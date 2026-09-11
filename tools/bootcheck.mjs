#!/usr/bin/env node
/**
 * Fast boot check.
 *
 * A full capture takes minutes; this answers "does the game start at all, and
 * how long does it take" in seconds, and — crucially — prints the page error
 * when it doesn't. A crash during construction shows up as a `waitForFunction`
 * timeout in the capture harness, which looks identical to a slow render and
 * sends you hunting in the wrong place.
 *
 *   node tools/bootcheck.mjs [baseUrl]
 *
 * Exit 0 = booted. Exit 1 = did not.
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

const browser = await chromium.launch({
  headless: true,
  executablePath: PINNED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});

// A small viewport keeps the software renderer from dominating the timing.
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const t0 = Date.now();
let ok = false;

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__game?.engine?.running, null, { timeout: 90000 });
  ok = true;
} catch { /* reported below */ }

const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (ok) {
  const stats = await page.evaluate(() => ({
    tier: window.__game.engine.quality.settings.name,
    screen: window.__game.menus.current,
  })).catch(() => ({}));
  console.log(`BOOTED in ${secs}s  ${JSON.stringify(stats)}`);
} else {
  const state = await page.evaluate(() => ({
    hasGame: !!window.__game,
    state: window.__game?.state ?? null,
    running: window.__game?.engine?.running ?? null,
  })).catch((e) => ({ evalFailed: String(e) }));
  console.log(`DID NOT BOOT after ${secs}s  ${JSON.stringify(state)}`);
}

if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e.slice(0, 400)}`);
}

await browser.close();
process.exit(ok ? 0 : 1);
