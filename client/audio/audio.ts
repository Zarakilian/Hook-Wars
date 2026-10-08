// Audio: procedural WebAudio SFX, ambience and music. (Slice version: a few synth blips.)
import type { MapDef } from '../../shared/maps/types.ts';
import type { AnnounceKey, RiverState } from '../../shared/types.ts';
import type { AudioSystem, MusicMood, SfxId } from '../render/contracts.ts';

export function createAudio(): AudioSystem {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let lx = 0;
  let lz = 0;
  let sfxVol = 0.8;

  function blip(freq: number, dur: number, type: OscillatorType, vol: number) {
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.5), ctx.currentTime + dur);
    g.gain.setValueAtTime(vol * sfxVol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  const TABLE: Partial<Record<SfxId, [number, number, OscillatorType, number]>> = {
    hookThrow: [520, 0.18, 'sawtooth', 0.15],
    hookHit: [140, 0.25, 'square', 0.3],
    bullseye: [880, 0.4, 'triangle', 0.3],
    hookClash: [1200, 0.3, 'square', 0.2],
    hookWall: [300, 0.1, 'square', 0.12],
    bash: [90, 0.3, 'sine', 0.4],
    melee: [200, 0.08, 'square', 0.12],
    splash: [180, 0.35, 'sawtooth', 0.12],
    death: [110, 0.6, 'sawtooth', 0.25],
    rune: [660, 0.3, 'triangle', 0.25],
    mineBoom: [60, 0.6, 'sawtooth', 0.4],
    uiClick: [700, 0.05, 'triangle', 0.12],
    countdown: [440, 0.15, 'triangle', 0.2],
    go: [880, 0.35, 'triangle', 0.25],
  };

  return {
    unlock() {
      if (ctx) {
        if (ctx.state === 'suspended') void ctx.resume();
        return;
      }
      try {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.gain.value = 0.7;
        master.connect(ctx.destination);
      } catch {
        ctx = null;
      }
    },
    play(id: SfxId, o) {
      const t = TABLE[id];
      if (!t) return;
      let vol = t[3] * (o?.volume ?? 1);
      if (o?.x !== undefined && o.z !== undefined) {
        const d = Math.hypot(o.x - lx, o.z - lz);
        vol *= Math.max(0.15, 1 - d / 45);
      }
      blip(t[0] * (o?.pitch ?? 1), t[1], t[2], vol);
    },
    announce(_key: AnnounceKey | 'countdown3' | 'countdown2' | 'countdown1' | 'go') {},
    setListener(x: number, z: number) {
      lx = x;
      lz = z;
    },
    setAmbience(_map: MapDef | null, _river: RiverState | null) {},
    setMusic(_mood: MusicMood) {},
    setVolumes(m: number, s: number) {
      if (master) master.gain.value = m;
      sfxVol = s;
    },
    update() {},
    dispose() {
      void ctx?.close();
      ctx = null;
    },
  };
}
