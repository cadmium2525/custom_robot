/**
 * The holosseum: level geometry, lighting rig, sky and atmosphere.
 *
 * Geometry comes from the same box list the sim collides against, so the stage
 * is never a lie. Everything static is merged into a handful of draw calls —
 * a phone GPU cares far more about batch count than triangle count.
 *
 * ---------------------------------------------------------------------------
 * VALUE STRUCTURE — read this before changing any colour in here.
 *
 * The arena is composed in three values plus one accent, and every decision
 * below serves that composition:
 *
 *   WHITE   the deck. Bright, dielectric, unlit-by-emissive. It is the largest
 *           surface on screen and the ground every robot is read against.
 *   BLACK   the boundary wall, the gallery and the roof structure. Near-black
 *           albedo, barely lit, deliberately starved of fill. This is the frame
 *           the bright deck sits inside.
 *   MID     obstacles and architecture — struck between the two, with a hard
 *           value break between their lit top planes and their dark side planes
 *           so they read as solid objects rather than as flat decals.
 *   WARM    hazard paint, gate lights and service lamps. A single warm note in
 *           an otherwise cool frame, kept small so it stays hot.
 *
 * Ambient light is rationed on purpose. Every unit of hemisphere or environment
 * intensity lifts the blacks, and once the blacks are gone no amount of key
 * light will put contrast back.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import {
  floorTexture, wallTexture, structureTexture, galleryTexture,
  screenTexture, hazardTexture, sprites,
} from './textures.js';
import { pbr, ensureAOChannel, makeSkyMaterial, bakeEnvironment, additive } from './materials.js';
import { Noise } from './noise.js';

/**
 * Per-kind albedo tint. The dais is an extension of the deck and stays bright;
 * everything you can hide behind trends darker, because a block's job is to
 * read as a silhouette and a bright block on a bright floor reads as nothing.
 */
const KIND_TINT = {
  dais: 1.0,
  block: 0.82,
  pillar: 0.66,
  rail: 0.88,
  wallblock: 0.6,
};

/** Structure plating tiles once per this many metres, on every surface. */
const STRUCT_TILE = 2.0;
/** Wall elevation tiles once per this many metres of run (two bays). */
const WALL_BAY = 8.4;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Re-derive box UVs from local face coordinates instead of BoxGeometry's flat
 * 0..1 per face. Without this a 12 m dais and a 1 m rail get the same number of
 * texture repeats, so the dais looks like a smooth slab and the rail looks like
 * a stack of pancakes — which is exactly what the review caught.
 */
function boxFaceUV(g, scale = STRUCT_TILE) {
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    // BoxGeometry emits +X, -X, +Y, -Y, +Z, -Z, four vertices each.
    const face = (i / 4) | 0;
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (face < 2) { u = z; v = y; }
    else if (face < 4) { u = x; v = z; }
    else { u = x; v = y; }
    uv.setXY(i, u / scale, v / scale);
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * Per-face vertex tint on a box: bright top plane, dark side planes, black
 * underside, plus a gradient that darkens the sides toward the deck so the form
 * sits INTO the floor instead of hovering over it. Light-top / dark-side is the
 * oldest trick in prop painting and it is what turns a greybox into an object.
 */
function boxFaceTint(g, hy, tint, { top = 1.9, side = 0.62, under = 0.2 } = {}) {
  const pos = g.attributes.position;
  const c = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const face = (i / 4) | 0;
    let t;
    if (face === 2) t = top;
    else if (face === 3) t = under;
    else {
      const k = (pos.getY(i) + hy) / Math.max(1e-4, hy * 2);   // 0 base .. 1 top
      t = side * (0.42 + 0.58 * k);
    }
    t *= tint;
    c[i * 3] = t; c[i * 3 + 1] = t; c[i * 3 + 2] = t;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Flat tint so a geometry can be merged into a vertex-coloured batch. */
function flatTint(g, r, gr = r, b = r) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gr; c[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Closed rectangular loop of 5 points (last repeats the first) at height y. */
function rectLoop(hx, hz, y, cx = 0, cz = 0, yaw = 0) {
  const co = Math.cos(yaw), si = Math.sin(yaw);
  const pt = (x, z) => new THREE.Vector3(cx + co * x - si * z, y, cz + si * x + co * z);
  return [pt(-hx, -hz), pt(hx, -hz), pt(hx, hz), pt(-hx, hz), pt(-hx, -hz)];
}

/**
 * Bridge two closed loops with a quad strip. One helper builds the gallery
 * rake, the jumbotron band, the cornice, the roof gantry and every hazard
 * skirt in the arena — they are all "a ring that goes from here to there".
 *
 * u runs along the perimeter in metres / uScale, v goes 0 (loop A) to 1 (B),
 * so texel density stays honest no matter how big the ring is.
 */
function ringStrip(a, b, uScale = 1, vScale = 1) {
  const segs = a.length - 1;
  const pos = new Float32Array((segs + 1) * 2 * 3);
  const uv = new Float32Array((segs + 1) * 2 * 2);
  const idx = [];

  let run = 0;
  for (let i = 0; i <= segs; i++) {
    if (i > 0) run += a[i].distanceTo(a[i - 1]);
    const u = run / uScale;
    const o = i * 2;
    pos[o * 3] = a[i].x; pos[o * 3 + 1] = a[i].y; pos[o * 3 + 2] = a[i].z;
    pos[(o + 1) * 3] = b[i].x; pos[(o + 1) * 3 + 1] = b[i].y; pos[(o + 1) * 3 + 2] = b[i].z;
    uv[o * 2] = u; uv[o * 2 + 1] = 0;
    uv[(o + 1) * 2] = u; uv[(o + 1) * 2 + 1] = vScale;
    if (i < segs) {
      const v0 = o, v1 = o + 1, v2 = o + 2, v3 = o + 3;
      idx.push(v0, v2, v1, v1, v2, v3);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A textured box in world space, ready to merge. */
function slab(w, h, d, x, y, z, yaw = 0, uvScale = STRUCT_TILE) {
  const g = new THREE.BoxGeometry(w, h, d);
  boxFaceUV(g, uvScale);
  if (yaw) g.rotateY(yaw);
  g.translate(x, y, z);
  return g;
}

export class Stage {
  constructor(renderer, arena, settings) {
    const t0 = performance.now();
    this.arena = arena;
    this.theme = arena.theme;
    this.settings = settings;
    this.group = new THREE.Group();
    this.group.name = 'stage';
    this.time = 0;

    // Wall goes chest-high on the bowl, not all the way to the sim ceiling.
    // The sim still clamps flight at bounds.ceil; visually, stopping the solid
    // wall low is what lets the galleries, the screen ring and the roof gantry
    // be visible at all — and those are the only things in frame that tell you
    // how big a robot is.
    const b = arena.bounds;
    this.wallH = Math.min(b.ceil * 0.55, 7.0);

    this.envMap = bakeEnvironment(renderer, this.theme, settings.envSize);
    // Ambient is rationed: this is the single biggest lever on whether the
    // frame has blacks in it.
    this.environmentIntensity = 0.3;
    this.fog = new THREE.FogExp2(this.theme.fog, this.theme.fogDensity);

    // Batches that several builders contribute to, merged once at the end.
    this._struct = [];      // dark architecture, structureTexture
    this._practicals = [];  // additive vertex-coloured glows
    this._hazard = [];      // warm painted chevrons
    this._decals = [];      // contact darkening on the deck

    // Every texture in here is baked on the CPU during the loading screen, so
    // the build cost is a real part of time-to-first-frame on a phone and has
    // to be measurable rather than assumed. One performance.now() per phase is
    // free; guessing at a multi-second hitch nobody can see in a screenshot is
    // not.
    const profile = this.buildProfile = { env: 0 };
    profile.env = Math.round(performance.now() - t0);
    const step = (name, fn) => {
      const t = performance.now();
      fn();
      profile[name] = Math.round(performance.now() - t);
    };

    step('sky', () => this._buildSky());
    step('floor', () => this._buildFloor());
    step('walls', () => this._buildWalls());
    step('arch', () => this._buildArchitecture());
    step('boxes', () => this._buildBoxes());
    step('flush', () => this._flushBatches());
    step('lights', () => this._buildLights());
    step('atmos', () => this._buildAtmosphere());
    profile.total = Math.round(performance.now() - t0);
  }

  // -------------------------------------------------------------------------

  _buildSky() {
    this.skyMat = makeSkyMaterial(this.theme);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 20), this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    this.sky = sky;
    this.group.add(sky);
  }

  _buildFloor() {
    const b = this.arena.bounds;
    const tex = floorTexture(this.theme, this.settings.envSize >= 256 ? 1024 : 512);
    for (const t of Object.values(tex)) {
      if (t?.isTexture) {
        t.repeat.set(b.hx / 8, b.hz / 8);   // ~2m panels — readable at range
        t.anisotropy = this.settings.anisotropy;
      }
    }
    this.floorTex = tex;

    const geo = new THREE.PlaneGeometry(b.hx * 2, b.hz * 2, 1, 1);
    geo.rotateX(-Math.PI / 2);
    ensureAOChannel(geo);

    // The deck carries almost no emissive now. It is bright because it is a
    // pale dielectric surface taking a strong key light, which is how a real
    // floor is bright — an emissive floor just becomes a light box and eats
    // every shadow that lands on it.
    const mat = pbr(tex, {
      emissive: 0xffffff,
      emissiveIntensity: 0.85,
      envMapIntensity: this.settings.reflections ? 0.34 : 0.22,
      normalScale: 1.0,
    });
    mat.envMap = this.envMap;
    this.floorMat = mat;

    const floor = new THREE.Mesh(geo, mat);
    floor.receiveShadow = this.settings.shadows;
    floor.name = 'floor';
    this.group.add(floor);
  }

  _buildWalls() {
    const b = this.arena.bounds;
    const h = this.wallH;
    const tex = wallTexture(this.theme, this.settings.envSize >= 256 ? 512 : 256);
    for (const t of Object.values(tex)) {
      if (t?.isTexture) {
        t.repeat.set(1, 1);              // per-plane UVs carry the tiling now
        t.anisotropy = this.settings.anisotropy;
      }
    }
    this.wallTex = tex;

    const mat = pbr(tex, {
      emissive: 0xffffff,
      emissiveIntensity: 1.15,
      envMapIntensity: 0.18,
      normalScale: 1.2,
      side: THREE.DoubleSide,
    });
    mat.envMap = this.envMap;
    this.wallMat = mat;

    const parts = [];
    const mk = (w, x, z, ry) => {
      const g = new THREE.PlaneGeometry(w, h, 1, 1);
      // Bake the horizontal tiling into UVs so a 35 m wall and a 29 m wall get
      // the same bay width instead of the same number of stretched bays.
      const bays = Math.max(2, Math.round(w / WALL_BAY));
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * bays);
      g.rotateY(ry);
      g.translate(x, h / 2, z);
      return g;
    };
    parts.push(mk(b.hx * 2, 0, -b.hz, 0));
    parts.push(mk(b.hx * 2, 0, b.hz, Math.PI));
    parts.push(mk(b.hz * 2, -b.hx, 0, Math.PI / 2));
    parts.push(mk(b.hz * 2, b.hx, 0, -Math.PI / 2));

    const merged = mergeGeometries(parts);
    ensureAOChannel(merged);
    const walls = new THREE.Mesh(merged, mat);
    walls.receiveShadow = this.settings.shadows;
    walls.name = 'walls';
    this.group.add(walls);

    // Thin glowing kerb where wall meets floor — reads the play area edge
    // instantly, which matters when you're airborne and hunting for the ground.
    // It is deliberately slim: a bright deck already contrasts hard against a
    // near-black wall, so this is a highlight, not a light source.
    const sh = 0.16;
    const strip = ringStrip(
      rectLoop(b.hx - 0.05, b.hz - 0.05, 0.03),
      rectLoop(b.hx - 0.05, b.hz - 0.05, 0.03 + sh),
      1
    );
    this._practicals.push(flatTint(strip, 0.5, 0.62, 0.72));
  }

  // -------------------------------------------------------------------------
  // Architecture — the reason the arena reads as a built place with a size
  // -------------------------------------------------------------------------

  _buildArchitecture() {
    const b = this.arena.bounds;
    const h = this.wallH;
    const t = this.theme;

    // --- Cornice: a heavy capping beam running the full perimeter. ----------
    // Every storey boundary in real architecture is marked; this one also
    // gives the near-black upper structure a bright edge to be read against.
    const corniceH = 0.55;
    const outHx = b.hx + 0.8, outHz = b.hz + 0.8;
    this._struct.push(flatTint(ringStrip(
      rectLoop(b.hx, b.hz, h), rectLoop(outHx, outHz, h), STRUCT_TILE
    ), 1.5));                                     // lit top plane of the beam
    this._struct.push(flatTint(ringStrip(
      rectLoop(outHx, outHz, h), rectLoop(outHx, outHz, h - corniceH), STRUCT_TILE
    ), 0.5));
    this._struct.push(flatTint(ringStrip(
      rectLoop(outHx, outHz, h - corniceH), rectLoop(b.hx + 0.25, b.hz + 0.25, h - corniceH - 0.35), STRUCT_TILE
    ), 0.28));                                    // shadowed soffit under the beam

    // --- Spectator galleries ------------------------------------------------
    // A raked bank of seats is the single best scale reference available: the
    // viewer knows how big a seat is, therefore knows how big the robot is.
    // The bank is almost black on purpose — it frames the lit deck.
    const galleryOn = t.crowd && this.settings.crowd;
    const rakeRun = 9.0, rakeRise = 6.4;
    const gy = h + 0.15;
    if (galleryOn) {
      const gtex = galleryTexture(t, this.settings.envSize >= 256 ? 512 : 256);
      for (const tx of Object.values(gtex)) {
        if (tx?.isTexture) tx.anisotropy = this.settings.anisotropy;
      }
      const gmat = pbr(gtex, {
        emissive: 0xffffff,
        emissiveIntensity: 2.2,      // all the information is in the crowd lights
        envMapIntensity: 0.1,
        normalScale: 1.0,
        side: THREE.DoubleSide,
      });
      gmat.envMap = this.envMap;
      this.galleryMat = gmat;

      const rake = ringStrip(
        rectLoop(outHx, outHz, gy),
        rectLoop(outHx + rakeRun, outHz + rakeRun, gy + rakeRise),
        6.0, 1
      );
      ensureAOChannel(rake);
      const bank = new THREE.Mesh(rake, gmat);
      bank.name = 'gallery';
      this.group.add(bank);
      this.gallery = bank;
    }

    // --- Jumbotron ring -----------------------------------------------------
    // A band of screens above the crowd. Emissive, so it survives being nearly
    // the only thing lit up there, and it puts the league's own colour high in
    // frame where nothing else is competing for it.
    const screenBase = gy + rakeRise + 0.4;
    const screenH = 2.6;
    const sHx = outHx + rakeRun, sHz = outHz + rakeRun;
    if (t.screens && this.settings.crowd) {
      const stex = screenTexture(t, this.settings.envSize >= 256 ? 512 : 256);
      const smat = pbr(stex, {
        emissive: 0xffffff,
        emissiveIntensity: 2.4,
        envMapIntensity: 0.06,
        side: THREE.DoubleSide,
      });
      smat.envMap = this.envMap;
      this.screenMat = smat;

      const band = ringStrip(
        rectLoop(sHx, sHz, screenBase),
        rectLoop(sHx, sHz, screenBase + screenH),
        screenH * 4, 1
      );
      ensureAOChannel(band);
      const screens = new THREE.Mesh(band, smat);
      screens.name = 'screens';
      this.group.add(screens);
      this.screens = screens;

      // Frame the band top and bottom so it reads as installed hardware.
      this._struct.push(flatTint(ringStrip(
        rectLoop(sHx + 0.3, sHz + 0.3, screenBase - 0.35),
        rectLoop(sHx + 0.3, sHz + 0.3, screenBase), STRUCT_TILE
      ), 0.4));
      this._struct.push(flatTint(ringStrip(
        rectLoop(sHx + 0.3, sHz + 0.3, screenBase + screenH),
        rectLoop(sHx + 0.3, sHz + 0.3, screenBase + screenH + 0.5), STRUCT_TILE
      ), 0.6));
    }

    // --- Corner pylons ------------------------------------------------------
    // Four towers anchoring the bowl. They read as a vertical measure and stop
    // the arena dissolving into open sky at the corners.
    const pyTop = screenBase + screenH + 5.5;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = sx * (sHx + 1.4), pz = sz * (sHz + 1.4);
        this._struct.push(flatTint(slab(2.6, pyTop, 2.6, px, pyTop / 2, pz), 0.5));
        this._struct.push(flatTint(slab(3.4, 0.9, 3.4, px, pyTop - 0.45, pz), 1.2));
        // Warm beacon at the head of every pylon: four small hot points at the
        // extremes of the composition, which is all the warmth a wide shot
        // needs to stop being monochrome.
        const beacon = new THREE.BoxGeometry(1.1, 0.5, 1.1);
        beacon.translate(px, pyTop + 0.3, pz);
        this._practicals.push(flatTint(beacon, 1.0, 0.52, 0.14));
      }
    }

    // --- Roof gantry --------------------------------------------------------
    // A lighting truss cantilevered inward over the crowd, with lamp housings
    // aimed at the deck. Kept off the centre of the arena so it never occludes
    // the fight, but it puts hard structure into the top of the frame.
    if (this.settings.lights >= 4) {
      const ry = pyTop - 1.6;
      const inHx = b.hx + 3.0, inHz = b.hz + 3.0;
      this._struct.push(flatTint(ringStrip(
        rectLoop(inHx, inHz, ry), rectLoop(sHx, sHz, ry + 1.1), STRUCT_TILE
      ), 0.34));
      this._struct.push(flatTint(ringStrip(
        rectLoop(inHx, inHz, ry - 0.7), rectLoop(inHx, inHz, ry), STRUCT_TILE
      ), 0.9));

      // Lamp housings on the inner edge, alternating cool key and warm fill.
      const lampsPerSide = 5;
      const acc = new THREE.Color(t.emissive);
      const warm = new THREE.Color(t.hazard ?? 0xffb01f);
      let li = 0;
      for (const [ax, az, len] of [[1, 0, inHx], [0, 1, inHz], [-1, 0, inHx], [0, -1, inHz]]) {
        const spanHalf = ax ? inHz : inHx;
        for (let i = 0; i < lampsPerSide; i++) {
          const f = (i + 0.5) / lampsPerSide * 2 - 1;
          const x = ax ? ax * len : f * spanHalf;
          const z = az ? az * len : f * spanHalf;
          this._struct.push(flatTint(slab(0.9, 0.7, 0.9, x, ry - 1.0, z), 0.55));
          const lens = new THREE.BoxGeometry(0.62, 0.1, 0.62);
          lens.translate(x, ry - 1.36, z);
          const c = (li++ % 3 === 0) ? warm : acc;
          this._practicals.push(flatTint(lens, c.r * 1.5, c.g * 1.5, c.b * 1.5));
        }
      }
    }

    // --- Entry gates --------------------------------------------------------
    if (t.gates !== false) this._buildGates();
  }

  /**
   * Recessed portals in the wall behind each spawn. They give the arena an
   * inside and an outside — you came in from somewhere — and their warm throat
   * light is the one place a hot colour spills onto the deck.
   */
  _buildGates() {
    const b = this.arena.bounds;
    const warm = new THREE.Color(this.theme.hazard ?? 0xffb01f);
    this.gateLights = [];

    for (const sp of this.arena.spawns) {
      // Push out to whichever wall the spawn is closest to.
      const toX = b.hx - Math.abs(sp.x);
      const toZ = b.hz - Math.abs(sp.z);
      const onX = toX < toZ;
      const yaw = onX
        ? (sp.x > 0 ? -Math.PI / 2 : Math.PI / 2)
        : (sp.z > 0 ? Math.PI : 0);
      const gx = onX ? Math.sign(sp.x) * b.hx : Math.max(-b.hx + 4, Math.min(b.hx - 4, sp.x));
      const gz = onX ? Math.max(-b.hz + 4, Math.min(b.hz - 4, sp.z)) : Math.sign(sp.z) * b.hz;

      const co = Math.cos(yaw), si = Math.sin(yaw);
      // Local frame: +Z points into the arena from the gate.
      const put = (lx, ly, lz) => [gx + co * lx + si * lz, ly, gz - si * lx + co * lz];

      const W = 5.0, H = 4.2, D = 1.6;

      // Recess: a dark box sunk into the wall. Near-black so the lit jambs read.
      const back = new THREE.BoxGeometry(W, H, 0.3);
      boxFaceUV(back, STRUCT_TILE);
      back.rotateY(yaw);
      const bp = put(0, H / 2, -D);
      back.translate(bp[0], bp[1], bp[2]);
      this._struct.push(flatTint(back, 0.12));

      // Jambs and lintel, brighter than the wall so the opening reads as framed.
      for (const s of [-1, 1]) {
        const p = put(s * (W / 2 + 0.45), H / 2, -D / 2);
        this._struct.push(flatTint(slab(0.9, H, D + 0.6, p[0], p[1], p[2], yaw), 1.15));
      }
      const lp = put(0, H + 0.5, -D / 2);
      this._struct.push(flatTint(slab(W + 1.8, 1.0, D + 0.6, lp[0], lp[1], lp[2], yaw), 1.35));

      // Warm throat: a glow panel deep in the recess plus a threshold strip on
      // the deck. Small, saturated, and the only thing in the arena that looks
      // like it is at a different temperature.
      const glow = new THREE.PlaneGeometry(W - 0.4, H - 0.5);
      glow.rotateY(yaw);
      const gp = put(0, H / 2, -D + 0.18);
      glow.translate(gp[0], gp[1], gp[2]);
      this._practicals.push(flatTint(glow, warm.r * 0.85, warm.g * 0.5, warm.b * 0.16));

      // Hazard chevrons painted across the threshold — warm paint on the white
      // deck, at exactly the spot the player's robot stands at round start.
      const th = new THREE.PlaneGeometry(W + 1.4, 2.4);
      th.rotateX(-Math.PI / 2);
      th.rotateY(yaw);
      const tp = put(0, 0.012, 1.0);
      th.translate(tp[0], tp[1], tp[2]);
      const uv = th.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i));
      this._hazard.push(th);

      if (this.settings.lights >= 4) {
        const p = put(0, 2.2, 0.6);
        const l = new THREE.PointLight(warm, 26, 16, 2.0);
        l.position.set(p[0], p[1], p[2]);
        this.group.add(l);
        this.gateLights.push(l);
      }
    }
  }

  // -------------------------------------------------------------------------

  _buildBoxes() {
    const solids = [];
    const rims = [];
    const emis = new THREE.Color(this.theme.emissive);

    for (const b of this.arena.boxes) {
      const g = new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2, 1, 1, 1);
      boxFaceUV(g, STRUCT_TILE);

      // Chamfer the silhouette by pulling the top face in slightly — box edges
      // are the fastest way to look cheap.
      const pos = g.attributes.position;
      const inset = Math.min(0.12, Math.min(b.hx, b.hz) * 0.18);
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) > 0) {
          pos.setX(i, pos.getX(i) * (1 - inset / Math.max(0.2, b.hx)));
          pos.setZ(i, pos.getZ(i) * (1 - inset / Math.max(0.2, b.hz)));
        }
      }
      g.computeVertexNormals();
      boxFaceTint(g, b.hy, KIND_TINT[b.kind] ?? 1);
      g.rotateY(b.yaw || 0);
      g.translate(b.x, b.y, b.z);
      solids.push(g);

      // A raised cap plate inset from the edge. Two planes at different heights
      // is what produces a real bevel highlight instead of a painted-on line.
      const capX = Math.max(0.12, b.hx - inset - 0.22);
      const capZ = Math.max(0.12, b.hz - inset - 0.22);
      const cap = new THREE.BoxGeometry(capX * 2, 0.09, capZ * 2);
      boxFaceUV(cap, STRUCT_TILE);
      boxFaceTint(cap, 0.045, (KIND_TINT[b.kind] ?? 1) * 1.12, { top: 1.9, side: 0.35, under: 0.2 });
      cap.rotateY(b.yaw || 0);
      cap.translate(b.x, b.top + 0.03, b.z);
      solids.push(cap);

      // Emissive trim, as an actual RING around the cap. The old version was a
      // filled additive box covering the entire top face, which flattened every
      // block into one pale slab and is the direct cause of the greybox read.
      const ri = rectLoop(capX + 0.16, capZ + 0.16, b.top + 0.075, b.x, b.z, b.yaw || 0);
      const ro = rectLoop(capX + 0.26, capZ + 0.26, b.top + 0.075, b.x, b.z, b.yaw || 0);
      rims.push(flatTint(ringStrip(ri, ro, 1), emis.r * 0.85, emis.g * 0.85, emis.b * 0.85));

      // Hazard skirt: a painted warning band wrapped round the base of every
      // obstacle. Warm, low, and it anchors the block to the deck.
      const skirtH = Math.min(0.34, b.hy * 0.5);
      const sk = ringStrip(
        rectLoop(b.hx + 0.012, b.hz + 0.012, b.bottom + 0.005, b.x, b.z, b.yaw || 0),
        rectLoop(b.hx + 0.012, b.hz + 0.012, b.bottom + skirtH, b.x, b.z, b.yaw || 0),
        0.9, 1
      );
      this._hazard.push(sk);

      // Contact darkening on the deck. Even with shadow maps on, a block needs
      // an ambient occlusion pool to stop reading as a decal — and at LOW tier
      // this is the only shadow there is.
      const pad = 0.55;
      const dec = new THREE.PlaneGeometry((b.hx + pad) * 2.15, (b.hz + pad) * 2.15);
      dec.rotateX(-Math.PI / 2);
      dec.rotateY(b.yaw || 0);
      dec.translate(b.x, 0.016, b.z);
      this._decals.push(dec);
    }

    if (solids.length) {
      const stex = structureTexture(this.theme, this.settings.envSize >= 256 ? 512 : 256);
      for (const t of Object.values(stex)) {
        if (t?.isTexture) t.anisotropy = this.settings.anisotropy;
      }
      this.structTex = stex;

      const merged = mergeGeometries(solids);
      ensureAOChannel(merged);
      const mat = pbr(stex, {
        emissive: 0xffffff,
        emissiveIntensity: 1.4,
        envMapIntensity: 0.22,
        normalScale: 1.35,
      });
      mat.envMap = this.envMap;
      mat.vertexColors = true;
      this.boxMat = mat;

      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = this.settings.shadows;
      mesh.receiveShadow = this.settings.shadows;
      mesh.name = 'obstacles';
      this.group.add(mesh);
      this.obstacles = mesh;
    }

    this._practicals.push(...rims);
  }

  /**
   * Merge everything the builders queued. Four extra draw calls buys the whole
   * architecture, every practical light, all the hazard paint and the contact
   * shadows — which is the trade a phone GPU wants.
   */
  _flushBatches() {
    if (!this.structTex) {
      this.structTex = structureTexture(this.theme, this.settings.envSize >= 256 ? 512 : 256);
    }

    if (this._struct.length) {
      const mat = pbr(this.structTex, {
        emissive: 0xffffff,
        emissiveIntensity: 1.2,
        envMapIntensity: 0.16,
        normalScale: 1.1,
        side: THREE.DoubleSide,
      });
      mat.envMap = this.envMap;
      mat.vertexColors = true;
      this.structMat = mat;

      const g = mergeGeometries(this._struct);
      ensureAOChannel(g);
      const m = new THREE.Mesh(g, mat);
      // Architecture never casts: a gantry throwing shadow bars across the deck
      // would fight the fight for attention and cost a second shadow pass.
      m.receiveShadow = this.settings.shadows;
      m.name = 'architecture';
      this.group.add(m);
      this.architecture = m;
    }

    if (this._hazard.length) {
      const htex = hazardTexture(this.theme, 128);
      for (const t of Object.values(htex)) {
        if (t?.isTexture) t.anisotropy = this.settings.anisotropy;
      }
      const mat = pbr(htex, {
        emissive: 0x000000,
        emissiveIntensity: 0,
        envMapIntensity: 0.12,
        normalScale: 0.9,
        side: THREE.DoubleSide,
      });
      mat.envMap = this.envMap;
      const g = mergeGeometries(this._hazard);
      ensureAOChannel(g);
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = this.settings.shadows;
      m.name = 'hazard';
      this.group.add(m);
      this.hazardMesh = m;
      this.hazardMat = mat;
    }

    if (this._practicals.length) {
      const mat = additive(0xffffff, { opacity: 1, vertexColors: true, side: THREE.DoubleSide });
      const m = new THREE.Mesh(mergeGeometries(this._practicals), mat);
      m.name = 'practicals';
      m.renderOrder = 4;
      this.group.add(m);
      this.practicals = m;
      this.practicalMat = mat;
    }

    if (this._decals.length) {
      const sp = sprites();
      const mat = new THREE.MeshBasicMaterial({
        map: sp.shadow,
        color: 0x000000,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      });
      const m = new THREE.Mesh(mergeGeometries(this._decals), mat);
      m.name = 'contact';
      m.renderOrder = 3;
      this.group.add(m);
      this.contact = m;
    }

    this._struct = this._practicals = this._hazard = this._decals = null;
  }

  _buildLights() {
    const t = this.theme;
    this.lights = {};

    const key = new THREE.DirectionalLight(t.sunColour, t.sunIntensity);
    key.position.set(t.sunDir[0] * 30, t.sunDir[1] * 34, t.sunDir[2] * 30);
    key.target.position.set(0, 0, 0);
    if (this.settings.shadows) {
      key.castShadow = true;
      const s = this.settings.shadowMapSize;
      key.shadow.mapSize.set(s, s);
      const b = this.arena.bounds;
      const ext = Math.max(b.hx, b.hz) * 1.15;
      key.shadow.camera.left = -ext;
      key.shadow.camera.right = ext;
      key.shadow.camera.top = ext;
      key.shadow.camera.bottom = -ext;
      key.shadow.camera.near = 1;
      key.shadow.camera.far = 90;
      key.shadow.bias = -0.0006;
      key.shadow.normalBias = 0.022;
      // Tight penumbra. A soft shadow on a dark floor is invisible; a crisp
      // shadow on a bright deck is the contact cue the whole scene was missing.
      key.shadow.radius = 1.2;
      key.shadow.intensity = 1.0;
    }
    this.group.add(key, key.target);
    this.lights.key = key;

    // Fill is deliberately weak. Its job is to keep shadowed metal legible, not
    // to make the shadow side match the lit side — the moment those two are
    // close, the frame has no value structure left.
    const fill = new THREE.DirectionalLight(t.rimColour, t.sunIntensity * 0.17);
    fill.position.set(-t.sunDir[0] * 24, 12, -t.sunDir[2] * 24);
    this.group.add(fill);
    this.lights.fill = fill;

    // Warm bounce off the deck. Grazing, low, and warm regardless of how cool
    // the arena is, so undersides and shadow planes pick up a hot edge instead
    // of going the same blue as everything else.
    const bounce = new THREE.DirectionalLight(t.hazard ?? 0xffb01f, t.sunIntensity * 0.1);
    bounce.position.set(-t.sunDir[0] * 10, -6, -t.sunDir[2] * 10);
    this.group.add(bounce);
    this.lights.bounce = bounce;

    // Sky/ground ambient, kept low: this is the term that lifts blacks.
    const hemi = new THREE.HemisphereLight(t.skyTop, t.wall, 0.4);
    this.group.add(hemi);
    this.lights.hemi = hemi;

    // Rig practicals give the robos moving specular highlights.
    if (this.settings.lights >= 4) {
      const b = this.arena.bounds;
      this.rigLights = [];
      for (let i = 0; i < 2; i++) {
        const l = new THREE.PointLight(t.accent, 55, b.hx * 2.4, 2.0);
        l.position.set(i === 0 ? -b.hx * 0.55 : b.hx * 0.55, this.wallH * 1.1, 0);
        this.group.add(l);
        this.rigLights.push(l);
      }
    }
  }

  _buildAtmosphere() {
    const b = this.arena.bounds;
    const sp = sprites();
    const n = new Noise(0xa7);

    // Floating dust motes: cheap parallax that sells depth and scale. Held very
    // low in opacity — over a bright deck they are invisible anyway, and over
    // the dark bowl they are all that is needed.
    const count = this.settings.particleBudget >= 600 ? 380 : 160;
    const pos = new Float32Array(count * 3);
    const scale = new Float32Array(count);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (n.simplex2(i * 0.71, 3.1)) * b.hx;
      pos[i * 3 + 1] = (n.simplex2(i * 0.37, 7.7) * 0.5 + 0.5) * b.ceil * 0.85 + 0.4;
      pos[i * 3 + 2] = (n.simplex2(i * 0.53, 11.3)) * b.hz;
      scale[i] = 0.05 + Math.abs(n.simplex2(i * 1.7, 2.2)) * 0.11;
      phase[i] = n.simplex2(i * 2.3, 5.5) * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: sp.glow },
        uColor: { value: new THREE.Color(this.theme.accent) },
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uCeil: { value: b.ceil },
      },
      vertexShader: /* glsl */`
        attribute float aScale;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uCeil;
        varying float vFade;
        void main() {
          vec3 p = position;
          // Slow convective drift, wrapping at the ceiling.
          p.y = mod(p.y + uTime * 0.22 + aPhase, uCeil * 0.85) + 0.4;
          p.x += sin(uTime * 0.35 + aPhase) * 0.5;
          p.z += cos(uTime * 0.28 + aPhase * 1.7) * 0.5;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aScale * 620.0 * uPixelRatio / max(1.0, -mv.z);
          vFade = smoothstep(0.0, 6.0, -mv.z) * (1.0 - smoothstep(28.0, 60.0, -mv.z));
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(uColor * t.rgb, t.a * vFade * 0.09);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const motes = new THREE.Points(geo, mat);
    motes.frustumCulled = false;
    motes.name = 'motes';
    this.group.add(motes);
    this.motes = motes;
    this.moteMat = mat;

    // Volumetric-ish light shafts hanging off the rig. Merged into one mesh and
    // held at a whisper of opacity: additive haze over the whole frame is
    // precisely how the arena turned into grey milk last time.
    if (this.settings.lights >= 6) {
      const parts = [];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        const g = new THREE.CylinderGeometry(0.22, 2.4, this.wallH * 1.4, 10, 1, true);
        g.rotateZ(Math.cos(a) * 0.16);
        g.rotateX(Math.sin(a) * 0.16);
        g.translate(Math.cos(a) * b.hx * 0.62, this.wallH * 0.9, Math.sin(a) * b.hz * 0.62);
        parts.push(g);
      }
      const shafts = new THREE.Mesh(
        mergeGeometries(parts),
        additive(this.theme.accent, { opacity: 0.014, side: THREE.DoubleSide, depthTest: true })
      );
      shafts.name = 'shafts';
      this.group.add(shafts);
      this.shafts = shafts;
    }

    // Sweeping floor bands.
    if (this.theme.sweep) {
      const g = new THREE.PlaneGeometry(b.hx * 2, b.hz * 2);
      g.rotateX(-Math.PI / 2);
      this.sweepMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(this.theme.floorAccent) },
          uTime: { value: 0 },
          uExtent: { value: new THREE.Vector2(b.hx, b.hz) },
        },
        vertexShader: /* glsl */`
          varying vec2 vP;
          void main() {
            vP = position.xz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uColor;
          uniform float uTime;
          uniform vec2 uExtent;
          varying vec2 vP;
          void main() {
            float d = length(vP) / max(uExtent.x, uExtent.y);
            float band = sin(d * 9.0 - uTime * 1.3);
            band = smoothstep(0.965, 1.0, band);
            // Fade the sweep OUT of the centre: the middle of the deck is where
            // the fight happens and it needs to stay a clean bright value.
            float fade = smoothstep(0.3, 0.8, d) * (1.0 - smoothstep(0.85, 1.05, d));
            gl_FragColor = vec4(uColor * band * 0.4 * fade, band * fade * 0.22);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const sweep = new THREE.Mesh(g, this.sweepMat);
      sweep.position.y = 0.012;
      sweep.renderOrder = 2;
      this.group.add(sweep);
      this.sweep = sweep;
    }
  }

  // -------------------------------------------------------------------------

  update(dt, time, ctx) {
    this.time = time;
    this.skyMat.uniforms.uTime.value = time;
    if (this.moteMat) {
      this.moteMat.uniforms.uTime.value = time;
      this.moteMat.uniforms.uPixelRatio.value = ctx?.pixelRatio ?? 1;
    }
    if (this.sweepMat) this.sweepMat.uniforms.uTime.value = time;

    if (this.sky && ctx?.cameraPos) this.sky.position.copy(ctx.cameraPos);

    // Rig lights orbit slowly so highlights crawl across the armour.
    if (this.rigLights) {
      const b = this.arena.bounds;
      for (let i = 0; i < this.rigLights.length; i++) {
        const a = time * 0.14 + i * Math.PI;
        this.rigLights[i].position.set(
          Math.cos(a) * b.hx * 0.6,
          this.wallH * (1.05 + Math.sin(time * 0.3 + i) * 0.06),
          Math.sin(a) * b.hz * 0.6
        );
      }
    }

    // Keep the shadow frustum tight around the action instead of the whole map.
    const key = this.lights.key;
    if (key?.castShadow && ctx?.focus) {
      key.target.position.set(ctx.focus.x, 0, ctx.focus.z);
      key.position.set(
        ctx.focus.x + this.theme.sunDir[0] * 30,
        this.theme.sunDir[1] * 34,
        ctx.focus.z + this.theme.sunDir[2] * 30
      );
      key.target.updateMatrixWorld();
    }
  }

  setQuality(settings) {
    this.settings = settings;
    if (this.lights.key) {
      this.lights.key.castShadow = settings.shadows;
      if (settings.shadows) this.lights.key.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    }
    if (this.obstacles) {
      this.obstacles.castShadow = settings.shadows;
      this.obstacles.receiveShadow = settings.shadows;
    }
    if (this.shafts) this.shafts.visible = settings.lights >= 6;
    if (this.gallery) this.gallery.visible = settings.crowd;
    if (this.screens) this.screens.visible = settings.crowd;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
    this.envMap?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Minimal geometry merge — avoids pulling in the BufferGeometryUtils example
// module and only handles what this file produces (non-indexed or indexed
// triangle lists sharing an attribute set).
// ---------------------------------------------------------------------------

export function mergeGeometries(geometries) {
  if (geometries.length === 1) return geometries[0];

  const names = new Set();
  for (const g of geometries) for (const k of Object.keys(g.attributes)) names.add(k);

  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geometries) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const proto = geometries.find((g) => g.attributes[name])?.attributes[name];
    if (!proto) continue;
    const itemSize = proto.itemSize;
    const array = new Float32Array(vertexCount * itemSize);
    let offset = 0;
    for (const g of geometries) {
      const attr = g.attributes[name];
      const count = g.attributes.position.count;
      if (attr) {
        array.set(attr.array.subarray(0, count * itemSize), offset);
      } else if (name === 'color') {
        // A geometry with no colour in a vertex-coloured batch must default to
        // white, not to black — silently multiplying a whole mesh by zero is a
        // very expensive five minutes to debug.
        array.fill(1, offset, offset + count * itemSize);
      }
      offset += count * itemSize;
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }

  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const index = new IndexArray(indexCount);
  let io = 0;
  let vo = 0;
  for (const g of geometries) {
    const count = g.attributes.position.count;
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) index[io++] = src[i] + vo;
    } else {
      for (let i = 0; i < count; i++) index[io++] = i + vo;
    }
    vo += count;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();

  for (const g of geometries) g.dispose();
  return out;
}
