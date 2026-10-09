// Server hardening regressions (2026-10-08 security and netcode review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { Agent, createServer, request, type IncomingHttpHeaders } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { DEFAULT_CONFIG, PROTOCOL_VERSION, TICK_RATE } from '../shared/constants.ts';
import { GameServer, ipKey, JOIN_MISS_LIMIT, MissCounter } from '../server/gameServer.ts';
import { loadConfig, type ServerConfig } from '../server/config.ts';
import { Room, type RoomClient } from '../server/room.ts';
import { acceptedEncodings, createStaticHandler } from '../server/static.ts';
import { createNullEconomy } from '../server/economy/api.ts';
import { REJOIN_GRACE_MS, SPECTATOR_DELAY_TICKS, type ServerMsg } from '../shared/protocol.ts';
import { GameSim } from '../shared/sim/sim.ts';
import type { PlayerInfo } from '../shared/types.ts';

async function startServer(exclusive = true) {
  const http = createServer((_, res) => res.end('ok'));
  const game = new GameServer({ ...loadConfig(), maxPerIp: 20 });
  game.attach(http, { exclusive });
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

function wsClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: ServerMsg[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as ServerMsg));
  const open = new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  const until = async (pred: (m: ServerMsg) => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = inbox.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('timeout');
  };
  return { ws, inbox, open, until, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

const PROFILE = { name: 'Tester', family: 'brawler', loadout: {} };

test('an upgrade on another path that resets the TCP connection does not crash the server', async () => {
  const s = await startServer(true);
  try {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        const sock = connect(s.port, '127.0.0.1', () => {
          sock.write(`GET /not-ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
          setTimeout(() => {
            sock.resetAndDestroy();
            resolve();
          }, 20);
        });
        sock.on('error', () => resolve());
      });
    }
    const c = wsClient(s.port);
    await c.open;
    c.send({ t: 'hello', v: PROTOCOL_VERSION, profile: PROFILE });
    await c.until((m) => m.t === 'welcome');
    c.ws.close();
  } finally {
    await s.close();
  }
});

test('double-clicking Quick Play on an empty server leaves you in a live, listed room', async () => {
  const s = await startServer();
  try {
    const c = wsClient(s.port);
    await c.open;
    c.send({ t: 'hello', v: PROTOCOL_VERSION, profile: PROFILE });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'quickPlay' });
    c.send({ t: 'quickPlay' });
    await new Promise((r) => setTimeout(r, 200));
    c.send({ t: 'listRooms' });
    const rooms = (await c.until((m) => m.t === 'rooms')) as Extract<ServerMsg, { t: 'rooms' }>;
    const last = [...c.inbox].reverse().find((m) => m.t === 'room') as Extract<ServerMsg, { t: 'room' }> | undefined;
    assert.ok(last, 'no room state received');
    assert.ok(rooms.rooms.some((r) => r.code === last!.room.code), 'the room you are in is not listed (deleted)');
    assert.equal(s.game.stats().rooms, 1);
    c.ws.close();
  } finally {
    await s.close();
  }
});

function fakeClient(id: number, name: string): RoomClient & { msgs: ServerMsg[] } {
  const msgs: ServerMsg[] = [];
  return {
    id,
    profile: { name, family: 'ogre', loadout: {} },
    ping: 0,
    msgs,
    send: (m) => msgs.push(m),
    sendRaw: (d) => msgs.push(JSON.parse(d) as ServerMsg),
  };
}

test('leaving and rejoining a running match takes your own unit back, with its progress', () => {
  const a = fakeClient(1, 'A');
  const b = fakeClient(2, 'B');
  const room = new Room('ABCDE', 'r', false, { ...DEFAULT_CONFIG, teamSize: 2 }, a, () => {});
  room.join(a);
  room.join(b);
  assert.equal(room.start(1), null);
  for (let i = 0; i < TICK_RATE * 5; i++) room.tick();
  const sim = room.sim!;
  sim.unitById.get(2)!.gold = 4321;
  room.leave(2); // a bot takes over B's unit
  room.join(b); // same connection comes back
  const ids = sim.units.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate unit ids');
  const u = sim.unitById.get(2)!;
  assert.equal(u.isBot, false);
  assert.equal(u.gold, 4321, 'progress lost');
  assert.equal(room.members.get(2)!.team, u.team);
});

test('spectator snapshots do not reveal stealthed units or any mines', () => {
  const players: PlayerInfo[] = [0, 1].map((team, i) => ({ id: i + 1, name: `P${i}`, team: team as 0 | 1, family: 'bot', loadout: {}, isBot: false }));
  const sim = new GameSim({ ...DEFAULT_CONFIG, botFill: false }, players, 3);
  sim.step();
  const b = sim.unitById.get(2)!;
  b.puff = 3;
  b.x = 25;
  sim.unitById.get(1)!.x = -25;
  sim.mines.push({ id: 77, owner: 2, team: 1, x: 10, z: 0, armT: 0, dead: false });
  sim.step();
  const spec = sim.snapshotFor(-1);
  assert.ok(!spec.u.some((u) => u.i === 2), 'stealthed unit visible to spectators');
  assert.equal(spec.m.length, 0, 'mines visible to spectators');
});

// ---------------------------------------------------------------------------------------------
// v2 netcode: rejoin tokens, ack flow control, liveness, spectator delay, tick cadence
// ---------------------------------------------------------------------------------------------

async function startWith(over: Partial<ServerConfig>) {
  const http = createServer((_, res) => res.end('ok'));
  const game = new GameServer({ ...loadConfig(), maxPerIp: 50, ...over });
  game.attach(http, { exclusive: true });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  const rooms = (game as unknown as { rooms: Map<string, Room> }).rooms;
  return {
    port,
    game,
    rooms,
    close: async () => {
      game.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wsClientWith(port: number, opts?: WebSocket.ClientOptions) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, opts);
  const inbox: ServerMsg[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as ServerMsg));
  const open = new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  const until = async (pred: (m: ServerMsg) => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = inbox.find(pred);
      if (m) return m;
      await sleep(15);
    }
    throw new Error('timeout');
  };
  return { ws, inbox, open, until, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

type Wc = ReturnType<typeof wsClientWith>;
const snaps = (c: Wc) => c.inbox.filter((m): m is Extract<ServerMsg, { t: 's' }> => m.t === 's');
const lastSnapTick = (c: Wc) => snaps(c).reduce((t, m) => Math.max(t, m.s.t), -1);

async function joined(port: number, name: string, opts?: WebSocket.ClientOptions) {
  const c = wsClientWith(port, opts);
  await c.open;
  c.send({ t: 'hello', v: PROTOCOL_VERSION, profile: { ...PROFILE, name } });
  const w = (await c.until((m) => m.t === 'welcome')) as Extract<ServerMsg, { t: 'welcome' }>;
  return { c, id: w.id };
}

test('a dropped player reclaims the same unit with its rejoin token: gold, upgrades, items and K/D intact', async () => {
  const s = await startWith({});
  try {
    const a = await joined(s.port, 'Ann');
    const b = await joined(s.port, 'Bob');
    a.c.send({ t: 'createRoom', name: 'r', isPrivate: true, config: { ...DEFAULT_CONFIG, teamSize: 2 } });
    const room = (await a.c.until((m) => m.t === 'room')) as Extract<ServerMsg, { t: 'room' }>;
    b.c.send({ t: 'joinRoom', code: room.room.code });
    await a.c.until((m) => m.t === 'room' && m.room.players.length === 2);
    a.c.send({ t: 'start' });
    const sb = (await b.c.until((m) => m.t === 'start')) as Extract<ServerMsg, { t: 'start' }>;
    assert.equal(sb.m.you, b.id, 'a fresh unit id is the connection id');
    assert.equal(sb.m.room, room.room.code);
    const token = sb.m.rejoin!;
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    const r = s.rooms.get(room.room.code)!;
    await sleep(200);
    const u = r.sim!.unitById.get(b.id)!;
    u.gold = 777;
    u.up.range = 2;
    u.items[0] = { id: 'ember', charges: 0 };
    u.stats.k = 3;
    u.stats.d = 1;
    b.c.ws.close(); // the socket drops
    await waitFor(() => !r.members.has(b.id), 5000);
    assert.equal(u.isBot, true, 'a bot should drive the unit while its owner is away');
    // a new socket (new connection id) presents the token
    const b2 = await joined(s.port, 'Bobby');
    assert.notEqual(b2.id, b.id);
    b2.c.send({ t: 'joinRoom', code: room.room.code, rejoin: token });
    const st = (await b2.c.until((m) => m.t === 'start')) as Extract<ServerMsg, { t: 'start' }>;
    assert.equal(st.m.you, b.id, 'did not get the old unit back');
    assert.ok(st.m.rejoin && st.m.rejoin !== token, 'the token must be replaced after use');
    const same = r.sim!.unitById.get(b.id)!;
    assert.equal(same, u, 'the unit was recreated');
    assert.equal(same.isBot, false);
    assert.equal(same.name, 'Bobby');
    assert.ok(same.gold >= 777, 'gold lost');
    assert.equal(same.up.range, 2, 'upgrades lost');
    assert.equal(same.items[0]?.id, 'ember', 'items lost');
    assert.equal(same.stats.k, 3, 'kills lost');
    assert.equal(same.stats.d, 1, 'deaths lost');
    const ids = r.sim!.units.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate unit ids');
    assert.equal(r.sim!.scoreboard().filter((row) => row.i === b.id).length, 1, 'scoreboard row lost or doubled');
    // the new client numbers inputs from 1 again; they must be accepted
    for (let i = 1; i <= 20; i++) {
      b2.c.send({ t: 'input', i: { seq: i, mx: 1, mz: 0, ax: 0, az: 0, b: 0 }, a: lastSnapTick(b2.c) });
      await sleep(10);
    }
    const acked = (await b2.c.until((m) => m.t === 's' && (m.s.you?.ack ?? 0) >= 10)) as Extract<ServerMsg, { t: 's' }>;
    assert.equal(acked.s.you!.id, b.id);
    // the old token is spent: a third socket presenting it does not get the unit
    const c3 = await joined(s.port, 'Mallory');
    c3.c.send({ t: 'joinRoom', code: room.room.code, rejoin: token });
    const st3 = (await c3.c.until((m) => m.t === 'start')) as Extract<ServerMsg, { t: 'start' }>;
    assert.notEqual(st3.m.you, b.id, 'a used token worked twice');
    assert.equal(r.sim!.unitById.get(b.id)!.name, 'Bobby');
    for (const x of [a.c, b2.c, c3.c]) x.ws.close();
  } finally {
    await s.close();
  }
});

test('ack flow control: a client that stops acking gets only probes, then resumes with a full snapshot', async () => {
  const s = await startWith({});
  try {
    const a = await joined(s.port, 'Ann');
    a.c.send({ t: 'createRoom', name: 'r', isPrivate: true, config: { ...DEFAULT_CONFIG, teamSize: 1 } });
    await a.c.until((m) => m.t === 'room');
    a.c.send({ t: 'start' });
    await a.c.until((m) => m.t === 'start');
    let seq = 0;
    const input = (ack: number) => a.c.send({ t: 'input', i: { seq: ++seq, mx: 0, mz: 0, ax: 0, az: 0, b: 0 }, a: ack });
    // acking every snapshot: the full 30 Hz stream
    for (let i = 0; i < 20; i++) {
      input(lastSnapTick(a.c));
      await sleep(33);
    }
    const code = [...s.rooms.keys()][0];
    const sim = () => s.rooms.get(code)!.sim!;
    const n0 = snaps(a.c).length;
    const tick0 = sim().tick;
    for (let i = 0; i < 30; i++) {
      input(lastSnapTick(a.c));
      await sleep(33);
    }
    // relative to the ticks the server actually ran (a loaded machine runs fewer)
    const live = (snaps(a.c).length - n0) / Math.max(1, sim().tick - tick0);
    assert.ok(live >= 0.5, `only ${(live * 100).toFixed(0)}% of frames delivered while acking`);
    // the client is still alive (inputs keep coming) but its acks stop advancing: a backlog the server cannot see
    const frozen = lastSnapTick(a.c);
    const n1 = snaps(a.c).length;
    const skipped1 = s.rooms.get(code)!.flowInfo(a.id)!.skipped;
    // The allowance in flight is LAG_TICKS plus the measured base round trip, which a loaded machine
    // inflates (up to 30 more ticks). Stay frozen well past it, counted in ticks the server really ran.
    const tickF = sim().tick;
    const tF = Date.now();
    let limit = s.rooms.get(code)!.flowInfo(a.id)!.limit;
    while (sim().tick - tickF < limit + 45 && Date.now() - tF < 20_000) {
      input(frozen);
      await sleep(33);
      limit = Math.max(limit, s.rooms.get(code)!.flowInfo(a.id)!.limit);
    }
    const ran = sim().tick - tickF;
    const stalled = snaps(a.c).length - n1;
    // at most the allowance (plus the frame in hand), then one probe every 30 ticks
    const bound = limit + 2 + Math.ceil(ran / 30);
    assert.ok(stalled <= bound, `${stalled} frames in ${ran} ticks to a client that stopped acking (allowance ${limit}, bound ${bound})`);
    const info = s.rooms.get(code)!.flowInfo(a.id)!;
    assert.ok(info.pauses >= 1, 'the stream never paused');
    assert.ok(info.skipped - skipped1 >= ran - bound, `skipped ${info.skipped - skipped1} of ${ran} frames`);
    // acks catch up: the stream resumes at once, and the first frame carries the scoreboard
    const n2 = snaps(a.c).length;
    input(lastSnapTick(a.c));
    for (let i = 0; i < 6; i++) {
      await sleep(33);
      input(lastSnapTick(a.c));
    }
    await a.c.until(() => snaps(a.c).length > n2 + 3, 5000);
    const resumed = snaps(a.c)[n2];
    assert.ok(resumed.s.sb, 'the first frame after a pause must carry the scoreboard');
    a.c.ws.close();
  } finally {
    await s.close();
  }
});

test('a client whose pongs are stuck behind a backlog stays connected while it keeps talking', async () => {
  const s = await startWith({ heartbeatMs: 400 });
  try {
    const quiet = await joined(s.port, 'Quiet', { autoPong: false });
    const talker = await joined(s.port, 'Talker', { autoPong: false });
    let closed = false;
    talker.c.ws.on('close', () => (closed = true));
    let quietClosed = false;
    quiet.c.ws.on('close', () => (quietClosed = true));
    let pings = 0;
    talker.c.ws.on('ping', () => pings++); // one per heartbeat the talker survived
    // talk until the silent socket is gone and the talker has seen at least five heartbeats
    // (a loaded machine runs fewer heartbeats in the same time; count them instead of the clock)
    const t0 = Date.now();
    for (let i = 0; (!quietClosed || pings < 5) && Date.now() - t0 < 15_000; i++) {
      talker.c.send({ t: 'ping', c: i });
      await sleep(20);
    }
    assert.equal(closed, false, 'a live client was killed by the heartbeat');
    assert.equal(quietClosed, true, 'a silent socket that never pongs must still be closed');
    assert.ok(pings >= 5, `only ${pings} heartbeats in 15 s`);
    talker.c.ws.close();
  } finally {
    await s.close();
  }
});

test('spectators get snapshots and events 3 s late, and the result only when their feed reaches it', () => {
  const a = fakeClient(1, 'A');
  const spec = fakeClient(2, 'S');
  const room = new Room('SPECT', 'r', false, { ...DEFAULT_CONFIG, teamSize: 1 }, a, () => {});
  room.join(a);
  room.join(spec);
  room.setTeam(2, -1);
  assert.equal(room.start(1), null);
  const start = spec.msgs.find((m) => m.t === 'start') as Extract<ServerMsg, { t: 'start' }>;
  assert.equal(start.m.you, -1);
  assert.equal(start.m.delay, SPECTATOR_DELAY_TICKS);
  assert.equal(start.m.rejoin, undefined, 'spectators get no rejoin token');
  const sim = room.sim!;
  let phaseLive = -1;
  for (let i = 0; i < TICK_RATE * 8; i++) {
    room.tick();
    if (phaseLive < 0 && sim.events.some((e) => e.e === 'phase')) phaseLive = sim.tick;
    const last = spec.msgs[spec.msgs.length - 1];
    if (last.t === 's') assert.equal(last.s.t, sim.tick - SPECTATOR_DELAY_TICKS, 'spectator frame is not 3 s behind');
  }
  const specSnaps = spec.msgs.filter((m): m is Extract<ServerMsg, { t: 's' }> => m.t === 's');
  assert.equal(specSnaps.length, TICK_RATE * 8 - SPECTATOR_DELAY_TICKS, 'spectators must get nothing for the first 3 s');
  assert.equal(specSnaps[0].s.t, 1);
  assert.ok(phaseLive > 0);
  const seen = specSnaps.find((m) => m.s.ev.some((e) => e.e === 'phase'));
  assert.equal(seen?.s.t, phaseLive, 'events must arrive with their own (delayed) frame');
  // the result: players at once, spectators 3 s later
  sim.phase = 'ended';
  sim.winner = 0;
  room.tick();
  assert.ok(a.msgs.some((m) => m.t === 'end'), 'player did not get the result');
  assert.ok(!spec.msgs.some((m) => m.t === 'end'), 'spectator saw the result before the final frames');
  for (let i = 0; i < SPECTATOR_DELAY_TICKS; i++) room.tick();
  assert.ok(spec.msgs.some((m) => m.t === 'end'), 'spectator never got the result');
});

test('rejoin edge cases: grace window, full rooms, silent owners, match results and no bot fill', () => {
  const mk = () => {
    const a = fakeClient(1, 'A');
    const b = fakeClient(2, 'B');
    const room = new Room('EDGES', 'r', false, { ...DEFAULT_CONFIG, teamSize: 2 }, a, () => {});
    room.join(a);
    room.join(b);
    assert.equal(room.start(1), null);
    for (let i = 0; i < 10; i++) room.tick();
    return { a, b, room, token: room.rejoinToken(2)! };
  };
  const seatOf = (room: Room, unit: number) => (room as unknown as { seats: Map<number, { leftAt: number }> }).seats.get(unit)!;
  // 1. inside the grace window a new connection takes the unit; the economy pays that connection
  {
    const { room, token } = mk();
    const u = room.sim!.unitById.get(2)!;
    u.gold = 2000;
    room.leave(2);
    assert.ok(room.canRejoin(token));
    for (let i = 0; i < TICK_RATE * 8; i++) room.tick(); // the stand-in bot plays (and would shop) for 8 s
    room.join(fakeClient(9, 'B2'), token);
    assert.equal(room.unitFor(9), 2);
    assert.equal(u.isBot, false);
    assert.ok(u.gold >= 2000, `the stand-in bot spent the owner's gold (${u.gold} left)`);
    assert.deepEqual(u.up, { damage: 0, range: 0, speed: 0, width: 0 }, 'the stand-in bot bought upgrades');
    let results: { connId: number; row: { i: number } }[] = [];
    room.onMatchEnd = (r) => (results = r);
    room.sim!.phase = 'ended';
    room.tick();
    const mine = results.find((r) => r.row.i === 2);
    assert.equal(mine?.connId, 9, 'match rewards must go to the connection driving the unit');
  }
  // 2. after the grace window the token is dead and the unit stays a bot
  {
    const { room, token } = mk();
    room.leave(2);
    seatOf(room, 2).leftAt = Date.now() - 91_000;
    assert.equal(room.canRejoin(token), false);
    room.join(fakeClient(9, 'B2'), token);
    assert.notEqual(room.unitFor(9), 2);
  }
  // 3. a full room still lets a valid token in (the server checks canRejoin before isFull)
  {
    const { room, token } = mk();
    room.leave(2);
    for (let i = 0; i < 10; i++) room.join(fakeClient(100 + i, `S${i}`));
    assert.ok(room.isFull());
    assert.ok(room.canRejoin(token));
  }
  // 4. a real network drop: the old socket is still open on the server (half-open, its last input a
  //    moment ago) when the player is already back on a new one. The token wins; the old one is evicted.
  {
    const { room, token } = mk();
    const evicted: number[] = [];
    room.onEvict = (id) => evicted.push(id);
    const u = room.sim!.unitById.get(2)!;
    u.gold = 1234;
    room.input(2, { seq: 1, mx: 0, mz: 0, ax: 0, az: 0, b: 0 });
    for (let i = 0; i < 30; i++) room.tick();
    assert.equal(room.canRejoin(token), true);
    const b2 = fakeClient(9, 'B2');
    room.join(b2, token);
    assert.deepEqual(evicted, [2]);
    assert.equal(room.unitFor(9), 2, 'a fast reconnect fell through to a fresh unit');
    assert.equal(room.members.has(2), false);
    assert.ok(u.gold >= 1234);
    const st = b2.msgs.find((m) => m.t === 'start') as Extract<ServerMsg, { t: 'start' }>;
    assert.ok(st.m.rejoin && st.m.rejoin !== token, 'the client must get a fresh token to keep');
    // the evicted socket closing later changes nothing
    room.leave(2);
    assert.equal(u.isBot, false);
    assert.equal(room.unitFor(9), 2);
  }
  // 5. without bot fill a stand-in bot still holds the unit through the grace window, then goes
  {
    const a = fakeClient(1, 'A');
    const b = fakeClient(2, 'B');
    const room = new Room('NOBOT', 'r', false, { ...DEFAULT_CONFIG, teamSize: 1, botFill: false }, a, () => {});
    room.join(a);
    room.join(b);
    assert.equal(room.start(1), null);
    room.leave(2);
    assert.equal(room.sim!.unitById.get(2)?.isBot, true, 'no stand-in while the owner may return');
    seatOf(room, 2).leftAt = Date.now() - 91_000;
    for (let i = 0; i < 31; i++) room.tick();
    assert.equal(room.sim!.unitById.has(2), false, 'stand-in bot outlived the grace window');
  }
});

test('the tick loop keeps an even 33 ms cadence (no 15.6 ms timer steps on Windows)', async (tc) => {
  const period = 1000 / TICK_RATE;
  /** One 2.2 s measurement of the real loop driving one match. */
  const measure = async () => {
    const times: number[] = [];
    const P = Room.prototype as unknown as { tick: () => void };
    const orig = P.tick;
    P.tick = function (this: Room) {
      if (this.code === 'CADNC') times.push(performance.now());
      return orig.call(this);
    };
    const s = await startWith({});
    try {
      const host = fakeClient(1, 'H');
      const r = new Room('CADNC', 'c', true, { ...DEFAULT_CONFIG }, host, () => {});
      r.join(host);
      assert.equal(r.start(1), null); // the precise timer only runs while a match does
      s.rooms.set('CADNC', r);
      await sleep(2200);
    } finally {
      await s.close();
      P.tick = orig;
    }
    const t = times.slice(10); // the first ticks after start-up may be catching up
    const iv: number[] = [];
    for (let i = 1; i < t.length; i++) iv.push(t[i] - t[i - 1]);
    iv.sort((x, y) => x - y);
    const median = iv[Math.floor(iv.length / 2)];
    const mean = (t[t.length - 1] - t[0]) / (t.length - 1);
    const hist = new Map<number, number>();
    for (const x of iv) hist.set(Math.round(x), (hist.get(Math.round(x)) ?? 0) + 1);
    const histText = [...hist.entries()].sort((p, q) => p[0] - q[0]).map(([k, v]) => `${k}:${v}`).join(' ');
    // A machine so loaded that this process is descheduled for whole ticks cannot measure a timer.
    // Timer quantisation alone never makes a gap of two periods (the old loop topped out near 48 ms).
    const starved = iv.filter((x) => x > 2 * period).length / iv.length > 0.1;
    // The median is what the old loop got wrong on Windows (31.1 ms: steps of 31 and 47), on every
    // run. The mean catches drift.
    const ok = Math.abs(median - period) < 1 && Math.abs(mean - period) < 1.5;
    return { ok, starved, text: `median ${median.toFixed(2)} ms, mean ${mean.toFixed(2)} ms: ${histText}` };
  };
  // A busy machine (other test files run in parallel) can spoil one measurement; a broken loop spoils
  // all three, so up to three tries tell the two apart.
  const runs: { ok: boolean; starved: boolean; text: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await measure();
    runs.push(r);
    if (r.ok) return;
  }
  if (runs.every((r) => r.starved)) {
    tc.skip(`process starved on every try (machine overloaded): ${runs.map((r) => r.text).join(' | ')}`);
    return;
  }
  assert.fail(`uneven tick cadence on all 3 tries: ${runs.map((r) => r.text).join(' | ')}`);
});

// ---------------------------------------------------------------------------------------------
// v2 review fixes (2026-10-09): rejoin when the last human drops (25/37), tokenless return (15),
// per-IP room-code guessing (13), compressed static files (26), heartbeat ordering after a stall
// ---------------------------------------------------------------------------------------------

type StartMsg = Extract<ServerMsg, { t: 'start' }>;
type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
type ErrorMsg = Extract<ServerMsg, { t: 'error' }>;

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(10);
  }
}

/** Run the seat sweep now (it runs every 30 ticks, at most once a second of wall time). */
function sweepNow(room: Room): void {
  (room as unknown as { sweepAt: number }).sweepAt = 0;
  for (let i = 0; i < 30; i++) room.tick();
}

const seatLeftAt = (room: Room, unit: number, at: number) => {
  (room as unknown as { seats: Map<number, { leftAt: number }> }).seats.get(unit)!.leftAt = at;
};

test('the last human dropping keeps the match for the grace window: lone vs bots, everyone at once, then it closes', () => {
  // 1. one human against bots: the socket closes, the match keeps running with a stand-in bot
  {
    let closed = 0;
    const a = fakeClient(1, 'A');
    const room = new Room('LONEA', 'r', true, { ...DEFAULT_CONFIG, teamSize: 2 }, a, () => closed++);
    room.join(a);
    assert.equal(room.start(1), null);
    for (let i = 0; i < 30; i++) room.tick();
    const token = room.rejoinToken(1)!;
    const u = room.sim!.unitById.get(1)!;
    u.gold = 1500;
    room.leave(1, true);
    assert.equal(closed, 0, 'the match was closed while its only player can still come back');
    for (let i = 0; i < TICK_RATE * 3; i++) room.tick(); // the bots keep playing
    const a2 = fakeClient(7, 'A2');
    room.join(a2, token);
    assert.equal(room.unitFor(7), 1, 'did not get the unit back');
    assert.equal(u.isBot, false);
    assert.ok(u.gold >= 1500, 'gold lost');
    assert.equal(room.hostId, 7, 'the first player back must be host');
    // a deliberate Leave still closes the room at once
    room.leave(7);
    assert.equal(closed, 1, 'a deliberate Leave from a one-human match must close the room');
  }
  // 2. everyone drops at once (a home-upload blip): both come back, play on, and can start the next match
  {
    let closed = 0;
    const a = fakeClient(1, 'A');
    const b = fakeClient(2, 'B');
    const room = new Room('BLIPA', 'r', true, { ...DEFAULT_CONFIG, teamSize: 2 }, a, () => closed++);
    room.join(a);
    room.join(b);
    assert.equal(room.start(1), null);
    for (let i = 0; i < 30; i++) room.tick();
    const ta = room.rejoinToken(1)!;
    const tb = room.rejoinToken(2)!;
    room.leave(1, true);
    room.leave(2, true);
    assert.equal(closed, 0, 'everyone dropping at once deleted the match');
    for (let i = 0; i < TICK_RATE * 2; i++) room.tick();
    const b2 = fakeClient(12, 'B2');
    const a2 = fakeClient(11, 'A2');
    room.join(b2, tb);
    room.join(a2, ta);
    assert.equal(room.unitFor(12), 2);
    assert.equal(room.unitFor(11), 1);
    assert.equal(room.hostId, 12, 'the first player back must be host');
    room.sim!.phase = 'ended';
    room.sim!.winner = 0;
    for (let i = 0; i < TICK_RATE * 15; i++) room.tick(); // the end screen, then back to the lobby
    assert.equal(room.phase, 'lobby');
    assert.equal(room.start(12), null, 'nobody can start the next match');
    assert.equal(closed, 0);
  }
  // 3. nobody comes back: the room closes once the grace window has run out
  {
    let closed = 0;
    const a = fakeClient(1, 'A');
    const room = new Room('GONEA', 'r', true, { ...DEFAULT_CONFIG, teamSize: 2 }, a, () => closed++);
    room.join(a);
    assert.equal(room.start(1), null);
    room.leave(1, true);
    sweepNow(room);
    assert.equal(closed, 0, 'closed inside the grace window');
    seatLeftAt(room, 1, Date.now() - REJOIN_GRACE_MS - 1000);
    sweepNow(room);
    assert.equal(closed, 1, 'the empty room outlived the grace window');
    sweepNow(room);
    assert.equal(closed, 1, 'onEmpty must fire once');
  }
  // 4. an empty room whose match ends is closed too (it must not sit in the lobby for 30 minutes)
  {
    let closed = 0;
    const a = fakeClient(1, 'A');
    const room = new Room('ENDSA', 'r', true, { ...DEFAULT_CONFIG, teamSize: 2 }, a, () => closed++);
    room.join(a);
    assert.equal(room.start(1), null);
    room.leave(1, true);
    room.sim!.phase = 'ended';
    room.sim!.winner = 1;
    for (let i = 0; i < TICK_RATE * 15 && closed === 0; i++) room.tick();
    assert.equal(closed, 1, 'an empty room whose match ended was kept');
  }
  // 5. one player dropped, the other then leaves on purpose: the room waits for the dropped one
  {
    let closed = 0;
    const a = fakeClient(1, 'A');
    const b = fakeClient(2, 'B');
    const room = new Room('MIXDA', 'r', true, { ...DEFAULT_CONFIG, teamSize: 2 }, a, () => closed++);
    room.join(a);
    room.join(b);
    assert.equal(room.start(1), null);
    const tb = room.rejoinToken(2)!;
    room.leave(2, true);
    room.leave(1);
    assert.equal(closed, 0, 'a deliberate Leave closed a room a dropped player can still come back to');
    room.join(fakeClient(9, 'B2'), tb);
    assert.equal(room.unitFor(9), 2);
  }
  // 6. an empty lobby closes at once, dropped or not
  {
    let closed = 0;
    const a = fakeClient(1, 'A');
    const room = new Room('LOBBA', 'r', true, { ...DEFAULT_CONFIG, teamSize: 2 }, a, () => closed++);
    room.join(a);
    room.leave(1, true);
    assert.equal(closed, 1);
  }
});

test('coming back without a token needs the same live connection and the grace window', () => {
  const a = fakeClient(1, 'A');
  const b = fakeClient(2, 'B');
  const room = new Room('RETRN', 'r', false, { ...DEFAULT_CONFIG, teamSize: 3 }, a, () => {});
  room.join(a);
  room.join(b);
  assert.equal(room.start(1), null);
  for (let i = 0; i < 30; i++) room.tick();
  const u = room.sim!.unitById.get(2)!;
  u.gold = 2500;
  u.stats.k = 7;
  room.leave(2); // B leaves on purpose; the socket stays open
  // a later connection that was handed the same numeric id, without a token
  const thief = fakeClient(2, 'Thief');
  room.join(thief);
  assert.notEqual(room.unitFor(2), 2, 'a different connection with a reused id took the unit');
  assert.equal(u.isBot, true);
  room.leave(2);
  // the same socket coming back inside the grace window gets its own unit back
  room.join(b);
  assert.equal(room.unitFor(2), 2, 'the same socket could not come back to its unit');
  assert.ok(u.gold >= 2500);
  // ...but not after the grace window
  room.leave(2);
  seatLeftAt(room, 2, Date.now() - REJOIN_GRACE_MS - 1000);
  room.join(b);
  assert.notEqual(room.unitFor(2), 2, 'tokenless return worked after the grace window');
  // a dropped socket (closed) never comes back without its token
  const c = fakeClient(3, 'C');
  room.leave(2);
  room.join(c);
  const unitC = room.unitFor(3);
  assert.ok(unitC >= 0);
  room.leave(3, true);
  room.join(c);
  assert.notEqual(room.unitFor(3), unitC, 'a closed connection came back without its token');
});

test('online: the last human dropping keeps the match and the rejoin gets the same unit (lone vs bots, and everyone at once)', async () => {
  const s = await startWith({ maxRoomsPerIp: 2 });
  try {
    const cfg = { ...DEFAULT_CONFIG, teamSize: 2, botFill: true };
    // 1. one human against bots
    {
      const a = await joined(s.port, 'Ann');
      a.c.send({ t: 'createRoom', name: 'r', isPrivate: true, config: cfg });
      const code = ((await a.c.until((m) => m.t === 'room')) as RoomMsg).room.code;
      a.c.send({ t: 'start' });
      const st = (await a.c.until((m) => m.t === 'start')) as StartMsg;
      await sleep(100);
      a.c.ws.close(); // the server sees the close (tab crash, network switch, heartbeat kill)
      await waitFor(() => !s.rooms.get(code)?.members.has(a.id));
      assert.ok(s.rooms.has(code), 'the match was deleted while its player can still come back');
      await sleep(300); // the stand-in bot plays on
      const a2 = await joined(s.port, 'Ann');
      a2.c.send({ t: 'joinRoom', code, rejoin: st.m.rejoin });
      const back = await a2.c.until((m) => m.t === 'start' || m.t === 'error', 5000);
      assert.equal(back.t, 'start', `rejoin failed: ${JSON.stringify(back)}`);
      assert.equal((back as StartMsg).m.you, st.m.you, 'did not get the same unit back');
      assert.equal(s.rooms.get(code)!.hostId, a2.id, 'the player who came back must be host');
      a2.c.send({ t: 'leaveRoom' });
      await a2.c.until((m) => m.t === 'leftRoom');
      assert.equal(s.rooms.has(code), false, 'a deliberate Leave must still close the room');
      a2.c.ws.close();
    }
    // 2. everyone drops at once
    {
      const a = await joined(s.port, 'Ann');
      const b = await joined(s.port, 'Bob');
      a.c.send({ t: 'createRoom', name: 'r', isPrivate: true, config: cfg });
      const code = ((await a.c.until((m) => m.t === 'room')) as RoomMsg).room.code;
      b.c.send({ t: 'joinRoom', code });
      await a.c.until((m) => m.t === 'room' && m.room.players.length === 2);
      a.c.send({ t: 'start' });
      const sa = (await a.c.until((m) => m.t === 'start')) as StartMsg;
      const sb = (await b.c.until((m) => m.t === 'start')) as StartMsg;
      await sleep(100);
      a.c.ws.close();
      b.c.ws.close();
      await waitFor(() => (s.rooms.get(code)?.members.size ?? 0) === 0);
      assert.ok(s.rooms.has(code), 'everyone dropping at once deleted the match');
      const b2 = await joined(s.port, 'Bob');
      const a2 = await joined(s.port, 'Ann');
      b2.c.send({ t: 'joinRoom', code, rejoin: sb.m.rejoin });
      a2.c.send({ t: 'joinRoom', code, rejoin: sa.m.rejoin });
      const rb = (await b2.c.until((m) => m.t === 'start' || m.t === 'error', 5000)) as StartMsg;
      const ra = (await a2.c.until((m) => m.t === 'start' || m.t === 'error', 5000)) as StartMsg;
      assert.equal(rb.t, 'start', `rejoin failed: ${JSON.stringify(rb)}`);
      assert.equal(ra.t, 'start', `rejoin failed: ${JSON.stringify(ra)}`);
      assert.equal(rb.m.you, sb.m.you);
      assert.equal(ra.m.you, sa.m.you);
      for (const x of [a2.c, b2.c]) {
        x.send({ t: 'leaveRoom' });
        await x.until((m) => m.t === 'leftRoom');
        x.ws.close();
      }
      assert.equal(s.rooms.has(code), false, 'the last deliberate Leave must close the room');
    }
    // 3. create, start and Leave three times from one IP: no room is held, the per-IP quota never trips
    for (let i = 0; i < 3; i++) {
      const l = await joined(s.port, `Lee${i}`);
      l.c.send({ t: 'createRoom', name: `r${i}`, isPrivate: false, config: cfg });
      const got = await l.c.until((m) => m.t === 'room' || m.t === 'error');
      assert.equal(got.t, 'room', `create #${i + 1}: ${JSON.stringify(got)}`);
      l.c.send({ t: 'start' });
      await l.c.until((m) => m.t === 'start');
      l.c.send({ t: 'leaveRoom' });
      await l.c.until((m) => m.t === 'leftRoom');
      l.c.ws.close();
    }
    await waitFor(() => s.game.stats().clients === 0);
    await waitFor(() => s.rooms.size === 0);
  } finally {
    await s.close();
  }
});

test('room codes cannot be brute-forced by reconnecting: failed joins are counted per IP, behind a trusted proxy too', async () => {
  const s = await startWith({ trustedProxies: ['127.0.0.1'] });
  const from = (ip: string): WebSocket.ClientOptions => ({ headers: { 'x-forwarded-for': ip } });
  const NAT = '203.0.113.5'; // the guesser and Ann share this address
  try {
    const cfg = { ...DEFAULT_CONFIG, teamSize: 2, botFill: true };
    const ann = await joined(s.port, 'Ann', from(NAT));
    ann.c.send({ t: 'createRoom', name: 'friends', isPrivate: true, config: cfg });
    const code = ((await ann.c.until((m) => m.t === 'room')) as RoomMsg).room.code;
    const friend = await joined(s.port, 'Friend', from('198.51.100.7'));
    friend.c.send({ t: 'joinRoom', code });
    await ann.c.until((m) => m.t === 'room' && m.room.players.length === 2);
    ann.c.send({ t: 'start' });
    const st = (await ann.c.until((m) => m.t === 'start')) as StartMsg;
    ann.c.ws.close(); // Ann drops; she will come back with her token
    const r = s.rooms.get(code)!;
    await waitFor(() => !r.members.has(ann.id));
    // the guesser opens a fresh socket for every few guesses, so per-socket strikes never add up
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let n = 0;
    const wrongCode = () => {
      let c = '';
      do {
        c = '';
        for (let k = 0, x = ++n * 7919; k < 5; k++, x = Math.floor(x / 24)) c += letters[x % 24];
      } while (s.rooms.has(c));
      return c;
    };
    for (let sock = 0; sock < 8; sock++) {
      const g = await joined(s.port, 'Guess', from(NAT));
      for (let k = 0; k < 3; k++) {
        g.c.send({ t: 'joinRoom', code: wrongCode() });
        await waitFor(() => g.c.inbox.filter((x) => x.t === 'error').length === k + 1);
      }
      g.c.ws.close();
    }
    // 24 misses from that IP: now even the right code is refused, on a brand new socket
    const g = await joined(s.port, 'Guess', from(NAT));
    g.c.send({ t: 'joinRoom', code });
    const res = await g.c.until((m) => m.t === 'error' || m.t === 'room' || m.t === 'start');
    assert.equal(res.t, 'error', 'a guessing IP got into a private room');
    assert.equal((res as ErrorMsg).code, 'join_limit');
    assert.equal(r.members.has(g.id), false);
    // another address is not affected
    const other = await joined(s.port, 'Other', from('192.0.2.44'));
    other.c.send({ t: 'joinRoom', code });
    await other.c.until((m) => m.t === 'start');
    // and a player on the blocked address who holds a real rejoin token still gets back in
    const ann2 = await joined(s.port, 'Ann', from(NAT));
    ann2.c.send({ t: 'joinRoom', code, rejoin: st.m.rejoin });
    const back = await ann2.c.until((m) => m.t === 'start' || m.t === 'error');
    assert.equal(back.t, 'start', `a valid rejoin was refused: ${JSON.stringify(back)}`);
    assert.equal((back as StartMsg).m.you, st.m.you);
    for (const x of [friend.c, g.c, other.c, ann2.c]) x.ws.close();
  } finally {
    await s.close();
  }
});

test('a stall right after a heartbeat does not kill a client whose messages were waiting to be read', async () => {
  const HB = 300;
  const s = await startWith({ heartbeatMs: HB });
  try {
    const t = wsClientWith(s.port, { autoPong: false });
    let closed = false;
    t.ws.on('close', () => (closed = true));
    let stalled = false;
    t.ws.on('ping', () => {
      if (stalled) return;
      stalled = true;
      t.send({ t: 'ping', c: 1 }); // proof of life, on the wire before the stall
      const end = performance.now() + HB + 100;
      while (performance.now() < end) {
        // the whole process stalls (GC, a slow save) past the next heartbeat
      }
    });
    await t.open;
    t.send({ t: 'hello', v: PROTOCOL_VERSION, profile: { ...PROFILE, name: 'Talker' } });
    await waitFor(() => stalled, 3000);
    // keep talking through two more heartbeats
    for (let i = 0; i < 12; i++) {
      t.send({ t: 'ping', c: 2 + i });
      await sleep(50);
    }
    assert.equal(closed, false, 'the heartbeat killed a client whose message was queued during the stall');
    t.ws.close();
  } finally {
    await s.close();
  }
});

test('the per-IP miss counter blocks at the limit, expires, stays bounded, and counts IPv6 by /64', () => {
  const m = new MissCounter(JOIN_MISS_LIMIT, 60_000, 60_000, 100);
  const t = 1_000_000;
  for (let i = 0; i < JOIN_MISS_LIMIT - 1; i++) m.miss('1.2.3.4', t + i);
  assert.equal(m.blocked('1.2.3.4', t + 100), false, 'blocked before the limit');
  m.miss('1.2.3.4', t + 100);
  assert.equal(m.blocked('1.2.3.4', t + 101), true, 'not blocked at the limit');
  assert.equal(m.blocked('1.2.3.5', t + 101), false, 'another address was blocked');
  assert.equal(m.blocked('1.2.3.4', t + 100 + 60_001), false, 'the block never ends');
  // misses spread out over more than the window never add up to a block
  for (let i = 0; i < JOIN_MISS_LIMIT * 3; i++) m.miss('5.6.7.8', t + i * 4_000);
  assert.equal(m.blocked('5.6.7.8', t + JOIN_MISS_LIMIT * 3 * 4_000), false);
  // bounded: a flood of addresses never grows the map past its cap
  for (let i = 0; i < 1000; i++) m.miss(`10.0.${i >> 8}.${i & 255}`, t + 200);
  assert.ok(m.size <= 100, `map grew to ${m.size}`);
  m.sweep(t + 10 * 60_000);
  assert.equal(m.size, 0, 'stale entries were not swept');
  // IPv6: one /64 is one address for the limit; IPv4 is unchanged
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), ipKey('2001:db8:1:2:bbbb:cccc:dddd:2'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
  assert.equal(ipKey('2001:DB8:0:0::1'), ipKey('2001:db8::5'));
  assert.equal(ipKey('203.0.113.5'), '203.0.113.5');
});

test('static files go out brotli or gzip encoded, with Vary, ETags and the right caching; a rebuild is picked up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hw-static-'));
  const srv = createServer();
  try {
    mkdirSync(join(dir, 'assets'));
    const js = Buffer.from(Array.from({ length: 6000 }, (_, i) => `export const hook${i} = ${i} * 2; // reel it in\n`).join(''));
    writeFileSync(join(dir, 'assets', 'index-AbC123.js'), js);
    const html = `<!doctype html><html><head><title>Hook Wars</title></head><body>${'<div class="slot">hook</div>'.repeat(200)}<script type="module" src="/assets/index-AbC123.js"></script></body></html>`;
    writeFileSync(join(dir, 'index.html'), html);
    writeFileSync(join(dir, 'assets', 'font-XyZ.woff2'), randomBytes(4096));
    const handler = createStaticHandler(dir);
    await handler.ready;
    srv.on('request', handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
      new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const rq = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
          const parts: Buffer[] = [];
          res.on('data', (d: Buffer) => parts.push(d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
        });
        rq.on('error', reject);
        rq.end();
      });
    const BROWSER = { 'accept-encoding': 'gzip, deflate, br, zstd' };
    // the bundle: brotli for a browser, decoded byte for byte, long-cached
    const a = await get('/assets/index-AbC123.js', BROWSER);
    assert.equal(a.status, 200);
    assert.equal(a.headers['content-encoding'], 'br', 'the bundle went out uncompressed');
    assert.match(String(a.headers.vary), /Accept-Encoding/i);
    assert.equal(Number(a.headers['content-length']), a.body.length);
    assert.ok(a.body.length < js.length / 3, `brotli ${a.body.length} of ${js.length} bytes`);
    assert.deepEqual(brotliDecompressSync(a.body), js);
    assert.equal(a.headers['cache-control'], 'public, max-age=31536000, immutable');
    // gzip-only clients, and q-values (br refused)
    for (const ae of ['gzip', 'br;q=0, gzip', 'gzip;q=1, br;q=0.5']) {
      const g = await get('/assets/index-AbC123.js', { 'accept-encoding': ae });
      assert.equal(g.headers['content-encoding'], 'gzip', ae);
      assert.deepEqual(gunzipSync(g.body), js);
    }
    // no Accept-Encoding: as is, with a length and still Vary
    const id = await get('/assets/index-AbC123.js');
    assert.equal(id.headers['content-encoding'], undefined);
    assert.equal(Number(id.headers['content-length']), js.length);
    assert.match(String(id.headers.vary), /Accept-Encoding/i);
    assert.deepEqual(id.body, js);
    // HEAD: the same headers, no body
    const h = await get('/assets/index-AbC123.js', BROWSER, 'HEAD');
    assert.equal(h.headers['content-encoding'], 'br');
    assert.equal(h.headers['content-length'], a.headers['content-length']);
    assert.equal(h.body.length, 0);
    // index.html and an unknown client route: compressed, revalidated every load, 304 on a match
    for (const path of ['/', '/lobby/ABCDE']) {
      const r = await get(path, BROWSER);
      assert.equal(r.headers['content-encoding'], 'br', path);
      assert.equal(r.headers['cache-control'], 'no-cache', path);
      assert.equal(brotliDecompressSync(r.body).toString(), html, path);
      const etag = String(r.headers.etag);
      assert.ok(etag.length > 4, 'no ETag');
      const again = await get(path, { ...BROWSER, 'if-none-match': etag });
      assert.equal(again.status, 304, `${path} not revalidated`);
      assert.equal(again.body.length, 0);
    }
    // already compressed files are not compressed again
    const f = await get('/assets/font-XyZ.woff2', BROWSER);
    assert.equal(f.headers['content-encoding'], undefined);
    assert.equal(f.body.length, 4096);
    // a hashed asset that does not exist is a 404, never index.html served as a script
    const miss = await get('/assets/index-Old999.js', BROWSER);
    assert.equal(miss.status, 404);
    assert.equal(miss.headers['cache-control'], 'no-store');
    // a rebuild while running: never the stale compressed page, the new one is compressed soon after
    const html2 = html.replace('index-AbC123.js', 'index-New456.js');
    writeFileSync(join(dir, 'index.html'), html2);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'index.html'), later, later);
    const fresh = await get('/', BROWSER);
    const freshBody = fresh.headers['content-encoding'] === 'br' ? brotliDecompressSync(fresh.body) : fresh.body;
    assert.equal(freshBody.toString(), html2, 'a stale compressed index.html was served after a rebuild');
    let enc: string | undefined;
    for (let i = 0; i < 100 && enc !== 'br'; i++) {
      const r = await get('/', BROWSER);
      enc = r.headers['content-encoding'];
      if (enc === 'br') assert.equal(brotliDecompressSync(r.body).toString(), html2);
      else await sleep(30);
    }
    assert.equal(enc, 'br', 'the rebuilt index.html was never compressed');
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file rewritten between the stat and the read never breaks its Content-Length (a rebuild while serving)', async () => {
  // The uncompressed path promises Content-Length from a stat taken before the read. A rebuild that
  // rewrites index.html in between must neither send extra bytes (they poison the keep-alive
  // connection: the next response fails to parse) nor leave the client waiting for missing ones.
  const dir = mkdtempSync(join(tmpdir(), 'hw-race-'));
  const page = `<!doctype html><title>Hook Wars</title>${'a'.repeat(500)}`; // under 1 KB: always streamed as is
  const target = join(dir, 'index.html');
  writeFileSync(target, page);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'b.txt'), 'b'.repeat(300));
  const handler = createStaticHandler(dir);
  await handler.ready;
  // rewrite the file right after the handler's stat of it, as a concurrent build would
  let rewrite: ((file: string) => void) | null = null;
  const realStat = fs.statSync;
  (fs as unknown as { statSync: unknown }).statSync = function (this: unknown, ...args: Parameters<typeof fs.statSync>) {
    const st = (realStat as (...a: unknown[]) => unknown).apply(this, args);
    if (rewrite && String(args[0]) === target) {
      const r = rewrite;
      rewrite = null;
      r(target);
    }
    return st;
  } as typeof fs.statSync;
  syncBuiltinESMExports(); // static.ts imports statSync by name
  const srv = createServer(handler);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    type Got = { ok: true; status: number; cl: number; body: Buffer } | { ok: false; why: string };
    const get = (path: string) =>
      new Promise<Got>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, why: 'hung' }), 3000);
        const done = (g: Got) => {
          clearTimeout(timer);
          resolve(g);
        };
        const rq = request({ host: '127.0.0.1', port, path, agent }, (res) => {
          const parts: Buffer[] = [];
          res.on('data', (d: Buffer) => parts.push(d));
          res.on('end', () => done({ ok: true, status: res.statusCode ?? 0, cl: Number(res.headers['content-length']), body: Buffer.concat(parts) }));
          res.on('error', (e) => done({ ok: false, why: e.message }));
          res.on('aborted', () => done({ ok: false, why: 'aborted' }));
        });
        rq.on('error', (e) => done({ ok: false, why: e.message }));
        rq.end();
      });
    // 1. the file grows: exactly Content-Length bytes go out, and the connection stays usable
    rewrite = (f) => appendFileSync(f, '<!-- rebuilt: a longer page -->'.repeat(20));
    const grown = await get('/');
    assert.ok(grown.ok, `the response broke: ${!grown.ok && grown.why}`);
    assert.equal(grown.body.length, grown.cl);
    const next = await get('/assets/b.txt');
    assert.ok(next.ok, `the next response on the same connection failed: ${!next.ok && next.why}`);
    assert.equal(next.body.toString(), 'b'.repeat(300));
    // 2. the file shrinks: the response is cut off at once, never left hanging
    rewrite = (f) => writeFileSync(f, '<!doctype html>');
    const shrunk = await get('/');
    assert.ok(!(shrunk.ok === false && shrunk.why === 'hung'), 'the client was left waiting for bytes that never come');
    if (shrunk.ok) assert.equal(shrunk.body.length, shrunk.cl, 'a short body under a longer Content-Length');
  } finally {
    (fs as unknown as { statSync: unknown }).statSync = realStat;
    syncBuiltinESMExports();
    agent.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Accept-Encoding parsing honours q-values and prefers brotli on a tie', () => {
  assert.deepEqual(acceptedEncodings('gzip, deflate, br'), ['br', 'gzip']);
  assert.deepEqual(acceptedEncodings('br;q=0, gzip'), ['gzip']);
  assert.deepEqual(acceptedEncodings('gzip;q=1, br ; q=0.5'), ['gzip', 'br']);
  assert.deepEqual(acceptedEncodings('identity'), []);
  assert.deepEqual(acceptedEncodings(undefined), []);
  assert.deepEqual(acceptedEncodings('*'), ['br', 'gzip']);
  assert.deepEqual(acceptedEncodings('*;q=0, gzip'), ['gzip']);
});


test('a match starting on a connection stops its market pushes (finding 14, the game server side)', async () => {
  const unwatched: number[] = [];
  const economy = { ...createNullEconomy(), unwatchMarket: (c: { id: number }) => void unwatched.push(c.id) };
  const http = createServer((_, res) => res.end('ok'));
  const game = new GameServer({ ...loadConfig(), maxPerIp: 50 }, economy);
  game.attach(http, { exclusive: true });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  try {
    const a = await joined(port, 'Ann');
    a.c.send({ t: 'createRoom', name: 'r', isPrivate: true, config: { ...DEFAULT_CONFIG, teamSize: 1 } });
    await a.c.until((m) => m.t === 'room');
    assert.deepEqual(unwatched, [], 'unwatched before any match');
    a.c.send({ t: 'start' });
    await a.c.until((m) => m.t === 'start');
    assert.deepEqual(unwatched, [a.id]);
    a.c.ws.close();
  } finally {
    game.close();
    await new Promise<void>((r) => http.close(() => r()));
  }
});
