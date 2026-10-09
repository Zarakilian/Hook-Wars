// The whole Steam lobby path on one machine, with FakeSteam where Steam would be: the host runs the
// real game server (server/index.ts, ECONOMY=trust) and a host relay; two joiners run their local
// relays; two game clients connect through the joiner relays and one straight to the host's server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../../shared/constants.ts';
import { DesktopBridge } from '../src/desktopBridge.ts';
import { FakeHub, FakeSteamBackend, memoryLink } from '../src/fakeSteam.ts';
import { FrameType, encodeData, encodeFrame } from '../src/framing.ts';
import { HOST_LEFT_CODE } from '../src/joinerRelay.ts';
import { probeServer, type ChildHandle, type SpawnServer } from '../src/serverLauncher.ts';
import { SERVER_SOURCE, client, closeQuietly, hello, nodeSpawner, sleep, tempDir, until, type TestClient } from './helpers.ts';

const noServer: SpawnServer = () => {
  throw new Error('a joiner never starts a server');
};

test('two joiners over FakeSteam P2P and the host page play one match on the host server; the host leaving ends the joiners cleanly', { timeout: 60_000 }, async (t) => {
  const hub = new FakeHub();
  const mk = (name: string) => FakeSteamBackend.connect({ link: memoryLink(hub), name, cloudDir: tempDir('cloud') });
  const [hostB, joeB, jillB, strangerB] = await Promise.all([mk('Host'), mk('Joe'), mk('Jill'), mk('Stranger')]);
  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  const spawned: ChildHandle[] = [];
  const host = new DesktopBridge({ backend: hostB, spawnServer: nodeSpawner(SERVER_SOURCE, spawned), dataDir: tempDir('host'), log, leaveFlushMs: 50 });
  const joe = new DesktopBridge({ backend: joeB, spawnServer: noServer, dataDir: tempDir('joe'), log });
  const jill = new DesktopBridge({ backend: jillB, spawnServer: noServer, dataDir: tempDir('jill'), log });
  let hc: TestClient | null = null;
  let c1: TestClient | null = null;
  let c2: TestClient | null = null;
  try {
    // --- host: server + lobby, the host's own page connects straight to the server
    const hosted = await host.hostLobby({ name: 'Relay test', maxMembers: 4, isPrivate: false });
    assert.match(hosted.url, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    hc = client(hosted.url);
    await hc.open;
    hello(hc, 'Host');
    assert.equal((await hc.wait('welcome')).serverName, 'Relay test');
    hc.send({ t: 'createRoom', name: 'Relay room', isPrivate: false, config: { ...DEFAULT_CONFIG, teamSize: 2 } });
    const code = (await hc.wait('room')).room.code;
    await host.setLobbyInfo({ room: code, phase: 'lobby', humans: '1' });

    // --- joiners: find the lobby in the browser, join, connect their pages to the local relay
    await sleep(20);
    const listed = await joe.listLobbies();
    const mine = listed.find((l) => l.id === hosted.lobbyId);
    assert.ok(mine, 'the lobby is listed');
    assert.equal(mine.info.room, code);
    assert.equal(mine.host, 'Host');
    assert.equal(mine.name, 'Relay test');
    const u1 = (await joe.joinLobby(hosted.lobbyId)).url;
    const u2 = (await jill.joinLobby(hosted.lobbyId)).url;
    assert.match(u1, /^ws:\/\/127\.0\.0\.1:\d+\/ws\/[0-9a-f]{48}$/);
    assert.equal((await joe.joinLobby(hosted.lobbyId)).url, u1, 'joining again: same relay');
    c1 = client(u1);
    c2 = client(u2);
    await Promise.all([c1.open, c2.open]);
    hello(c1, 'Joe');
    hello(c2, 'Jill');
    const w1 = await c1.wait('welcome');
    const w2 = await c2.wait('welcome');
    assert.notEqual(w1.id, w2.id);
    assert.equal((await c1.wait('econError')).code, 'local_only');
    c1.send({ t: 'joinRoom', code });
    c2.send({ t: 'joinRoom', code });
    await hc.wait('room', (m) => m.room.players.length === 3);

    // --- the match: everyone gets the start and snapshots
    hc.send({ t: 'start' });
    const [s1, s2] = await Promise.all([c1.wait('start'), c2.wait('start'), hc.wait('start')]);
    assert.equal(s1.m.you, w1.id);
    assert.equal(s2.m.you, w2.id);
    await Promise.all([c1.wait('s', (m) => !!m.s.you), c2.wait('s', (m) => !!m.s.you), hc.wait('s', (m) => !!m.s.you)]);
    // inputs from a joiner reach the server (its snapshot acks them)
    for (let i = 1; i <= 20; i++) c1.send({ t: 'input', i: { seq: i, mx: 1, mz: 0, ax: 0, az: 0, b: 0 } });
    await c1.wait('s', (m) => (m.s.you?.ack ?? 0) >= 10, 8000);

    // --- bandwidth per joiner over P2P (frames on the wire) against the raw messages the page got
    const relay = host.hostRelay!;
    const before = new Map(relay.stats().map((p) => [p.steamId, p.bytesOut]));
    const raw0 = c2.bytes();
    const t0 = Date.now();
    await sleep(2000);
    const secs = (Date.now() - t0) / 1000;
    const jillStats = relay.stats().find((p) => p.steamId === jillB.me().steamId)!;
    const wire = (jillStats.bytesOut - (before.get(jillB.me().steamId) ?? 0)) / secs;
    const raw = (c2.bytes() - raw0) / secs;
    t.diagnostic(`host -> one joiner, 2v2 with bots: ${(wire / 1024).toFixed(1)} KB/s on the P2P wire, ${(raw / 1024).toFixed(1)} KB/s of raw messages (${(raw / wire).toFixed(1)}x deflate)`);
    assert.ok(wire < raw, 'per-message deflate shrinks the stream');

    // --- a stranger (not in the lobby) is ignored: no reply, no server connection
    const strangerGot: Buffer[] = [];
    strangerB.on('packet', (_f, d) => strangerGot.push(d));
    strangerB.on('sessionRequest', (f) => strangerB.acceptSession(f));
    strangerB.sendPacket(hostB.me().steamId, encodeFrame(FrameType.Open, 1));
    strangerB.sendPacket(hostB.me().steamId, encodeData(1, Buffer.from(JSON.stringify({ t: 'listRooms' }))));
    await sleep(300);
    assert.equal(strangerGot.length, 0, 'the host answered a non-member');
    assert.ok(!relay.stats().some((p) => p.steamId === strangerB.me().steamId), 'the host opened a connection for a non-member');
    assert.equal(relay.stats().length, 2);

    // --- the host leaves: both joiner pages close with "host left", the server stops
    const [k1, k2] = [c1.closed, c2.closed];
    await host.leaveLobby();
    const [r1, r2] = await Promise.all([k1, k2]);
    assert.equal(r1.code, HOST_LEFT_CODE);
    assert.match(r1.reason, /host left/i);
    assert.equal(r2.code, HOST_LEFT_CODE);
    await until(() => joe.state === null && jill.state === null, 2000, 'joiners leave the lobby');
    assert.equal(host.state, null);
    assert.equal(await probeServer(hosted.url, 'Relay test', 500), false, 'the host server stopped');
    // the joiner relay is gone too: a reconnecting page is refused
    const late = client(u1);
    await assert.rejects(late.open);
  } finally {
    closeQuietly(hc);
    closeQuietly(c1);
    closeQuietly(c2);
    await Promise.all([host.shutdown(), joe.shutdown(), jill.shutdown()]);
    strangerB.close();
    for (const c of spawned) c.kill();
  }
});

test('a joiner leaving frees its server connection at once; another member can still play', { timeout: 40_000 }, async () => {
  const hub = new FakeHub();
  const mk = (name: string) => FakeSteamBackend.connect({ link: memoryLink(hub), name, cloudDir: tempDir('cloud') });
  const [hostB, joeB] = await Promise.all([mk('Host'), mk('Joe')]);
  const spawned: ChildHandle[] = [];
  const host = new DesktopBridge({ backend: hostB, spawnServer: nodeSpawner(SERVER_SOURCE, spawned), dataDir: tempDir('host'), log: () => {}, leaveFlushMs: 0 });
  const joe = new DesktopBridge({ backend: joeB, spawnServer: noServer, dataDir: tempDir('joe'), log: () => {} });
  let c: TestClient | null = null;
  try {
    const hosted = await host.hostLobby({ name: 'Leave test', maxMembers: 2, isPrivate: true });
    const { url } = await joe.joinLobby(hosted.lobbyId);
    c = client(url);
    await c.open;
    hello(c, 'Joe');
    await c.wait('welcome');
    await until(() => host.hostRelay!.stats()[0]?.conns === 1, 2000, 'relayed connection');
    const closed = c.closed;
    await joe.leaveLobby();
    const r = await closed;
    assert.equal(r.code, 1000);
    await until(() => host.hostRelay!.stats().length === 0, 2000, 'host drops the leaver');
    assert.equal(joe.state, null);
  } finally {
    closeQuietly(c);
    await Promise.all([host.shutdown(), joe.shutdown()]);
    for (const s of spawned) s.kill();
  }
});
