#!/usr/bin/env node
/**
 * Crop a capture so it can be READ AT 1:1.
 *
 * The review's standing trap is that every measurement in this repo is a
 * summary, and a summary can be gamed — the discarded explosion rework scored
 * better than anything here while covering the fight in beige smoke. The only
 * defence is looking at the pixels, and a 1600x900 PNG handed to a reader is
 * downscaled before it is seen: the 90px opponent that the whole argument is
 * about becomes 30px, which is precisely the size at which the defect hides.
 *
 *   node shots/_crop.mjs shots/foo.png 700,560,240,340 --zoom 2 --out shots/foo-crop.png
 *
 * Args: <src.png> <x,y,w,h> [--zoom n] [--out path]
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const src = args[0];
const rect = (args[1] || '0,0,400,400').split(',').map(Number);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const ZOOM = Number(flag('zoom', 1));
const OUT = flag('out', src.replace(/\.png$/, '-crop.png'));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');
  const uri = 'data:image/png;base64,' + readFileSync(src).toString('base64');
  const out = await page.evaluate(async ({ uri, rect, zoom }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const [x, y, w, h] = rect;
    const c = document.createElement('canvas');
    c.width = w * zoom; c.height = h * zoom;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, x, y, w, h, 0, 0, w * zoom, h * zoom);
    return { uri: c.toDataURL('image/png'), src: `${img.width}x${img.height}` };
  }, { uri, rect, zoom: ZOOM });
  writeFileSync(OUT, Buffer.from(out.uri.split(',')[1], 'base64'));
  console.log(`${src} (${out.src}) -> ${OUT}  ${rect.join(',')} @ ${ZOOM}x`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
