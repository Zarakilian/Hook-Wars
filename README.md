# Hook Wars

**Purpose:** Run Hook Wars locally, play solo against bots, or host it for friends online.
**Audience:** Someone comfortable with a terminal and Node.js. No game-dev knowledge needed.
**Done when:** You see the HOOK WARS menu at http://127.0.0.1:5173 (dev) or at your server address (hosted), and a solo match starts.
**Last verified:** 2026-10-09

A voxel hook-brawler. Up to 5v5 Lunkers stand on either side of a river and drag each other across it with chain hooks. Empty slots fill with bots, so you can play alone, with one friend, or with nine.

This is the standard edition: a normal game with no crypto of any kind. It runs in the browser (free, cosmetics earned with Pearls) and is being packaged for Steam (paid, premium cosmetics sold through Steam). An experimental Solana edition is parked on the `edition/solana` branch.

Inspired by the classic Pudge Wars custom game. Every character, name, model and sound here is original and generated in code.

## Features

| Area | What you get |
|---|---|
| Modes | Solo vs bots in the browser, or online rooms on your own server (room browser, 5-letter room codes, quick play, chat) |
| River | Deep Water (fall in and you drown), Dry Bed (walk the channel), Tidal (the water comes and goes, or the river freezes and thaws) |
| Hazards | Thorns, Bristles, or each map's special: quicksand, ice spikes, jellyfish, steam vents |
| Lunkers | Harbour Brawler, Swamp Ogre, Dredge-Bot. Each has a bare base and six cosmetic slots (head, face, outfit, hook, feet, back) |
| Cosmetics | Earned with Pearls from matches, worn in the Locker, traded for Pearls on the Market. Premium items are Steam only |
| Kit | Chain Hook, Grapple, Belly Bash, auto melee, 4 hook upgrades, 8 items, 5 runes and 3 hook power-ups you hook out of the river |
| Maps | Muckmire Bayou, Frostfang Fjord, Coral Cove, Cogwater Canal, Mirelight Marsh, Aurora Harbour, Maelstrom Lagoon, Lanternwharf |

## Play locally

You need Node.js 22.18 or newer. Check with `node --version`.

1. Install dependencies from the npm registry.

```bash
npm install
```

2. Start the dev server. It runs the game client and the multiplayer server together.

```bash
npm run dev
```

**Expect:** a line like `Local: http://127.0.0.1:5173/`.

3. Open http://127.0.0.1:5173 and click **Play Solo vs Bots**.

**Expect:** a 4 second countdown, then your Lunker on the west bank with bots on both teams.

## Controls

| Action | Modern (default) | Classic |
|---|---|---|
| Move | W A S D | Right-click to walk |
| Chain Hook | Left mouse | Q |
| Grapple | Right mouse or Q | E |
| Belly Bash | Space or E | W |
| Items | 1 to 4 | 1 to 4 |
| Shop, scoreboard, chat, menu | B, Tab, Enter (Shift+Enter for team), Esc | same |

Switch schemes in **Settings**.

## Host it for friends on your home PC

The server serves the game and the multiplayer websocket on one port.

1. Build the client.

```bash
npm run build
```

2. Start the server and let other machines connect (PowerShell).

```powershell
$env:HOST = "0.0.0.0"; $env:PORT = "8080"; npm start
```

**Expect:** `Hook Wars 0.1.0 listening on http://0.0.0.0:8080`.
**If wrong:** if friends cannot connect, Windows Firewall is asking you to allow Node.js on private or public networks. Allow it for the network you host on.

3. On your router, forward TCP port 8080 to your PC's local IP address.

4. Send friends `http://<your-public-ip>:8080`. They click **Play Online**, leave the server field empty, and press **Connect**.

**Expect:** they see your server name in the room browser and can join a room by its 5-letter code.

### Server settings

| Variable | Default | What it does |
|---|---|---|
| `HOST` | `127.0.0.1` | Interface to listen on. `0.0.0.0` accepts other machines |
| `PORT` | `8080` | Port for the game and the websocket |
| `SERVER_NAME` | `Hook Wars Server` | Shown in the room browser |
| `MOTD` | a welcome line | Message shown when players connect |
| `MAX_CLIENTS` | `200` | Total connections |
| `MAX_PER_IP` | `6` | Connections per IP address |
| `MAX_ROOMS` | `24` | Concurrent rooms |
| `TRUST_PROXY` | off | Set `1` only behind your own reverse proxy, so the real client IP is read from `X-Forwarded-For` |
| `ALLOWED_ORIGINS` | same host only | Extra browser origins allowed to connect, comma separated |
| `STATIC_DIR` | `dist` | Folder with the built client |

### What the server protects against

The server is authoritative. Clients only send inputs (move direction, aim point, button presses), and the server decides every hit, so a modified client cannot teleport or fake kills. Messages are capped at 4 KB, validated field by field and rate limited per connection. Connections are capped per IP. Names and chat are sanitised and always rendered as text.

It does **not** protect against a large flood of traffic (DDoS) or provide accounts and bans. Run it on a network you are happy to expose, and stop it when you are not playing.

## Develop

| Command | What it does |
|---|---|
| `npm run dev` | Client with hot reload plus the game server on one port |
| `npm run typecheck` | `tsc` over everything |
| `npm test` | Sim soak on every map and mode, mechanics checks, a real two-client websocket match |
| `npm run build` | Production client into `dist/` |
| `npm run check` | All three, the gate before every commit |

Add `?debug` to the URL to get `window.__hookwars` in the console. `__hookwars.solo({ mapId: 'coralcove', riverMode: 'tidal' })` starts a match, and `__hookwars.advance(1000)` steps the game.

Design, rules and module ownership: [docs/design.md](docs/design.md).

## If it fails

| You see | Check | Fix |
|---|---|---|
| `npm install` fails with a network error | Your npm registry with `npm config get registry` | It should be `https://registry.npmjs.org/` |
| Black screen, console says WebGL is unavailable | `chrome://gpu` | Turn on hardware acceleration in your browser settings |
| `Client not built yet. Run: npm run build` | You started `npm start` before building | Run `npm run build` first |
| Friends get "Could not reach the server" | `HOST` is still `127.0.0.1`, or the port is not forwarded | Set `HOST=0.0.0.0`, allow Node.js in the firewall, forward the port |
| "Your game version does not match this server" | Client and server come from different builds | Rebuild, restart the server, refresh the page |
| Low frame rate | Settings, Graphics | Pick `low` or `medium` |

## What I have not verified

- Internet play through a real home router and NAT. Tested on one machine with two browser tabs.
- Performance on low-end GPUs. Quality tiers exist, but nothing has been measured on weak hardware yet.
- Balance with human players. Numbers come from design and bot soaks.

## License

MIT, see [LICENSE](LICENSE).
