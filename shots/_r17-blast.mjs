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
 *   smokeshell  smoke-kind shells in `vfx.fireballs` (stage 5, the three volumes)
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
const KILL_NODES = ['flares', 'shockwaves', 'sparks', 'energy', 'decals', 'trails', 'particles', 'light'];
const KILL_KINDS = { fireshell: 0, smokeshell: 1 };
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
 * Stage suppression for `--kill`. Returns how many things it actually removed,
 * split by stage, so the caller can refuse when a name matched nothing.
 *
 * Node kills hide a whole pool's mesh. Shell kills park individual instances
 * dead by writing `aLife.y = 0`, which `SHELL_VERT` discards; the attribute is
 * flagged for upload directly because the pool's own `flush` is gated on a
 * dirty bit it owns.
 */
const KILL_FN = `(names) => {
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
    if (n in NODE) {
      const m = NODE[n];
      if (!m) { out[n] = 0; continue; }
      m.visible = false;
      out[n] = 1;
      continue;
    }
    // Shell kinds. aTint.w carries the kind written by ShellPool.spawn:
    // 0 and 1 are fire, 2 is smoke. Alive means life > 0.
    const wantSmoke = n === 'smokeshell';
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
      if (isSmoke !== wantSmoke) continue;
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
    say(`  blast @tick ${b.tick} R=${b.radius.toFixed(2)} kind=${b.kind} ` +
        `screen=(${pr.blast.x.toFixed(0)},${pr.blast.y.toFixed(0)}) ` +
        `d=${pr.blast.dist.toFixed(1)}m rpx=${pr.blast.rpx.toFixed(0)} ` +
        `p1=(${pr.robo0.x.toFixed(0)},${pr.robo0.y.toFixed(0)}) p2=(${pr.robo1.x.toFixed(0)},${pr.robo1.y.toFixed(0)}) ` +
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
  await writeFile(`${PREFIX}-scan.txt`, log.join('\n') + '\n');
  await browser.close();
  process.exit(0);
}
if (!chosen) {
  say('NO QUALIFYING BLAST FOUND — widen --scan or change --seed');
  await writeFile(`${PREFIX}-scan.txt`, log.join('\n') + '\n');
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
    const hits = await page.evaluate(`(${KILL_FN})(${JSON.stringify(KILL_LIST)})`);
    say(`  kill ${KILL_LIST.join(',')} at age ${age}: ${JSON.stringify(hits)}`);
    // A shell kill is PERMANENT — the instance is parked dead and never comes
    // back — so a later age legitimately matches zero. The refusal is therefore
    // against the run, not against the age: a stage that never matched anything
    // at ANY age is a diagnostic that did nothing, and that must throw.
    for (const k of KILL_LIST) if (hits[k]) KILL_SEEN.add(k);
  }
  const pad = String(age).padStart(2, '0');
  const ui = (show) => page.evaluate((s) => {
    for (const id of ['ui-layer', 'hud-layer', 'splash']) {
      const el = document.getElementById(id);
      if (el) el.style.display = s ? '' : 'none';
    }
  }, show);

  // 1. the photograph, HUD and all.
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${PREFIX}-a${pad}.png` });

  // 2-4. the measurement passes. The UI is off for all three or the HUD's own
  // hard edges are measured as the blast's.
  await ui(false);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${PREFIX}-a${pad}-raw.png` });

  await page.evaluate(`(${VFX_TOGGLE_FN})(false)`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${PREFIX}-a${pad}-novfx.png` });

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
  shots.push({ age, tick: target, ms: Math.round(age * 1000 / 60), pr });
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
