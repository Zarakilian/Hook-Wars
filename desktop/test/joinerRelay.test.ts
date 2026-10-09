// The joiner's local relay on its own: who may connect (token, Origin), what it sends the host, and
// how it ends (host left, host silent, host misbehaving, host unreachable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ORIGIN } from '../src/constants.ts';
import { FrameType, JOINER_TO_HOST, dataText, decodeFrame, encodeBye, encodeData, encodeDeflatedData, encodeFrame, encodeClose, type Frame } from '../src/framing.ts';
import { HOST_BAD_DATA_CODE, HOST_LEFT_CODE, HOST_LOST_CODE, HOST_UNREACHABLE_CODE, JoinerRelay, REPLACED_CODE, type JoinerRelayOptions } from '../src/joinerRelay.ts';
import { StreamDeflater } from '../src/streamCodec.ts';
import { client, closeQuietly, sleep, until } from './helpers.ts';

const HOST = '76561190000000001';
const OTHER = '76561190000000002';

async function relay(extra: Partial<JoinerRelayOptions> = {}) {
  const toHost: Frame[] = [];
  const ended: string[] = [];
  const r = new JoinerRelay({
    hostId: HOST,
    send: (to, p) => {
      assert.equal(to, HOST, 'a joiner only ever talks to its host');
      const d = decodeFrame(p, JOINER_TO_HOST);
      assert.ok(d.ok, d.ok ? '' : d.reason);
      toHost.push(d.frame);
      return true;
    },
    log: () => {},
    ...extra,
  });
  r.onEnded = (why) => ended.push(why);
  const url = await r.start();
  return { r, url, toHost, ended };
}

test('only the app page with the right token gets in', async () => {
  const { r, url } = await relay();
  try {
    const wrongToken = client(url.replace(/[0-9a-f]{4}$/, '0000'));
    await assert.rejects(wrongToken.open, /404/);
    const noOrigin = client(url, { origin: null });
    await assert.rejects(noOrigin.open, /403/);
    const website = client(url, { origin: 'https://evil.example' });
    await assert.rejects(website.open, /403/);
    const shortPath = client(url.replace(/\/ws\/.*$/, '/ws'));
    await assert.rejects(shortPath.open, /404/);
    const page = client(url);
    await page.open;
    closeQuietly(page);
  } finally {
    r.close();
  }
});

test('a page connection becomes Open + Data to the host; messages wait for the ack; only the host is heard', async () => {
  const { r, url, toHost } = await relay({ openRetryMs: 50 });
  const page = client(url);
  try {
    await page.open;
    page.send({ t: 'hello', v: 3 });
    await until(() => toHost.filter((f) => f.type === FrameType.Open).length >= 2, 1000, 'open retried');
    assert.equal(toHost.filter((f) => f.type === FrameType.Data).length, 0, 'data before the ack');
    const conn = toHost.find((f) => f.type === FrameType.Open)!.conn;
    r.onPacket(OTHER, encodeFrame(FrameType.Open, conn)); // not the host: ignored
    await sleep(30);
    assert.equal(toHost.filter((f) => f.type === FrameType.Data).length, 0);
    r.onPacket(HOST, encodeFrame(FrameType.Open, conn));
    await until(() => toHost.some((f) => f.type === FrameType.Data), 1000, 'queued hello sent');
    assert.equal(dataText(toHost.find((f) => f.type === FrameType.Data)!, JOINER_TO_HOST), '{"t":"hello","v":3}');
    const opens = toHost.filter((f) => f.type === FrameType.Open).length;
    await sleep(120);
    assert.equal(toHost.filter((f) => f.type === FrameType.Open).length, opens, 'no more retries after the ack');
    // the host's messages reach the page, plain and stream-deflated, in order
    const d = new StreamDeflater();
    r.onPacket(HOST, encodeData(conn, Buffer.from('{"t":"welcome","id":1}')));
    r.onPacket(HOST, encodeDeflatedData(conn, await d.deflate(Buffer.from('{"t":"rooms","rooms":[]}'))));
    r.onPacket(HOST, encodeDeflatedData(conn, await d.deflate(Buffer.from('{"t":"rooms","rooms":[1]}'))));
    r.onPacket(OTHER, encodeData(conn, Buffer.from('{"t":"error","code":"spoof"}')));
    await until(() => page.inbox.length === 3, 1000, 'three messages');
    assert.deepEqual(page.inbox.map((m) => m.t), ['welcome', 'rooms', 'rooms']);
    d.close();
    // the host closes the connection: the page sees the host's code and reason
    const closed = page.closed;
    r.onPacket(HOST, encodeClose(conn, 1008, 'policy violation'));
    assert.deepEqual(await closed, { code: 1008, reason: 'policy violation' });
  } finally {
    closeQuietly(page);
    r.close();
  }
});

test('a new page connection replaces the old one, and the host hears about both', async () => {
  const { r, url, toHost } = await relay();
  const a = client(url);
  const b = client(url);
  try {
    await a.open;
    const aClosed = a.closed;
    await b.open;
    assert.equal((await aClosed).code, REPLACED_CODE);
    const opens = toHost.filter((f) => f.type === FrameType.Open).map((f) => f.conn);
    assert.equal(new Set(opens).size, 2, 'two relay connections');
    await until(() => toHost.some((f) => f.type === FrameType.Close && f.conn === opens[0]), 1000, 'close for the old one');
  } finally {
    closeQuietly(a);
    closeQuietly(b);
    r.close();
  }
});

test('the host says Bye: the page closes with "host left" and the relay ends', async () => {
  const { r, url, ended } = await relay();
  const page = client(url);
  try {
    await page.open;
    const closed = page.closed;
    r.onPacket(HOST, encodeBye('The host left the lobby.'));
    assert.deepEqual(await closed, { code: HOST_LEFT_CODE, reason: 'The host left the lobby.' });
    assert.deepEqual(ended, ['The host left the lobby.']);
    await assert.rejects(client(url).open);
  } finally {
    closeQuietly(page);
    r.close();
  }
});

test('a malformed packet from the host ends the relay with "bad data"', async () => {
  const { r, url, ended } = await relay();
  const page = client(url);
  try {
    await page.open;
    const closed = page.closed;
    r.onPacket(HOST, Buffer.from([0x48, 0x57, 1, 0x0f, 0, 0, 0, 0, 0, 0]));
    const c = await closed;
    assert.equal(c.code, HOST_BAD_DATA_CODE);
    assert.match(ended[0], /bad data/);
  } finally {
    closeQuietly(page);
    r.close();
  }
});

test('a host that never answers: the page gives up (4002); a host that goes silent: the relay ends (4001)', async () => {
  const one = await relay({ openRetryMs: 20, openAttempts: 3 });
  const p1 = client(one.url);
  try {
    await p1.open;
    assert.equal((await p1.closed).code, HOST_UNREACHABLE_CODE);
  } finally {
    closeQuietly(p1);
    one.r.close();
  }
  const two = await relay({ pingMs: 30, hostTimeoutMs: 120 });
  const p2 = client(two.url);
  try {
    await p2.open;
    two.r.onPacket(HOST, encodeFrame(FrameType.Open, two.toHost.find((f) => f.type === FrameType.Open)!.conn));
    const c = await p2.closed;
    assert.equal(c.code, HOST_LOST_CODE);
    assert.ok(two.toHost.some((f) => f.type === FrameType.Ping), 'it pinged the host');
    assert.equal(two.ended.length, 1);
  } finally {
    closeQuietly(p2);
    two.r.close();
  }
});

test('pings from the host are answered; leaving says Bye to the host', async () => {
  const { r, toHost } = await relay();
  r.onPacket(HOST, encodeFrame(FrameType.Ping, 0, Buffer.from('12345678')));
  assert.ok(toHost.some((f) => f.type === FrameType.Pong && f.payload.toString() === '12345678'));
  r.close();
  assert.equal(toHost[toHost.length - 1].type, FrameType.Bye);
  assert.equal(APP_ORIGIN, 'app://hookwars');
});
