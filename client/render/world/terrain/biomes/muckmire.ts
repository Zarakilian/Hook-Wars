// Muckmire Bayou: mossy grass banks, mud channel, flagstone plazas, dense cypress jungle on the
// sides and far end, and a reedy swamp the river spills into past the near edge.
import type { Decor, MapDef } from '../../../../../shared/maps/types.ts';
import { scatter } from '../../../../../shared/maps/helpers.ts';
import type { Quality } from '../../../contracts.ts';
import type { MapBiome, PoolDef } from './index.ts';
import { fbm2, valueNoise2 } from '../../../../../shared/math.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import { hashVox } from '../../../voxel/voxel.ts';
import { BaseBiome, SIDE, SURF, clamp01, h01, jit, mix, mosaic, pathSegs, pick, shade, soilSide, sstep, strata } from '../biome.ts';
import type { Cell, SideOut } from '../field.ts';
import type { BackdropRule } from '../flora.ts';

const LITTER = [0x5a4a2a, 0x64532e, 0x4e4224, 0x46401f];
const MOSS = [0x3f5f22, 0x4a6b26, 0x355019];
const FLAG = [0x6f6d5f, 0x7b796a, 0x646354, 0x858270, 0x5c5b4e];
const MUD = [0x2f2a1d, 0x372f20, 0x2a251a];

export class MuckmireBiome extends BaseBiome implements MapBiome {
  private readonly zone = { z: 0, t: 0 };
  readonly sparkle = 0;
  readonly farColor = 0x2a3a1c;
  readonly farY: number;
  private readonly grassSorted: number[];
  private readonly dirtSorted: number[];

  constructor(map: MapDef, config: MatchConfig) {
    super(map, config);
    this.farY = this.T + 0.4;
    this.grassSorted = byLum(map.terrain.grass);
    this.dirtSorted = byLum(map.terrain.dirt);
    this.bankDrop = 0.18;
    this.wallW = 1.8;
    this.paths = pathSegs(
      [
        [-25.6, 1.2, -21, 2.6, -15.5, 4.6, -11, 6.2, -6.6, 6.8],
        [-26.6, -3.6, -21, -7.6, -15.5, -9.6, -10.5, -10.4, -7.4, -10.6],
        [-26.2, 4.6, -22.4, 8.6, -19.4, 14.2, -14.6, 16.6, -10.4, 17.6],
      ],
      0.75,
    );
  }

  /** Terrain channel: the sim channel inside, widening into the swamp past the near edge. */
  override channel(x: number, z: number): number {
    let c = super.channel(x, z);
    if (z > 25) c += (z - 25) * 0.45 + (valueNoise2(x * 0.2, z * 0.2, 31) - 0.5) * Math.min(1, (z - 25) / 4) * 3;
    return c;
  }

  sample(x: number, z: number, ix: number, iz: number, cs: number, out: Cell): void {
    const tr = this.map.terrain;
    const fine = cs < 0.5;
    const o = this.outside(x, z);
    const pd = this.plazaDist(x, z);
    const c = this.channel(x, z);
    const T = this.T;
    // ---- land height (before the river cut)
    let land = T + this.landNoise(x, z);
    let surf: number = SURF.LAND;
    let swamp = 0;
    if (o > 0 && pd > 0.6) {
      // near edge: the bank sinks into a reedy swamp; sides and far end: jungle floor
      swamp = z > this.halfD ? sstep(0.3, 6, z - this.halfD) : 0;
      const jungle = sstep(0.2, 3.2, o) * (1 - swamp);
      if (jungle > 0) {
        const hum = fbm2(x * 0.2, z * 0.2, 2, 41);
        const hills = Math.max(0, (fbm2(x * 0.035, z * 0.035, 3, 42) - 0.35) * 5 * sstep(6, 30, o));
        land += jungle * (0.3 + (hum - 0.45) * 0.55 + hills);
        surf = SURF.FLOOR;
      }
      if (swamp > 0) {
        const lvl = this.fullY + 0.08 + (fbm2(x * 0.16, z * 0.16, 3, 43) - 0.52) * 1.3;
        land += (lvl - land) * swamp;
        if (h01(ix, iz, 47) < swamp * 1.6 - 0.2) surf = SURF.FLOOR;
      }
    }
    // ---- plaza and paths (play area only)
    let path = 0;
    if (pd < 0) {
      land = T;
      surf = pd > -0.3 ? SURF.KERB : SURF.PLAZA;
      if (surf === SURF.KERB) land = T + 0.0625;
    } else if (o < 0 && fine) {
      path = this.pathAmount(x, z);
      if (path > 0) land -= 0.05 * sstep(0, 0.6, path);
    }
    // ---- river cut
    const zn = this.zone;
    let h = this.profile(c, land, zn, x, z);
    if (zn.z >= 2) {
      surf = zn.z === 2 ? SURF.WALL : SURF.BED;
      h += zn.z === 3 ? this.bedNoise(x, z) : 0;
      if (this.dry && zn.z === 3 && fine) {
        const cr = this.voronoi(x, z, 1.1);
        h += cr < 0.075 ? -0.07 : Math.min(0.04, cr * 0.1);
      }
    } else if (zn.z === 1 && surf !== SURF.PLAZA && surf !== SURF.KERB) {
      surf = this.nearIsland(x, z) && c > -this.bankW ? SURF.ISLAND : SURF.BANK;
    }
    if (swamp > 0.5 && h < this.fullY - 0.02) {
      // pool floors in the swamp
      h = Math.max(h, this.B + 0.55 + (valueNoise2(x * 0.3, z * 0.3, 44) - 0.5) * 0.3);
      surf = SURF.SEABED;
    }
    out.h = h;
    out.q = surf === SURF.WALL ? 0.25 : !fine ? 0.5 : surf === SURF.FLOOR || surf === SURF.SEABED ? 0.125 : 1 / 16;
    out.side = surf === SURF.WALL || surf === SURF.BED || surf === SURF.BANK || surf === SURF.ISLAND || surf === SURF.SEABED ? SIDE.BANK : surf === SURF.KERB || surf === SURF.PLAZA ? SIDE.STONE : SIDE.SOIL;
    out.tag = 0;
    out.sparkle = 0;
    // ---- colour
    let col: number;
    let rough = 0.95;
    switch (surf) {
      case SURF.PLAZA: {
        col = this.flagstone(x, z, ix, iz);
        rough = 0.8;
        break;
      }
      case SURF.KERB:
        col = jit(pick(FLAG, ix, iz, 7), ix, iz, 0.08);
        col = shade(col, 1.12);
        rough = 0.75;
        break;
      case SURF.BANK: {
        const t = zn.t;
        const g = h01(ix, iz, 21);
        if (g > t * t * 1.5 - 0.1) col = mosaic(this.grassSorted, 0.35 - t * 0.2, ix, iz, 1, 0.06, 0.1);
        else col = shade(pick(tr.bank, ix, iz, 2), 1 - t * 0.22);
        if (h01(ix, iz, 22) < 0.035) col = pick(MOSS, ix, iz, 3);
        rough = 0.92 - t * 0.2;
        break;
      }
      case SURF.ISLAND: {
        const t = zn.t;
        col = h01(ix, iz, 23) > 0.55 + t * 0.4 ? shade(pick(tr.grass, ix, iz, 4), 0.78) : shade(pick(tr.bank, ix, iz, 5), 0.95 - t * 0.2);
        rough = 0.85;
        break;
      }
      case SURF.WALL:
        col = shade(mix(pick(tr.bank, ix, iz, 6), pick(tr.dirt, ix, iz, 7), 0.4), 0.95 - zn.t * 0.15);
        if (h01(ix, iz, 24) < 0.05) col = 0x3a2a18; // root ends
        rough = 0.9;
        break;
      case SURF.BED:
        col = this.bedColor(x, z, ix, iz, zn.t);
        rough = this.dry ? 0.97 : 0.6;
        break;
      case SURF.FLOOR: {
        if (!fine) {
          const n1 = valueNoise2(x * 0.11, z * 0.11, 48);
          col = jit(mix(shade(tr.grass[2], 0.62), LITTER[3], n1 * 0.7), ix, iz, 0.06);
          rough = 0.97;
          break;
        }
        const r = h01(ix, iz, 25);
        if (r < 0.5) col = shade(pick(tr.grass, ix, iz, 8), 0.7);
        else if (r < 0.7) col = pick(LITTER, ix, iz, 9);
        else if (r < 0.8) col = shade(pick(tr.dirt, ix, iz, 10), 0.72);
        else col = pick(MOSS, ix, iz, 11);
        col = shade(col, 0.8 + valueNoise2(x * 0.2, z * 0.2, 45) * 0.3);
        rough = 0.97;
        break;
      }
      case SURF.SEABED:
        col = jit(pick(MUD, ix, iz, 12), ix, iz, 0.1);
        rough = 0.5;
        break;
      default: {
        // grass: soft mosaic of the map palette, darker clumps, dry and mossy flecks
        const patch = valueNoise2(x * 0.07, z * 0.07, 46) * 0.7 + valueNoise2(x * 0.31, z * 0.31, 49) * 0.3;
        col = mosaic(this.grassSorted, patch, ix, iz, 13, 0.06, 0.12);
        const r = h01(ix, iz, 26);
        if (r < 0.02) col = pick(tr.dirt, ix, iz, 14);
        else if (r < 0.05) col = mix(col, 0x9a9a44, 0.45);
        else if (r < 0.065) col = pick(MOSS, ix, iz, 15);
        if (path > 0.2) {
          const p = (path - 0.2) / 0.5;
          if (h01(ix, iz, 27) < p) col = mosaic(this.dirtSorted, valueNoise2(x * 0.5, z * 0.5, 50), ix, iz, 16, 0.07, 0.15);
        }
      }
    }
    out.top = col;
    out.rough = rough;
  }

  private flagstone(x: number, z: number, ix: number, iz: number): number {
    // running bond of 0.75 x 0.5 m stones with dark grout lines
    const row = Math.floor(z / 0.5);
    const off = hashVox(0, row, 0, 61) * 0.75;
    const col = Math.floor((x + off) / 0.75);
    const fx = (x + off) / 0.75 - col;
    const fz = z / 0.5 - row;
    const stone = FLAG[Math.floor(hashVox(col, row, 0, 62) * FLAG.length)];
    let c = shade(stone, 0.92 + hashVox(col, row, 1, 63) * 0.18);
    if (fx < 0.2 || fz < 0.3) c = shade(c, 0.72);
    if (h01(ix, iz, 28) < 0.12) c = mix(c, MOSS[0], 0.55);
    const ring = Math.hypot(x - (x < 0 ? -32 : 32), z);
    if (ring < 1.6) c = shade(c, 1.08);
    return c;
  }

  private bedColor(x: number, z: number, ix: number, iz: number, t: number): number {
    const tr = this.map.terrain;
    if (this.dry) {
      // cracked mud plates: each plate its own tone, dark cracks between
      const cr = this.voronoi(x, z, 1.1);
      const pid = this.cellId;
      let c = tr.dryBed[Math.floor(hashVox(pid, 3, 0, 64) * tr.dryBed.length) % tr.dryBed.length];
      c = shade(c, 0.92 + hashVox(pid, 4, 0, 65) * 0.16 + (cr - 0.25) * 0.25);
      c = jit(c, ix, iz, 0.035);
      if (cr < 0.075) c = shade(c, 0.42);
      else if (h01(ix, iz, 29) < 0.025) c = 0x8a8478; // pebble
      return c;
    }
    let c = jit(pick(tr.bed, ix, iz, 18), ix, iz, 0.08);
    c = shade(c, 1 - t * 0.15);
    if (h01(ix, iz, 30) < 0.04) c = 0x5d5848;
    return c;
  }

  sideColor(side: number, _tag: number, ix: number, iy: number, iz: number, _dir: number, _y0: number, y1: number, top: number, _cs: number, out: SideOut): void {
    const tr = this.map.terrain;
    out.emit = 0;
    out.rough = 0.95;
    switch (side) {
      case SIDE.SOIL:
        soilSide(tr.grass, tr.dirt, ix, iy, iz, y1, top, out);
        return;
      case SIDE.STONE:
        out.color = strata(FLAG, ix, iy, iz, 70, 0.06);
        out.rough = 0.8;
        return;
      default: {
        // bank / channel mud with roots near the top
        const depth = clamp01((top - y1) / 2.2);
        let c = strata(tr.bank, ix, iy, iz, 71, 0.1);
        if (hashVox(ix, iy, iz, 72) < 0.08 && top - y1 < 0.8) c = 0x3a2a18;
        out.color = shade(c, 1.0 - depth * 0.18);
        out.rough = 0.9;
      }
    }
  }

  backdrop(): BackdropRule[] {
    const jungle = (x: number, z: number) => {
      const o = this.outside(x, z);
      if (o < 1.4 || this.plazaDist(x, z) < 1.2) return 0;
      if (z > this.halfD && Math.abs(x) < this.halfW + 6) return 0;
      if (this.channel(x, z) > -1.2) return 0;
      return 1;
    };
    const swampTrees = (x: number, z: number) => (z > this.halfD + 8 && this.channel(x, z) < 2.5 ? 0.55 : 0);
    const edge = (x: number, z: number) => {
      const o = this.outside(x, z);
      if (o < 0.25 || o > 3 || this.plazaDist(x, z) < 0.6 || this.channel(x, z) > -0.8) return 0;
      if (z > this.halfD && Math.abs(x) < this.halfW + 4) return 0.25;
      return 1;
    };
    const reedy = (x: number, z: number) => {
      if (z < this.halfD + 0.5) return 0;
      const c = this.channel(x, z);
      return c > -2 && c < 3 ? 0.9 : 0;
    };
    return [
      { model: 'cypress', spacing: 3.8, scale: [1.0, 1.4], density: (x, z) => jungle(x, z) * (this.outside(x, z) < 16 ? 1 : 0), castShadow: true },
      { model: 'swampoak', spacing: 5.8, scale: [1.0, 1.4], density: (x, z) => jungle(x, z) * (this.outside(x, z) >= 9 ? 0.9 : 0.25) },
      { model: 'cypress', spacing: 4.6, scale: [0.85, 1.2], density: swampTrees, waterline: true },
      { model: 'snag', spacing: 7, scale: [0.8, 1.2], density: (x, z) => swampTrees(x, z) * 0.6 + jungle(x, z) * 0.12, waterline: true },
      { model: 'bush', spacing: 1.7, scale: [0.7, 1.25], density: (x, z) => edge(x, z) * 0.75 },
      { model: 'fern', spacing: 1.3, scale: [0.7, 1.2], density: (x, z) => edge(x, z) * 0.6 + jungle(x, z) * 0.25 },
      { model: 'mossrock', spacing: 2.4, scale: [0.6, 1.25], density: (x, z) => (edge(x, z) > 0.5 ? 0.55 : 0) },
      { model: 'log', spacing: 7, scale: [0.8, 1.2], density: (x, z) => edge(x, z) * 0.35 },
      { model: 'reeds', spacing: 1.3, scale: [0.8, 1.4], density: reedy, underwater: true },
      { model: 'lilypads', spacing: 2.4, scale: [0.8, 1.3], density: (x, z) => (z > this.halfD + 1 && this.channel(x, z) > 0.5 ? 0.6 : 0), onWater: true },
    ];
  }

  details(q: Quality): BackdropRule[] {
    if (q === 'low') return [];
    const rich = q === 'high' || q === 'ultra';
    const inPlay = (x: number, z: number) => Math.abs(x) < this.halfW - 0.3 && Math.abs(z) < this.halfD - 0.3 && this.plazaDist(x, z) > 0.3;
    return [
      { model: 'pebble', spacing: rich ? 1.1 : 1.6, scale: [0.7, 1.3], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -this.bankW && c < 0.1 ? 0.5 : 0; } },
      { model: 'root', spacing: rich ? 1.5 : 2.4, scale: [0.7, 1.2], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -0.6 && c < 0.15 && !this.nearIsland(x, z) ? 0.55 : 0; }, yaw: (x, z) => this.faceRiver(x, z) },
      { model: 'pebble', spacing: rich ? 1.4 : 2.2, scale: [0.8, 1.5], density: (x, z) => (inPlay(x, z) && this.channel(x, z) > 2.2 ? (this.dry ? 0.55 : 0.3) : 0), underwater: true },
    ];
  }

  /** Yaw that points a model's +X toward the river centre. */
  faceRiver(x: number, z: number): number {
    const g = (this.channel(x + 0.1, z) - this.channel(x - 0.1, z)) * 5;
    const gz = (this.channel(x, z + 0.1) - this.channel(x, z - 0.1)) * 5;
    return Math.atan2(-gz, g);
  }

  extraDecor(): Decor[] {
    if (!this.dry) return [];
    const m = this.map;
    const inBed = (x: number, z: number) => this.channel(x, z) > 1.6 && Math.abs(z) < this.halfD - 0.5;
    return [
      ...scatter(m, { kind: 'pebbles', count: 40, seed: 901, scale: [0.7, 1.3], accept: inBed }),
      ...scatter(m, { kind: 'bones', count: 5, seed: 902, scale: [0.8, 1.1], accept: inBed }),
      ...scatter(m, { kind: 'mushroom', count: 10, seed: 903, scale: [0.6, 1.0], accept: (x, z) => { const c = this.channel(x, z); return c > 0.4 && c < 1.4; } }),
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
