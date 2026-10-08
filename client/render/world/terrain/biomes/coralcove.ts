// Coral Cove: lush grass inland, wide sandy banks and a rippled sand bed. The river pours in over a
// sandstone waterfall cliff behind the far edge (z = -24) and runs out across a beach into the sea
// past the near edge. Jungle hills with palms and boulders flank the sides.
import { riverAt, scatter } from '../../../../../shared/maps/helpers.ts';
import type { Decor, MapDef } from '../../../../../shared/maps/types.ts';
import { fbm2, valueNoise2 } from '../../../../../shared/math.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import type { Quality } from '../../../contracts.ts';
import { hashVox } from '../../../voxel/voxel.ts';
import { BaseBiome, SIDE, SURF, clamp01, h01, jit, mix, mosaic, pathSegs, pick, shade, soilSide, sstep, strata } from '../biome.ts';
import type { Cell, SideOut } from '../field.ts';
import type { BackdropRule } from '../flora.ts';
import type { MapBiome, PoolDef } from './index.ts';

const SANDSTONE = [0xc2a57a, 0xb3966c, 0xd0b48a, 0xa8895f, 0xbf9e70];
const MOSS = [0x5a8a3a, 0x4f7f34, 0x679a44];
const TILE = [0xe2cfa4, 0xd6c094, 0xead9b2, 0xcbb487];
const SHELLS = [0xf4e6d4, 0xf0c8b8, 0xe8d8c0];
const JUNGLE_FLOOR = [0x4f7a2e, 0x5a8634, 0x456c28, 0x648f3a];

/**
 * Cliff lip height above the bank top where the river falls in. Matches the water module's
 * waterfall sheet (lip at groundY + 2.7, 1.25 m behind the waterfall decor at z = -24).
 */
export const CORAL_LIP = 2.62;
/** z of the waterfall lip edge (the notch is cut square here) */
const LIP_Z = -25.3;

export class CoralcoveBiome extends BaseBiome implements MapBiome {
  private readonly zone = { z: 0, t: 0 };
  readonly sparkle = 0.35;
  readonly farColor = 0x3d7a8a;
  readonly farY: number;
  private readonly grass: number[];
  private readonly sand: number[];
  private readonly lipY: number;
  private readonly cliffZ: number;

  constructor(map: MapDef, config: MatchConfig) {
    super(map, config);
    this.farY = this.B - 1;
    this.bankDrop = 0.17;
    this.wallW = 2.4;
    this.grass = byLum(map.terrain.grass);
    this.sand = byLum(map.terrain.bank);
    this.lipY = this.T + CORAL_LIP;
    this.cliffZ = -this.halfD - 0.6;
    this.paths = pathSegs(
      [
        [-25.6, 1.6, -21, 3.4, -16.4, 3.0, -11.8, 4.8],
        [-26.6, -3.6, -22, -9.6, -18.6, -13.2, -13.4, -12.4],
        [-26.2, 4.8, -23, 9.6, -21.6, 13.4, -17, 16.6, -12, 13.8],
      ],
      0.75,
    );
  }

  /** Cliff face line (z) behind the far edge, a little ragged, square at the waterfall notch. */
  private cliffLine(x: number): number {
    const r = riverAt(this.map.river.points, -this.halfD);
    const dx = Math.abs(x - r.x);
    const rag = this.cliffZ - valueNoise2(x * 0.35, 5, 61) * 0.9 - valueNoise2(x * 0.08, 6, 62) * 1.6;
    if (dx < 5.2) return LIP_Z;
    if (dx < 7) return LIP_Z + (rag - LIP_Z) * ((dx - 5.2) / 1.8);
    return rag;
  }

  /** The river opens wide into the sea past the near edge. */
  override channel(x: number, z: number): number {
    let c = super.channel(x, z);
    if (z > 25) c += (z - 25) * (z - 25) * 0.12 + (valueNoise2(x * 0.18, z * 0.18, 33) - 0.5) * Math.min(1, (z - 25) / 4) * 3;
    return c;
  }

  sample(x: number, z: number, ix: number, iz: number, cs: number, out: Cell): void {
    const tr = this.map.terrain;
    const fine = cs < 0.5;
    const o = this.outside(x, z);
    const pd = this.plazaDist(x, z);
    const T = this.T;
    let c = this.channel(x, z);
    let land = T + this.landNoise(x, z);
    let surf: number = SURF.LAND;
    let side: number = SIDE.SOIL;
    let mode = 0; // 0 normal, 1 cliff top, 2 notch / stream, 3 hills
    // ---------------- far end: waterfall cliff
    const cz = this.cliffLine(x);
    if (z < cz) {
      const r = riverAt(this.map.river.points, z);
      const dx = Math.abs(x - r.x);
      const notch = 4.6 + (cz - z) * 0.02;
      if (dx < notch) {
        // stream bed above the falls
        mode = 2;
        const k = clamp01((notch - dx) / 1.6);
        land = this.lipY + 0.35 - k * 0.95 + (valueNoise2(x * 0.5, z * 0.5, 63) - 0.5) * 0.12;
        if (cz - z < 0.7) land = Math.max(land, this.lipY - 0.22);
        surf = k > 0.75 ? SURF.SEABED : SURF.ROCK;
      } else {
        mode = 1;
        land = T + 4.6 + fbm2(x * 0.07, z * 0.07, 3, 64) * 2.2 + sstep(6, 40, cz - z) * 6;
        surf = SURF.FLOOR;
      }
      side = SIDE.ROCK;
    } else if (o > 0 && pd > 0.6) {
      if (z > this.halfD) {
        // beach running down into the sea
        const d = z - this.halfD;
        const wob = (valueNoise2(x * 0.22, z * 0.5, 67) - 0.5) * 1.6 + (valueNoise2(x * 0.9, z * 0.9, 68) - 0.5) * 0.4;
        const dd = d + wob;
        land = T + this.landNoise(x, z) * (1 - sstep(0, 3, d)) - 0.44 * sstep(0.3, 7.5, dd) - Math.max(0, dd - 6.5) * 0.32;
        land = Math.max(land, this.B - 2.5);
        surf = SURF.SAND;
        side = SIDE.SAND;
        // rocky headlands at the corners
        if (Math.abs(x) > this.halfW + 3) {
          const hill = Math.max(0, (fbm2(x * 0.05, z * 0.05, 3, 65) - 0.42) * 9) * sstep(3, 12, Math.abs(x) - this.halfW);
          if (hill > 0.3) {
            land = Math.max(land, T + hill * 0.7 - (z - this.halfD) * 0.12);
            surf = SURF.FLOOR;
            side = SIDE.ROCK;
          }
        }
      } else {
        // jungle hills
        mode = 3;
        const k = sstep(0.4, 4.5, o);
        land += k * (0.5 + Math.max(0, fbm2(x * 0.06, z * 0.06, 3, 66) - 0.3) * 6 * sstep(3, 25, o));
        surf = k > 0.3 ? SURF.FLOOR : SURF.LAND;
        side = SIDE.ROCK;
      }
    }
    let path = 0;
    if (pd < 0) {
      land = T;
      surf = pd > -0.3 ? SURF.KERB : SURF.PLAZA;
      if (surf === SURF.KERB) land = T + 0.0625;
      side = SIDE.STONE;
    } else if (o < 0 && fine) {
      path = this.pathAmount(x, z);
      if (path > 0) land -= 0.05 * sstep(0, 0.6, path);
    }
    const zn = this.zone;
    let h = land;
    if (mode === 0 || mode === 3) {
      h = this.profile(c, land, zn, x, z);
      if (zn.z >= 2) {
        surf = zn.z === 2 ? SURF.WALL : SURF.BED;
        side = SIDE.SAND;
        if (zn.z === 3) {
          h += this.bedNoise(x, z) * 0.6;
          if (fine) h += Math.sin(x * 2.1 + Math.sin(z * 0.4) * 1.5) * 0.025; // sand ripples
        }
      } else if (zn.z === 1 && surf !== SURF.PLAZA && surf !== SURF.KERB) {
        surf = SURF.BANK;
        side = SIDE.SAND;
      }
      if (z > this.halfD + 1 && h < this.fullY - 0.05) {
        surf = SURF.SEABED;
        side = SIDE.SAND;
      }
    } else {
      zn.z = 0;
      c = -9;
    }
    out.h = h;
    out.q = mode === 1 || mode === 2 || surf === SURF.WALL ? 0.25 : !fine ? 0.5 : surf === SURF.FLOOR ? 0.125 : 1 / 16;
    out.side = side;
    out.tag = 0;
    let col: number;
    let rough = 0.9;
    let spk = 0;
    switch (surf) {
      case SURF.PLAZA: {
        // sandstone tiles with a shell mosaic sunburst
        const f = x < 0 ? this.fountains[0] : this.fountains[1];
        const dx = x - f.x;
        const dz = z - f.z;
        const r = Math.hypot(dx, dz);
        const a = Math.atan2(dz, dx);
        const ray = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 16);
        col = pick(TILE, ix, iz, 40);
        if (r > 2 && r < 5.2 && ray % 2 === 0) col = mix(col, 0x7fc6c8, 0.55);
        if (r > 5.5 && r < 5.9) col = pick(SHELLS, ix, iz, 41);
        if (r < 1.9) col = shade(col, 1.06);
        col = jit(col, ix, iz, 0.04);
        rough = 0.75;
        break;
      }
      case SURF.KERB:
        col = jit(0xd8735a, ix, iz, 0.08); // coral pink kerb
        rough = 0.7;
        break;
      case SURF.BANK: {
        const t = zn.t;
        if (h01(ix, iz, 21) > t * 2.2 - 0.25 && t < 0.45) col = mosaic(this.grass, 0.4, ix, iz, 1, 0.06, 0.1);
        else col = mosaic(this.sand, valueNoise2(x * 0.2, z * 0.2, 42) * 0.8 + 0.1, ix, iz, 2, 0.04, 0.08);
        if (h01(ix, iz, 22) < 0.03) col = pick(SHELLS, ix, iz, 3);
        rough = 0.9;
        spk = 0.7;
        break;
      }
      case SURF.WALL:
      case SURF.SAND:
        col = mosaic(this.sand, valueNoise2(x * 0.15, z * 0.15, 43) * 0.7 + 0.15, ix, iz, 4, 0.05, 0.08);
        if (surf === SURF.WALL) col = shade(col, 0.94 - zn.t * 0.1);
        if (h01(ix, iz, 23) < 0.025) col = pick(SHELLS, ix, iz, 5);
        rough = 0.92;
        spk = 0.8;
        break;
      case SURF.BED: {
        const pal = this.dry ? tr.dryBed : tr.bed;
        col = mosaic(byLum(pal), valueNoise2(x * 0.2, z * 0.2, 44) * 0.6 + 0.2, ix, iz, 6, 0.05, 0.1);
        if (fine && Math.sin(x * 2.1 + Math.sin(z * 0.4) * 1.5) > 0.6) col = shade(col, 1.06);
        if (h01(ix, iz, 24) < 0.03) col = pick(SHELLS, ix, iz, 7);
        if (h01(ix, iz, 25) < 0.012) col = 0xe8806a; // coral bit
        rough = this.dry ? 0.95 : 0.7;
        spk = this.dry ? 0.8 : 0;
        break;
      }
      case SURF.SEABED:
        col = mosaic(this.sand, 0.5, ix, iz, 8, 0.05, 0.1);
        col = shade(col, 0.9);
        rough = 0.6;
        break;
      case SURF.ROCK:
        col = jit(pick(SANDSTONE, ix, iz, 9), ix, iz, 0.06);
        if (h01(ix, iz, 26) < 0.25) col = pick(MOSS, ix, iz, 10);
        rough = 0.8;
        break;
      case SURF.FLOOR: {
        col = mosaic(JUNGLE_FLOOR, valueNoise2(x * 0.1, z * 0.1, 45), ix, iz, 11, 0.07, 0.12);
        if (h01(ix, iz, 27) < 0.05) col = pick(SANDSTONE, ix, iz, 12);
        rough = 0.95;
        break;
      }
      default: {
        const patch = valueNoise2(x * 0.07, z * 0.07, 46) * 0.7 + valueNoise2(x * 0.3, z * 0.3, 49) * 0.3;
        col = mosaic(this.grass, patch, ix, iz, 13, 0.06, 0.1);
        const r = h01(ix, iz, 28);
        if (r < 0.015) col = 0xf2d24a; // tiny flower
        else if (r < 0.03) col = 0xe86a8a;
        if (path > 0.2) {
          const p = (path - 0.2) / 0.5;
          if (h01(ix, iz, 29) < p * 0.85) col = mix(mosaic(byLum(tr.dirt), valueNoise2(x * 0.5, z * 0.5, 50), ix, iz, 16, 0.05, 0.12), col, 0.3);
        }
        rough = 0.9;
      }
    }
    out.top = col;
    out.rough = rough;
    out.sparkle = spk;
  }

  sideColor(side: number, _tag: number, ix: number, iy: number, iz: number, _dir: number, _y0: number, y1: number, top: number, _cs: number, out: SideOut): void {
    const tr = this.map.terrain;
    out.emit = 0;
    out.rough = 0.85;
    const depth = top - y1;
    switch (side) {
      case SIDE.SOIL:
        soilSide(this.grass, tr.dirt, ix, iy, iz, y1, top, out);
        return;
      case SIDE.ROCK: {
        let c = strata(SANDSTONE, ix >> 1, iy >> 1, iz >> 1, 100, 0.07);
        if (depth < 0.3) c = pick(JUNGLE_FLOOR, ix, iz, 101);
        else if (hashVox(ix, iy, iz, 102) < 0.12) c = mix(c, MOSS[0], 0.6); // moss streaks
        else if (hashVox(ix >> 1, iy, iz >> 1, 103) < 0.05) c = shade(c, 0.7);
        out.color = c;
        out.rough = 0.8;
        return;
      }
      case SIDE.STONE:
        out.color = strata(TILE, ix, iy, iz, 104, 0.05);
        return;
      default: {
        let c = strata(this.sand, ix, iy, iz, 105, 0.06);
        out.color = shade(c, 1 - clamp01(depth / 2.6) * 0.15);
        out.rough = 0.92;
        c = 0;
      }
    }
  }

  backdrop(): BackdropRule[] {
    const hills = (x: number, z: number) => {
      const o = this.outside(x, z);
      if (o < 1.6 || this.plazaDist(x, z) < 1.2) return 0;
      if (z > this.halfD + 1 || this.channel(x, z) > -1.5) return 0;
      if (z < this.cliffLine(x) && Math.abs(x - riverAt(this.map.river.points, z).x) < 6.5) return 0;
      return 1;
    };
    const cliffTop = (x: number, z: number) => (z < this.cliffLine(x) - 1.2 && Math.abs(x - riverAt(this.map.river.points, z).x) > 6 ? 1 : 0);
    const beach = (x: number, z: number) => {
      if (z < this.halfD + 0.5) return 0;
      const c = this.channel(x, z);
      return c < -1 ? 1 : 0;
    };
    const surf = (x: number, z: number) => {
      if (z < this.halfD + 6) return 0;
      const c = this.channel(x, z);
      return c > 2 && c < 14 ? 1 : 0;
    };
    return [
      { model: 'palm', spacing: 4.2, scale: [0.85, 1.25], density: (x, z) => hills(x, z) * (this.outside(x, z) < 14 ? 0.7 : 0.4) + beach(x, z) * 0.25 + cliffTop(x, z) * 0.35, castShadow: true },
      { model: 'jbush', spacing: 2.2, scale: [0.8, 1.4], density: (x, z) => hills(x, z) * 0.7 + cliffTop(x, z) * 0.6 },
      { model: 'sandrock', spacing: 3.2, scale: [0.6, 1.4], density: (x, z) => hills(x, z) * 0.22 + beach(x, z) * 0.06 + cliffTop(x, z) * 0.15 },
      { model: 'beachgrass', spacing: 1.4, scale: [0.7, 1.3], density: (x, z) => beach(x, z) * 0.35 + (this.outside(x, z) > 0.3 && this.outside(x, z) < 2.5 && this.plazaDist(x, z) > 0.6 ? 0.4 : 0) },
      { model: 'driftwood', spacing: 6, scale: [0.8, 1.3], density: (x, z) => beach(x, z) * 0.2 },
      { model: 'searock', spacing: 7, scale: [0.8, 1.8], density: (x, z) => surf(x, z) * 0.3, yOffset: -0.4, underwater: true },
      { model: 'searock', spacing: 4, scale: [0.6, 1.2], density: (x, z) => (Math.abs(z - this.cliffLine(x)) < 1.2 && Math.abs(x - riverAt(this.map.river.points, z).x) > 5 && Math.abs(x - riverAt(this.map.river.points, z).x) < 9 ? 0.5 : 0) },
    ];
  }

  details(q: Quality): BackdropRule[] {
    if (q === 'low') return [];
    const rich = q === 'high' || q === 'ultra';
    const inPlay = (x: number, z: number) => Math.abs(x) < this.halfW - 0.3 && Math.abs(z) < this.halfD - 0.3 && this.plazaDist(x, z) > 0.3;
    return [
      { model: 'shellbits', spacing: rich ? 1.1 : 1.7, scale: [0.7, 1.3], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -this.bankW && c < 0.1 ? 0.45 : 0; } },
      { model: 'shellbits', spacing: rich ? 1.3 : 2, scale: [0.8, 1.4], density: (x, z) => (inPlay(x, z) && this.channel(x, z) > 2.4 ? (this.dry ? 0.55 : 0.3) : 0), underwater: true },
      { model: 'pebble', spacing: rich ? 2 : 3, scale: [0.6, 1.1], density: (x, z) => (inPlay(x, z) && this.channel(x, z) < -this.bankW - 0.5 ? 0.15 : 0) },
    ];
  }

  extraDecor(): Decor[] {
    if (!this.dry) return [];
    const inBed = (x: number, z: number) => this.channel(x, z) > 1.8 && Math.abs(z) < this.halfD - 0.5;
    return [
      ...scatter(this.map, { kind: 'shell', count: 44, seed: 921, scale: [0.7, 1.3], accept: inBed }),
      ...scatter(this.map, { kind: 'starfish', count: 22, seed: 922, scale: [0.7, 1.2], accept: inBed }),
      ...scatter(this.map, { kind: 'pebbles', count: 20, seed: 923, scale: [0.7, 1.2], accept: inBed }),
    ];
  }

  backwaterKeep(x: number, z: number): boolean {
    // the stream above the falls has its own fixed-level pool
    return z > this.cliffLine(x) + 0.05;
  }

  pools(): PoolDef[] {
    const zTop = OUTER_Z0;
    return [
      {
        x0: -20,
        x1: 20,
        z0: zTop,
        z1: -this.halfD - 0.5,
        level: this.lipY + 0.06,
        // only the stream notch: cells straddling the cliff face elsewhere would leave a strip of
        // lip-height water sticking out of the rock
        keep: (x, z) => z < this.cliffLine(x) + 0.12 && Math.abs(x - riverAt(this.map.river.points, z).x) < 6.5,
      },
    ];
  }
}

const OUTER_Z0 = -96;

function byLum(p: readonly number[]): number[] {
  const l = (c: number) => ((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11;
  return [...p].sort((a, b) => l(a) - l(b));
}
