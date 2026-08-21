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

## Round 4 (`35d0e66`) — the harness is finally repeatable

`a2ea5e8` landed the `onRender`/`quality.auto` detach in `contour.mjs`. **Verified, and it is the
single most important commit of this round**, because until now no #24 number in this project's
history could be compared to any other #24 number. Two unmodified `contour.mjs` runs at `35d0e66`,
same seed, minutes apart, one under load:

```
                      robot px   R1 box            OVERALL invisible / clean   R1 inv / clean   R2 inv / clean
  run 1                 23725    161x261 @723,638        8.9% / 57.0%          8.3% / 60.0%     11.1% / 47.0%
  run 2                 23717    161x261 @723,638        9.3% / 57.3%          8.7% / 60.3%     11.1% / 47.4%
```

Worst spread on any figure: **0.4 points**, against the **7 points** the round-3 critic documented
at `10621f2`. Bounding boxes are pixel-identical. Sim state identical (`tick=420 p1=-1.93,8.02
p2=9.52,-1.77`). The error bar is now an order of magnitude smaller than a round's improvement,
which means #24 can be tracked for the first time. Nothing in this review is inherited; every
figure below was re-measured at `35d0e66`.

One correction to the numbers the round handed me: the builder's claim of **R2 14.2% invisible** does
not reproduce — I get **11.1% on both runs**. The real figure is better than the one claimed, so
this is noted rather than held against anyone; it most likely predates the stage-warmth commits
that changed what R2 stands in front of.

### `measure.mjs` is still load-dependent — the bug `10621f2` claimed to close

`contour.mjs` is fixed. `measure.mjs` is not. Two successful runs at `35d0e66`, same seed, same
arena, minutes apart, differ like this on capture A (as shipped):

```
                        p50    below10pct   warmPct   coolPct   inBand20_55
  run 1 (box loaded)    3.9      86.0%       1.4%     10.2%       6.0%
  run 2 (box idle)     63.3      18.6%       9.9%     39.8%      52.8%
```

**A 67-point spread on `below10pct`.** Run 1 ran last in a chain of five capture jobs; run 2 ran
first on an idle box. The saved frame from run 2 is correct — I checked it independently with my
own histogram (`hist5.mjs`) and got p50 57.2 against measure's 63.3, the difference being the DOM
layer. Run 1's frame is a near-black one, i.e. a partially-initialised stage: `stage build ms`
reports **1166ms** of texture and light construction, and `boot()` waits 400ms then 1000ms before
capturing. Under load that is not enough. This is the same class of bug the round-3 critic found in
`contour.mjs`, in the tool `10621f2`'s commit message says it fixed.

**Consequence, and it is not small: every arena-warmth number any stage agent has tuned against
could have come from either column.** Do not tune against `measure.mjs` until it waits on a real
readiness signal instead of a fixed timeout. Everything below uses run 2 plus my own independent
histograms of the frames measure itself saved.

*I nearly published the opposite finding.* My first read was of a `meas-fight.png` left in the
worktree by an earlier session, which showed a different camera and a white deck; it was a stale
file, not a broken tool. Recording it because the next reviewer will hit the same trap: **these
tools overwrite fixed filenames, and `ls --time-style=+%H:%M` hides the date.**

*Captures this round:* `contour-n.png` / `contour-mask.png` (contour meter, `--keep`),
`c5-*.png` (screenshot.mjs at `--base http://127.0.0.1:4220/custom_robot/`), plus 1:1 and
magnified crops. **Harness note for the next builder:** `screenshot.mjs` defaults `--base` to
`http://127.0.0.1:4173/custom_robot/` while `contour.mjs` defaults to `http://127.0.0.1:4241/`
with no base path, and `vite preview` serves under `/custom_robot/`. Three tools, three different
default URLs, two of which are wrong for a local preview. Every reviewer loses a capture cycle to
this. One shared default would fix it.

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

### Arena warmth — the stage got warm; the frame did not, and the VFX are why

The round handed me a specific question: warmPct was 6.0% against 41.4% cool, a stage agent has
been warming the shell, does it now read as a deliberate cool rather than a blue tint over
everything? Re-measured at `35d0e66` on the good run, and cross-checked with my own histogram:

```
                                             warmPct   coolPct   inBand20_55   below10
  round 2, stage's own values                  6.0%     41.4%       32.1%       41.3%
  round 4, stage's own values (measure C)     25.5%      7.9%       45.2%       32.2%
  round 4, same, my own histogram             64.4%      7.8%       44.9%          —
  round 4, AS SHIPPED (measure A)              9.9%     39.8%       52.8%       18.6%
  round 4, as shipped, my own histogram       16.9%     56.2%       28.0%          —
```

**The stage-warmth work is real and it landed.** Warm and cool have swapped places in the shell:
6.0/41.4 has become 25.5/7.9. By eye on `contour-n.png` it is unmistakable — warm brown louvred
wall panels, a hot lit entry gate at frame left, warm crowd lights in the stands, played against
cyan deck rails and blue block trim. That is a deliberate warm/cool scheme, not a tint. Credit.

**But the frame the player sees is still cool-dominant, and the stage is no longer the cause.**
Measure's own two saved frames from a single run, differing only in whether VFX are drawn, put it
beyond argument — I ran my histogram over both:

```
  meas-fight-bare.png  (VFX off)   warm 38.9%   cool 25.6%
  meas-fight.png       (VFX on)    warm 16.9%   cool 56.2%
```

Same 3D frame, same camera, same tick. Turning the effects on **more than halves the warm coverage
and more than doubles the cool.** Measure's internal A-vs-C comparison agrees (25.5/7.9 becomes
9.9/39.8). So the "blue tint over everything" the last three rounds have been chasing is still
being applied — it has simply moved from the stage to the effects layer. Whatever is doing it
(a full-screen additive pass on the cyan tracers is the obvious suspect; `.hud__scan` is a
full-viewport `overlay`-blended layer at opacity 1 and worth ruling out too) is repainting an arena
somebody has spent three rounds warming.

**Verdict on arena warmth: FIXED at the stage, NOT FIXED at the frame.** Fix it in the VFX layer,
and do not let anyone warm the shell any further to compensate — the shell is correct now.

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

**1. Robots too small to find in the frame.** — **ROUND 4 (`35d0e66`): FIXED for the player.
NOT FIXED for the opponent, but DOWNGRADED off the blocker list.**

*My round-2 premise was wrong and I am correcting it against myself.* I reported the player at
109x209px "squarely inside CRV2's band". That mask was clipped by the bottom edge, so the number
was measured on a fraction of a machine. **Re-checked directly this round:** `maskrows.mjs` walks
`contour-mask.png` row by row and the stencil tapers to nothing — 62, 61, 60, 58, 55, 49, 28, 24,
7, 0 — terminating at **y=898 with row 899 empty**. The mask is *not* clipped. The player is
**161x261px = 29% of frame height**, honestly measured, and that is above CRV2's 15-25% band rather
than inside it. The size claim stands; my round-2 composition claim was built on a broken number
and is withdrawn.

**But one empty pixel of bottom margin is not framing, it is grazing.** The player's feet end 1px
from the bottom of the screen. You cannot see the ground the machine is standing on, which is why
its contact shadow is invisible (#14) and why the frame reads as if the player is falling out of
it. CRV2 always shows deck under the player. This is now the composition defect, not the size.

**The opponent: 42x79px = 8.8% of frame height** (up from 7.3%). Still under the rig's own 12%
floor.

**Assessing `9c8a4a0`'s claim that the floor is geometrically unreachable — I reject the premise
and accept the conclusion.**

The commit says: "at a 15m duel separation a 1.62m machine CANNOT be put above 12% of frame height
at the same time as the player by repositioning alone. The geometry does not allow it. The only
remaining lever is a much narrower FOV." Working it: the engine camera is **56° vertical**
(`src/core/engine.js:40`). An object of height *h* subtends 12% of frame height at
`d = h / (0.12 · 2 · tan 28°) = 1.62 / 0.1276 = 12.7m`. Measured separation on the pinned frame is
`|p1-p2| = 15.07m`. A camera on the duel **axis** has the two machines at `d±7.5m`, so no anchor
slide can bring the far one inside 12.7m — that much is right. But a camera **perpendicular** to
the duel axis, 10m out from the midpoint, has *both* machines at `sqrt(10² + 7.5²) = 12.5m` — both
inside 12.7m, both at 12%, with 2m of slack. **The lever the commit says does not exist is yaw, not
FOV.** The rig forecloses it on line 6 of `camera.js`: "anchors behind the local robo so movement
input stays intuitive." That is a design choice, and a defensible one, but it is not geometry.

I accept the **conclusion** anyway, for a reason the commit did not give: the perpendicular camera
costs the over-the-shoulder aim read in a game that aims, and it would drop the player from 29% to
12% — a different game, not a better frame. And the commit's closing prediction has now come true.
It said "a 55x78px opponent with a hard contour is perfectly readable; without one it is a smudge
at any size." The contour landed. At 42x79 the opponent measures separation **40.5** and 47% clean
contour, and at 1:1 (`c5-opp-1x.png`) you can read head, shoulders, arms, legs and which way it is
facing. It is small. It is not a smudge.

**Residual, and it is honest:** you can read *what* the opponent is; you cannot read *what it is
doing*. In a fighter where you dodge on the opponent's animation, 79px of machine is marginal. So
this is not FIXED — but it is no longer the thing standing between this build and the bar, and no
further rounds should be spent on the rig. **Off the blocker list.**

*Superseded round-2 entry:*
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

**14. Nothing casts a readable shadow.** — **ROUND 4 (`35d0e66`): PARTLY FIXED. Robots cast;
obstacles still do not; the player's own shadow is unviewable for a composition reason.**

`514051f` is real — the shadow path works now. Proof by eye: at 8x on `contour-n.png` around
(590-710, 365-415) there is a **sharp, correctly-shaped cast shadow** of the opponent machine on
the deck — you can make out a torso, two out-flung arms and a leg, projected down-left, consistent
with the key's direction. That is a shadow map doing its job, not a blob.

Two things are still wrong, and one of them is not a shadow bug at all:

**(a) The obstacle blocks cast nothing.** `c5-shadow1.png` (3x on the left crate) and
`c5-shadow3.png` (2x on the tall crate's base) show a metre-tall box sitting on a lit deck with no
shadow on any side. Probed: deck at the crate base reads **87.3**, deck on the same plate 240px
away reads **93.2** — a 6-point falloff, not a shadow. The code looks correct
(`stage.js:702-703` sets `castShadow` on the merged obstacle Mesh, `stage.js:1093` again in
`setQuality`, and the key's ortho frustum at `stage.js:835-838` is sized to the whole arena), so
this is worth ten minutes of a builder's time rather than a rewrite — check that the merged
`obstacles` mesh is inside `key.shadow.camera`'s **depth** range (`near = 1`, `far = 90`) once the
light has been re-positioned to `focus + sunDir*30` each frame at `stage.js:1075`, and that
`shadow.radius = 2.2` is not simply washing a short shadow out. **What makes the miss obvious is
that each block carries a bright orange emissive under-trim at deck level — so every block
*brightens* its own contact point.** The one place in the frame that should be darkest is lit.

**(b) The player's contact shadow cannot be seen, and the cause is #1, not #14.** Probed either
side of the player's feet on `contour-n.png`: deck 30px left of the foot reads **96.2**, deck 400px
away reads **97.3**. No pool, no darkening. But the feet end at y=898 of a 900px frame — there is
one pixel of deck below the machine to draw a shadow on, and the key throws down-left, i.e. off the
bottom of the screen. Fixing the framing (see #1) will expose whatever is already being cast; do
that before touching the shadow code for the player.

*Superseded round-2 entry:*
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

**16. Right HUD plate flush to screen edge; left plate is not.** — **ROUND 4 (`35d0e66`): FIXED.**
Measured rather than eyeballed. `rule.mjs` scans `c5-fight.png` for the coloured top rule on each
plate and reports:

```
  blue rule   y=14-15   x20..412     392px long   left margin 20px
  red  rule   y=14-15   x1188..1579  392px long   right margin 21px
```

Same y, same length to the pixel, margins 20 vs 21 on a 1600px frame — a one-pixel difference that
is odd-width rounding, not a design error. The round-2 complaint (red hairline at y≈3 bleeding to
x=1600 against blue at y≈10 stopping at 415) is completely gone, and with it the "stray magenta
hairline". The plates mirror.

*Residual, cosmetic, do not spend a round on it:* the P1 and P2 corner badges are **identical
rather than mirrored** — both cut the top-right corner large and the bottom-left corner small
(`c5-badgeL.png`, `c5-badgeR.png` at 6x). Everything else on the two plates mirrors properly,
including the diagonal cut on the depleting end of each HP bar, so the badges are the one element
that repeats instead of reflecting. The round's stated defect — 16px corners against 8px — is
fixed; the cuts are now the same size on both.

*Superseded round-2 entry:*
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

**22. Crosshair is invisible.** — **ROUND 4 (`35d0e66`): REGRESSED. There is no crosshair at all.**
Round 2 verified a white-cored reticle with an orange ring and four ticks at (800,450). At
`35d0e66` it is gone. I looked for it rather than assuming: `c5-ret.png` is a 4x crop of
(720-880, 370-530), i.e. ±80px around dead centre — empty. `c5-ret-wide.png` widens that to a 2x
crop of (560-1050, 250-650), 480x400 of frame centre — **no reticle anywhere in it.** Same
`fight` scenario, same `setDemo(true)`, same seed as the round-2 capture that had one.

For contrast, a `meas-fight.png` left in the worktree by an earlier session, from an older commit,
*does* show the reticle at exactly (800,450) under the same setup — so this is a regression between
that commit and this one, not a scenario artefact.

**An arena shooter with no crosshair is not shippable**, and this is the kind of defect that gets
marked FIXED once and then never re-checked. Whoever touched the HUD layer between rounds should
diff it. *Severity: promoted to MAJOR.*

*Superseded round-2 entry:*

**23. Top HUD scrim has a hard banding edge.** — **FIXED.**
`f-hud.png`: the full-width darkening gradient is gone; each plate carries its own dark backing
box. No horizontal seam at y≈100 or anywhere else.

**24. The robot silhouette is mushy.** — **ROUND 4 (`35d0e66`): FIXED.** Judged by eye at 1:1 and
2x on `contour-n.png`, and confirmed by two repeatable meter runs.

```
OVERALL   invisible (<12)  8.9%   weak (<25) 26.7%   clean (>=40) 57.0%   median step 48.1
ROBOT 1 (161x261px)  invisible  8.3%   weak 23.9%   clean 60.0%   median 53.6
ROBOT 2  (42x79px)   invisible 11.1%   weak 35.9%   clean 47.0%   median 37.8
```

The tool's own rule of thumb is "most of the contour above 25, very little below 12". Both machines
now meet it: 73% and 64% of contour above 25, 8.3% and 11.1% below 12. Against round 2's 72.1%
invisible / 4.1% clean this is not an incremental move, it is a different frame.

**The eye agrees with the meter, which is the part that matters.** In `c5-cn-r1.png` (2x on the
player) there is a continuous dark contour band running the whole perimeter — over the shoulder
blocks, down both arm housings, around the leg silhouette, around the head and antenna. It does not
break where the machine crosses a light deck plate. That is what the previous five rounds of rim
tuning never produced, and the diagnosis behind it was right: `fres` measured against hard face
normals fired the band only on geometry facing away from camera, so every rim tweak was tuning an
invisible effect. Welding the normals is the fix.

**Credit where it is due, and a warning.** The round-2 note listed three options and said "(c) ship
an actual outline pass is the one that matches the reference and fixes both robots at once". That
is what shipped, and it worked on both machines at once exactly as predicted. The warning: **the
outline is now carrying the entire silhouette on its own.** The meter's own body-vs-background
figures say so — ROBOT 1's body reads **84.5** against a background of **96**. The robot is still
*darker than the deck it stands on*; the contour is a dark line drawn around a shape that has no
value difference from its surroundings. That is a legitimate technique and it passes this defect.
It is not the same thing as fixing the casting problem, and the casting problem is what loses the
blind test. See N6.

*Superseded round-2 measurement, kept for the record:*

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

**N6. The value and detail hierarchy is inverted — the stage out-reads the machines.**
*New at round 4, and it is the finding of this review.* Every individual defect on the list above
is now fixed or close to it, and the frame still loses the blind test, because the thing that was
never on the list is the relationship between the subjects and the set. Measured on `c5-fight.png`
and `contour-n.png`:

- **Brightness.** ROBOT 1's body reads **84.5**; the deck immediately behind it reads **96**. The
  player character is darker than the floor. The brightest, most saturated, longest-line objects in
  the frame are the **cyan deck rails**, which clip near 255 and run right through the composition.
  The hazard chevrons are second. The machines are third and fourth.
- **Detail.** At true 1:1 (`c5-r1-1x.png`) the player's torso is a mosaic of eight or nine small
  blue and orange rectangles and the shoulders read as two pale blocks — there is no four-or-five-
  mass read. The louvred wall panels, the crate faces and the deck plating all carry more legible
  texture per square inch than either machine.
- **Consequence.** The eye lands on the floor. #24's outline pass is what stops the machines
  disappearing entirely, and it is doing that job alone.

This is one art decision, not a defect list: **the machines must become the lightest, most
saturated, simplest-massed objects on screen, and the deck must give up the top of the value range
to them.** Concretely — bring the plate values up until the body sits above the deck rather than
below it, drop the cyan rails out of the clipping range, and reduce the number of distinct panel
tones per machine. #5's residual (emissive edge lines at 120-180 bounding plates at 15-40) is the
same problem seen from the inside and should be fixed in the same pass.
*Severity: BLOCKING, and it is the only thing left on that list.*

**N7. Ordnance renders as untextured primitives.** `c5-oct.png` (6x) and `c5-ret-wide.png` (2x):
the projectiles/pods are bare flat-shaded **octahedra** in green and cyan, hard facets visible, no
texture, no trail, no glow. They appear in every fight frame — three of them in `c5-fight.png`
alone. Against crates that carry panel lines, rivets, wear and an emissive trim, these are the
least-finished objects in the game and they read as placeholder geometry that was never replaced.
*Severity: MAJOR. Cheap to fix and highly visible.*

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
