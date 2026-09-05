#!/usr/bin/env node
/**
 * ROUND 43 CRITIC — audit of the LOD clamp `5a30c18` put in all three meters.
 *
 * The clamp resolves `_applyLod` once against the settled camera and then
 * replaces the method with a no-op, so the plate budget is pinned for the rest
 * of the capture while the shipped game's would keep updating every frame. The
 * question a ruling needs answered is not whether that stops the stencil moving
 * — it demonstrably does — but WHICH MACHINE it photographs: the one the player
 * sees at the shutter, or a differently detailed one.
 *
 * So this measures three draw-range vectors on one pinned frame:
 *
 *   FROZEN     what the clamp chose, off the settled camera
 *   AT SHUTTER what the SHIPPED `_applyLod` would have chosen from the live
 *              camera at the moment the picture is actually taken
 *   FULL       every index, i.e. `lodMinPx2 = 0`, the control the LOD's own
 *              comment names as the one every claim about it must be run against
 *
 * The clamp overwrites `_applyLod` with an OWN property, so the real method is
 * still on the prototype and can be called for the two comparisons without
 * unfreezing anything. Ranges are restored after each, and no picture is taken
 * from a mutated state.
 *
 * The settle is NOT copied — it is read out of `tools/contour.mjs` at run time
 * (see `_settlesrc.mjs` and instrument fault 45). A probe auditing a meter must
 * not be a second meter.
 *
 *   node shots/_r45lodprobe.mjs --base http://127.0.0.1:4403/custom_robot/ --arena foundry
 */
import { chromium } from 'playwright';
import process from 'node:process';
import { settleFn } from './_settlesrc.mjs';

const A = process.argv.slice(2);
const flag = (n, d) => { const i = A.indexOf('--' + n); return i < 0 ? d : A[i + 1]; };
const BASE = flag('base', 'http://127.0.0.1:4403/custom_robot/');
const ARENA = flag('arena', 'foundry');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const SEED = Number(flag('seed', 1234567));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SETTLE = settleFn('contour.mjs');

/**
 * Read the three vectors. Runs in the page, after the settle has frozen things.
 *
 * `proto._applyLod` is the unclamped method. Calling it mutates draw ranges, so
 * the frozen ranges are captured first and written back at the end — verified
 * by re-reading them, because a probe that silently leaves the frame in a third
 * state is worse than no probe.
 */
const MEASURE_FN = `() => {
  const g = window.__game;
  const cam = g.engine.activeCamera || g.engine.camera;
  const rnd = g.engine.renderer;
  const out = [];
  for (const m of g.view.models) {
    const proto = Object.getPrototypeOf(m);
    const real = proto._applyLod;
    const own = Object.prototype.hasOwnProperty.call(m, '_applyLod');
    const ranges = () => m.lod.map((e) => e.geo.drawRange.count);
    const frozen = ranges();
    const totals = m.lod.map((e) => e.table.total);
    const outline = m.lod.map((e) => !!e.outline);
    const fPx = m.lodPx, fB = m._lodBudget, fO = m._outBudget;

    // AT SHUTTER — the shipped behaviour, from the camera as it stands now.
    m._lodBudget = -1; m._outBudget = -1;
    real.call(m, rnd, cam);
    const live = ranges();
    const lPx = m.lodPx, lB = m._lodBudget, lO = m._outBudget;

    // FRESH — the same call after the matrices are FORCED up to date.
    //
    // _applyLod reads camera.matrixWorldInverse and group.matrixWorld, and both
    // are written by renderer.render(), not by rig.update(). The clamp calls
    // _applyLod outside a render, so "resolved against the settled camera" is a
    // claim about a matrix that may still be the last RENDERED frame's — which
    // is precisely the thing the clamp's own comment says it added the resolve
    // to avoid. If fresh differs from frozen, the resolve is reading a stale
    // matrix and the comment overstates what it does.
    g.view.scene.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    m._lodBudget = -1; m._outBudget = -1;
    real.call(m, rnd, cam);
    const fresh = ranges();
    const rPx = m.lodPx;

    // FULL — the control. lodMinPx2 = 0 leaves budget at Infinity in _applyLod.
    const keepL = m.lodMinPx2, keepO = m.outLodMinPx2;
    m.lodMinPx2 = 0; m.outLodMinPx2 = 0;
    m._lodBudget = -1; m._outBudget = -1;
    real.call(m, rnd, cam);
    const full = ranges();
    m.lodMinPx2 = keepL; m.outLodMinPx2 = keepO;

    // Put the frozen state back, exactly.
    for (let i = 0; i < m.lod.length; i++) m.lod[i].geo.setDrawRange(0, frozen[i]);
    m._lodBudget = fB; m._outBudget = fO; m.lodPx = fPx;
    const back = ranges();
    const ok = back.every((v, i) => v === frozen[i]);

    // Infinity does not survive JSON — it comes back as null, which reads as
    // "no budget" when it means "no cut at all". Printed as a string.
    const n = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : String(v));
    out.push({
      own, ok, minPx2: keepL, outMinPx2: keepO,
      px: { frozen: n(fPx), live: n(lPx), fresh: n(rPx) },
      budget: { frozen: n(fB), live: n(lB) }, outBudget: { frozen: n(fO), live: n(lO) },
      frozen, live, fresh, full, totals, outline,
      // Five decimals, matching the read taken right after the settle: the
      // whole question is whether these two are the same three numbers.
      camPos: [cam.position.x, cam.position.y, cam.position.z].map((v) => Math.round(v * 1e5) / 1e5),
      grpPos: [n(m.group.position.x), n(m.group.position.y), n(m.group.position.z)],
    });
  }
  return out;
}`;

const browser = await chromium.launch({
  executablePath: PINNED,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
await page.evaluate((t) => { const q = window.__game.engine.quality; q.auto = false; q.setTier(t); }, TIER);
await page.waitForTimeout(400);
await page.evaluate(({ id, seed }) => {
  const g = window.__game;
  g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
  g.setDemo(true); g.engine.paused = true;
  if (g.engine.clock) g.engine.clock.elapsed = 1000;
}, { id: ARENA, seed: SEED });
await page.waitForTimeout(1200);
await page.evaluate((n) => window.__game.fastForward(n), TICKS);
await page.evaluate(`(${SETTLE})(240)`);
// The camera AT THE SETTLE, before anything has had a chance to move it. The
// same three numbers are read again at the shutter; the difference is the drift
// the clamp exists to absorb, stated in metres instead of inferred from a
// stencil.
const camAtSettle = await page.evaluate(() => {
  const g = window.__game;
  const c = g.engine.activeCamera || g.engine.camera;
  const r3 = (v) => Math.round(v * 100000) / 100000;
  return [r3(c.position.x), r3(c.position.y), r3(c.position.z)];
});

// Burn the meter's own path to the shutter: hide the layers, wait 700, take the
// multi-second software-GL screenshot, wait 700. The camera drift this clamp
// exists to defeat happens during exactly these steps, so a probe that measures
// straight after the settle measures nothing.
for (const id of ['ui-layer', 'hud-layer', 'splash']) {
  await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
}
await page.waitForTimeout(700);
await page.screenshot({ timeout: 180000 });
await page.waitForTimeout(700);

// Called, not merely evaluated: `page.evaluate('(x) => {...}')` returns the
// FUNCTION and the probe would print `{}` — which it did once, and which is the
// exact shape of a probe that reports nothing and looks like it ran.
const out = await page.evaluate(`(${MEASURE_FN})()`);
console.log(JSON.stringify({ arena: ARENA, camAtSettle, models: out }));
await browser.close();
