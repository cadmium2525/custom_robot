#!/usr/bin/env node
/**
 * THE MEASUREMENT THIS PROJECT HAS NEVER TAKEN.
 *
 * Headless Chromium resolves every `env(safe-area-inset-*)` to 0, so every
 * touch capture in `shots/` is of the no-notch layout. Since `ui.css` now
 * declares the four inset variables on `:root` (not on `.crv2-ui`), a harness
 * can force them at runtime and photograph the real iPhone 12.
 *
 * This drives a real match by touch, forces 47/34, and prints the resolved
 * rect of every in-match chrome element against the two device bands:
 *   - the status band, y in [0, safe-t)
 *   - the home indicator band, y in (H - safe-b, H]
 *
 *   node shots/_hudinset.mjs [base] [prefix] [vw] [vh] [t,b,l,r]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:4213/custom_robot/';
const PREFIX = process.argv[3] || 'shots/hi';
const VW = Number(process.argv[4] || 390), VH = Number(process.argv[5] || 844);
const SAFE = (process.argv[6] || '47,34,0,0').split(',').map(Number);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const ctx = await browser.newContext({
  viewport: { width: VW, height: VH }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
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
  if (document.documentElement) set(); else addEventListener('DOMContentLoaded', set);
}, SAFE);
const page = await ctx.newPage();
await mkdir('shots', { recursive: true });
const log = [];
const say = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 45000 });
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(900);

// Confirm the override actually took, which is the whole premise.
const resolved = await page.evaluate(() => {
  const rs = getComputedStyle(document.documentElement);
  const us = getComputedStyle(document.querySelector('.crv2-ui') || document.documentElement);
  return {
    root: ['--safe-t', '--safe-b', '--safe-l', '--safe-r'].map((k) => k + '=' + rs.getPropertyValue(k).trim()).join(' '),
    ui: ['--safe-t', '--safe-b', '--safe-l', '--safe-r'].map((k) => k + '=' + us.getPropertyValue(k).trim()).join(' '),
  };
});
say(`FORCED INSETS  t=${SAFE[0]} b=${SAFE[1]} l=${SAFE[2]} r=${SAFE[3]}   viewport ${VW}x${VH}@3x`);
say(`  :root resolves   ${resolved.root}`);
say(`  .crv2-ui resolves ${resolved.ui}`);

const cdp = await ctx.newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
async function tap(x, y) {
  await touch('touchStart', [{ x, y, id: 1 }]);
  await page.waitForTimeout(60);
  await touch('touchEnd', []);
  await page.waitForTimeout(450);
}
async function tapNav(match, sel) {
  const pt = await page.evaluate(({ m, s }) => {
    const screen = document.querySelector('.screen.is-on');
    if (!screen) return { err: 'no screen' };
    const el = Array.from(screen.querySelectorAll(s || '[data-nav]'))
      .find((e) => (e.textContent || '').replace(/\s+/g, ' ').toUpperCase().includes(m.toUpperCase()));
    if (!el) return { err: 'no nav ' + m };
    const b = el.getBoundingClientRect();
    return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  }, { m: match, s: sel });
  if (pt.err) { say('  !! ' + pt.err); return false; }
  await tap(pt.cx, pt.cy); return true;
}

await tapNav('ENTER ARENA');
await tapNav('TO GARAGE');
await tapNav('SELECT ARENA');
await tapNav('FIGHT');
await page.waitForTimeout(2600);
// Wake the touch layer with a real finger, then hold two down so the stick and
// the pad are in their live state, not their idle one.
await tap(VW * 0.25, VH * 0.8);
await page.waitForTimeout(700);

const measure = () => page.evaluate(({ VW, VH, ST, SB, SL, SR }) => {
  const want = ['.hud__top', '.hud__gear', '.hud__scrim', '.tc__stick', '.tc__pad', '.tc__pause',
    '.hud__hp--l', '.hud__hp--r', '.hud__timer', '.tc__btn', '.hud__pips', '.hud__ammo'];
  const out = [];
  for (const sel of want) {
    for (const el of document.querySelectorAll(sel)) {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') { out.push({ sel, hidden: true }); continue; }
      const lbl = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18);
      out.push({
        sel, lbl,
        r: [b.left, b.top, b.right, b.bottom].map((v) => +v.toFixed(1)),
        intoNotch: b.top < ST ? +(ST - b.top).toFixed(1) : 0,
        intoHome: b.bottom > VH - SB ? +(b.bottom - (VH - SB)).toFixed(1) : 0,
        intoLeft: b.left < SL ? +(SL - b.left).toFixed(1) : 0,
        intoRight: b.right > VW - SR ? +(b.right - (VW - SR)).toFixed(1) : 0,
        offBottom: b.bottom > VH ? +(b.bottom - VH).toFixed(1) : 0,
        offRight: b.right > VW ? +(b.right - VW).toFixed(1) : 0,
        opacity: cs.opacity,
      });
    }
  }
  return out;
}, { VW, VH, ST: SAFE[0], SB: SAFE[1], SL: SAFE[2], SR: SAFE[3] });

function report(title, rects) {
  say('');
  say(`--- ${title} ---`);
  say('element              rect (l,t,r,b)                intrusions            label');
  for (const e of rects) {
    if (e.hidden) { say(`${e.sel.padEnd(20)} display:none`); continue; }
    const flag = (v, n) => (v ? `${n}+${v}` : '');
    const bad = [flag(e.intoNotch, 'NOTCH'), flag(e.intoHome, 'HOME'), flag(e.intoLeft, 'L'), flag(e.intoRight, 'R'),
      flag(e.offBottom, 'OFF-BOTTOM'), flag(e.offRight, 'OFF-RIGHT')].filter(Boolean).join(' ');
    say(`${e.sel.padEnd(20)} ${JSON.stringify(e.r).padEnd(28)} ${(bad || 'clear').padEnd(20)}  ${e.lbl}`);
  }
}

// IDLE: the layer is awake but no finger is down, so every rect here is the
// one the stylesheet chose. This is the layout under test.
report('IDLE (stylesheet-placed)', await measure());
await page.screenshot({ path: `${PREFIX}-idle.png`, timeout: 120000 });

// LIVE: two fingers down, so the floating stick has moved to the thumb and the
// buttons are in their pressed state.
await touch('touchStart', [{ x: VW * 0.22, y: VH * 0.82, id: 1 }, { x: VW * 0.82, y: VH * 0.86, id: 2 }]);
await page.waitForTimeout(500);
report('LIVE (two fingers down)', await measure());
await page.screenshot({ path: `${PREFIX}-match.png`, timeout: 120000 });
await touch('touchEnd', []);
await writeFile(`${PREFIX}-log.txt`, log.join('\n'));
await browser.close();
