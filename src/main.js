/**
 * Application shell.
 *
 * Owns the engine, the sim, the presentation layer and the screen flow, and is
 * the only place where those things are allowed to know about each other.
 *
 * Frame contract:
 *   engine.onFixedStep  -> exactly one 60 Hz sim tick (input -> session -> world)
 *   engine.onRender     -> interpolate, animate, drive post-processing and UI
 */

import * as THREE from 'three';
import './ui/ui.css';

import { Engine } from './core/engine.js';
import { InputManager } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { clamp, damp } from './core/mathx.js';

import { World, PHASE, STATE } from './sim/world.js';
import { RoboAI, DIFFICULTY } from './sim/ai.js';
import { makeInput, BTN } from './sim/input.js';
import { getArena, ARENAS } from './sim/arena.js';
import { DEFAULT_LOADOUT, PRESETS, resolveLoadout } from './sim/parts.js';
import { EV, MATCH } from './sim/constants.js';

import { NetSession } from './net/session.js';
import { PeerTransport, makeRoomCode } from './net/peer.js';

import { GameView, TEAM_COLORS } from './game/view.js';
import { DuelCamera } from './game/camera.js';
import { RoboPreview } from './gfx/robot.js';
import { bakeEnvironment } from './gfx/materials.js';

import { HUD } from './ui/hud.js';
import { Menus } from './ui/menus.js';
import { TouchControls } from './ui/touch.js';

const SAVE_KEY = 'crv2-arena-save-v1';

const DEFAULT_SETTINGS = {
  master: 0.85, sfx: 0.9, music: 0.55,
  quality: 'auto', invertY: false, sensitivity: 1,
  shakeAmount: 1, touchLayout: 'default',
};

class Game {
  constructor() {
    this.root = document.getElementById('app');
    this.canvas = document.getElementById('view');

    this.settings = { ...DEFAULT_SETTINGS, ...loadSave().settings };
    this.loadouts = loadSave().loadouts || [{ ...DEFAULT_LOADOUT }, { ...PRESETS[2].loadout }];
    this.arenaId = loadSave().arenaId || 'grid';
    this.difficulty = loadSave().difficulty || 'ace';

    this.engine = new Engine(this.canvas, {
      forceTier: this.settings.quality === 'auto' ? null : Number(this.settings.quality),
    });
    this.scene = this.engine.scene;
    this.camera = this.engine.camera;

    this.input = new InputManager(window, {
      sensitivity: this.settings.sensitivity,
      invertY: this.settings.invertY,
    });
    this.audio = new AudioEngine();

    this.hudLayer = document.getElementById('hud-layer');
    this.uiLayer = document.getElementById('ui-layer');
    this.hud = new HUD(this.hudLayer);
    this.menus = new Menus(this.uiLayer);
    this.touch = new TouchControls(this.hudLayer);
    this.input.touch = this.touch;

    this.world = null;
    this.view = null;
    this.session = null;
    this.ai = null;
    this.rig = null;
    this.transport = null;

    this.localIndex = 0;
    this.mode = 'solo';
    this.state = 'boot';
    this.hitstop = 0;
    this.slowmo = 1;
    this.flash = 0;
    this.flashColor = new THREE.Vector3(1, 0.4, 0.35);
    this.shockTimer = 0;
    this.shockCenter = new THREE.Vector2(0.5, 0.5);
    this.names = ['PLAYER', 'RIVAL'];
    this.showDebug = false;

    this.preview = null;
    this.previewScene = null;
    this.previewCamera = null;
    this.previewSlots = [null, null];

    this._localInput = makeInput();
    this._aiInput = makeInput();
    this._tmpV = new THREE.Vector3();

    this._wire();
  }

  // -------------------------------------------------------------------------

  _wire() {
    this.engine.onFixedStep = () => this._fixedStep();
    this.engine.onRender = (dt, alpha, time) => this._render(dt, alpha, time);
    this.engine.onQualityChange = (settings) => {
      this.view?.setQuality(settings);
      this.preview?.setQuality?.(settings);
    };

    // Audio can only start from a gesture — arm it on the first one we see.
    const unlock = () => {
      this.audio.unlock().then(() => {
        this.audio.setVolume({
          master: this.settings.master, sfx: this.settings.sfx, music: this.settings.music,
        });
        this.audio.setListener(this.camera);
        if (this.state === 'menu') this.audio.startMusic('menu');
      }).catch(() => { /* audio is a nice-to-have, never fatal */ });
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.engine.paused = true;
        this.audio.suspend?.();
      } else {
        this.engine.paused = this.state !== 'match';
        this.audio.resume?.();
      }
    });

    // --- menu events ---
    this.menus.on('start', (d) => this.startMatch(d));
    this.menus.on('loadoutChange', ({ index, loadout }) => {
      this.loadouts[index] = loadout;
      this.preview?.setLoadout(resolveLoadout(loadout));
      persist(this);
    });
    this.menus.on('arenaChange', ({ arenaId }) => {
      this.arenaId = arenaId;
      persist(this);
    });
    this.menus.on('resume', () => this.resume());
    this.menus.on('quit', () => this.endMatch(true));
    this.menus.on('rematch', () => this.startMatch({
      mode: this.mode, difficulty: this.difficulty,
      arenaId: this.arenaId, loadouts: this.loadouts,
    }));
    this.menus.on('settingsChange', (s) => this.applySettings(s));
    this.menus.on('netHost', () => this.hostGame());
    this.menus.on('netJoin', ({ code }) => this.joinGame(code));
    this.menus.on('netCancel', () => this.cancelNet());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.state === 'match') this.pause();
        else if (this.state === 'paused') this.resume();
      }
      if (e.code === 'F3') { this.showDebug = !this.showDebug; e.preventDefault(); }
    });
  }

  // -------------------------------------------------------------------------

  async boot() {
    this.menus.show('boot');
    this.menus.setLoading(0.05, 'INITIALISING');
    await frame();

    // Warm the expensive procedural bakes for the default arena while the
    // loading screen is up, so entering a match is instant.
    this.menus.setLoading(0.3, 'SYNTHESISING TEXTURES');
    await frame();
    this._previewEnv = bakeEnvironment(this.engine.renderer, getArena(this.arenaId).theme, 128);

    this.menus.setLoading(0.65, 'BUILDING HOLOSSEUM');
    await frame();
    this._setupPreview();

    this.menus.setLoading(1, 'READY');
    await frame();
    await wait(220);

    this.state = 'menu';
    this.menus.show('title');
    this.engine.paused = false;
    this.engine.start();

    // Hand off from the static splash only once a real frame has landed.
    await frame();
    const splash = document.getElementById('splash');
    if (splash) {
      splash.classList.add('gone');
      setTimeout(() => splash.remove(), 700);
    }
  }

  _setupPreview() {
    this.previewScene = new THREE.Scene();
    this.previewScene.environment = this._previewEnv;
    this.previewScene.fog = new THREE.FogExp2(0x05070d, 0.11);
    this.previewCamera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
    this.previewCamera.position.set(0, 1.05, 3.6);
    this.previewCamera.lookAt(0, 0.85, 0);

    // Menu backdrop: a dark receding grid so the screen is never an empty void.
    const grid = new THREE.GridHelper(60, 60, 0x1d4a80, 0x11243d);
    grid.position.y = -0.06;
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.material.depthWrite = false;
    this.previewScene.add(grid);
    this.previewGrid = grid;

    const key = new THREE.DirectionalLight(0xfff2e0, 3.4);
    key.position.set(2.4, 4.2, 3.0);
    const rim = new THREE.DirectionalLight(0x59b7ff, 2.6);
    rim.position.set(-3.0, 1.8, -2.4);
    const fill = new THREE.HemisphereLight(0x2a3a58, 0x0a0c12, 0.7);
    this.previewScene.add(key, rim, fill);

    // A dark pedestal grounds the model instead of leaving it floating in void.
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 0.95, 0.09, 48),
      new THREE.MeshStandardMaterial({ color: 0x11151d, roughness: 0.42, metalness: 0.9 })
    );
    pedestal.position.y = -0.045;
    this.previewScene.add(pedestal);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 0.99, 64),
      new THREE.MeshBasicMaterial({ color: 0x59b7ff, transparent: true, opacity: 0.75, side: THREE.DoubleSide, toneMapped: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.005;
    this.previewScene.add(ring);

    this.preview = new RoboPreview(
      resolveLoadout(this.loadouts[0]), TEAM_COLORS[0],
      this.engine.quality.settings, this._previewEnv
    );
    this.previewScene.add(this.preview.group);

    // Hand the garage a placeholder to lay out around; we read its rect each
    // frame and park the 3D model inside it.
    for (let i = 0; i < 1; i++) {
      const slot = document.createElement('div');
      slot.className = 'crv2-preview-slot';
      this.previewSlots[i] = slot;
      this.menus.setPreviewSlot?.(i, slot);
    }
  }

  // -------------------------------------------------------------------------

  startMatch({ mode = 'solo', difficulty, arenaId, loadouts, seed } = {}) {
    this.mode = mode;
    if (difficulty) this.difficulty = difficulty;
    if (arenaId) this.arenaId = arenaId;
    if (loadouts) this.loadouts = loadouts;
    persist(this);

    this.teardownMatch();

    const matchSeed = seed ?? ((Math.random() * 0xffffffff) >>> 0);
    this.world = new World({
      seed: matchSeed,
      arenaId: this.arenaId,
      loadouts: this.loadouts,
    });

    this.view = new GameView(
      this.engine.renderer, this.scene, this.camera, this.world, this.engine.quality.settings
    );
    this.view.onEvents((events, world) => this._onSimEvents(events, world));

    this.rig = new DuelCamera(this.camera, this.world.arena);
    this.rig.shakeAmount = this.settings.shakeAmount;
    this.rig.reset(this.world, this.localIndex);

    if (mode === 'online' && this.transport) {
      this.session = new NetSession({
        world: this.world, transport: this.transport,
        localIndex: this.localIndex, inputDelay: 2,
      });
      this.ai = null;
      this.names = this.localIndex === 0 ? ['YOU', 'CHALLENGER'] : ['CHALLENGER', 'YOU'];
    } else {
      this.session = new NetSession({ world: this.world, transport: null, localIndex: 0 });
      this.localIndex = 0;
      this.ai = new RoboAI(this.world, 1, this.difficulty, matchSeed ^ 0x5eed);
      const d = DIFFICULTY.find((x) => x.id === this.difficulty);
      this.names = ['PLAYER', d ? d.name : 'RIVAL'];
    }

    this.hud.setVisible(true);
    this.menus.hide();
    this.state = 'match';
    this.engine.paused = false;
    this.engine.timeScale = 1;
    this.hitstop = 0;
    this.slowmo = 1;

    this.audio.startMusic(this.arenaId);
    this.hud.showBanner(`ROUND ${this.world.round}`, 'READY', { style: 'fight' });

    // Pointer lock only makes sense on a real mouse.
    if (!this.touch.active && this.input.lastDevice !== 'touch') {
      this.canvas.addEventListener('click', this._lockOnce = () => {
        if (this.state === 'match') this.input.requestPointerLock(this.canvas);
      });
    }
  }

  teardownMatch() {
    if (this._lockOnce) {
      this.canvas.removeEventListener('click', this._lockOnce);
      this._lockOnce = null;
    }
    this.input.exitPointerLock();
    if (this.view) {
      this.view.dispose();
      this.view = null;
    }
    this.scene.environment = null;
    this.scene.fog = null;
    this.world = null;
    this.session = null;
    this.ai = null;
    this.rig = null;
  }

  endMatch(toMenu = false) {
    const world = this.world;
    const result = world ? {
      winner: world.winner,
      wins: [...world.wins],
      rounds: world.round,
      names: this.names,
      localIndex: this.localIndex,
    } : null;

    this.teardownMatch();
    this.hud.setVisible(false);
    this.state = 'menu';
    this.audio.stopMusic(0.6);

    if (toMenu || !result) {
      this.menus.show('title');
      this.audio.startMusic('menu');
    } else {
      this.menus.show('results', result);
      this.audio.startMusic(result.winner === this.localIndex ? 'victory' : 'defeat');
    }
    if (this.mode === 'online') this.cancelNet();
  }

  pause() {
    if (this.state !== 'match') return;
    // Pausing a netplay match would desync both peers — it's a local-only idea.
    if (this.mode === 'online') return;
    this.state = 'paused';
    this.engine.paused = true;
    this.input.exitPointerLock();
    this.menus.show('pause');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'match';
    this.engine.paused = false;
    this.menus.hide();
  }

  applySettings(s) {
    Object.assign(this.settings, s);
    this.audio.setVolume({
      master: this.settings.master, sfx: this.settings.sfx, music: this.settings.music,
    });
    this.input.sensitivity = this.settings.sensitivity;
    this.input.invertY = this.settings.invertY;
    if (this.rig) this.rig.shakeAmount = this.settings.shakeAmount;
    this.touch.setLayout(this.settings.touchLayout);
    if (this.settings.quality === 'auto') {
      this.engine.quality.auto = true;
    } else {
      this.engine.quality.auto = false;
      this.engine.quality.setTier(Number(this.settings.quality));
    }
    persist(this);
  }

  // -------------------------------------------------------------------------
  // Netplay
  // -------------------------------------------------------------------------

  async hostGame() {
    this.cancelNet();
    const t = new PeerTransport();
    this.transport = t;
    this.localIndex = 0;
    try {
      const code = await t.host(makeRoomCode());
      this.menus.setNetState({ status: 'hosting', code, message: 'WAITING FOR CHALLENGER' });
      t.onOpen = () => {
        this.menus.setNetState({ status: 'connected', code, message: 'CHALLENGER CONNECTED' });
        // Host owns the seed so both sides simulate the same match.
        const seed = (Math.random() * 0xffffffff) >>> 0;
        const hello = new TextEncoder().encode(JSON.stringify({
          t: 'setup', seed, arenaId: this.arenaId, loadout: this.loadouts[0],
        }));
        t.send(hello.buffer);
        this._pendingSeed = seed;
        this._awaitGuest = true;
      };
      this._installSetupChannel(t);
    } catch (e) {
      this.menus.setNetState({ status: 'error', message: String(e?.message || e) });
    }
  }

  async joinGame(code) {
    this.cancelNet();
    const t = new PeerTransport();
    this.transport = t;
    this.localIndex = 1;
    this.menus.setNetState({ status: 'joining', code, message: 'DIALLING…' });
    try {
      await t.join(code.trim().toUpperCase());
      this.menus.setNetState({ status: 'connected', code, message: 'LINKED' });
      this._installSetupChannel(t);
      const hello = new TextEncoder().encode(JSON.stringify({
        t: 'ready', loadout: this.loadouts[0],
      }));
      t.send(hello.buffer);
    } catch (e) {
      this.menus.setNetState({ status: 'error', message: String(e?.message || e) });
      this.cancelNet();
    }
  }

  /**
   * Setup messages share the data channel with gameplay. JSON packets always
   * start with '{' (0x7b), a value no NetSession message type uses, so the two
   * protocols can coexist on one unreliable channel.
   *
   * NetSession assigns `transport.onMessage` in its constructor, which would
   * clobber a plain wrapper — so we intercept the assignment instead and keep
   * our dispatcher permanently installed.
   */
  _installSetupChannel(t) {
    let sessionHandler = null;
    const dispatch = (buf) => {
      if (buf.byteLength > 1 && new DataView(buf).getUint8(0) === 0x7b) {
        try {
          this._onSetupMessage(JSON.parse(new TextDecoder().decode(buf)), t);
          return;
        } catch { /* not a setup packet after all — fall through */ }
      }
      sessionHandler?.(buf);
    };
    Object.defineProperty(t, 'onMessage', {
      configurable: true,
      get: () => dispatch,
      set: (fn) => { sessionHandler = fn; },
    });
  }

  _onSetupMessage(msg, t) {
    if (msg.t === 'setup') {
      // Guest: adopt the host's seed/arena and start.
      this.arenaId = msg.arenaId || this.arenaId;
      const loadouts = [msg.loadout || DEFAULT_LOADOUT, this.loadouts[0]];
      this.loadouts = loadouts;
      this.startMatch({ mode: 'online', arenaId: this.arenaId, loadouts, seed: msg.seed });
    } else if (msg.t === 'ready' && this._awaitGuest) {
      this._awaitGuest = false;
      const loadouts = [this.loadouts[0], msg.loadout || DEFAULT_LOADOUT];
      this.loadouts = loadouts;
      this.startMatch({
        mode: 'online', arenaId: this.arenaId, loadouts, seed: this._pendingSeed,
      });
    }
  }

  cancelNet() {
    if (this.transport) {
      try { this.transport.close(); } catch { /* already torn down */ }
      this.transport = null;
    }
    this._awaitGuest = false;
    this.menus.setNetState({ status: 'idle' });
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  _fixedStep() {
    if (this.state !== 'match' || !this.world) return;

    const look = this.input.consumeLook();
    if (look.dx || look.dy) this.rig.look(look.dx, look.dy);

    const local = this.input.sample(this.rig.yaw + this.rig.yawOffset);

    this.view.beginStep();

    if (this.mode === 'online') {
      this.session.advance(local);
    } else {
      const foe = this.ai ? this.ai.update() : this._aiInput;
      if (this.localIndex === 0) this.session.advanceLocal(local, foe);
      else this.session.advanceLocal(foe, local);
    }

    this.view.endStep();

    if (this.world.phase === PHASE.MATCH_END && this.world.phaseTimer <= 0) {
      this.endMatch();
    }
  }

  _onSimEvents(events, world) {
    this.audio.handleEvents(events, world, this.localIndex);

    for (const ev of events) {
      switch (ev.type) {
        case EV.HIT: {
          if (ev.surface) break;
          this.hud.damageNumber(ev, ev.damage, {
            crit: !!ev.charged, heavy: !!ev.heavy, targetIndex: ev.target,
          });
          if (ev.target === this.localIndex) {
            this.flash = Math.min(0.5, 0.16 + ev.damage / 900);
            this.flashColor.set(1, 0.32, 0.3);
            this.rig.impulse(-ev.nx, -ev.nz, 0.09 + ev.damage * 0.0012);
          } else {
            this.hud.hitMarker({ heavy: !!ev.heavy, crit: !!ev.charged });
          }
          // Heavy blows freeze the frame — the single cheapest way to make an
          // impact feel like it landed.
          if (ev.heavy || ev.charged) this.hitstop = Math.max(this.hitstop, ev.heavy ? 0.09 : 0.055);
          break;
        }
        case EV.EXPLODE: {
          this._tmpV.set(ev.x, ev.y, ev.z).project(this.camera);
          if (this._tmpV.z < 1) {
            this.shockCenter.set(this._tmpV.x * 0.5 + 0.5, 1 - (this._tmpV.y * 0.5 + 0.5));
            const d = this.camera.position.distanceTo(this._tmpV.set(ev.x, ev.y, ev.z));
            this.shockTimer = Math.max(this.shockTimer, clamp(1.4 - d * 0.04, 0.25, 1) * (ev.radius / 3.4));
          }
          break;
        }
        case EV.ROUND_START:
          if (ev.go) {
            this.hud.showBanner('FIGHT', '', { style: 'fight' });
            setTimeout(() => this.hud.hideBanner(), 900);
          } else {
            this.hud.showBanner(`ROUND ${ev.round}`, 'READY', { style: 'fight' });
          }
          break;
        case EV.ROUND_END: {
          const win = ev.winner === this.localIndex;
          this.hud.showBanner(
            ev.timeout ? 'TIME UP' : 'K.O.',
            ev.winner < 0 ? 'DRAW' : (win ? 'ROUND WON' : 'ROUND LOST'),
            { style: ev.timeout ? 'timeup' : (ev.winner < 0 ? 'draw' : (win ? 'win' : 'lose')) }
          );
          this.slowmo = 0.28;
          this.flash = 0.55;
          this.flashColor.set(1, 0.95, 0.9);
          break;
        }
        case EV.MATCH_END:
          this.hud.showBanner(
            ev.winner === this.localIndex ? 'VICTORY' : 'DEFEAT', '',
            { style: ev.winner === this.localIndex ? 'win' : 'lose' }
          );
          break;
      }
    }
  }

  _render(dt, alpha, time) {
    // --- hitstop / slow motion ------------------------------------------
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      this.engine.timeScale = 0.06;
    } else {
      this.slowmo = damp(this.slowmo, 1, 1.6, dt);
      this.engine.timeScale = this.slowmo;
    }

    const u = this.engine.postfx.uniforms;

    // A paused match keeps rendering the frozen arena behind the menu.
    if (this.state === 'menu' || this.state === 'boot') {
      this._renderPreview(dt, time);
      u.radialBlur.value = 0;
      u.hitFlash.value = 0;
      u.shockwave.value = 0;
      u.exposure.value = 1.0;
      u.vignette.value = 0.42;
      u.saturation.value = 1.08;
      return;
    }

    // Back to the arena scene.
    this.engine.activeScene = null;
    this.engine.activeCamera = null;

    if (!this.world || !this.view) return;

    const views = this.view.interp;
    this.rig.update(this.world, views, this.localIndex, dt, time);
    this.view.update(dt, alpha, time);

    // VFX-authored camera shake.
    const shake = this.view.vfx.consumeShake();
    if (shake) this.rig.addShake(shake.x, shake.y, shake.z, shake.roll);

    this.audio.setListener(this.camera);
    const me = this.world.robos[this.localIndex];
    const foe = this.world.robos[1 - this.localIndex];
    const tension = clamp(
      1 - Math.min(me.hp / me.maxHp, foe.hp / foe.maxHp), 0, 1
    ) * (this.world.phase === PHASE.FIGHT ? 1 : 0.4);
    this.audio.update(dt, this.world, {
      tension, phase: this.world.phase, localIndex: this.localIndex, timeScale: this.engine.timeScale,
    });

    // --- post-processing reactions --------------------------------------
    this.flash = Math.max(0, this.flash - dt * 3.2);
    u.hitFlash.value = this.flash * 0.55;
    u.hitFlashColor.value.copy(this.flashColor);
    u.radialBlur.value = this.rig.speedBlur;
    u.radialCenter.value.set(0.5, 0.5);

    if (this.shockTimer > 0) {
      this.shockTimer = Math.max(0, this.shockTimer - dt * 1.9);
      const t = 1 - this.shockTimer;
      u.shockwave.value = this.shockTimer * 0.022;
      u.shockRadius.value = t * 0.9;
      u.shockCenter.value.copy(this.shockCenter);
    } else {
      u.shockwave.value = 0;
    }

    // Low HP darkens and desaturates the frame — legible without a HUD glance.
    const hpFrac = me.hp / me.maxHp;
    u.exposure.value = damp(u.exposure.value, hpFrac < 0.25 ? 0.94 : 1.02, 2, dt);
    u.saturation.value = damp(u.saturation.value, hpFrac < 0.25 ? 0.86 : 1.08, 2, dt);
    u.vignette.value = damp(u.vignette.value, hpFrac < 0.25 ? 0.58 : 0.34, 2, dt);

    // --- UI --------------------------------------------------------------
    this.hud.update(this.world, {
      camera: this.camera, alpha, names: this.names,
      localIndex: this.localIndex, time,
    });
    if (this.mode === 'online' && this.session) this.hud.setNetStats(this.session.stats);

    if (this.showDebug) {
      const s = this.engine.stats;
      this.hud.setDebug(
        `${s.fps}fps ${s.frameMs.toFixed(1)}ms | ${this.engine.quality.settings.name} ` +
        `x${this.engine.quality.effectiveScale.toFixed(2)} | ${s.drawCalls}dc ${(s.tris / 1000).toFixed(0)}kt`
      );
    } else {
      this.hud.setDebug(null);
    }
  }

  _renderPreview(dt, time) {
    if (!this.preview || !this.previewScene) return;

    const screen = this.menus.current;
    const inGarage = screen === 'garage';
    // The hero model is the backdrop on the title and the subject in the
    // garage; everywhere else it would just fight the menu for attention.
    this.preview.group.visible = inGarage || screen === 'title' || screen === 'mode';

    if (inGarage) {
      const slot = this.previewSlots[0];
      const r = slot?.isConnected ? slot.getBoundingClientRect() : null;
      if (r && r.width > 0) {
        // Map the slot's centre into a world offset so the model lands inside
        // whatever hole the garage layout left for it.
        const cx = (r.left + r.width / 2) / window.innerWidth * 2 - 1;
        const cy = -((r.top + r.height / 2) / window.innerHeight * 2 - 1);
        this.preview.group.position.set(cx * 1.7, -0.42 + cy * 1.0, 0);
      } else {
        this.preview.group.position.set(0.55, -0.42, 0);
      }
    } else {
      this.preview.group.position.set(0, -0.4, 0);
    }

    this.preview.update(dt, time);
    if (this.previewGrid) this.previewGrid.position.y = -0.06 + this.preview.group.position.y + 0.4;

    this.previewCamera.aspect = this.camera.aspect;
    this.previewCamera.fov = this.camera.aspect < 1 ? 44 : 34;
    this.previewCamera.updateProjectionMatrix();

    // Render the menu through the same post chain so the garage gets identical
    // bloom and grading to the match.
    this.engine.activeScene = this.previewScene;
    this.engine.activeCamera = this.previewCamera;
  }
}

// ---------------------------------------------------------------------------

function frame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadSave() {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY)) || {};
  } catch {
    return {};
  }
}

function persist(game) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      settings: game.settings,
      loadouts: game.loadouts,
      arenaId: game.arenaId,
      difficulty: game.difficulty,
    }));
  } catch { /* private mode / quota — not worth surfacing */ }
}

// ---------------------------------------------------------------------------

const game = new Game();
window.__game = game;   // handy for the screenshot tool and for debugging
game.boot();
