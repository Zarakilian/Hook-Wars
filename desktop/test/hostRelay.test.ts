// The host relay on its own: it sends the relay headers, the real game server keys relayed players by
// SteamID only with the right secret, and members who break the frame rules are dropped.
//
// Every test ends with nothing of its own still running: the relay is closed first (no frame goes out
// after that), then the game server, then each of the relay's server connections is awaited until it is
// closed, then each fake joiner inflates what it was sent and closes its inflate streams, and last the
// HTTP server's sockets are destroyed and its close is awaited. Anything a joiner could not take or
// inflate is recorded and asserted inside the test, never thrown from a callback after the test ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import { defaultProfile } from '../../shared/protocol.ts';
import { loadConfig } from '../../server/config.ts';
import { GameServer } from '../../server/gameServer.ts';
import { createNullEconomy } from '../../server/economy/api.ts';
import { RELAY_PEER_HEADER, RELAY_SECRET_HEADER } from '../src/constants.ts';
import { FrameType, HOST_TO_JOINER, closeInfo, decodeFrame, encodeData, encodeFrame, encodeClose, type Frame } from '../src/framing.ts';
import { DROP_COOLDOWN_MS, HostRelay, MAX_CONNS_PER_PEER, PEER_PACKET_BURST, PEER_PACKET_RATE, type WsFactory } from '../src/hostRelay.ts';
import { StreamInflater } from '../src/streamCodec.ts';
import { sleep, until } from './helpers.ts';

const SECRET = 'a'.repeat(32) + 'B-_9'.repeat(4);
const MEMBER = '76561190000000011';
const MEMBER2 = '76561190000000022';
const STRANGER = '76561190000000099';

/**
 * What one remote member sees: the host's frames, with Data inflated per connection. take() runs inside
 * the relay's callbacks, so it never throws: a frame it cannot decode or inflate is recorded in `errors`
 * (each test asserts that list is empty), and its inflate chain never rejects.
 */
class FakeJoiner {
  readonly frames: Frame[] = [];
  readonly texts = new Map<number, string[]>();
  readonly errors: string[] = [];
  private readonly inflaters = new Map<number, StreamInflater>();
  private chain: Promise<void> = Promise.resolve();
  private finished = false;

  take(packet: Buffer): void {
    if (this.finished) {
      this.errors.push('a frame arrived after the test closed the relay');
      return;
    }
    const d = decodeFrame(packet, HOST_TO_JOINER);
    if (!d.ok) {
      this.errors.push(`a frame the joiner cannot decode: ${d.reason}`);
      return;
    }
    const f = d.frame;
    this.chain = this.chain
      .then(async () => {
        this.frames.push(f);
        if (f.type !== FrameType.Data) return;
        let inf = this.inflaters.get(f.conn);
        if (!inf) this.inflaters.set(f.conn, (inf = new StreamInflater()));
        const bytes = f.deflated ? await inf.inflate(f.payload, HOST_TO_JOINER.maxMessage) : f.payload;
        if (!bytes) {
          this.errors.push(`a Data frame on connection ${f.conn} did not inflate`);
          return;
        }
        const list = this.texts.get(f.conn) ?? [];
        list.push(bytes.toString());
        this.texts.set(f.conn, list);
      })
      .catch((err: unknown) => {
        this.errors.push(String(err));
      });
  }

  messages(conn: number): { t: string; [k: string]: unknown }[] {
    return (this.texts.get(conn) ?? []).map((s) => JSON.parse(s));
  }

  closes(conn: number) {
    return this.frames.filter((f) => f.type === FrameType.Close && f.conn === conn).map((f) => closeInfo(f)!);
  }

  /**
   * End of the test (after the relay is closed, so nothing more arrives): inflate every frame already
   * taken, in order, then close the inflate streams. Closing them first would turn a frame still
   * queued into a failed inflate after the test ended.
   */
  async finish(): Promise<void> {
    this.finished = true;
    await this.chain;
    for (const i of this.inflaters.values()) i.close();
    this.inflaters.clear();
  }
}

/** An HTTP server on a free loopback port that keeps its sockets (upgraded ones too), so stop() really ends it. */
async function loopback(): Promise<{ http: Server; url: string; stop(): Promise<void> }> {
  const http = createServer();
  const sockets = new Set<Socket>();
  http.on('connection', (s: Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`;
  return {
    http,
    url,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

/**
 * The relay's connections to the local server, recorded: the same sockets its default factory makes
 * (loopback, no permessage-deflate, the host-to-joiner message cap), so closed() can wait for each one.
 */
function serverSockets(): { factory: WsFactory; closed(): Promise<void> } {
  const list: WebSocket[] = [];
  return {
    factory: (url, headers) => {
      const ws = new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: HOST_TO_JOINER.maxMessage });
      list.push(ws);
      return ws;
    },
    closed: async () => {
      await Promise.all(
        list.map((ws) => {
          if (ws.readyState === WebSocket.CLOSED) return undefined;
          // a socket still opening or still closing is cut now: its 'close' always follows
          const gone = new Promise<void>((r) => ws.once('close', () => r()));
          ws.terminate();
          return gone;
        }),
      );
    },
  };
}

/**
 * A relay to `url` with a fake joiner per member. finish() is the teardown: close the relay, wait until
 * every server connection it opened is closed (call it after the game server is closed), then drain and
 * close every joiner. errors() is what the joiners could not take. defaultSockets keeps the relay's own
 * socket factory (the header test checks what it sends); its sockets then close with the test server.
 */
function relayTo(url: string, opts: { secret?: string; members?: string[]; now?: () => number; defaultSockets?: boolean } = {}) {
  const joiners = new Map<string, FakeJoiner>();
  const joiner = (id: string) => {
    let j = joiners.get(id);
    if (!j) joiners.set(id, (j = new FakeJoiner()));
    return j;
  };
  const members = new Set(opts.members ?? [MEMBER, MEMBER2]);
  const logs: string[] = [];
  const sockets = opts.defaultSockets ? null : serverSockets();
  const relay = new HostRelay({
    serverUrl: url,
    relaySecret: opts.secret ?? SECRET,
    send: (to, p) => {
      joiner(to).take(p);
      return true;
    },
    isMember: (id) => members.has(id),
    wsFactory: sockets?.factory,
    now: opts.now,
    log: (s) => logs.push(s),
  });
  const finish = async () => {
    relay.close('done');
    await sockets?.closed();
    await Promise.all([...joiners.values()].map((j) => j.finish()));
  };
  const errors = () => [...joiners.values()].flatMap((j) => j.errors);
  return { relay, joiner, members, logs, finish, errors };
}

const helloMsg = (name: string) => Buffer.from(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, profile: { ...defaultProfile(), name } }));

test('relayed connections carry x-hookwars-relay and x-hookwars-peer', async () => {
  const seen: IncomingHttpHeaders[] = [];
  const srv = await loopback();
  const wss = new WebSocketServer({ noServer: true });
  const served: WebSocket[] = [];
  srv.http.on('upgrade', (req, socket, head) => {
    seen.push(req.headers);
    wss.handleUpgrade(req, socket, head, (ws) => {
      served.push(ws);
      ws.send('{"t":"welcome"}');
    });
  });
  // the relay's own socket factory: this test checks what it sends (no permessage-deflate on loopback)
  const { relay, joiner, finish, errors } = relayTo(srv.url, { defaultSockets: true });
  try {
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 1));
    await until(() => joiner(MEMBER).texts.get(1)?.length === 1, 5000, 'welcome through the relay');
    assert.equal(seen.length, 1);
    assert.equal(seen[0][RELAY_SECRET_HEADER], SECRET);
    assert.equal(seen[0][RELAY_PEER_HEADER], `steam:${MEMBER}`);
    assert.equal(seen[0]['sec-websocket-extensions'], undefined, 'no permessage-deflate on loopback');
    assert.equal(joiner(MEMBER).frames[0].type, FrameType.Open, 'the open is acknowledged first');
  } finally {
    // the server ends the relayed socket; the relay tells the joiner (Close on connection 1) only once its
    // own socket has closed, so after that wait nothing of that socket is left to run
    for (const ws of served) ws.terminate();
    if (served.length) await until(() => joiner(MEMBER).closes(1).length === 1, 5000, 'the relay saw its socket close').catch(() => {});
    await finish();
    await new Promise<void>((r) => wss.close(() => r()));
    await srv.stop();
  }
  assert.deepEqual(errors(), []);
});

test('the real game server keys relayed players by SteamID, and only with the right secret', async () => {
  const srv = await loopback();
  const game = new GameServer({ ...loadConfig(), maxPerIp: 1, relaySecret: SECRET }, createNullEconomy());
  game.attach(srv.http, { exclusive: true });
  const good = relayTo(srv.url);
  const bad = relayTo(srv.url, { secret: 'not-the-secret-0123456789' });
  try {
    // two players from 127.0.0.1 with MAX_PER_IP=1: both get in, each counted as their own SteamID
    for (const [id, name] of [
      [MEMBER, 'Joe'],
      [MEMBER2, 'Jill'],
    ]) {
      good.relay.onPacket(id, encodeFrame(FrameType.Open, 1));
      await until(() => good.joiner(id).frames.some((f) => f.type === FrameType.Open), 5000, `${name} open`);
      good.relay.onPacket(id, encodeData(1, helloMsg(name)));
      await until(() => good.joiner(id).messages(1).some((m) => m.t === 'welcome'), 5000, `${name} welcome`);
    }
    // a second connection of the same player is over that player's limit of 1
    good.relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 2));
    await until(() => good.joiner(MEMBER).closes(2).length === 1, 5000, 'refused second connection');
    // with a wrong secret the headers mean nothing: both count as 127.0.0.1, so only the first gets in
    bad.relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 1));
    await until(() => bad.joiner(MEMBER).frames.some((f) => f.type === FrameType.Open), 5000, 'first untrusted open');
    bad.relay.onPacket(MEMBER2, encodeFrame(FrameType.Open, 1));
    await until(() => bad.joiner(MEMBER2).closes(1).length === 1, 5000, 'second untrusted refused');
    assert.equal(game.stats().clients, 3);
  } finally {
    game.close();
    await good.finish();
    await bad.finish();
    await srv.stop();
  }
  assert.deepEqual([...good.errors(), ...bad.errors()], []);
});

test('frames keep their order: data then the server close, after a version mismatch', async () => {
  const srv = await loopback();
  const game = new GameServer({ ...loadConfig(), relaySecret: SECRET }, createNullEconomy());
  game.attach(srv.http, { exclusive: true });
  const { relay, joiner, finish, errors } = relayTo(srv.url);
  try {
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 3));
    // data sent before the ack waits in the relay and goes out once the server socket opens
    relay.onPacket(MEMBER, encodeData(3, Buffer.from(JSON.stringify({ t: 'hello', v: 999, profile: defaultProfile() }))));
    await until(() => joiner(MEMBER).closes(3).length === 1, 5000, 'server close');
    const j = joiner(MEMBER);
    assert.equal(j.messages(3)[0].t, 'error');
    const order = j.frames.map((f) => f.type);
    assert.ok(order.lastIndexOf(FrameType.Data) < order.indexOf(FrameType.Close), 'the close overtook the error message');
    assert.deepEqual(j.closes(3)[0], { code: 1000, reason: 'version' });
  } finally {
    game.close();
    await finish();
    await srv.stop();
  }
  assert.deepEqual(errors(), []);
});

test('a compressed frame Steam would not send closes that connection (4002) instead of breaking its stream', async () => {
  const srv = await loopback();
  const game = new GameServer({ ...loadConfig(), relaySecret: SECRET }, createNullEconomy());
  game.attach(srv.http, { exclusive: true });
  const j = new FakeJoiner();
  const sockets = serverSockets();
  let refuseData = 1; // Steam refuses the first Data frame (the welcome)
  const relay = new HostRelay({
    serverUrl: srv.url,
    relaySecret: SECRET,
    send: (_to, p) => {
      if (p[3] === (FrameType.Data | 0x80) && refuseData > 0) {
        refuseData--;
        return false; // lost: the joiner's inflater would never see this piece of the stream
      }
      j.take(p);
      return true;
    },
    isMember: (id) => id === MEMBER,
    wsFactory: sockets.factory,
    log: () => {},
  });
  try {
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 1));
    await until(() => j.frames.some((f) => f.type === FrameType.Open), 5000, 'open');
    relay.onPacket(MEMBER, encodeData(1, helloMsg('Joe')));
    await until(() => j.closes(1).length === 1, 5000, 'the connection is closed');
    assert.equal(j.closes(1)[0].code, 4002);
    await until(() => game.stats().clients === 0, 5000, 'its server connection is closed too');
    assert.equal(j.messages(1).length, 0, 'nothing after the lost piece was sent on that stream');
    // the member reconnects on a new connection id, with a fresh stream: it works
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 2));
    await until(() => j.frames.some((f) => f.type === FrameType.Open && f.conn === 2), 5000, 'open 2');
    relay.onPacket(MEMBER, encodeData(2, helloMsg('Joe')));
    await until(() => j.messages(2).some((m) => m.t === 'welcome'), 5000, 'welcome on the new connection');
  } finally {
    // the relay first (nothing more reaches the joiner), then the server, then this joiner's inflate
    // streams once every frame it was sent has been inflated
    relay.close('done');
    game.close();
    await sockets.closed();
    await j.finish();
    await srv.stop();
  }
  assert.deepEqual(j.errors, []);
});

test('non-members are ignored; a malformed packet drops the member, who is ignored for a while', async () => {
  let now = 1_000_000;
  const srv = await loopback();
  const game = new GameServer({ ...loadConfig(), relaySecret: SECRET }, createNullEconomy());
  game.attach(srv.http, { exclusive: true });
  const { relay, joiner, logs, finish, errors } = relayTo(srv.url, { now: () => now });
  try {
    relay.onPacket(STRANGER, encodeFrame(FrameType.Open, 1));
    relay.onPacket(STRANGER, Buffer.from('garbage'));
    await sleep(100);
    assert.equal(joiner(STRANGER).frames.length, 0, 'a stranger got an answer');
    assert.equal(game.stats().clients, 0);
    assert.ok(logs.some((s) => s.includes('not in the lobby')));

    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 1));
    await until(() => game.stats().clients === 1, 5000, 'member connected');
    relay.onPacket(MEMBER, Buffer.from([0x48, 0x57, 1, 2, 0, 1, 0, 0, 0, 9, 1])); // length mismatch
    await until(() => joiner(MEMBER).frames.some((f) => f.type === FrameType.Bye), 5000, 'bye');
    await until(() => game.stats().clients === 0, 5000, 'their server connection closed');
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 2));
    await sleep(100);
    assert.equal(game.stats().clients, 0, 'ignored during the cooldown');
    now += DROP_COOLDOWN_MS + 1;
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 2));
    await until(() => game.stats().clients === 1, 5000, 'back after the cooldown');
    // too many connections for one member
    for (let c = 3; c <= MAX_CONNS_PER_PEER + 2; c++) relay.onPacket(MEMBER, encodeFrame(FrameType.Open, c));
    await until(() => joiner(MEMBER).closes(MAX_CONNS_PER_PEER + 2).length === 1, 5000, 'limit');
    assert.equal(joiner(MEMBER).closes(MAX_CONNS_PER_PEER + 2)[0].code, 4008);
    // data for a connection that does not exist
    relay.onPacket(MEMBER, encodeData(77, Buffer.from('{}')));
    await until(() => joiner(MEMBER).closes(77).length === 1, 5000, 'unknown connection');
    // the member closes one: the server side closes too
    const before = game.stats().clients;
    relay.onPacket(MEMBER, encodeClose(2, 1000, ''));
    await until(() => game.stats().clients === before - 1, 5000, 'closed on the server');
  } finally {
    game.close();
    await finish();
    await srv.stop();
  }
  assert.deepEqual(errors(), []);
});

test('a member flooding packets is dropped and ignored for a while; steady traffic under the budget is not', async () => {
  let now = 5_000_000;
  // no server needed: pings and data for unknown connections are answered by the relay itself
  const { relay, joiner, logs, finish, errors } = relayTo('ws://127.0.0.1:9/ws', { now: () => now });
  const ping = () => encodeFrame(FrameType.Ping, 0, Buffer.alloc(8, 7));
  const count = (id: string, type: number) => joiner(id).frames.filter((f) => f.type === type).length;
  try {
    // steady: PEER_PACKET_RATE a second for five seconds is all answered (a real joiner sends ~35/s)
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < PEER_PACKET_RATE; i++) relay.onPacket(MEMBER, ping());
      now += 1000;
    }
    await until(() => count(MEMBER, FrameType.Pong) === 5 * PEER_PACKET_RATE, 5000, 'pongs');
    assert.equal(count(MEMBER, FrameType.Bye), 0, 'steady traffic is not a flood');

    // a flood: pings and data for unknown connections, all at once
    for (let i = 0; i < 5000; i++) relay.onPacket(MEMBER2, i % 2 ? ping() : encodeData(77, Buffer.from('{}')));
    await until(() => count(MEMBER2, FrameType.Bye) === 1, 5000, 'the flooder gets a Bye');
    await sleep(20);
    const answered = count(MEMBER2, FrameType.Pong) + count(MEMBER2, FrameType.Close);
    assert.ok(answered <= PEER_PACKET_BURST, `the flood drew ${answered} replies (budget ${PEER_PACKET_BURST})`);
    assert.match(joiner(MEMBER2).frames.find((f) => f.type === FrameType.Bye)!.payload.toString(), /too many packets/);
    assert.ok(logs.some((s) => s.includes(`dropped ${MEMBER2}`)));
    // ignored during the cooldown, heard again after it
    const before = joiner(MEMBER2).frames.length;
    relay.onPacket(MEMBER2, ping());
    await sleep(20);
    assert.equal(joiner(MEMBER2).frames.length, before, 'ignored during the cooldown');
    now += DROP_COOLDOWN_MS + 1;
    relay.onPacket(MEMBER2, ping());
    await until(() => joiner(MEMBER2).frames.length === before + 1, 5000, 'heard after the cooldown');
    // the other member was never affected
    relay.onPacket(MEMBER, ping());
    await until(() => count(MEMBER, FrameType.Pong) === 5 * PEER_PACKET_RATE + 1, 5000, 'the steady member still answered');
  } finally {
    await finish();
  }
  assert.deepEqual(errors(), []);
});

test('closing the relay says Bye to every member and closes their server connections', async () => {
  const srv = await loopback();
  const game = new GameServer({ ...loadConfig(), relaySecret: SECRET }, createNullEconomy());
  game.attach(srv.http, { exclusive: true });
  const { relay, joiner, finish, errors } = relayTo(srv.url);
  try {
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 1));
    await until(() => game.stats().clients === 1, 5000, 'connected');
    relay.close('The host left the lobby.', [MEMBER, MEMBER2]);
    for (const id of [MEMBER, MEMBER2]) {
      await until(() => joiner(id).frames.some((f) => f.type === FrameType.Bye), 5000, `bye for ${id}`);
      const bye = joiner(id).frames.find((f) => f.type === FrameType.Bye);
      assert.ok(bye, `no bye for ${id}`);
      assert.equal(bye.payload.toString(), 'The host left the lobby.');
    }
    await until(() => game.stats().clients === 0, 5000, 'server connections closed');
    relay.onPacket(MEMBER, encodeFrame(FrameType.Open, 5));
    await sleep(50);
    assert.equal(game.stats().clients, 0, 'a closed relay opens nothing');
  } finally {
    game.close();
    await finish();
    await srv.stop();
  }
  assert.deepEqual(errors(), []);
});
