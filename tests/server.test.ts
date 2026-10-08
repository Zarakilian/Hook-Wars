// Server hardening regressions (2026-10-08 security and netcode review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { DEFAULT_CONFIG, PROTOCOL_VERSION, TICK_RATE } from '../shared/constants.ts';
import { GameServer } from '../server/gameServer.ts';
import { loadConfig, type ServerConfig } from '../server/config.ts';
import { Room, type RoomClient } from '../server/room.ts';
import { SPECTATOR_DELAY_TICKS, type ServerMsg } from '../shared/protocol.ts';
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
    for (let i = 0; i < 50 && r.members.has(b.id); i++) await sleep(10);
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
    for (let i = 0; i < 45; i++) {
      input(frozen);
      await sleep(33);
    }
    const stalled = snaps(a.c).length - n1;
    assert.ok(stalled <= 16, `${stalled} frames sent in 1.5 s to a client 1.5 s behind`);
    const info = s.rooms.get(code)!.flowInfo(a.id)!;
    assert.ok(info.pauses >= 1, 'the stream never paused');
    assert.ok(info.skipped > 20, `skipped ${info.skipped}`);
    // acks catch up: the stream resumes at once, and the first frame carries the scoreboard
    const n2 = snaps(a.c).length;
    input(lastSnapTick(a.c));
    for (let i = 0; i < 6; i++) {
      await sleep(33);
      input(lastSnapTick(a.c));
    }
    await a.c.until(() => snaps(a.c).length > n2 + 3, 1500);
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
    for (let i = 0; i < 100; i++) {
      talker.c.send({ t: 'ping', c: i });
      await sleep(20);
    }
    assert.equal(closed, false, 'a live client was killed by the heartbeat');
    assert.equal(quietClosed, true, 'a silent socket that never pongs must still be closed');
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
  const period = 1000 / TICK_RATE;
  const median = iv[Math.floor(iv.length / 2)];
  const mean = (t[t.length - 1] - t[0]) / (t.length - 1);
  const hist = new Map<number, number>();
  for (const x of iv) hist.set(Math.round(x), (hist.get(Math.round(x)) ?? 0) + 1);
  const histText = [...hist.entries()].sort((p, q) => p[0] - q[0]).map(([k, v]) => `${k}:${v}`).join(' ');
  // A machine so loaded that this process is descheduled for whole ticks cannot measure a timer.
  // Timer quantisation alone never makes a gap of two periods (the old loop topped out near 48 ms).
  const gaps = iv.filter((x) => x > 2 * period).length / iv.length;
  if (gaps > 0.1) {
    tc.skip(`process starved for ${(gaps * 100).toFixed(0)}% of ticks (machine overloaded): ${histText}`);
    return;
  }
  // The median is what the old loop got wrong on Windows (31.1 ms: steps of 31 and 47). It also holds
  // up when a loaded machine deschedules the whole process now and then, which no loop can prevent.
  assert.ok(Math.abs(median - period) < 1, `median interval ${median.toFixed(2)} ms: ${histText}`);
  assert.ok(Math.abs(mean - period) < 1.5, `mean interval ${mean.toFixed(2)} ms (drift): ${histText}`);
});
