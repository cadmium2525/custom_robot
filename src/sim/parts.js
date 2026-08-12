/**
 * Parts database.
 *
 * Every entry carries BOTH the balance numbers used by the sim and a `look`
 * block used by the procedural model/VFX builders, so a part is a single source
 * of truth for stats and appearance.
 *
 * Colours are linear-ish hex; the material layer converts to sRGB working space.
 */

// ---------------------------------------------------------------------------
// BODIES (the "Robo" itself)
// ---------------------------------------------------------------------------

export const BODIES = [
  {
    id: 'ray',
    name: 'RAY-01',
    kana: 'レイMk-I',
    class: 'Balanced',
    hp: 1000,
    moveSpeed: 8.2,
    airControl: 0.62,
    weight: 1.0,
    knockbackTaken: 1.0,
    blurb: 'The tournament standard. No weakness, no excuse.',
    look: {
      silhouette: 'strider',
      primary: 0x2e6bd6,
      secondary: 0xe8eef7,
      accent: 0xff7a1a,
      emissive: 0x59b7ff,
      metalness: 0.92,
      roughness: 0.28,
      chest: 'v-crest',
      head: 'visor',
      shoulder: 'pauldron',
      trim: 'chrome',
    },
  },
  {
    id: 'shellbit',
    name: 'SHELLBIT',
    kana: 'シェルビット',
    class: 'Heavy',
    hp: 1180,
    moveSpeed: 7.0,
    airControl: 0.48,
    weight: 1.35,
    knockbackTaken: 0.74,
    blurb: 'Armour first. Everything else is negotiable.',
    look: {
      silhouette: 'bulwark',
      primary: 0x4a5560,
      secondary: 0xb9c4cf,
      accent: 0xffc21a,
      emissive: 0xffb347,
      metalness: 0.88,
      roughness: 0.42,
      chest: 'slab',
      head: 'dome',
      shoulder: 'block',
      trim: 'gunmetal',
    },
  },
  {
    id: 'aerial',
    name: 'AERIAL-Z',
    kana: 'エアリアルZ',
    class: 'Speed',
    hp: 860,
    moveSpeed: 9.6,
    airControl: 0.82,
    weight: 0.78,
    knockbackTaken: 1.22,
    blurb: 'Built to never be where the shot lands.',
    look: {
      silhouette: 'lance',
      primary: 0xd6255e,
      secondary: 0xf4f6fa,
      accent: 0x22e0c8,
      emissive: 0xff2f6d,
      metalness: 0.95,
      roughness: 0.2,
      chest: 'keel',
      head: 'crest',
      shoulder: 'fin',
      trim: 'chrome',
    },
  },
  {
    id: 'grandiso',
    name: 'GRAND ISO',
    kana: 'グランイソ',
    class: 'Technical',
    hp: 960,
    moveSpeed: 8.0,
    airControl: 0.7,
    weight: 1.05,
    knockbackTaken: 0.95,
    blurb: 'Every panel is a heatsink. Every heatsink is a threat.',
    look: {
      silhouette: 'monk',
      primary: 0x1f7a4d,
      secondary: 0xd8e6dd,
      accent: 0xf2e14c,
      emissive: 0x7dffb0,
      metalness: 0.9,
      roughness: 0.32,
      chest: 'reactor',
      head: 'mono',
      shoulder: 'vent',
      trim: 'brass',
    },
  },
  {
    id: 'nocturne',
    name: 'NOCTURNE',
    kana: 'ノクターン',
    class: 'Assassin',
    hp: 900,
    moveSpeed: 9.0,
    airControl: 0.78,
    weight: 0.86,
    knockbackTaken: 1.12,
    blurb: 'Illegal in four leagues. Undefeated in the rest.',
    look: {
      silhouette: 'lance',
      primary: 0x1a1d2b,
      secondary: 0x6e7590,
      accent: 0xb14cff,
      emissive: 0xc46bff,
      metalness: 0.97,
      roughness: 0.18,
      chest: 'keel',
      head: 'visor',
      shoulder: 'fin',
      trim: 'obsidian',
    },
  },
];

// ---------------------------------------------------------------------------
// GUNS
// ---------------------------------------------------------------------------

export const GUNS = [
  {
    id: 'vulcan',
    name: 'VULCAN',
    kana: 'バルカン',
    damage: 26,
    fireInterval: 6,      // ticks between shots
    burst: 1,
    speed: 44,
    spread: 0.016,
    life: 62,             // ticks
    homing: 0.0,
    knockback: 2.0,
    chargeMul: 2.35,
    chargeTicks: 46,
    blurb: 'Relentless chip damage. Punishes hesitation.',
    look: { colour: 0x66ccff, trail: 0x2f8fff, width: 0.055, len: 2.0, glow: 2.6, muzzle: 'flare' },
  },
  {
    id: 'scatter',
    name: 'SCATTER',
    kana: 'スキャッター',
    damage: 15,
    fireInterval: 20,
    burst: 6,
    speed: 36,
    spread: 0.085,
    life: 26,
    homing: 0.0,
    knockback: 1.4,
    chargeMul: 1.9,
    chargeTicks: 52,
    blurb: 'Six pellets. Close the gap and delete them.',
    look: { colour: 0xffb45e, trail: 0xff7a1a, width: 0.05, len: 1.35, glow: 2.2, muzzle: 'cone' },
  },
  {
    id: 'lancer',
    name: 'LANCER',
    kana: 'ランサー',
    damage: 78,
    fireInterval: 34,
    burst: 1,
    speed: 78,
    spread: 0.0,
    life: 60,
    homing: 0.0,
    knockback: 5.0,
    chargeMul: 2.0,
    chargeTicks: 60,
    pierce: true,
    blurb: 'One line, drawn straight through them.',
    look: { colour: 0xff3d6e, trail: 0xff0044, width: 0.085, len: 4.2, glow: 3.4, muzzle: 'lance' },
  },
  {
    id: 'seeker',
    name: 'SEEKER',
    kana: 'シーカー',
    damage: 22,
    fireInterval: 10,
    burst: 1,
    speed: 30,
    spread: 0.02,
    life: 96,
    homing: 3.9,
    knockback: 1.8,
    chargeMul: 2.1,
    chargeTicks: 50,
    blurb: 'It does not need you to aim. It needs you to breathe.',
    look: { colour: 0x9dff5e, trail: 0x36d13a, width: 0.06, len: 1.6, glow: 2.4, muzzle: 'ring' },
  },
  {
    id: 'tempest',
    name: 'TEMPEST',
    kana: 'テンペスト',
    damage: 34,
    fireInterval: 9,
    burst: 2,
    speed: 52,
    spread: 0.03,
    life: 70,
    homing: 0.9,
    knockback: 2.6,
    chargeMul: 2.6,
    chargeTicks: 58,
    blurb: 'Twin bolts, alternating. The rhythm is the weapon.',
    look: { colour: 0xc79cff, trail: 0x8c3dff, width: 0.062, len: 2.4, glow: 3.0, muzzle: 'flare' },
  },
];

// ---------------------------------------------------------------------------
// BOMBS
// ---------------------------------------------------------------------------

export const BOMBS = [
  {
    id: 'standard',
    name: 'STANDARD',
    kana: 'スタンダード',
    damage: 118,
    radius: 3.4,
    fuse: 70,
    speed: 17,
    arc: 7.4,
    bounce: 0.42,
    cooldown: 78,
    knockback: 9.0,
    blurb: 'Honest arc, honest blast.',
    look: { colour: 0xffd166, shell: 0xd94f2b, ring: 0xffb02e, size: 0.3, style: 'orb' },
  },
  {
    id: 'quake',
    name: 'QUAKE',
    kana: 'クエイク',
    damage: 92,
    radius: 5.6,
    fuse: 96,
    speed: 13,
    arc: 6.0,
    bounce: 0.2,
    cooldown: 104,
    knockback: 12.5,
    groundOnly: true,
    blurb: 'The floor becomes the attack.',
    look: { colour: 0xffa03d, shell: 0x7a4a2b, ring: 0xff6a1a, size: 0.36, style: 'drum' },
  },
  {
    id: 'sticky',
    name: 'STICKY',
    kana: 'スティッキー',
    damage: 138,
    radius: 2.6,
    fuse: 58,
    speed: 22,
    arc: 4.2,
    bounce: 0.0,
    sticky: true,
    cooldown: 88,
    knockback: 8.0,
    blurb: 'Lands, clings, counts down in their face.',
    look: { colour: 0x7dff9e, shell: 0x2f7a4a, ring: 0x39ffa0, size: 0.28, style: 'orb' },
  },
  {
    id: 'cluster',
    name: 'CLUSTER',
    kana: 'クラスター',
    damage: 62,
    radius: 2.4,
    fuse: 56,
    speed: 19,
    arc: 8.2,
    bounce: 0.3,
    cooldown: 96,
    knockback: 6.0,
    submunitions: 5,
    blurb: 'One throw, five apologies.',
    look: { colour: 0xff8ad1, shell: 0x8a2f5e, ring: 0xff4fa3, size: 0.3, style: 'cluster' },
  },
];

// ---------------------------------------------------------------------------
// PODS — deployed drones that chase and detonate / fire
// ---------------------------------------------------------------------------

export const PODS = [
  {
    id: 'stinger',
    name: 'STINGER',
    kana: 'スティンガー',
    damage: 96,
    radius: 2.8,
    speed: 12.5,
    turn: 4.2,
    life: 240,
    cooldown: 150,
    mode: 'charge',
    knockback: 7.0,
    blurb: 'Skims the deck, ends the round.',
    look: { colour: 0x5ee0ff, shell: 0x1e5f8a, size: 0.34, style: 'dart' },
  },
  {
    id: 'sentry',
    name: 'SENTRY',
    kana: 'セントリー',
    damage: 24,
    radius: 0,
    speed: 5.0,
    turn: 2.4,
    life: 330,
    cooldown: 190,
    mode: 'turret',
    fireInterval: 22,
    bulletSpeed: 34,
    knockback: 1.5,
    blurb: 'Parks between you and safety.',
    look: { colour: 0xffd45e, shell: 0x8a6a1e, size: 0.38, style: 'tripod' },
  },
  {
    id: 'wraith',
    name: 'WRAITH',
    kana: 'レイス',
    damage: 74,
    radius: 3.6,
    speed: 9.0,
    turn: 6.5,
    life: 300,
    cooldown: 165,
    mode: 'orbit',
    knockback: 6.0,
    blurb: 'Circles. Waits. Decides.',
    look: { colour: 0xc07bff, shell: 0x4b2a7a, size: 0.32, style: 'ring' },
  },
];

// ---------------------------------------------------------------------------
// LEGS
// ---------------------------------------------------------------------------

export const LEGS = [
  {
    id: 'featherx',
    name: 'FEATHER-X',
    kana: 'フェザーX',
    jumps: 2,
    airDashes: 2,
    dashSpeed: 19.0,
    dashTicks: 12,
    dashCooldown: 20,
    jumpSpeed: 11.2,
    landRecovery: 8,
    gravityMul: 0.92,
    blurb: 'Three-beat aerial rhythm. The classic.',
    look: { style: 'sprinter', colour: 0xdfe6ef, accent: 0x59b7ff, thruster: 'twin' },
  },
  {
    id: 'anvil',
    name: 'ANVIL',
    kana: 'アンビル',
    jumps: 1,
    airDashes: 1,
    dashSpeed: 15.5,
    dashTicks: 14,
    dashCooldown: 26,
    jumpSpeed: 9.6,
    landRecovery: 14,
    gravityMul: 1.18,
    stability: 0.6,
    blurb: 'You will not be moved. You will also not be fast.',
    look: { style: 'tank', colour: 0x8c96a3, accent: 0xffc21a, thruster: 'quad' },
  },
  {
    id: 'hover',
    name: 'HOVER-V',
    kana: 'ホバーV',
    jumps: 1,
    airDashes: 3,
    dashSpeed: 17.0,
    dashTicks: 16,
    dashCooldown: 16,
    jumpSpeed: 9.0,
    landRecovery: 4,
    gravityMul: 0.66,
    hover: true,
    blurb: 'Never really lands, never really commits.',
    look: { style: 'hover', colour: 0xb9e8ff, accent: 0x22e0c8, thruster: 'ring' },
  },
  {
    id: 'spring',
    name: 'SPRING-R',
    kana: 'スプリングR',
    jumps: 3,
    airDashes: 1,
    dashSpeed: 16.0,
    dashTicks: 12,
    dashCooldown: 22,
    jumpSpeed: 10.4,
    landRecovery: 6,
    gravityMul: 1.0,
    blurb: 'Triple jump. Own the vertical.',
    look: { style: 'digitigrade', colour: 0xe4d2ff, accent: 0xb14cff, thruster: 'twin' },
  },
];

// ---------------------------------------------------------------------------

const index = (arr) => {
  const m = new Map();
  for (const p of arr) m.set(p.id, p);
  return m;
};

export const BODY_BY_ID = index(BODIES);
export const GUN_BY_ID = index(GUNS);
export const BOMB_BY_ID = index(BOMBS);
export const POD_BY_ID = index(PODS);
export const LEG_BY_ID = index(LEGS);

export const CATEGORIES = [
  { key: 'body', label: 'BODY', kana: 'ボディ', list: BODIES, map: BODY_BY_ID },
  { key: 'gun', label: 'GUN', kana: 'ガン', list: GUNS, map: GUN_BY_ID },
  { key: 'bomb', label: 'BOMB', kana: 'ボム', list: BOMBS, map: BOMB_BY_ID },
  { key: 'pod', label: 'POD', kana: 'ポッド', list: PODS, map: POD_BY_ID },
  { key: 'legs', label: 'LEGS', kana: 'レッグ', list: LEGS, map: LEG_BY_ID },
];

export const DEFAULT_LOADOUT = {
  body: 'ray', gun: 'vulcan', bomb: 'standard', pod: 'stinger', legs: 'featherx',
};

export function resolveLoadout(ld) {
  const l = { ...DEFAULT_LOADOUT, ...(ld || {}) };
  return {
    ids: l,
    body: BODY_BY_ID.get(l.body) || BODIES[0],
    gun: GUN_BY_ID.get(l.gun) || GUNS[0],
    bomb: BOMB_BY_ID.get(l.bomb) || BOMBS[0],
    pod: POD_BY_ID.get(l.pod) || PODS[0],
    legs: LEG_BY_ID.get(l.legs) || LEGS[0],
  };
}

/** Preset opponent builds used by the AI ladder. */
export const PRESETS = [
  { name: 'ROOKIE',    loadout: { body: 'ray', gun: 'vulcan', bomb: 'standard', pod: 'sentry', legs: 'featherx' } },
  { name: 'BULWARK',   loadout: { body: 'shellbit', gun: 'scatter', bomb: 'quake', pod: 'sentry', legs: 'anvil' } },
  { name: 'SWIFT',     loadout: { body: 'aerial', gun: 'tempest', bomb: 'sticky', pod: 'stinger', legs: 'hover' } },
  { name: 'ARTISAN',   loadout: { body: 'grandiso', gun: 'seeker', bomb: 'cluster', pod: 'wraith', legs: 'spring' } },
  { name: 'NOCTURNE',  loadout: { body: 'nocturne', gun: 'lancer', bomb: 'sticky', pod: 'wraith', legs: 'featherx' } },
];
