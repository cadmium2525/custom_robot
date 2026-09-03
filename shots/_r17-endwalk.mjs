#!/usr/bin/env node
/**
 * THE END-OF-MATCH WALK — the screens nobody had ever reached on a phone.
 *
 * Round 16 confirmed the game is finishable (grid 5684 ticks, foundry 4662,
 * orbital 7138) but every phone walk in this repo stops at `05-match`, because
 * until now nothing could drive a match to completion inside a capture. So the
 * round-transition banners, the K.O. / TIME UP card, the VICTORY / DEFEAT card
 * and the entire results screen — verdict, score, round chips, stat strip and
 * the three actions on it — have never been looked at on an iPhone 12, in
 * either orientation, by anything.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT TAKE FORTY-SEVEN MINUTES
 * ---------------------------------------------------------------------------
 * `shots/r16p-log.txt` measures the real rate on this renderer: 146 sim ticks
 * in 72s of wall clock, i.e. ~2 ticks/s, because swiftshader is drawing
 * 1170x2532 and the fixed step is gated behind the render loop. A 5684-tick
 * match is therefore ~47 minutes of wall clock PER ORIENTATION, which is why
 * nobody has ever seen these screens.
 *
 * `Game.fastForward(n)` (src/main.js) already exists for exactly this: it calls
 * `_fixedStep()` in a loop with no render between steps, so the sim advances at
 * memory speed and every event, banner, phase change and `endMatch()` fires
 * through the normal path. This walk therefore runs a REAL match — real AI on
 * both sides via `setDemo(true)`, real damage, real round wins, whatever
 * outcome that produces — and only takes the render out of the inner loop.
 *
 * It is stepped in SMALL CHUNKS (`--chunk`, default 24 ticks) rather than one
 * call, because a banner that goes up and comes down inside one call is a
 * banner nobody photographs. After each chunk the page is given a real frame to
 * paint, the overlay state is sampled, and any CHANGE of banner text is
 * screenshotted and audited.
 *
 * Everything that is a UI ACTION is still a real finger through CDP
 * `Input.dispatchTouchEvent` at a real coordinate: ENTER ARENA, TO GARAGE,
 * SELECT ARENA, FIGHT, and then REMATCH / GARAGE / QUIT TO TITLE on the results
 * screen itself. No `menus.show()`, no keyboard, no synthetic clicks.
 *
 *   node shots/_r17-endwalk.mjs [base] [prefix] [vw] [vh] [t,b,l,r]
 *                               [--chunk n] [--ceil ms] [--arena name]
 *
 * Portrait:  ... shots/_r17/eP 390 844 47,34,0,0
 * Landscape: ... shots/_r17/eL 844 390 0,21,47,47
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const CHUNK = Number(flag('chunk', 24));
const CEIL = Number(flag('ceil', 420000));
const ARENA = flag('arena', '');
const BASE = argv[0] || 'http://127.0.0.1:4311/custom_robot/';
const PREFIX = argv[1] || 'shots/_r17/eP';
const VW = Number(argv[2] || 390), VH = Number(argv[3] || 844);
const SAFE = (argv[4] || '47,34,0,0').split(',').map(Number);

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
await mkdir(PREFIX.replace(/\/[^/]*$/, ''), { recursive: true });
const log = [];
const errors = [];
const say = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
page.on('pageerror', (e) => { const s = String((e && e.stack) || e).split('\n')[0]; errors.push(s); say('  PAGEERROR ' + s); });
page.on('console', (m) => { if (m.type() === 'error') { errors.push('console: ' + m.text()); say('  CONSOLE-ERROR ' + m.text()); } });

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__game.engine && window.__game.engine.running, null, { timeout: 60000 });
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(900);

const cdp = await ctx.newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
async function tap(x, y) {
  await touch('touchStart', [{ x, y, id: 1 }]);
  await page.waitForTimeout(60);
  await touch('touchEnd', []);
  await page.waitForTimeout(420);
}
async function swipe(x, y0, y1, steps = 12) {
  await touch('touchStart', [{ x, y: y0, id: 1 }]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x, y: y0 + ((y1 - y0) * i) / steps, id: 1 }]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(320);
}

/** Tap a [data-nav] by its text. Refuses to cheat past an unreachable one. */
async function tapNav(match, sel) {
  const pt = await page.evaluate(({ m, s }) => {
    const screen = document.querySelector('.screen.is-on');
    if (!screen) return { err: 'no screen up' };
    const el = Array.from(screen.querySelectorAll(s || '[data-nav]'))
      .find((e) => (e.textContent || '').replace(/\s+/g, ' ').toUpperCase().includes(m.toUpperCase()));
    if (!el) return { err: 'no nav matching ' + m };
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const rect = [b.left, b.top, b.right, b.bottom].map(Math.round);
    if (cy < 0 || cy > innerHeight || cx < 0 || cx > innerWidth) return { err: '"' + m + '" off-screen at ' + JSON.stringify(rect) };
    const hit = document.elementFromPoint(cx, cy);
    if (!(hit && (el.contains(hit) || hit === el))) {
      const on = hit && typeof hit.className === 'string' ? hit.className.split(/\s+/)[0] : '?';
      return { err: '"' + m + '" covered by ' + on + ' at ' + JSON.stringify(rect) };
    }
    return { cx, cy, rect };
  }, { m: match, s: sel });
  if (pt.err) { say('  !! TAP ' + pt.err); return false; }
  await tap(pt.cx, pt.cy);
  say('  tap "' + match + '" at ' + Math.round(pt.cx) + ',' + Math.round(pt.cy) + '  rect=' + JSON.stringify(pt.rect));
  return true;
}

/** Everything the end-of-match surfaces can be wrong about, in one sample. */
const PROBE = () => {
  const g = window.__game;
  const w = g.world;
  const vis = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.02) return null;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return null;
    return { r: [b.left, b.top, b.right, b.bottom].map(Math.round), op: +(+cs.opacity).toFixed(2) };
  };
  const ban = document.querySelector('.hud__banner');
  const banOn = ban && ban.classList.contains('is-on') ? ban : null;
  return {
    state: g.state,
    screen: g.menus ? g.menus.current : null,
    phase: w ? w.phase : -1,
    tick: w ? w.tick : -1,
    round: w ? w.round : -1,
    wins: w ? [w.wins[0], w.wins[1]] : null,
    banner: banOn ? {
      main: (document.querySelector('.banner__main').textContent || '').trim(),
      sub: (document.querySelector('.banner__sub').textContent || '').trim(),
      cls: Array.from(banOn.classList).filter((c) => c.indexOf('is-') === 0 && c !== 'is-on').join(' '),
      box: vis(document.querySelector('.banner__main')),
    } : null,
    padUp: !!vis(document.querySelector('.crv2-touch .tc__pad')),
    pauseUp: !!vis(document.querySelector('.tc__pause')),
    touchOn: document.documentElement.classList.contains('crv2-touch-on'),
    splash: !!document.getElementById('splash'),
  };
};

/** Does the banner's headline overlap anything a thumb owns? */
const CLASHES = ({ VW, VH, ST, SB, SL, SR }) => {
  const out = [];
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.02) return null;
    const b = el.getBoundingClientRect();
    return b.width > 1 && b.height > 1 ? b : null;
  };
  const main = box('.banner__main');
  if (main) {
    if (main.left < SL - 0.6 || main.right > VW - SR + 0.6) {
      out.push('banner__main ' + Math.round(main.left) + '..' + Math.round(main.right) + ' breaks the ' + SL + '/' + SR + ' side insets on a ' + VW + 'px frame');
    }
    if (main.top < ST - 0.6) out.push('banner__main top=' + Math.round(main.top) + ' is under the ' + ST + 'px notch');
    if (main.bottom > VH - SB + 0.6) out.push('banner__main bottom=' + Math.round(main.bottom) + ' is under the ' + SB + 'px home bar');
    const others = ['.tb--fire', '.tb--bomb', '.tb--pod', '.tb--jump', '.tb--dash', '.tc__pause', '.hud__top', '.hud__gear'];
    for (const sel of others) {
      const b = box(sel);
      if (!b) continue;
      const ox = Math.min(main.right, b.right) - Math.max(main.left, b.left);
      const oy = Math.min(main.bottom, b.bottom) - Math.max(main.top, b.top);
      if (ox > 2 && oy > 2) out.push('banner__main overlaps ' + sel + ' by ' + Math.round(ox) + 'x' + Math.round(oy) + 'px');
    }
  }
  return out;
};

/** The full screen audit, reused from the round-10 walk. */
async function audit(tag) {
  const r = await page.evaluate(({ VW, VH, ST, SB, SL, SR }) => {
    const g = window.__game;
    const screen = document.querySelector('.screen.is-on');
    const nameOf = (el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26);
      const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
      return (c || el.tagName.toLowerCase()) + '"' + t + '"';
    };
    const out = {
      screen: g.menus ? g.menus.current : null,
      state: g.state,
      menuOpen: !!screen,
      touchOn: document.documentElement.classList.contains('crv2-touch-on'),
      scroll: null, navs: [], widthOverflow: [], belowFold: [], underNotch: [], empties: [],
    };
    if (!screen) return out;
    out.scroll = {
      scrollTop: Math.round(screen.scrollTop),
      scrollHeight: Math.round(screen.scrollHeight),
      clientHeight: Math.round(screen.clientHeight),
      overflowY: getComputedStyle(screen).overflowY,
    };
    for (const el of screen.querySelectorAll('[data-nav]')) {
      const b = el.getBoundingClientRect();
      if (!b.width && !b.height) { out.navs.push({ n: nameOf(el), rect: 'ZERO' }); continue; }
      const cx = Math.min(Math.max(b.left + b.width / 2, 1), VW - 1);
      const cy = Math.min(Math.max(b.top + b.height / 2, 1), VH - 1);
      const hit = document.elementFromPoint(cx, cy);
      out.navs.push({
        n: nameOf(el),
        r: [b.left, b.top, b.right, b.bottom].map((v) => +v.toFixed(0)),
        onScreen: b.top >= 0 && b.bottom <= VH && b.left >= 0 && b.right <= VW,
        hits: hit ? (el.contains(hit) || hit === el) : false,
        dflt: el.hasAttribute('data-default'),
        // Apple's 44pt minimum, in CSS px.
        small: b.width < 44 || b.height < 44,
      });
    }
    for (const el of screen.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      // A container with no ink but real margins is dead space nobody sees and
      // everybody pays for; on a 390px-tall landscape frame it is the whole
      // budget. Report it separately from overflow.
      if (b.height <= 1 && el.children.length === 0 && !(el.textContent || '').trim()) {
        const mt = parseFloat(cs.marginTop) || 0, mb = parseFloat(cs.marginBottom) || 0;
        if (mt + mb >= 8) out.empties.push({ n: nameOf(el), m: Math.round(mt + mb) });
        continue;
      }
      if (b.width < 6 || b.height < 6) continue;
      if (b.right > VW - SR + 0.6 || b.left < SL - 0.6) {
        out.widthOverflow.push({ n: nameOf(el), l: +b.left.toFixed(0), r: +b.right.toFixed(0) });
      }
      if (el.children.length === 0) {
        if (b.bottom > VH - SB) out.belowFold.push({ n: nameOf(el), b: +b.bottom.toFixed(0) });
        if (b.top < ST) out.underNotch.push({ n: nameOf(el), t: +b.top.toFixed(0) });
      }
    }
    return out;
  }, { VW, VH, ST: SAFE[0], SB: SAFE[1], SL: SAFE[2], SR: SAFE[3] });

  say('\n=== ' + tag + ' === screen=' + r.screen + ' state=' + r.state + ' touchOn=' + r.touchOn);
  if (r.scroll) say('  scroll: top=' + r.scroll.scrollTop + ' h=' + r.scroll.scrollHeight + '/' + r.scroll.clientHeight + ' overflow-y=' + r.scroll.overflowY);
  for (const n of r.navs) {
    if (n.rect === 'ZERO') { say('  NAV ZERO-SIZE  ' + n.n); continue; }
    const flags = [];
    if (!n.onScreen) flags.push('OFF-SCREEN');
    if (!n.hits) flags.push('NOT-HITTABLE');
    if (n.small) flags.push('UNDER-44pt');
    if (n.dflt) flags.push('default');
    say('  NAV ' + JSON.stringify(n.r).padEnd(24) + ' ' + flags.join(' ').padEnd(30) + ' ' + n.n);
  }
  for (const e of r.empties) say('  EMPTY BOX with ' + e.m + 'px of margin — ' + e.n);
  if (r.widthOverflow.length) {
    say('  OUTSIDE THE SIDE INSETS (' + r.widthOverflow.length + '):');
    for (const w of r.widthOverflow.slice(0, 10)) say('    ' + w.l + '..' + w.r + '  ' + w.n);
  }
  if (r.belowFold.length) {
    say('  BELOW FOLD / UNDER HOME BAR (' + r.belowFold.length + '):');
    for (const w of r.belowFold.slice(0, 10)) say('    bottom=' + w.b + '  ' + w.n);
  }
  if (r.underNotch.length) {
    say('  UNDER NOTCH (' + r.underNotch.length + '):');
    for (const w of r.underNotch.slice(0, 10)) say('    top=' + w.t + '  ' + w.n);
  }
  await page.screenshot({ path: PREFIX + '-' + tag + '.png', timeout: 120000 });
  return r;
}

async function scrollProbe(tag) {
  const before = await page.evaluate(() => {
    const s = document.querySelector('.screen.is-on');
    return s ? { top: Math.round(s.scrollTop), h: Math.round(s.scrollHeight), c: Math.round(s.clientHeight) } : null;
  });
  if (!before) return;
  if (before.h <= before.c + 1) { say('  [' + tag + '] nothing to scroll (' + before.h + '/' + before.c + ')'); return; }
  for (let i = 0; i < 6; i++) await swipe(VW * 0.5, VH * 0.9, VH * 0.24, 10);
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
        out.bad.push({ n: t, r: [b.left, b.top, b.right, b.bottom].map(Math.round) });
      }
    }
    return out;
  }, { VW, VH });
  say('  [' + tag + '] swiped to bottom: scrollTop ' + before.top + ' -> ' + after.top + ' of ' + (after.h - after.c));
  if (!after.bad.length) say('  [' + tag + '] every nav reachable after the swipe');
  for (const b of after.bad) say('  [' + tag + '] STILL UNREACHABLE ' + JSON.stringify(b.r) + ' — ' + b.n);
  await page.screenshot({ path: PREFIX + '-' + tag + '-bottom.png', timeout: 120000 });
  for (let i = 0; i < 8; i++) await swipe(VW * 0.5, VH * 0.24, VH * 0.92, 10);
}

/**
 * Run the live match to its end, photographing every banner the sim raises.
 * Returns the sequence of banners seen.
 */
async function runMatch(tag) {
  const seen = [];
  let last = null, shots = 0;
  const t0 = Date.now();
  // Hand the local machine to the AI as well, so this is a fight rather than a
  // stationary target: the round outcomes below are the sim's, not the
  // harness's.
  await page.evaluate(() => { window.__game.setDemo(true, 'ace'); });
  while (Date.now() - t0 < CEIL) {
    const s = await page.evaluate((n) => {
      const g = window.__game;
      if (g.state === 'match') g.fastForward(n);
      return null;
    }, CHUNK).then(() => page.evaluate(PROBE));
    if (s.state !== 'match') { say('  match over after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's — state=' + s.state + ' screen=' + s.screen); return seen; }
    const key = s.banner ? s.banner.main + '/' + s.banner.sub + '/' + s.banner.cls : '';
    if (key !== last) {
      last = key;
      if (s.banner) {
        // Let the .5s bannerIn land and give swiftshader a frame to paint it.
        await page.waitForTimeout(700);
        const now = await page.evaluate(PROBE);
        const clash = await page.evaluate(CLASHES,
          { VW, VH, ST: SAFE[0], SB: SAFE[1], SL: SAFE[2], SR: SAFE[3] }).catch(() => []);
        const slug = (s.banner.main + '-' + s.banner.sub).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'card';
        const name = tag + '-b' + (++shots) + '-' + slug;
        await page.screenshot({ path: PREFIX + '-' + name + '.png', timeout: 120000 });
        say('  BANNER "' + s.banner.main + '" / "' + s.banner.sub + '" [' + s.banner.cls + ']' +
          '  round=' + s.round + ' wins=' + JSON.stringify(s.wins) + ' phase=' + s.phase + ' tick=' + s.tick +
          '  box=' + JSON.stringify(s.banner.box ? s.banner.box.r : null) +
          '  padUp=' + now.padUp + ' pauseUp=' + now.pauseUp + '  -> ' + name + '.png');
        for (const c of clash) say('    !! ' + c);
        seen.push({ main: s.banner.main, sub: s.banner.sub, cls: s.banner.cls, round: s.round, wins: s.wins, clash });
      }
    }
  }
  say('  !! match did not finish inside ' + CEIL + 'ms');
  return seen;
}

/** The results screen has three actions and nobody has ever pressed any. */
async function resultsAudit(tag) {
  const r = await audit(tag);
  await scrollProbe(tag + '-scroll');
  const extra = await page.evaluate(() => {
    const s = document.querySelector('.screen.is-on');
    const g = (sel) => {
      const el = s ? s.querySelector(sel) : null;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { r: [b.left, b.top, b.right, b.bottom].map(Math.round), h: Math.round(b.height),
        t: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        m: Math.round((parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)),
        kids: el.children.length };
    };
    return {
      verdict: g('.res__verdict'),
      dataVerdict: s ? s.dataset.verdict : null,
      cls: s ? s.className : null,
      score: g('.res__score'),
      rounds: g('.res__rounds'),
      stats: g('.res__stats'),
      actions: g('.res__actions'),
      chips: Array.from(s ? s.querySelectorAll('.rchip') : []).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()),
      padHidden: (() => {
        const t = document.querySelector('.crv2-touch');
        return !t || t.classList.contains('is-hidden') || getComputedStyle(t).display === 'none';
      })(),
    };
  });
  say('  results: verdict=' + JSON.stringify(extra.verdict) + ' data-verdict=' + extra.dataVerdict);
  say('  results: score=' + JSON.stringify(extra.score));
  say('  results: rounds=' + JSON.stringify(extra.rounds) + ' chips=' + JSON.stringify(extra.chips));
  say('  results: stats=' + JSON.stringify(extra.stats));
  say('  results: actions=' + JSON.stringify(extra.actions));
  say('  results: touch pad hidden = ' + extra.padHidden);
  return { r, extra };
}

// ---------------------------------------------------------------------------
// THE WALK
// ---------------------------------------------------------------------------
say('\nEND-OF-MATCH WALK — ' + VW + 'x' + VH + '@3x  insets ' + SAFE.join('/') + '  chunk=' + CHUNK);

async function intoMatch(tag) {
  if (!(await tapNav('ENTER ARENA'))) return false;
  if (!(await tapNav('TO GARAGE'))) return false;
  if (!(await tapNav('SELECT ARENA'))) return false;
  if (ARENA) await tapNav(ARENA, '.arena__card');
  if (!(await tapNav('FIGHT'))) return false;
  await page.waitForFunction(() => window.__game.state === 'match', null, { timeout: 60000 });
  say('  [' + tag + '] in a match');
  return true;
}

if (!(await intoMatch('m1'))) { say('  !! could not reach a match by touch'); await writeFile(PREFIX + '-log.txt', log.join('\n')); await browser.close(); process.exit(1); }

// --- MATCH 1: every transition card, then the results screen ---------------
const seq1 = await runMatch('m1');
await page.waitForTimeout(700);
const res1 = await resultsAudit('r1-results');

// --- REMATCH, by thumb -----------------------------------------------------
const preRound = await page.evaluate(PROBE);
if (await tapNav('REMATCH')) {
  const ok = await page.waitForFunction(() => window.__game.state === 'match', null, { timeout: 60000 })
    .then(() => true, () => false);
  const s = await page.evaluate(PROBE);
  say('  REMATCH -> state=' + s.state + ' screen=' + s.screen + ' round=' + s.round + ' wins=' + JSON.stringify(s.wins) + ' padUp=' + s.padUp + '  (started=' + ok + ')');
  if (!ok) say('  !! REMATCH did not start a match');
  await page.screenshot({ path: PREFIX + '-r2-rematch.png', timeout: 120000 });
} else {
  say('  !! REMATCH not tappable');
}

// --- MATCH 2 to its end, then GARAGE off the results screen ----------------
const seq2 = await runMatch('m2');
await page.waitForTimeout(700);
await audit('r3-results-again');
if (await tapNav('GARAGE')) {
  const s = await page.evaluate(PROBE);
  say('  GARAGE -> state=' + s.state + ' screen=' + s.screen);
  await page.screenshot({ path: PREFIX + '-r4-garage.png', timeout: 120000 });
  // and back out of the garage the way a thumb would
  if (!(await tapNav('BACK'))) await tapNav('TITLE');
  const b = await page.evaluate(PROBE);
  say('  back from garage -> screen=' + b.screen);
}

// --- MATCH 3 to its end, then QUIT TO TITLE --------------------------------
const s3 = await page.evaluate(PROBE);
if (s3.screen !== 'title') {
  say('  (walking back to the title to start the third match; at ' + s3.screen + ')');
  for (let i = 0; i < 4; i++) {
    const cur = await page.evaluate(PROBE);
    if (cur.screen === 'title') break;
    if (!(await tapNav('BACK')) && !(await tapNav('TITLE'))) break;
  }
}
const s3b = await page.evaluate(PROBE);
say('  at ' + s3b.screen + ' before match 3');
if (s3b.screen === 'title' ? await intoMatch('m3') : false) {
  await runMatch('m3');
  await page.waitForTimeout(700);
  await audit('r5-results-third');
  if (await tapNav('QUIT TO TITLE')) {
    const s = await page.evaluate(PROBE);
    say('  QUIT TO TITLE -> state=' + s.state + ' screen=' + s.screen);
    await page.screenshot({ path: PREFIX + '-r6-title.png', timeout: 120000 });
  } else {
    say('  !! QUIT TO TITLE not tappable');
  }
}

say('\nBANNER SEQUENCE (match 1): ' + JSON.stringify(seq1.map((b) => b.main + '/' + b.sub)));
say('BANNER SEQUENCE (match 2): ' + JSON.stringify(seq2.map((b) => b.main + '/' + b.sub)));
say('page errors: ' + (errors.length ? JSON.stringify(errors.slice(0, 6)) : 'none'));
await writeFile(PREFIX + '-log.txt', log.join('\n'));
await browser.close();
