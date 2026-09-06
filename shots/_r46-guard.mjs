/**
 * ROUND 46 CRITIC — AUDIT OF FAULT 47's FIX.
 *
 * Fault 47 widened the stencil guard from
 *   `!shells.has(o) && m0.depthWrite === false`
 * to
 *   `m0.depthWrite === false`
 * so the machine's own additive flare stops being painted white into the
 * machine's silhouette. The fix is right only if the widened guard removes the
 * FLARE and nothing else that is load-bearing. Nobody has enumerated what it
 * actually catches, and "it removes only the flare" is a claim about a set.
 *
 * So this lists every mesh the guard hides, in the meter's own pinned frame,
 * with the material that owns it, whether it is inside the shell set (i.e.
 * parented under a model group and therefore exempted by the OLD gate), and
 * which model owns it. It also reports the machines' five named materials with
 * their depthWrite, so a material that is load-bearing and depth-write-off would
 * be visible here rather than assumed absent.
 *
 * THE POSE IS THE METER'S POSE, NOT A COPY OF IT. `SETTLE_FN` and `VFX_OFF_FN`
 * are read out of tools/contour.mjs and evaluated, because a probe that pins the
 * frame its own way measures a different machine and this document has filed
 * that fault twice (fault 38, fault 44). If the anchors ever vanish this aborts
 * instead of quietly settling differently — the vanished-anchor failure RULING 10
 * found in the patcher.
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); if (i < 0) return d; const v = args[i + 1]; return v && !v.startsWith('--') ? v : true; };
const BASE = flag('base', 'http://127.0.0.1:4407/custom_robot/');
const ARENA = flag('arena', 'grid');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const SEED = Number(flag('seed', 1234567));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SRC = readFileSync(new URL('../tools/contour.mjs', import.meta.url), 'utf8');
const grab = (name) => {
  const m = SRC.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;\\n'));
  if (!m) { console.error('probe: anchor ' + name + ' not found in tools/contour.mjs — REFUSING to settle a different way.'); process.exit(2); }
  return m[1];
};
const SETTLE_FN = grab('SETTLE_FN');
const VFX_OFF_FN = grab('VFX_OFF_FN');

async function bundleHash(base) {
  const html = await (await fetch(base)).text();
  const h = createHash('sha256').update(html);
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  for (const s of srcs) h.update(new Uint8Array(await (await fetch(new URL(s, base).href)).arrayBuffer()));
  return h.digest('hex').slice(0, 12);
}

(async () => {
  const browser = await chromium.launch({ executablePath: PINNED, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`  bundle: ${await bundleHash(BASE)}   base: ${BASE}   arena: ${ARENA}`);
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
  if (!settled) throw new Error('camera rig unavailable');
  await page.evaluate(`(${VFX_OFF_FN})()`);
  await page.waitForTimeout(400);

  const rep = await page.evaluate(() => {
    const v = window.__game.view;
    // THE PRE-STEPS ARE PART OF THE GUARD'S INPUT AND MUST BE REPRODUCED.
    // STENCIL_FN hides the blobs, then every model's `shadow`, then every
    // model's `outline`, and only THEN traverses — and the traverse skips
    // invisible meshes. A probe that enumerates without those three hides
    // reports meshes the guard never sees: the first draft of this file called
    // the contact shadow a new casualty of fault 47's fix, and it is not one —
    // it has been hidden BY NAME since fault 36, three lines above the guard.
    const preHidden = [];
    for (const b of v.blobs) if (b.visible) { preHidden.push('blob'); b.visible = false; }
    for (const m of v.models) {
      if (m.shadow && m.shadow.visible) { preHidden.push('model.shadow'); m.shadow.visible = false; }
    }
    const hullHidden = [];
    for (const m of v.models) if (m.outline && m.outline.visible) { hullHidden.push(m.outline.name || '(unnamed hull)'); m.outline.visible = false; }
    const shells = new Set();
    const owner = new Map();
    v.models.forEach((m, i) => m.group.traverse((o) => { if (o.isMesh) { shells.add(o); owner.set(o, i); } }));
    // WHICH MACHINE IS "FAR" IS A MEASUREMENT, NOT A LABEL. ROUND 45 explained
    // the grid-only re-base by heat ("only grid's pinned frame has a hot
    // machine"), so which model carries which heat, at what distance, decides
    // whether that explanation survives.
    const cam = window.__game.engine.activeCamera || window.__game.engine.camera;
    cam.updateMatrixWorld(true);
    const named = v.models.map((m, i) => {
      const p = new (m.group.position.constructor)();
      m.group.getWorldPosition(p);
      const out = {
        model: i,
        heat: Math.round((m.heat ?? 0) * 1000) / 1000,
        dist: Math.round(p.distanceTo(cam.getWorldPosition(new (m.group.position.constructor)())) * 100) / 100,
      };
      for (const n of ['matShell', 'matOutline', 'matFrame', 'matEmis', 'matFlare']) {
        const mat = m[n];
        out[n] = mat ? { depthWrite: mat.depthWrite, transparent: !!mat.transparent, opacity: Math.round((mat.opacity ?? 1) * 1000) / 1000, blending: mat.blending, renderOrder: null } : null;
      }
      return out;
    });
    const hidden = [];
    const kept = { shellMeshes: 0, stageMeshes: 0 };
    v.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const m0 = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m0 && m0.depthWrite === false) {
        const mi = owner.has(o) ? owner.get(o) : -1;
        let matName = '(unnamed material)';
        if (mi >= 0) {
          const mm = v.models[mi];
          for (const n of ['matShell', 'matOutline', 'matFrame', 'matEmis', 'matFlare']) if (mm[n] === m0) matName = n;
          if (matName === '(unnamed material)' && (mm.shellMats || []).includes(m0)) matName = 'shellMats[]';
        }
        hidden.push({
          mesh: o.name || '(unnamed)',
          inShellSet: shells.has(o),
          model: mi,
          material: matName,
          matType: m0.type,
          blending: m0.blending,
          opacity: Math.round((m0.opacity ?? 1) * 1000) / 1000,
          renderOrder: o.renderOrder,
          parent: (o.parent && o.parent.name) || '(unnamed parent)',
          tris: o.geometry && o.geometry.index ? (o.geometry.drawRange.count === Infinity ? o.geometry.index.count : o.geometry.drawRange.count) / 3 : null,
        });
        return;
      }
      if (shells.has(o)) kept.shellMeshes++; else kept.stageMeshes++;
    });
    return { hullHidden, preHidden, named, hidden, kept, models: v.models.length };
  });

  console.log(`  hidden by name BEFORE the guard: ${rep.preHidden.join(', ') || '(none)'}`);
  console.log(`  hull hidden by name: ${rep.hullHidden.join(', ') || '(none visible)'}`);
  console.log(`  meshes SURVIVING the guard: ${rep.kept.shellMeshes} machine (white) + ${rep.kept.stageMeshes} stage (black)`);
  console.log(`  meshes HIDDEN by the widened guard: ${rep.hidden.length}`);
  for (const h of rep.hidden) {
    console.log(`    ${h.inShellSet ? 'MACHINE' : 'stage  '}  model=${h.model}  mat=${h.material}  type=${h.matType}  blend=${h.blending}  opacity=${h.opacity}  order=${h.renderOrder}  tris=${h.tris}  mesh=${h.mesh}  parent=${h.parent}`);
  }
  console.log('  named machine materials (depthWrite / transparent / opacity / blending):');
  for (const n of rep.named) {
    const row = ['matShell', 'matOutline', 'matFrame', 'matEmis', 'matFlare']
      .map((k) => `${k}=${n[k] ? `${n[k].depthWrite}/${n[k].transparent}/${n[k].opacity}/${n[k].blending}` : 'absent'}`).join('  ');
    console.log(`    model ${n.model} heat=${n.heat} dist=${n.dist}  ${row}`);
  }
  await browser.close();
})();
