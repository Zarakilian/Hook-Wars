// Steam lobbies, server side: the trusted relay identity (RELAY_SECRET, x-hookwars-relay and
// x-hookwars-peer) and the trust economy (ECONOMY=trust) a player-hosted lobby runs with.
// The relay itself (desktop/**) is stood in for by ws clients that send the relay headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_LOADOUT } from '../shared/cosmetics.ts';
import { DEFAULT_CONFIG, PROTOCOL_VERSION } from '../shared/constants.ts';
import type { EconomyClientMsg } from '../shared/economy.ts';
import type { Profile, ServerMsg } from '../shared/protocol.ts';
import type { ScoreRow } from '../shared/types.ts';
import { GameServer, ipKey, JOIN_MISS_LIMIT, relayPeer } from '../server/gameServer.ts';
import { loadConfig, RELAY_PEER_HEADER, RELAY_PEER_RE, RELAY_SECRET_HEADER, relaySecretFrom, type ServerConfig } from '../server/config.ts';
// the desktop app's constants (read only: its relay and page origin must match what the server trusts)
import * as desktop from '../desktop/src/constants.ts';
import { createNullEconomy, type EconomyConn, type ServerEconomy } from '../server/economy/api.ts';
import { loadEconomyConfig } from '../server/economy/config.ts';
import { createEconomyFromConfig, createServerEconomy } from '../server/economy/index.ts';
import { EconomyService, netKey } from '../server/economy/service.ts';
import { createTrustEconomy, LOCAL_ONLY_CODE, trustLoadout } from '../server/economy/trust.ts';

const SECRET = 'relay-secret-0123456789abcdefXYZ';
const PEER_A = 'steam:76561198000000001';
const PEER_B = 'steam:76561198000000002';
const PROFILE: Profile = { name: 'Tester', family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler } };

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

async function startServer(over: Partial<ServerConfig> = {}, economy?: ServerEconomy) {
  const http = createServer((_, res) => res.end('ok'));
  const game = new GameServer({ ...loadConfig(), relaySecret: null, ...over }, economy ?? createNullEconomy());
  game.attach(http, { exclusive: true });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    game,
    close: async () => {
      game.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

const relayHeaders = (peer: string, secret = SECRET): Record<string, string> => ({ [RELAY_SECRET_HEADER]: secret, [RELAY_PEER_HEADER]: peer });

interface Client {
  ws: WebSocket;
  inbox: ServerMsg[];
  send(m: unknown): void;
  until(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>;
  close(): Promise<void>;
}

/** Open a socket; resolves with the client, or with the HTTP status the upgrade was refused with. */
function tryConnect(port: number, headers: Record<string, string> = {}): Promise<Client | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const inbox: ServerMsg[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as ServerMsg));
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('error', (err) => reject(err));
    ws.once('open', () => {
      resolve({
        ws,
        inbox,
        send: (m) => ws.send(JSON.stringify(m)),
        async until(pred, ms = 3000) {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            const m = inbox.find(pred);
            if (m) return m;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error(`timeout; inbox: ${inbox.map((x) => x.t).join(',')}`);
        },
        close: () =>
          new Promise<void>((r) => {
            if (ws.readyState === ws.CLOSED) return r();
            ws.once('close', () => r());
            ws.close();
          }),
      });
    });
  });
}

async function connected(port: number, headers: Record<string, string> = {}, profile: Profile = PROFILE): Promise<Client> {
  const c = await tryConnect(port, headers);
  assert.ok(typeof c !== 'number', `the connection was refused with HTTP ${String(c)}`);
  c.send({ t: 'hello', v: PROTOCOL_VERSION, profile });
  await c.until((m) => m.t === 'welcome');
  return c;
}

/** An economy that records the ip (key) of every hello. */
function recordingEconomy(): ServerEconomy & { ips: string[] } {
  const inner = createNullEconomy();
  const ips: string[] = [];
  return { ...inner, ips, onHello: (c, t) => (ips.push(c.ip), inner.onHello(c, t)) };
}

/** Room codes never use I or O, so these can never be a real room. */
const wrongCode = (i: number) => `IOIO${'ABCDEFGHJKLMNPQRSTUVWXYZ'[i % 24]}`;

// ---------------------------------------------------------------------------------------------
// Relay identity: the pure check
// ---------------------------------------------------------------------------------------------

test('relayPeer trusts the peer header only from 127.0.0.1 with the exact secret, each header once', () => {
  const h = relayHeaders(PEER_A);
  assert.equal(relayPeer('127.0.0.1', h, SECRET), PEER_A);
  assert.equal(relayPeer('::ffff:127.0.0.1', h, SECRET), PEER_A, 'an IPv4-mapped loopback socket is still the local app');
  // not from this machine's 127.0.0.1: ignored, whatever the headers say
  for (const addr of ['10.0.0.5', '::ffff:10.0.0.5', '192.168.1.20', '::1', '127.0.0.2', '0.0.0.0', '', undefined]) {
    assert.equal(relayPeer(addr, h, SECRET), null, `trusted a socket from ${String(addr)}`);
  }
  // no secret configured: never trusted
  assert.equal(relayPeer('127.0.0.1', h, null), null);
  assert.equal(relayPeer('127.0.0.1', h, undefined), null);
  assert.equal(relayPeer('127.0.0.1', h, ''), null);
  // a wrong secret, a prefix of it, the secret with more after it, other case: ignored
  for (const s of ['nope', SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), '', ` ${SECRET}`]) {
    assert.equal(relayPeer('127.0.0.1', relayHeaders(PEER_A, s), SECRET), null, `trusted the secret ${JSON.stringify(s)}`);
  }
  // a header sent twice arrives as an array: ignored
  assert.equal(relayPeer('127.0.0.1', { [RELAY_SECRET_HEADER]: SECRET, [RELAY_PEER_HEADER]: [PEER_A, PEER_B] as unknown as string }, SECRET), null);
  assert.equal(relayPeer('127.0.0.1', { [RELAY_SECRET_HEADER]: [SECRET, SECRET] as unknown as string, [RELAY_PEER_HEADER]: PEER_A }, SECRET), null);
  assert.equal(relayPeer('127.0.0.1', { [RELAY_SECRET_HEADER]: SECRET }, SECRET), null, 'no peer header');
  assert.equal(relayPeer('127.0.0.1', { [RELAY_PEER_HEADER]: PEER_A }, SECRET), null, 'no secret header');
  // the peer must be exactly steam: plus 1 to 20 digits
  for (const p of ['steam:', 'steam:abc', 'steam:123456789012345678901', 'Steam:1', ' steam:1', 'steam:1 ', 'steam:1\n2', 'steam:-1', '1.2.3.4', 'steam:1;steam:2']) {
    assert.equal(relayPeer('127.0.0.1', relayHeaders(p), SECRET), null, `accepted the peer ${JSON.stringify(p)}`);
  }
  assert.equal(relayPeer('127.0.0.1', relayHeaders('steam:1'), SECRET), 'steam:1');
  assert.equal(relayPeer('127.0.0.1', relayHeaders('steam:12345678901234567890'), SECRET), 'steam:12345678901234567890');
});

test('RELAY_SECRET is read from the environment only in its safe shape; unset means never trusted', () => {
  assert.equal(relaySecretFrom(undefined), null);
  assert.equal(relaySecretFrom(''), null);
  assert.equal(relaySecretFrom('   '), null);
  assert.equal(relaySecretFrom('short'), null, 'under 16 characters');
  assert.equal(relaySecretFrom('x'.repeat(129)), null, 'over 128 characters');
  assert.equal(relaySecretFrom('has spaces in it 0123456789'), null);
  assert.equal(relaySecretFrom('quote"or<angle>0123456789'), null);
  assert.equal(relaySecretFrom(` ${SECRET} `), SECRET);
  const before = process.env.RELAY_SECRET;
  try {
    delete process.env.RELAY_SECRET;
    assert.equal(loadConfig().relaySecret, null);
    process.env.RELAY_SECRET = SECRET;
    assert.equal(loadConfig().relaySecret, SECRET);
  } finally {
    if (before === undefined) delete process.env.RELAY_SECRET;
    else process.env.RELAY_SECRET = before;
  }
});

test('a Steam peer id is its own key for the per-IP limits and the economy (neighbouring SteamIDs never share one)', () => {
  assert.equal(ipKey(PEER_A), PEER_A);
  assert.equal(netKey(PEER_A), PEER_A);
  assert.notEqual(ipKey(PEER_A), ipKey(PEER_B));
  assert.notEqual(netKey(PEER_A), netKey(PEER_B));
  // ordinary addresses are unchanged
  assert.equal(ipKey('203.0.113.5'), '203.0.113.5');
  assert.equal(ipKey('2001:db8:1:2::5'), '2001:db8:1:2::/64');
  assert.equal(netKey('::ffff:1.2.3.4'), '1.2.3.4');
});

// ---------------------------------------------------------------------------------------------
// Relay identity: live sockets
// ---------------------------------------------------------------------------------------------

test('without RELAY_SECRET the relay headers are ignored: every loopback socket counts as 127.0.0.1', async () => {
  const econ = recordingEconomy();
  const s = await startServer({ maxPerIp: 1, relaySecret: null }, econ);
  try {
    const a = await connected(s.port, relayHeaders(PEER_A));
    assert.equal(await tryConnect(s.port, relayHeaders(PEER_B)), 429, 'a second spoofed peer got its own per-IP slot');
    assert.deepEqual(econ.ips, ['127.0.0.1'], 'the economy saw the spoofed peer id');
    await a.close();
  } finally {
    await s.close();
  }
});

test('with RELAY_SECRET set, a wrong secret is ignored (the socket counts as 127.0.0.1)', async () => {
  const econ = recordingEconomy();
  const s = await startServer({ maxPerIp: 1, relaySecret: SECRET }, econ);
  try {
    const a = await connected(s.port, relayHeaders(PEER_A, 'not-the-secret-0123456789'));
    assert.equal(await tryConnect(s.port, relayHeaders(PEER_B, 'not-the-secret-0123456789')), 429);
    assert.equal(await tryConnect(s.port), 429, 'the plain loopback socket shares the same 127.0.0.1 key');
    assert.deepEqual(econ.ips, ['127.0.0.1']);
    await a.close();
  } finally {
    await s.close();
  }
});

test('trusted relay sockets are keyed on their peer id: one connection slot per Steam player, the economy sees the peer', async () => {
  const econ = recordingEconomy();
  const s = await startServer({ maxPerIp: 1, relaySecret: SECRET }, econ);
  try {
    const host = await connected(s.port); // the host's own page, straight to the server
    const a = await connected(s.port, relayHeaders(PEER_A));
    const b = await connected(s.port, relayHeaders(PEER_B));
    assert.equal(await tryConnect(s.port, relayHeaders(PEER_A)), 429, 'the same Steam player got a second slot past MAX_PER_IP');
    assert.equal(await tryConnect(s.port), 429, 'the host key was not 127.0.0.1');
    assert.deepEqual(econ.ips, ['127.0.0.1', PEER_A, PEER_B]);
    // a peer's slot is freed when its socket closes
    await a.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await connected(s.port, relayHeaders(PEER_A));
    for (const c of [host, b, again]) await c.close();
  } finally {
    await s.close();
  }
});

test('the real desktop host path: ALLOWED_ORIGINS=app://hookwars lets the host page and the relay in, a web page out', async () => {
  // the desktop app's own names for the relay headers and the page origin must match the server's
  assert.equal(desktop.RELAY_SECRET_HEADER, RELAY_SECRET_HEADER);
  assert.equal(desktop.RELAY_PEER_HEADER, RELAY_PEER_HEADER);
  assert.ok(RELAY_PEER_RE.test(`${desktop.RELAY_PEER_PREFIX}76561198000000003`), 'the desktop peer id shape is not one the server trusts');
  const econ = recordingEconomy();
  const s = await startServer({ allowedOrigins: [desktop.APP_ORIGIN], relaySecret: SECRET }, econ);
  try {
    // (a) the host's own page, served from app://hookwars
    const page = await connected(s.port, { origin: desktop.APP_ORIGIN });
    // (b) a relayed joiner: exactly the headers desktop/src/hostRelay.ts sends (no Origin: it is Node, not a page)
    const peer = `${desktop.RELAY_PEER_PREFIX}76561198000000003`;
    const relayed = await connected(s.port, { [desktop.RELAY_SECRET_HEADER]: SECRET, [desktop.RELAY_PEER_HEADER]: peer });
    assert.deepEqual(econ.ips, ['127.0.0.1', peer], 'the relayed joiner was not keyed on its Steam id');
    // (c) any web page is refused, even one claiming the relay headers
    assert.equal(await tryConnect(s.port, { origin: 'https://evil.example' }), 403);
    assert.equal(await tryConnect(s.port, { origin: 'https://evil.example', ...relayHeaders(PEER_B) }), 403);
    assert.equal(await tryConnect(s.port, { origin: 'app://hookwars.evil' }), 403);
    for (const c of [page, relayed]) await c.close();
  } finally {
    await s.close();
  }
});

test('wrong room codes are counted per Steam player, not for everyone behind the local relay', async () => {
  const s = await startServer({ maxPerIp: 4, relaySecret: SECRET });
  try {
    const host = await connected(s.port);
    host.send({ t: 'createRoom', name: 'lobby', isPrivate: false, config: { ...DEFAULT_CONFIG, teamSize: 2 } });
    const code = ((await host.until((m) => m.t === 'room')) as Extract<ServerMsg, { t: 'room' }>).room.code;
    // peer A guesses JOIN_MISS_LIMIT wrong codes, a few per socket (each miss is a strike)
    let n = 0;
    while (n < JOIN_MISS_LIMIT) {
      const g = await connected(s.port, relayHeaders(PEER_A));
      for (let k = 0; k < 4 && n < JOIN_MISS_LIMIT; k++, n++) {
        g.send({ t: 'joinRoom', code: wrongCode(n) });
        await g.until((m) => m.t === 'error' && g.inbox.filter((x) => x.t === 'error').length === k + 1);
      }
      await g.close();
    }
    const blocked = await connected(s.port, relayHeaders(PEER_A));
    blocked.send({ t: 'joinRoom', code });
    const res = await blocked.until((m) => m.t === 'error' || m.t === 'room');
    assert.equal(res.t === 'error' && res.code, 'join_limit', 'the guessing peer was not blocked');
    // another Steam player through the same relay, and the host's own page, are not blocked
    const friend = await connected(s.port, relayHeaders(PEER_B));
    friend.send({ t: 'joinRoom', code });
    const ok = await friend.until((m) => m.t === 'error' || m.t === 'room');
    assert.equal(ok.t, 'room', `another Steam player was blocked: ${JSON.stringify(ok)}`);
    const direct = await connected(s.port);
    direct.send({ t: 'joinRoom', code: wrongCode(99) });
    const miss = await direct.until((m) => m.t === 'error');
    assert.equal(miss.t === 'error' && miss.code, 'no_room', 'the loopback key was blocked by a relayed guesser');
    for (const c of [host, blocked, friend, direct]) await c.close();
  } finally {
    await s.close();
  }
});

test('rooms per IP are counted per Steam player when relayed', async () => {
  const s = await startServer({ maxPerIp: 4, maxRoomsPerIp: 1, relaySecret: SECRET });
  const cfg = { ...DEFAULT_CONFIG, teamSize: 1 };
  try {
    const a = await connected(s.port, relayHeaders(PEER_A));
    a.send({ t: 'createRoom', name: 'a', isPrivate: false, config: cfg });
    await a.until((m) => m.t === 'room');
    // a second socket of the same player is over the limit...
    const a2 = await connected(s.port, relayHeaders(PEER_A));
    a2.send({ t: 'createRoom', name: 'a2', isPrivate: false, config: cfg });
    const err = await a2.until((m) => m.t === 'error' || m.t === 'room');
    assert.equal(err.t === 'error' && err.code, 'rooms_per_ip');
    // ...another player is not
    const b = await connected(s.port, relayHeaders(PEER_B));
    b.send({ t: 'createRoom', name: 'b', isPrivate: false, config: cfg });
    assert.equal((await b.until((m) => m.t === 'error' || m.t === 'room')).t, 'room');
    assert.equal(s.game.stats().rooms, 2);
    for (const c of [a, a2, b]) await c.close();
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------------------------
// ECONOMY=trust
// ---------------------------------------------------------------------------------------------

interface TestConn extends EconomyConn {
  inbox: ServerMsg[];
}
let nextId = 1;
function conn(profile: Profile = PROFILE, ip = PEER_A): TestConn {
  const c: TestConn = { id: nextId++, ip, profile, accountId: null, inbox: [], send: (m) => void c.inbox.push(m) };
  return c;
}
const tick = () => new Promise<void>((r) => setImmediate(r));

test('ECONOMY=trust: real catalog items of the right family pass; unknown, wrong-family and premium items are stripped', async () => {
  const econ = createTrustEconomy();
  // Pearl items of every rarity the player could own in their locker are worn as sent
  const brawlerLook = { head: 'brawler.tricorn', face: 'brawler.cigar', body: 'brawler.oilskin_apron', hands: 'brawler.rope_hook', feet: 'brawler.green_wellies' };
  const c = conn({ name: 'Ann', family: 'brawler', loadout: brawlerLook });
  assert.deepEqual(econ.onHello(c, undefined).loadout, brawlerLook);
  const epic = econ.sanitize(c, { name: 'Ann', family: 'brawler', loadout: { head: 'brawler.lighthouse_helm' } });
  assert.deepEqual(epic.loadout, { head: 'brawler.lighthouse_helm' }, 'an Epic item from the locker was stripped');
  // premium (Steam Item Store, a later phase): stripped
  const prem = econ.sanitize(c, { name: 'Ann', family: 'brawler', loadout: { head: 'brawler.tricorn', hands: 'brawler.golden_harpoon' } });
  assert.deepEqual(prem.loadout, { head: 'brawler.tricorn' });
  // wrong family, wrong slot and unknown ids: stripped (the hello parser drops them too; this is the economy's own check)
  const raw = { head: 'ogre.moss_mane', face: 'brawler.no_such_item', body: 'brawler.tricorn', feet: '__proto__' } as Record<string, string>;
  assert.deepEqual(econ.sanitize(c, { name: 'Ann', family: 'brawler', loadout: raw }).loadout, {});
  assert.deepEqual(trustLoadout('ogre', { head: 'ogre.moss_mane', hands: 'brawler.rope_hook' }), { head: 'ogre.moss_mane' });
  // no account: hello is answered with one econError 'local_only' (after welcome) and no 'account'
  await tick();
  assert.deepEqual(c.inbox.map((m) => m.t), ['econError']);
  const e = c.inbox[0] as Extract<ServerMsg, { t: 'econError' }>;
  assert.equal(e.code, LOCAL_ONLY_CODE);
  assert.equal(e.re, undefined);
  assert.equal(c.accountId, null);
});

test('ECONOMY=trust: every economy message gets econError local_only naming the request, and a match pays nobody', async () => {
  const econ = createTrustEconomy();
  const c = conn();
  econ.onHello(c, 'some-token-from-another-server-123456');
  await tick();
  c.inbox.length = 0;
  const msgs: EconomyClientMsg[] = [
    { t: 'equip', family: 'brawler', loadout: {} },
    { t: 'storeBuy', item: 'brawler.souwester' },
    { t: 'market' },
    { t: 'marketSell', instance: 'itm_abcdefgh', price: { cur: 'pearls', amount: 100 } },
    { t: 'marketBuy', listing: 'lst_abcdefgh' },
    { t: 'marketCancel', listing: 'lst_abcdefgh' },
  ];
  for (const m of msgs) econ.route(c, m);
  assert.deepEqual(c.inbox.map((m) => m.t === 'econError' && `${m.code}:${m.re}`), msgs.map((m) => `local_only:${m.t}`));
  c.inbox.length = 0;
  const row: ScoreRow = { i: c.id, k: 12, d: 1, a: 0, hh: 30, ht: 40, bs: 1, dr: 2, sv: 3, dmg: 900, g: 0 };
  econ.onMatchEnd([{ connId: c.id, won: true, row }]);
  await tick();
  assert.deepEqual(c.inbox, [], 'the trust economy paid or messaged at match end');
  econ.onDisconnect(c);
  econ.close();
});

test('ECONOMY=trust from the environment: no data folder is created, and on / off are unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookwars-trust-'));
  try {
    const dataDir = join(dir, 'data');
    const lines: string[] = [];
    const cfg = loadEconomyConfig({ serverName: 'x' }, { ECONOMY: 'trust', ECONOMY_DATA_DIR: dataDir }, (s) => lines.push(s));
    assert.equal(cfg.mode, 'trust');
    assert.equal(cfg.enabled, false, 'trust has no accounts');
    const econ = createEconomyFromConfig(cfg, { log: (s) => lines.push(s) });
    assert.ok(!(econ instanceof EconomyService));
    assert.equal(existsSync(dataDir), false, 'ECONOMY=trust opened a data folder');
    assert.ok(lines.some((l) => /ECONOMY=trust/.test(l)));
    assert.equal(loadEconomyConfig({ serverName: 'x' }, { ECONOMY: 'TRUST' }, () => {}).mode, 'trust');
    econ.close();
    // the existing modes
    const on = loadEconomyConfig({ serverName: 'x' }, {}, () => {});
    assert.equal(on.mode, 'on');
    assert.equal(on.enabled, true);
    const off = loadEconomyConfig({ serverName: 'x' }, { ECONOMY: 'off' }, () => {});
    assert.equal(off.mode, 'off');
    assert.equal(off.enabled, false);
    const odd = loadEconomyConfig({ serverName: 'x' }, { ECONOMY: 'yes please' }, () => {});
    assert.equal(odd.mode, 'on', 'an unknown value still means on, as before');
    // a literal config without mode (older callers) behaves as before
    const plain = createEconomyFromConfig({ enabled: false, dataDir: null, problems: [] }, { log: () => {} });
    const pc = conn();
    plain.onHello(pc, undefined);
    plain.route(pc, { t: 'market' });
    assert.equal((pc.inbox[0] as Extract<ServerMsg, { t: 'econError' }>).code, 'disabled');
    plain.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ECONOMY=trust end to end: a relayed player wears their locker items, premium stripped, and Store requests are refused', async () => {
  const before = process.env.ECONOMY;
  process.env.ECONOMY = 'trust';
  let econ: ServerEconomy;
  try {
    econ = createServerEconomy(loadConfig(), { log: () => {} });
  } finally {
    if (before === undefined) delete process.env.ECONOMY;
    else process.env.ECONOMY = before;
  }
  const s = await startServer({ relaySecret: SECRET }, econ);
  try {
    const look = { head: 'brawler.tricorn', hands: 'brawler.golden_harpoon', feet: 'brawler.green_wellies' };
    const p = await connected(s.port, relayHeaders(PEER_A), { name: 'Ann', family: 'brawler', loadout: look });
    const err = (await p.until((m) => m.t === 'econError')) as Extract<ServerMsg, { t: 'econError' }>;
    assert.equal(err.code, 'local_only');
    p.send({ t: 'createRoom', name: 'lobby', isPrivate: false, config: { ...DEFAULT_CONFIG, teamSize: 1 } });
    const room = (await p.until((m) => m.t === 'room')) as Extract<ServerMsg, { t: 'room' }>;
    assert.deepEqual(room.room.players[0].loadout, { head: 'brawler.tricorn', feet: 'brawler.green_wellies' });
    p.send({ t: 'storeBuy', item: 'brawler.souwester' });
    const refused = (await p.until((m) => m.t === 'econError' && m.re === 'storeBuy')) as Extract<ServerMsg, { t: 'econError' }>;
    assert.equal(refused.code, 'local_only');
    assert.equal(p.inbox.some((m) => m.t === 'account'), false, 'a trust server sent an account');
    await p.close();
  } finally {
    await s.close();
  }
});
