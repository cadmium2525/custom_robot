#!/usr/bin/env node
/**
 * SPEC-CRV2 clause A, scored — the mass meter with the two figures the clause
 * actually names, printed as PASS/FAIL beside the bundle they were taken from.
 *
 *   node shots/_massdrive.mjs --base http://127.0.0.1:4176/holosseum --arena grid
 *
 * Takes every flag tools/mass.mjs takes, because it *is* tools/mass.mjs.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN, AND WHY IT MATTERED FOR SEVENTEEN ROUNDS
 * ---------------------------------------------------------------------------
 *
 * This file is a PATCHER, not a copy. It reads tools/mass.mjs at run time,
 * string-replaces named anchors, and runs the result, so the stock meter cannot
 * drift away from it. Every patcher of that shape has one failure mode: the
 * anchor goes away.
 *
 * It did. Until `52625c7` the stock meter settled the frame with
 *
 *     g.view.update(0, 1, t);            // dt = 0
 *
 * outside the tick loop, and since every pose term in RoboModel.update is a
 * damper — damp(a, b, lambda, dt) = lerp(a, b, 1 - exp(-lambda*dt)), exactly `a`
 * at dt = 0 — the machines never moved. They were photographed in whatever pose
 * the boot transient left them in. This file existed to rewrite that ONE line to
 * `1 / 60` before running.
 *
 * `52625c7` then fixed the line in tools/mass.mjs itself. The anchor vanished,
 * the `hits !== 1` guard fired exactly as designed, and **this file aborted at
 * head from that commit onward** — which RULING 10 found, and which is the whole
 * reason clause C has never been measured: the spec named this file as clause
 * C's host and the file would not start.
 *
 * The repair is not to delete the guard. It is to point the guard at the world
 * as it now is, and to keep asserting the thing the guard was always really
 * protecting:
 *
 *   1. the CORRECTED settle appears exactly once   (the frame is pinned), and
 *   2. the BROKEN settle appears exactly zero times (no dt = 0 has crept back).
 *
 * Assertion 1 is the direct check that INSTRUMENT FAULT 15 has not recurred:
 * `shots/_lodprobe.mjs` shipped a comment claiming its settle was byte-identical
 * to this meter's when it was not, and every budget that file swept came from a
 * frame nobody pinned. A claim in a comment is not a check. These two are checks
 * and they run before the browser launches.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ADDS: CLAUSE A'S SECOND HALF, WHICH HAS NEVER BEEN QUOTED
 * ---------------------------------------------------------------------------
 *
 * SPEC-CRV2 clause A has two halves — "4-6 distinct large forms" AND "the
 * largest four cover most of it", thresholded at `top-4 coverage >= 85%`. The
 * count half is scored in every round since round 12. The coverage half has
 * never appeared in a single line of this document, even though tools/mass.mjs
 * has computed `top4` all along and prints it in the curve. A number that is
 * printed and never read is not a measurement.
 *
 * So this scores both halves at the clause's own operating point (step 51, the
 * "five value bands" the rule names), per machine, and says PASS or FAIL. It
 * changes no threshold and computes no new geometry — it reads the stock meter's
 * own output and applies the spec to it.
 *
 * It also injects the bundle-hash print that round 14 asked every capture for
 * and that tools/mass.mjs still does not have. Four agents build into one tree.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'tools', 'mass.mjs');
const src = readFileSync(SRC, 'utf8');

/**
 * Every anchor this file depends on, asserted before anything else runs.
 *
 * The standing rule RULING 10 added: an instrument that transforms another file
 * must assert its anchor and exit non-zero when the anchor is missing. Doing it
 * as a table rather than one `if` means a future edit to the stock meter names
 * the anchor it broke instead of failing on whichever one happens to be checked
 * first.
 */
const ANCHORS = [
  ['SETTLE-OK', 'g.view.update(1 / 60, 1, t);', 1,
   'the corrected settle. If this is 0 the stock meter no longer drives the\n' +
   'machines inside the tick loop and NOTHING it reports is a pinned frame.'],
  ['SETTLE-BROKEN', 'g.view.update(0, 1, t);', 0,
   'the dt = 0 settle that INSTRUMENT FAULT 11 was filed for. If this is 1 it\n' +
   'has been reintroduced and the machines are being photographed mid-transient.'],
  ['READY', '  await page.waitForFunction(() => window.__game', 1,
   'the first line after navigation, where the bundle-hash print is injected.\n' +
   '  Injecting BEFORE the goto photographs a blank page and hashes zero bytes.'],
  ['REPORT-TAIL', "  if (errors.length) console.log(", 1,
   'the last line of the report, where the clause A scoring is injected.'],
];

let bad = 0;
for (const [name, needle, want, why] of ANCHORS) {
  const hits = src.split(needle).length - 1;
  if (hits === want) continue;
  bad++;
  console.error(
    '_massdrive: anchor ' + name + ' — expected ' + want + ' occurrence(s) of\n' +
    '    ' + needle + '\n' +
    '  in tools/mass.mjs, found ' + hits + '.\n' +
    '  This anchor is ' + why + '\n' +
    '  Re-read the stock meter before trusting any reading from this file — do\n' +
    '  NOT assume the transform still applies.'
  );
}
if (bad) process.exit(2);

/* ------------------------------------------------------------------ */
/* The transforms. No backtick appears in any injected string: a stray */
/* one inside a template literal has broken this project's build three */
/* times, and these strings are pasted verbatim into another JS file.  */
/* ------------------------------------------------------------------ */

/**
 * `shots/_salience.mjs` reads the bundle name off the `index-*.js` script tag,
 * which is right for `dist/` and useless for `dist-single/` — the single-file
 * build has no external script and that meter prints "(inline)", i.e. it names
 * no bundle at all on exactly the artefact the deploy check verifies. So this
 * hashes what is actually loaded: every inline script's text plus every external
 * script's filename, FNV-1a, printed as 8 hex digits. Two runs of one build
 * agree; a rebuild between two runs does not.
 */
const BUNDLE_INJECT =
  "  {\n" +
  "    const _b = await page.evaluate(() => {\n" +
  "      let s = '';\n" +
  "      for (const el of document.querySelectorAll('script')) s += el.src ? el.src.split('/').pop() : el.textContent;\n" +
  "      let h = 0x811c9dc5;\n" +
  "      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }\n" +
  "      return { hash: h.toString(16).padStart(8, '0'), bytes: s.length };\n" +
  "    });\n" +
  "    console.log('  bundle: ' + _b.hash + ' (' + _b.bytes + ' script bytes)   base: ' + BASE);\n" +
  "  }\n";

/**
 * Clause A, scored at step 51.
 *
 * `masses` at 51 is the phase-averaged count, so it is fractional; the clause
 * asks for a count in [4,6] and the honest reading of a 4.8 is that it is in
 * band. `massesMax` is printed beside it so a cell that only passes on the
 * average is visible as such.
 */
const CLAUSE_A_INJECT =
  "  {\n" +
  "    console.log('');\n" +
  "    console.log('SPEC-CRV2 CLAUSE A — 4-6 masses AND top-4 >= 85% of the silhouette');\n" +
  "    console.log('  (count half scored since round 12; the coverage half has never been quoted)');\n" +
  "    let _allPass = true;\n" +
  "    out.bodies.forEach((b, i) => {\n" +
  "      const f = b.curve.find((c) => c.step === 51);\n" +
  "      const okN = f.masses >= 4 && f.masses <= 6;\n" +
  "      const okC = f.top4 >= 85;\n" +
  "      if (!(okN && okC)) _allPass = false;\n" +
  "      console.log('  ROBOT ' + (i + 1) + '  ' + b.box + 'px' +\n" +
  "        '   count ' + f.masses.toFixed(1) + ' (max ' + f.massesMax + ') ' + (okN ? 'MET' : 'FAIL') +\n" +
  "        '   top4 ' + f.top4.toFixed(1) + '% ' + (okC ? 'MET' : 'FAIL'));\n" +
  "    });\n" +
  "    console.log('  CLAUSE A: ' + (_allPass ? 'MET' : 'FAIL') + ' on ' + ARENA + ' @ tier ' + TIER);\n" +
  "  }\n";

let out = src;
out = out.replace('  await page.waitForFunction(() => window.__game',
  BUNDLE_INJECT + '  await page.waitForFunction(() => window.__game');
out = out.replace("  if (errors.length) console.log(", CLAUSE_A_INJECT + "  if (errors.length) console.log(");

/*
 * Written INSIDE the project so `import { chromium } from 'playwright'` and
 * every other bare specifier resolves against the same node_modules — node walks
 * up from the file's own directory, so a temp file in os.tmpdir() would not
 * resolve. That is the obvious shortcut and the wrong one.
 *
 * In shots/ rather than tools/ because shots/ is gitignored, so a leftover
 * cannot end up in a commit, and tools/ is not this file's to write into.
 */
const TMP = join(HERE, '.massdrive-' + process.pid + '.mjs');
writeFileSync(TMP, out);
/*
 * NOT try/finally. `process.exit()` terminates immediately and does NOT run
 * finally blocks, so the obvious spelling leaks one temp file per run — which is
 * how the first version of this file left `.massdrive-*.mjs` through tools/.
 * Unlink first, exit second.
 */
const r = spawnSync(process.execPath, [TMP, ...process.argv.slice(2)], { stdio: 'inherit' });
try { unlinkSync(TMP); } catch { /* best effort */ }
process.exit(r.status ?? 1);
