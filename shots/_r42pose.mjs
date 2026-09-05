#!/usr/bin/env node
/**
 * INSTRUMENT FAULT 44'S DIAGNOSIS PROBE — read the machine's free-running
 * accumulators at the moment the shutter would fire.
 *
 * `tools/contour.mjs` returns two different stencils for one command (fault 44).
 * `src/gfx/robot.js:2680` records that this project already found and fixed one
 * accumulator of exactly this kind — the idle bob, converted to `time * k` so
 * the pose became a pure function of the pinned clock. Three more accumulators
 * in the same file were not converted:
 *
 *     robot.js:2761   this.spinAngle += this.spinRate * dt      rotary barrels
 *     robot.js:2790   to.rotation.y  += dt * (5 + heat * 26)    hover toes
 *     robot.js:2671   this.tumble    += dt * rate               tumble only
 *
 * This pins the frame exactly as contour.mjs pins it — same seed, tick, settle,
 * same clock pin — and prints those accumulators instead of a screenshot. If
 * they differ across identical runs, the pose is load-dependent by the
 * mechanism the file already documents, and no capture is needed to say so.
 *
 * Deliberately a NEW file: round 41's rule is that a capture script may not be
 * edited between the control and the treatment of a comparison in flight.
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const BASE = flag('base', 'http://127.0.0.1:4403/custom_robot/');
const ARENA = flag('arena', 'foundry');
const TICKS = Number(flag('ticks', 420));
const SEED = Number(flag('seed', 1234567));
const WAIT = Number(flag('wait', 1200));

const html = await (await fetch(BASE)).text();
const h = createHash('sha256').update(html);
for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
  h.update(new Uint8Array(await (await fetch(new URL(m[1], BASE).href)).arrayBuffer()));
}
console.log('  bundle: ' + h.digest('hex').slice(0, 12) + '   base: ' + BASE);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })).newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
await page.evaluate(() => { const q = window.__game.engine.quality; q.auto = false; q.setTier(3); });
await page.waitForTimeout(400);
await page.evaluate(({ id, seed }) => {
  const g = window.__game;
  g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
  g.setDemo(true);
  g.engine.paused = true;
  if (g.engine.clock) g.engine.clock.elapsed = 1000;
}, { id: ARENA, seed: SEED });
await page.waitForTimeout(WAIT);
const before = await page.evaluate(() => ({
  frame: window.__game.engine.clock.frame,
  elapsed: window.__game.engine.clock.elapsed,
  spin: window.__game.view.models.map((m) => Math.round((m.spinAngle || 0) * 1e4) / 1e4),
}));
await page.evaluate((n) => window.__game.fastForward(n), TICKS);
// contour.mjs's settle, verbatim in effect: 240 iterations of view.update.
await page.evaluate(`((n) => {
  const g = window.__game;
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
})(240)`);
const after = await page.evaluate(() => {
  const g = window.__game;
  const two = (v) => Math.round(v * 1e4) / 1e4;
  return {
    frame: g.engine.clock.frame,
    elapsed: g.engine.clock.elapsed,
    models: g.view.models.map((m) => ({
      spinAngle: two(m.spinAngle || 0),
      spinRate: two(m.spinRate || 0),
      breathe: two(m.breathe || 0),
      toeY: two((m.bToeR && m.bToeR.rotation.y) || 0),
      rootY: two(m.group.position.y),
    })),
  };
});
console.log('  before settle: frame=' + before.frame + ' elapsed=' + before.elapsed + ' spin=' + JSON.stringify(before.spin));
console.log('  after  settle: frame=' + after.frame + ' elapsed=' + after.elapsed);
for (let i = 0; i < after.models.length; i++) {
  console.log('    model ' + (i + 1) + '  ' + JSON.stringify(after.models[i]));
}
await browser.close();
