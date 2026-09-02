#!/usr/bin/env node
/**
 * Why the phone capture never reaches FIGHT: a tick-rate probe.
 *
 * `_r15-phone.mjs` gave up after 38s with phase=0 tick=83. That is not a UI
 * fault; it is the sim never getting to `PHASE.FIGHT` (150 ticks of
 * `T.roundIntro`) inside the script's ceiling. This measures the actual rate.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:4300/custom_robot/';
const VW = Number(process.argv[3] || 390), VH = Number(process.argv[4] || 844);
const DSF = Number(process.argv[5] || 3);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const ctx = await browser.newContext({
  viewport: { width: VW, height: VH }, deviceScaleFactor: DSF,
  isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  PAGEERROR ' + String(e && e.stack || e).split('\n')[0]));
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 60000 });
await page.waitForTimeout(1500);

console.log(`probe ${VW}x${VH}@${DSF}`);
console.log('  quality: ' + await page.evaluate(() => {
  const q = window.__game.engine.quality;
  return JSON.stringify({ tier: q.tier, dpr: q.pixelRatio, scale: q.effectiveScale,
    device: q.device, settings: q.settings });
}));
console.log('  backing store: ' + await page.evaluate(() => {
  const c = window.__game.engine.renderer.domElement;
  return `${c.width}x${c.height} css ${c.clientWidth}x${c.clientHeight}`;
}));

// Drive straight into a match through the API (this probe is about frame rate,
// not about the touch path).
await page.evaluate(() => window.__game.startMatch({ mode: 'solo', arenaId: 'grid' }));
const t0 = Date.now();
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => ({
    tick: window.__game.world?.tick, phase: window.__game.world?.phase,
    fps: +window.__game.engine.stats.fps.toFixed(2),
    frameMs: +window.__game.engine.stats.frameMs.toFixed(1),
    tier: window.__game.engine.quality.tier,
    scale: window.__game.engine.quality.effectiveScale,
    w: window.__game.engine.renderer.domElement.width,
    h: window.__game.engine.renderer.domElement.height,
  }));
  console.log(`  +${String(Date.now() - t0).padStart(6)}ms tick=${String(s.tick).padStart(5)} phase=${s.phase}` +
    ` fps=${s.fps} frameMs=${s.frameMs} tier=${s.tier} scale=${s.scale} rt=${s.w}x${s.h}`);
  if (s.phase >= 1) { console.log('  reached FIGHT'); break; }
}
await browser.close();
