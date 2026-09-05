#!/usr/bin/env node
/** Fault 44 probe: run contour's exact pin + settle, then print per-model state. */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const A = process.argv.slice(2);
const flag = (n, d) => { const i = A.indexOf('--' + n); return i < 0 ? d : A[i + 1]; };
const BASE = flag('base', 'http://127.0.0.1:4403/custom_robot/');
const ARENA = flag('arena', 'foundry');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const SEED = Number(flag('seed', 1234567));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SETTLE_FN = `(n) => {
  const g = window.__game;
  if (!g.rig || !g.world || !g.view) return false;
  let t = (g.engine.clock && g.engine.clock.elapsed) || 0;
  // INSTRUMENT FAULT 44 — A SETTLE CONVERGES DAMPERS AND CANNOT CONVERGE
  // INTEGRATORS, AND FOUR OF THIS MODEL'S POSE TERMS ARE INTEGRATORS.
  //
  // The loop below exists because damp(a, b, lambda, dt) forgets its starting
  // value: run it 240 times and every damped term lands on the same pose
  // whatever the frames before it did. Four terms in RoboModel.update are not
  // damped, they are integrated — spinAngle += spinRate * dt, tumble += rate *
  // dt, getupT += dt, and the toe bones' rotation.y += dt * (5 + heat * 26).
  // An integrator keeps its initial value forever and the settle merely adds a
  // constant four seconds on top of it, so the pose stayed a function of how
  // many load-dependent frames rendered before the pin.
  //
  // Measured, one bundle, one command, seventeen draws: the grid stencil came
  // back 24457 px fourteen times and 24209 three times, and the far contour cell
  // read 80.0 against 69.7 between the two poses — 10.3 points on the cell
  // clause B is failing by 4.0. It also produced both of the boxes that fault 38
  // blamed on two meters disagreeing; it was one meter disagreeing with itself.
  //
  // Zeroed so the settle starts from a known state and the pose becomes a
  // function of the iteration count alone. This is the meter reaching into the
  // model, which is justified precisely because these four values are the only
  // ones running the loop longer cannot fix. FIXED IN ALL THREE COPIES AT ONCE —
  // contour.mjs, mass.mjs and _r15dump.mjs are the meters behind clauses A, B, C
  // and D, and a pose fix in one of them is fault 38 all over again.
  for (const m of g.view.models) {
    m.spinAngle = 0; m.tumble = 0; m.getupT = 0;
    if (m.bToeR) m.bToeR.rotation.y = 0;
    if (m.bToeL) m.bToeL.rotation.y = 0;
  }
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


const browser = await chromium.launch({ headless: true, executablePath: existsSync(PINNED) ? PINNED : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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
await page.evaluate(`(${SETTLE_FN})(240)`);
// Contour waits 700+700ms and takes a multi-second software-GL screenshot
// between the settle and the shutter. Read the state where the SHUTTER is.
if (process.argv.includes('--late')) await page.waitForTimeout(1400);
const out = await page.evaluate(() => {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const g = window.__game;
  return g.view.models.map((m) => {
    const dr = [];
    if (m.lod) for (const e of m.lod) dr.push(e.geo.drawRange.count);
    return {
      pos: [r3(m.group.position.x), r3(m.group.position.y), r3(m.group.position.z)],
      rot: r3(m.group.rotation.y),
      lean: r3(m.lean), bank: r3(m.bank), heat: r3(m.heat), charge: r3(m.chargeAmt),
      pod: r3(m.podOpen || 0), recoil: r3(m.recoil), recoilB: r3(m.recoilB),
      spin: r3(m.spinAngle), tumble: r3(m.tumble), getup: r3(m.getupT),
      land: r3(m.land || 0), lodPx: r3(m.lodPx), draw: dr,
      wpos: [r3(g.world.robos[g.view.models.indexOf(m)].pos.x), r3(g.world.robos[g.view.models.indexOf(m)].pos.z)],
    };
  });
});
console.log(JSON.stringify(out));
await browser.close();
