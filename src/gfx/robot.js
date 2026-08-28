/**
 * The Robo: procedural mecha model, rig and animation.
 *
 * Three ideas carry this file:
 *
 *  1. ONE skeleton, a handful of SkinnedMeshes. Every greeble is baked into a
 *     merged buffer and rigidly bound (one bone, weight 1) to the rig segment it
 *     belongs to. Visually identical to a deep Object3D hierarchy, but a whole
 *     robot draws in 5-7 calls instead of forty — which is the difference
 *     between 60fps and 40fps on an A14.
 *  2. Geometry is authored in MODEL space in the rest pose, so the layout code
 *     reads like a blueprint ("chest plate at y=1.14") instead of a stack of
 *     nested local frames. Skinning's bind-inverse does the rest.
 *  3. The rest pose is the combat-ready pose — gun barrel already along +Z at
 *     zero pitch — so aiming is a single delta rotation on the shoulder and the
 *     barrel genuinely points where the sim says it points.
 *
 * update() only writes bone transforms and uniform values. No allocation, ever.
 */

import * as THREE from 'three';
import { mergeGeometries } from './stage.js';
import { armorTexture } from './textures.js';
import { roboShell, additive, ensureAOChannel } from './materials.js';
import { clamp, clamp01, lerp, damp, angleDelta, smoothstep, TAU } from '../core/mathx.js';
// GLSL-style three-argument edge ramp. mathx's smoothstep takes ONE argument,
// so `smoothstep(0.0, 0.62, r)` silently evaluates smoothstep(0.0) — a
// constant — and every ramp written that way collapses to a flat value. That
// is exactly what happened to the two textures below: the contact shadow baked
// as a fully opaque black square and the garage pad baked at 14% alpha, which
// is why the machine stood in a black hole on an invisible floor.
import { smoothstep as ramp } from './noise.js';

// ---------------------------------------------------------------------------
// Scratch — hoisted so the frame loop never allocates.
// ---------------------------------------------------------------------------

const _col = new THREE.Color();
const _sphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 2.6);

/** Fake sim state the garage preview feeds to the shared animation code. */
const _previewState = {
  pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
  yaw: 0, pitch: 0, aimYaw: 0, aimPitch: 0,
  state: 0, grounded: true, moveAmt: 0, stepPhase: 0,
  hurtFlash: 0, charge: 0, chargeReady: 0, boostHeat: 0,
  hp: 1, maxHp: 1, invuln: 0,
};

const TEAM_TINT = [0x3f8fff, 0xff4a5c];

/**
 * Frame/joint metal, picked by the body's trim so parts read as a family.
 *
 * These stay the DARKEST thing on the machine. The exposed armature is the only
 * thing threaded between every pair of armour plates on the model, so it is the
 * machine's line art: dark there means each plate ends somewhere visible. A
 * bright chrome frame between two mid-value plates does the opposite — it welds
 * the whole torso into one blob with a shine on it.
 *
 * But "darkest" is a relationship, not an absolute, and the plates moved. At
 * metalness 1.0 a material has NO diffuse response at all, so these rendered as
 * pure reflections of a night sky — 4-10/255 — which was a sensible line weight
 * under armour at 40-70 and is a hole punched through armour at 115. On the
 * shoulder yoke, which spans the whole top of the torso, it photographed as a
 * black slot cut across the machine.
 *
 * The fix is to let the frame receive light rather than to make it shiny:
 * metalness comes off 1.0 so there is a little diffuse to catch the key, and the
 * base colours come up to match. Measured, that puts the armature around 28/255
 * against plates at 115 — still a full two stops down, still unambiguously the
 * line and not the form, and no more chrome than before (less, in fact: the
 * specular share of the response went DOWN).
 */
const TRIM = {
  chrome:   { color: 0x424b5a, rough: 0.40, metal: 0.70 },
  gunmetal: { color: 0x333a44, rough: 0.52, metal: 0.68 },
  brass:    { color: 0x54462a, rough: 0.46, metal: 0.72 },
  obsidian: { color: 0x232833, rough: 0.30, metal: 0.75 },
};

// ---------------------------------------------------------------------------
// Paint
//
// The armour skin is baked NEUTRAL (see NEUTRAL_LOOK) and every scrap of hue and
// value on the shell comes from per-vertex paint instead. That buys three things
// a single-texture robo cannot have:
//
//  1. Hard colour blocking between armour GROUPS rather than between whichever
//     UV panels the splitter happened to land on. Head, pauldron, chest and
//     forearm can each be a different value on purpose.
//  2. A dark wash under and behind every hero plate, so neighbouring plates
//     separate instead of merging into one silhouette.
//  3. A baked top-plane / side-plane / underside ramp, which is what makes a
//     painted model read as a solid volume even when the arena light is flat.
//     Without it, overlapping plates at identical value read as one translucent
//     mass — the "blue glass" failure.
// ---------------------------------------------------------------------------

/**
 * Ceiling on baked albedo. The concern is that the key light drives the top
 * planes into a flat clipped white and the value structure the paint builds
 * disappears at the top end.
 *
 * Recomputed after the palette was re-cast light. The lightest role now tones
 * to sRGB L 0.93 = 0.85 linear, and 0.85 * 0.90 * 1.34 (max plane gain) = 1.02,
 * which reads as over the line — but that is only two thirds of the chain. The
 * vertex paint is multiplied by armorTexture's albedo, which is a neutral
 * DETAIL bake sitting around 0.80 sRGB = 0.60 linear across the machine and
 * reaching 1.0 nowhere, so the real product on the brightest top face of the
 * lightest plate is about 0.62. The headroom is in the map, not in this number,
 * and it is why the value ladder could move up a stop and a half without the
 * highlights flattening.
 */
const PAINT_GAIN = 0.90;

/**
 * The baked plane ramp: top faces lift, undersides crush, side faces are the
 * reference. Both numbers are now roughly half what they were (0.34 / 0.42),
 * and this is the LARGEST of the mass-count fixes — larger than the palette
 * collapse under it.
 *
 * Why. Measured on the pinned fight frame, the player's body spans p2..p98 =
 * 76..167 in luminance, a spread of ninety levels. Collapsing eight paint roles
 * to four barely touched that number, because the paint roles were never what
 * set it: at 0.34/0.42 a plate's top face is painted 1.34x its side and its
 * underside 0.58x, a 2.3:1 ratio inside ONE plate — wider than the entire
 * distance from `dark` to `light`. Every chamfered box on the machine therefore
 * arrived carrying three tones of its own, and a machine of thirty such boxes
 * is a mosaic no matter how few colours the palette names.
 *
 * It is also a duplicate. The arena's key light already lifts top faces and
 * shades undersides — that is what a light does — so a baked copy of the same
 * cue is the second application of an effect the renderer is already applying.
 * Halved, the cue survives (stacked plates still separate, which is what it was
 * added for) and stops out-shouting the paint.
 *
 * The DOWN half was already eased once, from 0.66, because painting a downward
 * face at a third of its plate's value is right for a plate you look down ON and
 * wrong for one whose underside IS the silhouette: on a raked arena camera the
 * pauldron undersides, armpits, skirt and thigh blocks are most of the outline's
 * lower half, and mapped, essentially all the surviving invisible contour lived
 * there. Easing it further pushes the same way, so this cannot cost contour.
 */
const PLANE_UP = 0.17;
const PLANE_DOWN = 0.21;

/** Lens/strip brightness. Above ~1.7 these stop reading as glass and bloom flat. */
const EMIS_GAIN = 0.45;
const FLARE_GAIN = 0.60;

/**
 * armorTexture() bakes a part's colours straight into its albedo, which leaves
 * every plate on the machine at the same value. Feeding it a white/grey look
 * turns it into a pure DETAIL map — panels, seams, bevels, rivets, brushed
 * grain, wear — and hands every hue and value decision to the vertex paint,
 * which is authored per part. One bake then serves every robo in the match, so
 * this is also three fewer texture uploads per machine.
 */
const NEUTRAL_LOOK = {
  primary: 0xe6e8ea, secondary: 0xffffff, accent: 0xc6cad0, trim: 'chrome',
  metalness: 0.85, roughness: 0.50,
};

const _hsl = { h: 0, s: 0, l: 0 };

/**
 * Re-value a roster colour to a TARGET LIGHTNESS, keeping its hue and at least
 * `satMin` of its chroma. Returns a linear swatch pre-scaled by PAINT_GAIN.
 *
 * Why the roster colours are not used as authored. `parts.js` picks each body's
 * primary for identity — RAY is a mid-dark tournament blue at sRGB L 0.51,
 * NOCTURNE is near-black at L 0.14 — and multiplying an already-dark hue by a
 * shadow factor leaves nothing. Measured on the pinned frame, the local machine
 * sat at 59/255 on a deck at 97 and the far machine at 50 in front of a wall at
 * 37: BOTH robots had been painted the value of the thing behind them, which is
 * defect #24 stated exactly.
 *
 * The reference this game is chasing solves it with a casting decision rather
 * than a shader: saturated, LIGHT toys, with a hard dark line drawn round them.
 * A light body separates from the arena's near-white deck AND from its black
 * service wall, because the outline supplies the dark half of the step in both
 * places — and neither is true of a mid-dark body. So the roster keeps naming
 * the hue and the palette decides the value, per role, identically for every
 * body in the roster. NOCTURNE comes out as a light violet-grey machine rather
 * than an invisible one, which is what "assassin" has to look like in a game
 * where you can still see it.
 */
function tone(hex, l, satMin, mul = 1) {
  _col.setHex(hex);
  _col.getHSL(_hsl, THREE.SRGBColorSpace);
  _col.setHSL(_hsl.h, clamp01(Math.max(_hsl.s, satMin)), clamp01(l), THREE.SRGBColorSpace);
  const k = PAINT_GAIN * mul;
  return { r: _col.r * k, g: _col.g * k, b: _col.b * k };
}

/**
 * Nine ROLES, but only FOUR VALUES. That distinction is the whole of this
 * table and it is worth stating before the numbers.
 *
 * WHY IT COLLAPSED. Measured with the review's own rule — blur at a radius
 * scaled to the machine's on-screen size, quantise to five value bands, count
 * the connected regions above 3% of the body — the machines came back at 8
 * masses (player, 160x260px) and 10 (opponent, 39x77px) against a Custom Robo
 * V2 reference that returns four or five. The opponent, drawn with a tenth of
 * the player's pixels, was the MORE fragmented of the two, which is backwards:
 * the machine you have the fewest pixels to describe is the one that has to be
 * described in the fewest pieces.
 *
 * The cause was that every role carried its own VALUE. hull 0.74, hullLo 0.58,
 * accent 0.68, leg 0.88, legLo 0.70, gunmetal 0.72, light 0.93, dark 0.33 —
 * eight rungs, sprayed across a machine whose separate plates are each a few
 * pixels wide at gameplay distance. That is per-panel variety, and it is what a
 * model kit has and a toy does not. An earlier round widened this deliberately
 * to fix a mushy silhouette; internal contrast was the right idea and it was
 * overshot.
 *
 * So the ladder keeps its rungs and loses its steps. The roles still exist,
 * still name what a plate is for, and still carry their own HUE — the accent is
 * still the accent colour up close in the garage. What they no longer do is
 * each occupy a separate value band at 40 pixels. Four values remain:
 *
 *    dark   0.52   line art: recesses, the wash behind a hero plate
 *    body   0.74   hull, hullLo, accent, gunmetal — the machine's mass
 *    leg    0.86   the leg group, one value from hip to toe
 *    light  0.93   hero plates: chest crest, shoulder caps, shin faces
 *
 * Which is torso+arms, legs, hero plates, and the dark that separates them —
 * four masses, arranged as a machine rather than as a mosaic.
 *
 * WHERE THE LADDER SITS, and why it moved.
 *
 * The previous ladder — 0.88 / 0.68 / 0.44 / 0.17 — was authored as "roughly a
 * stop between neighbours" and it is a perfectly good ladder. It is in the
 * wrong PLACE. Measured on the pinned fight frame, the machine's body came out
 * at a median of 85 while the deck it stands on measured 96: the actor was
 * painted darker than the scenery. The reference this game is chasing does the
 * opposite without exception — its robots are saturated LIGHT toys and the
 * stage is deliberately duller and darker than they are, so the eye lands on
 * the fight and not on the floor.
 *
 * The whole ladder is therefore shifted up, and the deck is left exactly where
 * it is (it belongs to the stage and is not ours to darken). Two consequences
 * are deliberate:
 *
 *  - THE RUNGS ARE CLOSER TOGETHER at the top. hull/light was 0.20 apart and is
 *    now 0.11. That is not a loss of structure, it is the fix for the second
 *    half of the same complaint: at 42x79 px the old spread turned the shoulder
 *    caps and the chest crest into detached PALE BLOCKS floating on a dark
 *    machine instead of highlights on a light one. Four or five big masses in
 *    clearly different values is the read we want; nine small ones in wildly
 *    different values is what we had.
 *  - `dark` STOPS BEING A HOLE. At 0.17 the recesses and the wash behind every
 *    hero plate rendered at 15-40/255 on the title rig, which is what made the
 *    emissive trim look like glowing wire around a void (#5's residual). At
 *    0.34 it is still comfortably the darkest paint on the machine — a full
 *    stop under the hull — but it now reads as shadowed machinery.
 *
 * Chroma goes up with value, not down. Lightening a colour in HSL costs
 * saturation for free unless you ask for it back, and "the blue one" and "the
 * pink one" have to survive being cast light.
 */
function buildPalette(look, legColour) {
  return {
    // The machine's mass, and the value the whole frame is judged on. This has
    // to sit ABOVE the arena deck, which measures ~96/255 in the pinned frame.
    //
    // WHERE THE CHROMA COMES FROM, and what it costs. Lightness and saturation
    // trade against each other and there is a hard ceiling: in HSL at L 0.82 no
    // colour can exceed an HSV chroma of 0.36 whatever you set S to, so the
    // first pass up the value ladder bought "brighter than the deck" and paid
    // for it in hue — the machine photographed as a pale grey-white blob, which
    // wins the value half of the brief and loses the other half. Backing the
    // hull off to 0.74 and asking for the chroma back doubles it (0.22 -> 0.45
    // measured on RAY's blue) for 14% of the luminance, and 14% is affordable
    // because the white plates carry the top of the machine.
    hull: tone(look.primary, 0.74, 0.82),
    // Same hue, a breath of shade. Carries the upper arms, the forearm cuffs,
    // the rear skirt and the whole backpack — which is to say the pieces that
    // WRAP the torso, so if it is a separate value the torso group arrives in
    // two halves. At 0.58 it was two thirds of a stop under the hull and did
    // exactly that: measured, the player's back plate and its upper arms landed
    // in different quantisation bands and counted as separate masses. At 0.72
    // it is inside the hull's band at gameplay size and still a visible turn of
    // the form in the garage, which is the only place anybody can see it.
    hullLo: tone(look.primary, 0.72, 0.86),
    // Hero plates: chest crest, shoulder caps, shin faces. This role stays
    // near-white on purpose — a toy robot's white plastic is white, and it is
    // what gives the saturated plates something to be saturated against.
    light: tone(look.secondary, 0.93, 0.10),
    // The model's line art: recesses, seams, the wash behind every hero plate.
    // This is the one role that stays genuinely dark — it keeps its hue so a
    // recess reads as shadowed machinery rather than as a hole cut in the model.
    // Driven to full chroma, which costs it nothing in value (a saturated dark
    // blue and a greyed one measure the same luminance) and stops the recesses
    // reading as soot.
    //
    // Raised again, from 0.33, and this is the half of the fix that is visible
    // in a still. `dark` is not only used for creases: the chest's back plate,
    // the pelvic block, the head's jaw and the thigh's rear blocks are all
    // painted with it, and they are BIG. At 0.33 the player photographed with a
    // near-black slab across the middle of its own torso — a hole with a lit
    // machine drawn round it, which is #5's residual seen from the outside. At
    // 0.52 it is still a clear stop under the hull and still the darkest paint
    // on the machine, but a large piece of it now reads as shadowed armour
    // instead of as absence.
    dark: tone(look.primary, 0.52, 0.86),
    // The accent keeps its HUE and gives up its VALUE. Its plates are the
    // knee caps, elbow tapers, head crest, toe claws, chest fin: eight or nine
    // small scattered pieces, which is precisely the per-panel variety that has
    // to go. Sitting on the hull's rung it is a colour note on a solid mass in
    // the garage and invisible as a separate mass at 40px, which is the right
    // answer at both distances.
    accent: tone(look.accent, 0.74, 1.0),
    leg: tone(legColour, 0.88, 0.10),
    // Formerly a full stop under the leg, which split every leg into a light
    // front and a dark side and gave the machine four masses below the waist.
    // Held just under `leg` so the thigh and shin plates still turn against
    // their own greebles without the leg group coming apart.
    legLo: tone(legColour, 0.84, 0.14),
    // Weapons are hardware: a neutral grey that belongs to no part's colour
    // scheme, so the gun reads as bolted-on rather than moulded in. It matches
    // the hull's VALUE — desaturation is what separates it, and desaturation
    // survives being 40 pixels tall in a way a value step does not.
    gunmetal: tone(0x9aa6b4, 0.74, 0.06),
    frame: { r: PAINT_GAIN, g: PAINT_GAIN, b: PAINT_GAIN },
  };
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/**
 * Rounded/chamfered box via clamp-to-inner-box + radius*normalize.
 *
 * A uniform BoxGeometry grid puts every vertex on a face plane or an edge line,
 * so the clamp alone would pillow the faces. Remapping the grid first — the two
 * outer rings land ON the corner arc, the inner ring sits exactly on the inner
 * box — keeps the flat faces genuinely flat and the bevels crisp.
 *
 * @param arc 1 = single 45-degree chamfer (the workhorse), 2 = smoother round.
 */
function roundedBox(w, h, d, r = 0.02, arc = 1) {
  const rad = Math.min(r, Math.min(w, h, d) * 0.48);
  const seg = 2 * arc + 1;
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);

  const table = (H) => {
    const t = new Float64Array(seg + 1);
    for (let i = 0; i <= seg; i++) {
      const j = i <= arc ? i : seg - i;
      const v = (H - rad) + rad * Math.cos((j * Math.PI) / (2 * arc));
      t[i] = i <= arc ? -v : v;
    }
    return t;
  };
  const tx = table(w * 0.5), ty = table(h * 0.5), tz = table(d * 0.5);
  const snap = (q, H, t) => t[Math.round(((q + H) / (2 * H)) * seg)];

  const ix = w * 0.5 - rad, iy = h * 0.5 - rad, iz = d * 0.5 - rad;
  const p = g.attributes.position, n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = snap(p.getX(i), w * 0.5, tx);
    const y = snap(p.getY(i), h * 0.5, ty);
    const z = snap(p.getZ(i), d * 0.5, tz);
    const cx = x < -ix ? -ix : x > ix ? ix : x;
    const cy = y < -iy ? -iy : y > iy ? iy : y;
    const cz = z < -iz ? -iz : z > iz ? iz : z;
    let dx = x - cx, dy = y - cy, dz = z - cz;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l; dy /= l; dz /= l;
    p.setXYZ(i, cx + dx * rad, cy + dy * rad, cz + dz * rad);
    n.setXYZ(i, dx, dy, dz);
  }
  p.needsUpdate = true;
  n.needsUpdate = true;
  return g;
}

const cyl = (rt, rb, h, rad = 10, open = false) =>
  new THREE.CylinderGeometry(rt, rb, h, rad, 1, open);

const ringGeo = (R, r, rad = 12, tub = 6) => new THREE.TorusGeometry(R, r, tub, rad);

const ball = (r, seg = 8) => new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1));

const disc = (r, rad = 14) => new THREE.CircleGeometry(r, rad);

/** Chamfered box spanning two points in the sagittal (YZ) plane at a fixed x. */
function segBox(x, y0, z0, y1, z1, w, d, r, arc) {
  const dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dy, dz) || 0.001;
  const g = roundedBox(w, len, d, r, arc);
  g.rotateX(Math.atan2(dz, dy));
  g.translate(x, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/** Trapezoidal plate — the fastest way to stop a greeble reading as a box. */
function taperBox(wTop, wBot, h, dTop, dBot, r, arc) {
  const g = roundedBox(Math.max(wTop, wBot), h, Math.max(dTop, dBot), r, arc);
  const p = g.attributes.position;
  const kw = wBot === 0 ? 0 : wTop / wBot;
  const kd = dBot === 0 ? 0 : dTop / dBot;
  for (let i = 0; i < p.count; i++) {
    const t = clamp01(p.getY(i) / h + 0.5);
    p.setX(i, p.getX(i) * lerp(1, kw, t));
    p.setZ(i, p.getZ(i) * lerp(1, kd, t));
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * MEAN PROJECTED AREA of one primitive, in square metres. The size number the
 * silhouette LOD is built on.
 *
 * Cauchy's surface-area formula: averaged over all viewing directions, the area
 * a CONVEX body projects is exactly one quarter of its surface area. Every
 * primitive on this machine is a box, a taper, a cylinder, a sphere or a torus,
 * so for all but the torus that is not an approximation — and it is the only
 * cheap size metric that survives the shapes this model is actually made of.
 *
 * Why not the obvious ones, both of which were tried on paper against the parts
 * list and both of which get the answer backwards on real pieces:
 *
 *   - Bounding-sphere DIAMETER. The head antenna is a 16 cm rod 6 mm thick; its
 *     diameter is 0.16, the same as a hand-sized armour plate's. It would be
 *     kept at every size, and it is the single worst greeble on the machine —
 *     measured, it is 0.26 px wide on the far robot and stretches that robot's
 *     silhouette 17% taller than its shell.
 *   - SMALLEST extent. A chest plate is 39 x 36 x 9 cm; its smallest extent is
 *     the 9 cm thickness, which is under a pixel at gameplay range. It would be
 *     dropped, and it is most of the machine's front.
 *
 * Area gets both right because area is what "can you see it" actually means:
 * the antenna projects 0.0021 m^2 and the chest plate 0.104, a factor of fifty,
 * where the two extent metrics put them within a factor of two of each other.
 *
 * Non-convexity only costs accuracy on the tori (a ring's real projection is
 * about a third of S/4, because Cauchy counts the hole's inner wall). That errs
 * toward KEEPING a ring, which is the safe direction for a part that is often
 * the only accent colour on a limb.
 */
function meanProjectedArea(g) {
  const p = g.attributes.position;
  if (!p || p.itemSize !== 3 || p.isInterleavedBufferAttribute) return Infinity;
  const a = p.array;
  const idx = g.index;
  const n = idx ? idx.count : p.count;
  const get = idx ? (i) => idx.array[i] * 3 : (i) => i * 3;
  let s2 = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    const o0 = get(i), o1 = get(i + 1), o2 = get(i + 2);
    const ux = a[o1] - a[o0], uy = a[o1 + 1] - a[o0 + 1], uz = a[o1 + 2] - a[o0 + 2];
    const vx = a[o2] - a[o0], vy = a[o2 + 1] - a[o0 + 1], vz = a[o2 + 2] - a[o0 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    s2 += Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  // sum(|u x v|) is twice the surface area, and Cauchy wants a quarter of it.
  return s2 * 0.125;
}

/**
 * Averaged ("welded") vertex normals, returned as a loose Float32Array.
 *
 * These are not for lighting — the shell wants its hard face normals, or every
 * chamfer turns to mush. They exist for the OUTLINE hull, which extrudes the
 * shell along its normals: extruding a hard-edged box along per-face normals
 * tears the hull open at every corner and the outline arrives as a dashed line
 * with a notch at each edge. Averaging the normals of coincident vertices seals
 * it, which is the whole trick to putting an outline on machined geometry.
 *
 * Run per PRIMITIVE, before the merge, so two unrelated plates that happen to
 * touch keep their own outlines instead of fusing into one blob.
 *
 * The key packs a 0.5 mm lattice (±4 m) into one exactly-representable double,
 * which is a good deal faster than string keys on ~15k vertices at boot.
 */
const WELD_Q = 2048, WELD_HALF = 8192, WELD_SPAN = 16384;

function weldedNormals(g) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const c = p.count;
  const out = new Float32Array(c * 3);
  if (!n) return out;

  const sums = new Map();
  const keys = new Float64Array(c);
  for (let i = 0; i < c; i++) {
    const qx = Math.round(p.getX(i) * WELD_Q) + WELD_HALF;
    const qy = Math.round(p.getY(i) * WELD_Q) + WELD_HALF;
    const qz = Math.round(p.getZ(i) * WELD_Q) + WELD_HALF;
    const k = (qx * WELD_SPAN + qy) * WELD_SPAN + qz;
    keys[i] = k;
    let s = sums.get(k);
    if (!s) { s = [0, 0, 0]; sums.set(k, s); }
    s[0] += n.getX(i); s[1] += n.getY(i); s[2] += n.getZ(i);
  }

  for (let i = 0; i < c; i++) {
    const s = sums.get(keys[i]);
    const l = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
    // A vertex whose neighbours cancel out — the two faces of a paper-thin
    // plate — has no meaningful average, so it keeps its own normal.
    if (l > 1e-3) {
      out[i * 3] = s[0] / l; out[i * 3 + 1] = s[1] / l; out[i * 3 + 2] = s[2] / l;
    } else {
      out[i * 3] = n.getX(i); out[i * 3 + 1] = n.getY(i); out[i * 3 + 2] = n.getZ(i);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rig — bones are declared by their REST WORLD transform, which keeps the
// layout table readable. Rest rotations are pure-X so the local conversion is
// exact and limb geometry can be built with segBox().
// ---------------------------------------------------------------------------

class Rig {
  constructor() {
    this.bones = [];
    this.index = Object.create(null);
    this.world = [];
  }

  add(name, parent, wx, wy, wz, wrx = 0) {
    const b = new THREE.Bone();
    b.name = name;
    const i = this.bones.length;
    this.index[name] = i;
    this.world[i] = { x: wx, y: wy, z: wz, rx: wrx };

    if (parent == null) {
      b.position.set(wx, wy, wz);
      b.rotation.x = wrx;
    } else {
      const p = this.world[this.index[parent]];
      const dx = wx - p.x, dy = wy - p.y, dz = wz - p.z;
      const c = Math.cos(-p.rx), s = Math.sin(-p.rx);
      b.position.set(dx, dy * c - dz * s, dy * s + dz * c);
      b.rotation.x = wrx - p.rx;
      this.bones[this.index[parent]].add(b);
    }

    // Animation targets are deltas on top of the rest pose.
    b.rx0 = b.rotation.x;
    b.px0 = b.position.x; b.py0 = b.position.y; b.pz0 = b.position.z;
    this.bones.push(b);
    return b;
  }

  id(name) { return this.index[name]; }
  get(name) { return this.bones[this.index[name]]; }
}

// ---------------------------------------------------------------------------
// Builder — collects geometry into per-material buckets and rigid-binds it.
// ---------------------------------------------------------------------------

const UV_SCALE = 0.78;

class Build {
  constructor(rig, opts) {
    this.rig = rig;
    this.arc = opts.arc;
    this.rad = opts.radial;
    this.low = opts.low;
    // A missing palette must degrade to a visible (if wrong-coloured) robot
    // rather than throwing halfway through the layout tables and taking the
    // whole boot with it.
    this.pal = opts.pal || buildPalette(NEUTRAL_LOOK, 0xdfe6ef);
    // Overrides the per-group default paint for a run of parts — set while the
    // weapon builders run so hardware paints itself without every call site
    // having to name a colour.
    this.def = null;
    // One shell bucket: with hue carried per-vertex there is no longer any
    // reason for torso/arms/legs to be three materials and three draw calls.
    this.buckets = { shell: [], frame: [], emis: [], flare: [] };
    // Mean projected area of each primitive, index-parallel to its bucket. The
    // silhouette LOD sorts on this; see buildLodTable().
    this.areas = { shell: [], frame: [], emis: [], flare: [] };
  }

  /**
   * Triplanar-ish planar UVs taken in model space, so panel layouts flow across
   * neighbouring pieces instead of restarting on every box.
   */
  _uv(g) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    let uv = g.attributes.uv;
    if (!uv) {
      uv = new THREE.BufferAttribute(new Float32Array(p.count * 2), 2);
      g.setAttribute('uv', uv);
    }
    for (let i = 0; i < p.count; i++) {
      const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
      let u, v;
      if (nx >= ny && nx >= nz) { u = p.getZ(i); v = p.getY(i); }
      else if (ny >= nz) { u = p.getX(i); v = p.getZ(i); }
      else { u = p.getX(i); v = p.getY(i); }
      uv.setXY(i, u * UV_SCALE, v * UV_SCALE);
    }
    uv.needsUpdate = true;
  }

  _skin(g, bone) {
    const c = g.attributes.position.count;
    const si = new Float32Array(c * 4);
    const sw = new Float32Array(c * 4);
    const b = this.rig.id(bone);
    for (let i = 0; i < c; i++) { si[i * 4] = b; sw[i * 4] = 1; }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  }

  /**
   * Bake a paint role down to vertex colours, with two structural gradients
   * folded in. Both are PAINT, not lighting — they stay put when the robot
   * tumbles, exactly like a hand-painted model kit.
   *
   *  plane — top faces lift, undersides crush, side faces are the reference.
   *          The arena can light the machine from anywhere; this guarantees the
   *          chamfer between a top plate and a side plate is always a visible
   *          value step, which is what stops stacked armour reading as glass.
   *  grime — value falls off toward the deck. The feet anchor dark, the
   *          shoulders carry the light, and the machine has a top and a bottom.
   */
  _paint(g, paint) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const c = p.count;
    const arr = new Float32Array(c * 3);
    for (let i = 0; i < c; i++) {
      const ny = n.getY(i);
      const plane = ny >= 0 ? 1 + ny * ny * PLANE_UP : 1 - ny * ny * PLANE_DOWN;
      // Gentle: this is grime, not a second value structure. Crushed harder it
      // drags the white leg armour down into the same grey as the blue torso
      // and undoes the colour blocking it is supposed to support.
      const k = plane * (0.82 + 0.18 * smoothstep((p.getY(i) - 0.02) / 1.2));
      arr[i * 3] = paint.r * k;
      arr[i * 3 + 1] = paint.g * k;
      arr[i * 3 + 2] = paint.b * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }

  /** Record a finished primitive in bucket `name`, with its LOD size. */
  _keep(name, g) {
    this.buckets[name].push(g);
    this.areas[name].push(meanProjectedArea(g));
    return g;
  }

  _push(name, g, bone, paint) {
    this._uv(g);
    this._skin(g, bone);
    this._paint(g, paint);
    // Only the shell carries an outline, so only the shell pays for the welded
    // normals. The frame is already the model's darkest value — drawing a dark
    // line around it would describe nothing.
    if (name === 'shell') {
      g.setAttribute('nweld', new THREE.BufferAttribute(weldedNormals(g), 3));
    }
    return this._keep(name, g);
  }

  // shellT/shellA/shellL all land in the same bucket now; they stay distinct so
  // the layout code still says which armour group a plate belongs to, and so the
  // per-group default paint is picked for you when a call site doesn't care.
  shellT(g, bone, paint) { return this._push('shell', g, bone, paint || this.def || this.pal.hull); }
  shellA(g, bone, paint) { return this._push('shell', g, bone, paint || this.def || this.pal.hull); }
  shellL(g, bone, paint) { return this._push('shell', g, bone, paint || this.def || this.pal.leg); }
  frame(g, bone) { return this._push('frame', g, bone, this.pal.frame); }

  _tinted(name, g, bone, hex, intensity) {
    this._uv(g);
    this._skin(g, bone);
    const c = g.attributes.position.count;
    const arr = new Float32Array(c * 3);
    _col.setHex(hex);
    const r = _col.r * intensity, gr = _col.g * intensity, b = _col.b * intensity;
    for (let i = 0; i < c; i++) { arr[i * 3] = r; arr[i * 3 + 1] = gr; arr[i * 3 + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return this._keep(name, g);
  }

  /** Solid unlit emissive — lenses, seams, nozzle throats. Drives the bloom. */
  emis(g, bone, hex, intensity = 2.0) {
    return this._tinted('emis', g, bone, hex, intensity * EMIS_GAIN);
  }

  /** Additive, depth-tested — thruster plumes, muzzle flash. */
  flare(g, bone, hex, intensity = 1.4) {
    return this._tinted('flare', g, bone, hex, intensity * FLARE_GAIN);
  }
}

// ---------------------------------------------------------------------------
// Layout tables
// ---------------------------------------------------------------------------

const SIL = {
  strider: {
    hipY: 0.84, waistY: 0.97, chestY: 1.15, headY: 1.45,
    chestW: 0.44, chestH: 0.42, chestD: 0.34,
    hipW: 0.34, hipD: 0.30, shX: 0.31, shY: 1.28,
    armW: 0.145, foreW: 0.16, headR: 0.115,
    elbowDrop: 0.20, elbowFwd: 0.20, wristRise: 0.18, wristFwd: 0.22,
    packD: 0.16, packH: 0.30, skirt: 0.9,
  },
  bulwark: {
    hipY: 0.73, waistY: 0.87, chestY: 1.11, headY: 1.41,
    chestW: 0.60, chestH: 0.48, chestD: 0.42,
    hipW: 0.46, hipD: 0.36, shX: 0.42, shY: 1.25,
    armW: 0.19, foreW: 0.215, headR: 0.13,
    elbowDrop: 0.19, elbowFwd: 0.19, wristRise: 0.16, wristFwd: 0.21,
    packD: 0.20, packH: 0.34, skirt: 1.35,
  },
  lance: {
    hipY: 0.93, waistY: 1.05, chestY: 1.21, headY: 1.48,
    chestW: 0.38, chestH: 0.38, chestD: 0.38,
    hipW: 0.28, hipD: 0.28, shX: 0.28, shY: 1.32,
    armW: 0.125, foreW: 0.14, headR: 0.10,
    elbowDrop: 0.22, elbowFwd: 0.22, wristRise: 0.20, wristFwd: 0.23,
    packD: 0.14, packH: 0.32, skirt: 0.62,
  },
  monk: {
    hipY: 0.82, waistY: 0.96, chestY: 1.16, headY: 1.46,
    chestW: 0.48, chestH: 0.45, chestD: 0.39,
    hipW: 0.37, hipD: 0.33, shX: 0.35, shY: 1.28,
    armW: 0.16, foreW: 0.175, headR: 0.125,
    elbowDrop: 0.20, elbowFwd: 0.19, wristRise: 0.17, wristFwd: 0.21,
    packD: 0.19, packH: 0.36, skirt: 1.15,
  },
};

/** Leg joint chain as fractions of hip height, plus per-style bulk. */
const LEGS = {
  sprinter: {
    kneeF: 0.50, kneeZ: 0.040, ankleF: 0.135, ankleZ: -0.015,
    toeY: 0.045, toeZ: 0.085, tipZ: 0.185,
    thighW: 0.155, shinW: 0.150, footW: 0.175, hipX: 0.155, walk: 1.0,
  },
  tank: {
    kneeF: 0.52, kneeZ: 0.030, ankleF: 0.185, ankleZ: -0.010,
    toeY: 0.060, toeZ: 0.100, tipZ: 0.200,
    thighW: 0.215, shinW: 0.225, footW: 0.265, hipX: 0.200, walk: 0.82,
  },
  hover: {
    kneeF: 0.62, kneeZ: 0.0, ankleF: 0.36, ankleZ: 0.0,
    toeY: 0.22, toeZ: 0.0, tipZ: 0.0,
    thighW: 0.150, shinW: 0.190, footW: 0.230, hipX: 0.165, walk: 0.0,
  },
  digitigrade: {
    kneeF: 0.58, kneeZ: 0.105, ankleF: 0.30, ankleZ: -0.125,
    toeY: 0.055, toeZ: 0.025, tipZ: 0.170,
    thighW: 0.165, shinW: 0.135, footW: 0.130, hipX: 0.150, walk: 1.15,
  },
};

// ---------------------------------------------------------------------------
// Skeleton layout
// ---------------------------------------------------------------------------

function buildRig(P, L) {
  const R = new Rig();
  const hip = P.hipY;
  const kneeY = hip * L.kneeF, ankleY = hip * L.ankleF;

  R.add('root', null, 0, 0, 0);
  R.add('pelvis', 'root', 0, hip, 0);
  R.add('spine', 'pelvis', 0, P.waistY, 0);
  R.add('chest', 'spine', 0, P.chestY - P.chestH * 0.28, 0);
  R.add('neck', 'chest', 0, P.headY - P.headR - 0.05, 0);
  R.add('head', 'neck', 0, P.headY, 0);
  R.add('pack', 'chest', 0, P.chestY + 0.02, -P.chestD * 0.42);
  R.add('core', 'chest', 0, P.chestY - 0.01, P.chestD * 0.5);
  R.add('pod', 'pelvis', 0, hip - 0.02, -P.hipD * 0.55);

  // --- arms. The rest pose already aims: barrel axis is model +Z at pitch 0.
  const shY = P.shY;
  const ang = (y0, z0, y1, z1) => Math.atan2(-(z1 - z0), -(y1 - y0));

  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const x = s * P.shX;
    const eY = shY - P.elbowDrop, eZ = s > 0 ? P.elbowFwd : 0.04;
    const wY = s > 0 ? eY + P.wristRise : eY - 0.26;
    const wZ = s > 0 ? eZ + P.wristFwd : eZ + 0.05;

    R.add(`clav${side}`, 'chest', x * 0.62, shY + 0.02, 0);
    R.add(`arm${side}`, `clav${side}`, x, shY, 0, ang(shY, 0, eY, eZ));
    R.add(`fore${side}`, `arm${side}`, x, eY, eZ, ang(eY, eZ, wY, wZ));
    R.add(`hand${side}`, `fore${side}`, x, wY, wZ, ang(eY, eZ, wY, wZ));
  }

  // Weapon chain lives in model-aligned space (rest rx 0) so recoil slides
  // along +Z and the rotary barrels spin about +Z, whatever the arm is doing.
  const gx = P.shX, gy = SIL_wristY(P), gz = SIL_wristZ(P);
  R.add('gun', 'handR', gx, gy, gz, 0);
  R.add('slide', 'gun', gx, gy, gz, 0);
  R.add('spin', 'slide', gx, gy, gz + 0.16, 0);
  R.add('muzzle', 'slide', gx, gy, gz + 0.46, 0);
  R.add('flash', 'muzzle', gx, gy, gz + 0.50, 0);

  const bwY = shY - P.elbowDrop - 0.26, bwZ = 0.04 + 0.05;
  R.add('bomb', 'handL', -P.shX, bwY, bwZ, 0);

  // --- legs
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const x = s * L.hipX;
    R.add(`hip${side}`, 'pelvis', x, hip, 0);
    R.add(`thigh${side}`, `hip${side}`, x, hip, 0, ang(hip, 0, kneeY, L.kneeZ));
    R.add(`shin${side}`, `thigh${side}`, x, kneeY, L.kneeZ, ang(kneeY, L.kneeZ, ankleY, L.ankleZ));
    R.add(`foot${side}`, `shin${side}`, x, ankleY, L.ankleZ, 0);
    R.add(`toe${side}`, `foot${side}`, x, L.toeY, L.toeZ, 0);
    R.add(`boot${side}`, `shin${side}`, x, ankleY + 0.10, L.ankleZ - 0.11, 0);
  }

  R.add('thrL', 'pack', -0.14, P.chestY - 0.06, -P.chestD * 0.5 - P.packD, 0);
  R.add('thrR', 'pack', 0.14, P.chestY - 0.06, -P.chestD * 0.5 - P.packD, 0);

  return R;
}

const SIL_wristY = (P) => P.shY - P.elbowDrop + P.wristRise;
const SIL_wristZ = (P) => P.elbowFwd + P.wristFwd;

// ---------------------------------------------------------------------------
// Torso
// ---------------------------------------------------------------------------

function buildPelvis(B, P, C) {
  const a = B.arc, hip = P.hipY;
  const { look, em, ac, team, pal } = C;

  // Pelvic block plus a floating belt ring — the waist is where a mecha reads
  // as "assembled from parts", so it gets the most layering per square metre.
  // The block itself stays black: it is the gap the skirt plates float off, and
  // a dark gap is what tells you they are separate plates at all.
  B.shellT(at(roundedBox(P.hipW, 0.20, P.hipD, 0.035, a), 0, hip - 0.03, 0), 'pelvis', pal.dark);
  B.frame(at(cyl(0.105, 0.115, 0.16, B.rad), 0, hip + 0.09, 0), 'pelvis');
  B.frame(at(roundedBox(P.hipW * 0.72, 0.06, P.hipD * 0.9, 0.02, a), 0, hip + 0.03, 0), 'pelvis');

  // Skirt armour: front, rear and two side plates, each floated off the block.
  // The front plate is the machine's one warm note below the chest — a small
  // saturated hit at the waist is what CRV2 used to break up a tall blue body.
  const sk = P.skirt;
  B.shellT(at(taperBox(P.hipW * 0.50, P.hipW * 0.62, 0.20 * sk, 0.06, 0.09, 0.022, a),
    0, hip - 0.13, P.hipD * 0.46), 'pelvis', pal.accent);
  B.shellT(at(taperBox(P.hipW * 0.58, P.hipW * 0.70, 0.18 * sk, 0.06, 0.09, 0.022, a),
    0, hip - 0.12, -P.hipD * 0.46), 'pelvis', pal.hullLo);
  for (const s of [-1, 1]) {
    const g = taperBox(0.13, 0.17, 0.22 * sk, 0.13, 0.17, 0.024, a);
    g.rotateZ(s * 0.16);
    g.translate(s * (P.hipW * 0.55 + 0.02), hip - 0.12, 0);
    B.shellT(g, 'pelvis', pal.hull);
  }

  B.emis(at(roundedBox(P.hipW * 0.30, 0.018, 0.02, 0.006, 1), 0, hip + 0.02, P.hipD * 0.52),
    'pelvis', team, 1.5);
  if (!B.low) {
    for (const s of [-1, 1]) {
      B.emis(at(roundedBox(0.012, 0.11, 0.012, 0.004, 1), s * P.hipW * 0.40, hip - 0.04, P.hipD * 0.5),
        'pelvis', em, 1.2);
    }
  }

  // Spine column: exposed frame + twin actuator pistons.
  B.frame(at(cyl(0.075, 0.085, P.waistY - hip + 0.10, B.rad), 0, (hip + P.waistY) * 0.5, 0), 'spine');
  for (const s of [-1, 1]) {
    B.frame(at(cyl(0.024, 0.024, 0.17, 6), s * 0.075, P.waistY - 0.02, -0.055), 'spine');
  }
  B.shellT(at(roundedBox(P.chestW * 0.52, 0.13, P.chestD * 0.62, 0.03, a), 0, P.waistY + 0.02, 0), 'spine', pal.dark);
  B.emis(at(ringGeo(0.088, 0.008, B.low ? 8 : 14, 4).rotateX(Math.PI / 2),
    0, P.waistY - 0.05, 0), 'spine', ac, 1.1);
}

function buildChest(B, P, C) {
  const a = B.arc;
  const { look, em, ac, team, pal } = C;
  const cy = P.chestY, cw = P.chestW, ch = P.chestH, cd = P.chestD;

  // Core torso volume: a tapered barrel, never a plain box. This is the machine's
  // ONE big statement of its own colour — at 40 pixels the torso is most of what
  // you see, and a torso painted in shadow value just makes a dark blob with a
  // white mark on it. The hero plate reads because it is white on mid, and the
  // sternum reads because it is black on mid.
  B.shellT(at(taperBox(cw * 0.96, cw * 0.80, ch, cd * 0.94, cd * 0.82, 0.045, a), 0, cy, 0), 'chest', pal.hull);
  // Upper back plate, floated so the shoulder yoke reads as a separate piece.
  B.shellT(at(roundedBox(cw * 0.84, ch * 0.52, cd * 0.30, 0.03, a), 0, cy + ch * 0.20, -cd * 0.46), 'chest', pal.dark);
  // Collar / shoulder yoke.
  B.frame(at(taperBox(cw * 0.98, cw * 0.72, 0.09, cd * 0.7, cd * 0.8, 0.025, a), 0, cy + ch * 0.50, -0.01), 'chest');

  // Side intake scoops.
  for (const s of [-1, 1]) {
    const g = taperBox(0.055, 0.10, 0.19, 0.16, 0.20, 0.02, a);
    g.rotateZ(-s * 0.22);
    g.translate(s * (cw * 0.50), cy + ch * 0.10, 0.01);
    B.shellT(g, 'chest', pal.dark);
    if (!B.low) {
      for (let i = 0; i < 3; i++) {
        B.frame(at(roundedBox(0.03, 0.012, 0.15, 0.004, 1),
          s * (cw * 0.53), cy + ch * 0.16 - i * 0.045, 0.01), 'chest');
      }
    }
  }

  // Abdomen: exposed frame ribs under the chest plate.
  B.frame(at(taperBox(cw * 0.60, cw * 0.52, 0.14, cd * 0.62, cd * 0.56, 0.02, a),
    0, cy - ch * 0.56, 0), 'chest');
  if (!B.low) {
    for (let i = 0; i < 2; i++) {
      B.frame(at(roundedBox(cw * 0.50, 0.022, cd * 0.66, 0.006, 1),
        0, cy - ch * 0.50 - i * 0.045, 0), 'chest');
    }
  }

  switch (look.chest) {
    case 'slab': {
      // SHELLBIT: one enormous front plate, split by a horizontal weld line,
      // with bolt columns. Reads as "armour first" from any distance.
      B.shellT(at(roundedBox(cw * 0.88, ch * 0.86, 0.09, 0.03, a), 0, cy + 0.01, cd * 0.50), 'chest', pal.light);
      B.shellT(at(roundedBox(cw * 0.70, ch * 0.30, 0.06, 0.022, a), 0, cy + ch * 0.24, cd * 0.56), 'chest', pal.hull);
      B.frame(at(roundedBox(cw * 0.90, 0.028, 0.03, 0.008, 1), 0, cy - ch * 0.02, cd * 0.56), 'chest');
      for (const s of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          B.frame(at(cyl(0.017, 0.017, 0.035, 6).rotateX(Math.PI / 2),
            s * cw * 0.36, cy + ch * 0.30 - i * 0.10, cd * 0.55), 'chest');
        }
      }
      B.emis(at(roundedBox(cw * 0.44, 0.028, 0.02, 0.008, 1), 0, cy - ch * 0.14, cd * 0.57), 'chest', em, 2.2);
      B.emis(at(roundedBox(0.10, 0.10, 0.018, 0.006, 1), 0, cy + ch * 0.24, cd * 0.60), 'core', em, 2.6);
      break;
    }
    case 'keel': {
      // AERIAL-Z / NOCTURNE: a forward-raked prow with keel fins. Everything
      // points forward; the silhouette should look like it is already moving.
      const prow = taperBox(0.10, cw * 0.70, 0.30, 0.20, 0.10, 0.02, a);
      prow.rotateX(-0.30);
      prow.translate(0, cy + 0.01, cd * 0.52);
      B.shellT(prow, 'chest', pal.light);
      for (const s of [-1, 1]) {
        const fin = taperBox(0.03, 0.055, 0.30, 0.06, 0.22, 0.014, a);
        fin.rotateZ(-s * 0.30);
        fin.rotateX(-0.16);
        fin.translate(s * cw * 0.44, cy + 0.03, cd * 0.36);
        B.shellT(fin, 'chest', pal.accent);
      }
      B.emis(at(roundedBox(0.028, 0.30, 0.014, 0.006, 1).rotateX(-0.30), 0, cy + 0.02, cd * 0.63), 'chest', em, 2.6);
      B.emis(at(ball(0.045, B.low ? 6 : 10), 0, cy + 0.15, cd * 0.55), 'core', em, 2.8);
      break;
    }
    case 'reactor': {
      // GRAND ISO: the power plant is the design. Housing, iris, radial vents.
      B.frame(at(cyl(0.135, 0.145, 0.10, B.low ? 10 : 16).rotateX(Math.PI / 2), 0, cy + 0.02, cd * 0.48), 'chest');
      B.shellT(at(ringGeo(0.155, 0.030, B.low ? 10 : 18, 5).rotateX(0), 0, cy + 0.02, cd * 0.50), 'chest', pal.light);
      B.emis(at(disc(0.115, B.low ? 10 : 18), 0, cy + 0.02, cd * 0.545), 'core', em, 3.0);
      B.emis(at(ringGeo(0.135, 0.010, B.low ? 10 : 18, 4), 0, cy + 0.02, cd * 0.53), 'core', ac, 1.8);
      if (!B.low) {
        for (let i = 0; i < 6; i++) {
          const t = (i / 6) * TAU;
          const g = roundedBox(0.035, 0.13, 0.05, 0.01, 1);
          g.rotateZ(t);
          g.translate(Math.sin(t) * 0.20, cy + 0.02 + Math.cos(t) * 0.20, cd * 0.44);
          B.frame(g, 'chest');
        }
      }
      break;
    }
    default: {
      // RAY-01: the tournament V-crest. Two angled slabs and a lit sternum.
      // The V is the machine's face at 32px — white slabs, black sternum
      // between them, warm bar above. Three values inside 30cm of chest.
      for (const s of [-1, 1]) {
        const g = taperBox(0.07, 0.13, 0.28, 0.05, 0.09, 0.018, a);
        g.rotateZ(s * 0.42);
        g.rotateX(-0.10);
        g.translate(s * cw * 0.20, cy + ch * 0.12, cd * 0.52);
        B.shellT(g, 'chest', pal.light);
      }
      B.shellT(at(roundedBox(cw * 0.34, ch * 0.52, 0.07, 0.022, a), 0, cy - ch * 0.10, cd * 0.52), 'chest', pal.dark);
      B.shellT(at(roundedBox(cw * 0.52, 0.03, 0.04, 0.008, 1), 0, cy + ch * 0.34, cd * 0.50), 'chest', pal.accent);
      B.emis(at(roundedBox(0.024, ch * 0.42, 0.016, 0.006, 1), 0, cy - ch * 0.10, cd * 0.57), 'chest', em, 2.3);
      B.emis(at(ball(0.05, B.low ? 6 : 10), 0, cy + ch * 0.30, cd * 0.50), 'core', em, 2.8);
      break;
    }
  }

  // Team chevron — the one piece of colour that is not part-driven, so the two
  // sides stay legible even with identical loadouts.
  B.emis(at(roundedBox(cw * 0.20, 0.02, 0.014, 0.005, 1), 0, cy + ch * 0.44, cd * 0.46), 'chest', team, 1.7);
}

function buildBackpack(B, P, C) {
  const a = B.arc;
  const { look, em, ac, pal } = C;
  const cy = P.chestY, cd = P.chestD, pd = P.packD, phh = P.packH;

  // The pack sits dark: it is behind the shoulder line, and anything bright back
  // there competes with the chest for the eye in a three-quarter view.
  B.shellT(at(taperBox(P.chestW * 0.62, P.chestW * 0.74, phh, pd * 0.7, pd, 0.03, a),
    0, cy + 0.02, -cd * 0.5 - pd * 0.5), 'pack', pal.hullLo);
  B.frame(at(roundedBox(P.chestW * 0.50, 0.05, pd * 0.5, 0.014, 1),
    0, cy + phh * 0.42, -cd * 0.5 - pd * 0.5), 'pack');

  // Twin main thrusters: bell, throat, plume.
  for (const s of [-1, 1]) {
    const x = s * 0.14, z = -cd * 0.5 - pd;
    B.frame(at(cyl(0.075, 0.052, 0.13, B.rad).rotateX(Math.PI / 2), x, cy - 0.06, z + 0.02), 'pack');
    B.shellT(at(cyl(0.088, 0.070, 0.06, B.rad).rotateX(Math.PI / 2), x, cy - 0.06, z + 0.08), 'pack', pal.dark);
    B.emis(at(disc(0.055, B.low ? 8 : 14).rotateY(Math.PI), x, cy - 0.06, z - 0.045), 'pack', em, 2.4);

    const plume = cyl(0.05, 0.012, 0.42, B.low ? 6 : 10, true);
    plume.rotateX(Math.PI / 2);
    plume.translate(x, cy - 0.06, z - 0.26);
    B.flare(plume, s < 0 ? 'thrL' : 'thrR', em, 1.5);
  }

  // Heat fins — angled so they catch the key light across the back.
  if (!B.low) {
    for (let i = 0; i < 3; i++) {
      for (const s of [-1, 1]) {
        const g = roundedBox(0.045, 0.11, 0.015, 0.005, 1);
        g.rotateY(s * 0.35);
        g.translate(s * (0.055 + i * 0.055), cy + phh * 0.30, -cd * 0.5 - pd * 0.95);
        B.shellT(g, 'pack', pal.light);
      }
    }
  }
  B.emis(at(roundedBox(0.16, 0.014, 0.012, 0.004, 1), 0, cy + phh * 0.16, -cd * 0.5 - pd * 1.02), 'pack', ac, 1.4);
}

function buildHead(B, P, C) {
  const a = B.arc;
  const { look, em, ac, pal } = C;
  const hy = P.headY, r = P.headR;

  // The head is the read. Every variant below paints the helmet crown in the
  // LIGHT value and everything under the jawline dark, so there is a hard value
  // break at the neck — that break is what makes a head a head at 32px instead
  // of a bump on the shoulders.
  B.frame(at(cyl(0.055, 0.065, 0.09, B.rad), 0, hy - r - 0.03, 0), 'neck');

  switch (look.head) {
    case 'dome': {
      // SHELLBIT: an armoured dome sunk into the shoulders. Barely a head.
      B.shellT(at(ball(r * 1.05, B.low ? 8 : 12).scale(1.15, 0.9, 1.0), 0, hy, 0), 'head', pal.light);
      B.shellT(at(taperBox(r * 2.0, r * 2.3, r * 0.55, r * 0.9, r * 1.5, 0.02, a), 0, hy - r * 0.55, r * 0.15), 'head', pal.dark);
      B.shellT(at(roundedBox(r * 1.9, 0.035, 0.06, 0.01, 1), 0, hy + r * 0.10, r * 0.85), 'head', pal.accent);
      B.emis(at(roundedBox(r * 1.30, 0.030, 0.02, 0.008, 1), 0, hy - r * 0.10, r * 0.92), 'head', em, 2.6);
      for (const s of [-1, 1]) {
        B.frame(at(cyl(0.028, 0.034, 0.05, 8).rotateZ(Math.PI / 2), s * r * 1.15, hy, 0), 'head');
      }
      break;
    }
    case 'crest': {
      // AERIAL-Z: narrow face, tall swept blade. All vertical energy.
      B.shellT(at(taperBox(r * 1.0, r * 1.5, r * 1.7, r * 1.3, r * 1.7, 0.02, a), 0, hy, 0), 'head', pal.light);
      const crest = taperBox(0.012, 0.05, 0.24, 0.03, 0.16, 0.008, a);
      crest.rotateX(0.42);
      crest.translate(0, hy + r * 1.15, -0.03);
      B.shellT(crest, 'head', pal.accent);
      for (const s of [-1, 1]) {
        const fin = taperBox(0.010, 0.028, 0.15, 0.02, 0.10, 0.006, a);
        fin.rotateZ(-s * 0.55);
        fin.rotateX(0.30);
        fin.translate(s * r * 0.75, hy + r * 0.85, -0.02);
        B.shellT(fin, 'head', pal.dark);
        B.emis(at(roundedBox(0.035, 0.016, 0.014, 0.004, 1), s * r * 0.42, hy + r * 0.05, r * 0.95), 'head', em, 3.0);
      }
      B.frame(at(roundedBox(r * 0.9, 0.05, 0.05, 0.012, 1), 0, hy - r * 0.55, r * 0.7), 'head');
      break;
    }
    case 'mono': {
      // GRAND ISO: one big sensor eye, rear heat fins. Deliberately inhuman.
      B.shellT(at(ball(r * 1.1, B.low ? 8 : 12).scale(1.0, 1.05, 1.05), 0, hy, 0), 'head', pal.light);
      B.frame(at(cyl(0.062, 0.070, 0.05, B.low ? 10 : 14).rotateX(Math.PI / 2), 0, hy + r * 0.05, r * 0.95), 'head');
      B.emis(at(disc(0.052, B.low ? 10 : 16), 0, hy + r * 0.05, r * 1.16), 'head', em, 3.2);
      B.emis(at(ringGeo(0.068, 0.008, B.low ? 10 : 16, 4), 0, hy + r * 0.05, r * 1.10), 'head', ac, 1.6);
      if (!B.low) {
        for (let i = 0; i < 3; i++) {
          B.shellT(at(roundedBox(r * 1.5 - i * 0.02, 0.018, 0.05, 0.005, 1),
            0, hy + r * 0.55 - i * 0.045, -r * 0.95), 'head', pal.dark);
        }
      }
      break;
    }
    default: {
      // RAY-01 / NOCTURNE: classic wedge helmet with a wraparound visor band.
      // Light crown, black jaw, warm brow bar over the visor — read in that
      // order from 40 metres away.
      B.shellT(at(taperBox(r * 1.5, r * 1.85, r * 1.8, r * 1.5, r * 1.9, 0.025, a), 0, hy, 0), 'head', pal.light);
      B.frame(at(taperBox(r * 1.3, r * 1.6, r * 0.7, r * 1.2, r * 1.5, 0.015, a), 0, hy - r * 0.75, r * 0.10), 'head');
      const brow = roundedBox(r * 1.9, 0.045, 0.09, 0.012, a);
      brow.rotateX(-0.18);
      brow.translate(0, hy + r * 0.52, r * 0.80);
      B.shellT(brow, 'head', pal.accent);
      B.emis(at(roundedBox(r * 1.55, 0.045, 0.024, 0.010, 1), 0, hy + r * 0.05, r * 0.95), 'head', em, 3.0);
      for (const s of [-1, 1]) {
        B.frame(at(cyl(0.024, 0.030, 0.055, 8).rotateZ(Math.PI / 2), s * r * 1.25, hy - r * 0.05, 0), 'head');
        B.emis(at(roundedBox(0.010, 0.045, 0.010, 0.003, 1), s * r * 1.30, hy - r * 0.05, 0), 'head', ac, 1.3);
      }
      // Antenna — cheap, but it is the thing that makes a head look like a mech.
      const ant = cyl(0.006, 0.010, 0.16, 6);
      ant.rotateX(0.30);
      ant.translate(-r * 0.55, hy + r * 1.35, -0.03);
      B.frame(ant, 'head');
      break;
    }
  }
}

function buildShoulder(B, P, C, s) {
  const a = B.arc;
  const { look, em, ac, team, pal } = C;
  const side = s < 0 ? 'L' : 'R';
  const clav = `clav${side}`;
  const x = s * P.shX, y = P.shY;
  const sc = P.chestW / 0.44;

  // Deltoid frame under the pauldron so the gap has something inside it.
  B.frame(at(ball(P.armW * 0.72, B.low ? 6 : 10), x, y, 0), clav);

  // The pauldrons carry the machine's LIGHT value, and they are the biggest
  // single block of it on the model. This is the read at 32 pixels: two bright
  // caps at the top of a mid-value torso, with black underneath them. Painting
  // them in the hull colour — which is what shipped — is most of defect #24,
  // because it fuses shoulder, chest and arm into one continuous blue mass.
  switch (look.shoulder) {
    case 'block': {
      // SHELLBIT: rectangular blocks with vertical slats.
      B.shellT(at(roundedBox(0.20 * sc, 0.24, 0.26, 0.035, a), x + s * 0.08, y + 0.05, 0), clav, pal.light);
      B.shellT(at(roundedBox(0.21 * sc, 0.05, 0.27, 0.018, a), x + s * 0.08, y - 0.08, 0), clav, pal.dark);
      B.shellT(at(roundedBox(0.16 * sc, 0.07, 0.22, 0.02, a), x + s * 0.08, y + 0.20, 0), clav, pal.hull);
      if (!B.low) {
        for (let i = 0; i < 3; i++) {
          B.frame(at(roundedBox(0.022, 0.16, 0.03, 0.006, 1),
            x + s * (0.08 + 0.10 * sc), y + 0.04, -0.07 + i * 0.07), clav);
        }
      }
      B.emis(at(roundedBox(0.10, 0.016, 0.014, 0.004, 1), x + s * 0.08, y + 0.15, 0.13), clav, team, 1.6);
      break;
    }
    case 'fin': {
      // AERIAL-Z / NOCTURNE: swept-back blades. Nothing bulky above the arm.
      const fin = taperBox(0.035, 0.11, 0.30, 0.05, 0.20, 0.016, a);
      fin.rotateZ(-s * 0.30);
      fin.rotateX(0.36);
      fin.translate(x + s * 0.075, y + 0.06, -0.06);
      B.shellT(fin, clav, pal.light);
      const cap = taperBox(0.09, 0.13, 0.13, 0.14, 0.19, 0.022, a);
      cap.rotateZ(-s * 0.18);
      cap.translate(x + s * 0.055, y + 0.03, 0.01);
      B.shellT(cap, clav, pal.hull);
      const lip = taperBox(0.10, 0.14, 0.045, 0.15, 0.20, 0.014, a);
      lip.rotateZ(-s * 0.18);
      lip.translate(x + s * 0.055, y - 0.045, 0.01);
      B.shellT(lip, clav, pal.dark);
      B.emis(at(roundedBox(0.012, 0.20, 0.012, 0.004, 1).rotateX(0.36).rotateZ(-s * 0.30),
        x + s * 0.115, y + 0.07, -0.05), clav, em, 1.9);
      break;
    }
    case 'vent': {
      // GRAND ISO: radiator drums. Every panel is a heatsink, so make it one.
      B.shellT(at(cyl(0.115, 0.125, 0.19, B.low ? 10 : 14).rotateZ(Math.PI / 2),
        x + s * 0.085, y + 0.03, 0), clav, pal.light);
      B.frame(at(cyl(0.075, 0.075, 0.21, B.low ? 8 : 12).rotateZ(Math.PI / 2),
        x + s * 0.085, y + 0.03, 0), clav);
      B.shellT(at(roundedBox(0.20, 0.05, 0.22, 0.016, a), x + s * 0.085, y - 0.10, 0), clav, pal.dark);
      if (!B.low) {
        for (let i = 0; i < 4; i++) {
          const t = (i / 4) * Math.PI * 2 + 0.4;
          B.shellT(at(roundedBox(0.19, 0.035, 0.05, 0.008, 1)
            .rotateX(t), x + s * 0.085, y + 0.03 + Math.cos(t) * 0.115, Math.sin(t) * 0.115), clav, pal.hullLo);
        }
      }
      B.emis(at(ringGeo(0.09, 0.010, B.low ? 10 : 16, 4).rotateY(Math.PI / 2),
        x + s * 0.185, y + 0.03, 0), clav, em, 2.0);
      break;
    }
    default: {
      // RAY-01: layered pauldron floating clear of the torso.
      const pau = taperBox(0.15 * sc, 0.21 * sc, 0.24, 0.17, 0.25, 0.032, a);
      pau.rotateZ(-s * 0.14);
      pau.translate(x + s * 0.075, y + 0.065, 0);
      B.shellT(pau, clav, pal.light);
      // Cap in the hull colour: the top plane still steps up in value off the
      // paint ramp, and the pauldron gets a coloured band that says which team
      // and which body this is without breaking the white block.
      const cap = taperBox(0.10 * sc, 0.16 * sc, 0.055, 0.12, 0.20, 0.018, a);
      cap.rotateZ(-s * 0.14);
      cap.translate(x + s * 0.085, y + 0.198, 0);
      B.shellT(cap, clav, pal.hull);
      // Black lip along the bottom edge, so the white block ENDS somewhere and
      // does not bleed into the upper arm hanging out of it.
      const lip = taperBox(0.155 * sc, 0.19 * sc, 0.05, 0.18, 0.24, 0.016, a);
      lip.rotateZ(-s * 0.14);
      lip.translate(x + s * 0.078, y - 0.065, 0);
      B.shellT(lip, clav, pal.dark);
      B.frame(at(roundedBox(0.05, 0.14, 0.20, 0.014, 1), x + s * 0.01, y + 0.05, 0), clav);
      B.emis(at(roundedBox(0.10, 0.018, 0.016, 0.005, 1), x + s * 0.10, y + 0.13, 0.10), clav, team, 1.7);
      if (!B.low) {
        B.frame(at(cyl(0.016, 0.016, 0.05, 6).rotateZ(Math.PI / 2), x + s * 0.16, y + 0.02, -0.06), clav);
      }
      break;
    }
  }
}

function buildArm(B, P, C, s) {
  const a = B.arc;
  const { em, ac, pal } = C;
  const side = s < 0 ? 'L' : 'R';
  const x = s * P.shX;
  const eY = P.shY - P.elbowDrop, eZ = s > 0 ? P.elbowFwd : 0.04;
  const wY = s > 0 ? eY + P.wristRise : eY - 0.26;
  const wZ = s > 0 ? eZ + P.wristFwd : eZ + 0.05;
  const aw = P.armW, fw = P.foreW;

  // Upper arm: inner frame sleeve + outer armour shell, so the joint gap has
  // depth instead of showing a hole.
  //
  // The mass stays a step below the pauldron — matching them would fuse
  // shoulder and arm into one lump — but it is the body's own hue in shadow,
  // not the near-black recess value it used to be. Painted black, the upper
  // arms simply stopped existing against the garage backdrop and the machine
  // lost both its arms from the silhouette. The outer plate then takes the
  // light value, so the limb has the same three-step structure as every other
  // armour group: light plane, mid mass, dark edge.
  B.frame(segBox(x, P.shY, 0, eY, eZ, aw * 0.62, aw * 0.62, aw * 0.3, 1), `arm${side}`);
  B.shellA(segBox(x, P.shY - 0.02, 0.0, eY + 0.02, eZ * 0.9, aw, aw * 1.05, 0.028, a), `arm${side}`, pal.hullLo);
  B.shellA(segBox(x + s * aw * 0.42, P.shY - 0.04, 0.0, eY + 0.05, eZ * 0.8, aw * 0.34, aw * 0.7, 0.012, a), `arm${side}`, pal.light);

  // Elbow: ball joint, guard plate, and a piston that visibly spans the joint.
  B.frame(at(ball(aw * 0.60, B.low ? 6 : 10), x, eY, eZ), `arm${side}`);
  B.shellA(at(taperBox(aw * 0.75, aw * 1.05, aw * 0.9, aw * 0.8, aw * 1.1, 0.018, a), x, eY + 0.02, eZ), `fore${side}`, pal.accent);
  if (!B.low) {
    B.frame(segBox(x - s * aw * 0.42, P.shY - 0.10, 0, eY + 0.02, eZ, 0.022, 0.022, 0.01, 1), `arm${side}`);
  }
  B.emis(at(ringGeo(aw * 0.62, 0.008, B.low ? 8 : 12, 4).rotateY(Math.PI / 2), x + s * aw * 0.1, eY, eZ),
    `fore${side}`, ac, 1.3);

  // Forearm: heavier cuff than the upper arm — top-light limbs look like sticks.
  B.shellA(segBox(x, eY, eZ, wY, wZ, fw, fw * 1.08, 0.03, a), `fore${side}`, pal.hull);
  B.shellA(segBox(x + s * fw * 0.44, eY - 0.02, eZ, wY, wZ, fw * 0.28, fw * 0.75, 0.012, a), `fore${side}`, pal.light);
  B.frame(at(cyl(fw * 0.46, fw * 0.46, 0.05, B.rad).rotateX(Math.atan2(wZ - eZ, wY - eY) + Math.PI / 2),
    x, wY, wZ), `hand${side}`);
  B.emis(at(roundedBox(0.014, 0.09, 0.014, 0.004, 1)
    .rotateX(Math.atan2(wZ - eZ, wY - eY)), x + s * fw * 0.52, (eY + wY) * 0.5, (eZ + wZ) * 0.5),
    `fore${side}`, em, 1.4);
}

// ---------------------------------------------------------------------------
// Legs — the four styles differ in joint chain, bulk and part count, not paint.
// ---------------------------------------------------------------------------

function buildLeg(B, P, L, C, s) {
  const a = B.arc;
  const { legs, em, ac, team, pal } = C;
  const side = s < 0 ? 'L' : 'R';
  const x = s * L.hipX;
  const hip = P.hipY;
  const kY = hip * L.kneeF, kZ = L.kneeZ;
  const aY = hip * L.ankleF, aZ = L.ankleZ;
  const tw = L.thighW, sw = L.shinW, fw = L.footW;
  const style = legs.look.style;

  // Hip ball + housing. Hips are dark: they are the hinge between the skirt and
  // the thigh, and the eye needs a break there or the legs read as one column.
  B.frame(at(ball(tw * 0.60, B.low ? 6 : 10), x, hip - 0.02, 0), `hip${side}`);
  B.shellL(at(taperBox(tw * 0.9, tw * 1.15, 0.13, tw * 0.9, tw * 1.1, 0.022, a), x + s * 0.015, hip - 0.05, 0), `thigh${side}`, pal.legLo);

  // Thigh. The legs are the part of the machine that touches the arena deck,
  // and the deck is near-white — so the leg mass is the SHADOW value of the leg
  // colour and only the forward-facing plates are painted up. Legs in full
  // light-grey armour disappear into the floor from twenty metres away.
  B.frame(segBox(x, hip - 0.02, 0, kY + 0.02, kZ, tw * 0.60, tw * 0.60, tw * 0.28, 1), `thigh${side}`);
  B.shellL(segBox(x, hip - 0.06, 0, kY + 0.04, kZ * 0.9, tw, tw * 1.05, 0.03, a), `thigh${side}`, pal.legLo);
  // Forward thigh plate in the light value: one bright plane per limb segment,
  // facing the camera in the fighting stance.
  B.shellL(segBox(x, hip - 0.05, tw * 0.52, kY + 0.02, kZ + tw * 0.48, tw * 0.62, tw * 0.30, 0.014, a), `thigh${side}`, pal.leg);
  if (style === 'tank') {
    // Bolted-on outer thigh armour with a lip — pure mass reading.
    B.shellL(segBox(x + s * tw * 0.52, hip - 0.10, 0, kY + 0.02, kZ, tw * 0.34, tw * 1.15, 0.016, a), `thigh${side}`, pal.leg);
    B.shellL(segBox(x, hip - 0.08, -tw * 0.55, kY, kZ - tw * 0.5, tw * 0.85, tw * 0.28, 0.014, a), `thigh${side}`, pal.dark);
  } else if (style === 'digitigrade') {
    B.shellL(segBox(x, hip - 0.04, -tw * 0.42, kY + 0.06, kZ - tw * 0.30, tw * 0.66, tw * 0.42, 0.016, a), `thigh${side}`, pal.dark);
  }

  // Knee: joint sphere, guard, and a piston bridging thigh to shin. The guard
  // takes the accent — a warm chevron at knee height is the one thing on the
  // lower body that survives being 40px tall in a fight frame.
  B.frame(at(ball(tw * 0.52, B.low ? 6 : 10), x, kY, kZ), `thigh${side}`);
  B.shellL(at(taperBox(sw * 0.85, sw * 1.12, 0.13, sw * 0.9, sw * 1.15, 0.02, a), x, kY + 0.01, kZ + 0.02), `shin${side}`, pal.accent);
  B.emis(at(ringGeo(tw * 0.56, 0.008, B.low ? 8 : 12, 4).rotateY(Math.PI / 2), x + s * tw * 0.1, kY, kZ),
    `shin${side}`, ac, 1.3);
  if (!B.low) {
    B.frame(segBox(x - s * tw * 0.40, hip - 0.14, kZ * 0.3, kY + 0.03, kZ - 0.03, 0.024, 0.024, 0.01, 1), `thigh${side}`);
  }

  // Shin / lower leg — the biggest style tell.
  if (style === 'hover') {
    // HOVER-V: no shin at all. A skirted housing over a turbine ring.
    B.shellL(segBox(x, kY, kZ, aY + 0.04, aZ, sw * 1.05, sw * 1.15, 0.03, a), `shin${side}`, pal.leg);
    B.shellL(at(taperBox(fw * 1.5, fw * 1.05, 0.16, fw * 1.5, fw * 1.05, 0.03, a), x, aY - 0.03, 0), `foot${side}`, pal.legLo);
    B.frame(at(cyl(fw * 0.78, fw * 0.72, 0.09, B.low ? 10 : 16), x, L.toeY + 0.05, 0), `toe${side}`);
    B.shellL(at(ringGeo(fw * 0.80, 0.036, B.low ? 12 : 20, 5).rotateX(Math.PI / 2), x, L.toeY + 0.04, 0), `toe${side}`, pal.accent);
    B.emis(at(ringGeo(fw * 0.60, 0.014, B.low ? 12 : 20, 4).rotateX(Math.PI / 2), x, L.toeY + 0.02, 0), `toe${side}`, em, 2.4);
    B.emis(at(disc(fw * 0.46, B.low ? 10 : 16).rotateX(Math.PI / 2), x, L.toeY - 0.005, 0), `toe${side}`, em, 1.6);
    const wash = cyl(fw * 0.5, fw * 0.16, 0.30, B.low ? 8 : 12, true);
    wash.rotateX(Math.PI);
    wash.translate(x, L.toeY - 0.17, 0);
    B.flare(wash, `boot${side}`, em, 1.1);
    if (!B.low) {
      for (const q of [-1, 1]) {
        const fin = taperBox(0.02, 0.05, 0.12, 0.05, 0.14, 0.008, a);
        fin.rotateZ(q * 0.5);
        fin.translate(x + q * fw * 0.9, aY - 0.04, 0);
        B.shellL(fin, `foot${side}`, pal.legLo);
      }
    }
  } else {
    // Shin in the leg colour with a LIGHT greave floated proud of it: two
    // planes at two values, which is what gives the lower leg any form at all
    // once the arena stops helping.
    B.frame(segBox(x, kY, kZ, aY, aZ, sw * 0.58, sw * 0.58, sw * 0.26, 1), `shin${side}`);
    B.shellL(segBox(x, kY - 0.02, kZ, aY + 0.02, aZ, sw, sw * 1.08, 0.028, a), `shin${side}`, pal.legLo);
    B.shellL(segBox(x, kY - 0.04, kZ + sw * 0.55, aY + 0.04, aZ + sw * 0.5, sw * 0.68, sw * 0.30, 0.014, a), `shin${side}`, pal.leg);

    if (style === 'tank') {
      for (const q of [-1, 1]) {
        B.shellL(segBox(x + q * sw * 0.56, kY - 0.06, kZ, aY + 0.03, aZ, sw * 0.26, sw * 1.1, 0.014, a), `shin${side}`, pal.leg);
      }
      // Quad thruster block on the calf.
      B.frame(at(roundedBox(sw * 0.95, 0.13, 0.09, 0.02, a), x, aY + 0.13, aZ - sw * 0.62), `shin${side}`);
      for (let i = 0; i < 4; i++) {
        const ox = ((i & 1) ? 1 : -1) * sw * 0.26;
        const oy = (i < 2 ? 0.03 : -0.03);
        B.emis(at(disc(0.026, 8).rotateY(Math.PI), x + ox, aY + 0.13 + oy, aZ - sw * 0.68), `shin${side}`, em, 2.0);
      }
    } else if (style === 'digitigrade') {
      // The spring: a coil piston along the back of a reverse-jointed leg.
      B.frame(segBox(x, kY - 0.02, kZ - sw * 0.5, aY + 0.06, aZ - sw * 0.2, 0.034, 0.034, 0.016, 1), `shin${side}`);
      if (!B.low) {
        for (let i = 0; i < 4; i++) {
          const t = i / 3;
          B.frame(at(ringGeo(0.030, 0.010, 8, 4).rotateX(Math.atan2(aZ - kZ, aY - kY) + Math.PI / 2),
            x, lerp(kY - 0.02, aY + 0.06, t), lerp(kZ - sw * 0.5, aZ - sw * 0.2, t)), `shin${side}`);
        }
      }
    }

    // Calf thruster.
    B.frame(at(cyl(0.042, 0.032, 0.07, B.rad).rotateX(Math.PI / 2 + 0.5), x, aY + 0.10, aZ - sw * 0.55), `shin${side}`);
    B.emis(at(disc(0.030, B.low ? 8 : 12).rotateY(Math.PI).rotateX(-0.5), x, aY + 0.085, aZ - sw * 0.62), `shin${side}`, em, 2.0);
    const jet = cyl(0.032, 0.008, 0.24, B.low ? 6 : 10, true);
    jet.rotateX(Math.PI / 2 - 0.5);
    jet.translate(x, aY + 0.04, aZ - sw * 0.74);
    B.flare(jet, `boot${side}`, em, 1.3);

    // Ankle + foot.
    B.frame(at(ball(sw * 0.44, B.low ? 6 : 10), x, aY, aZ), `foot${side}`);
    if (style === 'digitigrade') {
      // Long metatarsal running forward to a single hoof-like toe.
      B.shellL(segBox(x, aY, aZ, L.toeY + 0.03, L.toeZ, fw * 0.95, fw * 0.8, 0.018, a), `foot${side}`, pal.legLo);
      B.shellL(segBox(x, L.toeY + 0.02, L.toeZ, L.toeY - 0.02, L.tipZ, fw * 1.05, fw * 0.55, 0.016, a), `toe${side}`, pal.leg);
      B.shellL(segBox(x, aY - 0.02, aZ - 0.02, L.toeY + 0.02, aZ - 0.09, fw * 0.7, fw * 0.5, 0.014, a), `foot${side}`, pal.legLo);
    } else {
      const spread = style === 'tank' ? 1.0 : 0.85;
      B.shellL(at(taperBox(fw * 0.9, fw * 1.15, 0.10, fw * 1.5, fw * 1.9, 0.02, a), x, L.toeY + 0.02, L.toeZ * 0.35), `foot${side}`, pal.legLo);
      // The toe cap is the lowest thing on the machine and it is read against a
      // near-white deck, so it is the model's darkest note. It is also what
      // makes the contact shadow look like it belongs to something.
      B.shellL(at(taperBox(fw * 1.05, fw * 0.85, 0.075, fw * 0.9, fw * 0.7, 0.016, a).rotateX(0.12),
        x, L.toeY - 0.005, L.toeZ + 0.03), `toe${side}`, pal.dark);
      if (!B.low) {
        for (let i = -1; i <= 1; i++) {
          if (style !== 'tank' && i === 0) continue;
          B.shellL(at(taperBox(fw * 0.22, fw * 0.30, 0.05, 0.05, 0.09, 0.008, a).rotateX(0.30),
            x + i * fw * 0.34 * spread, L.toeY - 0.015, L.tipZ - 0.02), `toe${side}`, pal.accent);
        }
      }
      B.frame(at(roundedBox(fw * 1.2, 0.03, fw * 1.2, 0.008, 1), x, L.toeY - 0.035, L.toeZ * 0.4), `foot${side}`);
    }
  }

  // Ankle accent band + team stripe on the outer shin.
  B.emis(at(ringGeo(sw * 0.42, 0.008, B.low ? 8 : 12, 4).rotateY(Math.PI / 2), x, aY, aZ), `foot${side}`, ac, 1.2);
  B.emis(at(roundedBox(0.014, 0.11, 0.014, 0.004, 1)
    .rotateX(Math.atan2(aZ - kZ, aY - kY)), x + s * sw * 0.54, lerp(kY, aY, 0.45), lerp(kZ, aZ, 0.45)),
    `shin${side}`, team, 1.5);
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

function buildGun(B, P, C) {
  const a = B.arc;
  const { gun, em } = C;
  const x = P.shX, y = SIL_wristY(P), z0 = SIL_wristZ(P);
  const gc = gun.look.colour;

  // Receiver — shared by every gun so the arm mount reads consistently.
  B.shellA(at(roundedBox(0.115, 0.125, 0.24, 0.024, a), x, y, z0 + 0.10), 'gun');
  B.frame(at(roundedBox(0.135, 0.06, 0.10, 0.014, a), x, y - 0.055, z0 + 0.06), 'gun');
  B.emis(at(roundedBox(0.02, 0.05, 0.014, 0.005, 1), x + 0.062, y + 0.02, z0 + 0.06), 'gun', gc, 2.0);

  switch (gun.id) {
    case 'vulcan': {
      // Six-barrel rotary on a spun hub, plus a fat ammo drum.
      B.frame(at(cyl(0.055, 0.058, 0.10, B.rad).rotateX(Math.PI / 2), x, y, z0 + 0.24), 'slide');
      const n = B.low ? 4 : 6;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * TAU;
        B.frame(at(cyl(0.019, 0.019, 0.34, 7).rotateX(Math.PI / 2),
          x + Math.cos(t) * 0.042, y + Math.sin(t) * 0.042, z0 + 0.40), 'spin');
      }
      B.shellA(at(cyl(0.070, 0.070, 0.055, B.rad).rotateX(Math.PI / 2), x, y, z0 + 0.54), 'spin');
      B.shellA(at(cyl(0.085, 0.095, 0.14, B.low ? 10 : 14).rotateZ(Math.PI / 2), x - 0.09, y - 0.02, z0 + 0.16), 'gun');
      B.emis(at(ringGeo(0.052, 0.008, B.low ? 10 : 16, 4), x, y, z0 + 0.56), 'slide', gc, 2.4);
      break;
    }
    case 'scatter': {
      // Short and wide: a flared choke and a visible shell rack.
      B.frame(at(cyl(0.048, 0.052, 0.26, B.rad).rotateX(Math.PI / 2), x, y, z0 + 0.30), 'slide');
      B.shellA(at(cyl(0.115, 0.062, 0.16, B.low ? 10 : 16, true).rotateX(-Math.PI / 2), x, y, z0 + 0.50), 'slide');
      B.frame(at(roundedBox(0.15, 0.05, 0.16, 0.012, a), x, y + 0.085, z0 + 0.22), 'gun');
      if (!B.low) {
        for (let i = 0; i < 4; i++) {
          B.emis(at(cyl(0.014, 0.014, 0.05, 6).rotateX(Math.PI / 2),
            x - 0.048 + i * 0.032, y + 0.085, z0 + 0.31), 'gun', gc, 1.8);
        }
      }
      B.emis(at(disc(0.085, B.low ? 10 : 16), x, y, z0 + 0.575), 'slide', gc, 2.0);
      break;
    }
    case 'lancer': {
      // A rail, not a gun. Long spine, three focusing rings, stabiliser fins.
      B.frame(at(roundedBox(0.05, 0.05, 0.62, 0.012, a), x, y, z0 + 0.42), 'slide');
      for (let i = 0; i < 3; i++) {
        const zz = z0 + 0.30 + i * 0.17;
        B.shellA(at(ringGeo(0.062 - i * 0.010, 0.020, B.low ? 10 : 16, 5), x, y, zz), 'spin');
        B.emis(at(ringGeo(0.062 - i * 0.010, 0.007, B.low ? 10 : 16, 4), x, y, zz + 0.016), 'spin', gc, 2.2);
      }
      for (const q of [-1, 1]) {
        const fin = taperBox(0.012, 0.030, 0.20, 0.03, 0.11, 0.006, a);
        fin.rotateX(Math.PI / 2);
        fin.rotateZ(q * 0.35);
        fin.translate(x + q * 0.055, y - 0.02, z0 + 0.24);
        B.shellA(fin, 'gun');
      }
      B.emis(at(disc(0.040, B.low ? 10 : 16), x, y, z0 + 0.70), 'slide', gc, 2.6);
      break;
    }
    case 'seeker': {
      // A boxed launcher: 2x3 cells with visible warhead tips and a seeker eye.
      B.shellA(at(roundedBox(0.17, 0.19, 0.30, 0.022, a), x, y + 0.01, z0 + 0.32), 'slide');
      for (let r = 0; r < 3; r++) {
        for (let c2 = 0; c2 < 2; c2++) {
          const px = x - 0.042 + c2 * 0.084;
          const py = y + 0.075 - r * 0.062;
          B.frame(at(cyl(0.030, 0.030, 0.06, 8).rotateX(Math.PI / 2), px, py, z0 + 0.46), 'slide');
          B.emis(at(disc(0.021, 8), px, py, z0 + 0.492), 'slide', gc, 2.2);
        }
      }
      B.frame(at(roundedBox(0.19, 0.03, 0.24, 0.008, 1), x, y + 0.115, z0 + 0.30), 'gun');
      B.emis(at(ball(0.028, B.low ? 6 : 10), x, y + 0.135, z0 + 0.40), 'gun', gc, 2.6);
      break;
    }
    default: {
      // TEMPEST: twin over-under barrels with a heat shroud between them.
      for (const q of [1, -1]) {
        const py = y + q * 0.048;
        B.frame(at(cyl(0.032, 0.034, 0.40, B.rad).rotateX(Math.PI / 2), x, py, z0 + 0.36), 'slide');
        B.shellA(at(cyl(0.044, 0.040, 0.09, B.rad).rotateX(Math.PI / 2), x, py, z0 + 0.52), 'slide');
        B.emis(at(ringGeo(0.030, 0.007, B.low ? 8 : 14, 4), x, py, z0 + 0.555), 'slide', gc, 2.3);
      }
      B.shellA(at(roundedBox(0.10, 0.055, 0.22, 0.016, a), x, y, z0 + 0.30), 'slide');
      if (!B.low) {
        for (let i = 0; i < 3; i++) {
          B.frame(at(roundedBox(0.115, 0.012, 0.03, 0.004, 1), x, y, z0 + 0.24 + i * 0.05), 'slide');
        }
      }
      B.emis(at(roundedBox(0.014, 0.07, 0.012, 0.004, 1), x + 0.055, y, z0 + 0.30), 'slide', gc, 1.8);
      break;
    }
  }

  // Muzzle flash — parked at scale 0, punched out by onFire().
  const fl = cyl(0.005, 0.14, 0.30, B.low ? 6 : 10, true);
  fl.rotateX(-Math.PI / 2);
  fl.translate(x, y, z0 + 0.62);
  B.flare(fl, 'flash', gc, 2.2);
  B.flare(at(ringGeo(0.10, 0.035, B.low ? 8 : 14, 4), x, y, z0 + 0.52), 'flash', gc, 1.6);
}

function buildBombArm(B, P, C) {
  const a = B.arc;
  const { bomb, em } = C;
  const x = -P.shX;
  const y = P.shY - P.elbowDrop - 0.26, z = 0.09;
  const bc = bomb.look.colour, bs = bomb.look.shell;

  // Forearm-mounted launcher. Angled off the arm so it never reads as a tube
  // glued to a tube.
  B.shellA(at(roundedBox(0.145, 0.20, 0.145, 0.024, a), x - 0.035, y + 0.04, z), 'bomb');
  B.frame(at(roundedBox(0.16, 0.05, 0.10, 0.012, a), x - 0.035, y + 0.15, z), 'bomb');

  switch (bomb.look.style) {
    case 'drum': {
      // QUAKE: a wide-mouth stubby mortar.
      B.frame(at(cyl(0.085, 0.070, 0.14, B.low ? 10 : 14), x - 0.035, y - 0.09, z), 'bomb');
      B.shellA(at(cyl(0.105, 0.082, 0.06, B.low ? 10 : 14), x - 0.035, y - 0.17, z), 'bomb');
      B.emis(at(disc(0.072, B.low ? 10 : 16).rotateX(Math.PI / 2), x - 0.035, y - 0.201, z), 'bomb', bc, 2.2);
      break;
    }
    case 'cluster': {
      // CLUSTER: a three-tube rack, because five apologies need somewhere to sit.
      for (let i = 0; i < 3; i++) {
        const ox = (i - 1) * 0.048;
        B.frame(at(cyl(0.026, 0.026, 0.15, 8), x - 0.035 + ox, y - 0.09, z), 'bomb');
        B.emis(at(disc(0.019, 8).rotateX(Math.PI / 2), x - 0.035 + ox, y - 0.166, z), 'bomb', bc, 2.2);
      }
      B.shellA(at(roundedBox(0.16, 0.05, 0.09, 0.012, a), x - 0.035, y - 0.04, z), 'bomb');
      break;
    }
    default: {
      // STANDARD / STICKY: a magazine drum feeding a single stubby tube.
      B.shellA(at(cyl(0.072, 0.072, 0.09, B.low ? 10 : 14).rotateZ(Math.PI / 2), x - 0.11, y + 0.02, z), 'bomb');
      B.frame(at(cyl(0.048, 0.044, 0.17, B.low ? 8 : 12), x - 0.035, y - 0.10, z), 'bomb');
      B.shellA(at(cyl(0.062, 0.052, 0.05, B.low ? 8 : 12), x - 0.035, y - 0.19, z), 'bomb');
      B.emis(at(disc(0.040, B.low ? 8 : 14).rotateX(Math.PI / 2), x - 0.035, y - 0.216, z), 'bomb', bc, 2.2);
      break;
    }
  }
  B.emis(at(roundedBox(0.05, 0.014, 0.012, 0.004, 1), x - 0.035, y + 0.13, z + 0.075), 'bomb', bs, 1.4);
}

function buildPod(B, P, C) {
  const a = B.arc;
  const { pod } = C;
  const y = P.hipY - 0.02, z = -P.hipD * 0.55 - 0.05;
  const pc = pod.look.colour, ps = pod.look.shell;
  const sz = pod.look.size;

  // Docking cradle so the pod never looks like it is floating behind the hips.
  B.frame(at(roundedBox(0.16, 0.05, 0.09, 0.012, a), 0, y + 0.05, z + 0.03), 'pod');

  switch (pod.look.style) {
    case 'tripod': {
      // SENTRY: a squat turret that clearly wants to sit down and shoot.
      B.shellL(at(cyl(sz * 0.62, sz * 0.75, sz * 0.55, B.low ? 8 : 12), 0, y - 0.03, z), 'pod');
      B.frame(at(cyl(sz * 0.34, sz * 0.34, sz * 0.30, 8), 0, y + 0.13, z), 'pod');
      B.emis(at(ringGeo(sz * 0.52, 0.010, B.low ? 10 : 16, 4).rotateX(Math.PI / 2), 0, y + 0.06, z), 'pod', pc, 2.2);
      if (!B.low) {
        for (let i = 0; i < 3; i++) {
          const t = (i / 3) * TAU;
          const leg = taperBox(0.018, 0.030, 0.13, 0.018, 0.030, 0.006, 1);
          leg.rotateZ(Math.sin(t) * 0.45);
          leg.rotateX(-Math.cos(t) * 0.45);
          leg.translate(Math.sin(t) * sz * 0.55, y - 0.13, z + Math.cos(t) * sz * 0.55);
          B.frame(leg, 'pod');
        }
      }
      break;
    }
    case 'ring': {
      // WRAITH: a hovering ring that circles and decides.
      B.shellL(at(ringGeo(sz * 0.80, sz * 0.22, B.low ? 12 : 18, 6).rotateX(Math.PI / 2), 0, y - 0.02, z), 'pod');
      B.frame(at(ball(sz * 0.34, B.low ? 6 : 10), 0, y - 0.02, z), 'pod');
      B.emis(at(ringGeo(sz * 0.80, 0.010, B.low ? 12 : 20, 4).rotateX(Math.PI / 2), 0, y - 0.02, z), 'pod', pc, 2.4);
      B.emis(at(ball(sz * 0.18, B.low ? 6 : 10), 0, y - 0.02, z), 'pod', ps, 2.0);
      break;
    }
    default: {
      // STINGER: a dart, nose-down in its cradle.
      const body = taperBox(sz * 0.30, sz * 0.75, sz * 1.5, sz * 0.30, sz * 0.75, 0.014, a);
      body.rotateX(0.35);
      body.translate(0, y - 0.06, z);
      B.shellL(body, 'pod');
      if (!B.low) {
        for (const q of [-1, 1]) {
          const fin = taperBox(0.010, 0.026, 0.11, 0.03, 0.09, 0.005, 1);
          fin.rotateZ(q * 0.5);
          fin.rotateX(0.35);
          fin.translate(q * sz * 0.42, y + 0.10, z - 0.05);
          B.shellL(fin, 'pod');
        }
      }
      B.emis(at(ball(sz * 0.20, B.low ? 6 : 10).scale(1, 1, 1.4), 0, y - 0.28, z + 0.10), 'pod', pc, 2.6);
      break;
    }
  }
}

const at = (g, x, y, z) => { g.translate(x, y, z); return g; };

// ---------------------------------------------------------------------------
// Outline hull
//
// Defect #24 — "mushy silhouette" — is not a shading problem, it is a problem
// of the robot and the background meeting at an edge that has no value break in
// it. Shading cannot fix that on its own, because the background changes: the
// arena has a light deck AND dark walls in the same frame, so any single body
// value merges with one of them somewhere along the outline.
//
// The answer the whole toy-robot genre uses is to stop leaving it to chance and
// draw the contour: a back-faced copy of the shell, pushed out along its welded
// normals, in near-black. Combined with the shell's hard rim light (which lands
// on the opposite, lit side of the same edges) every silhouette edge on the
// machine now carries a dark line, a bright line, or both — and that survives
// any background.
//
// The push is done in CLIP space, scaled by w, so the line is a constant width
// in SCREEN space. That is the property that matters: 2 px on a 700 px garage
// hero is a fine drawn contour, and the same 2 px on a 40 px robot in a wide
// arena shot is 5% of its height, which is exactly the help it needs there.
// A world-space extrusion would have given the opposite of that on both ends.
// ---------------------------------------------------------------------------

/**
 * NDC half-height units. ~3.1 px at 900p, and the same fraction on a phone.
 *
 * Why not thinner. The line has to WIN the few pixels either side of the
 * silhouette, not share them: at 1.9 px a 7x7 neighbourhood straddling the
 * contour was still more than half deck, so the local value step the eye reads
 * came out as the average of a black line and a near-white floor — about 17
 * levels, which is the "dissolves in motion" band. At 3.1 px the same
 * neighbourhood is mostly line, and the step is the full distance from the
 * machine's paint to near-black wherever the machine ends.
 *
 * Why not thicker. Past about 4 px the line stops reading as a drawn contour on
 * the machine and starts reading as a halo behind it — a sticker pasted on the
 * arena, which is the exact failure the near-black-with-a-trace-of-hull colour
 * below is guarding against.
 */
const OUTLINE_WIDTH = 0.0068;

const OUTLINE_PARS = /* glsl */`
uniform float uOutlineWidth;
`;

const OUTLINE_VERT = /* glsl */`
  {
    vec3 nOut = normalize(transformedNormal);
    #ifdef FLIP_SIDED
      // BackSide flips transformedNormal, and we want the OUTWARD direction.
      nOut = -nOut;
    #endif
    vec2 d = (projectionMatrix * vec4(nOut, 0.0)).xy;
    float dl = length(d);
    if (dl > 1e-5) {
      // x is squeezed by the aspect ratio so the contour is the same weight on
      // the sides as on the top; P00/P11 is exactly height/width.
      float ax = projectionMatrix[0][0] / projectionMatrix[1][1];
      gl_Position.xy += (d / dl) * vec2(ax, 1.0) * uOutlineWidth * gl_Position.w;
    }
  }
`;

/**
 * A geometry that IS the shell — same buffers, same skinning, zero extra VRAM —
 * but wearing the welded normals so the extrusion has no gaps. Everything the
 * outline does not read (uv, uv1, vertex colour) is simply left off.
 */
function outlineGeometry(src) {
  const g = new THREE.BufferGeometry();
  if (src.index) g.setIndex(src.index);
  g.setAttribute('position', src.attributes.position);
  g.setAttribute('normal', src.attributes.nweld || src.attributes.normal);
  if (src.attributes.skinIndex) g.setAttribute('skinIndex', src.attributes.skinIndex);
  if (src.attributes.skinWeight) g.setAttribute('skinWeight', src.attributes.skinWeight);
  g.boundingSphere = src.boundingSphere ? src.boundingSphere.clone() : null;
  return g;
}

/**
 * Contour colour: near-black carrying a trace of the body's own hue.
 *
 * A pure 0x000000 line around a coloured machine reads as a sticker cut out and
 * pasted onto the arena, and it also has nowhere to go on NOCTURNE, whose paint
 * is already near-black. Keeping ~10% of the primary means the contour is
 * always darker than the plate it borders, on every body in the roster.
 */
function outlineHex(look) {
  _col.setHex(look.primary ?? 0x101318);
  _col.multiplyScalar(0.045);
  _col.r += 0.004; _col.g += 0.005; _col.b += 0.009;
  return _col.getHex();
}

/**
 * @param hex  Contour colour, from outlineHex().
 */
function outlineMaterial(hex) {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(hex),
    side: THREE.BackSide,
    // The contour is drawn where the hull pokes past the real surface, so its
    // depth is the far surface's — a hair behind the near one at the exact
    // silhouette. The offset keeps that hair from flickering.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
    dithering: true,
  });
  const u = { uOutlineWidth: { value: OUTLINE_WIDTH } };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${OUTLINE_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${OUTLINE_VERT}`);
  };
  m.userData.u = u;
  m.customProgramCacheKey = () => 'roboOutline';
  return m;
}

// ---------------------------------------------------------------------------
// Ground contact
//
// Two pieces of floor live here rather than in the stage, because they belong
// to the robot: they have to exist in the garage and on the title screen, where
// there is no stage at all, and they have to follow the machine when it moves.
// ---------------------------------------------------------------------------

/** 2D context helper — local so this file owns its own texture generation. */
function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, g: c.getContext('2d') };
}

let _shadowTex = null;
let _shadowGeo = null;

/**
 * Soft round contact shadow.
 *
 * Pure black with an alpha ramp, composited normally: black * a + dst * (1 - a)
 * is exactly a multiply, so this darkens a near-white arena deck hard and a
 * near-black garage floor gently, which is the behaviour you want from a
 * shadow and not the behaviour you get from a grey decal.
 *
 * The ramp matters as much as the size. A flat opaque core reads as a hole cut
 * in the floor — in the garage it swallowed the pad, the feet and the lower
 * legs whole — so the alpha peaks below 1 and falls off continuously from the
 * first texel. Density is the material's job, not the texture's.
 */
function contactShadowTexture() {
  if (_shadowTex) return _shadowTex;
  const S = 128;
  const { c, g } = canvas2d(S);
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S * 2 - 1;
      const v = (y + 0.5) / S * 2 - 1;
      const r = Math.min(1, Math.hypot(u, v));
      // Umbra under the footprint, penumbra out to the rim — and nothing at
      // all past it, so the quad's edge is never visible.
      const core = 1 - ramp(0.0, 0.52, r);
      const skirt = 1 - ramp(0.0, 0.96, r);
      const a = clamp01(core * 0.55 + skirt * skirt * 0.42);
      const o = (y * S + x) * 4;
      d[o] = 0; d[o + 1] = 0; d[o + 2] = 0;
      d[o + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  _shadowTex = t;
  return t;
}

function contactShadowGeometry() {
  if (!_shadowGeo) _shadowGeo = new THREE.PlaneGeometry(2, 2);
  return _shadowGeo;
}

/** One per robot — the opacity is animated per machine, so it cannot be shared. */
function contactShadowMaterial() {
  return new THREE.MeshBasicMaterial({
    map: contactShadowTexture(),
    color: 0x000000,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
}

let _padMaps = null;

/**
 * The garage floor: a lit service pad for the hero to stand on.
 *
 * The review's complaint (#15) is that the machine hovers in a black void over a
 * one-pixel ellipse. A pad fixes that twice over — it gives the contact shadow
 * something to land on, and it gives the robot's dark frame and near-black
 * recesses a mid value to be read against, which is most of what makes a
 * silhouette legible. Deliberately mid-grey: a white pad would swallow the
 * light top planes that the paint just spent its whole budget establishing.
 */
function padTextures() {
  if (_padMaps) return _padMaps;
  const S = 512;
  const { c, g } = canvas2d(S);
  const img = g.createImageData(S, S);
  const d = img.data;
  const R = S * 0.5;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) - R, dy = (y + 0.5) - R;
      const r = Math.hypot(dx, dy) / R;          // 0 at centre, 1 at rim
      const th = Math.atan2(dy, dx);
      const o = (y * S + x) * 4;

      // Base deck: brushed grey, a touch cooler toward the rim. High enough to
      // sit clearly above the machine's shadow values and give the dark legs
      // and feet something to be a silhouette against; still a stop under the
      // hero plates, because a white pad would swallow the light top planes
      // the paint spends its whole budget establishing.
      let v = 0.50 - r * 0.14;

      // Tread hatching, rotated 45 degrees so it never lines up with the ticks.
      const hatch = Math.abs(((dx + dy) / 14) % 1 - 0.5);
      v += (hatch < 0.16 ? 0.022 : 0) * (r > 0.30 ? 1 : 0);

      // Scribed rings.
      for (const rr of [0.30, 0.62, 0.90]) {
        const t = Math.abs(r - rr);
        if (t < 0.006) v += 0.20;
        else if (t < 0.014) v -= 0.10;
      }

      // Radial ticks around the outer band, long ones on the quarters.
      const seg = th / TAU * 48;
      const tick = Math.abs(seg - Math.round(seg));
      const long = Math.abs(seg / 12 - Math.round(seg / 12)) < 0.02;
      if (r > (long ? 0.66 : 0.74) && r < 0.88 && tick < 0.10) v += 0.16;

      // A single warm hazard wedge, so the pad has one non-grey note and the
      // camera has something to read rotation against.
      const wedge = Math.abs(((th + Math.PI) / TAU * 8) % 1 - 0.5);
      const warm = (r > 0.34 && r < 0.58 && wedge > 0.30) ? 1 : 0;

      // Dark blast staining under the middle, where the machine stands. Light:
      // the contact shadow already lands here, and two darkenings stacked on
      // the same 40cm is how the pad disappeared in the first place.
      v -= (1 - ramp(0.0, 0.42, r)) * 0.07;

      const cr = clamp01(v * (1 + warm * 0.55));
      const cg = clamp01(v * (1 + warm * 0.20));
      const cb = clamp01(v * (1 - warm * 0.35) + 0.012);

      // Alpha dissolves the rim so the pad reads as a lit patch of a bigger
      // floor rather than as a coin sitting in space.
      const a = 1 - ramp(0.72, 1.0, r);

      d[o] = Math.sqrt(cr) * 255;
      d[o + 1] = Math.sqrt(cg) * 255;
      d[o + 2] = Math.sqrt(cb) * 255;
      d[o + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  _padMaps = { map };
  return _padMaps;
}

// ---------------------------------------------------------------------------
// Silhouette LOD
//
// The machine is thirty-odd chamfered boxes with their own chamfers, and at
// gameplay range most of them are not plates any more. Measured on the pinned
// foundry frame the far robot is 38x42 px: the head antenna is 0.26 px wide,
// the pelvic trim strips 0.22 px, the chest bolt columns 0.6 px across. None of
// those is a shape at that size. Each is a fleck one or two levels off the
// plate under it, and the mass meter counts flecks.
//
// So they are not drawn. This is the one item in the art prescription that is
// FREE — it removes triangles rather than adding a term — and it is the reason
// the phone gets faster rather than slower for the fix.
//
// HOW IT COSTS NOTHING AT RUNTIME. Each bucket's primitives are sorted by mean
// projected area BEFORE the merge, so the merged index buffer runs
// largest-first and every "drop the small stuff" cut is a contiguous prefix.
// Choosing a detail level is then one binary search and one setDrawRange —
// no rebuild, no second geometry, no extra memory, no pop from swapping
// meshes, and it works per-machine because the near and far robot are simply
// at different depths.
// ---------------------------------------------------------------------------

/**
 * Drop a primitive once its mean projection falls under this many square
 * pixels of the actual render target.
 *
 * In PIXELS and not in the frame-height fractions vSizeX and OUTLINE_WIDTH use,
 * and the difference is deliberate. Those two are angular-size problems — a
 * machine that is 8% of the frame is equally illegible on a phone and on a
 * desktop, so its rim must not depend on the panel. This is a RESOLUTION
 * problem: a primitive that lands on half a pixel is aliasing whatever the
 * screen, and there is nothing to be gained by rasterising it. It also means a
 * phone, which renders this scene at renderScale 0.72, drops strictly MORE than
 * the desktop the numbers are measured on — so a count verified at 1600x900 is
 * an upper bound on what a phone draws, never a claim made on its behalf.
 *
 * Two square pixels is where a piece stops being a shape and becomes a fleck.
 * Swept against the mass meter over 0.5 / 2 / 6 / 12; see the round's notes.
 */
const LOD_MIN_PX2 = 2.0;

/**
 * The machine's height in world units — the reference length the on-screen size
 * is measured against, shared with the shell shader's vSizeX so the geometry LOD
 * and the light's size gate cannot drift apart.
 */
const BODY_H = 2.3;

/**
 * Sort one bucket largest-first and return the table the runtime cut uses.
 *
 *   need[k]  the reciprocal of primitive k's mean projected area — the value of
 *            (pixels per metre)^2 per square pixel it wants. Ascending, because
 *            area is descending. Kept free of the threshold itself so the
 *            threshold stays a live number: sweeping it against the mass meter
 *            costs one browser launch instead of one rebuild per value.
 *   upto[k]  how many indices to draw to INCLUDE primitive k.
 *
 * Sorting is free of side effects: the merge concatenates in list order and
 * every attribute — paint, UVs, skin binding, welded normals — is already baked
 * per primitive, so reordering moves whole primitives and nothing else. All
 * four buckets are depth-tested opaque or additive, and both are order
 * independent.
 */
function buildLodTable(list, areas) {
  const n = list.length;
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => areas[b] - areas[a]);

  const sorted = new Array(n);
  const need = new Float64Array(n);
  const upto = new Uint32Array(n);
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const g = list[order[k]];
    sorted[k] = g;
    const a = areas[order[k]];
    need[k] = a > 0 ? 1 / a : 0;
    acc += g.index ? g.index.count : g.attributes.position.count;
    upto[k] = acc;
  }
  // A sort by area is not exactly a sort by `need` when an area is zero or
  // non-finite (a degenerate primitive, or one this file could not measure).
  // Force the table monotone rather than handing a binary search an array that
  // is only nearly sorted.
  for (let k = 1; k < n; k++) if (need[k] < need[k - 1]) need[k] = need[k - 1];
  return { list: sorted, need, upto, total: acc };
}

/**
 * Indices to draw at a given square-pixels-per-square-metre budget — that is,
 * (pixels per metre)^2 divided by the minimum area a piece has to cover.
 * Never drops everything.
 */
function lodDrawCount(t, budget) {
  const { need, upto } = t;
  if (!upto.length) return 0;
  if (need[need.length - 1] <= budget) return t.total;
  let lo = 0, hi = need.length;            // first k with need[k] > budget
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (need[mid] <= budget) lo = mid + 1; else hi = mid;
  }
  // Always keep the largest piece: a robot that renders as nothing is a bug,
  // and frustum culling is the right tool for a machine that is genuinely gone.
  return upto[Math.max(0, lo - 1)];
}

const _lodPos = new THREE.Vector3();
const _lodSize = new THREE.Vector2();

// ---------------------------------------------------------------------------
// RoboModel
// ---------------------------------------------------------------------------

export class RoboModel {
  constructor(loadout, teamColor, settings, envMap = null) {
    this.loadout = loadout;
    this.teamColor = teamColor;
    this.settings = settings;
    this.envMap = envMap;
    this.preview = false;

    this.group = new THREE.Group();
    this.group.name = 'robo';
    this.height = 1.62;

    // --- animation state (all scalars; update() never allocates)
    this.fAir = 0; this.fDash = 0; this.fDown = 0; this.fMove = 0; this.fGetup = 0;
    this.land = 0; this.prevVy = 0; this.wasGrounded = true;
    this.recoil = 0; this.recoilB = 0; this.flash = 0;
    this.spinAngle = 0; this.spinRate = 0;
    this.tumble = 0; this.getupT = 99;
    this.lean = 0; this.bank = 0; this.breathe = 0;
    this.podOpen = 0; this.heat = 0; this.chargeAmt = 0;
    this.prevState = 0;

    // --- silhouette LOD state. lodMinPx2 is per-model rather than a module
    // constant so the meter can sweep it live; 0 disables the LOD entirely,
    // which is the control every claim made about it has to be run against.
    this.lod = [];
    this._lodBudget = -1;
    this.lodPx = Infinity;
    this.lodMinPx2 = LOD_MIN_PX2;

    this._build();
  }

  // -------------------------------------------------------------------------

  get _low() {
    const s = this.settings;
    return s.particleBudget <= 300 || s.anisotropy <= 2;
  }

  _build() {
    const ld = this.loadout;
    const look = ld.body.look;
    const P = SIL[look.silhouette] || SIL.strider;
    const L = LEGS[ld.legs.look.style] || LEGS.sprinter;
    const low = this._low;

    this.P = P;
    this.L = L;
    this.low = low;
    this.refSpeed = ld.body.moveSpeed;
    this.chargeTicks = ld.gun.chargeTicks || 50;
    this.legStyle = ld.legs.look.style;
    this.walkGain = L.walk;

    const team = (teamHex) => (teamHex === 0 || teamHex === 1) ? TEAM_TINT[teamHex] : teamHex;
    const teamHex = team(this.teamColor);

    const rig = buildRig(P, L);
    this.rig = rig;
    this.group.add(rig.bones[0]);

    // One palette for the whole machine, derived from the body's look plus the
    // legs' own colour, and handed to every layout function. This is where the
    // model's value structure is decided; the builders only say which role a
    // plate plays.
    const pal = buildPalette(look, ld.legs.look.colour);
    this.pal = pal;

    const B = new Build(rig, { arc: low ? 1 : 1, radial: low ? 8 : 12, low, pal });
    const C = {
      look, legs: ld.legs, gun: ld.gun, bomb: ld.bomb, pod: ld.pod,
      em: look.emissive, ac: look.accent, team: teamHex, pal,
    };

    buildPelvis(B, P, C);
    buildChest(B, P, C);
    buildBackpack(B, P, C);
    buildHead(B, P, C);
    for (const s of [-1, 1]) {
      buildShoulder(B, P, C, s);
      buildArm(B, P, C, s);
      buildLeg(B, P, L, C, s);
    }
    // Hardware paints itself: weapons default to neutral gunmetal so a gun never
    // dissolves into the arm it is bolted to.
    B.def = pal.gunmetal;
    buildGun(B, P, C);
    buildBombArm(B, P, C);
    buildPod(B, P, C);
    B.def = null;

    // --- materials -----------------------------------------------------------
    const texSize = low ? 256 : 512;
    const aniso = this.settings.anisotropy;

    // ONE neutral detail bake for the whole machine — and, because armorTexture
    // caches on the look, for every machine in the match. Hue and value are the
    // vertex paint's job now, so there is nothing left for a per-part bake to
    // decide except panel layout, and one panel layout is plenty.
    const maps = armorTexture(NEUTRAL_LOOK, texSize, 0);
    for (const t of Object.values(maps)) if (t?.isTexture) t.anisotropy = aniso;

    // Rim and energy are an ACCENT on painted metal, not the material itself.
    // This is defect #5: at the strengths this shipped with, the fresnel term
    // out-ran the albedo everywhere the surface turned away from camera, which
    // is every chamfer on the model — so each plate glowed along its own edges,
    // interior structure glowed through the plate in front of it, and the whole
    // machine read as blue glass. A rim is allowed to describe an edge. It is
    // not allowed to describe the whole robot.
    this.matShell = roboShell(maps, look, teamHex, {
      // Shared with the geometry LOD, so the size gate the light reads and the
      // size the greebles are dropped at cannot drift apart.
      bodyH: BODY_H,
      rimStrength: 0.10, rimPower: 5.2, energy: 0.03,
      normalScale: 1.15, envMapIntensity: 0.5,
      // The governor — see FILL_FRAG. The ceiling is what stops the arena
      // deciding how many value bands the machine occupies; the specular lid is
      // what stops the two sweeping practicals writing bright islands onto a
      // machine forty pixels wide.
      lightCeil: 1.15, lightKnee: 0.60, lightPivot: 0.50,
      flat: 0.0, flatFar: 0.0, specCap: 0.45,
      // Hemispheric bounce card — see FILL_FRAG. Deliberately cool above and
      // dim/warm below so it adds a top and a bottom rather than flattening the
      // machine out, and deliberately well under the key: at these values the
      // shell reads roughly two thirds key, one third bounce, which is a lit
      // model kit rather than an ambient-occlusion render. fillDark is the
      // separate stop and a half handed to a machine standing where no light
      // reaches, which is where the far robot spends most of a duel.
      fillUp: 0x74889f, fillDown: 0x3b3138, fillDark: 1.6,
    });
    // Without this the entire paint system above is dead code and every plate
    // renders at the neutral bake's value — one blue-grey machine, defect #24.
    this.matShell.vertexColors = true;
    this.matShell.envMap = this.envMap;

    const tr = TRIM[look.trim] || TRIM.gunmetal;
    this.matFrame = new THREE.MeshStandardMaterial({
      color: new THREE.Color(tr.color),
      roughness: tr.rough,
      metalness: tr.metal,
      envMap: this.envMap,
      // The frame is the model's line art. A hot env reflection turns black
      // line art into chrome highlight and the lines stop being lines.
      envMapIntensity: 0.55,
      vertexColors: true,
      dithering: true,
    });

    this.matEmis = new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, toneMapped: false, fog: false,
    });
    this.matFlare = additive(0xffffff, { opacity: 0.5, side: THREE.DoubleSide });
    this.matFlare.vertexColors = true;

    // --- meshes --------------------------------------------------------------
    this.meshes = [];
    this.shellMats = [this.matShell];

    const shadows = !!this.settings.shadows;
    // Geometries whose draw range the silhouette LOD moves, with the table that
    // says where to cut. Populated by mk() below.
    this.lod = [];
    const mk = (name, mat, opts = {}) => {
      const list = B.buckets[name];
      if (!list.length || !mat) return null;
      // Sorted largest-first so every LOD cut is a prefix of the index buffer.
      // The flare bucket is deliberately NOT sorted or cut: muzzle flash and
      // thruster plumes are gameplay tells, and a tell that disappears because
      // the machine got small is a bug, not a level of detail.
      const table = opts.noLod ? null : buildLodTable(list, B.areas[name]);
      const geo = mergeGeometries(table ? table.list : list);
      ensureAOChannel(geo);
      geo.boundingSphere = _sphere.clone();
      const m = new THREE.SkinnedMesh(geo, mat);
      m.castShadow = shadows && !opts.noShadow;
      m.receiveShadow = shadows && !opts.noShadow;
      if (opts.order !== undefined) m.renderOrder = opts.order;
      if (table) this.lod.push({ geo, table });
      this.group.add(m);
      this.meshes.push(m);
      return m;
    };

    // Bind after the rest pose is resolved — Skeleton derives its inverses from
    // the bones' world matrices, so they have to be current and un-posed.
    this.group.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(rig.bones);

    // Four draw calls for the entire machine: painted shell, dark frame, lit
    // emissives, additive plumes.
    const shellMesh = mk('shell', this.matShell);
    mk('frame', this.matFrame);
    mk('emis', this.matEmis, { noShadow: true, order: 1 });
    mk('flare', this.matFlare, { noShadow: true, order: 3, noLod: true });

    // Fifth: the contour. Shares every buffer with the shell, so it costs one
    // draw call and no memory. Drawn FIRST so the shell's own front faces land
    // on top of it and the line only survives where it pokes past the machine.
    this.matOutline = outlineMaterial(outlineHex(look));
    if (shellMesh) {
      const om = new THREE.SkinnedMesh(outlineGeometry(shellMesh.geometry), this.matOutline);
      om.castShadow = false;
      om.receiveShadow = false;
      om.renderOrder = -1;
      this.outline = om;
      this.group.add(om);
      this.meshes.push(om);
      // The contour is drawn from the shell's own index buffer, so it has to be
      // cut at the same place. Left out, the outline would keep drawing hulls
      // around plates the shell had already stopped drawing — a machine trailing
      // detached black flecks, which is worse than the greebles it removed.
      const shellLod = this.lod.find((e) => e.geo === shellMesh.geometry);
      if (shellLod) this.lod.push({ geo: om.geometry, table: shellLod.table });
    }

    // One hook per mesh rather than one for the model: three.js calls
    // onBeforeRender per drawn object, and the frame mesh can be reached before
    // the shell. _applyLod is idempotent and early-outs on an unchanged size, so
    // paying for it five times a frame costs a comparison.
    for (const m of this.meshes) {
      m.onBeforeRender = (renderer, scene, camera) => this._applyLod(renderer, camera);
    }

    for (const m of this.meshes) m.bind(this.skeleton, m.matrixWorld);

    // Fifth call: the thing that puts the machine ON the floor rather than in
    // front of it (defect #15). Not skinned, not parented to the rig — a
    // contact shadow belongs to the ground, not to the body that throws it.
    this.shadow = new THREE.Mesh(contactShadowGeometry(), contactShadowMaterial());
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = -1;
    // Sized off the STANCE, not the machine. The previous number came out at
    // 1.02 — a two-metre black disc under a 1.6m robot, which on the garage's
    // dark floor read as a pit and on the arena's bright deck as a bruise. A
    // contact shadow is the size of what touches the floor plus a little
    // penumbra, and nothing else on the model gets a vote.
    this.shadowRadius = 0.30 + P.chestW * 0.26 + L.footW * 0.60;
    this.shadow.scale.setScalar(this.shadowRadius);
    this.group.add(this.shadow);

    // --- bone handles used every frame --------------------------------------
    const g = (n) => rig.get(n);
    this.bRoot = g('root'); this.bPelvis = g('pelvis'); this.bSpine = g('spine');
    this.bChest = g('chest'); this.bNeck = g('neck'); this.bHead = g('head');
    this.bPack = g('pack'); this.bCore = g('core'); this.bPod = g('pod');
    this.bClavL = g('clavL'); this.bArmL = g('armL'); this.bForeL = g('foreL'); this.bHandL = g('handL');
    this.bClavR = g('clavR'); this.bArmR = g('armR'); this.bForeR = g('foreR'); this.bHandR = g('handR');
    this.bSlide = g('slide'); this.bSpin = g('spin'); this.bMuzzle = g('muzzle'); this.bFlash = g('flash');
    this.bThighL = g('thighL'); this.bShinL = g('shinL'); this.bFootL = g('footL'); this.bToeL = g('toeL');
    this.bThighR = g('thighR'); this.bShinR = g('shinR'); this.bFootR = g('footR'); this.bToeR = g('toeR');
    this.bHipL = g('hipL'); this.bHipR = g('hipR');
    this.bThrL = g('thrL'); this.bThrR = g('thrR');
    this.bBootL = g('bootL'); this.bBootR = g('bootR');

    this.bFlash.scale.setScalar(0.0001);
    this.bThrL.scale.setScalar(0.0001);
    this.bThrR.scale.setScalar(0.0001);
    this.bBootL.scale.setScalar(0.0001);
    this.bBootR.scale.setScalar(0.0001);

    // Tumble pivot sits at the robot's centre of mass, not its feet.
    this.pivotY = P.hipY * 0.65 + 0.35;
  }

  /**
   * Pick a detail level for the size this machine is actually being drawn at.
   *
   * Called from every LOD'd mesh's onBeforeRender, which is the only place that
   * knows BOTH the camera the frame is being rendered from and the resolution it
   * is being rendered at. Doing it in update() instead would need a camera this
   * file has no reference to, and would get the garage's preview camera wrong.
   *
   * The size expression is the CPU twin of the shader's vSizeX and is kept
   * identical to it on purpose — same uBodyH, same P11, same view-space depth,
   * same halving of the 2.0-tall NDC range — so the geometry that gets dropped
   * and the light that gets flattened are answering the same question about the
   * same machine.
   *
   * Reads the bound render target's height, not the canvas': the quality tiers
   * render this scene at renderScale 0.72 and 0.88 before the post chain
   * upsamples it, and a LOD that measured the canvas would draw half-pixel
   * greebles into a buffer that has no pixels for them.
   */
  _applyLod(renderer, camera) {
    if (!this.lod || !this.lod.length) return;
    let budget = Infinity;
    // The garage is where a player inspects the parts they just bought, and it
    // is one machine on the screen. Full detail, always.
    if (!this.preview && camera && camera.isPerspectiveCamera && renderer && this.lodMinPx2 > 0) {
      const rt = renderer.getRenderTarget();
      const h = rt ? rt.height : renderer.getDrawingBufferSize(_lodSize).y;
      _lodPos.setFromMatrixPosition(this.group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      const depth = Math.max(1e-3, -_lodPos.z);
      const px = BODY_H * camera.projectionMatrix.elements[5] / depth * 0.5 * h;
      this.lodPx = px;
      const perMetre = px / BODY_H;
      budget = perMetre * perMetre / this.lodMinPx2;
    } else {
      this.lodPx = Infinity;
    }
    if (budget === this._lodBudget) return;
    this._lodBudget = budget;
    for (const e of this.lod) e.geo.setDrawRange(0, lodDrawCount(e.table, budget));
  }

  _teardown() {
    this.lod = [];
    this._lodBudget = -1;
    for (const m of this.meshes || []) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.meshes = [];
    if (this.shadow) {
      // The geometry and the texture are module-shared; only the material is
      // this robot's to free.
      this.shadow.material.dispose();
      this.group.remove(this.shadow);
      this.shadow = null;
    }
    this.outline = null;
    for (const m of [this.matShell, this.matFrame, this.matEmis, this.matFlare, this.matOutline]) {
      m?.dispose();
    }
    this.skeleton?.dispose?.();
    if (this.rig) this.group.remove(this.rig.bones[0]);
    this.rig = null;
  }

  // -------------------------------------------------------------------------
  // Animation
  // -------------------------------------------------------------------------

  /** Damped absolute-local euler assign, taken as a delta on the rest pose. */
  _rot(b, dx, dy, dz, k, dt) {
    const r = b.rotation;
    r.x = damp(r.x, b.rx0 + dx, k, dt);
    r.y = damp(r.y, dy, k, dt);
    r.z = damp(r.z, dz, k, dt);
  }

  update(robo, dt, time) {
    dt = Math.min(dt, 0.05);
    const P = this.P, L = this.L;
    const st = robo.state;
    const isDown = st === 2, isDead = st === 4, isDash = st === 1, isGetup = st === 3;

    // --- root placement ------------------------------------------------------
    this.group.position.set(robo.pos.x, robo.pos.y, robo.pos.z);
    this.group.rotation.y = robo.yaw;

    if (st !== this.prevState) {
      if (st === 3) this.getupT = 0;
      this.prevState = st;
    }
    if (isGetup) this.getupT += dt;

    // --- blend factors -------------------------------------------------------
    const sy = Math.sin(robo.yaw), cy = Math.cos(robo.yaw);
    const fwdV = robo.vel.x * sy + robo.vel.z * cy;
    const sideV = robo.vel.x * cy - robo.vel.z * sy;
    const speed = Math.hypot(robo.vel.x, robo.vel.z);
    const gait = clamp01(speed / Math.max(1, this.refSpeed)) * clamp01(robo.moveAmt * 1.6 + 0.15);

    this.fAir = damp(this.fAir, robo.grounded ? 0 : 1, 13, dt);
    this.fDash = damp(this.fDash, isDash ? 1 : 0, isDash ? 22 : 9, dt);
    this.fDown = damp(this.fDown, (isDown || isDead) ? 1 : 0, (isDown || isDead) ? 15 : 6, dt);
    this.fMove = damp(this.fMove, robo.grounded ? gait : 0, 10, dt);
    this.fGetup = clamp01(1 - this.getupT / 0.55) * (isGetup ? 1 : 0);
    this.fGetup = damp(this.fGetup, isGetup ? clamp01(1 - this.getupT / 0.55) : 0, 14, dt);

    // Landing impact from the last airborne vertical velocity.
    if (robo.grounded && !this.wasGrounded) this.land = clamp01(Math.abs(this.prevVy) / 15);
    this.land = Math.max(0, this.land - dt * 4.6);
    this.wasGrounded = robo.grounded;
    if (!robo.grounded) this.prevVy = robo.vel.y;

    this.recoil = Math.max(0, this.recoil - dt / 0.15);
    this.recoilB = Math.max(0, this.recoilB - dt / 0.20);
    this.flash = Math.max(0, this.flash - dt / 0.055);
    this.podOpen = Math.max(0, this.podOpen - dt / 0.5);
    this.heat = damp(this.heat, clamp01(robo.boostHeat) + this.fDash * 0.6 + this.fAir * 0.25, 11, dt);
    this.chargeAmt = damp(this.chargeAmt, clamp01(robo.charge / this.chargeTicks), 9, dt);

    const limbK = lerp(48, 4.5, this.fDown);
    const bodyK = lerp(26, 4.0, this.fDown);

    // --- tumble / knockdown --------------------------------------------------
    if (isDown || isDead) {
      const rate = (5.2 + clamp01(speed / 12) * 5.0) * (robo.grounded ? 0.22 : 1);
      this.tumble += dt * rate;
      if (this.tumble > TAU) this.tumble -= TAU;
    } else {
      this.tumble = damp(this.tumble, TAU, 8, dt);
      if (this.fDown < 0.02) this.tumble = 0;
    }

    // --- locomotion ----------------------------------------------------------
    const walk = this.fMove * this.walkGain;
    const p = robo.stepPhase * 0.8;
    const sp = Math.sin(p), cp = Math.cos(p);
    const breatheAmp = this.preview ? 1 : 0.35;
    // The idle bob is a function of the CLOCK, not an accumulator fed by dt.
    //
    // Same rate, same amplitude, and nothing on screen changes — but it is the
    // sixth instrument fault in this project and it lives in this file. A
    // dt-accumulator advances once per RENDERED FRAME, so its phase is a
    // function of how many frames the browser managed between boot and the
    // shutter, which is a function of how loaded the machine was. Every
    // "pinned" frame the mass and contour meters take was photographing a
    // machine bobbing at a slightly different point in its cycle: measured over
    // three identical runs of an unchanged build, the near robot's bounding box
    // came back 260, 261 and 264 px tall and its largest mass swung 57%..65%.
    // Pinning engine.clock.elapsed — round 10's fix — could not close that,
    // because this accumulator never reads the clock at all.
    //
    // Deriving it from `time` makes the pose a pure function of the pinned
    // clock, which is what "pinned" was supposed to mean. The idle is a
    // free-running oscillator with no state to preserve, so there is nothing to
    // lose by recomputing it: the two machines were already in lockstep, since
    // both accumulators started at zero on the same frame.
    this.breathe = time * (this.preview ? 1.5 : 2.2);
    const bob = Math.sin(this.breathe) * 0.008 * breatheAmp;

    const air = this.fAir, dash = this.fDash, dwn = this.fDown, gu = this.fGetup;
    const ground = (1 - air) * (1 - dwn);

    // Chassis lean: dash pushes hard into the velocity, walking leans a little.
    const leanT = (fwdV * (0.012 + dash * 0.030)) * (1 - dwn) + gu * 0.30;
    const bankT = (-sideV * (0.010 + dash * 0.022)) * (1 - dwn);
    this.lean = damp(this.lean, clamp(leanT, -0.55, 0.55), 12, dt);
    this.bank = damp(this.bank, clamp(bankT, -0.42, 0.42), 12, dt);

    // Root: squash on landing, stretch on the way up, tumble about the CoM.
    const squash = this.land;
    const stretch = clamp01(Math.max(0, robo.vel.y) / 16) * air;
    const root = this.bRoot;
    root.position.y = -squash * 0.14 - gu * 0.22 + bob;
    root.scale.set(1 + squash * 0.09 - stretch * 0.05, 1 - squash * 0.13 + stretch * 0.10, 1 + squash * 0.09 - stretch * 0.05);
    root.rotation.x = this.lean + this.tumble * dwn;
    root.rotation.z = this.bank + Math.sin(this.tumble * 0.75) * 0.42 * dwn;
    root.position.z = -Math.sin(this.tumble * dwn) * this.pivotY * dwn;
    root.position.y += (1 - Math.cos(this.tumble * dwn)) * this.pivotY * dwn;

    // --- pelvis / spine ------------------------------------------------------
    const hipSway = sp * 0.030 * walk;
    this.bPelvis.position.x = damp(this.bPelvis.position.x, this.bPelvis.px0 + hipSway, limbK, dt);
    this.bPelvis.position.y = damp(this.bPelvis.position.y,
      this.bPelvis.py0 + Math.sin(p * 2) * 0.028 * walk - gu * 0.10 - air * 0.02, limbK, dt);
    this._rot(this.bPelvis, -gu * 0.18 + air * 0.10, sp * 0.16 * walk, -sp * 0.075 * walk, limbK, dt);

    // Aim split: the chest carries most of the yaw offset, the head the rest.
    const dYaw = angleDelta(robo.yaw, robo.aimYaw);
    const pitch = robo.aimPitch;
    const recoilAbsorb = this.recoil * 0.9;

    this._rot(this.bSpine,
      -pitch * 0.10 + recoilAbsorb * -0.10 + gu * 0.34 + air * 0.06,
      dYaw * 0.30 - sp * 0.06 * walk, 0, bodyK, dt);
    this._rot(this.bChest,
      -pitch * 0.18 + recoilAbsorb * -0.14 + gu * 0.26 - squash * 0.10 + Math.sin(this.breathe) * 0.012 * breatheAmp,
      dYaw * 0.34 - sp * 0.10 * walk,
      sp * 0.04 * walk, bodyK, dt);
    this._rot(this.bNeck, -pitch * 0.22 - gu * 0.30, dYaw * 0.22, 0, bodyK * 1.2, dt);
    this._rot(this.bHead, -pitch * 0.26 + squash * 0.10, dYaw * 0.14 + sp * 0.03 * walk, -sp * 0.03 * walk, bodyK * 1.2, dt);

    // --- gun arm: rest pose already aims down +Z, so this is a pure delta -----
    const aimK = lerp(30, 5, dwn);
    const gunSag = -0.06 - air * 0.10;
    this._rot(this.bClavR, -pitch * 0.12, dYaw * 0.20, -air * 0.10, aimK, dt);
    this._rot(this.bArmR,
      -pitch * 0.72 + this.recoil * 0.34 + gunSag + sp * 0.05 * walk + gu * 0.5,
      dYaw * 0.32 - air * 0.12,
      -0.05 - air * 0.30 - dash * 0.10, aimK, dt);
    this._rot(this.bForeR, -pitch * 0.20 + this.recoil * 0.16 + gu * 0.4, 0, 0, aimK, dt);
    this._rot(this.bHandR, this.recoil * 0.10, 0, 0, aimK, dt);
    this.bSlide.position.z = damp(this.bSlide.position.z, this.bSlide.pz0 - this.recoil * 0.085, 26, dt);

    // Rotary barrels spin up while charging or firing and coast back down.
    this.spinRate = damp(this.spinRate, this.recoil * 26 + this.chargeAmt * 12, 6, dt);
    this.spinAngle += this.spinRate * dt;
    this.bSpin.rotation.z = this.loadout.gun.id === 'lancer' ? -this.spinAngle * 0.4 : this.spinAngle;

    // --- free arm: contralateral swing, balance flare, bomb throw ------------
    const swing = -sp * 0.55 * walk;
    this._rot(this.bClavL, 0, -dYaw * 0.10, air * 0.12, limbK, dt);
    this._rot(this.bArmL,
      swing + air * -0.55 + dash * 0.25 - this.recoilB * 0.85 + gu * 0.6 - squash * 0.25,
      -dYaw * 0.10,
      0.10 + air * 0.55 + dash * 0.12 + dwn * 0.3, limbK, dt);
    this._rot(this.bForeL,
      -0.10 - Math.max(0, -sp) * 0.30 * walk - air * 0.35 + this.recoilB * 0.5 + gu * 0.7,
      0, 0, limbK, dt);
    this._rot(this.bHandL, -this.recoilB * 0.3, 0, 0, limbK, dt);

    // --- legs ----------------------------------------------------------------
    const hover = this.legStyle === 'hover';
    if (hover) {
      // HOVER-V never steps: it banks, trails and lets the turbines do the work.
      const trail = clamp(fwdV * 0.018, -0.30, 0.30);
      for (const s of [0, 1]) {
        const th = s ? this.bThighR : this.bThighL;
        const sh = s ? this.bShinR : this.bShinL;
        const ft = s ? this.bFootR : this.bFootL;
        const to = s ? this.bToeR : this.bToeL;
        const q = s ? 1 : -1;
        this._rot(th, -trail * 0.8 - air * 0.18 + squash * 0.30 + gu * 0.9, 0, q * (0.05 + air * 0.10), limbK * 0.8, dt);
        this._rot(sh, trail * 0.5 + squash * 0.35 + gu * 0.6, 0, 0, limbK * 0.8, dt);
        this._rot(ft, -trail * 0.4 - squash * 0.20 - gu * 0.5, 0, 0, limbK * 0.8, dt);
        to.rotation.y += dt * (5 + this.heat * 26);
      }
    } else {
      for (const s of [0, 1]) {
        const ph = s ? p + Math.PI : p;
        const s2 = Math.sin(ph), c2 = Math.cos(ph);
        const th = s ? this.bThighR : this.bThighL;
        const sh = s ? this.bShinR : this.bShinL;
        const ft = s ? this.bFootR : this.bFootL;
        const to = s ? this.bToeR : this.bToeL;
        const q = s ? 1 : -1;

        // Walk cycle: thigh swings, knee flexes on the recovery half, the foot
        // stays level under it and the toe pushes off at the end of stance.
        const wThigh = -s2 * 0.62 * walk;
        const wShin = Math.max(0, Math.sin(ph - 1.0)) * 0.95 * walk;
        const wFoot = -(wThigh + wShin) * 0.55 + Math.max(0, -c2) * 0.22 * walk;
        const wToe = Math.max(0, -Math.sin(ph + 0.6)) * 0.35 * walk;

        // Airborne: legs tuck and trail behind the direction of travel.
        const trail = clamp(fwdV * 0.014, -0.28, 0.28);
        const aThigh = -0.50 - trail + (s ? 0.14 : -0.10);
        const aShin = 1.05 + (s ? -0.16 : 0.14);
        const aFoot = -0.35;

        const dThigh = -0.34 - trail * 1.2 + (s ? 0.10 : -0.06);
        const dShin = 0.72;

        let rt = lerp(wThigh, aThigh, air);
        let rs = lerp(wShin, aShin, air);
        let rf = lerp(wFoot, aFoot, air);
        rt = lerp(rt, dThigh, dash * (1 - air) * 0.8);
        rs = lerp(rs, dShin, dash * (1 - air) * 0.8);

        // Landing absorption + get-up crouch.
        rt += -squash * 0.55 - gu * 0.95;
        rs += squash * 1.05 + gu * 1.5;
        rf += -squash * 0.45 - gu * 0.55;

        this._rot(th, rt, q * 0.03 * walk * s2, q * (0.035 + air * 0.10 + squash * 0.10), limbK, dt);
        this._rot(sh, rs, 0, 0, limbK, dt);
        this._rot(ft, rf, 0, -q * 0.03, limbK, dt);
        this._rot(to, lerp(wToe, 0.30, air) + squash * 0.25, 0, 0, limbK, dt);
      }
    }

    // --- thrusters, pod bay, reactor ----------------------------------------
    const heat = clamp01(this.heat);
    const flick = 0.82 + Math.sin(time * 47 + this.spinAngle) * 0.18;
    const mainT = (heat * 0.9 + air * 0.25) * flick;
    this.bThrL.scale.set(0.8 + mainT * 0.5, 0.8 + mainT * 0.5, Math.max(0.0001, mainT));
    this.bThrR.scale.copy(this.bThrL.scale);
    const bootT = (heat * 0.7 + air * 0.45 + dash * 0.5) * flick;
    this.bBootL.scale.set(0.9, 0.9, Math.max(0.0001, bootT));
    this.bBootR.scale.copy(this.bBootL.scale);

    const fl = Math.max(0.0001, this.flash * (0.9 + Math.sin(time * 90) * 0.1));
    this.bFlash.scale.set(fl, fl, fl);

    const pulse = 1 + this.chargeAmt * 0.35 + Math.sin(time * 6) * 0.03 + Math.sin(time * 30) * this.chargeAmt * 0.12;
    this.bCore.scale.setScalar(pulse);
    this._rot(this.bPod, -this.podOpen * 0.9, 0, 0, 14, dt);
    this._rot(this.bPack, -pitch * 0.06 + air * 0.10, 0, 0, bodyK, dt);

    // --- shader uniforms -----------------------------------------------------
    const hit = clamp01(robo.hurtFlash / 10);
    const invuln = robo.invuln > 0 ? (0.5 + 0.5 * Math.sin(time * 26)) : 0;

    // The idle floor on these two is the whole of defect #5. Whatever the
    // constructor asks for, this loop runs every frame and it used to reinstate
    // rim 0.5 / energy 0.22 on every surface — a permanent fresnel wash that no
    // amount of albedo work can out-shout. They are event tells now: at rest
    // they are barely there, and they only come up when the robot is doing
    // something the player has to notice.
    for (let i = 0; i < this.shellMats.length; i++) {
      const u = this.shellMats[i].userData.u;
      if (!u) continue;
      u.uTime.value = time;
      u.uHitFlash.value = hit * hit * 0.85;
      u.uCharge.value = this.chargeAmt * (robo.chargeReady ? 1 : 0.55);
      u.uEnergy.value = 0.03 + heat * 0.10 + invuln * 0.22;
      // The 0.10 idle floor here was the mitigation for defect #5 back when the
      // rim was pow(fres, k) — a ramp that covered half of every plate, so the
      // only way to stop it reading as tinted glass was to turn it almost off.
      // The rim is a narrow edge-biased smoothstep band now, which is a contour
      // and not a wash, so it can carry real strength: that is the whole point
      // of having changed its shape. Leaving it at 0.10 kept the fix for #5 and
      // threw away what the fix was FOR, which is the outline in #24.
      u.uRimStrength.value = 0.58 + invuln * 0.45 + hit * 0.5;
    }
    this.matFlare.opacity = clamp01(0.18 + heat * 0.55);

    // --- contact shadow ------------------------------------------------------
    // Stays welded to the ground plane while the group rides the robot, spreads
    // and fades with altitude, and shrinks to nothing on the frame the machine
    // is knocked down and its mass is no longer over its feet.
    if (this.shadow) {
      const alt = Math.max(0, robo.pos.y);
      const fade = 1 / (1 + alt * 0.55);
      this.shadow.position.y = 0.016 - robo.pos.y;
      this.shadow.scale.setScalar(this.shadowRadius * (1 + alt * 0.10) * (1 - dwn * 0.15));
      this.shadow.material.opacity = 0.72 * fade * (1 - dwn * 0.25);
      this.shadow.visible = alt < 7;
    }

    // Dead robos settle instead of standing at attention.
    if (isDead) this.group.position.y -= 0.02;
  }

  // -------------------------------------------------------------------------

  onFire(kind) {
    if (kind === 'gunCharged') {
      this.recoil = 1.0; this.flash = 1.0; this.spinRate = Math.max(this.spinRate, 34);
    } else if (kind === 'gun') {
      this.recoil = Math.max(this.recoil, 0.5); this.flash = 0.62;
      this.spinRate = Math.max(this.spinRate, 22);
    } else if (kind === 'bomb') {
      this.recoilB = 1;
    } else if (kind === 'pod') {
      this.podOpen = 1;
    }
  }

  muzzleWorld(out) {
    this.bMuzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.bMuzzle.matrixWorld);
  }

  setQuality(settings) {
    const wasLow = this.low;
    this.settings = settings;
    if (this._low !== wasLow) {
      this._teardown();
      this._build();
      return;
    }
    const shadows = !!settings.shadows;
    for (const m of this.meshes) {
      if (m.material === this.matEmis || m.material === this.matFlare) continue;
      // The contour is a drawing on top of the machine, not part of it: casting
      // from the expanded hull would fatten every shadow the robot throws.
      if (m.material === this.matOutline) continue;
      m.castShadow = shadows;
      m.receiveShadow = shadows;
    }
    for (const mat of this.shellMats) {
      for (const k of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap']) {
        if (mat[k]) mat[k].anisotropy = settings.anisotropy;
      }
    }
  }

  dispose() {
    this._teardown();
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// RoboPreview — the garage hero. Same rig, same shaders, a calmer brain.
// ---------------------------------------------------------------------------

export class RoboPreview {
  constructor(loadout, teamColor, settings, envMap = null) {
    this.teamColor = teamColor;
    this.settings = settings;
    this.envMap = envMap;
    this.group = new THREE.Group();
    this.t = 0;
    this._makePad();
    this._make(loadout);
  }

  /**
   * The hero stands on a service pad, not in a void (defect #15).
   *
   * It is one circle and one draw call, and it buys three separate things: a
   * surface for the key light's shadow to land on, a mid value for the dark
   * frame and near-black recesses to read against, and a floor line that tells
   * you how big the machine is. The pad is deliberately larger than the model's
   * footprint so the shadow has somewhere to fall as the robot shifts weight.
   */
  _makePad() {
    const { map } = padTextures();
    const pad = new THREE.Mesh(
      // 1.4m across for a 1.62m machine: wide enough to catch the shadow and
      // read as a place to stand, small enough to sit inside the garage's
      // preview slot instead of running out under the panels and off the
      // bottom of the frame, which is where a 3.2m pad ended up.
      new THREE.CircleGeometry(0.7, 64),
      new THREE.MeshStandardMaterial({
        map,
        transparent: true,
        roughness: 0.72,
        metalness: 0.08,
        envMapIntensity: 0.35,
        envMap: this.envMap,
        // The pad's whole job is to be a mid value the dark machine reads
        // against, and the menu's key light is aimed at the robot, not at the
        // floor 40cm below it. A self-lit floor guarantees the value: the
        // emissive channel carries the deck at half strength and the lights
        // shape what is left, so the pad cannot go black no matter what the
        // menu rig or the grade does above it.
        emissive: 0xffffff,
        emissiveMap: map,
        emissiveIntensity: 0.35,
        depthWrite: false,
        dithering: true,
      })
    );
    pad.rotation.x = -Math.PI / 2;
    // Above the menu's own pedestal cap, below its accent ring.
    pad.position.y = 0.002;
    pad.receiveShadow = true;
    pad.renderOrder = -2;
    this.pad = pad;
    this.group.add(pad);
  }

  _make(loadout) {
    this.loadout = loadout;
    this.model = new RoboModel(loadout, this.teamColor, this.settings, this.envMap);
    this.model.preview = true;
    this._lightForMenu();
    this.group.add(this.model.group);
  }

  /**
   * Re-light the shell for a room that does not exist (defect #5, residual).
   *
   * The same machine, the same materials, the same emissive strips: measured on
   * the pinned frames it comes out at body mean 87 in the arena and MEDIAN 32 in
   * the garage, with most of the model's area between 8 and 40. The trim strips
   * are MeshBasicMaterial with toneMapped off, so they are identical in both
   * places — which means they sit under the plates they bound in the arena and
   * over them here. That asymmetry is the whole of the residual complaint, and
   * it is why the answer is to bring the plates up rather than the lines down.
   *
   * The plates are down because the menu has no arena. In a match the machine
   * stands on a near-white deck between lit walls and every downward and
   * away-facing plate is carried by bounce; on the title screen it stands on a
   * 1.4 m pad in a black void, so the key is the only light in the frame and
   * everything it does not touch receives nothing at all.
   *
   * The shell's bounce card is exactly the stand-in for a missing room: it is
   * added to the INDIRECT diffuse and multiplied by the albedo, so the panel
   * bake, the vertex paint and the AO all survive it and no value relationship
   * the paint established is disturbed — the whole ladder just moves up. Up and
   * down stay different colours and stay far apart so the machine keeps a top
   * and a bottom; this is a bigger room, not an ambient wash.
   *
   * Scoped to RoboPreview on purpose. Setting these numbers on RoboModel would
   * double-light the arena machines, which already read.
   */
  _lightForMenu() {
    const u = this.model.matShell?.userData?.u;
    if (u) {
      // setRGB and not setHex, deliberately: a hex is capped at 1.0 per channel
      // and 1.0 is not enough. Swept live against the title frame, the shell's
      // response to this card is strongly sublinear — ACES is already
      // compressing the lit faces — so the arena's 0x74889f (0.18 linear) buys
      // the plates about four levels here. It takes an order of magnitude more
      // to move the machine's body from a median of 37 to 60, and there is
      // nothing unphysical about that number: it is the irradiance of a room,
      // and the arena gets the same amount from its deck and walls for free.
      u.uFillUp.value.setRGB(1.70, 1.90, 2.20);
      u.uFillDown.value.setRGB(0.55, 0.45, 0.52);
      // The DARK kicker comes down as the base goes up. It exists to rescue a
      // machine standing where no light reaches; stacked on top of a card this
      // size it would close the gap between the shadow side and the lit side
      // and the model would lose its form. Measured, the torso's lower quartile
      // stays at 20 while its median goes to 60 — the recesses stay recesses.
      u.uFillDark.value = 0.70;
    }
    // The garage's environment is a small dark studio probe, so the shell can
    // afford more of it than it can under an arena sky. Still well under 1:
    // armour is dielectric here (see armorTexture) and a hot env on a dielectric
    // is a haze over the paint, not a highlight on it.
    this.model.matShell.envMapIntensity = 0.9;
    // The frame is the model's line art and stays near-black by design, but at
    // 0.55 in a room with no light in it the joints between plates go to a flat
    // 4/255 and the line art stops being a line and becomes a hole.
    if (this.model.matFrame) this.model.matFrame.envMapIntensity = 0.95;
  }

  setLoadout(loadout) {
    this.model.dispose();
    this.group.remove(this.model.group);
    this._make(loadout);
  }

  /**
   * Keep the machine's feet on the menu's floor plane.
   *
   * The garage frames the hero by sliding this whole group around to line it up
   * with the layout's preview slot — currently about 0.4 m down. The menu's
   * floor furniture (pedestal, rim ring, backdrop grid) does not move with it,
   * so the machine ends up standing 0.4 m BELOW the plinth it is supposed to be
   * standing on: the pedestal's opaque top face then cuts the model off at the
   * knees, and the service pad and contact shadow are buried underneath it.
   * That is what defect #15 looks like in the current build — not a robot
   * floating over a void but a robot sunk into one.
   *
   * Cancelling only the downward part of the framing offset puts the feet, the
   * pad and the shadow back on y = 0 and leaves the horizontal framing alone.
   */
  _floorLift() {
    const y = this.group.position.y;
    return y < 0 ? -y : 0;
  }

  update(dt, time) {
    this.t += dt;
    const s = _previewState;
    // A slow weight shift plus a wandering gaze reads as "idling", not "frozen".
    s.aimYaw = Math.sin(this.t * 0.32) * 0.22;
    s.aimPitch = Math.sin(this.t * 0.23 + 1.1) * 0.10 - 0.04;
    s.yaw = s.aimYaw * 0.45;
    // Barely idling. A parked machine venting hard wraps itself in additive
    // plume every frame of the garage, which is the single cheapest way to make
    // painted metal look like a hologram again.
    s.boostHeat = 0.02 + Math.max(0, Math.sin(this.t * 0.55)) * 0.05;
    s.stepPhase = 0;
    this.model.update(s, dt, time);

    // After update(), because RoboModel.update() writes group.position from the
    // sim state every frame. Applied here rather than through _previewState.pos
    // so the contact shadow still sees altitude 0 and stays a contact shadow.
    const lift = this._floorLift();
    this.model.group.position.y += lift;
    if (this.pad) this.pad.position.y = lift + 0.002;
  }

  setQuality(settings) {
    this.settings = settings;
    this.model.setQuality(settings);
  }

  dispose() {
    this.model.dispose();
    if (this.pad) {
      this.pad.geometry.dispose();
      this.pad.material.dispose();
      this.pad = null;
    }
    this.group.clear();
  }
}
