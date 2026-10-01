# Mission Impossible

*Designed and developed by **Mahin Jaman**.*

A spy-themed troll platformer for the browser. Infiltrate the facility, grab the
keycard, reach extraction, and survive whatever the trap matrix throws at you:
lasers, tripwires, cameras, crushers, mines, fake keycards, fake doors, EMP
fields, anti-gravity zones... Missions are endless and get steadily nastier.

Pure HTML5 canvas + vanilla ES modules. No dependencies, no build step, no
asset files: every sound and every note of music is synthesized with Web Audio.
Installable as an offline PWA.

## The random trap matrix

- **Every attempt regenerates.** The first try, every death and every restart
  (`R`) builds a brand-new level for the mission from a fresh 32-bit seed
  (`src/gen.js`). You cannot memorise a layout; you have to read it.
- **Never repeats.** A level is a row of encounter *slots*. A slot never gets the
  same encounter as on your previous attempt, and the last 40 matrix
  signatures per mission are stored in your save, so a matrix you have already
  played is rejected and re-rolled.
- **Seeded and verified.** Generation is deterministic per seed, and every
  encounter is built inside the player's physics envelope. A headless beam
  search solver (`src/solver.js`) drives the real simulation to prove levels are
  beatable; `node tools/fuzz.mjs` runs it over thousands of seeds.
- **Scanner.** Hidden traps are invisible until you scan: a sonar pulse that
  tags threats in range (with a cooldown).

## Run

```sh
node tools/serve.mjs          # then open http://localhost:8080
```

Any static file server works. Debug mode: `http://localhost:8080/?debug=1`

| Debug key | Action |
| --- | --- |
| `G` | god mode |
| `H` | show trap zones |
| `N` / `B` | next / previous mission |
| `M` | new matrix (shows matrix code and slots) |

Deep link: `?debug=1&mission=12&seed=123`. Force touch controls on desktop: `?touch=1`.

Regenerate the app icons: `node tools/icons.mjs`.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move | `←` `→` / `A` `D` | slide pad, bottom-right |
| Jump (hold for higher) | `Space` / `↑` / `W` / `Z` | big button, bottom-left |
| Scan | `E` / `Shift` / `X` / `K` | radar button above Jump |
| Restart with a new matrix | `R` | pause menu |
| Pause | `Esc` / `P` | top-right button |
| Menus | arrows + `Enter`, `Esc` back | tap |

## Code map (`src/`)

| File | Role |
| --- | --- |
| `main.js` | app bootstrap, state machine, fixed 60 Hz loop, glue |
| `game.js` | `LevelRun`: pure deterministic simulation of one attempt |
| `gen.js` | procedural mission / trap-matrix generator |
| `solver.js` | headless solver proving generated levels beatable |
| `rng.js` | seeded RNG, matrix codes |
| `level.js` | level parsing, tile grid |
| `traps.js` | every trap type: triggers, motion, hazards |
| `physics.js` | constants and collision |
| `player.js` | player controller and input bits |
| `render.js` | world renderer, camera, particles |
| `fx.js` | post-processing (glow, glitch, briefing burn) |
| `hud.js` | in-game HUD |
| `ui.js` | menus, briefing, debrief, death screen |
| `theme.js` | colours, per-mission accents, fonts |
| `input.js` | keyboard + touch input |
| `audio.js` | synthesized SFX and adaptive procedural music |
| `storage.js` | save data (localStorage) |

`sw.js` is a network-first service worker (bump `VERSION` when files change).
