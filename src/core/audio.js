/**
 * Procedural audio.
 *
 * No audio files ship with the game — every sound is synthesised at runtime.
 * That keeps the download tiny and lets each weapon carry its own voice built
 * from layers, the way a real gunshot is transient + body + tail.
 *
 * Two things keep it stable during a firefight:
 *   - a hard polyphony cap with oldest-voice stealing
 *   - per-sound rate limiting, so three simultaneous hits play one louder hit
 *     instead of three phase-cancelling copies
 *
 * Everything degrades to silence rather than throwing: audio must never take
 * the frame loop down with it.
 */

const MAX_VOICES = 24;
const LOOKAHEAD = 0.12;      // seconds of music scheduled ahead of the clock

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Musical helper: MIDI note -> Hz. */
const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);

// ---------------------------------------------------------------------------
// Track definitions. Scale degrees over a root, plus per-arena voicing.
// ---------------------------------------------------------------------------

const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];

const TRACKS = {
  menu: {
    bpm: 96, root: 45, scale: MINOR, wave: 'triangle',
    bass: [0, 0, 5, 5, 3, 3, 5, 7],
    arp: [0, 4, 7, 11, 7, 4],
    drums: 0.25, cutoff: 900, drive: 0.1, pad: 0.5,
  },
  grid: {
    bpm: 148, root: 40, scale: MINOR, wave: 'sawtooth',
    bass: [0, 0, 7, 0, 5, 5, 3, 7],
    arp: [0, 7, 12, 7, 15, 12, 7, 3],
    drums: 1, cutoff: 1500, drive: 0.32, pad: 0.28,
  },
  foundry: {
    bpm: 132, root: 38, scale: PHRYGIAN, wave: 'sawtooth',
    bass: [0, 0, 1, 0, 5, 3, 1, 0],
    arp: [0, 3, 7, 8, 7, 3],
    drums: 1, cutoff: 1100, drive: 0.55, pad: 0.34,
  },
  orbital: {
    bpm: 120, root: 47, scale: MINOR, wave: 'triangle',
    bass: [0, 7, 5, 3, 0, 7, 10, 12],
    arp: [0, 5, 7, 12, 14, 12, 7, 5],
    drums: 0.6, cutoff: 1800, drive: 0.12, pad: 0.75,
  },
};

// ---------------------------------------------------------------------------

export class AudioEngine {
  constructor(opts = {}) {
    this.ctx = null;
    this._ready = false;
    this._failed = false;
    this.muted = false;
    this.vol = { master: 0.85, sfx: 0.9, music: 0.55 };

    this.listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0, fx: 0, fz: 1 };

    this._voices = [];          // {node, end, priority}
    this._lastPlay = new Map(); // rate limiting per sound key
    this._loops = [];           // continuous voices, rebuilt on unlock

    this.music = { track: null, next: 0, step: 0, cfg: null, tension: 0, gainTarget: 1 };
    this._noise = null;
    this._pinkNoise = null;
  }

  get ready() { return this._ready; }

  // -------------------------------------------------------------------------

  async unlock() {
    if (this._ready || this._failed) return this._ready;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { this._failed = true; return false; }
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      this._buildGraph();
      this._buildBuffers();
      this._buildLoops();
      this._ready = true;
      return true;
    } catch {
      this._failed = true;
      return false;
    }
  }

  _buildGraph() {
    const ctx = this.ctx;

    // Master bus: a limiter-ish compressor keeps a dogpile of explosions from
    // clipping, and gives the mix its punch.
    this.master = ctx.createGain();
    this.master.gain.value = this.vol.master;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 9;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.vol.sfx;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.vol.music;

    // Music ducks under loud SFX so explosions read as loud without turning
    // the master up.
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;

    // Shared reverb send, fed by a procedurally generated impulse.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(2.1, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.34;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.55;

    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.duck);
    this.duck.connect(this.master);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
  }

  _makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Noise under an exponential envelope, with early reflections carved in
        // so it sounds like a hard-walled arena rather than a hall.
        const early = (i < rate * 0.09 && Math.random() < 0.006) ? 3.5 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * early;
      }
    }
    return buf;
  }

  _buildBuffers() {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;

    // White noise, one second, looped by every noise-based voice.
    const wn = ctx.createBuffer(1, rate, rate);
    const wd = wn.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    this._noise = wn;

    // Pink-ish noise for smoother bodies (Voss-McCartney, 5 rows).
    const pn = ctx.createBuffer(1, rate, rate);
    const pd = pn.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0;
    for (let i = 0; i < pd.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + w * 0.5362) * 0.16;
    }
    this._pinkNoise = pn;

    // Soft-clip curve for the industrial/drive voices.
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.4);
    }
    this._driveCurve = curve;
  }

  // -------------------------------------------------------------------------
  // Voice plumbing
  // -------------------------------------------------------------------------

  /** Reserve a voice slot, stealing the oldest if we're at the cap. */
  _claim(priority, endTime) {
    const now = this.ctx.currentTime;
    for (let i = this._voices.length - 1; i >= 0; i--) {
      if (this._voices[i].end <= now) this._voices.splice(i, 1);
    }
    if (this._voices.length >= MAX_VOICES) {
      let worst = -1, worstScore = Infinity;
      for (let i = 0; i < this._voices.length; i++) {
        const s = this._voices[i].priority;
        if (s < worstScore) { worstScore = s; worst = i; }
      }
      if (worst < 0 || worstScore >= priority) return false;
      const v = this._voices[worst];
      try { v.stop?.(); } catch { /* already ended */ }
      this._voices.splice(worst, 1);
    }
    this._voices.push({ priority, end: endTime });
    return true;
  }

  /**
   * Rate limit a sound key. Returns a gain multiplier: 0 means "skip", >1 means
   * "this stands in for several collapsed hits".
   */
  _rate(key, windowMs, boostCap = 1.5) {
    const now = performance.now();
    const last = this._lastPlay.get(key);
    if (last && now - last.t < windowMs) {
      last.n++;
      return 0;
    }
    const prevN = last ? last.n : 0;
    this._lastPlay.set(key, { t: now, n: 0 });
    return prevN > 0 ? Math.min(boostCap, 1 + prevN * 0.18) : 1;
  }

  /** Distance/pan/air-absorption chain for a world-space source. */
  _spatial(x, y, z, maxDist = 44) {
    const ctx = this.ctx;
    const dx = x - this.listener.x;
    const dy = y - this.listener.y;
    const dz = z - this.listener.z;
    const dist = Math.hypot(dx, dy, dz);

    const gain = ctx.createGain();
    gain.gain.value = clamp(1 - dist / maxDist, 0, 1) ** 1.6;

    // Equal-power pan from the listener's right vector — far cheaper than HRTF
    // and indistinguishable in a game mix on phone speakers or earbuds.
    const pan = ctx.createStereoPanner
      ? ctx.createStereoPanner()
      : null;
    if (pan) {
      const right = (dx * this.listener.rx + dz * this.listener.rz) / Math.max(1, dist);
      pan.pan.value = clamp(right, -1, 1) * 0.85;
    }

    // Air absorption: distant sounds lose their top end.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(20000 - dist * 380, 900, 20000);

    const out = pan || lp;
    if (pan) { gain.connect(pan); pan.connect(lp); } else { gain.connect(lp); }
    lp.connect(this.sfxBus);

    // Reverb send rises with distance — that's the cue that sells the space.
    const send = ctx.createGain();
    send.gain.value = clamp(dist / maxDist, 0.05, 1) * 0.5;
    lp.connect(send);
    send.connect(this.reverbSend);

    return { input: gain, dist };
  }

  _noiseSource(pink = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = pink ? this._pinkNoise : this._noise;
    s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    return s;
  }

  /** One-shot noise burst through a filter — the workhorse of this engine. */
  _burst(dest, t, { dur = 0.12, type = 'bandpass', f0 = 1800, f1 = 400, q = 1.4, gain = 1, pink = false, attack = 0.002 }) {
    const ctx = this.ctx;
    const src = this._noiseSource(pink);
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(dest);
    src.start(t);
    src.stop(t + dur + 0.02);
    src.onended = () => { try { g.disconnect(); filt.disconnect(); } catch { /* gone */ } };
    return g;
  }

  /** Pitched tone with an exponential sweep — bodies, whines, stingers. */
  _tone(dest, t, { dur = 0.2, wave = 'sine', f0 = 220, f1 = 110, gain = 0.4, attack = 0.004, detune = 0 }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = wave;
    o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
    o.onended = () => { try { g.disconnect(); } catch { /* gone */ } };
    return g;
  }

  // -------------------------------------------------------------------------
  // Continuous voices
  // -------------------------------------------------------------------------

  _buildLoops() {
    const ctx = this.ctx;
    this._loops = [];

    // Two thruster loops, one per robo.
    for (let i = 0; i < 2; i++) {
      const src = this._noiseSource(true);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 400;
      lp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(lp); lp.connect(g); g.connect(this.sfxBus);
      src.start();
      this._loops.push({ kind: 'thruster', src, lp, g });
    }

    // Charge whine for the local player.
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 180;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 8;
    const cg = ctx.createGain();
    cg.gain.value = 0;
    o.connect(bp); bp.connect(cg); cg.connect(this.sfxBus);
    o.start();
    this._charge = { o, bp, g: cg };

    // Low-HP alarm.
    const ao = ctx.createOscillator();
    ao.type = 'square';
    ao.frequency.value = 660;
    const ag = ctx.createGain();
    ag.gain.value = 0;
    const alp = ctx.createBiquadFilter();
    alp.type = 'lowpass';
    alp.frequency.value = 1400;
    ao.connect(alp); alp.connect(ag); ag.connect(this.sfxBus);
    ao.start();
    this._alarm = { o: ao, g: ag };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  setListener(camera) {
    if (!camera) return;
    const m = camera.matrixWorld.elements;
    this.listener.x = m[12];
    this.listener.y = m[13];
    this.listener.z = m[14];
    // Column 0 is the camera's right vector, column 2 its backward vector.
    this.listener.rx = m[0];
    this.listener.rz = m[2];
    this.listener.fx = -m[8];
    this.listener.fz = -m[10];
  }

  setVolume({ master, sfx, music }) {
    if (master !== undefined) this.vol.master = master;
    if (sfx !== undefined) this.vol.sfx = sfx;
    if (music !== undefined) this.vol.music = music;
    if (!this._ready) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol.master, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.vol.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.vol.music, t, 0.05);
  }

  setMuted(v) {
    this.muted = !!v;
    if (this._ready) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol.master, this.ctx.currentTime, 0.03);
    }
  }

  suspend() { if (this._ready && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }
  resume() { if (this._ready && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

  // -------------------------------------------------------------------------

  handleEvents(events, world, localIndex) {
    if (!this._ready || this.muted) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      try {
        this._event(ev, world, localIndex, t);
      } catch { /* one bad sound must never stall the frame */ }
    }
  }

  _event(ev, world, localIndex, t) {
    // Event type constants are duplicated as numbers here rather than imported,
    // so this module stays dependency-free and safe to load standalone.
    switch (ev.type) {
      case 1: this._gun(ev, t); break;                 // FIRE_GUN
      case 2: this._launch(ev, t, 150, 60); break;     // FIRE_BOMB
      case 3: this._launch(ev, t, 420, 180); break;    // DEPLOY_POD
      case 4: this._hit(ev, t); break;                 // HIT
      case 5: this._explode(ev, t); break;             // EXPLODE
      case 6: this._jump(ev, t); break;                // JUMP
      case 7: this._dash(ev, t); break;                // AIR_DASH
      case 8: this._land(ev, t); break;                // LAND
      case 9: this._down(ev, t); break;                // DOWN
      case 10: this._getUp(ev, t); break;              // GET_UP
      case 11: this._ko(ev, t); break;                 // KO
      case 12: this._chargeReady(ev, t); break;        // CHARGE_READY
      case 14: this._wall(ev, t); break;               // WALL_HIT
      case 15: this._roundStart(ev, t); break;         // ROUND_START
      case 16: this._roundEnd(ev, t); break;           // ROUND_END
      default: break;
    }
  }

  _gun(ev, t) {
    const key = `gun:${ev.gun}:${ev.charged}`;
    const boost = this._rate(key, ev.charged ? 40 : 45);
    if (!boost) return;
    if (!this._claim(ev.charged ? 8 : 3, t + 0.5)) return;

    const s = this._spatial(ev.x, ev.y, ev.z);
    const d = s.input;
    const g = ev.charged ? 0.9 : 0.34;
    const jitter = 1 + (Math.random() - 0.5) * 0.14;

    switch (ev.gun) {
      case 'vulcan':
        // Dry mechanical chatter: click transient + short filtered body.
        this._burst(d, t, { dur: 0.045, type: 'highpass', f0: 3800, f1: 1600, q: 0.9, gain: g * 0.9 * boost });
        this._tone(d, t, { dur: 0.07, wave: 'square', f0: 320 * jitter, f1: 110, gain: g * 0.5 * boost });
        break;
      case 'scatter':
        this._burst(d, t, { dur: 0.2, type: 'bandpass', f0: 2100, f1: 260, q: 0.7, gain: g * 1.5 * boost, pink: true });
        this._tone(d, t, { dur: 0.18, wave: 'sawtooth', f0: 190 * jitter, f1: 52, gain: g * 0.8 * boost });
        break;
      case 'lancer':
        // Rail crack: sharp transient, hard body, long descending tail.
        this._burst(d, t, { dur: 0.05, type: 'highpass', f0: 7000, f1: 2600, q: 0.8, gain: g * 1.5 });
        this._tone(d, t, { dur: 0.42, wave: 'sawtooth', f0: 1500 * jitter, f1: 70, gain: g * 1.1 });
        this._tone(d, t, { dur: 0.55, wave: 'sine', f0: 120, f1: 34, gain: g * 0.9 });
        break;
      case 'seeker':
        this._tone(d, t, { dur: 0.26, wave: 'triangle', f0: 620 * jitter, f1: 1500, gain: g * 0.7 });
        this._burst(d, t, { dur: 0.3, type: 'bandpass', f0: 900, f1: 2400, q: 4, gain: g * 0.4 });
        break;
      case 'tempest':
      default:
        this._tone(d, t, { dur: 0.13, wave: 'square', f0: 900 * jitter, f1: 260, gain: g * 0.6 * boost });
        this._tone(d, t + 0.012, { dur: 0.13, wave: 'sawtooth', f0: 1350 * jitter, f1: 300, gain: g * 0.4 * boost, detune: 14 });
        break;
    }

    if (ev.charged) {
      // Charged shots get their own sub layer, not just more gain.
      this._tone(d, t, { dur: 0.6, wave: 'sine', f0: 90, f1: 28, gain: 0.9 });
      this._burst(d, t, { dur: 0.35, type: 'lowpass', f0: 2200, f1: 200, q: 1, gain: 0.6, pink: true });
    }
  }

  _launch(ev, t, f0, f1) {
    if (!this._rate(`launch:${f0}`, 60)) return;
    if (!this._claim(4, t + 0.4)) return;
    const d = this._spatial(ev.x, ev.y, ev.z).input;
    this._burst(d, t, { dur: 0.18, type: 'bandpass', f0, f1, q: 1.2, gain: 0.4, pink: true });
    this._tone(d, t, { dur: 0.22, wave: 'triangle', f0: f0 * 0.7, f1: f1 * 0.5, gain: 0.3 });
  }

  _hit(ev, t) {
    const surface = !!ev.surface;
    const key = surface ? 'hit:surf' : 'hit:robo';
    const boost = this._rate(key, 28, 1.8);
    if (!boost) return;
    if (!this._claim(surface ? 2 : 6, t + 0.5)) return;

    const d = this._spatial(ev.x, ev.y, ev.z).input;
    const heavy = !!(ev.heavy || ev.charged);

    if (surface) {
      // Duller, keyed off how hard the round was.
      this._burst(d, t, { dur: 0.09, type: 'bandpass', f0: 2600, f1: 700, q: 1.1, gain: 0.28 * boost });
      this._tone(d, t, { dur: 0.1, wave: 'triangle', f0: 260, f1: 90, gain: 0.2 * boost });
      return;
    }

    // Armour clang: pitch rises with combo so chaining reads as rewarding.
    const combo = clamp(ev.combo || 1, 1, 8);
    const pitch = 1 + (combo - 1) * 0.06;
    const dmg = clamp((ev.damage || 30) / 60, 0.4, 2.2);

    this._burst(d, t, { dur: 0.06, type: 'highpass', f0: 6000, f1: 2400, q: 1, gain: 0.4 * boost });
    this._tone(d, t, { dur: 0.16 * dmg, wave: 'square', f0: 780 * pitch, f1: 240 * pitch, gain: 0.34 * dmg * boost });
    this._tone(d, t + 0.006, { dur: 0.22 * dmg, wave: 'triangle', f0: 1180 * pitch, f1: 420, gain: 0.2 * boost, detune: 9 });
    if (heavy) {
      this._tone(d, t, { dur: 0.4, wave: 'sine', f0: 150, f1: 44, gain: 0.7 });
      this._burst(d, t, { dur: 0.25, type: 'lowpass', f0: 1800, f1: 240, q: 0.8, gain: 0.4, pink: true });
    }
  }

  _explode(ev, t) {
    if (!this._rate('explode', 45, 1.3)) return;
    if (!this._claim(10, t + 1.6)) return;
    const r = clamp((ev.radius || 3.4) / 3.4, 0.5, 2.2);
    const s = this._spatial(ev.x, ev.y, ev.z, 60);
    const d = s.input;

    // Sub thump.
    this._tone(d, t, { dur: 0.7 * r, wave: 'sine', f0: 110 * r, f1: 26, gain: 1.1 });
    // Mid body.
    this._burst(d, t, { dur: 0.45 * r, type: 'lowpass', f0: 2600, f1: 180, q: 0.9, gain: 0.9, pink: true });
    // Crackling debris tail.
    this._burst(d, t + 0.06, { dur: 0.9 * r, type: 'bandpass', f0: 3400, f1: 900, q: 0.6, gain: 0.34, attack: 0.05 });

    // Duck the music under it.
    const dg = this.duck.gain;
    dg.cancelScheduledValues(t);
    dg.setValueAtTime(dg.value, t);
    dg.linearRampToValueAtTime(0.42, t + 0.03);
    dg.linearRampToValueAtTime(1, t + 0.7 * r);
  }

  _wall(ev, t) {
    if (ev.soft) return;
    if (!this._rate('wall', 70)) return;
    if (!this._claim(1, t + 0.3)) return;
    const d = this._spatial(ev.x, ev.y, ev.z).input;
    this._burst(d, t, { dur: 0.1, type: 'bandpass', f0: 1400, f1: 380, q: 1.4, gain: 0.22 });
  }

  _jump(ev, t) {
    if (!this._claim(3, t + 0.4)) return;
    const d = this._spatial(ev.x, ev.y, ev.z).input;
    this._burst(d, t, { dur: 0.26, type: 'bandpass', f0: 500, f1: 2600, q: 1.6, gain: ev.air ? 0.42 : 0.3, pink: true });
    this._tone(d, t, { dur: 0.2, wave: 'triangle', f0: 180, f1: 460, gain: 0.22 });
  }

  _dash(ev, t) {
    if (!this._claim(5, t + 0.5)) return;
    const d = this._spatial(ev.x, ev.y, ev.z).input;
    // Doppler-ish sweep: the pitch falls as the robo leaves the listener.
    this._burst(d, t, { dur: 0.3, type: 'bandpass', f0: 3200, f1: 420, q: 2.2, gain: 0.5, pink: true });
    this._tone(d, t, { dur: 0.28, wave: 'sawtooth', f0: 720, f1: 190, gain: 0.28 });
  }

  _land(ev, t) {
    if (!this._rate('land', 50)) return;
    if (!this._claim(ev.hard ? 6 : 2, t + 0.5)) return;
    const d = this._spatial(ev.x, ev.y, ev.z).input;
    const w = clamp((ev.speed || 6) / 14, 0.3, 1.6);
    this._tone(d, t, { dur: 0.22 * w, wave: 'sine', f0: 150 * w, f1: 40, gain: 0.5 * w });
    this._burst(d, t, { dur: 0.14, type: 'lowpass', f0: 1200, f1: 220, q: 0.8, gain: 0.34 * w, pink: true });
    if (ev.hard) {
      this._burst(d, t, { dur: 0.3, type: 'bandpass', f0: 2200, f1: 500, q: 0.9, gain: 0.3 });
    }
  }

  _down(ev, t) {
    if (!this._claim(8, t + 1.0)) return;
    const d = this._spatial(ev.x, ev.y, ev.z).input;
    this._burst(d, t, { dur: 0.5, type: 'lowpass', f0: 2400, f1: 200, q: 0.7, gain: 0.7, pink: true });
    this._tone(d, t, { dur: 0.45, wave: 'square', f0: 300, f1: 60, gain: 0.4 });
    // Sputtering aftermath.
    for (let i = 0; i < 5; i++) {
      this._burst(d, t + 0.2 + i * 0.11 + Math.random() * 0.05, {
        dur: 0.06, type: 'bandpass', f0: 1800 + Math.random() * 1600, f1: 600, q: 3, gain: 0.14,
      });
    }
  }

  _getUp(ev, t) {
    if (!this._claim(3, t + 0.5)) return;
    const d = this._spatial(ev.x, ev.y, ev.z).input;
    this._tone(d, t, { dur: 0.34, wave: 'sawtooth', f0: 240, f1: 900, gain: 0.16 });
    this._burst(d, t, { dur: 0.2, type: 'bandpass', f0: 900, f1: 2200, q: 5, gain: 0.14 });
  }

  _ko(ev, t) {
    if (!this._claim(12, t + 2.5)) return;
    const d = this.sfxBus;
    this._tone(d, t, { dur: 1.6, wave: 'sine', f0: 130, f1: 22, gain: 1.2 });
    this._burst(d, t, { dur: 1.2, type: 'lowpass', f0: 3200, f1: 120, q: 0.8, gain: 0.9, pink: true });
    this._burst(d, t + 0.1, { dur: 1.8, type: 'bandpass', f0: 2600, f1: 700, q: 0.5, gain: 0.34, attack: 0.08 });
    const dg = this.duck.gain;
    dg.cancelScheduledValues(t);
    dg.setValueAtTime(dg.value, t);
    dg.linearRampToValueAtTime(0.25, t + 0.05);
    dg.linearRampToValueAtTime(1, t + 1.6);
  }

  _chargeReady(ev, t) {
    if (!this._claim(6, t + 0.5)) return;
    this._tone(this.sfxBus, t, { dur: 0.22, wave: 'sine', f0: 900, f1: 1800, gain: 0.22 });
    this._tone(this.sfxBus, t + 0.05, { dur: 0.3, wave: 'triangle', f0: 1800, f1: 1800, gain: 0.14 });
  }

  _roundStart(ev, t) {
    if (ev.go) {
      this._tone(this.sfxBus, t, { dur: 0.5, wave: 'square', f0: 660, f1: 880, gain: 0.3 });
      this._tone(this.sfxBus, t, { dur: 0.7, wave: 'sawtooth', f0: 220, f1: 330, gain: 0.2 });
    } else {
      this._tone(this.sfxBus, t, { dur: 0.28, wave: 'sine', f0: 440, f1: 440, gain: 0.22 });
    }
  }

  _roundEnd(ev, t) {
    const win = ev.winner >= 0;
    this._tone(this.sfxBus, t + 0.1, { dur: 0.9, wave: 'sawtooth', f0: win ? 330 : 220, f1: win ? 660 : 110, gain: 0.28 });
  }

  playUI(name) {
    if (!this._ready || this.muted) return;
    const t = this.ctx.currentTime;
    const d = this.sfxBus;
    try {
      switch (name) {
        case 'move': this._tone(d, t, { dur: 0.05, wave: 'square', f0: 1400, f1: 1400, gain: 0.07 }); break;
        case 'confirm':
          this._tone(d, t, { dur: 0.09, wave: 'square', f0: 880, f1: 880, gain: 0.12 });
          this._tone(d, t + 0.06, { dur: 0.14, wave: 'square', f0: 1320, f1: 1320, gain: 0.1 });
          break;
        case 'back': this._tone(d, t, { dur: 0.12, wave: 'square', f0: 520, f1: 300, gain: 0.1 }); break;
        case 'error': this._tone(d, t, { dur: 0.2, wave: 'sawtooth', f0: 180, f1: 120, gain: 0.14 }); break;
        case 'equip':
          this._tone(d, t, { dur: 0.1, wave: 'triangle', f0: 660, f1: 990, gain: 0.14 });
          this._burst(d, t, { dur: 0.12, type: 'bandpass', f0: 2600, f1: 1200, q: 4, gain: 0.1 });
          break;
        case 'select': this._tone(d, t, { dur: 0.06, wave: 'triangle', f0: 1100, f1: 1100, gain: 0.08 }); break;
        case 'countdown': this._tone(d, t, { dur: 0.16, wave: 'sine', f0: 660, f1: 660, gain: 0.18 }); break;
        case 'start':
          this._tone(d, t, { dur: 0.5, wave: 'sawtooth', f0: 330, f1: 660, gain: 0.24 });
          break;
        default: break;
      }
    } catch { /* never let a UI blip break navigation */ }
  }

  // -------------------------------------------------------------------------
  // Music
  // -------------------------------------------------------------------------

  startMusic(trackId) {
    if (!this._ready) { this._pendingTrack = trackId; return; }
    const cfg = TRACKS[trackId] || TRACKS.menu;
    this.music.track = trackId;
    this.music.cfg = cfg;
    this.music.step = 0;
    this.music.next = this.ctx.currentTime + 0.08;
    this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicBus.gain.setTargetAtTime(this.vol.music, this.ctx.currentTime, 0.4);
  }

  stopMusic(fade = 1) {
    if (!this._ready) { this._pendingTrack = null; return; }
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, t);
    this.musicBus.gain.linearRampToValueAtTime(0.0001, t + fade);
    // Let the ramp finish before the scheduler stops feeding it.
    setTimeout(() => { this.music.track = null; this.music.cfg = null; }, fade * 1000);
  }

  _scheduleMusic() {
    const cfg = this.music.cfg;
    if (!cfg) return;
    const ctx = this.ctx;
    const spb = 60 / cfg.bpm / 4;      // sixteenth notes
    const tension = this.music.tension;

    while (this.music.next < ctx.currentTime + LOOKAHEAD) {
      const t = this.music.next;
      const step = this.music.step;
      const bar = Math.floor(step / 16);

      // --- bass: one note per eighth ---
      if (step % 2 === 0) {
        const idx = (step / 2) % cfg.bass.length;
        const deg = cfg.bass[idx];
        const n = cfg.root + this._degree(cfg.scale, deg);
        const g = this.ctx.createGain();
        g.gain.value = 0.22 + tension * 0.1;
        g.connect(this.musicBus);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = cfg.cutoff * (0.6 + tension * 0.9);
        lp.Q.value = 4;
        lp.connect(g);
        this._tone(lp, t, { dur: spb * 1.7, wave: cfg.wave, f0: hz(n), f1: hz(n) * 0.99, gain: 0.6 });
        if (cfg.drive > 0.2) {
          const ws = ctx.createWaveShaper();
          ws.curve = this._driveCurve;
          ws.connect(g);
          this._tone(ws, t, { dur: spb * 1.5, wave: 'square', f0: hz(n - 12), f1: hz(n - 12), gain: cfg.drive * 0.3 });
        }
      }

      // --- arpeggio: layers in as tension rises ---
      if (tension > 0.18 && step % 1 === 0 && (step % 4 !== 3)) {
        const idx = step % cfg.arp.length;
        const n = cfg.root + 24 + this._degree(cfg.scale, cfg.arp[idx]);
        const g = ctx.createGain();
        g.gain.value = (0.05 + tension * 0.1);
        g.connect(this.musicBus);
        this._tone(g, t, { dur: spb * 0.9, wave: 'square', f0: hz(n), f1: hz(n), gain: 0.5 });
      }

      // --- pad: sustained chord at the top of each bar ---
      if (step % 16 === 0 && cfg.pad > 0) {
        const g = ctx.createGain();
        g.gain.value = cfg.pad * (0.16 + tension * 0.12);
        g.connect(this.musicBus);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(500, t);
        lp.frequency.linearRampToValueAtTime(cfg.cutoff * (1 + tension), t + spb * 8);
        lp.connect(g);
        for (const iv of [0, 3, 7]) {
          const n = cfg.root + 12 + this._degree(cfg.scale, iv);
          this._tone(lp, t, { dur: spb * 15, wave: 'sawtooth', f0: hz(n), f1: hz(n), gain: 0.28, attack: 0.4, detune: (iv - 3) * 6 });
        }
      }

      // --- drums ---
      if (cfg.drums > 0) {
        const dg = cfg.drums * (0.6 + tension * 0.5);
        if (step % 4 === 0) {
          this._tone(this.musicBus, t, { dur: 0.16, wave: 'sine', f0: 150, f1: 42, gain: 0.5 * dg });
        }
        if (step % 8 === 4) {
          this._burst(this.musicBus, t, { dur: 0.13, type: 'bandpass', f0: 2400, f1: 900, q: 1.1, gain: 0.28 * dg });
        }
        if (step % 2 === 1 && tension > 0.3) {
          this._burst(this.musicBus, t, { dur: 0.035, type: 'highpass', f0: 8000, f1: 6000, q: 1, gain: 0.09 * dg });
        }
        // Fill at the end of every fourth bar.
        if (bar % 4 === 3 && step % 16 >= 12) {
          this._burst(this.musicBus, t, { dur: 0.06, type: 'bandpass', f0: 3000 + (step % 16) * 260, f1: 1200, q: 2, gain: 0.16 * dg });
        }
      }

      this.music.next += spb;
      this.music.step = (step + 1) % 256;
    }
  }

  _degree(scale, deg) {
    const oct = Math.floor(deg / 7);
    const i = ((deg % 7) + 7) % 7;
    return scale[i] + oct * 12;
  }

  // -------------------------------------------------------------------------

  update(dt, world, ctx) {
    if (!this._ready) return;
    if (this._pendingTrack) {
      const t = this._pendingTrack;
      this._pendingTrack = null;
      this.startMusic(t);
    }

    const tension = ctx?.tension ?? 0;
    this.music.tension += (tension - this.music.tension) * Math.min(1, dt * 1.4);
    this._scheduleMusic();

    if (!world) return;
    const now = this.ctx.currentTime;
    const local = ctx?.localIndex ?? 0;

    // Thruster loops track speed and airborne state.
    for (let i = 0; i < 2 && i < this._loops.length; i++) {
      const r = world.robos[i];
      const loop = this._loops[i];
      const speed = Math.hypot(r.vel.x, r.vel.z);
      const airborne = r.grounded ? 0 : 1;
      const drive = clamp(speed / 14 + airborne * 0.35 + r.boostHeat * 0.5, 0, 1.4);
      const d = Math.hypot(r.pos.x - this.listener.x, r.pos.z - this.listener.z);
      const prox = clamp(1 - d / 34, 0, 1);
      loop.g.gain.setTargetAtTime(drive * 0.11 * prox, now, 0.09);
      loop.lp.frequency.setTargetAtTime(300 + drive * 1700, now, 0.09);
    }

    // Charge whine for the local player, pitched to how far along it is.
    const me = world.robos[local];
    const gun = world.loadouts[local].gun;
    const chargeFrac = clamp((me.charge || 0) / Math.max(1, gun.chargeTicks), 0, 1.2);
    if (this._charge) {
      this._charge.g.gain.setTargetAtTime(chargeFrac > 0.04 ? 0.05 + chargeFrac * 0.07 : 0, now, 0.05);
      this._charge.o.frequency.setTargetAtTime(160 + chargeFrac * 620, now, 0.06);
      this._charge.bp.frequency.setTargetAtTime(900 + chargeFrac * 2600, now, 0.06);
    }

    // Low-HP alarm: a slow pulse under 25%.
    if (this._alarm) {
      const frac = me.hp / me.maxHp;
      const on = frac > 0 && frac < 0.25 && ctx?.phase === 1;
      const pulse = on ? (Math.sin(now * 7) > 0.4 ? 1 : 0) : 0;
      this._alarm.g.gain.setTargetAtTime(pulse * 0.045, now, 0.02);
    }
  }

  dispose() {
    if (!this._ready) return;
    try {
      for (const l of this._loops) { l.src.stop(); l.src.disconnect(); }
      this._charge?.o.stop();
      this._alarm?.o.stop();
      this.ctx.close();
    } catch { /* already closing */ }
    this._ready = false;
  }
}

export default AudioEngine;
