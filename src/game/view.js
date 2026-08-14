/**
 * The bridge between the 60 Hz sim and whatever framerate the display runs at.
 *
 * The sim never knows this file exists. This is where sim state becomes meshes:
 * transforms get interpolated between the previous and current tick, events get
 * handed to VFX/audio/HUD exactly once, and the stage gets told where the
 * action is so it can aim its shadow frustum.
 */

import * as THREE from 'three';
import { Stage } from '../gfx/stage.js';
import { RoboModel } from '../gfx/robot.js';
import { VFX } from '../gfx/vfx.js';
import { sprites } from '../gfx/textures.js';
import { EV } from '../sim/constants.js';
import { PHASE, STATE } from '../sim/world.js';
import { lerp, angleDelta, clamp } from '../core/mathx.js';

export const TEAM_COLORS = [0x35a7ff, 0xff4d5e];

function makeRenderState() {
  return {
    pos: { x: 0, y: 0, z: 0 },
    prevPos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, prevYaw: 0,
    pitch: 0, prevPitch: 0,
    aimYaw: 0, prevAimYaw: 0,
    aimPitch: 0, prevAimPitch: 0,
    state: 0, grounded: true, moveAmt: 0, stepPhase: 0,
    hurtFlash: 0, charge: 0, chargeReady: 0, boostHeat: 0,
    hp: 1000, maxHp: 1000, invuln: 0,
  };
}

export class GameView {
  /**
   * @param renderer THREE.WebGLRenderer
   * @param scene    THREE.Scene
   * @param camera   THREE.PerspectiveCamera
   * @param world    the sim
   * @param settings quality settings
   */
  constructor(renderer, scene, camera, world, settings) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.world = world;
    this.settings = settings;

    this.stage = new Stage(renderer, world.arena, settings);
    scene.add(this.stage.group);
    scene.environment = this.stage.envMap;
    scene.environmentIntensity = this.stage.environmentIntensity ?? 1;
    scene.fog = this.stage.fog;

    this.vfx = new VFX(scene, settings, camera, world.arena.theme);

    this.models = [];
    this.render = [makeRenderState(), makeRenderState()];
    for (let i = 0; i < 2; i++) {
      const m = new RoboModel(world.loadouts[i], TEAM_COLORS[i], settings, this.stage.envMap);
      scene.add(m.group);
      this.models.push(m);
      this._captureRobo(i, true);
    }

    // Contact shadow blobs: shadow maps alone lose the robot against dark
    // geometry, and on LOW tier there are no shadow maps at all.
    const sp = sprites();
    this.blobs = [];
    for (let i = 0; i < 2; i++) {
      const blob = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 1.5),
        new THREE.MeshBasicMaterial({
          map: sp.shadow,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          color: 0x000000,
          toneMapped: false,
          fog: false,
        })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.renderOrder = 3;
      scene.add(blob);
      this.blobs.push(blob);
    }

    /** Consumers registered by the game shell: audio, HUD, camera. */
    this.eventSinks = [];
    this.time = 0;
    this._muzzle = new THREE.Vector3();
    this._focus = { x: 0, y: 0, z: 0 };
    this._camPos = new THREE.Vector3();
  }

  onEvents(fn) {
    this.eventSinks.push(fn);
    return () => {
      const i = this.eventSinks.indexOf(fn);
      if (i >= 0) this.eventSinks.splice(i, 1);
    };
  }

  /** Snapshot the current tick as "previous" — call BEFORE world.step(). */
  beginStep() {
    for (let i = 0; i < 2; i++) {
      const r = this.render[i];
      r.prevPos.x = r.pos.x; r.prevPos.y = r.pos.y; r.prevPos.z = r.pos.z;
      r.prevYaw = r.yaw;
      r.prevPitch = r.pitch;
      r.prevAimYaw = r.aimYaw;
      r.prevAimPitch = r.aimPitch;
    }
  }

  /** Pull the post-step sim state — call AFTER world.step(). */
  endStep() {
    for (let i = 0; i < 2; i++) this._captureRobo(i, false);
    const events = this.world.events;
    if (events.length) {
      this.vfx.handleEvents(events, this.world);
      for (const sink of this.eventSinks) sink(events, this.world);
      this._reactToEvents(events);
    }
  }

  _captureRobo(i, initial) {
    const s = this.world.robos[i];
    const r = this.render[i];
    r.pos.x = s.pos.x; r.pos.y = s.pos.y; r.pos.z = s.pos.z;
    r.vel.x = s.vel.x; r.vel.y = s.vel.y; r.vel.z = s.vel.z;
    r.yaw = s.yaw; r.pitch = s.pitch;
    r.aimYaw = s.aimYaw; r.aimPitch = s.aimPitch;
    r.state = s.state;
    r.grounded = s.grounded;
    r.moveAmt = s.moveAmt;
    r.stepPhase = s.stepPhase;
    r.hurtFlash = s.hurtFlash;
    r.charge = s.charge;
    r.chargeReady = s.chargeReady;
    r.boostHeat = s.boostHeat;
    r.hp = s.hp; r.maxHp = s.maxHp;
    r.invuln = s.invuln;
    if (initial) {
      r.prevPos.x = r.pos.x; r.prevPos.y = r.pos.y; r.prevPos.z = r.pos.z;
      r.prevYaw = r.yaw; r.prevPitch = r.pitch;
      r.prevAimYaw = r.aimYaw; r.prevAimPitch = r.aimPitch;
    }
  }

  _reactToEvents(events) {
    for (const ev of events) {
      switch (ev.type) {
        case EV.FIRE_GUN:
          if (!ev.pod && this.models[ev.id]) {
            this.models[ev.id].onFire(ev.charged ? 'gunCharged' : 'gun');
          }
          break;
        case EV.FIRE_BOMB:
          this.models[ev.id]?.onFire('bomb');
          break;
        case EV.DEPLOY_POD:
          this.models[ev.id]?.onFire('pod');
          break;
      }
    }
  }

  /** Interpolated render transform for `alpha` in [0,1]. */
  _interpolate(alpha) {
    for (let i = 0; i < 2; i++) {
      const r = this.render[i];
      r.rx = lerp(r.prevPos.x, r.pos.x, alpha);
      r.ry = lerp(r.prevPos.y, r.pos.y, alpha);
      r.rz = lerp(r.prevPos.z, r.pos.z, alpha);
      r.ryaw = r.prevYaw + angleDelta(r.prevYaw, r.yaw) * alpha;
      r.rpitch = lerp(r.prevPitch, r.pitch, alpha);
      r.raimYaw = r.prevAimYaw + angleDelta(r.prevAimYaw, r.aimYaw) * alpha;
      r.raimPitch = lerp(r.prevAimPitch, r.aimPitch, alpha);
    }
  }

  /** The interpolated states, in the shape RoboModel.update() expects. */
  get interp() {
    return this._interpView || (this._interpView = [
      this._makeView(0), this._makeView(1),
    ]);
  }

  _makeView(i) {
    const r = this.render[i];
    const view = {
      pos: { x: 0, y: 0, z: 0 },
      vel: r.vel,
      get yaw() { return r.ryaw; },
      get pitch() { return r.rpitch; },
      get aimYaw() { return r.raimYaw; },
      get aimPitch() { return r.raimPitch; },
      get state() { return r.state; },
      get grounded() { return r.grounded; },
      get moveAmt() { return r.moveAmt; },
      get stepPhase() { return r.stepPhase; },
      get hurtFlash() { return r.hurtFlash; },
      get charge() { return r.charge; },
      get chargeReady() { return r.chargeReady; },
      get boostHeat() { return r.boostHeat; },
      get hp() { return r.hp; },
      get maxHp() { return r.maxHp; },
      get invuln() { return r.invuln; },
    };
    view._src = r;
    return view;
  }

  /**
   * Resolve interpolated world positions for this frame.
   *
   * This has to run BEFORE the camera rig, or the camera frames where the
   * robots were on the previous frame. At 60 fps that's an invisible frame of
   * lag; at 5 fps it points the camera at empty floor.
   */
  prepare(alpha) {
    this._interpolate(alpha);
    const views = this.interp;
    for (let i = 0; i < 2; i++) {
      const r = this.render[i];
      views[i].pos.x = r.rx;
      views[i].pos.y = r.ry;
      views[i].pos.z = r.rz;
    }
    return views;
  }

  update(dt, alpha, time) {
    this.time = time;
    const views = this.prepare(alpha);

    for (let i = 0; i < 2; i++) {
      const r = this.render[i];
      const v = views[i];
      this.models[i].update(v, dt, time);

      // Boost plume follows the robot's back, opposite its travel.
      const speed = Math.hypot(r.vel.x, r.vel.z);
      const intensity = clamp(
        (r.state === STATE.DASH ? 1 : 0) + (r.grounded ? 0 : 0.42) + speed * 0.035 + r.boostHeat * 0.5,
        0, 1.6
      );
      if (intensity > 0.05) {
        const bx = -Math.sin(r.ryaw) * 0.22;
        const bz = -Math.cos(r.ryaw) * 0.22;
        this.vfx.thruster(
          i, { x: r.rx + bx, y: r.ry + 0.62, z: r.rz + bz },
          -r.vel.x, -r.vel.y * 0.4 - 1, -r.vel.z,
          intensity, TEAM_COLORS[i]
        );
      }

      // Contact blob: fades and shrinks with height off the deck.
      const blob = this.blobs[i];
      const groundY = this._groundUnder(r.rx, r.rz);
      const h = Math.max(0, r.ry - groundY);
      const k = clamp(1 - h / 6.5, 0, 1);
      blob.position.set(r.rx, groundY + 0.02, r.rz);
      blob.scale.setScalar(0.9 + (1 - k) * 1.5);
      blob.material.opacity = 0.5 * k * k;
      blob.visible = k > 0.02 && r.state !== STATE.DEAD;
    }

    // Shadow frustum + sky follow the action, not the world origin.
    this._focus.x = (views[0].pos.x + views[1].pos.x) * 0.5;
    this._focus.z = (views[0].pos.z + views[1].pos.z) * 0.5;
    this._camPos.copy(this.camera.position);
    this.stage.update(dt, time, {
      cameraPos: this._camPos,
      focus: this._focus,
      pixelRatio: this.renderer.getPixelRatio?.() ?? 1,
    });

    this.vfx.syncProjectiles(this.world, alpha);
    this.vfx.update(dt, time, this.camera);
  }

  _groundUnder(x, z) {
    let best = 0;
    for (const b of this.world.arena.boxes) {
      if (b.top <= best) continue;
      const dx = x - b.x, dz = z - b.z;
      const lx = b.cos * dx - b.sin * dz;
      const lz = b.sin * dx + b.cos * dz;
      if (Math.abs(lx) <= b.hx + 0.4 && Math.abs(lz) <= b.hz + 0.4) best = b.top;
    }
    return best;
  }

  /** Rebuild the robots when a loadout changes between matches. */
  rebuildRobo(i) {
    const old = this.models[i];
    this.scene.remove(old.group);
    old.dispose();
    const m = new RoboModel(this.world.loadouts[i], TEAM_COLORS[i], this.settings, this.stage.envMap);
    this.scene.add(m.group);
    this.models[i] = m;
  }

  muzzleOf(i) {
    return this.models[i].muzzleWorld(this._muzzle);
  }

  setQuality(settings) {
    this.settings = settings;
    this.stage.setQuality(settings);
    this.vfx.setQuality(settings);
    for (const m of this.models) m.setQuality(settings);
  }

  clearTransients() {
    this.vfx.clear();
  }

  dispose() {
    this.scene.remove(this.stage.group);
    this.stage.dispose();
    for (const m of this.models) {
      this.scene.remove(m.group);
      m.dispose();
    }
    for (const b of this.blobs) {
      this.scene.remove(b);
      b.geometry.dispose();
      b.material.dispose();
    }
    this.vfx.dispose();
  }
}
