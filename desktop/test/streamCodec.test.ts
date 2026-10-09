// The per-connection deflate stream (host -> joiner): messages come back exactly and in order, later
// ones shrink against earlier ones, and a bomb or garbage kills the stream instead of the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { StreamDeflater, StreamInflater } from '../src/streamCodec.ts';

const snapshot = (tick: number) =>
  JSON.stringify({ t: 's', s: { t: tick, u: Array.from({ length: 10 }, (_, i) => ({ i, x: +(i * 1.25 + tick * 0.01).toFixed(2), z: -3.5, hp: 100 - i, f: 0.5, fl: 0 })) } });

test('a stream of snapshots round-trips in order and compresses far better than one message at a time', async () => {
  const d = new StreamDeflater();
  const i = new StreamInflater();
  try {
    let raw = 0;
    let streamed = 0;
    let single = 0;
    const msgs = Array.from({ length: 60 }, (_, k) => Buffer.from(snapshot(k)));
    // all compressions start at once (as messages arrive), results still come back in order
    const pieces = await Promise.all(msgs.map((m) => d.deflate(m)));
    for (let k = 0; k < msgs.length; k++) {
      raw += msgs[k].length;
      streamed += pieces[k].length;
      single += deflateRawSync(msgs[k], { level: 1 }).length;
      const back = await i.inflate(pieces[k], 1 << 20);
      assert.ok(back, `message ${k} did not inflate`);
      assert.equal(back.toString(), msgs[k].toString());
    }
    assert.ok(streamed * 2 < single, `stream ${streamed} B vs per-message ${single} B`);
    assert.ok(streamed * 5 < raw, `stream ${streamed} B vs raw ${raw} B`);
  } finally {
    d.close();
    i.close();
  }
});

test('a deflate bomb is cut off at the size cap and the stream is dead after it', async () => {
  const i = new StreamInflater();
  const bomb = deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
  assert.equal(await i.inflate(bomb, 1024 * 1024), null);
  assert.equal(await i.inflate(deflateRawSync(Buffer.from('{"t":"x"}')), 1024 * 1024), null, 'dead stream');
  i.close();
});

test('garbage that claims to be deflated returns null, never throws', async () => {
  const i = new StreamInflater();
  assert.equal(await i.inflate(Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x13]), 1024), null);
  i.close();
  const j = new StreamInflater();
  // a valid piece from a different stream (no shared context) still inflates as long as it is self-contained
  const other = new StreamDeflater();
  const piece = await other.deflate(Buffer.from('hello'));
  assert.equal((await j.inflate(piece, 1024))?.toString(), 'hello');
  other.close();
  j.close();
});
