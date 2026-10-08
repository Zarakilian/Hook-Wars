// Economy service: accounts, persistence, store, rewards, marketplace, wallet link and USDC orders.
// Runs against MockChain and a temp data folder. No network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cosmeticById, DEFAULT_LOADOUT, matchPearls } from '../shared/cosmetics.ts';
import {
  base58Decode, base58Encode, DAILY_PEARL_CAP, isSolanaAddress, marketFee, MARKET_FEE_BPS, parseEconomyClientMsg, sellerProceeds, SOLO_PEARL_RATE,
  type AccountView, type EconomyClientMsg, type Listing,
} from '../shared/economy.ts';
import type { Profile, ServerMsg } from '../shared/protocol.ts';
import type { ScoreRow } from '../shared/types.ts';
import type { EconomyConn, MatchResult } from '../server/economy/api.ts';
import { MockChain } from '../server/economy/chain.ts';
import { loadEconomyConfig } from '../server/economy/config.ts';
import { joinWireTx, requiredSigners, sha256Hex, splitWireTx } from '../server/economy/crypto.ts';
import { EconomyService } from '../server/economy/service.ts';
import { AccountStore, SCHEMA_VERSION } from '../server/economy/store.ts';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const EPIC = 'brawler.lighthouse_helm'; // epic head, 2400 Pearls, tradable for Pearls
const COMMON = 'brawler.souwester'; // common head, 300 Pearls
const LIMITED = 'brawler.golden_harpoon'; // limited hook, 9 USDC, supply 500
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

interface TestConn extends EconomyConn {
  inbox: ServerMsg[];
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'hookwars-econ-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEconomy(dir: string | null, opts: { chain?: MockChain; perIp?: number } = {}) {
  const clock = { t: T0 };
  const chain = opts.chain ?? new MockChain({ now: () => clock.t });
  const store = new AccountStore({ dir, debounceMs: 5, log: () => {} });
  const svc = new EconomyService({ store, chain, domain: 'hookwars.test', network: 'off', now: () => clock.t, log: () => {}, newAccountsPerIpHour: opts.perIp });
  return { svc, store, chain, clock };
}

let nextConn = 1;
function conn(ip = '10.0.0.1', profile: Partial<Profile> = {}): TestConn {
  const c: TestConn = {
    id: nextConn++,
    ip,
    profile: { name: 'Tester', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler }, ...profile },
    accountId: null,
    inbox: [],
    send(m: ServerMsg) {
      c.inbox.push(m);
    },
  };
  return c;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function last<T extends ServerMsg['t']>(c: TestConn, t: T): Extract<ServerMsg, { t: T }> | undefined {
  for (let i = c.inbox.length - 1; i >= 0; i--) if (c.inbox[i].t === t) return c.inbox[i] as Extract<ServerMsg, { t: T }>;
  return undefined;
}

function acct(c: TestConn): AccountView {
  const m = last(c, 'account');
  assert.ok(m, 'expected an account message');
  return m.a;
}

function errors(c: TestConn): string[] {
  return c.inbox.filter((m): m is Extract<ServerMsg, { t: 'econError' }> => m.t === 'econError').map((m) => m.code);
}

/** Connect and say hello, returning the issued token (if a new account was made). */
async function hello(svc: EconomyService, c: TestConn, token?: string): Promise<string | undefined> {
  c.profile = svc.onHello(c, token);
  await tick();
  return last(c, 'account')?.token;
}

function send(svc: EconomyService, c: TestConn, m: EconomyClientMsg): void {
  svc.route(c, m);
}

function row(i: number, over: Partial<ScoreRow> = {}): ScoreRow {
  return { i, k: 3, d: 1, a: 2, hh: 6, ht: 12, bs: 0, dr: 1, sv: 1, dmg: 400, g: 300, ...over };
}

function givePearls(svc: EconomyService, c: TestConn, n: number): void {
  svc.accountById(c.accountId!)!.pearls += n;
}

function ed25519Wallet(): { address: string; priv: KeyObject; raw: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = new Uint8Array(spki.subarray(spki.length - 32));
  return { address: base58Encode(raw), priv: privateKey, raw };
}

async function linkWallet(svc: EconomyService, c: TestConn, w = ed25519Wallet()) {
  send(svc, c, { t: 'walletChallenge' });
  const ch = last(c, 'walletChallenge');
  assert.ok(ch, 'challenge issued');
  const sig = sign(null, Buffer.from(ch.message, 'utf8'), w.priv);
  send(svc, c, { t: 'walletLink', address: w.address, signature: base58Encode(new Uint8Array(sig)) });
  return w;
}

/** What a wallet does with solana:signTransaction: sign the message bytes as given, in its own slot. */
function walletSign(txB64: string, w: { raw: Uint8Array; priv: KeyObject }): string {
  const wire = splitWireTx(new Uint8Array(Buffer.from(txB64, 'base64')));
  assert.ok(wire);
  const signers = requiredSigners(wire.message)!;
  const at = signers.findIndex((k) => Buffer.from(k).equals(Buffer.from(w.raw)));
  assert.ok(at > 0, 'the player is a required signer, after the fee payer');
  wire.signatures[at] = new Uint8Array(sign(null, wire.message, w.priv));
  return Buffer.from(joinWireTx(wire)).toString('base64');
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

test('base58 matches the Bitcoin alphabet vectors and round trips random bytes', () => {
  const vectors: [string, string][] = [
    ['61', '2g'], ['626262', 'a3gV'], ['636363', 'aPEr'], ['572e4794', '3EFU7m'], ['10c8511e', 'Rt5zm'], ['00000000000000000000', '1111111111'],
    ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
    ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
    ['000111d38e5fc9071ffcd20b4a763cc9ae4f252bb4e48fd66a835e252ada93ff480d6dd43dc62a641155a5', '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'],
  ];
  for (const [hex, b58] of vectors) {
    assert.equal(base58Encode(Buffer.from(hex, 'hex')), b58);
    assert.equal(Buffer.from(base58Decode(b58)!).toString('hex'), hex);
  }
  // Solana's System Program is 32 zero bytes
  assert.deepEqual([...base58Decode('11111111111111111111111111111111')!], new Array(32).fill(0));
  assert.ok(isSolanaAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
  assert.equal(isSolanaAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5D'), false);
  for (const bad of ['', '0', 'O', 'I', 'l', 'abc+', '1'.repeat(129)]) assert.equal(base58Decode(bad), null, `rejects ${JSON.stringify(bad).slice(0, 12)}`);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 300; i++) {
    const bytes = new Uint8Array(1 + Math.floor(rnd() * 70)).map(() => (rnd() < 0.1 ? 0 : Math.floor(rnd() * 256)));
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  }
});

test('economy messages are validated before they reach the service', () => {
  assert.equal(parseEconomyClientMsg({ t: 'storeBuy', item: 'nope.item' }), null);
  assert.equal(parseEconomyClientMsg({ t: 'marketSell', instance: 'itm_abcdefgh', price: { cur: 'pearls', amount: 10 } }), null, 'below the minimum price');
  assert.equal(parseEconomyClientMsg({ t: 'marketSell', instance: 'itm_abcdefgh', price: { cur: 'pearls', amount: 99.5 } }), null, 'whole Pearls only');
  assert.equal(parseEconomyClientMsg({ t: 'usdcSubmit', order: 'ord_abcdefgh', tx: 'not base64!' }), null);
  assert.equal(parseEconomyClientMsg({ t: 'walletLink', address: 'short', signature: 'x' }), null);
  assert.ok(parseEconomyClientMsg({ t: 'marketSell', instance: 'itm_abcdefgh', price: { cur: 'pearls', amount: 500 } }));
});

test('ECONOMY_NETWORK=mainnet is refused and points at the legal checklist', () => {
  const lines: string[] = [];
  const ec = loadEconomyConfig({ serverName: 'Test' }, { ECONOMY_NETWORK: 'mainnet', NODE_TEST_CONTEXT: '1' }, (s) => lines.push(s));
  assert.equal(ec.network, 'off');
  assert.equal(ec.devnet, null);
  assert.ok(lines.some((l) => /Legal checklist/.test(l)), lines.join('\n'));
  const dev = loadEconomyConfig({ serverName: 'Test' }, { ECONOMY_NETWORK: 'devnet', NODE_TEST_CONTEXT: '1' }, () => {});
  assert.equal(dev.devnet, null, 'devnet without its settings stays off');
  assert.ok(dev.problems.some((p) => /ECONOMY_KEYPAIR_PATH/.test(p)));
});

// ---------------------------------------------------------------------------------------------
// Accounts and persistence
// ---------------------------------------------------------------------------------------------

test('a guest gets an account and a token; the token brings the same account back', async () => {
  const { svc } = makeEconomy(null);
  const a = conn();
  const token = await hello(svc, a);
  assert.ok(token && TOKEN_RE.test(token), 'token matches TOKEN_RE');
  const id = acct(a).id;
  assert.equal(acct(a).pearls, 0, 'online accounts start with no Pearls');
  const b = conn();
  assert.equal(await hello(svc, b, token), undefined, 'a known token gets no new token');
  assert.equal(acct(b).id, id);
  const c = conn();
  const other = await hello(svc, c, 'x'.repeat(43));
  assert.ok(other && other !== token, 'an unknown token gets a new guest account');
  assert.notEqual(acct(c).id, id);
  svc.close();
});

test('new guest accounts are limited per IP address', async () => {
  const { svc } = makeEconomy(null, { perIp: 2 });
  assert.ok(await hello(svc, conn('10.9.9.9')));
  assert.ok(await hello(svc, conn('10.9.9.9')));
  const third = conn('10.9.9.9');
  assert.equal(await hello(svc, third), undefined);
  assert.equal(third.accountId, null);
  send(svc, third, { t: 'storeBuy', item: COMMON });
  assert.deepEqual(errors(third), ['no_account']);
  assert.ok(await hello(svc, conn('10.9.9.8')), 'another address is not affected');
  svc.close();
});

test('accounts survive a restart, and only a hash of the token is written', async (t) => {
  const dir = tempDir(t);
  const one = makeEconomy(dir);
  const a = conn('10.0.0.1');
  const b = conn('10.0.0.2');
  const token = (await hello(one.svc, a))!;
  await hello(one.svc, b);
  one.svc.onMatchEnd([{ connId: a.id, won: true, row: row(0) }, { connId: b.id, won: false, row: row(1) }]);
  const pearls = acct(a).pearls;
  assert.ok(pearls > 0);
  one.svc.close();
  const disk = readFileSync(join(dir, 'economy.json'), 'utf8');
  assert.ok(!disk.includes(token), 'the token itself is never stored');
  assert.ok(disk.includes(sha256Hex(token)));
  assert.equal(JSON.parse(disk).v, SCHEMA_VERSION);

  const two = makeEconomy(dir);
  const again = conn();
  assert.equal(await hello(two.svc, again, token), undefined);
  assert.equal(acct(again).id, acct(a).id);
  assert.equal(acct(again).pearls, pearls);
  assert.equal(acct(again).stats.wins, 1);
  two.svc.close();
});

test('a crash mid-write never loses data: newest complete file wins, torn files are ignored', (t) => {
  const dir = tempDir(t);
  const acc = (id: string, pearls: number) => ({
    id, tokenHash: sha256Hex(id), created: T0, seen: T0, name: 'X', pearls, owned: [], loadouts: {}, wallet: null,
    stats: { matches: 1, wins: 0, kills: 0, hooksHit: 0 }, day: '', dayPearls: 0, lastPaid: 0,
  });
  const file = (pearls: number, savedAt: string) => JSON.stringify({ v: 1, savedAt, accounts: { acc_test0001: acc('acc_test0001', pearls) }, listings: {}, orders: {}, serials: {} });
  writeFileSync(join(dir, 'economy.json'), file(100, '2026-10-08T10:00:00.000Z'));
  // fsync done, rename not: a complete newer temp file
  writeFileSync(join(dir, 'economy.json.tmp-1-aaaaaa'), file(250, '2026-10-08T10:00:05.000Z'));
  // a torn temp file from a crash during the write itself
  writeFileSync(join(dir, 'economy.json.tmp-2-bbbbbb'), file(999, '2026-10-08T10:00:09.000Z').slice(0, 60));
  const s1 = new AccountStore({ dir, log: () => {} });
  assert.equal(s1.db.accounts.acc_test0001.pearls, 250);
  s1.close();
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), 'temp files are cleaned up');

  // a corrupt main file is moved aside untouched and the backup is used
  writeFileSync(join(dir, 'economy.json'), '{"v":1,"accou');
  const s2 = new AccountStore({ dir, log: () => {} });
  assert.equal(s2.db.accounts.acc_test0001.pearls, 250, 'restored from economy.json.bak');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('economy.json.corrupt-')));
  s2.close();
});

test('a second server on the same data folder runs from memory instead of corrupting it', (t) => {
  const dir = tempDir(t);
  const s1 = new AccountStore({ dir, log: () => {} });
  const s2 = new AccountStore({ dir, log: () => {} });
  assert.equal(s1.persistent, true);
  assert.equal(s2.persistent, false);
  s2.close();
  s1.close();
  assert.ok(!existsSync(join(dir, 'economy.lock')));
});

// ---------------------------------------------------------------------------------------------
// Loadouts and the store
// ---------------------------------------------------------------------------------------------

test('hello, setProfile and equip only wear what the account owns', async () => {
  const { svc } = makeEconomy(null);
  const a = conn('10.0.0.1', { loadout: { head: EPIC, face: 'brawler.cigar' } });
  await hello(svc, a);
  assert.deepEqual(a.profile.loadout, DEFAULT_LOADOUT.brawler, 'an unowned Epic falls back to the stored (default) loadout');
  // bare slots chosen on purpose stay bare
  const bare = svc.sanitize(a, { name: 'Tester', family: 'brawler', loadout: { hands: 'brawler.rope_hook' } });
  assert.deepEqual(bare.loadout, { hands: 'brawler.rope_hook' });
  givePearls(svc, a, 5000);
  send(svc, a, { t: 'storeBuy', item: EPIC });
  send(svc, a, { t: 'equip', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler, head: EPIC } });
  assert.equal(acct(a).loadouts.brawler.head, EPIC);
  assert.equal(a.profile.loadout.head, EPIC, 'the live profile follows the equip');
  send(svc, a, { t: 'equip', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler, head: 'brawler.tricorn' } });
  assert.equal(acct(a).loadouts.brawler.head, 'brawler.captain_cap', 'equipping an unowned item gives the default for that slot');
  svc.close();
});

test('a known account keeps its online loadout even when this browser says hello with less', async () => {
  const { svc } = makeEconomy(null);
  const a = conn();
  const token = (await hello(svc, a))!;
  givePearls(svc, a, 5000);
  send(svc, a, { t: 'storeBuy', item: EPIC });
  send(svc, a, { t: 'equip', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler, head: EPIC } });
  // after a reload the offline locker trimmed the saved profile: no Epic, head left bare
  const { head: _drop, ...trimmed } = DEFAULT_LOADOUT.brawler;
  const again = conn('10.0.0.1', { loadout: trimmed });
  await hello(svc, again, token);
  assert.equal(again.profile.loadout.head, EPIC, 'the server keeps what was equipped online');
  assert.equal(acct(again).loadouts.brawler.head, EPIC);
  svc.close();
});

test('the store charges the catalog price once, and a double click does not charge twice', async () => {
  const { svc } = makeEconomy(null);
  const a = conn();
  await hello(svc, a);
  send(svc, a, { t: 'storeBuy', item: COMMON });
  assert.deepEqual(errors(a), ['pearls'], 'no Pearls yet');
  givePearls(svc, a, 1000);
  send(svc, a, { t: 'storeBuy', item: COMMON });
  send(svc, a, { t: 'storeBuy', item: COMMON }); // the double click
  assert.equal(acct(a).pearls, 1000 - cosmeticById(COMMON)!.pearls!);
  assert.equal(acct(a).owned.filter((o) => o.item === COMMON).length, 1);
  assert.deepEqual(errors(a), ['pearls', 'owned']);
  send(svc, a, { t: 'storeBuy', item: LIMITED });
  send(svc, a, { t: 'storeBuy', item: 'brawler.captain_cap' });
  assert.deepEqual(errors(a).slice(-2), ['not_for_sale', 'not_for_sale'], 'Limited and default items are not sold for Pearls');
  svc.close();
});

// ---------------------------------------------------------------------------------------------
// Rewards and anti-farm
// ---------------------------------------------------------------------------------------------

test('match rewards: full rate needs two IP addresses, two tabs are paid once, AFK pays nothing', async () => {
  const { svc } = makeEconomy(null);
  const a = conn('10.0.0.1');
  const b = conn('10.0.0.2');
  await hello(svc, a);
  await hello(svc, b);
  const full = matchPearls(true, 3, 6, 1);
  const lose = matchPearls(false, 3, 6, 1);
  svc.onMatchEnd([{ connId: a.id, won: true, row: row(0) }, { connId: b.id, won: false, row: row(1) }]);
  assert.equal(acct(a).pearls, full);
  assert.equal(acct(b).pearls, lose);
  assert.equal(last(a, 'reward')?.pearls, full);
  assert.equal(acct(a).stats.matches, 1);
  assert.equal(acct(a).earnedToday, full);

  // the same person in two tabs on one token, alone on one IP: paid once, at the solo rate
  const tokenC = (await hello(svc, conn('10.0.0.3')))!;
  const c1 = conn('10.0.0.3');
  const c2 = conn('10.0.0.3');
  await hello(svc, c1, tokenC);
  await hello(svc, c2, tokenC);
  svc.onMatchEnd([{ connId: c1.id, won: true, row: row(0) }, { connId: c2.id, won: false, row: row(1) }]);
  assert.equal(acct(c1).pearls, Math.round(full * SOLO_PEARL_RATE));
  assert.equal(acct(c1).stats.matches, 1);
  assert.match(last(c1, 'reward')!.reason, /half rate/);

  // two guest accounts from one address count as one human
  const d = conn('10.0.0.4');
  const e = conn('10.0.0.4');
  await hello(svc, d);
  await hello(svc, e);
  svc.onMatchEnd([{ connId: d.id, won: true, row: row(0) }, { connId: e.id, won: false, row: row(1, { ht: 0 }) }]);
  assert.equal(acct(d).pearls, Math.round(full * SOLO_PEARL_RATE));
  assert.equal(acct(e).pearls, 0, 'never threw a hook: no Pearls');
  assert.match(last(e, 'reward')!.reason, /no hooks/);
  svc.close();
});

test('the daily cap stops match Pearls until the next UTC day', async () => {
  const { svc, clock } = makeEconomy(null);
  const a = conn('10.0.0.1');
  const b = conn('10.0.0.2');
  await hello(svc, a);
  await hello(svc, b);
  const big = row(0, { k: 30, hh: 50, sv: 5 }); // capped at 200 per match by matchPearls
  for (let i = 0; i < 15; i++) svc.onMatchEnd([{ connId: a.id, won: true, row: big }, { connId: b.id, won: false, row: row(1) }]);
  assert.equal(acct(a).pearls, DAILY_PEARL_CAP);
  assert.equal(acct(a).earnedToday, DAILY_PEARL_CAP);
  assert.equal(last(a, 'reward')!.pearls, 0);
  assert.match(last(a, 'reward')!.reason, /daily limit/);
  assert.equal(acct(a).stats.matches, 15, 'stats still count');
  clock.t += 24 * 3600_000;
  svc.onMatchEnd([{ connId: a.id, won: true, row: big }, { connId: b.id, won: false, row: row(1) }]);
  assert.equal(acct(a).pearls, DAILY_PEARL_CAP + 200);
  assert.equal(acct(a).earnedToday, 200);
  svc.close();
});

// ---------------------------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------------------------

test('market: list, buy with the 5% fee, cancel; a listed item cannot be worn', async () => {
  const { svc } = makeEconomy(null);
  const seller = conn('10.0.0.1');
  const buyer = conn('10.0.0.2', { name: 'Buyer' });
  await hello(svc, seller);
  await hello(svc, buyer);
  givePearls(svc, seller, 3000);
  givePearls(svc, buyer, 5000);
  send(svc, seller, { t: 'storeBuy', item: EPIC });
  send(svc, seller, { t: 'storeBuy', item: COMMON });
  send(svc, seller, { t: 'equip', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler, head: EPIC } });
  const inst = acct(seller).owned.find((o) => o.item === EPIC)!.instance;
  const common = acct(seller).owned.find((o) => o.item === COMMON)!.instance;
  send(svc, buyer, { t: 'market' });
  assert.deepEqual(last(buyer, 'market')!.listings, []);

  send(svc, seller, { t: 'marketSell', instance: common, price: { cur: 'pearls', amount: 500 } });
  assert.equal(errors(seller).at(-1), 'not_tradable', 'only Epic items trade for Pearls');
  send(svc, seller, { t: 'marketSell', instance: inst, price: { cur: 'usdc', amount: 5 } });
  assert.equal(errors(seller).at(-1), 'usdc_later');

  send(svc, seller, { t: 'marketSell', instance: inst, price: { cur: 'pearls', amount: 1000 } });
  const listed = acct(seller).owned.find((o) => o.instance === inst)!;
  assert.ok(listed.listed, 'held in escrow');
  assert.equal(acct(seller).loadouts.brawler.head, 'brawler.captain_cap', 'listing takes it off');
  assert.equal(seller.profile.loadout.head, 'brawler.captain_cap');
  send(svc, seller, { t: 'equip', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler, head: EPIC } });
  assert.equal(acct(seller).loadouts.brawler.head, 'brawler.captain_cap', 'a listed item cannot be equipped');
  send(svc, seller, { t: 'marketSell', instance: inst, price: { cur: 'pearls', amount: 900 } });
  assert.equal(errors(seller).at(-1), 'listed');

  svc.flushMarket();
  const l: Listing = last(buyer, 'market')!.listings[0];
  assert.equal(l.item, EPIC);
  assert.equal(l.price.amount, 1000);
  assert.equal(l.sellerName, 'Tester');
  send(svc, seller, { t: 'marketBuy', listing: l.id });
  assert.equal(errors(seller).at(-1), 'own_listing');

  const sellerBefore = acct(seller).pearls;
  send(svc, buyer, { t: 'marketBuy', listing: l.id });
  send(svc, buyer, { t: 'marketBuy', listing: l.id }); // double click
  assert.equal(acct(buyer).pearls, 4000, 'the buyer pays the price once');
  assert.equal(acct(seller).pearls, sellerBefore + sellerProceeds(1000));
  assert.equal(sellerProceeds(1000), 950);
  assert.equal(marketFee(1000), (1000 * MARKET_FEE_BPS) / 10_000);
  assert.ok(acct(buyer).owned.some((o) => o.instance === inst && !o.listed), 'the same copy moved');
  assert.ok(!acct(seller).owned.some((o) => o.instance === inst), 'the seller is told: the copy left their inventory');
  assert.equal(errors(buyer).at(-1), 'gone');
  svc.flushMarket();
  assert.deepEqual(last(buyer, 'market')!.listings, []);

  // cancel gives it back, wearable again
  send(svc, buyer, { t: 'marketSell', instance: inst, price: { cur: 'pearls', amount: 2000 } });
  const l2 = acct(buyer).owned.find((o) => o.instance === inst)!.listed!;
  send(svc, seller, { t: 'marketCancel', listing: l2 });
  assert.equal(errors(seller).at(-1), 'gone', 'only the seller can cancel');
  send(svc, buyer, { t: 'marketCancel', listing: l2 });
  assert.equal(acct(buyer).owned.find((o) => o.instance === inst)!.listed, undefined);
  send(svc, buyer, { t: 'equip', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler, head: EPIC } });
  assert.equal(acct(buyer).loadouts.brawler.head, EPIC);
  svc.close();
});

test('the market fee is always at least one Pearl and never more than 5% rounded up', () => {
  for (const p of [50, 51, 99, 100, 1234, 1_000_000]) {
    assert.ok(marketFee(p) >= 1);
    assert.equal(marketFee(p), Math.ceil(p * 0.05));
    assert.equal(sellerProceeds(p) + marketFee(p), p);
  }
});

// ---------------------------------------------------------------------------------------------
// Wallet link
// ---------------------------------------------------------------------------------------------

test('wallet link: a real signature links; bad signatures, replays and expired nonces do not', async () => {
  const { svc, clock } = makeEconomy(null);
  const a = conn('10.0.0.1');
  await hello(svc, a);
  const w = ed25519Wallet();

  // bad signature: signed by a different key
  send(svc, a, { t: 'walletChallenge' });
  const ch1 = last(a, 'walletChallenge')!;
  assert.match(ch1.message, /hookwars\.test wants you to link/);
  assert.match(ch1.message, new RegExp(`Account: ${acct(a).id}`));
  const impostor = ed25519Wallet();
  send(svc, a, { t: 'walletLink', address: w.address, signature: base58Encode(new Uint8Array(sign(null, Buffer.from(ch1.message), impostor.priv))) });
  assert.equal(errors(a).at(-1), 'bad_signature');
  assert.equal(acct(a).wallet, null);

  // the happy path
  send(svc, a, { t: 'walletChallenge' });
  const ch2 = last(a, 'walletChallenge')!;
  assert.notEqual(ch2.message, ch1.message, 'a fresh nonce every time');
  const good = base58Encode(new Uint8Array(sign(null, Buffer.from(ch2.message, 'utf8'), w.priv)));
  send(svc, a, { t: 'walletLink', address: w.address, signature: good });
  assert.equal(acct(a).wallet, w.address);

  // replaying the same signed message on another account fails (the nonce is bound to one account and used up)
  const b = conn('10.0.0.2');
  await hello(svc, b);
  send(svc, b, { t: 'walletLink', address: w.address, signature: good });
  assert.equal(errors(b).at(-1), 'challenge');
  send(svc, b, { t: 'walletChallenge' });
  send(svc, b, { t: 'walletLink', address: w.address, signature: good });
  assert.equal(errors(b).at(-1), 'bad_signature', 'an old signature does not match a new nonce');

  // one account per wallet
  send(svc, b, { t: 'walletChallenge' });
  const ch3 = last(b, 'walletChallenge')!;
  send(svc, b, { t: 'walletLink', address: w.address, signature: base58Encode(new Uint8Array(sign(null, Buffer.from(ch3.message), w.priv))) });
  assert.equal(errors(b).at(-1), 'wallet_taken');

  // one wallet per account
  send(svc, a, { t: 'walletChallenge' });
  assert.equal(errors(a).at(-1), 'linked');

  // expired challenge
  const c = conn('10.0.0.3');
  await hello(svc, c);
  send(svc, c, { t: 'walletChallenge' });
  const ch4 = last(c, 'walletChallenge')!;
  clock.t += 5 * 60_000 + 1;
  const w2 = ed25519Wallet();
  send(svc, c, { t: 'walletLink', address: w2.address, signature: base58Encode(new Uint8Array(sign(null, Buffer.from(ch4.message), w2.priv))) });
  assert.equal(errors(c).at(-1), 'challenge');
  assert.equal(acct(c).wallet, null);
  svc.close();
});

// ---------------------------------------------------------------------------------------------
// Limited items for USDC (MockChain)
// ---------------------------------------------------------------------------------------------

test('USDC order: the wallet signs, the server verifies and mints once; repeats are idempotent', async () => {
  const { svc, chain } = makeEconomy(null);
  const a = conn('10.0.0.1');
  await hello(svc, a);
  send(svc, a, { t: 'usdcOrder', item: LIMITED });
  assert.equal(errors(a).at(-1), 'no_wallet');
  const w = await linkWallet(svc, a);

  send(svc, a, { t: 'usdcOrder', item: LIMITED });
  send(svc, a, { t: 'usdcOrder', item: LIMITED }); // double click while the first is still being built
  await svc.idle();
  const orders = a.inbox.filter((m): m is Extract<ServerMsg, { t: 'usdcOrder' }> => m.t === 'usdcOrder');
  assert.equal(orders.length, 2);
  assert.equal(orders[0].order, orders[1].order, 'the same order both times');
  assert.equal(orders[0].tx, orders[1].tx);
  assert.equal(orders[0].usdc, cosmeticById(LIMITED)!.usdc);
  const order = orders[0];

  // the wallet changed the transaction (for example, injected an instruction): refused, nothing charged
  const tampered = new Uint8Array(Buffer.from(walletSign(order.tx, w), 'base64'));
  tampered[tampered.length - 1] ^= 1;
  send(svc, a, { t: 'usdcSubmit', order: order.order, tx: Buffer.from(tampered).toString('base64') });
  await svc.idle();
  assert.equal(errors(a).at(-1), 'tx_modified');
  // unsigned by the player: refused
  send(svc, a, { t: 'usdcSubmit', order: order.order, tx: order.tx });
  await svc.idle();
  assert.equal(errors(a).at(-1), 'not_signed');
  assert.equal(svc.orderById(order.order)!.status, 'open', 'the order can still be signed properly');
  assert.equal(chain.payments.size, 0);

  const signed = walletSign(order.tx, w);
  send(svc, a, { t: 'usdcSubmit', order: order.order, tx: signed });
  send(svc, a, { t: 'usdcSubmit', order: order.order, tx: signed }); // double submit
  await svc.idle();
  const owned = acct(a).owned.find((o) => o.item === LIMITED);
  assert.ok(owned, 'the item is in the inventory');
  assert.equal(owned.serial, 1);
  assert.ok(owned.asset && isSolanaAddress(owned.asset), 'the NFT twin is recorded');
  assert.equal(chain.payments.size, 1, 'paid once');
  assert.equal(chain.mintCount, 1, 'minted once');
  const minted = [...chain.assets.values()][0];
  assert.equal(minted.name, 'Hook Wars: Golden Harpoon #1/500');
  assert.equal(minted.owner, w.address, 'minted to the linked wallet');
  assert.equal(svc.orderById(order.order)!.status, 'minted');

  // the same order again: no second payment or mint, the account comes back
  send(svc, a, { t: 'usdcSubmit', order: order.order, tx: signed });
  await svc.idle();
  assert.equal(chain.mintCount, 1);
  send(svc, a, { t: 'usdcOrder', item: LIMITED });
  assert.equal(errors(a).at(-1), 'owned');
  // Limited items do not trade for Pearls (they are NFTs; on-chain trading is a later phase)
  send(svc, a, { t: 'marketSell', instance: owned.instance, price: { cur: 'pearls', amount: 500 } });
  assert.equal(errors(a).at(-1), 'usdc_later');
  svc.close();
});

test('USDC: a payment the player submitted elsewhere is found on chain when the order expires', async () => {
  const { svc, chain, clock } = makeEconomy(null);
  const a = conn('10.0.0.1');
  await hello(svc, a);
  const w = await linkWallet(svc, a);
  send(svc, a, { t: 'usdcOrder', item: LIMITED });
  await svc.idle();
  const order = last(a, 'usdcOrder')!;
  const rec = svc.orderById(order.order)!;
  // the player sends the signed transaction straight to the network, never telling the server
  await chain.submitUsdcTransfer({ orderId: rec.id, payer: rec.wallet, cents: rec.cents, message: new Uint8Array(Buffer.from(rec.message, 'base64')), meta: rec.meta }, new Uint8Array(Buffer.from(walletSign(order.tx, w), 'base64')), () => {});
  clock.t += 3 * 60_000;
  send(svc, a, { t: 'usdcOrder', item: 'ogre.crystal_tusks' }); // any later order request sweeps old orders
  await svc.idle();
  assert.equal(svc.orderById(order.order)!.status, 'minted');
  assert.ok(acct(a).owned.some((o) => o.item === LIMITED && o.serial === 1));
  svc.close();
});

test('USDC: an abandoned order expires and gives its place in the edition back', async () => {
  const { svc, clock } = makeEconomy(null);
  const a = conn('10.0.0.1');
  const b = conn('10.0.0.2');
  await hello(svc, a);
  await hello(svc, b);
  await linkWallet(svc, a);
  await linkWallet(svc, b);
  // one copy left
  (svc as unknown as { store: AccountStore }).store.db.serials[LIMITED] = cosmeticById(LIMITED)!.supply! - 1;
  send(svc, a, { t: 'usdcOrder', item: LIMITED });
  await svc.idle();
  const first = last(a, 'usdcOrder')!;
  send(svc, b, { t: 'usdcOrder', item: LIMITED });
  await svc.idle();
  assert.equal(errors(b).at(-1), 'sold_out', 'the open order holds the last copy');
  clock.t += 3 * 60_000;
  send(svc, b, { t: 'usdcOrder', item: LIMITED }); // sweeps first, then counts again
  await svc.idle();
  assert.equal(svc.orderById(first.order)!.status, 'expired');
  send(svc, b, { t: 'usdcOrder', item: LIMITED });
  await svc.idle();
  assert.equal(last(b, 'usdcOrder')?.item, LIMITED, 'the released copy can be bought');
  svc.close();
});

test('USDC: a mint that fails is retried and still mints only once', async () => {
  const chain = new MockChain();
  const realMint = chain.mintLimited.bind(chain);
  let fails = 1;
  chain.mintLimited = async (spec) => {
    if (fails-- > 0) throw new Error('RPC timeout');
    return realMint(spec);
  };
  const { svc } = makeEconomy(null, { chain });
  const a = conn('10.0.0.1');
  await hello(svc, a);
  const w = await linkWallet(svc, a);
  send(svc, a, { t: 'usdcOrder', item: LIMITED });
  await svc.idle();
  const order = last(a, 'usdcOrder')!;
  send(svc, a, { t: 'usdcSubmit', order: order.order, tx: walletSign(order.tx, w) });
  await svc.idle();
  assert.equal(svc.orderById(order.order)!.status, 'paid', 'paid and owned while the mint retries');
  assert.ok(acct(a).owned.some((o) => o.item === LIMITED && !o.asset));
  // a restart (or the retry timer) finishes the mint
  await (svc as unknown as { mint: (o: unknown) => Promise<void> }).mint(svc.orderById(order.order));
  await (svc as unknown as { mint: (o: unknown) => Promise<void> }).mint(svc.orderById(order.order));
  assert.equal(svc.orderById(order.order)!.status, 'minted');
  assert.equal(chain.mintCount, 1);
  svc.close();
});

test('a server with the chain switched off refuses USDC purchases politely', async () => {
  const { svc } = makeEconomy(null, { chain: new MockChain({ purchases: false }) });
  const a = conn('10.0.0.1');
  await hello(svc, a);
  await linkWallet(svc, a);
  send(svc, a, { t: 'usdcOrder', item: LIMITED });
  assert.equal(errors(a).at(-1), 'network_off');
  svc.close();
});

test('results for unknown connections are ignored', () => {
  const { svc } = makeEconomy(null);
  const res: MatchResult[] = [{ connId: 99_999, won: true, row: row(0) }];
  assert.doesNotThrow(() => svc.onMatchEnd(res));
  svc.close();
});
