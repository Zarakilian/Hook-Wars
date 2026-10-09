// Lobbies through the LobbyManager (FakeSteam underneath): the metadata every Hook Wars lobby carries,
// the game and version filters (app 480 is shared with every developer), and the host leaving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOBBY_VERSION_VALUE } from '../src/constants.ts';
import { FakeHub, FakeSteamBackend, memoryLink } from '../src/fakeSteam.ts';
import { LobbyError, LobbyManager } from '../src/lobbyManager.ts';
import { sleep, tempDir, until } from './helpers.ts';

const mk = (hub: FakeHub, name: string) => FakeSteamBackend.connect({ link: memoryLink(hub), name, cloudDir: tempDir('cloud') });

test('create writes the Hook Wars metadata; list shows only Hook Wars lobbies of this version', async () => {
  const hub = new FakeHub();
  const [hostB, otherDevB, oldB, viewerB] = await Promise.all([mk(hub, 'Host'), mk(hub, 'SpacewarDev'), mk(hub, 'Old'), mk(hub, 'Viewer')]);
  const host = new LobbyManager(hostB);
  const viewer = new LobbyManager(viewerB);
  try {
    const cur = await host.create({ name: 'Fishing trip', maxMembers: 12, isPrivate: false });
    assert.equal(cur.role, 'host');
    await sleep(5);
    const data = hostB.lobbyData(cur.id);
    assert.deepEqual(data, { game: 'hookwars', v: LOBBY_VERSION_VALUE, name: 'Fishing trip', host: 'Host', max: '10', phase: 'lobby' });
    assert.equal(hostB.lobbyMemberLimit(cur.id), 10, 'clamped to 5v5');
    // somebody else's Spacewar lobby, and a Hook Wars lobby of another version
    const foreign = await otherDevB.createLobby('public', 4);
    otherDevB.setLobbyData(foreign, { game: 'spacewar' });
    const old = await oldB.createLobby('public', 4);
    oldB.setLobbyData(old, { game: 'hookwars', v: '1' });
    await sleep(5);
    const list = await viewer.list();
    assert.deepEqual(list.map((l) => l.id), [cur.id]);
    assert.equal(list[0].name, 'Fishing trip');
    assert.equal(list[0].host, 'Host');
    assert.equal(list[0].members, 1);
    assert.equal(list[0].max, 10);
    // joining either of the others is refused, and leaves that lobby again
    await assert.rejects(viewer.join(foreign), (e: LobbyError) => e.code === 'not_hookwars');
    await assert.rejects(viewer.join(old), (e: LobbyError) => e.code === 'version');
    await until(() => otherDevB.lobbyMembers(foreign).length === 1 && oldB.lobbyMembers(old).length === 1, 1000, 'left again');
    assert.equal(viewer.current, null);
  } finally {
    host.dispose();
    viewer.dispose();
    for (const b of [hostB, otherDevB, oldB, viewerB]) b.close();
  }
});

test('publish: host only, and the reserved keys stay as the app set them', async () => {
  const hub = new FakeHub();
  const [hostB, joeB] = await Promise.all([mk(hub, 'Host'), mk(hub, 'Joe')]);
  const host = new LobbyManager(hostB);
  const joe = new LobbyManager(joeB);
  try {
    const { id } = await host.create({ name: 'Room', maxMembers: 4, isPrivate: false });
    assert.equal(host.publish({ room: 'ABCDE', map: 'coral', game: 'evil', v: '0', host: 'Mallory' }), true);
    await sleep(5);
    const d = hostB.lobbyData(id);
    assert.equal(d.room, 'ABCDE');
    assert.equal(d.game, 'hookwars');
    assert.equal(d.v, LOBBY_VERSION_VALUE);
    assert.equal(d.host, 'Host');
    await joe.join(id);
    assert.equal(joe.publish({ room: 'ZZZZZ' }), false, 'a member cannot publish');
  } finally {
    host.dispose();
    joe.dispose();
    hostB.close();
    joeB.close();
  }
});

test('a private lobby is not in the Steam list, but the one you are in is listed for you', async () => {
  const hub = new FakeHub();
  const [hostB, joeB] = await Promise.all([mk(hub, 'Host'), mk(hub, 'Joe')]);
  const host = new LobbyManager(hostB);
  const joe = new LobbyManager(joeB);
  try {
    const { id } = await host.create({ name: 'Friends only', maxMembers: 4, isPrivate: true });
    host.publish({ room: 'QWERT' });
    await sleep(5);
    assert.equal((await joe.list()).length, 0);
    await joe.join(id);
    const mine = await joe.list();
    assert.equal(mine.length, 1);
    assert.equal(mine[0].info.room, 'QWERT', 'an invited player can read the room code');
    assert.equal(mine[0].members, 2);
  } finally {
    host.dispose();
    joe.dispose();
    hostB.close();
    joeB.close();
  }
});

test('the host leaving is "host left" for members, even though Steam hands the lobby to one of them', async () => {
  const hub = new FakeHub();
  const [hostB, joeB, jillB] = await Promise.all([mk(hub, 'Host'), mk(hub, 'Joe'), mk(hub, 'Jill')]);
  const joined: string[] = [];
  const left: string[] = [];
  const host = new LobbyManager(hostB, { onMemberJoined: (id) => joined.push(id), onMemberLeft: (id) => left.push(id) });
  const hostLeft: string[] = [];
  const joe = new LobbyManager(joeB, { onHostLeft: (r) => hostLeft.push(`joe: ${r}`) });
  const jill = new LobbyManager(jillB, { onHostLeft: (r) => hostLeft.push(`jill: ${r}`) });
  try {
    const { id } = await host.create({ name: 'Room', maxMembers: 4, isPrivate: false });
    await joe.join(id);
    await jill.join(id);
    await until(() => joined.length === 2, 1000, 'joins seen by the host');
    assert.equal(host.isMember(joeB.me().steamId), true);
    jill.leave();
    await until(() => left.length === 1, 1000, 'leave seen by the host');
    assert.deepEqual(left, [jillB.me().steamId]);
    await jill.join(id);
    host.leave();
    await until(() => hostLeft.length === 2, 1000, 'both members told');
    assert.ok(hostLeft.every((s) => s.endsWith('The host left the lobby.')));
    assert.equal(joe.current, null);
    assert.equal(jill.current, null);
  } finally {
    host.dispose();
    joe.dispose();
    jill.dispose();
    for (const b of [hostB, joeB, jillB]) b.close();
  }
});
