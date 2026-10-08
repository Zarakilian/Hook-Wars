// Formant voice synthesis: a crude but characterful "talking" synth for the announcer, grunts and crowds.
// Source (sawtooth stack + noise) -> parallel formant band-passes, with phoneme-by-phoneme automation.
import type { Snd } from './core.ts';

type PhKind = 'v' | 'a' | 'n' | 'f' | 'vf' | 'h' | 'p' | 'b' | 'gap';

interface Ph {
  k: PhKind;
  F?: readonly [number, number, number];
  amp?: number;
  nf?: number;
  nq?: number;
  namp?: number;
}

const PH: Record<string, Ph> = {
  a: { k: 'v', F: [760, 1160, 2500] },
  e: { k: 'v', F: [540, 1840, 2480] },
  i: { k: 'v', F: [290, 2250, 3010] },
  I: { k: 'v', F: [400, 1950, 2560] },
  o: { k: 'v', F: [530, 860, 2400] },
  u: { k: 'v', F: [320, 800, 2250] },
  U: { k: 'v', F: [450, 1030, 2300] },
  A: { k: 'v', F: [650, 1200, 2400] },
  ae: { k: 'v', F: [690, 1700, 2450] },
  er: { k: 'v', F: [480, 1350, 1700] },
  ay: { k: 'v', F: [700, 1300, 2500] },
  l: { k: 'a', F: [360, 1250, 2700], amp: 0.55 },
  r: { k: 'a', F: [420, 1250, 1600], amp: 0.6 },
  w: { k: 'a', F: [300, 650, 2200], amp: 0.5 },
  y: { k: 'a', F: [280, 2200, 2900], amp: 0.5 },
  m: { k: 'n', F: [260, 1000, 2300], amp: 0.42 },
  n: { k: 'n', F: [260, 1650, 2600], amp: 0.42 },
  s: { k: 'f', nf: 6300, nq: 2.2, namp: 0.55 },
  sh: { k: 'f', nf: 2900, nq: 1.7, namp: 0.6 },
  f: { k: 'f', nf: 4200, nq: 0.7, namp: 0.25 },
  th: { k: 'f', nf: 5200, nq: 0.6, namp: 0.2 },
  h: { k: 'h', namp: 0.4 },
  z: { k: 'vf', F: [260, 1600, 2600], amp: 0.25, nf: 6000, nq: 2, namp: 0.3 },
  v: { k: 'vf', F: [260, 1100, 2300], amp: 0.3, nf: 3500, nq: 0.8, namp: 0.16 },
  p: { k: 'p', nf: 900, nq: 0.8, namp: 0.7 },
  t: { k: 'p', nf: 4300, nq: 1.2, namp: 0.65 },
  k: { k: 'p', nf: 2100, nq: 1.5, namp: 0.7 },
  tsh: { k: 'p', nf: 3000, nq: 1.6, namp: 0.75 },
  b: { k: 'b', nf: 700, nq: 0.8, namp: 0.4 },
  d: { k: 'b', nf: 3400, nq: 1.0, namp: 0.4 },
  g: { k: 'b', nf: 1800, nq: 1.4, namp: 0.4 },
  gap: { k: 'gap' },
};

/** [phoneme, duration s, start semitone, end semitone, amplitude] */
export type Seg = readonly [string, number, number?, number?, number?];

export interface SpeakOpts {
  t?: number;
  /** fundamental (Hz) */
  f0: number;
  v: number;
  dest?: AudioNode;
  /** time stretch */
  rate?: number;
  /** formant scale: < 1 bigger throat, > 1 smaller */
  shift?: number;
  /** add an octave-down growl layer (0..1) */
  sub?: number;
  /** detuned double for a thicker shout */
  chorus?: boolean;
  /** vibrato depth (fraction) */
  vib?: number;
  /** waveshaper drive for a megaphone edge */
  drive?: boolean;
  /** reverb send */
  rev?: number;
}

const FQ = [5, 8, 10] as const;
const FG = [1, 0.85, 0.55] as const;

/** Speak a phoneme script. Returns the end time. */
export function speak(s: Snd, segs: readonly Seg[], o: SpeakOpts): number {
  const t0 = o.t ?? s.t;
  const rate = o.rate ?? 1;
  const shift = o.shift ?? 1;
  let total = 0;
  for (const sg of segs) total += sg[1] * rate;
  const tEnd = t0 + total;
  const stop = tEnd + 0.25;
  const f0 = o.f0 * s.p;

  const out = s.g(o.v, o.dest ?? s.out);
  const post = s.f('highpass', 110, 0.7, out);
  const pres = s.f('peaking', 2600, 1.1, post, 4);
  const sum = o.drive ? s.shaper(s.kit.drive, s.g(1, pres)) : s.g(1, pres);
  const sumIn = o.drive ? s.g(1.6, sum) : sum;
  if (o.rev) s.send(out, o.rev);

  // ---- voiced source
  const voiced = s.g(0);
  const srcs: { o: OscillatorNode; m: number }[] = [];
  const addSrc = (mult: number, gain: number, detune: number) => {
    const g = s.g(gain, voiced);
    const osc = s.osc('sawtooth', f0 * mult, t0, stop, g);
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(f0 * mult, t0);
    srcs.push({ o: osc, m: mult });
  };
  addSrc(1, 1, 0);
  if (o.chorus) addSrc(1, 0.7, 11);
  if (o.sub) addSrc(0.5, o.sub, -4);
  const vibG = s.g(f0 * (o.vib ?? 0.012));
  s.osc('sine', 5.6, t0, stop, vibG);
  for (const sc of srcs) vibG.connect(sc.o.frequency);

  // ---- formant bank
  const bankIn = s.g(1);
  voiced.connect(bankIn);
  const bank: BiquadFilterNode[] = [];
  for (let i = 0; i < 3; i++) {
    const bp = s.f('bandpass', 500, FQ[i], s.g(FG[i] * 3.2, sumIn));
    bankIn.connect(bp);
    bank.push(bp);
  }
  const f4 = s.f('bandpass', 3400 * shift, 7, s.g(0.9, sumIn));
  bankIn.connect(f4);
  // a little raw body so it is not too thin
  voiced.connect(s.f('lowpass', 900, 0.7, s.g(0.12, sumIn)));

  // ---- noise: fricatives (direct) and aspiration (through the formants)
  const nf = s.f('bandpass', 4000, 1, null);
  const ng = s.g(0, sumIn);
  nf.connect(ng);
  const hg = s.g(0, bankIn);
  const nsrc = s.g(1);
  nsrc.connect(nf);
  nsrc.connect(hg);
  s.noise('white', t0, stop, nsrc);

  // initial formants: first voiced phoneme
  const firstF = segs.map((sg) => PH[sg[0]]?.F).find((F) => F) ?? PH.A.F!;
  for (let i = 0; i < 3; i++) bank[i].frequency.setValueAtTime(firstF[i] * shift, t0);
  voiced.gain.setValueAtTime(0, t0);
  ng.gain.setValueAtTime(0, t0);
  hg.gain.setValueAtTime(0, t0);

  const setF = (F: readonly [number, number, number], at: number, tc: number) => {
    for (let i = 0; i < 3; i++) bank[i].frequency.setTargetAtTime(F[i] * shift, at, tc);
  };
  const setPitch = (st: number, at: number, tc: number) => {
    const f = f0 * Math.pow(2, st / 12);
    for (const sc of srcs) sc.o.frequency.setTargetAtTime(Math.max(20, f * sc.m), at, tc);
  };

  let tau = t0;
  for (let si = 0; si < segs.length; si++) {
    const [name, dur0, st0, st1, ampMul] = segs[si];
    const ph = PH[name] ?? PH.gap;
    const d = dur0 * rate;
    const amp = (ph.amp ?? 1) * (ampMul ?? 1);
    if (st0 !== undefined) setPitch(st0, tau, 0.025);
    if (st1 !== undefined) setPitch(st1, tau + d * 0.35, d * 0.3);
    switch (ph.k) {
      case 'v':
      case 'a':
      case 'n':
        voiced.gain.setTargetAtTime(amp, tau, 0.012);
        ng.gain.setTargetAtTime(0, tau, 0.008);
        hg.gain.setTargetAtTime(0, tau, 0.008);
        setF(ph.F!, tau, ph.k === 'v' ? 0.022 : 0.012);
        break;
      case 'vf':
        voiced.gain.setTargetAtTime(amp, tau, 0.01);
        setF(ph.F!, tau, 0.012);
        nf.frequency.setValueAtTime(ph.nf! * shift, tau);
        nf.Q.setValueAtTime(ph.nq!, tau);
        ng.gain.setTargetAtTime(ph.namp! * (ampMul ?? 1), tau, 0.01);
        break;
      case 'f':
        voiced.gain.setTargetAtTime(0, tau, 0.01);
        hg.gain.setTargetAtTime(0, tau, 0.008);
        nf.frequency.setValueAtTime(ph.nf! * shift, tau);
        nf.Q.setValueAtTime(ph.nq!, tau);
        ng.gain.setTargetAtTime(ph.namp! * (ampMul ?? 1), tau, 0.012);
        ng.gain.setTargetAtTime(0, tau + d * 0.8, 0.012);
        break;
      case 'h': {
        voiced.gain.setTargetAtTime(0, tau, 0.01);
        ng.gain.setTargetAtTime(0, tau, 0.008);
        const next = segs.slice(si + 1).map((sg) => PH[sg[0]]?.F).find((F) => F);
        if (next) setF(next, tau, 0.006);
        hg.gain.setTargetAtTime(ph.namp! * (ampMul ?? 1), tau, 0.01);
        break;
      }
      case 'p':
      case 'b': {
        const voiceBar = ph.k === 'b' ? 0.12 : 0;
        voiced.gain.setTargetAtTime(voiceBar, tau, 0.006);
        ng.gain.setTargetAtTime(0, tau, 0.004);
        hg.gain.setTargetAtTime(0, tau, 0.004);
        const tb = tau + d * 0.62;
        nf.frequency.setValueAtTime(ph.nf! * shift, tb);
        nf.Q.setValueAtTime(ph.nq!, tb);
        ng.gain.setTargetAtTime(ph.namp! * (ampMul ?? 1), tb, 0.0015);
        ng.gain.setTargetAtTime(0, tb + (name === 'tsh' ? 0.05 : 0.01), name === 'tsh' ? 0.02 : 0.01);
        if (ph.k === 'p') {
          hg.gain.setTargetAtTime(0.18, tb + 0.008, 0.008);
          hg.gain.setTargetAtTime(0, tau + d, 0.01);
        }
        break;
      }
      default:
        voiced.gain.setTargetAtTime(0, tau, 0.012);
        ng.gain.setTargetAtTime(0, tau, 0.01);
        hg.gain.setTargetAtTime(0, tau, 0.01);
        break;
    }
    tau += d;
  }
  voiced.gain.setTargetAtTime(0, tEnd, 0.035);
  ng.gain.setTargetAtTime(0, tEnd, 0.02);
  hg.gain.setTargetAtTime(0, tEnd, 0.02);
  return tEnd;
}

/**
 * Crowd vocal: many detuned voices through a shared vowel filter ("oooh", "yaaay", "awww").
 */
export function crowd(
  s: Snd,
  o: { t?: number; d: number; v: number; v0: string; v1: string; lo: number; hi: number; n: number; glide: number; swell: number; dest?: AudioNode; breath?: number },
): number {
  const t = o.t ?? s.t;
  const end = t + o.d;
  const out = s.g(0, o.dest ?? s.out);
  const bankIn = s.g(1 / Math.sqrt(o.n));
  const F0 = PH[o.v0]?.F ?? PH.u.F!;
  const F1 = PH[o.v1]?.F ?? PH.o.F!;
  for (let i = 0; i < 3; i++) {
    const bp = s.f('bandpass', F0[i], FQ[i] * 0.7, s.g(FG[i] * 2.6, out));
    bp.frequency.setValueAtTime(F0[i], t);
    bp.frequency.linearRampToValueAtTime(F1[i], t + o.d * 0.7);
    bankIn.connect(bp);
  }
  for (let i = 0; i < o.n; i++) {
    const f = s.r(o.lo, o.hi) * s.p;
    const st = t + s.r(0, o.swell * 0.6);
    const osc = s.osc('sawtooth', f, st, end, bankIn);
    osc.frequency.setValueAtTime(f, st);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f * o.glide * s.r(0.97, 1.03)), end);
    osc.detune.value = s.r(-20, 20);
  }
  const br = s.g(o.breath ?? 0.5, bankIn);
  s.noise('pink', t, end, br);
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(o.v, t + o.swell);
  out.gain.setTargetAtTime(o.v * 0.8, t + o.swell, o.d * 0.15);
  out.gain.setTargetAtTime(0, t + o.d * 0.55, o.d * 0.12);
  out.gain.setValueAtTime(0, end);
  return end;
}
