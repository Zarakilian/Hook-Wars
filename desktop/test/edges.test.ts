// Edge cases of the whole Steam lobby path, with FakeSteam where Steam would be and the real game
// server (server/index.ts from source) on the host: the host's server crashing (restart, then giving
// up), a joiner arriving in the middle of a match and getting its unit back on a new page connection,
// and two lobbies at once on one hub (no packets cross, and a host who joins another lobby ends its own).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, MAX_TEAM_SIZE } from '../../shared/constants.ts';
import { DesktopBridge } from '../src/desktopBridge.ts';
import { FakeHub, FakeSteamBackend, memoryLink } from '../src/fakeSteam.ts';
import { FrameType, encodeData, encodeFrame } from '../src/framing.ts';
import { HOST_LEFT_CODE, REPLACED_CODE } from '../src/joinerRelay.ts';
import { probeServer, type ChildHandle, type SpawnServer } from '../src/serverLauncher.ts';
import { SERVER_SOURCE, client, closeQuietly, hello, nodeSpawner, sleep, tempDir, until, type TestClient } from './helpers.ts';

const noServer: SpawnServer = () => {
  throw new Error('a joiner never starts a server');
};

async function players(names: string[]) {
  const hub = new FakeHub();
  return Promise.all(names.map((name) => FakeSteamBackend.connect({ link: memoryLink(hub), name, cloudDir: tempDir('cloud') })));
}

test("the host's server crashes: joiner pages close with 4002 and get back in through the same relay; repeated crashes end the lobby", { timeout: 90_000 }, async () => {
  const [hostB, joeB] = await players(['Host', 'Joe']);
  const spawned: ChildHandle[] = [];
  const logs: string[] = [];
  const host = new DesktopBridge({ backend: hostB, spawnServer: nodeSpawner(SERVER_SOURCE, spawned), dataDir: tempDir('host'), log: (s) => logs.push(s), leaveFlushMs: 50 });
  const joe = new DesktopBridge({ backend: joeB, spawnServer: noServer, dataDir: tempDir('joe'), log: () => {} });
  const open: TestClient[] = [];
  const page = async (url: string, name: string) => {
    const c = client(url);
    open.push(c);
    await c.open;
    hello(c, name);
    await c.wait('welcome', () => true, 8000);
    return c;
  };
  // the bridge logs each restart once the launcher has the new server answering
  const restarted = (n: number) => until(() => logs.filter((s) => s.includes('restarted after a crash')).length >= n, 15_000, `restart ${n}`);
  try {
    const hosted = await host.hostLobby({ name: 'Crash test', maxMembers: 2, isPrivate: false });
    const { url: relayUrl } = await joe.joinLobby(hosted.lobbyId);
    const c1 = await page(relayUrl, 'Joe');
    await page(hosted.url, 'Host');

    // one crash: the relayed page is told (4002), not left hanging
    const closed = c1.closed;
    spawned.at(-1)!.kill();
    const r = await closed;
    assert.equal(r.code, 4002, `close ${r.code} ${r.reason}`);
    assert.ok(joe.state, 'the joiner is still in the lobby');
    // the launcher brings the server back on the same port: the same relay url reaches it, and the
    // host's page finds it at the address it already had
    await restarted(1);
    assert.equal(spawned.length, 2, 'one restart');
    assert.equal(host.state!.url, hosted.url, 'same port');
    await page(relayUrl, 'Joe');
    await page(hosted.url, 'Host');

    // crashes until the launcher gives up: the joiner is told the host left, the lobby is gone
    let c3: TestClient = await page(relayUrl, 'Joe');
    for (let i = 0; i < 3; i++) {
      const before: number = spawned.length;
      const ended = c3.closed;
      spawned.at(-1)!.kill();
      if (i < 2) {
        assert.equal((await ended).code, 4002);
        await restarted(i + 2);
        assert.equal(spawned.length, before + 1);
        c3 = await page(relayUrl, 'Joe');
      } else {
        const last = await ended;
        assert.ok(last.code === 4002 || last.code === HOST_LEFT_CODE, `close ${last.code}`);
      }
    }
    await until(() => host.state === null, 15_000, 'the host gives the lobby up');
    await until(() => joe.state === null, 5000, 'the joiner leaves too');
    assert.ok(logs.some((s) => s.includes('keeps crashing')), logs.slice(-5).join('\n'));
    // the relay is gone with the lobby
    const late = client(relayUrl);
    open.push(late);
    await assert.rejects(late.open);
  } catch (err) {
    console.log(logs.join('\n'));
    throw err;
  } finally {
    for (const c of open) closeQuietly(c);
    await Promise.all([host.shutdown(), joe.shutdown()]);
    for (const c of spawned) c.kill();
  }
});

test('6v6: a joiner arriving mid-match gets a unit and snapshots; a new page connection mid-match takes the same unit back', { timeout: 60_000 }, async (t) => {
  const [hostB, joeB] = await players(['Host', 'Joe']);
  const spawned: ChildHandle[] = [];
  const host = new DesktopBridge({ backend: hostB, spawnServer: nodeSpawner(SERVER_SOURCE, spawned), dataDir: tempDir('host'), log: () => {}, leaveFlushMs: 0 });
  const joe = new DesktopBridge({ backend: joeB, spawnServer: noServer, dataDir: tempDir('joe'), log: () => {} });
  const open: TestClient[] = [];
  try {
    const hosted = await host.hostLobby({ name: 'Mid match', maxMembers: 2 * MAX_TEAM_SIZE, isPrivate: false });
    const hc = client(hosted.url);
    open.push(hc);
    await hc.open;
    hello(hc, 'Host');
    await hc.wait('welcome');
    hc.send({ t: 'createRoom', name: 'Mid', isPrivate: false, config: { ...DEFAULT_CONFIG, teamSize: MAX_TEAM_SIZE, botFill: true } });
    const code = (await hc.wait('room')).room.code;
    hc.send({ t: 'start' });
    await hc.wait('s', (m) => !!m.s.you, 8000);

    // the match is running; Joe joins the lobby and the room now
    const { url } = await joe.joinLobby(hosted.lobbyId);
    const c1 = client(url);
    open.push(c1);
    await c1.open;
    hello(c1, 'Joe');
    await c1.wait('welcome');
    c1.send({ t: 'joinRoom', code });
    const start = (await c1.wait('start', () => true, 8000)).m;
    assert.ok(start.you > 0, 'a unit, not a spectator seat');
    assert.ok(start.tick > 0, 'a mid-match start');
    assert.ok(start.rejoin, 'a rejoin token');
    await c1.wait('s', (m) => m.s.you?.id === start.you, 8000);

    // the page reconnects (a reload): the relay replaces the old connection, the token reclaims the unit
    const replaced = c1.closed;
    const c2 = client(url);
    open.push(c2);
    await c2.open;
    assert.equal((await replaced).code, REPLACED_CODE);
    hello(c2, 'Joe');
    await c2.wait('welcome');
    c2.send({ t: 'joinRoom', code, rejoin: start.rejoin });
    const again = (await c2.wait('start', () => true, 8000)).m;
    assert.equal(again.you, start.you, 'the same unit');
    await c2.wait('s', (m) => m.s.you?.id === start.you, 8000);
    assert.equal(host.hostRelay!.stats()[0].conns, 1, 'one server connection for Joe, the old one is closed');

    // what one joiner costs the host's upload in a full 6v6 (11 others on the field, bots included)
    const relay = host.hostRelay!;
    const out0 = relay.stats()[0].bytesOut;
    const raw0 = c2.bytes();
    const t0 = Date.now();
    await sleep(2000);
    const secs = (Date.now() - t0) / 1000;
    const wire = (relay.stats()[0].bytesOut - out0) / secs;
    const raw = (c2.bytes() - raw0) / secs;
    t.diagnostic(`6v6, host -> one joiner: ${(wire / 1024).toFixed(1)} KB/s on the P2P wire (${(raw / 1024).toFixed(1)} KB/s raw); a full lobby of 11 joiners: about ${((11 * wire) / 1024).toFixed(0)} KB/s of host upload`);
    assert.ok(wire > 0 && wire < 32 * 1024, `${wire} B/s`);
  } finally {
    for (const c of open) closeQuietly(c);
    await Promise.all([host.shutdown(), joe.shutdown()]);
    for (const c of spawned) c.kill();
  }
});

test('two lobbies at once: no packets cross between them; a host who joins another lobby ends its own', { timeout: 60_000 }, async () => {
  const [annB, bobB, ajB, bjB] = await players(['Ann', 'Bob', 'AnnsFriend', 'BobsFriend']);
  const spawned: ChildHandle[] = [];
  const mkHost = (b: FakeSteamBackend) => new DesktopBridge({ backend: b, spawnServer: nodeSpawner(SERVER_SOURCE, spawned), dataDir: tempDir('host'), log: () => {}, leaveFlushMs: 50 });
  const ann = mkHost(annB);
  const bob = mkHost(bobB);
  const aj = new DesktopBridge({ backend: ajB, spawnServer: noServer, dataDir: tempDir('aj'), log: () => {} });
  const bj = new DesktopBridge({ backend: bjB, spawnServer: noServer, dataDir: tempDir('bj'), log: () => {} });
  const open: TestClient[] = [];
  const page = async (url: string, name: string, server: string) => {
    const c = client(url);
    open.push(c);
    await c.open;
    hello(c, name);
    assert.equal((await c.wait('welcome', () => true, 8000)).serverName, server, `${name} reached the wrong server`);
    return c;
  };
  try {
    const [la, lb] = await Promise.all([ann.hostLobby({ name: 'Lobby A', maxMembers: 4, isPrivate: false }), bob.hostLobby({ name: 'Lobby B', maxMembers: 4, isPrivate: false })]);
    const listed = (await aj.listLobbies()).map((l) => l.id).sort();
    assert.deepEqual(listed, [la.lobbyId, lb.lobbyId].sort(), 'both lobbies are listed');
    const ua = (await aj.joinLobby(la.lobbyId)).url;
    const ub = (await bj.joinLobby(lb.lobbyId)).url;
    const ca = await page(ua, 'AnnsFriend', 'Lobby A');
    const cb = await page(ub, 'BobsFriend', 'Lobby B');

    // A's member talks to B's host directly: B ignores it (not in B's lobby)
    const bobRelay = bob.hostRelay!;
    ajB.sendPacket(bobB.me().steamId, encodeFrame(FrameType.Open, 9));
    ajB.sendPacket(bobB.me().steamId, encodeData(9, Buffer.from('{"t":"listRooms"}')));
    // B's host sends garbage to A's member: A's relay hears only its own host, so it does not end
    bobB.sendPacket(ajB.me().steamId, Buffer.from('not a frame at all'));
    await sleep(300);
    assert.deepEqual(bobRelay.stats().map((p) => p.steamId), [bjB.me().steamId], "B's relay serves only B's member");
    assert.ok(aj.state, "A's member is still in lobby A");
    ca.send({ t: 'listRooms' });
    await ca.wait('rooms', () => true, 3000); // A's page still works
    cb.send({ t: 'listRooms' });
    await cb.wait('rooms', () => true, 3000);

    // Ann joins lobby B: lobby A ends for her friend (4000), her server stops, she is a member of B
    const annServer = la.url;
    const aClosed = ca.closed;
    const ub2 = (await ann.joinLobby(lb.lobbyId)).url;
    const r = await aClosed;
    assert.equal(r.code, HOST_LEFT_CODE);
    assert.equal(ann.state?.kind, 'member');
    assert.equal(ann.state?.lobbyId, lb.lobbyId);
    assert.equal(await probeServer(annServer, 'Lobby A', 500), false, "Ann's server stopped");
    await until(() => aj.state === null, 3000, "A's member leaves lobby A");
    await page(ub2, 'Ann', 'Lobby B');
    assert.equal(bobRelay.stats().length, 2, 'Bob now relays Ann too');
  } finally {
    for (const c of open) closeQuietly(c);
    await Promise.all([ann.shutdown(), bob.shutdown(), aj.shutdown(), bj.shutdown()]);
    for (const c of spawned) c.kill();
  }
});

