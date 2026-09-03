#!/usr/bin/env node
/**
 * THE CHROMA METER — machines against stage, on one photograph, offline.
 *
 * Round 15 closed with a negative result and no instrument to carry it: the
 * figure everyone quotes ("machines 0.324 against a stage at 0.748") came off
 * a TILE in shots/_salience.mjs's top-20 list — a 40px square that happened to
 * be 48% machine — so it is a number about a neighbourhood, not about the
 * machines, and half of what it measures is the deck behind the robot. That is
 * how a paint change can move the paint and not move the number.
 *
 * This reads the same pinned dump pair every other meter reads
 * (`<dir>/<arena>-n.png` + `<dir>/<arena>-mask.png`, from shots/_r15dump.mjs)
 * and reports the machines' pixels and the stage's pixels SEPARATELY, under
 * every colour definition that has been used in this document, because they
 * disagree and the disagreement is the whole reason the last four rounds
 * argued past each other:
 *
 *   chroma  (max-min)/255          — _salience.mjs' definition. Absolute. This
 *                                    is the one the brief is written against.
 *   HSV S   (max-min)/max          — _sal.mjs' "sat". Scale-free, so a near
 *                                    black pixel can score 1.0.
 *   HSL L   (max+min)/2/255        — the term that BINDS chroma: the HSL
 *                                    identity is chroma = (1-|2L-1|) x S, so a
 *                                    surface at L 0.93 cannot exceed 0.14
 *                                    whatever S is set to.
 *   HSL S   chroma/(1-|2L-1|)      — what the paint asked for, recovered.
 *
 * It also prints the CEILING — mean (1 - |2L - 1|) over the machines' pixels —
 * beside the achieved chroma, so "we are at 40% of what this lightness allows"
 * and "we are at the wall" are distinguishable at a glance. Every previous
 * round conflated them.
 *
 * The machines are split by connected component so the near hero and the far
 * opponent are never averaged into one figure: they sit at different sizes,
 * different depths and (since the size gate landed) genuinely different
 * flatten, and a mean over both hides which one moved.
 *
 *   node shots/_r16chroma.mjs <dumpDir> <arena>
 *
 * Force-added under shots/ because shots/ is gitignored and eight agents have
 * lost their instruments to that.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const DIR = args[0], ARENA = args[1];
if (!DIR || !ARENA) { console.error('usage: node shots/_r16chroma.mjs <dumpDir> <arena>'); process.exit(1); }
if (!existsSync(`${DIR}/${ARENA}-n.png`)) { console.error(`no ${DIR}/${ARENA}-n.png`); process.exit(1); }

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--disable-dev-shm-usage'],
});
const page = await (await browser.newContext()).newPage();
await page.goto('about:blank');

const nb = readFileSync(`${DIR}/${ARENA}-n.png`).toString('base64');
const mb = readFileSync(`${DIR}/${ARENA}-mask.png`).toString('base64');

const out = await page.evaluate(async ({ nb, mb }) => {
  const load = async (b64) => {
    const img = new Image();
    await new Promise((r, e) => { img.onload = r; img.onerror = e; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, img.width, img.height).data, W: img.width, H: img.height };
  };
  const N = await load(nb), M = await load(mb);
  const W = N.W, H = N.H, NP = W * H;

  // Machine mask: the stencil paints shells pure white on pure black.
  const mask = new Uint8Array(NP);
  for (let i = 0; i < NP; i++) mask[i] = M.d[i * 4] > 127 ? 1 : 0;

  // Connected components over the mask, so the near and far machine separate.
  const lab = new Int32Array(NP).fill(-1);
  const comps = [];
  const stack = new Int32Array(NP);
  for (let s = 0; s < NP; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    const id = comps.length;
    let sp = 0; stack[sp++] = s; lab[s] = id;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    while (sp) {
      const p = stack[--sp]; n++;
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && lab[p - W] < 0) { lab[p - W] = id; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && lab[p + W] < 0) { lab[p + W] = id; stack[sp++] = p + W; }
    }
    comps.push({ id, n, x0, y0, x1, y1 });
  }
  comps.sort((a, b) => b.n - a.n);
  const keep = comps.filter((c) => c.n >= 300).slice(0, 2);

  const stat = (pick) => {
    let n = 0, sChroma = 0, sHsvS = 0, sL = 0, sHslS = 0, sLum = 0, sCeil = 0, sHsvV = 0;
    const lums = [];
    const chromas = [];
    for (let i = 0; i < NP; i++) {
      if (!pick(i)) continue;
      const r = N.d[i * 4], g = N.d[i * 4 + 1], b = N.d[i * 4 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const chroma = (mx - mn) / 255;
      const L = (mx + mn) / 510;
      const ceil = 1 - Math.abs(2 * L - 1);
      n++;
      sChroma += chroma;
      sHsvS += mx > 0 ? (mx - mn) / mx : 0;
      sHsvV += mx / 255;
      sL += L;
      sCeil += ceil;
      sHslS += ceil > 1e-4 ? Math.min(1, chroma / ceil) : 0;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sLum += lum;
      lums.push(lum);
      chromas.push(chroma);
    }
    if (!n) return null;
    lums.sort((a, b) => a - b);
    chromas.sort((a, b) => a - b);
    const q = (p) => lums[Math.min(lums.length - 1, Math.max(0, Math.round(p * (lums.length - 1))))];
    const qc = (p) => chromas[Math.min(chromas.length - 1, Math.max(0, Math.round(p * (chromas.length - 1))))];
    return {
      n, pct: (100 * n) / NP,
      chroma: sChroma / n, hsvS: sHsvS / n, hsvV: sHsvV / n,
      L: sL / n, ceil: sCeil / n, hslS: sHslS / n,
      cmed: qc(0.50),
      lum: sLum / n, p10: q(0.10), med: q(0.50), p90: q(0.90),
    };
  };

  const res = {
    W, H,
    machines: stat((i) => mask[i] === 1),
    stage: stat((i) => mask[i] === 0),
    parts: keep.map((c) => ({
      n: c.n, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1, x: c.x0, y: c.y0,
      s: stat((i) => lab[i] === c.id),
    })),
  };

  // The brightest 1% of the frame: who owns it. Carried from _sal.mjs so the
  // two files' headline numbers stay comparable.
  const all = new Float32Array(NP);
  for (let i = 0; i < NP; i++) all[i] = 0.2126 * N.d[i * 4] + 0.7152 * N.d[i * 4 + 1] + 0.0722 * N.d[i * 4 + 2];
  const sorted = Float32Array.from(all).sort();
  const thr = sorted[Math.floor(NP * 0.99)];
  let top = 0, topM = 0;
  for (let i = 0; i < NP; i++) if (all[i] >= thr) { top++; if (mask[i]) topM++; }
  res.top1 = { thr, share: (100 * topM) / Math.max(1, top) };
  return res;
}, { nb, mb });

await browser.close();

const f = (v, d = 3) => (v === null || v === undefined ? '  -  ' : v.toFixed(d));
const pad = (v, w) => String(v).padStart(w);

console.log(`\nCHROMA — ${DIR} / ${ARENA}  (${out.W}x${out.H})`);
console.log('                  px      %frame   chroma   cMED    ceil   used   HSL L   HSL S   HSV S    lum    p10   med   p90');
const row = (name, s) => {
  if (!s) { console.log(`  ${name.padEnd(14)}  (none)`); return; }
  console.log(`  ${name.padEnd(14)}${pad(s.n, 7)}  ${pad(s.pct.toFixed(2), 6)}   ${f(s.chroma)}  ${f(s.cmed)}  ${f(s.ceil)}  ${pad((100 * s.chroma / Math.max(1e-4, s.ceil)).toFixed(0) + '%', 5)}  ${f(s.L)}  ${f(s.hslS)}  ${f(s.hsvS)}  ${pad(s.lum.toFixed(1), 6)} ${pad(s.p10.toFixed(0), 5)} ${pad(s.med.toFixed(0), 5)} ${pad(s.p90.toFixed(0), 5)}`);
};
row('MACHINES', out.machines);
out.parts.forEach((p, i) => row(`  robot ${i + 1} ${p.w}x${p.h}`, p.s));
row('STAGE', out.stage);
const m = out.machines, s = out.stage;
if (m && s) {
  console.log(`\n  machine chroma / stage chroma = ${f(m.chroma / Math.max(1e-4, s.chroma))}   (1.0 = the machines are as colourful as their backdrop)`);
  console.log(`  CLAUSE D, on its written threshold (MEDIAN chroma): machines ${f(m.cmed)} vs stage ${f(s.cmed)}  ->  ${m.cmed > s.cmed ? 'MET' : 'NOT MET'}`);
  console.log(`  the same pair in HSL S (scale-free, inflates on dark pixels): machines ${f(m.hslS)} vs stage ${f(s.hslS)}  — NOT clause D's statistic`);
  console.log(`  headroom: the machines are at ${(100 * m.chroma / Math.max(1e-4, m.ceil)).toFixed(0)}% of the chroma their own lightness allows`);
}
console.log(`  brightest 1% (>= ${out.top1.thr.toFixed(1)}): machines own ${out.top1.share.toFixed(1)}%`);
