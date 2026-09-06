/**
 * ROUND 46 CRITIC — RUN tools/contour.mjs WITH THE PRE-FAULT-47 GATE.
 *
 * ROUND 45 re-based grid's far cell from 70.9 to 84.4 and asserted the re-base
 * is grid-only, "because the flare's opacity tracks `heat` and only grid's
 * pinned frame has a hot machine". `shots/_r46-guard.mjs` reads the opacity off
 * the running bundle and refutes that: `matFlare.opacity = clamp01(0.18 + heat *
 * 0.55)` has a FLOOR of 0.18, the flare is drawn on every machine of every
 * arena, and grid's FAR machine — the one that moved 13.5 points — carries
 * opacity 0.317, the same value as both of foundry's machines, which moved 0.0.
 *
 * So the size of the re-base has to be MEASURED per arena rather than deduced
 * from a uniform. This is the difference engine: it patches the one guard line
 * back to what it was and runs the real meter, so old-gate and new-gate figures
 * come from the same code, the same bundle and the same session.
 *
 * PATCHER CONTRACT (RULING 10, INSTRUMENT FAULT 29): anchor by exact text,
 * verify by read-back, ABORT on a miss. A patcher whose anchor has drifted runs
 * the unpatched meter and reports the control twice — which is fault 43 with a
 * different subject.
 *
 *   node shots/_r46-gate.mjs --gate old  --arena grid --base ... --tier 3 --ticks 420
 *   node shots/_r46-gate.mjs --gate head --arena grid ...     (control, no patch)
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const gi = args.indexOf('--gate');
const GATE = gi >= 0 ? args[gi + 1] : 'head';
const rest = args.filter((_, i) => i !== gi && i !== gi + 1);

const SRC_PATH = new URL('../tools/contour.mjs', import.meta.url);
let src = readFileSync(SRC_PATH, 'utf8');

const ANCHOR = '      if (m0 && m0.depthWrite === false) {';
const GATES = {
  head: ANCHOR,
  // The gate as it stood before fault 47: depth-write-off meshes are dropped
  // from the mask ONLY when they are outside the shell set, so anything
  // parented under a model group — the flare — is painted white.
  old: '      if (m0 && !shells.has(o) && m0.depthWrite === false) {',
};
if (!(GATE in GATES)) { console.error('gate: unknown --gate ' + GATE + ' (head|old)'); process.exit(2); }
if (!src.includes(ANCHOR)) {
  console.error('gate: the guard anchor is not in tools/contour.mjs — REFUSING to run the unpatched meter and call it a variant.');
  process.exit(2);
}
if (src.split(ANCHOR).length - 1 !== 1) {
  console.error('gate: the guard anchor appears more than once — REFUSING rather than patching an ambiguous line.');
  process.exit(2);
}
src = src.replace(ANCHOR, GATES[GATE]);
if (!src.includes(GATES[GATE])) { console.error('gate: read-back failed.'); process.exit(2); }

const out = new URL('./.r46gate-' + process.pid + '.mjs', import.meta.url);
writeFileSync(out, src);
console.log('  GATE: ' + GATE + '  ->  ' + GATES[GATE].trim());
try {
  const r = spawnSync(process.execPath, [out.pathname, ...rest], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  try { unlinkSync(out); } catch { /* leave nothing behind */ }
}
