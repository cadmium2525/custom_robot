/**
 * Front-end shell: boot, title, mode, garage, arena, netplay, pause, results,
 * settings, controls.
 *
 * Design notes that shape the code:
 *
 *  - Screens are built lazily and then kept. Building is the only place
 *    `innerHTML` is allowed; after that a screen is driven by class toggles and
 *    `textContent`, so re-entering the garage never re-parses 60 part rows or
 *    loses your scroll position.
 *  - Every interactive element is a real `<button>` carrying `data-nav`. That
 *    gives us click, touch and Enter/Space activation for free from the
 *    browser, and lets keyboard/gamepad navigation be pure *spatial* focus
 *    movement (nearest item along the pressed axis) instead of a hand-authored
 *    graph per screen. The integrator forwards d-pad input as synthetic
 *    keydown events, so keyboard handling covers pads too.
 *  - Sliders/選択 controls are custom buttons rather than <input>, because
 *    native widgets fight the arrow-key navigation model and can't be styled to
 *    match the rest of the league aesthetic.
 */

import { CATEGORIES, PRESETS, DEFAULT_LOADOUT } from '../sim/parts.js';
import { ARENAS } from '../sim/arena.js';
import { DIFFICULTY } from '../sim/ai.js';

// ---------------------------------------------------------------------------
// Stat comparison tables
//
// `norm` drives the bar (always "fuller is stronger"), `raw` + `fmt` drive the
// numeric delta, and `better` says which direction of the raw number is good —
// cooldowns and fuses are better when small.
// ---------------------------------------------------------------------------

const pct = (v) => `${Math.round(v * 100)}%`;
const secs = (t) => `${(t / 60).toFixed(2)}s`;
const one = (v) => v.toFixed(1);
const two = (v) => v.toFixed(2);
const int = (v) => String(Math.round(v));

const STATS = {
  body: [
    { en: 'ARMOUR', kana: '装甲', raw: (p) => p.hp, norm: (p) => p.hp / 1250, fmt: int, better: 'hi' },
    { en: 'SPEED', kana: '機動', raw: (p) => p.moveSpeed, norm: (p) => p.moveSpeed / 10.5, fmt: one, better: 'hi' },
    { en: 'AIR CONTROL', kana: '空中', raw: (p) => p.airControl, norm: (p) => p.airControl / 0.9, fmt: two, better: 'hi' },
    { en: 'MASS', kana: '重量', raw: (p) => p.weight, norm: (p) => p.weight / 1.45, fmt: two, better: 'hi' },
    { en: 'POISE', kana: '耐衝', raw: (p) => p.knockbackTaken, norm: (p) => 1 - (p.knockbackTaken - 0.6) / 0.9, fmt: two, better: 'lo' },
  ],
  gun: [
    { en: 'DAMAGE', kana: '威力', raw: (p) => p.damage * (p.burst || 1), norm: (p) => (p.damage * (p.burst || 1)) / 95, fmt: int, better: 'hi' },
    { en: 'RATE', kana: '連射', raw: (p) => 60 / p.fireInterval, norm: (p) => (60 / p.fireInterval) / 10, fmt: one, better: 'hi' },
    { en: 'MUZZLE', kana: '弾速', raw: (p) => p.speed, norm: (p) => p.speed / 80, fmt: int, better: 'hi' },
    { en: 'ACCURACY', kana: '精度', raw: (p) => p.spread, norm: (p) => 1 - p.spread / 0.09, fmt: (v) => v.toFixed(3), better: 'lo' },
    { en: 'HOMING', kana: '追尾', raw: (p) => p.homing, norm: (p) => p.homing / 4, fmt: one, better: 'hi' },
    { en: 'CHARGE', kana: '溜め', raw: (p) => p.chargeMul, norm: (p) => (p.chargeMul - 1.6) / 1.1, fmt: two, better: 'hi' },
  ],
  bomb: [
    { en: 'DAMAGE', kana: '威力', raw: (p) => p.damage, norm: (p) => p.damage / 145, fmt: int, better: 'hi' },
    { en: 'BLAST', kana: '範囲', raw: (p) => p.radius, norm: (p) => p.radius / 6, fmt: one, better: 'hi' },
    { en: 'FUSE', kana: '起爆', raw: (p) => p.fuse, norm: (p) => 1 - p.fuse / 110, fmt: secs, better: 'lo' },
    { en: 'CYCLE', kana: '再装填', raw: (p) => p.cooldown, norm: (p) => 1 - p.cooldown / 115, fmt: secs, better: 'lo' },
    { en: 'IMPACT', kana: '衝撃', raw: (p) => p.knockback, norm: (p) => p.knockback / 13, fmt: one, better: 'hi' },
  ],
  pod: [
    { en: 'DAMAGE', kana: '威力', raw: (p) => p.damage, norm: (p) => p.damage / 100, fmt: int, better: 'hi' },
    { en: 'BLAST', kana: '範囲', raw: (p) => p.radius, norm: (p) => p.radius / 4, fmt: one, better: 'hi' },
    { en: 'SPEED', kana: '速度', raw: (p) => p.speed, norm: (p) => p.speed / 13, fmt: one, better: 'hi' },
    { en: 'ENDURANCE', kana: '稼働', raw: (p) => p.life, norm: (p) => p.life / 340, fmt: secs, better: 'hi' },
    { en: 'CYCLE', kana: '再装填', raw: (p) => p.cooldown, norm: (p) => 1 - (p.cooldown - 140) / 60, fmt: secs, better: 'lo' },
  ],
  legs: [
    { en: 'JUMPS', kana: '跳躍', raw: (p) => p.jumps, norm: (p) => p.jumps / 3, fmt: int, better: 'hi' },
    { en: 'AIR DASH', kana: '空中D', raw: (p) => p.airDashes, norm: (p) => p.airDashes / 3, fmt: int, better: 'hi' },
    { en: 'BOOST', kana: '加速', raw: (p) => p.dashSpeed, norm: (p) => (p.dashSpeed - 14) / 6, fmt: one, better: 'hi' },
    { en: 'CYCLE', kana: '冷却', raw: (p) => p.dashCooldown, norm: (p) => 1 - (p.dashCooldown - 12) / 18, fmt: secs, better: 'lo' },
    { en: 'LIFT', kana: '揚力', raw: (p) => p.jumpSpeed, norm: (p) => (p.jumpSpeed - 8.5) / 3.2, fmt: one, better: 'hi' },
    { en: 'GRAVITY', kana: '重力', raw: (p) => p.gravityMul, norm: (p) => 1 - (p.gravityMul - 0.6) / 0.7, fmt: two, better: 'lo' },
  ],
};

/** Most rows any category needs — the compare panel is built once at this size. */
const MAX_STAT_ROWS = 6;

const MODES = [
  { id: 'solo', en: 'SOLO LADDER', kana: 'ソロ', blurb: 'Climb the commander ladder against the league AI.' },
  { id: 'versus', en: 'LOCAL VERSUS', kana: 'ローカル対戦', blurb: 'Two builds, one screen, one pad each.' },
  { id: 'training', en: 'TRAINING', kana: 'トレーニング', blurb: 'Free practice. Infinite time, no stakes.' },
  { id: 'online', en: 'ONLINE MATCH', kana: 'オンライン', blurb: 'Rollback netcode. Room code, five characters, go.' },
];

const QUALITY = ['auto', 'low', 'mid', 'high', 'ultra'];
const TOUCH_LAYOUTS = ['default', 'lefty', 'compact'];

const DEFAULT_SETTINGS = {
  master: 0.8, sfx: 0.9, music: 0.55,
  quality: 'auto', invertY: false, sensitivity: 1,
  shakeAmount: 1, touchLayout: 'default',
};

/** Sliders: [min, max, step, formatter]. */
const SLIDERS = {
  master: [0, 1, 0.05, pct],
  sfx: [0, 1, 0.05, pct],
  music: [0, 1, 0.05, pct],
  sensitivity: [0.3, 2.5, 0.05, (v) => `${v.toFixed(2)}x`],
  shakeAmount: [0, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`],
};

const CONTROL_ROWS = [
  ['MOVE', '移動', 'W A S D', 'L-STICK', 'L-STICK (float)'],
  ['AIM / CAMERA', '照準', 'MOUSE', 'R-STICK', 'DRAG (right)'],
  ['FIRE / CHARGE', '射撃・溜め', 'LMB / J', 'RT', 'FIRE (hold)'],
  ['BOMB', 'ボム', 'RMB / K', 'LT', 'BOMB'],
  ['POD', 'ポッド', 'Q / L', 'LB', 'POD'],
  ['JUMP', 'ジャンプ', 'SPACE', 'A / ✕', 'JUMP'],
  ['DASH', 'ダッシュ', 'SHIFT', 'B / ○', 'DASH'],
  ['LOCK', 'ロック', 'F', 'RB', 'LOCK'],
  ['PAUSE', 'ポーズ', 'ESC', 'START', 'PAUSE'],
];

/**
 * Fallback back-targets, for a screen reached by a route nobody recorded.
 *
 * The garage is reachable from four places — the title's item 02, the mode
 * step, a connected netplay lobby and the results screen — and this table only
 * knows one of them, so BACK out of the garage always landed on the BATTLE
 * MODE step. Enter from the title and one press of BACK dropped you two
 * screens deep into a flow you had not started. `_from` records the actual
 * route and this stays as the fallback.
 */
const BACK_TO = { mode: 'title', garage: 'mode', arena: 'garage' };

const STORE_KEY = 'crv2.settings.v1';

// ---------------------------------------------------------------------------
// DOM helpers (build-time only)
// ---------------------------------------------------------------------------

function h(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

/** English label with the kana beneath it — the house lockup. */
const bi = (en, kana) => `<b>${en}</b><i>${kana}</i>`;

/**
 * The house mark: an arena hexagon with a machine's visor inside it. Drawn
 * inline because the whole product ships with no external assets — and because
 * a generic gradient hexagon carried none of this game's identity.
 */
const MARK = `<svg class="mark__svg" viewBox="0 0 52 56" aria-hidden="true" focusable="false">
  <path class="mk__hex" d="M26 2 48 14.5v27L26 54 4 41.5v-27z"/>
  <path class="mk__inner" d="M26 11 40 19v18l-14 8-14-8V19z"/>
  <rect class="mk__crest" x="24" y="14" width="4" height="7"/>
  <rect class="mk__visor" x="17" y="25" width="18" height="6"/>
</svg>`;

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function stepHeader(n, en, kana) {
  return `<header class="step">
    <span class="step__n">${n}</span>
    <span class="step__t">${bi(en, kana)}</span>
    <span class="step__rule"></span>
  </header>`;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* private mode / disabled storage — defaults are fine */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------

export class Menus {
  constructor(root) {
    this.root = root;

    const el = h('div', 'crv2-ui crv2-menus is-hidden');
    el.innerHTML = '<div class="menus__bg"></div><div class="menus__grain"></div>';
    root.appendChild(el);
    this.el = el;

    this.screens = new Map();
    this._cur = null;
    this._returnTo = 'title';
    /** screen id -> the screen it was actually entered from. See BACK_TO. */
    this._from = new Map();
    this._events = new Map();
    this._previewSlots = [null, null];

    this.settings = loadSettings();
    this.netState = { status: 'idle', code: '', message: '', pingMs: 0 };

    /** Everything the 'start' event needs, mutated as the player walks the flow. */
    this.sel = {
      mode: 'solo',
      difficulty: DIFFICULTY[2].id,
      arenaId: ARENAS[0].id,
      loadouts: [{ ...DEFAULT_LOADOUT }, { ...PRESETS[1].loadout }],
    };

    this._onKeyDown = (e) => this._handleKey(e);
    this._keysOn = false;

    // Pointer hover moves focus so the animated selection cursor tracks the
    // mouse — but touch must not, or the cursor jumps on every tap-scroll.
    this._onPointerOver = (e) => {
      if (e.pointerType === 'touch') return;
      const t = e.target.closest?.('[data-nav]');
      if (t && !t.disabled && this.el.contains(t)) this._focus(t, false);
    };
    this.el.addEventListener('pointerover', this._onPointerOver);
  }

  // -------------------------------------------------------------------------
  // Event bus
  // -------------------------------------------------------------------------

  on(event, cb) {
    let list = this._events.get(event);
    if (!list) this._events.set(event, (list = []));
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  _emit(event, payload) {
    const list = this._events.get(event);
    if (!list) return;
    for (const cb of list.slice()) cb(payload);
  }

  // -------------------------------------------------------------------------
  // Screen lifecycle
  // -------------------------------------------------------------------------

  get current() { return this._cur; }

  show(screen, data) {
    const s = this._ensure(screen);
    if (!s) return;

    if (this._cur && this._cur !== screen) {
      const prev = this.screens.get(this._cur);
      prev?.el.classList.remove('is-on');
      prev?.onHide?.();
    }

    this.el.classList.remove('is-hidden');
    this.el.dataset.screen = screen;
    this._cur = screen;
    s.el.classList.add('is-on');
    // Screens are kept in the DOM, and a scroll container keeps its offset.
    // Without this, leaving CONTROLS half-read and coming back reopened it
    // half-read — a screen that has been shown, not resumed.
    s.el.scrollTop = 0;
    s.onShow?.(data || {});

    if (!this._keysOn) {
      window.addEventListener('keydown', this._onKeyDown, true);
      this._keysOn = true;
    }

    this._announce(true);

    // Focus after the screen is painted so scroll containers are laid out.
    //
    // Focus WITHOUT scrolling. A screen mounts at scroll offset 0 and that is
    // where its reading starts — the step header, then the thing the screen is
    // about. But several screens put `data-default` on the BACK button in the
    // footer, so scrolling the default item into view scrolled to the END:
    // opening CONTROLS on a 390x844 phone landed 169px down its own table,
    // with the title and the first four rows already above the fold, before
    // the player had touched anything. Every later `_focus` still scrolls,
    // which is what the arrow keys and the pad need.
    requestAnimationFrame(() => {
      if (this._cur !== screen) return;
      const pref = s.el.querySelector('[data-nav][data-default]') ||
        s.el.querySelector('[data-nav]:not([disabled])');
      if (pref) this._focus(pref, false);
    });
  }

  hide() {
    for (const s of this.screens.values()) {
      if (s.el.classList.contains('is-on')) { s.el.classList.remove('is-on'); s.onHide?.(); }
    }
    this.el.classList.add('is-hidden');
    this.el.removeAttribute('data-screen');
    this._cur = null;
    if (this._keysOn) {
      window.removeEventListener('keydown', this._onKeyDown, true);
      this._keysOn = false;
    }
    this._announce(false);
  }

  /**
   * Tell the rest of the interface whether a screen is covering the arena.
   * The touch layer listens: its buttons must not sit under the pause menu,
   * and a menu is the one thing that can appear while a match is still live.
   */
  _announce(open) {
    if (open === this._announced) return;
    this._announced = open;
    window.dispatchEvent(new CustomEvent('crv2:menu', { detail: { open } }));
  }

  _ensure(id) {
    let s = this.screens.get(id);
    if (s) return s;
    const build = this[`_build_${id}`];
    if (typeof build !== 'function') return null;
    s = build.call(this);
    s.id = id;
    s.el.classList.add('screen', `screen--${id}`);
    this.el.appendChild(s.el);
    this.screens.set(id, s);
    return s;
  }

  // -------------------------------------------------------------------------
  // Navigation (keyboard + gamepad-as-keyboard + pointer)
  // -------------------------------------------------------------------------

  _navItems() {
    const s = this.screens.get(this._cur);
    if (!s) return [];
    return Array.from(s.el.querySelectorAll('[data-nav]'))
      .filter((n) => !n.disabled && n.offsetParent !== null);
  }

  _focus(node, scroll) {
    if (!node) return;
    node.focus({ preventScroll: true });
    if (scroll !== false) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this._moveCursor(node);
    node.dispatchEvent(new CustomEvent('crv2focus', { bubbles: true }));
  }

  /**
   * Slide the selection indicator onto `node`. Reads layout, which is fine
   * here: this only ever runs on a navigation event, never in a frame loop.
   */
  _moveCursor(node) {
    const s = this.screens.get(this._cur);
    const cursor = s?.cursor;
    if (!cursor) return;
    const host = cursor.parentElement;
    if (!host.contains(node)) { cursor.classList.remove('is-on'); return; }
    const r = node.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    cursor.style.setProperty('--y', `${r.top - hr.top}px`);
    cursor.style.setProperty('--x', `${r.left - hr.left}px`);
    cursor.style.setProperty('--w', `${r.width}px`);
    cursor.style.setProperty('--h', `${r.height}px`);
    cursor.classList.add('is-on');
  }

  /** Nearest item along an axis; wraps to the far side when nothing is ahead. */
  _move(dx, dy) {
    const items = this._navItems();
    if (!items.length) return;
    const from = items.includes(document.activeElement) ? document.activeElement : items[0];
    if (from !== document.activeElement) { this._focus(from); return; }

    const r0 = from.getBoundingClientRect();
    const cx = r0.left + r0.width / 2;
    const cy = r0.top + r0.height / 2;

    let best = null, bestScore = Infinity;
    let wrap = null, wrapScore = -Infinity;

    for (const it of items) {
      if (it === from) continue;
      const r = it.getBoundingClientRect();
      const ddx = r.left + r.width / 2 - cx;
      const ddy = r.top + r.height / 2 - cy;
      const along = ddx * dx + ddy * dy;
      const ortho = Math.abs(ddx * dy - ddy * dx);
      if (along > 2) {
        // Penalise lateral drift hard so columns and rows feel "sticky".
        const score = along + ortho * 3.2;
        if (score < bestScore) { bestScore = score; best = it; }
      } else if (along < -2) {
        const score = -along - ortho * 3.2;
        if (score > wrapScore) { wrapScore = score; wrap = it; }
      }
    }
    this._focus(best || wrap);
  }

  _handleKey(e) {
    if (!this._cur) return;
    const s = this.screens.get(this._cur);
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    const k = e.key;

    // Screens may claim keys first (the join-code field does).
    if (s?.onKey && s.onKey(e) === true) return;

    const stop = () => { e.preventDefault(); e.stopPropagation(); };

    if (k === 'Escape' || k === 'Backspace') {
      if (typing && k === 'Backspace') return;
      stop();
      this._back();
      return;
    }

    if (typing) return;   // let the code field own letters/digits

    switch (k) {
      case 'ArrowUp': case 'w': case 'W': stop(); this._move(0, -1); return;
      case 'ArrowDown': case 's': case 'S': stop(); this._move(0, 1); return;
      case 'ArrowLeft': case 'a': case 'A': stop(); this._adjustOrMove(-1); return;
      case 'ArrowRight': case 'd': case 'D': stop(); this._adjustOrMove(1); return;
      case 'Enter': case ' ': {
        // A focused <button> already activates itself on Enter/Space; only step
        // in when focus is nowhere useful.
        if (active && active.hasAttribute?.('data-nav')) return;
        stop();
        const first = this._navItems()[0];
        this._focus(first);
        return;
      }
      default:
    }
  }

  /** Left/right first tries to nudge a focused slider/cycler, else moves focus. */
  _adjustOrMove(dir) {
    const active = document.activeElement;
    if (active?.dataset?.ctl) {
      this._nudgeControl(active, dir);
      return;
    }
    this._move(dir, 0);
  }

  _back() {
    const id = this._cur;
    if (id === 'pause') { this._emit('resume'); return; }
    if (id === 'settings' || id === 'controls') { this.show(this._returnTo || 'title'); return; }
    if (id === 'netplay') { this._emit('netCancel'); this.show('title'); return; }
    if (id === 'results') { this._emit('quit'); return; }
    const to = this._from.get(id) || BACK_TO[id];
    if (to) this.show(to);
  }

  /** `show`, remembering the route so BACK can retrace it. */
  _enter(screen, from) {
    this._from.set(screen, from);
    this.show(screen);
  }

  // -------------------------------------------------------------------------
  // BOOT
  // -------------------------------------------------------------------------

  /*
   * The first screen anybody ever sees, and the one nobody had ever captured.
   * Its markup and its stylesheet described two different documents:
   *   - `<span class="mark__hex">` was an empty span. The house mark is the
   *     inline SVG in `MARK` and its classes are `mk__*`, so the boot logo was
   *     a zero-size box and the screen opened with no mark on it at all.
   *   - `.boot__bar` was a direct child of `.boot`, so it had no width of its
   *     own and stretched the full 1600px of the frame — a progress bar drawn
   *     as a hairline rule from edge to edge.
   *   - `.boot__row` carried the 420px width the bar wanted, but held the
   *     label and the percentage; and the stylesheet's `.boot__meta` — the
   *     `space-between` row those two belong in — matched nothing, so
   *     "ARENA GEOMETRY" and "62%" printed as one run-on string.
   * Rebuilt in the shape the stylesheet has always described: a 420px
   * `.boot__row` holding the bar with the meta line under it.
   */
  _build_boot() {
    const el = h('div');
    el.innerHTML = `
      <div class="boot">
        <div class="boot__mark">${MARK}<span class="mark__id">CR·V2</span></div>
        <div class="boot__title">${bi('HOLOSSEUM LINK', 'ホロシアム接続')}</div>
        <div class="boot__row">
          <div class="boot__bar"><i class="boot__fill"></i><i class="boot__scan"></i></div>
          <div class="boot__meta">
            <span class="boot__label">INITIALISING</span>
            <span class="boot__pct">0%</span>
          </div>
        </div>
        <div class="boot__glitch" data-text="LOADING">LOADING</div>
      </div>`;
    return {
      el,
      fill: el.querySelector('.boot__fill'),
      label: el.querySelector('.boot__label'),
      pctEl: el.querySelector('.boot__pct'),
      _p: -1,
      _label: '',
    };
  }

  setLoading(progress, label) {
    const s = this._ensure('boot');
    const p = clamp(Number(progress) || 0, 0, 1);
    if (Math.abs(p - s._p) > 0.004) {
      s._p = p;
      s.el.style.setProperty('--p', p.toFixed(3));
      s.pctEl.textContent = `${Math.round(p * 100)}%`;
    }
    if (label != null && label !== s._label) {
      s._label = label;
      s.label.textContent = String(label).toUpperCase();
    }
  }

  // -------------------------------------------------------------------------
  // TITLE
  // -------------------------------------------------------------------------

  _build_title() {
    const el = h('div');
    el.innerHTML = `
      <div class="title">
        <div class="logo">
          <div class="logo__mark">${MARK}<span class="mark__id">HLS·02</span></div>
          <div class="logo__text">
            <div class="logo__eyebrow">CUSTOM MACHINE COMBAT LEAGUE<i>機甲競技連盟</i></div>
            <h1 class="logo__word" data-text="HOLOSSEUM">HOLOSSEUM</h1>
            <div class="logo__kana">ホロシアム<i>SEASON 02</i></div>
          </div>
        </div>

        <nav class="menu">
          <i class="menu__cursor"></i>
          <button class="menu__item" data-nav data-default data-act="battle">
            <span class="mi__n">01</span><span class="mi__l">${bi('ENTER ARENA', '出撃')}</span><span class="mi__a"></span>
          </button>
          <button class="menu__item" data-nav data-act="garage">
            <span class="mi__n">02</span><span class="mi__l">${bi('GARAGE', 'ガレージ')}</span><span class="mi__a"></span>
          </button>
          <button class="menu__item" data-nav data-act="online">
            <span class="mi__n">03</span><span class="mi__l">${bi('ONLINE MATCH', 'オンライン')}</span><span class="mi__a"></span>
          </button>
          <button class="menu__item" data-nav data-act="settings">
            <span class="mi__n">04</span><span class="mi__l">${bi('SETTINGS', '設定')}</span><span class="mi__a"></span>
          </button>
          <button class="menu__item" data-nav data-act="controls">
            <span class="mi__n">05</span><span class="mi__l">${bi('CONTROLS', '操作')}</span><span class="mi__a"></span>
          </button>
        </nav>

        <footer class="title__foot">
          <span>SEASON 02 · BUILD 1.0</span>
          <span class="title__hint">${bi('MOVE ↑↓ · SELECT ENTER · BACK ESC', '選択')}</span>
        </footer>
      </div>`;

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      switch (b.dataset.act) {
        case 'battle': this._enter('mode', 'title'); break;
        case 'garage': this._enter('garage', 'title'); break;
        case 'online': this.sel.mode = 'online'; this._enter('netplay', 'title'); break;
        case 'settings': this._returnTo = 'title'; this.show('settings'); break;
        case 'controls': this._returnTo = 'title'; this.show('controls'); break;
      }
    });

    return { el, cursor: el.querySelector('.menu__cursor') };
  }

  // -------------------------------------------------------------------------
  // MODE
  // -------------------------------------------------------------------------

  _build_mode() {
    const el = h('div');
    const cards = MODES.map((m) => `
      <button class="mode__card" data-nav data-mode="${m.id}" ${m.id === 'solo' ? 'data-default' : ''}>
        <span class="card__tick"></span>
        <span class="card__t">${bi(m.en, m.kana)}</span>
        <span class="card__b">${m.blurb}</span>
        <span class="card__go">SELECT</span>
      </button>`).join('');

    const diffs = DIFFICULTY.map((d) => `
      <button class="diff__b" data-nav data-diff="${d.id}">${bi(d.name, d.kana)}</button>`).join('');

    el.innerHTML = `
      ${stepHeader('01', 'BATTLE MODE', '対戦形式')}
      <div class="mode">
        <div class="mode__grid">${cards}</div>
        <div class="mode__diff">
          <div class="sub">${bi('COMMANDER LEVEL', '難易度')}</div>
          <div class="diff__row">${diffs}</div>
        </div>
      </div>
      <footer class="foot">
        <button class="btn btn--ghost" data-nav data-act="back">${bi('BACK', '戻る')}</button>
        <button class="btn btn--go" data-nav data-act="next">${bi('TO GARAGE', 'ガレージへ')}</button>
      </footer>`;

    const s = { el };
    const paint = () => {
      for (const b of el.querySelectorAll('[data-mode]')) {
        b.classList.toggle('is-sel', b.dataset.mode === this.sel.mode);
      }
      for (const b of el.querySelectorAll('[data-diff]')) {
        b.classList.toggle('is-sel', b.dataset.diff === this.sel.difficulty);
      }
      // Difficulty is meaningless in local versus / online.
      el.querySelector('.mode__diff').classList.toggle(
        'is-off', this.sel.mode === 'versus' || this.sel.mode === 'online');
    };

    el.addEventListener('click', (e) => {
      const m = e.target.closest('[data-mode]');
      if (m) { this.sel.mode = m.dataset.mode; paint(); return; }
      const d = e.target.closest('[data-diff]');
      if (d) { this.sel.difficulty = d.dataset.diff; paint(); return; }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'back') this._back();
      else if (this.sel.mode === 'online') this._enter('netplay', 'mode');
      else this._enter('garage', 'mode');
    });

    s.onShow = paint;
    return s;
  }

  // -------------------------------------------------------------------------
  // GARAGE
  // -------------------------------------------------------------------------

  _build_garage() {
    const el = h('div');

    const rail = CATEGORIES.map((c, i) => `
      <button class="rail__b" data-nav data-cat="${c.key}" ${i === 0 ? 'data-default' : ''}>
        <span class="rail__i">0${i + 1}</span>
        <span class="rail__l">${bi(c.label, c.kana)}</span>
        <span class="rail__eq"></span>
      </button>`).join('');

    const presets = PRESETS.map((p, i) => `
      <button class="preset" data-nav data-preset="${i}">${p.name}</button>`).join('');

    // One list per category, all built up front and toggled by class — keeps
    // scroll position per tab and never re-parses markup.
    const lists = CATEGORIES.map((c) => {
      const rows = c.list.map((p) => `
        <button class="row" data-nav data-cat="${c.key}" data-part="${p.id}">
          <span class="row__bar"></span>
          <span class="row__main">
            <span class="row__n">${p.name}</span>
            <span class="row__k">${p.kana}</span>
          </span>
          <span class="row__c">${p.class || c.label}</span>
          <span class="row__eq">EQUIPPED</span>
        </button>`).join('');
      return `<div class="list" data-cat="${c.key}">${rows}</div>`;
    }).join('');

    // Source order is load-bearing: label, then the number, then the bar
    // underneath. `.st__bar` spans the full row, so grid auto-placement puts
    // whatever follows it on a new line — listing the bar second pushed the
    // value below it and left the bar reading as an orphan above its own label.
    const statRows = Array.from({ length: MAX_STAT_ROWS }, () => `
      <div class="st">
        <span class="st__l"><b></b><i></i></span>
        <span class="st__v"></span>
        <span class="st__d"></span>
        <span class="st__bar"><i class="st__a"></i><i class="st__b"></i></span>
      </div>`).join('');

    /* N2. The stage column used to end in a `.stage__eq` row of five chips —
       BODY / GUN / BOMB / POD / LEGS with the equipped part under each. Two
       rounds of trying to move it out of the way missed the point: the model
       is not laid out by this document. `Game._renderPreview` reads the
       slot's rect, maps its CENTRE into a world offset and renders the machine
       at a fixed world size, so the machine is roughly 675px tall whatever the
       hole is, and it overhangs the 586px slot by about 100px at the feet.
       Nothing in normal flow below the stage view can avoid it, and shrinking
       the slot only drags the model down with it.
       So the row is gone. Every one of those five chips was a second copy of a
       `.rail__b` on the left — same category, same equipped part name, same
       action (select that category) — printed in 7px --ink-faint over the one
       object on the screen the player came to look at. The rail keeps the
       reading; the stage column keeps the machine. */

    el.innerHTML = `
      ${stepHeader('02', 'GARAGE', 'ガレージ')}
      <div class="garage">
        <aside class="garage__rail">
          ${rail}
          <div class="rail__sep"></div>
          <div class="rail__pl">
            <button class="pl__b" data-nav data-player="0">P1</button>
            <button class="pl__b" data-nav data-player="1">P2</button>
          </div>
        </aside>

        <section class="garage__list">
          <div class="list__head">
            <span class="list__t"></span>
            <span class="list__n"></span>
          </div>
          <div class="list__scroll">${lists}</div>
          <div class="list__presets">
            <span class="presets__l">${bi('PRESETS', '定型')}</span>
            <div class="presets__row">${presets}</div>
          </div>
        </section>

        <section class="garage__stage">
          <div class="stage__view">
            <div class="stage__slot" data-slot="0"></div>
            <div class="stage__slot" data-slot="1"></div>
            <div class="stage__ph">${bi('PREVIEW OFFLINE', 'プレビュー')}</div>
            <div class="stage__corner stage__corner--tl"></div>
            <div class="stage__corner stage__corner--tr"></div>
            <div class="stage__corner stage__corner--bl"></div>
            <div class="stage__corner stage__corner--br"></div>
            <div class="stage__tag">P1</div>
          </div>
        </section>

        <section class="garage__info">
          <div class="info__head">
            <span class="info__n"></span>
            <span class="info__k"></span>
            <span class="info__c"></span>
          </div>
          <p class="info__b"></p>
          <div class="info__swl">LIVERY<i>塗装</i></div>
          <div class="info__sw"><i></i><i></i><i></i></div>
          <div class="info__statl"><span>PERFORMANCE<i>性能</i></span><span>VS EQUIPPED</span></div>
          <div class="info__stats">${statRows}</div>
          <div class="info__legend">
            <span class="lg lg--a">EQUIPPED</span>
            <span class="lg lg--b">CANDIDATE</span>
          </div>
        </section>
      </div>
      <footer class="foot">
        <button class="btn btn--ghost" data-nav data-act="back">${bi('BACK', '戻る')}</button>
        <span class="foot__hint">${bi('HOVER TO COMPARE · ENTER TO EQUIP', '比較・装備')}</span>
        <button class="btn btn--go" data-nav data-act="next">${bi('SELECT ARENA', 'アリーナへ')}</button>
      </footer>`;

    // ---- cached refs -----------------------------------------------------
    const s = {
      el,
      cat: 'body',
      player: 0,
      hover: null,
      lists: new Map(),
      rows: new Map(),
      rail: new Map(),
      statRows: Array.from(el.querySelectorAll('.st')).map((r) => ({
        el: r,
        en: r.querySelector('.st__l b'),
        kana: r.querySelector('.st__l i'),
        a: r.querySelector('.st__a'),
        b: r.querySelector('.st__b'),
        v: r.querySelector('.st__v'),
        d: r.querySelector('.st__d'),
      })),
      info: {
        n: el.querySelector('.info__n'),
        k: el.querySelector('.info__k'),
        c: el.querySelector('.info__c'),
        b: el.querySelector('.info__b'),
        sw: Array.from(el.querySelectorAll('.info__sw i')),
      },
      listT: el.querySelector('.list__t'),
      listN: el.querySelector('.list__n'),
      stageTag: el.querySelector('.stage__tag'),
      slots: Array.from(el.querySelectorAll('.stage__slot')),
    };
    for (const l of el.querySelectorAll('.list')) s.lists.set(l.dataset.cat, l);
    for (const r of el.querySelectorAll('.row')) s.rows.set(`${r.dataset.cat}:${r.dataset.part}`, r);
    for (const r of el.querySelectorAll('.rail__b')) s.rail.set(r.dataset.cat, r);

    // ---- behaviour -------------------------------------------------------
    const cat = (key) => CATEGORIES.find((c) => c.key === key);

    const setCat = (key) => {
      s.cat = key;
      for (const [k, l] of s.lists) l.classList.toggle('is-on', k === key);
      for (const [k, b] of s.rail) b.classList.toggle('is-sel', k === key);
      const c = cat(key);
      s.listT.innerHTML = bi(c.label, c.kana);
      s.listN.textContent = `${c.list.length} PARTS`;
      paintEquipped();
      preview(c.map.get(this.sel.loadouts[s.player][key]) || c.list[0]);
    };

    const paintEquipped = () => {
      const ld = this.sel.loadouts[s.player];
      for (const c of CATEGORIES) {
        const eq = ld[c.key];
        for (const p of c.list) {
          const row = s.rows.get(`${c.key}:${p.id}`);
          if (row) row.classList.toggle('is-eq', p.id === eq);
        }
        const part = c.map.get(eq) || c.list[0];
        const railEq = s.rail.get(c.key)?.querySelector('.rail__eq');
        if (railEq) railEq.textContent = part.name;
      }
      for (const b of el.querySelectorAll('[data-player]')) {
        b.classList.toggle('is-sel', Number(b.dataset.player) === s.player);
      }
      s.stageTag.textContent = `P${s.player + 1}`;
      for (let i = 0; i < s.slots.length; i++) s.slots[i].classList.toggle('is-on', i === s.player);
    };

    /** Fill the compare panel for `part` against the equipped part. */
    const preview = (part) => {
      if (!part || part === s.hover) return;
      s.hover = part;
      const c = cat(s.cat);
      const base = c.map.get(this.sel.loadouts[s.player][s.cat]) || c.list[0];
      const spec = STATS[s.cat];

      s.info.n.textContent = part.name;
      s.info.k.textContent = part.kana;
      s.info.c.textContent = (part.class || c.label).toUpperCase();
      s.info.b.textContent = part.blurb || '';

      const look = part.look || {};
      const cols = [look.primary ?? look.colour, look.secondary ?? look.shell ?? look.accent, look.accent ?? look.ring ?? look.emissive];
      for (let i = 0; i < s.info.sw.length; i++) {
        const col = cols[i];
        s.info.sw[i].style.background = col == null ? 'transparent' : hex(col);
        s.info.sw[i].classList.toggle('is-off', col == null);
      }

      for (let i = 0; i < s.statRows.length; i++) {
        const row = s.statRows[i];
        const st = spec[i];
        if (!st) { row.el.classList.add('is-off'); continue; }
        row.el.classList.remove('is-off');
        row.en.textContent = st.en;
        row.kana.textContent = st.kana;

        const na = clamp(st.norm(base), 0, 1);
        const nb = clamp(st.norm(part), 0, 1);
        row.a.style.setProperty('--v', na.toFixed(3));
        row.b.style.setProperty('--v', nb.toFixed(3));
        row.v.textContent = st.fmt(st.raw(part));

        const delta = st.raw(part) - st.raw(base);
        const eps = Math.abs(st.raw(base)) * 1e-4 + 1e-6;
        // The up/down tint belongs on the delta cell itself. Toggling it on the
        // row never matched `.st__d.is-up`, so every delta rendered in the same
        // dim grey and the compare panel lost the one signal it exists for.
        if (Math.abs(delta) <= eps) {
          row.d.textContent = '—';
          row.d.classList.remove('is-up', 'is-down');
        } else {
          const good = st.better === 'hi' ? delta > 0 : delta < 0;
          row.d.textContent = `${delta > 0 ? '+' : '−'}${st.fmt(Math.abs(delta))}`;
          row.d.classList.toggle('is-up', good);
          row.d.classList.toggle('is-down', !good);
        }
      }

      // The headline stat drives the little strength bar on each list row.
      for (const p of c.list) {
        const row = s.rows.get(`${c.key}:${p.id}`);
        if (row) row.style.setProperty('--v', clamp(spec[0].norm(p), 0.04, 1).toFixed(3));
        if (row) row.classList.toggle('is-hover', p === part);
      }
    };

    const equip = (key, id) => {
      const ld = this.sel.loadouts[s.player];
      if (ld[key] === id) return;
      ld[key] = id;
      paintEquipped();
      s.hover = null;
      preview(cat(key).map.get(id));
      this._emit('loadoutChange', { index: s.player, loadout: { ...ld } });
    };

    el.addEventListener('click', (e) => {
      const railB = e.target.closest('[data-cat].rail__b');
      if (railB) { setCat(railB.dataset.cat); return; }

      const row = e.target.closest('.row');
      if (row) { equip(row.dataset.cat, row.dataset.part); return; }

      const pre = e.target.closest('[data-preset]');
      if (pre) {
        const src = PRESETS[Number(pre.dataset.preset)].loadout;
        this.sel.loadouts[s.player] = { ...DEFAULT_LOADOUT, ...src };
        paintEquipped();
        s.hover = null;
        preview(cat(s.cat).map.get(this.sel.loadouts[s.player][s.cat]));
        this._emit('loadoutChange', { index: s.player, loadout: { ...this.sel.loadouts[s.player] } });
        return;
      }

      const pl = e.target.closest('[data-player]');
      if (pl) {
        s.player = Number(pl.dataset.player);
        paintEquipped();
        s.hover = null;
        preview(cat(s.cat).map.get(this.sel.loadouts[s.player][s.cat]));
        // The stage is a single live model driven by `loadoutChange`, and
        // switching player was the one thing that changed which machine the
        // panel describes without announcing it. The tag read P2, the rail
        // read P2's parts, the compare table read P2's numbers — and the
        // machine on the stage was still P1's, until you happened to equip
        // something and it swapped under you.
        this._emit('loadoutChange', { index: s.player, loadout: { ...this.sel.loadouts[s.player] } });
        return;
      }

      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'back') this._back();
      else this._enter('arena', 'garage');
    });

    // Focus (keyboard/pad) and hover (pointer) both drive the comparison.
    el.addEventListener('crv2focus', (e) => {
      const row = e.target.closest?.('.row');
      if (row && row.dataset.cat === s.cat) preview(cat(row.dataset.cat).map.get(row.dataset.part));
      const railB = e.target.closest?.('.rail__b');
      if (railB && railB.dataset.cat !== s.cat) setCat(railB.dataset.cat);
    });

    s.onShow = (data) => {
      if (data.index != null) s.player = clamp(Number(data.index) | 0, 0, 1);
      if (data.loadouts) {
        for (let i = 0; i < 2; i++) {
          if (data.loadouts[i]) this.sel.loadouts[i] = { ...DEFAULT_LOADOUT, ...data.loadouts[i] };
        }
      }
      if (data.mode) this.sel.mode = data.mode;
      // `is-2p` was toggled on the SCREEN root and the only rules that read it
      // are `.stage__view.is-2p`, so the two-up stage has never once been on.
      // It is also only honest when there is a second machine to put in it:
      // the integrator hands us one preview node, and splitting the box for a
      // slot nobody filled would trade one machine for an empty half-frame.
      el.classList.toggle('is-2p', this.sel.mode === 'versus');
      el.querySelector('.stage__view').classList.toggle(
        'is-2p', this.sel.mode === 'versus' && !!this._previewSlots[1]);
      if (this.sel.mode !== 'versus') s.player = 0;
      s.hover = null;
      setCat(s.cat);
      this._applyPreviewSlots();
    };

    return s;
  }

  /** The integrator owns the live 3D preview canvas; we just host it. */
  setPreviewSlot(index, node) {
    this._previewSlots[index] = node || null;
    if (this.screens.has('garage')) this._applyPreviewSlots();
  }

  _applyPreviewSlots() {
    const g = this.screens.get('garage');
    if (!g) return;
    let any = false;
    for (let i = 0; i < g.slots.length; i++) {
      const node = this._previewSlots[i];
      const slot = g.slots[i];
      if (node && node.parentElement !== slot) {
        slot.textContent = '';
        slot.appendChild(node);
      }
      if (node) any = true;
    }
    g.el.querySelector('.stage__view').classList.toggle('has-preview', any);
  }

  // -------------------------------------------------------------------------
  // ARENA
  // -------------------------------------------------------------------------

  _build_arena() {
    const el = h('div');
    const cards = ARENAS.map((a, i) => `
      <button class="arena__card" data-nav data-arena="${a.id}" ${i === 0 ? 'data-default' : ''}
        style="--acc:${hex(a.theme.accent)};--sky:${hex(a.theme.skyTop)};--floor:${hex(a.theme.floor)};--em:${hex(a.theme.emissive)}">
        <span class="ac__sky"></span>
        <span class="ac__grid"></span>
        <span class="ac__tick"></span>
        <span class="ac__body">
          <span class="ac__n">${a.name}</span>
          <span class="ac__k">${a.kana}</span>
          <span class="ac__b">${a.blurb}</span>
          <span class="ac__meta">${a.bounds.hx * 2}×${a.bounds.hz * 2}m · CEIL ${a.bounds.ceil}m</span>
        </span>
      </button>`).join('');

    el.innerHTML = `
      ${stepHeader('03', 'HOLOSSEUM', 'アリーナ選択')}
      <div class="arena">${cards}</div>
      <footer class="foot">
        <button class="btn btn--ghost" data-nav data-act="back">${bi('BACK', '戻る')}</button>
        <span class="foot__hint arena__sel"></span>
        <button class="btn btn--fight" data-nav data-act="fight">${bi('FIGHT', '出撃')}</button>
      </footer>`;

    const s = { el, selLabel: el.querySelector('.arena__sel') };

    const paint = () => {
      for (const b of el.querySelectorAll('[data-arena]')) {
        b.classList.toggle('is-sel', b.dataset.arena === this.sel.arenaId);
      }
      const a = ARENAS.find((x) => x.id === this.sel.arenaId) || ARENAS[0];
      s.selLabel.innerHTML = bi(a.name, a.kana);
    };

    const pick = (id, fire) => {
      if (this.sel.arenaId === id) return;
      this.sel.arenaId = id;
      paint();
      if (fire) this._emit('arenaChange', { arenaId: id });
    };

    // Focusing a card previews it live; the integrator can swap the backdrop.
    el.addEventListener('crv2focus', (e) => {
      const c = e.target.closest?.('[data-arena]');
      if (c) pick(c.dataset.arena, true);
    });

    el.addEventListener('click', (e) => {
      const c = e.target.closest('[data-arena]');
      if (c) { pick(c.dataset.arena, true); return; }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'back') this._back();
      else this._start();
    });

    s.onShow = paint;
    return s;
  }

  _start() {
    this._emit('start', {
      mode: this.sel.mode,
      difficulty: this.sel.difficulty,
      arenaId: this.sel.arenaId,
      loadouts: [{ ...this.sel.loadouts[0] }, { ...this.sel.loadouts[1] }],
    });
  }

  // -------------------------------------------------------------------------
  // NETPLAY
  // -------------------------------------------------------------------------

  _build_netplay() {
    const el = h('div');
    const boxes = Array.from({ length: 5 }, (_, i) =>
      `<input class="code__box" data-i="${i}" maxlength="1" inputmode="latin" autocomplete="off"
        autocapitalize="characters" spellcheck="false" aria-label="code ${i + 1}">`).join('');

    el.innerHTML = `
      ${stepHeader('--', 'ONLINE MATCH', 'オンライン対戦')}
      <div class="net">
        <section class="net__panel net__panel--host">
          <div class="np__t">${bi('HOST A ROOM', 'ルーム作成')}</div>
          <p class="np__b">Generate a room code and wait for a challenger. You are P1.</p>
          <div class="code code--host"><span class="code__v">-----</span></div>
          <div class="np__row">
            <button class="btn btn--go" data-nav data-default data-act="host">${bi('CREATE ROOM', '作成')}</button>
            <button class="btn btn--ghost" data-nav data-act="copy">${bi('COPY CODE', 'コピー')}</button>
          </div>
          <div class="np__wait"><i></i><i></i><i></i><span>WAITING FOR CHALLENGER<em>対戦相手を待機中</em></span></div>
        </section>

        <div class="net__or"><span>OR</span></div>

        <section class="net__panel net__panel--join">
          <div class="np__t">${bi('JOIN A ROOM', 'ルーム参加')}</div>
          <p class="np__b">Type the five-character code your opponent sent. You are P2.</p>
          <div class="code code--join">${boxes}</div>
          <div class="np__row">
            <button class="btn btn--go" data-nav data-act="join" disabled>${bi('CONNECT', '接続')}</button>
            <button class="btn btn--ghost" data-nav data-act="clear">${bi('CLEAR', '消去')}</button>
          </div>
        </section>

        <!-- Inside .net, not after it. .net is the flex:1 centred block and the
             status line is the caption for what is in it; as a sibling it fell
             to the bottom of the screen, 130px of empty space below the panel
             it describes, and its own top margin was inert. -->
        <div class="net__status">
          <span class="ns__dot"></span>
          <span class="ns__t">IDLE</span>
          <span class="ns__m"></span>
          <span class="ns__p"></span>
        </div>
      </div>

      <footer class="foot">
        <button class="btn btn--ghost" data-nav data-act="cancel">${bi('CANCEL', '中止')}</button>
        <button class="btn btn--fight" data-nav data-act="ready" disabled>${bi('TO GARAGE', 'ガレージへ')}</button>
      </footer>`;

    const s = {
      el,
      codeV: el.querySelector('.code__v'),
      boxes: Array.from(el.querySelectorAll('.code__box')),
      joinBtn: el.querySelector('[data-act="join"]'),
      readyBtn: el.querySelector('[data-act="ready"]'),
      statusT: el.querySelector('.ns__t'),
      statusM: el.querySelector('.ns__m'),
      statusP: el.querySelector('.ns__p'),
      status: el.querySelector('.net__status'),
      hostPanel: el.querySelector('.net__panel--host'),
    };

    const code = () => s.boxes.map((b) => b.value).join('').toUpperCase();
    const syncJoin = () => {
      const full = code().length === 5;
      s.joinBtn.disabled = !full;
      s.joinBtn.classList.toggle('is-armed', full);
    };

    // Five single-character fields: auto-uppercase, auto-advance, paste-aware.
    for (const box of s.boxes) {
      box.addEventListener('input', () => {
        const v = box.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        box.value = v.slice(-1);
        const i = Number(box.dataset.i);
        if (box.value && i < s.boxes.length - 1) s.boxes[i + 1].focus();
        syncJoin();
      });
      box.addEventListener('keydown', (e) => {
        const i = Number(box.dataset.i);
        if (e.key === 'Backspace' && !box.value && i > 0) { s.boxes[i - 1].focus(); s.boxes[i - 1].value = ''; syncJoin(); }
        else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); s.boxes[i - 1].focus(); }
        else if (e.key === 'ArrowRight' && i < s.boxes.length - 1) { e.preventDefault(); s.boxes[i + 1].focus(); }
        else if (e.key === 'Enter' && code().length === 5) { e.preventDefault(); this._emit('netJoin', { code: code() }); }
      });
      box.addEventListener('paste', (e) => {
        const text = (e.clipboardData?.getData('text') || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (!text) return;
        e.preventDefault();
        for (let i = 0; i < s.boxes.length; i++) s.boxes[i].value = text[i] || '';
        syncJoin();
        s.boxes[Math.min(text.length, 4)].focus();
      });
    }

    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      switch (a.dataset.act) {
        case 'host':
          this.setNetState({ status: 'hosting', message: 'opening room…' });
          this._emit('netHost', {});
          break;
        case 'copy': {
          const c = this.netState.code;
          if (c) navigator.clipboard?.writeText(c).then(
            () => this._flashStatus('CODE COPIED'),
            () => this._flashStatus('COPY BLOCKED'),
          );
          break;
        }
        case 'join':
          if (code().length === 5) {
            this.setNetState({ status: 'joining', message: 'dialling…' });
            this._emit('netJoin', { code: code() });
          }
          break;
        case 'clear':
          for (const b of s.boxes) b.value = '';
          syncJoin();
          s.boxes[0].focus();
          break;
        case 'cancel':
          this._emit('netCancel', {});
          this.setNetState({ status: 'idle', code: '', message: '' });
          this.show('title');
          break;
        case 'ready':
          this.sel.mode = 'online';
          this._enter('garage', 'netplay');
          break;
      }
    });

    s.onShow = () => { syncJoin(); this._paintNet(); };
    return s;
  }

  /** @param {object} state {status, code, message, pingMs} */
  setNetState(state) {
    this.netState = { ...this.netState, ...(state || {}) };
    if (this.screens.has('netplay')) this._paintNet();
  }

  _paintNet() {
    const s = this.screens.get('netplay');
    if (!s) return;
    const n = this.netState;
    const status = n.status || 'idle';

    s.el.dataset.net = status;
    s.codeV.textContent = (n.code || '-----').toUpperCase();
    s.statusT.textContent = {
      idle: 'IDLE', hosting: 'HOSTING', joining: 'CONNECTING',
      connected: 'LINKED', error: 'ERROR',
    }[status] || status.toUpperCase();
    s.statusM.textContent = n.message || '';
    s.statusP.textContent = n.pingMs ? `${Math.round(n.pingMs)} ms` : '';
    s.status.className = `net__status is-${status}`;
    s.readyBtn.disabled = status !== 'connected';
    s.readyBtn.classList.toggle('is-armed', status === 'connected');

    // The three-dot "WAITING FOR CHALLENGER" indicator is styled behind
    // `.net__panel.is-armed`, and nothing had ever put `is-armed` on a
    // `.net__panel` — the class was only ever set on two buttons. So the one
    // piece of feedback the host screen has for the state it spends all its
    // time in was unreachable markup: you pressed CREATE ROOM, a code
    // appeared, and nothing else on the panel said anybody was listening.
    s.hostPanel.classList.toggle('is-armed', status === 'hosting');
  }

  _flashStatus(text) {
    const s = this.screens.get('netplay');
    if (!s) return;
    const prev = s.statusM.textContent;
    s.statusM.textContent = text;
    clearTimeout(s._flashT);
    s._flashT = setTimeout(() => { s.statusM.textContent = this.netState.message || prev || ''; }, 1200);
  }

  // -------------------------------------------------------------------------
  // PAUSE
  // -------------------------------------------------------------------------

  _build_pause() {
    const el = h('div');
    el.innerHTML = `
      <div class="pause">
        <div class="pause__t" data-text="PAUSED">PAUSED<i>一時停止</i></div>
        <nav class="menu menu--pause">
          <i class="menu__cursor"></i>
          <button class="menu__item" data-nav data-default data-act="resume"><span class="mi__l">${bi('RESUME', '再開')}</span><span class="mi__a"></span></button>
          <button class="menu__item" data-nav data-act="settings"><span class="mi__l">${bi('SETTINGS', '設定')}</span><span class="mi__a"></span></button>
          <button class="menu__item" data-nav data-act="controls"><span class="mi__l">${bi('CONTROLS', '操作')}</span><span class="mi__a"></span></button>
          <button class="menu__item menu__item--warn" data-nav data-act="quit"><span class="mi__l">${bi('QUIT MATCH', '中断')}</span><span class="mi__a"></span></button>
        </nav>
      </div>`;

    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      switch (a.dataset.act) {
        case 'resume': this._emit('resume'); break;
        case 'settings': this._returnTo = 'pause'; this.show('settings'); break;
        case 'controls': this._returnTo = 'pause'; this.show('controls'); break;
        case 'quit': this._emit('quit'); break;
      }
    });

    return { el, cursor: el.querySelector('.menu__cursor') };
  }

  // -------------------------------------------------------------------------
  // RESULTS
  // -------------------------------------------------------------------------

  _build_results() {
    const el = h('div');
    el.innerHTML = `
      <div class="results">
        <div class="res__verdict" data-text="WIN">WIN<i class="res__kana">勝利</i></div>
        <!-- Both sides read name-over-number. Side B used to be written in
             mirrored source order, which is right for a row and wrong for a
             column: rs__side stacks its children, so the mirror flipped the
             side VERTICALLY instead of horizontally and the two score numerals
             — the largest objects on the screen — sat at different heights
             either side of the VS. -->
        <div class="res__score">
          <div class="rs__side rs__side--a"><span class="rs__n"></span><span class="rs__w">0</span></div>
          <span class="rs__vs">VS</span>
          <div class="rs__side rs__side--b"><span class="rs__n"></span><span class="rs__w">0</span></div>
        </div>
        <div class="res__rounds"></div>
        <div class="res__stats"></div>
        <div class="res__actions">
          <button class="btn btn--fight" data-nav data-default data-act="rematch">${bi('REMATCH', '再戦')}</button>
          <button class="btn btn--ghost" data-nav data-act="garage">${bi('GARAGE', 'ガレージ')}</button>
          <button class="btn btn--ghost" data-nav data-act="quit">${bi('QUIT TO TITLE', 'タイトルへ')}</button>
        </div>
      </div>`;

    const s = {
      el,
      verdict: el.querySelector('.res__verdict'),
      kana: el.querySelector('.res__kana'),
      nameA: el.querySelector('.rs__side--a .rs__n'),
      nameB: el.querySelector('.rs__side--b .rs__n'),
      winA: el.querySelector('.rs__side--a .rs__w'),
      winB: el.querySelector('.rs__side--b .rs__w'),
      rounds: el.querySelector('.res__rounds'),
      stats: el.querySelector('.res__stats'),
    };

    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'rematch') this._emit('rematch');
      // The match is over, so there is no results screen to come BACK to.
      else if (a.dataset.act === 'garage') this._enter('garage', 'title');
      else this._emit('quit');
    });

    s.onShow = (data) => {
      const local = data.localIndex ?? 0;
      const names = data.names || ['P1', 'P2'];
      const wins = data.wins || [0, 0];
      const winner = data.winner ?? -1;

      const verdict = winner < 0 ? 'DRAW' : winner === local ? 'WIN' : 'LOSE';
      s.verdict.childNodes[0].nodeValue = verdict;
      s.verdict.setAttribute('data-text', verdict);
      s.kana.textContent = verdict === 'WIN' ? '勝利' : verdict === 'LOSE' ? '敗北' : '引分';
      el.dataset.verdict = verdict.toLowerCase();

      s.nameA.textContent = String(names[0]).toUpperCase();
      s.nameB.textContent = String(names[1]).toUpperCase();
      s.winA.textContent = String(wins[0]);
      s.winB.textContent = String(wins[1]);

      // Round-by-round strip. Falls back to a synthetic history when the
      // integrator has none to hand.
      let rounds = data.rounds;
      if (!Array.isArray(rounds) || !rounds.length) {
        rounds = [];
        for (let i = 0; i < wins[0]; i++) rounds.push({ winner: 0 });
        for (let i = 0; i < wins[1]; i++) rounds.push({ winner: 1 });
      }
      s.rounds.textContent = '';
      rounds.forEach((r, i) => {
        const outcome = r.winner < 0 ? 'draw' : r.winner === local ? 'win' : 'lose';
        const chip = h('div', `rchip is-${outcome}`);
        chip.innerHTML = `<span class="rchip__r">R${r.round ?? i + 1}</span>
          <span class="rchip__o">${outcome.toUpperCase()}</span>
          <span class="rchip__x">${r.timeout ? 'TIME UP' : 'K.O.'}</span>`;
        s.rounds.appendChild(chip);
      });

      s.stats.textContent = '';
      const rows = data.stats && typeof data.stats === 'object' ? Object.entries(data.stats) : [];
      for (const [k, v] of rows) {
        const row = h('div', 'rstat');
        row.innerHTML = `<span class="rstat__k"></span><span class="rstat__v"></span>`;
        row.querySelector('.rstat__k').textContent = String(k).toUpperCase();
        row.querySelector('.rstat__v').textContent = String(v);
        s.stats.appendChild(row);
      }
    };

    return s;
  }

  // -------------------------------------------------------------------------
  // SETTINGS
  // -------------------------------------------------------------------------

  _build_settings() {
    const el = h('div');

    const slider = (key, en, kana) => `
      <button class="opt opt--slider" data-nav data-ctl="${key}">
        <span class="opt__l">${bi(en, kana)}</span>
        <span class="opt__bar"><i class="opt__fill"></i><i class="opt__grid"></i></span>
        <span class="opt__v"></span>
      </button>`;

    // The two arrows carry their own direction. Without `data-cyc` the click
    // handler had one branch for the whole row and pressed `‹` — a control
    // whose entire meaning is "the other way" — one step FORWARD. With four
    // quality tiers that is three presses to reach the neighbour on your left.
    const cycler = (key, en, kana) => `
      <button class="opt opt--cycle" data-nav data-ctl="${key}">
        <span class="opt__l">${bi(en, kana)}</span>
        <span class="opt__cy"><i class="cy__a" data-cyc="-1">‹</i><span class="opt__v"></span><i class="cy__a" data-cyc="1">›</i></span>
      </button>`;

    const toggle = (key, en, kana) => `
      <button class="opt opt--toggle" data-nav data-ctl="${key}">
        <span class="opt__l">${bi(en, kana)}</span>
        <span class="opt__sw"><i></i></span>
        <span class="opt__v"></span>
      </button>`;

    el.innerHTML = `
      ${stepHeader('--', 'SETTINGS', '設定')}
      <div class="opts">
        <div class="opts__group">
          <div class="sub">${bi('AUDIO', '音声')}</div>
          ${slider('master', 'MASTER', 'マスター')}
          ${slider('sfx', 'EFFECTS', '効果音')}
          ${slider('music', 'MUSIC', '音楽')}
        </div>
        <div class="opts__group">
          <div class="sub">${bi('VIDEO', '映像')}</div>
          ${cycler('quality', 'QUALITY', '画質')}
          ${slider('shakeAmount', 'SCREEN SHAKE', '振動')}
        </div>
        <div class="opts__group">
          <div class="sub">${bi('CONTROL', '操作')}</div>
          ${slider('sensitivity', 'SENSITIVITY', '感度')}
          ${toggle('invertY', 'INVERT Y', 'Y反転')}
          ${cycler('touchLayout', 'TOUCH LAYOUT', 'タッチ配置')}
        </div>
      </div>
      <footer class="foot">
        <button class="btn btn--ghost" data-nav data-act="back" data-default>${bi('BACK', '戻る')}</button>
        <span class="foot__hint">${bi('← → ADJUST', '調整')}</span>
        <button class="btn btn--ghost" data-nav data-act="reset">${bi('RESET DEFAULTS', '初期化')}</button>
      </footer>`;

    const s = { el, opts: new Map() };
    for (const o of el.querySelectorAll('[data-ctl]')) s.opts.set(o.dataset.ctl, o);

    el.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-ctl]');
      if (opt) {
        const key = opt.dataset.ctl;
        // Position-set ONLY for a real pointer press that landed on the bar.
        //
        // Every option here is a <button>, so Enter and Space — and the pad,
        // which is forwarded as keydown — fire a click with `detail: 0` and
        // `clientX: 0`. That put `t` at the far left of the track: pressing
        // Enter on MASTER set the volume to 0%, on a screen whose own footer
        // hint says the way to change a value is the arrow keys. A pointer
        // click on the row's LABEL was the same bug by another route, since
        // that x is also left of the bar.
        // Both cases now nudge one step, which is what the cycler and the
        // toggle have always done on activation.
        const bar = e.detail > 0 && SLIDERS[key] ? e.target.closest('.opt__bar') : null;
        if (bar) {
          const r = bar.getBoundingClientRect();
          const t = clamp((e.clientX - r.left) / r.width, 0, 1);
          const [min, max, step] = SLIDERS[key];
          this._setSetting(key, Math.round((min + t * (max - min)) / step) * step);
        } else {
          // A pointer landing on an arrow means that arrow's direction; a
          // press anywhere else on the row (or Enter, whose target is the
          // button itself) keeps the old "one step forward".
          const arrow = e.detail > 0 ? e.target.closest('[data-cyc]') : null;
          this._nudgeControl(opt, arrow ? Number(arrow.dataset.cyc) : 1);
        }
        return;
      }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'reset') {
        this.settings = { ...DEFAULT_SETTINGS };
        this._paintSettings();
        this._pushSettings();
      } else {
        this.show(this._returnTo || 'title');
      }
    });

    s.onShow = () => this._paintSettings();
    return s;
  }

  _nudgeControl(node, dir) {
    const key = node.dataset.ctl;
    if (SLIDERS[key]) {
      const [min, max, step] = SLIDERS[key];
      this._setSetting(key, clamp(this.settings[key] + dir * step, min, max));
      return;
    }
    if (key === 'invertY') { this._setSetting(key, !this.settings[key]); return; }
    if (key === 'quality' || key === 'touchLayout') {
      const list = key === 'quality' ? QUALITY : TOUCH_LAYOUTS;
      const i = Math.max(0, list.indexOf(this.settings[key]));
      this._setSetting(key, list[(i + dir + list.length) % list.length]);
    }
  }

  _setSetting(key, value) {
    if (typeof value === 'number') value = Math.round(value * 1000) / 1000;
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    this._paintSettings();
    this._pushSettings();
  }

  _pushSettings() {
    saveSettings(this.settings);
    this._emit('settingsChange', { ...this.settings });
  }

  _paintSettings() {
    const s = this.screens.get('settings');
    if (!s) return;
    for (const [key, node] of s.opts) {
      const v = this.settings[key];
      const out = node.querySelector('.opt__v');
      if (SLIDERS[key]) {
        const [min, max, , fmt] = SLIDERS[key];
        const t = clamp((v - min) / (max - min), 0, 1);
        node.style.setProperty('--v', t.toFixed(3));
        out.textContent = fmt(v);
      } else if (typeof v === 'boolean') {
        node.classList.toggle('is-on', v);
        out.textContent = v ? 'ON' : 'OFF';
      } else {
        out.textContent = String(v).toUpperCase();
      }
    }
  }

  // -------------------------------------------------------------------------
  // CONTROLS
  // -------------------------------------------------------------------------

  _build_controls() {
    const el = h('div');
    const rows = CONTROL_ROWS.map(([en, kana, kb, pad, touch]) => `
      <div class="ctl">
        <span class="ctl__a">${bi(en, kana)}</span>
        <span class="ctl__k"><kbd>${kb}</kbd></span>
        <span class="ctl__p"><kbd>${pad}</kbd></span>
        <span class="ctl__t"><kbd>${touch}</kbd></span>
      </div>`).join('');

    el.innerHTML = `
      ${stepHeader('--', 'CONTROLS', '操作方法')}
      <div class="ctls">
        <div class="ctl ctl--head">
          <span class="ctl__a">ACTION<i>動作</i></span>
          <span class="ctl__k">KEYBOARD<i>キーボード</i></span>
          <span class="ctl__p">GAMEPAD<i>パッド</i></span>
          <span class="ctl__t">TOUCH<i>タッチ</i></span>
        </div>
        ${rows}
      </div>
      <p class="ctls__note">Hold FIRE to charge — release the instant the meter locks to READY for a charged shot. Robos auto-face their opponent, so movement is pure spacing.</p>
      <footer class="foot">
        <button class="btn btn--ghost" data-nav data-default data-act="back">${bi('BACK', '戻る')}</button>
      </footer>`;

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="back"]')) this.show(this._returnTo || 'title');
    });
    return { el };
  }

  // -------------------------------------------------------------------------

  dispose() {
    if (this._keysOn) window.removeEventListener('keydown', this._onKeyDown, true);
    this.el.removeEventListener('pointerover', this._onPointerOver);
    const net = this.screens.get('netplay');
    if (net?._flashT) clearTimeout(net._flashT);
    this.screens.clear();
    this._from.clear();
    this._events.clear();
    this.el.remove();
  }
}

export default Menus;
