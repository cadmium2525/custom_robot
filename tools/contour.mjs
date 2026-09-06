#!/usr/bin/env node
/**
 * Silhouette meter — does the robot separate from what is behind it?
 *
 * Defect #24 ("mushy silhouette") survived five review rounds because it was
 * argued about in words and inspected in zoomed-in crops. Zooming is precisely
 * what hides it: at 400% every panel line is crisp and the robot looks great,
 * while at gameplay size the machine is 90px tall and dissolves into the deck.
 * So this measures the thing directly, at the size the player actually sees.
 *
 *   node tools/contour.mjs --base http://127.0.0.1:4241/
 *
 * Method. Two screenshots are taken from ONE frozen frame — the engine is
 * paused, so the camera, the sim and the effect clock are all held still:
 *
 *   N  the frame as rendered
 *   M  a silhouette pass: everything but the shells hidden, flat white override
 *
 * M is an exact binary stencil of the machines, which is a ground-truth mask
 * with no coordinate guessing and no colour keying. Two details matter for
 * honesty:
 *
 *   - The contact shadow and blob are excluded from the stencil. A shadow is
 *     not silhouette; counting it would credit the robot for a dark patch it
 *     merely casts.
 *   - VFX are suppressed before either capture. A muzzle flash lying across
 *     the outline is not the outline, and it moves, so including it would make
 *     the measurement unrepeatable.
 *
 * The mask's boundary is then walked over N. For each boundary pixel a 7x7
 * window is split into its mask and non-mask halves, and the difference of
 * their mean luminances is the local value step — how hard the edge reads
 * right there, against whatever the robot actually happens to be in front of.
 *
 * What comes out is a distribution, because a silhouette does not fail
 * uniformly: a robot can be perfectly crisp against a dark wall and vanish
 * where it crosses a bright deck tile, and the average of those two is a
 * meaningless number that hides both. The headline figure is therefore the
 * fraction of the contour whose step falls below a legibility floor.
 *
 * Rules of thumb used for the verdict, in 0-255 sRGB:
 *   step < 12   invisible edge — the outline is gone there
 *   step < 25   weak — survives a still frame, dissolves in motion
 *   step >= 40  reads cleanly
 * A robot that is genuinely readable keeps most of its contour above 25 and
 * very little below 12.
 */

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Hash of the bundle actually served, printed with every capture.
 *
 * INSTRUMENT FAULT 27. Round 14 asked for this in one line; it was added to
 * `shots/_salience.mjs` and never applied to the meters that produce clauses A,
 * B, C and G. The cost came due in round 20: an orbital contour arm did not
 * reproduce, one record's bloom-ON row equalled another's bloom-OFF row to the
 * decimal, and because neither run named the code it measured the disagreement
 * could not be resolved — a three-arena result had to be withdrawn instead.
 * Several agents build into this tree at once. A measurement that does not name
 * its bundle is not comparable to the one before it.
 */
async function bundleHash(base) {
  try {
    const html = await (await fetch(base)).text();
    const h = createHash('sha256').update(html);
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    for (const s of srcs) {
      const u = new URL(s, base).href;
      h.update(new Uint8Array(await (await fetch(u)).arrayBuffer()));
    }
    return h.digest('hex').slice(0, 12) + (srcs.length ? '' : ' (inline)');
  } catch (e) {
    return 'unavailable (' + String(e.message || e).slice(0, 40) + ')';
  }
}

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4241/');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const ARENA = flag('arena', 'grid');
// startMatch defaults its seed to Math.random(), so without pinning this every
// run measures a different fight and nothing can be compared to anything.
const SEED = Number(flag('seed', 1234567));
const KEEP = !!flag('keep');
/** --bloom X: composite bloomStrength for this capture only. See the block below. */
const BLOOM = flag('bloom', null) === null ? null : Number(flag('bloom', null));
/**
 * Live shell-uniform overrides — `--u bandX=4` or `--u uBandX=4`.
 *
 * WHY THIS EXISTS HERE, AND WHY IT IS A COPY OF tools/mass.mjs's BLOCK.
 *
 * Clause A and clause C are swept with `mass.mjs --u`; clause B is this meter;
 * and until now this meter had no `--u` at all. So the acceptance test the
 * rounds keep writing down — "clause C under X with clause A at or above Y AND
 * clause B not below Z" — could never be evaluated on a swept point. Every
 * sweep had to be baked into a build first, which is the rebuild-per-point cost
 * `--u` was added to mass.mjs to avoid, and which is why round 24's follow-up
 * timed out twice instead of finishing.
 *
 * It is a COPY and not a shared import on purpose. `shots/_massdrive.mjs` is a
 * PATCHER: it reads tools/mass.mjs, string-replaces anchors, and writes the
 * result into `shots/` before running it. A relative import in mass.mjs would
 * resolve against `shots/` in that copy and the meter would not start — the
 * same class of breakage as the vanished settle anchor RULING 10 found. So
 * mass.mjs must stay import-free, and the price of that is this duplicate.
 * KEEP THE TWO IN STEP: the applier's contract is resolve-both-spellings,
 * verify-by-read-back, abort-on-miss. See INSTRUMENT FAULT 29 in mass.mjs.
 */
const UNIFORMS = String(flag('u', '') || '').split(',').filter(Boolean).map((kv) => {
  const [k, v] = kv.split('=');
  const key = String(k).trim();
  const num = Number(v);
  if (!key || !Number.isFinite(num)) {
    console.error('contour: --u "' + kv + '" is not name=number.');
    process.exit(2);
  }
  return [key, num];
});
/**
 * `--mat <mesh>.<prop>=<value>[,...]` — live STAGE overrides, the counterpart of
 * `--u`, and here for the same reason `--u` is here.
 *
 * RULING 56 and RULING 59 both end at the stage: clause B's worst cell is
 * foundry's NEAR machine, its weak contour fails against a BRIGHT BACKGROUND
 * rather than a dark machine, and a far-gated machine lift cannot reach it by
 * construction. `shots/_r15dump.mjs` could already sweep a stage knob and this
 * meter — the one that scores the clause — could not, so every stage hypothesis
 * cost a rebuild and none was ever tested against clause B.
 *
 * It ABORTS on a miss rather than warning. `_r15dump.mjs` warned, a caller
 * redirected stdout, and INSTRUMENT FAULT 43 was a whole clause D reading whose
 * treatment and control were the same render.
 *
 *   --mat floor.envMapIntensity=0
 *   --mat floor.color=0x202024,deck.roughness=1
 */
const MATS = String(flag('mat', '') || '').split(',').filter(Boolean).map((kv) => {
  const [lhs, v] = kv.split('=');
  const dot = String(lhs).lastIndexOf('.');
  if (dot < 0 || !Number.isFinite(Number(v))) {
    console.error('contour: --mat "' + kv + '" is not mesh.prop=number.');
    process.exit(2);
  }
  return [lhs.slice(0, dot).trim(), lhs.slice(dot + 1).trim(), Number(v)];
});
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Enter or leave a silhouette pass: everything except the robots' shells is
 * hidden and every remaining surface is flat white, so the frame becomes an
 * exact binary stencil of the machines.
 *
 * The first version of this tool diffed a normal frame against one with the
 * robots hidden, which is wrong in a way worth recording: removing the robots
 * also removes what they contribute to the shadow maps and to bloom, so the
 * deck shifts a level or two across the WHOLE frame and the "robot" mask came
 * back as 74% of the image. A stencil cannot drift like that.
 *
 * `three` is bundled and unreachable from the page, so the override material is
 * built from a constructor borrowed off an existing MeshBasicMaterial — the
 * contact-shadow blob is a known one.
 */
const STENCIL_FN = `(on) => {
  const v = window.__game.view;
  if (on) {
    const MB = v.blobs[0].material.constructor;
    const white = new MB({ color: 0xffffff, fog: false, toneMapped: false });
    const black = new MB({ color: 0x000000, fog: false, toneMapped: false });

    // A cast shadow is not silhouette, and a shadow blob turned opaque would
    // occlude the feet it is supposed to sit under.
    v.__hidden = [];
    for (const b of v.blobs) if (b.visible) { v.__hidden.push(b); b.visible = false; }
    for (const m of v.models) {
      if (m.shadow && m.shadow.visible) { v.__hidden.push(m.shadow); m.shadow.visible = false; }
    }

    // INSTRUMENT FAULT 36, FIXED IN ALL EIGHT COPIES AT ONCE.
    //
    // The outline hull is a mesh under the model's group, so it lands in
    // \`shells\` and is painted white along with the machine — a mask dilated by
    // OUTLINE_WIDTH rather than the machine's own silhouette. That does not
    // happen today, and the reason is an accident: the override material below
    // is a fresh MeshBasicMaterial at its default FrontSide, and the hull is
    // BackSide, so its faces are culled. Give that material a \`side\` for any
    // reason and every mask-derived figure in this project changes at once,
    // with nothing in the output to say so.
    //
    // Measured before writing this: the grid stencil is 24415 px across a
    // nine-fold sweep of the hull's width, and clause B reads 84.8% with the
    // hull at full width and 80.8% with it collapsed to nothing. A hull inside
    // the mask would have dilated the first number and improved the second.
    //
    // So this asserts what culling was already doing, by NAME — \`m.outline\` is
    // the hull, set in robot.js where it is built — rather than by a property of
    // a material somebody else owns. Hidden rather than blackened, to reproduce
    // the culled behaviour exactly rather than a behaviour that merely agrees
    // with it on this arena.
    for (const m of v.models) {
      if (m.outline && m.outline.visible) { v.__hidden.push(m.outline); m.outline.visible = false; }
    }
    const shells = new Set();
    for (const m of v.models) m.group.traverse((o) => { if (o.isMesh) shells.add(o); });

    // Materials are swapped per-mesh rather than via scene.overrideMaterial,
    // because the stage has to stay in the depth buffer: a robot standing
    // BEHIND a pillar must not appear in the stencil. An earlier version used
    // an override and reported a fully occluded robot as 100% invisible
    // contour, which is a measurement artefact, not a defect in the art.
    v.__swap = [];
    v.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      // INSTRUMENT FAULT 19, FIXED HERE AND IN THE OTHER FOUR COPIES AT ONCE.
      // A mesh that does not write depth does not occlude the machines in the
      // real frame. Painting it opaque black made it occlude them in the mask:
      // the practicals batch is additive with depthWrite off at renderOrder 4,
      // so it drew after the machines and deleted them wherever it overlapped.
      // Measured before this change, machine stencil area with that batch
      // hidden vs left visible: grid 24460 -> 24460, orbital 24808 -> 24808,
      // foundry 4854 -> 8138 — two fifths of foundry's near machine missing
      // from every mask-derived figure taken of that arena. Zero on grid, which
      // is why five rounds of arguing on grid never hit it.
      // Hidden rather than blackened: whether such a mesh TINTS the machine is
      // a colour question, and this is a mask.
      const m0 = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!shells.has(o) && m0 && m0.depthWrite === false) {
        v.__hidden.push(o); o.visible = false; return;
      }
      v.__swap.push([o, o.material]);
      o.material = shells.has(o) ? white : black;
    });
    v.__bg = v.scene.background; v.__fog = v.scene.fog;
    v.scene.background = null; v.scene.fog = null;
  } else {
    for (const [o, mat] of v.__swap || []) o.material = mat;
    for (const o of v.__hidden || []) o.visible = true;
    v.scene.background = v.__bg; v.scene.fog = v.__fog;
    v.__swap = null; v.__hidden = null;
  }
}`;

/**
 * Drive the camera rig to its steady state by hand.
 *
 * Without this the tool is useless for A/B work: the rig smooths toward its
 * target using the real frame delta, and under software GL that delta is
 * whatever the last frame happened to cost, so two runs of the same seed frame
 * the fight from visibly different places. Robot heights swung between 28px and
 * 146px across runs, which swamps any change being measured. The sim itself is
 * deterministic, so once it is frozen the rig converges to one pose — this just
 * runs it there on a fixed 1/60 delta with nothing else moving.
 */
const SETTLE_FN = `(n) => {
  const g = window.__game;
  if (!g.rig || !g.world || !g.view) return false;
  let t = (g.engine.clock && g.engine.clock.elapsed) || 0;
  // INSTRUMENT FAULT 44 — A SETTLE CONVERGES DAMPERS AND CANNOT CONVERGE
  // INTEGRATORS, AND FOUR OF THIS MODEL'S POSE TERMS ARE INTEGRATORS.
  //
  // The loop below exists because damp(a, b, lambda, dt) forgets its starting
  // value: run it 240 times and every damped term lands on the same pose
  // whatever the frames before it did. Four terms in RoboModel.update are not
  // damped, they are integrated — spinAngle += spinRate * dt, tumble += rate *
  // dt, getupT += dt, and the toe bones' rotation.y += dt * (5 + heat * 26).
  // An integrator keeps its initial value forever and the settle merely adds a
  // constant four seconds on top of it, so the pose stayed a function of how
  // many load-dependent frames rendered before the pin.
  //
  // Measured, one bundle, one command, seventeen draws: the grid stencil came
  // back 24457 px fourteen times and 24209 three times, and the far contour cell
  // read 80.0 against 69.7 between the two poses — 10.3 points on the cell
  // clause B is failing by 4.0. It also produced both of the boxes that fault 38
  // blamed on two meters disagreeing; it was one meter disagreeing with itself.
  //
  // Zeroed so the settle starts from a known state and the pose becomes a
  // function of the iteration count alone. This is the meter reaching into the
  // model, which is justified precisely because these four values are the only
  // ones running the loop longer cannot fix. FIXED IN ALL THREE COPIES AT ONCE —
  // contour.mjs, mass.mjs and _r15dump.mjs are the meters behind clauses A, B, C
  // and D, and a pose fix in one of them is fault 38 all over again.
  for (const m of g.view.models) {
    m.spinAngle = 0; m.tumble = 0; m.getupT = 0;
    if (m.bToeR) m.bToeR.rotation.y = 0;
    if (m.bToeL) m.bToeL.rotation.y = 0;
  }
  for (let i = 0; i < n; i++) {
    const views = g.view.prepare(1);
    g.rig.update(g.world, views, g.localIndex, 1 / 60, t);
    // Drive the MACHINES on the same clock as the camera, inside the loop.
    //
    // This used to be a single g.view.update(0, 1, t) after the loop, and that
    // one argument was the root cause of every "the meter is noisy" round this
    // project has had. Every pose blend term in RoboModel.update is a damper,
    // and damp(a, b, lambda, dt) = lerp(a, b, 1 - exp(-lambda*dt)) is exactly
    // exactly a at dt = 0 — the dampers do not move. So the camera converged 240
    // iterations while the limbs were left wherever the pre-fastForward frames
    // had dragged them, and how far that was depended on how many frames the
    // box had managed to render, i.e. on load. The machine was drawn at tick
    // 420's POSITION in a load-dependent POSE: root pinned to 720,565..570
    // while the stencil box ranged 183 to 245px tall.
    g.view.update(1 / 60, 1, t);
    t += 1 / 60;
  }

  // Settling by hand is not enough on its own. \`paused\` gates only the fixed
  // step; the engine still calls onRender every frame with the REAL wall-clock
  // delta, and that damps the camera rig and the grade. Between this settle and
  // the shutter there are two 700ms waits and a multi-second software-GL
  // screenshot, so the rig kept sliding by an amount that depended on how loaded
  // the machine was. Two runs at the same seed and commit differed by 7 points
  // on the headline "invisible contour" figure — wider than any single round's
  // improvement, which means every #24 number measured before this line existed
  // carries that error bar.
  g.engine.onRender = null;
  // INSTRUMENT FAULT 44, SECOND HALF — FREEZE THE LOD, BECAUSE THE CAMERA WILL
  // NOT HOLD STILL AND THE LOD IS WHAT TURNS THAT INTO A DIFFERENT STENCIL.
  //
  // Zeroing the pose integrators above pinned grid at five draws of five and
  // left foundry returning two stencils, 8037 px and 8220. A probe that dumps
  // every model field found them identical across four runs both immediately
  // after this loop and again at the shutter — positions, dampers, integrators,
  // heat, and the LOD draw ranges element by element. One quantity was not
  // identical at the shutter: lodPx, at 331.72 / 331.717 / 331.718 / 332.209.
  //
  // lodPx is BODY_H * projection[1][1] / depth * 0.5 * targetHeight. The target
  // is 1600x900 in every run, the tier is 3 and dynamicScale is 1 in every run
  // (all four measured, not assumed), the projection is fixed and the model
  // positions do not move.
  //
  // FROM THAT I CONCLUDED THE CAMERA WAS DRIFTING, AND RULING 57 REFUTED IT BY
  // MEASURING THE CAMERA: its position is identical at settle and at shutter in
  // 8 of 8 draws. The moving term was never depth. It was that _applyLod reads
  // matrices only renderer.render() writes, so the resolve below was reading the
  // last PRE-SETTLE frame — see the corrected resolve, which is the actual fix. Running this settle a second time
  // at the shutter was tried as the repair and is refused: six draws, two
  // stencils still, and the near cell collapsed from about 72 to about 42.
  //
  // What that drift COSTS is the LOD: _applyLod recomputes a budget from lodPx
  // every frame and calls setDrawRange when it changes, so a camera creeping by
  // a tenth of a percent flips plates in and out and the stencil moves by 2.3%.
  // Freezing the draw ranges cuts the chain at the link that does the damage,
  // and it freezes them at whatever the settled camera chose — the pose being
  // measured — rather than at full detail, which would measure a machine the
  // game never draws.
  //
  // The camera writer is still unfound. This is a clamp, and it is labelled one.
  // Resolve the LOD ONCE against the settled camera before freezing it. Without
  // this the ranges frozen are whatever the last RENDERED frame chose, and that
  // frame happened before the settle finished, so the freeze preserved a
  // load-dependent choice instead of removing one. Measured: freezing alone took
  // foundry's minority pose from two draws in three to one in six; it did not
  // reach zero, and this is the term that was left.
  {
    // RULING 57 — THE CORRECTED RESOLVE. The previous line called _applyLod and
    // called it "against the settled camera", and it was not: _applyLod reads
    // camera.matrixWorldInverse and group.matrixWorld, NOTHING but
    // renderer.render() writes those, and this settle is synchronous — no frame
    // renders inside it — so at the end of the loop both matrices still held the
    // last PRE-SETTLE frame. The clamp was freezing the unconverged,
    // load-dependent camera the settle exists to discard.
    //
    // Measured by the audit: the frozen lodPx spread 6.4 and 11.3 px across four
    // draws while the LIVE value spread 0.001 and 0.000, and the camera's own
    // position was identical at settle and shutter in 8 of 8 draws — which also
    // REFUTES the camera-drift diagnosis this clamp was written on. The drift was
    // never the camera; it was this resolve reading stale matrices.
    //
    // Updating the world matrices and inverting the camera by hand before
    // resolving reproduces the shipped budget in 8 of 8. It is the only mode in
    // the audit's table that never froze a plate the game does not draw.
    const cam = g.engine.activeCamera || g.engine.camera;
    g.view.scene.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    for (const m of g.view.models) {
      m._lodBudget = -1; m._outBudget = -1;
      if (m._applyLod) m._applyLod(g.engine.renderer, cam);
    }
  }
  for (const m of g.view.models) if (m._applyLod) m._applyLod = () => {};
  if (g.engine.quality) g.engine.quality.auto = false;
  return true;
}`;

/** Suppress every effect so a beam across the outline cannot be mistaken for it. */
const VFX_OFF_FN = `() => {
  const v = window.__game.view;
  const keep = new Set([v.stage.group, ...v.models.map((m) => m.group), ...v.blobs]);
  for (const o of v.scene.children) {
    if (keep.has(o) || o.isLight || o.isCamera) continue;
    o.visible = false;
  }
  for (const k of ['motes', 'shafts', 'sweep']) if (v.stage[k]) v.stage[k].visible = false;
}`;

/**
 * Runs in a throwaway page: decodes both PNGs, builds the mask, splits it into
 * connected components (one per robot) and measures every boundary pixel.
 */
const ANALYSE_FN = async ({ nUri, hUri }) => {
  const load = async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  };

  const N = await load(nUri);
  const H = await load(hUri);
  const W = N.W, HT = N.H;
  const lumOf = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  // Ln is the real frame's luminance; H is the white-on-black stencil, so its
  // luminance IS the mask. The 0.5 cut is nowhere near either state, which
  // makes the mask insensitive to antialiasing on the stencil's own edge.
  const Ln = new Float32Array(W * HT);
  const mask = new Uint8Array(W * HT);
  for (let p = 0, i = 0; p < W * HT; p++, i += 4) {
    Ln[p] = lumOf(N.d, i);
    if (lumOf(H.d, i) > 128) mask[p] = 1;
  }

  // Connected components, so each robot is reported on its own. A robot that
  // reads well up close and one that is a smudge in the distance must not be
  // averaged into a single misleading figure.
  const comp = new Int32Array(W * HT).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * HT);
  for (let p = 0; p < W * HT; p++) {
    if (!mask[p] || comp[p] >= 0) continue;
    const id = comps.length;
    let sp = 0, n = 0;
    let x0 = W, x1 = 0, y0 = HT, y1 = 0;
    stack[sp++] = p; comp[p] = id;
    while (sp) {
      const q = stack[--sp];
      const qx = q % W, qy = (q / W) | 0;
      n++;
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
      if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      if (qx > 0 && mask[q - 1] && comp[q - 1] < 0) { comp[q - 1] = id; stack[sp++] = q - 1; }
      if (qx < W - 1 && mask[q + 1] && comp[q + 1] < 0) { comp[q + 1] = id; stack[sp++] = q + 1; }
      if (qy > 0 && mask[q - W] && comp[q - W] < 0) { comp[q - W] = id; stack[sp++] = q - W; }
      if (qy < HT - 1 && mask[q + W] && comp[q + W] < 0) { comp[q + W] = id; stack[sp++] = q + W; }
    }
    comps.push({ id, n, x0, x1, y0, y1 });
  }
  // Speckle from dithering and bloom fringing is not a robot.
  const bodies = comps.filter((c) => c.n >= 300 && (c.y1 - c.y0) >= 16)
    .sort((a, b) => b.n - a.n).slice(0, 2);

  const R = 3;                       // 7x7 window
  const measure = (only) => {
    const steps = [];
    /**
     * WHERE THE CONTOUR FAILS, WHICH THE SPLIT ALONE CANNOT SAY.
     *
     * `under25` says how much of the outline is weak. It does not say whether
     * those pixels are weak because the MACHINE is dark there or because the
     * BACKGROUND is bright there, and those two have opposite fixes: the first
     * is a machine-value problem an edge treatment can reach, the second is a
     * stage-value problem that no amount of rim or hull will touch. Four
     * rounds of outline-width work were spent without that distinction on the
     * table, and the round-38 sweep showed the hull is already at its optimum,
     * so the next attempt has to start from this column instead.
     *
     * Kept as a parallel array rather than a second walk: it is the same two
     * means the step is computed from, already in hand, and re-deriving them
     * would be a second instrument to keep in agreement with the first.
     */
    const det = [];
    for (let y = R; y < HT - R; y++) {
      for (let x = R; x < W - R; x++) {
        const p = y * W + x;
        if (!mask[p]) continue;
        if (only !== undefined && comp[p] !== only) continue;
        // Boundary only.
        if (mask[p - 1] && mask[p + 1] && mask[p - W] && mask[p + W]) continue;
        let inSum = 0, inN = 0, outSum = 0, outN = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const q = p + dy * W + dx;
            if (mask[q]) { inSum += Ln[q]; inN++; }
            else { outSum += Ln[q]; outN++; }
          }
        }
        if (inN < 5 || outN < 5) continue;
        const inM = inSum / inN, outM = outSum / outN;
        steps.push(Math.abs(inM - outM));
        det.push({ s: Math.abs(inM - outM), i: inM, o: outM });
      }
    }
    if (!steps.length) return null;
    steps.sort((a, b) => a - b);
    const q = (f) => Math.round(steps[Math.min(steps.length - 1, Math.floor(f * steps.length))] * 10) / 10;
    const frac = (t) => Math.round(steps.filter((s) => s < t).length / steps.length * 1000) / 10;
    // Medians, not means: one stretch of contour against a light fitting would
    // drag a mean and say nothing about the rest of the outline.
    const med1 = (a) => (a.length
      ? Math.round(a.slice().sort((x, y) => x - y)[a.length >> 1] * 10) / 10
      : null);
    const weak = det.filter((d) => d.s < 25);
    const good = det.filter((d) => d.s >= 40);
    return {
      n: steps.length,
      p10: q(0.10), median: q(0.50), p90: q(0.90),
      mean: Math.round(steps.reduce((a, b) => a + b, 0) / steps.length * 10) / 10,
      under12: frac(12), under25: frac(25), over40: Math.round((100 - frac(40)) * 10) / 10,
      weakIn: med1(weak.map((d) => d.i)), weakOut: med1(weak.map((d) => d.o)),
      goodIn: med1(good.map((d) => d.i)), goodOut: med1(good.map((d) => d.o)),
    };
  };

  /**
   * Body value against the value of the ground it is standing on, which is
   * what decides whether a rim light is even the right tool. A body sitting at
   * the same value as its background cannot be rescued by an edge treatment;
   * it has to move in value first.
   */
  const values = (only) => {
    const inside = [], around = [];
    const RING = 14;
    for (let y = RING; y < HT - RING; y++) {
      for (let x = RING; x < W - RING; x++) {
        const p = y * W + x;
        if (mask[p]) {
          if (only === undefined || comp[p] === only) inside.push(Ln[p]);
          continue;
        }
        // Background sampled in a ring just outside the mask, not the whole
        // frame: what matters is what the robot is actually in front of.
        let near = false;
        for (let dy = -RING; dy <= RING && !near; dy += 7) {
          for (let dx = -RING; dx <= RING; dx += 7) {
            const q2 = p + dy * W + dx;
            if (mask[q2] && (only === undefined || comp[q2] === only)) { near = true; break; }
          }
        }
        if (near) around.push(Ln[p]);
      }
    }
    const med = (a) => a.length ? Math.round(a.sort((x, y) => x - y)[a.length >> 1] * 10) / 10 : null;
    return { body: med(inside), background: med(around) };
  };

  return {
    screen: `${W}x${HT}`,
    maskPx: mask.reduce((a, b) => a + b, 0),
    overall: measure(),
    overallValues: values(),
    bodies: bodies.map((c) => ({
      px: c.n,
      box: `${c.x1 - c.x0 + 1}x${c.y1 - c.y0 + 1}`,
      heightPctOfFrame: Math.round((c.y1 - c.y0 + 1) / HT * 1000) / 10,
      at: `${c.x0},${c.y0}`,
      contour: measure(c.id),
      values: values(c.id),
    })),
  };
};

const bar = (pct, width = 28) => {
  const n = Math.max(0, Math.min(width, Math.round(pct / 100 * width)));
  return '#'.repeat(n) + '.'.repeat(width - n);
};

(async () => {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`  bundle: ${await bundleHash(BASE)}   base: ${BASE}`);
  await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
  await page.evaluate((t) => { const q = window.__game.engine.quality; q.auto = false; q.setTier(t); }, TIER);
  await page.waitForTimeout(400);

  // Freeze on the SAME line that starts the match. Any wall-clock that elapses
  // with the engine live is sim ticks the demo AI has already played, and how
  // many of those there are depends on how busy the machine was — which is the
  // whole of the nondeterminism. The sim is deterministic from tick 0, so the
  // only way to get the same frame twice is to never let it run free at all.
  await page.evaluate(({ id, seed }) => {
    const g = window.__game;
    g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
    g.setDemo(true);
    g.engine.paused = true;
    // Pin the clock to a fixed absolute value, the way vfxsheet.mjs does.
    // Pausing stops `elapsed` advancing, but it does not undo what accumulated
    // during boot, and how much that is depends on how loaded the machine was.
    // The limb animation is driven off this clock, so an unpinned value moves
    // the machine's pose between runs — which is how a "pinned" frame returned
    // a bounding box that changed shape, 37x66 one run and 37x67 the next.
    // A pose change is not rasteriser noise.
    if (g.engine.clock) g.engine.clock.elapsed = 1000;
  }, { id: ARENA, seed: SEED });
  await page.waitForTimeout(1200);
  await page.evaluate((n) => window.__game.fastForward(n), TICKS);
  const st = await page.evaluate(() => {
    const w = window.__game.world;
    const r = (v) => Math.round(v * 100) / 100;
    return { tick: w.tick, a: [r(w.robos[0].pos.x), r(w.robos[0].pos.z)], b: [r(w.robos[1].pos.x), r(w.robos[1].pos.z)] };
  });
  console.log(`  sim state: tick=${st.tick} p1=${st.a} p2=${st.b}`);
  const settled = await page.evaluate(`(${SETTLE_FN})(240)`);
  if (!settled) throw new Error('camera rig unavailable — cannot pin the frame');
  await page.evaluate(`(${VFX_OFF_FN})()`);
  if (UNIFORMS.length) {
    const uReport = await page.evaluate((list) => {
      const mats = [];
      for (const m of window.__game.view.models) {
        for (const mat of [m.matShell, m.matOutline, m.matFrame, m.matEmis, m.matFlare]) {
          if (mat && mat.userData && mat.userData.u && !mats.includes(mat)) mats.push(mat);
        }
        for (const mat of m.shellMats || []) {
          if (mat && mat.userData && mat.userData.u && !mats.includes(mat)) mats.push(mat);
        }
      }
      const numeric = new Set();
      const typed = new Set();
      for (const mat of mats) {
        for (const name of Object.keys(mat.userData.u)) {
          const slot = mat.userData.u[name];
          if (slot && typeof slot.value === 'number') numeric.add(name);
          else typed.add(name);
        }
      }
      const applied = [];
      const missed = [];
      for (const [k, v] of list) {
        const cand = [k, 'u' + k[0].toUpperCase() + k.slice(1)];
        const name = cand.find((c) => numeric.has(c));
        if (!name) {
          const t = cand.find((c) => typed.has(c));
          missed.push({ key: k, why: t ? t + ' is not a numeric uniform' : 'no such uniform' });
          continue;
        }
        let hit = 0;
        for (const mat of mats) {
          const slot = mat.userData.u[name];
          if (slot && typeof slot.value === 'number') { slot.value = v; hit++; }
        }
        let back = null;
        for (const mat of mats) {
          const slot = mat.userData.u[name];
          if (slot && typeof slot.value === 'number') { back = slot.value; break; }
        }
        applied.push({ key: k, name, want: v, got: back, mats: hit });
      }
      return { applied, missed, numeric: [...numeric].sort(), typed: [...typed].sort() };
    }, UNIFORMS);

    for (const a of uReport.applied) {
      console.log(
        '  uniform ' + a.key + ' -> ' + a.name + ' = ' + a.want +
        '  read back ' + a.got + ' on ' + a.mats + ' material(s)' +
        (a.got === a.want ? '' : '   *** READ-BACK MISMATCH ***')
      );
    }
    const bad = uReport.missed.concat(uReport.applied.filter((a) => a.got !== a.want));
    if (bad.length) {
      for (const m of uReport.missed) console.error('  --u ' + m.key + ': ' + m.why);
      console.error(
        'contour: --u did not reach ' + bad.length + ' of ' + UNIFORMS.length + ' key(s). ' +
        'A sweep knob that changes nothing must not return figures.\n' +
        '  settable (numeric) uniforms on this build:\n    ' +
        uReport.numeric.join(' ') +
        (uReport.typed.length ? '\n  present but NOT numeric, so --u can never set them:\n    ' +
          uReport.typed.join(' ') : '')
      );
      await browser.close();
      process.exit(3);
    }
  }
  if (MATS.length) {
    const report = await page.evaluate((list) => {
      const st = window.__game.view.stage;
      const hit = [], gone = [];
      for (const [name, prop, v] of list) {
        let found = false;
        st.group.traverse((o) => {
          if (!o.isMesh || o.name !== name) return;
          if (prop === 'visible') { found = true; hit.push(name + '.visible ' + o.visible + ' -> ' + !!v); o.visible = !!v; return; }
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!(prop in m)) continue;
            found = true;
            if (m[prop] && m[prop].isColor) {
              hit.push(name + '.' + prop + ' #' + m[prop].getHexString() + ' -> #' + (v >>> 0).toString(16).padStart(6, '0'));
              m[prop].setHex(v >>> 0);
            } else {
              hit.push(name + '.' + prop + ' ' + m[prop] + ' -> ' + v);
              m[prop] = v;
            }
            m.needsUpdate = true;
          }
        });
        if (!found) gone.push(name + '.' + prop);
      }
      return { hit, gone };
    }, MATS);
    console.log('  materials:', report.hit.join('; ') || '(none applied)');
    if (report.gone.length) {
      console.error('contour: --mat found no such mesh or property: ' + report.gone.join(', '));
      console.error('contour: REFUSING rather than scoring a clause on the unmodified stage.');
      process.exit(2);
    }
  }
  for (const id of ['ui-layer', 'hud-layer', 'splash']) {
    await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
  }
  await page.waitForTimeout(700);

  /**
   * `--bloom X` sets the composite's bloomStrength for this capture only.
   *
   * Clause B's three arena figures have only ever been measured with the post
   * chain's glow on. `0dbaa12` showed bloom is 30.4 of the 68.0 points of the
   * opponent's outline collapse DURING A DETONATION and said in terms that the
   * still frame had not been re-read without it. This is the knob that lets it
   * be, on the meter clause B is actually scored on.
   *
   * Diagnostic only: nothing is written to src and the uniform is restored by
   * the next settings change. It is safe to set here because the engine's frame
   * loop calls onRender whether or not the sim is paused, so the pinned frame is
   * re-composited during the wait, and because this capture turns the automatic
   * tier switcher off so nothing re-applies the tier underneath it.
   *
   * IT REFUSES rather than reporting a number from an unchanged composite.
   */
  if (BLOOM !== null) {
    const got = await page.evaluate((b) => {
      const u = window.__game.engine.postfx && window.__game.engine.postfx.uniforms;
      if (!u || !u.bloomStrength) return null;
      const was = u.bloomStrength.value;
      u.bloomStrength.value = Number(b);
      return was;
    }, BLOOM);
    if (got === null) throw new Error('--bloom: no bloomStrength uniform on this build — the diagnostic did nothing');
    await page.waitForTimeout(500);
    const held = await page.evaluate(() => window.__game.engine.postfx.uniforms.bloomStrength.value);
    if (Math.abs(held - Number(BLOOM)) > 1e-6) {
      throw new Error(`--bloom: set ${BLOOM} but the composite holds ${held} — something re-applied the tier`);
    }
    console.log(`  bloomStrength ${got} -> ${held}  (diagnostic, not written to src)`);
  }

  const N = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(true)`);
  await page.waitForTimeout(700);
  const H = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(false)`);

  if (KEEP) {
    mkdirSync('shots', { recursive: true });
    writeFileSync('shots/contour-n.png', N);
    writeFileSync('shots/contour-mask.png', H);
  }

  const probe = await context.newPage();
  await probe.goto('about:blank');
  const out = await probe.evaluate(ANALYSE_FN, {
    nUri: 'data:image/png;base64,' + N.toString('base64'),
    hUri: 'data:image/png;base64,' + H.toString('base64'),
  });

  console.log(`\nSILHOUETTE — ${ARENA} @ tier ${TIER}, ${out.screen}, robot pixels ${out.maskPx}`);
  const show = (label, c, extra = '') => {
    if (!c) { console.log(`  ${label}: no contour found`); return; }
    console.log(`  ${label}${extra}`);
    // THE SAMPLE COUNT IS PRINTED BECAUSE THE PERCENTAGES ARE NOT SELF-DESCRIBING.
    // A far machine can be 41x39 px, whose whole contour is a couple of hundred
    // boundary pixels, and "54.5%" off that is a different kind of claim from
    // the same figure off six thousand. It was computed and thrown away for
    // twenty rounds while three-arena comparisons were made on the percentages
    // alone. A percentage whose denominator is not on the page cannot be argued
    // about, only quoted.
    console.log(`     step  p10=${c.p10}  median=${c.median}  p90=${c.p90}  mean=${c.mean}  (n=${c.n})`);
    console.log(`     invisible (<12) ${String(c.under12).padStart(5)}%  ${bar(c.under12)}`);
    console.log(`     weak      (<25) ${String(c.under25).padStart(5)}%  ${bar(c.under25)}`);
    console.log(`     clean    (>=40) ${String(c.over40).padStart(5)}%  ${bar(c.over40)}`);
    // The diagnosis: what the two sides of the window actually read where the
    // contour fails, against what they read where it works. If `machine` is
    // much lower on the weak rows than on the clean ones, the outline is
    // failing because the machine goes dark there; if `behind` is much higher,
    // it is failing against a bright background and no edge treatment on the
    // machine can fix it.
    if (c.weakIn != null && c.goodIn != null) {
      console.log(`     where it fails   weak rows: machine ${String(c.weakIn).padStart(5)}  behind ${String(c.weakOut).padStart(5)}`);
      console.log(`                      clean rows: machine ${String(c.goodIn).padStart(5)}  behind ${String(c.goodOut).padStart(5)}`);
    }
  };
  const vals = (v) => v && v.body != null
    ? `     body ${v.body} vs background ${v.background}  (separation ${Math.round(Math.abs(v.body - v.background) * 10) / 10})`
    : null;
  show('OVERALL', out.overall);
  if (vals(out.overallValues)) console.log(vals(out.overallValues));
  out.bodies.forEach((b, i) => {
    show(`ROBOT ${i + 1}`, b.contour, `  ${b.box}px (${b.heightPctOfFrame}% of frame height) at ${b.at}`);
    if (vals(b.values)) console.log(vals(b.values));
  });
  if (errors.length) console.log('\npage errors:', errors.slice(0, 4));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
