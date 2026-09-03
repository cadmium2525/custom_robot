#!/usr/bin/env node
/**
 * WHAT THE BLAST LIGHT ALONE DOES TO THE OPPONENT, PER AGE.
 *
 * `_r17-edge.mjs`'s occlusion column is |luma(raw) - luma(novfx)| over the
 * machine stencil: it cannot separate covering from lighting (fault 23), and
 * `--kill light` separates them only as a total. This prints the light's own
 * signed contribution on the opponent's pixels, which is
 *
 *     L(x,y) = luma(raw_shipped) - luma(raw_killlight)
 *
 * — the same frozen frame, the same tick, the same everything, differing by
 * whether the blast's point light was in the scene. Both prefixes must have
 * been captured from the same bundle at the same ages.
 *
 *   node shots/_r23-lightprobe.mjs --a shots/r23base --b shots/r23nolight \
 *        --ages 1,7,14,20,26,32,48
 *
 * The machine mask is the capture's own `-mach.png`, split between the two
 * machines by nearest reported centre, so the far machine is the one this
 * document calls the opponent. Centres are read from the `-edge.txt` of --a.
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
const A = flag('a', 'shots/r23base');
const B = flag('b', 'shots/r23nolight');
const AGES = String(flag('ages', '1,7,14,20,26,32,48')).split(',').map(Number);

const edge = readFileSync(`${A}-edge.txt`, 'utf8');
const centres = {};
{
  let age = null;
  for (const line of edge.split('\n')) {
    const m = line.match(/^--- age (\d+) ticks/);
    if (m) { age = Number(m[1]); centres[age] = []; continue; }
    const c = line.match(/MACHINE @\((\d+),(\d+)\) (\d+)px/);
    if (c && age != null) centres[age].push({ x: Number(c[1]), y: Number(c[2]), h: Number(c[3]) });
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();

/**
 * All pixel work happens inside the page. Handing a 1600x900 frame back over
 * CDP as an array is minutes per image; four images per age is a meter nobody
 * will run twice.
 */
async function measure(paths, far, near) {
  const b64 = {};
  for (const k of Object.keys(paths)) b64[k] = readFileSync(paths[k]).toString('base64');
  return page.evaluate(async ([imgs, f, n]) => {
    const grab = async (d) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + d;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, px: g.getImageData(0, 0, c.width, c.height).data };
    };
    const rawA = await grab(imgs.rawA), rawB = await grab(imgs.rawB);
    const nov = await grab(imgs.nov), mach = await grab(imgs.mach);
    const lum = (p, i) => 0.2126 * p.px[i] + 0.7152 * p.px[i + 1] + 0.0722 * p.px[i + 2];
    const L = [], Csh = [], Ckl = [];
    let novSum = 0;
    for (let y = 0; y < mach.h; y++) {
      for (let x = 0; x < mach.w; x++) {
        const i = (y * mach.w + x) * 4;
        if (mach.px[i] < 128) continue;
        const df = (x - f.x) ** 2 + (y - f.y) ** 2;
        const dn = (x - n.x) ** 2 + (y - n.y) ** 2;
        if (df >= dn) continue;
        const la = lum(rawA, i), lb = lum(rawB, i), ln = lum(nov, i);
        L.push(la - lb); Csh.push(Math.abs(la - ln)); Ckl.push(Math.abs(lb - ln));
        novSum += ln;
      }
    }
    return { L, Csh, Ckl, novSum };
  }, [b64, far, near]);
}

const pad = (s, n) => String(s).padStart(n);
console.log(`light probe: ${A} (light in) against ${B} (light killed)`);
console.log('             opponent = the SMALLER machine box, the one clause F calls "far"');
console.log('');
console.log('  age    ms   |  L mean   L p90   L>25%   L>60%  |  C>25% shipped  C>25% nolight  |  novfx luma');

for (const age of AGES) {
  const cs = centres[age];
  if (!cs || cs.length < 2) { console.log(`  age ${age}: no two machine boxes in ${A}-edge.txt`); continue; }
  const tag = String(age).padStart(2, '0');
  const far = cs.slice().sort((p, q) => p.h - q.h)[0];
  const near = cs.slice().sort((p, q) => p.h - q.h)[1];
  const { L, Csh, Ckl, novSum } = await measure({
    rawA: `${A}-a${tag}-raw.png`,
    rawB: `${B}-a${tag}-raw.png`,
    nov: `${A}-a${tag}-novfx.png`,
    mach: `${A}-a${tag}-mach.png`,
  }, far, near);
  if (!L.length) { console.log(`  age ${age}: empty opponent mask`); continue; }
  const sorted = L.slice().sort((a, b) => a - b);
  const mean = L.reduce((a, b) => a + b, 0) / L.length;
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const pct = (arr, t) => (100 * arr.filter((v) => Math.abs(v) > t).length / arr.length);
  console.log(
    `  ${pad(age, 3)} ${pad(Math.round(age * 1000 / 60), 5)}   |` +
    `${pad(mean.toFixed(1), 8)}${pad(p90.toFixed(1), 8)}` +
    `${pad(pct(L, 25).toFixed(1), 8)}${pad(pct(L, 60).toFixed(1), 8)}  |` +
    `${pad(pct(Csh, 25).toFixed(1), 15)}${pad(pct(Ckl, 25).toFixed(1), 15)}  |` +
    `${pad((novSum / L.length).toFixed(1), 13)}`
  );
}
await browser.close();
