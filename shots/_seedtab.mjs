#!/usr/bin/env node
/**
 * Read a `shots/_seeds.sh` sweep into one table, and report the thing the
 * single-frame figures cannot: how much of the arena-to-arena gap is the ART
 * and how much is the FRAME.
 *
 * Per cell it prints the mask size and the near machine's on-screen box next to
 * invisible/clean, because those are the confound: a machine that is small or
 * occluded has few boundary pixels and every one of them is against whatever
 * happens to be behind it.
 *
 *   node shots/_seedtab.mjs shots/r17seeds
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import process from 'node:process';

const DIR = process.argv[2] || 'shots/r17seeds';
if (!existsSync(DIR)) { console.error(`no ${DIR}`); process.exit(1); }

const num = (s, re) => { const m = s.match(re); return m ? Number(m[1]) : null; };

const rows = [];
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort()) {
  const m = f.match(/^(\w+)-(\d+)\.txt$/);
  if (!m) continue;
  const s = readFileSync(`${DIR}/${f}`, 'utf8');
  const px = num(s, /robot pixels (\d+)/);
  if (px == null) { rows.push({ arena: m[1], seed: m[2], bad: true }); continue; }
  const blocks = s.split(/\n {2}(?=OVERALL|ROBOT)/).slice(1);
  const parse = (b) => ({
    label: b.split('\n')[0].trim(),
    inv: num(b, /invisible \(<12\)\s+([\d.]+)%/),
    clean: num(b, /clean\s+\(>=40\)\s+([\d.]+)%/),
    body: num(b, /body ([\d.]+) vs/),
    bg: num(b, /vs background ([\d.]+)/),
  });
  const ov = parse(blocks[0]);
  const r1 = blocks[1] ? parse(blocks[1]) : null;
  rows.push({
    arena: m[1], seed: m[2], px,
    box: r1 ? (r1.label.match(/(\d+x\d+)px/) || [])[1] : '-',
    ov, r1,
  });
}

const fmt = (v, n = 5) => String(v == null ? '-' : v).padStart(n);
console.log(`\nSEED SWEEP — ${DIR}   (tick 420, tier 3, 1600x900)\n`);
console.log('arena     seed      maskpx   near box     OVERALL inv  clean   body/bg      NEAR inv  clean   body/bg');
let last = '';
for (const r of rows) {
  if (r.arena !== last) { console.log(''); last = r.arena; }
  if (r.bad) { console.log(`${r.arena.padEnd(9)} ${r.seed.padEnd(9)} FAILED`); continue; }
  console.log(
    `${r.arena.padEnd(9)} ${r.seed.padEnd(9)} ${fmt(r.px, 6)}  ${String(r.box).padEnd(10)}` +
    `  ${fmt(r.ov.inv)}%  ${fmt(r.ov.clean)}%  ${fmt(r.ov.body, 5)}/${fmt(r.ov.bg, 5)}` +
    `   ${fmt(r.r1?.inv)}%  ${fmt(r.r1?.clean)}%  ${fmt(r.r1?.body, 5)}/${fmt(r.r1?.bg, 5)}`);
}

/* Per-arena summary, on the cells that actually have a machine to measure. */
const med = (a) => { const b = a.filter((v) => v != null).sort((x, y) => x - y); return b.length ? Math.round(b[b.length >> 1] * 10) / 10 : null; };
console.log('\nMEDIANS across seeds');
console.log('arena       n   maskpx   OVERALL inv  clean     NEAR inv  clean');
for (const a of ['grid', 'foundry', 'orbital']) {
  const g = rows.filter((r) => r.arena === a && !r.bad);
  if (!g.length) continue;
  console.log(
    `${a.padEnd(10)} ${String(g.length).padStart(2)}  ${fmt(med(g.map((r) => r.px)), 7)}` +
    `  ${fmt(med(g.map((r) => r.ov.inv)))}%  ${fmt(med(g.map((r) => r.ov.clean)))}%` +
    `   ${fmt(med(g.map((r) => r.r1?.inv)))}%  ${fmt(med(g.map((r) => r.r1?.clean)))}%`);
}
