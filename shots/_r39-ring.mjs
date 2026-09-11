#!/usr/bin/env node
/**
 * THE DILATED-RING COLUMN — RULING 36's instrument, built.
 *
 * RULING 36 ruled the 800 ms row a FAIL and then said, in the same breath, that
 * EVERY L>25 cell in clause F sub-2 is an UPPER BOUND until this column exists:
 *
 *   "Clause F sub-2's currency is the legibility of the aiming target. An outline
 *    is a step across a boundary, not a brightness. A veil that covers the target
 *    AND ITS BACKGROUND EQUALLY preserves the step and the machine stays readable;
 *    a veil that stops at the silhouette destroys it, at any intensity. ... The
 *    instrument is one addition to `_r25-cover.mjs`: report the effect's coverage
 *    of a dilated ring OUTSIDE the machine's stencil beside its coverage of the
 *    machine."
 *
 * That was three rounds ago and it has been rank 3 on the list ever since. It is
 * built here as a separate file rather than folded into `_r25-cover.mjs`, for one
 * reason: the cover meter is the instrument every filed F sub-2 figure was taken
 * on, and changing it changes what "the same meter, before and after" means. This
 * one CROSS-CHECKS against it instead — it reproduces the cover meter's own L>25
 * column to the digit as a health check, on the same PNGs, and refuses to print a
 * ring number for any age where it does not.
 *
 *   node shots/_r39-ring.mjs --prefix shots/r37-p1195-base
 *
 * WHAT IT READS. Nothing new. `_r17-blast.mjs` already writes `-a<NN>-vfxonly.png`
 * (the effects layer alone, everything else hidden, cleared to black) and
 * `-a<NN>-mach.png` (the machine stencil). This is entirely offline: it spends no
 * capture and it can be run against any post-round-34 capture in the tree.
 *
 * THE MEASUREMENT.
 *
 *   IN    the opponent's own connected component, exactly — not its bounding box.
 *   RING  the pixels within `w` px of that component, MINUS the component, MINUS
 *         every other machine-stencil pixel. So the ring is background that the
 *         opponent's outline is drawn against, and it can contain no machine.
 *
 * Coverage is computed identically on both, at the same three cuts, so the two
 * numbers are the same measurement pointed at two sides of one boundary.
 *
 * THE INSTRUMENT'S OWN SENSITIVITY IS MEASURED, NOT ASSUMED. `w` is an arbitrary
 * parameter and a column whose value depends on an arbitrary parameter is a knob.
 * So it sweeps `--w 4,6,8` by default and prints the SPREAD of the ring figure
 * across the three widths beside the figure. That spread is this column's noise
 * floor, derived rather than declared, and a difference smaller than it is not a
 * finding. This document has four instrument faults of the shape "a number that
 * was really a parameter"; that is the cheapest possible guard against a fifth.
 *
 * WHAT IT DOES NOT DO. It does not rule. `IN - RING` near zero says the effect
 * covered the target and its background alike; it does not by itself say the
 * machine is legible, because a uniform veil at alpha `a` attenuates the outline
 * step by `(1-a)` even when it destroys no boundary. The ruling that uses these
 * numbers has to say which of those it is claiming. See RULING 41.
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

const PREFIX = flag('prefix', 'shots/r37-p1195-base');
const WIDTHS = String(flag('w', '4,6,8')).split(',').map(Number);
const CUT = Number(flag('cut', 25));
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

if (!existsSync(`${PREFIX}-meta.json`)) {
  console.error(`no ${PREFIX}-meta.json — this meter reads a capture, it does not take one`);
  process.exit(1);
}
const meta = JSON.parse(readFileSync(`${PREFIX}-meta.json`, 'utf8'));
const uri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

const ANALYSE = async ({ vfxUri, machUri, widths, cut }) => {
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
  if (V.W !== M.W || V.H !== M.H) return { err: `size mismatch ${V.W}x${V.H} vs ${M.W}x${M.H}` };
  const W = M.W, H = M.H, NP = W * H;

  // ---- machine components, the cover meter's rule, restated so the two agree
  //      by construction rather than by luck.
  const label = new Int32Array(NP).fill(-1);
  const isOn = (i) => M.d[i * 4] > 128;
  const comps = [];
  const stack = [];
  for (let p = 0; p < NP; p++) {
    if (label[p] >= 0 || !isOn(p)) continue;
    const id = comps.length;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    stack.length = 0; stack.push(p); label[p] = id;
    while (stack.length) {
      const q = stack.pop();
      const x = q % W, y = (q / W) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && label[q - 1] < 0 && isOn(q - 1)) { label[q - 1] = id; stack.push(q - 1); }
      if (x < W - 1 && label[q + 1] < 0 && isOn(q + 1)) { label[q + 1] = id; stack.push(q + 1); }
      if (y > 0 && label[q - W] < 0 && isOn(q - W)) { label[q - W] = id; stack.push(q - W); }
      if (y < H - 1 && label[q + W] < 0 && isOn(q + W)) { label[q + W] = id; stack.push(q + W); }
    }
    comps.push({ id, x0, y0, x1, y1, n });
  }
  const big = comps.filter((c) => c.n > 200);
  if (!big.length) return { err: 'no machine in the stencil' };
  big.sort((a, b) => b.n - a.n);
  const far = big.length > 1 ? big[big.length - 1] : big[0];

  const lum = (i) => 0.2126 * V.d[i * 4] + 0.7152 * V.d[i * 4 + 1] + 0.0722 * V.d[i * 4 + 2];

  // ---- IN: the opponent's component, exactly.
  const inPx = [];
  for (let p = 0; p < NP; p++) if (label[p] === far.id) inPx.push(p);

  // ---- The cover meter's OWN rule, reproduced, so this file can be checked
  //      against the instrument every filed figure was taken on: it walks the
  //      far BOX and takes any on-stencil pixel in it. Where the two disagree,
  //      another component intrudes into the box and the row is suspect.
  let boxTotal = 0, boxHit = 0;
  for (let y = far.y0; y <= far.y1; y++) {
    for (let x = far.x0; x <= far.x1; x++) {
      const i = y * W + x;
      if (!isOn(i)) continue;
      boxTotal++;
      if (lum(i) > cut) boxHit++;
    }
  }

  // ---- RING: multi-source BFS outward from the opponent's component, stopping
  //      at `w` px. Any machine-stencil pixel is excluded from the ring at every
  //      width, so the ring is background and can hold no part of either machine.
  const dist = new Int32Array(NP).fill(-1);
  let frontier = inPx.slice();
  for (const p of frontier) dist[p] = 0;
  const maxW = Math.max(...widths);
  for (let step = 1; step <= maxW; step++) {
    const next = [];
    for (const q of frontier) {
      const x = q % W, y = (q / W) | 0;
      const push = (r) => { if (dist[r] < 0) { dist[r] = step; next.push(r); } };
      if (x > 0) push(q - 1);
      if (x < W - 1) push(q + 1);
      if (y > 0) push(q - W);
      if (y < H - 1) push(q + W);
    }
    frontier = next;
    if (!frontier.length) break;
  }

  const stat = (pixels) => {
    let hit = 0;
    const vals = [];
    for (const p of pixels) { const L = lum(p); if (L > cut) hit++; vals.push(L); }
    vals.sort((a, b) => a - b);
    return {
      px: pixels.length,
      pct: pixels.length ? (100 * hit) / pixels.length : 0,
      med: vals.length ? Math.round(vals[Math.floor(vals.length / 2)]) : 0,
    };
  };

  const rings = [];
  for (const w of widths) {
    const ring = [];
    for (let p = 0; p < NP; p++) {
      if (dist[p] >= 1 && dist[p] <= w && !isOn(p)) ring.push(p);
    }
    rings.push({ w, ...stat(ring) });
  }

  return {
    boxes: big.length,
    inside: stat(inPx),
    boxTotal,
    boxPct: boxTotal ? (100 * boxHit) / boxTotal : 0,
    rings,
  };
};

const browser = await chromium.launch({
  headless: true,
  executablePath: PINNED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });

console.log(`DILATED-RING COLUMN (RULING 36) — ${PREFIX}   bundle ${meta.bundle}`);
console.log(`  ${meta.arena} @ ${meta.tier}, seed ${meta.seed}, blast tick ${meta.blast.tick}, cut L>${CUT}`);
console.log(`  IN   = the opponent's own connected component (NOT its box)`);
console.log(`  RING = within w px of it, minus it, minus every machine-stencil pixel`);
console.log(`  widths ${WIDTHS.join('/')} px; SPREAD is this column's own noise floor, derived not declared\n`);
console.log('  age    ms  | nbox   in px   IN%   Lmed |  ring px   RING%  spread  Lmed |   IN-RING  | xcheck');

let missing = 0, disagree = 0;
const table = [];
for (const s of meta.shots) {
  const tag = String(s.age).padStart(2, '0');
  const vfx = `${PREFIX}-a${tag}-vfxonly.png`;
  const mach = `${PREFIX}-a${tag}-mach.png`;
  if (!existsSync(vfx) || !existsSync(mach)) { missing++; continue; }
  const r = await page.evaluate(`(${ANALYSE})(${JSON.stringify({
    vfxUri: uri(vfx), machUri: uri(mach), widths: WIDTHS, cut: CUT,
  })})`);
  if (r.err) { console.log(`  ${String(s.age).padStart(3)}  ${String(s.ms).padStart(4)}  | ${r.err}`); continue; }

  const mid = r.rings[Math.floor(r.rings.length / 2)];
  const spread = Math.max(...r.rings.map((x) => x.pct)) - Math.min(...r.rings.map((x) => x.pct));
  // Health check: this file's own IN% against the cover meter's box-walk rule.
  const dx = Math.abs(r.inside.pct - r.boxPct);
  const ok = dx < 0.05;
  if (!ok) disagree++;
  const f = (v, n = 6) => v.toFixed(1).padStart(n);
  console.log(`  ${String(s.age).padStart(3)}  ${String(s.ms).padStart(4)}  | ${
    String(r.boxes).padStart(3)}${r.boxes === 2 ? ' ' : '!'} ${
    String(r.inside.px).padStart(6)} ${f(r.inside.pct)}  ${String(r.inside.med).padStart(4)} | ${
    String(mid.px).padStart(7)}  ${f(mid.pct)}  ${f(spread, 6)}  ${String(mid.med).padStart(4)} | ${
    f(r.inside.pct - mid.pct, 8)}   | ${ok ? 'ok' : `DISAGREES ${dx.toFixed(2)}`}`);
  table.push({ ms: s.ms, boxes: r.boxes, inPct: r.inside.pct, ringPct: mid.pct, spread, ok });
}

await browser.close();

if (missing === meta.shots.length) {
  console.error(`\nno -vfxonly.png for any age under ${PREFIX} — nothing was measured`);
  process.exit(1);
}
if (missing) console.log(`\n  ${missing} age(s) had no PNG pair and were skipped`);
if (disagree) {
  console.log(`\n  ! ${disagree} age(s) where this file's IN% differs from the cover meter's box-walk`);
  console.log('    rule by more than 0.05. On those rows another component intrudes into the');
  console.log("    opponent's bounding box; read them as suspect until the stencil is checked.");
} else {
  console.log('\n  every age reproduces `_r25-cover.mjs`\'s subject rule to within 0.05 points.');
}

const worstSpread = table.length ? Math.max(...table.map((t) => t.spread)) : 0;
console.log(`\n  WIDEST SPREAD ACROSS w = ${WIDTHS.join('/')} px: ${worstSpread.toFixed(2)} points.`);
console.log('  That is the floor for any IN-RING difference quoted off this column.');
