#!/usr/bin/env node
/** List the stage's named meshes for an arena, so --mat has real names to aim at. */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const A = process.argv.slice(2);
const f = (n, d) => { const i = A.indexOf('--' + n); return i < 0 ? d : A[i + 1]; };
const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const b = await chromium.launch({ headless: true, executablePath: existsSync(PINNED) ? PINNED : undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
await p.goto(f('base', 'http://127.0.0.1:4403/custom_robot/'), { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => window.__game?.engine?.running, null, { timeout: 90000 });
await p.evaluate(({ id, seed }) => {
  const g = window.__game;
  g.startMatch({ mode: 'solo', difficulty: 'ace', arenaId: id, loadouts: g.loadouts, seed });
  g.setDemo(true); g.engine.paused = true;
  if (g.engine.clock) g.engine.clock.elapsed = 1000;
}, { id: f('arena', 'foundry'), seed: 1234567 });
await p.waitForTimeout(1500);
console.log(await p.evaluate(() => {
  const out = [];
  window.__game.view.stage.group.traverse((o) => {
    if (!o.isMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    out.push(`${(o.name || '(unnamed)').padEnd(22)} ${m ? m.type : '-'}  col=${m && m.color ? '#' + m.color.getHexString() : '-'}  emi=${m && m.emissiveIntensity !== undefined ? m.emissiveIntensity : '-'}  env=${m && m.envMapIntensity !== undefined ? m.envMapIntensity : '-'}`);
  });
  return out.join('\n');
}));
await b.close();
