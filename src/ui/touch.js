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
 *
 * ---------------------------------------------------------------------------
 * Mounting, and the bug that made this whole file dead code
 * ---------------------------------------------------------------------------
 * The layer used to arm itself from a `pointerdown` on its own move/look zones.
 * Those zones live inside a root that starts at `display: none` (`is-hidden`),
 * and a `display: none` subtree is not hit-tested — so the wake listener could
 * never fire, and the controls could never appear on any phone, ever. Verified
 * headless at 390x844: after a real touch, `active` was still false and the
 * computed display was still `none`.
 *
 * Arming is therefore two independent paths that both work while hidden:
 *   1. A capture-phase `touchstart` on `window`, which fires regardless of what
 *      is or is not painted.
 *   2. Media query. On a device whose primary pointer is a finger the controls
 *      come up with the match, before the player has touched anything — you
 *      cannot ask someone to guess that a hidden button is there.
 * A keypress or a real mouse press disarms again, so a desktop that happens to
 * have a touchscreen does not get a thumb cluster over its arena.
 *
 * Visibility is gated on the match being live: the HUD and the menu layer each
 * announce themselves on `window`, and the pad stays down over the title, the
 * garage and the pause menu.
 */

import { BTN } from '../sim/input.js';

const STICK_RADIUS = 58;      // px of travel before the stick saturates
const DEAD = 0.16;

/** True where the primary pointer is a finger — phones and tablets, not a
 *  laptop that merely has a touchscreen bolted on. */
const COARSE = typeof matchMedia === 'function' &&
  matchMedia('(pointer: coarse) and (hover: none)').matches;

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
    this._active = COARSE;
    this.visible = true;
    this.layout = 'default';
    // A match has to be running for the pad to mean anything. Both flags are
    // fed by events the HUD and the menu layer publish on `window`.
    this._hudUp = false;
    this._menuUp = true;

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
      <div class="tc__stick is-idle">
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
    this._sync();
  }

  /** A real keypress or mouse press means this player is not on a phone. */
  _sleep() {
    if (!this._active) return;
    this._active = false;
    this._release();
    this._sync();
  }

  /**
   * One place decides whether the pad is on screen, because four independent
   * conditions have to agree: the device is being driven by a finger, the layer
   * has not been switched off in settings, a match is running, and no menu is
   * covering it. Anything else and a FIRE button ends up floating over the
   * title screen or over the pause menu.
   */
  _sync() {
    const show = this._active && this.visible && this._hudUp && !this._menuUp;
    if (show === this._shown) return;
    this._shown = show;
    this.el.classList.toggle('is-hidden', !show);
    // The HUD is a sibling layer, so it cannot see this class. Publishing it on
    // the root element lets the stylesheet move the weapon readout off the
    // bottom-left, which is exactly where the left thumb lives.
    document.documentElement.classList.toggle('crv2-touch-on', show);
    if (!show) this._release();
  }

  /** Drop every latched input. Called whenever the layer stops being live. */
  _release() {
    this.buttons = 0;
    this.moveX = 0;
    this.moveZ = 0;
    this.lookDX = 0;
    this.lookDY = 0;
    this._stickId = -1;
    this._lookId = -1;
    this._held.clear();
    this._pressed.clear();
    for (const el of this.btnEls.values()) el.classList.remove('is-down');
    this._park();
  }

  /**
   * Send the stick back to its resting mark. Clearing the inline custom
   * properties is what hands it back to the stylesheet — an inline `--x` beats
   * any rule, so the idle rule cannot place the ring until these are gone.
   */
  _park() {
    this.nub.style.transform = 'translate(0px, 0px)';
    this.stick.style.removeProperty('--x');
    this.stick.style.removeProperty('--y');
    this.stick.classList.remove('is-on');
    this.stick.classList.add('is-idle');
  }

  _bind() {
    const opts = { passive: false };

    // --- movement stick ---------------------------------------------------
    this.moveZone.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      if (this._stickId >= 0) return;     // second finger, not a new stick
      e.preventDefault();
      this._wake();
      this._stickId = e.pointerId;
      this.stick.classList.remove('is-idle');
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
      this._park();
    };
    this.moveZone.addEventListener('pointerup', endStick);
    this.moveZone.addEventListener('pointercancel', endStick);
    // No `pointerleave`: the zone captures the pointer, and a drag that crosses
    // into the right-hand half must keep steering rather than dropping the
    // stick out from under a thumb that is still down.
    this.moveZone.addEventListener('lostpointercapture', endStick);

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

    // --- arming -----------------------------------------------------------
    // On `window`, in the capture phase, because everything below it may be
    // `display: none` at the moment the first touch lands — which is precisely
    // the state this listener exists to get us out of.
    this._onTouch = () => this._wake();
    window.addEventListener('touchstart', this._onTouch, { passive: true, capture: true });

    // A keypress or a real mouse press means a desk, not a phone.
    this._onKey = () => this._sleep();
    this._onMouse = (e) => { if (e.pointerType === 'mouse') this._sleep(); };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('pointerdown', this._onMouse, { capture: true });

    // --- match gating -----------------------------------------------------
    this._onHud = (e) => { this._hudUp = !!e.detail?.visible; this._sync(); };
    this._onMenu = (e) => { this._menuUp = !!e.detail?.open; this._sync(); };
    window.addEventListener('crv2:hud', this._onHud);
    window.addEventListener('crv2:menu', this._onMenu);

    this._sync();
  }

  /** Merge the current touch state into an InputFrame-shaped object. */
  apply(out) {
    if (!this._shown) return out;
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
    this.visible = !!v;
    this._sync();
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
    window.removeEventListener('touchstart', this._onTouch, { capture: true });
    window.removeEventListener('pointerdown', this._onMouse, { capture: true });
    window.removeEventListener('crv2:hud', this._onHud);
    window.removeEventListener('crv2:menu', this._onMenu);
    document.documentElement.classList.remove('crv2-touch-on');
    this.el.remove();
  }
}

export default TouchControls;
