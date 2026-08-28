#!/usr/bin/env node
/**
 * FRAME SALIENCE — who owns the frame, measured on any PNG, at any aspect.
 *
 * Blind point 1 is "the robots are the brightest, most saturated things on
 * screen". Every measurement of it in this project has been taken on a
 * 1600x900 desktop capture. `N8` in this document's own ledger says a fix
 * verified on desktop is not a fix; the same sentence applies to a PASS. On a
 * phone the frame also contains five touch buttons, and nobody has ever asked
 * what share of the frame's light and chroma those buttons take.
 *
 * So this is deliberately mask-free and resolution-free. It reports, for a
 * whole frame:
 *
 *   TOP TILES     a `--tile` grid ranked by luminance x (0.5 + saturation) —
 *                 the same score the round-8 sweep used — with each tile's own
 *                 L, S and peak. Overlapping picks are suppressed so one bright
 *                 object cannot fill the list.
 *   RECT SHARE    for each `--rect name:x,y,w,h`, that rect's share of the
 *                 frame's brightest 1% of pixels and of its saturated pixels
 *                 (S >= 0.35), against its share of the frame's AREA. A thing
 *                 that owns more light than area is winning the frame; the
 *                 ratio is the number to quote.
 *
 * Coordinates are in the SOURCE image's pixels. On a 3x device capture that is
 * device pixels: multiply the CSS rects a layout tool prints by the DPR first.
 *
 *   node shots/_framesal.mjs shots/hi-p-match.png --tile 60 \
 *        --rect touch:600,1750,570,700 --rect hud:0,0,1170,620
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const SRC = args[0];
if (!SRC) { console.error('usage: node shots/_framesal.mjs <png> [--tile n] [--rect name:x,y,w,h]...'); process.exit(1); }
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const TILE = Number(flag('tile', 60));
const RECTS = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--rect') continue;
  const [name, nums] = args[i + 1].split(':');
  const [x, y, w, h] = nums.split(',').map(Number);
  RECTS.push({ name, x, y, w, h });
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--disable-dev-shm-usage'],
});
const page = await (await browser.newContext()).newPage();
await page.goto('about:blank');

const out = await page.evaluate(async ({ b64, TILE, RECTS }) => {
  const img = new Image();
  await new Promise((r, e) => { img.onload = r; img.onerror = e; img.src = 'data:image/png;base64,' + b64; });
  const W = img.width, H = img.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;

  const lum = new Float32Array(W * H), sat = new Float32Array(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    lum[p] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    sat[p] = mx ? (mx - mn) / mx : 0;
  }

  // Threshold for "the brightest 1%" — a real percentile, not a fixed level,
  // so a dark frame and a bright frame are asked the same question.
  const sorted = Float32Array.from(lum).sort();
  const bright = sorted[Math.floor(sorted.length * 0.99)];
  // Two chroma filters, reported side by side ON PURPOSE.
  //
  // `sat` is the bare S >= 0.35 used by this project's round-8 point-1
  // measurement. S = (max-min)/max is scale-free, so RGB (2,3,12) scores 0.75:
  // on a dark blue-tinted stage the filter counts near-black pixels as
  // saturated and can return most of a frame that reads as monochrome. `satL`
  // adds the only thing that makes the word mean what a viewer means by it —
  // the pixel has to be visible: S >= 0.35 AND L >= 40.
  let nBright = 0, nSat = 0, nSatL = 0;
  for (let p = 0; p < W * H; p++) {
    if (lum[p] >= bright) nBright++;
    if (sat[p] >= 0.35) { nSat++; if (lum[p] >= 40) nSatL++; }
  }

  const tiles = [];
  for (let ty = 0; ty + TILE <= H; ty += TILE) {
    for (let tx = 0; tx + TILE <= W; tx += TILE) {
      let L = 0, S = 0, top = 0, n = 0;
      for (let y = ty; y < ty + TILE; y++) {
        for (let x = tx; x < tx + TILE; x++) {
          const p = y * W + x;
          L += lum[p]; S += sat[p]; n++;
          if (lum[p] > top) top = lum[p];
        }
      }
      tiles.push({ x: tx, y: ty, L: L / n, S: S / n, top, score: (L / n) * (0.5 + S / n) });
    }
  }
  tiles.sort((a, b) => b.score - a.score);
  const picks = [];
  for (const t of tiles) {
    if (picks.some((p) => Math.abs(p.x - t.x) < TILE * 1.5 && Math.abs(p.y - t.y) < TILE * 1.5)) continue;
    picks.push(t);
    if (picks.length >= 12) break;
  }

  const rects = RECTS.map((r) => {
    let b = 0, s = 0, sL = 0, a = 0;
    for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(W, r.x + r.w); x++) {
        const p = y * W + x;
        a++;
        if (lum[p] >= bright) b++;
        if (sat[p] >= 0.35) { s++; if (lum[p] >= 40) sL++; }
      }
    }
    return { name: r.name, area: a, bright: b, sat: s, satL: sL };
  });
  return { W, H, bright, nBright, nSat, nSatL, picks, rects };
}, { b64: readFileSync(SRC).toString('base64'), TILE, RECTS });

console.log(`\nFRAME SALIENCE — ${SRC}  ${out.W}x${out.H}`);
console.log(`  brightest-1% threshold L=${out.bright.toFixed(0)}  (${out.nBright} px)`);
console.log(`  saturated S>=0.35        : ${out.nSat} px = ${(100 * out.nSat / (out.W * out.H)).toFixed(1)}% of frame   [round-8 filter]`);
console.log(`  saturated S>=0.35 & L>=40: ${out.nSatL} px = ${(100 * out.nSatL / (out.W * out.H)).toFixed(1)}% of frame   [visible chroma]\n`);
console.log(`  TOP ${out.picks.length} TILES (${TILE}px, luminance x chroma)`);
out.picks.forEach((t, i) => console.log(
  `   ${String(i + 1).padStart(2)}. ${String(t.x).padStart(5)},${String(t.y).padStart(5)}  L=${t.L.toFixed(0).padStart(3)}  S=${t.S.toFixed(2)}  peak=${t.top.toFixed(0)}`));
if (out.rects.length) {
  console.log(`\n  RECT SHARE                 area%   bright1%%   sat%%   satL%%   light/area   chromaL/area`);
  const A = out.W * out.H;
  for (const r of out.rects) {
    const ap = 100 * r.area / A, bp = 100 * r.bright / out.nBright;
    const sp = 100 * r.sat / (out.nSat || 1), lp = 100 * r.satL / (out.nSatL || 1);
    console.log(`   ${r.name.padEnd(22)} ${ap.toFixed(1).padStart(6)} ${bp.toFixed(1).padStart(9)} ${sp.toFixed(1).padStart(7)} ${lp.toFixed(1).padStart(7)}` +
      `   ${(bp / ap).toFixed(2).padStart(9)}x  ${(lp / ap).toFixed(2).padStart(11)}x`);
  }
}
await browser.close();
