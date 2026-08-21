#!/usr/bin/env node
/**
 * VFX contact sheet — captures one effect at several *ages* from a single run.
 *
 * Why this exists, and why it is not just a flag on screenshot.mjs:
 *
 * `clock.elapsed` — the clock every effect ages against — advances by whatever
 * the last frame really took, clamped to one tick only when that exceeds 250ms.
 * Under software GL that clamp fires on big viewports and does not fire on
 * small ones, so effect age per rendered frame is neither 16.7ms nor wall time;
 * it is unpredictable. Worse, `page.screenshot()` takes *seconds* here and the
 * render loop keeps running throughout, so a shot taken right after "advance
 * one frame" is actually of some unknowable later moment. That is why every
 * explosion capture in `shots/` looked like a different random instant with no
 * fireball in it — not because the fireball was missing.
 *
 * So this harness does not race the clock, it owns it: `engine.paused` freezes
 * the sim, the camera and `clock.elapsed`, and the age of the effect is then
 * *written* directly into `clock.elapsed` before each capture. Everything in
 * vfx.js is integrated on the GPU from (birth, life) against that one uniform,
 * so a written time is an exact age, held perfectly still for as long as the
 * screenshot needs. A whole lifetime gets walked in one run, from one blast,
 * with the camera nailed down so the crop stays on it.
 *
 *   node tools/vfxsheet.mjs --base http://127.0.0.1:4203/ --tier 3
 *   node tools/vfxsheet.mjs --effect tracer --out shots/sheet-tracer.png
 *   node tools/vfxsheet.mjs --effect probe          # DOM/canvas luminance probe
 *
 * Flags:
 *   --effect  explosion | ko | tracer | impact | probe
 *   --ages    "0,40,110"  only these ages, in ms — a three-tile sheet is under
 *             a minute where the full twelve is four, which is the difference
 *             between tuning an effect and guessing at it
 *   --nowide  skip the full-frame staging shot (costs about three tiles)
 *   --zoom    crop side in CSS px (default 560)
 *   --keep    also write every tile to shots/frames/
 *
 * Output is a single labelled grid PNG, plus the individual frames when
 * `--keep` is passed.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4203/');
const EFFECT = flag('effect', 'explosion');
const TIER = flag('tier', '3');
const KEEP = !!flag('keep');
const ZOOM = Number(flag('zoom', 560));      // crop side length in CSS px
const AGES_ARG = flag('ages', null);         // "0,40,110" — fewer tiles, faster loop
const NOWIDE = !!flag('nowide');             // skip the 1600x900 staging frame
const OUT = flag('out', `shots/sheet-${EFFECT}.png`);
const VP = { width: 1600, height: 900 };
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Ages in ms, written straight into the effect clock. */
const AGES = {
  explosion: [0, 17, 40, 70, 110, 165, 240, 340, 470, 650, 950, 1400],
  ko: [0, 33, 100, 200, 350, 550, 800, 1100, 1500, 2000, 2600, 3200],
  tracer: [0, 17, 33, 50, 67, 83, 100, 133, 167, 217, 283, 350],
  impact: [0, 17, 33, 50, 67, 100, 133, 183, 250, 350, 500, 700],
};

/** Age, in seconds, the wide staging frame is taken at. */
const PEAK = { explosion: 0.11, ko: 0.20, tracer: 0.08, impact: 0.05 };

/** Effects whose subject is a live projectile: step the sim alongside the clock. */
const LOCKSTEP = { tracer: true };

// ---------------------------------------------------------------------------

async function frames(page, n) {
  if (n <= 0) return;
  // If the page did go away under us, say so here rather than three calls later
  // with a bare "cannot read properties of undefined".
  const target = await page.evaluate((k) => {
    if (!window.__game) throw new Error('window.__game is gone — the page reloaded mid-run');
    return window.__game.engine.clock.frame + k;
  }, n);
  await page.waitForFunction(
    (t) => window.__game.engine.clock.frame >= t,
    target,
    { timeout: 240000, polling: 30 }
  );
}

/**
 * Freeze the sim, the camera, the grade and the effect clock.
 *
 * `engine.paused` only stops the fixed step. `onRender` still runs on every
 * rendered frame, and three things in it move on their own: the camera rig
 * damps toward its framing target, the grade uniforms (exposure, saturation,
 * vignette) damp toward theirs, and the hit flash decays. A twelve-tile walk
 * takes hundreds of rendered frames under software GL, so without this the
 * sheet is a slow dolly with a slow exposure ramp laid over it and no two
 * tiles are comparable — which defeats the entire point of holding the age.
 *
 * So the rig is nailed shut and the grade is written straight to the value it
 * was converging on. After this the only thing in the frame that can change is
 * the number written into `clock.elapsed`.
 */
const freeze = (page) => page.evaluate(() => {
  const g = window.__game;
  g.engine.paused = true;

  if (!g.rig.__frozen) {
    g.rig.__frozen = true;
    g.rig.update = () => {};
    g.rig.addShake = () => {};
    g.rig.speedBlur = 0;
  }

  const u = g.engine.postfx.uniforms;
  const me = g.world?.robos?.[g.localIndex];
  const low = me ? me.hp / me.maxHp < 0.25 : false;
  u.exposure.value = low ? 1.18 : 1.35;
  u.saturation.value = low ? 0.9 : 1.16;
  u.vignette.value = low ? 0.58 : 0.34;
  u.hitFlash.value = 0;
  u.radialBlur.value = 0;
  u.shockwave.value = 0;
  g.flash = 0;
  g.shockTimer = 0;
  g.hitstop = 0;

  // Pin the effect clock to a fixed absolute value. Nothing downstream needs it
  // to be the real elapsed time — every effect ages against `uTime - birth` —
  // and pinning it means every birth time, every uniform and every animated
  // grade term in the sheet is the same number on every run instead of being
  // offset by however long the browser took to boot.
  g.engine.clock.elapsed = 1000;

  return g.engine.clock.elapsed;
});

/** Write an absolute effect-clock time and render one frame at it. */
async function scrubTo(page, seconds) {
  await page.evaluate((t) => { window.__game.engine.clock.elapsed = t; }, seconds);
  await frames(page, 1);
}

async function boot(browser) {
  const context = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });

  // A full walk takes minutes. Anyone else saving a file anywhere in the repo
  // makes the dev server broadcast a reload, and a reload lands mid-walk and
  // takes `window.__game` with it — the run dies with "cannot read properties
  // of undefined" after eight good tiles. The page only needs the modules it
  // loaded at boot, so the HMR socket is refused and the page is pinned to the
  // code it started with.
  await context.addInitScript(() => {
    const Real = window.WebSocket;
    const isVite = (p) => (Array.isArray(p) ? p.includes('vite-hmr') : p === 'vite-hmr');
    window.WebSocket = new Proxy(Real, {
      construct(target, args) {
        if (!isVite(args[1])) return new target(...args);
        return {
          readyState: 3, url: String(args[0]), protocol: '',
          send() {}, close() {},
          addEventListener() {}, removeEventListener() {},
          set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {},
        };
      },
    });
  });

  const page = await context.newPage();
  // Software GL renders a tier-3 frame in seconds, and page.screenshot() waits
  // for a stable frame — the 30s default fires long before the compositor has
  // one to hand back.
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e?.stack ? String(e.stack) : String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game?.engine?.running, null, { timeout: 90000 });

  if (TIER != null) {
    await page.evaluate((t) => {
      const q = window.__game.engine.quality;
      q.auto = false;
      q.setTier(Number(t));
      // Pinning the tier is not pinning the resolution. The auto-scaler ran on
      // every frame between page load and this call, and under software GL it
      // has always already walked `dynamicScale` down — by a different number
      // of 0.08 steps each run, because it is reacting to how loaded the box
      // is. `effectiveScale` multiplies it into the render target, so the whole
      // frame was being rendered at 1600x900, or 1472x828, or 1216x684 and
      // upscaled: two runs differed softly along every edge in the arena, which
      // looks exactly like a camera that has not settled.
      q.dynamicScale = 1;
      q.cooldown = 1e9;
      window.__game.engine.resize(true);
    }, TIER);
    await frames(page, 3);
  }
  return { context, page, errors };
}

/**
 * `startMatch` defaults its seed to `Math.random()`. Without one pinned here the
 * 380 ticks below are a different fight every run: the robots end up somewhere
 * else, the blast is ignited at their midpoint, and the crop lands on a
 * different piece of arena — so two sheets taken minutes apart are not of the
 * same shot and cannot be compared. Same fixed value the other capture tools
 * use.
 */
const MATCH_SEED = 0x5eed1234;

/** Seed for the effects layer's own jitter. See `VFX.seedJitter`. */
const VFX_SEED = 0x0b1a5701;

async function enterMatch(page, ticks = 380) {
  // `paused` goes on the same line as `startMatch`, not two round-trips later.
  // A rendered frame under software GL is worth anywhere from one to fifteen
  // sim ticks (`acc += dt`, clamped only above 250 ms), so even the two frames
  // this used to render before pausing moved the fight by a load-dependent
  // amount: the robots ended up somewhere else, the blast is ignited at their
  // midpoint, and the crop landed on a different piece of arena. Two sheets
  // minutes apart differed on 44% of their pixels because of these two frames.
  await page.evaluate((seed) => {
    const g = window.__game;
    g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'grid', loadouts: g.loadouts, seed });
    g.engine.paused = true;
    g.setDemo(true);
  }, MATCH_SEED);
  await frames(page, 2);
  await page.evaluate((n) => window.__game.fastForward(n), ticks);
  // The rig has to catch up before the freeze: `fastForward` teleports the fight
  // a long way from wherever the camera was last pointed, and freezing it
  // mid-swing shoots the sheet from a place the game would never frame from.
  //
  // It is settled by hand on a fixed 1/60 delta rather than by rendering real
  // frames, because a real frame damps by the *wall-clock* delta and a software
  // GL frame is worth anywhere between 50 ms and half a second depending on how
  // loaded the box is.
  //
  // The step count is not "enough to look settled", it is enough to converge to
  // *bit equality*. The rig's slowest term decays by about exp(-2*dt) a step,
  // i.e. a factor of 0.967, and the two rendered frames before this leave the
  // camera metres from its target with a load-dependent error. Four seconds
  // (240 steps) only takes that error down by 1e-4 — still a fraction of a
  // pixel of parallax, which is enough to light up every edge in the frame in a
  // diff and put the integer crop rectangle one pixel over. Twenty-five seconds
  // takes it below double precision, so the last few hundred steps are exact
  // no-ops and the camera lands on the same float on every run.
  //
  // ...and that argument holds for every term in the rig EXCEPT the one that
  // matters, which is why the pin line still drifted between runs:
  //
  //     run A   cam=5.8248,4.1261,11.8550  rot=-0.4355,-0.0111
  //     run B   cam=6.0009,3.9910,11.8843  rot=-0.4332,-0.0032
  //
  // Eighteen centimetres and eight milliradians apart, from an identical sim
  // state — same tick, same two robot positions to the centimetre. That is not
  // an unconverged exponential; it is a *closed loop*. `camera.js`'s framing
  // check projects the opponent through the camera, derives `anchorBias`,
  // `lookAhead`, `fitBoost` and `aimDrop` from where they land, and then those
  // four move the camera that did the projecting — with deliberately asymmetric
  // damping (2.2 opening, 0.8 closing). A feedback loop with asymmetric rates
  // is not obliged to converge to a point, and this one does not; where it ends
  // up depends on the rig state it started from. That state is whatever
  // `engine.onRender` left behind after damping by real wall-clock deltas for
  // however many frames the box managed while the page was booting. The settle
  // was deterministic. Its *input* was not.
  //
  // Fixed by starting the settle from a canonical rig state rather than from
  // the boot's leftovers. These are the rig's own resting values, written back
  // verbatim, so this reproduces framing the game reaches on its own and simply
  // strips the boot's history out of it.
  await page.evaluate((n) => {
    const g = window.__game;
    const r = g.rig;
    const canon = {
      yaw: 0, yawOffset: 0, pitch: 0.1, roll: 0,
      distance: 7, height: 3, introT: 0, mode: 'duel',
      anchorBias: 0, lookAhead: 1, fitBoost: 1, aimDrop: 0,
      fovOffset: 0, _speedBlur: 0, shakeRoll: 0,
    };
    for (const k of Object.keys(canon)) if (k in r) r[k] = canon[k];
    if (r.shake && r.shake.set) r.shake.set(0, 0, 0);
    // The smoothed pose is seeded just behind the player rather than at the
    // origin: from the origin the first step swings the boom across the whole
    // arena, and the clamp that keeps the camera inside the arena shell is not
    // a damped term, so that one swing can leave a permanent mark on the result.
    const me = g.world.robos[g.localIndex];
    if (r.smoothPos && r.smoothPos.set) r.smoothPos.set(me.pos.x, me.pos.y + 3, me.pos.z + 7);
    if (r.smoothTarget && r.smoothTarget.set) r.smoothTarget.set(me.pos.x, me.pos.y + 1, me.pos.z);

    let t = 0;
    for (let i = 0; i < n; i++) {
      g.rig.update(g.world, g.view.prepare(1), g.localIndex, 1 / 60, t);
      t += 1 / 60;
    }
    g.view.update(0, 1, g.engine.clock.elapsed);
  }, 1500);

  // From here the page renders on a *pinned* delta. `paused` gates only the
  // fixed step; `engine.onRender` still fires on every rendered frame with the
  // real wall-clock delta, and `_render` feeds that delta to the camera rig,
  // the grade damping and — the one that actually broke this harness —
  // `view.update`, which drives the thruster emitters. A `page.screenshot()`
  // under software GL is worth dozens of rendered frames, each one aging the
  // plumes and drawing values out of `vfxRng`, so the effect being captured had
  // a different random seed by the time the shutter closed and every tile after
  // the first was of a different blast.
  //
  // Replacing the callback with a dt=0 render keeps everything the frame needs
  // — model placement, billboarding, `vfx.update`'s uniform writes, the shell
  // pools' flush — while integrating nothing. Rendering the same frame twice
  // now gives the same pixels, which is the entire premise of a contact sheet.
  await page.evaluate(() => {
    const g = window.__game;
    g.engine.onRender = () => { g.view.update(0, 1, g.engine.clock.elapsed); };
  });
  await frames(page, 2);
}

/**
 * Detonate a bomb at a chosen point and return where it lands on screen, so the
 * sheet can crop to the blast instead of to the middle of the arena.
 */
async function igniteExplosion(page, opts = {}) {
  return page.evaluate((o) => {
    const g = window.__game;
    const w = g.world;
    const a = w.robos[0], b = w.robos[1];
    const x = o.x ?? (a.pos.x + b.pos.x) / 2;
    const z = o.z ?? (a.pos.z + b.pos.z) / 2;
    const y = o.y ?? 1.1;
    const p = w.alloc();
    if (!p) return null;
    p.alive = 1; p.kind = 1; p.owner = 1; p.team = 1;
    p.pos.x = x; p.pos.y = y; p.pos.z = z;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.life = 1; p.maxLife = 1;
    p.damage = 120; p.radius = o.radius ?? 4.2; p.knockback = 9;
    p.partIdx = 0; p.seed = 12345;
    // Two sim steps: one to tick the fuse to zero, one for the blast to resolve.
    g.fastForward(2);
    return { x, y, z };
  }, opts);
}

/** Project a world point to CSS pixels for the crop rectangle. */
async function projectPoint(page, pt) {
  return page.evaluate((p) => {
    const g = window.__game;
    const cam = g.camera;
    const THREE = window.__THREE;
    const v = THREE
      ? new THREE.Vector3(p.x, p.y, p.z)
      : { x: p.x, y: p.y, z: p.z };
    // No THREE handle on window in the production bundle — do it by hand with
    // the camera's own matrices, which are already up to date this frame.
    cam.updateMatrixWorld();
    const m = cam.projectionMatrix.elements;
    const vm = cam.matrixWorldInverse.elements;
    const X = p.x, Y = p.y, Z = p.z;
    const ex = vm[0] * X + vm[4] * Y + vm[8] * Z + vm[12];
    const ey = vm[1] * X + vm[5] * Y + vm[9] * Z + vm[13];
    const ez = vm[2] * X + vm[6] * Y + vm[10] * Z + vm[14];
    const cx = m[0] * ex + m[4] * ey + m[8] * ez + m[12];
    const cy = m[1] * ex + m[5] * ey + m[9] * ez + m[13];
    const cw = m[3] * ex + m[7] * ey + m[11] * ez + m[15];
    void v;
    const ndcX = cx / cw, ndcY = cy / cw;
    return {
      x: (ndcX * 0.5 + 0.5) * window.innerWidth,
      y: (-ndcY * 0.5 + 0.5) * window.innerHeight,
      behind: cw <= 0,
    };
  }, pt);
}

function cropRect(centre, side) {
  const half = side / 2;
  let x = Math.round(centre.x - half);
  let y = Math.round(centre.y - half);
  x = Math.max(0, Math.min(VP.width - side, x));
  y = Math.max(0, Math.min(VP.height - side, y));
  return { x, y, width: side, height: side };
}

/**
 * Sample the captured PNG rather than eyeballing it, so "is there actually
 * anything bright here" is a number instead of an opinion.
 *
 * The pixels have to come out of the screenshot, not out of the live canvas:
 * the renderer runs without `preserveDrawingBuffer`, so the drawing buffer is
 * already cleared by the time script can read it and `drawImage(canvas)` hands
 * back black. The screenshot is decoded back inside the page instead, which is
 * the one place with an image decoder.
 */
async function analyze(page, buf) {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let max = 0, sum = 0, over200 = 0, over128 = 0, warm = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (lum > max) max = lum;
      sum += lum;
      if (lum > 200) over200++;
      if (lum > 128) over128++;
      if (d[i] > d[i + 2] + 30) warm++;
      n++;
    }
    bmp.close();
    return {
      max: Math.round(max),
      mean: Math.round(sum / n),
      pctOver200: +(100 * over200 / n).toFixed(2),
      pctOver128: +(100 * over128 / n).toFixed(2),
      pctWarm: +(100 * warm / n).toFixed(2),
    };
  }, buf.toString('base64'));
}

// ---------------------------------------------------------------------------
// Contact sheet composition — a second page, an <img> grid, one screenshot.
// ---------------------------------------------------------------------------

async function composeSheet(browser, tiles, outPath, title) {
  const cols = 4;
  const rows = Math.ceil(tiles.length / cols);
  const cell = 380;
  const context = await browser.newContext({
    viewport: { width: cols * cell + 40, height: rows * (cell + 34) + 90 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const cells = tiles.map((t) => `
    <figure>
      <img src="data:image/png;base64,${t.b64}">
      <figcaption>${t.label}<span>${t.note || ''}</span></figcaption>
    </figure>`).join('');

  await page.setContent(`<!doctype html><meta charset="utf-8">
  <style>
    :root { color-scheme: dark; }
    body { margin:0; padding:16px 20px 24px; background:#111316; color:#e8e8ea;
           font:13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
    h1 { font-size:15px; margin:0 0 12px; letter-spacing:.06em; color:#9fd8ff; font-weight:600; }
    .grid { display:grid; grid-template-columns:repeat(${cols}, ${cell}px); gap:8px; }
    figure { margin:0; }
    img { display:block; width:${cell}px; height:${cell}px; image-rendering:auto;
          border:1px solid #2a2f36; }
    figcaption { padding:4px 2px 0; font-size:11px; color:#c8ccd2;
                 display:flex; justify-content:space-between; gap:8px; }
    figcaption span { color:#7d8792; }
  </style>
  <h1>${title}</h1>
  <div class="grid">${cells}</div>`, { waitUntil: 'load' });

  await page.waitForTimeout(300);
  await mkdir(path.dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, fullPage: true });
  await context.close();
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runLifetime(browser, effect) {
  const { context, page, errors } = await boot(browser);
  await enterMatch(page);

  // Freeze everything before anything is ignited: from here on the only thing
  // that moves is the number written into clock.elapsed.
  const t0 = await freeze(page);
  // Printed on every run so "is this sheet comparable to the last one" is a
  // string match rather than a hope. Sim tick, the two robots and — the one
  // that actually drifted — the settled camera, to four decimals: a rig that is
  // a thousandth of a unit out moves the integer crop rectangle and lights up
  // every edge in a pixel diff.
  console.log('  pin: ' + await page.evaluate(() => {
    const g = window.__game;
    const c = g.camera.position;
    const f = (n) => n.toFixed(4);
    const r = g.world.robos;
    return `tick=${g.world.tick} cam=${f(c.x)},${f(c.y)},${f(c.z)} ` +
      `rot=${f(g.camera.rotation.x)},${f(g.camera.rotation.y)} ` +
      `p1=${r[0].pos.x.toFixed(2)},${r[0].pos.z.toFixed(2)} ` +
      `p2=${r[1].pos.x.toFixed(2)},${r[1].pos.z.toFixed(2)}`;
  }));
  // Wipe the firefight already in flight so the sheet shows this effect and not
  // a hundred stale tracers. The wide shot at the end keeps the staging read.
  // ...and reseed the jitter, so the lobes, the spark cone and the debris
  // spread are the same on every run. The firefight before the freeze has
  // already pulled an unknown number of values out of `vfxRng`, so seeding at
  // boot would not be enough — it has to happen here, right before the spawn.
  await page.evaluate((seed) => {
    const v = window.__game.view.vfx;
    v.clear();
    v.seedJitter(seed);
  }, VFX_SEED);
  await frames(page, 1);

  let centre = { x: VP.width / 2, y: VP.height / 2 };
  let world = null;

  if (effect === 'explosion') {
    world = await igniteExplosion(page);
  } else if (effect === 'ko') {
    world = await page.evaluate(() => {
      const g = window.__game;
      const r = g.world.robos[1];
      const p = { x: r.pos.x, y: r.pos.y + 0.9, z: r.pos.z };
      g.view.vfx._ko({ winner: 0 }, g.world);
      return p;
    });
  } else if (effect === 'impact') {
    // Both impact reads at once, because they are different code paths and the
    // ring only exists on one of them: an armour hit on the robo's chest (flash
    // card, no ring) and a deck hit a little in front of it (ring + scorch).
    // The crop is centred between the two so one tile judges both.
    world = await page.evaluate(() => {
      const g = window.__game;
      const r = g.world.robos[1];
      const p = { x: r.pos.x, y: r.pos.y + 1.2, z: r.pos.z };
      g.view.vfx._hit({ x: p.x, y: p.y, z: p.z, nx: 0, ny: 1, nz: 0, heavy: true, surface: false });
      g.view.vfx._hit({
        x: r.pos.x + 1.6, y: 0.02, z: r.pos.z + 1.0,
        nx: 0, ny: 1, nz: 0, heavy: true, surface: true,
      });
      return { x: r.pos.x + 0.8, y: r.pos.y + 0.6, z: r.pos.z + 0.5 };
    });
  } else if (effect === 'tracer') {
    // Fire one round from robo 0 straight at robo 1 and walk alongside it.
    world = await page.evaluate(() => {
      const g = window.__game;
      const w = g.world;
      const a = w.robos[0], b = w.robos[1];
      a.aimYaw = Math.atan2(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
      a.aimPitch = 0;
      a.gunCd = 0; a.burstLeft = 0;
      w.fireGun(a, w.loadouts[0], true);
      // world.step() clears the event buffer at the top, so a round fired from
      // outside a step has to be handed to the view now or the muzzle flash is
      // gone before anything renders.
      g.view.endStep();
      return { x: a.pos.x, y: a.pos.y + 1.2, z: a.pos.z };
    });
  }

  if (world) {
    const scr = await projectPoint(page, world);
    if (!scr.behind) centre = scr;
  }

  // `--ages 0,40,110` cuts the walk down to the tiles a given change actually
  // touches. Twelve tiles is ~4 minutes under software GL; three is under one,
  // and that difference is the difference between tuning a fireball and
  // guessing at it.
  const ages = AGES_ARG
    ? String(AGES_ARG).split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v))
    : (AGES[effect] || AGES.explosion);
  const tiles = [];
  let rect = cropRect(centre, ZOOM);   // camera is frozen: one crop for all
  let ticks = 0;

  for (const ms of ages) {
    // A live projectile only moves when the sim moves, so the tracer sheet
    // steps the world in lockstep with the clock — one tick per 1/60s of age —
    // and re-crops onto the round each tile. Everything else is pure effect age
    // against a dead-still world.
    if (LOCKSTEP[effect]) {
      const want = Math.round((ms / 1000) * 60);
      if (want > ticks) await page.evaluate((n) => window.__game.fastForward(n), want - ticks);
      ticks = want;
    }
    await scrubTo(page, t0 + ms / 1000);
    if (LOCKSTEP[effect]) {
      const live = await page.evaluate(() => {
        const p = window.__game.world.proj.find((q) => q.alive && q.kind === 0);
        return p ? { x: p.pos.x, y: p.pos.y, z: p.pos.z } : null;
      });
      if (live) {
        const scr = await projectPoint(page, live);
        if (!scr.behind) rect = cropRect(scr, ZOOM);
      }
    }

    const buf = await page.screenshot({ clip: rect, timeout: 180000 });
    const m = await analyze(page, buf);
    tiles.push({
      b64: buf.toString('base64'),
      label: `${ms}ms`,
      note: `max ${m.max} · >200 ${m.pctOver200}% · warm ${m.pctWarm}%`,
    });
    console.log(`  ${String(ms).padStart(5)}ms  ` +
      `max=${String(m.max).padStart(3)} mean=${String(m.mean).padStart(3)} ` +
      `>200=${String(m.pctOver200).padStart(6)}% >128=${String(m.pctOver128).padStart(6)}% warm=${m.pctWarm}%`);

    if (KEEP) {
      await mkdir('shots/frames', { recursive: true });
      await writeFile(`shots/frames/${effect}-${String(ms).padStart(4, '0')}ms.png`, buf);
    }
  }

  const stats = await page.evaluate(() => {
    const g = window.__game;
    return {
      drawCalls: g.engine.stats.drawCalls,
      tris: g.engine.stats.tris,
      tier: g.engine.quality.settings.name,
      fps: g.engine.stats.fps,
    };
  });

  // One wide frame at the effect's most violent moment, for staging context.
  // It is a full 1600x900 shot and costs as much as three tiles, so `--nowide`
  // drops it while iterating.
  if (!NOWIDE) {
    await mkdir('shots', { recursive: true });
    // Rewinding a lockstep effect would put the clock and the sim out of step,
    // so those keep the state the walk ended on.
    if (!LOCKSTEP[effect]) await scrubTo(page, t0 + (PEAK[effect] ?? 0.11));
    const wide = await page.screenshot({ timeout: 180000 });
    await writeFile(`shots/sheet-${effect}-wide.png`, wide);
  }

  await context.close();
  return { tiles, stats, errors };
}

/**
 * Luminance probe. The art director measured white DOM text at 255 on the title
 * screen and 111 in a match; this pins down which layer is eating it by planting
 * known-value probes and reading them back out of a real screenshot.
 */
async function runProbe(browser) {
  const { context, page, errors } = await boot(browser);

  const plant = () => page.evaluate(() => {
    let host = document.getElementById('__probe');
    if (!host) {
      host = document.createElement('div');
      host.id = '__probe';
      host.style.cssText =
        'position:fixed;left:0;top:0;z-index:2147483647;display:flex;pointer-events:none';
      for (const c of ['#ffffff', '#808080', '#000000']) {
        const d = document.createElement('div');
        d.style.cssText = `width:40px;height:40px;background:${c}`;
        host.appendChild(d);
      }
      // A second white swatch parked inside the HUD subtree, to separate "the
      // whole page is dim" from "the HUD's own container is dim".
      const hud = document.querySelector('.hud, #hud, [class*="hud"]');
      if (hud) {
        const d = document.createElement('div');
        d.id = '__probe2';
        d.style.cssText =
          'position:fixed;left:130px;top:0;width:40px;height:40px;background:#fff;z-index:2147483647;pointer-events:none';
        hud.appendChild(d);
      }
      document.body.appendChild(host);
    }
  });

  /** Read the planted swatches straight out of a real screenshot. */
  const swatches = async (buf) => page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const at = (x, y) => {
      const o = (y * bmp.width + x) * 4;
      return [d[o], d[o + 1], d[o + 2]];
    };
    const out = {
      'body #fff': at(20, 20),
      'body #808080': at(60, 20),
      'body #000': at(100, 20),
      'hud #fff': at(150, 20),
    };
    bmp.close();
    return out;
  }, buf.toString('base64'));

  const read = async (label) => {
    await plant();
    await frames(page, 2);
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 40 }, timeout: 180000 });
    const values = await swatches(buf);
    const px = await page.evaluate(() => {
      const info = [];
      const seen = new Set();
      const walk = (el) => {
        while (el && el !== document.documentElement) {
          if (!seen.has(el)) {
            seen.add(el);
            const cs = getComputedStyle(el);
            const notable = {};
            if (cs.opacity !== '1') notable.opacity = cs.opacity;
            if (cs.filter !== 'none') notable.filter = cs.filter;
            if (cs.backdropFilter && cs.backdropFilter !== 'none') notable.backdropFilter = cs.backdropFilter;
            if (cs.mixBlendMode !== 'normal') notable.mixBlendMode = cs.mixBlendMode;
            if (Object.keys(notable).length) {
              info.push({ el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${el.className}`, ...notable });
            }
          }
          el = el.parentElement;
        }
      };
      document.querySelectorAll('body *').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.opacity !== '1' || cs.filter !== 'none' ||
            (cs.backdropFilter && cs.backdropFilter !== 'none') || cs.mixBlendMode !== 'normal') {
          walk(el);
        }
      });
      // Full-viewport elements that could be sitting over everything.
      const overlays = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width >= window.innerWidth * 0.95 && r.height >= window.innerHeight * 0.95 &&
            cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.001) {
          overlays.push({
            el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).slice(0, 60)}`,
            bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 90),
            opacity: cs.opacity, z: cs.zIndex, blend: cs.mixBlendMode,
            filter: cs.filter, backdrop: cs.backdropFilter,
          });
        }
      }
      return { styles: info.slice(0, 20), overlays: overlays.slice(0, 20) };
    });
    return { label, buf, px, values };
  };

  const results = [];
  results.push(await read('title'));
  await enterMatch(page, 200);
  results.push(await read('match'));

  await mkdir('shots', { recursive: true });
  for (const r of results) {
    await writeFile(`shots/probe-${r.label}.png`, r.buf);
    console.log(`\n=== ${r.label} ===`);
    console.log(`swatch readback: ${JSON.stringify(r.values)}`);
    console.log('full-viewport elements:');
    for (const o of r.px.overlays) console.log(`  ${JSON.stringify(o)}`);
    console.log('elements with opacity/filter/blend:');
    for (const s of r.px.styles) console.log(`  ${JSON.stringify(s)}`);
  }

  await context.close();
  return { errors };
}

// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(PINNED) ? PINNED : undefined,
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio',
    ],
  });

  try {
    if (EFFECT === 'probe') {
      const { errors } = await runProbe(browser);
      if (errors.length) console.log(`\n⚠ ${errors.length} page error(s):\n  ${errors.slice(0, 6).join('\n  ')}`);
      return;
    }

    console.log(`contact sheet: ${EFFECT} @ tier ${TIER}, crop ${ZOOM}px`);
    const { tiles, stats, errors } = await runLifetime(browser, EFFECT);
    await composeSheet(browser, tiles, OUT,
      `${EFFECT.toUpperCase()} — one run, aged by rendered frames (1 frame = 16.7ms) — ${JSON.stringify(stats)}`);
    console.log(`\n✓ ${OUT}`);
    console.log(`  ${JSON.stringify(stats)}`);
    if (errors.length) console.log(`  ⚠ ${errors.length} page error(s):\n    ${errors.slice(0, 6).join('\n    ')}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
