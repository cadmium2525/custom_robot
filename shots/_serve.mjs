#!/usr/bin/env node
/**
 * A serving root that `npm run build` cannot kill.
 *
 * Round 12 lost eleven of twelve captures and another agent lost six of nine to
 * the same cause: `vite preview` serves dist/ directly, so rebuilding while a
 * sweep is in flight replaces the directory under the server, the server exits,
 * and every remaining capture records ERR_CONNECTION_REFUSED. The recorded
 * advice was "serve a COPY of dist"; this is that, written down so it does not
 * have to be re-derived a seventh time.
 *
 *   node shots/_serve.mjs &                 # serves shots/_root/ on :4300
 *   sh   shots/_snap.sh                     # build -> refresh shots/_root/
 *
 * The server holds no handle on any file between requests and resolves each URL
 * against the root at request time, so refreshing the root mid-sweep is safe:
 * the worst case is one capture reading a half-copied bundle, and _snap.sh
 * copies to a temp dir and renames, so even that cannot happen.
 *
 * Serves under BOTH `/` and `/custom_robot/` because the built index.html is
 * emitted with base=/custom_robot/ but every tool in tools/ defaults to a bare
 * root. `vite preview` answers `/` with a 302 that playwright reports as
 * ERR_HTTP_RESPONSE_CODE_FAILURE; this one just serves the file.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = process.env.SERVE_ROOT || join(HERE, '_root');
const PORT = Number(process.env.SERVE_PORT || 4300);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.startsWith('/custom_robot/')) p = p.slice('/custom_robot'.length);
    if (p === '/custom_robot') p = '/';
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404).end('not found'); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e && e.message));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`serving ${ROOT} on http://127.0.0.1:${PORT}/ (and /custom_robot/)\n`);
});
