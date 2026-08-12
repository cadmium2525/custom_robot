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
const _up = new THREE.Vector3(0, 1, 0);

export class DuelCamera {
  constructor(camera, arena) {
    this.camera = camera;
    this.arena = arena;

    this.yaw = 0;
    this.yawOffset = 0;       // player look nudge, decays back to 0
    this.pitch = 0.20;
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

    this._prevLocalPos = new THREE.Vector3();
    this._speedBlur = 0;
  }

  reset(world, localIndex) {
    this.introT = 0;
    this.mode = 'intro';
    const r = world.robos[localIndex];
    const o = world.robos[1 - localIndex];
    this.yaw = Math.atan2(r.pos.x - o.pos.x, r.pos.z - o.pos.z);
    this.yawOffset = 0;
  }

  /** Player look nudge from mouse / stick / touch drag. */
  look(dx, dy) {
    this.yawOffset = clamp(this.yawOffset + dx * 1.35, -1.15, 1.15);
    this.pitch = clamp(this.pitch + dy * 0.9, -0.28, 0.72);
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

    // Focus sits between the two, biased toward the local player so their own
    // robo never drifts to the edge of a phone screen.
    _mid.copy(_a).lerp(_b, 0.42);

    if (world.phase === PHASE.INTRO) {
      this._updateIntro(world, _mid, separation, dt, time);
    } else {
      this.mode = 'duel';
      // Look down the axis between the fighters, from behind the local robo.
      const axisYaw = Math.atan2(_a.x - _b.x, _a.z - _b.z);
      // Approach rather than snap, so a fast strafe swings the camera smoothly.
      this.yaw = approachAngle(this.yaw, axisYaw, Math.min(1, dt * 3.4) * Math.abs(angleDelta(this.yaw, axisYaw)) + dt * 0.6);

      // Frame both: more separation -> further back and slightly higher.
      const wantDist = clamp(7.6 + separation * 0.52, 8.5, 21);
      const wantHeight = clamp(2.3 + separation * 0.12 + Math.max(_a.y, _b.y) * 0.42, 2.3, 8.5);
      this.distance = damp(this.distance, wantDist, 3.2, dt);
      this.height = damp(this.height, wantHeight, 3.6, dt);
    }

    const yaw = this.yaw + this.yawOffset;
    // Player nudge decays so the rig always returns to the readable framing.
    this.yawOffset = damp(this.yawOffset, 0, 0.9, dt);
    this.pitch = damp(this.pitch, 0.20, 0.7, dt);

    const cp = Math.cos(this.pitch);
    _desired.set(
      _mid.x + Math.sin(yaw) * this.distance * cp,
      _mid.y + this.height + Math.sin(this.pitch) * this.distance,
      _mid.z + Math.cos(yaw) * this.distance * cp
    );

    // Keep the camera inside the arena shell and above the floor.
    const bd = this.arena.bounds;
    _desired.x = clamp(_desired.x, -bd.hx + 1.2, bd.hx - 1.2);
    _desired.z = clamp(_desired.z, -bd.hz + 1.2, bd.hz - 1.2);
    _desired.y = clamp(_desired.y, 1.4, bd.ceil - 0.8);

    _look.copy(_mid);
    _look.y += 1.15 + Math.min(2.2, separation * 0.045);

    const posLambda = this.mode === 'intro' ? 6.5 : 7.5;
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
  }

  _updateIntro(world, mid, separation, dt, time) {
    this.mode = 'intro';
    this.introT += dt;
    const total = 2.5;
    const t = clamp(this.introT / total, 0, 1);
    // Sweeping orbit that settles into the duel framing.
    const ease = 1 - Math.pow(1 - t, 3);
    this.yaw = this.yaw + dt * 0.9 * (1 - ease);
    this.distance = lerp(24, clamp(7.6 + separation * 0.52, 8.5, 21), ease);
    this.height = lerp(9.5, clamp(2.3 + separation * 0.12, 2.3, 8.5), ease);
    this.pitch = lerp(0.52, 0.2, ease);
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
