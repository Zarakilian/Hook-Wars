// Helpers shared by the three family builders.
import type * as THREE from 'three';
import { CH, hashVox, meshPart, mix, RGrid, shade, type ColorFn } from './grid.ts';
import type { PartDef, V3 } from './types.ts';

/** Copy of a grid mirrored across the skeleton x = 0 plane (left part -> right part). */
export function mirrorGrid(g: RGrid): RGrid {
  const m = new RGrid(g.nx, g.ny, g.nz, -(g.ox + g.nx), g.oy, g.oz);
  for (let z = 0; z < g.nz; z++)
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < g.nx; x++) m.data[m.index(g.nx - 1 - x, y, z)] = g.data[g.index(x, y, z)];
  return m;
}

export function mirrorV(v: V3): V3 {
  return [-v[0], v[1], v[2]];
}

/** Mirror a cell x coordinate. */
export function mx(x: number): number {
  return -1 - x;
}

export function part(key: string, build: () => RGrid, joint: V3, ao = 0.52): PartDef {
  return { key, build: () => meshPart(build(), joint, ao) };
}

export function partMirrored(key: string, build: () => RGrid, joint: V3, ao = 0.52): PartDef {
  return { key, build: () => meshPart(mirrorGrid(build()), mirrorV(joint), ao) };
}

export function partFn(key: string, fn: () => THREE.BufferGeometry): PartDef {
  return { key, build: fn };
}

/** Wrap a cosmetic index into 0..n-1 (negative-safe). */
export function wrap(i: number, n: number): number {
  const k = Math.floor(i) % n;
  return k < 0 ? k + n : k;
}

export interface TeamCols {
  main: number;
  dark: number;
  light: number;
}

/** Glossy team colour with highlights toward the top and per-voxel jitter. */
export function teamPaint(t: TeamCols, seed: number, y0: number, y1: number): ColorFn {
  return (x, y, z) => {
    const h = hashVox(x, y, z, seed);
    const k = Math.max(0, Math.min(1, (y - y0) / Math.max(1, y1 - y0)));
    const base = h > 0.93 ? t.light : h < 0.06 ? t.dark : t.main;
    return shade(base, 0.9 + k * 0.16 + (h - 0.5) * 0.06);
  };
}

/** Bead eyes: black glossy 2x2 with a white glint, at x = +-ex. Paints into an existing grid. */
export function beadEyes(g: RGrid, ex: number, y: number, z: number, which: 'both' | 'left' | 'right' = 'both', big = false): void {
  const one = (side: number) => {
    const x0 = side > 0 ? ex : -1 - ex - (big ? 2 : 1);
    const w = big ? 3 : 2;
    g.on(CH.wet, () => {
      for (let i = 0; i < w; i++)
        for (let j = 0; j < w; j++) {
          g.set(x0 + i, y + j, z, 0x17141a);
          g.set(x0 + i, y + j, z - 1, 0x17141a);
        }
      // glint (upper outer corner)
      const gx = side > 0 ? x0 + w - 1 : x0;
      g.set(gx, y + w - 1, z, 0xffffff);
      if (big) g.set(side > 0 ? x0 : x0 + w - 1, y, z, 0x3a3440);
    });
  };
  if (which !== 'right') one(1);
  if (which !== 'left') one(-1);
}

/** Water drop (sweat) or spark, centred on its joint. */
export function dropGrid(spark: boolean): RGrid {
  const g = new RGrid(4, 5, 4, -2, -2, -2);
  if (spark) {
    g.on(CH.pulse, () => {
      g.box(-1, -1, -1, 0, 0, 0, 0xffb347);
      g.set(-1, 1, -1, 0xffe08a);
      g.set(0, -2, 0, 0xff7a2a);
    });
  } else {
    g.on(CH.wet, () => {
      g.box(-1, -2, -1, 0, -1, 0, 0x9fd8ff);
      g.set(-1, 0, -1, 0xc8ecff);
      g.set(0, 0, 0, 0xb4e2ff);
      g.set(-1, 1, -1, 0xe6f7ff);
    });
  }
  return g;
}

/** Hair / fur colour function with strands. */
export function hairPaint(base: number, seed: number): ColorFn {
  return (x, y, z) => {
    const h = hashVox(x, y, z, seed);
    const strand = hashVox(x, 0, z, seed + 1);
    return shade(base, 0.84 + strand * 0.22 + (h - 0.5) * 0.1);
  };
}

export { mix, shade, hashVox };
