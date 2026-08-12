/**
 * PeerJS transport — WebRTC data channel, unreliable/unordered so a dropped
 * input packet never stalls the pipeline (the session sends redundant history
 * instead of retransmitting).
 *
 * PeerJS is loaded lazily so a local-only session never pays for the bundle.
 */

import { Transport } from './transport.js';

let PeerCtor = null;

async function loadPeer() {
  if (PeerCtor) return PeerCtor;
  const mod = await import('peerjs');
  PeerCtor = mod.Peer || mod.default?.Peer || mod.default;
  return PeerCtor;
}

/** Short, human-typeable room codes. Avoids look-alike glyphs. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeRoomCode(len = 5) {
  let s = '';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

const NS = 'crv2-arena-';

export class PeerTransport extends Transport {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    this.role = null;
    this.roomCode = null;
    this.pingMs = 0;
  }

  /** Host: claims the room code as our peer id and waits for a challenger. */
  async host(code = makeRoomCode()) {
    const Peer = await loadPeer();
    this.role = 'host';
    this.roomCode = code;
    return new Promise((resolve, reject) => {
      this.peer = new Peer(NS + code, { debug: 0 });
      this.peer.on('open', () => resolve(code));
      this.peer.on('error', (e) => {
        this.onError?.(e);
        if (!this.connected) reject(e);
      });
      this.peer.on('connection', (conn) => {
        if (this.conn) { conn.close(); return; }   // room is full
        this._bind(conn);
      });
    });
  }

  /** Guest: dials the host's room code. */
  async join(code) {
    const Peer = await loadPeer();
    this.role = 'guest';
    this.roomCode = code;
    return new Promise((resolve, reject) => {
      this.peer = new Peer({ debug: 0 });
      this.peer.on('error', (e) => {
        this.onError?.(e);
        if (!this.connected) reject(e);
      });
      this.peer.on('open', () => {
        const conn = this.peer.connect(NS + code, {
          reliable: false,
          serialization: 'binary',
          metadata: { game: 'crv2-arena' },
        });
        conn.on('open', () => resolve(code));
        conn.on('error', reject);
        this._bind(conn);
      });
      setTimeout(() => { if (!this.connected) reject(new Error('connection timed out')); }, 20000);
    });
  }

  _bind(conn) {
    this.conn = conn;
    conn.on('open', () => {
      this.connected = true;
      this.onOpen?.();
    });
    conn.on('data', (data) => {
      // PeerJS hands back ArrayBuffer or a typed-array view depending on path.
      let buf = data;
      if (ArrayBuffer.isView(buf)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      if (buf instanceof ArrayBuffer) this.onMessage?.(buf);
    });
    conn.on('close', () => {
      this.connected = false;
      this.onClose?.();
    });
    conn.on('error', (e) => this.onError?.(e));
  }

  send(buf) {
    if (!this.conn || !this.connected) return;
    try {
      this.conn.send(buf);
    } catch (e) {
      this.onError?.(e);
    }
  }

  close() {
    this.connected = false;
    try { this.conn?.close(); } catch { /* already gone */ }
    try { this.peer?.destroy(); } catch { /* already gone */ }
    this.conn = null;
    this.peer = null;
  }
}
