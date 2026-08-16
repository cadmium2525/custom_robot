#!/usr/bin/env node
/**
 * Value-structure meter.
 *
 * The art-direction gate on this project is a *measurement*: "every fight frame
 * sits in a 20-55% value band, no true blacks, no whites". That cannot be
 * answered by looking at a PNG — the eye adapts, and a screenshot viewed beside
 * a bright terminal reads darker than it is. So this reads the pixels.
 *
 *   node tools/measure.mjs --base http://127.0.0.1:4232/ --shots fight,foundry
 *
 * For each named surface it reports, on the 0-255 sRGB scale the reviewer's
 * eyedropper uses, the min / median / max of pixels that are *provably* that
 * surface: world points are projected through the live camera matrices and then
 * occlusion-tested against the arena's own collision boxes and the robots, so a
 * pixel only counts as deck if the deck is what the camera actually sees there.
 * No hand-picked coordinates and no guessing which part of the image is floor.
 *
 * Three frames are captured from one settled camera, which is what settles the
 * "something dims the match screen" confound without any guesswork:
 *
 *   A  as shipped                      — DOM layers on,  VFX on
 *   B  DOM layers display:none         — DOM layers off, VFX on
 *   C  DOM and VFX both off            — the stage's own surface values
 *
 * A vs B at the same pixels is the dimming test. C is the honest surface
 * measurement, because an additive beam lying across the deck is not the deck.
 */

import { chromium } from 'playwright';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4232/');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));

const ARENA_OF = { fight: 'grid', foundry: 'foundry', orbital: 'orbital' };

/* ---------------------------------------------------------------------------
 * In-page probe. Written as a string so it can be evaluated verbatim; it uses
 * no imports, because `three` is bundled and not reachable from the page.
 * ------------------------------------------------------------------------ */
const PROBE_FN = `(() => {
  const g = window.__game;
  const view = g.view;
  const W = window.innerWidth, H = window.innerHeight;

  /* --- DOM text rects (available in every state, match or menu) ------------- */
  const text = {};
  const grabText = (label, sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(el);
    text[label] = {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      color: cs.color, opacity: cs.opacity, font: cs.fontSize + '/' + cs.fontWeight,
    };
  };
  grabText('clock', '.clock__v');
  grabText('p1name', '.hud__plate--l .plate__name');
  grabText('p1hp', '.hud__plate--l .hp__now');
  grabText('round', '.round__n');
  grabText('titleword', '.title__word');
  grabText('menuitem', '.menu__item b');

  /* --- anything that could dim the whole screen ----------------------------- */
  const dimmers = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!(r.width >= W * 0.9 && r.height >= H * 0.9)) continue;
    const op = parseFloat(cs.opacity);
    const hasFilter = cs.filter && cs.filter !== 'none';
    const hasBlend = cs.mixBlendMode && cs.mixBlendMode !== 'normal';
    const bgc = cs.backgroundColor;
    const opaqueBg = bgc && bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent';
    const bgImg = cs.backgroundImage !== 'none';
    if (hasFilter || op < 1 || hasBlend || opaqueBg || bgImg) {
      dimmers.push({
        el: (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).trim().split(/\\s+/).join('.') : el.tagName),
        opacity: cs.opacity,
        filter: hasFilter ? cs.filter : undefined,
        blend: hasBlend ? cs.mixBlendMode : undefined,
        bg: opaqueBg ? bgc : undefined,
        bgImage: bgImg ? cs.backgroundImage.slice(0, 80) : undefined,
        z: cs.zIndex,
      });
    }
  }

  // Menu states have no arena in the scene; the surface probes below need one.
  if (!view || !g.world) {
    return { text, dimmers, deck: [], deckNearBlock: [], wall: [], blockTop: [], blockSide: [], hazard: [],
      stats: { drawCalls: g.engine.stats.drawCalls, tris: g.engine.stats.tris,
               tier: g.engine.quality.settings.name, screen: W + 'x' + H }, stageBuildMs: null };
  }

  const cam = view.camera;
  const stage = view.stage;
  const arena = g.world.arena;
  const b = arena.bounds;

  cam.updateMatrixWorld();
  const VI = cam.matrixWorldInverse.elements;
  const P = cam.projectionMatrix.elements;
  const cx = cam.matrixWorld.elements[12];
  const cy = cam.matrixWorld.elements[13];
  const cz = cam.matrixWorld.elements[14];

  const mul = (e, x, y, z, w) => [
    e[0]*x + e[4]*y + e[8]*z + e[12]*w,
    e[1]*x + e[5]*y + e[9]*z + e[13]*w,
    e[2]*x + e[6]*y + e[10]*z + e[14]*w,
    e[3]*x + e[7]*y + e[11]*z + e[15]*w,
  ];

  /** World point -> integer screen pixel, or null if off-screen / behind. */
  function project(x, y, z) {
    const v = mul(VI, x, y, z, 1);
    const c = mul(P, v[0], v[1], v[2], v[3]);
    if (c[3] <= 0) return null;
    const nx = c[0] / c[3], ny = c[1] / c[3], nz = c[2] / c[3];
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1 || nz > 1) return null;
    const sx = Math.round((nx * 0.5 + 0.5) * W);
    const sy = Math.round((-ny * 0.5 + 0.5) * H);
    if (sx < 1 || sy < 1 || sx >= W - 1 || sy >= H - 1) return null;
    return { x: sx, y: sy };
  }

  /* --- occluders -----------------------------------------------------------
   * The arena's own collision boxes, plus a crude volume per robot. This is the
   * same list the sim collides against, so what occludes a probe is exactly
   * what occludes the player's view. */
  const occ = arena.boxes.map((k, i) => ({
    i, x: k.x, y: k.y, z: k.z,
    hx: k.hx + 0.02, hy: k.hy + 0.07, hz: k.hz + 0.02,   // cap plate + rim
    co: Math.cos(k.yaw || 0), si: Math.sin(k.yaw || 0),
  }));
  for (const r of g.world.robos) {
    if (!r || r.hp <= 0) continue;
    occ.push({ i: -1, x: r.pos.x, y: r.pos.y + 1.0, z: r.pos.z, hx: 1.0, hy: 1.3, hz: 1.0, co: 1, si: 0 });
  }

  /** Distance along cam->P at which the segment first enters box o, or -1. */
  function entryDist(o, px, py, pz) {
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const len = Math.hypot(dx, dy, dz);
    // Into box-local space (inverse yaw).
    const ox = cx - o.x, oz = cz - o.z;
    const lox = o.co * ox + o.si * oz;
    const loz = -o.si * ox + o.co * oz;
    const loy = cy - o.y;
    const ldx = (o.co * dx + o.si * dz) / len;
    const ldz = (-o.si * dx + o.co * dz) / len;
    const ldy = dy / len;
    let t0 = 0, t1 = len;
    const slab = (orig, dir, h) => {
      if (Math.abs(dir) < 1e-9) return (orig >= -h && orig <= h);
      let a = (-h - orig) / dir, bb = (h - orig) / dir;
      if (a > bb) { const s = a; a = bb; bb = s; }
      if (a > t0) t0 = a;
      if (bb < t1) t1 = bb;
      return t0 <= t1;
    };
    if (!slab(lox, ldx, o.hx)) return -1;
    if (!slab(loy, ldy, o.hy)) return -1;
    if (!slab(loz, ldz, o.hz)) return -1;
    return Math.max(0, t0);
  }

  const EPS = 0.08;   // a probe sitting on its own surface must not self-reject
  function visible(px, py, pz, skipIdx) {
    const dist = Math.hypot(px - cx, py - cy, pz - cz);
    for (const o of occ) {
      if (skipIdx != null && o.i === skipIdx) continue;
      const t = entryDist(o, px, py, pz);
      if (t >= 0 && dist - t > EPS) return false;
    }
    return true;
  }

  function sample(px, py, pz, skipIdx, tag) {
    if (!visible(px, py, pz, skipIdx)) return null;
    const s = project(px, py, pz);
    if (!s) return null;
    s.w = [Math.round(px * 100) / 100, Math.round(py * 100) / 100, Math.round(pz * 100) / 100];
    if (tag) s.t = tag;
    return s;
  }

  const deck = [], deckNearBlock = [], wall = [], blockTop = [], blockSide = [], hazard = [];

  /* --- deck ---------------------------------------------------------------- */
  const N = 60;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -b.hx + (i + 0.5) / N * b.hx * 2;
      const z = -b.hz + (j + 0.5) / N * b.hz * 2;
      const p = sample(x, 0.0, z, null);
      if (p) deck.push(p);
    }
  }

  /* --- deck immediately around an obstacle base: the contact-shadow test ---- */
  for (const k of arena.boxes) {
    if (k.kind === 'dais') continue;
    const co = Math.cos(k.yaw || 0), si = Math.sin(k.yaw || 0);
    for (let a = 0; a < 48; a++) {
      const th = a / 48 * Math.PI * 2;
      for (const pad of [0.18, 0.4, 0.75]) {
        const lx = Math.cos(th) * (k.hx + pad), lz = Math.sin(th) * (k.hz + pad);
        const x = k.x + co * lx - si * lz, z = k.z + si * lx + co * lz;
        if (Math.abs(x) > b.hx - 0.2 || Math.abs(z) > b.hz - 0.2) continue;
        const p = sample(x, 0.0, z, null);
        if (p) deckNearBlock.push(p);
      }
    }
  }

  /* --- boundary wall -------------------------------------------------------- */
  const wh = stage.wallH;
  for (let i = 0; i < 56; i++) {
    for (let k = 0; k < 12; k++) {
      const t = (i + 0.5) / 56 * 2 - 1;
      const y = (k + 0.4) / 12 * wh;
      for (const q of [
        [t * b.hx * 0.995, y, -b.hz * 0.998],
        [t * b.hx * 0.995, y, b.hz * 0.998],
        [-b.hx * 0.998, y, t * b.hz * 0.995],
        [b.hx * 0.998, y, t * b.hz * 0.995],
      ]) {
        const p = sample(q[0], q[1], q[2], null);
        if (p) wall.push(p);
      }
    }
  }

  /* --- obstacles ------------------------------------------------------------ */
  arena.boxes.forEach((k, idx) => {
    const co = Math.cos(k.yaw || 0), si = Math.sin(k.yaw || 0);
    const L = (lx, lz) => [k.x + co * lx - si * lz, k.z + si * lx + co * lz];
    for (let i = 0; i < 11; i++) {
      for (let j = 0; j < 11; j++) {
        const lx = (-0.6 + 1.2 * (i / 10)) * k.hx;
        const lz = (-0.6 + 1.2 * (j / 10)) * k.hz;
        const [wx, wz] = L(lx, lz);
        const p = sample(wx, k.top + 0.10, wz, idx, k.kind);
        if (p) blockTop.push(p);
      }
    }
    for (let i = 0; i < 11; i++) {
      for (let m = 0; m < 6; m++) {
        const f = -0.8 + 1.6 * (i / 10);
        const y = k.bottom + (m + 1.4) / 8 * (k.top - k.bottom);
        for (const [lx, lz] of [
          [f * k.hx, -k.hz * 1.03], [f * k.hx, k.hz * 1.03],
          [-k.hx * 1.03, f * k.hz], [k.hx * 1.03, f * k.hz],
        ]) {
          const [wx, wz] = L(lx, lz);
          const p = sample(wx, y, wz, idx, k.kind);
          if (p) blockSide.push(p);
        }
      }
    }
  });

  /* --- hazard paint --------------------------------------------------------- */
  if (stage.hazardMesh) {
    const pos = stage.hazardMesh.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 1200));
    for (let i = 0; i < pos.count; i += step) {
      const s = project(pos.getX(i), pos.getY(i) + 0.004, pos.getZ(i));
      if (s) hazard.push(s);
    }
  }

  return {
    deck, deckNearBlock, wall, blockTop, blockSide, hazard, text, dimmers,
    stats: {
      drawCalls: g.engine.stats.drawCalls,
      tris: g.engine.stats.tris,
      tier: g.engine.quality.settings.name,
      screen: W + 'x' + H,
      // The stage's own batch count is the number in the phone budget, and it
      // is not the same number as the scene total (robots, VFX and the post
      // chain all bill to that). Count the meshes the stage actually submits.
      stageDrawCalls: (() => {
        let n = 0;
        stage.group.traverse((o) => { if ((o.isMesh || o.isPoints) && o.visible) n++; });
        return n;
      })(),
      stageMeshes: (() => {
        const out = [];
        stage.group.traverse((o) => {
          if ((o.isMesh || o.isPoints) && o.visible) {
            out.push((o.name || o.type) + ':' + (o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0));
          }
        });
        return out;
      })(),
    },
    stageBuildMs: stage.buildProfile,
  };
})()`;

/* ---------------------------------------------------------------------------
 * Image analysis, done by decoding the PNG in a throwaway page.
 * ------------------------------------------------------------------------ */
const ANALYSE_FN = async ({ dataUri, probes }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUri; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g2 = c.getContext('2d', { willReadFrequently: true });
  g2.drawImage(img, 0, 0);
  const W = c.width, H = c.height;
  const d = g2.getImageData(0, 0, W, H).data;

  const at = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  const r1 = (v) => Math.round(v * 10) / 10;

  function summarise(pts, filter) {
    if (!pts || !pts.length) return null;
    const rows = [];
    for (const p of pts) {
      if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) continue;
      const rgb = at(p.x, p.y);
      if (filter && !filter(rgb)) continue;
      rows.push({ l: lum(rgb), rgb, x: p.x, y: p.y, w: p.w, t: p.t });
    }
    if (!rows.length) return null;
    rows.sort((a, b) => a.l - b.l);
    const q = (f) => r1(rows[Math.min(rows.length - 1, Math.floor(f * rows.length))].l);
    return {
      n: rows.length,
      min: r1(rows[0].l), p05: q(0.05), p50: q(0.5), p95: q(0.95),
      max: r1(rows[rows.length - 1].l),
      darkest: rows[0], brightest: rows[rows.length - 1],
    };
  }

  // Whole-frame statistics with the HUD strips excluded.
  const L = [];
  let warm = 0, cool = 0, sat = 0, total = 0;
  for (let y = 130; y < H - 100; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const p = at(x, y);
      L.push(lum(p));
      const mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]);
      total++;
      if (mx - mn > 26) {
        sat++;
        if (p[0] > p[2] + 18) warm++;
        else if (p[2] > p[0] + 18) cool++;
      }
    }
  }
  L.sort((a, b) => a - b);
  const fq = (f) => r1(L[Math.floor(f * L.length)]);
  const pct = (n) => Math.round(n / total * 1000) / 10;

  const text = {};
  for (const [k, t] of Object.entries(probes.text || {})) {
    let best = -1, bestPx = null;
    const r = t.rect;
    for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(W, r.x + r.w); x++) {
        const px = at(x, y);
        const v = Math.max(px[0], px[1], px[2]);
        if (v > best) { best = v; bestPx = px; }
      }
    }
    text[k] = { peak: best, rgb: bestPx, css: t.color, opacity: t.opacity, font: t.font };
  }

  return {
    frame: {
      min: r1(L[0]), p01: fq(0.01), p05: fq(0.05), p25: fq(0.25), p50: fq(0.5),
      p75: fq(0.75), p95: fq(0.95), p99: fq(0.99), max: r1(L[L.length - 1]),
      // The gate's own metric, in its own words: 20-55% of 255 is 51-140.
      inBand20_55: pct(L.filter((v) => v >= 51 && v <= 140).length),
      below10pct: pct(L.filter((v) => v < 26).length),
      above90pct: pct(L.filter((v) => v > 229).length),
      warmPct: pct(warm), coolPct: pct(cool), saturatedPct: pct(sat),
    },
    deck: summarise(probes.deck),
    deckNearBlock: summarise(probes.deckNearBlock),
    wall: summarise(probes.wall),
    blockTop: summarise(probes.blockTop),
    blockSide: summarise(probes.blockSide),
    hazard: summarise(probes.hazard, (p) => p[0] > p[2] + 20),
    text,
  };
};

async function analyse(browser, png, probes) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('about:blank');
  const out = await page.evaluate(ANALYSE_FN, {
    dataUri: 'data:image/png;base64,' + png.toString('base64'), probes,
  });
  await ctx.close();
  return out;
}

/* ------------------------------------------------------------------------- */

async function boot(browser) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
  await page.evaluate((t) => {
    const q = window.__game.engine.quality;
    q.auto = false; q.setTier(t);
  }, TIER);
  await page.waitForTimeout(400);
  return { context, page, errors };
}

async function runMatch(browser, name) {
  const { context, page, errors } = await boot(browser);
  // A fixed seed, because startMatch defaults to Math.random() and every run
  // otherwise measures a different fight. That is what made small changes look
  // like noise and noise look like changes.
  await page.evaluate(({ id, seed }) => {
    const g = window.__game;
    g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
    g.setDemo(true);
  }, { id: ARENA_OF[name] || 'grid', seed: 1234567 });
  await page.waitForTimeout(1000);

  // Deterministic advance. Three things had to be closed before capture A was
  // repeatable at all: the match seed (above), the engine running free between
  // slices so the demo AI played a load-dependent number of ticks, and
  // `fastForward` advancing the sim without advancing `engine.clock.elapsed` —
  // the clock every effect ages against — so the effects in frame A were
  // whatever the screenshot's own latency made them. The camera rig is then
  // settled on a fixed delta, and onRender detached, because `paused` gates
  // only the sim: the engine keeps calling onRender with the real wall-clock
  // delta, so the view went on integrating throughout a multi-second capture.
  await page.evaluate((n) => {
    const g = window.__game;
    const TICK = 1 / 60;
    g.engine.paused = true;
    for (let i = 0; i < n; i++) {
      g.fastForward(1);
      if (g.engine.clock) g.engine.clock.elapsed += TICK;
    }
    if (g.rig && g.world && g.view) {
      let t = (g.engine.clock && g.engine.clock.elapsed) || 0;
      for (let i = 0; i < 240; i++) {
        const views = g.view.prepare(1);
        g.rig.update(g.world, views, g.localIndex, TICK, t);
        t += TICK;
      }
      g.view.update(0, 1, t);
    }
    g.engine.onRender = null;
    if (g.engine.quality) g.engine.quality.auto = false;
  }, TICKS);
  await page.waitForTimeout(500);

  const probes = await page.evaluate(PROBE_FN);

  // A — as shipped.
  const A = await page.screenshot({ timeout: 180000 });

  // B — DOM layers removed, camera and sim untouched.
  await page.evaluate(() => {
    window.__game.engine.paused = true;
    for (const id of ['ui-layer', 'hud-layer', 'splash']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
  });
  await page.waitForTimeout(600);
  const B = await page.screenshot({ timeout: 180000 });

  // C — VFX suppressed too, so an additive beam over the deck is not counted
  //     as the deck.
  // VFX objects are parented straight to the scene rather than to a group, so
  // "not the stage and not a robot" is the only reliable way to name them.
  await page.evaluate(() => {
    const v = window.__game.view;
    const keep = new Set([v.stage.group, ...v.models.map((m) => m.group), ...v.blobs]);
    for (const o of v.scene.children) {
      if (keep.has(o) || o.isLight || o.isCamera) continue;
      o.visible = false;
    }
    for (const k of ['motes', 'shafts', 'sweep']) if (v.stage[k]) v.stage[k].visible = false;
  });
  await page.waitForTimeout(600);
  const C = await page.screenshot({ timeout: 180000 });

  await context.close();
  return { name, probes, A, B, C, errors };
}

async function runMenu(browser) {
  const { context, page, errors } = await boot(browser);
  await page.waitForTimeout(2000);
  const probes = await page.evaluate(PROBE_FN);
  const A = await page.screenshot({ timeout: 180000 });
  await context.close();
  return { probes, A, errors };
}

const pad = (v, n = 6) => String(v).padStart(n);
function line(label, s) {
  if (!s) return `  ${label.padEnd(12)} — no visible samples`;
  return `  ${label.padEnd(12)} n=${pad(s.n, 5)}  min=${pad(s.min)}  p05=${pad(s.p05)}  ` +
    `med=${pad(s.p50)}  p95=${pad(s.p95)}  max=${pad(s.max)}` +
    `\n${''.padEnd(16)}darkest  rgb(${s.darkest.rgb.join(',')}) @${s.darkest.x},${s.darkest.y}` +
    `   brightest rgb(${s.brightest.rgb.join(',')}) @${s.brightest.x},${s.brightest.y}`;
}

async function main() {
  const pinned = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(pinned) ? pinned : undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
  });

  if (flag('menu')) {
    const m = await runMenu(browser);
    const a = await analyse(browser, m.A, m.probes);
    console.log('\n============ TITLE / MENU STATE (nothing dimming it) ============');
    console.log('  DOM text peaks:', JSON.stringify(a.text, null, 0));
    console.log('  frame:', JSON.stringify(a.frame));
    if (m.probes.dimmers?.length) {
      console.log('  full-viewport elements:');
      for (const x of m.probes.dimmers) console.log('   ', JSON.stringify(x));
    }
    if (m.errors.length) console.log('  page errors:', m.errors.slice(0, 5));
  }

  for (const name of String(flag('shots', 'fight')).split(',').map((s) => s.trim()).filter(Boolean)) {
    const r = await runMatch(browser, name);
    if (flag('save')) {
      mkdirSync('shots', { recursive: true });
      writeFileSync(`shots/meas-${name}.png`, r.A);
      writeFileSync(`shots/meas-${name}-bare.png`, r.C);
    }
    const A = await analyse(browser, r.A, r.probes);
    const B = await analyse(browser, r.B, r.probes);
    const C = await analyse(browser, r.C, r.probes);

    console.log(`\n============ ${name.toUpperCase()} (${ARENA_OF[name]}) ============`);
    console.log('-- A: as shipped (DOM on, VFX on) --');
    console.log(line('DECK', A.deck));
    console.log(line('WALL', A.wall));
    console.log('  frame:', JSON.stringify(A.frame));
    console.log('  DOM text peaks:', JSON.stringify(A.text));

    console.log('-- B: DOM layers display:none (same 3D frame) --');
    console.log(line('DECK', B.deck));
    console.log(line('WALL', B.wall));
    console.log('  frame:', JSON.stringify(B.frame));

    console.log('-- C: DOM off + VFX off — the stage\'s own values --');
    console.log(line('DECK', C.deck));
    console.log(line('deck@block', C.deckNearBlock));
    console.log(line('WALL', C.wall));
    console.log(line('BLOCK top', C.blockTop));
    console.log(line('BLOCK side', C.blockSide));
    console.log(line('HAZARD', C.hazard));
    console.log('  frame:', JSON.stringify(C.frame));

    console.log('  render:', JSON.stringify(r.probes.stats));
    console.log('  stage build ms:', JSON.stringify(r.probes.stageBuildMs));
    if (r.probes.dimmers?.length) {
      console.log('  full-viewport DOM elements over the match:');
      for (const x of r.probes.dimmers) console.log('   ', JSON.stringify(x));
    }
    if (r.errors.length) console.log('  page errors:', r.errors.slice(0, 5));
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
