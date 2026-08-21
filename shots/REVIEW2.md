# HOLOSSEUM — Art Direction Gate Review

Rolling document. Round 2 reviewed `10621f2`; **round 4 (this pass) reviews `35d0e66`** and
re-verifies every entry a builder has touched since. Entries still carrying a round-2 verdict were
checked against `10621f2` and are not re-litigated unless the code under them moved.

**STATUS: COMPLETE at `35d0e66`.** All sections filled, including the blind comparison and the
verdict, both of which had been PENDING through three rounds.

**VERDICT: NO — but for the first time the reason is a single, named, tractable problem rather than
a list. See the bottom of this file.**

*Correction to the round-2 header: it read "STATUS: COMPLETE / VERDICT: NO" while the verdict
section at the bottom of the same file read PENDING. The header was aspirational. It has been
rewritten to match what the document actually contains.*

---

## How this round was captured

### The `a1fdf34` capture problem, and what `10621f2` actually fixed

The previous pass could not use `tools/screenshot.mjs` at all: its `fight` scenario started an
unseeded match, so two runs were two different fights. `10621f2` closed that — fixed seed, engine
paused before the tick loop, `clock.elapsed` stepped in lockstep with the sim, `onRender` detached
after settling, auto-quality pinned. **Independently verified here:** two `screenshot.mjs --shots
fight --tier 3` runs back to back differ on **0.41%** of pixels (`m1-fight.png` vs `m2-fight.png`,
`tools/pxdiff.mjs`, threshold 8). That is good enough to review from, and `cap2.mjs` is retired.

Residual, minor: `capture()` still does `await page.waitForTimeout(settle * 1000)` *before* the
tick loop sets `engine.paused = true`, so the engine free-runs for one second of wall clock first.
Under software GL that is only one to three sim ticks (the fixed-step accumulator clamps a long
frame to a single tick), which is why the diff is 0.41% and not 40% — but it is 0.41% at a max
channel delta of **124**, i.e. a handful of pixels are completely different, not slightly. Moving
`paused = true` onto the `startMatch` line, the way `contour.mjs` already does it, would take it
to zero.

### The fix did not reach `contour.mjs`, which is the tool that measures the #1 blocker

`10621f2` patched `screenshot.mjs` and `measure.mjs`. It did not patch `contour.mjs`. That tool
freezes the sim on the `startMatch` line and hand-settles the rig on a fixed 1/60 delta — and then
never detaches `engine.onRender`. `paused` gates only the fixed step; `main.js:112` still calls
`_render(dt, alpha, time)` on every rendered frame with the real wall-clock delta, and `_render`
damps the camera rig and the grade. Between the settle and the shutter there are two 700 ms waits
and a multi-second software-GL screenshot, so the rig keeps sliding by an amount that depends on
how loaded the box is.

Measured, two runs of unmodified `contour.mjs` at `10621f2`, same seed, minutes apart:

```
                      robot px   ROBOT 1 size   R1 invisible   OVERALL clean
  run 1 (light load)    12962     104x206         59.8%           11.8%
  run 2 (heavy load)    13497     109x209         66.7%            6.9%
```

Identical sim state printed by both (`tick=420 p1=-1.93,8.02 p2=9.52,-1.77`). Same seed, same
commit, same code — **a 7-point spread on the headline number and a 5-point spread on "clean"**,
which is wider than any single round's improvement. Every #24 figure in this project's history,
including the previous critic's, carries that error bar.

Adding the two lines `screenshot.mjs` already has —

```js
window.__game.engine.onRender = null;
window.__game.engine.quality.auto = false;
```

— immediately after `SETTLE_FN` runs makes it repeatable. This review's #24 numbers are from that
patched tool (critic worktree only, uncommitted; the patch is four lines and carries the comment
explaining it). **A builder must land this before the next round or #24 cannot be tracked.**

Captures referenced: `m1-fight.png` / `m2-fight.png` (screenshot.mjs, tier 3, 1600x900),
`contour-n.png` / `contour-mask.png` (patched contour meter, VFX+DOM off), `p-touch-iphone12.png`,
`x-sheet-*.png` (vfxsheet), `z-*.png` (1:1 and magnified crops, `tools/crop.mjs`).

### The honest baseline is darker and bluer than the commit log claims

`#2` (flat haze) is still a genuine FIX — the frame has real blacks and real whites now. But the
numbers that were used to argue it were measured on frames lit by whatever effects happened to be
mid-flight, and they were inflated. The repeatable baseline for `grid` as shipped is:

```
  inBand20_55 32.1%   below10pct 41.3%   above90pct 0.2%
  DECK median 95.0    WALL median 27.2
  warmPct 6.0%   coolPct 41.4%   saturatedPct 47.8%
```

`below10pct` is **41.3%**, not the 27.6% previously claimed: two fifths of the frame is essentially
black. Warm coverage is **6%**, not 19%. The arena did not become well-lit, it became *contrasty* —
a small bright deck in a large black room. That is a different thing, and it is most of why the
opponent cannot be seen (#24, #1).

---

## Defect ledger

### BLOCKERS

**1. Robots too small to find in the frame.** — **FIXED for the local robot, UNCHANGED for the opponent.**
`contour.mjs` measures the mask directly: ROBOT 1 is **109x209px = 23.2% of frame height**. That
is squarely inside CRV2's 15-25% band and it is a real fix. ROBOT 2 is **47x66px = 7.3%**. The
opponent is still a speck. In a 1v1 game the number that matters is the *smaller* of the two, and
7.3% is less than a third of the local robot. The camera frames the player, not the fight.
*Note:* the rig needs a two-subject framing term — pull back and/or raise until both machines are
above ~12% of frame height, the way CRV2's arena camera did. Framing only the local robot is what
produces the current composition, where the fight happens bottom-centre-left and the right 40% of
the frame is empty deck.

**2. Flat haze, no blacks/whites, no contrast.** — **FIXED.**
`contour-n.png` (VFX and DOM off, so this is the stage's own values) has a genuine range: the
stands read 2-20, the deck 85-110, the cyan rim strips and hazard chevrons clip near 255. There
is true black in the wall band at y≈300-460 and true white on the deck edge highlights. The
uniform blue-grey milk of the previous round is gone. Confirmed by eye at 1:1 and consistent with
the arena rebuild in #12.

**3. Health bars do not communicate health.** — **FIXED.**
`f-hud.png` (1:1 crop of the top 110px of `d1-fight.png`). P1 at 950/1000 shows a solid blue fill
that stops at x≈385 with a hard black remainder to x≈405 — the filled/empty boundary is
unambiguous. ACE at 813/860 mirrors correctly, depleting from the left. The gradient-plus-hatching
mush is gone.
*Residual (new, minor):* P1's bar is blue and P2's is red at full health, so the two are not
comparable at a glance and a healthy opponent reads as "in danger". The Vulcan ammo bar directly
below (`f-gear.png`) is the *same* blue at the *same* weight as the P1 health bar — two different
quantities in identical visual language, 750px apart.

**4. `explosion.png` contains no explosion.** — PENDING

**5. The robots are translucent.** — **FIXED.**
Verified in code and in pixels. `src/gfx/materials.js:112+` builds the shell as an opaque
`MeshStandardMaterial` with an injected rim term; `src/gfx/robot.js:1765` sets
`rimStrength: 0.10, rimPower: 5.2`, i.e. a narrow band, and the strength did **not** creep back up.
At 3x (`t-torso.png`, `g-torso.png`) the chest wedges are painted panels — the background does not
bleed through any plate, and no rear structure is visible through a front one.
*Residual, and it is the same complaint by a different mechanism:* the emissive trim
(`matEmis`, `MeshBasicMaterial` + `toneMapped:false`) draws a bright cyan line along **every**
panel edge, and on the title/garage rig the plates themselves sit at value 15-40 while those lines
sit at 120-180. The machine is therefore a mesh of glowing wires around dark voids. A rim that
describes an edge is right; edge lines brighter than every surface they bound is the hologram
read again. Bring the plate values up (see #24) rather than the lines down.

**6. BOMB/POD cooldown widgets clipped off the bottom.** — **FIXED.**
`f-gear.png`: the VULCAN meter, BOMB/STANDARD and POD/STINGER ring gauges all sit fully inside the
frame with ~20px of bottom margin, labels and kana intact. These are now the best-designed
elements in the HUD.

**7. Shockwave rings read as solid grey donuts.** — PENDING (early read: still typographic — see notes)

**8. Damage flash blows out the opponent HUD plate.** — PENDING

**9. Brand mismatch on the title screen.** — **FIXED.**
`c3a-title.png`: wordmark is **HOLOSSEUM**, sub is ホロシアム, eyebrow is "CUSTOM MACHINE COMBAT
LEAGUE / 機甲競技連盟", corner mark is HLS·02. The product name is now the biggest type on the
screen and the CR·V2 clone-label is gone.

### MAJOR

**10. Beams and tracers have no core and no shape.** — PENDING

**11. Garage stat bars look broken.** — **FIXED.**
`c3a-garage.png` right panel: every bar now has a proportional fill on a dark track (ARMOUR ~95%,
SPEED ~92%, AIR CONTROL ~70%, MASS ~72%, POISE ~55%). The stack order is corrected — label and
numeral on one line, bar beneath. The unexplained "—" now sits under a "VS EQUIPPED" column header,
so it reads as "no change", which is what it always meant.

**12. The arena is a featureless box, not a built place.** — **FIXED.**
`contour-n.png`: raked stands with crowd lights running the full circumference, a black service
wall with louvre panels, a lit entry gate at frame left, an overhead gantry, hazard chevrons on the
deck, cyan rim strips defining the deck edge and every block. It is a built place with a scale
reference. This is the biggest single improvement in the build.

**13. Obstacle blocks are untextured greybox.** — **FIXED.**
Same frame: blocks now carry a panelled top face, a distinct darker side plane, a cyan emissive
rim along the top edge and an orange under-trim at deck level. The lit-top/dark-side discipline
that the robots still lack (#24) is present on the blocks.

**14. Nothing casts a readable shadow.** — **UNCHANGED.**
`contour-n.png` at 1:1: there is no contact shadow under ROBOT 1 at (755-865, 625-835), and no cast
shadow from any of the four obstacle blocks onto the deck, despite `shadows: true` and
`shadowMapSize: 2048` at tier 3. The only darkening is ambient occlusion at block/deck junctions.
The robot reads as a decal on the floor, which is also the reason its feet look like they are not
touching. `g-feet.png` shows the same in the garage — a `contactShadowMaterial` exists
(`robot.js:1562`, opacity 0.7) but nothing of it is visible under the model.
*Note:* find out whether the key light's shadow camera actually contains the play area, or whether
`castShadow` is set on the merged shell meshes at all. A blob shadow alone would recover most of
this, and it is the cheapest available fix for both #14 and #24's grounding problem.

**15. Title and garage robots float on a 1px ellipse in a void.** — **IMPROVED BUT NOT FIXED.**
There is now a real lit pad with a rim ring (`c3a-title.png`, `c3a-garage.png`). Three things stop
it landing: (a) no contact shadow, so the machine still does not touch — see #14; (b) the pad's
outer edge is a hard-edged ellipse against pure black, so it is a disc in a void rather than a
room; (c) **new collision** — in `g-feet.png` the BOMB/POD/LEGS loadout chips are drawn *over the
robot's shins*, at 2x you can see "STANDARD" sitting on the model's left leg.

**16. Right HUD plate flush to screen edge; left plate is not.** — **IMPROVED BUT NOT FIXED.**
`f-hud.png` at 1:1: the ACE plate's top rule is a red hairline at y≈3 that runs to x=1600 with zero
right margin, while P1's top rule is a blue hairline at y≈10 that stops at x≈415. Two plates that
should mirror each other differ in both their y position and whether they bleed. The "stray magenta
hairline" from the last round is that same red rule — it starts at x≈1190, far left of any plate
content, so it still reads as a stray line rather than a frame.

**17. Title screen bottom-left text block is a collision.** — **FIXED.**
"SEASON 02 · BUILD 1.0" now sits alone at (24, 860); the control hints moved to bottom-right. No
element is within 190px of the CONTROLS menu row.

**18. "SELECT ARENA" sub-label is illegible.** — **FIXED.**
`g-cta.png` at 3x: "SELECT ARENA" is near-black on orange (~8:1). The kana アリーナへ is a dark
brown on orange at roughly 3.5:1 — thin, but it resolves at 1:1 and clears the bar for decorative
sub-type.

**19. Garage left rail truncates labels that have room.** — **FIXED.**
Rows 03 and 05 now read "STANDARD" and "FEATHER-X" in full.

**20. Bottom-right debug/telemetry panel ships in every fight frame.** — **FIXED.**
`f-net.png` (2x of the bottom-right 500x120 of `d1-fight.png`) shows deck and nothing else. The
panel is gone from solo play.

**21. The accent colour is doing no work.** — **FIXED.**
`contour-n.png`: orange/yellow hazard chevrons on the deck, an orange under-trim on every obstacle
block, a warm lit gate at frame left, warm crowd lights in the stands, orange BOMB ring in the HUD.
There is a warm note in the 3D scene at three different scales.

**22. Crosshair is invisible.** — **FIXED.**
`d1-fight.png` at (800, 450): a white-cored reticle with an orange ring and four tick marks, with
its own dark outline so it survives over both the bright deck and the dark wall.

**23. Top HUD scrim has a hard banding edge.** — **FIXED.**
`f-hud.png`: the full-width darkening gradient is gone; each plate carries its own dark backing
box. No horizontal seam at y≈100 or anywhere else.

**24. The robot silhouette is mushy.** — **UNCHANGED. This is now the #1 blocker.**
`contour.mjs` on the pinned frame, robots at their real gameplay size:

```
OVERALL   invisible (<12) 72.1%   weak (<25) 89.9%   clean (>=40) 4.1%
ROBOT 1 (109x209px)  invisible 70.0%   body 76.2 vs background 85.5  (separation 9.3)
ROBOT 2 (47x66px)    invisible 78.0%   body  6.7 vs background  2.0  (separation 4.7)
```

Seven tenths of the local robot's outline has a value step under 12 — the outline is not there.
Ninety percent is under 25, which the tool's own rule of thumb calls "survives a still frame,
dissolves in motion". Only 4% reads cleanly.

The mechanism is visible at 1:1 in `contour-n.png` and it is not an edge problem, it is a
**casting** problem: a mid-blue robot is standing on a mid-blue deck (76 vs 86), and the magenta
robot is standing in front of a black wall at value 2 while itself sitting at value 7. Both
machines have been painted the value of the thing behind them. The three-tier panel-tone work from
last round widened the robot's *internal* range without ever asking what it would be seen against.
*Note:* this needs an art decision, not a shader tweak. Either (a) re-value the machines — CRV2 put
saturated, **light** toys on its floor and gave them a hard dark outline, and a light robot on this
deck would separate immediately; or (b) give the deck a much darker mid and keep the robots where
they are; or (c) ship an actual outline pass (inverted hull / depth-discontinuity) so the contour
has a step regardless of what is behind it. Option (c) is the one that matches the reference and
fixes both robots at once. What must stop is tuning the rim: the rim is already at the value where
it makes the machine look like a wireframe (#5) and it has bought 4% clean contour.

### MINOR

**25. Garage swatch row under RAY-01 description is unlabelled.** — **FIXED.** Now headed "LIVERY 塗装".

**26. "EQUIPPED CANDIDATE" legend with no swatches.** — **FIXED.** Both keys now carry swatches.

**27. P1/P2 tabs detached, no selected state.** — **FIXED.** Now 76x40, attached to the rail, P1
carries a filled blue selected state.

**28. Garage bottom bar sits on three different baselines.** — **FIXED.** BACK, the hover hint and
SELECT ARENA all centre on y≈855.

**29. "ROUND 1 / ラウンド" effectively invisible.** — **FIXED.** Now white on its own dark chip at
(735-865, 18-34).

**30. Title selected-row highlight has an unjustified hard cut.** — **FIXED.** The highlight now
fades out to the right instead of terminating on a hard vertical edge.

**31. Title hexagon mark is generic.** — **UNCHANGED.** Still a plain hexagon outline with a small
orange/white bar inside. It carries no read of "arena", "machine" or "holo". Lowest-value item on
this list; fine to leave.

**32. Soft circular flares read as lens dirt.** — PENDING

---

## New defects and regressions since REVIEW.md

**N1. `tools/screenshot.mjs` is still nondeterministic.** See the capture note at the top. This is
the tool every builder and reviewer reaches for first, and it is the one that did not get fixed.
Passing a fixed `seed` and setting `engine.paused = true` on the `startMatch` line — the same three
lines already in `contour.mjs` — would close it.
*Severity: BLOCKING for the review process itself.*

**N2. Garage loadout chips overlap the model.** `g-feet.png`: the BOMB / POD / LEGS chips are drawn
across the robot's shins. New since the pad landed.

**N3. The two HP bars are not comparable.** See #3 residual — P1 blue, P2 red at identical health
fractions.

**N4. The ammo bar and the health bar are the same widget.** See #3 residual.

**N5. Rendered frames are not reproducible even with a pinned seed and a frozen sim.** 26.1% of
pixels differ by >8 levels between two runs at an identical sim state, because the effect clock
advances on wall time during the settle window. `vfxsheet.mjs` solves this for effects; the fight
capture path does not use it.

---

## Ranked top-5 blocking the blind side-by-side bar

1. **#24 — the silhouette.** 72% of contour invisible; both machines painted their background's
   value. Nothing else on this list matters as much.
2. **#1 (opponent half) — the opponent is 7.3% of frame height.** You cannot see who you are
   fighting.
3. **#14 — nothing casts a shadow.** The robots are decals on a floor; this is also half of why
   #24 fails.
4. **VFX as a group — #4 explosion, #7 shockwaves, #10 tracers, #32 flares.** Ranked as one item
   because they fail as one: every effect in this build is a *soft, desaturated, additive smudge*,
   and the reference's effects are hard-edged saturated shapes with white cores. An arena fighter
   is 40% effects by screen time. Whatever the silhouette does, a frame with a grey donut in it
   loses the blind test on its own.
5. **#5's residual — the emissive trim is brighter than every surface it bounds.** `matEmis` is
   `MeshBasicMaterial` + `toneMapped:false`, so panel-edge lines sit at 120-180 while the plates
   they describe sit at 15-40 on the title/garage rig. The machine reads as a cage of glowing wires
   around dark voids. This is the same failure as item 1 seen from the inside: the *lines* are
   winning the value hierarchy instead of the *forms*. Fixing it is a prerequisite for the
   "saturated light toy" read, not a polish item after it.

*This ranking is superseded by the re-ranked list in the VERDICT section at the bottom, which is
written against `35d0e66` after re-verification. The list above is preserved as the round-2 view.*

---

## Blind comparison against a real CRV2 frame

**This is the acceptance criterion, so it is stated plainly: shown our frame and a real Custom Robo
V2 frame side by side and unlabelled, a person picks the CRV2 frame. We do not pass yet.**

### Method, and its one honest limitation

There is no CRV2 capture in this repository — `find` over the tree returns nothing, and the review
harness has no reference plate. The comparison below is therefore against the reference *as
described*, feature by feature, not against a pixel file. Every claim about our frame is measured
or read at 1:1 from `shots/fight.png` (1600x900, tier 3, captured at `35d0e66`) plus `c5-r1-1x.png`
(the player at true 1:1) and `c5-r2-4x.png` (the opponent at 4x). Every claim about CRV2 is a
structural one — where the subjects sit, what carries the contrast, what carries the detail — not a
claim about a specific screenshot, so it does not depend on which frame you pick.

**A builder should drop one real CRV2 frame into the repo.** Three rounds of reviews have argued
about a reference nobody can point at. It is the cheapest possible fix to this whole process.

### What a CRV2 frame does, structurally

1. **The two robots are the brightest, most saturated things on screen.** They are toys — flat-lit,
   near-primary reds, blues, yellows, whites — and they sit on a stage that is deliberately duller
   and darker than they are.
2. **The stage is quieter than the subjects.** The floor is patterned, but it is *low-contrast*
   patterning. Nothing on the floor clips to white. Nothing on the floor out-details a robot.
3. **Both machines are legible at once.** The camera frames the *pair*. You always know what your
   opponent is and roughly what it is doing.
4. **Very few, very large forms per machine.** A CRV2 robot reads as four or five chunky masses.
   You can describe its silhouette from memory after one frame.
5. **The effects are enormous, hard-edged and saturated** — fat coloured bolts with white cores,
   flat expanding rings, star bursts. They are drawn, not simulated.

### What our frame does

1. **Inverted.** Our player machine (`c5-r1-1x.png`) is dark navy and slate, values roughly 40-70,
   standing on a deck whose plates run 110-140 and whose cyan rim rails clip near 255. The single
   most saturated, brightest object in the frame is a *light rail on the floor*. The second is a
   hazard chevron. The machines are the third and fourth. Measured, not asserted: the contour meter
   reports ROBOT 1's body at 84.5 against a background of 96 — **the deck is brighter than the
   robot standing on it.**
2. **Inverted.** The louvred wall panels, the crate faces and the deck plating carry more legible
   texture per square inch than either machine does. Four brown crates occupy more of the eye's
   attention than the fight does.
3. **Failed.** ROBOT 2 is 42x79px, 8.8% of frame height. At 1:1 you can tell it is a robot and
   nothing else. `c5-r2-4x.png` had to be magnified 4x before its shape could be described at all.
4. **Failed.** At true 1:1 the player's torso is a mosaic of eight or nine small blue and orange
   rectangles; the shoulders read as two pale blocks. There is no four-or-five-mass read. This is
   the one place ours is objectively *more* detailed than the reference and objectively *worse* for
   it.
5. Deferred to the VFX entries (#4/#7/#10/#32) below.

### Where ours actually wins

It should be said, because it is the reason this project is close rather than hopeless. Our frame
has genuinely better craft than the reference in three places: the arena is a **built place** with
real architecture, scale reference and a light plan (#12, and it is very good); the HUD typography
and gauge design are better than any N64 HUD ever was (#6, #11, #22); and the material work on the
crates and deck is a level of finish CRV2 never attempted. If the machines were cast correctly,
this frame would beat the reference.

### The verdict of the blind test, in one sentence

A person shown both frames unlabelled picks CRV2, and picks it in under a second, because in the
CRV2 frame their eye lands on two robots and in ours it lands on a cyan floor rail — **we have
built an excellent stage and then painted the actors the colour of the scenery.**

---

## iPhone 12 playability, including touch

PENDING

---

## VERDICT

PENDING
