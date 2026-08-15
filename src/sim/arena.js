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
    bounds: { hx: 16, hz: 16, ceil: 12 },
    spawns: [
      { x: 0, z: -10.5, yaw: 0 },
      { x: 0, z: 10.5, yaw: Math.PI },
    ],
    boxes: [
      box(0, 0.55, 0, 3.4, 0.55, 3.4, 'dais'),
      box(-7.2, 1.1, -7.2, 1.3, 1.1, 1.3, 'block'),
      box(7.2, 1.1, -7.2, 1.3, 1.1, 1.3, 'block'),
      box(-7.2, 1.1, 7.2, 1.3, 1.1, 1.3, 'block'),
      box(7.2, 1.1, 7.2, 1.3, 1.1, 1.3, 'block'),
      box(-11.2, 2.2, 0, 0.95, 2.2, 2.8, 'pillar'),
      box(11.2, 2.2, 0, 0.95, 2.2, 2.8, 'pillar'),
      // Waist-high cover, pulled off the centre line: it should reward angles,
      // not wall off the opening exchange between the two spawns.
      box(-5.2, 0.45, -5.7, 2.8, 0.45, 0.5, 'rail'),
      box(5.2, 0.45, 5.7, 2.8, 0.45, 0.5, 'rail'),
    ],
    /**
     * Every theme is built on the same four anchors, because a frame with no
     * value structure cannot be lit out of trouble:
     *
     *   deck   — the largest surface on screen and the value the robots are
     *            read against. It is the frame's LIGHT, which is not the same
     *            thing as the frame's WHITE: a 5.8-intensity key on a pale
     *            albedo lands the deck at 200+ and there is nowhere left to put
     *            a highlight. Authored so the LIT deck sits mid-band and the
     *            things that are supposed to be bright — rims, hazard paint,
     *            muzzle flash, tracers — are the only bright things.
     *   wall   — low boundary structure. Darker than the deck by a clear step,
     *            but not a void: a surround with no detail in it is 25% of the
     *            frame reading as a hole.
     *   struct — mid plating for obstacles and architecture, sitting between
     *            the two so blocks read as objects on a floor.
     *   hazard — the warm note. Nothing else in the arena is warm, which is
     *            exactly why it works.
     */
    theme: {
      key: 'grid',
      floor: 0x2b3442,
      deck: 0x5c6068,
      floorAccent: 0x2f6bd6,
      struct: 0x39424f,
      wall: 0x232a35,
      accent: 0x4aa8ff,
      emissive: 0x59b7ff,
      hazard: 0xffb01f,
      crowdWarm: 0xffa03c,
      fog: 0x05070d,
      fogDensity: 0.0034,
      skyTop: 0x0a1424,
      skyBottom: 0x02040a,
      sunDir: [0.45, 0.78, 0.44],
      sunColour: 0xfff2de,
      sunIntensity: 3.4,
      rimColour: 0x2f6bd6,
      crowd: true,
      screens: true,
      gates: true,
      // Ambient bands of light that sweep the arena floor.
      sweep: true,
    },
  },
  {
    id: 'foundry',
    name: 'MAGMA FOUNDRY',
    kana: 'マグマ工廠',
    blurb: 'Heat haze, moving light, and a very short patience.',
    bounds: { hx: 14.5, hz: 17.5, ceil: 13 },
    spawns: [
      { x: -9, z: -11.5, yaw: Math.PI * 0.25 },
      { x: 9, z: 11.5, yaw: Math.PI * 1.25 },
    ],
    boxes: [
      box(0, 1.4, 0, 4.6, 1.4, 1.8, 'dais', Math.PI * 0.25),
      box(-8.4, 2.6, 3, 1.7, 2.6, 1.7, 'pillar'),
      box(8.4, 2.6, -3, 1.7, 2.6, 1.7, 'pillar'),
      box(-4.6, 0.7, -8.4, 2.6, 0.7, 1.2, 'block', -0.3),
      box(4.6, 0.7, 8.4, 2.6, 0.7, 1.2, 'block', -0.3),
      box(0, 3.0, -13, 6.0, 3.0, 0.8, 'wallblock'),
      box(0, 3.0, 13, 6.0, 3.0, 0.8, 'wallblock'),
      box(-11.4, 1.0, -1.5, 1.1, 1.0, 3.8, 'rail'),
      box(11.4, 1.0, 1.5, 1.1, 1.0, 3.8, 'rail'),
    ],
    /**
     * The foundry is the one warm arena, so the counter-note inverts: the fill
     * light and the crowd lamps go cold. A hot arena rendered entirely in hot
     * colours is just as monochrome as a cold one.
     */
    theme: {
      key: 'foundry',
      floor: 0x352a22,
      deck: 0x7a6f62,
      floorAccent: 0xff6a1a,
      struct: 0x4b3b2e,
      wall: 0x160e08,
      accent: 0xff8c2a,
      emissive: 0xff5a10,
      hazard: 0xffd24a,
      crowdWarm: 0x8fd0ff,
      fog: 0x120705,
      fogDensity: 0.0072,
      skyTop: 0x2a0d05,
      skyBottom: 0x0a0302,
      sunDir: [-0.4, 0.7, 0.55],
      sunColour: 0xffd8b0,
      sunIntensity: 3.2,
      rimColour: 0x3f7fd0,
      crowd: false,
      screens: true,
      gates: true,
      heat: true,
      lavaGlow: true,
    },
  },
  {
    id: 'orbital',
    name: 'ORBITAL RING',
    kana: 'オービタルリング',
    blurb: 'Low gravity aesthetics, full gravity consequences.',
    bounds: { hx: 15.5, hz: 15.5, ceil: 14 },
    spawns: [
      { x: -10, z: -10, yaw: Math.PI * 0.25 },
      { x: 10, z: 10, yaw: Math.PI * 1.25 },
    ],
    boxes: [
      box(0, 0.4, 0, 5.8, 0.4, 5.8, 'dais'),
      box(0, 2.4, 0, 1.5, 2.4, 1.5, 'pillar'),
      box(-6.2, 1.6, 0, 0.8, 1.6, 3.0, 'rail', Math.PI * 0.25),
      box(6.2, 1.6, 0, 0.8, 1.6, 3.0, 'rail', Math.PI * 0.25),
      box(0, 1.6, -6.2, 3.0, 1.6, 0.8, 'rail', Math.PI * 0.25),
      box(0, 1.6, 6.2, 3.0, 1.6, 0.8, 'rail', Math.PI * 0.25),
      box(-11.6, 3.0, -11.6, 2.0, 3.0, 2.0, 'pillar', Math.PI * 0.25),
      box(11.6, 3.0, 11.6, 2.0, 3.0, 2.0, 'pillar', Math.PI * 0.25),
    ],
    theme: {
      key: 'orbital',
      floor: 0x232c3c,
      deck: 0x646c78,
      floorAccent: 0x7de2ff,
      struct: 0x36414f,
      wall: 0x0b1018,
      accent: 0x7de2ff,
      emissive: 0x9df0ff,
      hazard: 0xff9a2e,
      crowdWarm: 0xffb066,
      fog: 0x02040a,
      fogDensity: 0.0028,
      skyTop: 0x050b18,
      skyBottom: 0x010206,
      sunDir: [0.2, 0.5, -0.84],
      sunColour: 0xe8f0ff,
      sunIntensity: 3.2,
      rimColour: 0x3a6cc0,
      crowd: true,
      screens: true,
      gates: true,
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
