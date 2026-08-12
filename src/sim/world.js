/**
 * The deterministic simulation.
 *
 * Rules of this file:
 *   - no three.js, no DOM, no Date.now, no Math.random
 *   - all randomness comes from `world.rng`
 *   - every mutation happens inside `step()` driven by two InputFrames
 *
 * That discipline is what makes rollback netcode, replays and headless testing
 * possible. `snapshot()`/`restore()` round-trip the entire match state.
 */

import {
  TICK_DT, GRAVITY, AIR_DRAG, GROUND_FRICTION, ROBO_RADIUS, ROBO_HEIGHT,
  T, DOWN_THRESHOLD, DOWN_WINDOW, PK, EV, MATCH,
} from './constants.js';
import { BTN, makeInput, copyInput, held, pressed, released } from './input.js';
import { resolveLoadout } from './parts.js';
import { getArena, prepareArena } from './arena.js';
import { moveBody, probePoint, lineOfSight, groundHeightAt } from './physics.js';
import { Rng, clamp, clampXZ, angleDelta, approachAngle, v3, v3dist, v3distXZ } from '../core/mathx.js';

const MAX_PROJ = 220;

export const PHASE = {
  INTRO: 0,
  FIGHT: 1,
  ROUND_END: 2,
  MATCH_END: 3,
};

export const STATE = {
  ACTIVE: 0,
  DASH: 1,
  DOWN: 2,
  GETUP: 3,
  DEAD: 4,
};

// ---------------------------------------------------------------------------

function makeRobo(id, team) {
  return {
    id, team,
    pos: v3(), vel: v3(),
    yaw: 0, pitch: 0, aimYaw: 0, aimPitch: 0,
    hp: 1000, maxHp: 1000,
    state: STATE.ACTIVE,
    stateTimer: 0,
    grounded: true,
    jumpsLeft: 2,
    airDashesLeft: 2,
    gunCd: 0, bombCd: 0, podCd: 0,
    charge: 0, chargeReady: 0,
    burstLeft: 0, burstTimer: 0, burstCharged: 0,
    invuln: 0, stun: 0, landLag: 0,
    recentDmg: 0, recentDmgTimer: 0,
    dashX: 0, dashZ: 0, dashY: 0,
    podId: -1,
    facingBlend: 0,
    // presentation-only counters (still snapshotted so rollback stays clean)
    fireFlash: 0, hurtFlash: 0, boostHeat: 0, moveAmt: 0, stepPhase: 0,
    lastDamage: 0, comboHits: 0,
  };
}

function makeProj() {
  return {
    alive: 0, kind: 0, owner: 0, team: 0,
    pos: v3(), vel: v3(),
    life: 0, maxLife: 0,
    damage: 0, radius: 0, knockback: 0,
    homing: 0, pierce: 0, charged: 0,
    partIdx: 0, mode: 0, timer: 0, stuck: 0,
    scale: 1, seed: 0, sub: 0,
    nx: 0, ny: 1, nz: 0,
  };
}

// ---------------------------------------------------------------------------

export class World {
  constructor(opts = {}) {
    this.arena = prepareArena(getArena(opts.arenaId || 'grid'));
    this.arenaId = this.arena.id;
    this.rng = new Rng(opts.seed ?? 0x1234abcd);
    this.seed = opts.seed ?? 0x1234abcd;

    this.robos = [makeRobo(0, 0), makeRobo(1, 1)];
    this.loadouts = [
      resolveLoadout(opts.loadouts?.[0]),
      resolveLoadout(opts.loadouts?.[1]),
    ];

    this.proj = new Array(MAX_PROJ);
    for (let i = 0; i < MAX_PROJ; i++) this.proj[i] = makeProj();
    this.projCursor = 0;

    this.prevInputs = [makeInput(), makeInput()];

    this.tick = 0;
    this.phase = PHASE.INTRO;
    this.phaseTimer = T.roundIntro;
    this.roundTimer = MATCH.roundTimeTicks;
    this.round = 1;
    this.wins = [0, 0];
    this.winner = -1;
    this.koFreeze = 0;

    /** Presentation events for the current tick. Cleared at the top of step(). */
    this.events = [];
    this.suppressEvents = false;

    this.resetRound(true);
  }

  setLoadout(i, ids) {
    this.loadouts[i] = resolveLoadout(ids);
    const r = this.robos[i];
    r.maxHp = this.loadouts[i].body.hp;
    r.hp = r.maxHp;
  }

  emit(type, a) {
    if (this.suppressEvents) return;
    a.type = type;
    a.tick = this.tick;
    this.events.push(a);
  }

  // -------------------------------------------------------------------------

  resetRound(first = false) {
    const spawns = this.arena.spawns;
    for (let i = 0; i < 2; i++) {
      const r = this.robos[i];
      const ld = this.loadouts[i];
      const sp = spawns[i % spawns.length];
      r.pos.x = sp.x; r.pos.y = 0; r.pos.z = sp.z;
      r.vel.x = 0; r.vel.y = 0; r.vel.z = 0;
      r.yaw = sp.yaw; r.aimYaw = sp.yaw; r.pitch = 0; r.aimPitch = 0;
      r.maxHp = ld.body.hp;
      r.hp = r.maxHp;
      r.state = STATE.ACTIVE;
      r.stateTimer = 0;
      r.grounded = true;
      r.jumpsLeft = ld.legs.jumps;
      r.airDashesLeft = ld.legs.airDashes;
      r.gunCd = 0; r.bombCd = 0; r.podCd = 0;
      r.charge = 0; r.chargeReady = 0;
      r.burstLeft = 0; r.burstTimer = 0;
      r.invuln = T.spawnInvuln; r.stun = 0; r.landLag = 0;
      r.recentDmg = 0; r.recentDmgTimer = 0;
      r.podId = -1;
      r.fireFlash = 0; r.hurtFlash = 0; r.boostHeat = 0; r.moveAmt = 0;
      r.comboHits = 0;
    }
    for (let i = 0; i < MAX_PROJ; i++) this.proj[i].alive = 0;
    this.roundTimer = MATCH.roundTimeTicks;
    this.phase = PHASE.INTRO;
    this.phaseTimer = first ? T.roundIntro : T.roundIntro;
    this.koFreeze = 0;
    this.emit(EV.ROUND_START, { round: this.round });
  }

  // -------------------------------------------------------------------------

  step(inputs) {
    this.events.length = 0;
    this.tick++;

    if (this.koFreeze > 0) {
      this.koFreeze--;
      // Freeze frames still advance visual timers so nothing looks stuck.
      for (const r of this.robos) {
        if (r.hurtFlash > 0) r.hurtFlash--;
        if (r.fireFlash > 0) r.fireFlash--;
      }
      return;
    }

    switch (this.phase) {
      case PHASE.INTRO:
        this.stepIntro(inputs);
        break;
      case PHASE.FIGHT:
        this.stepFight(inputs);
        break;
      case PHASE.ROUND_END:
        this.stepRoundEnd();
        break;
      case PHASE.MATCH_END:
        this.stepProjectiles();
        break;
    }

    for (let i = 0; i < 2; i++) copyInput(this.prevInputs[i], inputs[i]);
  }

  stepIntro(inputs) {
    this.phaseTimer--;
    // Robos settle onto the pad during the intro, but take no input.
    for (const r of this.robos) {
      r.vel.x = 0; r.vel.z = 0;
      this.integrate(r, this.loadouts[r.id], true);
    }
    this.faceOpponents();
    if (this.phaseTimer <= 0) {
      this.phase = PHASE.FIGHT;
      this.emit(EV.ROUND_START, { round: this.round, go: 1 });
    }
  }

  stepRoundEnd() {
    this.phaseTimer--;
    for (const r of this.robos) this.integrate(r, this.loadouts[r.id], true);
    this.stepProjectiles();
    if (this.phaseTimer <= 0) {
      if (this.wins[0] >= MATCH.roundsToWin || this.wins[1] >= MATCH.roundsToWin) {
        this.winner = this.wins[0] > this.wins[1] ? 0 : 1;
        this.phase = PHASE.MATCH_END;
        this.emit(EV.MATCH_END, { winner: this.winner });
      } else {
        this.round++;
        this.resetRound();
      }
    }
  }

  stepFight(inputs) {
    this.roundTimer--;

    for (let i = 0; i < 2; i++) {
      this.stepRobo(this.robos[i], inputs[i], this.prevInputs[i], this.loadouts[i]);
    }
    this.faceOpponents();
    this.stepProjectiles();
    this.resolveRoboOverlap();

    // Round resolution
    const a = this.robos[0], b = this.robos[1];
    if (a.hp <= 0 || b.hp <= 0 || this.roundTimer <= 0) {
      let winner;
      if (a.hp <= 0 && b.hp <= 0) winner = -1;
      else if (a.hp <= 0) winner = 1;
      else if (b.hp <= 0) winner = 0;
      else winner = a.hp === b.hp ? -1 : (a.hp > b.hp ? 0 : 1);

      if (winner >= 0) this.wins[winner]++;
      this.phase = PHASE.ROUND_END;
      this.phaseTimer = T.roundOutro;
      this.koFreeze = T.koFreeze;
      if (a.hp <= 0) a.state = STATE.DEAD;
      if (b.hp <= 0) b.state = STATE.DEAD;
      this.emit(EV.ROUND_END, {
        winner, round: this.round, wins: [this.wins[0], this.wins[1]],
        timeout: this.roundTimer <= 0 ? 1 : 0,
      });
      this.emit(EV.KO, { winner, x: 0, y: 0, z: 0 });
    }
  }

  // -------------------------------------------------------------------------
  // Robo
  // -------------------------------------------------------------------------

  stepRobo(r, inp, prev, ld) {
    const legs = ld.legs;

    if (r.gunCd > 0) r.gunCd--;
    if (r.bombCd > 0) r.bombCd--;
    if (r.podCd > 0) r.podCd--;
    if (r.invuln > 0) r.invuln--;
    if (r.stun > 0) r.stun--;
    if (r.landLag > 0) r.landLag--;
    if (r.fireFlash > 0) r.fireFlash--;
    if (r.hurtFlash > 0) r.hurtFlash--;
    if (r.recentDmgTimer > 0) { r.recentDmgTimer--; if (r.recentDmgTimer === 0) { r.recentDmg = 0; r.comboHits = 0; } }
    r.boostHeat = Math.max(0, r.boostHeat - 0.05);

    if (r.state === STATE.DEAD) {
      this.integrate(r, ld, true);
      return;
    }

    if (r.state === STATE.DOWN) {
      r.stateTimer--;
      this.integrate(r, ld, true);
      if (r.stateTimer <= 0 && r.grounded) {
        r.state = STATE.GETUP;
        r.stateTimer = T.getUpInvuln;
        r.invuln = Math.max(r.invuln, T.getUpInvuln);
        r.jumpsLeft = legs.jumps;
        r.airDashesLeft = legs.airDashes;
        this.emit(EV.GET_UP, { id: r.id, x: r.pos.x, y: r.pos.y, z: r.pos.z });
      }
      return;
    }

    if (r.state === STATE.GETUP) {
      r.stateTimer--;
      if (r.stateTimer <= 0) r.state = STATE.ACTIVE;
      // Get-up is actionable near the end, which keeps the flow fast.
      if (r.stateTimer > T.getUpInvuln * 0.45) {
        this.integrate(r, ld, true);
        return;
      }
    }

    const dashing = r.state === STATE.DASH;
    if (dashing) {
      r.stateTimer--;
      if (r.stateTimer <= 0) {
        r.state = STATE.ACTIVE;
        // Bleed the dash down to a controllable speed instead of a hard stop.
        r.vel.x *= 0.44; r.vel.z *= 0.44;
      }
    }

    // ---- movement --------------------------------------------------------
    const stick = Math.min(1, Math.hypot(inp.moveX, inp.moveZ));
    const cy = Math.cos(inp.yaw), sy = Math.sin(inp.yaw);
    // Stick space -> world space around the camera yaw.
    let wx = inp.moveX * cy + inp.moveZ * sy;
    let wz = -inp.moveX * sy + inp.moveZ * cy;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-5) { wx /= wl; wz /= wl; }

    r.moveAmt = stick;

    if (!dashing && r.stun <= 0 && r.landLag <= 0) {
      const speed = ld.body.moveSpeed;
      const accel = r.grounded ? 62 : 62 * ld.body.airControl;
      const targetX = wx * speed * stick;
      const targetZ = wz * speed * stick;
      r.vel.x += (targetX - r.vel.x) * Math.min(1, accel * TICK_DT / Math.max(1, speed));
      r.vel.z += (targetZ - r.vel.z) * Math.min(1, accel * TICK_DT / Math.max(1, speed));
    }

    // ---- jump ------------------------------------------------------------
    if (pressed(inp, prev, BTN.JUMP) && r.stun <= 0 && !dashing && r.landLag <= 0) {
      if (r.jumpsLeft > 0) {
        r.jumpsLeft--;
        r.vel.y = legs.jumpSpeed * (r.grounded ? 1 : 0.92);
        r.grounded = false;
        r.boostHeat = Math.min(1, r.boostHeat + 0.5);
        this.emit(EV.JUMP, {
          id: r.id, x: r.pos.x, y: r.pos.y, z: r.pos.z,
          air: r.jumpsLeft < legs.jumps - 1 ? 1 : 0,
        });
      }
    }

    // ---- dash ------------------------------------------------------------
    if (pressed(inp, prev, BTN.DASH) && r.stun <= 0 && r.state !== STATE.DASH) {
      const canGround = r.grounded && r.landLag <= 0;
      const canAir = !r.grounded && r.airDashesLeft > 0;
      if (canGround || canAir) {
        let dx = wx, dz = wz;
        if (wl < 1e-5) { dx = Math.sin(r.yaw); dz = Math.cos(r.yaw); }
        r.state = STATE.DASH;
        r.stateTimer = legs.dashTicks;
        r.invuln = Math.max(r.invuln, T.dashInvuln);
        r.vel.x = dx * legs.dashSpeed;
        r.vel.z = dz * legs.dashSpeed;
        if (!r.grounded) {
          r.airDashesLeft--;
          r.vel.y = Math.max(r.vel.y, -1.5) * 0.35 + 1.4;
        }
        r.boostHeat = 1;
        r.dashX = dx; r.dashZ = dz;
        this.emit(EV.AIR_DASH, {
          id: r.id, x: r.pos.x, y: r.pos.y, z: r.pos.z,
          dx, dz, air: r.grounded ? 0 : 1,
        });
      }
    }

    // ---- weapons ---------------------------------------------------------
    if (r.stun <= 0 && r.state !== STATE.DOWN) {
      this.stepGun(r, inp, prev, ld);
      if (pressed(inp, prev, BTN.BOMB) && r.bombCd <= 0) this.fireBomb(r, ld);
      if (pressed(inp, prev, BTN.POD) && r.podCd <= 0) this.deployPod(r, ld);
    }

    this.integrate(r, ld, false);
  }

  stepGun(r, inp, prev, ld) {
    const gun = ld.gun;

    // Burst continuation (scatter/tempest fire several rounds per trigger pull).
    if (r.burstLeft > 0) {
      r.burstTimer--;
      if (r.burstTimer <= 0) {
        this.spawnBullet(r, ld, r.burstCharged);
        r.burstLeft--;
        r.burstTimer = 2;
      }
    }

    const isHeld = held(inp, BTN.FIRE);
    const wasReleased = released(inp, prev, BTN.FIRE);

    if (isHeld) {
      r.charge++;
      if (r.charge === gun.chargeTicks) {
        r.chargeReady = 1;
        this.emit(EV.CHARGE_READY, { id: r.id });
      }
      // Auto-fire until the charge locks in — hold through it for the big shot.
      if (r.charge < gun.chargeTicks && r.gunCd <= 0 && r.burstLeft <= 0) {
        this.fireGun(r, ld, false);
      }
    } else if (wasReleased) {
      if (r.chargeReady) this.fireGun(r, ld, true);
      r.charge = 0;
      r.chargeReady = 0;
    } else {
      r.charge = 0;
      r.chargeReady = 0;
    }
  }

  fireGun(r, ld, charged) {
    const gun = ld.gun;
    r.gunCd = charged ? Math.round(gun.fireInterval * 1.8) : gun.fireInterval;
    r.fireFlash = 5;
    const n = gun.burst || 1;
    this.spawnBullet(r, ld, charged);
    if (n > 1) {
      r.burstLeft = n - 1;
      r.burstTimer = 2;
      r.burstCharged = charged ? 1 : 0;
    }
    this.emit(EV.FIRE_GUN, {
      id: r.id, charged: charged ? 1 : 0,
      x: r.pos.x, y: r.pos.y + 1.05, z: r.pos.z,
      yaw: r.aimYaw, pitch: r.aimPitch, gun: gun.id,
    });
  }

  spawnBullet(r, ld, charged) {
    const gun = ld.gun;
    const p = this.alloc();
    if (!p) return;
    const spread = charged ? gun.spread * 0.3 : gun.spread;
    const yaw = r.aimYaw + this.rng.s() * spread * 6;
    const pitch = r.aimPitch + this.rng.s() * spread * 4;
    const cp = Math.cos(pitch);
    const dx = Math.sin(yaw) * cp;
    const dy = Math.sin(pitch);
    const dz = Math.cos(yaw) * cp;
    const speed = gun.speed * (charged ? 1.25 : 1);

    p.alive = 1;
    p.kind = PK.BULLET;
    p.owner = r.id;
    p.team = r.team;
    // Muzzle sits at the shoulder line, offset to the gun arm.
    const sx = Math.cos(yaw) * 0.34;
    const sz = -Math.sin(yaw) * 0.34;
    p.pos.x = r.pos.x + dx * 0.7 + sx;
    p.pos.y = r.pos.y + 1.06 + dy * 0.7;
    p.pos.z = r.pos.z + dz * 0.7 + sz;
    p.vel.x = dx * speed; p.vel.y = dy * speed; p.vel.z = dz * speed;
    p.life = p.maxLife = gun.life;
    p.damage = charged ? gun.damage * gun.chargeMul : gun.damage;
    p.radius = charged ? 0.44 : 0.26;
    p.knockback = gun.knockback * (charged ? 2.2 : 1);
    p.homing = gun.homing * (charged ? 1.4 : 1);
    p.pierce = (gun.pierce || charged) ? 1 : 0;
    p.charged = charged ? 1 : 0;
    p.partIdx = gunIndex(gun.id);
    p.scale = charged ? 1.9 : 1;
    p.seed = this.rng.u32();
  }

  fireBomb(r, ld) {
    const bomb = ld.bomb;
    r.bombCd = bomb.cooldown;
    const p = this.alloc();
    if (!p) return;
    const yaw = r.aimYaw;
    const pitch = r.aimPitch;
    const cp = Math.cos(pitch);
    p.alive = 1;
    p.kind = PK.BOMB;
    p.owner = r.id; p.team = r.team;
    p.pos.x = r.pos.x + Math.sin(yaw) * 0.5;
    p.pos.y = r.pos.y + 1.15;
    p.pos.z = r.pos.z + Math.cos(yaw) * 0.5;
    p.vel.x = Math.sin(yaw) * cp * bomb.speed + r.vel.x * 0.35;
    p.vel.y = bomb.arc + Math.sin(pitch) * bomb.speed * 0.5;
    p.vel.z = Math.cos(yaw) * cp * bomb.speed + r.vel.z * 0.35;
    p.life = p.maxLife = bomb.fuse;
    p.damage = bomb.damage;
    p.radius = bomb.radius;
    p.knockback = bomb.knockback;
    p.partIdx = bombIndex(bomb.id);
    p.scale = 1;
    p.stuck = 0;
    p.sub = 0;
    p.seed = this.rng.u32();
    this.emit(EV.FIRE_BOMB, { id: r.id, x: p.pos.x, y: p.pos.y, z: p.pos.z, bomb: bomb.id });
  }

  deployPod(r, ld) {
    const pod = ld.pod;
    r.podCd = pod.cooldown;
    // One pod per robo — deploying again retires the old one.
    if (r.podId >= 0 && this.proj[r.podId] && this.proj[r.podId].alive && this.proj[r.podId].kind === PK.POD) {
      this.proj[r.podId].life = 1;
    }
    const p = this.alloc();
    if (!p) return;
    const yaw = r.aimYaw;
    p.alive = 1;
    p.kind = PK.POD;
    p.owner = r.id; p.team = r.team;
    p.pos.x = r.pos.x + Math.sin(yaw) * 0.9;
    p.pos.y = r.pos.y + 0.45;
    p.pos.z = r.pos.z + Math.cos(yaw) * 0.9;
    p.vel.x = Math.sin(yaw) * pod.speed * 0.6;
    p.vel.y = 0;
    p.vel.z = Math.cos(yaw) * pod.speed * 0.6;
    p.life = p.maxLife = pod.life;
    p.damage = pod.damage;
    p.radius = pod.radius;
    p.knockback = pod.knockback;
    p.partIdx = podIndex(pod.id);
    p.mode = pod.mode === 'turret' ? 1 : pod.mode === 'orbit' ? 2 : 0;
    p.timer = 0;
    p.scale = 1;
    p.seed = this.rng.u32();
    r.podId = this.proj.indexOf(p);
    this.emit(EV.DEPLOY_POD, { id: r.id, x: p.pos.x, y: p.pos.y, z: p.pos.z, pod: pod.id });
  }

  integrate(r, ld, passive) {
    const legs = ld.legs;
    const gMul = legs.gravityMul * (r.state === STATE.DOWN ? 1.15 : 1);

    if (!r.grounded || r.vel.y > 0) {
      r.vel.y -= GRAVITY * gMul * TICK_DT;
      if (legs.hover && r.vel.y < -6 && !passive) r.vel.y += GRAVITY * 0.45 * TICK_DT;
      r.vel.x -= r.vel.x * AIR_DRAG * TICK_DT;
      r.vel.z -= r.vel.z * AIR_DRAG * TICK_DT;
    } else if (r.state !== STATE.DASH) {
      const f = GROUND_FRICTION * (passive || r.moveAmt < 0.05 ? 1.7 : 0.55) * TICK_DT;
      const sp = Math.hypot(r.vel.x, r.vel.z);
      if (sp > 1e-4) {
        const nsp = Math.max(0, sp - f * Math.max(1, sp * 0.35));
        r.vel.x *= nsp / sp;
        r.vel.z *= nsp / sp;
      }
    }

    clampXZ(r.vel, 30);
    r.vel.y = clamp(r.vel.y, -42, 26);

    const wasGrounded = r.grounded;
    const res = moveBody(this.arena, r.pos, r.vel, ROBO_RADIUS, ROBO_HEIGHT, TICK_DT);
    r.grounded = res.grounded;

    if (res.landedThisStep && !wasGrounded) {
      r.jumpsLeft = legs.jumps;
      r.airDashesLeft = legs.airDashes;
      if (r.state === STATE.DASH) { r.state = STATE.ACTIVE; r.stateTimer = 0; }
      const hard = res.impactSpeed > 14;
      r.landLag = hard ? legs.landRecovery : Math.round(legs.landRecovery * 0.4);
      this.emit(EV.LAND, {
        id: r.id, x: r.pos.x, y: r.pos.y, z: r.pos.z,
        speed: res.impactSpeed, hard: hard ? 1 : 0, kind: res.groundKind,
      });
    }
    if (res.hitWall && Math.hypot(r.vel.x, r.vel.z) > 8) {
      this.emit(EV.WALL_HIT, { x: r.pos.x, y: r.pos.y + 0.9, z: r.pos.z, nx: res.wallNx, nz: res.wallNz });
    }
    if (r.grounded) r.stepPhase += Math.hypot(r.vel.x, r.vel.z) * TICK_DT * 2.4;
  }

  /** Auto-lock: robos always square up to their opponent, Custom Robo style. */
  faceOpponents() {
    for (let i = 0; i < 2; i++) {
      const r = this.robos[i];
      const o = this.robos[1 - i];
      const dx = o.pos.x - r.pos.x;
      const dz = o.pos.z - r.pos.z;
      const dy = (o.pos.y + 0.95) - (r.pos.y + 1.05);
      const flat = Math.hypot(dx, dz);
      const targetYaw = Math.atan2(dx, dz);
      const targetPitch = Math.atan2(dy, Math.max(0.5, flat));

      const rate = r.state === STATE.DOWN ? 0.06 : 0.34;
      r.aimYaw = approachAngle(r.aimYaw, targetYaw, rate);
      r.aimPitch += (targetPitch - r.aimPitch) * 0.4;
      // The body turns a little slower than the aim, which reads as weight.
      r.yaw = approachAngle(r.yaw, r.aimYaw, rate * 0.85);
      r.pitch = r.aimPitch;
    }
  }

  resolveRoboOverlap() {
    const a = this.robos[0], b = this.robos[1];
    const dx = b.pos.x - a.pos.x;
    const dz = b.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    const min = ROBO_RADIUS * 2;
    if (d > min || d < 1e-5) return;
    // Vertically separated robos pass each other freely.
    if (Math.abs(a.pos.y - b.pos.y) > ROBO_HEIGHT * 0.9) return;
    const push = (min - d) * 0.5;
    const nx = dx / d, nz = dz / d;
    a.pos.x -= nx * push; a.pos.z -= nz * push;
    b.pos.x += nx * push; b.pos.z += nz * push;
  }

  // -------------------------------------------------------------------------
  // Projectiles
  // -------------------------------------------------------------------------

  alloc() {
    for (let i = 0; i < MAX_PROJ; i++) {
      const idx = (this.projCursor + i) % MAX_PROJ;
      const p = this.proj[idx];
      if (!p.alive) {
        this.projCursor = (idx + 1) % MAX_PROJ;
        p.stuck = 0; p.timer = 0; p.sub = 0; p.mode = 0;
        p.pierce = 0; p.charged = 0; p.homing = 0; p.scale = 1;
        return p;
      }
    }
    return null;
  }

  stepProjectiles() {
    const robos = this.robos;
    for (let i = 0; i < MAX_PROJ; i++) {
      const p = this.proj[i];
      if (!p.alive) continue;

      p.life--;
      if (p.life <= 0) {
        if (p.kind === PK.BOMB) this.explode(p);
        else if (p.kind === PK.POD) this.explode(p, 0.7);
        else this.emit(EV.BULLET_EXPIRE, { x: p.pos.x, y: p.pos.y, z: p.pos.z, part: p.partIdx });
        p.alive = 0;
        continue;
      }

      switch (p.kind) {
        case PK.BULLET: this.stepBullet(p, robos); break;
        case PK.BOMB: this.stepBomb(p, robos); break;
        case PK.POD: this.stepPod(p, robos); break;
      }
    }
  }

  stepBullet(p, robos) {
    if (p.homing > 0) {
      const t = robos[1 - p.owner];
      const tx = t.pos.x - p.pos.x;
      const ty = (t.pos.y + 0.95) - p.pos.y;
      const tz = t.pos.z - p.pos.z;
      const tl = Math.hypot(tx, ty, tz);
      if (tl > 0.2 && tl < 26) {
        const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
        const k = p.homing * TICK_DT;
        p.vel.x += (tx / tl * sp - p.vel.x) * k;
        p.vel.y += (ty / tl * sp - p.vel.y) * k;
        p.vel.z += (tz / tl * sp - p.vel.z) * k;
        const ns = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
        p.vel.x *= sp / ns; p.vel.y *= sp / ns; p.vel.z *= sp / ns;
      }
    }

    // Substep fast bullets so nothing tunnels through a robo or a pillar.
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    const steps = speed * TICK_DT > 0.6 ? Math.min(5, Math.ceil(speed * TICK_DT / 0.6)) : 1;
    const sdt = TICK_DT / steps;

    for (let s = 0; s < steps; s++) {
      p.pos.x += p.vel.x * sdt;
      p.pos.y += p.vel.y * sdt;
      p.pos.z += p.vel.z * sdt;

      const target = robos[1 - p.owner];
      if (this.hitsRobo(p, target)) {
        this.damageRobo(target, p.damage, p, p.charged ? 1.6 : 1);
        if (!p.pierce) { p.alive = 0; return; }
      }

      const h = probePoint(this.arena, p.pos, p.radius * 0.5);
      if (h.hit) {
        this.emit(EV.HIT, {
          x: p.pos.x, y: p.pos.y, z: p.pos.z,
          nx: h.nx, ny: h.ny, nz: h.nz,
          part: p.partIdx, charged: p.charged, surface: 1,
        });
        p.alive = 0;
        return;
      }
    }
  }

  stepBomb(p, robos) {
    if (p.stuck) {
      // Stuck to geometry — just tick the fuse.
      return;
    }
    p.vel.y -= GRAVITY * 0.86 * TICK_DT;
    const bomb = bombByIndex(p.partIdx);

    const steps = 2;
    const sdt = TICK_DT / steps;
    for (let s = 0; s < steps; s++) {
      p.pos.x += p.vel.x * sdt;
      p.pos.y += p.vel.y * sdt;
      p.pos.z += p.vel.z * sdt;

      const target = robos[1 - p.owner];
      if (this.hitsRobo(p, target, 0.55)) {
        this.explode(p);
        p.alive = 0;
        return;
      }

      const h = probePoint(this.arena, p.pos, 0.22);
      if (h.hit) {
        if (bomb.sticky) {
          p.stuck = 1;
          p.vel.x = p.vel.y = p.vel.z = 0;
          p.nx = h.nx; p.ny = h.ny; p.nz = h.nz;
          // Sit just proud of the surface.
          p.pos.x += h.nx * 0.16; p.pos.y += h.ny * 0.16; p.pos.z += h.nz * 0.16;
          return;
        }
        if (bomb.groundOnly && h.ny > 0.5) {
          this.explode(p);
          p.alive = 0;
          return;
        }
        const b = bomb.bounce ?? 0.4;
        const vn = p.vel.x * h.nx + p.vel.y * h.ny + p.vel.z * h.nz;
        p.vel.x -= (1 + b) * vn * h.nx;
        p.vel.y -= (1 + b) * vn * h.ny;
        p.vel.z -= (1 + b) * vn * h.nz;
        p.vel.x *= 0.82; p.vel.z *= 0.82;
        p.pos.x += h.nx * 0.06; p.pos.y += h.ny * 0.06; p.pos.z += h.nz * 0.06;
        this.emit(EV.WALL_HIT, { x: p.pos.x, y: p.pos.y, z: p.pos.z, nx: h.nx, nz: h.nz, soft: 1 });
      }
    }
  }

  stepPod(p, robos) {
    const pod = podByIndex(p.partIdx);
    const target = robos[1 - p.owner];
    p.timer++;

    const tx = target.pos.x - p.pos.x;
    const tz = target.pos.z - p.pos.z;
    const flat = Math.hypot(tx, tz) || 1;

    if (p.mode === 1) {
      // Turret: crawl a short way out, plant, then fire on a cadence.
      if (p.timer > 40) { p.vel.x *= 0.86; p.vel.z *= 0.86; }
      if (p.timer % pod.fireInterval === 0 && p.timer > 40) {
        const b = this.alloc();
        if (b) {
          const ty = (target.pos.y + 0.9) - (p.pos.y + 0.3);
          const tl = Math.hypot(tx, ty, tz) || 1;
          b.alive = 1; b.kind = PK.BULLET; b.owner = p.owner; b.team = p.team;
          b.pos.x = p.pos.x; b.pos.y = p.pos.y + 0.35; b.pos.z = p.pos.z;
          b.vel.x = tx / tl * pod.bulletSpeed;
          b.vel.y = ty / tl * pod.bulletSpeed;
          b.vel.z = tz / tl * pod.bulletSpeed;
          b.life = b.maxLife = 60;
          b.damage = pod.damage; b.radius = 0.24; b.knockback = pod.knockback;
          b.homing = 0; b.pierce = 0; b.charged = 0;
          b.partIdx = 0; b.scale = 0.85; b.seed = this.rng.u32();
          this.emit(EV.FIRE_GUN, { id: p.owner, pod: 1, x: p.pos.x, y: p.pos.y + 0.35, z: p.pos.z });
        }
      }
    } else if (p.mode === 2) {
      // Orbit: circles the target and closes in over time.
      const ang = Math.atan2(tx, tz) + Math.PI * 0.5;
      const closeness = clamp(1 - p.timer / p.maxLife, 0, 1);
      const desiredR = 3.0 + closeness * 5.0;
      const radial = (flat - desiredR) * 1.4;
      const ox = Math.sin(ang), oz = Math.cos(ang);
      const dirX = (tx / flat) * radial + ox * pod.speed;
      const dirZ = (tz / flat) * radial + oz * pod.speed;
      const dl = Math.hypot(dirX, dirZ) || 1;
      p.vel.x += ((dirX / dl) * pod.speed - p.vel.x) * pod.turn * TICK_DT;
      p.vel.z += ((dirZ / dl) * pod.speed - p.vel.z) * pod.turn * TICK_DT;
    } else {
      // Charge: beeline, hugging the ground.
      p.vel.x += ((tx / flat) * pod.speed - p.vel.x) * pod.turn * TICK_DT;
      p.vel.z += ((tz / flat) * pod.speed - p.vel.z) * pod.turn * TICK_DT;
    }

    // Hover a fixed height over whatever surface is beneath.
    const gh = groundHeightAt(this.arena, p.pos.x, p.pos.z, 0.3);
    const desiredY = gh + 0.32;
    p.vel.y += (desiredY - p.pos.y) * 9.0 * TICK_DT;
    p.vel.y *= 0.86;

    p.pos.x += p.vel.x * TICK_DT;
    p.pos.y += p.vel.y * TICK_DT;
    p.pos.z += p.vel.z * TICK_DT;

    const b = this.arena.bounds;
    if (p.pos.x < -b.hx + 0.3) { p.pos.x = -b.hx + 0.3; p.vel.x = Math.abs(p.vel.x); }
    if (p.pos.x > b.hx - 0.3) { p.pos.x = b.hx - 0.3; p.vel.x = -Math.abs(p.vel.x); }
    if (p.pos.z < -b.hz + 0.3) { p.pos.z = -b.hz + 0.3; p.vel.z = Math.abs(p.vel.z); }
    if (p.pos.z > b.hz - 0.3) { p.pos.z = b.hz - 0.3; p.vel.z = -Math.abs(p.vel.z); }

    if (p.mode !== 1 && this.hitsRobo(p, target, 0.6)) {
      this.explode(p);
      p.alive = 0;
      return;
    }
    if (p.timer % 6 === 0) {
      this.emit(EV.POD_STEP, { x: p.pos.x, y: p.pos.y, z: p.pos.z, part: p.partIdx });
    }
  }

  hitsRobo(p, r, extra = 0) {
    if (r.state === STATE.DEAD) return false;
    if (r.invuln > 0) return false;
    const rad = ROBO_RADIUS + p.radius * 0.5 + extra;
    const dx = p.pos.x - r.pos.x;
    const dz = p.pos.z - r.pos.z;
    if (dx * dx + dz * dz > rad * rad) return false;
    const dy = p.pos.y - (r.pos.y + ROBO_HEIGHT * 0.5);
    return Math.abs(dy) < ROBO_HEIGHT * 0.5 + p.radius * 0.5 + extra * 0.5;
  }

  explode(p, scale = 1) {
    const radius = p.radius * scale;
    this.emit(EV.EXPLODE, {
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      radius, kind: p.kind, part: p.partIdx, seed: p.seed,
    });

    for (const r of this.robos) {
      if (r.state === STATE.DEAD || r.invuln > 0) continue;
      const cx = r.pos.x, cy = r.pos.y + ROBO_HEIGHT * 0.5, cz = r.pos.z;
      const d = Math.hypot(cx - p.pos.x, cy - p.pos.y, cz - p.pos.z);
      if (d > radius + ROBO_RADIUS) continue;
      const falloff = clamp(1 - (d - ROBO_RADIUS) / Math.max(0.001, radius), 0.25, 1);
      // Splash from your own bomb still hurts — spacing is part of the game.
      const mul = r.id === p.owner ? 0.45 : 1;
      const dmg = p.damage * falloff * mul;
      const dirX = (cx - p.pos.x) / Math.max(0.4, d);
      const dirZ = (cz - p.pos.z) / Math.max(0.4, d);
      this.damageRobo(r, dmg, {
        pos: p.pos, knockback: p.knockback * falloff,
        vel: { x: dirX * 12, y: 8, z: dirZ * 12 },
        partIdx: p.partIdx, charged: 1, kind: p.kind,
      }, 1.4, true);
    }

    // Cluster bombs seed a ring of smaller charges.
    const bomb = p.kind === PK.BOMB ? bombByIndex(p.partIdx) : null;
    if (bomb && bomb.submunitions && !p.sub) {
      for (let i = 0; i < bomb.submunitions; i++) {
        const c = this.alloc();
        if (!c) break;
        const a = (i / bomb.submunitions) * Math.PI * 2 + this.rng.f();
        c.alive = 1; c.kind = PK.BOMB; c.owner = p.owner; c.team = p.team;
        c.pos.x = p.pos.x; c.pos.y = p.pos.y + 0.4; c.pos.z = p.pos.z;
        c.vel.x = Math.sin(a) * 7; c.vel.y = 6.5; c.vel.z = Math.cos(a) * 7;
        c.life = c.maxLife = 34;
        c.damage = p.damage * 0.55; c.radius = p.radius * 0.8;
        c.knockback = p.knockback * 0.5;
        c.partIdx = p.partIdx; c.scale = 0.6; c.sub = 1;
        c.seed = this.rng.u32();
      }
    }
  }

  damageRobo(r, dmg, src, kbMul = 1, heavy = false) {
    if (r.hp <= 0 || r.state === STATE.DEAD) return;
    dmg = Math.round(dmg);
    r.hp = Math.max(0, r.hp - dmg);
    r.hurtFlash = 10;
    r.lastDamage = dmg;
    r.recentDmg += dmg;
    r.recentDmgTimer = DOWN_WINDOW;
    r.comboHits++;

    const kb = (src.knockback || 2) * kbMul * this.loadouts[r.id].body.knockbackTaken;
    let dx = src.vel ? src.vel.x : 0;
    let dz = src.vel ? src.vel.z : 0;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;

    r.vel.x += dx * kb;
    r.vel.z += dz * kb;
    r.stun = Math.max(r.stun, T.hitStun);

    const forceDown = heavy || r.recentDmg >= DOWN_THRESHOLD;
    if (forceDown && r.state !== STATE.DOWN) {
      r.state = STATE.DOWN;
      r.stateTimer = T.downTime;
      r.vel.y = Math.max(r.vel.y, 6.5 + kb * 0.28);
      r.vel.x += dx * kb * 0.9;
      r.vel.z += dz * kb * 0.9;
      r.grounded = false;
      r.recentDmg = 0;
      this.emit(EV.DOWN, { id: r.id, x: r.pos.x, y: r.pos.y, z: r.pos.z });
    }

    this.emit(EV.HIT, {
      x: src.pos ? src.pos.x : r.pos.x,
      y: src.pos ? src.pos.y : r.pos.y + 1,
      z: src.pos ? src.pos.z : r.pos.z,
      nx: -dx, ny: 0.2, nz: -dz,
      target: r.id, damage: dmg, part: src.partIdx || 0,
      charged: src.charged || 0, heavy: heavy ? 1 : 0,
      combo: r.comboHits, hpFrac: r.hp / r.maxHp, surface: 0,
    });

    if (r.hp <= 0) {
      r.state = STATE.DOWN;
      r.stateTimer = 9999;
      r.vel.y = 9;
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot / restore — the rollback contract
  // -------------------------------------------------------------------------

  snapshot() {
    const robos = this.robos.map((r) => ({
      pos: { ...r.pos }, vel: { ...r.vel },
      yaw: r.yaw, pitch: r.pitch, aimYaw: r.aimYaw, aimPitch: r.aimPitch,
      hp: r.hp, maxHp: r.maxHp, state: r.state, stateTimer: r.stateTimer,
      grounded: r.grounded, jumpsLeft: r.jumpsLeft, airDashesLeft: r.airDashesLeft,
      gunCd: r.gunCd, bombCd: r.bombCd, podCd: r.podCd,
      charge: r.charge, chargeReady: r.chargeReady,
      burstLeft: r.burstLeft, burstTimer: r.burstTimer, burstCharged: r.burstCharged,
      invuln: r.invuln, stun: r.stun, landLag: r.landLag,
      recentDmg: r.recentDmg, recentDmgTimer: r.recentDmgTimer,
      dashX: r.dashX, dashZ: r.dashZ, podId: r.podId,
      fireFlash: r.fireFlash, hurtFlash: r.hurtFlash, boostHeat: r.boostHeat,
      moveAmt: r.moveAmt, stepPhase: r.stepPhase, lastDamage: r.lastDamage,
      comboHits: r.comboHits,
    }));

    const live = [];
    for (let i = 0; i < MAX_PROJ; i++) {
      const p = this.proj[i];
      if (!p.alive) continue;
      live.push([
        i, p.kind, p.owner, p.team,
        p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z,
        p.life, p.maxLife, p.damage, p.radius, p.knockback,
        p.homing, p.pierce, p.charged, p.partIdx, p.mode, p.timer,
        p.stuck, p.scale, p.seed, p.sub, p.nx, p.ny, p.nz,
      ]);
    }

    return {
      tick: this.tick, phase: this.phase, phaseTimer: this.phaseTimer,
      roundTimer: this.roundTimer, round: this.round,
      wins: [this.wins[0], this.wins[1]], winner: this.winner, koFreeze: this.koFreeze,
      rng: this.rng.save(), projCursor: this.projCursor,
      robos, live,
      prevInputs: this.prevInputs.map((i) => ({ ...i })),
    };
  }

  restore(s) {
    this.tick = s.tick; this.phase = s.phase; this.phaseTimer = s.phaseTimer;
    this.roundTimer = s.roundTimer; this.round = s.round;
    this.wins[0] = s.wins[0]; this.wins[1] = s.wins[1];
    this.winner = s.winner; this.koFreeze = s.koFreeze;
    this.rng.load(s.rng);
    this.projCursor = s.projCursor;

    for (let i = 0; i < 2; i++) {
      const r = this.robos[i], t = s.robos[i];
      r.pos.x = t.pos.x; r.pos.y = t.pos.y; r.pos.z = t.pos.z;
      r.vel.x = t.vel.x; r.vel.y = t.vel.y; r.vel.z = t.vel.z;
      r.yaw = t.yaw; r.pitch = t.pitch; r.aimYaw = t.aimYaw; r.aimPitch = t.aimPitch;
      r.hp = t.hp; r.maxHp = t.maxHp; r.state = t.state; r.stateTimer = t.stateTimer;
      r.grounded = t.grounded; r.jumpsLeft = t.jumpsLeft; r.airDashesLeft = t.airDashesLeft;
      r.gunCd = t.gunCd; r.bombCd = t.bombCd; r.podCd = t.podCd;
      r.charge = t.charge; r.chargeReady = t.chargeReady;
      r.burstLeft = t.burstLeft; r.burstTimer = t.burstTimer; r.burstCharged = t.burstCharged;
      r.invuln = t.invuln; r.stun = t.stun; r.landLag = t.landLag;
      r.recentDmg = t.recentDmg; r.recentDmgTimer = t.recentDmgTimer;
      r.dashX = t.dashX; r.dashZ = t.dashZ; r.podId = t.podId;
      r.fireFlash = t.fireFlash; r.hurtFlash = t.hurtFlash; r.boostHeat = t.boostHeat;
      r.moveAmt = t.moveAmt; r.stepPhase = t.stepPhase; r.lastDamage = t.lastDamage;
      r.comboHits = t.comboHits;
      copyInput(this.prevInputs[i], s.prevInputs[i]);
    }

    for (let i = 0; i < MAX_PROJ; i++) this.proj[i].alive = 0;
    for (const a of s.live) {
      const p = this.proj[a[0]];
      p.alive = 1;
      p.kind = a[1]; p.owner = a[2]; p.team = a[3];
      p.pos.x = a[4]; p.pos.y = a[5]; p.pos.z = a[6];
      p.vel.x = a[7]; p.vel.y = a[8]; p.vel.z = a[9];
      p.life = a[10]; p.maxLife = a[11]; p.damage = a[12]; p.radius = a[13];
      p.knockback = a[14]; p.homing = a[15]; p.pierce = a[16]; p.charged = a[17];
      p.partIdx = a[18]; p.mode = a[19]; p.timer = a[20]; p.stuck = a[21];
      p.scale = a[22]; p.seed = a[23]; p.sub = a[24];
      p.nx = a[25]; p.ny = a[26]; p.nz = a[27];
    }
  }

  /** Cheap desync detector for netplay — order-independent state digest. */
  checksum() {
    let h = 2166136261;
    const mix = (v) => {
      h ^= (v | 0);
      h = Math.imul(h, 16777619);
      h >>>= 0;
    };
    for (const r of this.robos) {
      mix(Math.round(r.pos.x * 512)); mix(Math.round(r.pos.y * 512)); mix(Math.round(r.pos.z * 512));
      mix(Math.round(r.vel.x * 256)); mix(Math.round(r.vel.y * 256)); mix(Math.round(r.vel.z * 256));
      mix(r.hp); mix(r.state); mix(r.stateTimer); mix(Math.round(r.aimYaw * 1024));
    }
    for (let i = 0; i < MAX_PROJ; i++) {
      const p = this.proj[i];
      if (!p.alive) continue;
      mix(i); mix(p.kind); mix(p.life);
      mix(Math.round(p.pos.x * 256)); mix(Math.round(p.pos.y * 256)); mix(Math.round(p.pos.z * 256));
    }
    mix(this.tick); mix(this.phase); mix(this.roundTimer);
    return h >>> 0;
  }
}

// ---------------------------------------------------------------------------
// Part index tables — snapshots store small ints, not object references.
// ---------------------------------------------------------------------------

import { GUNS, BOMBS, PODS } from './parts.js';

const gunIdx = new Map(GUNS.map((g, i) => [g.id, i]));
const bombIdx = new Map(BOMBS.map((b, i) => [b.id, i]));
const podIdx = new Map(PODS.map((p, i) => [p.id, i]));

export const gunIndex = (id) => gunIdx.get(id) ?? 0;
export const bombIndex = (id) => bombIdx.get(id) ?? 0;
export const podIndex = (id) => podIdx.get(id) ?? 0;
export const gunByIndex = (i) => GUNS[i] || GUNS[0];
export const bombByIndex = (i) => BOMBS[i] || BOMBS[0];
export const podByIndex = (i) => PODS[i] || PODS[0];

export { MAX_PROJ };
