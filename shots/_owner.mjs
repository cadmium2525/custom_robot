#!/usr/bin/env node
/**
 * WHO OWNS THE TOP OF THE VALUE RANGE — by object, not by tile.
 *
 * `shots/_r16chroma.mjs` says foundry's stage owns 82.3% of the frame's
 * brightest 1% against grid's 34.3% and orbital's 4.0%, and `shots/_spread.mjs`
 * says the local background behind foundry's near machine reaches 146 where
 * grid's reaches 71. Those are the same pixels seen twice, and neither tool can
 * say WHICH PIECE OF THE ARENA they belong to — which is why four rounds of
 * "the foundry is too bright / too dark" have been argued on a whole-frame
 * histogram and moved nothing.
 *
 * Attribution by removal, which needs no colour keying and no ID pass that the
 * grade could distort: photograph the pinned frame, then hide ONE stage mesh
 * and photograph it again. Every pixel that moved is a pixel that object was
 * responsible for — including, for free, the bloom it sheds and the shadow it
 * casts, because those move too.
 *
 * Reported per object:
 *   footprint  % of frame whose luminance moves by more than --thr (default 4)
 *   dLum       mean and max drop over that footprint
 *   TOP1%      share of the frame's brightest 1% of pixels that this object
 *              owns (moves when it is hidden) — the number the review argues
 *              about, finally attached to a mesh
 *   behind     share of the machines' contour BACKGROUND ring it supplies:
 *              the pixels within 14px of the stencil that this object owns
 *
 * The last column is the one that decides a silhouette. A surface can own the
 * top of the histogram and be nowhere near the fight (orbital's planet) or own
 * very little and sit directly behind the machine (a block's lit cap).
 *
 *   node shots/_owner.mjs --base http://127.0.0.1:4300/custom_robot/ --arena foundry
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); if (i < 0) return d; const v = args[i + 1]; return v && !v.startsWith('--') ? v : true; };
const BASE = flag('base', 'http://127.0.0.1:4300/custom_robot/');
const ARENA = flag('arena', 'foundry');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const SEED = Number(flag('seed', 1234567));
const THR = Number(flag('thr', 4));
const KEEP = !!flag('keep');
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* contour.mjs's freeze, settle and suppression, verbatim. */
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
/**
 * INSTRUMENT FAULT — found and fixed in round 18, and it invalidated every
 * TOP1% figure this tool has ever printed for orbital.
 *
 * `shots/_salience.mjs` (the authority meter), `shots/_r15dump.mjs` and every
 * meter fed by that dump zero the robots' transient shell uniforms —
 * `uHitFlash`, `uCharge`, `uRimWash`, `uDissolve` — before they photograph.
 * This tool did not. At the pinned orbital frame robot 1 is carrying
 * `uHitFlash = 0.42`, so this tool was photographing a machine mid-hit-flash
 * and the others were not: the brightest 1% of the frame started at luminance
 * **205.5 here and 176.6 there**, on the same build, same seed, same tick.
 *
 * That is not a rounding difference. The attribution table's TOP1% column was
 * being read straight across against clause E and clause H numbers taken on a
 * different photograph — exactly the tool-crossing RULING 5 banned — and it is
 * why this table appeared to say that nothing in orbital's stage owns the top
 * of the value range while the authority meter said the stage owns 80% of it.
 *
 * Suppression is now identical to `_salience.mjs`'s, character for character,
 * and the suppressed transients are printed so the two runs can be checked
 * against each other by eye.
 */
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
      if (u[k] && u[k].value > 0.001) { was.push('robot ' + (i + 1) + ' ' + k + '=' + u[k].value.toFixed(2)); u[k].value = 0; }
    }
  }
  return was;
}`;
const STENCIL_FN = `(on) => {
  const v = window.__game.view;
  if (on) {
    const MB = v.blobs[0].material.constructor;
    const white = new MB({ color: 0xffffff, fog: false, toneMapped: false });
    const black = new MB({ color: 0x000000, fog: false, toneMapped: false });
    v.__hidden = [];
    for (const b of v.blobs) if (b.visible) { v.__hidden.push(b); b.visible = false; }
    for (const m of v.models) if (m.shadow && m.shadow.visible) { v.__hidden.push(m.shadow); m.shadow.visible = false; }
    const shells = new Set();
    for (const m of v.models) m.group.traverse((o) => { if (o.isMesh) shells.add(o); });
    v.__swap = [];
    v.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
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

/**
 * The stage's own meshes, in build order.
 *
 * INSTRUMENT FAULT — found and fixed in round 18. This used to read
 * `if ((o.isMesh || o.isPoints) && o.name && o.visible)`, so **every unnamed
 * mesh in the stage group was silently absent from the table**, and the table
 * was still printed as if it accounted for the frame. In orbital the only
 * unnamed mesh was the SKY SPHERE, and the sky owns the brightest 1% of that
 * arena: the tool reported nine objects summing to 2.8% of the top 1% while the
 * machines held 19.5%, and the missing 78% had no row because it had no name.
 * Four rounds of "orbital's highlights" were argued on that table.
 *
 * Unnamed meshes now get a synthetic `#<n>` handle and are toggled by object
 * identity, so a batch can never leave the attribution table by forgetting to
 * introduce itself. The count of them is printed.
 */
const LIST_FN = `() => {
  const s = window.__game.view.stage;
  const out = [];
  let anon = 0;
  s.group.traverse((o) => {
    if (!(o.isMesh || o.isPoints) || !o.visible) return;
    if (!o.__ownId) o.__ownId = o.name || ('#' + (++anon));
    out.push(o.__ownId);
  });
  return out;
}`;
const SET_FN = `(spec) => {
  const s = window.__game.view.stage;
  s.group.traverse((o) => { if (o.__ownId === spec.name) o.visible = spec.on; });
}`;

/* The per-object diff, run with the base arrays already in the page. */
const OWN_FN = async ({ bUri, THR }) => {
  const load = async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, c.width, c.height).data;
  };
  const d = await load(bUri);
  const { La, mask, ring, top1, W, H } = window.__base;
  const NP = W * H;
  const lum = (dd, i) => 0.2126 * dd[i] + 0.7152 * dd[i + 1] + 0.0722 * dd[i + 2];
  let foot = 0, sum = 0, max = 0, top = 0, rr = 0, lit = 0;
  for (let p = 0, i = 0; p < NP; p++, i += 4) {
    const dl = La[p] - lum(d, i);
    if (Math.abs(dl) < THR) continue;
    foot++; sum += dl; if (dl > max) max = dl;
    if (La[p] >= top1) top++;
    if (ring[p]) rr++;
    if (!mask[p] && La[p] >= 90) lit++;
  }
  return { foot, mean: foot ? Math.round(sum / foot * 10) / 10 : 0, max: Math.round(max * 10) / 10, top, ring: rr, lit };
};

const BASE_FN = async ({ aUri, mUri }) => {
  const load = async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const A = await load(aUri), M = await load(mUri);
  const W = A.W, H = A.H, NP = W * H;
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const La = new Float32Array(NP), mask = new Uint8Array(NP);
  for (let p = 0, i = 0; p < NP; p++, i += 4) { La[p] = lum(A.d, i); if (lum(M.d, i) > 128) mask[p] = 1; }
  const sorted = Float32Array.from(La).sort();
  const top1 = sorted[Math.floor(NP * 0.99)];
  const RING = 14;
  const ring = new Uint8Array(NP);
  for (let y = RING; y < H - RING; y++) {
    for (let x = RING; x < W - RING; x++) {
      const p = y * W + x;
      if (mask[p]) continue;
      let near = false;
      for (let dy = -RING; dy <= RING && !near; dy += 7) {
        for (let dx = -RING; dx <= RING; dx += 7) { if (mask[p + dy * W + dx]) { near = true; break; } }
      }
      if (near) ring[p] = 1;
    }
  }
  let nTop = 0, nTopM = 0, nRing = 0, nLit = 0;
  for (let p = 0; p < NP; p++) {
    if (La[p] >= top1) { nTop++; if (mask[p]) nTopM++; }
    if (ring[p]) nRing++;
    if (!mask[p] && La[p] >= 90) nLit++;
  }
  window.__base = { La, mask, ring, top1, W, H };
  return { W, H, NP, top1: Math.round(top1 * 10) / 10, nTop, nTopM, nRing, nLit };
};

(async () => {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  /* Round 14's standing rule: every capture names the bundle it measured. */
  const bundle = await page.evaluate(() => [...document.querySelectorAll('script[src]')]
    .map((s) => s.src.split('/').pop()).filter((s) => /^index-/.test(s)).join(',') || '(inline)');
  console.log(`  bundle: ${bundle}   base: ${BASE}`);
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
  if (!await page.evaluate(`(${SETTLE_FN})(240)`)) throw new Error('rig unavailable');
  const transient = await page.evaluate(`(${VFX_OFF_FN})()`);
  if (transient && transient.length) console.log('  suppressed transients:', transient.join(', '));
  for (const id of ['ui-layer', 'hud-layer', 'splash']) {
    await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
  }
  await page.waitForTimeout(700);

  const A = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(true)`);
  await page.waitForTimeout(500);
  const M = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(false)`);
  await page.waitForTimeout(300);

  const names = [...new Set(await page.evaluate(`(${LIST_FN})()`))];

  const probe = await context.newPage();
  await probe.goto('about:blank');
  const uri = (b) => 'data:image/png;base64,' + b.toString('base64');
  const base = await probe.evaluate(BASE_FN, { aUri: uri(A), mUri: uri(M) });
  console.log(`\nWHO OWNS THE LIGHT — ${ARENA} @ tier ${TIER}, seed ${SEED}, ${base.W}x${base.H}`);
  console.log(`  brightest 1% starts at luminance ${base.top1}  (${base.nTop} px) — MACHINES own ${(100 * base.nTopM / Math.max(1, base.nTop)).toFixed(1)}% of it (clause E), so the stage rows below have ${(100 - 100 * base.nTopM / Math.max(1, base.nTop)).toFixed(1)}% to account for`);
  console.log(`  contour background ring: ${base.nRing} px;  lit non-machine pixels (>=90): ${base.nLit}`);
  console.log(`  objects: ${names.join(', ')}   (${names.filter((n) => n.startsWith('#')).length} unnamed)\n`);
  console.log('object            footprint    dLum mean/max     TOP1% owned    RING owned    LIT owned');

  const rows = [];
  for (const name of names) {
    await page.evaluate(`(${SET_FN})(${JSON.stringify({ name, on: false })})`);
    await page.waitForTimeout(400);
    const B = await page.screenshot({ timeout: 180000 });
    await page.evaluate(`(${SET_FN})(${JSON.stringify({ name, on: true })})`);
    const r = await probe.evaluate(OWN_FN, { bUri: uri(B), THR });
    rows.push({ name, ...r });
    const pct = (a, b) => `${(a / Math.max(1, b) * 100).toFixed(1)}%`;
    console.log(
      `${name.padEnd(16)} ${pct(r.foot, base.NP).padStart(7)}   ${String(r.mean).padStart(6)} / ${String(r.max).padStart(6)}` +
      `      ${pct(r.top, base.nTop).padStart(7)}      ${pct(r.ring, base.nRing).padStart(7)}     ${pct(r.lit, base.nLit).padStart(7)}`);
    if (KEEP) { mkdirSync('shots/_own', { recursive: true }); writeFileSync(`shots/_own/${ARENA}-no-${name}.png`, B); }
  }
  if (KEEP) { mkdirSync('shots/_own', { recursive: true }); writeFileSync(`shots/_own/${ARENA}-base.png`, A); }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
