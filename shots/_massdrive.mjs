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
   'the last line of the report, where the clause A and C scoring is injected.'],
  ['SEGMENT', '      sizes.push(n);\n    }\n    sizes.sort((a, b) => b - a);', 1,
   'the end of the region flood fill. Clause C\'s per-region mean and sd are\n' +
   '  injected between the push and the sort, because the sort destroys the\n' +
   '  id-to-size map every one of those figures is indexed by. If the sort has\n' +
   '  moved, the injection would index the WRONG regions and still print a\n' +
   '  number — which is the fault class this whole table exists to stop.'],
  ['ABLATE', '  if (NOPAINT) await page.evaluate(', 1,
   'where the --off ablation is injected, after the paint control and before\n' +
   '  the shutter.'],
  ['REGION-RETURN', '      top4: top4 * 100,\n    };', 1,
   'the per-phase return, extended with the clause C figures.'],
  ['PHASE-AVG', "      top4: Math.round(avg('top4') * 10) / 10,\n    };", 1,
   'the phase-averaging return, extended with the clause C figures.'],
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

/* ================================================================== */
/* SPEC-CRV2 CLAUSE C — value belongs to form, not to view            */
/* ================================================================== */
/**
 * The clause, from the hardware: N64 lighting is per-vertex Gouraud with no
 * programmable per-pixel stage, so within one mass the value is near-constant
 * and between masses it STEPS. No gradient inside a face, no view-dependent
 * highlight travelling across one. Threshold: per-mass luminance sd < half the
 * between-mass step.
 *
 * NO METER HAS EVER EXISTED FOR THIS. It is the mechanism the whole look rests
 * on and it has gone unmeasured for seventeen rounds, because the file the spec
 * named as its host would not start.
 *
 * The measurement rides on segmentation the stock meter already does and adds no
 * geometry of its own:
 *
 *   sd    Per-mass luminance sd, taken on the ORIGINAL luminance, not the blur
 *         the segmentation runs on. Measuring sd on the blurred image would be
 *         measuring the blur — the mass would look flat because we flattened it.
 *         Area-weighted across masses, so the torso counts for what it covers.
 *
 *   step  The median absolute difference in mean luminance between masses THAT
 *         TOUCH. Two masses on opposite sides of the body share no edge for the
 *         eye to read a step across, and averaging them in inflates the step
 *         until anything passes. Contact is counted in pixels of shared
 *         4-neighbour border, and a pair under 6px of contact is dropped as an
 *         incidental corner touch.
 *
 *   ratio sd / (step / 2). The clause passes below 1.0.
 *
 * ---------------------------------------------------------------------------
 * THE METER'S OWN NULL, WHICH MUST BE QUOTED WITH EVERY NUMBER IT RETURNS
 * ---------------------------------------------------------------------------
 *
 * A perfect linear ramp across the body — the exact thing clause C forbids —
 * scores 0.577, not 1.0, and therefore PASSES the spec's threshold. The
 * arithmetic is forced and takes one line: quantisation at step S cuts a ramp
 * into strips of width S, a uniform distribution of width S has sd = S/sqrt(12)
 * = 0.289S, adjacent strip means differ by exactly S, so the ratio is
 * 0.289S / 0.5S = 0.577 at EVERY step in the sweep.
 *
 * So this meter is not a gradient detector, and anyone who quotes a passing
 * ratio as "the faces are flat" is over-reading it. What it detects is variance
 * inside a mass in EXCESS of a ramp: a specular lobe sitting in the middle of a
 * face, a Fresnel rim brightening one edge of a region, a hit flash — the
 * view-dependent terms the clause is actually about, which pile variance into a
 * region without moving its neighbours. That is the failure mode named in the
 * clause and it is what this reads.
 *
 * Both figures are therefore printed: the spec's 1.0 gate, and the distance to
 * the 0.577 ramp null. A ratio at 0.30 is a genuinely stepped body. A ratio at
 * 0.58 is a body no flatter than a gradient that happens to satisfy the letter
 * of the threshold, and it should be reported as such rather than as a pass.
 */
const CLAUSE_C_SEGMENT =
  "      sizes.push(n);\n" +
  "    }\n" +
  "    /* --- SPEC-CRV2 clause C: per-region mean and sd, before the sort --- */\n" +
  "    /* `sizes` is sorted immediately below, which destroys the id-to-size   */\n" +
  "    /* map every one of these figures is indexed by. This must run first.  */\n" +
  "    const _nR = sizes.length;\n" +
  "    const _sum = new Float64Array(_nR), _sq = new Float64Array(_nR), _cnt = new Float64Array(_nR);\n" +
  "    const _bx0 = B.x0, _by0 = B.y0;\n" +
  "    for (let y = 0; y < bh; y++) {\n" +
  "      for (let x = 0; x < bw; x++) {\n" +
  "        const i = y * bw + x;\n" +
  "        const id = seen[i];\n" +
  "        if (id < 0) continue;\n" +
  "        const L = Ln[(y + _by0) * W + (x + _bx0)];\n" +
  "        _sum[id] += L; _sq[id] += L * L; _cnt[id]++;\n" +
  "      }\n" +
  "    }\n" +
  "    const _mean = new Float64Array(_nR), _sd = new Float64Array(_nR);\n" +
  "    for (let r = 0; r < _nR; r++) {\n" +
  "      const c = _cnt[r] || 1;\n" +
  "      _mean[r] = _sum[r] / c;\n" +
  "      _sd[r] = Math.sqrt(Math.max(0, _sq[r] / c - _mean[r] * _mean[r]));\n" +
  "    }\n" +
  "    /* Big regions only, at the same 3% floor the count uses, so the sd and  */\n" +
  "    /* the mass count describe the same set of regions. A 12px sliver is not */\n" +
  "    /* a mass and its sd is not a fact about the mass read.                  */\n" +
  "    const _big = (r) => sizes[r] / area >= 0.03;\n" +
  "    let _wsd = 0, _wt = 0, _maxsd = 0;\n" +
  "    for (let r = 0; r < _nR; r++) {\n" +
  "      if (!_big(r)) continue;\n" +
  "      _wsd += _sd[r] * sizes[r]; _wt += sizes[r];\n" +
  "      if (_sd[r] > _maxsd) _maxsd = _sd[r];\n" +
  "    }\n" +
  "    const _sdw = _wt > 0 ? _wsd / _wt : 0;\n" +
  "    /* Shared 4-neighbour border length per pair of regions. */\n" +
  "    const _con = new Map();\n" +
  "    const _bump = (a, b) => {\n" +
  "      if (a === b || a < 0 || b < 0) return;\n" +
  "      const k = a < b ? a * 1000000 + b : b * 1000000 + a;\n" +
  "      _con.set(k, (_con.get(k) || 0) + 1);\n" +
  "    };\n" +
  "    for (let y = 0; y < bh; y++) {\n" +
  "      for (let x = 0; x < bw; x++) {\n" +
  "        const i = y * bw + x;\n" +
  "        if (seen[i] < 0) continue;\n" +
  "        if (x + 1 < bw) _bump(seen[i], seen[i + 1]);\n" +
  "        if (y + 1 < bh) _bump(seen[i], seen[i + bw]);\n" +
  "      }\n" +
  "    }\n" +
  "    const _st = [];\n" +
  "    for (const [k, n2] of _con) {\n" +
  "      if (n2 < 6) continue;\n" +
  "      const a = Math.floor(k / 1000000), b2 = k % 1000000;\n" +
  "      if (!_big(a) || !_big(b2)) continue;\n" +
  "      _st.push(Math.abs(_mean[a] - _mean[b2]));\n" +
  "    }\n" +
  "    _st.sort((p, q) => p - q);\n" +
  "    const _stepMed = _st.length ? _st[_st.length >> 1] : 0;\n" +
  "    sizes.sort((a, b) => b - a);";

const CLAUSE_C_RETURN =
  "      top4: top4 * 100,\n" +
  "      sd: _sdw,\n" +
  "      sdMax: _maxsd,\n" +
  "      gap: _stepMed,\n" +
  "      pairs: _st.length,\n" +
  "    };";

const CLAUSE_C_AVG =
  "      top4: Math.round(avg('top4') * 10) / 10,\n" +
  "      sd: Math.round(avg('sd') * 100) / 100,\n" +
  "      sdMax: Math.round(Math.max(...runs.map((r) => r.sdMax)) * 100) / 100,\n" +
  "      gap: Math.round(avg('gap') * 100) / 100,\n" +
  "      pairs: Math.round(avg('pairs') * 10) / 10,\n" +
  "    };";

/**
 * The report. Prints the ratio across the whole sweep as well as at 51, because
 * the sweep is what separates the two ways of passing: a genuinely stepped body
 * holds a low ratio as the step coarsens and real form steps survive, while a
 * ramp sits pinned at the 0.577 null at every step by construction.
 */
const CLAUSE_C_REPORT =
  "  {\n" +
  "    const RAMP = Math.sqrt(1 / 12) / 0.5;\n" +
  "    console.log('');\n" +
  "    console.log('SPEC-CRV2 CLAUSE C — per-mass luminance sd < half the between-mass step');\n" +
  "    console.log('  ratio = sd / (step/2); PASS < 1.00. A LINEAR RAMP SCORES ' + RAMP.toFixed(3) + ' AND PASSES,');\n" +
  "    console.log('  so the ramp null is quoted with every number: this meter reads variance');\n" +
  "    console.log('  inside a mass IN EXCESS of a gradient — speculars, rims, flashes.');\n" +
  "    let _cPass = true, _cFlat = true;\n" +
  "    out.bodies.forEach((b, i) => {\n" +
  "      const f = b.curve.find((c) => c.step === 51);\n" +
  "      const rat = (c) => (c.gap > 0 ? c.sd / (c.gap / 2) : NaN);\n" +
  "      const head = b.curve.map((c) => String(c.step).padStart(6)).join('');\n" +
  "      const row = b.curve.map((c) => (isNaN(rat(c)) ? '   n/a' : rat(c).toFixed(2).padStart(6))).join('');\n" +
  "      const sdr = b.curve.map((c) => c.sd.toFixed(1).padStart(6)).join('');\n" +
  "      const stp = b.curve.map((c) => c.gap.toFixed(1).padStart(6)).join('');\n" +
  "      console.log('  ROBOT ' + (i + 1) + '  ' + b.box + 'px   ' + f.pairs + ' touching mass pairs at step 51');\n" +
  "      console.log('     step  ' + head);\n" +
  "      console.log('     sd    ' + sdr);\n" +
  "      console.log('     gap   ' + stp);\n" +
  "      console.log('     ratio ' + row);\n" +
  "      const r51 = rat(f);\n" +
  "      const ok = r51 < 1;\n" +
  "      const flat = r51 < RAMP;\n" +
  "      if (!ok) _cPass = false;\n" +
  "      if (!flat) _cFlat = false;\n" +
  "      console.log('     @51: sd ' + f.sd.toFixed(2) + ' (worst mass ' + f.sdMax.toFixed(2) + ')' +\n" +
  "        '  step ' + f.gap.toFixed(2) + '  ratio ' + r51.toFixed(3) +\n" +
  "        '  ' + (ok ? 'MET' : 'FAIL') + (ok ? (flat ? ', below the ramp null' : ', BUT ABOVE THE RAMP NULL') : ''));\n" +
  "    });\n" +
  "    console.log('  CLAUSE C: ' + (_cPass ? 'MET' : 'FAIL') + ' on ' + ARENA + ' @ tier ' + TIER +\n" +
  "      '   (vs ramp null: ' + (_cFlat ? 'flatter than a gradient' : 'NO FLATTER THAN A GRADIENT') + ')');\n" +
  "  }\n";

/**
 * `--off outline,normal,maps,env` — the attribution probe for clause C.
 *
 * The stock meter's `--u` reaches every VIEW-DEPENDENT term in the shell shader,
 * because those are all uniforms. It reaches nothing else. When the first clause
 * C reading came back at ratio 4.06 and zeroing the rim, the specular, the
 * energy and the wash together only moved it to 3.01, the remaining three
 * quarters of the excess were coming from somewhere `--u` cannot switch off, and
 * guessing which was not an option — this repository has sixteen instrument
 * faults on file and most of them start with a plausible guess.
 *
 * So this removes, one at a time, the four things that write value INSIDE a mass
 * without being view-dependent:
 *
 *   outline  the inverted-hull line art, which is drawn in near-black over every
 *            interior seam as well as the silhouette
 *   normal   the normal map — a per-pixel normal perturbation, i.e. exactly the
 *            programmable per-pixel stage clause C's hardware fact says did not
 *            exist, and the one term that can put a gradient inside a flat face
 *   maps     albedo / AO / roughness textures
 *   env      the environment map
 *
 * ROUND 19 adds the two that write value inside a mass and are neither
 * view-dependent nor a texture, so `--u` and the four above both miss them:
 *
 *   shadow   the shadow map. An N64 has none, and a limb's shadow lying across
 *            the torso is a hard-edged dark region in the middle of a mass —
 *            the exact shape of clause C's failure, and it was never on any
 *            round's list because it is not a term in the shell shader.
 *   emis     the emissive channel — vents, energy veins, lamp faces. Small,
 *            bright, and inside a mass by construction.
 *   smooth   SMOOTH SHADING itself, i.e. flatShading = true. This is the only
 *            entry that is not a removal of an effect but a change of the
 *            shading normal, and it is here because `roundedBox` — the
 *            workhorse of this model — gives every chamfer quad one row of
 *            vertices carrying the face normal and one row carrying the
 *            corner-sphere normal. That is a Gouraud RAMP across a band whose
 *            projected width is the chamfer radius: 0.02-0.045 m, which at 166
 *            px/m on grid's near machine is 3-7 px. Clause C's own hardware
 *            fact allows a per-vertex ramp; the clause's text does not ("no
 *            gradient inside a face"). Nothing moves: positions, the welded
 *            normal the rim and the outline hull are built on, and therefore
 *            the silhouette are all untouched.
 *
 * DIAGNOSTIC ONLY. It changes nothing in the build and nothing it switches off
 * is a proposal to switch off — it is there to name the term, which is the step
 * this clause has been missing for seventeen rounds.
 */
const ABLATE_INJECT =
  "  {\n" +
  "    const _off = String(flag('off', '') || '').split(',').filter(Boolean);\n" +
  "    if (_off.length) {\n" +
  "      const _did = await page.evaluate((list) => {\n" +
  "        const v = window.__game.view;\n" +
  "        const seen = [];\n" +
  "        if (list.includes('shadow')) {\n" +
  "          const r = window.__game.engine.renderer;\n" +
  "          const sc = window.__game.engine.scene;\n" +
  "          if (r && r.shadowMap.enabled) {\n" +
  "            r.shadowMap.enabled = false;\n" +
  "            /* three.js bakes NUM_DIR_LIGHT_SHADOWS into every program, so the */\n" +
  "            /* flag alone changes nothing until each material recompiles.      */\n" +
  "            if (sc) sc.traverse((o) => { if (o.material) for (const mm of [].concat(o.material)) mm.needsUpdate = true; });\n" +
  "            seen.push('shadowMap');\n" +
  "          }\n" +
  "        }\n" +
  "        for (const m of v.models) {\n" +
  "          if (list.includes('outline') && m.outline) { m.outline.visible = false; seen.push('outline'); }\n" +
  "          for (const mat of [m.matShell, m.matFrame]) {\n" +
  "            if (!mat) continue;\n" +
  "            let touched = false;\n" +
  "            if (list.includes('normal') && mat.normalMap) { mat.normalMap = null; seen.push('normalMap'); touched = true; }\n" +
  "            if (list.includes('maps') || list.includes('albedo')) {\n" +
  "              if (mat.map) { mat.map = null; seen.push('map'); touched = true; }\n" +
  "            }\n" +
  "            if (list.includes('maps') || list.includes('ao')) {\n" +
  "              if (mat.aoMap) { mat.aoMap = null; seen.push('aoMap'); touched = true; }\n" +
  "            }\n" +
  "            if (list.includes('maps') || list.includes('rough')) {\n" +
  "              if (mat.roughnessMap) { mat.roughnessMap = null; seen.push('roughnessMap'); touched = true; }\n" +
  "            }\n" +
  "            if (list.includes('env') && mat.envMap) { mat.envMap = null; seen.push('envMap'); touched = true; }\n" +
  "            if (list.includes('smooth') && !mat.flatShading) {\n" +
  "              mat.flatShading = true; seen.push('flatShading'); touched = true;\n" +
  "            }\n" +
  "            if (list.includes('emis') && mat.emissive && mat.emissive.getHex() !== 0) {\n" +
  "              mat.emissive.setHex(0); seen.push('emissive'); touched = true;\n" +
  "            }\n" +
  "            if (list.includes('emis') && mat.emissiveMap) { mat.emissiveMap = null; seen.push('emissiveMap'); touched = true; }\n" +
  "            if (touched) mat.needsUpdate = true;\n" +
  "          }\n" +
  "          /* The lit vents and the plumes are their OWN meshes with their own  */\n" +
  "          /* materials (matEmis is a MeshBasicMaterial, matFlare is additive), */\n" +
  "          /* so nulling mat.emissive on the shell and the frame never reached  */\n" +
  "          /* them. They are identified by material identity, not by index.     */\n" +
  "          for (const mesh of m.meshes || []) {\n" +
  "            if (list.includes('lit') && mesh.material === m.matEmis && mesh.visible) { mesh.visible = false; seen.push('emisMesh'); }\n" +
  "            if (list.includes('lit') && mesh.material === m.matFlare && mesh.visible) { mesh.visible = false; seen.push('flareMesh'); }\n" +
  "            /* recv and cast are separable and they are NOT the same clause.  */\n" +
  "            /* recv removes the shadow a limb throws ACROSS a mass, which is  */\n" +
  "            /* a per-pixel darkening inside a form. cast removes the shadow    */\n" +
  "            /* the machine throws on the GROUND, which is a grounding cue and  */\n" +
  "            /* belongs to another meter entirely. --off shadow kills both, and */\n" +
  "            /* the stage's own shadows with them.                             */\n" +
  "            if (list.includes('recv') && mesh.receiveShadow) { mesh.receiveShadow = false; seen.push('receiveShadow'); if (mesh.material) mesh.material.needsUpdate = true; }\n" +
  "            if (list.includes('cast') && mesh.castShadow) { mesh.castShadow = false; seen.push('castShadow'); }\n" +
  "          }\n" +
  "          /* The dark chassis and the light plates are two materials with two  */\n" +
  "          /* base colours, interleaved at the scale of a plate. This sets the  */\n" +
  "          /* frame to the shell's colour — VALUE AND ALL, so it is a probe and */\n" +
  "          /* not a proposal — to size what that interleaving is worth.         */\n" +
  "          if (list.includes('frame') && m.matFrame && m.matShell) {\n" +
  "            m.matFrame.color.copy(m.matShell.color);\n" +
  "            m.matFrame.needsUpdate = true;\n" +
  "            seen.push('frameColour');\n" +
  "          }\n" +
  "        }\n" +
  "        return [...new Set(seen)];\n" +
  "      }, _off);\n" +
  "      console.log('  off: ' + _off.join(',') + '   removed: ' + (_did.join(', ') || 'NOTHING — check the names'));\n" +
  "    }\n" +
  "  }\n";

let out = src;
out = out.replace('  if (NOPAINT) await page.evaluate(', ABLATE_INJECT + '  if (NOPAINT) await page.evaluate(');
out = out.replace('  await page.waitForFunction(() => window.__game',
  BUNDLE_INJECT + '  await page.waitForFunction(() => window.__game');
out = out.replace('      sizes.push(n);\n    }\n    sizes.sort((a, b) => b - a);', CLAUSE_C_SEGMENT);
out = out.replace('      top4: top4 * 100,\n    };', CLAUSE_C_RETURN);
out = out.replace("      top4: Math.round(avg('top4') * 10) / 10,\n    };", CLAUSE_C_AVG);
out = out.replace("  if (errors.length) console.log(",
  CLAUSE_A_INJECT + CLAUSE_C_REPORT + "  if (errors.length) console.log(");

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
/*
 * RULING 30 — `--repeat N`. INSTRUMENT FAULT 30 is that this meter does not
 * agree with itself across runs of one binary: four draws on bundle
 * `83ecfb41023f` returned ROBOT 2 top-4 of 86.2 / 85.3 / 86.2 / 86.2 and clause
 * C ratios of 1.288 / 1.202 / 1.288 / 1.288, on a stencil that was
 * bit-identical every time. The margin on clause A's far cell (86.2 against a
 * threshold of 85.0) is a third of that spread, so the cell was scored MET on a
 * number the meter cannot reproduce.
 *
 * The remedy is not a better renderer and not a fix to the segmentation — it is
 * a SPREAD printed beside the figure, which is fault 15's rule (no single-seed
 * figure without a spread) applied to the axis nobody thought was stochastic.
 *
 * This runs the patched meter N times as N separate processes, so every draw is
 * an independent run of exactly the binary a single draw would have used, and
 * reports:
 *
 *   every draw, in order          so a drifting run is visible, not averaged out
 *   median, min, max, spread      per machine, for clause A count, clause A
 *                                 top-4 and clause C ratio
 *   the RULING 30 disposition     MET needs the WHOLE observed range on the
 *                                 passing side; NOT MET needs the whole range on
 *                                 the failing side; a range that straddles the
 *                                 threshold is UNSCORED and the spread is quoted
 *                                 in the cell
 *
 * The median alone is deliberately not the rule. A cell that passes on median
 * and fails on one draw in four is a cell a rebuild can flip, and this document
 * has been flipped by a rebuild before (INSTRUMENT FAULT 27).
 */
const REPEAT = (() => {
  const i = process.argv.indexOf('--repeat');
  if (i < 0) return 0;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 1 ? Math.floor(v) : 0;
})();

/* Child argv with `--repeat N` stripped: the patched meter knows nothing of it. */
const CHILD_ARGV = (() => {
  const a = process.argv.slice(2);
  const i = a.indexOf('--repeat');
  if (i >= 0) a.splice(i, 2);
  return a;
})();

if (!REPEAT) {
  const r = spawnSync(process.execPath, [TMP, ...CHILD_ARGV], { stdio: 'inherit' });
  try { unlinkSync(TMP); } catch { /* best effort */ }
  process.exit(r.status ?? 1);
}

const A_RE = /^\s{2}ROBOT (\d+)\s+(\S+)\s+count ([0-9.]+) \(max (\d+)\) (MET|FAIL)\s+top4 ([0-9.]+)% (MET|FAIL)/;
const C_RE = /^\s+@51: sd ([0-9.]+) \(worst mass [0-9.]+\)\s+step ([0-9.]+)\s+ratio ([0-9.]+)/;

/*
 * INSTRUMENT FAULT 40 (round 41). The child prints the bundle it measured —
 * fault 27 exists so that it would — and this driver ATE it: spawnSync captures
 * the child's stdout, two regexes take the ROBOT and @51 lines out of it, and
 * everything else, the bundle line included, was dropped on the floor. So the
 * one invocation RULING 49's acceptance test mandates (`--repeat 3`) was the one
 * invocation that could not name its bundle, and every guard column in this
 * document taken with it was labelled by hand. That is the exact precondition of
 * fault 39. The hashes are collected here and re-emitted with the disposition;
 * draws that disagree are a rebuild mid-run and are called out, not averaged.
 */
const BUNDLE_RE = /^\s{2}bundle:\s+(\S+)/;
const bundles = new Set();
const draws = [];
let failed = 0;
for (let n = 0; n < REPEAT; n++) {
  const r = spawnSync(process.execPath, [TMP, ...CHILD_ARGV], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    process.stdout.write('DRAW ' + (n + 1) + ' FAILED, status ' + r.status + '\n');
    process.stdout.write(String(r.stderr || '').slice(-800) + '\n');
    continue;
  }
  const bots = [];
  const seen = [];
  let ci = 0;
  for (const line of String(r.stdout).split('\n')) {
    const b = BUNDLE_RE.exec(line);
    /* The child prints two identifiers — mass.mjs' 12-hex hash OF THE SERVED
     * BYTES and this file's 8-hex FNV OF THE SCRIPT FILENAMES. They are not the
     * same number and this document quotes the first. Both are kept, in order,
     * so a draw's identity is the pair and a mismatch across draws is visible. */
    if (b) { seen.push(b[1]); continue; }
    const a = A_RE.exec(line);
    if (a) { bots.push({ box: a[2], count: Number(a[3]), top4: Number(a[6]), ratio: NaN, step: NaN }); continue; }
    const c = C_RE.exec(line);
    if (c && bots[ci]) { bots[ci].sd = Number(c[1]); bots[ci].step = Number(c[2]); bots[ci].ratio = Number(c[3]); ci++; }
  }
  /* A draw that parsed no machine is a parse fault, not a quiet zero. */
  if (!bots.length) {
    failed++;
    process.stdout.write('DRAW ' + (n + 1) + ' PARSED NOTHING — the report format moved under the harness\n');
    continue;
  }
  bundles.add(seen.length ? seen.join(' / ') : 'NOT PRINTED BY THE CHILD');
  draws.push(bots);
  process.stdout.write('draw ' + (n + 1) + '  ' +
    bots.map((b, i) => 'R' + (i + 1) + ' ' + b.box + ' count ' + b.count.toFixed(1) +
      ' top4 ' + b.top4.toFixed(1) + ' ratio ' + (isNaN(b.ratio) ? 'n/a' : b.ratio.toFixed(3)) +
      ' step ' + (isNaN(b.step) ? 'n/a' : b.step.toFixed(2))).join('   ') + '\n');
}
try { unlinkSync(TMP); } catch { /* best effort */ }

if (!draws.length) { process.stdout.write('\nEVERY DRAW FAILED — nothing to score\n'); process.exit(1); }

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, d) => x.toFixed(d);

/*
 * The disposition rule. `dir` is '>=' when passing means at or above the
 * threshold and '<' when passing means below it. A band is a straddle when the
 * two ends disagree, and a straddle is UNSCORED — never MET, never NOT MET.
 */
const dispose = (lo, hi, thr, dir, thr2) => {
  const pass = (v) => (dir === 'band' ? v >= thr && v <= thr2 : dir === '>=' ? v >= thr : v < thr);
  if (pass(lo) && pass(hi)) return 'MET';
  if (!pass(lo) && !pass(hi)) return 'NOT MET';
  return 'UNSCORED (straddles)';
};

const nBots = Math.max(...draws.map((d) => d.length));
process.stdout.write('\nRULING 30 — ' + draws.length + ' draws' +
  (failed ? ' (' + failed + ' failed)' : '') + ', one binary, spread quoted with every cell\n');
process.stdout.write('  MET needs the WHOLE range on the passing side; a straddle is UNSCORED.\n');
process.stdout.write('  bundle: ' + [...bundles].join('   AND   ') +
  (bundles.size > 1
    ? '\n  *** THE DRAWS DO NOT SHARE A BUNDLE — a rebuild landed mid-run and these figures are NOT one measurement ***'
    : '') + '\n');

for (let i = 0; i < nBots; i++) {
  const col = draws.map((d) => d[i]).filter(Boolean);
  if (!col.length) continue;
  const box = col[0].box;
  const cell = (key, thr, dir, dec, thr2) => {
    const xs = col.map((b) => b[key]).filter((v) => Number.isFinite(v));
    if (!xs.length) return '    ' + key + ': no finite draw\n';
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return '    ' + key.padEnd(6) +
      ' median ' + fmt(med(xs), dec).padStart(7) +
      '   min ' + fmt(lo, dec).padStart(7) +
      '   max ' + fmt(hi, dec).padStart(7) +
      '   spread ' + fmt(hi - lo, dec).padStart(7) +
      '   vs ' + (dir === 'band' ? thr + '-' + thr2 : dir + ' ' + thr).padEnd(6) +
      '   ' + dispose(lo, hi, thr, dir, thr2) + '\n';
  };
  process.stdout.write('  ROBOT ' + (i + 1) + '  ' + box + '\n');
  /*
   * INSTRUMENT FAULT 41 (round 41). This line read `cell('count', 4, '>=', 1)`
   * and then STRING-REPLACED the label 'vs >= 4' with 'vs 4-6'. The clause is a
   * BAND and only its floor was ever tested, so a count of 6.3 — out the top,
   * which is what the paint direction returns on the far machine at +13 levels —
   * printed as `vs 4-6  MET`. The child tests the ceiling (`count 4.8 (max 6)`);
   * this driver, added by RULING 30 to make the meter honest about spread, threw
   * that half of the clause away and lied in the label about having done it.
   */
  process.stdout.write(cell('count', 4, 'band', 1, 6));
  process.stdout.write(cell('top4', 85, '>=', 1));
  process.stdout.write(cell('ratio', 1, '<', 3));
}
process.exit(0);
