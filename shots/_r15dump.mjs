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

/* Identical to mass.mjs' stencil, which is identical to contour.mjs'. */
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
