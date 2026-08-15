/**
 * Effects layer: everything that isn't the robots or the stage.
 *
 * Two design rules make this fast enough for a phone:
 *
 *  1. **GPU-integrated particles.** The CPU only writes a spawn record
 *     (origin, velocity, birth, life, size, colour). The vertex shader
 *     integrates ballistic motion from `uTime - birth`, so a thousand live
 *     sparks cost one buffer upload of the few slots that changed, not a
 *     thousand position updates per frame.
 *  2. **Fixed batches.** Every effect draws out of a small set of pre-allocated
 *     Points/InstancedMesh batches. Nothing here allocates during play.
 *
 * Emissive values are pushed above 1.0 on purpose — the bloom pass thresholds
 * around 0.92, and that headroom is where the neon look comes from.
 */

import * as THREE from 'three';
import { sprites } from './textures.js';
import { Noise } from './noise.js';
import { EV, PK } from '../sim/constants.js';
import { GUNS, BOMBS, PODS } from '../sim/parts.js';
import { MAX_PROJ } from '../sim/world.js';
import { vfxRng, clamp } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// Local sprite set
//
// These three live here rather than in textures.js because they exist purely to
// give the effects their read: a flash needs rays, a spark needs a long axis,
// and a fireball needs a turbulence field it can look up per pixel. All are
// generated once at boot and shared by every batch.
// ---------------------------------------------------------------------------

function paint(size, fn, { srgb = true, repeat = false } = {}) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = c.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1, d, (y * size + x) * 4, x, y);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

const g2 = (v, s) => Math.exp(-(v * v) / (s * s));

/**
 * Impact flash: a tiny white core, a four-ray cross and a shorter diagonal
 * cross. The rays are what make a single card read as *detonation* instead of
 * "soft dot" — and unlike an anamorphic streak it has no preferred axis, so it
 * looks deliberate at any billboard roll.
 */
function flashSprite() {
  return paint(256, (u, v, d, o) => {
    const r2 = u * u + v * v;
    const core = Math.exp(-r2 / 0.0022);
    const glow = Math.exp(-r2 / 0.045) * 0.5;
    const cross = g2(v, 0.026) * g2(u, 0.66) + g2(u, 0.026) * g2(v, 0.66);
    const ud = (u + v) * 0.7071, vd = (u - v) * 0.7071;
    const diag = (g2(vd, 0.017) * g2(ud, 0.38) + g2(ud, 0.017) * g2(vd, 0.38)) * 0.42;
    const a = Math.min(1, core + glow + cross * 0.8 + diag);
    d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
    d[o + 3] = a * 255;
  });
}

/**
 * Spark / debris streak, long axis on +X. The particle shader rotates it onto
 * the screen-space velocity, so every spark points along its own flight path
 * instead of being one more round dot.
 */
function streakSprite() {
  return paint(128, (u, v, d, o) => {
    const body = g2(u, 0.52) * g2(v, 0.085);
    const core = Math.exp(-((u * u) / 0.012 + (v * v) / 0.0024));
    const head = g2(u - 0.28, 0.13) * g2(v, 0.05);
    const a = Math.min(1, body * 0.55 + core * 0.9 + head * 0.7);
    d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
    d[o + 3] = a * 255;
  });
}

/** Tiling fbm used as the fireball's turbulence lookup. Raw values, no encode. */
function turbulenceSprite() {
  const n = new Noise(0x9e13);
  const S = 128;
  return paint(S, (u, v, d, o, x, y) => {
    // Blend the field with a shifted copy so the texture tiles without a seam.
    const fx = x / S, fy = y / S;
    const a1 = n.fbm2(fx * 4, fy * 4, 4) * 0.5 + 0.5;
    const a2 = n.fbm2((fx + 1) * 4, fy * 4, 4) * 0.5 + 0.5;
    const a3 = n.fbm2(fx * 4, (fy + 1) * 4, 4) * 0.5 + 0.5;
    const a4 = n.fbm2((fx + 1) * 4, (fy + 1) * 4, 4) * 0.5 + 0.5;
    const w = (1 - fx) * (1 - fy) * a1 + fx * (1 - fy) * a2 + (1 - fx) * fy * a3 + fx * fy * a4;
    const fine = n.fbm2(fx * 13, fy * 13, 3) * 0.5 + 0.5;
    d[o] = clamp(w, 0, 1) * 255;
    d[o + 1] = clamp(fine, 0, 1) * 255;
    d[o + 2] = clamp(w * fine * 1.6, 0, 1) * 255;
    d[o + 3] = 255;
  }, { srgb: false, repeat: true });
}

// ---------------------------------------------------------------------------
// GPU particle batch
// ---------------------------------------------------------------------------

const PARTICLE_VERT = /* glsl */`
attribute vec3 aVel;
attribute vec4 aParams;      // x: birth, y: life, z: size, w: drag
attribute vec3 aColor;
attribute vec3 aFlags;       // x: gravity, y: spin/seed, z: fadeMode

uniform float uTime;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uMaxSize;
uniform float uAlign;        // 1 = rotate the sprite onto screen-space velocity
uniform float uAspect;

varying vec3 vColor;
varying float vAlpha;
varying float vSeed;

void main() {
  float age = uTime - aParams.x;
  float life = aParams.y;

  if (age < 0.0 || age > life) {
    // Dead slots are collapsed to a degenerate point behind the camera.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }

  float t = age / life;

  // Exponential drag integrated analytically: p = p0 + v0 * (1 - e^-kt) / k
  float k = max(aParams.w, 0.0001);
  float decay = (1.0 - exp(-k * age)) / k;
  vec3 p = position + aVel * decay;
  p.y -= 0.5 * aFlags.x * age * age;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // fadeMode 0: fade out. 1: flash in then out. 2: hold then cut.
  float a;
  if (aFlags.z < 0.5)      a = 1.0 - t;
  else if (aFlags.z < 1.5) a = sin(t * 3.14159);
  else                     a = smoothstep(1.0, 0.75, t);

  // Sparks streak thin and long; smoke swells as it dissipates.
  float grow = aFlags.z < 1.5 ? (1.0 - t * 0.55) : (0.5 + t * 0.85);
  float size = aParams.z * grow * uSizeScale;

  float depth = -mv.z;

  // A point sprite's screen size goes to infinity as it approaches the near
  // plane, so a single puff drifting past the lens can fill the frame. Cap it,
  // and fade anything that ends up inside the camera's personal space.
  gl_PointSize = clamp(size * 640.0 * uPixelRatio / max(0.6, depth), 1.0, uMaxSize);
  a *= smoothstep(0.35, 2.2, depth);

  vColor = aColor;
  vAlpha = a;
  vSeed = aFlags.y;

  // Velocity-aligned sprites. A round dot carries no information about where a
  // spark came from or where it is going; a streak laid along the particle's own
  // screen-space path turns the same buffer into readable debris. The velocity
  // is the analytic derivative of the position above, so it stays exact under
  // drag and gravity.
  if (uAlign > 0.5) {
    vec3 vNow = aVel * exp(-k * age);
    vNow.y -= aFlags.x * age;
    vec4 c2 = projectionMatrix * (modelViewMatrix * vec4(p + vNow * 0.02, 1.0));
    vec2 s0 = gl_Position.xy / max(abs(gl_Position.w), 1e-4);
    vec2 s1 = c2.xy / max(abs(c2.w), 1e-4);
    vec2 dscr = (s1 - s0) * vec2(uAspect, 1.0);
    if (dot(dscr, dscr) > 1e-10) vSeed = atan(dscr.y, dscr.x);
  }
}`;

const PARTICLE_FRAG = /* glsl */`
precision mediump float;
uniform sampler2D uMap;
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
varying float vSeed;

void main() {
  if (vAlpha <= 0.001) discard;
  // Cheap per-particle rotation so smoke puffs don't obviously repeat.
  float s = sin(vSeed), c = cos(vSeed);
  vec2 uv = gl_PointCoord - 0.5;
  uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
  vec4 tex = texture2D(uMap, uv);
  float a = tex.a * vAlpha * uOpacity;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vColor * tex.rgb, a);
}`;

class ParticleBatch {
  constructor(capacity, map, { additive = true, opacity = 1, sizeScale = 1, renderOrder = 5, maxSize = 190, align = false } = {}) {
    this.capacity = capacity;
    this.cursor = 0;
    this.live = 0;

    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.color = new Float32Array(capacity * 3);
    this.flags = new Float32Array(capacity * 3);

    // Park every slot dead: birth far in the past, zero life.
    for (let i = 0; i < capacity; i++) this.params[i * 4 + 1] = 0;

    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage);
    this.aParams = new THREE.BufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage);
    this.aFlags = new THREE.BufferAttribute(this.flags, 3).setUsage(THREE.DynamicDrawUsage);

    g.setAttribute('position', this.aPos);
    g.setAttribute('aVel', this.aVel);
    g.setAttribute('aParams', this.aParams);
    g.setAttribute('aColor', this.aColor);
    g.setAttribute('aFlags', this.aFlags);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uMap: { value: map },
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uOpacity: { value: opacity },
        uSizeScale: { value: sizeScale },
        uMaxSize: { value: maxSize },
        uAlign: { value: align ? 1 : 0 },
        uAspect: { value: 16 / 9 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
      fog: false,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;

    this._dirtyLo = capacity;
    this._dirtyHi = 0;
  }

  /**
   * @param drag   exponential velocity decay (0 = none)
   * @param fade   0 fade-out, 1 flash, 2 hold-then-cut
   */
  spawn(x, y, z, vx, vy, vz, birth, life, size, r, g, b, gravity, drag, fade) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;

    const i3 = i * 3;
    const i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.params[i4] = birth;
    this.params[i4 + 1] = life;
    this.params[i4 + 2] = size;
    this.params[i4 + 3] = drag;
    this.color[i3] = r; this.color[i3 + 1] = g; this.color[i3 + 2] = b;
    this.flags[i3] = gravity;
    this.flags[i3 + 1] = vfxRng.f() * 6.283;
    this.flags[i3 + 2] = fade;

    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
  }

  flush(time) {
    this.material.uniforms.uTime.value = time;
    // Only re-upload on frames that actually spawned something. Between bursts
    // the GPU keeps integrating the existing slots for free.
    if (this._dirtyHi < this._dirtyLo) return;
    this.aPos.needsUpdate = true;
    this.aVel.needsUpdate = true;
    this.aParams.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aFlags.needsUpdate = true;
    this._dirtyLo = this.capacity;
    this._dirtyHi = 0;
  }

  clear() {
    this.params.fill(0);
    this.aParams.needsUpdate = true;
    this._dirtyLo = this.capacity;
    this._dirtyHi = 0;
    this.cursor = 0;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Tracer ribbons — one shared strip mesh for every live projectile
// ---------------------------------------------------------------------------

const TRAIL_VERT = /* glsl */`
attribute vec3 aDir;         // world-space direction along the ribbon
attribute float aSide;       // -1 / +1
attribute vec2 aMeta;        // x: t along the trail, y: width
attribute vec4 aTint;        // rgb + alpha scale
uniform float uMinWidth;     // view units per unit depth: a screen-space floor
varying float vT;
varying float vSide;
varying vec4 vTint;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Expand perpendicular to the segment IN VIEW SPACE, which is what makes the
  // ribbon face the camera regardless of which way the shot is travelling.
  vec3 dirV = mat3(modelViewMatrix) * aDir;
  vec2 perp = vec2(-dirV.y, dirV.x);
  float len = length(perp);
  perp = len > 0.0001 ? perp / len : vec2(1.0, 0.0);
  // Taper to a point at the tail, and never let the ribbon fall below a couple
  // of pixels wide: a sub-pixel core scintillates and then reads as a smudge
  // once bloom gets hold of the leftovers.
  float taper = pow(max(1.0 - aMeta.x, 0.0), 0.55);
  float w = max(aMeta.y, -mv.z * uMinWidth) * taper;
  mv.xy += perp * aSide * w;
  gl_Position = projectionMatrix * mv;
  vT = aMeta.x;
  vSide = aSide;
  vTint = aTint;
}`;

const TRAIL_FRAG = /* glsl */`
precision mediump float;
varying float vT;
varying float vSide;
varying vec4 vTint;
void main() {
  // Three parts, and all three are needed for a discharge to read: a hard white
  // core down the centre line, a tight coloured sheath either side of it, and a
  // head-to-tail brightness ramp that states which way the shot is travelling.
  float s = abs(vSide);
  float head = pow(1.0 - vT, 1.3);
  float core = smoothstep(0.44, 0.02, s);
  float sheath = exp(-s * s * 3.4);
  float a = (core * 0.9 + sheath * 0.38) * head * vTint.a;
  if (a <= 0.004) discard;
  vec3 col = vTint.rgb * (0.5 + head * 1.15)
           + vec3(1.0, 0.97, 0.93) * core * core * (0.7 + head * 2.4);
  gl_FragColor = vec4(col, a);
}`;

class TrailPool {
  constructor(slots, segments) {
    this.slots = slots;
    this.segments = segments;
    const verts = slots * segments * 2;
    const tris = slots * (segments - 1) * 2;

    this.position = new Float32Array(verts * 3);
    this.dir = new Float32Array(verts * 3);
    this.side = new Float32Array(verts);
    this.meta = new Float32Array(verts * 2);     // t along trail, half-width
    this.tint = new Float32Array(verts * 4);

    const index = new Uint16Array(tris * 3);
    let io = 0;
    for (let s = 0; s < slots; s++) {
      const base = s * segments * 2;
      for (let i = 0; i < segments - 1; i++) {
        const a = base + i * 2;
        index[io++] = a; index[io++] = a + 1; index[io++] = a + 2;
        index[io++] = a + 1; index[io++] = a + 3; index[io++] = a + 2;
      }
    }

    for (let s = 0; s < slots; s++) {
      for (let i = 0; i < segments; i++) {
        const v = (s * segments + i) * 2;
        this.side[v] = -1; this.side[v + 1] = 1;
        const t = i / (segments - 1);
        this.meta[v * 2] = t;
        this.meta[(v + 1) * 2] = t;
      }
    }
    this._maxLen = 6;

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    this.aDir = new THREE.BufferAttribute(this.dir, 3).setUsage(THREE.DynamicDrawUsage);
    this.aMeta = new THREE.BufferAttribute(this.meta, 2).setUsage(THREE.DynamicDrawUsage);
    this.aTint = new THREE.BufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aDir', this.aDir);
    g.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1));
    g.setAttribute('aMeta', this.aMeta);
    g.setAttribute('aTint', this.aTint);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      uniforms: { uMinWidth: { value: 0.0016 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;

    /** history[slot] = Float32Array(segments*3), newest at index 0. */
    this.history = [];
    this.used = new Uint8Array(slots);
    for (let s = 0; s < slots; s++) this.history.push(new Float32Array(segments * 3));
  }

  /** Push a new head position for a slot, shifting the history back. */
  push(slot, x, y, z, r, g, b, width, fresh, maxLen) {
    this._maxLen = maxLen || 6;
    const h = this.history[slot];
    const seg = this.segments;
    if (fresh || !this.used[slot]) {
      for (let i = 0; i < seg; i++) {
        h[i * 3] = x; h[i * 3 + 1] = y; h[i * 3 + 2] = z;
      }
    } else {
      for (let i = seg - 1; i > 0; i--) {
        h[i * 3] = h[(i - 1) * 3];
        h[i * 3 + 1] = h[(i - 1) * 3 + 1];
        h[i * 3 + 2] = h[(i - 1) * 3 + 2];
      }
      h[0] = x; h[1] = y; h[2] = z;
    }
    this.used[slot] = 1;
    this._write(slot, r, g, b, width);
  }

  _write(slot, r, g, b, width) {
    const seg = this.segments;
    const h = this.history[slot];
    const base = slot * seg * 2;
    const maxLen = this._maxLen;

    // The history holds one sample per rendered frame, so its world length is
    // whatever the projectile's speed happens to be times the frame time — at
    // 78 m/s that is a 25-metre banner draped across the arena. Walk the path
    // instead and cut it at a fixed world length, remapping the fade to real
    // distance travelled. The tracer is then the same readable blade whether it
    // came off a lance round or a lobbed pod.
    let acc = 0;
    let cutX = h[0], cutY = h[1], cutZ = h[2];
    let cut = false;

    for (let i = 0; i < seg; i++) {
      let px = h[i * 3], py = h[i * 3 + 1], pz = h[i * 3 + 2];

      if (!cut && i > 0) {
        const ax = h[(i - 1) * 3], ay = h[(i - 1) * 3 + 1], az = h[(i - 1) * 3 + 2];
        const sx = px - ax, sy = py - ay, sz = pz - az;
        const segLen = Math.hypot(sx, sy, sz);
        if (acc + segLen > maxLen) {
          const k = segLen > 1e-6 ? (maxLen - acc) / segLen : 0;
          px = ax + sx * k; py = ay + sy * k; pz = az + sz * k;
          acc = maxLen;
          cut = true;
          cutX = px; cutY = py; cutZ = pz;
        } else {
          acc += segLen;
        }
      } else if (cut) {
        px = cutX; py = cutY; pz = cutZ;
      }

      // Direction toward the previous sample gives the ribbon its orientation.
      const j = Math.min(seg - 1, i + 1);
      let dx = h[j * 3] - px, dy = h[j * 3 + 1] - py, dz = h[j * 3 + 2] - pz;
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-5) { dx = 0; dy = 1; dz = 0; } else { dx /= l; dy /= l; dz /= l; }

      const t = acc / maxLen;
      const v = base + i * 2;
      for (let k = 0; k < 2; k++) {
        const o = v + k;
        const o3 = o * 3;
        const o4 = o * 4;
        this.position[o3] = px; this.position[o3 + 1] = py; this.position[o3 + 2] = pz;
        this.dir[o3] = dx; this.dir[o3 + 1] = dy; this.dir[o3 + 2] = dz;
        this.meta[o * 2] = t;
        this.meta[o * 2 + 1] = width;
        this.tint[o4] = r; this.tint[o4 + 1] = g; this.tint[o4 + 2] = b;
        this.tint[o4 + 3] = cut && t >= 1 ? 0 : 1;
      }
    }
  }

  release(slot) {
    if (!this.used[slot]) return;
    this.used[slot] = 0;
    const seg = this.segments;
    const base = slot * seg * 2;
    for (let i = 0; i < seg * 2; i++) this.tint[(base + i) * 4 + 3] = 0;
  }

  flush() {
    this.aPos.needsUpdate = true;
    this.aDir.needsUpdate = true;
    this.aMeta.needsUpdate = true;
    this.aTint.needsUpdate = true;
  }

  clear() {
    for (let s = 0; s < this.slots; s++) this.release(s);
    this.flush();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Expanding shells (explosion cores, shockwave rings, muzzle flares)
// ---------------------------------------------------------------------------

/**
 * Shell modes. One shader, four jobs — a fireball, a shock ring, a billboard
 * flash card and a scorch decal — because each extra material is another draw
 * call and the budget for the whole effects layer is about a dozen.
 */
const SHELL_FIREBALL = 0;
const SHELL_RING = 1;
const SHELL_CARD = 2;
const SHELL_SOOT = 3;

const SHELL_VERT = /* glsl */`
attribute vec4 aLife;     // birth, life, scale0, scale1
attribute vec4 aTint;     // rgb + kind
attribute vec4 aMotion;   // local drift per second + seed
uniform float uTime;
uniform float uMode;
uniform float uEase;
varying float vT;
varying vec4 vTint;
varying vec2 vUv;
varying vec3 vLocal;
varying float vRim;
varying float vSeed;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash13(i + vec3(0.0, 0.0, 0.0)), hash13(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

void main() {
  float age = uTime - aLife.x;
  float t = age / max(aLife.y, 1e-4);
  if (age < 0.0 || t > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vT = 2.0;
    return;
  }
  // Fast out, slow settle — the classic detonation curve.
  float e = 1.0 - pow(1.0 - t, uEase);
  float s = mix(aLife.z, aLife.w, e);

  vec3 p = position;
  vLocal = normalize(position + 1e-5);
  if (uMode < 0.5 && aTint.w > 0.5) {
    // Push the surface in and out along two octaves of noise so the fireball is
    // a cluster of billows rather than a balloon, and let the lobes deepen as it
    // cools — that growth is what sells a mass of burning gas expanding.
    float n1 = vnoise(position * 1.7 + aMotion.w);
    float n2 = vnoise(position * 4.3 - aMotion.w * 1.7);
    float lump = (n1 - 0.5) * 0.9 + (n2 - 0.5) * 0.42;
    p *= 1.0 + lump * (0.24 + t * 0.66);
  }
  p *= s;
  p += aMotion.xyz * age;

  vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  vec3 nv = normalize((modelViewMatrix * instanceMatrix * vec4(vLocal, 0.0)).xyz);
  vRim = abs(nv.z);
  vUv = uv;
  vT = t;
  vTint = aTint;
  vSeed = aMotion.w;
  gl_Position = projectionMatrix * mv;
}`;

const SHELL_FRAG = /* glsl */`
precision mediump float;
varying float vT;
varying vec4 vTint;
varying vec2 vUv;
varying vec3 vLocal;
varying float vRim;
varying float vSeed;
uniform sampler2D uMap;
uniform float uUseMap;
uniform float uMode;

// Fire ramp, in linear light. Everything from ORANGE up is over 1.0 so it
// clears the bloom threshold; SMOKE and EMBER stay under it so the tail of the
// fireball cools *out* of the glow instead of staying lit forever.
const vec3 C_SMOKE  = vec3(0.055, 0.048, 0.046);
const vec3 C_EMBER  = vec3(0.90, 0.16, 0.03);
const vec3 C_ORANGE = vec3(2.30, 0.66, 0.07);
const vec3 C_YELLOW = vec3(3.30, 2.00, 0.42);
const vec3 C_WHITE  = vec3(4.40, 3.80, 3.00);

void main() {
  if (vT > 1.0 || vT < 0.0) discard;
  float fade = 1.0 - vT;
  vec3 col = vTint.rgb;
  float a;

  if (uMode > 2.5) {
    // Scorch marks are burnt material, not light: they must never brighten the
    // floor, and they linger rather than flash.
    a = smoothstep(0.0, 0.06, vT) * pow(fade, 0.8) * 0.5;
    vec4 tx = texture2D(uMap, vUv);
    col *= tx.rgb;
    a *= tx.a;
  } else if (uMode > 1.5) {
    // Billboard flash card. The hot phase is deliberately short — held any
    // longer and a nearby blast just reads as a white screen once bloom has it.
    col = mix(vec3(2.6, 2.3, 1.9) * col, col, smoothstep(0.0, 0.3, vT));
    col *= 0.4 + fade * 1.1;
    a = pow(fade, 1.7);
    vec4 tx = texture2D(uMap, vUv);
    col *= tx.rgb;
    a *= tx.a;
  } else if (uMode > 0.5) {
    // Shock ring: a thin bright front that races outward through the geometry
    // while the geometry itself expands. Kind 1 pins the band instead, for the
    // charge tell that collapses inward.
    float r = length(vUv - 0.5) * 2.0;
    float centre = vTint.w > 0.5 ? 0.80 : mix(0.5, 0.95, vT);
    float hw = vTint.w > 0.5 ? 0.12 : mix(0.30, 0.07, vT);
    float band = exp(-pow((r - centre) / hw, 2.0));
    float fill = (1.0 - smoothstep(centre - hw, centre + hw * 0.3, r)) * 0.16 * fade;
    a = (band + fill) * pow(fade, 1.3);
    col = col * (0.4 + band * 1.5) + vec3(1.0, 0.95, 0.88) * pow(band, 3.0) * fade * 1.3;
  } else {
    // Fireball. Two turbulence taps drive a temperature field that cools with
    // age; the ramp then carries it white -> yellow -> orange -> ember -> smoke.
    // The colour break-up is the whole point: an even ball of white is a puff of
    // steam, a broken one with cool pockets is an explosion.
    float cs = cos(vSeed), sn = sin(vSeed);
    vec2 nuv = vec2(vLocal.x * cs - vLocal.z * sn, vLocal.x * sn + vLocal.z * cs) * 0.42;
    nuv += vec2(vLocal.y * 0.28, -vT * 0.16);
    float t1 = texture2D(uMap, nuv).r;
    float t2 = texture2D(uMap, nuv * 2.7 + vec2(0.37, 0.11)).g;
    float turb = t1 * 0.68 + t2 * 0.32;

    float heat = clamp((1.0 - vT * 0.85) * (0.30 + turb * 1.30) - vT * 0.42, 0.0, 1.2);
    if (vTint.w < 0.5) heat = max(heat, 1.15 * pow(fade, 0.5));   // smooth flash core

    col = mix(C_SMOKE, C_EMBER, smoothstep(0.02, 0.24, heat));
    col = mix(col, C_ORANGE, smoothstep(0.22, 0.50, heat));
    col = mix(col, C_YELLOW, smoothstep(0.50, 0.78, heat));
    col = mix(col, C_WHITE, smoothstep(0.80, 1.06, heat));
    col *= mix(vec3(1.0), vTint.rgb, 0.35);

    a = smoothstep(0.03, 0.30, heat) * pow(fade, 0.7) * 0.62;
    a *= 0.30 + 0.70 * smoothstep(0.0, 0.5, vRim);
  }

  if (a <= 0.004) discard;
  gl_FragColor = vec4(col, a);
}`;

class ShellPool {
  constructor(geometry, capacity, map = null, { renderOrder = 7, mode = SHELL_FIREBALL, ease = 2.6 } = {}) {
    this.capacity = capacity;
    this.cursor = 0;
    this.life = new Float32Array(capacity * 4);
    this.tint = new Float32Array(capacity * 4);
    this.motion = new Float32Array(capacity * 4);

    const g = geometry;
    this.aLife = new THREE.InstancedBufferAttribute(this.life, 4).setUsage(THREE.DynamicDrawUsage);
    this.aTint = new THREE.InstancedBufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage);
    this.aMotion = new THREE.InstancedBufferAttribute(this.motion, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aLife', this.aLife);
    g.setAttribute('aTint', this.aTint);
    g.setAttribute('aMotion', this.aMotion);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: map },
        uUseMap: { value: map ? 1 : 0 },
        uMode: { value: mode },
        uEase: { value: ease },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });

    this.mesh = new THREE.InstancedMesh(g, this.material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);

    // Park everything dead.
    for (let i = 0; i < capacity; i++) this.life[i * 4 + 1] = 0;
  }

  spawn(x, y, z, quat, birth, life, from, to, r, g, b, kind = 0, mx = 0, my = 0, mz = 0) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;
    this._p.set(x, y, z);
    this._m.compose(this._p, quat || this._q.identity(), this._s);
    this.mesh.setMatrixAt(i, this._m);
    const i4 = i * 4;
    this.life[i4] = birth; this.life[i4 + 1] = life;
    this.life[i4 + 2] = from; this.life[i4 + 3] = to;
    this.tint[i4] = r; this.tint[i4 + 1] = g; this.tint[i4 + 2] = b; this.tint[i4 + 3] = kind;
    this.motion[i4] = mx; this.motion[i4 + 1] = my; this.motion[i4 + 2] = mz;
    this.motion[i4 + 3] = vfxRng.f() * 12.0;
    this._dirty = true;
  }

  flush(time) {
    this.material.uniforms.uTime.value = time;
    if (!this._dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aLife.needsUpdate = true;
    this.aTint.needsUpdate = true;
    this.aMotion.needsUpdate = true;
    this._dirty = false;
  }

  clear() {
    this.life.fill(0);
    this.aLife.needsUpdate = true;
    this.cursor = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Projectile bodies
// ---------------------------------------------------------------------------

/**
 * The bolt used to be a stretched octahedron shaded by its facing ratio. An
 * octahedron at detail 0 has eight *flat* facets, so the facing ratio is
 * constant across each one: every round rendered as three or four uniform
 * slabs with no interior structure at all. That is the "soft lozenge with no
 * hot centre" — it was not a tuning problem, the geometry could not express a
 * core.
 *
 * It is now a quad billboarded about its own velocity axis, with the core, the
 * sheath and the taper all built analytically from the UV. Two triangles, the
 * same single instanced draw call, and every pixel of the profile is authored.
 */
const BOLT_VERT = /* glsl */`
varying vec3 vTint;
varying vec2 vUv;
void main() {
  vTint = instanceColor;
  vUv = uv;

  // The CPU still hands us the same instance matrix it always did: column 2 is
  // the round's direction scaled by its length, column 0 carries the width, and
  // column 3 is the centre. We rebuild the quad in view space from those rather
  // than transforming the vertex directly, because a flat quad left in world
  // space would edge on to the lens and vanish at exactly the angles a duel
  // spends most of its time at.
  vec4 centre = modelViewMatrix * instanceMatrix[3];
  vec3 axis   = (modelViewMatrix * vec4(instanceMatrix[2].xyz, 0.0)).xyz;
  float halfW = length((modelViewMatrix * vec4(instanceMatrix[0].xyz, 0.0)).xyz);

  // Billboard about the velocity axis, not about the view axis. The side vector
  // is perpendicular to both the trajectory and the line of sight, so the round
  // always presents its full width to the camera while its nose keeps pointing
  // exactly where it is actually going. Degenerate only when you are looking
  // straight down the barrel, where the round covers a pixel anyway.
  vec3 along = normalize(axis);
  vec3 side  = cross(along, normalize(centre.xyz));
  float sl   = length(side);
  side = sl > 1e-4 ? side / sl : normalize(cross(along, vec3(0.0, 1.0, 0.0) + vec3(1e-3)));

  // position.y spans the length in local units, position.x the half-width, so
  // multiplying straight through by the instance columns reproduces the world
  // dimensions the old solid had — the silhouette changes, the sizing does not.
  vec3 p = centre.xyz + axis * position.y + side * (position.x * halfW);
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const BOLT_FRAG = /* glsl */`
precision mediump float;
varying vec3 vTint;
varying vec2 vUv;
void main() {
  // u: 0 at the tail, 1 at the nose (the quad's +Y is the velocity axis).
  // v: -1..1 across the round.
  float u = vUv.y;
  float v = (vUv.x - 0.5) * 2.0;

  // Dart silhouette. Full width behind the shoulder, pinched to a point at the
  // tail and rounded off over the last of the nose, so the shape alone says
  // which way the round is travelling.
  float hw = (0.08 + 0.92 * smoothstep(0.0, 0.58, u))
           * (1.0 - smoothstep(0.82, 1.0, u) * 0.94);
  float q = v / max(hw, 1e-3);
  float q2 = q * q;

  // Two nested profiles: a spine about a tenth of the width that is white-hot
  // and well over 1.0 so bloom picks it up as a line rather than a blob, and a
  // wider sheath carrying the part's colour.
  float core   = exp(-q2 * 52.0);
  float sheath = exp(-q2 * 3.4);

  // Everything ramps toward the nose. A tracer that is uniformly bright end to
  // end is a smear; one with a hot head and a cooling tail is a projectile.
  float lead = 0.18 + 0.82 * smoothstep(0.05, 0.92, u);
  float head = exp(-pow((u - 0.86) / 0.24, 2.0));

  vec3 col = vec3(3.4, 3.15, 2.85) * core * (0.85 + head * 1.5)
           + vTint * sheath * lead;
  float a = clamp(core * 1.1 + sheath * 0.62, 0.0, 1.0) * lead;

  if (a <= 0.004) discard;
  gl_FragColor = vec4(col, a);
}`;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fv = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const _col = new THREE.Color();

/** Emissive colours are pushed past 1.0 so the bloom threshold catches them. */
function hot(hex, boost, out) {
  _col.setHex(hex);
  out[0] = _col.r * boost;
  out[1] = _col.g * boost;
  out[2] = _col.b * boost;
  return out;
}

/** Hue with the value normalised out, for shaders that supply their own ramp. */
function hotNorm(hex, out) {
  _col.setHex(hex);
  const m = Math.max(_col.r, _col.g, _col.b, 1e-4);
  out[0] = _col.r / m;
  out[1] = _col.g / m;
  out[2] = _col.b / m;
  return out;
}

const _rgb = [0, 0, 0];

export class VFX {
  constructor(scene, settings, camera, theme) {
    this.scene = scene;
    this.settings = settings;
    this.camera = camera;
    this.theme = theme || {};
    this.time = 0;
    this.sp = sprites();
    this.tex = {
      flash: flashSprite(),
      streak: streakSprite(),
      turb: turbulenceSprite(),
    };

    const budget = settings.particleBudget;

    // --- particle batches -------------------------------------------------
    // Sparks are velocity-aligned streaks; smoke and energy stay round.
    this.sparks = new ParticleBatch(Math.round(budget * 0.5), this.tex.streak,
      { additive: true, sizeScale: 1.35, maxSize: 120, align: true });
    this.smoke = new ParticleBatch(Math.round(budget * 0.28), this.sp.smoke,
      { additive: false, opacity: 0.62, renderOrder: 4, maxSize: 150 });
    this.energy = new ParticleBatch(Math.round(budget * 0.22), this.sp.glow,
      { additive: true, sizeScale: 1.0, maxSize: 96 });
    scene.add(this.smoke.points, this.sparks.points, this.energy.points);

    // --- trails -----------------------------------------------------------
    this.trails = new TrailPool(Math.min(MAX_PROJ, 96), Math.max(4, settings.trailSegments));
    scene.add(this.trails.mesh);

    // --- expanding shells -------------------------------------------------
    const sphere = new THREE.IcosahedronGeometry(1, settings.bloomQuality >= 2 ? 3 : 2);
    this.fireballs = new ShellPool(sphere, 48, this.tex.turb, { mode: SHELL_FIREBALL, ease: 2.2 });
    scene.add(this.fireballs.mesh);

    // Nearly a disc: the visible ring is a travelling band inside the geometry,
    // so the front can start tight in the middle and race out to the rim.
    const ring = new THREE.RingGeometry(0.2, 1.0, 56, 1);
    ring.rotateX(-Math.PI / 2);
    this.shockwaves = new ShellPool(ring, 24, null, { renderOrder: 8, mode: SHELL_RING, ease: 3.0 });
    scene.add(this.shockwaves.mesh);

    const flareQuad = new THREE.PlaneGeometry(1, 1);
    this.flares = new ShellPool(flareQuad, 48, this.tex.flash, { renderOrder: 9, mode: SHELL_CARD, ease: 3.4 });
    scene.add(this.flares.mesh);

    // --- projectile bodies ------------------------------------------------
    this._buildProjectileMeshes();

    // --- decals -----------------------------------------------------------
    this._buildDecals();

    // --- dynamic explosion lights ----------------------------------------
    // Driven off the effect clock, not off dt. A blast light that decays per
    // frame is a different light at 30fps and at 144fps, and it is invisible in
    // a frozen capture; keyed to `time` it matches the fireball it belongs to.
    this.lights = [];
    this.lightBirth = [];
    this.lightLife = [];
    this.lightPeak = [];
    const lightCount = settings.lights >= 4 ? 3 : 1;
    for (let i = 0; i < lightCount; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 26, 2);
      l.visible = false;
      scene.add(l);
      this.lights.push(l);
      this.lightBirth.push(0);
      this.lightLife.push(0);
      this.lightPeak.push(0);
    }
    this.lightCursor = 0;

    // --- shake accumulator ------------------------------------------------
    this.shake = { x: 0, y: 0, z: 0, roll: 0 };
    this._shakeOut = { x: 0, y: 0, z: 0, roll: 0 };

    // Per-projectile-slot bookkeeping so trails and thrusters stay attached.
    this.slotAlive = new Uint8Array(MAX_PROJ);
    this.slotTrail = new Int16Array(MAX_PROJ).fill(-1);
    this.trailOwner = new Int16Array(this.trails.slots).fill(-1);
    this.prevPos = new Float32Array(MAX_PROJ * 3);

    // Rate limiting: identical impacts inside one frame collapse into one.
    this._impactBudget = 0;
    this._thrusterAccum = [0, 0];
  }

  // -------------------------------------------------------------------------

  _buildProjectileMeshes() {
    const cap = 128;

    // Bullets: two triangles, oriented about the trajectory in the vertex
    // shader. Scaled here so local +X spans the half-width and local +Y spans
    // the length in the same units the old solid used, which keeps every gun's
    // `look.width` / `look.len` tuning meaning what it meant before.
    const boltGeo = new THREE.PlaneGeometry(1, 1);
    boltGeo.scale(2.0, 4.8, 1);
    this.bolts = new THREE.InstancedMesh(
      boltGeo,
      new THREE.ShaderMaterial({
        vertexShader: BOLT_VERT,
        fragmentShader: BOLT_FRAG,
        uniforms: {},
        transparent: true, blending: THREE.AdditiveBlending,
        // The quad is re-oriented in view space, so its winding flips depending
        // on which side of the trajectory the camera is standing. Cull nothing.
        side: THREE.DoubleSide,
        depthWrite: false, toneMapped: false, fog: false,
      }),
      cap
    );
    this.bolts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bolts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.bolts.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.bolts.frustumCulled = false;
    this.bolts.renderOrder = 6;
    this.bolts.count = 0;
    this.scene.add(this.bolts);

    // Bomb shells: faceted, lit, so they read as physical objects among all the
    // energy effects.
    const bombGeo = new THREE.IcosahedronGeometry(1, 0);
    this.bombs = new THREE.InstancedMesh(
      bombGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.36, metalness: 0.85, envMapIntensity: 1.2 }),
      24
    );
    this.bombs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bombs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(24 * 3), 3);
    this.bombs.frustumCulled = false;
    this.bombs.castShadow = false;
    this.bombs.count = 0;
    this.scene.add(this.bombs);

    // Pods: a squat hovering drone body.
    const podGeo = new THREE.ConeGeometry(0.55, 1.2, 6);
    podGeo.rotateX(Math.PI / 2);
    this.pods = new THREE.InstancedMesh(
      podGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.9, emissive: 0x224466, emissiveIntensity: 1.4 }),
      12
    );
    this.pods.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pods.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(12 * 3), 3);
    this.pods.frustumCulled = false;
    this.pods.count = 0;
    this.scene.add(this.pods);

    this._m4 = new THREE.Matrix4();
    this._scaleV = new THREE.Vector3();
  }

  _buildDecals() {
    const cap = this.settings.decals;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.decals = new ShellPool(geo, cap, this.sp.smoke, { renderOrder: 3, mode: SHELL_SOOT, ease: 1.4 });
    this.decals.material.blending = THREE.NormalBlending;
    this.decals.material.depthWrite = false;
    this.decals.mesh.renderOrder = 3;
    this.scene.add(this.decals.mesh);
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  handleEvents(events, world) {
    this._impactBudget = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.type) {
        case EV.FIRE_GUN: this._muzzle(ev); break;
        case EV.FIRE_BOMB: this._launchPuff(ev, 0xffb84d); break;
        case EV.DEPLOY_POD: this._launchPuff(ev, 0x5ee0ff); break;
        case EV.HIT: this._hit(ev); break;
        case EV.EXPLODE: this._explode(ev); break;
        case EV.WALL_HIT: this._wallHit(ev); break;
        case EV.BULLET_EXPIRE: this._fizzle(ev); break;
        case EV.JUMP: this._jump(ev); break;
        case EV.AIR_DASH: this._dash(ev); break;
        case EV.LAND: this._land(ev); break;
        case EV.DOWN: this._down(ev); break;
        case EV.GET_UP: this._getUp(ev); break;
        case EV.CHARGE_READY: this._chargeReady(ev, world); break;
        case EV.KO: this._ko(ev, world); break;
      }
    }
  }

  _addShake(x, y, z, roll) {
    this.shake.x += x; this.shake.y += y; this.shake.z += z; this.shake.roll += roll;
  }

  /** Proximity falloff so a detonation across the arena doesn't rattle the lens. */
  _proximity(x, y, z) {
    const d = this.camera.position.distanceTo(_v.set(x, y, z));
    return clamp(1 - d / 34, 0.06, 1);
  }

  _budgetScale() {
    // Everything scales down together under a tight particle budget rather than
    // some effects vanishing entirely.
    return this.settings.particleBudget >= 1400 ? 1 : this.settings.particleBudget >= 600 ? 0.62 : 0.34;
  }

  _muzzle(ev) {
    const gun = GUNS.find((g) => g.id === ev.gun) || GUNS[0];
    const look = gun.look;
    const charged = ev.charged;
    const t = this.time;
    const s = this._budgetScale();

    const cp = Math.cos(ev.pitch || 0);
    const dx = Math.sin(ev.yaw || 0) * cp;
    const dy = Math.sin(ev.pitch || 0);
    const dz = Math.cos(ev.yaw || 0) * cp;

    hot(look.colour, charged ? 4.2 : 2.6, _rgb);

    // Flare card oriented to face the camera, scaled by the muzzle style. The
    // card is a rayed star, so it reads as a discharge at any billboard roll.
    const styleScale = look.muzzle === 'lance' ? 2.4 : look.muzzle === 'cone' ? 1.7 : 1.2;
    _v.set(ev.x + dx * 0.5, ev.y + dy * 0.5, ev.z + dz * 0.5);
    this.flares.spawn(
      _v.x, _v.y, _v.z, this._faceCamera(_v),
      t, charged ? 0.15 : 0.07,
      (charged ? 0.24 : 0.12) * styleScale, (charged ? 0.78 : 0.32) * styleScale,
      _rgb[0], _rgb[1], _rgb[2]
    );

    // A pop of sparks along the barrel line.
    const n = Math.round((charged ? 22 : 7) * s);
    for (let i = 0; i < n; i++) {
      const sp = (charged ? 14 : 8) * (0.4 + vfxRng.f());
      this.sparks.spawn(
        ev.x, ev.y, ev.z,
        dx * sp + vfxRng.s() * 2.4, dy * sp + vfxRng.s() * 2.4 + 0.6, dz * sp + vfxRng.s() * 2.4,
        t, 0.1 + vfxRng.f() * 0.14, (charged ? 0.075 : 0.05) * (0.6 + vfxRng.f()),
        _rgb[0], _rgb[1], _rgb[2], 4, 3.2, 0
      );
    }

    // Recoil smoke wisp.
    if (this.settings.particleBudget >= 600) {
      for (let i = 0; i < Math.round(2 * s) + 1; i++) {
        this.smoke.spawn(
          ev.x + dx * 0.3, ev.y + dy * 0.3, ev.z + dz * 0.3,
          dx * 1.6 + vfxRng.s(), dy * 1.6 + 0.9, dz * 1.6 + vfxRng.s(),
          t, 0.5 + vfxRng.f() * 0.3, 0.08 + vfxRng.f() * 0.05,
          0.26, 0.27, 0.31, -0.6, 2.2, 2
        );
      }
    }

    this._addShake(
      vfxRng.s() * (charged ? 0.09 : 0.016),
      vfxRng.s() * (charged ? 0.07 : 0.012),
      vfxRng.s() * (charged ? 0.09 : 0.016),
      vfxRng.s() * (charged ? 0.006 : 0.001)
    );
  }

  /**
   * Billboard quaternion for a card at world position `p`.
   * The card geometry faces +Z, so we rotate +Z onto the view vector.
   */
  _faceCamera(p) {
    _fv.copy(this.camera.position).sub(p);
    if (_fv.lengthSq() < 1e-8) _fv.set(0, 0, 1);
    _fv.normalize();
    _q.setFromUnitVectors(FORWARD, _fv);
    return _q;
  }

  /** Same, for the ring geometry — its plane normal is +Y, not +Z. */
  _faceCameraUp(p) {
    _fv.copy(this.camera.position).sub(p);
    if (_fv.lengthSq() < 1e-8) _fv.set(0, 1, 0);
    _fv.normalize();
    _q.setFromUnitVectors(_up, _fv);
    return _q;
  }

  _launchPuff(ev, colour) {
    const t = this.time;
    const s = this._budgetScale();
    hot(colour, 2.0, _rgb);
    _v.set(ev.x, ev.y, ev.z);
    this.flares.spawn(ev.x, ev.y, ev.z, this._faceCamera(_v), t, 0.16, 0.1, 0.34,
      _rgb[0], _rgb[1], _rgb[2]);
    for (let i = 0; i < Math.round(10 * s); i++) {
      const a = vfxRng.f() * 6.283;
      this.sparks.spawn(
        ev.x, ev.y, ev.z,
        Math.cos(a) * 3, 1.5 + vfxRng.f() * 2, Math.sin(a) * 3,
        t, 0.25 + vfxRng.f() * 0.2, 0.06,
        _rgb[0], _rgb[1], _rgb[2], 6, 2.6, 0
      );
    }
  }

  _hit(ev) {
    const t = this.time;
    const s = this._budgetScale();
    // Collapse a burst of near-simultaneous impacts into a few visible ones.
    if (this._impactBudget++ > 6) return;

    const nx = ev.nx || 0, ny = ev.ny || 1, nz = ev.nz || 0;
    const surface = !!ev.surface;
    const heavy = !!(ev.heavy || ev.charged);

    const colour = surface ? 0xffd9a0 : 0xfff0d0;
    hot(colour, heavy ? 4.0 : 2.8, _rgb);

    const n = Math.round((heavy ? 26 : 11) * s);
    for (let i = 0; i < n; i++) {
      // Cone around the surface normal, with a wide skirt.
      const spread = heavy ? 1.5 : 1.0;
      const vx = nx * 7 + vfxRng.s() * 6 * spread;
      const vy = ny * 7 + vfxRng.s() * 5 * spread + 1.5;
      const vz = nz * 7 + vfxRng.s() * 6 * spread;
      this.sparks.spawn(
        ev.x, ev.y, ev.z, vx, vy, vz,
        t, 0.2 + vfxRng.f() * 0.36, 0.04 + vfxRng.f() * 0.045,
        _rgb[0], _rgb[1], _rgb[2], 20, 0.9, 0
      );
    }

    // Flash card — the whole impact read, on one billboard, gone in ~90ms.
    _v.set(ev.x, ev.y, ev.z);
    this.flares.spawn(ev.x, ev.y, ev.z, this._faceCamera(_v), t,
      heavy ? 0.12 : 0.06, 0.1, heavy ? 0.62 : 0.3, _rgb[0], _rgb[1], _rgb[2]);

    if (surface) {
      // A ring only ever lies on the surface it hit, never free in the air, and
      // it is gone inside 150ms. Rings that hang around at arbitrary angles are
      // what turned the old arena into a field of grey donuts.
      _q.setFromUnitVectors(_up, _v2.set(nx, ny, nz).normalize());
      this.shockwaves.spawn(
        ev.x + nx * 0.03, ev.y + ny * 0.03, ev.z + nz * 0.03, _q,
        t, heavy ? 0.15 : 0.11, 0.2, heavy ? 1.5 : 0.85,
        _rgb[0] * 1.1, _rgb[1] * 1.0, _rgb[2] * 0.85
      );
      this._decal(ev.x, ev.y, ev.z, nx, ny, nz, heavy ? 1.1 : 0.55);
    } else {
      // Armour hit: a second, tighter flash instead of a ring. Nothing about a
      // round bouncing off a chest plate says "expanding disc on the ground".
      this.flares.spawn(ev.x, ev.y, ev.z, this._faceCamera(_v), t + 0.02,
        heavy ? 0.16 : 0.08, 0.06, heavy ? 0.34 : 0.16, 3.4, 2.4, 1.6);
      const prox = this._proximity(ev.x, ev.y, ev.z);
      const mag = (heavy ? 0.24 : 0.06) * prox;
      this._addShake(vfxRng.s() * mag, vfxRng.s() * mag * 0.7, vfxRng.s() * mag, vfxRng.s() * mag * 0.05);
    }
  }

  _decal(x, y, z, nx, ny, nz, size) {
    if (!this.settings.decals) return;
    _q.setFromUnitVectors(_v2.set(0, 0, 1), _v.set(nx, ny, nz).normalize());
    this.decals.spawn(
      x + nx * 0.012, y + ny * 0.012, z + nz * 0.012, _q,
      this.time, 7.5, size, size * 1.05, 0.05, 0.04, 0.045
    );
  }

  _explode(ev) {
    const isPod = ev.kind === PK.POD;
    const part = isPod ? PODS[ev.part] || PODS[0] : BOMBS[ev.part] || BOMBS[0];
    this._detonate(ev.x, ev.y, ev.z, ev.radius || 3, part.look.colour);
  }

  /**
   * A detonation in legible stages, because "one bright ball" is a puff of
   * steam. In order of what the eye catches:
   *
   *   0-80ms    flash — rayed card plus a smooth white core, over before you
   *             can focus on it, but it is what makes the hit feel *hard*
   *   0-700ms   fireball — a cluster of turbulent billows cooling through
   *             white → yellow → orange → ember, rising as they cool
   *   0-350ms   shock — a thin bright front racing out along the deck
   *   50ms-1.3s dust wave — pale, fast, flat, hugging the floor
   *   100ms-3s  smoke column — dark, slow, rising: the opposite read to dust
   *   0-1.5s    debris — sparks and chunks on sim gravity, arcing and falling
   *   0-550ms   light — the blast throws real light onto the arena
   *
   * Positional args rather than an event object: this is called from event
   * handling, where allocating anything at all is off the table.
   */
  _detonate(x, y, z, R, colourHex) {
    const t = this.time;
    const s = this._budgetScale();
    const scale = clamp(R / 3.4, 0.55, 2.0);
    const grounded = y < 3.2;
    const deck = 0.06;

    // Hue only — the fire ramp in the shader supplies the value, the part just
    // leans it. An HE bomb and a plasma pod should not be the same colour.
    hotNorm(colourHex, _rgb);
    const hr = _rgb[0], hg = _rgb[1], hb = _rgb[2];

    // --- 1. flash ---------------------------------------------------------
    _v.set(x, y, z);
    this.flares.spawn(x, y, z, this._faceCamera(_v), t, 0.1,
      R * 0.3, R * 2.0, 5.4, 4.7, 3.7);
    this.fireballs.spawn(x, y, z, null, t, 0.14, R * 0.05, R * 0.66,
      1.0, 0.95, 0.86, 0);

    // --- 2. fireball cluster ---------------------------------------------
    this.fireballs.spawn(x, y + R * 0.05, z, null, t, 0.66, R * 0.16, R * 0.82,
      hr, hg, hb, 1, 0, R * 0.22, 0);
    const billows = Math.round(5 * (s > 0.5 ? 1 : 0.6));
    for (let i = 0; i < billows; i++) {
      const a = (i / billows) * 6.283 + vfxRng.f() * 0.9;
      const el = vfxRng.f() * 0.9 - 0.15;
      const ca = Math.cos(a) * Math.cos(el), sa = Math.sin(a) * Math.cos(el);
      const rad = R * (0.2 + vfxRng.f() * 0.28);
      this.fireballs.spawn(
        x + ca * rad, y + Math.sin(el) * rad * 0.7 + R * 0.05, z + sa * rad, null,
        t + i * 0.028, 0.5 + vfxRng.f() * 0.36, R * 0.1, R * (0.36 + vfxRng.f() * 0.2),
        hr, hg, hb, 1,
        ca * R * 0.5, R * (0.35 + vfxRng.f() * 0.5), sa * R * 0.5
      );
    }

    // --- 3. shock front ---------------------------------------------------
    if (grounded) {
      this.shockwaves.spawn(x, deck, z, null, t, 0.19, R * 0.45, R * 2.1,
        3.8, 2.9, 1.8, 0);
      this.shockwaves.spawn(x, deck, z, null, t + 0.035, 0.3, R * 0.8, R * 3.3,
        1.7, 1.15, 0.7, 0);
    } else {
      this.shockwaves.spawn(x, y, z, null, t, 0.16, R * 0.4, R * 1.9,
        3.2, 2.4, 1.6, 0);
    }

    // --- 4. ground-hugging dust wave -------------------------------------
    // Pale, flat and fast, with enough drag that it piles up at the end of its
    // run. Deliberately a different colour, speed and direction from the smoke
    // column so the two never read as one grey mass.
    if (grounded) {
      const dustN = Math.round(16 * s * scale);
      for (let i = 0; i < dustN; i++) {
        const a = (i / dustN) * 6.283 + vfxRng.s() * 0.5;
        const ca = Math.cos(a), sa = Math.sin(a);
        const sp = R * (2.4 + vfxRng.f() * 1.6);
        this.smoke.spawn(
          x + ca * R * 0.25, deck + 0.06 + vfxRng.f() * 0.2, z + sa * R * 0.25,
          ca * sp, 0.35 + vfxRng.f() * 0.55, sa * sp,
          t + vfxRng.f() * 0.05, 1.0 + vfxRng.f() * 0.7, R * (0.09 + vfxRng.f() * 0.05),
          1.0, 0.88, 0.74, -0.22, 2.8, 2
        );
      }
    }

    // --- 5. smoke column --------------------------------------------------
    const smokeN = Math.round(10 * s * scale);
    for (let i = 0; i < smokeN; i++) {
      const a = vfxRng.f() * 6.283;
      const rad = vfxRng.f() * R * 0.35;
      this.smoke.spawn(
        x + Math.cos(a) * rad, y + vfxRng.f() * R * 0.4, z + Math.sin(a) * rad,
        Math.cos(a) * 1.3, 2.6 + vfxRng.f() * 2.4, Math.sin(a) * 1.3,
        t + 0.05 + vfxRng.f() * 0.3, 1.7 + vfxRng.f() * 1.2, R * (0.12 + vfxRng.f() * 0.08),
        0.17, 0.155, 0.15, -0.5, 1.1, 2
      );
    }

    // --- 6. debris --------------------------------------------------------
    // Gravity 26 is the sim's own constant, so the arcs match how a knocked-down
    // robo falls. Low drag keeps them ballistic instead of floaty.
    const sparkN = Math.round(66 * s * scale);
    for (let i = 0; i < sparkN; i++) {
      const a = vfxRng.f() * 6.283;
      const el = vfxRng.f() * 1.5 - 0.15;
      const ce = Math.cos(el);
      const sp = R * (1.5 + vfxRng.f() * 3.6);
      const heat = 0.55 + vfxRng.f() * 0.8;
      this.sparks.spawn(
        x, y, z,
        Math.cos(a) * ce * sp, Math.sin(el) * sp + 4.5, Math.sin(a) * ce * sp,
        t, 0.5 + vfxRng.f() * 1.0, 0.04 + vfxRng.f() * 0.06,
        3.6 * heat, 2.1 * heat * heat, 0.7 * heat * heat * heat,
        26, 0.22, 0
      );
    }

    const chunkN = Math.round(12 * s * scale);
    for (let i = 0; i < chunkN; i++) {
      const a = vfxRng.f() * 6.283;
      const el = vfxRng.f() * 1.1 + 0.1;
      const ce = Math.cos(el);
      const sp = R * (1.1 + vfxRng.f() * 1.9);
      // Opaque and unlit: a tumbling fragment of the shell casing, not a spark.
      this.smoke.spawn(
        x, y, z,
        Math.cos(a) * ce * sp, Math.sin(el) * sp + 3.5, Math.sin(a) * ce * sp,
        t, 0.7 + vfxRng.f() * 0.7, R * (0.018 + vfxRng.f() * 0.02),
        0.13, 0.115, 0.105, 26, 0.1, 0
      );
    }

    // --- 7. light on the arena -------------------------------------------
    const li = this.lightCursor % this.lights.length;
    this.lightCursor++;
    const l = this.lights[li];
    l.position.set(x, y + 0.45, z);
    l.color.setRGB(1.0, 0.6, 0.26);
    l.distance = R * 9;
    l.visible = true;
    this.lightBirth[li] = t;
    this.lightLife[li] = 0.55;
    this.lightPeak[li] = 260 * scale;
    l.intensity = this.lightPeak[li];

    const prox = this._proximity(x, y, z);
    const mag = scale * prox * 0.8;
    this._addShake(vfxRng.s() * mag, vfxRng.s() * mag * 0.8, vfxRng.s() * mag, vfxRng.s() * mag * 0.05);

    if (grounded) this._decal(x, 0.001, z, 0, 1, 0, R * 0.9);
  }

  _wallHit(ev) {
    if (ev.soft) return;
    const t = this.time;
    hot(0xbfd8ff, 1.6, _rgb);
    for (let i = 0; i < Math.round(6 * this._budgetScale()); i++) {
      this.sparks.spawn(
        ev.x, ev.y, ev.z,
        (ev.nx || 0) * 3 + vfxRng.s() * 2, 1.5 + vfxRng.f() * 2, (ev.nz || 0) * 3 + vfxRng.s() * 2,
        t, 0.22 + vfxRng.f() * 0.2, 0.04, _rgb[0], _rgb[1], _rgb[2], 14, 1.6, 0
      );
    }
  }

  _fizzle(ev) {
    const t = this.time;
    const gun = GUNS[ev.part] || GUNS[0];
    hot(gun.look.colour, 1.5, _rgb);
    _v.set(ev.x, ev.y, ev.z);
    this.flares.spawn(ev.x, ev.y, ev.z, this._faceCamera(_v), t, 0.13, 0.22, 0.02,
      _rgb[0], _rgb[1], _rgb[2]);
  }

  _jump(ev) {
    const t = this.time;
    const s = this._budgetScale();
    const air = !!ev.air;
    hot(air ? 0x9fd8ff : 0xcfd8e4, air ? 2.2 : 1.1, _rgb);

    if (!air) {
      // Ground kick: dust only. A takeoff does not warrant a shock ring, and
      // every ring that is not an impact is one more donut on the floor.
      for (let i = 0; i < Math.round(12 * s); i++) {
        const a = vfxRng.f() * 6.283;
        this.smoke.spawn(
          ev.x, ev.y + 0.06, ev.z,
          Math.cos(a) * 3.4, 0.7 + vfxRng.f(), Math.sin(a) * 3.4,
          t, 0.5 + vfxRng.f() * 0.3, 0.09 + vfxRng.f() * 0.06,
          0.62, 0.58, 0.52, -0.2, 3.2, 2
        );
      }
    }

    for (let i = 0; i < Math.round((air ? 20 : 10) * s); i++) {
      this.sparks.spawn(
        ev.x + vfxRng.s() * 0.2, ev.y + 0.3, ev.z + vfxRng.s() * 0.2,
        vfxRng.s() * 3, -2 - vfxRng.f() * 4, vfxRng.s() * 3,
        t, 0.2 + vfxRng.f() * 0.2, 0.06, _rgb[0], _rgb[1], _rgb[2], 2, 3.5, 0
      );
    }
  }

  _dash(ev) {
    const t = this.time;
    const s = this._budgetScale();
    hot(0x8fd0ff, 2.6, _rgb);
    const dx = ev.dx || 0, dz = ev.dz || 0;

    // Speed-line streaks trailing the dash vector.
    for (let i = 0; i < Math.round(22 * s); i++) {
      const back = vfxRng.f();
      this.energy.spawn(
        ev.x - dx * back * 1.6 + vfxRng.s() * 0.35,
        ev.y + 0.3 + vfxRng.f() * 1.1,
        ev.z - dz * back * 1.6 + vfxRng.s() * 0.35,
        -dx * 7 + vfxRng.s() * 1.5, vfxRng.s() * 1.2, -dz * 7 + vfxRng.s() * 1.5,
        t, 0.22 + vfxRng.f() * 0.16, 0.1 + vfxRng.f() * 0.08,
        _rgb[0], _rgb[1], _rgb[2], 0, 4.5, 1
      );
    }

    // Boost cone at the back.
    _v.set(ev.x - dx * 0.3, ev.y + 0.6, ev.z - dz * 0.3);
    this.flares.spawn(_v.x, _v.y, _v.z, this._faceCamera(_v), t, 0.18, 0.14, 0.44,
      _rgb[0], _rgb[1], _rgb[2]);

    if (!ev.air) {
      for (let i = 0; i < Math.round(7 * s); i++) {
        const a = vfxRng.f() * 6.283;
        this.smoke.spawn(
          ev.x - dx * 0.2, ev.y + 0.08, ev.z - dz * 0.2,
          Math.cos(a) * 2.4 - dx * 2.5, 0.5 + vfxRng.f() * 0.6, Math.sin(a) * 2.4 - dz * 2.5,
          t, 0.4 + vfxRng.f() * 0.25, 0.08 + vfxRng.f() * 0.05,
          0.58, 0.55, 0.5, -0.2, 3.4, 2
        );
      }
    }
    const prox = this._proximity(ev.x, ev.y, ev.z);
    this._addShake(vfxRng.s() * 0.05 * prox, 0, vfxRng.s() * 0.05 * prox, 0);
  }

  _land(ev) {
    const t = this.time;
    const s = this._budgetScale();
    const hard = !!ev.hard;
    const power = clamp((ev.speed || 6) / 16, 0.25, 1.6);

    // Only a hard landing gets a ring, and only for a sixth of a second.
    if (hard) {
      this.shockwaves.spawn(ev.x, ev.y + 0.04, ev.z, null, t,
        0.17, 0.4, 3.0 * power, 2.6, 2.5, 2.3, 0);
    }

    const n = Math.round((hard ? 22 : 9) * s * power);
    for (let i = 0; i < n; i++) {
      const a = vfxRng.f() * 6.283;
      const sp = (hard ? 6.5 : 3.4) * (0.5 + vfxRng.f());
      this.smoke.spawn(
        ev.x + Math.cos(a) * 0.3, ev.y + 0.08, ev.z + Math.sin(a) * 0.3,
        Math.cos(a) * sp, 0.4 + vfxRng.f() * 0.7, Math.sin(a) * sp,
        t, 0.55 + vfxRng.f() * 0.45, 0.1 + vfxRng.f() * 0.08,
        0.66, 0.62, 0.56, -0.15, 2.8, 2
      );
    }
    if (hard) {
      hot(0xffe0a8, 1.6, _rgb);
      for (let i = 0; i < Math.round(14 * s); i++) {
        const a = vfxRng.f() * 6.283;
        this.sparks.spawn(
          ev.x, ev.y + 0.05, ev.z,
          Math.cos(a) * 6, 1.5 + vfxRng.f() * 2, Math.sin(a) * 6,
          t, 0.3 + vfxRng.f() * 0.3, 0.05, _rgb[0], _rgb[1], _rgb[2], 16, 1.6, 0
        );
      }
      const prox = this._proximity(ev.x, ev.y, ev.z);
      this._addShake(0, -0.14 * power * prox, 0, vfxRng.s() * 0.01);
    }
  }

  _down(ev) {
    const t = this.time;
    const s = this._budgetScale();
    hot(0xff8a4d, 2.2, _rgb);
    for (let i = 0; i < Math.round(26 * s); i++) {
      const a = vfxRng.f() * 6.283;
      this.sparks.spawn(
        ev.x, ev.y + 0.9, ev.z,
        Math.cos(a) * 5, 2 + vfxRng.f() * 4, Math.sin(a) * 5,
        t, 0.4 + vfxRng.f() * 0.5, 0.06, _rgb[0], _rgb[1], _rgb[2], 18, 1.2, 0
      );
    }
    _v.set(ev.x, ev.y + 0.9, ev.z);
    this.flares.spawn(_v.x, _v.y, _v.z, this._faceCamera(_v), t, 0.24, 0.16, 0.6,
      _rgb[0], _rgb[1], _rgb[2]);
    this._addShake(vfxRng.s() * 0.2, vfxRng.s() * 0.15, vfxRng.s() * 0.2, vfxRng.s() * 0.02);
  }

  _getUp(ev) {
    const t = this.time;
    const s = this._budgetScale();
    hot(0xa8e0ff, 2.6, _rgb);
    this.shockwaves.spawn(ev.x, ev.y + 0.04, ev.z, null, t, 0.16, 0.3, 2.0,
      _rgb[0], _rgb[1], _rgb[2], 0);
    for (let i = 0; i < Math.round(8 * s); i++) {
      const a = vfxRng.f() * 6.283;
      this.smoke.spawn(
        ev.x, ev.y + 0.07, ev.z,
        Math.cos(a) * 3.0, 0.5 + vfxRng.f() * 0.5, Math.sin(a) * 3.0,
        t, 0.5 + vfxRng.f() * 0.3, 0.09 + vfxRng.f() * 0.05,
        0.6, 0.57, 0.52, -0.15, 3.0, 2
      );
    }
  }

  _chargeReady(ev, world) {
    const r = world?.robos?.[ev.id];
    if (!r) return;
    const t = this.time;
    const s = this._budgetScale();
    hot(0xffe27a, 3.0, _rgb);
    // Energy streaming inward, so the tell reads as a gathering, not a burst.
    for (let i = 0; i < Math.round(26 * s); i++) {
      const a = vfxRng.f() * 6.283;
      const rad = 1.6 + vfxRng.f() * 1.4;
      const px = r.pos.x + Math.cos(a) * rad;
      const py = r.pos.y + 0.4 + vfxRng.f() * 1.4;
      const pz = r.pos.z + Math.sin(a) * rad;
      this.energy.spawn(
        px, py, pz,
        (r.pos.x - px) * 3.4, (r.pos.y + 1.0 - py) * 3.4, (r.pos.z - pz) * 3.4,
        t, 0.3, 0.09, _rgb[0], _rgb[1], _rgb[2], 0, 0.4, 1
      );
    }
    // Kind 1: the band is pinned to the geometry, so the whole ring converges on
    // the robo as the shell shrinks — a gathering, not a blast.
    _v.set(r.pos.x, r.pos.y + 1.0, r.pos.z);
    this.shockwaves.spawn(_v.x, _v.y, _v.z, this._faceCameraUp(_v),
      t, 0.3, 2.1, 0.45, _rgb[0], _rgb[1], _rgb[2], 1);
  }

  _ko(ev, world) {
    const loser = ev.winner < 0 ? -1 : 1 - ev.winner;
    const r = loser >= 0 ? world?.robos?.[loser] : null;
    if (!r) return;
    // Reuse the detonation recipe at a much larger radius, twice, offset in time.
    this._detonate(r.pos.x, r.pos.y + 0.9, r.pos.z, 6.5, 0xffd166);
    this.fireballs.spawn(r.pos.x, r.pos.y + 1.2, r.pos.z, null, this.time + 0.12, 0.9, 0.35, 4.6,
      1.0, 0.72, 0.4, 1, 0, 2.2, 0);
    this._addShake(vfxRng.s() * 1.2, 0.6, vfxRng.s() * 1.2, vfxRng.s() * 0.06);

    // Lingering smoke column.
    const s = this._budgetScale();
    for (let i = 0; i < Math.round(26 * s); i++) {
      this.smoke.spawn(
        r.pos.x + vfxRng.s() * 0.8, r.pos.y + 0.4 + vfxRng.f() * 1.5, r.pos.z + vfxRng.s() * 0.8,
        vfxRng.s() * 1.2, 1.6 + vfxRng.f() * 1.8, vfxRng.s() * 1.2,
        this.time + vfxRng.f() * 0.7, 2.0 + vfxRng.f() * 1.4, 0.22 + vfxRng.f() * 0.18,
        0.19, 0.18, 0.18, -0.5, 0.9, 2
      );
    }
  }

  // -------------------------------------------------------------------------
  // Continuous emitters
  // -------------------------------------------------------------------------

  thruster(index, pos, dx, dy, dz, intensity, teamColor) {
    // Emit on a budget rather than every frame — the visual difference is nil
    // and the buffer traffic is halved.
    this._thrusterAccum[index] += intensity * 0.9;
    if (this._thrusterAccum[index] < 1) return;
    this._thrusterAccum[index] -= 1;

    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    hot(teamColor, 1.6 + intensity * 1.4, _rgb);
    const sp = 2.5 + intensity * 4;

    this.energy.spawn(
      pos.x + vfxRng.s() * 0.1, pos.y + vfxRng.s() * 0.1, pos.z + vfxRng.s() * 0.1,
      dx * sp + vfxRng.s() * 1.2, dy * sp + vfxRng.s() * 1.2, dz * sp + vfxRng.s() * 1.2,
      this.time, 0.16 + vfxRng.f() * 0.14, 0.06 + intensity * 0.05,
      _rgb[0], _rgb[1], _rgb[2], 0, 5.5, 1
    );

    if (intensity > 0.8 && this.settings.particleBudget >= 600) {
      this.smoke.spawn(
        pos.x, pos.y, pos.z,
        dx * 2 + vfxRng.s(), dy * 2 + 0.4, dz * 2 + vfxRng.s(),
        this.time, 0.4 + vfxRng.f() * 0.25, 0.06,
        0.24, 0.25, 0.3, -0.4, 3.0, 2
      );
    }
  }

  // -------------------------------------------------------------------------
  // Projectiles
  // -------------------------------------------------------------------------

  syncProjectiles(world, alpha) {
    let boltCount = 0, bombCount = 0, podCount = 0;
    const proj = world.proj;

    for (let i = 0; i < proj.length; i++) {
      const p = proj[i];
      const i3 = i * 3;

      if (!p.alive) {
        if (this.slotAlive[i]) {
          this.slotAlive[i] = 0;
          const ts = this.slotTrail[i];
          if (ts >= 0) {
            this.trails.release(ts);
            this.trailOwner[ts] = -1;
            this.slotTrail[i] = -1;
          }
        }
        continue;
      }

      // Extrapolate between ticks so fast bolts don't visibly step.
      const px = p.pos.x + p.vel.x * alpha * (1 / 60);
      const py = p.pos.y + p.vel.y * alpha * (1 / 60);
      const pz = p.pos.z + p.vel.z * alpha * (1 / 60);

      const fresh = !this.slotAlive[i];
      this.slotAlive[i] = 1;
      this.prevPos[i3] = px; this.prevPos[i3 + 1] = py; this.prevPos[i3 + 2] = pz;

      switch (p.kind) {
        case PK.BULLET: boltCount = this._drawBolt(p, i, px, py, pz, fresh, boltCount); break;
        case PK.BOMB: bombCount = this._drawBomb(p, i, px, py, pz, fresh, bombCount); break;
        case PK.POD: podCount = this._drawPod(p, i, px, py, pz, fresh, podCount); break;
      }
    }

    this.bolts.count = boltCount;
    this.bombs.count = bombCount;
    this.pods.count = podCount;
    if (boltCount) { this.bolts.instanceMatrix.needsUpdate = true; this.bolts.instanceColor.needsUpdate = true; }
    if (bombCount) { this.bombs.instanceMatrix.needsUpdate = true; this.bombs.instanceColor.needsUpdate = true; }
    if (podCount) { this.pods.instanceMatrix.needsUpdate = true; this.pods.instanceColor.needsUpdate = true; }
    this.trails.flush();
  }

  _trailSlot(projIndex) {
    let slot = this.slotTrail[projIndex];
    if (slot >= 0) return slot;
    for (let s = 0; s < this.trails.slots; s++) {
      if (this.trailOwner[s] < 0) {
        this.trailOwner[s] = projIndex;
        this.slotTrail[projIndex] = s;
        return s;
      }
    }
    return -1;
  }

  _drawBolt(p, i, px, py, pz, fresh, count) {
    if (count >= 128) return count;
    const gun = GUNS[p.partIdx] || GUNS[0];
    const look = gun.look;
    const charged = !!p.charged;

    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
    _v.set(p.vel.x / speed, p.vel.y / speed, p.vel.z / speed);
    _q.setFromUnitVectors(_v2.set(0, 0, 1), _v);

    // Longer and thinner than before: a bolt is a spike travelling nose-first,
    // and length is what sells speed. Width is what made the old one a lozenge.
    const w = look.width * (charged ? 1.8 : 1) * (1 + p.scale * 0.15);
    const len = look.len * (charged ? 1.5 : 1) * 0.5;
    this._scaleV.set(w * 2.6, w * 2.6, len);
    this._m4.compose(_v2.set(px, py, pz), _q, this._scaleV);
    this.bolts.setMatrixAt(count, this._m4);

    hot(look.colour, look.glow * (charged ? 1.5 : 1), _rgb);
    this.bolts.instanceColor.setXYZ(count, _rgb[0], _rgb[1], _rgb[2]);

    const slot = this._trailSlot(i);
    if (slot >= 0) {
      hot(look.trail, charged ? 2.6 : 1.8, _rgb);
      this.trails.push(slot, px, py, pz, _rgb[0], _rgb[1], _rgb[2],
        look.width * (charged ? 1.7 : 1.0), fresh, charged ? 7.5 : 5.5);
    }

    // Charged rounds carry a corona of their own — small, or it swallows the
    // core it is supposed to be surrounding.
    if (charged && (i & 1) === 0) {
      hot(look.colour, 2.2, _rgb);
      this.energy.spawn(px, py, pz, vfxRng.s() * 0.6, vfxRng.s() * 0.6, vfxRng.s() * 0.6,
        this.time, 0.16, 0.1, _rgb[0], _rgb[1], _rgb[2], 0, 4, 0);
    }
    return count + 1;
  }

  _drawBomb(p, i, px, py, pz, fresh, count) {
    if (count >= 24) return count;
    const bomb = BOMBS[p.partIdx] || BOMBS[0];
    const look = bomb.look;
    const size = look.size * (p.scale || 1);

    // Tumble driven by the seed so each shell spins differently.
    const spin = this.time * 4 + (p.seed % 1000) * 0.01;
    _q.setFromAxisAngle(_v.set(0.4, 0.82, 0.4).normalize(), spin);
    this._scaleV.set(size, size * (look.style === 'drum' ? 0.7 : 1), size);
    this._m4.compose(_v2.set(px, py, pz), _q, this._scaleV);
    this.bombs.setMatrixAt(count, this._m4);
    _col.setHex(look.shell);
    this.bombs.instanceColor.setXYZ(count, _col.r, _col.g, _col.b);

    // Fuse blink accelerates as the timer runs out.
    const frac = p.life / Math.max(1, p.maxLife);
    const rate = 6 + (1 - frac) * 34;
    const on = Math.sin(this.time * rate) > 0;
    if (on) {
      hot(look.ring, 2.6, _rgb);
      _v.set(px, py + size * 1.2, pz);
      this.flares.spawn(_v.x, _v.y, _v.z, this._faceCamera(_v),
        this.time, 0.06, 0.09, 0.2, _rgb[0], _rgb[1], _rgb[2]);
    }

    // Smoke ribbon.
    const slot = this._trailSlot(i);
    if (slot >= 0) {
      hot(look.colour, 1.1, _rgb);
      this.trails.push(slot, px, py, pz, _rgb[0] * 0.4, _rgb[1] * 0.4, _rgb[2] * 0.4, 0.06, fresh, 3.5);
    }
    return count + 1;
  }

  _drawPod(p, i, px, py, pz, fresh, count) {
    if (count >= 12) return count;
    const pod = PODS[p.partIdx] || PODS[0];
    const look = pod.look;
    const size = look.size * 1.6;

    const heading = Math.atan2(p.vel.x, p.vel.z);
    _q.setFromAxisAngle(_up, heading);
    const bob = Math.sin(this.time * 9 + (p.seed % 100)) * 0.04;
    this._scaleV.set(size, size * 0.75, size * 1.2);
    this._m4.compose(_v2.set(px, py + bob, pz), _q, this._scaleV);
    this.pods.setMatrixAt(count, this._m4);
    _col.setHex(look.shell);
    this.pods.instanceColor.setXYZ(count, _col.r, _col.g, _col.b);

    // Ground-hugging thruster glow.
    if ((i & 1) === 0) {
      hot(look.colour, 2.4, _rgb);
      this.energy.spawn(
        px, py - 0.12, pz,
        -p.vel.x * 0.3 + vfxRng.s(), -0.6, -p.vel.z * 0.3 + vfxRng.s(),
        this.time, 0.22, 0.13, _rgb[0], _rgb[1], _rgb[2], 0, 4, 1
      );
    }

    const slot = this._trailSlot(i);
    if (slot >= 0) {
      hot(look.colour, 1.8, _rgb);
      this.trails.push(slot, px, py, pz, _rgb[0], _rgb[1], _rgb[2], 0.055, fresh, 4.5);
    }
    return count + 1;
  }

  // -------------------------------------------------------------------------

  update(dt, time, camera) {
    this.time = time;
    if (camera) this.camera = camera;

    const pr = 1;
    this.sparks.material.uniforms.uPixelRatio.value = pr;
    this.smoke.material.uniforms.uPixelRatio.value = pr;
    this.energy.material.uniforms.uPixelRatio.value = pr;
    // Streak alignment happens in NDC, so it needs the frame's aspect to know
    // which way "along the velocity" actually points on screen.
    this.sparks.material.uniforms.uAspect.value = this.camera?.aspect || 16 / 9;

    this.sparks.flush(time);
    this.smoke.flush(time);
    this.energy.flush(time);
    this.fireballs.flush(time);
    this.shockwaves.flush(time);
    this.flares.flush(time);
    this.decals.flush(time);

    // Explosion lights decay fast — a lingering one looks like a bug. Keyed to
    // the effect clock so the falloff is the same curve at any frame rate, and
    // so it holds still when a capture freezes time.
    for (let i = 0; i < this.lights.length; i++) {
      if (this.lightLife[i] <= 0) continue;
      const l = this.lights[i];
      const age = time - this.lightBirth[i];
      if (age < 0 || age >= this.lightLife[i]) {
        this.lightLife[i] = 0;
        l.visible = false;
        l.intensity = 0;
      } else {
        // Slow enough that the blast actually lands on the geometry for a few
        // frames. The old 9/s decay meant the light was gone before the fireball
        // had finished expanding, so nothing in the arena ever showed the flash.
        l.intensity = this.lightPeak[i] * Math.exp(-age * 5.0);
      }
    }
  }

  consumeShake() {
    const o = this._shakeOut;
    o.x = this.shake.x; o.y = this.shake.y; o.z = this.shake.z; o.roll = this.shake.roll;
    this.shake.x = this.shake.y = this.shake.z = this.shake.roll = 0;
    return o;
  }

  setQuality(settings) {
    this.settings = settings;
    this.decals.mesh.visible = settings.decals > 0;
    for (let i = 0; i < this.lights.length; i++) {
      this.lights[i].visible = this.lights[i].visible && settings.lights >= 4;
    }
  }

  clear() {
    this.sparks.clear();
    this.smoke.clear();
    this.energy.clear();
    this.fireballs.clear();
    this.shockwaves.clear();
    this.flares.clear();
    this.decals.clear();
    this.trails.clear();
    this.slotAlive.fill(0);
    this.slotTrail.fill(-1);
    this.trailOwner.fill(-1);
    this.bolts.count = 0;
    this.bombs.count = 0;
    this.pods.count = 0;
    for (let i = 0; i < this.lights.length; i++) {
      this.lightLife[i] = 0;
      this.lights[i].visible = false;
      this.lights[i].intensity = 0;
    }
  }

  dispose() {
    for (const b of [this.sparks, this.smoke, this.energy]) {
      this.scene.remove(b.points);
      b.dispose();
    }
    for (const s of [this.fireballs, this.shockwaves, this.flares, this.decals]) {
      this.scene.remove(s.mesh);
      s.dispose();
    }
    this.scene.remove(this.trails.mesh);
    this.trails.dispose();
    for (const m of [this.bolts, this.bombs, this.pods]) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    for (const l of this.lights) this.scene.remove(l);
  }
}
