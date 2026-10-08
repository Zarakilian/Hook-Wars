// Adaptive music: lookahead scheduler over the pure patterns in patterns.ts, synth instruments,
// per-mood tracks with crossfades and an intensity layer driven by combat heat.
import type { MusicMood } from '../render/contracts.ts';
import { EPS, Snd, midiHz, noiseHit, tone, type Kit } from './core.ts';
import { SONGS, swingOffset, type Inst, type NoteEv, type Song } from './patterns.ts';
import { brass, cymbal } from './sfx.ts';

/** Instrument bus levels inside a track. */
const LEVEL: Record<Inst, number> = {
  acc: 0.55,
  fiddle: 0.5,
  whistle: 0.42,
  bass: 0.85,
  pluck: 0.32,
  bodhran: 0.62,
  rim: 0.4,
  stomp: 0.5,
  shaker: 0.22,
  tamb: 0.26,
  cymbal: 0.5,
  timp: 0.55,
  brass: 0.45,
};

/** Reverb send per instrument. */
const SEND: Partial<Record<Inst, number>> = { acc: 0.18, fiddle: 0.28, whistle: 0.32, pluck: 0.2, bodhran: 0.12, brass: 0.3, cymbal: 0.25, timp: 0.2 };

class Band {
  readonly out: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly buses = new Map<string, AudioNode>();
  private readonly lfos: OscillatorNode[] = [];
  private readonly send: AudioNode | null;
  private readonly layerGains: GainNode[] = [];
  private readonly sendGains: GainNode[] = [];
  private layerLevel = 0;

  constructor(ctx: BaseAudioContext, dest: AudioNode, send: AudioNode | null) {
    this.ctx = ctx;
    this.send = send;
    this.out = ctx.createGain();
    this.out.connect(dest);
  }

  /** Input node for an instrument, main or intensity layer. */
  bus(i: Inst, layer: boolean): AudioNode {
    const key = layer ? `${i}:L` : i;
    const have = this.buses.get(key);
    if (have) return have;
    if (layer) {
      // the layer input is a gain in front of the instrument chain, driven by combat intensity
      const g = this.ctx.createGain();
      g.gain.value = this.layerLevel;
      g.connect(this.bus(i, false));
      this.layerGains.push(g);
      this.buses.set(key, g);
      return g;
    }
    const level = this.ctx.createGain();
    level.gain.value = LEVEL[i];
    level.connect(this.out);
    const sendAmt = SEND[i] ?? 0;
    if (this.send && sendAmt > 0) {
      const sg = this.ctx.createGain();
      sg.gain.value = sendAmt;
      level.connect(sg);
      sg.connect(this.send);
      this.sendGains.push(sg);
    }
    let head: AudioNode = level;
    if (i === 'acc') {
      // bellows tremolo and a soft reed top end
      const trem = this.ctx.createGain();
      trem.gain.value = 0.88;
      trem.connect(level);
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 5.2;
      const depth = this.ctx.createGain();
      depth.gain.value = 0.1;
      lfo.connect(depth).connect(trem.gain);
      lfo.start();
      this.lfos.push(lfo);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2900;
      lp.Q.value = 0.5;
      lp.connect(trem);
      head = lp;
    } else if (i === 'fiddle') {
      // violin body resonances
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6500;
      lp.connect(level);
      const p2 = this.peq(2500, 1.2, 4, lp);
      const p1 = this.peq(470, 1.4, 3.5, p2);
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 190;
      hp.connect(p1);
      head = hp;
    } else if (i === 'whistle') {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 7500;
      lp.connect(level);
      head = lp;
    } else if (i === 'pluck') {
      head = this.peq(1800, 1, 3, level);
    }
    this.buses.set(key, head);
    return head;
  }

  private peq(f: number, q: number, db: number, dest: AudioNode): BiquadFilterNode {
    const n = this.ctx.createBiquadFilter();
    n.type = 'peaking';
    n.frequency.value = f;
    n.Q.value = q;
    n.gain.value = db;
    n.connect(dest);
    return n;
  }

  /** current intensity-layer target */
  get layer(): number {
    return this.layerLevel;
  }

  setLayer(v: number, now: number): void {
    this.layerLevel = v;
    for (const g of this.layerGains) g.gain.setTargetAtTime(v, now, 0.9);
  }

  stop(at: number): void {
    for (const l of this.lfos) {
      try {
        l.stop(at);
      } catch {
        // already stopped
      }
    }
  }

  disconnect(): void {
    try {
      this.out.disconnect();
      for (const g of this.sendGains) g.disconnect();
    } catch {
      // already disconnected
    }
  }
}

// ---------------------------------------------------------------------------------------------
// instruments
// ---------------------------------------------------------------------------------------------

function acc(s: Snd, dest: AudioNode, t: number, m: number, dur: number, v: number): void {
  const f = midiHz(m);
  const g = s.g(0, dest);
  const end = t + dur + 0.2;
  s.osc(s.kit.reed, f, t, end, g).detune.value = -7;
  s.osc(s.kit.reed, f, t, end, g).detune.value = 7;
  const a = dur > 1.2 ? 0.14 : 0.02;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v * 0.5, t + a);
  g.gain.setTargetAtTime(v * 0.4, t + a, 0.08);
  g.gain.setTargetAtTime(0, t + dur, dur > 1.2 ? 0.08 : 0.025);
  g.gain.setValueAtTime(0, end);
}

function fiddle(s: Snd, dest: AudioNode, t: number, m: number, dur: number, v: number): void {
  const f = midiHz(m);
  const g = s.g(0, dest);
  const end = t + dur + 0.25;
  const o = s.osc(s.kit.bow, f, t, end, g);
  o.frequency.setValueAtTime(f * 0.988, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.045);
  if (dur > 0.22) {
    const vg = s.g(0, o.frequency);
    s.osc('sine', 5.5 + s.r(-0.3, 0.3), t, end, vg);
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(0, t + 0.12);
    vg.gain.linearRampToValueAtTime(f * 0.0075, t + 0.4);
  }
  const a = Math.min(0.06, dur * 0.3);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v * 0.5, t + a);
  g.gain.setTargetAtTime(v * 0.42, t + a, 0.1);
  g.gain.setTargetAtTime(0, t + dur, 0.045);
  g.gain.setValueAtTime(0, end);
}

function whistle(s: Snd, dest: AudioNode, t: number, m: number, dur: number, v: number): void {
  const f = midiHz(m);
  const g = s.g(0, dest);
  const end = t + dur + 0.2;
  const o = s.osc('sine', f, t, end, g);
  const o2 = s.osc('triangle', f * 2, t, end, s.g(0.06, g));
  if (dur > 0.25) {
    const vg = s.g(0, o.frequency);
    s.osc('sine', 5.8, t, end, vg);
    vg.gain.setValueAtTime(0, t + 0.1);
    vg.gain.linearRampToValueAtTime(f * 0.009, t + 0.35);
    vg.connect(o2.frequency);
  }
  // breathy chiff at the onset
  noiseHit(s, { t, ft: 'bandpass', f: f * 2, q: 2, a: 0.004, d: 0.05, v: v * 0.12, dest, pitched: false });
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v * 0.45, t + 0.03);
  g.gain.setTargetAtTime(v * 0.36, t + 0.03, 0.1);
  g.gain.setTargetAtTime(0, t + dur, 0.04);
  g.gain.setValueAtTime(0, end);
}

function bass(s: Snd, dest: AudioNode, t: number, m: number, dur: number, v: number): void {
  const f = midiHz(m);
  const g = s.g(0, dest);
  const lp = s.f('lowpass', 1300, 1.2, g);
  const end = t + dur + 0.2;
  s.osc('triangle', f, t, end, lp);
  s.osc('sawtooth', f, t, end, s.g(0.18, lp));
  s.osc('sine', f, t, end, s.g(0.6, g));
  lp.frequency.setValueAtTime(1500, t);
  lp.frequency.exponentialRampToValueAtTime(420, t + 0.18);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v * 0.6, t + 0.006);
  g.gain.setTargetAtTime(v * 0.36, t + 0.01, 0.12);
  g.gain.setTargetAtTime(0, t + dur, 0.05);
  g.gain.setValueAtTime(0, end);
}

function pluck(s: Snd, dest: AudioNode, t: number, m: number, dur: number, v: number): void {
  const f = midiHz(m);
  const g = s.g(0, dest);
  const lp = s.f('lowpass', 3200, 1, g);
  const end = t + Math.min(dur, 0.9) + 0.05;
  s.osc('sawtooth', f, t, end, lp).detune.value = -4;
  s.osc('sawtooth', f * 2, t, end, s.g(0.3, lp)).detune.value = 5;
  lp.frequency.setValueAtTime(3600, t);
  lp.frequency.exponentialRampToValueAtTime(500, t + 0.25);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v * 0.4, t + 0.003);
  g.gain.exponentialRampToValueAtTime(EPS, end);
}

function playEvent(s: Snd, band: Band, e: NoteEv, t: number, eighth: number): void {
  const dest = band.bus(e.i, e.layer === 1);
  const dur = e.d * eighth;
  const v = e.v;
  switch (e.i) {
    case 'acc':
      acc(s, dest, t, e.n, dur, v);
      break;
    case 'fiddle':
      fiddle(s, dest, t, e.n, dur, v);
      break;
    case 'whistle':
      whistle(s, dest, t, e.n, dur, v);
      break;
    case 'bass':
      bass(s, dest, t, e.n, dur, v);
      break;
    case 'pluck':
      pluck(s, dest, t, e.n, dur, v);
      break;
    case 'bodhran':
      tone(s, { t, f: 132 * s.r(0.98, 1.02), f1: 62, sw: 0.08, a: 0.002, d: 0.32, v, dest });
      noiseHit(s, { t, ft: 'bandpass', f: 850, q: 1, a: 0.0008, d: 0.03, v: v * 0.32, dest });
      break;
    case 'rim':
      noiseHit(s, { t, ft: 'bandpass', f: 2600, q: 3, a: 0.0005, d: 0.02, v, dest });
      tone(s, { t, f: 920, a: 0.0005, d: 0.02, v: v * 0.4, dest });
      break;
    case 'stomp':
      tone(s, { t, f: 82, f1: 44, a: 0.002, d: 0.18, v, dest });
      noiseHit(s, { t, ft: 'lowpass', f: 320, a: 0.001, d: 0.08, v: v * 0.6, dest });
      noiseHit(s, { t, ft: 'bandpass', f: 1300, q: 1.5, a: 0.0005, d: 0.02, v: v * 0.3, dest });
      break;
    case 'shaker':
      noiseHit(s, { t, ft: 'highpass', f: 5600, q: 0.7, a: 0.009, d: 0.05, v, dest });
      break;
    case 'tamb':
      noiseHit(s, { t, ft: 'highpass', f: 6000, q: 0.7, a: 0.002, d: 0.06, v, dest });
      noiseHit(s, { t, ft: 'bandpass', f: 8600, q: 5, a: 0.001, d: 0.14, v: v * 0.7, dest });
      break;
    case 'cymbal': {
      const sub = new Snd(s.kit, dest, null, t, 1);
      cymbal(sub, t, Math.min(4, dur), v);
      for (const src of sub.srcs) s.srcs.push(src);
      break;
    }
    case 'timp':
      tone(s, { t, f: midiHz(e.n) * 1.04, f1: midiHz(e.n), sw: 0.05, a: 0.002, d: 1.2, v, dest });
      noiseHit(s, { t, ft: 'lowpass', f: 400, a: 0.001, d: 0.12, v: v * 0.4, dest });
      break;
    case 'brass': {
      const sub = new Snd(s.kit, dest, null, t, 1);
      brass(sub, t, [50, 57, 62, 66, 69, 74], Math.min(3, dur), v, 1.1);
      for (const src of sub.srcs) s.srcs.push(src);
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// tracks and the player
// ---------------------------------------------------------------------------------------------

class Track {
  readonly song: Song;
  readonly band: Band;
  readonly gain: GainNode;
  bar = 0;
  loopN = 0;
  /** eighth-note step inside the bar */
  step = 0;
  evs: NoteEv[] | null = null;
  /** start time of the current bar */
  next: number;
  done = false;
  killAt = Infinity;
  fading = false;
  lastSrcEnd = 0;

  constructor(ctx: BaseAudioContext, song: Song, dest: AudioNode, send: AudioNode | null, start: number) {
    this.song = song;
    this.gain = ctx.createGain();
    this.gain.connect(dest);
    this.band = new Band(ctx, this.gain, send);
    this.next = start;
  }

  barDur(): number {
    return this.song.bar * this.song.eighth;
  }
}

export interface MusicOpts {
  /** seconds of lookahead (larger when the tab is hidden and timers are throttled) */
  lookahead: number;
}

export class MusicPlayer {
  private readonly kit: Kit;
  private readonly dest: AudioNode;
  private readonly send: AudioNode | null;
  private readonly tracks: Track[] = [];
  private mood: MusicMood = 'none';
  private intensity = 0;
  private lastLayer = -1;

  constructor(kit: Kit, dest: AudioNode, send: AudioNode | null) {
    this.kit = kit;
    this.dest = dest;
    this.send = send;
  }

  get current(): MusicMood {
    return this.mood;
  }

  setMood(mood: MusicMood, now: number): void {
    if (mood === this.mood) return;
    const prev = this.mood;
    this.mood = mood;
    const stinger = mood === 'victory' || mood === 'defeat';
    for (const tr of this.tracks) {
      if (tr.fading) continue;
      tr.fading = true;
      const tc = stinger ? 0.12 : prev === 'menu' || mood === 'none' ? 0.5 : 0.45;
      tr.gain.gain.cancelScheduledValues(now);
      tr.gain.gain.setValueAtTime(tr.gain.gain.value, now);
      tr.gain.gain.setTargetAtTime(0, now, tc);
      tr.killAt = now + tc * 7 + 0.2;
    }
    if (mood === 'none') return;
    const song = SONGS[mood];
    const start = now + (stinger ? 0.05 : 0.12);
    const tr = new Track(this.kit.ctx, song, this.dest, this.send, start);
    if (stinger) tr.gain.gain.value = 1;
    else {
      tr.gain.gain.setValueAtTime(0, now);
      tr.gain.gain.linearRampToValueAtTime(1, now + (prev === 'none' ? 2.5 : 1.6));
    }
    tr.band.setLayer(this.layerLevel(mood), now);
    this.tracks.push(tr);
  }

  private layerLevel(mood: MusicMood): number {
    if (mood === 'match') return Math.min(1, this.intensity);
    if (mood === 'tense') return Math.min(1, 0.55 + this.intensity * 0.45);
    return 0;
  }

  /** 0..1 combat intensity; drives the match/tense layers. */
  setIntensity(v: number, now: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
    const lv = this.layerLevel(this.mood);
    if (Math.abs(lv - this.lastLayer) < 0.03) return;
    this.lastLayer = lv;
    for (const tr of this.tracks) if (!tr.fading) tr.band.setLayer(lv, now);
  }

  /** Schedule everything due before now + lookahead, one eighth-note step at a time. Safe to call often. */
  tick(now: number, o: MusicOpts): void {
    for (let k = this.tracks.length - 1; k >= 0; k--) {
      const tr = this.tracks[k];
      if (now > tr.killAt || (tr.done && now > tr.lastSrcEnd + 0.5)) {
        tr.band.stop(now);
        tr.band.disconnect();
        try {
          tr.gain.disconnect();
        } catch {
          // ok
        }
        this.tracks.splice(k, 1);
        continue;
      }
      if (tr.done) continue;
      const e8 = tr.song.eighth;
      // fell behind (stall, hidden tab, resumed context): skip ahead instead of dumping a burst
      if (tr.next + tr.step * e8 < now - 0.05) {
        while (!tr.done && tr.next + tr.step * e8 < now) this.stepOn(tr);
        if (tr.done) continue;
      }
      while (!tr.done && tr.next + tr.step * e8 < now + o.lookahead) {
        this.scheduleStep(tr);
        this.stepOn(tr);
      }
    }
  }

  private stepOn(tr: Track): void {
    tr.step++;
    if (tr.step < tr.song.bar) return;
    tr.step = 0;
    tr.evs = null;
    tr.next += tr.barDur();
    tr.bar++;
    if (tr.bar >= tr.song.bars) {
      if (tr.song.loop) {
        tr.bar = 0;
        tr.loopN++;
      } else {
        tr.done = true;
      }
    }
  }

  private scheduleStep(tr: Track): void {
    const song = tr.song;
    if (!tr.evs) tr.evs = song.events(tr.loopN, tr.bar);
    const s = new Snd(this.kit, tr.band.out, null, tr.next, 1);
    const layerOn = tr.band.layer > 0.02;
    for (const e of tr.evs) {
      if (Math.floor(e.s + 1e-6) !== tr.step) continue;
      // the intensity layer costs nodes even when faded out: skip it while silent
      if (e.layer === 1 && !layerOn) continue;
      const at = tr.next + (e.s + swingOffset(e.s, song.swing)) * song.eighth;
      // tiny human timing, never on the downbeat
      const hum = e.s > 0 ? (this.kit.rng() - 0.5) * 0.008 : 0;
      playEvent(s, tr.band, e, at + hum, song.eighth);
    }
    tr.lastSrcEnd = Math.max(tr.lastSrcEnd, s.end);
  }

  stopAll(now: number): void {
    this.setMood('none', now);
  }

  dispose(): void {
    for (const tr of this.tracks) {
      tr.band.stop(0);
      tr.band.disconnect();
      try {
        tr.gain.disconnect();
      } catch {
        // ok
      }
    }
    this.tracks.length = 0;
  }
}

/** Render a song into an existing context (used by the offline self-test). */
export function scheduleSongOffline(kit: Kit, mood: Exclude<MusicMood, 'none'>, dest: AudioNode, bars: number, intensity = 1): number {
  const song = SONGS[mood];
  const tr = new Track(kit.ctx, song, dest, null, 0.05);
  tr.band.setLayer(intensity, 0);
  let n = 0;
  let t = 0.05;
  while (n < bars && !tr.done) {
    tr.next = t;
    const s = new Snd(kit, tr.band.out, null, t, 1);
    for (const e of song.events(tr.loopN, tr.bar)) {
      playEvent(s, tr.band, e, t + (e.s + swingOffset(e.s, song.swing)) * song.eighth, song.eighth);
    }
    tr.bar++;
    if (tr.bar >= song.bars) {
      if (song.loop) {
        tr.bar = 0;
        tr.loopN++;
      } else tr.done = true;
    }
    t += tr.barDur();
    n++;
  }
  tr.band.stop(t + 4);
  return t;
}

/** Main-thread cost of building each instrument note (ms per note), for the debug harness. */
export function benchInstruments(kit: Kit, dest: AudioNode, n = 40): Record<string, number> {
  const band = new Band(kit.ctx, dest, null);
  const out: Record<string, number> = {};
  const insts: Inst[] = ['acc', 'fiddle', 'whistle', 'bass', 'pluck', 'bodhran', 'rim', 'stomp', 'shaker', 'tamb', 'cymbal', 'timp', 'brass'];
  for (const i of insts) band.bus(i, false);
  for (const i of insts) {
    const s = new Snd(kit, band.out, null, 0.1, 1);
    const t0 = performance.now();
    for (let k = 0; k < n; k++) playEvent(s, band, { i, s: 0, d: 1, n: 62, v: 0.5 }, 0.1 + k * 0.05, 0.2);
    out[i] = +((performance.now() - t0) / n).toFixed(3);
  }
  return out;
}
