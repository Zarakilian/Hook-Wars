// Backdrop mode only: while the stage is the menu backdrop it sets the engine's own sky, moon / sun,
// hemisphere fill, fog and environment to the theme's, and puts the engine's values back when it stops.
//
// The menu backdrop is built by the engine with only the sky uniforms, so the lights are found in the
// scene (the sun is named 'HW.Sun'; the hemisphere light is the scene's only HemisphereLight). The engine
// re-applies its own atmosphere in setAtmosphere() (every match start and every return to the menu) and
// parts of it in setQuality() and on a cinematic toggle. Each group of values (sky, sun, fill, fog,
// environment) is tracked on its own: when a group no longer matches what this module last wrote, the
// engine has written it, so its current values become that group's snapshot before the theme is written
// on top. restore() writes a snapshot back only where the value is still ours.
import * as THREE from 'three';
import type { SkyLook } from '../engine/atmosphere.ts';
import { applySkyLook, type SkyUniforms } from '../engine/sky.ts';

export interface HostLookValues {
  sky: SkyLook;
  sunColor: THREE.Color;
  sunIntensity: number;
  /** direction to the sun / moon (the light is placed at dir * 60 around the stage origin) */
  sunDir: THREE.Vector3;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fogColor: THREE.Color;
  fogDensity: number;
  environment: THREE.Texture | null;
  envIntensity: number;
}

/** One overridden group: read the host's values, write ours, compare. */
interface Group<S> {
  read(): S;
  write(s: S): void;
  same(a: S, b: S): boolean;
  snap: S | null;
  wrote: S | null;
}

function group<S>(read: () => S, write: (s: S) => void, same: (a: S, b: S) => boolean): Group<S> {
  return { read, write, same, snap: null, wrote: null };
}

function applyGroup<S>(g: Group<S>, ours: S): void {
  const cur = g.read();
  if (!g.wrote || !g.same(cur, g.wrote)) g.snap = cur;
  g.write(ours);
  g.wrote = g.read();
}

function restoreGroup<S>(g: Group<S>): void {
  if (g.snap && g.wrote && g.same(g.read(), g.wrote)) g.write(g.snap);
  g.snap = null;
  g.wrote = null;
}

type SkyVals = Record<string, unknown>;

function cloneValue(v: unknown): unknown {
  return v && typeof (v as { clone?: () => unknown }).clone === 'function' ? (v as { clone: () => unknown }).clone() : v;
}
function eqValue(a: unknown, b: unknown): boolean {
  if (a && typeof (a as { equals?: (o: unknown) => boolean }).equals === 'function') return (a as { equals: (o: unknown) => boolean }).equals(b);
  return a === b;
}

export class HostLook {
  private readonly scene: THREE.Scene;
  private readonly sky: SkyUniforms | null;
  private sun: THREE.DirectionalLight | null = null;
  private hemi: THREE.HemisphereLight | null = null;
  private readonly groups: Group<unknown>[] = [];
  private readonly gSky: Group<SkyVals>;
  private readonly gSun: Group<{ c: THREE.Color; i: number; p: THREE.Vector3 }>;
  private readonly gHemi: Group<{ s: THREE.Color; g: THREE.Color; i: number }>;
  private readonly gFog: Group<{ c: THREE.Color; d: number }>;
  private readonly gEnv: Group<{ t: THREE.Texture | null; i: number }>;

  constructor(scene: THREE.Scene, sky: SkyUniforms | null) {
    this.scene = scene;
    this.sky = sky;
    this.find();
    const sk = sky;
    this.gSky = group<SkyVals>(
      () => {
        const o: SkyVals = {};
        if (sk) for (const [k, u] of Object.entries(sk)) if (k !== 'uSkyTime') o[k] = cloneValue(u.value);
        return o;
      },
      (s) => {
        if (!sk) return;
        for (const [k, v] of Object.entries(s)) {
          const u = sk[k];
          if (!u) continue;
          const cur = u.value as { copy?: (o: unknown) => unknown };
          if (cur && typeof cur.copy === 'function' && v && typeof v === 'object') cur.copy(v);
          else u.value = v;
        }
      },
      (a, b) => Object.keys(a).every((k) => eqValue(a[k], b[k])),
    );
    this.gSun = group(
      () => ({ c: this.sun ? this.sun.color.clone() : new THREE.Color(), i: this.sun ? this.sun.intensity : 0, p: this.sun ? this.sun.position.clone() : new THREE.Vector3() }),
      (s) => {
        if (!this.sun) return;
        this.sun.color.copy(s.c);
        this.sun.intensity = s.i;
        this.sun.position.copy(s.p);
        this.sun.updateMatrixWorld();
      },
      (a, b) => a.c.equals(b.c) && a.i === b.i && a.p.equals(b.p),
    );
    this.gHemi = group(
      () => ({ s: this.hemi ? this.hemi.color.clone() : new THREE.Color(), g: this.hemi ? this.hemi.groundColor.clone() : new THREE.Color(), i: this.hemi ? this.hemi.intensity : 0 }),
      (s) => {
        if (!this.hemi) return;
        this.hemi.color.copy(s.s);
        this.hemi.groundColor.copy(s.g);
        this.hemi.intensity = s.i;
      },
      (a, b) => a.s.equals(b.s) && a.g.equals(b.g) && a.i === b.i,
    );
    this.gFog = group(
      () => {
        const f = this.fog();
        return { c: f ? f.color.clone() : new THREE.Color(), d: f ? f.density : 0 };
      },
      (s) => {
        const f = this.fog();
        if (!f) return;
        f.color.copy(s.c);
        f.density = s.d;
      },
      (a, b) => a.c.equals(b.c) && a.d === b.d,
    );
    this.gEnv = group(
      () => ({ t: this.scene.environment, i: this.scene.environmentIntensity }),
      (s) => {
        this.scene.environment = s.t;
        this.scene.environmentIntensity = s.i;
      },
      (a, b) => a.t === b.t && a.i === b.i,
    );
    this.groups.push(this.gSky as Group<unknown>, this.gSun as Group<unknown>, this.gHemi as Group<unknown>, this.gFog as Group<unknown>, this.gEnv as Group<unknown>);
  }

  private find(): void {
    const s = this.scene.getObjectByName('HW.Sun') as THREE.DirectionalLight | undefined;
    this.sun = s && s.isDirectionalLight ? s : null;
    this.hemi = (this.scene.children.find((o) => (o as THREE.HemisphereLight).isHemisphereLight) as THREE.HemisphereLight | undefined) ?? null;
  }

  private fog(): THREE.FogExp2 | null {
    const f = this.scene.fog as THREE.FogExp2 | null;
    return f && (f as THREE.FogExp2).isFogExp2 ? f : null;
  }

  private readonly skyVals: SkyVals = {};

  /** Write the theme's look over the engine's (call every frame while the stage is the backdrop). */
  apply(v: HostLookValues, origin: THREE.Vector3): void {
    if (!this.sun || !this.hemi) this.find();
    if (this.sky) {
      // the theme's sky as uniform values (applySkyLook into a scratch copy, then compared and written)
      const scratch = this.gSky.read();
      const u: Record<string, { value: unknown }> = {};
      for (const [k, val] of Object.entries(scratch)) u[k] = { value: val };
      applySkyLook(u as unknown as SkyUniforms, v.sky);
      for (const [k, val] of Object.entries(u)) this.skyVals[k] = val.value;
      applyGroup(this.gSky, this.skyVals);
    }
    if (this.sun) {
      applyGroup(this.gSun, { c: v.sunColor, i: v.sunIntensity, p: v.sunDir.clone().multiplyScalar(60).add(origin) });
      this.sun.target.position.copy(origin);
      this.sun.target.updateMatrixWorld();
    }
    if (this.hemi) applyGroup(this.gHemi, { s: v.hemiSky, g: v.hemiGround, i: v.hemiIntensity });
    if (this.fog()) applyGroup(this.gFog, { c: v.fogColor, d: v.fogDensity });
    applyGroup(this.gEnv, { t: v.environment ?? this.scene.environment, i: v.envIntensity });
  }

  /** Put the engine's values back (cinematic turned off while the menu shows, or the stage is disposed). */
  restore(): void {
    for (const g of this.groups) restoreGroup(g);
    if (this.sun) {
      this.sun.target.position.set(0, 0, 0);
      this.sun.target.updateMatrixWorld();
    }
  }
}

/**
 * Preview mode: the stage's environment on a host scene that had its own (the Locker turntable's room
 * environment). The host's environment and intensity are saved the first time and written back when
 * the stage lets go, but only while the scene still holds the stage's environment.
 */
export class EnvSwap {
  private readonly scene: THREE.Scene;
  private saved: { t: THREE.Texture | null; i: number } | null = null;
  private ours: THREE.Texture | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  set(env: THREE.Texture, intensity: number): void {
    if (!this.saved || (this.scene.environment !== this.ours && this.scene.environment !== env)) this.saved = { t: this.scene.environment, i: this.scene.environmentIntensity };
    this.scene.environment = env;
    this.scene.environmentIntensity = intensity;
    this.ours = env;
  }

  /** Put the host's environment back if the scene still shows `env` (the one about to be disposed). */
  release(env: THREE.Texture | null): void {
    if (!env || this.scene.environment !== env || !this.saved) return;
    this.scene.environment = this.saved.t;
    this.scene.environmentIntensity = this.saved.i;
    this.ours = null;
  }
}
