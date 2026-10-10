# Carry on Hook Wars on your home PC

**Purpose:** move Hook Wars development to your home PC and know exactly where the game stands.
**Audience:** Miguel, and Claude Code on the home PC. Assumes Git and a terminal; no game-dev knowledge needed.
**Done when:** on the home PC `npm test` ends with `fail 0`, a solo match starts in the browser build, and two Steam desktop windows play a match through the stand-in lobby ([steam-desktop.md](steam-desktop.md) part B).
**Last verified:** 2026-10-09
**Time:** about 45 minutes, most of it downloads.

**You need:**
- Git, Node.js 25 (nodejs.org), and Steam installed and logged in.
- This repository: `https://github.com/Zarakilian/Hook-Wars` (branch `main` has everything below).
- The reference images, which are not in git (step 1).

**Out of scope:** publishing on Steam. That needs your own Steamworks app first (see "Only you can do these").

## 1. Copy what git does not carry

Two folders live only on the laptop because they are gitignored.

| Folder | What it is | Needed? |
|---|---|---|
| `References_Sources/` | Your 10 reference images (characters and maps) | Yes, for any art work |
| `.notes/` | The detailed session handover log and the workflow scripts | Optional: everything important is in this file |

Copy them into the same place in your home clone after step 2.

**Expect:** `References_Sources/References_hook/` holds 10 PNG files.

## 2. Get the code and check it

```powershell
git clone https://github.com/Zarakilian/Hook-Wars.git; cd Hook-Wars; npm ci
```

**Expect:** `added ... packages`, no `ERR!` lines.

```powershell
npm test
```

**Expect:** about 370 tests, ending with `fail 0`. It takes 1 to 3 minutes.
**If wrong:** note the failing test name and ask Claude to look at it.

```powershell
npm run dev
```

**Expect:** `Local: http://127.0.0.1:5173/`. Open it, click **Play Solo**, and a match starts.

## 3. Run the Steam desktop app

Follow [steam-desktop.md](steam-desktop.md): part A (setup), part B (two windows with the stand-in Steam), then part C (real Steam with a friend). The desktop app was written on the laptop without Electron or Steam installed, so part A step A6 and part B are its first real run. Its "What I have not verified" section lists exactly what to watch.

## Where the game stands

| Area | State |
|---|---|
| Standard edition (no crypto) | Done. Solana work is parked on branch `edition/solana`, untouched |
| Gameplay, 8 maps, bots, 1v1 to 6v6 | Done and tested, including the lobby, HUD and scoreboard at 6 a side. 5v5 is the default and the Quick Play size |
| Cosmetics, Locker, Store, Pearl market | Done. Premium items (US$1.99) show "Available in the Steam version" |
| Online play on your own server | Done. Rejoin, flow control, compression, per-IP limits |
| Steam desktop app (lobbies, P2P relay, Steam Cloud, Epic setting) | Code done, 67 desktop tests with a stand-in. Never run on real Electron or Steam yet |
| Epic graphics (Steam only) | Done: bevelled voxels, lantern lights, mist and shafts, tilt-shift, per-map grade, a reference-angle menu and Locker scene. With Epic off the graphics are proven identical. In a match, a change applies from the next match. GTX 1070 cost is estimated, not measured |
| Steam Inventory, Item Store purchases | Not started: needs your Steamworks app |
| Browser gamepad (twin-stick in matches) | Done: left stick move, right stick aim, RT hook, LT grapple, A or RB bash, D-pad items, Y shop, Start menu. Menus still use the mouse; pad menu navigation is not built |
| Browser layout, short and squarer screens | Done for 1024x768, 1280x1024, 1366x768, 1280x800 and 1440x900: no clipped text, main action in view. The 16:9 sizes (1280x720, 1920x1080, 2560x1440) keep main's CSS and 3D camera. Settings and the lobby's rules column scroll. On 16:10 and the 1366x768 size the map blurbs and Solo preset lines show as tooltips only |
| Controller support (Steam Deck, Steam Input) | Not started |
| Store page art, trailer, achievements | Not started |

## Only you can do these

1. Create a Steamworks partner account and pay the Steam Direct fee (US$100, refunded once the game earns US$1,000).
2. Create the app and note its app id. Then the premium items can become Steam Inventory item definitions, and `desktop/steam_appid.txt` (today 480, Steam's test app) changes to your id.
3. Check the names "Hook Wars", "Lunkers" and "Dredge-Bot" for trademark clashes before the store page goes public.
4. Ask a tax adviser about income from Steam sales.

## Decisions waiting for Miguel

Nothing here is changed yet. The numbers are from the builder's logs and have not been measured again.

1. **Own-hook hand-over feel** (`client/game/ghost.ts`). Current: the predicted head waits at the tip for the server's turn: about 0.10 s on LAN, 0.17 s at 50 ms ping, 0.25 s at 150 ms. A catch overshoots the target by 2.5 to 3 m at 100 ms ping and 4 to 4.5 m at 150 ms. Old blend (kept for Bendy Eel): the head slows to about 7.5 to 14 m/s and never waits. Catches land close to the target.
2. **First pad press.** A pad only reaches the page after a press, and that press is treated as the baseline, so it is lost. If it is Start, the menu does not open and the second press works. Option: open the menu on a Start held at a fresh pad sighting. Side effect: a Start held as a match starts, or a pad plugged in, also opens the menu.
3. **Auto How-to dialog.** On a fresh profile it opens 450 ms after the first menu shows, and nothing cancels it when a match starts. The first Escape or Start then closes it. Option: cancel the timer when a match starts (a few lines in `client/ui/ui.ts`).
4. **Map blurbs and Solo preset lines.** On 16:10 and on 1366x768 they show as tooltips only, so keyboard and pad players never see them. Options: keep it, or build a focus tooltip.
5. **Stand-in bots always play at "normal" difficulty**, whatever the room asks for. Read in the code near `server/room.ts` line 261, not tested.

## Open items, in the order I would do them

1. Run the Steam desktop app for real (step 3) and fix what it finds.
2. Controller support with Steam Input, so the game works on Steam Deck.
3. Steam Inventory and the Item Store for premium items (needs the app id). `steamworks.js` has no inventory API, so this needs the Steam Web API on a server or a small native bridge.
4. Smaller polish: the online own-hook hand-over stall, the online render clock stepping back under heavy jitter, a host-server crash ending a Steam lobby for everyone, mines dropped under a deck drawn on top.
5. Before the first real Steam release: remove `build.extraFiles` (`steam_appid.txt`) from `desktop/package.json`, and consider bumping the pinned Electron version.

## Continue with Claude Code at home

Open the project folder in Claude Code and start with: "Read docs/home-pc-handoff.md and docs/design.md, then continue with the open items." Commits for this repo go out under your personal GitHub account.

## If it fails

| You see | Check | Fix |
|---|---|---|
| `npm ci` errors about the lock file | Node version: `node --version` | Install Node 25, then run `npm ci` again |
| `npm run dev` page is blank | The terminal for build errors | Run `npm run typecheck`; send the first error to Claude |
| The Steam app will not start | [steam-desktop.md](steam-desktop.md) "If it fails" | Follow that table |
| Art work looks wrong against the references | `References_Sources/` copied? | Copy it from the laptop (step 1) |

## Rollback

Not needed: this guide only reads and runs code.

## What I have not verified

- Nothing here has run on your home PC. The Steam desktop app has never run under real Electron or Steam.
- The GTX 1070 frame rates for the Epic setting are estimates scaled from the laptop's integrated GPU, not measurements.
- `npm test` counts change as work lands; "about 370" is from the last full run (372).
- The pad was driven by code and a synthetic pad in headless Chrome, not a real controller.
- The 1366x657 real browser window (the sizes above are viewports, and a window is shorter).
- 16:10 sizes taller than 900 px, such as 1680x1050, and 3:2 sizes such as 1504x1003.
- Browsers other than Chrome. The layout checks used headless Chrome 154 only.
- The Steam build's screens in a real Steam session. They ran with a stand-in bridge.
