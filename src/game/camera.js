/**
 * Duel camera rig.
 *
 * Custom Robo's camera keeps both fighters legible at all times rather than
 * sitting on one player's shoulder. This rig does the same: it frames the pair,
 * anchors behind the local robo so movement input stays intuitive, and pulls
 * back as the fighters separate.
 *
 * The player can still nudge the orbit — expression matters — but the rig
 * always re-centres, so nobody loses their opponent.
 */

import * as THREE from 'three';
import { damp, clamp, lerp, angleDelta, approachAngle } from '../core/mathx.js';
import { PHASE, STATE } from '../sim/world.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fit = new THREE.Vector3();
const _fit2 = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class DuelCamera {
  constructor(camera, arena) {
    this.camera = camera;
    this.arena = arena;

    this.yaw = 0;
    this.yawOffset = 0;       // player look nudge, decays back to 0
    this.pitch = 0.26;
    this.distance = 11;
    this.height = 2.7;

    this.position = new THREE.Vector3(0, 4, -14);
    this.target = new THREE.Vector3(0, 1.2, 0);
    this.smoothPos = new THREE.Vector3(0, 4, -14);
    this.smoothTarget = new THREE.Vector3(0, 1.2, 0);

    this.shake = new THREE.Vector3();
    this.shakeRoll = 0;
    this.shakeAmount = 1;

    this.fovBase = camera.fov;
    this.fovOffset = 0;
    this.roll = 0;

    this.introT = 0;
    this.mode = 'intro';
    this.timeScale = 1;
    /** Closed-loop boom multiplier — capped, so the player never shrinks far. */
    this.fitBoost = 1;
    /** How far ahead of the player the rig aims, to keep the opponent framed. */
    this.lookAhead = 1;
    /**
     * How far the orbit anchor slides from the player toward the midpoint.
     * Pulling the camera BACK to fit both fighters shrinks both of them, which
     * is the mistake this rig was written to undo. Sliding the anchor instead
     * closes distance on the opponent while giving up the player's scale only
     * slowly, because the two move in opposite directions by the same amount.
     */
    this.anchorBias = 0;

    this._prevLocalPos = new THREE.Vector3();
    this._speedBlur = 0;
  }

  reset(world, localIndex) {
    this.introT = 0;
    this.mode = 'intro';
    this.fitBoost = 1;
    this.lookAhead = 1;
    this.anchorBias = 0;
    const r = world.robos[localIndex];
    const o = world.robos[1 - localIndex];
    this.yaw = Math.atan2(r.pos.x - o.pos.x, r.pos.z - o.pos.z);
    this.yawOffset = 0;
  }

  /** Player look nudge from mouse / stick / touch drag. */
  look(dx, dy) {
    this.yawOffset = clamp(this.yawOffset + dx * 1.35, -1.15, 1.15);
    this.pitch = clamp(this.pitch + dy * 0.9, -0.12, 0.78);
  }

  /**
   * @param world  the sim
   * @param alpha  0..1 interpolation between ticks
   * @param dt     seconds
   * @param localIndex which robo the camera belongs to
   * @param interp array of interpolated {pos, ...} render states
   */
  update(world, interp, localIndex, dt, time) {
    const me = interp[localIndex];
    const foe = interp[1 - localIndex];

    _a.set(me.pos.x, me.pos.y, me.pos.z);
    _b.set(foe.pos.x, foe.pos.y, foe.pos.z);

    const separation = _a.distanceTo(_b);

    // ---- framing model -------------------------------------------------
    //
    // The rig used to try to fit BOTH fighters inside the frustum, pulling the
    // boom out until they both fitted. At arena-length separations that put the
    // camera 25m away and rendered two 1.6m robos at 3% of frame height — you
    // could not find your own machine in a screenshot, let alone read a fight.
    //
    // So it no longer negotiates. The camera is anchored a fixed short distance
    // behind the LOCAL robo, looking along the axis toward the opponent. The
    // player is always large and always in the same place; the opponent gets
    // smaller with range, which is just honest perspective and is exactly how
    // the games this is modelled on staged their duels. When the opponent would
    // leave the frame the rig pans toward them rather than retreating.

    // Horizontal axis from the local robo toward its opponent.
    let ax = _b.x - _a.x;
    let az = _b.z - _a.z;
    const axl = Math.hypot(ax, az);
    if (axl > 1e-4) { ax /= axl; az /= axl; } else { ax = 0; az = 1; }
    const axisYaw = Math.atan2(-ax, -az);   // yaw of "behind the player"

    _mid.copy(_a).lerp(_b, 0.5);

    if (world.phase === PHASE.INTRO) {
      this._updateIntro(world, _mid, separation, dt, time);
    } else {
      this.mode = 'duel';
      // Approach rather than snap, so a fast strafe swings the camera smoothly.
      this.yaw = approachAngle(
        this.yaw, axisYaw,
        Math.min(1, dt * 3.4) * Math.abs(angleDelta(this.yaw, axisYaw)) + dt * 0.6
      );

      // Short and nearly constant: this is what holds the player at a readable
      // ~20-25% of frame height. Range only nudges it.
      const near = Math.min(separation, 22);
      const wantDist = 5.9 + near * 0.055;
      const wantHeight = 2.35 + near * 0.035 + Math.max(_a.y, _b.y) * 0.38;
      this.distance = damp(this.distance, wantDist, 4.5, dt);
      this.height = damp(this.height, wantHeight, 4.0, dt);
    }

    const yaw = this.yaw + this.yawOffset;
    // Player nudge decays so the rig always returns to the readable framing.
    this.yawOffset = damp(this.yawOffset, 0, 0.9, dt);
    this.pitch = damp(this.pitch, 0.1, 0.7, dt);

    // Orbit a point slid from the player toward the midpoint. At anchorBias 0
    // this is exactly the old player-anchored rig; as it opens up, the camera
    // closes on the opponent by the same distance it gives up on the player,
    // which is what lets a distant opponent grow without the fight retreating.
    _anchor.set(
      _a.x + (_mid.x - _a.x) * this.anchorBias,
      _a.y,
      _a.z + (_mid.z - _a.z) * this.anchorBias
    );

    const boom = this.distance * this.fitBoost;
    const rawX = _anchor.x + Math.sin(yaw) * boom;
    const rawZ = _anchor.z + Math.cos(yaw) * boom;

    // Keep the camera inside the arena shell.
    const bd = this.arena.bounds;
    const cx = clamp(rawX, -bd.hx + 1.0, bd.hx - 1.0);
    const cz = clamp(rawZ, -bd.hz + 1.0, bd.hz - 1.0);

    // Backed into a corner the boom can't extend, so it rises instead — the
    // player stays framed rather than ending up behind the lens.
    const lost = Math.hypot(rawX - cx, rawZ - cz);

    _desired.set(
      cx,
      _a.y + this.height + this.pitch * boom + lost * 0.8,
      cz
    );
    _desired.y = clamp(_desired.y, 1.2, bd.ceil - 0.8);

    // Aim ahead of the player toward the opponent, so the local robo sits low
    // and forward in frame with the fight laid out in front of it.
    const ahead = clamp(separation * 0.42, 2.2, 9) * this.lookAhead;
    _look.set(
      _a.x + ax * ahead,
      _a.y + 1.05 + Math.min(1.6, separation * 0.045) + (_b.y - _a.y) * 0.3,
      _a.z + az * ahead
    );

    const posLambda = this.mode === 'intro' ? 6.5 : 8.5;
    this.smoothPos.x = damp(this.smoothPos.x, _desired.x, posLambda, dt);
    this.smoothPos.y = damp(this.smoothPos.y, _desired.y, posLambda * 0.85, dt);
    this.smoothPos.z = damp(this.smoothPos.z, _desired.z, posLambda, dt);
    this.smoothTarget.x = damp(this.smoothTarget.x, _look.x, 9, dt);
    this.smoothTarget.y = damp(this.smoothTarget.y, _look.y, 8, dt);
    this.smoothTarget.z = damp(this.smoothTarget.z, _look.z, 9, dt);

    // ---- dynamic FOV: speed and impact both read as pressure ----
    const speed = Math.hypot(me.vel?.x || 0, me.vel?.z || 0);
    const dashing = me.state === STATE.DASH;
    const wantFov = (dashing ? 7.5 : 0) + clamp(speed * 0.22, 0, 4.5);
    this.fovOffset = damp(this.fovOffset, wantFov, 6, dt);
    this._speedBlur = damp(this._speedBlur, dashing ? 0.09 : clamp(speed * 0.0035, 0, 0.02), 7, dt);

    // ---- shake ----
    this.shake.multiplyScalar(Math.exp(-dt * 9));
    this.shakeRoll *= Math.exp(-dt * 8);

    const cam = this.camera;
    cam.position.copy(this.smoothPos).addScaledVector(this.shake, this.shakeAmount);
    cam.lookAt(this.smoothTarget);
    cam.rotateZ(this.roll + this.shakeRoll * this.shakeAmount);

    const targetFov = this.fovBase + this.fovOffset;
    if (Math.abs(cam.fov - targetFov) > 0.01) {
      cam.fov = targetFov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();

    // ---- closed-loop opponent-visibility check --------------------------
    // Measure where the opponent actually lands on screen. If they are leaving
    // frame, PAN toward them (lookAhead) before considering any pull-back, and
    // cap the pull-back hard — losing the opponent for a moment is recoverable,
    // rendering both fighters as specks is not.
    if (this.mode === 'duel') {
      _fit.set(_b.x, _b.y + 0.9, _b.z).project(cam);
      const off = _fit.z > 1 ? 2 : Math.max(Math.abs(_fit.x), Math.abs(_fit.y));

      const wantAhead = clamp(this.lookAhead * (off / 0.72), 1, 2.0);
      this.lookAhead = damp(this.lookAhead, wantAhead, wantAhead > this.lookAhead ? 7 : 1.4, dt);

      // Only after panning is maxed do we give up any of the player's scale.
      const needBoom = this.lookAhead > 1.85 ? clamp(off / 0.72, 1, 1.35) : 1;
      this.fitBoost = damp(this.fitBoost, needBoom, needBoom > this.fitBoost ? 5 : 1.1, dt);

      // ---- opponent SCALE, not just opponent presence ---------------------
      // The loop above only ever asked whether the opponent was inside the
      // frame, and an opponent can sit comfortably inside it while being far
      // too small to fight: measured at 7.3% of frame height against the
      // player's 23.2%. So measure the height they actually subtend, by
      // projecting their feet and their head, and treat anything under the
      // floor as a framing failure in its own right.
      _fit.set(_b.x, _b.y, _b.z).project(cam);
      _fit2.set(_b.x, _b.y + 1.62, _b.z).project(cam);
      const behind = _fit.z > 1 || _fit2.z > 1;
      // NDC spans 2 units across the frame, so half the NDC delta is the
      // fraction of frame height.
      const seen = behind ? 1 : Math.abs(_fit2.y - _fit.y) * 0.5;

      // Custom Robo keeps both machines readable; below about an eighth of the
      // frame the opponent stops being a fighter and becomes a target dot.
      const FLOOR = 0.12;
      // Square-rooted, because a linear response to the deficit is nearly no
      // response where it matters: an opponent at 7.8% against a 12% floor is
      // only a 35% shortfall, and 35% of the cap moved the anchor about a metre
      // out of fifteen, which is invisible.
      const deficit = clamp((FLOOR - seen) / FLOOR, 0, 1);
      const wantBias = behind ? 0 : Math.sqrt(deficit) * 0.62;
      // Open up briskly when the opponent is too small, close slowly, so a
      // fighter dashing in and out does not pump the camera.
      this.anchorBias = damp(this.anchorBias, wantBias, wantBias > this.anchorBias ? 2.2 : 0.8, dt);
    }
  }

  _updateIntro(world, mid, separation, dt, time) {
    this.mode = 'intro';
    this.introT += dt;
    const total = 2.5;
    const t = clamp(this.introT / total, 0, 1);
    // Sweeping orbit that settles into the duel framing.
    const ease = 1 - Math.pow(1 - t, 3);
    this.yaw = this.yaw + dt * 0.9 * (1 - ease);
    this.distance = lerp(22, clamp(7.4 + separation * 0.38, 8.4, 15), ease);
    this.height = lerp(9.5, clamp(2.6 + separation * 0.10, 2.6, 6.8), ease);
    this.pitch = lerp(0.34, 0.1, ease);
  }

  /** Additive impulse, typically from VFX.consumeShake(). */
  addShake(x, y, z, roll = 0) {
    this.shake.x += x;
    this.shake.y += y;
    this.shake.z += z;
    this.shakeRoll += roll;
  }

  /** Directional kick — used for hit reactions on the local player. */
  impulse(dirX, dirZ, strength) {
    this.shake.x += dirX * strength;
    this.shake.z += dirZ * strength;
    this.shake.y += strength * 0.35;
    this.shakeRoll += (dirX * 0.02 - dirZ * 0.02) * strength;
  }

  get speedBlur() { return this._speedBlur; }
}
