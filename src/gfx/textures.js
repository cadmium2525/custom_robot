/**
 * Procedural texture bakery.
 *
 * The game ships zero image files: every map here is synthesised into a canvas
 * at boot. That keeps the download tiny, lets textures scale with the device
 * tier, and means the art is parameterised — a part's `look` block drives its
 * armour panels directly.
 *
 * PBR maps use the ORM packing three.js already expects:
 *   R = ambient occlusion, G = roughness, B = metalness
 * so one upload serves three channels.
 */

import * as THREE from 'three';
import { Noise, smoothstep, mix, clamp01 } from './noise.js';

const cache = new Map();

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function ctx2d(size) {
  const c = canvas(size);
  const g = c.getContext('2d', { willReadFrequently: true });
  return { c, g };
}

function toTexture(cv, { srgb = false, repeat = 1, aniso = 4, filter = true } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.magFilter = filter ? THREE.LinearFilter : THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Sobel height -> tangent-space normal map. */
function heightToNormal(height, size, strength = 2.0) {
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len;
      const nzn = nz / len;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nzn * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const { c, g } = ctx2d(size);
  g.putImageData(new ImageData(out, size, size), 0, 0);
  return c;
}

const hex = (v) => ({ r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 });

// ---------------------------------------------------------------------------
// Armour: machined panels with bevels, rivets, brushed grain and wear
// ---------------------------------------------------------------------------

/**
 * @returns {{map: THREE.Texture, normalMap: THREE.Texture, ormMap: THREE.Texture}}
 */
export function armorTexture(look, size = 512, seedOffset = 0) {
  const key = `armor:${look.primary}:${look.secondary}:${look.accent}:${look.trim}:${size}:${seedOffset}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0x51ed + (look.primary & 0xffff) + seedOffset * 7919);
  const base = hex(look.primary);
  const sec = hex(look.secondary);
  const acc = hex(look.accent);

  const albedo = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);

  // Panel layout: recursive-ish splits produce believable plate boundaries.
  const panels = [];
  const split = (x, y, w, h, depth) => {
    if (depth <= 0 || w < 0.09 || h < 0.09) {
      panels.push({ x, y, w, h, id: panels.length });
      return;
    }
    const horiz = w > h ? n.simplex2(x * 9 + 4, y * 9) > -0.55 : n.simplex2(x * 9, y * 9 + 4) > 0.55;
    const t = 0.34 + (n.simplex2(x * 13 + depth, y * 13) * 0.5 + 0.5) * 0.32;
    if (horiz) {
      split(x, y, w * t, h, depth - 1);
      split(x + w * t, y, w * (1 - t), h, depth - 1);
    } else {
      split(x, y, w, h * t, depth - 1);
      split(x, y + h * t, w, h * (1 - t), depth - 1);
    }
  };
  split(0, 0, 1, 1, 4);

  const panelAt = (u, v) => {
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i];
      if (u >= p.x && u < p.x + p.w && v >= p.y && v < p.y + p.h) return p;
    }
    return panels[0];
  };

  const gap = 0.0055;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      const o = i * 4;

      const p = panelAt(u, v);
      // Distance to the nearest panel edge, in UV units.
      const du = Math.min(u - p.x, p.x + p.w - u);
      const dv = Math.min(v - p.y, p.y + p.h - v);
      const edge = Math.min(du, dv);

      const seam = 1 - smoothstep(gap, gap * 2.6, edge);      // dark groove
      const bevel = smoothstep(gap * 1.4, gap * 6.5, edge);   // lit lip

      // Per-panel tonal variation keeps large surfaces from looking flat.
      const pv = ((p.id * 2654435761) >>> 0) / 4294967296;
      const tint = 0.9 + pv * 0.2;

      // Brushed grain, anisotropic along the longer panel axis.
      const grainDir = p.w >= p.h ? n.simplex2(u * 260, v * 12) : n.simplex2(u * 12, v * 260);
      const grain = grainDir * 0.05;

      // Broad mottling + micro speckle.
      const macro = n.fbm2(u * 5.5, v * 5.5, 4) * 0.5 + 0.5;
      const micro = n.fbm2(u * 46, v * 46, 3) * 0.5 + 0.5;

      // Wear concentrates on panel edges and high macro spots.
      const wear = clamp01(smoothstep(0.62, 0.95, macro) * 0.8 + (1 - bevel) * 0.35);

      // Accent stripe: a diagonal band crossing a subset of panels.
      const stripeBand = Math.abs(((u * 0.7 + v * 0.7) % 0.5) - 0.25);
      const stripe = (pv > 0.72 ? 1 : 0) * (1 - smoothstep(0.045, 0.075, stripeBand));

      // Secondary plate colour on some panels.
      const isSec = pv > 0.38 && pv < 0.56;

      let r = isSec ? sec.r : base.r;
      let g = isSec ? sec.g : base.g;
      let b = isSec ? sec.b : base.b;

      r = mix(r, acc.r, stripe * 0.92);
      g = mix(g, acc.g, stripe * 0.92);
      b = mix(b, acc.b, stripe * 0.92);

      const shade = tint * (0.86 + macro * 0.2) * (1 - seam * 0.72) * (0.94 + bevel * 0.09) + grain;
      r *= shade; g *= shade; b *= shade;

      // Scuffed metal shows through as a desaturated bright.
      const scuff = wear * 0.35 * micro;
      r = mix(r, 0.72, scuff); g = mix(g, 0.74, scuff); b = mix(b, 0.78, scuff);

      albedo[o] = clamp01(r) * 255;
      albedo[o + 1] = clamp01(g) * 255;
      albedo[o + 2] = clamp01(b) * 255;
      albedo[o + 3] = 255;

      // --- ORM ---
      const ao = clamp01(1 - seam * 0.85 - (1 - bevel) * 0.18);
      const rough = clamp01(
        (look.roughness ?? 0.3) * (0.72 + micro * 0.5) + wear * 0.3 + seam * 0.25 - stripe * 0.1
      );
      // Armour is PAINTED, so the plates are dielectric — bare metal only shows
      // where the coat is worn through, at the seams and along scuffed edges.
      // Making the whole shell metallic turns the robo into a mirror, and a
      // mirror in a dark arena reads as a hologram rather than a machine.
      const metal = clamp01(
        0.10 + wear * 0.55 * (look.metalness ?? 0.9) + seam * 0.3 - stripe * 0.08
      );

      orm[o] = ao * 255;
      orm[o + 1] = rough * 255;
      orm[o + 2] = metal * 255;
      orm[o + 3] = 255;

      // --- height for the normal map ---
      let h = bevel * 0.5 + macro * 0.08 + micro * 0.03;
      h -= seam * 0.55;
      // Rivets along panel edges.
      const rivetU = (u % 0.085) - 0.0425;
      const rivetV = (v % 0.085) - 0.0425;
      const rd = Math.hypot(rivetU, rivetV);
      const nearEdge = edge < 0.022 && edge > gap * 1.5;
      if (nearEdge && rd < 0.011) h += (1 - smoothstep(0.004, 0.011, rd)) * 0.42;
      // Vent slots on a few panels.
      if (pv > 0.86) {
        const slot = Math.abs(((v - p.y) / Math.max(1e-4, p.h) * 9 % 1) - 0.5);
        if (du > 0.02) h -= (1 - smoothstep(0.16, 0.3, slot)) * 0.5;
      }
      height[i] = h;
    }
  }

  const { c: ac, g: ag } = ctx2d(size);
  ag.putImageData(new ImageData(albedo, size, size), 0, 0);
  const { c: oc, g: og } = ctx2d(size);
  og.putImageData(new ImageData(orm, size, size), 0, 0);

  const res = {
    map: toTexture(ac, { srgb: true, aniso: 8 }),
    ormMap: toTexture(oc, { aniso: 4 }),
    normalMap: toTexture(heightToNormal(height, size, 2.6), { aniso: 4 }),
  };
  cache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------
// Shared industrial-surface helpers
// ---------------------------------------------------------------------------

/**
 * A blocky 5x3 glyph cluster driven off a hash — at arena distance the eye
 * reads "there is a stencilled serial number there" long before it could read
 * an actual character, so painting real letters would be wasted texels.
 */
function stencilMark(hash, su, sv) {
  if (su < 0 || su > 1 || sv < 0 || sv > 1) return 0;
  const gx = Math.floor(su * 5);
  const gy = Math.floor(sv * 3);
  // Keep a margin inside each cell so glyphs read as separate strokes.
  const fx = su * 5 - gx, fy = sv * 3 - gy;
  if (fx < 0.14 || fx > 0.86 || fy < 0.2 || fy > 0.8) return 0;
  const bit = ((hash >>> ((gx * 3 + gy) & 31)) ^ (hash >>> (gx + 7))) & 1;
  return bit;
}

/** Deterministic 0..1 from an integer cell id. */
const cellRand = (i) => ((Math.imul(i, 2654435761) >>> 0) % 65536) / 65536;

// ---------------------------------------------------------------------------
// Arena floor — the lit combat deck
// ---------------------------------------------------------------------------

/**
 * The combat deck. This is the single most important surface in the game: it is
 * the largest thing on screen and it is what every robot silhouette is read
 * against, so it is authored as a NEAR-WHITE painted deck, not as dark metal.
 *
 * Two rules do most of the work:
 *   1. Low metalness. Metal has no diffuse response, so a metallic floor in a
 *      dark room can only ever be as bright as its reflections — which is how
 *      you end up with a grey arena no matter how hard you light it. The deck
 *      is coated composite: dielectric, bright, and it takes the key light.
 *   2. A real internal value range. Bright deck plates, mid tread plates and
 *      genuinely dark service/vent plates all live on the same floor, so the
 *      ground reads as a built surface and gives the frame its blacks *and*
 *      its whites without touching a single light.
 */
export function floorTexture(theme, size = 1024) {
  const key = `floor:${theme.key}:${size}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0xf100 + theme.floor);
  const base = hex(theme.floor);
  const acc = hex(theme.floorAccent);
  const deck = hex(theme.deck ?? theme.floor);
  const warn = hex(theme.hazard ?? 0xf5b21e);

  const albedo = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const emis = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);

  const cells = 8;          // tiles across the texture
  const lineW = 0.0075;     // narrower than before: a crisp scribed line, not a gutter

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      const o = i * 4;

      const cu = (u * cells) % 1;
      const cv = (v * cells) % 1;
      const cx = Math.floor(u * cells), cy = Math.floor(v * cells);
      const ci = cx + cy * cells;
      const cr = cellRand(ci);
      const cr2 = cellRand(ci + 977);

      const edge = Math.min(Math.min(cu, 1 - cu), Math.min(cv, 1 - cv));
      const seam = 1 - smoothstep(lineW, lineW * 2.4, edge);
      const glowLine = 1 - smoothstep(lineW * 0.3, lineW * 1.15, edge);

      // Inset frame inside each tile, then a raised centre field. Two steps of
      // relief is what stops a tiled floor reading as wallpaper.
      const inner = smoothstep(0.035, 0.055, edge);
      const field = smoothstep(0.075, 0.095, edge);
      const notch = (cu < 0.07 || cu > 0.93) && (cv < 0.07 || cv > 0.93) ? 1 : 0;

      // Octave counts here are pixels of freeze on the loading screen, so each
      // one has to earn itself. `speck` and `scratch` are already near the
      // Nyquist limit of the map at its first octave — their second octaves
      // land at a two-pixel period and are gone the instant a mipmap is built,
      // so they were pure cost.
      const grime = n.fbm2(u * 6, v * 6, 3) * 0.5 + 0.5;
      const speck = n.simplex2(u * 90, v * 90) * 0.5 + 0.5;
      // Cheap directional scuff. worley() looks lovely and costs four times as
      // much for something nobody can see at arena range.
      const scratch = smoothstep(0.42, 0.88, n.simplex2(u * 130, v * 22) * 0.5 + 0.5);

      // Five plate types keep the deck from repeating visibly under the camera.
      // The mix is deliberately weighted toward plain bright deck: the dark and
      // marked plates are punctuation, and punctuation stops working if you use
      // it in every sentence.
      const kind = cr < 0.07 ? 4 : cr < 0.17 ? 3 : cr < 0.34 ? 1 : cr < 0.44 ? 2 : 0;

      // Base plate rides most of the way to `deck`, which is near-white. The
      // floor is the light source of the composition even though it emits
      // nothing — everything else in the arena is darker than this.
      let shade = (0.9 + grime * 0.2) * (0.94 + cr2 * 0.12);
      let r = mix(base.r, deck.r, 0.88) * shade;
      let g = mix(base.g, deck.g, 0.88) * shade;
      let b = mix(base.b, deck.b, 0.88) * shade;

      let h = inner * 0.22 + field * 0.16 - seam * 0.75 + grime * 0.05 + notch * 0.2;
      let rough = 0.38 + grime * 0.26 + scratch * 0.16;
      // Coated composite deck: dielectric. Only the raw service plates and the
      // scribed grooves show bare metal.
      let metal = 0.05 + speck * 0.1;

      if (kind === 1 && field > 0.5) {
        // Tread plate: a diamond raised pattern, matte and grippy.
        const tu = (u * cells * 6) % 1 - 0.5;
        const tv = (v * cells * 6) % 1 - 0.5;
        const dia = 1 - smoothstep(0.16, 0.3, Math.abs(tu) + Math.abs(tv));
        h += dia * 0.3;
        shade = 0.86 + dia * 0.2;
        r *= shade; g *= shade; b *= shade;
        rough += 0.22 * dia;
      } else if (kind === 2 && field > 0.5) {
        // Service plate: a dark recessed grille. This is where the floor gets
        // its blacks — a bare grating drops two full stops below the deck.
        const lo = Math.abs(((v * cells * 9) % 1) - 0.5);
        const slot = 1 - smoothstep(0.22, 0.4, lo);
        const inset = smoothstep(0.075, 0.1, edge);
        const d = 0.55 + slot * 0.42;
        h -= slot * inset * 0.5;
        r *= 1 - d * inset; g *= 1 - d * inset; b *= 1 - d * inset;
        metal += inset * 0.5;
        rough += inset * 0.15;
      } else if (kind === 3 && field > 0.5) {
        // Stencilled ident plate — painted, so it goes matte and dielectric.
        const mk = stencilMark((ci * 2246822519) >>> 0, (cu - 0.28) / 0.44, (cv - 0.4) / 0.2);
        r = mix(r, 0.07, mk * 0.85);
        g = mix(g, 0.075, mk * 0.85);
        b = mix(b, 0.09, mk * 0.85);
        rough += mk * 0.3;
      } else if (kind === 4 && field > 0.5) {
        // Hazard plate: painted warning chevrons. The arena's only large warm
        // note lives on the deck, where the eye spends all its time.
        const s = ((cu + cv * 0.6) * 4) % 1;
        const stripe = smoothstep(0.46, 0.54, s) * smoothstep(0.9, 0.78, Math.abs(cv - 0.5) * 2);
        const worn = smoothstep(0.55, 0.9, grime);
        r = mix(r, mix(warn.r, 0.06, 0.0), stripe * (1 - worn * 0.45));
        g = mix(g, mix(warn.g, 0.06, 0.0), stripe * (1 - worn * 0.45));
        b = mix(b, mix(warn.b, 0.07, 0.0), stripe * (1 - worn * 0.45));
        r *= 1 - (1 - stripe) * 0.55; g *= 1 - (1 - stripe) * 0.55; b *= 1 - (1 - stripe) * 0.55;
        rough += 0.2;
        metal *= 0.4;
      }

      // The scribed grid is a dark line, not a glowing one. Dark line on bright
      // deck is legible in every lighting condition; the emissive version only
      // reads in the dark and turns to mush under bloom.
      r *= 1 - seam * 0.86; g *= 1 - seam * 0.86; b *= 1 - seam * 0.86;

      albedo[o] = clamp01(r) * 255;
      albedo[o + 1] = clamp01(g) * 255;
      albedo[o + 2] = clamp01(b) * 255;
      albedo[o + 3] = 255;

      // Emissive is now rationed: only the corner nodes of a few "live" tiles
      // light up. Painting the whole grid emissive is what turned the deck into
      // a light box and ate the contrast we just built.
      const live = cr > 0.9 ? 1 : 0;
      const e = live * (notch * 1.15 + glowLine * 0.35);
      emis[o] = clamp01(acc.r * e) * 255;
      emis[o + 1] = clamp01(acc.g * e) * 255;
      emis[o + 2] = clamp01(acc.b * e) * 255;
      emis[o + 3] = 255;

      orm[o] = clamp01(1 - seam * 0.8 - (1 - inner) * 0.12) * 255;
      orm[o + 1] = clamp01(rough) * 255;
      orm[o + 2] = clamp01(metal) * 255;
      orm[o + 3] = 255;

      height[i] = h;
    }
  }

  const mk = (arr, srgb) => {
    const { c, g } = ctx2d(size);
    g.putImageData(new ImageData(arr, size, size), 0, 0);
    return toTexture(c, { srgb, aniso: 16 });
  };

  const res = {
    map: mk(albedo, true),
    ormMap: mk(orm, false),
    emissiveMap: mk(emis, true),
    normalMap: toTexture(heightToNormal(height, size, 1.7), { aniso: 8 }),
  };
  cache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------
// Structure plating — obstacles, pylons, gantries, anything engineered
// ---------------------------------------------------------------------------

/**
 * Armour plate courses, laid like brickwork so vertical seams never stack into
 * a continuous crack. Authored to tile at one texture repeat per ~2 m, and
 * applied through `boxFaceUV()` in stage.js so a 6 m dais and a 0.5 m rail end
 * up with the same texel density instead of BoxGeometry's flat 0..1 squash.
 *
 * THEME-INDEPENDENT ON PURPOSE. Every theme was baking its own copy of this,
 * and every one of them was the same greyscale plating multiplied by a single
 * colour — the albedo was literally `themeColour * shade` and the emissive was
 * literally `accent * led`. So it bakes once, white, and stage.js tints it with
 * `material.color` / `material.emissive`, which the GPU does for free. Three
 * arenas, one bake. It is also the truthful reading: these are the same
 * league's prefab plates bolted together in every venue.
 *
 * The one thing a multiply cannot reproduce is paint that is BRIGHTER than the
 * plate it sits on, so the stencil marks now carry their contrast in roughness
 * and metalness — a matte dielectric patch on glossy metal — rather than in a
 * raw albedo value. That is how a real stencil reads anyway.
 */
export function structureTexture(size = 256) {
  const key = `struct:${size}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0x57a1);
  const base = { r: 1, g: 1, b: 1 };
  const acc = { r: 1, g: 1, b: 1 };

  const albedo = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const emis = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);

  const ROWS = 2, COLS = 2;
  const gap = 0.008;          // ~1.6 cm at a 2 m tile
  const BOLT = 0.0625;        // bolt lattice pitch; divides 1 so it tiles

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      const o = i * 4;

      const rowF = v * ROWS;
      const row = Math.floor(rowF);
      const rv = rowF - row;
      const colF = u * COLS + (row & 1) * 0.5;
      const col = Math.floor(colF);
      const cu = colF - col;

      const pid = (Math.imul(row + 1, 7919) ^ Math.imul(col + 1, 104729)) >>> 0;
      const pr = (pid % 65536) / 65536;

      // Plate-edge distance, converted back into UV units so the groove is the
      // same physical width on both axes.
      const du = Math.min(cu, 1 - cu) / COLS;
      const dv = Math.min(rv, 1 - rv) / ROWS;
      const edge = Math.min(du, dv);

      const groove = 1 - smoothstep(gap * 0.5, gap * 1.7, edge);
      const bevel = smoothstep(gap * 1.2, gap * 4.5, edge);

      const grain = n.simplex2(u * 210, v * 26) * 0.045;
      const macro = n.fbm2(u * 5, v * 5, 3) * 0.5 + 0.5;
      const micro = n.simplex2(u * 55, v * 55) * 0.5 + 0.5;
      // Rain/coolant streaks always run down the surface, never across it.
      const streak = clamp01(n.fbm2(u * 34, v * 2.4, 2) * 0.5 + 0.5);

      const tone = 0.86 + pr * 0.26;
      let shade = tone * (0.8 + macro * 0.34) * (1 - groove * 0.78) * (0.95 + bevel * 0.1) + grain;
      let r = base.r * shade, g = base.g * shade, b = base.b * shade;

      let h = bevel * 0.4 + macro * 0.06 + micro * 0.025 - groove * 0.7;
      let ao = 1 - groove * 0.9 - (1 - bevel) * 0.2;
      let rough = 0.44 + macro * 0.3 + streak * 0.2 + groove * 0.2;
      let metal = 0.7 - macro * 0.2;
      let e = 0;

      // Bolt heads on a global lattice, kept to the perimeter band of a plate
      // so they read as fasteners rather than decoration.
      const bu = ((u / BOLT) % 1 - 0.5) * BOLT;
      const bv = ((v / BOLT) % 1 - 0.5) * BOLT;
      const bd = Math.hypot(bu, bv);
      if (edge > gap * 1.8 && edge < gap * 5.5 && bd < 0.013) {
        const head = 1 - smoothstep(0.007, 0.012, bd);
        h += head * 0.5;
        r *= 1 + head * 0.18; g *= 1 + head * 0.18; b *= 1 + head * 0.18;
        rough -= head * 0.18;
        ao -= (1 - head) * 0.1;
      }

      const interior = edge > gap * 7;
      if (interior) {
        if (pr > 0.78) {
          // Louvred cooling vent.
          const lo = Math.abs(((rv * ROWS * 7) % 1) - 0.5);
          const slot = 1 - smoothstep(0.19, 0.34, lo);
          const inset = smoothstep(gap * 7, gap * 11, edge);
          h -= slot * inset * 0.62;
          const d = slot * inset;
          r *= 1 - d * 0.62; g *= 1 - d * 0.62; b *= 1 - d * 0.62;
          ao -= d * 0.4;
          metal += d * 0.2;
        } else if (pr > 0.56) {
          // Raised sub-plate bolted over the main course.
          const su = Math.abs(cu - 0.5), sv = Math.abs(rv - 0.5);
          const sub = (1 - smoothstep(0.3, 0.33, su)) * (1 - smoothstep(0.28, 0.31, sv));
          h += sub * 0.34;
          r *= 1 + sub * 0.1; g *= 1 + sub * 0.1; b *= 1 + sub * 0.1;
        } else if (pr > 0.44) {
          // Stencilled ident block. Lifted toward white rather than to a fixed
          // grey, so it survives the theme tint as the lightest thing on the
          // plate; the rough/metal break below does the rest of the work.
          const mk = stencilMark(pid, (cu - 0.26) / 0.48, (rv - 0.4) / 0.22);
          r = mix(r, 1.0, mk * 0.8);
          g = mix(g, 1.0, mk * 0.8);
          b = mix(b, 1.0, mk * 0.8);
          rough += mk * 0.34;
          metal -= mk * 0.62;
        }
      }

      // A single status LED per powered plate: cheap, and it makes the whole
      // structure read as machinery that is switched on.
      if (pr > 0.3 && pr < 0.42) {
        const lu = cu - 0.12, lv = rv - 0.14;
        const ld = Math.hypot(lu / COLS, lv / ROWS);
        e = (1 - smoothstep(0.004, 0.009, ld)) * 1.4;
      }

      // Grime pooling under the plate lips.
      const dirt = streak * (1 - bevel) * 0.3 + streak * 0.12;
      r *= 1 - dirt * 0.4; g *= 1 - dirt * 0.42; b *= 1 - dirt * 0.44;

      albedo[o] = clamp01(r) * 255;
      albedo[o + 1] = clamp01(g) * 255;
      albedo[o + 2] = clamp01(b) * 255;
      albedo[o + 3] = 255;

      emis[o] = clamp01(acc.r * e) * 255;
      emis[o + 1] = clamp01(acc.g * e) * 255;
      emis[o + 2] = clamp01(acc.b * e) * 255;
      emis[o + 3] = 255;

      orm[o] = clamp01(ao) * 255;
      orm[o + 1] = clamp01(rough) * 255;
      orm[o + 2] = clamp01(metal) * 255;
      orm[o + 3] = 255;

      height[i] = h;
    }
  }

  const mk = (arr, srgb) => {
    const { c, g } = ctx2d(size);
    g.putImageData(new ImageData(arr, size, size), 0, 0);
    return toTexture(c, { srgb, aniso: 8 });
  };

  const res = {
    map: mk(albedo, true),
    ormMap: mk(orm, false),
    emissiveMap: mk(emis, true),
    normalMap: toTexture(heightToNormal(height, size, 2.4), { aniso: 8 }),
  };
  cache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------
// Spectator galleries
// ---------------------------------------------------------------------------

const GALLERY_ROWS = 12, GALLERY_SEATS = 40;

/**
 * The seating bank itself: a packed, near-black rake of seat backs. Nothing in
 * here knows what arena it is in — the same moulded plastic seat is bolted into
 * every venue in the league — so it bakes once and every theme shares it. The
 * expensive part of a gallery bake (the grime fbm and the normal map) lives
 * entirely on this side of the split.
 */
function galleryBase(size) {
  const key = `gallery-base:${size}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0xc0d3);
  const albedo = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      const o = i * 4;

      const rowF = v * GALLERY_ROWS, row = Math.floor(rowF), rv = rowF - row;
      const seatF = u * GALLERY_SEATS + (row & 1) * 0.35;
      const su = seatF - Math.floor(seatF);

      // Seat backs: a rounded block with a gap to its neighbour and a step
      // shadow under the row above.
      const gapU = 1 - smoothstep(0.06, 0.16, Math.min(su, 1 - su));
      const stepShade = smoothstep(0.0, 0.45, rv);

      const grime = n.fbm2(u * 12, v * 12, 3) * 0.5 + 0.5;
      let l = 0.055 + grime * 0.05;
      l *= 1 - gapU * 0.7;
      l *= 0.45 + stepShade * 0.55;

      albedo[o] = clamp01(l * 0.9) * 255;
      albedo[o + 1] = clamp01(l * 0.95) * 255;
      albedo[o + 2] = clamp01(l * 1.15) * 255;
      albedo[o + 3] = 255;

      orm[o] = clamp01(0.35 + stepShade * 0.5 - gapU * 0.3) * 255;
      orm[o + 1] = clamp01(0.82 + grime * 0.16) * 255;   // fabric + matte plastic
      orm[o + 2] = 20;
      orm[o + 3] = 255;

      height[i] = (1 - gapU) * 0.35 + stepShade * 0.2 - 0.1;
    }
  }

  const mk = (arr, srgb) => {
    const { c, g } = ctx2d(size);
    g.putImageData(new ImageData(arr, size, size), 0, 0);
    return toTexture(c, { srgb, aniso: 4 });
  };

  const res = {
    map: mk(albedo, true),
    ormMap: mk(orm, false),
    normalMap: toTexture(heightToNormal(height, size, 1.4), { aniso: 4 }),
  };
  cache.set(key, res);
  return res;
}

/**
 * The crowd: the only part of a gallery that knows which arena it is sitting
 * in. Two colours interact here (accent hand-lights and a scatter of warm
 * ones), so unlike the plating this genuinely cannot collapse into a tint —
 * but it is pure integer hashing with no noise in it, which makes it about the
 * cheapest map in the file to re-bake per theme.
 */
function galleryEmissive(theme, size) {
  const key = `gallery-emis:${theme.key}:${size}`;
  if (cache.has(key)) return cache.get(key);

  const acc = hex(theme.accent);
  const warm = hex(theme.crowdWarm ?? 0xffb066);
  const emis = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const o = (y * size + x) * 4;

      const rowF = v * GALLERY_ROWS, row = Math.floor(rowF), rv = rowF - row;
      const seatF = u * GALLERY_SEATS + (row & 1) * 0.35, seat = Math.floor(seatF);
      const su = seatF - seat;

      const sid = (Math.imul(row + 3, 40499) ^ Math.imul(seat + 11, 86111)) >>> 0;
      const sr = (sid % 65536) / 65536;

      // A sparse scatter of hand-lights, mostly the arena accent with a few
      // warm ones so the bank doesn't read as a single flat colour.
      let er = 0, eg = 0, eb = 0;
      if (sr > 0.90 && su > 0.2 && su < 0.8 && rv > 0.25 && rv < 0.75) {
        const dot = (1 - smoothstep(0.12, 0.3, Math.hypot(su - 0.5, (rv - 0.5) * 1.4)));
        const warmOne = sr > 0.975;
        const c = warmOne ? warm : acc;
        const amp = dot * (warmOne ? 1.5 : 1.1);
        er = c.r * amp; eg = c.g * amp; eb = c.b * amp;
      }
      // Aisle strip lighting every eighth seat column: guides the eye around
      // the bowl and gives the tiers a legible rhythm.
      if (Math.abs((seatF / 8) % 1 - 0.5) > 0.482) {
        er += acc.r * 0.5; eg += acc.g * 0.5; eb += acc.b * 0.5;
      }

      emis[o] = clamp01(er) * 255;
      emis[o + 1] = clamp01(eg) * 255;
      emis[o + 2] = clamp01(eb) * 255;
      emis[o + 3] = 255;
    }
  }

  const { c, g } = ctx2d(size);
  g.putImageData(new ImageData(emis, size, size), 0, 0);
  const t = toTexture(c, { srgb: true, aniso: 4 });
  cache.set(key, t);
  return t;
}

/**
 * A packed, near-black seating bank speckled with crowd lights. The gallery
 * exists to be *dark* — it frames the lit deck. All the information is in the
 * emissive channel, which costs nothing and survives bloom beautifully.
 */
export function galleryTexture(theme, size = 256) {
  return { ...galleryBase(size), emissiveMap: galleryEmissive(theme, size) };
}

// ---------------------------------------------------------------------------
// Banner / jumbotron band
// ---------------------------------------------------------------------------

/** Four panels across the tile, each with its own content block. */
const SCREEN_PANELS = 4;

/** Bezel + dead glass. Same hardware in every venue, so it bakes once. */
function screenBase(size) {
  const key = `screen-base:${size}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0x5c33);
  const albedo = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const o = (y * size + x) * 4;

      const pF = u * SCREEN_PANELS, pu = pF - Math.floor(pF);
      const bez = Math.min(Math.min(pu, 1 - pu) * SCREEN_PANELS, Math.min(v, 1 - v));
      const inScreen = smoothstep(0.055, 0.075, bez);
      const frame = 1 - inScreen;

      // The frame is dark structural metal; the panel face is near-black glass.
      const fl = frame > 0.5 ? 0.09 + n.fbm2(u * 20, v * 20, 2) * 0.03 : 0.015;
      albedo[o] = fl * 235;
      albedo[o + 1] = fl * 240;
      albedo[o + 2] = fl * 255;
      albedo[o + 3] = 255;

      orm[o] = clamp01(0.6 + inScreen * 0.4) * 255;
      orm[o + 1] = frame > 0.5 ? 150 : 40;
      orm[o + 2] = frame > 0.5 ? 200 : 30;
      orm[o + 3] = 255;
    }
  }

  const mk = (arr, srgb) => {
    const { c, g } = ctx2d(size);
    g.putImageData(new ImageData(arr, size, size), 0, 0);
    return toTexture(c, { srgb, aniso: 4 });
  };

  const res = { map: mk(albedo, true), ormMap: mk(orm, false) };
  cache.set(key, res);
  return res;
}

/** The broadcast itself — the half of a jumbotron that carries the league's colour. */
function screenEmissive(theme, size) {
  const key = `screen-emis:${theme.key}:${size}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0x5c33 + theme.accent);
  const acc = hex(theme.accent);
  const hot = hex(theme.emissive);
  const emis = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const o = (y * size + x) * 4;

      const pF = u * SCREEN_PANELS, p = Math.floor(pF), pu = pF - p;
      const pr = cellRand(p * 31 + 7);

      const bez = Math.min(Math.min(pu, 1 - pu) * SCREEN_PANELS, Math.min(v, 1 - v));
      const inScreen = smoothstep(0.055, 0.075, bez);

      let er = 0, eg = 0, eb = 0;

      if (inScreen > 0.5) {
        const su = (pu - 0.09) / 0.82;
        const sv = (v - 0.09) / 0.82;

        if (pr < 0.4) {
          // Wordmark: heavy bars, the league name as pure shape.
          const bar = stencilMark((p * 2654435761) >>> 0, (su - 0.06) / 0.88, (sv - 0.3) / 0.4);
          er = acc.r * bar * 2.6; eg = acc.g * bar * 2.6; eb = acc.b * bar * 2.6;
        } else if (pr < 0.72) {
          // Telemetry ladder: a stacked bar chart that reads as live data.
          const col = Math.floor(su * 14);
          const cr = cellRand(col * 17 + p * 5);
          const barTop = 0.15 + cr * 0.7;
          const lit = sv > (1 - barTop) && Math.abs((su * 14) % 1 - 0.5) < 0.34 ? 1 : 0;
          const hotBar = cr > 0.78 ? 1 : 0;
          const c = hotBar ? hot : acc;
          er = c.r * lit * 2.2; eg = c.g * lit * 2.2; eb = c.b * lit * 2.2;
        } else {
          // Sweeping gradient wash with a marquee band.
          const wash = 0.25 + 0.35 * Math.sin(sv * 5.0 + p);
          const band = 1 - smoothstep(0.05, 0.14, Math.abs(sv - 0.5));
          er = acc.r * (wash * 0.5 + band * 1.8);
          eg = acc.g * (wash * 0.5 + band * 1.8);
          eb = acc.b * (wash * 0.5 + band * 1.8);
        }

        // Scanlines + a little sensor grain: sells "emissive display" over
        // "glowing rectangle".
        const scan = 0.72 + 0.28 * Math.sin(v * size * 0.55);
        const grain = 0.9 + n.simplex2(u * 300, v * 300) * 0.12;
        er *= scan * grain; eg *= scan * grain; eb *= scan * grain;
      }

      emis[o] = clamp01(er) * 255;
      emis[o + 1] = clamp01(eg) * 255;
      emis[o + 2] = clamp01(eb) * 255;
      emis[o + 3] = 255;
    }
  }

  const { c, g } = ctx2d(size);
  g.putImageData(new ImageData(emis, size, size), 0, 0);
  const t = toTexture(c, { srgb: true, aniso: 4 });
  cache.set(key, t);
  return t;
}

/**
 * The ring of screens above the galleries. Mostly emissive: at arena distance
 * the content only has to read as "moving league broadcast", so it is built
 * from wordmark bars, a telemetry ladder and scanlines.
 */
export function screenTexture(theme, size = 256) {
  return { ...screenBase(size), emissiveMap: screenEmissive(theme, size) };
}

// ---------------------------------------------------------------------------
// Hazard chevrons
// ---------------------------------------------------------------------------

/**
 * Diagonal warning stripes, laid as thin decal bands around obstacle skirts.
 * This is the single cheapest cue that a block is a built, maintained object
 * rather than a grey box the level designer left behind.
 *
 * Theme-independent, like the plating: the stripe was `mix(near-black, warn)`,
 * which is a tint, so it bakes white once and stage.js sets `material.color` to
 * the theme's hazard colour. The dark half of the stripe stays dark under any
 * tint because 0.04 times anything is still 0.04.
 */
export function hazardTexture(size = 64) {
  const key = `hazard:${size}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0x4a2d);
  const warn = { r: 1, g: 1, b: 1 };

  const albedo = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      const o = i * 4;

      // 45-degree stripes: period 0.25 in u so the band tiles cleanly.
      const s = ((u + v * 0.5) * 8) % 1;
      const stripe = smoothstep(0.46, 0.54, s);

      // Paint wears off the raised edges of the band first.
      const wear = clamp01(n.fbm2(u * 18, v * 18, 3) * 0.5 + 0.5);
      const chip = smoothstep(0.62, 0.88, wear);

      let r = mix(0.04, warn.r, stripe);
      let g = mix(0.04, warn.g, stripe);
      let b = mix(0.045, warn.b, stripe);
      r = mix(r, 0.3, chip * 0.55);
      g = mix(g, 0.31, chip * 0.55);
      b = mix(b, 0.33, chip * 0.55);

      // Edge grime along the top and bottom of the band.
      const edge = Math.min(v, 1 - v);
      const soot = 1 - smoothstep(0.06, 0.3, edge);
      r *= 1 - soot * 0.45; g *= 1 - soot * 0.45; b *= 1 - soot * 0.45;

      albedo[o] = clamp01(r) * 255;
      albedo[o + 1] = clamp01(g) * 255;
      albedo[o + 2] = clamp01(b) * 255;
      albedo[o + 3] = 255;

      orm[o] = clamp01(1 - soot * 0.5) * 255;
      orm[o + 1] = clamp01(0.62 + wear * 0.3) * 255;   // painted, so fairly matte
      orm[o + 2] = clamp01(0.1 + chip * 0.6) * 255;    // bare metal in the chips
      orm[o + 3] = 255;

      height[i] = stripe * 0.08 + wear * 0.05 - soot * 0.1;
    }
  }

  const mk = (arr, srgb) => {
    const { c, g } = ctx2d(size);
    g.putImageData(new ImageData(arr, size, size), 0, 0);
    return toTexture(c, { srgb, aniso: 8 });
  };

  const res = {
    map: mk(albedo, true),
    ormMap: mk(orm, false),
    normalMap: toTexture(heightToNormal(height, size, 1.2), { aniso: 4 }),
  };
  cache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------
// Walls / structures
// ---------------------------------------------------------------------------

/**
 * The arena boundary wall, authored as a single full-height ELEVATION rather
 * than a tiling swatch: v = 0 is the deck, v = 1 is the top rail, and the tile
 * repeats horizontally only. That is the difference between "a wall" and "a
 * stripe pattern that happens to be vertical" — the old map ran sixteen
 * identical ribs top to bottom, which is why all four walls read the same and
 * gave the eye nothing to measure the arena against.
 *
 * Storeys, bottom to top:
 *   plinth · armoured plating (two courses) · service gutter · capping course
 *
 * Two bays per tile, hashed differently, so the repeat period is 2 bays and the
 * wall never reads as a single stamped module.
 */
export function wallTexture(theme, size = 512) {
  const key = `wall:${theme.key}:${size}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0xa11 + theme.wall);
  const base = hex(theme.wall);
  const acc = hex(theme.accent);
  const warn = hex(theme.hazard ?? 0xf5b21e);

  const albedo = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const emis = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);

  const BAYS = 2;
  // Storey boundaries in v.
  const V_PLINTH = 0.085;
  const V_MID = 0.46;       // course break inside the plating
  const V_GUTTER = 0.79;
  const V_CAP = 0.87;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      const o = i * 4;

      const bayF = u * BAYS;
      const bay = Math.floor(bayF);
      const bu = bayF - bay;
      const br = cellRand(bay * 977 + 13);

      // Pilaster: a structural column standing proud at every bay joint. This
      // is the vertical rhythm the old wall was missing entirely.
      const pil = 1 - smoothstep(0.035, 0.055, Math.min(bu, 1 - bu));
      const pilEdge = 1 - smoothstep(0.055, 0.07, Math.min(bu, 1 - bu));

      const grunge = n.fbm2(u * 8, v * 8, 3) * 0.5 + 0.5;
      // Weathering runs DOWN a wall. Streaking it along u was another reason
      // the old surface read as abstract stripes rather than as a built thing.
      const streak = clamp01(n.fbm2(u * 44, v * 2.6, 2) * 0.5 + 0.5);

      let l = 1;            // luminance multiplier on the base wall colour
      let rough = 0.5 + grunge * 0.3 + streak * 0.14;
      let metal = 0.5 - grunge * 0.2;
      let h = 0;
      let e = 0;            // accent emissive
      let warm = 0;         // warm emissive (service lamps)
      let hz = 0;           // hazard paint coverage
      let paint = 0;        // chalky stencil paint coverage

      if (v < V_PLINTH) {
        // Plinth: a heavy dark kick course, scuffed where robots scrape it.
        l = 0.42 + grunge * 0.16;
        h = -0.25 + smoothstep(V_PLINTH * 0.75, V_PLINTH, v) * 0.5;
        rough += 0.15;
        // Hazard chevrons wrap the base of the wall — the warm ring that tells
        // you where the play area stops.
        const s = ((u * 34 + v * 3) % 1);
        hz = smoothstep(0.46, 0.54, s) * smoothstep(0.012, 0.03, v) *
             smoothstep(V_PLINTH, V_PLINTH - 0.03, v);
      } else if (v < V_GUTTER) {
        // Main armoured plating: two courses, panel seams, bolt lines.
        const course = v < V_MID ? 0 : 1;
        const cv0 = course === 0 ? V_PLINTH : V_MID;
        const cv1 = course === 0 ? V_MID : V_GUTTER;
        const pv = (v - cv0) / (cv1 - cv0);
        const pid = (Math.imul(bay + 1, 7919) ^ Math.imul(course + 5, 104729)) >>> 0;
        const pr = (pid % 65536) / 65536;

        // Two plates per bay per course.
        const plateF = bu * 2, plate = Math.floor(plateF), pu = plateF - plate;
        const dEdge = Math.min(Math.min(pu, 1 - pu) * 0.5, Math.min(pv, 1 - pv) * 0.9);
        const groove = 1 - smoothstep(0.006, 0.016, dEdge);
        const bevel = smoothstep(0.012, 0.05, dEdge);

        l = (0.78 + grunge * 0.34) * (1 - groove * 0.72) * (0.95 + bevel * 0.1);
        h = bevel * 0.35 - groove * 0.6 + grunge * 0.05;

        // Bolt line along the top and bottom rail of each plate.
        const bd = Math.hypot(((pu * 8) % 1 - 0.5) / 8, Math.min(pv, 1 - pv) - 0.035);
        if (dEdge > 0.016 && bd < 0.012) {
          const head = 1 - smoothstep(0.006, 0.012, bd);
          h += head * 0.4;
          l *= 1 + head * 0.2;
          rough -= head * 0.15;
        }

        // Per-plate content: vent grille, stencilled bay number, or blank.
        if (dEdge > 0.05) {
          if (pr > 0.72) {
            const lo = Math.abs(((pv * 9) % 1) - 0.5);
            const slot = 1 - smoothstep(0.2, 0.36, lo);
            h -= slot * 0.5;
            l *= 1 - slot * 0.62;
            metal += slot * 0.25;
          } else if (pr > 0.5) {
            const mk = stencilMark(pid, (pu - 0.3) / 0.4, (pv - 0.42) / 0.16);
            paint = mk * 0.62;              // chalky stencil paint, not glowing
            rough += mk * 0.3;
            metal -= mk * 0.4;
          }
        }

        // One service lamp per lit bay, in its own warm colour: the arena has
        // maintenance lighting, and the warm/cool split is what stops every
        // frame from being one temperature.
        if (br > 0.55 && course === 1) {
          const ld = Math.hypot((bu - 0.5) * 1.4, pv - 0.72);
          warm = (1 - smoothstep(0.012, 0.03, ld)) * 2.2;
        }
      } else if (v < V_CAP) {
        // Service gutter: a deep dark recess carrying the perimeter light rail.
        const gv = (v - V_GUTTER) / (V_CAP - V_GUTTER);
        l = 0.16 + grunge * 0.06;
        h = -0.55;
        rough += 0.1;
        // The rail itself: thin, continuous, and the only horizontal glow line
        // left on the wall.
        e = (1 - smoothstep(0.1, 0.32, Math.abs(gv - 0.5))) * 1.5;
      } else {
        // Capping course: brighter machined coping that catches the rig light
        // and draws a clean bright line along the top of the bowl.
        const cvv = (v - V_CAP) / (1 - V_CAP);
        l = (1.05 + grunge * 0.25) * (0.8 + smoothstep(0.0, 0.35, cvv) * 0.45);
        h = 0.45 - smoothstep(0.85, 1.0, cvv) * 0.5;
        rough -= 0.12;
        metal += 0.15;
      }

      // Pilasters read across every storey — that is what makes them columns.
      l *= 1 - pil * 0.5 + pilEdge * 0.12;
      h += pilEdge * 0.22 - pil * 0.3;

      // Grime pools down the wall and under every lip.
      l *= 1 - streak * 0.22;

      let r = base.r * l, g = base.g * l, b = base.b * l;
      r = mix(r, 0.52, paint); g = mix(g, 0.54, paint); b = mix(b, 0.56, paint);
      r = mix(r, warn.r * 0.85, hz);
      g = mix(g, warn.g * 0.85, hz);
      b = mix(b, warn.b * 0.85, hz);

      albedo[o] = clamp01(r) * 255;
      albedo[o + 1] = clamp01(g) * 255;
      albedo[o + 2] = clamp01(b) * 255;
      albedo[o + 3] = 255;

      emis[o] = clamp01(acc.r * e + warn.r * warm) * 255;
      emis[o + 1] = clamp01(acc.g * e + warn.g * warm * 0.8) * 255;
      emis[o + 2] = clamp01(acc.b * e + warn.b * warm * 0.6) * 255;
      emis[o + 3] = 255;

      orm[o] = clamp01(0.9 - pil * 0.35 + h * 0.2) * 255;
      orm[o + 1] = clamp01(rough) * 255;
      orm[o + 2] = clamp01(metal) * 255;
      orm[o + 3] = 255;

      height[i] = h;
    }
  }

  const mk = (arr, srgb) => {
    const { c, g } = ctx2d(size);
    g.putImageData(new ImageData(arr, size, size), 0, 0);
    return toTexture(c, { srgb, aniso: 8 });
  };

  const res = {
    map: mk(albedo, true),
    ormMap: mk(orm, false),
    emissiveMap: mk(emis, true),
    normalMap: toTexture(heightToNormal(height, size, 2.0), { aniso: 8 }),
  };
  cache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------
// Sprites for VFX (radial falloffs, drawn with canvas gradients — fast + exact)
// ---------------------------------------------------------------------------

function radialSprite(size, stops, { power = 1 } = {}) {
  const { c, g } = ctx2d(size);
  const img = g.createImageData(size, size);
  const d = img.data;
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half + 0.5) / half;
      const dy = (y - half + 0.5) / half;
      const r = Math.min(1, Math.hypot(dx, dy));
      const t = Math.pow(1 - r, power);
      let cr = 0, cg = 0, cb = 0, ca = 0;
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i], b = stops[i + 1];
        if (r >= a[0] && r <= b[0]) {
          const k = (r - a[0]) / Math.max(1e-5, b[0] - a[0]);
          cr = mix(a[1], b[1], k); cg = mix(a[2], b[2], k);
          cb = mix(a[3], b[3], k); ca = mix(a[4], b[4], k);
          break;
        }
      }
      const o = (y * size + x) * 4;
      d[o] = clamp01(cr) * 255;
      d[o + 1] = clamp01(cg) * 255;
      d[o + 2] = clamp01(cb) * 255;
      d[o + 3] = clamp01(ca * t) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

let _sprites = null;

export function sprites() {
  if (_sprites) return _sprites;

  // [radius, r, g, b, a]
  const glow = radialSprite(128, [
    [0.0, 1.0, 1.0, 1.0, 1.0],
    [0.18, 0.85, 0.95, 1.0, 0.9],
    [0.5, 0.35, 0.6, 1.0, 0.30],
    [1.0, 0.0, 0.0, 0.0, 0.0],
  ], { power: 1.6 });

  const spark = radialSprite(64, [
    [0.0, 1.0, 1.0, 0.95, 1.0],
    [0.3, 1.0, 0.85, 0.5, 0.85],
    [1.0, 1.0, 0.4, 0.1, 0.0],
  ], { power: 2.2 });

  // Smoke: turbulent alpha so puffs don't read as circles.
  const smokeSize = 128;
  const { c: sc, g: sg } = ctx2d(smokeSize);
  {
    const n = new Noise(0x5107);
    const img = sg.createImageData(smokeSize, smokeSize);
    const d = img.data;
    const half = smokeSize / 2;
    for (let y = 0; y < smokeSize; y++) {
      for (let x = 0; x < smokeSize; x++) {
        const dx = (x - half + 0.5) / half, dy = (y - half + 0.5) / half;
        const r = Math.hypot(dx, dy);
        const turb = n.fbm2(x / smokeSize * 4.5, y / smokeSize * 4.5, 5) * 0.5 + 0.5;
        const a = clamp01((1 - smoothstep(0.15, 1.0, r)) * (0.45 + turb * 0.85) - 0.12);
        const o = (y * smokeSize + x) * 4;
        const l = 0.22 + turb * 0.3;
        d[o] = l * 255; d[o + 1] = l * 255; d[o + 2] = l * 255;
        d[o + 3] = a * 255;
      }
    }
    sg.putImageData(img, 0, 0);
  }

  // Shockwave ring.
  const ringSize = 256;
  const { c: rc, g: rg } = ctx2d(ringSize);
  {
    const img = rg.createImageData(ringSize, ringSize);
    const d = img.data;
    const half = ringSize / 2;
    for (let y = 0; y < ringSize; y++) {
      for (let x = 0; x < ringSize; x++) {
        const dx = (x - half + 0.5) / half, dy = (y - half + 0.5) / half;
        const r = Math.hypot(dx, dy);
        const band = Math.exp(-Math.pow((r - 0.78) / 0.10, 2));
        const inner = Math.exp(-Math.pow((r - 0.6) / 0.28, 2)) * 0.22;
        const a = clamp01(band + inner) * (r < 1 ? 1 : 0);
        const o = (y * ringSize + x) * 4;
        d[o] = 255; d[o + 1] = 250 * (0.7 + band * 0.3); d[o + 2] = 235;
        d[o + 3] = a * 255;
      }
    }
    rg.putImageData(img, 0, 0);
  }

  // Anamorphic-ish flare streak.
  const flareSize = 256;
  const { c: fc, g: fg } = ctx2d(flareSize);
  {
    const img = fg.createImageData(flareSize, flareSize);
    const d = img.data;
    const half = flareSize / 2;
    for (let y = 0; y < flareSize; y++) {
      for (let x = 0; x < flareSize; x++) {
        const dx = (x - half + 0.5) / half, dy = (y - half + 0.5) / half;
        const streak = Math.exp(-Math.pow(dy / 0.045, 2)) * Math.exp(-Math.pow(dx / 0.75, 2));
        const core = Math.exp(-(dx * dx + dy * dy) / 0.012);
        const a = clamp01(streak * 0.9 + core);
        const o = (y * flareSize + x) * 4;
        d[o] = 255; d[o + 1] = 245; d[o + 2] = 255;
        d[o + 3] = a * 255;
      }
    }
    fg.putImageData(img, 0, 0);
  }

  // Soft contact shadow blob.
  const shadow = radialSprite(128, [
    [0.0, 0, 0, 0, 0.85],
    [0.55, 0, 0, 0, 0.45],
    [1.0, 0, 0, 0, 0.0],
  ], { power: 1.3 });

  const mk = (cv, srgb = true) => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  };

  _sprites = {
    glow: mk(glow),
    spark: mk(spark),
    smoke: mk(sc),
    ring: mk(rc),
    flare: mk(fc),
    shadow: mk(shadow),
  };
  return _sprites;
}

/** 1D gradient ramp used for energy trails and heat. */
export function rampTexture(colors, width = 128) {
  const c = document.createElement('canvas');
  c.width = width; c.height = 1;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, width, 0);
  for (const [stop, col] of colors) grad.addColorStop(stop, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, width, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** Blue-noise-ish dither tile for banding-free gradients. */
export function ditherTexture(size = 64) {
  const key = `dither:${size}`;
  if (cache.has(key)) return cache.get(key);
  const { c, g } = ctx2d(size);
  const img = g.createImageData(size, size);
  const d = img.data;
  const n = new Noise(0xd17e);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const v = (n.simplex2(x * 0.9, y * 0.9) * 0.5 + 0.5) * 255;
      d[o] = d[o + 1] = d[o + 2] = v;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = toTexture(c, { srgb: false, aniso: 1 });
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  cache.set(key, t);
  return t;
}

export function disposeTextureCache() {
  for (const v of cache.values()) {
    if (v?.isTexture) v.dispose();
    else if (v && typeof v === 'object') {
      for (const t of Object.values(v)) t?.isTexture && t.dispose();
    }
  }
  cache.clear();
  _sprites = null;
}
