#!/usr/bin/env node
/**
 * Fold a Vite build into one self-contained HTML file.
 *
 * Used for hosts that can only serve a single document (and as a fallback when
 * static hosting isn't available). Requires `SINGLE=1 vite build` so the bundle
 * is a single module with no cross-chunk imports.
 *
 *   SINGLE=1 npx vite build --outDir dist-single && node tools/bundle-single.mjs
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const DIST = process.argv[2] || 'dist-single';
const OUT = process.argv[3] || 'dist-single/holosseum.html';

const html = await readFile(path.join(DIST, 'index.html'), 'utf8');
const assets = await readdir(path.join(DIST, 'assets')).catch(() => []);

let out = html;

for (const file of assets) {
  const full = path.join(DIST, 'assets', file);
  const body = await readFile(full, 'utf8');

  if (file.endsWith('.css')) {
    // <link rel="stylesheet" ... href=".../file.css"> -> inline <style>
    const re = new RegExp(`<link[^>]*href="[^"]*${escapeRe(file)}"[^>]*>`, 'g');
    out = out.replace(re, `<style>\n${body}\n</style>`);
  } else if (file.endsWith('.js')) {
    const re = new RegExp(`<script[^>]*src="[^"]*${escapeRe(file)}"[^>]*></script>`, 'g');
    // The closing-tag sequence inside a string literal would end the script
    // element early; the standard escape is to break the token.
    const safe = body.replace(/<\/script/gi, '<\\/script');
    out = out.replace(re, `<script type="module">\n${safe}\n</script>`);
  }
}

// Strip modulepreload hints — everything is inline now, nothing left to fetch.
out = out.replace(/<link[^>]*rel="modulepreload"[^>]*>/g, '');

if (/<script[^>]+src=/.test(out) || /<link[^>]+stylesheet/.test(out)) {
  console.error('warning: external references remain in the output');
}

await writeFile(OUT, out, 'utf8');
console.log(`${OUT}  ${(Buffer.byteLength(out) / 1024 / 1024).toFixed(2)} MB`);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Artifact variant: the host wraps content in its own <!doctype>/<head>/<body>,
// so strip our document shell and emit only the page content.
// ---------------------------------------------------------------------------

if (process.env.ARTIFACT_OUT) {
  const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || 'HOLOSSEUM';
  const styles = [...out.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const scripts = [...out.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const bodyInner = (out.match(/<body[^>]*>([\s\S]*?)<\/body>/) || [, ''])[1]
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
    .trim();

  const page = [
    `<title>${title}</title>`,
    ...styles.map((s) => `<style>\n${s}\n</style>`),
    bodyInner,
    ...scripts.map((s) => `<script type="module">\n${s}\n</script>`),
  ].join('\n');

  await writeFile(process.env.ARTIFACT_OUT, page, 'utf8');
  console.log(`${process.env.ARTIFACT_OUT}  ${(Buffer.byteLength(page) / 1024 / 1024).toFixed(2)} MB`);
}
