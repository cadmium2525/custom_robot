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
import { Noise, worley2, smoothstep, mix, clamp01 } from './noise.js';

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
      const metal = clamp01((look.metalness ?? 0.9) * (1 - stripe * 0.55) - wear * 0.12);

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
// Arena floor
// ---------------------------------------------------------------------------

export function floorTexture(theme, size = 1024) {
  const key = `floor:${theme.key}:${size}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0xf100 + theme.floor);
  const base = hex(theme.floor);
  const acc = hex(theme.floorAccent);

  const albedo = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const emis = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);

  const cells = 8;          // tiles across the texture
  const lineW = 0.012;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      const o = i * 4;

      const cu = (u * cells) % 1;
      const cv = (v * cells) % 1;
      const ci = Math.floor(u * cells) + Math.floor(v * cells) * cells;
      const cr = ((ci * 2654435761) >>> 0) / 4294967296;

      const edge = Math.min(Math.min(cu, 1 - cu), Math.min(cv, 1 - cv));
      const seam = 1 - smoothstep(lineW, lineW * 2.2, edge);
      const glowLine = 1 - smoothstep(lineW * 0.35, lineW * 1.3, edge);

      // Inner tile detail: an inset frame plus corner notches.
      const inner = smoothstep(0.055, 0.075, edge);
      const notch = (cu < 0.09 || cu > 0.91) && (cv < 0.09 || cv > 0.91) ? 1 : 0;

      const grime = n.fbm2(u * 6, v * 6, 5) * 0.5 + 0.5;
      const speck = n.fbm2(u * 90, v * 90, 2) * 0.5 + 0.5;
      const scratch = smoothstep(0.55, 0.85, worley2(u * 26, v * 26, 3));

      let r = base.r * (0.75 + grime * 0.5) * (0.9 + cr * 0.18);
      let g = base.g * (0.75 + grime * 0.5) * (0.9 + cr * 0.18);
      let b = base.b * (0.75 + grime * 0.5) * (0.9 + cr * 0.18);

      r *= 1 - seam * 0.55; g *= 1 - seam * 0.55; b *= 1 - seam * 0.55;
      r = mix(r, r * 1.25, inner * 0.4);
      g = mix(g, g * 1.25, inner * 0.4);
      b = mix(b, b * 1.25, inner * 0.4);
      r = mix(r, 0.55, scratch * 0.12);
      g = mix(g, 0.57, scratch * 0.12);
      b = mix(b, 0.6, scratch * 0.12);

      albedo[o] = clamp01(r) * 255;
      albedo[o + 1] = clamp01(g) * 255;
      albedo[o + 2] = clamp01(b) * 255;
      albedo[o + 3] = 255;

      // Emissive grid lines, brighter on a scattering of "live" tiles.
      const live = cr > 0.82 ? 1 : 0.42;
      const e = glowLine * live + notch * 0.5 * live;
      emis[o] = clamp01(acc.r * e) * 255;
      emis[o + 1] = clamp01(acc.g * e) * 255;
      emis[o + 2] = clamp01(acc.b * e) * 255;
      emis[o + 3] = 255;

      orm[o] = clamp01(1 - seam * 0.6) * 255;
      orm[o + 1] = clamp01(0.34 + grime * 0.4 + scratch * 0.18 - glowLine * 0.2) * 255;
      orm[o + 2] = clamp01(0.55 + speck * 0.25 - scratch * 0.2) * 255;
      orm[o + 3] = 255;

      height[i] = inner * 0.35 - seam * 0.6 + grime * 0.05 + notch * 0.15;
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
    normalMap: toTexture(heightToNormal(height, size, 1.6), { aniso: 8 }),
  };
  cache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------
// Walls / structures
// ---------------------------------------------------------------------------

export function wallTexture(theme, size = 512) {
  const key = `wall:${theme.key}:${size}`;
  if (cache.has(key)) return cache.get(key);

  const n = new Noise(0xa11 + theme.wall);
  const base = hex(theme.wall);
  const acc = hex(theme.accent);

  const albedo = new Uint8ClampedArray(size * size * 4);
  const orm = new Uint8ClampedArray(size * size * 4);
  const emis = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const i = y * size + x;
      const o = i * 4;

      // Horizontal ribbing with a heavier band every fourth rib.
      const rib = (v * 16) % 1;
      const ribEdge = Math.min(rib, 1 - rib);
      const ribShade = smoothstep(0.0, 0.14, ribEdge);
      const major = Math.floor(v * 16) % 4 === 0 ? 1 : 0;

      const col = (u * 10) % 1;
      const colEdge = Math.min(col, 1 - col);
      const colSeam = 1 - smoothstep(0.008, 0.02, colEdge);

      const grunge = n.fbm2(u * 8, v * 8, 5) * 0.5 + 0.5;
      const streak = clamp01(n.fbm2(u * 40, v * 3.2, 3) * 0.5 + 0.5);

      const shade = (0.7 + ribShade * 0.4) * (0.8 + grunge * 0.4) * (1 - colSeam * 0.5);
      let r = base.r * shade, g = base.g * shade, b = base.b * shade;
      r = mix(r, r * 0.7, streak * 0.35);
      g = mix(g, g * 0.7, streak * 0.35);
      b = mix(b, b * 0.72, streak * 0.35);

      albedo[o] = clamp01(r) * 255;
      albedo[o + 1] = clamp01(g) * 255;
      albedo[o + 2] = clamp01(b) * 255;
      albedo[o + 3] = 255;

      // Thin light strip riding the major ribs.
      const strip = major * (1 - smoothstep(0.02, 0.09, ribEdge)) * 0.9;
      emis[o] = clamp01(acc.r * strip) * 255;
      emis[o + 1] = clamp01(acc.g * strip) * 255;
      emis[o + 2] = clamp01(acc.b * strip) * 255;
      emis[o + 3] = 255;

      orm[o] = clamp01(0.35 + ribShade * 0.65) * 255;
      orm[o + 1] = clamp01(0.42 + grunge * 0.4 + streak * 0.15) * 255;
      orm[o + 2] = clamp01(0.62 - grunge * 0.25) * 255;
      orm[o + 3] = 255;

      height[i] = ribShade * 0.5 - colSeam * 0.4 + major * 0.12 + grunge * 0.06;
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
        const l = 0.6 + turb * 0.4;
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
