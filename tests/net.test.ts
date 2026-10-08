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
import { GameSim } from '../shared/sim/sim.ts';
import { moversPresent } from '../shared/sim/river.ts';
import { Predictor } from '../client/net/prediction.ts';
import { Btn, type PlayerInfo, type PlayerInput, type Snapshot } from '../shared/types.ts';

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
    const profile = { name: 'Alice<script>', family: 'brawler', loadout: {} };
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
    c.send({ t: 'hello', v: 999, profile: { name: 'X', family: 'ogre', loadout: {} } });
    const err = await c.wait('error');
    assert.equal(err.code, 'version');
  } finally {
    game.close();
    await new Promise<void>((r) => http.close(() => r()));
  }
});

// ---------------------------------------------------------------------------------------------
// Input queue after a network stall (v2 netcode pass)
// ---------------------------------------------------------------------------------------------

interface StallOpts {
  stallAt: number;
  stallLen: number;
  up: number; // uplink delay in ticks
  down: number; // downlink delay in ticks
  downStall?: boolean; // the downlink stalls too (snapshots of the stall arrive in a burst)
  presses?: Map<number, number>; // client tick -> buttons
  ticks: number;
}

/** One human walking up and down the west bank through a stall, with the real client Predictor. */
function stallRun(o: StallOpts) {
  const players: PlayerInfo[] = [
    { id: 1, name: 'A', team: 0, family: 'ogre', loadout: {}, isBot: false },
    { id: 2, name: 'B', team: 1, family: 'ogre', loadout: {}, isBot: false },
  ];
  const sim = new GameSim({ ...DEFAULT_CONFIG, mapId: 'muckmire', riverMode: 'deep', hazards: 'none', botFill: false }, players, 7);
  while (sim.phase !== 'playing') sim.step();
  const u = sim.unitById.get(1)!;
  const pred = new Predictor(sim.map);
  const up: { at: number; i: PlayerInput }[] = [];
  const down: { at: number; s: Snapshot }[] = [];
  const consumedPresses: number[] = [];
  const depth: number[] = [];
  let seq = 0;
  let delivered = 0;
  let maxCorr = 0;
  const inStall = (k: number) => k >= o.stallAt && k < o.stallAt + o.stallLen;
  for (let k = 0; k < o.ticks; k++) {
    // client: one input per tick, walking 40 ticks one way then 40 back
    const dir = Math.floor(k / 40) % 2 === 0 ? 1 : -1;
    const inp: PlayerInput = { seq: ++seq, mx: 0, mz: dir, ax: u.x + 6, az: u.z, b: o.presses?.get(k) ?? 0 };
    pred.apply(inp);
    up.push({ at: (inStall(k) ? o.stallAt + o.stallLen : k) + o.up, i: inp });
    // server tick
    while (up.length && up[0].at <= k) {
      const x = up.shift()!;
      sim.queueInput(1, x.i);
      delivered = x.i.seq;
    }
    sim.step();
    if (u.input.b) consumedPresses.push(u.input.seq);
    depth.push(delivered - u.ack);
    const s = sim.snapshotFor(1);
    down.push({ at: (o.downStall && inStall(k) ? o.stallAt + o.stallLen : k) + o.down, s });
    // client receives
    while (down.length && down[0].at <= k) {
      const { s: snap } = down.shift()!;
      const me = snap.u.find((x) => x.i === 1)!;
      const bx = pred.body.x;
      const bz = pred.body.z;
      pred.reconcile(me, snap.you!, snap.w, snap.mc, moversPresent(snap.w, sim.config), snap.t);
      if (k > 30) maxCorr = Math.max(maxCorr, Math.hypot(pred.body.x - bx, pred.body.z - bz));
    }
  }
  return { sim, depth, consumedPresses, maxCorr };
}

test('after a stall burst the input queue drains back to just-in-time and the walk never rubber-bands', () => {
  for (const downStall of [false, true]) {
    const r = stallRun({ stallAt: 100, stallLen: 10, up: 2, down: 2, downStall, ticks: 300 });
    const before = Math.max(...r.depth.slice(60, 100));
    assert.equal(before, 0, 'baseline should be just-in-time');
    // the burst lands at tick 112; within 3 ticks the queue is back to the baseline, and stays there
    const after = r.depth.slice(115);
    assert.ok(Math.max(...after) <= before, `queue depth stuck at ${Math.max(...after)} after the stall (downStall ${downStall})`);
    // walking straight through the stall: the held ticks are predicted, so nothing snaps back
    assert.ok(r.maxCorr < 0.02, `prediction corrected by ${r.maxCorr.toFixed(3)} m (downStall ${downStall})`);
  }
});

test('repeated stalls do not ratchet latency up', () => {
  // three stalls of different lengths; the depth must return to zero after each one
  const presses = new Map<number, number>();
  const r1 = stallRun({ stallAt: 80, stallLen: 5, up: 1, down: 1, ticks: 160, presses });
  const r2 = stallRun({ stallAt: 80, stallLen: 12, up: 3, down: 3, ticks: 160, presses });
  for (const r of [r1, r2]) assert.equal(Math.max(...r.depth.slice(100)), 0, 'standing input latency after a stall');
});

test('every button press inside a stall burst is consumed exactly once, with its own aim', () => {
  const presses = new Map<number, number>([[102, Btn.Hook], [106, Btn.Bash], [107, Btn.Grapple]]);
  const r = stallRun({ stallAt: 100, stallLen: 10, up: 2, down: 2, presses, ticks: 200 });
  const want = [103, 107, 108]; // seq = client tick + 1
  assert.deepEqual(r.consumedPresses.filter((s) => want.includes(s)), want, 'a press was dropped, merged or repeated');
  assert.equal(new Set(r.consumedPresses).size, r.consumedPresses.length, 'a press was repeated');
  assert.equal(Math.max(...r.depth.slice(125)), 0, 'presses left the queue backed up');
});

test('debt from inputs that were never sent (hidden tab) is forgiven, so later jitter is not eaten', () => {
  const players: PlayerInfo[] = [{ id: 1, name: 'A', team: 0, family: 'ogre', loadout: {}, isBot: false }];
  const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: true }, players, 3);
  while (sim.phase !== 'playing') sim.step();
  let seq = 0;
  const send = () => sim.queueInput(1, { seq: ++seq, mx: 1, mz: 0, ax: 0, az: 0, b: 0 });
  for (let i = 0; i < 30; i++) {
    send();
    sim.step();
  }
  for (let i = 0; i < 12; i++) sim.step(); // the client sent nothing for 12 ticks (paused, never re-sent)
  for (let i = 0; i < 10; i++) {
    send(); // back to one input per tick
    sim.step();
  }
  const drained0 = sim.inputQueueInfo(1)!.drained;
  send(); // jitter: two arrive together
  send();
  sim.step();
  assert.equal(sim.inputQueueInfo(1)!.debt, 0, 'old debt not forgiven');
  assert.equal(sim.inputQueueInfo(1)!.drained, drained0, 'a fresh input was skipped to pay for ticks that never had one');
});
