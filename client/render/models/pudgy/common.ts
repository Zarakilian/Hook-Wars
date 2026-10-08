// Helpers shared by the three family builders.
import type * as THREE from 'three';
import type { Quality } from '../../contracts.ts';
import type { Loadout, Team } from '../../../../shared/types.ts';
import { atRes, CH, hashVox, hv, meshPart, mix, P, RGrid, shade, type ColorFn, type Paint, type Test } from './grid.ts';
import type { PartDef, V3 } from './types.ts';

/** Build context handed to every part builder. */
export interface Look {
  head?: string;
  face?: string;
  body?: string;
  hands?: string;
  feet?: string;
  back?: string;
  team: Team;
  t: TeamCols;
  /** showcase detail: finer voxels and extra trims */
  fine: boolean;
  quality: Quality;
}

export function lookOf(loadout: Loadout, team: Team, t: TeamCols, fine: boolean, quality: Quality): Look {
  return { head: loadout.head, face: loadout.face, body: loadout.body, hands: loadout.hands, feet: loadout.feet, back: loadout.back, team, t, fine, quality };
}

/** Copy of a grid mirrored across the skeleton x = 0 plane (left part -> right part). */
export function mirrorGrid(g: RGrid): RGrid {
  const m = new RGrid(g.ux, g.uy, g.uz, -(g.ox + g.ux), g.oy, g.oz, g.res);
  for (let z = 0; z < g.nz; z++)
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < g.nx; x++) m.data[m.index(g.nx - 1 - x, y, z)] = g.data[g.index(x, y, z)];
  return m;
}

export function mirrorV(v: V3): V3 {
  return [-v[0], v[1], v[2]];
}

/** Fine voxels per unit for a detail level. */
export function resOf(fine: boolean): number {
  return fine ? 2 : 1;
}

export function part(key: string, build: () => RGrid, joint: V3, res: number, ao = 0.52): PartDef {
  return {
    key: `${key}@${res}`,
    build: () => atRes(res, () => meshPart(build(), joint, ao)),
    grid: () => atRes(res, build),
  };
}

export function partMirrored(key: string, build: () => RGrid, joint: V3, res: number, ao = 0.52): PartDef {
  return {
    key: `${key}@${res}R`,
    build: () => atRes(res, () => meshPart(mirrorGrid(build()), mirrorV(joint), ao)),
    grid: () => atRes(res, () => mirrorGrid(build())),
  };
}

export function partFn(key: string, fn: () => THREE.BufferGeometry): PartDef {
  return { key, build: fn };
}

export interface TeamCols {
  main: number;
  dark: number;
  light: number;
}

/** Glossy team colour with highlights toward the top and per-voxel jitter. */
export function teamPaint(t: TeamCols, seed: number, y0: number, y1: number): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed);
    const k = Math.max(0, Math.min(1, (y - y0) / Math.max(1, y1 - y0)));
    const base = h > 0.93 ? t.light : h < 0.06 ? t.dark : t.main;
    return shade(base, 0.9 + k * 0.16 + (h - 0.5) * 0.06);
  };
}

/** Woven team cloth (neckerchiefs, sashes, wraps): a subtle twill. */
export function teamCloth(t: TeamCols, seed: number): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed);
    const tw = (x + y + z + 300) % 3 === 0;
    const base = h > 0.95 ? t.light : tw ? shade(t.main, 0.88) : t.main;
    return shade(base, 0.94 + h * 0.1);
  };
}

/** Water drop (sweat) or spark, centred on its joint. */
export function dropGrid(spark: boolean): RGrid {
  const g = new RGrid(4, 5, 4, -2, -2, -2, 1);
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

/** Hair / fur colour with strands running along y. */
export function hairPaint(base: number, seed: number, streak = 0, streakCol = 0): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed);
    const strand = hashVox(x, 0, z, seed + 1);
    if (streak > 0 && hashVox(x, Math.floor(y / 3), z, seed + 2) < streak) return shade(streakCol, 0.9 + h * 0.18);
    return shade(base, 0.8 + strand * 0.26 + (h - 0.5) * 0.12);
  };
}

/** Knit: vertical ribs with a little per-voxel fuzz. */
export function knit(base: number, seed: number, rib = 0.88): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed);
    const r = (x + z + 400) % 2 === 0 ? 1 : rib;
    const row = (y + 400) % 2 === 0 ? 1.02 : 0.97;
    return shade(base, r * row * (0.94 + h * 0.1));
  };
}

/** Horizontal ring (annulus) of cells at height y around (0, cz) on the x/z plane. */
export function ring(g: RGrid, cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, col: Paint, test?: Test): void {
  g.cyl('y', cx, cz, r1, y0, y1, col, r1, (x, y, z) => {
    const d = Math.hypot(P.x - cx, P.z - cz);
    return d >= r0 && (!test || test(x, y, z));
  });
}

/** A flat disc in the x/z plane (brims, plates), radius r around (cx, cz), one cell thick at y. */
export function disc(g: RGrid, cx: number, y: number, cz: number, rx: number, rz: number, col: Paint, test?: Test): void {
  g.cyl('y', cx, cz, rx, y, y, col, rz, test);
}

/** Lumps of a material scattered over a region of a shell (curls, moss, growths). */
export function lumps(
  g: RGrid,
  cx: number, cy: number, cz: number, rx: number, ry: number, rz: number,
  count: number, seed: number, r0: number, r1: number, region: (nx: number, ny: number, nz: number) => boolean, col: Paint, lift = 0.3,
): void {
  let placed = 0;
  for (let i = 0; i < count * 8 && placed < count; i++) {
    // deterministic spherical sample
    const u = hashVox(i, 1, 2, seed);
    const v = hashVox(i, 3, 4, seed);
    const th = u * Math.PI * 2;
    const ph = Math.acos(2 * v - 1);
    const nx = Math.sin(ph) * Math.cos(th);
    const ny = Math.cos(ph);
    const nz = Math.sin(ph) * Math.sin(th);
    if (!region(nx, ny, nz)) continue;
    const r = r0 + (r1 - r0) * hashVox(i, 5, 6, seed);
    g.blob(cx + nx * (rx + lift), cy + ny * (ry + lift), cz + nz * (rz + lift), r, r, r, col);
    placed++;
  }
}

/** Colour of the surface mix used for grime / weathering over a base paint. */
export function grime(base: ColorFn, dirt: number, amount: number, seed: number, scale = 3): ColorFn {
  return (x, y, z) => {
    const c = base(x, y, z);
    const b = hashVox(Math.floor(x / scale), Math.floor(y / scale), Math.floor(z / scale), seed);
    if (b > 1 - amount) return mix(c, dirt, 0.35 + hv(x, y, z, seed + 1) * 0.35);
    return c;
  };
}

export { mix, shade, hashVox, hv };
