// Backdrop water outside the playable rectangle: the river beyond the map ends, the sea, swamp pools,
// the harbour basin and the fjord lake. Its level follows the match river level, so tides drain the
// sea too. The water inside the play rectangle belongs to the water module.
import * as THREE from 'three';
import { WATER_LAYER } from '../../contracts.ts';
import { backdropWaterMaterial, waterUniforms, type WaterUniforms } from './material.ts';

export interface BackwaterOpts {
  /** area to cover */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** hole: the play rectangle |x| < hx, |z| < hz is left to the water module */
  hx: number;
  hz: number;
  /** extra hole (e.g. the water module's river grid beyond the map ends) */
  hole?: (x: number, z: number) => boolean;
  cell: number;
  /** highest level the water will ever reach (quads entirely above this are skipped) */
  maxLevel: number;
  ground: (x: number, z: number) => number;
  colors: { shallow: number; deep: number; foam: number };
  /** optional extra mask: return false to drop a quad (e.g. cut the upper waterfall pool) */
  keep?: (x: number, z: number) => boolean;
}

export interface Backwater {
  mesh: THREE.Mesh | null;
  u: WaterUniforms;
  dispose(): void;
}

export function buildBackwater(o: BackwaterOpts): Backwater {
  const u = waterUniforms(o.colors.shallow, o.colors.deep, o.colors.foam);
  const pos: number[] = [];
  const bed: number[] = [];
  const idx: number[] = [];
  const vmap = new Map<number, number>();
  const nx = Math.round((o.x1 - o.x0) / o.cell);
  const nz = Math.round((o.z1 - o.z0) / o.cell);
  const vert = (i: number, j: number): number => {
    const key = i + j * (nx + 1);
    let v = vmap.get(key);
    if (v === undefined) {
      const x = o.x0 + i * o.cell;
      const z = o.z0 + j * o.cell;
      v = pos.length / 3;
      pos.push(x, 0, z);
      bed.push(o.ground(x, z));
      vmap.set(key, v);
    }
    return v;
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const xa = o.x0 + i * o.cell;
      const za = o.z0 + j * o.cell;
      const cx = xa + o.cell / 2;
      const cz = za + o.cell / 2;
      if (Math.abs(cx) < o.hx && Math.abs(cz) < o.hz) continue;
      if (o.hole && o.hole(cx, cz)) continue;
      if (o.keep && !o.keep(cx, cz)) continue;
      const g = Math.min(o.ground(xa, za), o.ground(xa + o.cell, za), o.ground(xa, za + o.cell), o.ground(xa + o.cell, za + o.cell), o.ground(cx, cz));
      if (g > o.maxLevel + 0.05) continue;
      const a = vert(i, j);
      const b = vert(i + 1, j);
      const c = vert(i + 1, j + 1);
      const d = vert(i, j + 1);
      idx.push(a, d, c, a, c, b);
    }
  }
  if (idx.length === 0) return { mesh: null, u, dispose() {} };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aBed', new THREE.Float32BufferAttribute(bed, 1));
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  // bounds: the shader moves vertices to the water level, so cover the full vertical range
  geo.computeBoundingBox();
  geo.boundingBox!.min.y = -20;
  geo.boundingBox!.max.y = o.maxLevel + 1;
  geo.boundingSphere = geo.boundingBox!.getBoundingSphere(new THREE.Sphere());
  const mat = backdropWaterMaterial(u);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.layers.set(WATER_LAYER);
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  mesh.name = 'backdrop-water';
  return {
    mesh,
    u,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
