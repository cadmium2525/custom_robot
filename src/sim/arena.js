/**
 * Holosseum definitions.
 *
 * These are pure data: the sim uses `boxes` for collision, the renderer uses the
 * same boxes plus `theme` to build the visual stage. One list, so what you see
 * is exactly what you hit.
 *
 * Box convention: centre (x,y,z) with half-extents (hx,hy,hz), optional `yaw`
 * rotation about Y. Floor sits at y = 0.
 */

const box = (x, y, z, hx, hy, hz, kind = 'block', yaw = 0, extra = {}) => ({
  x, y, z, hx, hy, hz, yaw, kind, ...extra,
});

export const ARENAS = [
  {
    id: 'grid',
    name: 'NEON GRID',
    kana: 'ネオングリッド',
    blurb: 'The league default. Clean sightlines, nowhere to hide.',
    bounds: { hx: 21, hz: 21, ceil: 15 },
    spawns: [
      { x: 0, z: -14, yaw: 0 },
      { x: 0, z: 14, yaw: Math.PI },
    ],
    boxes: [
      box(0, 0.55, 0, 4.4, 0.55, 4.4, 'dais'),
      box(-9.5, 1.1, -9.5, 1.7, 1.1, 1.7, 'block'),
      box(9.5, 1.1, -9.5, 1.7, 1.1, 1.7, 'block'),
      box(-9.5, 1.1, 9.5, 1.7, 1.1, 1.7, 'block'),
      box(9.5, 1.1, 9.5, 1.7, 1.1, 1.7, 'block'),
      box(-14.5, 2.2, 0, 1.2, 2.2, 3.6, 'pillar'),
      box(14.5, 2.2, 0, 1.2, 2.2, 3.6, 'pillar'),
      // Waist-high cover, pulled off the centre line: it should reward angles,
      // not wall off the opening exchange between the two spawns.
      box(-6.8, 0.45, -7.5, 3.6, 0.45, 0.6, 'rail'),
      box(6.8, 0.45, 7.5, 3.6, 0.45, 0.6, 'rail'),
    ],
    theme: {
      key: 'grid',
      floor: 0x232c3a,
      floorAccent: 0x2f6bd6,
      wall: 0x252d3a,
      accent: 0x4aa8ff,
      emissive: 0x59b7ff,
      fog: 0x070a10,
      fogDensity: 0.0085,
      skyTop: 0x0a1424,
      skyBottom: 0x02040a,
      sunDir: [0.45, 0.78, 0.44],
      sunColour: 0xfff0d8,
      sunIntensity: 4.2,
      rimColour: 0x2f6bd6,
      crowd: true,
      // Ambient bands of light that sweep the arena floor.
      sweep: true,
    },
  },
  {
    id: 'foundry',
    name: 'MAGMA FOUNDRY',
    kana: 'マグマ工廠',
    blurb: 'Heat haze, moving light, and a very short patience.',
    bounds: { hx: 19, hz: 23, ceil: 16 },
    spawns: [
      { x: -12, z: -15, yaw: Math.PI * 0.25 },
      { x: 12, z: 15, yaw: Math.PI * 1.25 },
    ],
    boxes: [
      box(0, 1.4, 0, 6.0, 1.4, 2.4, 'dais', Math.PI * 0.25),
      box(-11, 2.6, 4, 2.2, 2.6, 2.2, 'pillar'),
      box(11, 2.6, -4, 2.2, 2.6, 2.2, 'pillar'),
      box(-6, 0.7, -11, 3.4, 0.7, 1.6, 'block', -0.3),
      box(6, 0.7, 11, 3.4, 0.7, 1.6, 'block', -0.3),
      box(0, 3.6, -17, 8.0, 3.6, 1.0, 'wallblock'),
      box(0, 3.6, 17, 8.0, 3.6, 1.0, 'wallblock'),
      box(-15, 1.0, -2, 1.4, 1.0, 5.0, 'rail'),
      box(15, 1.0, 2, 1.4, 1.0, 5.0, 'rail'),
    ],
    theme: {
      key: 'foundry',
      floor: 0x2e211b,
      floorAccent: 0xff6a1a,
      wall: 0x33211a,
      accent: 0xff8c2a,
      emissive: 0xff5a10,
      fog: 0x160806,
      fogDensity: 0.015,
      skyTop: 0x2a0d05,
      skyBottom: 0x0a0302,
      sunDir: [-0.4, 0.7, 0.55],
      sunColour: 0xffb680,
      sunIntensity: 3.6,
      rimColour: 0xff5a10,
      crowd: false,
      heat: true,
      lavaGlow: true,
    },
  },
  {
    id: 'orbital',
    name: 'ORBITAL RING',
    kana: 'オービタルリング',
    blurb: 'Low gravity aesthetics, full gravity consequences.',
    bounds: { hx: 20, hz: 20, ceil: 18 },
    spawns: [
      { x: -13, z: -13, yaw: Math.PI * 0.25 },
      { x: 13, z: 13, yaw: Math.PI * 1.25 },
    ],
    boxes: [
      box(0, 0.4, 0, 7.5, 0.4, 7.5, 'dais'),
      box(0, 2.4, 0, 2.0, 2.4, 2.0, 'pillar'),
      box(-8, 1.6, 0, 1.0, 1.6, 4.0, 'rail', Math.PI * 0.25),
      box(8, 1.6, 0, 1.0, 1.6, 4.0, 'rail', Math.PI * 0.25),
      box(0, 1.6, -8, 4.0, 1.6, 1.0, 'rail', Math.PI * 0.25),
      box(0, 1.6, 8, 4.0, 1.6, 1.0, 'rail', Math.PI * 0.25),
      box(-15, 3.0, -15, 2.6, 3.0, 2.6, 'pillar', Math.PI * 0.25),
      box(15, 3.0, 15, 2.6, 3.0, 2.6, 'pillar', Math.PI * 0.25),
    ],
    theme: {
      key: 'orbital',
      floor: 0x1b2434,
      floorAccent: 0x7de2ff,
      wall: 0x1d2637,
      accent: 0x7de2ff,
      emissive: 0x9df0ff,
      fog: 0x03060d,
      fogDensity: 0.006,
      skyTop: 0x050b18,
      skyBottom: 0x010206,
      sunDir: [0.2, 0.5, -0.84],
      sunColour: 0xdfeaff,
      sunIntensity: 3.4,
      rimColour: 0x7de2ff,
      crowd: true,
      stars: true,
      planet: true,
    },
  },
];

export const ARENA_BY_ID = new Map(ARENAS.map((a) => [a.id, a]));

export function getArena(id) {
  return ARENA_BY_ID.get(id) || ARENAS[0];
}

/**
 * Precompute per-box rotation terms so the collision inner loop never calls
 * trig. Call once per match, not per tick.
 */
export function prepareArena(arena) {
  if (arena._prepared) return arena;
  for (const b of arena.boxes) {
    b.cos = Math.cos(b.yaw || 0);
    b.sin = Math.sin(b.yaw || 0);
    b.top = b.y + b.hy;
    b.bottom = b.y - b.hy;
  }
  arena._prepared = true;
  return arena;
}
