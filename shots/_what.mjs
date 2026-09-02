#!/usr/bin/env node
/**
 * WHAT IS THAT? — name every object still drawing in the pinned contour frame.
 *
 * `tools/contour.mjs` photographs a frame with VFX suppressed, and the foundry
 * capture from that frame has a large translucent RED slab lying across the
 * near machine — through the exact contour the meter is measuring. Nothing in
 * `src/gfx/stage.js` builds a red translucent slab and every VFX emitter is a
 * direct child of the scene, so the suppression pass should have removed it.
 * Rather than guess for another round, this reproduces contour.mjs's freeze +
 * settle + VFX-off verbatim and then walks the scene graph, reporting for every
 * still-visible mesh:
 *
 *   its name and ancestry, its material colour / opacity / blending, and the
 *   screen-space AABB of its world bounding box under the pinned camera.
 *
 * Sorted by screen area, so whatever is painting a third of the frame is line
 * one. Any object whose screen box covers the machine is a candidate.
 *
 *   node shots/_what.mjs --base http://127.0.0.1:4300/custom_robot/ --arena foundry
 */
import { chromium } from 'playwright';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); if (i < 0) return d; const v = args[i + 1]; return v && !v.startsWith('--') ? v : true; };
const BASE = flag('base', 'http://127.0.0.1:4300/custom_robot/');
const ARENA = flag('arena', 'foundry');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const SEED = Number(flag('seed', 1234567));
const TOP = Number(flag('top', 30));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* Verbatim from tools/contour.mjs — see its header for why each line is here. */
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
const VFX_OFF_FN = `() => {
  const v = window.__game.view;
  const keep = new Set([v.stage.group, ...v.models.map((m) => m.group), ...v.blobs]);
  for (const o of v.scene.children) {
    if (keep.has(o) || o.isLight || o.isCamera) continue;
    o.visible = false;
  }
  for (const k of ['motes', 'shafts', 'sweep']) if (v.stage[k]) v.stage[k].visible = false;
}`;

const WALK_FN = `(W, H) => {
  const g = window.__game;
  const cam = g.camera || g.rig.camera;
  cam.updateMatrixWorld(true);
  const v = g.view;
  v.scene.updateMatrixWorld(true);
  const out = [];
  const chain = (o) => { const a = []; for (let p = o; p && p !== v.scene; p = p.parent) a.push(p.name || p.type); return a.reverse().join('/'); };
  v.scene.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    // An invisible ancestor hides the whole subtree, so walk up.
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    const geo = o.geometry;
    if (!geo) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, anyFront = false;
    for (let i = 0; i < 8; i++) {
      const p = new (bb.min.constructor)(
        i & 1 ? bb.max.x : bb.min.x,
        i & 2 ? bb.max.y : bb.min.y,
        i & 4 ? bb.max.z : bb.min.z);
      p.applyMatrix4(o.matrixWorld).project(cam);
      if (p.z < 1) anyFront = true;
      const sx = (p.x * 0.5 + 0.5) * W, sy = (1 - (p.y * 0.5 + 0.5)) * H;
      if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
    }
    if (!anyFront) return;
    const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(W, x1), cy1 = Math.min(H, y1);
    const area = Math.max(0, cx1 - cx0) * Math.max(0, cy1 - cy0);
    if (area <= 0) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const m = mats[0] || {};
    out.push({
      path: chain(o), kind: o.isPoints ? 'Points' : o.isLine ? 'Line' : 'Mesh',
      area: Math.round(area), box: [Math.round(cx0), Math.round(cy0), Math.round(cx1), Math.round(cy1)],
      mat: m.type || '?',
      color: m.color ? '#' + m.color.getHexString() : '-',
      emissive: m.emissive ? '#' + m.emissive.getHexString() : '-',
      opacity: m.opacity != null ? Math.round(m.opacity * 1000) / 1000 : 1,
      transparent: !!m.transparent, blending: m.blending, vcol: !!m.vertexColors,
      tris: geo.index ? geo.index.count / 3 : (geo.attributes.position ? geo.attributes.position.count / 3 : 0),
    });
  });
  out.sort((a, b) => b.area - a.area);
  return out;
}`;

(async () => {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })).newPage();
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
  await page.evaluate((n) => window.__game.fastForward(n), TICKS);
  await page.evaluate(`(${SETTLE_FN})(240)`);
  await page.evaluate(`(${VFX_OFF_FN})()`);
  const rows = await page.evaluate(`(${WALK_FN})(1600, 900)`);
  const BL = { 0: 'none', 1: 'normal', 2: 'additive', 3: 'subtractive', 4: 'multiply' };
  console.log(`\nSTILL DRAWING — ${ARENA}, after contour.mjs's VFX suppression (${rows.length} objects)\n`);
  for (const r of rows.slice(0, TOP)) {
    console.log(
      `${String(r.area).padStart(8)}px  [${r.box.join(',')}]  ${r.kind} ${r.mat}` +
      `  col ${r.color} emis ${r.emissive} op ${r.opacity}${r.transparent ? ' T' : ''}` +
      ` ${BL[r.blending] || r.blending}${r.vcol ? ' vcol' : ''}  tris ${r.tris}\n            ${r.path}`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
