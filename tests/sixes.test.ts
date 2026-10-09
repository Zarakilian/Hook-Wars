// 6v6: the sixth spawn point on every map, spawn slots that never stack, the suggested kills to win,
// and the server with twelve seats (in-process websocket clients). 5v5 stays the default and the
// Quick Play size. Run: node --test tests/sixes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { DEFAULT_CONFIG, MAX_TEAM_SIZE, PROTOCOL_VERSION, suggestedKills, UNIT_RADIUS } from '../shared/constants.ts';
import { channelDepthAt, clearOf, platformAt, waterDepthAt } from '../shared/maps/helpers.ts';
import { getMap } from '../shared/maps/index.ts';
import { parseConfig, type ServerMsg } from '../shared/protocol.ts';
import { GameSim } from '../shared/sim/sim.ts';
import { MAP_IDS, UnitState, type MatchConfig, type PlayerInfo, type Team } from '../shared/types.ts';
import { GameServer } from '../server/gameServer.ts';
import { loadConfig } from '../server/config.ts';
import type { Room } from '../server/room.ts';

type P = { x: number; z: number };
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.z - b.z);

function minPair(list: readonly P[]): number {
  let m = Infinity;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) m = Math.min(m, dist(list[i], list[j]));
  return m;
}

// ------------------------------------------------------------------------------------------------
// The sixth spawn point

test('every map has MAX_TEAM_SIZE spawn points a team: on dry open ground in the home fountain, mirrored, spaced', () => {
  assert.equal(MAX_TEAM_SIZE, 6);
  for (const id of MAP_IDS) {
    const map = getMap(id);
    for (const team of [0, 1] as const) {
      const sp = map.spawns[team];
      const f = map.fountains[team];
      assert.equal(sp.length, MAX_TEAM_SIZE, `${id} team ${team} has ${sp.length} spawn points`);
      for (const p of sp) {
        const at = `${id} spawn (${p.x}, ${p.z})`;
        // dry walkable land with a margin, and real ground (not a deck over the water)
        assert.ok(channelDepthAt(map, p.x, p.z) < -3, `${at} is ${(-channelDepthAt(map, p.x, p.z)).toFixed(2)} m from the water`);
        assert.ok(waterDepthAt(map, p.x, p.z) < -3, `${at} is over water`);
        assert.equal(platformAt(map, p.x, p.z), null, `${at} is on a deck`);
        // no obstacle within a body radius plus half a metre, no hazard slot under or next to it
        assert.ok(clearOf(map.obstacles, p.x, p.z, UNIT_RADIUS + 0.5), `${at} is inside or against an obstacle`);
        for (const h of map.hazardSlots) assert.ok(dist(p, h) > h.r + UNIT_RADIUS + 1, `${at} is on a hazard slot`);
        // inside the home fountain (its heal ring)
        assert.ok(dist(p, f) <= f.r, `${at} is ${dist(p, f).toFixed(2)} m from the fountain centre (r ${f.r})`);
        assert.ok(Math.abs(p.x) < map.w / 2 - 2 && Math.abs(p.z) < map.d / 2 - 2, `${at} is at the map edge`);
      }
      // the sixth: wholly inside the ring, and at least as far from the other five as they are from each other
      assert.ok(dist(sp[5], f) <= f.r - UNIT_RADIUS, `${id}: the sixth spawn pokes out of the fountain ring`);
      const five = sp.slice(0, 5);
      const nearest = Math.min(...five.map((p) => dist(p, sp[5])));
      assert.ok(nearest >= minPair(five) - 1e-9, `${id}: the sixth spawn is ${nearest.toFixed(2)} m from the nearest, the others ${minPair(five).toFixed(2)} m apart`);
      assert.ok(minPair(sp) >= 2.5, `${id}: spawn points ${minPair(sp).toFixed(2)} m apart`);
    }
    // the fairness rule: team 1's point i is team 0's point i mirrored through the map centre
    for (let i = 0; i < MAX_TEAM_SIZE; i++) {
      const [p, q] = [map.spawns[0][i], map.spawns[1][i]];
      assert.ok(p.x + q.x === 0 && p.z + q.z === 0, `${id} spawn ${i} (${p.x}, ${p.z}) / (${q.x}, ${q.z}) not mirrored`);
    }
  }
});

function squad(perTeam: number): PlayerInfo[] {
  const out: PlayerInfo[] = [];
  for (let i = 0; i < perTeam * 2; i++) {
    out.push({ id: i + 1, name: `Bot ${i + 1}`, team: (i % 2) as Team, family: (['brawler', 'ogre', 'bot'] as const)[(i >> 1) % 3], loadout: {}, isBot: true, botDifficulty: 'normal' });
  }
  return out;
}

test('6v6: every Lunker of a team starts and respawns on its own spawn point, and a freed slot is reused', () => {
  for (const [mi, mapId] of MAP_IDS.entries()) {
    const config: MatchConfig = { ...DEFAULT_CONFIG, mapId, teamSize: MAX_TEAM_SIZE, killsToWin: 999 };
    const sim = new GameSim(config, squad(MAX_TEAM_SIZE), 70 + mi);
    for (const team of [0, 1] as const) {
      const mine = sim.units.filter((u) => u.team === team);
      assert.deepEqual(mine.map((u) => u.spawnIndex).sort(), [0, 1, 2, 3, 4, 5], `${mapId} spawn slots`);
      for (const u of mine) assert.deepEqual({ x: u.x, z: u.z }, sim.map.spawns[team][u.spawnIndex], `${mapId} unit ${u.id} not on its spawn point`);
      assert.ok(minPair(mine) >= 2.5, `${mapId}: two of team ${team} start ${minPair(mine).toFixed(2)} m apart`);
    }
    // everybody dies at once (a hazard death scores, no killer); they come back on their own points
    for (let i = 0; i < 30 * 5; i++) sim.step(); // countdown
    for (const u of sim.units) {
      u.spawnProt = 0;
      sim.damage(u, u.maxHp * 10, -1, 'hazard');
    }
    assert.ok(sim.units.every((u) => u.state === UnitState.Dead), `${mapId}: not everybody died`);
    let back = 0;
    for (let i = 0; i < 30 * 12 && back < sim.units.length; i++) {
      sim.step();
      for (const e of sim.events) {
        if (e.e !== 'respawn') continue;
        const u = sim.unitById.get(e.u)!;
        back++;
        assert.ok(dist(u, sim.map.spawns[u.team][u.spawnIndex]) < 0.6, `${mapId}: unit ${u.id} respawned away from its point`);
      }
    }
    assert.equal(back, sim.units.length, `${mapId}: only ${back} respawned`);
    // a player leaves and another joins: the new one takes the free slot, not somebody else's
    const gone = sim.units.find((u) => u.team === 1 && u.spawnIndex === 3)!;
    sim.removePlayer(gone.id);
    const fresh = sim.addPlayer({ id: 99, name: 'New', team: 1, family: 'ogre', loadout: {}, isBot: false });
    assert.equal(fresh.spawnIndex, 3);
    assert.deepEqual({ x: fresh.x, z: fresh.z }, sim.map.spawns[1][3]);
  }
});

test('spawnPoint never stacks two of a team, even past the map points (a solo or debug match bigger than 6v6)', () => {
  for (const mapId of MAP_IDS) {
    const sim = new GameSim({ ...DEFAULT_CONFIG, mapId }, [], 1);
    for (const team of [0, 1] as const) {
      const pts = Array.from({ length: MAX_TEAM_SIZE * 3 }, (_, i) => sim.spawnPoint(team, i));
      assert.deepEqual(pts.slice(0, MAX_TEAM_SIZE), sim.map.spawns[team], 'the first points are the map points, in order');
      assert.ok(minPair(pts) >= 0.7, `${mapId}: spawn slots ${minPair(pts).toFixed(2)} m apart`);
      const f = sim.map.fountains[team];
      for (const p of pts) {
        assert.ok(channelDepthAt(sim.map, p.x, p.z) < -3 && clearOf(sim.map.obstacles, p.x, p.z, UNIT_RADIUS), `${mapId}: extra slot (${p.x}, ${p.z}) not on open ground`);
        assert.ok(dist(p, f) < f.r, `${mapId}: extra slot outside the fountain`);
      }
    }
    // and a sim with 8 a side places all 8 apart
    const big = new GameSim({ ...DEFAULT_CONFIG, mapId, teamSize: 8 }, squad(8), 3);
    for (const team of [0, 1] as const) assert.ok(minPair(big.units.filter((u) => u.team === team)) >= 0.7, `${mapId}: 8 a side stack`);
  }
});

// ------------------------------------------------------------------------------------------------
// Suggested kills to win

test('suggestedKills: 30 at 5v5, 35 at 6v6, always a target the server accepts, growing with the team', () => {
  assert.equal(suggestedKills(5), 30);
  assert.equal(suggestedKills(DEFAULT_CONFIG.teamSize), DEFAULT_CONFIG.killsToWin, 'the default match keeps its default target');
  assert.equal(suggestedKills(6), 35);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(suggestedKills), [5, 10, 15, 20, 30, 35]);
  let prev = 0;
  for (let n = 1; n <= MAX_TEAM_SIZE; n++) {
    const k = suggestedKills(n);
    assert.ok(Number.isInteger(k) && k >= prev, `${n}v${n}: ${k}`);
    assert.ok(parseConfig({ ...DEFAULT_CONFIG, teamSize: n, killsToWin: k }), `${n}v${n}: ${k} kills is not a valid config`);
    prev = k;
  }
  // nonsense in, a valid target out
  assert.equal(suggestedKills(0), 5);
  assert.equal(suggestedKills(-3), 5);
  assert.equal(suggestedKills(99), suggestedKills(MAX_TEAM_SIZE));
  assert.equal(suggestedKills(5.4), 30);
  assert.equal(suggestedKills(Number.NaN), 30);
});

// ------------------------------------------------------------------------------------------------
// The server at 6v6, with real websocket clients

async function startServer() {
  const http = createServer((_, res) => res.end('ok'));
  // 13 sockets from one address in these tests (the default allows 6 per IP)
  const game = new GameServer({ ...loadConfig(), maxPerIp: 50 });
  game.attach(http, { exclusive: true });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  const rooms = (game as unknown as { rooms: Map<string, Room> }).rooms;
  return {
    port,
    rooms,
    close: async () => {
      game.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(10);
  }
}

type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
type StartMsg = Extract<ServerMsg, { t: 'start' }>;
type RoomsMsg = Extract<ServerMsg, { t: 'rooms' }>;

async function client(port: number, name: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: ServerMsg[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as ServerMsg));
  await new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  const until = async <T extends ServerMsg>(pred: (m: ServerMsg) => boolean, ms = 4000): Promise<T> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = inbox.find(pred);
      if (m) return m as T;
      await sleep(15);
    }
    throw new Error(`${name}: timeout`);
  };
  /** the newest message matching pred, if any */
  const last = <T extends ServerMsg>(pred: (m: ServerMsg) => boolean): T | undefined => [...inbox].reverse().find(pred) as T | undefined;
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  send({ t: 'hello', v: PROTOCOL_VERSION, profile: { name, family: 'brawler', loadout: {} } });
  const w = await until<Extract<ServerMsg, { t: 'welcome' }>>((m) => m.t === 'welcome');
  return { ws, inbox, until, last, send, id: w.id, name };
}
type Client = Awaited<ReturnType<typeof client>>;

const SIX: MatchConfig = { ...DEFAULT_CONFIG, teamSize: 6, killsToWin: suggestedKills(6), botFill: false };

/** A host and `others` joiners in one room (public), everybody seated by the server's team balance. */
async function sixRoom(port: number, others: number, config: MatchConfig = SIX) {
  const host = await client(port, 'Host');
  host.send({ t: 'createRoom', name: 'Six a side', isPrivate: false, config });
  const code = (await host.until<RoomMsg>((m) => m.t === 'room')).room.code;
  const all: Client[] = [host];
  for (let i = 0; i < others; i++) {
    const c = await client(port, `P${i + 1}`);
    c.send({ t: 'joinRoom', code });
    await c.until((m) => m.t === 'room');
    all.push(c);
  }
  await host.until((m) => m.t === 'room' && m.room.players.length === others + 1);
  return { host, all, code };
}

test('6v6 room: twelve humans get twelve seats, six a side; a thirteenth watches', async () => {
  const s = await startServer();
  const opened: Client[] = [];
  try {
    const { host, all, code } = await sixRoom(s.port, 11);
    opened.push(...all);
    const lobby = host.last<RoomMsg>((m) => m.t === 'room' && m.room.players.length === 12)!;
    assert.equal(lobby.room.config.teamSize, 6);
    assert.equal(lobby.room.players.filter((p) => p.team === 0).length, 6);
    assert.equal(lobby.room.players.filter((p) => p.team === 1).length, 6);
    const extra = await client(s.port, 'Late');
    opened.push(extra);
    extra.send({ t: 'joinRoom', code });
    await host.until((m) => m.t === 'room' && m.room.players.length === 13);
    const full = host.last<RoomMsg>((m) => m.t === 'room')!;
    assert.equal(full.room.players.find((p) => p.id === extra.id)?.team, -1, 'the 13th should be a spectator');
    // a full team refuses one more
    extra.send({ t: 'setTeam', team: 0 });
    await sleep(150);
    assert.equal(s.rooms.get(code)!.members.get(extra.id)?.team, -1, 'a seventh joined a full team');

    host.send({ t: 'start' });
    const starts = await Promise.all(all.map((c) => c.until<StartMsg>((m) => m.t === 'start')));
    const spec = await extra.until<StartMsg>((m) => m.t === 'start');
    assert.equal(spec.m.you, -1, 'the spectator got a unit');
    const yous = starts.map((st) => st.m.you);
    assert.deepEqual(yous, all.map((c) => c.id), 'every player drives its own unit');
    for (const st of starts) {
      assert.equal(st.m.players.length, 12);
      assert.equal(st.m.players.filter((p) => p.isBot).length, 0, 'no bots without bot fill');
      assert.ok(st.m.rejoin, 'every seat gets a rejoin token');
    }
    const sim = s.rooms.get(code)!.sim!;
    for (const team of [0, 1] as const) {
      const mine = sim.units.filter((u) => u.team === team);
      assert.equal(mine.length, 6);
      assert.ok(minPair(mine) >= 2.5, 'two players of a team spawned on one point');
    }
    // every seated client is streamed its own team's view
    for (const c of all) await c.until((m) => m.t === 's' && m.s.you?.id === c.id);
  } finally {
    for (const c of opened) c.ws.close();
    await s.close();
  }
});

test('6v6 room with bot fill: one human and eleven bots, six a side; humans joining mid-match take over bots', async () => {
  const s = await startServer();
  const opened: Client[] = [];
  try {
    const { host, all, code } = await sixRoom(s.port, 0, { ...SIX, botFill: true });
    opened.push(...all);
    host.send({ t: 'start' });
    const st = await host.until<StartMsg>((m) => m.t === 'start');
    assert.equal(st.m.you, host.id);
    assert.equal(st.m.players.length, 12);
    assert.equal(st.m.players.filter((p) => !p.isBot).length, 1);
    assert.equal(st.m.players.filter((p) => p.isBot).length, 11);
    for (const team of [0, 1] as const) assert.equal(st.m.players.filter((p) => p.team === team).length, 6);
    assert.equal(new Set(st.m.players.map((p) => p.name)).size, 12, 'bot names repeat');
    const room = s.rooms.get(code)!;
    assert.equal(room.sim!.units.length, 12);
    // two more humans join the running match: each takes over a bot (lighter team first), still six a side
    for (const [i, name] of ['Late1', 'Late2'].entries()) {
      const late = await client(s.port, name);
      opened.push(late);
      late.send({ t: 'joinRoom', code });
      const ls = await late.until<StartMsg>((m) => m.t === 'start');
      assert.ok(ls.m.you >= 0, `${name} should take over a bot`);
      assert.equal(room.sim!.unitById.get(ls.m.you)!.team, i === 0 ? 1 : 0, `${name} on the wrong team`);
      await waitFor(() => room.sim!.units.filter((u) => !u.isBot).length === 2 + i);
      assert.equal(room.sim!.units.length, 12);
      for (const team of [0, 1] as const) assert.equal(room.sim!.units.filter((u) => u.team === team).length, 6);
    }
  } finally {
    for (const c of opened) c.ws.close();
    await s.close();
  }
});

test('6v6 rejoin: a dropped player is covered by a stand-in bot, the seat stays theirs, the token takes it back', async () => {
  const s = await startServer();
  const opened: Client[] = [];
  try {
    const { host, all, code } = await sixRoom(s.port, 11);
    opened.push(...all);
    host.send({ t: 'start' });
    const starts = await Promise.all(all.map((c) => c.until<StartMsg>((m) => m.t === 'start')));
    const room = s.rooms.get(code)!;
    const sim = room.sim!;
    const victim = all[7];
    const token = starts[7].m.rejoin!;
    const unit = sim.unitById.get(victim.id)!;
    unit.gold = 1234;
    victim.ws.close(); // the socket drops
    await waitFor(() => !room.members.has(victim.id));
    assert.equal(unit.isBot, true, 'a stand-in bot should drive the unit');
    assert.equal(sim.units.length, 12);
    // somebody new arrives: both teams are full (the dropped seat is held), so they watch
    const newcomer = await client(s.port, 'Newcomer');
    opened.push(newcomer);
    newcomer.send({ t: 'joinRoom', code });
    const ns = await newcomer.until<StartMsg>((m) => m.t === 'start');
    assert.equal(ns.m.you, -1, 'the held seat was given away');
    assert.equal(sim.units.length, 12);
    // the owner comes back on a new socket with the token: same unit, gold kept
    const back = await client(s.port, 'Back');
    opened.push(back);
    back.send({ t: 'joinRoom', code, rejoin: token });
    const bs = await back.until<StartMsg>((m) => m.t === 'start');
    assert.equal(bs.m.you, victim.id, 'did not get the old unit back');
    assert.equal(sim.unitById.get(victim.id), unit);
    assert.equal(unit.isBot, false);
    assert.ok(unit.gold >= 1234, 'gold lost while away');
    for (const team of [0, 1] as const) assert.equal(sim.units.filter((u) => u.team === team).length, 6);
  } finally {
    for (const c of opened) c.ws.close();
    await s.close();
  }
});

test('6v6 with bot fill: a newcomer takes over a bot, never the held unit of a dropped player, who still gets it back', async () => {
  const s = await startServer();
  const opened: Client[] = [];
  try {
    const { host, all, code } = await sixRoom(s.port, 3, { ...SIX, botFill: true });
    opened.push(...all);
    host.send({ t: 'start' });
    const starts = await Promise.all(all.map((c) => c.until<StartMsg>((m) => m.t === 'start')));
    const room = s.rooms.get(code)!;
    const sim = room.sim!;
    assert.equal(sim.units.length, 12);
    for (const team of [0, 1] as const) {
      assert.equal(sim.units.filter((u) => u.team === team).length, 6);
      assert.equal(sim.units.filter((u) => u.team === team && !u.isBot).length, 2, 'two humans a side');
    }
    // a team 0 player drops: a stand-in bot drives the unit, the seat is held
    const vi = all.findIndex((c) => sim.unitById.get(c.id)?.team === 0);
    const victim = all[vi];
    const token = starts[vi].m.rejoin!;
    const unit = sim.unitById.get(victim.id)!;
    unit.gold = 777;
    victim.ws.close();
    await waitFor(() => !room.members.has(victim.id));
    assert.equal(unit.isBot, true);
    // a newcomer: team 0 still counts the held seat (2 a side), so the newcomer lands on team 0 and
    // takes over one of its four bots, not the dropped player's unit
    const newcomer = await client(s.port, 'Newcomer');
    opened.push(newcomer);
    newcomer.send({ t: 'joinRoom', code });
    const ns = await newcomer.until<StartMsg>((m) => m.t === 'start');
    assert.ok(ns.m.you >= 0, 'the newcomer should take over a bot');
    assert.notEqual(ns.m.you, victim.id, 'the newcomer was handed the held unit');
    assert.equal(sim.unitById.get(ns.m.you)!.team, 0);
    assert.equal(sim.unitById.get(victim.id), unit, 'the held unit is gone');
    assert.equal(unit.isBot, true);
    for (const team of [0, 1] as const) assert.equal(sim.units.filter((u) => u.team === team).length, 6);
    // the token brings the dropped player back to the same unit and gold, still six a side
    const back = await client(s.port, 'Back');
    opened.push(back);
    back.send({ t: 'joinRoom', code, rejoin: token });
    const bs = await back.until<StartMsg>((m) => m.t === 'start');
    assert.equal(bs.m.you, victim.id);
    assert.equal(unit.isBot, false);
    assert.ok(unit.gold >= 777);
    for (const team of [0, 1] as const) {
      assert.equal(sim.units.filter((u) => u.team === team).length, 6);
      assert.equal(sim.units.filter((u) => u.team === team && !u.isBot).length, team === 0 ? 3 : 2);
    }
  } finally {
    for (const c of opened) c.ws.close();
    await s.close();
  }
});

test('lobby: switching a full 6v6 room to 5v5 sends the sixth of each team to spectate', async () => {
  const s = await startServer();
  const opened: Client[] = [];
  try {
    const { host, all, code } = await sixRoom(s.port, 11);
    opened.push(...all);
    const room = s.rooms.get(code)!;
    const teamOf = (c: Client) => room.members.get(c.id)!.team;
    const before = all.map(teamOf);
    host.send({ t: 'setConfig', config: { ...SIX, teamSize: 5, killsToWin: suggestedKills(5) } });
    await waitFor(() => room.config.teamSize === 5);
    const after = all.map(teamOf);
    for (const team of [0, 1] as const) {
      assert.equal(after.filter((t) => t === team).length, 5, `team ${team} after the switch`);
      // the last to join that team is the one moved out; everybody else keeps their side
      const was = all.filter((_, i) => before[i] === team);
      assert.equal(teamOf(was[was.length - 1]), -1);
      for (const c of was.slice(0, -1)) assert.equal(teamOf(c), team);
    }
    assert.equal(after.filter((t) => t === -1).length, 2);
    // back to 6v6: the spectators stay spectators until they pick a side, and then they fit again
    host.send({ t: 'setConfig', config: SIX });
    await waitFor(() => room.config.teamSize === 6);
    assert.equal(all.map(teamOf).filter((t) => t === -1).length, 2);
    for (const [i, c] of all.entries()) if (after[i] === -1) c.send({ t: 'setTeam', team: before[i] });
    await waitFor(() => all.every((c, i) => teamOf(c) === before[i]));
    host.send({ t: 'start' });
    const starts = await Promise.all(all.map((c) => c.until<StartMsg>((m) => m.t === 'start')));
    assert.ok(starts.every((st, i) => st.m.you === all[i].id), 'all twelve drive their own unit');
  } finally {
    for (const c of opened) c.ws.close();
    await s.close();
  }
});

test('room list: a 6v6 room shows 12 slots; Quick Play on an empty server still makes a 5v5', async () => {
  const s = await startServer();
  const opened: Client[] = [];
  try {
    const { host, code } = await sixRoom(s.port, 2);
    opened.push(host);
    const viewer = await client(s.port, 'Viewer');
    opened.push(viewer);
    viewer.send({ t: 'listRooms' });
    const list = await viewer.until<RoomsMsg>((m) => m.t === 'rooms');
    const row = list.rooms.find((r) => r.code === code);
    assert.ok(row, 'the 6v6 room is not listed');
    assert.equal(row.slots, 12);
    assert.equal(row.humans, 3);
    assert.equal(row.phase, 'lobby');
    // a separate server with no rooms: Quick Play creates the default 5v5
    const q = await startServer();
    try {
      const c = await client(q.port, 'Quick');
      opened.push(c);
      c.send({ t: 'quickPlay' });
      const r = await c.until<RoomMsg>((m) => m.t === 'room');
      assert.equal(r.room.config.teamSize, 5);
      c.send({ t: 'listRooms' });
      const ql = await c.until<RoomsMsg>((m) => m.t === 'rooms');
      assert.equal(ql.rooms.find((x) => x.code === r.room.code)?.slots, 10);
    } finally {
      await q.close();
    }
  } finally {
    for (const c of opened) c.ws.close();
    await s.close();
  }
});
