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
import { readFileSync } from 'node:fs';
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
