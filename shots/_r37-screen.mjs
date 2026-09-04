#!/usr/bin/env node
/**
 * THE PIN SCREEN — RULING 38's two gates, run as one command.
 *
 * RULING 34 withdrew four rounds of clause F sub-2 findings because the card was
 * a sample of one pin. RULING 35 replaced it with an enumerated pin set. RULING
 * 38 then amended that before it was used, because the first pin taken from
 * another arena — foundry 1198 — passed the geometric screen at `in = 1.00` and
 * then failed `shots/_r25-cover.mjs`'s subject-selection guard at six of seven
 * ages: that arena's near machine stands among occluders that cut its stencil
 * into one piece or three. A set screened on geometry alone silently becomes
 * "the pins where the stencil happened to segment", which is the sample-of-one
 * problem with more steps.
 *
 * So a pin needs BOTH:
 *
 *   GEOMETRIC   `in >= 1.00 AND d < fd` — the opponent inside the blast's
 *               projected disc AND the blast nearer the camera than the
 *               opponent. `in` alone is a projected-disc overlap with no depth,
 *               which is why RULING 38 demoted it from predictor to candidate
 *               generator: it read 1.00 at foundry 1198, which covers 26.8%, and
 *               1.00 at grid 956, which covers 100.0%. Both numbers are correct
 *               and the column simply does not answer the question.
 *
 *   ADMISSIBLE  the machine stencil segments to exactly TWO boxes at every age
 *               being scored, so "the opponent" is a machine rather than a
 *               fragment of one.
 *
 *   node shots/_r37-screen.mjs --base <url> --arena grid --scan 2400
 *
 * It runs the geometric screen off the scan listing for free, then spends one
 * `--stenconly` capture per surviving candidate — roughly a fifth of a full
 * capture, because four of the five passes are not consulted to count boxes.
 *
 * IT PUBLISHES THE REJECTIONS. Every candidate is printed with the screen it
 * failed and the numbers it failed on. A pin set quoted without its rejections
 * is not a set, it is a selection, and this document has been burned by exactly
 * that twice.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4400/custom_robot/');
const ARENA = flag('arena', 'grid');
const SCAN = Number(flag('scan', 2400));
const SEED = Number(flag('seed', 1234567));
const AGES = String(flag('ages', '1,7,14,20,26,32,48'));
const MAX = Number(flag('max', 6));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// ---------------------------------------------------------------------------
// GATE 1 — geometric, off the scan listing, free.
// ---------------------------------------------------------------------------

const scan = spawnSync(process.execPath, [
  'shots/_r17-blast.mjs', '--base', BASE, '--arena', ARENA,
  '--seed', String(SEED), '--scan', String(SCAN), '--list',
], { encoding: 'utf8' });

if (scan.status !== 0) {
  console.error(scan.stderr || 'scan failed');
  process.exit(1);
}

const rows = [];
for (const line of scan.stdout.split('\n')) {
  const m = line.match(/blast @tick (\d+) .*?\bd=([\d.]+)m\b.*?\bfd=([\d.]+)m\b.*?\bin=([\d.]+)\b.*?\bd3=([\d.]+)\b/);
  if (!m) continue;
  rows.push({ tick: +m[1], d: +m[2], fd: +m[3], in: +m[4], d3: +m[5], line: line.trim() });
}

if (!rows.length) {
  console.error(`no blasts parsed from the scan of ${ARENA} — has the listing format changed?`);
  process.exit(1);
}

/**
 * GATE 1, ROUND 37: three terms, not two.
 *
 * RULING 38 gave `in >= 1.00 AND d < fd`. Both are about the SCREEN: the blast's
 * disc covers the opponent's, and the blast is in front. Neither says the
 * opponent is INSIDE the fire — and the first pin this screen accepted, grid 838,
 * reads `d3 = 2.32`, the same defect as pin 956 at 2.37. Both have the opponent
 * more than two mass radii OUTSIDE the fire, with the cell reading high purely
 * because the blast stands between it and the camera. At 956 the bomb in fact
 * went off on the NEAR machine, 2.65 m away, inside its mass.
 *
 * `d3 < 1.0` is the term that separates "the effect swallowed the opponent" from
 * "the effect was in the way". Clause F sub-2 asks the first question, so a pin
 * that only satisfies the second is not evidence about the clause.
 *
 * AND `d < fd` IS DROPPED, which is a correction to RULING 38 rather than an
 * implementation choice. Pin 1195 — the pin this project's entire card was built
 * on for six rounds — reads `d = 16.1 m` against `fd = 14.3 m`, so the blast's
 * CENTRE is 1.8 m behind the opponent and the term rejects it. But the blast is
 * a volume: R 3.4 m, mass radius about 5.1 m, and `d3 = 0.72` says the opponent
 * is well inside the fire. A centre-distance comparison cannot express "inside a
 * sphere" and rejects exactly the pins where the clause's premise holds.
 *
 * `d3 < 1.0` already subsumes what `d < fd` was reaching for and does it in three
 * dimensions, so the two-term gate is strictly worse than the one-term gate that
 * replaces it.
 */
const g1 = [];
const rejGeo = [];
for (const r of rows) {
  if (r.in >= 1.0 && r.d3 < 1.0) g1.push(r);
  else rejGeo.push(r);
}
g1.sort((a, b) => (b.in - a.in) || (a.d - b.d));

console.log(`PIN SCREEN — ${ARENA}, seed ${SEED}, ${SCAN} ticks`);
console.log(`  gate 1 (geometric): in >= 1.00 AND d3 < 1.00   (RULING 38's d < fd is DROPPED, see the note)`);
console.log(`  gate 2 (admissible): stencil segments to exactly 2 machine boxes at every age\n`);
console.log(`  ${rows.length} blasts scanned, ${g1.length} pass gate 1, ${rejGeo.length} rejected\n`);

// ---------------------------------------------------------------------------
// GATE 2 — admissibility, one stencil-only capture per survivor.
// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(PINNED) ? PINNED : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });

const COUNT = async ({ machUri }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = machUri; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const { data: d, width: W, height: H } = g.getImageData(0, 0, c.width, c.height);
  const seen = new Uint8Array(W * H);
  const on = (i) => d[i * 4] > 128;
  let n = 0;
  const stack = [];
  for (let p = 0; p < W * H; p++) {
    if (seen[p] || !on(p)) continue;
    let size = 0;
    stack.length = 0; stack.push(p); seen[p] = 1;
    while (stack.length) {
      const q = stack.pop();
      const x = q % W, y = (q / W) | 0;
      size++;
      if (x > 0 && !seen[q - 1] && on(q - 1)) { seen[q - 1] = 1; stack.push(q - 1); }
      if (x < W - 1 && !seen[q + 1] && on(q + 1)) { seen[q + 1] = 1; stack.push(q + 1); }
      if (y > 0 && !seen[q - W] && on(q - W)) { seen[q - W] = 1; stack.push(q - W); }
      if (y < H - 1 && !seen[q + W] && on(q + W)) { seen[q + W] = 1; stack.push(q + W); }
    }
    if (size > 200) n++;
  }
  return n;
};

const accepted = [];
const rejAdm = [];
const ages = AGES.split(',').map(Number);

for (const r of g1.slice(0, MAX)) {
  const prefix = `shots/_screen-${ARENA}-${r.tick}`;
  const cap = spawnSync(process.execPath, [
    'shots/_r17-blast.mjs', '--base', BASE, '--arena', ARENA, '--seed', String(SEED),
    '--tick', String(r.tick), '--ages', AGES, '--prefix', prefix, '--stenconly',
  ], { encoding: 'utf8', timeout: 45 * 60 * 1000 });

  if (cap.status !== 0) {
    rejAdm.push({ ...r, why: `capture failed (${cap.status})`, boxes: [] });
    console.log(`  tick ${String(r.tick).padStart(5)}  REJECT  capture failed`);
    continue;
  }

  const boxes = [];
  for (const a of ages) {
    const f = `${prefix}-a${String(a).padStart(2, '0')}-mach.png`;
    if (!existsSync(f)) { boxes.push(null); continue; }
    boxes.push(await page.evaluate(`(${COUNT})(${JSON.stringify({
      machUri: `data:image/png;base64,${readFileSync(f).toString('base64')}`,
    })})`));
  }
  const ok = boxes.length === ages.length && boxes.every((b) => b === 2);
  const shown = boxes.map((b) => (b === null ? '-' : b)).join(' ');
  if (ok) {
    accepted.push({ ...r, boxes });
    console.log(`  tick ${String(r.tick).padStart(5)}  ACCEPT  in ${r.in.toFixed(2)}  d3 ${r.d3.toFixed(2)}  d ${r.d.toFixed(1)}m < fd ${r.fd.toFixed(1)}m  boxes ${shown}`);
  } else {
    rejAdm.push({ ...r, why: 'stencil', boxes });
    console.log(`  tick ${String(r.tick).padStart(5)}  REJECT  gate 2, boxes ${shown}`);
  }
}

await browser.close();

console.log(`\nTHE SET — ${accepted.length} pin(s), in decreasing \`in\``);
for (const a of accepted) console.log(`  ${ARENA} ${a.tick}   in ${a.in.toFixed(2)}   d3 ${a.d3.toFixed(2)}   d ${a.d.toFixed(1)}m   fd ${a.fd.toFixed(1)}m`);

console.log(`\nREJECTED AT GATE 2 — ${rejAdm.length}, published because a set without them is a selection`);
for (const r of rejAdm) console.log(`  ${ARENA} ${r.tick}   ${r.why}   boxes ${r.boxes.map((b) => (b === null ? '-' : b)).join(' ')}`);

console.log(`\nREJECTED AT GATE 1 — ${rejGeo.length} of ${rows.length}`);
const outside = rejGeo.filter((r) => r.in >= 1.0 && r.d3 >= 1.0).length;
console.log(`  ${outside} had in >= 1.00 but the opponent OUTSIDE the fire (d3 >= 1.00) — the round-37 term`);
console.log(`  ${rejGeo.length - outside} failed on \`in\` alone`);

if (!accepted.length) {
  console.error('\nno pin passed both gates — the set is empty and nothing may be scored on this arena');
  process.exit(2);
}
