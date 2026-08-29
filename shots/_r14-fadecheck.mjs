#!/usr/bin/env node
/**
 * Does `tools/mass.mjs --u frameFade=X` actually reach the frame material?
 *
 * mass.mjs's --u handler builds the uniform name as 'u' + Capitalised(key) and
 * then does `if (u[name]) u[name].value = v` — a guard that SILENTLY does
 * nothing when the name is wrong, while the tool still prints
 * "uniforms: <key>=<value>" as though it had worked. That print is not proof.
 * Eleven instrument faults on this project say check it.
 *
 * Reads the value back off matFrame.userData.u — the material's OWN bag, not
 * the shell alias it was assigned through — so a pass means the live frame
 * shader is holding the number.
 */
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://127.0.0.1:4311/custom_robot/';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
// Boot exactly the way tools/mass.mjs does (mass.mjs:421-441), including the
// null `arg` before the options bag — waitForFunction(fn, arg, options), and
// passing options in the arg slot silently falls back to the 30 s default.
await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => window.__game && window.__game.engine?.running, null, { timeout: 120000 });
await p.evaluate(() => { const q = window.__game.engine.quality; q.auto = false; q.setTier(3); });
await p.evaluate(() => {
  const g = window.__game;
  g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: 'grid', loadouts: g.loadouts, seed: 1234567 });
});
await p.waitForFunction(() => window.__game.view && window.__game.view.models.length >= 2, null, { timeout: 120000 });
await p.evaluate((n) => window.__game.fastForward(n), 60);
const read = () => p.evaluate(`window.__game.view.models.map((m) => ({
  frameOwn:  m.matFrame  && m.matFrame.userData.u.uFrameFade.value,
  shellAlias: m.matShell && m.matShell.userData.u.uFrameFade && m.matShell.userData.u.uFrameFade.value,
  sameObject: !!(m.matFrame && m.matShell && m.matFrame.userData.u.uFrameFade === m.matShell.userData.u.uFrameFade),
  lo: m.matFrame && m.matFrame.userData.u.uFrameSizeLo.value,
  hi: m.matFrame && m.matFrame.userData.u.uFrameSizeHi.value,
}))`);
console.log('shipped :', JSON.stringify(await read()));
// EXACTLY mass.mjs's --u code path, key spelled the way a caller would spell it.
await p.evaluate((list) => {
  for (const m of window.__game.view.models) {
    const u = m.matShell?.userData?.u;
    if (!u) continue;
    for (const [k, v] of list) {
      const name = 'u' + k[0].toUpperCase() + k.slice(1);
      if (u[name]) u[name].value = v;
    }
  }
}, [['frameFade', 0.7]]);
console.log('--u frameFade=0.7 ->', JSON.stringify(await read()));
await p.evaluate((list) => {
  for (const m of window.__game.view.models) {
    const u = m.matShell?.userData?.u;
    if (!u) continue;
    for (const [k, v] of list) {
      const name = 'u' + k[0].toUpperCase() + k.slice(1);
      if (u[name]) u[name].value = v;
    }
  }
}, [['uFrameFade', 0.3]]);
console.log('--u uFrameFade=0.3 ->', JSON.stringify(await read()), '(expect UNCHANGED: wrong spelling)');
await b.close();
