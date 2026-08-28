#!/usr/bin/env node
/**
 * r8sal — offline re-measurement of the two stage residuals, from the SAME
 * pinned dump pair that mass2.mjs counts (`<arena>-n.png` + `<arena>-mask.png`,
 * settled frame, VFX off, DOM hidden, stencil mask for the machines).
 *
 * Round 6 left two residuals against the stage and round 7 did not re-measure
 * either. This tool answers both from one photograph, offline, so it can be run
 * against any number of builds without re-staging anything:
 *
 *  (a) THE SALIENCE RANKS. 80x80 windows on a 40px stride, ranked by mean
 *      luminance — "the brightness-weighted salience sweep". Prints the top 12
 *      non-overlapping picks with each window's robot coverage, AND, because
 *      the top-12 list can hide a regression, the best rank achieved by any
 *      window inside a named rect (--rect x0,y0,x1,y1) and the best rank
 *      achieved by any window that is >=50% machine.
 *
 *  (b) THE COLOUR FAMILIES. Coverage-weighted, which is the instrument this
 *      document settled on: what share of the frame is cyan / amber, at what
 *      mean luminance and saturation, against what the machines get.
 *      The family definitions are MINE and are stated here rather than
 *      inherited, so the only honest use of them is a delta between two builds
 *      measured with this same file:
 *          cyan   hue 165..200 deg, sat >= 0.35, non-machine
 *          amber  hue  20..55  deg, sat >= 0.35, non-machine
 *
 *   node shots/_sal.mjs <dumpDir> <arena> [--rect x0,y0,x1,y1]
 *
 * ROUND 12 — provenance and one caveat, added when this file was force-added
 * under shots/ so it stops evaporating. This is round 8's tool verbatim; it
 * produced the numbers behind blind point 1's chroma FAIL and point 2's FAIL,
 * it then lived only in a scratch directory, and rounds 9, 10 and 11 all
 * declined to re-measure those entries partly because re-deriving it was the
 * cost of doing so. Get the dump pairs it reads from `shots/_dump.sh`.
 *
 * The caveat is on `sat >= 0.35`. S = (max-min)/max is scale-free, so RGB
 * (2,3,12) scores 0.75 and a frame can be reported 80% saturated while reading
 * as monochrome. Round 12 checked whether that invalidated round 8's figures
 * and it does NOT: gating the same filter at L >= 40 moves grid 59.2 -> 59.0,
 * foundry 89.7 -> 89.6 and orbital 59.5 -> 59.3 on round 8's own dumps. The
 * filter is safe at the exposure of a settled arena frame. It is NOT safe on a
 * frame dimmed by a title card or a scrim — on the round-11 phone captures the
 * gate moves 73.9% to 9.1% — so do not carry these numbers to a phone capture
 * without re-gating. `shots/_framesal.mjs` reports both filters side by side.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const DIR = args[0], ARENA = args[1];
const ri = args.indexOf('--rect');
const RECT = ri >= 0 ? args[ri + 1].split(',').map(Number) : null;
if (!existsSync(`${DIR}/${ARENA}-n.png`)) { console.error(`no ${DIR}/${ARENA}-n.png`); process.exit(1); }

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await (await browser.newContext()).newPage();
await page.goto('about:blank');

const FN = async ({ nUri, mUri, rect }) => {
  const load = async (src) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = src; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  };
  const N = await load(nUri), M = await load(mUri);
  const W = N.width, H = N.height, NP = W * H;
  const L = new Float32Array(NP), S = new Float32Array(NP), HU = new Float32Array(NP);
  const mask = new Uint8Array(NP);
  let maskN = 0;
  for (let p = 0, i = 0; p < NP; p++, i += 4) {
    const r = N.data[i], g = N.data[i + 1], b = N.data[i + 2];
    L[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    S[p] = mx ? d / mx : 0;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    HU[p] = h;
    const ml = 0.2126 * M.data[i] + 0.7152 * M.data[i + 1] + 0.0722 * M.data[i + 2];
    if (ml > 128) { mask[p] = 1; maskN++; }
  }

  // --- (a) window sweep -------------------------------------------------
  const WIN = 80, STRIDE = 40;
  const wins = [];
  for (let y = 0; y + WIN <= H; y += STRIDE) {
    for (let x = 0; x + WIN <= W; x += STRIDE) {
      let s = 0, m = 0;
      for (let j = 0; j < WIN; j += 2) for (let i2 = 0; i2 < WIN; i2 += 2) {
        const p = (y + j) * W + (x + i2);
        s += L[p]; if (mask[p]) m++;
      }
      const n = (WIN / 2) * (WIN / 2);
      wins.push({ x, y, mean: Math.round(s / n * 10) / 10, robotPct: Math.round(m / n * 1000) / 10 });
    }
  }
  wins.sort((a, b) => b.mean - a.mean);
  const picks = [];
  for (const w of wins) {
    if (picks.some((p) => Math.abs(p.x - w.x) < WIN && Math.abs(p.y - w.y) < WIN)) continue;
    picks.push(w);
    if (picks.length >= 12) break;
  }
  let bestRobot = -1, bestRect = -1, rectWin = null, robotWin = null;
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    if (bestRobot < 0 && w.robotPct >= 50) { bestRobot = i + 1; robotWin = w; }
    if (rect && bestRect < 0) {
      const cx = w.x + WIN / 2, cy = w.y + WIN / 2;
      if (cx >= rect[0] && cx <= rect[2] && cy >= rect[1] && cy <= rect[3]) { bestRect = i + 1; rectWin = w; }
    }
  }

  // --- (b) colour families ---------------------------------------------
  const fam = (test) => {
    let n = 0, ls = 0, ss = 0;
    for (let p = 0; p < NP; p++) if (test(p)) { n++; ls += L[p]; ss += S[p]; }
    return { pct: Math.round(n / NP * 1000) / 10, mean: Math.round(ls / Math.max(1, n) * 10) / 10, sat: Math.round(ss / Math.max(1, n) * 1000) / 1000, n };
  };
  // Conditional saturation, because comparing a family that was SELECTED for
  // sat>=0.35 against a machine mean taken over every pixel including its own
  // black line art is not a comparison. Both sides get the same filter here.
  const satOf = (test) => {
    let n = 0, ns = 0, ss = 0;
    for (let p = 0; p < NP; p++) if (test(p)) { n++; if (S[p] >= 0.35) { ns++; ss += S[p]; } }
    return { pct: Math.round(ns / NP * 1000) / 10, ofSelf: Math.round(ns / Math.max(1, n) * 1000) / 10, sat: Math.round(ss / Math.max(1, ns) * 1000) / 1000 };
  };
  const satMach = satOf((p) => mask[p] === 1);
  const satScene = satOf((p) => !mask[p]);

  const cyan = fam((p) => !mask[p] && S[p] >= 0.35 && HU[p] >= 165 && HU[p] < 200);
  const amber = fam((p) => !mask[p] && S[p] >= 0.35 && HU[p] >= 20 && HU[p] < 55);
  const mach = fam((p) => mask[p] === 1);
  const scene = fam((p) => !mask[p]);

  // top-1% ownership
  const sorted = Float32Array.from(L).sort();
  const t1 = sorted[Math.floor(NP * 0.99)];
  let t1n = 0, t1m = 0, t1c = 0, t1a = 0;
  for (let p = 0; p < NP; p++) if (L[p] >= t1) {
    t1n++;
    if (mask[p]) t1m++;
    else if (S[p] >= 0.35 && HU[p] >= 165 && HU[p] < 200) t1c++;
    else if (S[p] >= 0.35 && HU[p] >= 20 && HU[p] < 55) t1a++;
  }

  return {
    screen: `${W}x${H}`, picks, bestRobot, robotWin, bestRect, rectWin,
    fams: { cyan, amber, mach, scene }, satMach, satScene,
    top1: { thr: Math.round(t1 * 10) / 10, n: t1n, machPct: Math.round(t1m / t1n * 1000) / 10, cyanPct: Math.round(t1c / t1n * 1000) / 10, amberPct: Math.round(t1a / t1n * 1000) / 10 },
  };
};

const r = await page.evaluate(FN, {
  nUri: 'data:image/png;base64,' + readFileSync(`${DIR}/${ARENA}-n.png`).toString('base64'),
  mUri: 'data:image/png;base64,' + readFileSync(`${DIR}/${ARENA}-mask.png`).toString('base64'),
  rect: RECT,
});

console.log(`\nR8SAL — ${DIR} / ${ARENA}  (${r.screen})`);
console.log('  brightness-weighted salience sweep, 80px windows / 40px stride:');
r.picks.forEach((p, i) => console.log(`   ${String(i + 1).padStart(2)}. mean ${String(p.mean).padStart(6)}  at ${String(p.x).padStart(4)},${String(p.y).padStart(3)}  robot ${String(p.robotPct).padStart(5)}%`));
console.log(`  best rank of a >=50%-machine window: ${r.bestRobot}  (mean ${r.robotWin?.mean} at ${r.robotWin?.x},${r.robotWin?.y}, robot ${r.robotWin?.robotPct}%)`);
if (RECT) console.log(`  best rank inside rect ${RECT.join(',')}: ${r.bestRect}  (mean ${r.rectWin?.mean} at ${r.rectWin?.x},${r.rectWin?.y})`);
console.log('\n  coverage-weighted colour families (non-machine pixels only for cyan/amber):');
console.log('                 pct of frame   mean lum   mean sat');
for (const [k, v] of [['cyan family', r.fams.cyan], ['amber family', r.fams.amber], ['MACHINES', r.fams.mach], ['rest of scene', r.fams.scene]]) {
  console.log(`  ${k.padEnd(15)} ${String(v.pct).padStart(8)}%  ${String(v.mean).padStart(9)}  ${String(v.sat).padStart(9)}`);
}
console.log(`\n  saturated pixels (sat >= 0.35), same filter on both sides:`);
console.log(`    machines: ${r.satMach.pct}% of frame, ${r.satMach.ofSelf}% of the machines' own pixels, mean sat ${r.satMach.sat}`);
console.log(`    stage:    ${r.satScene.pct}% of frame, ${r.satScene.ofSelf}% of the stage's own pixels, mean sat ${r.satScene.sat}`);
console.log(`\n  brightest 1% of the frame (threshold ${r.top1.thr}, ${r.top1.n}px): machines own ${r.top1.machPct}%, cyan ${r.top1.cyanPct}%, amber ${r.top1.amberPct}%`);
await browser.close();
