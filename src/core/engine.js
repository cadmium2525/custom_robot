/**
 * Renderer, frame loop and the fixed-timestep clock.
 *
 * The sim runs at a hard 60 Hz; rendering runs as fast as the display allows and
 * interpolates between the last two sim states. On a 120 Hz iPad that means
 * smooth motion without doubling the simulation cost, and on a struggling phone
 * the sim stays correct while frames are dropped.
 */

import * as THREE from 'three';
import { TICK_DT, MAX_STEPS_PER_FRAME } from '../sim/constants.js';
import { QualityManager } from './quality.js';
import { PostFX } from '../gfx/postfx.js';
import { ditherTexture } from '../gfx/textures.js';

export class Engine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.quality = new QualityManager(opts.forceTier ?? null);

    const s = this.quality.settings;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // we resolve with FXAA / MSAA on the RT instead
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;   // handled in the composite
    this.renderer.shadowMap.enabled = s.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(56, 1, 0.1, 240);

    /**
     * Menus render their own scene through the same post chain, so the garage
     * preview gets identical bloom and grading to the match. Set these to
     * override what gets drawn; null falls back to scene/camera.
     */
    this.activeScene = null;
    this.activeCamera = null;

    this.postfx = new PostFX(this.renderer, s, ditherTexture(64));

    this.clock = { last: 0, acc: 0, alpha: 0, elapsed: 0, frame: 0 };
    this.running = false;
    this.paused = false;
    this.timeScale = 1;

    this.onFixedStep = null;   // () => void, exactly TICK_DT of sim time
    this.onRender = null;      // (dt, alpha) => void
    this.onResize = null;

    this._raf = null;
    this._boundLoop = (t) => this._loop(t);
    this._resizeObserver = null;

    this.stats = { fps: 60, frameMs: 16.7, simSteps: 0, drawCalls: 0, tris: 0 };
    this._fpsAcc = 0;
    this._fpsFrames = 0;

    this.quality.onChange((settings) => {
      this.renderer.shadowMap.enabled = settings.shadows;
      this.renderer.shadowMap.needsUpdate = true;
      this.postfx.setQuality(settings);
      this.resize(true);
      this.onQualityChange?.(settings);
    });

    this._installResize();
    this.resize(true);

    // Recover gracefully instead of leaving a black canvas.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.stop();
      this.onContextLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.onContextRestored?.();
      this.start();
    });
  }

  _installResize() {
    const handler = () => this.resize();
    window.addEventListener('resize', handler, { passive: true });
    window.addEventListener('orientationchange', handler, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handler, { passive: true });
    }
    this._removeResize = () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('orientationchange', handler);
      window.visualViewport?.removeEventListener('resize', handler);
    };
  }

  resize(force = false) {
    const dpr = this.quality.pixelRatio;
    const scale = this.quality.effectiveScale;
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;

    const w = Math.max(2, Math.floor(cssW * dpr * scale));
    const h = Math.max(2, Math.floor(cssH * dpr * scale));

    if (!force && w === this._lastW && h === this._lastH) return;
    this._lastW = w;
    this._lastH = h;

    this.renderer.setPixelRatio(1);       // we manage the backing store manually
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    this.camera.aspect = cssW / Math.max(1, cssH);
    // Widen the FOV a touch on tall phone screens so the arena still reads.
    this.camera.fov = this.camera.aspect < 1 ? 68 : 56;
    this.camera.updateProjectionMatrix();

    this.postfx.setSize(w, h);
    this.onResize?.(w, h, cssW, cssH);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.last = performance.now();
    this._raf = requestAnimationFrame(this._boundLoop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _loop(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._boundLoop);

    let dt = (now - this.clock.last) / 1000;
    this.clock.last = now;
    // A tab that was backgrounded should resume, not fast-forward.
    if (dt > 0.25) dt = TICK_DT;

    const frameMs = dt * 1000;
    this._fpsAcc += frameMs;
    this._fpsFrames++;
    if (this._fpsAcc > 500) {
      this.stats.fps = Math.round(1000 / (this._fpsAcc / this._fpsFrames));
      this.stats.frameMs = this._fpsAcc / this._fpsFrames;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }

    if (this.quality.sample(frameMs)) this.resize(true);

    if (!this.paused) {
      this.clock.acc += dt * this.timeScale;
      this.clock.elapsed += dt;

      let steps = 0;
      while (this.clock.acc >= TICK_DT && steps < MAX_STEPS_PER_FRAME) {
        this.onFixedStep?.();
        this.clock.acc -= TICK_DT;
        steps++;
      }
      // Falling behind: drop the backlog rather than spiral.
      if (steps >= MAX_STEPS_PER_FRAME) this.clock.acc = 0;
      this.stats.simSteps = steps;
      this.clock.alpha = this.clock.acc / TICK_DT;
    }

    this.renderer.info.reset();
    this.onRender?.(dt, this.clock.alpha, this.clock.elapsed);
    this.postfx.render(
      this.activeScene || this.scene,
      this.activeCamera || this.camera,
      this.clock.elapsed
    );

    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.tris = this.renderer.info.render.triangles;
    this.clock.frame++;
  }

  dispose() {
    this.stop();
    this._removeResize?.();
    this.postfx.dispose();
    this.renderer.dispose();
  }
}
