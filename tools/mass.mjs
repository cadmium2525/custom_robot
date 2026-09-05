#!/usr/bin/env node
/**
 * Mass meter — how many pieces does a machine break into at gameplay size?
 *
 *   node tools/mass.mjs --base http://127.0.0.1:4211/ --arena grid
 *
 * The blind-comparison rule this answers, quoted from the review: *blur at a
 * radius scaled to on-screen size, quantise to five value bands, count the
 * connected regions above 3% of the body*. A Custom Robo V2 machine returns
 * four or five. This build returned eleven, twice, and the round spent closing
 * that number closed the wrong file — because the number was a single figure
 * from a tool with two modes that disagreed by a factor of two.
 *
 * So this reports a CURVE, never one number, and it reports the inputs that
 * make a flattering number cheap to fake:
 *
 *   - The quantisation step is ABSOLUTE (levels of 0-255), swept from 24 to 85.
 *     A claim only counts if the sign of the change holds across the sweep.
 *   - `spread` (the body's own p2..p98 luminance range) and `median` are printed
 *     beside it. Darkening a machine until it fits in one band collapses the
 *     count and shows up here instantly, as does washing it out flat: neither
 *     is a fix, and both are visible in the same three lines.
 *   - Top-4 coverage: the share of the body the four largest masses occupy. A
 *     toy is four masses that cover it. Five masses covering 40% is not a pass
 *     just because the count says 5.
 *
 * Method, and where it is identical to contour.mjs on purpose. The frame is
 * pinned exactly as the silhouette meter pins it — same seed, same tick, same
 * hand-driven camera settle, same VFX suppression — and the robots' pixels come
 * from the same white-on-black stencil pass, so a mass count and a contour
 * reading taken at one commit describe the same photograph. The mask is ground
 * truth: no colour keying, no hand-picked boxes, and a machine standing behind
 * a pillar is measured on the part of it you can actually see.
 *
 * The blur is a masked Gaussian (three box passes), sigma = body height / 32,
 * so a 260px machine and a 79px machine are squinted at with the SAME relative
 * acuity — which is the only way the near and far robot can be compared at all.
 * Background pixels are excluded from the kernel's weight, so the deck behind a
 * thin arm never bleeds into the arm and invents a value step inside the body.
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

const BASE = flag('base', 'http://127.0.0.1:4211/');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const ARENA = flag('arena', 'grid');
const SEED = Number(flag('seed', 1234567));
const KEEP = !!flag('keep');
const DUMP = !!flag('dump');
const NOPAINT = !!flag('nopaint');
/**
 * Restrict the segmentation to the machine's own stencil. OPT-IN, default off.
 * See the long note in `blurBody` — without it the masses include background
 * inside the bounding box, and on grid's near machine that is +78% of pixels.
 */
const ONBODY = !!flag('onbody');
/**
 * Live shell-uniform overrides — `--u lightCeil=0.4,specCap=0.2` or, since
 * INSTRUMENT FAULT 29, the full uniform name: `--u uLightCeil=0.4`.
 *
 * Every number in the shell's light governor is a uniform, so tuning it does
 * not need a rebuild: this sets them on the running page between the settle and
 * the shutter. Findings still have to be baked into robot.js and re-measured
 * from a build, but the search for the number costs one browser launch instead
 * of one build plus one launch.
 *
 * -----------------------------------------------------------------------------
 * INSTRUMENT FAULT 29 — `--u` SILENTLY DROPPED EVERY KEY IT COULD NOT RESOLVE
 * -----------------------------------------------------------------------------
 *
 * The applier used to be four lines in the page:
 *
 *     const name = 'u' + k[0].toUpperCase() + k.slice(1);
 *     if (u[name]) u[name].value = v;
 *
 * Two faults, and they compound into the `ssao` fault exactly:
 *
 *   1. The name is built by PREFIXING, so a caller who passes the uniform's own
 *      name — `--u uBandX=4`, which is what the uniform is called in
 *      `materials.js`, in the shader, and in every probe that reads it back —
 *      gets `uUBandX`, which exists nowhere.
 *   2. `if (u[name])` then swallows the miss without a word. The run proceeds,
 *      the meter prints `uniforms: uBandX=4` from the ARGUMENT LIST rather than
 *      from anything it set, and the report is a full set of figures for a
 *      machine that was never touched.
 *
 * That is how round 24's follow-up got 1.706 at N=4 and 1.708 at N=1 against a
 * baseline of 1.705 with the uniform reading 0 the whole time: not a null
 * result about banding, a null result about `--u`. `ssao` is on file for the
 * same shape — a probe that changed nothing, read as evidence about the thing
 * it failed to change.
 *
 * The repair is the one this project keeps writing down: resolve BOTH spellings,
 * verify by READ-BACK rather than by assumption, and make a key that resolves to
 * nothing an ABORT with the list of names that would have worked. A sweep knob
 * is allowed to say no. It is not allowed to say nothing.
 */
const UNIFORMS = String(flag('u', '') || '').split(',').filter(Boolean).map((kv) => {
  const [k, v] = kv.split('=');
  const key = String(k).trim();
  const num = Number(v);
  if (!key || !Number.isFinite(num)) {
    console.error('mass: --u "' + kv + '" is not name=number.');
    process.exit(2);
  }
  return [key, num];
});
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Absolute quantisation steps, in 0-255 levels. 51 = "five value bands". */
const STEPS = [24, 30, 36, 42, 51, 60, 72, 85];

/* Identical to contour.mjs's stencil — see the commentary there. */
const STENCIL_FN = `(on) => {
  const v = window.__game.view;
  if (on) {
    const MB = v.blobs[0].material.constructor;
    const white = new MB({ color: 0xffffff, fog: false, toneMapped: false });
    const black = new MB({ color: 0x000000, fog: false, toneMapped: false });
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
 * The control the review ran by hand: every shell and frame material on both
 * machines forced to one flat grey, so the paint contributes nothing. What
 * survives is what the LIGHT and the PART COUNT are doing on their own.
 */
const NOPAINT_FN = `() => {
  const v = window.__game.view;
  for (const m of v.models) {
    for (const mat of [m.matShell, m.matFrame]) {
      if (!mat) continue;
      mat.vertexColors = false;
      mat.color.setRGB(0.55, 0.55, 0.55);
      mat.needsUpdate = true;
    }
  }
}`;

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

/**
 * Suppress every effect, INCLUDING the ones painted onto the shell itself.
 *
 * The scene-graph half is contour.mjs'. The second half is this tool's, and it
 * was bought with a wrong answer: pinned at tick 420 in orbital the player is
 * mid hit-flash, so its shell is mixed 90% toward (1.6, 0.9, 0.85) and every
 * value reading taken off it described a white-hot machine that exists for
 * 150 ms. That frame cannot be tuned against — it did not respond to the
 * shell's light governor at all, because almost none of what it photographed
 * was light. A hit flash across the body is not the body, the same way a
 * muzzle flash across the outline is not the outline.
 *
 * Returns whatever it had to switch off, so a suppressed transient is reported
 * rather than silently assumed.
 */
const VFX_OFF_FN = `() => {
  const v = window.__game.view;
  const keep = new Set([v.stage.group, ...v.models.map((m) => m.group), ...v.blobs]);
  for (const o of v.scene.children) {
    if (keep.has(o) || o.isLight || o.isCamera) continue;
    o.visible = false;
  }
  for (const k of ['motes', 'shafts', 'sweep']) if (v.stage[k]) v.stage[k].visible = false;
  const was = [];
  for (let i = 0; i < v.models.length; i++) {
    const u = v.models[i].matShell && v.models[i].matShell.userData.u;
    if (!u) continue;
    for (const k of ['uHitFlash', 'uCharge', 'uRimWash', 'uDissolve']) {
      if (u[k] && u[k].value > 0.001) {
        was.push('robot ' + (i + 1) + ' ' + k + '=' + Math.round(u[k].value * 100) / 100);
        u[k].value = 0;
      }
    }
  }
  return was;
}`;

const ANALYSE_FN = async ({ nUri, hUri, steps, dump, onbody }) => {
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

  const Ln = new Float32Array(W * HT);
  const mask = new Uint8Array(W * HT);
  for (let p = 0, i = 0; p < W * HT; p++, i += 4) {
    Ln[p] = lumOf(N.d, i);
    if (lumOf(H.d, i) > 128) mask[p] = 1;
  }

  // One component per machine, from the stencil.
  const comp = new Int32Array(W * HT).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * HT);
  for (let p = 0; p < W * HT; p++) {
    if (!mask[p] || comp[p] >= 0) continue;
    const id = comps.length;
    let sp = 0, n = 0, x0 = W, x1 = 0, y0 = HT, y1 = 0;
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
  const bodies = comps.filter((c) => c.n >= 300 && (c.y1 - c.y0) >= 16)
    .sort((a, b) => b.n - a.n).slice(0, 2);

  /**
   * Masked box blur, run three times to approximate a Gaussian. Only masked
   * pixels contribute and only masked pixels are normalised, so the machine is
   * blurred against itself and never against what is behind it.
   */
  const blurBody = (c, sigma) => {
    const x0 = Math.max(0, c.x0 - 2), x1 = Math.min(W - 1, c.x1 + 2);
    const y0 = Math.max(0, c.y0 - 2), y1 = Math.min(HT - 1, c.y1 + 2);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    let val = new Float32Array(bw * bh);
    let wgt = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const p = (y + y0) * W + (x + x0);
        const on = mask[p] && comp[p] === c.id;
        val[y * bw + x] = on ? Ln[p] : 0;
        wgt[y * bw + x] = on ? 1 : 0;
      }
    }
    // Box radius for three passes approximating a Gaussian of this sigma.
    // Three boxes of radius r sum to variance 3*((2r+1)^2-1)/12, so matching
    // it to sigma^2 gives r = (sqrt(4*sigma^2+1)-1)/2 — very nearly sigma-0.5.
    // Getting this wrong by the obvious factor (r = 1.2*sigma) blurs 30% harder
    // than the rule asks and quietly deletes masses.
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    const tmpV = new Float32Array(bw * bh), tmpW = new Float32Array(bw * bh);
    const pass = (src, srcW, dst, dstW, horiz) => {
      const outerN = horiz ? bh : bw, innerN = horiz ? bw : bh;
      for (let o = 0; o < outerN; o++) {
        for (let i = 0; i < innerN; i++) {
          let sv = 0, sw = 0;
          for (let k = -r; k <= r; k++) {
            const j = i + k;
            if (j < 0 || j >= innerN) continue;
            const idx = horiz ? o * bw + j : j * bw + o;
            sv += src[idx]; sw += srcW[idx];
          }
          const idx = horiz ? o * bw + i : i * bw + o;
          dst[idx] = sv; dstW[idx] = sw;
        }
      }
    };
    for (let it = 0; it < 3; it++) {
      pass(val, wgt, tmpV, tmpW, true);
      pass(tmpV, tmpW, val, wgt, false);
    }
    const out = new Float32Array(bw * bh);
    /*
     * `wgt > 1e-4` is a DIVIDE-BY-ZERO GUARD, and round 19 found it being used
     * as the definition of "this pixel is on the machine". It is not one. Three
     * un-normalised box passes of radius ~8 spread a single unit of weight over
     * a ~26px neighbourhood with the SUM preserved, so wgt is far above 1e-4
     * everywhere the kernel reaches — which is the whole bounding box, minus its
     * corners. On grid's near machine the stencil is 22270 px and the set this
     * guard admits is 39662 px: **+78% of pixels that are not on the machine.**
     * The gaps between the legs, between arm and torso, and above the shoulders
     * are inside the box, so they are inside the "masses", so the stage's own
     * value range is counted as variance INSIDE a mass and the stage's own mean
     * is mixed into the mass mean the between-mass step is taken from.
     *
     * --onbody restricts the segmentation to the machine's own stencil, which is
     * what the comment above blurBody has always said this does ("the machine is
     * blurred against itself and never against what is behind it"). It is OPT-IN
     * and defaults OFF so that no figure any other round filed changes under it
     * without someone asking for it; the two readings are meant to be quoted
     * side by side. Round 19's finding is the difference between them.
     */
    for (let i = 0; i < bw * bh; i++) out[i] = wgt[i] > 1e-4 ? val[i] / wgt[i] : -1;
    if (onbody) {
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const p = (y + y0) * W + (x + x0);
          if (!(mask[p] && comp[p] === c.id)) out[y * bw + x] = -1;
        }
      }
    }
    let seg = 0;
    for (let i = 0; i < bw * bh; i++) if (out[i] >= 0) seg++;
    return { out, x0, y0, bw, bh, seg };
  };

  /** Connected regions of one quantisation band inside the body, at one phase. */
  const regionsAtPhase = (c, B, step, phase) => {
    const { out, bw, bh } = B;
    const band = new Int16Array(bw * bh).fill(-999);
    let area = 0;
    for (let i = 0; i < bw * bh; i++) {
      if (out[i] < 0) continue;
      band[i] = Math.floor((out[i] + phase) / step);
      area++;
    }
    const seen = new Int32Array(bw * bh).fill(-1);
    const st = new Int32Array(bw * bh);
    const sizes = [];
    for (let p = 0; p < bw * bh; p++) {
      if (band[p] === -999 || seen[p] >= 0) continue;
      const id = sizes.length;
      const b = band[p];
      let sp = 0, n = 0;
      st[sp++] = p; seen[p] = id;
      while (sp) {
        const q = st[--sp];
        n++;
        const qx = q % bw, qy = (q / bw) | 0;
        const nb = [];
        if (qx > 0) nb.push(q - 1);
        if (qx < bw - 1) nb.push(q + 1);
        if (qy > 0) nb.push(q - bw);
        if (qy < bh - 1) nb.push(q + bw);
        for (const m of nb) if (band[m] === b && seen[m] < 0) { seen[m] = id; st[sp++] = m; }
      }
      sizes.push(n);
    }
    sizes.sort((a, b) => b - a);
    const big = sizes.filter((s) => s / area >= 0.03);
    const top4 = sizes.slice(0, 4).reduce((a, b) => a + b, 0) / area;
    return {
      masses: big.length,
      largest: sizes[0] / area * 100,
      top4: top4 * 100,
    };
  };

  /**
   * The same count, averaged over four quantisation PHASES.
   *
   * A single fixed origin makes the count a lottery: a machine whose torso sits
   * exactly on a band boundary splits down the middle into two masses, and the
   * same machine one level darker does not. Averaging the phase out removes an
   * artefact worth two masses on this model, and it also closes the cheapest
   * way to fake a win — nudging the paint until the body lands mid-band.
   */
  const regionsAt = (c, B, step) => {
    const phases = [0, 0.25, 0.5, 0.75].map((f) => f * step);
    const runs = phases.map((ph) => regionsAtPhase(c, B, step, ph));
    const avg = (k) => runs.reduce((a, r) => a + r[k], 0) / runs.length;
    return {
      masses: Math.round(avg('masses') * 10) / 10,
      massesMax: Math.max(...runs.map((r) => r.masses)),
      largest: Math.round(avg('largest') * 10) / 10,
      top4: Math.round(avg('top4') * 10) / 10,
    };
  };

  const stats = (c) => {
    const v = [];
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const p = y * W + x;
        if (mask[p] && comp[p] === c.id) v.push(Ln[p]);
      }
    }
    v.sort((a, b) => a - b);
    const q = (f) => v[Math.min(v.length - 1, Math.floor(f * v.length))];
    const p2 = q(0.02), p98 = q(0.98);
    return {
      spread: Math.round(p98 - p2),
      p2: Math.round(p2), p98: Math.round(p98),
      median: Math.round(q(0.5)),
    };
  };

  /**
   * A contact sheet for one machine: the crop as photographed, the masked blur
   * the count is taken on, and the bands themselves in flat false colour. The
   * count says how many pieces; only this says WHICH pieces, which is the
   * difference between fixing the defect and guessing at it.
   */
  const sheet = (c, B, step) => {
    const { out, x0, y0, bw, bh } = B;
    const Z = Math.max(1, Math.round(220 / bh));
    const cv = document.createElement('canvas');
    cv.width = bw * Z * 3 + 24; cv.height = bh * Z;
    const g = cv.getContext('2d');
    g.fillStyle = '#202024'; g.fillRect(0, 0, cv.width, cv.height);
    const px = (gx, gy, r, gr, b) => { g.fillStyle = `rgb(${r|0},${gr|0},${b|0})`; g.fillRect(gx, gy, Z, Z); };
    const BAND = [[24,26,32],[70,58,110],[196,64,92],[240,150,40],[250,240,180],[255,255,255],[120,220,255]];
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        const p = (y + y0) * W + (x + x0);
        const on = mask[p] && comp[p] === c.id;
        const o = (p) * 4;
        if (on) px(x * Z, y * Z, N.d[o], N.d[o + 1], N.d[o + 2]);
        const v = out[i];
        if (v >= 0) {
          px(bw * Z + 12 + x * Z, y * Z, v, v, v);
          const b = BAND[Math.min(BAND.length - 1, Math.floor(v / step))];
          px(bw * Z * 2 + 24 + x * Z, y * Z, b[0], b[1], b[2]);
        }
      }
    }
    return cv.toDataURL('image/png');
  };

  return {
    screen: `${W}x${HT}`,
    bodies: bodies.map((c) => {
      const h = c.y1 - c.y0 + 1;
      const sigma = Math.max(0.8, h / 32);
      const B = blurBody(c, sigma);
      return {
        px: c.n,
        seg: B.seg,
        box: `${c.x1 - c.x0 + 1}x${h}`,
        at: `${c.x0},${c.y0}`,
        sigma: Math.round(sigma * 100) / 100,
        ...stats(c),
        curve: steps.map((s) => ({ step: s, ...regionsAt(c, B, s) })),
        sheet: dump ? sheet(c, B, 51) : null,
      };
    }),
  };
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
  const settled = await page.evaluate(`(${SETTLE_FN})(240)`);
  if (!settled) throw new Error('camera rig unavailable — cannot pin the frame');
  const transient = await page.evaluate(`(${VFX_OFF_FN})()`);
  if (transient && transient.length) console.log('  suppressed transients:', transient.join(', '));
  if (NOPAINT) await page.evaluate(`(${NOPAINT_FN})()`);
  if (UNIFORMS.length) {
    const uReport = await page.evaluate((list) => {
      // Every material on the machine that carries live uniforms, not just
      // matShell. robot.js Object.assign's the outline and frame tables INTO
      // matShell.userData.u, which copies the uniform OBJECTS by reference, so
      // most names are reachable through the shell — but a material added later
      // would not be, and a knob that reaches only some of the machine is the
      // fault this block was rewritten for.
      const mats = [];
      for (const m of window.__game.view.models) {
        for (const mat of [m.matShell, m.matOutline, m.matFrame, m.matEmis, m.matFlare]) {
          if (mat && mat.userData && mat.userData.u && !mats.includes(mat)) mats.push(mat);
        }
        for (const mat of m.shellMats || []) {
          if (mat && mat.userData && mat.userData.u && !mats.includes(mat)) mats.push(mat);
        }
      }
      // The names a caller could have meant, and the ones no --u can ever set
      // because their value is not a number (THREE.Color and friends).
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
        // Both spellings: the uniform's own name, and the lowercase-initial
        // short form the usage line documents.
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
        // READ-BACK. The whole point of this rewrite: report what the uniform
        // says it is now, not what we asked it to be.
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
        'mass: --u did not reach ' + bad.length + ' of ' + UNIFORMS.length + ' key(s). ' +
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
  for (const id of ['ui-layer', 'hud-layer', 'splash']) {
    await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
  }
  await page.waitForTimeout(700);

  const N = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(true)`);
  await page.waitForTimeout(700);
  const Hs = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(false)`);

  if (KEEP) {
    mkdirSync('shots', { recursive: true });
    writeFileSync(`shots/mass-${ARENA}.png`, N);
  }

  const probe = await context.newPage();
  await probe.goto('about:blank');
  const out = await probe.evaluate(ANALYSE_FN, {
    nUri: 'data:image/png;base64,' + N.toString('base64'),
    hUri: 'data:image/png;base64,' + Hs.toString('base64'),
    steps: STEPS,
    dump: DUMP,
    onbody: ONBODY,
  });

  console.log(`\nMASSES — ${ARENA} @ tier ${TIER}, ${out.screen}${NOPAINT ? '  [NO PAINT]' : ''}${ONBODY ? '  [ON-BODY]' : ''}`);
  out.bodies.forEach((b, i) => {
    console.log(`  ROBOT ${i + 1}  ${b.box}px at ${b.at}   blur sigma ${b.sigma}`);
    // The two pixel sets every figure below is averaged over. When `seg` is
    // larger than `px`, the difference is background inside the bounding box
    // that the blur's weight guard admitted into the masses. See blurBody.
    console.log(`     stencil ${b.px}px   segmented ${b.seg}px` +
      (b.seg > b.px ? `   (+${Math.round((b.seg / b.px - 1) * 1000) / 10}% NOT ON THE MACHINE)` : '   (on-body)'));
    console.log(`     value  p2=${b.p2} median=${b.median} p98=${b.p98}   spread ${b.spread} levels`);
    const head = b.curve.map((c) => String(c.step).padStart(6)).join('');
    const mass = b.curve.map((c) => c.masses.toFixed(1).padStart(6)).join('');
    const top4 = b.curve.map((c) => String(Math.round(c.top4)).padStart(6)).join('');
    console.log(`     step  ${head}`);
    console.log(`     mass  ${mass}`);
    console.log(`     top4% ${top4}`);
    const five = b.curve.find((c) => c.step === 51);
    const mean = b.curve.reduce((a, c) => a + c.masses, 0) / b.curve.length;
    console.log(`     @51 (five bands): ${five.masses} masses, largest ${five.largest}%, top4 ${five.top4}%`);
    console.log(`     curve mean: ${Math.round(mean * 10) / 10} masses`);
  });
  if (DUMP) {
    mkdirSync('shots', { recursive: true });
    out.bodies.forEach((b, i) => {
      if (!b.sheet) return;
      const f = `shots/mass-${ARENA}-r${i + 1}.png`;
      writeFileSync(f, Buffer.from(b.sheet.split(',')[1], 'base64'));
      console.log(`  wrote ${f}  (crop | masked blur | bands @51)`);
    });
  }
  if (errors.length) console.log('\npage errors:', errors.slice(0, 4));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
