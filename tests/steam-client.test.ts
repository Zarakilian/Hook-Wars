// Steam lobbies, client side: the lobby info a host publishes, the lobby browser's filter, and the
// whole host / join / invite / leave flow (client/net/steamPlay.ts) against the real game server in
// ECONOMY=trust mode. A FakeSteam hub stands in for Steam: it keeps the lobbies of every "computer"
// in this process, and joinLobby hands back the host server's own address where the desktop app
// would hand back its P2P relay (desktop/** tests the relay itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CONFIG, PROTOCOL_VERSION } from '../shared/constants.ts';
import { DEFAULT_LOADOUT } from '../shared/cosmetics.ts';
import type { Profile, RoomState, ServerMsg } from '../shared/protocol.ts';
import { GameServer } from '../server/gameServer.ts';
import { loadConfig } from '../server/config.ts';
import { createTrustEconomy } from '../server/economy/trust.ts';
import type { SteamBridge, SteamLobbySummary } from '../client/platform.ts';
import { Connection } from '../client/net/connection.ts';
import { RejoinStore } from '../client/net/rejoin.ts';
import {
  clampLobbyMax, cleanLobbyName, filterLobbies, LOBBY_KEYS, lobbyInfoFor, LobbyInfoPublisher, roomCodeFor, teamSizeFor, type LobbyInfo, type Timers,
} from '../client/net/steamLobby.ts';
import { SteamPlay, type SteamPlayState } from '../client/net/steamPlay.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 4000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

/** Manual clock for the publisher. */
function fakeTimers() {
  let now = 1000;
  let seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      q.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (t) => void q.delete(t as number),
    now: () => now,
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await sleep(0);
      const next = [...q.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      q.delete(next[0]);
      next[1].fn();
    }
    now = end;
    await sleep(0);
  };
  return { timers, advance, pending: () => q.size };
}

const ROOM = (over: Partial<RoomState> = {}): RoomState => ({
  code: 'ABCDE',
  name: "Ann's room",
  isPrivate: false,
  hostId: 1,
  config: { ...DEFAULT_CONFIG, mapId: 'coralcove', riverMode: 'tidal', teamSize: 3 },
  players: [{ id: 1, name: 'Ann', team: 0, family: 'brawler', loadout: {}, isBot: false, ready: false, host: true, ping: 0 }],
  phase: 'lobby',
  ...over,
});

// ---------------------------------------------------------------------------------------------
// Lobby info and the browser filter
// ---------------------------------------------------------------------------------------------

test('lobby info: game, protocol version, name, room code, map, mode, phase, humans and max, as short strings', () => {
  const info = lobbyInfoFor(ROOM(), "Ann's lobby");
  assert.deepEqual(info, { game: 'hookwars', v: String(PROTOCOL_VERSION), name: "Ann's lobby", room: 'ABCDE', map: 'coralcove', mode: 'tidal', phase: 'lobby', humans: '1', max: '6' });
  assert.deepEqual(Object.keys(info), [...LOBBY_KEYS]);
  for (const v of Object.values(info)) assert.ok(typeof v === 'string' && v.length <= 40);
  // a long or odd name is cleaned; an empty one falls back to the room's name
  assert.equal(lobbyInfoFor(ROOM(), `  a\u0007b${'x'.repeat(80)}`).name.length, 40);
  assert.equal(lobbyInfoFor(ROOM(), '').name, "Ann's room");
  assert.equal(cleanLobbyName('  two   spaces\n'), 'two spaces');
  // max players picks a lobby size; the room gets half of it per team
  assert.deepEqual([1, 2, 3, 4, 9, 10, 40, Number.NaN].map(clampLobbyMax), [2, 2, 4, 4, 10, 10, 10, 10]);
  assert.deepEqual([2, 4, 6, 8, 10].map(teamSizeFor), [1, 2, 3, 4, 5]);
});

test('the lobby browser shows only Hook Wars lobbies of this protocol version, checked field by field', () => {
  const hw = (id: string, info: Partial<LobbyInfo>, over: Partial<SteamLobbySummary> = {}): SteamLobbySummary => ({
    id, name: `lobby ${id}`, host: 'Host', members: 1, max: 6,
    info: { game: 'hookwars', v: String(PROTOCOL_VERSION), name: `lobby ${id}`, room: 'ABCDE', map: 'muckmire', mode: 'deep', phase: 'lobby', humans: '1', max: '6', ...info } as Record<string, string>, ...over,
  });
  const list: unknown[] = [
    hw('1', {}),
    hw('2', { game: 'spacewar' }), // another developer's app 480 lobby
    hw('3', { v: String(PROTOCOL_VERSION - 1) }), // an older build
    hw('4', { v: String(PROTOCOL_VERSION + 1) }), // a newer build
    hw('5', { room: '' }), // no room yet
    hw('6', { room: 'abcde' }),
    hw('not-a-number', {}),
    hw('1', { name: 'duplicate' }),
    { id: '7', name: 'no info' },
    null,
    'junk',
    hw('8', { phase: 'match' }, { members: 3 }),
    hw('9', {}, { members: 6, max: 6 }), // full
    hw('10', { map: '__proto__', mode: '<script>' }, { name: '\u0000evil\u0007 name', host: 'h'.repeat(100), members: -5, max: 1e9 }),
    hw('11', {}, { members: 4 }),
  ];
  const out = filterLobbies(list);
  assert.deepEqual(out.map((l) => l.id), ['11', '1', '10', '9', '8'], 'filtered or ordered wrongly (waiting lobbies first, full ones after, then the fullest)');
  const odd = out.find((l) => l.id === '10')!;
  assert.equal(odd.info.map, '', 'an unknown map id was kept');
  assert.equal(odd.info.mode, '');
  assert.equal(odd.name, 'evil name');
  assert.equal(odd.host.length, 32);
  assert.equal(odd.members, 0);
  assert.equal(odd.max, 250);
  assert.equal(filterLobbies('nope').length, 0);
  assert.equal(filterLobbies([hw('1', {})], PROTOCOL_VERSION + 1).length, 0, 'the version is not checked');
  assert.equal(roomCodeFor('1', out), 'ABCDE');
  assert.equal(roomCodeFor('2', out), null);
});

test('the lobby info publisher sends only changes, at most once a second, the newest wins, and retries a failure', async () => {
  const { timers, advance } = fakeTimers();
  const sent: LobbyInfo[] = [];
  let fail = false;
  const pub = new LobbyInfoPublisher(async (info) => {
    if (fail) throw new Error('steam busy');
    sent.push(info);
  }, { timers, minIntervalMs: 1000 });
  const a = lobbyInfoFor(ROOM(), 'L');
  pub.update(a);
  await advance(0);
  assert.equal(sent.length, 1, 'the first info is not published at once');
  // the same info again (room messages arrive often): nothing is sent
  for (let i = 0; i < 5; i++) pub.update(lobbyInfoFor(ROOM(), 'L'));
  await advance(5000);
  assert.equal(sent.length, 1, 'an unchanged info was published again');
  // three changes inside one second: one publish, with the newest
  pub.update({ ...a, humans: '2' });
  await advance(0);
  pub.update({ ...a, humans: '3' });
  pub.update({ ...a, humans: '4', phase: 'match' });
  await advance(100);
  assert.equal(sent.length, 2);
  await advance(1000);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].humans, '4');
  assert.equal(sent[2].phase, 'match');
  // a failed publish is tried again later; the info Steam has is still the old one meanwhile
  fail = true;
  pub.update({ ...a, humans: '5' });
  await advance(1100);
  assert.equal(pub.published?.humans, '4');
  fail = false;
  await advance(5000);
  assert.equal(sent[sent.length - 1].humans, '5');
  assert.equal(pub.published?.humans, '5');
  // stopped: nothing more goes out
  pub.stop();
  pub.update({ ...a, humans: '9' });
  await advance(5000);
  assert.equal(sent[sent.length - 1].humans, '5');
});

// ---------------------------------------------------------------------------------------------
// FakeSteam: lobbies shared by every player in this process
// ---------------------------------------------------------------------------------------------

interface FakeLobby {
  id: string;
  name: string;
  host: string;
  hostSteamId: string;
  max: number;
  isPrivate: boolean;
  members: Set<string>;
  info: Record<string, string>;
  url: string;
}

class FakeSteamHub {
  readonly lobbies = new Map<string, FakeLobby>();
  private next = 109775240000000000n;
  /** the game server a host's hostLobby "starts" */
  serverUrl = '';
  newId(): string {
    this.next += 1n;
    return this.next.toString();
  }
}

type FakeBridge = SteamBridge & { joinRequest(id: string): void; invites: number; current(): string | null; published: Record<string, string>[] };

function fakeBridge(hub: FakeSteamHub, steamId: string, name: string): FakeBridge {
  let lobby: string | null = null;
  const cbs = new Set<(id: string) => void>();
  const b: FakeBridge = {
    kind: 'steam',
    appId: 480,
    fake: true,
    invites: 0,
    published: [],
    current: () => lobby,
    joinRequest: (id) => cbs.forEach((cb) => cb(id)),
    player: async () => ({ steamId, name }),
    async hostLobby(o) {
      const id = hub.newId();
      hub.lobbies.set(id, { id, name: o.name, host: name, hostSteamId: steamId, max: o.maxMembers, isPrivate: o.isPrivate, members: new Set([steamId]), info: {}, url: hub.serverUrl });
      lobby = id;
      return { lobbyId: id, url: hub.serverUrl };
    },
    async joinLobby(id) {
      const l = hub.lobbies.get(id);
      if (!l) throw new Error('That lobby no longer exists');
      if (l.members.size >= l.max) throw new Error('That lobby is full');
      l.members.add(steamId);
      lobby = id;
      return { url: l.url };
    },
    async leaveLobby() {
      const l = lobby ? hub.lobbies.get(lobby) : undefined;
      lobby = null;
      if (!l) return;
      l.members.delete(steamId);
      if (l.hostSteamId === steamId || l.members.size === 0) hub.lobbies.delete(l.id);
    },
    async listLobbies() {
      const real = [...hub.lobbies.values()].filter((l) => !l.isPrivate).map((l) => ({ id: l.id, name: l.name, host: l.host, members: l.members.size, max: l.max, info: { ...l.info } }));
      // app 480 is shared: other games' lobbies and older Hook Wars builds show up too
      return [
        ...real,
        { id: '42', name: 'Spacewar dogfight', host: 'someone', members: 2, max: 4, info: { game: 'spacewar' } },
        { id: '43', name: 'old build', host: 'x', members: 1, max: 4, info: { game: 'hookwars', v: '1', room: 'ZZZZZ' } },
      ];
    },
    async setLobbyInfo(info) {
      const l = lobby ? hub.lobbies.get(lobby) : undefined;
      b.published.push({ ...info });
      if (l && l.hostSteamId === steamId) Object.assign(l.info, info);
    },
    inviteFriends() {
      b.invites++;
    },
    onJoinRequest(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    cloudRead: async () => null,
    cloudWrite: async () => true,
    openOverlayUrl() {},
    setFullscreen() {},
    isFullscreen: async () => false,
    quit() {},
  };
  return b;
}

/** One player's page: a SteamPlay controller wired to a real Connection, like client/app.ts does. */
function player(hub: FakeSteamHub, steamId: string, name: string, opts: { live?: () => boolean } = {}) {
  const bridge = fakeBridge(hub, steamId, name);
  const profile: Profile = { name, family: 'brawler', loadout: { ...DEFAULT_LOADOUT.brawler } };
  let conn: Connection | null = null;
  const inbox: ServerMsg[] = [];
  const states: SteamPlayState[] = [];
  let lastRoom: RoomState | null = null;
  const store = new RejoinStore(null);
  const play: SteamPlay = new SteamPlay(bridge, {
    connect(url) {
      conn?.close();
      const c = new Connection(url, profile, null, { autoRejoin: false, rejoinStore: store });
      conn = c;
      c.onMessage = (m) => {
        inbox.push(m);
        if (m.t === 'room') lastRoom = m.room;
        if (m.t === 'leftRoom') {
          lastRoom = null;
          void play.leave();
          return;
        }
        play.onServer(m);
      };
      c.onStatus = (st, reason) => {
        if (conn !== c || st !== 'closed') return;
        conn = null;
        lastRoom = null;
        play.onClosed(reason);
      };
    },
    disconnect() {
      const c = conn;
      conn = null;
      lastRoom = null;
      c?.close();
    },
    send: (m) => conn?.send(m),
    roomConfig: (max) => ({ ...DEFAULT_CONFIG, teamSize: teamSizeFor(max), botFill: true, mapId: 'cogwater' }),
    inLiveMatch: () => opts.live?.() ?? false,
    changed: (s) => void states.push(s),
  });
  play.start();
  return { bridge, play, inbox, states, room: () => lastRoom, conn: () => conn, close: () => (conn as Connection | null)?.close() };
}

async function startLobbyServer() {
  const http = createServer((_, res) => res.end('ok'));
  const game = new GameServer({ ...loadConfig(), relaySecret: null }, createTrustEconomy());
  game.attach(http, { exclusive: true });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    game,
    close: async () => {
      game.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The whole flow
// ---------------------------------------------------------------------------------------------

test('host a lobby: the room is made by itself and the lobby info follows it; a friend finds it in the browser and joins by its code', async () => {
  const srv = await startLobbyServer();
  const hub = new FakeSteamHub();
  hub.serverUrl = srv.url;
  const ann = player(hub, '76561198000000001', 'Ann');
  const bob = player(hub, '76561198000000002', 'Bob');
  try {
    await waitFor(() => ann.play.state().player?.name === 'Ann', 2000, 'the Steam player');
    await Promise.all([ann.play.host({ name: "Ann's lobby", maxPlayers: 4, isPrivate: false }), ann.play.host({ name: 'double click', maxPlayers: 4, isPrivate: false })]);
    assert.equal(hub.lobbies.size, 1, 'a double click made two lobbies');
    await waitFor(() => ann.play.state().phase === 'lobby', 4000, 'the host lobby');
    const room = ann.room()!;
    assert.ok(room, 'no room');
    assert.equal(room.isPrivate, false, 'the room on the host server must be findable for invites');
    assert.equal(room.config.teamSize, 2, 'max players 4 = 2 a side');
    const lobbyId = ann.play.state().lobbyId!;
    await waitFor(() => hub.lobbies.get(lobbyId)?.info.room === room.code, 3000, 'the published room code');
    assert.deepEqual(hub.lobbies.get(lobbyId)!.info, lobbyInfoFor(room, "Ann's lobby"));
    assert.equal(hub.lobbies.get(lobbyId)!.info.v, String(PROTOCOL_VERSION));
    // the joiner's browser: only this Hook Wars lobby (other games and old builds are filtered out)
    await bob.play.refresh();
    assert.deepEqual(bob.play.state().lobbies.map((l) => l.id), [lobbyId]);
    await bob.play.join(lobbyId);
    await waitFor(() => bob.play.state().phase === 'lobby', 4000, 'the joiner lobby');
    assert.equal(bob.room()!.code, room.code, 'joined another room than the published one');
    assert.equal(bob.inbox.some((m) => m.t === 'econError' && m.code === 'local_only'), true, 'the trust server did not say local_only');
    // the host's lobby info follows the room: 2 humans now
    await waitFor(() => hub.lobbies.get(lobbyId)?.info.humans === '2', 3000, 'humans=2 published');
    // invite friends opens the overlay (only while in a lobby)
    ann.play.inviteFriends();
    assert.equal(ann.bridge.invites, 1);
    // the joiner leaves: back to idle, Steam lobby left, the host stays
    await bob.play.leave();
    assert.equal(bob.play.state().phase, 'idle');
    assert.equal(bob.play.state().error, null);
    assert.equal(bob.bridge.current(), null);
    assert.equal(bob.conn(), null);
    await waitFor(() => hub.lobbies.get(lobbyId)?.info.humans === '1', 3000, 'humans=1 published');
    assert.equal(ann.play.state().phase, 'lobby');
  } finally {
    ann.close();
    bob.close();
    ann.play.dispose();
    bob.play.dispose();
    await srv.close();
  }
});

test('a friend invite joins from the menu, also for a lobby not in the list; during a live match it waits for a yes', async () => {
  const srv = await startLobbyServer();
  const hub = new FakeSteamHub();
  hub.serverUrl = srv.url;
  let live = true;
  const ann = player(hub, '76561198000000011', 'Ann');
  const cid = player(hub, '76561198000000012', 'Cid', { live: () => live });
  const dee = player(hub, '76561198000000013', 'Dee');
  try {
    await ann.play.host({ name: 'friends only', maxPlayers: 6, isPrivate: true });
    await waitFor(() => ann.play.state().phase === 'lobby', 4000, 'host lobby');
    const lobbyId = ann.play.state().lobbyId!;
    // a private lobby is not in anyone's list: the invite still gets in (the host server has one room)
    await dee.play.refresh();
    assert.equal(dee.play.state().lobbies.length, 0);
    dee.bridge.joinRequest(lobbyId);
    await waitFor(() => dee.play.state().phase === 'lobby', 6000, 'Dee in by invite');
    assert.equal(dee.room()!.code, ann.room()!.code);
    // a garbage request is ignored
    dee.bridge.joinRequest('not-a-lobby');
    assert.equal(dee.play.state().lobbyId, lobbyId);
    // Cid is in a live match: the invite waits
    cid.bridge.joinRequest(lobbyId);
    assert.equal(cid.play.state().invite, lobbyId);
    assert.equal(cid.play.state().phase, 'idle');
    cid.play.dismissInvite();
    assert.equal(cid.play.state().invite, null);
    cid.bridge.joinRequest(lobbyId);
    live = false; // the match ended
    cid.play.acceptInvite();
    await waitFor(() => cid.play.state().phase === 'lobby', 6000, 'Cid in after saying yes');
    assert.equal(cid.room()!.code, ann.room()!.code);
    await waitFor(() => ann.room()?.players.length === 3, 3000, 'three players in the host room');
    assert.equal(hub.lobbies.get(lobbyId)!.members.size, 3);
  } finally {
    for (const p of [ann, cid, dee]) {
      p.close();
      p.play.dispose();
    }
    await srv.close();
  }
});

test('the host leaving (its server stops) sends every joiner back to the Steam screen with the reason', async () => {
  const srv = await startLobbyServer();
  const hub = new FakeSteamHub();
  hub.serverUrl = srv.url;
  const ann = player(hub, '76561198000000021', 'Ann');
  const bob = player(hub, '76561198000000022', 'Bob');
  try {
    await ann.play.host({ name: 'short one', maxPlayers: 2, isPrivate: false });
    await waitFor(() => ann.play.state().phase === 'lobby', 4000, 'host lobby');
    await bob.play.refresh();
    await bob.play.join(ann.play.state().lobbyId!);
    await waitFor(() => bob.play.state().phase === 'lobby', 4000, 'joiner lobby');
    await ann.play.leave();
    assert.equal(ann.play.state().phase, 'idle');
    assert.equal(hub.lobbies.size, 0, 'the host left but its lobby is still listed');
    await srv.close(); // the desktop app stops the host's server
    await waitFor(() => bob.play.state().phase === 'idle', 4000, 'the joiner back to idle');
    assert.match(bob.play.state().error ?? '', /host left|connection to the host/i);
    assert.equal(bob.bridge.current(), null, 'the joiner did not leave the Steam lobby');
  } finally {
    ann.close();
    bob.close();
    ann.play.dispose();
    bob.play.dispose();
    await srv.close().catch(() => {});
  }
});

test('join failures end cleanly: a full lobby, a lobby that is gone, a Steam error while hosting, leaving mid-host', async () => {
  const srv = await startLobbyServer();
  const hub = new FakeSteamHub();
  hub.serverUrl = srv.url;
  const ann = player(hub, '76561198000000031', 'Ann');
  const bob = player(hub, '76561198000000032', 'Bob');
  const cid = player(hub, '76561198000000033', 'Cid');
  try {
    await ann.play.host({ name: 'tiny', maxPlayers: 2, isPrivate: false });
    await waitFor(() => ann.play.state().phase === 'lobby', 4000, 'host lobby');
    const id = ann.play.state().lobbyId!;
    await bob.play.refresh();
    await bob.play.join(id);
    await waitFor(() => bob.play.state().phase === 'lobby', 4000, 'bob in');
    // Steam says the lobby is full
    await cid.play.refresh();
    await cid.play.join(id);
    assert.equal(cid.play.state().phase, 'idle');
    assert.match(cid.play.state().error ?? '', /full/i);
    // a lobby that no longer exists
    await cid.play.join('123456');
    assert.equal(cid.play.state().phase, 'idle');
    assert.match(cid.play.state().error ?? '', /no longer exists/);
    // Steam fails to make a lobby
    const realHost = cid.bridge.hostLobby;
    cid.bridge.hostLobby = async () => {
      throw new Error('Steam is offline');
    };
    await cid.play.host({ name: 'x', maxPlayers: 4, isPrivate: false });
    assert.equal(cid.play.state().phase, 'idle');
    assert.match(cid.play.state().error ?? '', /Steam is offline/);
    // leaving while the lobby is still being made: the lobby is not kept
    let release: () => void = () => {};
    cid.bridge.hostLobby = (o) => new Promise((r) => (release = () => r(realHost(o))));
    const hosting = cid.play.host({ name: 'slow', maxPlayers: 4, isPrivate: false });
    await sleep(10);
    assert.equal(cid.play.state().phase, 'hosting');
    await cid.play.leave();
    release();
    await hosting;
    await sleep(20);
    assert.equal(cid.play.state().phase, 'idle');
    assert.equal(cid.conn(), null, 'connected to a lobby the player had left');
    assert.equal([...hub.lobbies.values()].some((l) => l.name === 'slow'), false, 'the abandoned lobby was kept');
  } finally {
    for (const p of [ann, bob, cid]) {
      p.close();
      p.play.dispose();
    }
    await srv.close();
  }
});
