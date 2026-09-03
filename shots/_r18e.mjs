#!/usr/bin/env node
/**
 * THE CLAUSE E BUDGET — how many stage pixels have to come down, and to what
 * level, stated as an exact requirement rather than a direction to push in.
 *
 * Clause E: "machines own >= 50% of the brightest 1% of the frame." Every round
 * so far has read that as a slider — dim the stage a bit, re-photograph, see if
 * the percentage moved — and every round has spent a full capture cycle finding
 * out that it moved by one point. The clause is not a slider. It has a closed
 * form, and this file prints it.
 *
 *   Let N   = pixels in the frame, K = ceil(N/100) = the size of "the top 1%".
 *   Let L*  = the luminance of the machines' (K/2)-th brightest pixel.
 *   Let S(t)= the number of STAGE pixels with luminance >= t.
 *
 *   The final threshold T is whatever makes M(T) + S(T) = K. M is decreasing in
 *   T, so "machines hold at least K/2 of the top 1%" is exactly "T <= L*", and
 *   at T = L* the machines hold exactly K/2. Therefore:
 *
 *       CLAUSE E IS MET  <=>  S(L*) <= K/2.
 *
 * So the whole clause reduces to two numbers that can be read off one dump
 * pair with no rebuild and no capture: **L*, the level the stage has to get
 * under, and S(L*) - K/2, the number of stage pixels that have to leave it.**
 *
 * It also prints the ARITHMETIC CAP, which is the finding this file was written
 * for. The machines cannot own more of the top 1% than they have pixels: if a
 * machine's whole stencil is smaller than K/2, clause E is unreachable in that
 * frame at any lighting whatsoever, and no amount of dimming the stage will
 * move it. That is foundry's situation and it had never been checked.
 *
 * Reads the same pinned dump pair as `shots/_r16chroma.mjs`
 * (`<dir>/<arena>-n.png` + `<dir>/<arena>-mask.png`, from `shots/_r15dump.mjs`),
 * so it is scored on the identical photograph the chroma meter is scored on and
 * no figure has to be carried between two frames.
 *
 * This is NOT a second salience meter. It reports no ranks, no tiles and no
 * coverage; `shots/_salience.mjs` remains the authority for clause E's verdict.
 * This says what would have to change for that verdict to flip.
 *
 *   node shots/_r18e.mjs <dumpDir> <arena>
 *
 * Force-added under shots/ because shots/ is gitignored.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const DIR = args[0], ARENA = args[1];
if (!DIR || !ARENA) { console.error('usage: node shots/_r18e.mjs <dumpDir> <arena>'); process.exit(1); }
if (!existsSync(`${DIR}/${ARENA}-n.png`)) { console.error(`no ${DIR}/${ARENA}-n.png`); process.exit(1); }

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--disable-dev-shm-usage'],
});
const page = await (await browser.newContext()).newPage();
await page.goto('about:blank');

const nb = readFileSync(`${DIR}/${ARENA}-n.png`).toString('base64');
const mb = readFileSync(`${DIR}/${ARENA}-mask.png`).toString('base64');

const out = await page.evaluate(async ({ nb, mb }) => {
  const load = async (b64) => {
    const img = new Image();
    await new Promise((r, e) => { img.onload = r; img.onerror = e; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, img.width, img.height).data, W: img.width, H: img.height };
  };
  const N = await load(nb), M = await load(mb);
  const W = N.W, H = N.H, NP = W * H;
  const K = Math.floor(NP * 0.01);
  const half = Math.ceil(K / 2);

  const mach = [], stage = [];
  let clipM = 0;
  for (let i = 0; i < NP; i++) {
    const r = N.d[i * 4], g = N.d[i * 4 + 1], b = N.d[i * 4 + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (M.d[i * 4] > 127) {
      mach.push(lum);
      if (r >= 254 || g >= 254 || b >= 254) clipM++;
    } else stage.push(lum);
  }
  mach.sort((a, b) => b - a);
  stage.sort((a, b) => b - a);

  const above = (arr, t) => {           // count of arr >= t, arr sorted DESC
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] >= t) lo = m + 1; else hi = m; }
    return lo;
  };

  // The realised top 1% and today's share, so this file reproduces the number
  // the authority meter reports before it says anything about moving it.
  const all = mach.concat(stage).sort((a, b) => b - a);
  const T = all[K - 1];
  const nowM = above(mach, T);

  const reachable = mach.length >= half;
  const Lstar = reachable ? mach[half - 1] : null;
  const sAt = reachable ? above(stage, Lstar) : null;

  // What the stage looks like just above L*, so the demotion has a target that
  // is a level and not a vibe.
  const ladder = [];
  if (reachable) {
    for (const q of [1.0, 0.98, 0.96, 0.94, 0.92, 0.90]) {
      const t = Lstar * q;
      ladder.push({ t, s: above(stage, t), m: above(mach, t) });
    }
  }
  // WHERE the offending stage pixels are, as a coarse map, because "35000 stage
  // pixels are too bright" does not say which surface to go and look at and the
  // last four rounds each spent a capture cycle finding that out by hand.
  const CX = 16, CY = 9;
  const map = new Int32Array(CX * CY);
  if (reachable) {
    for (let i = 0; i < NP; i++) {
      if (M.d[i * 4] > 127) continue;
      const r = N.d[i * 4], g = N.d[i * 4 + 1], b = N.d[i * 4 + 2];
      if (0.2126 * r + 0.7152 * g + 0.0722 * b < Lstar) continue;
      map[(((i / W) | 0) * CY / H | 0) * CX + ((i % W) * CX / W | 0)]++;
    }
  }
  return {
    W, H, NP, K, half, T, nowM, map: Array.from(map), CX, CY,
    nMach: mach.length, nStage: stage.length,
    machMax: mach[0], machP50: mach[Math.floor(mach.length / 2)],
    clipM, reachable, Lstar, sAt, ladder,
  };
}, { nb, mb });

await browser.close();

const p = (n, d = 1) => n.toFixed(d);
console.log(`\nCLAUSE E BUDGET — ${DIR} / ${ARENA}  (${out.W}x${out.H})`);
console.log(`  frame ${out.NP} px;  top 1% = K = ${out.K} px;  clause E needs K/2 = ${out.half} of them to be machine`);
console.log(`  machine stencil: ${out.nMach} px (${p(100 * out.nMach / out.NP, 2)}% of frame), max lum ${p(out.machMax)}, median ${p(out.machP50)}, clipped ${p(100 * out.clipM / out.nMach, 2)}%`);
console.log(`  today: threshold ${p(out.T)}, machines hold ${out.nowM} of ${out.K} = ${p(100 * out.nowM / out.K)}%`);

if (!out.reachable) {
  console.log(`\n  *** CLAUSE E IS ARITHMETICALLY UNREACHABLE IN THIS FRAME ***`);
  console.log(`  The machines have ${out.nMach} pixels and the clause asks them to own ${out.half}.`);
  console.log(`  Even a perfectly black stage caps them at ${p(100 * out.nMach / out.K)}%. No lighting`);
  console.log(`  change can move this; only a bigger machine in frame can (clause G).`);
} else {
  console.log(`\n  L* = ${p(out.Lstar)}  — the machines' ${out.half}th brightest pixel.`);
  console.log(`  S(L*) = ${out.sAt} stage pixels are at or above it; the budget is ${out.half}.`);
  if (out.sAt <= out.half) console.log(`  -> CLAUSE E MET (S(L*) <= K/2), with ${out.half - out.sAt} px of slack.`);
  else console.log(`  -> NOT MET. ${out.sAt - out.half} stage pixels must drop below ${p(out.Lstar)}. That is ${p(100 * (out.sAt - out.half) / out.NP, 3)}% of the frame.`);
  console.log(`\n  the stage tail, so the demotion has a target:`);
  console.log(`     level      stage px >= level    machine px >= level`);
  for (const r of out.ladder) console.log(`    ${p(r.t).padStart(6)}   ${String(r.s).padStart(16)}   ${String(r.m).padStart(18)}`);
  console.log(`\n  where the stage pixels above L* are (${out.CX}x${out.CY} cells over the frame, px per cell):`);
  for (let y = 0; y < out.CY; y++) {
    let line = '   ';
    for (let x = 0; x < out.CX; x++) line += String(out.map[y * out.CX + x]).padStart(7);
    console.log(line);
  }
}
console.log('');
