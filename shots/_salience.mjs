#!/usr/bin/env node
/**
 * ATTENTION METER — what does the eye land on before it lands on the fight?
 *
 * Two residuals in REVIEW2 have flipped between "closed" and "open" across four
 * rounds, and the reason is written into the review itself: *"That file has
 * since been rewritten and no tool in this tree can reproduce those numbers any
 * more — which is the residual's real problem and is why a report that it 'no
 * longer reproduces' could be made in good faith."* An agent closed the gate
 * residual, the critic re-measured and re-opened it, and neither could hand the
 * other a command to run. So this file exists to be RE-RUNNABLE, is force-added
 * under shots/ (which is gitignored — eight agents have lost their instruments
 * to that), and re-implements the sweep from round 6's written definition:
 *
 *   A = lum x chroma                      "colourful and bright"
 *   B = (lum + 1.5 x local contrast) x chroma
 *   C = local contrast x chroma           "busy and colourful"
 *   T = 32/40/48/64 at offsets 0 and half-tile; machine pixels come from
 *   contour.mjs's binary stencil, not from a hand-drawn box.
 *
 * Absolute ranks from this file will NOT match round 6's to the integer — its
 * tool is gone and its chroma was never defined in writing. That does not
 * matter for the job, and pretending otherwise is how the residual got stuck:
 * what decides whether a fix worked is the SAME tool run before and after, and
 * the review's own claim — "the gate takes rank 1 in ten of twenty-four cells"
 * — is a statement about this build that this file can check today.
 *
 * chroma here is (max-min)/255 of the sRGB triple, in 0..1. Stated because it
 * was not, last time.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS THE AUTHORITY METER FOR SALIENCE AND COVERAGE. `shots/_sal.mjs`
 * IS NOT.
 * ---------------------------------------------------------------------------
 *
 * Instrument fault 13 in REVIEW2: the repository carries two committed salience
 * meters that suppress different scene elements before they look and disagree
 * by about 2.7 points on the same build, and neither was labelled. That is
 * settled here rather than left to the next round to trip over. This one wins
 * on three counts and one of them is decisive:
 *
 *   - it takes the machine mask from `contour.mjs`'s binary stencil, so a
 *     "machine" pixel is a machine pixel and not a colour key;
 *   - it carries the dt-corrected settle (see INSTRUMENT FAULT #12 below), so
 *     the machines are drawn in the pose that belongs to the tick;
 *   - it is the file the gate residual has been argued on since round 13, so
 *     keeping it is what makes this round's before/after comparable with the
 *     five rounds of filings behind it.
 *
 * `_sal.mjs` stays in the tree because round 12 derived it and round 16 used it
 * to cross-check a top-1% figure, and a second opinion is worth having. It is a
 * SECOND opinion. No figure may be carried from one of these files to the other
 * inside a comparison; name the meter in the sentence, every time.
 *
 * MODES
 *   (default)  the 3-model x 4-tile x 2-offset sweep, plus the top-20 tiles of
 *              model A, plus the colour-family table (cyan/amber/machines) on
 *              REVIEW2's own definition: sat >= 0.35, hue 165-200 / 20-55.
 *   --lights   knock each stage light out of the pinned frame in turn and diff.
 *              This is the half of the gate residual that is a LIGHTING bug
 *              rather than a paint one: "a practical is not allowed to out-light
 *              the sun" is only checkable by turning them off one at a time.
 *   --bloom X  composite bloomStrength for this capture only, 0 to switch the
 *              post chain's glow off. `0dbaa12` measured bloom's share of the
 *              opponent's outline collapse during a detonation and closed by
 *              saying clause E on the STILL FRAME had never been re-read
 *              without it. This is that knob. Diagnostic only, and it refuses
 *              rather than reporting a zero if the composite did not change.
 *   --rect x0,y0,x1,y1   name a region to rank.
 *   --gate     derive the gate rect from the SCENE instead of typing one in,
 *              and rank that. The rect quoted for the gate residual since round
 *              6 — `x 80-200, y 226-386` — is a hand-drawn box on ONE arena's
 *              frame, which is exactly why the residual could never be carried
 *              to another arena: nobody could say where foundry's gate was
 *              without eyeballing a PNG, so for four rounds nobody did, and the
 *              entry was argued on grid, which it was never about. This
 *              re-derives `Stage._buildGates`'s own local frame from
 *              `arena.bounds` + `arena.spawns`, projects the portal's eight
 *              corners through the pinned camera, and reports the screen AABB.
 *              Same definition in every arena, no eyeballing, and it prints the
 *              rect it used so a later round can check it.
 *
 * Usage:
 *   node shots/_salience.mjs --arena grid
 *   node shots/_salience.mjs --arena foundry --gate
 *   node shots/_salience.mjs --arena orbital --lights
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

const BASE = flag('base', 'http://127.0.0.1:4210/');
const TIER = Number(flag('tier', 3));
const ARENA = flag('arena', 'grid');
const SEED = Number(flag('seed', 1234567));
const TICKS = Number(flag('ticks', 420));
const LIGHTS = !!flag('lights');
const KEEP = !!flag('keep');
const GATE = !!flag('gate');
const RECT = flag('rect', null);
/** --bloom X: composite bloomStrength for this capture only. See the block below. */
const BLOOM = flag('bloom', null) === null ? null : Number(flag('bloom', null));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* Identical to contour.mjs / mass.mjs / _ground.mjs. */
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
      // INSTRUMENT FAULT 19, FIXED HERE AND IN THE OTHER FOUR COPIES AT ONCE.
      // A mesh that does not write depth does not occlude the machines in the
      // real frame. Painting it opaque black made it occlude them in the mask:
      // the practicals batch is additive with depthWrite off at renderOrder 4,
      // so it drew after the machines and deleted them wherever it overlapped.
      // Measured before this change, machine stencil area with that batch
      // hidden vs left visible: grid 24460 -> 24460, orbital 24808 -> 24808,
      // foundry 4854 -> 8138 — two fifths of foundry's near machine missing
      // from every mask-derived figure taken of that arena. Zero on grid, which
      // is why five rounds of arguing on grid never hit it.
      // Hidden rather than blackened: whether such a mesh TINTS the machine is
      // a colour question, and this is a mask.
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

/**
 * INSTRUMENT FAULT #12 — this file had the dt = 0 machine settle that HEAD's
 * commit 52625c7 fixed in tools/contour.mjs and tools/mass.mjs, and nowhere
 * else. It settled the CAMERA 240 times at 1/60 and the MACHINES once,
 * afterwards, at dt = 0; every pose blend term in RoboModel.update is a damper
 * and damp(a, b, lambda, dt) is exactly `a` at dt = 0, so the machines were
 * drawn at tick 420's POSITION in a load-dependent POSE.
 *
 * That matters for THIS tool specifically, and it is why the fix is carried
 * across rather than shrugged at. The stage does not move, so the tiles the
 * sweep ranks are stable — but the two figures the residual is argued on are
 * not. `m%` per tile and "best rank of a >=50%-machine tile" are both functions
 * of where the limbs happened to be, so "the gate outranks the machines" was
 * being decided by how loaded the box was when the capture ran. Every rank
 * quoted against this file before this line existed carries that error bar.
 */
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
 * Every light in the scene, named, so a knock-out diff can say WHICH fixture is
 * responsible for a bright region rather than "the lighting".
 */
const LIGHT_LIST_FN = `() => {
  const v = window.__game.view;
  const out = [];
  v.scene.traverse((o) => { if (o.isLight) out.push(o); });
  if (v.stage && v.stage.group) v.stage.group.traverse((o) => {
    if (o.isLight && !out.includes(o)) out.push(o);
  });
  window.__lights = out;
  return out.map((l, i) => ({
    i,
    type: l.type,
    name: l.name || '',
    intensity: Math.round((l.intensity || 0) * 100) / 100,
    distance: l.distance != null ? Math.round(l.distance * 10) / 10 : null,
    inStage: !!(v.stage && v.stage.gateLights && v.stage.gateLights.includes(l)),
  }));
}`;

/**
 * The gate rect, taken from the scene rather than from a reader's eye.
 *
 * `Stage._buildGates` builds one portal per spawn: it picks the nearest wall,
 * builds a local frame with +Z pointing into the arena, and lays out a W=5.0 x
 * H=4.2 x D=1.6 recess with 0.9-wide jambs, a lintel 1.0 tall above it and a
 * threshold chevron plane 2.4 deep on the deck in front. The same arithmetic is
 * repeated here — deliberately, rather than reading it off the merged mesh,
 * because every gate primitive is merged into `architecture` / `practicals` /
 * `hazard` at flush time and cannot be picked out again.
 *
 * Returns every gate's screen AABB plus which one is in frame, so the caller
 * ranks the portal the camera is actually looking at.
 */
const GATE_RECT_FN = `() => {
  const v = window.__game.view;
  const st = v.stage, cam = v.camera, a = st.arena, b = a.bounds;
  cam.updateMatrixWorld(true);
  const W = window.innerWidth, H = window.innerHeight;
  const mvi = cam.matrixWorldInverse.elements, prj = cam.projectionMatrix.elements;
  const mul = (e, x, y, z, w) => [
    e[0] * x + e[4] * y + e[8] * z + e[12] * w,
    e[1] * x + e[5] * y + e[9] * z + e[13] * w,
    e[2] * x + e[6] * y + e[10] * z + e[14] * w,
    e[3] * x + e[7] * y + e[11] * z + e[15] * w,
  ];
  const project = (x, y, z) => {
    const c = mul(mvi, x, y, z, 1);
    const p = mul(prj, c[0], c[1], c[2], c[3]);
    if (p[3] <= 0) return null;                 // behind the camera
    return [(p[0] / p[3] * 0.5 + 0.5) * W, (1 - (p[1] / p[3] * 0.5 + 0.5)) * H];
  };

  const GW = 5.0, GH = 4.2, GD = 1.6;
  const out = [];
  for (const sp of a.spawns) {
    const toX = b.hx - Math.abs(sp.x), toZ = b.hz - Math.abs(sp.z);
    const onX = toX < toZ;
    const yaw = onX ? (sp.x > 0 ? -Math.PI / 2 : Math.PI / 2) : (sp.z > 0 ? Math.PI : 0);
    const gx = onX ? Math.sign(sp.x) * b.hx : Math.max(-b.hx + 4, Math.min(b.hx - 4, sp.x));
    const gz = onX ? Math.max(-b.hz + 4, Math.min(b.hz - 4, sp.z)) : Math.sign(sp.z) * b.hz;
    const co = Math.cos(yaw), si = Math.sin(yaw);
    const put = (lx, ly, lz) => [gx + co * lx + si * lz, ly, gz - si * lx + co * lz];

    // Local extents of the portal AS BUILT: jambs sit at +-(W/2 + 0.45) and are
    // 0.9 wide, the lintel is (W + 1.8) wide and reaches H + 1.0, the recess
    // runs back to -D and the threshold plane forward to +2.2.
    const hx = GW / 2 + 0.9, y0 = 0, y1 = GH + 1.0, z0 = -GD, z1 = 2.2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, behind = 0, n = 0;
    for (const lx of [-hx, hx]) for (const ly of [y0, y1]) for (const lz of [z0, z1]) {
      const p = put(lx, ly, lz);
      const s = project(p[0], p[1], p[2]);
      n++;
      if (!s) { behind++; continue; }
      if (s[0] < minX) minX = s[0];
      if (s[0] > maxX) maxX = s[0];
      if (s[1] < minY) minY = s[1];
      if (s[1] > maxY) maxY = s[1];
    }
    if (behind === n) { out.push({ spawn: sp, behind: true }); continue; }
    const cx = Math.max(0, Math.min(W, minX)), cX = Math.max(0, Math.min(W, maxX));
    const cy = Math.max(0, Math.min(H, minY)), cY = Math.max(0, Math.min(H, maxY));
    out.push({
      spawn: { x: sp.x, z: sp.z },
      raw: [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)],
      rect: [Math.round(cx), Math.round(cy), Math.round(cX), Math.round(cY)],
      onScreen: Math.max(0, cX - cx) * Math.max(0, cY - cy),
      clipped: behind > 0,
    });
  }
  return out;
}`;

const ANALYSE_FN = async ({ nUri, hUri, rect }) => {
  const load = async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };

  const N = await load(nUri);
  const M = await load(hUri);
  const W = N.W, H = N.H, NP = W * H;
  const lumOf = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  const L = new Float32Array(NP);
  const C = new Float32Array(NP);        // chroma 0..1
  const S = new Float32Array(NP);        // HSV saturation 0..1
  const Hue = new Float32Array(NP);      // degrees
  const mask = new Uint8Array(NP);
  for (let p = 0, i = 0; p < NP; p++, i += 4) {
    const r = N.d[i], g = N.d[i + 1], b = N.d[i + 2];
    L[p] = lumOf(N.d, i);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    C[p] = d / 255;
    S[p] = mx > 0 ? d / mx : 0;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    Hue[p] = (h + 360) % 360;
    if (lumOf(M.d, i) > 128) mask[p] = 1;
  }

  /* Local contrast: |L - blur(L)| on a 9px box blur, the cheap standard. */
  const blur = new Float32Array(NP);
  {
    const tmp = new Float32Array(NP);
    const R = 4;
    for (let y = 0; y < H; y++) {
      let acc = 0, n = 0;
      for (let x = -R; x <= R; x++) { const xx = Math.min(W - 1, Math.max(0, x)); acc += L[y * W + xx]; n++; }
      for (let x = 0; x < W; x++) {
        tmp[y * W + x] = acc / n;
        const xa = Math.min(W - 1, Math.max(0, x - R)), xb = Math.min(W - 1, Math.max(0, x + R + 1));
        acc += L[y * W + xb] - L[y * W + xa];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0, n = 0;
      for (let y = -R; y <= R; y++) { const yy = Math.min(H - 1, Math.max(0, y)); acc += tmp[yy * W + x]; n++; }
      for (let y = 0; y < H; y++) {
        blur[y * W + x] = acc / n;
        const ya = Math.min(H - 1, Math.max(0, y - R)), yb = Math.min(H - 1, Math.max(0, y + R + 1));
        acc += tmp[yb * W + x] - tmp[ya * W + x];
      }
    }
  }
  const LC = new Float32Array(NP);
  for (let p = 0; p < NP; p++) LC[p] = Math.abs(L[p] - blur[p]);

  /* --- the sweep -------------------------------------------------------- */
  const models = ['A', 'B', 'C'];
  const scoreOf = (m, l, lc, c) => {
    if (m === 'A') return l * c;
    if (m === 'B') return (l + 1.5 * lc) * c;
    return lc * c;
  };

  const sweep = [];
  let topA40 = null;
  for (const T of [32, 40, 48, 64]) {
    for (const off of [0, T >> 1]) {
      const cols = Math.floor((W - off) / T), rows = Math.floor((H - off) / T);
      const tiles = [];
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const x0 = off + tx * T, y0 = off + ty * T;
          let sl = 0, slc = 0, sc = 0, mc = 0, n = 0;
          for (let y = y0; y < y0 + T; y++) {
            for (let x = x0; x < x0 + T; x++) {
              const p = y * W + x;
              sl += L[p]; slc += LC[p]; sc += C[p]; mc += mask[p]; n++;
            }
          }
          tiles.push({ x: x0, y: y0, l: sl / n, lc: slc / n, c: sc / n, m: mc / n });
        }
      }
      /**
       * INSTRUMENT FAULT #14 — the two things this sweep ranks against each
       * other were never counted by the same rule. A tile scored as "machine"
       * only if HALF ITS PIXELS were machine; a tile scored as "gate" if its
       * top-left CORNER landed in the rect, with no content threshold at all,
       * so a 64x64 tile whose other 4095 pixels are bare wall counted as the
       * gate. Every "the gate outranks the machines" figure in REVIEW2 was
       * taken on that pair.
       *
       * Both rules are computed here and both are reported. `area` is the fair
       * one — the same >= 50% test the machines have always been held to,
       * applied to the rect — and it is the one a closure argument may use.
       * `corner` is kept only so this round's numbers stay comparable with the
       * five rounds of filings that were taken on it.
       */
      const cover = (t) => {
        if (!rect) return 0;
        const ox = Math.max(0, Math.min(t.x + T, rect[2]) - Math.max(t.x, rect[0]));
        const oy = Math.max(0, Math.min(t.y + T, rect[3]) - Math.max(t.y, rect[1]));
        return (ox * oy) / (T * T);
      };
      for (const t of tiles) {
        t.rc = cover(t);
        t.rcorner = rect ? (t.x >= rect[0] && t.x < rect[2] && t.y >= rect[1] && t.y < rect[3]) : false;
      }
      const row = { T, off, total: tiles.length, cells: {} };
      for (const m of models) {
        for (const t of tiles) t.s = scoreOf(m, t.l, t.lc, t.c);
        const sorted = tiles.slice().sort((a, b) => b.s - a.s);
        let robotRank = null, rectRank = null, rectTop10 = 0;
        let cornerRank = null, cornerTop10 = 0;
        for (let i = 0; i < sorted.length; i++) {
          const t = sorted[i];
          if (robotRank === null && t.m >= 0.5) robotRank = i + 1;
          if (t.rc >= 0.5) {
            if (rectRank === null) rectRank = i + 1;
            if (i < 10) rectTop10++;
          }
          if (t.rcorner) {
            if (cornerRank === null) cornerRank = i + 1;
            if (i < 10) cornerTop10++;
          }
        }
        row.cells[m] = { robotRank, rectRank, rectTop10, cornerRank, cornerTop10 };
        if (m === 'A' && T === 40 && off === 0) {
          topA40 = sorted.slice(0, 20).map((t) => ({
            x: t.x, y: t.y,
            s: Math.round(t.s * 10) / 10,
            l: Math.round(t.l * 10) / 10,
            c: Math.round(t.c * 1000) / 1000,
            m: Math.round(t.m * 100),
            r: Math.round(t.rc * 100),
            k: t.rcorner ? 1 : 0,
          }));
        }
      }
      sweep.push(row);
    }
  }

  /* --- colour families, REVIEW2's own definition ------------------------ */
  const fam = (lo, hi) => {
    let n = 0, sl = 0, ss = 0;
    for (let p = 0; p < NP; p++) {
      if (mask[p]) continue;
      if (S[p] < 0.35) continue;
      const h = Hue[p];
      if (h < lo || h > hi) continue;
      n++; sl += L[p]; ss += S[p];
    }
    return { pct: Math.round(n / NP * 1000) / 10, lum: n ? Math.round(sl / n * 10) / 10 : 0, sat: n ? Math.round(ss / n * 1000) / 1000 : 0, n };
  };
  let mn = 0, msl = 0, mss = 0;
  for (let p = 0; p < NP; p++) if (mask[p]) { mn++; msl += L[p]; mss += S[p]; }

  /* Who owns the brightest 1% of the frame.
   *
   * ROUND 39 — the two columns round 16's standing rule REQUIRES beside this
   * figure. The rule reads: clause E is quoted "with the saturation and clipped
   * fraction of the pixels that won it". This meter has never printed either.
   * `families.machines.sat` is the saturation of EVERY machine pixel, which is a
   * different quantity from the saturation of the machine pixels in the top 1%,
   * and there has never been a clipped fraction at all — so every clause E
   * figure in REVIEW2 has been filed in breach of REVIEW2's own rule, and it was
   * invisible because the instrument silently did not compute it.
   *
   * Both are added here as REPORT-ONLY columns. `hot.machine` is untouched, so
   * no filed figure moves and the before/after comparability that makes this the
   * authority meter is preserved. `winSat` is the mean HSV saturation of the
   * machine pixels above the cut; `winClip` is the fraction of them with any
   * channel at 250 or more, i.e. the share of the win that is a clip rather than
   * a highlight. The threshold `thr` is printed for the same reason: a share of
   * the top 1% is a RANK statistic, so it is invariant to a lift that moves the
   * machines and the cut together, and the cut is the only thing in the row that
   * can say so. */
  const sortedL = Float32Array.from(L).sort();
  const thr = sortedL[Math.floor(NP * 0.99)];
  let hotN = 0, hotMachine = 0, hotCyan = 0, hotAmber = 0;
  let winSat = 0, winClip = 0;
  for (let p = 0; p < NP; p++) {
    if (L[p] < thr) continue;
    hotN++;
    if (mask[p]) {
      hotMachine++;
      winSat += S[p];
      const i = p * 4;
      if (Math.max(N.d[i], N.d[i + 1], N.d[i + 2]) >= 250) winClip++;
      continue;
    }
    if (S[p] >= 0.35) {
      const h = Hue[p];
      if (h >= 165 && h <= 200) hotCyan++;
      else if (h >= 20 && h <= 55) hotAmber++;
    }
  }

  return {
    screen: `${W}x${H}`,
    sweep,
    topA40,
    families: {
      cyan: fam(165, 200),
      amber: fam(20, 55),
      machines: { pct: Math.round(mn / NP * 1000) / 10, lum: mn ? Math.round(msl / mn * 10) / 10 : 0, sat: mn ? Math.round(mss / mn * 1000) / 1000 : 0 },
    },
    hot: {
      threshold: Math.round(thr * 10) / 10,
      machine: Math.round(hotMachine / hotN * 1000) / 10,
      cyan: Math.round(hotCyan / hotN * 1000) / 10,
      amber: Math.round(hotAmber / hotN * 1000) / 10,
      n: hotN,
      winN: hotMachine,
      winSat: hotMachine ? Math.round(winSat / hotMachine * 1000) / 1000 : 0,
      winClip: hotMachine ? Math.round(winClip / hotMachine * 1000) / 10 : 0,
    },
  };
};

/**
 * Diff two frames: coverage of pixels this light actually moved, its mean
 * contribution over those pixels, and its peak. The peak is the number that
 * settles "a practical out-lights the sun".
 */
const DIFF_FN = async ({ aUri, bUri }) => {
  const load = async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const A = await load(aUri), B = await load(bUri);
  const NP = A.W * A.H;
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  let n = 0, sum = 0, peak = 0;
  for (let p = 0, i = 0; p < NP; p++, i += 4) {
    const dv = lum(A.d, i) - lum(B.d, i);
    if (dv > 2) { n++; sum += dv; if (dv > peak) peak = dv; }
  }
  return {
    pct: Math.round(n / NP * 1000) / 10,
    mean: n ? Math.round(sum / n * 10) / 10 : 0,
    peak: Math.round(peak * 10) / 10,
  };
};

const pad = (v, n) => String(v).padStart(n);

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
  /**
   * Round 14 asked for this in one line and nobody added it: "have every
   * capture print the bundle hash it measured." Four agents build into the same
   * tree concurrently, so a sweep that does not name the bundle it photographed
   * is a set of numbers about somebody else's uncommitted work.
   */
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
  const settled = await page.evaluate(`(${SETTLE_FN})(240)`);
  if (!settled) throw new Error('camera rig unavailable — cannot pin the frame');
  const transient = await page.evaluate(`(${VFX_OFF_FN})()`);
  if (transient && transient.length) console.log('  suppressed transients:', transient.join(', '));
  for (const id of ['ui-layer', 'hud-layer', 'splash']) {
    await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
  }
  await page.waitForTimeout(700);

  /**
   * `--bloom X` sets the composite's bloomStrength for this capture only.
   *
   * `0dbaa12` measured bloom's share of the opponent's outline collapse and of
   * the brightest 1% DURING A DETONATION, and closed by naming what it could
   * not settle: "clause E on the still frame, clause B's three arena figures
   * and the whole look of the machines' highlights are measured WITH bloom and
   * none of them has been re-read without it." This is the flag that lets the
   * still frame be re-read. `_r17-blast.mjs` has had the same knob since round
   * 18; the authority meter for clause E did not, which is why the still-frame
   * half of the question has never been asked.
   *
   * It is a DIAGNOSTIC. Nothing is written to src, and the uniform is restored
   * by the next settings change. Two facts make it safe to set here rather than
   * at construction: the engine's frame loop calls onRender whether or not the
   * sim is paused (core/engine.js), so the pinned frame is re-composited a few
   * dozen times during the wait below; and `q.auto` is off in this capture, so
   * nothing re-applies the tier and resets the uniform underneath it.
   *
   * IT REFUSES RATHER THAN REPORTING A ZERO. The value is read back after the
   * wait, and a capture whose composite did not actually change is a capture
   * that would print a full, plausible, wrong table -- which is fault 25 with a
   * different first cause. If the uniform is absent or did not take, this stops.
   */
  if (BLOOM !== null) {
    const got = await page.evaluate((b) => {
      const u = window.__game.engine.postfx && window.__game.engine.postfx.uniforms;
      if (!u || !u.bloomStrength) return null;
      const was = u.bloomStrength.value;
      u.bloomStrength.value = Number(b);
      return { was, now: u.bloomStrength.value };
    }, BLOOM);
    if (!got) throw new Error('--bloom: no bloomStrength uniform on this build — the diagnostic did nothing');
    await page.waitForTimeout(500);
    const held = await page.evaluate(() => window.__game.engine.postfx.uniforms.bloomStrength.value);
    if (Math.abs(held - Number(BLOOM)) > 1e-6) {
      throw new Error(`--bloom: set ${BLOOM} but the composite holds ${held} — something re-applied the tier`);
    }
    console.log(`  bloomStrength ${got.was} -> ${held}  (diagnostic, not written to src)`);
  }

  const probe = await context.newPage();
  await probe.goto('about:blank');
  const b64 = (buf) => 'data:image/png;base64,' + buf.toString('base64');

  if (LIGHTS) {
    const lights = await page.evaluate(`(${LIGHT_LIST_FN})()`);
    const full = await page.screenshot({ timeout: 180000 });
    console.log(`\nLIGHT KNOCK-OUT — ${ARENA} @ tier ${TIER}, tick ${TICKS}`);
    console.log('  Each fixture switched off in turn and the frame diffed against the full rig.');
    console.log('  "a practical is not allowed to out-light the sun" is a claim about PEAK.\n');
    console.log('   # type              int   dist  gate |   cover     mean    peak');
    console.log('  ' + '-'.repeat(66));
    const rows = [];
    for (const l of lights) {
      await page.evaluate((i) => { const x = window.__lights[i]; x.__was = x.intensity; x.intensity = 0; }, l.i);
      await page.waitForTimeout(320);
      const off = await page.screenshot({ timeout: 180000 });
      await page.evaluate((i) => { const x = window.__lights[i]; x.intensity = x.__was; }, l.i);
      const d = await probe.evaluate(DIFF_FN, { aUri: b64(full), bUri: b64(off) });
      rows.push({ l, d });
      console.log(`  ${pad(l.i, 2)} ${(l.type + '            ').slice(0, 17)} ${pad(l.intensity, 5)} `
        + `${pad(l.distance == null ? '-' : l.distance, 6)} ${l.inStage ? ' YES ' : '  -  '} |`
        + `${pad(d.pct + '%', 7)} ${pad('+' + d.mean, 8)} ${pad('+' + d.peak, 7)}`);
    }
    const gates = rows.filter((r) => r.l.inStage);
    const key = rows.filter((r) => r.l.type === 'DirectionalLight').sort((a, b) => b.d.pct - a.d.pct)[0];
    if (gates.length && key) {
      const worst = gates.sort((a, b) => b.d.peak - a.d.peak)[0];
      console.log(`\n  gate practical peak ${worst.d.peak}  vs  key light peak ${key.d.peak}`
        + `   -> ${worst.d.peak > key.d.peak ? 'THE PRACTICAL OUT-PEAKS THE SUN' : 'ok, the sun wins'}`);
    } else if (!gates.length) {
      console.log('\n  no gate practicals in this arena at this tier.');
    }
    if (errors.length) console.log('\npage errors:', errors.slice(0, 4));
    await browser.close();
    return;
  }

  const N = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(true)`);
  await page.waitForTimeout(700);
  const Ms = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(false)`);

  if (KEEP) {
    mkdirSync('shots', { recursive: true });
    writeFileSync(`shots/sal-${ARENA}-t${TICKS}.png`, N);
  }

  let rect = RECT ? String(RECT).split(',').map(Number) : null;
  let gateNote = '';
  if (GATE) {
    const gates = await page.evaluate(`(${GATE_RECT_FN})()`);
    console.log(`\nGATE RECTS — re-derived from arena.bounds + arena.spawns, projected through the pinned camera`);
    for (const g of gates) {
      if (g.behind) { console.log(`    spawn ${g.spawn.x},${g.spawn.z}   entirely behind the camera`); continue; }
      const [x0, y0, x1, y1] = g.rect;
      console.log(`    spawn ${pad(g.spawn.x, 5)},${pad(g.spawn.z, 6)}   rect ${x0},${y0},${x1},${y1}`
        + `   ${x1 - x0}x${y1 - y0} on screen${g.clipped ? '  (partly behind camera)' : ''}`
        + `   raw ${g.raw.join(',')}`);
    }
    const best = gates.filter((g) => !g.behind && g.onScreen > 0).sort((a, b) => b.onScreen - a.onScreen)[0];
    if (!best) throw new Error('no gate is on screen in this frame — nothing to rank');
    rect = best.rect;
    gateNote = `  ranking the in-frame gate: ${rect.join(',')} (${rect[2] - rect[0]}x${rect[3] - rect[1]} px, `
      + `${(((rect[2] - rect[0]) * (rect[3] - rect[1])) / (1600 * 900) * 100).toFixed(1)}% of frame)`;
    console.log(gateNote);
  }
  const out = await probe.evaluate(ANALYSE_FN, { nUri: b64(N), hUri: b64(Ms), rect });

  console.log(`\nATTENTION — ${ARENA} @ tier ${TIER}, tick ${TICKS}, ${out.screen}`);
  if (gateNote) console.log(gateNote);
  console.log('  best rank of a >=50%-machine tile'
    + (rect ? ' / best rank of a tile >=50% INSIDE the named rect [tiles in top 10]' : ''));
  console.log('\n   T  off  total       A          B          C');
  for (const r of out.sweep) {
    const cell = (m) => {
      const c = r.cells[m];
      const a = pad(c.robotRank == null ? '-' : c.robotRank, 3);
      return rect ? `${a}/${pad(c.rectRank == null ? '-' : c.rectRank, 3)} [${c.rectTop10}]` : `${a}       `;
    };
    console.log(`  ${pad(r.T, 2)} ${pad(r.off, 4)} ${pad(r.total, 6)}  ${cell('A')} ${cell('B')} ${cell('C')}`);
  }

  if (rect) {
    /* The two sentences the residual has actually been filed in, counted. */
    const cells = out.sweep.flatMap((r) => ['A', 'B', 'C'].map((m) => r.cells[m]));
    const n = cells.length;
    const cnt = (f) => cells.filter(f).length;
    const top14 = out.topA40.slice(0, 14);
    console.log('\n  THE FILED CLAIM, COUNTED — "rank 1 in N of 24 cells; M of the top 14 tiles"');
    console.log('                                     rank 1   outranks the machines   of top 14 (A,T=40,off=0)');
    console.log(`    tile >=50% inside the rect (fair) ${pad(cnt((c) => c.rectRank === 1), 5)} /${pad(n, 3)}`
      + `        ${pad(cnt((c) => c.rectRank != null && (c.robotRank == null || c.rectRank < c.robotRank)), 5)} /${pad(n, 3)}`
      + `             ${pad(top14.filter((t) => t.r >= 50).length, 5)} / 14`);
    console.log(`    top-left corner in the rect (as filed) ${pad(cnt((c) => c.cornerRank === 1), 1)} /${pad(n, 3)}`
      + `        ${pad(cnt((c) => c.cornerRank != null && (c.robotRank == null || c.cornerRank < c.robotRank)), 5)} /${pad(n, 3)}`
      + `             ${pad(top14.filter((t) => t.k).length, 5)} / 14`);
    console.log(`    a >=50%-machine tile              ${pad(cnt((c) => c.robotRank === 1), 5)} /${pad(n, 3)}`);
  }

  console.log('\n  top 20 tiles, model A at T=40 off=0   (m% = machine share of the tile;'
    + ' r% = share of the tile inside the rect)');
  for (const t of out.topA40) {
    console.log(`    ${pad(t.x, 5)},${pad(t.y, 4)}   score ${pad(t.s, 7)}   lum ${pad(t.l, 6)}  chroma ${pad(t.c, 6)}`
      + `  m ${pad(t.m, 3)}%  r ${pad(t.r, 3)}%`);
  }

  const f = out.families;
  console.log('\n  colour families (non-machine, sat>=0.35; cyan h165-200, amber h20-55)');
  console.log('                pct     lum     sat');
  console.log(`    cyan      ${pad(f.cyan.pct + '%', 6)} ${pad(f.cyan.lum, 7)} ${pad(f.cyan.sat, 7)}`);
  console.log(`    amber     ${pad(f.amber.pct + '%', 6)} ${pad(f.amber.lum, 7)} ${pad(f.amber.sat, 7)}`);
  console.log(`    MACHINES  ${pad(f.machines.pct + '%', 6)} ${pad(f.machines.lum, 7)} ${pad(f.machines.sat, 7)}`);
  console.log(`\n  brightest 1% of the frame (>= ${out.hot.threshold}): machines ${out.hot.machine}%, cyan ${out.hot.cyan}%, amber ${out.hot.amber}%`);
  console.log('  CLAUSE E, QUOTED AS ROUND 16\'S RULE REQUIRES — the pixels that won it, not all machine pixels');
  console.log(`    cut ${out.hot.threshold} of 255   top 1% = ${out.hot.n} px   machine winners ${out.hot.winN} px`
    + `   their saturation ${out.hot.winSat}   CLIPPED (any channel >= 250) ${out.hot.winClip}%`);

  if (errors.length) console.log('\npage errors:', errors.slice(0, 4));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
