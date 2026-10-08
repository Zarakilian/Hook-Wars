// Low-level procedural synth toolkit shared by SFX, announcer, ambience and music.
// Everything takes a BaseAudioContext so the same recipes render live or into an OfflineAudioContext.
import type { FamilyId, HazardKind, MapId } from '../../shared/types.ts';

export type Rng = () => number;

/** Small fast seeded PRNG (mulberry32). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Floor for exponential ramps (they throw on 0). */
export const EPS = 1e-4;

// ---------------------------------------------------------------------------------------------
// Kit: per-context shared resources (noise buffers, periodic waves, baked one-shot textures)
// ---------------------------------------------------------------------------------------------

export type NoiseKind = 'white' | 'pink' | 'brown';

export interface Kit {
  readonly ctx: BaseAudioContext;
  readonly sr: number;
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly reed: PeriodicWave; // accordion
  readonly bow: PeriodicWave; // fiddle
  readonly brass: PeriodicWave;
  readonly hollow: PeriodicWave; // odd harmonics, clarinet / horn body
  readonly rng: Rng;
  /** soft clip curve for WaveShaperNode (input expected within -1..1 after a 0.5 pre-gain) */
  readonly clip: Float32Array<ArrayBuffer>;
  /** gentle tanh drive curve */
  readonly drive: Float32Array<ArrayBuffer>;
  /** baked textures, built lazily on first use */
  baked(name: BakedName): AudioBuffer;
}

export type BakedName = 'jangle' | 'clatter' | 'bubbles' | 'applause' | 'crackle';

function makeNoise(ctx: BaseAudioContext, kind: NoiseKind, seconds: number, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  if (kind === 'white') {
    for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  } else if (kind === 'pink') {
    // Paul Kellet's refined pink filter, run twice round so the loop point is seamless
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    const white = new Float32Array(n);
    for (let i = 0; i < n; i++) white[i] = rng() * 2 - 1;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const w = white[i];
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        if (pass === 1) d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
  } else {
    let last = 0;
    const white = new Float32Array(n);
    for (let i = 0; i < n; i++) white[i] = rng() * 2 - 1;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        last = (last + 0.02 * white[i]) / 1.02;
        if (pass === 1) d[i] = last * 3.5;
      }
    }
  }
  return buf;
}

function makeWave(ctx: BaseAudioContext, amp: (n: number) => number, count: number): PeriodicWave {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  for (let n = 1; n <= count; n++) imag[n] = amp(n);
  return ctx.createPeriodicWave(real, imag);
}

function curve(n: number, f: (x: number) => number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) c[i] = f((i / (n - 1)) * 2 - 1);
  return c;
}

export function makeKit(ctx: BaseAudioContext, seed = 0x5eed): Kit {
  const rng = mulberry32(seed);
  // only white noise is built up front; pink and brown are built on first use (or by warm())
  const white = makeNoise(ctx, 'white', 2.5, rng);
  let pink: AudioBuffer | null = null;
  let brown: AudioBuffer | null = null;
  const reed = makeWave(ctx, (n) => (1 / Math.pow(n, 0.75)) * (n >= 3 && n <= 6 ? 1.35 : 1) * (n % 2 ? 1 : 0.8), 40);
  const bow = makeWave(ctx, (n) => (1 / n) * (1 + 0.45 * Math.sin(n * 0.93)) * (n > 18 ? 0.6 : 1), 48);
  const brass = makeWave(ctx, (n) => (1 / Math.pow(n, 0.85)) * (n <= 8 ? 1 : 0.7), 32);
  const hollow = makeWave(ctx, (n) => (n % 2 ? 1 / n : 0.12 / n), 24);
  // linear to 0.8, smooth knee up to ~0.985
  const clip = curve(4096, (x) => {
    const v = x * 2; // undo the 0.5 pre-gain
    const a = Math.abs(v);
    if (a <= 0.8) return v;
    const k = 0.8 + 0.185 * Math.tanh((a - 0.8) / 0.185);
    return Math.sign(v) * k;
  });
  const drive = curve(2048, (x) => Math.tanh(x * 2.2) / Math.tanh(2.2));
  const cache = new Map<BakedName, AudioBuffer>();
  const kit: Kit = {
    ctx,
    sr: ctx.sampleRate,
    white,
    get pink() {
      return (pink ??= makeNoise(ctx, 'pink', 2.5, rng));
    },
    get brown() {
      return (brown ??= makeNoise(ctx, 'brown', 2.5, rng));
    },
    reed,
    bow,
    brass,
    hollow,
    rng,
    clip,
    drive,
    baked(name: BakedName): AudioBuffer {
      let b = cache.get(name);
      if (!b) {
        b = bake(ctx, name);
        cache.set(name, b);
      }
      return b;
    },
  };
  return kit;
}

/** Build the lazy resources one per task so no single frame pays for all of them. */
export function warmKit(kit: Kit, then?: () => void): void {
  const steps: (() => unknown)[] = [
    () => kit.pink,
    () => kit.brown,
    () => kit.baked('jangle'),
    () => kit.baked('bubbles'),
    () => kit.baked('clatter'),
    () => kit.baked('crackle'),
  ];
  const run = () => {
    const f = steps.shift();
    if (!f) {
      then?.();
      return;
    }
    try {
      f();
    } catch {
      // ignore: the getter will retry on use
    }
    setTimeout(run, 16);
  };
  setTimeout(run, 30);
}

/**
 * A kit for another context (offline bakes) that shares the base kit's buffers.
 * AudioBuffers can be shared across contexts; PeriodicWaves cannot, so those are rebuilt (cheap).
 */
export function kitFrom(ctx: BaseAudioContext, base: Kit, seed: number): Kit {
  const rng = mulberry32(seed);
  return {
    ctx,
    sr: ctx.sampleRate,
    white: base.white,
    get pink() {
      return base.pink;
    },
    get brown() {
      return base.brown;
    },
    reed: makeWave(ctx, (n) => (1 / Math.pow(n, 0.75)) * (n >= 3 && n <= 6 ? 1.35 : 1) * (n % 2 ? 1 : 0.8), 40),
    bow: makeWave(ctx, (n) => (1 / n) * (1 + 0.45 * Math.sin(n * 0.93)) * (n > 18 ? 0.6 : 1), 48),
    brass: makeWave(ctx, (n) => (1 / Math.pow(n, 0.85)) * (n <= 8 ? 1 : 0.7), 32),
    hollow: makeWave(ctx, (n) => (n % 2 ? 1 / n : 0.12 / n), 24),
    rng,
    clip: base.clip,
    drive: base.drive,
    baked: (name) => base.baked(name),
  };
}

// ---------------------------------------------------------------------------------------------
// Baked textures: computed sample by sample once, then replayed at random rates (cheap at runtime)
// ---------------------------------------------------------------------------------------------

function bake(ctx: BaseAudioContext, name: BakedName): AudioBuffer {
  const sr = ctx.sampleRate;
  const rng = mulberry32(name.length * 7919 + name.charCodeAt(0) * 131);
  const r = (a: number, b: number) => a + (b - a) * rng();
  const len = { jangle: 0.75, clatter: 1.1, bubbles: 1.3, applause: 3.2, crackle: 1.2 }[name];
  const n = Math.floor(sr * len);
  const buf = ctx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  // add a decaying multi-partial ping into both channels with a pan (rotating phasors: no sin/exp per sample)
  const ping = (t0: number, f: number, ratios: number[], decay: number, amp: number, pan: number, noise = 0) => {
    const s0 = Math.floor(t0 * sr);
    const dur = Math.min(n - s0, Math.floor(decay * 5.5 * sr));
    if (dur <= 0) return;
    const gl = Math.sqrt(0.5 * (1 - pan));
    const gr = Math.sqrt(0.5 * (1 + pan));
    for (let k = 0; k < ratios.length; k++) {
      const w = (2 * Math.PI * f * ratios[k]) / sr;
      if (w >= Math.PI) continue;
      const cw = Math.cos(w);
      const sw = Math.sin(w);
      const ph = rng() * Math.PI * 2;
      let c = Math.cos(ph);
      let sn = Math.sin(ph);
      let env = amp / (k + 1);
      const mul = Math.exp(-1 / (decay * sr) - (k * 9) / sr);
      for (let i = 0; i < dur; i++) {
        const v = sn * env * (i < 24 ? i / 24 : 1);
        L[s0 + i] += v * gl;
        R[s0 + i] += v * gr;
        const nc = c * cw - sn * sw;
        sn = sn * cw + c * sw;
        c = nc;
        env *= mul;
      }
    }
    if (noise > 0) {
      const m = Math.min(dur, Math.floor(sr * 0.004));
      for (let i = 0; i < m; i++) {
        const v = (rng() * 2 - 1) * noise * amp * (1 - i / m);
        L[s0 + i] += v * gl;
        R[s0 + i] += v * gr;
      }
    }
  };
  if (name === 'jangle') {
    // chain links knocking together: clustered early, thinning out
    let t = 0.002;
    for (let i = 0; i < 22 && t < len - 0.1; i++) {
      ping(t, r(2100, 6200), [1, r(1.38, 1.52), r(2.05, 2.3)], r(0.025, 0.09), r(0.25, 0.6) * (1 - t / len), r(-0.7, 0.7), 0.4);
      t += r(0.006, 0.05) * (1 + t * 3);
    }
  } else if (name === 'clatter') {
    // bits bouncing: each "bit" bounces with shrinking gaps and energy
    for (let b = 0; b < 7; b++) {
      let t = r(0, 0.12);
      let gap = r(0.12, 0.24);
      let a = r(0.4, 0.8);
      const f = r(500, 1900);
      const pan = r(-0.8, 0.8);
      const wood = rng() < 0.6;
      while (t < len - 0.08 && a > 0.04) {
        ping(t, f * r(0.97, 1.03), wood ? [1, 2.7, 5.1] : [1, 1.48, 2.18], wood ? r(0.012, 0.03) : r(0.03, 0.07), a, pan, 0.6);
        t += gap;
        gap *= r(0.55, 0.72);
        a *= r(0.55, 0.7);
      }
    }
  } else if (name === 'bubbles') {
    // rising-pitch sine chirps (Minnaert bubbles)
    let t = 0;
    while (t < len - 0.06) {
      const s0 = Math.floor(t * sr);
      const f0 = r(320, 1300);
      const d = r(0.025, 0.07);
      const a = r(0.15, 0.5) * (1 - 0.6 * (t / len));
      const pan = r(-0.6, 0.6);
      const gl = Math.sqrt(0.5 * (1 - pan));
      const gr = Math.sqrt(0.5 * (1 + pan));
      let ph = 0;
      let env = a;
      const mul = Math.exp(-1 / (d * sr));
      const m = Math.min(n - s0, Math.floor(d * 4 * sr));
      const k2 = (2 * Math.PI * f0) / sr;
      const rise = 2.2 / (d * sr);
      for (let i = 0; i < m; i++) {
        ph += k2 * (1 + rise * i);
        const v = Math.sin(ph) * env * (i < 30 ? i / 30 : 1);
        L[s0 + i] += v * gl;
        R[s0 + i] += v * gr;
        env *= mul;
      }
      t += r(0.012, 0.07);
    }
  } else if (name === 'applause') {
    // claps: a few filtered noise templates stamped at a dense random rate, swelling then thinning
    const temps: Float32Array[] = [];
    for (let k = 0; k < 8; k++) {
      const d = Math.floor(r(0.004, 0.012) * sr);
      const tl = d * 3;
      const tp = new Float32Array(tl);
      let lp1 = 0;
      let lp2 = 0;
      const kk = r(0.2, 0.6);
      for (let i = 0; i < tl; i++) {
        const w = rng() * 2 - 1;
        lp1 += kk * (w - lp1);
        lp2 += 0.05 * (lp1 - lp2);
        tp[i] = (lp1 - lp2) * Math.exp(-i / d);
      }
      temps.push(tp);
    }
    let t = 0;
    while (t < len - 0.05) {
      const dens = 0.004 + 0.02 * Math.pow(t / len, 2);
      const s0 = Math.floor(t * sr);
      const a = r(0.15, 0.45) * Math.min(1, t * 4) * (1 - 0.5 * (t / len));
      const pan = r(-0.9, 0.9);
      const gl = Math.sqrt(0.5 * (1 - pan)) * a;
      const gr = Math.sqrt(0.5 * (1 + pan)) * a;
      const tp = temps[Math.floor(rng() * temps.length) % temps.length];
      const m = Math.min(tp.length, n - s0);
      for (let i = 0; i < m; i++) {
        L[s0 + i] += tp[i] * gl;
        R[s0 + i] += tp[i] * gr;
      }
      t += r(dens * 0.4, dens * 1.6);
    }
  } else {
    // crackle: sharp sparse clicks (ice, splinters, fire)
    let t = 0.005;
    while (t < len - 0.02) {
      ping(t, r(1800, 7000), [1, r(1.7, 2.4)], r(0.003, 0.012), r(0.3, 1), r(-0.8, 0.8), 0.9);
      t += r(0.008, 0.09);
    }
  }
  // normalise to a peak of 0.9
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  if (pk > 0) {
    const g = 0.9 / pk;
    for (let i = 0; i < n; i++) {
      L[i] *= g;
      R[i] *= g;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------------------------
// Reverb impulse responses
// ---------------------------------------------------------------------------------------------

export interface IRSpec {
  dur: number; // buffer length (s)
  decay: number; // time to -60 dB (s)
  pre: number; // pre-delay (s)
  damp: number; // 0..1 high-frequency damping over the tail
  early: number; // 0..1 discrete early reflection level
  slap?: number; // optional distinct echo delay (s), e.g. brick walls or fjord cliffs
  slapAmp?: number;
  seed?: number;
}

export function makeIR(ctx: BaseAudioContext, o: IRSpec): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(o.dur * sr));
  const buf = ctx.createBuffer(2, n, sr);
  const rng = mulberry32(o.seed ?? 99);
  const pre = Math.floor(o.pre * sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let y = 0;
    let env = 1;
    const mul = Math.exp(-6.9 / (o.decay * sr));
    const kEnd = pre + Math.floor(o.decay * sr);
    const fadeIn = Math.max(1, Math.floor(0.006 * sr));
    for (let i = pre; i < n; i++) {
      const x = rng() * 2 - 1;
      const k = i < kEnd ? 0.92 - o.damp * 0.85 * ((i - pre) / (kEnd - pre)) : 0.92 - o.damp * 0.85;
      y += (k > 0.02 ? k : 0.02) * (x - y);
      const j = i - pre;
      d[i] = y * env * (j < fadeIn ? j / fadeIn : 1);
      env *= mul;
    }
    // early reflections
    for (let e = 0; e < 10; e++) {
      const at = pre + Math.floor((0.004 + rng() * 0.075) * sr);
      if (at < n) d[at] += (rng() * 2 - 1) * o.early * (1 - e / 12);
    }
    if (o.slap && o.slapAmp) {
      const at = pre + Math.floor((o.slap + c * 0.013) * sr);
      for (let i = 0; i < 300 && at + i < n; i++) d[at + i] += (rng() * 2 - 1) * o.slapAmp * Math.exp(-i / 60);
      const at2 = at + Math.floor(o.slap * sr);
      for (let i = 0; i < 300 && at2 + i < n; i++) d[at2 + i] += (rng() * 2 - 1) * o.slapAmp * 0.45 * Math.exp(-i / 60);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------------------------

/** Percussive envelope: 0 -> peak in a, exponential decay to silence after d more seconds. */
export function perc(p: AudioParam, t0: number, peak: number, a: number, d: number): number {
  const pk = Math.max(EPS * 2, peak);
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(pk, t0 + Math.max(0.0005, a));
  p.exponentialRampToValueAtTime(EPS, t0 + Math.max(0.0005, a) + Math.max(0.005, d));
  p.setValueAtTime(0, t0 + Math.max(0.0005, a) + Math.max(0.005, d) + 0.002);
  return t0 + a + d + 0.003;
}

/** Attack / hold / release envelope with an optional decay to a sustain level. */
export function ahr(p: AudioParam, t0: number, peak: number, a: number, hold: number, r: number, sus = 1, d = 0.08): number {
  const pk = Math.max(EPS * 2, peak);
  const ta = t0 + Math.max(0.001, a);
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(pk, ta);
  if (sus < 1) p.setTargetAtTime(pk * sus, ta, d / 3);
  const tr = Math.max(ta, t0 + hold);
  p.setTargetAtTime(0, tr, Math.max(0.005, r) / 4);
  p.setValueAtTime(0, tr + r * 1.6 + 0.01);
  return tr + r * 1.6 + 0.012;
}

/** Anchor then exponential (or linear) sweep of a frequency-like parameter. */
export function sweep(p: AudioParam, t0: number, v0: number, v1: number, dur: number, lin = false): void {
  p.setValueAtTime(Math.max(EPS, v0), t0);
  if (lin) p.linearRampToValueAtTime(v1, t0 + Math.max(0.001, dur));
  else p.exponentialRampToValueAtTime(Math.max(EPS, v1), t0 + Math.max(0.001, dur));
}

/** Fade a param to silence quickly from whatever it is doing (voice steal). */
export function fadeOut(p: AudioParam, now: number, dur: number): void {
  const anyP = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof anyP.cancelAndHoldAtTime === 'function') {
    anyP.cancelAndHoldAtTime(now);
  } else {
    const v = p.value;
    p.cancelScheduledValues(now);
    p.setValueAtTime(v, now);
  }
  p.linearRampToValueAtTime(0, now + dur);
}

// ---------------------------------------------------------------------------------------------
// Snd: one sound being built. Tracks its sources (for voice stealing) and its end time.
// ---------------------------------------------------------------------------------------------

/** A connection target: a node or a parameter (for LFOs and modulators). */
export type Dest = AudioNode | AudioParam;

export function link(n: AudioNode, d: Dest): void {
  if ('connect' in d) n.connect(d);
  else n.connect(d);
}

export interface SndEnv {
  family?: FamilyId;
  mapId?: MapId | null;
  special?: HazardKind | null;
}

export class Snd {
  readonly ctx: BaseAudioContext;
  readonly kit: Kit;
  /** dry destination */
  readonly out: AudioNode;
  /** reverb send input (null = no reverb) */
  readonly wet: AudioNode | null;
  /** start time */
  readonly t: number;
  /** pitch multiplier */
  readonly p: number;
  readonly env: SndEnv;
  readonly srcs: AudioScheduledSourceNode[] = [];
  end: number;
  private parent: Snd | null = null;

  constructor(kit: Kit, out: AudioNode, wet: AudioNode | null, t: number, p: number, env: SndEnv = {}) {
    this.ctx = kit.ctx;
    this.kit = kit;
    this.out = out;
    this.wet = wet;
    this.t = t;
    this.p = Math.max(0.05, Math.min(8, p));
    this.env = env;
    this.end = t;
  }

  r(a = 0, b = 1): number {
    return a + (b - a) * this.kit.rng();
  }

  ri(a: number, b: number): number {
    return Math.floor(this.r(a, b + 1 - 1e-9));
  }

  chance(p: number): boolean {
    return this.kit.rng() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.kit.rng() * arr.length) % arr.length];
  }

  g(v: number, dest?: Dest | null): GainNode {
    const n = this.ctx.createGain();
    n.gain.value = v;
    if (dest) link(n, dest);
    return n;
  }

  f(type: BiquadFilterType, freq: number, q = 0.707, dest?: AudioNode | null, gainDb = 0): BiquadFilterNode {
    const n = this.ctx.createBiquadFilter();
    n.type = type;
    n.frequency.value = Math.max(10, Math.min(this.ctx.sampleRate * 0.49, freq));
    n.Q.value = q;
    if (gainDb) n.gain.value = gainDb;
    if (dest) n.connect(dest);
    return n;
  }

  shaper(c: Float32Array<ArrayBuffer>, dest?: AudioNode | null): WaveShaperNode {
    const n = this.ctx.createWaveShaper();
    n.curve = c;
    if (dest) n.connect(dest);
    return n;
  }

  panner(v: number, dest: AudioNode): AudioNode {
    const c = this.ctx as BaseAudioContext & { createStereoPanner?: () => StereoPannerNode };
    if (typeof c.createStereoPanner === 'function') {
      const n = c.createStereoPanner();
      n.pan.value = Math.max(-1, Math.min(1, v));
      n.connect(dest);
      return n;
    }
    return this.g(1, dest);
  }

  delay(sec: number, dest?: AudioNode | null, max = 1): DelayNode {
    const n = this.ctx.createDelay(max);
    n.delayTime.value = sec;
    if (dest) n.connect(dest);
    return n;
  }

  track(src: AudioScheduledSourceNode, t1: number): void {
    this.srcs.push(src);
    if (t1 > this.end) this.end = t1;
    if (this.parent) this.parent.track(src, t1);
  }

  /** A sub-sound behind its own gain (layer balancing). Its sources are tracked by this Snd too. */
  child(gain: number, at?: number): Snd {
    const c = new Snd(this.kit, this.g(gain, this.out), this.wet, at ?? this.t, this.p, this.env);
    c.parent = this;
    return c;
  }

  osc(type: OscillatorType | PeriodicWave, freq: number, t0: number, t1: number, dest: AudioNode): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type as OscillatorType;
    else o.setPeriodicWave(type);
    o.frequency.value = Math.max(1, Math.min(this.ctx.sampleRate * 0.49, freq));
    o.connect(dest);
    o.start(t0);
    o.stop(t1 + 0.02);
    this.track(o, t1 + 0.02);
    return o;
  }

  noise(kind: NoiseKind, t0: number, t1: number, dest: AudioNode, rate = 1): AudioBufferSourceNode {
    const b = this.ctx.createBufferSource();
    b.buffer = kind === 'white' ? this.kit.white : kind === 'pink' ? this.kit.pink : this.kit.brown;
    b.loop = true;
    b.playbackRate.value = rate;
    b.connect(dest);
    const off = this.r(0, 2.5);
    b.start(t0, off);
    b.stop(t1 + 0.02);
    this.track(b, t1 + 0.02);
    return b;
  }

  buf(buffer: AudioBuffer, t0: number, dest: AudioNode, rate = 1, maxDur?: number): AudioBufferSourceNode {
    const b = this.ctx.createBufferSource();
    b.buffer = buffer;
    b.playbackRate.value = rate;
    b.connect(dest);
    b.start(t0);
    const dur = Math.min(maxDur ?? Infinity, buffer.duration / rate);
    b.stop(t0 + dur + 0.01);
    this.track(b, t0 + dur + 0.01);
    return b;
  }

  /** route a node to the reverb send with an amount */
  send(node: AudioNode, amount: number): void {
    if (!this.wet || amount <= 0) return;
    node.connect(this.g(amount, this.wet));
  }
}

// ---------------------------------------------------------------------------------------------
// Composite building blocks
// ---------------------------------------------------------------------------------------------

export interface ToneOpts {
  t?: number;
  type?: OscillatorType | PeriodicWave;
  f: number;
  f1?: number;
  /** sweep duration (defaults to a + d) */
  sw?: number;
  a?: number;
  d: number;
  v: number;
  dest?: AudioNode;
  /** vibrato [rate Hz, depth as fraction of f] */
  vib?: [number, number];
  /** apply the Snd pitch multiplier (default true) */
  pitched?: boolean;
  /** 'perc' (exp decay) or 'hold' (sustain then release over the last 30%) */
  shape?: 'perc' | 'hold';
  detune?: number;
}

/** A pitched oscillator with exponential pitch sweep and envelope. Returns the output gain. */
export function tone(s: Snd, o: ToneOpts): GainNode {
  const t = o.t ?? s.t;
  const a = o.a ?? 0.003;
  const pm = o.pitched === false ? 1 : s.p;
  const g = s.g(0, o.dest ?? s.out);
  const total = a + o.d;
  const osc = s.osc(o.type ?? 'sine', o.f * pm, t, t + total + 0.01, g);
  if (o.detune) osc.detune.value = o.detune;
  if (o.f1 !== undefined) sweep(osc.frequency, t, o.f * pm, o.f1 * pm, o.sw ?? total);
  if (o.vib) {
    const lfo = s.osc('sine', o.vib[0], t, t + total + 0.01, s.g(o.f * pm * o.vib[1], osc.frequency));
    void lfo;
  }
  if (o.shape === 'hold') ahr(g.gain, t, o.v, a, t + total * 0.7 - t, total * 0.3 * 0.6, 1);
  else perc(g.gain, t, o.v, a, o.d);
  return g;
}

export interface NoiseOpts {
  t?: number;
  kind?: NoiseKind;
  ft?: BiquadFilterType;
  f: number;
  f1?: number;
  sw?: number;
  q?: number;
  a?: number;
  d: number;
  v: number;
  dest?: AudioNode;
  rate?: number;
  /** apply pitch multiplier to the filter (default true) */
  pitched?: boolean;
}

/** Filtered noise burst with optional filter sweep. Returns the output gain. */
export function noiseHit(s: Snd, o: NoiseOpts): GainNode {
  const t = o.t ?? s.t;
  const a = o.a ?? 0.002;
  const pm = o.pitched === false ? 1 : s.p;
  const g = s.g(0, o.dest ?? s.out);
  const fl = s.f(o.ft ?? 'bandpass', o.f * pm, o.q ?? 1, g);
  s.noise(o.kind ?? 'white', t, t + a + o.d + 0.01, fl, o.rate ?? 1);
  const ny = s.ctx.sampleRate * 0.49;
  if (o.f1 !== undefined) sweep(fl.frequency, t, Math.min(ny, o.f * pm), Math.min(ny, o.f1 * pm), o.sw ?? a + o.d);
  perc(g.gain, t, o.v, a, o.d);
  return g;
}

/** Whoosh: filtered noise whose filter and level rise to a peak then fall. */
export function whoosh(s: Snd, o: { t?: number; d: number; f0: number; fp: number; f1: number; q?: number; v: number; kind?: NoiseKind; peakAt?: number; dest?: AudioNode }): GainNode {
  const t = o.t ?? s.t;
  const pk = o.peakAt ?? 0.4;
  const g = s.g(0, o.dest ?? s.out);
  const fl = s.f('bandpass', o.f0, o.q ?? 1.2, g);
  s.noise(o.kind ?? 'pink', t, t + o.d + 0.02, fl);
  const ny = s.ctx.sampleRate * 0.49;
  fl.frequency.setValueAtTime(Math.min(ny, o.f0 * s.p), t);
  fl.frequency.exponentialRampToValueAtTime(Math.min(ny, o.fp * s.p), t + o.d * pk);
  fl.frequency.exponentialRampToValueAtTime(Math.min(ny, o.f1 * s.p), t + o.d);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.v, t + o.d * pk);
  g.gain.exponentialRampToValueAtTime(EPS, t + o.d);
  g.gain.setValueAtTime(0, t + o.d + 0.005);
  return g;
}

/** Inharmonic additive bell / metal ping. partials: [ratio, amp, decay multiplier]. */
export function bell(s: Snd, o: { t?: number; f: number; d: number; v: number; partials?: readonly (readonly [number, number, number])[]; dest?: AudioNode; a?: number }): GainNode {
  const t = o.t ?? s.t;
  const parts = o.partials ?? BELL;
  const out = s.g(1, o.dest ?? s.out);
  let sum = 0;
  for (const p of parts) sum += p[1];
  for (const [ratio, amp, dm] of parts) {
    const f = o.f * ratio * s.p;
    if (f > s.ctx.sampleRate * 0.45) continue;
    const g = s.g(0, out);
    s.osc('sine', f, t, t + o.d * dm + 0.01, g);
    perc(g.gain, t, (o.v * amp) / sum, o.a ?? 0.001, o.d * dm);
  }
  return out;
}

export const BELL: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [2.0, 0.55, 0.75],
  [3.0, 0.35, 0.5],
  [4.16, 0.28, 0.35],
  [5.43, 0.14, 0.25],
];
export const CLANG: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [2.32, 0.85, 0.8],
  [3.98, 0.6, 0.6],
  [5.6, 0.45, 0.45],
  [7.92, 0.3, 0.32],
  [10.3, 0.2, 0.22],
];
export const STEEL: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [2.76, 0.6, 0.6],
  [5.4, 0.4, 0.4],
  [8.93, 0.22, 0.28],
];

/** Two-operator FM tone with a decaying modulation index (bells, zaps, servo grit). */
export function fm(s: Snd, o: { t?: number; f: number; ratio: number; index: number; index1?: number; a?: number; d: number; v: number; type?: OscillatorType; dest?: AudioNode; f1?: number }): GainNode {
  const t = o.t ?? s.t;
  const a = o.a ?? 0.002;
  const total = a + o.d;
  const g = s.g(0, o.dest ?? s.out);
  const car = s.osc(o.type ?? 'sine', o.f * s.p, t, t + total + 0.01, g);
  const mg = s.g(0, car.frequency);
  const mod = s.osc('sine', o.f * o.ratio * s.p, t, t + total + 0.01, mg);
  const dev = o.f * o.ratio * s.p;
  mg.gain.setValueAtTime(dev * o.index, t);
  mg.gain.exponentialRampToValueAtTime(Math.max(EPS, dev * (o.index1 ?? o.index * 0.05)), t + total);
  if (o.f1 !== undefined) {
    sweep(car.frequency, t, o.f * s.p, o.f1 * s.p, total);
    sweep(mod.frequency, t, o.f * o.ratio * s.p, o.f1 * o.ratio * s.p, total);
  }
  perc(g.gain, t, o.v, a, o.d);
  return g;
}

/**
 * Click train on ONE noise source (cheap): ratchets, reels, ice crackle.
 * Intervals interpolate from i0 to i1 (seconds between clicks).
 */
export function clicks(s: Snd, o: { t?: number; n: number; i0: number; i1: number; f: number; q?: number; cd?: number; v: number; jitter?: number; dest?: AudioNode; ft?: BiquadFilterType; fJit?: number; vJit?: number }): number {
  const t0 = o.t ?? s.t;
  const g = s.g(0, o.dest ?? s.out);
  const fl = s.f(o.ft ?? 'bandpass', o.f * s.p, o.q ?? 3, g);
  let t = t0;
  const times: number[] = [];
  for (let i = 0; i < o.n; i++) {
    times.push(t);
    const k = o.n > 1 ? i / (o.n - 1) : 0;
    t += (o.i0 + (o.i1 - o.i0) * k) * (1 + (o.jitter ?? 0.15) * (s.r() * 2 - 1));
  }
  const end = times[times.length - 1] + 0.06;
  s.noise('white', t0, end, fl);
  for (let i = 0; i < times.length; i++) {
    const ti = times[i];
    const next = i + 1 < times.length ? times[i + 1] : ti + 0.05;
    const cd = Math.min(o.cd ?? 0.012, (next - ti) * 0.8);
    const v = o.v * (1 - (o.vJit ?? 0.3) * s.r());
    g.gain.setValueAtTime(0, ti);
    g.gain.linearRampToValueAtTime(v, ti + 0.0008);
    g.gain.exponentialRampToValueAtTime(EPS, ti + 0.0008 + Math.max(0.002, cd));
    g.gain.setValueAtTime(0, ti + 0.001 + Math.max(0.002, cd));
    if (o.fJit) fl.frequency.setValueAtTime(o.f * s.p * (1 + o.fJit * (s.r() * 2 - 1)), ti);
  }
  return end;
}

/**
 * Stick-slip creak (wood, vines, ice under load): a low pulse train with jittered rate
 * pushed through resonant body filters.
 */
export function creak(s: Snd, o: { t?: number; d: number; r0: number; r1: number; res: readonly number[]; v: number; q?: number; dest?: AudioNode }): GainNode {
  const t = o.t ?? s.t;
  const g = s.g(0, o.dest ?? s.out);
  const mix = s.g(1);
  for (const f of o.res) {
    const bp = s.f('bandpass', f * s.p, o.q ?? 9, s.g(2.2, g));
    mix.connect(bp);
  }
  const osc = s.osc('sawtooth', o.r0, t, t + o.d + 0.02, mix);
  // jittered stick-slip rate
  const steps = Math.max(2, Math.floor(o.d / 0.03));
  osc.frequency.setValueAtTime(o.r0, t);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const base = o.r0 + (o.r1 - o.r0) * k;
    osc.frequency.linearRampToValueAtTime(Math.max(4, base * (1 + 0.35 * (s.r() * 2 - 1))), t + o.d * k);
  }
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.v, t + Math.min(0.06, o.d * 0.2));
  g.gain.setValueAtTime(o.v, t + o.d * 0.6);
  g.gain.linearRampToValueAtTime(0, t + o.d);
  return g;
}

/** A few rising sine chirps on round-robin oscillators (water drops, bubbles). */
export function drops(s: Snd, o: { t?: number; n: number; span: number; f0: number; f1: number; d: number; v: number; rise?: number; dest?: AudioNode }): void {
  const t0 = o.t ?? s.t;
  const lanes = Math.min(3, o.n);
  const gs: GainNode[] = [];
  const os: OscillatorNode[] = [];
  const times: number[] = [];
  for (let i = 0; i < o.n; i++) times.push(t0 + (o.n > 1 ? (i / (o.n - 1)) * o.span : 0) + s.r(-0.3, 0.3) * (o.span / Math.max(1, o.n)));
  times.sort((a, b) => a - b);
  const end = times[times.length - 1] + o.d + 0.02;
  for (let l = 0; l < lanes; l++) {
    const g = s.g(0, o.dest ?? s.out);
    gs.push(g);
    os.push(s.osc('sine', o.f0 * s.p, Math.max(t0, times[0] - 0.005), end, g));
  }
  const free = new Array<number>(lanes).fill(t0);
  for (let i = 0; i < times.length; i++) {
    const l = i % lanes;
    const ti = Math.max(t0, times[i], free[l]);
    free[l] = ti + o.d + 0.003;
    if (ti + o.d > end) break;
    const f = s.r(o.f0, o.f1) * s.p;
    os[l].frequency.setValueAtTime(f, ti);
    os[l].frequency.exponentialRampToValueAtTime(f * (o.rise ?? 2.2), ti + o.d);
    const v = o.v * s.r(0.5, 1);
    gs[l].gain.setValueAtTime(0, ti);
    gs[l].gain.linearRampToValueAtTime(v, ti + 0.002);
    gs[l].gain.exponentialRampToValueAtTime(EPS, ti + o.d);
    gs[l].gain.setValueAtTime(0, ti + o.d + 0.001);
  }
}
