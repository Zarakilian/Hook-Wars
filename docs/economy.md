# Hook Wars cosmetics and crypto economy

**Purpose:** Explain how players earn, buy, own and trade cosmetics (Pearls, the store, the marketplace, Solana devnet NFTs), and how to switch the devnet store on.
**Audience:** Miguel and anyone working on the store, locker, marketplace or server. Assumes no crypto background.
**Done when:** `npm test` passes `tests/economy.test.ts`, and a player online gets an account, earns Pearls in a match, buys a cosmetic, wears it, and still has it after a page reload and a server restart.
**Last verified:** 2026-10-08

The game server owns every account and item. The blockchain only gets involved for Limited items, on devnet, and mainnet stays switched off until the legal checklist at the bottom is done.

## What runs today

| Feature | Where | State |
|---|---|---|
| Guest accounts, tokens, Pearls, loadouts per family | `server/economy/service.ts`, `store.ts` | Working, tested |
| Pearl store (Common, Rare, Epic) | same | Working, tested |
| Match rewards with anti-farm rules | same | Working, tested |
| Pearl marketplace with a 5% fee | same | Working, tested |
| Wallet link (Sign in with Solana) | service + `client/economy/wallet.ts` | Working with test keys and a test Wallet Standard wallet; not tried with a real wallet extension |
| Limited items for devnet USDC, minted as Metaplex Core NFTs | `server/economy/solanaDevnet.ts` | Built and byte-checked against devnet; never sent (see "What I have not verified") |
| USDC resale of Limited items | none | Later phase |
| Mainnet | none | Refused by the server |

## The call

1. **The game server is the source of truth for play.** Every cosmetic lives in the server's inventory first. Only Limited items get an on-chain twin (an NFT). Nobody needs a wallet to play, unlock or equip anything.
2. **Metaplex Core NFTs, not the older Token Metadata standard.** One NFT is one account, which is cheaper to mint, and Core has plugins for royalties and attributes.
3. **No home-made escrow smart contract.** The marketplace settles on the server for Pearls. On-chain trading comes later through Core's transfer-delegate plugin or an audited program, after a security review.
4. **Devnet only** (free test money). Selling NFTs for real money in South Africa is likely regulated activity.

Think of the server as the game's own vault and the blockchain as a public notary. The vault holds what you own and decides what you can wear, instantly. The notary only gets involved for the rare items you want to prove you own.

## Currencies and items

| Currency | What it is | Comes from | Buys |
|---|---|---|---|
| **Pearls** | In-game soft currency, not crypto | Online matches (server); solo matches at half rate (this browser only) | Common, Rare and Epic items; Epic items on the marketplace |
| **USDC on Solana devnet** | Test dollars | The player's own wallet | Limited items |
| **SOL** | Network fee money | The server's fee-payer key | Fees only, never shown to players |

| Rarity | Owned how | Tradable | Supply |
|---|---|---|---|
| Default | Everyone owns the family's default set | No | Unlimited |
| Common, Rare | Server inventory | No | Unlimited |
| Epic | Server inventory | Yes, for Pearls | Unlimited |
| Limited | Server inventory plus a Core NFT in the linked wallet | Not yet (USDC resale is a later phase) | Fixed, for example 500, named `Hook Wars: Golden Harpoon #17/500` |

No item has stats. Cosmetics never change gameplay.

## How the pieces fit

```
Browser: client/economy/index.ts (local locker for solo, server account online)
   |   websocket messages, validated by parseEconomyClientMsg in shared/economy.ts
   v
server/gameServer.ts --> server/economy/service.ts (EconomyService)
                            |-- store.ts      AccountStore, <ECONOMY_DATA_DIR>/economy.json
                            `-- ChainAdapter  chain.ts
                                  |-- MockChain     in memory: tests, and ECONOMY_NETWORK=off (sells nothing)
                                  `-- SolanaDevnet  solanaDevnet.ts, loaded by import() only when ECONOMY_NETWORK=devnet
```

Packages actually used, all on the server, all loaded lazily: `@solana/web3.js` 1.99 (connection, legacy transactions), `@solana/spl-token` 0.4.15 (USDC transfer), `@metaplex-foundation/umi` 1.6 with `umi-bundle-defaults` and `mpl-core` 1.10 (Core NFTs). The browser only loads `@wallet-standard/app` (a small chunk, on demand). The client bundle contains no `@solana/web3.js`.

## Accounts and tokens

- `hello` without a token creates a guest account and replies `{t:'account', a, token}`. The token is 32 random bytes in base64url.
- The server stores only `sha256(token)`. A known token loads its account; an unknown one gets a new guest account.
- The browser keeps one token per server in localStorage key `hookwars.tokens.v1`, keyed by server address.
- Online accounts start with 0 Pearls (`STARTING_PEARLS`), so free guest accounts cannot mint Pearls from nothing.
- One IP address can create 20 new accounts an hour. Empty guest accounts not seen for 30 days are dropped at start.
- Loadouts are stored per family. A loadout that asks for an item the account does not own, or has listed for sale, gets the family default for that slot.

`economy.json` is written atomically (temp file, fsync, rename), debounced, with a schema version. On start the newest complete file wins (the main file or a temp file left by a crash), then `economy.json.bak`. A file that does not parse is moved aside, never overwritten. A lock file stops two servers sharing one folder.

## Earning Pearls: the anti-farm rules

| Rule | Value |
|---|---|
| Pearls per match | `matchPearls(won, kills, hooksHit, saves)` from `shared/cosmetics.ts`, at most 200 |
| Full rate needs | Humans on at least 2 different IP addresses in the match |
| Otherwise | `SOLO_PEARL_RATE` = half rate (also used for offline solo) |
| Two tabs on one account | Paid once per match |
| Never threw a hook | No Pearls (stats still count) |
| Daily cap | `DAILY_PEARL_CAP` = 2,000 Pearls per account per UTC day |

Each player gets `{t:'reward', pearls, reason}` and an updated account. The cap is per account and guest accounts are free, so a per-IP Pearl cap is a known follow-up.

## Store and marketplace rules

| Action | Rule |
|---|---|
| Store buy | Price from the catalog, never the client. Refused if already owned or short of Pearls. A double click finds the item owned and charges nothing |
| List for sale | Epic items only, 50 to 1,000,000 whole Pearls, at most 20 listings per account |
| While listed | The item is held in escrow: still in the inventory, cannot be worn |
| Buy | Buyer pays the price. Seller gets the price minus 5% (`MARKET_FEE_BPS` = 500, rounded up, at least 1). The fee is destroyed, which keeps Pearls scarce. The same copy moves to the buyer |
| Cancel | Seller only. The item becomes wearable again |
| Updates | Every client that opened the market gets the new list. The seller's client sees the item leave its inventory and shows "Sold" |

## Wallet link (Sign in with Solana)

1. The client asks for a challenge. The server makes a one-time random nonce that expires in 5 minutes and sends `walletChallengeText(domain, accountId, nonce, issuedAt)`.
2. The wallet signs the exact text with `solana:signMessage`.
3. The server checks the Ed25519 signature with `node:crypto` (raw key wrapped in the SPKI prefix `302a300506032b6570032100`).

The nonce is used up by any attempt, right or wrong. One wallet per account, one account per wallet. The server never sees a private key.

## Buying a Limited item (devnet)

1. **Order.** The server checks the item, the linked wallet, the supply and the player's devnet USDC. It builds one legacy transaction: `transferChecked` of the exact price from the player's USDC account to the treasury's, plus a Memo `hookwars:order:<id>`. The server key is fee payer and signs first.
2. **Sign.** The wallet signs with `solana:signTransaction` and hands the bytes back. The client sends them in `{t:'usdcSubmit', order, tx}`.
3. **Check and send.** The server refuses anything whose message is not byte-for-byte the one it built, then sends it on its own RPC and confirms it.
4. **Verify.** The server reads the confirmed transaction back and checks mint, source, destination, signer, amount and memo.
5. **Own, then mint.** The item lands in the inventory with the next serial, then a Core asset named `Hook Wars: <item> #n/N` (with `item`, `serial` and `supply` attributes) is minted into `CORE_COLLECTION`, owned by the wallet.

**Why signTransaction and not signAndSendTransaction:** the server's key has already signed as fee payer. A wallet that sends the transaction itself may add instructions first (priority fees, safety checks), which changes the message and breaks the server's signature. Signing and handing back keeps the message exactly as built.

**Idempotent at every step.** A repeated order request gets the same order. A repeated submit gets the same answer. The transaction id is the fee payer's signature, known at build time, so a payment the player sent some other way is still found when the order expires. The NFT address is derived from the server key and the order id, so a retried mint finds the asset instead of making a second one.

**Supply** is enforced on the server: serials issued plus open orders can never pass the item's supply. An order that expires gives its place back.

## Environment variables

Nothing reads `.env` on its own. Start the server with `node --env-file=.env server/index.ts`. `.env` is gitignored; `.env.example` at the project root lists everything with placeholders.

| Variable | Default | What it does |
|---|---|---|
| `ECONOMY` | `on` | `off` = no accounts, everyone wears the default sets |
| `ECONOMY_DATA_DIR` | `./data` (gitignored) | Folder for `economy.json`. Under `node --test` with no value, accounts stay in memory |
| `ECONOMY_DOMAIN` | `SERVER_NAME` | Name shown in the wallet sign-in message |
| `ECONOMY_NETWORK` | `off` | `devnet` turns on Limited items. `mainnet` is refused with a log line pointing at the legal checklist |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Must be devnet: the server checks the genesis hash |
| `ECONOMY_KEYPAIR_PATH` | none | Fee payer and mint authority, a 64-number JSON keypair. Refused if it is inside the project folder |
| `TREASURY_ADDRESS` | none | Wallet that receives USDC. Only its address goes here, never its key |
| `USDC_MINT` | none | Devnet USDC mint |
| `CORE_COLLECTION` | none | The Core collection Limited items are minted into. Its update authority must be the fee-payer key |
| `NFT_METADATA_BASE_URL` | empty | Optional metadata JSON base URL. Leave empty for now; decide where to host the metadata before mainnet |

If any devnet value is missing or wrong, the server logs exactly which one and keeps running with Limited items switched off.

## Devnet setup

**Time:** about 15 minutes. **You need:** this project with `node_modules`, a browser wallet with a devnet address you control (the treasury), devnet USDC.

### 1. Make a fee-payer keypair outside the repo

Run from the project root. Pick a folder outside `Game1`, and create it first.

```
node -e "const {Keypair}=require('@solana/web3.js');const fs=require('fs');const k=Keypair.generate();fs.writeFileSync(process.argv[1],JSON.stringify([...k.secretKey]),{mode:0o600});console.log(k.publicKey.toBase58())" C:/Users/<you>/.hookwars/devnet-fee-payer.json
```

**Expect:** one line, the fee payer's address. The file holds 64 numbers. **This file is a secret: never commit it or paste it anywhere.**

### 2. Put devnet SOL on the fee payer

```
node -e "const w=require('@solana/web3.js');const c=new w.Connection('https://api.devnet.solana.com','confirmed');c.requestAirdrop(new w.PublicKey(process.argv[1]),1e9).then(s=>c.confirmTransaction(s)).then(()=>console.log('airdropped 1 devnet SOL'))" <FEE_PAYER_ADDRESS>
```

**Expect:** `airdropped 1 devnet SOL`. **If wrong:** a 429 error means the public faucet is rate limited. Wait and retry.

### 3. Fill in `.env`

Copy `.env.example` to `.env`. Set `ECONOMY_NETWORK=devnet`, `ECONOMY_KEYPAIR_PATH`, `TREASURY_ADDRESS` (your wallet's devnet address) and `USDC_MINT`. On 2026-10-08, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` read back from devnet as an SPL Token mint with 6 decimals; confirm it is the mint your devnet USDC faucet sends before using it.

### 4. Dry-run the setup script, then run it

```
node --env-file=.env server/economy/setupDevnet.ts
```

**Expect:** the fee payer, the treasury's USDC account, a `CORE_COLLECTION=` line, and "Nothing was sent". Then run it for real (devnet only):

```
node --env-file=.env server/economy/setupDevnet.ts --send
```

**Expect:** "created" for the token account (if it was missing) and the collection. It creates the collection "Hook Wars Limited" with a 5% Royalties plugin paid to the treasury. Running it again finds both and creates nothing.

### 5. Start the server

Put the printed `CORE_COLLECTION` in `.env`, then:

```
node --env-file=.env server/index.ts
```

**Expect:** `[economy] Solana devnet is ready: Limited items can be bought with devnet USDC.` **If wrong:** the line after `devnet setup check failed:` names the missing piece.

## Security rules

- The treasury's private key never goes on the game server. The server holds only a small fee-payer and mint-authority key, outside the repo.
- Prices, items, amounts and supply always come from the catalog and the server, never from a client message. Economy messages are validated and rate limited (3 a second, burst 12).
- The server refuses mainnet twice: by setting and by genesis hash.
- Before mainnet, get an independent security review of key management, secrets handling and hosting.

## Dependencies and npm audit

`npm audit` on 2026-10-08: 14 advisories, 3 high, 11 moderate, all from the Solana packages.

| Severity | Package | Comes in through |
|---|---|---|
| High | `bigint-buffer` (buffer overflow in `toBigIntLE`) | `@solana/buffer-layout-utils`, `@solana/spl-token`, `@solana/web3.js` |
| High | `@solana/buffer-layout-utils`, `@solana/spl-token` | Flagged because they depend on `bigint-buffer` |
| Moderate | `stream-json` (slow on deeply nested JSON), `uuid` (missing bounds check) | `jayson`, the RPC client inside `@solana/web3.js` |
| Moderate | `@solana/web3.js`, `spl-token-group`, `spl-token-metadata`, five `umi-*` packages | Flagged through the chain above |

Why this is acceptable for now: they only run on the server, they are only loaded when `ECONOMY_NETWORK=devnet`, they only talk to devnet and its RPC, and the browser never loads them. **Revisit before mainnet**, ideally with a move to `@solana/kit`. None of these packages has been through the organisation's vetting process yet.

## Legal checklist before mainnet

Get advice from a South African lawyer who knows fintech. These are the questions to bring. They are not answers.

- The FSCA declared crypto assets to be financial products in 2022. Does selling Limited NFTs, or running a marketplace for them, need a licence (for example as a crypto asset service provider)?
- Consumer protection: refunds, clear pricing in rand, and terms of sale.
- Tax (SARS) on sales and on the creator fee.
- Personal information (POPIA): wallet addresses linked to accounts count as personal information.
- Age limits and no gambling mechanics: no paid loot boxes or random paid drops. Every paid item is a direct purchase of a known item.

## Build order

| Phase | Ships | State |
|---|---|---|
| 1 | Catalog, Locker, Pearls from matches, Pearl store, server inventory, cosmetics checked online | Done |
| 2 | Wallet link, MockChain and SolanaDevnet, Limited items for devnet USDC | Built; devnet sends not yet run |
| 3 | Pearl marketplace | Done. USDC resale with Core delegates and royalties: not started |
| 4 | Mainnet | Only after the legal checklist, a security review and key management |

## If it fails

| You see | Check | Fix |
|---|---|---|
| `[economy] ... is in use by process N` | Another server owns `./data` | Give this one its own `ECONOMY_DATA_DIR` |
| A new account on every visit | Browser storage blocked (private window) | Expected: the token cannot be saved. Use a normal window |
| `devnet store disabled: ...` at start | The variable it names | Fix that line in `.env`, restart |
| `devnet setup check failed: ... has 0 SOL` | Fee-payer balance | Repeat setup step 2 |
| `Limited items are not sold on this server` | `ECONOMY_NETWORK` | Set `devnet` and the devnet variables |
| `[economy] order ... was paid ... Refund it by hand` | `economy.json`, the order's `signature` | Refund that devnet USDC from the treasury yourself |

## Rollback

- Switch Limited items off: `ECONOMY_NETWORK=off`, restart. Accounts and items stay.
- Switch the economy off: `ECONOMY=off`, restart. `economy.json` is untouched.

## What I have not verified

- No transaction was ever sent to devnet: no airdrop, no collection, no USDC payment, no mint. The order transaction was built against a live devnet blockhash and checked byte by byte (signers, memo, amount, accounts, web3.js signature check), and the Core create instruction was built, but neither was sent.
- No real wallet extension was tried. Whether every Wallet Standard wallet accepts `solana:signTransaction` on a transaction the fee payer already signed is unverified.
- Core supply caps are not enforced by the Core program as far as I know; the server enforces them. Whether Core accepts an empty metadata `uri` is unverified.
- The devnet USDC mint address is checked as a 6-decimal SPL mint, not as Circle's. The devnet faucet for it is not named here on purpose.
- Linked wallets are not re-checked on a schedule, so an NFT moved out of the wallet stays in the game inventory.
- Checked live on 2026-10-08 (local server, own data folder): a guest account and token, the same account after a page reload, Pearls and an equipped Epic after a hard server kill and restart, and a wallet link from a test Wallet Standard wallet signing with WebCrypto Ed25519. The Pearls were seeded by hand into `economy.json`; match payouts are covered by tests, not by a real online match.
