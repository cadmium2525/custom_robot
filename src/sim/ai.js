/**
 * Commander AI.
 *
 * The AI is not privileged: it produces `InputFrame`s exactly like a human pad
 * does, so the sim can't tell the difference and netplay can drop it in as a
 * stand-in for a disconnected peer.
 *
 * Difficulty scales reaction latency, aim discipline and how often it bothers to
 * dodge — not damage numbers.
 */

import { BTN, makeInput, quantizeInput } from './input.js';
import { TICK_DT, PK } from './constants.js';
import { STATE, PHASE, bombByIndex } from './world.js';
import { lineOfSight } from './physics.js';
import { Rng, clamp, angleDelta } from '../core/mathx.js';

export const DIFFICULTY = [
  { id: 'rookie',  name: 'ROOKIE',  kana: 'ルーキー',  react: 16, aimErr: 0.20, dodge: 0.20, aggro: 0.45, chargeUse: 0.10, comboSense: 0.2 },
  { id: 'pilot',   name: 'PILOT',   kana: 'パイロット', react: 10, aimErr: 0.11, dodge: 0.42, aggro: 0.62, chargeUse: 0.30, comboSense: 0.45 },
  { id: 'ace',     name: 'ACE',     kana: 'エース',    react: 6,  aimErr: 0.055, dodge: 0.66, aggro: 0.78, chargeUse: 0.55, comboSense: 0.7 },
  { id: 'master',  name: 'MASTER',  kana: 'マスター',  react: 3,  aimErr: 0.022, dodge: 0.85, aggro: 0.9,  chargeUse: 0.75, comboSense: 0.9 },
  { id: 'legend',  name: 'LEGEND',  kana: 'レジェンド', react: 1,  aimErr: 0.008, dodge: 0.95, aggro: 1.0,  chargeUse: 0.9,  comboSense: 1.0 },
];

export const DIFFICULTY_BY_ID = new Map(DIFFICULTY.map((d) => [d.id, d]));

export class RoboAI {
  constructor(world, index, difficultyId = 'ace', seed = 0xC0FFEE) {
    this.world = world;
    this.i = index;
    this.diff = DIFFICULTY_BY_ID.get(difficultyId) || DIFFICULTY[2];
    this.rng = new Rng(seed ^ (index * 0x9e3779b1));
    this.input = makeInput();

    this.think = 0;
    this.strafeDir = 1;
    this.strafeTimer = 0;
    this.desiredRange = 9;
    this.holdFire = 0;
    this.charging = 0;
    this.chargeGoal = 0;
    this.dodgeTimer = 0;
    this.dodgeX = 0;
    this.dodgeZ = 0;
    this.jumpCooldown = 0;
    this.repositionTimer = 0;
    this.lastThreat = 0;
  }

  setDifficulty(id) {
    this.diff = DIFFICULTY_BY_ID.get(id) || this.diff;
  }

  /** Returns the InputFrame for this tick. */
  update() {
    const w = this.world;
    const me = w.robos[this.i];
    const foe = w.robos[1 - this.i];
    const ld = w.loadouts[this.i];
    const inp = this.input;
    const d = this.diff;

    inp.buttons = 0;
    inp.moveX = 0;
    inp.moveZ = 0;

    if (w.phase !== PHASE.FIGHT || me.state === STATE.DOWN || me.state === STATE.DEAD) {
      inp.yaw = Math.atan2(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z);
      return quantizeInput(inp);
    }

    if (this.jumpCooldown > 0) this.jumpCooldown--;
    if (this.strafeTimer > 0) this.strafeTimer--;
    if (this.dodgeTimer > 0) this.dodgeTimer--;
    if (this.repositionTimer > 0) this.repositionTimer--;
    if (this.holdFire > 0) this.holdFire--;

    const dx = foe.pos.x - me.pos.x;
    const dz = foe.pos.z - me.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const toFoeX = dx / dist;
    const toFoeZ = dz / dist;

    // The AI "faces" the target; movement is expressed relative to that facing,
    // which is exactly the frame a human player's camera provides.
    inp.yaw = Math.atan2(dx, dz);

    // ---- pick a preferred engagement range from the loadout ---------------
    if (this.repositionTimer <= 0) {
      const gun = ld.gun;
      const ideal = gun.id === 'scatter' ? 5.5 : gun.id === 'lancer' ? 15 : gun.id === 'seeker' ? 12 : 9;
      this.desiredRange = ideal + this.rng.range(-1.6, 1.6);
      this.repositionTimer = 40 + this.rng.int(50);
      if (this.strafeTimer <= 0) {
        this.strafeDir = this.rng.f() < 0.5 ? -1 : 1;
        this.strafeTimer = 30 + this.rng.int(60);
      }
    }

    // ---- threat assessment: what is about to hit me? ----------------------
    const threat = this.assessThreat(me);
    if (threat.level > 0 && this.dodgeTimer <= 0 && this.rng.f() < d.dodge) {
      // Sidestep perpendicular to the incoming shot.
      const px = -threat.dz, pz = threat.dx;
      const side = (px * -toFoeZ + pz * toFoeX) >= 0 ? 1 : -1;
      this.dodgeX = px * side;
      this.dodgeZ = pz * side;
      this.dodgeTimer = 14 + this.rng.int(10);
      if (threat.level > 1 && this.jumpCooldown <= 0) {
        // Heavy ordnance: leave the ground entirely.
        inp.buttons |= BTN.JUMP;
        this.jumpCooldown = 26;
      } else if (this.rng.f() < 0.55) {
        inp.buttons |= BTN.DASH;
      }
    }

    // ---- movement --------------------------------------------------------
    let mx = 0, mz = 0;
    if (this.dodgeTimer > 0) {
      mx = this.dodgeX;
      mz = this.dodgeZ;
    } else {
      const err = dist - this.desiredRange;
      // Forward/back to hold range, plus a constant strafe so it never presents
      // a static target.
      const approach = clamp(err / 5, -1, 1) * d.aggro;
      mx = -toFoeZ * this.strafeDir * 0.85 + toFoeX * approach;
      mz = toFoeX * this.strafeDir * 0.85 + toFoeZ * approach;
    }

    // Stay off the walls — being cornered is how AI loses rounds.
    const b = w.arena.bounds;
    const edge = 3.5;
    if (me.pos.x < -b.hx + edge) mx += 0.9;
    if (me.pos.x > b.hx - edge) mx -= 0.9;
    if (me.pos.z < -b.hz + edge) mz += 0.9;
    if (me.pos.z > b.hz - edge) mz -= 0.9;

    const ml = Math.hypot(mx, mz);
    if (ml > 1e-4) { mx /= ml; mz /= ml; }

    // Input is expressed in the AI's own facing frame (inp.yaw), so rotate the
    // world-space desire back into stick space.
    const cy = Math.cos(inp.yaw), sy = Math.sin(inp.yaw);
    inp.moveX = mx * cy - mz * sy;
    inp.moveZ = mx * sy + mz * cy;

    // ---- vertical game ---------------------------------------------------
    if (this.jumpCooldown <= 0 && me.grounded && this.rng.f() < 0.02 * (0.5 + d.aggro)) {
      inp.buttons |= BTN.JUMP;
      this.jumpCooldown = 34;
    }
    if (!me.grounded && me.airDashesLeft > 0 && me.vel.y < -2 && this.rng.f() < 0.06 * d.dodge) {
      inp.buttons |= BTN.DASH;
    }

    // ---- shooting --------------------------------------------------------
    const canSee = lineOfSight(w.arena, { x: me.pos.x, y: me.pos.y + 1.05, z: me.pos.z },
      { x: foe.pos.x, y: foe.pos.y + 1.0, z: foe.pos.z }, 8);

    const aimOff = Math.abs(angleDelta(me.aimYaw, Math.atan2(dx, dz)));
    const aimed = aimOff < 0.10 + d.aimErr;

    if (canSee && this.holdFire <= 0 && dist < 30) {
      const gun = ld.gun;
      if (this.charging > 0) {
        this.charging--;
        inp.buttons |= BTN.FIRE;
        if (this.charging === 0) {
          // Release happens by simply not setting the bit next tick.
          this.holdFire = 4;
        }
      } else if (aimed) {
        // Occasionally commit to a charged shot when the opening is big enough.
        const wantCharge = this.rng.f() < d.chargeUse * 0.08 &&
          (foe.state === STATE.DOWN || dist > this.desiredRange * 1.3);
        if (wantCharge) {
          this.charging = gun.chargeTicks + 3;
          this.chargeGoal = 1;
        } else {
          inp.buttons |= BTN.FIRE;
        }
      }

      // Bombs: lead the target, prefer a grounded or committed opponent.
      if (me.bombCd <= 0 && dist < 16 && dist > 3.5) {
        const bomb = ld.bomb;
        const good = foe.grounded || foe.state === STATE.DOWN || bomb.sticky;
        if (good && this.rng.f() < 0.10 * (0.4 + d.aggro)) inp.buttons |= BTN.BOMB;
      }

      if (me.podCd <= 0 && dist < 24 && this.rng.f() < 0.12 * (0.4 + d.aggro)) {
        inp.buttons |= BTN.POD;
      }
    } else if (!canSee && this.rng.f() < 0.02) {
      // Break cover rather than trade shots with a pillar.
      this.repositionTimer = 0;
    }

    // Punish a downed opponent: reposition on top of where they will get up.
    if (foe.state === STATE.DOWN && d.comboSense > this.rng.f()) {
      this.desiredRange = Math.min(this.desiredRange, 7.5);
      if (me.bombCd <= 0 && dist < 12) inp.buttons |= BTN.BOMB;
    }

    return quantizeInput(inp);
  }

  /**
   * Scan live projectiles for anything on an intercept course.
   * level 0 = clear, 1 = bullet, 2 = explosive.
   */
  assessThreat(me) {
    const w = this.world;
    let best = { level: 0, dx: 0, dz: 0, t: 999 };
    const react = this.diff.react;

    for (let i = 0; i < w.proj.length; i++) {
      const p = w.proj[i];
      if (!p.alive || p.owner === this.i) continue;

      const rx = me.pos.x - p.pos.x;
      const rz = me.pos.z - p.pos.z;
      const dist = Math.hypot(rx, rz);
      const speed = Math.hypot(p.vel.x, p.vel.z) || 0.001;
      const eta = dist / speed / TICK_DT;   // in ticks

      // Only react once the projectile is inside our reaction window.
      if (eta > 32 + react * 2 || eta < react * 0.4) continue;

      const dirX = p.vel.x / speed;
      const dirZ = p.vel.z / speed;
      // Perpendicular miss distance at closest approach.
      const along = rx * dirX + rz * dirZ;
      if (along < 0) continue;
      const missX = rx - dirX * along;
      const missZ = rz - dirZ * along;
      const miss = Math.hypot(missX, missZ);

      const danger = p.kind === PK.BOMB || p.kind === PK.POD ? 2 : 1;
      const window = danger === 2 ? p.radius + 1.6 : 1.1 + p.radius;
      if (miss > window) continue;

      if (eta < best.t || danger > best.level) {
        best = { level: danger, dx: dirX, dz: dirZ, t: eta };
      }
    }
    return best;
  }
}
