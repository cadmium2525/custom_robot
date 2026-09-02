#!/usr/bin/env node
/**
 * WHERE the silhouette fails, not how much.
 *
 * `tools/contour.mjs` reports one number — the fraction of contour below the
 * legibility floor — and that number has now been moved twice by stage edits
 * without anybody being able to say WHICH edge went. Round 16 needs that,
 * because the amber dim traded 3.3 of separation for 1.7pt of invisible contour
 * and "make the background lighter again" is exactly the move that hands the
 * amber win back. So this reads the SAME pinned dump pair, reproduces
 * contour.mjs's boundary walk verbatim (7x7 window, |mean_in - mean_out|,
 * connected components, the same >=300px / >=16px-tall body filter), and then
 * asks of every failing boundary pixel:
 *
 *   - is it dark-on-dark or light-on-light?  (the sign of in - out, not |.|)
 *   - what is behind it?                      (mean sRGB of the outside half)
 *   - where is it?                            (bbox-relative bands, and a map)
 *
 * The sign is the whole point. A stage edit that darkens the frame CANNOT fix a
 * light-on-light failure and CANNOT break a dark-on-dark one; if the failures
 * are one-sided, then the fix is one-sided too and does not have to touch the
 * end of the range the amber result lives at.
 *
 *   node shots/_invis.mjs <dumpDir> <arena> [--thr 12] [--map]
 *
 * Reads <dir>/<arena>-n.png + <dir>/<arena>-mask.png from shots/_dump.sh.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const DIR = args[0], ARENA = args[1];
const fl = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const THR = Number(fl('thr', 12));
const MAP = !!fl('map');
if (!DIR || !ARENA || !existsSync(`${DIR}/${ARENA}-n.png`)) {
  console.error(`usage: node shots/_invis.mjs <dumpDir> <arena>   (no ${DIR}/${ARENA}-n.png)`);
  process.exit(1);
}

const FN = async ({ nUri, hUri, THR }) => {
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

  /* Components — verbatim from contour.mjs. */
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
    const pts = [];
    for (let y = R; y < HT - R; y++) {
      for (let x = R; x < W - R; x++) {
        const p = y * W + x;
        if (!mask[p]) continue;
        if (only !== undefined && comp[p] !== only) continue;
        if (mask[p - 1] && mask[p + 1] && mask[p - W] && mask[p + W]) continue;
        let inS = 0, inN = 0, outS = 0, outN = 0, oR = 0, oG = 0, oB = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const q = p + dy * W + dx, i = q * 4;
            if (mask[q]) { inS += Ln[q]; inN++; }
            else { outS += Ln[q]; outN++; oR += N.d[i]; oG += N.d[i + 1]; oB += N.d[i + 2]; }
          }
        }
        if (inN < 5 || outN < 5) continue;
        const mi = inS / inN, mo = outS / outN;
        pts.push({ x, y, step: Math.abs(mi - mo), signed: mi - mo, mi, mo, r: oR / outN, g: oG / outN, b: oB / outN });
      }
    }
    return pts;
  };

  const report = (pts, box) => {
    const bad = pts.filter((p) => p.step < THR);
    const darkOnDark = bad.filter((p) => p.mi < 90 && p.mo < 90);
    const lightOnLight = bad.filter((p) => p.mi >= 90 && p.mo >= 90);
    const mid = bad.length - darkOnDark.length - lightOnLight.length;
    const avg = (a, k) => (a.length ? Math.round(a.reduce((s, v) => s + v[k], 0) / a.length * 10) / 10 : 0);
    /* Vertical thirds of the body's own bbox: head / torso / legs. */
    const h = Math.max(1, box.y1 - box.y0);
    const band = (p) => Math.min(2, Math.floor((p.y - box.y0) / h * 3));
    const bands = [0, 1, 2].map((k) => ({
      all: pts.filter((p) => band(p) === k).length,
      bad: bad.filter((p) => band(p) === k).length,
    }));
    /* What is behind the failures, bucketed by the outside half's own value. */
    const buckets = [[0, 30], [30, 60], [60, 90], [90, 130], [130, 255]].map(([a, b2]) => {
      const s = bad.filter((p) => p.mo >= a && p.mo < b2);
      return { a, b: b2, n: s.length, mi: avg(s, 'mi'), mo: avg(s, 'mo'), r: avg(s, 'r'), g: avg(s, 'g'), bl: avg(s, 'b') };
    });
    return {
      n: pts.length, bad: bad.length, pct: Math.round(bad.length / pts.length * 1000) / 10,
      darkOnDark: darkOnDark.length, lightOnLight: lightOnLight.length, mid,
      dodIn: avg(darkOnDark, 'mi'), dodOut: avg(darkOnDark, 'mo'),
      lolIn: avg(lightOnLight, 'mi'), lolOut: avg(lightOnLight, 'mo'),
      bands, buckets,
      box: [box.x0, box.y0, box.x1, box.y1],
      /* A coarse map of the failures, 1 cell = 8x8px of the bbox. */
      map: (() => {
        const CW = 24, CH = 30;
        const g = Array.from({ length: CH }, () => new Array(CW).fill(0));
        const t = Array.from({ length: CH }, () => new Array(CW).fill(0));
        for (const p of pts) {
          const cx = Math.min(CW - 1, Math.floor((p.x - box.x0) / Math.max(1, box.x1 - box.x0 + 1) * CW));
          const cy = Math.min(CH - 1, Math.floor((p.y - box.y0) / Math.max(1, box.y1 - box.y0 + 1) * CH));
          t[cy][cx]++; if (p.step < THR) g[cy][cx]++;
        }
        return g.map((row, y) => row.map((v, x) => (t[y][x] === 0 ? ' ' : v === 0 ? '.' : v === t[y][x] ? '#' : v * 2 >= t[y][x] ? '+' : '-')).join('')).join('\n');
      })(),
    };
  };

  const out = { bodies: [] };
  out.all = report(walk(undefined), { x0: 0, y0: 0, x1: W - 1, y1: HT - 1 });
  for (const b of bodies) out.bodies.push({ n: b.n, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, r: report(walk(b.id), b) });
  return out;
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await (await browser.newContext()).newPage();
await page.goto('about:blank');
const uri = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64');
const out = await page.evaluate(FN, { nUri: uri(`${DIR}/${ARENA}-n.png`), hUri: uri(`${DIR}/${ARENA}-mask.png`), THR });
await browser.close();

const pad = (v, n) => String(v).padStart(n);
console.log(`\nINVISIBLE CONTOUR — ${DIR} / ${ARENA}, threshold step < ${THR}`);
const show = (label, r) => {
  console.log(`\n  ${label}   ${r.bad}/${r.n} boundary px fail  (${r.pct}%)`);
  console.log(`    dark-on-dark   ${pad(r.darkOnDark, 5)}  (${pad(Math.round(r.darkOnDark / Math.max(1, r.bad) * 100), 3)}% of failures)  body ${r.dodIn} vs behind ${r.dodOut}`);
  console.log(`    light-on-light ${pad(r.lightOnLight, 5)}  (${pad(Math.round(r.lightOnLight / Math.max(1, r.bad) * 100), 3)}% of failures)  body ${r.lolIn} vs behind ${r.lolOut}`);
  console.log(`    straddling     ${pad(r.mid, 5)}`);
  console.log('    failures by what is BEHIND them:');
  for (const b of r.buckets) {
    if (!b.n) continue;
    console.log(`      behind lum ${pad(b.a, 3)}-${pad(b.b, 3)}   ${pad(b.n, 5)} px   body ${pad(b.mi, 5)}  behind ${pad(b.mo, 5)}   rgb(${Math.round(b.r)},${Math.round(b.g)},${Math.round(b.bl)})`);
  }
  console.log(`    by band (top/mid/bottom third of the body):  `
    + r.bands.map((b, i) => `${['top', 'mid', 'bot'][i]} ${b.bad}/${b.all}`).join('   '));
  if (MAP) { console.log('    map (# all-fail, + majority, - some, . clean):'); console.log(r.map.split('\n').map((l) => '      ' + l).join('\n')); }
};
show('OVERALL', out.all);
out.bodies.forEach((b, i) => show(`ROBOT ${i + 1}  ${b.w}x${b.h}px at ${b.r.box[0]},${b.r.box[1]}`, b.r));
