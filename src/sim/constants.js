/**
 * Simulation tuning. Everything here is expressed in metres / seconds and is
 * consumed at a fixed 60 Hz tick, so values read as "per second" unless the
 * name says otherwise.
 */

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

/** Max sim steps we allow per rendered frame before we give up and drop time. */
export const MAX_STEPS_PER_FRAME = 5;

export const GRAVITY = 26.0;
export const AIR_DRAG = 0.16;
export const GROUND_FRICTION = 12.0;

/** Robo capsule. */
export const ROBO_RADIUS = 0.46;
export const ROBO_HEIGHT = 1.62;
export const ROBO_EYE = 1.25;

export const MAX_HP = 1000;

/** Arena bounds are set per-map, this is the fallback. */
export const ARENA_HALF = 22;
export const ARENA_CEIL = 15;

/** Knockdown / recovery timings, in ticks. */
export const T = {
  hitStun: 12,
  downTime: 44,
  getUpInvuln: 34,
  spawnInvuln: 60,
  dashInvuln: 6,
  roundIntro: 150,
  roundOutro: 170,
  koFreeze: 22,
};

/** Damage accumulation that forces a knockdown when exceeded inside `downWindow`. */
export const DOWN_THRESHOLD = 165;
export const DOWN_WINDOW = 42;

export const TEAM_A = 0;
export const TEAM_B = 1;

/** Entity kinds inside the projectile pool. */
export const PK = {
  BULLET: 0,
  BOMB: 1,
  POD: 2,
  BEAM: 3,
  SHOCKWAVE: 4,
};

/** Sim event types consumed by the presentation layer. */
export const EV = {
  FIRE_GUN: 1,
  FIRE_BOMB: 2,
  DEPLOY_POD: 3,
  HIT: 4,
  EXPLODE: 5,
  JUMP: 6,
  AIR_DASH: 7,
  LAND: 8,
  DOWN: 9,
  GET_UP: 10,
  KO: 11,
  CHARGE_READY: 12,
  BULLET_EXPIRE: 13,
  WALL_HIT: 14,
  ROUND_START: 15,
  ROUND_END: 16,
  MATCH_END: 17,
  POD_STEP: 18,
  BLOCK: 19,
};

export const MATCH = {
  roundTimeTicks: 60 * 99,
  roundsToWin: 2,
};
