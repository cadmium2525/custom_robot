#!/usr/bin/env node
/**
 * GROUNDING METER — and, first, an audit of the frame the grounding is judged on.
 *
 * Defect #14's open half is "the machines are still barely grounded": a machine
 * that does not touch the floor reads as a decal. Every previous attempt to
 * judge that was made on the standard pinned frame — seed 1234567, tick 420 —
 * which is the frame contour.mjs and mass.mjs share. A predecessor stopped
 * before landing anything and left one question behind:
 *
 *   "The pinned frame has the opponent 3.1 m airborne and the player's feet off
 *    the bottom edge. Let me check whether that is fair ground for a grounding
 *    measurement."
 *
 * It is not, and this tool exists to say so with numbers rather than to assert
 * it. `--survey` walks the pinned fight tick by tick and prints, for each
 * machine, the two things that decide whether a frame can carry a grounding
 * measurement at all:
 *
 *   air     metres between the machine's root and the surface underneath it.
 *           A machine in flight has no contact to measure. The sim's own
 *           `grounded` flag is printed beside it, because a machine can be
 *           0.00 m up and still be one tick into a jump.
 *   below   pixels of viewport between the machine's lowest rendered vertex and
 *           the bottom edge of the frame. A contact reads in the pixels AROUND
 *           the contact — the pool of occlusion the feet sit in — so a machine
 *           whose feet are at the edge has had the entire measurement cropped
 *           away, and one whose feet are past the edge has no contact in frame
 *           at all.
 *
 * A frame is FIT for grounding when both machines are grounded and both have
 * clear viewport under their feet. That is a much stronger requirement than the
 * silhouette meter's — contour.mjs measures the outline against whatever is
 * behind it and does not care whether a machine is flying — which is why the
 * shared frame was never wrong for contour.mjs and is wrong for this.
 *
 * The default mode measures grounding on whatever tick it is given, from the
 * same white-on-black stencil the other two meters use, and reports:
 *
 *   FOOT CONTOUR   the silhouette meter's own 7x7 value step, restricted to the
 *                  boundary pixels in the bottom 18% of the machine's box. This
 *                  is the outline where it meets the floor, which is the only
 *                  part of the outline grounding is about. A machine can read
 *                  76% clean overall and still have feet that dissolve.
 *   CONTACT CURVE  deck luminance as a function of distance out from the
 *                  machine's footprint, sampled only in the bottom band and
 *                  only on non-machine pixels. A machine standing on a floor
 *                  sits in a pool: the deck is darkest against the feet and
 *                  recovers outward. A decal has a flat curve. Reported as a
 *                  curve, not a number, because the DEPTH of the pool and its
 *                  RADIUS are different defects — a pool four times too wide is
 *                  the AO smudge this file's history already caught once, and a
 *                  single "contact = 14" would score that as a triumph.
 *
 * Usage:
 *   node shots/_ground.mjs --survey --arena grid
 *   node shots/_ground.mjs --arena grid --ticks 520 --keep
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

const BASE = flag('base', 'http://127.0.0.1:4210/');
const TIER = Number(flag('tier', 3));
const ARENA = flag('arena', 'grid');
const SEED = Number(flag('seed', 1234567));
const TICKS = Number(flag('ticks', 420));
const SURVEY = !!flag('survey');
const FROM = Number(flag('from', 300));
const TO = Number(flag('to', 900));
const STEP = Number(flag('step', 20));
const KEEP = !!flag('keep');
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* Identical to contour.mjs / mass.mjs — see the commentary in contour.mjs. */
const STENCIL_FN = `(on) => {
  const v = window.__game.view;
  if (on) {
    const MB = v.blobs[0].material.constructor;
    const white = new MB({ color: 0xffffff, fog: false, toneMapped: false });
    const black = new MB({ color: 0x000000, fog: false, toneMapped: false });
    v.__hidden = [];
    for (const b of v.blobs) if (b.visible) { v.__hidden.push(b); b.visible = false; }
    for (const m of v.models) {
      if (m.shadow && m.shadow.visible) { v.__hidden.push(m.shadow); m.shadow.visible = false; }
    }
    const shells = new Set();
    for (const m of v.models) m.group.traverse((o) => { if (o.isMesh) shells.add(o); });
    v.__swap = [];
    v.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      // INSTRUMENT FAULT 19. A mesh that does not write depth does not occlude
      // the machines in the real frame; painting it opaque black made it occlude
      // them in the mask. See tools/contour.mjs for the measurement.
      //
      // This is the THIRD sweep for copies of this block. The first fixed five
      // and was described as atomic; a sixth was then found inline in
      // _r17-blast.mjs; these three are the remainder, found by asking which
      // files contain the swap and do NOT contain the guard rather than by
      // listing them from memory. Nine copies, three sweeps. If this block is
      // ever touched again, run that query, do not trust a list.
      const m0 = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!shells.has(o) && m0 && m0.depthWrite === false) {
        v.__hidden.push(o); o.visible = false; return;
      }
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

const SETTLE_FN = `(n) => {
  const g = window.__game;
  if (!g.rig || !g.world || !g.view) return false;
  let t = (g.engine.clock && g.engine.clock.elapsed) || 0;
  for (let i = 0; i < n; i++) {
    const views = g.view.prepare(1);
    g.rig.update(g.world, views, g.localIndex, 1 / 60, t);
    t += 1 / 60;
  }
  g.view.update(0, 1, t);
  g.engine.onRender = null;
  if (g.engine.quality) g.engine.quality.auto = false;
  return true;
}`;

const VFX_OFF_FN = `() => {
  const v = window.__game.view;
  const keep = new Set([v.stage.group, ...v.models.map((m) => m.group), ...v.blobs]);
  for (const o of v.scene.children) {
    if (keep.has(o) || o.isLight || o.isCamera) continue;
    o.visible = false;
  }
  for (const k of ['motes', 'shafts', 'sweep']) if (v.stage[k]) v.stage[k].visible = false;
  const was = [];
  for (let i = 0; i < v.models.length; i++) {
    const u = v.models[i].matShell && v.models[i].matShell.userData.u;
    if (!u) continue;
    for (const k of ['uHitFlash', 'uCharge', 'uRimWash', 'uDissolve']) {
      if (u[k] && u[k].value > 0.001) { was.push('robot ' + (i + 1) + ' ' + k); u[k].value = 0; }
    }
  }
  return was;
}`;

/**
 * Framing + contact readiness of the CURRENT frame, straight off the scene
 * graph. No screenshot: this has to be cheap enough to run at fifty ticks.
 *
 * The machine's lowest rendered vertex is taken from real geometry — every mesh
 * bounding box, transformed by its own matrixWorld — not from a guessed capsule,
 * because a guess is exactly how "the feet are off the edge" stayed an opinion.
 */
const FRAME_FN = `() => {
  const g = window.__game;
  const v = g.view;
  const cam = v.camera;
  const V3 = cam.position.constructor;
  const W = window.innerWidth, H = window.innerHeight;
  cam.updateMatrixWorld();
  const out = [];
  for (let i = 0; i < v.models.length; i++) {
    const m = v.models[i];
    const r = g.world.robos[i];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, any = false;
    m.group.updateMatrixWorld(true);
    m.group.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry) return;
      // THE SHELL, AND ONLY THE SHELL — the same set the stencil paints white.
      //
      // RoboModel parents its own contact shadow to the model group and parks it
      // at y = 0.016 - pos.y, i.e. on the deck however high the machine is. Its
      // plane is 2 m square before the ~1.2 m radius scale, so on an airborne
      // machine the group's bounding box reaches a metre and a half BELOW the
      // feet and a metre out to each side. Including it put the player's "lowest
      // vertex" 176 px under the viewport when the shell itself ends 3 px above
      // it, which would have condemned a frame for a crop it does not have. A
      // shadow is not the machine here for exactly the reason contour.mjs says
      // it is not silhouette.
      if (o === m.shadow) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      for (let c = 0; c < 8; c++) {
        const p = new V3(
          (c & 1) ? bb.max.x : bb.min.x,
          (c & 2) ? bb.max.y : bb.min.y,
          (c & 4) ? bb.max.z : bb.min.z
        );
        p.applyMatrix4(o.matrixWorld).project(cam);
        const sx = (p.x * 0.5 + 0.5) * W, sy = (-p.y * 0.5 + 0.5) * H;
        if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
        if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
        any = true;
      }
    });
    const groundY = v._groundUnder(r.pos.x, r.pos.z);
    // THE CONTACT POINT, and it is what decides fitness rather than the shell
    // box. Where the machine meets the deck is a single world point — the
    // surface directly under its root — and a grounding measurement is made in
    // the deck AROUND that point. Projecting it is exact; a bounding box over
    // shell meshes is not, because a raised weapon or a splayed thruster shroud
    // stretches the box without moving the feet.
    const proj = (wy) => {
      const p = new V3(r.pos.x, wy, r.pos.z).project(cam);
      return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H };
    };
    const foot = proj(groundY);
    const head = proj(groundY + 1.7);           // a machine is ~1.7 m tall
    out.push({
      air: Math.round((r.pos.y - groundY) * 100) / 100,
      grounded: !!r.grounded,
      state: r.state,
      blob: v.blobs[i] ? (v.blobs[i].visible ? Math.round(v.blobs[i].material.opacity * 100) / 100 : 0) : null,
      box: any ? { x0: Math.round(x0), x1: Math.round(x1), y0: Math.round(y0), y1: Math.round(y1) } : null,
      hPx: Math.round(Math.abs(foot.y - head.y)),
      footPx: { x: Math.round(foot.x), y: Math.round(foot.y) },
      below: Math.round(H - foot.y),
    });
  }
  return { W, H, robots: out };
}`;

/**
 * Foot contour and the contact curve, from one N frame plus its stencil.
 */
const ANALYSE_FN = async ({ nUri, hUri, band }) => {
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
  const Hm = await load(hUri);
  const W = N.W, HT = N.H;
  const lumOf = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  const Ln = new Float32Array(W * HT);
  const mask = new Uint8Array(W * HT);
  for (let p = 0, i = 0; p < W * HT; p++, i += 4) {
    Ln[p] = lumOf(N.d, i);
    if (lumOf(Hm.d, i) > 128) mask[p] = 1;
  }

  const comp = new Int32Array(W * HT).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * HT);
  for (let p = 0; p < W * HT; p++) {
    if (!mask[p] || comp[p] >= 0) continue;
    const id = comps.length;
    let sp = 0, n = 0, x0 = W, x1 = 0, y0 = HT, y1 = 0;
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
  const bodies = comps.filter((c) => c.n >= 300 && (c.y1 - c.y0) >= 16)
    .sort((a, b) => b.n - a.n).slice(0, 2);

  const R = 3;
  /** contour.mjs' step, over the boundary rows of one horizontal band. */
  const footContour = (c, yFrom, yTo) => {
    const steps = [];
    for (let y = Math.max(R, yFrom); y <= Math.min(HT - R - 1, yTo); y++) {
      for (let x = R; x < W - R; x++) {
        const p = y * W + x;
        if (!mask[p] || comp[p] !== c.id) continue;
        if (mask[p - 1] && mask[p + 1] && mask[p - W] && mask[p + W]) continue;
        let inS = 0, inN = 0, outS = 0, outN = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const q = p + dy * W + dx;
            if (mask[q]) { inS += Ln[q]; inN++; } else { outS += Ln[q]; outN++; }
          }
        }
        if (inN < 5 || outN < 5) continue;
        steps.push(Math.abs(inS / inN - outS / outN));
      }
    }
    if (!steps.length) return null;
    steps.sort((a, b) => a - b);
    const q = (f) => Math.round(steps[Math.min(steps.length - 1, Math.floor(f * steps.length))] * 10) / 10;
    const frac = (t) => Math.round(steps.filter((s) => s < t).length / steps.length * 1000) / 10;
    return {
      n: steps.length, p10: q(0.10), median: q(0.50),
      under12: frac(12), under25: frac(25), over40: Math.round((100 - frac(40)) * 10) / 10,
    };
  };

  /**
   * Deck value as a function of distance out from the footprint.
   *
   * Distances are in FOOTPRINT WIDTHS, not pixels, so a 260px machine and a
   * 79px machine are sampled at the same physical radius — the same reason
   * mass.mjs scales its blur by body height. Only rows at or below the mask's
   * bottom are used and only non-machine pixels are counted, so nothing here
   * can be contaminated by the machine's own paint.
   */
  const contact = (c) => {
    const cw = c.x1 - c.x0 + 1;
    const cx = (c.x0 + c.x1) / 2;
    const rings = [0.15, 0.35, 0.6, 0.9, 1.3, 1.8, 2.5];
    const acc = rings.map(() => []);
    const yBase = c.y1;
    const maxR = rings[rings.length - 1] * cw;
    for (let y = Math.max(0, yBase - Math.round(cw * 0.35)); y <= Math.min(HT - 1, yBase + Math.round(maxR)); y++) {
      for (let x = Math.max(0, Math.round(cx - maxR)); x <= Math.min(W - 1, Math.round(cx + maxR)); x++) {
        const p = y * W + x;
        if (mask[p]) continue;
        const dx = (x - cx) / cw;
        const dy = (y - yBase) / cw;
        const d = Math.hypot(dx, Math.max(0, dy) * 1.9);   // deck is foreshortened
        for (let r = 0; r < rings.length; r++) {
          const lo = r === 0 ? 0 : rings[r - 1];
          if (d >= lo && d < rings[r]) { acc[r].push(Ln[p]); break; }
        }
      }
    }
    const med = (a) => a.length >= 25 ? Math.round(a.sort((p, q) => p - q)[a.length >> 1] * 10) / 10 : null;
    const curve = rings.map((r, i) => ({ r, v: med(acc[i]), n: acc[i].length }));
    const near = curve[0].v, far = curve[curve.length - 1].v;
    return { curve, depth: near != null && far != null ? Math.round((far - near) * 10) / 10 : null };
  };

  return {
    screen: `${W}x${HT}`,
    bodies: bodies.map((c) => {
      const h = c.y1 - c.y0 + 1;
      const footFrom = c.y0 + Math.round(h * 0.82);
      return {
        px: c.n,
        box: `${c.x1 - c.x0 + 1}x${h}`,
        at: `${c.x0},${c.y0}`,
        bottomRow: c.y1,
        clipped: c.y1 >= HT - 2,
        all: footContour(c, c.y0, c.y1),
        foot: footContour(c, footFrom, c.y1),
        contact: contact(c),
      };
    }),
  };
};

const bar = (pct, width = 24) => {
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

  await page.evaluate(({ id, seed }) => {
    const g = window.__game;
    g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
    g.setDemo(true);
    g.engine.paused = true;
    if (g.engine.clock) g.engine.clock.elapsed = 1000;
  }, { id: ARENA, seed: SEED });
  await page.waitForTimeout(1200);

  if (SURVEY) {
    console.log(`\nFRAME FITNESS — ${ARENA}, seed ${SEED}, ticks ${FROM}..${TO} step ${STEP}`);
    console.log('  A machine can only carry a grounding measurement if it is ON the floor');
    console.log('  and the floor it stands on is IN the frame.\n');
    console.log('   tick |        ROBOT 1 (player)        |       ROBOT 2 (opponent)      | fit');
    console.log('        |  air  gnd  blob  hPx  below    |  air  gnd  blob  hPx  below   |');
    console.log('        |  air:   metres above the surface underneath it');
    console.log('        |  hPx:   pixels a 1.7 m machine spans at that distance');
    console.log('        |  below: pixels of viewport under its GROUND CONTACT POINT');
    console.log('  ' + '-'.repeat(76));
    let done = 0;
    const fit = [];
    for (let tk = FROM; tk <= TO; tk += STEP) {
      await page.evaluate((n) => window.__game.fastForward(n), tk - done);
      done = tk;
      await page.evaluate(`(${SETTLE_FN})(240)`);
      const f = await page.evaluate(`(${FRAME_FN})()`);
      const r = f.robots;
      const cell = (x) => `${String(x.air.toFixed(2)).padStart(6)} ${x.grounded ? ' Y ' : ' - '}`
        + `${String(x.blob).padStart(5)} ${String(x.hPx).padStart(5)} ${String(x.below).padStart(6)}`;
      // Fit needs both feet on the deck AND clear viewport under them: the pool
      // of occlusion around a contact is the measurement, so a cropped foot has
      // nothing left to measure.
      // The pool of occlusion a contact sits in runs out to roughly a third of
      // the machine's own height, so that much deck has to be in frame under
      // the feet before there is anything to measure.
      const ok = r.every((x) => x.grounded && x.air < 0.08 && x.below >= Math.round(x.hPx * 0.33) && x.hPx >= 55);
      if (ok) fit.push({ tick: tk, r });
      console.log(`  ${String(tk).padStart(5)} |${cell(r[0])}    |${cell(r[1])}   | ${ok ? 'FIT' : '  -'}`);
    }
    console.log('');
    if (!fit.length) console.log('  NO FIT FRAME in this range.');
    else {
      console.log(`  ${fit.length} fit frame(s): ${fit.map((f) => f.tick).join(', ')}`);
      const best = fit.sort((a, b) =>
        (b.r[0].hPx + b.r[1].hPx) - (a.r[0].hPx + a.r[1].hPx))[0];
      console.log(`  largest machines: tick ${best.tick}  (${best.r[0].hPx}px / ${best.r[1].hPx}px,`
        + ` ${best.r[0].below}px / ${best.r[1].below}px of deck under the feet)`);
    }
    if (errors.length) console.log('\npage errors:', errors.slice(0, 4));
    await browser.close();
    return;
  }

  await page.evaluate((n) => window.__game.fastForward(n), TICKS);
  const settled = await page.evaluate(`(${SETTLE_FN})(240)`);
  if (!settled) throw new Error('camera rig unavailable — cannot pin the frame');
  const transient = await page.evaluate(`(${VFX_OFF_FN})()`);
  if (transient && transient.length) console.log('  suppressed transients:', transient.join(', '));
  const frame = await page.evaluate(`(${FRAME_FN})()`);
  for (const id of ['ui-layer', 'hud-layer', 'splash']) {
    await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
  }
  await page.waitForTimeout(700);

  const N = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(true)`);
  await page.waitForTimeout(700);
  const Hs = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(false)`);

  if (KEEP) {
    mkdirSync('shots', { recursive: true });
    writeFileSync(`shots/ground-${ARENA}-t${TICKS}.png`, N);
  }

  const probe = await context.newPage();
  await probe.goto('about:blank');
  const out = await probe.evaluate(ANALYSE_FN, {
    nUri: 'data:image/png;base64,' + N.toString('base64'),
    hUri: 'data:image/png;base64,' + Hs.toString('base64'),
  });

  console.log(`\nGROUNDING — ${ARENA} @ tier ${TIER}, tick ${TICKS}, ${out.screen}`);
  frame.robots.forEach((r, i) => {
    console.log(`  scene  robot ${i + 1}: ${r.air.toFixed(2)} m up, grounded=${r.grounded}, `
      + `blob opacity ${r.blob}, ${r.below}px of viewport below its lowest vertex`);
    if (r.box) console.log(`         projected box x ${r.box.x0}..${r.box.x1}  y ${r.box.y0}..${r.box.y1}`);
  });
  out.bodies.forEach((b, i) => {
    console.log(`\n  ROBOT ${i + 1}  ${b.box}px at ${b.at}${b.clipped ? '   *** FEET CROPPED BY THE FRAME ***' : ''}`);
    const show = (label, c) => {
      if (!c) { console.log(`     ${label}: no contour`); return; }
      console.log(`     ${label} (${c.n}px)  p10=${c.p10} median=${c.median}`);
      console.log(`        invisible (<12) ${String(c.under12).padStart(5)}%  ${bar(c.under12)}`);
      console.log(`        clean    (>=40) ${String(c.over40).padStart(5)}%  ${bar(c.over40)}`);
    };
    show('whole contour', b.all);
    show('foot contour ', b.foot);
    const cv = b.contact.curve;
    console.log(`     contact curve (deck value by distance, in footprint widths)`);
    console.log(`        r    ${cv.map((c) => String(c.r).padStart(6)).join('')}`);
    console.log(`        val  ${cv.map((c) => String(c.v == null ? '-' : c.v).padStart(6)).join('')}`);
    console.log(`        pool depth (far - nearest): ${b.contact.depth}`);
  });
  if (errors.length) console.log('\npage errors:', errors.slice(0, 4));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
