// Server hardening regressions (2026-10-08 security and netcode review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { DEFAULT_CONFIG, PROTOCOL_VERSION, TICK_RATE } from '../shared/constants.ts';
import { GameServer } from '../server/gameServer.ts';
import { loadConfig } from '../server/config.ts';
import { Room, type RoomClient } from '../server/room.ts';
import type { ServerMsg } from '../shared/protocol.ts';
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

const PROFILE = { name: 'Tester', family: 'brawler', cosmetics: { hat: 0, accent: 0, face: 0 } };

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
    profile: { name, family: 'ogre', cosmetics: { hat: 0, accent: 0, face: 0 } },
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
  const players: PlayerInfo[] = [0, 1].map((team, i) => ({ id: i + 1, name: `P${i}`, team: team as 0 | 1, family: 'bot', cosmetics: { hat: 0, accent: 0, face: 0 }, isBot: false }));
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
