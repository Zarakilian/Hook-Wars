// DesktopBridge, the main-process side of every SteamBridge call: argument checks, host-only calls,
// invites reaching another window, join requests queued for the page, and one lobby action at a time.
// The game server here runs in-process (a GameServer on the port the launcher picked) to keep it fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig } from '../../server/config.ts';
import { GameServer } from '../../server/gameServer.ts';
import { createNullEconomy } from '../../server/economy/api.ts';
import { DesktopBridge, JoinRequestQueue } from '../src/desktopBridge.ts';
import { FakeHub, FakeSteamBackend, memoryLink } from '../src/fakeSteam.ts';
import type { ChildHandle, SpawnServer } from '../src/serverLauncher.ts';
import { sleep, tempDir, until } from './helpers.ts';

/** A "process" that is an in-process game server listening where the launcher asked. */
function inProcessSpawner(started: Record<string, string>[]): SpawnServer {
  return (env) => {
    started.push(env);
    const http = createServer();
    const game = new GameServer({ ...loadConfig(), host: env.HOST, port: Number(env.PORT), serverName: env.SERVER_NAME, relaySecret: env.RELAY_SECRET, allowedOrigins: [env.ALLOWED_ORIGINS] }, createNullEconomy());
    game.attach(http, { exclusive: true });
    let exitCb: ((c: number | null) => void) | null = null;
    let gone = false;
    const stop = (code: number | null) => {
      if (gone) return;
      gone = true;
      game.close();
      http.close();
      http.closeAllConnections();
      setImmediate(() => exitCb?.(code));
    };
    http.on('error', () => stop(1));
    http.listen(Number(env.PORT), env.HOST);
    const h: ChildHandle = { kill: () => stop(null), onExit: (cb) => (exitCb = cb), onOutput: () => {} };
    return h;
  };
}

async function setup(names: string[]) {
  const hub = new FakeHub();
  const started: Record<string, string>[] = [];
  const backends = await Promise.all(names.map((name) => FakeSteamBackend.connect({ link: memoryLink(hub), name, cloudDir: tempDir('cloud') })));
  const joins = names.map(() => [] as string[]);
  const bridges = backends.map(
    (backend, i) => new DesktopBridge({ backend, spawnServer: inProcessSpawner(started), dataDir: tempDir('data'), log: () => {}, leaveFlushMs: 0, onJoinRequest: (id) => joins[i].push(id) }),
  );
  return { bridges, backends, started, joins, done: () => Promise.all(bridges.map((b) => b.shutdown())) };
}

test('every call checks its arguments before anything happens', async () => {
  const { bridges, started, done } = await setup(['Host']);
  const [b] = bridges;
  try {
    await assert.rejects(b.hostLobby({}), /name/);
    await assert.rejects(b.hostLobby({ name: 'x', maxMembers: 99, isPrivate: false }), /maxMembers/);
    await assert.rejects(b.hostLobby({ name: 'x', maxMembers: 4, isPrivate: 'no' }), /isPrivate/);
    await assert.rejects(b.hostLobby({ name: 'x', maxMembers: 4, isPrivate: false, extra: 1 }), /unknown option/);
    await assert.rejects(b.hostLobby(null), /object/);
    await assert.rejects(b.joinLobby('12abc'), /lobby id/);
    await assert.rejects(b.joinLobby(123), /lobby id/);
    await assert.rejects(b.joinLobby('99999999999999999999999'), /lobby id/);
    await assert.rejects(b.setLobbyInfo({ room: 'ABCDE' }), /Only the host/);
    await assert.rejects(b.setLobbyInfo({ Bad: 'x' }), /bad key/);
    await assert.rejects(b.setLobbyInfo({ game: 'x' }), /set by the app/);
    await assert.rejects(b.cloudWrite('../x', 'data'), /file name/);
    await assert.rejects(b.cloudWrite('locker.json', 5), /string/);
    await assert.rejects(b.cloudRead('dir/file'), /file name/);
    assert.throws(() => b.openOverlayUrl('http://store.steampowered.com/'), /https/);
    assert.throws(() => b.openOverlayUrl('https://evil.example/'), /Steam sites/);
    b.openOverlayUrl('https://store.steampowered.com/itemstore/480/');
    assert.equal(started.length, 0, 'no server was started by a bad call');
    assert.equal(await b.cloudWrite('locker.json', '{"pearls":3}'), true);
    assert.equal(await b.cloudRead('locker.json'), '{"pearls":3}');
    assert.deepEqual(b.info, { appId: 480, fake: true });
    assert.equal((await b.player()).name, 'Host');
  } finally {
    await done();
  }
});

test('host lobby: one server per lobby, a double click starts one, leave stops it, setLobbyInfo publishes', async () => {
  const { bridges, started, done } = await setup(['Host', 'Joe']);
  const [host, joe] = bridges;
  try {
    const opts = { name: 'Double click', maxMembers: 4, isPrivate: false };
    const [a, b] = await Promise.all([host.hostLobby(opts), host.hostLobby(opts)]);
    assert.equal(started.length, 2, 'the second call replaced the first lobby');
    assert.notEqual(a.lobbyId, b.lobbyId);
    assert.equal(host.state?.lobbyId, b.lobbyId);
    assert.equal(started[1].ECONOMY, 'trust');
    await host.setLobbyInfo({ room: 'ABCDE', phase: 'match' });
    await sleep(10);
    const list = await joe.listLobbies();
    assert.deepEqual(list.map((l) => l.id), [b.lobbyId], 'the first lobby is gone');
    assert.equal(list[0].info.phase, 'match');
    await host.leaveLobby();
    assert.equal(host.state, null);
    assert.equal((await joe.listLobbies()).length, 0);
  } finally {
    await done();
  }
});

test('invite friends: the other window gets a join request for the lobby (stand-in)', async () => {
  const { bridges, joins, done } = await setup(['Host', 'Joe']);
  const [host] = bridges;
  try {
    const { lobbyId } = await host.hostLobby({ name: 'Invite', maxMembers: 2, isPrivate: true });
    host.inviteFriends();
    await until(() => joins[1].length === 1, 1000, 'join request');
    assert.deepEqual(joins[1], [lobbyId]);
    assert.deepEqual(joins[0], [], 'not to yourself');
  } finally {
    await done();
  }
});

test('join requests wait until the page listens, then go straight through', () => {
  const delivered: string[] = [];
  const q = new JoinRequestQueue((id) => delivered.push(id));
  q.push('not a lobby');
  q.push('109775240000000001');
  q.push('109775240000000002'); // only the newest waits
  assert.deepEqual(delivered, []);
  assert.equal(q.take(), '109775240000000002');
  assert.equal(q.take(), null);
  q.push('109775240000000003');
  assert.deepEqual(delivered, ['109775240000000003']);
  q.reset(); // the page reloads
  q.push('109775240000000004');
  assert.deepEqual(delivered, ['109775240000000003']);
  assert.equal(q.take(), '109775240000000004');
});
