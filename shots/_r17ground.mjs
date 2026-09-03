#!/usr/bin/env node
/**
 * CONTACT METER — round 17.
 *
 * WHY THIS EXISTS RATHER THAN `shots/_ground.mjs`.
 *
 * `_ground.mjs` decides whether a frame can carry a grounding measurement from
 * two facts: the sim's `grounded` flag, and the projected height of the model
 * group's bounding box. Both are wrong for the question.
 *
 *   1. `r.grounded` is a property of the SIM CAPSULE. The sim has no legs. A
 *      machine walking across the deck is `grounded` on every tick of the walk
 *      cycle, including the ticks where the renderer has both feet in the air
 *      mid-stride — RoboModel's walk cycle lifts the swing foot by up to ~0.2 m
 *      and the whole rig rides a `bob` term on top of that. "The sim says it is
 *      standing" is not "a foot is touching the floor", and the pool of
 *      occlusion a contact shadow makes is a fact about the second one.
 *
 *   2. The box `_ground.mjs` projects is taken from `o.geometry.boundingBox`
 *      transformed by `o.matrixWorld`. Every shell mesh on this model is a
 *      THREE.SkinnedMesh (`m.bind(this.skeleton, m.matrixWorld)` in robot.js),
 *      and a skinned mesh's vertices are moved by BONES, not by its own
 *      matrixWorld — which for these is the group transform and nothing else.
 *      So that box is the BIND POSE's box parked at the machine's position: it
 *      does not move when the legs do, which is precisely the motion being
 *      asked about.
 *
 * So this tool asserts the contact instead of assuming it. The sole height is
 * taken from `SkinnedMesh.getVertexPosition()` — real skinned vertices, in the
 * pose that will be photographed — restricted per foot by the dominant bone in
 * the skin weights. `gapL` / `gapR` are millimetres between the lowest vertex
 * carried by that foot and the deck under the machine. A frame has a CONTACT
 * when a foot is actually on the floor, and the tool refuses to measure one
 * that is not.
 *
 * TWO METERS, both named wherever a number from them is quoted.
 *
 *   POOL DEPTH (PD)      Deck luminance sampled in WORLD-SPACE rings around the
 *                        asserted contact point — each sample is a world point
 *                        on the deck, projected, so the ring is a correct
 *                        ellipse on screen at any camera pitch and the radii
 *                        are metres rather than "footprint widths". Machine
 *                        pixels are excluded via the same white-on-black
 *                        stencil contour.mjs uses. PD = median(far ring) -
 *                        median(nearest ring), in 0..255 luminance. A machine
 *                        standing on a floor sits in a pool; a decal is flat.
 *
 *   CONTACT DELTA (CD)   The same rings, measured as a PAIRED difference
 *                        between the frame as shipped and the same frame with
 *                        the contact cue knocked out. CD_blob is what the two
 *                        contact discs (GameView's multiply blob and
 *                        RoboModel's own shadow) are worth; CD_map is what the
 *                        shadow MAP adds on top; CD_all is both. PD says there
 *                        is a pool in the picture, CD says how much of it the
 *                        contact cue is actually paying for — and CD_map is
 *                        exactly the quantity TIER.LOW does not have.
 *
 * Deterministic per the house rule: pinned seed, engine paused, sim advanced by
 * fastForward, camera AND limbs settled on the same 1/60 clock inside the loop
 * (SETTLE_FN copied from tools/contour.mjs), onRender detached, adaptive
 * quality off.
 *
 * Usage:
 *   node shots/_r17ground.mjs --survey --arena grid            # find contacts
 *   node shots/_r17ground.mjs --arena grid --ticks 380 --tier 3
 *   node shots/_r17ground.mjs --arena grid --auto --tier 0     # survey, then
 *                                                              # measure the
 *                                                              # best contact
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4300/');
const TIER = Number(flag('tier', 3));
const ARENA = flag('arena', 'grid');
const SEED = Number(flag('seed', 1234567));
const TICKS = Number(flag('ticks', 380));
const SURVEY = !!flag('survey');
const AUTO = !!flag('auto');
const FROM = Number(flag('from', 300));
const TO = Number(flag('to', 900));
const STEP = Number(flag('step', 10));
const KEEP = !!flag('keep');
const TAG = flag('tag', '');
/** Millimetres of air under the lowest vertex of a foot that still counts as touching. */
const EPS_MM = Number(flag('eps', 45));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* ---------------------------------------------------------------- page code */

/** Identical to contour.mjs / mass.mjs. */
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

/** Copied verbatim from tools/contour.mjs — see the commentary there. */
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
  const was = [];
  for (let i = 0; i < v.models.length; i++) {
    const u = v.models[i].matShell && v.models[i].matShell.userData.u;
    if (!u) continue;
    for (const k of ['uHitFlash', 'uCharge', 'uRimWash', 'uDissolve']) {
      if (u[k] && u[k].value > 0.001) { was.push('robot ' + (i + 1) + ' ' + k); u[k].value = 0; }
    }
  }
  return was;
}`;

/**
 * THE CONTACT ASSERTION.
 *
 * Real skinned vertices in the pose about to be photographed, split per foot by
 * the dominant bone in the skin weights. Everything the camera needs to sample
 * a world-space ring on the deck comes back with it.
 */
const CONTACT_FN = `() => {
  const g = window.__game;
  const v = g.view;
  const cam = v.camera;
  const V3 = cam.position.constructor;
  const W = window.innerWidth, H = window.innerHeight;
  cam.updateMatrixWorld();
  const tmp = new V3();
  const toScreen = (x, y, z) => {
    tmp.set(x, y, z).project(cam);
    return { x: (tmp.x * 0.5 + 0.5) * W, y: (-tmp.y * 0.5 + 0.5) * H, z: tmp.z };
  };
  const out = [];
  for (let i = 0; i < v.models.length; i++) {
    const m = v.models[i];
    const r = g.world.robos[i];
    m.group.updateMatrixWorld(true);
    let minY = 1e9;
    const footMin = { L: 1e9, R: 1e9 };
    const footAt = { L: null, R: null };
    m.group.traverse((o) => {
      if (!o.isSkinnedMesh || !o.visible || !o.geometry) return;
      const pos = o.geometry.attributes.position;
      const si = o.geometry.attributes.skinIndex;
      const sw = o.geometry.attributes.skinWeight;
      const bones = o.skeleton && o.skeleton.bones;
      const p = new V3();
      for (let k = 0; k < pos.count; k++) {
        o.getVertexPosition(k, p);
        p.applyMatrix4(o.matrixWorld);
        if (p.y < minY) minY = p.y;
        if (!si || !sw || !bones) continue;
        let bi = si.getX(k), bw = sw.getX(k);
        if (sw.getY(k) > bw) { bw = sw.getY(k); bi = si.getY(k); }
        if (sw.getZ(k) > bw) { bw = sw.getZ(k); bi = si.getZ(k); }
        if (sw.getW(k) > bw) { bw = sw.getW(k); bi = si.getW(k); }
        const nm = bones[bi] && bones[bi].name;
        if (!nm) continue;
        const side = /L$/.test(nm) ? 'L' : (/R$/.test(nm) ? 'R' : null);
        if (!side) continue;
        if (!/^(foot|toe)/.test(nm)) continue;
        if (p.y < footMin[side]) { footMin[side] = p.y; footAt[side] = { x: p.x, y: p.y, z: p.z }; }
      }
    });
    const deckY = v._groundUnder(r.pos.x, r.pos.z);
    // NOTE: no backticks below. This comment sits inside the CONTACT_FN
    // template literal, and the two that used to wrap the function name here
    // ended that literal on this line — so this file did not parse AT ALL and
    // the grounding meter could not be run by anybody. It is the project's
    // signature failure, in the instrument for the project's oldest defect.
    // _groundUnder takes the top of any box whose footprint contains the
    // point WITH A 0.4 m MARGIN, so a machine standing on the deck beside a
    // pillar resolves to the pillar's cap. Recorded, because the renderer parks
    // the contact blob on exactly this number.
    const deckStrict = (() => {
      let best = 0;
      for (const b of g.world.arena.boxes) {
        if (b.top <= best) continue;
        const dx = r.pos.x - b.x, dz = r.pos.z - b.z;
        const lx = b.cos * dx - b.sin * dz, lz = b.sin * dx + b.cos * dz;
        if (Math.abs(lx) <= b.hx && Math.abs(lz) <= b.hz) best = b.top;
      }
      return best;
    })();
    const mm = (y) => (y > 1e8 ? null : Math.round((y - deckY) * 1000));
    const foot = toScreen(r.pos.x, deckY, r.pos.z);
    const head = toScreen(r.pos.x, deckY + 1.7, r.pos.z);
    // Pixels per metre ON THE DECK at the contact, measured along the world X
    // axis at the contact point. Used only for reporting; the ring sampler
    // works in world space and never needs it.
    const east = toScreen(r.pos.x + 1, deckY, r.pos.z);
    out.push({
      // WALKER or HOVER. A HOVER-V chassis never puts a foot on the deck — its
      // legs are turbine pods and RoboModel's walk cycle is switched off for
      // it — so "a foot within 45 mm" is not a test it can ever pass and a tool
      // that applies it anyway is measuring the part number, not the frame.
      legs: m.legStyle,
      hover: m.legStyle === 'hover',
      air: Math.round((r.pos.y - deckY) * 1000) / 1000,
      deckStrict,
      deckSnapped: Math.abs(deckStrict - deckY) > 0.01,
      grounded: !!r.grounded,
      state: r.state,
      stepPhase: Math.round((r.stepPhase || 0) * 100) / 100,
      moveAmt: Math.round(Math.hypot(r.vel.x, r.vel.z) * 100) / 100,
      gapMin: mm(minY),
      gapL: mm(footMin.L),
      gapR: mm(footMin.R),
      plantAt: (footMin.L <= footMin.R ? footAt.L : footAt.R),
      deckY,
      root: { x: r.pos.x, y: r.pos.y, z: r.pos.z },
      hPx: Math.round(Math.abs(foot.y - head.y)),
      mPx: Math.round(Math.hypot(east.x - foot.x, east.y - foot.y) * 10) / 10,
      footPx: { x: Math.round(foot.x), y: Math.round(foot.y) },
      below: Math.round(H - foot.y),
      blob: v.blobs[i] ? (v.blobs[i].visible ? Math.round(v.blobs[i].material.opacity * 1000) / 1000 : 0) : null,
      disc: m.shadow ? (m.shadow.visible ? Math.round(m.shadow.material.opacity * 1000) / 1000 : 0) : null,
    });
  }
  return { W, H, robots: out, shadowMap: !!(g.engine.renderer && g.engine.renderer.shadowMap.enabled) };
}`;

/**
 * World-space ring samples around the asserted contact, projected to screen.
 *
 * Returned as raw pixel coordinates so the SAME sample set can be read out of
 * every knock-out frame — which is what makes CD a paired difference rather
 * than a comparison of two independent medians.
 */
const RINGS_FN = `(rings, nAng) => {
  const g = window.__game;
  const v = g.view;
  const cam = v.camera;
  const V3 = cam.position.constructor;
  const W = window.innerWidth, H = window.innerHeight;
  cam.updateMatrixWorld();
  const tmp = new V3();
  const out = [];
  for (let i = 0; i < v.models.length; i++) {
    const r = g.world.robos[i];
    const deckY = v._groundUnder(r.pos.x, r.pos.z);
    const per = [];
    for (const rad of rings) {
      const pts = [];
      const n = rad === 0 ? 1 : nAng;
      for (let a = 0; a < n; a++) {
        const th = (a / n) * Math.PI * 2;
        const wx = r.pos.x + Math.cos(th) * rad;
        const wz = r.pos.z + Math.sin(th) * rad;
        // Sample the deck the machine is standing on, not whatever box is
        // under that offset: a ring that walked up onto a crate would report
        // the crate's albedo as the pool recovering.
        if (Math.abs(v._groundUnder(wx, wz) - deckY) > 0.05) continue;
        tmp.set(wx, deckY, wz).project(cam);
        const sx = Math.round((tmp.x * 0.5 + 0.5) * W);
        const sy = Math.round((-tmp.y * 0.5 + 0.5) * H);
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        pts.push(sx, sy);
      }
      per.push(pts);
    }
    out.push(per);
  }
  return out;
}`;

/** Hide / show the two contact discs. */
const CUE_FN = `(on) => {
  const v = window.__game.view;
  for (const b of v.blobs) b.visible = on ? (b.__wasVis !== false) : (b.__wasVis = b.visible, false);
  for (const m of v.models) {
    if (!m.shadow) continue;
    if (on) m.shadow.visible = m.shadow.__wasVis !== false;
    else { m.shadow.__wasVis = m.shadow.visible; m.shadow.visible = false; }
  }
  return true;
}`;

const MAP_FN = `(on) => {
  const g = window.__game;
  const rd = g.engine.renderer;
  if (!rd) return false;
  rd.shadowMap.enabled = !!on;
  g.view.scene.traverse((o) => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
  return true;
}`;

/* ------------------------------------------------------------ image readout */

const READ_FN = async ({ uris, samples }) => {
  const load = async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const imgs = {};
  for (const k of Object.keys(uris)) imgs[k] = await load(uris[k]);
  const stencil = await load(uris.__stencil);
  const W = stencil.W, H = stencil.H;
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  const keys = Object.keys(uris).filter((k) => k !== '__stencil');
  const out = [];
  for (let robot = 0; robot < samples.length; robot++) {
    const perRing = [];
    for (const pts of samples[robot]) {
      const vals = {};
      for (const k of keys) vals[k] = [];
      let kept = 0, masked = 0;
      for (let p = 0; p < pts.length; p += 2) {
        const x = pts[p], y = pts[p + 1];
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        if (lum(stencil.d, i) > 128) { masked++; continue; }   // machine pixel
        kept++;
        for (const k of keys) vals[k].push(lum(imgs[k].d, i));
      }
      const med = (a) => (a.length ? a.slice().sort((p, q) => p - q)[a.length >> 1] : null);
      const ring = { n: kept, masked };
      for (const k of keys) ring[k] = med(vals[k]);
      // Paired differences, per sample, then median — never median-of-medians.
      const pair = (a, b) => {
        const d = [];
        for (let i = 0; i < vals[a].length; i++) d.push(vals[b][i] - vals[a][i]);
        return med(d);
      };
      if (keys.includes('none') && keys.includes('nocue')) ring.dBlob = pair('none', 'nocue');
      if (keys.includes('nocue') && keys.includes('nothing')) ring.dMap = pair('nocue', 'nothing');
      if (keys.includes('none') && keys.includes('nothing')) ring.dAll = pair('none', 'nothing');
      perRing.push(ring);
    }
    out.push(perRing);
  }
  return out;
};

/* ----------------------------------------------------------------- reporting */

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const pad = (x, n) => String(x == null ? '-' : x).padStart(n);

/* ---------------------------------------------------------------------- run */

const RINGS = [0.0, 0.35, 0.6, 0.9, 1.3, 1.8, 2.6, 3.6];
const NANG = 192;

(async () => {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
  await page.evaluate((t) => { const q = window.__game.engine.quality; q.auto = false; q.setTier(t); }, TIER);
  await page.waitForTimeout(400);

  const restart = async () => {
    await page.evaluate(({ id, seed }) => {
      const g = window.__game;
      g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
      g.setDemo(true);
      g.engine.paused = true;
      if (g.engine.clock) g.engine.clock.elapsed = 1000;
    }, { id: ARENA, seed: SEED });
    await page.waitForTimeout(1200);
  };
  await restart();

  const tierName = await page.evaluate(() => window.__game.engine.quality.settings.name);
  /* Four agents build into this tree at once; a capture that does not name the
   * bundle it photographed is not reproducible. */
  const bundle = await page.evaluate(() => [...document.querySelectorAll('script[src]')]
    .map((s) => s.getAttribute('src')).join(' ') || document.title);
  console.log(`  bundle: ${bundle}   base: ${BASE}`);

  /* ------------------------------------------------------------- the survey */
  let picked = TICKS;
  if (SURVEY || AUTO) {
    console.log(`\nCONTACT SURVEY — ${ARENA}, tier ${tierName}, seed ${SEED}, ticks ${FROM}..${TO} step ${STEP}`);
    console.log('  gapL/gapR: millimetres from the deck to the LOWEST SKINNED VERTEX carried by');
    console.log('             that foot, in the pose that would be photographed. The sim\'s own');
    console.log(`             grounded flag is printed beside it. CONTACT = grounded AND a foot`);
    console.log(`             within ${EPS_MM} mm AND the pool in frame.\n`);
    console.log('   tick |          ROBOT 1 (player)          |         ROBOT 2 (opponent)        | ct');
    console.log('        |  air  gnd  gapL gapR  hPx  below   |  air  gnd  gapL gapR  hPx  below  |');
    console.log('  ' + '-'.repeat(82));
    let done = 0;
    const hits = [];
    for (let tk = FROM; tk <= TO; tk += STEP) {
      await page.evaluate((n) => window.__game.fastForward(n), tk - done);
      done = tk;
      await page.evaluate(`(${SETTLE_FN})(240)`);
      const f = await page.evaluate(`(${CONTACT_FN})()`);
      const rs = f.robots;
      if (tk === FROM) {
        console.log(`  (chassis: robot 1 ${rs[0].legs}${rs[0].hover ? ' — HOVER, never plants a foot' : ''}`
          + `, robot 2 ${rs[1].legs}${rs[1].hover ? ' — HOVER, never plants a foot' : ''})`);
      }
      const touch = (x) => x.grounded && (x.hover
        ? x.air < 0.08                                     // at rest hover height
        : Math.min(x.gapL == null ? 1e9 : x.gapL, x.gapR == null ? 1e9 : x.gapR) <= EPS_MM);
      const framed = (x) => x.below >= Math.round(x.hPx * 0.33) && x.hPx >= 55;
      const ok = rs.every((x) => touch(x) && framed(x));
      if (ok) hits.push({ tick: tk, r: rs });
      const cell = (x) => `${pad(x.air.toFixed(2), 6)} ${x.grounded ? ' Y ' : ' - '}`
        + `${pad(x.gapL, 6)}${pad(x.gapR, 5)}${pad(x.hPx, 5)}${pad(x.below, 7)}`;
      console.log(`  ${pad(tk, 5)} |${cell(rs[0])}   |${cell(rs[1])}  | ${ok ? 'YES' : '  -'}`);
    }
    console.log('');
    if (!hits.length) {
      console.log('  NO FRAME WITH A CONTACT in this range. Nothing here can carry a grounding number.');
      if (!AUTO) { await browser.close(); return; }
      throw new Error('no contact frame');
    }
    console.log(`  ${hits.length} contact frame(s): ${hits.map((h) => h.tick).join(', ')}`);
    // Prefer the contact with the most deck around it and the largest machines:
    // the pool is measured in the deck, so deck in frame is the scarce resource.
    const best = hits.slice().sort((a, b) =>
      (b.r[0].hPx + b.r[1].hPx + Math.min(b.r[0].below, 600) + Math.min(b.r[1].below, 600))
      - (a.r[0].hPx + a.r[1].hPx + Math.min(a.r[0].below, 600) + Math.min(a.r[1].below, 600)))[0];
    picked = best.tick;
    console.log(`  best: tick ${picked}  (${best.r[0].hPx}px / ${best.r[1].hPx}px machines,`
      + ` gaps ${best.r[0].gapL}/${best.r[0].gapR} and ${best.r[1].gapL}/${best.r[1].gapR} mm)`);
    if (!AUTO) {
      if (errors.length) console.log('\npage errors:', errors.slice(0, 4));
      await browser.close();
      return;
    }
    await restart();
  }

  /* -------------------------------------------------------- the measurement */
  await page.evaluate((n) => window.__game.fastForward(n), picked);
  const settled = await page.evaluate(`(${SETTLE_FN})(240)`);
  if (!settled) throw new Error('camera rig unavailable — cannot pin the frame');
  const transient = await page.evaluate(`(${VFX_OFF_FN})()`);
  if (transient && transient.length) console.log('  suppressed transients:', transient.join(', '));
  const frame = await page.evaluate(`(${CONTACT_FN})()`);

  // ASSERT, do not assume. This is the whole point of the tool.
  const bad = [];
  frame.robots.forEach((x, i) => {
    const g = Math.min(x.gapL == null ? 1e9 : x.gapL, x.gapR == null ? 1e9 : x.gapR);
    if (!x.grounded) bad.push(`robot ${i + 1} is not grounded (${x.air.toFixed(2)} m up)`);
    else if (x.hover) {
      if (x.air >= 0.08) bad.push(`robot ${i + 1} (HOVER) is not at rest height (${x.air.toFixed(2)} m up)`);
    } else if (g > EPS_MM) bad.push(`robot ${i + 1} has no foot on the deck (nearest sole ${g} mm up)`);
  });

  for (const id of ['ui-layer', 'hud-layer', 'splash']) {
    await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
  }
  await page.waitForTimeout(700);

  const samples = await page.evaluate(`(${RINGS_FN})(${JSON.stringify(RINGS)}, ${NANG})`);

  const shot = async () => {
    await page.waitForTimeout(500);
    const b = await page.screenshot({ timeout: 180000 });
    return 'data:image/png;base64,' + b.toString('base64');
  };

  const uris = {};
  uris.none = await shot();                                     // as shipped
  await page.evaluate(`(${CUE_FN})(false)`);
  uris.nocue = await shot();                                    // discs off
  await page.evaluate(`(${MAP_FN})(false)`);
  uris.nothing = await shot();                                  // discs + map off
  await page.evaluate(`(${MAP_FN})(true)`);
  await page.evaluate(`(${CUE_FN})(true)`);

  await page.evaluate(`(${STENCIL_FN})(true)`);
  uris.__stencil = await shot();
  await page.evaluate(`(${STENCIL_FN})(false)`);

  if (KEEP) {
    mkdirSync('shots', { recursive: true });
    const nm = `shots/r17-${ARENA}-t${TIER}-${picked}${TAG ? '-' + TAG : ''}`;
    for (const k of ['none', 'nocue', 'nothing']) {
      writeFileSync(`${nm}-${k}.png`, Buffer.from(uris[k].split(',')[1], 'base64'));
    }
  }

  const probe = await context.newPage();
  await probe.goto('about:blank');
  const rings = await probe.evaluate(READ_FN, { uris, samples });

  console.log(`\nCONTACT — ${ARENA} @ tier ${tierName}, tick ${picked}, ${frame.W}x${frame.H}`
    + `, shadowMap=${frame.shadowMap}`);
  if (bad.length) {
    console.log('  *** NO CONTACT IN THIS FRAME — the numbers below are void ***');
    for (const b of bad) console.log('      ' + b);
  }
  frame.robots.forEach((x, i) => {
    console.log(`\n  ROBOT ${i + 1}  legs=${x.legs}${x.hover ? ' (HOVER — no foot contact exists)' : ''}`
      + `  air ${x.air.toFixed(3)} m  grounded=${x.grounded}`
      + `  soles L/R ${x.gapL}/${x.gapR} mm  lowest ${x.gapMin} mm`
      + (x.deckSnapped ? `  *** deck snapped to ${x.deckStrict.toFixed(2)} m by a neighbouring box ***` : ''));
    console.log(`     ${x.hPx}px tall, ${x.mPx}px per deck metre, ${x.below}px of viewport below the contact`
      + `   blob=${x.blob} disc=${x.disc}`);
    const R = rings[i];
    console.log('     ring (m)     ' + RINGS.map((r) => pad(r.toFixed(2), 8)).join(''));
    console.log('     samples      ' + R.map((r) => pad(r.n, 8)).join(''));
    console.log('     as shipped   ' + R.map((r) => pad(r1(r.none), 8)).join(''));
    console.log('     no discs     ' + R.map((r) => pad(r1(r.nocue), 8)).join(''));
    console.log('     no cue at all' + R.map((r) => pad(r1(r.nothing), 8)).join(''));
    console.log('     CD_blob      ' + R.map((r) => pad(r1(r.dBlob), 8)).join(''));
    console.log('     CD_map       ' + R.map((r) => pad(r1(r.dMap), 8)).join(''));
    console.log('     CD_all       ' + R.map((r) => pad(r1(r.dAll), 8)).join(''));
    const near = R[0].none, far = R[R.length - 2].none;
    const pd = near != null && far != null ? r1(far - near) : null;
    console.log(`     PD (2.6 m minus contact, as shipped): ${pd}`);
    const cdPeak = Math.max(...R.map((r) => r.dAll ?? 0));
    console.log(`     CD_all peak: ${r1(cdPeak)}   CD_blob at contact: ${r1(R[0].dBlob)}`
      + `   CD_map at contact: ${r1(R[0].dMap)}`);
  });

  console.log('\n  JSON ' + JSON.stringify({
    arena: ARENA, tier: tierName, tick: picked, contact: !bad.length,
    robots: frame.robots.map((x, i) => ({
      legs: x.legs, gapL: x.gapL, gapR: x.gapR, hPx: x.hPx, below: x.below,
      pd: r1((rings[i][RINGS.length - 2].none ?? 0) - (rings[i][0].none ?? 0)),
      cdBlob0: r1(rings[i][0].dBlob), cdMap0: r1(rings[i][0].dMap), cdAll0: r1(rings[i][0].dAll),
      cdAllPeak: r1(Math.max(...rings[i].map((r) => r.dAll ?? 0))),
      curve: rings[i].map((r) => r1(r.none)),
    })),
  }));
  if (errors.length) console.log('\npage errors:', errors.slice(0, 4));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
