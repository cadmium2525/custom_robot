#!/usr/bin/env node
/**
 * The pinned dump pair — `<dir>/<arena>-n.png` + `<dir>/<arena>-mask.png` —
 * taken with LIVE SHELL-UNIFORM OVERRIDES, so `shots/_sal.mjs` can be pointed
 * at a knob setting without a rebuild.
 *
 *   node shots/_r15dump.mjs --base http://127.0.0.1:4311/custom_robot/ \
 *        --arena grid --dir shots/_r15/flat06 --u flat=0.6,flatFar=0.85
 *
 * WHY THIS EXISTS. Round 15 has to move two halves of the same brief at once:
 * the mass count (blind point 4) and the machines' chroma (blind point 1). The
 * mass meter can sweep any governor knob live — `tools/mass.mjs --u` — and the
 * chroma meter cannot, because it reads a dump pair and only `tools/contour.mjs
 * --keep` writes one, and that tool has no `--u`. So every chroma reading of a
 * light-rig knob cost a full rebuild, and the two halves were being measured on
 * different builds. That is exactly how an earlier round won the value half and
 * lost the chroma half without noticing: measured chroma inside the player's
 * box fell 0.32 to 0.23 while luminance rose.
 *
 * The staging is mass.mjs' staging, verbatim and deliberately: same seed, same
 * tier, same tick, same clock pin, same settle (machines driven INSIDE the loop
 * at the camera's dt — see the note in that file, it is the fix that made these
 * meters repeatable), same VFX suppression, same stencil. A dump taken here and
 * a mass curve taken there describe the same photograph.
 *
 * It writes nothing but the pair, and it is a measurement script, not a tool:
 * it lives under shots/ because tools/ is not mine to add to.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4311/custom_robot/');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const ARENA = flag('arena', 'grid');
const SEED = Number(flag('seed', 1234567));
const DIR = flag('dir', 'shots/_r15dump');
const UNIFORMS = String(flag('u', '') || '').split(',').filter(Boolean).map((kv) => {
  const [k, v] = kv.split('=');
  return [k.trim(), Number(v)];
});
/**
 * `--mat <mesh>.<prop>=<value>[,...]` — the same live-override idea as `--u`,
 * pointed at the STAGE instead of the shells.
 *
 * `--u` exists because every chroma reading of a shell knob used to cost a
 * rebuild. Every reading of a STAGE knob still did, and round 18 needed a sweep
 * of the deck's specular return: orbital's clause E gap is 34739 stage pixels
 * above L*, they are one blown-out region of deck, and whether that region is
 * albedo, emissive, env reflection or key specular is four rebuilds to find out
 * by hand and one run to find out with this.
 *
 * Meshes are addressed by NAME — the same names `shots/_owner.mjs` attributes
 * by, sky included since round 18 — so a sweep here and an attribution there
 * name the same object. A property that is not on the material is reported, not
 * silently ignored, because a misspelled knob otherwise reads as "no effect".
 *
 *   --mat floor.envMapIntensity=0
 *   --mat floor.roughness=1,floor.emissiveIntensity=0
 */
const MATS = String(flag('mat', '') || '').split(',').filter(Boolean).map((kv) => {
  const [lhs, v] = kv.split('=');
  const dot = lhs.lastIndexOf('.');
  return [lhs.slice(0, dot).trim(), lhs.slice(dot + 1).trim(), Number(v)];
});
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* Identical to mass.mjs' stencil, which is identical to contour.mjs'.
 *
 * INSTRUMENT FAULT 19 — round 18, measured here and FIXED in `bf17a94`, in all
 * five copies at once (`tools/contour.mjs`, `tools/mass.mjs`,
 * `shots/_salience.mjs`, `shots/_owner.mjs` and this file), because changing one
 * copy alone would have made a round's numbers incomparable with every figure
 * filed against the other four. The account of the fault below is kept as the
 * reason the rule at the swap is what it is.
 *
 * The re-baseline that came with the fix: grid does not move at all — 4.5 /
 * 10.7 / 83.7 invisible / weak / clean before and after, separation 69.5 vs
 * 69.4, inside the 0.2-point round-trip noise floor — so every figure ever
 * filed against grid stays comparable. Foundry's near machine goes 61x200 ->
 * 78x217 px, invisible contour 20.0% -> 9.1%, clean 52.6% -> 71.4%.
 *
 * THE FAULT. The swap gives every non-shell mesh an opaque black
 * MeshBasicMaterial. A stage mesh that is normally ADDITIVE and depth-write-off
 * — the practicals batch, `renderOrder` 4 — becomes an opaque black plane that
 * draws AFTER the machines and erases them from the mask wherever it overlaps.
 * The machines are perfectly visible through it in the real frame; they are
 * simply gone from the stencil.
 *
 * MEASURED, same build, same tick, machine stencil area with the practicals
 * batch hidden during the capture versus left visible:
 *
 *     grid      24460 -> 24460 px    no erosion
 *     orbital   24808 -> 24808 px    no erosion
 *     foundry    4854 -> 8138 px     THE MASK IS 40% OF THE MACHINE
 *
 * Foundry's pinned frame has a large translucent red practical lying across the
 * near machine, so 3284 machine pixels — two fifths of the machine — are absent
 * from every mask-derived figure this project has taken of that arena: contour
 * percentage, mass count, top-4 coverage, chroma, clause E share, rendered
 * height for clause G. It is arena-specific and frame-specific, which is
 * exactly why nobody has hit it: on the arena everything is argued on, it is
 * zero.
 */
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
    // INSTRUMENT FAULT 35, FIXED IN ALL EIGHT COPIES AT ONCE.
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

/* mass.mjs' settle: the CAMERA and the MACHINES on the same clock. */
const SETTLE_FN = `(n) => {
  const g = window.__game;
  if (!g.rig || !g.world || !g.view) return false;
  let t = (g.engine.clock && g.engine.clock.elapsed) || 0;
  for (let i = 0; i < n; i++) {
    const views = g.view.prepare(1);
    g.rig.update(g.world, views, g.localIndex, 1 / 60, t);
    g.view.update(1 / 60, 1, t);
    t += 1 / 60;
  }
  g.engine.onRender = null;
  if (g.engine.quality) g.engine.quality.auto = false;
  return true;
}`;

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
  await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
  await page.evaluate((t) => { const q = window.__game.engine.quality; q.auto = false; q.setTier(t); }, TIER);
  await page.waitForTimeout(400);

  await page.evaluate(({ id, seed }) => {
    const g = window.__game;
    g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
    g.setDemo(true);
    g.engine.paused = true;
    if (g.engine.clock) g.engine.clock.elapsed = 1000;
  }, { id: ARENA, seed: SEED });
  await page.waitForTimeout(1200);
  await page.evaluate((n) => window.__game.fastForward(n), TICKS);
  const settled = await page.evaluate(`(${SETTLE_FN})(240)`);
  if (!settled) throw new Error('camera rig unavailable — cannot pin the frame');
  const transient = await page.evaluate(`(${VFX_OFF_FN})()`);
  if (transient && transient.length) console.log('  suppressed transients:', transient.join(', '));
  if (UNIFORMS.length) {
    const missed = await page.evaluate((list) => {
      const gone = [];
      for (const m of window.__game.view.models) {
        const u = m.matShell?.userData?.u;
        if (!u) continue;
        for (const [k, v] of list) {
          const name = 'u' + k[0].toUpperCase() + k.slice(1);
          if (u[name]) u[name].value = v;
          else if (!gone.includes(name)) gone.push(name);
        }
      }
      return gone;
    }, UNIFORMS);
    console.log('  uniforms:', UNIFORMS.map(([k, v]) => `${k}=${v}`).join(' '));
    // A knob that is not on the bag is silently ignored by mass.mjs, which is
    // how a sweep of a misspelled uniform reads as "no effect". Say so.
    if (missed.length) console.log('  NOT ON THE BAG (ignored):', missed.join(', '));
  }
  if (MATS.length) {
    const report = await page.evaluate((list) => {
      const s = window.__game.view.stage;
      const hit = [], gone = [];
      for (const [name, prop, v] of list) {
        let found = false;
        s.group.traverse((o) => {
          if (!o.isMesh || o.name !== name) return;
          // `visible` lives on the object, not the material. Supported here so
          // a removal diff and a knob sweep can be taken by the same command.
          if (prop === 'visible') { found = true; hit.push(`${name}.visible ${o.visible} -> ${!!v}`); o.visible = !!v; return; }
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!(prop in m)) continue;
            found = true;
            // A THREE.Color is not a number, and `m.color = 0x333333` silently
            // produces a material with no colour at all rather than an error.
            // Colour knobs take a hex and go through setHex, which makes the
            // albedo itself sweepable live — the one knob that decides whether
            // a blown surface is over-lit or over-painted.
            if (m[prop] && m[prop].isColor) {
              hit.push(`${name}.${prop} #${m[prop].getHexString()} -> #${(v >>> 0).toString(16).padStart(6, '0')}`);
              m[prop].setHex(v >>> 0);
            } else {
              hit.push(`${name}.${prop} ${m[prop]} -> ${v}`);
              m[prop] = v;
            }
            m.needsUpdate = true;
          }
        });
        if (!found) gone.push(`${name}.${prop}`);
      }
      return { hit, gone };
    }, MATS);
    console.log('  materials:', report.hit.join('; ') || '(none applied)');
    if (report.gone.length) console.log('  NO SUCH MESH OR PROPERTY (ignored):', report.gone.join(', '));
  }
  for (const id of ['ui-layer', 'hud-layer', 'splash']) {
    await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
  }
  await page.waitForTimeout(700);

  const N = await page.screenshot({ timeout: 180000 });
  await page.evaluate(`(${STENCIL_FN})(true)`);
  await page.waitForTimeout(700);
  const M = await page.screenshot({ timeout: 180000 });

  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/${ARENA}-n.png`, N);
  writeFileSync(`${DIR}/${ARENA}-mask.png`, M);
  console.log(`  ${ARENA} -> ${DIR}/${ARENA}-n.png + ${DIR}/${ARENA}-mask.png`);
  if (errors.length) console.log('  page errors:', errors.slice(0, 4));

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
