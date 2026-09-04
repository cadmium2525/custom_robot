#!/usr/bin/env node
/**
 * PER-MACHINE LUMA AND CHROMA, ON THE FRAME BEFORE ANY EFFECT IS DRAWN.
 *
 * RULING 29 granted this column and named the reason. `3a0f570` established, and
 * declined to work around, that `_r17-edge.mjs`'s CHROMA row averages BOTH
 * machines across the whole frame:
 *
 *     CHROMA  effect sat 0.481   machines sat 0.409   stage sat 0.384
 *
 * At 117 ms only the FAR machine is hit-flashed, and it is 93 px tall against
 * the near machine's 256. So a chroma change confined to the flashed machine
 * moves that row by roughly its area share and is indistinguishable from noise —
 * which is why the commit filed NO chroma result rather than a small one. That
 * was the right call and this is the instrument that makes it unnecessary next
 * time.
 *
 *   node shots/_r32-permach.mjs --prefix shots/r32c
 *
 * WHAT IT READS, AND WHY IT IS THE NOVFX FRAME
 * ---------------------------------------------------------------------------
 * The clause the hit tell is aimed at is "the aiming target is not white before
 * any effect is drawn over it" — RULING 26's leg 1, threshold 150 luma. That is
 * a statement about `<prefix>-a<NN>-novfx.png`, the frozen frame with the VFX
 * layer hidden, which the capture already writes. Measuring the tell on the raw
 * frame would measure the fireball sitting on top of it.
 *
 * THE SPLIT, AND THE STANDING RULE IT OBEYS
 * ---------------------------------------------------------------------------
 * "A meter that selects its own subject must print the selection." The two
 * machines come from connected components of the capture's own `-mach.png`
 * stencil, exactly as `_r25-cover.mjs` derives them, and EVERY component is
 * printed with its box and pixel count — not just the two that survive. The
 * opponent is the smaller box, which is the same rule `_r25-cover.mjs` and
 * `_r23-lightprobe.mjs` use, so the three agree by construction.
 *
 * CHROMA is `(max - min) / 255` per pixel, the same definition
 * `shots/_r16chroma.mjs` and `shots/_salience.mjs` use, and the MEDIAN is
 * reported because clause D is written on a median. Mean saturation is printed
 * beside it because `_r17-edge.mjs`'s row is a mean and the two must be
 * comparable when somebody quotes them together.
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf('--' + n);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const PREFIX = flag('prefix', 'shots/r32c');
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const meta = JSON.parse(readFileSync(PREFIX + '-meta.json', 'utf8'));
const uri = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');

const ANALYSE = async ({ imgUri, machUri }) => {
  const load = async (u) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const F = await load(imgUri);
  const M = await load(machUri);
  if (F.W !== M.W || F.H !== M.H) throw new Error('size mismatch');

  // Connected components of the stencil. Iterative flood fill: the frames here
  // are 1600x900 and a recursive one blows the stack on the near machine.
  const seen = new Uint8Array(M.W * M.H);
  const comps = [];
  for (let p = 0; p < M.W * M.H; p++) {
    if (seen[p] || M.d[p * 4] <= 128) continue;
    const stack = [p];
    seen[p] = 1;
    const px = [];
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    while (stack.length) {
      const q = stack.pop();
      px.push(q);
      const x = q % M.W, y = (q / M.W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [x > 0 ? q - 1 : -1, x < M.W - 1 ? q + 1 : -1, y > 0 ? q - M.W : -1, y < M.H - 1 ? q + M.W : -1];
      for (const n of nb) if (n >= 0 && !seen[n] && M.d[n * 4] > 128) { seen[n] = 1; stack.push(n); }
    }
    comps.push({ px, box: (x1 - x0 + 1) + 'x' + (y1 - y0 + 1), x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  comps.sort((a, b) => b.px.length - a.px.length);

  const stat = (c) => {
    let lsum = 0;
    const chr = [];
    for (const q of c.px) {
      const r = F.d[q * 4], g = F.d[q * 4 + 1], b = F.d[q * 4 + 2];
      lsum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      chr.push((Math.max(r, g, b) - Math.min(r, g, b)) / 255);
    }
    chr.sort((a, b) => a - b);
    const n = chr.length;
    return {
      n,
      box: c.box,
      h: c.h,
      lum: lsum / n,
      chromaMed: n % 2 ? chr[(n - 1) >> 1] : (chr[n / 2 - 1] + chr[n / 2]) / 2,
      chromaMean: chr.reduce((a, b) => a + b, 0) / n,
    };
  };
  return comps.map(stat);
};

(async () => {
  const browser = await chromium.launch({ executablePath: PINNED, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const say = (s) => console.log(s);

  say('PER-MACHINE LUMA AND CHROMA on the NOVFX frame — ' + PREFIX + '   bundle ' + (meta.bundle || '?'));
  say('  ' + (meta.arena || '?') + ' @ ' + (meta.tier || '?') + ', seed ' + (meta.seed || '?') + ', blast tick ' + (meta.tick || meta.blastTick || '?'));
  say('  RULING 26 leg 1 threshold: the OPPONENT (smaller box) under 150 luma before any effect.');
  say('');
  say('  age    ms  | ncomp |          NEAR (larger)          |         OPPONENT (smaller)');
  say('             |       |   box     px    luma  chroMed   |   box     px    luma  chroMed   leg1');

  const ages = (meta.ages || [1, 7, 14, 20, 26, 32, 48]);
  const msOf = (t) => Math.round((t / 60) * 1000);
  for (const age of ages) {
    const tag = String(age).padStart(2, '0');
    const f = PREFIX + '-a' + tag + '-novfx.png';
    const m = PREFIX + '-a' + tag + '-mach.png';
    if (!existsSync(f) || !existsSync(m)) { say('  age ' + tag + ': missing capture'); continue; }
    const r = await page.evaluate(ANALYSE, { imgUri: uri(f), machUri: uri(m) });
    const big = r[0], small = r[1];
    const cell = (s) => s
      ? (s.box.padStart(7) + ' ' + String(s.n).padStart(6) + ' ' + s.lum.toFixed(1).padStart(7) + ' ' + s.chromaMed.toFixed(3).padStart(8))
      : '        -      -       -        -';
    const leg1 = small ? (small.lum < 150 ? 'MET' : 'MISS') : '-';
    say('  ' + String(age).padStart(3) + ' ' + String(msOf(age)).padStart(5) + '  |' +
      String(r.length).padStart(5) + '  | ' + cell(big) + '  | ' + cell(small) + '  ' + leg1);
    if (r.length > 2) say('        components beyond the two machines, printed because a meter may not choose in silence: ' +
      r.slice(2).map((s) => s.box + '/' + s.n + 'px').join(' '));
  }
  say('');
  say('  chroMed is median (max-min)/255 over that machine own pixels — the same definition');
  say('  _r16chroma.mjs scores clause D on, restricted to one machine instead of both.');
  await browser.close();
})();
