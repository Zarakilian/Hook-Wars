// Master chain, buses, map reverb and the SFX voice manager (spatial pan + distance, voice limits,
// stealing, merging, throttling). Shared by the live system and the offline self-test.
import type { SfxId } from '../render/contracts.ts';
import type { MapId } from '../../shared/types.ts';
import { Baker, sfxKey } from './bake.ts';
import { Snd, fadeOut, makeIR, type Kit, type SndEnv } from './core.ts';
import { ROOMS } from './rooms.ts';
import { SFX } from './sfx.ts';

export interface MasterGraph {
  /** everything mixes into here (master volume) */
  master: GainNode;
  sfxBus: GainNode;
  voxBus: GainNode;
  ambBus: GainNode;
  musicBus: GainNode;
  sfxSend: GainNode;
  voxSend: GainNode;
  ambSend: GainNode;
  musicSend: GainNode;
  musicDuck: GainNode;
  ambDuck: GainNode;
  reverbIn: GainNode;
  revReturn: GainNode;
  comp: DynamicsCompressorNode;
  limiter: DynamicsCompressorNode;
}

/** Music sits well under the SFX at the default slider positions. */
export const MUSIC_TRIM = 0.5;
export const AMB_TRIM = 0.32;

export function buildMaster(ctx: BaseAudioContext, kit: Kit): MasterGraph {
  const gain = (v: number, dest?: AudioNode) => {
    const g = ctx.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  };
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 24;
  hp.Q.value = 0.6;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 8;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.09;
  const pre = gain(0.5);
  const clip = ctx.createWaveShaper();
  clip.curve = kit.clip;
  clip.oversample = '2x';
  const master = gain(0.64);
  master.connect(hp);
  hp.connect(comp);
  comp.connect(limiter);
  limiter.connect(pre);
  pre.connect(clip);
  clip.connect(ctx.destination);

  const sfxBus = gain(0.81, master);
  const voxBus = gain(0.81, master);
  const ambDuck = gain(1, master);
  const ambBus = gain(0.81 * AMB_TRIM, ambDuck);
  const musicDuck = gain(1, master);
  const musicBus = gain(0.3 * MUSIC_TRIM, musicDuck);
  const revReturn = gain(0.85, master);
  const reverbIn = gain(1);
  const sfxSend = gain(0.81, reverbIn);
  const voxSend = gain(0.81, reverbIn);
  const ambSend = gain(0.81 * AMB_TRIM, reverbIn);
  // music reverb follows the music ducking too
  const musicSend = gain(0.3 * MUSIC_TRIM, reverbIn);
  return { master, sfxBus, voxBus, ambBus, musicBus, sfxSend, voxSend, ambSend, musicSend, musicDuck, ambDuck, reverbIn, revReturn, comp, limiter };
}

/** Slider (0..1) to gain: squared, a cheap perceptual taper. */
export function taper(v: number): number {
  const c = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  return c * c;
}

export function applyVolumes(g: MasterGraph, now: number, master: number, sfx: number, music: number): void {
  const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.03);
  set(g.master.gain, taper(master));
  set(g.sfxBus.gain, taper(sfx));
  set(g.voxBus.gain, taper(sfx));
  set(g.sfxSend.gain, taper(sfx));
  set(g.voxSend.gain, taper(sfx));
  set(g.ambBus.gain, taper(sfx) * AMB_TRIM);
  set(g.ambSend.gain, taper(sfx) * AMB_TRIM);
  set(g.musicBus.gain, taper(music) * MUSIC_TRIM);
  set(g.musicSend.gain, taper(music) * MUSIC_TRIM);
}

// ---------------------------------------------------------------------------------------------
// reverb per map
// ---------------------------------------------------------------------------------------------


export class ReverbSwitch {
  private readonly ctx: BaseAudioContext;
  private readonly input: AudioNode;
  private readonly output: AudioNode;
  private cur: { conv: ConvolverNode; g: GainNode; room: string } | null = null;
  private readonly old: { conv: ConvolverNode; g: GainNode; kill: number }[] = [];

  constructor(ctx: BaseAudioContext, input: AudioNode, output: AudioNode) {
    this.ctx = ctx;
    this.input = input;
    this.output = output;
  }

  get room(): string | null {
    return this.cur?.room ?? null;
  }

  set(room: MapId | 'menu', now: number): void {
    if (this.cur?.room === room) return;
    const conv = this.ctx.createConvolver();
    conv.buffer = makeIR(this.ctx, ROOMS[room]);
    const g = this.ctx.createGain();
    this.input.connect(conv);
    conv.connect(g);
    g.connect(this.output);
    if (this.cur) {
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(1, now + 0.8);
      const o = this.cur;
      o.g.gain.cancelScheduledValues(now);
      o.g.gain.setValueAtTime(o.g.gain.value, now);
      o.g.gain.linearRampToValueAtTime(0, now + 0.8);
      this.old.push({ conv: o.conv, g: o.g, kill: now + 4 });
    }
    this.cur = { conv, g, room };
  }

  tick(now: number): void {
    for (let k = this.old.length - 1; k >= 0; k--) {
      const o = this.old[k];
      if (now < o.kill) continue;
      try {
        this.input.disconnect(o.conv);
        o.conv.disconnect();
        o.g.disconnect();
      } catch {
        // ok
      }
      this.old.splice(k, 1);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// voices
// ---------------------------------------------------------------------------------------------

interface Voice {
  id: SfxId;
  prio: number;
  start: number;
  end: number;
  vol: number;
  vin: GainNode;
  nodes: AudioNode[];
  srcs: AudioScheduledSourceNode[];
  x: number;
  z: number;
  spatial: boolean;
  stolen: boolean;
}

export interface PlayOpts {
  x?: number;
  z?: number;
  volume?: number;
  pitch?: number;
  family?: SndEnv['family'];
}

export interface PlayResult {
  played: boolean;
  /** combat heat this sound adds (already distance weighted) */
  heat: number;
}

/** Spatial model: distance attenuation, pan and air absorption from a listener at (lx, lz). */
export function spatial(x: number, z: number, lx: number, lz: number): { att: number; pan: number; lp: number; wet: number } {
  const dx = x - lx;
  const dz = z - lz;
  const d = Math.hypot(dx, dz * 0.85);
  const att = Math.max(0.1, 1 / (1 + Math.max(0, d - 6) / 13));
  const pan = Math.max(-1, Math.min(1, dx / 20)) * 0.85;
  const lp = d < 10 ? 20000 : Math.max(1700, 20000 * Math.pow(att, 1.7));
  const wet = 1 + Math.min(1.4, d / 22);
  return { att, pan, lp, wet };
}

export const MAX_VOICES = 26;

export class VoiceManager {
  private readonly kit: Kit;
  private readonly bus: AudioNode;
  private readonly send: AudioNode;
  private readonly voices: Voice[] = [];
  private readonly last = new Map<SfxId, { t: number; x: number; z: number; spatial: boolean; v: Voice | null }>();
  lx = 0;
  lz = 0;
  env: SndEnv = {};
  /** optional background baker: once a recipe is baked, play() is a single buffer source */
  baker: Baker | null = null;
  baked = 0;
  live = 0;

  constructor(kit: Kit, bus: AudioNode, send: AudioNode) {
    this.kit = kit;
    this.bus = bus;
    this.send = send;
  }

  get count(): number {
    return this.voices.length;
  }

  play(id: SfxId, o: PlayOpts | undefined, now: number): PlayResult {
    const def = SFX[id];
    if (!def) return { played: false, heat: 0 };
    const ctx = this.kit.ctx;
    const hasPos = !!o && Number.isFinite(o.x) && Number.isFinite(o.z);
    const x = hasPos ? (o!.x as number) : this.lx;
    const z = hasPos ? (o!.z as number) : this.lz;
    const prev = this.last.get(id);
    if (prev) {
      // currentTime only moves per render quantum, so a whole frame of events shares one time.
      // Throttle and merge only the SAME source: both non-spatial (UI, own unit) or both spatial and close.
      const dt = now - prev.t;
      const near = hasPos ? prev.spatial && Math.hypot(prev.x - x, prev.z - z) < 3 : !prev.spatial;
      if (def.gap && dt >= 0 && dt < def.gap && near) return { played: false, heat: 0 };
      // same sound, same moment, same place: merge into one slightly louder voice
      if (dt >= 0 && dt < 0.025 && near) {
        const v = prev.v;
        if (v && !v.stolen) v.vin.gain.setTargetAtTime(v.vol * 1.3, now, 0.01);
        return { played: false, heat: 0 };
      }
    }
    let att = 1;
    let pan = 0;
    let lp = 20000;
    let wet = 1;
    if (hasPos) {
      const sp = spatial(x, z, this.lx, this.lz);
      att = sp.att;
      pan = sp.pan;
      lp = sp.lp;
      wet = sp.wet;
    }
    const vol = def.v * Math.max(0, Math.min(2, o?.volume ?? 1)) * att;
    if (vol < 0.006) return { played: false, heat: 0 };

    // ---- voice limits
    let same = 0;
    let oldestSame: Voice | null = null;
    for (const v of this.voices) {
      if (v.stolen || v.id !== id) continue;
      same++;
      if (!oldestSame || v.start < oldestSame.start) oldestSame = v;
    }
    if (same >= def.cap && oldestSame) this.steal(oldestSame, now);
    if (this.active() >= MAX_VOICES) {
      let victim: Voice | null = null;
      let worst = Infinity;
      for (const v of this.voices) {
        if (v.stolen) continue;
        // lower priority, quieter and older voices go first
        const age = now - v.start;
        const score = v.prio * 10 + v.vol * 4 - age * 0.5;
        if (score < worst) {
          worst = score;
          victim = v;
        }
      }
      const mine = def.prio * 10 + vol * 4;
      if (!victim || mine < worst) return { played: false, heat: 0 };
      this.steal(victim, now);
    }

    // ---- build
    const vin = ctx.createGain();
    vin.gain.value = vol;
    const nodes: AudioNode[] = [];
    const s0 = new Snd(this.kit, vin, null, now, 1);
    const pn = s0.panner(pan, this.bus);
    nodes.push(pn);
    if (lp < 19000) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      f.Q.value = 0.5;
      f.connect(pn);
      vin.connect(f);
      nodes.push(f);
    } else {
      vin.connect(pn);
    }
    if (def.rev > 0) {
      const sg = ctx.createGain();
      sg.gain.value = Math.min(1, def.rev * wet);
      vin.connect(sg);
      sg.connect(this.send);
      nodes.push(sg);
    }
    const pitch = Math.max(0.25, Math.min(4, (o?.pitch ?? 1) * (1 + (this.kit.rng() * 2 - 1) * def.vary)));
    const env: SndEnv = { ...this.env, family: o?.family ?? this.env.family };
    const s = new Snd(this.kit, vin, null, now + 0.004, pitch, env);
    try {
      const key = this.baker ? sfxKey(id, env) : '';
      const buf = this.baker ? this.baker.get(key) : null;
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = pitch;
        src.connect(vin);
        src.start(s.t);
        s.track(src, s.t + buf.duration / pitch + 0.01);
        this.baked++;
      } else {
        def.fn(s);
        this.live++;
        if (this.baker) this.baker.request(sfxBakeJob(id, env, key), true);
      }
    } catch (err) {
      try {
        vin.disconnect();
      } catch {
        // ok
      }
      console.warn('[audio] sfx failed', id, err);
      return { played: false, heat: 0 };
    }
    const voice: Voice = { id, prio: def.prio, start: now, end: s.end + 0.15, vol, vin, nodes, srcs: s.srcs, x, z, spatial: hasPos, stolen: false };
    this.voices.push(voice);
    this.last.set(id, { t: now, x, z, spatial: hasPos, v: voice });
    return { played: true, heat: (def.heat ?? 0) * (hasPos ? Math.min(1, att * 1.3) : 1) };
  }

  private active(): number {
    let n = 0;
    for (const v of this.voices) if (!v.stolen) n++;
    return n;
  }

  private steal(v: Voice, now: number): void {
    v.stolen = true;
    fadeOut(v.vin.gain, now, 0.015);
    for (const src of v.srcs) {
      try {
        src.stop(now + 0.02);
      } catch {
        // already stopped
      }
    }
    v.end = now + 0.05;
  }

  /** Release finished voices. */
  tick(now: number): void {
    for (let k = this.voices.length - 1; k >= 0; k--) {
      const v = this.voices[k];
      if (now < v.end) continue;
      try {
        v.vin.disconnect();
        for (const n of v.nodes) n.disconnect();
      } catch {
        // ok
      }
      this.voices.splice(k, 1);
      const l = this.last.get(v.id);
      if (l && l.v === v) l.v = null;
    }
  }

  stopAll(now: number): void {
    for (const v of this.voices) if (!v.stolen) this.steal(v, now);
  }
}

/** Render length budget for baking each SFX (before trimming). */
const BAKE_LEN: Partial<Record<SfxId, number>> = {
  tideHorn: 4.8, victory: 4.2, defeat: 3.2, drown: 2.8, hookClash: 3.2, iceCrack: 2.6, mineBoom: 2.8, bullseye: 2.4, pie: 2, runeSpawn: 1.8,
};
/** Frequent sounds get two takes so repeats are not identical. */
const TWO_TAKES = new Set<SfxId>([
  'hookThrow', 'hookHit', 'hookWall', 'hookBounce', 'hookReturn', 'hookBreak', 'hookHitAlly', 'hookClash', 'grappleThrow', 'grappleLatch', 'grappleLand',
  'bash', 'melee', 'hurt', 'death', 'corpse', 'splash', 'drown', 'footstep', 'hazardBurst',
]);

export function sfxBakeJob(id: SfxId, env: SndEnv, key = sfxKey(id, env)) {
  return {
    key,
    takes: TWO_TAKES.has(id) ? 2 : 1,
    channels: 1 as const,
    maxDur: BAKE_LEN[id] ?? 2.2,
    env,
    render: (s: Snd) => SFX[id].fn(s),
  };
}
