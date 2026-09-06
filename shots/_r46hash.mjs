#!/usr/bin/env node
/**
 * ROUND 44 CRITIC — the bundle hash, computed here and not read off a meter.
 *
 * FAULT 39 is "a figure that quotes a hash it did not compute". Every meter in
 * this tree prints `bundleHash()` itself, and a critic who quotes the meter's
 * own line is quoting the instrument about the instrument. This file is the
 * same algorithm written out separately — index HTML plus every `<script src>`
 * it names, in document order, sha256, first 12 hex — so a disagreement between
 * this and the meter is a finding rather than a coincidence.
 *
 *   node shots/_r46hash.mjs http://127.0.0.1:4405/custom_robot/
 */
import { createHash } from 'node:crypto';
import process from 'node:process';

const base = process.argv[2] || 'http://127.0.0.1:4405/custom_robot/';
const html = await (await fetch(base)).text();
const h = createHash('sha256').update(html);
const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
let bytes = html.length;
for (const s of srcs) {
  const buf = new Uint8Array(await (await fetch(new URL(s, base).href)).arrayBuffer());
  bytes += buf.length;
  h.update(buf);
}
console.log(`${h.digest('hex').slice(0, 12)}   ${srcs.length} script(s), ${bytes} bytes   ${base}`);
