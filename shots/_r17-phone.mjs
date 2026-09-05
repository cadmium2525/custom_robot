#!/usr/bin/env node
/**
 * R17PHONE — the deterministic phone frame, and every number the phone ruling
 * asks for, taken by ONE meter on ONE frame.
 *
 * ---------------------------------------------------------------------------
 * WHY A NEW HARNESS WHEN `_r15-phone.mjs` ALREADY WORKS
 * ---------------------------------------------------------------------------
 * `_r15-phone.mjs` delivered the first card-free phone frame and its diagnosis
 * of the banner race is correct and reused here. But it waits on the LIVE loop,
 * and that has two consequences that make it unusable for A/B work:
 *
 *   1. It is not deterministic. `startMatch` seeds itself from `Math.random()`,
 *      the sim then runs free for however many ticks the box can render, and
 *      the camera rig damps on the REAL frame delta. Two runs of the same
 *      commit photograph two different fights from two different places — the
 *      A/B pair in shots/_r17/ab.log has the same tick number and visibly
 *      different framing. House rule: pinned seed, engine paused, sim advanced
 *      a tick at a time, `view.update(1/60, ...)` INSIDE the settle loop.
 *   2. It costs 100-300s per capture and fails outright about a third of the
 *      time (see bL-log.txt), because under swiftshader the fixed step is gated
 *      behind a 5 fps render loop, so 150 intro ticks take three minutes of
 *      wall clock. This one reaches the same state in about fifteen seconds by
 *      taking the render out of the inner loop with `Game.fastForward`.
 *
 * The route to the match is still a REAL FINGER — ENTER ARENA / TO GARAGE /
 * SELECT ARENA / FIGHT through CDP `Input.dispatchTouchEvent` at coordinates
 * read off the live layout. No `menus.show()`, no keyboard. The ONE thing this
 * harness reaches into is the match seed, which it pins by wrapping
 * `Game.startMatch` before the FIGHT tap so the button the finger presses
 * starts a known fight. Everything else is the shipped path.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MEASURES, AND WHY IT IS ALL IN ONE TOOL
 * ---------------------------------------------------------------------------
 * The standing rule in REVIEW2.md is that no comparison may cross two tools.
 * The phone table has six rows — opponent size, FIRE-to-opponent ratio, HUD
 * share, player clipping, control-to-silhouette gap, and who owns the frame's
 * light and chroma — and each of them was previously read off a different
 * instrument or off a ruler held to a PNG. So they are all taken here, from one
 * pair of screenshots of one frozen frame:
 *
 *   N  the frame as shipped, DOM and all
 *   M  a white-on-black stencil of the two machines (borrowed verbatim from
 *      tools/contour.mjs, including its two hard-won details: shadows excluded,
 *      and per-mesh material swap so the stage still occludes)
 *
 * From those two, plus the DOM rects and the camera projection of each machine,
 * it reports:
 *
 *   GEOMETRY   per machine: stencil bbox and pixel count, the projected
 *              feet-to-head height (independent of occlusion), height as a
 *              share of the FRAME and of the RENDER BAND, and whether the mask
 *              touches an edge of the band (clipped).
 *   CONTROLS   every touch/HUD rect in device px, its size, its ratio to the
 *              opponent's height, the machine-mask pixels it covers, and its
 *              gap in pixels to the nearest machine pixel.
 *   SALIENCE   ON THE AUTHORITY METER'S RULES. `shots/_salience.mjs` is the
 *              authority for salience and coverage (instrument fault 14,
 *              commit 1c34325) and `_framesal.mjs` — which produced the
 *              "54.7% of visible chroma" figure in the ruling — is a third
 *              meter with a DIFFERENT chroma definition: it uses HSV
 *              S = (max-min)/max with an L >= 40 gate, the authority uses
 *              chroma = (max-min)/255. Those are not the same number and no
 *              comparison may cross them.
 *
 *              The authority meter cannot photograph this frame: it hides
 *              #ui-layer and #hud-layer before it looks, so it has never seen a
 *              touch button and structurally cannot rank one. So its RULES are
 *              reimplemented here, verbatim from its own source:
 *                - chroma = (max-min)/255, HSV S, hue in degrees
 *                - salience model A = lum x chroma
 *                - the 4-tile x 2-offset sweep (T = 32/40/48/64, offset 0 and
 *                  T/2), a tile counts as MACHINE at m >= 0.5 and as a control
 *                  at >= 0.5 AREA coverage — the fair rule fault 14 installed,
 *                  not the corner rule it replaced
 *                - brightest 1% = pixels at or above the 99th percentile of L
 *              and `--crosscheck` re-runs the authority meter's own numbers on
 *              a desktop frame so the reimplementation can be held to it.
 *              Every figure this tool prints is therefore quotable in the same
 *              sentence as a `_salience.mjs` figure, and it says so on the tin.
 *
 *   node shots/_r17-phone.mjs --prefix shots/_r17/x --vw 390 --vh 844 \
 *        --safe 47,34,0,0 --tier 2 --ticks 420 --arena grid
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); if (i < 0) return d; return argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const BASE = flag('base', 'http://127.0.0.1:4317/custom_robot/');
const PREFIX = flag('prefix', 'shots/_r17/x');
const VW = Number(flag('vw', 390));
const VH = Number(flag('vh', 844));
const DPR = Number(flag('dpr', 3));
const SAFE = String(flag('safe', '47,34,0,0')).split(',');
const ARENA = flag('arena', 'grid');
const TIER = Number(flag('tier', 2));
const TICKS = Number(flag('ticks', 420));
const SEED = Number(flag('seed', 1234567));
const TILE = Number(flag('tile', 60));
const NOSTENCIL = has('nostencil');
/** Re-run the analysis on PNGs already captured under this prefix. */
const ANALYSE = has('analyse');
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const log = [];
const say = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };

/* Verbatim from tools/contour.mjs — see its header for why the shadows come
   out of the stencil and why the swap is per-mesh rather than an override. */
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
    // INSTRUMENT FAULT 35, FIXED IN ALL EIGHT COPIES AT ONCE.
    //
    // The outline hull is a mesh under the model's group, so it lands in
    // \`shells\` and is painted white along with the machine — a mask dilated by
    // OUTLINE_WIDTH rather than the machine's own silhouette. That does not
    // happen today, and the reason is an accident: the override material below
    // is a fresh MeshBasicMaterial at its default FrontSide, and the hull is
    // BackSide, so its faces are culled. Give that material a \`side\` for any
    // reason and every mask-derived figure in this project changes at once,
    // with nothing in the output to say so.
    //
    // Measured before writing this: the grid stencil is 24415 px across a
    // nine-fold sweep of the hull's width, and clause B reads 84.8% with the
    // hull at full width and 80.8% with it collapsed to nothing. A hull inside
    // the mask would have dilated the first number and improved the second.
    //
    // So this asserts what culling was already doing, by NAME — \`m.outline\` is
    // the hull, set in robot.js where it is built — rather than by a property of
    // a material somebody else owns. Hidden rather than blackened, to reproduce
    // the culled behaviour exactly rather than a behaviour that merely agrees
    // with it on this arena.
    for (const m of v.models) {
      if (m.outline && m.outline.visible) { v.__hidden.push(m.outline); m.outline.visible = false; }
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

/* Verbatim from tools/contour.mjs. The 1/60 inside the loop is the whole point:
   damp() is a no-op at dt = 0, so a single update after the loop settles the
   camera and leaves the limbs wherever load happened to drag them. */
const SETTLE_FN = `(n) => {
  const g = window.__game;
  if (!g.rig || !g.world || !g.view) return false;
  let t = (g.engine.clock && g.engine.clock.elapsed) || 0;
  for (let i = 0; i < n; i++) {
    const views = g.view.prepare(1);
    g.rig.update(g.world, views, g.localIndex, 1 / 60, t);
    g.view.update(1 / 60, 1, t);
    t += 1 / 60;
  }
  g.engine.onRender = null;
  if (g.engine.quality) g.engine.quality.auto = false;
  return true;
}`;

/** Everything that can put a card over the arena, sampled in one go. */
const OVERLAYS = () => {
  const g = window.__game;
  const seen = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.02) return null;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return null;
    return { sel, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) };
  };
  return {
    state: g.state,
    phase: g.world ? g.world.phase : -1,
    tick: g.world ? g.world.tick : -1,
    round: g.world ? g.world.round : -1,
    splash: !!document.getElementById('splash'),
    cards: [seen('.hud__banner.is-on'), seen('.screen.is-on'), seen('.hud__net.is-on'),
      seen('.hud__combo.is-on')].filter(Boolean),
    touchOn: document.documentElement.classList.contains('crv2-touch-on'),
    padUp: !document.querySelector('.crv2-touch')?.classList.contains('is-hidden'),
    tier: g.engine.quality.settings.name,
    pr: g.engine.quality.pixelRatio,
    scale: g.engine.quality.effectiveScale,
  };
};

// ---------------------------------------------------------------------------
mkdirSync(dirname(PREFIX), { recursive: true });

let N = null, M = null, geo = null, st = null, fin = null;
if (ANALYSE) {
  // Re-read a capture already on disk. Everything below the shutter is pure
  // analysis, so a meter change costs seconds instead of another walk.
  const { readFileSync } = await import('node:fs');
  const g = JSON.parse(readFileSync(`${PREFIX}-geo.json`, 'utf8'));
  geo = g.geo; st = g.st; fin = g.fin;
  N = readFileSync(`${PREFIX}-match.png`);
  try { M = readFileSync(`${PREFIX}-mask.png`); } catch { M = null; }
  say(`  --analyse: re-reading ${PREFIX}-match.png / -mask.png / -geo.json`);
} else {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio',
      '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: VW, height: VH },
    deviceScaleFactor: DPR,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  // Headless Chromium resolves every env(safe-area-inset-*) to 0, so the notch
  // layout has to be forced or every phone capture is of the no-notch layout.
  await ctx.addInitScript((sf) => {
    const set = () => {
      const s = document.documentElement.style;
      s.setProperty('--safe-t', sf[0] + 'px', 'important');
      s.setProperty('--safe-b', sf[1] + 'px', 'important');
      s.setProperty('--safe-l', sf[2] + 'px', 'important');
      s.setProperty('--safe-r', sf[3] + 'px', 'important');
    };
    if (document.documentElement) set();
    else addEventListener('DOMContentLoaded', set);
  }, SAFE);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => say('  PAGEERROR ' + String(e && e.stack || e).split('\n')[0]));

  say(`\nR17PHONE — ${VW}x${VH}@${DPR}x  insets ${SAFE.join('/')}  arena=${ARENA} tier=${TIER} ticks=${TICKS} seed=${SEED}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  /* Round 14 asked for this and _salience.mjs added it: name the bundle. Four
     agents build into this tree at once, so a capture that does not say what it
     photographed is a set of numbers about somebody else's uncommitted work. */
  const bundle = await page.evaluate(() => [...document.querySelectorAll('script[src]')]
    .map((s) => s.src.split('/').pop()).filter((s) => /^index-/.test(s)).join(',') || '(inline)');
  say(`  bundle: ${bundle}   base: ${BASE}`);
  await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
  await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(700);

  // Tier is forced BEFORE the match so the frame is not a photograph of whatever
  // swiftshader could manage; the adaptive controller is what dropped every
  // previous phone capture to LOW.
  await page.evaluate(({ t, seed }) => {
    const g = window.__game;
    const q = g.engine.quality;
    q.auto = false;
    q.setTier(t);
    g.engine.resize(true);
    // Pin the one nondeterministic input on the shipped path: startMatch's seed
    // defaults to Math.random(). The FIGHT button still calls startMatch.
    const orig = g.startMatch.bind(g);
    g.startMatch = (o = {}) => orig({ ...o, seed });
  }, { t: TIER, seed: SEED });
  await page.waitForTimeout(300);

  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  async function tap(x, y) {
    await touch('touchStart', [{ x, y, id: 1 }]);
    await page.waitForTimeout(60);
    await touch('touchEnd', []);
    await page.waitForTimeout(380);
  }
  async function tapNav(match, sel) {
    const pt = await page.evaluate(({ m, s }) => {
      const screen = document.querySelector('.screen.is-on');
      if (!screen) return { err: 'no screen up' };
      const el = Array.from(screen.querySelectorAll(s || '[data-nav]'))
        .find((e) => (e.textContent || '').replace(/\s+/g, ' ').toUpperCase().includes(m.toUpperCase()));
      if (!el) return { err: `no nav matching ${m}` };
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      if (cy < 0 || cy > innerHeight || cx < 0 || cx > innerWidth) return { err: `"${m}" off-screen` };
      const hit = document.elementFromPoint(cx, cy);
      if (!(hit && (el.contains(hit) || hit === el))) return { err: `"${m}" covered` };
      return { cx, cy };
    }, { m: match, s: sel });
    if (pt.err) { say(`  !! TAP ${pt.err}`); return false; }
    await tap(pt.cx, pt.cy);
    say(`  tap "${match}" at ${Math.round(pt.cx)},${Math.round(pt.cy)}`);
    return true;
  }

  await tapNav('ENTER ARENA');
  await tapNav('TO GARAGE');
  await tapNav('SELECT ARENA');
  if (ARENA) await tapNav(ARENA, '.arena__card');
  if (!(await tapNav('FIGHT'))) { say('  !! could not reach a match by touch'); await browser.close(); process.exit(1); }

  const started = await page.evaluate(() => window.__game.state);
  if (started !== 'match') { say(`  !! state is "${started}", not "match"`); await browser.close(); process.exit(2); }

  // --- freeze, then advance by hand ------------------------------------------
  await page.evaluate((ticks) => {
    const g = window.__game;
    g.setDemo(true);
    g.engine.paused = true;
    // Pinned absolute clock: pausing stops `elapsed` advancing but does not undo
    // what boot accumulated, and the limb animation reads this clock, so an
    // unpinned value moves the pose between runs.
    if (g.engine.clock) g.engine.clock.elapsed = 1000;
    g.fastForward(ticks);
  }, TICKS);
  // The FIGHT card is taken down by a 900ms wall-clock setTimeout started when
  // the sim emits ROUND_START, which the fastForward above just fired.
  await page.waitForFunction(() => !document.querySelector('.hud__banner.is-on'), null,
    { timeout: 20000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(250);

  st = await page.evaluate(() => {
    const w = window.__game.world;
    const r = (v) => Math.round(v * 100) / 100;
    return { tick: w.tick, phase: w.phase,
      a: [r(w.robos[0].pos.x), r(w.robos[0].pos.z)], b: [r(w.robos[1].pos.x), r(w.robos[1].pos.z)],
      sep: r(Math.hypot(w.robos[0].pos.x - w.robos[1].pos.x, w.robos[0].pos.z - w.robos[1].pos.z)) };
  });
  say(`  sim: tick=${st.tick} phase=${st.phase} p1=${st.a} p2=${st.b} separation=${st.sep}m`);

  if (!(await page.evaluate(`(${SETTLE_FN})(240)`))) {
    say('  !! camera rig unavailable — cannot pin the frame');
    await browser.close(); process.exit(3);
  }
  await page.waitForTimeout(500);

  fin = await page.evaluate(OVERLAYS);
  say(`  CAPTURING state=${fin.state} phase=${fin.phase} tick=${fin.tick} round=${fin.round} ` +
    `tier=${fin.tier} pr=${fin.pr} scale=${fin.scale} touchOn=${fin.touchOn} padUp=${fin.padUp} ` +
    `cards=${fin.cards.length ? JSON.stringify(fin.cards) : 'NONE'}`);
  if (fin.cards.length) say('  !! A CARD IS UP — this frame is not card-free');

  // --- DOM geometry and the camera projection, in DEVICE pixels ---------------
  geo = await page.evaluate((dpr) => {
    const R = (b) => ({ x: Math.round(b.left * dpr), y: Math.round(b.top * dpr),
      w: Math.round(b.width * dpr), h: Math.round(b.height * dpr) });
    const out = { rects: [], canvas: null, machines: [] };
    const add = (name, sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      out.rects.push({ name, ...R(b) });
    };
    const cv = document.getElementById('view');
    out.canvas = R(cv.getBoundingClientRect());
    out.backing = { w: cv.width, h: cv.height };
    add('fire', '.tb--fire');
    add('bomb', '.tb--bomb');
    add('dash', '.tb--dash');
    add('jump', '.tb--jump');
    add('pod', '.tb--pod');
    add('stick', '.tc__stick');
    add('pause', '.tc__pause');
    add('hudtop', '.hud__top');
    add('hudgear', '.hud__gear');
    const bs = Array.from(document.querySelectorAll('.tb')).map((e) => e.getBoundingClientRect());
    if (bs.length) {
      const x0 = Math.min(...bs.map((b) => b.left)), y0 = Math.min(...bs.map((b) => b.top));
      const x1 = Math.max(...bs.map((b) => b.right)), y1 = Math.max(...bs.map((b) => b.bottom));
      out.rects.push({ name: 'buttons', x: Math.round(x0 * dpr), y: Math.round(y0 * dpr),
        w: Math.round((x1 - x0) * dpr), h: Math.round((y1 - y0) * dpr) });
    }
    // The HUD block the ruling measures: the union of everything the HUD paints
    // above the arena.
    const hs = ['.hud__top', '.hud__gear'].map((s) => document.querySelector(s))
      .filter(Boolean).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 1);
    if (hs.length) {
      const x0 = Math.min(...hs.map((b) => b.left)), y0 = Math.min(...hs.map((b) => b.top));
      const x1 = Math.max(...hs.map((b) => b.right)), y1 = Math.max(...hs.map((b) => b.bottom));
      out.rects.push({ name: 'hudblock', x: Math.round(x0 * dpr), y: Math.round(y0 * dpr),
        w: Math.round((x1 - x0) * dpr), h: Math.round((y1 - y0) * dpr) });
    }
    // Where the camera says each machine is, independent of the stencil.
    const g = window.__game;
    const cam = g.camera;
    /*
     * NDC maps to the CANVAS, not to the window, and those stopped being the
     * same thing when portrait was letterboxed. This projected into the full
     * frame, so with a render band 69.7% of the frame's height every machine
     * landed low and short: the near machine fell outside the mask the tool
     * matches against and was reported "not in stencil", while the far one was
     * matched to the near machine's blob and came back 408x1201 px against a
     * projected height of 106. Both figures were nonsense and neither was the
     * game's fault.
     *
     * Taken off the canvas's own client rect, which is where the renderer put
     * the pixels, plus its offset within the frame.
     */
    const cr = document.getElementById('view').getBoundingClientRect();
    const toPx = (v) => ({
      x: ((v.x * 0.5 + 0.5) * cr.width + cr.left) * dpr,
      y: ((-v.y * 0.5 + 0.5) * cr.height + cr.top) * dpr,
      z: v.z,
    });
    for (let i = 0; i < g.world.robos.length; i++) {
      const r = g.world.robos[i];
      const V = g.camera.position.constructor;      // THREE.Vector3, borrowed
      const foot = new V(r.pos.x, r.pos.y, r.pos.z).project(cam);
      const head = new V(r.pos.x, r.pos.y + 1.62, r.pos.z).project(cam);
      const f = toPx(foot), h = toPx(head);
      out.machines.push({ i, local: i === g.localIndex, behind: foot.z > 1 || head.z > 1,
        footY: Math.round(f.y), headY: Math.round(h.y), cx: Math.round((f.x + h.x) / 2),
        projH: Math.round(Math.abs(f.y - h.y)) });
    }
    out.fov = cam.fov; out.aspect = Math.round(cam.aspect * 1000) / 1000;
    return out;
  }, DPR);
  say(`  canvas ${geo.canvas.w}x${geo.canvas.h} at ${geo.canvas.x},${geo.canvas.y}` +
    `  backing ${geo.backing.w}x${geo.backing.h}  fov=${geo.fov} aspect=${geo.aspect}`);

  // Written BEFORE the shutter so a failed analysis can be re-run off the PNGs
  // with --analyse instead of paying 90s to reach the match again.
  writeFileSync(`${PREFIX}-geo.json`, JSON.stringify({ geo, st, fin }, null, 1));
  N = await page.screenshot({ path: `${PREFIX}-match.png`, timeout: 240000 });
  if (!NOSTENCIL) {
    await page.evaluate(`(${STENCIL_FN})(true)`);
    for (const id of ['ui-layer', 'hud-layer', 'splash']) {
      await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
    }
    await page.waitForTimeout(500);
    M = await page.screenshot({ path: `${PREFIX}-mask.png`, timeout: 240000 });
  }
  await browser.close();
}

// --- analysis --------------------------------------------------------------
const ab = await chromium.launch({ executablePath: PINNED, args: ['--disable-dev-shm-usage'] });
const probe = await (await ab.newContext()).newPage();
await probe.goto('about:blank');
const out = await probe.evaluate(async ({ nUri, mUri, TILE, geo }) => {
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
  const W = N.W, H = N.H;
  // Definitions verbatim from shots/_salience.mjs, the authority meter.
  const lum = new Float32Array(W * H);
  const chr = new Float32Array(W * H);      // chroma (max-min)/255, 0..1
  const sat = new Float32Array(W * H);      // HSV S, for the framesal cross-read
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    const R = N.d[i], G = N.d[i + 1], B = N.d[i + 2];
    lum[p] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
    chr[p] = d / 255;
    sat[p] = mx ? d / mx : 0;
  }
  const sorted = Float32Array.from(lum).sort();
  const bright = sorted[Math.floor(W * H * 0.99)];
  let nBright = 0, nSat = 0, nSatL = 0;
  for (let p = 0; p < W * H; p++) {
    if (lum[p] >= bright) nBright++;
    if (sat[p] >= 0.35) { nSat++; if (lum[p] >= 40) nSatL++; }
  }

  // --- machine stencil -----------------------------------------------------
  let mask = null, comps = [], comp = null;
  if (mUri) {
    const Mi = await load(mUri);
    mask = new Uint8Array(W * H);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      if (0.2126 * Mi.d[i] + 0.7152 * Mi.d[i + 1] + 0.0722 * Mi.d[i + 2] > 128) mask[p] = 1;
    }
    comp = new Int32Array(W * H).fill(-1);
    const stack = new Int32Array(W * H);
    for (let p = 0; p < W * H; p++) {
      if (!mask[p] || comp[p] >= 0) continue;
      const id = comps.length;
      let sp = 0, n = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
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
        if (qy < H - 1 && mask[q + W] && comp[q + W] < 0) { comp[q + W] = id; stack[sp++] = q + W; }
      }
      comps.push({ id, n, x0, x1, y0, y1 });
    }
    // Keep the ORIGINAL component id: `comp[]` indexes into the unfiltered
    // list, so filtering and re-sorting this array without carrying `c.id`
    // silently re-points every lookup.
    comps = comps.filter((c) => c.n >= 120).sort((a, b) => b.n - a.n);
  }

  // Attach every component to the machine whose projected centre is nearest,
  // so "player" and "opponent" are decided by the camera, not by guessing.
  const machines = geo.machines.map((m) => ({ ...m, px: 0, x0: W, x1: 0, y0: H, y1: 0, parts: 0 }));
  const owner = {};
  if (mask) {
    for (const c of comps) {
      const ccx = (c.x0 + c.x1) / 2, ccy = (c.y0 + c.y1) / 2;
      let best = 0, bd = Infinity;
      machines.forEach((m, k) => {
        const d = Math.hypot(m.cx - ccx, (m.footY + m.headY) / 2 - ccy);
        if (d < bd) { bd = d; best = k; }
      });
      const m = machines[best];
      m.px += c.n; m.parts++;
      m.x0 = Math.min(m.x0, c.x0); m.x1 = Math.max(m.x1, c.x1);
      m.y0 = Math.min(m.y0, c.y0); m.y1 = Math.max(m.y1, c.y1);
      c.owner = best;
      owner[c.id] = best;
    }
  }
  const ownerOf = (p) => (comp && comp[p] >= 0 && owner[comp[p]] !== undefined ? owner[comp[p]] : -1);

  // area, share of the brightest 1%, chroma MASS (sum of the authority meter's
  // chroma), and the two saturated-pixel counts: REVIEW2's bare S >= 0.35 and
  // _framesal.mjs's visible-chroma gate. Reported side by side, each labelled,
  // so a later round cannot mistake one for another.
  let chrMass = 0;
  for (let p = 0; p < W * H; p++) chrMass += chr[p];
  const shareOf = (test) => {
    let a = 0, b = 0, s = 0, sl = 0, cm = 0;
    for (let p = 0; p < W * H; p++) {
      if (!test(p)) continue;
      a++;
      cm += chr[p];
      if (lum[p] >= bright) b++;
      if (sat[p] >= 0.35) { s++; if (lum[p] >= 40) sl++; }
    }
    return { area: a, bright: b, sat: s, satL: sl, chroma: cm };
  };

  const rects = geo.rects.map((r) => {
    const inRect = (p) => {
      const x = p % W, y = (p / W) | 0;
      return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    };
    const v = shareOf(inRect);
    // Machine pixels this control covers, and the gap to the nearest one.
    let cover = 0, gap = Infinity;
    if (mask) {
      for (let p = 0; p < W * H; p++) {
        if (!mask[p]) continue;
        const x = p % W, y = (p / W) | 0;
        const dx = x < r.x ? r.x - x : x >= r.x + r.w ? x - (r.x + r.w - 1) : 0;
        const dy = y < r.y ? r.y - y : y >= r.y + r.h ? y - (r.y + r.h - 1) : 0;
        const d = Math.hypot(dx, dy);
        if (d === 0) cover++;
        if (d < gap) gap = d;
      }
    }
    return { ...r, ...v, cover, gap: gap === Infinity ? -1 : Math.round(gap) };
  });

  const machineStats = machines.map((m, k) => {
    if (!mask || !m.px) return { ...m, area: 0, bright: 0, sat: 0, satL: 0, chroma: 0 };
    return { ...m, ...shareOf((p) => !!mask[p] && ownerOf(p) === k) };
  });
  const allMach = mask ? shareOf((p) => !!mask[p])
    : { area: 0, bright: 0, sat: 0, satL: 0, chroma: 0 };

  // --- the authority meter's tile sweep -----------------------------------
  // Model A = lum x chroma, T in {32,40,48,64} x offset {0, T/2}. A tile is
  // MACHINE at >= 50% machine pixels and a control at >= 50% AREA coverage —
  // the same rule for both sides, which is what instrument fault 14 was about.
  const named = geo.rects.filter((r) => r.name !== 'hudblock');
  const sweep = [];
  let topA40 = null;
  for (const T of [32, 40, 48, 64]) {
    for (const off of [0, T >> 1]) {
      const cols = Math.floor((W - off) / T), rows = Math.floor((H - off) / T);
      const tiles = [];
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const x0 = off + tx * T, y0 = off + ty * T;
          let sl = 0, sc = 0, mc = 0, n = 0;
          for (let y = y0; y < y0 + T; y++) {
            for (let x = x0; x < x0 + T; x++) {
              const p = y * W + x;
              sl += lum[p]; sc += chr[p]; if (mask && mask[p]) mc++; n++;
            }
          }
          const t = { x: x0, y: y0, l: sl / n, c: sc / n, m: mc / n };
          t.s = t.l * t.c;
          t.cov = {};
          for (const r of named) {
            const ox = Math.max(0, Math.min(x0 + T, r.x + r.w) - Math.max(x0, r.x));
            const oy = Math.max(0, Math.min(y0 + T, r.y + r.h) - Math.max(y0, r.y));
            t.cov[r.name] = (ox * oy) / (T * T);
          }
          tiles.push(t);
        }
      }
      tiles.sort((a, b) => b.s - a.s);
      const row = { T, off, total: tiles.length, machineRank: null, machineTop14: 0, rect: {} };
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        if (t.m >= 0.5) {
          if (row.machineRank === null) row.machineRank = i + 1;
          if (i < 14) row.machineTop14++;
        }
        for (const r of named) {
          if (t.cov[r.name] < 0.5) continue;
          const e = row.rect[r.name] || (row.rect[r.name] = { rank: null, top14: 0 });
          if (e.rank === null) e.rank = i + 1;
          if (i < 14) e.top14++;
        }
      }
      sweep.push(row);
      if (T === 40 && off === 0) {
        topA40 = tiles.slice(0, 14).map((t) => {
          let label = t.m >= 0.5 ? 'MACHINE' : 'stage';
          if (label === 'stage') {
            let bestN = null, bestC = 0.5;
            for (const r of named) if (t.cov[r.name] >= bestC) { bestC = t.cov[r.name]; bestN = r.name; }
            if (bestN) label = bestN;
          }
          return { x: t.x, y: t.y, l: Math.round(t.l * 10) / 10, c: Math.round(t.c * 1000) / 1000,
            s: Math.round(t.s * 10) / 10, m: Math.round(t.m * 100) / 100, label };
        });
      }
    }
  }
  return { W, H, bright, nBright, nSat, nSatL, chrMass, rects, machines: machineStats, allMach, sweep, topA40,
    comps: comps.map((c) => ({ n: c.n, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, owner: c.owner })) };
}, { nUri: 'data:image/png;base64,' + N.toString('base64'),
  mUri: M ? 'data:image/png;base64,' + M.toString('base64') : null, TILE, geo });
await ab.close();

// --- report ----------------------------------------------------------------
const { W, H } = out;
const band = geo.canvas;
const pct = (a, b) => (100 * a / b).toFixed(1);
say(`\n  FRAME ${W}x${H}   RENDER BAND ${band.w}x${band.h} at ${band.x},${band.y}` +
  `  = ${pct(band.w * band.h, W * H)}% of frame area, ${pct(band.h, H)}% of frame height`);

say(`\n  MACHINES (stencil mask + camera projection)`);
say(`    who        maskbox                px      maskH   projH   %frameH  %bandH  clipped`);
for (const m of out.machines) {
  const who = m.local ? 'PLAYER' : 'OPPONENT';
  const mh = m.px ? m.y1 - m.y0 + 1 : 0;
  const clip = [];
  if (m.px) {
    if (m.y1 >= band.y + band.h - 2) clip.push('BOTTOM');
    if (m.y0 <= band.y + 1) clip.push('top');
    if (m.x0 <= band.x + 1) clip.push('left');
    if (m.x1 >= band.x + band.w - 2) clip.push('right');
  }
  say(`    ${who.padEnd(9)}  ${m.px ? `${m.x0},${m.y0} ${m.x1 - m.x0 + 1}x${mh}`.padEnd(21) : 'not in stencil'.padEnd(21)}` +
    ` ${String(m.px).padStart(7)} ${String(mh).padStart(7)} ${String(m.projH).padStart(7)}` +
    ` ${pct(mh, H).padStart(8)} ${pct(mh, band.h).padStart(7)}  ${clip.join('+') || '-'}`);
}

const opp = out.machines.find((m) => !m.local);
const oppH = opp && opp.px ? opp.y1 - opp.y0 + 1 : (opp ? opp.projH : 0);
say(`\n  CONTROLS (device px)   size        vs opponent H   machine px covered   gap to machine`);
for (const r of out.rects) {
  const big = oppH ? (Math.max(r.w, r.h) / oppH).toFixed(2) + 'x' : '-';
  say(`    ${r.name.padEnd(10)} ${`${r.x},${r.y}`.padStart(10)}  ${`${r.w}x${r.h}`.padEnd(11)} ${big.padStart(9)}` +
    `        ${String(r.cover).padStart(9)}        ${r.gap >= 0 ? String(r.gap) + 'px' : '-'}`);
}

say(`\n  SALIENCE — rules copied from shots/_salience.mjs, THE AUTHORITY METER.`);
say(`    brightest-1% threshold L=${out.bright.toFixed(0)} (${out.nBright} px).` +
  `  chroma = (max-min)/255.  S = HSV saturation.`);
say(`    what            area%   bright1%   chromaMass%   S>=.35%   [framesal S&L>=40%]   light/area  chroma/area`);
const rowsFor = [];
if (out.allMach.area) rowsFor.push({ name: 'MACHINES', ...out.allMach });
for (const m of out.machines) if (m.area) rowsFor.push({ name: ' ' + (m.local ? 'player' : 'opponent'), ...m });
for (const r of out.rects) rowsFor.push(r);
for (const r of rowsFor) {
  const ap = 100 * r.area / (W * H);
  const bp = 100 * r.bright / (out.nBright || 1);
  const cm = 100 * r.chroma / (out.chrMass || 1);
  const sp = 100 * r.sat / (out.nSat || 1);
  const lp = 100 * r.satL / (out.nSatL || 1);
  say(`    ${r.name.padEnd(14)} ${ap.toFixed(2).padStart(6)} ${bp.toFixed(1).padStart(10)} ${cm.toFixed(1).padStart(13)}` +
    ` ${sp.toFixed(1).padStart(9)} ${lp.toFixed(1).padStart(21)}   ${(bp / (ap || 1)).toFixed(2).padStart(9)}x` +
    ` ${(cm / (ap || 1)).toFixed(2).padStart(10)}x`);
}

say(`\n  TILE SWEEP (authority meter's model A = lum x chroma; MACHINE at >=50% machine px,`);
say(`              control at >=50% AREA coverage — fault 14's fair rule, both sides)`);
const ctlNames = out.rects.filter((r) => r.name !== 'hudblock').map((r) => r.name);
say(`    T   off   cells   machine rank / in top14   ` + ctlNames.map((n) => n.slice(0, 6)).join('  '));
for (const s of out.sweep) {
  const cells = ctlNames.map((n) => {
    const e = s.rect[n];
    return (e && e.rank ? String(e.rank) : '-').padStart(6);
  }).join('  ');
  say(`   ${String(s.T).padStart(2)} ${String(s.off).padStart(4)} ${String(s.total).padStart(7)}` +
    `   ${String(s.machineRank ?? '-').padStart(6)} / ${String(s.machineTop14).padStart(2)}         ${cells}`);
}
say(`\n  TOP 14 TILES, model A at T=40 offset 0 (the authority meter's headline grid)`);
for (const [i, t] of out.topA40.entries()) {
  say(`   ${String(i + 1).padStart(2)}. ${String(t.x).padStart(5)},${String(t.y).padStart(5)}` +
    `  score ${String(t.s).padStart(6)}  lum ${String(t.l).padStart(5)}  chroma ${String(t.c).padStart(5)}` +
    `  machine ${String(t.m).padStart(4)}   ${t.label}`);
}
const machineTiles = out.topA40.filter((t) => t.label === 'MACHINE').length;
say(`   -> ${machineTiles} of the top 14 tiles are MACHINE`);

writeFileSync(`${PREFIX}-report.txt`, log.join('\n') + '\n');
writeFileSync(`${PREFIX}.json`, JSON.stringify({ geo, out, st, fin }, null, 1));
say(`\n  wrote ${PREFIX}-match.png ${PREFIX}-mask.png ${PREFIX}-report.txt ${PREFIX}.json`);
writeFileSync(`${PREFIX}-report.txt`, log.join('\n') + '\n');
