// Pure music data: original sea-shanty style tunes in 6/8, as functions of (loop, bar) -> note events.
// No WebAudio or DOM here, so the arrangement can be unit-checked in Node.
import type { MusicMood } from '../render/contracts.ts';

export type Inst =
  | 'acc' // accordion chord / pad
  | 'fiddle'
  | 'whistle'
  | 'bass'
  | 'pluck' // bouzouki-ish broken chords
  | 'bodhran'
  | 'rim'
  | 'stomp'
  | 'shaker'
  | 'tamb'
  | 'cymbal'
  | 'timp'
  | 'brass';

export interface NoteEv {
  i: Inst;
  /** start, in eighth notes from the bar start */
  s: number;
  /** duration in eighth notes */
  d: number;
  /** MIDI note (0 for unpitched) */
  n: number;
  /** velocity 0..1 */
  v: number;
  /** 1 = intensity layer (faded by combat heat) */
  layer?: 1;
}

export interface Song {
  mood: MusicMood;
  /** seconds per eighth note */
  eighth: number;
  /** eighths per bar */
  bar: number;
  /** bars per loop (or total for one-shots) */
  bars: number;
  loop: boolean;
  /** lilt: how far (fraction of an eighth) the 2nd/3rd eighth of each triplet group is pushed */
  swing: number;
  events(loop: number, bar: number): NoteEv[];
}

// ---------------------------------------------------------------------------------------------
// harmony helpers
// ---------------------------------------------------------------------------------------------

const PC: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

export interface Chord {
  root: number; // pitch class
  ints: readonly number[];
}

export function parseChord(name: string): Chord {
  const m = /^([A-G](?:#|b)?)(m|7|m7|maj7)?$/.exec(name);
  if (!m) throw new Error(`bad chord ${name}`);
  const root = PC[m[1]];
  const q = m[2] ?? '';
  const ints = q === 'm' ? [0, 3, 7] : q === '7' ? [0, 4, 7, 10] : q === 'm7' ? [0, 3, 7, 10] : q === 'maj7' ? [0, 4, 7, 11] : [0, 4, 7];
  return { root, ints };
}

/** Close voicing of the chord inside [lo, lo + 12). Sorted ascending. */
export function voicing(name: string, lo = 55): number[] {
  const c = parseChord(name);
  const out: number[] = [];
  for (const iv of c.ints) {
    const pc = (c.root + iv) % 12;
    let m = lo + ((pc - (lo % 12) + 12) % 12);
    if (m >= lo + 12) m -= 12;
    out.push(m);
  }
  return out.sort((a, b) => a - b);
}

/** Bass root in [lo, lo + 12). */
export function bassRoot(name: string, lo = 38): number {
  const c = parseChord(name);
  return lo + ((c.root - (lo % 12) + 12) % 12);
}

type Mel = readonly (readonly [number, number])[]; // [midi (0 = rest), eighths]

/** Split a melody into bars of `bar` eighths. Notes crossing a bar line are cut. */
export function melodyBars(mel: Mel, bar: number): { n: number; s: number; d: number }[][] {
  const bars: { n: number; s: number; d: number }[][] = [];
  let pos = 0;
  for (const [n, d] of mel) {
    let rem = d;
    let at = pos;
    while (rem > 0) {
      const bi = Math.floor(at / bar + 1e-9);
      const inBar = at - bi * bar;
      const take = Math.min(rem, bar - inBar);
      while (bars.length <= bi) bars.push([]);
      if (n > 0) bars[bi].push({ n, s: inBar, d: take });
      rem -= take;
      at += take;
    }
    pos += d;
  }
  return bars;
}

function ev(i: Inst, s: number, d: number, n: number, v: number, layer?: 1): NoteEv {
  return layer ? { i, s, d, n, v, layer } : { i, s, d, n, v };
}

// ---------------------------------------------------------------------------------------------
// MENU: "Lantern on the Quay" - warm, unhurried, G major
// ---------------------------------------------------------------------------------------------

const MENU_CHORDS = ['G', 'C', 'G', 'D', 'G', 'C', 'D', 'G', 'Em', 'C', 'G', 'D', 'Em', 'C', 'D7', 'G'];
const MENU_MEL: Mel = [
  [74, 2], [71, 1], [67, 2], [71, 1],
  [72, 2], [76, 1], [79, 2], [76, 1],
  [74, 3], [71, 2], [69, 1],
  [69, 2], [71, 1], [69, 2], [66, 1],
  [67, 2], [71, 1], [74, 2], [79, 1],
  [76, 2], [74, 1], [72, 2], [76, 1],
  [74, 2], [72, 1], [71, 2], [69, 1],
  [67, 5], [0, 1],
  [76, 2], [78, 1], [79, 2], [76, 1],
  [72, 2], [74, 1], [76, 3],
  [74, 2], [71, 1], [67, 2], [71, 1],
  [69, 4], [71, 1], [72, 1],
  [71, 2], [76, 1], [79, 2], [78, 1],
  [76, 2], [74, 1], [72, 2], [76, 1],
  [74, 2], [69, 1], [66, 1], [69, 1], [72, 1],
  [71, 3], [67, 3],
];
const MENU_BARS = melodyBars(MENU_MEL, 6);

const menu: Song = {
  mood: 'menu',
  eighth: 60 / 72 / 3,
  bar: 6,
  bars: 16,
  loop: true,
  swing: 0.12,
  events(loop, bar) {
    const out: NoteEv[] = [];
    const ch = MENU_CHORDS[bar];
    const tones = voicing(ch, 55);
    const root = bassRoot(ch, 40);
    // accordion breathes a sustained chord
    for (const m of tones) out.push(ev('acc', 0, 5.8, m, 0.2));
    // bouzouki broken chord, from the 2nd time round
    if (loop > 0 || bar >= 8) {
      const pat = [tones[0], tones[1], tones[2], tones[0] + 12, tones[2], tones[1]];
      pat.forEach((m, k) => out.push(ev('pluck', k, 1.6, m + 12, k === 0 ? 0.36 : 0.24)));
    }
    out.push(ev('bass', 0, 2.6, root, 0.5));
    out.push(ev('bass', 3, 2.6, root + 7 > 52 ? root - 5 : root + 7, 0.36));
    // melody rotates between instruments; the 4th time round is a breather
    const rot = loop % 4;
    const mel = MENU_BARS[bar] ?? [];
    if (rot !== 3) {
      const inst: Inst = rot === 1 ? 'fiddle' : 'whistle';
      for (const n of mel) out.push(ev(inst, n.s, n.d, inst === 'whistle' ? n.n + 12 : n.n, inst === 'whistle' ? 0.32 : 0.3));
      if (rot === 2 && bar >= 8) for (const n of mel) out.push(ev('fiddle', n.s, n.d, n.n - (n.n % 12 === 7 || n.n % 12 === 0 ? 5 : 4), 0.18));
    } else if (bar % 4 === 3) {
      out.push(ev('whistle', 0, 3, tones[2] + 24, 0.18));
    }
    // soft frame drum after the intro
    if (loop > 0) {
      out.push(ev('bodhran', 0, 1, 0, 0.32));
      out.push(ev('bodhran', 3, 1, 0, 0.2));
      if (bar % 2 === 1) out.push(ev('rim', 5, 1, 0, 0.12));
      if (bar === 15) {
        out.push(ev('bodhran', 4, 1, 0, 0.18));
        out.push(ev('bodhran', 5, 1, 0, 0.24));
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// MATCH: "Haul Away the Hook" - driving D dorian jig with an intensity layer
// ---------------------------------------------------------------------------------------------

const MATCH_CHORDS = ['Dm', 'C', 'Dm', 'Am', 'Dm', 'F', 'C', 'Dm', 'F', 'C', 'Dm', 'Am', 'F', 'C', 'A', 'Dm'];
const MATCH_MEL: Mel = [
  [69, 2], [74, 1], [74, 1], [76, 1], [77, 1],
  [76, 2], [72, 1], [67, 2], [72, 1],
  [74, 2], [69, 1], [65, 1], [69, 1], [74, 1],
  [72, 2], [69, 1], [64, 3],
  [69, 2], [74, 1], [74, 1], [76, 1], [77, 1],
  [79, 2], [77, 1], [76, 1], [74, 1], [72, 1],
  [76, 2], [74, 1], [72, 2], [71, 1],
  [74, 4], [0, 2],
  [77, 2], [77, 1], [76, 2], [74, 1],
  [76, 2], [72, 1], [67, 3],
  [77, 2], [77, 1], [76, 1], [74, 1], [76, 1],
  [72, 3], [69, 3],
  [69, 1], [72, 1], [77, 1], [81, 2], [79, 1],
  [79, 2], [76, 1], [72, 2], [76, 1],
  [76, 2], [73, 1], [69, 2], [73, 1],
  [74, 3], [0, 3],
];
const MATCH_BARS = melodyBars(MATCH_MEL, 6);
// accordion answer riff for the groove-only pass
const MATCH_RIFF: Mel = [[74, 1], [72, 1], [69, 1], [67, 1], [69, 2]];
const MATCH_RIFF_BAR = melodyBars(MATCH_RIFF, 6)[0];

const match: Song = {
  mood: 'match',
  eighth: 60 / 100 / 3,
  bar: 6,
  bars: 16,
  loop: true,
  swing: 0.1,
  events(loop, bar) {
    const out: NoteEv[] = [];
    const ch = MATCH_CHORDS[bar];
    const tones = voicing(ch, 57);
    const root = bassRoot(ch, 38);
    const fifth = root + 7 > 50 ? root - 5 : root + 7;
    // oom-pah: bass on 1 and 4, accordion stabs between
    out.push(ev('bass', 0, 1.5, root, 0.62));
    out.push(ev('bass', 3, 1.5, bar % 8 === 7 ? root + 12 : fifth, 0.5));
    for (const k of [1, 2, 4, 5]) for (const m of tones) out.push(ev('acc', k, 0.62, m, k === 1 || k === 4 ? 0.2 : 0.15));
    // frame drum groove
    out.push(ev('bodhran', 0, 1, 0, 0.62));
    out.push(ev('bodhran', 2, 1, 0, 0.2));
    out.push(ev('bodhran', 3, 1, 0, 0.45));
    out.push(ev('bodhran', 5, 1, 0, 0.26));
    out.push(ev('rim', 4, 1, 0, 0.13));
    const rot = loop % 3;
    const mel = MATCH_BARS[bar] ?? [];
    if (rot === 0) {
      // groove pass: just an accordion answer at the phrase ends, keeps ears fresh
      if (bar % 4 === 3) for (const n of MATCH_RIFF_BAR) out.push(ev('acc', n.s, n.d, n.n, 0.2));
    } else {
      for (const n of mel) out.push(ev('fiddle', n.s, n.d, n.n, 0.34));
      if (rot === 2) for (const n of mel) out.push(ev('whistle', n.s, n.d, n.n + 12, 0.2, 1));
    }
    // intensity layer: shaker, stomps, tambourine, bass drive, fiddle octave
    for (let k = 0; k < 6; k++) out.push(ev('shaker', k, 1, 0, k === 0 || k === 3 ? 0.4 : 0.22, 1));
    out.push(ev('stomp', 0, 1, 0, 0.6, 1));
    out.push(ev('stomp', 3, 1, 0, 0.5, 1));
    out.push(ev('tamb', 3, 1, 0, 0.3, 1));
    out.push(ev('bass', 2, 0.8, root + 12, 0.3, 1));
    out.push(ev('bass', 5, 0.8, root + 12, 0.3, 1));
    if (rot !== 0) for (const n of mel) out.push(ev('fiddle', n.s, n.d, n.n + 12, 0.14, 1));
    if (bar === 15) out.push(ev('cymbal', 5, 4, 0, 0.18, 1));
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// TENSE: "Next Catch Wins" - overtime / close score, D harmonic minor ostinato
// ---------------------------------------------------------------------------------------------

const TENSE_CHORDS = ['Dm', 'Dm', 'Bb', 'A', 'Dm', 'Dm', 'Gm', 'A'];
const TENSE_HIGH: Mel = [[0, 24], [81, 6], [82, 6], [79, 6], [76, 6]];
const TENSE_HIGH_BARS = melodyBars(TENSE_HIGH, 6);

const tense: Song = {
  mood: 'tense',
  eighth: 60 / 116 / 3,
  bar: 6,
  bars: 8,
  loop: true,
  swing: 0.04,
  events(loop, bar) {
    const out: NoteEv[] = [];
    const ch = TENSE_CHORDS[bar];
    const low = voicing(ch, 50);
    const hi = voicing(ch, 62);
    const root = bassRoot(ch, 38);
    // low drone
    out.push(ev('acc', 0, 5.9, low[0], 0.17));
    out.push(ev('acc', 0, 5.9, low[low.length - 1], 0.13));
    // fiddle ostinato
    const pat = [hi[2] ?? hi[0] + 12, hi[0], hi[1], hi[0], hi[2] ?? hi[1], hi[1]];
    pat.forEach((m, k) => out.push(ev('fiddle', k, 0.55, m, k === 0 || k === 3 ? 0.3 : 0.22)));
    // bass pulse
    out.push(ev('bass', 0, 1.2, root, 0.62));
    out.push(ev('bass', 3, 1.2, root, 0.5));
    out.push(ev('bass', 5, 0.6, root + 12, 0.32));
    // heartbeat drum
    out.push(ev('bodhran', 0, 1, 0, 0.7));
    out.push(ev('bodhran', 1, 1, 0, 0.42));
    out.push(ev('bodhran', 3, 1, 0, 0.55));
    out.push(ev('bodhran', 4, 1, 0, 0.32));
    // the long high line every other pass
    if (loop % 2 === 1) for (const n of TENSE_HIGH_BARS[bar] ?? []) out.push(ev('whistle', n.s, n.d, n.n, 0.2));
    // layer
    for (let k = 0; k < 6; k++) out.push(ev('tamb', k, 1, 0, k % 3 === 0 ? 0.28 : 0.15, 1));
    if (bar === 0 || bar === 4) out.push(ev('timp', 0, 3, 38, 0.5, 1));
    if (bar === 7) out.push(ev('timp', 3, 3, 45, 0.45, 1));
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// VICTORY / DEFEAT stingers (one-shot, then quiet)
// ---------------------------------------------------------------------------------------------

const victory: Song = {
  mood: 'victory',
  eighth: 0.17,
  bar: 6,
  bars: 4,
  loop: false,
  swing: 0,
  events(_loop, bar) {
    const out: NoteEv[] = [];
    if (bar === 0) {
      [[74, 0, 1], [78, 1, 1], [81, 2, 1], [86, 3, 3]].forEach(([n, s, d]) => {
        out.push(ev('fiddle', s, d, n, 0.4));
        out.push(ev('whistle', s, d, n + 12, 0.22));
      });
      for (const m of voicing('D', 57)) out.push(ev('acc', 0, 2.8, m, 0.24));
      for (const m of voicing('G', 57)) out.push(ev('acc', 3, 2.8, m, 0.24));
      out.push(ev('bass', 0, 2.5, 38, 0.65));
      out.push(ev('bass', 3, 2.5, 43, 0.6));
      out.push(ev('bodhran', 0, 1, 0, 0.7));
      out.push(ev('bodhran', 3, 1, 0, 0.6));
      out.push(ev('cymbal', 0, 6, 0, 0.25));
    } else if (bar === 1) {
      [[83, 0, 2], [81, 2, 1], [78, 3, 1], [76, 4, 2]].forEach(([n, s, d]) => out.push(ev('fiddle', s, d, n, 0.4)));
      for (const m of voicing('A7', 57)) out.push(ev('acc', 0, 5.8, m, 0.22));
      out.push(ev('bass', 0, 5, 45, 0.6));
      out.push(ev('timp', 3, 3, 45, 0.5));
    } else if (bar === 2) {
      out.push(ev('fiddle', 0, 6, 86, 0.42));
      out.push(ev('whistle', 0, 6, 90, 0.22));
      out.push(ev('brass', 0, 6, 0, 0.6));
      for (const m of voicing('D', 57)) out.push(ev('acc', 0, 6, m, 0.24));
      out.push(ev('bass', 0, 6, 38, 0.65));
      out.push(ev('cymbal', 0, 8, 0, 0.3));
      out.push(ev('bodhran', 0, 1, 0, 0.8));
    } else {
      for (const m of voicing('D', 62)) out.push(ev('acc', 0, 6, m, 0.08));
    }
    return out;
  },
};

const defeat: Song = {
  mood: 'defeat',
  eighth: 0.26,
  bar: 6,
  bars: 4,
  loop: false,
  swing: 0,
  events(_loop, bar) {
    const out: NoteEv[] = [];
    if (bar === 0) {
      [[69, 0, 2], [67, 2, 1], [65, 3, 2], [64, 5, 1]].forEach(([n, s, d]) => out.push(ev('fiddle', s, d, n, 0.32)));
      for (const m of voicing('Dm', 57)) out.push(ev('acc', 0, 5.8, m, 0.16));
      out.push(ev('bass', 0, 5, 38, 0.5));
      out.push(ev('bodhran', 0, 1, 0, 0.35));
    } else if (bar === 1) {
      [[64, 0, 2], [61, 2, 1], [57, 3, 3]].forEach(([n, s, d]) => out.push(ev('fiddle', s, d, n, 0.3)));
      for (const m of voicing('A7', 55)) out.push(ev('acc', 0, 5.8, m, 0.15));
      out.push(ev('bass', 0, 5, 45, 0.45));
    } else if (bar === 2) {
      out.push(ev('fiddle', 0, 6, 62, 0.3));
      for (const m of voicing('Dm', 57)) out.push(ev('acc', 0, 6, m, 0.15));
      out.push(ev('bass', 0, 6, 38, 0.45));
      out.push(ev('bodhran', 0, 1, 0, 0.3));
    }
    return out;
  },
};

export const SONGS: Record<Exclude<MusicMood, 'none'>, Song> = { menu, match, tense, victory, defeat };

/** Swing offset (eighths) for a position inside a 6/8 bar. */
export function swingOffset(pos: number, swing: number): number {
  const k = ((pos % 3) + 3) % 3;
  const frac = pos - Math.floor(pos);
  if (frac > 1e-6) return 0;
  return k === 1 ? swing * 0.5 : k === 2 ? swing * 0.25 : 0;
}

/** Raw melodies, exported for unit checks. */
export const MELODIES = { menu: MENU_MEL, match: MATCH_MEL, tenseHigh: TENSE_HIGH } as const;
