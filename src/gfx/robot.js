/**
 * The Robo: procedural mecha model, rig and animation.
 *
 * Three ideas carry this file:
 *
 *  1. ONE skeleton, a handful of SkinnedMeshes. Every greeble is baked into a
 *     merged buffer and rigidly bound (one bone, weight 1) to the rig segment it
 *     belongs to. Visually identical to a deep Object3D hierarchy, but a whole
 *     robot draws in 5-7 calls instead of forty — which is the difference
 *     between 60fps and 40fps on an A14.
 *  2. Geometry is authored in MODEL space in the rest pose, so the layout code
 *     reads like a blueprint ("chest plate at y=1.14") instead of a stack of
 *     nested local frames. Skinning's bind-inverse does the rest.
 *  3. The rest pose is the combat-ready pose — gun barrel already along +Z at
 *     zero pitch — so aiming is a single delta rotation on the shoulder and the
 *     barrel genuinely points where the sim says it points.
 *
 * update() only writes bone transforms and uniform values. No allocation, ever.
 */

import * as THREE from 'three';
import { mergeGeometries } from './stage.js';
import { armorTexture } from './textures.js';
import { roboShell, additive, fresnelGlow, ensureAOChannel } from './materials.js';
import { clamp, clamp01, lerp, damp, angleDelta, smoothstep, TAU } from '../core/mathx.js';

// ---------------------------------------------------------------------------
// Scratch — hoisted so the frame loop never allocates.
// ---------------------------------------------------------------------------

const _col = new THREE.Color();
const _sphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 2.6);

/** Fake sim state the garage preview feeds to the shared animation code. */
const _previewState = {
  pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
  yaw: 0, pitch: 0, aimYaw: 0, aimPitch: 0,
  state: 0, grounded: true, moveAmt: 0, stepPhase: 0,
  hurtFlash: 0, charge: 0, chargeReady: 0, boostHeat: 0,
  hp: 1, maxHp: 1, invuln: 0,
};

const TEAM_TINT = [0x3f8fff, 0xff4a5c];

/** Frame/joint metal, picked by the body's trim so parts read as a family. */
const TRIM = {
  chrome:   { color: 0x9aa4b2, rough: 0.24, metal: 1.0 },
  gunmetal: { color: 0x3a4149, rough: 0.46, metal: 0.98 },
  brass:    { color: 0x8d7433, rough: 0.36, metal: 1.0 },
  obsidian: { color: 0x15171f, rough: 0.20, metal: 1.0 },
};

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/**
 * Rounded/chamfered box via clamp-to-inner-box + radius*normalize.
 *
 * A uniform BoxGeometry grid puts every vertex on a face plane or an edge line,
 * so the clamp alone would pillow the faces. Remapping the grid first — the two
 * outer rings land ON the corner arc, the inner ring sits exactly on the inner
 * box — keeps the flat faces genuinely flat and the bevels crisp.
 *
 * @param arc 1 = single 45-degree chamfer (the workhorse), 2 = smoother round.
 */
function roundedBox(w, h, d, r = 0.02, arc = 1) {
  const rad = Math.min(r, Math.min(w, h, d) * 0.48);
  const seg = 2 * arc + 1;
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);

  const table = (H) => {
    const t = new Float64Array(seg + 1);
    for (let i = 0; i <= seg; i++) {
      const j = i <= arc ? i : seg - i;
      const v = (H - rad) + rad * Math.cos((j * Math.PI) / (2 * arc));
      t[i] = i <= arc ? -v : v;
    }
    return t;
  };
  const tx = table(w * 0.5), ty = table(h * 0.5), tz = table(d * 0.5);
  const snap = (q, H, t) => t[Math.round(((q + H) / (2 * H)) * seg)];

  const ix = w * 0.5 - rad, iy = h * 0.5 - rad, iz = d * 0.5 - rad;
  const p = g.attributes.position, n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = snap(p.getX(i), w * 0.5, tx);
    const y = snap(p.getY(i), h * 0.5, ty);
    const z = snap(p.getZ(i), d * 0.5, tz);
    const cx = x < -ix ? -ix : x > ix ? ix : x;
    const cy = y < -iy ? -iy : y > iy ? iy : y;
    const cz = z < -iz ? -iz : z > iz ? iz : z;
    let dx = x - cx, dy = y - cy, dz = z - cz;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l; dy /= l; dz /= l;
    p.setXYZ(i, cx + dx * rad, cy + dy * rad, cz + dz * rad);
    n.setXYZ(i, dx, dy, dz);
  }
  p.needsUpdate = true;
  n.needsUpdate = true;
  return g;
}

const cyl = (rt, rb, h, rad = 10, open = false) =>
  new THREE.CylinderGeometry(rt, rb, h, rad, 1, open);

const ringGeo = (R, r, rad = 12, tub = 6) => new THREE.TorusGeometry(R, r, tub, rad);

const ball = (r, seg = 8) => new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1));

const disc = (r, rad = 14) => new THREE.CircleGeometry(r, rad);

/** Chamfered box spanning two points in the sagittal (YZ) plane at a fixed x. */
function segBox(x, y0, z0, y1, z1, w, d, r, arc) {
  const dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dy, dz) || 0.001;
  const g = roundedBox(w, len, d, r, arc);
  g.rotateX(Math.atan2(dz, dy));
  g.translate(x, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/** Trapezoidal plate — the fastest way to stop a greeble reading as a box. */
function taperBox(wTop, wBot, h, dTop, dBot, r, arc) {
  const g = roundedBox(Math.max(wTop, wBot), h, Math.max(dTop, dBot), r, arc);
  const p = g.attributes.position;
  const kw = wBot === 0 ? 0 : wTop / wBot;
  const kd = dBot === 0 ? 0 : dTop / dBot;
  for (let i = 0; i < p.count; i++) {
    const t = clamp01(p.getY(i) / h + 0.5);
    p.setX(i, p.getX(i) * lerp(1, kw, t));
    p.setZ(i, p.getZ(i) * lerp(1, kd, t));
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Rig — bones are declared by their REST WORLD transform, which keeps the
// layout table readable. Rest rotations are pure-X so the local conversion is
// exact and limb geometry can be built with segBox().
// ---------------------------------------------------------------------------

class Rig {
  constructor() {
    this.bones = [];
    this.index = Object.create(null);
    this.world = [];
  }

  add(name, parent, wx, wy, wz, wrx = 0) {
    const b = new THREE.Bone();
    b.name = name;
    const i = this.bones.length;
    this.index[name] = i;
    this.world[i] = { x: wx, y: wy, z: wz, rx: wrx };

    if (parent == null) {
      b.position.set(wx, wy, wz);
      b.rotation.x = wrx;
    } else {
      const p = this.world[this.index[parent]];
      const dx = wx - p.x, dy = wy - p.y, dz = wz - p.z;
      const c = Math.cos(-p.rx), s = Math.sin(-p.rx);
      b.position.set(dx, dy * c - dz * s, dy * s + dz * c);
      b.rotation.x = wrx - p.rx;
      this.bones[this.index[parent]].add(b);
    }

    // Animation targets are deltas on top of the rest pose.
    b.rx0 = b.rotation.x;
    b.px0 = b.position.x; b.py0 = b.position.y; b.pz0 = b.position.z;
    this.bones.push(b);
    return b;
  }

  id(name) { return this.index[name]; }
  get(name) { return this.bones[this.index[name]]; }
}

// ---------------------------------------------------------------------------
// Builder — collects geometry into per-material buckets and rigid-binds it.
// ---------------------------------------------------------------------------

const UV_SCALE = 0.78;

class Build {
  constructor(rig, opts) {
    this.rig = rig;
    this.arc = opts.arc;
    this.rad = opts.radial;
    this.low = opts.low;
    this.buckets = {
      torso: [], arms: [], legs: [], frame: [], emis: [], flare: [], halo: [],
    };
  }

  /**
   * Triplanar-ish planar UVs taken in model space, so panel layouts flow across
   * neighbouring pieces instead of restarting on every box.
   */
  _uv(g) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    let uv = g.attributes.uv;
    if (!uv) {
      uv = new THREE.BufferAttribute(new Float32Array(p.count * 2), 2);
      g.setAttribute('uv', uv);
    }
    for (let i = 0; i < p.count; i++) {
      const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
      let u, v;
      if (nx >= ny && nx >= nz) { u = p.getZ(i); v = p.getY(i); }
      else if (ny >= nz) { u = p.getX(i); v = p.getZ(i); }
      else { u = p.getX(i); v = p.getY(i); }
      uv.setXY(i, u * UV_SCALE, v * UV_SCALE);
    }
    uv.needsUpdate = true;
  }

  _skin(g, bone) {
    const c = g.attributes.position.count;
    const si = new Float32Array(c * 4);
    const sw = new Float32Array(c * 4);
    const b = this.rig.id(bone);
    for (let i = 0; i < c; i++) { si[i * 4] = b; sw[i * 4] = 1; }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  }

  _push(list, g, bone) {
    this._uv(g);
    this._skin(g, bone);
    list.push(g);
    return g;
  }

  shellT(g, bone) { return this._push(this.buckets.torso, g, bone); }
  shellA(g, bone) { return this._push(this.buckets.arms, g, bone); }
  shellL(g, bone) { return this._push(this.buckets.legs, g, bone); }
  frame(g, bone) { return this._push(this.buckets.frame, g, bone); }

  _tinted(list, g, bone, hex, intensity) {
    this._uv(g);
    this._skin(g, bone);
    const c = g.attributes.position.count;
    const arr = new Float32Array(c * 3);
    _col.setHex(hex);
    const r = _col.r * intensity, gr = _col.g * intensity, b = _col.b * intensity;
    for (let i = 0; i < c; i++) { arr[i * 3] = r; arr[i * 3 + 1] = gr; arr[i * 3 + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    list.push(g);
    return g;
  }

  /** Solid unlit emissive — lenses, seams, nozzle throats. Drives the bloom. */
  emis(g, bone, hex, intensity = 2.0) {
    return this._tinted(this.buckets.emis, g, bone, hex, intensity);
  }

  /** Additive, depth-tested — thruster plumes, muzzle flash, halo rings. */
  flare(g, bone, hex, intensity = 1.4) {
    return this._tinted(this.buckets.flare, g, bone, hex, intensity);
  }

  /** Fresnel shell — skipped entirely on the low tier. */
  halo(g, bone) {
    if (this.low) { g.dispose(); return null; }
    return this._push(this.buckets.halo, g, bone);
  }
}

// ---------------------------------------------------------------------------
// Layout tables
// ---------------------------------------------------------------------------

const SIL = {
  strider: {
    hipY: 0.84, waistY: 0.97, chestY: 1.15, headY: 1.45,
    chestW: 0.44, chestH: 0.42, chestD: 0.34,
    hipW: 0.34, hipD: 0.30, shX: 0.31, shY: 1.28,
    armW: 0.145, foreW: 0.16, headR: 0.115,
    elbowDrop: 0.20, elbowFwd: 0.20, wristRise: 0.18, wristFwd: 0.22,
    packD: 0.16, packH: 0.30, skirt: 0.9,
  },
  bulwark: {
    hipY: 0.73, waistY: 0.87, chestY: 1.11, headY: 1.41,
    chestW: 0.60, chestH: 0.48, chestD: 0.42,
    hipW: 0.46, hipD: 0.36, shX: 0.42, shY: 1.25,
    armW: 0.19, foreW: 0.215, headR: 0.13,
    elbowDrop: 0.19, elbowFwd: 0.19, wristRise: 0.16, wristFwd: 0.21,
    packD: 0.20, packH: 0.34, skirt: 1.35,
  },
  lance: {
    hipY: 0.93, waistY: 1.05, chestY: 1.21, headY: 1.48,
    chestW: 0.38, chestH: 0.38, chestD: 0.38,
    hipW: 0.28, hipD: 0.28, shX: 0.28, shY: 1.32,
    armW: 0.125, foreW: 0.14, headR: 0.10,
    elbowDrop: 0.22, elbowFwd: 0.22, wristRise: 0.20, wristFwd: 0.23,
    packD: 0.14, packH: 0.32, skirt: 0.62,
  },
  monk: {
    hipY: 0.82, waistY: 0.96, chestY: 1.16, headY: 1.46,
    chestW: 0.48, chestH: 0.45, chestD: 0.39,
    hipW: 0.37, hipD: 0.33, shX: 0.35, shY: 1.28,
    armW: 0.16, foreW: 0.175, headR: 0.125,
    elbowDrop: 0.20, elbowFwd: 0.19, wristRise: 0.17, wristFwd: 0.21,
    packD: 0.19, packH: 0.36, skirt: 1.15,
  },
};

/** Leg joint chain as fractions of hip height, plus per-style bulk. */
const LEGS = {
  sprinter: {
    kneeF: 0.50, kneeZ: 0.040, ankleF: 0.135, ankleZ: -0.015,
    toeY: 0.045, toeZ: 0.085, tipZ: 0.185,
    thighW: 0.155, shinW: 0.150, footW: 0.175, hipX: 0.155, walk: 1.0,
  },
  tank: {
    kneeF: 0.52, kneeZ: 0.030, ankleF: 0.185, ankleZ: -0.010,
    toeY: 0.060, toeZ: 0.100, tipZ: 0.200,
    thighW: 0.215, shinW: 0.225, footW: 0.265, hipX: 0.200, walk: 0.82,
  },
  hover: {
    kneeF: 0.62, kneeZ: 0.0, ankleF: 0.36, ankleZ: 0.0,
    toeY: 0.22, toeZ: 0.0, tipZ: 0.0,
    thighW: 0.150, shinW: 0.190, footW: 0.230, hipX: 0.165, walk: 0.0,
  },
  digitigrade: {
    kneeF: 0.58, kneeZ: 0.105, ankleF: 0.30, ankleZ: -0.125,
    toeY: 0.055, toeZ: 0.025, tipZ: 0.170,
    thighW: 0.165, shinW: 0.135, footW: 0.130, hipX: 0.150, walk: 1.15,
  },
};

// ---------------------------------------------------------------------------
// Skeleton layout
// ---------------------------------------------------------------------------

function buildRig(P, L) {
  const R = new Rig();
  const hip = P.hipY;
  const kneeY = hip * L.kneeF, ankleY = hip * L.ankleF;

  R.add('root', null, 0, 0, 0);
  R.add('pelvis', 'root', 0, hip, 0);
  R.add('spine', 'pelvis', 0, P.waistY, 0);
  R.add('chest', 'spine', 0, P.chestY - P.chestH * 0.28, 0);
  R.add('neck', 'chest', 0, P.headY - P.headR - 0.05, 0);
  R.add('head', 'neck', 0, P.headY, 0);
  R.add('pack', 'chest', 0, P.chestY + 0.02, -P.chestD * 0.42);
  R.add('core', 'chest', 0, P.chestY - 0.01, P.chestD * 0.5);
  R.add('pod', 'pelvis', 0, hip - 0.02, -P.hipD * 0.55);

  // --- arms. The rest pose already aims: barrel axis is model +Z at pitch 0.
  const shY = P.shY;
  const ang = (y0, z0, y1, z1) => Math.atan2(-(z1 - z0), -(y1 - y0));

  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const x = s * P.shX;
    const eY = shY - P.elbowDrop, eZ = s > 0 ? P.elbowFwd : 0.04;
    const wY = s > 0 ? eY + P.wristRise : eY - 0.26;
    const wZ = s > 0 ? eZ + P.wristFwd : eZ + 0.05;

    R.add(`clav${side}`, 'chest', x * 0.62, shY + 0.02, 0);
    R.add(`arm${side}`, `clav${side}`, x, shY, 0, ang(shY, 0, eY, eZ));
    R.add(`fore${side}`, `arm${side}`, x, eY, eZ, ang(eY, eZ, wY, wZ));
    R.add(`hand${side}`, `fore${side}`, x, wY, wZ, ang(eY, eZ, wY, wZ));
  }

  // Weapon chain lives in model-aligned space (rest rx 0) so recoil slides
  // along +Z and the rotary barrels spin about +Z, whatever the arm is doing.
  const gx = P.shX, gy = SIL_wristY(P), gz = SIL_wristZ(P);
  R.add('gun', 'handR', gx, gy, gz, 0);
  R.add('slide', 'gun', gx, gy, gz, 0);
  R.add('spin', 'slide', gx, gy, gz + 0.16, 0);
  R.add('muzzle', 'slide', gx, gy, gz + 0.46, 0);
  R.add('flash', 'muzzle', gx, gy, gz + 0.50, 0);

  const bwY = shY - P.elbowDrop - 0.26, bwZ = 0.04 + 0.05;
  R.add('bomb', 'handL', -P.shX, bwY, bwZ, 0);

  // --- legs
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const x = s * L.hipX;
    R.add(`hip${side}`, 'pelvis', x, hip, 0);
    R.add(`thigh${side}`, `hip${side}`, x, hip, 0, ang(hip, 0, kneeY, L.kneeZ));
    R.add(`shin${side}`, `thigh${side}`, x, kneeY, L.kneeZ, ang(kneeY, L.kneeZ, ankleY, L.ankleZ));
    R.add(`foot${side}`, `shin${side}`, x, ankleY, L.ankleZ, 0);
    R.add(`toe${side}`, `foot${side}`, x, L.toeY, L.toeZ, 0);
    R.add(`boot${side}`, `shin${side}`, x, ankleY + 0.10, L.ankleZ - 0.11, 0);
  }

  R.add('thrL', 'pack', -0.14, P.chestY - 0.06, -P.chestD * 0.5 - P.packD, 0);
  R.add('thrR', 'pack', 0.14, P.chestY - 0.06, -P.chestD * 0.5 - P.packD, 0);

  return R;
}

const SIL_wristY = (P) => P.shY - P.elbowDrop + P.wristRise;
const SIL_wristZ = (P) => P.elbowFwd + P.wristFwd;

// ---------------------------------------------------------------------------
// Torso
// ---------------------------------------------------------------------------

function buildPelvis(B, P, C) {
  const a = B.arc, hip = P.hipY;
  const { look, em, ac, team } = C;

  // Pelvic block plus a floating belt ring — the waist is where a mecha reads
  // as "assembled from parts", so it gets the most layering per square metre.
  B.shellT(at(roundedBox(P.hipW, 0.20, P.hipD, 0.035, a), 0, hip - 0.03, 0), 'pelvis');
  B.frame(at(cyl(0.105, 0.115, 0.16, B.rad), 0, hip + 0.09, 0), 'pelvis');
  B.frame(at(roundedBox(P.hipW * 0.72, 0.06, P.hipD * 0.9, 0.02, a), 0, hip + 0.03, 0), 'pelvis');

  // Skirt armour: front, rear and two side plates, each floated off the block.
  const sk = P.skirt;
  B.shellT(at(taperBox(P.hipW * 0.50, P.hipW * 0.62, 0.20 * sk, 0.06, 0.09, 0.022, a),
    0, hip - 0.13, P.hipD * 0.46), 'pelvis');
  B.shellT(at(taperBox(P.hipW * 0.58, P.hipW * 0.70, 0.18 * sk, 0.06, 0.09, 0.022, a),
    0, hip - 0.12, -P.hipD * 0.46), 'pelvis');
  for (const s of [-1, 1]) {
    const g = taperBox(0.13, 0.17, 0.22 * sk, 0.13, 0.17, 0.024, a);
    g.rotateZ(s * 0.16);
    g.translate(s * (P.hipW * 0.55 + 0.02), hip - 0.12, 0);
    B.shellT(g, 'pelvis');
  }

  B.emis(at(roundedBox(P.hipW * 0.30, 0.018, 0.02, 0.006, 1), 0, hip + 0.02, P.hipD * 0.52),
    'pelvis', team, 1.5);
  if (!B.low) {
    for (const s of [-1, 1]) {
      B.emis(at(roundedBox(0.012, 0.11, 0.012, 0.004, 1), s * P.hipW * 0.40, hip - 0.04, P.hipD * 0.5),
        'pelvis', em, 1.2);
    }
  }

  // Spine column: exposed frame + twin actuator pistons.
  B.frame(at(cyl(0.075, 0.085, P.waistY - hip + 0.10, B.rad), 0, (hip + P.waistY) * 0.5, 0), 'spine');
  for (const s of [-1, 1]) {
    B.frame(at(cyl(0.024, 0.024, 0.17, 6), s * 0.075, P.waistY - 0.02, -0.055), 'spine');
  }
  B.shellT(at(roundedBox(P.chestW * 0.52, 0.13, P.chestD * 0.62, 0.03, a), 0, P.waistY + 0.02, 0), 'spine');
  B.emis(at(ringGeo(0.088, 0.008, B.low ? 8 : 14, 4).rotateX(Math.PI / 2),
    0, P.waistY - 0.05, 0), 'spine', ac, 1.1);
}

function buildChest(B, P, C) {
  const a = B.arc;
  const { look, em, ac, team } = C;
  const cy = P.chestY, cw = P.chestW, ch = P.chestH, cd = P.chestD;

  // Core torso volume: a tapered barrel, never a plain box.
  B.shellT(at(taperBox(cw * 0.96, cw * 0.80, ch, cd * 0.94, cd * 0.82, 0.045, a), 0, cy, 0), 'chest');
  // Upper back plate, floated so the shoulder yoke reads as a separate piece.
  B.shellT(at(roundedBox(cw * 0.84, ch * 0.52, cd * 0.30, 0.03, a), 0, cy + ch * 0.20, -cd * 0.46), 'chest');
  // Collar / shoulder yoke.
  B.frame(at(taperBox(cw * 0.98, cw * 0.72, 0.09, cd * 0.7, cd * 0.8, 0.025, a), 0, cy + ch * 0.50, -0.01), 'chest');

  // Side intake scoops.
  for (const s of [-1, 1]) {
    const g = taperBox(0.055, 0.10, 0.19, 0.16, 0.20, 0.02, a);
    g.rotateZ(-s * 0.22);
    g.translate(s * (cw * 0.50), cy + ch * 0.10, 0.01);
    B.shellT(g, 'chest');
    if (!B.low) {
      for (let i = 0; i < 3; i++) {
        B.frame(at(roundedBox(0.03, 0.012, 0.15, 0.004, 1),
          s * (cw * 0.53), cy + ch * 0.16 - i * 0.045, 0.01), 'chest');
      }
    }
  }

  // Abdomen: exposed frame ribs under the chest plate.
  B.frame(at(taperBox(cw * 0.60, cw * 0.52, 0.14, cd * 0.62, cd * 0.56, 0.02, a),
    0, cy - ch * 0.56, 0), 'chest');
  if (!B.low) {
    for (let i = 0; i < 2; i++) {
      B.frame(at(roundedBox(cw * 0.50, 0.022, cd * 0.66, 0.006, 1),
        0, cy - ch * 0.50 - i * 0.045, 0), 'chest');
    }
  }

  switch (look.chest) {
    case 'slab': {
      // SHELLBIT: one enormous front plate, split by a horizontal weld line,
      // with bolt columns. Reads as "armour first" from any distance.
      B.shellT(at(roundedBox(cw * 0.88, ch * 0.86, 0.09, 0.03, a), 0, cy + 0.01, cd * 0.50), 'chest');
      B.shellT(at(roundedBox(cw * 0.70, ch * 0.30, 0.06, 0.022, a), 0, cy + ch * 0.24, cd * 0.56), 'chest');
      B.frame(at(roundedBox(cw * 0.90, 0.028, 0.03, 0.008, 1), 0, cy - ch * 0.02, cd * 0.56), 'chest');
      for (const s of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          B.frame(at(cyl(0.017, 0.017, 0.035, 6).rotateX(Math.PI / 2),
            s * cw * 0.36, cy + ch * 0.30 - i * 0.10, cd * 0.55), 'chest');
        }
      }
      B.emis(at(roundedBox(cw * 0.44, 0.028, 0.02, 0.008, 1), 0, cy - ch * 0.14, cd * 0.57), 'chest', em, 2.2);
      B.emis(at(roundedBox(0.10, 0.10, 0.018, 0.006, 1), 0, cy + ch * 0.24, cd * 0.60), 'core', em, 2.6);
      break;
    }
    case 'keel': {
      // AERIAL-Z / NOCTURNE: a forward-raked prow with keel fins. Everything
      // points forward; the silhouette should look like it is already moving.
      const prow = taperBox(0.10, cw * 0.70, 0.30, 0.20, 0.10, 0.02, a);
      prow.rotateX(-0.30);
      prow.translate(0, cy + 0.01, cd * 0.52);
      B.shellT(prow, 'chest');
      for (const s of [-1, 1]) {
        const fin = taperBox(0.03, 0.055, 0.30, 0.06, 0.22, 0.014, a);
        fin.rotateZ(-s * 0.30);
        fin.rotateX(-0.16);
        fin.translate(s * cw * 0.44, cy + 0.03, cd * 0.36);
        B.shellT(fin, 'chest');
      }
      B.emis(at(roundedBox(0.028, 0.30, 0.014, 0.006, 1).rotateX(-0.30), 0, cy + 0.02, cd * 0.63), 'chest', em, 2.6);
      B.emis(at(ball(0.045, B.low ? 6 : 10), 0, cy + 0.15, cd * 0.55), 'core', em, 2.8);
      break;
    }
    case 'reactor': {
      // GRAND ISO: the power plant is the design. Housing, iris, radial vents.
      B.frame(at(cyl(0.135, 0.145, 0.10, B.low ? 10 : 16).rotateX(Math.PI / 2), 0, cy + 0.02, cd * 0.48), 'chest');
      B.shellT(at(ringGeo(0.155, 0.030, B.low ? 10 : 18, 5).rotateX(0), 0, cy + 0.02, cd * 0.50), 'chest');
      B.emis(at(disc(0.115, B.low ? 10 : 18), 0, cy + 0.02, cd * 0.545), 'core', em, 3.0);
      B.emis(at(ringGeo(0.135, 0.010, B.low ? 10 : 18, 4), 0, cy + 0.02, cd * 0.53), 'core', ac, 1.8);
      B.halo(at(ball(0.20, B.low ? 8 : 12), 0, cy + 0.02, cd * 0.44), 'core');
      if (!B.low) {
        for (let i = 0; i < 6; i++) {
          const t = (i / 6) * TAU;
          const g = roundedBox(0.035, 0.13, 0.05, 0.01, 1);
          g.rotateZ(t);
          g.translate(Math.sin(t) * 0.20, cy + 0.02 + Math.cos(t) * 0.20, cd * 0.44);
          B.frame(g, 'chest');
        }
      }
      break;
    }
    default: {
      // RAY-01: the tournament V-crest. Two angled slabs and a lit sternum.
      for (const s of [-1, 1]) {
        const g = taperBox(0.07, 0.13, 0.28, 0.05, 0.09, 0.018, a);
        g.rotateZ(s * 0.42);
        g.rotateX(-0.10);
        g.translate(s * cw * 0.20, cy + ch * 0.12, cd * 0.52);
        B.shellT(g, 'chest');
      }
      B.shellT(at(roundedBox(cw * 0.34, ch * 0.52, 0.07, 0.022, a), 0, cy - ch * 0.10, cd * 0.52), 'chest');
      B.frame(at(roundedBox(cw * 0.52, 0.03, 0.04, 0.008, 1), 0, cy + ch * 0.34, cd * 0.50), 'chest');
      B.emis(at(roundedBox(0.024, ch * 0.42, 0.016, 0.006, 1), 0, cy - ch * 0.10, cd * 0.57), 'chest', em, 2.3);
      B.emis(at(ball(0.05, B.low ? 6 : 10), 0, cy + ch * 0.30, cd * 0.50), 'core', em, 2.8);
      B.halo(at(ball(0.13, B.low ? 8 : 12), 0, cy + ch * 0.30, cd * 0.46), 'core');
      break;
    }
  }

  // Team chevron — the one piece of colour that is not part-driven, so the two
  // sides stay legible even with identical loadouts.
  B.emis(at(roundedBox(cw * 0.20, 0.02, 0.014, 0.005, 1), 0, cy + ch * 0.44, cd * 0.46), 'chest', team, 1.7);
}

function buildBackpack(B, P, C) {
  const a = B.arc;
  const { look, em, ac } = C;
  const cy = P.chestY, cd = P.chestD, pd = P.packD, phh = P.packH;

  B.shellT(at(taperBox(P.chestW * 0.62, P.chestW * 0.74, phh, pd * 0.7, pd, 0.03, a),
    0, cy + 0.02, -cd * 0.5 - pd * 0.5), 'pack');
  B.frame(at(roundedBox(P.chestW * 0.50, 0.05, pd * 0.5, 0.014, 1),
    0, cy + phh * 0.42, -cd * 0.5 - pd * 0.5), 'pack');

  // Twin main thrusters: bell, throat, plume.
  for (const s of [-1, 1]) {
    const x = s * 0.14, z = -cd * 0.5 - pd;
    B.frame(at(cyl(0.075, 0.052, 0.13, B.rad).rotateX(Math.PI / 2), x, cy - 0.06, z + 0.02), 'pack');
    B.shellT(at(cyl(0.088, 0.070, 0.06, B.rad).rotateX(Math.PI / 2), x, cy - 0.06, z + 0.08), 'pack');
    B.emis(at(disc(0.055, B.low ? 8 : 14).rotateY(Math.PI), x, cy - 0.06, z - 0.045), 'pack', em, 2.4);

    const plume = cyl(0.05, 0.012, 0.42, B.low ? 6 : 10, true);
    plume.rotateX(Math.PI / 2);
    plume.translate(x, cy - 0.06, z - 0.26);
    B.flare(plume, s < 0 ? 'thrL' : 'thrR', em, 1.5);
  }

  // Heat fins — angled so they catch the key light across the back.
  if (!B.low) {
    for (let i = 0; i < 3; i++) {
      for (const s of [-1, 1]) {
        const g = roundedBox(0.045, 0.11, 0.015, 0.005, 1);
        g.rotateY(s * 0.35);
        g.translate(s * (0.055 + i * 0.055), cy + phh * 0.30, -cd * 0.5 - pd * 0.95);
        B.shellT(g, 'pack');
      }
    }
  }
  B.emis(at(roundedBox(0.16, 0.014, 0.012, 0.004, 1), 0, cy + phh * 0.16, -cd * 0.5 - pd * 1.02), 'pack', ac, 1.4);
}

function buildHead(B, P, C) {
  const a = B.arc;
  const { look, em, ac } = C;
  const hy = P.headY, r = P.headR;

  B.frame(at(cyl(0.055, 0.065, 0.09, B.rad), 0, hy - r - 0.03, 0), 'neck');

  switch (look.head) {
    case 'dome': {
      // SHELLBIT: an armoured dome sunk into the shoulders. Barely a head.
      B.shellT(at(ball(r * 1.05, B.low ? 8 : 12).scale(1.15, 0.9, 1.0), 0, hy, 0), 'head');
      B.shellT(at(taperBox(r * 2.0, r * 2.3, r * 0.55, r * 0.9, r * 1.5, 0.02, a), 0, hy - r * 0.55, r * 0.15), 'head');
      B.frame(at(roundedBox(r * 1.9, 0.035, 0.06, 0.01, 1), 0, hy + r * 0.10, r * 0.85), 'head');
      B.emis(at(roundedBox(r * 1.30, 0.030, 0.02, 0.008, 1), 0, hy - r * 0.10, r * 0.92), 'head', em, 2.6);
      for (const s of [-1, 1]) {
        B.frame(at(cyl(0.028, 0.034, 0.05, 8).rotateZ(Math.PI / 2), s * r * 1.15, hy, 0), 'head');
      }
      break;
    }
    case 'crest': {
      // AERIAL-Z: narrow face, tall swept blade. All vertical energy.
      B.shellT(at(taperBox(r * 1.0, r * 1.5, r * 1.7, r * 1.3, r * 1.7, 0.02, a), 0, hy, 0), 'head');
      const crest = taperBox(0.012, 0.05, 0.24, 0.03, 0.16, 0.008, a);
      crest.rotateX(0.42);
      crest.translate(0, hy + r * 1.15, -0.03);
      B.shellT(crest, 'head');
      for (const s of [-1, 1]) {
        const fin = taperBox(0.010, 0.028, 0.15, 0.02, 0.10, 0.006, a);
        fin.rotateZ(-s * 0.55);
        fin.rotateX(0.30);
        fin.translate(s * r * 0.75, hy + r * 0.85, -0.02);
        B.shellT(fin, 'head');
        B.emis(at(roundedBox(0.035, 0.016, 0.014, 0.004, 1), s * r * 0.42, hy + r * 0.05, r * 0.95), 'head', em, 3.0);
      }
      B.frame(at(roundedBox(r * 0.9, 0.05, 0.05, 0.012, 1), 0, hy - r * 0.55, r * 0.7), 'head');
      break;
    }
    case 'mono': {
      // GRAND ISO: one big sensor eye, rear heat fins. Deliberately inhuman.
      B.shellT(at(ball(r * 1.1, B.low ? 8 : 12).scale(1.0, 1.05, 1.05), 0, hy, 0), 'head');
      B.frame(at(cyl(0.062, 0.070, 0.05, B.low ? 10 : 14).rotateX(Math.PI / 2), 0, hy + r * 0.05, r * 0.95), 'head');
      B.emis(at(disc(0.052, B.low ? 10 : 16), 0, hy + r * 0.05, r * 1.16), 'head', em, 3.2);
      B.emis(at(ringGeo(0.068, 0.008, B.low ? 10 : 16, 4), 0, hy + r * 0.05, r * 1.10), 'head', ac, 1.6);
      if (!B.low) {
        for (let i = 0; i < 3; i++) {
          B.shellT(at(roundedBox(r * 1.5 - i * 0.02, 0.018, 0.05, 0.005, 1),
            0, hy + r * 0.55 - i * 0.045, -r * 0.95), 'head');
        }
      }
      break;
    }
    default: {
      // RAY-01 / NOCTURNE: classic wedge helmet with a wraparound visor band.
      B.shellT(at(taperBox(r * 1.5, r * 1.85, r * 1.8, r * 1.5, r * 1.9, 0.025, a), 0, hy, 0), 'head');
      B.frame(at(taperBox(r * 1.3, r * 1.6, r * 0.7, r * 1.2, r * 1.5, 0.015, a), 0, hy - r * 0.75, r * 0.10), 'head');
      const brow = roundedBox(r * 1.9, 0.045, 0.09, 0.012, a);
      brow.rotateX(-0.18);
      brow.translate(0, hy + r * 0.52, r * 0.80);
      B.shellT(brow, 'head');
      B.emis(at(roundedBox(r * 1.55, 0.045, 0.024, 0.010, 1), 0, hy + r * 0.05, r * 0.95), 'head', em, 3.0);
      for (const s of [-1, 1]) {
        B.frame(at(cyl(0.024, 0.030, 0.055, 8).rotateZ(Math.PI / 2), s * r * 1.25, hy - r * 0.05, 0), 'head');
        B.emis(at(roundedBox(0.010, 0.045, 0.010, 0.003, 1), s * r * 1.30, hy - r * 0.05, 0), 'head', ac, 1.3);
      }
      // Antenna — cheap, but it is the thing that makes a head look like a mech.
      const ant = cyl(0.006, 0.010, 0.16, 6);
      ant.rotateX(0.30);
      ant.translate(-r * 0.55, hy + r * 1.35, -0.03);
      B.frame(ant, 'head');
      break;
    }
  }
}

function buildShoulder(B, P, C, s) {
  const a = B.arc;
  const { look, em, ac, team } = C;
  const side = s < 0 ? 'L' : 'R';
  const clav = `clav${side}`;
  const x = s * P.shX, y = P.shY;
  const sc = P.chestW / 0.44;

  // Deltoid frame under the pauldron so the gap has something inside it.
  B.frame(at(ball(P.armW * 0.72, B.low ? 6 : 10), x, y, 0), clav);

  switch (look.shoulder) {
    case 'block': {
      // SHELLBIT: rectangular blocks with vertical slats.
      B.shellT(at(roundedBox(0.20 * sc, 0.24, 0.26, 0.035, a), x + s * 0.08, y + 0.05, 0), clav);
      B.shellT(at(roundedBox(0.16 * sc, 0.07, 0.22, 0.02, a), x + s * 0.08, y + 0.20, 0), clav);
      if (!B.low) {
        for (let i = 0; i < 3; i++) {
          B.frame(at(roundedBox(0.022, 0.16, 0.03, 0.006, 1),
            x + s * (0.08 + 0.10 * sc), y + 0.04, -0.07 + i * 0.07), clav);
        }
      }
      B.emis(at(roundedBox(0.10, 0.016, 0.014, 0.004, 1), x + s * 0.08, y + 0.15, 0.13), clav, team, 1.6);
      break;
    }
    case 'fin': {
      // AERIAL-Z / NOCTURNE: swept-back blades. Nothing bulky above the arm.
      const fin = taperBox(0.035, 0.11, 0.30, 0.05, 0.20, 0.016, a);
      fin.rotateZ(-s * 0.30);
      fin.rotateX(0.36);
      fin.translate(x + s * 0.075, y + 0.06, -0.06);
      B.shellT(fin, clav);
      const cap = taperBox(0.09, 0.13, 0.13, 0.14, 0.19, 0.022, a);
      cap.rotateZ(-s * 0.18);
      cap.translate(x + s * 0.055, y + 0.03, 0.01);
      B.shellT(cap, clav);
      B.emis(at(roundedBox(0.012, 0.20, 0.012, 0.004, 1).rotateX(0.36).rotateZ(-s * 0.30),
        x + s * 0.115, y + 0.07, -0.05), clav, em, 1.9);
      break;
    }
    case 'vent': {
      // GRAND ISO: radiator drums. Every panel is a heatsink, so make it one.
      B.shellT(at(cyl(0.115, 0.125, 0.19, B.low ? 10 : 14).rotateZ(Math.PI / 2),
        x + s * 0.085, y + 0.03, 0), clav);
      B.frame(at(cyl(0.075, 0.075, 0.21, B.low ? 8 : 12).rotateZ(Math.PI / 2),
        x + s * 0.085, y + 0.03, 0), clav);
      if (!B.low) {
        for (let i = 0; i < 4; i++) {
          const t = (i / 4) * Math.PI * 2 + 0.4;
          B.shellT(at(roundedBox(0.19, 0.035, 0.05, 0.008, 1)
            .rotateX(t), x + s * 0.085, y + 0.03 + Math.cos(t) * 0.115, Math.sin(t) * 0.115), clav);
        }
      }
      B.emis(at(ringGeo(0.09, 0.010, B.low ? 10 : 16, 4).rotateY(Math.PI / 2),
        x + s * 0.185, y + 0.03, 0), clav, em, 2.0);
      break;
    }
    default: {
      // RAY-01: layered pauldron floating clear of the torso.
      const pau = taperBox(0.15 * sc, 0.20 * sc, 0.22, 0.17, 0.24, 0.032, a);
      pau.rotateZ(-s * 0.14);
      pau.translate(x + s * 0.075, y + 0.055, 0);
      B.shellT(pau, clav);
      const cap = taperBox(0.10 * sc, 0.16 * sc, 0.06, 0.12, 0.20, 0.018, a);
      cap.rotateZ(-s * 0.14);
      cap.translate(x + s * 0.085, y + 0.185, 0);
      B.shellT(cap, clav);
      B.frame(at(roundedBox(0.05, 0.14, 0.20, 0.014, 1), x + s * 0.01, y + 0.05, 0), clav);
      B.emis(at(roundedBox(0.10, 0.018, 0.016, 0.005, 1), x + s * 0.10, y + 0.13, 0.10), clav, team, 1.7);
      if (!B.low) {
        B.frame(at(cyl(0.016, 0.016, 0.05, 6).rotateZ(Math.PI / 2), x + s * 0.16, y + 0.02, -0.06), clav);
      }
      break;
    }
  }
}

function buildArm(B, P, C, s) {
  const a = B.arc;
  const { em, ac } = C;
  const side = s < 0 ? 'L' : 'R';
  const x = s * P.shX;
  const eY = P.shY - P.elbowDrop, eZ = s > 0 ? P.elbowFwd : 0.04;
  const wY = s > 0 ? eY + P.wristRise : eY - 0.26;
  const wZ = s > 0 ? eZ + P.wristFwd : eZ + 0.05;
  const aw = P.armW, fw = P.foreW;

  // Upper arm: inner frame sleeve + outer armour shell, so the joint gap has
  // depth instead of showing a hole.
  B.frame(segBox(x, P.shY, 0, eY, eZ, aw * 0.62, aw * 0.62, aw * 0.3, 1), `arm${side}`);
  B.shellA(segBox(x, P.shY - 0.02, 0.0, eY + 0.02, eZ * 0.9, aw, aw * 1.05, 0.028, a), `arm${side}`);
  B.shellA(segBox(x + s * aw * 0.42, P.shY - 0.04, 0.0, eY + 0.05, eZ * 0.8, aw * 0.30, aw * 0.7, 0.012, a), `arm${side}`);

  // Elbow: ball joint, guard plate, and a piston that visibly spans the joint.
  B.frame(at(ball(aw * 0.60, B.low ? 6 : 10), x, eY, eZ), `arm${side}`);
  B.shellA(at(taperBox(aw * 0.75, aw * 1.05, aw * 0.9, aw * 0.8, aw * 1.1, 0.018, a), x, eY + 0.02, eZ), `fore${side}`);
  if (!B.low) {
    B.frame(segBox(x - s * aw * 0.42, P.shY - 0.10, 0, eY + 0.02, eZ, 0.022, 0.022, 0.01, 1), `arm${side}`);
  }
  B.emis(at(ringGeo(aw * 0.62, 0.008, B.low ? 8 : 12, 4).rotateY(Math.PI / 2), x + s * aw * 0.1, eY, eZ),
    `fore${side}`, ac, 1.3);

  // Forearm: heavier cuff than the upper arm — top-light limbs look like sticks.
  B.shellA(segBox(x, eY, eZ, wY, wZ, fw, fw * 1.08, 0.03, a), `fore${side}`);
  B.shellA(segBox(x + s * fw * 0.44, eY - 0.02, eZ, wY, wZ, fw * 0.28, fw * 0.75, 0.012, a), `fore${side}`);
  B.frame(at(cyl(fw * 0.46, fw * 0.46, 0.05, B.rad).rotateX(Math.atan2(wZ - eZ, wY - eY) + Math.PI / 2),
    x, wY, wZ), `hand${side}`);
  B.emis(at(roundedBox(0.014, 0.09, 0.014, 0.004, 1)
    .rotateX(Math.atan2(wZ - eZ, wY - eY)), x + s * fw * 0.52, (eY + wY) * 0.5, (eZ + wZ) * 0.5),
    `fore${side}`, em, 1.4);
}

// ---------------------------------------------------------------------------
// Legs — the four styles differ in joint chain, bulk and part count, not paint.
// ---------------------------------------------------------------------------

function buildLeg(B, P, L, C, s) {
  const a = B.arc;
  const { legs, em, ac, team } = C;
  const side = s < 0 ? 'L' : 'R';
  const x = s * L.hipX;
  const hip = P.hipY;
  const kY = hip * L.kneeF, kZ = L.kneeZ;
  const aY = hip * L.ankleF, aZ = L.ankleZ;
  const tw = L.thighW, sw = L.shinW, fw = L.footW;
  const style = legs.look.style;

  // Hip ball + housing.
  B.frame(at(ball(tw * 0.60, B.low ? 6 : 10), x, hip - 0.02, 0), `hip${side}`);
  B.shellL(at(taperBox(tw * 0.9, tw * 1.15, 0.13, tw * 0.9, tw * 1.1, 0.022, a), x + s * 0.015, hip - 0.05, 0), `thigh${side}`);

  // Thigh.
  B.frame(segBox(x, hip - 0.02, 0, kY + 0.02, kZ, tw * 0.60, tw * 0.60, tw * 0.28, 1), `thigh${side}`);
  B.shellL(segBox(x, hip - 0.06, 0, kY + 0.04, kZ * 0.9, tw, tw * 1.05, 0.03, a), `thigh${side}`);
  if (style === 'tank') {
    // Bolted-on outer thigh armour with a lip — pure mass reading.
    B.shellL(segBox(x + s * tw * 0.52, hip - 0.10, 0, kY + 0.02, kZ, tw * 0.34, tw * 1.15, 0.016, a), `thigh${side}`);
    B.shellL(segBox(x, hip - 0.08, -tw * 0.55, kY, kZ - tw * 0.5, tw * 0.85, tw * 0.28, 0.014, a), `thigh${side}`);
  } else if (style === 'digitigrade') {
    B.shellL(segBox(x, hip - 0.04, -tw * 0.42, kY + 0.06, kZ - tw * 0.30, tw * 0.66, tw * 0.42, 0.016, a), `thigh${side}`);
  }

  // Knee: joint sphere, guard, and a piston bridging thigh to shin.
  B.frame(at(ball(tw * 0.52, B.low ? 6 : 10), x, kY, kZ), `thigh${side}`);
  B.shellL(at(taperBox(sw * 0.85, sw * 1.12, 0.13, sw * 0.9, sw * 1.15, 0.02, a), x, kY + 0.01, kZ + 0.02), `shin${side}`);
  B.emis(at(ringGeo(tw * 0.56, 0.008, B.low ? 8 : 12, 4).rotateY(Math.PI / 2), x + s * tw * 0.1, kY, kZ),
    `shin${side}`, ac, 1.3);
  if (!B.low) {
    B.frame(segBox(x - s * tw * 0.40, hip - 0.14, kZ * 0.3, kY + 0.03, kZ - 0.03, 0.024, 0.024, 0.01, 1), `thigh${side}`);
  }

  // Shin / lower leg — the biggest style tell.
  if (style === 'hover') {
    // HOVER-V: no shin at all. A skirted housing over a turbine ring.
    B.shellL(segBox(x, kY, kZ, aY + 0.04, aZ, sw * 1.05, sw * 1.15, 0.03, a), `shin${side}`);
    B.shellL(at(taperBox(fw * 1.5, fw * 1.05, 0.16, fw * 1.5, fw * 1.05, 0.03, a), x, aY - 0.03, 0), `foot${side}`);
    B.frame(at(cyl(fw * 0.78, fw * 0.72, 0.09, B.low ? 10 : 16), x, L.toeY + 0.05, 0), `toe${side}`);
    B.shellL(at(ringGeo(fw * 0.80, 0.036, B.low ? 12 : 20, 5).rotateX(Math.PI / 2), x, L.toeY + 0.04, 0), `toe${side}`);
    B.emis(at(ringGeo(fw * 0.60, 0.014, B.low ? 12 : 20, 4).rotateX(Math.PI / 2), x, L.toeY + 0.02, 0), `toe${side}`, em, 2.4);
    B.emis(at(disc(fw * 0.46, B.low ? 10 : 16).rotateX(Math.PI / 2), x, L.toeY - 0.005, 0), `toe${side}`, em, 1.6);
    const wash = cyl(fw * 0.5, fw * 0.16, 0.30, B.low ? 8 : 12, true);
    wash.rotateX(Math.PI);
    wash.translate(x, L.toeY - 0.17, 0);
    B.flare(wash, `boot${side}`, em, 1.1);
    if (!B.low) {
      for (const q of [-1, 1]) {
        const fin = taperBox(0.02, 0.05, 0.12, 0.05, 0.14, 0.008, a);
        fin.rotateZ(q * 0.5);
        fin.translate(x + q * fw * 0.9, aY - 0.04, 0);
        B.shellL(fin, `foot${side}`);
      }
    }
  } else {
    B.frame(segBox(x, kY, kZ, aY, aZ, sw * 0.58, sw * 0.58, sw * 0.26, 1), `shin${side}`);
    B.shellL(segBox(x, kY - 0.02, kZ, aY + 0.02, aZ, sw, sw * 1.08, 0.028, a), `shin${side}`);
    // Front greave, floated proud of the shin.
    B.shellL(segBox(x, kY - 0.04, kZ + sw * 0.55, aY + 0.04, aZ + sw * 0.5, sw * 0.68, sw * 0.30, 0.014, a), `shin${side}`);

    if (style === 'tank') {
      for (const q of [-1, 1]) {
        B.shellL(segBox(x + q * sw * 0.56, kY - 0.06, kZ, aY + 0.03, aZ, sw * 0.26, sw * 1.1, 0.014, a), `shin${side}`);
      }
      // Quad thruster block on the calf.
      B.frame(at(roundedBox(sw * 0.95, 0.13, 0.09, 0.02, a), x, aY + 0.13, aZ - sw * 0.62), `shin${side}`);
      for (let i = 0; i < 4; i++) {
        const ox = ((i & 1) ? 1 : -1) * sw * 0.26;
        const oy = (i < 2 ? 0.03 : -0.03);
        B.emis(at(disc(0.026, 8).rotateY(Math.PI), x + ox, aY + 0.13 + oy, aZ - sw * 0.68), `shin${side}`, em, 2.0);
      }
    } else if (style === 'digitigrade') {
      // The spring: a coil piston along the back of a reverse-jointed leg.
      B.frame(segBox(x, kY - 0.02, kZ - sw * 0.5, aY + 0.06, aZ - sw * 0.2, 0.034, 0.034, 0.016, 1), `shin${side}`);
      if (!B.low) {
        for (let i = 0; i < 4; i++) {
          const t = i / 3;
          B.frame(at(ringGeo(0.030, 0.010, 8, 4).rotateX(Math.atan2(aZ - kZ, aY - kY) + Math.PI / 2),
            x, lerp(kY - 0.02, aY + 0.06, t), lerp(kZ - sw * 0.5, aZ - sw * 0.2, t)), `shin${side}`);
        }
      }
    }

    // Calf thruster.
    B.frame(at(cyl(0.042, 0.032, 0.07, B.rad).rotateX(Math.PI / 2 + 0.5), x, aY + 0.10, aZ - sw * 0.55), `shin${side}`);
    B.emis(at(disc(0.030, B.low ? 8 : 12).rotateY(Math.PI).rotateX(-0.5), x, aY + 0.085, aZ - sw * 0.62), `shin${side}`, em, 2.0);
    const jet = cyl(0.032, 0.008, 0.24, B.low ? 6 : 10, true);
    jet.rotateX(Math.PI / 2 - 0.5);
    jet.translate(x, aY + 0.04, aZ - sw * 0.74);
    B.flare(jet, `boot${side}`, em, 1.3);

    // Ankle + foot.
    B.frame(at(ball(sw * 0.44, B.low ? 6 : 10), x, aY, aZ), `foot${side}`);
    if (style === 'digitigrade') {
      // Long metatarsal running forward to a single hoof-like toe.
      B.shellL(segBox(x, aY, aZ, L.toeY + 0.03, L.toeZ, fw * 0.95, fw * 0.8, 0.018, a), `foot${side}`);
      B.shellL(segBox(x, L.toeY + 0.02, L.toeZ, L.toeY - 0.02, L.tipZ, fw * 1.05, fw * 0.55, 0.016, a), `toe${side}`);
      B.shellL(segBox(x, aY - 0.02, aZ - 0.02, L.toeY + 0.02, aZ - 0.09, fw * 0.7, fw * 0.5, 0.014, a), `foot${side}`);
    } else {
      const spread = style === 'tank' ? 1.0 : 0.85;
      B.shellL(at(taperBox(fw * 0.9, fw * 1.15, 0.10, fw * 1.5, fw * 1.9, 0.02, a), x, L.toeY + 0.02, L.toeZ * 0.35), `foot${side}`);
      B.shellL(at(taperBox(fw * 1.05, fw * 0.85, 0.075, fw * 0.9, fw * 0.7, 0.016, a).rotateX(0.12),
        x, L.toeY - 0.005, L.toeZ + 0.03), `toe${side}`);
      if (!B.low) {
        for (let i = -1; i <= 1; i++) {
          if (style !== 'tank' && i === 0) continue;
          B.shellL(at(taperBox(fw * 0.22, fw * 0.30, 0.05, 0.05, 0.09, 0.008, a).rotateX(0.30),
            x + i * fw * 0.34 * spread, L.toeY - 0.015, L.tipZ - 0.02), `toe${side}`);
        }
      }
      B.frame(at(roundedBox(fw * 1.2, 0.03, fw * 1.2, 0.008, 1), x, L.toeY - 0.035, L.toeZ * 0.4), `foot${side}`);
    }
  }

  // Ankle accent band + team stripe on the outer shin.
  B.emis(at(ringGeo(sw * 0.42, 0.008, B.low ? 8 : 12, 4).rotateY(Math.PI / 2), x, aY, aZ), `foot${side}`, ac, 1.2);
  B.emis(at(roundedBox(0.014, 0.11, 0.014, 0.004, 1)
    .rotateX(Math.atan2(aZ - kZ, aY - kY)), x + s * sw * 0.54, lerp(kY, aY, 0.45), lerp(kZ, aZ, 0.45)),
    `shin${side}`, team, 1.5);
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

function buildGun(B, P, C) {
  const a = B.arc;
  const { gun, em } = C;
  const x = P.shX, y = SIL_wristY(P), z0 = SIL_wristZ(P);
  const gc = gun.look.colour;

  // Receiver — shared by every gun so the arm mount reads consistently.
  B.shellA(at(roundedBox(0.115, 0.125, 0.24, 0.024, a), x, y, z0 + 0.10), 'gun');
  B.frame(at(roundedBox(0.135, 0.06, 0.10, 0.014, a), x, y - 0.055, z0 + 0.06), 'gun');
  B.emis(at(roundedBox(0.02, 0.05, 0.014, 0.005, 1), x + 0.062, y + 0.02, z0 + 0.06), 'gun', gc, 2.0);

  switch (gun.id) {
    case 'vulcan': {
      // Six-barrel rotary on a spun hub, plus a fat ammo drum.
      B.frame(at(cyl(0.055, 0.058, 0.10, B.rad).rotateX(Math.PI / 2), x, y, z0 + 0.24), 'slide');
      const n = B.low ? 4 : 6;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * TAU;
        B.frame(at(cyl(0.019, 0.019, 0.34, 7).rotateX(Math.PI / 2),
          x + Math.cos(t) * 0.042, y + Math.sin(t) * 0.042, z0 + 0.40), 'spin');
      }
      B.shellA(at(cyl(0.070, 0.070, 0.055, B.rad).rotateX(Math.PI / 2), x, y, z0 + 0.54), 'spin');
      B.shellA(at(cyl(0.085, 0.095, 0.14, B.low ? 10 : 14).rotateZ(Math.PI / 2), x - 0.09, y - 0.02, z0 + 0.16), 'gun');
      B.emis(at(ringGeo(0.052, 0.008, B.low ? 10 : 16, 4), x, y, z0 + 0.56), 'slide', gc, 2.4);
      break;
    }
    case 'scatter': {
      // Short and wide: a flared choke and a visible shell rack.
      B.frame(at(cyl(0.048, 0.052, 0.26, B.rad).rotateX(Math.PI / 2), x, y, z0 + 0.30), 'slide');
      B.shellA(at(cyl(0.115, 0.062, 0.16, B.low ? 10 : 16, true).rotateX(-Math.PI / 2), x, y, z0 + 0.50), 'slide');
      B.frame(at(roundedBox(0.15, 0.05, 0.16, 0.012, a), x, y + 0.085, z0 + 0.22), 'gun');
      if (!B.low) {
        for (let i = 0; i < 4; i++) {
          B.emis(at(cyl(0.014, 0.014, 0.05, 6).rotateX(Math.PI / 2),
            x - 0.048 + i * 0.032, y + 0.085, z0 + 0.31), 'gun', gc, 1.8);
        }
      }
      B.emis(at(disc(0.085, B.low ? 10 : 16), x, y, z0 + 0.575), 'slide', gc, 2.0);
      break;
    }
    case 'lancer': {
      // A rail, not a gun. Long spine, three focusing rings, stabiliser fins.
      B.frame(at(roundedBox(0.05, 0.05, 0.62, 0.012, a), x, y, z0 + 0.42), 'slide');
      for (let i = 0; i < 3; i++) {
        const zz = z0 + 0.30 + i * 0.17;
        B.shellA(at(ringGeo(0.062 - i * 0.010, 0.020, B.low ? 10 : 16, 5), x, y, zz), 'spin');
        B.emis(at(ringGeo(0.062 - i * 0.010, 0.007, B.low ? 10 : 16, 4), x, y, zz + 0.016), 'spin', gc, 2.2);
      }
      for (const q of [-1, 1]) {
        const fin = taperBox(0.012, 0.030, 0.20, 0.03, 0.11, 0.006, a);
        fin.rotateX(Math.PI / 2);
        fin.rotateZ(q * 0.35);
        fin.translate(x + q * 0.055, y - 0.02, z0 + 0.24);
        B.shellA(fin, 'gun');
      }
      B.emis(at(disc(0.040, B.low ? 10 : 16), x, y, z0 + 0.70), 'slide', gc, 2.6);
      break;
    }
    case 'seeker': {
      // A boxed launcher: 2x3 cells with visible warhead tips and a seeker eye.
      B.shellA(at(roundedBox(0.17, 0.19, 0.30, 0.022, a), x, y + 0.01, z0 + 0.32), 'slide');
      for (let r = 0; r < 3; r++) {
        for (let c2 = 0; c2 < 2; c2++) {
          const px = x - 0.042 + c2 * 0.084;
          const py = y + 0.075 - r * 0.062;
          B.frame(at(cyl(0.030, 0.030, 0.06, 8).rotateX(Math.PI / 2), px, py, z0 + 0.46), 'slide');
          B.emis(at(disc(0.021, 8), px, py, z0 + 0.492), 'slide', gc, 2.2);
        }
      }
      B.frame(at(roundedBox(0.19, 0.03, 0.24, 0.008, 1), x, y + 0.115, z0 + 0.30), 'gun');
      B.emis(at(ball(0.028, B.low ? 6 : 10), x, y + 0.135, z0 + 0.40), 'gun', gc, 2.6);
      break;
    }
    default: {
      // TEMPEST: twin over-under barrels with a heat shroud between them.
      for (const q of [1, -1]) {
        const py = y + q * 0.048;
        B.frame(at(cyl(0.032, 0.034, 0.40, B.rad).rotateX(Math.PI / 2), x, py, z0 + 0.36), 'slide');
        B.shellA(at(cyl(0.044, 0.040, 0.09, B.rad).rotateX(Math.PI / 2), x, py, z0 + 0.52), 'slide');
        B.emis(at(ringGeo(0.030, 0.007, B.low ? 8 : 14, 4), x, py, z0 + 0.555), 'slide', gc, 2.3);
      }
      B.shellA(at(roundedBox(0.10, 0.055, 0.22, 0.016, a), x, y, z0 + 0.30), 'slide');
      if (!B.low) {
        for (let i = 0; i < 3; i++) {
          B.frame(at(roundedBox(0.115, 0.012, 0.03, 0.004, 1), x, y, z0 + 0.24 + i * 0.05), 'slide');
        }
      }
      B.emis(at(roundedBox(0.014, 0.07, 0.012, 0.004, 1), x + 0.055, y, z0 + 0.30), 'slide', gc, 1.8);
      break;
    }
  }

  // Muzzle flash — parked at scale 0, punched out by onFire().
  const fl = cyl(0.005, 0.14, 0.30, B.low ? 6 : 10, true);
  fl.rotateX(-Math.PI / 2);
  fl.translate(x, y, z0 + 0.62);
  B.flare(fl, 'flash', gc, 2.2);
  B.flare(at(ringGeo(0.10, 0.035, B.low ? 8 : 14, 4), x, y, z0 + 0.52), 'flash', gc, 1.6);
}

function buildBombArm(B, P, C) {
  const a = B.arc;
  const { bomb, em } = C;
  const x = -P.shX;
  const y = P.shY - P.elbowDrop - 0.26, z = 0.09;
  const bc = bomb.look.colour, bs = bomb.look.shell;

  // Forearm-mounted launcher. Angled off the arm so it never reads as a tube
  // glued to a tube.
  B.shellA(at(roundedBox(0.145, 0.20, 0.145, 0.024, a), x - 0.035, y + 0.04, z), 'bomb');
  B.frame(at(roundedBox(0.16, 0.05, 0.10, 0.012, a), x - 0.035, y + 0.15, z), 'bomb');

  switch (bomb.look.style) {
    case 'drum': {
      // QUAKE: a wide-mouth stubby mortar.
      B.frame(at(cyl(0.085, 0.070, 0.14, B.low ? 10 : 14), x - 0.035, y - 0.09, z), 'bomb');
      B.shellA(at(cyl(0.105, 0.082, 0.06, B.low ? 10 : 14), x - 0.035, y - 0.17, z), 'bomb');
      B.emis(at(disc(0.072, B.low ? 10 : 16).rotateX(Math.PI / 2), x - 0.035, y - 0.201, z), 'bomb', bc, 2.2);
      break;
    }
    case 'cluster': {
      // CLUSTER: a three-tube rack, because five apologies need somewhere to sit.
      for (let i = 0; i < 3; i++) {
        const ox = (i - 1) * 0.048;
        B.frame(at(cyl(0.026, 0.026, 0.15, 8), x - 0.035 + ox, y - 0.09, z), 'bomb');
        B.emis(at(disc(0.019, 8).rotateX(Math.PI / 2), x - 0.035 + ox, y - 0.166, z), 'bomb', bc, 2.2);
      }
      B.shellA(at(roundedBox(0.16, 0.05, 0.09, 0.012, a), x - 0.035, y - 0.04, z), 'bomb');
      break;
    }
    default: {
      // STANDARD / STICKY: a magazine drum feeding a single stubby tube.
      B.shellA(at(cyl(0.072, 0.072, 0.09, B.low ? 10 : 14).rotateZ(Math.PI / 2), x - 0.11, y + 0.02, z), 'bomb');
      B.frame(at(cyl(0.048, 0.044, 0.17, B.low ? 8 : 12), x - 0.035, y - 0.10, z), 'bomb');
      B.shellA(at(cyl(0.062, 0.052, 0.05, B.low ? 8 : 12), x - 0.035, y - 0.19, z), 'bomb');
      B.emis(at(disc(0.040, B.low ? 8 : 14).rotateX(Math.PI / 2), x - 0.035, y - 0.216, z), 'bomb', bc, 2.2);
      break;
    }
  }
  B.emis(at(roundedBox(0.05, 0.014, 0.012, 0.004, 1), x - 0.035, y + 0.13, z + 0.075), 'bomb', bs, 1.4);
}

function buildPod(B, P, C) {
  const a = B.arc;
  const { pod } = C;
  const y = P.hipY - 0.02, z = -P.hipD * 0.55 - 0.05;
  const pc = pod.look.colour, ps = pod.look.shell;
  const sz = pod.look.size;

  // Docking cradle so the pod never looks like it is floating behind the hips.
  B.frame(at(roundedBox(0.16, 0.05, 0.09, 0.012, a), 0, y + 0.05, z + 0.03), 'pod');

  switch (pod.look.style) {
    case 'tripod': {
      // SENTRY: a squat turret that clearly wants to sit down and shoot.
      B.shellL(at(cyl(sz * 0.62, sz * 0.75, sz * 0.55, B.low ? 8 : 12), 0, y - 0.03, z), 'pod');
      B.frame(at(cyl(sz * 0.34, sz * 0.34, sz * 0.30, 8), 0, y + 0.13, z), 'pod');
      B.emis(at(ringGeo(sz * 0.52, 0.010, B.low ? 10 : 16, 4).rotateX(Math.PI / 2), 0, y + 0.06, z), 'pod', pc, 2.2);
      if (!B.low) {
        for (let i = 0; i < 3; i++) {
          const t = (i / 3) * TAU;
          const leg = taperBox(0.018, 0.030, 0.13, 0.018, 0.030, 0.006, 1);
          leg.rotateZ(Math.sin(t) * 0.45);
          leg.rotateX(-Math.cos(t) * 0.45);
          leg.translate(Math.sin(t) * sz * 0.55, y - 0.13, z + Math.cos(t) * sz * 0.55);
          B.frame(leg, 'pod');
        }
      }
      break;
    }
    case 'ring': {
      // WRAITH: a hovering ring that circles and decides.
      B.shellL(at(ringGeo(sz * 0.80, sz * 0.22, B.low ? 12 : 18, 6).rotateX(Math.PI / 2), 0, y - 0.02, z), 'pod');
      B.frame(at(ball(sz * 0.34, B.low ? 6 : 10), 0, y - 0.02, z), 'pod');
      B.emis(at(ringGeo(sz * 0.80, 0.010, B.low ? 12 : 20, 4).rotateX(Math.PI / 2), 0, y - 0.02, z), 'pod', pc, 2.4);
      B.emis(at(ball(sz * 0.18, B.low ? 6 : 10), 0, y - 0.02, z), 'pod', ps, 2.0);
      break;
    }
    default: {
      // STINGER: a dart, nose-down in its cradle.
      const body = taperBox(sz * 0.30, sz * 0.75, sz * 1.5, sz * 0.30, sz * 0.75, 0.014, a);
      body.rotateX(0.35);
      body.translate(0, y - 0.06, z);
      B.shellL(body, 'pod');
      if (!B.low) {
        for (const q of [-1, 1]) {
          const fin = taperBox(0.010, 0.026, 0.11, 0.03, 0.09, 0.005, 1);
          fin.rotateZ(q * 0.5);
          fin.rotateX(0.35);
          fin.translate(q * sz * 0.42, y + 0.10, z - 0.05);
          B.shellL(fin, 'pod');
        }
      }
      B.emis(at(ball(sz * 0.20, B.low ? 6 : 10).scale(1, 1, 1.4), 0, y - 0.28, z + 0.10), 'pod', pc, 2.6);
      break;
    }
  }
}

const at = (g, x, y, z) => { g.translate(x, y, z); return g; };

// ---------------------------------------------------------------------------
// RoboModel
// ---------------------------------------------------------------------------

export class RoboModel {
  constructor(loadout, teamColor, settings, envMap = null) {
    this.loadout = loadout;
    this.teamColor = teamColor;
    this.settings = settings;
    this.envMap = envMap;
    this.preview = false;

    this.group = new THREE.Group();
    this.group.name = 'robo';
    this.height = 1.62;

    // --- animation state (all scalars; update() never allocates)
    this.fAir = 0; this.fDash = 0; this.fDown = 0; this.fMove = 0; this.fGetup = 0;
    this.land = 0; this.prevVy = 0; this.wasGrounded = true;
    this.recoil = 0; this.recoilB = 0; this.flash = 0;
    this.spinAngle = 0; this.spinRate = 0;
    this.tumble = 0; this.getupT = 99;
    this.lean = 0; this.bank = 0; this.breathe = 0;
    this.podOpen = 0; this.heat = 0; this.chargeAmt = 0;
    this.prevState = 0;

    this._build();
  }

  // -------------------------------------------------------------------------

  get _low() {
    const s = this.settings;
    return s.particleBudget <= 300 || s.anisotropy <= 2;
  }

  _build() {
    const ld = this.loadout;
    const look = ld.body.look;
    const P = SIL[look.silhouette] || SIL.strider;
    const L = LEGS[ld.legs.look.style] || LEGS.sprinter;
    const low = this._low;

    this.P = P;
    this.L = L;
    this.low = low;
    this.refSpeed = ld.body.moveSpeed;
    this.chargeTicks = ld.gun.chargeTicks || 50;
    this.legStyle = ld.legs.look.style;
    this.walkGain = L.walk;

    const team = (teamHex) => (teamHex === 0 || teamHex === 1) ? TEAM_TINT[teamHex] : teamHex;
    const teamHex = team(this.teamColor);

    const rig = buildRig(P, L);
    this.rig = rig;
    this.group.add(rig.bones[0]);

    const B = new Build(rig, { arc: low ? 1 : 1, radial: low ? 8 : 12, low });
    const C = {
      look, legs: ld.legs, gun: ld.gun, bomb: ld.bomb, pod: ld.pod,
      em: look.emissive, ac: look.accent, team: teamHex,
    };

    buildPelvis(B, P, C);
    buildChest(B, P, C);
    buildBackpack(B, P, C);
    buildHead(B, P, C);
    for (const s of [-1, 1]) {
      buildShoulder(B, P, C, s);
      buildArm(B, P, C, s);
      buildLeg(B, P, L, C, s);
    }
    buildGun(B, P, C);
    buildBombArm(B, P, C);
    buildPod(B, P, C);

    // --- materials -----------------------------------------------------------
    const texSize = low ? 256 : 512;
    const aniso = this.settings.anisotropy;
    const legLook = {
      primary: ld.legs.look.colour,
      secondary: look.secondary,
      accent: ld.legs.look.accent,
      trim: look.trim,
      emissive: look.emissive,
      metalness: Math.min(1, (look.metalness ?? 0.9) * 0.96),
      roughness: (look.roughness ?? 0.3) + 0.07,
    };

    const shell = (lk, seed, opts) => {
      const maps = armorTexture(lk, texSize, seed);
      for (const t of Object.values(maps)) if (t?.isTexture) t.anisotropy = aniso;
      const m = roboShell(maps, lk, teamHex, opts);
      m.envMap = this.envMap;
      return m;
    };

    this.matTorso = shell(look, 0, { rimStrength: 0.6, energy: 0.30, normalScale: 1.1 });
    this.matArms = low ? this.matTorso : shell(look, 3, { rimStrength: 0.5, energy: 0.24, normalScale: 1.0 });
    this.matLegs = shell(legLook, 7, { rimStrength: 0.45, energy: 0.20, normalScale: 1.0 });

    const tr = TRIM[look.trim] || TRIM.gunmetal;
    this.matFrame = new THREE.MeshStandardMaterial({
      color: new THREE.Color(tr.color),
      roughness: tr.rough,
      metalness: tr.metal,
      envMap: this.envMap,
      envMapIntensity: 1.5,
      dithering: true,
    });

    this.matEmis = new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, toneMapped: false, fog: false,
    });
    this.matFlare = additive(0xffffff, { opacity: 1, side: THREE.DoubleSide });
    this.matFlare.vertexColors = true;
    this.matHalo = low ? null : fresnelGlow(look.emissive, { power: 2.2, intensity: 1.5, opacity: 0.85 });

    // --- meshes --------------------------------------------------------------
    this.meshes = [];
    this.shellMats = [this.matTorso, this.matLegs];
    if (this.matArms !== this.matTorso) this.shellMats.push(this.matArms);

    const shadows = !!this.settings.shadows;
    const mk = (list, mat, opts = {}) => {
      if (!list.length || !mat) return null;
      const geo = mergeGeometries(list);
      ensureAOChannel(geo);
      geo.boundingSphere = _sphere.clone();
      const m = new THREE.SkinnedMesh(geo, mat);
      m.castShadow = shadows && !opts.noShadow;
      m.receiveShadow = shadows && !opts.noShadow;
      if (opts.order !== undefined) m.renderOrder = opts.order;
      this.group.add(m);
      this.meshes.push(m);
      return m;
    };

    // Bind after the rest pose is resolved — Skeleton derives its inverses from
    // the bones' world matrices, so they have to be current and un-posed.
    this.group.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(rig.bones);

    const merged = low
      ? { torso: B.buckets.torso.concat(B.buckets.arms), arms: [], ...B.buckets }
      : B.buckets;
    if (low) { merged.arms = []; merged.legs = B.buckets.legs; }

    mk(merged.torso, this.matTorso);
    mk(merged.arms, this.matArms);
    mk(merged.legs, this.matLegs);
    mk(B.buckets.frame, this.matFrame);
    mk(B.buckets.emis, this.matEmis, { noShadow: true, order: 1 });
    mk(B.buckets.flare, this.matFlare, { noShadow: true, order: 3 });
    mk(B.buckets.halo, this.matHalo, { noShadow: true, order: 2 });

    for (const m of this.meshes) m.bind(this.skeleton, m.matrixWorld);

    // --- bone handles used every frame --------------------------------------
    const g = (n) => rig.get(n);
    this.bRoot = g('root'); this.bPelvis = g('pelvis'); this.bSpine = g('spine');
    this.bChest = g('chest'); this.bNeck = g('neck'); this.bHead = g('head');
    this.bPack = g('pack'); this.bCore = g('core'); this.bPod = g('pod');
    this.bClavL = g('clavL'); this.bArmL = g('armL'); this.bForeL = g('foreL'); this.bHandL = g('handL');
    this.bClavR = g('clavR'); this.bArmR = g('armR'); this.bForeR = g('foreR'); this.bHandR = g('handR');
    this.bSlide = g('slide'); this.bSpin = g('spin'); this.bMuzzle = g('muzzle'); this.bFlash = g('flash');
    this.bThighL = g('thighL'); this.bShinL = g('shinL'); this.bFootL = g('footL'); this.bToeL = g('toeL');
    this.bThighR = g('thighR'); this.bShinR = g('shinR'); this.bFootR = g('footR'); this.bToeR = g('toeR');
    this.bHipL = g('hipL'); this.bHipR = g('hipR');
    this.bThrL = g('thrL'); this.bThrR = g('thrR');
    this.bBootL = g('bootL'); this.bBootR = g('bootR');

    this.bFlash.scale.setScalar(0.0001);
    this.bThrL.scale.setScalar(0.0001);
    this.bThrR.scale.setScalar(0.0001);
    this.bBootL.scale.setScalar(0.0001);
    this.bBootR.scale.setScalar(0.0001);

    // Tumble pivot sits at the robot's centre of mass, not its feet.
    this.pivotY = P.hipY * 0.65 + 0.35;
  }

  _teardown() {
    for (const m of this.meshes || []) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.meshes = [];
    for (const m of [this.matTorso, this.matArms, this.matLegs, this.matFrame,
      this.matEmis, this.matFlare, this.matHalo]) {
      if (m && m !== this.matTorso) m.dispose();
    }
    this.matTorso?.dispose();
    this.skeleton?.dispose?.();
    if (this.rig) this.group.remove(this.rig.bones[0]);
    this.rig = null;
  }

  // -------------------------------------------------------------------------
  // Animation
  // -------------------------------------------------------------------------

  /** Damped absolute-local euler assign, taken as a delta on the rest pose. */
  _rot(b, dx, dy, dz, k, dt) {
    const r = b.rotation;
    r.x = damp(r.x, b.rx0 + dx, k, dt);
    r.y = damp(r.y, dy, k, dt);
    r.z = damp(r.z, dz, k, dt);
  }

  update(robo, dt, time) {
    dt = Math.min(dt, 0.05);
    const P = this.P, L = this.L;
    const st = robo.state;
    const isDown = st === 2, isDead = st === 4, isDash = st === 1, isGetup = st === 3;

    // --- root placement ------------------------------------------------------
    this.group.position.set(robo.pos.x, robo.pos.y, robo.pos.z);
    this.group.rotation.y = robo.yaw;

    if (st !== this.prevState) {
      if (st === 3) this.getupT = 0;
      this.prevState = st;
    }
    if (isGetup) this.getupT += dt;

    // --- blend factors -------------------------------------------------------
    const sy = Math.sin(robo.yaw), cy = Math.cos(robo.yaw);
    const fwdV = robo.vel.x * sy + robo.vel.z * cy;
    const sideV = robo.vel.x * cy - robo.vel.z * sy;
    const speed = Math.hypot(robo.vel.x, robo.vel.z);
    const gait = clamp01(speed / Math.max(1, this.refSpeed)) * clamp01(robo.moveAmt * 1.6 + 0.15);

    this.fAir = damp(this.fAir, robo.grounded ? 0 : 1, 13, dt);
    this.fDash = damp(this.fDash, isDash ? 1 : 0, isDash ? 22 : 9, dt);
    this.fDown = damp(this.fDown, (isDown || isDead) ? 1 : 0, (isDown || isDead) ? 15 : 6, dt);
    this.fMove = damp(this.fMove, robo.grounded ? gait : 0, 10, dt);
    this.fGetup = clamp01(1 - this.getupT / 0.55) * (isGetup ? 1 : 0);
    this.fGetup = damp(this.fGetup, isGetup ? clamp01(1 - this.getupT / 0.55) : 0, 14, dt);

    // Landing impact from the last airborne vertical velocity.
    if (robo.grounded && !this.wasGrounded) this.land = clamp01(Math.abs(this.prevVy) / 15);
    this.land = Math.max(0, this.land - dt * 4.6);
    this.wasGrounded = robo.grounded;
    if (!robo.grounded) this.prevVy = robo.vel.y;

    this.recoil = Math.max(0, this.recoil - dt / 0.15);
    this.recoilB = Math.max(0, this.recoilB - dt / 0.20);
    this.flash = Math.max(0, this.flash - dt / 0.055);
    this.podOpen = Math.max(0, this.podOpen - dt / 0.5);
    this.heat = damp(this.heat, clamp01(robo.boostHeat) + this.fDash * 0.6 + this.fAir * 0.25, 11, dt);
    this.chargeAmt = damp(this.chargeAmt, clamp01(robo.charge / this.chargeTicks), 9, dt);

    const limbK = lerp(48, 4.5, this.fDown);
    const bodyK = lerp(26, 4.0, this.fDown);

    // --- tumble / knockdown --------------------------------------------------
    if (isDown || isDead) {
      const rate = (5.2 + clamp01(speed / 12) * 5.0) * (robo.grounded ? 0.22 : 1);
      this.tumble += dt * rate;
      if (this.tumble > TAU) this.tumble -= TAU;
    } else {
      this.tumble = damp(this.tumble, TAU, 8, dt);
      if (this.fDown < 0.02) this.tumble = 0;
    }

    // --- locomotion ----------------------------------------------------------
    const walk = this.fMove * this.walkGain;
    const p = robo.stepPhase * 0.8;
    const sp = Math.sin(p), cp = Math.cos(p);
    const breatheAmp = this.preview ? 1 : 0.35;
    this.breathe += dt * (this.preview ? 1.5 : 2.2);
    const bob = Math.sin(this.breathe) * 0.008 * breatheAmp;

    const air = this.fAir, dash = this.fDash, dwn = this.fDown, gu = this.fGetup;
    const ground = (1 - air) * (1 - dwn);

    // Chassis lean: dash pushes hard into the velocity, walking leans a little.
    const leanT = (fwdV * (0.012 + dash * 0.030)) * (1 - dwn) + gu * 0.30;
    const bankT = (-sideV * (0.010 + dash * 0.022)) * (1 - dwn);
    this.lean = damp(this.lean, clamp(leanT, -0.55, 0.55), 12, dt);
    this.bank = damp(this.bank, clamp(bankT, -0.42, 0.42), 12, dt);

    // Root: squash on landing, stretch on the way up, tumble about the CoM.
    const squash = this.land;
    const stretch = clamp01(Math.max(0, robo.vel.y) / 16) * air;
    const root = this.bRoot;
    root.position.y = -squash * 0.14 - gu * 0.22 + bob;
    root.scale.set(1 + squash * 0.09 - stretch * 0.05, 1 - squash * 0.13 + stretch * 0.10, 1 + squash * 0.09 - stretch * 0.05);
    root.rotation.x = this.lean + this.tumble * dwn;
    root.rotation.z = this.bank + Math.sin(this.tumble * 0.75) * 0.42 * dwn;
    root.position.z = -Math.sin(this.tumble * dwn) * this.pivotY * dwn;
    root.position.y += (1 - Math.cos(this.tumble * dwn)) * this.pivotY * dwn;

    // --- pelvis / spine ------------------------------------------------------
    const hipSway = sp * 0.030 * walk;
    this.bPelvis.position.x = damp(this.bPelvis.position.x, this.bPelvis.px0 + hipSway, limbK, dt);
    this.bPelvis.position.y = damp(this.bPelvis.position.y,
      this.bPelvis.py0 + Math.sin(p * 2) * 0.028 * walk - gu * 0.10 - air * 0.02, limbK, dt);
    this._rot(this.bPelvis, -gu * 0.18 + air * 0.10, sp * 0.16 * walk, -sp * 0.075 * walk, limbK, dt);

    // Aim split: the chest carries most of the yaw offset, the head the rest.
    const dYaw = angleDelta(robo.yaw, robo.aimYaw);
    const pitch = robo.aimPitch;
    const recoilAbsorb = this.recoil * 0.9;

    this._rot(this.bSpine,
      -pitch * 0.10 + recoilAbsorb * -0.10 + gu * 0.34 + air * 0.06,
      dYaw * 0.30 - sp * 0.06 * walk, 0, bodyK, dt);
    this._rot(this.bChest,
      -pitch * 0.18 + recoilAbsorb * -0.14 + gu * 0.26 - squash * 0.10 + Math.sin(this.breathe) * 0.012 * breatheAmp,
      dYaw * 0.34 - sp * 0.10 * walk,
      sp * 0.04 * walk, bodyK, dt);
    this._rot(this.bNeck, -pitch * 0.22 - gu * 0.30, dYaw * 0.22, 0, bodyK * 1.2, dt);
    this._rot(this.bHead, -pitch * 0.26 + squash * 0.10, dYaw * 0.14 + sp * 0.03 * walk, -sp * 0.03 * walk, bodyK * 1.2, dt);

    // --- gun arm: rest pose already aims down +Z, so this is a pure delta -----
    const aimK = lerp(30, 5, dwn);
    const gunSag = -0.06 - air * 0.10;
    this._rot(this.bClavR, -pitch * 0.12, dYaw * 0.20, -air * 0.10, aimK, dt);
    this._rot(this.bArmR,
      -pitch * 0.72 + this.recoil * 0.34 + gunSag + sp * 0.05 * walk + gu * 0.5,
      dYaw * 0.32 - air * 0.12,
      -0.05 - air * 0.30 - dash * 0.10, aimK, dt);
    this._rot(this.bForeR, -pitch * 0.20 + this.recoil * 0.16 + gu * 0.4, 0, 0, aimK, dt);
    this._rot(this.bHandR, this.recoil * 0.10, 0, 0, aimK, dt);
    this.bSlide.position.z = damp(this.bSlide.position.z, this.bSlide.pz0 - this.recoil * 0.085, 26, dt);

    // Rotary barrels spin up while charging or firing and coast back down.
    this.spinRate = damp(this.spinRate, this.recoil * 26 + this.chargeAmt * 12, 6, dt);
    this.spinAngle += this.spinRate * dt;
    this.bSpin.rotation.z = this.loadout.gun.id === 'lancer' ? -this.spinAngle * 0.4 : this.spinAngle;

    // --- free arm: contralateral swing, balance flare, bomb throw ------------
    const swing = -sp * 0.55 * walk;
    this._rot(this.bClavL, 0, -dYaw * 0.10, air * 0.12, limbK, dt);
    this._rot(this.bArmL,
      swing + air * -0.55 + dash * 0.25 - this.recoilB * 0.85 + gu * 0.6 - squash * 0.25,
      -dYaw * 0.10,
      0.10 + air * 0.55 + dash * 0.12 + dwn * 0.3, limbK, dt);
    this._rot(this.bForeL,
      -0.10 - Math.max(0, -sp) * 0.30 * walk - air * 0.35 + this.recoilB * 0.5 + gu * 0.7,
      0, 0, limbK, dt);
    this._rot(this.bHandL, -this.recoilB * 0.3, 0, 0, limbK, dt);

    // --- legs ----------------------------------------------------------------
    const hover = this.legStyle === 'hover';
    if (hover) {
      // HOVER-V never steps: it banks, trails and lets the turbines do the work.
      const trail = clamp(fwdV * 0.018, -0.30, 0.30);
      for (const s of [0, 1]) {
        const th = s ? this.bThighR : this.bThighL;
        const sh = s ? this.bShinR : this.bShinL;
        const ft = s ? this.bFootR : this.bFootL;
        const to = s ? this.bToeR : this.bToeL;
        const q = s ? 1 : -1;
        this._rot(th, -trail * 0.8 - air * 0.18 + squash * 0.30 + gu * 0.9, 0, q * (0.05 + air * 0.10), limbK * 0.8, dt);
        this._rot(sh, trail * 0.5 + squash * 0.35 + gu * 0.6, 0, 0, limbK * 0.8, dt);
        this._rot(ft, -trail * 0.4 - squash * 0.20 - gu * 0.5, 0, 0, limbK * 0.8, dt);
        to.rotation.y += dt * (5 + this.heat * 26);
      }
    } else {
      for (const s of [0, 1]) {
        const ph = s ? p + Math.PI : p;
        const s2 = Math.sin(ph), c2 = Math.cos(ph);
        const th = s ? this.bThighR : this.bThighL;
        const sh = s ? this.bShinR : this.bShinL;
        const ft = s ? this.bFootR : this.bFootL;
        const to = s ? this.bToeR : this.bToeL;
        const q = s ? 1 : -1;

        // Walk cycle: thigh swings, knee flexes on the recovery half, the foot
        // stays level under it and the toe pushes off at the end of stance.
        const wThigh = -s2 * 0.62 * walk;
        const wShin = Math.max(0, Math.sin(ph - 1.0)) * 0.95 * walk;
        const wFoot = -(wThigh + wShin) * 0.55 + Math.max(0, -c2) * 0.22 * walk;
        const wToe = Math.max(0, -Math.sin(ph + 0.6)) * 0.35 * walk;

        // Airborne: legs tuck and trail behind the direction of travel.
        const trail = clamp(fwdV * 0.014, -0.28, 0.28);
        const aThigh = -0.50 - trail + (s ? 0.14 : -0.10);
        const aShin = 1.05 + (s ? -0.16 : 0.14);
        const aFoot = -0.35;

        const dThigh = -0.34 - trail * 1.2 + (s ? 0.10 : -0.06);
        const dShin = 0.72;

        let rt = lerp(wThigh, aThigh, air);
        let rs = lerp(wShin, aShin, air);
        let rf = lerp(wFoot, aFoot, air);
        rt = lerp(rt, dThigh, dash * (1 - air) * 0.8);
        rs = lerp(rs, dShin, dash * (1 - air) * 0.8);

        // Landing absorption + get-up crouch.
        rt += -squash * 0.55 - gu * 0.95;
        rs += squash * 1.05 + gu * 1.5;
        rf += -squash * 0.45 - gu * 0.55;

        this._rot(th, rt, q * 0.03 * walk * s2, q * (0.035 + air * 0.10 + squash * 0.10), limbK, dt);
        this._rot(sh, rs, 0, 0, limbK, dt);
        this._rot(ft, rf, 0, -q * 0.03, limbK, dt);
        this._rot(to, lerp(wToe, 0.30, air) + squash * 0.25, 0, 0, limbK, dt);
      }
    }

    // --- thrusters, pod bay, reactor ----------------------------------------
    const heat = clamp01(this.heat);
    const flick = 0.82 + Math.sin(time * 47 + this.spinAngle) * 0.18;
    const mainT = (heat * 0.9 + air * 0.25) * flick;
    this.bThrL.scale.set(0.8 + mainT * 0.5, 0.8 + mainT * 0.5, Math.max(0.0001, mainT));
    this.bThrR.scale.copy(this.bThrL.scale);
    const bootT = (heat * 0.7 + air * 0.45 + dash * 0.5) * flick;
    this.bBootL.scale.set(0.9, 0.9, Math.max(0.0001, bootT));
    this.bBootR.scale.copy(this.bBootL.scale);

    const fl = Math.max(0.0001, this.flash * (0.9 + Math.sin(time * 90) * 0.1));
    this.bFlash.scale.set(fl, fl, fl);

    const pulse = 1 + this.chargeAmt * 0.35 + Math.sin(time * 6) * 0.03 + Math.sin(time * 30) * this.chargeAmt * 0.12;
    this.bCore.scale.setScalar(pulse);
    this._rot(this.bPod, -this.podOpen * 0.9, 0, 0, 14, dt);
    this._rot(this.bPack, -pitch * 0.06 + air * 0.10, 0, 0, bodyK, dt);

    // --- shader uniforms -----------------------------------------------------
    const hit = clamp01(robo.hurtFlash / 10);
    const invuln = robo.invuln > 0 ? (0.5 + 0.5 * Math.sin(time * 26)) : 0;
    for (let i = 0; i < this.shellMats.length; i++) {
      const u = this.shellMats[i].userData.u;
      if (!u) continue;
      u.uTime.value = time;
      u.uHitFlash.value = hit * hit * 0.85;
      u.uCharge.value = this.chargeAmt * (robo.chargeReady ? 1 : 0.55);
      u.uEnergy.value = 0.22 + heat * 0.35 + invuln * 0.5;
      u.uRimStrength.value = 0.5 + invuln * 0.9 + hit * 0.6;
    }
    if (this.matHalo) {
      this.matHalo.uniforms.uIntensity.value = 1.2 + this.chargeAmt * 2.2 + heat * 0.6 + hit * 1.5;
    }
    this.matEmis.opacity = 1;
    this.matFlare.opacity = clamp01(0.55 + heat * 0.5);

    // Dead robos settle instead of standing at attention.
    if (isDead) this.group.position.y -= 0.02;
  }

  // -------------------------------------------------------------------------

  onFire(kind) {
    if (kind === 'gunCharged') {
      this.recoil = 1.0; this.flash = 1.0; this.spinRate = Math.max(this.spinRate, 34);
    } else if (kind === 'gun') {
      this.recoil = Math.max(this.recoil, 0.5); this.flash = 0.62;
      this.spinRate = Math.max(this.spinRate, 22);
    } else if (kind === 'bomb') {
      this.recoilB = 1;
    } else if (kind === 'pod') {
      this.podOpen = 1;
    }
  }

  muzzleWorld(out) {
    this.bMuzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.bMuzzle.matrixWorld);
  }

  setQuality(settings) {
    const wasLow = this.low;
    this.settings = settings;
    if (this._low !== wasLow) {
      this._teardown();
      this._build();
      return;
    }
    const shadows = !!settings.shadows;
    for (const m of this.meshes) {
      if (m.material === this.matEmis || m.material === this.matFlare || m.material === this.matHalo) continue;
      m.castShadow = shadows;
      m.receiveShadow = shadows;
    }
    for (const mat of this.shellMats) {
      for (const k of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap']) {
        if (mat[k]) mat[k].anisotropy = settings.anisotropy;
      }
    }
  }

  dispose() {
    this._teardown();
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// RoboPreview — the garage hero. Same rig, same shaders, a calmer brain.
// ---------------------------------------------------------------------------

export class RoboPreview {
  constructor(loadout, teamColor, settings, envMap = null) {
    this.teamColor = teamColor;
    this.settings = settings;
    this.envMap = envMap;
    this.group = new THREE.Group();
    this.t = 0;
    this._make(loadout);
  }

  _make(loadout) {
    this.loadout = loadout;
    this.model = new RoboModel(loadout, this.teamColor, this.settings, this.envMap);
    this.model.preview = true;
    this.group.add(this.model.group);
  }

  setLoadout(loadout) {
    this.model.dispose();
    this.group.remove(this.model.group);
    this._make(loadout);
  }

  update(dt, time) {
    this.t += dt;
    const s = _previewState;
    // A slow weight shift plus a wandering gaze reads as "idling", not "frozen".
    s.aimYaw = Math.sin(this.t * 0.32) * 0.22;
    s.aimPitch = Math.sin(this.t * 0.23 + 1.1) * 0.10 - 0.04;
    s.yaw = s.aimYaw * 0.45;
    s.boostHeat = 0.10 + Math.max(0, Math.sin(this.t * 0.55)) * 0.16;
    s.stepPhase = 0;
    this.model.update(s, dt, time);
  }

  setQuality(settings) {
    this.settings = settings;
    this.model.setQuality(settings);
  }

  dispose() {
    this.model.dispose();
    this.group.clear();
  }
}
