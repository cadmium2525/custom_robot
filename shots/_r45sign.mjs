#!/usr/bin/env node
/**
 * ROUND 43 CRITIC — `tools/contour.mjs` with the SIGN of the value step kept.
 *
 *   node shots/_r45sign.mjs --base http://127.0.0.1:4403/custom_robot/ --arena foundry
 *
 * WHY. Clause B's meter scores `Math.abs(inM - outM)` and throws the sign away,
 * and the diagnosis column that round 38 added prints the MEDIAN machine value
 * and the MEDIAN background value over the weak pixels. On every cell but one
 * those two medians are far apart — foundry's far machine reads 69.4 against
 * 51.4 — so the weak contour there is uniformly "machine brighter, but not
 * brightly enough", and a lift on the machine has an unambiguous lever arm.
 *
 * On foundry's NEAR machine they read 83.7 against 83.5. Round 38 read that as
 * a bright BACKGROUND failure and RULING 49 wrote it into the acceptance test
 * as a standing clause. Two medians a fifth of a level apart do not establish
 * that. They are equally consistent with a boundary that is HALF dark-on-bright
 * and half bright-on-dark, and those two readings have opposite consequences:
 * against a uniformly brighter background a machine lift is useless, while
 * against a sign-balanced boundary a machine lift is actively self-cancelling —
 * it repairs one half of the contour by breaking the other.
 *
 * The sign is already computed inside the meter and discarded one line later.
 * This prints it, by ANCHORED REPLACEMENT on the meter read at run time — the
 * `_drivefix.mjs` pattern, for the reason given there: a copy of a 30 KB meter
 * is a second meter, and two meters drift. Both anchors must be found exactly
 * once or the run aborts.
 *
 * Adds three numbers per component and changes nothing else, so every existing
 * figure this prints must reproduce the stock meter's digit for digit — which
 * is the check to run before believing the new column.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));

const FROM_RET = '      weakIn: med1(weak.map((d) => d.i)), weakOut: med1(weak.map((d) => d.o)),';
const TO_RET = FROM_RET + `
      // ROUND 43 CRITIC: the sign, which the line above discards. \`i\` is the
      // machine side of the window and \`o\` is what is behind it, so i < o is a
      // boundary pixel where the MACHINE IS THE DARKER of the two.
      weakN: weak.length,
      weakDarker: weak.length ? Math.round(weak.filter((d) => d.i < d.o).length / weak.length * 1000) / 10 : null,
      allDarker: det.length ? Math.round(det.filter((d) => d.i < d.o).length / det.length * 1000) / 10 : null,`;

const FROM_SHOW = "      console.log(`     where it fails   weak rows: machine ${String(c.weakIn).padStart(5)}  behind ${String(c.weakOut).padStart(5)}`);";
const TO_SHOW = FROM_SHOW + `
      console.log(\`     SIGN             weak rows machine DARKER than behind: \${c.weakDarker}% of \${c.weakN}   whole contour: \${c.allDarker}%\`);`;

const src = readFileSync(join(HERE, '..', 'tools', 'contour.mjs'), 'utf8');
let out = src;
for (const [from, to] of [[FROM_RET, TO_RET], [FROM_SHOW, TO_SHOW]]) {
  const hits = out.split(from).length - 1;
  if (hits !== 1) {
    console.error(
      `_r45sign: expected exactly one\n  ${from}\nin tools/contour.mjs, found ${hits}.\n` +
      'The analyser has changed shape. Re-read it before trusting any reading from this file.'
    );
    process.exit(2);
  }
  out = out.replace(from, to);
}

const tmp = join(HERE, `.r45sign-${process.pid}.mjs`);
writeFileSync(tmp, out);
const r = spawnSync(process.execPath, [tmp, ...process.argv.slice(2)], { stdio: 'inherit' });
try { unlinkSync(tmp); } catch { /* best effort */ }
process.exit(r.status ?? 1);
