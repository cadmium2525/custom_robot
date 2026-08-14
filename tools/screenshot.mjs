#!/usr/bin/env node
/**
 * Headless capture harness.
 *
 * Boots the built game in Chromium, drives it into a named scenario, and writes
 * a PNG. This is what the visual-review pass looks at, so it has to reproduce
 * what a player actually sees — same post chain, same quality tier logic.
 *
 * Usage:
 *   node tools/screenshot.mjs --shot title
 *   node tools/screenshot.mjs --shot fight --time 6 --out shots/fight.png
 *   node tools/screenshot.mjs --shots title,garage,settings --prefix ui-
 *   node tools/screenshot.mjs --all
 *   node tools/screenshot.mjs --shot fight --device iphone12
 *
 * `--shots` takes a comma-separated list and captures all of them from one
 * browser launch. A review pass wants ten screens at once and paying the boot
 * cost ten times is most of the wall clock.
 *
 * Assumes a server is already running (npm run preview) unless --serve is given.
 */

import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4173/custom_robot/');
const OUT_DIR = flag('outdir', 'shots');
const DEVICE = flag('device', 'desktop');
const HEADLESS = flag('headed') ? false : true;

const VIEWPORTS = {
  desktop: { width: 1600, height: 900, deviceScaleFactor: 1 },
  hd: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  iphone12: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  ipad: { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true },
};

/**
 * Each scenario is a recipe run inside the page against `window.__game`.
 * Keep them declarative — the reviewer needs the same frame every run.
 */
const SCENARIOS = {
  title: { settle: 2.0, setup: null },

  garage: {
    settle: 2.2,
    setup: async (page) => {
      await page.evaluate(() => window.__game.menus.show('garage', {
        loadouts: window.__game.loadouts, index: 0,
      }));
    },
  },

  arena: {
    settle: 1.6,
    setup: async (page) => {
      await page.evaluate(() => window.__game.menus.show('arena', { arenaId: window.__game.arenaId }));
    },
  },

  // --- menu screens that had no scenario, so nobody had ever looked at them --

  mode: {
    settle: 1.4,
    setup: async (page) => {
      await page.evaluate(() => window.__game.menus.show('mode'));
    },
  },

  netplay: {
    settle: 1.4,
    setup: async (page) => {
      await page.evaluate(() => {
        const m = window.__game.menus;
        m.show('netplay');
        // Show it mid-flight rather than idle: a host code is up and we are
        // waiting on a peer, which is the state with the most chrome in it.
        m.setNetState({ status: 'hosting', code: 'K7QX', message: 'waiting for challenger', pingMs: 0 });
      });
    },
  },

  boot: {
    settle: 1.2,
    setup: async (page) => {
      await page.evaluate(() => {
        const m = window.__game.menus;
        m.show('boot');
        m.setLoading(0.62, 'arena geometry');
      });
    },
  },

  settings: {
    settle: 1.2,
    setup: async (page) => {
      await page.evaluate(() => window.__game.menus.show('settings'));
    },
  },

  controls: {
    settle: 1.2,
    setup: async (page) => {
      await page.evaluate(() => window.__game.menus.show('controls'));
    },
  },

  results: {
    settle: 1.4,
    setup: async (page) => {
      await page.evaluate(() => window.__game.menus.show('results', {
        winner: 0,
        wins: [2, 1],
        localIndex: 0,
        names: ['RAY-01', 'ACE'],
        rounds: [
          { round: 1, winner: 0 },
          { round: 2, winner: 1, timeout: true },
          { round: 3, winner: 0 },
        ],
        stats: { damage: 2480, hits: 63, accuracy: '41%', 'longest chain': 7 },
      }));
    },
  },

  // Pause sits over a live match, so the match has to be running underneath.
  pause: {
    settle: 1.0,
    ticks: 300,
    setup: async (page) => {
      await page.evaluate(() => {
        const g = window.__game;
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'grid', loadouts: g.loadouts });
        g.setDemo(true);
      });
    },
    beforeShot: async (page) => {
      await page.evaluate(() => window.__game.pause());
      await page.waitForTimeout(500);
    },
  },

  // Two robos squared up mid-round, mid-firefight.
  fight: {
    settle: 1.0,
    ticks: 420,
    setup: async (page, opts) => {
      await page.evaluate((o) => {
        const g = window.__game;
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: o.arenaId || 'grid', loadouts: g.loadouts });
        g.setDemo(true);
      }, opts);
    },
  },

  // Frozen at the instant a charged shot detonates.
  explosion: {
    settle: 1.0,
    ticks: 400,
    setup: async (page, opts) => {
      await page.evaluate((o) => {
        const g = window.__game;
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: o.arenaId || 'grid', loadouts: g.loadouts });
        g.setDemo(true);
      }, opts);
    },
    beforeShot: async (page) => {
      // Force a detonation right between the fighters so the frame is reliable.
      await page.evaluate(() => {
        const g = window.__game;
        const w = g.world;
        if (!w) return;
        const a = w.robos[0], b = w.robos[1];
        const p = w.alloc();
        if (!p) return;
        p.alive = 1; p.kind = 1; p.owner = 1; p.team = 1;
        p.pos.x = (a.pos.x + b.pos.x) / 2;
        p.pos.y = 1.1;
        p.pos.z = (a.pos.z + b.pos.z) / 2;
        p.vel.x = p.vel.y = p.vel.z = 0;
        p.life = 2; p.damage = 120; p.radius = 4.2; p.knockback = 9;
        p.partIdx = 0; p.seed = 12345;
      });
      await page.waitForTimeout(260);
    },
  },

  foundry: {
    settle: 1.0,
    ticks: 420,
    setup: async (page) => {
      await page.evaluate(() => {
        const g = window.__game;
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'foundry', loadouts: g.loadouts });
        g.setDemo(true);
      });
    },
  },

  orbital: {
    settle: 1.0,
    ticks: 420,
    setup: async (page) => {
      await page.evaluate(() => {
        const g = window.__game;
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'orbital', loadouts: g.loadouts });
        g.setDemo(true);
      });
    },
  },

  // The touch layer only mounts after a real touch, so a plain phone capture
  // shows an empty screen and the whole control layer goes unreviewed. This
  // wakes it and then holds two fingers down — stick out, FIRE pressed.
  touch: {
    settle: 1.0,
    ticks: 380,
    setup: async (page, opts) => {
      await page.evaluate((o) => {
        const g = window.__game;
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: o.arenaId || 'grid', loadouts: g.loadouts });
        g.setDemo(true);
      }, opts);
    },
    beforeShot: async (page) => {
      // A tap is enough to mount the layer; only then can we measure it.
      await page.touchscreen.tap(60, 500);
      await page.waitForTimeout(250);

      const pts = await page.evaluate(() => {
        const c = (sel) => {
          const r = document.querySelector(sel)?.getBoundingClientRect();
          return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        };
        const zone = document.querySelector('.tc__zone--move')?.getBoundingClientRect();
        return {
          move: zone && zone.width
            ? { x: zone.left + zone.width * 0.45, y: zone.top + zone.height * 0.74 }
            : null,
          fire: c('.tb--fire'),
        };
      });
      if (!pts.move || !pts.fire) return;

      // Real held touches, via CDP — Playwright's tap always releases.
      const cdp = await page.context().newCDPSession(page);
      const send = (type, points) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      const thumb = { x: pts.move.x, y: pts.move.y, id: 1 };
      const trigger = { x: pts.fire.x, y: pts.fire.y, id: 2 };
      await send('touchStart', [thumb]);
      // Drag the stick off-centre so the nub is not sitting dead centre.
      await send('touchMove', [{ x: thumb.x + 34, y: thumb.y - 26, id: 1 }]);
      await send('touchStart', [{ x: thumb.x + 34, y: thumb.y - 26, id: 1 }, trigger]);
      await page.waitForTimeout(500);
    },
  },

  // Static hero framing of a single robo, for model review.
  hero: {
    settle: 2.4,
    setup: async (page, opts) => {
      await page.evaluate((o) => {
        const g = window.__game;
        if (o.loadout) {
          g.loadouts[0] = { ...g.loadouts[0], ...o.loadout };
          g.menus.emit?.('loadoutChange', { index: 0, loadout: g.loadouts[0] });
        }
        g.menus.show('garage', { loadouts: g.loadouts, index: 0 });
      }, opts);
    },
  },
};

async function capture(browser, name, opts = {}) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario: ${name}`);

  const vp = VIEWPORTS[opts.device || DEVICE] || VIEWPORTS.desktop;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: !!vp.mobile,
    hasTouch: !!vp.mobile,
    userAgent: vp.mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(e?.stack ? `${e.stack}` : String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Wait for the shell to construct and the loop to be running.
  //
  // When this times out it is almost always because something threw during
  // construction, and the bare timeout says nothing about what. Re-throw with
  // the page errors attached — a boot crash reported as "waitForFunction:
  // Timeout" costs whoever hits it an hour of bisecting their own diff.
  try {
    await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 45000 });
  } catch (e) {
    const where = await page.evaluate(() => ({
      hasGame: !!window.__game,
      state: window.__game?.state ?? '(none)',
      screen: window.__game?.menus?.current ?? '(none)',
      running: !!window.__game?.engine?.running,
    })).catch(() => null);

    const lines = [`the game never reached engine.running (${e.message.split('\n')[0]})`];
    if (where) {
      lines.push(`  page state: __game=${where.hasGame} state=${where.state} ` +
        `screen=${where.screen} running=${where.running}`);
    }
    if (errors.length) {
      lines.push(`  ${errors.length} page error(s) — this is very likely the cause:`);
      for (const err of errors.slice(0, 5)) {
        lines.push(err.split('\n').slice(0, 6).map((l) => `    ${l.trim()}`).join('\n'));
      }
    } else {
      lines.push('  no page errors were logged — boot is hanging rather than throwing.');
    }
    await context.close();
    throw new Error(lines.join('\n'));
  }

  if (opts.tier != null) {
    await page.evaluate((t) => {
      const q = window.__game.engine.quality;
      q.auto = false;
      q.setTier(t);
    }, Number(opts.tier));
    await page.waitForTimeout(400);
  }

  const settle = Number(opts.time ?? scenario.settle ?? 2);
  if (scenario.setup) await scenario.setup(page, opts);
  await page.waitForTimeout(settle * 1000);

  // Software GL renders at a few fps here, so drive the sim directly rather
  // than hoping enough real time elapses.
  const ticks = Number(opts.ticks ?? scenario.ticks ?? 0);
  if (ticks > 0) {
    // Bulk-advance to an interesting point in the round...
    await page.evaluate((n) => window.__game.fastForward(Math.max(0, n - 40)), ticks);
    // ...then hand the last stretch over in small slices with real frames in
    // between, so per-frame systems (trails, particle spawn timing, camera
    // damping) settle the way they would at 60fps instead of being sampled once.
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.__game.fastForward(4));
      await page.waitForTimeout(260);
    }
  }

  if (scenario.beforeShot) await scenario.beforeShot(page);

  const stats = await page.evaluate(() => {
    const g = window.__game;
    return {
      fps: g.engine.stats.fps,
      frameMs: +g.engine.stats.frameMs.toFixed(2),
      drawCalls: g.engine.stats.drawCalls,
      triangles: g.engine.stats.tris,
      tier: g.engine.quality.settings.name,
      scale: +g.engine.quality.effectiveScale.toFixed(2),
      state: g.state,
      screen: g.menus.current,
    };
  }).catch(() => null);

  await mkdir(OUT_DIR, { recursive: true });
  const suffix = opts.device && opts.device !== 'desktop' ? `-${opts.device}` : '';
  const file = opts.out || path.join(OUT_DIR, `${opts.prefix || ''}${name}${suffix}.png`);

  // `--clip x,y,w,h` crops to a region. A 15px-tall health bar in a 1600x900
  // frame is four pixels tall by the time anyone looks at the PNG, so judging
  // HUD detail from full frames is guesswork; this crops to the widget.
  let clip;
  if (typeof opts.clip === 'string') {
    const n = opts.clip.split(',').map(Number);
    if (n.length === 4 && n.every((v) => Number.isFinite(v))) {
      clip = { x: n[0], y: n[1], width: n[2], height: n[3] };
    }
  }
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  await context.close();

  return { file, stats, errors };
}

async function main() {
  let server = null;
  if (flag('serve')) {
    server = spawn('npx', ['vite', 'preview', '--port', '4173', '--host', '127.0.0.1'], {
      stdio: 'ignore', detached: false,
    });
    // Give preview a beat to bind the port.
    await new Promise((r) => setTimeout(r, 2500));
  }

  // The sandbox image ships a pinned Chromium that may not match the version
  // this Playwright build expects, so use it directly rather than downloading.
  const pinned = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const executablePath = existsSync(pinned) ? pinned : undefined;

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-lcd-text',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const shots = flag('shots');
  const list = flag('all')
    ? ['title', 'garage', 'arena', 'fight', 'explosion', 'foundry', 'orbital']
    : typeof shots === 'string'
      ? shots.split(',').map((s) => s.trim()).filter(Boolean)
      : [flag('shot', 'fight')];

  const results = [];
  for (const name of list) {
    try {
      const r = await capture(browser, name, {
        device: DEVICE,
        time: flag('time') ? Number(flag('time')) : undefined,
        out: list.length === 1 ? flag('out') : null,
        prefix: flag('prefix') || '',
        clip: flag('clip'),
        arenaId: flag('arena'),
        ticks: flag('ticks') ? Number(flag('ticks')) : undefined,
        tier: flag('tier') != null ? flag('tier') : undefined,
        loadout: flag('body') ? { body: flag('body') } : undefined,
      });
      results.push({ name, ...r });
      console.log(`✓ ${name} -> ${r.file}`);
      if (r.stats) console.log(`  ${JSON.stringify(r.stats)}`);
      if (r.errors.length) console.log(`  ⚠ ${r.errors.length} error(s):\n    ${r.errors.slice(0, 8).join('\n    ')}`);
    } catch (e) {
      console.error(`✗ ${name}: ${e.message}`);
      results.push({ name, error: e.message });
    }
  }

  await browser.close();
  if (server) server.kill();

  const failed = results.filter((r) => r.error || (r.errors && r.errors.length));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
