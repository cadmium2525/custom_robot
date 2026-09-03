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
import { vfxRng, clamp, Rng } from '../core/mathx.js';

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
    // The soft halo, and defect #32 in one term. It used to be a Gaussian of
    // radius 0.21 at half alpha, which is a disc covering forty times the area
    // of the core it was supposed to surround, on the card that every muzzle
    // flash, every impact and every bomb fuse blink is drawn with. A soft
    // circular patch of light with no structure is what dirt on a lens looks
    // like, and this game draws hundreds of them a minute. Tightened to a third
    // of that radius and two thirds of the alpha: the rays below now carry the
    // read, which is what makes a card say "discharge" rather than "smudge".
    const glow = Math.exp(-r2 / 0.016) * 0.34;
    const cross = g2(v, 0.026) * g2(u, 0.66) + g2(u, 0.026) * g2(v, 0.66);
    const ud = (u + v) * 0.7071, vd = (u - v) * 0.7071;
    const diag = (g2(vd, 0.017) * g2(ud, 0.38) + g2(ud, 0.017) * g2(vd, 0.38)) * 0.42;
    const a = Math.min(1, core + glow + cross * 0.86 + diag);
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

/**
 * Plume / energy sprite, long axis on +X, leading edge at +u like the streak.
 *
 * It exists to replace the shared `sprites().glow` blob on the `energy` batch,
 * and the reason is worth recording. That sprite is a wide, low-alpha disc whose
 * *own texel colour* runs white at the centre to (0.35, 0.60, 1.00) at half
 * radius and only reaches zero at the very corner of the quad. The batch shader
 * multiplies texel colour into the particle tint, so every thruster particle,
 * dash line and pod glow laid a saturated blue skirt across whatever it covered
 * — whatever colour the effect had actually asked for. Two idling machines keep
 * dozens of them alive at all times and the batch is additive, so the sum is a
 * broad, permanent, low-value cool wash. That is the measured mechanism behind
 * the review's finding that turning the effects on halves the arena's warm
 * coverage and doubles its cool: the wash is the effects layer repainting a
 * stage three rounds have spent warming.
 *
 * This one is neutral white, so the tint alone decides hue; its energy is
 * concentrated in a nucleus a tenth of the quad across; and it carries a tail
 * rather than a halo, which the batch then rotates onto the particle's own
 * screen-space velocity. A jet particle that points where it is going is a jet.
 * A soft circle with no structure is dirt on the lens at any brightness, which
 * is the whole of defect #32.
 */
function plumeSprite() {
  return paint(128, (u, v, d, o) => {
    // Nucleus: small enough that even a 96px point sprite gives it ~10px, which
    // is what makes it read as a source rather than as a patch of light.
    const core = Math.exp(-((u * u) / 0.0040 + (v * v) / 0.0026));
    // Body: still compact — gone by ~0.22 of the quad.
    const body = Math.exp(-((u * u) / 0.030 + (v * v) / 0.014)) * 0.62;
    // Tail, behind the direction of travel.
    const tail = g2(u + 0.26, 0.30) * g2(v, 0.052) * 0.5;
    let a = Math.min(1, core + body + tail);
    // Hard support cut. Whatever the profile does, nothing may survive past two
    // thirds of the quad: an unbounded skirt of near-zero alpha is exactly what
    // deposits a film over the whole frame once a few dozen of them overlap.
    const e = Math.sqrt((u / 0.66) * (u / 0.66) + (v / 0.46) * (v / 0.46));
    a *= 1 - clamp((e - 0.72) / 0.28, 0, 1);
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
  // 3: dissipate — ramp in fast, then thin on a long continuous tail.
  //
  // Mode 2 holds at full opacity for three quarters of a life and then cuts,
  // which is the shape of a curtain being dropped rather than of smoke going
  // away: the mass is equally solid at 10% and at 70% of its life and then
  // leaves in a couple of frames. It is fine for a short dust wave, where the
  // whole point is a hard fast pass, and it is wrong for anything that is
  // supposed to dissipate. Mode 3 never holds — from the moment it is up it is
  // on its way out, which is what lets the late blast thin instead of vanish.
  float a;
  if (aFlags.z < 0.5)      a = 1.0 - t;
  else if (aFlags.z < 1.5) a = sin(t * 3.14159);
  else if (aFlags.z < 2.5) a = smoothstep(1.0, 0.75, t);
  else                     a = smoothstep(0.0, 0.09, t) * pow(1.0 - t, 1.45);

  // Sparks streak thin and long; smoke swells as it dissipates.
  //
  // Mode 3 swells much harder than mode 2, and the two halves of that are one
  // idea: a puff that grows to three and a half times its birth size while its
  // opacity falls to a tenth is spreading its mass over an area that grows
  // faster than the mass thins, which is what makes it read as gas mixing into
  // air. It is also the guard against the failure this effect was rejected for
  // twice — the growth is in the transparent direction, so the late plume is
  // large and see-through rather than large and solid.
  float grow = aFlags.z < 1.5 ? (1.0 - t * 0.55)
             : aFlags.z < 2.5 ? (0.5 + t * 0.85)
             : (0.40 + t * 1.60);
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

const SHELL_SMOKE_KIND = 2;

const SHELL_VERT = /* glsl */`
attribute vec4 aLife;     // birth, life, scale0, scale1
attribute vec4 aTint;     // rgb + kind
attribute vec4 aMotion;   // launch velocity + seed
uniform float uTime;
// uMode is read by BOTH stages, and GLSL ES requires a uniform declared in both
// to carry the same precision in both. The fragment stage is mediump, the
// vertex stage defaults to highp, so leaving this unqualified linked a program
// that failed VALIDATE_STATUS — and a program that fails validation is not
// required to draw anything. That is the actual reason the "explosion" in every
// capture was a couple of sparks: the fireballs, the shockwaves, the flare
// cards and the scorch decals all share this one program, so all four pools
// were silently dropping out together.
uniform mediump float uMode;
uniform float uEase;
uniform float uDrag;      // exponential decay on aMotion
varying vec4 vTint;
varying vec2 vUv;
varying vec3 vLocal;
// Packed rather than four separate varyings: this program already carries a
// vec4, a vec3 and a vec2, and the ES 2.0 floor is eight varying *vectors*.
// x: normalised age  y: face-on ratio  z: seed  w: edge-on ratio
varying vec4 vMeta;

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
    vMeta = vec4(2.0, 0.0, 0.0, 0.0);
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
    float smoky = step(1.5, aTint.w);
    float n1 = vnoise(position * 1.7 + aMotion.w);
    float n2 = vnoise(position * 4.6 - aMotion.w * 1.7);
    float lump = (n1 - 0.5) * 0.95 + (n2 - 0.5) * 0.46;
    // Fire tears itself open as it burns, so its lobes go on deepening to the
    // end. Smoke does not, and running the same curve on it displaced the
    // sphere by more than its own radius by mid-life — on an icosahedron this
    // coarse that is not billowing, it is a handful of flat triangular panels,
    // and the late blast was visibly a low-poly rock. The smoke's break-up is
    // the fragment stage's erosion, which is per-pixel and cannot facet.
    p *= 1.0 + lump * mix(0.26 + t * 0.90, 0.30 + t * 0.30, smoky);

    // Buoyancy. The cap climbs and the base necks in behind it, so a mass that
    // starts as a ball has become a rising, stalked column by the end of its
    // life. This is the difference between an explosion and one shape fading:
    // the silhouette has to change, not just get dimmer.
    //
    // Pushed harder on the smoke than on the fire, for a reason that is about
    // composition rather than physics: a fight happens at deck level, so a mass
    // that leaves upward is a mass that has stopped standing in front of the
    // machines. Rising is how the smoke gives the frame back.
    //
    // There is a ceiling on how much of that is useful, and it is the frame
    // itself. This camera sits four metres up looking down a quarter of a
    // radian, so at the fifteen metres a duel is fought at the top edge of the
    // picture is only about three and a half metres above the deck. A smoke
    // mass that climbs faster than that has not dissipated, it has EXITED — and
    // an effect that leaves by walking out of shot has no late life to judge,
    // which is exactly what the contact sheet was measuring when cover fell
    // from 27.9% at 470ms to 12.7% at 560ms. Nothing had thinned. It had gone
    // upstairs. Trimmed so the column stretches and stalls inside the frame.
    float rise = t * t;
    p.y += rise * (0.45 + 0.55 * vLocal.y) * mix(0.95, 1.28, smoky);
    p.xz *= 1.0 - mix(0.34, 0.58, smoky) * rise * smoothstep(0.4, -0.8, vLocal.y);
  }
  p *= s;

  // Thrown, then stalling. Integrated the same way the particle batch does it,
  // so a lobe leaves the core fast and is left hanging where the blast put it
  // rather than sliding outward forever at its launch speed.
  float dk = max(uDrag, 1e-3);
  p += aMotion.xyz * ((1.0 - exp(-dk * age)) / dk);

  vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  vec3 nv = normalize((modelViewMatrix * instanceMatrix * vec4(vLocal, 0.0)).xyz);
  vec3 eye = normalize(mv.xyz);
  vUv = uv;
  vTint = aTint;
  // y is 1 looking straight *at* the surface (long path through a solid ball),
  // w is 1 looking *along* it (long path through a thin shell). A fireball
  // wants the first, a shock front the second.
  float edge = 1.0 - abs(dot(nv, eye));
  float meta = aMotion.w;

  if (uMode < 0.5) {
    // The fireball pool is the one mode that never asks how edge-on it is
    // being viewed — a ball of burning gas wants the face-on ratio, which is
    // vMeta.y — so this slot carries the shell's absolute age in seconds
    // instead. The smoke needs it: how brightly the fire is still lighting the
    // smoke from underneath is a question about the *fire's* clock, and every
    // other quantity in the fragment stage is normalised against the smoke's
    // own two-second life.
    edge = age;
  } else if (uMode > 0.5 && uMode < 1.5) {
    // A shock ring is not a sphere, and measuring it like one is what made it a
    // donut. The thing that has to look edge-on is the *wall* of compressed air
    // standing on the ring — its normal is the ring's own radial, and its long
    // axis is the ring's axis. dot(nv, eye) compares those in view space,
    // where the camera's elevation contaminates every term: this camera looks
    // down at the deck from four metres up, so the near and far lips of a ground
    // ring came out almost as edge-on as the flanks and the sheen was uniform
    // the whole way round. Uniform brightness all the way round is the donut.
    //
    // Done properly here, in the ring's own frame: project the radial and the
    // view direction into the plane of the ring and compare them there. That is
    // orientation-agnostic, so it is equally right for a ring lying on the deck,
    // one stuck to a wall, and the billboarded charge tell.
    vec3 wp   = (modelMatrix * instanceMatrix * vec4(p, 1.0)).xyz;
    vec3 axis = normalize((modelMatrix * instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 rad  = (modelMatrix * instanceMatrix * vec4(vLocal, 0.0)).xyz;
    rad -= axis * dot(rad, axis);
    vec3 toEye = cameraPosition - wp;
    float dEye = max(length(toEye), 1e-4);
    vec3 vdir = toEye - axis * dot(toEye, axis);
    float lr = length(rad), lv = length(vdir);
    float algn = (lr > 1e-4 && lv > 1e-4) ? abs(dot(rad / lr, vdir / lv)) : 1.0;
    // Straight down the axis there is no edge-on direction anywhere on the ring,
    // so fall back to flat rather than to whichever way the numerics tipped.
    edge = mix(0.45, 1.0 - algn, smoothstep(0.03, 0.34, lv / dEye));
    // Radius reached so far, as a fraction of the radius it will reach. The
    // fragment stage needs it to hold the front's thickness in *world* units.
    meta = s / max(max(aLife.z, aLife.w), 1e-4);
  }

  vMeta = vec4(t, abs(nv.z), meta, edge);
  gl_Position = projectionMatrix * mv;
}`;

const SHELL_FRAG = /* glsl */`
precision mediump float;
varying vec4 vTint;
varying vec2 vUv;
varying vec3 vLocal;
varying vec4 vMeta;
uniform sampler2D uMap;
uniform mediump float uMode;
uniform mediump float uFlat;

// The fire ramp, in linear light. EMBER and up clear the bloom threshold (1.04)
// so the burning part of the blast has real HDR headroom to glow with; SOOT and
// CHAR sit an order of magnitude below it, which is what lets the same mass cool
// *out* of the bloom into a dark opaque lump instead of staying a lamp forever.
const vec3 C_SOOT   = vec3(0.028, 0.025, 0.024);
const vec3 C_CHAR   = vec3(0.34, 0.11, 0.05);
const vec3 C_EMBER  = vec3(1.15, 0.20, 0.03);
const vec3 C_ORANGE = vec3(2.70, 0.76, 0.07);
const vec3 C_YELLOW = vec3(3.90, 2.25, 0.40);
const vec3 C_WHITE  = vec3(5.80, 5.05, 4.20);

void main() {
  float vT  = vMeta.x;
  float rim = vMeta.y;      // 1 face-on, 0 at the silhouette
  // 1 looking along the shell, 0 straight through it — except in the fireball
  // mode, which has no use for it and carries the shell's age in seconds there
  // instead. See the note in the vertex stage.
  float edg = vMeta.w;
  if (vT > 1.0 || vT < 0.0) discard;
  float fade = 1.0 - vT;
  vec3 col = vTint.rgb;
  float a;

  if (uMode > 2.5) {
    // Scorch marks are burnt material, not light: they must never brighten the
    // floor, and they linger rather than flash. Raised from 0.6 — at 0.6 on a
    // deck sitting at value 95 the mark the blast left behind was not findable
    // in a still, so as far as the frame was concerned the explosion had never
    // touched the world it happened in.
    a = smoothstep(0.0, 0.04, vT) * pow(fade, 0.7) * 0.88;
    vec4 tx = texture2D(uMap, vUv);
    col *= tx.rgb;
    a *= tx.a;
  } else if (uMode > 1.5) {
    // Billboard flash card. The hot phase is deliberately short — held any
    // longer and a nearby blast just reads as a white screen once bloom has it.
    col = mix(vec3(2.2, 1.9, 1.6) * col, col, smoothstep(0.0, 0.35, vT));
    col *= 0.35 + fade * 1.2;
    a = pow(fade, 2.0);
    vec4 tx = texture2D(uMap, vUv);
    col *= tx.rgb;
    a *= tx.a;
  } else if (uMode > 0.5) {
    // Shock front. A pressure wave that reads is a thin, sharp, decelerating
    // leading edge — not a ring of paint lying on the floor. Three parts:
    //
    //  * the front itself, tinted well over 1.0 so bloom has something to catch;
    //  * a sheen term, so it is brightest where the line of sight runs *along*
    //    the shell and nearly gone across the near and far lips. A ring of even
    //    brightness all the way round is exactly what reads as a donut;
    //  * a dark compression lip immediately behind the front. It carries alpha
    //    but almost no colour, so under the over-blend it *darkens* whatever it
    //    crosses. That is the cheap stand-in for refraction, and it is what
    //    makes the front look like a discontinuity in the air rather than a
    //    decal — you can see the deck bend around it.
    //
    // Kind 1 pins the band and drops both the sheen and the lip: it is the
    // charge tell, billboarded at the camera, where an edge-on term would put
    // it out altogether.
    float pinned = vTint.w > 0.5 ? 1.0 : 0.0;
    float r = length(vUv - 0.5) * 2.0;
    float centre = mix(mix(0.58, 0.93, sqrt(vT)), 0.80, pinned);
    // Half-width held constant in WORLD units, by dividing the uv half-width by
    // how far the shell has already grown (vMeta.z, the radius so far as a
    // fraction of the radius it will reach).
    //
    // This is the arithmetic behind "grey donut", and it was never a colour
    // problem. The band used to be a fixed *fraction* of a shell that grows
    // five-fold, and the fraction itself was doubling with age on top of that:
    // by mid-life the front was twelve times thicker in world terms than at
    // birth — a sixty-pixel band on a ring twenty metres across, drawn at a
    // brightness that tone-maps to paper white from edge to edge. No amount of
    // temperature work on a band that shape would have read as a pressure wave.
    // Held constant, the same geometry is a line that races outward.
    float sn = max(vMeta.z, 0.05);
    float hw = mix(clamp(0.021 / sn, 0.018, 0.16), 0.13, pinned);
    float d = (r - centre) / hw;
    // A GAUSSIAN HAS NO EDGE. exp(-d*d) is still at 1% of peak two and a half
    // half-widths out and never reaches zero, so the front's boundary was a
    // tail rather than a line — the same defect as the fireball's density ramp,
    // in a shape whose entire job is to be a sharp discontinuity.
    //
    // A flat top with a hard shoulder instead: full strength through the middle
    // of the band, falling to nothing over the last third of it. The spine is
    // split out rather than left as pow(front, 6.0), which on a flat top would
    // be flat too and would push the whole band to paper white — the "grey
    // donut" this file already fixed once from the other direction.
    float ad = abs(d);
    float front = 1.0 - smoothstep(0.68, 1.0, ad);
    float spine = 1.0 - smoothstep(0.0, 0.34, ad);
    // Nearly all of the front's brightness is now anisotropic. A wave you can
    // see equally well from every direction is a decal.
    float sheen = mix(0.10 + 0.90 * edg, 1.0, pinned);
    // Compression lip: alpha with almost no colour, immediately behind the
    // front, so under the over-blend it darkens whatever it crosses. Widened
    // along with the thinner front — it is the only part of this that says
    // "discontinuity in the air" rather than "line on the floor".
    float dl = (r - (centre - hw * 3.2)) / (hw * 3.0);
    float lip = exp(-dl * dl) * (1.0 - pinned);

    // Temperature across the thickness of the front rather than one clipped
    // white band. The flanks are left where ACES still has colour — under about
    // 1.2 linear — so they read amber, and only the spine itself is pushed past
    // white. Every pixel of the old front was above 4.0 linear, and above 4.0
    // every colour tone-maps to the same paper white, which is exactly why a
    // ring authored in warm values arrived on screen grey.
    col = vTint.rgb * front * (0.35 + sheen * 1.15)
        + vec3(1.0, 0.93, 0.82) * spine * sheen * 3.2;
    col *= fade;
    a = clamp(front * (0.16 + 0.84 * sheen) * 0.88 + lip * 0.30 * sheen, 0.0, 1.0)
      * pow(fade, 1.25) * mix(1.0, 0.42, pinned);
  } else {
    // Turbulence, sampled in a rotated frame that drifts as the mass burns, so
    // no two blasts break up the same way and each one churns while it lives.
    // Frequency more than doubled. At 0.42 the whole ball sampled less than half
    // a tile of the field, so every billow was one smooth gradient with no
    // internal structure at all — which is why they read as flat yellow discs
    // rather than as burning gas, no matter what the colour ramp did. A little
    // under one tile across the ball, with a second octave over it, is enough
    // detail for the eye to see the mass churn.
    float cs = cos(vMeta.z), sn = sin(vMeta.z);
    vec2 nuv = vec2(vLocal.x * cs - vLocal.z * sn, vLocal.x * sn + vLocal.z * cs) * 0.95;
    nuv += vec2(vLocal.y * 0.62, -vT * 0.26);
    float t1 = texture2D(uMap, nuv).r;
    float t2 = texture2D(uMap, nuv * 3.1 + vec2(0.37, 0.11)).g;
    float turb = t1 * 0.62 + t2 * 0.38;

    if (vTint.w > 1.5) {
      // Smoke phase. No fire ramp at all: soot, eroded hard by the same
      // turbulence so it stays a ragged mass rather than a dome.
      //
      // What changed is that it now has MASS. It used to top out around a=0.6
      // on a colour of 0.03 linear, which against this arena is nothing at all:
      // the blast handed off from a solid fireball to something you could see
      // the deck straight through, so the last two thirds of its life were
      // empty. Alpha now reaches 0.9 through the middle. That is the difference
      // between smoke and a stain.
      //
      // Lit from two sides, because that is the whole of why smoke reads as
      // volume: what is left of the fire from underneath, the arena from above.
      // The upper light is deliberately held at about a twentieth of linear
      // white — dark enough that the mass always sits well below the deck it
      // crosses. Kept to the fireball's own footprint, too. A pale dome big
      // enough to cover the fight is not atmosphere, it is an occlusion bug; it
      // also flatters a mid-tone histogram while hiding the one thing the frame
      // is about, which is how an earlier version of this scored better and
      // looked considerably worse.
      // The erosion has to bite from the *first* frame of the smoke, not from
      // its last quarter. Measured on the contact sheet, the previous curve
      // left the mass at its greatest screen area — 53.4% of the crop, more
      // than the fireball ever reached — at 470ms, when it was no longer fire
      // and the frame was supposed to be handing back to the fight. Opening at
      // 0.34 instead of 0.10 means the mass is torn from the moment it appears:
      // solid enough in its billows to be a hole in the frame, already full of
      // gaps between them.
      //
      // That correction then went far past its target and deleted the stage it
      // was tuning. Opening to 1.18 on pow(vT, 0.55) puts the threshold at 0.77
      // by a third of the way through a life, and turb only reaches about 0.62
      // in the middle of its distribution, so d2 was zero nearly everywhere
      // from very early on. With the fire also fixed to go out on time, the
      // sheet measured the consequence exactly: 5.8% of the crop at 650ms and
      // 4.8% at 950ms. There was no late blast left to be muddy because there
      // was no late blast.
      //
      // The correction to THAT then landed on 0.18, and 0.18 is the bug this
      // curve keeps coming back to, because the field it is thresholding is
      // much narrower than it looks. Measured over the actual turbulence
      // texture: p05 0.367, p50 0.502, p95 0.637. Ninety percent of the mass
      // lives inside a band 0.27 wide. Against that, a threshold of 0.18 is
      // BELOW the whole distribution — d2 came out 1.0 on every pixel for the
      // first fifth of the shell's life, which is precisely the 240-470ms
      // window the smoke is on screen alone. That is where the dark dome came
      // from: not from the colour, not from the size, but from an erosion that
      // had not started yet.
      //
      // The range is now written against that measurement. 0.40 puts p50 at
      // about four fifths open and p05 at a quarter, so the mass is holed from
      // its first frame; 0.74 at the end leaves only the densest cores. Nearly
      // linear in vT because the noise is nearly Gaussian in that band — a
      // power curve on one side of it just wastes half the schedule.
      float cap  = smoothstep(-0.30, 0.90, vLocal.y);
      float bite = mix(0.40, 0.74, vT) + cap * 0.18 * vT;
      // A third octave, and it exists to WIDEN the distribution rather than to
      // add another average. turb is two samples already averaged together, and
      // averaging narrows: mixing a third one in would make the field flatter
      // and the mass smoother, which is the opposite of break-up. Added as a
      // signed offset it increases the variance instead, so the same threshold
      // now cuts small holes through the billows as well as separating them.
      float t3 = texture2D(uMap, nuv * 6.7 + vec2(0.19, 0.63)).r;
      float rag = turb + (t3 - 0.5) * 0.55;
      // A WIDE window, not the 0.17 it was. A narrow one is a stencil: every
      // pixel is either fully in or fully out, so the mass has a cut edge and
      // leaves by losing whole regions at once — which is the "fades as a whole
      // rather than thinning at the edges" complaint, arriving as geometry
      // instead of as opacity. Widened, the same noise field reads as a
      // soot-to-transparent falloff and the mass frays.
      // Narrowed from 0.34 for the same reason the fire's was, and with the same
      // trade understood. The note above is right that a narrow window is a
      // stencil with a cut edge — that is now the point. It also does the second
      // half of clause F for free: shots/_r17-edge.mjs measured the effect
      // covering 59.5%, 66.4% and 73.0% of the FAR machine's pixels at ages 12,
      // 20 and 72 against a < 25% threshold, and the late ages are the smoke's.
      // Thresholding the same field harder puts more of it fully out rather than
      // faintly in, so the mass tears into billows with real gaps between them
      // and the opponent reads THROUGH it instead of behind it.
      float d2 = smoothstep(bite, bite + 0.12, rag + 0.16);
      // Underlighting is the fire shining up into the smoke, so it has to die
      // with the fire and not with the smoke. It went out on pow(fade, 3.0) of
      // the *smoke's* two-second life, i.e. it was still at a third of full
      // strength most of a second after the last flame — which is why the late
      // mass came back rust-orange and 42% of the crop measured "warm" at
      // 650ms. It is now keyed to the shell's age in SECONDS -- edg carries it
      // in this mode -- with a 0.28s time constant, so it tracks the fire's
      // clock and not the smoke's, and the tint is halved on top of that.
      // (No backticks in this file's GLSL: it is a template literal, and a
      // stray one in a comment has broken the build twice.)
      float lit = exp(-edg * 3.6);
      float under = smoothstep(0.10, -0.80, vLocal.y) * lit;
      float over  = smoothstep(-0.25, 0.85, vLocal.y);
      // Two lights and a cold bias, which between them are the whole of "lit by
      // the embers early, cold and thin late". The underlight is the fire and
      // dies with the fire, on the shell's own age in seconds. What is left
      // over is a thin cold skylight on the upper surfaces, deliberately blue
      // against the soot's neutral, so the mass has somewhere to go once the
      // warmth has gone rather than settling on one flat mid-grey.
      col = C_SOOT
          + vec3(0.014, 0.019, 0.030) * over * (0.55 + turb * 0.85)
          + C_CHAR * 0.42 * under * (0.5 + turb * 0.7);
      // Continuous to the end, and this is not the same knob as the erosion
      // above. The tail used to be smoothstep(0.82, 0.30) — full opacity for
      // the first third of a life, then a ramp that reaches zero with a fifth
      // of the life still to run. A mass that arrives at full weight, holds,
      // and then stops eighteen percent short of its own death is a curtain
      // being dropped. pow(1 - vT, 0.85) is falling from the first frame and
      // reaches nothing exactly when the shell does.
      a = d2 * (0.30 + 0.52 * rim)
        * smoothstep(0.0, 0.08, vT) * pow(1.0 - vT, 0.85);
    } else {
      // Density and temperature are two different fields, and separating them is
      // the whole trick.
      //
      // Density is *mass*: it decides what the blast hides. It is eaten away
      // from the outside in as the ball burns out, so the silhouette tears into
      // separate billows instead of one shape dissolving uniformly.
      //
      // Temperature only decides colour, and it falls fastest at the silhouette
      // and with age. That is what puts white in the middle, yellow and orange
      // around it, deep red at the rim and soot on the outside — a gradient
      // across the ball at every instant, not one ramp played back over time.
      //
      // The erosion curve was vT*vT, which is a curve that does almost nothing
      // for the first half of a life: at mid-life it had opened to 0.27 out of
      // 0.88, so the mass was still very nearly solid. Meanwhile the lobes are
      // thrown outward against a drag of 2.6, which carries them 0.18 of their
      // launch speed by 240ms and 0.27 of it by 470ms — so the cluster goes on
      // spreading for the whole of its life. Solid mass on a still-expanding
      // envelope is a footprint that GROWS as the fire dies, and that is what
      // the sheet measured: cover 47.4% at 240ms rising to 54.6% at 470ms, the
      // blast at its largest a quarter-second after it stopped being bright.
      //
      // pow(vT, 1.30) is very nearly linear, so the tearing tracks the
      // spreading instead of lagging a half-life behind it. The cluster still
      // blows apart; what it can no longer do is stay a solid object while it
      // does so.
      float bite = mix(0.06, 1.00, pow(vT, 1.30));
      // THE WINDOW IS THE EDGE. 0.28 was the whole reason the blast measured
      // soft, and the number that proves it is in this file's own smoke branch:
      // the turbulence field runs p05 0.367, p50 0.502, p95 0.637, so ninety
      // percent of the mass lives inside a band 0.27 wide. A 0.28-wide
      // smoothstep across a 0.27-wide distribution is not an edge treatment at
      // all — it is a ramp spanning the entire ball, and every pixel of the
      // fireball sat somewhere on it.
      //
      // Measured by shots/_r17-edge.mjs at HIGH: the 10-90 transition of the
      // effect's own boundary was 21.5-32 px against 1.25 px for a machine
      // silhouette rasterised by the same code in the same frame. Seventeen to
      // twenty-six times softer than a hard edge in its own pipeline, and
      // 11.6-21.3% of the effect's own radius against clause F's < 10%.
      //
      // 0.07 cuts the mass out of the noise field instead of fading it. The
      // smoke branch below calls a narrow window "a stencil: every pixel is
      // either fully in or fully out, so the mass has a cut edge" — that is a
      // correct description and, for the FIRE, it is the goal rather than the
      // defect. A drawn explosion is a flat shape with a hard boundary. The
      // ragged multi-octave field is what stops that boundary being a circle.
      float dens = smoothstep(bite, bite + 0.07, turb + fade * 0.26);
      // The rim term is what actually carries the gradient, and it used to span
      // 0.45..1.30 — a factor of under three across the whole ball, which put
      // nearly every visible pixel inside one band of the ramp. That is why the
      // mid-life fireball arrived as a flat yellow disc with an orange edge
      // instead of a temperature field: the ramp was fine, nothing was being
      // fed into most of it. Spanning 0.02..1.24, on a curve, the same ball
      // holds white at the centre, yellow and orange around it, deep red at the
      // rim and soot at the silhouette — all at once, at every age.
      //
      // The RIM axis of that gradient was right; the TIME axis was not, and it
      // is the whole of the "muddy late" defect. Temperature fell on
      // pow(fade, k) — each lobe's own *lifetime fraction* — and the lobes are
      // deliberately spawned with lives spread over 0.50..0.90s so the cluster
      // does not die all at once. The consequence is that the mass never agrees
      // with itself about how hot it is: at 470ms a short lobe is at 90% of its
      // life and nearly out while a long one is barely past half and still
      // fully orange, so the long tail of that distribution holds the blast at
      // fire colours for about twice as long as there is any fire.
      //
      // Measured on the contact sheet, that read as: peak occlusion at 470ms
      // (hide 42.0% of the crop, higher than the flash's 41.8%), at the blast's
      // DIMMEST (2.41% of pixels over 200, against 18.3% at 40ms) and its
      // WARMEST (62.9% warm, against 50.7%). Most-covering, least-bright and
      // most-orange all at the same instant is not a fireball, it is a sheet of
      // orange paint hung in front of the fight.
      //
      // So temperature now falls on ONE curve in seconds, shared by every lobe,
      // and lifetime fraction is demoted to a gentle tail. edg carries the
      // shell's absolute age here (see the note in the vertex stage). The curve
      // is flat across the flash and the white-hot churn and then falls hard:
      // about 0.90 at 110ms, 0.62 at 240ms, 0.43 at 340ms, 0.27 at 470ms and
      // 0.15 at 650ms — which walks the ramp white -> yellow -> orange -> deep
      // red -> soot on roughly the schedule a fireball this size burns out on,
      // with every lobe walking it together.
      float cool = 1.0 / (1.0 + pow(max(edg, 0.0) / 0.30, 2.2));
      float heat = clamp((0.02 + 1.22 * pow(rim, 1.6)) * (0.55 + 0.78 * turb)
                         * pow(fade, 0.45) * cool, 0.0, 1.4);
      if (vTint.w < 0.5) {
        // The detonation core: a smooth white-hot ball with no break-up at all,
        // over before the eye can resolve it.
        heat = 1.32 * pow(fade, 0.4);
        dens = smoothstep(0.02, 0.50, rim);
      }
      col = mix(C_SOOT, C_CHAR, smoothstep(0.02, 0.16, heat));
      col = mix(col, C_EMBER, smoothstep(0.14, 0.36, heat));
      col = mix(col, C_ORANGE, smoothstep(0.34, 0.58, heat));
      col = mix(col, C_YELLOW, smoothstep(0.58, 0.86, heat));
      col = mix(col, C_WHITE, smoothstep(0.88, 1.16, heat));
      col *= mix(vec3(1.0), vTint.rgb, 0.28);

      // Released from half-life rather than from 70%, for the same reason. The
      // hold to 0.70 meant a lobe was at full opacity through the whole of the
      // stretch where it had already cooled out of the fire ramp — opaque and
      // no longer burning, which is the definition of a curtain.
      // The SECOND source of softness, and it is a soft-particle look arrived at
      // from the other direction. rim is 1 face-on and 0 at the silhouette, so
      // (0.42 + 0.62 * rim) drove alpha down to 40% of its centre value exactly
      // where the boundary is — a smooth radial opacity falloff built into every
      // shell, on top of the density ramp above.
      //
      // Held nearly flat instead: the shape now carries its opacity out to its
      // own edge and stops. rim keeps its real job, which is TEMPERATURE — it
      // is what puts white at the centre, yellow and orange around it and deep
      // red at the rim, and none of that is touched. What it no longer does is
      // decide coverage. Flat alpha inside a hard boundary is what a drawn
      // effect is; the gradient belongs in the colour, not in the mask.
      a = clamp(dens * (0.88 + 0.14 * rim) * smoothstep(0.97, 0.50, vT), 0.0, 0.95);
    }
  }

  if (a <= 0.004) discard;
  // DORMANT DIAGNOSTIC, default 0, shipped off. Replaces every shell's COLOUR
  // with one flat value and leaves its ALPHA untouched, which is the only way
  // to ask this shader the question clause F actually turns on: is the boundary
  // that shots/_r17-edge.mjs measures the edge of the shape's COVERAGE, or the
  // edge of its TEMPERATURE?
  //
  // The two are not the same here and that is the whole difficulty. The meter
  // reads C = |luma(raw) - luma(novfx)|. At a lobe's silhouette rim is 0, so
  // heat is ~0 and the ramp returns C_SOOT = 0.028 linear -- while alpha is
  // still dens * (0.88 + 0.14 * rim), i.e. very nearly opaque. A pixel that is
  // fully covered but coloured almost exactly like an unlit background makes
  // NO difference to the frame, so the meter cannot distinguish it from a pixel
  // the effect never touched. Flatten the colour and C becomes a pure coverage
  // signal; the difference between the two readings is the answer.
  //
  // A uniform branch, uniform across the draw, and zero when it is not being
  // measured. It is here rather than in a scratch build because four of this
  // project's instruments have already been lost to a container restart.
  if (uFlat > 0.0) col = vec3(uFlat);
  // Premultiplied. Alpha is coverage and colour is emission, and keeping them
  // independent is what lets one shader be both a lamp and a solid: a wisp with
  // a=0.05 and col=5.0 blooms without hiding anything behind it, while burnt
  // gas with a=0.8 and col=0.03 is a hole in the frame. An all-additive blast
  // can only ever be a glow, and a glow has no mass.
  gl_FragColor = vec4(col * a, a);
}`;

class ShellPool {
  constructor(geometry, capacity, map = null, {
    renderOrder = 7, mode = SHELL_FIREBALL, ease = 2.6, drag = 0, over = false,
  } = {}) {
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
        uMode: { value: mode },
        uFlat: { value: 0 },
        uEase: { value: ease },
        uDrag: { value: drag },
      },
      transparent: true,
      depthWrite: false,
      // The fragment stage always emits premultiplied colour, which makes the
      // two blend modes below the *same* maths with one term switched off:
      // additive is (ONE, ONE) and over is (ONE, ONE_MINUS_SRC_ALPHA). A pool
      // that can occlude is therefore one boolean away from one that can only
      // add, and nothing else in the shader has to know which it is.
      premultipliedAlpha: true,
      blending: over ? THREE.NormalBlending : THREE.AdditiveBlending,
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
/** Contact point after `_liftOffSurface` has pulled it clear of what it hit. */
const _hp = new THREE.Vector3();
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
      plume: plumeSprite(),
      turb: turbulenceSprite(),
    };

    const budget = settings.particleBudget;

    // --- particle batches -------------------------------------------------
    // Sparks are velocity-aligned streaks; smoke and energy stay round.
    this.sparks = new ParticleBatch(Math.round(budget * 0.5), this.tex.streak,
      { additive: true, sizeScale: 1.35, maxSize: 120, align: true });
    this.smoke = new ParticleBatch(Math.round(budget * 0.28), this.sp.smoke,
      { additive: false, opacity: 0.62, renderOrder: 4, maxSize: 150 });
    // `maxSize` halved along with the sprite change: the cap is what a single
    // plume particle is allowed to cover when it drifts near the lens, and 96px
    // of additive blue at a=0.3 is a quarter of the screen height of haze from
    // one particle.
    this.energy = new ParticleBatch(Math.round(budget * 0.22), this.tex.plume,
      { additive: true, sizeScale: 1.0, maxSize: 52, align: true });
    scene.add(this.smoke.points, this.sparks.points, this.energy.points);

    // --- trails -----------------------------------------------------------
    this.trails = new TrailPool(Math.min(MAX_PROJ, 96), Math.max(4, settings.trailSegments));
    scene.add(this.trails.mesh);

    // --- expanding shells -------------------------------------------------
    // `over` is what gives the blast mass: burning gas is dense, and dense
    // things hide what is behind them. `drag` lets a lobe be thrown off the core
    // and stall rather than slide outward at a constant rate forever.
    const sphere = new THREE.IcosahedronGeometry(1, settings.bloomQuality >= 2 ? 3 : 2);
    this.fireballs = new ShellPool(sphere, 48, this.tex.turb,
      { mode: SHELL_FIREBALL, ease: 2.2, drag: 2.6, over: true });
    scene.add(this.fireballs.mesh);

    // Nearly a disc: the visible ring is a travelling band inside the geometry,
    // so the front can start tight in the middle and race out to the rim.
    const ring = new THREE.RingGeometry(0.2, 1.0, 56, 1);
    ring.rotateX(-Math.PI / 2);
    this.shockwaves = new ShellPool(ring, 24, null,
      { renderOrder: 8, mode: SHELL_RING, ease: 3.4, over: true });
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

    // Last frame's delta, kept so emitters that are *called* per frame can
    // still emit per second. `thruster()` is invoked from `view.update` before
    // `vfx.update` runs, so it reads the previous frame's value; that is one
    // frame of lag on a rate, which is invisible, and it is the difference
    // between a plume that is the same length at 30fps and at 144fps and one
    // that is not.
    this.frameDt = 1 / 60;
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
    this.decals = new ShellPool(geo, cap, this.sp.smoke,
      { renderOrder: 3, mode: SHELL_SOOT, ease: 1.4, over: true });
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

    // The card's own shader multiplies this by 2.2 for the first third of its
    // life and the composite then blooms anything over 1.04, so 2.6 arrived on
    // screen at nearly nine — a muzzle flash that clips to white and spills a
    // halo across the deck, several times a second, for the whole match. A
    // firing machine should be the brightest thing in the frame at the instant
    // it fires and nothing like it in between; that is a job for a short curve,
    // not a large number.
    hot(look.colour, charged ? 3.1 : 1.85, _rgb);

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

  /**
   * Lift a contact point off the thing it landed on, into `_hp`.
   *
   * This is the whole of why the most-played effect in the game rendered
   * NOTHING. An EV.HIT arrives at the point the collision test caught the round
   * — for an armour hit that is the round's own position *inside the target's
   * capsule*, and for a surface hit it is a point on the deck or the wall. Every
   * pool in this file draws with `depthTest: true`, so a billboard centred there
   * is behind the very surface the hit is about and is discarded in its
   * entirety. Measured on a frozen frame at 17m: an armour hit changed exactly
   * ZERO pixels; the same spawn pushed half a metre toward the camera changed
   * 1753 of them. Not a shader bug, not the spawn path, not alpha — geometry.
   *
   * The lift is toward the CAMERA, not along the normal, because the normal is
   * the one direction that does not help: a round hitting a chest plate has a
   * normal pointing back at the shooter, which is very often across the lens
   * rather than toward it. It is scaled with view distance so it is a constant
   * *screen-space* bias — about a fixed number of pixels of parallax at any
   * range — and clamped so it never detaches the effect from the hit up close.
   * A dash of normal is added on top so a deck mark still sits above the deck.
   */
  _liftOffSurface(x, y, z, nx, ny, nz) {
    _fv.set(this.camera.position.x - x, this.camera.position.y - y, this.camera.position.z - z);
    const d = Math.max(_fv.length(), 1e-3);
    _fv.multiplyScalar(1 / d);
    const lift = clamp(d * 0.035, 0.14, 0.6);
    _hp.set(x + _fv.x * lift + nx * 0.05, y + _fv.y * lift + ny * 0.05, z + _fv.z * lift + nz * 0.05);
    return d;
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

    // Out of the surface first — see `_liftOffSurface`. `dist` comes back
    // because everything below is sized against it.
    const dist = this._liftOffSurface(ev.x, ev.y, ev.z, nx, ny, nz);
    const hx = _hp.x, hy = _hp.y, hz = _hp.z;

    // Screen-referenced sizing, and this is the second half of "the impact is
    // not there". A duel in this arena is fought at fifteen to twenty-six
    // metres — the review measures the opponent at 42x79px, under 9% of frame
    // height — so a card authored at 0.62 world units arrived on screen 29
    // pixels across and the sparks arrived at three. A hit is one event whether
    // it lands near or far and it has to read the same either way, so the cards
    // are given back the size perspective takes off them, above a reference
    // range where the authored sizes are already right. Never below 1: a hit at
    // arm's length keeps exactly the size it was authored at, which is what
    // stops a vulcan burst at close quarters from strobing the screen.
    const gain = clamp(dist / 9, 1, 2.2);

    // --- the burst -----------------------------------------------------------
    // The read is a hard-edged star, not a glow, so the flash card is at 72% of
    // its final size on its FIRST frame. It used to open at 0.1 units against a
    // 0.62 finish, i.e. a sixth of its size, on a 3.4 ease — which is why the
    // sheet measured cover 0.0% at age 0 even in the frames where something did
    // survive the depth test. A flash that grows into existence is a bloom; a
    // flash that is already there and shuts is an impact.
    //
    // The star is tinted well under the value the sparks get, and the arithmetic
    // for how far under is worth writing down, because the first version of this
    // burst was held down by eye and still arrived as a white disc.
    //
    // The card shader's whole output is `col * a` into an additive buffer, where
    // `a` is the sprite's alpha and `col` is the tint multiplied by 3.41 at
    // vT=0 (2.2 from the hot-phase mix, times 0.35 + fade * 1.2). The flash
    // sprite is white texels with three alpha populations: the nucleus at ~1.0,
    // the ray spines at ~0.86, and the soft halo at 0.34. So the tint is the one
    // number that decides which of those three land above the white point and
    // which keep their colour, and ACES puts that point at about 1.2 linear.
    //
    //   tint 1.74 (what this was)     halo 2.0   rays 5.1   core 5.9
    //   tint 0.98 (what it is now)    halo 1.1   rays 2.9   core 3.3
    //
    // At the old numbers every population was over the white point — the halo
    // included — so the card was a uniformly white disc with a 2px ray buried in
    // it, and the bloom halo of that disc is the "soft round blob" the sheet
    // photographed at 0 and 17ms. Held at 0.98 the halo lands just above the
    // bloom threshold and KEEPS ITS HUE, the ray spines go white with a warm
    // fringe where they fall off, and the nucleus below is the only paper-white
    // thing in the frame. That is a hard-edged star instead of a lamp, and it is
    // the same lesson `51b7098` applied to the fireball: a tone-mapped renderer
    // gives you exactly one white, so only one thing may have it.
    const cardTo = (heavy ? 1.35 : 0.64) * gain;
    const cv = (heavy ? 0.52 : 0.62) * 0.56;
    _v.set(hx, hy, hz);
    this.flares.spawn(hx, hy, hz, this._faceCamera(_v), t,
      heavy ? 0.11 : 0.075, cardTo * 0.72, cardTo,
      _rgb[0] * cv, _rgb[1] * cv, _rgb[2] * cv);
    // A white nucleus inside the star that shuts faster than the star does, so
    // the centre of the hit is hard rather than a soft bright patch. It shrinks
    // rather than grows — the card shader's ease is front-loaded, so a shrinking
    // core snaps closed over two or three frames.
    //
    // 5.2 linear reached the frame at 17.7 through the same 3.41, which put
    // every texel above alpha 0.23 at paper white — i.e. the "nucleus" was a
    // disc a third of the card across, not a nucleus. At 2.7 only the texels
    // above 0.45 clip, and 0.45 on a Gaussian of sigma 0.047 is a dot a
    // twentieth of the card wide. Same idea as the star: the clipped region has
    // to be SMALL for the eye to read it as hard.
    this.flares.spawn(hx, hy, hz, this._faceCamera(_v), t,
      heavy ? 0.05 : 0.038, cardTo * 0.44, cardTo * 0.16, 2.7, 2.4, 2.05);

    // --- sparks and debris ---------------------------------------------------
    // Two populations rather than one cloud. The sparks are fast, thin,
    // velocity-aligned streaks that are gone in a fifth of a second; the debris
    // is a handful of slower chunks under hard gravity that arc out of the hit
    // and fall, which is the part that says a piece of the machine came off.
    // Counts are unchanged at tier 3 and still scale on `_budgetScale`, because
    // this plays on every landed round and its frame cost is a phone's problem:
    // what changed is the SIZE of each streak, which costs nothing.
    //
    // A point sprite's screen size is `size * 640 / depth`, so the old 0.04-0.085
    // was three pixels at duel range — sub-pixel once the alpha profile has
    // shaped it thin. These are authored against that arithmetic rather than
    // against the world: ~8-17px at twenty-six metres, ~25-50px at nine, which
    // is a streak at both ends and needs no distance gain because the point
    // sprite already carries perspective correctly.
    const n = Math.round((heavy ? 24 : 11) * s);
    for (let i = 0; i < n; i++) {
      const spread = heavy ? 1.5 : 1.1;
      const sp = 8 + vfxRng.f() * 7;
      const vx = nx * sp + vfxRng.s() * 7 * spread;
      const vy = ny * sp + vfxRng.s() * 6 * spread + 2.2;
      const vz = nz * sp + vfxRng.s() * 7 * spread;
      this.sparks.spawn(
        hx, hy, hz, vx, vy, vz,
        t, 0.16 + vfxRng.f() * 0.24, 0.24 + vfxRng.f() * 0.26,
        _rgb[0], _rgb[1], _rgb[2], 22, 1.1, 0
      );
    }
    const chunks = Math.round((heavy ? 6 : 3) * s);
    for (let i = 0; i < chunks; i++) {
      const a = vfxRng.f() * 6.283;
      const sp = 2.6 + vfxRng.f() * 3.4;
      this.sparks.spawn(
        hx, hy, hz,
        nx * 2 + Math.cos(a) * sp, ny * 2 + 3.4 + vfxRng.f() * 2.6, nz * 2 + Math.sin(a) * sp,
        t, 0.45 + vfxRng.f() * 0.35, 0.22 + vfxRng.f() * 0.16,
        // Dim and warm rather than white-hot: a chunk is lit debris, not a
        // spark, and at spark values it would just be more of the burst. It is
        // the one part of the hit that outlives the flash, so it is also the
        // part that says something came off rather than merely lit up.
        _rgb[0] * 0.34, _rgb[1] * 0.24, _rgb[2] * 0.15, 26, 0.35, 0
      );
    }

    if (surface) {
      // A ring only ever lies on the surface it hit, never free in the air, and
      // it is gone inside 150ms. Rings that hang around at arbitrary angles are
      // what turned the old arena into a field of grey donuts.
      _q.setFromUnitVectors(_up, _v2.set(nx, ny, nz).normalize());
      // A third of the value the sparks are given. The ring's own shader pushes
      // its spine past white; the tint is only there to say what colour the
      // *flanks* are, and a tint already above 4.0 linear leaves no flanks.
      //
      // Kept on the surface, not on the lifted point — a shock front that is
      // not lying on the deck is not a shock front. It clears the deck by the
      // 3cm it always did, and it is a ring rather than a filled card so the
      // depth test can only ever eat its far lip.
      this.shockwaves.spawn(
        ev.x + nx * 0.03, ev.y + ny * 0.03, ev.z + nz * 0.03, _q,
        t, heavy ? 0.15 : 0.11, 0.2, (heavy ? 1.5 : 0.85) * Math.min(gain, 1.7),
        _rgb[0] * 0.42, _rgb[1] * 0.38, _rgb[2] * 0.30
      );
      // Short-lived, as a scorch from a rifle round should be. At 7.5s the mark
      // a single bullet left outlived four more bursts of them, and — because
      // the decal shader ramps in over the first 4% of a life — it took 300ms
      // to arrive, so the only thing the contact sheet was measuring at 250ms
      // was a stain fading UP. At 1.1s that ramp is 44ms and the mark is there
      // with the flash.
      this._decal(ev.x, ev.y, ev.z, nx, ny, nz, (heavy ? 1.1 : 0.55) * gain, 1.1);
    } else {
      const prox = this._proximity(ev.x, ev.y, ev.z);
      const mag = (heavy ? 0.24 : 0.06) * prox;
      this._addShake(vfxRng.s() * mag, vfxRng.s() * mag * 0.7, vfxRng.s() * mag, vfxRng.s() * mag * 0.05);
    }
  }

  _decal(x, y, z, nx, ny, nz, size, life = 7.5) {
    if (!this.settings.decals) return;
    _q.setFromUnitVectors(_v2.set(0, 0, 1), _v.set(nx, ny, nz).normalize());
    this.decals.spawn(
      x + nx * 0.012, y + ny * 0.012, z + nz * 0.012, _q,
      this.time, life, size, size * 1.05, 0.05, 0.04, 0.045
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
   *   0-50ms    flash — a rayed card and a smooth white-hot core, over before
   *             you can focus on it, but it is what makes the hit feel *hard*
   *   0-700ms   fireball — dense turbulent billows thrown off the core and
   *             stalling, white-hot in the middle and soot at the rim, tearing
   *             open and rising as they burn out
   *   0-260ms   shock — a thin bright front racing out along the deck with the
   *             deck visibly compressed behind it
   *   50ms-1.3s dust wave — pale, fast, flat, hugging the floor
   *   250ms-2s  smoke — dark, ragged, rising off what is left of the fire
   *   0-1.5s    debris — sparks and chunks on sim gravity, arcing and falling
   *   0-550ms   light — the blast throws real light onto the arena
   *
   * The one thing every stage shares is that it is integrated on the GPU from
   * (birth, life) against the effect clock, so the whole sequence is exact at
   * any frame rate and holds still when a capture writes an age into it.
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
    // Two frames and small. The old card lived 100ms and grew to four radii of
    // near-white, which bloom then smeared over the entire arena: the blast
    // washed out the very value structure it was supposed to be punching a hole
    // in, and the fireball behind it was invisible until the card had gone.
    //
    // Both parts of it now arrive at nearly full size on the *first* frame
    // rather than easing up to it. They used to start at a fifth of their final
    // radius, so the brightest thing in the whole sequence happened seventy
    // milliseconds after the bang: the blast ramped up instead of detonating,
    // and a detonation that ramps has no hardness. Big immediately, gone in
    // three frames, is the shape of the curve — it is the *duration* of the old
    // flash that washed the arena out, not its size.
    _v.set(x, y, z);
    this.flares.spawn(x, y, z, this._faceCamera(_v), t, 0.050,
      R * 0.85, R * 1.30, 6.6, 5.7, 4.6);
    this.fireballs.spawn(x, y, z, null, t, 0.075, R * 0.30, R * 0.52,
      1.0, 0.96, 0.90, 0);

    // --- 2. fireball cluster ---------------------------------------------
    // The core of the cluster outlives the lobes thrown off it, and it is what
    // stops the blast becoming a handful of separate balloons drifting apart at
    // half a second — which is exactly what it used to do, because every part
    // was thrown and nothing stayed behind to bridge them.
    this.fireballs.spawn(x, y + R * 0.04, z, null, t, 0.72, R * 0.22, R * 0.72,
      hr, hg, hb, 1, 0, R * 0.16, 0);
    /**
     * -----------------------------------------------------------------------
     * THE COMPOSITION CUT: TRIED, MEASURED, REVERTED. FOURTH HYPOTHESIS DOWN.
     * -----------------------------------------------------------------------
     * SPEC-CRV2 clause F asks for effects that are "large, FEW and hard-edged",
     * and round 18's verdict named recomposing the detonation from a handful of
     * large elements as the single piece of work that would move the card most.
     * It was done and it does not work. Recorded here so nobody spends the
     * round again.
     *
     * Counts were cut roughly to a third — billows 7 -> 4, smoke shells 3 -> 2,
     * dust 18 -> 5, plume 16 -> 5, sparks 72 -> 14, chunks 12 -> 6, 128 elements
     * down to about 37 — with the survivors grown (lobe radius 0.30-0.48 R ->
     * 0.44-0.68 R) and thrown less far so they still shared one silhouette.
     * Measured on the same pinned blast by shots/_r17-edge.mjs:
     *
     *     age        1     4     7    12    20    32    48    72
     *     before  31.75  30.0  23.0  28.8  25.5  22.0  25.5  28.8
     *     after   31.75  29.3  21.8  30.0  29.0  28.3   2.5  29.3
     *
     * **The 10-90 boundary does not move**, exactly as it did not move for the
     * shell-alpha hypothesis before it. The single figure that did move is the
     * regression: coverage at 800ms fell from 6.7% of frame to 0.4%, which is
     * this file's own documented failure — "there was no late blast left to be
     * muddy because there was no late blast".
     *
     * WHAT THE FOUR FAILED HYPOTHESES POINT AT. Shell alpha, the post chain,
     * and now element count have each been changed hard and none moved the
     * number. What is left is the thing none of them touched: the radial
     * TEMPERATURE gradient. A lobe is white at the centre, yellow and orange
     * around it, deep red at the rim and soot at the silhouette, deliberately,
     * at every age — see the heat ramp in SHELL_FRAG. That gradient IS the soft
     * boundary the meter measures, and it is not an accident or a soft-particle
     * artifact; it is the thing that makes the mass read as burning gas rather
     * than as a decal.
     *
     * So clause F and this effect's art direction are in direct conflict, and
     * that is a judgement the review has to make rather than a defect a builder
     * should quietly fix. The spec's own warning cuts both ways here: "we are
     * not obliged to inherit the limitation, only to beat the result." Deleting
     * the temperature field to pass a clause derived from hardware that could
     * not draw one is exactly the regression that warning describes — but so is
     * carrying a FAIL forever because the fix is unpalatable. **Whoever takes
     * this next should get a ruling on that before writing any code.**
     */
    const billows = Math.round((s > 0.5 ? 7 : 4));
    for (let i = 0; i < billows; i++) {
      const a = (i / billows) * 6.283 + vfxRng.f() * 0.8;
      const el = vfxRng.f() * 1.0 - 0.22;
      const ce = Math.cos(el);
      const ca = Math.cos(a) * ce, sa = Math.sin(a) * ce, ea = Math.sin(el);
      const rad = R * (0.10 + vfxRng.f() * 0.22);
      // Thrown outward with a real velocity spread and a drag term, so the
      // cluster blows apart fast and then hangs: the outline at 60ms, at 200ms
      // and at 500ms are three different shapes. Thrown a little less far, and
      // grown a little larger, than it was: the lobes have to stay overlapped
      // enough to share one silhouette.
      const sp = R * (1.1 + vfxRng.f() * 1.6);
      this.fireballs.spawn(
        x + ca * rad, y + ea * rad * 0.8 + R * 0.04, z + sa * rad, null,
        t + i * 0.016, 0.50 + vfxRng.f() * 0.40, R * 0.09, R * (0.30 + vfxRng.f() * 0.18),
        hr, hg, hb, 1,
        ca * sp, ea * sp + R * 0.50, sa * sp
      );
    }

    // --- 3. shock front ---------------------------------------------------
    // One front, not a family of them. Short, hot, and strongly decelerating.
    // It also stops well short of where it used to. A front that ends up five
    // radii across is a ring twenty metres wide drawn over the two machines the
    // frame is about — the blast may own the screen for a third of a second, but
    // it may not own it by drawing a circle round the whole fight.
    if (grounded) {
      this.shockwaves.spawn(x, deck, z, null, t, 0.24, R * 0.42, R * 1.9,
        1.85, 0.80, 0.30, 0);
    } else {
      this.shockwaves.spawn(x, y, z, null, t, 0.20, R * 0.40, R * 1.6,
        1.70, 0.74, 0.28, 0);
    }

    // --- 4. ground-hugging dust wave -------------------------------------
    // Pale, flat and fast, with enough drag that it piles up at the end of its
    // run. Deliberately a different colour, speed and direction from the smoke
    // so the two never read as one grey mass.
    //
    // The colour is the important number here and it was five times too high.
    // These particles are unlit and `toneMapped: false`, so the value written
    // is very nearly the value that lands: 0.92 linear encodes to sRGB 247, and
    // eighteen overlapping sprites of near-white beige at a=0.62 is precisely
    // the "large pale smoke dome covering the fight" an earlier version of this
    // effect was rejected for. It scored *better* on the arena's value-band
    // metric while doing it, because a big mid-tone flatters a histogram.
    //
    // A blast on a deck that measures 81 cannot throw up dust that measures
    // 247. At 0.17 linear it encodes to about 113 — a pale wave that reads
    // against the deck without ever competing with the machines standing on it,
    // and it is now neutral rather than beige, so it cannot be mistaken for a
    // second fireball. What sells a ground wave is that it is fast, flat and
    // going somewhere, not that it is bright.
    if (grounded) {
      const dustN = Math.round(18 * s * scale);
      for (let i = 0; i < dustN; i++) {
        const a = (i / dustN) * 6.283 + vfxRng.s() * 0.5;
        const ca = Math.cos(a), sa = Math.sin(a);
        const sp = R * (2.6 + vfxRng.f() * 1.8);
        this.smoke.spawn(
          x + ca * R * 0.25, deck + 0.06 + vfxRng.f() * 0.2, z + sa * R * 0.25,
          ca * sp, 0.35 + vfxRng.f() * 0.55, sa * sp,
          t + vfxRng.f() * 0.05, 0.62 + vfxRng.f() * 0.42, R * (0.10 + vfxRng.f() * 0.05),
          0.175, 0.170, 0.168, -0.22, 3.0, 2
        );
      }
    }

    // --- 5. smoke ---------------------------------------------------------
    // Volumes rather than a cloud of billboards, because the fireball has to
    // hand off to something with the same silhouette or the blast visibly
    // changes species halfway through. Three of them, dark, no bigger than the
    // fire that made them, and eroded to rags by the shader.
    //
    // Sized DOWN from where it was, and this is the whole of the fix for the
    // late life. The shells used to reach R*0.70..0.96 each, so three of them
    // offset by up to R*0.27 covered more of the screen than the fireball ever
    // had: measured on the contact sheet, the mass hit its greatest area —
    // 53.4% of the crop against the fireball's 48.6% — at 470ms, and was still
    // painting a third of it at 950ms. An explosion whose largest moment is
    // after the fire has gone out is not an explosion, it is a curtain.
    //
    // They also rise harder and die sooner. What the smoke is *for* is the
    // silhouette change — ball becomes rising stalked column — and it can only
    // do that by leaving, which is the same thing as giving the fight back.
    //
    // "Rise harder" was taken much too literally. R*(1.8..2.7) on a four-metre
    // blast is eight to eleven metres a second, and at eleven metres a second a
    // mass clears the top of the picture in about four hundred milliseconds.
    // The sheet showed the consequence as a cliff — cover 27.9% at 470ms, 12.7%
    // at 560ms — and the cliff was not the smoke thinning, it was the smoke
    // leaving. Two to four metres a second instead: enough to stalk the column
    // and drift it off the crater, slow enough that the thinning happens where
    // it can be seen. The life is lengthened to match, because the point of the
    // stage is the dispersal and the dispersal is now allowed to take place.
    const smokeShells = s > 0.5 ? 3 : 2;
    for (let i = 0; i < smokeShells; i++) {
      const a = vfxRng.f() * 6.283;
      const rad = R * (0.04 + vfxRng.f() * 0.16);
      this.fireballs.spawn(
        x + Math.cos(a) * rad, y + R * 0.10, z + Math.sin(a) * rad, null,
        t + 0.17 + i * 0.075, 1.55 + vfxRng.f() * 0.6,
        R * 0.30, R * (0.46 + vfxRng.f() * 0.16),
        1.0, 0.92, 0.86, SHELL_SMOKE_KIND,
        Math.cos(a) * R * 0.14, R * (0.55 + vfxRng.f() * 0.45), Math.sin(a) * R * 0.14
      );
    }
    // --- 5b. the rising plume, and the settle -----------------------------
    // The third and fourth stages of the blast, and until now they did not
    // exist. Six sprites of R*0.10..0.17 at fifteen metres are thirteen screen
    // pixels each: measured on the contact sheet, once the fire was fixed to go
    // out on schedule the whole effect fell from 27.1% of the crop at 650ms to
    // 5.8%, and to 4.8% at 950ms. The blast went fireball, fireball, nothing.
    // A detonation that stops rather than dissipates has no weight, because
    // nothing is left to say the air it happened in was disturbed.
    //
    // Sprites rather than another shell, deliberately, and this is the answer
    // to the failure this effect has been rejected for twice. A shell can only
    // ever be ONE silhouette, so a shell big enough to be a presence is a dome,
    // and a dome over the fight is an occlusion bug however it is coloured.
    // Sixteen independent puffs rising at different speeds from different
    // offsets separate as they climb: the mass breaks into pieces on its own,
    // with gaps between them that are the arena, and it cannot facet the way a
    // coarse displaced icosahedron does.
    //
    // Three guards keep it atmosphere rather than a curtain:
    //
    //  * VALUE. Round 6's dust was 0.92 linear, which is sRGB 247 on a deck
    //    that measures 81 — brighter than anything in the arena including the
    //    machines. These sit at 0.05..0.12 linear, i.e. sRGB 63..90, at or
    //    below the deck. Soot is darker than what it drifts across; that is
    //    what makes it a hole rather than a lamp, and it is what finally lets
    //    the late blast measure NEGATIVE on the sheet's signed-change column.
    //  * FADE. Mode 3, which never holds — see the note in the particle vertex
    //    stage. The plume is thinning from the moment it appears.
    //  * DIRECTION. They rise, and they carry enough outward velocity to lean.
    //    A fight happens at deck level, so a mass that leaves upward is a mass
    //    that has stopped standing in front of the machines.
    //
    // Temperature over the plume's life comes free from WHEN each puff is born
    // rather than from any shader work: a puff that forms at 200ms forms in
    // light from a fire that is still burning, and one that forms at 700ms
    // forms in the dark. So warmth is keyed to the birth offset and the plume
    // grades itself from ember-lit brown at the base to cold blue-grey soot at
    // the top, which is also the direction the eye reads a rising column in.
    const plumeN = Math.round(16 * s * scale);
    for (let i = 0; i < plumeN; i++) {
      const a = (i / plumeN) * 6.283 + vfxRng.s() * 0.9;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rad = R * (0.05 + vfxRng.f() * 0.34);
      const bt = 0.18 + vfxRng.f() * 0.62;
      // 1 for a puff that forms while there is still fire, 0 once there is not.
      const warmth = Math.max(0, 1 - bt / 0.55);
      const out = R * (0.18 + vfxRng.f() * 0.40);
      this.smoke.spawn(
        x + ca * rad, y + R * (0.04 + vfxRng.f() * 0.48), z + sa * rad,
        ca * out, 1.5 + vfxRng.f() * 2.5, sa * out,
        t + bt, 1.15 + vfxRng.f() * 0.90, R * (0.12 + vfxRng.f() * 0.10),
        0.052 + warmth * 0.070, 0.052 + warmth * 0.022, 0.058 + warmth * 0.002,
        -0.55, 1.35, 3
      );
    }

    // --- 6. debris --------------------------------------------------------
    // Gravity 26 is the sim's own constant, so the arcs match how a knocked-down
    // robo falls. Low drag keeps them ballistic instead of floaty.
    const sparkN = Math.round(72 * s * scale);
    for (let i = 0; i < sparkN; i++) {
      const a = vfxRng.f() * 6.283;
      const el = vfxRng.f() * 1.5 - 0.15;
      const ce = Math.cos(el);
      // A wide speed spread is what makes debris read as thrown rather than
      // released: the fast tail outruns the fireball and is visible against the
      // deck while the slow bulk is still inside the fire.
      const fast = vfxRng.f();
      const sp = R * (1.4 + fast * fast * 6.0);
      const heat = 0.55 + vfxRng.f() * 0.8;
      // Sized in *world* units and then divided by depth, so 0.035 at the
      // fifteen metres a duel is actually fought at came out as a three-pixel
      // streak: the debris was there in the buffer and was not there in the
      // frame. Tripled, it is a legible chunk of thrown metal at duel range and
      // still small enough not to become a firework at contact range.
      this.sparks.spawn(
        x, y, z,
        Math.cos(a) * ce * sp, Math.sin(el) * sp + 4.5, Math.sin(a) * ce * sp,
        t, 0.45 + vfxRng.f() * 1.0, 0.10 + vfxRng.f() * 0.14,
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
        t, 0.7 + vfxRng.f() * 0.7, R * (0.040 + vfxRng.f() * 0.035),
        0.13, 0.115, 0.105, 26, 0.1, 0
      );
    }

    // --- 7. light on the arena -------------------------------------------
    const li = this.lightCursor % this.lights.length;
    this.lightCursor++;
    const l = this.lights[li];
    l.position.set(x, y + 0.45, z);
    l.color.setRGB(1.0, 0.58, 0.24);
    l.distance = R * 9;
    l.visible = true;
    this.lightBirth[li] = t;
    this.lightLife[li] = 0.55;
    this.lightPeak[li] = 300 * scale;
    l.intensity = this.lightPeak[li];

    const prox = this._proximity(x, y, z);
    const mag = scale * prox * 0.8;
    this._addShake(vfxRng.s() * mag, vfxRng.s() * mag * 0.8, vfxRng.s() * mag, vfxRng.s() * mag * 0.05);

    if (grounded) this._decal(x, 0.001, z, 0, 1, 0, R * 1.15);
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
      // Dust displaced by a landing, not burning gas: low value, so what carries
      // it is the dark compression lip rather than the light.
      this.shockwaves.spawn(ev.x, ev.y + 0.04, ev.z, null, t,
        0.17, 0.4, 2.4 * power, 1.00, 0.92, 0.80, 0);
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
    hot(0xa8e0ff, 1.1, _rgb);
    this.shockwaves.spawn(ev.x, ev.y + 0.04, ev.z, null, t, 0.16, 0.3, 1.7,
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
    hot(0xffe27a, 1.6, _rgb);
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
    // and the buffer traffic is halved. The budget accrues per *second*, not
    // per frame: `+= intensity * 0.9` made the plume twice as dense at 120fps
    // as at 60, and — because a spawn draws six values out of `vfxRng` — it
    // also made every downstream random effect depend on how many frames had
    // been drawn, which is why two capture runs of the same frozen blast were
    // two different blasts.
    this._thrusterAccum[index] += intensity * 54 * this.frameDt;
    if (this._thrusterAccum[index] < 1) return;
    this._thrusterAccum[index] -= 1;

    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    // Squared, and starting well under the bloom threshold (1.04). The old
    // `1.6 + intensity * 1.4` put a *walking* machine's exhaust above it, so the
    // plume bloomed continuously — and a permanently blooming light source on
    // each robot is one of the first things the eye finds in a still frame with
    // nothing detonating, which is the thing the effects layer is not allowed to
    // be. Now idle and walking exhaust is a dim ember that stays inside the
    // frame's own value range, and only a real boost (intensity approaching the
    // 1.6 a dash produces) clears the threshold and glows. The dynamic range
    // between drifting and burning is much larger for it.
    hot(teamColor, 0.55 + intensity * intensity * 1.35, _rgb);
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
    // Clamped: a tab that was backgrounded hands back a delta of seconds, and
    // an emitter that believes it would dump a whole plume in one frame.
    this.frameDt = dt > 0 ? Math.min(dt, 1 / 15) : 0;

    const pr = 1;
    this.sparks.material.uniforms.uPixelRatio.value = pr;
    this.smoke.material.uniforms.uPixelRatio.value = pr;
    this.energy.material.uniforms.uPixelRatio.value = pr;
    // Streak alignment happens in NDC, so it needs the frame's aspect to know
    // which way "along the velocity" actually points on screen. Both aligned
    // batches need it: on a phone held upright the difference between the real
    // aspect and the 16/9 the uniform is initialised to is enough to swing a
    // plume noticeably off its own flight path.
    const asp = this.camera?.aspect || 16 / 9;
    this.sparks.material.uniforms.uAspect.value = asp;
    this.energy.material.uniforms.uAspect.value = asp;

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

  /**
   * Reseed the visual-jitter RNG.
   *
   * `vfxRng` is seeded from `Math.random()` at module load, and that is right
   * for play: two grenades landing in the same crater should not break up into
   * the same seven billows. It is fatal for measurement. Every capture of an
   * explosion is therefore of a *different* explosion, so a sheet shot before a
   * change and a sheet shot after it differ by the change plus a fresh set of
   * random lobes, and no per-frame number on them is attributable to anything.
   *
   * Capture harnesses call this immediately before igniting. Nothing in
   * gameplay calls it, so play keeps its variety.
   */
  seedJitter(seed) {
    vfxRng.load(new Rng((seed >>> 0) || 1).save());
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
    // The per-frame impact allowance is only ever reset at the top of
    // `handleEvents`, and that is only reached on a tick that produced events.
    // Leave it set and the first impacts after a wipe are silently swallowed —
    // which is exactly what happened to every `--effect impact` capture ever
    // taken: the harness clears, calls `_hit` directly with the sim paused, and
    // the budget was still saturated from the firefight before the freeze.
    this._impactBudget = 0;
    this._thrusterAccum[0] = this._thrusterAccum[1] = 0;
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
