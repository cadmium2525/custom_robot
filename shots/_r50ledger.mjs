#!/usr/bin/env node
/**
 * ROUND 50 — the cross-session cell ledger, mechanical rather than asserted.
 *
 * ROUND 48 §5 published "twenty-nine cells reproduce and four do not", ROUND 49 §3
 * corrected it to "twenty-seven of thirty-one", and RULING 70 declined to adjudicate
 * either — so the number had been asserted twice and checked by nobody. This file is
 * the check. It reads the draw lines this round measured (in `_r50data/`, committed
 * beside it) and the prior values transcribed from this document with their line
 * numbers, applies ONE stated criterion to every cell, and prints the tally.
 *
 * Run it:  node shots/_r50ledger.mjs
 *
 * Three things it does that the prose did not:
 *
 *   1. It names the criterion and applies it uniformly, instead of writing "yes" and
 *      "yes, within 0.005" and "yes (median)" in the same column.
 *   2. It EXCLUDES the census, because INSTRUMENT FAULT 57 established that it is a
 *      CPU model over bind-pose vertices; a deterministic model cannot fail to
 *      reproduce, so counting its six cells inflated the numerator with cells that
 *      were never a test.
 *   3. INSTRUMENT FAULT 62 — it asserts its own denominator. The first run of this
 *      ledger read a file the meter was still WRITING, reported ranges over 2 draws
 *      of 6, and turned three AGREEs into DISAGREEs with nothing in the output to say
 *      the set was partial. That is HANDOVER §7's "tail -N cuts off the line you are
 *      about to file a fault about" in a new place, and it nearly put three false
 *      disagreements into the record. A parser that does not check its own n is an
 *      instrument that reports on whatever happened to be on disk.
 */
// Criterion, applied uniformly and stated in the output:
//   AGREE     the prior's whole published interval lies inside mine, or mine inside the prior's
//   CONSISTENT ranges overlap but neither contains the other
//   DISAGREE  ranges are disjoint
// A prior published as a bare point is treated as a zero-width interval.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const S = join(dirname(fileURLToPath(import.meta.url)), '_r50data');
const rd=p=>{try{return readFileSync(p,'utf8')}catch{return''}};
const dr=t=>[...t.matchAll(/^draw \d+\s+R1 \S+ count ([\d.]+) top4 ([\d.]+) ratio ([\d.]+) step ([\d.]+)\s+R2 \S+ count ([\d.]+) top4 ([\d.]+) ratio ([\d.]+) step ([\d.]+)/gm)];
const rng=a=>[Math.min(...a),Math.max(...a)];
const massCol={ 'A near count':1,'A near top-4':2,'C near ratio':3,'A FAR count':5,'A FAR top-4':6,'C FAR ratio':7 };
const EXPECT=6;
function massRange(file,cell){ const d=dr(rd(join(S, file.split('/').pop() + '.txt'))); if(!d.length) return null;
  // INSTRUMENT FAULT 62: this parser read a file that was still being WRITTEN and
  // reported ranges over 2 of 6 draws, turning three AGREEs into DISAGREEs with
  // nothing in the output to say so. A parser must assert its own denominator.
  if(d.length!==EXPECT){
    console.error(`ledger: ${file} has ${d.length} draws, expected ${EXPECT}. Refusing to report a range over a partial set.`);
    process.exit(2);
  }
  return {r:rng(d.map(x=>+x[massCol[cell]])), n:d.length}; }
function verdict(prior, mine){
  if(!mine) return ['PENDING',''];
  const [a,b]=prior,[c,d]=mine;
  if(b<c||d<a) return ['DISAGREE','ranges disjoint'];
  if((a>=c&&b<=d)||(c>=a&&d<=b)) return ['AGREE','one interval contains the other'];
  return ['CONSISTENT','overlap, neither contains the other'];
}
// ---- contour cells: prior values transcribed with their REVIEW2 line numbers
const contour=[
 ['contour baseline','grid near',   [86.0,86.0],   [86.0,86.0],  'L15640'],
 ['contour baseline','grid FAR',    [84.4,84.4],   [84.4,84.4],  'L15641'],
 ['contour baseline','foundry near',[74.6,74.6],   [74.5,74.6],  'L15642'],
 ['contour baseline','foundry FAR', [54.5,54.5],   [54.5,54.5],  'L15643'],
 ['contour baseline','orbital near',[89.4,89.4],   [89.4,89.4],  'L15758'],
 ['contour baseline','orbital FAR', [68.3,68.6],   [68.3,68.6],  'L15759'],
 ['contour COMBINATION','grid near',   [97.4,97.4],  [97.4,97.4],   'L15640'],
 ['contour COMBINATION','grid FAR',    [100.0,100.0],[100.0,100.0], 'L15641'],
 ['contour COMBINATION','foundry near',[87.7,87.7],  [87.7,87.9],   'L15642'],
 ['contour COMBINATION','foundry FAR', [86.4,86.4],  [86.4,86.4],   'L15643'],
 ['contour COMBINATION','orbital near',[100.0,100.0],[100.0,100.0], 'L15758'],
 ['contour COMBINATION','orbital FAR', [90.4,90.5],  [89.9,90.5],   'L15759'],
];
// ---- mass cells: prior from ROUND 46's guard table, mine computed from disk
const massPrior={
 COMBINATION:{'A near count':[4.8,4.8],'A near top-4':[88.2,88.4],'C near ratio':[1.732,1.741],
              'A FAR count':[3.0,3.0],'A FAR top-4':[95.4,95.9],'C FAR ratio':[1.452,1.460]},
 'HALF (paintFar .157 + frame .079)':{'A near count':[4.0,4.0],'A near top-4':[87.8,87.8],'C near ratio':[1.796,1.796],
              'A FAR count':[3.3,3.3],'A FAR top-4':[95.3,95.3],'C FAR ratio':[1.483,1.483]},
 BASELINE:{'A near count':[4.3,4.3],'A near top-4':[85.2,85.3],'C near ratio':[1.706,1.709],
              'A FAR count':[5.5,5.5],'A FAR top-4':[86.1,86.4],'C FAR ratio':[1.288,1.288]},
};
const massFile={COMBINATION:'sweep/comb','HALF (paintFar .157 + frame .079)':'sweep/half_real',BASELINE:'sweep/f000'};
const massLine={COMBINATION:'L15688-93','HALF (paintFar .157 + frame .079)':'L15725-30',BASELINE:'L15688-93'};
const tally={AGREE:0,CONSISTENT:0,DISAGREE:0,PENDING:0};
const show=(g,cell,prior,mine,src)=>{
  const [v,why]=verdict(prior,mine); tally[v]++;
  const f=x=>x?`[${x[0]}, ${x[1]}]`:'(pending)';
  console.log(`  ${g.padEnd(36)} ${cell.padEnd(13)} prior ${f(prior).padEnd(18)} mine ${f(mine).padEnd(18)} ${v.padEnd(11)} ${src}`);
};
console.log('CROSS-SESSION CELL LEDGER  (meter + bundle 586e670836d3 / 93b94641, chromium-1194, n=6 mine)\n');
for(const [g,cell,prior,mine,src] of contour) show(g,cell,prior,mine,src);
for(const [cond,cells] of Object.entries(massPrior)){
  for(const [cell,prior] of Object.entries(cells)){
    const m=massRange(massFile[cond],cell);
    show('mass '+cond,cell,prior,m&&m.r,massLine[cond]);
  }
}
console.log('\n  TALLY:', JSON.stringify(tally));
console.log('  (census excluded: RULING 70 / fault 57 establish it is a CPU model, so its agreement is not probative)');
