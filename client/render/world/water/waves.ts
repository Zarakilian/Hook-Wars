// Gerstner wave set travelling along the river flow. The same numbers drive the vertex shader
// and the CPU height query, so floating things sit on the waves they look like they sit on.
import * as THREE from 'three';
import type { MapDef } from '../../../../shared/maps/types.ts';
import { Rng } from '../../../../shared/math.ts';
import type { WaterStyle } from './style.ts';

export const MAX_WAVES = 6;

export interface WaveSet {
  n: number;
  dirX: Float32Array;
  dirZ: Float32Array;
  amp: Float32Array;
  k: Float32Array;
  /** angular phase speed (rad/s) at base flow */
  omega: Float32Array;
  q: Float32Array;
  phase: Float32Array;
  /** shader uniforms: A = (dirX, dirZ, amp, k), B = (phase, Q, 0, 0) */
  uA: THREE.Vector4[];
  uB: THREE.Vector4[];
}

export function makeWaves(map: MapDef, style: WaterStyle, count: number): WaveSet {
  const n = Math.max(1, Math.min(MAX_WAVES, count));
  const rng = new Rng(map.id.charCodeAt(0) * 977 + map.id.length * 31);
  const flowSign = map.river.flow < 0 ? -1 : 1;
  const flow = Math.abs(map.river.flow);
  // hand-tuned spectrum: two long swells, then shorter chop, all leaning along the flow
  const lens = [5.6, 4.1, 2.9, 2.2, 1.6, 1.25];
  const amps = [0.095, 0.075, 0.06, 0.05, 0.042, 0.04];
  const angs = [0.12, -0.38, 0.55, -0.7, 0.95, -1.15];
  const w: WaveSet = {
    n,
    dirX: new Float32Array(n),
    dirZ: new Float32Array(n),
    amp: new Float32Array(n),
    k: new Float32Array(n),
    omega: new Float32Array(n),
    q: new Float32Array(n),
    phase: new Float32Array(n),
    uA: [],
    uB: [],
  };
  for (let i = 0; i < n; i++) {
    const a = angs[i] + rng.range(-0.12, 0.12);
    const L = lens[i] * style.waveLen * rng.range(0.9, 1.1);
    const k = (Math.PI * 2) / L;
    w.dirX[i] = Math.sin(a);
    w.dirZ[i] = Math.cos(a) * flowSign;
    w.amp[i] = amps[i] * style.waveAmp * rng.range(0.85, 1.15);
    w.k[i] = k;
    // stylised dispersion (slower than deep water so it reads as a lazy river) plus the current
    const c = 0.32 * Math.sqrt(9.81 / k) + flow * 0.9;
    w.omega[i] = c * k;
    w.q[i] = 0.55 / (k * w.amp[i] * n + 1e-6) * 0.6;
    w.q[i] = Math.min(w.q[i], 1.2);
    w.phase[i] = rng.range(0, Math.PI * 2);
  }
  for (let i = 0; i < MAX_WAVES; i++) {
    w.uA.push(new THREE.Vector4(0, 1, 0, 1));
    w.uB.push(new THREE.Vector4(0, 0, 0, 0));
  }
  syncWaveUniforms(w);
  return w;
}

export function advanceWaves(w: WaveSet, dt: number, speedMul: number): void {
  const TAU = Math.PI * 2;
  for (let i = 0; i < w.n; i++) {
    w.phase[i] = (w.phase[i] + w.omega[i] * speedMul * dt) % (TAU * 64);
  }
  syncWaveUniforms(w);
}

function syncWaveUniforms(w: WaveSet): void {
  for (let i = 0; i < w.n; i++) {
    w.uA[i].set(w.dirX[i], w.dirZ[i], w.amp[i], w.k[i]);
    w.uB[i].set(w.phase[i], w.q[i], 0, 0);
  }
}

/** Approximate surface offset at x,z (ignores the small horizontal Gerstner shift). */
export function waveHeight(w: WaveSet, x: number, z: number, ampMul: number): number {
  let h = 0;
  for (let i = 0; i < w.n; i++) {
    h += w.amp[i] * Math.sin(w.k[i] * (w.dirX[i] * x + w.dirZ[i] * z) - w.phase[i]);
  }
  return h * ampMul;
}
