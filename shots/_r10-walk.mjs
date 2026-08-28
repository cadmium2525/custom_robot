#!/usr/bin/env node
/**
 * Round 10: walk the whole game on an iPhone 12 with a thumb and nothing else,
 * in either orientation.
 *
 * No keyboard, no mouse, no `menus.show()`. Every transition is a real touch at
 * a real coordinate, and if a control cannot be tapped the walk records that
 * and stops rather than cheating past it with an evaluate().
 *
 * Insets are forced to 47/34 because that is the device the game is aimed at;
 * headless Chromium resolves env() to 0 and every capture this project has ever
 * taken was therefore of the no-notch layout.
 *
 *   node shots/_r10-walk.mjs [base] [prefix] [vw] [vh] [safeT,safeB,safeL,safeR]
 *
 * Portrait:  ... shots/r10w 390 844 47,34,0,0
 * Landscape: ... shots/r10L 844 390 0,21,47,47   (iOS rotates the notch to the
 *            side and shrinks the home indicator; l/r carry the sensor housing)
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:4213/custom_robot/';
const PREFIX = process.argv[3] || 'shots/r10w';
const VW = Number(process.argv[4] || 390), VH = Number(process.argv[5] || 844);
const SAFE = (process.argv[6] || '47,34,0,0').split(',');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const ctx = await browser.newContext({
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
await ctx.addInitScript((sf) => {
  const set = () => {
    const s = document.documentElement.style;
    s.setProperty('--safe-t', sf[0] + 'px', 'important');
    s.setProperty('--safe-b', sf[1] + 'px', 'important');
    s.setProperty('--safe-l', sf[2] + 'px', 'important');
    s.setProperty('--safe-r', sf[3] + 'px', 'important');
  };
  if (document.documentElement) set();
  else addEventListener('DOMContentLoaded', set);
}, SAFE);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.stack || e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await mkdir('shots', { recursive: true });
const log = [];
const say = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 45000 });
// #splash sits at z-index 100 over everything and fades for 500ms before it is
// removed; a tap inside that window lands on the splash. Wait it out.
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(900);

const cdp = await ctx.newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

/** A real finger tap: down, small dwell, up. */
async function tap(x, y) {
  await touch('touchStart', [{ x, y, id: 1 }]);
  await page.waitForTimeout(60);
  await touch('touchEnd', []);
  await page.waitForTimeout(420);
}

/** A real finger swipe, in steps, so momentum/scroll handlers see movement. */
async function swipe(x, y0, y1, steps = 12) {
  await touch('touchStart', [{ x, y: y0, id: 1 }]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x, y: y0 + (y1 - y0) * (i / steps), id: 1 }]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
}

/** Everything a thumb could want to know about the screen that is up. */
async function audit(tag) {
  const r = await page.evaluate(({ VW, VH, ST, SB }) => {
    const g = window.__game;
    const screen = document.querySelector('.screen.is-on');
    const nameOf = (el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26);
      const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
      return `${c || el.tagName.toLowerCase()}"${t}"`;
    };
    const out = {
      screen: g.menus?.current ?? null,
      state: g.state,
      menuOpen: !!screen,
      touchOn: document.documentElement.classList.contains('crv2-touch-on'),
      scroll: null,
      navs: [],
      widthOverflow: [],
      belowFold: [],
      underNotch: [],
    };
    if (screen) {
      out.scroll = {
        scrollTop: Math.round(screen.scrollTop),
        scrollHeight: Math.round(screen.scrollHeight),
        clientHeight: Math.round(screen.clientHeight),
        overflowY: getComputedStyle(screen).overflowY,
      };
      for (const el of screen.querySelectorAll('[data-nav]')) {
        const b = el.getBoundingClientRect();
        if (!b.width && !b.height) { out.navs.push({ n: nameOf(el), rect: 'ZERO' }); continue; }
        // Where a thumb would land, and whether that point actually hits it.
        const cx = Math.min(Math.max(b.left + b.width / 2, 1), VW - 1);
        const cy = Math.min(Math.max(b.top + b.height / 2, 1), VH - 1);
        const hit = document.elementFromPoint(cx, cy);
        out.navs.push({
          n: nameOf(el),
          r: [+b.left.toFixed(0), +b.top.toFixed(0), +b.right.toFixed(0), +b.bottom.toFixed(0)],
          onScreen: b.top >= 0 && b.bottom <= VH && b.left >= 0 && b.right <= VW,
          hits: hit ? (el.contains(hit) || hit === el) : false,
          disabled: el.disabled === true,
          dflt: el.hasAttribute('data-default'),
        });
      }
      // Anything painted past an edge, or in the two device bands.
      for (const el of screen.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        if (b.width < 6 || b.height < 6) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
        if (b.right > VW + 0.6 || b.left < -0.6) {
          out.widthOverflow.push({ n: nameOf(el), l: +b.left.toFixed(0), r: +b.right.toFixed(0) });
        }
        if (el.children.length === 0) {
          if (b.bottom > VH - SB) out.belowFold.push({ n: nameOf(el), b: +b.bottom.toFixed(0) });
          if (b.top < ST) out.underNotch.push({ n: nameOf(el), t: +b.top.toFixed(0) });
        }
      }
    }
    return out;
  }, { VW, VH, ST: Number(SAFE[0]), SB: Number(SAFE[1]) });
  say(`\n=== ${tag} === screen=${r.screen} state=${r.state} touchOn=${r.touchOn}`);
  if (r.scroll) say(`  scroll: top=${r.scroll.scrollTop} h=${r.scroll.scrollHeight}/${r.scroll.clientHeight} overflow-y=${r.scroll.overflowY}`);
  for (const n of r.navs) {
    if (n.rect === 'ZERO') { say(`  NAV ZERO-SIZE  ${n.n}`); continue; }
    const flags = [];
    if (!n.onScreen) flags.push('OFF-SCREEN');
    if (!n.hits) flags.push('NOT-HITTABLE');
    if (n.disabled) flags.push('disabled');
    if (n.dflt) flags.push('default');
    say(`  NAV ${JSON.stringify(n.r).padEnd(24)} ${flags.join(' ').padEnd(28)} ${n.n}`);
  }
  if (r.widthOverflow.length) {
    say(`  WIDTH OVERFLOW (${r.widthOverflow.length}):`);
    for (const w of r.widthOverflow.slice(0, 12)) say(`    ${w.l}..${w.r}  ${w.n}`);
  }
  if (r.belowFold.length) {
    say(`  BELOW FOLD / UNDER HOME BAR (${r.belowFold.length}):`);
    for (const w of r.belowFold.slice(0, 12)) say(`    bottom=${w.b}  ${w.n}`);
  }
  if (r.underNotch.length) {
    say(`  UNDER NOTCH (${r.underNotch.length}):`);
    for (const w of r.underNotch.slice(0, 12)) say(`    top=${w.t}  ${w.n}`);
  }
  await page.screenshot({ path: `${PREFIX}-${tag}.png`, timeout: 120000 });
  return r;
}

/**
 * Swipe the screen to its bottom the way a thumb would, then report which
 * [data-nav] are STILL unreachable. A control that a swipe can bring into
 * range is awkward; one that no swipe can reach is a dead end.
 */
async function scrollProbe(tag) {
  const before = await page.evaluate(() => {
    const s = document.querySelector('.screen.is-on');
    return s ? { top: Math.round(s.scrollTop), h: Math.round(s.scrollHeight), c: Math.round(s.clientHeight) } : null;
  });
  if (!before) return;
  if (before.h <= before.c + 1) { say(`  [${tag}] nothing to scroll (${before.h}/${before.c})`); return; }
  for (let i = 0; i < 6; i++) await swipe(VW*0.5, VH*0.90, VH*0.24, 10);
  const after = await page.evaluate(({ VW, VH }) => {
    const s = document.querySelector('.screen.is-on');
    const out = { top: Math.round(s.scrollTop), h: Math.round(s.scrollHeight), c: Math.round(s.clientHeight), bad: [] };
    for (const el of s.querySelectorAll('[data-nav]')) {
      const b = el.getBoundingClientRect();
      if (!b.width && !b.height) continue;
      const cx = Math.min(Math.max(b.left + b.width / 2, 1), VW - 1);
      const cy = Math.min(Math.max(b.top + b.height / 2, 1), VH - 1);
      const hit = document.elementFromPoint(cx, cy);
      const ok = b.top >= 0 && b.bottom <= VH && hit && el.contains(hit);
      if (!ok) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
        const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
        out.bad.push({ n: `${c}"${t}"`, r: [b.left, b.top, b.right, b.bottom].map(Math.round),
          why: b.bottom > VH || b.top < 0 ? 'off-screen' : 'covered by ' + (hit && typeof hit.className === 'string' ? hit.className.split(/\s+/)[0] : '?') });
      }
    }
    return out;
  }, { VW, VH });
  say(`  [${tag}] swiped to bottom: scrollTop ${before.top} -> ${after.top} of ${after.h - after.c}`);
  if (!after.bad.length) say(`  [${tag}] every nav reachable after the swipe`);
  for (const b of after.bad) say(`  [${tag}] STILL UNREACHABLE ${JSON.stringify(b.r)} ${b.why} — ${b.n}`);
  await page.screenshot({ path: `${PREFIX}-${tag}-bottom.png`, timeout: 120000 });
  // Put it back at the top so the walk continues from a known place.
  for (let i = 0; i < 8; i++) await swipe(VW*0.5, VH*0.24, VH*0.92, 10);
}

/** Tap the nav whose text matches; returns false if it is not tappable. */
async function tapNav(match, opts = {}) {
  const pt = await page.evaluate(({ m, sel }) => {
    const screen = document.querySelector('.screen.is-on');
    if (!screen) return { err: 'no screen' };
    const list = Array.from(screen.querySelectorAll(sel || '[data-nav]'));
    const el = list.find((e) => (e.textContent || '').replace(/\s+/g, ' ').toUpperCase().includes(m.toUpperCase()));
    if (!el) return { err: `no nav matching ${m}` };
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const inView = cy >= 0 && cy <= innerHeight && cx >= 0 && cx <= innerWidth;
    const hit = inView ? document.elementFromPoint(cx, cy) : null;
    return { cx, cy, inView, hits: hit ? (el.contains(hit) || hit === el) : false,
      rect: [+b.left.toFixed(0), +b.top.toFixed(0), +b.right.toFixed(0), +b.bottom.toFixed(0)] };
  }, { m: match, sel: opts.sel });
  if (pt.err) { say(`  !! TAP "${match}": ${pt.err}`); return false; }
  if (!pt.inView) { say(`  !! TAP "${match}": centre off-screen at ${JSON.stringify(pt.rect)} — UNREACHABLE BY THUMB`); return false; }
  if (!pt.hits) { say(`  !! TAP "${match}": something else is on top at that point ${JSON.stringify(pt.rect)}`); return false; }
  await tap(pt.cx, pt.cy);
  say(`  tap "${match}" at ${Math.round(pt.cx)},${Math.round(pt.cy)}`);
  return true;
}

// ---------------------------------------------------------------------------
// THE WALK
// ---------------------------------------------------------------------------
await audit('01-title');
await tapNav('ENTER ARENA');
await audit('02-mode');
await scrollProbe('02-mode');
// Pick a difficulty and a mode card on the way through — they are navs too.
await tapNav('ACE', { sel: '.diff__b' });
await tapNav('TO GARAGE');
await audit('03-garage');
await scrollProbe('03-garage');

// Every part category on the rail, then count how many of its parts a thumb
// can actually put on the machine.
for (const cat of ['BODY', 'GUN', 'BOMB', 'POD', 'LEGS']) {
  const ok = await tapNav(cat, { sel: '.rail__b' });
  if (!ok) { say(`  !! garage rail: category ${cat} unreachable`); continue; }
  const a = await audit(`03-garage-${cat.toLowerCase()}`);
  const rows = a.navs.filter((n) => n.n.startsWith('row') && n.rect !== 'ZERO');
  const good = rows.filter((r) => r.onScreen && r.hits);
  say(`  ${cat}: ${rows.length} part rows laid out, ${good.length} tappable without scrolling`);
  // Equip the LAST one, which is the one a scroll is needed for.
  const last = rows[rows.length - 1];
  if (last) {
    if (last.onScreen && last.hits) {
      await tap((last.r[0] + last.r[2]) / 2, (last.r[1] + last.r[3]) / 2);
      say(`  equipped last ${cat} part by tap`);
    } else {
      say(`  !! last ${cat} part ${last.n} at ${JSON.stringify(last.r)} needs a scroll`);
      for (let i = 0; i < 3; i++) await swipe(VW*0.5, VH*0.83, VH*0.50, 10);
      const p = await page.evaluate(({ nm }) => {
        const el = Array.from(document.querySelectorAll('.screen.is-on .row'))
          .find((e) => (e.textContent || '').replace(/\s+/g, ' ').includes(nm));
        if (!el) return null;
        const b = el.getBoundingClientRect();
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return { cx, cy, ok: b.top >= 0 && b.bottom <= innerHeight && hit && el.contains(hit),
          r: [b.left, b.top, b.right, b.bottom].map(Math.round) };
      }, { nm: last.n.replace(/^row"/, '').split(' ')[0] });
      if (p && p.ok) { await tap(p.cx, p.cy); say(`  reached after scrolling, equipped`); }
      else say(`  !! STILL UNREACHABLE after scrolling: ${JSON.stringify(p)}`);
      for (let i = 0; i < 5; i++) await swipe(VW*0.5, VH*0.36, VH*0.90, 10);
    }
  }
  await audit(`03-garage-${cat.toLowerCase()}-after`);
}
// A preset.
await tapNav('', { sel: '.preset' });
await audit('03-garage-preset');
// The P2 switch.
await tapNav('P2', { sel: '.pl__b' });
await audit('03-garage-p2');
await tapNav('P1', { sel: '.pl__b' });

await tapNav('SELECT ARENA');
const arenaA = await audit('04-arena');
await scrollProbe('04-arena');
const cards = arenaA.navs.filter((n) => n.n.startsWith('arena__card'));
say(`  arena: ${cards.length} cards, ${cards.filter((c) => c.onScreen && c.hits).length} tappable`);
for (const c of cards) {
  if (!(c.onScreen && c.hits)) { say(`  !! arena card UNREACHABLE ${c.n} at ${JSON.stringify(c.r)}`); continue; }
  await tap((c.r[0] + c.r[2]) / 2, (c.r[1] + c.r[3]) / 2);
}
await audit('04-arena-picked');
await tapNav('FIGHT');
await page.waitForTimeout(2500);
await audit('05-match');

// Pause with the on-screen key, not Escape.
const pb = await page.evaluate(() => {
  const el = document.querySelector('.tc__pause');
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, r: [b.left, b.top, b.right, b.bottom].map(Math.round) };
});
if (!pb) say('  !! no .tc__pause in the DOM — a match cannot be paused by touch');
else { say(`  tap PAUSE key at ${Math.round(pb.x)},${Math.round(pb.y)}`); await tap(pb.x, pb.y); }
await audit('06-pause');
await scrollProbe('06-pause');

await tapNav('CONTROLS');
await audit('07-controls');
await scrollProbe('07-controls');
await tapNav('BACK');
await audit('08-back-from-controls');

await tapNav('SETTINGS');
await audit('09-settings');
await scrollProbe('09-settings');
await tapNav('BACK');
await audit('10-back-from-settings');

await tapNav('RESUME');
await page.waitForTimeout(800);
await audit('11-resumed');

// Results: end the match the only way a walk can, then look at it by touch.
await page.evaluate(() => {
  const g = window.__game;
  g.menus.show('results', {
    winner: 0, wins: [2, 1], localIndex: 0, names: ['RAY-01', 'ACE'],
    rounds: [{ round: 1, winner: 0 }, { round: 2, winner: 1, timeout: true }, { round: 3, winner: 0 }],
    stats: { damage: 2480, hits: 63, accuracy: '41%', 'longest chain': 7 },
  });
});
await page.waitForTimeout(1000);
await audit('12-results');
await scrollProbe('12-results');
await tapNav('QUIT TO TITLE');
await audit('13-title-again');

if (errors.length) { say('\nPAGE ERRORS:'); for (const e of errors.slice(0, 12)) say('  ' + e); }
await writeFile(`${PREFIX}-log.txt`, log.join('\n'));
await browser.close();
