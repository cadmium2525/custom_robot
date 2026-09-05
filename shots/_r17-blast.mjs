#!/usr/bin/env node
/**
 * THE DESKTOP REAL-MATCH EXPLOSION CAPTURE.
 *
 * Round 16's RULING 3 downgraded blind point 5 on `shots/r16L-match.png` — the
 * only real-match photograph of the effect that had ever been taken, shot on a
 * phone at TIER.LOW (260 particles, bloomQuality 0). The ruling was explicit
 * about what would settle it: the same effect, in a real match, at TIER.HIGH
 * (1400 particles, bloom on, renderScale 1.0). This is that capture.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `tools/vfxsheet.mjs`
 * ---------------------------------------------------------------------------
 * vfxsheet composes the effect itself: it calls `_detonate` on a staged point
 * between the machines. Four rounds of PASS were carried on its stills, and the
 * first frame in which the sim decided where the blast went, how big it was and
 * what was standing in front of it, failed. So the blast here is ignited by an
 * actual `EV.EXPLODE` out of `world.step()` — a bomb or a pod the AI chose to
 * throw — and nothing in this file touches `_detonate`, `spawn`, or any pool.
 *
 * ---------------------------------------------------------------------------
 * THE HARNESS PROBLEM, AND WHY THE PHONE CAPTURE'S DIAGNOSIS SOLVES IT
 * ---------------------------------------------------------------------------
 * `shots/_r15-phone.mjs` records the shape of it: under swiftshader this build
 * renders at ~5 fps, so a 3.4s sim-time window is 25s of wall clock and a
 * cross-process poll loop competing for the render thread turns that into
 * never. A fireball's whole life is 700ms — 42 ticks — and its peak is at
 * about 110ms, or SEVEN. Landing a shutter on tick 7 of 42 by waiting is not
 * merely hard, it is not a thing that can be done at all.
 *
 * So nothing here waits. The engine is paused on the same line as `startMatch`,
 * and the ENTIRE frame — sim step, camera rig, model poses, effect clock, post
 * grade, HUD — is driven by hand, one 1/60 tick at a time, inside the page:
 *
 *   R = engine.onRender                (the shipped render path, kept)
 *   engine.onRender = null             (so the rAF loop only rasterises)
 *   per tick:  fastForward(1)          -> sim, events, vfx spawns at vfx.time
 *              clock.elapsed += 1/60
 *              R(1/60, 1, elapsed)     -> rig, poses, vfx.update, grade, HUD
 *
 * `R` is the real `Game._render`, called with a fixed delta, so every damper in
 * it — the camera rig, the exposure/saturation/vignette grade, the hit flash,
 * the shock ripple — converges exactly the way it does in play and exactly the
 * same way on every run. Between the last tick and the shutter nothing at all
 * can move, which is the house rule (`onRender = null`, `quality.auto = false`)
 * arrived at from the other direction: the rule exists because the settle must
 * not drift, and a settle that never reads the wall clock cannot.
 *
 * The consequence is that "the peak frame" is not something to be raced for. It
 * is tick `EXPLODE + 7`, and it is that on every machine at every load.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WRITES, AND WHY THREE PASSES PER AGE
 * ---------------------------------------------------------------------------
 * For every age in `--ages` (in ticks after the EV.EXPLODE that was chosen):
 *
 *   <prefix>-a<NN>.png        the frame as shipped, HUD and all — the photograph
 *   <prefix>-a<NN>-raw.png    the same frozen frame with the UI layers hidden
 *   <prefix>-a<NN>-novfx.png  the same again with the effects layer hidden
 *   <prefix>-a<NN>-mach.png   the same again as a white-on-black stencil of the
 *                             two machines
 *
 * The effect's own contribution is then RAW - NOVFX exactly, with no colour
 * keying and no threshold guessing, which is what makes an edge-hardness number
 * meaningful: the boundary being measured is the boundary of the thing the
 * effect ADDED, not of some bright region that happens to include the deck.
 * The UI has to be off all three of those or the HUD's own hard edges get
 * measured as the blast's. The stencil is the same construction
 * `tools/contour.mjs` uses, and it answers "is the opponent inside this"
 * without anybody eyeballing a rectangle.
 *
 * Projectile bodies (bolts, bomb shells, pods) stay visible in BOTH passes and
 * therefore cancel: they are the sim's objects, not the blast.
 *
 *   node shots/_r17-blast.mjs --base http://127.0.0.1:4262/ --prefix shots/r17h
 *
 * Flags:
 *   --tier N        quality tier, default 2 (HIGH: 1400 particles, bloom 2)
 *   --ages a,b,c    ticks after EV.EXPLODE to capture, default 2,7,14,28,48
 *   --seed N        match seed, default 1234567 (the house pin)
 *   --arena id      default grid
 *   --scan N        how many ticks to run looking for a blast, default 2400
 *   --index N       take the Nth qualifying blast rather than the first
 *   --tick N        take the blast at this exact scan tick (see --list)
 *   --vw,--vh       viewport, default 1600x900
 *   --list          scan only: print every EV.EXPLODE and exit without shooting
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import process from 'node:process';

/**
 * Hash of the bundle actually served, printed with every capture.
 *
 * Several agents build into this tree at once, and a measurement that does not
 * name the code it measured is not comparable to the one before it. This reads
 * the served index and its entry chunk over HTTP, so it hashes what the browser
 * will run rather than what happens to be on disk.
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

/**
 * Write the scan listing, refusing to overwrite ANOTHER ARENA's record.
 *
 * `${PREFIX}-scan.txt` is keyed on the prefix and not on the arena, and the
 * prefix defaults to `shots/r17h` — the house grid pin. So
 * `--arena foundry --list` with no prefix silently replaced grid's committed
 * listing with foundry's, under grid's name, and the substitution was committed
 * before anyone read the second line of the file. I did that.
 *
 * It is the same shape as instrument faults 25 and 29: a tool allowed to answer
 * about one subject under another subject's name. The fix is the same one those
 * got — refuse, and say what it found instead of what it expected.
 */
async function writeScan(path, arena, body) {
  try {
    const prev = readFileSync(path, 'utf8');
    const m = prev.match(/\barena=(\w+)/);
    if (m && m[1] !== arena) {
      console.error(`refusing to overwrite ${path}: it holds arena=${m[1]}, this run is arena=${arena}`);
      console.error('pass --prefix so each arena keeps its own listing');
      process.exit(3);
    }
  } catch { /* no previous listing is fine */ }
  await writeFile(path, body);
}

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4262/');
const PREFIX = flag('prefix', 'shots/r17h');
const TIER = Number(flag('tier', 2));
const BLOOM = flag('bloom', null) === null ? null : Number(flag('bloom', null));
const FLAT = flag('flatheat', null) === null ? null : Number(flag('flatheat', null));
const SEED = Number(flag('seed', 1234567));
const ARENA = flag('arena', 'grid');
const SCAN = Number(flag('scan', 2400));
const INDEX = Number(flag('index', 0));
/** Pick the blast at this exact scan tick. Beats --index for reproducibility. */
const TICKSEL = flag('tick', null) == null ? null : Number(flag('tick'));
const VW = Number(flag('vw', 1600));
const VH = Number(flag('vh', 900));
const LIST = !!flag('list');
/** Walk the ages and log the geometry, writing no PNG. See the pre-flight below. */
const NOSNAP = !!flag('nosnap');
/**
 * --stenconly   ADMISSIBILITY SCREEN. Write ONLY the machine stencil.
 *
 * RULING 38 requires a pin to pass two screens before it joins the set: a
 * GEOMETRIC one, which the scan listing already answers for free, and an
 * ADMISSIBLE one — that `shots/_r25-cover.mjs` can actually resolve the opponent
 * at the ages being scored. The second was found the expensive way: foundry
 * 1198 screened in at `in = 1.00` and then failed the cover meter's own
 * subject-selection guard at six of seven ages, because that arena's near
 * machine stands among occluders that cut its stencil into one piece or three.
 *
 * Admissibility cannot be predicted from the scan — it depends on what the
 * stencil does, which needs a render. But it needs ONLY the stencil: four of the
 * five passes are the photograph and the three measurement frames, and none of
 * them is consulted to count machine boxes. Skipping them turns a screening run
 * from a full capture into roughly a fifth of one, which is what makes screening
 * a whole candidate list affordable instead of a thing nobody does.
 *
 * The pin set is then published WITH ITS REJECTIONS. A set filtered on
 * admissibility and quoted without them is "the pins where the stencil happened
 * to segment", which is RULING 34's sample-of-one with more steps.
 */
const STENCONLY = !!flag('stenconly');
const AGES = String(flag('ages', '2,7,14,28,48')).split(',').map(Number);
/**
 * --kill a,b,c   ATTRIBUTION. Suppress named stages of the detonation in BOTH
 * the raw and the novfx pass, so that C = raw - novfx is the contribution of
 * everything EXCEPT them. Run once per stage and the drop in far-machine
 * occlusion names which stage is standing in front of the opponent.
 *
 * Names, and what each one owns in `_detonate`:
 *   flares      the rayed flash card
 *   shockwaves  the deck front
 *   sparks      debris streaks
 *   energy      muzzle/impact energy (not part of a detonation)
 *   decals      scorch marks
 *   trails      projectile trails
 *   particles   the whole `vfx.smoke` ParticleBatch: dust wave + rising plume
 *               + tumbling chunks. They share one pool, so this kills all three.
 *   fireshell   fireball-kind shells in `vfx.fireballs` (flash core + cluster)
 *   firecore    the UNTHROWN fire shells only: the flash and the cluster core
 *   firelobes   the THROWN fire shells only: the seven billows
 *   flashcore   ROUND 29. The flash's own white-hot ball ALONE — stage 1's
 *               `fireballs.spawn(..., 0.075, R*0.30, R*0.52, ...)`, which is
 *               the one fire shell spawned with kind 0. `firecore` kills it
 *               together with the cluster core and so cannot say which of the
 *               two is standing on the opponent; at 117 ms they are 75 ms and
 *               17 ms old respectively and they are not the same object.
 *   latefire    ROUND 29, and `latelight`'s missing other half. Only the FIRE
 *               shells born after the pinned blast. `latelight` separates a
 *               second detonation's LIGHT from the pin's; nothing separated its
 *               FIRE, so a covering figure could not say which detonation was
 *               doing the covering. Both are needed to obey the standing rule
 *               of RULING 23 — a figure names the layer, not the emitter,
 *               unless a kill column isolates that emitter in the same bundle.
 *   latecore    ROUND 32. `latefire` AND `firecore` at once: only the UNTHROWN
 *               fire shells of a detonation born after the pin — the later
 *               blast's flash ball and cluster core, and neither of its lobes
 *               nor any of the pin's own fire. Round 29's attribution says the
 *               fire on the opponent at 117 ms is cores, not lobes (killing
 *               every lobe in the frame left the cell at 100.0), and that half
 *               of what is there belongs to the second detonation. This is the
 *               intersection of those two facts and therefore the exact
 *               CEILING of any composition rule that only declines to re-light
 *               a core where one is already burning.
 *   smokeshell  smoke-kind shells in `vfx.fireballs` (stage 5, the three volumes)
 *   light       every live blast point light, in both passes
 *   latelight   ROUND 21. Only the point lights born AFTER the pinned blast.
 *               The pin is one EV.EXPLODE; the frame is not. A second
 *               detonation inside the 800ms window puts a second light in the
 *               arena, the novfx pass hides that one too, and its wash lands in
 *               the pinned blast's occlusion column. This kills the later
 *               lights and leaves the pinned blast's own, so the column can be
 *               read as a statement about the effect it names.
 *
 * The last two share a pool and are separated by `aTint.w`, which `spawn`
 * writes as the kind. They are suppressed by parking the instance dead
 * (`aLife.y = 0`), which the vertex stage discards.
 *
 * It is a diagnostic, not a shipping mode, and it REFUSES rather than reporting
 * a zero: a kill that matched nothing is the confidently-wrong-number failure
 * this file's flat-heat block was already burned by once.
 */
const KILL = flag('kill', null);
const KILL_LIST = KILL === null ? [] : String(KILL).split(',').map((s) => s.trim()).filter(Boolean);
const KILL_NODES = ['flares', 'shockwaves', 'sparks', 'energy', 'decals', 'trails', 'particles', 'light', 'latelight'];
const KILL_KINDS = {
  fireshell: 0, smokeshell: 1, firecore: 2, firelobes: 3, flashcore: 4, latefire: 5, latecore: 6,
};
/** Stages that actually matched something, at any age. See the guard below. */
const KILL_SEEN = new Set();
for (const k of KILL_LIST) {
  if (!KILL_NODES.includes(k) && !(k in KILL_KINDS)) {
    console.error(`--kill: unknown stage "${k}". Known: ${[...KILL_NODES, ...Object.keys(KILL_KINDS)].join(', ')}`);
    process.exit(2);
  }
}
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Seed for the effects layer's own jitter, so lobe directions repeat too. */
const VFX_SEED = 0x0b1a5701;

// ---------------------------------------------------------------------------
// In-page driver. Installed once; every later call is a pure function of the
// tick count, so a run is reproducible to the pixel.
// ---------------------------------------------------------------------------

const INSTALL_FN = `(cfg) => {
  const g = window.__game;
  const TICK = 1 / 60;

  g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: cfg.arena, loadouts: g.loadouts, seed: cfg.seed });
  g.engine.paused = true;
  g.setDemo(true);

  // The effects layer keeps its own RNG for lobe directions and spark spreads.
  // Unpinned, two runs of the same seed produce the same blast in a different
  // shape, which is enough to move an edge measurement.
  g.view.vfx.seedJitter(cfg.vfxSeed);

  // A fixed absolute effect clock, for the same reason vfxsheet pins one: every
  // birth time and every uniform is then the same number on every run instead
  // of being offset by however long the browser took to boot.
  g.engine.clock.elapsed = 1000;

  // Kept on window because INSTALL is called TWICE — once to scan for a blast,
  // once to replay the same seed and stop exactly on it. A second call that
  // read g.engine.onRender would read the null the first call wrote, and the
  // replay would step the sim with nothing drawing it.
  if (!window.__blastR) window.__blastR = g.engine.onRender;
  const R = window.__blastR;
  g.engine.onRender = null;              // the rAF loop rasterises and nothing else
  g.engine.quality.auto = false;

  const blasts = [];
  g.view.onEvents((events) => {
    for (const ev of events) {
      if (ev.type !== 5) continue;       // EV.EXPLODE
      blasts.push({
        tick: window.__blast.tick,
        t: g.engine.clock.elapsed,
        x: ev.x, y: ev.y, z: ev.z, radius: ev.radius || 3, kind: ev.kind, part: ev.part,
      });
    }
  });

  window.__blast = {
    tick: 0,
    blasts,
    step(n) {
      for (let i = 0; i < n; i++) {
        // Sim first: events raised here are handed to vfx.handleEvents, which
        // stamps every spawn with vfx.time — i.e. with the clock as it stood at
        // the START of this tick. Advancing the clock first would put every
        // birth one tick in the future and the flash would be missing from the
        // frame it belongs to.
        g.fastForward(1);
        this.tick++;
        if (!g.world) break;
        g.engine.clock.elapsed += TICK;
        R(TICK, 1, g.engine.clock.elapsed);
      }
      return { tick: this.tick, blasts: this.blasts.length, phase: g.world ? g.world.phase : -1 };
    },
    /**
     * ROUND 34 — THE COMPOSITION RULE'S OWN STRENGTH, READ OFF THE LIVE PAGE.
     *
     * _recordDet keeps occ on every detonation for exactly this: the rule's
     * strength is a number the renderer computes and nothing consumes, so a
     * search for a pin where the rule FIRES does not have to predict it from a
     * listing. Absent on a build without the rule, where it returns null and
     * the column prints a dash rather than a zero -- a zero there would read as
     * "the rule declined" when the truth is "there is no rule".
     */
    dets() {
      const v = g.view && g.view.vfx;
      if (!v || !v._dets) return null;
      return v._dets.map((d) => ({ birth: d.birth, occ: d.occ, R: d.R }));
    },
    /** Where the blast centre and both machines land in CSS pixels. */
    project(p) {
      const THREE_V = g.camera.position.constructor;
      const out = {};
      const put = (k, x, y, z) => {
        const v = new THREE_V(x, y, z).project(g.camera);
        out[k] = { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (1 - (v.y * 0.5 + 0.5)) * window.innerHeight, z: v.z };
      };
      if (p) {
        put('blast', p.x, p.y, p.z);
        // How BIG the blast is on screen, which is the whole of what separates
        // this capture from the phone frame the review failed. A four-metre
        // detonation thirty metres away is a spark; the same detonation eight
        // metres away is the third of the frame RULING 3 was written about, and
        // picking one at random picks the first far more often than the second.
        const cam = g.camera.position;
        const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
        const f = window.innerHeight / (2 * Math.tan(g.camera.fov * Math.PI / 360));
        // The fireball cluster reaches about 1.5 R at its widest (core R*0.72
        // plus lobes thrown to about R*0.8), so this is the radius of the whole
        // mass, not of the core.
        out.blast.dist = d;
        out.blast.rpx = (p.radius || 3) * 1.5 / Math.max(d, 0.001) * f;
      }
      for (let i = 0; i < 2; i++) {
        const r = g.world.robos[i];
        put('robo' + i, r.pos.x, r.pos.y + 0.9, r.pos.z);
        // ROUND 34. Which machine is the OPPONENT, and how deep it stands
        // inside this blast, are the two things that decide whether a pin can
        // fail clause F sub-2 at all -- and both were being computed by hand
        // off a listing that did not print them. The opponent is the FAR
        // machine (_r25-cover.mjs takes the smaller stencil box), so its camera
        // distance is what names it; a metre-radius sphere at chest height is
        // the same proxy the composition rule itself uses for a machine.
        const cam2 = g.camera.position;
        const rd = Math.hypot(r.pos.x - cam2.x, r.pos.y + 0.9 - cam2.y, r.pos.z - cam2.z);
        const f2 = window.innerHeight / (2 * Math.tan(g.camera.fov * Math.PI / 360));
        out['robo' + i].dist = rd;
        out['robo' + i].rpx = 1.0 / Math.max(rd, 0.001) * f2;
        if (p) {
          out['robo' + i].sep = Math.hypot(out['robo' + i].x - out.blast.x, out['robo' + i].y - out.blast.y);
        }
      }
      return out;
    },
  };
  return { tier: g.engine.quality.settings.name, budget: g.engine.quality.settings.particleBudget };
}`;

/**
 * Hide every effect without touching the sim, the camera or the grade, so the
 * background pass is the SAME frame minus the blast. Pools are made invisible
 * rather than cleared: clearing writes to the instance buffers, and the frame
 * has to be restorable for the stencil pass that follows.
 */
/**
 * THE VFX LAYER RENDERED ALONE ON BLACK — instrument fault 28's route out.
 *
 * Every clause F sub-clause 2 figure this project has filed is
 * `|luma(raw) - luma(novfx)|`: a DIFFERENCE, and therefore a statement about
 * what the VFX layer CHANGED rather than about what it COVERS. The two come
 * apart whenever the thing underneath changes brightness. `8b071d2` made the
 * opponent darker under the effect — the aiming target had been at 220 of 255
 * before anything was drawn over it — and the difference column promptly read
 * 117 ms as 20.0 -> 87.0, i.e. the same effect over a darker machine measured as
 * four times the alteration. The clause got worse because the target got better.
 *
 * The critic's standing rule after four faults of this shape: **a mask is a
 * render, not a difference.** So this hides everything that is not the effects
 * layer, clears to black, and shoots. What comes back is the effect's own
 * footprint, exactly the way `tools/contour.mjs` gets its machine mask.
 *
 * Bloom is deliberately LEFT ON. Glow that lands on the opponent covers it as
 * far as a player is concerned, and P6 is a separate clause with its own ruling.
 * `--bloom 0` gives the geometry-only variant for anyone who wants the split.
 */
const VFX_ONLY_FN = `(on) => {
  const v = window.__game.view;
  const f = v.vfx;
  if (!v.__vfxNodes) {
    v.__vfxNodes = [
      f.sparks.points, f.smoke.points, f.energy.points,
      f.fireballs.mesh, f.shockwaves.mesh, f.flares.mesh, f.decals.mesh, f.trails.mesh,
    ].filter(Boolean);
  }
  const keep = new Set(v.__vfxNodes);
  const r = window.__game.engine.renderer;
  if (on) {
    v.__onlyHid = [];
    v.scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints)) return;
      if (keep.has(o) || !o.visible) return;
      v.__onlyHid.push(o);
      o.visible = false;
    });
    v.__onlyBg = v.scene.background;
    v.__onlyFog = v.scene.fog;
    // three is bundled and unreachable from the page, so a THREE.Color to read
    // the clear colour into is borrowed from a material that already owns one —
    // the same dodge STENCIL_FN uses to construct its flat materials.
    const C = v.blobs[0].material.color.clone();
    r.getClearColor(C);
    v.__onlyClear = C.getHex();
    v.__onlyAlpha = r.getClearAlpha();
    v.scene.background = null;
    v.scene.fog = null;
    r.setClearColor(0x000000, 1);
  } else {
    for (const o of v.__onlyHid || []) o.visible = true;
    v.scene.background = v.__onlyBg;
    v.scene.fog = v.__onlyFog;
    if (v.__onlyClear !== undefined) r.setClearColor(v.__onlyClear, v.__onlyAlpha);
    v.__onlyHid = null;
  }
}`;

const VFX_TOGGLE_FN = `(on) => {
  const v = window.__game.view;
  const f = v.vfx;
  if (!v.__vfxNodes) {
    v.__vfxNodes = [
      f.sparks.points, f.smoke.points, f.energy.points,
      f.fireballs.mesh, f.shockwaves.mesh, f.flares.mesh, f.decals.mesh, f.trails.mesh,
    ].filter(Boolean);
  }
  if (!on) {
    // Snapshot before hiding, so restoring cannot switch on a pool the frame
    // did not have on.
    v.__vfxWas = v.__vfxNodes.map((n) => n.visible);
    v.__lightWas = f.lights.map((l) => l.visible);
    for (const n of v.__vfxNodes) n.visible = false;
    // The blast throws real light onto the arena. That light is part of what
    // the effect DID to the frame, so the background pass has to be without it.
    for (const l of f.lights) l.visible = false;
  } else if (v.__vfxWas) {
    v.__vfxNodes.forEach((n, i) => { n.visible = v.__vfxWas[i]; });
    f.lights.forEach((l, i) => { l.visible = v.__lightWas[i]; });
  }
}`;

/**
 * LIGHT CENSUS, ROUND 21. Every live blast point light at the moment of the
 * shutter, with the illuminance it is actually delivering to each machine.
 *
 * The occlusion column could not say whether the effect was standing in front
 * of the opponent or shining on it until `--kill light` existed (fault 23), and
 * it still cannot say WHICH light is shining, or whether the light belongs to
 * the blast the capture is pinned to. Both are decided by numbers this returns:
 * `birth` against the pinned blast's own time, and `lux = intensity / d^2`
 * against the arena key of about 3.2, which is the unit `stage.js` and
 * `c2db8b1` both argued the blast light in.
 */
const LIGHTS_FN = `() => {
  const g = window.__game;
  const f = g.view.vfx;
  const out = [];
  const robos = (g.world && g.world.robos) || [];
  for (let i = 0; i < f.lights.length; i++) {
    const l = f.lights[i];
    if (!l.visible || !(l.intensity > 0)) continue;
    const at = [];
    for (let r = 0; r < robos.length; r++) {
      const p = robos[r].pos;
      const dx = l.position.x - p.x, dy = l.position.y - (p.y + 0.9), dz = l.position.z - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const w = l.distance > 0 ? Math.max(0, 1 - Math.pow(d / l.distance, 4)) : 1;
      at.push({ robo: r, d, lux: (l.intensity / Math.max(d * d, 1e-6)) * w * w });
    }
    out.push({
      i, birth: f.lightBirth[i], life: f.lightLife[i], peak: f.lightPeak[i],
      intensity: l.intensity, range: l.distance,
      x: l.position.x, y: l.position.y, z: l.position.z, at,
    });
  }
  return out;
}`;

/**
 * Stage suppression for `--kill`. Returns how many things it actually removed,
 * split by stage, so the caller can refuse when a name matched nothing.
 *
 * Node kills hide a whole pool's mesh. Shell kills park individual instances
 * dead by writing `aLife.y = 0`, which `SHELL_VERT` discards; the attribute is
 * flagged for upload directly because the pool's own `flush` is gated on a
 * dirty bit it owns.
 */
const KILL_FN = `(names, pinT) => {
  const f = window.__game.view.vfx;
  const out = {};
  const NODE = {
    flares: f.flares && f.flares.mesh,
    shockwaves: f.shockwaves && f.shockwaves.mesh,
    sparks: f.sparks && f.sparks.points,
    energy: f.energy && f.energy.points,
    decals: f.decals && f.decals.mesh,
    trails: f.trails && f.trails.mesh,
    particles: f.smoke && f.smoke.points,
  };
  for (const n of names) {
    if (n === 'light') {
      // The blast's real point lights. VFX_TOGGLE_FN already hides these for
      // the novfx pass, so C normally CONTAINS the arena being lit by the
      // blast. Killing them here removes them from both passes, which separates
      // "the effect is standing in front of the machine" from "the effect is
      // shining on it" -- two very different things to call occlusion.
      let hit = 0;
      for (const l of f.lights) { if (l.visible) hit++; l.visible = false; l.intensity = 0; }
      for (let i = 0; i < f.lightLife.length; i++) f.lightLife[i] = 0;
      out[n] = hit;
      continue;
    }
    if (n === 'latelight') {
      // Only the lights that are NOT the pinned blast's. A light born within a
      // tick of the pin is the pin's own and stays; anything later belongs to
      // another detonation and its wash is not this effect.
      let hit = 0;
      for (let i = 0; i < f.lights.length; i++) {
        const l = f.lights[i];
        if (f.lightBirth[i] <= pinT + 0.02) continue;
        if (l.visible) hit++;
        l.visible = false; l.intensity = 0; f.lightLife[i] = 0;
      }
      out[n] = hit;
      continue;
    }
    if (n in NODE) {
      const m = NODE[n];
      if (!m) { out[n] = 0; continue; }
      m.visible = false;
      out[n] = 1;
      continue;
    }
    // Shell kinds. aTint.w carries the kind written by ShellPool.spawn:
    // 0 and 1 are fire, 2 is smoke. Alive means life > 0.
    //
    // ROUND 20 -- 'fireshell' is too coarse to act on. It kills the flash core,
    // the cluster core AND the seven thrown lobes together, so it can say the
    // fire is standing on the opponent and cannot say WHICH fire. The two are
    // separable without touching the renderer: every unthrown shell in
    // _detonate spawns with mx = mz = 0 (the flash passes no motion at all, the
    // cluster core passes 0, R*0.16, 0), and every lobe passes ca*sp / sa*sp,
    // which is nonzero for all seven. So the discriminator is the LATERAL
    // launch velocity, read off the pool's own motion buffer:
    //
    //   firecore    fire shells with no lateral throw  (flash + cluster core)
    //   firelobes   fire shells with a lateral throw   (the seven billows)
    //   fireshell   both, unchanged
    const wantSmoke = n === 'smokeshell';
    const coreOnly = n === 'firecore';
    const lobesOnly = n === 'firelobes';
    // ROUND 29. Two finer knives on the same pool, both needed because the
    // 117 ms cell turned out to be a SECOND detonation's flash standing on the
    // machine and 'firecore' can say neither WHICH core nor WHOSE.
    //   flashcore  kind 0 exactly -- stage 1's white-hot ball, nothing else in
    //              _detonate spawns a fire shell with kind 0
    //   latefire   fire shells whose birth is later than the pin, the exact
    //              analogue of 'latelight' on the mass instead of the light
    const flashOnly = n === 'flashcore';
    const lateOnly = n === 'latefire';
    // ROUND 32. 'latecore' is 'latefire' AND 'firecore' at once: born after the
    // pin, and with no lateral throw. It is the exact footprint a composition
    // rule that declines to re-light an occupied core would remove.
    const lateCoreOnly = n === 'latecore';
    const p = f.fireballs;
    // Census first. A kill that matches nothing has to be able to say what WAS
    // in the pool, or the refusal is as uninformative as the zero it replaces.
    const census = { cap: p && p.capacity, alive: 0, kinds: {} };
    for (let i = 0; p && i < p.capacity; i++) {
      const i4 = i * 4;
      if (!(p.life[i4 + 1] > 0)) continue;
      census.alive++;
      const k = String(p.tint[i4 + 3]);
      census.kinds[k] = (census.kinds[k] || 0) + 1;
    }
    out.__census = census;
    let hit = 0;
    for (let i = 0; i < p.capacity; i++) {
      const i4 = i * 4;
      if (!(p.life[i4 + 1] > 0)) continue;
      const isSmoke = p.tint[i4 + 3] > 1.5;
      if (flashOnly) {
        if (isSmoke || p.tint[i4 + 3] > 0.5) continue;
      } else if (lateOnly) {
        if (isSmoke) continue;
        if (!(p.life[i4] > pinT + 0.02)) continue;
      } else if (lateCoreOnly) {
        if (isSmoke) continue;
        if (!(p.life[i4] > pinT + 0.02)) continue;
        if (Math.abs(p.motion[i4]) > 1e-4 || Math.abs(p.motion[i4 + 2]) > 1e-4) continue;
      } else if (coreOnly || lobesOnly) {
        if (isSmoke) continue;
        const thrown = Math.abs(p.motion[i4]) > 1e-4 || Math.abs(p.motion[i4 + 2]) > 1e-4;
        if (thrown !== lobesOnly) continue;
      } else if (isSmoke !== wantSmoke) continue;
      p.life[i4 + 1] = 0;
      hit++;
    }
    p.aLife.needsUpdate = true;
    p._dirty = true;
    out[n] = hit;
  }
  return out;
}`;

/**
 * The machine mask, built the same way `tools/contour.mjs` builds it.
 *
 * INSTRUMENT FAULT 22 -- this was the SIXTH copy of the stencil block and
 * `bf17a94` fixed five. It said "exactly contour.mjs's stencil" and had said so
 * since the five diverged from it, which made a false claim of provenance the
 * reason nobody re-read it. Every clause F occlusion figure in this document
 * was measured against a mask built by the unfixed rule. Fixed here to match.
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
      // INSTRUMENT FAULT 19's rule, which this copy did not have. A mesh that
      // does not write depth does not occlude the machines in the real frame,
      // so painting it opaque black made it occlude them in the mask. Hidden
      // rather than blackened: whether such a mesh TINTS the machine is a
      // colour question, and this is a mask.
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

// ---------------------------------------------------------------------------

const log = [];
const say = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };

const browser = await chromium.launch({
  executablePath: PINNED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio',
    '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(300000);
page.on('pageerror', (e) => say('  PAGEERROR ' + String(e?.stack || e).split('\n')[0]));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game?.engine?.running, null, { timeout: 120000 });
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 30000 }).catch(() => {});

// Pin the tier BEFORE the match starts: the pools are sized from
// settings.particleBudget in the VFX constructor, so a tier set afterwards
// leaves a HIGH-labelled build running LOW-sized pools.
await page.evaluate((t) => {
  const q = window.__game.engine.quality;
  q.auto = false;
  q.setTier(Number(t));
  q.dynamicScale = 1;
  q.cooldown = 1e9;
  window.__game.engine.resize(true);
}, TIER);

/**
 * `--bloom X` scales the composite's bloom contribution, and it exists to
 * answer one question the edge meter cannot: **how much of the effect's soft
 * boundary is the effect, and how much is the post chain smearing it?**
 *
 * The first hardening pass narrowed the fireball's density window from 0.28 to
 * 0.07 on a noise field whose 90% band is 0.27 wide, and flattened the
 * rim-driven alpha falloff that took coverage to 40% at the silhouette. Both
 * are large changes to the shell's own alpha. Neither moved the measured 10-90
 * edge by more than a pixel. That result only makes sense if the boundary being
 * measured is not the shell's.
 *
 * Set to 0 the effect is composited with no bloom at all, so the difference
 * between the two runs is the post chain's contribution to its own edge. This
 * is a diagnostic, not a shipping mode: `bloomStrength` is restored by the next
 * settings change, and nothing here is written back to the tier tables.
 */
if (BLOOM !== null) {
  await page.evaluate((b) => {
    const u = window.__game.engine.postfx?.uniforms;
    if (u && u.bloomStrength) u.bloomStrength.value = Number(b);
  }, BLOOM);
}

/**
 * `--flatheat X` replaces every shell's COLOUR with the flat linear value X and
 * leaves its ALPHA exactly as authored. It answers the one question three
 * rounds of edge work never asked, and the question the clause F ruling turns
 * on: is the boundary `shots/_r17-edge.mjs` measures the edge of the effect's
 * COVERAGE, or the edge of its TEMPERATURE?
 *
 * They are different objects in this shader. `SHELL_FRAG` drives colour from
 * `rim` through the heat ramp, and rim is 0 at every lobe's silhouette, so the
 * outer skin of the fireball is C_SOOT (0.028 linear, effectively black) while
 * its alpha is still ~0.88. The meter reads C = |luma(raw) - luma(novfx)|. A
 * fully covered pixel painted almost exactly the colour of an unlit background
 * contributes nothing to C, so the meter cannot tell it from a pixel the effect
 * never reached. Flat colour makes C a pure coverage signal.
 *
 *   both runs soft   -> the boundary really is coverage; the gradient is not
 *                       the cause and clause F's threshold stands as written
 *   flat run hard    -> the alpha edge is already hard, the meter has been
 *                       measuring the temperature ramp, and the clause and the
 *                       art direction were never actually in conflict
 *
 * Pair it with `--bloom 0` to take the post chain out at the same time. It sets
 * the dormant `uFlat` uniform documented at the premultiply in `src/gfx/vfx.js`
 * and is a diagnostic, not a shipping mode.
 */
const applyFlat = async () => {
  if (FLAT === null) return 0;
  return page.evaluate((v) => {
    // Addressed through the VFX object rather than by walking the scene. The
    // scene walk found nothing and returned a confident zero, which is the
    // print-a-number-anyway failure this document has ruled on three times: the
    // pools are owned by `view.vfx`, and a uniform that is not there is an
    // error rather than a zero.
    const vfx = window.__game.view && window.__game.view.vfx;
    if (!vfx) return 0;
    let n = 0;
    for (const k of Object.keys(vfx)) {
      const u = vfx[k] && vfx[k].mesh && vfx[k].mesh.material && vfx[k].mesh.material.uniforms;
      if (u && u.uFlatShell) { u.uFlatShell.value = Number(v); n++; }
    }
    return n;
  }, FLAT);
};
// The scene is `__game.view.scene`, NOT `__game.engine.scene` -- the first
// version of this reached for the wrong handle, found nothing, set nothing and
// printed `flatheat=1 on 0 shell materials`. It is re-applied immediately
// before every capture as well as here, because a count of zero is the only
// thing standing between this diagnostic and a confidently wrong ruling, and
// the pools are built when the first blast is spawned rather than at boot.
if (FLAT !== null) say(`flatheat=${FLAT} on ${await applyFlat()} shell materials at setup (0 here is fine, the view is built later)`);
await page.waitForTimeout(600);

const meta = await page.evaluate(`(${INSTALL_FN})(${JSON.stringify({ seed: SEED, arena: ARENA, vfxSeed: VFX_SEED })})`);
const BUNDLE = await bundleHash(BASE);
say(`bundle=${BUNDLE}`);
say(`tier=${meta.tier} particleBudget=${meta.budget} seed=${SEED} arena=${ARENA} vp=${VW}x${VH}`);

// --- scan for a blast worth photographing ----------------------------------
// "Worth photographing" is a stated rule, not a taste call: the blast has to be
// in front of the camera, and BOTH machines have to be in frame, because the
// question RULING 3 asks is whether the effect occludes the opponent and an
// opponent who is off-screen cannot answer it.
let chosen = null;
let found = 0;      // every blast seen, qualifying or not
let qual = 0;       // qualifying blasts only — what --index counts
let lastTick = null; // previous EV.EXPLODE, for the dt column
let step;
for (let done = 0; done < SCAN; done += 30) {
  step = await page.evaluate(() => window.__blast.step(30));
  if (step.phase < 0) { say('  match ended during scan'); break; }
  const news = await page.evaluate((n) => window.__blast.blasts.slice(n), found);
  for (const b of news) {
    const pr = await page.evaluate((p) => window.__blast.project(p), b);
    const ok = pr.blast.z < 1 && pr.robo0.z < 1 && pr.robo1.z < 1
      && pr.robo0.x > 0 && pr.robo0.x < VW && pr.robo0.y > 0 && pr.robo0.y < VH
      && pr.robo1.x > 0 && pr.robo1.x < VW && pr.robo1.y > 0 && pr.robo1.y < VH;
    // ROUND 34 — THE TWO COLUMNS A PIN IS CHOSEN ON.
    //
    //   far   which machine is the OPPONENT. `_r25-cover.mjs` scores the
    //         SMALLER stencil box, so the opponent is the machine further from
    //         the camera, and a listing that does not say which one that is
    //         cannot be used to predict the cell.
    //   in    how much of that machine's disc the blast's disc covers, on the
    //         metre-radius sphere the composition rule itself uses. 1.00 is a
    //         machine wholly inside the mass. The cell can only FAIL where this
    //         is large, which is what makes a pin have power.
    //   dt    ticks since the previous EV.EXPLODE. A second detonation within
    //         ~12 ticks (200 ms) is the other half of the requirement.
    const farKey = pr.robo1.dist > pr.robo0.dist ? 'robo1' : 'robo0';
    const far = pr[farKey];
    const inBlast = Math.max(0, Math.min(1,
      (pr.blast.rpx + far.rpx - far.sep) / (2 * far.rpx)));
    /**
     * ROUND 37 — THE THIRD COLUMN, and it is the one that separates the two
     * cases `in` cannot.
     *
     * `in` is built from PROJECTED discs, so it says the blast's disc covers the
     * opponent's disc on screen and nothing about depth. RULING 38 added
     * `d < fd` on top, which says the blast is IN FRONT. Neither says the
     * opponent is INSIDE the fire, and pin 956 passes both while sitting
     * 1.73-2.35 mass radii outside it: the cell reads 100.0 there because the
     * blast is between the opponent and the camera, and the bomb in fact went
     * off on the NEAR machine, 2.65 m away, inside its mass.
     *
     * `d3` is the 3-D distance from the blast centre to the opponent in MASS
     * RADII — 1.5 R, the width this file's own composition note gives the
     * fireball cluster at its widest (core R*0.72 plus lobes thrown to about
     * R*0.8). Under 1.0 the machine is in the fire; over it, the fire is merely
     * in the way. It costs one evaluate and no capture.
     */
    const wp = await page.evaluate(() => {
      const r = window.__game.world.robos;
      return [{ x: r[0].pos.x, y: r[0].pos.y, z: r[0].pos.z },
              { x: r[1].pos.x, y: r[1].pos.y, z: r[1].pos.z }];
    });
    const fw = wp[farKey === 'robo1' ? 1 : 0];
    const massR = Math.max(1e-3, (b.radius || 3) * 1.5);
    const d3 = Math.hypot(fw.x - b.x, fw.y - b.y, fw.z - b.z) / massR;
    const dt = lastTick === null ? null : b.tick - lastTick;
    lastTick = b.tick;
    // The rule's own strength at this detonation, matched to it by birth time.
    // On a build without the rule there is no ring at all and this prints '-'.
    const dets = await page.evaluate(() => window.__blast.dets());
    let rec = null;
    if (dets) {
      for (const d of dets) {
        if (d.birth < 0) continue;
        if (Math.abs(d.birth - b.t) > 0.05) continue;
        if (!rec || Math.abs(d.birth - b.t) < Math.abs(rec.birth - b.t)) rec = d;
      }
    }
    say(`  blast @tick ${b.tick} R=${b.radius.toFixed(2)} kind=${b.kind} ` +
        `screen=(${pr.blast.x.toFixed(0)},${pr.blast.y.toFixed(0)}) ` +
        `d=${pr.blast.dist.toFixed(1)}m rpx=${pr.blast.rpx.toFixed(0)} ` +
        `p1=(${pr.robo0.x.toFixed(0)},${pr.robo0.y.toFixed(0)}) p2=(${pr.robo1.x.toFixed(0)},${pr.robo1.y.toFixed(0)}) ` +
        `far=${farKey === 'robo1' ? 'p2' : 'p1'} fd=${far.dist.toFixed(1)}m fsep=${far.sep.toFixed(0)} ` +
        `frpx=${far.rpx.toFixed(0)} in=${inBlast.toFixed(2)} d3=${d3.toFixed(2)} dt=${dt === null ? '-' : dt} ` +
        `occ=${dets === null ? '-' : rec ? rec.occ.toFixed(2) : 'none'} ` +
        `${ok ? 'QUALIFIES' : 'skip'}`);
    if (ok && !chosen) {
      // --tick names the blast outright, which is the form a finding should be
      // written in: "the bomb at tick 1195 of seed 1234567" reproduces without
      // anybody having to count. --index is the fallback for a fresh seed.
      if (TICKSEL != null ? b.tick === TICKSEL : qual === INDEX) chosen = { ...b, pr };
    }
    if (ok) qual++;
    found++;
  }
  if (chosen && !LIST) break;
}
if (LIST) {
  say(`scanned ${step?.tick} ticks, ${found} blasts, ${qual} qualifying`);
  await writeScan(`${PREFIX}-scan.txt`, ARENA, log.join('\n') + '\n');
  await browser.close();
  process.exit(0);
}
if (!chosen) {
  say('NO QUALIFYING BLAST FOUND — widen --scan or change --seed');
  await writeScan(`${PREFIX}-scan.txt`, ARENA, log.join('\n') + '\n');
  await browser.close();
  process.exit(2);
}

// The scan steps in blocks of 30, so by the time a blast is seen the sim is up
// to 29 ticks past it and the early ages are gone. The fix is to replay: the
// whole run is a pure function of the seed, so starting the same match again
// and stepping exactly to `chosen.tick + age` reaches the identical frame. It
// costs one more pass over the same ticks and it is the only way to shoot the
// flash, which is over in three.
say(`chosen blast at tick ${chosen.tick} (scan reached ${step.tick}); replaying`);
await page.evaluate(`(${INSTALL_FN})(${JSON.stringify({ seed: SEED, arena: ARENA, vfxSeed: VFX_SEED })})`);
const shots = [];
for (const age of AGES) {
  const target = chosen.tick + age;
  const now = await page.evaluate(() => window.__blast.tick);
  if (target < now) { say(`  age ${age} (tick ${target}) already passed at ${now} — skipped`); continue; }
  await page.evaluate((n) => window.__blast.step(n), target - now);
  // The FIGHT card is taken down by a 900ms setTimeout in real time; with the
  // clock driven by hand it may still be up. Removing it is what play does.
  await page.evaluate(() => { try { window.__game.hud.hideBanner(); } catch (e) {} });
  if (FLAT !== null) {
    const n = await applyFlat();
    say(`  flatheat=${FLAT} on ${n} shell materials at age ${age}`);
    if (!n) throw new Error('--flatheat matched no shell material: the diagnostic did nothing');
  }
  if (KILL_LIST.length) {
    const hits = await page.evaluate(`(${KILL_FN})(${JSON.stringify(KILL_LIST)}, ${chosen.t})`);
    say(`  kill ${KILL_LIST.join(',')} at age ${age}: ${JSON.stringify(hits)}`);
    // A shell kill is PERMANENT — the instance is parked dead and never comes
    // back — so a later age legitimately matches zero. The refusal is therefore
    // against the run, not against the age: a stage that never matched anything
    // at ANY age is a diagnostic that did nothing, and that must throw.
    for (const k of KILL_LIST) if (hits[k]) KILL_SEEN.add(k);
  }
  const pad = String(age).padStart(2, '0');
  // ROUND 34 — THE PRE-FLIGHT. --nosnap walks the pin's ages and logs the
  // geometry without writing a single PNG. A capture costs half an hour and
  // `_r25-cover.mjs` refuses any age whose stencil is not exactly two machine
  // boxes, so the two things worth knowing before spending one are whether
  // both machines stay in frame across the whole age window and whether the
  // composition rule fires inside it. Both are readable here for the price of
  // a scan.
  if (NOSNAP) {
    const pr0 = await page.evaluate((p) => window.__blast.project(p), chosen);
    const dets0 = await page.evaluate(() => window.__blast.dets());
    const live = dets0 ? dets0.filter((d) => d.birth >= 0 && d.birth > chosen.t - 0.75)
      .map((d) => `${((d.birth - chosen.t) * 1000).toFixed(0)}ms occ=${d.occ.toFixed(2)}`) : ['-'];
    const inFrame = (q) => q.x > 0 && q.x < VW && q.y > 0 && q.y < VH && q.z < 1;
    say(`  age ${age}t (${Math.round(age * 1000 / 60)}ms)  ` +
        `p1=(${pr0.robo0.x.toFixed(0)},${pr0.robo0.y.toFixed(0)})${inFrame(pr0.robo0) ? '' : ' OFF'} ` +
        `p2=(${pr0.robo1.x.toFixed(0)},${pr0.robo1.y.toFixed(0)})${inFrame(pr0.robo1) ? '' : ' OFF'} ` +
        `far=${pr0.robo1.dist > pr0.robo0.dist ? 'p2' : 'p1'} ` +
        `sep12=${Math.hypot(pr0.robo0.x - pr0.robo1.x, pr0.robo0.y - pr0.robo1.y).toFixed(0)}px ` +
        `dets[${live.join('  ')}]`);
    shots.push({ age, tick: target, ms: Math.round(age * 1000 / 60), pr: pr0, lights: [] });
    continue;
  }
  const ui = (show) => page.evaluate((s) => {
    for (const id of ['ui-layer', 'hud-layer', 'splash']) {
      const el = document.getElementById(id);
      if (el) el.style.display = s ? '' : 'none';
    }
  }, show);

  // 1. the photograph, HUD and all.
  if (!STENCONLY) {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${PREFIX}-a${pad}.png` });
  }

  // 2-4. the measurement passes. The UI is off for all three or the HUD's own
  // hard edges are measured as the blast's.
  await ui(false);
  if (!STENCONLY) {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${PREFIX}-a${pad}-raw.png` });
  }

  await page.evaluate(`(${VFX_TOGGLE_FN})(false)`);
  if (!STENCONLY) {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${PREFIX}-a${pad}-novfx.png` });
  }

  // 5. the effects layer alone on black — the footprint as a render. See
  // VFX_ONLY_FN: the difference column above cannot tell coverage from a change
  // in what is underneath, and this one can.
  if (!STENCONLY) {
    await page.evaluate(`(${VFX_TOGGLE_FN})(true)`);
    await page.evaluate(`(${VFX_ONLY_FN})(true)`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${PREFIX}-a${pad}-vfxonly.png` });
    await page.evaluate(`(${VFX_ONLY_FN})(false)`);
    await page.evaluate(`(${VFX_TOGGLE_FN})(false)`);
    await page.waitForTimeout(150);
  }

  // The stencil is taken with the effects still hidden, and that is deliberate:
  // STENCIL_FN overrides every visible mesh's material, which would turn the
  // fireball shells into opaque black spheres standing in front of the machines
  // and report an occluded robot as a missing one. What is wanted here is where
  // the machines ARE, so that the next question — how much of that the blast is
  // painting over — has something to be asked against.
  await page.evaluate(`(${STENCIL_FN})(true)`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${PREFIX}-a${pad}-mach.png` });
  await page.evaluate(`(${STENCIL_FN})(false)`);
  await page.evaluate(`(${VFX_TOGGLE_FN})(true)`);
  await ui(true);

  const pr = await page.evaluate((p) => window.__blast.project(p), chosen);
  const lights = await page.evaluate(`(${LIGHTS_FN})()`);
  shots.push({ age, tick: target, ms: Math.round(age * 1000 / 60), pr, lights });
  for (const l of lights) {
    const own = l.birth <= chosen.t + 0.02 ? 'PINNED' : `late +${((l.birth - chosen.t) * 1000).toFixed(0)}ms`;
    say(`    light ${l.i} ${own}  intensity ${l.intensity.toFixed(1)} range ${l.range.toFixed(1)}m  ` +
        l.at.map((a) => `robo${a.robo} ${a.d.toFixed(1)}m ${a.lux.toFixed(2)}lux`).join('  '));
  }
  say(`  age ${age}t (${Math.round(age * 1000 / 60)}ms) -> ${PREFIX}-a${pad}.png  ` +
      `blast=(${pr.blast.x.toFixed(0)},${pr.blast.y.toFixed(0)}) ` +
      `p1=(${pr.robo0.x.toFixed(0)},${pr.robo0.y.toFixed(0)}) p2=(${pr.robo1.x.toFixed(0)},${pr.robo1.y.toFixed(0)})`);
}

if (KILL_LIST.length) {
  const never = KILL_LIST.filter((k) => !KILL_SEEN.has(k));
  if (never.length) {
    say(`--kill matched nothing at any age for: ${never.join(', ')}`);
    await writeFile(`${PREFIX}-log.txt`, log.join('\n') + '\n');
    await browser.close();
    throw new Error(`--kill matched nothing at any age for: ${never.join(', ')} — the diagnostic did nothing`);
  }
}

await writeFile(`${PREFIX}-meta.json`, JSON.stringify({
  base: BASE, bundle: BUNDLE, tier: meta.tier, particleBudget: meta.budget, seed: SEED, arena: ARENA,
  vfxSeed: VFX_SEED, viewport: { w: VW, h: VH }, blast: chosen, shots,
}, null, 2));
await writeFile(`${PREFIX}-log.txt`, log.join('\n') + '\n');
say(`wrote ${PREFIX}-meta.json`);
await browser.close();
