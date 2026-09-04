#!/usr/bin/env node
/**
 * THE GEOMETRY OF THE PIN, READ OFF CAPTURES ALREADY PAID FOR.
 *
 * Round 36's first question, and it costs nothing: **is the opponent simply
 * standing inside the blast?** `_r17-blast.mjs` has been writing the answer
 * into every `-meta.json` it produces since round 34 and nothing has ever read
 * it back. Per age it stores `pr` — the pinned blast's world position projected
 * to screen, its camera distance and its on-screen radius `rpx`, plus both
 * machines' screen positions, camera distances, their own projected radii and
 * their separation from the blast centre in pixels.
 *
 * So the question clause F sub-clause 2 actually asks — how much of the
 * opponent's disc does the effect's disc cover — is arithmetic on numbers that
 * are already on disk, at every age, for every pin ever captured.
 *
 *   node shots/_r36-geom.mjs shots/r34c-off-meta.json shots/r32base-meta.json
 *
 * WHAT THE COLUMNS MEAN, stated because a figure that does not name its meter
 * is not a figure:
 *
 *   far      which machine is the OPPONENT. `_r25-cover.mjs` scores the SMALLER
 *            stencil box, i.e. the machine further from the camera, so that is
 *            what is named here and the two agree by construction.
 *   fd       the opponent's camera distance in metres.
 *   sep      the opponent's screen distance from the blast centre, in CSS px.
 *   Rpx      the blast's on-screen radius, in CSS px. `_r17-blast.mjs` builds it
 *            as `radius * 1.5 / dist * f` — 1.5 R because the fireball cluster
 *            reaches about that at its widest (core R*0.72 plus lobes thrown to
 *            about R*0.8). It is the radius of the whole mass, not of the core,
 *            and it is a FULL-LIFE radius: the mass only reaches it at peak.
 *   frpx     the opponent's own projected radius, on the metre-radius sphere at
 *            chest height that the composition rule uses as a machine proxy.
 *   sep/R    the critic's filed quantity: how deep the opponent's CENTRE stands
 *            inside the fireball's projected radius. 0.0 is dead centre.
 *   far/R    the far EDGE of the opponent's disc, (sep + frpx) / Rpx. Under 1.0
 *            the whole machine is inside the projected mass — there is no part
 *            of it the effect has to reach past.
 *   in       the fraction of the opponent's DISC covered by the blast's disc,
 *            clamped to [0,1]: `(Rpx + frpx - sep) / (2 * frpx)`. This is the
 *            same expression `_r17-blast.mjs`'s scan listing prints, restated
 *            here per age rather than once per blast.
 *
 * AND THE THREE COLUMNS THAT SEPARATE THE TWO WAYS A DISC CAN BE COVERED,
 * because `in = 1.00` on its own cannot tell them apart and the fix is not the
 * same in the two cases:
 *
 *   bd       the blast centre's own camera distance, in metres. If bd < fd the
 *            blast stands BETWEEN the camera and the opponent.
 *   d3       the true 3-D distance from the blast centre to the opponent, in
 *            metres, by the law of cosines on the two camera rays. The angle
 *            between them is `atan(sep / f)`, and the focal length in pixels
 *            comes free from the projection the capture already stored:
 *            `frpx = 1.0 m / fd * f`, so `f = frpx * fd`, with no camera matrix
 *            needed and no fov typed in by hand.
 *   d3/M     that distance in units of the effect's own MASS radius, `1.5 * R`
 *            — the same 1.5 R `_r17-blast.mjs` uses for `rpx`, so the two agree.
 *            **Under 1.0 the opponent is inside the fireball. Over 1.0 it is
 *            outside it, and any coverage is a foreground object standing in
 *            front of a background machine rather than a machine engulfed.**
 *
 * It reports the geometry and stops. Whether a machine standing wholly inside a
 * detonation may be drawn as covered is a reading of the clause and belongs to
 * the critic; this file's job is to say whether it IS standing inside one.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node shots/_r36-geom.mjs <prefix>-meta.json [...]');
  process.exit(2);
}

for (const f of files) {
  const m = JSON.parse(readFileSync(f, 'utf8'));
  const b = m.blast;
  console.log(`\n${f}`);
  console.log(`  bundle ${m.bundle}   ${m.arena} @ ${m.tier}, seed ${m.seed}, viewport ${m.viewport.w}x${m.viewport.h}`);
  console.log(`  PINNED BLAST: tick ${b.tick}  kind ${b.kind}  world R ${b.radius.toFixed(2)} m  ` +
    `at (${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)})`);
  console.log('');
  console.log(`  mass radius 1.5R = ${(b.radius * 1.5).toFixed(2)} m`);
  console.log('');
  console.log('   age    ms | far   fd(m)   sep    Rpx   frpx | sep/R  far/R    in |  bd(m)  d3(m)   d3/M');
  for (const s of m.shots) {
    const pr = s.pr;
    // Pre-round-34 captures projected only x/y/z and carry no dist, rpx or sep.
    // Refusing the row is the house rule: a meter that prints a number it did
    // not measure is how four instrument faults got on the record.
    if (!pr || !pr.blast || pr.blast.rpx === undefined || pr.robo0.dist === undefined) {
      console.log(`  ${String(s.age).padStart(4)}  ${String(s.ms).padStart(4)} | ` +
        'NO GEOMETRY — capture predates the round-34 projection fields');
      continue;
    }
    const farKey = pr.robo1.dist > pr.robo0.dist ? 'robo1' : 'robo0';
    const far = pr[farKey];
    const Rpx = pr.blast.rpx;
    const inBlast = Math.max(0, Math.min(1, (Rpx + far.rpx - far.sep) / (2 * far.rpx)));
    // Focal length in pixels, recovered from the machine proxy the capture
    // already projected: frpx px is 1.0 m at the opponent's depth, so
    // frpx * fd is the focal length and no camera matrix or typed-in fov is
    // needed. (It comes out at 760-765 px on every pin, which is the check.)
    const fpx = far.rpx * far.dist;
    // The angle between the two camera rays, exactly rather than as
    // `atan(sep / f)`. The small-angle form is within 0.01 degrees at these
    // offsets, but both points sit ~200 px off the principal point and an
    // approximation nobody bounded is how figures get argued instead of read.
    const ray = (q) => {
      const d = [q.x - m.viewport.w / 2, q.y - m.viewport.h / 2, fpx];
      const n2 = Math.hypot(d[0], d[1], d[2]);
      return [d[0] / n2, d[1] / n2, d[2] / n2];
    };
    const rb = ray(pr.blast);
    const rf = ray(far);
    const theta = Math.acos(Math.max(-1, Math.min(1, rb[0] * rf[0] + rb[1] * rf[1] + rb[2] * rf[2])));
    const bd = pr.blast.dist;
    const d3 = Math.sqrt(bd * bd + far.dist * far.dist - 2 * bd * far.dist * Math.cos(theta));
    const mass = b.radius * 1.5;
    const n = (v, w, d = 1) => v.toFixed(d).padStart(w);
    console.log(`  ${String(s.age).padStart(4)}  ${String(s.ms).padStart(4)} | ` +
      `${farKey === 'robo1' ? 'p2 ' : 'p1 '} ${n(far.dist, 6, 2)} ${n(far.sep, 6)} ${n(Rpx, 6)} ${n(far.rpx, 6)} | ` +
      `${n(far.sep / Rpx, 5, 3)} ${n((far.sep + far.rpx) / Rpx, 6, 3)} ${n(inBlast, 5, 2)} | ` +
      `${n(bd, 6, 2)} ${n(d3, 6, 2)} ${n(d3 / mass, 6, 2)}`);
  }
}
console.log('');
