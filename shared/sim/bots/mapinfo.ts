// Static map analysis for bots, built once per map and shared by every match on it:
// occupancy grids for cheap line-of-sight and walkability tests, cover and anchor lists per side.
import { UNIT_RADIUS } from '../../constants.ts';
import { channelDepthAt, riverAt } from '../../maps/helpers.ts';
import type { MapDef } from '../../maps/types.ts';
import { distToSegment } from '../../math.ts';
import type { Team } from '../../types.ts';

const CELL = 0.5;
/** Obstacles are inflated by this much in the hook grid (about a base hook head radius). */
export const HOOK_INFLATE = 0.4;

export interface MapInfo {
  map: MapDef;
  nx: number;
  nz: number;
  ox: number;
  oz: number;
  inv: number;
  /** 1 where a hook head would touch an obstacle. */
  hookGrid: Uint8Array;
  /** 1 where a unit centre cannot stand (obstacle or map edge). */
  walkGrid: Uint8Array;
  /** Obstacles close to each team's bank edge: places to hide from hooks. */
  cover: [number[], number[]];
  /** Obstacles on each team's side of the river: grapple anchors. */
  anchors: [number[], number[]];
  /** Obstacle reference points (circle centre or wall midpoint). */
  ox_: Float64Array;
  oz_: Float64Array;
  bouncy: boolean;
}

const cache = new WeakMap<MapDef, MapInfo>();

export function mapInfo(map: MapDef): MapInfo {
  const hit = cache.get(map);
  if (hit) return hit;
  const nx = Math.ceil(map.w / CELL);
  const nz = Math.ceil(map.d / CELL);
  const ox = -map.w / 2;
  const oz = -map.d / 2;
  const hookGrid = new Uint8Array(nx * nz);
  const walkGrid = new Uint8Array(nx * nz);
  const obs = map.obstacles;
  const halfW = map.w / 2;
  const halfD = map.d / 2;
  for (let iz = 0; iz < nz; iz++) {
    const z = oz + (iz + 0.5) * CELL;
    for (let ix = 0; ix < nx; ix++) {
      const x = ox + (ix + 0.5) * CELL;
      let dmin = 1e9;
      for (const o of obs) {
        const d = o.shape === 'circle' ? Math.hypot(x - o.x, z - o.z) - o.r : distToSegment(o.ax, o.az, o.bx, o.bz, x, z) - o.r;
        if (d < dmin) dmin = d;
      }
      const i = ix + iz * nx;
      if (dmin < HOOK_INFLATE) hookGrid[i] = 1;
      if (dmin < UNIT_RADIUS + 0.05 || Math.abs(x) > halfW - UNIT_RADIUS - 0.1 || Math.abs(z) > halfD - UNIT_RADIUS - 0.1) walkGrid[i] = 1;
    }
  }
  const cover: [number[], number[]] = [[], []];
  const anchors: [number[], number[]] = [[], []];
  const ox_ = new Float64Array(obs.length);
  const oz_ = new Float64Array(obs.length);
  let bouncy = false;
  obs.forEach((o, i) => {
    const x = o.shape === 'circle' ? o.x : (o.ax + o.bx) / 2;
    const z = o.shape === 'circle' ? o.z : (o.az + o.bz) / 2;
    ox_[i] = x;
    oz_[i] = z;
    if (o.bouncy) bouncy = true;
    const c = riverAt(map.river.points, z);
    const side: Team = x < c.x ? 0 : 1;
    anchors[side].push(i);
    const edgeDist = -channelDepthAt(map, x, z);
    if (edgeDist > 0.4 && edgeDist < 11 && !o.bouncy) cover[side].push(i);
  });
  const info: MapInfo = { map, nx, nz, ox, oz, inv: 1 / CELL, hookGrid, walkGrid, cover, anchors, ox_, oz_, bouncy };
  cache.set(map, info);
  return info;
}

export function cellBlocked(info: MapInfo, grid: Uint8Array, x: number, z: number): boolean {
  const ix = Math.floor((x - info.ox) * info.inv);
  const iz = Math.floor((z - info.oz) * info.inv);
  if (ix < 0 || iz < 0 || ix >= info.nx || iz >= info.nz) return true;
  return grid[ix + iz * info.nx] === 1;
}

/**
 * Cheap static line test on the hook grid. Skips `skip0` metres at the start (the hand) and
 * `skip1` metres at the end (the target's body is hit before its centre).
 */
export function hookLineClear(info: MapInfo, x0: number, z0: number, x1: number, z1: number, skip0 = 0.9, skip1 = 0.9): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.sqrt(dx * dx + dz * dz);
  const a = skip0;
  const b = len - skip1;
  if (b <= a) return true;
  const ux = dx / len;
  const uz = dz / len;
  const grid = info.hookGrid;
  const nx = info.nx;
  for (let s = a; s <= b; s += 0.3) {
    const ix = Math.floor((x0 + ux * s - info.ox) * info.inv);
    const iz = Math.floor((z0 + uz * s - info.oz) * info.inv);
    if (ix < 0 || iz < 0 || ix >= nx || iz >= info.nz) continue;
    if (grid[ix + iz * nx] === 1) return false;
  }
  return true;
}

/** True if a unit centre fits at (x, z) (static obstacles and map edge only). */
export function standable(info: MapInfo, x: number, z: number): boolean {
  return !cellBlocked(info, info.walkGrid, x, z);
}
