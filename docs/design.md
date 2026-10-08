# Hook Wars design

**Purpose:** Single source of truth for what Hook Wars is, how it plays and how the code is split.
**Audience:** Anyone building or reviewing the game. Assumes TypeScript and basic three.js.
**Done when:** You can say which file owns a feature and which contract it must keep.
**Last verified:** 2026-10-08

Hook Wars is a voxel hook-brawler for the browser. Two teams of up to 5 Pudgies stand on either side of a river and drag each other across it with chain hooks. It is inspired by the classic "Pudge Wars" custom game, but every character, name and asset is original.

## The one-line pitch

Think of it as fishing for your friends. Your hook is the rod, the river is the danger, and the catch is an enemy Pudgy dragged onto your bank and beaten up.

## Rules

| Rule | Value |
|---|---|
| Teams | Red Tide (team 0, west, -X) and Blue Gill (team 1, east, +X) |
| Team size | 1 to 5, empty slots filled with bots (Easy, Normal, Hard, Brutal) |
| Win | First to `killsToWin` (5 to 50, default 30), or most kills when `timeLimitSec` ends. A tie goes to overtime: next kill wins |
| Scoring | Every death scores a point for the other team, including drownings and hazard deaths |
| Respawn | 5 s, +0.35 s per death, max 10 s, then 2 s of spawn protection |
| Home fountain | Heals your team 10% max HP per second, burns invaders 28% per second |

## River modes (per match)

| Mode | What it does | Maps |
|---|---|---|
| Deep Water | Nobody can walk into the river. Anyone knocked, dropped or grappled into it drowns in 2 s unless they swim out or get hooked out | all |
| Dry Bed | The channel is a walkable, slightly slow river bed | all |
| Tidal | The water comes and goes on a timer with warnings | Coral Cove (tide), Cogwater Canal (lock gates flood), Frostfang Fjord (freezes solid, then cracks and thaws). Muckmire has no tide and falls back to Deep Water |

Tide cycle for `tide` and `locks`: low (walkable) → rising (wading, slow, horn warning) → high (deep, lethal) → falling. For `freeze`: frozen (walkable slippery ice) → cracking (warning) → thawed (deep, lethal) → freezing. Code: `shared/sim/river.ts`.

## Hazards (per match)

`none`, `thorns`, `bristles`, `special` (the map's own), `mixed`. Slots come from each map. In Deep Water mode only bank slots are used.

| Hazard | Effect |
|---|---|
| Thorns | slow 30%, 18 damage per second |
| Bristles | touch: 35 damage and a shove |
| Quicksand (Muckmire) | slow 55%, eats you if you stand still |
| Ice Spikes (Frostfang) | crack warning, then erupt every 5 s: 90 damage and a knock-up |
| Jellyfish (Coral Cove) | slow 25%, 24 damage per second |
| Steam Vents (Cogwater) | hiss warning, then blast every 4 s: 60 damage and big knockback |

## Pudgies

Three families, one shared kit, one small passive each. They must never look like Pudge: no stitched flesh, no exposed guts, no cleaver, no rot.

| Family | Look | Passive |
|---|---|---|
| Harbour Brawler | big-bellied fishmonger, team-coloured rubber apron, wellies, hats, barbed fishing hook on a rope | Sea Legs: +8% move speed |
| Swamp Ogre | mossy, warty, tusked bog troll, bone and vine hook | Mudskin: doubled regen out of combat |
| Butcher-Bot | riveted barrel-bellied robot, steam vents, glowing visor, crane claw | Overclock: hook cooldown -8% |

Cosmetic option names live in `client/render/contracts.ts` as `COSMETIC_NAMES`: 8 hats, 8 accents and 6 faces per family.

## Kit

| Ability | Modern keys | Classic keys | What it does |
|---|---|---|---|
| Chain Hook | Left mouse | Q | 0.12 s wind-up, then a skillshot. Drags the first unit it hits back to you. Hooks that meet in flight clash and both retract. Hooking an ally saves them |
| Grapple | Right mouse or Q | E | Latches onto a tree, rock, wall or unit and flies you to it. You can cross the river. Works while drowning |
| Belly Bash | Space or E | W | Short cone shove: 70 damage, 6 m knockback, interrupts hooks |
| Wallop | automatic | automatic | Melee swing at an adjacent enemy, 45 damage per second |
| Items | 1 to 4 | 1 to 4 | Use consumables |
| Shop, scoreboard, chat, menu | B, Tab, Enter, Esc | same | |

Hook upgrades: Damage, Range, Speed and Width, 5 levels each. Items: Ricochet Spring, Ember Barb, Lucky Sinker, Iron Gut, Swift Wellies, Bramble Mine, Healing Pie, Puffball. Runes spawn on river spots every 40 s, and you hook them to claim them: Haste, Double Damage, Iron Skin, Ghost, Bounty. All numbers are in `shared/constants.ts`.

## Maps

| Map | Mood | Special | Movers | Tidal style |
|---|---|---|---|---|
| Muckmire Bayou | dusk swamp, fireflies, mud island | Quicksand | drifting logs | none |
| Frostfang Fjord | night glacier, aurora, snow | Ice Spikes | ice floes | freeze and thaw |
| Coral Cove | sunny turquoise lagoon, waterfall, whirlpool that bends hooks, bouncy reef posts | Jellyfish | raft | tide |
| Cogwater Canal | rainy night harbour, brick and brass | Steam Vents | barges | lock gates |

Map data lives in `shared/maps/*.ts` (format: `shared/maps/types.ts`). One map definition drives collision, river, spawns and the visuals. The layout is 72 m by 48 m, with the river along Z through x = 0.

## Architecture

```
shared/   game rules. Runs on the server (online) and in the browser (solo). No DOM, no three.js.
server/   Node websocket server: rooms, lobby, 30 Hz authoritative ticks, hardening.
client/   browser: app controller, netcode, input, camera, render modules, audio, UI.
tests/    node --test: sim soak, mechanics, end-to-end websocket match.
```

| Layer | Detail |
|---|---|
| Sim | Fixed 30 Hz tick (`shared/sim/sim.ts`). Server authoritative. Bots use the same input path as humans |
| Snapshots | JSON, per-team view at 30 Hz. Stealthed enemies and enemy mines are never sent |
| Client netcode | Own walking is predicted with the same `stepMove` and reconciled on every snapshot. Others are interpolated about 2.5 ticks behind. Cast feedback plays instantly on key press |
| Solo | `LocalSession` runs `GameSim` in the page. Same client code path, zero latency |
| Server hardening | 4 KB max message, token-bucket rate limit, per-IP and total connection caps, strict validation in `shared/protocol.ts`, slow-consumer protection, same-origin check, CSP and security headers |

## Module ownership and contracts

Every render, audio and UI module implements an interface in `client/render/contracts.ts` or `client/ui/types.ts`. Implementations may improve freely, but signatures stay fixed.

| Module | Files | Contract |
|---|---|---|
| Engine (renderer, sky, lights, post, weather) | `client/render/engine.ts` (+ `engine/`) | `Engine`, `SceneCapture`, `WATER_LAYER` |
| Water | `client/render/world/water.ts` (+ `water/`) | `WaterView`, `waterY()` |
| Terrain and map art | `client/render/world/terrain.ts` (+ `terrain/`), `shared/maps/*.ts` | `WorldView`, `groundY()`, `bedY()` |
| Characters | `client/render/models/pudgy.ts` (+ `pudgy/`) | `PudgyView`, `PudgyPalette`, `COSMETIC_NAMES` |
| Props, decor, movers, hazards, runes, mines, fountains | `client/render/models/props.ts` (+ `props/`) | `HazardView`, `AnimatedView` and the `build*`/`create*` functions |
| Effects and hook chains | `client/render/fx/fx.ts` (+ `fx/`) | `FxSystem`, `ChainView` |
| Audio | `client/audio/**` | `AudioSystem`, `SfxId` |
| UI and HUD | `client/ui/**` | `UI`, `Hud`, `HudFrame`, `AppActions` |
| Bots | `shared/sim/bots.ts` (+ `bots/`) | `updateBots(sim)` |
| Glue | `client/game/*`, `client/app.ts`, `client/net/*` | owns the contracts |

Vertical layout every module uses: the bank top is at `groundY(map)` (about 1.2 m), the river bed at `bedY(map)`, and the water surface at `waterY(map, level)`. Models face +Z at `rotation.y = 0`. The sim's facing angle `f` means direction `(sin f, cos f)`.

## Rules for all code

- TypeScript with erasable syntax only (no `enum`, `namespace` or parameter properties), `.ts` import extensions, and `import type` for types. Node runs `shared/` and `server/` directly.
- three.js 0.186 `WebGLRenderer` with GLSL. No WebGPU or TSL.
- No downloaded assets. Every model, texture and sound is generated in code. Fonts come from npm `@fontsource` packages.
- Text from players always goes through `textContent`, never `innerHTML`.
- Gate before any commit: `npm run typecheck`, `npm test` and `npm run build` all pass.

## Running it

```bash
npm install
```

```bash
npm run dev
```

Dev serves the client with hot reload and the game server on the same port (default http://127.0.0.1:5173, websocket `/ws`).

```bash
npm run build
```

```bash
npm start
```

Production serves `dist/` and `/ws` on `PORT` (default 8080). Set `HOST=0.0.0.0` to accept players from other machines. Other settings are in `server/config.ts`.

## What I have not verified

- Performance on a low-end GPU. The quality tiers exist, but no measurements yet.
- Internet play through a home router. Tested on localhost with 2 browser tabs and bots only.
- Balance numbers. They come from the design and a bot soak, not from human playtests.
