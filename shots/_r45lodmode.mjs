#!/usr/bin/env node
/**
 * ROUND 43 CRITIC — `tools/contour.mjs` with its LOD clamp set to one of three
 * modes, and NOTHING else changed.
 *
 *   node shots/_r45lodmode.mjs --mode frozen --arena foundry      # stock, = HEAD
 *   node shots/_r45lodmode.mjs --mode live   --arena foundry      # no clamp at all
 *   node shots/_r45lodmode.mjs --mode full   --arena foundry      # lodMinPx2 = 0
 *
 * WHY IT REWRITES THE METER INSTEAD OF COPYING IT — the same reason
 * `shots/_drivefix.mjs` gives, which this file is modelled on. A copy of the
 * meter is a second meter, two meters drift, and instrument fault 45 (filed
 * this round) is a probe that drifted from the meter in exactly one commit.
 * So the stock tool is read at run time, ONE anchor is replaced, and the run
 * ABORTS if the anchor is not found exactly once.
 *
 *   frozen  no replacement — the tool as committed, so `--mode frozen` and a
 *           bare `node tools/contour.mjs` are the same instrument by
 *           construction and any disagreement between them is this file's bug.
 *   live    the freeze line is deleted, so `_applyLod` keeps running off the
 *           live camera every frame — the SHIPPED renderer's behaviour, and the
 *           meter's own behaviour before `5a30c18`.
 *   full    `lodMinPx2` and `outLodMinPx2` are zeroed before the resolve, so
 *           every index is drawn. This is the control robot.js's own LOD
 *           comment names: "0 disables the LOD entirely, which is the control
 *           every claim made about it has to be run against".
 *
 * `live` is the interesting one: it is the machine the player is actually
 * looking at when the shutter opens, and if the frozen cells and the live cells
 * differ then the clamp is not neutral and clause B is being scored on a
 * machine the game does not draw.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const mi = argv.indexOf('--mode');
const MODE = mi < 0 ? 'frozen' : argv[mi + 1];
const rest = mi < 0 ? argv : argv.slice(0, mi).concat(argv.slice(mi + 2));

const FREEZE = 'for (const m of g.view.models) if (m._applyLod) m._applyLod = () => {};';
const RESOLVE = 'for (const m of g.view.models) if (m._applyLod) m._applyLod(g.engine.renderer, cam);';

const PATCHES = {
  frozen: null,
  live: [FREEZE, '/* r43 audit: LOD left live, as the shipped renderer runs it */'],
  full: [
    RESOLVE,
    'for (const m of g.view.models) { m.lodMinPx2 = 0; m.outLodMinPx2 = 0; ' +
    'm._lodBudget = -1; m._outBudget = -1; if (m._applyLod) m._applyLod(g.engine.renderer, cam); }',
  ],
};

if (!(MODE in PATCHES)) {
  console.error(`_r45lodmode: --mode must be one of ${Object.keys(PATCHES).join(', ')}`);
  process.exit(2);
}

const src = readFileSync(join(HERE, '..', 'tools', 'contour.mjs'), 'utf8');
// Both anchors are checked in EVERY mode, including the one that patches
// neither. A mode that silently measures a meter whose clamp has been rewritten
// underneath it is the fault this file exists to avoid.
for (const anchor of [FREEZE, RESOLVE]) {
  const hits = src.split(anchor).length - 1;
  if (hits !== 1) {
    console.error(
      `_r45lodmode: expected exactly one\n  ${anchor}\nin tools/contour.mjs, found ${hits}.\n` +
      'The clamp has changed shape. Re-read it before trusting any reading from this file.'
    );
    process.exit(2);
  }
}

const patch = PATCHES[MODE];
const out = patch ? src.replace(patch[0], patch[1]) : src;
if (patch && out === src) { console.error('_r45lodmode: replacement was a no-op'); process.exit(2); }

// In shots/ (gitignored for the temp, resolvable for node_modules) — see
// _drivefix.mjs for why os.tmpdir() is the obvious wrong answer here.
const tmp = join(HERE, `.r45lod-${MODE}-${process.pid}.mjs`);
writeFileSync(tmp, out);
console.log(`  LOD MODE: ${MODE}`);
const r = spawnSync(process.execPath, [tmp, ...rest], { stdio: 'inherit' });
try { unlinkSync(tmp); } catch { /* best effort */ }
process.exit(r.status ?? 1);
