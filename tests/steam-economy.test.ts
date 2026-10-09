// Steam build, client economy: the offline locker in Steam Cloud (debounced writes, localStorage as
// the first copy, never lost when the Cloud fails), a trust server's 'local_only' answer, and the
// Pearls a client pays itself once per match on such a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPearls } from '../shared/cosmetics.ts';
import { SOLO_PEARL_RATE } from '../shared/economy.ts';
import type { MatchEnd, ServerMsg } from '../shared/protocol.ts';
import type { PlayerInfo, ScoreRow } from '../shared/types.ts';
import { createEconomy, LOCAL_ONLY_CODE, parseLocker } from '../client/economy/index.ts';
import { CLOUD_LOCKER_FILE, CloudSaver, type CloudStore } from '../client/economy/cloudLocker.ts';
import { matchKey, trustPayout } from '../client/economy/payout.ts';

const LOCKER_KEY = 'hookwars.locker.v1';
const COMMON = 'brawler.souwester'; // 300 Pearls
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(5);
  }
}

/** A fake browser localStorage; set fail to make every write throw (quota, blocked storage). */
function fakeStorage(): { ls: Map<string, string>; failWrites: boolean } {
  const st = { ls: new Map<string, string>(), failWrites: false };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => st.ls.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (st.failWrites) throw new Error('QuotaExceededError');
      st.ls.set(k, String(v));
    },
    removeItem: (k: string) => void st.ls.delete(k),
  };
  return st;
}

/** Steam Cloud stand-in (what SteamBridge.cloudRead / cloudWrite do through the desktop app). */
function fakeCloud(files: Record<string, string> = {}) {
  const c = {
    files: new Map(Object.entries(files)),
    reads: 0,
    writes: [] as string[],
    readFails: 0, // the next n reads reject
    writeFails: 0, // the next n writes resolve false
    writeThrows: false,
    store: null as unknown as CloudStore,
  };
  c.store = {
    async read(name) {
      c.reads++;
      if (c.readFails > 0) {
        c.readFails--;
        throw new Error('Steam Cloud is not available');
      }
      return c.files.get(name) ?? null;
    },
    async write(name, data) {
      if (c.writeThrows) throw new Error('IPC closed');
      if (c.writeFails > 0) {
        c.writeFails--;
        return false;
      }
      c.files.set(name, data);
      c.writes.push(data);
      return true;
    },
  };
  return c;
}

const FAST = { debounceMs: 5, retryMs: 5, retryMaxMs: 20 };
const lockerOf = (text: string | undefined) => parseLocker(text ?? null);

function savedLocker(pearls: number, savedAt: number, owned: string[] = []): string {
  return JSON.stringify({
    id: 'local', pearls, owned: owned.map((item, i) => ({ instance: `L${i}`, item })), loadouts: { brawler: {}, ogre: {}, bot: {} },
    stats: { matches: 3, wins: 1, kills: 9, hooksHit: 20 }, savedAt,
  });
}

// ---------------------------------------------------------------------------------------------
// Steam Cloud locker
// ---------------------------------------------------------------------------------------------

test('Cloud: a newer Cloud locker (another computer) replaces this one at start, and is kept in localStorage', async () => {
  const st = fakeStorage();
  st.ls.set(LOCKER_KEY, savedLocker(100, 1000));
  const cloud = fakeCloud({ [CLOUD_LOCKER_FILE]: savedLocker(2500, 5000, [COMMON]) });
  const e = createEconomy();
  assert.equal(e.state().account?.pearls, 100);
  const seen: number[] = [];
  e.onChange((s) => seen.push(s.account?.pearls ?? -1));
  assert.equal(await e.useCloud(cloud.store, FAST), 'cloud');
  assert.equal(e.state().account?.pearls, 2500, 'the newer Cloud copy was not used');
  assert.ok(e.owns(COMMON));
  assert.ok(seen.includes(2500), 'the screens were not told');
  assert.equal(lockerOf(st.ls.get(LOCKER_KEY))?.account.pearls, 2500, 'localStorage still has the old copy');
  await sleep(30);
  assert.equal(cloud.writes.length, 0, 'the Cloud copy it just read was written back');
});

test('Cloud: a newer local locker goes up to the Cloud; an empty Cloud gets this one; garbage in the Cloud is ignored', async () => {
  for (const cloudText of [savedLocker(50, 1000), undefined, '{not json', JSON.stringify({ pearls: 'lots' })]) {
    const st = fakeStorage();
    st.ls.set(LOCKER_KEY, savedLocker(900, 7000));
    const cloud = fakeCloud(cloudText === undefined ? {} : { [CLOUD_LOCKER_FILE]: cloudText });
    const e = createEconomy();
    assert.equal(await e.useCloud(cloud.store, FAST), 'local');
    assert.equal(e.state().account?.pearls, 900);
    await waitFor(() => cloud.writes.length === 1, 1000, `the upload (cloud was ${String(cloudText).slice(0, 20)})`);
    assert.equal(lockerOf(cloud.files.get(CLOUD_LOCKER_FILE))?.account.pearls, 900);
  }
});

test('Cloud: changes are written to localStorage at once and to the Cloud debounced, one write for a burst, newest data', async () => {
  const st = fakeStorage();
  const cloud = fakeCloud();
  const e = createEconomy(); // a fresh locker: 500 Pearls
  await e.useCloud(cloud.store, { ...FAST, debounceMs: 40 });
  await waitFor(() => cloud.writes.length === 1, 1000, 'first upload');
  for (let i = 0; i < 5; i++) e.grantLocal(10, 'solo match');
  assert.equal(lockerOf(st.ls.get(LOCKER_KEY))?.account.pearls, 550, 'localStorage was not written at once');
  assert.equal(cloud.writes.length, 1, 'the Cloud was written before the debounce');
  await waitFor(() => cloud.writes.length === 2, 1000, 'the debounced write');
  await sleep(80);
  assert.equal(cloud.writes.length, 2, 'five changes made more than one Cloud write');
  assert.equal(lockerOf(cloud.writes[1])?.account.pearls, 550);
  // flushCloud writes a pending change at once (the page is being hidden or closed)
  e.buyWithPearls(COMMON);
  assert.equal(await e.flushCloud(), true);
  assert.equal(cloud.writes.length, 3);
  assert.ok(lockerOf(cloud.writes[2])?.account.owned.some((o) => o.item === COMMON));
});

test('Cloud: failed writes keep the data and retry; the locker is never lost, not even with localStorage blocked', async () => {
  const st = fakeStorage();
  st.ls.set(LOCKER_KEY, savedLocker(300, 2000));
  const cloud = fakeCloud({ [CLOUD_LOCKER_FILE]: savedLocker(300, 2000) });
  const e = createEconomy();
  await e.useCloud(cloud.store, FAST);
  cloud.writeFails = 3; // Cloud full or Steam offline for a while
  e.grantLocal(40, 'solo match');
  assert.equal(lockerOf(st.ls.get(LOCKER_KEY))?.account.pearls, 340);
  await waitFor(() => cloud.writes.length === 1, 2000, 'the write after three failures');
  assert.equal(lockerOf(cloud.files.get(CLOUD_LOCKER_FILE))?.account.pearls, 340);
  // a write that throws (IPC gone) is the same: kept and retried
  cloud.writeThrows = true;
  e.grantLocal(60, 'solo match');
  await sleep(40);
  assert.equal(lockerOf(cloud.files.get(CLOUD_LOCKER_FILE))?.account.pearls, 340);
  cloud.writeThrows = false;
  await waitFor(() => lockerOf(cloud.files.get(CLOUD_LOCKER_FILE))?.account.pearls === 400, 2000, 'the retried write');
  // localStorage blocked: the Cloud still gets every change, and the page keeps working
  st.failWrites = true;
  e.grantLocal(100, 'solo match');
  assert.equal(e.state().account?.pearls, 500);
  await waitFor(() => lockerOf(cloud.files.get(CLOUD_LOCKER_FILE))?.account.pearls === 500, 2000, 'the Cloud write with localStorage blocked');
});

test('Cloud: a Cloud that cannot be read keeps the local locker and is not written over until the player changes something', async () => {
  const st = fakeStorage();
  st.ls.set(LOCKER_KEY, savedLocker(700, 3000));
  const cloud = fakeCloud({ [CLOUD_LOCKER_FILE]: savedLocker(9999, 9000) }); // newer, but unreadable right now
  cloud.readFails = 5;
  const e = createEconomy();
  assert.equal(await e.useCloud(cloud.store, { ...FAST, readTries: 3 }), 'failed');
  assert.equal(cloud.reads, 3, 'the read was not retried');
  assert.equal(e.state().account?.pearls, 700, 'the local locker was lost');
  await sleep(40);
  assert.equal(cloud.writes.length, 0, 'an unread Cloud copy was overwritten at start');
  // progress made from now on is saved (localStorage first, the Cloud after)
  e.grantLocal(20, 'solo match');
  assert.equal(lockerOf(st.ls.get(LOCKER_KEY))?.account.pearls, 720);
  await waitFor(() => cloud.writes.length === 1, 1000, 'the later write');
});

test('Cloud: a purchase made before the Cloud answered is not undone by an older Cloud copy', async () => {
  const st = fakeStorage();
  st.ls.set(LOCKER_KEY, savedLocker(600, Date.now() - 60_000));
  let answer: (v: string | null) => void = () => {};
  const slow: CloudStore = { read: () => new Promise((r) => (answer = r)), write: async () => true };
  const e = createEconomy();
  const loading = e.useCloud(slow, FAST);
  e.buyWithPearls(COMMON); // 600 - 300
  answer(savedLocker(600, Date.now() - 30_000)); // older than the purchase
  assert.equal(await loading, 'local');
  assert.equal(e.state().account?.pearls, 300);
  assert.ok(e.owns(COMMON), 'the purchase was undone by the Cloud copy');
  assert.equal(lockerOf(st.ls.get(LOCKER_KEY))?.account.pearls, 300);
});

test('Cloud: on a new install the Cloud copy wins, even over a click made before the Cloud answered', async () => {
  const st = fakeStorage(); // nothing saved on this computer
  let answer: (v: string | null) => void = () => {};
  const slow: CloudStore = { read: () => new Promise((r) => (answer = r)), write: async () => true };
  const e = createEconomy();
  const loading = e.useCloud(slow, FAST);
  e.buyWithPearls(COMMON); // the fresh 500-Pearl locker
  answer(savedLocker(4200, 1000, ['brawler.tricorn']));
  assert.equal(await loading, 'cloud');
  assert.equal(e.state().account?.pearls, 4200, 'a new install threw the Cloud locker away');
  assert.ok(e.owns('brawler.tricorn'));
  assert.equal(lockerOf(st.ls.get(LOCKER_KEY))?.account.pearls, 4200);
});

test('CloudSaver: holds writes while asked to, and refuses a locker over the size limit', async () => {
  const cloud = fakeCloud();
  const logs: string[] = [];
  const s = new CloudSaver(cloud.store, { ...FAST, log: (l) => logs.push(l) });
  s.hold(true);
  s.schedule('{"a":1}');
  await sleep(30);
  assert.equal(cloud.writes.length, 0);
  assert.equal(s.dirty, true);
  s.hold(false);
  await waitFor(() => cloud.writes.length === 1, 1000, 'the released write');
  assert.equal(s.dirty, false);
  s.schedule('x'.repeat(300 * 1024));
  await sleep(30);
  assert.equal(cloud.writes.length, 1);
  assert.match(logs.join(' '), /limit/);
  s.dispose();
});

// ---------------------------------------------------------------------------------------------
// local_only (ECONOMY=trust) and the self-paid Pearls
// ---------------------------------------------------------------------------------------------

test('local_only: on a trust server the client keeps its own locker (no Signing in...), and goes back to normal after', () => {
  fakeStorage();
  const e = createEconomy();
  const sent: unknown[] = [];
  e.attachServer((m) => sent.push(m), 'ws://127.0.0.1:5000/ws');
  assert.equal(e.state().mode, 'server');
  assert.equal(e.state().account, null);
  e.receive({ t: 'econError', code: LOCAL_ONLY_CODE, message: 'player hosted' } as ServerMsg);
  const s = e.state();
  assert.equal(s.mode, 'local');
  assert.equal(s.localOnly, true);
  assert.equal(s.account?.pearls, 500, 'the locker is not shown');
  assert.equal(s.accountError, null);
  // the locker works as offline: buying with its own Pearls, nothing sent to the server
  e.buyWithPearls(COMMON);
  assert.ok(e.owns(COMMON));
  assert.equal(e.state().account?.pearls, 200);
  assert.deepEqual(sent, []);
  // the Market says why it is not here
  e.listForSale('itm_abcdefgh', 100);
  assert.match(e.state().error ?? '', /hosted by a player/);
  // a later local_only answer to some request changes nothing
  e.receive({ t: 'econError', code: LOCAL_ONLY_CODE, message: 'x', re: 'storeBuy' } as ServerMsg);
  assert.equal(e.state().mode, 'local');
  e.detachServer();
  assert.equal(e.state().localOnly, false);
  assert.equal(e.state().mode, 'local');
  // a normal server's account still works the same afterwards
  e.attachServer(() => {}, 'ws://example.test/ws');
  assert.equal(e.state().localOnly, false);
  assert.equal(e.state().mode, 'server');
});

function end(players: PlayerInfo[], rows: ScoreRow[], winner: 0 | 1 | -1 = 0): MatchEnd {
  return { winner, score: [10, 4], rows, players };
}
const P = (id: number, team: 0 | 1, isBot = false): PlayerInfo => ({ id, name: `p${id}`, team, family: 'brawler', loadout: {}, isBot });
const R = (i: number, over: Partial<ScoreRow> = {}): ScoreRow => ({ i, k: 6, d: 2, a: 1, hh: 14, ht: 20, bs: 0, dr: 1, sv: 2, dmg: 500, g: 900, ...over });

test('self-paid Pearls: full rate with 2 or more humans, the solo rate alone, nothing without a hook thrown or as a spectator', () => {
  const full = matchPearls(true, 6, 14, 2);
  // two humans (and bots): full rate, a win
  assert.deepEqual(trustPayout(end([P(1, 0), P(2, 1), P(100, 0, true)], [R(1), R(2), R(100)]), 1), { pearls: full, reason: 'win' });
  // a loss
  assert.equal(trustPayout(end([P(1, 0), P(2, 1)], [R(1), R(2)], 1), 1).pearls, matchPearls(false, 6, 14, 2));
  // alone with bots: the solo rate
  const solo = trustPayout(end([P(1, 0), P(100, 1, true), P(101, 1, true)], [R(1), R(100), R(101)]), 1);
  assert.equal(solo.pearls, Math.round(full * SOLO_PEARL_RATE));
  assert.match(solo.reason, /half rate/);
  // never threw a hook: nothing
  assert.equal(trustPayout(end([P(1, 0), P(2, 1)], [R(1, { ht: 0, hh: 0 }), R(2)]), 1).pearls, 0);
  // spectating (no unit) or unknown: nothing
  assert.equal(trustPayout(end([P(1, 0), P(2, 1)], [R(1), R(2)]), -1).pearls, 0);
  assert.equal(trustPayout(end([P(1, 0), P(2, 1)], [R(1), R(2)]), 77).pearls, 0);
});

test('self-paid Pearls are paid once per match, however often the end arrives', () => {
  const st = fakeStorage();
  const e = createEconomy();
  e.attachServer(() => {}, 'ws://127.0.0.1:5000/ws');
  e.receive({ t: 'econError', code: LOCAL_ONLY_CODE, message: 'player hosted' } as ServerMsg);
  const key = matchKey('ABCDE', 123456);
  assert.equal(e.payLocalMatch(key, 80), true);
  assert.equal(e.payLocalMatch(key, 80), false, 'the same match paid twice');
  assert.equal(e.payLocalMatch(matchKey('ABCDE', 123456), 80), false);
  assert.equal(e.state().account?.pearls, 580);
  assert.equal(lockerOf(st.ls.get(LOCKER_KEY))?.account.pearls, 580, 'the payout was not saved');
  // the next match in the same room pays again
  assert.equal(e.payLocalMatch(matchKey('ABCDE', 999), 20), true);
  assert.equal(e.state().account?.pearls, 600);
  // a match with nothing earned still counts as paid (it is not paid later either)
  assert.equal(e.payLocalMatch(matchKey('FGHJK', 1), 0), true);
  assert.equal(e.payLocalMatch(matchKey('FGHJK', 1), 50), false);
  assert.equal(e.state().account?.pearls, 600);
});
