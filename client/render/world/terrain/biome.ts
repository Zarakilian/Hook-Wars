// Shared terrain authoring for every map: the river cross-section (bank, lip, wall, bed), islands,
// fountain plazas, worn paths and colour helpers. Each map's biome builds on this and adds its own
// borders and backdrop.
//
// Vertical invariants (see contracts.ts):
//   land (sim channel c <= 0)  stays at or above top - bankDrop, always above waterY(map, 1)
//   the drop into the channel starts at c = LIP so units parked on the edge never stand on a lowered column
//   plazas sit exactly at groundY(map)
import { waterDepthAt } from '../../../../shared/maps/helpers.ts';
import type { MapDef } from '../../../../shared/maps/types.ts';
import { fbm2, valueNoise2 } from '../../../../shared/math.ts';
import { tidalActive } from '../../../../shared/sim/river.ts';
import type { MatchConfig } from '../../../../shared/types.ts';
import { bedY, groundY, waterY } from '../../contracts.ts';
import { hashVox, mix, shade } from '../../voxel/voxel.ts';
import type { Biome, Cell, SideOut } from './field.ts';

/** Channel offset where the bank lip ends and the wall starts dropping. */
export const LIP = 0.2;

/** Surface ids written by biomes (top material). */
export const SURF = {
  LAND: 0,
  PATH: 1,
  PLAZA: 2,
  KERB: 3,
  BANK: 4,
  WALL: 5,
  BED: 6,
  ISLAND: 7,
  ROCK: 8,
  CLIFF: 9,
  SNOW: 10,
  ICE: 11,
  SAND: 12,
  SEABED: 13,
  FLOOR: 14, // jungle floor / dark soil
  BRICK: 15,
  ROOF: 16,
  STREET: 17,
  COPING: 18,
  DARK: 19,
} as const;

/** Side material ids. */
export const SIDE = {
  SOIL: 0, // grass lip over dirt strata
  BANK: 1,
  ROCK: 2,
  ICE: 3,
  SAND: 4,
  BRICK: 5,
  STONE: 6, // cut stone blocks (quay walls, plaza kerbs)
  BUILDING: 7, // walls with windows, tag = building style
  ROOF: 8,
  SNOWROCK: 9,
  PLANK: 10,
  CORAL: 11,
  DARK: 12,
} as const;

export interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  w: number; // half width
}

export function smooth01(t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return k * k * (3 - 2 * k);
}

export function sstep(a: number, b: number, x: number): number {
  return smooth01((x - a) / (b - a));
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Deterministic per-column random 0..1. */
export function h01(ix: number, iz: number, seed: number): number {
  return hashVox(ix, seed * 7 + 3, iz, seed);
}

export function pick(pal: readonly number[], ix: number, iz: number, seed: number): number {
  return pal[Math.floor(h01(ix, iz, seed) * pal.length) % pal.length];
}

/**
 * Soft voxel mosaic: large-scale blend between two palette entries, small per-column brightness
 * jitter and the occasional odd column. Reads as natural ground rather than a checkerboard.
 */
export function mosaic(pal: readonly number[], patch: number, ix: number, iz: number, seed: number, jitter = 0.07, odd = 0.1): number {
  const n = pal.length;
  const f = Math.max(0, Math.min(0.999, patch)) * (n - 1);
  const a = Math.floor(f);
  let c = mix(pal[a], pal[Math.min(n - 1, a + 1)], f - a);
  if (h01(ix, iz, seed) < odd) c = mix(c, pal[Math.floor(h01(ix, iz, seed + 1) * n) % n], 0.7);
  return shade(c, 1 + (h01(ix, iz, seed + 2) - 0.5) * 2 * jitter);
}

/** Brightness jitter: c * (1 +- amt). */
export function jit(c: number, ix: number, iz: number, amt: number, seed = 5): number {
  return shade(c, 1 + (h01(ix, iz, seed) - 0.5) * 2 * amt);
}

export function distToSeg(px: number, pz: number, s: Seg): number {
  const abx = s.bx - s.ax;
  const abz = s.bz - s.az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 0 ? ((px - s.ax) * abx + (pz - s.az) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (s.ax + abx * t);
  const dz = pz - (s.az + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Polyline [x0,z0,x1,z1,...] (team 0 side) -> segments for both teams (point mirrored). */
export function pathSegs(lines: number[][], w: number): Seg[] {
  const out: Seg[] = [];
  for (const l of lines) {
    for (let i = 0; i + 3 < l.length; i += 2) {
      out.push({ ax: l[i], az: l[i + 1], bx: l[i + 2], bz: l[i + 3], w });
      out.push({ ax: -l[i], az: -l[i + 1], bx: -l[i + 2], bz: -l[i + 3], w });
    }
  }
  return out;
}

export interface RiverInfo {
  /** terrain channel offset (sim channel inside the map) */
  c: number;
  /** distance into the nearest island (negative outside), or -1e9 */
  island: boolean;
}

export abstract class BaseBiome implements Biome {
  readonly map: MapDef;
  readonly config: MatchConfig;
  readonly base: number;
  readonly T: number;
  readonly B: number;
  readonly fullY: number;
  readonly dry: boolean;
  readonly tidal: boolean;
  readonly halfW: number;
  readonly halfD: number;
  /** how far the bank slopes down before the lip (stays above full water) */
  bankDrop = 0.18;
  /** horizontal width of the channel wall */
  wallW = 1.8;
  /** width of the gentle bank on land */
  bankW: number;
  paths: Seg[] = [];
  plazaR = 6.5;
  readonly fountains: { x: number; z: number; r: number }[];

  constructor(map: MapDef, config: MatchConfig) {
    this.map = map;
    this.config = config;
    this.T = groundY(map);
    this.base = this.T;
    this.B = bedY(map);
    this.fullY = waterY(map, 1);
    this.dry = config.riverMode === 'dry';
    this.tidal = tidalActive(map, config);
    this.halfW = map.w / 2;
    this.halfD = map.d / 2;
    this.bankW = map.river.bank;
    this.fountains = map.fountains.map((f) => ({ x: f.x, z: f.z, r: f.r }));
  }

  abstract sample(x: number, z: number, ix: number, iz: number, cellSize: number, out: Cell): void;
  abstract sideColor(side: number, tag: number, ix: number, iy: number, iz: number, dir: number, y0: number, y1: number, top: number, cellSize: number, out: SideOut): void;

  /**
   * Channel offset where the water (and so the carved bed) is: the sim channel without platforms, so
   * the river runs on under docks and bridges. Biomes override to reshape the river outside the map.
   */
  channel(x: number, z: number): number {
    return waterDepthAt(this.map, x, z);
  }

  /** True when the nearest channel boundary at (x,z) is an island shore. */
  nearIsland(x: number, z: number): boolean {
    for (const i of this.map.islands) {
      const d = Math.hypot(x - i.x, z - i.z) - i.r;
      if (d < this.bankW + 0.5) return true;
    }
    return false;
  }

  /** Low-amplitude ground noise for the playable land. */
  landNoise(x: number, z: number): number {
    const t = this.map.terrain;
    return (fbm2(x * t.noiseScale, z * t.noiseScale, 3, 5) - 0.5) * 2 * t.noiseAmp;
  }

  /** Distance from (x,z) to the nearest fountain plaza edge (negative inside). The plaza is the heal circle plus a kerb ring. */
  plazaDist(x: number, z: number): number {
    let best = 1e9;
    for (const f of this.fountains) {
      const d = Math.hypot(x - f.x, z - f.z) - (f.r + 0.4);
      if (d < best) best = d;
    }
    return best;
  }

  /** 0..1 how much (x,z) is on a worn path (1 = centre). Edges are dithered by the caller. */
  pathAmount(x: number, z: number): number {
    let best = 0;
    for (const s of this.paths) {
      const d = distToSeg(x, z, s);
      if (d < s.w) {
        const v = 1 - d / s.w;
        if (v > best) best = v;
      }
    }
    return best;
  }

  /**
   * River cross-section height for channel offset c. landH is the height the land would have here.
   * Returns the height and writes the zone: 0 land, 1 bank, 2 wall, 3 bed.
   */
  profile(c: number, landH: number, zone: { z: number; t: number }, x?: number, z?: number): number {
    const bw = this.bankW;
    // ragged channel walls: only ever pushes the wall further into the channel, never lowers land
    if (x !== undefined && z !== undefined && c > LIP && this.wallW > 0.5) {
      // positive = the wall drops sooner; the negative side is clamped so dry lip ground never
      // reaches far into the sim's water
      const jag = Math.max(-0.08, (valueNoise2(x * 0.42, z * 0.42, 79) - 0.5) * 0.9 + (valueNoise2(x * 1.3, z * 1.3, 80) - 0.5) * 0.2);
      c = LIP + Math.max(0.0001, c - LIP + jag);
    }
    if (c <= -bw) {
      zone.z = 0;
      zone.t = 0;
      return landH;
    }
    const lipH = this.T - this.bankDrop;
    if (c <= LIP) {
      const t = smooth01((c + bw) / (bw + LIP));
      zone.z = 1;
      zone.t = t;
      return landH + (lipH - landH) * t;
    }
    const bedEdge = this.B + 0.4;
    const ww = this.wallW;
    if (c <= LIP + ww) {
      const t = (c - LIP) / ww;
      zone.z = 2;
      zone.t = t;
      // steeper at the top, easing into the bed
      const k = 1 - Math.pow(1 - t, 1.7);
      return lipH + (bedEdge - lipH) * k;
    }
    const t = clamp01((c - LIP - ww) / 2.6);
    zone.z = 3;
    zone.t = t;
    return bedEdge + (this.B - bedEdge) * smooth01(t);
  }

  /** Bed micro relief: gentle undulation, kept tiny so the dry bed is walkable. */
  bedNoise(x: number, z: number): number {
    return (valueNoise2(x * 0.45, z * 0.45, 77) - 0.5) * 0.12 + (valueNoise2(x * 1.7, z * 1.7, 78) - 0.5) * 0.04;
  }

  /** Voronoi crack distance (0 on a crack line, ~0.5 inside a plate). Cell size ~ 1/scale m. */
  crack(x: number, z: number, scale: number): number {
    return this.voronoi(x, z, scale);
  }

  /** Voronoi edge distance; the nearest cell id is left in this.cellId. */
  cellId = 0;
  voronoi(x: number, z: number, scale: number): number {
    const px = x * scale;
    const pz = z * scale;
    const cx = Math.floor(px);
    const cz = Math.floor(pz);
    let d1 = 9;
    let d2 = 9;
    let id = 0;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i;
        const gz = cz + j;
        const fx = gx + 0.15 + hashVox(gx, 1, gz, 91) * 0.7;
        const fz = gz + 0.15 + hashVox(gx, 2, gz, 92) * 0.7;
        const dx = fx - px;
        const dz = fz - pz;
        const d = dx * dx + dz * dz;
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = gx * 7919 + gz * 104729;
        } else if (d < d2) d2 = d;
      }
    this.cellId = id;
    return Math.sqrt(d2) - Math.sqrt(d1);
  }

  /** Signed distance outside the play rectangle (negative inside). */
  outside(x: number, z: number): number {
    const dx = Math.abs(x) - this.halfW;
    const dz = Math.abs(z) - this.halfD;
    if (dx > 0 && dz > 0) return Math.hypot(dx, dz);
    return Math.max(dx, dz);
  }
}

/** Colour of a stacked soil side: grass lip on top, then dirt strata, darker with depth. */
export function soilSide(grass: readonly number[], dirt: readonly number[], ix: number, iy: number, iz: number, y1: number, top: number, out: SideOut): void {
  if (top - y1 < 0.001) {
    // topmost segment: grass lip
    out.color = shade(grass[Math.floor(hashVox(ix, iy, iz, 3) * grass.length) % grass.length], 0.78);
  } else {
    out.color = shade(dirt[Math.floor(hashVox(ix, iy, iz, 4) * dirt.length) % dirt.length], 0.92 + hashVox(ix, iy, iz, 9) * 0.12);
  }
  out.rough = 0.95;
  out.emit = 0;
}

/** Layered rock strata: each 0.25 m course picks a palette entry, with per-voxel jitter. */
export function strata(pal: readonly number[], ix: number, iy: number, iz: number, seed: number, jitter = 0.08): number {
  const band = Math.floor(hashVox(0, iy, 0, seed) * pal.length);
  const c = hashVox(ix, iy, iz, seed + 1) < 0.7 ? pal[band % pal.length] : pal[Math.floor(hashVox(ix, iy, iz, seed + 2) * pal.length) % pal.length];
  return shade(c, 1 + (hashVox(ix, iy, iz, seed + 3) - 0.5) * 2 * jitter);
}

export { mix, shade };
