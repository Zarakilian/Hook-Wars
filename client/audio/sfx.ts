// Every SfxId as a layered procedural recipe. Recipes only build nodes on a Snd; the mixer owns
// spatialisation, voice limits and buses. All times are relative to s.t.
import type { SfxId } from '../render/contracts.ts';
import { BELL, CLANG, STEEL, Snd, bell, clicks, creak, drops, fm, midiHz, noiseHit, perc, sweep, tone, whoosh } from './core.ts';
import { crowd, speak } from './voice.ts';

export interface SfxDef {
  /** base gain (calibrated against offline RMS) */
  v: number;
  /** 0 = ambient detail .. 3 = must be heard */
  prio: number;
  /** max simultaneous voices of this id */
  cap: number;
  /** reverb send amount */
  rev: number;
  /** random pitch spread (fraction) */
  vary: number;
  /** combat heat added (drives the adaptive music layer) */
  heat?: number;
  /** minimum seconds between two triggers of this id (throttle) */
  gap?: number;
  fn: (s: Snd) => void;
}

// ---------------------------------------------------------------------------------------------
// shared layers
// ---------------------------------------------------------------------------------------------

function thwack(s: Snd, t: number, v: number, low = 1): void {
  noiseHit(s, { t, ft: 'lowpass', f: 3200, f1: 500, a: 0.0008, d: 0.08, v: v * 0.9, q: 0.8 });
  noiseHit(s, { t, ft: 'bandpass', f: 950, q: 1.1, a: 0.001, d: 0.12, v: v * 0.55 });
  tone(s, { t, f: 165 * low, f1: 46 * low, a: 0.002, d: 0.24, v: v * 1.05 });
  tone(s, { t, type: 'triangle', f: 430, f1: 170, a: 0.001, d: 0.05, v: v * 0.3 });
}

function jangle(s: Snd, t: number, v: number, rate = 1, max = 0.7): void {
  const g = s.g(v, s.out);
  s.buf(s.kit.baked('jangle'), t, g, rate * s.r(0.92, 1.08), max);
}

function clatter(s: Snd, t: number, v: number, rate = 1): void {
  const g = s.g(v, s.out);
  s.buf(s.kit.baked('clatter'), t, g, rate * s.r(0.9, 1.1));
}

function bubbleBuf(s: Snd, t: number, v: number, rate = 1, max = 1.3): void {
  const g = s.g(v, s.f('lowpass', 3500, 0.7, s.out));
  s.buf(s.kit.baked('bubbles'), t, g, rate * s.r(0.9, 1.1), max);
}

function thump(s: Snd, t: number, f: number, v: number, d = 0.25): void {
  tone(s, { t, f: f * 1.9, f1: f * 0.5, a: 0.002, d, v });
  noiseHit(s, { t, ft: 'lowpass', f: 900, f1: 180, a: 0.001, d: d * 0.6, v: v * 0.55, q: 0.7 });
}

function sploosh(s: Snd, t: number, v: number, size = 1): void {
  noiseHit(s, { t, ft: 'lowpass', f: 4200, f1: 420 / size, a: 0.006, d: 0.45 * size, v: v * 0.9, q: 0.9 });
  noiseHit(s, { t: t + 0.02, ft: 'bandpass', f: 1300, f1: 600, q: 0.8, a: 0.01, d: 0.3 * size, v: v * 0.45 });
  tone(s, { t, f: 180 / size, f1: 520 / size, sw: 0.09, a: 0.003, d: 0.12, v: v * 0.45 });
  tone(s, { t, f: 90 / size, f1: 40, a: 0.004, d: 0.22 * size, v: v * 0.55 });
  bubbleBuf(s, t + 0.08, v * 0.5, 1 / Math.sqrt(size), 0.9 * size);
  drops(s, { t: t + 0.14, n: 4, span: 0.45 * size, f0: 1400, f1: 2900, d: 0.045, v: v * 0.16 });
}

function sparkle(s: Snd, t: number, v: number, base = 84, n = 5, step = 0.05): void {
  const scale = [0, 2, 4, 7, 9, 12, 14, 16];
  for (let i = 0; i < n; i++) {
    const m = base + s.pick(scale);
    bell(s, { t: t + i * step * s.r(0.7, 1.3), f: midiHz(m), d: 0.35, v: v * s.r(0.6, 1), partials: BELL });
  }
}

function grunt(s: Snd, t: number, v: number, f0: number, segs: Parameters<typeof speak>[1], shift = 1): void {
  speak(s, segs, { t, f0, v, shift, vib: 0.02 });
}

/** Steam / pressure hiss. */
function hiss(s: Snd, t: number, d: number, v: number, f = 3500): void {
  const g = s.g(0, s.out);
  const hp = s.f('highpass', 1400, 0.7, g);
  const bp = s.f('bandpass', f, 0.9, s.g(0.8, g));
  const n = s.g(1);
  n.connect(hp);
  n.connect(bp);
  s.noise('white', t, t + d + 0.02, n);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v, t + 0.03);
  g.gain.setTargetAtTime(v * 0.6, t + 0.05, d * 0.25);
  g.gain.setTargetAtTime(0, t + d * 0.6, d * 0.15);
  g.gain.setValueAtTime(0, t + d + 0.01);
}

/** "Pew" dispersion chirp: the sound of stressed ice and springs. */
function pew(s: Snd, t: number, v: number, f0 = 3800, f1 = 260, d = 0.16): void {
  const g = s.g(0, s.out);
  const o = s.osc('sine', f0 * s.p, t, t + d + 0.02, g);
  sweep(o.frequency, t, f0 * s.p, f1 * s.p, d);
  perc(g.gain, t, v, 0.001, d);
}

/** Brass stab for fanfares and stingers. */
export function brass(s: Snd, t: number, notes: readonly number[], d: number, v: number, bright = 1, dest?: AudioNode): void {
  const out = s.g(0, dest ?? s.out);
  const lp = s.f('lowpass', 400, 1.2, out);
  lp.frequency.setValueAtTime(350, t);
  lp.frequency.exponentialRampToValueAtTime(2600 * bright, t + 0.06);
  lp.frequency.exponentialRampToValueAtTime(1100 * bright, t + Math.max(0.12, d * 0.6));
  for (const m of notes) {
    const f = midiHz(m) * s.p;
    const o1 = s.osc(s.kit.brass, f, t, t + d + 0.3, lp);
    o1.detune.value = s.r(-6, 6);
    const o2 = s.osc('sawtooth', f, t, t + d + 0.3, s.g(0.35, lp));
    o2.detune.value = s.r(4, 12);
    // tiny scoop into pitch
    o1.frequency.setValueAtTime(f * 0.97, t);
    o1.frequency.exponentialRampToValueAtTime(f, t + 0.05);
  }
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(v / Math.sqrt(notes.length), t + 0.025);
  out.gain.setTargetAtTime((v * 0.62) / Math.sqrt(notes.length), t + 0.03, 0.08);
  out.gain.setTargetAtTime(0, t + d, 0.07);
  out.gain.setValueAtTime(0, t + d + 0.3);
}

export function cymbal(s: Snd, t: number, d: number, v: number): void {
  noiseHit(s, { t, ft: 'highpass', f: 5200, q: 0.6, a: 0.002, d, v: v * 0.8, pitched: false });
  noiseHit(s, { t, ft: 'bandpass', f: 8600, q: 1.5, a: 0.001, d: d * 0.6, v: v * 0.5, pitched: false });
  bell(s, { t, f: 410, d: d * 0.5, v: v * 0.12, partials: CLANG });
}

export function drum(s: Snd, t: number, f: number, v: number, d = 0.35): void {
  tone(s, { t, f: f * 2.1, f1: f, sw: 0.06, a: 0.001, d, v });
  noiseHit(s, { t, ft: 'bandpass', f: 1100, q: 0.9, a: 0.0008, d: 0.035, v: v * 0.45, pitched: false });
}

export function timpaniRoll(s: Snd, t: number, d: number, f: number, v: number): void {
  const n = Math.floor(d / 0.045);
  for (let i = 0; i < n; i++) {
    const k = i / Math.max(1, n - 1);
    tone(s, { t: t + i * 0.045 + s.r(0, 0.006), f: f * 1.05, f1: f, sw: 0.05, a: 0.002, d: 0.18, v: v * (0.25 + 0.75 * k * k) * s.r(0.8, 1) });
  }
}

// ---------------------------------------------------------------------------------------------
// family layers for the hook
// ---------------------------------------------------------------------------------------------

function throwBrawler(s: Snd, t: number): void {
  // rope whoosh plus the reel ratchet paying out line
  whoosh(s, { t, d: 0.34, f0: 450, fp: 2600, f1: 800, q: 1.4, v: 0.95, peakAt: 0.32 });
  whoosh(s, { t: t + 0.03, d: 0.22, f0: 1600, fp: 5200, f1: 2200, q: 2.5, v: 0.25, kind: 'white' });
  clicks(s, { t: t + 0.015, n: 11, i0: 0.016, i1: 0.038, f: 3100, q: 4.5, cd: 0.01, v: 0.55, fJit: 0.08 });
  tone(s, { t: t + 0.02, type: 'triangle', f: 210, f1: 150, a: 0.002, d: 0.06, v: 0.25 });
  bell(s, { t: t + 0.06, f: 2650, d: 0.22, v: 0.07, partials: STEEL });
}

function throwOgre(s: Snd, t: number): void {
  // creaky vine winding, a low whip and a wet slap as the bone hook leaves
  creak(s, { t, d: 0.3, r0: 34, r1: 62, res: [470, 1180, 2300], v: 0.42, q: 10 });
  whoosh(s, { t, d: 0.32, f0: 280, fp: 1500, f1: 420, q: 1.1, v: 0.85, peakAt: 0.35 });
  const ts = t + 0.11;
  noiseHit(s, { t: ts, ft: 'bandpass', f: 1300, f1: 520, q: 0.9, a: 0.0015, d: 0.09, v: 0.75 });
  noiseHit(s, { t: ts, ft: 'lowpass', f: 2400, f1: 600, q: 1.5, a: 0.001, d: 0.05, v: 0.5 });
  tone(s, { t: ts, f: 270, f1: 95, a: 0.001, d: 0.08, v: 0.4 });
  drops(s, { t: ts + 0.04, n: 3, span: 0.12, f0: 700, f1: 1400, d: 0.05, v: 0.12 });
}

function throwBot(s: Snd, t: number): void {
  // servo whine spinning up, pneumatic release and a steel clank
  const g = s.g(0, s.f('lowpass', 3400, 0.8, s.out));
  const o1 = s.osc('sawtooth', 320 * s.p, t, t + 0.3, g);
  sweep(o1.frequency, t, 320 * s.p, 1500 * s.p, 0.2);
  const o2 = s.osc('square', 480 * s.p, t, t + 0.3, s.g(0.35, g));
  sweep(o2.frequency, t, 480 * s.p, 2250 * s.p, 0.2);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.12, t + 0.03);
  g.gain.setTargetAtTime(0, t + 0.18, 0.04);
  fm(s, { t, f: 900, ratio: 1.41, index: 2, index1: 0.2, a: 0.01, d: 0.18, v: 0.05, f1: 1800 });
  bell(s, { t: t + 0.03, f: 820, d: 0.32, v: 0.4, partials: STEEL });
  noiseHit(s, { t: t + 0.03, ft: 'highpass', f: 2800, a: 0.0005, d: 0.03, v: 0.45 });
  noiseHit(s, { t: t + 0.01, ft: 'highpass', f: 4200, a: 0.004, d: 0.18, v: 0.22, q: 0.6 });
  whoosh(s, { t, d: 0.26, f0: 600, fp: 2400, f1: 900, q: 1.3, v: 0.45 });
}

function returnFamily(s: Snd, t: number): void {
  const fam = s.env.family;
  if (fam === 'ogre') {
    creak(s, { t, d: 0.3, r0: 60, r1: 30, res: [420, 1050], v: 0.35 });
    noiseHit(s, { t: t + 0.3, ft: 'lowpass', f: 1600, f1: 300, a: 0.002, d: 0.12, v: 0.6 });
  } else if (fam === 'bot') {
    const g = s.g(0, s.f('lowpass', 3000, 0.8, s.out));
    const o = s.osc('sawtooth', 1400 * s.p, t, t + 0.34, g);
    sweep(o.frequency, t, 1400 * s.p, 380 * s.p, 0.3);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.03);
    g.gain.setTargetAtTime(0, t + 0.24, 0.03);
    bell(s, { t: t + 0.3, f: 700, d: 0.3, v: 0.3, partials: STEEL });
  } else {
    clicks(s, { t, n: 12, i0: 0.04, i1: 0.016, f: 2700, q: 4, cd: 0.01, v: 0.45, fJit: 0.06 });
  }
}

// ---------------------------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------------------------

export const SFX: Record<SfxId, SfxDef> = {
  hookThrow: {
    v: 1.85, prio: 2, cap: 5, rev: 0.08, vary: 0.05,
    fn: (s) => {
      const fam = s.env.family;
      if (fam === 'ogre') throwOgre(s.child(0.48), s.t);
      else if (fam === 'bot') throwBot(s.child(0.66), s.t);
      else throwBrawler(s, s.t);
    },
  },
  hookHit: {
    v: 1.17, prio: 3, cap: 4, rev: 0.14, vary: 0.06, heat: 0.22,
    fn: (s) => {
      thwack(s, s.t, 1);
      jangle(s, s.t + 0.012, 0.42, 1, 0.55);
      // meaty squish under the hit (slapstick, not gore)
      noiseHit(s, { t: s.t + 0.01, ft: 'lowpass', f: 700, f1: 250, a: 0.004, d: 0.18, v: 0.35 });
    },
  },
  hookHitAlly: {
    v: 1.008, prio: 3, cap: 3, rev: 0.18, vary: 0.04,
    fn: (s) => {
      thwack(s, s.t, 0.55, 1.2);
      jangle(s, s.t + 0.01, 0.28, 1.1, 0.4);
      // friendly rescue chime: up a major third, then a fifth
      bell(s, { t: s.t + 0.03, f: midiHz(79), d: 0.45, v: 0.16 });
      bell(s, { t: s.t + 0.11, f: midiHz(83), d: 0.5, v: 0.15 });
      bell(s, { t: s.t + 0.19, f: midiHz(86), d: 0.7, v: 0.14 });
    },
  },
  bullseye: {
    v: 0.95, prio: 3, cap: 2, rev: 0.25, vary: 0.02, heat: 0.4,
    fn: (s) => {
      thwack(s, s.t, 1.15, 0.9);
      jangle(s, s.t + 0.01, 0.45, 0.95, 0.6);
      // golden ding-ding
      bell(s, { t: s.t + 0.02, f: midiHz(91), d: 1.7, v: 0.36, partials: BELL });
      bell(s, { t: s.t + 0.115, f: midiHz(98), d: 1.5, v: 0.26, partials: BELL });
      sparkle(s, s.t + 0.15, 0.06, 96, 6, 0.045);
      // the crowd goes "ooooh"
      crowd(s, { t: s.t + 0.1, d: 1.7, v: 0.42, v0: 'u', v1: 'o', lo: 150, hi: 290, n: 7, glide: 0.82, swell: 0.32, breath: 0.4 });
    },
  },
  hookWall: {
    v: 1.44, prio: 1, cap: 3, rev: 0.12, vary: 0.08,
    fn: (s) => {
      tone(s, { f: 230, f1: 85, a: 0.001, d: 0.1, v: 0.7 });
      noiseHit(s, { ft: 'lowpass', f: 2200, f1: 500, a: 0.0006, d: 0.06, v: 0.7 });
      noiseHit(s, { ft: 'bandpass', f: 650, q: 1.5, a: 0.001, d: 0.09, v: 0.35 });
      bell(s, { t: s.t + 0.002, f: 3100, d: 0.07, v: 0.09, partials: STEEL });
      jangle(s, s.t + 0.02, 0.18, 1.2, 0.3);
    },
  },
  hookBounce: {
    v: 1.43, prio: 1, cap: 3, rev: 0.15, vary: 0.06,
    fn: (s) => {
      // springy ricochet "boyoyoing"
      const g = s.g(0, s.out);
      const o = s.osc('triangle', 520 * s.p, s.t, s.t + 0.45, g);
      sweep(o.frequency, s.t, 480 * s.p, 980 * s.p, 0.32);
      const lg = s.g(70 * s.p, o.frequency);
      s.osc('sine', 26, s.t, s.t + 0.45, lg);
      lg.gain.setValueAtTime(90 * s.p, s.t);
      lg.gain.exponentialRampToValueAtTime(4, s.t + 0.4);
      perc(g.gain, s.t, 0.4, 0.002, 0.4);
      bell(s, { f: 1900, d: 0.22, v: 0.16, partials: STEEL });
      noiseHit(s, { ft: 'highpass', f: 3000, a: 0.0005, d: 0.02, v: 0.4 });
    },
  },
  hookClash: {
    v: 1.062, prio: 3, cap: 2, rev: 0.32, vary: 0.04, heat: 0.15,
    fn: (s) => {
      const f = 455 * s.r(0.96, 1.04);
      // two slightly detuned clangs beat against each other for a long ring-out
      bell(s, { f, d: 2.3, v: 0.5, partials: CLANG });
      bell(s, { f: f * 1.0065, d: 2.0, v: 0.3, partials: CLANG });
      bell(s, { f: f * 2.71, d: 0.9, v: 0.14, partials: STEEL });
      noiseHit(s, { ft: 'highpass', f: 2100, a: 0.0004, d: 0.045, v: 0.9 });
      noiseHit(s, { ft: 'bandpass', f: 7200, q: 1.2, a: 0.002, d: 0.3, v: 0.16 });
      tone(s, { f: 125, f1: 70, a: 0.001, d: 0.13, v: 0.5 });
      jangle(s, s.t + 0.03, 0.3, 0.9, 0.6);
    },
  },
  hookReturn: {
    v: 0.42, prio: 2, cap: 3, rev: 0.1, vary: 0.05,
    fn: (s) => {
      returnFamily(s, s.t);
      jangle(s, s.t + 0.04, 0.26, 0.85, 0.45);
      // the catch lands at the caster's feet: clunk and plop
      tone(s, { t: s.t + 0.31, f: 190, f1: 70, a: 0.001, d: 0.12, v: 0.55 });
      noiseHit(s, { t: s.t + 0.31, ft: 'lowpass', f: 1200, f1: 250, a: 0.001, d: 0.12, v: 0.5 });
      tone(s, { t: s.t + 0.34, f: 120, f1: 55, a: 0.003, d: 0.2, v: 0.5 });
    },
  },
  hookBreak: {
    v: 0.845, prio: 2, cap: 2, rev: 0.16, vary: 0.05,
    fn: (s) => {
      noiseHit(s, { ft: 'highpass', f: 1600, a: 0.0003, d: 0.045, v: 1.0 });
      bell(s, { f: 2800, d: 0.3, v: 0.16, partials: STEEL });
      // snapped line twangs and falls slack
      const g = s.g(0, s.f('lowpass', 3200, 0.8, s.out));
      const o = s.osc('sawtooth', 900 * s.p, s.t, s.t + 0.45, g);
      sweep(o.frequency, s.t, 900 * s.p, 110 * s.p, 0.4);
      perc(g.gain, s.t, 0.2, 0.001, 0.42);
      jangle(s, s.t + 0.05, 0.38, 1.25, 0.6);
    },
  },
  grappleThrow: {
    v: 1.8, prio: 2, cap: 3, rev: 0.1, vary: 0.05,
    fn: (s) => {
      tone(s, { f: 150, f1: 58, a: 0.001, d: 0.13, v: 0.6 });
      noiseHit(s, { ft: 'bandpass', f: 620, q: 1, a: 0.001, d: 0.07, v: 0.55 });
      whoosh(s, { d: 0.4, f0: 380, fp: 3200, f1: 1500, q: 1.3, v: 0.75, peakAt: 0.5 });
      clicks(s, { t: s.t + 0.02, n: 14, i0: 0.012, i1: 0.022, f: 3600, q: 4, cd: 0.008, v: 0.38 });
      const g = s.g(0, s.f('bandpass', 1200, 2, s.out));
      const o = s.osc('sawtooth', 200 * s.p, s.t, s.t + 0.35, g);
      sweep(o.frequency, s.t, 200 * s.p, 820 * s.p, 0.32);
      perc(g.gain, s.t, 0.07, 0.03, 0.3);
    },
  },
  grappleLatch: {
    v: 1.92, prio: 2, cap: 3, rev: 0.16, vary: 0.05,
    fn: (s) => {
      noiseHit(s, { ft: 'highpass', f: 2600, a: 0.0003, d: 0.022, v: 0.9 });
      bell(s, { f: 1320, d: 0.42, v: 0.26, partials: [[1, 1, 1], [2.4, 0.5, 0.6], [4.1, 0.3, 0.4]] });
      tone(s, { f: 320, f1: 140, a: 0.001, d: 0.06, v: 0.45 });
      clicks(s, { t: s.t + 0.05, n: 2, i0: 0.05, i1: 0.05, f: 4200, q: 5, v: 0.3 });
    },
  },
  grappleLand: {
    v: 0.589, prio: 2, cap: 3, rev: 0.1, vary: 0.06,
    fn: (s) => {
      thump(s, s.t, 58, 0.95, 0.28);
      noiseHit(s, { t: s.t + 0.01, kind: 'pink', ft: 'lowpass', f: 1400, f1: 250, a: 0.01, d: 0.32, v: 0.4 });
      jangle(s, s.t + 0.03, 0.15, 1.1, 0.3);
      grunt(s, s.t + 0.02, 0.22, 150, [['A', 0.07, 0], ['f', 0.05]]);
    },
  },
  bash: {
    v: 1.014, prio: 3, cap: 3, rev: 0.12, vary: 0.05, heat: 0.12,
    fn: (s) => {
      // belly BOING: spring tone that overshoots then wobbles down
      const fam = s.env.family;
      const g = s.g(0, s.out);
      const o = s.osc(fam === 'bot' ? 'square' : 'sine', 170 * s.p, s.t, s.t + 0.62, fam === 'bot' ? s.f('lowpass', 1500, 1, g) : g);
      o.frequency.setValueAtTime(150 * s.p, s.t);
      o.frequency.exponentialRampToValueAtTime(270 * s.p, s.t + 0.05);
      o.frequency.exponentialRampToValueAtTime(130 * s.p, s.t + 0.55);
      const lg = s.g(55 * s.p, o.frequency);
      s.osc('sine', 15, s.t, s.t + 0.62, lg);
      lg.gain.setValueAtTime(60 * s.p, s.t);
      lg.gain.exponentialRampToValueAtTime(3, s.t + 0.55);
      perc(g.gain, s.t, fam === 'bot' ? 0.4 : 0.6, 0.004, 0.56);
      thump(s, s.t, 52, 1, 0.2);
      whoosh(s, { d: 0.26, f0: 300, fp: 1300, f1: 400, q: 1, v: 0.5, peakAt: 0.3 });
      noiseHit(s, { ft: 'bandpass', f: 1500, q: 0.9, a: 0.0008, d: 0.05, v: 0.45 });
      if (fam === 'bot') bell(s, { f: 640, d: 0.4, v: 0.18, partials: STEEL });
      if (fam === 'ogre') noiseHit(s, { t: s.t + 0.01, ft: 'lowpass', f: 900, f1: 300, a: 0.002, d: 0.14, v: 0.4 });
    },
  },
  melee: {
    v: 1.56, prio: 1, cap: 4, rev: 0.06, vary: 0.12, heat: 0.04, gap: 0.03,
    fn: (s) => {
      noiseHit(s, { ft: 'bandpass', f: 1800, f1: 850, q: 0.8, a: 0.0008, d: 0.065, v: 0.85 });
      tone(s, { f: 150, f1: 68, a: 0.001, d: 0.1, v: 0.75 });
      const r = s.r();
      if (r < 0.3) tone(s, { type: 'triangle', f: 720, f1: 640, a: 0.0005, d: 0.06, v: 0.22 }); // bonk
      else if (r < 0.55) whoosh(s, { t: s.t - 0.0, d: 0.1, f0: 900, fp: 2600, f1: 1200, q: 1.5, v: 0.25 });
    },
  },
  hurt: {
    v: 0.425, prio: 2, cap: 2, rev: 0.05, vary: 0.08, gap: 0.12,
    fn: (s) => {
      const fam = s.env.family;
      if (fam === 'bot') {
        const g = s.g(0, s.f('bandpass', 1100, 1.2, s.g(5.5, s.out)));
        const o = s.osc('square', 230 * s.p, s.t, s.t + 0.2, g);
        o.frequency.setValueAtTime(230 * s.p, s.t);
        o.frequency.setValueAtTime(180 * s.p, s.t + 0.06);
        o.frequency.setValueAtTime(150 * s.p, s.t + 0.12);
        perc(g.gain, s.t, 1.0, 0.003, 0.18);
        tone(s, { type: 'sawtooth', f: 115, f1: 75, a: 0.003, d: 0.16, v: 0.25 });
      } else {
        const f0 = fam === 'ogre' ? 105 : 150;
        grunt(s, s.t, 0.5, f0, s.pick([
          [['A', 0.06, 2], ['A', 0.08, 0, -5]],
          [['u', 0.05, 2], ['A', 0.09, 0, -6]],
          [['h', 0.02], ['o', 0.11, 1, -5]],
        ]), fam === 'ogre' ? 0.85 : 1);
      }
      tone(s, { f: 120, f1: 60, a: 0.002, d: 0.08, v: 0.3 });
    },
  },
  death: {
    v: 0.68, prio: 3, cap: 3, rev: 0.16, vary: 0.05, heat: 0.3,
    fn: (s) => {
      // comedic deflating "bwoooww" plus a slide whistle down
      const g = s.g(0, s.out);
      const lp = s.f('lowpass', 1800, 2, g);
      const o = s.osc('sawtooth', 330 * s.p, s.t, s.t + 0.85, lp);
      sweep(o.frequency, s.t, 330 * s.p, 68 * s.p, 0.75);
      sweep(lp.frequency, s.t, 2000, 380, 0.75);
      const lg = s.g(18 * s.p, o.frequency);
      s.osc('sine', 7, s.t, s.t + 0.85, lg);
      g.gain.setValueAtTime(0, s.t);
      g.gain.linearRampToValueAtTime(0.3, s.t + 0.04);
      g.gain.setTargetAtTime(0, s.t + 0.55, 0.08);
      const w = s.g(0, s.out);
      const ow = s.osc('sine', 1500 * s.p, s.t + 0.05, s.t + 0.62, w);
      sweep(ow.frequency, s.t + 0.05, 1500 * s.p, 480 * s.p, 0.52);
      perc(w.gain, s.t + 0.05, 0.1, 0.03, 0.52);
      thump(s, s.t + 0.05, 44, 0.65, 0.3);
      const fam = s.env.family;
      grunt(s, s.t, 0.3, fam === 'ogre' ? 95 : fam === 'bot' ? 210 : 135, [['o', 0.12, 3], ['u', 0.2, 0, -7]]);
    },
  },
  corpse: {
    v: 0.788, prio: 2, cap: 3, rev: 0.12, vary: 0.06, heat: 0.15,
    fn: (s) => {
      // comedic POP then bits clatter everywhere
      tone(s, { f: 260, f1: 1250, sw: 0.05, a: 0.001, d: 0.07, v: 0.6 });
      noiseHit(s, { ft: 'bandpass', f: 2100, q: 0.9, a: 0.0004, d: 0.03, v: 0.85 });
      tone(s, { f: 95, f1: 45, a: 0.001, d: 0.16, v: 0.6 });
      clatter(s, s.t + 0.04, 0.75);
      sparkle(s, s.t + 0.06, 0.035, 93, 3, 0.07);
    },
  },
  splash: {
    v: 0.735, prio: 2, cap: 4, rev: 0.14, vary: 0.08, gap: 0.04,
    fn: (s) => sploosh(s, s.t, 1, 1),
  },
  drown: {
    v: 0.576, prio: 3, cap: 3, rev: 0.16, vary: 0.05, heat: 0.2,
    fn: (s) => {
      sploosh(s, s.t, 1, 1.35);
      bubbleBuf(s, s.t + 0.25, 0.7, 0.72, 1.3);
      bubbleBuf(s, s.t + 0.75, 0.5, 0.6, 1.0);
      for (let i = 0; i < 3; i++) tone(s, { t: s.t + 0.35 + i * 0.28, f: 290, f1: 115, a: 0.006, d: 0.18, v: 0.32 * (1 - i * 0.2) });
      // muffled gargle "blblbl"
      const g = s.g(0, s.f('lowpass', 650, 1, s.out));
      const am = s.g(0.6, g);
      s.osc('sine', 17, s.t + 0.3, s.t + 1.25, s.g(0.4, am.gain));
      speak(s, [['u', 0.5, 2, -6], ['o', 0.3, -4, -10]], { t: s.t + 0.3, f0: 150, v: 0.6, dest: am });
      g.gain.setValueAtTime(0, s.t + 0.3);
      g.gain.linearRampToValueAtTime(0.5, s.t + 0.4);
      g.gain.setTargetAtTime(0, s.t + 0.95, 0.08);
    },
  },
  drownSave: {
    v: 0.62, prio: 3, cap: 2, rev: 0.2, vary: 0.03,
    fn: (s) => {
      bubbleBuf(s, s.t, 0.35, 1.4, 0.6);
      whoosh(s, { d: 0.35, f0: 500, fp: 3200, f1: 2000, q: 1.2, v: 0.35, peakAt: 0.6 });
      bell(s, { t: s.t + 0.05, f: midiHz(84), d: 0.45, v: 0.15 });
      bell(s, { t: s.t + 0.12, f: midiHz(88), d: 0.45, v: 0.15 });
      bell(s, { t: s.t + 0.19, f: midiHz(91), d: 0.8, v: 0.17 });
    },
  },
  respawn: {
    v: 0.605, prio: 2, cap: 2, rev: 0.3, vary: 0.02,
    fn: (s) => {
      const arp = [74, 78, 81, 86, 90];
      arp.forEach((m, i) => {
        tone(s, { t: s.t + i * 0.06, type: 'triangle', f: midiHz(m), a: 0.004, d: 0.5, v: 0.13 });
        tone(s, { t: s.t + i * 0.06, f: midiHz(m) * 2, a: 0.004, d: 0.3, v: 0.04 });
      });
      noiseHit(s, { ft: 'highpass', f: 1800, f1: 8000, a: 0.25, d: 0.4, v: 0.1, q: 0.6 });
      tone(s, { f: 75, f1: 115, a: 0.08, d: 0.5, v: 0.3 });
      tone(s, { t: s.t + 0.05, type: 'triangle', f: midiHz(62), a: 0.2, d: 0.7, v: 0.07, shape: 'hold' });
      tone(s, { t: s.t + 0.05, type: 'triangle', f: midiHz(69), a: 0.2, d: 0.7, v: 0.06, shape: 'hold' });
    },
  },
  rune: {
    v: 1.2, prio: 3, cap: 2, rev: 0.25, vary: 0.02,
    fn: (s) => {
      [81, 85, 88, 93].forEach((m, i) => fm(s, { t: s.t + i * 0.055, f: midiHz(m), ratio: 3.5, index: 2.2, index1: 0.05, a: 0.002, d: 0.4, v: 0.15 }));
      noiseHit(s, { ft: 'bandpass', f: 6000, q: 1.2, a: 0.05, d: 0.6, v: 0.12 });
      tone(s, { f: 120, f1: 250, sw: 0.18, a: 0.01, d: 0.22, v: 0.32 });
      sparkle(s, s.t + 0.25, 0.04, 96, 4, 0.06);
    },
  },
  runeSpawn: {
    v: 0.325, prio: 1, cap: 2, rev: 0.4, vary: 0.03,
    fn: (s) => {
      tone(s, { f: 110, f1: 104, a: 0.18, d: 1.0, v: 0.3 });
      tone(s, { type: 'triangle', f: 220, f1: 208, a: 0.2, d: 0.9, v: 0.08 });
      whoosh(s, { d: 0.7, f0: 900, fp: 3000, f1: 1800, q: 1.4, v: 0.14, peakAt: 0.55 });
      [93, 88, 86, 81].forEach((m, i) => bell(s, { t: s.t + 0.25 + i * 0.09, f: midiHz(m), d: 0.6, v: 0.05 }));
    },
  },
  mineArm: {
    v: 0.765, prio: 1, cap: 2, rev: 0.05, vary: 0.03,
    fn: (s) => {
      clicks(s, { n: 2, i0: 0.06, i1: 0.06, f: 3200, q: 3, v: 0.6 });
      creak(s, { t: s.t + 0.02, d: 0.14, r0: 50, r1: 70, res: [900, 2100], v: 0.2 });
      tone(s, { t: s.t + 0.15, f: 1760, a: 0.002, d: 0.06, v: 0.13, shape: 'hold' });
      tone(s, { t: s.t + 0.27, f: 2093, a: 0.002, d: 0.07, v: 0.13, shape: 'hold' });
    },
  },
  mineBoom: {
    v: 0.8, prio: 3, cap: 2, rev: 0.4, vary: 0.05, heat: 0.35,
    fn: (s) => {
      // deep thump with grit, a filtered blast, splinters and debris
      const g = s.g(0, s.out);
      const sh = s.shaper(s.kit.drive, g);
      const o = s.osc('sine', 95 * s.p, s.t, s.t + 1.3, s.g(1.4, sh));
      sweep(o.frequency, s.t, 95 * s.p, 27 * s.p, 1.0);
      perc(g.gain, s.t, 1.0, 0.003, 1.2);
      noiseHit(s, { ft: 'lowpass', f: 7000, f1: 260, a: 0.002, d: 0.95, v: 0.95, q: 0.7 });
      noiseHit(s, { kind: 'brown', ft: 'lowpass', f: 500, f1: 120, a: 0.01, d: 1.4, v: 0.7, q: 0.7 });
      const cr = s.g(0.35, s.f('highpass', 1200, 0.7, s.out));
      s.buf(s.kit.baked('crackle'), s.t + 0.04, cr, s.r(0.8, 1));
      clatter(s, s.t + 0.18, 0.4, 0.75);
    },
  },
  buy: {
    v: 0.825, prio: 2, cap: 2, rev: 0.12, vary: 0.02,
    fn: (s) => {
      tone(s, { f: 310, f1: 120, a: 0.001, d: 0.06, v: 0.25 });
      bell(s, { t: s.t + 0.01, f: midiHz(96), d: 0.4, v: 0.18, partials: [[1, 1, 1], [2.4, 0.4, 0.5], [3.9, 0.3, 0.4]] });
      bell(s, { t: s.t + 0.09, f: midiHz(100), d: 0.65, v: 0.2, partials: [[1, 1, 1], [2.4, 0.4, 0.5], [3.9, 0.3, 0.4]] });
      jangle(s, s.t + 0.02, 0.2, 1.6, 0.4);
    },
  },
  deny: {
    v: 0.588, prio: 2, cap: 1, rev: 0.03, vary: 0.0, gap: 0.15,
    fn: (s) => {
      const lp = s.f('lowpass', 1300, 0.8, s.out);
      tone(s, { type: 'square', f: 330, a: 0.003, d: 0.07, v: 0.12, dest: lp, shape: 'hold' });
      tone(s, { t: s.t + 0.1, type: 'square', f: 247, a: 0.003, d: 0.11, v: 0.12, dest: lp, shape: 'hold' });
      tone(s, { type: 'triangle', f: 600, a: 0.0005, d: 0.03, v: 0.1 });
    },
  },
  pie: {
    v: 0.55, prio: 2, cap: 2, rev: 0.08, vary: 0.04,
    fn: (s) => {
      for (let i = 0; i < 3; i++) {
        const t = s.t + i * 0.17;
        noiseHit(s, { t, ft: 'bandpass', f: 720 * s.r(0.9, 1.1), q: 1.2, a: 0.004, d: 0.07, v: 0.6 });
        tone(s, { t, f: 190, f1: 100, a: 0.002, d: 0.05, v: 0.3 });
      }
      speak(s, [['m', 0.36, 0, 4], ['m', 0.08, 4, 3]], { t: s.t + 0.52, f0: 150, v: 0.7, vib: 0.03 });
      sparkle(s, s.t + 0.65, 0.05, 88, 4, 0.06);
    },
  },
  puff: {
    v: 1.76, prio: 2, cap: 2, rev: 0.2, vary: 0.05,
    fn: (s) => {
      noiseHit(s, { kind: 'pink', ft: 'bandpass', f: 950, f1: 300, q: 0.8, a: 0.01, d: 0.42, v: 0.75 });
      tone(s, { f: 190, f1: 80, a: 0.002, d: 0.08, v: 0.4 });
      noiseHit(s, { ft: 'highpass', f: 3200, a: 0.03, d: 0.5, v: 0.14, q: 0.6 });
      [96, 91, 88].forEach((m, i) => bell(s, { t: s.t + 0.12 + i * 0.08, f: midiHz(m), d: 0.35, v: 0.035 }));
    },
  },
  tideHorn: {
    v: 0.446, prio: 3, cap: 1, rev: 0.5, vary: 0.0, gap: 1.5,
    fn: (s) => {
      const map = s.env.mapId;
      if (map === 'frostfang') {
        foghorn(s, s.t, 98, 2.2, 0.85, s.kit.brass);
        for (let i = 0; i < 6; i++) bell(s, { t: s.t + 0.3 + i * 0.2, f: midiHz(s.pick([93, 96, 98, 100, 103])), d: 0.9, v: 0.04 });
        pew(s, s.t + 1.4, 0.06, 4200, 400, 0.2);
      } else if (map === 'cogwater') {
        s = s.child(0.85);
        foghorn(s, s.t, 73, 2.0, 0.9, 'sawtooth');
        steamWhistle(s, s.t + 0.15, 1.5);
        foghorn(s, s.t + 2.5, 73, 0.7, 0.75, 'sawtooth');
      } else {
        foghorn(s, s.t, 82, 2.0, 1, 'sawtooth');
        foghorn(s, s.t + 2.45, 82, 0.8, 0.85, 'sawtooth');
      }
    },
  },
  iceCrack: {
    v: 0.7, prio: 3, cap: 2, rev: 0.4, vary: 0.04,
    fn: (s) => {
      const cr = s.g(0.9, s.f('highpass', 1000, 0.7, s.out));
      s.buf(s.kit.baked('crackle'), s.t, cr, s.r(0.85, 1.1));
      clicks(s, { n: 9, i0: 0.05, i1: 0.11, f: 3600, q: 2.5, cd: 0.025, v: 0.9, fJit: 0.4, jitter: 0.5 });
      creak(s, { t: s.t + 0.05, d: 1.0, r0: 16, r1: 30, res: [170, 420, 900], v: 0.5, q: 12 });
      pew(s, s.t + 0.2, 0.18);
      pew(s, s.t + 0.62, 0.12, 3000, 220, 0.2);
      tone(s, { f: 72, f1: 38, a: 0.01, d: 0.7, v: 0.45 });
    },
  },
  hazardBurst: {
    v: 1.12, prio: 2, cap: 3, rev: 0.2, vary: 0.06, heat: 0.05,
    fn: (s) => {
      const sp = s.env.special;
      if (sp === 'steamvent' || sp === 'icespikes') s = s.child(sp === 'steamvent' ? 0.36 : 0.8);
      if (sp === 'icespikes') {
        noiseHit(s, { ft: 'bandpass', f: 3000, q: 0.8, a: 0.001, d: 0.16, v: 0.9 });
        thump(s, s.t, 50, 0.8, 0.25);
        const cr = s.g(0.5, s.f('highpass', 2000, 0.7, s.out));
        s.buf(s.kit.baked('crackle'), s.t + 0.01, cr, 1.3, 0.5);
        for (let i = 0; i < 4; i++) bell(s, { t: s.t + 0.04 + i * 0.05, f: s.r(2600, 5200), d: 0.3, v: 0.06, partials: STEEL });
        pew(s, s.t + 0.05, 0.1, 4600, 600, 0.12);
      } else if (sp === 'steamvent') {
        hiss(s, s.t, 1.1, 0.75, 3200);
        tone(s, { f: 85, f1: 48, a: 0.004, d: 0.3, v: 0.6 });
        noiseHit(s, { kind: 'brown', ft: 'lowpass', f: 600, f1: 150, a: 0.01, d: 0.6, v: 0.5 });
        clicks(s, { t: s.t + 0.02, n: 4, i0: 0.03, i1: 0.05, f: 1500, q: 5, v: 0.25 });
      } else {
        whoosh(s, { d: 0.4, f0: 300, fp: 1800, f1: 500, q: 1, v: 0.6 });
        thump(s, s.t, 50, 0.75, 0.25);
      }
    },
  },
  countdown: {
    v: 2.0, prio: 3, cap: 1, rev: 0.1, vary: 0.0,
    fn: (s) => {
      // wooden tick and a soft tom: the announcer carries the number
      tone(s, { f: 1250, a: 0.0005, d: 0.05, v: 0.22 });
      noiseHit(s, { ft: 'bandpass', f: 2400, q: 3, a: 0.0004, d: 0.025, v: 0.45 });
      tone(s, { f: 210, f1: 120, a: 0.001, d: 0.18, v: 0.4 });
    },
  },
  go: {
    v: 0.75, prio: 3, cap: 1, rev: 0.3, vary: 0.0,
    fn: (s) => {
      cymbal(s, s.t, 1.8, 0.4);
      drum(s, s.t, 48, 0.95, 0.45);
      whoosh(s, { d: 0.5, f0: 300, fp: 4000, f1: 2500, q: 0.9, v: 0.3, peakAt: 0.2 });
    },
  },
  victory: {
    v: 0.56, prio: 3, cap: 1, rev: 0.3, vary: 0.0,
    fn: (s) => {
      // the crowd cheers; the music stinger carries the fanfare
      crowd(s, { d: 3.2, v: 0.5, v0: 'ae', v1: 'e', lo: 190, hi: 420, n: 10, glide: 1.12, swell: 0.4, breath: 0.6 });
      const ap = s.g(0.5, s.out);
      s.buf(s.kit.baked('applause'), s.t + 0.1, ap, 1);
      for (let i = 0; i < 2; i++) {
        const t = s.t + 0.3 + i * 0.7;
        const g = s.g(0, s.out);
        const o = s.osc('sine', 2100, t, t + 0.55, g);
        o.frequency.setValueAtTime(1900, t);
        o.frequency.exponentialRampToValueAtTime(2900, t + 0.18);
        o.frequency.exponentialRampToValueAtTime(2300, t + 0.5);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.06, t + 0.04);
        g.gain.setTargetAtTime(0, t + 0.4, 0.04);
      }
      cymbal(s, s.t, 2.2, 0.3);
    },
  },
  defeat: {
    v: 0.6, prio: 3, cap: 1, rev: 0.3, vary: 0.0,
    fn: (s) => {
      crowd(s, { d: 2.4, v: 0.45, v0: 'a', v1: 'o', lo: 150, hi: 260, n: 8, glide: 0.8, swell: 0.3, breath: 0.4 });
      drum(s, s.t, 42, 0.6, 0.6);
    },
  },
  uiClick: {
    v: 3.36, prio: 2, cap: 2, rev: 0.02, vary: 0.03, gap: 0.02,
    fn: (s) => {
      tone(s, { f: 1750, a: 0.0005, d: 0.035, v: 0.14 });
      noiseHit(s, { ft: 'bandpass', f: 950, q: 4, a: 0.0004, d: 0.03, v: 0.32 });
      tone(s, { type: 'triangle', f: 480, a: 0.0006, d: 0.04, v: 0.1 });
    },
  },
  uiHover: {
    v: 4.2, prio: 0, cap: 2, rev: 0.0, vary: 0.04, gap: 0.045,
    fn: (s) => {
      tone(s, { f: 2400, a: 0.0005, d: 0.022, v: 0.07 });
      noiseHit(s, { ft: 'bandpass', f: 1450, q: 5, a: 0.0004, d: 0.016, v: 0.14 });
    },
  },
  uiOpen: {
    v: 2.52, prio: 2, cap: 2, rev: 0.04, vary: 0.02, gap: 0.05,
    fn: (s) => {
      noiseHit(s, { ft: 'bandpass', f: 780, q: 4, a: 0.0004, d: 0.03, v: 0.3 });
      noiseHit(s, { t: s.t + 0.055, ft: 'bandpass', f: 1050, q: 4, a: 0.0004, d: 0.03, v: 0.26 });
      whoosh(s, { d: 0.2, f0: 450, fp: 2100, f1: 1500, q: 1.1, v: 0.16, peakAt: 0.6 });
      tone(s, { t: s.t + 0.055, f: 1400, a: 0.0005, d: 0.04, v: 0.08 });
    },
  },
  chat: {
    v: 2.0, prio: 1, cap: 2, rev: 0.03, vary: 0.04, gap: 0.08,
    fn: (s) => {
      tone(s, { f: 620, f1: 1400, sw: 0.05, a: 0.001, d: 0.07, v: 0.16 });
      tone(s, { t: s.t + 0.075, f: 900, f1: 1900, sw: 0.05, a: 0.001, d: 0.06, v: 0.11 });
    },
  },
  footstep: {
    v: 1.35, prio: 0, cap: 3, rev: 0.0, vary: 0.12, gap: 0.05,
    fn: (s) => {
      tone(s, { f: 125, f1: 70, a: 0.001, d: 0.07, v: 0.3 });
      noiseHit(s, { ft: 'lowpass', f: 750, a: 0.001, d: 0.05, v: 0.3 });
      const fam = s.env.family;
      if (fam === 'bot') bell(s, { f: 1250, d: 0.06, v: 0.06, partials: STEEL });
      else if (fam === 'ogre') noiseHit(s, { ft: 'bandpass', f: 520, q: 2, a: 0.004, d: 0.06, v: 0.18 });
    },
  },
  // store and power-up cues (first pass; the fx-audio pass refines these)
  purchase: {
    v: 1.6, prio: 2, cap: 1, rev: 0.12, vary: 0.02, gap: 0.1,
    fn: (s) => {
      bell(s, { f: 1320, d: 0.35, v: 0.12, partials: STEEL });
      bell(s, { t: s.t + 0.09, f: 1760, d: 0.45, v: 0.1, partials: STEEL });
      noiseHit(s, { ft: 'highpass', f: 5200, a: 0.001, d: 0.12, v: 0.08 });
    },
  },
  equip: {
    v: 2.0, prio: 2, cap: 2, rev: 0.03, vary: 0.04, gap: 0.05,
    fn: (s) => {
      noiseHit(s, { ft: 'bandpass', f: 620, q: 3, a: 0.001, d: 0.05, v: 0.3 });
      tone(s, { type: 'triangle', f: 330, f1: 520, sw: 0.06, a: 0.001, d: 0.08, v: 0.12 });
    },
  },
  listingSold: {
    v: 1.5, prio: 2, cap: 1, rev: 0.1, vary: 0.02, gap: 0.2,
    fn: (s) => {
      for (let i = 0; i < 3; i++) bell(s, { t: s.t + i * 0.07, f: 1100 + i * 330, d: 0.3, v: 0.09, partials: STEEL });
    },
  },
  walletLinked: {
    v: 1.6, prio: 2, cap: 1, rev: 0.08, vary: 0.0, gap: 0.3,
    fn: (s) => {
      tone(s, { f: 520, f1: 780, sw: 0.08, a: 0.002, d: 0.12, v: 0.12 });
      tone(s, { t: s.t + 0.11, f: 780, f1: 1040, sw: 0.08, a: 0.002, d: 0.16, v: 0.1 });
    },
  },
  powerHook: {
    v: 1.8, prio: 3, cap: 1, rev: 0.1, vary: 0.03, gap: 0.15,
    fn: (s) => {
      tone(s, { type: 'sawtooth', f: 180, f1: 720, sw: 0.25, a: 0.004, d: 0.3, v: 0.08 });
      bell(s, { t: s.t + 0.18, f: 1480, d: 0.3, v: 0.08, partials: STEEL });
    },
  },
};

function foghorn(s: Snd, t: number, f: number, d: number, v: number, wave: OscillatorType | PeriodicWave): void {
  const out = s.g(0, s.out);
  const lp = s.f('lowpass', 520, 2.2, out);
  const fs = [f * s.p, f * 1.008 * s.p, (f / 2) * s.p];
  fs.forEach((fr, i) => {
    const o = s.osc(i === 2 ? 'square' : wave, fr, t, t + d + 0.8, i === 2 ? s.g(0.35, lp) : lp);
    o.frequency.setValueAtTime(fr * 0.93, t);
    o.frequency.exponentialRampToValueAtTime(fr, t + 0.25);
  });
  lp.frequency.setValueAtTime(260, t);
  lp.frequency.linearRampToValueAtTime(620, t + 0.3);
  lp.frequency.setTargetAtTime(480, t + 0.4, 0.4);
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(v * 0.5, t + 0.22);
  out.gain.setValueAtTime(v * 0.5, t + d);
  out.gain.setTargetAtTime(0, t + d, 0.18);
  out.gain.setValueAtTime(0, t + d + 0.8);
}

function steamWhistle(s: Snd, t: number, d: number): void {
  const out = s.g(0, s.out);
  for (const f of [523, 659, 784]) {
    const bp = s.f('bandpass', f * 2, 18, s.g(1.8, out));
    s.noise('white', t, t + d + 0.3, bp);
    s.osc('sine', f * 2, t, t + d + 0.3, s.g(0.05, out));
  }
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(0.32, t + 0.1);
  out.gain.setValueAtTime(0.3, t + d);
  out.gain.setTargetAtTime(0, t + d, 0.08);
  out.gain.setValueAtTime(0, t + d + 0.3);
}
