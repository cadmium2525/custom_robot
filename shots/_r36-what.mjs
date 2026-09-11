#!/usr/bin/env node
/**
 * WHAT IS STANDING ON THE OPPONENT — the colour and the intensity of the
 * covering pixels, read off captures already paid for.
 *
 * `_r25-cover.mjs` answers HOW MUCH of the opponent the effect covers. It does
 * not say WHAT is doing the covering, and round 36's second question needs a
 * candidate before it spends a forty-minute `--kill` capture on one. The
 * detonation's stages are not the same colour and they are not alive at the
 * same times, so the pixels themselves narrow the field for free:
 *
 *   flash card + flash core   near-white, dead by 75 ms
 *   fireball cluster + lobes  hot ramp, white -> yellow -> orange -> soot
 *   shock front               hot, dead by 240 ms
 *   dust wave                 neutral grey, 0.17 linear by construction
 *   smoke shells              dark, born 170/245/320 ms, alive past 2 s
 *   rising plume              0.05-0.12 linear, warm brown at the base and
 *                             cold blue-grey at the top, alive past 2 s
 *
 * It reads exactly the same two files `_r25-cover.mjs` reads — `-vfxonly.png`
 * against `-mach.png` — and picks the opponent by exactly the same rule (the
 * SMALLER stencil box), so its rows line up with that meter's row for row and
 * its `nbox` guard is the same guard. **A row it flags with `!` must not be
 * quoted, for the same reason.**
 *
 *   node shots/_r36-what.mjs --prefix shots/r34c-off
 *
 * COLUMNS. All over the opponent's stencil pixels only, on the VFX-only render:
 *
 *   L>25 L>60    the cover meter's own two columns, recomputed here so the two
 *                instruments can be checked against each other rather than
 *                trusted.
 *   Lmed Lp90    median and 90th-percentile luminance of the covering pixels
 *                (those over L 8). 100.0% at L>25 with a median of 30 is a
 *                different defect from 100.0% with a median of 200.
 *   R G B        mean channel values of those same pixels. Fire is strongly
 *                R > G > B; smoke and dust are near-neutral; the plume is dark.
 *   warm         (R - B) / max(R, 1), the one number that separates a hot mass
 *                from a grey one without anybody eyeballing a swatch.
 *
 * IMPORTANT, AND IT IS WHY THE POINT LIGHT CANNOT BE IN THESE NUMBERS.
 * `_r17-blast.mjs`'s VFX_ONLY_FN hides every mesh that is not an effects pool
 * and clears to black. The blast's point light illuminates the arena and the
 * machines, and both are hidden, so what a light contributes to this render is
 * whatever it adds to the effect meshes themselves. It is a render of the
 * effect's own emitted geometry.
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const PREFIX = flag('prefix', 'shots/r34c-off');
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

const meta = JSON.parse(readFileSync(`${PREFIX}-meta.json`, 'utf8'));
const uri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

const ANALYSE = async ({ vfxUri, machUri }) => {
  const load = async (u) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const V = await load(vfxUri);
  const M = await load(machUri);
  if (V.W !== M.W || V.H !== M.H) throw new Error(`size mismatch ${V.W}x${V.H} vs ${M.W}x${M.H}`);

  // Identical construction to _r25-cover.mjs, deliberately: the two meters must
  // pick the same subject by the same rule or their rows cannot be read side by
  // side.
  const seen = new Uint8Array(M.W * M.H);
  const boxes = [];
  const isOn = (i) => M.d[i * 4] > 128;
  const stack = [];
  for (let p = 0; p < M.W * M.H; p++) {
    if (seen[p] || !isOn(p)) continue;
    let x0 = M.W, y0 = M.H, x1 = -1, y1 = -1, n = 0;
    stack.length = 0; stack.push(p); seen[p] = 1;
    while (stack.length) {
      const q = stack.pop();
      const x = q % M.W, y = (q / M.W) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !seen[q - 1] && isOn(q - 1)) { seen[q - 1] = 1; stack.push(q - 1); }
      if (x < M.W - 1 && !seen[q + 1] && isOn(q + 1)) { seen[q + 1] = 1; stack.push(q + 1); }
      if (y > 0 && !seen[q - M.W] && isOn(q - M.W)) { seen[q - M.W] = 1; stack.push(q - M.W); }
      if (y < M.H - 1 && !seen[q + M.W] && isOn(q + M.W)) { seen[q + M.W] = 1; stack.push(q + M.W); }
    }
    if (n > 200) boxes.push({ x0, y0, x1, y1, n });
  }
  boxes.sort((a, b) => b.n - a.n);
  if (!boxes.length) return { err: 'no machine in the stencil' };
  const far = boxes.length > 1 ? boxes[boxes.length - 1] : boxes[0];

  let total = 0, n25 = 0, n60 = 0;
  const lums = [];
  let sr = 0, sg = 0, sb = 0, ncov = 0;
  for (let y = far.y0; y <= far.y1; y++) {
    for (let x = far.x0; x <= far.x1; x++) {
      const i = y * M.W + x;
      if (!isOn(i)) continue;
      total++;
      const r = V.d[i * 4], g = V.d[i * 4 + 1], b = V.d[i * 4 + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (L > 25) n25++;
      if (L > 60) n60++;
      if (L > 8) { lums.push(L); sr += r; sg += g; sb += b; ncov++; }
    }
  }
  lums.sort((a, b) => a - b);
  const pct = (q) => (lums.length ? lums[Math.min(lums.length - 1, Math.floor(q * lums.length))] : 0);
  return {
    boxes: boxes.length,
    px: total,
    cov: ncov,
    l25: total ? (100 * n25) / total : 0,
    l60: total ? (100 * n60) / total : 0,
    lmed: pct(0.5), lp90: pct(0.9),
    r: ncov ? sr / ncov : 0, g: ncov ? sg / ncov : 0, b: ncov ? sb / ncov : 0,
  };
};

const browser = await chromium.launch({
  headless: true,
  executablePath: PINNED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });

console.log(`WHAT IS ON THE OPPONENT — ${PREFIX}   bundle ${meta.bundle}`);
console.log(`  ${meta.arena} @ ${meta.tier}, seed ${meta.seed}, blast tick ${meta.blast.tick}`);
console.log('  opponent = the SMALLER stencil box, same rule as _r25-cover.mjs.\n');
console.log('  age    ms  | nbox    px  |  L>25    L>60 |  Lmed  Lp90 |     R     G     B   warm');

let flagged = 0;
for (const s of meta.shots) {
  const tag = String(s.age).padStart(2, '0');
  const vfx = `${PREFIX}-a${tag}-vfxonly.png`;
  const mach = `${PREFIX}-a${tag}-mach.png`;
  if (!existsSync(vfx) || !existsSync(mach)) continue;
  const r = await page.evaluate(`(${ANALYSE})(${JSON.stringify({ vfxUri: uri(vfx), machUri: uri(mach) })})`);
  if (r.err) { console.log(`  ${String(s.age).padStart(3)}  ${String(s.ms).padStart(4)}  | ${r.err}`); continue; }
  if (r.boxes !== 2) flagged++;
  const f = (v, w = 6, d = 1) => v.toFixed(d).padStart(w);
  const warm = (r.r - r.b) / Math.max(r.r, 1);
  console.log(`  ${String(s.age).padStart(3)}  ${String(s.ms).padStart(4)}  | ${
    String(r.boxes).padStart(3)}${r.boxes === 2 ? ' ' : '!'} ${String(r.px).padStart(5)}  |${
    f(r.l25)}  ${f(r.l60)} |${f(r.lmed, 6, 0)}${f(r.lp90, 6, 0)} |${
    f(r.r, 6, 0)}${f(r.g, 6, 0)}${f(r.b, 6, 0)}  ${f(warm, 5, 2)}`);
}
await browser.close();
if (flagged) {
  console.log(`\n  ! ${flagged} age(s) did not segment to two machine boxes. NEVER QUOTE A FLAGGED ROW.`);
} else {
  console.log('\n  every age segmented to exactly two machine boxes.');
}
