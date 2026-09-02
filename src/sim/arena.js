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
      // The shell of the building is warm graphite, and that is the whole
      // reason the arena's blues are allowed to be blue.
      //
      // A frame measured 41% cool coverage against 6% warm, which is not a cool
      // arena, it is a tinted one — a blue cast has nothing to be a cast
      // AGAINST. So the deck stays a neutral bright dielectric, the rim strips
      // and the sky stay cold, and the built structure that surrounds both goes
      // warm. Same luminance as the blue-grey it replaces to a fraction of a
      // percent; only the hue moves.
      struct: 0x4b4136,
      // A boundary wall at 0x232a35 has a linear albedo of 0.021 — it returns
      // two percent of everything that lands on it, so no rig can light it and
      // the surround measured 90%+ below the black threshold. Doubled, and it
      // is still less than half the deck.
      wall: 0x413a30,
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
      // The two lights that describe everything the sun does not reach. Warm on
      // purpose and warm in the grid specifically: this arena measured 41% cool
      // coverage against 6% warm, so the only way the cool read is a decision
      // rather than a tint is if there is something hot for it to be cool
      // against — and the shadow side of the architecture is where that lives.
      bounceColour: 0xffa63a,
      groundBounce: 0x54402c,
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
      floorAccent: 0xb2500f,
      // The cold counter-note this theme declares — a 0x3f7fd0 fill and a
      // 0x5c9ad8 bounce — was being aimed at brown. 0x4b3b2e has a linear BLUE
      // albedo of 0.027, so the block faces that the counter-kick exists to
      // describe returned almost none of it and measured a median of 22/255:
      // the arena paid for two cold lights and then threw the light away.
      //
      // Blued gunmetal at the same luminance. Under the 0xffd8b0 key the lit
      // top planes still read hot, which is right — a lit plane takes the
      // colour of the light — while the shadow sides now return three times the
      // blue they did, so a block's dark half is the coolest thing in the frame
      // instead of one more orange plane. Machinery in a hot mill is grey.
      struct: 0x3e4250,
      // Same arithmetic that condemned the grid's wall, run on this one: an
      // 0x2e2119 boundary has a linear albedo of 0.017, so it returns under two
      // percent of everything that reaches it and no rig can light it — the
      // foundry measured 38% of the frame below the black threshold with a wall
      // median of 25 against a deck of 96.
      //
      // Lifted 2.6x, and lifted COLD. The foundry measured 78% warm coverage
      // against 1% cool, and the boundary is a quarter of the frame: making it
      // one more orange plane is what "monochrome" means. Blued dark steel under
      // the mercury wash is the counter-note this theme's own comment asks for
      // and never got.
      wall: 0x383c4a,
      accent: 0xb26a20,
      emissive: 0xbc470c,
      hazard: 0xcfa63c,
      crowdWarm: 0x8fd0ff,
      fog: 0x120705,
      fogDensity: 0.0072,
      skyTop: 0x2a0d05,
      skyBottom: 0x0a0302,
      sunDir: [-0.4, 0.7, 0.55],
      sunColour: 0xffd8b0,
      sunIntensity: 3.2,
      rimColour: 0x3f7fd0,
      // Inverted, like the fill above it: in the one hot arena the counter-kick
      // and the ground ambient go cold, so a block's shadow side is the coolest
      // thing in frame instead of one more orange plane among orange planes.
      bounceColour: 0x5c9ad8,
      groundBounce: 0x2e4054,
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
      // 0x7de2ff is a 49%-saturated cyan, and the perimeter light rail baked
      // into the wall drives it at 1.5. Added over a lit deck it landed at
      // rgb(194,240,237) — a white line, the brightest thing in the arena,
      // outranking the muzzle flash. Saturated so the same fixture reads as the
      // colour it is supposed to be and stops competing for the top of the
      // value range.
      floorAccent: 0x55cdf5,
      // Mirror of the foundry's problem. Orbital declares a sodium counter-kick
      // (0xff9a4a bounce over a 0x4b3826 ground term) and then points it at a
      // blue-grey whose linear RED albedo is 0.036, so the one warm light in
      // the rig had nothing to land on and the arena measured 2.7% warm against
      // 51% cool. Painted steel under service lamps, as the grid's shell is.
      struct: 0x494033,
      // 0x1d242f is a linear albedo of 0.017 — the same unlightable surface the
      // grid was rebuilt to get rid of, left in place here. Orbital measured a
      // wall median of 29 and 33% of the frame below the black threshold.
      //
      // Lifted 2.7x and taken warm, for the reason the grid's was: this arena
      // measured 51% cool coverage against 2.7% warm, and a blue cast with
      // nothing to be cast against is not cool, it is tinted. The shell of the
      // ring is painted steel under sodium service lamps; the cyan belongs to
      // the rails and the deck.
      wall: 0x443b2f,
      accent: 0x55cdf5,
      emissive: 0x4ad0ff,
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
      // Coldest arena of the three, so its counter-kick is the warmest — a
      // sodium service light bouncing off the ring's own deck.
      bounceColour: 0xff9a4a,
      groundBounce: 0x4b3826,
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
