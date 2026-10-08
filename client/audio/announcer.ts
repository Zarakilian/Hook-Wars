// Announcer stingers: a hyped formant "voice" shouting the callout over drums, brass and a signature
// sound per key. FIRST HOOK and KRAKEN UNLEASHED are the biggest.
import type { AnnounceKey } from '../../shared/types.ts';
import { BELL, STEEL, Snd, bell, clicks, midiHz, noiseHit, perc, sweep, tone, whoosh } from './core.ts';
import { brass, cymbal, drum, timpaniRoll } from './sfx.ts';
import { speak, type Seg } from './voice.ts';

export type AnnounceId = AnnounceKey | 'countdown3' | 'countdown2' | 'countdown1' | 'go';

export const ANNOUNCE_IDS: readonly AnnounceId[] = [
  'countdown3', 'countdown2', 'countdown1', 'go',
  'firstBlood', 'doubleHook', 'tripleHook', 'ultraHook', 'spree3', 'spree5', 'spree8',
  'shutdown', 'bullseye', 'save', 'drowned', 'overtime',
];

export interface AnnDef {
  /** output gain */
  v: number;
  /** how long it occupies the announcer before the next queued callout may start */
  dur: number;
  /** how much it ducks the music (0..1) */
  duck: number;
  /** queue priority: 3 = never dropped for a smaller callout, 0 = skippable flavour */
  prio: number;
  fn: (s: Snd) => void;
}

const VOICE = 128;

function shout(s: Snd, t: number, segs: readonly Seg[], v: number, extra: { f0?: number; sub?: number; shift?: number; rate?: number; rev?: number } = {}): number {
  return speak(s, segs, {
    t,
    f0: extra.f0 ?? VOICE,
    v,
    chorus: true,
    drive: true,
    sub: extra.sub ?? 0.18,
    shift: extra.shift ?? 1,
    rate: extra.rate ?? 1,
    vib: 0.014,
    rev: extra.rev ?? 0.3,
  });
}

function boom(s: Snd, t: number, f0: number, f1: number, d: number, v: number): void {
  const g = s.g(0, s.out);
  const sh = s.shaper(s.kit.drive, g);
  const o = s.osc('sine', f0, t, t + d + 0.05, s.g(1.3, sh));
  sweep(o.frequency, t, f0, f1, d * 0.8);
  perc(g.gain, t, v, 0.004, d);
}

function ratchetFlourish(s: Snd, t: number, v: number): void {
  clicks(s, { t, n: 16, i0: 0.035, i1: 0.012, f: 2900, q: 4.5, cd: 0.01, v, fJit: 0.06 });
}

function arp(s: Snd, t: number, notes: readonly number[], step: number, v: number, type: OscillatorType = 'triangle', d = 0.25): void {
  notes.forEach((m, i) => tone(s, { t: t + i * step, type, f: midiHz(m), a: 0.004, d, v }));
}

export const ANNOUNCE: Record<AnnounceId, AnnDef> = {
  countdown3: {
    v: 0.16, dur: 0.6, duck: 0.3, prio: 3,
    fn: (s) => {
      drum(s, s.t, 70, 0.55, 0.3);
      brass(s, s.t, [57, 64], 0.28, 0.22);
      shout(s, s.t + 0.02, [['th', 0.06], ['r', 0.05, 4], ['i', 0.32, 4, 1]], 0.9);
    },
  },
  countdown2: {
    v: 0.16, dur: 0.6, duck: 0.3, prio: 3,
    fn: (s) => {
      drum(s, s.t, 76, 0.6, 0.3);
      brass(s, s.t, [61, 64], 0.28, 0.24);
      shout(s, s.t + 0.02, [['t', 0.05], ['u', 0.34, 5, 2]], 0.95);
    },
  },
  countdown1: {
    v: 0.16, dur: 0.6, duck: 0.3, prio: 3,
    fn: (s) => {
      drum(s, s.t, 82, 0.65, 0.3);
      brass(s, s.t, [64, 69], 0.3, 0.26);
      shout(s, s.t + 0.02, [['w', 0.07, 6], ['A', 0.18, 6], ['n', 0.16, 5, 2]], 0.95);
    },
  },
  go: {
    v: 0.247, dur: 1.0, duck: 0.4, prio: 3,
    fn: (s) => {
      brass(s, s.t, [50, 62, 66, 69, 74], 0.75, 0.6, 1.25);
      drum(s, s.t, 52, 0.7, 0.4);
      shout(s, s.t + 0.02, [['g', 0.05], ['o', 0.22, 7, 9], ['u', 0.3, 9, 5]], 1.05, { sub: 0.35 });
    },
  },
  firstBlood: {
    v: 0.384, dur: 2.4, duck: 0.6, prio: 3,
    fn: (s) => {
      const t = s.t;
      timpaniRoll(s, t, 0.42, 62, 0.5);
      const hit = t + 0.44;
      cymbal(s, hit, 2.6, 0.45);
      boom(s, hit, 70, 30, 1.4, 0.9);
      brass(s, hit, [38, 50, 57, 62, 66, 69], 0.32, 0.7, 1.2);
      brass(s, hit + 0.34, [57, 62, 69], 0.14, 0.5, 1.2);
      brass(s, hit + 0.5, [50, 62, 66, 69, 74, 78], 1.2, 0.75, 1.35);
      drum(s, hit + 0.5, 50, 0.8, 0.5);
      whoosh(s, { t: hit - 0.3, d: 0.4, f0: 400, fp: 5000, f1: 3000, q: 0.8, v: 0.3, peakAt: 0.85 });
      shout(s, hit + 0.06, [['f', 0.08], ['er', 0.2, 3, 5], ['s', 0.09], ['t', 0.05], ['gap', 0.05], ['h', 0.05], ['u', 0.5, 8, 4], ['k', 0.08]], 1.1, { sub: 0.3, rev: 0.4 });
      const jg = s.g(0.3, s.out);
      s.buf(s.kit.baked('jangle'), hit + 0.02, jg, 0.9);
    },
  },
  doubleHook: {
    v: 0.223, dur: 1.4, duck: 0.45, prio: 1,
    fn: (s) => {
      drum(s, s.t, 62, 0.75, 0.3);
      drum(s, s.t + 0.14, 62, 0.85, 0.35);
      brass(s, s.t + 0.14, [52, 64, 68, 71], 0.55, 0.55);
      shout(s, s.t + 0.18, [['d', 0.04], ['A', 0.14, 3], ['b', 0.04], ['l', 0.12, 2], ['gap', 0.04], ['h', 0.04], ['u', 0.38, 7, 4], ['k', 0.07]], 1);
    },
  },
  tripleHook: {
    v: 0.228, dur: 1.5, duck: 0.5, prio: 2,
    fn: (s) => {
      for (let i = 0; i < 3; i++) drum(s, s.t + i * 0.12, 62 + i * 4, 0.7 + i * 0.1, 0.3);
      brass(s, s.t + 0.24, [54, 66, 70, 73], 0.6, 0.6, 1.1);
      cymbal(s, s.t + 0.24, 1.4, 0.25);
      shout(s, s.t + 0.28, [['t', 0.04], ['r', 0.05, 4], ['I', 0.12, 4], ['p', 0.05], ['l', 0.1, 3], ['gap', 0.04], ['h', 0.04], ['u', 0.38, 8, 5], ['k', 0.07]], 1);
    },
  },
  ultraHook: {
    v: 0.235, dur: 1.7, duck: 0.55, prio: 2,
    fn: (s) => {
      for (let i = 0; i < 4; i++) drum(s, s.t + i * 0.1, 60 + i * 5, 0.65 + i * 0.1, 0.3);
      timpaniRoll(s, s.t, 0.4, 70, 0.3);
      brass(s, s.t + 0.4, [44, 56, 68, 72, 75, 80], 0.8, 0.7, 1.3);
      cymbal(s, s.t + 0.4, 2, 0.35);
      boom(s, s.t + 0.4, 65, 32, 1, 0.6);
      shout(s, s.t + 0.44, [['A', 0.14, 5], ['l', 0.07, 5], ['t', 0.04], ['r', 0.05, 6], ['a', 0.16, 6], ['gap', 0.04], ['h', 0.04], ['u', 0.42, 10, 6], ['k', 0.07]], 1.05, { sub: 0.3 });
    },
  },
  spree3: {
    v: 0.223, dur: 1.5, duck: 0.45, prio: 1,
    fn: (s) => {
      ratchetFlourish(s, s.t, 0.4);
      arp(s, s.t + 0.05, [62, 66, 69, 74], 0.06, 0.14, 'sawtooth', 0.18);
      brass(s, s.t + 0.3, [50, 62, 66, 69], 0.5, 0.55);
      drum(s, s.t + 0.3, 58, 0.7, 0.35);
      shout(s, s.t + 0.34, [['r', 0.07, 3], ['i', 0.18, 4], ['l', 0.1, 3], ['gap', 0.04], ['d', 0.04], ['i', 0.26, 7, 4], ['l', 0.14, 3]], 1);
    },
  },
  spree5: {
    v: 0.228, dur: 1.8, duck: 0.5, prio: 2,
    fn: (s) => {
      arp(s, s.t, [67, 69, 71, 72, 74, 76, 78, 79], 0.035, 0.1, 'sawtooth', 0.12);
      noiseHit(s, { t: s.t + 0.3, ft: 'highpass', f: 6500, q: 0.8, a: 0.001, d: 0.25, v: 0.25, pitched: false });
      brass(s, s.t + 0.3, [43, 55, 67, 71, 74, 79], 0.7, 0.62, 1.2);
      bell(s, { t: s.t + 0.32, f: midiHz(91), d: 1.0, v: 0.18, partials: BELL });
      drum(s, s.t + 0.3, 55, 0.75, 0.4);
      shout(s, s.t + 0.34, [['k', 0.05], ['ae', 0.16, 4], ['tsh', 0.09], ['A', 0.07, 3], ['v', 0.06], ['th', 0.04], ['A', 0.07, 3], ['d', 0.04], ['e', 0.2, 7, 8], ['i', 0.22, 8, 4]], 1);
    },
  },
  spree8: {
    v: 0.384, dur: 3.0, duck: 0.7, prio: 3,
    fn: (s) => {
      const t = s.t;
      // the deep rumbles first
      boom(s, t, 48, 24, 2.4, 1.0);
      const roar = s.g(0, s.out);
      const amp = s.g(0.65, roar);
      const rf = s.f('lowpass', 180, 4, amp);
      for (let i = 0; i < 5; i++) {
        const o = s.osc('sawtooth', 52 * s.r(0.94, 1.08), t, t + 1.9, rf);
        o.detune.value = s.r(-30, 30);
        sweep(o.frequency, t, 48 * s.r(0.95, 1.05), 72 * s.r(0.95, 1.05), 1.2);
      }
      s.osc('sine', 23, t, t + 1.9, s.g(0.35, amp.gain));
      sweep(rf.frequency, t, 160, 1500, 0.9);
      rf.frequency.exponentialRampToValueAtTime(380, t + 1.8);
      roar.gain.setValueAtTime(0, t);
      roar.gain.linearRampToValueAtTime(0.75, t + 0.6);
      roar.gain.setTargetAtTime(0, t + 1.2, 0.2);
      noiseHit(s, { t, kind: 'brown', ft: 'lowpass', f: 400, f1: 900, a: 0.5, d: 1.2, v: 0.5, q: 0.8 });
      timpaniRoll(s, t + 0.05, 0.55, 52, 0.55);
      const hit = t + 0.62;
      cymbal(s, hit, 3.2, 0.5);
      brass(s, hit, [26, 38, 50, 57, 62, 65, 69], 1.0, 0.85, 1.1);
      brass(s, hit + 1.0, [34, 46, 58, 62, 65, 70], 0.35, 0.65, 1.2);
      brass(s, hit + 1.35, [33, 45, 57, 61, 64, 69], 0.9, 0.75, 1.35);
      drum(s, hit, 44, 1, 0.6);
      drum(s, hit + 1.0, 48, 0.8, 0.4);
      drum(s, hit + 1.35, 44, 1, 0.6);
      // a monstrous splash
      noiseHit(s, { t: hit, ft: 'lowpass', f: 4500, f1: 300, a: 0.01, d: 0.9, v: 0.45 });
      const bb = s.g(0.35, s.out);
      s.buf(s.kit.baked('bubbles'), hit + 0.2, bb, 0.55);
      shout(s, hit + 0.06, [['k', 0.06], ['r', 0.05, 2], ['a', 0.22, 3], ['k', 0.06], ['e', 0.1, 2], ['n', 0.1, 1], ['gap', 0.06], ['A', 0.1, 0], ['n', 0.07, 0], ['l', 0.06, 1], ['i', 0.28, 6, 7], ['sh', 0.13], ['t', 0.06]], 1.15, { f0: 104, shift: 0.86, sub: 0.6, rate: 1.1, rev: 0.5 });
    },
  },
  shutdown: {
    v: 0.228, dur: 1.6, duck: 0.5, prio: 2,
    fn: (s) => {
      const g = s.g(0, s.f('lowpass', 2500, 1.5, s.out));
      const o = s.osc('sawtooth', 900, s.t, s.t + 0.7, g);
      sweep(o.frequency, s.t, 900, 45, 0.6);
      perc(g.gain, s.t, 0.25, 0.01, 0.65);
      drum(s, s.t + 0.55, 42, 1, 0.5);
      cymbal(s, s.t + 0.55, 1.0, 0.25);
      brass(s, s.t + 0.55, [38, 50, 53, 57], 0.5, 0.6, 0.9);
      shout(s, s.t + 0.58, [['sh', 0.1], ['A', 0.14, 4], ['t', 0.05], ['gap', 0.04], ['d', 0.04], ['a', 0.14, 2], ['u', 0.12, 0], ['n', 0.2, -2, -4]], 1);
    },
  },
  bullseye: {
    v: 0.223, dur: 1.4, duck: 0.45, prio: 0,
    fn: (s) => {
      // the bullseye SFX already rings the golden bell; the callout adds brass and the voice
      brass(s, s.t + 0.05, [55, 67, 71, 74, 79], 0.6, 0.55, 1.3);
      drum(s, s.t + 0.05, 56, 0.7, 0.35);
      shout(s, s.t + 0.1, [['b', 0.04], ['U', 0.12, 3], ['l', 0.08, 3], ['z', 0.08], ['a', 0.18, 7], ['i', 0.26, 8, 5]], 1);
    },
  },
  save: {
    v: 0.218, dur: 1.3, duck: 0.4, prio: 0,
    fn: (s) => {
      // the rescue chime is in the hookHitAlly SFX; this is the warm brass and the voice
      brass(s, s.t + 0.2, [53, 65, 69, 72], 0.5, 0.45);
      shout(s, s.t + 0.22, [['s', 0.1], ['e', 0.18, 4, 6], ['i', 0.12, 6], ['v', 0.06], ['d', 0.05]], 0.95);
    },
  },
  drowned: {
    v: 0.218, dur: 1.5, duck: 0.45, prio: 0,
    fn: (s) => {
      const bb = s.g(0.2, s.f('lowpass', 2000, 0.7, s.out));
      s.buf(s.kit.baked('bubbles'), s.t + 0.6, bb, 0.6, 0.8);
      // trombone-ish "bwah-waaah"
      const lp = s.f('lowpass', 500, 4, s.out);
      brass(s, s.t + 0.1, [58], 0.28, 0.4, 0.8, lp);
      brass(s, s.t + 0.42, [57], 0.6, 0.45, 0.8, lp);
      lp.frequency.setValueAtTime(300, s.t + 0.1);
      lp.frequency.linearRampToValueAtTime(1600, s.t + 0.25);
      lp.frequency.linearRampToValueAtTime(350, s.t + 0.4);
      lp.frequency.linearRampToValueAtTime(1500, s.t + 0.6);
      lp.frequency.linearRampToValueAtTime(300, s.t + 1.0);
      shout(s, s.t + 0.15, [['d', 0.04], ['r', 0.06, 3], ['a', 0.2, 3, 2], ['u', 0.14, 1], ['n', 0.14, 0, -2], ['d', 0.05]], 0.95);
    },
  },
  overtime: {
    v: 0.228, dur: 2.0, duck: 0.55, prio: 3,
    fn: (s) => {
      // clock ticks and a heartbeat under a tense swelling chord
      clicks(s, { t: s.t, n: 6, i0: 0.24, i1: 0.24, f: 3300, q: 6, cd: 0.02, v: 0.35, jitter: 0 });
      for (let i = 0; i < 2; i++) {
        drum(s, s.t + 0.1 + i * 0.7, 45, 0.7, 0.3);
        drum(s, s.t + 0.28 + i * 0.7, 45, 0.5, 0.3);
      }
      const sw = s.g(0, s.out);
      brass(s, s.t, [38, 50, 57, 62, 65], 1.4, 0.75, 0.9, sw);
      sw.gain.setValueAtTime(0, s.t);
      sw.gain.linearRampToValueAtTime(1, s.t + 0.9);
      sw.gain.setTargetAtTime(0, s.t + 1.4, 0.15);
      bell(s, { t: s.t + 0.9, f: midiHz(86), d: 1.0, v: 0.1, partials: STEEL });
      shout(s, s.t + 0.85, [['o', 0.14, 3], ['u', 0.06, 3], ['v', 0.06], ['er', 0.14, 4], ['t', 0.05], ['a', 0.2, 7], ['i', 0.14, 6], ['m', 0.2, 4, 2]], 1);
    },
  },
};
