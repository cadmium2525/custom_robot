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

export function detectTier() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const mobile = isIOS || isAndroid || /Mobi/.test(ua);
  const cores = navigator.hardwareConcurrency || (mobile ? 4 : 8);
  const mem = navigator.deviceMemory || (mobile ? 4 : 8);

  let tier;
  if (mobile) {
    // iPhone 12 and up comfortably run MID; older/weaker phones start LOW and
    // the adaptive loop lifts them if they can take it.
    tier = cores >= 6 && mem >= 4 ? TIER.MID : TIER.LOW;
  } else {
    tier = cores >= 8 && mem >= 8 ? TIER.HIGH : TIER.MID;
  }

  return { tier, mobile, isIOS, isAndroid, cores, mem };
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
