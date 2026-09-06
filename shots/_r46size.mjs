#!/usr/bin/env node
/**
 * ROUND 44 CRITIC — what the size gate actually reads, at six draws, on the
 * meter's own settle, and PER FRAGMENT rather than per machine.
 *
 *   node shots/_r46size.mjs --base http://127.0.0.1:4405/custom_robot/ \
 *        --arena foundry --draws 6
 *
 * WHY THIS FILE EXISTS. The round-43 census read `vSizeX` as `lodPx /
 * targetHeight` out of `shots/_r44probe.mjs`, one draw per arena, and concluded
 * that grid's and foundry's near machines are 0.373 and 0.369 — indistinguishable
 * to the gate. Two things are wrong with the evidence and neither is wrong with
 * the conclusion, which is why this file measures both halves.
 *
 *   1. `_r44probe.mjs` reads `m.lodPx` straight after a settle that contains no
 *      LOD resolve, so the value it prints is the one the LAST RENDERED FRAME
 *      left behind — the pre-settle, load-dependent camera. RULING 57 measured
 *      that quantity at a spread of 6.4 px (foundry) and 11.3 px (grid) over
 *      four draws. The census's own separation is 0.004 x 900 = 3.6 px. And the
 *      probe is under INSTRUMENT FAULT 45's standing bar on being quoted at all.
 *      So: resolve the LOD the way `tools/contour.mjs` now does — matrices
 *      forced current, camera inverted by hand — and take six draws.
 *
 *   2. `lodPx` is computed from ONE point, the model group's origin
 *      (`robot.js:_applyLod`). The shader's `vSizeX` is computed from
 *      `depthX`, the per-vertex view-space depth, so it is not one number per
 *      machine at all: it sweeps across the machine's own depth extent. A gate
 *      whose two edges are 0.004 apart is being asked to separate two machines
 *      whose own fragments may span many times that. This file therefore
 *      reports the DISTRIBUTION over the shell's vertices as well as the value
 *      at the origin.
 *
 * The per-vertex figure is a MODEL, not a render: vertices are read in bind
 * pose, so skinning is not applied, and it is quoted as an estimate of the
 * spread and never as a cell. The render that decides the question is a
 * `tools/contour.mjs --u rimSizeLo=..,rimSizeHi=..` A/B, which is a render.
 *
 * The settle is read out of `tools/contour.mjs` at run time via
 * `_settlesrc.mjs`, so this probe cannot drift from the meter the way fault 45's
 * did.
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { settleFn } from './_settlesrc.mjs';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const BASE = flag('base', 'http://127.0.0.1:4405/custom_robot/');
const ARENA = flag('arena', 'grid');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const SEED = Number(flag('seed', 1234567));
const DRAWS = Number(flag('draws', 6));
const PINNED = '/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';

async function bundleHash(base) {
  const html = await (await fetch(base)).text();
  const h = createHash('sha256').update(html);
  for (const s of [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])) {
    h.update(new Uint8Array(await (await fetch(new URL(s, base).href)).arrayBuffer()));
  }
  return h.digest('hex').slice(0, 12);
}

const SETTLE = settleFn('contour.mjs');

const READ_FN = `() => {
  const g = window.__game;
  const cam = g.engine.activeCamera || g.engine.camera;
  // The corrected resolve, the same three lines tools/contour.mjs runs. Without
  // them every matrix below is the last pre-settle frame's.
  g.view.scene.updateMatrixWorld(true);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  const P11 = cam.projectionMatrix.elements[5];
  const r = g.engine.renderer;
  const rt = r.getRenderTarget();
  const H = rt ? rt.height : r.domElement.height;
  const mi = cam.matrixWorldInverse.elements;
  // View-space z of a world point, without allocating a Vector3 per vertex.
  const viewZ = (x, y, z) => mi[2] * x + mi[6] * y + mi[10] * z + mi[14];
  const out = [];
  for (const m of g.view.models) {
    // uBodyH is read off the live material, not assumed: the gate and the LOD
    // are only the same question while they share this number.
    let bodyH = null;
    const mats = [];
    for (const mesh of (m.meshes || [])) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of list) if (mat && mat.userData && mat.userData.u && mat.userData.u.uBodyH) {
        if (!mats.includes(mat)) mats.push(mat);
      }
    }
    if (mats.length) bodyH = mats[0].userData.u.uBodyH.value;
    const gp = m.group.matrixWorld.elements;
    const dOrigin = Math.max(1e-3, -viewZ(gp[12], gp[13], gp[14]));
    const sizeOrigin = bodyH === null ? null : bodyH * P11 / dOrigin * 0.5;
    // Per-vertex sweep over exactly the meshes the gate is compiled into.
    const vals = [];
    for (const mesh of (m.meshes || [])) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const gated = list.some((mat) => mat && mat.userData && mat.userData.u && mat.userData.u.uRimSizeLo);
      if (!gated) continue;
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) continue;
      const e = mesh.matrixWorld.elements;
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const d = Math.max(1e-3, -viewZ(wx, wy, wz));
        vals.push(bodyH * P11 / d * 0.5);
      }
    }
    vals.sort((a, b) => a - b);
    const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : null);
    out.push({
      bodyH, P11, H, lodPx: m.lodPx, dOrigin, sizeOrigin,
      n: vals.length, min: q(0), p05: q(0.05), p50: q(0.5), p95: q(0.95), max: vals[vals.length - 1],
      camPos: [cam.position.x, cam.position.y, cam.position.z],
      all: vals,
    });
  }
  return out;
}`;

const r5 = (v) => (v === null || v === undefined ? '   -   ' : v.toFixed(5));
const r3 = (v) => (v === null || v === undefined ? '  -  ' : v.toFixed(3));

console.log(`  bundle: ${await bundleHash(BASE)}   base: ${BASE}`);
console.log(`  arena: ${ARENA}  tier ${TIER}  ticks ${TICKS}  seed ${SEED}  draws ${DRAWS}`);
console.log('');
console.log('  draw  machine   lodPx     vSizeX@origin   per-fragment  min      p05      p50      p95      max');
console.log('  ----------------------------------------------------------------------------------------------');

const rows = [[], []];
for (let d = 0; d < DRAWS; d++) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(PINNED) ? PINNED : undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
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
  const ok = await page.evaluate(`(${SETTLE})(240)`);
  if (!ok) throw new Error('camera rig unavailable');
  const res = await page.evaluate(`(${READ_FN})()`);
  res.forEach((m, i) => {
    rows[i] = rows[i] || [];
    rows[i].push(m);
    console.log(
      `   ${d + 1}    ${i === 0 ? 'NEAR' : 'FAR '}     ${r3(m.lodPx)}   ${r5(m.sizeOrigin)}` +
      `                     ${r5(m.min)}  ${r5(m.p05)}  ${r5(m.p50)}  ${r5(m.p95)}  ${r5(m.max)}`
    );
  });
  await browser.close();
}

console.log('');
const DUMP = flag('dump', null);
if (DUMP && typeof DUMP === 'string') {
  writeFileSync(DUMP, JSON.stringify({
    base: BASE, arena: ARENA,
    near: rows[0] ? rows[0][0].all : [],
    far: rows[1] ? rows[1][0].all : [],
  }));
  console.log(`  wrote per-fragment vSizeX samples to ${DUMP}`);
}
const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
rows.forEach((set, i) => {
  if (!set.length) return;
  const o = set.map((m) => m.sizeOrigin);
  const l = set.map((m) => m.lodPx);
  console.log(
    `  ${i === 0 ? 'NEAR' : 'FAR '}  vSizeX@origin ${r5(Math.min(...o))} .. ${r5(Math.max(...o))}` +
    `  spread ${spread(o).toExponential(2)}   lodPx spread ${spread(l).toFixed(4)} px` +
    `   per-fragment p05..p95 ${r5(set[0].p05)}..${r5(set[0].p95)}` +
    `   (bodyH ${r3(set[0].bodyH)}, H ${set[0].H})`
  );
});
