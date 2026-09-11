#!/usr/bin/env node
/**
 * WHAT IS THE SUBJECT? — an audit of `_r25-cover.mjs`'s denominator.
 *
 * RULING 40 recorded one defect of kind in the coverage meter: it walks the
 * opponent's bounding BOX and counts any on-stencil pixel inside it, so the
 * other machine can leak in. That was worth 0.07 points and was left.
 *
 * This tool asks the prior question, which nobody has asked: **is the thing in
 * that box a whole machine?** The coverage cell is a percentage OF THE
 * OPPONENT'S OWN STENCIL, so the denominator is a free variable — it is chosen
 * per frame by a connected-component pass, and neither gate of
 * `_r37-screen.mjs` bounds it. Gate 2 counts components larger than 200 px and
 * requires exactly two. A machine whose lower half is behind an occluder is
 * still exactly one component and still passes.
 *
 *   node shots/_r40-subject.mjs --prefix shots/r38-1248
 *
 * It prints, per age, off the SAME PNGs the coverage cell is taken from:
 *
 *   nbox      components > 200 px (gate 2's count)
 *   crumbs    components 20..200 px, and their total pixels — the ones gate 2
 *             throws away. A shattered machine reads `2` boxes here too.
 *   who       which of meta's two robots the chosen component actually is,
 *             by nearest projected centre, with the miss in px. The meter
 *             picks "the smaller box" and has never once been checked against
 *             the engine's own idea of where the far machine is.
 *   box/n     the box, the component's own pixel count, and the meter's
 *             denominator (on-stencil pixels inside the box). Their difference
 *             is RULING 40's leak, measured rather than asserted.
 *   h/rpx     the component's stencil HEIGHT over the engine's projected radius
 *             for that robot. This is a shape invariant: a machine standing in
 *             full view holds it near-constant across ages and pins. A machine
 *             half-hidden does not. It costs nothing and no round has printed it.
 *   Lmed      the median luminance of the VFX layer over the opponent's own
 *             stencil pixels, and the covered/uncovered split at L>25. A cell
 *             of 100.0 whose Lmed sits at 30 is a cut artefact; one at 180 is
 *             fire. RULING 41 could not settle that question because the frame
 *             was gone. Here the frames are on disk.
 *   cuts      coverage at 8/25/60/100/150/200. A statistic pinned at its
 *             ceiling has no derivative, which is what an attribution column
 *             needs. Where 25 reads 100.0 the higher cuts say how much headroom
 *             the frame actually had.
 *
 * A RENDER, NOT A DIFFERENCE, throughout: the VFX layer is read from
 * `-vfxonly.png`, never from `raw - novfx`.
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

const PREFIX = flag('prefix', 'shots/r38-1248');
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// INSTRUMENT FAULT 56. This used to read `PINNED`, which
// resolves a missing pin to the DEFAULT browser instead of stopping. A guard the
// caller can redirect is not a guard (faults 29, 43 and 53), and a figure taken on a
// different rasteriser than the card was measured on is not comparable to it.
if (!existsSync(PINNED)) {
  console.error('INSTRUMENT FAULT 56: this file pins ' + PINNED + ' and it is not on this box.');
  console.error('Refusing to fall back to the default browser. Install that build or run elsewhere.');
  process.exit(2);
}

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
  if (V.W !== M.W || V.H !== M.H) throw new Error(`size mismatch`);
  const W = M.W, H = M.H;

  const seen = new Uint8Array(W * H);
  const isOn = (i) => M.d[i * 4] > 128;
  const comps = [];
  const stack = [];
  for (let p = 0; p < W * H; p++) {
    if (seen[p] || !isOn(p)) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0, sx = 0, sy = 0;
    const seed = p;
    stack.length = 0; stack.push(p); seen[p] = 1;
    while (stack.length) {
      const q = stack.pop();
      const x = q % W, y = (q / W) | 0;
      n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !seen[q - 1] && isOn(q - 1)) { seen[q - 1] = 1; stack.push(q - 1); }
      if (x < W - 1 && !seen[q + 1] && isOn(q + 1)) { seen[q + 1] = 1; stack.push(q + 1); }
      if (y > 0 && !seen[q - W] && isOn(q - W)) { seen[q - W] = 1; stack.push(q - W); }
      if (y < H - 1 && !seen[q + W] && isOn(q + W)) { seen[q + W] = 1; stack.push(q + W); }
    }
    comps.push({ x0, y0, x1, y1, n, seed, cx: sx / n, cy: sy / n });
  }
  const big = comps.filter((c) => c.n > 200).sort((a, b) => b.n - a.n);
  const crumbs = comps.filter((c) => c.n > 20 && c.n <= 200);
  const crumbPx = crumbs.reduce((s, c) => s + c.n, 0);
  if (!big.length) return { err: 'no machine in the stencil' };

  // _r25-cover.mjs's own subject rule, reproduced exactly.
  const far = big.length > 1 ? big[big.length - 1] : big[0];

  const cuts = [8, 25, 60, 100, 150, 200];
  const hitBox = cuts.map(() => 0);
  const hitComp = cuts.map(() => 0);
  let denomBox = 0;
  const lums = [];
  // Component membership, so the box rule and the component rule can be split.
  // SEEDED FROM THE COMPONENT ITSELF, not from the first on-pixel in the box:
  // the other machine can clip the corner of this box, and a flood started on
  // that pixel measures the wrong machine. It did, on the first run of this
  // tool — pin 896 at 333 ms, where the neighbour intrudes by exactly one pixel.
  const inComp = new Uint8Array(W * H);
  {
    const seen2 = new Uint8Array(W * H);
    const s2 = [far.seed];
    seen2[far.seed] = 1;
    while (s2.length) {
      const q = s2.pop();
      inComp[q] = 1;
      const x = q % W, y = (q / W) | 0;
      if (x > 0 && !seen2[q - 1] && isOn(q - 1)) { seen2[q - 1] = 1; s2.push(q - 1); }
      if (x < W - 1 && !seen2[q + 1] && isOn(q + 1)) { seen2[q + 1] = 1; s2.push(q + 1); }
      if (y > 0 && !seen2[q - W] && isOn(q - W)) { seen2[q - W] = 1; s2.push(q - W); }
      if (y < H - 1 && !seen2[q + W] && isOn(q + W)) { seen2[q + W] = 1; s2.push(q + W); }
    }
  }
  let denomComp = 0;
  for (let y = far.y0; y <= far.y1; y++) {
    for (let x = far.x0; x <= far.x1; x++) {
      const i = y * W + x;
      if (!isOn(i)) continue;
      denomBox++;
      const L = 0.2126 * V.d[i * 4] + 0.7152 * V.d[i * 4 + 1] + 0.0722 * V.d[i * 4 + 2];
      for (let k = 0; k < cuts.length; k++) if (L > cuts[k]) hitBox[k]++;
      if (inComp[i]) {
        denomComp++;
        lums.push(L);
        for (let k = 0; k < cuts.length; k++) if (L > cuts[k]) hitComp[k]++;
      }
    }
  }
  // SUBJECT-SIZE CONTROL. The cell is a percentage of the opponent's own
  // stencil, so its denominator is a free variable that ranges over 986..3925
  // px across the 21 cells of the set — a factor of four, chosen by the frame
  // and bounded by neither gate of `_r37-screen.mjs`. A ratio whose denominator
  // is that free is not comparable across pins until somebody scores the same
  // frame on a subject of FIXED size. So: the same L>25 cut over discs of
  // radius 20/40/80/160 px centred on the opponent's own centroid. If the
  // neighbourhood is covered as densely as the machine, the machine's size did
  // not make the number; if it falls away with radius, it did.
  const RS = [20, 40, 80, 160];
  const disc = RS.map(() => ({ n: 0, hit: 0 }));
  const ccx = Math.round(far.cx), ccy = Math.round(far.cy);
  for (let k = 0; k < RS.length; k++) {
    const R = RS[k];
    for (let y = Math.max(0, ccy - R); y <= Math.min(H - 1, ccy + R); y++) {
      for (let x = Math.max(0, ccx - R); x <= Math.min(W - 1, ccx + R); x++) {
        const dx = x - ccx, dy = y - ccy;
        if (dx * dx + dy * dy > R * R) continue;
        const i = y * W + x;
        disc[k].n++;
        const L = 0.2126 * V.d[i * 4] + 0.7152 * V.d[i * 4 + 1] + 0.0722 * V.d[i * 4 + 2];
        if (L > 25) disc[k].hit++;
      }
    }
  }

  lums.sort((a, b) => a - b);
  const q = (f) => (lums.length ? lums[Math.min(lums.length - 1, Math.floor(f * lums.length))] : 0);

  return {
    nbox: big.length,
    crumbs: crumbs.length,
    crumbPx,
    boxes: big.map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, n: c.n, cx: c.cx, cy: c.cy })),
    far: { x0: far.x0, y0: far.y0, x1: far.x1, y1: far.y1, n: far.n, cx: far.cx, cy: far.cy },
    denomBox, denomComp,
    edge: far.x0 === 0 || far.y0 === 0 || far.x1 === W - 1 || far.y1 === H - 1,
    W, H,
    pctBox: hitBox.map((v) => (denomBox ? (100 * v) / denomBox : 0)),
    pctComp: hitComp.map((v) => (denomComp ? (100 * v) / denomComp : 0)),
    uncovered25: denomComp - hitComp[1],
    lmed: q(0.5), lp10: q(0.1), lp90: q(0.9),
    disc: disc.map((d) => (d.n ? (100 * d.hit) / d.n : 0)),
  };
};

const browser = await chromium.launch({
  headless: true,
  executablePath: PINNED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });

console.log(`SUBJECT AUDIT — ${PREFIX}   bundle ${meta.bundle}`);
console.log(`  ${meta.arena} @ ${meta.tier}, seed ${meta.seed}, blast tick ${meta.blast.tick}, viewport ${meta.viewport.w}x${meta.viewport.h}`);
console.log('  subject rule reproduced from _r25-cover.mjs: the SMALLEST component > 200 px.\n');
console.log('   ms | nbox crumbs |  who miss | box    n(comp) leak | h/rpx | sep/R | Lmed Lp10 | unc |  L>8   L>25   L>60  L>100  L>150  L>200 | DISC L>25 r20   r40   r80  r160');

for (const s of meta.shots) {
  const tag = String(s.age).padStart(2, '0');
  const vfx = `${PREFIX}-a${tag}-vfxonly.png`;
  const mach = `${PREFIX}-a${tag}-mach.png`;
  if (!existsSync(vfx) || !existsSync(mach)) continue;
  const r = await page.evaluate(`(${ANALYSE})(${JSON.stringify({ vfxUri: uri(vfx), machUri: uri(mach) })})`);
  if (r.err) { console.log(`  ${String(s.ms).padStart(4)} | ${r.err}`); continue; }
  const pr = s.pr;
  const d0 = Math.hypot(r.far.cx - pr.robo0.x, r.far.cy - pr.robo0.y);
  const d1 = Math.hypot(r.far.cx - pr.robo1.x, r.far.cy - pr.robo1.y);
  const who = d1 <= d0 ? 'robo1' : 'robo0';
  const miss = Math.min(d0, d1);
  const rpx = who === 'robo1' ? pr.robo1.rpx : pr.robo0.rpx;
  const h = r.far.y1 - r.far.y0 + 1;
  const w = r.far.x1 - r.far.x0 + 1;
  const f = (v) => v.toFixed(1).padStart(6);
  console.log(`  ${String(s.ms).padStart(4)} |  ${String(r.nbox).padStart(2)}  ${String(r.crumbs).padStart(2)}(${String(r.crumbPx).padStart(3)}) | ${
    who} ${miss.toFixed(0).padStart(3)} | ${String(w).padStart(2)}x${String(h).padEnd(3)} ${
    String(r.far.n).padStart(5)} ${String(r.denomBox - r.denomComp).padStart(4)} | ${
    (h / rpx).toFixed(2).padStart(5)} | ${(pr.robo1.sep / pr.blast.rpx).toFixed(2).padStart(5)} | ${
    String(Math.round(r.lmed)).padStart(4)} ${String(Math.round(r.lp10)).padStart(4)} | ${
    String(r.uncovered25).padStart(3)} |${r.pctBox.map(f).join(' ')} |${r.disc.map(f).join(' ')}${r.edge ? '  EDGE' : ''}`);
}

await browser.close();
console.log('\n  h/rpx is the shape invariant. `who`/`miss` is the meter\'s subject checked against the engine\'s.');
console.log('  leak = denom(box) - denom(component): RULING 40\'s box-rule defect, in pixels.');
console.log('  unc = stencil pixels of the opponent NOT covered at L>25. A cell of 100.0 has unc 0.');
console.log('  sep/R = the opponent\'s screen offset from the blast centre over the blast\'s projected radius:');
console.log('          how deep inside the fireball\'s own disc the subject sits. Neither gate bounds it.');
console.log('  DISC = the same L>25 cut over fixed-radius discs at the opponent\'s centroid — the subject-size control.');
