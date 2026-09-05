#!/usr/bin/env node
/**
 * WHERE the weak contour pixels ARE, and what the diagnosis column can and
 * cannot license. Reads shots/contour-n.png and shots/contour-mask.png off
 * disk (written by tools/contour.mjs --keep) and re-walks the SAME boundary
 * with the SAME 7x7 rule, so every figure here is comparable to the meter's.
 *
 *   node tools/contour.mjs --base http://127.0.0.1:4400/custom_robot/ \
 *        --arena grid --tier 3 --ticks 420 --keep
 *   node shots/_r40-where.mjs --tag grid
 *
 * Costs one browser launch and no render: the frame is already on disk. Run
 * from the repository root; --tag keeps one arena's maps from overwriting
 * another's.
 *
 * WHY IT EXISTS. `tools/contour.mjs` says HOW MUCH of the outline is weak and,
 * since 5c60b81, what the two sides of the window READ where it is weak. It has
 * never said WHERE on the machine those pixels are, and four rounds of work
 * were aimed at the outline hull on the strength of a mechanism nobody had
 * located. On grid the far machine's entire failure is two 18-pixel stretches
 * on the head; on foundry the same machine's failure is spread over the whole
 * silhouette. Those need different fixes and the percentage cannot tell them
 * apart.
 *
 * THE TWO MODELS AT THE BOTTOM ARE ARITHMETIC, NOT RENDERS. `lift` adds a
 * constant to the machine half of every window; `pivot` pulls it toward a
 * constant, which is the shape FILL_FRAG's flatten has. They say what this
 * meter would read under that transform. They do not say any knob produces it
 * and they price nothing. Quote them as models or not at all.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ROOT = process.cwd().replace(/\/*$/, '') + '/';
/** --tag NAME: written into the map filenames, so grid and foundry do not overwrite each other. */
const TAG = (() => { const i = process.argv.indexOf('--tag'); return i > 0 ? String(process.argv[i + 1] || '') : ''; })();
const uri = (f) => 'data:image/png;base64,' + readFileSync(ROOT + f).toString('base64');

const FN = async ({ nUri, hUri }) => {
  const load = (u) => new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0);
      res({ d: g.getImageData(0, 0, im.width, im.height).data, W: im.width, H: im.height });
    };
    im.src = u;
  });
  const N = await load(nUri), H = await load(hUri);
  const W = N.W, HT = N.H;
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const Ln = new Float32Array(W * HT), mask = new Uint8Array(W * HT);
  for (let p = 0, i = 0; p < W * HT; p++, i += 4) {
    Ln[p] = lum(N.d, i);
    if (lum(H.d, i) > 128) mask[p] = 1;
  }
  // components, identical rule to contour.mjs
  const comp = new Int32Array(W * HT).fill(-1); const comps = []; const st = new Int32Array(W * HT);
  for (let p = 0; p < W * HT; p++) {
    if (!mask[p] || comp[p] >= 0) continue;
    const id = comps.length; let sp = 0, n = 0, x0 = W, x1 = 0, y0 = HT, y1 = 0;
    st[sp++] = p; comp[p] = id;
    while (sp) {
      const q = st[--sp]; const qx = q % W, qy = (q / W) | 0; n++;
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      if (qx > 0 && mask[q - 1] && comp[q - 1] < 0) { comp[q - 1] = id; st[sp++] = q - 1; }
      if (qx < W - 1 && mask[q + 1] && comp[q + 1] < 0) { comp[q + 1] = id; st[sp++] = q + 1; }
      if (qy > 0 && mask[q - W] && comp[q - W] < 0) { comp[q - W] = id; st[sp++] = q - W; }
      if (qy < HT - 1 && mask[q + W] && comp[q + W] < 0) { comp[q + W] = id; st[sp++] = q + W; }
    }
    comps.push({ id, n, x0, x1, y0, y1 });
  }
  const bodies = comps.filter((c) => c.n >= 300 && (c.y1 - c.y0) >= 16).sort((a, b) => b.n - a.n).slice(0, 2);

  const R = 3;
  const walk = (only) => {
    const out = [];
    for (let y = R; y < HT - R; y++) {
      for (let x = R; x < W - R; x++) {
        const p = y * W + x;
        if (!mask[p]) continue;
        if (only !== undefined && comp[p] !== only) continue;
        if (mask[p - 1] && mask[p + 1] && mask[p - W] && mask[p + W]) continue;
        let iS = 0, iN = 0, oS = 0, oN = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const q = p + dy * W + dx;
          if (mask[q]) { iS += Ln[q]; iN++; } else { oS += Ln[q]; oN++; }
        }
        if (iN < 5 || oN < 5) continue;
        const i = iS / iN, o = oS / oN;
        // Local machine thickness: how many of the 49 window pixels are on a
        // machine at all. A boundary on a big convex mass reads ~24; a boundary
        // on a 2px antenna reads single figures. This is what tells a value
        // failure apart from a THIN-FEATURE failure, and no round has looked.
        out.push({ x, y, i, o, s: Math.abs(i - o), iN });
      }
    }
    return out;
  };

  const med = (a) => (a.length ? a.slice().sort((p, q) => p - q)[a.length >> 1] : null);
  const pct = (a, f) => (a.length ? a.slice().sort((p, q) => p - q)[Math.min(a.length - 1, Math.floor(f * a.length))] : null);

  const report = [];
  const maps = [];
  for (const c of bodies) {
    const d = walk(c.id);
    const weak = d.filter((k) => k.s < 25), good = d.filter((k) => k.s >= 40);
    const H0 = c.y1 - c.y0 + 1, W0 = c.x1 - c.x0 + 1;
    // vertical band occupancy: weak share vs all-boundary share, in fifths
    const band = (arr, n) => {
      const b = new Array(n).fill(0);
      for (const k of arr) b[Math.min(n - 1, Math.floor((k.y - c.y0) / H0 * n))]++;
      return b;
    };
    // sign of machine-minus-background on weak pixels
    const brighter = weak.filter((k) => k.i > k.o).length;
    // ---- lift model: add X to the machine half only, recompute clean%
    const lift = [];
    for (let X = 0; X <= 120; X += 10) {
      const cl = d.filter((k) => Math.abs(k.i + X - k.o) >= 40).length / d.length * 100;
      lift.push([X, Math.round(cl * 10) / 10]);
    }
    // ---- pivot model: machine half pulled toward constant P by fraction f.
    // Best case over a grid of (P,f); this is the shape the FILL_FRAG flatten has.
    let best = { cl: -1 };
    const pivotRows = [];
    for (let P = 40; P <= 240; P += 20) {
      const row = [];
      for (let f = 0; f <= 1.0001; f += 0.25) {
        const cl = d.filter((k) => Math.abs(k.i + (P - k.i) * f - k.o) >= 40).length / d.length * 100;
        row.push(Math.round(cl * 10) / 10);
        if (cl > best.cl) best = { cl, P, f: Math.round(f * 100) / 100 };
      }
      pivotRows.push([P, row]);
    }
    // finer search for the ceiling
    let fine = { cl: -1 };
    for (let P = 0; P <= 255; P += 5) for (let f = 0; f <= 1.0001; f += 0.05) {
      const cl = d.filter((k) => Math.abs(k.i + (P - k.i) * f - k.o) >= 40).length / d.length * 100;
      if (cl > fine.cl) fine = { cl: Math.round(cl * 10) / 10, P, f: Math.round(f * 100) / 100 };
    }
    // Connected runs of weak boundary (8-neighbour) — how many separate
    // STRETCHES of outline are failing, as against how many pixels.
    const key = (k) => k.y * 10000 + k.x;
    const wset = new Map(weak.map((k) => [key(k), k]));
    const seenR = new Set(); const runs = [];
    for (const k of weak) {
      if (seenR.has(key(k))) continue;
      const stk = [k]; seenR.add(key(k));
      let n = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      while (stk.length) {
        const q = stk.pop(); n++;
        if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
        if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const m = wset.get((q.y + dy) * 10000 + (q.x + dx));
          if (m && !seenR.has(key(m))) { seenR.add(key(m)); stk.push(m); }
        }
      }
      runs.push({ n, box: `${x1 - x0 + 1}x${y1 - y0 + 1}`, at: `${x0},${y0}` });
    }
    runs.sort((a, b) => b.n - a.n);

    report.push({
      runs: runs.slice(0, 6), nRuns: runs.length,
      weakThick: med(weak.map((k) => k.iN)), goodThick: med(good.map((k) => k.iN)),
      weakThin: Math.round(weak.filter((k) => k.iN <= 14).length / Math.max(1, weak.length) * 1000) / 10,
      goodThin: Math.round(good.filter((k) => k.iN <= 14).length / Math.max(1, good.length) * 1000) / 10,
      // What clause B would read if boundary on THIN geometry were excluded.
      cleanThickOnly: (() => {
        const t = d.filter((k) => k.iN > 14);
        return t.length ? Math.round(t.filter((k) => k.s >= 40).length / t.length * 1000) / 10 : null;
      })(),
      thickN: d.filter((k) => k.iN > 14).length,
      box: `${W0}x${H0}`, at: `${c.x0},${c.y0}`, px: c.n,
      n: d.length, weakN: weak.length, goodN: good.length,
      weakPct: Math.round(weak.length / d.length * 1000) / 10,
      cleanPct: Math.round(good.length / d.length * 1000) / 10,
      weakIn: med(weak.map((k) => k.i)), weakOut: med(weak.map((k) => k.o)),
      goodIn: med(good.map((k) => k.i)), goodOut: med(good.map((k) => k.o)),
      weakOutP10: pct(weak.map((k) => k.o), 0.1), weakOutP90: pct(weak.map((k) => k.o), 0.9),
      goodOutP10: pct(good.map((k) => k.o), 0.1), goodOutP90: pct(good.map((k) => k.o), 0.9),
      weakBrighter: Math.round(brighter / Math.max(1, weak.length) * 1000) / 10,
      bandsAll: band(d, 5), bandsWeak: band(weak, 5),
      lift, pivotRows, fine,
    });

    // ---- the picture: crop, dimmed frame, weak in red, clean in green, mid in yellow
    const PAD = 10, Z = Math.max(2, Math.round(300 / H0));
    const cw = (W0 + PAD * 2), ch = (H0 + PAD * 2);
    const cv = document.createElement('canvas');
    cv.width = cw * Z; cv.height = ch * Z;
    const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const px = c.x0 - PAD + x, py = c.y0 - PAD + y;
      if (px < 0 || py < 0 || px >= W || py >= HT) continue;
      const o = (py * W + px) * 4;
      g.fillStyle = `rgb(${N.d[o] * 0.45 | 0},${N.d[o + 1] * 0.45 | 0},${N.d[o + 2] * 0.45 | 0})`;
      g.fillRect(x * Z, y * Z, Z, Z);
    }
    for (const k of d) {
      const col = k.s < 12 ? '#ff2020' : k.s < 25 ? '#ff9000' : k.s < 40 ? '#ffe000' : '#20e060';
      g.fillStyle = col;
      g.fillRect((k.x - c.x0 + PAD) * Z, (k.y - c.y0 + PAD) * Z, Z, Z);
    }
    maps.push(cv.toDataURL('image/png'));
  }
  return { screen: `${W}x${HT}`, report, maps };
};

(async () => {
  const b = await chromium.launch({ executablePath: PINNED, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const p = await (await b.newContext()).newPage();
  await p.goto('about:blank');
  const out = await p.evaluate(FN, { nUri: uri('shots/contour-n.png'), hUri: uri('shots/contour-mask.png') });
  console.log('frame', out.screen);
  out.report.forEach((r, i) => {
    console.log(`\nROBOT ${i + 1}  ${r.box}px at ${r.at}  stencil ${r.px}  boundary n=${r.n}`);
    console.log(`  weak ${r.weakPct}%  clean ${r.cleanPct}%`);
    const f1 = (v) => (v == null ? ' n/a' : v.toFixed(1).padStart(6));
    console.log(`  weak  machine ${f1(r.weakIn)}  behind ${f1(r.weakOut)}   behind p10/p90 ${f1(r.weakOutP10)}/${f1(r.weakOutP90)}`);
    console.log(`  clean machine ${f1(r.goodIn)}  behind ${f1(r.goodOut)}   behind p10/p90 ${f1(r.goodOutP10)}/${f1(r.goodOutP90)}`);
    console.log(`  weak pixels where MACHINE IS BRIGHTER than what is behind it: ${r.weakBrighter}%`);
    console.log(`  local thickness (mask px in the 7x7, of 49): weak median ${r.weakThick}  clean median ${r.goodThick}`);
    console.log(`    on THIN geometry (<=14 of 49): weak ${r.weakThin}%  clean ${r.goodThin}%`);
    console.log(`    clause B restricted to boundary on thick geometry (n=${r.thickN}): clean ${r.cleanThickOnly}%`);
    console.log(`  weak boundary comes in ${r.nRuns} connected stretch(es); largest:`);
    for (const q of r.runs) console.log(`    ${String(q.n).padStart(4)} px   ${q.box} at ${q.at}`);
    const sh = (a, t) => a.map((v) => String(Math.round(v / t * 1000) / 10).padStart(6)).join('');
    console.log(`  vertical fifths (top->bottom), share of that population:`);
    console.log(`    all boundary ${sh(r.bandsAll, r.n)}`);
    console.log(`    weak only    ${sh(r.bandsWeak, r.weakN)}`);
    console.log(`  LIFT MODEL — add X to the machine half only, clean% becomes:`);
    console.log('    X     ' + r.lift.map((l) => String(l[0]).padStart(6)).join(''));
    console.log('    clean ' + r.lift.map((l) => l[1].toFixed(1).padStart(6)).join(''));
    console.log(`  PIVOT MODEL — machine half pulled toward P by fraction f (the FILL_FRAG shape):`);
    console.log('    P \\ f ' + [0, 0.25, 0.5, 0.75, 1].map((f) => String(f).padStart(6)).join(''));
    for (const [P, row] of r.pivotRows) console.log('    ' + String(P).padStart(5) + ' ' + row.map((v) => v.toFixed(1).padStart(6)).join(''));
    console.log(`  CEILING over all (P,f) on a 5-level / 0.05 grid: clean ${r.fine.cl}%  at P=${r.fine.P} f=${r.fine.f}`);
  });
  out.maps.forEach((m, i) => {
    const f = ROOT + `shots/r40-where-${TAG ? TAG + '-' : ''}r${i + 1}.png`;
    writeFileSync(f, Buffer.from(m.split(',')[1], 'base64'));
    console.log(`wrote ${f}`);
  });
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
