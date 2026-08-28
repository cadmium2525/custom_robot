#!/usr/bin/env node
/**
 * Batch 1:1 cropper — `_crop.mjs` for a whole list, in ONE browser launch.
 *
 * Why this exists rather than a shell loop over `_crop.mjs`. The review's rule
 * is that every PNG is read at 1:1, which on a 2532px capture means eight or
 * ten crops per round. Eight `_crop.mjs` invocations are eight Chromium
 * launches, and this project's own instrument history says why that matters:
 * the mass meter's pose is a function of wall-clock load, so a reviewer who
 * crops while a noise floor is capturing is perturbing the measurement they are
 * about to quote. One launch, one queue, one short burst.
 *
 *   node shots/_crops.mjs jobs.txt
 *
 * jobs.txt: one job per line, `<src.png> <x,y,w,h> <zoom> <out.png>`,
 * blank lines and #-comments ignored. Coordinates are in the SOURCE image's
 * own pixels, so on a 3x device capture they are device pixels, not CSS px.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const jobsFile = process.argv[2];
if (!jobsFile) { console.error('usage: node shots/_crops.mjs <jobs.txt>'); process.exit(1); }
const jobs = readFileSync(jobsFile, 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [src, rect, zoom, out] = l.split(/\s+/);
    return { src, rect: rect.split(',').map(Number), zoom: Number(zoom) || 1, out };
  });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--disable-dev-shm-usage'],
});
const page = await (await browser.newContext()).newPage();
await page.goto('about:blank');

for (const j of jobs) {
  const b64 = readFileSync(j.src).toString('base64');
  const out = await page.evaluate(async ({ b64, rect, zoom }) => {
    const img = new Image();
    await new Promise((r, e) => { img.onload = r; img.onerror = e; img.src = 'data:image/png;base64,' + b64; });
    const [x, y, w, h] = rect;
    const c = document.createElement('canvas');
    c.width = Math.round(w * zoom); c.height = Math.round(h * zoom);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
    return { uri: c.toDataURL('image/png'), src: `${img.width}x${img.height}` };
  }, { b64, rect: j.rect, zoom: j.zoom });
  writeFileSync(j.out, Buffer.from(out.uri.split(',')[1], 'base64'));
  console.log(`  ${j.src} (${out.src})  ${j.rect.join(',')} x${j.zoom} -> ${j.out}`);
}
await browser.close();
