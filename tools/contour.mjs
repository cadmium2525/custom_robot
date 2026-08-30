#!/usr/bin/env node
/**
 * Silhouette meter — does the robot separate from what is behind it?
 *
 * Defect #24 ("mushy silhouette") survived five review rounds because it was
 * argued about in words and inspected in zoomed-in crops. Zooming is precisely
 * what hides it: at 400% every panel line is crisp and the robot looks great,
 * while at gameplay size the machine is 90px tall and dissolves into the deck.
 * So this measures the thing directly, at the size the player actually sees.
 *
 *   node tools/contour.mjs --base http://127.0.0.1:4241/
 *
 * Method. Two screenshots are taken from ONE frozen frame — the engine is
 * paused, so the camera, the sim and the effect clock are all held still:
 *
 *   N  the frame as rendered
 *   M  a silhouette pass: everything but the shells hidden, flat white override
 *
 * M is an exact binary stencil of the machines, which is a ground-truth mask
 * with no coordinate guessing and no colour keying. Two details matter for
 * honesty:
 *
 *   - The contact shadow and blob are excluded from the stencil. A shadow is
 *     not silhouette; counting it would credit the robot for a dark patch it
 *     merely casts.
 *   - VFX are suppressed before either capture. A muzzle flash lying across
 *     the outline is not the outline, and it moves, so including it would make
 *     the measurement unrepeatable.
 *
 * The mask's boundary is then walked over N. For each boundary pixel a 7x7
 * window is split into its mask and non-mask halves, and the difference of
 * their mean luminances is the local value step — how hard the edge reads
 * right there, against whatever the robot actually happens to be in front of.
 *
 * What comes out is a distribution, because a silhouette does not fail
 * uniformly: a robot can be perfectly crisp against a dark wall and vanish
 * where it crosses a bright deck tile, and the average of those two is a
 * meaningless number that hides both. The headline figure is therefore the
 * fraction of the contour whose step falls below a legibility floor.
 *
 * Rules of thumb used for the verdict, in 0-255 sRGB:
 *   step < 12   invisible edge — the outline is gone there
 *   step < 25   weak — survives a still frame, dissolves in motion
 *   step >= 40  reads cleanly
 * A robot that is genuinely readable keeps most of its contour above 25 and
 * very little below 12.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4241/');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const ARENA = flag('arena', 'grid');
// startMatch defaults its seed to Math.random(), so without pinning this every
// run measures a different fight and nothing can be compared to anything.
const SEED = Number(flag('seed', 1234567));
const KEEP = !!flag('keep');
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Enter or leave a silhouette pass: everything except the robots' shells is
 * hidden and every remaining surface is flat white, so the frame becomes an
 * exact binary stencil of the machines.
 *
 * The first version of this tool diffed a normal frame against one with the
 * robots hidden, which is wrong in a way worth recording: removing the robots
 * also removes what they contribute to the shadow maps and to bloom, so the
 * deck shifts a level or two across the WHOLE frame and the "robot" mask came
 * back as 74% of the image. A stencil cannot drift like that.
 *
 * `three` is bundled and unreachable from the page, so the override material is
 * built from a constructor borrowed off an existing MeshBasicMaterial — the
 * contact-shadow blob is a known one.
 */
const STENCIL_FN = `(on) => {
  const v = window.__game.view;
  if (on) {
    const MB = v.blobs[0].material.constructor;
    const white = new MB({ color: 0xffffff, fog: false, toneMapped: false });
    const black = new MB({ color: 0x000000, fog: false, toneMapped: false });

    // A cast shadow is not silhouette, and a shadow blob turned opaque would
    // occlude the feet it is supposed to sit under.
    v.__hidden = [];
    for (const b of v.blobs) if (b.visible) { v.__hidden.push(b); b.visible = false; }
    for (const m of v.models) {
      if (m.shadow && m.shadow.visible) { v.__hidden.push(m.shadow); m.shadow.visible = false; }
    }

    const shells = new Set();
    for (const m of v.models) m.group.traverse((o) => { if (o.isMesh) shells.add(o); });

    // Materials are swapped per-mesh rather than via scene.overrideMaterial,
    // because the stage has to stay in the depth buffer: a robot standing
    // BEHIND a pillar must not appear in the stencil. An earlier version used
    // an override and reported a fully occluded robot as 100% invisible
    // contour, which is a measurement artefact, not a defect in the art.
    v.__swap = [];
    v.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      v.__swap.push([o, o.material]);
      o.material = shells.has(o) ? white : black;
    });
    v.__bg = v.scene.background; v.__fog = v.scene.fog;
    v.scene.background = null; v.scene.fog = null;
  } else {
    for (const [o, mat] of v.__swap || []) o.material = mat;
    for (const o of v.__hidden || []) o.visible = true;
    v.scene.background = v.__bg; v.scene.fog = v.__fog;
    v.__swap = null; v.__hidden = null;
  }
}`;

/**
 * Drive the camera rig to its steady state by hand.
 *
 * Without this the tool is useless for A/B work: the rig smooths toward its
 * target using the real frame delta, and under software GL that delta is
 * whatever the last frame happened to cost, so two runs of the same seed frame
 * the fight from visibly different places. Robot heights swung between 28px and
 * 146px across runs, which swamps any change being measured. The sim itself is
 * deterministic, so once it is frozen the rig converges to one pose — this just
 * runs it there on a fixed 1/60 delta with nothing else moving.
 */
const SETTLE_FN = `(n) => {
  const g = window.__game;
  if (!g.rig || !g.world || !g.view) return false;
  let t = (g.engine.clock && g.engine.clock.elapsed) || 0;
  for (let i = 0; i < n; i++) {
    const views = g.view.prepare(1);
    g.rig.update(g.world, views, g.localIndex, 1 / 60, t);
    // Drive the MACHINES on the same clock as the camera, inside the loop.
    //
    // This used to be a single g.view.update(0, 1, t) after the loop, and that
    // one argument was the root cause of every "the meter is noisy" round this
    // project has had. Every pose blend term in RoboModel.update is a damper,
    // and damp(a, b, lambda, dt) = lerp(a, b, 1 - exp(-lambda*dt)) is exactly
    // exactly a at dt = 0 — the dampers do not move. So the camera converged 240
    // iterations while the limbs were left wherever the pre-fastForward frames
    // had dragged them, and how far that was depended on how many frames the
    // box had managed to render, i.e. on load. The machine was drawn at tick
    // 420's POSITION in a load-dependent POSE: root pinned to 720,565..570
    // while the stencil box ranged 183 to 245px tall.
    g.view.update(1 / 60, 1, t);
    t += 1 / 60;
  }

  // Settling by hand is not enough on its own. \`paused\` gates only the fixed
  // step; the engine still calls onRender every frame with the REAL wall-clock
  // delta, and that damps the camera rig and the grade. Between this settle and
  // the shutter there are two 700ms waits and a multi-second software-GL
  // screenshot, so the rig kept sliding by an amount that depended on how loaded
  // the machine was. Two runs at the same seed and commit differed by 7 points
  // on the headline "invisible contour" figure — wider than any single round's
  // improvement, which means every #24 number measured before this line existed
  // carries that error bar.
  g.engine.onRender = null;
  if (g.engine.quality) g.engine.quality.auto = false;
  return true;
}`;

/** Suppress every effect so a beam across the outline cannot be mistaken for it. */
const VFX_OFF_FN = `() => {
  const v = window.__game.view;
  const keep = new Set([v.stage.group, ...v.models.map((m) => m.group), ...v.blobs]);
  for (const o of v.scene.children) {
    if (keep.has(o) || o.isLight || o.isCamera) continue;
    o.visible = false;
  }
  for (const k of ['motes', 'shafts', 'sweep']) if (v.stage[k]) v.stage[k].visible = false;
}`;

/**
 * Runs in a throwaway page: decodes both PNGs, builds the mask, splits it into
 * connected components (one per robot) and measures every boundary pixel.
 */
const ANALYSE_FN = async ({ nUri, hUri }) => {
  const load = async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };

  const N = await load(nUri);
  const H = await load(hUri);
  const W = N.W, HT = N.H;
  const lumOf = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  // Ln is the real frame's luminance; H is the white-on-black stencil, so its
  // luminance IS the mask. The 0.5 cut is nowhere near either state, which
  // makes the mask insensitive to antialiasing on the stencil's own edge.
  const Ln = new Float32Array(W * HT);
  const mask = new Uint8Array(W * HT);
  for (let p = 0, i = 0; p < W * HT; p++, i += 4) {
    Ln[p] = lumOf(N.d, i);
    if (lumOf(H.d, i) > 128) mask[p] = 1;
  }

  // Connected components, so each robot is reported on its own. A robot that
  // reads well up close and one that is a smudge in the distance must not be
  // averaged into a single misleading figure.
  const comp = new Int32Array(W * HT).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * HT);
  for (let p = 0; p < W * HT; p++) {
    if (!mask[p] || comp[p] >= 0) continue;
    const id = comps.length;
    let sp = 0, n = 0;
    let x0 = W, x1 = 0, y0 = HT, y1 = 0;
    stack[sp++] = p; comp[p] = id;
    while (sp) {
      const q = stack[--sp];
      const qx = q % W, qy = (q / W) | 0;
      n++;
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
      if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      if (qx > 0 && mask[q - 1] && comp[q - 1] < 0) { comp[q - 1] = id; stack[sp++] = q - 1; }
      if (qx < W - 1 && mask[q + 1] && comp[q + 1] < 0) { comp[q + 1] = id; stack[sp++] = q + 1; }
      if (qy > 0 && mask[q - W] && comp[q - W] < 0) { comp[q - W] = id; stack[sp++] = q - W; }
      if (qy < HT - 1 && mask[q + W] && comp[q + W] < 0) { comp[q + W] = id; stack[sp++] = q + W; }
    }
    comps.push({ id, n, x0, x1, y0, y1 });
  }
  // Speckle from dithering and bloom fringing is not a robot.
  const bodies = comps.filter((c) => c.n >= 300 && (c.y1 - c.y0) >= 16)
    .sort((a, b) => b.n - a.n).slice(0, 2);

  const R = 3;                       // 7x7 window
  const measure = (only) => {
    const steps = [];
    for (let y = R; y < HT - R; y++) {
      for (let x = R; x < W - R; x++) {
        const p = y * W + x;
        if (!mask[p]) continue;
        if (only !== undefined && comp[p] !== only) continue;
        // Boundary only.
        if (mask[p - 1] && mask[p + 1] && mask[p - W] && mask[p + W]) continue;
        let inSum = 0, inN = 0, outSum = 0, outN = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const q = p + dy * W + dx;
            if (mask[q]) { inSum += Ln[q]; inN++; }
            else { outSum += Ln[q]; outN++; }
          }
        }
        if (inN < 5 || outN < 5) continue;
        steps.push(Math.abs(inSum / inN - outSum / outN));
      }
    }
    if (!steps.length) return null;
    steps.sort((a, b) => a - b);
    const q = (f) => Math.round(steps[Math.min(steps.length - 1, Math.floor(f * steps.length))] * 10) / 10;
    const frac = (t) => Math.round(steps.filter((s) => s < t).length / steps.length * 1000) / 10;
    return {
      n: steps.length,
      p10: q(0.10), median: q(0.50), p90: q(0.90),
      mean: Math.round(steps.reduce((a, b) => a + b, 0) / steps.length * 10) / 10,
      under12: frac(12), under25: frac(25), over40: Math.round((100 - frac(40)) * 10) / 10,
    };
  };

  /**
   * Body value against the value of the ground it is standing on, which is
   * what decides whether a rim light is even the right tool. A body sitting at
   * the same value as its background cannot be rescued by an edge treatment;
   * it has to move in value first.
   */
  const values = (only) => {
    const inside = [], around = [];
    const RING = 14;
    for (let y = RING; y < HT - RING; y++) {
      for (let x = RING; x < W - RING; x++) {
        const p = y * W + x;
        if (mask[p]) {
          if (only === undefined || comp[p] === only) inside.push(Ln[p]);
          continue;
        }
        // Background sampled in a ring just outside the mask, not the whole
        // frame: what matters is what the robot is actually in front of.
        let near = false;
        for (let dy = -RING; dy <= RING && !near; dy += 7) {
          for (let dx = -RING; dx <= RING; dx += 7) {
            const q2 = p + dy * W + dx;
            if (mask[q2] && (only === undefined || comp[q2] === only)) { near = true; break; }
          }
        }
        if (near) around.push(Ln[p]);
      }
    }
    const med = (a) => a.length ? Math.round(a.sort((x, y) => x - y)[a.length >> 1] * 10) / 10 : null;
    return { body: med(inside), background: med(around) };
  };

  return {
    screen: `${W}x${HT}`,
    maskPx: mask.reduce((a, b) => a + b, 0),
    overall: measure(),
    overallValues: values(),
    bodies: bodies.map((c) => ({
      px: c.n,
      box: `${c.x1 - c.x0 + 1}x${c.y1 - c.y0 + 1}`,
      heightPctOfFrame: Math.round((c.y1 - c.y0 + 1) / HT * 1000) / 10,
      at: `${c.x0},${c.y0}`,
      contour: measure(c.id),
      values: values(c.id),
    })),
  };
};

const bar = (pct, width = 28) => {
  const n = Math.max(0, Math.min(width, Math.round(pct / 100 * width)));
  return '#'.repeat(n) + '.'.repeat(width - n);
};

(async () => {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
  await page.evaluate((t) => { const q = window.__game.engine.quality; q.auto = false; q.setTier(t); }, TIER);
  await page.waitForTimeout(400);

  // Freeze on the SAME line that starts the match. Any wall-clock that elapses
  // with the engine live is sim ticks the demo AI has already played, and how
  // many of those there are depends on how busy the machine was — which is the
  // whole of the nondeterminism. The sim is deterministic from tick 0, so the
  // only way to get the same frame twice is to never let it run free at all.
  await page.evaluate(({ id, seed }) => {
    const g = window.__game;
    g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
    g.setDemo(true);
    g.engine.paused = true;
    // Pin the clock to a fixed absolute value, the way vfxsheet.mjs does.
    // Pausing stops `elapsed` advancing, but it does not undo what accumulated
    // during boot, and how much that is depends on how loaded the machine was.
    // The limb animation is driven off this clock, so an unpinned value moves
    // the machine's pose between runs — which is how a "pinned" frame returned
    // a bounding box that changed shape, 37x66 one run and 37x67 the next.
    // A pose change is not rasteriser noise.
    if (g.engine.clock) g.engine.clock.elapsed = 1000;
  }, { id: ARENA, seed: SEED });
  await page.waitForTimeout(1200);
  await page.evaluate((n) => window.__game.fastForward(n), TICKS);
  const st = await page.evaluate(() => {
    const w = window.__game.world;
    const r = (v) => Math.round(v * 100) / 100;
    return { tick: w.tick, a: [r(w.robos[0].pos.x), r(w.robos[0].pos.z)], b: [r(w.robos[1].pos.x), r(w.robos[1].pos.z)] };
  });
  console.log(`  sim state: tick=${st.tick} p1=${st.a} p2=${st.b}`);
  const settled = await page.evaluate(`(${SETTLE_FN})(240)`);
  if (!settled) throw new Error('camera rig unavailable — cannot pin the frame');
  await page.evaluate(`(${VFX_OFF_FN})()`);
  for (const id of ['ui-layer', 'hud-layer', 'splash']) {
    await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
  }
  await page.waitForTimeout(700);

  const N = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(true)`);
  await page.waitForTimeout(700);
  const H = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(false)`);

  if (KEEP) {
    mkdirSync('shots', { recursive: true });
    writeFileSync('shots/contour-n.png', N);
    writeFileSync('shots/contour-mask.png', H);
  }

  const probe = await context.newPage();
  await probe.goto('about:blank');
  const out = await probe.evaluate(ANALYSE_FN, {
    nUri: 'data:image/png;base64,' + N.toString('base64'),
    hUri: 'data:image/png;base64,' + H.toString('base64'),
  });

  console.log(`\nSILHOUETTE — ${ARENA} @ tier ${TIER}, ${out.screen}, robot pixels ${out.maskPx}`);
  const show = (label, c, extra = '') => {
    if (!c) { console.log(`  ${label}: no contour found`); return; }
    console.log(`  ${label}${extra}`);
    console.log(`     step  p10=${c.p10}  median=${c.median}  p90=${c.p90}  mean=${c.mean}`);
    console.log(`     invisible (<12) ${String(c.under12).padStart(5)}%  ${bar(c.under12)}`);
    console.log(`     weak      (<25) ${String(c.under25).padStart(5)}%  ${bar(c.under25)}`);
    console.log(`     clean    (>=40) ${String(c.over40).padStart(5)}%  ${bar(c.over40)}`);
  };
  const vals = (v) => v && v.body != null
    ? `     body ${v.body} vs background ${v.background}  (separation ${Math.round(Math.abs(v.body - v.background) * 10) / 10})`
    : null;
  show('OVERALL', out.overall);
  if (vals(out.overallValues)) console.log(vals(out.overallValues));
  out.bodies.forEach((b, i) => {
    show(`ROBOT ${i + 1}`, b.contour, `  ${b.box}px (${b.heightPctOfFrame}% of frame height) at ${b.at}`);
    if (vals(b.values)) console.log(vals(b.values));
  });
  if (errors.length) console.log('\npage errors:', errors.slice(0, 4));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
