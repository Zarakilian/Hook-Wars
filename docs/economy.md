# Hook Wars economy: Pearls, the Pearl store and the Pearl market

**Purpose:** Explain how players earn, buy, own and trade cosmetics in the standard edition, where the data lives, and what to do when the economy will not start.
**Audience:** Miguel and anyone working on the store, locker, market or server. No crypto involved anywhere.
**Done when:** `npm test` passes `tests/economy.test.ts`, and a player online gets an account, earns Pearls in a match, buys a cosmetic, wears it, and still has it after a page reload and a server restart (including a hard kill).
**Last verified:** 2026-10-09

The game server owns every online account and item. Pearls are the only currency in this build. Premium items are for the future Steam version and are never sold, granted or worn here.

The Solana / NFT / USDC design is parked on git branch `edition/solana`. Nothing from it is in this tree.

## The three builds

| Build | Currency | Store | Market | Premium items |
|---|---|---|---|---|
| Free browser build (solo) | Pearls, kept in this browser only (`hookwars.locker.v1`), solo pays half rate | Pearl store | None offline | Shown as "Available in the Steam version" (`isSteam()` in `client/platform.ts` is false) |
| Browser or app on a dedicated server (`server/index.ts`) | Pearls on the server account | Pearl store | Pearl market, Epic items only | Not sold. Never counted as owned |
| Steam version (later phase) | Pearls, plus real money through Steam | Pearl store, plus premium items in Steam's Item Store | Pearl market, plus premium items on the Steam Community Market | Bought for real money (`usd` price in `shared/cosmetics.ts`); Steam converts per region |

TODO: design the Steam phase (Steam Inventory Service as the source of truth for premium items, server checks). Nothing for it is built yet.

## Items

| Rarity | How you get it | Tradable |
|---|---|---|
| Default | Everyone owns the family's default set | No |
| Common, Rare | Pearl store | No |
| Epic | Pearl store, or the Pearl market | Yes, for Pearls |
| Premium | Steam version only (later) | On Steam only |

No item has stats. Cosmetics never change gameplay.

## Accounts and tokens

- `hello` without a token creates a guest account and replies `{t:'account', a, token}`. The token is 32 random bytes in base64url (43 characters). The server stores only `sha256(token)`.
- A known token loads its account. An unknown token **in the issued shape** is kept: the server binds a new account to it and sends no new token, so the browser never throws a token away. Any other unknown token gets a new one.
- The browser keeps one token per server in `hookwars.tokens.v1`. If a server ever hands out a different token, the old one moves to `hookwars.tokens.prev.v1` (5 per server), so an account can still be recovered by hand.
- Online accounts start with 0 Pearls (`STARTING_PEARLS`), so free guest accounts cannot mint Pearls.
- One internet connection (an IPv4 address, or an IPv6 /64) can make 20 new accounts an hour. The 21st gets `econError` code `account_limit`, and the client economy puts the reason in `state().accountError` for the screens to show instead of "Signing in...". The same browser coming back within the hour does not count twice.
- Empty guests (no Pearls, no items, no matches) are never written to disk and leave memory when their last socket closes. Their token still works next time.
- If no account and no reason arrive within 15 s (`SIGN_IN_MS`), the client says "This server did not sign you in".

## Earning Pearls: the anti-farm rules

| Rule | Value |
|---|---|
| Pearls per match | `matchPearls(won, kills, hooksHit, saves)` from `shared/cosmetics.ts`, at most 200 |
| Full rate needs | Humans on at least 2 different internet connections in the match |
| Otherwise | `SOLO_PEARL_RATE` = half rate (also offline solo) |
| Two tabs on one account | Paid once per match |
| Never threw a hook | No Pearls (stats still count) |
| Daily cap per account | `DAILY_PEARL_CAP` = 2,000 per UTC day |
| Daily cap per internet connection | `DAILY_PEARL_CAP_PER_IP` = 4,000 per UTC day, all accounts on it together |

Each player gets `{t:'reward', pearls, reason}` and an updated account. The reason names the limit that stopped them. Match Pearls are committed to disk at once, every player of the match in one transaction.

The per-connection cap is why throwaway accounts do not help: five accounts on two connections earn at most 8,000 a day between them, not 10,000, and none of it can reach a main account through the market on day one (next section).

## Store and market rules

| Action | Rule |
|---|---|
| Store buy | Price from the catalog, never the client. Refused if already owned or short of Pearls. Premium items answer `steam_only` |
| Who may trade | An account at least a day old (`MARKET_MIN_AGE_MS`) with at least 10 online matches (`MARKET_MIN_MATCHES`). Otherwise `too_new`, with how long is left |
| List for sale | Epic items only, 50 to 1,000,000 whole Pearls, at most 20 listings per account |
| While listed | Held in escrow: still in the inventory, cannot be worn |
| Buy | Buyer pays the price. Seller gets the price minus 5% (`MARKET_FEE_BPS` = 500, rounded up, at least 1). The fee leaves the economy. Both sides and the listing are saved in one transaction |
| Cancel | Seller only. The item becomes wearable again |
| Live updates | A `{t:'market'}` request sends the list and live updates for 60 s (`MARKET_WATCH_MS`). The Market screen is meant to call `econ.watchMarket()` on open (it renews every 25 s) and the returned stop function on close. The game server calls `economy.unwatchMarket(c)` when a match starts |

Listing and instance ids carry a prefix (`lst_`, `itm_`) and every id lookup uses a `Map`, so ids like `__proto__` find nothing and cost nothing.

## Where the data lives

```
Browser: client/economy/index.ts (local locker for solo, server account online)
   |   websocket messages, validated by parseEconomyClientMsg in shared/economy.ts
   v
server/gameServer.ts --> server/economy/service.ts (EconomyService)
                            `-- store.ts  AccountStore, <ECONOMY_DATA_DIR>/economy.db (node:sqlite)
```

- **One row per account and per listing.** A save writes only the rows that changed, in one transaction. A purchase on a server with 20,000 accounts took p50 1.1 ms, p99 5.7 ms on this machine (the old whole-file save took about 222 ms there).
- **Durable.** WAL journal with `synchronous=FULL`: a committed purchase, trade or match payout survives a crash or a power cut. Loadouts and names are batched for up to 500 ms.
- **One server per folder.** The database opens in EXCLUSIVE locking mode and takes its write lock at once. The operating system releases that lock when the process ends, however it ends, so a killed server never leaves a stale lock.
- **Never runs from memory, never starts empty.** If the folder is held by another server, or the data cannot be read, the server logs `[economy] ERROR: ...` and runs with no economy: no accounts, no tokens handed out, and players keep their saved tokens. The file is not touched.
- **One backup per start:** `economy.db.bak`.
- **Upgrade from the old JSON store:** on the first start, `economy.json` (or a newer complete temp file a crash left behind) is imported once and renamed to `economy.json.imported-<time>`. Wallet addresses, USDC orders, edition serials and empty guests are not imported. Delete the `.imported-` file once you are happy, because it still holds old wallet addresses. Stop any older server before this first start.

## Environment variables

`npm start` reads `.env` if it exists (`node --env-file-if-exists=.env server/index.ts`). `.env` is gitignored; `.env.example` lists every setting.

| Variable | Default | What it does |
|---|---|---|
| `ECONOMY` | `on` | `off` = no accounts, everyone wears the default sets |
| `ECONOMY_DATA_DIR` | `./data` (gitignored) | Folder for `economy.db`. Under `node --test` with no value, accounts stay in memory |

Settings from the Solana build (`ECONOMY_NETWORK`, `SOLANA_RPC_URL`, `ECONOMY_KEYPAIR_PATH`, `TREASURY_ADDRESS`, `USDC_MINT`, `CORE_COLLECTION`, `NFT_METADATA_BASE_URL`, `ECONOMY_DOMAIN`) are ignored, with one log line naming them.

## Security rules

- Prices and items always come from the catalog and the server, never from a client message.
- Economy messages are validated in `shared/economy.ts` and rate limited by the game server (3 a second, burst 12).
- The server stores token hashes, never tokens. No payment data, no wallets, no IP addresses on disk (the per-connection counters live in memory).

## If it fails

| You see | Check | Fix |
|---|---|---|
| `[economy] ERROR: ...economy.db is in use by another Hook Wars server` | Another server, or a program like DB Browser, has `economy.db` open | Stop it, then restart this server. **Never point the live server at a new folder: returning players would get empty accounts** |
| `[economy] ERROR: ...economy.json could not be read` | The old JSON file is damaged | Repair it, or replace it with `economy.json.bak` (accounts made after that backup are lost), then restart |
| `[economy] ERROR: ...economy.db could not be opened` | Disk fault or a hand edit | Stop the server, copy `economy.db.bak` over `economy.db`, restart |
| Players see "Too many new accounts..." | Many players behind one address (a class, a LAN party, carrier NAT) | Expected. It clears after an hour. The limit is `NEW_ACCOUNTS_PER_IP_HOUR` in `server/economy/service.ts` |
| Players see "This server did not sign you in" | The server log around their connect time | Usually the economy is off on that run: see the rows above |
| Everyone is paid half rate, or "daily limit of 4000 for your internet connection" comes early | Whether the server sees real player addresses. Behind a reverse proxy every player looks like the proxy | Set `TRUST_PROXY` (see `server/config.ts`) |
| "The market opens for an account once it is a day old..." | The account's age and match count | Expected for new accounts |
| A new account on every visit | Browser storage blocked (private window) | Expected: the token cannot be saved. Use a normal window |

## Rollback

- Switch the economy off: `ECONOMY=off`, restart. `economy.db` is untouched.
- Go back to the old JSON build: stop the server, rename `economy.json.imported-<time>` back to `economy.json`, run the older commit. Changes made since the import are not in that file.

## What I have not verified

- `node:sqlite` was only run on Node 25.8.2. `package.json` allows Node 22.18; there it is older and may print an ExperimentalWarning.
- Durability after a power cut is from SQLite's documented WAL guarantees, not tested. A hard process kill was tested (`tests/economy.test.ts`, the child-process test).
- The lock was tested on a local NTFS folder. On a network drive or a synced folder (OneDrive), SQLite locking is not reliable: keep `ECONOMY_DATA_DIR` on a local disk.
- The per-connection Pearl cap resets when the server restarts.
- Players behind carrier NAT share one IPv4 address, so they share the 20 new accounts an hour and the 4,000 Pearls a day.
- Closing the server's console window on Windows: `server/index.ts` handles `SIGINT` and `SIGTERM` only, so up to 500 ms of batched loadout and name changes can be lost. Committed purchases, trades and payouts are not affected.
- The Steam phase (Item Store, Community Market, Steam inventory checks) is not designed or built.
- Match payouts are covered by tests, not by a real online match. The live check on 2026-10-09 covered the import of an old `economy.json`, a purchase, an equip, a hard kill and restart, a held folder and a fresh browser.
- The screens do not use `accountError` or `watchMarket()` yet (that is UI work in `client/ui/screens/market.ts` and `store.ts`). Until they do, the Market stops getting live updates 60 s after it opens, and the screens still say "Signing in..." where the reason should be. The economy state itself was checked in the browser.
