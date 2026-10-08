// Audio: fully procedural WebAudio sound engine. No audio files: every SFX, announcer stinger,
// ambience bed and music cue is synthesised at runtime.
//
//   voices ─┐                           ┌─ comp ─ limiter ─ soft clip ─ out
//   vox ────┼─ master (volume) ─ hp ────┘
//   amb ────┤        ▲
//   music ──┘        └─ map reverb (generated IR) ◄─ sends
//
// Everything is a no-op until unlock() runs from a user gesture; settings made before that
// (volumes, music mood, ambience) are remembered and applied when the context starts.
import type { MapDef } from '../../shared/maps/types.ts';
import type { AnnounceKey, RiverState } from '../../shared/types.ts';
import type { AudioSystem, MusicMood, SfxId } from '../render/contracts.ts';
import { ANNOUNCE, ANNOUNCE_IDS, type AnnounceId } from './announcer.ts';
import { Ambience } from './ambience.ts';
import { Baker } from './bake.ts';
import { Snd, makeKit, warmKit, type Kit, type SndEnv } from './core.ts';
import { MusicPlayer } from './music.ts';
import { ReverbSwitch, VoiceManager, applyVolumes, buildMaster, sfxBakeJob, type MasterGraph, type PlayOpts } from './mixer.ts';
import { benchMusic, probeVoice, runSelfTest, type SelfTestReport } from './offline.ts';

/** Extra, non-contract controls. The glue can reach them with a cast; see integration notes. */
export interface AudioSystemExt extends AudioSystem {
  /** 0..1 combat intensity override for the adaptive music (otherwise derived from played SFX). */
  setIntensity(v: number | null): void;
  /** Debug and verification hooks (used by the ?debug harness). */
  readonly debug: AudioDebug;
}

export interface AudioDebug {
  state(): Record<string, unknown>;
  /** allow play()/announce() while the context is suspended (headless checks) */
  force: boolean;
  /** render every SfxId, AnnounceKey, music mood and ambience bed offline and report levels */
  selfTest(opts?: { only?: string[]; sampleRate?: number }): Promise<SelfTestReport>;
  /** announcer voice vs bed loudness and vowel formant energies */
  probeVoice(): Promise<Record<string, number>>;
  /** main-thread cost of building music notes and bars */
  benchMusic(): { perNote: Record<string, number>; perBar: Record<string, number> };
  /** clear the per-phase tick maxima reported by state() */
  resetStats(): void;
}

const HEAT_HALF_LIFE = 7;

/** Baked first, in this order (announcer and the busiest combat sounds). The rest bake on first use. */
const EAGER_SFX: readonly SfxId[] = [
  'countdown', 'go', 'hookThrow', 'hookHit', 'hookReturn', 'hookWall', 'melee', 'bash', 'death', 'corpse', 'splash', 'drown', 'bullseye',
  'hookClash', 'hookBounce', 'hookBreak', 'hookHitAlly', 'grappleThrow', 'grappleLatch', 'grappleLand', 'hurt', 'respawn', 'drownSave',
  'rune', 'runeSpawn', 'powerHook', 'mineArm', 'mineBoom', 'buy', 'pie', 'puff', 'iceCrack', 'victory', 'defeat', 'uiClick', 'uiHover', 'uiOpen', 'chat', 'deny', 'footstep',
];
const ANN_MAX_AGE = 2.5;

type Ctor = new (opts?: AudioContextOptions) => AudioContext;

export function createAudio(): AudioSystem {
  return createAudioExt();
}

export function createAudioExt(): AudioSystemExt {
  let ctx: AudioContext | null = null;
  let kit: Kit | null = null;
  let graph: MasterGraph | null = null;
  let voices: VoiceManager | null = null;
  let music: MusicPlayer | null = null;
  let amb: Ambience | null = null;
  let reverb: ReverbSwitch | null = null;
  let baker: Baker | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  // remembered intent (applies at unlock)
  const vol = { master: 0.8, sfx: 0.9, music: 0.55 };
  let wantMusic: MusicMood = 'none';
  let wantMap: MapDef | null = null;
  let wantRiver: RiverState | null = null;
  let lx = 0;
  let lz = 0;

  // adaptive state
  let heat = 0;
  let heatAt = 0;
  let intensityOverride: number | null = null;
  const annQueue: { id: AnnounceId; at: number }[] = [];
  let annFree = 0;
  let overtimeTense = false;
  const initMs: Record<string, number> = {};
  const tickMax = { voices: 0, music: 0, amb: 0, ann: 0 };
  const spoken: string[] = [];

  const debug: AudioDebug = {
    force: false,
    state: () => ({
      ctx: ctx?.state ?? 'none',
      time: ctx?.currentTime ?? 0,
      sampleRate: ctx?.sampleRate ?? 0,
      voices: voices?.count ?? 0,
      music: music?.current ?? wantMusic,
      ambience: amb?.mapId ?? null,
      reverb: reverb?.room ?? null,
      heat,
      queue: annQueue.map((q) => q.id),
      spoken: spoken.slice(),
      baked: baker ? { ready: baker.ready, queued: baker.queued, renders: baker.renders, failures: baker.failures, mb: +(baker.bytes / 1048576).toFixed(1), buildMs: Math.round(baker.buildMs), maxBuildMs: +baker.maxBuildMs.toFixed(1), slow: baker.slow.slice(0, 20) } : null,
      plays: voices ? { baked: voices.baked, live: voices.live } : null,
      volumes: { ...vol },
      initMs: { ...initMs },
      tickMax: { ...tickMax },
    }),
    selfTest: (opts) => runSelfTest(opts),
    benchMusic: () => benchMusic(),
    probeVoice: () => probeVoice(),
    resetStats: () => {
      tickMax.voices = tickMax.music = tickMax.amb = tickMax.ann = 0;
    },
  };

  const running = () => !!ctx && (ctx.state === 'running' || debug.force);

  function tick(): void {
    if (!ctx || !voices || !music || !amb || !reverb) return;
    const now = ctx.currentTime;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const look = hidden ? 1.5 : 0.3;
    try {
      const p0 = performance.now();
      voices.tick(now);
      reverb.tick(now);
      // heat decays with the audio clock, so frame bursts (debug advance) cannot inflate it
      if (now > heatAt) {
        heat *= Math.pow(0.5, (now - heatAt) / HEAT_HALF_LIFE);
        heatAt = now;
      }
      music.setIntensity(intensityOverride ?? Math.min(1, heat), now);
      const p1 = performance.now();
      music.tick(now, { lookahead: look });
      const p2 = performance.now();
      if (ctx.state === 'running' || debug.force) amb.tick(now, look);
      const p3 = performance.now();
      pumpAnnouncer(now);
      const p4 = performance.now();
      tickMax.voices = Math.max(tickMax.voices, p1 - p0);
      tickMax.music = Math.max(tickMax.music, p2 - p1);
      tickMax.amb = Math.max(tickMax.amb, p3 - p2);
      tickMax.ann = Math.max(tickMax.ann, p4 - p3);
    } catch (err) {
      console.warn('[audio] tick', err);
    }
  }

  function pumpAnnouncer(now: number): void {
    // drop stale callouts: flavour goes quickly, the big ones wait their turn
    for (let k = annQueue.length - 1; k >= 0; k--) {
      const q = annQueue[k];
      const p = ANNOUNCE[q.id].prio;
      if (now - q.at > (p >= 2 ? ANN_MAX_AGE * 2 : p === 1 ? ANN_MAX_AGE : ANN_MAX_AGE * 0.6)) annQueue.splice(k, 1);
    }
    if (!annQueue.length || now < annFree) return;
    // most important first; ties keep arrival order
    let best = 0;
    for (let k = 1; k < annQueue.length; k++) if (ANNOUNCE[annQueue[k].id].prio > ANNOUNCE[annQueue[best].id].prio) best = k;
    const q = annQueue.splice(best, 1)[0];
    speakNow(q.id, now);
  }

  function enqueue(id: AnnounceId, now: number): void {
    if (annQueue.some((q) => q.id === id)) return; // coalesce repeats (bullseye spam)
    annQueue.push({ id, at: now });
    if (annQueue.length > 3) {
      // drop the least important (oldest among equals)
      let worst = 0;
      for (let k = 1; k < annQueue.length; k++) if (ANNOUNCE[annQueue[k].id].prio < ANNOUNCE[annQueue[worst].id].prio) worst = k;
      annQueue.splice(worst, 1);
    }
  }

  function speakNow(id: AnnounceId, now: number): void {
    if (!ctx || !kit || !graph) return;
    const def = ANNOUNCE[id];
    if (!def) return;
    spoken.push(id);
    if (spoken.length > 12) spoken.shift();
    const out = ctx.createGain();
    out.gain.value = def.v;
    out.connect(graph.voxBus);
    const s = new Snd(kit, out, graph.voxSend, now + 0.01, 1, { mapId: wantMap?.id ?? null });
    const buf = baker?.get(`ann:${id}`) ?? null;
    try {
      if (buf) {
        // baked dry: one uniform send into the room reverb replaces the per-layer sends
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(out);
        s.send(out, 0.3);
        src.start(s.t);
        s.track(src, s.t + buf.duration);
      } else {
        def.fn(s);
        requestAnnBake(id, true);
      }
    } catch (err) {
      console.warn('[audio] announce failed', id, err);
    }
    const end = s.end + 0.2;
    setTimeout(() => {
      try {
        out.disconnect();
      } catch {
        // ok
      }
    }, Math.max(0, (end - now) * 1000 + 600));
    annFree = now + def.dur;
    // duck music and ambience under the callout
    const md = graph.musicDuck.gain;
    md.cancelScheduledValues(now);
    md.setTargetAtTime(1 - def.duck * 0.55, now, 0.03);
    md.setTargetAtTime(1, now + def.dur * 0.85, 0.45);
    const ad = graph.ambDuck.gain;
    ad.cancelScheduledValues(now);
    ad.setTargetAtTime(1 - def.duck * 0.35, now, 0.05);
    ad.setTargetAtTime(1, now + def.dur, 0.6);
  }

  function requestAnnBake(id: AnnounceId, urgent = false): void {
    if (!baker) return;
    const def = ANNOUNCE[id];
    baker.request({ key: `ann:${id}`, takes: 1, channels: 1, maxDur: def.dur + 1.6, render: (s) => def.fn(s) }, urgent);
  }

  function requestSfxBake(id: SfxId, env: SndEnv): void {
    baker?.request(sfxBakeJob(id, env));
  }

  function applyAmbience(now: number): void {
    if (!amb || !reverb || !voices) return;
    const prevMap = amb.mapId;
    amb.set(wantMap, wantRiver, now);
    const id = wantMap?.id ?? null;
    if (id !== prevMap || !reverb.room) reverb.set(id ?? 'menu', now);
    voices.env = { mapId: id, special: wantMap?.special ?? null };
    if (wantMap) {
      requestSfxBake('tideHorn', voices.env);
      requestSfxBake('hazardBurst', voices.env);
    }
  }

  const sys: AudioSystemExt = {
    debug,

    unlock() {
      if (disposed) return;
      if (ctx) {
        if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') void ctx.resume().catch(() => undefined);
        return;
      }
      try {
        const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
        const AC = w.AudioContext ?? w.webkitAudioContext;
        if (!AC) return;
        ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        ctx = null;
        return;
      }
      try {
        const pt = performance.now();
        kit = makeKit(ctx, (Math.random() * 0xffffffff) >>> 0);
        initMs.kit = performance.now() - pt;
        graph = buildMaster(ctx, kit);
        reverb = new ReverbSwitch(ctx, graph.reverbIn, graph.revReturn);
        voices = new VoiceManager(kit, graph.sfxBus, graph.sfxSend);
        initMs.graph = performance.now() - pt - initMs.kit;
        if (typeof OfflineAudioContext !== 'undefined') {
          baker = new Baker(kit);
          // let the lazy noise and textures warm up before the first bakes need them
          voices.baker = baker;
          for (const id of ANNOUNCE_IDS) requestAnnBake(id);
          for (const id of EAGER_SFX) requestSfxBake(id, {});
        }
        voices.lx = lx;
        voices.lz = lz;
        music = new MusicPlayer(kit, graph.musicBus, graph.musicSend);
        amb = new Ambience(kit, graph.ambBus, graph.ambSend);
        const now = ctx.currentTime;
        heatAt = now;
        applyVolumes(graph, now, vol.master, vol.sfx, vol.music);
        // the reverb IR and ambience loops cost a few ms each: build them after the gesture handler
        const k = kit;
        setTimeout(() => {
          if (!ctx || disposed) return;
          const pa = performance.now();
          applyAmbience(ctx.currentTime);
          initMs.ambience = performance.now() - pa;
          warmKit(k);
        }, 20);
        music.setMood(wantMusic, now);
        timer = setInterval(tick, 40);
        initMs.total = performance.now() - pt;
        if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
      } catch (err) {
        console.warn('[audio] init failed', err);
        try {
          void ctx.close();
        } catch {
          // ok
        }
        ctx = null;
        kit = null;
        graph = null;
      }
    },

    play(id: SfxId, o?: PlayOpts) {
      if (!running() || !voices || !ctx) return;
      try {
        const r = voices.play(id, o, ctx.currentTime);
        if (r.played && r.heat > 0) heat = Math.min(1.6, heat + r.heat);
      } catch (err) {
        console.warn('[audio] play', id, err);
      }
    },

    announce(key: AnnounceKey | 'countdown3' | 'countdown2' | 'countdown1' | 'go') {
      if (!running() || !ctx) return;
      const now = ctx.currentTime;
      try {
        if (key === 'countdown3' || key === 'countdown2' || key === 'countdown1' || key === 'go') {
          // countdown is time critical: never queued
          speakNow(key, now);
          annFree = Math.min(annFree, now + 0.55);
          return;
        }
        if (key === 'overtime' && (wantMusic === 'match' || music?.current === 'match')) {
          overtimeTense = true;
          wantMusic = 'tense';
          music?.setMood('tense', now);
        }
        enqueue(key, now);
        pumpAnnouncer(now);
      } catch (err) {
        console.warn('[audio] announce', key, err);
      }
    },

    setListener(x: number, z: number) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      lx = x;
      lz = z;
      if (voices) {
        voices.lx = x;
        voices.lz = z;
      }
    },

    setAmbience(map: MapDef | null, river: RiverState | null) {
      const changed = (map?.id ?? null) !== (wantMap?.id ?? null);
      wantMap = map;
      wantRiver = river;
      if (!ctx) return;
      try {
        if (changed) {
          heat = 0;
          overtimeTense = false;
        }
        applyAmbience(ctx.currentTime);
      } catch (err) {
        console.warn('[audio] ambience', err);
      }
    },

    setMusic(mood: MusicMood) {
      // the overtime switch keeps the tense cue while the glue still asks for 'match'
      if (mood === 'match' && overtimeTense) mood = 'tense';
      if (mood !== 'match' && mood !== 'tense') overtimeTense = false;
      wantMusic = mood;
      if (!ctx || !music) return;
      try {
        music.setMood(mood, ctx.currentTime);
        if (mood === 'menu' || mood === 'victory' || mood === 'defeat') heat = 0;
      } catch (err) {
        console.warn('[audio] music', err);
      }
    },

    setVolumes(master: number, sfx: number, mus: number) {
      vol.master = master;
      vol.sfx = sfx;
      vol.music = mus;
      if (ctx && graph) applyVolumes(graph, ctx.currentTime, master, sfx, mus);
    },

    setIntensity(v: number | null) {
      intensityOverride = v === null || !Number.isFinite(v) ? null : Math.max(0, Math.min(1, v));
    },

    update(_dt: number) {
      // the interval timer keeps time on menus (no frames call update there); frames add precision
      tick();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      baker?.stop();
      baker = null;
      try {
        const now = ctx?.currentTime ?? 0;
        voices?.stopAll(now);
        music?.dispose();
        amb?.dispose(now);
      } catch {
        // ok
      }
      const c = ctx;
      ctx = null;
      voices = null;
      music = null;
      amb = null;
      graph = null;
      kit = null;
      reverb = null;
      if (c) void c.close().catch(() => undefined);
    },
  };
  return sys;
}
