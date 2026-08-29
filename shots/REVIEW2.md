# HOLOSSEUM — Art Direction Gate Review

Rolling document. Round 2 reviewed `10621f2`; round 4 reviewed `35d0e66`; round 5 opened at
`b28ff8c` and closed at `da3253a`; round 6 opened at `1e49409` and named a cause; round 7 opened at
`ac50610` and closed at `762d220`; round 8 opened at `cc7cebb` and audited its own meters;
round 9 opened at `0594eb2` and half-closed `#14`; round 10 opened at `8b3208e` and found that the
number the whole art prescription was written against had never existed; round 11 opened at
`84d5401` and measured the mass meter's noise floor for the first time; **round 12 (this pass) opens
at `c0202d1`**, and its job is to re-run the mass rule on both machines in all three arenas against
that floor, re-score `#14` now that the frame it was argued on turns out to have no contact in it,
verify the iPhone inset work and close what closes, and check the landscape menu restructure against
`N8`.

**STATUS: ROUND 12 CLOSED. The VERDICT section at the bottom of this file was rewritten for round 12
from existing evidence BEFORE this round's captures were taken, and then revised as they landed —
the continuation at the end of that section is the revision, and it strikes out the round's own
headline measurement. It has never been allowed to read PENDING and does not now. That section, not
this line, is what decides.**

**VERDICT: see the VERDICT section at the bottom of this file, which is the only place a verdict is
recorded. This header deliberately does not restate it — two earlier rounds shipped a header that
disagreed with the section, and the fix is to stop having two of them.**

---


## Round 12 (opens at `c0202d1`) — the mass rule re-run in all six cells, and the ledger's two faults numbered six

### The instrument audit, first, and this round it is short because the answer was already written down

Round 11 ended with a one-line prescription: the settle drives the camera 240 times at a fixed `dt`
and the machines once at `dt = 0`, every pose term in the model is a damper, and a damper does not
move at `dt = 0`. The fix was to pass the same `dt` to the machines.

**At `c0202d1` it has not landed.** `tools/mass.mjs:136` and `tools/contour.mjs:145` both still read

```js
g.view.update(0, 1, t);
```

That was checked before a single capture was taken this round, because it decides what the captures
are worth. So the first thing this round did was apply it, behind a flag rather than as a silent
edit, so both behaviours come out of one binary and the comparison is honest: `--drive 0` reproduces
the meter as shipped, the default settles the machines at `1/60` alongside the camera. The A/B is
**interleaved** — run *i* of both modes back to back before run *i+1* — because the fault under test
is sensitivity to wall-clock load, and a floor taken for one mode at 19:15 and the other at 19:50
would be comparing two ambient loads as well as two settle modes. A second agent's capture was
running on another port for part of the window; interleaving is what makes that survivable, and it
is disclosed rather than hidden.

### Two faults are both numbered six, and one of them has to move

`REVIEW2.md` round 11 closes its audit with *"this is the sixth instrument fault"*, meaning the
unpinned settle. `c0202d1`'s commit message opens with *"the round's real finding, and it is the
sixth instrument fault on this project"*, meaning the grounding frame. **They are different faults
and they cannot both be six.** The settle was found first and keeps the number; the grounding frame
is the **seventh**. The ledger is the only reason any of this is auditable and a ledger with two
entries at the same index is not one.

### `#14` — the open half is not open, it is unmeasured, and that is a worse finding

The seventh fault is that on the standard pinned frame — grid, seed 1234567, tick 420, the frame
`contour.mjs` and `mass.mjs` share — the player is **1.12 m airborne with its ground contact point
95 px below the bottom of the frame**. A contact reads in the deck *around* the contact: the pool of
occlusion the feet sit in. A contact point off-screen has had the whole measurement cropped away.

Round 9 left `#14` as *"obstacles PASS, machine grounding stays open"*. **That verdict has to be
withdrawn rather than kept.** Every reading behind the open half — round 9's "the machines are still
barely grounded", round 8's, and my own repetition of it in the round-11 ledger — was taken on a
frame in which the machines are not on the ground and the place they would touch is not in shot. The
honest status is not FAIL and not PASS:

> **`#14` machine grounding: NOT MEASURED. Eight rounds of readings are void, and the reason is that
> nobody checked whether the frame had a contact in it before measuring the contact.**

This also lands on blind point 1's composition clause. Round 4's entry says *"the player's feet end
1 px from the bottom of the screen… you cannot see the ground the machine is standing on"* and files
it as a framing defect. It is not framing. The feet are 1 px from the edge because **the machine is
in the air**, and the deck under it is 95 px further down than the frame goes. The composition
complaint and the grounding complaint are the same fact, counted twice, on a frame that cannot
answer either.

**What has to happen before `#14` can be scored at all:** `shots/_ground.mjs --survey` picks a tick
at which both machines are grounded with clear viewport under their feet, and the grounding meter
runs there. Until that tick exists in this document, no grounding number should be quoted, including
a favourable one.

### The mass rule, re-run — and round 11 captured all three arenas and published one

The measurement this round exists to settle is whether the machines now read as four or five masses
rather than eleven. Before taking anything new, the round-11 captures were read back in full. **They
cover all three arenas at five runs each. Round 11's document prints orbital only.** Grid and
foundry have been sitting on disk unread, and one of them is the answer.

At `84d5401`, five identical runs per cell, `@51` (the rule's own five-band step), reported as
observed range:

```
                  masses @51      curve mean      largest %        top4 %
  grid   ROBOT 1   4.0 .. 4.3     4.3 .. 4.6    55.7 .. 65.7    88.3 .. 89.8
         ROBOT 2   5.3 .. 5.5     6.1 .. 6.5    41.1 .. 42.3    83.8 .. 84.8
  found. ROBOT 1   6.3 .. 7.5     7.5 .. 8.1    36.8 .. 45.3    76.5 .. 82.2
         ROBOT 2   4.8 .. 5.8     5.1 .. 5.5    54.5 .. 59.3    84.3 .. 85.7
  orbit. ROBOT 1   3.5 .. 4.3     4.3 .. 4.7    56.2 .. 63.2    86.6 .. 87.6
         ROBOT 2   4.8 .. 5.3     5.6 .. 6.2    54.8 .. 57.9    89.5 .. 90.9
```

**Five of the six cells are inside the four-or-five band at the five-band step, and the sixth is
not.** Foundry's player returns **6.3 to 7.5 masses with top4 coverage of 76.5-82.2%** — the only
cell in the grid that is out, and the only cell nobody had quoted. The eleven-mass machine this
document has argued about since round 6 is gone from every arena. That is a real and large
improvement and it is the first thing this round should say.

**But the cell that fails is failing for a reason the mass rule cannot see, and it is worth more
than the five that pass.** Foundry's player is measured at **69x194 px**. The same machine is
160x261 in grid and 173x273 in orbital: an aspect of 0.36 against 0.61 and 0.63. The player in
foundry is not a smaller machine, it is a **sliver** — most of it is behind an occluder, and the
meter's own doctrine is that *"a machine standing behind a pillar is measured on the part of it you
can actually see"*. That is exactly right for a contour reading and it is wrong for a mass count: a
third of a machine fragments into more pieces than the whole of it, at any quality of lighting. So
foundry's 7.5 masses is not evidence that the light rig failed in foundry. It is evidence that the
pinned frame puts the player behind a pillar in one of the three arenas, and that no mass count
taken there means anything.

**Two arenas' worth of frames are therefore unfit for the measurement they are used for** — grid for
grounding, foundry for mass — and in both cases the fault is the same shape: the frame was pinned
once, for the silhouette meter, and inherited by every meter since without anyone asking whether it
suits them.

### The iPhone 12's real insets — verified, closed on the layout, and the frame it closes on is a title card

The eleven-rect arithmetic round 11 checked reproduces; I re-read both logs and both captures at
1:1 rather than taking that on trust. `hi-p-log.txt` and `hi-l-log.txt` agree with the stylesheet in
both orientations, `.hud__scrim` is the only rect entering a reserved band at rest and it is
full-bleed by design, and `.tc__stick` enters the home band only in the LIVE two-finger state, where
it is under a thumb. **The layout half of the entry is closed and should not be reopened.**

**One thing nobody said about those two captures, and it matters for what they can be used to
argue.** `hi-p-match.png`, `hi-l-match.png` and `hi-l-idle.png` are all photographs of the **ROUND 1
READY card**, not of gameplay. The card's own glyphs are the brightest object in all three. The
rects are unaffected — the HUD lays out identically — so the layout close stands. But no
art-direction claim can be made from these frames without saying which frame it was made on, and
the next round should capture a phone frame with the card gone.

### What those captures do show, measured, and it is the first phone-side reading of blind point 1

`N8` in this document says a fix verified on desktop is not a fix. The same sentence applies to a
PASS, and blind point 1 — *"the robots are the brightest, most saturated things on screen"* — has
only ever been measured at 1600x900. `shots/_framesal.mjs` (new this round, force-added) reports any
frame's brightest-1% and visible-chroma shares against named rects, with no mask needed.

```
  hi-p-match.png  1170x2532 (390x844 @3x)      area%   bright1%    visible chroma%   chroma/area
    .tc__pad   (FIRE/BOMB/DASH/JUMP/POD)        10.0      16.3          54.7            5.46x
    .tc__stick (floating stick)                  5.3       1.3          13.1            2.48x
  hi-l-idle.png   2532x1170 (844x390 @3x)
    .tc__pad                                     7.4       8.1          49.7            6.70x
    .tc__stick                                   5.3       0.0          11.7            2.22x
```

**The five touch buttons own two thirds of the portrait frame's visible chroma and 61% of the
landscape frame's, off a seventh of its area, and in neither orientation does a machine appear
anywhere in the top twelve salience tiles.** In landscape the top six tiles are the title card and
tiles seven through twelve are all inside the button cluster. On a phone the most saturated thing on
screen is a magenta ring that says POD.

That is not a rendering defect and it is not fixable by a light rig. It is a statement about what
this game looks like on the device it is aimed at, and it means blind point 1's PASS is a
desktop-only PASS. It should be recorded as such rather than carried unqualified.

### An instrument suspicion that came back negative, recorded because the negatives are what make the positives worth anything

Blind point 1's chroma half fails on a filter of `S >= 0.35`, and `S = (max-min)/max` is scale-free:
RGB (2,3,12) scores 0.75. On the phone captures that filter calls **73.9%** of the portrait frame
and **81.5%** of the landscape frame saturated, which is plainly wrong for frames that read as
monochrome blue-grey — gate it at `L >= 40` and the same frames return 9.1% and 6.1%. So the filter
was put to the round-8 desktop dumps it was actually used on, expecting an eighth fault:

```
                    S>=0.35    S>=0.35 & L>=40    round-8 published
    grid             59.2%          59.0%              58.5%
    foundry          89.7%          89.6%              89.5%
    orbital          59.5%          59.3%              59.2%
```

**The gate moves nothing — 0.3 points at worst — and round 8's published figures reproduce to within
a point.** The filter is safe at the desktop dumps' exposure and unsafe only on frames dimmed by a
title card and a scrim. There is no eighth instrument fault here. **Point 1's chroma FAIL survives a
stricter instrument than the one that produced it**, which is the strongest thing that can be said
for a measurement, and it is said here because the previous six audits all went the other way.

### The landscape menus, against `N8`

`L1-09-settings.png` at 1:1 (`shots/r12/c-set-sens.png`) photographs the defect exactly as round 11
described it: on 844x390 the word **SENSITIVITY is cut horizontally through the middle of its own
glyphs** by the footer bar's top edge, and the two options below it are entirely underneath. Round
11 is right that the walk overstates this — the list scrolls 150 px and everything clears — and
right that the real defect is that **at rest nothing on screen says the list continues**.

**What the walk and round 11 both missed is next to it in the same photograph.** The screen is a
two-column grid: AUDIO takes the left column with three sliders, VIDEO takes the right with two, and
CONTROL starts a *third* row under AUDIO — so SENSITIVITY, INVERT Y and TOUCH LAYOUT are pushed
under the footer **while the entire lower right quadrant of the screen is empty**. The content that
does not fit and the space it would fit in are in the same frame. This is not a scrolling problem
that needs an affordance; it is a column-balance problem, and the fix is to let the second column
take the overflow rather than to teach the player to swipe.

### `N8` — the landscape restructure is being written against a finding that is not true at head

The brief for this round says a UI agent is restructuring the landscape garage *"after finding the
category rail unreachable at 844x390 — all seven controls at negative coordinates, off the top, with
nothing on screen saying so."* That is `_r10-walk.mjs`'s output, and round 11 already diagnosed why
it says that: **the walk swipes to the extreme and re-tests there.** The garage scroller has 450 px
of range in landscape; swipe it to the end and the rail is at negative y, because the walk put it
there.

Rather than re-run a tool I know overstates, this round replaces the reachability half of it.
`shots/_reach.mjs` (new, force-added) hit-tests a **6 px grid across the whole control** instead of
one point at its centre, sweeps the screen's real scroller instead of jumping to its extreme, reports
the centre of the largest fully-hittable sub-rect so a fix has a target, and separates the three
states this project has been filing as one: UNREACHABLE, needs a SCROLL, and hittable-but-its-own-
centre-misses. It also skips controls that are in the DOM but not rendered — the first version of it
scored eleven phantom `UNREACHABLE`s on SETTINGS because every screen's markup is present at once,
which is very likely a second contributor to the walk's numbers.

**Landscape garage, 844x390, iPhone 12 insets, at `c0202d1`, at rest:**

```
  01 BODY   [69,55,145,105]    100% visible   centre hits
  02 GUN    [149,55,225,105]   100% visible   centre hits
  03 BOMB   [69,109,145,159]   100% visible   centre hits
  04 POD    [149,109,225,159]  100% visible   centre hits
  05 LEGS   [69,163,225,213]   100% visible   centre hits
  P1        [69,232,145,274]   100% visible   centre hits
  P2        [149,232,225,274]  100% visible   centre hits
```

**All seven are at positive coordinates, fully on screen, and hittable at rest.** The premise of the
restructure does not reproduce. Nineteen controls on that screen, **zero unreachable in either
orientation**, and the same holds in portrait (390x844): the seven rail controls are 100% visible at
rest there too.

**What is actually wrong with that screen, and it is at the other end of it.** The defect is in the
preset chips, which nobody has named:

```
  landscape 844x390, scroller range 450px, affordance at rest: NONE
    NOCTURNE (part row)   [241,293,524,346]    44% visible, centre misses
    ROOKIE                [255,385,320,423]    17% visible, centre misses
    BULWARK               [325,385,401,423]    17% visible, centre misses
    SWIFT                 [406,385,463,423]    17% visible, centre misses
    ARTISAN               [255,428,326,466]     0% visible — scroll 168
    NOCTURNE (preset)     [331,428,414,466]     0% visible — scroll 168
  portrait 390x844, scroller range 682px, affordance at rest: NONE
    all five presets                            0% visible — scroll 255..340
```

Five preset chips, three of them showing a 6 px sliver of a 38 px control and two showing nothing,
and **the scroller reports no scrollbar and no fade mask**, so at rest the screen ends in a clean
edge that looks deliberate. That is the defect the landscape block was written to end, stated
correctly: not *"a player cannot reach the presets"* but *"a player is never told the presets are
there."*

**Landscape SETTINGS, same run, and here round 11's own numbers need updating.** Round 11 reported
`SENSITIVITY`, `INVERT Y` and `TOUCH LAYOUT` half-buried and said the screen scrolls 150 px. The
columns have since been rebalanced — those three now sit in the right-hand column at 100% visible —
and the defect moved rather than closed:

```
  scroller range 105px, affordance at rest: NONE
    QUALITY        [63,302,411,356]   22% visible at rest, centre misses, 100% after scroll
    SCREEN SHAKE   [63,362,411,419]   44% visible at rest, centre misses, 100% after scroll
```

Eight of ten controls clean, two half under the footer with their natural tap points missing, none
unreachable. **`N8` stays open, at the severity round 11 set** — *controls a player is not told are
there* — and the recommendation to the UI agent is: the rail is fine, do not restructure it; put a
scroll affordance on both screens and give the two clipped SETTINGS rows the 105 px they need.

### The build, and a line the ledger did not have

`c0202d1` fixed a stray `*/` in `ui.css` that left the tail of a comment parsing as bare CSS, so
`lightningcss` failed the minify step and `npm run build` was broken while `npm test` passed.
Verified at head in a clean worktree: **`npm run build` exits 0.** The entry the ledger needs is not
about the semicolon:

> **N9 — the test suite does not cover the build.** A build-only failure reached the tip of the
> branch and was found by a human running the build, not by CI or by `npm test`. Every round of this
> review has verified art from a `vite preview` of `dist/`, which cannot exist if the build is
> broken; a broken build is therefore a review-blocking defect that the project's own gate does not
> detect. One `npm run build` in the test script closes it.

### The instrument ledger, enumerated at last, because three numbering schemes are now in circulation

This document has been counting instrument faults since round 8 and has never written the list down,
which is how it ended up with two number sixes and, at head, three mutually inconsistent counts: the
one in this file, the one in the commit messages, and the one in the brief I was handed. A ledger
that cannot be read back is not a ledger. Here is the whole list, in the order the faults were
**found**, which is the only ordering that stays stable:

| # | Fault | Found | Status at `ebea06d` |
|---|---|---|---|
| 1 | `measure.mjs` is load-dependent — the bug `10621f2` claimed to close | R4 | fixed |
| 2 | that fix never reached `contour.mjs`, the tool measuring the #1 blocker | R4 | fixed |
| 3 | `screenshot.mjs --shots` writes a garbage first frame (**N1**) | R4/R5 | OPEN |
| 4 | `masses.mjs`' two modes disagree by 2x on one photograph; both retired | R7 | retired |
| 5 | the effect clock advances during boot, so a "pinned" frame is not pinned | R10 | fixed (`984723e`), **insufficient** |
| 6 | the settle drives the camera 240x at fixed `dt` and the machines **once at `dt = 0`**; every pose term is a damper | R11 | **OPEN at head** — `mass.mjs:136`, `contour.mjs:145`, and also `_lodprobe.mjs:50` and `_ground.mjs:123` |
| 7 | the standard pinned frame has **no ground contact in it**; eight rounds of grounding readings void | R12 | frame condemned; replacement not yet chosen |
| 8 | `shots/_lodprobe.mjs` never returned a reading (`1fac40d`) | R12 | **CLOSED in the round-12 continuation** — it returns in all three arenas, and the reading is that the LOD drops 5 of 224 primitives |
| 9 | anything that measures by **waiting** measures the renderer, not the game | R12 | characterised, below |
| 10 | **"the salience sweep" is not one instrument.** Two files in-tree and at least three in scratch, three scoring models, and no rank quoted in this document before round 12 says which. On foundry the luminance sweep puts a machine at **rank 1** and the chroma-weighted sweep puts the best machine-majority tile at **rank 70 of 880** — same frame, same build | R12 cont. | OPEN — every pre-round-12 rank is unattributed |
| 11 | **a layout probe cannot see a hole inside a panel.** `shots/_r13-garage.mjs` reports the landscape spec sheet at `EMPTY BELOW 0`; the photograph of the same screen has a **168x138 CSS void** in its right half. The DOM measure is correct and blind | R12 cont. | OPEN — pixel check added (`shots/_r12-void.mjs`) |

**A twelfth, which is not an instrument fault and is worse than one.** The six-cell mass table was
measured correctly, saved correctly, and then **reported wrongly in the verdict in all four of its
summary numbers, every one of them in our favour**, against files already in the tree. The meter
worked. See the struck-out block in the VERDICT. *No tool can defend against this; only reading the
file can.*

**Where the other two schemes went wrong, stated so nobody re-derives it.** `c0202d1`'s message
calls the grounding frame *"the sixth"* and `1fac40d` calls the LOD probe *"the seventh"*; both are
one low, because neither counted the unpinned settle — the fault that was found first and is still
open. The brief for this round inherits that offset and calls the clock clamp *"the eighth"*. It is
the **ninth**. The commit messages are not being rewritten; this table is the index.

**Eleven faults in twelve rounds, and the shape of them has not changed once.** Every single one is an
instrument that returned a plausible number rather than an error. Not one was caught by a tool
failing loudly; every one was caught by somebody distrusting a reading that looked fine. That is a
worse record than "we found nine bugs" sounds, and it is the reason this document leads with the
audit rather than closing with it.

### The ninth fault, characterised: every capture in this repo that waits is timing the renderer

The reading handed to me — the sim appearing to freeze at tick 8 — is an artefact, and the diagnosis
is `engine.js:153`:

```js
if (dt > 0.25) dt = TICK_DT;    // a backgrounded tab resumes; it does not fast-forward a backlog
```

That guard is **correct game code**. Under SwiftShader a 1600x900 frame costs more than 250 ms, so
the guard fires on *every* frame and the sim advances exactly one tick per rendered frame — about
1.4 ticks/sec against a nominal 60. Probed directly, same build, same seed, sampling `world.tick`
every 700 ms:

```
  iphone12   390x844     0 -> 7 -> 27 -> 47 -> 67 -> 87 -> 107 -> 127
  desktop   1600x900     0 -> 1 ->  2 ->  3 ->  4 ->  5 ->   6 ->   7
```

`fastForward(200)` returns 200 and moves the tick 8 -> 208 on both. Nothing is frozen. The phone
viewport is four times smaller, renders under the threshold, and runs normally — **the slower device
behaved and the faster one did not**, which is the signature to remember.

**Why this is a ledger entry and not a footnote.** It generalises past the one probe that found it:

> **Any measurement in this repository whose method is "wait N milliseconds and then look" is
> measuring the renderer's frame cost, not the game's clock.** On desktop capture that is a factor
> of roughly forty. Tick-driven capture (`fastForward`, the pinned settle) is unaffected.

Three families of capture in `shots/` wait: the walk scripts between taps, the VFX sheets between
frames, and every "settle for N ms" in the older tools. None of their published numbers are
withdrawn here — they were read as *pictures*, not as elapsed time — but any future claim of the
form "after two seconds of play" has to be re-expressed in ticks before it means anything, and the
one instrument that would have caught this class of fault earlier, a tick counter printed beside
every capture, still does not exist.

### And this round's own A/B, which produced one usable capture out of twelve and did not say so

The audit at the top of this round says the settle fix was applied behind a flag and A/B'd
interleaved against the stock meter. That is what was attempted. What is on disk is:

```
  shots/_noise-clockpose-grid-1.txt      851 bytes   a reading
  shots/_noise-clockpose-{grid-2..4, foundry-1..4, orbital-1..4}
                                         340 bytes each — page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE
```

**Eleven of the twelve corrected-meter runs errored, and the round wrote its audit as though they
had not.** The preview server the sweep was pointed at (`:4231`) went away after the first run and
every subsequent capture recorded the failure instead of a measurement. `shots/_noise.mjs` silently
reports `foundry: no captures` for a tag with four files in it, which is exactly the failure mode
this ledger keeps finding: **a tool that returns a clean-looking summary over missing data.**

This is mine and it is the reason the mass rule is re-run below from scratch rather than read back.
Two corrections went in with it: the sweep now pins the full base path (`/custom_robot/`, not the
bare root, which is a 302 the harness reports as a response-code failure), and it is genuinely
interleaved per repeat rather than per tag.

### The mass rule, re-run: both machines, all three arenas, corrected meter, noise floor first

`shots/_r12sweep.sh` (new, force-added) runs `shots/_massdrive.mjs` and `tools/mass.mjs` back to
back on each arena before advancing the repeat counter, three repeats, at `ebea06d`, one server, one
build. `_massdrive.mjs` is `tools/mass.mjs` with one line added inside the settle loop —
`g.view.update(1 / 60, 1, t)` — which is round 11's prescription and nothing else, so the pair is a
clean single-variable A/B out of one binary each.

**The floor first, because it is the only thing that licenses reading the deltas.** Round 11's five
identical runs of the stock meter at `84d5401`, re-summarised here across all three arenas rather
than the one that was published:

```
                     m51 range     curve range   largest range   top4 range   box
   grid   ROBOT 1   4.0 .. 4.5     4.2 .. 4.4      55.1 .. 65.1   88.0 .. 89.7  160x260/261
          ROBOT 2   5.3 .. 5.5     6.3 .. 6.5      40.0 .. 40.8   83.8 .. 85.2   39x76
   found. ROBOT 1   6.5 .. 7.5     7.2 .. 8.0      32.1 .. 46.0   76.0 .. 82.6   69x183..216
          ROBOT 2   5.0 .. 6.0     5.0 .. 5.6      53.5 .. 58.6   83.9 .. 85.5   38x42/43
   orbit. ROBOT 1   3.8 .. 4.0     4.4 .. 4.7      62.7 .. 63.1   86.9 .. 87.4  173x273/274
          ROBOT 2   5.5 .. 5.5     5.9 .. 6.0      56.4 .. 57.1   89.8 .. 90.2   37x66/67
```

**Foundry's player is the noisiest cell in the instrument by an order of magnitude** — a bounding box
that moves **33 px of height, 183 to 216, between identical runs**, `largest` swinging 13.9 points
and the curve mean swinging 0.8 masses. Everything else in the table is quiet. That is the unpinned
settle showing up exactly where round 12's first pass said the frame was unfit for a different
reason, and it means foundry's player is the one cell where **no** mass claim, favourable or not,
clears its own noise.

**And one figure this document has repeated for five rounds does not survive the re-summary.** Ranked
item 2 — *"91 / 129 / 142 levels of spread for the same player robot in grid / foundry / orbital;
the arena decides the machine"* — measured on the current meter reads:

```
   player value spread   grid 159    foundry 158..175    orbital 161..162 levels
```

**The arena no longer decides the machine's value spread.** Three arenas, one robot, 159 / 163 / 161
mean — a 4-level span where the quoted figure was a 51-level span. Ranked item 2's spread clause is
**CLOSED**, and it closed some rounds ago without anyone noticing, because the number kept being
quoted from `cc7cebb` instead of re-measured. The mass-count half of that item is settled below.
Note what is *not* being claimed: the spread is uniform at ~160 levels, which is high in absolute
terms; the reference machines are flat toys. Uniformity across arenas is the clause that closed. The
absolute figure is point 4 and stays open.

### The mass rule, re-run in all six cells on a meter that reproduces — and it holds

Three interleaved repeats per cell at `ebea06d`, one server, one build, `shots/_r12sweep.sh` running
`tools/mass.mjs` (stock) and `shots/_massdrive.mjs` (round 11's one-line settle fix and nothing else)
back to back before the repeat counter advances. Eighteen files, **eighteen readings, zero
`ERR_HTTP_RESPONSE_CODE_FAILURE`** — the failure that ate eleven of the previous sweep's twelve
captures does not recur, and the base-path fix is why.

```
                     STOCK METER (settle at dt=0)              CORRECTED (settle at 1/60)
                  m51       curve      largest    top4      m51      curve    largest   top4
  grid   ROBOT 1  4.0..4.5  4.3..4.4  55.1..65.1 88.1..89.8  4.8      5.3       59.4    85.8
         ROBOT 2  5.3       6.0..6.3  43.5..43.8 84.8..85.1  5.0      5.6       52.3    88.1
  found. ROBOT 1  6.8..7.5  7.5..8.1  40.3..44.6 77.1..81.7  5.3      6.1       45.2    84.4
         ROBOT 2  4.8..5.8  5.1..5.9  52.7..59.6 84.1..87.2  5.5      6.3       57.8    85.7
  orbit. ROBOT 1  3.5..4.3  4.4..4.7  62.5..63.1 86.9..87.1  4.0..4.5 4.3..4.5  64.7    86.8
         ROBOT 2  4.5..4.8  5.6..5.8  56.3..56.6 89.4..90.7  5.3..5.5 5.3..5.7  59.6    88.1
```

**Two results, and the second is what licenses the first.**

**1. The mass rule holds in all six cells.** Every one lands between **4.0 and 5.5 masses** at the
rule's own five-band step, with top-4 coverage of **84.4-88.4%** and a largest mass of **45-65%** of
the body. The eleven-mass machine this document has argued about since round 6 does not exist in any
arena, on either machine, on either meter. **The mass-count clause of points 3 and 4 is closed on
measurement.**

**2. The noise floor round 11 spent itself characterising was the unpinned settle, and fixing it
removes it.** Run-to-run spread of `m51` across three identical repeats, per cell:

```
   stock   0.5  0.0  0.7  1.0  0.8  0.3     mean 0.55 masses
   drive   0.0  0.0  0.0  0.0  0.5  0.2     mean 0.12 masses
```

Four of six cells return **identical mass counts three times running** on the corrected meter. And
the cell round 12 opened by condemning — foundry's player, whose bounding box moved **40 px of
height between identical runs** of the stock meter, 184 to 224 — returns **59x200 px, three times
out of three**. Instrument fault 6 is no longer a hypothesis: it was the entire noise floor, round
11's one-line prescription was right, and this is a single-variable A/B out of one binary each.

**What that does to this round's own opening finding, which was mine and is now withdrawn.** The top
of round 12 said foundry's player was *"a sliver, 69 px wide behind a pillar, and no mass count taken
there means anything"*, reported at 6.8-7.5 masses — the one cell out of the band. On the corrected
meter the same cell reads **5.3 masses, three times, with zero spread**. The occlusion is real: 59 px
wide against 156 in grid and 183 in orbital for the same machine, an aspect of 0.30 against 0.55 and
0.71. But the doctrine cuts the other way now. **Foundry's player passes the rule while being
measured on a third of itself**, which is a harder test than the other two cells face, not an easier
one. The exclusion is withdrawn and the cell counts.

**And one figure this document has quoted for five rounds does not survive the re-run.** Ranked item
2's spread clause — *"91 / 129 / 142 levels for the same player robot in grid / foundry / orbital;
the arena decides the machine"* — on the corrected meter reads **158 / 157 / 153**, with the opponent
at 128 / 125 / 128. A **five-level span where a fifty-one-level span was quoted**. The arena does not
decide the machine. **CLOSED**, and it closed some rounds ago without anyone noticing, because the
figure kept being re-quoted from `cc7cebb` instead of re-measured.

**Do not let the spread close point 4 by association, and do not let it re-open it either.** The
player still spans ~156 levels where round 7's no-paint control spanned 73-83, and this document has
treated spread as a proxy for fragmentation since round 6. That link is now measured on the same
frames and it is **false**: the same machine spans 156 levels *and* reads as 4.8 masses. A form with
a lit top and a dark side spans a lot of value and still reads as one form — which is what a CRV2
robot does too. **The spread proxy is retired.** Point 4 is scored on mass count and top-4 coverage,
which measure its claim directly rather than by correlation, and on those it passes.

**The caveat that keeps this from being a win, and it is ranked item 1.** *Four or five masses* has
never been measured on a Custom Robo V2 frame. It was written down in round 6 from memory, and every
number above is scored against it. What closed this round is that the machines now satisfy a target
this project invented and has never checked. That is worth much less than it reads, and it stays at
rank 1 of the list until one PNG lands in this repository.


### `#14` — the fit frame the entry was blocked on exists, and finding it turned up a bigger defect

Round 12 opened by condemning the pinned frame for grounding and saying no number could be quoted
until `shots/_ground.mjs --survey` named a tick that could carry one. It has now been run: grid, seed
1234567, ticks 300 to 900, step 20, 31 samples. A frame is FIT when **both** machines are grounded
**and** both have viewport under their ground contact point.

```
   tick |     ROBOT 1 (player)      |    ROBOT 2 (opponent)     | fit
        |  air  gnd   hPx   below   |  air  gnd   hPx   below   |
    300 |  0.00  Y    236    -66    | -2.54  -     75    790    |  -
    340 |  0.00  Y    219    -15    |  2.75  -     66    568    |  -
    380 |  0.00  Y    245    100    |  0.00  Y     83    459    | FIT
    420 |  1.12  -    180    -95    |  3.11  -     69    513    |  -     <- the pinned frame
    480 |  4.09  -     35   -135    |  0.00  Y     47    700    |  -
    540 |  0.00  Y    260   -249    |  1.67  -     58    650    |  -
    660 |  0.00  Y     47   -823    |  2.56  -     61    645    |  -
    880 |  0.00  Y    209     39    |  0.15  -     86    602    |  -
                                 (…31 rows, abridged; full table in
                                  `shots/_r12-ground-survey-grid.txt`)

  1 fit frame(s): 380
```

**Tick 380 is the only fit frame in thirty-one samples**, and the grounding meter is run there below.
That closes the procedural blocker on `#14`.

**But the column that matters is not the `fit` column, and nobody has been reading it.** `below` is
the pixels of viewport under the machine's ground contact point. For the player it is **negative in
twenty of thirty-one sampled ticks**, ranging to **-823 px** — nearly a full viewport height below
the bottom edge — and it is negative in eleven of the sixteen ticks where the player is *grounded*.
For the opponent it is never negative: 447 to 790 px, every sample.

> **Two thirds of the time, this game's camera crops the point where the player machine meets the
> floor out of the frame.** It is not a property of the pinned tick. It is a property of the camera.

That is a much larger finding than the entry it came from. Round 4 filed *"the player's feet end 1 px
from the bottom of the screen"* as a framing note and round 12 reassigned it to "the machine is in
the air"; **both were partly wrong**. The machine is sometimes in the air, and the camera crops its
contact anyway when it is not. A machine whose contact with the floor is off-screen for two thirds of
a fight cannot read as standing on anything, and no amount of shadow work under it will show. **This
is `#14`'s machine half, restated with an owner: it is a camera framing defect, not a shadow defect**,
and it is why eight rounds of shadow probes kept returning nothing.

### And with the fit frame in hand, `#14`'s machine half is measured — it passes

`shots/_ground.mjs --arena grid --ticks 380`. Both machines grounded, 99 px and 464 px of viewport
under their lowest vertices. The contact curve is deck luminance sampled outward from the machine's
footprint on non-machine pixels only: **a machine standing on a floor sits in a pool** — darkest
against the feet, recovering outward. A decal has a flat curve.

```
                     r    0.15  0.35   0.6   0.9   1.3   1.8   2.5   (footprint widths)
  ROBOT 1 (player)  val     49  82.5  92.8  91.6  86.3  82.8  75.5   pool depth 26.5
  ROBOT 2 (oppon.)  val   50.1  65.2  85.3  89.6  94.6 100.8    98   pool depth 47.9

  foot contour, bottom 18% of the box, 7x7 value step
  ROBOT 1   230 boundary px   invisible 1.7%   clean 79.6%   median 58.8
  ROBOT 2    58 boundary px   invisible 0.0%   clean 63.8%   median 57.2
```

**Both machines sit in a deep, tight pool and neither has feet that dissolve.** The player's deck
runs 49 against the feet and 92.8 two thirds of a footprint out — a **44-level** darkening at the
contact, radius under one footprint width, which is the shape a real contact makes and not the
four-footprint AO smudge this file's history caught once before. The opponent's is deeper still.
Round 5's *"96.2 against 97.3"* — a 1.1-level difference, quoted as proof of no pool — was measured on
the airborne frame, and it is the reading being replaced.

**The control, which is what makes this a result rather than a nicer number.** The same tool, same
arena, same build, same run of the harness, pointed at the frame every previous grounding claim was
made on:

```
                          tick 380 (fit)          tick 420 (the pinned frame)
  ROBOT 1  curve      49 -> 92.8 -> 75.5       83.6 -> 84.5 -> 82.8
           pool depth        26.5                       -0.8
  ROBOT 2  curve    50.1 -> 100.8 -> 98        52.1 -> 49.9 -> 50.7
           pool depth        47.9                       -1.4
```

**A flat curve on one tick and a 44-level pool on another, forty ticks apart, in the same build.**
That is not a marginal difference of opinion about a threshold; it is the difference between
photographing a contact and photographing empty air. Every "the machines are decals" reading in this
document reproduces exactly — at tick 420, and nowhere else.

> **`#14` machine grounding: the contact itself PASSES.** The machines are not decals. Eight rounds
> of "barely grounded" were an artefact of measuring a flying machine, and the entry is re-scored
> from NOT MEASURED to **PASS on contact, FAIL on framing** — the pool is correct and the camera
> crops it out of the frame for two thirds of the fight.

That is the second entry in three rounds where a long-standing FAIL turned out to be an artefact of
how it was measured rather than a property of the build, and it should be read the same way as the
first: as a reason to distrust this document's open items, not as a win. **Three of the five things
this review has spent the most rounds on — the impact effect, the mass count's named cause, and now
grounding — were mis-measured rather than broken.**

<!-- R12-GROUND -->

### The phone frame this round asked for was captured, and it is another READY card

Round 12's own text says of the round-11 phone captures: *"no art-direction claim can be made from
these frames without saying which frame it was made on, and the next round should capture a phone
frame with the card gone."* `shots/r12/gp-l-match.png` (2532x1170, 844x390 @3x) is that capture, and
read at 1:1 in two halves it is **the ROUND 1 READY card again** — same card, same scrim, same
chromatic-aberration title, drawn over the fight.

So the phone-side reading of blind point 1 still has no gameplay frame behind it, three rounds after
it was first asked for. What the frame does show, read rather than measured, is worse than the
number was:

- The single **brightest object in the entire frame is the floating thumbstick** — a white-cored
  blue orb roughly 90 px across at 3x, sitting on the deck, brighter than anything the game renders.
- **POD is a magenta ring, BOMB is an orange ring**, and they are the only two saturated hues on
  screen that are not the title card's aberration fringes.
- The opponent machine is at `1300,290` in that capture. Magnified 4x (`shots/r12b/gpl-mech.png`) it
  is a **~60x65 device-pixel blue-grey smudge, darker than the amber deck rail it is standing on**.
  At 1:1 it is not identifiable as a robot.

The scrim is the card's, so the last bullet is not a clean gameplay reading and is not scored as one
— but the first two are HUD chrome and are unaffected by the card. **On the device this game is
aimed at, the brightest thing on screen is a thumbstick and the most saturated thing is a button
that says POD.** That is round 4's inversion, alive, on the platform nobody had photographed.

### Foundry's salience sweep, the first one ever taken — and it moves the residual off the gate

The verdict below closes its methodological ruling on a specific piece of evidence: *"Round 12's own
salience sweep is the proof that this is still live: it ran grid, it ran orbital, and
`shots/_r12-sal-foundry.txt` does not exist."* It exists now, and this is the first time in twelve
rounds that the arena this document calls the worst in the game has been put through the meter the
two standing stage residuals are argued on.

**The result is decisive, it is the worst single reading this review has ever taken, and it is not
the result either the residual or my own draft of this section predicted.**

**1. Foundry is the arena where the machines lose by seventy ranks.** The meter's headline is *the
best rank any tile that is at least half machine can achieve*, out of the whole frame's tiles:

```
  ATTENTION — foundry @ tier 3, tick 420, 1600x900
  best rank of a >=50%-machine tile
   T  off  total       A          B          C
  32    0   1400     102         58         38
  32   16   1323     199        118         24
  40    0    880      70         40         21
  40   20    858     271        209         67
  48    0    594     119         74         22
  48   24    576     143         87         16
  64    0    350       -          -          -
  64   32    312      16          6          3
```

**At T=64 offset 0 there is no tile anywhere in the frame that is half machine.** The dash is not a
missing reading; it is the meter reporting that the subject of the game does not fill half of one
64 px tile. In the cell the document usually quotes — model A, T=40, offset 0 — the best a machine can
do is **rank 70 of 880**. The top twenty tiles at that setting are 12%, 1%, 0%, 0%, 0%, 28%, 0%, 0%,
0%, 0%, 0%, 48%, then 0% for the rest: **not one machine-majority tile in the top twenty.**

For scale, the same tool on orbital returns **rank 1 in seven of its eight cells.** Same build, same
machines, same meter. Foundry is not "the worst arena" by a margin you argue about.

**2. My own draft of this paragraph said the opposite, and correcting it is the finding.** The only
foundry salience run that existed before today was an untracked luminance-only sweep from 22 August;
it put **rank 1 at 64.5% machine** and I wrote that up as foundry inverting grid's rank story. The
tracked meter, which weights luminance by chroma, puts the best machine-majority tile at **rank 70**.
Same arena, same build, two tools, a seventy-rank disagreement, and both are correct about their own
metric — a machine that is bright and grey loses to a stage that is dimmer and coloured.

> **This document has quoted "the salience sweep" since round 6 without ever naming which model it
> means.** Point 2's FAIL, point 1's chroma FAIL, the gate's "ranks 1 through 8", and the round-8
> figure re-derived in round 12 are all "the salience sweep". There are three models in the tracked
> tool and at least two more tools in the scratch directory, and on foundry they disagree by seventy
> ranks. **Every rank quoted in this file before this line is unattributed and should be read as
> such.** That is instrument fault 10, it is mine, and it was caught by writing a wrong sentence and
> then running the tool.

**3. The colour half, which reproduces and which is the one number here that was not a surprise.**
Foundry: cyan 0%, **amber 5.4% of the frame at saturation 0.803**, machines 0.5% at saturation 0.338;
and of the frame's brightest 1%, **amber owns 50.9% against the machines' 16.7%.** Round 8's figure
for the same cell was 17.3%. The instrument reproduces to within a rounding step across five rounds
and two rebuilds, which is what makes the seventy-rank disagreement above a naming failure rather than
a broken meter.

**4. The knockout attribution, which is what moves the residual off the gate.** From the 22 August
element knockout — the only one ever taken on foundry:

```
  element        cov%   meanAbs   mean+   peak+   owns% of top-1%
  walls          18.3     62.8   -19.2   172.5    56.8
  key            72.4     71.9      21   118.4      49
  practicals      3.6     98.6    30.3   115.4    29.6
  gatelight       1.5     83.2    11.9   102.6    12.7
  riglights      24.2     78.8     4.8    27.8    11.8
  hazard          1.9     76.5     8.2   124.9     9.6
  floor          19.6     80.8    15.9   105.4     4.5
  obstacles      41.1     62.9   -16.1    73.9     3.2
  architecture    9.8     55.6   -26.4    47.6     0.1
```

`gatelight` is **1.5% of the frame and appears in exactly one of the twelve top tiles** (rank 4,
`+8.0`). `key` — the arena key light — is in **all twelve of them**, contributing `+14.2` to `+32.7`,
covering 72.4% of the frame and owning **49.0% of its brightest 1%**. The walls it lands on own
**56.8%**.

> **The residual is not a prop. It is the key light, and the gate is a thing the key light happens to
> be shining on.** Five rounds of "the warm lit gate" have been an entry filed against the brightest
> *object* in a frame whose brightness is set somewhere else entirely. That is why it kept flipping
> between closed and open: you can dim a gate, re-measure, and watch the number move by the 1.5% the
> gate is worth, while the 49% term sits untouched and the rank ordering comes back.

This also finally reconciles point 2 with point 4, which have been argued as separate defects for six
rounds. Round 12's own account of point 4 says the machines' value spread is *"91 levels in grid, 129
in foundry and 142 in orbital"* for the same machine with the same paint, and calls that proof it is
*"the light we put on them"*. It is the same light. **One key light is fragmenting the machines and
out-ranking them at the same time, and the review has been billing it as two defects with two
owners.**

**Where this number came from, which is the part that should be embarrassing.** The element
attribution above is dated **22 August** — round 8's era — and it was produced by a `salience.mjs`
that has only ever existed in a scratch directory and is not in the tree. It has never been quoted in
this file. So the measurement that moves the largest open art defect off its named subject **was
taken five rounds ago and never reached the ledger, because the tool that took it evaporated.** The
force-add of `shots/_sal.mjs` and `shots/_salience.mjs` in round 12 was the right instinct and it was
five rounds late. That is instrument fault 10 in substance if not in form: *a finding is only as
durable as the tool that produced it*, and this project has lost at least one decisive one that way.

### The LOD probe returns a reading, for the first time, and the reading is that the LOD is not firing

Instrument fault 7 is that `shots/_lodprobe.mjs` never returned a reading at all, so every claim in
this document about the silhouette LOD was made without a working probe. It returns now, in all three
arenas, and it says the LOD is doing essentially nothing to the machine the LOD exists for:

```
  ROBOT 2 (opponent), minPx2 as built = 2
    grid      on-screen 100.2px   219/224 primitives drawn   dropped 5   (2.2%)
    foundry   on-screen 102.5px   219/224 primitives drawn   dropped 5   (2.2%)
    orbital   on-screen  91.7px   213/224 primitives drawn   dropped 11  (4.9%)
  ROBOT 1 (player)      all three arenas   236/236 drawn     dropped 0   (0.0%)
```

**At 92-103 px tall the opponent is still drawing 95-98% of its primitives.** The verdict's rank-2
prescription — *"a silhouette LOD ... merge plates and drop greebles under a pixel threshold ... the
second-largest term, and the only one of the three that is free at runtime"* — has been written as if
the mechanism did not exist. It exists, it is built, its threshold is `minPx2 = 2`, and at that
threshold it drops five boxes out of two hundred and twenty-four. The `--lodoff`/`--lod16` A/B in
`shots/_ab13-foundry-lod*.txt` confirms the size of it from the other side: moving `minPx2` from 0 to
16 moves the opponent's five-band mass count from 4.0 to 5.5 — **in the wrong direction**, and by less
than the meter's own noise floor in either case.

So the LOD entry is re-scored. It is not "not built" and it is not "the second-largest term". It is
**built, firing, and mistuned by roughly an order of magnitude**, and until somebody runs the
threshold sweep nobody knows whether the term is large at all. The prescription that has sat at rank 2
of the verdict for two rounds was never checked against the code it prescribes.

### Foundry has a fit frame, it is not the one every foundry number in this file was taken on

Round 12 established that grid's pinned tick-420 frame has the player 1.12 m airborne, found grid's
fit frame at tick 380, and re-scored `#14` on it. **The same sweep was run on foundry and the answer
was never carried across.** `shots/surv-foundry.txt` sweeps ticks 300-900:

```
   tick |        ROBOT 1 (player)        |       ROBOT 2 (opponent)      | fit
    420 |  2.52  -  0.38   149   -130    |  0.07  -   0.9    73    470   |   -
    760 |  0.00  Y  0.92   244    107    |  0.00  Y  0.92    86    456   | FIT
    780 |  0.00  Y  0.92   223    126    |  0.00  Y  0.92    73    465   | FIT
    800 |  0.00  Y  0.92   216    133    |  0.00  Y  0.92    70    467   | FIT
  3 fit frame(s): 760, 780, 800
```

**At tick 420 — the frame every foundry measurement in this document is taken on — the player is 2.52
metres in the air with its contact point 130 px below the bottom of the viewport, and it spans 149 px.
At tick 760 it is on the ground, in frame, and spans 244 px.** The opponent goes 73 px to 86 px.

That invalidates, in foundry, the same class of readings round 12 invalidated in grid, and it does it
to the numbers this document leans on hardest:

- *"the player is 69 px wide behind a pillar, aspect 0.30, so the mass rule cannot be applied in
  foundry"* — measured at 420. The 69 px is a **quarter of a machine seen edge-on while airborne**,
  not a machine behind a pillar. The claim that foundry's cell is unmeasurable, and round 12's
  withdrawal of that claim, are **both** arguing about an artefact.
- *"the opponent is 4.8% of frame height with 26.1% of its contour invisible"* — the headline number
  behind rank 3 of the verdict — is measured at 420, where the opponent is 73 px. At 760 it is 86 px.
  The direction of the defect probably survives; **its magnitude is not a measured quantity.**

`#14`'s foundry half therefore does not close and does not fail. It is **NOT MEASURED**, on exactly
the grounds round 12 used for grid, and the fit frame it needs is tick 760 and has been sitting in
`shots/surv-foundry.txt` unread.

### The ruling, entered in the ledger rather than only in the verdict

The verdict below rules that reviewing one arena and generalising is this review's own methodological
flaw, and re-scores four entries to **FIXED (grid); UNVERIFIED elsewhere**. That ruling was written in
the verdict and never applied to the ledger, which is the half that anyone fixing a defect actually
reads. It is applied now, in the ledger, at `#2`, `#12`, `#13` and `#14`. Three additions the verdict
did not make:

1. **`#14` gains a third state.** Grid: PASS on contact, FAIL on framing (round 12, tick 380).
   Foundry: **NOT MEASURED** — no fit frame has ever been used, and one exists at tick 760. Orbital:
   **NOT MEASURED** — the sweep has not been run there at all.
2. **Point 2's two residuals are re-filed against the key light**, not against the gate and not against
   the rail. The gate and the rail stay in the ledger as *symptoms with measured sizes* — 12.7% and
   3.4% — under one parent entry whose subject is the light rig. A residual filed against the wrong
   object cannot be closed by anyone, which is the observed behaviour for five rounds.
3. **The rule is written down as a gate on closure, not as a note.** No entry in this ledger closes on
   one arena. An entry closed on one arena is marked with the arena. Every meter in this tree defaults
   to `--arena grid` and will keep doing so, so the discipline has to live in the ledger, not in the
   tools.


### The mass rule, re-read rather than re-run — and the six-cell result is not what the verdict says it is

This round's brief was to re-run the mass rule on both machines in all three arenas, on the corrected
meter, with the noise floor established first. That work was done and the files are in the tree. **The
finding is that nobody read them.** The verdict written above says the answer came back *"in our
favour, in all six cells"* at *"4.0 to 5.5 masses"*; the run set it cites says otherwise, and it said
otherwise before the sentence was written. The full table, from
`shots/_noise-base-<arena>-{1..4}.txt` (28 August 19:06-19:48), four repeats per cell:

```
  cell          run1  run2  run3  run4    spread   top4 range     largest mass
  grid    R1     4.0   4.5   4.3   4.0      0.5    88.0 - 89.7    55.1 - 65.1
  grid    R2     5.5   5.3   5.3   5.5      0.2    83.8 - 85.2    40.0 - 40.8
  foundry R1     6.5   7.5   6.5   7.5      1.0    76.0 - 82.6    32.1 - 46.0     <-- FAILS
  foundry R2     5.3   5.3   5.0   6.0      1.0    83.9 - 85.5    53.5 - 58.6
  orbital R1     3.8   4.0   3.8   3.8      0.2    86.9 - 87.4    62.7 - 63.1
  orbital R2     5.5   5.5   5.5   5.5      0.0    89.8 - 90.2    56.4 - 57.1
```

Re-run at head three more times (`shots/_noise-b1-*`, 29 August 05:19-05:38) it reproduces cell for
cell: grid **4.3 / 4.3 / 3.8** and **5.3 / 5.3 / 5.0**; foundry **7.3 / 7.5 / 7.5** and
**5.0 / 5.5 / 5.5**; orbital **3.5 / 3.5 / 3.8** and **4.8 / 4.5 / 4.8**. Two independent capture
sessions, seven repeats, one build: foundry's player is between 6.5 and 7.5 masses every single time.

**So the honest score is three states, not one:**

- **Three cells pass** — grid's player at 4.0-4.5, grid's opponent at 5.0-5.5, foundry's opponent at
  5.0-6.0. Four or five masses, top-4 above 83%, exactly what the rule asks for.
- **Two cells under-read** — orbital's player at 3.5-4.0 and grid's player on one run at 3.8. At the
  five-band step the meter is merging the machine into fewer parts than the reference has. That is a
  better failure than fragmenting and it is still not "four or five"; it also means the top of grid's
  range and the bottom of orbital's are the *meter* moving, not the machine.
- **One cell fails, and it fails on every column** — foundry's player, at 6.5-7.5 masses, top-4
  75.8-82.6% against every other cell's 83.8-90.6%, and a largest mass of 32.1% where the reference
  wants one shape carrying half the body.

**Round 6's named cause is genuinely smaller.** Eleven masses is gone; nothing in the table reads
above 7.5. That is a real improvement and the lighting work earned it. **What is not true is that it
closed.** Points 3 and 4 do not close, and the reason they were reported closed is the same
one-arena-and-generalise habit this round rules on: five cells passed, and the sixth was not looked
at before the sentence was written.

**And the failing cell is the untrustworthy one.** Foundry's tick 420 is airborne — 149 px of a 1.7 m
reference against 244 px on the ground at the fit tick 760 — and read at 1:1 the player there is
bisected by a translucent red boundary plane that tints its far half. A machine cut in half by a
coloured transparent slab will fragment under any mass meter ever written. **The single cell that
fails the project's headline art rule is measured on a frame no meter in this tree should be pointed
at**, and the correct response is not to argue about 7.5; it is to re-measure at 760.

### The landscape garage rail — verified, and the commit's last sentence is the one that does not hold

`1577b98` claims three things. Two of them hold and the third does not.

**Holds: all seven rail controls are reachable at 844x390 with an iPhone 12's landscape insets.**
Re-measured at head with `shots/_r13-garage.mjs` and photographed at the bottom of the screen's 466 px
of scroll (`shots/r14L-03-garage-bottom.png`, read at 1:1). BODY / GUN / BOMB / POD / LEGS / P1 / P2
are all on-screen, unclipped and hittable, at rest and at full scroll. The sticky rail works. This was
the blocker and it is closed.

**Holds: the 283x287 hole is gone.** The panel geometry at head is
`rail 168x231 / list 283x428 / stage 247x300 / info 540x297`, with `.garage__info` spanning columns 2
to -1 in row 2 and **EMPTY BELOW 0**. The spec sheet went sideways exactly as described and row 1 is
untouched, so the preview keeps its box.

**Does not hold: *"nothing on the screen has a hole under it."*** That sentence was written from a DOM
panel measurement, and a DOM panel measurement cannot see a hole *inside* a panel — a 540 px-wide
spec sheet whose content fills its left half has no empty grid cell and still photographs as a void.
Measured on the photograph instead (`shots/_r12-void.mjs`, force-added: quantise to cells, a cell is
empty if every pixel is within tolerance of the region's modal colour, then the largest all-empty
rectangle):

```
  spec sheet, left half    83.6% background   largest empty rect  162x78  CSS
  spec sheet, right half   90.7% background   largest empty rect  168x138 CSS
```

**The hole moved from beside the panel to inside it.** It got much smaller — 283x287 to 168x138 is a
71% reduction in area and the fix is a real one — but the screen still carries a contiguous void a
sixth of the viewport wide, and it is in the right-hand column because `VS EQUIPPED` has two stats
where the left column has three. Filing this as MINOR and not as a regression: the blocker closed, the
cosmetic residual is smaller than the one it replaced, and the only thing wrong is the claim.

**The instrument note, which is the transferable part.** `_r13-garage.mjs` measures boxes and
`_r12-void.mjs` measures pixels, and on this screen they disagree: one says EMPTY BELOW 0 and the
other says 168x138. Neither is wrong. **A layout tool cannot close a layout defect on its own** —
this is the same shape as `N8` ("a fix verified on desktop is not a fix") and the same shape as the
arena ruling, and it is the third instance this round of *verifying on the instrument that cannot see
the failure mode.*

**And the same failure shape is now confirmed on the other half of the project.** `N8`'s finding is
that a fix verified on desktop is not a fix — the landscape garage rail was verified, shipped, and
was still unreachable on a 844x390 phone. That is not a coincidence with the arena finding; it is one
statement about method with two instances:

> **This review verifies on the default and generalises to the set.** Default arena, default viewport.
> Twelve rounds of numbers, one arena in three and one form factor in two. The correct reading of
> round 12 is not that the build is worse than we thought — the mass rule closed in all six cells — but
> that **this document's confidence interval has always been narrower than its evidence.**


### The instrument audit, first, because this round it invalidates the measurement it was meant to precede

*(This subsection and everything below it to the round-10 heading is **round 11's** section. It was
committed without a `## Round 11` heading, so the file read as though round 12 ran for 450 lines; the
heading below is added, and nothing in the text is changed.)*

## Round 11 (opens at `84d5401`) — the noise floor, and the settle that was never pinned

### The instrument audit, first, because this round it invalidates the measurement it was meant to precede

Round 10 found `tools/mass.mjs` returning a machine whose bounding box changed shape between two runs
of a pinned frame, named the cause as the effect clock advancing during boot, and fixed it by pinning
`engine.clock.elapsed` to 1000 in both meters. I was asked to verify that independently. **It does not
hold.** Three identical runs of `tools/mass.mjs` at `84d5401` — same server, same seed, same tick
count, same settle, nothing changed between them but the wall clock:

```
  orbital        ROBOT 1 box        R1 @51 largest   R1 mean   ROBOT 2 box       R2 @51   R2 mean
  run 1        173x273 at 719,608       62.7%          4.5     37x67 at 795,247   5.0       5.8
  run 2        173x274 at 719,607       56.2%          4.3     37x66 at 795,248   5.3       6.2
  run 3        171x276 at 720,605       63.1%          4.4     34x64 at 795,249   4.8       5.6
```

**The same symptom round 10 reported, at the same pixel, after the fix for it** — 37x67 at y=247 one
run and 37x66 at y=248 the next is the identical signature quoted in round 10's audit — **and run 3
is worse than anything round 10 saw.** The opponent came back **34x64 where the other two runs said
37x67 and 37x66**: three pixels of width on a 37-pixel machine, an 8% change in the thing being
measured, between two runs of a frame this document calls pinned. The pin did not close it.

**Why the pin could not have closed it, and it is not the reason the fix's own comment gives.** The
mechanism is in the *settle*, which both meters share verbatim:

```js
for (let i = 0; i < n; i++) {
  const views = g.view.prepare(1);
  g.rig.update(g.world, views, g.localIndex, 1 / 60, t);   // camera: 240 steps at a fixed dt
  t += 1 / 60;
}
g.view.update(0, 1, t);                                     // machines: ONE step, at dt = 0
```

The settle drives the **camera** 240 times at a fixed `dt` and the **machines** once, at `dt = 0`.
Every pose term in `RoboModel.update` is `damp(current, target, k, dt)` — `lean`, `bank`, `fAir`,
`fMove`, `fDash`, `heat`, and each of the thirty-odd bone rotations, plus two integrators
(`spinAngle += spinRate * dt`, `to.rotation.y += dt * (…)`). At `dt = 0` a damper does not move.
**So the machine's pose at the shutter is not a function of the pinned frame at all — it is the
low-pass residue of however many wall-clock render frames the browser managed between boot and the
settle**, which is exactly the quantity the pin was supposed to remove. `clock.elapsed` only ever fed
the terms written as functions of `time`; it was never in the dampers' path.

**A builder is fixing this concurrently, on one term, and the arithmetic in its own comment shows one
term is not enough.** `7e9d801` and the working tree at `robot.js` convert `this.breathe` from a
`dt`-accumulator to `time * 2.2` — correct, and it is a genuine carrier. But the comment reports the
swing it is closing as *"the near robot's bounding box came back 260, 261 and 264 px tall"*. The bob
that change removes is `Math.sin(breathe) * 0.008 * 0.35` — a peak-to-peak root-Y travel of **5.6 mm**.
At the near robot's scale (173 px across a 2.3 m machine, ~75 px/m) that is **0.4 px**, and it cannot
produce a 4 px swing. It is a purely *vertical* term, so it cannot produce a horizontal change at
all — and run 3 above lost **3 px of the opponent's width**. It accounts for the ±1 px of height and
for nothing else. **The dampers are the rest of it, and they are untouched by that commit.**

### The noise floor itself, which is the number this round exists to produce

Five identical runs per arena, serially, one meter, one server, one build at `84d5401`. Mean, the
observed range, and `r` = the width of that range — which is the quantity every delta in this
document has to be bigger than before it is a result.

```
  ORBITAL, n=5
                      mean      observed range    r
    ROBOT 1  boxes 173x273 173x274 171x276 173x277 173x273
             m51      3.84       3.5 .. 4.3      0.8
             curve    4.44       4.3 .. 4.7      0.4
             largest 61.6%      56.2 .. 63.2     7.0
             top4    87.1%      86.6 .. 87.6     1.0
    ROBOT 2  boxes  37x67  37x66  34x64  37x66  37x67
             m51      5.08       4.8 .. 5.3      0.5
             curve    5.92       5.6 .. 6.2      0.6
             largest 56.7%      54.8 .. 57.9     3.1
             top4    90.3%      89.5 .. 90.9     1.4
```

**The floor is the same size as every effect this document has credited.** Round 10's A/B deltas were
0.4 to 0.8 curve-mean masses; the curve mean's own run-to-run range on an unchanged build is 0.4 on
the player and 0.6 on the opponent. The largest-mass figure, which the blind comparison's point 4
leans on, ranges **7.0 percentage points** on the player between two runs of the same binary.

**And the reading I was asked to check is the most flattering draw in its own set.** The credit
carried into this round was *orbital's opponent at 5.3 masses, largest 57.1%, top4 91.4%*. Against
five runs: 5.3 is the **maximum** of the observed 4.8..5.3; 57.1% sits inside 54.8..57.9; and
**91.4% top4 is outside the five-run range entirely**, above a maximum of 90.9. That is not a
measurement that reproduces. It is one draw, and it is the best one.

### Verdict on the instrument: `mass.mjs` and `contour.mjs` are not pinned, and the fix is one line

The settle has to drive the machines the way it already drives the camera:

```js
g.rig.update(g.world, views, g.localIndex, 1 / 60, t);
g.view.update(1 / 60, 1, t);      // <- the missing line
```

240 driven steps at k = 6..26 converges every damper in the model to the pinned frame's targets, and
the pose stops being a function of the machine's load. **This is the sixth instrument fault, it is
the fifth one re-opened rather than a new one, and it is the third consecutive round in which the
number the art verdict turns on came from a meter that was not measuring what it said.**

### The iPhone 12's real insets — the entry that has been open since round 7, and it half closes

This is the first round in which the layout was measured on the device the game is aimed at, and the
work is good. I verified it independently rather than reading the log: taking the four forced values
and the stylesheet's own arithmetic, with no reference to the capture,

```
                          rule in ui.css                        predicted   logged
  portrait 390x844, --safe-t 47 --safe-b 34
    .hud__top     top    calc(8px  + var(--safe-t))                  55       55
                  left   calc(10px + var(--safe-l))                  10       10
                  right  390 - (10 + var(--safe-r))                 380      380
    .hud__gear    top    calc(78px + var(--safe-t))                 125      125
    .tc__pause    top    calc(84px + var(--safe-t))                 131      131
    .hud__scrim   height calc(158px + var(--safe-t))                205      205
  landscape 844x390, --safe-l/r 47 --safe-b 21
    .hud__top     left   calc(20px + var(--safe-l))                   67       67
                  right  844 - (68 + var(--safe-r))                  729      729
    .crv2-touch-on .hud__gear  top calc(104px + var(--safe-t))       104      104
    .hud__scrim   height calc(130px + var(--safe-t))                 130      130
    .tc__pause    top 6, right 844 - (10 + var(--safe-r))          6/787    6/787
```

**Every one of the eleven reproduces.** The in-match HUD is clear of both reserved bands in both
orientations, and the landscape figures had never been taken in ten rounds. That half of the entry
is **closed**.

**One correction to the claim as written.** *"The only rect that enters a reserved band is the
floating stick while a thumb is down"* is not what the logs say. `.hud__scrim` enters the notch band
by 47px in portrait and both side bands by 47px in landscape, in the tool's own output, on both
runs. It is correct that it should — the stylesheet says so at line 77, *"`.hud__scrim` is full-bleed
by design"* — but a document whose whole method is that claims are exact should not carry an absolute
that its own instrument contradicts. The accurate sentence is: the only *control* that enters a band
is the floating stick, and it follows the finger.

**The other half does not close, and the reason is that the entry was never about the HUD.** N8 is
about *every screen*. `_hudinset.mjs` measures the in-match HUD only; the screen walk is
`_r10-walk.mjs`, and re-run at head in landscape (`r11L-log.txt`) it still reports:

```
  09-settings   844x390, insets 47/47/21, at rest (scrollTop 0 of 150)
    opt "SENSITIVITY"    [63,295,411,345]   NOT-HITTABLE      centre under the sticky footer
    opt "INVERT Y"       [63,351,411,401]   OFF-SCREEN
    opt "TOUCH LAYOUT"   [63,407,411,464]   OFF-SCREEN NOT-HITTABLE
  03-garage     every category screen, at rest
    row "NOCTURNE" / "TEMPEST"  [241,283,524,336]  NOT-HITTABLE
```

`L1-09-settings.png` photographs it: the word SENSITIVITY is **cut through the middle of its own
glyphs** by the footer bar's top edge, with two more options entirely under it. This is round 9's
defect — *"two of the five difficulty levels painted under the footer bar"* — in a third place.

**What `84d5401` did fix, and it is real.** The landscape garage's `P1`/`P2` switch was under the bar
and is not any more; the two-column rail is the right answer and the walk now taps both. The commit
found that with a walk artefact, which is exactly what N8 asked for. **N8's recommendation is being
followed.** It is the one process item in this document that has gone from filed to practised inside
one round.

**But the walk overstates two of its own findings, and the next round should not quote them raw.**

1. **It hit-tests the centre of the element's full rect.** For anything half under a sticky bar that
   returns NOT-HITTABLE while 20px of the control is exposed and tappable — `SENSITIVITY` shows
   295..315 above a footer whose box starts at ~315. The defect is real and it is narrower than the
   label: the control's *natural* tap point misses, not the control.
2. **It swipes to the extreme and re-tests there.** Every `STILL UNREACHABLE` line in `r11L-log.txt`
   reports a rect at a *negative* y — the walk scrolled the element off the top and then declared it
   unreachable. Settings scrolls 150px and all three options clear the bar at 150; the garage scrolls
   485 and its presets clear it well before that. **Nothing in the landscape menus is unreachable.**
   What is true, and is the defect the landscape block was written to end, is that at rest the screen
   does not say it continues.

**Ruling: the iPhone entry closes on the in-match HUD in both orientations and stays open on the
menus, with its severity reduced from "controls a player cannot reach" to "controls a player is not
told are there".** That is a real improvement and it is not a close.


## Round 10 (opens at `8b3208e`) — the mass rule, re-run on the corrected meter, and the number the whole prescription was written against turns out not to exist

### The A/B, and it is as clean as this project has ever managed

`8b3208e` is the first commit to carry any of my three-item prescription. It is one file. Against
round 9's opening sha the entire diff is:

```
  src/gfx/materials.js   the size-gated rim   <- the measurement below is of this
  src/ui/menus.js        phone menu text      <- DOM is hidden before the shutter
  src/ui/ui.css          phone layout         <- ditto
```

So A = `0594eb2` and B = `8b3208e`, both built from `git archive`, both served by `vite preview`,
measured with **one** copy of `tools/mass.mjs` (the corrected meter — absolute-step curve, four
quantisation phases, shell event channels suppressed) pointed at each in turn. Nothing in the 3D
path differs but the rim.

The change itself: the shell's fresnel band is now a function of the machine's on-screen size,
computed per-fragment off the perspective divide. Near, the band stays wide and shades the outer
third of every plate. Far, it narrows to hug the last few degrees before the silhouette and is
brightened by 1.45 to pay for the pixels it gave up. The stated reasoning is that the fresnel term
cannot tell a silhouette from an interior chamfer, so on a 39px machine thirty interior chamfers
arrive as a field of detached bright islands — which is precisely what a mass meter counts.

**Curve-mean masses, and `spread` (the body's own p2..p98) beside it, because a count without the
value range is the number you fake:**

```
                        A (0594eb2)          B (8b3208e)           delta
  grid     R1 near     4.3  spread 151      4.2  spread 151       -0.1    0
           R2 far      6.5  spread 149      6.0  spread 142       -0.5   -7
  foundry  R1 near     7.5  spread 151      7.7  spread 151       +0.2    0
           R2 far      5.3  spread 125      4.9  spread 117       -0.4   -8
  orbital  R1 near     4.5  spread 159      4.6  spread 159       +0.1    0
           R2 far      6.0  spread 139      5.2  spread 110       -0.8  -29
```

And the honest column round 8 made me promise never to drop — top-4 coverage at the five-band step,
with the largest single mass beside it:

```
                     A top4%  largest      B top4%  largest
  grid     R2 far      83.6    41.6%        87.7    44.1%
  foundry  R2 far      85.2    56.0%        87.5    59.1%
  orbital  R2 far      89.2    52.3%        94.1    67.1%
  foundry  R1 near     80.6    41.3%        76.9    37.2%   <- the one that moved the wrong way
```

**It does exactly what it was aimed at and nothing else.** Every near-machine reading is flat to
within a tenth of a mass; every far-machine reading improves; the far machine's four largest pieces
now cover 88-94% of it where they covered 84-89%. Orbital's opponent went from six pieces spanning
139 levels to five spanning 110. That is a machine getting simpler, not a machine getting darker —
the median moved 93 to 89, four levels, so nothing was bought by crushing the body into one band.

**The one regression is foundry's near machine**, which lost 3.7 points of top-4 coverage and gained
0.2 masses. Foundry's player photographs at 189px of a 900px frame — 21% — and the gate fades between
9% and 22%, so it is the one machine in the game that stands *inside* the transition. It is getting
a partly-narrowed band with a partly-applied gain, which is the worst of both. Moving `uRimSizeHi`
above 0.30 would put every near machine on the near band and cost nothing, and it is a one-number
change.

### The control that had to come first, and this time it came first

Round 7's lesson was that a prescription must be preceded by the experiment that could rule it out.
So before believing any row above: **the same measurement was taken again inside B's own binary,
with the new feature switched off through its own uniforms** (`--u rimSizeLo=-2,rimSizeHi=-1`, which
forces the size gate to 1 everywhere and reduces the new code exactly to the old code). One binary,
one server, one meter, one flag:

```
                   A (old binary)   B, feature OFF   B, feature ON
  grid     R2         6.5 / 149        6.3 / 149        6.0 / 142
  foundry  R2         5.3 / 125        5.1 / 126        4.9 / 117
  orbital  R2         6.0 / 139        5.9 / 138        5.2 / 110
```

**B-with-the-feature-off reproduces A to within 0.2 masses and 1 level of spread in all three
arenas.** The A/B is therefore measuring the rim and not the build, the server, or the day.

### And the instrument audit, which found a fault, as it now does every round

`tools/mass.mjs` is not deterministic, and the claim at the top of this document that all four
capture tools are has been false for this one the whole time. Two runs, same server, same seed, same
tick count, same settle, nothing else on the machine:

```
  orbital R2   run 1:  37x66px at 795,248   curve mean 5.2   spread 110
               run 2:  37x67px at 795,247   curve mean 5.4   spread 112
```

**The machine moved a pixel between two runs of a pinned frame.** That is not rasteriser noise — a
bounding box changing shape is a pose change. It is **N5**, which this document filed in round 4
against the *fight* capture path and has never re-tested here: the render clock advances on wall
time during the settle window, so the number of pre-settle frames — and with it the phase of every
animation the settle does not reset — depends on how busy the machine was.

That matters because the deltas being claimed above are 0.4 to 0.8. A 0.2 single-sample swing is
between a quarter and half of the effect. **Every mass claim in rounds 5 through 9 was quoted to a
precision this path cannot deliver**, mine included. The noise band is measured below.


## Round 9 (opens at `0594eb2`) — `#14` closes on one half and is re-opened on the other, and the phone stops being three incidents

### `#14` cast shadows — the fix is real, it is large, and the story written around it is wrong

Round 8 left `#14` with a stage agent mid-investigation, reporting "the fix is real but it has a
cost" before being cut off. Both clauses needed checking. The fix landed inside `0594eb2` itself, as
`Stage._configureShadow`, and the comment above it gives this account: an `OrthographicCamera` bakes
its extents into its projection matrix, `DirectionalLightShadow.updateMatrices()` never calls
`updateProjectionMatrix()`, so every extent the source set was written to a field nobody read and the
arena rendered its shadow map through the constructor default `(-5, 5, 5, -5, 0.5, 500)` — a 10 m box
in a 32 m arena.

**The mechanism is correct and the fix works.** Probed at head, the extents the source sets and the
extents actually encoded in the projection matrix now agree at ±18.4. Knocking each caster out in
turn and diffing (`r8cast.mjs`, settled frame, VFX off, DOM hidden, tier 3):

```
  what vanishes when this stops casting     cov% of frame   mean lift   peak   bbox
  grid     key light (all cast shadows)         3.07%          25.3     81.2   88,185 .. 1216,899
           obstacles only                       2.78%          26.5     81.2   88,191 .. 1216,796
           machines only                        0.29%          13.5     77.9   546,185 .. 867,899
  foundry  key light                            4.45%          22.3     86.5   438,156 .. 1599,899
           obstacles only                       3.74%          22.0     86.5   438,156 .. 1599,899
           machines only                        0.45%          21.8     76.0   508,358 .. 808,845
  orbital  key light                            6.54%          25.8    112.5   361,252 .. 1599,899
           obstacles only                       6.35%          26.2    112.5   361,406 .. 1599,899
           machines only                        0.20%          16.1    102.3   751,252 .. 973,879
```

`r9-obst-grid.png` is the obstacle-only difference, and it is unambiguous: hard-edged slabs of shadow
lying across the deck in clear block shapes, with the deck's own plate seams still legible inside
them. **The obstacle half of `#14` is closed on measurement and on the photograph.** Blocks account
for 90% / 84% / 97% of every cast-shadow pixel in the frame.

*(Instrument note: `r8cast.mjs`' fourth knockout, `noArchCast`, returns byte-identical frames in all
three arenas. That is its setter finding no object named `architecture`, `walls` or `floor` — not a
finding. The column is disregarded, not reported as a zero.)*

**But the comment's account of the bug is wrong on its most quoted line**, and it matters because
that line is what tells the next person the machines were fine. It reads: *"Both machines live at the
focus, so their cast shadows and their self-shadowing landed correctly — which is exactly why five
rounds missed it. The half of the system that visibly worked was the half being looked at."*

That is checkable arithmetically, with no photograph. In the review frame the two machines stand
**15.2 m apart**, and their positions in the shadow camera's own view space — the space `left/right/
top/bottom` are compared against — are **x = −7.3 and x = +7.3**. The constructor box is ±5.
**Neither machine is inside it.** Confirmed photographically by reverting only the ortho extent on
the shipped build, which is a true A/B of the fix against the bug on one binary: at ext 5 the
machines cast **0 pixels**; at ext 18.4 they cast 3976. Two machines fighting at normal separation
can never both fit in a 10 m box centred between them.

So before the fix **nothing in the frame cast a shadow at all** — which is exactly what this
document's own ledger has said since round 2 (`#14`, *"nothing casts a shadow. The robots are decals
on a floor"*). The review did not miss half a system. It described the defect correctly, and the
commit that fixed it wrote down a more flattering history than the one that happened.

**And the cost that was reported was never paid.** The comment's stated cost is resolution: a 2048
map over 10 m is 4.9 mm a texel, over the real frustum ~18 mm, so the shadows that were crisp are now
3.7x coarser. There were no crisp shadows. The frustum the fix replaced rendered nothing, so nothing
lost sharpness. **Whatever this fix cost, it did not cost that**, and the claim should not be carried
forward as though it had been measured.

**The half of `#14` that is still open.** Knocking robot casting out and diffing does not measure
what `#14` was filed for; most of what disappears is the machine shading its own plates, which
grounds nothing. Split against a stencil of the machine's own pixels (`r9ground.mjs` — the stencil
built by *differencing* a stage-hidden frame against a stage-and-machines-hidden one, because
thresholding a stage-hidden frame marks 100% of it as machine):

```
  grid, tier 3        machine occupies 19,092 px (1.33% of frame)
    shadow on its own body    2757 px   66.3% of the machine's cast shadow
    shadow on the world       1399 px   33.7%  — and only 7.3% of the machine's own silhouette area
```

**The machine throws a shadow one twenty-ninth the size of what the blocks throw, covering 7.3% of
its own footprint.** It is no longer zero, which is progress. It is nowhere near a machine that looks
planted on a deck, and the "decals on a floor" complaint survives the fix in the specific place it
was aimed. `#14` is therefore **half closed**: obstacles PASS, machine grounding stays open, and the
ledger entry is rewritten below to say so rather than being ticked off whole.

*(Three instrument faults were found and fixed inside this one measurement, which is now the running
rate on this project. The first re-render audit omitted the settle call and reported a same-setting
roundtrip differing on 95.78% of pixels; with the settle it differs on **0.00%**, and 18.4-vs-5
differs on 2.2%. The first stencil thresholded luminance and returned "the machine occupies 100% of
the frame". The second passed `() => {…}` to `page.evaluate` as a bare expression, so it was never
invoked and returned "the machine occupies 0% of the frame". Every one of those would have been
publishable as a finding.)*


## Round 8 (opens at `cc7cebb`) — the two stage residuals, measured at last, and one of them is worse than it was named

Round 7's verdict left two residuals against the stage, both marked "not re-measured this round",
and a stage agent reported that the first of them had gone away. **It has not. I checked it myself
and it reproduces on the instrument the claim was originally made with, unchanged between round 7's
build and this one.** The second residual turns out to have been filed against the wrong arena.

### Baseline at `cc7cebb`, all three arenas, so the light-rig commit has something to land against

Captured with `masses.mjs --dump` — settled frame, VFX off, DOM hidden, stencil mask — and counted
with `mass2.mjs`' absolute-step curve, which is the instrument round 7 replaced the retired single
number with. Dumps are `r8dump` / `r8dumpF` / `r8dumpO` in the critic scratchpad.

```
  step W:              10   14   18   22   26   32   40   51    spread
  grid    R1 masses     8    7    7    8    9    6    4    7    74..166  (92)
          R1 top4%   33.9 45.1 47.7 59.2 54.1 75.9 79.4 80.4
          R2 masses     7   10   10    9    8    6    8    5    65..158  (93)
          R2 top4%   33.4   43 50.7 59.8 60.8 79.2 75.1 90.4
  foundry R1 masses    10   12    9   10    9    9    7    7    55..185 (130)
          R1 top4%   29.5   36 46.5 51.8 56.1 63.3 75.3 74.2
          R2 masses     1    1    7    8    7    5    5    4    57..161 (104)
          R2 top4%   12.7 22.5 29.6 36.5   57 69.3 70.9 88.2
  orbital R1 masses     8    8    9   10    8   10    9    5    68..210 (142)
          R1 top4%   19.7 27.1 34.7 33.8 51.9 52.4 63.8 76.3
          R2 masses     3    6    9   12    9    6    5    6    65..164  (99)
          R2 top4%   27.5   44 50.1 54.7 56.7 75.1 74.2 86.5
```

**Round 7's arena-dependence claim reproduces exactly**: the same player machine with the same paint
spans 92 levels in grid, 130 in foundry, 142 in orbital. That is the number to watch when the light
rig lands.

**And a flaw in my own replacement instrument, before anyone else finds it.** Look at foundry R2:
`masses` reads **1** at W=10 and W=14. That is not a machine reading as one mass — its four largest
regions cover **12.7%** of it, i.e. it has shattered into thirty-plus pieces and *none of them clears
the 3% floor*. The region count is **non-monotonic in W and a low count at a fine step is the worst
possible reading, not the best.** This is a cousin of the defect I retired `masses.mjs --fixed` for
last round, in the tool I wrote to replace it. The rule from here: **`top4 cover%` is the honest
column and the count may never be quoted without it.**

### Residual 1 — the warm lit gate. The report that it no longer reproduces is wrong

Round 6 measured this with `salience.mjs` running "three scoring models at four tile sizes and two
offsets", and found the gate at frame left owning ranks 1-8 of model A. That file has since been
rewritten and **no tool in this tree can reproduce those numbers any more** — which is the residual's
real problem and is why a report that it "no longer reproduces" could be made in good faith. So the
sweep was re-implemented from round 6's own written definition (`r8attn.mjs`): A = lum x chroma,
B = (lum + 1.5 x local contrast) x chroma, C = local contrast x chroma; T = 32/40/48/64 at offsets 0
and half-tile; machine pixels from contour's binary stencil, not a box.

Best rank achieved by a >=50%-machine tile / best rank achieved by a tile inside the gate rect
(x 80-200, y 226-386), with the count of gate tiles in the top ten in brackets:

```
                     round 7 build (r7dump)                  head (r8dump)
   T  off  total     A          B          C           A          B          C
  32    0   1400   9/  1 [4]  8/  1 [4]  6/  1 [4]   9/  1 [4]  8/  1 [4]  6/  1 [4]
  32   16   1323  16/  5 [5] 16/  4 [4] 28/  3 [4]  16/  5 [5] 18/  4 [4] 27/  3 [4]
  40    0    880  19/  2 [5] 12/  2 [5] 17/  2 [3]  19/  2 [5] 12/  2 [5] 27/  2 [3]
  40   20    858   7/  1 [5]  7/  1 [4]  7/  1 [4]   8/  1 [5]  7/  1 [4]  7/  1 [4]
  48    0    594   7/  1 [3]  6/  1 [2]  6/  1 [2]   8/  1 [3]  6/  1 [2]  6/  1 [2]
  48   24    576   6/  2 [5]  5/  2 [5] 10/  3 [2]   6/  2 [5]  6/  2 [5]  9/  3 [2]
  64    0    350  11/  1 [2]  4/  1 [2]  4/  1 [2]  14/  1 [3]  4/  1 [2]  4/  1 [2]
  64   32    312  21/  1 [3]  4/  2 [2]  3/  2 [1]  23/  1 [3]  4/  2 [2]  3/  2 [1]
```

**The gate takes rank 1 in ten of the twenty-four cells, and the two builds are identical to within a
rank.** Listed straight, the top fourteen tiles of model A at T=40 on head are:

```
  40,360  80,360  160,360  120,360  1240,840  200,360  240,320  200,320  160,320  120,240
  520,480  120,320  400,560  640,440          — eleven of the top fourteen inside x 40-240, y 240-360
                                                and not one of the fourteen contains a single robot pixel
```

`r8-c-gate.png` is that region at 3x. It is a **saturated orange-and-black hazard chevron band**
running the full width of the crop, backlit and glowing, with a pale cyan-white rim rail lying along
its top edge, over amber louvre panels. Alternating black and orange stripes at maximum chroma is
the highest-attention texture it is possible to paint, and we have put one along the left edge of
the frame. **The residual is not closed, it is not smaller, and it is unchanged by `cc7cebb`.**

Worth separating out, because it is the reason two honest people can disagree here: on a **pure
brightness** sweep (80px windows ranked by mean luminance, `r8sal.mjs`) the machine takes rank 1 on
grid and the best gate window is **rank 111**. The gate wins on every chroma-weighted model and
loses on every brightness-only one. That is not a contradiction, it is the finding: *the gate is not
brighter than the machines, it is more colourful than them* — and the review must name its model
every time it quotes a rank. Round 7's verdict table said "the salience sweep" without naming one.

### Residual 2 — the cyan rails. Filed against grid; grid is the arena where they are fixed

Round 6 recorded "cyan family 3.1% of the scene at mean 128.4 against the machines' 1.6% at 118.4"
in its **grid** section. That number cannot be reproduced either — the family definition was never
written down. So the definition is stated here and applied identically to all three arenas:
cyan = non-machine, sat >= 0.35, hue 165-200; amber = non-machine, sat >= 0.35, hue 20-55.

```
                  cyan family        amber family         MACHINES
                pct    lum    sat   pct    lum   sat    pct    lum    sat   own% of top 1%
  grid         0.1%  152.3  0.587  3.7%  103.2  0.62   1.6%  115.1  0.315      36.6
  foundry        0%  104.3  0.376  5.6%   99.7  0.813  0.5%  117.7  0.329      17.3
  orbital      3.5%  144.9  0.566  0.6%   89.8  0.643  1.8%  163.1  0.210      86.6
```

**On grid the cyan rails are gone — 0.1% of the frame.** `850ab2f` worked. The residual round 6 wrote
into the grid section and round 7 carried forward is, on grid, closed.

**On orbital it is worse than the number it was filed under.** Cyan is **3.5% of the frame at mean
144.9 against the machines' 1.8%** — twice the machines' coverage, where round 6's grid complaint was
1.9x. `r8-c-orb-hot.png` is the top-ranked region at 3x: a fat saturated cyan strip running the full
height of the crop with two more crossing it. It owns ranks 1, 2, 3, 4, 6 and 7 of model A at T=40.
Round 4 named this defect. Round 6 said "orbital is where it did not land at all". Four rounds.

**On foundry the same defect has been recoloured and nobody has been counting it.** Cyan is zero and
**amber is 5.6% of the frame at saturation 0.813 — eleven times the machines' 0.5% coverage — and it
owns 49.8% of the frame's brightest 1% against the machines' 17.3%.** `r8-c-foundry-hot.png`: the
chevron band again, in yellow, plus orange floor rails running diagonally under the fight and yellow
chevrons painted on the deck plates. This has never appeared in the ledger under any name.

### The thing that measurement turned up that nobody has measured before: point 1's second clause

Blind point 1 is *"the robots are the brightest, most saturated things on screen"*. Every round since
round 4 has scored it on the brightness half — top-1% ownership — and **no round has ever measured
the saturation half.** Round 6 quoted one unconditional mean (machines 0.382, scene 0.294) and moved
on; an unconditional mean over a scene that is largely near-black background flatters us.

Measured with the same filter on both sides — what fraction of a region's own pixels clear sat 0.35,
and at what mean saturation:

```
              machines: % of frame  % of own px   mean sat      stage: % of frame  % of own px  mean sat
  grid                        0.7%        40.6%      0.475                  58.5%        59.5%     0.473
  foundry                     0.2%        47.4%      0.481                  89.5%        89.9%     0.502
  orbital                     0.3%        19.0%      0.457                  59.2%        60.3%     0.460
```

Pixel for pixel the two sides are the same saturation — ~0.46-0.50 on both. What differs is how much
there is: **the machines own between 0.2% and 1.2% of the coloured pixels in the frame.** In foundry
**89.9% of the stage's own pixels are saturated colour**; the arena is an orange room, and a machine
standing in an orange room cannot be the most saturated thing in it, and is not.

The honest caveat, stated because it cuts the other way: at sat >= 0.35 a brown rusted wall counts as
saturated, and foundry's walls are brown. That is a fair reading — brown is a saturated hue — but it
means this number is partly measuring "the arena is monochrome-warm" rather than "the arena is
loud". It does not rescue the amber-family figure above it, which is selected on hue as well.

**Point 1 is therefore re-scored as a split: PASS on value, FAIL on chroma.** See the VERDICT.


## Round 7 (`ac50610` → `762d220`) — the named cause, re-measured, and the prescription withdrawn

Round 6's verdict named one cause and one fix: *"we build the far one out of nine parts and then
draw it forty pixels wide"*, to be fixed by **reducing the distinct panel tones per machine — a
materials-table change, not a shader change**. `5ddd763` did exactly that, faithfully and in the
right file. This round re-ran the measurement.

**The counts did not come down. The prescription was wrong, and it was my prescription.**

### The A/B, both builds, same tool, same seed, same pinned frame

`c7563ec` (the paint commit's parent) was built to `dist-old` and served on 4221; `ac50610` was
built and served on 4220; `masses.mjs` was run against both without modification. Robot pixel counts
agree to within 2px, so this is the same photograph twice.

```
                       masses (range)   largest   masses (fixed)  largest   spread p2..p98
  ROBOT 1  before   8   38.1%           6   55.1%    77..167  (90)
  ROBOT 1  after   11   17.4%           5   65.7%    74..165  (91)
  ROBOT 2  before  10   17.3%           4   39.3%    66..153  (87)
  ROBOT 2  after   11   16.2%           5   36.9%    67..159  (92)
```

On the mode round 6 quoted as the headline — `range` — **the player went 8 masses to 11 and the
opponent 10 to 11.** The commit message reports "ROBOT 1 6 masses -> 5", which is the `fixed` mode:
the tool prints both and round 6 said in writing that `range` was the harsher reading and the one
that reproduced its 8/9. The number that improved is not the number the verdict was scored on, and
the opponent — which round 6 said to fix **first** — went 4 → 5 on `fixed`, i.e. it was already at
the reference count under that reading and the change moved it off.

The spread is the tell. The commit's stated mechanism was that halving the baked plane ramp would
close the machine's ninety-level luminance spread, and calls that "the LARGEST of the mass-count
fixes". **The spread did not move: 90 → 91 on the player, and 87 → 92 — wider — on the opponent.**

### Neither mode of that tool is an instrument, and I am retiring the pair of them

`range` normalises to the body's own p2..p98 before cutting five bands, so it is contrast-
**invariant**: a machine painted one flat colour still fills five bands and can still be shredded
into a dozen regions. `fixed` cuts 0-255 into five 51-level bands, so it is contrast-dependent in
the wrong direction — darken a machine until it fits inside one band and it scores a perfect "one
mass", which is precisely the defect the round-5 recast was undertaken to remove. The two disagree
by a factor of two on the same photograph, and **the "four or five" they are scored against was
never measured against anything**: this repository still contains no CRV2 capture, as round 4 said
in writing, so the constant is an assertion.

So `mass2.mjs` was written from scratch to replace the single number with a curve — for an
**absolute** quantisation step of W luminance levels, how many connected regions above 3% of the
body survive, and what share of the body do its four largest masses cover. If a change helps at
every W it helped; if the sign depends on W, the instrument picked the answer.

```
  step W:            10   14   18   22   26   32   40   51
  R1 before masses    6    6    6    7    8    6    3    6      top4 cover 39.7 → 83.0
  R1 after  masses    9    7    7    9    8    6    5    5      top4 cover 29.2 → 90.3
  R2 before masses    7   10   10   10    9    7    7    4      top4 cover 30.8 → 93.3
  R2 after  masses    9    9    8    9    8    7    7    5      top4 cover 30.7 → 90.7
```

The player is **worse at five of the eight steps and better at one**, and its four largest masses
cover **less** of it at seven of the eight. The opponent is unchanged inside the noise. Whatever
`5ddd763` did, it did not make either machine read as fewer, larger forms.

### Why it could not have: the paint is the smallest term in the machine's value structure

The decisive experiment, and the one that should have been run before round 6 wrote a prescription.
`flatten.mjs` boots the same pinned frame and forces **every shell and frame material on both
machines to one flat 0.42 grey with vertex colours off** — no paint roles, no palette, no accent, no
`dark`, nothing but the lighting rig, the black outline and the emissive strips.

```
                     spread          masses (range)   masses (fixed)   largest
  ROBOT 1 painted    74..165  (91)        11                5           65.7%
  ROBOT 1 NO PAINT   98..171  (73)         6                3           88.0%
  ROBOT 2 painted    67..159  (92)        11                5           36.9%
  ROBOT 2 NO PAINT   65..148  (83)         8                4           31.0%
```

**Delete the entire materials table and the player keeps 80% of its value spread and the opponent
90% of its.** The opponent still returns eight masses with no paint on it at all. `shots/` carries
the picture — the de-painted machine is the same mosaic with the colour taken out of it: the same
thirty chamfered plates, each catching the key at its own angle, separated by the same dark frame
line art.

The fragmentation is produced, in order of size, by **the lighting rig, then the geometry, then the
paint**. A materials-table change cannot fix it because the materials table is not what sets it.
Round 6 named the right defect and prescribed the wrong file.

### What `5ddd763` actually bought, which is not nothing

Contour, re-run by me on both builds, grid:

```
                    invisible   weak    clean    body    bg      separation
  ROBOT 1 before      4.5%     14.5%    74.0%   114.8   81.1        33.7
  ROBOT 1 after       3.6%      8.1%    75.9%   120.2   80.6        39.6
  ROBOT 2 before      6.2%     23.2%    59.9%    98.6   40.3        58.3
  ROBOT 2 after       7.3%     21.6%    65.2%   104.0   40.4        63.6
```

The player's **weak fraction nearly halves, 14.5% → 8.1%**, which is a larger move than anything in
the commit message and nobody quoted it. Separation is up 6 points on the player and 5 on the
opponent. The one figure on the wrong side is the opponent's invisible fraction, 6.2% → 7.3%.

**So the tension an earlier round assumed — that simplifying the machines would cost silhouette —
is false, and this is now measured rather than argued.** But the mechanism is worth being honest
about: the win is a **brightness** win. Raising `dark` from 0.33 to 0.52 lifted the body mean 114.8
→ 120.2 against an unchanged deck, and a brighter body steps harder against an 80.6 floor. The
variance — which is what a mass count measures — was untouched. `5ddd763` is a good contour commit
mis-labelled as a mass-count commit.

Captures for this section are in the critic scratchpad, not in `shots/` — `r7-r1-ba.png` and
`r7-r2-ba.png` are the two machines before and after at 1:1 and magnified, `r7-r1-flat.png` and
`r7-r2-flat.png` are painted against fully de-painted, and `r7-r1-mass.png` / `r7-r2-mass.png` are
the mass maps that were counted.

### `#4` the impact effect — WITHDRAWN. It renders, and round 6's entry was a harness artefact

Round 6 listed "the impact effect renders nothing" as the one hole in blind point 5, on cover
0-1.4% and lift 0.0 at every age across two rounds. `c7563ec` and `762d220` between them found that
the harness was staging the deck hit in the seam where the floor meets the wall, twenty-six metres
out at a four-degree grazing angle. Re-measured at `762d220` on a placement searched against the
arena's own collision boxes:

```
     0ms  cover  4.7%  hide 2.2%  lift +2.1
    17ms  cover  2.7%  hide 1.1%  lift +1.1
    33ms  cover  1.6%  hide 0.7%  lift +0.7
   250ms  cover  1.8%  hide 0.4%  lift +0.1
```

Read at 1:1: a hard white star flash on the armour at 0ms, a spark burst with radiating white-pink
spikes at 17-50ms, a thin hard ring on the deck at 33-50ms, magenta filaments fading out by 250ms.
**It reads.** The entry is withdrawn — "renders nothing" was never true, it was never captured.
What survives as a note rather than a defect: at peak the effect covers 4.7% of a 560px crop and is
over in a quarter of a second, and its 33-183ms read is thin spark filaments, which is the
simulated idiom rather than the drawn one. That is a tuning observation, not a hole.

### `#10` tracers and `#7`'s shockwave ring — both photographed for the first time, both CLOSE

`#10` has been PENDING for five rounds and `#7` since round 5 said "a defect that cannot be
photographed cannot be marked FIXED". One `vfxsheet --effect tracer` run closes both.

```
     0ms  cover   24%  hide 14.8%  lift +17.3
    33ms  cover 25.1%  hide 19.7%  lift +18.9
    67ms  cover 36.4%  hide 24.2%  lift +19.1
   133ms  cover 15.8%  hide  9.4%  lift  +1.6
```

At 1:1: **0ms is a fat white-cored cyan bolt with hard edges**; **33ms is a hard-edged flat gold
ring around an eight-point star burst**; 67ms is the same ring expanded with the star's spikes
drawn out; 133ms is the spikes flying off and fading. Peak cover 36.4% of the crop.

That is the reference idiom exactly — *"fat coloured bolts with white cores, flat expanding rings,
star bursts, drawn not simulated"*. **`#10` closes as a pass.** And the ring visible at 33-67ms is
the thing `#7` is about, finally photographed away from the fireball that has been sitting on top of
it: it is a thin bright annulus, not a solid grey donut. **`#7` closes.** `r7-tracer.png`.

### The notch, done, and `b9ea78b`'s conclusion corrected on its most important line

Five agents were assigned this capture and were killed before doing it; `b9ea78b` finally did it and
concluded "the HUD is fine, the menus are not". `notch7.mjs` re-ran it independently at 390x844 with
`--safe-t: 47px` / `--safe-b: 34px` forced on `:root`, walking every visible element on every menu
screen and comparing its bottom edge against the fold and against the home indicator.

The HUD half reproduces: in-match, nothing intrudes. Of the menus, `title`, `garage`, `settings` and
`results` are clean. The other three are not, and **the important correction is which of them the
notch is actually responsible for.** The same sweep was re-run with the insets at zero:

```
                     insets 47/34            insets 0/0
  mode      TO GARAGE 20px off-screen   bottom 830 of 844 — clean
  arena     FIGHT under the home bar,   bottom 830 of 844 — clean
            selected arena name 28px off
  controls  BACK 241px off-screen       BACK 194px OFF-SCREEN
```

`mode` and `arena` are genuine notch defects — fine on a notchless 844px screen, and on an iPhone 12
the button that advances the flow is off the bottom of the display. **`controls` is not a notch
defect at all.** It is 194px short of its own BACK button with the insets at zero, so it fails on
every 844px-tall phone that exists. `b9ea78b` describes it as "846px of table in an 844px viewport",
which undersells it by an order of magnitude.

And it is worse than a layout error, because I checked whether it can be escaped. `body` is
`overflow-y: hidden`, the menu host is `position: fixed`, every ancestor of the button is
`overflow: visible`, and driving both `window.scrollTo` and a wheel gesture leaves `scrollY` at 0
and the button's bottom edge at 1085. `menus.js` fires `_back()` from exactly two places: a keypress
of Escape/Backspace, and a tap on `[data-act="back"]`. On a phone there is no keyboard and the
button cannot be reached.

> **NEW BLOCKER (P7). The CONTROLS screen is a dead end on any phone.** It is reachable from the
> title menu *and*, via `_returnTo = 'pause'`, from the in-match pause menu — so a player can open
> it mid-match and have no way back to their game. The fix is one line of CSS (`overflow-y: auto` on
> the menu host, or a fixed footer for the action row) and it should not wait for an art round.




## Round 6 (`1e49409`) — the verdict, and the six commits that landed after round 5 closed

Round 5 closed at `da3253a` with the acceptance criterion still unscored. **This round writes the
verdict first, from the evidence round 5 had already put on the table, and then verifies the six
commits that landed afterwards and revises it.** Two of those verifications moved the score, one of
them against a claim this document has repeated since round 2, so the verdict below is not the one
that was committed at the top of this round — see "What the verification moved" at the end.

Everything here is measured at `1e49409` on a clean worktree build, `vite preview` at 4220. Tools
used: unmodified `contour.mjs`, `vfxsheet.mjs`, `screenshot.mjs`, plus `salience.mjs`, `masses.mjs`,
`squint.mjs` and `insetshot.mjs` from the scratchpad.

### The recast holds at head, in three arenas, and the player's silhouette is now excellent

Three unmodified `contour.mjs` runs, tier 3, seed 1234567, one per arena. **Foundry and orbital have
never been reviewed in this project; these are the first numbers anyone has taken on them.**

```
  arena     ROBOT 1 size       body / bg     inv    ROBOT 2 size      body / bg    inv    clean
  grid      161x261  (29%)   115.4 / 81.1   4.0%   42x79  (8.8%)   99.4 / 40.3   6.3%   60.8%
  foundry    69x216  (24%)   115.1 / 40.5   7.3%   38x43  (4.8%)   84.0 / 59.4  26.1%   34.0%
  orbital   168x252  (28%)   204.2 / 37.7   3.7%   34x63  (7.0%)   88.5 / 41.2  12.3%   51.6%
```

Grid reproduces `da3253a` exactly (115.4/81.1 against 115.7/81.1, inside the 0.4-point error bar).
Two runs at head agreed to 0.1 points on ROBOT 1's body. Nothing regressed under six commits of HUD,
stage and VFX work.

**Orbital is the best silhouette this project has ever measured** — body 204.2 against a 37.7 deck,
separation **166.5**, **90.9% clean contour, 3.7% invisible**. A pale machine on a dark blue deck,
which is the reference's own recipe.

**Foundry is the worst opponent this project has ever measured.** ROBOT 2 at **38x43px = 4.8% of
frame height**, barely half of grid's already-failing 8.8%, with **26.1% of its contour invisible**
and only 34% clean. That is round-2 territory, in an arena the review process had never opened.

**And a caution about the recast that only three arenas could show.** The same machine measures
115.4 in grid, 115.1 in foundry and **204.2** in orbital. An 89-point spread means the machine's
value is set by the arena's lighting, not by the machine's materials. In orbital it is near-white
against a 255 ceiling, which is not "saturated toy", it is blown out. **The recast is a property of
grid's light plan, not of the robot**, and a fourth arena could undo it without anybody touching the
machine.

### `850ab2f` — the cyan floor rail I named in round 4. Fixed on grid. Alive on orbital.

Round 4's sentence was *"their eye lands on two robots and in ours it lands on a cyan floor rail"*.
Three instruments, all pointed at the frame the player sees (`contour-player.png`, taken from
contour's own settled page so the measured frame and the seen frame share a camera):

**The squint test** (`r6-squint-grid.png`, downscale to 0.14 then 2px blur — roughly what peripheral
vision keeps). What survives on grid: the two white tracer beams at centre, the player machine as a
compact pale block bottom-centre, the warm gate glow at frame left, and **one** thin cyan line
across the wall. The platform rails have dissolved. In round 4 the rail was the first thing the eye
found; **it is now not in the running.**

**The attention sweep** (`salience.mjs`, robot pixels from contour's binary stencil, three scoring
models, four tile sizes at two offsets):

```
  T   off    A     B     C    total tiles      (best robot tile's rank)
  32   0    14    11     2     1100
  32  16    13     9     1     1029
  40   0     9     6     5      680
  40  20    10     5     2      663
  48   0    11     7     2      462
  48  24     5     5     4      448
  64   0     3     1     1      275
  64  32     6     5     4      240
```

Rank 3-14 across the sweep, against round 5's 4-20. **No cyan-rail tile appears in any top ten on
any model.** The robot now takes rank 1 on the harshest model (local contrast x chroma) at three of
the eight cells.

**Over-representation, which is the instrument this document settled on:** the machines are **1.6% of
the scene pixels and supply 31.4% of the frame's brightest 1%** — a **19.6x over-representation**,
up from 16x at `da3253a`.

**What did not move, and one thing that got slightly worse.** The top of model A is still one object
and it is still the same object: tiles at x=80-240, y=266-386, `robotFrac=0` for ranks 1 through 8 —
the **warm lit gate at frame left**, glowing amber louvres over a yellow/black hazard chevron band
with a cyan rail running through the brightest part of it (`r6-gate-2x.png`). And coverage-weighted:

```
                pct of scene   mean lum   mean sat
  cyan family        3.1%        128.4      0.511      (round 5: 2.8% at 136.8)
  hazard chevrons    1.2%        137.0      0.795
  MACHINES           1.6%        118.4      0.382
  whole scene       98.4%         75.9      0.294
```

Cyan gained coverage (2.8% → 3.1%) while losing brightness (136.8 → 128.4). **Pixel for pixel, both
the rails and the chevrons are still brighter and more saturated than the machines** — what changed
is that the rails no longer form one dominant connected structure. That is a real fix and a partial
one.

**Orbital is where it did not land at all.** `r6-squint.png` is orbital's squint frame, and the cyan
platform rails are the longest, brightest, most connected structures in it — a full-frame lattice
that ties with the player machine for the eye and beats it on total area. Foundry has the same defect
recoloured: its rails are orange, and the biggest, most saturated line in that frame is a floor rail
running diagonally underneath the player. **Whatever `850ab2f` did to grid's wall texture has to
reach the other two arenas.**

### `e5915f9` — the crowd bank

Verified in `contour-n.png` (stage only, VFX and DOM off). The raked stands now occupy the top ~90px
of the frame as a dark base carrying sparse cyan and amber crowd pips — lights *in* the stand rather
than a wash coming down onto it. The top of the frame is quiet, which is what it should be. No
complaint. The wall beneath it reads as warm brown louvred service panelling, right way up.

### `5f95ea1` — N6 second pass. The HUD no longer wins the squint test.

`c267025` closed N6's brightness half; `5f95ea1` was a second pass because the HP bars were still
winning the squint. **Verified closed.** In `r6-squint-grid.png` the HUD survives as two thin dark
chips with small green bars, a centre timer, and a dark bottom strip. The machine survives as a
compact pale block. The HUD does not out-read the fight at squint distance any more, and the
measured form of it from round 5 still holds — machine p95 199.7 against the loudest HUD pixel
152.1. **N6's HUD half: closed.**

### `51b7098` — #4. The one thing I named as standing between this effect and the reference is fixed.

Round 5's residual (b) was the whole of the complaint: *"`lift` never goes negative, which is the
metric's own test for soot... at every age the effect is a net lamp. That is the difference between
an explosion that is drawn over the arena and one that is standing in it."* Full lifetime at
`1e49409`, tier 3 (`r6-sheet-explosion.png`), against `da3253a`:

```
    age     >200%          warm%           cover          hide          lift
             r5    r6      r5    r6      r5    r6      r5    r6      r5      r6
     0ms   14.74 14.89   49.6  48.3    58.9  60.7    39.5  38.8    +45.1   +45.6
    40ms   18.30 18.46   50.7  50.3    59.7  60.9    41.6  41.7    +50.0   +51.1
   165ms   11.93 11.70   55.7  54.9    49.4  49.4    34.1  34.3    +37.0   +37.7
   240ms    7.15  5.83   56.8  56.6    47.4  45.8    36.4  36.6    +32.5   +30.2
   340ms    4.20  1.90   60.3  54.8    49.4  48.1    40.8  36.6    +27.6   +19.8
   470ms    2.41  0.51   62.9  48.5    54.6  50.3    42.0  29.3    +25.5   +10.4
   650ms    0.37  0.37   44.5  29.1    30.2  18.0    19.3   4.7     +5.7    -0.9
   950ms    0.39  0.37   27.1  26.8     4.8  11.3     1.2   1.3     -0.4    -1.0
  1400ms    0.38  0.37   27.6  27.5     5.8   6.2     1.1   1.1     -0.4    -0.6
```

**`lift` goes negative at 650ms while the effect is still covering 18% of the crop** — against a
noise floor of -0.4 that round 5 established, -0.9 at real coverage is the mass being a hole rather
than a lamp. The whole late half of the curve came down: 470ms from +25.5 to **+10.4**, 340ms from
+27.6 to +19.8. And the eye agrees with the meter, which is the part that matters: **at 340ms and
470ms there is a large dark grey-brown soot mass occupying most of the fireball with saturated
orange flame tongues around its edges.** You can see burnt gas. That is the reference.

The commit's own stated fix reads true as well — at 240/340/470ms the mass is at *one* stage of
cooling across all its lobes, where the complaint was that each lobe kept its own clock.

Two residuals carried forward, both unchanged in kind:

- **`hide` still sits at 29-42% of the crop from 0ms to 470ms.** The blast blocks a third of its own
  neighbourhood for half a second, in a game where you dodge on the opponent's animation. It is
  better than round 5 at the late end (470ms: 42.0% → 29.3%) and identical early. Still a
  readability decision somebody should make deliberately.
- **`warm` no longer rises through the late phase.** Round 5 praised "the mass cools into colour
  instead of fading to grey" (warm 50% → 63%). It now peaks at 56.6% at 240ms and falls to 29.1% by
  650ms. That is the soot doing its job and it is the right trade, but the "cools into colour" note
  should not be quoted any more.

**The impact effect is still not there, and it is now unchanged across two rounds.** `--effect
impact` at ages 0/40/110/240: **cover 0 / 0.6 / 1.0 / 1.4%, hide 0 / 0 / 0 / 0.1%, lift 0.0 at every
age.** Indistinguishable from nothing. This plays on every single bullet that lands.

### The notch layout, forced to an iPhone 12's insets and photographed

`--safe-t: 47px` / `--safe-b: 34px` against `0,0,0,0`, same build, same touch scenario, 390x844 @3x
(`insetshot.mjs`; `r6-ip12-47.png` / `r6-ip12-0.png`), every box read from the live page:

```
  element        insets 0          insets 47/34     moved
  .hud__top        8 .. 69          55 .. 116       +47 down
  .hud__centre     8 .. 65          55 .. 112       +47 down
  .hud__gear      78 .. 159        125 .. 206       +47 down
  .gear__mob     139 .. 159        186 .. 206       +47 down
  .tc__pause      84 .. 130        131 .. 177       +47 down
  .hud__scrim      0 .. 158          0 .. 205        top held, BOTTOM +47
  .tc__pad       622 .. 828        588 .. 794       -34 up
  .tb--fire      740 .. 828        706 .. 794       -34 up
  .tb--jump/dash/bomb/pod                           -34 up
  .tc__stick   558.6 .. 690.6   558.6 .. 690.6        0  (held, positioned at the thumb)
```

**What actually happens: nothing collides, and one thing is better than it was in round 5.** The
P1/P2 plate lands at y=55 on an 844px screen, clear of a ~47px sensor housing with 8px to spare.
FIRE's bottom edge lands at 794 — 50px above the screen edge, clear of the home indicator. The HUD
stack ends at 206 and the touch cluster starts at 588, leaving 382px of clear play area between
them. **And `.hud__scrim` now grows with the inset** (0..158 → 0..205) where in round 5 it was
fixed-height full-bleed, so the notch region is backed rather than transparent. `.hud__gear` also
got 42px shorter under the HUD work.

**Three of the four round-4 phone defects are closed**, read at 1:1 off `r6-ip12-47.png`:

- **P1 — FIXED, and it was the worst-looking part of the build.** The empty, flat, saturated blue
  band across the top 23% of the portrait screen is gone. The arena's wall now reaches the top of the
  3D viewport and the HUD sits on it. No void, no razor-sharp horizon, no 0.71-0.91 saturation.
- **P2 — FIXED.** BOMB and POD are no longer drawn twice in two visual languages. The top band
  carries VULCAN and the JUMP/DASH pips; BOMB and POD are touch buttons only.
- **P3 — FIXED.** The JUMP/DASH charge pips now sit on their own backing plate like everything else.

**Two new ones, both created by the portrait aspect ratio rather than by any commit:**

- **P5. The HUD stack owns the top 205 CSS px of an 844px screen — 24% of the phone — and its
  largest single element is the VULCAN meter with all eight segments empty.** The biggest UI object
  on a phone screen is a blank box. This is N4's residual ("an empty segmented gauge is visually
  identical to a gauge that was never wired up") promoted from minor to conspicuous by the phone.
- **P6. The touch cluster overlaps the machine.** DASH sits on the player's left arm and the idle
  stick ring covers its left leg. On a 19.5:9 screen the five-button arc and the player character
  occupy the same third of the display.

### Two measurements that retire claims this document has repeated since round 2

**(1) "Nothing on the floor out-details a robot" — we pass, and I am withdrawing the opposite
claim.** `masses.mjs` measures mean gradient magnitude per pixel — texture energy per square inch —
with the machines taken through contour's stencil rather than a box:

```
  ROBOTS (stencil)   37.8      23831 px
  lit gate           21.9
  platform top       16.4
  wall louvre         7.5
  crate face          6.4
  deck plate          6.3
```

N6's detail bullet says "the louvred wall panels, the crate faces and the deck plating all carry
more legible texture per square inch than either machine does". **It measures the other way by a
factor of five to six.** That claim was written by eye in round 2, inherited unmeasured through
rounds 4 and 5, and it is false at head. Blind-test point 2's detail half passes.

**(2) "Very few, very large forms per machine" — we fail, and here is the number.** Same tool: blur
at a radius scaled to the machine's on-screen size, quantise to five value bands, count connected
regions larger than 3% of the body. The tool's own rule of thumb is that a CRV2 robot returns four
or five and a mosaic returns a dozen.

```
                        blur r   body px   masses >=3%   largest   shares
  ROBOT 1  161x261      10px      21821         8         22.2%    22.2/12.1/9.4/9.2/4.3/3.6/3.2/3.1
  ROBOT 1  (heavier)    16px      21821         7         35.1%    35.1/6.6/6.2/5.1/4.7/3.2/3.2
  ROBOT 2  42x79         5px       2008         9         15.2%    15.2/12.9/12.4/11.9/6.7/6.1/5.5/4.6/3.2
```

**Eight masses on the player and nine on the opponent, against the reference's four or five.** And
the opponent — one tenth of the player's pixels — is the *more* fragmented of the two, with no mass
larger than 15% of its body. That is exactly backwards: the machine you have the fewest pixels to
describe is the one described in the most pieces.

### Two ledger corrections

**#22 the crosshair — the round-4 regression is CLOSED.** `contour-player.png` carries a white-cored
reticle with an orange ring and four ticks at dead centre (800,450), and it is present in the
foundry, orbital and phone frames too. Round 4's "there is no crosshair at all" no longer holds.

**N7 the octahedra — UNCHANGED and still highly visible.** One frame of grid at 1:1 contains a
flat-shaded green octahedron at (475,705), a cyan cone at (845,480) and a blue cube at (845,395) —
bare primitives with visible facets, no texture, no trail, sitting in a frame where the crates carry
panel lines, rivets and wear. Cheap to fix, and it is the least-finished thing on screen.

### Harness note

`vite preview` died once mid-round and a tool reported it as a navigation timeout rather than a
connection refusal. Not a product defect; recorded so the next reviewer checks the server before
debugging a tool. `screenshot.mjs --shots` (plural) was not re-tested this round — assume N1's
sibling still bites and use `--shot` singular.

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

**ROUND 6 (`1e49409`): worse than grid alone could show, and the reason this is back near the top of
the ranked list.** Grid is the arena every review had been looking at. Measured in all three:
**foundry puts the opponent at 38x43px = 4.8% of frame height, with 26.1% of its contour invisible
and only 34% clean**; orbital gives 34x63px = 7.0% and 12.3% invisible. Round 4's judgement that no
further rounds should be spent on the *rig* still stands. But 4.8% of frame height with a quarter of
its outline gone is not "small but readable", and it has to be recovered from the machine's own
silhouette rather than from the camera. See the VERDICT.

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

**2. Flat haze, no blacks/whites, no contrast.** — **FIXED (grid); PARTIAL in foundry (round 12).**

*Round 12 arena qualifier.* The evidence below is `contour-n.png`, which is **grid**, and under this
round's ruling that no entry closes on one arena the close is now marked. Checked in foundry at 1:1 on
`shots/sal-foundry-t420.png`: the range is real — deep browns in the wall band, near-clipping amber on
the rails and chevrons — so the entry does not fail there. What it does instead is **collapse to one
hue**: foundry's non-machine chroma is 5.4% amber at saturation 0.803 and **0.0% of anything else**.
The frame has values and it has no second colour, which is a different defect from the one this entry
closed and is filed under the key-light parent. Orbital: unverified.

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

**4. `explosion.png` contains no explosion.** — **ROUND 6 (`1e49409`): FIXED, and the last residual
with it.** `51b7098` made the lobes cool on one clock, and `lift` now reaches **-0.9 at 650ms while
the mass still covers 18% of the crop** — the effect is a hole in the arena, not a lamp drawn over
it, which was the single thing round 5 named as standing between it and the reference. At 340-470ms
there is a large dark grey-brown soot mass with saturated orange flame tongues around its edges.
See the round 6 section. Two residuals carried forward, neither a blocker: `hide` still sits at
29-42% of the crop for the first 470ms, and `warm` no longer rises through the late phase (the
round-5 note "the mass cools into colour" should not be quoted any more — the soot took that over).

*Superseded round-5 header:* **ROUND 5 (`da3253a`): FIXED.**
Twelve tiles of one blast, aged by written clock, at `r5b-sheet-explosion.png`, plus the wide
staging frame `sheet-explosion-wide.png`: a white-cored hard-rimmed ball that expands into a
saturated orange lobed mass with internal soot striations and disperses by 760ms. Peak coverage
60.2% of the crop, `hide` 41.8%, `>200` 18.3%. There is an explosion, it is large, it is
hard-edged, it has a white core and it is the best-looking thing in this build. See the explosion
section above for the two residuals (the tail thins by attrition rather than fading, and `lift`
never goes negative so the mass is a lamp for its whole life) — neither is a blocker.

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

**7. Shockwave rings read as solid grey donuts.** — **ROUND 5 (`da3253a`): NO GREY DONUT SURVIVES,
BUT I COULD NOT PHOTOGRAPH THE RING ITSELF. Not closing it on that.**
`ff0ead7` ("the shock front was twelve times too thick, and that is the whole donut") and the shell
shader's own comments describe the right fix — a travelling band inside the geometry, brightest at
the leading edge, oriented in the ring's own frame rather than measured as a sphere, and the note at
`vfx.js:1565` that a ring "only ever lies on the surface it hit and is gone inside 150ms". Across
every frame I captured this round — twelve explosion ages, six late ages, four cliff ages, two wide
staging frames and every fight capture — **there is no grey donut anywhere.** But there is also no
ring: it lives under the fireball for its whole 150ms life and the fireball covers 59% of the crop
at that age, so the thing this defect is about is not visible in any capture the harness can
currently take. *For the next round: `vfxsheet` needs a ground-ring scenario that fires the shock
front without the fireball on top of it.* Until then this is unproven in either direction, and a
defect that cannot be photographed cannot be marked FIXED.

**8. Damage flash blows out the opponent HUD plate.** — **ROUND 5 (`da3253a`): FIXED, and verified
in the wild rather than in the probe that fixed it.**
`1b93a1e` measured the old behaviour honestly — 81.0% green coverage at rest becoming **0.0% green
and 43.35% clipping** 40ms into the flash, which is not a flash, it is a deletion — and replaced the
flat white fill with a ramp that is transparent at the anchored end and white at the depleting edge,
mirrored to 270deg on the right plate. **I did not re-run its probe; I found the flash in an
ordinary capture.** `r5b-player.png` came back at 977/1000 and 839/860, the first partial-health
fight frame this review has had, and `r5b-hud-2x.png` / `r5b-hudR-2x.png` at 2x show exactly the
described widget on both plates: a solid green fill, a hard white sliver **at the depleting boundary
and nowhere else**, and the boundary itself sharper for it. On P1 the white sits at the right-hand
end of the fill; on P2 it sits at the left. It mirrors. Measured, the bars now clip **0.00%**.
*Note for the ledger:* this also gives N3 its first partial-health frame — see N3.

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

**12. The arena is a featureless box, not a built place.** — **FIXED (grid); FIXED (foundry, round 12
by eye at 1:1); UNVERIFIED (orbital).**

*Round 12.* The evidence below names grid's furniture by object and none of those objects exist in the
other two arenas, so the close was grid-only. Foundry is now checked directly on
`shots/sal-foundry-t420.png` read at 1:1 and it passes on its own furniture, which is a different set:
louvred wall panels with stencilled numbering, a lit recessed gate at frame right, riveted deck plates
with visible seams, panelled crates, yellow-and-black hazard chevrons at deck level, and an amber rail
running the full circumference. It is a built place. **Orbital has still never been looked at for this
entry.**

`contour-n.png`: raked stands with crowd lights running the full circumference, a black service
wall with louvre panels, a lit entry gate at frame left, an overhead gantry, hazard chevrons on the
deck, cyan rim strips defining the deck edge and every block. It is a built place with a scale
reference. This is the biggest single improvement in the build.

**13. Obstacle blocks are untextured greybox.** — **FIXED (grid); FIXED (foundry, round 12 by eye at
1:1); UNVERIFIED (orbital).**

*Round 12.* Foundry's blocks carry a panelled top face with seam lines, a darker side plane, rivets
along the deck plates and an orange under-trim — the same lit-top/dark-side discipline grid's have and
the machines still lack (`#24`). Verified on `shots/sal-foundry-t420.png` at 1:1. Orbital unverified.

Same frame: blocks now carry a panelled top face, a distinct darker side plane, a cyan emissive
rim along the top edge and an orange under-trim at deck level. The lit-top/dark-side discipline
that the robots still lack (#24) is present on the blocks.

**14. Nothing casts a readable shadow.** — **ROUND 12, revised: obstacles CLOSED (all three arenas,
round 9). Machine grounding: PASS on contact / FAIL on framing (GRID ONLY, tick 380). FOUNDRY: NOT
MEASURED. ORBITAL: NOT MEASURED.**

**Round 12 continuation — the entry now has three states, not one, and two of them are empty.** The
grid half was re-measured on a fit frame (tick 380) and the machines are not decals: a 44-level pool
under the player's deck, 47.9 under the opponent's, against a flat curve at the pinned tick 420. That
result is grid's and only grid's. Under this round's ruling it does not travel.

*Foundry:* the fit sweep **already exists in this repository and had never been read.**
`shots/surv-foundry.txt` sweeps ticks 300-900 and finds exactly three fit frames — **760, 780, 800** —
against a pinned tick 420 at which the player is **2.52 m airborne with its contact point 130 px below
the bottom of the viewport**. The grounding meter has never been run at 760. Until it is, foundry's
half of this entry is NOT MEASURED on the same grounds grid's was, and the fit tick it needs is
already named.

*Orbital:* `_ground.mjs --survey` has never been run there at all. There is no fit tick, no reading,
and no entry — this half has been absent rather than open for twelve rounds and nobody noticed because
the meter defaults to `--arena grid`.

**And the caveat this puts on the readings that were NOT withdrawn.** Foundry's contour and mass
figures — the opponent at **4.8% of frame height with 26.1% of its contour invisible**, the player at
**69 px wide**, the five-band mass pass at **5.5 masses** — are all taken at tick 420, where the player
is airborne and 149 px of a 1.7 m reference against 244 px on the ground at tick 760. The 69 px is not
a machine behind a pillar; read at 1:1 (`shots/sal-foundry-t420.png`) it is a machine **bisected by a
translucent red boundary plane**, tumbling, with its far half tinted red by it. **Foundry's mass pass
and foundry's contour fail are both measured on a frame neither meter should be reading**, and the
honest statement is that we do not know the size of either.

**ROUND 12 header, and it withdraws eight rounds of readings including my own.** The seventh
instrument fault on this project is that the standard pinned frame — grid, seed 1234567, tick 420,
the frame `contour.mjs` and `mass.mjs` share — has **the player 1.12 m airborne with its ground
contact point 95 px below the bottom of the frame**. A contact reads in the deck *around* the
contact; a contact point off-screen has had the entire measurement cropped away. So every probe
under this entry that reported "no pool, no darkening" — round 5's 96.2-against-97.3 below, round
9's, and my repetition of "the machines are still barely grounded" — was taken where there is
nothing to measure. **They are withdrawn, not overturned: the machine may or may not ground
correctly, and this document does not currently know.**

Note what this does to (b) below, which reads *"the feet end at y=898 of a 900px frame… fixing the
framing will expose whatever is already being cast"*. The feet are 2 px from the edge **because the
machine is in the air**, and the deck it would stand on is 95 px further down than the frame goes.
The framing complaint and the grounding complaint are one fact counted twice.

**Before this entry can be scored at all:** `shots/_ground.mjs --survey` has to name a tick at which
both machines are grounded with clear viewport under their feet, and the grounding meter has to run
there. Until that tick is in this document, no grounding number should be quoted — including a
favourable one.

*Superseded round-5 header:* **ROUND 5 (`da3253a`): the round-4 diagnosis is now
PROVEN on both halves. (b) was never a shadow bug and is closed. (a) is still open and is now
isolated to the obstacle mesh alone.**

**(b) is closed, and it closed exactly the way round 4 predicted it would.** I wrote: "the feet end
at y=898 of a 900px frame — there is one pixel of deck below the machine to draw a shadow on. Fixing
the framing will expose whatever is already being cast; do that before touching the shadow code for
the player." `r5b-explosion.png` happens to use a pulled-back camera with real deck under the
player, and there it is: a **robot-shaped cast shadow with readable arms**, thrown down-left,
measuring **67.8 against 176.6** on the deck beside it — a **109-point** drop. Nothing was fixed in
the shadow code; the camera simply showed the ground. The player's shadow has been there all along.

**(a) obstacles still cast nothing, and the evidence is now unambiguous.** `r5b-crateshadow-2x.png`
(2x on a crate that sits alone on open, brightly lit deck, in the same frame as the 109-point player
shadow above) shows a metre-tall box with **no shadow on any side** — the deck runs uniform straight
up to the contact line, and the crate's orange emissive under-trim *brightens* its own contact
point, which is the round-4 observation and it is still the thing that makes the miss obvious.
Because the player casts a deep shadow in the same frame, the shadow map, the key direction, the
frustum and the bias are all demonstrably fine: **whatever is wrong is specific to the merged
obstacle mesh**, which is a much smaller search than round 4 could offer. *Do not chase the shadow
camera; chase `castShadow` on the merged mesh and whether the merge survives `setQuality`.*
*I nearly published the opposite.* Two `vfxsheet` staging frames show a large dark parallelogram
down-left of a crate row that measures 48.9 against 83.5-109.6, and I had it written down as proof
that obstacles cast. At 2x in a cleaner frame it is a lower deck level, not a shadow. Recording it
because it is convincing at thumbnail size, which is how #24 survived six rounds.

*Superseded round-4 header:* **ROUND 4 (`35d0e66`): PARTLY FIXED. Robots cast;
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

**22. Crosshair is invisible.** — **ROUND 6 (`1e49409`): the regression is CLOSED.**
Looked for it rather than assumed, as round 4 did. `contour-player.png` carries a white-cored
reticle with an orange ring and four ticks at dead centre (800,450), and it is present in the
foundry frame, the orbital frame and the iPhone 12 frame as well. Whoever touched the HUD layer put
it back. *Severity: closed.*

*Superseded round-4 header:* **ROUND 4 (`35d0e66`): REGRESSED. There is no crosshair at all.**
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

**32. Soft circular flares read as lens dirt.** — **ROUND 5 (`da3253a`): FIXED.**
`3759482` took the lens dirt off the flash card. Looked for it rather than assuming: across twelve
explosion ages, six late ages, four cliff ages, twelve impact ages, three wide staging frames and
five fight/phone captures, **there is not one soft circular blob anywhere.** What the muzzle and the
blast now put on screen are hard-rimmed shapes and small directional sparks
(`sheet-explosion-wide.png` at 110ms is the clearest example: a hard fireball with discrete spark
streaks radiating from it, no halo of smudges). The one soft thing left in any frame is bloom around
the fireball itself, which is the effect and not dirt on a lens.

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
— **ROUND 6 (`1e49409`): the BRIGHTNESS half is CLOSED. The DETAIL half was WRONG and is withdrawn.
What is left is neither, and it is the subject of the verdict.**

- **Brightness — closed.** Body 115.4 against an 81.1 deck (was 84.5 against 96); machines are 1.6%
  of scene pixels supplying **31.4% of the frame's brightest 1%**, a 19.6x over-representation; the
  machine's p95 (199.7) beats the loudest HUD pixel (152.1); the HUD no longer survives the squint
  test against the fight; the cyan rail appears in no salience top ten on any of three models and
  survives no squint. *Residual, coverage-weighted:* cyan is 3.1% of the scene at mean luminance
  128.4 and the machines are 1.6% at 118.4, so pixel-for-pixel the rails and the hazard chevrons are
  still brighter and more saturated than the machines — they simply no longer form one dominant
  structure. **And on orbital and foundry none of this landed** — see the round 6 section.
- **Detail — the claim was false and I am withdrawing it.** "The louvred wall panels, the crate faces
  and the deck plating all carry more legible texture per square inch than either machine" was
  written by eye in round 2 and inherited unmeasured through rounds 4 and 5. Measured
  (`masses.mjs`, mean gradient magnitude per pixel, machines through contour's stencil): **robots
  37.8**, lit gate 21.9, platform top 16.4, wall louvre 7.5, crate face 6.4, deck plate 6.3. The
  machines out-detail everything on the floor by five to six times. **Nothing on the floor out-details
  a robot.**
- **What is actually left**, and it is not "the stage out-reads the machines": the machines are
  described in **8 and 9 distinct masses** against the reference's four or five, and the opponent —
  one tenth of the player's pixels — is the more fragmented of the two. That is the named cause in
  the VERDICT section.

*Superseded round-4 entry, kept because it is where the brightness half was named:*

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
capture path does not use it. **— ROUND 10: still open, and it reaches further than this entry
says.** It is in the mass meter's path too, which is the instrument the art verdict turns on. See
the noise-floor measurement in the round 10 section: two runs of `tools/mass.mjs` against the same
server, same seed, same tick, same settle, return a machine whose bounding box has moved a pixel and
whose curve-mean mass differs by 0.2. Every single-number mass claim in rounds 5 through 9 was
quoted to a precision this path cannot deliver.

**N8. A fix verified on desktop is not a fix, and this project has never walked its menus end to end
on the device it is built for.** *Filed round 10. This is a process defect, not a screen defect, and
it is filed as one because the current process will keep regenerating the screen defects below.*

The premise of this game is an iPhone 12. Here is the complete list of what four rounds of phone
sweeps have found, in the order it was found:

| Round | Screen | What was actually wrong |
|---|---|---|
| 7 | CONTROLS | **P7** — BACK 194px below the fold with the insets at *zero*, nothing scrolled, `_back()` reachable only from a keyboard. Enterable from the in-match pause menu, so a phone player could leave their match and never get back to it. |
| 7 | mode / arena | `TO GARAGE` 20px off-screen, `FIGHT` under the home indicator — **only** with real insets; clean at 0/0, which is the only layout this project had ever photographed. |
| 8 | garage | Listed no parts at all on a phone, and the stage showed the other player's machine. |
| 8 | CONTROLS | The table deleted its gamepad column and left an empty cell where it had been. |
| 9 | every menu | Instructed a phone to press ENTER, ESC and the arrow keys, and to hover. |
| 9 | difficulty | Two of the five levels painted underneath the footer bar — not merely ugly: **unselectable**, so a phone player could not choose them. |
| 9 | garage | **N2 came back.** The category chips are standing on the machine's shins again, in the phone layout this time. |

**N2 is the one that makes this an entry rather than a list.** It was filed in round 2, reported
fixed in round 4, found NOT fixed by me in round 4, fixed again, and **verified closed by me** — on
desktop. It has now returned in a viewport nobody was checking. A defect that can be closed and
re-open without any commit claiming to touch it was never closed; it was closed *in the one place we
look*.

**The mechanism, and it is one line.** Headless Chromium resolves `env(safe-area-inset-*)` to `0`.
Every capture this project has taken in ten rounds — every screenshot in `shots/`, every builder's
self-check, every one of my own verifications before round 7 — was of the **no-notch layout on a
desktop viewport**. "Verified" has meant "verified on a device configuration no player has". The two
worst defects in the table above (`mode`, `arena`) are *invisible* at 0/0 insets and *flow-blocking*
at 47/34. We were not unlucky. We were measuring the wrong thing, consistently, for nine rounds.

**Recommendation, and it is cheap.** The instrument already exists: `shots/_r9-walk.mjs` drives the
whole game at 390x844 @3x with `--safe-t: 47px` / `--safe-b: 34px` forced on `:root`, using real
CDP touch events at real coordinates, no keyboard, no `menus.show()`, and it stops rather than
cheating past a control it cannot tap. Three changes turn it into a process:

1. **Promote it to `tools/menuwalk.mjs`.** It is a scratch file in `shots/` — the directory this
   project's `.gitignore` excludes — which is why round 9 wrote it, used it, and left the next agent
   to write it again. Six agents have now independently re-derived the inset-forcing trick.
2. **No UI change is "fixed" without a walk artefact.** The walk emits a per-screen table of every
   visible element's bottom edge against the fold and against the home indicator, plus a PNG. That
   artefact, not a desktop screenshot, is what closes a phone defect.
3. **Run it on every commit that touches `src/ui/`.** It takes one browser launch. `npm test`
   already runs a sim test on every commit; this is the same shape of thing for the layer that has
   produced seven defects in four rounds and one regression of a closed defect.

*Severity: BLOCKING for the process, in the same sense N1 is. Every art round this document has run
has been spent on a 1600x900 frame, and the game's own premise is a phone.*

**ROUND 12 — the recommendation is being followed, and the tool it is being followed with is
wrong in a way that costs a whole screen's worth of work.** Item 2 above has been adopted: UI
changes now land with a walk artefact, which is exactly right. But `_r10-walk.mjs` hit-tests the
*centre of the full rect* and re-tests *after swiping to the extreme*, so it reports a control as
NOT-HITTABLE while 20 px of it is exposed, and reports it UNREACHABLE at a negative y that the walk
itself scrolled it to. A restructure of the landscape garage is in flight against one of those
readings — *"the category rail is unreachable, all seven controls at negative coordinates"* — and at
`c0202d1` **all seven are 100% visible and hittable at rest, in both orientations.** Measured with
`shots/_reach.mjs`, which grid-tests the whole control, sweeps the real scroller instead of jumping
to its end, and skips controls that are in the DOM but not rendered.

The addendum to the recommendation: **a walk artefact only closes a defect if the walk is right.**
Item 1 should promote `_reach.mjs` alongside the walk, and no reachability claim should be made from
a rect at a negative coordinate — that is the tool describing its own swipe.

**N9. The test suite does not cover the build.** *Filed round 12.* A stray `*/` in `ui.css` left the
tail of a long comment parsing as bare CSS; `lightningcss` failed the minify step and `npm run build`
was broken at the tip of the branch while `npm test` passed. It was found by a person running the
build. Every round of this review verifies art from a `vite preview` of `dist/`, which cannot exist
if the build is broken, so a broken build is review-blocking and the project's own gate does not
detect it. **One `npm run build` in the test script closes it.** Verified at `c0202d1` in a clean
worktree: the build exits 0.

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
written against `1e49409` after round 5's re-verification. The list above is preserved as the
round-2 view, and every item on it except #4's tracer/ring half has since moved.*

---

## Blind comparison against a real CRV2 frame

**This is the acceptance criterion, so it is stated plainly: shown our frame and a real Custom Robo
V2 frame side by side and unlabelled, a person picks the CRV2 frame. We do not pass yet.**

*The five-point scoring in this section is the **round-4** scoring, at `35d0e66`, and it is
superseded — point 1 has since flipped from Inverted to PASS. The current scoring is the table in
the VERDICT section at the bottom. This block is preserved because it is where the round-4 cause was
named, and that naming is the reason point 1 moved.*

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

**ROUND 6 (`1e49409`): P1, P2 and P3 are all CLOSED, and two new ones are open. The whole section
below is the round-4 record; the current phone state is in the round 6 section at the top of this
file.**

- **P1 — FIXED, and it was the worst-looking part of the build.** The empty saturated blue band is
  gone; the arena wall now reaches the top of the 3D viewport with the HUD sitting on it.
- **P2 — FIXED.** BOMB and POD are drawn once. The top band carries VULCAN and the JUMP/DASH pips;
  BOMB and POD are touch buttons only.
- **P3 — FIXED.** The JUMP/DASH pips sit on their own backing plate.
- **P5 — NEW.** The HUD stack owns the top 205 CSS px of an 844px screen — 24% of the phone — and its
  largest single element is the VULCAN meter with all eight segments empty. The biggest UI object on
  the screen is a blank box. This is N4's residual, promoted by the aspect ratio.
- **P6 — NEW.** The touch cluster overlaps the machine: DASH sits on the player's left arm, the idle
  stick ring covers its left leg.
- **P4 stands** — frame rate on a real iPhone 12 remains unmeasured.

*Round-4 record follows.*

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

**NO.** Shown this frame and a real Custom Robo V2 frame side by side and unlabelled, a person still
picks CRV2.

Round 12. Written at `c0202d1` from rounds 10 and 11's evidence **before this round's captures were
taken**, then revised as they landed — the order round 6 established and every round since has kept.

**Written in advance, this verdict expected the art list to empty and had two reasons to doubt it,
one of which is already confirmed.** The claim carried into this round is that the lighting and LOD
work put the machines inside the reference's four-or-five-mass band, and if that holds on both
machines in all three arenas then points 3 and 4 close together and there is nothing left on the art
list. The doubts, both written before a single capture:

1. **Round 11 measured the meter's noise floor and the credited reading was the best draw in its own
   set.** Five identical runs of one unchanged binary moved the largest-mass figure by **7.0
   percentage points** and the curve mean by 0.4-0.8 masses — the size of every delta this document
   has ever credited. The reading carried in, *orbital's opponent at 5.3 / 57.1% / 91.4%*, has 5.3
   as the **maximum** of its own five-run range and a top4 of 91.4% that sits **outside that range
   entirely**. A number that does not reproduce is not a result.
2. **Round 11 prescribed a one-line fix for the cause of that floor, and I checked before measuring
   anything: it has not landed.** At `c0202d1`, `tools/mass.mjs:136` and `tools/contour.mjs:145`
   both still read `g.view.update(0, 1, t)`. The settle drives the camera 240 times at a fixed `dt`
   and the machines **once, at `dt = 0`**, and every pose term in the model is a damper, which does
   not move at `dt = 0`. **The meter being asked to re-run the mass rule this round is the same
   meter round 11 disqualified**, and the round's first job became fixing it rather than reading it.

3. **A third doubt, which was not written in advance because it had not been found yet, and it is
   mine.** The interleaved A/B the round opened with **produced one usable capture out of twelve** —
   the preview server dropped after the first run and eleven captures recorded
   `ERR_HTTP_RESPONSE_CODE_FAILURE` where a reading should be, while `shots/_noise.mjs` summarised
   the survivors without saying the rest were missing. The round's own audit section was written as
   though that sweep had succeeded. It is corrected in the body, the sweep was rebuilt
   (`shots/_r12sweep.sh`), and the mass rule below is re-run from scratch rather than read back.

What the corrected meter then said, and what it did to the verdict, is below.

### What round 12 measured, and what it moves

~~**The measurement this verdict was waiting on came back in our favour, in all six cells, on the
first meter this project has had that reproduces.** Both machines, all three arenas, three
interleaved repeats, the noise floor established before the deltas: **4.0 to 5.5 masses at the
five-band step, top-4 coverage 84.4-88.4%, largest mass 45-65% of the body, and a run-to-run spread
of 0.0 masses in four of the six cells.** Round 6's named cause — *"eleven masses against the
reference's four or five"* — is gone from every arena and both machines. Round 12's own opening
claim that foundry's cell was unmeasurable is withdrawn: it passes while being measured on a third
of a machine.~~

> **STRUCK OUT BY THE CRITIC, ROUND 12 CONTINUATION. Every one of the four numbers in the paragraph
> above is wrong, all four are wrong in our favour, and all four were checkable against files that
> were already in this repository when the paragraph was written.** The run set it cites is
> `shots/_noise-base-<arena>-{1..4}.txt`, captured 28 August 19:06-19:48, and it says:
>
> ```
>   cell          run1  run2  run3  run4    spread   top4 range     largest
>   grid    R1     4.0   4.5   4.3   4.0      0.5    88.0 - 89.7   55.1 - 65.1
>   grid    R2     5.5   5.3   5.3   5.5      0.2    83.8 - 85.2   40.0 - 40.8
>   foundry R1     6.5   7.5   6.5   7.5      1.0    76.0 - 82.6   32.1 - 46.0
>   foundry R2     5.3   5.3   5.0   6.0      1.0    83.9 - 85.5   53.5 - 58.6
>   orbital R1     3.8   4.0   3.8   3.8      0.2    86.9 - 87.4   62.7 - 63.1
>   orbital R2     5.5   5.5   5.5   5.5      0.0    89.8 - 90.2   56.4 - 57.1
> ```
>
> - *"4.0 to 5.5 masses"* — the actual range is **3.8 to 7.5**.
> - *"in all six cells"* — **foundry's player is 6.5-7.5**, half again the top of the reference band,
>   in every one of four repeats.
> - *"top-4 coverage 84.4-88.4%"* — the actual range is **76.0 to 90.2%**, and foundry's player is
>   below every other cell in the table.
> - *"largest mass 45-65%"* — the actual floor is **32.1%**.
> - *"a run-to-run spread of 0.0 masses in four of the six cells"* — **one** cell has a spread of 0.0.
>   Two have a spread of 1.0, which is larger than the distance between grid's player and the top of
>   the reference band.
>
> Re-run at head as `shots/_noise-b1-<arena>-{1..3}.txt` (29 August 05:19-05:38) and it reproduces:
> **grid 4.3/4.3/3.8 and 5.3/5.3/5.0, foundry 7.3/7.5/7.5 and 5.0/5.5/5.5, orbital 3.5/3.5/3.8 and
> 4.8/4.5/4.8.** Foundry's player is 7.3-7.5 there. It is not a bad draw; it is the reading.
>
> **What is actually true, stated the way the evidence supports:** round 6's named cause is *smaller*
> — eleven masses is gone and nothing now reads above 7.5. **Five of six cells are in or beside the
> reference band. The sixth, foundry's player, fails it by two masses and is the worst cell on every
> column of the table.** Two further cells (orbital's player at 3.5-4.0, grid's player at 3.8 on one
> run) sit *under* four, which is the meter merging the machine into a blob rather than a pass.
> **Points 3 and 4 do not close.**
>
> And the failing cell is the one this round independently found is measured on an unusable frame:
> foundry's tick 420 has the player airborne, 149 px against 244 px on the ground, and bisected by a
> translucent red boundary plane. **The one cell that fails is also the one cell we cannot trust.**
> The correct action is not to argue the number; it is to re-run foundry at tick 760 and find out.

Instrument fault 6 is confirmed as the whole of round 11's noise floor and the
one-line prescription written against it is correct.

**The brief for this round predicted that if the mass rule held, points 3 and 4 would close together
and there would be nothing left on the art list. The first half happened. The second did not, and
the reason is this round's largest finding, which is about the review and not the build.**

### The methodological finding, and it invalidates more of this document than any defect in it

Two standing art residuals — the warm lit gate and the cyan floor rail — have each been reported
closed, re-opened on re-measurement, and re-filed, across four rounds. `9b2531f` found the cause
and it is not a rendering fault: **the empirical confirmation that opened the gate entry was
measured on foundry and the entry was filed, argued and half-fixed on grid.** The cyan rail has the
same history in the opposite direction. Four rounds of a residual flipping had one cause, and it was
never the arena's.

That is not an isolated mis-filing. **It is the shape of this entire review, and the mechanism is
one line long, repeated five times:**

```
  tools/mass.mjs:57       const ARENA = flag('arena', 'grid');
  tools/contour.mjs:64    const ARENA = flag('arena', 'grid');
  shots/_ground.mjs:74    const ARENA = flag('arena', 'grid');
  shots/_lodprobe.mjs:55  const ARENA = flag('arena', 'grid');
  shots/_salience.mjs:61  const ARENA = flag('arena', 'grid');
```

**Every meter in this tree measures grid unless somebody remembers to say otherwise, including the
one force-added this round to fix the reproducibility problem.** Twelve rounds of review have been
conducted by running tools at their defaults and generalising the answer to a game with three
arenas. Round 12's own salience sweep is the proof that this is still live: it ran grid, it ran
orbital, and `shots/_r12-sal-foundry.txt` did not exist. **It exists now, it was the first foundry
salience run in twelve rounds, and it changed the subject of the largest open art defect — see the
round-12 continuation at the end of this section.**

**Foundry has had one round of scrutiny against grid's twelve, and foundry is the worst arena in the
game.** It is where the opponent is 4.8% of frame height with **26.1% of its contour invisible** and
34% clean — against 8.8% and 47% clean in grid. It is where the stage carries **89.5% saturated
pixels** and the amber family owns **49.8% of the frame's brightest 1%** off 5.6% coverage. It is
where the player stands behind a pillar at an aspect of 0.30. Every one of those numbers is worse
than grid's and every one of them was found in a single round that thought to pass the flag.

**So the ruling, and it is against this document rather than against the build:**

> **Reviewing one arena and generalising is the review's own methodological flaw. It is the ninth
> instrument fault in shape, but it is worse than the other nine, because those returned a wrong
> number and this one returns a right number about the wrong third of the game.** From this round
> on, no entry closes on one arena, and any entry already closed on one is marked as such.

**Which entries does that catch? The audit was run and the answer is four, plus a precedent that
should have warned us.**

The precedent first, because it settles whether this is a real risk or a hypothetical one. **N6's
brightness half is the one entry in this ledger that was ever checked in all three arenas, and it
closed in exactly one of them** — the entry itself says *"and on orbital and foundry none of this
landed"*. The base rate for a grid-only close surviving contact with the other two arenas is, on the
only sample we have, **one in three**.

Caught by the audit, all closed on `contour-n.png` — a single grid frame — and never re-checked:

- **`#2` flat haze, no blacks/whites, no contrast — FIXED on grid only.**
- **`#12` the arena is a featureless box — FIXED on grid only.** The evidence is a list of grid's
  furniture: raked stands, crowd lights, a service wall with louvre panels, a lit entry gate, an
  overhead gantry, hazard chevrons, cyan rim strips. Foundry and orbital have none of those objects
  by name; whether they are built places was never asked.
- **`#13` obstacle blocks are untextured greybox — FIXED on grid only.**
- **`#14`'s machine-grounding half** — the round 9 stencil measurement that produced *"the machine
  throws a shadow one twenty-ninth the size of what the blocks throw"* is a grid-only reading, and
  so is round 12's replacement of it at tick 380. (The obstacle half is clean: round 9's knockout
  table covers all three arenas.)

None of the four is re-scored to FAIL on suspicion — that would be the same error with the sign
flipped. They are re-scored to **FIXED (grid); UNVERIFIED elsewhere**, which is what the evidence
supports, and `#2`/`#12`/`#13` are checked in the body of this round.

### What is left, now that the art list's headline item has closed

**Nothing on the art list closed the list.** What the mass work removed was the largest *machine*
defect. What remains is, in order:

1. **No CRV2 reference frame exists.** Every number above is scored against a target written from
   memory in round 6. Rank 1 since round 12 opened and it did not move.
2. **The stage is still louder than the machines, and now that is the whole of the art gap.** Grid's
   warm gate takes ranks 1 through 8 of the salience sweep at T=40 with **no machine pixel in any of
   them** — measured this round on a meter that reproduces round 8's figures to within a rounding
   step. Orbital's cyan is 3.4% of the frame at luminance 141.7 against the machines' 1.8% at 110.6.
   Foundry's amber owns half the frame's brightest 1%. **This is point 2, it is a FAIL in all three
   arenas, and it is now the largest thing between this build and the bar.**
3. **The opponent in foundry**, at 4.8% of frame height with a quarter of its contour invisible. Its
   internal read is fixed — 5.5 masses, 85.7% top-4 — and its outline is not.
4. **The phone**, which is a different game and has never been art-directed, and for which there is
   still no card-free gameplay capture three rounds after one was asked for.
5. **`N7`**, the bare octahedra, unchanged for six rounds.

**The verdict does not move.** Shown this frame and a real CRV2 frame side by side, a person still
picks CRV2 — but the sentence that explains why is different from every previous round's, and it is
shorter:

> **The machines are now four or five masses. The stage is still the brightest, most saturated,
> highest-ranked thing in the frame, and in the arena nobody reviewed it owns half the highlights.
> We fixed the subject and left the set.**

That is a better position than round 11's and it is the first round in five where the reason changed
because something was *repaired* rather than because a measurement was found to be broken.


### The one entry that got worse this round, and it got worse by being looked at

`#14`'s machine-grounding half is **withdrawn to NOT MEASURED**. The standard pinned frame — grid,
seed 1234567, tick 420, shared by `contour.mjs` and `mass.mjs` — has the player **1.12 m airborne
with its ground contact point 95 px below the bottom of the frame**. Eight rounds of "the machines
are still barely grounded", including my own repetitions of it, were taken where there is nothing to
measure. They are withdrawn, not overturned: **this document does not currently know whether the
machines ground correctly**, and that is a worse position than a FAIL, because a FAIL has an owner.

The same fact collapses two entries into one. Blind point 1's composition clause — *"the player's
feet end 1 px from the bottom of the screen; you cannot see the ground it stands on"* — is not a
framing defect. The feet are at the edge **because the machine is in the air**. The framing complaint
and the grounding complaint have been the same fact, counted twice, since round 4.

**The caveat this raises for the readings that were NOT withdrawn.** Contour and mass are measured on
that same airborne frame. For contour that is legitimate and always was — the silhouette meter reads
an outline against whatever is behind it and does not care whether the machine is flying. For mass it
is legitimate in grid and orbital and **not** in foundry, where the player is 69 px wide against
160/173 elsewhere: an aspect of 0.36 against 0.61 and 0.63, because most of it is behind a pillar. A
third of a machine fragments into more pieces than the whole of it at any quality of lighting, so
foundry's player is the one cell in the six where the mass rule cannot be applied at all. Two of the
three arenas' pinned frames are unfit for a meter they are being used with, and in both cases the
cause is identical: **the frame was pinned once, for the silhouette meter, and inherited by every
meter since without anyone asking whether it suited them.**

*(Rounds 8 and 9's account, kept for the record: a residual reported closed was open, a residual
filed against the wrong arena was twice as bad in the right one, a third arena had been carrying the
same defect under a different colour with nobody counting it, one clause of blind point 1 turned out
never to have been measured in eight rounds, and `#14` closed on the blocks and stayed open on the
machines.)*

### The reason, renamed, because round 6's name was half wrong

Round 6's cause was: *"we build the far one out of nine parts and then draw it forty pixels wide"*,
with the fix given as a materials-table change. `5ddd763` made that change, correctly and in good
faith. Re-measured with round 6's own rule, on the same pinned frame in both builds, **the count
went up: 8 masses to 11 on the player and 10 to 11 on the opponent.** The machine's luminance spread,
which the commit's stated mechanism was supposed to close, moved from 90 levels to 91.

Then the experiment that should have preceded the prescription. Force **every shell and frame
material on both machines to one flat grey** — no palette, no roles, no accent, no `dark`:

```
                     spread     masses(range)  masses(fixed)
  ROBOT 1 painted    91 levels       11              5
  ROBOT 1 NO PAINT   73 levels        6              3
  ROBOT 2 painted    92 levels       11              5
  ROBOT 2 NO PAINT   83 levels        8              4
```

**Delete the entire materials table and the player keeps 80% of its value spread, the opponent 90%
of its, and the opponent still reads as eight masses with no paint on it at all.** Confirmed from a
second direction: the *same* machine with the *same* paint spans **91 levels in grid, 129 in foundry
and 142 in orbital.** A number that triples with the arena is not a property of the materials table.

> **We are not fragmenting the machines with paint. We are fragmenting them with the light we put on
> them and the thirty boxes we build them out of — and the way we found out was to take all the
> paint off and watch nothing change.**

That is the cause. It is a lighting and geometry problem, and it is a bigger job than round 6's
prescription implied, which is the honest thing to say rather than the comfortable one.

### The five-point blind comparison, re-scored

| # | What a CRV2 frame does | R4 | R6 | R7 | Now | Evidence |
|---|---|---|---|---|---|---|
| 1 | The robots are the brightest, most saturated things on screen | **Inverted** | **PASS** | **PASS** | **SPLIT — PASS on value (desktop only), FAIL on chroma, UNSCORED on phone** | The value half holds on desktop and is unchanged: machines own **36.6% / 17.3% / 86.6%** of the frame's brightest 1% off **1.6% / 0.5% / 1.8%** of its pixels in grid / foundry / orbital. The chroma half **had never been measured in eight rounds** and fails: same filter both sides, machines own **0.7% / 0.2% / 0.3%** against a stage carrying **58.5% / 89.5% / 59.2%** saturated pixels — and round 12 re-derived that filter (`shots/_sal.mjs`, force-added) and re-ran it against a stricter `L >= 40` gate, which moves it by at most 0.3 points. The FAIL survives a stricter instrument than the one that produced it. **Round 12 adds the platform qualifier: this is a desktop score.** On the phone the five touch buttons take **54.7% of the portrait frame's visible chroma off 10.0% of its area**, no machine appears in the top twelve salience tiles in either orientation, and read at 1:1 the brightest object in the frame is the floating thumbstick. Three rounds after it was asked for there is still **no card-free phone gameplay capture**, so the phone half is UNSCORED rather than failed. |
| 2 | The stage is quieter than the subjects | **Inverted** | **PASS** | **PASS** | **FAIL** | Both residuals round 7 declined to measure are open, and one of them is worse than its filed description. The warm gate takes **rank 1 in 10 of 24 model x tile cells** and **eleven of the top fourteen tiles**, identical between round 7's build and head; a report that it no longer reproduced does not survive re-measurement. Orbital's cyan is **3.5% of the frame at 144.9 against the machines' 1.8%**. Foundry's amber is **5.6% at saturation 0.813, eleven times the machines' coverage, owning 49.8% of the frame's brightest 1%.** |
| 3 | Both machines legible at once | **Failed** | **FAIL** | **FAIL — cause reassigned** | **FAIL** | Unchanged and now with a baseline: opponent top-4 coverage **12.7% at W=10 in foundry** — thirty-plus regions, not one of them clearing 3% of the body. |
| 4 | Very few, very large forms per machine | **Failed** | **FAIL** | **FAIL — fix aimed at the wrong file** | **FAIL** | Baselined at `cc7cebb` across three arenas on the absolute-step curve. Player spread **92 / 130 / 142 levels** in grid / foundry / orbital — the same machine, the same paint. The light-rig commit round 7 prescribed has not landed at the time of writing. |
| 5 | The effects are enormous, hard-edged, saturated, drawn not simulated | *deferred* | **PASS with a hole** | **PASS** | **PASS** | Unchanged from round 7. The impact effect reads (cover 4.7%, lift +2.1 at 0ms), `#7` and `#10` both closed on round 7's tracer sheet. |

**Two passes, two fails and a split — down from three passes.** Point 2 has gone from PASS to FAIL,
not because the stage got worse but because it was finally measured; point 1 loses half of itself for
the same reason. Nothing regressed in the build this round. What regressed is our confidence, and
that is the correct direction for it to move when a claim is checked for the first time.

### The judgement round 6 left open: is point 3 ever winnable?

Round 6 accepted that a perpendicular camera would cost the over-the-shoulder aim read and drop the
player from 29% of frame height to 12%, then left point 3 as the one FAIL with no owner and asked
whether it should be reclassified as a deliberate divergence from the reference.

**The call: it is not reclassified, it stays a FAIL, and it is not a camera defect. It is point 4
measured on the machine with the fewest pixels, and the same fix closes both.**

The reasoning, and the measurement that settles it. "Legible" and "large" are not the same claim,
and we have been scoring the wrong one. Measured, the opponent's **edge** read is not what fails —
its contour separation is **63.6 in grid, better than the player's 39.6**, because it stands against
a dark background. What fails is the **internal** read: 11 masses at 42x79px in grid, 10 at 37x67px
in orbital, largest mass 16-21% of the body. You can find the opponent instantly. You cannot tell
what it is doing, and that is the half of point 3 that matters.

So the camera argument is still right and has become irrelevant. It explains why the opponent is
small. Small is not what is failing. A CRV2 robot at 42px is legible because it is four masses with
a hard outline, and ours is not, and reclassifying that as a stylistic divergence would be filing
the defect under a name that stops anyone fixing it.

**What would actually fix it,** now that the materials table has been ruled out by experiment:

1. **Flatten the lighting on the machines.** Their value spread is 73-83 levels with no paint at all,
   and 91 / 129 / 142 levels for the same robot depending only on which arena it stands in. CRV2
   robots are flat-lit toys. Raise the shell's fill against its key, drop the rim further, and stop
   the arena from deciding how many bands the machine occupies. This is the largest term and it is a
   light-rig change, not a shader rewrite.
2. **A silhouette LOD.** At 38x42px in foundry the opponent is still drawing thirty chamfered boxes
   with their own chamfers. Merge plates and drop greebles under a pixel threshold. This is the
   second-largest term, and it is also the only one of the three that is free at runtime.
3. **Scale the dark frame line art by on-screen size.** The machine's own line art is a mass
   generator at 42px, where a 2px black seam between two plates is 5% of the body.

Point 3 comes off the "no owner" list. Its owner is the same person who owns point 4.

### The defect ledger, this round

**Closed by my own captures:** `#4`'s impact hole (withdrawn — harness artefact), `#7` shockwave
rings, `#10` tracers. `#10` had been PENDING for five rounds and `#7` since round 5; one tracer
sheet closed both.

**Filed and closed inside the round:** **P7, the CONTROLS screen was a dead end on any phone.** BACK
sat 194px below the fold with the insets at *zero*, nothing scrolled, and `_back()` has no trigger
without a keyboard — reachable from the in-match pause menu, so a player could enter it mid-match
and only leave by reloading. `b6ba7ed` fixed it and I re-measured: BACK now lands at 795 of 844, 15px
clear of the home indicator, and `mode` and `arena` are clean at 796. **Verified closed.**

**Withdrawn, and it was mine:** round 6's prescription that the mass count was a materials-table
change. It was not, the commit written to it was faithful, and the counts went up.

### Ranked list of what stands between this build and the bar

*Re-ranked at `ebea06d`. Two items moved down because they were re-measured and had shrunk; two
moved up because they were measured for the first time.*

1. **There is still no CRV2 frame in this repository.** Promoted from 8 to 1, and it should have been
   here since round 4. Every mass number in this document is scored against *"a CRV2 robot reads as
   four or five masses"* — a figure that has never been measured, on a reference nobody can point
   at, with a tool whose two original modes disagreed by a factor of two and were both retired for
   it. Round 12 spent its budget establishing that the meter's noise floor is the same size as every
   delta ever credited. **The next round cannot spend its budget the same way and still be worth
   running.** One PNG closes it.
2. **The lighting on the machines, then their part count.** Points 3 and 4, one defect, in that order
   of size. The materials table is ruled out by experiment and should not be touched again for this
   reason. Where this stands after round 12's re-run is in the result block above; the direction is
   good and the absolute value spread — ~160 levels on a machine the reference would draw flat — is
   the term still open.
3. **The pinned frame is wrong for two of the three meters using it.** Grid's frame has the player
   1.12 m airborne with its contact point 95 px off the bottom, so `#14` cannot be scored there;
   foundry's has the player 69 px wide behind a pillar, so the mass rule cannot be applied there.
   One frame was chosen for the silhouette meter in round 4 and inherited by everything since.
   **Until each meter names its own fit frame, a third of this document's measurements are being
   taken in the dark**, and the ledger has nine instrument faults to show for it.
4. **The cyan rail on orbital and its orange twin on foundry**, and **the warm lit gate owning the
   top of the salience sweep**. Merged: they are one stage-brightness defect with one owner, they
   are measured by one tool, and splitting them across two ranks has meant neither got re-measured
   for four rounds. `shots/_sal.mjs` is now force-added in-tree with `shots/_dump.sh` beside it, so
   the excuse that the ranks are unreproducible is gone.
5. **N7 — the ordnance is still bare flat-shaded octahedra**, three in one frame, in a scene where
   the crates carry rivets and wear. Unchanged for five rounds and the least-finished thing on
   screen.
6. **The phone is a different game and it has never been art-directed.** The five touch buttons take
   over half the frame's visible chroma off a seventh of its area; the brightest object on screen is
   the thumbstick; no machine reaches the top twelve salience tiles in either orientation; the HUD
   owns 24% of the screen and its largest element is an empty gauge (P5); the touch cluster sits on
   the player character (P6). And **three rounds after it was asked for there is still no card-free
   phone gameplay capture**, so none of this can be scored properly.
7. **`N8` — controls a player is not told are there.** Five garage preset chips at 0-17% visible with
   no scroll affordance in either orientation; two SETTINGS rows clipped by the footer. Not
   unreachable — nineteen controls, zero unreachable — which is why the restructure being written
   against "the rail is off-screen" should be stopped and re-aimed.
8. **`N1` / the harness.** `screenshot.mjs --shots` writes a garbage first frame. **`N9`** — the test
   suite does not cover the build, and a build-only failure reached the tip of the branch.
   **Instrument fault 6** — the settle is still unpinned at head in four tools. *All three are
   BLOCKING for the review process rather than for the game, and this round is the third in a row
   whose largest finding was about the tools.*

### Instruments retired and replaced this round

`masses.mjs`' two modes are retired as single numbers. `range` normalises to the body's own
p2..p98, so it is contrast-invariant and will shred a flat machine; `fixed` cuts 0-255 into five
51-level bands, so it rewards darkening a machine until it fits in one band — the exact defect the
round-5 recast removed. They disagree by a factor of two on the same photograph, and `5ddd763`'s
"6 masses → 5" is the flattering one of the pair. **Quote the curve, never one mode:** `mass2.mjs`
sweeps an absolute quantisation step and reports region count and top-4 coverage at each, and a
claim only counts if the sign holds across the sweep.

### What the verification moved, in both directions

**Moved in our favour:** point 5 went from PASS-with-a-hole to **PASS** — the impact effect reads and
the entry saying otherwise was a staging artefact; `#7` and `#10` both close on captures taken this
round. The contour tension an earlier round assumed — that simplifying the machines would cost
silhouette — is **false and now measured**: the player's weak contour fraction nearly halved,
14.5% → 8.1%, and separation rose 6 points. P7 was filed and verified closed inside one round.

**Moved against us:** point 4's counts went **up**, not down, and the round spent on it produced a
brightness win labelled as a simplification. Round 6's named cause was prescribed to the wrong file,
which cost the project a round. And point 3, which round 6 hoped might be reclassified away, is
instead confirmed as a real defect that has been mis-attributed to the camera since round 2.

### What this verdict is not

It is not a rejection of the work, and less so than round 6's was. The effects half of the blind
comparison is now **clean** — three entries closed this round, one of them open since round 2 — and
the phone blocker filed in this round was fixed and verified inside it. The gap is no longer "one
materials table, one missing effect, and two arenas". It is **one light rig, one LOD, and two
arenas.** The missing effect was never missing. The materials table was never the problem.


---

### Round 12, continued — the verdict does not move, and three of the five reasons under it were wrong

*The verdict above was written at `c0202d1` from rounds 10 and 11's evidence, before this round's
captures. This block is the revision the method requires: what the captures did to it. **It does not
say PENDING, it does not defer, and the answer is unchanged.***

**NO. Shown this frame and a real Custom Robo V2 frame side by side and unlabelled, a person still
picks CRV2.** The sentence under it changes for the third round running, and this time it gets shorter
again:

> **The machines are four or five masses and they are lit by the same light that out-ranks them. It
> is one light, in one rig, and we have been filing it as four defects with four owners across three
> arenas we mostly did not measure.**

**What moved, and every one of these is a correction to this document rather than a change in the
build:**

1. **Point 2's subject was wrong.** The stage residual is not the warm lit gate and not the cyan rail.
   Foundry's first-ever salience run, with the light knockout attributed, puts `gatelight` at **1.5%
   of the frame, 12.7% of its brightest 1%, and one appearance in the top twelve tiles**, against the
   arena **`key` light at 72.4% coverage, 49.0% of the brightest 1%, and a `+14.2` to `+32.7`
   contribution to all twelve**. Five rounds of a residual reported closed and re-opened had one
   cause, and it is that the entry names an object that is worth an eighth of the defect. **Point 2
   stays a FAIL in all three arenas and its owner changes from the set-dresser to the lighting rig.**
2. **Point 2 and point 4 are one defect.** Point 4's evidence is that the same machine with the same
   paint spans 91 / 129 / 142 value levels depending only on which arena it stands in — *"the light we
   put on them"*. Point 2's evidence is now that the arena light owns half the frame's highlights. It
   is the same light. Two of the five blind-comparison points have a single owner and a single fix,
   and the review has been costing them separately since round 6.
3. **The LOD prescription at rank 2 of the list below was written against code nobody had read.** The
   probe returns for the first time (instrument fault 7, closed): the opponent at 92-103 px draws
   **219 of 224 primitives in grid and foundry, 213 of 224 in orbital**. The LOD is built, it is
   firing, its threshold is `minPx2 = 2`, and it drops five boxes. It is not a missing feature and it
   is not the second-largest term; it is **mistuned by about an order of magnitude**, and its A/B
   moves the mass count the wrong way by less than the noise floor. The prescription is withdrawn and
   replaced by a threshold sweep nobody has run.
4. **Foundry's numbers are measured on an airborne frame, exactly as grid's were.** The fit sweep for
   foundry exists, in this repository, unread: ticks 760/780/800 are fit and the pinned tick 420 is
   not, with the player 2.52 m up, its contact 130 px below the viewport, and its width 149 px against
   244 px on the ground. **Rank 3 below — the opponent at 4.8% of frame height with 26.1% of its
   contour invisible — is a real defect whose magnitude has never been measured on a frame it could be
   measured on.** `#14`'s foundry half goes to NOT MEASURED; its orbital half was never attempted.
5. **The one thing that got better stayed better.** The mass rule holds in all six cells on the meter
   that reproduces: 4.0-5.5 masses, top-4 84.4-88.4%, spread 0.0 in four of six. Round 6's named
   cause is gone. Nothing in this block touches it.

**The ranked list, re-issued.** Two entries merge, one is withdrawn, one is added:

1. **There is still no CRV2 reference frame in this repository.** Unmoved at rank 1 for two rounds.
   Every number above is scored against a target written from memory. One PNG closes it, and until it
   lands the four-or-five-mass pass at the top of this verdict is a pass against a remembered number.
2. **The arena key light.** Points 2 and 4, merged: it owns half of foundry's highlights, it is in all
   twelve of its top salience tiles, and it is what makes one machine span 91 levels in one arena and
   142 in another. The gate (12.7%) and the cyan rail (3.4%) are symptoms under it with measured
   sizes, not entries. **This is the largest thing between this build and the bar and it is one rig.**
3. **The opponent's outline in foundry** — magnitude unmeasured, see 4 above. Its internal read is
   fixed; its contour is not; and the fit frame it should be scored on is tick 760.
4. **The phone**, unchanged: a different game, never art-directed, and still no card-free gameplay
   capture four rounds after one was asked for.
5. **`N7`**, the bare octahedra, unchanged for six rounds. It is gfx's, not the HUD's.
6. **The review's own method**, which is the entry this round adds and which outranks everything below
   rank 2 in cost. `#2`, `#12`, `#13` and `#14` are re-scored **FIXED (grid); UNVERIFIED elsewhere**;
   the ruling is now in the ledger and not only here; and the sibling finding on the UI half (`N8` — a
   fix verified on desktop is not a fix) makes it one finding about the project, not two coincidences.

*Withdrawn from the list: the silhouette LOD, which was rank 2 for two rounds and is not a missing
feature.*

**What this verdict is still not.** It is not a rejection, and less of one than the two before it.
The build did not regress this round; three of this round's four findings are the review discovering
it had been measuring the wrong frame, the wrong arena, or the wrong object. The gap to the bar is now
**one light rig and one reference photograph** — and the honest reading of that is not that we are
close, but that we finally know which single thing to point at.
