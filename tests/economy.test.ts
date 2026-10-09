// Economy (standard edition: Pearls only): accounts, the economy.db store, the Pearl store, match
// rewards, the Pearl market and the client economy. Runs on temp data folders. No network calls.
// Tests named "F<n>:" are the regression tests for review finding n (docs: fix-progress notes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cosmeticById, DEFAULT_LOADOUT, matchPearls } from '../shared/cosmetics.ts';
import { UNIT_NOUN } from '../shared/constants.ts';
import {
  DAILY_PEARL_CAP, DAILY_PEARL_CAP_PER_IP, ECONOMY_MSG_TYPES, MARKET_FEE_BPS, MARKET_MIN_MATCHES, marketFee, parseEconomyClientMsg, sellerProceeds, SOLO_PEARL_RATE,
  type AccountView, type EconomyClientMsg, type Listing,
} from '../shared/economy.ts';
import type { Profile, ServerMsg } from '../shared/protocol.ts';
import type { ScoreRow } from '../shared/types.ts';
import { createNullEconomy, type EconomyConn, type MatchResult, type ServerEconomy } from '../server/economy/api.ts';
import { loadEconomyConfig } from '../server/economy/config.ts';
import { sha256Hex } from '../server/economy/crypto.ts';
import { createEconomyFromConfig } from '../server/economy/index.ts';
import { EconomyService, MARKET_WATCH_MS, netKey } from '../server/economy/service.ts';
import { AccountStore, DB_FILE, StoreLockedError, StoreUnreadableError, type AccountRec } from '../server/economy/store.ts';
import { createEconomy, MARKET_RENEW_MS, SIGN_IN_MS } from '../client/economy/index.ts';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const EPIC = 'brawler.lighthouse_helm'; // epic head, 2400 Pearls, tradable for Pearls
const COMMON = 'brawler.souwester'; // common head, 300 Pearls
const PREMIUM = 'brawler.golden_harpoon'; // premium hook: Steam version only
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const DAY = 24 * 3600_000;

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

interface TestConn extends EconomyConn {
  inbox: ServerMsg[];
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'hookwars-econ-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

function makeEconomy(dir: string | null, opts: { perIp?: number } = {}) {
  const clock = { t: T0 };
  const store = new AccountStore({ dir, debounceMs: 5, log: () => {} });
  const svc = new EconomyService({ store, now: () => clock.t, log: () => {}, newAccountsPerIpHour: opts.perIp });
  return { svc, store, clock };
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

function count(c: TestConn, t: ServerMsg['t']): number {
  return c.inbox.filter((m) => m.t === t).length;
}

function acct(c: TestConn): AccountView {
  const m = last(c, 'account');
  assert.ok(m, 'expected an account message');
  return m.a;
}

function errors(c: TestConn): string[] {
  return c.inbox.filter((m): m is Extract<ServerMsg, { t: 'econError' }> => m.t === 'econError').map((m) => m.code);
}

/** Connect and say hello, returning the issued token (if a new token was handed out). */
async function hello(svc: ServerEconomy, c: TestConn, token?: string): Promise<string | undefined> {
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

function rec(svc: EconomyService, c: TestConn): AccountRec {
  const a = svc.accountById(c.accountId!);
  assert.ok(a, 'account in memory');
  return a;
}

function givePearls(svc: EconomyService, c: TestConn, n: number): void {
  rec(svc, c).pearls += n;
}

/** An account old enough, and with enough matches, to trade on the market. */
function veteran(svc: EconomyService, c: TestConn, now = T0): void {
  const a = rec(svc, c);
  a.created = now - 2 * DAY;
  a.stats.matches = Math.max(a.stats.matches, MARKET_MIN_MATCHES);
}

/** A fake browser localStorage for the client economy. */
function fakeStorage(): Map<string, string> {
  const ls = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, String(v)),
    removeItem: (k: string) => void ls.delete(k),
  };
  return ls;
}

function view(id: string, over: Partial<AccountView> = {}): AccountView {
  return { id, pearls: 0, owned: [], loadouts: { brawler: {}, ogre: {}, bot: {} } as AccountView['loadouts'], stats: { matches: 0, wins: 0, kills: 0, hooksHit: 0 }, ...over };
}

const LEGACY_ACC = (id: string, over: Record<string, unknown> = {}) => ({
  id, tokenHash: sha256Hex(id), created: T0, seen: T0, name: 'X', pearls: 100, owned: [], loadouts: {}, wallet: null,
  stats: { matches: 1, wins: 0, kills: 0, hooksHit: 0 }, day: '', dayPearls: 0, lastPaid: 0, ...over,
});
const legacyFile = (accounts: Record<string, unknown>, savedAt: string, listings: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, savedAt, accounts, listings, orders: { ord_x1: { id: 'ord_x1' } }, serials: { [PREMIUM]: 3 } });

// ---------------------------------------------------------------------------------------------
// Messages and settings
// ---------------------------------------------------------------------------------------------

test('economy messages: only the Pearl wire format parses, and ids need their server prefix', () => {
  assert.deepEqual([...ECONOMY_MSG_TYPES].sort(), ['equip', 'market', 'marketBuy', 'marketCancel', 'marketSell', 'storeBuy']);
  assert.equal(parseEconomyClientMsg({ t: 'storeBuy', item: 'nope.item' }), null);
  assert.equal(parseEconomyClientMsg({ t: 'marketSell', instance: 'itm_abcdefgh', price: { cur: 'pearls', amount: 10 } }), null, 'below the minimum price');
  assert.equal(parseEconomyClientMsg({ t: 'marketSell', instance: 'itm_abcdefgh', price: { cur: 'pearls', amount: 99.5 } }), null, 'whole Pearls only');
  assert.equal(parseEconomyClientMsg({ t: 'marketSell', instance: 'itm_abcdefgh', price: { cur: 'usdc', amount: 5 } }), null, 'no USDC prices');
  for (const t of ['walletChallenge', 'walletLink', 'usdcOrder', 'usdcSubmit']) assert.equal(parseEconomyClientMsg({ t, item: COMMON }), null, `${t} is gone`);
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'abcdefgh']) {
    assert.equal(parseEconomyClientMsg({ t: 'marketBuy', listing: id }), null, `listing id ${id}`);
    assert.equal(parseEconomyClientMsg({ t: 'marketSell', instance: id, price: { cur: 'pearls', amount: 500 } }), null, `instance id ${id}`);
  }
  assert.ok(parseEconomyClientMsg({ t: 'marketSell', instance: 'itm_abcdefgh', price: { cur: 'pearls', amount: 500 } }));
  assert.ok(parseEconomyClientMsg({ t: 'marketBuy', listing: 'lst_abcdefgh' }));
});

test('settings from the Solana build are ignored with one log line', () => {
  const lines: string[] = [];
  const ec = loadEconomyConfig({ serverName: 'Test' }, { ECONOMY_NETWORK: 'devnet', USDC_MINT: 'x', NODE_TEST_CONTEXT: '1' }, (s) => lines.push(s));
  assert.equal(ec.enabled, true);
  assert.equal(ec.dataDir, null, 'memory only under the test runner');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ECONOMY_NETWORK, USDC_MINT are not used.*edition\/solana/);
  assert.deepEqual(loadEconomyConfig({ serverName: 'T' }, { NODE_TEST_CONTEXT: '1' }, () => {}).problems, []);
});

test('the null economy tells the client why there is no account, once, after hello', async () => {
  const econ = createNullEconomy();
  const c = conn();
  await hello(econ, c);
  assert.deepEqual(errors(c), ['disabled']);
  assert.equal(count(c, 'account'), 0);
  econ.route(c, { t: 'storeBuy', item: COMMON });
  assert.equal(last(c, 'econError')?.re, 'storeBuy');
  econ.unwatchMarket(c);
});

// ---------------------------------------------------------------------------------------------
// Accounts and tokens
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
  const other = await hello(svc, c, 'x'.repeat(30));
  assert.ok(other && other !== token, 'a token not in the shape this server issues gets a new one');
  assert.notEqual(acct(c).id, id);
  svc.close();
});

test('F16: an unknown token in the issued shape is kept: bound to the new account, no new token sent', async (t) => {
  const dir = tempDir(t);
  const one = makeEconomy(dir);
  const token = 'C'.repeat(43);
  const a = conn();
  assert.equal(await hello(one.svc, a, token), undefined, 'no replacement token, so the browser keeps its own');
  assert.ok(a.accountId);
  const again = conn();
  await hello(one.svc, again, token);
  assert.equal(again.accountId, a.accountId, 'the same token finds the same account');
  givePearls(one.svc, a, 40);
  one.store.dirtyAccount(a.accountId!);
  one.svc.close();
  const two = makeEconomy(dir);
  const back = conn();
  assert.equal(await hello(two.svc, back, token), undefined);
  assert.equal(acct(back).pearls, 40, 'after a restart the token still finds the account');
  two.svc.close();
});

test('F16: the browser keeps the previous token when a server sends a different one', () => {
  const ls = fakeStorage();
  const e = createEconomy();
  const key = 'ws://x/ws';
  e.attachServer(() => {}, key);
  e.receive({ t: 'account', a: view('acc_1'), token: 'D'.repeat(43) });
  e.receive({ t: 'account', a: view('acc_1') });
  assert.equal(e.tokenFor(key), 'D'.repeat(43));
  e.receive({ t: 'account', a: view('acc_2'), token: 'E'.repeat(43) });
  assert.equal(e.tokenFor(key), 'E'.repeat(43));
  const prev = JSON.parse(ls.get('hookwars.tokens.prev.v1') ?? '{}') as Record<string, string[]>;
  assert.deepEqual(prev[key], ['D'.repeat(43)], 'the old token is kept for recovery');
  e.detachServer();
});

test('F21: new guest accounts are limited per internet connection, and a refused player is told why', async () => {
  const { svc, clock } = makeEconomy(null, { perIp: 2 });
  assert.ok(await hello(svc, conn('10.9.9.9')));
  const rebound = conn('10.9.9.9');
  await hello(svc, rebound, 'F'.repeat(43)); // the second account, bound to its own token
  assert.ok(rebound.accountId);
  svc.onDisconnect(rebound); // an empty guest: dropped from memory
  const back = conn('10.9.9.9');
  await hello(svc, back, 'F'.repeat(43));
  assert.ok(back.accountId, 'the same browser coming back within the hour does not count twice');
  const third = conn('10.9.9.9');
  assert.equal(await hello(svc, third), undefined);
  assert.equal(third.accountId, null);
  const why = last(third, 'econError');
  assert.equal(why?.code, 'account_limit');
  assert.equal(why?.re, undefined, 'an account-state message, not an answer to a request');
  assert.match(why!.message, /Too many new accounts.*Try again in an hour/);
  send(svc, third, { t: 'storeBuy', item: COMMON });
  assert.equal(errors(third).at(-1), 'no_account');
  assert.ok(await hello(svc, conn('10.9.9.8')), 'another address is not affected');
  const v6a = conn('2001:db8:5:6::1');
  await hello(svc, v6a);
  await hello(svc, conn('2001:db8:5:6::2'));
  const v6c = conn('2001:db8:5:6:aaaa::3');
  await hello(svc, v6c);
  assert.equal(v6c.accountId, null, 'IPv6 addresses in one /64 are one connection');
  clock.t += 3601_000;
  assert.ok(await hello(svc, conn('10.9.9.9')), 'an hour later it works again');
  svc.close();
});

test('F21: the client shows why it has no account instead of "Still signing in" or a Pearl shortfall', (t) => {
  fakeStorage();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const e = createEconomy();
  e.attachServer(() => {}, 'ws://y/ws');
  assert.equal(e.state().accountError, null, 'signing in');
  e.receive({ t: 'econError', code: 'account_limit', message: 'Too many new accounts were made from your internet connection.' });
  assert.match(e.state().accountError ?? '', /Too many new accounts/);
  e.buyWithPearls(EPIC);
  assert.match(e.state().error ?? '', /Too many new accounts/);
  assert.doesNotMatch(e.state().error ?? '', /more Pearls/);
  e.listForSale('itm_abcdefgh', 500);
  assert.match(e.state().error ?? '', /Too many new accounts/);
  // a successful action elsewhere never clears the reason
  e.receive({ t: 'econError', code: 'pearls', message: 'x', re: 'storeBuy' });
  assert.match(e.state().accountError ?? '', /Too many new accounts/);

  // a server that never answers: after SIGN_IN_MS the screens stop saying "Signing in..."
  const quiet = createEconomy();
  quiet.attachServer(() => {}, 'ws://z/ws');
  t.mock.timers.tick(SIGN_IN_MS - 1);
  assert.equal(quiet.state().accountError, null);
  t.mock.timers.tick(2);
  assert.match(quiet.state().accountError ?? '', /did not sign you in/);
  quiet.receive({ t: 'account', a: view('acc_9') });
  assert.equal(quiet.state().accountError, null, 'an account clears it');
  // a server that signs in on time never shows it
  const ok = createEconomy();
  ok.attachServer(() => {}, 'ws://w/ws');
  ok.receive({ t: 'account', a: view('acc_8') });
  t.mock.timers.tick(SIGN_IN_MS * 2);
  assert.equal(ok.state().accountError, null);
  // a server without accounts says so
  const offSent: EconomyClientMsg[] = [];
  const off = createEconomy();
  off.attachServer((m) => offSent.push(m as EconomyClientMsg), 'ws://v/ws');
  off.receive({ t: 'econError', code: 'disabled', message: 'This server runs without accounts.' });
  assert.match(off.state().accountError ?? '', /without accounts/);
  // and the Market screen does not ask it for listings, which would only answer with a second,
  // vaguer error toast ("You are not signed in...") on top of the reason
  const stop = off.watchMarket();
  off.refreshMarket();
  t.mock.timers.tick(MARKET_RENEW_MS * 2);
  assert.deepEqual(offSent, [], 'no market requests to a server that gave no account');
  assert.equal(off.state().error, null);
  stop();
  for (const x of [e, quiet, ok, off]) x.detachServer();
});

test('F21: a Market request that crosses the sign-in answer on a slow line shows the reason, never a second error toast', () => {
  fakeStorage();
  const sent: EconomyClientMsg[] = [];
  const reason = 'Accounts, the Store and the Market are unavailable on this server right now.';
  // the Market screen opens while still "Signing in": its request goes out before the account-state message is back
  const e = createEconomy();
  e.attachServer((m) => sent.push(m as EconomyClientMsg), 'ws://slow/ws');
  const stop = e.watchMarket();
  assert.equal(sent.length, 1);
  e.receive({ t: 'econError', code: 'disabled', message: reason, re: 'market' }); // the answer to that request
  assert.equal(e.state().error, null, 'a background market request never raises an error toast');
  assert.equal(e.state().accountError, reason, 'its answer says why there is no account');
  e.receive({ t: 'econError', code: 'disabled', message: reason }); // the account-state message, arriving in any order
  assert.equal(e.state().error, null);
  assert.equal(e.state().accountError, reason);
  stop();
  // the same for a server that refused this connection an account
  const r = createEconomy();
  r.attachServer(() => {}, 'ws://slow2/ws');
  r.watchMarket()();
  r.receive({ t: 'econError', code: 'no_account', message: 'You are not signed in to this server.', re: 'market' });
  assert.equal(r.state().error, null);
  assert.match(r.state().accountError ?? '', /not signed in/);
  r.receive({ t: 'econError', code: 'account_limit', message: 'Too many new accounts were made from your internet connection.' });
  assert.match(r.state().accountError ?? '', /Too many new accounts/, 'the precise reason replaces the vague one');
  for (const x of [e, r]) x.detachServer();
});

// ---------------------------------------------------------------------------------------------
// The store on disk (economy.db)
// ---------------------------------------------------------------------------------------------

test('accounts survive a restart, and only a hash of the token is written', async (t) => {
  const dir = tempDir(t);
  const one = makeEconomy(dir);
  const a = conn('10.0.0.1');
  const b = conn('10.0.0.2');
  const token = (await hello(one.svc, a))!;
  await hello(one.svc, b);
  const writes = one.store.writes;
  one.svc.onMatchEnd([{ connId: a.id, won: true, row: row(0) }, { connId: b.id, won: false, row: row(1) }]);
  assert.equal(one.store.writes, writes + 1, 'match Pearls are committed at once, both players in one transaction');
  const pearls = acct(a).pearls;
  assert.ok(pearls > 0);
  one.svc.close();
  const disk = readFileSync(join(dir, DB_FILE));
  assert.ok(!disk.includes(token), 'the token itself is never stored');
  assert.ok(disk.includes(sha256Hex(token)));
  assert.ok(existsSync(join(dir, `${DB_FILE}.bak`)), 'one backup per start');

  const two = makeEconomy(dir);
  const again = conn();
  assert.equal(await hello(two.svc, again, token), undefined);
  assert.equal(acct(again).id, acct(a).id);
  assert.equal(acct(again).pearls, pearls);
  assert.equal(acct(again).stats.wins, 1);
  two.svc.close();
});

test('F10: a second server on a held data folder runs without an economy and hands out no tokens', async (t) => {
  const dir = tempDir(t);
  const first = new AccountStore({ dir, log: () => {} });
  assert.throws(() => new AccountStore({ dir, log: () => {} }), StoreLockedError);
  const lines: string[] = [];
  const econ = createEconomyFromConfig({ enabled: true, dataDir: dir, problems: [] }, { log: (s) => lines.push(s) });
  assert.ok(!(econ instanceof EconomyService), 'the null economy, not a memory-only service');
  assert.ok(lines.some((l) => /ERROR: .*economy\.db is in use/.test(l) && /Do not point this server at a new folder/.test(l)), lines.join('\n'));
  const c = conn();
  await hello(econ, c, 'A'.repeat(43));
  assert.equal(count(c, 'account'), 0, 'no account and no token: the browser keeps its saved one');
  assert.deepEqual(errors(c), ['disabled']);
  econ.close();
  first.close();
  const after = new AccountStore({ dir, log: () => {} });
  assert.equal(after.persistent, true, 'free again once the first one closed');
  after.close();
});

test('F10: a server killed outright leaves no lock behind, and what it committed is kept', async (t) => {
  const dir = tempDir(t);
  const url = (p: string) => new URL(`../${p}`, import.meta.url).href; // works from any working directory
  const token = 'K'.repeat(43);
  const code = `
    const { AccountStore } = await import(${JSON.stringify(url('server/economy/store.ts'))});
    const { EconomyService } = await import(${JSON.stringify(url('server/economy/service.ts'))});
    const { DEFAULT_LOADOUT } = await import(${JSON.stringify(url('shared/cosmetics.ts'))});
    const store = new AccountStore({ dir: ${JSON.stringify(dir)}, log: () => {} });
    const svc = new EconomyService({ store, log: () => {} });
    const c = { id: 1, ip: '10.0.0.1', profile: { name: 'Killed', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler } }, accountId: null, send() {} };
    svc.onHello(c, ${JSON.stringify(token)});
    svc.accountById(c.accountId).pearls = 3000;
    svc.route(c, { t: 'storeBuy', item: ${JSON.stringify(EPIC)} }); // commits at once
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  await new Promise<void>((res, rej) => {
    child.stdout.once('data', () => res());
    child.once('exit', (n) => rej(new Error(`child exited ${n}: ${err}`)));
  });
  // while it runs, a second server gets no economy
  assert.throws(() => new AccountStore({ dir, log: () => {} }), StoreLockedError);
  const exited = new Promise((res) => child.once('exit', res));
  child.kill(); // TerminateProcess on Windows, SIGTERM elsewhere: no shutdown code runs
  await exited;
  const { svc } = makeEconomy(dir);
  const c = conn();
  assert.equal(await hello(svc, c, token), undefined);
  assert.equal(acct(c).pearls, 3000 - cosmeticById(EPIC)!.pearls!, 'the committed purchase survived the kill');
  assert.ok(acct(c).owned.some((o) => o.item === EPIC));
  svc.close();
});

test('F10: a left-over economy.lock naming a live process is ignored (no pid file decides anything)', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'economy.lock'), JSON.stringify({ pid: process.pid, started: '2026-10-01T00:00:00.000Z' }));
  const s = new AccountStore({ dir, log: () => {} });
  assert.equal(s.persistent, true);
  s.close();
});

test('F16: data that cannot be read never starts an empty economy, and the file is left alone', async (t) => {
  const dir = tempDir(t);
  const broken = '{"v":1,"accounts":{';
  writeFileSync(join(dir, 'economy.json'), broken);
  writeFileSync(join(dir, 'economy.json.bak'), legacyFile({ acc_old00001: LEGACY_ACC('acc_old00001') }, '2026-10-01T00:00:00.000Z'));
  assert.throws(() => new AccountStore({ dir, log: () => {} }), (e: unknown) => e instanceof StoreUnreadableError && /economy\.json\.bak/.test(e.message));
  const lines: string[] = [];
  const econ = createEconomyFromConfig({ enabled: true, dataDir: dir, problems: [] }, { log: (s) => lines.push(s) });
  assert.ok(lines.some((l) => /ERROR: .*could not be read/.test(l)));
  const c = conn();
  await hello(econ, c, 'B'.repeat(43));
  assert.equal(count(c, 'account'), 0, 'no empty account and no new token');
  econ.close();
  assert.equal(readFileSync(join(dir, 'economy.json'), 'utf8'), broken, 'the unreadable file stays where it is, unchanged');
  assert.ok(!readdirSync(dir).some((f) => f.includes('corrupt')), 'nothing was moved aside');

  // a database file that is not a database
  const dir2 = tempDir(t);
  writeFileSync(join(dir2, DB_FILE), 'this is not a database, it is a text file '.repeat(200));
  const before = readFileSync(join(dir2, DB_FILE));
  assert.throws(() => new AccountStore({ dir: dir2, log: () => {} }), StoreUnreadableError);
  assert.ok(!(createEconomyFromConfig({ enabled: true, dataDir: dir2, problems: [] }, { log: () => {} }) instanceof EconomyService));
  assert.ok(readFileSync(join(dir2, DB_FILE)).equals(before), 'the database file was not changed');
});

/** A data folder with n accounts, started twice so economy.db.bak holds them all. */
function seededFolder(t: { after: (fn: () => void) => void }, n: number): string {
  const dir = tempDir(t);
  const { svc, store } = makeEconomy(dir);
  for (let i = 0; i < n; i++) {
    const c = conn(`10.3.${i >> 8}.${i & 255}`);
    c.profile = svc.onHello(c, undefined);
    givePearls(svc, c, 100 + i);
    store.dirtyAccount(c.accountId!);
  }
  svc.close();
  new AccountStore({ dir, log: () => {} }).close();
  return dir;
}

/**
 * With page p zeroed: does the small meta / first-row reading still work (head), can every row
 * still be read (rows), and does PRAGMA quick_check pass (check)?
 */
function probePage(src: Buffer, pageSize: number, p: number, scratch: string): { head: boolean; rows: boolean; check: boolean } {
  const b = Buffer.from(src);
  b.fill(0, p * pageSize, (p + 1) * pageSize);
  writeFileSync(scratch, b);
  const db: { d: DatabaseSync | null } = { d: null };
  const ok = (qs: string[]) => {
    try {
      db.d ??= new DatabaseSync(scratch);
      for (const q of qs) db.d.prepare(q).all();
      return true;
    } catch {
      return false;
    }
  };
  const head = ok(["SELECT v FROM meta WHERE k = 'schema'", "SELECT v FROM meta WHERE k = 'imported'", 'SELECT k, v FROM meta', 'SELECT EXISTS(SELECT 1 FROM accounts) AS a, EXISTS(SELECT 1 FROM listings) AS l']);
  const rows = head && ok(['SELECT id, data FROM accounts', 'SELECT id, data FROM listings']);
  let check = true;
  try {
    const r = db.d!.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    check = r.length === 1 && r[0].quick_check === 'ok';
  } catch {
    check = false;
  }
  db.d?.close();
  return { head, rows, check };
}

test('E1: a damaged page inside economy.db gives the null economy (never a crash), and neither economy.db nor its backup is touched', async (t) => {
  const dir = seededFolder(t, 1200);
  const file = join(dir, DB_FILE);
  const bakFile = join(dir, `${DB_FILE}.bak`);
  const src = readFileSync(file);
  const bak = readFileSync(bakFile);
  const pageSize = src.readUInt16BE(16) === 1 ? 65536 : src.readUInt16BE(16);
  const scratch = join(tempDir(t), 'probe.db');
  let inRows = -1;
  let onlyCheck = -1;
  for (let p = 1; p < src.length / pageSize && (inRows < 0 || onlyCheck < 0); p++) {
    const r = probePage(src, pageSize, p, scratch);
    if (r.head && !r.rows && inRows < 0) inRows = p; // the full row scan at load is the first to see it
    if (r.rows && !r.check && onlyCheck < 0) onlyCheck = p; // reading every row never sees it
  }
  assert.ok(inRows > 0 && onlyCheck > 0, `found both kinds of page (rows ${inRows}, check only ${onlyCheck})`);
  const cases: [string, number][] = [['a page the account rows live on', inRows], ['a page that reading the rows never touches (an index)', onlyCheck]];
  for (const [what, p] of cases) {
    const b = Buffer.from(src);
    b.fill(0, p * pageSize, (p + 1) * pageSize);
    writeFileSync(file, b);
    const lines: string[] = [];
    let econ: ServerEconomy | undefined;
    assert.doesNotThrow(() => {
      econ = createEconomyFromConfig({ enabled: true, dataDir: dir, problems: [] }, { log: (s) => lines.push(s) });
    }, `${what}: the server must still start`);
    assert.ok(econ && !(econ instanceof EconomyService), `${what}: the null economy, not a service`);
    assert.ok(lines.some((l) => /ERROR: .*economy\.db could not be (read|opened)/.test(l)), `${what}: ${lines.join(' | ')}`);
    const c = conn();
    await hello(econ, c, 'G'.repeat(43));
    assert.equal(count(c, 'account'), 0, `${what}: no account and no new token`);
    assert.deepEqual(errors(c), ['disabled']);
    econ.close();
    assert.ok(readFileSync(file).equals(b), `${what}: economy.db was not changed`);
    assert.ok(readFileSync(bakFile).equals(bak), `${what}: the last good economy.db.bak is kept`);
  }
});

test('E1: a data folder that cannot be created gives the null economy with a loud log, not a crash', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'not-a-folder'), 'a file where the data folder should be');
  const lines: string[] = [];
  let econ: ServerEconomy | undefined;
  assert.doesNotThrow(() => {
    econ = createEconomyFromConfig({ enabled: true, dataDir: join(dir, 'not-a-folder', 'data'), problems: [] }, { log: (s) => lines.push(s) });
  });
  assert.ok(econ && !(econ instanceof EconomyService));
  assert.ok(lines.some((l) => /ERROR: the economy data in .*not-a-folder.* could not be opened/.test(l)), lines.join(' | '));
  const c = conn();
  await hello(econ, c, 'H'.repeat(43));
  assert.equal(count(c, 'account'), 0);
  econ.close();
});

test('the old economy.json is imported once: newest complete file wins, no wallets, orders or empty guests', (t) => {
  const dir = tempDir(t);
  const accounts = {
    acc_test0001: LEGACY_ACC('acc_test0001', { pearls: 100, wallet: 'So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxx' }),
    acc_guest001: LEGACY_ACC('acc_guest001', { pearls: 0, stats: { matches: 0, wins: 0, kills: 0, hooksHit: 0 } }),
  };
  writeFileSync(join(dir, 'economy.json'), legacyFile(accounts, '2026-10-08T10:00:00.000Z'));
  // fsync done, rename not: a complete newer temp file
  const newer = {
    ...accounts,
    acc_test0001: LEGACY_ACC('acc_test0001', {
      pearls: 250, wallet: 'So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxx',
      owned: [{ instance: 'itm_epic0001', item: EPIC, listed: 'lst_sale0001' }, { instance: 'itm_prem0001', item: PREMIUM, serial: 3, asset: 'AssetAddre55' }],
    }),
  };
  const listings = {
    lst_sale0001: { id: 'lst_sale0001', seller: 'acc_test0001', sellerName: 'X', instance: 'itm_epic0001', item: EPIC, price: { cur: 'pearls', amount: 900 }, created: T0 },
    lst_usdc0001: { id: 'lst_usdc0001', seller: 'acc_test0001', sellerName: 'X', instance: 'itm_prem0001', item: PREMIUM, price: { cur: 'usdc', amount: 9 }, created: T0 },
  };
  writeFileSync(join(dir, 'economy.json.tmp-1-aaaaaa'), legacyFile(newer, '2026-10-08T10:00:05.000Z', listings));
  // a torn temp file from a crash during the write itself
  writeFileSync(join(dir, 'economy.json.tmp-2-bbbbbb'), legacyFile(newer, '2026-10-08T10:00:09.000Z').slice(0, 60));
  writeFileSync(join(dir, 'economy.lock'), JSON.stringify({ pid: 999999 }));
  const s1 = new AccountStore({ dir, log: () => {} });
  const a = s1.db.accounts.get('acc_test0001')!;
  assert.equal(a.pearls, 250);
  assert.equal('wallet' in a, false, 'wallet addresses are not imported');
  assert.deepEqual(a.owned[1], { instance: 'itm_prem0001', item: PREMIUM }, 'serial and asset dropped');
  assert.equal(s1.db.accounts.has('acc_guest001'), false, 'empty guests are not imported');
  assert.deepEqual([...s1.db.listings.keys()], ['lst_sale0001'], 'USDC listings are not imported');
  s1.close();
  const files = readdirSync(dir);
  assert.ok(files.some((f) => /^economy\.json\.imported-/.test(f)) && !files.includes('economy.json'), files.join(', '));
  assert.ok(!files.includes('economy.lock'), 'the old pid lock is removed');
  assert.ok(!readFileSync(join(dir, DB_FILE)).includes('So1anaWa11et'), 'no wallet address in the database');
  // a second start does not import again, even if an economy.json turns up
  writeFileSync(join(dir, 'economy.json'), legacyFile({ acc_late0001: LEGACY_ACC('acc_late0001') }, '2026-10-09T00:00:00.000Z'));
  const s2 = new AccountStore({ dir, log: () => {} });
  assert.equal(s2.db.accounts.has('acc_late0001'), false);
  assert.equal(s2.db.accounts.get('acc_test0001')!.pearls, 250);
  s2.close();
});

test('F11/F19: empty drive-by guests never reach the disk, leave memory with their socket, and keep their token', async (t) => {
  const dir = tempDir(t);
  const { svc, store } = makeEconomy(dir);
  const ids: string[] = [];
  const tokens: string[] = [];
  for (let i = 0; i < 10; i++) {
    const c = conn(`10.1.0.${i}`);
    tokens.push((await hello(svc, c))!);
    ids.push(c.accountId!);
    svc.onDisconnect(c);
  }
  store.flush();
  assert.equal(store.rowsWritten, 0, 'nothing was written');
  for (const id of ids) assert.equal(svc.accountById(id), undefined, 'an empty guest is gone from memory once it left');
  const back = conn('10.1.0.3');
  assert.equal(await hello(svc, back, tokens[3]), undefined, 'coming back with its token: no new token');
  assert.ok(back.accountId);
  svc.close();
  assert.ok(!readFileSync(join(dir, DB_FILE)).includes(sha256Hex(tokens[0])), 'no guest row on disk');
});

test('F11/F19: a save writes only the rows that changed, and nothing when nothing changed', async (t) => {
  const dir = tempDir(t);
  const { svc, store } = makeEconomy(dir);
  const players: TestConn[] = [];
  for (let i = 0; i < 300; i++) {
    const c = conn(`10.2.${i >> 8}.${i & 255}`);
    await hello(svc, c);
    givePearls(svc, c, 10 + i);
    store.dirtyAccount(c.accountId!);
    players.push(c);
  }
  store.flush();
  const me = players[7];
  givePearls(svc, me, 5000);
  store.flush();
  const rows = store.rowsWritten;
  const writes = store.writes;
  for (let i = 0; i < 5; i++) send(svc, me, { t: 'equip', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler } }); // changes nothing
  svc.sanitize(me, me.profile); // same name, same loadout
  await hello(svc, conn('10.2.0.7'), undefined); // a fresh guest: not written
  await new Promise((r) => setTimeout(r, 20));
  store.flush();
  assert.equal(store.writes, writes, 'no save for an equip, a profile or a guest that changed nothing on disk');
  send(svc, me, { t: 'storeBuy', item: EPIC });
  assert.equal(store.rowsWritten - rows, 1, 'a purchase writes one row, not 300');
  assert.equal(store.writes, writes + 1, 'and commits at once');
  svc.close();
});

// ---------------------------------------------------------------------------------------------
// Loadouts, the store and premium items
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
  send(svc, a, { t: 'storeBuy', item: 'brawler.captain_cap' });
  assert.equal(errors(a).at(-1), 'not_for_sale', 'default items are not sold');
  svc.close();
});

test('premium items: never sold, granted, worn, listed or shown as owned in this build', async () => {
  const { svc } = makeEconomy(null);
  const a = conn();
  await hello(svc, a);
  veteran(svc, a);
  givePearls(svc, a, 99_999);
  send(svc, a, { t: 'storeBuy', item: PREMIUM });
  assert.equal(errors(a).at(-1), 'steam_only');
  assert.match(last(a, 'econError')!.message, /Steam version/);
  // a copy left on an imported record from the old Solana build
  rec(svc, a).owned.push({ instance: 'itm_prem0001', item: PREMIUM });
  send(svc, a, { t: 'equip', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler, hands: PREMIUM } });
  assert.equal(acct(a).loadouts.brawler.hands, DEFAULT_LOADOUT.brawler.hands, 'cannot be worn');
  assert.ok(!acct(a).owned.some((o) => o.item === PREMIUM), 'not shown as owned');
  send(svc, a, { t: 'marketSell', instance: 'itm_prem0001', price: { cur: 'pearls', amount: 500 } });
  assert.equal(errors(a).at(-1), 'not_owned');
  assert.ok(rec(svc, a).owned.some((o) => o.item === PREMIUM), 'the record keeps it, untouched');
  // the client agrees
  fakeStorage();
  const e = createEconomy();
  e.attachServer(() => {}, 'ws://p/ws');
  e.receive({ t: 'account', a: view('acc_p', { owned: [{ instance: 'itm_prem0001', item: PREMIUM }] }) });
  assert.equal(e.owns(PREMIUM), false);
  e.buyWithPearls(PREMIUM);
  assert.match(e.state().error ?? '', /Steam version/);
  e.detachServer();
  svc.close();
});

// ---------------------------------------------------------------------------------------------
// Rewards and anti-farm
// ---------------------------------------------------------------------------------------------

test('match rewards: full rate needs two connections, two tabs are paid once, AFK pays nothing', async () => {
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
  const first = conn('10.0.0.3');
  const tokenC = (await hello(svc, first))!;
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

  // two IPv6 addresses in one /64 are one home
  const f = conn('2001:db8:1:2::10');
  const g = conn('2001:db8:1:2:8000::11');
  await hello(svc, f);
  await hello(svc, g);
  svc.onMatchEnd([{ connId: f.id, won: true, row: row(0) }, { connId: g.id, won: false, row: row(1) }]);
  assert.equal(acct(f).pearls, Math.round(full * SOLO_PEARL_RATE));
  svc.close();
});

test('connection keys: IPv4 as is, IPv4-mapped unwrapped, IPv6 by /64', () => {
  assert.equal(netKey('10.0.0.1'), '10.0.0.1');
  assert.equal(netKey('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(netKey('2001:db8::7'), netKey('2001:db8::8'));
  assert.equal(netKey('2001:DB8:0:0:1:2:3:4'), netKey('2001:db8::9'));
  assert.notEqual(netKey('2001:db8:0:1::7'), netKey('2001:db8::7'));
  assert.equal(netKey('fe80::1%eth0'), netKey('fe80::2'));
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
  assert.match(last(a, 'reward')!.reason, /daily limit of 2000 reached/);
  assert.equal(acct(a).stats.matches, 15, 'stats still count');
  clock.t += DAY;
  svc.onMatchEnd([{ connId: a.id, won: true, row: big }, { connId: b.id, won: false, row: row(1) }]);
  assert.equal(acct(a).pearls, DAILY_PEARL_CAP + 200);
  assert.equal(acct(a).earnedToday, 200);
  svc.close();
});

test('F20: throwaway accounts on two connections cannot beat the daily cap, and cannot move Pearls through the market', async () => {
  const { svc, clock } = makeEconomy(null);
  const main = conn('198.51.100.7');
  const farms = [conn('198.51.100.7'), conn('2001:db8::7'), conn('2001:db8::8'), conn('198.51.100.7')];
  const all = [main, ...farms];
  for (const c of all) await hello(svc, c);
  veteran(svc, main);
  givePearls(svc, main, 2400);
  send(svc, main, { t: 'storeBuy', item: EPIC });
  const epic = rec(svc, main).owned[0].instance;
  const start = rec(svc, main).pearls;
  const big = (i: number) => row(i, { k: 5, hh: 10, ht: 12, sv: 0 });
  for (let m = 0; m < 24; m++) svc.onMatchEnd(all.map((c, k) => ({ connId: c.id, won: true, row: big(k) })));
  const byNet = new Map<string, number>();
  for (const c of all) byNet.set(netKey(c.ip), (byNet.get(netKey(c.ip)) ?? 0) + rec(svc, c).pearls);
  for (const [k, n] of byNet) assert.ok(n <= DAILY_PEARL_CAP_PER_IP, `${k} earned ${n} Pearls in one day`);
  assert.ok(farms.some((f) => /internet connection/.test(last(f, 'reward')!.reason)), 'the player is told which limit stopped them');
  // consolidate: main lists its Epic at a farm's balance, the farm buys it, relists it at 50, main buys it back
  const tryMove = () => {
    for (const f of farms) {
      const price = rec(svc, f).pearls;
      if (price < 50) continue;
      send(svc, main, { t: 'marketSell', instance: epic, price: { cur: 'pearls', amount: price } });
      const l1 = [...svc['store'].db.listings.values()].find((l: Listing) => l.seller === main.accountId);
      if (!l1) continue;
      send(svc, f, { t: 'marketBuy', listing: l1.id });
      const got = rec(svc, f).owned.find((o) => o.item === EPIC);
      if (!got) {
        send(svc, main, { t: 'marketCancel', listing: l1.id });
        continue;
      }
      send(svc, f, { t: 'marketSell', instance: got.instance, price: { cur: 'pearls', amount: 50 } });
      const l2 = [...svc['store'].db.listings.values()].find((l: Listing) => l.seller === f.accountId);
      if (l2) send(svc, main, { t: 'marketBuy', listing: l2.id });
    }
  };
  tryMove();
  assert.equal(rec(svc, main).pearls - start <= DAILY_PEARL_CAP, true, `main gained ${rec(svc, main).pearls - start} Pearls in a day`);
  assert.ok(farms.every((f) => errors(f).includes('too_new')), 'accounts made today cannot buy on the market');
  assert.match(last(farms[0], 'econError')!.message, /a day old and has played 10 online matches/);
  // a day later the farms may trade, but the most that can move is what their connections earned
  clock.t += DAY;
  for (const f of farms) veteran(svc, f, clock.t);
  const before = rec(svc, main).pearls;
  tryMove();
  assert.ok(rec(svc, main).pearls - before <= 2 * DAILY_PEARL_CAP_PER_IP, 'bounded by the per-connection cap');
  svc.close();
});

test('F20: over five days a farm on two connections is bounded by its connections, not by how many accounts it makes', async () => {
  const { svc, clock } = makeEconomy(null);
  const main = conn('198.51.100.9');
  const farms = [conn('198.51.100.9'), conn('198.51.100.9'), conn('198.51.100.9'), conn('2001:db8:9::1'), conn('2001:db8:9::2'), conn('2001:db8:9:0:1::3')];
  const all = [main, ...farms];
  for (const c of all) await hello(svc, c);
  veteran(svc, main);
  givePearls(svc, main, 2400);
  send(svc, main, { t: 'storeBuy', item: EPIC });
  const start = rec(svc, main).pearls;
  const DAYS = 5;
  const connections = new Set(all.map((c) => netKey(c.ip))).size;
  assert.equal(connections, 2);
  let minted = 0;
  for (let d = 0; d < DAYS; d++) {
    const before = all.reduce((s, c) => s + rec(svc, c).pearls, 0);
    for (let m = 0; m < 24; m++) svc.onMatchEnd(all.map((c, k) => ({ connId: c.id, won: true, row: row(k, { k: 5, hh: 10, ht: 12, sv: 0 }) })));
    minted += all.reduce((s, c) => s + rec(svc, c).pearls, 0) - before;
    // the farms ship everything to main: main lists its Epic at a farm's balance, the farm buys it, relists it at 50, main buys it back
    for (const f of farms) {
      const price = Math.min(rec(svc, f).pearls, 1_000_000);
      if (price < 50) continue;
      const epic = rec(svc, main).owned.find((o) => o.item === EPIC && !o.listed);
      if (!epic) break;
      send(svc, main, { t: 'marketSell', instance: epic.instance, price: { cur: 'pearls', amount: price } });
      const l1 = [...svc['store'].db.listings.values()].find((l: Listing) => l.seller === main.accountId);
      if (!l1) continue;
      send(svc, f, { t: 'marketBuy', listing: l1.id });
      const got = rec(svc, f).owned.find((o) => o.item === EPIC);
      if (!got) {
        send(svc, main, { t: 'marketCancel', listing: l1.id });
        continue;
      }
      send(svc, f, { t: 'marketSell', instance: got.instance, price: { cur: 'pearls', amount: 50 } });
      const l2 = [...svc['store'].db.listings.values()].find((l: Listing) => l.seller === f.accountId);
      if (l2) send(svc, main, { t: 'marketBuy', listing: l2.id });
    }
    clock.t += DAY;
  }
  const gained = rec(svc, main).pearls - start;
  const bound = DAYS * connections * DAILY_PEARL_CAP_PER_IP;
  assert.ok(minted <= bound, `${all.length} accounts minted ${minted} Pearls in ${DAYS} days, more than ${connections} connections may (${bound})`);
  assert.ok(gained <= bound, `main gained ${gained} in ${DAYS} days (bound ${bound}; one honest account earns ${DAYS * DAILY_PEARL_CAP})`);
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
  veteran(svc, seller);
  veteran(svc, buyer);
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

test('a trade is saved as one transaction and survives a restart on both sides', async (t) => {
  const dir = tempDir(t);
  const one = makeEconomy(dir);
  const seller = conn('10.0.0.1');
  const buyer = conn('10.0.0.2');
  const ts = (await hello(one.svc, seller))!;
  const tb = (await hello(one.svc, buyer))!;
  veteran(one.svc, seller);
  veteran(one.svc, buyer);
  givePearls(one.svc, seller, 2400);
  givePearls(one.svc, buyer, 1000);
  send(one.svc, seller, { t: 'storeBuy', item: EPIC });
  send(one.svc, seller, { t: 'marketSell', instance: acct(seller).owned[0].instance, price: { cur: 'pearls', amount: 700 } });
  const writes = one.store.writes;
  send(one.svc, buyer, { t: 'market' });
  send(one.svc, buyer, { t: 'marketBuy', listing: last(buyer, 'market')!.listings[0].id });
  assert.equal(one.store.writes, writes + 1, 'buyer, seller and listing in one commit');
  one.svc.close();
  const two = makeEconomy(dir);
  const s2 = conn();
  const b2 = conn();
  await hello(two.svc, s2, ts);
  await hello(two.svc, b2, tb);
  assert.equal(acct(s2).pearls, sellerProceeds(700));
  assert.equal(acct(s2).owned.length, 0);
  assert.equal(acct(b2).pearls, 300);
  assert.ok(acct(b2).owned.some((o) => o.item === EPIC));
  two.svc.close();
});

test('the market fee is always at least one Pearl and never more than 5% rounded up', () => {
  for (const p of [50, 51, 99, 100, 1234, 1_000_000]) {
    assert.ok(marketFee(p) >= 1);
    assert.equal(marketFee(p), Math.ceil(p * 0.05));
    assert.equal(sellerProceeds(p) + marketFee(p), p);
  }
});

test('F12: marketBuy and marketCancel with prototype names never save or push the market', async (t) => {
  const dir = tempDir(t);
  const { svc, store } = makeEconomy(dir);
  const c = conn();
  const watcher = conn('10.0.0.2');
  await hello(svc, c);
  await hello(svc, watcher);
  veteran(svc, c);
  givePearls(svc, watcher, 5);
  store.dirtyAccount(watcher.accountId!);
  store.flush();
  send(svc, watcher, { t: 'market' });
  const pushes = count(watcher, 'market');
  const writes = store.writes;
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'lst_doesnotexist']) {
    send(svc, c, { t: 'marketBuy', listing: id });
    send(svc, c, { t: 'marketCancel', listing: id });
  }
  svc.flushMarket();
  await new Promise((r) => setTimeout(r, 20));
  store.flush();
  assert.equal(store.writes - writes, 0, 'saves forced by a guest');
  assert.equal(count(watcher, 'market') - pushes, 0, 'market pushes forced by a guest');
  assert.ok(errors(c).every((e) => e === 'gone'));
  svc.close();
});

test('F14: a market subscription ends at once when the match starts, and when it is not renewed', async () => {
  const { svc, clock } = makeEconomy(null);
  const seller = conn('10.0.0.1');
  const idle = conn('10.0.0.2');
  const player = conn('10.0.0.3');
  const browsing = conn('10.0.0.4');
  for (const c of [seller, idle, player, browsing]) await hello(svc, c);
  veteran(svc, seller);
  givePearls(svc, seller, 9000);
  send(svc, seller, { t: 'storeBuy', item: EPIC });
  const inst = rec(svc, seller).owned[0].instance;
  const watchers = [idle, player, browsing];
  const pushed = (fn: () => void) => {
    const n0 = watchers.map((c) => count(c, 'market'));
    fn();
    svc.flushMarket();
    return watchers.map((c, i) => count(c, 'market') - n0[i]);
  };
  for (const c of watchers) send(svc, c, { t: 'market' });
  // 1. the player's match starts: the game server calls unwatchMarket, and pushes stop at once
  svc.unwatchMarket(player);
  assert.deepEqual(pushed(() => send(svc, seller, { t: 'marketSell', instance: inst, price: { cur: 'pearls', amount: 3000 } })), [1, 0, 1]);
  // 2. a minute later only the Market screen that kept renewing still gets live updates
  clock.t += MARKET_WATCH_MS + 1_000;
  send(svc, browsing, { t: 'market' });
  const listing = rec(svc, seller).owned[0].listed!;
  assert.deepEqual(pushed(() => send(svc, seller, { t: 'marketCancel', listing })), [0, 0, 1]);
  svc.close();
});

test('F14: the client renews the market while the screen is open and stops when it closes', (t) => {
  fakeStorage();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent: EconomyClientMsg[] = [];
  const e = createEconomy();
  e.attachServer((m) => sent.push(m as EconomyClientMsg), 'ws://m/ws');
  e.receive({ t: 'account', a: view('acc_m') });
  const stop = e.watchMarket();
  assert.equal(sent.filter((m) => m.t === 'market').length, 1, 'asks at once');
  assert.ok(MARKET_RENEW_MS < MARKET_WATCH_MS, 'renews inside the server lease');
  t.mock.timers.tick(MARKET_RENEW_MS * 3);
  assert.equal(sent.filter((m) => m.t === 'market').length, 4);
  stop();
  t.mock.timers.tick(MARKET_RENEW_MS * 10);
  assert.equal(sent.filter((m) => m.t === 'market').length, 4, 'nothing after the screen closed');
  stop();
  e.detachServer();
});

test('F20: an account under a day old, or with under 10 matches, cannot buy or sell on the market', async () => {
  const { svc, clock } = makeEconomy(null);
  const seller = conn('10.0.0.1');
  const fresh = conn('10.0.0.2');
  await hello(svc, seller);
  await hello(svc, fresh);
  veteran(svc, seller);
  givePearls(svc, seller, 2400);
  givePearls(svc, fresh, 5000);
  send(svc, seller, { t: 'storeBuy', item: EPIC });
  send(svc, seller, { t: 'marketSell', instance: rec(svc, seller).owned[0].instance, price: { cur: 'pearls', amount: 100 } });
  send(svc, fresh, { t: 'market' });
  const l = last(fresh, 'market')!.listings[0];
  send(svc, fresh, { t: 'marketBuy', listing: l.id });
  assert.equal(errors(fresh).at(-1), 'too_new');
  assert.match(last(fresh, 'econError')!.message, /24 more hours and 10 more online matches/);
  assert.equal(rec(svc, fresh).pearls, 5000);
  rec(svc, fresh).stats.matches = 10;
  clock.t += DAY - 3600_000;
  send(svc, fresh, { t: 'marketBuy', listing: l.id });
  assert.match(last(fresh, 'econError')!.message, /needs 1 more hour\./);
  clock.t += 3600_000;
  send(svc, fresh, { t: 'marketBuy', listing: l.id });
  assert.ok(rec(svc, fresh).owned.some((o) => o.item === EPIC), 'open after a day and 10 matches');
  // selling is held back the same way
  const newSeller = conn('10.0.0.3');
  await hello(svc, newSeller);
  givePearls(svc, newSeller, 2400);
  send(svc, newSeller, { t: 'storeBuy', item: EPIC });
  send(svc, newSeller, { t: 'marketSell', instance: rec(svc, newSeller).owned[0].instance, price: { cur: 'pearls', amount: 50 } });
  assert.equal(errors(newSeller).at(-1), 'too_new');
  // the client says so before sending
  fakeStorage();
  const e = createEconomy();
  const sent: EconomyClientMsg[] = [];
  e.attachServer((m) => sent.push(m as EconomyClientMsg), 'ws://n/ws');
  e.receive({ t: 'account', a: view('acc_n', { created: Date.now(), pearls: 900 }) });
  e.buyListing('lst_abcdefgh');
  assert.match(e.state().error ?? '', /a day old/);
  assert.equal(sent.length, 0);
  e.detachServer();
  svc.close();
});

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

test('F31: an account saved without a name gets a neutral one, never Pudgy or Butcher', (t) => {
  const dir = tempDir(t);
  const { name: _n, ...noName } = LEGACY_ACC('acc_noname01', { pearls: 100 });
  writeFileSync(join(dir, 'economy.json'), legacyFile({ acc_noname01: noName }, '2026-10-08T00:00:00.000Z'));
  const { svc } = makeEconomy(dir);
  const name = svc.accountById('acc_noname01')?.name;
  svc.close();
  assert.equal(name, UNIT_NOUN.one);
  assert.doesNotMatch(String(name), /pudgy|butcher/i);
});

test('results for unknown connections are ignored', () => {
  const { svc } = makeEconomy(null);
  const res: MatchResult[] = [{ connId: 99_999, won: true, row: row(0) }];
  assert.doesNotThrow(() => svc.onMatchEnd(res));
  svc.close();
});
