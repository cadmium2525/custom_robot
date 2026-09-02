#!/usr/bin/env node
/**
 * Is the silhouette LOD firing, and by how much?
 *
 *   node shots/_lodprobe.mjs --arena foundry [--tier 3] [--minpx2 6]
 *
 * The mass meter can only tell you the LOD's EFFECT. This tells you whether it
 * ran at all — which is the question that has to be answered before a
 * 0.3-mass delta is interpreted as anything.
 *
 * Pins the frame exactly the way tools/mass.mjs does (same seed, ticks, camera
 * settle, clock pin), then reads each machine's own LOD state straight off the
 * model after a render has happened: the on-screen height in pixels the model
 * measured for itself, the square-pixels-per-square-metre budget that came out
 * of it, and per bucket how many indices survive the cut out of how many exist.
 * `prims` is the count of whole primitives kept, which is the number the review
 * is actually asking about ("thirty chamfered boxes").
 *
 * --minpx2 sweeps the threshold live, so the cost of trying a value is one
 * browser launch rather than one rebuild.
 *
 * --sweep 2,8,16,32 walks a whole list of thresholds inside ONE launch, which
 * is what makes the threshold tunable at all: a launch is forty seconds and the
 * useful range is a decade wide. The geometry table does not change with the
 * arena — only the budget does, and budget = (px/BODY_H)^2 / minPx2 — so a
 * sweep of minPx2 at one machine size samples exactly the same curve as the
 * same machine seen at every other size. One arena is the whole answer.
 *
 * --cost adds the other half of the review's question about this item ("the
 * only item free at runtime, so measure frame cost too"): triangles submitted
 * per frame, and the REAL frame rate.
 *
 * The frame rate has to be counted here and cannot be read off the engine.
 * `engine.stats.frameMs` is derived from `dt` AFTER `engine.js:153` clamps it
 * (`if (dt > 0.25) dt = TICK_DT`), so under SwiftShader — where a 1600x900
 * frame costs well over 250 ms — it reports a flat 16.7 ms and 60 fps whatever
 * the scene actually costs. `engine.clock.frame` is incremented once per
 * rendered frame and is not clamped, so counting it against wall time is the
 * only honest reading available in this harness. This is the eighth instrument
 * finding applied rather than rediscovered.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const BASE = flag('base', 'http://127.0.0.1:4211/');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const ARENA = flag('arena', 'grid');
const SEED = Number(flag('seed', 1234567));
const MINPX2 = flag('minpx2', null);
const SWEEP = String(flag('sweep', '') || '').split(',').filter(Boolean).map(Number);
const COST = !!flag('cost');
/** Wall-clock seconds each frame-rate sample runs for. */
const COST_S = Number(flag('costs', 8));
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/*
 * Byte-identical to tools/mass.mjs's settle — same pinned frame.
 *
 * AND IT WAS NOT, until round 17. This file carried the pre-`52625c7` settle:
 * the 240-iteration loop drove only the camera and the machines were driven
 * once, afterwards, by `g.view.update(0, 1, t)`. `damp(a, b, l, dt)` is exactly
 * `a` at dt = 0, so every pose damper stood still and the machine was posed by
 * whatever the boot transient left behind — the exact fault house rule 5 was
 * written from, sitting inside the instrument that certifies the LOD. It
 * matters here and not only in the mass meter: `_applyLod` measures the model's
 * on-screen size off `group.matrixWorld`, which `view.update` writes, so an
 * unsettled machine is one whose REPORTED PIXEL HEIGHT — the input to every
 * budget in this file — comes from a frame nobody pinned.
 */
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

const READ_FN = `() => {
  const v = window.__game.view;
  return v.models.map((m, i) => {
    const buckets = (m.lod || []).map((e) => {
      const idx = e.geo.index ? e.geo.index.count : e.geo.attributes.position.count;
      const drawn = e.geo.drawRange.count === Infinity ? idx : Math.min(e.geo.drawRange.count, idx);
      const upto = Array.from(e.table.upto);
      let prims = 0;
      for (const u of upto) if (u <= drawn) prims++;
      return { drawn, total: e.table.total, prims, allPrims: upto.length };
    });
    return {
      i, px: m.lodPx, budget: m._lodBudget, minPx2: m.lodMinPx2,
      preview: !!m.preview, buckets,
    };
  });
}`;

/**
 * Set the live threshold and then WAIT FOR A FRAME, not for a clock.
 *
 * `_applyLod` runs from onBeforeRender, so a threshold written between frames
 * has not been applied to any draw range yet. Under SwiftShader a frame here
 * costs 0.7 s and the probe's old fixed 400 ms wait was shorter than one — so
 * a swept value could be read back before it had taken effect, and the reading
 * would silently describe the previous value. Two rendered frames is the
 * cheapest condition that cannot do that.
 */
const APPLY_FN = `(v) => new Promise((res) => {
  const g = window.__game;
  for (const m of g.view.models) { m.lodMinPx2 = v; m._lodBudget = -1; }
  const f0 = g.engine.clock.frame;
  const tick = () => (g.engine.clock.frame - f0 >= 2 ? res(true) : requestAnimationFrame(tick));
  tick();
})`;

/**
 * Frames actually rendered per second, and the triangles in each of them.
 *
 * Counted off engine.clock.frame against wall time for the reason given at the
 * top of the file: engine.stats.frameMs is downstream of the backgrounded-tab
 * clamp and reads a flat 60 fps in this harness however heavy the scene is.
 * engine.stats.tris is fine — it is renderer.info, which counts what was
 * submitted and is not a timing.
 */
const COST_FN = `(ms) => new Promise((res) => {
  const g = window.__game;
  const f0 = g.engine.clock.frame;
  const t0 = performance.now();
  let tris = 0, calls = 0, n = 0;
  const tick = () => {
    tris += g.engine.stats.tris; calls += g.engine.stats.drawCalls; n++;
    if (performance.now() - t0 >= ms) {
      const secs = (performance.now() - t0) / 1000;
      res({ frames: g.engine.clock.frame - f0, secs, tris: tris / n, calls: calls / n });
    } else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

(async () => {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
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
  await page.evaluate(`(${SETTLE_FN})(240)`);

  // Every threshold to report, in one launch. `null` means "whatever the build
  // shipped with", and it is always first so the sweep is read against it.
  const values = SWEEP.length ? SWEEP : [MINPX2 === null ? null : Number(MINPX2)];

  console.log(`\nLOD — ${ARENA} @ tier ${TIER}`);
  for (const v of values) {
    if (v !== null) await page.evaluate(`(${APPLY_FN})(${v})`);
    else await page.waitForTimeout(400);
    // INSTRUMENT FAULT (the seventh on this project, found round 12). This read
    // was `page.evaluate(READ_FN)`. Playwright evaluates a STRING argument as an
    // expression and does not call it, so the page returned the function object,
    // which serialises to `undefined`, and the probe died on "out is not
    // iterable" — every time, for anyone who ran it. The round-11 note that "the
    // LOD barely fires" therefore has no reading behind it from this tool. Every
    // other evaluate in this file already wraps-and-calls; this one did not.
    const out = await page.evaluate(`(${READ_FN})()`);
    const cost = COST ? await page.evaluate(`(${COST_FN})(${COST_S * 1000})`) : null;

    console.log(`\n  --- minPx2 ${v === null ? '(as built)' : v} ---`);
    for (const m of out) {
      const px = Number.isFinite(m.px) ? m.px.toFixed(1) : String(m.px);
      console.log(`  ROBOT ${m.i + 1}  on-screen height ${px}px   minPx2 ${m.minPx2}   budget ${Number.isFinite(m.budget) ? m.budget.toFixed(0) : m.budget}`);
      let dp = 0, ap = 0;
      m.buckets.forEach((b, k) => {
        dp += b.prims; ap += b.allPrims;
        const pc = b.total ? (100 * b.drawn / b.total).toFixed(1) : '—';
        console.log(`     bucket ${k}: prims ${b.prims}/${b.allPrims}   indices ${b.drawn}/${b.total} (${pc}%)`);
      });
      console.log(`     TOTAL primitives drawn ${dp}/${ap}  (${ap ? (100 * dp / ap).toFixed(1) : '—'}%)  dropped ${ap - dp}`);
    }
    if (cost) {
      const fps = cost.frames / cost.secs;
      console.log(`     COST  ${fps.toFixed(2)} fps (${(1000 / fps).toFixed(0)} ms/frame, ${cost.frames} frames in ${cost.secs.toFixed(1)}s)   ${Math.round(cost.tris)} tris   ${Math.round(cost.calls)} draw calls`);
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
