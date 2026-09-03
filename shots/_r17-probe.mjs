#!/usr/bin/env node
/**
 * Why is the frozen phone frame black? A differential probe, not a capture.
 *
 * The first R17PHONE run came back with an empty scene: both machines project
 * on-screen and centred, and nothing is drawn but the arena's rim ring. The
 * same freeze recipe (pause, pin the clock, fastForward, settle) is what
 * tools/contour.mjs runs at 1600x900 and it works there, so the difference is
 * one of: the mobile context, the route through the touch UI, the tier, or the
 * viewport. This asks the page directly instead of guessing from PNGs.
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const BASE = flag('base', 'http://127.0.0.1:4317/custom_robot/');
const VW = Number(flag('vw', 390)), VH = Number(flag('vh', 844)), DPR = Number(flag('dpr', 3));
const TIER = Number(flag('tier', 2));
const TICKS = Number(flag('ticks', 420));
const MOBILE = flag('mobile', '1') !== '0';
const ROUTE = flag('route', 'direct');     // direct | touch
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const DUMP = () => {
  const g = window.__game;
  const v = g.view, cam = g.camera;
  const count = { mesh: 0, visibleMesh: 0, light: 0, other: 0 };
  v.scene.traverse((o) => {
    if (o.isMesh) { count.mesh++; if (o.visible) count.visibleMesh++; }
    else if (o.isLight) count.light++;
    else count.other++;
  });
  const models = v.models.map((m) => {
    let meshes = 0, vis = 0;
    m.group.traverse((o) => { if (o.isMesh) { meshes++; if (o.visible) vis++; } });
    return { visible: m.group.visible, meshes, vis,
      pos: [+m.group.position.x.toFixed(2), +m.group.position.y.toFixed(2), +m.group.position.z.toFixed(2)],
      scale: +m.group.scale.x.toFixed(3) };
  });
  return {
    arenaId: g.arenaId, state: g.state, tick: g.world.tick, phase: g.world.phase,
    tier: g.engine.quality.settings.name, pr: g.engine.quality.pixelRatio,
    backing: [g.engine.renderer.domElement.width, g.engine.renderer.domElement.height],
    cam: { p: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
      fov: +cam.fov.toFixed(1), aspect: +cam.aspect.toFixed(3), near: cam.near, far: cam.far },
    rig: { dist: +g.rig.distance.toFixed(2), height: +g.rig.height.toFixed(2),
      bias: +g.rig.anchorBias.toFixed(2), boost: +g.rig.fitBoost.toFixed(2), mode: g.rig.mode },
    scene: count, models,
    stageChildren: v.stage && v.stage.group ? v.stage.group.children.length : -1,
    stageVisible: v.stage && v.stage.group ? v.stage.group.visible : null,
    lights: [], drawCalls: g.engine.renderer.info.render.calls,
    tris: g.engine.renderer.info.render.triangles,
    robos: g.world.robos.map((r) => [+r.pos.x.toFixed(2), +r.pos.y.toFixed(2), +r.pos.z.toFixed(2)]),
  };
};

const browser = await chromium.launch({
  executablePath: PINNED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage', '--mute-audio'],
});
const ctx = await browser.newContext(MOBILE
  ? { viewport: { width: VW, height: VH }, deviceScaleFactor: DPR, isMobile: true, hasTouch: true }
  : { viewport: { width: VW, height: VH }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  PAGEERROR ' + String(e && e.stack || e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.log('  CONSOLE ' + m.text().slice(0, 160)); });
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
await page.waitForTimeout(800);
await page.evaluate((t) => { const q = window.__game.engine.quality; q.auto = false; q.setTier(t); }, TIER);
await page.waitForTimeout(300);

console.log(`\nPROBE ${VW}x${VH}@${DPR} mobile=${MOBILE} tier=${TIER} route=${ROUTE}`);
await page.evaluate(({ ticks }) => {
  const g = window.__game;
  g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'grid', loadouts: g.loadouts, seed: 1234567 });
  g.setDemo(true);
  g.engine.paused = true;
  if (g.engine.clock) g.engine.clock.elapsed = 1000;
  g.fastForward(ticks);
}, { ticks: TICKS });
await page.waitForTimeout(1200);
console.log('  after fastForward:', JSON.stringify(await page.evaluate(DUMP), null, 1));

const SETTLE = `(n) => {
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
await page.evaluate(`(${SETTLE})(240)`);
await page.waitForTimeout(600);
console.log('  after settle:', JSON.stringify(await page.evaluate(DUMP), null, 1));
await page.screenshot({ path: `shots/_r17/probe-${VW}x${VH}-t${TIER}-${MOBILE ? 'm' : 'd'}.png`, timeout: 180000 });
console.log(`  wrote shots/_r17/probe-${VW}x${VH}-t${TIER}-${MOBILE ? 'm' : 'd'}.png`);
await browser.close();
