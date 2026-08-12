/**
 * Device input -> InputFrame.
 *
 * Keyboard, gamepad and touch all collapse into the same 8-byte frame the sim
 * and the netcode consume. Nothing downstream knows or cares which device the
 * player used, which is also why an AI and a remote peer slot in cleanly.
 */

import { BTN, makeInput, quantizeInput } from '../sim/input.js';
import { clamp } from './mathx.js';

const KEY_BINDS = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyJ: 'fire', KeyK: 'bomb', KeyL: 'pod',
  KeyE: 'bomb', KeyQ: 'pod',
  KeyF: 'lock',
};

const DEADZONE = 0.22;

function applyDeadzone(x, y) {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return [0, 0];
  // Rescale so the stick still reaches 1.0 at the rim.
  const s = (m - DEADZONE) / (1 - DEADZONE) / m;
  return [x * s, y * s];
}

export class InputManager {
  constructor(target = window, opts = {}) {
    this.target = target;
    this.keys = new Set();
    this.frame = makeInput();
    this.mouse = { down: 0, dx: 0, dy: 0, locked: false };
    this.sensitivity = opts.sensitivity ?? 1;
    this.invertY = !!opts.invertY;
    this.touch = null;            // set by the integrator to a TouchControls instance
    this.enabled = true;
    this.lastDevice = 'keyboard';
    this.gamepadIndex = -1;
    this.lookDX = 0;
    this.lookDY = 0;
    /** Set true while a menu owns the input so gameplay doesn't react. */
    this.suppressed = false;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const b = KEY_BINDS[e.code];
      if (b) {
        this.keys.add(b);
        this.lastDevice = 'keyboard';
        // Don't let space/arrows scroll the page behind the canvas.
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      }
    };
    this._onKeyUp = (e) => {
      const b = KEY_BINDS[e.code];
      if (b) this.keys.delete(b);
    };
    this._onBlur = () => this.keys.clear();

    this._onMouseDown = (e) => {
      if (this.suppressed) return;
      this.lastDevice = 'mouse';
      if (e.button === 0) this.mouse.down |= 1;
      if (e.button === 2) this.mouse.down |= 2;
      if (e.button === 1) this.mouse.down |= 4;
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.mouse.down &= ~1;
      if (e.button === 2) this.mouse.down &= ~2;
      if (e.button === 1) this.mouse.down &= ~4;
    };
    this._onMouseMove = (e) => {
      if (this.mouse.locked) {
        this.lookDX += e.movementX * 0.0022 * this.sensitivity;
        this.lookDY += e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
      } else if (this.mouse.down & 1) {
        this.lookDX += e.movementX * 0.0018 * this.sensitivity;
        this.lookDY += e.movementY * 0.0018 * this.sensitivity * (this.invertY ? -1 : 1);
      }
    };
    this._onContext = (e) => { if (!this.suppressed) e.preventDefault(); };
    this._onPointerLockChange = () => {
      this.mouse.locked = document.pointerLockElement === this.lockElement;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);

    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.lastDevice = 'gamepad';
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = -1;
    });

    this._prevGamepadButtons = new Uint8Array(20);
  }

  requestPointerLock(el) {
    this.lockElement = el;
    el.requestPointerLock?.();
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  /** Consume accumulated look delta (mouse / right stick / touch drag). */
  consumeLook() {
    let dx = this.lookDX;
    let dy = this.lookDY;
    this.lookDX = 0;
    this.lookDY = 0;
    if (this.touch?.active) {
      const t = this.touch.consumeLook();
      dx += t.dx * 0.004 * this.sensitivity;
      dy += t.dy * 0.004 * this.sensitivity * (this.invertY ? -1 : 1);
    }
    return { dx, dy };
  }

  _pollGamepad(out) {
    if (this.gamepadIndex < 0 || !navigator.getGamepads) return false;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return false;

    const [lx, ly] = applyDeadzone(gp.axes[0] || 0, gp.axes[1] || 0);
    const [rx, ry] = applyDeadzone(gp.axes[2] || 0, gp.axes[3] || 0);

    let used = Math.abs(lx) + Math.abs(ly) + Math.abs(rx) + Math.abs(ry) > 0.05;

    out.moveX += lx;
    out.moveZ += -ly;
    this.lookDX += rx * 0.05 * this.sensitivity;
    this.lookDY += ry * 0.05 * this.sensitivity * (this.invertY ? -1 : 1);

    const b = gp.buttons;
    const pressed = (i) => b[i] && (b[i].pressed || b[i].value > 0.4);
    // Standard mapping: A=0 jump, B=1 dash, X=2 bomb, Y=3 pod, RT=7 fire, LT=6 pod
    if (pressed(0)) { out.buttons |= BTN.JUMP; used = true; }
    if (pressed(1) || pressed(5)) { out.buttons |= BTN.DASH; used = true; }
    if (pressed(2) || pressed(6)) { out.buttons |= BTN.BOMB; used = true; }
    if (pressed(3) || pressed(4)) { out.buttons |= BTN.POD; used = true; }
    if (pressed(7)) { out.buttons |= BTN.FIRE; used = true; }
    if (pressed(10)) { out.buttons |= BTN.LOCK; used = true; }
    // D-pad also drives movement, for players who prefer it.
    if (pressed(12)) { out.moveZ += 1; used = true; }
    if (pressed(13)) { out.moveZ -= 1; used = true; }
    if (pressed(14)) { out.moveX -= 1; used = true; }
    if (pressed(15)) { out.moveX += 1; used = true; }

    if (used) this.lastDevice = 'gamepad';
    return used;
  }

  /**
   * Build this frame's input.
   * @param cameraYaw the yaw the player's movement should be relative to
   */
  sample(cameraYaw) {
    const f = this.frame;
    f.moveX = 0;
    f.moveZ = 0;
    f.buttons = 0;
    f.yaw = cameraYaw;
    f.pitch = 0;

    if (!this.enabled || this.suppressed) return quantizeInput(f);

    const k = this.keys;
    if (k.has('left')) f.moveX -= 1;
    if (k.has('right')) f.moveX += 1;
    if (k.has('up')) f.moveZ += 1;
    if (k.has('down')) f.moveZ -= 1;
    if (k.has('jump')) f.buttons |= BTN.JUMP;
    if (k.has('dash')) f.buttons |= BTN.DASH;
    if (k.has('fire')) f.buttons |= BTN.FIRE;
    if (k.has('bomb')) f.buttons |= BTN.BOMB;
    if (k.has('pod')) f.buttons |= BTN.POD;
    if (k.has('lock')) f.buttons |= BTN.LOCK;

    if (this.mouse.down & 1) f.buttons |= BTN.FIRE;
    if (this.mouse.down & 2) f.buttons |= BTN.BOMB;
    if (this.mouse.down & 4) f.buttons |= BTN.POD;

    this._pollGamepad(f);

    if (this.touch?.active) {
      this.touch.apply(f);
      this.lastDevice = 'touch';
    }

    // Normalise the stick so diagonals aren't faster than cardinals.
    const m = Math.hypot(f.moveX, f.moveZ);
    if (m > 1) { f.moveX /= m; f.moveZ /= m; }

    return quantizeInput(f);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('contextmenu', this._onContext);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
  }
}
