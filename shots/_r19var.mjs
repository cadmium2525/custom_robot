#!/usr/bin/env node
/**
 * ROUND 19 — where does clause C's per-mass sd actually live?
 *
 *   node shots/_r19var.mjs shots/mass-grid-r1.png
 *
 * WHY THIS FILE EXISTS. `shots/_massdrive.mjs` reports ONE number per machine:
 * the area-weighted per-mass sd of the ORIGINAL luminance. At head that number
 * is 41.17 on grid's near machine against a between-mass step of 20.53, ratio
 * 4.011, FAIL. What it does not say is WHICH pixels carry the 41, and clause C
 * has two completely different failure modes that produce the same headline:
 *
 *   BROAD   a smooth gradient across a big flat plate — a Lambert response, a
 *           gradient inside a face, the thing the clause's hardware fact says
 *           the N64 could not draw. Fixed by geometry: fewer, flatter facets.
 *
 *   FINE    near-black seams and near-white plate edges a couple of pixels
 *           wide, threaded through the middle of what the blur calls one mass.
 *           Fixed by paint and by plate layout, NOT by facet count — flattening
 *           a facet does nothing to a black line drawn across it.
 *
 * Round 18's verdict assigned the whole 4.06 to the first ("the Lambert response
 * of a body with too many facets... a modelling problem") on an inference from
 * the size-scaling, never on a decomposition. This decomposes it.
 *
 * METHOD, and it deliberately adds no capture of its own. `tools/mass.mjs
 * --dump` already writes a three-panel contact sheet per machine at Z=1 for a
 * body taller than 220px:
 *
 *     [ crop as photographed | masked blur | bands @51 in false colour ]
 *
 * The SECOND panel is the masked blur the meter segments, written as 8-bit grey,
 * and the FIRST is the original luminance the meter takes sd on. So the whole
 * segmentation can be re-run offline on the meter's own two arrays, with no
 * second frame and no second settle.
 *
 * IT MUST RE-RUN THE SEGMENTATION, NOT READ THE THIRD PANEL. The bands panel is
 * drawn at PHASE 0 only, while `regionsAt` averages the count and every figure
 * derived from it over FOUR quantisation phases (0, .25, .5, .75 of the step) —
 * a deliberate anti-lottery measure in the stock meter. Reading the drawn bands
 * therefore reproduces one phase out of four and inflates the answer badly: at
 * phase 0 a single region swallows 76% of grid's near machine and its sd is
 * 57.4, against the meter's four-phase 41.17. The first version of this file did
 * exactly that, and it is recorded here because the number it printed looked
 * entirely plausible. Four phases, area-weighted, is the meter, and the check
 * that it IS the meter is that the total sd reproduces _massdrive's figure.
 *
 * Per mass it splits L into LOW (a masked Gaussian, sigma set by --lo, default
 * 3px) and HIGH (the residual), and reports
 *
 *     sd        total, which must reproduce _massdrive's figure
 *     sdLow     the broad part — gradients across the plate
 *     sdHigh    the fine part — seams, edges, greeble seams, the outline
 *     hi%       sdHigh^2 / sd^2, the share of the VARIANCE that is fine detail
 *
 * Variance adds, sd does not, so the share is quoted on variance. LOW and HIGH
 * are orthogonal by construction only when the blur is a projection; a Gaussian
 * is not exactly one, so sdLow^2 + sdHigh^2 is printed beside sd^2 and any run
 * where they disagree by more than 5% is flagged rather than quietly reported.
 *
 * The blur is MASKED — background pixels are excluded from the kernel weight,
 * exactly as tools/mass.mjs does it — because otherwise the #202024 backdrop
 * bleeds across the silhouette and invents a fake gradient in the outermost
 * 3px of every mass, which is where a lot of this body's contrast already is.
 *
 * NOT A METER FOR THE CARD. It scores no clause and no threshold. It is an
 * attribution instrument, and every figure it prints names sd, never ratio,
 * because the ratio belongs to _massdrive.mjs and no figure may cross two
 * meters.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const FILES = args.filter((a) => !a.startsWith('--') && a.endsWith('.png'));
const LO = Number(flag('lo', 3));
const FLOOR = Number(flag('floor', 0.03));
/** The clause's operating point. 51 = the "five value bands" the rule names. */
const STEP = Number(flag('step', 51));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

if (!FILES.length) {
  console.error('usage: node shots/_r19var.mjs shots/mass-grid-r1.png [--lo 3] [--floor 0.03]');
  process.exit(2);
}

/**
 * Runs in the page. Takes the contact sheet as a data URI and returns the
 * decomposition. Passed as a FUNCTION, not as a template string, so that no
 * backtick or comment terminator ever has to live inside a literal — house
 * rule 2, learned four times.
 */
const ANALYSE = async ({ uri, lo, floor, step }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
  const W = img.width, H = img.height;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;

  // Panel geometry, from tools/mass.mjs: width = bw*Z*3 + 24, two 12px gutters.
  // Z is 1 for any body taller than 220px; solve for bw and assert it is whole.
  const bw = (W - 24) / 3;
  if (!Number.isInteger(bw)) return { err: 'sheet width ' + W + ' is not bw*3+24 — Z is not 1, re-dump a taller body' };
  const bh = H;
  const P0 = 0, P1 = bw + 12;   // crop panel, masked-blur panel

  const lum = (o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
  // Background of the sheet, painted by mass.mjs before anything else. The blur
  // panel is pure grey (v,v,v), so r===b there and the 32/32/36 test is exact.
  const isBg = (o) => d[o] === 32 && d[o + 1] === 32 && d[o + 2] === 36;

  const mask = new Uint8Array(bw * bh);
  const shell = new Uint8Array(bw * bh);
  const L = new Float32Array(bw * bh);
  const BL = new Float32Array(bw * bh);
  let area = 0, body = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      const ob = ((y) * W + (P1 + x)) * 4;
      const oc = ((y) * W + (P0 + x)) * 4;
      // The CROP panel is painted only on the machine's own stencil; the BLUR
      // panel is painted wherever the blur's weight survived, which is a
      // different and larger set. The gap between them is the finding below.
      if (!isBg(oc)) { shell[i] = 1; body++; }
      if (isBg(ob)) continue;
      mask[i] = 1; area++;
      L[i] = lum(oc);
      BL[i] = d[ob];
    }
  }
  if (!area) return { err: 'no masked pixels found in the blur panel' };

  // Masked separable box-blur x3 ~= Gaussian, background excluded from weight.
  const boxR = Math.max(1, Math.round(lo * 1.2));
  let num = new Float32Array(bw * bh), den = new Float32Array(bw * bh);
  for (let i = 0; i < bw * bh; i++) { num[i] = mask[i] ? L[i] : 0; den[i] = mask[i] ? 1 : 0; }
  const pass = (r, horiz) => {
    const n2 = new Float32Array(bw * bh), d2 = new Float32Array(bw * bh);
    const outer = horiz ? bh : bw, inner = horiz ? bw : bh;
    for (let a = 0; a < outer; a++) {
      let sn = 0, sd2 = 0;
      const at = (b) => (horiz ? a * bw + b : b * bw + a);
      for (let b = -r; b <= r; b++) { const q = Math.min(inner - 1, Math.max(0, b)); sn += num[at(q)]; sd2 += den[at(q)]; }
      for (let b = 0; b < inner; b++) {
        n2[at(b)] = sn; d2[at(b)] = sd2;
        const add = Math.min(inner - 1, b + r + 1), sub = Math.max(0, b - r);
        sn += num[at(add)] - num[at(sub)];
        sd2 += den[at(add)] - den[at(sub)];
      }
    }
    num = n2; den = d2;
  };
  for (let k = 0; k < 3; k++) { pass(boxR, true); pass(boxR, false); }
  const LOW = new Float32Array(bw * bh);
  for (let i = 0; i < bw * bh; i++) LOW[i] = den[i] > 0 ? num[i] / den[i] : 0;

  /**
   * One quantisation phase: flood fill the blur into bands, then take per-region
   * moments on L, on LOW and on the residual. Identical flood fill to
   * `regionsAtPhase` in tools/mass.mjs, 4-neighbour, on floor((v+phase)/step).
   */
  const stack = new Int32Array(bw * bh);
  const atPhase = (phase) => {
    const bandOf = new Int32Array(bw * bh).fill(-999);
    for (let i = 0; i < bw * bh; i++) if (mask[i]) bandOf[i] = Math.floor((BL[i] + phase) / step);
    const comp = new Int32Array(bw * bh).fill(-1);
    const sizes = [];
    for (let s = 0; s < bw * bh; s++) {
      if (bandOf[s] === -999 || comp[s] >= 0) continue;
      const id = sizes.length, c = bandOf[s];
      let sp = 0, n = 0;
      stack[sp++] = s; comp[s] = id;
      while (sp > 0) {
        const p = stack[--sp]; n++;
        const px = p % bw, py = (p / bw) | 0;
        if (px > 0 && comp[p - 1] < 0 && bandOf[p - 1] === c) { comp[p - 1] = id; stack[sp++] = p - 1; }
        if (px + 1 < bw && comp[p + 1] < 0 && bandOf[p + 1] === c) { comp[p + 1] = id; stack[sp++] = p + 1; }
        if (py > 0 && comp[p - bw] < 0 && bandOf[p - bw] === c) { comp[p - bw] = id; stack[sp++] = p - bw; }
        if (py + 1 < bh && comp[p + bw] < 0 && bandOf[p + bw] === c) { comp[p + bw] = id; stack[sp++] = p + bw; }
      }
      sizes.push(n);
    }
    const nR = sizes.length;
    const acc = () => ({ s: new Float64Array(nR), q: new Float64Array(nR) });
    const A = acc(), B = acc(), C = acc();
    const cnt = new Float64Array(nR);
    for (let i = 0; i < bw * bh; i++) {
      const id = comp[i];
      if (id < 0) continue;
      const a = L[i], b = LOW[i], c = a - b;
      cnt[id]++;
      A.s[id] += a; A.q[id] += a * a;
      B.s[id] += b; B.q[id] += b * b;
      C.s[id] += c; C.q[id] += c * c;
    }
    const sdOf = (o, id) => {
      const n = cnt[id] || 1, m = o.s[id] / n;
      return Math.sqrt(Math.max(0, o.q[id] / n - m * m));
    };
    const big = [];
    for (let r = 0; r < nR; r++) {
      if (sizes[r] / area < floor) continue;
      big.push({
        size: sizes[r], share: sizes[r] / area,
        mean: A.s[r] / (cnt[r] || 1),
        sd: sdOf(A, r), sdLow: sdOf(B, r), sdHigh: sdOf(C, r),
      });
    }
    big.sort((p, q) => q.size - p.size);
    let w = 0, wsd = 0, wlo = 0, whi = 0;
    for (const r of big) { w += r.size; wsd += r.sd * r.size; wlo += r.sdLow * r.size; whi += r.sdHigh * r.size; }
    return {
      regions: nR, big,
      sd: w ? wsd / w : 0, sdLow: w ? wlo / w : 0, sdHigh: w ? whi / w : 0,
    };
  };

  // The stock meter's four phases, averaged exactly as `regionsAt` averages.
  const runs = [0, 0.25, 0.5, 0.75].map((f) => atPhase(f * step));
  const mean = (k) => runs.reduce((a, r) => a + r[k], 0) / runs.length;
  return {
    bw, bh, area, body, boxR, step,
    regions: Math.round(mean('regions') * 10) / 10,
    nbig: Math.round((runs.reduce((a, r) => a + r.big.length, 0) / runs.length) * 10) / 10,
    phase0: runs[0].big,
    sd: mean('sd'), sdLow: mean('sdLow'), sdHigh: mean('sdHigh'),
    perPhase: runs.map((r) => ({ sd: r.sd, sdLow: r.sdLow, sdHigh: r.sdHigh, n: r.big.length })),
  };
};

(async () => {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const page = await (await browser.newContext()).newPage();
  await page.goto('about:blank');
  for (const f of FILES) {
    const uri = 'data:image/png;base64,' + readFileSync(f).toString('base64');
    const out = await page.evaluate(ANALYSE, { uri, lo: LO, floor: FLOOR, step: STEP });
    console.log('\n' + f);
    if (out.err) { console.log('  ERROR: ' + out.err); continue; }
    console.log('  bbox ' + out.bw + 'x' + out.bh + '   stencil ' + out.body + ' px   segmented ' + out.area + ' px  (+' + (((out.area/out.body)-1)*100).toFixed(1) + '% NOT ON THE MACHINE)');
    console.log('  ' + out.regions +
      ' regions, ' + out.nbig + ' above the ' + (FLOOR * 100) + '% floor, step ' + out.step +
      ', 4 phases');
    console.log('  low-pass sigma ~' + LO + 'px (box radius ' + out.boxR + ' x3)');
    console.log('  per-mass, PHASE 0 ONLY (the phases have different regions, so only');
    console.log('  the area-weighted total below is comparable with _massdrive.mjs):');
    console.log('    share%   mean     sd   sdLow  sdHigh   hi% of variance');
    for (const r of out.phase0) {
      const v = r.sd * r.sd || 1;
      const hi = (r.sdHigh * r.sdHigh / v) * 100;
      const sum = (r.sdLow * r.sdLow + r.sdHigh * r.sdHigh) / v;
      const warn = Math.abs(sum - 1) > 0.05 ? '  [split ' + (sum * 100).toFixed(0) + '% of variance — not orthogonal]' : '';
      console.log('   ' + (r.share * 100).toFixed(1).padStart(6) +
        r.mean.toFixed(1).padStart(8) +
        r.sd.toFixed(2).padStart(8) +
        r.sdLow.toFixed(2).padStart(8) +
        r.sdHigh.toFixed(2).padStart(8) +
        (hi).toFixed(0).padStart(8) + '%' + warn);
    }
    const V = out.sd * out.sd || 1;
    console.log('  AREA-WEIGHTED  sd ' + out.sd.toFixed(2) +
      '   sdLow ' + out.sdLow.toFixed(2) +
      '   sdHigh ' + out.sdHigh.toFixed(2) +
      '   fine detail = ' + ((out.sdHigh * out.sdHigh / V) * 100).toFixed(0) + '% of the variance');
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
