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
  screenTexture, hazardTexture, sprites, hazPaint,
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
  block: 0.94,
  pillar: 0.82,
  rail: 0.94,
  wallblock: 0.72,
};

/** Structure plating tiles once per this many metres, on every surface. */
const STRUCT_TILE = 2.0;
/** Wall elevation tiles once per this many metres of run (two bays). */
const WALL_BAY = 8.4;

/**
 * Texture budget, in pixels, per device tier.
 *
 * Every one of these is a synchronous CPU pixel loop that runs on the loading
 * screen, so the number here is milliseconds of freeze on a phone, not a
 * quality slider. They are sized by TEXEL DENSITY, not by habit:
 *
 *   floor    one tile covers ~16 m of deck  ->  512 px = 32 texels/m
 *   wall     one tile is the full 7 m elevation, two bays wide
 *   struct   one tile covers 2 m of plating  ->  256 px = 128 texels/m, which
 *            is already generous for something you mostly see edge-on
 *   gallery  a 12x40 seat bank seen from 30 m away
 *   screen   emissive, read as shape, never as text
 *   hazard   eight diagonal stripes. It does not need 512. It never did.
 *
 * `envSize` is the tier's own resolution knob, so it doubles as the tier signal
 * rather than threading a second field through every call site.
 */
function texBudget(settings) {
  const e = settings.envSize ?? 128;
  if (e >= 256) return { floor: 512, wall: 256, struct: 256, gallery: 256, screen: 256, hazard: 64 };
  if (e >= 128) return { floor: 512, wall: 256, struct: 128, gallery: 128, screen: 128, hazard: 64 };
  return { floor: 256, wall: 128, struct: 128, gallery: 128, screen: 128, hazard: 64 };
}

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
function boxFaceTint(g, hy, tint, { top = 1.9, side = 1.15, under = 0.34 } = {}) {
  const pos = g.attributes.position;
  const c = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const face = (i / 4) | 0;
    let t;
    if (face === 2) t = top;
    else if (face === 3) t = under;
    else {
      // 0 base .. 1 top. The base is darker than the cap so the form sits INTO
      // the deck, but it is a gradient, not a cliff: at the old 0.42 floor the
      // side planes of a block measured a median of 2/255 — a shape with no
      // information in it at all, which is a hole in the frame however correct
      // the lit-top/dark-side theory behind it was. Blocks are still a full
      // stop and a half below their own cap.
      const k = (pos.getY(i) + hy) / Math.max(1e-4, hy * 2);
      t = side * (0.68 + 0.32 * k);
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

/**
 * Vertical ramp instead of a flat tint: colour `lo` at the bottom of the
 * geometry's own bounding box, `hi` at the top. Costs four vertex colours and
 * no texture, which is the only reason a gradient is affordable on a batch
 * whose whole point is to stay one draw call.
 */
function rampTint(g, lo, hi) {
  g.computeBoundingBox();
  const y0 = g.boundingBox.min.y;
  const span = Math.max(1e-4, g.boundingBox.max.y - y0);
  const pos = g.attributes.position;
  const c = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = (pos.getY(i) - y0) / span;
    for (let j = 0; j < 3; j++) c[i * 3 + j] = lo[j] + (hi[j] - lo[j]) * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/**
 * THE ADDITIVE VALUE BUDGET, and the one place it is enforced.
 *
 * Every practical in this arena is drawn into one additive, un-tone-mapped
 * batch, and the bloom prefilter thresholds on max(r, g, b) at 1.04 linear
 * (postfx.js). So a practical whose largest channel exceeds that blooms on its
 * OWN, before a single photon from behind it is added: it has stopped being a
 * light drawn on a surface and become an emitter with a halo.
 *
 * That rule has been re-derived from scratch, in a comment, three times in this
 * file — for the deck kerb, for the cap rim rings and for the gate throat — and
 * each time it was applied to exactly the one fixture under discussion. The
 * gantry lamp lenses were never in any of those discussions, and they are
 * authored at 1.5x a near-saturated hue: all twenty of them, in all three
 * arenas, clip their strongest channel by 45% and bloom by themselves, 20 m up
 * at the top of the frame. Nothing caught it because nothing was looking; there
 * was no budget, only three separate arguments about three separate numbers.
 *
 * So the budget is a property of the BATCH now. Anything pushed into
 * `_practicals` is held to it at flush time, whoever pushed it and whenever.
 *
 * The scaling is proportional across the three channels, which is the whole
 * point: hue and saturation come through untouched and only radiance moves. A
 * practical is allowed to be the most saturated thing in frame. It is not
 * allowed to be the brightest.
 */
const PRACTICAL_CEIL = 0.92;

/**
 * Hold a merged vertex-coloured additive batch to the budget above. Runs once,
 * at build, over the colour attribute — no per-frame cost and no shader.
 */
function clampAdditive(geo, ceil = PRACTICAL_CEIL) {
  const c = geo.attributes.color;
  if (!c) return geo;
  const a = c.array;
  let clamped = 0;
  for (let i = 0; i < a.length; i += 3) {
    const peak = Math.max(a[i], a[i + 1], a[i + 2]);
    if (peak <= ceil) continue;
    const s = ceil / peak;
    a[i] *= s; a[i + 1] *= s; a[i + 2] *= s;
    clamped++;
  }
  c.needsUpdate = true;
  geo.userData.practicalsClamped = clamped;
  return geo;
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
    this.tex = texBudget(settings);
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
    // not. Each phase is timed around the work itself — an `env` bucket that
    // quietly also contained "everything above it in the constructor" is how a
    // slow phase hides behind a fast one.
    const profile = this.buildProfile = {};
    const step = (name, fn) => {
      const t = performance.now();
      const r = fn();
      profile[name] = Math.round(performance.now() - t);
      return r;
    };

    this.envMap = step('env', () => bakeEnvironment(renderer, this.theme, settings.envSize));
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
    const tex = floorTexture(this.theme, this.tex.floor);
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
    //
    // `normalScale` is the busyness dial for this surface, and it is a more
    // honest one than the albedo. Under a single hard key every normal-mapped
    // groove produces a lit lip and a shadow lip, so relief is what turns a
    // quiet tonal pattern into legible line work — which is precisely the
    // finding the blind comparison returned about this deck. Halved. The
    // plating is all still there; it has stopped drawing itself in outline.
    //
    // The emissive corner nodes come down with it: they are small, cyan and
    // scattered across the entire floor, which is three separate reasons for
    // the eye to go to the ground.
    const mat = pbr(tex, {
      emissive: 0xffffff,
      emissiveIntensity: 0.5,
      envMapIntensity: this.settings.reflections ? 0.34 : 0.22,
      normalScale: 0.5,
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
    const tex = wallTexture(this.theme, this.tex.wall);
    for (const t of Object.values(tex)) {
      if (t?.isTexture) {
        t.repeat.set(1, 1);              // per-plane UVs carry the tiling now
        t.anisotropy = this.settings.anisotropy;
      }
    }
    this.wallTex = tex;

    // envMapIntensity is not "shininess" here, it is the deck's bounce.
    //
    // The baked environment is a dark sky over a lower hemisphere painted the
    // DECK's own colour, so it is a directional ambient, not a flat one: an
    // up-facing plane (the deck, a block cap) sees only the black sky and gets
    // nothing, while a vertical plane sees half deck and gets the bounce. Three
    // of the four boundary walls face away from the key and were lit by nothing
    // but a hemisphere term worth 0.03 of irradiance, which is why the top
    // third of every frame measured 90-100% below the black threshold. At 0.18
    // the arena was throwing away the light its own brightest surface makes.
    const mat = pbr(tex, {
      emissive: 0xffffff,
      emissiveIntensity: 1.15,
      envMapIntensity: 0.85,
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
    //
    // VALUE BUDGET, and this is the whole argument for the number below.
    // The practicals batch is additive and its contribution goes through the
    // same ACES curve as everything else, so a tint of 0.72 laid over a deck
    // already sitting at ~0.35 linear sums to 1.07 — which is ABOVE the bloom
    // threshold (0.04 above it, in fact). The kerb was therefore not a rim
    // light, it was an emitter: it clipped near 255, it bled a halo, and it ran
    // the full width of the composition. A blind comparison against the
    // reference put it plainly — the eye landed on a floor rail before it
    // landed on either machine. A boundary is allowed to be the most SATURATED
    // thing in frame; it is not allowed to be the brightest. Held under the
    // bloom threshold when it lands on lit deck, and slimmer, so it reads as a
    // scribed edge rather than a strip light.
    const sh = 0.12;
    const strip = ringStrip(
      rectLoop(b.hx - 0.05, b.hz - 0.05, 0.03),
      rectLoop(b.hx - 0.05, b.hz - 0.05, 0.03 + sh),
      1
    );
    this._practicals.push(flatTint(strip, 0.12, 0.21, 0.30));
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
    ), 0.62));
    // Shadowed soffit under the beam. Dark, because it faces down and away from
    // everything — but a soffit in shade is still a soffit, and at 0.28 of an
    // already dark tint this face measured 0/255 across the whole top of the
    // frame. "Shadow side" has to mean a lower value, not an absence.
    this._struct.push(flatTint(ringStrip(
      rectLoop(outHx, outHz, h - corniceH), rectLoop(b.hx + 0.25, b.hz + 0.25, h - corniceH - 0.35), STRUCT_TILE
    ), 0.46));

    // --- Spectator galleries ------------------------------------------------
    // A raked bank of seats is the single best scale reference available: the
    // viewer knows how big a seat is, therefore knows how big the robot is.
    // The bank is almost black on purpose — it frames the lit deck.
    //
    // THE BANK IS ARCHITECTURE. THE CROWD SITTING IN IT IS DECORATION. Those
    // were one flag, and that is the whole of phone defect P1.
    //
    // `crowd` is false at LOW and it gated the rake, the jumbotron AND the roof
    // gantry — the entire upper volume — on the one tier that shows the most of
    // it. A 19.5:9 portrait frame pitches the cornice down to a fifth of the
    // way from the top and puts raw sky in every row above it: measured at
    // saturation 0.71-0.91, the most saturated region of the whole phone frame,
    // and empty. On a 16:9 desktop frame the rake fills those rows and the
    // defect is invisible, which is how it survived eleven rounds of review.
    //
    // So the VOLUME is built at every tier now and only its SURFACE is tiered:
    // the seat-and-crowd bake where there is texture budget for it, flat
    // plating out of the shared structure batch where there is not. The
    // fallback is genuinely free — it merges into a mesh that already exists,
    // adds no texture bake to the loading screen and no draw call to the frame.
    //
    // An arena with no spectators gets the same volume as a terraced retaining
    // bank rather than nothing, because "this arena has no crowd" was never a
    // reason for the top of its frame to be empty — and the foundry, which
    // declares `crowd: false`, has been playing with a hole up there at EVERY
    // tier, not just LOW.
    const rakeRun = 9.0, rakeRise = 6.4;
    const gy = h + 0.15;
    const crowdOn = t.crowd && this.settings.crowd;
    if (crowdOn) {
      const gtex = galleryTexture(t, this.tex.gallery);
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
    } else {
      // Plated bank: the same raked volume in the shared structure batch. Mid
      // tint, so it sits between the near-black wall below it and the lit top
      // plane of the cornice — the bank has to read as a SURFACE that turns,
      // not as one more piece of the dark surround.
      const slope = Math.hypot(rakeRun, rakeRise);
      this._struct.push(flatTint(ringStrip(
        rectLoop(outHx, outHz, gy),
        rectLoop(outHx + rakeRun, outHz + rakeRun, gy + rakeRise),
        STRUCT_TILE, slope / STRUCT_TILE
      ), 0.66));
      // Capping rail along the head of the bank. A raked plane running off the
      // top of frame with no edge on it reads as a gradient; an edge is what
      // makes it a built thing with a top.
      this._struct.push(flatTint(ringStrip(
        rectLoop(outHx + rakeRun, outHz + rakeRun, gy + rakeRise),
        rectLoop(outHx + rakeRun + 0.5, outHz + rakeRun + 0.5, gy + rakeRise + 0.45),
        STRUCT_TILE
      ), 1.25));
      // One aisle line low on the rake. Additive and therefore unbounded, so it
      // is held far under the strength of the deck kerb: this is 20 m up and
      // near the top of the frame, which is the last place in the composition
      // allowed to compete for brightness. It exists to put a horizontal in the
      // dark, not to light anything.
      const warm = new THREE.Color(t.crowdWarm ?? t.hazard ?? 0xffb01f);
      const af = 0.26;
      this._practicals.push(flatTint(ringStrip(
        rectLoop(outHx + rakeRun * af, outHz + rakeRun * af, gy + rakeRise * af),
        rectLoop(outHx + rakeRun * af + 0.06, outHz + rakeRun * af + 0.06, gy + rakeRise * af + 0.1),
        1
      ), warm.r * 0.17, warm.g * 0.11, warm.b * 0.05));
    }

    // --- Jumbotron ring -----------------------------------------------------
    // A band of screens above the crowd. Emissive, so it survives being nearly
    // the only thing lit up there, and it puts the league's own colour high in
    // frame where nothing else is competing for it.
    const screenBase = gy + rakeRise + 0.4;
    const screenH = 2.6;
    const sHx = outHx + rakeRun, sHz = outHz + rakeRun;
    const screensOn = t.screens && this.settings.crowd;
    if (screensOn) {
      const stex = screenTexture(t, this.tex.screen);
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
    } else {
      // No screen bake at this tier: the band is still built, as the blank back
      // of the hoarding the screens are hung on. Darker than its own framing,
      // so the two struct strips below still read as installed hardware around
      // something rather than as a pair of stray lines.
      this._struct.push(flatTint(ringStrip(
        rectLoop(sHx, sHz, screenBase),
        rectLoop(sHx, sHz, screenBase + screenH),
        STRUCT_TILE, screenH / STRUCT_TILE
      ), 0.4));
    }

    // Frame the band top and bottom so it reads as installed hardware. Built
    // whether or not the screens themselves are — it is the hoarding, and the
    // hoarding is what gives the top of the frame two horizontals to sit on.
    if (t.screens) {
      this._struct.push(flatTint(ringStrip(
        rectLoop(sHx + 0.3, sHz + 0.3, screenBase - 0.35),
        rectLoop(sHx + 0.3, sHz + 0.3, screenBase), STRUCT_TILE
      ), 0.55));
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
        // needs to stop being monochrome. There are only four of them and they
        // are as far from the fight as anything in the arena gets, so they are
        // the one practical allowed to sit at the top of the budget.
        const beacon = new THREE.BoxGeometry(1.1, 0.5, 1.1);
        beacon.translate(px, pyTop + 0.3, pz);
        this._practicals.push(flatTint(beacon, PRACTICAL_CEIL, PRACTICAL_CEIL * 0.52, PRACTICAL_CEIL * 0.14));
      }
    }

    // --- Roof gantry --------------------------------------------------------
    // A lighting truss cantilevered inward over the crowd, with lamp housings
    // aimed at the deck. Kept off the centre of the arena so it never occludes
    // the fight, but it puts hard structure into the top of the frame.
    //
    // It used to be gated on `lights >= 4`, and nothing here is a light. The
    // truss is two ring strips in the structure batch and the lamp lenses are
    // quads in the practicals batch; both meshes exist already, so this costs
    // no draw call, no texture and no shader at any tier. The gate was reading
    // the lamp COUNT as though it were the lamp BUDGET, and what it actually
    // did was strip the last hard edge out of the top of the frame on LOW —
    // exactly where the portrait phone is looking. Built everywhere.
    {
      const ry = pyTop - 1.6;
      const inHx = b.hx + 3.0, inHz = b.hz + 3.0;
      this._struct.push(flatTint(ringStrip(
        rectLoop(inHx, inHz, ry), rectLoop(sHx, sHz, ry + 1.1), STRUCT_TILE
      ), 0.5));
      this._struct.push(flatTint(ringStrip(
        rectLoop(inHx, inHz, ry - 0.7), rectLoop(inHx, inHz, ry), STRUCT_TILE
      ), 0.9));

      // Lamp housings on the inner edge, alternating cool key and warm fill.
      //
      // There are twenty of these and they run in an unbroken dotted line along
      // the top of the frame, which is why they get a fraction of the budget the
      // four corner beacons get rather than the same share. They were authored
      // at 1.5x a near-saturated hue — 45% over the bloom threshold on their
      // strongest channel, i.e. twenty self-blooming emitters in a composition
      // whose kerb had already been argued down to 0.30 for exactly this.
      const lampsPerSide = 5;
      const LENS = PRACTICAL_CEIL * 0.62;
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
          // Normalised on its own peak channel, so a lens is the same
          // brightness whichever hue it is: the alternation is meant to read as
          // two colours of lamp, not as one bright lamp and one dim one.
          const c = (li++ % 3 === 0) ? warm : acc;
          const k = LENS / Math.max(1e-4, Math.max(c.r, c.g, c.b));
          this._practicals.push(flatTint(lens, c.r * k, c.g * k, c.b * k));
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
   *
   * READ THIS BEFORE TUNING ANYTHING IN HERE — FIVE ROUNDS WERE SPENT ON
   * SURFACES THE MATCH CAMERA CANNOT SEE.
   *
   * `_buildWalls` builds the boundary as four unbroken `PlaneGeometry` walls.
   * There is no opening cut in them, and every piece of this portal except the
   * threshold and the lamp is built at a NEGATIVE local z — that is, on the far
   * side of that wall plane:
   *
   *   recess back    z = -1.60      behind the wall
   *   jambs, lintel  z = -0.80      behind the wall
   *   throat glow    z = -1.42      behind the wall
   *   threshold mat  z = -0.20 .. +2.20   IN FRONT, on the deck
   *   throat lamp    z = +0.60      IN FRONT, and it lights the deck and wall
   *
   * Verified by removal on the pinned grid frame (`shots/_own/grid-base.png`
   * against `grid-no-walls.png`): hide the walls and a large flat orange
   * rectangle appears where the throat glow is. It is not in the base frame at
   * all. So the two levers this file has pulled at the residual — the throat
   * glow's 0.85 -> 0.62, and its own comment claiming "the strongest single
   * region of the frame on every model that weights brightness is this panel"
   * — were aimed at an invisible quad. That is the mechanical reason four
   * filings landed nothing: the argument was correct about the picture and
   * wrong about which object was in it.
   *
   * What the camera actually sees of a gate is the threshold mat, the warm
   * spill the lamp throws on the deck and the wall plinth behind it, and the
   * wall's own plinth chevrons and kerb strip running through the same tiles.
   * Those are the three surfaces the residual is about, and they are tuned
   * here, in `_buildWalls`, and in `textures.js`'s `hazPaint`.
   *
   * The dead geometry is left standing rather than deleted: the portal reads
   * from the results camera and from the garage, deleting it is a composition
   * change rather than a salience one, and this note is worth more to the next
   * round than the vertex count is.
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
      // "Small, saturated" is what the paragraph above promises and it is not
      // what was built: 17 m² of additive quad at a FLAT 0.85 red, which after
      // ACES is a near-white slab of even value with no gradient anywhere in
      // it. Evenly lit and rectangular is the description of a screen, not of a
      // doorway, and the review's salience sweep found it — the strongest
      // single region of the frame on every model that weights brightness is
      // this panel, one piece of architecture, out-ranking both machines.
      //
      // A throat light spills from the threshold and falls off with height, so
      // ramp it: the peak stays where the floor is (the gate is still the one
      // hot thing in the arena, and its brightest point barely moves), the mean
      // radiance halves, and the flat rectangle becomes a gradient that reads
      // as depth. Four vertex colours, no texture, no extra draw call.
      //
      // The gradient fixed the SHAPE and left the VALUE where it was, which is
      // why the review's sweep still returns this panel at rank 1: at the old
      // peak the quad's luminance was 0.394 linear, which ACES lands at 194 on
      // screen against a machine's p95 of 193. A dead heat between one large
      // contiguous rectangle and the scattered highlights on a robot is not a
      // dead heat to the eye — the rectangle wins, and it did, on every model.
      //
      // Scaled to 0.62 of itself, hue untouched. Luminance lands at 162 and the
      // red channel still resolves at 204, so the throat is exactly as orange
      // and exactly as saturated as it was and is no longer the brightest
      // object in the composition. This is the kerb's rule applied to the one
      // fixture that had never been held to it: a piece of architecture is
      // allowed to be the most saturated thing in frame, not the brightest.
      const GATE_GLOW = 0.62;
      this._practicals.push(rampTint(glow,
        [warm.r * 0.78 * GATE_GLOW, warm.g * 0.46 * GATE_GLOW, warm.b * 0.15 * GATE_GLOW],
        [warm.r * 0.10 * GATE_GLOW, warm.g * 0.06 * GATE_GLOW, warm.b * 0.02 * GATE_GLOW]));

      // Hazard chevrons painted across the threshold — warm paint on the white
      // deck, at exactly the spot the player's robot stands at round start.
      //
      // THIS SLAB IS THE GATE RESIDUAL. Five rounds of REVIEW2 have argued the
      // entry against the recess, the throat glow and the gate lamp, and it was
      // none of them — see the occlusion note at the top of this method. Knock
      // the `hazard` mesh out of the pinned grid frame and the bright orange
      // chevron band at frame left disappears; knock the `walls` mesh out
      // instead and the band is still there. It is a 6.4 x 2.4 m mat of the
      // most saturated paint in the arena, laid on the deck, IN FRONT of the
      // wall rather than behind it, and it is the only part of the portal the
      // match camera can see.
      //
      // Two thirds of the paint's remaining chroma, on top of the batch-wide
      // value ceiling and saturation pull. It still reads as a threshold — the
      // stripes are the same stripes and the hue does not move — and it stops
      // being the most chromatic object in a frame that contains two robots.
      const GATE_THRESHOLD_TINT = 0.66;
      const th = new THREE.PlaneGeometry(W + 1.4, 2.4);
      th.rotateX(-Math.PI / 2);
      th.rotateY(yaw);
      const tp = put(0, 0.012, 1.0);
      th.translate(tp[0], tp[1], tp[2]);
      const uv = th.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i));
      this._hazard.push(flatTint(th, GATE_THRESHOLD_TINT));

      // Throat lamp. A PRACTICAL, and a practical is not allowed to out-light
      // the sun — which this one did, by a factor of eight at the surface it
      // was closest to.
      //
      // Decay is 2, so the illuminance it delivers is intensity / d². At 26 that
      // is 26 lux at one metre against a key of 3.2, and the boundary wall the
      // gate is cut into stands 0.6-3 m away from it. Knocking each light out of
      // a frozen frame in turn and diffing measures what that actually bought:
      //
      //   foundry   gate lamp  2.8% of the frame, mean +26.7, PEAK +160
      //             key light 60.3% of the frame, mean +24.4, peak +122
      //
      // A 5 m doorway's fixture was the strongest single light in the arena, and
      // its footprint is the 626x443 box of blown-out gold plating that made the
      // boundary wall — 19.4% of the foundry frame — supply 42% of the frame's
      // brightest 1%. That is a surround out-lighting the fight.
      //
      // Matched to the key at the distance it is meant to reach instead. The
      // threshold chevrons sit ~2.5 m from the lamp, where 7 lux of intensity
      // lands 1.1 against the key's 3.2 — a warm fill on the deck at the
      // doorway, which is the whole of what the paragraph above promises it for.
      // And the range comes down with it: 16 m of reach on a 5 m opening is what
      // put the lamp's fingerprint eight metres down the plating, so the window
      // now closes at 6.5 m and the wash stops at the jambs.
      if (this.settings.lights >= 4) {
        const p = put(0, 2.2, 0.6);
        const l = new THREE.PointLight(warm, 7, 6.5, 2.0);
        l.position.set(p[0], p[1], p[2]);
        this.group.add(l);
        this.gateLights.push(l);
      }
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Perimeter of one box's emissive cap ring, in metres. Kept next to the code
   * that builds the ring so the two cannot drift apart: it re-derives the same
   * chamfer inset and cap inset, and takes the mid-line between the ring's inner
   * and outer loops.
   */
  static _rimPerimeter(b) {
    const inset = Math.min(0.12, Math.min(b.hx, b.hz) * 0.18);
    const capX = Math.max(0.12, b.hx - inset - 0.22);
    const capZ = Math.max(0.12, b.hz - inset - 0.22);
    return 4 * (capX + capZ + 0.42);
  }

  _buildBoxes() {
    const solids = [];
    const rims = [];
    const emis = new THREE.Color(this.theme.emissive);

    // ARENA TERM OF THE RIM BUDGET — see the per-box term below.
    //
    // The per-box term answers "is this cap bigger than the one the number was
    // set on", and it was the right question asked at the wrong scope. What a
    // viewer pays for is the total additive line in the FRAME, and the three
    // arenas draw very different amounts of it: 116 m of ring in the grid, 143
    // in the orbital, 167 in the foundry. Two arenas nobody had reviewed were
    // therefore shipping 23% and 44% more glowing line than the one arena the
    // number was signed off against, out of the same per-metre allowance.
    //
    // Held against the reference arena's own total, so the grid comes out at
    // exactly 1.0 and does not move by a pixel, and an arena that draws half as
    // much line again pays for it per metre. The two terms multiply because they
    // are two different mistakes: one very large cap in a sparse arena and forty
    // small ones in a dense arena both need cutting, for different reasons.
    const RIM_ARENA_REF = 116.3;
    const rimTotal = this.arena.boxes.reduce((s, b) => s + Stage._rimPerimeter(b), 0);
    const arenaK = Math.min(1, RIM_ARENA_REF / Math.max(1e-3, rimTotal));

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
      boxFaceTint(cap, 0.045, (KIND_TINT[b.kind] ?? 1) * 1.12, { top: 1.9, side: 0.62, under: 0.3 });
      cap.rotateY(b.yaw || 0);
      cap.translate(b.x, b.top + 0.03, b.z);
      solids.push(cap);

      // Emissive trim, as an actual RING around the cap. The old version was a
      // filled additive box covering the entire top face, which flattened every
      // block into one pale slab and is the direct cause of the greybox read.
      //
      // Same budget as the perimeter kerb, and for the same reason: the dais is
      // 6.8 m square, so its rim is a cyan rectangle drawn across a third of the
      // frame. At 0.85 of a near-white emissive it summed past the bloom
      // threshold on every lit cap and became the longest, brightest line in the
      // composition. The ring still describes the cap edge — that is the job —
      // it just does it at rim-light strength instead of at strip-light
      // strength.
      //
      // 0.30 IS A PER-METRE BUDGET SPENT ON A PER-FRAME COST, and that is the
      // whole of why it does not survive leaving the grid. It was set against
      // one cap — the grid's 6.8 m dais, whose ring the comment above already
      // calls "a cyan rectangle drawn across a third of the frame" — and then
      // applied unchanged to caps that draw two to four times as much line.
      // What a viewer pays for is the LENGTH of additive line in the frame; the
      // reason the ring exists (mark the edge you can land on) does not grow
      // with the platform. Nobody re-ran the arithmetic for the orbital's 11.6 m
      // dais, whose ring is 45 m of it, or for the foundry's two 12 m wall
      // blocks 6 m up, and the two arenas nobody has reviewed both ship a web of
      // it that a squint finds before it finds either machine.
      //
      // So the budget is held per frame instead: a cap no larger than the
      // reference keeps the full 0.30 and anything bigger is cut in proportion
      // to the extra line it draws, with a floor so a large platform still gets
      // its edge described. The reference IS the grid's dais, so every box in
      // the reviewed arena — dais, crates, pillars, rails — comes out at
      // exactly 0.30 and the arena five rounds of review signed off on does not
      // move by one pixel.
      const RIM_REF = 3.4;
      const rimK = 0.30 * Math.min(1, Math.max(0.45, RIM_REF / Math.max(b.hx, b.hz))) * arenaK;
      const ri = rectLoop(capX + 0.16, capZ + 0.16, b.top + 0.075, b.x, b.z, b.yaw || 0);
      const ro = rectLoop(capX + 0.26, capZ + 0.26, b.top + 0.075, b.x, b.z, b.yaw || 0);
      rims.push(flatTint(ringStrip(ri, ro, 1), emis.r * rimK, emis.g * rimK, emis.b * rimK));

      // Hazard skirt: a painted warning band wrapped round the base of every
      // obstacle. Warm, low, and it anchors the block to the deck.
      const skirtH = Math.min(0.34, b.hy * 0.5);
      const sk = ringStrip(
        rectLoop(b.hx + 0.012, b.hz + 0.012, b.bottom + 0.005, b.x, b.z, b.yaw || 0),
        rectLoop(b.hx + 0.012, b.hz + 0.012, b.bottom + skirtH, b.x, b.z, b.yaw || 0),
        0.9, 1
      );
      // Unmodified: the skirt is a 0.34 m band round a block, it is not what
      // the gate residual is filed against, and it takes the batch's own
      // saturation cut like everything else on this material.
      this._hazard.push(flatTint(sk, 1));

      // Contact darkening on the deck. Even with shadow maps on, a block needs
      // an ambient occlusion pool to stop reading as a decal — and at LOW tier
      // this is the only shadow there is.
      //
      // Sized as CONTACT, not as shadow. At 0.55 m of pad and a 2.15x blow-up a
      // 2.6 m block laid a 8 m smudge over the deck, measured at a median of 16
      // against a deck of 95 — four times the footprint of the block and darker
      // than the real cast shadow beside it, which is exactly how an AO pool
      // ends up impersonating the lighting. Tight and shallow now: it darkens
      // the joint and stops.
      const pad = 0.24;
      const dec = new THREE.PlaneGeometry((b.hx + pad) * 1.5, (b.hz + pad) * 1.5);
      dec.rotateX(-Math.PI / 2);
      dec.rotateY(b.yaw || 0);
      dec.translate(b.x, 0.016, b.z);
      this._decals.push(dec);
    }

    if (solids.length) {
      const stex = this._structureTex();

      const merged = mergeGeometries(solids);
      ensureAOChannel(merged);
      // Same argument as the architecture batch: the shared plating bake is
      // authored at metalness 0.5-0.7, so a block's four side planes — which
      // face away from the key by definition, that is what a side plane is —
      // had no diffuse term to receive the bounce with and measured a median of
      // 11/255 against a cap at 65. The lit-top/dark-side discipline survives
      // (the envMap's bright half is BELOW the horizon, so it lifts sides and
      // leaves caps alone), it just stops being lit-top/no-side.
      const mat = pbr(stex, {
        color: this.theme.struct ?? this.theme.wall,
        emissive: this.theme.accent,
        emissiveIntensity: 1.4,
        metalness: 0.44,
        // Same argument as the deck's normalScale, and the crates are the
        // surface the comparison named first: "four brown crates occupy more of
        // the eye's attention than the fight does". At 1.35 every plate groove,
        // bolt head and louvre slot on a 2.6 m box gets its own highlight, so a
        // crate carries more legible line work than a robot does. The plating
        // stays; the relief that was drawing it in ink comes down.
        envMapIntensity: 0.6,
        normalScale: 0.8,
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
  /**
   * The plating bake is shared by every theme and every arena in the session;
   * what makes an arena's architecture its own is the tint applied at the
   * material, not a private copy of the same greyscale plates.
   */
  _structureTex() {
    if (!this.structTex) {
      this.structTex = structureTexture(this.tex.struct);
      for (const t of Object.values(this.structTex)) {
        if (t?.isTexture) t.anisotropy = this.settings.anisotropy;
      }
    }
    return this.structTex;
  }

  _flushBatches() {
    if (this._struct.length) {
      // Architecture is painted plate, not bare chrome. The shared structure
      // bake authors metalness at 0.5-0.7, and a metal has no diffuse term at
      // all — it can only be as bright as what it reflects, and what a gantry
      // 20 m up reflects is a near-black sky. That is the whole mechanism
      // behind the black band across the top of every frame: not "too little
      // light" but "a surface that cannot accept light". Knocking the map down
      // to roughly a third gives the cornice, the pylons and the gate jambs a
      // diffuse coat for the warm rig to land on, and the envMap lift lets the
      // deck's bounce do the rest. Both are needed; either alone does nothing.
      const mat = pbr(this._structureTex(), {
        color: this.theme.struct ?? this.theme.wall,
        emissive: this.theme.accent,
        emissiveIntensity: 1.2,
        metalness: 0.34,
        envMapIntensity: 0.75,
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
      const htex = hazardTexture(this.tex.hazard);
      for (const t of Object.values(htex)) {
        if (t?.isTexture) t.anisotropy = this.settings.anisotropy;
      }
      // Hazard paint is INFORMATION, not illumination.
      //
      // The theme's `hazard` hue is the colour of the paint chip; a chevron band
      // lit by a 3.4-intensity key at that albedo lands at 180-200 on a deck
      // whose median is 96, i.e. the warning stripes were the second brightest
      // object in the arena after the deck rails and comfortably brighter than
      // either machine. Warning paint on a real deck is a mid-value ochre that
      // reads by HUE and by its hard stripe rhythm, not by out-glowing the floor
      // it is painted on. Two thirds of the albedo keeps every bit of the
      // information — the chevrons are exactly as legible — and gives the top of
      // the value range back to the robots.
      //
      // And the saturation half, which is the half that was never applied.
      // Three rounds took value off this paint and the residual did not move,
      // because on the authority meter (`shots/_salience.mjs`, model A, T=40,
      // off=0) the stage tiles that outrank the machines do it at a LOWER
      // luminance and a higher chroma — 92-101 at 0.324-0.378 against the
      // machines' 103-117 at 0.190-0.320. `hazPaint` takes the value ceiling
      // this line already had and then pulls the chip toward its own luminance
      // at constant hue, which is the axis the paint was actually winning on.
      const chip = new THREE.Color(this.theme.hazard ?? 0xffb01f);
      const q = hazPaint({ r: chip.r, g: chip.g, b: chip.b }, 0.62);
      const paint = new THREE.Color(q.r, q.g, q.b);
      const mat = pbr(htex, {
        color: paint,
        emissive: 0x000000,
        emissiveIntensity: 0,
        envMapIntensity: 0.12,
        normalScale: 0.9,
        side: THREE.DoubleSide,
      });
      mat.envMap = this.envMap;
      // Per-surface tint, so the one hazard surface the residual is actually
      // filed against can be taken down without dragging every obstacle skirt
      // in the arena with it. See GATE_THRESHOLD_TINT in _buildGates.
      mat.vertexColors = true;
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
      // Every practical in the arena passes through here, so this is where the
      // additive budget is enforced — see PRACTICAL_CEIL.
      const geo = clampAdditive(mergeGeometries(this._practicals));
      this.buildProfile.practicalsClamped = geo.userData.practicalsClamped;
      const m = new THREE.Mesh(geo, mat);
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
        opacity: 0.34,
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

  /**
   * DEFECT #14 — no obstacle has ever cast a shadow onto the deck — AND IT WAS
   * NEVER THE EXTENT.
   *
   * An OrthographicCamera bakes left/right/top/bottom/near/far into its
   * projection matrix, and three never re-bakes one for you. LightShadow's
   * updateMatrices() puts the shadow camera at the light, aims it at the light's
   * target, and stops; SpotLightShadow overrides it to call
   * updateProjectionMatrix() because its fov tracks the cone angle, and
   * DirectionalLightShadow — having nothing to track — calls it never. So every
   * extent set below was written to a field nobody read, and the arena has been
   * rendering its shadow map through DirectionalLightShadow's CONSTRUCTOR
   * default: OrthographicCamera(-5, 5, 5, -5, 0.5, 500).
   *
   * That is a 10 m x 10 m column, centred on the camera focus, in an arena 32 m
   * across. Both machines live at the focus, so their cast shadows and their
   * self-shadowing landed correctly — which is exactly why five rounds missed
   * it. The half of the system that visibly worked was the half being looked at.
   * Every obstacle leaves a 10 m box the instant the fight moves off it, so no
   * block has ever thrown anything onto the deck: the whole defect, from one
   * missing call.
   *
   * It also explains why the shadows that DID land were unusually crisp. A 2048
   * map over 10 m is 4.9 mm a texel; over the real frustum it is ~18 mm, so the
   * filter radius and the normal bias are now doing the job they were written
   * for instead of sitting on eight times the resolution they were tuned on.
   *
   * Called from setQuality too, because the same hole is open on the other path:
   * a device that boots at LOW (shadows off) and climbs to MID used to turn
   * castShadow on against a frustum nobody had ever configured.
   */
  _configureShadow(key) {
    key.castShadow = true;
    const s = this.settings.shadowMapSize;
    if (key.shadow.mapSize.x !== s) {
      key.shadow.mapSize.set(s, s);
      // three allocates the depth target once and never re-reads mapSize, so a
      // tier change only takes if the old target is dropped.
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
    const b = this.arena.bounds;
    const ext = Math.max(b.hx, b.hz) * 1.15;
    const c = key.shadow.camera;
    c.left = -ext;
    c.right = ext;
    c.top = ext;
    c.bottom = -ext;
    c.near = 1;
    c.far = 90;
    c.updateProjectionMatrix();
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.022;
    // Tight penumbra. A soft shadow on a dark floor is invisible; a crisp
    // shadow on a bright deck is the contact cue the whole scene was missing.
    // 1.2 was tight enough that the 2048 map's stair-stepping was visible on
    // the long diagonal edge a block throws across the deck.
    key.shadow.radius = 2.2;
    // NOT 1.0. At full intensity the key is the only meaningful light on the
    // deck, so a shadow removes ~90% of the value and the deck drops from 95
    // to single digits: the shadow stops being shade and becomes a hole cut
    // in the floor, and every pixel of it lands in the crushed-black mass.
    // At 0.86 the shadowed deck still falls a long way — this is a hard-light
    // arena, not an overcast one — but it keeps enough value to read as the
    // same floor in shade, which is the whole point of casting it.
    key.shadow.intensity = 0.86;
  }

  _buildLights() {
    const t = this.theme;
    this.lights = {};

    const key = new THREE.DirectionalLight(t.sunColour, t.sunIntensity);
    key.position.set(t.sunDir[0] * 30, t.sunDir[1] * 34, t.sunDir[2] * 30);
    key.target.position.set(0, 0, 0);
    if (this.settings.shadows) this._configureShadow(key);
    this.group.add(key, key.target);
    this.lights.key = key;

    // Fill is deliberately weak. Its job is to keep shadowed metal legible, not
    // to make the shadow side match the lit side — the moment those two are
    // close, the frame has no value structure left.
    const fill = new THREE.DirectionalLight(t.rimColour, t.sunIntensity * 0.17);
    fill.position.set(-t.sunDir[0] * 24, 12, -t.sunDir[2] * 24);
    this.group.add(fill);
    this.lights.fill = fill;

    // Warm counter-kick off the deck, and the most important light in the rig
    // after the key.
    //
    // It used to sit at y = -6, i.e. UNDER the floor, so the only surfaces it
    // could reach were undersides nobody ever sees; the four side planes of
    // every block that face away from the sun were lit by nothing at all and
    // measured a median of 2/255. A block is not a silhouette, it is an object,
    // and an object needs a second read on its shadow side.
    //
    // So: low over the deck from the anti-sun quadrant, warm, and grazing. Its
    // elevation is the whole trick — at 0.16 of the way up it lands 0.16 on the
    // deck (which is already the brightest thing in frame and does not want the
    // help) and up to 0.69 on a vertical plane, so it separates the sides from
    // the floor instead of flattening them together. Warm because everything
    // else here is blue: the shadow side of a block is now the one place in the
    // arena where the accent colour is doing structural work rather than trim.
    const bounce = new THREE.DirectionalLight(t.bounceColour ?? t.hazard ?? 0xffb01f, t.sunIntensity * 0.30);
    bounce.position.set(-t.sunDir[0] * 26, 2.7, -t.sunDir[2] * 26);
    this.group.add(bounce);
    this.lights.bounce = bounce;

    // Sky/ground ambient. The ground half is warm and carries most of the
    // weight: a hemisphere's ground term barely touches an up-facing plane
    // (the deck reads almost pure sky) and lands at full half-strength on every
    // vertical face, which is exactly the distribution the frame needs. This is
    // the term that lifts blacks, so it is still rationed — but rationed is not
    // the same as absent, and 0.4 of two near-black colours was absent.
    const hemi = new THREE.HemisphereLight(t.skyTop, t.groundBounce ?? 0x4a3524, 0.95);
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
      if (settings.shadows) this._configureShadow(this.lights.key);
      else this.lights.key.castShadow = false;
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
    // envMap is shared across every arena that uses this theme and outlives the
    // stage — disposing it here would make the next arena re-bake it, which is
    // exactly the cost this pass exists to remove.
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
