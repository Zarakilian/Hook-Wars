// Offline self-test: renders every SfxId (with family and map variants), every announcer key,
// each music mood and each ambience bed into an OfflineAudioContext through the real master chain,
// then reports peak, loudness and audible length. Needs no user gesture, so it works headless.
import { MAPS } from '../../shared/maps/index.ts';
import type { FamilyId, MapId } from '../../shared/types.ts';
import type { MusicMood, SfxId } from '../render/contracts.ts';
import { ANNOUNCE, ANNOUNCE_IDS, type AnnounceId } from './announcer.ts';
import { Ambience } from './ambience.ts';
import { Snd, makeKit } from './core.ts';
import { ReverbSwitch, VoiceManager, applyVolumes, buildMaster } from './mixer.ts';
import { benchInstruments, scheduleSongOffline } from './music.ts';
import { SONGS } from './patterns.ts';
import { SFX, brass, drum } from './sfx.ts';
import { speak } from './voice.ts';

export interface SelfTestItem {
  id: string;
  kind: 'sfx' | 'announce' | 'music' | 'ambience';
  peak: number;
  /** loudest 100 ms window RMS (short-term loudness) */
  loud: number;
  /** whole-render RMS */
  rms: number;
  /** seconds until the signal stays below -60 dBFS */
  audible: number;
  nan: boolean;
  ms: number;
  ok: boolean;
  note?: string;
}

export interface SelfTestReport {
  sampleRate: number;
  items: SelfTestItem[];
  failures: string[];
  totalMs: number;
}

type Job = { id: string; kind: SelfTestItem['kind']; dur: number; build: (c: OfflineAudioContext) => void };

const LONG: Partial<Record<SfxId, number>> = { tideHorn: 4.6, victory: 4, defeat: 3, drown: 2.6, hookClash: 3, iceCrack: 2.4, mineBoom: 2.6 };

function jobs(sr: number): Job[] {
  void sr;
  const out: Job[] = [];
  const setup = (c: OfflineAudioContext, mapId: MapId | null) => {
    const kit = makeKit(c, 1234);
    const g = buildMaster(c, kit);
    applyVolumes(g, 0, 0.8, 0.9, 0.55);
    const rv = new ReverbSwitch(c, g.reverbIn, g.revReturn);
    rv.set(mapId ?? 'menu', 0);
    return { kit, g };
  };
  const sfx = (id: SfxId, family?: FamilyId, mapId: MapId | null = null, pos?: { x: number; z: number }) => {
    const label = id + (family ? `:${family}` : '') + (mapId ? `@${mapId}` : '') + (pos ? `(${pos.x},${pos.z})` : '');
    out.push({
      id: label,
      kind: 'sfx',
      dur: LONG[id] ?? 2,
      build: (c) => {
        const { kit, g } = setup(c, mapId);
        const vm = new VoiceManager(kit, g.sfxBus, g.sfxSend);
        vm.env = { mapId, special: mapId ? MAPS[mapId].special : null };
        vm.play(id, { family, x: pos?.x, z: pos?.z }, 0.01);
      },
    });
  };
  for (const id of Object.keys(SFX) as SfxId[]) sfx(id);
  for (const f of ['ogre', 'bot'] as FamilyId[]) {
    sfx('hookThrow', f);
    sfx('hookReturn', f);
    sfx('bash', f);
    sfx('hurt', f);
    sfx('death', f);
    sfx('footstep', f);
  }
  sfx('tideHorn', undefined, 'frostfang');
  sfx('tideHorn', undefined, 'cogwater');
  sfx('hazardBurst', undefined, 'frostfang');
  sfx('hazardBurst', undefined, 'cogwater');
  sfx('hookHit', undefined, null, { x: 30, z: 10 });
  for (const id of ANNOUNCE_IDS) {
    out.push({
      id,
      kind: 'announce',
      dur: ANNOUNCE[id].dur + 2.5,
      build: (c) => {
        const { kit, g } = setup(c, null);
        const o = c.createGain();
        o.gain.value = ANNOUNCE[id as AnnounceId].v;
        o.connect(g.voxBus);
        ANNOUNCE[id as AnnounceId].fn(new Snd(kit, o, g.voxSend, 0.01, 1));
      },
    });
  }
  for (const mood of Object.keys(SONGS) as Exclude<MusicMood, 'none'>[]) {
    const song = SONGS[mood];
    const bars = song.loop ? 4 : song.bars;
    for (const inten of song.loop ? [0, 1] : [0]) {
      out.push({
        id: `${mood}${song.loop ? `@${inten}` : ''}`,
        kind: 'music',
        dur: bars * song.bar * song.eighth + 2.5,
        build: (c) => {
          const { kit, g } = setup(c, null);
          scheduleSongOffline(kit, mood, g.musicBus, bars, inten);
        },
      });
    }
  }
  for (const id of Object.keys(MAPS) as MapId[]) {
    out.push({
      id,
      kind: 'ambience',
      dur: 8,
      build: (c) => {
        const { kit, g } = setup(c, id);
        const a = new Ambience(kit, g.ambBus, g.ambSend);
        a.set(MAPS[id], null, 0);
        a.tick(0, 8);
      },
    });
  }
  return out;
}

function analyse(buf: AudioBuffer): { peak: number; loud: number; rms: number; audible: number; nan: boolean } {
  const sr = buf.sampleRate;
  const n = buf.length;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  let peak = 0;
  let sum = 0;
  let nan = false;
  let last = 0;
  const win = Math.max(1, Math.floor(sr * 0.1));
  let wsum = 0;
  let loud = 0;
  for (let i = 0; i < n; i++) {
    const a = L[i];
    const b = R[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      nan = true;
      continue;
    }
    const m = Math.max(Math.abs(a), Math.abs(b));
    if (m > peak) peak = m;
    if (m > 0.001) last = i;
    const e = (a * a + b * b) * 0.5;
    sum += e;
    wsum += e;
    if (i >= win) {
      const o = (L[i - win] * L[i - win] + R[i - win] * R[i - win]) * 0.5;
      if (Number.isFinite(o)) wsum -= o;
    }
    if (i >= win - 1 && wsum > loud) loud = wsum;
  }
  return { peak, loud: Math.sqrt(Math.max(0, loud) / win), rms: Math.sqrt(sum / Math.max(1, n)), audible: last / sr, nan };
}

export async function runSelfTest(opts?: { only?: string[]; sampleRate?: number }): Promise<SelfTestReport> {
  const sr = opts?.sampleRate ?? 44100;
  const t0 = performance.now();
  const items: SelfTestItem[] = [];
  const failures: string[] = [];
  for (const j of jobs(sr)) {
    if (opts?.only && !opts.only.some((o) => j.id === o || j.id.startsWith(o))) continue;
    const s = performance.now();
    let item: SelfTestItem;
    try {
      const c = new OfflineAudioContext(2, Math.ceil(sr * j.dur), sr);
      j.build(c);
      const buf = await c.startRendering();
      const a = analyse(buf);
      const ok = !a.nan && a.peak <= 1.0 && a.peak > 0.015;
      item = { id: j.id, kind: j.kind, ...a, ms: Math.round(performance.now() - s), ok };
      if (!ok) item.note = a.nan ? 'NaN' : a.peak > 1 ? 'clipping' : 'silent';
    } catch (err) {
      item = { id: j.id, kind: j.kind, peak: 0, loud: 0, rms: 0, audible: 0, nan: false, ms: Math.round(performance.now() - s), ok: false, note: String(err) };
    }
    if (!item.ok) failures.push(`${item.id}: ${item.note}`);
    items.push(item);
  }
  return { sampleRate: sr, items, failures, totalMs: Math.round(performance.now() - t0) };
}

/** Time the main-thread graph building of instruments and whole music bars (no rendering). */
export function benchMusic(): { perNote: Record<string, number>; perBar: Record<string, number> } {
  const c = new OfflineAudioContext(2, 44100, 44100);
  const kit = makeKit(c, 5);
  const perNote = benchInstruments(kit, c.destination);
  const perBar: Record<string, number> = {};
  for (const mood of Object.keys(SONGS) as Exclude<MusicMood, 'none'>[]) {
    const c2 = new OfflineAudioContext(2, 44100 * 40, 44100);
    const k2 = makeKit(c2, 6);
    const t0 = performance.now();
    const bars = SONGS[mood].loop ? 8 : SONGS[mood].bars;
    scheduleSongOffline(k2, mood, c2.destination, bars, 1);
    perBar[mood] = +((performance.now() - t0) / bars).toFixed(2);
  }
  return { perNote, perBar };
}

/** Loudness of the announcer voice alone vs the brass / drum bed it sits on (intelligibility check). */
export async function probeVoice(): Promise<Record<string, number>> {
  const sr = 32000;
  const out: Record<string, number> = {};
  const parts: Record<string, (s: Snd) => void> = {
    voice: (s) => {
      speak(s, [['f', 0.08], ['er', 0.2, 3, 5], ['s', 0.09], ['t', 0.05], ['gap', 0.05], ['h', 0.05], ['u', 0.5, 8, 4], ['k', 0.08]], { f0: 128, v: 1.1, chorus: true, drive: true, sub: 0.3, vib: 0.014 });
    },
    brass: (s) => brass(s, s.t, [50, 62, 66, 69, 74, 78], 1.2, 0.75, 1.35),
    drum: (s) => drum(s, s.t, 50, 0.8, 0.5),
    vowel_i: (s) => {
      speak(s, [['i', 0.6, 0, 0]], { f0: 128, v: 1, drive: false });
    },
    vowel_u: (s) => {
      speak(s, [['u', 0.6, 0, 0]], { f0: 128, v: 1, drive: false });
    },
  };
  for (const [name, fn] of Object.entries(parts)) {
    const c = new OfflineAudioContext(1, sr * 2, sr);
    const kit = makeKit(c, 9);
    const an = c.createAnalyser();
    void an;
    fn(new Snd(kit, c.destination, null, 0.01, 1));
    const buf = await c.startRendering();
    const a = analyse(buf);
    out[name] = +a.loud.toFixed(4);
    if (name.startsWith('vowel')) {
      // energy in a few bands (Goertzel) to confirm the formants land where they should
      const d = buf.getChannelData(0);
      for (const f of [300, 800, 1200, 2250, 3000]) {
        const w = (2 * Math.PI * f) / sr;
        const cw = 2 * Math.cos(w);
        let s1 = 0;
        let s2 = 0;
        for (let i = Math.floor(0.1 * sr); i < Math.floor(0.55 * sr); i++) {
          const s0 = d[i] + cw * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        out[`${name}@${f}`] = +Math.sqrt(s1 * s1 + s2 * s2 - cw * s1 * s2).toFixed(1);
      }
    }
  }
  return out;
}
