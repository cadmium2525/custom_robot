# HOLOSSEUM — handover

A Custom Robo V2-style 3D battle-robot action game in Three.js. This document is what a
fresh session needs to resume the work. Written 2026-09-11 at commit `b77fb0a`, branch
`claude/custom-robo-v2-game-195efo`.

---

## 1. What exists and whether it works

The game is **built, playable and tested**. It is not a prototype.

```
npm install
npm test                       # 32 tests, all pass
npx vite build --outDir dist   # clean
npx vite preview --outDir dist --port 4400 --strictPort
node tools/deploycheck.mjs http://127.0.0.1:4400/custom_robot/
```

`deploycheck` plays a full match to a result in all three arenas with a page-error check.
It passes. So does the single-file build:

```
node tools/bundle-single.mjs      # writes dist-single/holosseum.html, ~1.06 MB
```

**`dist-single/holosseum.html` is the deliverable** — one file, open it in a browser and
play. It is a tracked artifact and is kept in step with the tree.

### Architecture

- `src/sim/` — the simulation. **Renderer-free and deterministic at a fixed 60 Hz.** This
  separation is what makes netplay and the test suite possible; do not import rendering
  code into it.
- `src/gfx/` — rendering. `materials.js` (shell/frame/outline/emissive/flare materials and
  their injected shader blocks), `robot.js` (the machine, its palette, LOD and animation),
  `vfx.js` (the effects layer), `postfx.js` (bloom and the composite).
- `src/net/` — PeerJS rollback netplay. `session.js`, `peer.js`, `transport.js`. Covered by
  the test suite over a simulated lossy 120 ms link, with desync and rollback-depth
  assertions.
- `src/core/` — engine loop, quality tiers, clock.
- `src/game/` — view, camera rig, HUD.

### Requirements the user set, and their status

| Requirement | Status |
|---|---|
| Custom Robo V2-level battle robot action game in Three.js | built, playable |
| Runs on an iPhone 12 | quality tiers + per-tier pixel budgets in `src/core/quality.js`; **never measured on real hardware** |
| Designed for PeerJS netplay | implemented and tested (rollback, lossy link) |
| AAA visual quality, judged by a harsh critic | the ongoing work — see §2 |
| Publish to GitHub, deploy via Pages | **blocked, see §6** |

---

## 2. The review system — read this before touching anything visual

`shots/REVIEW2.md` is ~15,000 lines and is the project's real memory. **Do not read it
whole.** Use `tail -400` and `grep`.

It contains:

- **`SPEC-CRV2`** — an eight-clause standard (P1–P8) derived from documented N64 rendering
  facts, plus lettered clauses A–I that the card is scored on. Grep for `SPEC-CRV2`.
  It is explicitly **a written spec, not a photograph**: Custom Robo V2 is copyrighted
  commercial footage and is deliberately *not* scraped into this repository.
- **RULINGS 1–66+** — the critic's binding decisions, numbered in sequence.
- **INSTRUMENT FAULTS 1–47** — defects found in the *measuring tools*. Several invalidated
  the very conclusions they were built to support. This is the single most valuable part
  of the document.

### The standing rules (breaking one is itself a fault)

1. **A mask is a RENDER, not a difference.**
2. **Every figure names its METER and its BUNDLE hash**, hashed off the running server.
   Every contour figure also names its `n`.
3. **Audit the instrument before believing the number.**
4. **A figure no round has re-run is a memory** — re-run it or withdraw it.
5. **Publish rejections with any screened set.** A set without its rejections is a
   selection.
6. **≥ 6 draws on a binding cell.** A foundry contour figure is the **mode of ≥ 6 draws
   with the minority rate published**.
7. **A guard response may not be interpolated.** (Learned twice, the hard way — see §4.)
8. **Never name an AI model** in a commit message, code comment, or any repo artifact.

### The working loop

A round is: **builder measures and changes → critic audits, rules and commits → repeat.**
The critic is a subagent and its evaluation is mandatory. One or two agents at a time
complete rounds; six concurrent agents exhaust the session limit and produce nothing.
**Commit early and often** — several agents have died mid-round and lost uncommitted work.

---

## 3. The instruments

All live captures need a built bundle served over HTTP. Build each variant into a **new**
directory — building over a directory a preview server is already serving silently changes
what it hands out (instrument fault 39).

| Tool | Measures | Key flags |
|---|---|---|
| `tools/contour.mjs` | **clause B** — silhouette legibility | `--arena --tier --ticks --u --mat --hidemat --bloom --keep` |
| `tools/mass.mjs` / `shots/_massdrive.mjs` | **clauses A and C** — mass count, top-4, value ratio | `--onbody --repeat N --u` |
| `shots/_r15dump.mjs` + `shots/_r16chroma.mjs` | **clause D** — machine vs stage chroma | `--dir --u --mat` |
| `shots/_r17-blast.mjs` + `shots/_r25-cover.mjs` | **clause F** — the effects layer | `--tick --ages --kill --stenconly` |
| `shots/_r40-where.mjs` | **where** weak contour pixels are | reads `contour --keep`'s PNGs |
| `shots/_r44probe.mjs` | per-model state dump after the settle | diagnosing pose/LOD faults |
| `tools/deploycheck.mjs` | full playthrough, all arenas | takes a URL |

**Applier contract** (instrument faults 29 and 43): every `--u`, `--mat` and `--hidemat`
**resolves both spellings, verifies by read-back, and ABORTS on a miss.** A warning a caller
can redirect is not a guard — that fault produced a whole clause D reading whose treatment
and control were the same render.

**The stencil exists in nine copies.** Fix any stencil defect in all nine *at once*, found
by searching for the guard line, not by listing files from memory. Faults 19, 36 and 47 were
all stencil defects and the first took three sweeps because the files were listed from
memory.

---

## 4. Where the visual work actually stands

### Clause B (silhouette) — the live front

Baseline and the best candidate, bundle `586e670836d3`, threshold 90:

```
  cell                  baseline   candidate   verdict
  grid    near  n=1025    86.0       97.4      PASS
  grid    FAR   n=275     84.4      100.0      PASS
  orbital near            89.4      100.0      PASS   (informative, not gating)
  orbital FAR             68.6       90.4      PASS   (informative, not gating)
  foundry near  n=560     74.6       87.7      -2.3
  foundry FAR   n=132     54.5       86.4      -3.6
```

The candidate is `uPaintLiftFar = 0.157, uFrameLift = 0.157, uPaintWhite = 1`.

**It is REFUSED**, on two guards measured at full lift on grid:

```
  A FAR count   5.5 -> 3.0    needs [4.0, 6.0]    the masses MERGE
  C FAR ratio  1.288 -> 1.455 needs <= 1.338
```

The mechanism is understood and is not a bug: **the line art is what separates the masses.**
`pal.dark` is the recesses and seams, so lifting it toward the plates it divides merges them,
which is exactly what clause A counts and clause C measures.

**Half the lift is not half the merging** — measured, and *both* clause C ratios come back
**worse** at half lift than at full. The guard response is non-monotone. Sample the interval;
do not interpolate.

### The knobs (all ship at 0.0 — nothing visual has changed in the tree)

| Uniform | Material | Gate |
|---|---|---|
| `uPaintLift` / `uPaintLiftFar` | shell | near / far by `sizeGateX()` |
| `uFrameLift` / `uFrameLiftFar` | line art | near / far |
| `uPaintTint`, `uPaintWhite` | direction of the lift | 0 = paint hue, 1 = white |

The lift is added **after** the colour-space stage, so it is in **display sRGB levels**
(0.157 ≈ +40 of 255). The tint is normalised by luminance *in that space* — normalising a
linear triple and adding it to an encoded one was instrument fault 42.

### The verdict

**HOLOSSEUM does not yet win a blind side-by-side against Custom Robo V2.** Two of six blind
points pass. The honest summary of the last several rounds is that most movement came from
finding the *instruments* wrong, and the largest single correction (fault 47) moved a clause
cell 13.5 points with no renderer change at all.

---

## 5. Outstanding debts, in priority order

1. **Sample the `uFrameLift` interval properly** against clause A and C. It is non-monotone,
   it has no six-draw reading of its own, and it is the strongest unspent lever on the card.
2. **Orbital's guards are unmeasured** under the candidate — clause A and C there have never
   been read.
3. **Foundry's two cells** are short by 2.3 and 3.6 and are the only ones the candidate
   cannot carry.
4. **The foundry minority pose** — 1 draw in 6 (and grid 1 in 12, worth 4.2 points) lands in
   a different frame entirely. It is *load-gated*, so a quiet box hides it. Undiagnosed;
   it is why the six-draw rule exists.
5. **iPhone 12 performance has never been measured on hardware.** The tiers are reasoned,
   not tested.
6. **GitHub Pages deployment** — `.github/workflows/deploy.yml` exists and has never run.

---

## 6. The push situation

`git push` currently fails:

```
remote: Claude doesn't have GitHub access to cadmium2525/custom_robot for your organization.
fatal: ... 403
```

**All 355 commits are local on `claude/custom-robo-v2-game-195efo`.** The full history is in
the `.git` directory included in this archive — the commit messages are a substantial part of
the project's reasoning and should not be squashed or discarded. Once access is granted:

```
git push -u origin claude/custom-robo-v2-game-195efo
```

Do not create a pull request unless asked.

**Commit trailers** — every commit ends with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <the session URL>
```

---

## 7. Traps that have each cost this project real time

- **A backtick inside a GLSL template literal** in `src/**.js` breaks the vite build while
  `npm test` still passes. Cost two builds, once in a comment.
- **A C-style comment terminator written literally inside a CSS comment** in `index.html`
  silently deletes the following rule. Cost a whole canvas-sizing regression, twice.
- **`tail -N` on a tool's output** can cut off the line you are about to file a fault about.
  One fault was false for exactly that reason and had to be struck.
- **Rebuilding into a directory a preview server is serving** changes what it serves with
  nothing in the terminal to say so. Re-read the bundle hash after every rebuild.
- **`npm test` passing does not mean the build is clean.** Run both.
