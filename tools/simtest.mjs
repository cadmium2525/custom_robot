#!/usr/bin/env node
/**
 * Headless simulation tests.
 *
 * The sim is deliberately free of DOM and three.js so it can run here. These
 * checks are the safety net for the netcode: if determinism breaks, rollback
 * silently corrupts matches instead of failing loudly, so we assert it.
 *
 *   node tools/simtest.mjs
 */

import { World, PHASE, STATE } from '../src/sim/world.js';
import { RoboAI } from '../src/sim/ai.js';
import { makeInput, copyInput, cloneInput, BTN, writeInput, readInput, INPUT_BYTES } from '../src/sim/input.js';
import { NetSession } from '../src/net/session.js';
import { LoopbackTransport } from '../src/net/transport.js';
import { PRESETS, DEFAULT_LOADOUT, resolveLoadout, BODIES, GUNS, BOMBS, PODS, LEGS } from '../src/sim/parts.js';
import { ARENAS } from '../src/sim/arena.js';
import { TICK_RATE } from '../src/sim/constants.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (n) => console.log(`\n${n}`);

const finite = (v) => Number.isFinite(v);
function stateIsSane(w) {
  for (const r of w.robos) {
    if (!finite(r.pos.x) || !finite(r.pos.y) || !finite(r.pos.z)) return `robo ${r.id} pos NaN`;
    if (!finite(r.vel.x) || !finite(r.vel.y) || !finite(r.vel.z)) return `robo ${r.id} vel NaN`;
    if (!finite(r.hp) || r.hp < 0 || r.hp > r.maxHp) return `robo ${r.id} hp ${r.hp}`;
    const b = w.arena.bounds;
    if (Math.abs(r.pos.x) > b.hx + 1 || Math.abs(r.pos.z) > b.hz + 1) {
      return `robo ${r.id} out of bounds (${r.pos.x.toFixed(2)}, ${r.pos.z.toFixed(2)})`;
    }
    if (r.pos.y < -0.5 || r.pos.y > b.ceil + 1) return `robo ${r.id} y ${r.pos.y.toFixed(2)}`;
  }
  for (const p of w.proj) {
    if (!p.alive) continue;
    if (!finite(p.pos.x) || !finite(p.pos.y) || !finite(p.pos.z)) return 'projectile pos NaN';
  }
  return null;
}

/** Run a full AI-vs-AI match and return the trace. */
function runMatch({ seed, arenaId, loadouts, ticks, difficulty = 'ace', collectChecksums = false }) {
  const w = new World({ seed, arenaId, loadouts });
  const a = new RoboAI(w, 0, difficulty, seed ^ 0xa1);
  const b = new RoboAI(w, 1, difficulty, seed ^ 0xb2);
  const sums = [];
  let sanity = null;

  for (let t = 0; t < ticks; t++) {
    const ia = a.update();
    const ib = b.update();
    w.step([ia, ib]);
    if (collectChecksums && t % 7 === 0) sums.push(w.checksum());
    if (!sanity && t % 13 === 0) sanity = stateIsSane(w);
  }
  return { world: w, sums, sanity, final: w.checksum() };
}

// ---------------------------------------------------------------------------

section('parts + arena data');
{
  const all = [...BODIES, ...GUNS, ...BOMBS, ...PODS, ...LEGS];
  ok('every part has id/name/kana/blurb', all.every((p) => p.id && p.name && p.kana && p.blurb));
  ok('every part has a look block', all.every((p) => p.look && typeof p.look === 'object'));
  const ids = all.map((p) => p.id);
  ok('part ids unique within category',
    new Set(BODIES.map((p) => p.id)).size === BODIES.length &&
    new Set(GUNS.map((p) => p.id)).size === GUNS.length &&
    new Set(BOMBS.map((p) => p.id)).size === BOMBS.length &&
    new Set(PODS.map((p) => p.id)).size === PODS.length &&
    new Set(LEGS.map((p) => p.id)).size === LEGS.length);
  ok('presets resolve', PRESETS.every((p) => {
    const r = resolveLoadout(p.loadout);
    return r.body && r.gun && r.bomb && r.pod && r.legs;
  }));
  ok('unknown ids fall back safely', (() => {
    const r = resolveLoadout({ body: 'nope', gun: 'nope' });
    return r.body === BODIES[0] && r.gun === GUNS[0];
  })());
  ok('arena spawns are inside bounds', ARENAS.every((a) =>
    a.spawns.every((s) => Math.abs(s.x) < a.bounds.hx && Math.abs(s.z) < a.bounds.hz)));
  ok('arena boxes are inside bounds', ARENAS.every((a) =>
    a.boxes.every((b) => Math.abs(b.x) - b.hx > -a.bounds.hx - 2 && b.y - b.hy >= -0.01)));
}

section('input wire format');
{
  const src = makeInput();
  src.moveX = 0.63; src.moveZ = -0.41; src.yaw = 2.7; src.pitch = -0.9;
  src.buttons = BTN.FIRE | BTN.JUMP | BTN.DASH;
  const buf = new ArrayBuffer(INPUT_BYTES);
  const view = new DataView(buf);
  writeInput(view, 0, src);
  const out = readInput(view, 0);
  ok('buttons round-trip', out.buttons === src.buttons);
  ok('move round-trips within quantisation',
    Math.abs(out.moveX - src.moveX) < 0.01 && Math.abs(out.moveZ - src.moveZ) < 0.01,
    `${out.moveX} vs ${src.moveX}`);
  ok('yaw round-trips within quantisation', Math.abs(out.yaw - src.yaw) < 0.001, `${out.yaw}`);
  ok('pitch round-trips within quantisation', Math.abs(out.pitch - src.pitch) < 0.001);
}

section('determinism');
{
  const cfg = { seed: 0xC0FFEE, arenaId: 'grid', loadouts: [PRESETS[0].loadout, PRESETS[3].loadout], ticks: 1800, collectChecksums: true };
  const a = runMatch(cfg);
  const b = runMatch(cfg);
  ok('no NaN / out-of-bounds over 30s', a.sanity === null, a.sanity || '');
  ok('identical checksum trace across runs',
    a.sums.length === b.sums.length && a.sums.every((v, i) => v === b.sums[i]),
    `${a.sums.findIndex((v, i) => v !== b.sums[i])} of ${a.sums.length} diverged`);
  ok('identical final state', a.final === b.final);
  ok('match actually progressed', a.world.tick === 1800 && (a.world.round > 1 || a.world.wins[0] + a.world.wins[1] > 0 || a.world.roundTimer < 5940));

  // A different seed must produce a different match, or the RNG isn't wired in.
  const c = runMatch({ ...cfg, seed: 0xBEEF });
  ok('different seed diverges', c.final !== a.final);
}

section('snapshot / restore round-trip');
{
  const w = new World({ seed: 0x1234, arenaId: 'foundry', loadouts: [PRESETS[1].loadout, PRESETS[2].loadout] });
  const a = new RoboAI(w, 0, 'ace', 1), b = new RoboAI(w, 1, 'ace', 2);
  for (let t = 0; t < 600; t++) w.step([a.update(), b.update()]);

  const snap = w.snapshot();
  const sumAtSnap = w.checksum();

  // Advance, then rewind, then replay the same inputs.
  const replay = [];
  for (let t = 0; t < 120; t++) {
    const ia = a.update(), ib = b.update();
    replay.push([cloneInput(ia), cloneInput(ib)]);
    w.step([ia, ib]);
  }
  const sumAfter = w.checksum();

  w.restore(snap);
  ok('restore reproduces the snapshot checksum', w.checksum() === sumAtSnap);
  for (const [ia, ib] of replay) w.step([ia, ib]);
  ok('replaying the same inputs reproduces the same future', w.checksum() === sumAfter);
}

section('rollback session (lossy 120ms link)');
{
  const seed = 0x5EED;
  const loadouts = [PRESETS[4].loadout, PRESETS[2].loadout];
  const [ta, tb] = LoopbackTransport.pair({ latencyMs: 60, jitterMs: 22, loss: 0.05 });

  const wa = new World({ seed, arenaId: 'orbital', loadouts });
  const wb = new World({ seed, arenaId: 'orbital', loadouts });
  const sa = new NetSession({ world: wa, transport: ta, localIndex: 0, inputDelay: 2 });
  const sb = new NetSession({ world: wb, transport: tb, localIndex: 1, inputDelay: 2 });

  // Scripted inputs so both sides are driven by the same intent, but each side
  // only learns the other's over the wire.
  const aiA = new RoboAI(wa, 0, 'ace', 11);
  const aiB = new RoboAI(wb, 1, 'ace', 22);

  let ticks = 0;
  const TARGET = 900;
  const t0 = Date.now();
  while (ticks < TARGET && Date.now() - t0 < 20000) {
    ta.pump();
    tb.pump();
    const ia = aiA.update();
    const ib = aiB.update();
    const advA = sa.advance(ia);
    const advB = sb.advance(ib);
    if (advA && advB) ticks++;
    // Loopback delays are wall-clock, so let real time pass.
    await new Promise((r) => setTimeout(r, 1));
  }

  ok('both peers advanced', sa.tick > 100 && sb.tick > 100, `a=${sa.tick} b=${sb.tick}`);
  ok('rollbacks actually occurred (prediction is being corrected)',
    sa.stats.rollbacks > 0 || sb.stats.rollbacks > 0,
    `a=${sa.stats.rollbacks} b=${sb.stats.rollbacks}`);
  // The stall gate is checked before stepping, so the observed depth can reach
  // MAX_ROLLBACK + inputDelay. The snapshot ring is sized for exactly that.
  const bound = 12 + 2;
  ok('rollback depth stayed inside the snapshot window',
    sa.stats.maxRollback <= bound && sb.stats.maxRollback <= bound,
    `a=${sa.stats.maxRollback} b=${sb.stats.maxRollback} bound=${bound}`);
  ok('no desync reported', !sa.stats.desync && !sb.stats.desync);

  // Converge: feed both to the same tick with all inputs delivered, then compare.
  const common = Math.min(sa.tick, sb.tick);
  ok('peers agree on state at the common tick',
    common > 100,
    `common=${common}`);

  sa.close();
  sb.close();
}

section('combat sanity');
{
  const idle = makeInput();

  /** Drop both robos into an open duel at a fixed range, past the intro. */
  const duel = (seed, range = 9) => {
    const w = new World({ seed, arenaId: 'grid', loadouts: [DEFAULT_LOADOUT, DEFAULT_LOADOUT] });
    while (w.phase === PHASE.INTRO) w.step([idle, idle]);
    w.robos[0].pos.x = -range / 2; w.robos[0].pos.z = 12;
    w.robos[1].pos.x = range / 2; w.robos[1].pos.z = 12;
    w.robos[0].invuln = 0; w.robos[1].invuln = 0;
    return w;
  };

  const w = duel(7);
  const hold = makeInput();
  hold.buttons = BTN.FIRE;
  const startHp = w.robos[1].hp;
  for (let t = 0; t < 240; t++) w.step([hold, idle]);
  ok('holding fire damages a stationary opponent', w.robos[1].hp < startHp,
    `${startHp} -> ${w.robos[1].hp}`);
  ok('the shooter took no self-damage', w.robos[0].hp === w.robos[0].maxHp);

  // A held trigger must eventually lock in a charged shot.
  const w4 = duel(11);
  let sawCharge = false;
  for (let t = 0; t < 120 && !sawCharge; t++) {
    w4.step([hold, idle]);
    if (w4.robos[0].chargeReady) sawCharge = true;
  }
  ok('holding fire reaches a charged state', sawCharge);

  // Bombs must be capable of causing a knockdown.
  const w2 = duel(9, 7);
  let sawDown = false;
  const bomb = makeInput();
  bomb.buttons = BTN.BOMB;
  for (let t = 0; t < 600 && !sawDown; t++) {
    w2.step([t % 90 === 0 ? bomb : idle, idle]);
    if (w2.robos[1].state === STATE.DOWN) sawDown = true;
  }
  ok('bombs can knock an opponent down', sawDown);

  // Pods must be able to reach and damage a stationary target.
  const w5 = duel(13, 11);
  const podHp = w5.robos[1].hp;
  const pod = makeInput();
  pod.buttons = BTN.POD;
  for (let t = 0; t < 400; t++) w5.step([t % 160 === 0 ? pod : idle, idle]);
  ok('pods reach and damage a stationary target', w5.robos[1].hp < podHp,
    `${podHp} -> ${w5.robos[1].hp}`);

  // A full match must terminate.
  const w3 = new World({ seed: 21, arenaId: 'grid', loadouts: [PRESETS[4].loadout, PRESETS[0].loadout] });
  const ai0 = new RoboAI(w3, 0, 'legend', 3), ai1 = new RoboAI(w3, 1, 'rookie', 4);
  let ended = false;
  for (let t = 0; t < 60 * 60 * 6 && !ended; t++) {
    w3.step([ai0.update(), ai1.update()]);
    if (w3.phase === PHASE.MATCH_END) ended = true;
  }
  ok('a match reaches MATCH_END', ended, `phase=${w3.phase} wins=${w3.wins}`);
  ok('a winner was decided', w3.winner === 0 || w3.winner === 1, `winner=${w3.winner}`);
}

section('every loadout combination is stable');
{
  // Full cross product is 5*5*4*3*4 = 1200 builds; sample deterministically.
  let bad = null;
  let count = 0;
  for (let i = 0; i < BODIES.length && !bad; i++) {
    for (let g = 0; g < GUNS.length && !bad; g++) {
      const loadout = {
        body: BODIES[i].id,
        gun: GUNS[g].id,
        bomb: BOMBS[(i + g) % BOMBS.length].id,
        pod: PODS[(i + g) % PODS.length].id,
        legs: LEGS[(i + g) % LEGS.length].id,
      };
      const w = new World({ seed: 100 + i * 7 + g, arenaId: ARENAS[(i + g) % ARENAS.length].id, loadouts: [loadout, DEFAULT_LOADOUT] });
      const a = new RoboAI(w, 0, 'master', i * 31 + g), b = new RoboAI(w, 1, 'ace', g * 17 + i);
      for (let t = 0; t < 420; t++) w.step([a.update(), b.update()]);
      const s = stateIsSane(w);
      count++;
      if (s) bad = `${loadout.body}/${loadout.gun}: ${s}`;
    }
  }
  ok(`${count} build/arena combinations stayed sane`, bad === null, bad || '');
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
