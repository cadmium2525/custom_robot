/**
 * Post-processing chain.
 *
 * Hand-rolled instead of EffectComposer + UnrealBloomPass, because that stack
 * costs ~9 full-screen passes at full res — a non-starter on an A14. This is a
 * dual-filter (Kawase) bloom pyramid at half res plus a single composite pass
 * that folds tonemapping, vignette, chromatic aberration, radial speed blur,
 * grain and colour grading together, then one optional FXAA resolve.
 *
 * Passes at MID tier: bright(½) + 3 down + 3 up + composite + fxaa = 9 small
 * passes, only one of which is full-res.
 */

import * as THREE from 'three';

const fullscreenGeo = new THREE.BufferGeometry();
fullscreenGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
fullscreenGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 texel;
uniform float threshold;
uniform float knee;
uniform float intensity;

vec3 prefilter(vec3 c) {
  // A single blown pixel should not become a soft grey continent.
  c = min(c, vec3(28.0));
  float br = max(c.r, max(c.g, c.b));
  float soft = br - threshold + knee;
  soft = clamp(soft, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float contrib = max(soft, br - threshold) / max(br, 1e-4);
  return c * contrib;
}

void main() {
  // 4-tap bilinear box: the downsample and the bright pass share one fetch set.
  vec3 a = texture2D(tDiffuse, vUv + texel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture2D(tDiffuse, vUv + texel * vec2( 1.0, -1.0)).rgb;
  vec3 c = texture2D(tDiffuse, vUv + texel * vec2(-1.0,  1.0)).rgb;
  vec3 d = texture2D(tDiffuse, vUv + texel * vec2( 1.0,  1.0)).rgb;
  vec3 col = (a + b + c + d) * 0.25;
  gl_FragColor = vec4(prefilter(col) * intensity, 1.0);
}`;

const DOWN_FRAG = /* glsl */`
precision mediump float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 texel;
void main() {
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 4.0;
  sum += texture2D(tDiffuse, vUv - texel).rgb;
  sum += texture2D(tDiffuse, vUv + texel).rgb;
  sum += texture2D(tDiffuse, vUv + vec2(texel.x, -texel.y)).rgb;
  sum += texture2D(tDiffuse, vUv - vec2(texel.x, -texel.y)).rgb;
  gl_FragColor = vec4(sum / 8.0, 1.0);
}`;

const UP_FRAG = /* glsl */`
precision mediump float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tPrev;
uniform vec2 texel;
uniform float radius;
uniform float weight;
void main() {
  vec2 o = texel * radius;
  // 3x3 tent — smooth enough to hide the pyramid seams.
  vec3 s = texture2D(tDiffuse, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
  s += texture2D(tDiffuse, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + vec2(0.0, o.y * 2.0)).rgb;
  s += texture2D(tDiffuse, vUv + vec2(o.x, o.y)).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + vec2(o.x * 2.0, 0.0)).rgb;
  s += texture2D(tDiffuse, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + vec2(0.0, -o.y * 2.0)).rgb;
  s += texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  s /= 12.0;
  // A weight below 1 on the coarse levels is what keeps the glow attached to
  // the emissive that made it. At weight 1.0 every octave lands with equal
  // force and the widest one -- a 25px-across mip stretched over the whole
  // frame -- becomes a flat veil that lifts the blacks the stage lighting
  // worked to earn.
  // (No backticks in here: this is a JS template literal, and one would end it.)
  gl_FragColor = vec4(s * weight + texture2D(tPrev, vUv).rgb, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform sampler2D tDither;
uniform float bloomStrength;
uniform float exposure;
uniform float vignette;
uniform float aberration;
uniform float grain;
uniform float time;
uniform float radialBlur;     // dash / impact speed lines
uniform vec2  radialCenter;
uniform float shockwave;      // screen-space ripple amplitude
uniform vec2  shockCenter;
uniform float shockRadius;
uniform float saturation;
uniform float contrast;
uniform float blackPoint;
uniform vec3  lift;
uniform vec3  gain;
uniform float hitFlash;
uniform vec3  hitFlashColor;
uniform vec2  resolution;

// ACES filmic, Narkowicz fit — cheap and holds saturated emissives well.
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;

  // Impact ripple: displaces UVs on a travelling ring.
  if (shockwave > 0.001) {
    vec2 d = uv - shockCenter;
    d.x *= resolution.x / resolution.y;
    float dist = length(d);
    float ring = exp(-pow((dist - shockRadius) * 9.0, 2.0));
    uv += normalize(d + 1e-5) * ring * shockwave;
  }

  vec2 toCenter = uv - radialCenter;

  vec3 col;
  if (aberration > 0.0001) {
    // Lateral CA scaled by distance from centre, like a real lens.
    float amt = aberration * (0.35 + dot(toCenter, toCenter) * 2.2);
    col.r = texture2D(tDiffuse, uv - toCenter * amt).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, uv + toCenter * amt).b;
  } else {
    col = texture2D(tDiffuse, uv).rgb;
  }

  if (radialBlur > 0.001) {
    vec3 acc = col;
    for (int i = 1; i < 6; i++) {
      float t = float(i) / 5.0;
      acc += texture2D(tDiffuse, uv - toCenter * t * radialBlur).rgb;
    }
    col = acc / 6.0;
  }

  col += texture2D(tBloom, vUv).rgb * bloomStrength;

  col *= exposure;
  col = aces(col);

  // Grade: lift/gain, then an S-curve, then saturation — all after tonemap so
  // the result is predictable. The curve is what stops the mid-tones going
  // muddy once ACES has compressed everything toward the middle.
  col = col * gain + lift;
  col = mix(col, col * col * (3.0 - 2.0 * col), contrast);

  // Hard black point. Bloom, fog and grain all deposit a fraction of a percent
  // everywhere; without this the darkest part of the frame settles a few points
  // above zero and the whole image reads as grey milk no matter how dark the
  // art is. Anything under the black point is crushed to true black and the
  // rest is re-expanded, so the arena keeps a real shadow end.
  col = max(col - blackPoint, vec3(0.0)) / max(1.0 - blackPoint, 1e-3);

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, saturation);

  col = mix(col, hitFlashColor, hitFlash);

  float v = 1.0 - vignette * dot(toCenter, toCenter) * 1.9;
  col *= clamp(v, 0.0, 1.0);

  // Ordered-ish dither breaks 8-bit banding in the dark gradients.
  float d = texture2D(tDither, gl_FragCoord.xy / 64.0).r;
  col += (d - 0.5) / 255.0;

  if (grain > 0.0001) {
    float n = fract(sin(dot(gl_FragCoord.xy + time * 37.0, vec2(12.9898, 78.233))) * 43758.5453);
    // Keep grain out of the deepest shadows — it is the last thing that would
    // re-lift the black point we just set.
    col += (n - 0.5) * grain * smoothstep(0.015, 0.16, luma) * (1.0 - luma * 0.6);
  }

  // This is a raw shader, so three's automatic output conversion never runs —
  // encode to sRGB here. FXAA downstream then works on perceptual values,
  // which is where it was designed to run anyway.
  col = clamp(col, 0.0, 1.0);
  vec3 srgb = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
  gl_FragColor = vec4(srgb, 1.0);
}`;

const FXAA_FRAG = /* glsl */`
precision mediump float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 texel;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * texel).rgb;
  vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * texel).rgb;
  vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * texel).rgb;
  vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * texel).rgb;
  vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;

  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  if (lMax - lMin < max(0.0312, lMax * 0.125)) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * texel;

  vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv - dir * 0.5).rgb +
                                   texture2D(tDiffuse, vUv + dir * 0.5).rgb);
  float lB = luma(rgbB);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}`;

// ---------------------------------------------------------------------------

class Pass {
  constructor(fragment, uniforms) {
    // GLSL1 ShaderMaterial: three handles the version directive and the
    // WebGL1/2 differences, which matters for older iOS Safari builds.
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: fragment,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(fullscreenGeo, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }

  dispose() {
    this.material.dispose();
  }
}

/**
 * Bloom pyramid depth per `bloomQuality` tier — i.e. HOW FAR a seeded pixel's
 * glow spreads. RULING 22 decided this is the knob, and it decided it against
 * the two obvious alternatives.
 *
 * `SPEC-CRV2` platform fact P6: the N64 has no framebuffer post-processing, so
 * nothing glows outside its own geometry. It is the only platform fact this
 * renderer contradicts by design, and the contradiction is measurable — with the
 * composite's bloom at zero the opponent's coverage at 117 ms falls from 100.0%
 * to 59.3% on the render meter, which is the largest single contribution to the
 * worst cell on the card.
 *
 * WHY NOT THE THRESHOLD. P6 is a statement about the SUPPORT of the glow, and
 * `threshold`/`knee` decide only WHICH pixels seed it. Raising the threshold
 * removes the dimmest emitters — whose glow is already nearest their own
 * geometry — and leaves the brightest ones spreading exactly as far. It answers
 * a different question.
 *
 * WHY NOT `bloomStrength`. That is HOW MUCH is added, not how far, and `--bloom
 * 0` is a ceiling measurement, never a ship setting: deleting the chain because
 * it fails a clause derived from hardware that could not run one is the move
 * RULING 16 refused for the temperature gradient. Bloom's near field is the
 * look; its far field is the defect; they have different knobs and this is the
 * one that separates them.
 *
 * Each mip halves the resolution, so dropping one roughly halves the radius the
 * glow reaches while leaving the near field — the part that is the look — intact.
 */
const MIPS = [2, 3, 3, 4];   // per bloomQuality tier

export class PostFX {
  constructor(renderer, settings, ditherTex) {
    this.renderer = renderer;
    this.settings = settings;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const type = renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.hdrType = type;

    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: settings.msaa ?? 0,
    });
    this.sceneTarget.texture.colorSpace = THREE.NoColorSpace;

    this.ldrTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.ldrTarget.texture.colorSpace = THREE.NoColorSpace;

    this.mips = [];
    this.scratch = [];   // per-level ping-pong partner for the upsample chain
    this.mipCount = MIPS[settings.bloomQuality ?? 1];

    // The contract with vfx.js/materials.js is that anything meant to glow is
    // authored above 1.0 linear. Thresholding just under that keeps the bloom on
    // actual emissives: a lit floor at 0.8 linear contributes nothing, so a
    // bright deck stays a bright deck instead of turning into a light source.
    this.brightPass = new Pass(BRIGHT_FRAG, {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2() },
      threshold: { value: 1.04 },
      knee: { value: 0.16 },
      intensity: { value: 1.0 },
    });

    this.downPass = new Pass(DOWN_FRAG, {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2() },
    });

    this.upPass = new Pass(UP_FRAG, {
      tDiffuse: { value: null },
      tPrev: { value: null },
      texel: { value: new THREE.Vector2() },
      radius: { value: 1.0 },
      weight: { value: 1.0 },
    });

    this.compositePass = new Pass(COMPOSITE_FRAG, {
      tDiffuse: { value: null },
      tBloom: { value: null },
      tDither: { value: ditherTex },
      bloomStrength: { value: 0.66 },
      exposure: { value: 1.0 },
      vignette: { value: 0.34 },
      aberration: { value: 0.0018 },
      grain: { value: 0.014 },
      time: { value: 0 },
      radialBlur: { value: 0 },
      radialCenter: { value: new THREE.Vector2(0.5, 0.5) },
      shockwave: { value: 0 },
      shockCenter: { value: new THREE.Vector2(0.5, 0.5) },
      shockRadius: { value: 0 },
      saturation: { value: 1.16 },
      contrast: { value: 0.22 },
      blackPoint: { value: 0.005 },
      // No lift. A positive lift is a milk pump: it raises the floor of every
      // channel across the whole frame, which is exactly the "nothing is black"
      // failure the arena rebuild is trying to fix.
      lift: { value: new THREE.Vector3(0, 0, 0) },
      gain: { value: new THREE.Vector3(1.06, 1.02, 0.99) },
      hitFlash: { value: 0 },
      hitFlashColor: { value: new THREE.Vector3(1, 0.35, 0.3) },
      resolution: { value: new THREE.Vector2(1, 1) },
    });

    this.fxaaPass = new Pass(FXAA_FRAG, {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2() },
    });

    this.enabled = true;
    this.width = 1;
    this.height = 1;
  }

  get uniforms() { return this.compositePass.material.uniforms; }

  setSize(width, height) {
    this.width = Math.max(2, Math.floor(width));
    this.height = Math.max(2, Math.floor(height));
    this.sceneTarget.setSize(this.width, this.height);
    this.ldrTarget.setSize(this.width, this.height);
    this.uniforms.resolution.value.set(this.width, this.height);

    for (const m of this.mips) m.dispose();
    for (const m of this.scratch) m.dispose();
    this.mips.length = 0;
    this.scratch.length = 0;

    const makeRT = (w, h) => {
      const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
        type: this.hdrType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      rt.texture.colorSpace = THREE.NoColorSpace;
      return rt;
    };

    let w = Math.max(1, this.width >> 1);
    let h = Math.max(1, this.height >> 1);
    for (let i = 0; i < this.mipCount; i++) {
      this.mips.push(makeRT(w, h));
      // Same-size partner so the upsample never reads and writes one target,
      // which is undefined behaviour on several mobile drivers.
      this.scratch.push(makeRT(w, h));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }

  setQuality(settings) {
    this.settings = settings;
    const next = MIPS[settings.bloomQuality ?? 1];
    if (next !== this.mipCount) {
      this.mipCount = next;
      this.setSize(this.width, this.height);
    }
    this.uniforms.grain.value = settings.bloomQuality >= 2 ? 0.014 : 0.009;
  }

  _blit(pass, target) {
    this.renderer.setRenderTarget(target);
    this.renderer.render(pass.scene, this.camera);
  }

  render(scene, camera, time) {
    const r = this.renderer;

    r.setRenderTarget(this.sceneTarget);
    r.clear();
    r.render(scene, camera);

    if (!this.enabled || !this.settings.bloom) {
      this.uniforms.tDiffuse.value = this.sceneTarget.texture;
      this.uniforms.tBloom.value = this.sceneTarget.texture;
      this.uniforms.bloomStrength.value = 0;
      this.uniforms.time.value = time;
      this._finish();
      return;
    }

    // --- bloom pyramid: bright + downsample chain ---
    const bu = this.brightPass.material.uniforms;
    bu.tDiffuse.value = this.sceneTarget.texture;
    bu.texel.value.set(1 / this.width, 1 / this.height);
    this._blit(this.brightPass, this.mips[0]);

    for (let i = 1; i < this.mips.length; i++) {
      const src = this.mips[i - 1];
      const du = this.downPass.material.uniforms;
      du.tDiffuse.value = src.texture;
      du.texel.value.set(1 / src.width, 1 / src.height);
      this._blit(this.downPass, this.mips[i]);
    }

    // --- upsample + accumulate back down the pyramid ---
    for (let i = this.mips.length - 1; i > 0; i--) {
      const src = this.mips[i];
      const dst = this.mips[i - 1];
      const uu = this.upPass.material.uniforms;
      uu.tDiffuse.value = src.texture;
      uu.tPrev.value = dst.texture;
      uu.texel.value.set(1 / dst.width, 1 / dst.height);
      uu.radius.value = 1.0;
      // Coarse levels are attenuated as they fold down, so the pyramid ends up
      // as a tight halo with a faint wide skirt rather than a uniform haze.
      uu.weight.value = i === 1 ? 0.82 : 0.55;
      // Ping-pong through this level's own same-size partner: reading and
      // writing one target in a single pass is undefined behaviour on several
      // mobile drivers. The partner is pre-allocated in setSize, so the swap
      // below costs two array writes and never touches the GL allocator.
      const spare = this.scratch[i - 1];
      this._blit(this.upPass, spare);
      this.mips[i - 1] = spare;
      this.scratch[i - 1] = dst;
    }

    this.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this.uniforms.tBloom.value = this.mips[0].texture;
    this.uniforms.time.value = time;
    this._finish();
  }

  _finish() {
    const r = this.renderer;
    if (this.settings.fxaa) {
      this._blit(this.compositePass, this.ldrTarget);
      const fu = this.fxaaPass.material.uniforms;
      fu.tDiffuse.value = this.ldrTarget.texture;
      fu.texel.value.set(1 / this.width, 1 / this.height);
      r.setRenderTarget(null);
      r.render(this.fxaaPass.scene, this.camera);
    } else {
      r.setRenderTarget(null);
      r.render(this.compositePass.scene, this.camera);
    }
  }

  dispose() {
    this.sceneTarget.dispose();
    this.ldrTarget.dispose();
    for (const m of this.mips) m.dispose();
    for (const m of this.scratch) m.dispose();
    this.brightPass.dispose();
    this.downPass.dispose();
    this.upPass.dispose();
    this.compositePass.dispose();
    this.fxaaPass.dispose();
  }
}
