#!/usr/bin/env node
/**
 * COVERAGE, AS A RENDER RATHER THAN AS A DIFFERENCE — instrument fault 28's fix.
 *
 * Clause F sub-clause 2 asks whether the effects swallow the opponent. Every
 * figure ever filed for it came from `|luma(raw) - luma(novfx)|`, which is a
 * statement about what the VFX layer CHANGED. Those come apart the moment the
 * thing underneath changes brightness: `8b071d2` made the aiming target darker —
 * it had been sitting at 220 of 255 before anything was drawn over it — and the
 * difference column immediately read 117 ms as 20.0 -> 87.0. The same effect
 * over a better-behaved machine measured as four times the alteration.
 *
 * The critic's standing rule, after four instrument faults of this shape: **a
 * mask is a render, not a difference.** `_r17-blast.mjs` now writes
 * `<prefix>-a<NN>-vfxonly.png` — the effects layer alone, everything else
 * hidden, cleared to black — and this reads it against the machine stencil the
 * same capture already writes.
 *
 *   node shots/_r25-cover.mjs --prefix shots/r25h
 *
 * REPORTED AT THREE THRESHOLDS ON PURPOSE. A single cut would be a knob, and a
 * knob on a coverage number is how a clause gets argued instead of measured. 25
 * and 60 match the C>25 / C>60 columns the difference meter already prints, so
 * the two can be read side by side; 8 is "the effect drew anything here at all",
 * which on a black clear is close to the footprint's true support.
 *
 * The opponent is the SMALLER of the two stencil boxes — clause F's "far"
 * machine, the one being aimed at. That is the same rule `_r23-lightprobe.mjs`
 * uses, stated here so the two agree by construction rather than by luck.
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const PREFIX = flag('prefix', 'shots/r25h');
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const meta = JSON.parse(readFileSync(`${PREFIX}-meta.json`, 'utf8'));
const uri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

const ANALYSE = async ({ vfxUri, machUri }) => {
  const load = async (u) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };
  const V = await load(vfxUri);
  const M = await load(machUri);
  if (V.W !== M.W || V.H !== M.H) throw new Error(`size mismatch ${V.W}x${V.H} vs ${M.W}x${M.H}`);

  // Connected machine regions from the stencil, so "the opponent" is a box this
  // tool derives rather than a rectangle somebody typed.
  const seen = new Uint8Array(M.W * M.H);
  const boxes = [];
  const isOn = (i) => M.d[i * 4] > 128;
  const stack = [];
  for (let p = 0; p < M.W * M.H; p++) {
    if (seen[p] || !isOn(p)) continue;
    let x0 = M.W, y0 = M.H, x1 = -1, y1 = -1, n = 0;
    stack.length = 0; stack.push(p); seen[p] = 1;
    while (stack.length) {
      const q = stack.pop();
      const x = q % M.W, y = (q / M.W) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !seen[q - 1] && isOn(q - 1)) { seen[q - 1] = 1; stack.push(q - 1); }
      if (x < M.W - 1 && !seen[q + 1] && isOn(q + 1)) { seen[q + 1] = 1; stack.push(q + 1); }
      if (y > 0 && !seen[q - M.W] && isOn(q - M.W)) { seen[q - M.W] = 1; stack.push(q - M.W); }
      if (y < M.H - 1 && !seen[q + M.W] && isOn(q + M.W)) { seen[q + M.W] = 1; stack.push(q + M.W); }
    }
    if (n > 200) boxes.push({ x0, y0, x1, y1, n });
  }
  boxes.sort((a, b) => b.n - a.n);
  if (!boxes.length) return { err: 'no machine in the stencil' };
  // Smaller box = the far machine = the opponent being aimed at.
  const far = boxes.length > 1 ? boxes[boxes.length - 1] : boxes[0];

  const cuts = [8, 25, 60];
  const hit = [0, 0, 0];
  let total = 0;
  for (let y = far.y0; y <= far.y1; y++) {
    for (let x = far.x0; x <= far.x1; x++) {
      const i = y * M.W + x;
      if (!isOn(i)) continue;
      total++;
      const L = 0.2126 * V.d[i * 4] + 0.7152 * V.d[i * 4 + 1] + 0.0722 * V.d[i * 4 + 2];
      for (let k = 0; k < 3; k++) if (L > cuts[k]) hit[k]++;
    }
  }
  return {
    boxes: boxes.length,
    w: far.x1 - far.x0 + 1,
    h: far.y1 - far.y0 + 1,
    px: total,
    pct: hit.map((v) => (total ? (100 * v) / total : 0)),
  };
};

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(PINNED) ? PINNED : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });

console.log(`COVERAGE AS A RENDER — ${PREFIX}   bundle ${meta.bundle}`);
console.log(`  ${meta.arena} @ ${meta.tier}, seed ${meta.seed}, blast tick ${meta.blast.tick}`);
console.log('  opponent = the SMALLER stencil box. Clause F sub-clause 2 threshold is 25%.\n');
console.log('  age    ms  |  nbox  opponent box    px  |  L>8     L>25    L>60');

let missing = 0;
let nbox2 = true;
for (const s of meta.shots) {
  const tag = String(s.age).padStart(2, '0');
  const vfx = `${PREFIX}-a${tag}-vfxonly.png`;
  const mach = `${PREFIX}-a${tag}-mach.png`;
  if (!existsSync(vfx) || !existsSync(mach)) { missing++; continue; }
  const r = await page.evaluate(`(${ANALYSE})(${JSON.stringify({
    vfxUri: uri(vfx), machUri: uri(mach),
  })})`);
  if (r.err) { console.log(`  ${String(s.age).padStart(3)}  ${String(s.ms).padStart(4)}  |  ${r.err}`); continue; }
  const f = (v) => v.toFixed(1).padStart(6);
  // The box COUNT decides which component "the opponent" is, and the tool used
  // to compute it and throw it away. If a machine's stencil splits into three
  // components — an occluder cutting a leg off, a detached part — then
  // boxes[len-1] is a fragment and every number on that row is a fragment's.
  // An instrument that picks a subject silently is fault 29's shape: it is
  // allowed to pick, it is not allowed to pick without saying so. Two boxes is
  // the only count under which this row means what its heading says.
  if (r.boxes !== 2) nbox2 = false;
  console.log(`  ${String(s.age).padStart(3)}  ${String(s.ms).padStart(4)}  |  ${
    String(r.boxes).padStart(3)}${r.boxes === 2 ? ' ' : '!'}  ${
    String(r.w).padStart(4)}x${String(r.h).padEnd(4)} ${String(r.px).padStart(6)}  |${
    f(r.pct[0])}  ${f(r.pct[1])}  ${f(r.pct[2])}`);
}

await browser.close();

// A run that silently measured nothing is fault 21 again; refuse instead.
if (missing === meta.shots.length) {
  console.error(`\nno -vfxonly.png for any age under ${PREFIX} — re-capture with a build that writes it`);
  process.exit(1);
}
if (missing) console.log(`\n  ${missing} age(s) had no -vfxonly.png and were skipped`);
if (!nbox2) {
  console.log('\n  ! at least one age segmented to something other than TWO machine boxes.');
  console.log('    On those rows "the opponent" is the smallest component, which may be a');
  console.log('    fragment of either machine. Read them as suspect until the stencil is checked.');
} else {
  console.log('\n  every age segmented to exactly two machine boxes, so "the smaller box" is a machine.');
}
