/**
 * Touch controls.
 *
 * A phone is a first-class target here, not an afterthought, so the layout is
 * built around what thumbs can actually reach: a floating stick that spawns
 * wherever the left thumb lands, and a right-hand cluster where FIRE sits under
 * the thumb's resting position because it gets held for charge shots.
 *
 * Everything is DOM. The only per-frame work is `apply()`, which reads cached
 * numbers — no layout reads, no allocation.
 */

import { BTN } from '../sim/input.js';

const STICK_RADIUS = 58;      // px of travel before the stick saturates
const DEAD = 0.16;

/** Which bit each action button drives. */
const BUTTONS = [
  { key: 'fire', bit: BTN.FIRE, label: 'FIRE', kana: 'ショット', cls: 'tb--fire' },
  { key: 'bomb', bit: BTN.BOMB, label: 'BOMB', kana: 'ボム', cls: 'tb--bomb' },
  { key: 'pod', bit: BTN.POD, label: 'POD', kana: 'ポッド', cls: 'tb--pod' },
  { key: 'jump', bit: BTN.JUMP, label: 'JUMP', kana: 'ジャンプ', cls: 'tb--jump' },
  { key: 'dash', bit: BTN.DASH, label: 'DASH', kana: 'ブースト', cls: 'tb--dash' },
];

export class TouchControls {
  constructor(root) {
    this.root = root;
    this._active = false;
    this.visible = true;
    this.layout = 'default';

    this.moveX = 0;
    this.moveZ = 0;
    this.buttons = 0;
    this.lookDX = 0;
    this.lookDY = 0;

    this._stickId = -1;
    this._lookId = -1;
    this._lookX = 0;
    this._lookY = 0;
    this._originX = 0;
    this._originY = 0;
    this._pressed = new Map();     // pointerId -> button key
    this._held = new Set();

    this.el = document.createElement('div');
    this.el.className = 'crv2-ui crv2-touch is-hidden';
    this.el.innerHTML = `
      <div class="tc__zone tc__zone--move"></div>
      <div class="tc__zone tc__zone--look"></div>
      <div class="tc__stick">
        <div class="stick__ring"></div>
        <div class="stick__nub"></div>
      </div>
      <div class="tc__pad">
        ${BUTTONS.map((b) => `
          <button class="tb ${b.cls}" data-k="${b.key}" type="button">
            <span class="tb__ring"></span>
            <span class="tb__l">${b.label}</span>
            <span class="tb__k">${b.kana}</span>
          </button>`).join('')}
      </div>
      <button class="tc__pause" type="button" aria-label="Pause">
        <i></i><i></i>
      </button>
    `;
    root.appendChild(this.el);

    this.stick = this.el.querySelector('.tc__stick');
    this.nub = this.el.querySelector('.stick__nub');
    this.moveZone = this.el.querySelector('.tc__zone--move');
    this.lookZone = this.el.querySelector('.tc__zone--look');
    this.pauseBtn = this.el.querySelector('.tc__pause');
    this.btnEls = new Map();
    for (const b of BUTTONS) {
      this.btnEls.set(b.key, this.el.querySelector(`[data-k="${b.key}"]`));
    }

    this._bind();
  }

  get active() { return this._active; }

  _wake() {
    if (this._active) return;
    this._active = true;
    if (this.visible) this.el.classList.remove('is-hidden');
  }

  _bind() {
    const opts = { passive: false };

    // --- movement stick ---------------------------------------------------
    this.moveZone.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      this._wake();
      this._stickId = e.pointerId;
      this._originX = e.clientX;
      this._originY = e.clientY;
      this.stick.style.setProperty('--x', `${e.clientX}px`);
      this.stick.style.setProperty('--y', `${e.clientY}px`);
      this.stick.classList.add('is-on');
      this.moveZone.setPointerCapture(e.pointerId);
    }, opts);

    this.moveZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._stickId) return;
      e.preventDefault();
      let dx = e.clientX - this._originX;
      let dy = e.clientY - this._originY;
      const m = Math.hypot(dx, dy);
      if (m > STICK_RADIUS) {
        // Drag the origin along so the stick never feels stuck at the rim.
        const k = STICK_RADIUS / m;
        this._originX += dx * (1 - k);
        this._originY += dy * (1 - k);
        dx *= k;
        dy *= k;
        this.stick.style.setProperty('--x', `${this._originX}px`);
        this.stick.style.setProperty('--y', `${this._originY}px`);
      }
      this.nub.style.transform = `translate(${dx}px, ${dy}px)`;

      const nx = dx / STICK_RADIUS;
      const ny = dy / STICK_RADIUS;
      const mag = Math.hypot(nx, ny);
      if (mag < DEAD) {
        this.moveX = 0;
        this.moveZ = 0;
      } else {
        const s = (mag - DEAD) / (1 - DEAD) / mag;
        this.moveX = nx * s;
        this.moveZ = -ny * s;      // screen down is world back
      }
    }, opts);

    const endStick = (e) => {
      if (e.pointerId !== this._stickId) return;
      this._stickId = -1;
      this.moveX = 0;
      this.moveZ = 0;
      this.nub.style.transform = 'translate(0px, 0px)';
      this.stick.classList.remove('is-on');
    };
    this.moveZone.addEventListener('pointerup', endStick);
    this.moveZone.addEventListener('pointercancel', endStick);
    this.moveZone.addEventListener('pointerleave', endStick);

    // --- look drag --------------------------------------------------------
    this.lookZone.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      this._wake();
      this._lookId = e.pointerId;
      this._lookX = e.clientX;
      this._lookY = e.clientY;
      this.lookZone.setPointerCapture(e.pointerId);
    }, opts);

    this.lookZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._lookId) return;
      e.preventDefault();
      this.lookDX += e.clientX - this._lookX;
      this.lookDY += e.clientY - this._lookY;
      this._lookX = e.clientX;
      this._lookY = e.clientY;
    }, opts);

    const endLook = (e) => {
      if (e.pointerId !== this._lookId) return;
      this._lookId = -1;
    };
    this.lookZone.addEventListener('pointerup', endLook);
    this.lookZone.addEventListener('pointercancel', endLook);

    // --- action buttons ---------------------------------------------------
    for (const b of BUTTONS) {
      const el = this.btnEls.get(b.key);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._wake();
        this._pressed.set(e.pointerId, b.key);
        this._held.add(b.key);
        this.buttons |= b.bit;
        el.classList.add('is-down');
        el.setPointerCapture?.(e.pointerId);
      }, opts);

      const up = (e) => {
        if (this._pressed.get(e.pointerId) !== b.key) return;
        this._pressed.delete(e.pointerId);
        this._held.delete(b.key);
        this.buttons &= ~b.bit;
        el.classList.remove('is-down');
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', (e) => {
        // Sliding off a button releases it, which is what players expect.
        if (e.buttons === 0) up(e);
      });
    }

    this.pauseBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    }, opts);

    // Any real keyboard/mouse use hides the touch layer again.
    this._onKey = () => { if (this._active) this.setVisible(false); };
    window.addEventListener('keydown', this._onKey);
  }

  /** Merge the current touch state into an InputFrame-shaped object. */
  apply(out) {
    if (!this._active || !this.visible) return out;
    out.moveX += this.moveX;
    out.moveZ += this.moveZ;
    out.buttons |= this.buttons;
    return out;
  }

  consumeLook() {
    const dx = this.lookDX;
    const dy = this.lookDY;
    this.lookDX = 0;
    this.lookDY = 0;
    return { dx, dy };
  }

  setVisible(v) {
    this.visible = v;
    this.el.classList.toggle('is-hidden', !v || !this._active);
    if (!v) {
      // Never leave a button latched when the layer is pulled away.
      this.buttons = 0;
      this.moveX = 0;
      this.moveZ = 0;
      this._held.clear();
      this._pressed.clear();
      for (const el of this.btnEls.values()) el.classList.remove('is-down');
    }
  }

  setLayout(name) {
    this.layout = name || 'default';
    this.el.classList.remove('lay--default', 'lay--lefty', 'lay--compact');
    this.el.classList.add(`lay--${this.layout}`);
  }

  /** Visual feedback for the charge ring on the FIRE button (0..1). */
  setCharge(t) {
    const el = this.btnEls.get('fire');
    if (!el) return;
    if (this._lastCharge === t) return;
    this._lastCharge = t;
    el.style.setProperty('--c', t.toFixed(3));
    el.classList.toggle('is-ready', t >= 1);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    this.el.remove();
  }
}

export default TouchControls;
