#!/usr/bin/env node
/**
 * VFX contact sheet — captures one effect at several *ages* from a single run.
 *
 * Why this exists, and why it is not just a flag on screenshot.mjs:
 *
 * The engine clamps `dt` to one tick whenever a frame takes longer than 250ms
 * (`engine.js:_loop`), which under software GL is *every* frame. `clock.elapsed`
 * — the clock every effect ages against — therefore advances exactly 1/60 s per
 * **rendered frame**, no matter how much wall time passed. So the usual
 * "trigger it, `waitForTimeout(260)`, screenshot" pattern does not photograph a
 * detonation 260ms old. It photographs one that is 16ms old, if it has even
 * been ignited yet. Every explosion capture in `shots/` is the same 16ms frame,
 * which is why the reviewer kept seeing a formless blob: the fireball has had
 * one frame to exist.
 *
 * This harness waits on `engine.clock.frame` instead. One frame == 16.67ms of
 * effect age, exactly and deterministically, so a requested age converts to an
 * integer frame count and a whole lifetime can be walked in one run.
 *
 *   node tools/vfxsheet.mjs --base http://127.0.0.1:4203/ --tier 3
 *   node tools/vfxsheet.mjs --effect tracer --out shots/sheet-tracer.png
 *   node tools/vfxsheet.mjs --effect probe          # DOM/canvas luminance probe
 *
 * Output is a single labelled grid PNG, plus the individual frames when
 * `--keep` is passed.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const BASE = flag('base', 'http://127.0.0.1:4203/');
const EFFECT = flag('effect', 'explosion');
const TIER = flag('tier', '3');
const KEEP = !!flag('keep');
const ZOOM = Number(flag('zoom', 560));      // crop side length in CSS px
const OUT = flag('out', `shots/sheet-${EFFECT}.png`);
const VP = { width: 1600, height: 900 };
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Ages in ms. Converted to frame counts at 1/60s per rendered frame. */
const AGES = {
  explosion: [0, 17, 33, 67, 117, 183, 267, 383, 533, 750, 1050, 1500],
  ko: [0, 33, 100, 200, 350, 550, 800, 1100, 1500, 2000, 2600, 3200],
  tracer: [0, 17, 33, 50, 67, 83, 100, 133, 167, 217, 283, 350],
  impact: [0, 17, 33, 50, 67, 100, 133, 183, 250, 350, 500, 700],
};

const msToFrames = (ms) => Math.round((ms / 1000) * 60);

// ---------------------------------------------------------------------------

async function frames(page, n) {
  if (n <= 0) return;
  const target = await page.evaluate((k) => window.__game.engine.clock.frame + k, n);
  await page.waitForFunction(
    (t) => window.__game.engine.clock.frame >= t,
    target,
    { timeout: 240000, polling: 30 }
  );
}

async function boot(browser) {
  const context = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
  const page = await context.newPage();
  // Software GL renders a tier-3 frame in seconds, and page.screenshot() waits
  // for a stable frame — the 30s default fires long before the compositor has
  // one to hand back.
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e?.stack ? String(e.stack) : String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game?.engine?.running, null, { timeout: 90000 });

  if (TIER != null) {
    await page.evaluate((t) => {
      const q = window.__game.engine.quality;
      q.auto = false;
      q.setTier(Number(t));
    }, TIER);
    await frames(page, 3);
  }
  return { context, page, errors };
}

async function enterMatch(page, ticks = 380) {
  await page.evaluate(() => {
    const g = window.__game;
    g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'grid', loadouts: g.loadouts });
    g.setDemo(true);
  });
  await frames(page, 2);
  await page.evaluate((n) => window.__game.fastForward(n), ticks);
  // A few real frames so trails, camera damping and the interpolator settle.
  await frames(page, 6);
}

/**
 * Detonate a bomb at a chosen point and return where it lands on screen, so the
 * sheet can crop to the blast instead of to the middle of the arena.
 */
async function igniteExplosion(page, opts = {}) {
  return page.evaluate((o) => {
    const g = window.__game;
    const w = g.world;
    const a = w.robos[0], b = w.robos[1];
    const x = o.x ?? (a.pos.x + b.pos.x) / 2;
    const z = o.z ?? (a.pos.z + b.pos.z) / 2;
    const y = o.y ?? 1.1;
    const p = w.alloc();
    if (!p) return null;
    p.alive = 1; p.kind = 1; p.owner = 1; p.team = 1;
    p.pos.x = x; p.pos.y = y; p.pos.z = z;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.life = 1; p.maxLife = 1;
    p.damage = 120; p.radius = o.radius ?? 4.2; p.knockback = 9;
    p.partIdx = 0; p.seed = 12345;
    // Two sim steps: one to tick the fuse to zero, one for the blast to resolve.
    g.fastForward(2);
    return { x, y, z };
  }, opts);
}

/** Project a world point to CSS pixels for the crop rectangle. */
async function projectPoint(page, pt) {
  return page.evaluate((p) => {
    const g = window.__game;
    const cam = g.camera;
    const THREE = window.__THREE;
    const v = THREE
      ? new THREE.Vector3(p.x, p.y, p.z)
      : { x: p.x, y: p.y, z: p.z };
    // No THREE handle on window in the production bundle — do it by hand with
    // the camera's own matrices, which are already up to date this frame.
    cam.updateMatrixWorld();
    const m = cam.projectionMatrix.elements;
    const vm = cam.matrixWorldInverse.elements;
    const X = p.x, Y = p.y, Z = p.z;
    const ex = vm[0] * X + vm[4] * Y + vm[8] * Z + vm[12];
    const ey = vm[1] * X + vm[5] * Y + vm[9] * Z + vm[13];
    const ez = vm[2] * X + vm[6] * Y + vm[10] * Z + vm[14];
    const cx = m[0] * ex + m[4] * ey + m[8] * ez + m[12];
    const cy = m[1] * ex + m[5] * ey + m[9] * ez + m[13];
    const cw = m[3] * ex + m[7] * ey + m[11] * ez + m[15];
    void v;
    const ndcX = cx / cw, ndcY = cy / cw;
    return {
      x: (ndcX * 0.5 + 0.5) * window.innerWidth,
      y: (-ndcY * 0.5 + 0.5) * window.innerHeight,
      behind: cw <= 0,
    };
  }, pt);
}

function cropRect(centre, side) {
  const half = side / 2;
  let x = Math.round(centre.x - half);
  let y = Math.round(centre.y - half);
  x = Math.max(0, Math.min(VP.width - side, x));
  y = Math.max(0, Math.min(VP.height - side, y));
  return { x, y, width: side, height: side };
}

/**
 * Sample the captured PNG rather than eyeballing it, so "is there actually
 * anything bright here" is a number instead of an opinion.
 *
 * The pixels have to come out of the screenshot, not out of the live canvas:
 * the renderer runs without `preserveDrawingBuffer`, so the drawing buffer is
 * already cleared by the time script can read it and `drawImage(canvas)` hands
 * back black. The screenshot is decoded back inside the page instead, which is
 * the one place with an image decoder.
 */
async function analyze(page, buf) {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let max = 0, sum = 0, over200 = 0, over128 = 0, warm = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (lum > max) max = lum;
      sum += lum;
      if (lum > 200) over200++;
      if (lum > 128) over128++;
      if (d[i] > d[i + 2] + 30) warm++;
      n++;
    }
    bmp.close();
    return {
      max: Math.round(max),
      mean: Math.round(sum / n),
      pctOver200: +(100 * over200 / n).toFixed(2),
      pctOver128: +(100 * over128 / n).toFixed(2),
      pctWarm: +(100 * warm / n).toFixed(2),
    };
  }, buf.toString('base64'));
}

// ---------------------------------------------------------------------------
// Contact sheet composition — a second page, an <img> grid, one screenshot.
// ---------------------------------------------------------------------------

async function composeSheet(browser, tiles, outPath, title) {
  const cols = 4;
  const rows = Math.ceil(tiles.length / cols);
  const cell = 380;
  const context = await browser.newContext({
    viewport: { width: cols * cell + 40, height: rows * (cell + 34) + 90 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const cells = tiles.map((t) => `
    <figure>
      <img src="data:image/png;base64,${t.b64}">
      <figcaption>${t.label}<span>${t.note || ''}</span></figcaption>
    </figure>`).join('');

  await page.setContent(`<!doctype html><meta charset="utf-8">
  <style>
    :root { color-scheme: dark; }
    body { margin:0; padding:16px 20px 24px; background:#111316; color:#e8e8ea;
           font:13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
    h1 { font-size:15px; margin:0 0 12px; letter-spacing:.06em; color:#9fd8ff; font-weight:600; }
    .grid { display:grid; grid-template-columns:repeat(${cols}, ${cell}px); gap:8px; }
    figure { margin:0; }
    img { display:block; width:${cell}px; height:${cell}px; image-rendering:auto;
          border:1px solid #2a2f36; }
    figcaption { padding:4px 2px 0; font-size:11px; color:#c8ccd2;
                 display:flex; justify-content:space-between; gap:8px; }
    figcaption span { color:#7d8792; }
  </style>
  <h1>${title}</h1>
  <div class="grid">${cells}</div>`, { waitUntil: 'load' });

  await page.waitForTimeout(300);
  await mkdir(path.dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, fullPage: true });
  await context.close();
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runLifetime(browser, effect) {
  const { context, page, errors } = await boot(browser);
  await enterMatch(page);

  let centre = { x: VP.width / 2, y: VP.height / 2 };
  let world = null;

  if (effect === 'explosion') {
    world = await igniteExplosion(page);
  } else if (effect === 'ko') {
    world = await page.evaluate(() => {
      const g = window.__game;
      const r = g.world.robos[1];
      const p = { x: r.pos.x, y: r.pos.y + 0.9, z: r.pos.z };
      g.view.vfx._ko({ winner: 0 }, g.world);
      return p;
    });
  } else if (effect === 'impact') {
    world = await page.evaluate(() => {
      const g = window.__game;
      const r = g.world.robos[1];
      const p = { x: r.pos.x, y: r.pos.y + 1.2, z: r.pos.z };
      g.view.vfx._hit({ x: p.x, y: p.y, z: p.z, nx: 0, ny: 1, nz: 0, heavy: true, surface: false });
      return p;
    });
  } else if (effect === 'tracer') {
    // Fire a charged lance round across the arena and follow it.
    world = await page.evaluate(() => {
      const g = window.__game;
      const a = g.world.robos[0];
      return { x: a.pos.x, y: a.pos.y + 1.2, z: a.pos.z };
    });
  }

  if (world) {
    const scr = await projectPoint(page, world);
    if (!scr.behind) centre = scr;
  }

  const ages = AGES[effect] || AGES.explosion;
  const tiles = [];
  let done = 0;

  for (const ms of ages) {
    const want = msToFrames(ms);
    await frames(page, want - done);
    done = want;

    const rect = cropRect(centre, ZOOM);
    const buf = await page.screenshot({ clip: rect, timeout: 180000 });
    const m = await analyze(page, buf);
    tiles.push({
      b64: buf.toString('base64'),
      label: `${ms}ms`,
      note: `max ${m.max} · >200 ${m.pctOver200}% · warm ${m.pctWarm}%`,
    });
    console.log(`  ${String(ms).padStart(5)}ms  frame+${String(want).padStart(3)}  ` +
      `max=${String(m.max).padStart(3)} mean=${String(m.mean).padStart(3)} ` +
      `>200=${String(m.pctOver200).padStart(6)}% >128=${String(m.pctOver128).padStart(6)}% warm=${m.pctWarm}%`);

    if (KEEP) {
      await mkdir('shots/frames', { recursive: true });
      await writeFile(`shots/frames/${effect}-${String(ms).padStart(4, '0')}ms.png`, buf);
    }
  }

  const stats = await page.evaluate(() => {
    const g = window.__game;
    return {
      drawCalls: g.engine.stats.drawCalls,
      tris: g.engine.stats.tris,
      tier: g.engine.quality.settings.name,
      fps: g.engine.stats.fps,
    };
  });

  // One wide frame at the effect's most violent moment, for staging context.
  await mkdir('shots', { recursive: true });
  const wide = await page.screenshot({ timeout: 180000 });
  await writeFile(`shots/sheet-${effect}-wide.png`, wide);

  await context.close();
  return { tiles, stats, errors };
}

/**
 * Luminance probe. The art director measured white DOM text at 255 on the title
 * screen and 111 in a match; this pins down which layer is eating it by planting
 * known-value probes and reading them back out of a real screenshot.
 */
async function runProbe(browser) {
  const { context, page, errors } = await boot(browser);

  const plant = () => page.evaluate(() => {
    let host = document.getElementById('__probe');
    if (!host) {
      host = document.createElement('div');
      host.id = '__probe';
      host.style.cssText =
        'position:fixed;left:0;top:0;z-index:2147483647;display:flex;pointer-events:none';
      for (const c of ['#ffffff', '#808080', '#000000']) {
        const d = document.createElement('div');
        d.style.cssText = `width:40px;height:40px;background:${c}`;
        host.appendChild(d);
      }
      // A second white swatch parked inside the HUD subtree, to separate "the
      // whole page is dim" from "the HUD's own container is dim".
      const hud = document.querySelector('.hud, #hud, [class*="hud"]');
      if (hud) {
        const d = document.createElement('div');
        d.id = '__probe2';
        d.style.cssText =
          'position:fixed;left:130px;top:0;width:40px;height:40px;background:#fff;z-index:2147483647;pointer-events:none';
        hud.appendChild(d);
      }
      document.body.appendChild(host);
    }
  });

  /** Read the planted swatches straight out of a real screenshot. */
  const swatches = async (buf) => page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const at = (x, y) => {
      const o = (y * bmp.width + x) * 4;
      return [d[o], d[o + 1], d[o + 2]];
    };
    const out = {
      'body #fff': at(20, 20),
      'body #808080': at(60, 20),
      'body #000': at(100, 20),
      'hud #fff': at(150, 20),
    };
    bmp.close();
    return out;
  }, buf.toString('base64'));

  const read = async (label) => {
    await plant();
    await frames(page, 2);
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 40 }, timeout: 180000 });
    const values = await swatches(buf);
    const px = await page.evaluate(() => {
      const info = [];
      const seen = new Set();
      const walk = (el) => {
        while (el && el !== document.documentElement) {
          if (!seen.has(el)) {
            seen.add(el);
            const cs = getComputedStyle(el);
            const notable = {};
            if (cs.opacity !== '1') notable.opacity = cs.opacity;
            if (cs.filter !== 'none') notable.filter = cs.filter;
            if (cs.backdropFilter && cs.backdropFilter !== 'none') notable.backdropFilter = cs.backdropFilter;
            if (cs.mixBlendMode !== 'normal') notable.mixBlendMode = cs.mixBlendMode;
            if (Object.keys(notable).length) {
              info.push({ el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${el.className}`, ...notable });
            }
          }
          el = el.parentElement;
        }
      };
      document.querySelectorAll('body *').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.opacity !== '1' || cs.filter !== 'none' ||
            (cs.backdropFilter && cs.backdropFilter !== 'none') || cs.mixBlendMode !== 'normal') {
          walk(el);
        }
      });
      // Full-viewport elements that could be sitting over everything.
      const overlays = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width >= window.innerWidth * 0.95 && r.height >= window.innerHeight * 0.95 &&
            cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.001) {
          overlays.push({
            el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).slice(0, 60)}`,
            bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 90),
            opacity: cs.opacity, z: cs.zIndex, blend: cs.mixBlendMode,
            filter: cs.filter, backdrop: cs.backdropFilter,
          });
        }
      }
      return { styles: info.slice(0, 20), overlays: overlays.slice(0, 20) };
    });
    return { label, buf, px, values };
  };

  const results = [];
  results.push(await read('title'));
  await enterMatch(page, 200);
  results.push(await read('match'));

  await mkdir('shots', { recursive: true });
  for (const r of results) {
    await writeFile(`shots/probe-${r.label}.png`, r.buf);
    console.log(`\n=== ${r.label} ===`);
    console.log(`swatch readback: ${JSON.stringify(r.values)}`);
    console.log('full-viewport elements:');
    for (const o of r.px.overlays) console.log(`  ${JSON.stringify(o)}`);
    console.log('elements with opacity/filter/blend:');
    for (const s of r.px.styles) console.log(`  ${JSON.stringify(s)}`);
  }

  await context.close();
  return { errors };
}

// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(PINNED) ? PINNED : undefined,
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio',
    ],
  });

  try {
    if (EFFECT === 'probe') {
      const { errors } = await runProbe(browser);
      if (errors.length) console.log(`\n⚠ ${errors.length} page error(s):\n  ${errors.slice(0, 6).join('\n  ')}`);
      return;
    }

    console.log(`contact sheet: ${EFFECT} @ tier ${TIER}, crop ${ZOOM}px`);
    const { tiles, stats, errors } = await runLifetime(browser, EFFECT);
    await composeSheet(browser, tiles, OUT,
      `${EFFECT.toUpperCase()} — one run, aged by rendered frames (1 frame = 16.7ms) — ${JSON.stringify(stats)}`);
    console.log(`\n✓ ${OUT}`);
    console.log(`  ${JSON.stringify(stats)}`);
    if (errors.length) console.log(`  ⚠ ${errors.length} page error(s):\n    ${errors.slice(0, 6).join('\n    ')}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
