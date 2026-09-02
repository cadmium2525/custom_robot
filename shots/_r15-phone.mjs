#!/usr/bin/env node
/**
 * THE CARD-FREE PHONE GAMEPLAY CAPTURE.
 *
 * Asked for in rounds 12, 13 and 14; not delivered once, which is why the phone
 * half of blind point 1 is UNSCORED rather than failed. This file exists so it
 * stops being a manual errand.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY PREVIOUS PHONE CAPTURE HAD A CARD IN IT
 * ---------------------------------------------------------------------------
 * Nothing structural. It is a race that every phone harness in this repo lost
 * the same way:
 *
 *   `Game.startMatch()` calls `hud.showBanner('ROUND 1', 'READY')` on the same
 *   turn it flips `state = 'match'`. The banner is only taken down by
 *   `EV.ROUND_START` with `go` set — the sim's INTRO phase runs for
 *   `MATCH.introTicks` and then the FIGHT banner replaces it for a further
 *   900ms on a `setTimeout`. So from the tap on FIGHT there is a window of
 *   roughly (introTicks/60 + 0.9)s in which the frame is a full-bleed title
 *   card over a stationary arena.
 *
 *   `_r10-walk.mjs` shoots `05-match` after `waitForTimeout(2500)`, and
 *   `_hudinset.mjs`/the `hi-*` pair shoot on a fixed dwell too. Both dwells are
 *   inside that window. The captures are not of gameplay; they are of the
 *   ROUND 1 card, over an arena the card's own presence keeps still.
 *
 * The fix is to wait on the STATE, never on a clock: phase == FIGHT, no
 * `.hud__banner.is-on`, no `.screen.is-on`, no `#splash`, and the sim's tick
 * actually advancing between two samples. All five are asserted below and
 * printed, so a future capture that regresses says which one it lost.
 *
 * ---------------------------------------------------------------------------
 * AND WHY *THIS* FILE ALSO FAILED THE FIRST TIME IT RAN  (round 16)
 * ---------------------------------------------------------------------------
 * Waiting on the state is necessary and was not sufficient. The first version
 * of this loop polled the state with `page.evaluate` every 120ms and gave up
 * after 31s with `phase=0 tick=83 stalled=true`, i.e. the sim had advanced 83
 * of the 150 `T.roundIntro` ticks it needs to reach FIGHT, in 38 seconds.
 *
 * That is the harness starving the page, not the game hanging. Under
 * swiftshader at 390x844@3x this build renders the match at ~5 fps with
 * MAX_STEPS_PER_FRAME=5, so sim time advances at roughly a TENTH of wall clock
 * — INTRO alone takes ~18s of wall clock — and every `page.evaluate` is a
 * cross-process round trip that must land on the same main thread the render
 * loop is on. Eight of those a second turned ~18s into never.
 *
 * So the state watcher runs IN THE PAGE (`setInterval`, one thread, no IPC),
 * this side only does a `waitForFunction` on a flag at 400ms, and every dwell
 * after the FIGHT banner lifts is counted in SIM TICKS rather than in
 * milliseconds — 2.6s of wall clock is ~15 ticks here, which is not a fight,
 * it is a flinch. `--settle` ticks, default 110, is the real dwell.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PRODUCES
 * ---------------------------------------------------------------------------
 *   <prefix>-match.png    the frame, at 390x844@3x (or 844x390@3x)
 *   <prefix>-rects.txt    every touch/HUD rect in DEVICE pixels, ready to paste
 *                         into shots/_framesal.mjs --rect, so the salience
 *                         measurement is taken on measured geometry rather than
 *                         on numbers typed from a log.
 *
 * Everything before the capture is a real finger: no menus.show(), no keyboard.
 *
 *   node shots/_r15-phone.mjs <base> <prefix> <vw> <vh> <t,b,l,r> [arena]
 *                            [--settle ticks] [--ceil ms]
 *
 * Portrait:  ... http://127.0.0.1:4300/custom_robot/ shots/r15p 390 844 47,34,0,0
 * Landscape: ... http://127.0.0.1:4300/custom_robot/ shots/r15L 844 390 0,21,47,47
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
/** Dwell after the FIGHT card lifts, in SIM TICKS. 110 ~= 1.8s of sim time. */
const SETTLE = Number(flag('settle', 110));
/** Wall-clock ceiling. INTRO alone is ~18s here; a fight dwell is ~20s more. */
const CEIL = Number(flag('ceil', 150000));
const BASE = argv[0] || 'http://127.0.0.1:4300/custom_robot/';
const PREFIX = argv[1] || 'shots/r15p';
const VW = Number(argv[2] || 390), VH = Number(argv[3] || 844);
const SAFE = (argv[4] || '47,34,0,0').split(',');
const ARENA = argv[5] || '';

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
const log = [];
const say = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
page.on('pageerror', (e) => say('  PAGEERROR ' + String(e && e.stack || e).split('\n')[0]));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 60000 });
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
async function tapNav(match, sel) {
  const pt = await page.evaluate(({ m, s }) => {
    const screen = document.querySelector('.screen.is-on');
    if (!screen) return { err: 'no screen up' };
    const el = Array.from(screen.querySelectorAll(s || '[data-nav]'))
      .find((e) => (e.textContent || '').replace(/\s+/g, ' ').toUpperCase().includes(m.toUpperCase()));
    if (!el) return { err: `no nav matching ${m}` };
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    if (cy < 0 || cy > innerHeight || cx < 0 || cx > innerWidth) return { err: `"${m}" off-screen` };
    const hit = document.elementFromPoint(cx, cy);
    if (!(hit && (el.contains(hit) || hit === el))) return { err: `"${m}" covered` };
    return { cx, cy };
  }, { m: match, s: sel });
  if (pt.err) { say(`  !! TAP ${pt.err}`); return false; }
  await tap(pt.cx, pt.cy);
  say(`  tap "${match}" at ${Math.round(pt.cx)},${Math.round(pt.cy)}`);
  return true;
}

/** Everything that can put a card over the arena, sampled in one go. */
const OVERLAYS = () => {
  const g = window.__game;
  const seen = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.02) return null;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return null;
    return { sel, op: +(+cs.opacity).toFixed(2), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28) };
  };
  return {
    state: g.state,
    phase: g.world ? g.world.phase : -1,
    tick: g.world ? g.world.tick : -1,
    round: g.world ? g.world.round : -1,
    splash: !!document.getElementById('splash'),
    cards: [
      seen('.hud__banner.is-on'), seen('.screen.is-on'), seen('.hud__net.is-on'),
      seen('.hud__debug.is-on'), seen('.hud__combo.is-on'),
    ].filter(Boolean),
    touchOn: document.documentElement.classList.contains('crv2-touch-on'),
    padUp: !document.querySelector('.crv2-touch')?.classList.contains('is-hidden'),
  };
};

// ---------------------------------------------------------------------------
say(`\nPHONE CAPTURE — ${VW}x${VH}@3x  insets t=${SAFE[0]} b=${SAFE[1]} l=${SAFE[2]} r=${SAFE[3]}`);
await tapNav('ENTER ARENA');
await tapNav('TO GARAGE');
await tapNav('SELECT ARENA');
if (ARENA) await tapNav(ARENA, '.arena__card');
if (!(await tapNav('FIGHT'))) { say('  !! could not reach a match by touch'); await browser.close(); process.exit(1); }

// --- WAIT ON THE STATE, NOT ON A CLOCK, AND WATCH FROM INSIDE THE PAGE -----
// The watcher is a `setInterval` in the page so it costs one main-thread task
// per sample instead of a cross-process round trip; see the header. This side
// only polls a boolean, at 400ms, and reads the accumulated log once at the
// end.
const t0 = Date.now();
await page.evaluate(({ probeSrc, settle }) => {
  const OV = new Function('return (' + probeSrc + ')')();
  window.__cap = { log: [], clean: false, fightTick: -1, last: null };
  const c = window.__cap;
  clearInterval(window.__capTimer);
  window.__capTimer = setInterval(() => {
    let s;
    try { s = OV(); } catch (e) { return; }
    s.t = Math.round(performance.now());
    const l = c.last;
    if (!l || JSON.stringify(s.cards) !== JSON.stringify(l.cards) || s.phase !== l.phase) {
      c.log.push(`  +${String(s.t).padStart(6)}ms phase=${s.phase} tick=${s.tick}` +
        (s.cards.length ? `  CARD ${s.cards.map((x) => `${x.sel}@${x.op}"${x.text}"`).join(' ')}` : '  (clear)'));
    }
    const bare = s.state === 'match' && s.phase === 1 && !s.splash && !s.cards.length &&
      l && s.tick > l.tick;
    // The instant the FIGHT card lifts, both machines are still on their spawn
    // marks. Dwell in SIM TICKS from there, not in milliseconds: at ~5fps a
    // 2.6s wall-clock dwell buys about fifteen ticks.
    if (bare && c.fightTick < 0) {
      c.fightTick = s.tick;
      c.log.push(`  +${String(s.t).padStart(6)}ms first clear frame at tick ${s.tick}; dwelling ${settle} sim ticks`);
    }
    if (bare && c.fightTick >= 0 && s.tick - c.fightTick >= settle) {
      c.clean = true;
      clearInterval(window.__capTimer);
    }
    c.last = s;
  }, 150);
}, { probeSrc: OVERLAYS.toString(), settle: SETTLE });

const ok = await page.waitForFunction(() => window.__cap.clean, null,
  { timeout: CEIL, polling: 400 }).then(() => true, () => false);
for (const line of await page.evaluate(() => window.__cap.log)) say(line);
if (!ok) {
  const last = await page.evaluate(() => window.__cap.last);
  say(`  !! NO CARD-FREE FRAME after ${Date.now() - t0}ms — last: ${JSON.stringify(last)}`);
  await page.screenshot({ path: `${PREFIX}-FAILED.png`, timeout: 120000 });
  await writeFile(`${PREFIX}-log.txt`, log.join('\n'));
  await browser.close();
  process.exit(2);
}
say(`  clear + ${SETTLE} sim ticks after ${Date.now() - t0}ms of wall clock`);
// A hit marker or a K.O. can land between the flag going up and the shutter.
// Re-check, and if a card is back, take the next clear frame instead.
const at = await page.evaluate(OVERLAYS);
if (at.cards.length) {
  say(`  card reappeared (${at.cards.map((c) => c.sel).join(' ')}) — waiting it out`);
  await page.waitForFunction(() => !document.querySelector('.hud__banner.is-on, .screen.is-on'),
    null, { timeout: 40000, polling: 400 }).catch(() => {});
  await page.waitForTimeout(600);
}
const fin = await page.evaluate(OVERLAYS);
say(`  CAPTURING  state=${fin.state} phase=${fin.phase} tick=${fin.tick} round=${fin.round}` +
  `  touchOn=${fin.touchOn} padUp=${fin.padUp}  cards=${fin.cards.length ? JSON.stringify(fin.cards) : 'NONE'}`);

// --- geometry, in DEVICE pixels, for the salience meter --------------------
const rects = await page.evaluate((dpr) => {
  const out = [];
  const add = (name, sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return;
    out.push({ name, x: Math.round(b.left * dpr), y: Math.round(b.top * dpr),
      w: Math.round(b.width * dpr), h: Math.round(b.height * dpr) });
  };
  add('pad', '.tc__pad');
  add('stick', '.tc__stick');
  add('pause', '.tc__pause');
  add('hudtop', '.hud__top');
  add('hudgear', '.hud__gear');
  // The union of the five buttons, which is what "the touch buttons" means.
  const bs = Array.from(document.querySelectorAll('.tb')).map((e) => e.getBoundingClientRect());
  if (bs.length) {
    const x0 = Math.min(...bs.map((b) => b.left)), y0 = Math.min(...bs.map((b) => b.top));
    const x1 = Math.max(...bs.map((b) => b.right)), y1 = Math.max(...bs.map((b) => b.bottom));
    out.push({ name: 'buttons', x: Math.round(x0 * dpr), y: Math.round(y0 * dpr),
      w: Math.round((x1 - x0) * dpr), h: Math.round((y1 - y0) * dpr) });
  }
  return out;
}, 3);
const args = rects.map((r) => `--rect ${r.name}:${r.x},${r.y},${r.w},${r.h}`).join(' ');
say('  rects (device px): ' + rects.map((r) => `${r.name}=${r.x},${r.y},${r.w},${r.h}`).join('  '));
await writeFile(`${PREFIX}-rects.txt`,
  `node shots/_framesal.mjs ${PREFIX}-match.png --tile 60 ${args}\n`);

await page.screenshot({ path: `${PREFIX}-match.png`, timeout: 120000 });
say(`  wrote ${PREFIX}-match.png and ${PREFIX}-rects.txt`);
await writeFile(`${PREFIX}-log.txt`, log.join('\n'));
await browser.close();
