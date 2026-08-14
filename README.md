# HOLOSSEUM — Arena Robo Battle

A high-fidelity, browser-native arena battle game in the spirit of **Custom Robo V2**:
build a machine from five part slots, drop into a holosseum, and win the league.

Built with Three.js. No art assets ship with the game — every texture, model,
sound and piece of music is synthesised at runtime.

**▶ Play: https://cadmium2525.github.io/custom_robot/**

---

## Design goals

1. **AAA presentation in a browser tab.** PBR materials, a real bloom pyramid,
   ACES tonemapping, dynamic shadows, layered particle work, procedural audio.
2. **60 fps on an iPhone 12.** Every subsystem has a mobile budget, and an
   adaptive quality controller trades internal resolution before it trades
   features.
3. **Netplay-ready from the first line.** The simulation is deterministic and
   snapshot-able, so rollback netcode over PeerJS is a transport swap, not a
   rewrite.

---

## Controls

| Action | Keyboard / Mouse | Gamepad | Touch |
| --- | --- | --- | --- |
| Move | `WASD` / arrows | Left stick / d-pad | Left virtual stick |
| Camera nudge | Mouse move (hold LMB or lock) | Right stick | Right drag zone |
| Fire (hold to charge) | `J` / Left mouse | `RT` | FIRE button |
| Bomb | `K` / `E` / Right mouse | `X` / `LT` | BOMB button |
| Pod | `L` / `Q` / Middle mouse | `Y` / `LB` | POD button |
| Jump / air jump | `Space` | `A` | JUMP button |
| Dash / air dash | `Shift` | `B` / `RB` | DASH button |
| Pause | `Esc` | `Start` | Pause button |
| Perf overlay | `F3` | — | — |

Your robo **auto-faces its opponent** — as in the source material — so movement
is about spacing and angles, not aiming.

### The charge mechanic

Holding the fire button auto-fires normal shots while the charge builds. Hold
*through* the charge window and the auto-fire stops, the robo visibly spools up,
and releasing lands a much heavier shot. Tap for chip damage, hold for a
committed punish.

---

## Architecture

```
src/
  sim/          Deterministic simulation — no three.js, no DOM, no Math.random
    constants.js    tick rate, tuning, event + projectile enums
    parts.js        parts database (stats AND appearance in one place)
    arena.js        holosseum definitions (collision boxes double as art)
    physics.js      cylinder-vs-rotated-box collision, projectile probes
    world.js        robo state machine, weapons, match flow, snapshot/restore
    ai.js           commander AI — emits InputFrames, gets no privileges
    input.js        InputFrame format + 8-byte wire encoding
  net/
    transport.js    transport interface + lossy loopback for testing
    peer.js         PeerJS WebRTC data channel
    session.js      GGPO-style rollback: prediction, correction, desync checks
  core/
    engine.js       renderer, fixed timestep, render interpolation
    quality.js      device tiering + adaptive resolution/feature control
    input.js        keyboard/gamepad/touch -> InputFrame
    audio.js        procedural Web Audio synthesis and generative music
    mathx.js        deterministic math + seeded RNG
  gfx/
    noise.js        simplex/worley/fbm for texture synthesis
    textures.js     procedural PBR bakery (ORM-packed), VFX sprites
    materials.js    material factory, shell shader, procedural environment map
    stage.js        holosseum geometry, lighting rig, atmosphere
    robot.js        procedural mecha construction + full procedural animation
    vfx.js          projectiles, impacts, explosions, trails, thrusters
    postfx.js       bloom pyramid + composite (tonemap/CA/vignette/grain)
  game/
    camera.js       duel camera rig
    view.js         sim -> presentation bridge, interpolation, event fan-out
  ui/               HUD, menus, touch controls (DOM + CSS)
  main.js           application shell
```

### The determinism contract

`src/sim/` may not import three.js, touch the DOM, call `Date.now()`, or use
`Math.random()`. All randomness flows through the seeded xorshift RNG in
`world.rng`. This is what makes rollback, replays and headless testing possible —
and `npm test` asserts it, so it stays true.

### Rollback netcode

Both peers run the same `World` from the same seed. Each sends its own inputs
with ~10 frames of redundant history over an unreliable WebRTC data channel; the
remote input for the current frame is predicted (repeat-last). When the truth
arrives and disagrees, the session restores the snapshot from that tick and
re-simulates forward with presentation events suppressed, so the player only ever
sees the corrected timeline.

Offline play runs the identical code path with a null transport, which removes
the whole class of "it only breaks online" bugs.

### Performance strategy

- Fixed 60 Hz simulation decoupled from render rate; transforms are interpolated,
  so a 120 Hz display is smooth without doubling sim cost.
- Static level geometry is merged into a handful of draw calls — batch count
  matters far more than triangle count on a tile-based mobile GPU.
- Custom bloom pyramid (bright pass + dual-filter down/up chain) instead of
  `UnrealBloomPass`; only one full-resolution pass in the whole chain.
- Adaptive quality nudges internal render scale first (invisible at a glance)
  and only drops a whole tier when that isn't enough.
- Every particle, projectile and floating damage number is pooled. No allocation
  in the frame loop.

---

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # headless sim/netcode assertions
npm run build
npm run preview      # http://localhost:4173/custom_robot/

# Visual capture (requires a running preview server)
node tools/screenshot.mjs --all
node tools/screenshot.mjs --shot fight --device iphone12
```

Deployment to GitHub Pages happens automatically on push via
`.github/workflows/deploy.yml`.

---

## Credits

Inspired by Nintendo / Noise's **Custom Robo** series. This is an original work
and shares no assets, code or characters with it.
