#!/usr/bin/env node
/**
 * Crop a PNG without an image library.
 *
 * Reading a 1170x2532 phone capture through anything that downscales is how
 * five rounds of this project "checked" a layout and missed a clipped label:
 * the reviewer has to see device pixels, so a capture has to be cut into bands
 * small enough to survive at 1:1. There is no image module in this repo's
 * dependency tree, so the decode happens in the browser that is already here.
 *
 *   node shots/_crop.mjs in.png out.png x y w h     # coords in DEVICE pixels
 *   node shots/_crop.mjs in.png out.png x y w h 3   # ...or in CSS px at dpr 3
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const [inp, outp, x, y, w, h, dpr = 1] = process.argv.slice(2);
if (!inp || !outp) { console.error('usage: _crop.mjs in.png out.png x y w h [dpr]'); process.exit(1); }
const s = Number(dpr) || 1;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const b64 = await page.evaluate(async ({ uri, x, y, w, h }) => {
  const img = new Image();
  img.src = uri;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = Math.min(w, img.naturalWidth - x);
  c.height = Math.min(h, img.naturalHeight - y);
  c.getContext('2d').drawImage(img, x, y, c.width, c.height, 0, 0, c.width, c.height);
  return c.toDataURL('image/png').split(',')[1];
}, {
  uri: 'data:image/png;base64,' + readFileSync(inp).toString('base64'),
  x: Math.round(Number(x) * s), y: Math.round(Number(y) * s),
  w: Math.round(Number(w) * s), h: Math.round(Number(h) * s),
});
writeFileSync(outp, Buffer.from(b64, 'base64'));
console.log('wrote', outp);
await browser.close();
