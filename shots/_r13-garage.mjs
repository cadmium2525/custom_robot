#!/usr/bin/env node
/**
 * Measure the landscape garage's four panels — where each one sits, how tall
 * it is, and how much of its own column is EMPTY underneath it.
 *
 * The round-13 walk proved the sticky rail reachable and then showed why that
 * is not the end of it: at the bottom of the scroll the middle column is a
 * 283x690 hole between the rail and the spec sheet, because `.garage__list`
 * spans both grid rows and only fills the top 400 of 800.
 *
 *   node shots/_r13-garage.mjs [base] [vw] [vh] [t,b,l,r]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:4213/custom_robot/';
const VW = Number(process.argv[3] || 844), VH = Number(process.argv[4] || 390);
const SAFE = (process.argv[5] || '0,21,47,47').split(',');

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
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 45000 });
await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(700);
await page.evaluate(() => window.__game.menus.show('garage'));
await page.waitForTimeout(700);

const r = await page.evaluate(() => {
  const s = document.querySelector('.screen.is-on');
  const g = document.querySelector('.garage');
  const gb = g.getBoundingClientRect();
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      sel, x: Math.round(b.left - gb.left), y: Math.round(b.top - gb.top),
      w: Math.round(b.width), h: Math.round(b.height),
      col: cs.gridColumn, row: cs.gridRow,
    };
  };
  return {
    screen: { h: Math.round(s.scrollHeight), c: Math.round(s.clientHeight) },
    grid: { w: Math.round(gb.width), h: Math.round(gb.height), cols: getComputedStyle(g).gridTemplateColumns, rows: getComputedStyle(g).gridTemplateRows },
    panels: ['.garage__rail', '.garage__list', '.garage__stage', '.garage__info'].map(box),
    info: ['.info__head', '.info__b', '.info__paint', '.info__perf'].map(box).filter(Boolean),
    stRows: document.querySelectorAll('.garage__info .st').length,
  };
});
console.log(`screen scrollHeight ${r.screen.h} / client ${r.screen.c}  (scroll ${r.screen.h - r.screen.c})`);
console.log(`grid ${r.grid.w}x${r.grid.h}  cols=${r.grid.cols}  rows=${r.grid.rows}`);
for (const p of r.panels) {
  if (!p) { console.log('  MISSING'); continue; }
  const tail = r.grid.h - (p.y + p.h);
  console.log(`  ${p.sel.padEnd(16)} x=${String(p.x).padStart(4)} y=${String(p.y).padStart(4)} ${String(p.w).padStart(4)}x${String(p.h).padStart(4)}  col=${p.col} row=${p.row}  EMPTY BELOW ${tail}`);
}
console.log(`  info children (${r.stRows} stat rows):`);
for (const p of r.info) console.log(`    ${p.sel.padEnd(16)} y=${String(p.y).padStart(4)} ${p.w}x${p.h}`);
await browser.close();
