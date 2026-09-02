/**
 * Device tiering and adaptive quality.
 *
 * Target: iPhone 12 (A14, 3x display) holding 60 fps. That means we start
 * conservative on mobile, measure, and only climb when there's headroom — the
 * opposite of "detect once and hope".
 */

export const TIER = { LOW: 0, MID: 1, HIGH: 2, ULTRA: 3 };

const PRESETS = {
  [TIER.LOW]: {
    name: 'LOW',
    maxPixelRatio: 1.0,
    renderScale: 0.72,
    shadows: false,
    shadowMapSize: 512,
    bloom: true,
    bloomQuality: 0,       // half-res, 3 mips
    ssao: false,
    motionBlur: false,
    reflections: false,
    particleBudget: 260,
    trailSegments: 6,
    anisotropy: 2,
    envSize: 64,
    crowd: false,
    decals: 24,
    lights: 2,
    fxaa: true,
  },
  [TIER.MID]: {
    name: 'MID',
    maxPixelRatio: 1.6,
    renderScale: 0.88,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    bloomQuality: 1,
    ssao: false,
    motionBlur: true,
    reflections: false,
    particleBudget: 620,
    trailSegments: 10,
    anisotropy: 4,
    envSize: 128,
    crowd: true,
    decals: 48,
    lights: 4,
    fxaa: true,
  },
  [TIER.HIGH]: {
    name: 'HIGH',
    maxPixelRatio: 2.0,
    renderScale: 1.0,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    bloomQuality: 2,
    ssao: true,
    motionBlur: true,
    reflections: true,
    particleBudget: 1400,
    trailSegments: 16,
    anisotropy: 8,
    envSize: 256,
    crowd: true,
    decals: 96,
    lights: 6,
    fxaa: true,
  },
  [TIER.ULTRA]: {
    name: 'ULTRA',
    maxPixelRatio: 2.0,
    renderScale: 1.0,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    bloomQuality: 3,
    ssao: true,
    motionBlur: true,
    reflections: true,
    particleBudget: 2600,
    trailSegments: 22,
    anisotropy: 16,
    envSize: 512,
    crowd: true,
    decals: 160,
    lights: 8,
    fxaa: true,
  },
};

/**
 * Pick a starting tier from what the browser will actually tell us.
 *
 * ---------------------------------------------------------------------------
 * THE `deviceMemory` NO-OP, AND WHY IT MATTERED ON THE ONE DEVICE THIS FILE
 * NAMES IN ITS HEADER
 * ---------------------------------------------------------------------------
 * This used to read:
 *
 *     const mem = navigator.deviceMemory || (mobile ? 4 : 8);
 *     tier = cores >= 6 && mem >= 4 ? TIER.MID : TIER.LOW;
 *
 * `navigator.deviceMemory` is a Chromium-only API. WebKit has never shipped it
 * and has said it will not, so on EVERY iOS device the fallback supplied the
 * literal 4 and `mem >= 4` compared that literal to itself: always true, never
 * a test. The gate read as a two-term check on memory and cores and was, on
 * Safari, a one-term check on cores — on the one browser this project's target
 * device runs and the one nobody had run it on.
 *
 * Two things are wrong with that beyond the dead term. It hides which signal
 * decided the tier, so a wrong tier on an iPhone cannot be diagnosed from the
 * outside; and it publishes `mem: 4` on the device object, a number nobody
 * measured, for anything downstream to believe.
 *
 * So: memory is only consulted where it exists, `memKnown` says whether it did,
 * and iOS is gated on the signal WebKit does implement.
 *
 * WHAT `hardwareConcurrency` IS WORTH ON iOS. Safari has exposed it since 10.1
 * and reports the physical core count, and Apple's core counts happen to
 * separate the classes cleanly: A9 and earlier are dual-core, A10 is quad, and
 * every hexa-core iPhone is A11 (2017) or newer — which is exactly the line
 * between "starts at MID" and "starts at LOW and climbs". The iPhone 12's A14
 * reports 6. It is a coarse signal and it is named as such below rather than
 * dressed up as a memory check.
 *
 * None of this is load-bearing for very long: `sample()` measures real frame
 * times and moves the tier within a few seconds either way. What it decides is
 * the first few seconds, and which way a device that cannot be identified errs.
 */
export function detectTier() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const mobile = isIOS || isAndroid || /Mobi/.test(ua);

  const coresKnown = typeof navigator.hardwareConcurrency === 'number' &&
    navigator.hardwareConcurrency > 0;
  const cores = coresKnown ? navigator.hardwareConcurrency : (mobile ? 4 : 8);
  // Chromium-only. Absent on every WebKit browser, which is every browser on
  // iOS. `null`, not a fabricated default, so nothing downstream can mistake
  // the fallback for a reading.
  const memKnown = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory > 0;
  const mem = memKnown ? navigator.deviceMemory : null;

  let tier, why;
  if (mobile) {
    if (memKnown) {
      // Android/Chromium: both signals are real, so use both.
      tier = cores >= 6 && mem >= 4 ? TIER.MID : TIER.LOW;
      why = `mobile cores=${cores} mem=${mem}GB`;
    } else {
      // iOS and any other WebKit: cores is the only real signal there is.
      tier = cores >= 6 ? TIER.MID : TIER.LOW;
      why = `mobile cores=${cores} mem=unavailable(WebKit)`;
    }
  } else {
    // Desktop keeps the memory term where it exists; where it does not
    // (Safari on a Mac) an 8-core machine is not asked to prove it twice.
    tier = cores >= 8 && (!memKnown || mem >= 8) ? TIER.HIGH : TIER.MID;
    why = `desktop cores=${cores} mem=${memKnown ? mem + 'GB' : 'unavailable(WebKit)'}`;
  }

  return { tier, mobile, isIOS, isAndroid, cores, mem, coresKnown, memKnown, why };
}

export class QualityManager {
  constructor(forced = null) {
    const d = detectTier();
    this.device = d;
    this.tier = forced ?? d.tier;
    this.settings = { ...PRESETS[this.tier] };
    this.auto = forced === null;

    // Rolling frame-time window for the adaptive controller.
    this.samples = new Float32Array(90);
    this.cursor = 0;
    this.filled = 0;
    this.cooldown = 180;
    this.dynamicScale = 1;
    this.listeners = [];
    this.lastChange = 0;
  }

  onChange(fn) { this.listeners.push(fn); return () => {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }; }

  setTier(tier) {
    if (tier === this.tier) return;
    this.tier = Math.max(0, Math.min(3, tier));
    this.settings = { ...PRESETS[this.tier] };
    this.dynamicScale = 1;
    for (const fn of this.listeners) fn(this.settings, this.tier);
  }

  get pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, this.settings.maxPixelRatio);
  }

  get effectiveScale() {
    return this.settings.renderScale * this.dynamicScale;
  }

  /**
   * Feed one frame time (ms). Nudges internal resolution first — invisible at a
   * glance — and only drops a whole tier when that isn't enough.
   */
  sample(dtMs) {
    this.samples[this.cursor] = dtMs;
    this.cursor = (this.cursor + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled++;
    if (this.cooldown > 0) { this.cooldown--; return false; }
    if (this.filled < this.samples.length) return false;
    if (!this.auto) return false;

    // Median is robust against GC spikes in a way that a mean is not.
    const arr = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
    const med = arr[arr.length >> 1];
    const p95 = arr[Math.floor(arr.length * 0.95)];

    let changed = false;
    if (med > 19.5 || p95 > 30) {
      if (this.dynamicScale > 0.62) {
        this.dynamicScale = Math.max(0.62, this.dynamicScale - 0.08);
        changed = true;
      } else if (this.tier > TIER.LOW) {
        this.setTier(this.tier - 1);
        changed = true;
      }
      this.cooldown = 150;
    } else if (med < 13.2 && p95 < 18) {
      if (this.dynamicScale < 1) {
        this.dynamicScale = Math.min(1, this.dynamicScale + 0.05);
        changed = true;
        this.cooldown = 180;
      } else if (this.tier < (this.device.mobile ? TIER.HIGH : TIER.ULTRA)) {
        this.setTier(this.tier + 1);
        changed = true;
        this.cooldown = 420;   // climbing is riskier than falling; be patient
      }
    }
    if (changed) this.lastChange = performance.now();
    return changed;
  }
}

export { PRESETS };
