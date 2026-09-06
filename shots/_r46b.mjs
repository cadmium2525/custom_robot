#!/usr/bin/env node
/**
 * ROUND 44 CRITIC — N draws of `tools/contour.mjs`, unmodified, with the two
 * clause B cells and the stencil pulled out of its own printed output.
 *
 *   node shots/_r46b.mjs --draws 6 --arena foundry -- --u uPaintLift=0,...
 *
 * Everything after a bare `--` is handed to the meter verbatim. The meter is
 * SPAWNED, not copied — there is no second settle in this file, which is the
 * whole of instrument fault 45's lesson. Its bundle line is echoed for every
 * draw rather than once, because a rebuild into a directory a server is already
 * serving replaces the bundle with nothing in the terminal to mark it (the rule
 * left by fault 39's sibling).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cut = argv.indexOf('--');
const mine = cut < 0 ? argv : argv.slice(0, cut);
const pass = cut < 0 ? [] : argv.slice(cut + 1);
const flag = (n, d) => {
  const i = mine.indexOf(`--${n}`);
  return i < 0 ? d : mine[i + 1];
};
const DRAWS = Number(flag('draws', 6));
const ARENA = flag('arena', 'grid');
const BASE = flag('base', 'http://127.0.0.1:4405/custom_robot/');

console.log(`  ${DRAWS} draws  arena ${ARENA}  extra: ${pass.join(' ') || '(none)'}`);
console.log('  draw  bundle        stencil   NEAR box      n     clean   |   FAR box    n     clean');
console.log('  ---------------------------------------------------------------------------------');
const rows = [];
for (let d = 0; d < DRAWS; d++) {
  const r = spawnSync(process.execPath, [
    join(HERE, '..', 'tools', 'contour.mjs'),
    '--base', BASE, '--arena', ARENA, '--tier', '3', '--ticks', '420', ...pass,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const hash = (out.match(/bundle:\s+(\S+)/) || [])[1] || '?';
  const px = (out.match(/robot pixels (\d+)/) || [])[1] || '?';
  const bots = [...out.matchAll(
    /ROBOT (\d)\s+(\d+x\d+)px[^\n]*\n\s+step[^\n]*\(n=(\d+)\)[\s\S]*?clean\s+\(>=40\)\s+([\d.]+)%/g
  )];
  if (bots.length < 2) {
    console.log(`   ${d + 1}    ${hash}  PARSE FAILED`);
    console.log(out.slice(-1200));
    continue;
  }
  const [a, b] = bots;
  rows.push({ px: Number(px), near: Number(a[4]), far: Number(b[4]), nb: a[2], fb: b[2], nn: a[3], fn: b[3] });
  console.log(
    `   ${d + 1}    ${hash}  ${String(px).padStart(6)}   ${a[2].padEnd(9)} ${a[3].padStart(5)}  ${a[4].padStart(5)}   |   ` +
    `${b[2].padEnd(7)} ${b[3].padStart(4)}  ${b[4].padStart(5)}`
  );
}
const mode = (a) => {
  const c = new Map();
  for (const v of a) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((x, y) => y[1] - x[1])[0];
};
if (rows.length) {
  const nm = mode(rows.map((r) => r.near));
  const fm = mode(rows.map((r) => r.far));
  console.log('');
  console.log(`  NEAR  mode ${nm[0]} x${nm[1]} of ${rows.length}   range ${Math.min(...rows.map((r) => r.near))}..${Math.max(...rows.map((r) => r.near))}`);
  console.log(`  FAR   mode ${fm[0]} x${fm[1]} of ${rows.length}   range ${Math.min(...rows.map((r) => r.far))}..${Math.max(...rows.map((r) => r.far))}`);
  console.log(`  stencil ${[...new Set(rows.map((r) => r.px))].join(' / ')}`);
}
