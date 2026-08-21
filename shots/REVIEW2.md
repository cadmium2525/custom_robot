# HOLOSSEUM — Art Direction Gate Review

Rolling document. Round 2 reviewed `10621f2`; round 4 reviewed `35d0e66`; **round 5 (this pass)
opened at `b28ff8c` and closes at `da3253a`**, and re-runs the blind comparison, which is the
acceptance criterion.

**STATUS: IN PROGRESS — the blind comparison is being re-scored at `da3253a`. The header will read
COMPLETE only when the VERDICT section at the bottom of this file says something other than
PENDING, and it is the section, not this line, that decides.**

**VERDICT: see the VERDICT section at the bottom of this file, which is the only place a verdict is
recorded. This header deliberately does not restate it — the last two rounds both shipped a header
that disagreed with the section, and the fix is to stop having two of them.**

---

## Round 5 (`b28ff8c`) — the recast, and what the meter is measuring

Round 4 failed this build for one named reason: *"in the CRV2 frame their eye lands on two robots
and in ours it lands on a cyan floor rail — we have built an excellent stage and then painted the
actors the colour of the scenery."* The measured form of that was **ROBOT 1's body at 84.5 against
a deck at 96** — the player character darker than the floor.

### The sign has flipped, and that is the headline

Reproduced rather than trusted. Two unmodified `contour.mjs` runs at `b28ff8c`, tier 3, seed
1234567, against the figures the round handed me:

```
                          claimed   my run 1   my run 2
  OVERALL invisible         4.7%      4.8%       4.6%
  OVERALL clean            71.1%     71.0%      71.7%
  OVERALL body / bg     113.4/77.3  114/77.2  115.4/77.3
  ROBOT 1 invisible         4.0%      4.5%       4.0%
  ROBOT 1 clean            74.2%     73.8%      74.7%
  ROBOT 1 body / deck   115.5/81.1 115.9/81.1 117.5/81.1
  ROBOT 2 invisible         7.3%      5.9%       6.6%
  ROBOT 2 clean            60.8%     61.8%      61.9%
```

Every claimed figure reproduces. The one that matters: **ROBOT 1's body has gone from 84.5 against
a 96 deck to 117.5 against an 81.1 deck.** A machine 11 points darker than its floor is now 36
points lighter than it. That is the exact move round 4 demanded and it landed. `contour.mjs`'s
`values()` is an honest definition — median of every stencil pixel against the median of a 14px
ring just outside it — and I re-implemented it independently (`bodyring.mjs`) and got 115.6/81.1
against contour's 115.9/81.1 on the same frame, so the tool is not flattering itself.

### But the magnitude is not trustworthy, and I could not make it be

I measured the same quantity — ROBOT 1 body minus deck ring — on **nine captures of one identical
sim state at one commit** (tick=420, p1=-1.93,8.02, p2=9.52,-1.77 printed by every one of them),
using contour's own stencil and contour's own ring rule:

```
  capture                                          frame p10   R1 body - deck ring
  contour.mjs run 1  (VFX off, DOM off)               36.8           +34.5
  contour.mjs run 2  (VFX off, DOM off)               36.8           +36.1
  same page as run 2, shutter BEFORE anything hidden  26.7           +32.2
  clockab.mjs A  (contour's flow, my script)          47.6           +24.0
  clockab.mjs B  (same, clock stepped in lockstep)    47.6           +21.0
  clock2.mjs t0 / t7.03 / t3.5  (one page, 3 shots)   31.4     +20.0 / +16.8 / +22.2
  isolate.mjs  full frame, VFX and DOM on             10.8            +5.7
  isolate.mjs  VFX off, DOM off (contour's condition)  6.1            +6.5
  screenshot.mjs --shot fight (tier 3)                10.5            +6.8
```

`contour.mjs` is internally repeatable — its two runs agree to 1.6 points and its bounding boxes
are pixel-identical, exactly as round 4 established. That is not the same thing as the *render*
being repeatable. Across launches the frame's 10th-percentile luminance runs from **6.1 to 47.6**
and the headline separation runs from **+5.7 to +36.4**. The sim is pinned, the camera is pinned,
the seed is pinned; the picture is not.

Things I ruled out, so the next person does not repeat the work:

- **The effect clock.** `contour.mjs` calls `fastForward(420)` in one bulk call and never advances
  `engine.clock.elapsed`, so it photographs the sim at t=7.0s with the effect and animation clock
  at **t=0.03s** — I printed it. `screenshot.mjs` steps the clock in lockstep, which is the bug its
  own commit message says it fixed; contour still has it, and the two tools therefore capture the
  machine in visibly *different arm poses* (`r5-r1-3x.png` vs `r5-pp-r1-3x.png`). Real, worth
  fixing, **not the cause**: moving the clock 0.03 → 7.03 → 3.5 within a single page moves the
  separation only 20.0 → 16.8 → 22.2.
- **The exposure ramp.** `main.js:718` damps `exposure`, `saturation` and `vignette` toward their
  match targets on real wall-clock `dt` inside `_render`, and every tool then detaches
  `engine.onRender`, freezing the ramp wherever it got to. Real, and worth a builder's attention
  for a different reason — I read the uniforms at each tool's shutter and got exposure **1.2324**
  (contour) vs **1.2284** (screenshot.mjs) against a match target of **1.35**. Under software GL
  the ramp is so slow that *no capture this project has ever taken has reached the match grade*;
  even a live match at t+5s only reaches 1.2362. But a 0.3% difference cannot produce a 6-fold
  swing, so it is **not the cause** either.
- **Mask misalignment.** Checked by eye at 3x: the stencil sits on the machine in both frames.

**Consequence, and it is the same shape as the `measure.mjs` finding I made in round 4:** the
number this round is being judged on is stable to 1.6 points *within* `contour.mjs` and moves by 30
points *between* tools that photograph the same frozen frame. The **sign** of the recast is solid —
all nine captures are positive, where round 4 was negative — and that is what I am scoring the
blind test on. The **magnitude** should not be quoted to one decimal place by anybody until a
builder finds out why two tools disagree this much about the same pixel.

### Re-verified at `da3253a`, which is where this round closes

Four commits landed after `b28ff8c` (`8727f60`, `1b93a1e`, `18ff5c1`, `c267025`, `51247e1`,
`ab8b88e`, `da3253a`). Everything below is re-measured at `da3253a` on a clean worktree build,
`vite preview` at 4220, so nothing in the verdict is inherited from the opening half of the round.

The recast holds — one unmodified `contour.mjs` run, tier 3, seed 1234567:

```
                        b28ff8c (round open)   da3253a (round close)
  OVERALL invisible            4.6-4.8%              4.4%
  OVERALL clean               71.0-71.7%            71.1%
  OVERALL body / bg          114-115.4 / 77.2      113.6 / 77.3
  ROBOT 1 body / deck        115.9-117.5 / 81.1    115.7 / 81.1
  ROBOT 2 body / bg              — / —              99.4 / 40
```

Every figure is inside the 0.4-point error bar or the 1.6-point run-to-run spread I measured at the
top of this round. Nothing regressed under the HUD and stage work.

### The frame-attention question I posed, answered — and the account of it corrected

I asked whether the machines now out-rank the scenery, and a robot agent reported the robot's best
luminance x chroma tile moving from **rank 28 of 720 to rank 17**, with the tiles above it being
"the tracer beam, the rails and a wall lamp". I did not inherit that. `salience.mjs` (written from
scratch this round) takes robot pixels from **contour's binary stencil** rather than a box — a box
round a robot is mostly deck, so a box tile can score on deck pixels and be credited to the machine
— runs three scoring models, and sweeps four tile sizes at two offsets, because one tile size and
one formula is one data point rather than a measurement. On `r5b-player.png` (the frame the player
sees, taken from contour's own settled page so the measured frame and the seen frame share a
camera):

```
  model                                   T=32   T=40   T=48   T=64
  A  lum x chroma  (the agent's model)     20/17  11/14  12/8   5/7
  B  (lum + 1.5*local contrast) x chroma   14/11   9/8    7/6   5/7
  C  local contrast x chroma  (harshest)    4/10   5/3    1/2   2/4
     — best robot tile's rank, at offset 0 / offset half-tile; totals 1100, 680, 462, 275
```

**The direction reproduces and the exact number does not**, which is the same lesson as the contour
magnitude: on the agent's own model at its own tile size I get **rank 11 of 680**, not 17 of 720.
Quote the sign, not the digit.

**The account of what out-ranks it is wrong, and the correction matters more than the rank.** It is
not the tracer, the rails and a lamp. Under model A **the entire top ten is one object** — tiles at
x=80-200, y=226-386, which `r5b-gate-2x.png` shows to be the **warm lit entry gate at frame left**:
glowing amber louvre panels, the cyan rim rail beneath them and the yellow/black hazard chevron band
under that, stacked into one 120x160px block that is the most saturated bright region in the
picture (gate crop: warm 70.5%, saturated 50%). One piece of architecture in the corner of the frame
is beating both machines on every model that weights brightness.

**Is rank 17 acceptable, or must it be rank 1? Neither, and the tile rank is the wrong instrument.**
A tile rank asks "is there one 40px square of robot brighter than every 40px square of anything
else", and the honest answer for any game with a lit set is no — a lamp is allowed to be brighter
than a machine. What the blind test actually asks is whether the machines punch above their size.
So I measured that instead, on the same frame: the machines are **1.6% of the scene pixels** and
supply **26.0% of the frame's brightest 1%** — a **16x over-representation**, against a background
that also contains a tracer beam and a lit gate. The full split of that top 1% (threshold luminance
172):

```
  white / neutral        45.4%   the tracer beams at x~800 y200-400, and the white deck-edge rim line
  ROBOT                  26.0%   1.6% of the pixels, 26% of the highlights
  warm (gate, chevrons)  15.5%
  cyan / blue            12.9%
```

**That is a pass, and it is the answer to the question.** Rank 1 is not required and was never the
right target; 16x over-representation in the top of the value range is. The one figure that is still
the wrong way round is coverage-weighted: the cyan rail family is **2.8% of the scene at mean
luminance 136.8** against the machines' **1.6% at 117.7**, so there is still more bright cyan on
screen than there is robot. That is a smaller complaint than round 4's, and it is the only part of
N6 left.

### N6's own numbers reproduce, and the HUD now loses to the machine

`c267025` measured the HUD against the standard the stage had just been held to and found the health
bars at luma 169.7 / p95 207 / 85.5% saturated — brighter and more saturated than either machine.
Re-measured independently at `da3253a` (`regions.mjs`, written this round; machine figures taken
through contour's stencil, not a box):

```
                        mean    p50     p95   sat%   clip%      claimed after
  P1 health bar        123.7  135.1   152.1   90.9      0       122.1 / p95 152
  P2 health bar        135.2  139.3   152.1  100.0      0
  P1 class chip         31.2   26.2   113.9   56.9   1.37       clipping 66.3% -> 2.2%
  player machine       117.6  121.0   199.7   22.8      —       p95 188
  opponent machine     106.1  104.8   186.9   28.3      —
  deck (mid / right)  75.4/91.8  —  121/115  6.5/0.4    0
  lit gate             114.5  113.6   171.0   69.2      0
  hazard chevron       112.1   96.2   187.0   39.0      0
  cyan rail band        65.3   47.2   150.9   46.1      0
```

Every claim in that commit reproduces, one of them better than claimed: **the machine's highlights
(p95 199.7) now out-rank the loudest HUD pixel (152.1)**, and the opponent has gone from luma 51.3
to 106.1 — it more than doubled. Both machines are now brighter than the deck they stand on, on the
frame with the HUD and the VFX both drawn, which is the frame the player sees. The class chip's
blowout is gone (1.37% clipping against 66.3%). **N6: FIXED.** Credit; this was the finding of round
4 and it has been answered with the right instrument.

### The notch layout, photographed for the first time in this project's history

`afbefa2` moved the four safe-area custom properties from `.crv2-ui` to `:root`, on the round-4
recommendation, and that makes the override work: `getComputedStyle(documentElement)` now returns
`--safe-t: 47px` **and the elements move**, where in round 4 they did not. So here is the check
nobody in this project has ever been able to make — the same touch scenario captured twice from one
build, insets forced to `0,0,0,0` and to an iPhone 12's `47,34,0,0` (`insetshot.mjs`;
`r5b-ip12-0.png` / `r5b-ip12-47.png`), with every element's box read out of the live page:

```
  element        insets 0 (top..bottom)   insets 47/34   moved
  .hud__top            8 .. 69              55 .. 116     +47 down
  .hud__centre         8 .. 65              55 .. 112     +47 down
  .hud__gear          78 .. 201            125 .. 248     +47 down
  .gear__mob         181 .. 201            228 .. 248     +47 down
  .tc__pause          84 .. 130            131 .. 177     +47 down
  .tc__pad           622 .. 828            588 .. 794     -34 up
  .tb--fire          740 .. 828            706 .. 794     -34 up
  .tb--jump/dash/bomb/pod                                 -34 up
  .tc__stick       558.6 .. 690.6      558.6 .. 690.6      0  (held, so positioned at the thumb)
  .hud__scrim          0 .. 158              0 .. 158      0  (full-bleed by design)
```

**What 47px and 34px actually do:** the notch inset pushes the entire top HUD stack down as one
block, landing the P1/P2 plate at y=55 on a 844px screen — clear of an iPhone 12's ~47px sensor
housing with 8px to spare — and the home-indicator inset lifts the whole five-button touch cluster
up as one block, putting FIRE's bottom edge at 794, i.e. **50px above the screen edge** and clear of
the indicator. Nothing collides at either setting: the HUD stack ends at 248 and the pause chip
starts at 131 inside it, the touch cluster's top (588) is 340px below the HUD's bottom. The idle
stick is covered by its own `bottom: calc(12px + var(--safe-b))` rule and moves with the rest; it
does not move in this capture only because the capture holds a thumb on it, which is correct
behaviour. **The layout is verified, not merely plausible.** The round-4 caveat is withdrawn.

### The explosion, with the new occlusion metric pointed at it

I wrote earlier that the explosion is *"genuinely good early and muddy late"*. The VFX agent reached
the same conclusion independently and worked the late smoke; `51247e1` added the right instrument
for judging the result — `cover` (the effect changed this pixel at all), `hide` (changed it by more
than a glaze) and `lift` (mean signed change), all differenced against a plate of the same frozen
frame captured before ignition, so the footprint is exact with no segmentation. All figures below
are percentages **of the 560px crop**, not of the frame.

Full lifetime at `da3253a`, tier 3 (`r5b-sheet-explosion.png`):

```
    age    >200%   warm%   cover   hide    lift
     0ms   14.74   49.59   58.9%  39.5%   +45.1
    17ms   17.21   46.35   60.2%  41.8%   +49.0
    40ms   18.30   50.68   59.7%  41.6%   +50.0
    70ms   11.52   55.28   52.1%  34.4%   +38.7
   110ms   12.11   54.81   50.7%  33.3%   +37.2
   165ms   11.93   55.70   49.4%  34.1%   +37.0
   240ms    7.15   56.79   47.4%  36.4%   +32.5
   340ms    4.20   60.32   49.4%  40.8%   +27.6
   470ms    2.41   62.89   54.6%  42.0%   +25.5
   650ms    0.37   44.46   30.2%  19.3%    +5.7
   950ms    0.39   27.11    4.8%   1.2%    -0.4      <- effect over; -0.4 is the noise floor
  1400ms    0.38   27.59    5.8%   1.1%    -0.4
```

**"Muddy late" is no longer true, and I am withdrawing it.** There is no grey smudge anywhere in the
lifetime. The shape reads as drawn rather than simulated, which is the reference's whole idea: a
white-cored hard-rimmed ball at 0-40ms, a saturated orange lobed mass with real internal soot
striations at 70-470ms (`>200` falls from 18.3% to 2.4% while `warm` *rises* from 50% to 63% — the
mass cools into colour instead of fading to grey, which is exactly right), then dispersal.

Two residuals, both small, and one of them needs a builder's eye:

**(a) The tail is attrition, not dissipation.** A narrow sweep (`r5b-sheet-excliff.png`, ages
690/710/730/750) gives cover 20.7 / 14.0 / 9.3 / 6.5 and, at 1:1, shows *fewer* flame tongues each
step rather than *dimmer* ones — the individual tongues are at full chroma when they stop existing.
Over 60ms at 60fps that is four frames of large orange shapes winking out one at a time. It is the
one part of the effect that looks like particles rather than a drawing. Cheap fix, low priority.

**(b) `lift` never goes negative, which is the metric's own test for soot.** The comment in
`51247e1` says it best: "a mass with real soot in it should go NEGATIVE in its late life, because
burnt gas is a hole, not a lamp." This one runs +45 → +25 → +5.7 → 0. The dark striations at
240-470ms are dark *relative to the fireball*, not dark relative to the arena; at every age the
effect is a net lamp. That is the difference between an explosion that is drawn over the arena and
one that is standing in it, and it is the single thing left between this effect and the reference.

**(c) A number worth a designer's attention rather than an artist's.** `hide` sits at 33-42% of the
crop from 0ms to 470ms — the effect blocks a third to a half of its own neighbourhood for half a
second. In a game where you dodge on the opponent's animation, that is a readability decision
somebody should make deliberately rather than inherit.

**And the impact effect is not there at all.** `--effect impact` over its full 0-700ms sweep never
exceeds **cover 1.9% / hide 0.1% / lift 0.0** — i.e. the difference against the pre-ignition plate is
indistinguishable from nothing at every age. Either it fires outside the crop the tool centres on
the blast, or it renders nothing. Whichever it is, the effect that plays on *every single bullet
that lands* is currently unmeasurable, and that is worth a builder's ten minutes before any more
tuning of the explosion, which is already the best-looking thing in the build.

*Captures this round, all at `b28ff8c` on a local `vite preview` at 4220:* `r5-fight2.png` (the
fight frame; see the harness note below), `r5-cn2.png` / `r5-mask2.png` (contour, `--keep`),
`r5-player-samepage.png` (the player frame taken from contour's own settled page, via a four-line
uncommitted probe), `r5-squint.png` / `r5-squint-novfx.png`, and 1:1 / 3x / 4x crops. Tools written
this round and left in the scratchpad: `salience.mjs`, `bodyring.mjs`, `squint.mjs`, `gstat.mjs`,
`clockab.mjs`, `clock2.mjs`, `expo.mjs`, `isolate.mjs`.

### Harness note — `screenshot.mjs --shots` corrupts its first frame

`--shots fight,title,garage,explosion` wrote a `fight` frame containing **the title-screen model
rig with the match HUD drawn over it** (`r5-fight.png`): one machine facing camera on a lit
circular pad in a black void, both HP plates reading "ROBO / BALANCED / 1000", no arena at all. The
same scenario captured alone (`--shot fight`) gives the correct arena frame. Every batched review
capture this project has taken has had a garbage first shot, and it looks plausible enough at
thumbnail size to review from. *Severity: BLOCKING for the review process. N1's sibling.*

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

**11. Garage stat bars look broken.** — **FIXED (round 2), and still fixed at `35d0e66`.**
`c5-garage.png`: ARMOUR 1000, SPEED 8.2, AIR CONTROL 0.62, MASS 1.00, POISE 1.00 each have a
proportional fill on a dark track, label and numeral share a line, and the "—" sits under a
"VS EQUIPPED" column head.
*New defect found while checking it — the garage screen is far too dark.* At 1:1 the part-list
secondary labels ("Balanced", "Heavy", "Speed", "Technical", "Assassin"), the "LIVERY 塗装",
"PERFORMANCE 性能" and "VS EQUIPPED" headers, and the chip category labels are all dim grey on
near-black and sit well under any reasonable contrast floor. This is not a capture artefact:
`c5-title.png` was taken in the same run with the same settle and its menu rows are crisp white.
The garage is the screen where a player reads numbers, and it is the least legible screen in the
build. *Severity: MAJOR.*

*Round-2 entry:*
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

**15. Title and garage robots float on a 1px ellipse in a void.** — **ROUND 4 (`35d0e66`):
(a) FIXED, (b) IMPROVED, (c) NOT FIXED.**
(a) **The contact shadow is there now.** `c5-title.png` shows a soft dark pool under and slightly
left of the machine's feet on the pad, consistent with the rig's key direction. `514051f` reached
the menu rigs. The machine touches the ground.
(b) The pad's outer edge is still a hard-terminating ellipse, but it now sits in a soft floor glow
rather than pure black, so it reads more as a lit circle in a dark room than a disc in a void.
Partial.
(c) **The chip/model collision is unchanged** — see N2.

**A note on the menu rigs that matters more than this entry.** The title screen is the one place in
this build where the machine is unambiguously the subject, and probing it explains N6 precisely.
Same robot, two screens:

```
                  robot body   its background   ratio
  c5-title.png       49.1           10.9        4.5 : 1   robot dominates
  c5-fight.png       76.5           92.8        0.8 : 1   background dominates
```

The machine is in fact **lit more brightly in the arena** (76.5) than on the title screen (49.1).
It is not under-lit and it does not need repainting. **The deck is over-lit relative to it.** The
title screen proves the model, the materials and the outline all work when the ground gives up the
top of the value range. That makes the cheapest fix for N6 "take the deck and the rails down",
not "re-cast the robots" — and it preserves the arena work, which is the best thing in the build.

*Superseded round-2 entry:*
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

**N2. Garage loadout chips overlap the model.** — **ROUND 4 (`35d0e66`): NOT FIXED.**
`c5-garage-chips.png` (3x on (600-1020, 740-840) of `c5-garage.png`): the BODY / GUN / BOMB / POD /
LEGS chip row is still drawn straight across the model's feet and lower shins. "STANDARD" and
"STINGER" sit on top of the machine's boots. The round reported this as addressed; it is not.
*Also visible in the same crop, and worse:* the chips' own category labels (BODY, GUN, BOMB, POD,
LEGS) are dark grey on near-black and are effectively illegible — see the garage-contrast note
under #11.

**N3. The two HP bars are not comparable.** — **ROUND 4: FIXED at full health; UNVERIFIED below
it.** In `c5-fight.png` and `c5-explosion.png` both bars are the **same green** at 1000/1000 and
860/860, so the round-2 complaint — a healthy opponent reading as dying because its bar is red — no
longer applies at the state I could capture. **I could not get a partial-health frame**: every
scenario in `screenshot.mjs` freezes at a tick where both machines are untouched. That is a gap in
the harness, not a pass: if the bars are green at full and team-coloured below it, the defect is
merely hidden at the one state anyone photographs. **A builder should add a scenario that freezes
at, say, 60%/85% health, and a reviewer should then re-check this.** Do not mark N3 closed until
someone has seen that frame.

**N4. The ammo bar and the health bar are the same widget.** — **ROUND 4: FIXED in form.**
`c5-gear.png` (2x): the VULCAN meter is now **eight discrete segments on a dark track**, which is
unmistakably a different widget from the continuous green health fill. The two quantities no longer
speak the same visual language. Good fix.
*Residual:* in every frame I captured all eight segments are **empty**, and an empty segmented
gauge is visually identical to a gauge that was never wired up. Whether the value is correct (the
player has been firing for 6.3s of sim, so it may well be) is beside the point — the empty state
needs styling that reads as "spent" rather than "absent". Compare the BOMB and POD rings beside it,
which are unmistakably alive.

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

Captured at `35d0e66`: `c5-touch-iphone12.png` (390x844 @3x, `screenshot.mjs --shots touch --device
iphone12`, the scenario that wakes the layer with a real tap and then holds two fingers down), plus
`c5-ip12-edge.png` and `c5-ip12-br.png` at 1:1, and a safe-area probe of my own (`inset.mjs`).

**The touch layer landed and it is good.** `65e4670` works. A left analogue ring with a dragged nub
sits at the thumb's home position, and FIRE / JUMP / DASH / BOMB / POD are laid out bottom-right in
a thumb arc with FIRE largest. Labels carry kana. The layer mounts on first touch as designed.

**The safe-area question, which is what nobody had checked.** `src/ui/ui.css` uses
`env(safe-area-inset-*)` in 25+ places — `.hud__top`, `.hud__gear`, `.tc__stick`, `.tc__pad`, the
screen padding — so the intent is there and the arithmetic checks out: at a real iPhone 12's 47px
top inset, `.hud__top`'s `calc(8px + var(--safe-t))` puts the plate at y=55, clear of the notch;
at the 34px bottom inset, `.tc__pad`'s `calc(16px + var(--safe-b))` lifts FIRE clear of the home
indicator. Measured at 1:1 with insets at zero, FIRE's right edge sits 12.7 CSS px in
(`c5-ip12-br.png`) and its bottom 31px up, exactly as the rules specify, so the layout is doing
what it is told.

**But it is still unverified on a device, and it cannot be verified in this harness.** Headless
Chromium reports every `env(safe-area-inset-*)` as 0, so *every touch capture this project has ever
taken is of the no-notch layout.* I tried to force the issue: `inset.mjs` sets the four custom
properties on `documentElement` with `!important`, and `getComputedStyle` confirms `--safe-t: 47px`
— **and not one element moved.** The reason is that `ui.css` declares the four variables on
`.crv2-ui` (line 24 block, lines 73-76), not on `:root`, so the container's own `env()` declaration
shadows any root override for everything inside it. That is not a product bug — and the fact that
`.hud__top` resolves to exactly 8px rather than dropping an invalid `calc` proves the HUD really is
inside `.crv2-ui` and really will receive the insets on a phone. **The claim "verifies clean" is
therefore plausible but still untested.** To make it testable, move the four declarations to
`:root` and let `.crv2-ui` inherit; the override then works and the notch layout becomes
photographable in CI.

### Real defects on the phone

**P1. The top 23% of the portrait screen is empty, flat, saturated blue.** `c5-ip12-edge.png` at
1:1 shows the arena's back wall terminating in a razor-sharp horizontal line across the full width,
with nothing above it but the clear colour — measured at saturation **0.71-0.91 and 100% cool**,
which makes it *the most saturated region of the entire phone frame, and it is empty*. On a 16:9
desktop frame the raked stands fill the top rows and you never see it. On a 19.5:9 portrait phone
the taller vertical FOV looks straight over the arena and out into the void, because the arena has
no ceiling, no upper structure and no sky treatment. **This is the first thing a phone player sees
and it is the worst-looking part of the build.** *Severity: BLOCKING on mobile.*

**P2. BOMB and POD are drawn twice, in two different visual languages.** They appear as ring-gauge
chips in the top HUD band *and* as circular touch buttons in the bottom cluster. One screen, two
widgets, same two things.

**P3. The JUMP and DASH charge pips are orphaned.** "JUMP ●● DASH ●●" sits directly on the flat
blue with no backing plate, while every other HUD element on the screen has one.

**P4. Not a defect, but do not read it as a pass:** the capture reports `fps 21, frameMs 46.6, tier
LOW, scale 0.72`. That is software GL in a container and says **nothing** about a real iPhone 12.
What it does show is that the auto-quality path engages and picks LOW at 0.72 render scale, which
is the behaviour you want. **Frame rate on this device remains unmeasured.**

---

## VERDICT

PENDING
