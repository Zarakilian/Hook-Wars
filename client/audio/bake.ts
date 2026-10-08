// Background baking: renders synth recipes once into AudioBuffers with an OfflineAudioContext
// (on the browser's render thread), so a later play() is a single buffer source instead of
// dozens of oscillators. Until a bake is ready the caller synthesises live, so nothing waits.
import type { SfxId } from '../render/contracts.ts';
import { Snd, kitFrom, type Kit, type SndEnv } from './core.ts';

export interface BakeJob {
  key: string;
  takes: number;
  channels: 1 | 2;
  /** render length before trimming (s) */
  maxDur: number;
  env?: SndEnv;
  render: (s: Snd) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for an idle slice between frames (falls back to a short timer), so bake builds stay out of frame budgets. */
const idle = () =>
  new Promise<void>((r) => {
    const w = globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => r(), { timeout: 300 });
    else setTimeout(r, 24);
  });

export class Baker {
  private readonly base: Kit;
  private readonly sr: number;
  private readonly store = new Map<string, AudioBuffer[]>();
  private readonly pending = new Set<string>();
  private readonly queue: BakeJob[] = [];
  private busy = false;
  private stopped = false;
  private seed = 1;
  bytes = 0;
  renders = 0;
  failures = 0;
  buildMs = 0;
  maxBuildMs = 0;
  readonly slow: string[] = [];

  constructor(base: Kit) {
    this.base = base;
    this.sr = base.sr;
  }

  get ready(): number {
    return this.store.size;
  }

  get queued(): number {
    return this.queue.length;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  get(key: string): AudioBuffer | null {
    const a = this.store.get(key);
    if (!a || !a.length) return null;
    return a[Math.floor(Math.random() * a.length) % a.length];
  }

  /** Queue a bake once. `urgent` jumps the queue (a sound just played live). */
  request(job: BakeJob, urgent = false): void {
    if (this.stopped || this.store.has(job.key) || this.pending.has(job.key)) return;
    this.pending.add(job.key);
    if (urgent) this.queue.unshift(job);
    else this.queue.push(job);
    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // let the page settle first (this usually starts on the first click)
      await sleep(260);
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        const takes: AudioBuffer[] = [];
        for (let k = 0; k < job.takes && !this.stopped; k++) {
          await idle();
          if (this.stopped) break;
          try {
            const b = await this.renderOne(job);
            if (b) takes.push(b);
          } catch (err) {
            this.failures++;
            console.warn('[audio] bake failed', job.key, err);
          }
          // small gaps keep the main-thread graph building out of consecutive frames
          await sleep(16);
        }
        this.pending.delete(job.key);
        if (takes.length) this.store.set(job.key, takes);
      }
    } finally {
      this.busy = false;
    }
  }

  private async renderOne(job: BakeJob): Promise<AudioBuffer | null> {
    const len = Math.ceil(job.maxDur * this.sr);
    const c = new OfflineAudioContext(job.channels, len, this.sr);
    const kit = kitFrom(c, this.base, (this.seed = (this.seed * 1103515245 + 12345) >>> 0));
    const out = c.createGain();
    out.connect(c.destination);
    const t0 = performance.now();
    // bakes are dry: reverb sends are applied live at playback (no convolver set-up on the main thread)
    const s = new Snd(kit, out, null, 0.003, 1, job.env ?? {});
    job.render(s);
    const ms = performance.now() - t0;
    this.buildMs += ms;
    if (ms > this.maxBuildMs) this.maxBuildMs = ms;
    if (ms > 6) this.slow.push(`${job.key} build ${ms.toFixed(1)}`);
    const buf = await c.startRendering();
    this.renders++;
    const t1 = performance.now();
    const out2 = this.trim(buf);
    const tm = performance.now() - t1;
    if (tm > 6) this.slow.push(`${job.key} trim ${tm.toFixed(1)}`);
    return out2;
  }

  /** Copy into a buffer cut just after the signal falls below -60 dBFS. */
  private trim(buf: AudioBuffer): AudioBuffer | null {
    const n = buf.length;
    let last = -1;
    let nan = false;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = n - 1; i > last; i--) {
        const v = d[i];
        if (v !== v) {
          nan = true;
          break;
        }
        if (v > 1e-3 || v < -1e-3) {
          last = i;
          break;
        }
      }
    }
    if (nan || last < 0) return null;
    const keep = Math.min(n, last + Math.floor(this.sr * 0.03));
    const out = new AudioBuffer({ length: keep, numberOfChannels: buf.numberOfChannels, sampleRate: this.sr });
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch).subarray(0, keep);
      // short fade at the cut
      const f = Math.min(keep, Math.floor(this.sr * 0.02));
      const copy = new Float32Array(d);
      for (let i = 0; i < f; i++) copy[keep - 1 - i] *= i / f;
      out.copyToChannel(copy, ch);
    }
    this.bytes += keep * buf.numberOfChannels * 4;
    return out;
  }
}

/** Bake key for an SFX in an environment. Only the dimensions a recipe reads are part of the key. */
export function sfxKey(id: SfxId, env: SndEnv): string {
  switch (id) {
    case 'hookThrow':
    case 'hookReturn':
    case 'bash':
    case 'hurt':
    case 'death':
    case 'footstep':
      return `${id}:${env.family === 'ogre' || env.family === 'bot' ? env.family : 'brawler'}`;
    case 'tideHorn':
      return `${id}@${env.mapId === 'frostfang' || env.mapId === 'cogwater' ? env.mapId : 'sea'}`;
    case 'hazardBurst':
      return `${id}@${env.special === 'icespikes' || env.special === 'steamvent' ? env.special : 'any'}`;
    default:
      return id;
  }
}
