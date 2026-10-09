// Per-connection deflate stream for the host -> joiner direction (what WebSocket permessage-deflate
// does with context takeover): every message is sync-flushed, so the joiner can inflate it as soon as
// it arrives, and later messages compress against the earlier ones. Snapshots repeat almost all of
// their keys, so this is several times smaller than deflating each message on its own.
//
// Both ends must see the same messages in the same order: the relays use one stream per relay
// connection and keep every frame of a connection in order behind its pending (de)compression.
import { constants, createDeflateRaw, createInflateRaw, type DeflateRaw, type InflateRaw } from 'node:zlib';

/** The deflate window (8 KB, as the game server's own permessage-deflate) */
const WINDOW_BITS = 13;

export class StreamDeflater {
  private readonly z: DeflateRaw = createDeflateRaw({ level: 1, memLevel: 7, windowBits: WINDOW_BITS });
  private queue: Promise<unknown> = Promise.resolve();
  private failed: Error | null = null;
  private closed = false;

  constructor() {
    this.z.on('error', (err: Error) => {
      this.failed = err;
    });
  }

  /** Compress one message; results come back in call order. */
  deflate(message: Uint8Array): Promise<Buffer> {
    const run = () =>
      new Promise<Buffer>((resolve, reject) => {
        if (this.failed || this.closed) return reject(this.failed ?? new Error('deflater closed'));
        const chunks: Buffer[] = [];
        const onData = (c: Buffer) => chunks.push(c);
        this.z.on('data', onData);
        this.z.write(message);
        this.z.flush(constants.Z_SYNC_FLUSH, () => {
          this.z.off('data', onData);
          if (this.failed) reject(this.failed);
          else resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
        });
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.queue.then(() => this.z.close());
  }
}

export class StreamInflater {
  private readonly z: InflateRaw = createInflateRaw({ windowBits: 15 });
  private queue: Promise<unknown> = Promise.resolve();
  private dead = false;

  constructor() {
    this.z.on('error', () => {
      this.dead = true;
    });
  }

  /**
   * Inflate one message. Null when the data is corrupt or the message would be bigger than
   * maxMessage (a deflate bomb): the stream is dead after that, so the caller ends the connection.
   */
  inflate(chunk: Uint8Array, maxMessage: number): Promise<Buffer | null> {
    const run = () =>
      new Promise<Buffer | null>((resolve) => {
        if (this.dead) return resolve(null);
        let done = false;
        const finish = (v: Buffer | null) => {
          if (done) return;
          done = true;
          this.z.off('data', onData);
          this.z.off('error', onError);
          resolve(v);
        };
        const chunks: Buffer[] = [];
        let total = 0;
        const onData = (c: Buffer) => {
          total += c.length;
          if (total > maxMessage) {
            this.dead = true;
            this.z.destroy(); // stop inflating the rest of a bomb
            finish(null);
            return;
          }
          chunks.push(c);
        };
        const onError = () => finish(null);
        this.z.on('data', onData);
        this.z.once('error', onError);
        this.z.write(chunk);
        this.z.flush(constants.Z_SYNC_FLUSH, () => finish(this.dead ? null : Buffer.concat(chunks)));
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    void this.queue.then(() => this.z.close());
  }
}
