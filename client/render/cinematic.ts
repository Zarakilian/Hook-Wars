// Cinematic mode: the opt-in look on top of the ultra tier (the Steam build's "Epic" graphics setting;
// the browser never offers it). This module owns the on/off state and the per-effect switches.
//
// For now it turns on with the URL parameter ?cinematic, or at runtime with
// hw.app.engine.setCinematic(true) under ?debug. While it is on the engine renders the ultra tier and
// adds: lantern point lights, height mist with light shafts, a tilt-shift depth of field, a depth rim
// light, a teal-and-orange grade with a stronger bloom, and the voxel bevel shader on adopted materials.
// While it is off nothing here runs: every normal tier renders exactly as before.

/** Every cinematic effect is individually switchable and scalable (for profiling and weaker GPUs). */
export interface CinematicConfig {
  /** warm PointLights at the nearest lanterns to the camera focus */
  lights: boolean;
  /** how many lantern lights at once (the program light count; changing it recompiles) */
  lightBudget: number;
  /** low height mist (analytic, full resolution, very cheap) */
  mist: boolean;
  /** sun / moon light shafts through the mist: a low-resolution raymarch through the sun shadow map */
  shafts: boolean;
  /** raymarch steps through the mist slab */
  shaftSteps: number;
  /** raymarch resolution as a fraction of the drawing buffer (0.25 = quarter) */
  shaftScale: number;
  /** lantern glow in the mist (closed-form in-scatter per lantern light) */
  lanternGlow: boolean;
  /** tilt-shift depth of field (miniature look) */
  dof: boolean;
  /** blur radius at the top and bottom of the frame, in pixels at 1080p */
  dofRadius: number;
  /** screen-space rim / back light on silhouettes (Lunkers pop off the ground) */
  rim: boolean;
  /** teal shadows, warm highlights, deeper contrast */
  grade: boolean;
  /** stronger, wider bloom for lanterns */
  bloom: boolean;
  /** voxel bevel / seam / glint shader on materials that adopted it (applyVoxelLook) */
  voxelLook: boolean;
}

export const DEFAULT_CINEMATIC: Readonly<CinematicConfig> = Object.freeze({
  lights: true,
  lightBudget: 10,
  mist: true,
  shafts: true,
  shaftSteps: 20,
  shaftScale: 0.5,
  lanternGlow: true,
  dof: true,
  dofRadius: 6,
  rim: true,
  grade: true,
  bloom: true,
  voxelLook: true,
});

type Listener = (on: boolean, config: Readonly<CinematicConfig>) => void;

function readInitial(): boolean {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('cinematic');
  } catch {
    return false;
  }
}

let enabled = readInitial();
let config: CinematicConfig = { ...DEFAULT_CINEMATIC };
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l(enabled, config);
    } catch (err) {
      console.error('[cinematic]', err);
    }
  }
}

/** True while cinematic mode is on. */
export function cinematicEnabled(): boolean {
  return enabled;
}

/** Turn cinematic mode on or off. The engine switches to (or back from) the ultra tier. */
export function setCinematic(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  notify();
}

/** The current effect switches (a copy is not made: treat as read-only). */
export function cinematicConfig(): Readonly<CinematicConfig> {
  return config;
}

/** Change effect switches, e.g. setCinematicConfig({ dof: false }) to profile without the depth of field. */
export function setCinematicConfig(patch: Partial<CinematicConfig>): void {
  config = { ...config, ...patch };
  config.lightBudget = Math.max(0, Math.min(16, Math.round(config.lightBudget)));
  config.shaftSteps = Math.max(4, Math.min(48, Math.round(config.shaftSteps)));
  config.shaftScale = Math.max(0.125, Math.min(1, config.shaftScale));
  config.dofRadius = Math.max(0, Math.min(16, config.dofRadius));
  if (enabled) notify();
}

/** Called on every change of the state or (while on) of the config. Returns an unsubscribe function. */
export function onCinematicChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
