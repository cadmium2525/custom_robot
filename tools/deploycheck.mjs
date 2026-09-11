#!/usr/bin/env node
/**
 * Playthrough gate for a built artifact.
 *
 * `bootcheck` answers "does it start"; this answers "does a whole match run to
 * a result, in every arena, with nothing thrown". It is the check that has to
 * pass before a bundle is handed to anybody, and it is deliberately pointed at
 * a URL rather than at the source tree so it can be run against the real
 * deployed thing — the dev server, `dist/`, the single-file bundle, or Pages.
 *
 *   node tools/deploycheck.mjs [baseUrl]
 *
 * This was run by hand once, found nothing, and was then not committed — so
 * the next person to want it had to write it again. Both the single-file
 * bundler and this file exist in their present form because an artifact that
 * "was verified" and an artifact that has a committed verifier are not the
 * same claim.
 *
 * Exit 0 = every arena reached a result with no page errors.
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:4173/custom_robot/';
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// INSTRUMENT FAULT 56. This used to read `PINNED`, which
// resolves a missing pin to the DEFAULT browser instead of stopping. A guard the
// caller can redirect is not a guard (faults 29, 43 and 53), and a figure taken on a
// different rasteriser than the card was measured on is not comparable to it.
if (!existsSync(PINNED)) {
  console.error('INSTRUMENT FAULT 56: this file pins ' + PINNED + ' and it is not on this box.');
  console.error('Refusing to fall back to the default browser. Install that build or run elsewhere.');
  process.exit(2);
}
const SEED = 1234567;          // pinned, as everywhere else in this harness
const MAX_TICKS = 60 * 60 * 8; // eight sim-minutes: far past any real match

const browser = await chromium.launch({
  headless: true,
  executablePath: PINNED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});

const page = await browser.newPage({ viewport: { width: 640, height: 360 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__game?.engine?.running, null, { timeout: 90000 });

const arenas = await page.evaluate(() => window.__game.arenas?.map((a) => a.id)
  ?? ['grid', 'foundry', 'orbital']);

let bad = 0;

for (const arenaId of arenas) {
  const r = await page.evaluate(async ({ arenaId, SEED, MAX_TICKS }) => {
    const g = window.__game;

    // Drive the renderer off the clock: a software-rendered frame costs more
    // than a sim tick by two orders of magnitude, and none of what is being
    // asserted here is visual.
    g.engine.paused = true;
    g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId, seed: SEED });
    g.setDemo(true);            // both sides on AI, so the match actually ends

    let ticks = 0;
    // `fastForward` stops at MATCH_END, so this loop is what carries the run
    // across rounds to the end of the match rather than the end of round one.
    for (let i = 0; i < 40 && ticks < MAX_TICKS; i++) {
      const n = g.fastForward(600);
      ticks += n;
      if (n === 0) break;       // no longer in a match: it ended and tore down
      // Let the round-transition timers run on the real clock for a beat.
      g.engine.clock.elapsed += 600 / 60;
      await new Promise((res) => setTimeout(res, 0));
    }

    const state = g.state;
    const screen = g.menus?.current ?? null;
    g.engine.paused = false;
    return { ticks, state, screen };
  }, { arenaId, SEED, MAX_TICKS });

  // A finished match leaves the match state; still being in it after eight
  // sim-minutes means something is wedged, which is the failure this catches.
  const ok = r.state !== 'match' && r.ticks > 0 && r.ticks < MAX_TICKS;
  if (!ok) bad++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${arenaId.padEnd(9)} ${String(r.ticks).padStart(6)} ticks` +
    `  state=${r.state} screen=${r.screen}`,
  );

  // Back to a known screen before the next arena.
  await page.evaluate(() => window.__game.menus?.show?.('title')).catch(() => {});
}

if (errors.length) {
  console.log(`\n${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e.slice(0, 400)}`);
}

await browser.close();

const pass = bad === 0 && errors.length === 0;
console.log(pass ? '\nDEPLOY OK' : `\nDEPLOY FAILED (${bad} arena(s), ${errors.length} error(s))`);
process.exit(pass ? 0 : 1);
