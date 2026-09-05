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
uniform float uRimEdge;
uniform float uRimSoft;
uniform float uRimStrength;
uniform float uRimWash;
uniform vec3  uFillUp;
uniform vec3  uFillDown;
uniform float uFillDark;
uniform float uLightCeil;
uniform float uBandX;
uniform float uLightKnee;
uniform float uLightPivot;
uniform float uFlat;
uniform float uFlatFar;
uniform float uSpecCap;
uniform vec3  uTeamColor;
uniform float uEnergy;
uniform float uHitFlash;
uniform float uCharge;
uniform float uTime;
uniform float uDissolve;
uniform float uBodyH;
uniform float uRimSizeLo;
uniform float uRimSizeHi;
uniform float uRimFar;
uniform float uRimEdgeFar;
uniform float uRimSoftFar;
uniform float uPaintLift;
uniform vec3  uPaintTint;
uniform float uPaintWhite;
varying vec3 vWorldNormalX;
varying vec3 vWorldPosX;
/**
 * On-screen size of THIS machine, as a fraction of frame height (0..1).
 *
 * Measured per-fragment off the perspective divide, so it costs nothing to
 * plumb: no camera reference, no per-frame CPU update, and it is automatically
 * per-machine because the near and far robot sit at different depths. It is a
 * FRACTION and not a pixel count on purpose, for the same reason
 * OUTLINE_WIDTH is in NDC units — the defect is angular size, and a machine
 * that is 8% of the frame is equally illegible on a phone and on a desktop.
 */
varying float vSizeX;

/**
 * The size gate, 0 at uRimSizeLo and 1 at uRimSizeHi.
 *
 * Declared once and shared, because TWO passes need it and they are injected at
 * different points in the fragment shader — the light governor at
 * lights_fragment_end, the rim at dithering_fragment. Computing it twice from
 * two copies of the same smoothstep is how the near and far machines end up on
 * different gates after somebody tunes one of them.
 */
float sizeGateX() { return smoothstep(uRimSizeLo, uRimSizeHi, vSizeX); }
`;

/**
 * The SMOOTH ("welded") normal, which the shell geometry already carries for the
 * outline hull. This is vertex-shader-only, so it cannot live in RIM_PARS.
 */
const RIM_PARS_VERT = /* glsl */`
attribute vec3 nweld;
vec3 rimNormalX;
`;

/**
 * Pick the normal the RIM is measured against — and it must NOT be the shading
 * normal.
 *
 * This is the whole of why five rounds of rim tuning did nothing for the
 * silhouette. `fres = 1 - dot(n, view)` only reaches 1.0 at the contour if n
 * turns smoothly through it, and the shell is machined boxes with hard face
 * normals: on a plate facing the camera the front face sits at fres ~= 0.05 and
 * its 45-degree chamfer at fres ~= 0.29, both far below a 0.72 band, while the
 * side face that WOULD pass the test is seen edge-on and covers roughly no
 * pixels at all. So the band fired on nothing you could see, at any strength.
 *
 * The welded normals fix it exactly: averaged across coincident vertices they
 * sweep continuously from the face normal to the silhouette, so fres hits 1.0
 * precisely where the machine ends. Lighting keeps the hard normals — a rim
 * measured smooth and a surface shaded flat is what a drawn contour on a
 * machined shape actually is.
 */
const RIM_NORMAL_VERT = /* glsl */`
  rimNormalX = objectNormal;
  {
    // A mesh built without the attribute reads (0,0,0); fall back rather than
    // normalizing a zero vector and painting the shell with NaN.
    vec3 nwX = nweld;
    if (dot(nwX, nwX) > 1e-6) {
      #ifdef USE_SKINNING
        mat4 rimSkinX = mat4(0.0);
        rimSkinX += skinWeight.x * boneMatX;
        rimSkinX += skinWeight.y * boneMatY;
        rimSkinX += skinWeight.z * boneMatZ;
        rimSkinX += skinWeight.w * boneMatW;
        rimSkinX = bindMatrixInverse * rimSkinX * bindMatrix;
        nwX = (rimSkinX * vec4(nwX, 0.0)).xyz;
      #endif
      rimNormalX = nwX;
    }
  }
`;

const RIM_VERT = /* glsl */`
  vWorldNormalX = normalize(mat3(modelMatrix) * rimNormalX);
  vWorldPosX = (modelMatrix * vec4(transformed, 1.0)).xyz;
  {
    // View-space depth, NOT gl_Position.w — identical for a perspective camera
    // but defined at both of this snippet's injection points. (The fallback
    // path below splices RIM_VERT in BEFORE project_vertex, where gl_Position
    // has not been written yet; reading .w there would have sampled whatever
    // the previous stage left behind and made the gate depend on link order.)
    float depthX = max(-(modelViewMatrix * vec4(transformed, 1.0)).z, 1e-3);
    // P11 = 1/tan(fovY/2). NDC height spans 2.0, so halving gives the share of
    // the frame's height this machine covers.
    vSizeX = uBodyH * projectionMatrix[1][1] / depthX * 0.5;
  }
`;

/**
 * Bounce card: a hemispheric fill that always fires, with an extra kick where
 * the machine is receiving nothing at all.
 *
 * Why it exists: measured, the far robot's body sat at luminance 5/255 against
 * a background of 2. It was standing where the key light does not reach, and no
 * edge treatment rescues a machine that is receiving no light — 68% of its
 * contour was invisible.
 *
 * Why it is no longer gated OFF on lit fragments. It used to be, and the reason
 * given was that an unconditional fill would lift the near robot onto the
 * deck's value: the deck measured 88 and the body 78, so the fill would close
 * the last ten levels between them. That argument only holds while the machine
 * is DARKER than the floor it stands on. It is not any more — the paint is cast
 * light on purpose now (see buildPalette) — so the fill is pushing the body
 * further AWAY from the deck's value, not toward it, and the gate was costing
 * exactly the lift the far machine needs. The gate survives as the second term,
 * where it is still the right tool: a machine in an unlit corner gets a stop and
 * a half of bounce that a machine standing in the key does not.
 *
 * It is added to the INDIRECT diffuse, so it is a light and not a paint job: it
 * is multiplied by the albedo, every value break the panel bake and the vertex
 * paint built survives it, and it lands before <aomap_fragment> so the seams
 * and creases stay dark. Up and down are separate colours because a uniform
 * ambient is the flattest possible light and would buy visibility by throwing
 * the machine's volume away.
 */
const FILL_FRAG = /* glsl */`
  {
    const vec3 lumaX = vec3(0.2126, 0.7152, 0.0722);
    float litX = dot(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse, lumaX);
    float darkX = 1.0 - smoothstep(0.0, 0.09, litX);
    float upX = normalize(vWorldNormalX).y * 0.5 + 0.5;
    reflectedLight.indirectDiffuse +=
      diffuseColor.rgb * mix(uFillDown, uFillUp, upX) * (1.0 + uFillDark * darkX);

    // --- the governor ---------------------------------------------------
    //
    // The machine's own light rig, asserting itself over the arena's. Three
    // terms: a lid on the specular, a fill-against-key flatten, and a shoulder.
    //
    // WHY. The same robot, with the same paint, spans 91 levels of luminance in
    // grid, 129 in foundry and 142 in orbital, and photographs at a median of
    // 118 / 118 / 203. A number that moves that far with the backdrop is not a
    // property of the model at all — the arena is deciding how many
    // quantisation bands the machine occupies, and a machine spread across four
    // bands arrives as four-plus masses however few colours are painted on it.
    //
    // The specular lid comes first and is the simplest. Two point practicals
    // sweep the arena to give the robos moving highlights; on a 42px machine a
    // moving highlight is not a highlight, it is a detached bright island in
    // the middle of the body — measured, the far machine's band map was a field
    // of them. Painted armour keeps a sheen, it does not keep a hotspot.
    reflectedLight.directSpecular *= uSpecCap;
    reflectedLight.indirectSpecular *= mix(1.0, uSpecCap, 0.5);
    {
      // --- ILLUMINATION SPACE, and this is the whole trick ----------------
      //
      // three's reflectedLight.*Diffuse is irradiance x BRDF_Lambert, i.e. it
      // is light TIMES PAINT. Every previous attempt at this compressed that
      // product, which is why it kept costing what it bought: pulling the
      // product toward a constant pulls a dark plate and a light plate toward
      // the same value, so the machine flattens by DELETING THE PAINT — the
      // exact value blocking that makes neighbouring plates separate. The
      // review's experiment already proved the paint is not the defect; a fix
      // that quietly removes it is the same mistake spelled backwards.
      //
      // So divide the albedo back out, compress the ILLUMINATION alone, and
      // multiply the paint back in by scaling the original terms. What the
      // machine is made of survives untouched; only how hard the arena is
      // lighting it changes. material.diffuseColor and NOT diffuseColor,
      // because the metalness map has already taken its bite out of the former.
      vec3 dTot = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
      float albX = max(dot(material.diffuseColor, lumaX), 1e-3);
      float lightX = max(dot(dTot, lumaX) / albX, 1e-4);

      // 1. FILL AGAINST KEY. Pull the illumination toward a fixed pivot: the
      //    shadow side comes UP by as much as the key side comes DOWN, so the
      //    machine's median barely moves while the ratio across it collapses.
      //    That is what "raise the fill against the key" is, done as one
      //    expression instead of by re-aiming three arena lights this file does
      //    not own — and unlike a hemisphere light it cannot leak onto the
      //    stage, because it lives inside the shell's own shader.
      //
      //    The pivot is ABSOLUTE, which is what makes the machine stop being a
      //    function of its backdrop: at flatten 1.0 every arena lights the
      //    shell identically, and the 91/129/142 spread would be one number.
      //    Below 1.0 it is a lerp toward that, so the knob really is "how much
      //    of a toy".
      //
      //    Far machines get flattened HARDER than near ones. A 260px hero can
      //    carry modelling that a 40px opponent cannot: at that size a value
      //    step across a pauldron is a detached island, and the same step on the
      //    hero is the shape of a pauldron.
      float flatX = mix(uFlatFar, uFlat, sizeGateX());
      float outX = mix(lightX, uLightPivot, flatX);

      // 2. THE SHOULDER. Unity below the knee, asymptotic to uLightCeil above
      //    it — so a machine standing in shade is not taxed a single level
      //    (which is what the old whole-range Reinhard did, and it cost the
      //    near machine 13 points of contour separation), and no arena can
      //    drive the shell off the top of the scale either.
      if (outX > uLightKnee) {
        float headX = max(uLightCeil - uLightKnee, 1e-3);
        outX = uLightKnee + headX * (1.0 - exp(-(outX - uLightKnee) / headX));
      }

      // 3. BANDING, and this is P2 IMPLEMENTED RATHER THAN IMITATED.
      //
      // Every other route to clause C has been measured and closed: eleven
      // geometry readings, every shading term zeroed, flat shading (which makes
      // it WORSE), the paint (which REDUCES the variance). The arithmetic behind
      // all of those nulls is that per-mass sd is a fixed fraction of the
      // machine's own spread — 0.280 +/- 0.003 against a uniform null of
      // 1/sqrt(12) = 0.289 — and the step is spread-invariant too at 0.328, so
      // the spread CANCELS: ratio = 0.280 / (0.328 / 2) = 1.707 against 1.705
      // measured. The clause does not respond to the value range at all. It
      // responds only to the SHAPE of the histogram, and the shape is uniform.
      //
      // So the lever has to change the shape, and quantising the illumination is
      // the only one that does: it replaces a uniform ramp with a small number
      // of spikes. Every closed lever REMOVES a term; this one keeps the term
      // and quantises it, which is why it is not in the closed set.
      //
      // In ILLUMINATION space, like everything else in this block, so the paint
      // survives — banding light times paint would band the plates together and
      // be the flattening mistake this comment block already warns about.
      //
      // The band edge is softened by its own screen-space derivative, so a band
      // boundary crossing a curved plate is a line rather than a staircase.
      //
      // ---------------------------------------------------------------------
      // ROUND 28 SWEPT IT AND IT IS CLOSED. uBandX SHIPS AT 0. DO NOT RE-SWEEP.
      // ---------------------------------------------------------------------
      //
      // Round 24 named this the one lever that changes the SHAPE of the
      // within-mass luminance histogram rather than removing a term, and set the
      // test: near ratio under 1.35, clause A top-4 at or above 85.0 on both
      // machines, clause B not below 84.6. Seven points were measured on bundle
      // fc777480 with the plumbing repaired (INSTRUMENT FAULT 29 — the earlier
      // readings were the control repeated). NO N PASSES:
      //
      //     N        1      2      3      4      6      8     12    ctl
      //     C near 1.925  1.783  1.876  1.674  1.707  1.717  1.708  1.706
      //     A near  81.7   84.6   85.0   84.5   85.4   85.3   85.3   85.2
      //     B       ----   83.7   84.8   81.3   84.8   84.8   84.8   84.8
      //
      // The lever renders — at N=1 the machine blows out and every clause moves
      // hard — but the number clause C reads does not respond to it. Per-mass sd
      // at step 51 is 44.2 / 43.6 / 44.3 / 44.3 / 44.3 / 44.2 across N=2..12
      // against 44.2 at the control, and the whole eight-step sd curve overlays
      // the control to within a level. The best ratio, 1.674 at N=4, is a
      // 0.032 move inside a 0.05 round-trip floor and it comes entirely from the
      // between-mass GAP, not from a flatter mass — and it costs 0.7 of clause A
      // and 3.5 of clause B. sd stays 0.280 +/- 0.003 of the machine's own
      // spread at every N, which is round 24's constant exactly.
      //
      // Why: the meter blurs the near machine at sigma 8.84 px before it
      // segments, and this band edge is softened by fwidth on top of that. The
      // far machine, blurred at sigma 2.47, moves its sd about four times as far
      // (27.6 to 29.6) — and UPWARD. A staircase integrated by a kernel wider
      // than its tread is the ramp again.
      //
      // Kept at 0 rather than deleted so the numbers above sit on the mechanism
      // they describe. It is not a knob to sweep; it is a closed result.
      if (uBandX > 0.5) {
        float g = clamp(outX / max(uLightCeil, 1e-3), 0.0, 1.0) * uBandX;
        float fl = floor(g);
        float w = clamp(fwidth(g), 1e-4, 0.5);
        outX = (fl + smoothstep(0.5 - w, 0.5 + w, g - fl)) / uBandX * uLightCeil;
      }

      // Clamped because albX is a floor, not a measurement: on a fully metallic
      // fragment the diffuse response is zero and the ratio is meaningless.
      // Scaling zero by anything is still zero, but only if "anything" is
      // finite.
      float scaleD = clamp(outX / lightX, 0.0, 8.0);
      reflectedLight.directDiffuse *= scaleD;
      reflectedLight.indirectDiffuse *= scaleD;
    }
  }
`;

const RIM_FRAG = /* glsl */`
  vec3 nWorldX = normalize(vWorldNormalX);
  vec3 viewDirX = normalize(cameraPosition - vWorldPosX);
  float fres = 1.0 - clamp(dot(nWorldX, viewDirX), 0.0, 1.0);

  // A rim is a LIGHT CATCHING AN EDGE, so it has to have an edge of its own.
  // pow(fres, k) is a smooth ramp that covers half of every plate on the model
  // and reads as tinted glass — that is defect #5, and no amount of turning it
  // down fixes it, because turning it down just makes a dimmer glass. A
  // smoothstep band only covers the last few degrees before the silhouette, so
  // it reads as a contour catching a light. Same uniform, opposite result.
  //
  // The band's WIDTH has to be read together with which normal feeds it. On the
  // hard face normals this used to run on, "the last few degrees before the
  // silhouette" was a set of polygons that are edge-on to the camera and cover
  // no pixels, so the band was invisible however hard it was driven. On the
  // welded normals it is a genuine ring, but a ring whose width is set by the
  // chamfer radius — 0.02-0.045 m, under a pixel on a robot 40 px tall. Measured
  // at 0.72/0.24 the contour got WORSE than the broken version (54.6% -> 65.8%
  // invisible), because a correct rim nobody can see loses to an incorrect one
  // that at least lit whole side faces. So the band is opened up to cover the
  // outer part of the turn rather than the last sliver of it.
  // ...and the band's width is itself a function of ON-SCREEN SIZE, which is
  // the whole of the mass fix. See the note under the size gate below.
  float sizeKX = sizeGateX();
  float edgeX = mix(uRimEdgeFar, uRimEdge, sizeKX);
  float softX = mix(uRimSoftFar, uRimSoft, sizeKX);
  float rim = smoothstep(edgeX, min(edgeX + softX, 1.0), fres);

  // Biased to the upper and outer edges. A rim that wraps the underside as
  // hard as the shoulders is an ambient wash with no direction in it, and the
  // eye reads directionless brightness on a curved surface as translucency.
  //
  // The floor is 0.44 and not the 0.26 it was, because the bias was over-taxing
  // the half of the contour that needs the rim most. From a raked arena camera
  // the machine's lower silhouette is all downward-facing: pauldron undersides,
  // armpits, skirt, thigh blocks. Mapped against the meter, that arc was where
  // essentially all of the surviving invisible contour lived. The translucency
  // read the bias was guarding against came from a rim that was a full-plate
  // pow() ramp; this one is a band a few degrees wide with a hard dark hull
  // drawn immediately outside it, which is a lit edge, not a glow through.
  rim *= 0.44 + 0.56 * clamp(nWorldX.y * 0.85 + 0.50, 0.0, 1.0);

  // --- the rim becomes a LINE as the machine gets smaller ------------------
  //
  // Measured: zeroing the rim alone takes the far machine from 6.5 masses to
  // 5.0 and its luminance spread from 150 levels to 112, while the near machine
  // barely moves (4.3 -> 3.7). Nothing else in the shell's light path comes
  // close — the diffuse ceiling, swept over a factor of three, moved the spread
  // by nine levels. The rim is the largest single term in the mass count.
  //
  // WHY it is the far machine specifically. The fresnel term does not know the
  // difference between the machine's silhouette and the turn-away of an
  // interior plate, and the shell is thirty chamfered boxes. On the 260px hero
  // each interior chamfer's rim is a legible drawn edge describing a real form.
  // On the 39px opponent the SAME band is several percent of the body, there
  // are thirty of them, and they arrive as a field of detached bright islands —
  // exactly what the mass meter counts. Identical code; a lit edge at one size
  // and noise at the other.
  //
  // WHAT DOES NOT WORK, and it was measured before it was believed: simply
  // turning the rim DOWN at distance. At a far gain of 0.22 the mass count fell
  // (grid 6.5 -> 5.7) and the contour went with it — the far machine's
  // invisible fraction rose 9.4% -> 11.9% in grid, 25% -> 30.9% in foundry,
  // 12.9% -> 15.1% in orbital, and separation dropped in all three. The rim is
  // genuinely buying the far machine's edge, so the brightness has to stay.
  //
  // WHAT WORKS is to change the band's SHAPE rather than its level. Near, the
  // band is wide (0.40..1.00) and reads as shading down the outer third of
  // every plate — correct on a machine whose plates are 40px across. Far, it is
  // narrowed to hug the last few degrees before the silhouette and brightened
  // to pay for the pixels it gave up. That keeps the full value step exactly
  // where the contour meter reads it — at the machine's edge — and takes it off
  // the interior chamfers, which is where the mass meter reads it. The earlier
  // finding that a narrow band was invisible (0.72/0.24) is not contradicted:
  // that band was narrowed WITHOUT the compensating gain, so it gave up the
  // pixels and bought nothing with them.
  //
  // Near the rim shades; far it draws a line. That is not a compromise between
  // the two, it is what the reference does.
  rim *= mix(uRimFar, 1.0, sizeKX);

  // Energy veins: a slow band travelling up the body, masked to creases.
  float band = sin(vWorldPosX.y * 5.5 - uTime * 2.4) * 0.5 + 0.5;
  band = pow(band, 6.0);
  vec3 energy = uTeamColor * band * uEnergy;

  // Charge tell: whole shell breathes toward the team colour.
  float pulse = (sin(uTime * 22.0) * 0.5 + 0.5) * uCharge;

  gl_FragColor.rgb += uRimColor * rim * uRimStrength;
  // The soft fresnel is kept, at zero by default, purely as an EVENT channel:
  // invulnerability and the charge tell want the whole shell to glow, and that
  // is the one time the machine is allowed to look like energy.
  gl_FragColor.rgb += uTeamColor * pow(fres, 2.5) * uRimWash;
  gl_FragColor.rgb += energy;
  gl_FragColor.rgb += uTeamColor * pulse * 0.85;
  // THE HIT TELL IS CHROMATIC, NOT LUMINOUS, AND THAT IS THE WHOLE POINT.
  //
  // This was vec3(1.6, 0.9, 0.85). The bright-pass in postfx.js keys on the MAX
  // CHANNEL against a threshold of 1.04 with a 0.16 knee, so a flashed pixel sat
  // at br 1.6 and bled with contrib (1.6 - 1.04) / 1.6 = 0.35. **A machine being
  // hit was itself a bloom source** — the defect RULING 22 is about, emitted by
  // the object whose outline is collapsing.
  //
  // Measured: at 117 ms the opponent's mean luma with the entire VFX layer
  // suppressed is 220 of 255. Before any effect is drawn, the aiming target is
  // nearly white. Two rounds of work on the 68% outline collapse at that age
  // aimed at the effect; the light fix moved it 1.2 points and the throw fix 0.0,
  // because the effect was never what was doing it.
  //
  // 0.88 is threshold minus knee, so a fully flashed pixel contributes exactly
  // nothing to the bright pass rather than a little. The punch that value used to
  // carry is bought back in CHROMA instead — green and blue drop far below the
  // old 0.9/0.85, so the tell reads as a hot red hit rather than a white blowout,
  // and it moves clause D the right way instead of the wrong one.
  //
  // The tell is NOT deleted: RULING 16 applies to it, and a hit that cannot be
  // seen is a worse defect than a hit that blooms. What changed is only which
  // axis it is built on.
  // FINISHED AS A CHROMA TELL. The previous value was half the job and the
  // commit that landed it said so wrongly: "the punch is bought back in chroma"
  // is FALSE, measured — the tell's chroma delta was 0.000. What vec3(0.88,
  // 0.34, 0.30) actually did was stop the tell DESTROYING chroma (-0.113 -> 0),
  // leaving a pure luminance tell at half amplitude, and it missed its own
  // acceptance test: the opponent's pre-effect luma came out 174.5 against a
  // stated 150.
  //
  // 0.34/0.30 sat near the machine's own paint chroma, so mixing toward it
  // changed the hue balance and nothing else. Green and blue now go far below
  // it, which is what makes the pixel MORE chromatic than the armour it is
  // painted over rather than equally so — and being chromatic is what lets the
  // max channel come down to 0.62 while the tell stays obvious. Under 0.88
  // (threshold minus knee) it still contributes exactly nothing to the bright
  // pass, so the machine remains a non-source; the 0.26 of headroom bought by
  // the saturation is spent on the luma the acceptance test asks for.
  // ---------------------------------------------------------------------
  // CLAUSE B — RULING 50's TRANSLATION, AS A SHADER TERM. SHIPS AT ZERO.
  // ---------------------------------------------------------------------
  //
  // RULING 50 priced the only transform that reaches clause B's worst cell: add
  // a constant to the machine and nothing else. On the captured boundary
  // samples a uniform +40 display levels takes all four cells over the 90%
  // threshold (grid near 86.2 -> 92.9, grid far 80.7 -> 100.0, foundry near
  // 74.8 -> 97.7, foundry far 54.5 -> 97.7) and +20 clears neither foundry cell.
  //
  // WHY A TRANSLATION AND NOT THE FLATTEN. The flatten is a CONTRACTION toward a
  // pivot: it moves illumination and explicitly preserves paint, and the failing
  // pixels are paint, which is why sweeping it to 1.0 moved them 0.3 of a level.
  // A translation adds the same constant to every mass, so the per-mass sd and
  // the between-mass step are both unchanged and clause C's ratio is invariant
  // under it by construction — the one guard a value change would be expected
  // to trip.
  //
  // WHY IT IS ADDED ALONG THE PAINT AND NOT ALONG WHITE. RULING 50 named clause
  // D as the risk and named the mechanism: the cheapest way to add 40 levels is
  // to add white, and white costs saturation. Adding lift * tint, with the tint
  // being the machine's own hull colour scaled so its max channel is 1, is
  // exactly a scale of any pixel whose hue already matches it — so
  // 1 - min/max is unchanged and the chroma the clause measures is preserved by
  // construction rather than by hoping.
  //
  // This sits BEFORE the hit tell on purpose. The tell mixes to a fixed 0.62,
  // which is under the bright pass's threshold minus knee so that a flashed
  // machine contributes nothing to bloom; lifting after the mix would push it
  // back over and undo RULING 22's work in a different file.
  //
  // gl_FragColor here is already tone-mapped and colour-space encoded — this
  // block is injected before <dithering_fragment> — so uPaintLift is in display
  // levels over 255 and 40 levels is 0.157. It is a live numeric uniform, which
  // means the acceptance test can be swept with contour.mjs --u and mass.mjs --u
  // without a build per point, and it SHIPS AT 0.0 until that test is passed.
  // THE DIRECTION IS A KNOB BECAUSE THE MEASUREMENT SAID IT HAD TO BE.
  //
  // At uPaintWhite 0 this adds along the machine's own hull hue, which keeps
  // chroma by construction and was the whole design. Measured, it also takes
  // clause A off both machines — near mass count 4.3 -> 6.3, top-4 85.2 -> 79.1
  // — and the reason is clipping. The tint is normalised to luminance 1, so a
  // saturated blue hull carries a blue channel of 2.103 and a lift of 0.157
  // adds 0.33 to blue; every plate already above 0.67 there clips, gains less
  // than the requested forty levels, and separates from the plates that gain
  // all of them. A translation that clips is not a translation.
  //
  // vec3(1.0) has a max channel of 1.0 against that 2.103, so it clips a far
  // smaller share of the machine. Both endpoints have luminance 1 by
  // construction, so the mix does too and uPaintLift keeps meaning display
  // levels at every setting of this. What white costs is chroma, which is
  // clause D's margin of 0.020 — the trade RULING 50 named, with the evidence
  // now pointing the other way down it.
  gl_FragColor.rgb += uPaintLift * mix(uPaintTint, vec3(1.0), uPaintWhite);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.62, 0.08, 0.05), uHitFlash);
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

  // A rim light is a LIGHT, so it is mostly the colour of the source and only
  // slightly the colour of the paint. It also has to buy LUMINANCE: a fully
  // saturated blue contributes 0.07 of it, so a pure team-blue rim on a blue
  // machine is a hue change at the contour and not a value step — which is the
  // only thing the eye reads a silhouette from. Pulled two thirds to white it
  // still says "this robot is the blue one" and actually separates.
  const rimCol = new THREE.Color(look.emissive ?? 0x88ccff).lerp(new THREE.Color(0xffffff), 0.62);

  /**
   * The direction clause B's translation is added along — see the block at the
   * end of RIM_FRAG. It is the machine's own hull colour normalised so its
   * largest channel is 1, which makes `+= lift * tint` a pure SCALE of any
   * pixel already painted that hue, so `1 - min/max` — the chroma clause D
   * measures — comes through unchanged. Adding along white would not, and
   * RULING 50 named that as the risk before any of this was written.
   *
   * `look.primary` rather than the team colour: the team colour is a livery
   * marker on a few plates, and the pixels that fail are hull and `dark`, both
   * of which are `primary` at different lightnesses.
   */
  const paintTint = new THREE.Color(look.primary ?? 0xffffff);
  {
    // NORMALISED BY LUMINANCE, NOT BY THE MAX CHANNEL, AND THE FIRST VERSION OF
    // THIS GOT IT WRONG IN A WAY THE METER CAUGHT IMMEDIATELY.
    //
    // Dividing by the max channel makes `lift` mean "levels added to the
    // brightest channel", which for a saturated blue hull — 0x2e6bd6, whose
    // normalised luminance is 0.476 — delivers 19 levels of LUMINANCE for a
    // requested 40. Measured on foundry at lift 0.157: the far machine went
    // 54.5 to 65.9 where RULING 50's model, which is stated in luminance,
    // predicts 97.7. The transform was right and its unit was not.
    //
    // Dividing by luminance instead leaves the DIRECTION untouched — both
    // normalisations are the same ray — so the pure-scale property that keeps
    // chroma intact is unaffected, and `lift` now means what the ruling means.
    const l = Math.max(0.2126 * paintTint.r + 0.7152 * paintTint.g + 0.0722 * paintTint.b, 1e-3);
    paintTint.setRGB(paintTint.r / l, paintTint.g / l, paintTint.b / l);
  }

  const u = {
    uRimColor: { value: rimCol },
    // Clause B's translation. SHIPS AT 0 — RULING 50 priced it, the acceptance
    // test has not been run, and a knob that has not passed its test does not
    // get to be on by default. In display levels over 255: 40 levels is 0.157.
    uPaintLift: { value: opts.paintLift ?? 0.0 },
    uPaintTint: { value: paintTint },
    // 0 = add along the paint (keeps chroma, clips, breaks clause A),
    // 1 = add along white (clips far less, costs chroma). Numeric so the
    // direction can be swept on both meters without a build per point.
    uPaintWhite: { value: opts.paintWhite ?? 0.0 },
    // uRimEdge/uRimSoft/uRimWash are READ by RIM_FRAG. They were declared in the
    // shader but never supplied here, so WebGL left all three at 0 and the band
    // evaluated as smoothstep(0.0, 0.0, fres) — edge0 == edge1, a divide by zero
    // that clamps to 1.0 for every fragment. The "narrow contour band" was in
    // fact a full-body additive wash of the emissive colour: defect #5 exactly,
    // and most of why the machine photographed as a pale smudge. Supplying them
    // is the whole fix; the GLSL was already right.
    //
    // ---------------------------------------------------------------------
    // MEASURED AND REVERTED: narrowing this band is a clause B regression.
    // Do not retry it without reading the numbers below. (`shots/_massdrive.mjs`
    // clause C + `tools/contour.mjs`, grid @ tier 3, seed 1234567.)
    // ---------------------------------------------------------------------
    //
    // 0.40/0.60 makes the NEAR rim a band across much of every chamfered plate:
    // smoothstep(0.40, 1.00, fres) is on wherever the surface has turned ~66
    // degrees off camera, which is a large share of a rounded machine's area.
    // The first measurement SPEC-CRV2 clause C has ever had lands on it — near
    // machine, per-mass luminance sd 41.2 levels against a between-mass step of
    // 20.3, ratio 4.06 where the clause passes below 1.00. The value variation
    // INSIDE one mass is twice the step BETWEEN masses, and the rim is a
    // measurable part of why: it both adds variance inside a mass and washes
    // out the step between masses.
    //
    // Narrowing the near band to 0.70/0.30 is the largest single improvement
    // available to that ratio — larger than switching off EVERY view-dependent
    // term in the shader put together:
    //
    //     rim/spec/energy/wash all zeroed   ratio 4.06 -> 3.01
    //     this one change                   ratio 4.06 -> 2.73  (gap 20.3 -> 28.7)
    //     clause A top-4 coverage           86.3% -> 87.4%, 87.7% -> 88.8%
    //
    // AND IT IS STILL WRONG, because of what it costs on the clause next door.
    // Built and re-measured from the bundle, not predicted:
    //
    //     clause B clean contour   83.8% -> 81.8%   (robot 1: 85.9% -> 83.5%)
    //     body/background separation  69.5 -> 66.8
    //     invisible boundary        4.5% -> 4.9%
    //
    // Clause C's gain comes from removing rim energy near the silhouette, which
    // is the exact pixels clause B reads. The two are the same lever pulled in
    // opposite directions. Clause B is already six points under its 90% floor,
    // and clause C at 2.73 is still a FAIL — so the trade spends a real
    // regression on a clause that does not change verdict. Reverted.
    //
    // Two escapes were tried and both closed. Compensating with rimStrength
    // 0.10 -> 0.14 recovers rim energy at the edge but drops the near machine's
    // mass count to 3.5 and FAILS clause A. A saturating band (0.60/0.25 or
    // 0.66/0.20, full rim before the silhouette) keeps clause B's edge lift but
    // gives back almost all of clause C's gain: ratio 3.88 and 3.86 against a
    // 4.06 baseline. What buys clause C here is specifically the band NOT
    // reaching full before the silhouette, which is specifically what costs
    // clause B.
    //
    // The lever that has NOT been tried is the up-bias two lines below the
    // smoothstep in RIM_FRAG (`rim *= 0.44 + 0.56 * ...nWorldX.y...`): biasing
    // harder to upward-facing normals would keep the top silhouette a raked
    // camera reads while dropping the rim off plate interiors and undersides.
    // It is a literal in the shader, so no uniform reaches it and it cannot be
    // swept without a rebuild per point. That is the next thing to measure.
    uRimEdge: { value: opts.rimEdge ?? 0.40 },
    uRimSoft: { value: opts.rimSoft ?? 0.60 },
    uRimWash: { value: opts.rimWash ?? 0.0 },
    uRimStrength: { value: opts.rimStrength ?? 0.22 },
    // The machine's height in world units — the reference length vSizeX is
    // measured against. Not a tuning knob: it is a property of the model, and
    // getting it wrong just re-scales the two thresholds below.
    uBodyH: { value: opts.bodyH ?? 2.3 },
    // Frame-height fractions the rim fades between. The near robot photographs
    // at 24-29% of frame height and the far one at 4.8-8.8%, so a band from
    // 0.09 to 0.22 puts the hero on the full rim, the opponent essentially off
    // it, and the transition somewhere no machine in a duel actually sits.
    uRimSizeLo: { value: opts.rimSizeLo ?? 0.09 },
    uRimSizeHi: { value: opts.rimSizeHi ?? 0.22 },
    // The far band, and the GAIN that pays for narrowing it. Above 1.0 on
    // purpose: the band is roughly a third of its near width there, so without
    // the gain the machine's edge loses the value step that the outline hull's
    // dark side is supposed to be stepping against.
    uRimEdgeFar: { value: opts.rimEdgeFar ?? 0.66 },
    uRimSoftFar: { value: opts.rimSoftFar ?? 0.34 },
    uRimFar: { value: opts.rimFar ?? 1.45 },
    // Illumination banding. 0 = off (shipped). See FILL_FRAG step 3.
    uBandX: { value: opts.bandX ?? 0 },
    uFillUp: { value: new THREE.Color(opts.fillUp ?? 0x000000) },
    uFillDown: { value: new THREE.Color(opts.fillDown ?? 0x000000) },
    uFillDark: { value: opts.fillDark ?? 0.0 },
    // The governor — see FILL_FRAG. All four of the light numbers are in
    // ILLUMINATION units (irradiance x Lambert, albedo divided out), not in
    // rendered pixels: 1.0 is roughly a surface square-on to a full-strength
    // key, and the far machine standing in shade sits nearer 0.1.
    uLightCeil: { value: opts.lightCeil ?? 1.15 },
    uLightKnee: { value: opts.lightKnee ?? 0.60 },
    uLightPivot: { value: opts.lightPivot ?? 0.50 },
    uFlat: { value: opts.flat ?? 0.0 },
    uFlatFar: { value: opts.flatFar ?? (opts.flat ?? 0.0) },
    uSpecCap: { value: opts.specCap ?? 0.5 },
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
      .replace('#include <common>', `#include <common>\n${RIM_PARS}\n${RIM_PARS_VERT}`)
      // Must run AFTER skinbase_vertex, which is what builds boneMatX..W.
      .replace('#include <skinnormal_vertex>', `#include <skinnormal_vertex>\n${RIM_NORMAL_VERT}`)
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
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FILL_FRAG}`)
      .replace('#include <dithering_fragment>', `${RIM_FRAG}\n#include <dithering_fragment>`);
    mat.userData.shader = shader;
  };

  mat.userData.u = u;
  mat.customProgramCacheKey = () => 'roboShell';
  return mat;
}

// ---------------------------------------------------------------------------
// The dark frame — the model's line art
// ---------------------------------------------------------------------------

/**
 * The third size-dependent treatment on the machine, and the one the review
 * named that had no owner: *"scale the dark frame line art by on-screen size.
 * At 42px a 2px black seam between plates is 5% of the body, so the line art is
 * itself a mass generator."*
 *
 * The contour got this treatment in `OUTLINE_WIDTH_FAR` — the inverted hull is
 * a screen-space extrusion, so it can literally be drawn thinner. The frame
 * cannot: it is real geometry, forty-nine to sixty-four merged primitives of
 * recess, strut, vent and seam, and its width on screen is whatever the
 * perspective divide says it is. There is no thickness knob to turn.
 *
 * What there is instead is CONTRAST. A seam is line art because it is darker
 * than the plate beside it; the number of masses it generates is a function of
 * how many quantisation bands that step crosses, not of its width. So at
 * gameplay distance the frame is lifted toward the body's own hull tone, and
 * the step it makes against the plate collapses without a single piece of the
 * machine going missing. Near, at the size a hero is inspected at, nothing
 * happens at all and the line art is exactly what it was.
 *
 * It is an ALBEDO change and not a light: it lands at `color_fragment`, before
 * the lighting, so the frame still takes the arena's key, still self-shadows,
 * still catches its env reflection, and still darkens in its own creases. What
 * changes is what colour it was painted, at the one distance where that colour
 * was doing damage.
 *
 * Same gate, same body height and the same fraction-of-frame-height units as
 * the shell's light governor, the rim, and the geometry LOD — see
 * SIZE_GATE_LO in robot.js. Four treatments now read "how big is this machine",
 * and they read it off one band on purpose.
 */
const FRAME_PARS = /* glsl */`
uniform float uFrameBodyH;
uniform float uFrameSizeLo;
uniform float uFrameSizeHi;
uniform float uFrameFade;
uniform vec3  uFrameFadeCol;
varying float vFrameSizeX;
`;

/**
 * Spliced in AFTER project_vertex, where gl_Position has been written. For a
 * perspective camera gl_Position.w is the view-space depth, and NDC height
 * spans 2.0 — the same expression as the contour's `sizeO` and the shell's
 * `vSizeX`, written out rather than shared because the three materials do not
 * share a shader.
 */
const FRAME_VERT = /* glsl */`
  vFrameSizeX = uFrameBodyH * projectionMatrix[1][1] / max(gl_Position.w, 1e-3) * 0.5;
`;

const FRAME_FRAG = /* glsl */`
  {
    float farF = 1.0 - smoothstep(uFrameSizeLo, uFrameSizeHi, vFrameSizeX);
    diffuseColor.rgb = mix(diffuseColor.rgb, uFrameFadeCol, uFrameFade * farF);
  }
`;

/**
 * The machine's dark frame, with the size-gated line-art fade above.
 *
 * Returns a MeshStandardMaterial whose `userData.u` holds the live uniforms, so
 * the fade can be swept against the mass meter in one browser launch instead of
 * one rebuild per value — see the note in RoboModel._build() about publishing
 * this bag on the shell's.
 */
export function roboFrame(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(opts.color ?? 0x333a44),
    roughness: opts.roughness ?? 0.52,
    metalness: opts.metalness ?? 0.68,
    envMap: opts.envMap || null,
    // The frame is the model's line art. A hot env reflection turns black
    // line art into chrome highlight and the lines stop being lines.
    envMapIntensity: opts.envMapIntensity ?? 0.55,
    vertexColors: true,
    dithering: true,
  });

  const u = {
    uFrameBodyH: { value: opts.bodyH ?? 2.3 },
    uFrameSizeLo: { value: opts.sizeLo ?? 0.09 },
    uFrameSizeHi: { value: opts.sizeHi ?? 0.22 },
    uFrameFade: { value: opts.fade ?? 0.0 },
    uFrameFadeCol: {
      value: opts.fadeColor instanceof THREE.Color
        ? opts.fadeColor.clone()
        : new THREE.Color().setRGB(0.32, 0.34, 0.38),
    },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FRAME_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${FRAME_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAME_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAME_FRAG}`);
  };

  mat.userData.u = u;
  mat.customProgramCacheKey = () => 'roboFrame';
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

// One generator for the whole session. Constructing a PMREMGenerator allocates
// its render targets and compiles the blur + GGX shader chain, and disposing it
// throws all of that away — so the old build-one-per-bake pattern paid a full
// shader compile for every arena. That single line was the largest item in the
// boot profile: 7.4 s to enter an arena whose textures were already cached.
let _pmrem = null;
let _pmremRenderer = null;

function pmremFor(renderer) {
  if (_pmrem && _pmremRenderer === renderer) return _pmrem;
  _pmrem?.dispose();
  _pmrem = new THREE.PMREMGenerator(renderer);
  _pmremRenderer = renderer;
  return _pmrem;
}

/** Baked environments, keyed by theme + cube size. Live for the session. */
const _envCache = new Map();

/**
 * An environment map is prefiltered by roughness, so above a certain size the
 * extra texels are blurred away before anything ever samples them. Nothing in
 * the arena is a mirror — the highest envMapIntensity in the whole scene is
 * 0.85 on painted robo armour — so 128 is genuinely the top of the useful
 * range, and the cost of the blur chain scales with the square of this.
 */
function cubeSizeFor(size) {
  return size <= 64 ? 64 : 128;
}

/**
 * Bake the sky into a PMREM environment map.
 *
 * Cached per theme: re-entering an arena, or returning to one you have already
 * played, costs nothing. `Stage.dispose()` deliberately does NOT dispose this —
 * see `disposeEnvCache()` for the teardown path.
 */
export function bakeEnvironment(renderer, theme, size = 128) {
  const cube = cubeSizeFor(size);
  const key = `${theme.key}:${cube}`;
  const cached = _envCache.get(key);
  globalThis.__envLog = (globalThis.__envLog || []).concat(`${key} ${cached ? 'HIT' : 'MISS'}`);
  if (cached) return cached;

  const pmrem = pmremFor(renderer);

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

  // `size` lives in the options bag — passing it positionally (as this used to)
  // silently leaves every tier on the 256 default, which is why LOW and MID
  // were paying ULTRA's environment cost.
  const rt = pmrem.fromScene(scene, 0.04, 0.1, 100, { size: cube });
  sky.geometry.dispose();
  sky.material.dispose();
  bounce.geometry.dispose();
  bounce.material.dispose();

  _envCache.set(key, rt.texture);
  return rt.texture;
}

/** Full teardown. Only for a real shutdown — not for leaving an arena. */
export function disposeEnvCache() {
  for (const t of _envCache.values()) t.dispose();
  _envCache.clear();
  _pmrem?.dispose();
  _pmrem = null;
  _pmremRenderer = null;
}

/** True if this texture belongs to the shared cache and must not be disposed. */
export function isCachedEnv(texture) {
  for (const t of _envCache.values()) if (t === texture) return true;
  return false;
}
