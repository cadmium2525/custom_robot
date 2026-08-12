/**
 * Transport abstraction.
 *
 * The netcode never talks to PeerJS directly — it talks to this interface. That
 * keeps rollback testable in a single tab (LoopbackTransport) and lets a
 * different signalling stack drop in later without touching the session code.
 *
 * Messages are ArrayBuffers. Ordering and delivery are NOT guaranteed; the
 * session is built to tolerate loss and reordering.
 */

export class Transport {
  constructor() {
    this.onMessage = null;   // (ArrayBuffer) => void
    this.onOpen = null;
    this.onClose = null;
    this.onError = null;
    this.connected = false;
  }

  send(_buf) { throw new Error('not implemented'); }
  close() {}
}

/**
 * In-process transport with configurable latency and packet loss. Used by the
 * netcode self-test and for tuning rollback without a second device.
 */
export class LoopbackTransport extends Transport {
  constructor({ latencyMs = 60, jitterMs = 15, loss = 0.02 } = {}) {
    super();
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.loss = loss;
    this.peer = null;
    this.queue = [];
    this.connected = true;
  }

  static pair(opts) {
    const a = new LoopbackTransport(opts);
    const b = new LoopbackTransport(opts);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(buf) {
    if (!this.peer) return;
    if (Math.random() < this.loss) return;
    const delay = this.latencyMs + (Math.random() * 2 - 1) * this.jitterMs;
    const copy = buf.slice(0);
    this.peer.queue.push({ at: performance.now() + delay, buf: copy });
  }

  /** Call once per frame to flush anything whose delay has elapsed. */
  pump() {
    const now = performance.now();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].at <= now) {
        const m = this.queue.splice(i, 1)[0];
        this.onMessage?.(m.buf);
      }
    }
  }

  close() {
    this.connected = false;
    this.queue.length = 0;
    this.onClose?.();
  }
}
