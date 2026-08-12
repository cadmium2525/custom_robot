/**
 * Rollback netcode session (GGPO-style).
 *
 * Both peers run the same deterministic `World`. Each sends its own inputs with
 * redundant history; the remote input for the current tick is *predicted*
 * (repeat-last), and when the truth arrives and disagrees we restore the
 * snapshot from that tick and re-simulate forward with presentation events
 * suppressed, so the player only ever sees the corrected timeline.
 *
 * Local play uses the same path with a null transport, which means the online
 * and offline code paths never diverge — the class of bug where "it only breaks
 * in netplay" mostly stops existing.
 */

import { makeInput, copyInput, cloneInput, writeInput, readInput, INPUT_BYTES } from '../sim/input.js';

const HISTORY = 256;                 // ring size, ticks
export const MAX_ROLLBACK = 12;      // how far back we can correct
const REDUNDANCY = 10;               // inputs resent per packet

const MSG = {
  HELLO: 1,
  INPUT: 2,
  PING: 3,
  PONG: 4,
  CHECKSUM: 5,
  BYE: 6,
};

const PROTOCOL = 3;

export class NetSession {
  /**
   * @param {object} o
   * @param {import('../sim/world.js').World} o.world
   * @param {import('./transport.js').Transport|null} o.transport
   * @param {number} o.localIndex   0 or 1
   * @param {number} [o.inputDelay] frames of local delay traded for less rollback
   */
  constructor({ world, transport = null, localIndex = 0, inputDelay = 2 }) {
    this.world = world;
    this.transport = transport;
    this.local = localIndex;
    this.remote = 1 - localIndex;
    this.inputDelay = transport ? inputDelay : 0;
    this.online = !!transport;

    this.buffers = [new Array(HISTORY), new Array(HISTORY)];
    this.valid = [new Uint8Array(HISTORY), new Uint8Array(HISTORY)];
    for (let p = 0; p < 2; p++) {
      for (let i = 0; i < HISTORY; i++) this.buffers[p][i] = makeInput();
    }
    /** What we actually fed the sim, so we can detect a misprediction. */
    this.used = new Array(HISTORY);
    for (let i = 0; i < HISTORY; i++) this.used[i] = makeInput();

    this.snapshots = new Array(MAX_ROLLBACK + 2).fill(null);
    this.snapTick = new Int32Array(MAX_ROLLBACK + 2).fill(-1);

    this.tick = 0;                 // next tick to simulate
    this.remoteConfirmed = -1;     // highest remote tick we hold truth for
    this.lastRemoteInput = makeInput();

    this.stats = {
      rollbacks: 0, maxRollback: 0, rttMs: 0, remoteAhead: 0,
      stalls: 0, predicted: 0, desync: false, sent: 0, recv: 0,
    };

    this._pingAt = 0;
    this._pingSeq = 0;
    this._sendBuf = new ArrayBuffer(8 + INPUT_BYTES * REDUNDANCY);
    this._sendView = new DataView(this._sendBuf);
    this._scratch = makeInput();
    this._checksums = new Map();
    this._peerChecksums = new Map();

    if (transport) {
      transport.onMessage = (buf) => this._onMessage(buf);
      transport.onClose = () => { this.stats.disconnected = true; };
      this._sendHello();
    }
  }

  get idx() { return this.tick % HISTORY; }

  // -------------------------------------------------------------------------

  _sendHello() {
    const b = new ArrayBuffer(12);
    const v = new DataView(b);
    v.setUint8(0, MSG.HELLO);
    v.setUint8(1, PROTOCOL);
    v.setUint8(2, this.local);
    v.setUint32(4, this.world.seed >>> 0, true);
    v.setUint32(8, this.world.tick, true);
    this.transport.send(b);
  }

  ping() {
    if (!this.transport) return;
    const b = new ArrayBuffer(12);
    const v = new DataView(b);
    v.setUint8(0, MSG.PING);
    v.setUint32(1, ++this._pingSeq, true);
    v.setFloat64(4, performance.now(), true);
    this._pingAt = performance.now();
    this.transport.send(b);
  }

  _onMessage(buf) {
    const v = new DataView(buf);
    const type = v.getUint8(0);
    this.stats.recv++;

    switch (type) {
      case MSG.HELLO: {
        if (v.getUint8(1) !== PROTOCOL) this.stats.protocolMismatch = true;
        break;
      }
      case MSG.INPUT: {
        const start = v.getUint32(1, true);
        const count = v.getUint8(5);
        let earliestNew = Infinity;
        for (let i = 0; i < count; i++) {
          const t = start + i;
          if (t < 0) continue;
          const slot = t % HISTORY;
          readInput(v, 8 + i * INPUT_BYTES, this._scratch);
          const already = this.valid[this.remote][slot] === 1 && this._slotTick(this.remote, slot) === t;
          if (already) continue;
          copyInput(this.buffers[this.remote][slot], this._scratch);
          this.buffers[this.remote][slot].tick = t;
          this.valid[this.remote][slot] = 1;
          if (t > this.remoteConfirmed) this.remoteConfirmed = t;
          if (t < earliestNew) earliestNew = t;
        }
        if (earliestNew < this.tick) this._maybeRollback(earliestNew);
        break;
      }
      case MSG.PING: {
        const b = new ArrayBuffer(12);
        const o = new DataView(b);
        o.setUint8(0, MSG.PONG);
        o.setUint32(1, v.getUint32(1, true), true);
        o.setFloat64(4, v.getFloat64(4, true), true);
        this.transport.send(b);
        break;
      }
      case MSG.PONG: {
        const sent = v.getFloat64(4, true);
        const rtt = performance.now() - sent;
        this.stats.rttMs = this.stats.rttMs ? this.stats.rttMs * 0.8 + rtt * 0.2 : rtt;
        break;
      }
      case MSG.CHECKSUM: {
        const t = v.getUint32(1, true);
        const sum = v.getUint32(5, true);
        const mine = this._checksums.get(t);
        // Either side can reach a checkpoint first, so hold unmatched values
        // until the counterpart shows up.
        if (mine !== undefined) {
          if (mine !== sum) this.stats.desync = true;
        } else {
          this._peerChecksums.set(t, sum);
          if (this._peerChecksums.size > 64) {
            this._peerChecksums.delete(this._peerChecksums.keys().next().value);
          }
        }
        break;
      }
      case MSG.BYE:
        this.stats.disconnected = true;
        break;
    }
  }

  _slotTick(player, slot) {
    return this.buffers[player][slot].tick ?? -1;
  }

  _sendInputs() {
    if (!this.transport) return;
    const target = this.tick + this.inputDelay;
    const start = Math.max(0, target - REDUNDANCY + 1);
    const count = target - start + 1;
    const v = this._sendView;
    v.setUint8(0, MSG.INPUT);
    v.setUint32(1, start, true);
    v.setUint8(5, count);
    for (let i = 0; i < count; i++) {
      const slot = (start + i) % HISTORY;
      writeInput(v, 8 + i * INPUT_BYTES, this.buffers[this.local][slot]);
    }
    this.transport.send(this._sendBuf.slice(0, 8 + count * INPUT_BYTES));
    this.stats.sent++;
  }

  // -------------------------------------------------------------------------

  /** Remote input for `t`: truth if we have it, otherwise repeat-last. */
  _remoteInputFor(t, out) {
    const slot = t % HISTORY;
    if (this.valid[this.remote][slot] === 1 && this._slotTick(this.remote, slot) === t) {
      return copyInput(out, this.buffers[this.remote][slot]);
    }
    this.stats.predicted++;
    return copyInput(out, this.lastRemoteInput);
  }

  _localInputFor(t, out) {
    const slot = t % HISTORY;
    if (this.valid[this.local][slot] === 1 && this._slotTick(this.local, slot) === t) {
      return copyInput(out, this.buffers[this.local][slot]);
    }
    return copyInput(out, out.buttons !== undefined ? this.lastLocalNeutral || (this.lastLocalNeutral = makeInput()) : makeInput());
  }

  _saveSnapshot() {
    const i = this.tick % this.snapshots.length;
    this.snapshots[i] = this.world.snapshot();
    this.snapTick[i] = this.tick;
  }

  _findSnapshot(t) {
    for (let i = 0; i < this.snapshots.length; i++) {
      if (this.snapTick[i] === t && this.snapshots[i]) return this.snapshots[i];
    }
    return null;
  }

  _maybeRollback(fromTick) {
    // Did the truth actually differ from what we fed the sim?
    let diverged = -1;
    for (let t = fromTick; t < this.tick; t++) {
      const slot = t % HISTORY;
      if (this.valid[this.remote][slot] !== 1 || this._slotTick(this.remote, slot) !== t) continue;
      const truth = this.buffers[this.remote][slot];
      const fed = this.used[slot];
      if (fed.tick !== t) continue;
      if (truth.buttons !== fed.rButtons || truth.moveX !== fed.rMoveX ||
          truth.moveZ !== fed.rMoveZ || truth.yaw !== fed.rYaw) {
        diverged = t;
        break;
      }
    }
    if (diverged < 0) return;

    const snap = this._findSnapshot(diverged);
    if (!snap) return;   // too far back to correct — the peer is beyond our window

    const depth = this.tick - diverged;
    this.stats.rollbacks++;
    this.stats.maxRollback = Math.max(this.stats.maxRollback, depth);

    this.world.restore(snap);
    const target = this.tick;
    this.tick = diverged;

    // Re-simulate silently: the player already saw these frames.
    this.world.suppressEvents = true;
    while (this.tick < target) this._stepOnce();
    this.world.suppressEvents = false;
  }

  _stepOnce() {
    const slot = this.tick % HISTORY;
    const a = this._inA || (this._inA = makeInput());
    const b = this._inB || (this._inB = makeInput());

    this._localInputFor(this.tick, a);
    this._remoteInputFor(this.tick, b);

    const rec = this.used[slot];
    rec.tick = this.tick;
    rec.rButtons = b.buttons; rec.rMoveX = b.moveX; rec.rMoveZ = b.moveZ; rec.rYaw = b.yaw;

    const inputs = this.local === 0 ? [a, b] : [b, a];
    this._saveSnapshot();
    this.world.step(inputs);
    this.tick++;
  }

  /**
   * Advance exactly one tick.
   * @param {object} localInput the local player's InputFrame for this frame
   * @returns {boolean} false if we stalled waiting for the peer
   */
  advance(localInput) {
    // Record local input at tick + delay so both sides agree on when it lands.
    const target = this.tick + this.inputDelay;
    const slot = target % HISTORY;
    copyInput(this.buffers[this.local][slot], localInput);
    this.buffers[this.local][slot].tick = target;
    this.valid[this.local][slot] = 1;

    // Fill the delay window on the first frames so tick 0 has an input.
    if (this.tick === 0 && this.inputDelay > 0) {
      for (let t = 0; t < this.inputDelay; t++) {
        const s = t % HISTORY;
        if (this.valid[this.local][s] !== 1 || this._slotTick(this.local, s) !== t) {
          copyInput(this.buffers[this.local][s], localInput);
          this.buffers[this.local][s].tick = t;
          this.valid[this.local][s] = 1;
        }
      }
    }

    this._sendInputs();

    if (this.online) {
      // Don't outrun the peer further than we can roll back.
      const ahead = this.tick - this.remoteConfirmed;
      this.stats.remoteAhead = ahead;
      if (ahead > MAX_ROLLBACK) {
        this.stats.stalls++;
        return false;
      }
    }

    const rslot = this.tick % HISTORY;
    if (this.valid[this.remote][rslot] === 1 && this._slotTick(this.remote, rslot) === this.tick) {
      copyInput(this.lastRemoteInput, this.buffers[this.remote][rslot]);
    }

    this._stepOnce();

    // Only checksum FINAL state. A tick whose remote input is still predicted
    // can be rewritten by a later rollback, so comparing it would report a
    // desync that never happened.
    const settled = this.tick - 1;
    if (this.online && settled % 30 === 0 && settled <= this.remoteConfirmed) {
      const sum = this.world.checksum();
      this._checksums.set(settled, sum);
      if (this._checksums.size > 64) {
        const oldest = this._checksums.keys().next().value;
        this._checksums.delete(oldest);
      }
      const peer = this._peerChecksums.get(settled);
      if (peer !== undefined) {
        if (peer !== sum) this.stats.desync = true;
        this._peerChecksums.delete(settled);
      }
      const b = new ArrayBuffer(9);
      const v = new DataView(b);
      v.setUint8(0, MSG.CHECKSUM);
      v.setUint32(1, settled, true);
      v.setUint32(5, sum, true);
      this.transport.send(b);
    }
    if (this.online && this.tick % 30 === 0) this.ping();

    return true;
  }

  /** Offline convenience: drive both sides locally (player + AI). */
  advanceLocal(inputA, inputB) {
    const slotA = this.tick % HISTORY;
    copyInput(this.buffers[0][slotA], inputA);
    this.buffers[0][slotA].tick = this.tick;
    this.valid[0][slotA] = 1;
    copyInput(this.buffers[1][slotA], inputB);
    this.buffers[1][slotA].tick = this.tick;
    this.valid[1][slotA] = 1;
    this.remoteConfirmed = this.tick;
    copyInput(this.lastRemoteInput, this.local === 0 ? inputB : inputA);
    this._stepOnce();
    return true;
  }

  close() {
    if (this.transport) {
      const b = new ArrayBuffer(1);
      new DataView(b).setUint8(0, MSG.BYE);
      try { this.transport.send(b); } catch { /* connection already gone */ }
      this.transport.close();
    }
  }
}
