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
 *   node tools/screenshot.mjs --shot fight --clip hud-l
 *   node tools/screenshot.mjs --shot fight --clip 0,0,520,140
 *
 * `--shots` takes a comma-separated list and captures all of them from one
 * browser launch. A review pass wants ten screens at once and paying the boot
 * cost ten times is most of the wall clock.
 *
 * `--clip` crops the capture, either to a named region (see CLIPS below) or to
 * a literal `x,y,w,h`. Crops are written alongside the full frame with the
 * region name appended, never over it.
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
 * Named crop regions for `--clip`, as fractions of the viewport so one name
 * works on a 1600x900 desktop frame and on a 390x844 phone.
 *
 * A 15px-tall health bar occupies 1.7% of a 1600x900 PNG. Judging whether its
 * filled/empty boundary actually reads is guesswork at that size, and two
 * different HP values look identical. These crop to the widget instead.
 */
const CLIPS = {
  'hud-top':    [0, 0, 1, 0.20],
  'hud-l':      [0, 0, 0.33, 0.17],
  'hud-r':      [0.67, 0, 0.33, 0.17],
  'hud-centre': [0.37, 0, 0.26, 0.20],
  gear:         [0, 0.72, 0.44, 0.28],
  reticle:      [0.40, 0.35, 0.20, 0.30],
  net:          [0.70, 0.72, 0.30, 0.28],
  foot:         [0, 0.85, 1, 0.15],
  info:         [0.71, 0.03, 0.29, 0.94],
  rail:         [0, 0.03, 0.32, 0.94],
  pad:          [0.42, 0.55, 0.58, 0.45],
};

/**
 * `--clip` takes a literal `x,y,w,h` in CSS pixels, or a comma-separated list
 * of named regions — `--clip hud-l,hud-r,gear` writes three detail PNGs from a
 * single page load. Four numeric tokens are the literal form; anything else is
 * read as names.
 *
 * Returns [] for no clip and skips names it does not know, so a typo costs one
 * crop rather than throwing halfway through a ten-screen run.
 */
function resolveClips(spec, vp) {
  if (typeof spec !== 'string') return [];
  const toks = spec.split(',').map((s) => s.trim()).filter(Boolean);

  const nums = toks.map(Number);
  if (toks.length === 4 && nums.every((v) => Number.isFinite(v))) {
    return [{ tag: 'crop', rect: { x: nums[0], y: nums[1], width: nums[2], height: nums[3] } }];
  }

  const out = [];
  for (const t of toks) {
    const f = CLIPS[t];
    if (!f) {
      console.error(`  ⚠ unknown --clip region "${t}" — known: ${Object.keys(CLIPS).join(', ')}`);
      continue;
    }
    out.push({
      tag: t,
      rect: {
        x: Math.round(f[0] * vp.width),
        y: Math.round(f[1] * vp.height),
        width: Math.round(f[2] * vp.width),
        height: Math.round(f[3] * vp.height),
      },
    });
  }
  return out;
}

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
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'grid', loadouts: g.loadouts, seed: 1234567 });
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
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: o.arenaId || 'grid', loadouts: g.loadouts, seed: 1234567 });
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
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: o.arenaId || 'grid', loadouts: g.loadouts, seed: 1234567 });
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
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'foundry', loadouts: g.loadouts, seed: 1234567 });
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
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'orbital', loadouts: g.loadouts, seed: 1234567 });
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
        g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: o.arenaId || 'grid', loadouts: g.loadouts, seed: 1234567 });
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
  //
  // This used to bulk-advance and then hand the last stretch over in ten slices
  // with real frames in between, to let per-frame systems settle at something
  // like 60fps. It also made every capture unrepeatable, which cost this project
  // more than the settling was worth: two runs of the same command produced two
  // different fights, so no before/after comparison meant anything. Three
  // separate sources had to be closed.
  //
  //   1. The match seed defaulted to Math.random() (fixed at the startMatch
  //      calls above).
  //   2. The engine ran free between slices, so the demo AI played however many
  //      ticks the machine had time for. It is paused here first.
  //   3. `fastForward` advances the sim but NOT `engine.clock.elapsed`, which is
  //      what every effect ages against. Births during a paused fast-forward all
  //      got stamped with a clock that only moves on wall time, so the effects
  //      in the frame were whatever the screenshot's own latency made them. The
  //      clock is now stepped in lockstep with the sim, one tick at a time.
  //
  // The camera rig is then driven to its steady state on a fixed delta, since it
  // smooths using the real frame delta and under software GL that is whatever
  // the last frame happened to cost.
  const ticks = Number(opts.ticks ?? scenario.ticks ?? 0);
  if (ticks > 0) {
    await page.evaluate((n) => {
      const g = window.__game;
      const TICK = 1 / 60;
      g.engine.paused = true;
      for (let i = 0; i < n; i++) {
        g.fastForward(1);
        if (g.engine.clock) g.engine.clock.elapsed += TICK;
      }
      if (g.rig && g.world && g.view) {
        let t = (g.engine.clock && g.engine.clock.elapsed) || 0;
        for (let i = 0; i < 240; i++) {
          const views = g.view.prepare(1);
          g.rig.update(g.world, views, g.localIndex, TICK, t);
          t += TICK;
        }
        g.view.update(0, 1, t);
      }

      // `paused` only gates the sim: the engine still calls onRender every frame
      // with the REAL wall-clock delta, so the view kept integrating throughout
      // the multi-second software-GL screenshot and no two captures matched.
      // Detaching it leaves the scene exactly as settled above, with postfx
      // still drawing it against the frozen clock.
      g.engine.onRender = null;
      // Auto-quality samples frame time and can resize the render target
      // mid-capture, which changes the image for reasons that have nothing to
      // do with the art.
      if (g.engine.quality) g.engine.quality.auto = false;
    }, ticks);
    await page.waitForTimeout(500);
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
  const clips = resolveClips(opts.clip, vp);

  // A crop gets its own filename. Writing a 500px detail view over the
  // full-frame PNG of the same scenario loses the frame you were comparing
  // against, which is exactly when you need both.
  const nameFor = (tag) => {
    if (opts.out) return tag ? opts.out.replace(/(\.png)?$/i, `-${tag}.png`) : opts.out;
    const dev = opts.device && opts.device !== 'desktop' ? `-${opts.device}` : '';
    return path.join(OUT_DIR, `${opts.prefix || ''}${name}${dev}${tag ? `-${tag}` : ''}.png`);
  };

  // Playwright's 30s default is a desktop-GPU assumption. Compositing a
  // 1600x900 WebGL frame under SwiftShader on a box that is also running
  // three other capture jobs routinely takes longer than that, and losing a
  // six-minute capture on the very last call is the most expensive way to
  // find out. The failure this guards against is slowness, not a hang.
  const SHOT_TIMEOUT = 120000;

  const files = [];
  if (!clips.length) {
    const f = nameFor('');
    await page.screenshot({ path: f, timeout: SHOT_TIMEOUT });
    files.push(f);
  } else {
    // All crops come off the same settled frame — no re-boot per region.
    for (const c of clips) {
      const f = nameFor(c.tag);
      await page.screenshot({ path: f, clip: c.rect, timeout: SHOT_TIMEOUT });
      files.push(f);
    }
  }
  await context.close();

  return { file: files.join(', '), files, stats, errors };
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
  // INSTRUMENT FAULT 56. This used to read `pinned`, which
  // resolves a missing pin to the DEFAULT browser instead of stopping. A guard the
  // caller can redirect is not a guard (faults 29, 43 and 53), and a figure taken on a
  // different rasteriser than the card was measured on is not comparable to it.
  if (!existsSync(pinned)) {
    console.error('INSTRUMENT FAULT 56: this file pins ' + pinned + ' and it is not on this box.');
    console.error('Refusing to fall back to the default browser. Install that build or run elsewhere.');
    process.exit(2);
  }
  const executablePath = pinned;

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
