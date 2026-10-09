// FakeSteam, the stand-in for Steam: lobbies, owner hand-over, owner-only metadata, packets with an
// unforgeable sender, the session-accept rule, and the TCP hub that lets windows on one PC meet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { FakeHub, FakeHubServer, FakeSteamBackend, connectOrHostHub, memoryLink, parseToHub, tcpLink } from '../src/fakeSteam.ts';
import { sleep, tempDir, until } from './helpers.ts';

async function player(hub: FakeHub, name: string): Promise<FakeSteamBackend> {
  return FakeSteamBackend.connect({ link: memoryLink(hub), name, cloudDir: tempDir('cloud') });
}

test('lobbies: create, list, join, data is owner-only, the next member owns it when the owner leaves', async () => {
  const hub = new FakeHub();
  const [a, b, c] = await Promise.all([player(hub, 'Ann'), player(hub, 'Bob'), player(hub, 'Cid')]);
  try {
    const id = await a.createLobby('public', 3);
    assert.equal(a.lobbyOwner(id), a.me().steamId);
    assert.ok(a.setLobbyData(id, { game: 'hookwars', name: 'Ann room' }));
    await sleep(5);
    const listed = await b.listLobbies();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].data.name, 'Ann room');
    await b.joinLobby(id);
    await c.joinLobby(id);
    await until(() => a.lobbyMembers(id).length === 3, 1000, 'three members');
    assert.deepEqual(b.lobbyMembers(id), [a.me().steamId, b.me().steamId, c.me().steamId]);
    // full now: not listed, and a fourth cannot join
    const d = await player(hub, 'Dee');
    assert.equal((await d.listLobbies()).length, 0);
    await assert.rejects(d.joinLobby(id), /full/);
    d.close();
    // members cannot change the data
    assert.equal(b.setLobbyData(id, { name: 'hijacked' }), false);
    await sleep(5);
    assert.equal(a.lobbyData(id).name, 'Ann room');
    // the owner leaves: Bob (next to join) owns it
    a.leaveLobby(id);
    await until(() => c.lobbyOwner(id) === b.me().steamId, 1000, 'owner hand-over');
    assert.deepEqual(c.lobbyMembers(id), [b.me().steamId, c.me().steamId]);
  } finally {
    a.close();
    b.close();
    c.close();
  }
});

test('private lobbies are not listed but can be joined by id', async () => {
  const hub = new FakeHub();
  const [a, b] = await Promise.all([player(hub, 'Ann'), player(hub, 'Bob')]);
  try {
    const id = await a.createLobby('private', 4);
    assert.equal((await b.listLobbies()).length, 0);
    await b.joinLobby(id);
    await until(() => b.lobbyOwner(id) === a.me().steamId, 1000, 'lobby state');
    await assert.rejects(b.joinLobby('123456789'), /does not exist/);
  } finally {
    a.close();
    b.close();
  }
});

test('packets: the sender is who the hub says, and they wait for acceptSession', async () => {
  const hub = new FakeHub();
  const [a, b] = await Promise.all([player(hub, 'Ann'), player(hub, 'Bob')]);
  try {
    const got: [string, string][] = [];
    const requests: string[] = [];
    b.on('packet', (from, data) => got.push([from, data.toString()]));
    b.on('sessionRequest', (from) => requests.push(from));
    a.sendPacket(b.me().steamId, Buffer.from('one'));
    a.sendPacket(b.me().steamId, Buffer.from('two'));
    await until(() => requests.length === 1, 1000, 'session request');
    await sleep(10);
    assert.deepEqual(got, [], 'nothing before accept');
    assert.equal(requests.length, 1, 'asked once');
    b.acceptSession(a.me().steamId);
    assert.deepEqual(got, [
      [a.me().steamId, 'one'],
      [a.me().steamId, 'two'],
    ]);
    // replies need no accept: b sent to a first? no, a sent to b, so a takes b's packets directly
    const back: string[] = [];
    a.on('packet', (_f, d) => back.push(d.toString()));
    b.sendPacket(a.me().steamId, Buffer.from('reply'));
    await until(() => back.length === 1, 1000, 'reply');
    // closing the session makes the next packet ask again
    b.closeSession(a.me().steamId);
    a.sendPacket(b.me().steamId, Buffer.from('three'));
    await until(() => requests.length === 2, 1000, 'second request');
  } finally {
    a.close();
    b.close();
  }
});

test('the hub refuses malformed messages and duplicate ids', async () => {
  assert.equal(parseToHub({ op: 'send', to: 'abc', data: '' }), null);
  assert.equal(parseToHub({ op: 'send', to: '1234', data: '***' }), null);
  assert.equal(parseToHub({ op: 'create', rid: 1, visibility: 'public', max: 0 }), null);
  assert.equal(parseToHub({ op: 'setData', lobby: '5', data: { k: 5 } }), null);
  assert.equal(parseToHub({ op: 'nope' }), null);
  assert.ok(parseToHub({ op: 'hello', steamId: '76561190000000001', name: 'x' }));
  const hub = new FakeHub();
  const a = await FakeSteamBackend.connect({ link: memoryLink(hub), steamId: '76561190000000001', cloudDir: tempDir('cloud') });
  try {
    await assert.rejects(FakeSteamBackend.connect({ link: memoryLink(hub), steamId: '76561190000000001', cloudDir: tempDir('cloud') }), /already connected/);
    let kicked = '';
    const h = hub.attach({ deliver: () => {}, kick: (r) => (kicked = r) });
    h.receive({ op: 'send', to: '1', data: 'AA==' }); // before hello
    assert.equal(kicked, 'no hello');
  } finally {
    a.close();
  }
});

test('stand-in Steam Cloud keeps files per profile folder and refuses odd names', async () => {
  const hub = new FakeHub();
  const dir = tempDir('cloud');
  const a = await FakeSteamBackend.connect({ link: memoryLink(hub), cloudDir: dir });
  try {
    assert.equal(a.cloudRead('locker.json'), null);
    assert.equal(a.cloudWrite('locker.json', '{"pearls":12}'), true);
    assert.equal(a.cloudRead('locker.json'), '{"pearls":12}');
    assert.equal(a.cloudWrite('../escape.json', 'x'), false);
    assert.equal(a.cloudRead('..'), null);
  } finally {
    a.close();
  }
});

test('TCP hub: the first window hosts it, the next ones join it, and they exchange packets', async () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const first = await connectOrHostHub(port);
  const second = await connectOrHostHub(port);
  assert.ok(first.server, 'first window runs the hub');
  assert.equal(second.server, null, 'second window joins it');
  const a = await FakeSteamBackend.connect({ link: first.link, server: first.server, name: 'Ann', cloudDir: tempDir('cloud') });
  const b = await FakeSteamBackend.connect({ link: second.link, name: 'Bob', cloudDir: tempDir('cloud') });
  try {
    const id = await a.createLobby('public', 4);
    a.setLobbyData(id, { game: 'hookwars' });
    await sleep(20);
    assert.equal((await b.listLobbies())[0]?.id, id);
    await b.joinLobby(id);
    b.acceptSession(a.me().steamId);
    const got: string[] = [];
    b.on('packet', (_f, d) => got.push(d.toString('hex')));
    const payload = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i & 255));
    a.sendPacket(b.me().steamId, payload);
    await until(() => got.length === 1, 2000, 'packet over TCP');
    assert.equal(got[0], payload.toString('hex'));
    // garbage on the socket gets that socket dropped, not the hub
    const junk = createConnection({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => junk.once('connect', () => r()));
    junk.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 2, 3]));
    await new Promise<void>((r) => junk.once('close', () => r()));
    assert.ok((await b.listLobbies()).length >= 0, 'hub still answers');
    // the window that hosts the hub quits: the others hear about it
    let lost = '';
    b.on('disconnected', (r) => (lost = r));
    a.close();
    await until(() => lost !== '', 2000, 'hub loss');
  } finally {
    a.close();
    b.close();
    await first.server?.close();
  }
});

test('tcpLink fails fast when no hub listens', async () => {
  const srv = new FakeHubServer();
  const port = await srv.listen(0);
  await srv.close();
  await assert.rejects(tcpLink(port));
});
