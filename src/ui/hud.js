/**
 * Combat HUD.
 *
 * This layer sits on top of a renderer that has already spent its frame budget,
 * so the whole file obeys one rule: `update()` never reads layout and never
 * writes a property that triggers one. Every node is created and cached in the
 * constructor; per-frame work is limited to CSS custom properties, `transform`
 * and `opacity`, and every write is guarded by a "did this actually change?"
 * check against a cached value.
 *
 * Motion (banners, damage numbers, hit markers) is handed to CSS/WAAPI so it
 * runs on the compositor instead of the main thread — the sim needs that thread.
 *
 * three.js is imported for exactly one thing: projecting a world-space hit
 * position into screen space for floating damage numbers.
 */

import * as THREE from 'three';
import { MATCH, TICK_RATE } from '../sim/constants.js';
import { PHASE, STATE } from '../sim/world.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Pooled floating damage numbers. Beyond this we recycle the oldest. */
const DMG_POOL = 24;

/** Damage-number lifetimes (ms). Heavier hits linger so they read as heavier. */
const DMG_LIFE = 900;
const DMG_LIFE_BIG = 1250;

/** Below this HP fraction the local player gets the red vignette treatment. */
const LOW_HP = 0.28;

/** Round clock turns hostile under this many seconds. */
const URGENT_SECONDS = 10;

const PIPS = MATCH.roundsToWin;

const BANNER_STYLES = ['fight', 'ko', 'win', 'lose', 'draw', 'timeup'];

/**
 * Motion preference is read once. Every impact cue in here has a static
 * fallback, so honouring it is a matter of shortening or skipping WAAPI work
 * rather than removing the information.
 */
const REDUCED = typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Markup — built once, never re-parsed. No innerHTML ever runs after boot.
// ---------------------------------------------------------------------------

function pipMarkup(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += '<i class="pip"></i>';
  return s;
}

/**
 * One player plate.
 *
 * Bar stacking order is load-bearing: the segment ticks sit *under* the fill,
 * so the spent part of the track is textured and the remaining part is a solid
 * block of colour. That single hard edge is what makes the bar readable at the
 * edge of vision, which is the only way a fighting HUD is ever read.
 */
function plateMarkup(side) {
  const tag = side === 'l' ? 'P1' : 'P2';
  return `
  <div class="hud__plate hud__plate--${side}">
    <div class="plate__edge"></div>
    <div class="plate__portrait">
      <span class="portrait__glyph">R</span>
      <span class="portrait__tag">${tag}</span>
      <span class="portrait__scan"></span>
    </div>
    <div class="plate__main">
      <div class="plate__row plate__row--head">
        <span class="plate__name">ROBO</span>
        <span class="plate__class">BALANCED</span>
      </div>
      <div class="plate__bar">
        <div class="bar__track"></div>
        <div class="bar__grid"></div>
        <div class="bar__ghost"></div>
        <div class="bar__fill"></div>
        <div class="bar__lead"></div>
        <div class="bar__flash"></div>
      </div>
      <div class="plate__row plate__row--foot">
        <span class="plate__hp"><b class="hp__now">1000</b><i class="hp__max">/1000</i></span>
        <span class="plate__kana">ロボ</span>
        <span class="plate__pips">${pipMarkup(PIPS)}</span>
      </div>
    </div>
  </div>`;
}

const TEMPLATE = `
<div class="hud__vignette"></div>
<div class="hud__scan"></div>
<div class="hud__scrim"></div>

<div class="hud__top">
  ${plateMarkup('l')}
  <div class="hud__centre">
    <div class="centre__round">
      <b class="round__n">ROUND 1</b><i class="round__k">ラウンド</i>
    </div>
    <div class="centre__clock">
      <span class="clock__v">1:39</span>
      <span class="clock__arc"></span>
    </div>
    <div class="centre__rule"></div>
  </div>
  ${plateMarkup('r')}
</div>

<div class="hud__reticle">
  <i class="ret__dot"></i>
  <i class="ret__ring"></i>
  <i class="ret__charge"></i>
  <b class="ret__b ret__b--n"></b>
  <b class="ret__b ret__b--s"></b>
  <b class="ret__b ret__b--w"></b>
  <b class="ret__b ret__b--e"></b>
</div>

<div class="hud__hitmark"><i></i><i></i><i></i><i></i></div>

<div class="hud__combo">
  <b class="combo__n">2</b>
  <i class="combo__x">HIT</i>
  <i class="combo__l">CHAIN<em>連撃</em></i>
</div>

<div class="hud__gear">
  <div class="gear__charge">
    <div class="charge__head">
      <b class="charge__name">VULCAN</b>
      <i class="charge__kana">バルカン</i>
    </div>
    <div class="charge__bar">
      <div class="charge__fill"></div>
      <div class="charge__grid"></div>
      <div class="charge__tip"></div>
      <div class="charge__flare"></div>
    </div>
    <div class="charge__ready"><b>CHARGE READY</b><i>チャージ完了</i></div>
  </div>

  <div class="gear__cds">
    <div class="cd cd--bomb">
      <div class="cd__dial">
        <i class="dial__sweep"></i>
        <i class="dial__ring"></i>
        <span class="cd__num"></span>
      </div>
      <div class="cd__meta">
        <span class="cd__slot">BOMB</span>
        <b class="cd__name">STANDARD</b>
        <i class="cd__kana">スタンダード</i>
      </div>
    </div>
    <div class="cd cd--pod">
      <div class="cd__dial">
        <i class="dial__sweep"></i>
        <i class="dial__ring"></i>
        <span class="cd__num"></span>
      </div>
      <div class="cd__meta">
        <span class="cd__slot">POD</span>
        <b class="cd__name">STINGER</b>
        <i class="cd__kana">スティンガー</i>
      </div>
    </div>
  </div>

  <div class="gear__mob">
    <div class="mob__row"><span class="mob__l">JUMP</span><span class="mob__pips mob__pips--jump"></span></div>
    <div class="mob__row"><span class="mob__l">DASH</span><span class="mob__pips mob__pips--dash"></span></div>
  </div>
</div>

<div class="hud__dmg"></div>

<div class="hud__banner">
  <div class="banner__slab"></div>
  <div class="banner__bars"><i></i><i></i><i></i></div>
  <div class="banner__wrap">
    <div class="banner__main" data-text=""></div>
    <div class="banner__sub"></div>
  </div>
</div>

<div class="hud__net">
  <div class="net__title">NETCODE<i>ネットコード</i></div>
  <div class="net__grid">
    <span class="net__k">PING</span><span class="net__v net__v--ping">--</span>
    <span class="net__k">ROLLBACK</span><span class="net__v net__v--rb">0</span>
    <span class="net__k">MAX DEPTH</span><span class="net__v net__v--max">0</span>
    <span class="net__k">AHEAD</span><span class="net__v net__v--ahead">0</span>
    <span class="net__k">STALLS</span><span class="net__v net__v--stall">0</span>
  </div>
  <div class="net__warn">DESYNC DETECTED<i>同期エラー</i></div>
</div>

<div class="hud__debug"></div>
`;

// ---------------------------------------------------------------------------

const _proj = new THREE.Vector3();

/** Cheap 0xRRGGBB -> "#rrggbb". Called on loadout change only. */
const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------

export class HUD {
  constructor(root) {
    this.root = root;

    const el = document.createElement('div');
    el.className = 'crv2-ui crv2-hud';
    el.innerHTML = TEMPLATE;
    root.appendChild(el);
    this.el = el;

    const q = (sel, ctx = el) => ctx.querySelector(sel);

    // ---- plates ----------------------------------------------------------
    this.plates = Array.from(el.querySelectorAll('.hud__plate')).map((p, i) => ({
      el: p,
      flash: q('.bar__flash', p),
      edge: q('.plate__edge', p),
      glyph: q('.portrait__glyph', p),
      tag: q('.portrait__tag', p),
      name: q('.plate__name', p),
      cls: q('.plate__class', p),
      kana: q('.plate__kana', p),
      hpNow: q('.hp__now', p),
      hpMax: q('.hp__max', p),
      pips: Array.from(p.querySelectorAll('.pip')),
      // Cached values — the whole point of this object.
      s: {
        bodyId: '', name: '', hp: -1, maxHp: -1, shownHp: 0, frac: -1,
        wins: -1, low: null, down: null, dead: null, local: null,
      },
      flashAnim: null,
      edgeAnim: null,
      index: i,
    }));

    // ---- centre ----------------------------------------------------------
    this.roundEl = q('.round__n');
    this.clockEl = q('.clock__v');
    this.clockWrap = q('.centre__clock');
    this.centre = q('.hud__centre');

    // ---- local weapon gear ----------------------------------------------
    this.gear = q('.hud__gear');
    this.chargeEl = q('.gear__charge');
    this.chargeName = q('.charge__name');
    this.chargeKana = q('.charge__kana');
    this.cd = {
      bomb: {
        el: q('.cd--bomb'), num: q('.cd--bomb .cd__num'),
        name: q('.cd--bomb .cd__name'), kana: q('.cd--bomb .cd__kana'),
      },
      pod: {
        el: q('.cd--pod'), num: q('.cd--pod .cd__num'),
        name: q('.cd--pod .cd__name'), kana: q('.cd--pod .cd__kana'),
      },
    };
    this.mobJump = q('.mob__pips--jump');
    this.mobDash = q('.mob__pips--dash');

    // ---- feedback --------------------------------------------------------
    this.reticle = q('.hud__reticle');
    this.hitmark = q('.hud__hitmark');
    this.comboEl = q('.hud__combo');
    this.comboNum = q('.combo__n');
    this.dmgLayer = q('.hud__dmg');

    // ---- banner ----------------------------------------------------------
    this.banner = q('.hud__banner');
    this.bannerMain = q('.banner__main');
    this.bannerSub = q('.banner__sub');
    this._bannerFlip = false;

    // ---- overlays --------------------------------------------------------
    this.net = q('.hud__net');
    this.netV = {
      ping: q('.net__v--ping'), rb: q('.net__v--rb'), max: q('.net__v--max'),
      ahead: q('.net__v--ahead'), stall: q('.net__v--stall'),
    };
    this.debugEl = q('.hud__debug');

    // ---- frame-loop caches ----------------------------------------------
    this._s = {
      round: -1, seconds: -1, urgent: null, timeFrac: -1,
      charge: -1, ready: null, gunId: '', bombId: '', podId: '', legsId: '',
      bombCd: -1, podCd: -1, bombNum: -1, podNum: -1,
      jumps: -1, dashes: -1, jumpMax: -1, dashMax: -1,
      combo: 0, phase: -1, localIndex: -1, lowHp: null, netKey: '', debug: null,
      gearKey: '',
    };

    // ---- damage-number pool ---------------------------------------------
    this._dmgPool = [];
    this._dmgLive = [];
    for (let i = 0; i < DMG_POOL; i++) {
      const outer = document.createElement('div');
      outer.className = 'dmg';
      const inner = document.createElement('span');
      inner.className = 'dmg__t';
      outer.appendChild(inner);
      this.dmgLayer.appendChild(outer);
      this._dmgPool.push({ outer, inner, anim: null, live: false, x: 0, y: 0, z: 0, jx: 0, jy: 0, until: 0 });
    }

    // Viewport size is cached, not measured per frame.
    this._w = window.innerWidth;
    this._h = window.innerHeight;
    this._onResize = () => { this._w = window.innerWidth; this._h = window.innerHeight; };
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });

    this._hitAnim = null;
    this._comboAnim = null;
    this._visible = true;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * @param {object} world  the sim World
   * @param {object} ctx    {camera, alpha, names, localIndex, time}
   */
  update(world, ctx = {}) {
    if (!this._visible) return;

    const s = this._s;
    const local = ctx.localIndex ?? 0;
    if (local !== s.localIndex) {
      s.localIndex = local;
      this.el.classList.toggle('is-p2', local === 1);
    }

    // ---- player plates ---------------------------------------------------
    for (let i = 0; i < 2; i++) {
      this._updatePlate(this.plates[i], world.robos[i], world.loadouts[i],
        ctx.names?.[i], world.wins[i], i === local);
    }

    // ---- round + clock ---------------------------------------------------
    if (world.round !== s.round) {
      s.round = world.round;
      this.roundEl.textContent = `ROUND ${world.round}`;
    }

    const secs = Math.max(0, Math.ceil(world.roundTimer / TICK_RATE));
    if (secs !== s.seconds) {
      s.seconds = secs;
      const m = (secs / 60) | 0;
      const ss = secs % 60;
      this.clockEl.textContent = `${m}:${ss < 10 ? '0' : ''}${ss}`;
      const urgent = secs <= URGENT_SECONDS && world.phase === PHASE.FIGHT;
      if (urgent !== s.urgent) {
        s.urgent = urgent;
        this.clockWrap.classList.toggle('is-urgent', urgent);
      }
    }
    // The arc under the clock is a paint-only conic gradient.
    const tf = clamp01(world.roundTimer / MATCH.roundTimeTicks);
    if (Math.abs(tf - s.timeFrac) > 0.002) {
      s.timeFrac = tf;
      this.centre.style.setProperty('--tf', tf.toFixed(3));
    }

    if (world.phase !== s.phase) {
      s.phase = world.phase;
      this.el.classList.toggle('is-fight', world.phase === PHASE.FIGHT);
      // `is-over` hides the reticle; `is-fight` no longer reveals it. Aiming
      // furniture defaults to on and is taken away at the end of a round —
      // see the note on .hud__reticle. Anything that stops this method being
      // called then leaves the crosshair up rather than deleting it.
      this.el.classList.toggle(
        'is-over',
        world.phase === PHASE.ROUND_END || world.phase === PHASE.MATCH_END,
      );
    }

    // ---- local loadout gear ---------------------------------------------
    this._updateGear(world, local);

    // ---- combo (hits the local player has landed = victim's chain) -------
    const victim = world.robos[1 - local];
    const chain = victim.recentDmgTimer > 0 ? victim.comboHits : 0;
    if (chain !== s.combo) {
      const grew = chain > s.combo;
      s.combo = chain;
      if (chain >= 2) {
        this.comboNum.textContent = String(chain);
        this.comboEl.classList.add('is-on');
        if (grew) this._punch(this.comboEl, this._comboAnim, (a) => { this._comboAnim = a; });
      } else {
        this.comboEl.classList.remove('is-on');
      }
    }

    // ---- floating damage numbers ----------------------------------------
    if (this._dmgLive.length) this._updateDamageNumbers(ctx.camera);
  }

  _updatePlate(p, r, ld, name, wins, isLocal) {
    const s = p.s;

    // Loadout identity changes are rare — do the expensive writes only then.
    const body = ld.body;
    if (body.id !== s.bodyId) {
      s.bodyId = body.id;
      p.cls.textContent = body.class.toUpperCase();
      p.kana.textContent = body.kana;
      p.glyph.textContent = body.name.charAt(0);
      // The machine's own colours dress the portrait only. The bar and the
      // pips stay on the fixed side colours (P1 blue / P2 red) so that "how
      // much is left" is never confused with "which robo is that" — a bright
      // body palette must not read as a fuller bar.
      const look = body.look;
      p.el.style.setProperty('--body', hex(look.primary));
      p.el.style.setProperty('--body-hot', hex(look.emissive));
      p.el.style.setProperty('--body-acc', hex(look.accent));
    }

    const label = (name || body.name).toUpperCase();
    if (label !== s.name) {
      s.name = label;
      p.name.textContent = label;
    }

    if (isLocal !== s.local) {
      s.local = isLocal;
      p.el.classList.toggle('is-local', isLocal);
    }

    // ---- HP --------------------------------------------------------------
    if (r.maxHp !== s.maxHp) {
      s.maxHp = r.maxHp;
      p.hpMax.textContent = `/${r.maxHp}`;
    }

    if (r.hp !== s.hp) {
      // First sight of this plate: adopt the value outright. Easing from the
      // initial 0 made the numeral count up from zero while the bar was already
      // correct, so bar and readout disagreed for the first ~10 frames of every
      // round — and disagreed in every screenshot taken during them.
      const first = s.hp === -1;
      const healed = r.hp > s.hp;
      s.hp = r.hp;
      if (first) s.shownHp = r.hp;
      const frac = r.maxHp > 0 ? r.hp / r.maxHp : 0;
      s.frac = frac;
      p.el.style.setProperty('--hp', frac.toFixed(4));

      // A round reset must not play the chip-damage drain backwards, so the
      // ghost bar is snapped (transition suppressed) for a couple of frames.
      if (healed) {
        p.el.classList.add('is-snap');
        p.snapFrames = 3;
      } else {
        this._punchFlash(p);
      }

      const low = frac <= LOW_HP && r.hp > 0;
      if (low !== s.low) {
        s.low = low;
        p.el.classList.toggle('is-low', low);
        if (s.local) {
          this.el.classList.toggle('is-lowhp', low);
        }
      }
    }
    if (p.snapFrames > 0 && --p.snapFrames === 0) p.el.classList.remove('is-snap');

    // Numeric HP eases toward the real value: reads as a mechanical counter
    // spinning down rather than a number teleporting.
    const shown = s.shownHp + (r.hp - s.shownHp) * 0.22;
    const rounded = Math.abs(shown - r.hp) < 1 ? r.hp : Math.round(shown);
    s.shownHp = Math.abs(shown - r.hp) < 1 ? r.hp : shown;
    if (rounded !== p._lastShown) {
      p._lastShown = rounded;
      p.hpNow.textContent = String(rounded);
    }

    // ---- round pips ------------------------------------------------------
    if (wins !== s.wins) {
      s.wins = wins;
      for (let i = 0; i < p.pips.length; i++) {
        p.pips[i].classList.toggle('is-on', i < wins);
      }
    }

    // ---- state -----------------------------------------------------------
    const down = r.state === STATE.DOWN;
    if (down !== s.down) { s.down = down; p.el.classList.toggle('is-down', down); }
    const dead = r.state === STATE.DEAD || r.hp <= 0;
    if (dead !== s.dead) { s.dead = dead; p.el.classList.toggle('is-dead', dead); }
  }

  _updateGear(world, local) {
    const s = this._s;
    const r = world.robos[local];
    const ld = world.loadouts[local];

    // ---- charge ----------------------------------------------------------
    if (ld.gun.id !== s.gunId) {
      s.gunId = ld.gun.id;
      this.chargeName.textContent = ld.gun.name;
      this.chargeKana.textContent = ld.gun.kana;
    }
    const cFrac = r.chargeReady ? 1 : clamp01(r.charge / Math.max(1, ld.gun.chargeTicks));
    if (Math.abs(cFrac - s.charge) > 0.004 || (cFrac === 0 && s.charge !== 0)) {
      s.charge = cFrac;
      this.el.style.setProperty('--charge', cFrac.toFixed(3));
    }
    const ready = !!r.chargeReady;
    if (ready !== s.ready) {
      s.ready = ready;
      this.chargeEl.classList.toggle('is-ready', ready);
      this.reticle.classList.toggle('is-ready', ready);
    }

    // ---- bomb / pod cooldown dials --------------------------------------
    this._updateCd(this.cd.bomb, r.bombCd, ld.bomb, 'bomb');
    this._updateCd(this.cd.pod, r.podCd, ld.pod, 'pod');

    // The same three quantities, republished for the touch layer, which draws
    // them on the buttons the thumb is already on. See _publishGear.
    this._publishGear(cFrac, ready, s.bombCd, r.bombCd <= 0, s.podCd, r.podCd <= 0);

    // ---- mobility pips ---------------------------------------------------
    const legs = ld.legs;
    if (legs.id !== s.legsId) {
      s.legsId = legs.id;
      this._buildPips(this.mobJump, legs.jumps);
      this._buildPips(this.mobDash, legs.airDashes);
      s.jumpMax = legs.jumps;
      s.dashMax = legs.airDashes;
      s.jumps = -1;
      s.dashes = -1;
    }
    if (r.jumpsLeft !== s.jumps) {
      s.jumps = r.jumpsLeft;
      const kids = this.mobJump.children;
      for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('is-on', i < r.jumpsLeft);
    }
    if (r.airDashesLeft !== s.dashes) {
      s.dashes = r.airDashesLeft;
      const kids = this.mobDash.children;
      for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('is-on', i < r.airDashesLeft);
    }
  }

  /**
   * Republish charge and the two cooldowns on `crv2:gear`, the same window
   * channel `crv2:hud` already uses to talk to the touch layer.
   *
   * On a phone the BOMB and POD cooldowns were drawn twice — as ring gauges in
   * the top-left column and as buttons in the thumb cluster — and only the
   * copy the player is NOT looking at carried the state. Their buttons have had
   * a `.tb__ring` in the markup all along; nothing ever fed it, and neither did
   * anything feed FIRE's, because `setCharge()` has no caller in the build. So
   * the ring furniture was dead on all three.
   *
   * Quantised to 1/32 before comparing: a draining dial changes every frame and
   * a 62px ring cannot show a thirty-second of a turn, so this dispatches on
   * the order of once every few frames instead of sixty times a second.
   */
  _publishGear(charge, chargeReady, bomb, bombReady, pod, podReady) {
    const q = (v) => Math.round(clamp01(v) * 32);
    const key = `${q(charge)}${chargeReady ? 'R' : ''}|${q(bomb)}${bombReady ? 'R' : ''}|${q(pod)}${podReady ? 'R' : ''}`;
    if (key === this._s.gearKey) return;
    this._s.gearKey = key;
    window.dispatchEvent(new CustomEvent('crv2:gear', {
      detail: {
        fire: clamp01(charge), fireReady: !!chargeReady,
        bomb: clamp01(bomb), bombReady: !!bombReady,
        pod: clamp01(pod), podReady: !!podReady,
      },
    }));
  }

  _updateCd(slot, cd, part, key) {
    const s = this._s;
    const idKey = key + 'Id';
    if (part.id !== s[idKey]) {
      s[idKey] = part.id;
      slot.name.textContent = part.name;
      slot.kana.textContent = part.kana;
    }
    const max = Math.max(1, part.cooldown);
    const frac = clamp01(1 - cd / max);
    const cdKey = key + 'Cd';
    if (Math.abs(frac - s[cdKey]) > 0.004) {
      s[cdKey] = frac;
      slot.el.style.setProperty('--cd', frac.toFixed(3));
      slot.el.classList.toggle('is-ready', cd <= 0);
    }
    // Seconds remaining, written at most once per second.
    const numKey = key + 'Num';
    const secs = cd > 0 ? Math.ceil(cd / TICK_RATE) : 0;
    if (secs !== s[numKey]) {
      s[numKey] = secs;
      slot.num.textContent = secs > 0 ? String(secs) : '';
    }
  }

  _buildPips(host, n) {
    host.textContent = '';
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      p.className = 'mpip';
      host.appendChild(p);
    }
  }

  // -------------------------------------------------------------------------
  // Banners
  // -------------------------------------------------------------------------

  /**
   * @param {string} main  e.g. 'ROUND 1'
   * @param {string} sub   e.g. 'FIGHT'
   * @param {object} opts  {style:'fight'|'ko'|'win'|'lose'|'draw'|'timeup', kana}
   */
  showBanner(main, sub, opts = {}) {
    const b = this.banner;
    this.bannerMain.textContent = main || '';
    // The chromatic-offset ghosts are ::before/::after reading attr(data-text).
    this.bannerMain.setAttribute('data-text', main || '');
    this.bannerSub.textContent = sub || '';
    this.bannerSub.classList.toggle('is-empty', !sub);

    for (const st of BANNER_STYLES) b.classList.toggle(`is-${st}`, opts.style === st);

    // Restarting a CSS animation normally needs a forced reflow; alternating
    // between two identical animation classes restarts it without one.
    this._bannerFlip = !this._bannerFlip;
    b.classList.remove('anim-a', 'anim-b');
    b.classList.add(this._bannerFlip ? 'anim-a' : 'anim-b');
    b.classList.add('is-on');
  }

  hideBanner() {
    this.banner.classList.remove('is-on');
  }

  // -------------------------------------------------------------------------
  // Floating damage numbers
  // -------------------------------------------------------------------------

  /**
   * @param {{x:number,y:number,z:number}} worldPos
   * @param {number} amount
   * @param {object} opts {crit, heavy, targetIndex}
   */
  damageNumber(worldPos, amount, opts = {}) {
    const n = Math.round(amount);
    if (!(n > 0)) return;

    let d = this._dmgPool.pop();
    if (!d) {
      // Pool exhausted: steal the oldest live one rather than allocating.
      d = this._dmgLive.shift();
      if (!d) return;
      if (d.anim) d.anim.cancel();
    }

    const big = !!(opts.crit || opts.heavy);
    d.inner.textContent = String(n);
    // Damage *you* took is red; damage you dealt is white/amber. Same glyphs,
    // opposite meaning — the colour has to carry it.
    d.inner.className = 'dmg__t' +
      (opts.crit ? ' is-crit' : '') +
      (opts.heavy ? ' is-heavy' : '') +
      (opts.targetIndex === this._s.localIndex ? ' is-self' : ' is-foe');

    d.x = worldPos.x; d.y = worldPos.y; d.z = worldPos.z;
    // A little screen-space scatter so a burst of hits doesn't stack into mush.
    d.jx = (Math.random() - 0.5) * 46;
    d.jy = (Math.random() - 0.5) * 22;
    d.live = true;

    const life = (big ? DMG_LIFE_BIG : DMG_LIFE) * (REDUCED ? 0.7 : 1);
    d.until = performance.now() + life;
    d.outer.style.opacity = '1';

    if (d.anim) d.anim.cancel();
    d.anim = d.inner.animate([
      { transform: 'translate(-50%,-50%) scale(.45)', opacity: 0 },
      { transform: `translate(-50%,-76%) scale(${big ? 1.5 : 1.28})`, opacity: 1, offset: 0.14 },
      { transform: `translate(-50%,-104%) scale(${big ? 1.14 : 1})`, opacity: 1, offset: 0.38 },
      { transform: `translate(-50%,-190%) scale(${big ? 1.0 : 0.9})`, opacity: 0 },
    ], { duration: life, easing: 'cubic-bezier(.16,.9,.3,1)', fill: 'forwards' });

    this._dmgLive.push(d);
  }

  _updateDamageNumbers(camera) {
    const now = performance.now();
    const w = this._w, h = this._h;
    const live = this._dmgLive;

    for (let i = live.length - 1; i >= 0; i--) {
      const d = live[i];
      if (now >= d.until) {
        d.live = false;
        d.outer.style.opacity = '0';
        live.splice(i, 1);
        this._dmgPool.push(d);
        continue;
      }
      if (!camera) continue;

      // Re-projected every frame so the number stays pinned to the world point
      // while the camera swings; the rise/fade lives on the inner element.
      _proj.set(d.x, d.y, d.z).project(camera);
      if (_proj.z > 1) {
        d.outer.style.opacity = '0';
        continue;
      }
      const sx = (_proj.x * 0.5 + 0.5) * w + d.jx;
      const sy = (-_proj.y * 0.5 + 0.5) * h + d.jy;
      d.outer.style.opacity = '1';
      d.outer.style.transform = `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0)`;
    }
  }

  // -------------------------------------------------------------------------
  // Hit feedback
  // -------------------------------------------------------------------------

  /** @param {object} opts {heavy, kill, crit} */
  hitMarker(opts = {}) {
    const m = this.hitmark;
    m.classList.toggle('is-heavy', !!(opts.heavy || opts.crit));
    m.classList.toggle('is-kill', !!opts.kill);
    if (this._hitAnim) this._hitAnim.cancel();
    const big = opts.heavy || opts.crit || opts.kill;
    this._hitAnim = m.animate([
      { transform: 'translate(-50%,-50%) scale(.55) rotate(0deg)', opacity: 1 },
      { transform: `translate(-50%,-50%) scale(${big ? 1.5 : 1.15}) rotate(${big ? 45 : 0}deg)`, opacity: 1, offset: 0.28 },
      { transform: `translate(-50%,-50%) scale(${big ? 1.75 : 1.3}) rotate(${big ? 45 : 0}deg)`, opacity: 0 },
    ], { duration: big ? 420 : 260, easing: 'cubic-bezier(.2,.8,.3,1)' });
  }

  /**
   * Damage feedback on a plate.
   *
   * It flashes the *bar* and strokes the plate edge — never the plate fill.
   * A hit is exactly the moment the player needs to read the name, the class
   * and the remaining HP, so nothing is allowed to paint over the readout.
   */
  _punchFlash(p) {
    if (p.flashAnim) p.flashAnim.cancel();
    p.flashAnim = p.flash.animate(
      [{ opacity: 0.85 }, { opacity: 0 }],
      { duration: REDUCED ? 120 : 260, easing: 'ease-out' },
    );
    if (p.edgeAnim) p.edgeAnim.cancel();
    p.edgeAnim = p.edge.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: REDUCED ? 140 : 340, easing: 'ease-out' },
    );
  }

  _punch(el, prev, store) {
    if (prev) prev.cancel();
    if (REDUCED) { store(null); return; }
    store(el.animate([
      { transform: 'translate(-50%,0) scale(1.34)' },
      { transform: 'translate(-50%,0) scale(1)' },
    ], { duration: 220, easing: 'cubic-bezier(.2,1.5,.4,1)' }));
  }

  // -------------------------------------------------------------------------
  // Overlays
  // -------------------------------------------------------------------------

  /** @param {object|null} stats session.stats, or null to hide. */
  setNetStats(stats) {
    if (!stats) {
      if (this._s.netKey !== '') {
        this._s.netKey = '';
        this.net.classList.remove('is-on');
      }
      return;
    }
    const ping = Math.round(stats.rttMs || 0);
    const key = `${ping}|${stats.rollbacks}|${stats.maxRollback}|${stats.remoteAhead}|${stats.stalls}|${stats.desync ? 1 : 0}`;
    if (key === this._s.netKey) return;
    this._s.netKey = key;

    this.net.classList.add('is-on');
    this.netV.ping.textContent = ping ? `${ping} ms` : '--';
    this.netV.rb.textContent = String(stats.rollbacks | 0);
    this.netV.max.textContent = String(stats.maxRollback | 0);
    this.netV.ahead.textContent = String(stats.remoteAhead | 0);
    this.netV.stall.textContent = String(stats.stalls | 0);
    this.net.classList.toggle('is-bad', ping > 120 || (stats.maxRollback | 0) > 8);
    this.net.classList.toggle('is-desync', !!stats.desync);
  }

  /** @param {string|null} text small perf readout, top-left. */
  setDebug(text) {
    if (text === this._s.debug) return;
    this._s.debug = text;
    if (text == null || text === '') {
      this.debugEl.classList.remove('is-on');
      this.debugEl.textContent = '';
      return;
    }
    this.debugEl.classList.add('is-on');
    this.debugEl.textContent = text;
  }

  setVisible(v) {
    this._visible = !!v;
    this.el.classList.toggle('is-hidden', !v);
    // The touch layer is a sibling, not a child, so it cannot read this. It
    // needs to know because a thumb cluster over the title screen is worse
    // than no thumb cluster at all.
    window.dispatchEvent(new CustomEvent('crv2:hud', { detail: { visible: this._visible } }));
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    for (const d of this._dmgLive) if (d.anim) d.anim.cancel();
    for (const d of this._dmgPool) if (d.anim) d.anim.cancel();
    if (this._hitAnim) this._hitAnim.cancel();
    if (this._comboAnim) this._comboAnim.cancel();
    for (const p of this.plates) {
      if (p.flashAnim) p.flashAnim.cancel();
      if (p.edgeAnim) p.edgeAnim.cancel();
    }
    this._dmgLive.length = 0;
    this._dmgPool.length = 0;
    this.el.remove();
  }
}

export default HUD;
