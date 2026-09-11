#!/usr/bin/env node
/**
 * LEG 4 OF THE ROUND-23 ACCEPTANCE TEST, MEASURED INSTEAD OF EYEBALLED.
 *
 * "The tell still legible on the 1:1 crop" was the fourth leg and it was not
 * reported. A tell is a CHANGE — the machine must look different when it is hit
 * than when it is not — so the quantity is the delta between the hit age (117ms,
 * where the second detonation lands on the opponent) and an unhit age (17ms),
 * taken on the novfx frames so nothing the effect draws can contribute.
 *
 * Reported in both channels the ruling is about: luminance, which the fix was
 * built to give back, and chroma, which it claims to have bought the punch with.
 * Same chroma statistic as _r16chroma.mjs: (max-min)/255 per pixel, median over
 * the machine's own stencil pixels.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';

const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// INSTRUMENT FAULT 56. This used to read `PINNED`, which

// resolves a missing pin to the DEFAULT browser instead of stopping. A guard the

// caller can redirect is not a guard (faults 29, 43 and 53), and a figure taken on a

// different rasteriser than the card was measured on is not comparable to it.

if (!existsSync(PINNED)) {

  console.error('INSTRUMENT FAULT 56: this file pins ' + PINNED + ' and it is not on this box.');

  console.error('Refusing to fall back to the default browser. Install that build or run elsewhere.');

  process.exit(2);

}
const uri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

const ANALYSE = async ({ frameUri, machUri }) => {
  const load = async (u) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const F = await load(frameUri);
  const M = await load(machUri);
  const seen = new Uint8Array(M.W * M.H);
  const boxes = [];
  const isOn = (i) => M.d[i * 4] > 128;
  const stack = [];
  for (let p = 0; p < M.W * M.H; p++) {
    if (seen[p] || !isOn(p)) continue;
    let x0 = M.W, y0 = M.H, x1 = -1, y1 = -1, n = 0;
    const px = [];
    stack.length = 0; stack.push(p); seen[p] = 1;
    while (stack.length) {
      const q = stack.pop();
      const x = q % M.W, y = (q / M.W) | 0;
      n++; px.push(q);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !seen[q - 1] && isOn(q - 1)) { seen[q - 1] = 1; stack.push(q - 1); }
      if (x < M.W - 1 && !seen[q + 1] && isOn(q + 1)) { seen[q + 1] = 1; stack.push(q + 1); }
      if (y > 0 && !seen[q - M.W] && isOn(q - M.W)) { seen[q - M.W] = 1; stack.push(q - M.W); }
      if (y < M.H - 1 && !seen[q + M.W] && isOn(q + M.W)) { seen[q + M.W] = 1; stack.push(q + M.W); }
    }
    if (n > 200) boxes.push({ n, px, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  boxes.sort((a, b) => b.n - a.n);
  const far = boxes.length > 1 ? boxes[boxes.length - 1] : boxes[0];
  const lum = [], chr = [];
  let r = 0, g = 0, b = 0;
  for (const q of far.px) {
    const R = F.d[q * 4], G = F.d[q * 4 + 1], B = F.d[q * 4 + 2];
    r += R; g += G; b += B;
    lum.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    chr.push((Math.max(R, G, B) - Math.min(R, G, B)) / 255);
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const n = far.px.length;
  return {
    boxes: boxes.length, w: far.w, h: far.h, px: n,
    lumMean: mean(lum), lumMed: med(lum),
    chrMean: mean(chr), chrMed: med(chr),
    rgb: [r / n, g / n, b / n],
  };
};

const browser = await chromium.launch({
  headless: true,
  executablePath: PINNED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });

const rows = [
  ['PRE-FIX  17ms  unhit', 'shots/r23base-a01-novfx.png', 'shots/r23base-a01-mach.png'],
  ['PRE-FIX 117ms  HIT  ', 'shots/r23base-a07-novfx.png', 'shots/r23base-a07-mach.png'],
  ['POST-FIX 17ms  unhit', 'shots/r24h-a01-novfx.png', 'shots/r24h-a01-mach.png'],
  ['POST-FIX117ms  HIT  ', 'shots/r24h-a07-novfx.png', 'shots/r24h-a07-mach.png'],
];

console.log('THE HIT TELL, MEASURED — opponent pixels in the novfx frame (no VFX, no blast lights)');
console.log('  arm                    box       px  |  luma mean   med  |  chroma mean    med  |  mean rgb');
const out = {};
for (const [label, frame, mach] of rows) {
  if (!existsSync(frame) || !existsSync(mach)) { console.log(`  ${label}  MISSING`); continue; }
  const r = await page.evaluate(`(${ANALYSE})(${JSON.stringify({ frameUri: uri(frame), machUri: uri(mach) })})`);
  out[label.trim()] = r;
  const f = (v, w = 6) => v.toFixed(1).padStart(w);
  const c = (v) => v.toFixed(3).padStart(6);
  console.log(`  ${label}  ${String(r.w).padStart(3)}x${String(r.h).padEnd(3)} ${String(r.px).padStart(5)}  |${
    f(r.lumMean)} ${f(r.lumMed)}  |    ${c(r.chrMean)} ${c(r.chrMed)}  |  ${
    r.rgb.map((v) => v.toFixed(0).padStart(4)).join('')}`);
}
await browser.close();

const pre = [out['PRE-FIX  17ms  unhit'], out['PRE-FIX 117ms  HIT']];
const post = [out['POST-FIX 17ms  unhit'], out['POST-FIX117ms  HIT']];
if (pre[0] && pre[1] && post[0] && post[1]) {
  const d = (a, b, k) => (b[k] - a[k]);
  console.log('\n  THE TELL = the delta the player has to see (hit minus unhit)');
  console.log(`    PRE-FIX    luma ${d(pre[0], pre[1], 'lumMean').toFixed(1)}   chroma ${d(pre[0], pre[1], 'chrMean').toFixed(3)}`);
  console.log(`    POST-FIX   luma ${d(post[0], post[1], 'lumMean').toFixed(1)}   chroma ${d(post[0], post[1], 'chrMean').toFixed(3)}`);
}
