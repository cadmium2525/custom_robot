/**
 * Material factory.
 *
 * Two ideas carry most of the look:
 *
 *  1. Everything solid is a MeshStandardMaterial fed by the procedural ORM
 *     packing, so one texture drives AO + roughness + metalness.
 *  2. Robo shells get an injected rim/fresnel term, a team-colour energy pulse
 *     and a hit-flash channel, patched in through onBeforeCompile so we keep
 *     three's shadow, fog and env-map plumbing for free.
 */

import * as THREE from 'three';

/** aoMap samples uv1 — mirror uv into it once per geometry. */
export function ensureAOChannel(geometry) {
  if (geometry.attributes.uv && !geometry.attributes.uv1) {
    geometry.setAttribute('uv1', geometry.attributes.uv);
  }
  return geometry;
}

/**
 * @param {object} maps  {map, normalMap, ormMap, emissiveMap}
 */
export function pbr(maps, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: maps.map || null,
    normalMap: maps.normalMap || null,
    aoMap: maps.ormMap || null,
    roughnessMap: maps.ormMap || null,
    metalnessMap: maps.ormMap || null,
    emissiveMap: maps.emissiveMap || null,
    emissive: new THREE.Color(opts.emissive ?? 0xffffff),
    emissiveIntensity: opts.emissiveIntensity ?? (maps.emissiveMap ? 1.6 : 0),
    roughness: opts.roughness ?? 1.0,
    metalness: opts.metalness ?? 1.0,
    envMapIntensity: opts.envMapIntensity ?? 1.0,
    color: new THREE.Color(opts.color ?? 0xffffff),
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    dithering: true,
  });
  if (maps.normalMap && opts.normalScale) {
    m.normalScale.set(opts.normalScale, opts.normalScale);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Robo shell material
// ---------------------------------------------------------------------------

const RIM_PARS = /* glsl */`
uniform vec3  uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform vec3  uTeamColor;
uniform float uEnergy;
uniform float uHitFlash;
uniform float uCharge;
uniform float uTime;
uniform float uDissolve;
varying vec3 vWorldNormalX;
varying vec3 vWorldPosX;
`;

const RIM_VERT = /* glsl */`
  vWorldNormalX = normalize(mat3(modelMatrix) * objectNormal);
  vWorldPosX = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const RIM_FRAG = /* glsl */`
  vec3 viewDirX = normalize(cameraPosition - vWorldPosX);
  float fres = 1.0 - clamp(dot(normalize(vWorldNormalX), viewDirX), 0.0, 1.0);
  float rim = pow(fres, uRimPower) * uRimStrength;

  // Energy veins: a slow band travelling up the body, masked to creases.
  float band = sin(vWorldPosX.y * 5.5 - uTime * 2.4) * 0.5 + 0.5;
  band = pow(band, 6.0);
  vec3 energy = uTeamColor * band * uEnergy;

  // Charge tell: whole shell breathes toward the team colour.
  float pulse = (sin(uTime * 22.0) * 0.5 + 0.5) * uCharge;

  gl_FragColor.rgb += uRimColor * rim;
  gl_FragColor.rgb += energy;
  gl_FragColor.rgb += uTeamColor * pulse * 0.85;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.6, 0.9, 0.85), uHitFlash);
`;

/**
 * Armoured shell with rim light, energy veins, charge pulse and hit flash.
 * Returns a MeshStandardMaterial whose `userData.u` holds the live uniforms.
 */
export function roboShell(maps, look, teamColor, opts = {}) {
  const mat = pbr(maps, {
    roughness: 1.0,
    metalness: 1.0,
    // Painted panels are mostly dielectric now, so a strong env contribution
    // just washes them out; direct light does the shaping instead.
    envMapIntensity: opts.envMapIntensity ?? 0.85,
    normalScale: opts.normalScale ?? 1.0,
  });

  const u = {
    uRimColor: { value: new THREE.Color(look.emissive ?? 0x88ccff) },
    uRimPower: { value: opts.rimPower ?? 4.0 },
    uRimStrength: { value: opts.rimStrength ?? 0.22 },
    uTeamColor: { value: new THREE.Color(teamColor) },
    uEnergy: { value: opts.energy ?? 0.10 },
    uHitFlash: { value: 0 },
    uCharge: { value: 0 },
    uTime: { value: 0 },
    uDissolve: { value: 0 },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RIM_PARS}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${RIM_VERT}`);
    // worldpos_vertex only exists when shadows/env need it; make sure we hook
    // something that is always present too.
    if (!shader.vertexShader.includes('vWorldNormalX =')) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `${RIM_VERT}\n#include <project_vertex>`
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RIM_PARS}`)
      .replace('#include <dithering_fragment>', `${RIM_FRAG}\n#include <dithering_fragment>`);
    mat.userData.shader = shader;
  };

  mat.userData.u = u;
  mat.customProgramCacheKey = () => 'roboShell';
  return mat;
}

// ---------------------------------------------------------------------------
// Energy / additive materials
// ---------------------------------------------------------------------------

export function additive(color, opts = {}) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    map: opts.map || null,
    transparent: true,
    opacity: opts.opacity ?? 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: opts.depthTest ?? true,
    side: opts.side ?? THREE.DoubleSide,
    // Vertex colours let every practical light in the arena — block rims, gate
    // glows, lamp lenses, beacons — share one merged mesh and still carry its
    // own colour. One draw call for the whole lighting story.
    vertexColors: opts.vertexColors ?? false,
    toneMapped: false,
    fog: false,
  });
}

const GLOW_VERT = /* glsl */`
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const GLOW_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uPower;
uniform float uIntensity;
uniform float uOpacity;
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vec3 v = normalize(cameraPosition - vPosW);
  float f = 1.0 - clamp(dot(normalize(vNormalW), v), 0.0, 1.0);
  float a = pow(f, uPower) * uIntensity;
  gl_FragColor = vec4(uColor * a, a * uOpacity);
}`;

/** Fresnel shell used for energy fields, shields and projectile halos. */
export function fresnelGlow(color, { power = 2.4, intensity = 1.6, opacity = 1 } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPower: { value: power },
      uIntensity: { value: intensity },
      uOpacity: { value: opacity },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

// ---------------------------------------------------------------------------
// Procedural environment map
// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */`
precision highp float;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunSize;
uniform float uStars;
uniform float uPlanet;
uniform float uTime;
varying vec3 vDir;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y * 0.5 + 0.5;

  // Three-stop vertical gradient with a tight horizon band.
  vec3 col = mix(uBottom, uHorizon, smoothstep(0.0, 0.5, h));
  col = mix(col, uTop, smoothstep(0.45, 1.0, h));

  // Sun / key light disc with a wide falloff halo.
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(sd, uSunSize) * 3.2;
  col += uSunColor * pow(sd, 6.0) * 0.28;

  if (uStars > 0.5) {
    vec3 g = floor(d * 220.0);
    float s = hash(g);
    float star = smoothstep(0.9965, 1.0, s) * step(0.02, h);
    float tw = 0.65 + 0.35 * sin(uTime * 2.0 + s * 90.0);
    col += vec3(0.85, 0.92, 1.0) * star * 2.4 * tw;
  }

  if (uPlanet > 0.5) {
    // A gas giant hanging off one side, for scale and colour interest.
    vec3 pc = normalize(vec3(-0.55, 0.16, -0.82));
    float pd = dot(d, pc);
    float disc = smoothstep(0.9955, 0.9975, pd);
    float lat = (d.y - pc.y) * 42.0;
    vec3 bands = mix(vec3(0.32, 0.20, 0.42), vec3(0.55, 0.42, 0.68),
                     sin(lat * 2.3) * 0.5 + 0.5);
    bands *= 0.55 + 0.45 * smoothstep(-1.0, 1.0, dot(d, normalize(uSunDir)));
    col = mix(col, bands, disc);
    col += vec3(0.35, 0.25, 0.55) * smoothstep(0.990, 0.9955, pd) * 0.5;
  }

  gl_FragColor = vec4(col, 1.0);
}`;

export function makeSkyMaterial(theme) {
  const top = new THREE.Color(theme.skyTop);
  const bottom = new THREE.Color(theme.skyBottom);
  const horizon = new THREE.Color(theme.skyTop).lerp(new THREE.Color(theme.accent), 0.28).multiplyScalar(0.8);
  return new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uTop: { value: top },
      uBottom: { value: bottom },
      uHorizon: { value: horizon },
      uSunDir: { value: new THREE.Vector3(...theme.sunDir) },
      uSunColor: { value: new THREE.Color(theme.sunColour) },
      uSunSize: { value: 900 },
      uStars: { value: theme.stars ? 1 : 0 },
      uPlanet: { value: theme.planet ? 1 : 0 },
      uTime: { value: 0 },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
}

/**
 * Bake the sky into a PMREM environment map. Runs once per arena — the cost is
 * paid on the loading screen, and every metal surface in the scene gets a
 * believable reflection out of it.
 */
export function bakeEnvironment(renderer, theme, size = 256) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 24), makeSkyMaterial(theme));
  scene.add(sky);

  // Ground bounce: metals look wrong without something below the horizon, and
  // the thing below the horizon is now a near-white deck, so it has to be the
  // deck colour. Reflecting a dark floor that no longer exists was quietly
  // dragging every metal surface in the arena down toward grey.
  const bounce = new THREE.Mesh(
    new THREE.SphereGeometry(9.5, 24, 12, 0, Math.PI * 2, Math.PI * 0.52, Math.PI * 0.48),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(theme.deck ?? theme.floor).multiplyScalar(0.55)
        .lerp(new THREE.Color(theme.floorAccent), 0.12),
      side: THREE.BackSide,
      toneMapped: false,
      fog: false,
    })
  );
  scene.add(bounce);

  const rt = pmrem.fromScene(scene, 0.04, 0.1, 100);
  sky.geometry.dispose();
  sky.material.dispose();
  bounce.geometry.dispose();
  bounce.material.dispose();
  pmrem.dispose();
  return rt.texture;
}
