// Epic level of detail for in-match Lunkers: the showcase (fine, res 2) geometry once the camera is close
// enough for it to show, the game geometry otherwise. Built only for units created while cinematic mode
// is on (pudgy.ts): the normal tiers never construct one.
//
// Why a level of detail and not "always showcase": at the gameplay camera (34 m x zoom 0.7..1.8, 45 deg
// fov) a game voxel is 1.4 px at 1080p (up to 3.4 px at the closest zoom), so a showcase voxel is 0.7..1.7 px.
// Sub-pixel cubes add nothing the eye can resolve; they shimmer, overshade 2x2 pixel quads and quadruple
// the triangles (17k to 29k per Lunker at game detail, 68k to 122k at showcase), and building them costs
// 150 to 300 ms per character. So the swap happens per unit, from the projected size of one of its game
// voxels on the drawing buffer, measured where it is drawn (onBeforeRender of its body part):
//   >= LOD_PX.build  start building the showcase parts (one part per frame across all units, cached and
//                    shared with every unit that wears the same pieces),
//   >= LOD_PX.in     draw the showcase geometry (once every part is built): showcase cubes of 2.7 px or more,
//   <  LOD_PX.out    back to the game geometry (hysteresis, so a zooming camera does not flicker).
// A part build is one blocking task (the body is 50 to 150 ms on a laptop CPU), so it must never start
// mid-fight: at 1080p and 1440p the gameplay camera never reaches LOD_PX.build (up to 3.4 and 4.5 px at
// the closest zoom), and on a drawing buffer tall enough for the closest zoom to reach it (PREBUILD_H, about
// 4K) every unit builds its showcase parts from its first frames, during the match countdown. Close-up
// cameras (podium shots, debug close-ups) build when they get close.
import * as THREE from 'three';
import { cinematicEnabled } from '../../cinematic.ts';
import { acquireGeo, hasGeo, releaseGeo } from './cache.ts';
import { VOX } from './grid.ts';
import { setPudgyVoxelRes } from './material.ts';
import type { FamilyBuild, PartName } from './types.ts';

/** projected size of one game voxel, in drawing-buffer pixels, that builds / shows / drops the showcase detail */
export const LOD_PX = { build: 5.0, in: 5.4, out: 4.8 };

/**
 * Projected game-voxel size of the nearest units at the gameplay camera's closest zoom on a 1080 px tall
 * drawing buffer (game/camera.ts: 34 m x 0.7, pitch 0.95, fov 45): up to 3.4 px measured on the units
 * nearest the bottom of the screen at a 5v5 match start (4.5 px at 1440p); 3.5 keeps a margin.
 */
const CLOSEST_GAMEPLAY_PX_1080 = 3.5;

/** drawing-buffer height (px) from which the closest gameplay zoom reaches LOD_PX.build: prebuild at match start */
export const PREBUILD_H = Math.ceil((LOD_PX.build / CLOSEST_GAMEPLAY_PX_1080) * 1080);

/** height of the drawing buffer the units were last drawn to (onBeforeRender) */
let bufferH = 0;

/** at most one uncached part build per this many milliseconds, across every unit (spreads the cost) */
const BUILD_GAP_MS = 12;
let lastBuild = -1e9;

const _p = new THREE.Vector3();

export class DetailLod {
  /** detail drawn now: 1 = game, 2 = showcase */
  res = 1;
  /** debug: force a projected size (px) instead of measuring, null = measure */
  forcePx: number | null = null;
  /** largest projected game-voxel size seen since the last update (px) */
  private px = 0;
  /** the last measured size, for debugging */
  lastPx = 0;
  private fine: FamilyBuild | null = null;
  private readonly gameGeo: THREE.BufferGeometry[];
  private readonly fineGeo: (THREE.BufferGeometry | null)[] = [];
  private readonly keys: string[] = [];
  private next = 0;
  private ready = false;
  private disposed = false;
  private readonly probe: THREE.Mesh | null;
  private readonly meshes: readonly THREE.Mesh[];
  /** rig scale (metres of one skeleton unit = VOX * scale) */
  private readonly scale: number;
  private readonly makeFine: () => FamilyBuild;
  private readonly material: THREE.MeshStandardMaterial;
  /** the stealth depth twins (children of each part, same order as meshes), if any were made */
  private readonly twins: () => readonly THREE.Mesh[] | null;

  constructor(
    meshes: readonly THREE.Mesh[],
    scale: number,
    makeFine: () => FamilyBuild,
    material: THREE.MeshStandardMaterial,
    twins: () => readonly THREE.Mesh[] | null,
  ) {
    this.meshes = meshes;
    this.scale = scale;
    this.makeFine = makeFine;
    this.material = material;
    this.twins = twins;
    this.gameGeo = meshes.map((m) => m.geometry);
    const probe = meshes.find((m) => m.name === 'body') ?? meshes[0] ?? null;
    this.probe = probe;
    if (probe) {
      probe.onBeforeRender = (renderer, _scene, camera) => {
        const cam = camera as THREE.PerspectiveCamera;
        if (!cam.isPerspectiveCamera) return;
        _p.setFromMatrixPosition(probe.matrixWorld).applyMatrix4(cam.matrixWorldInverse);
        const depth = -_p.z;
        if (depth < 0.05) return;
        const h = renderer.domElement.height;
        bufferH = h;
        const px = (VOX * this.scale * h * cam.zoom) / (2 * Math.tan((cam.fov * Math.PI) / 360) * depth);
        if (px > this.px) this.px = px;
      };
    }
  }

  /** Once per frame (before rendering): pick the detail from the size measured in the last frame. */
  update(): void {
    if (this.disposed) return;
    // cinematic turned off mid-match: back to the game geometry (the normal tiers never draw showcase parts)
    if (!cinematicEnabled()) {
      if (this.res !== 1) this.apply(1);
      this.px = 0;
      return;
    }
    const px = this.forcePx ?? this.px;
    this.lastPx = px;
    this.px = 0;
    const want = this.res === 2 ? px >= LOD_PX.out : px >= LOD_PX.in;
    if (!this.ready && (want || px >= LOD_PX.build || bufferH >= PREBUILD_H)) this.build();
    if (want && this.ready) {
      if (this.res !== 2) this.apply(2);
    } else if (this.res !== 1) this.apply(1);
  }

  /** Build the next showcase part (cached parts are free; at most one uncached build per gap). */
  private build(): void {
    const now = performance.now();
    if (now - lastBuild < BUILD_GAP_MS && now >= lastBuild) return;
    if (!this.fine) this.fine = this.makeFine();
    const parts = this.fine.parts;
    while (this.next < this.meshes.length) {
      const i = this.next++;
      const def = parts[this.meshes[i].name as PartName];
      if (!def) {
        this.fineGeo[i] = null;
        continue;
      }
      const cached = hasGeo(def.key);
      this.fineGeo[i] = acquireGeo(def);
      this.keys.push(def.key);
      if (!cached) {
        lastBuild = performance.now();
        break;
      }
    }
    if (this.next >= this.meshes.length) this.ready = true;
  }

  private apply(res: 1 | 2): void {
    const twins = this.twins();
    for (let i = 0; i < this.meshes.length; i++) {
      const g = res === 2 ? this.fineGeo[i] ?? this.gameGeo[i] : this.gameGeo[i];
      this.meshes[i].geometry = g;
      if (twins && twins[i]) twins[i].geometry = g;
    }
    setPudgyVoxelRes(this.material, res);
    this.res = res;
  }

  /** triangles drawn by this unit's parts at its current detail (debug) */
  triangles(): number {
    let t = 0;
    for (const m of this.meshes) t += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
    return Math.round(t);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.probe) this.probe.onBeforeRender = () => {};
    for (const k of this.keys) releaseGeo(k);
    this.keys.length = 0;
  }
}
