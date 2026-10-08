// Cogwater Canal: rain-slick cobbles with puddles, granite coping along a sheer stone canal wall,
// herringbone brick plazas. A brick harbour wall rings the sides with a lamplit street and
// warehouses behind it, the canal runs on between warehouse quays past the far lock gate, and past
// the near lock gate it opens into the harbour basin with piers, boats and cranes.
// The lock gates hold the outer water at a fixed level, so on Tidal only the canal drains.
import { scatter } from '../../../../../shared/maps/helpers.ts';
import type { Decor, MapDef } from '../../../../../shared/maps/types.ts';
import { valueNoise2 } from '../../../../../shared/math.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import { waterY, type Quality } from '../../../contracts.ts';
import { hashVox } from '../../../voxel/voxel.ts';
import { BaseBiome, SIDE, SURF, clamp01, h01, jit, mix, mosaic, pick, shade, strata } from '../biome.ts';
import type { Cell, SideOut } from '../field.ts';
import type { BackdropRule } from '../flora.ts';
import type { MapBiome, PoolDef } from './index.ts';

const GRANITE = [0x8a8a90, 0x7e7e85, 0x96969c, 0x74747b];
const QUAY_STONE = [0x5e5e66, 0x55555d, 0x68686f, 0x4d4d55, 0x62625a];
const BRICK = [0x7a3b2a, 0x6e3424, 0x84422e, 0x733826, 0x8c4a32];
const SLIME = [0x3a4a2e, 0x34442a, 0x445436];
const WALLS = [
  [0x7a3b2a, 0x6e3424, 0x84422e, 0x733826], // red brick
  [0x4e3a34, 0x5a443c, 0x463430, 0x54403a], // soot brick
  [0xb8ae98, 0xa89e88, 0xc2b8a2, 0x9e9480], // plaster
  [0x6a6a70, 0x5e5e64, 0x74747a, 0x585860], // stone
  [0x3e4e5a, 0x465866, 0x384650, 0x4e606e], // blue clapboard
];
const ROOFS = [
  [0x3a3e48, 0x444955, 0x32363f],
  [0x7a3222, 0x8a3a2a, 0x6e2c1e],
  [0x2e2e32, 0x36363a, 0x2a2a2e],
  [0x3e4a3a, 0x465442, 0x36422f],
];

export interface Bld {
  h: number; // eave height above the base
  ridge: number; // extra gable height
  alongX: boolean;
  style: number;
  roof: number;
  // footprint (world)
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export class CogwaterBiome extends BaseBiome implements MapBiome {
  private readonly zone = { z: 0, t: 0 };
  readonly sparkle = 0;
  readonly farColor: number = 0x24242a;
  readonly farY: number;
  private readonly cobble: number[];
  private readonly quayZ: number;
  /** fixed backdrop water level (held by the lock gates) */
  readonly fixedWaterY: number;
  readonly backwaterHoleZ: number;
  private bld: Bld | null = null;

  constructor(map: MapDef, config: MatchConfig) {
    super(map, config);
    this.farY = this.T;
    this.bankDrop = 0;
    this.wallW = 0.06;
    this.cobble = byLum(map.terrain.grass);
    this.quayZ = this.halfD + 6.5;
    this.fixedWaterY = waterY(map, 1) - 0.03;
    this.backwaterHoleZ = this.halfD - 1;
  }

  /** Distance outside the play rectangle united with the fountain plazas. */
  private od(x: number, z: number): number {
    return Math.min(this.outside(x, z), this.plazaDist(x, z));
  }

  /** Building at (x,z), or null. Lots on a grid with streets between. */
  protected building(x: number, z: number): Bld | null {
    const T = this.T;
    const ax = Math.abs(x);
    const sideZone = ax > this.halfW && this.od(x, z) > 5.6;
    const farZone = z < -this.halfD - 4.6 && ax > 9.6;
    if (!sideZone && !farZone) return null;
    if (z > this.halfD + 1.5) return null;
    // lots: 10 m along x, 8 m along z, 2.6 m streets
    const LX = 10;
    const LZ = 8;
    const gx = Math.floor((x + 1000) / LX);
    const gz = Math.floor((z + 1000) / LZ);
    const lx = x + 1000 - gx * LX;
    const lz = z + 1000 - gz * LZ;
    const sx = 1.3 + hashVox(gx, gz, 0, 120) * 0.5;
    const sz = 1.3 + hashVox(gx, gz, 1, 121) * 0.5;
    if (lx < sx || lx > LX - sx * 0.6 || lz < sz || lz > LZ - sz * 0.6) return null;
    if (hashVox(gx, gz, 2, 122) < 0.08) return null; // empty lot / yard
    const dist = Math.max(this.outside(x, z), 0);
    const b: Bld = {
      h: 5.2 + hashVox(gx, gz, 3, 123) * 4.5 + Math.min(6, dist * 0.12),
      ridge: hashVox(gx, gz, 4, 124) < 0.7 ? 1.4 + hashVox(gx, gz, 5, 125) * 1.4 : 0,
      alongX: hashVox(gx, gz, 6, 126) < 0.5,
      style: Math.floor(hashVox(gx, gz, 7, 127) * WALLS.length),
      roof: Math.floor(hashVox(gx, gz, 8, 128) * ROOFS.length),
      x0: gx * LX - 1000 + sx,
      x1: gx * LX - 1000 + LX - sx * 0.6,
      z0: gz * LZ - 1000 + sz,
      z1: gz * LZ - 1000 + LZ - sz * 0.6,
    };
    void T;
    return b;
  }

  sample(x: number, z: number, ix: number, iz: number, cs: number, out: Cell): void {
    const tr = this.map.terrain;
    const fine = cs < 0.5;
    const T = this.T;
    const o = this.outside(x, z);
    const pd = this.plazaDist(x, z);
    const od = this.od(x, z);
    const c = this.channel(x, z);
    let h = T;
    let surf: number = SURF.LAND;
    let side: number = SIDE.STONE;
    let tag = 0;
    let harbour = false;
    const b = this.building(x, z);
    this.bld = b;
    if (pd < 0) {
      surf = pd > -0.3 ? SURF.KERB : SURF.PLAZA;
      if (surf === SURF.KERB) h = T + 0.0625;
    } else if (b) {
      // warehouse: walls up to the eaves, then a stepped gable
      const w = b.alongX ? (b.z1 - b.z0) / 2 : (b.x1 - b.x0) / 2;
      const d = b.alongX ? Math.abs(z - (b.z0 + b.z1) / 2) : Math.abs(x - (b.x0 + b.x1) / 2);
      h = T + b.h + b.ridge * clamp01(1 - d / w);
      surf = SURF.ROOF;
      side = SIDE.BUILDING;
      tag = b.style | (b.roof << 4);
    } else if (z > this.quayZ && Math.abs(x) < 70 && !this.pier(x, z)) {
      harbour = true;
    } else if (Math.abs(x) > this.halfW && od > 0.4 && od < 1.15 && z < this.quayZ) {
      // harbour wall
      h = T + 1.75;
      surf = SURF.COPING;
      side = SIDE.BRICK;
    } else if (o > 0) {
      surf = SURF.STREET;
    }
    const zn = this.zone;
    if (harbour) {
      h = this.B - 1.6 + (valueNoise2(x * 0.1, z * 0.1, 140) - 0.5) * 0.6;
      surf = SURF.SEABED;
      side = SIDE.STONE;
      zn.z = 3;
    } else if (surf !== SURF.ROOF && surf !== SURF.COPING) {
      const land = h;
      h = this.profile(c, land, zn);
      if (zn.z >= 2) {
        surf = zn.z === 2 ? SURF.WALL : SURF.BED;
        side = SIDE.STONE;
        if (zn.z === 3) h += this.bedNoise(x, z) * 0.4;
      } else if (c > -0.6 && surf !== SURF.PLAZA && surf !== SURF.KERB) {
        surf = SURF.BANK; // granite coping
        h = T + 0.0625;
      }
    }
    out.h = h;
    out.q = surf === SURF.ROOF || surf === SURF.COPING || surf === SURF.WALL ? 0.25 : !fine ? 0.5 : 1 / 16;
    out.side = side;
    out.tag = tag;
    let col: number;
    let rough = 0.85;
    switch (surf) {
      case SURF.PLAZA: {
        // herringbone brick rings
        const f = x < 0 ? this.fountains[0] : this.fountains[1];
        const r = Math.hypot(x - f.x, z - f.z);
        const hb = (ix + (iz >> 1)) & 3;
        col = BRICK[(hb + (iz & 1) * 2) % BRICK.length];
        col = jit(col, ix, iz, 0.06);
        if (Math.floor(r / 1.3) % 2 === 1) col = shade(col, 0.88);
        if (r < 1.8) col = pick(GRANITE, ix, iz, 30);
        rough = 0.55;
        break;
      }
      case SURF.KERB:
      case SURF.BANK:
      case SURF.COPING:
        col = jit(pick(GRANITE, ix >> 1, iz >> 1, 31), ix, iz, 0.04);
        if ((ix & 7) === 0 || (iz & 7) === 0) col = shade(col, 0.82);
        rough = 0.5;
        break;
      case SURF.WALL:
        col = pick(QUAY_STONE, ix, iz, 32);
        rough = 0.6;
        break;
      case SURF.BED:
        if (this.dry) {
          col = mosaic(byLum(tr.dryBed), valueNoise2(x * 0.3, z * 0.3, 33), ix, iz, 34, 0.08, 0.15);
          if (h01(ix, iz, 35) < 0.03) col = 0x6a5a4a; // junk
          rough = 0.7;
        } else {
          col = jit(pick(tr.bed, ix, iz, 36), ix, iz, 0.08);
          rough = 0.5;
        }
        break;
      case SURF.SEABED:
        col = jit(shade(tr.bed[0], 0.9), ix, iz, 0.08);
        rough = 0.5;
        break;
      case SURF.ROOF: {
        const pal = ROOFS[(tag >> 4) & 15];
        col = jit(pal[(iz + ix) % pal.length], ix, iz, 0.06);
        if (h01(ix, iz, 37) < 0.04) col = shade(col, 1.3); // moss / patch
        rough = 0.45;
        break;
      }
      default: {
        // cobbles with rain puddles
        const patch = valueNoise2(x * 0.09, z * 0.09, 38);
        col = mosaic(this.cobble, patch * 0.8 + 0.1, ix, iz, 13, 0.1, 0.18);
        if (((ix ^ iz) & 1) === 0) col = shade(col, 0.94);
        const pud = valueNoise2(x * 0.22, z * 0.22, 39) + valueNoise2(x * 0.8, z * 0.8, 40) * 0.25;
        if (pud < 0.3) {
          col = shade(mix(col, 0x2a3240, 0.25), 0.88);
          rough = 0.04;
        } else rough = 0.42;
        if (surf === SURF.STREET && (ix & 15) === 0) col = shade(col, 0.75); // gutter
      }
    }
    out.top = col;
    out.rough = rough;
    out.sparkle = 0;
  }

  private pier(x: number, z: number): boolean {
    const ax = Math.abs(x);
    if (ax > 16 && ax < 19.5 && z < this.quayZ + 15) return true;
    if (ax > 44 && ax < 48 && z < this.quayZ + 11) return true;
    return false;
  }

  sideColor(side: number, tag: number, ix: number, iy: number, iz: number, dir: number, y0: number, y1: number, top: number, cs: number, out: SideOut): void {
    out.emit = 0;
    out.rough = 0.7;
    const depth = top - y1;
    switch (side) {
      case SIDE.BRICK: {
        // harbour wall: brick courses in two bands per column, granite coping on top
        let c = BRICK[(ix * 3 + iz * 5 + (iy >> 2)) % BRICK.length];
        c = shade(c, 0.9 + hashVox(ix, iy >> 2, iz, 150) * 0.16);
        if (depth < 0.3) c = pick(GRANITE, ix, iz, 151);
        out.color = c;
        out.rough = 0.6;
        return;
      }
      case SIDE.BUILDING: {
        const style = tag & 15;
        const pal = WALLS[style % WALLS.length];
        const along = dir < 2 ? iz : ix;
        const T = this.T;
        const yMid = (y0 + y1) * 0.5 - T;
        const fine = cs < 0.5;
        const flH = fine ? 2.75 : 3;
        const fl = Math.floor(yMid / flH);
        const fy = yMid - fl * flH;
        // wall tone is constant per column and floor so runs merge into tall quads
        let c = pal[Math.floor(hashVox(along >> 1, fl, tag, 152) * pal.length) % pal.length];
        c = shade(c, 0.92 + hashVox(along, fl, tag, 153) * 0.12);
        if (depth < 0.3 && yMid > 1) {
          out.color = shade(pal[0], 0.7); // eave / cornice
          return;
        }
        let win = false;
        let lit = false;
        if (fine) {
          const col = ((along % 6) + 6) % 6;
          if (fl === 0) {
            win = col >= 1 && col <= 3 && fy > 0.5 && fy < 2.1;
            lit = hashVox(Math.floor(along / 6), fl, tag, 154) < 0.6;
          } else {
            win = (col === 2 || col === 3) && fy > 0.9 && fy < 2.1;
            lit = hashVox(Math.floor(along / 6), fl, tag + ix * 3 + iz, 155) < 0.42;
          }
          if (fy < 0.26 && fl > 0) c = shade(c, 0.8); // floor band
        } else {
          win = ((along % 2) + 2) % 2 === 0 && fy > 0.9 && fy < 2.1 && yMid > 0.5;
          lit = hashVox(along, fl, tag, 156) < 0.45;
        }
        if (win && yMid < top - T - 0.6) {
          out.color = lit ? (hashVox(along >> 1, fl, 3, 157) < 0.5 ? 0xffc870 : 0xffb050) : 0x232c38;
          out.emit = lit ? 1.6 : 0;
          out.rough = 0.12;
          return;
        }
        out.color = c;
        out.rough = 0.75;
        return;
      }
      default: {
        // cut granite quay blocks; slimy and dark near and below the water line
        const course = iy;
        const block = Math.floor(((dir < 2 ? iz : ix) + (course & 1) * 2) / 4);
        let c = QUAY_STONE[Math.floor(hashVox(block, course, 0, 157) * QUAY_STONE.length)];
        c = shade(c, 0.92 + hashVox(ix, iy, iz, 158) * 0.12);
        const y = (y0 + y1) * 0.5;
        if (y < this.fullY + 0.2 && y > this.fullY - 0.6) c = mix(c, pick(SLIME, ix, iz, 159), 0.5);
        if (y < this.fullY - 0.6) c = shade(c, 0.75);
        if (depth < 0.1) c = pick(GRANITE, ix, iz, 160);
        out.color = c;
        out.rough = 0.55;
      }
    }
  }

  backdrop(): BackdropRule[] {
    const street = (x: number, z: number) => {
      const od = this.od(x, z);
      return Math.abs(x) > this.halfW && od > 1.4 && od < 5 && z < this.quayZ - 0.5 && !this.building(x, z) ? 1 : 0;
    };
    const farQuay = (x: number, z: number) => {
      const ax = Math.abs(x);
      return z < -this.halfD - 1 && ax > 5.6 && ax < 9.2 ? 1 : 0;
    };
    const roofs = (x: number, z: number) => {
      const b = this.building(x, z);
      if (!b) return 0;
      const cx = (b.x0 + b.x1) / 2;
      const cz = (b.z0 + b.z1) / 2;
      return Math.abs(x - cx) < 1.2 && Math.abs(z - cz) < 1.2 ? 0 : 0.08;
    };
    const quayEdge = (x: number, z: number) => (Math.abs(z - this.quayZ - 0.6) < 0.4 && Math.abs(x) > 6 && Math.abs(x) < 70 && !this.pier(x, z + 1.2) ? 1 : 0);
    const harbour = (x: number, z: number) => (z > this.quayZ + 3 && Math.abs(x) < 60 && !this.pier(x, z) && this.height0(x, z) < this.fixedWaterY - 1 ? 1 : 0);
    return [
      { model: 'lamp', spacing: 7, scale: [1, 1], density: (x, z) => street(x, z) * 0.35 + farQuay(x, z) * 0.4 + quayEdge(x, z) * 0.18, castShadow: true },
      { model: 'crate', spacing: 3.2, scale: [0.8, 1.2], density: (x, z) => street(x, z) * 0.12 + farQuay(x, z) * 0.15 + quayEdge(x, z) * 0.1 },
      { model: 'barrel', spacing: 2.8, scale: [0.85, 1.15], density: (x, z) => street(x, z) * 0.12 + farQuay(x, z) * 0.12 + quayEdge(x, z) * 0.1 },
      { model: 'bollard', spacing: 2.6, scale: [1, 1.2], density: (x, z) => quayEdge(x, z) * 0.55 + farQuay(x, z) * 0.12 },
      { model: 'chimney', spacing: 3.4, scale: [0.9, 1.3], density: roofs, yOffset: -0.1 },
      { model: 'crane', spacing: 9, scale: [0.9, 1.1], density: (x, z) => (this.pier(x, z) && z > this.quayZ + 9 && Math.abs(Math.abs(x) - 17.75) < 0.6 ? 0.8 : 0) },
      { model: 'crane', spacing: 16, scale: [0.9, 1.15], density: (x, z) => (z < -this.halfD - 6 && Math.abs(Math.abs(x) - 7.6) < 0.7 ? 0.6 : 0), yaw: (x) => (x < 0 ? 0 : Math.PI) },
      { model: 'boat', spacing: 9, scale: [0.85, 1.25], density: (x, z) => harbour(x, z) * 0.22, onWater: true, yOffset: -0.25 },
    ];
  }

  /** Unquantised height probe used for placement rules. */
  private height0(x: number, z: number): number {
    const c = { h: 0, q: 1, top: 0, rough: 0, sparkle: 0, side: 0, tag: 0 };
    this.sample(x, z, 0, 0, 1, c);
    return c.h;
  }

  /** Roof height under (x,z), or NaN. Used by placement of chimneys. */
  roofAt(x: number, z: number): number {
    const b = this.building(x, z);
    return b ? this.T + b.h : NaN;
  }

  details(q: Quality): BackdropRule[] {
    if (q === 'low') return [];
    const rich = q === 'high' || q === 'ultra';
    const inPlay = (x: number, z: number) => Math.abs(x) < this.halfW - 0.3 && Math.abs(z) < this.halfD - 0.3 && this.plazaDist(x, z) > 0.3;
    return [
      { model: 'cobbles', spacing: rich ? 2.2 : 3.2, scale: [0.7, 1.2], density: (x, z) => (inPlay(x, z) && this.channel(x, z) < -0.8 ? 0.25 : 0) },
      { model: 'pebble', spacing: rich ? 1.4 : 2.2, scale: [0.8, 1.4], density: (x, z) => (inPlay(x, z) && this.channel(x, z) > 0.8 ? (this.dry ? 0.5 : 0.25) : 0), underwater: true },
    ];
  }

  extraDecor(): Decor[] {
    if (!this.dry) return [];
    const inBed = (x: number, z: number) => this.channel(x, z) > 1.2 && Math.abs(z) < this.halfD - 2;
    return [
      ...scatter(this.map, { kind: 'gear', count: 14, seed: 931, scale: [0.7, 1.2], accept: inBed }),
      ...scatter(this.map, { kind: 'pebbles', count: 24, seed: 932, scale: [0.8, 1.3], accept: inBed }),
      ...scatter(this.map, { kind: 'rope', count: 6, seed: 933, scale: [0.8, 1.1], accept: inBed }),
      ...scatter(this.map, { kind: 'bones', count: 4, seed: 934, scale: [0.7, 1.0], accept: inBed }),
    ];
  }

  backwaterKeep(): boolean {
    return true;
  }

  pools(): PoolDef[] {
    return [];
  }
}

function byLum(p: readonly number[]): number[] {
  const l = (c: number) => ((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11;
  return [...p].sort((a, b) => l(a) - l(b));
}
