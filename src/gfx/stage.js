/**
 * The holosseum: level geometry, lighting rig, sky and atmosphere.
 *
 * Geometry comes from the same box list the sim collides against, so the stage
 * is never a lie. Everything static is merged into a handful of draw calls —
 * a phone GPU cares far more about batch count than triangle count.
 */

import * as THREE from 'three';
import { floorTexture, wallTexture, sprites } from './textures.js';
import { pbr, ensureAOChannel, makeSkyMaterial, bakeEnvironment, additive, fresnelGlow } from './materials.js';
import { Noise } from './noise.js';

const KIND_TINT = {
  dais: 1.0,
  block: 0.94,
  pillar: 0.9,
  rail: 1.06,
  wallblock: 0.86,
};

export class Stage {
  constructor(renderer, arena, settings) {
    this.arena = arena;
    this.theme = arena.theme;
    this.settings = settings;
    this.group = new THREE.Group();
    this.group.name = 'stage';
    this.time = 0;

    this.envMap = bakeEnvironment(renderer, this.theme, settings.envSize);
    this.fog = new THREE.FogExp2(this.theme.fog, this.theme.fogDensity);

    this._buildSky();
    this._buildFloor();
    this._buildWalls();
    this._buildBoxes();
    this._buildLights();
    this._buildAtmosphere();
  }

  // -------------------------------------------------------------------------

  _buildSky() {
    this.skyMat = makeSkyMaterial(this.theme);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 20), this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    this.sky = sky;
    this.group.add(sky);
  }

  _buildFloor() {
    const b = this.arena.bounds;
    const tex = floorTexture(this.theme, this.settings.envSize >= 256 ? 1024 : 512);
    for (const t of Object.values(tex)) {
      if (t?.isTexture) {
        t.repeat.set(b.hx / 8, b.hz / 8);   // ~2m panels — readable at range
        t.anisotropy = this.settings.anisotropy;
      }
    }
    this.floorTex = tex;

    const geo = new THREE.PlaneGeometry(b.hx * 2, b.hz * 2, 1, 1);
    geo.rotateX(-Math.PI / 2);
    ensureAOChannel(geo);

    const mat = pbr(tex, {
      emissive: 0xffffff,
      emissiveIntensity: 1.5,
      envMapIntensity: 0.85,
      normalScale: 0.9,
    });
    mat.envMap = this.envMap;
    this.floorMat = mat;

    const floor = new THREE.Mesh(geo, mat);
    floor.receiveShadow = this.settings.shadows;
    floor.name = 'floor';
    this.group.add(floor);

    // Wet-look mirror plane: a cheap stand-in for SSR that reads as polish.
    if (this.settings.reflections) {
      const gloss = new THREE.Mesh(
        geo.clone(),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(this.theme.floorAccent).multiplyScalar(0.06),
          roughness: 0.12,
          metalness: 1.0,
          envMap: this.envMap,
          envMapIntensity: 1.6,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
        })
      );
      gloss.position.y = 0.004;
      gloss.renderOrder = 1;
      this.group.add(gloss);
      this.glossFloor = gloss;
    }
  }

  _buildWalls() {
    const b = this.arena.bounds;
    const tex = wallTexture(this.theme, 512);
    for (const t of Object.values(tex)) {
      if (t?.isTexture) {
        t.repeat.set(4, 1.2);
        t.anisotropy = this.settings.anisotropy;
      }
    }
    this.wallTex = tex;

    const h = b.ceil;
    const mat = pbr(tex, {
      emissive: 0xffffff,
      emissiveIntensity: 1.3,
      envMapIntensity: 0.7,
      normalScale: 1.1,
      side: THREE.DoubleSide,
    });
    mat.envMap = this.envMap;
    this.wallMat = mat;

    const parts = [];
    const mk = (w, hh, x, z, ry) => {
      const g = new THREE.PlaneGeometry(w, hh, 1, 1);
      g.rotateY(ry);
      g.translate(x, hh / 2, z);
      return g;
    };
    parts.push(mk(b.hx * 2, h, 0, -b.hz, 0));
    parts.push(mk(b.hx * 2, h, 0, b.hz, Math.PI));
    parts.push(mk(b.hz * 2, h, -b.hx, 0, Math.PI / 2));
    parts.push(mk(b.hz * 2, h, b.hx, 0, -Math.PI / 2));

    const merged = mergeGeometries(parts);
    ensureAOChannel(merged);
    const walls = new THREE.Mesh(merged, mat);
    walls.receiveShadow = this.settings.shadows;
    walls.name = 'walls';
    this.group.add(walls);

    // Glowing boundary strip where wall meets floor — reads the play area edge
    // instantly, which matters when you're airborne and hunting for the ground.
    const stripGeo = [];
    const sh = 0.34;
    const sm = (w, x, z, ry) => {
      const g = new THREE.PlaneGeometry(w, sh);
      g.rotateY(ry);
      g.translate(x, sh / 2 + 0.02, z);
      return g;
    };
    stripGeo.push(sm(b.hx * 2, 0, -b.hz + 0.06, 0));
    stripGeo.push(sm(b.hx * 2, 0, b.hz - 0.06, Math.PI));
    stripGeo.push(sm(b.hz * 2, -b.hx + 0.06, 0, Math.PI / 2));
    stripGeo.push(sm(b.hz * 2, b.hx - 0.06, 0, -Math.PI / 2));
    const strip = new THREE.Mesh(
      mergeGeometries(stripGeo),
      additive(this.theme.emissive, { opacity: 0.55, side: THREE.DoubleSide, depthTest: true })
    );
    strip.name = 'boundary';
    this.group.add(strip);
    this.boundaryStrip = strip;
  }

  _buildBoxes() {
    const solids = [];
    const trims = [];

    for (const b of this.arena.boxes) {
      const g = new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2, 1, 1, 1);
      // Chamfer the silhouette by pulling the top face in slightly — box edges
      // are the fastest way to look cheap.
      const pos = g.attributes.position;
      const inset = Math.min(0.12, Math.min(b.hx, b.hz) * 0.18);
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y > 0) {
          pos.setX(i, pos.getX(i) * (1 - inset / Math.max(0.2, b.hx)));
          pos.setZ(i, pos.getZ(i) * (1 - inset / Math.max(0.2, b.hz)));
        }
      }
      g.computeVertexNormals();
      g.rotateY(b.yaw || 0);
      g.translate(b.x, b.y, b.z);

      const tint = KIND_TINT[b.kind] ?? 1;
      const c = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < c.length; i += 3) { c[i] = tint; c[i + 1] = tint; c[i + 2] = tint; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      solids.push(g);

      // Emissive trim ring around the top face.
      const t = new THREE.BoxGeometry(b.hx * 2 + 0.04, 0.06, b.hz * 2 + 0.04);
      t.rotateY(b.yaw || 0);
      t.translate(b.x, b.y + b.hy + 0.03, b.z);
      trims.push(t);
    }

    if (solids.length) {
      const merged = mergeGeometries(solids);
      ensureAOChannel(merged);
      const mat = pbr(this.wallTex, {
        emissive: 0xffffff,
        emissiveIntensity: 0.8,
        envMapIntensity: 0.9,
        normalScale: 1.0,
      });
      mat.envMap = this.envMap;
      mat.vertexColors = true;
      this.boxMat = mat;

      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = this.settings.shadows;
      mesh.receiveShadow = this.settings.shadows;
      mesh.name = 'obstacles';
      this.group.add(mesh);
      this.obstacles = mesh;
    }

    if (trims.length) {
      const trim = new THREE.Mesh(
        mergeGeometries(trims),
        additive(this.theme.emissive, { opacity: 0.85, side: THREE.FrontSide })
      );
      trim.name = 'obstacleTrim';
      this.group.add(trim);
      this.trim = trim;
    }
  }

  _buildLights() {
    const t = this.theme;
    this.lights = {};

    const key = new THREE.DirectionalLight(t.sunColour, t.sunIntensity);
    key.position.set(t.sunDir[0] * 30, t.sunDir[1] * 34, t.sunDir[2] * 30);
    key.target.position.set(0, 0, 0);
    if (this.settings.shadows) {
      key.castShadow = true;
      const s = this.settings.shadowMapSize;
      key.shadow.mapSize.set(s, s);
      const b = this.arena.bounds;
      const ext = Math.max(b.hx, b.hz) * 1.15;
      key.shadow.camera.left = -ext;
      key.shadow.camera.right = ext;
      key.shadow.camera.top = ext;
      key.shadow.camera.bottom = -ext;
      key.shadow.camera.near = 1;
      key.shadow.camera.far = 90;
      key.shadow.bias = -0.0012;
      key.shadow.normalBias = 0.045;
      key.shadow.radius = 2.2;
    }
    this.group.add(key, key.target);
    this.lights.key = key;

    // Cool fill from the opposite side keeps shadowed metal from going black.
    const fill = new THREE.DirectionalLight(t.rimColour, t.sunIntensity * 0.42);
    fill.position.set(-t.sunDir[0] * 24, 14, -t.sunDir[2] * 24);
    this.group.add(fill);
    this.lights.fill = fill;

    const hemi = new THREE.HemisphereLight(t.skyTop, t.floor, 1.15);
    this.group.add(hemi);
    this.lights.hemi = hemi;

    // Two spot rigs above the arena give the robos moving specular highlights.
    if (this.settings.lights >= 4) {
      const b = this.arena.bounds;
      this.rigLights = [];
      for (let i = 0; i < 2; i++) {
        const l = new THREE.PointLight(t.accent, 90, b.hx * 2.4, 2.0);
        l.position.set(i === 0 ? -b.hx * 0.55 : b.hx * 0.55, b.ceil * 0.72, 0);
        this.group.add(l);
        this.rigLights.push(l);
      }
    }
  }

  _buildAtmosphere() {
    const b = this.arena.bounds;
    const sp = sprites();
    const n = new Noise(0xa7);

    // Floating dust motes: cheap parallax that sells depth and scale.
    const count = this.settings.particleBudget >= 600 ? 380 : 160;
    const pos = new Float32Array(count * 3);
    const scale = new Float32Array(count);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (n.simplex2(i * 0.71, 3.1)) * b.hx;
      pos[i * 3 + 1] = (n.simplex2(i * 0.37, 7.7) * 0.5 + 0.5) * b.ceil * 0.85 + 0.4;
      pos[i * 3 + 2] = (n.simplex2(i * 0.53, 11.3)) * b.hz;
      scale[i] = 0.05 + Math.abs(n.simplex2(i * 1.7, 2.2)) * 0.11;
      phase[i] = n.simplex2(i * 2.3, 5.5) * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: sp.glow },
        uColor: { value: new THREE.Color(this.theme.accent) },
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uCeil: { value: b.ceil },
      },
      vertexShader: /* glsl */`
        attribute float aScale;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uCeil;
        varying float vFade;
        void main() {
          vec3 p = position;
          // Slow convective drift, wrapping at the ceiling.
          p.y = mod(p.y + uTime * 0.22 + aPhase, uCeil * 0.85) + 0.4;
          p.x += sin(uTime * 0.35 + aPhase) * 0.5;
          p.z += cos(uTime * 0.28 + aPhase * 1.7) * 0.5;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aScale * 620.0 * uPixelRatio / max(1.0, -mv.z);
          vFade = smoothstep(0.0, 6.0, -mv.z) * (1.0 - smoothstep(28.0, 60.0, -mv.z));
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(uColor * t.rgb, t.a * vFade * 0.16);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const motes = new THREE.Points(geo, mat);
    motes.frustumCulled = false;
    motes.name = 'motes';
    this.group.add(motes);
    this.motes = motes;
    this.moteMat = mat;

    // Volumetric-ish light shafts from the rig, as camera-facing quads.
    if (this.settings.lights >= 4) {
      const shafts = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        const g = new THREE.CylinderGeometry(0.22, 2.4, b.ceil * 1.05, 10, 1, true);
        const m = additive(this.theme.accent, { opacity: 0.012, side: THREE.DoubleSide, depthTest: true });
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(Math.cos(a) * b.hx * 0.62, b.ceil * 0.55, Math.sin(a) * b.hz * 0.62);
        mesh.rotation.z = Math.cos(a) * 0.16;
        mesh.rotation.x = Math.sin(a) * 0.16;
        shafts.add(mesh);
      }
      shafts.name = 'shafts';
      this.group.add(shafts);
      this.shafts = shafts;
    }

    // Sweeping floor bands.
    if (this.theme.sweep) {
      const g = new THREE.PlaneGeometry(b.hx * 2, b.hz * 2);
      g.rotateX(-Math.PI / 2);
      this.sweepMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(this.theme.floorAccent) },
          uTime: { value: 0 },
          uExtent: { value: new THREE.Vector2(b.hx, b.hz) },
        },
        vertexShader: /* glsl */`
          varying vec2 vP;
          void main() {
            vP = position.xz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uColor;
          uniform float uTime;
          uniform vec2 uExtent;
          varying vec2 vP;
          void main() {
            float d = length(vP) / max(uExtent.x, uExtent.y);
            float band = sin(d * 9.0 - uTime * 1.3);
            band = smoothstep(0.965, 1.0, band);
            float fade = 1.0 - smoothstep(0.35, 1.05, d);
            gl_FragColor = vec4(uColor * band * 0.55 * fade, band * fade * 0.4);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const sweep = new THREE.Mesh(g, this.sweepMat);
      sweep.position.y = 0.012;
      sweep.renderOrder = 2;
      this.group.add(sweep);
      this.sweep = sweep;
    }
  }

  // -------------------------------------------------------------------------

  update(dt, time, ctx) {
    this.time = time;
    this.skyMat.uniforms.uTime.value = time;
    if (this.moteMat) {
      this.moteMat.uniforms.uTime.value = time;
      this.moteMat.uniforms.uPixelRatio.value = ctx?.pixelRatio ?? 1;
    }
    if (this.sweepMat) this.sweepMat.uniforms.uTime.value = time;

    if (this.sky && ctx?.cameraPos) this.sky.position.copy(ctx.cameraPos);

    // Rig lights orbit slowly so highlights crawl across the armour.
    if (this.rigLights) {
      const b = this.arena.bounds;
      for (let i = 0; i < this.rigLights.length; i++) {
        const a = time * 0.14 + i * Math.PI;
        this.rigLights[i].position.set(
          Math.cos(a) * b.hx * 0.6,
          b.ceil * (0.68 + Math.sin(time * 0.3 + i) * 0.05),
          Math.sin(a) * b.hz * 0.6
        );
      }
    }

    // Keep the shadow frustum tight around the action instead of the whole map.
    const key = this.lights.key;
    if (key?.castShadow && ctx?.focus) {
      key.target.position.set(ctx.focus.x, 0, ctx.focus.z);
      key.position.set(
        ctx.focus.x + this.theme.sunDir[0] * 30,
        this.theme.sunDir[1] * 34,
        ctx.focus.z + this.theme.sunDir[2] * 30
      );
      key.target.updateMatrixWorld();
    }
  }

  setQuality(settings) {
    this.settings = settings;
    if (this.lights.key) {
      this.lights.key.castShadow = settings.shadows;
      if (settings.shadows) this.lights.key.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    }
    if (this.obstacles) {
      this.obstacles.castShadow = settings.shadows;
      this.obstacles.receiveShadow = settings.shadows;
    }
    if (this.shafts) this.shafts.visible = settings.lights >= 4;
    if (this.glossFloor) this.glossFloor.visible = settings.reflections;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
    this.envMap?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Minimal geometry merge — avoids pulling in the BufferGeometryUtils example
// module and only handles what this file produces (non-indexed or indexed
// triangle lists sharing an attribute set).
// ---------------------------------------------------------------------------

export function mergeGeometries(geometries) {
  if (geometries.length === 1) return geometries[0];

  const names = new Set();
  for (const g of geometries) for (const k of Object.keys(g.attributes)) names.add(k);

  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geometries) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const proto = geometries.find((g) => g.attributes[name])?.attributes[name];
    if (!proto) continue;
    const itemSize = proto.itemSize;
    const array = new Float32Array(vertexCount * itemSize);
    let offset = 0;
    for (const g of geometries) {
      const attr = g.attributes[name];
      const count = g.attributes.position.count;
      if (attr) {
        array.set(attr.array.subarray(0, count * itemSize), offset);
      }
      offset += count * itemSize;
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }

  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const index = new IndexArray(indexCount);
  let io = 0;
  let vo = 0;
  for (const g of geometries) {
    const count = g.attributes.position.count;
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) index[io++] = src[i] + vo;
    } else {
      for (let i = 0; i < count; i++) index[io++] = i + vo;
    }
    vo += count;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();

  for (const g of geometries) g.dispose();
  return out;
}
