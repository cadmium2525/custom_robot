#!/usr/bin/env node
/**
 * SWEEP A THEME VALUE THROUGH THE SILHOUETTE METER, WITHOUT A REBUILD.
 *
 * An arena theme is pure data (`src/sim/arena.js`), the Stage reads it once at
 * `startMatch`, and `World` holds the SAME object `ARENAS` does — so a variant
 * can be measured by mutating the theme in the page and starting the match
 * again. No `npm run build`, no `_snap.sh`, no serving root swapped under a
 * sweep that is already in flight (which is how rounds 12 and 13 lost captures).
 * One browser boot covers every variant, so a four-point sweep costs one run.
 *
 * ONE CACHE TRAP, and it will silently return the OLD arena if you miss it:
 * `floorTexture`/`wallTexture`/`galleryTexture`/`screenTexture` are all cached
 * under `<what>:${theme.key}:${size}`. Changing `theme.deck` without changing
 * `theme.key` gets you the previous bake and a null result that looks like a
 * real one. Every variant here is given its own key.
 *
 * THE METER IS tools/contour.mjs, NOT A COPY OF IT. Its settle, its VFX
 * suppression, its stencil pass and its analysis are read out of the file at
 * run time by name, the way `shots/_drivefix.mjs` reads its settle line, and the
 * run aborts if any of the four cannot be found rather than quietly measuring
 * with something else. Two meters drift; this project has retired two mass
 * modes for exactly that.
 *
 *   node shots/_theme.mjs --arena foundry \
 *        --v "head" --v "deck=0x6d6459" --v "deck=0x665c51,floor=0x2f251e"
 *
 * Each --v is a comma-separated list of `field=value` (0x… hex, or a number).
 * "head" (or an empty variant) measures the shipped theme untouched.
 * --seed may be repeated; every variant is measured at every seed.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); if (i < 0) return d; const v = args[i + 1]; return v && !v.startsWith('--') ? v : true; };
const many = (n) => args.reduce((a, v, i) => (v === `--${n}` && args[i + 1] ? [...a, args[i + 1]] : a), []);
const BASE = flag('base', 'http://127.0.0.1:4300/custom_robot/');
const ARENA = flag('arena', 'foundry');
const TIER = Number(flag('tier', 3));
const TICKS = Number(flag('ticks', 420));
const SEEDS = (many('seed').length ? many('seed') : ['1234567']).map(Number);
const VARIANTS = many('v').length ? many('v') : ['head'];
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* ---- lift the meter's own code out of tools/contour.mjs ------------------ */
const SRC = readFileSync(join(HERE, '..', 'tools', 'contour.mjs'), 'utf8');
const lift = (startMark, endMark) => {
  const a = SRC.indexOf(startMark);
  const b = SRC.indexOf(endMark, a + 1);
  if (a < 0 || b < 0) {
    console.error(`_theme: cannot find ${startMark} .. ${endMark} in tools/contour.mjs.\n` +
      'The meter has been rewritten. Re-read it before trusting any reading from this file.');
    process.exit(2);
  }
  return SRC.slice(a + startMark.length, b).trim().replace(/;$/, '');
};
const STENCIL_FN = lift('const STENCIL_FN = `', '`;\n');
const SETTLE_FN = lift('const SETTLE_FN = `', '`;\n');
const VFX_OFF_FN = lift('const VFX_OFF_FN = `', '`;\n');
const ANALYSE_FN = lift('const ANALYSE_FN =', '\nconst bar =');

const parseV = (spec) => {
  const o = {};
  if (!spec || spec === 'head') return o;
  for (const part of spec.split(',')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    o[k.trim()] = v.trim().startsWith('0x') ? parseInt(v.trim(), 16) : Number(v.trim());
  }
  return o;
};

(async () => {
  const browser = await chromium.launch({
    executablePath: PINNED,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 90000 });
  await page.evaluate((t) => { const q = window.__game.engine.quality; q.auto = false; q.setTier(t); }, TIER);
  for (const id of ['ui-layer', 'hud-layer', 'splash']) {
    await page.evaluate((i) => { const el = document.getElementById(i); if (el) el.style.display = 'none'; }, id);
  }
  const probe = await context.newPage();
  await probe.goto('about:blank');

  /* The shipped theme, captured once so every variant starts from it. */
  await page.evaluate(({ id }) => {
    const g = window.__game;
    g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed: 1 });
    window.__theme0 = { ...g.world.arena.theme };
  }, { id: ARENA });

  const rows = [];
  for (const spec of VARIANTS) {
    const over = parseV(spec);
    for (const seed of SEEDS) {
      await page.evaluate(({ id, seed, over, tag }) => {
        const g = window.__game;
        const th = g.world.arena.theme;
        // Back to the shipped values first, so variants cannot accumulate.
        Object.assign(th, window.__theme0, over);
        // Bust every texture cache keyed on theme.key — see the header.
        th.key = `${window.__theme0.key}#${tag}`;
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
        g.setDemo(true);
        g.engine.paused = true;
        if (g.engine.clock) g.engine.clock.elapsed = 1000;
      }, { id: ARENA, seed, over, tag: `${spec}|${seed}` });
      await page.waitForTimeout(1200);
      await page.evaluate((n) => window.__game.fastForward(n), TICKS);
      if (!await page.evaluate(`(${SETTLE_FN})(240)`)) throw new Error('rig unavailable');
      await page.evaluate(`(${VFX_OFF_FN})()`);
      await page.waitForTimeout(700);
      const N = await page.screenshot({ timeout: 180000 });
      await page.evaluate(`(${STENCIL_FN})(true)`);
      await page.waitForTimeout(700);
      const H = await page.screenshot({ timeout: 180000 });
      await page.evaluate(`(${STENCIL_FN})(false)`);
      // The analysis is lifted from contour.mjs as SOURCE, so it reaches the
      // page as a string. `page.evaluate(string, arg)` does not forward `arg`
      // — Playwright treats a string as an expression — so the two data URIs
      // are parked on `window` by a real function first and the lifted arrow is
      // then called against them. Passing them inside the expression would work
      // and would also mean a 5 MB source string per capture.
      await probe.evaluate(([n, h]) => { window.__args = { nUri: n, hUri: h }; }, [
        'data:image/png;base64,' + N.toString('base64'),
        'data:image/png;base64,' + H.toString('base64'),
      ]);
      const out = await probe.evaluate(`(${ANALYSE_FN})(window.__args)`);
      const r1 = out.bodies[0];
      rows.push({ spec, seed, px: out.maskPx, ov: out.overall, ovv: out.overallValues, r1 });
      const f = (v, n = 5) => String(v == null ? '-' : v).padStart(n);
      console.log(
        `${spec.padEnd(34)} seed ${String(seed).padEnd(8)} px ${f(out.maskPx, 6)}  ` +
        `OVERALL inv ${f(out.overall.under12)}%  clean ${f(out.overall.over40)}%  ` +
        `med ${f(out.overall.median)}  body ${f(out.overallValues.body)}/${f(out.overallValues.background)}   ` +
        `NEAR ${r1 ? `${r1.box.padEnd(9)} inv ${f(r1.contour.under12)}%  clean ${f(r1.contour.over40)}%  body ${f(r1.values.body)}/${f(r1.values.background)}` : '-'}`);
    }
  }

  /* Per-variant medians across the seeds, which is the only comparison that
     means anything: one seed is one frame and the frames are not equivalent. */
  const med = (a) => { const b = a.filter((v) => v != null).sort((x, y) => x - y); return b.length ? Math.round(b[b.length >> 1] * 10) / 10 : null; };
  console.log('\nMEDIANS ACROSS SEEDS');
  console.log('variant                              n   OVERALL inv  clean    NEAR inv  clean');
  for (const spec of VARIANTS) {
    const g = rows.filter((r) => r.spec === spec);
    if (!g.length) continue;
    const f = (v) => String(v == null ? '-' : v).padStart(5);
    console.log(`${spec.padEnd(34)} ${String(g.length).padStart(3)}   ${f(med(g.map((r) => r.ov.under12)))}%  ${f(med(g.map((r) => r.ov.over40)))}%` +
      `   ${f(med(g.map((r) => r.r1?.contour.under12)))}%  ${f(med(g.map((r) => r.r1?.contour.over40)))}%`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
