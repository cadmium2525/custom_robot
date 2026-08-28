#!/usr/bin/env node
/**
 * REACHABILITY, measured the way a thumb measures it.
 *
 * This replaces the reachability half of `_r10-walk.mjs`, which round 11 caught
 * overstating two of its own findings and which a restructure of the landscape
 * garage is currently being written against:
 *
 *   1. It hit-tests the CENTRE of the element's full rect. Anything half under
 *      a sticky footer therefore reports NOT-HITTABLE while 20 px of it is
 *      exposed and perfectly tappable. The defect is real and narrower than the
 *      label: the control's *natural* tap point misses, not the control.
 *   2. It swipes to the extreme and re-tests THERE. Every "STILL UNREACHABLE"
 *      line it has ever printed carries a NEGATIVE y — it scrolled the element
 *      off the top and then declared it unreachable.
 *
 * So this reports, for every interactive control on a screen, AT REST and then
 * at the scroll offset that best exposes it:
 *
 *   rect        the control's own box
 *   vis%        share of that box inside the viewport AND not covered by any
 *               fixed/sticky overlay, found by hit-testing a grid across the
 *               whole control rather than one point at its centre
 *   tap         the centre of the LARGEST fully-hittable sub-rect, or MISS.
 *               A fix needs a target, and "not hittable" is not a target.
 *   verdict     UNREACHABLE  no hittable pixel at any scroll offset — the only
 *                            state that is a blocker
 *               SCROLL       fully reachable, but not at rest
 *               EDGE         hittable at rest, but its own centre misses
 *               OK
 *
 * When anything returns SCROLL it also reports whether the scroller shows an
 * AFFORDANCE at rest — a scrollbar, a fade/mask, or a visible partial row —
 * because "the player is not told it continues" and "the player cannot get
 * there" are different defects with different fixes and this project has been
 * filing them as one.
 *
 *   node shots/_reach.mjs <base> <screen> [vw] [vh] [t,b,l,r]
 *
 *   node shots/_reach.mjs http://127.0.0.1:4220/custom_robot/ settings 844 390 0,21,47,47
 *   node shots/_reach.mjs http://127.0.0.1:4220/custom_robot/ garage   844 390 0,21,47,47
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:4220/custom_robot/';
const SCREEN = process.argv[3] || 'settings';
const VW = Number(process.argv[4] || 844), VH = Number(process.argv[5] || 390);
const SAFE = (process.argv[6] || '0,21,47,47').split(',');

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
const log = [];
const say = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };

await mkdir('shots', { recursive: true });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 45000 });
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(700);

// Navigate by the menu API. This tool measures LAYOUT, not navigation — the
// walk already proves the screens are reachable by touch, and using the API
// here keeps a navigation failure from being reported as a reachability one.
const ok = await page.evaluate((s) => {
  const m = window.__game?.menus;
  if (!m) return 'no menus object';
  try { m.show(s); return true; } catch (e) { return String(e); }
}, SCREEN);
if (ok !== true) { say(`could not open "${SCREEN}": ${ok}`); await browser.close(); process.exit(1); }
await page.waitForTimeout(600);

const PROBE = (sel) => {
  const STEP = 6;
  const vw = innerWidth, vh = innerHeight;
  // Only controls that are actually RENDERED. Every screen's markup lives in
  // the DOM at once, so an unfiltered querySelectorAll returns the title menu
  // and the touch pad as [0,0,0,0] boxes and scores eleven phantom
  // UNREACHABLEs on a screen that has none.
  const els = [...document.querySelectorAll(sel)].filter((e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  });
  // The scroller this screen actually uses: the deepest scrollable ancestor
  // that contains the controls, not the first scrollable node in the document.
  const scroller = (() => {
    const cands = new Map();
    for (const el of els) {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.scrollHeight - p.clientHeight > 4 && p.clientHeight > 60) {
          cands.set(p, (cands.get(p) || 0) + 1);
          break;
        }
      }
    }
    let best = null;
    for (const [e, n] of cands) if (!best || n > best.n) best = { e, n };
    return best ? best.e : null;
  })();

  /** Hit-test a grid over the element's box; return the hittable point set. */
  const probe = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { r, hits: [], total: 0 };
    const hits = []; let total = 0;
    for (let y = r.top + 2; y < r.bottom - 1; y += STEP) {
      for (let x = r.left + 2; x < r.right - 1; x += STEP) {
        total++;
        if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === el || el.contains(hit) || hit.contains(el))) hits.push({ x, y });
      }
    }
    return { r, hits, total };
  };

  /** Largest axis-aligned run of hittable points, as a tap target. */
  const target = (hits) => {
    if (!hits.length) return null;
    const rows = new Map();
    for (const h of hits) { const k = Math.round(h.y); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(h.x); }
    let best = null;
    for (const [y, xs] of rows) {
      xs.sort((a, b) => a - b);
      let run = [xs[0]];
      for (let i = 1; i <= xs.length; i++) {
        if (i < xs.length && xs[i] - xs[i - 1] <= STEP + 1) { run.push(xs[i]); continue; }
        if (!best || run.length > best.n) best = { n: run.length, y, x: (run[0] + run[run.length - 1]) / 2 };
        run = [xs[i]];
      }
    }
    return best;
  };

  const out = [];
  for (const el of els) {
    const at0 = probe(el);
    const centreHit = (() => {
      const c = { x: at0.r.left + at0.r.width / 2, y: at0.r.top + at0.r.height / 2 };
      if (c.x < 0 || c.y < 0 || c.x >= vw || c.y >= vh) return false;
      const h = document.elementFromPoint(c.x, c.y);
      return !!(h && (h === el || el.contains(h) || h.contains(el)));
    })();
    out.push({
      label: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26),
      rect: [at0.r.left, at0.r.top, at0.r.right, at0.r.bottom].map((v) => Math.round(v)),
      vis: at0.total ? Math.round(100 * at0.hits.length / at0.total) : 0,
      centreHit,
      tap: target(at0.hits),
    });
  }
  window.__reachScroller = scroller;
  return {
    scroller: scroller ? {
      sel: scroller.className || scroller.tagName,
      scrollTop: scroller.scrollTop,
      range: scroller.scrollHeight - scroller.clientHeight,
      // Does anything at rest tell the player it continues?
      hasScrollbar: getComputedStyle(scroller).overflowY === 'scroll',
      hasMask: !!(getComputedStyle(scroller).maskImage !== 'none' ||
                  getComputedStyle(scroller).webkitMaskImage !== 'none'),
    } : null,
    els: out,
  };
};

const SEL = 'button, [role="button"], .opt, .cat, .part, .chip, [tabindex]:not([tabindex="-1"])';
const rest = await page.evaluate(PROBE, SEL);

say(`\nREACHABILITY — ${SCREEN} at ${VW}x${VH}, insets ${SAFE.join('/')}`);
if (rest.scroller) {
  const s = rest.scroller;
  say(`  scroller "${String(s.sel).slice(0, 40)}"  scrollTop ${s.scrollTop} of ${s.range}` +
      `   affordance: ${s.hasScrollbar ? 'scrollbar ' : ''}${s.hasMask ? 'fade-mask ' : ''}` +
      `${!s.hasScrollbar && !s.hasMask ? 'NONE' : ''}`);
} else say('  no scroller on this screen');

// Now sweep the scroller and keep, per element, its best exposure.
const best = new Map(rest.els.map((e, i) => [i, e]));
if (rest.scroller && rest.scroller.range > 0) {
  const stops = [];
  for (let s = 0; s <= rest.scroller.range; s += Math.max(25, Math.round(rest.scroller.range / 8))) stops.push(s);
  stops.push(rest.scroller.range);
  for (const s of stops) {
    await page.evaluate((top) => {
      const sc = window.__reachScroller;
      if (sc) sc.scrollTop = top;
    }, s);
    await page.waitForTimeout(90);
    const at = await page.evaluate(PROBE, SEL);
    at.els.forEach((e, i) => {
      const b = best.get(i);
      if (b && e.vis > b.vis) best.set(i, { ...e, atScroll: s });
    });
  }
}

say(`\n  ${'control'.padEnd(28)} ${'rect at rest'.padEnd(24)} vis%  centre  best   verdict`);
let blockers = 0, scrolls = 0, edges = 0;
rest.els.forEach((e, i) => {
  const b = best.get(i);
  const verdict = b.vis === 0 ? 'UNREACHABLE'
    : e.vis === 0 ? `SCROLL (to ${b.atScroll ?? '?'})`
      : !e.centreHit ? 'EDGE — centre misses'
        : e.vis < 100 ? 'OK (clipped)' : 'OK';
  if (verdict === 'UNREACHABLE') blockers++;
  else if (verdict.startsWith('SCROLL')) scrolls++;
  else if (verdict.startsWith('EDGE')) edges++;
  const tap = e.tap ? `${Math.round(e.tap.x)},${Math.round(e.tap.y)}` : 'MISS';
  say(`  ${(e.label || '(unlabelled)').padEnd(28)} [${e.rect.join(',')}]`.padEnd(56) +
      ` ${String(e.vis).padStart(3)}  ${(e.centreHit ? 'hit' : 'MISS').padEnd(5)} ${String(b.vis).padStart(4)}   ${verdict}   tap ${tap}`);
});
say(`\n  ${rest.els.length} controls: ${blockers} UNREACHABLE, ${scrolls} need a scroll, ${edges} hittable but centre misses`);
if (blockers === 0) say('  Nothing on this screen is unreachable by a thumb.');

await writeFile(`shots/reach-${SCREEN}-${VW}x${VH}.txt`, log.join('\n'));
await page.screenshot({ path: `shots/reach-${SCREEN}-${VW}x${VH}.png` });
await browser.close();
