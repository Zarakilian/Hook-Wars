// The steamworks.js adapter against a stand-in object shaped like steamworks.js 0.4.0 (client.d.ts):
// bigint <-> string ids, the callbacks it listens to, the P2P read loop, lobbies, cloud and overlay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOBBY_TYPE, SEND_RELIABLE, STEAM_CALLBACK_FALLBACK, SteamworksBackend, idString, type SwClient, type SwLobby, type SwModule } from '../src/steamworksBackend.ts';
import { until } from './helpers.ts';

const ME = 76561198000000001n;

function mockLobby(id: bigint, owner: bigint, members: bigint[], data: Record<string, string> = {}) {
  const calls: string[] = [];
  const l: SwLobby = {
    id,
    join: async () => l,
    leave: () => calls.push('leave'),
    openInviteDialog: () => calls.push('invite'),
    getMembers: () => members.map((m) => ({ steamId64: m })),
    getOwner: () => ({ steamId64: owner }),
    getMemberCount: () => BigInt(members.length),
    getMemberLimit: () => 10n,
    getData: (k) => data[k] ?? null,
    setData: (k, v) => ((data[k] = v), true),
    getFullData: () => ({ ...data }),
    mergeFullData: (d) => (Object.assign(data, d), true),
    setJoinable: () => true,
  };
  return { l, calls, data };
}

function mockSteamworks(opts: { withEnum?: boolean; failInit?: boolean; cloudFault?: 'exists' | 'read' | 'write' } = {}) {
  const handlers = new Map<number, (v: unknown) => void>();
  const sent: { to: bigint; type: number; data: Buffer }[] = [];
  const accepted: bigint[] = [];
  const inbox: { data: Buffer; steamId: { steamId64: bigint } }[] = [];
  const files = new Map<string, string>();
  const overlay: string[] = [];
  const created = mockLobby(109775240000000777n, ME, [ME]);
  const listed = mockLobby(109775240000000888n, 76561198000000002n, [76561198000000002n], { game: 'hookwars', v: '3' });
  let initAppId: number | undefined = -1;
  let runCount = 0;
  let disconnected = 0;
  const client: SwClient = {
    localplayer: { getSteamId: () => ({ steamId64: ME }), getName: () => 'Real Player' },
    matchmaking: {
      createLobby: async (type, max) => {
        assert.equal(type, LOBBY_TYPE.Public);
        assert.equal(max, 6);
        return created.l;
      },
      joinLobby: async (id) => {
        assert.equal(typeof id, 'bigint');
        return listed.l;
      },
      getLobbies: async () => [listed.l],
    },
    networking: {
      sendP2PPacket: (to, type, data) => (sent.push({ to, type, data }), true),
      isP2PPacketAvailable: () => inbox[0]?.data.length ?? 0,
      readP2PPacket: () => inbox.shift()!,
      acceptP2PSession: (id) => accepted.push(id),
    },
    cloud: {
      readFile: (n) => {
        if (opts.cloudFault === 'read') throw new Error('Steam Cloud read failed');
        return files.get(n)!;
      },
      writeFile: (n, c) => {
        if (opts.cloudFault === 'write') throw new Error('Steam Cloud write failed');
        return (files.set(n, c), true);
      },
      fileExists: (n) => {
        if (opts.cloudFault === 'exists') throw new Error('Steam Cloud is not ready');
        return files.has(n);
      },
    },
    overlay: { activateToWebPage: (u) => overlay.push(u), activateInviteDialog: (id) => overlay.push(`invite:${id}`) },
    callback: {
      register: (id, h) => {
        handlers.set(id, h);
        return { disconnect: () => disconnected++ };
      },
    },
  };
  const ENUM = { LobbyDataUpdate: 40, LobbyChatUpdate: 50, P2PSessionRequest: 60, P2PSessionConnectFail: 70, GameLobbyJoinRequested: 80 };
  const mod: SwModule = {
    init: (appId) => {
      if (opts.failInit) throw new Error('Steam is not running');
      initAppId = appId;
      return client;
    },
    runCallbacks: () => runCount++,
    SteamCallback: opts.withEnum ? ENUM : undefined,
  };
  return { mod, handlers, sent, accepted, inbox, files, overlay, created, listed, ENUM, initAppId: () => initAppId, runs: () => runCount, disconnected: () => disconnected };
}

test('ids: bigints, numbers, strings and SteamId objects all become decimal strings', () => {
  assert.equal(idString(76561198000000001n), '76561198000000001');
  assert.equal(idString({ steamId64: 5n }), '5');
  assert.equal(idString(42), '42');
  assert.equal(idString('123'), '123');
  assert.equal(idString(0n), null);
  assert.equal(idString('abc'), null);
  assert.equal(idString(null), null);
});

test('callbacks map to backend events (enum from the module, or the fallback ids)', async () => {
  for (const withEnum of [true, false]) {
    const m = mockSteamworks({ withEnum });
    const b = new SteamworksBackend({ module: m.mod, appId: 480, log: () => {} });
    try {
      assert.equal(m.initAppId(), 480);
      const ids = withEnum ? m.ENUM : STEAM_CALLBACK_FALLBACK;
      const seen: string[] = [];
      b.on('sessionRequest', (f) => seen.push(`req ${f}`));
      b.on('sessionFailed', (f) => seen.push(`fail ${f}`));
      b.on('lobbyChanged', (l) => seen.push(`lobby ${l}`));
      b.on('joinRequested', (l) => seen.push(`join ${l}`));
      m.handlers.get(ids.P2PSessionRequest)!({ remote: 76561198000000002n });
      m.handlers.get(ids.P2PSessionConnectFail)!({ remote: 76561198000000003n, error: 4 });
      m.handlers.get(ids.LobbyChatUpdate)!({ lobby: 77n, user_changed: 1n, making_change: 1n, member_state_change: 2 });
      m.handlers.get(ids.LobbyDataUpdate)!({ lobby: 78n, member: 0n, success: true });
      m.handlers.get(ids.GameLobbyJoinRequested)!({ lobby_steam_id: 79n, friend_steam_id: 2n });
      m.handlers.get(ids.GameLobbyJoinRequested)!({ nonsense: true });
      assert.deepEqual(seen, ['req 76561198000000002', 'fail 76561198000000003', 'lobby 77', 'lobby 78', 'join 79']);
      await until(() => m.runs() > 0, 1000, 'runCallbacks polled');
    } finally {
      b.close();
    }
    assert.equal(m.disconnected(), 5, 'callbacks unregistered on close');
  }
});

test('P2P: reliable sends with bigint ids, and the read loop delivers packets with the sender', async () => {
  const m = mockSteamworks();
  const b = new SteamworksBackend({ module: m.mod, appId: 480, log: () => {} });
  try {
    assert.equal(b.sendPacket('76561198000000002', Buffer.from('hi')), true);
    assert.deepEqual(m.sent.map((s) => [s.to, s.type, s.data.toString()]), [[76561198000000002n, SEND_RELIABLE, 'hi']]);
    b.acceptSession('76561198000000002');
    assert.deepEqual(m.accepted, [76561198000000002n]);
    const got: string[] = [];
    b.on('packet', (from, d) => got.push(`${from}:${d.toString()}`));
    m.inbox.push({ data: Buffer.from('one'), steamId: { steamId64: 76561198000000002n } }, { data: Buffer.from('two'), steamId: { steamId64: 76561198000000003n } });
    await until(() => got.length === 2, 1000, 'packets');
    assert.deepEqual(got, ['76561198000000002:one', '76561198000000003:two']);
  } finally {
    b.close();
  }
});

test('lobbies, cloud and overlay go through to steamworks.js', async () => {
  const m = mockSteamworks();
  const b = new SteamworksBackend({ module: m.mod, appId: 480, log: () => {} });
  try {
    assert.deepEqual(b.me(), { steamId: '76561198000000001', name: 'Real Player' });
    const id = await b.createLobby('public', 6);
    assert.equal(id, '109775240000000777');
    assert.equal(b.lobbyOwner(id), '76561198000000001');
    assert.equal(b.setLobbyData(id, { game: 'hookwars' }), true);
    assert.equal(m.created.data.game, 'hookwars');
    const list = await b.listLobbies();
    assert.deepEqual(list, [{ id: '109775240000000888', owner: '76561198000000002', members: 1, max: 10, data: { game: 'hookwars', v: '3' } }]);
    assert.equal(b.lobbyOwner('109775240000000888'), null, 'a lobby that was only listed is not kept (app 480 lists many)');
    await b.joinLobby('109775240000000888');
    assert.deepEqual(b.lobbyMembers('109775240000000888'), ['76561198000000002']);
    b.openInviteDialog(id);
    b.openOverlayUrl('https://store.steampowered.com/');
    assert.deepEqual(m.overlay, [`invite:${id}`, 'https://store.steampowered.com/']);
    assert.equal(b.cloudRead('locker.json'), null);
    assert.equal(b.cloudWrite('locker.json', '{}'), true);
    assert.equal(b.cloudRead('locker.json'), '{}');
    b.leaveLobby(id);
    assert.deepEqual(m.created.calls, ['leave']);
  } finally {
    b.close();
  }
  assert.deepEqual(m.listed.calls, ['leave'], 'close leaves the lobbies we are in, not the ones we only listed');
});

test('Steam Cloud: a missing file is null, a failed read throws, a failed write is false', () => {
  // The page treats null as "no Cloud copy yet" and uploads its own locker over it, so a read that
  // fails must not look like a missing file (client/economy/index.ts useCloud: readOk).
  for (const fault of ['exists', 'read'] as const) {
    const m = mockSteamworks({ cloudFault: fault });
    const b = new SteamworksBackend({ module: m.mod, appId: 480, log: () => {} });
    try {
      m.files.set('locker.json', '{"pearls":40}');
      assert.throws(() => b.cloudRead('locker.json'), /Steam Cloud/, `a ${fault} failure is an error, not "no file"`);
    } finally {
      b.close();
    }
  }
  const ok = mockSteamworks();
  const b1 = new SteamworksBackend({ module: ok.mod, appId: 480, log: () => {} });
  try {
    assert.equal(b1.cloudRead('locker.json'), null, 'no such file');
  } finally {
    b1.close();
  }
  const w = mockSteamworks({ cloudFault: 'write' });
  const b2 = new SteamworksBackend({ module: w.mod, appId: 480, log: () => {} });
  try {
    assert.equal(b2.cloudWrite('locker.json', '{}'), false, 'a write that throws is false, never an exception');
  } finally {
    b2.close();
  }
});

test('Steam not running: the constructor throws, so main falls back to the stand-in', () => {
  const m = mockSteamworks({ failInit: true });
  assert.throws(() => new SteamworksBackend({ module: m.mod, appId: 480 }), /not running/);
});
