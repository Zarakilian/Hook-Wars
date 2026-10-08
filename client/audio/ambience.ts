// Looping ambience beds per map (continuous textures + randomly scheduled critters and machinery)
// and a river flow bed that follows the RiverState when one is passed.
import type { MapDef } from '../../shared/maps/types.ts';
import type { MapId, RiverState } from '../../shared/types.ts';
import { STEEL, Snd, bell, creak, drops, mulberry32, noiseHit, perc, sweep, tone, whoosh, type Kit } from './core.ts';
import { speak } from './voice.ts';

interface Gen {
  next: number;
  min: number;
  max: number;
  fn: (s: Snd) => void;
  /** pan range */
  pan: number;
  /** event gain */
  v: number;
  rev: number;
}

interface RiverStyle {
  f1: number;
  f2: number;
  base: number;
}

const RIVER: Record<MapId, RiverStyle> = {
  muckmire: { f1: 300, f2: 720, base: 0.5 },
  frostfang: { f1: 520, f2: 1500, base: 0.5 },
  coralcove: { f1: 620, f2: 1700, base: 0.36 },
  cogwater: { f1: 360, f2: 950, base: 0.5 },
};

// ---------------------------------------------------------------------------------------------
// generated seamless loops (cached per context)
// ---------------------------------------------------------------------------------------------

const loopCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

function cachedLoop(ctx: BaseAudioContext, name: string, make: () => AudioBuffer): AudioBuffer {
  let m = loopCache.get(ctx);
  if (!m) {
    m = new Map();
    loopCache.set(ctx, m);
  }
  let b = m.get(name);
  if (!b) {
    b = make();
    m.set(name, b);
  }
  return b;
}

function cricketLoop(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const L = 6;
  const n = sr * L;
  const buf = ctx.createBuffer(2, n, sr);
  const ch = [buf.getChannelData(0), buf.getChannelData(1)];
  const rng = mulberry32(4242);
  for (let c = 0; c < 6; c++) {
    const f = Math.round((4100 + rng() * 1100) * L) / L; // integer cycles per loop: seamless
    const pan = rng() * 1.6 - 0.8;
    const amp = 0.18 + rng() * 0.3;
    const chirps = 6 + Math.floor(rng() * 6); // chirps per loop (integer: seamless)
    const period = L / chirps;
    const pulses = 3 + Math.floor(rng() * 3);
    const prate = 26 + rng() * 14;
    const phase = rng() * period;
    const gl = Math.sqrt(0.5 * (1 - pan));
    const gr = Math.sqrt(0.5 * (1 + pan));
    const w = 2 * Math.PI * f;
    // only the samples inside pulses are touched (wrapping at the loop end)
    for (let k = 0; k < chirps; k++) {
      const start = k * period - phase;
      const s0 = Math.floor(start * sr);
      const m = Math.floor((pulses / prate) * sr);
      for (let i = 0; i < m; i++) {
        const j = (((s0 + i) % n) + n) % n;
        const t = j / sr;
        const pp = (i / sr) * prate;
        const win = Math.sin(Math.PI * (pp % 1));
        const swell = 0.75 + 0.25 * Math.sin((2 * Math.PI * t) / L + c);
        const v = Math.sin(w * t) * win * win * amp * swell;
        ch[0][j] += v * gl;
        ch[1][j] += v * gr;
      }
    }
  }
  return buf;
}

function rainLoop(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const L = 5;
  const n = sr * L;
  const buf = ctx.createBuffer(2, n, sr);
  const ch = [buf.getChannelData(0), buf.getChannelData(1)];
  const rng = mulberry32(777);
  // droplets, wrapped modulo the loop so the seam is invisible
  const drops = 4200;
  for (let k = 0; k < drops; k++) {
    const s0 = Math.floor(rng() * n);
    const big = rng() < 0.06;
    const f = big ? 700 + rng() * 1100 : 1800 + rng() * 5600;
    const dec = (big ? 0.006 : 0.0015 + rng() * 0.002) * sr;
    const a = big ? 0.25 + rng() * 0.3 : 0.04 + rng() * 0.12;
    const pan = rng() * 2 - 1;
    const gl = Math.sqrt(0.5 * (1 - pan));
    const gr = Math.sqrt(0.5 * (1 + pan));
    const len = Math.floor(dec * 5);
    const w = (2 * Math.PI * f) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let c = 1;
    let sn = 0;
    let env = a;
    const mul = Math.exp(-1 / dec);
    for (let i = 0; i < len; i++) {
      const v = sn * env;
      const j = (s0 + i) % n;
      ch[0][j] += v * gl;
      ch[1][j] += v * gr;
      const nc = c * cw - sn * sw;
      sn = sn * cw + c * sw;
      c = nc;
      env *= mul;
    }
  }
  // soft hiss, filtered twice round for a seamless loop
  for (let c = 0; c < 2; c++) {
    let y = 0;
    const white = new Float32Array(n);
    for (let i = 0; i < n; i++) white[i] = rng() * 2 - 1;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        y += 0.35 * (white[i] - y);
        if (pass === 1) ch[c][i] += y * 0.12;
      }
    }
  }
  let pk = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(ch[c][i]));
  const g = 0.8 / Math.max(1e-6, pk);
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) ch[c][i] *= g;
  return buf;
}

// ---------------------------------------------------------------------------------------------
// critters and machinery (event recipes; each Snd already sits behind a panner)
// ---------------------------------------------------------------------------------------------

function frog(s: Snd): void {
  const kind = s.r();
  if (kind < 0.55) {
    // ribbit: two buzzy pulses
    const f = s.r(150, 260);
    for (let k = 0; k < 2; k++) {
      const t = s.t + k * s.r(0.12, 0.16);
      const g = s.g(0, s.f('bandpass', s.r(700, 1100), 3, s.out));
      const am = s.g(0.5, g);
      s.osc('sine', s.r(32, 44), t, t + 0.12, s.g(0.5, am.gain));
      const o = s.osc('square', f, t, t + 0.12, am);
      sweep(o.frequency, t, f * 1.1, f * 0.92, 0.1);
      perc(g.gain, t, 0.6, 0.01, 0.1);
    }
  } else if (kind < 0.8) {
    // spring peeper
    const f = s.r(2500, 3100);
    for (let k = 0; k < s.ri(1, 3); k++) tone(s, { t: s.t + k * 0.35, f: f * 0.9, f1: f * 1.1, a: 0.01, d: 0.09, v: 0.35 });
  } else {
    // bullfrog "rrrum"
    const g = s.g(0, s.f('lowpass', 500, 2, s.out));
    const am = s.g(0.5, g);
    s.osc('sine', 22, s.t, s.t + 0.6, s.g(0.5, am.gain));
    s.osc('sawtooth', s.r(85, 105), s.t, s.t + 0.6, am);
    g.gain.setValueAtTime(0, s.t);
    g.gain.linearRampToValueAtTime(0.7, s.t + 0.08);
    g.gain.setTargetAtTime(0, s.t + 0.35, 0.06);
  }
}

function owl(s: Snd): void {
  const f = s.r(340, 390);
  const hoot = (t: number, d: number, k: number) => {
    const g = s.g(0, s.f('lowpass', 900, 0.7, s.out));
    const o = s.osc('sine', f * k, t, t + d + 0.1, g);
    sweep(o.frequency, t, f * k * 1.04, f * k * 0.94, d);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.6, t + 0.06);
    g.gain.setTargetAtTime(0, t + d * 0.6, 0.06);
  };
  hoot(s.t, 0.4, 1);
  hoot(s.t + 0.75, 0.18, 1.02);
  hoot(s.t + 1.0, 0.45, 0.98);
}

function flyBy(s: Snd): void {
  const d = s.r(1.6, 2.6);
  const g = s.g(0, s.out);
  const bp = s.f('bandpass', 900, 1.5, g);
  s.f('bandpass', 2400, 3, s.g(0.5, g));
  const o = s.osc('sawtooth', s.r(190, 235), s.t, s.t + d, bp);
  sweep(o.frequency, s.t, o.frequency.value * 1.06, o.frequency.value * 0.94, d);
  const vib = s.g(6, o.frequency);
  s.osc('sine', s.r(9, 14), s.t, s.t + d, vib);
  g.gain.setValueAtTime(0, s.t);
  g.gain.linearRampToValueAtTime(0.3, s.t + d * 0.45);
  g.gain.linearRampToValueAtTime(0, s.t + d);
}

function gull(s: Snd): void {
  const n = s.ri(1, 3);
  for (let k = 0; k < n; k++) {
    const t = s.t + k * s.r(0.3, 0.45);
    const g = s.g(0, s.f('bandpass', 1900, 1.4, s.out));
    const o = s.osc('sawtooth', 1100, t, t + 0.4, g);
    const f0 = s.r(1000, 1250);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 1.55, t + 0.06);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.82, t + 0.32);
    const vib = s.g(f0 * 0.03, o.frequency);
    s.osc('sine', 28, t, t + 0.4, vib);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.04);
    g.gain.setTargetAtTime(0, t + 0.22, 0.05);
  }
}

function wave(s: Snd): void {
  const d = s.r(3.2, 4.4);
  const g = s.g(0, s.out);
  const lp = s.f('lowpass', 300, 0.7, g);
  s.noise('pink', s.t, s.t + d, lp);
  lp.frequency.setValueAtTime(260, s.t);
  lp.frequency.exponentialRampToValueAtTime(2300, s.t + d * 0.42);
  lp.frequency.exponentialRampToValueAtTime(500, s.t + d);
  g.gain.setValueAtTime(0, s.t);
  g.gain.linearRampToValueAtTime(0.7, s.t + d * 0.4);
  g.gain.linearRampToValueAtTime(0, s.t + d);
  // foam fizz as it breaks
  noiseHit(s, { t: s.t + d * 0.38, ft: 'highpass', f: 3500, a: 0.25, d: d * 0.5, v: 0.14, q: 0.6, pitched: false });
}

function gust(s: Snd): void {
  whoosh(s, { d: s.r(2.2, 3.4), f0: 250, fp: s.r(900, 1500), f1: 300, q: 1.6, v: 0.5, peakAt: 0.45 });
}

function iceCreak(s: Snd): void {
  creak(s, { d: s.r(0.5, 1.1), r0: s.r(14, 22), r1: s.r(24, 40), res: [s.r(150, 220), s.r(380, 480), s.r(850, 1000)], v: 0.4, q: 12 });
}

function icePing(s: Snd): void {
  const g = s.g(0, s.out);
  const o = s.osc('sine', 3800, s.t, s.t + 0.25, g);
  sweep(o.frequency, s.t, s.r(3200, 4400), s.r(220, 320), 0.18);
  perc(g.gain, s.t, 0.35, 0.001, 0.2);
}

function wolf(s: Snd): void {
  speak(s, [['u', 0.5, 0, 4], ['o', 1.0, 4, 1], ['u', 0.5, 1, -3]], { f0: 420, v: 0.25, vib: 0.02, shift: 1.3 });
}

function drip(s: Snd): void {
  const f = s.r(1200, 2600);
  const g = s.g(0, s.out);
  const o = s.osc('sine', f, s.t, s.t + 0.09, g);
  sweep(o.frequency, s.t, f, f * 1.9, 0.05);
  perc(g.gain, s.t, 0.5, 0.001, 0.07);
  if (s.chance(0.4)) drops(s, { t: s.t + 0.08, n: 2, span: 0.06, f0: f * 1.2, f1: f * 1.6, d: 0.04, v: 0.12 });
}

function farHorn(s: Snd): void {
  const g = s.g(0, s.f('lowpass', 380, 1.5, s.out));
  const f = s.r(70, 78);
  s.osc('sawtooth', f, s.t, s.t + 2.6, g);
  s.osc('sawtooth', f * 1.007, s.t, s.t + 2.6, g);
  g.gain.setValueAtTime(0, s.t);
  g.gain.linearRampToValueAtTime(0.4, s.t + 0.4);
  g.gain.setValueAtTime(0.4, s.t + 1.6);
  g.gain.setTargetAtTime(0, s.t + 1.6, 0.25);
}

function clank(s: Snd): void {
  bell(s, { f: s.r(300, 520), d: s.r(0.6, 1.0), v: 0.4, partials: STEEL });
  noiseHit(s, { ft: 'bandpass', f: 1800, q: 1, a: 0.001, d: 0.04, v: 0.3, pitched: false });
  if (s.chance(0.5)) bell(s, { t: s.t + s.r(0.18, 0.3), f: s.r(300, 520), d: 0.5, v: 0.22, partials: STEEL });
}

function farHiss(s: Snd): void {
  noiseHit(s, { ft: 'highpass', f: 2600, f1: 1800, a: 0.12, d: s.r(0.8, 1.4), v: 0.35, q: 0.6, pitched: false });
}

// ---------------------------------------------------------------------------------------------
// a bed
// ---------------------------------------------------------------------------------------------

class Bed {
  readonly mapId: MapId;
  readonly gain: GainNode;
  readonly srcs: AudioScheduledSourceNode[] = [];
  readonly gens: Gen[] = [];
  readonly riverGain: GainNode;
  readonly rushGain: GainNode;
  killAt = Infinity;
  private readonly style: RiverStyle;
  private lastLevel = -1;
  private lastAt = 0;
  private riverTarget = -1;
  private rush = 0;
  private lastRush = -1;

  constructor(kit: Kit, map: MapDef, dest: AudioNode, now: number) {
    const ctx = kit.ctx;
    this.mapId = map.id;
    this.style = RIVER[map.id];
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0, now);
    this.gain.gain.linearRampToValueAtTime(1, now + 2.5);
    this.gain.connect(dest);
    const s = new Snd(kit, this.gain, null, now, 1);
    const loopNoise = (kind: 'white' | 'pink' | 'brown', destN: AudioNode, rate = 1) => {
      const b = ctx.createBufferSource();
      b.buffer = kind === 'white' ? kit.white : kind === 'pink' ? kit.pink : kit.brown;
      b.loop = true;
      b.playbackRate.value = rate;
      b.connect(destN);
      b.start(now, Math.random() * 2);
      this.srcs.push(b);
      return b;
    };
    const loopBuf = (buf: AudioBuffer, destN: AudioNode) => {
      const b = ctx.createBufferSource();
      b.buffer = buf;
      b.loop = true;
      b.connect(destN);
      b.start(now, Math.random() * buf.duration);
      this.srcs.push(b);
      return b;
    };
    const lfo = (f: number, depth: number, target: AudioParam, type: OscillatorType = 'sine') => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g).connect(target);
      o.start(now);
      this.srcs.push(o);
      return o;
    };
    const constOsc = (type: OscillatorType, f: number, v: number, destN: AudioNode) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(s.g(v, destN));
      o.start(now);
      this.srcs.push(o);
    };
    const gen = (fn: Gen['fn'], min: number, max: number, v: number, pan = 0.9, rev = 0.25, first = 0.5) => {
      this.gens.push({ fn, min, max, v, pan, rev, next: now + first + Math.random() * (max - min) * 0.6 });
    };

    // ---- river flow bed (all maps)
    this.riverGain = s.g(0, this.gain);
    const rv = s.g(1, this.riverGain);
    const b1 = s.f('bandpass', this.style.f1, 0.7, s.g(0.9, rv));
    const b2 = s.f('bandpass', this.style.f2, 1.6, s.g(0.55, rv));
    const rIn = s.g(1);
    rIn.connect(b1);
    rIn.connect(b2);
    loopNoise('pink', rIn);
    lfo(0.23, this.style.f2 * 0.3, b2.frequency);
    lfo(0.11, this.style.f1 * 0.2, b1.frequency);
    lfo(0.17, 0.25, rv.gain);
    this.rushGain = s.g(0, this.gain);
    const rush = s.f('highpass', 800, 0.7, s.f('lowpass', 5200, 0.7, this.rushGain));
    loopNoise('white', rush);
    this.setRiver(null, now);

    // ---- per map texture
    const id = map.id;
    if (id === 'muckmire') {
      loopNoise('brown', s.f('lowpass', 320, 0.7, s.g(0.32, this.gain)));
      const cr = s.g(0.14, s.f('highpass', 3000, 0.7, this.gain));
      loopBuf(cachedLoop(ctx, 'crickets', () => cricketLoop(ctx)), cr);
      lfo(0.05, 0.05, cr.gain);
      gen(frog, 1.0, 3.6, 0.32, 0.9, 0.18, 0.3);
      gen(frog, 2.5, 6.0, 0.22, 0.9, 0.3, 1.5);
      gen(owl, 15, 30, 0.2, 0.8, 0.6, 6);
      gen(flyBy, 9, 18, 0.16, 0.9, 0.1, 4);
    } else if (id === 'frostfang') {
      const wind = s.g(0.55, this.gain);
      const w1 = s.f('bandpass', 600, 2.5, s.g(1.0, wind));
      const w2 = s.f('bandpass', 1400, 7, s.g(0.9, wind));
      const wl = s.f('lowpass', 450, 0.7, s.g(0.8, wind));
      const wIn = s.g(1);
      wIn.connect(w1);
      wIn.connect(w2);
      wIn.connect(wl);
      loopNoise('pink', wIn);
      lfo(0.061, 320, w1.frequency);
      lfo(0.093, 560, w2.frequency);
      lfo(0.045, 0.3, wind.gain);
      gen(gust, 5, 11, 0.32, 0.9, 0.3, 2);
      gen(iceCreak, 4, 11, 0.3, 0.9, 0.5, 3);
      gen(icePing, 12, 26, 0.12, 0.9, 0.7, 7);
      gen(wolf, 40, 75, 0.12, 0.9, 0.8, 18);
    } else if (id === 'coralcove') {
      const surf = s.g(0.42, this.gain);
      loopNoise('brown', s.f('lowpass', 650, 0.7, surf));
      lfo(0.11, 0.18, surf.gain);
      const breeze = s.g(0.05, s.f('highpass', 1800, 0.6, this.gain));
      loopNoise('pink', breeze, 0.9);
      lfo(0.07, 0.03, breeze.gain);
      // the waterfall, far off
      loopNoise('white', s.f('bandpass', 1100, 0.5, s.g(0.05, this.gain)), 0.8);
      gen(wave, 4.5, 8, 0.38, 0.7, 0.15, 0.6);
      gen(gull, 4, 12, 0.18, 0.95, 0.4, 2.5);
    } else {
      const rain = s.g(0.34, this.gain);
      loopBuf(cachedLoop(ctx, 'rain', () => rainLoop(ctx)), rain);
      loopNoise('pink', s.f('highpass', 2600, 0.6, s.g(0.07, this.gain)));
      const hum = s.g(0.5, this.gain);
      constOsc('sine', 55, 0.12, hum);
      constOsc('sine', 110, 0.06, hum);
      constOsc('sine', 165, 0.03, hum);
      constOsc('sawtooth', 55.3, 0.05, s.f('lowpass', 190, 0.8, hum));
      lfo(0.3, 0.12, hum.gain);
      gen(drip, 0.6, 2.4, 0.22, 0.9, 0.45, 0.4);
      gen(farHorn, 35, 60, 0.12, 0.7, 0.8, 14);
      gen(clank, 8, 20, 0.12, 0.9, 0.7, 5);
      gen(farHiss, 12, 26, 0.08, 0.9, 0.5, 9);
    }
  }

  /** Retarget the river flow bed. Cheap; safe to call every frame (writes only on change). */
  setRiver(river: RiverState | null, now: number): void {
    const base = this.style.base;
    let target: number;
    if (!river) {
      target = base * 0.85;
      this.rush = 0;
    } else if (river.frozen) {
      target = base * 0.05;
      this.rush = 0;
      this.lastLevel = -1;
    } else {
      const lv = river.level;
      target = base * (lv < 0.08 ? 0.04 + lv * 0.6 : 0.25 + 0.75 * lv);
      // rising / falling water: a rushing layer, from the level change over a quarter second
      if (this.lastLevel < 0) {
        this.lastLevel = lv;
        this.lastAt = now;
      } else if (now - this.lastAt >= 0.25) {
        const rate = (lv - this.lastLevel) / (now - this.lastAt);
        this.rush = Math.min(0.45, Math.abs(rate) * 6);
        this.lastLevel = lv;
        this.lastAt = now;
      }
    }
    if (Math.abs(target - this.riverTarget) > 0.004) {
      this.riverTarget = target;
      this.riverGain.gain.setTargetAtTime(target, now, 0.6);
    }
    if (Math.abs(this.rush - this.lastRush) > 0.01) {
      this.lastRush = this.rush;
      this.rushGain.gain.setTargetAtTime(this.rush * base, now, 0.5);
    }
  }

  stop(now: number): void {
    if (this.killAt !== Infinity) return;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.setTargetAtTime(0, now, 0.4);
    this.killAt = now + 3;
    for (const src of this.srcs) {
      try {
        src.stop(now + 3);
      } catch {
        // ok
      }
    }
  }
}

export class Ambience {
  private readonly kit: Kit;
  private readonly dest: AudioNode;
  private readonly send: AudioNode | null;
  private bed: Bed | null = null;
  private readonly dying: Bed[] = [];
  private readonly live: { node: AudioNode; end: number }[] = [];

  constructor(kit: Kit, dest: AudioNode, send: AudioNode | null) {
    this.kit = kit;
    this.dest = dest;
    this.send = send;
  }

  get mapId(): MapId | null {
    return this.bed?.mapId ?? null;
  }

  set(map: MapDef | null, river: RiverState | null, now: number): void {
    if (map && this.bed && this.bed.mapId === map.id) {
      this.bed.setRiver(river, now);
      return;
    }
    if (this.bed) {
      this.bed.stop(now);
      this.dying.push(this.bed);
      this.bed = null;
    }
    if (!map) return;
    this.bed = new Bed(this.kit, map, this.dest, now);
    if (river) this.bed.setRiver(river, now);
  }

  /** Fire due random events. */
  tick(now: number, lookahead: number): void {
    for (let k = this.dying.length - 1; k >= 0; k--) {
      const b = this.dying[k];
      if (now > b.killAt) {
        try {
          b.gain.disconnect();
        } catch {
          // ok
        }
        this.dying.splice(k, 1);
      }
    }
    for (let k = this.live.length - 1; k >= 0; k--) {
      if (now > this.live[k].end) {
        try {
          this.live[k].node.disconnect();
        } catch {
          // ok
        }
        this.live.splice(k, 1);
      }
    }
    const bed = this.bed;
    if (!bed) return;
    for (const g of bed.gens) {
      if (g.next < now - 1) g.next = now + Math.random() * 0.5; // fell behind: do not burst
      if (g.next > now + lookahead) continue;
      const pan = (Math.random() * 2 - 1) * g.pan;
      const vg = this.kit.ctx.createGain();
      vg.gain.value = g.v * (0.6 + Math.random() * 0.4);
      vg.connect(bed.gain);
      const at = Math.max(now + 0.01, g.next);
      const p = new Snd(this.kit, vg, null, at, 1).panner(pan, vg);
      const ev = new Snd(this.kit, p, this.send, at, 0.92 + Math.random() * 0.16);
      try {
        g.fn(ev);
        if (this.send && g.rev > 0) ev.send(p, g.rev * 0.5);
      } catch {
        // an ambient detail must never break the frame
      }
      // free the event chain once it is done
      this.live.push({ node: vg, end: ev.end + 0.6 });
      g.next = Math.max(now, g.next) + g.min + Math.random() * (g.max - g.min);
    }
  }

  dispose(now: number): void {
    this.set(null, null, now);
  }
}
