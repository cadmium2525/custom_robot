#!/usr/bin/env node
/**
 * ROUND 44 CRITIC — the CEILING on what any size gate can buy, computed from
 * the two near machines' own per-fragment `vSizeX` distributions.
 *
 *   node shots/_r46ks.mjs grid.json foundry.json
 *
 * THE ARGUMENT, which is arithmetic and is labelled a MODEL, not a render.
 *
 * The shell's gate is `smoothstep(lo, hi, vSizeX)`, a monotone map from
 * fragment size to [0,1], and the lift a fragment receives is
 * `mix(uPaintLiftFar, uPaintLift, gate)`. So the mean lift a MACHINE receives
 * is `L_far + (L_near - L_far) * E[g]`, and the only thing a gate can do to
 * separate two machines is make `E[g]` differ between them.
 *
 * For any monotone g rising from 0 to 1,
 *
 *     E_A[g] - E_B[g]  =  integral (F_B(v) - F_A(v)) dg(v)
 *
 * and since dg integrates to 1 this is bounded in absolute value by
 * `sup_v |F_A(v) - F_B(v)|` — the Kolmogorov-Smirnov distance between the two
 * fragment distributions. The bound is attained in the limit by a step at the
 * argmax. **So the KS distance IS the maximally aggressive gate**, and no
 * choice of `uRimSizeLo`/`uRimSizeHi` can beat it.
 *
 * Reported alongside: the same bound for a NEAR-vs-FAR gate, which is the
 * separation the shipped relocation actually uses, so the two numbers can be
 * read against each other rather than in isolation.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const A = load(process.argv[2]);
const B = load(process.argv[3]);

/** sup |F_a - F_b| over the pooled support, plus the v where it is attained. */
function ks(a, b) {
  const xs = [...new Set([...a, ...b])].sort((x, y) => x - y);
  const cdf = (arr, v) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; }
    return lo / arr.length;
  };
  let best = 0, at = null, fa = 0, fb = 0;
  for (const v of xs) {
    const d = Math.abs(cdf(a, v) - cdf(b, v));
    if (d > best) { best = d; at = v; fa = cdf(a, v); fb = cdf(b, v); }
  }
  return { d: best, at, fa, fb };
}

const f = (v) => (v === null ? '  -  ' : v.toFixed(5));
const pct = (v) => (v * 100).toFixed(2) + '%';

const pairs = [
  ['grid NEAR vs foundry NEAR', A.near, B.near],
  ['grid NEAR vs grid FAR', A.near, A.far],
  ['foundry NEAR vs foundry FAR', B.near, B.far],
];
console.log('  the ceiling on E[gate] separation, = the KS distance between the fragment distributions');
console.log('  ------------------------------------------------------------------------------------');
for (const [name, x, y] of pairs) {
  const r = ks(x, y);
  console.log(
    `  ${name.padEnd(28)} max |dE[g]| = ${pct(r.d).padStart(7)}   at vSizeX ${f(r.at)}` +
    `   (F = ${pct(r.fa)} / ${pct(r.fb)})   n = ${x.length}/${y.length}`
  );
}
console.log('');
const rng = (a) => `${f(Math.min(...a))} .. ${f(Math.max(...a))}`;
console.log(`  grid    NEAR support ${rng(A.near)}      FAR ${rng(A.far)}`);
console.log(`  foundry NEAR support ${rng(B.near)}      FAR ${rng(B.far)}`);
const lo = Math.max(Math.min(...A.near), Math.min(...B.near));
const hi = Math.min(Math.max(...A.near), Math.max(...B.near));
const spanA = Math.max(...A.near) - Math.min(...A.near);
console.log(`  the two NEAR supports overlap on ${f(lo)} .. ${f(hi)} = ${pct((hi - lo) / spanA)} of grid's own span`);
