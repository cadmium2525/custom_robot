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
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* Byte-identical to tools/mass.mjs's settle — same pinned frame. */
const SETTLE_FN = `(n) => {
  const g = window.__game;
  if (!g.rig || !g.world || !g.view) return false;
  let t = (g.engine.clock && g.engine.clock.elapsed) || 0;
  for (let i = 0; i < n; i++) {
    const views = g.view.prepare(1);
    g.rig.update(g.world, views, g.localIndex, 1 / 60, t);
    t += 1 / 60;
  }
  g.view.update(0, 1, t);
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
  if (MINPX2 !== null) {
    await page.evaluate((v) => {
      for (const m of window.__game.view.models) { m.lodMinPx2 = v; m._lodBudget = -1; }
    }, Number(MINPX2));
  }
  await page.waitForTimeout(400);
  const out = await page.evaluate(READ_FN);

  console.log(`\nLOD — ${ARENA} @ tier ${TIER}${MINPX2 !== null ? `  minPx2=${MINPX2}` : ''}`);
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
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
