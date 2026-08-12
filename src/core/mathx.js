/**
 * Deterministic math helpers for the simulation layer.
 *
 * Nothing in here may import three.js — the sim must stay renderer-free so it
 * can be stepped headlessly for rollback netcode.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (t) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Frame-rate independent exponential approach. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Shortest signed angular difference, result in (-PI, PI]. */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function approachAngle(from, to, maxStep) {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

export function moveTowards(a, b, maxStep) {
  const d = b - a;
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
}

// ---------------------------------------------------------------------------
// Plain-object vector helpers. Sim state is JSON-shaped so snapshots are cheap.
// ---------------------------------------------------------------------------

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const v3set = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const v3copy = (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; return o; };
export const v3add = (o, a, b) => { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; };
export const v3sub = (o, a, b) => { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; };
export const v3scale = (o, a, s) => { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; };
export const v3addScaled = (o, a, b, s) => {
  o.x = a.x + b.x * s; o.y = a.y + b.y * s; o.z = a.z + b.z * s; return o;
};
export const v3dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const v3lenSq = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const v3len = (a) => Math.sqrt(v3lenSq(a));
export const v3distSq = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const v3dist = (a, b) => Math.sqrt(v3distSq(a, b));

export function v3norm(o, a) {
  const l = v3len(a);
  if (l < 1e-9) return v3set(o, 0, 0, 0);
  return v3scale(o, a, 1 / l);
}

export function v3lerp(o, a, b, t) {
  o.x = a.x + (b.x - a.x) * t;
  o.y = a.y + (b.y - a.y) * t;
  o.z = a.z + (b.z - a.z) * t;
  return o;
}

/** Horizontal (XZ) length — used constantly for ground movement. */
export const v3lenXZ = (a) => Math.sqrt(a.x * a.x + a.z * a.z);
export const v3distXZ = (a, b) => {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
};

/** Clamp the XZ component of a vector to `max` length, leaving Y untouched. */
export function clampXZ(o, max) {
  const l = Math.sqrt(o.x * o.x + o.z * o.z);
  if (l > max && l > 1e-9) {
    const s = max / l;
    o.x *= s;
    o.z *= s;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Deterministic RNG — xorshift128. Same seed => same match on every machine.
// ---------------------------------------------------------------------------

export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.seed(seed);
  }

  seed(s) {
    // Scramble the seed so nearby seeds diverge immediately.
    let x = (s >>> 0) || 0x9e3779b9;
    const next = () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      return x;
    };
    this.a = next(); this.b = next(); this.c = next(); this.d = next();
    return this;
  }

  /** uint32 */
  u32() {
    let t = this.d;
    const s = this.a;
    this.d = this.c;
    this.c = this.b;
    this.b = s;
    t ^= t << 11; t >>>= 0;
    t ^= t >>> 8;
    this.a = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.a;
  }

  /** [0,1) */
  f() { return this.u32() / 4294967296; }
  /** [-1,1) */
  s() { return this.f() * 2 - 1; }
  range(lo, hi) { return lo + this.f() * (hi - lo); }
  int(n) { return (this.u32() % n) | 0; }
  pick(arr) { return arr[this.int(arr.length)]; }

  save() { return [this.a, this.b, this.c, this.d]; }
  load(s) { this.a = s[0]; this.b = s[1]; this.c = s[2]; this.d = s[3]; return this; }
}

/** Non-deterministic RNG for pure-visual jitter (never touches sim state). */
export const vfxRng = new Rng((Math.random() * 0xffffffff) >>> 0);
