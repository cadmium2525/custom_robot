#!/usr/bin/env node
/**
 * WHY foundry's contour fails when its separation is the BIGGEST of the three.
 *
 * The filed story is "foundry's machine is the darkest in the game, so the
 * background has to be lifted". Head does not support it. On the pinned frames:
 *
 *   grid     body 144.3  background 77.3   separation 67.0   invisible  4.7%
 *   foundry  body 116.6  background 48.5   separation 68.1   invisible 22.0%
 *
 * Same separation, five times the failure. A separation figure is the distance
 * between two MEDIANS, and a silhouette does not fail at the median — it fails
 * wherever a bright part of the machine happens to land on a bright part of the
 * stage, or a dark part on a dark part. What decides that is not where the two
 * distributions sit, it is how WIDE they are and how much they OVERLAP.
 *
 * So this reads the same dump pair every other offline meter reads and reports,
 * for each machine and for the frame:
 *
 *   - percentiles of the local BODY value  (mean of the mask half of the 7x7)
 *   - percentiles of the local BACKGROUND value (mean of the non-mask half)
 *   - their interquartile widths, and the OVERLAP: the fraction of boundary
 *     pixels whose background value falls inside the body's own p10..p90 —
 *     i.e. how often the stage is wearing the machine's colours
 *   - the same two distributions as a shared 16-bin histogram, so the shape is
 *     readable rather than summarised
 *
 * An arena can fix an overlap by moving its background OUT of the machine's
 * range, and it can do that by moving the median (which costs the amber win) or
 * by NARROWING the spread (which does not). This meter is what tells the two
 * apart.
 *
 *   node shots/_spread.mjs <dumpDir> <arena> [<arena> ...]
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const DIR = args[0];
const ARENAS = args.slice(1).filter((a) => !a.startsWith('--'));
if (!DIR || !ARENAS.length) { console.error('usage: node shots/_spread.mjs <dumpDir> <arena>...'); process.exit(1); }

const FN = async ({ nUri, hUri }) => {
  const load = async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const N = await load(nUri), M = await load(hUri);
  const W = N.W, HT = N.H, NP = W * HT;
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const Ln = new Float32Array(NP), mask = new Uint8Array(NP);
  for (let p = 0, i = 0; p < NP; p++, i += 4) { Ln[p] = lum(N.d, i); if (lum(M.d, i) > 128) mask[p] = 1; }

  /* Components — same filter as contour.mjs, so the bodies match its rows. */
  const comp = new Int32Array(NP).fill(-1);
  const comps = [];
  const stack = new Int32Array(NP);
  for (let p = 0; p < NP; p++) {
    if (!mask[p] || comp[p] >= 0) continue;
    const id = comps.length;
    let sp = 0, n = 0, x0 = W, x1 = 0, y0 = HT, y1 = 0;
    stack[sp++] = p; comp[p] = id;
    while (sp) {
      const q = stack[--sp], qx = q % W, qy = (q / W) | 0;
      n++;
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
      if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      if (qx > 0 && mask[q - 1] && comp[q - 1] < 0) { comp[q - 1] = id; stack[sp++] = q - 1; }
      if (qx < W - 1 && mask[q + 1] && comp[q + 1] < 0) { comp[q + 1] = id; stack[sp++] = q + 1; }
      if (qy > 0 && mask[q - W] && comp[q - W] < 0) { comp[q - W] = id; stack[sp++] = q - W; }
      if (qy < HT - 1 && mask[q + W] && comp[q + W] < 0) { comp[q + W] = id; stack[sp++] = q + W; }
    }
    comps.push({ id, n, x0, x1, y0, y1 });
  }
  const bodies = comps.filter((c) => c.n >= 300 && (c.y1 - c.y0) >= 16).sort((a, b) => b.n - a.n).slice(0, 2);

  const R = 3;
  const walk = (only) => {
    const mi = [], mo = [];
    for (let y = R; y < HT - R; y++) {
      for (let x = R; x < W - R; x++) {
        const p = y * W + x;
        if (!mask[p]) continue;
        if (only !== undefined && comp[p] !== only) continue;
        if (mask[p - 1] && mask[p + 1] && mask[p - W] && mask[p + W]) continue;
        let iS = 0, iN = 0, oS = 0, oN = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const q = p + dy * W + dx;
            if (mask[q]) { iS += Ln[q]; iN++; } else { oS += Ln[q]; oN++; }
          }
        }
        if (iN < 5 || oN < 5) continue;
        mi.push(iS / iN); mo.push(oS / oN);
      }
    }
    return { mi, mo };
  };

  const stat = (a) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    const q = (f) => Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 10) / 10;
    return { n: s.length, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), iqr: Math.round((q(0.75) - q(0.25)) * 10) / 10 };
  };
  const hist = (a, lo, hi, bins) => {
    const h = new Array(bins).fill(0);
    for (const v of a) h[Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / (hi - lo) * bins)))]++;
    return h;
  };

  const pack = (only, label) => {
    const { mi, mo } = walk(only);
    const B = stat(mi), G = stat(mo);
    if (!B) return null;
    // How often is the stage wearing the machine's own values?
    const inBody = mo.filter((v) => v >= B.p10 && v <= B.p90).length;
    return {
      label, body: B, bg: G,
      overlap: Math.round(inBody / mo.length * 1000) / 10,
      hBody: hist(mi, 0, 256, 16), hBg: hist(mo, 0, 256, 16),
    };
  };

  const out = [pack(undefined, 'OVERALL')];
  bodies.forEach((b, i) => out.push(pack(b.id, `ROBOT ${i + 1}  ${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1}px`)));

  /* Frame-wide value histogram, non-mask pixels only: the stage's own spread. */
  const bg = [];
  for (let p = 0; p < NP; p++) if (!mask[p]) bg.push(Ln[p]);
  return { out: out.filter(Boolean), frame: { stat: stat(bg), h: hist(bg, 0, 256, 16) } };
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await (await browser.newContext()).newPage();
await page.goto('about:blank');
const uri = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64');

const barRow = (h) => {
  const max = Math.max(1, ...h);
  const ch = ' .:-=+*#%@';
  return h.map((v) => ch[Math.min(ch.length - 1, Math.round(v / max * (ch.length - 1)))]).join('');
};
const line = (s) => `p10 ${String(s.p10).padStart(5)}  p25 ${String(s.p25).padStart(5)}  p50 ${String(s.p50).padStart(5)}  p75 ${String(s.p75).padStart(5)}  p90 ${String(s.p90).padStart(5)}   IQR ${String(s.iqr).padStart(5)}`;

for (const ARENA of ARENAS) {
  if (!existsSync(`${DIR}/${ARENA}-n.png`)) { console.error(`no ${DIR}/${ARENA}-n.png`); continue; }
  const r = await page.evaluate(FN, { nUri: uri(`${DIR}/${ARENA}-n.png`), hUri: uri(`${DIR}/${ARENA}-mask.png`) });
  console.log(`\n============ ${ARENA}  (${DIR}) ============`);
  console.log(`  FRAME, non-machine pixels:  ${line(r.frame.stat)}`);
  console.log(`     0 |${barRow(r.frame.h)}| 255`);
  for (const b of r.out) {
    console.log(`\n  ${b.label}   ${b.body.n} boundary px`);
    console.log(`    body        ${line(b.body)}`);
    console.log(`    background  ${line(b.bg)}`);
    console.log(`    OVERLAP: ${b.overlap}% of local backgrounds fall inside the body's own p10..p90`);
    console.log(`    body  0 |${barRow(b.hBody)}| 255`);
    console.log(`    bg    0 |${barRow(b.hBg)}| 255`);
  }
}
await browser.close();
