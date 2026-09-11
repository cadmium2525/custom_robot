/**
 * The ONE settle, read out of the meter at run time.
 *
 * INSTRUMENT FAULT 45. `shots/_r44probe.mjs` was written to "run contour.mjs's
 * exact pin and settle" and it did — for one commit. `5a30c18` added the LOD
 * freeze to `tools/contour.mjs`, `tools/mass.mjs` and `shots/_r15dump.mjs` and
 * did NOT add it to the probe, whose only edit in that commit was an extra
 * `env` dump. So the file the round-42 record cites as evidence about the
 * meter now settles the frame differently from the meter, and a re-run of it
 * would report on a machine no clause is scored on.
 *
 * That is fault 38's shape exactly — two copies of one procedure, one of them
 * edited — and it is the fourth copy of this settle in the tree. The three in
 * the meters are load-bearing and are kept in step by hand under a rule that
 * has now been broken once. A PROBE has no such excuse: it can read the meter's
 * own text. So it does.
 *
 * Extraction is by anchor and it ABORTS rather than guessing: the template
 * literal runs from `const SETTLE_FN = \`` to the first line that is exactly
 * "}`;", which cannot occur inside it because every backtick in the body is
 * escaped. If either anchor is missing, or the body does not still contain the
 * two lines this project's last two faults were about, nothing is returned.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));

const START = 'const SETTLE_FN = `';
const END = '\n}`;';

/** The meter's settle body, as a string ready for `(${body})(240)`. */
export function settleFn(tool = 'contour.mjs') {
  const src = readFileSync(join(HERE, '..', 'tools', tool), 'utf8');
  const i = src.indexOf(START);
  if (i < 0 || src.indexOf(START, i + 1) >= 0) {
    console.error(`_settlesrc: expected exactly one \`${START}\` in tools/${tool}.`);
    process.exit(2);
  }
  const j = src.indexOf(END, i);
  if (j < 0) {
    console.error(`_settlesrc: no terminating "}\`;" for SETTLE_FN in tools/${tool}.`);
    process.exit(2);
  }
  const body = src.slice(i + START.length - 1 + 1, j + 2); // '(n) => { ... }'
  // The two things this settle is currently believed to do. If a later round
  // removes either, a probe quoting "the meter's settle" must stop rather than
  // report on a settle that is no longer the one described in the ledger.
  for (const need of ['m.spinAngle = 0', 'm._applyLod = () => {}']) {
    if (!body.includes(need)) {
      console.error(`_settlesrc: tools/${tool}'s settle no longer contains \`${need}\`.`);
      process.exit(2);
    }
  }
  return body;
}

/**
 * The BROWSER the meters pin, read out of the meter at run time.
 *
 * INSTRUMENT FAULT 53. `shots/_r46size.mjs` — the census behind RULING 60's
 * per-fragment table, and behind every gate argument built on it — carried its
 * own copy of the pin, at a DIFFERENT build from the meters
 * (`chromium-1148` against the meters' `chromium-1194`) and at a path in
 * `~/.cache` rather than `/opt/pw-browsers`. Worse than the mismatch, the guard
 * was `existsSync(PINNED) ? PINNED : undefined`, so on any box where that build
 * is absent it SILENTLY fell back to whatever playwright resolves by default.
 * That is fault 29 and 43's shape exactly — a guard a caller can redirect is
 * not a guard — applied to the rasteriser instead of to a uniform.
 *
 * So the pin is read from the meter's own text, like the settle beside it, and
 * a missing binary is an ABORT rather than a fallback. A probe that cannot run
 * on the meter's browser must stop, not quietly report on another one.
 */
export function pinnedBrowser(tool = 'contour.mjs') {
  const src = readFileSync(join(HERE, '..', 'tools', tool), 'utf8');
  const m = src.match(/^const PINNED = '([^']+)';$/m);
  if (!m) {
    console.error(`_settlesrc: no "const PINNED = '...'" in tools/${tool}.`);
    process.exit(2);
  }
  if (!existsSync(m[1])) {
    console.error(`_settlesrc: tools/${tool} pins ${m[1]} and it is not on this box.`);
    console.error('_settlesrc: refusing to fall back — a probe on a different browser than the meter');
    console.error('            is not a probe of the meter. Install that build or run elsewhere.');
    process.exit(2);
  }
  return m[1];
}
