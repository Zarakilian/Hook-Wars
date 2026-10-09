// The host relay on its own: it sends the relay headers, the real game server keys relayed players by
// SteamID only with the right secret, and members who break the frame rules are dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import { defaultProfile } from '../../shared/protocol.ts';
import { loadConfig } from '../../server/config.ts';
import { GameServer } from '../../server/gameServer.ts';
import { createNullEconomy } from '../../server/economy/api.ts';
import { RELAY_PEER_HEADER, RELAY_SECRET_HEADER } from '../src/constants.ts';
import { FrameType, HOST_TO_JOINER, closeInfo, decodeFrame, encodeData, encodeFrame, encodeClose, type Frame } from '../src/framing.ts';
import { DROP_COOLDOWN_MS, HostRelay, MAX_CONNS_PER_PEER } from '../src/hostRelay.ts';
import { StreamInflater } from '../src/streamCodec.ts';
import { sleep, until } from './helpers.ts';

const SECRET = 'a'.repeat(32) + 'B-_9'.repeat(4);
const MEMBER = '76561190000000011';
const MEMBER2 = '76561190000000022';
const STRANGER = '76561190000000099';

/** What one remote member sees: the host's frames, with Data inflated per connection. */
class FakeJoiner {
  readonly frames: Frame[] = [];
  readonly texts = new Map<number, string[]>();
  private readonly inflaters = new Map<number, StreamInflater>();
  private chain: Promise<void> = Promise.resolve();

  take(packet: Buffer): void {
    const d = decodeFrame(packet, HOST_TO_JOINER);
    assert.ok(d.ok, d.ok ? '' : d.reason);
    const f = d.frame;
    this.chain = this.chain.then(async () => {
      this.frames.push(f);
      if (f.type !== FrameType.Data) return;
      let inf = this.inflaters.get(f.conn);
      if (!inf) this.inflaters.set(f.conn, (inf = new StreamInflater()));
      const bytes = f.deflated ? await inf.inflate(f.payload, HOST_TO_JOINER.maxMessage) : f.payload;
      assert.ok(bytes);
      const list = this.texts.get(f.conn) ?? [];
      list.push(bytes.toString());
      this.texts.set(f.conn, list);
    });
  }

  messages(conn: number): { t: string; [k: string]: unknown }[] {
    return (this.texts.get(conn) ?? []).map((s) => JSON.parse(s));
  }

  closes(conn: number) {
    return this.frames.filter((f) => f.type === FrameType.Close && f.conn === conn).map((f) => closeInfo(f)!);
  }

  done(): void {
    for (const i of this.inflaters.values()) i.close();
  }
}

function relayTo(url: string, opts: { secret?: string; members?: string[]; now?: () => number } = {}) {
  const joiners = new Map<string, FakeJoiner>();
  const joiner = (id: string) => {
    let j = joiners.get(id);
    if (!j) joiners.set(id, (j = new FakeJoiner()));
    return j;
  };
  const members = new Set(opts.members ?? [MEMBER, MEMBER2]);
  const logs: string[] = [];
  const relay = new HostRelay({
    serverUrl: url,
    relaySecret: opts.secret ?? SECRET,
    send: (to, p) => {
      joiner(to).take(p);
      return true;
    },
    isMember: (id) => members.has(id),
    now: opts.now,
    log: (s) => logs.push(s),
  });
  return { relay, joiner, members, logs };
}

const helloMsg = (name: string) => Buffer.from(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, profile: { ...defaultProfile(), name } }));

test('relayed connections carry x-hookwars-relay and x-hookwars-peer', async () => {
  const seen: IncomingHttpHeaders[] = [];
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    seen.push(req.headers);
    wss.handleUpgrade(req, socket, head, (ws) => ws.send('{"t":"welcome"}'));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const { relay, joiner } = relayTo(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`);
  try {
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 1));
    await until(() => joiner(MEMBER).texts.get(1)?.length === 1, 2000, 'welcome through the relay');
    assert.equal(seen.length, 1);
    assert.equal(seen[0][RELAY_SECRET_HEADER], SECRET);
    assert.equal(seen[0][RELAY_PEER_HEADER], `steam:${MEMBER}`);
    assert.equal(seen[0]['sec-websocket-extensions'], undefined, 'no permessage-deflate on loopback');
    assert.equal(joiner(MEMBER).frames[0].type, FrameType.Open, 'the open is acknowledged first');
  } finally {
    relay.close('done');
    for (const c of wss.clients) c.terminate();
    http.close();
  }
});

test('the real game server keys relayed players by SteamID, and only with the right secret', async () => {
  const http = createServer();
  const game = new GameServer({ ...loadConfig(), maxPerIp: 1, relaySecret: SECRET }, createNullEconomy());
  game.attach(http, { exclusive: true });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`;
  const good = relayTo(url);
  const bad = relayTo(url, { secret: 'not-the-secret-0123456789' });
  try {
    // two players from 127.0.0.1 with MAX_PER_IP=1: both get in, each counted as their own SteamID
    for (const [id, name] of [
      [MEMBER, 'Joe'],
      [MEMBER2, 'Jill'],
    ]) {
      good.relay.onPacket(id, encodeFrame(FrameType.Open, 1));
      await until(() => good.joiner(id).frames.some((f) => f.type === FrameType.Open), 2000, `${name} open`);
      good.relay.onPacket(id, encodeData(1, helloMsg(name)));
      await until(() => good.joiner(id).messages(1).some((m) => m.t === 'welcome'), 2000, `${name} welcome`);
    }
    // a second connection of the same player is over that player's limit of 1
    good.relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 2));
    await until(() => good.joiner(MEMBER).closes(2).length === 1, 2000, 'refused second connection');
    // with a wrong secret the headers mean nothing: both count as 127.0.0.1, so only the first gets in
    bad.relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 1));
    await until(() => bad.joiner(MEMBER).frames.some((f) => f.type === FrameType.Open), 2000, 'first untrusted open');
    bad.relay.onPacket(MEMBER2, encodeFrame(FrameType.Open, 1));
    await until(() => bad.joiner(MEMBER2).closes(1).length === 1, 2000, 'second untrusted refused');
    assert.equal(game.stats().clients, 3);
  } finally {
    good.relay.close('done');
    bad.relay.close('done');
    game.close();
    http.close();
  }
});

test('frames keep their order: data then the server close, after a version mismatch', async () => {
  const http = createServer();
  const game = new GameServer({ ...loadConfig(), relaySecret: SECRET }, createNullEconomy());
  game.attach(http, { exclusive: true });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const { relay, joiner } = relayTo(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`);
  try {
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 3));
    // data sent before the ack waits in the relay and goes out once the server socket opens
    relay.onPacket(MEMBER, encodeData(3, Buffer.from(JSON.stringify({ t: 'hello', v: 999, profile: defaultProfile() }))));
    await until(() => joiner(MEMBER).closes(3).length === 1, 3000, 'server close');
    const j = joiner(MEMBER);
    assert.equal(j.messages(3)[0].t, 'error');
    const order = j.frames.map((f) => f.type);
    assert.ok(order.lastIndexOf(FrameType.Data) < order.indexOf(FrameType.Close), 'the close overtook the error message');
    assert.deepEqual(j.closes(3)[0], { code: 1000, reason: 'version' });
  } finally {
    relay.close('done');
    game.close();
    http.close();
  }
});

test('non-members are ignored; a malformed packet drops the member, who is ignored for a while', async () => {
  let now = 1_000_000;
  const http = createServer();
  const game = new GameServer({ ...loadConfig(), relaySecret: SECRET }, createNullEconomy());
  game.attach(http, { exclusive: true });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const { relay, joiner, logs } = relayTo(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`, { now: () => now });
  try {
    relay.onPacket(STRANGER, encodeFrame(FrameType.Open, 1));
    relay.onPacket(STRANGER, Buffer.from('garbage'));
    await sleep(100);
    assert.equal(joiner(STRANGER).frames.length, 0, 'a stranger got an answer');
    assert.equal(game.stats().clients, 0);
    assert.ok(logs.some((s) => s.includes('not in the lobby')));

    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 1));
    await until(() => game.stats().clients === 1, 2000, 'member connected');
    relay.onPacket(MEMBER, Buffer.from([0x48, 0x57, 1, 2, 0, 1, 0, 0, 0, 9, 1])); // length mismatch
    await until(() => joiner(MEMBER).frames.some((f) => f.type === FrameType.Bye), 2000, 'bye');
    await until(() => game.stats().clients === 0, 2000, 'their server connection closed');
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 2));
    await sleep(100);
    assert.equal(game.stats().clients, 0, 'ignored during the cooldown');
    now += DROP_COOLDOWN_MS + 1;
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 2));
    await until(() => game.stats().clients === 1, 2000, 'back after the cooldown');
    // too many connections for one member
    for (let c = 3; c <= MAX_CONNS_PER_PEER + 2; c++) relay.onPacket(MEMBER, encodeFrame(FrameType.Open, c));
    await until(() => joiner(MEMBER).closes(MAX_CONNS_PER_PEER + 2).length === 1, 2000, 'limit');
    assert.equal(joiner(MEMBER).closes(MAX_CONNS_PER_PEER + 2)[0].code, 4008);
    // data for a connection that does not exist
    relay.onPacket(MEMBER, encodeData(77, Buffer.from('{}')));
    await until(() => joiner(MEMBER).closes(77).length === 1, 2000, 'unknown connection');
    // the member closes one: the server side closes too
    const before = game.stats().clients;
    relay.onPacket(MEMBER, encodeClose(2, 1000, ''));
    await until(() => game.stats().clients === before - 1, 2000, 'closed on the server');
  } finally {
    relay.close('done');
    game.close();
    http.close();
  }
});

test('closing the relay says Bye to every member and closes their server connections', async () => {
  const http = createServer();
  const game = new GameServer({ ...loadConfig(), relaySecret: SECRET }, createNullEconomy());
  game.attach(http, { exclusive: true });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const { relay, joiner } = relayTo(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`);
  try {
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 1));
    await until(() => game.stats().clients === 1, 2000, 'connected');
    relay.close('The host left the lobby.', [MEMBER, MEMBER2]);
    for (const id of [MEMBER, MEMBER2]) {
      await until(() => joiner(id).frames.some((f) => f.type === FrameType.Bye), 1000, `bye for ${id}`);
      const bye = joiner(id).frames.find((f) => f.type === FrameType.Bye);
      assert.ok(bye, `no bye for ${id}`);
      assert.equal(bye.payload.toString(), 'The host left the lobby.');
    }
    await until(() => game.stats().clients === 0, 2000, 'server connections closed');
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 5));
    await sleep(50);
    assert.equal(game.stats().clients, 0, 'a closed relay opens nothing');
  } finally {
    game.close();
    http.close();
  }
});
