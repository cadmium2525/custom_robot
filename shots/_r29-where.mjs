#!/usr/bin/env node
/**
 * WHERE THE MASS IS — the footprint of one suppressed layer, located in the
 * frame rather than merely counted.
 *
 * `0562782` closed 333 ms and 433 ms by reconstructing where the LOBES go, from
 * the capture's own metadata. Round 29 does the same for the CORE, and it does
 * not have to be arithmetic this time: `_r17-blast.mjs` now writes a vfxonly
 * pass (fault 28's fix), so the difference between two vfxonly renders — one as
 * shipped, one with a stage killed — IS that stage's own footprint, rendered.
 *
 *   node shots/_r29-where.mjs --a shots/r29base --b shots/r29k-firecore --age 07
 *
 * Reports, for the A render, for the B render and for the layer A-minus-B:
 * pixel count, centroid, bounding box, equivalent radius, and how much of the
 * opponent's stencil box that layer alone covers. The opponent is the SMALLER
 * of the two stencil boxes — the same rule `_r25-cover.mjs` and
 * `_r23-lightprobe.mjs` use, so all three agree by construction.
 *
 * The threshold is the same L>25 the coverage column is quoted at, and it is
 * printed so a figure from here can never be confused for one from there.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const A = flag('a', 'shots/r29base');
const B = flag('b', null);
const AGE = String(flag('age', '07')).padStart(2, '0');
const CUT = Number(flag('cut', 25));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const uri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

const ANALYSE = async ({ aUri, bUri, mUri, cut }) => {
  const load = async (u) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const P = await load(aUri);
  const Q = bUri ? await load(bUri) : null;
  const M = await load(mUri);
  const W = P.W, H = P.H;
  const luma = (d, i) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];

  // Opponent box = the smaller connected stencil region.
  const seen = new Uint8Array(W * H);
  const boxes = [];
  const on = (i) => M.d[i * 4] > 128;
  const st = [];
  for (let p = 0; p < W * H; p++) {
    if (seen[p] || !on(p)) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    st.length = 0; st.push(p); seen[p] = 1;
    while (st.length) {
      const q = st.pop();
      const x = q % W, y = (q / W) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !seen[q - 1] && on(q - 1)) { seen[q - 1] = 1; st.push(q - 1); }
      if (x < W - 1 && !seen[q + 1] && on(q + 1)) { seen[q + 1] = 1; st.push(q + 1); }
      if (y > 0 && !seen[q - W] && on(q - W)) { seen[q - W] = 1; st.push(q - W); }
      if (y < H - 1 && !seen[q + W] && on(q + W)) { seen[q + W] = 1; st.push(q + W); }
    }
    if (n > 200) boxes.push({ x0, y0, x1, y1, n });
  }
  boxes.sort((a, b) => a.n - b.n);
  const opp = boxes[0] || null;

  const stat = (test) => {
    let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, onOpp = 0, oppN = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inOpp = opp && x >= opp.x0 && x <= opp.x1 && y >= opp.y0 && y <= opp.y1 && on(i);
        if (inOpp) oppN++;
        if (!test(i)) continue;
        n++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (inOpp) onOpp++;
      }
    }
    return {
      n, cx: n ? sx / n : 0, cy: n ? sy / n : 0, x0, y0, x1, y1,
      req: Math.sqrt(n / Math.PI), oppPct: oppN ? (100 * onOpp) / oppN : 0, oppN,
    };
  };

  const aOn = (i) => luma(P.d, i) > cut;
  const bOn = (i) => Q && luma(Q.d, i) > cut;
  const out = { W, H, opp, A: stat(aOn) };
  if (Q) {
    out.B = stat(bOn);
    out.DIFF = stat((i) => aOn(i) && !bOn(i));
  }
  return out;
};

const browser = await chromium.launch({ executablePath: PINNED, args: ['--no-sandbox'] });
const page = await browser.newPage();
const res = await page.evaluate(ANALYSE, {
  aUri: uri(`${A}-a${AGE}-vfxonly.png`),
  bUri: B ? uri(`${B}-a${AGE}-vfxonly.png`) : null,
  mUri: uri(`${A}-a${AGE}-mach.png`),
  cut: CUT,
});
await browser.close();

const meta = JSON.parse(readFileSync(`${A}-meta.json`, 'utf8'));
const shot = meta.shots.find((s) => String(s.age).padStart(2, '0') === AGE);

console.log(`WHERE THE MASS IS — age ${AGE}${shot ? ` (${shot.ms} ms)` : ''}, L>${CUT}`);
console.log(`  A = ${A}${B ? `   B = ${B}   DIFF = A minus B, i.e. the layer B removed` : ''}`);
if (shot) {
  console.log(`  pinned blast projects at (${shot.pr.blast.x.toFixed(0)},${shot.pr.blast.y.toFixed(0)}) rpx ${shot.pr.blast.rpx.toFixed(0)}`);
  console.log(`  robo0 (${shot.pr.robo0.x.toFixed(0)},${shot.pr.robo0.y.toFixed(0)})  robo1 (${shot.pr.robo1.x.toFixed(0)},${shot.pr.robo1.y.toFixed(0)})`);
  for (const l of shot.lights || []) {
    console.log(`  light born ${l.birth.toFixed(3)} at (${l.x.toFixed(2)},${l.y.toFixed(2)},${l.z.toFixed(2)})`
      + `  ${(l.at || []).map((a) => `robo${a.robo} ${a.d.toFixed(2)}m ${a.lux.toFixed(2)}lux`).join('  ')}`);
  }
}
if (res.opp) console.log(`  opponent box (${res.opp.x0},${res.opp.y0})-(${res.opp.x1},${res.opp.y1})  ${res.opp.n} px`);
const row = (k, s) => console.log(
  `  ${k.padEnd(5)} px ${String(s.n).padStart(7)}  centroid (${s.cx.toFixed(0)},${s.cy.toFixed(0)})`
  + `  bbox (${s.x0},${s.y0})-(${s.x1},${s.y1})  r_eq ${s.req.toFixed(0)}  covers opponent ${s.oppPct.toFixed(1)}%`);
row('A', res.A);
if (res.B) { row('B', res.B); row('DIFF', res.DIFF); }
