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

**Expect:** about 340 tests, ending with `fail 0`. It takes 1 to 3 minutes.
**If wrong:** one timing test (`desktop/test/hostRelay.test.ts`, the flood test) can fail when the PC is busy. Run `node --test desktop/test/hostRelay.test.ts` on its own: it should pass.

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
| Epic graphics (Steam only) | Foundation done; the modules' look (characters, props, terrain, water, a reference-angle menu scene) see the last commit message for its final state |
| Steam Inventory, Item Store purchases | Not started: needs your Steamworks app |
| Controller support (Steam Deck) | Not started |
| Store page art, trailer, achievements | Not started |

## Only you can do these

1. Create a Steamworks partner account and pay the Steam Direct fee (US$100, refunded once the game earns US$1,000).
2. Create the app and note its app id. Then the premium items can become Steam Inventory item definitions, and `desktop/steam_appid.txt` (today 480, Steam's test app) changes to your id.
3. Check the names "Hook Wars", "Lunkers" and "Dredge-Bot" for trademark clashes before the store page goes public.
4. Ask a tax adviser about income from Steam sales.

## Open items, in the order I would do them

1. Run the Steam desktop app for real (step 3) and fix what it finds.
2. Controller support with Steam Input, so the game works on Steam Deck.
3. Steam Inventory and the Item Store for premium items (needs the app id). `steamworks.js` has no inventory API, so this needs the Steam Web API on a server or a small native bridge.
4. Smaller polish: the online own-hook hand-over stall, the online render clock stepping back under heavy jitter, a host-server crash ending a Steam lobby for everyone, mines dropped under a deck drawn on top, a 4:3 menu layout.
5. Before the first real Steam release: remove `build.extraFiles` (`steam_appid.txt`) from `desktop/package.json`, and consider bumping the pinned Electron version.

## Continue with Claude Code at home

Open the project folder in Claude Code and start with: "Read docs/home-pc-handoff.md and docs/design.md, then continue with the open items." Commits for this repo go out under your personal GitHub account.

## If it fails

| You see | Check | Fix |
|---|---|---|
| `npm ci` errors about the lock file | Node version: `node --version` | Install Node 25, then run `npm ci` again |
| One `hostRelay` flood test fails in `npm test` | Run that file on its own | If it passes alone it is load timing, not a bug |
| `npm run dev` page is blank | The terminal for build errors | Run `npm run typecheck`; send the first error to Claude |
| The Steam app will not start | [steam-desktop.md](steam-desktop.md) "If it fails" | Follow that table |
| Art work looks wrong against the references | `References_Sources/` copied? | Copy it from the laptop (step 1) |

## Rollback

Not needed: this guide only reads and runs code.

## What I have not verified

- Nothing here has run on your home PC. The Steam desktop app has never run under real Electron or Steam.
- The GTX 1070 frame rates for the Epic setting are estimates scaled from the laptop's integrated GPU, not measurements.
- `npm test` counts change as work lands; the "about 340" is from the last full run.
