# Run Hook Wars as a Steam desktop app on your home PC

**Purpose:** build and run the Steam desktop app (`desktop/`), first with the stand-in Steam on one PC, then with real Steam and a friend.
**Audience:** Miguel on his home PC. You know the game and npm; you have not run Electron or Steamworks with this project before.
**Done when:** two windows on one PC play a match through a stand-in lobby (part B), and a friend on another PC joins your real Steam lobby (app 480) and plays a match with you (part C).
**Time:** about 30 min for part A (Electron is a ~100 MB download), 10 min for B, 30 min for C.
**Last verified:** 2026-10-09, on the work laptop: the build, the server bundle, the 67 desktop tests (including a 6v6 match through the relay) and the root test suite. Parts A to C have not been run yet, because Electron and Steam cannot be installed there.

**You need:**
- Windows 10 or 11, a terminal (PowerShell or Git Bash), Git
- A Steam account, and for part C a friend with a Steam account
- The repo: `https://github.com/Zarakilian/Hook-Wars.git`, branch `wip/art-pass` (personal identity)

**Out of scope:** the browser build and the dedicated server itself (see `docs/design.md`), and Steam Inventory (premium items), which comes in a later phase.

**How a Steam lobby works, in three lines:**

| Who | What runs on their PC |
|---|---|
| Host | the normal game server on `127.0.0.1` (never on the internet), plus a Steam lobby. Remote players reach it only through Steam's relay. |
| Joiner | a tiny relay on `127.0.0.1` that carries the game's WebSocket over Steam P2P packets to the host |
| Both | the same game page. It only ever sees an ordinary `ws://127.0.0.1:<port>` address. |

---

## A. One-time setup

### A1. Install Node 25

Download the **Current** Windows installer (25.x) from `https://nodejs.org` and run it.

```powershell
node --version
```

**Expect:** `v25.` followed by any numbers.

### A2. Install Steam and log in

Install from `https://store.steampowered.com/about/` and log in. Leave it running.

**Expect:** your friends list shows you as Online.

### A3. Get the code

```powershell
git clone https://github.com/Zarakilian/Hook-Wars.git; cd Hook-Wars; git checkout wip/art-pass
```

If you already have a clone, run `git pull` on that branch instead.

**Expect:** a `Hook-Wars` folder, and `git branch` shows `* wip/art-pass`.

### A4. Install the root packages

The desktop build uses vite and three from the project root, so this comes first.

```powershell
npm ci
```

**Expect:** `added ... packages`, no `ERR!` lines.
**If wrong:** skipping this makes A6 fail with `Cannot find package 'vite'`.

### A5. Install the desktop packages

From the official npm registry only. What each package is and what it downloads is in "Vetting notes" at the bottom.

```powershell
cd desktop; npm install
```

**Expect:** `added ... packages`. A new `desktop/package-lock.json` appears: commit it, so the next install is identical.

### A6. Check it against the real Electron types, then run the tests

```powershell
npm run typecheck:electron; npm test
```

**Expect:** no output from the typecheck, then `ℹ fail 0` at the end of the tests.
**If wrong:** a type error in `src/main.ts` or `src/preload.ts` means the real Electron API differs from `src/electron-shim.d.ts`. Send me the error.

---

## B. Two windows on one PC with the stand-in Steam

The stand-in replaces Steam with a small hub on `127.0.0.1:27999`, so you can test lobbies without Steam or a second PC. Run these from `desktop/`.

### B1. Start the first window

```powershell
npm run start:fake
```

**Expect:** a "Hook Wars" window opens, and the terminal prints `[fakesteam] started the stand-in hub on 127.0.0.1:27999`.

### B2. Start the second window, in a second terminal

```powershell
cd desktop; npm run start:fake2
```

**Expect:** a second window, and `[fakesteam] joined the stand-in hub` in that terminal. It has its own profile, so its own locker.

### B3. Host a lobby in window 1

Main menu → **Play with Steam** → **Host Lobby**.

**Expect:** the Play with Steam screen shows a **Stand-in Steam** badge, then **Host Lobby** opens the lobby screen with an **Invite friends** button.

### B4. Join it from window 2

Main menu → **Play with Steam** → the refresh icon → **Join** on window 1's lobby.

**Expect:** both names in the lobby on both windows.

### B5. Play a match

Both press **Ready**, then window 1 presses **Start Match**.

**Expect:** both windows show the match, and each window sees the other player's Lunker move.

### B6. Leave as the host

In window 1, press **Leave**.

**Expect:** window 2 drops back to the Steam screen with "The host left, or the connection to the host was lost." No error dialogs, no frozen window.

---

## C. Real Steam (test app 480) with a friend

Until your own Steamworks app exists, the app runs as Steam's public test app 480, "Spacewar". Its lobbies are shared with every developer, so the game filters them by `game=hookwars` and the protocol version.

Upload the host needs: about 5.5 KB/s per joiner in a 6v6 match, so about 60 KB/s for a full lobby of 12 (measured through the stand-in relay). Any home connection has that.

### C1. Start the app on real Steam

With Steam running, from `desktop/`:

```powershell
npm start
```

**Expect:** the terminal prints `[steam] Steam is running: app 480, player <your Steam name>`. Steam shows you as "Playing Spacewar". **Shift+Tab** opens the Steam overlay over the game.
**If wrong:** `using the stand-in` in the terminal means Steam was not found. Check Steam is running and logged in, then start again.

### C2. Build a copy for your friend

```powershell
npm run dist
```

**Expect:** a folder `desktop\dist\win-unpacked` with `Hook Wars.exe` and `steam_appid.txt` in it. Zip that folder and send it to your friend.

### C3. Your friend starts the game

Your friend starts Steam, unzips the folder and runs `Hook Wars.exe`. Windows SmartScreen may say "Windows protected your PC": **More info** → **Run anyway** (the build is not code-signed).

**Expect:** Steam shows your friend as "Playing Spacewar".

### C4. Host and invite

You: **Play with Steam** → **Host Lobby** → **Invite friends** → pick your friend in the overlay. Your friend accepts the invite in Steam chat **while Hook Wars is already running**.

**Expect:** your friend lands in your lobby, and both of you see both names.
**If wrong:** if your friend accepts while the game is closed, Steam starts Spacewar instead. Close it, start Hook Wars, accept again.

### C5. Play a match

Both press **Ready**, then you press **Start Match**.

**Expect:** a normal match. Your friend's movement looks the same as in part B.

### C6. Leave as the host

Press **Leave**.

**Expect:** your friend drops back to the Steam screen with the host-left message, the same as B6.

---

## Play on your own dedicated server from the Steam build

The Steam build's page comes from `app://hookwars`, so your server must allow that origin.

1. In your server's `.env` file, add this line (or add `,app://hookwars` to the end of an existing `ALLOWED_ORIGINS` line), then restart the server:

   ```
   ALLOWED_ORIGINS=app://hookwars
   ```

2. In the Steam build: **Play Online** → type your server address → connect.

**Expect:** the room list loads, exactly as in the browser build.
**If wrong:** an immediate disconnect means the server answered `403 Forbidden`: the `ALLOWED_ORIGINS` line is missing or the server was not restarted.

---

<details>
<summary><b>D. Once your own Steamworks app exists</b> (do this before launch, not now)</summary>

| # | Do this | Where | Note |
|---|---|---|---|
| 1 | Pay the Steam Direct fee (US$100 per app, paid back after US$1,000 in sales) | `https://partner.steamgames.com` | Bank, tax and identity checks come first. You cannot release earlier than 30 days after paying. |
| 2 | Put your app id in `desktop/steam_appid.txt` instead of `480` | this repo | Nothing else in the code names 480. Lobbies then contain only your players. |
| 3 | Remove the `extraFiles` entry (the `steam_appid.txt` copy) from `build` in `desktop/package.json` before the first release build | this repo | The shipped game is started by Steam, which supplies the app id. `desktop/test/package.test.ts` checks this entry, so change the test in the same commit. |
| 4 | Turn on Steam Cloud with a small quota (1 MB, 10 files is plenty) | Steamworks → your app → Application → Steam Cloud | The locker saves there. Without it the game falls back to the PC's own storage. |
| 5 | Create a Windows depot and upload `desktop\dist\win-unpacked` with SteamPipe | Steamworks → SteamPipe, and `steamcmd` with an `app_build` `.vdf` from the Steamworks SDK ContentBuilder | Set the launch option to `Hook Wars.exe`. |
| 6 | Build the store page: capsules, screenshots, trailer, the Early Access questions, price US$4.99 | Steamworks → Store Page | The store page and the first build are each reviewed by Valve, which takes a few working days. |
| 7 | Fill in the age rating questionnaire (content survey) | Steamworks → Store Page → Ratings | Needed before the page can go live. |
| 8 | Publish the Coming Soon page at least 2 weeks before launch | Steamworks → Store Page | Valve requires it. Plan the launch date from this. |
| 9 | Check the names "Hook Wars", "Lunkers" and "Dredge-Bot" for trademarks | USPTO trademark search, EUIPO TMview, and the Steam store | "DREDGE" is an existing fishing game (Black Salt Games, 2023), so look hard at "Dredge-Bot". If anything is close, rename it or ask a trademark lawyer. |
| 10 | Premium items as Steam Inventory item definitions (a later phase) | Steamworks → Community → Inventory Service | steamworks.js has no inventory API, so ownership checks need another binding or the `IInventoryService` Web API from a server. That needs a publisher Web API key, which is a secret: never in the repo or the client. Until then premium items stay stripped in player-hosted lobbies. |

</details>

---

## If it fails

| You see | Check | Fix |
|---|---|---|
| `Electron is not installed` | Did A5 run inside `desktop/`? | `cd desktop; npm install` |
| `Cannot find package 'vite'` | Did A4 run in the project root? | Run `npm ci` in the root, then try again |
| Terminal says `using the stand-in` when you wanted real Steam | Steam is running and logged in, and `desktop/steam_appid.txt` says `480` | Start Steam, log in, run `npm start` again |
| Window opens but stays dark, or DevTools (Ctrl+Shift+I) shows CSP, CORS or MIME errors for `./assets/...` | The log at `%APPDATA%\Hook Wars\hookwars-desktop.log` | Send me the DevTools error lines and the log |
| Your lobby is not in your friend's list | Steam returns about 50 nearby app 480 lobbies before the game filters them, so a busy 480 can push yours out | Use **Invite friends** (C4) instead of the list |
| `npm run dist` fails with `Cannot create symbolic link` | electron-builder unpacking its Windows tools | Turn on Windows Developer Mode (Settings → System → For developers), then run `npm run dist` again |
| Friend presses **Join**, waits, and drops back after about 10 seconds | `[relay]` lines in both logs (`%APPDATA%\Hook Wars\hookwars-desktop.log` on each PC) | Send me both logs: the Steam P2P session to the host did not open |
| Everyone drops back to the Steam screen at once, the host with "Your lobby server stopped" | `[server]` lines in the host's log (`crashed`): the host's game server crashed. Today a crash ends the lobby for everyone | Send me the host's log. Host a new lobby to keep playing |
| A friend drops with "The host dropped the connection (too many packets)" or "(bad data)" | `[relay] dropped` in the host's log | Should never happen in normal play. Send me both logs. The friend can rejoin after 30 seconds |

## Rollback

- Delete `desktop/node_modules`, `desktop/build` and `desktop/dist`. Nothing outside `desktop/` is installed or changed, apart from the `desktop:*` scripts in the root `package.json`.
- The stand-in keeps each window's profile in `%APPDATA%\Hook Wars` and `%APPDATA%\Hook Wars-2`. Delete those folders to start fresh.
- On the dedicated server, remove `app://hookwars` from `ALLOWED_ORIGINS` and restart it.

## What I have not verified

- Nothing in parts A to C has been run. Electron, steamworks.js and Steam were not installed on the work laptop. What did run there: the server bundle under plain Node with `ECONOMY=trust`, the client build, and 67 tests. The tests use the stand-in Steam and a fake steamworks.js object.
- `src/main.ts` and `src/preload.ts` were type-checked only against a hand-written `src/electron-shim.d.ts`. A6 is the first check against the real Electron 44 types.
- The steamworks.js calls were written from its `client.d.ts`, and checked on 2026-10-09 against the published 0.4.0 `client.d.ts`, `callbacks.d.ts` and `index.js` (callback ids, payload field names, enum values). These have not been seen working: the overlay in Electron, invites, `+connect_lobby` and Steam Cloud on app 480.
- **Copy** for the room code: the app denies every permission request, so the page's clipboard call falls back to the older copy command. Check that **Copy** in the lobby still puts the code on the clipboard.
- Whether steamworks.js `getLobbies()` can filter on the Steam side is unknown. The game filters after Steam returns the list.
- That Electron's install step downloads its binary from GitHub releases and checks it against checksums is from Electron's documentation. `npm view` did not show its install script.
- `npm run dist` (electron-builder) has not been run, so the packaged app and `asarUnpack` are untested.
- The Steamworks steps in part D come from Valve's public rules as I know them. Check the fee, the 30-day wait and the 2-week Coming Soon rule in the Steamworks docs when you get there.

<details>
<summary><b>Vetting notes for the new packages</b> (desktop/package.json, exact versions, official npm registry)</summary>

Integrity hashes are from `npm view <pkg>@<version> dist.integrity` on 2026-10-09. After A5, the same values appear in `desktop/package-lock.json`.

| Package | Version | Licence and source | What it downloads or ships | Integrity |
|---|---|---|---|---|
| `electron` | 44.4.5 (2026-09-23) | MIT, `github.com/electron/electron` | Its install step downloads the Electron binary from the project's GitHub releases and checks it against the checksums in the package. Newer 44.x patches exist (44.7.0 on 2026-10-07): move up after reading their notes. | `sha512-SjgoaeYsSWZfJzubgQU7juvuXMTvn6/e1gAHdGFA/yuMbpF+I+skYqIJ6DdXBXHeWbkbpNpmwZCTpiivtlWZSw==` |
| `electron-builder` | 26.15.3 (the `latest` tag) | MIT, `github.com/electron-userland/electron-builder` | Dev only. Downloads its Windows tools from the project's GitHub releases the first time `npm run dist` runs. | `sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==` |
| `steamworks.js` | 0.4.0 (2024-08-06, newest) | MIT, `github.com/ceifa/steamworks.js` | No install script. Ships a prebuilt native module (`.node`, Rust) and Valve's `steam_api64.dll` inside the package (8.9 MB). | `sha512-O5TTRs7ucCRql4IA/kYUIQYeghTsXqf3rAm81sC22RDId264LQYqQjuaMEUSqL60I5LdULiGu0W2/A+ZDcKBKA==` |
| `ws` | 8.22.0 | MIT, `github.com/websockets/ws` | Nothing. The same version the game server already uses. | `sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==` |

</details>
