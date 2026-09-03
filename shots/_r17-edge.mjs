#!/usr/bin/env node
/**
 * EDGE-HARDNESS METER for the explosion. "Hard-edged" made into a number.
 *
 * Blind point 5 asks for effects that are *enormous, hard-edged and drawn*, and
 * for five rounds it has been scored by looking at pictures. RULING 3 failed it
 * on a description — "every boundary is a gradient falloff" — which is a real
 * observation and an unfalsifiable one. This turns it into a measurement with a
 * unit: **the 10-90 transition width of the effect's own boundary, in pixels**,
 * against the same pipeline's hard-edge floor measured by the same code.
 *
 *   node shots/_r17-edge.mjs --prefix shots/r17h
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING MEASURED, AND WHY IT IS A SUBTRACTION
 * ---------------------------------------------------------------------------
 * `_r17-blast.mjs` writes, from ONE frozen frame, the frame with the effects
 * layer on (`-raw`), the same frame with it off (`-novfx`), and a white-on-black
 * stencil of the machines (`-mach`). So the effect's own contribution is
 *
 *   C(x,y) = | luma(raw) - luma(novfx) |          0..255
 *
 * exactly — no colour key, no hand-drawn rectangle, and nothing in it that the
 * effect did not put there. Every figure below is computed on C or on the raw
 * frame restricted to C.
 *
 * ---------------------------------------------------------------------------
 * THE EDGE METER
 * ---------------------------------------------------------------------------
 * Rays are cast from the blast's projected centre — 720 of them, sampled
 * bilinearly every 0.25px. On each ray:
 *
 *   r50   the OUTERMOST radius at which C falls through half of that ray's own
 *         maximum. That is the silhouette: the last thing the eye sees going
 *         outward, and the boundary the complaint is about.
 *   hi    max C over [r50-W, r50]     (inside the boundary)
 *   lo    min C over [r50, r50+W]     (outside it)
 *   width the distance from the last radius at or above lo+0.9(hi-lo) to the
 *         first at or below lo+0.1(hi-lo). The standard 10-90 edge width.
 *
 * A hard alpha cutoff lands at 1-2px, which is the renderer's own floor after
 * FXAA. A gradient falloff lands in the tens. The distribution is reported, not
 * the mean, because an effect can have one drawn ring and a cloud behind it and
 * the average of those is a number describing neither.
 *
 * The floor is measured, not assumed: the SAME ray code is run over the machine
 * stencil, whose edge is the hardest this pipeline can draw. Any claim about
 * the blast's edge is a claim relative to that number, printed beside it.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER FOUR COLUMNS
 * ---------------------------------------------------------------------------
 *  * CORE. Mean sRGB and HSV of the hottest 5% of the effect's pixels, and of a
 *    disc at the blast centre. "Brown-maroon mud" and "hot white-to-yellow
 *    centre" are different points in HSV and the difference is decidable: mud is
 *    hue 10-40 with V below about 0.65 and S above 0.55; a hot core is V above
 *    0.9 with S below about 0.4.
 *  * COVERAGE. Fraction of the frame with C above the noise floor, and the
 *    noise floor itself, measured as the 99.9th percentile of C over the
 *    quarter of the frame furthest from the blast.
 *  * OCCLUSION. For each machine's stencil component: the contour step (mean
 *    luma inside minus outside over a 7x7 window on the boundary, exactly
 *    contour.mjs's construction, recomputed here so this is a within-tool
 *    before/after) with the blast on and with it off. A machine the blast has
 *    erased loses its step. Also the fraction of its pixels the effect moved by
 *    more than 25 and more than 60 levels.
 *  * BRIGHTEST 1%. Who owns it, blast on versus blast off, on the same frame.
 *    The definition — luma, chroma (max-min)/255, sat>=0.35, cyan h165-200,
 *    amber h20-55, machine pixels from the stencil — is copied from
 *    `shots/_salience.mjs`'s `hot` block so it means the same thing.
 *
 *    NAMING THE METER, per the standing rule: these are THIS FILE's numbers.
 *    `_salience.mjs` is the authority for salience and coverage and its figures
 *    are taken on its own pinned frame at tick 420 with no blast in it; nothing
 *    here may be subtracted from anything there. What makes the point-2 claim
 *    below sound is that the before and the after are the SAME FRAME measured
 *    by the SAME code, which is a stronger comparison than either tool could
 *    make against the other.
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PREFIX = flag('prefix', 'shots/r17h');
const OUT = flag('out', `${PREFIX}-edge.txt`);
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const meta = JSON.parse(readFileSync(`${PREFIX}-meta.json`, 'utf8'));

// ---------------------------------------------------------------------------
// Everything below runs in a throwaway page, which is how every other analysis
// tool in this directory decodes a PNG: there is no image decoder in node here
// and adding a dependency to read three files is not worth it.
// ---------------------------------------------------------------------------

const ANALYSE = async ({ rawUri, novfxUri, machUri, cx, cy }) => {
  const load = async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const RAW = await load(rawUri);
  const NO = await load(novfxUri);
  const MA = await load(machUri);
  const W = RAW.W, H = RAW.H, NP = W * H;
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  const Lraw = new Float32Array(NP);
  const Lno = new Float32Array(NP);
  const C = new Float32Array(NP);
  const mask = new Uint8Array(NP);          // machines, from the stencil
  for (let p = 0, i = 0; p < NP; p++, i += 4) {
    Lraw[p] = lum(RAW.d, i);
    Lno[p] = lum(NO.d, i);
    C[p] = Math.abs(Lraw[p] - Lno[p]);
    if (lum(MA.d, i) > 128) mask[p] = 1;
  }

  // --- noise floor -------------------------------------------------------
  // Measured, not assumed: the 99.9th percentile of C over every pixel more
  // than 40% of the frame diagonal from the blast. Whatever is there is not the
  // blast, so anything at or below it cannot be counted as the blast either.
  const diag = Math.hypot(W, H);
  const far = [];
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (Math.hypot(x - cx, y - cy) < diag * 0.40) continue;
      far.push(C[y * W + x]);
    }
  }
  far.sort((a, b) => a - b);
  const noise = far.length ? far[Math.floor(far.length * 0.999)] : 0;
  const T = Math.max(6, noise * 1.5);

  let cover = 0;
  for (let p = 0; p < NP; p++) if (C[p] > T) cover++;

  // --- ray edge meter ----------------------------------------------------
  const bilinear = (F, x, y) => {
    if (x < 0 || y < 0 || x > W - 2 || y > H - 2) return 0;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, p = y0 * W + x0;
    return (F[p] * (1 - fx) + F[p + 1] * fx) * (1 - fy)
         + (F[p + W] * (1 - fx) + F[p + W + 1] * fx) * fy;
  };

  const RSTEP = 0.25, RMAX = Math.round(diag * 0.55), WIN = 48;
  const rays = (F, ox, oy, minPeak) => {
    const widths = [], slopes = [], radii = [];
    const N = 720;
    const prof = new Float32Array(Math.ceil(RMAX / RSTEP) + 1);
    for (let k = 0; k < N; k++) {
      const a = k / N * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      let peak = 0, n = 0;
      for (let r = 0; r <= RMAX; r += RSTEP) {
        const v = bilinear(F, ox + dx * r, oy + dy * r);
        prof[n++] = v;
        if (v > peak) peak = v;
      }
      if (peak < minPeak) continue;
      // Outermost fall through half the ray's own maximum.
      const half = peak * 0.5;
      let i50 = -1;
      for (let i = n - 2; i >= 1; i--) {
        if (prof[i] >= half && prof[i + 1] < half) { i50 = i; break; }
      }
      if (i50 < 0) continue;
      const wi = Math.round(WIN / RSTEP);
      let hi = 0, lo = 1e9;
      for (let i = Math.max(0, i50 - wi); i <= i50; i++) if (prof[i] > hi) hi = prof[i];
      for (let i = i50; i < Math.min(n, i50 + wi); i++) if (prof[i] < lo) lo = prof[i];
      const amp = hi - lo;
      if (amp < 12) continue;                  // no edge here worth measuring
      const a90 = lo + amp * 0.9, a10 = lo + amp * 0.1;
      let iA = i50, iB = i50;
      for (let i = i50; i >= Math.max(0, i50 - wi); i--) { if (prof[i] >= a90) { iA = i; break; } iA = i; }
      for (let i = i50; i < Math.min(n, i50 + wi); i++) { if (prof[i] <= a10) { iB = i; break; } iB = i; }
      widths.push((iB - iA) * RSTEP);
      // Equivalent slope width: amplitude divided by the steepest local slope
      // across the boundary. Immune to a single noisy sample in a way the
      // crossing pair is not, and it agrees with it on a clean edge.
      let ms = 0;
      for (let i = Math.max(1, i50 - 8); i < Math.min(n - 1, i50 + 8); i++) {
        const s = Math.abs(prof[i + 1] - prof[i]) / RSTEP;
        if (s > ms) ms = s;
      }
      if (ms > 0) slopes.push(amp / ms);
      radii.push(i50 * RSTEP);
    }
    const stat = (arr) => {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      const q = (f) => Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 100) / 100;
      const frac = (t) => Math.round(s.filter((v) => v <= t).length / s.length * 1000) / 10;
      return {
        n: s.length, p10: q(0.1), median: q(0.5), p90: q(0.9),
        mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length * 100) / 100,
        under2: frac(2), under4: frac(4), under8: frac(8), over20: Math.round((100 - frac(20)) * 10) / 10,
      };
    };
    return { width: stat(widths), slope: stat(slopes), radius: stat(radii) };
  };

  const blastEdge = rays(C, cx, cy, Math.max(24, T * 3));

  // --- the pipeline's own hard-edge floor --------------------------------
  // The same ray code over the machine stencil. Nothing this renderer draws can
  // have a harder edge than a flat white body on black after FXAA, so this is
  // the number the blast's edge has to be read against.
  const comps = [];
  {
    const comp = new Int32Array(NP).fill(-1);
    const stack = new Int32Array(NP);
    for (let p = 0; p < NP; p++) {
      if (!mask[p] || comp[p] >= 0) continue;
      const id = comps.length;
      let sp = 0, n = 0, sx = 0, sy = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
      stack[sp++] = p; comp[p] = id;
      while (sp) {
        const q = stack[--sp], qx = q % W, qy = (q / W) | 0;
        n++; sx += qx; sy += qy;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
        if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        if (qx > 0 && mask[q - 1] && comp[q - 1] < 0) { comp[q - 1] = id; stack[sp++] = q - 1; }
        if (qx < W - 1 && mask[q + 1] && comp[q + 1] < 0) { comp[q + 1] = id; stack[sp++] = q + 1; }
        if (qy > 0 && mask[q - W] && comp[q - W] < 0) { comp[q - W] = id; stack[sp++] = q - W; }
        if (qy < H - 1 && mask[q + W] && comp[q + W] < 0) { comp[q + W] = id; stack[sp++] = q + W; }
      }
      comps.push({ id, n, cx: sx / n, cy: sy / n, x0, x1, y0, y1 });
    }
    comps.sort((a, b) => b.n - a.n);
  }
  const bodies = comps.filter((c) => c.n >= 300 && (c.y1 - c.y0) >= 16).slice(0, 2);
  const Lmask = new Float32Array(NP);
  for (let p = 0; p < NP; p++) Lmask[p] = mask[p] ? 255 : 0;
  const floor = bodies.length ? rays(Lmask, bodies[0].cx, bodies[0].cy, 100) : null;

  // --- core colour -------------------------------------------------------
  const hsv = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h: Math.round(h), s: mx ? Math.round(d / mx * 1000) / 1000 : 0, v: Math.round(mx / 255 * 1000) / 1000 };
  };
  const meanOf = (pixels) => {
    if (!pixels.length) return null;
    let r = 0, g = 0, b = 0;
    for (const p of pixels) { r += RAW.d[p * 4]; g += RAW.d[p * 4 + 1]; b += RAW.d[p * 4 + 2]; }
    const n = pixels.length;
    r /= n; g /= n; b /= n;
    return { n, rgb: [Math.round(r), Math.round(g), Math.round(b)], ...hsv(r, g, b) };
  };
  // Hottest 5% of the effect's pixels, by the luminance they ended up at.
  const fx = [];
  for (let p = 0; p < NP; p++) if (C[p] > T) fx.push(p);
  fx.sort((a, b) => Lraw[b] - Lraw[a]);
  const core = meanOf(fx.slice(0, Math.max(1, Math.round(fx.length * 0.05))));
  const whole = meanOf(fx);
  // A disc at the blast's own centre, 24px, which is where a "hot centre" would
  // be if there were one.
  const disc = [];
  for (let y = Math.max(0, cy - 24 | 0); y < Math.min(H, cy + 24); y++) {
    for (let x = Math.max(0, cx - 24 | 0); x < Math.min(W, cx + 24); x++) {
      if (Math.hypot(x - cx, y - cy) <= 24) disc.push(y * W + x);
    }
  }
  const centre = meanOf(disc);

  // --- occlusion ---------------------------------------------------------
  // contour.mjs's construction, recomputed here on both passes of the same
  // frame, so the before and the after come off one meter.
  const step = (L, only, compArr) => {
    const R = 3, steps = [];
    for (let y = R; y < H - R; y++) {
      for (let x = R; x < W - R; x++) {
        const p = y * W + x;
        if (!mask[p]) continue;
        if (compArr[p] !== only) continue;
        if (mask[p - 1] && mask[p + 1] && mask[p - W] && mask[p + W]) continue;
        let iS = 0, iN = 0, oS = 0, oN = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const q = p + dy * W + dx;
            if (mask[q]) { iS += L[q]; iN++; } else { oS += L[q]; oN++; }
          }
        }
        if (iN < 5 || oN < 5) continue;
        steps.push(Math.abs(iS / iN - oS / oN));
      }
    }
    if (!steps.length) return null;
    steps.sort((a, b) => a - b);
    return {
      n: steps.length,
      median: Math.round(steps[steps.length >> 1] * 10) / 10,
      mean: Math.round(steps.reduce((a, b) => a + b, 0) / steps.length * 10) / 10,
      under12: Math.round(steps.filter((s) => s < 12).length / steps.length * 1000) / 10,
    };
  };
  // Recompute the component map (the one above went out of scope with its ids).
  const compMap = new Int32Array(NP).fill(-1);
  {
    const stack = new Int32Array(NP);
    let id = 0;
    const order = [];
    for (let p = 0; p < NP; p++) {
      if (!mask[p] || compMap[p] >= 0) continue;
      let sp = 0, n = 0, sx = 0, sy = 0, y0 = H, y1 = 0;
      stack[sp++] = p; compMap[p] = id;
      while (sp) {
        const q = stack[--sp], qx = q % W, qy = (q / W) | 0;
        n++; sx += qx; sy += qy;
        if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        if (qx > 0 && mask[q - 1] && compMap[q - 1] < 0) { compMap[q - 1] = id; stack[sp++] = q - 1; }
        if (qx < W - 1 && mask[q + 1] && compMap[q + 1] < 0) { compMap[q + 1] = id; stack[sp++] = q + 1; }
        if (qy > 0 && mask[q - W] && compMap[q - W] < 0) { compMap[q - W] = id; stack[sp++] = q - W; }
        if (qy < H - 1 && mask[q + W] && compMap[q + W] < 0) { compMap[q + W] = id; stack[sp++] = q + W; }
      }
      order.push({ id, n, cx: sx / n, cy: sy / n, h: y1 - y0 });
      id++;
    }
    order.sort((a, b) => b.n - a.n);
    var machines = order.filter((c) => c.n >= 300 && c.h >= 16).slice(0, 2);
  }
  const occl = machines.map((m) => {
    let moved25 = 0, moved60 = 0, n = 0;
    for (let p = 0; p < NP; p++) {
      if (compMap[p] !== m.id) continue;
      n++;
      if (C[p] > 25) moved25++;
      if (C[p] > 60) moved60++;
    }
    return {
      px: m.n, cx: Math.round(m.cx), cy: Math.round(m.cy), heightPx: m.h,
      moved25: Math.round(moved25 / n * 1000) / 10,
      moved60: Math.round(moved60 / n * 1000) / 10,
      stepWith: step(Lraw, m.id, compMap),
      stepWithout: step(Lno, m.id, compMap),
    };
  });

  // --- brightest 1%, blast on and blast off ------------------------------
  const hot = (L, d) => {
    const s = Float32Array.from(L).sort();
    const thr = s[Math.floor(NP * 0.99)];
    let n = 0, mach = 0, cyan = 0, amber = 0, effect = 0;
    for (let p = 0; p < NP; p++) {
      if (L[p] < thr) continue;
      n++;
      if (C[p] > T) effect++;
      if (mask[p]) { mach++; continue; }
      const i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      if (sat < 0.35) continue;
      let h = 0; const dd = mx - mn;
      if (dd > 0) {
        if (mx === r) h = ((g - b) / dd) % 6; else if (mx === g) h = (b - r) / dd + 2; else h = (r - g) / dd + 4;
        h *= 60; if (h < 0) h += 360;
      }
      if (h >= 165 && h <= 200) cyan++; else if (h >= 20 && h <= 55) amber++;
    }
    return {
      threshold: Math.round(thr * 10) / 10,
      machines: Math.round(mach / n * 1000) / 10,
      effect: Math.round(effect / n * 1000) / 10,
      cyan: Math.round(cyan / n * 1000) / 10,
      amber: Math.round(amber / n * 1000) / 10,
    };
  };
  // Mean chroma of the effect's pixels against the machines', which is the
  // "most saturated object in the frame" half of point 2.
  const chromaOf = (pred) => {
    let n = 0, s = 0, l = 0;
    for (let p = 0; p < NP; p++) {
      if (!pred(p)) continue;
      const i = p * 4, r = RAW.d[i], g = RAW.d[i + 1], b = RAW.d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      n++; s += mx ? (mx - mn) / mx : 0; l += Lraw[p];
    }
    return n ? { n, sat: Math.round(s / n * 1000) / 1000, lum: Math.round(l / n * 10) / 10 } : null;
  };

  return {
    size: `${W}x${H}`,
    noise: Math.round(noise * 100) / 100,
    threshold: Math.round(T * 100) / 100,
    coverPct: Math.round(cover / NP * 1000) / 10,
    edge: blastEdge,
    floor,
    core, whole, centre,
    occl,
    hotOn: hot(Lraw, RAW.d),
    hotOff: hot(Lno, NO.d),
    chromaEffect: chromaOf((p) => C[p] > T && !mask[p]),
    chromaMachines: chromaOf((p) => !!mask[p]),
    chromaStage: chromaOf((p) => C[p] <= T && !mask[p]),
  };
};

// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: PINNED,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.goto('about:blank');

const out = [];
const say = (...a) => { const s = a.join(' '); console.log(s); out.push(s); };
const pad = (v, n) => String(v).padStart(n);
const uri = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64');

say(`prefix=${PREFIX}  bundle=${meta.bundle}  tier=${meta.tier}  budget=${meta.particleBudget}`);
say(`seed=${meta.seed} arena=${meta.arena} viewport=${meta.viewport.w}x${meta.viewport.h}`);
say(`blast: tick ${meta.blast.tick} R=${meta.blast.radius} kind=${meta.blast.kind}`);
say('');

const rows = [];
for (const s of meta.shots) {
  const p = String(s.age).padStart(2, '0');
  const f = { raw: `${PREFIX}-a${p}-raw.png`, no: `${PREFIX}-a${p}-novfx.png`, ma: `${PREFIX}-a${p}-mach.png` };
  if (!existsSync(f.raw) || !existsSync(f.no) || !existsSync(f.ma)) { say(`age ${s.age}: missing passes, skipped`); continue; }
  const r = await page.evaluate(ANALYSE, {
    rawUri: uri(f.raw), novfxUri: uri(f.no), machUri: uri(f.ma),
    cx: s.pr.blast.x, cy: s.pr.blast.y,
  });
  rows.push({ age: s.age, ms: s.ms, ...r });
  say(`--- age ${s.age} ticks (${s.ms}ms) --------------------------------------------`);
  say(`  C noise floor ${r.noise}  threshold ${r.threshold}  effect covers ${r.coverPct}% of frame`);
  if (r.edge.width) {
    const w = r.edge.width, sl = r.edge.slope;
    say(`  EDGE 10-90 width px  n=${w.n}  p10 ${w.p10}  median ${w.median}  p90 ${w.p90}   <=2px ${w.under2}%  <=4px ${w.under4}%  >20px ${w.over20}%`);
    say(`  EDGE slope-equiv px            median ${sl ? sl.median : '-'}   outer radius median ${r.edge.radius.median}px`);
  } else say('  EDGE: no measurable boundary');
  if (r.floor && r.floor.width) {
    say(`  FLOOR (machine stencil, same code)  median ${r.floor.width.median}px  p90 ${r.floor.width.p90}px  <=2px ${r.floor.width.under2}%`);
  }
  const c = r.core, ce = r.centre;
  if (c) say(`  CORE hottest 5%: rgb(${c.rgb})  H ${c.h} S ${c.s} V ${c.v}`);
  if (ce) say(`  CENTRE 24px disc: rgb(${ce.rgb})  H ${ce.h} S ${ce.s} V ${ce.v}`);
  for (const m of r.occl) {
    say(`  MACHINE @(${m.cx},${m.cy}) ${m.heightPx}px tall: effect moved ${m.moved25}% of its pixels >25, ${m.moved60}% >60`);
    say(`     contour step  blast ON ${m.stepWith ? m.stepWith.median : '-'}   blast OFF ${m.stepWithout ? m.stepWithout.median : '-'}` +
        `   (invisible contour ${m.stepWith ? m.stepWith.under12 : '-'}% vs ${m.stepWithout ? m.stepWithout.under12 : '-'}%)`);
  }
  say(`  BRIGHTEST 1%  blast ON : machines ${r.hotOn.machines}%  effect ${r.hotOn.effect}%  cyan ${r.hotOn.cyan}%  amber ${r.hotOn.amber}%  (thr ${r.hotOn.threshold})`);
  say(`  BRIGHTEST 1%  blast OFF: machines ${r.hotOff.machines}%  effect ${r.hotOff.effect}%  cyan ${r.hotOff.cyan}%  amber ${r.hotOff.amber}%  (thr ${r.hotOff.threshold})`);
  say(`  CHROMA  effect sat ${r.chromaEffect ? r.chromaEffect.sat : '-'} lum ${r.chromaEffect ? r.chromaEffect.lum : '-'}` +
      `   machines sat ${r.chromaMachines ? r.chromaMachines.sat : '-'} lum ${r.chromaMachines ? r.chromaMachines.lum : '-'}` +
      `   stage sat ${r.chromaStage ? r.chromaStage.sat : '-'} lum ${r.chromaStage ? r.chromaStage.lum : '-'}`);
  say('');
}

say('SUMMARY  (this file is the meter; see the header on why its numbers may not be carried to _salience.mjs)');
say('  age  ms   cover%  edge10-90  floor  coreHSV            hot1% mach  hot1% fx  fx sat');
for (const r of rows) {
  say(`  ${pad(r.age, 3)}  ${pad(r.ms, 4)}  ${pad(r.coverPct, 6)}  ${pad(r.edge.width ? r.edge.width.median : '-', 9)}  ` +
      `${pad(r.floor && r.floor.width ? r.floor.width.median : '-', 5)}  ` +
      `${pad(r.core ? `${r.core.h}/${r.core.s}/${r.core.v}` : '-', 17)}  ` +
      `${pad(r.hotOn.machines, 10)}  ${pad(r.hotOn.effect, 8)}  ${pad(r.chromaEffect ? r.chromaEffect.sat : '-', 6)}`);
}

writeFileSync(OUT, out.join('\n') + '\n');
writeFileSync(OUT.replace(/\.txt$/, '.json'), JSON.stringify({ meta, rows }, null, 2));
console.log(`\nwrote ${OUT}`);
await browser.close();
