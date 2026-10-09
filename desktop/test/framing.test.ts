// The P2P frame codec: round trips, the size limits, and that anything malformed is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  FLAG_DEFLATE,
  FrameType,
  HEADER_BYTES,
  HOST_TO_JOINER,
  JOINER_TO_HOST,
  byeReason,
  clipUtf8,
  closeInfo,
  dataText,
  decodeFrame,
  encodeBye,
  encodeClose,
  encodeData,
  encodeDeflatedData,
  encodeFrame,
  encodePing,
  encodePong,
  sendableCloseCode,
} from '../src/framing.ts';

const text = (s: string) => Buffer.from(s, 'utf8');

function decodeOk(packet: Buffer, limits = HOST_TO_JOINER) {
  const d = decodeFrame(packet, limits);
  assert.ok(d.ok, d.ok ? '' : d.reason);
  return d.frame;
}

test('every frame type round-trips', () => {
  const open = decodeOk(encodeFrame(FrameType.Open, 7));
  assert.deepEqual([open.type, open.conn, open.payload.length], [FrameType.Open, 7, 0]);

  const msg = JSON.stringify({ t: 'hello', v: 3, profile: { name: 'Hookó 🎣', family: 'brawler' } });
  const data = decodeOk(encodeData(65535, text(msg)), JOINER_TO_HOST);
  assert.equal(data.conn, 65535);
  assert.equal(dataText(data, JOINER_TO_HOST), msg);

  const close = decodeOk(encodeClose(3, 4000, 'The host left the lobby.'));
  assert.deepEqual(closeInfo(close), { code: 4000, reason: 'The host left the lobby.' });

  const ping = decodeOk(encodePing(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])));
  const pong = decodeOk(encodePong(ping));
  assert.equal(pong.type, FrameType.Pong);
  assert.deepEqual([...pong.payload], [1, 2, 3, 4, 5, 6, 7, 8]);

  const bye = decodeOk(encodeBye('bye now'));
  assert.equal(byeReason(bye), 'bye now');
});

test('deflated Data frames: allowed host -> joiner only, and never read as plain text', () => {
  const f = decodeOk(encodeDeflatedData(1, Buffer.from([1, 2, 3])));
  assert.equal(f.deflated, true);
  assert.equal(dataText(f, HOST_TO_JOINER), null, 'the stream inflater reads these, not dataText');
  assert.deepEqual(decodeFrame(encodeDeflatedData(1, Buffer.from([1, 2, 3])), JOINER_TO_HOST), { ok: false, reason: 'unexpected compression' });
});

test('size limits: oversized packets and messages are refused', () => {
  const big = Buffer.alloc(JOINER_TO_HOST.maxMessage + 1, 0x61);
  const d = decodeFrame(encodeData(1, big), JOINER_TO_HOST);
  assert.equal(d.ok, false);
  const atLimit = decodeFrame(encodeData(1, Buffer.alloc(JOINER_TO_HOST.maxMessage, 0x61)), JOINER_TO_HOST);
  assert.equal(atLimit.ok, true);
  const huge = decodeFrame(Buffer.alloc(HOST_TO_JOINER.maxPacket + 1), HOST_TO_JOINER);
  assert.deepEqual(huge, { ok: false, reason: 'oversized packet' });
});

test('malformed packets are refused, each for its own reason', () => {
  const good = encodeFrame(FrameType.Open, 1);
  const cases: [string, Buffer, typeof HOST_TO_JOINER][] = [];
  const mut = (f: (b: Buffer) => void, limits = HOST_TO_JOINER) => {
    const b = Buffer.from(good);
    f(b);
    return [b, limits] as const;
  };
  const add = (name: string, [b, l]: readonly [Buffer, typeof HOST_TO_JOINER]) => cases.push([name, b, l]);
  add('short packet', [Buffer.alloc(HEADER_BYTES - 1), HOST_TO_JOINER]);
  add('bad magic', mut((b) => (b[0] = 0x00)));
  add('unknown version', mut((b) => (b[2] = 9)));
  add('unknown type', mut((b) => (b[3] = 0x0e)));
  add('unknown flags', mut((b) => (b[3] = FrameType.Open | 0x20)));
  add('unexpected compression', mut((b) => (b[3] = FrameType.Open | FLAG_DEFLATE)));
  add('length mismatch', mut((b) => b.writeUInt32BE(5, 6)));
  add('bad connection id', mut((b) => b.writeUInt16BE(0, 4)));
  add('open with payload', [encodeFrame(FrameType.Open, 1, Buffer.from([1])), HOST_TO_JOINER]);
  add('bad close', [encodeFrame(FrameType.Close, 1, Buffer.from([3])), HOST_TO_JOINER]);
  add('bad ping', [encodeFrame(FrameType.Ping, 0, Buffer.alloc(4)), HOST_TO_JOINER]);
  add('bad connection id', [encodeFrame(FrameType.Ping, 5, Buffer.alloc(8)), HOST_TO_JOINER]);
  add('bad bye', [encodeFrame(FrameType.Bye, 0, Buffer.alloc(200)), HOST_TO_JOINER]);
  // joiners may never send compressed data
  add('unexpected compression', [encodeFrame(FrameType.Data, 1, deflateRawSync(text('{"t":"ping","c":1}')), true), JOINER_TO_HOST]);
  for (const [reason, packet, limits] of cases) {
    const d = decodeFrame(packet, limits);
    assert.deepEqual(d, { ok: false, reason }, `expected "${reason}"`);
  }
  // random bytes never crash the decoder
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(Math.random() * 40);
    const b = Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256)));
    if (i % 2) b.set([0x48, 0x57, 1].slice(0, n));
    const d = decodeFrame(b, JOINER_TO_HOST);
    if (d.ok) dataText(d.frame, JOINER_TO_HOST);
  }
});

test('text that is not UTF-8 is refused', () => {
  const f = decodeOk(encodeFrame(FrameType.Data, 1, Buffer.from([0x7b, 0xc3, 0x28, 0x7d])), JOINER_TO_HOST);
  assert.equal(dataText(f, JOINER_TO_HOST), null);
  const c = decodeOk(encodeFrame(FrameType.Close, 1, Buffer.from([0x03, 0xe8, 0xff])));
  assert.equal(closeInfo(c), null);
});

test('close codes and reasons stay sendable', () => {
  assert.equal(sendableCloseCode(1000), true);
  assert.equal(sendableCloseCode(1006), false);
  assert.equal(sendableCloseCode(1005), false);
  assert.equal(sendableCloseCode(4999), true);
  assert.equal(sendableCloseCode(2000), false);
  // a code that may not be sent becomes 1000
  assert.equal(closeInfo(decodeOk(encodeClose(1, 1006, 'x')))!.code, 1000);
  // reasons are clipped to 123 bytes on a character boundary
  const clipped = clipUtf8('🎣'.repeat(40));
  assert.ok(clipped.length <= 123);
  assert.equal(clipped.length % 4, 0);
  assert.ok(decodeFrame(encodeClose(1, 4000, 'é'.repeat(200)), HOST_TO_JOINER).ok);
});
