#!/usr/bin/env node
/**
 * Summarise repeated tools/mass.mjs runs into a NOISE FLOOR.
 *
 *   sh shots/_noise.sh 4 base          # capture 4 identical runs per arena
 *   node shots/_noise.mjs base         # read them back as min/max/spread
 *   node shots/_noise.mjs base after   # and A/B two tags against that floor
 *
 * Why this exists. Five instrument faults have been found in this project, the
 * most recent one five hours before this script was written: mass.mjs moved the
 * machine's POSE between runs, so a bounding box that was supposed to be pinned
 * came back 37x66 one run and 37x67 the next, and every A/B taken across that
 * was reading a different photograph on each side. The fix (pinning
 * engine.clock.elapsed) is a claim like any other. This measures the residual.
 *
 * The rule it exists to enforce: a delta smaller than the spread between two
 * runs of the SAME build is not a result. Print the floor first, then the
 * delta, and let the reader see both numbers next to each other.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname);
const tags = process.argv.slice(2);
if (!tags.length) { console.error('usage: node shots/_noise.mjs <tag> [tag2]'); process.exit(1); }

/** Pull every number this tool reports out of one mass.mjs stdout capture. */
function parse(text) {
  const bodies = [];
  let cur = null;
  for (const line of text.split('\n')) {
    let m = line.match(/ROBOT (\d+)\s+(\d+)x(\d+)px at (\d+),(\d+)/);
    if (m) {
      cur = { n: +m[1], w: +m[2], h: +m[3], x: +m[4], y: +m[5] };
      bodies.push(cur);
      continue;
    }
    if (!cur) continue;
    m = line.match(/p2=(\d+) median=(\d+) p98=(\d+)\s+spread (\d+)/);
    if (m) { cur.p2 = +m[1]; cur.median = +m[2]; cur.p98 = +m[3]; cur.spread = +m[4]; continue; }
    m = line.match(/^\s+mass\s+(.*)$/);
    if (m) { cur.curve = m[1].trim().split(/\s+/).map(Number); continue; }
    m = line.match(/^\s+top4%\s+(.*)$/);
    if (m) { cur.top4c = m[1].trim().split(/\s+/).map(Number); continue; }
    m = line.match(/@51 \(five bands\): ([\d.]+) masses, largest ([\d.]+)%, top4 ([\d.]+)%/);
    if (m) { cur.m51 = +m[1]; cur.largest = +m[2]; cur.top4 = +m[3]; continue; }
    m = line.match(/curve mean: ([\d.]+)/);
    if (m) { cur.mean = +m[1]; continue; }
  }
  return bodies;
}

const FIELDS = ['h', 'w', 'y', 'spread', 'median', 'm51', 'largest', 'top4', 'mean'];
const ARENAS = ['grid', 'foundry', 'orbital'];

/**
 * Captures that exist but carry no reading, with the first line of each.
 *
 * INSTRUMENT FAULT 10, and it is this file's own. `load()` dropped every
 * unparseable capture on the floor and the summary printed `foundry: no
 * captures` — a phrase that reads as "you did not run it" when what happened is
 * "you ran it three times and it failed three times". Round 12 lost eleven of
 * twelve captures to a dead preview server and wrote its audit as though the
 * sweep had succeeded; round 13 lost six of nine to the same cause — a
 * `npm run build` under a live `vite preview`, which takes the server with it —
 * and caught it only by listing the files by hand.
 *
 * A tool that cannot tell "no data" from "all errors" is a tool that reports a
 * clean summary over missing data, which is the failure mode this ledger has
 * now found ten times. So the two states are separated and the error text is
 * printed, because the error text is what names the cause.
 */
function load(tag) {
  const out = {};
  const bad = {};
  for (const a of ARENAS) {
    const files = readdirSync(DIR)
      .filter((f) => f.startsWith(`_noise-${tag}-${a}-`) && f.endsWith('.txt'))
      .sort();
    const runs = [];
    for (const f of files) {
      const text = readFileSync(join(DIR, f), 'utf8');
      const r = parse(text);
      if (r.length) runs.push(r);
      else (bad[a] ||= []).push([f, (text.trim().split('\n')[0] || '(empty file)').slice(0, 110)]);
    }
    if (runs.length) out[a] = runs;
  }
  out.__bad = bad;
  return out;
}

/** Print the errored captures for one arena, if there are any. */
function reportBad(data, a) {
  const bad = data.__bad?.[a];
  if (!bad || !bad.length) return;
  console.log(`    ${bad.length} capture(s) present with NO reading in them:`);
  for (const [f, first] of bad) console.log(`      ${f}: ${first}`);
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

for (const tag of tags) {
  const data = load(tag);
  console.log(`\n=== ${tag} ===`);
  for (const a of ARENAS) {
    const runs = data[a];
    if (!runs) {
      const bad = data.__bad?.[a];
      console.log(`  ${a}: NO READING${bad && bad.length ? ` — ${bad.length} capture(s) FAILED` : ' — no captures on disk'}`);
      reportBad(data, a);
      continue;
    }
    console.log(`  ${a}  (${runs.length} identical runs)`);
    reportBad(data, a);
    for (let b = 0; b < runs[0].length; b++) {
      const row = FIELDS.map((f) => {
        const vals = runs.map((r) => r[b]?.[f]).filter((v) => typeof v === 'number');
        if (!vals.length) return `${f}=—`;
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        return `${f} ${fmt(mean)} [${fmt(lo)}..${fmt(hi)}] ±${fmt((hi - lo) / 2)}`;
      });
      console.log(`    ROBOT ${b + 1}`);
      for (const r of row) console.log(`       ${r}`);
      // Whole-curve spread: the widest run-to-run gap at any quantisation step.
      const curves = runs.map((r) => r[b]?.curve).filter(Boolean);
      if (curves.length > 1) {
        let worst = 0, at = 0;
        for (let k = 0; k < curves[0].length; k++) {
          const v = curves.map((c) => c[k]);
          const d = Math.max(...v) - Math.min(...v);
          if (d > worst) { worst = d; at = k; }
        }
        console.log(`       curve: widest run-to-run gap ${worst.toFixed(1)} masses (step index ${at})`);
      }
    }
  }
}

if (tags.length === 2) {
  const A = load(tags[0]), B = load(tags[1]);
  console.log(`\n=== DELTA ${tags[1]} - ${tags[0]}, scored against the floor ===`);
  for (const a of ARENAS) {
    if (!A[a] || !B[a]) continue;
    console.log(`  ${a}`);
    for (let b = 0; b < A[a][0].length; b++) {
      for (const f of ['m51', 'mean', 'top4', 'largest', 'spread']) {
        const va = A[a].map((r) => r[b]?.[f]).filter((v) => typeof v === 'number');
        const vb = B[a].map((r) => r[b]?.[f]).filter((v) => typeof v === 'number');
        if (!va.length || !vb.length) continue;
        const ma = va.reduce((s, v) => s + v, 0) / va.length;
        const mb = vb.reduce((s, v) => s + v, 0) / vb.length;
        const floor = Math.max(Math.max(...va) - Math.min(...va), Math.max(...vb) - Math.min(...vb));
        const d = mb - ma;
        const verdict = Math.abs(d) > floor ? 'REAL' : 'NOISE';
        console.log(`    ROBOT ${b + 1} ${f.padEnd(8)} ${fmt(ma)} -> ${fmt(mb)}  d=${d >= 0 ? '+' : ''}${d.toFixed(2)}  floor ${floor.toFixed(2)}  ${verdict}`);
      }
    }
  }
}
