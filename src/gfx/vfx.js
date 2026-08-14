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
import { EV, PK } from '../sim/constants.js';
import { GUNS, BOMBS, PODS } from '../sim/parts.js';
import { MAX_PROJ } from '../sim/world.js';
import { vfxRng, clamp } from '../core/mathx.js';

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
  float grow = aFlags.z < 1.5 ? (1.0 - t * 0.55) : (0.55 + t * 1.5);
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
  constructor(capacity, map, { additive = true, opacity = 1, sizeScale = 1, renderOrder = 5, maxSize = 190 } = {}) {
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
varying float vT;
varying vec4 vTint;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Expand perpendicular to the segment IN VIEW SPACE, which is what makes the
  // ribbon face the camera regardless of which way the shot is travelling.
  vec3 dirV = mat3(modelViewMatrix) * aDir;
  vec2 perp = vec2(-dirV.y, dirV.x);
  float len = length(perp);
  perp = len > 0.0001 ? perp / len : vec2(1.0, 0.0);
  mv.xy += perp * aSide * aMeta.y * (1.0 - aMeta.x * 0.75);
  gl_Position = projectionMatrix * mv;
  vT = aMeta.x;
  vTint = aTint;
}`;

const TRAIL_FRAG = /* glsl */`
precision mediump float;
varying float vT;
varying vec4 vTint;
void main() {
  float a = pow(1.0 - vT, 1.6) * vTint.a;
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vTint.rgb * (0.4 + (1.0 - vT) * 1.5), a);
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
      uniforms: {},
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
  push(slot, x, y, z, r, g, b, width, fresh) {
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
    for (let i = 0; i < seg; i++) {
      const px = h[i * 3], py = h[i * 3 + 1], pz = h[i * 3 + 2];
      // Direction toward the previous sample gives the ribbon its orientation.
      const j = Math.min(seg - 1, i + 1);
      let dx = h[j * 3] - px, dy = h[j * 3 + 1] - py, dz = h[j * 3 + 2] - pz;
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-5) { dx = 0; dy = 1; dz = 0; } else { dx /= l; dy /= l; dz /= l; }

      const v = base + i * 2;
      for (let k = 0; k < 2; k++) {
        const o = v + k;
        const o3 = o * 3;
        const o4 = o * 4;
        this.position[o3] = px; this.position[o3 + 1] = py; this.position[o3 + 2] = pz;
        this.dir[o3] = dx; this.dir[o3 + 1] = dy; this.dir[o3 + 2] = dz;
        this.meta[o * 2 + 1] = width;
        this.tint[o4] = r; this.tint[o4 + 1] = g; this.tint[o4 + 2] = b; this.tint[o4 + 3] = 1;
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

const SHELL_VERT = /* glsl */`
attribute vec4 aLife;     // birth, life, scale0, scale1
attribute vec4 aTint;     // rgb + kind
uniform float uTime;
varying float vT;
varying vec4 vTint;
varying vec2 vUv;

void main() {
  float age = uTime - aLife.x;
  float t = age / aLife.y;
  if (age < 0.0 || t > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vT = 2.0;
    return;
  }
  // Fast out, slow settle — the classic detonation curve.
  float e = 1.0 - pow(1.0 - t, 2.6);
  float s = mix(aLife.z, aLife.w, e);
  vec3 p = position * s;
  vUv = uv;
  vT = t;
  vTint = aTint;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}`;

const SHELL_FRAG = /* glsl */`
precision mediump float;
varying float vT;
varying vec4 vTint;
varying vec2 vUv;
uniform sampler2D uMap;
uniform float uUseMap;
uniform float uSoot;      // 1 = scorch decal: dark, no hot ramp, slow fade

void main() {
  if (vT > 1.0 || vT < 0.0) discard;
  float fade = 1.0 - vT;
  vec3 col = vTint.rgb;
  float a;

  if (uSoot > 0.5) {
    // Scorch marks are burnt material, not light: they must never brighten the
    // floor, and they linger rather than flash.
    a = smoothstep(0.0, 0.06, vT) * pow(fade, 0.8) * 0.5;
  } else {
    // Cool from white-hot through the tint as the shell expands.
    col = mix(vec3(2.6, 2.3, 1.9), col, smoothstep(0.0, 0.42, vT));
    col *= 0.6 + fade * 1.9;
    a = pow(fade, 1.4);
  }

  if (uUseMap > 0.5) {
    vec4 t = texture2D(uMap, vUv);
    col *= t.rgb;
    a *= t.a;
  }
  if (a <= 0.004) discard;
  gl_FragColor = vec4(col, a);
}`;

class ShellPool {
  constructor(geometry, capacity, map = null, { renderOrder = 7, soot = false } = {}) {
    this.capacity = capacity;
    this.cursor = 0;
    this.life = new Float32Array(capacity * 4);
    this.tint = new Float32Array(capacity * 4);

    const g = geometry;
    this.aLife = new THREE.InstancedBufferAttribute(this.life, 4).setUsage(THREE.DynamicDrawUsage);
    this.aTint = new THREE.InstancedBufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aLife', this.aLife);
    g.setAttribute('aTint', this.aTint);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: map },
        uUseMap: { value: map ? 1 : 0 },
        uSoot: { value: soot ? 1 : 0 },
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

  spawn(x, y, z, quat, birth, life, from, to, r, g, b) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;
    this._p.set(x, y, z);
    this._m.compose(this._p, quat || this._q.identity(), this._s);
    this.mesh.setMatrixAt(i, this._m);
    const i4 = i * 4;
    this.life[i4] = birth; this.life[i4 + 1] = life;
    this.life[i4 + 2] = from; this.life[i4 + 3] = to;
    this.tint[i4] = r; this.tint[i4 + 1] = g; this.tint[i4 + 2] = b; this.tint[i4 + 3] = 1;
    this._dirty = true;
  }

  flush(time) {
    this.material.uniforms.uTime.value = time;
    if (!this._dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aLife.needsUpdate = true;
    this.aTint.needsUpdate = true;
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

const _rgb = [0, 0, 0];

export class VFX {
  constructor(scene, settings, camera, theme) {
    this.scene = scene;
    this.settings = settings;
    this.camera = camera;
    this.theme = theme || {};
    this.time = 0;
    this.sp = sprites();

    const budget = settings.particleBudget;

    // --- particle batches -------------------------------------------------
    this.sparks = new ParticleBatch(Math.round(budget * 0.5), this.sp.spark, { additive: true, sizeScale: 1 });
    this.smoke = new ParticleBatch(Math.round(budget * 0.28), this.sp.smoke, { additive: false, opacity: 0.34, renderOrder: 4, maxSize: 150 });
    this.energy = new ParticleBatch(Math.round(budget * 0.22), this.sp.glow, { additive: true, sizeScale: 1.15 });
    scene.add(this.smoke.points, this.sparks.points, this.energy.points);

    // --- trails -----------------------------------------------------------
    this.trails = new TrailPool(Math.min(MAX_PROJ, 96), Math.max(4, settings.trailSegments));
    scene.add(this.trails.mesh);

    // --- expanding shells -------------------------------------------------
    const sphere = new THREE.IcosahedronGeometry(1, settings.bloomQuality >= 2 ? 2 : 1);
    this.fireballs = new ShellPool(sphere, 24);
    scene.add(this.fireballs.mesh);

    const ring = new THREE.RingGeometry(0.72, 1.0, 40, 1);
    ring.rotateX(-Math.PI / 2);
    this.shockwaves = new ShellPool(ring, 20, null, { renderOrder: 8 });
    scene.add(this.shockwaves.mesh);

    const flareQuad = new THREE.PlaneGeometry(1, 1);
    this.flares = new ShellPool(flareQuad, 48, this.sp.flare, { renderOrder: 9 });
    scene.add(this.flares.mesh);

    // --- projectile bodies ------------------------------------------------
    this._buildProjectileMeshes();

    // --- decals -----------------------------------------------------------
    this._buildDecals();

    // --- dynamic explosion lights ----------------------------------------
    this.lights = [];
    this.lightTimers = [];
    const lightCount = settings.lights >= 4 ? 3 : 1;
    for (let i = 0; i < lightCount; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 26, 2);
      l.visible = false;
      scene.add(l);
      this.lights.push(l);
      this.lightTimers.push(0);
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

    // Bullets: a stretched octahedron reads as a bolt from every angle and
    // costs 8 triangles.
    const boltGeo = new THREE.OctahedronGeometry(1, 0);
    boltGeo.scale(1, 1, 2.4);
    this.bolts = new THREE.InstancedMesh(
      boltGeo,
      new THREE.MeshBasicMaterial({
        transparent: true, blending: THREE.AdditiveBlending,
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
    this.decals = new ShellPool(geo, cap, this.sp.smoke, { renderOrder: 3, soot: true });
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

    hot(look.colour, charged ? 3.4 : 2.1, _rgb);

    // Flare card oriented to face the camera, scaled by the muzzle style.
    const styleScale = look.muzzle === 'lance' ? 2.4 : look.muzzle === 'cone' ? 1.7 : 1.2;
    _v.set(ev.x + dx * 0.5, ev.y + dy * 0.5, ev.z + dz * 0.5);
    this.flares.spawn(
      _v.x, _v.y, _v.z, this._faceCamera(_v),
      t, charged ? 0.19 : 0.085,
      (charged ? 0.2 : 0.1) * styleScale, (charged ? 0.62 : 0.26) * styleScale,
      _rgb[0], _rgb[1], _rgb[2]
    );

    // A pop of sparks along the barrel line.
    const n = Math.round((charged ? 22 : 7) * s);
    for (let i = 0; i < n; i++) {
      const sp = (charged ? 9 : 5) * (0.4 + vfxRng.f());
      this.sparks.spawn(
        ev.x, ev.y, ev.z,
        dx * sp + vfxRng.s() * 2.4, dy * sp + vfxRng.s() * 2.4 + 0.6, dz * sp + vfxRng.s() * 2.4,
        t, 0.12 + vfxRng.f() * 0.18, (charged ? 0.1 : 0.055) * (0.6 + vfxRng.f()),
        _rgb[0], _rgb[1], _rgb[2], 4, 3.2, 0
      );
    }

    // Recoil smoke wisp.
    if (this.settings.particleBudget >= 600) {
      for (let i = 0; i < Math.round(2 * s) + 1; i++) {
        this.smoke.spawn(
          ev.x + dx * 0.3, ev.y + dy * 0.3, ev.z + dz * 0.3,
          dx * 1.6 + vfxRng.s(), dy * 1.6 + 0.9, dz * 1.6 + vfxRng.s(),
          t, 0.5 + vfxRng.f() * 0.3, 0.14 + vfxRng.f() * 0.1,
          0.5, 0.52, 0.58, -0.6, 2.2, 2
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
    hot(colour, heavy ? 3.2 : 2.2, _rgb);

    const n = Math.round((heavy ? 26 : 11) * s);
    for (let i = 0; i < n; i++) {
      // Cone around the surface normal, with a wide skirt.
      const spread = heavy ? 1.5 : 1.0;
      const vx = nx * 5 + vfxRng.s() * 5 * spread;
      const vy = ny * 5 + vfxRng.s() * 4 * spread + 1.5;
      const vz = nz * 5 + vfxRng.s() * 5 * spread;
      this.sparks.spawn(
        ev.x, ev.y, ev.z, vx, vy, vz,
        t, 0.24 + vfxRng.f() * 0.4, 0.045 + vfxRng.f() * 0.05,
        _rgb[0], _rgb[1], _rgb[2], 16, 1.4, 0
      );
    }

    // Flash card.
    _v.set(ev.x, ev.y, ev.z);
    this.flares.spawn(ev.x, ev.y, ev.z, this._faceCamera(_v), t,
      heavy ? 0.14 : 0.07, 0.08, heavy ? 0.42 : 0.22, _rgb[0], _rgb[1], _rgb[2]);

    // Surface ring, oriented to the impact normal.
    if (surface) {
      _q.setFromUnitVectors(_up, _v2.set(nx, ny, nz).normalize());
      this.shockwaves.spawn(
        ev.x + nx * 0.03, ev.y + ny * 0.03, ev.z + nz * 0.03, _q,
        t, 0.28, 0.14, heavy ? 1.5 : 0.8, _rgb[0] * 0.7, _rgb[1] * 0.7, _rgb[2] * 0.7
      );
      this._decal(ev.x, ev.y, ev.z, nx, ny, nz, heavy ? 1.1 : 0.55);
    } else {
      // Armour spark ring facing the shot.
      this.shockwaves.spawn(
        ev.x, ev.y, ev.z, this._faceCameraUp(_v),
        t, 0.22, 0.2, heavy ? 1.4 : 0.7, 1.8, 1.1, 0.7
      );
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
    const t = this.time;
    const s = this._budgetScale();
    const R = ev.radius || 3;
    const isPod = ev.kind === PK.POD;
    const part = isPod ? PODS[ev.part] || PODS[0] : BOMBS[ev.part] || BOMBS[0];
    const look = part.look;

    hot(look.colour, 2.6, _rgb);

    // (a) white-hot core
    this.fireballs.spawn(ev.x, ev.y, ev.z, null, t, 0.42, R * 0.14, R * 0.72,
      _rgb[0], _rgb[1], _rgb[2]);
    this.fireballs.spawn(ev.x, ev.y, ev.z, null, t + 0.04, 0.62, R * 0.05, R * 1.0,
      _rgb[0] * 0.5, _rgb[1] * 0.42, _rgb[2] * 0.35);

    // (b) ground-aligned shockwave
    this.shockwaves.spawn(ev.x, Math.max(0.03, ev.y - R * 0.35), ev.z, null,
      t, 0.55, R * 0.2, R * 2.1, 2.2, 1.7, 1.2);
    // and a second one facing the camera, so it reads in the air too
    _v.set(ev.x, ev.y, ev.z);
    this.shockwaves.spawn(ev.x, ev.y, ev.z, this._faceCameraUp(_v),
      t, 0.4, R * 0.1, R * 1.5, _rgb[0], _rgb[1], _rgb[2]);

    // (c) billowing smoke
    const smokeN = Math.round(18 * s * clamp(R / 3.4, 0.6, 1.8));
    for (let i = 0; i < smokeN; i++) {
      const a = vfxRng.f() * 6.283;
      const el = vfxRng.f() * 1.2;
      const sp = R * (0.5 + vfxRng.f() * 0.9);
      this.smoke.spawn(
        ev.x + vfxRng.s() * R * 0.2, ev.y + vfxRng.f() * R * 0.25, ev.z + vfxRng.s() * R * 0.2,
        Math.cos(a) * sp * Math.cos(el), sp * Math.sin(el) * 0.7 + 1.2, Math.sin(a) * sp * Math.cos(el),
        t + vfxRng.f() * 0.09, 1.0 + vfxRng.f() * 0.9, R * (0.09 + vfxRng.f() * 0.08),
        0.34, 0.31, 0.3, -0.7, 1.5, 2
      );
    }

    // (d) debris / spark shower with real gravity
    const sparkN = Math.round(52 * s * clamp(R / 3.4, 0.6, 1.6));
    for (let i = 0; i < sparkN; i++) {
      const a = vfxRng.f() * 6.283;
      const el = vfxRng.f() * 1.5 - 0.2;
      const sp = R * (1.2 + vfxRng.f() * 2.4);
      this.sparks.spawn(
        ev.x, ev.y, ev.z,
        Math.cos(a) * sp * Math.cos(el), sp * Math.sin(el) + 3, Math.sin(a) * sp * Math.cos(el),
        t, 0.5 + vfxRng.f() * 0.9, 0.05 + vfxRng.f() * 0.08,
        _rgb[0] * 1.3, _rgb[1] * 1.05, _rgb[2] * 0.7, 20, 0.9, 0
      );
    }

    // (e) transient light
    const li = this.lightCursor % this.lights.length;
    this.lightCursor++;
    const l = this.lights[li];
    l.position.set(ev.x, ev.y + 0.3, ev.z);
    l.color.setRGB(clamp(_rgb[0], 0, 1), clamp(_rgb[1], 0, 1), clamp(_rgb[2], 0, 1));
    l.intensity = 60 * clamp(R / 3.4, 0.5, 2);
    l.distance = R * 7;
    l.visible = true;
    this.lightTimers[li] = 0.34;

    const prox = this._proximity(ev.x, ev.y, ev.z);
    const mag = clamp(R / 3.4, 0.5, 2.2) * prox * 0.5;
    this._addShake(vfxRng.s() * mag, vfxRng.s() * mag * 0.8, vfxRng.s() * mag, vfxRng.s() * mag * 0.05);

    this._decal(ev.x, 0.001, ev.z, 0, 1, 0, R * 0.8);
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
      // Ground kick: a low dust ring.
      this.shockwaves.spawn(ev.x, ev.y + 0.03, ev.z, null, t, 0.4, 0.25, 1.9, 0.9, 0.92, 1.0);
      for (let i = 0; i < Math.round(12 * s); i++) {
        const a = vfxRng.f() * 6.283;
        this.smoke.spawn(
          ev.x, ev.y + 0.06, ev.z,
          Math.cos(a) * 3.2, 0.7 + vfxRng.f(), Math.sin(a) * 3.2,
          t, 0.55 + vfxRng.f() * 0.3, 0.2 + vfxRng.f() * 0.12,
          0.44, 0.45, 0.48, -0.2, 3.0, 2
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
      this.shockwaves.spawn(ev.x, ev.y + 0.03, ev.z, null, t, 0.32, 0.3, 1.5, 0.8, 0.9, 1.0);
    }
    const prox = this._proximity(ev.x, ev.y, ev.z);
    this._addShake(vfxRng.s() * 0.05 * prox, 0, vfxRng.s() * 0.05 * prox, 0);
  }

  _land(ev) {
    const t = this.time;
    const s = this._budgetScale();
    const hard = !!ev.hard;
    const power = clamp((ev.speed || 6) / 16, 0.25, 1.6);

    this.shockwaves.spawn(ev.x, ev.y + 0.03, ev.z, null, t,
      hard ? 0.5 : 0.32, 0.3, (hard ? 3.2 : 1.7) * power, 0.95, 0.97, 1.0);

    const n = Math.round((hard ? 22 : 9) * s * power);
    for (let i = 0; i < n; i++) {
      const a = vfxRng.f() * 6.283;
      const sp = (hard ? 5.5 : 3) * (0.5 + vfxRng.f());
      this.smoke.spawn(
        ev.x + Math.cos(a) * 0.3, ev.y + 0.08, ev.z + Math.sin(a) * 0.3,
        Math.cos(a) * sp, 0.5 + vfxRng.f() * 0.8, Math.sin(a) * sp,
        t, 0.6 + vfxRng.f() * 0.5, 0.2 + vfxRng.f() * 0.16,
        0.46, 0.47, 0.5, -0.15, 2.6, 2
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
    hot(0xa8e0ff, 1.8, _rgb);
    this.shockwaves.spawn(ev.x, ev.y + 0.04, ev.z, null, t, 0.45, 0.2, 2.0,
      _rgb[0], _rgb[1], _rgb[2]);
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
    _v.set(r.pos.x, r.pos.y + 1.0, r.pos.z);
    this.shockwaves.spawn(_v.x, _v.y, _v.z, this._faceCameraUp(_v),
      t, 0.34, 1.9, 0.5, _rgb[0], _rgb[1], _rgb[2]);
  }

  _ko(ev, world) {
    const loser = ev.winner < 0 ? -1 : 1 - ev.winner;
    const r = loser >= 0 ? world?.robos?.[loser] : null;
    if (!r) return;
    // Reuse the explosion recipe at a much larger radius, twice, offset in time.
    this._explode({ x: r.pos.x, y: r.pos.y + 0.9, z: r.pos.z, radius: 6.5, kind: PK.BOMB, part: 0 });
    this.fireballs.spawn(r.pos.x, r.pos.y + 1.2, r.pos.z, null, this.time + 0.12, 0.9, 0.4, 7.5,
      2.4, 1.4, 0.7);
    this._addShake(vfxRng.s() * 1.2, 0.6, vfxRng.s() * 1.2, vfxRng.s() * 0.06);

    // Lingering smoke column.
    const s = this._budgetScale();
    for (let i = 0; i < Math.round(26 * s); i++) {
      this.smoke.spawn(
        r.pos.x + vfxRng.s() * 0.8, r.pos.y + 0.4 + vfxRng.f() * 1.5, r.pos.z + vfxRng.s() * 0.8,
        vfxRng.s() * 1.2, 1.6 + vfxRng.f() * 1.8, vfxRng.s() * 1.2,
        this.time + vfxRng.f() * 0.7, 2.0 + vfxRng.f() * 1.4, 0.3 + vfxRng.f() * 0.25,
        0.3, 0.28, 0.28, -0.5, 0.9, 2
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
      this.time, 0.16 + vfxRng.f() * 0.14, 0.11 + intensity * 0.08,
      _rgb[0], _rgb[1], _rgb[2], 0, 5.5, 1
    );

    if (intensity > 0.8 && this.settings.particleBudget >= 600) {
      this.smoke.spawn(
        pos.x, pos.y, pos.z,
        dx * 2 + vfxRng.s(), dy * 2 + 0.4, dz * 2 + vfxRng.s(),
        this.time, 0.4 + vfxRng.f() * 0.25, 0.11,
        0.5, 0.53, 0.6, -0.4, 3.0, 2
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

    const w = look.width * (charged ? 2.4 : 1) * (1 + p.scale * 0.15);
    const len = look.len * (charged ? 1.6 : 1) * 0.34;
    this._scaleV.set(w * 3.4, w * 3.4, len);
    this._m4.compose(_v2.set(px, py, pz), _q, this._scaleV);
    this.bolts.setMatrixAt(count, this._m4);

    hot(look.colour, look.glow * (charged ? 1.5 : 1), _rgb);
    this.bolts.instanceColor.setXYZ(count, _rgb[0], _rgb[1], _rgb[2]);

    const slot = this._trailSlot(i);
    if (slot >= 0) {
      hot(look.trail, charged ? 2.4 : 1.5, _rgb);
      this.trails.push(slot, px, py, pz, _rgb[0], _rgb[1], _rgb[2],
        look.width * (charged ? 3.2 : 1.6), fresh);
    }

    // Charged rounds carry a corona of their own.
    if (charged && (i & 1) === 0) {
      hot(look.colour, 2.2, _rgb);
      this.energy.spawn(px, py, pz, vfxRng.s() * 0.6, vfxRng.s() * 0.6, vfxRng.s() * 0.6,
        this.time, 0.2, 0.22, _rgb[0], _rgb[1], _rgb[2], 0, 4, 0);
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
      this.trails.push(slot, px, py, pz, _rgb[0] * 0.4, _rgb[1] * 0.4, _rgb[2] * 0.4, 0.09, fresh);
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
      this.trails.push(slot, px, py, pz, _rgb[0], _rgb[1], _rgb[2], 0.07, fresh);
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

    this.sparks.flush(time);
    this.smoke.flush(time);
    this.energy.flush(time);
    this.fireballs.flush(time);
    this.shockwaves.flush(time);
    this.flares.flush(time);
    this.decals.flush(time);

    // Explosion lights decay fast — a lingering one looks like a bug.
    for (let i = 0; i < this.lights.length; i++) {
      if (this.lightTimers[i] <= 0) continue;
      this.lightTimers[i] -= dt;
      const l = this.lights[i];
      if (this.lightTimers[i] <= 0) {
        l.visible = false;
        l.intensity = 0;
      } else {
        l.intensity *= Math.exp(-dt * 9);
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
    for (const l of this.lights) { l.visible = false; l.intensity = 0; }
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
