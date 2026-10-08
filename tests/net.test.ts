// End-to-end network test: real http + websocket server, two clients, a 2v2 room with bots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { DEFAULT_CONFIG, PROTOCOL_VERSION } from '../shared/constants.ts';
import { GameServer } from '../server/gameServer.ts';
import { loadConfig } from '../server/config.ts';
import type { ServerMsg } from '../shared/protocol.ts';

function client(url: string) {
  const ws = new WebSocket(url);
  const inbox: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as ServerMsg;
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        waiters[i].res(m);
        waiters.splice(i, 1);
      }
    }
  });
  const open = new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  return {
    ws,
    inbox,
    open,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    wait: <T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 4000) =>
      new Promise<Extract<ServerMsg, { t: T }>>((res, rej) => {
        const found = inbox.find((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
        if (found) return res(found as Extract<ServerMsg, { t: T }>);
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), ms);
        waiters.push({ pred: (m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>), res: (m) => { clearTimeout(timer); res(m as Extract<ServerMsg, { t: T }>); } });
      }),
  };
}

test('two clients create, join and play a match over websockets', async () => {
  const http = createServer((_, res) => res.end('ok'));
  const game = new GameServer({ ...loadConfig(), maxPerIp: 10 });
  game.attach(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/ws`;
  try {
    const a = client(url);
    const b = client(url);
    await Promise.all([a.open, b.open]);
    const profile = { name: 'Alice<script>', family: 'brawler', cosmetics: { hat: 1, accent: 2, face: 3 } };
    a.send({ t: 'hello', v: PROTOCOL_VERSION, profile });
    b.send({ t: 'hello', v: PROTOCOL_VERSION, profile: { ...profile, name: 'Bob', family: 'bot' } });
    const wa = await a.wait('welcome');
    await b.wait('welcome');
    a.send({ t: 'createRoom', name: 'Test room', isPrivate: false, config: { ...DEFAULT_CONFIG, teamSize: 2 } });
    const roomA = await a.wait('room');
    assert.equal(roomA.room.players[0].name, 'Alicescript', 'name not sanitised');
    b.send({ t: 'listRooms' });
    const rooms = await b.wait('rooms');
    assert.ok(rooms.rooms.some((r) => r.code === roomA.room.code));
    b.send({ t: 'joinRoom', code: roomA.room.code });
    await a.wait('room', (m) => m.room.players.length === 2);
    a.send({ t: 'start' });
    const sa = await a.wait('start');
    const sb = await b.wait('start');
    assert.equal(sa.m.players.length, 4, '2v2 with bot fill');
    assert.equal(sa.m.you, wa.id);
    assert.notEqual(sb.m.you, -1);
    const snap = await a.wait('s', (m) => !!m.s.you);
    assert.equal(snap.s.you!.id, wa.id);
    // garbage and oversized messages are ignored, not fatal
    a.ws.send('not json');
    a.ws.send(JSON.stringify({ t: 'input', i: { seq: 1, mx: 'x' } }));
    for (let i = 0; i < 30; i++) a.send({ t: 'input', i: { seq: i + 1, mx: 1, mz: 0, ax: 0, az: 0, b: 0 } });
    const later = await a.wait('s', (m) => (m.s.you?.ack ?? 0) >= 10, 6000);
    assert.ok(later.s.you!.ack >= 10, 'server did not process inputs');
    a.ws.close();
    b.ws.close();
  } finally {
    game.close();
    await new Promise<void>((r) => http.close(() => r()));
  }
});

test('version mismatch is rejected', async () => {
  const http = createServer((_, res) => res.end('ok'));
  const game = new GameServer(loadConfig());
  game.attach(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  try {
    const c = client(`ws://127.0.0.1:${port}/ws`);
    await c.open;
    c.send({ t: 'hello', v: 999, profile: { name: 'X', family: 'ogre', cosmetics: { hat: 0, accent: 0, face: 0 } } });
    const err = await c.wait('error');
    assert.equal(err.code, 'version');
  } finally {
    game.close();
    await new Promise<void>((r) => http.close(() => r()));
  }
});
