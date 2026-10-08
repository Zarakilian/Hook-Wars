# Hook Wars cosmetics and crypto economy

**Purpose:** Decide how players buy, own and trade cosmetics, including Solana NFTs, and set the order we build it in.
**Audience:** Miguel and anyone building the store, locker or marketplace. Assumes no crypto background.
**Done when:** Phase 1 below runs end to end: a player earns Pearls in a match, buys a cosmetic, equips it in the Locker, and other players see it online.
**Last verified:** 2026-10-08

## The call

Keep the Gemini plan's spine: Solana, NFTs for limited cosmetics, USDC for prices, a player marketplace with a creator fee. Change four things about how it is built:

1. **The game server, not the blockchain, is the source of truth for play.** Every cosmetic lives in the server's inventory first. Only *Limited* items get an on-chain twin (an NFT). Nobody needs a wallet to play, unlock or equip anything.
2. **Use Metaplex Core NFTs, not the older Token Metadata standard.** Core stores one NFT in one account, which makes it cheaper to mint. It also has built-in plugins for enforced royalties and numbered limited editions, so we do not write those rules ourselves.
3. **Do not write our own escrow smart contract to start.** A home-made Rust program that holds other people's NFTs and money is the riskiest code in the whole project. Start with a server-run marketplace for in-game currency. Add on-chain trading later using Core's transfer-delegate plugin or an audited marketplace program, after a security review.
4. **Build and test everything on Solana devnet** (free test money) **and keep mainnet switched off** until a lawyer has signed it off. Selling NFTs and running a marketplace for real money in South Africa is likely to be regulated activity (see the legal checklist).

## Why these changes

Think of the server as the game's own vault and the blockchain as a public notary. The vault holds what you own and decides what you can wear, instantly. The notary only gets involved for the rare items you want to prove you own, or to sell to someone outside the game.

| Gemini's plan | Problem | What we do instead |
|---|---|---|
| The game reads your wallet to unlock skins | Every equip waits on a slow RPC call, and players without a wallet see nothing | The server inventory unlocks skins. The wallet is checked once when you link it, then again on a schedule |
| Write an Anchor escrow program for trades | It needs a Rust audit, and a bug can drain listed items | Server-settled trades for Pearls first. On-chain settlement later via Core delegates or an audited program |
| NFT attributes like "+5 Charisma" | Stats you can buy are pay-to-win, and they make an item look like an investment | Cosmetic only. No stats on any item, ever |
| Price in USDC, users hold SOL for fees | Players need two currencies just to buy a hat | The server pays the tiny SOL fee as fee payer. Players only ever see USDC |
| Mainnet from the start | Real money, legal exposure, irreversible mistakes | Devnet until the legal checklist is done |

## Currencies

| Currency | What it is | Where it comes from | Used for |
|---|---|---|---|
| **Pearls** | In-game soft currency, not crypto | Earned by playing matches (online on the server; solo in your local save) | Common, Rare and Epic cosmetics in the store, and player trades of tradable non-NFT items |
| **USDC on Solana** | A dollar-pegged stablecoin | The player's own wallet | Limited cosmetics (minted as NFTs) and marketplace trades of NFTs |
| **SOL** | Solana's network fee currency | The game's fee-payer wallet | Network fees only, paid by the server, never shown to players |

We do **not** create our own token. A custom coin needs liquidity, invites speculation and is the part regulators look at hardest.

## Item model

| Rarity | Owned how | Tradable | Supply |
|---|---|---|---|
| Default | Every player has the family's default set (the look in the reference renders) | No | Unlimited |
| Common, Rare, Epic | Server inventory | Epic only, for Pearls | Unlimited |
| **Limited** | Server inventory **plus** a Metaplex Core NFT in the player's wallet | Yes, for USDC | Fixed (for example 500), numbered `#17 / 500` |

Each family has slots: `head`, `face`, `body`, `hands` (the hook skin), `back` and `feet`. A *loadout* is one item per slot. Bare bases are what you see with every slot empty.

## How the pieces fit

```
Browser (Locker, Store, Marketplace UI)
   │  websocket: account / store / market messages (validated like every other message)
   ▼
Game server ── AccountStore (inventory, loadouts, Pearls, listings)   data/economy.json, gitignored
   │
   └── ChainAdapter (interface)
          ├── MockChain     : in-memory, used by tests and local dev
          └── SolanaDevnet  : @solana/kit + mpl-core, mints and transfers on devnet
```

- The server checks every cosmetic a player tries to wear online against their inventory, so nobody can fake a Limited hat.
- Wallet linking uses a signed message ("Sign in with Solana"). The server verifies the Ed25519 signature with Node's built-in crypto and never sees a private key.
- Purchases are idempotent: each order has an id, and paying twice for one order cannot mint two items.

## Purchase flow for a Limited item (devnet)

1. The player clicks **Buy** in the Store.
2. The server creates an order and builds one transaction: a USDC transfer from the player to the treasury, with the order id in a memo. The server signs as fee payer.
3. The player's wallet shows the transaction. The player approves it.
4. The server waits for confirmation, then reads the transaction back and checks the amount, the mint (USDC) and the memo.
5. The server mints the Core NFT (edition number = next free serial) to the player's wallet and adds the item to their inventory.

**Expect:** the item appears in the Locker within a few seconds, and in the wallet as `Hook Wars: <item> #n/N`.

## Marketplace

| Phase | Settles | Currency | Trust |
|---|---|---|---|
| 1 | On the server | Pearls | The server is the referee (normal for games) |
| 2 | On-chain, server-assisted | USDC | The seller grants the game a Core transfer delegate when listing. When a buyer pays, the server moves the NFT. The royalty plugin sends the creator fee automatically |
| 3 (optional) | On-chain, trustless | USDC | An audited marketplace program, only if trading volume justifies it |

Creator fee: 5% on every resale, enforced by Core's royalty plugin on-chain and by the server for Pearl trades.

## Build order

| Phase | Ships | Real money |
|---|---|---|
| 1 | Cosmetic catalog, bare bases plus default sets, Locker, Pearls from matches, Store (Pearls), server inventory, cosmetics validated online | No |
| 2 | Wallet linking (Sign in with Solana), MockChain plus SolanaDevnet adapter, Limited items minted on devnet, Store (devnet USDC) | No, devnet only |
| 3 | Marketplace for Pearls, then devnet USDC trades with delegates and royalties | No, devnet only |
| 4 | Mainnet | Only after the legal checklist, a security review and key management are done |

## Legal checklist before mainnet

Get advice from a South African lawyer who knows fintech. These are the questions to bring. They are not answers.

- The FSCA declared crypto assets to be financial products in 2022. Does selling Limited NFTs, or running a marketplace for them, need a licence (for example as a crypto asset service provider)?
- Consumer protection: refunds, clear pricing in rand, and terms of sale.
- Tax (SARS) on sales and on the creator fee.
- Personal information (POPIA): wallet addresses linked to accounts count as personal information.
- Age limits and no gambling mechanics: no paid loot boxes or random paid drops. Every paid item is a direct purchase of a known item.

## Security rules

- The treasury wallet's private key **never** goes on the game server. The server only holds a small fee-payer and mint-authority key, read from `.env` (gitignored), topped up with a few cents of SOL.
- The mint authority can only mint inside our own collection. Supply caps are enforced on-chain by the collection, not only by the server.
- Every economy message is validated and rate-limited like gameplay messages.
- If the project goes beyond your own machine, talk to a security reviewer about key management before mainnet.

## What I have not verified

- The exact Metaplex Core plugin names and parameters (royalties, editions, transfer delegate). They come from my knowledge of the library and will be checked against the current docs when Phase 2 is built.
- Network access from this laptop to Solana devnet RPC endpoints. It has not been tried yet.
- Whether South African law treats game cosmetics as crypto assets. That is for a lawyer.
- New packages (`@solana/kit`, `@metaplex-foundation/mpl-core`, `@metaplex-foundation/umi`) come from the official npm registry, but they have not been through any vetting process.
