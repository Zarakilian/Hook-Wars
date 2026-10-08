// Aurora Harbour: sparkling snow banks, icy gravel shores and frost-stone plazas round a frozen fjord
// harbour. Past the far edge the harbour opens wide, full of glowing ice floes, up to a far shore of
// icicle-hung cliffs with a lantern-lit village of log cabins on its terraces and jagged peaks behind
// under the aurora. Snowy cliffs with timber piers and cranes close in on the sides, and past the near
// edge the harbour runs out to open water with icebergs. The harbour freezes with the river on Tidal.
import { riverAt, scatter } from '../../../../../shared/maps/helpers.ts';
import type { Decor, MapDef } from '../../../../../shared/maps/types.ts';
import { fbm2, valueNoise2 } from '../../../../../shared/math.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import type { Quality } from '../../../contracts.ts';
import { hashVox } from '../../../voxel/voxel.ts';
import { BaseBiome, SIDE, SURF, clamp01, h01, jit, mix, mosaic, pathSegs, pick, shade, sstep, strata } from '../biome.ts';
import type { Cell, SideOut } from '../field.ts';
import type { BackdropRule } from '../flora.ts';
import type { MistDef } from '../mist.ts';
import type { MapBiome, PoolDef } from './index.ts';

const GLACIER = [0x9ccbe6, 0x86b9da, 0xb4daee, 0x74a8cc, 0xc8e6f4];
const ROCK = [0x525c74, 0x465068, 0x5e6880, 0x3c465c, 0x58627a];
const FROST_TILE = [0x8796a8, 0x7a899c, 0x93a2b3, 0x6f7e91, 0x9eacbc];
const ICICLE = [0xd6ecf8, 0xc2e2f4, 0xe6f4fb, 0xaed8f0];

export class AuroraBiome extends BaseBiome implements MapBiome {
  private readonly zone = { z: 0, t: 0 };
  readonly sparkle = 1.25;
  readonly farColor = 0xc8d4e4;
  readonly farY: number;
  readonly mistColor = 0x9ab4d8;
  readonly lampLight = 1.0;
  private readonly snow: number[];

  constructor(map: MapDef, config: MatchConfig) {
    super(map, config);
    this.farY = this.T + 8;
    this.bankDrop = 0.16;
    this.wallW = 1.3;
    this.snow = byLum(map.terrain.grass);
    this.paths = pathSegs(
      [
        [-25.8, 1.4, -21, 2.6, -16.4, 3.4, -11.6, 3.6, -8.2, 4.2],
        [-26.4, -3.8, -21.6, -6.4, -16.4, -9.4, -12.2, -12.6, -9.0, -13.6],
        [-26.2, 4.8, -22.6, 9.6, -19.2, 15.6, -13.6, 18.4, -8.6, 20.0],
      ],
      0.7,
    );
  }

  /** The far shore of the harbour (z), ragged. */
  private farShore(x: number): number {
    return -this.halfD - 12 - valueNoise2(x * 0.07, 3, 501) * 4.5 - valueNoise2(x * 0.28, 4, 502) * 1.4 - Math.max(0, 16 - Math.abs(x)) * 0.25;
  }

  /** Ridged noise 0..1 for jagged peaks. */
  private ridged(x: number, z: number): number {
    const a = 1 - Math.abs(fbm2(x * 0.028, z * 0.028, 4, 510) * 2 - 1);
    const b = 1 - Math.abs(fbm2(x * 0.071 + 3, z * 0.071, 3, 511) * 2 - 1);
    return a * a * 0.75 + b * b * 0.25;
  }

  /** Cliff, terrace and peak height above the bank top (0 = none). */
  cliffs(x: number, z: number): number {
    let h = 0;
    // far shore: an icy cliff, two village terraces, then the peaks
    const dz = this.farShore(x) - z;
    if (dz > 0) {
      const ter = 4.6 + sstep(8.6, 10, dz) * 4.0 + sstep(16.6, 18, dz) * 3.4 + (valueNoise2(x * 0.15, z * 0.15, 512) - 0.5) * 0.4;
      const peaks = sstep(19, 42, dz) * (6 + this.ridged(x, z) * 32);
      h = Math.max(h, ter + peaks);
    }
    // sides: snowy cliffs behind the plazas, peaks further out
    const ax = Math.abs(x) - this.halfW;
    const start = 3.6 + valueNoise2(z * 0.2, 7, 513) * 2.2;
    if (ax > start && z < this.halfD + 2) {
      const s = 4.4 + (fbm2(x * 0.06, z * 0.06, 2, 514) - 0.5) * 1.8 + sstep(9, 30, ax) * 6 + sstep(24, 55, ax) * this.ridged(x, z) * 26;
      h = Math.max(h, s * sstep(start, start + 0.6, ax));
    }
    return h;
  }

  /** Terrain channel: the harbour opens out past the far edge and runs out to sea past the near edge. */
  override channel(x: number, z: number): number {
    let c = super.channel(x, z);
    const hd = this.halfD;
    if (z < -hd) {
      const d = -hd - z;
      const r = riverAt(this.map.river.points, -hd);
      const hw = r.hw + sstep(0, 6, d) * 30 + (valueNoise2(x * 0.1, z * 0.1, 515) - 0.5) * 5;
      c = Math.max(c, hw - Math.abs(x - r.x));
      c = Math.min(c, z - this.farShore(x));
    } else if (z > hd) {
      c += (z - hd) * 0.85 + (valueNoise2(x * 0.15, z * 0.15, 32) - 0.5) * Math.min(1, (z - hd) / 4) * 4;
    }
    return c;
  }

  sample(x: number, z: number, ix: number, iz: number, cs: number, out: Cell): void {
    const tr = this.map.terrain;
    const fine = cs < 0.5;
    const o = this.outside(x, z);
    const pd = this.plazaDist(x, z);
    const c = this.channel(x, z);
    const T = this.T;
    let land = T + this.landNoise(x, z);
    let surf: number = SURF.SNOW;
    let side: number = SIDE.SNOWROCK;
    let cliff = 0;
    if (o > 0 && pd > 0.6) {
      cliff = this.cliffs(x, z);
      if (cliff <= 0) {
        if (z > this.halfD) {
          const k = sstep(0.3, 6, z - this.halfD);
          land += (this.fullY + 0.14 - land) * k;
          land += (fbm2(x * 0.2, z * 0.2, 2, 54) - 0.5) * 0.45 * (1 - k * 0.6);
        } else {
          land += sstep(0.2, 2.6, o) * (0.35 + (fbm2(x * 0.22, z * 0.22, 2, 55) - 0.4) * 0.6);
        }
      }
    }
    let path = 0;
    if (pd < 0) {
      land = T;
      surf = pd > -0.3 ? SURF.KERB : SURF.PLAZA;
      if (surf === SURF.KERB) land = T + 0.0625;
      cliff = 0;
    } else if (o < 0 && fine) {
      path = this.pathAmount(x, z);
      if (path > 0) land -= 0.06 * sstep(0, 0.6, path);
    }
    const zn = this.zone;
    let h = land;
    if (cliff <= 0) {
      h = this.profile(c, land, zn, x, z);
      if (zn.z >= 2) {
        surf = zn.z === 2 ? SURF.WALL : SURF.BED;
        if (zn.z === 3) h += this.bedNoise(x, z);
        if (this.dry && zn.z === 3 && fine && h01(ix >> 1, iz >> 1, 71) < 0.08) h += 0.07;
      } else if (zn.z === 1 && surf !== SURF.PLAZA && surf !== SURF.KERB) surf = SURF.BANK;
      if (o > 1 && h < this.fullY - 0.05) {
        // harbour floor past the edges: deeper the further out
        h = Math.max(this.B - 1.4 - Math.min(2, o * 0.05), h - Math.min(2, o * 0.05));
        surf = SURF.SEABED;
      }
    } else {
      zn.z = 0;
      h = T + cliff;
      surf = cliff > 14 && h01(ix >> 2, iz >> 2, 516) < 0.35 ? SURF.ROCK : SURF.SNOW;
      // the waterline band of the cliffs is blue glacier ice, the rest snowy rock
      side = SIDE.ICE;
    }
    out.h = h;
    out.q = cliff > 0 ? (fine ? 0.25 : 0.5) : surf === SURF.WALL ? 0.25 : !fine ? 0.5 : 1 / 16;
    if (cliff <= 0) side = surf === SURF.WALL || surf === SURF.BED || surf === SURF.BANK || surf === SURF.SEABED ? SIDE.ROCK : surf === SURF.PLAZA || surf === SURF.KERB ? SIDE.STONE : SIDE.SNOWROCK;
    out.side = side;
    out.tag = 0;
    let col: number;
    let rough = 0.9;
    let spk = 0;
    switch (surf) {
      case SURF.PLAZA: {
        const f = x < 0 ? this.fountains[0] : this.fountains[1];
        const r = Math.hypot(x - f.x, z - f.z);
        const a = Math.atan2(z - f.z, x - f.x);
        const ring = Math.floor(r / 0.9);
        const seg = Math.floor(((a + Math.PI) / (Math.PI * 2)) * (8 + ring * 6));
        col = FROST_TILE[Math.floor(hashVox(ring, seg, 0, 81) * FROST_TILE.length)];
        col = shade(col, 0.95 + hashVox(ring, seg, 1, 82) * 0.12);
        if (r / 0.9 - ring < 0.22) col = shade(col, 0.72);
        if (h01(ix, iz, 83) < 0.2) col = mix(col, 0xe8f0f8, 0.6);
        if (r < 1.8) col = shade(col, 1.1);
        rough = 0.55;
        spk = 0.4;
        break;
      }
      case SURF.KERB:
        col = jit(0x5d6a7c, ix, iz, 0.08);
        if (h01(ix, iz, 84) < 0.5) col = mix(col, 0xeef4fa, 0.75);
        rough = 0.6;
        spk = 0.6;
        break;
      case SURF.BANK: {
        const t = zn.t;
        if (h01(ix, iz, 21) > t * 1.5 - 0.2) col = mosaic(this.snow, valueNoise2(x * 0.3, z * 0.3, 85), ix, iz, 1, 0.04, 0.08);
        else col = shade(pick(tr.bank, ix, iz, 2), 1 - t * 0.18);
        if (h01(ix, iz, 22) < 0.05) col = pick(ROCK, ix, iz, 3);
        rough = 0.5 - t * 0.2;
        spk = 0.6;
        break;
      }
      case SURF.WALL:
        col = shade(mix(pick(tr.bank, ix, iz, 6), pick(ROCK, ix, iz, 7), 0.5), 0.9 - zn.t * 0.15);
        if (h01(ix, iz, 24) < 0.22) col = mix(col, 0xcfe4f2, 0.55);
        rough = 0.35;
        break;
      case SURF.BED:
        if (this.dry) {
          col = jit(pick(tr.dryBed, ix, iz, 17), ix, iz, 0.08);
          if (h01(ix >> 1, iz >> 1, 71) < 0.08) col = shade(pick(ROCK, ix >> 1, iz >> 1, 72), 1.3);
          if (h01(ix, iz, 73) < 0.05) col = 0xdfe9f3;
          rough = 0.9;
        } else {
          col = shade(jit(pick(tr.bed, ix, iz, 18), ix, iz, 0.08), 1 - zn.t * 0.15);
          rough = 0.55;
        }
        break;
      case SURF.SEABED:
        col = jit(shade(tr.bed[1], 0.85), ix, iz, 0.08);
        rough = 0.5;
        break;
      case SURF.ROCK:
        col = jit(pick(ROCK, ix >> 1, iz >> 1, 30), ix, iz, 0.06);
        if (h01(ix, iz, 31) < 0.4) col = mosaic(this.snow, 0.5, ix, iz, 32, 0.03, 0.05);
        rough = 0.8;
        spk = 0.4;
        break;
      default: {
        const patch = valueNoise2(x * 0.08, z * 0.08, 46) * 0.7 + valueNoise2(x * 0.35, z * 0.35, 49) * 0.3;
        col = mosaic(this.snow, patch, ix, iz, 13, 0.035, 0.08);
        if (cliff > 0) col = shade(col, 0.96 + clamp01(cliff / 40) * 0.06);
        const r = h01(ix, iz, 26);
        if (r < 0.012) col = pick(ROCK, ix, iz, 14);
        else if (r < 0.03) col = mix(col, 0xa9c4dc, 0.45);
        if (path > 0.2) {
          const p = (path - 0.2) / 0.5;
          if (h01(ix, iz, 27) < p) col = mix(mosaic(byLum(tr.dirt), valueNoise2(x * 0.5, z * 0.5, 50), ix, iz, 16, 0.06, 0.12), 0xc6d3e2, 0.55);
        }
        rough = 0.75;
        spk = path > 0.4 ? 0 : 1;
      }
    }
    out.top = col;
    out.rough = rough;
    out.sparkle = spk;
  }

  sideColor(side: number, _tag: number, ix: number, iy: number, iz: number, _dir: number, y0: number, y1: number, top: number, _cs: number, out: SideOut): void {
    const tr = this.map.terrain;
    out.emit = 0;
    out.rough = 0.8;
    const depth = top - y1;
    switch (side) {
      case SIDE.ICE: {
        if (depth < 0.3 || top - y0 < 0.6) {
          out.color = shade(this.snow[3], 0.97);
          out.rough = 0.7;
          return;
        }
        // icicle curtains hang under every snowy lip
        if (depth < 1.4 && hashVox(ix, 0, iz, 520) < 0.55 - depth * 0.3) {
          out.color = pick(ICICLE, ix, iz + iy, 521);
          out.emit = 0.18;
          out.rough = 0.15;
          return;
        }
        const yy = (y0 + y1) * 0.5;
        if (yy < this.fullY + 3.2) {
          // glowing blue ice at the foot of the cliffs
          let c = strata(GLACIER, ix >> 1, iy >> 1, iz >> 1, 90, 0.05);
          if (hashVox(0, iy, 0, 91) < 0.18) c = mix(c, 0xeaf4fa, 0.6);
          if (hashVox(ix >> 2, 0, iz >> 2, 92) < 0.1) c = shade(c, 0.7);
          out.color = c;
          out.emit = 0.32;
          out.rough = 0.2;
          return;
        }
        let c = strata(ROCK, ix >> 1, iy >> 1, iz >> 1, 93, 0.08);
        if (hashVox(ix, iy, iz, 94) < 0.24) c = mix(c, 0xe6eef6, 0.75);
        if (hashVox(ix >> 1, iy, iz >> 1, 95) < 0.06) c = mix(c, GLACIER[1], 0.6);
        out.color = c;
        out.rough = 0.85;
        return;
      }
      case SIDE.SNOWROCK: {
        if (depth < 0.3 || top - y0 < 0.6) {
          out.color = shade(this.snow[2], 0.95);
          out.rough = 0.75;
          return;
        }
        let c = strata(ROCK, ix >> 1, iy >> 1, iz >> 1, 96, 0.08);
        if (hashVox(ix, iy, iz, 97) < 0.22) c = mix(c, 0xe6eef6, 0.7);
        out.color = c;
        out.rough = 0.85;
        return;
      }
      case SIDE.STONE:
        out.color = strata(FROST_TILE, ix, iy, iz, 98, 0.06);
        out.rough = 0.6;
        return;
      default: {
        let c = strata(tr.bank, ix, iy, iz, 99, 0.08);
        if (hashVox(ix, iy, iz, 100) < 0.22) c = mix(c, 0xcfe4f2, 0.5);
        out.color = shade(c, 1 - clamp01(depth / 2.6) * 0.2);
        out.rough = 0.45;
      }
    }
  }

  /** True when (x, z) is a flat spot on a cliff terrace (for cabins). */
  private terrace(x: number, z: number): boolean {
    const h = this.cliffs(x, z);
    if (h < 4 || h > 14) return false;
    const g = Math.abs(this.cliffs(x + 1.3, z) - this.cliffs(x - 1.3, z)) + Math.abs(this.cliffs(x, z + 1.3) - this.cliffs(x, z - 1.3));
    return g < 0.9;
  }

  backdrop(): BackdropRule[] {
    const hd = this.halfD;
    const water = (x: number, z: number) => this.outside(x, z) > 1.2 && this.channel(x, z) > 1.6;
    const farTerrace = (x: number, z: number) => (z < -hd - 8 && this.terrace(x, z) ? 1 : 0);
    const sideTop = (x: number, z: number) => {
      const h = this.cliffs(x, z);
      return Math.abs(x) > this.halfW + 5 && h > 3.5 && h < 16 && z > -hd - 6 ? 1 : 0;
    };
    const drift = (x: number, z: number) => {
      const o = this.outside(x, z);
      if (o < 0.3 || o > 3.2 || this.plazaDist(x, z) < 0.8) return 0;
      if (this.channel(x, z) > -1 || this.cliffs(x, z) > 0) return 0;
      return 1;
    };
    // the shore right at the foot of the far cliffs and on the sides
    const shoreFoot = (x: number, z: number) => {
      if (this.outside(x, z) < 2) return 0;
      const c = this.channel(x, z);
      return c > 0.4 && c < 1.4 && this.cliffs(x, z) === 0 ? 1 : 0;
    };
    const face = (x: number, z: number) => {
      const g = (this.channel(x + 0.5, z) - this.channel(x - 0.5, z));
      const gz = (this.channel(x, z + 0.5) - this.channel(x, z - 0.5));
      return Math.atan2(g, gz);
    };
    return [
      { model: 'cabin', spacing: 6.2, scale: [0.85, 1.15], density: (x, z) => farTerrace(x, z) * 0.8 + (sideTop(x, z) && this.terrace(x, z) ? 0.1 : 0), yaw: (x, z) => (hashVox(Math.round(x), 0, Math.round(z), 530) - 0.5) * 0.6 },
      { model: 'lanternpole', spacing: 3.6, scale: [1, 1.2], density: (x, z) => farTerrace(x, z) * 0.3 },
      { model: 'snowpine', spacing: 3.6, scale: [0.85, 1.3], density: (x, z) => sideTop(x, z) * 0.55 + farTerrace(x, z) * 0.25 + drift(x, z) * 0.1, castShadow: true },
      { model: 'pine', spacing: 4.2, scale: [0.85, 1.25], density: (x, z) => sideTop(x, z) * 0.35 + (this.cliffs(x, z) > 14 && this.cliffs(x, z) < 22 ? 0.2 : 0), castShadow: true },
      { model: 'floeblock', spacing: 5.5, scale: [0.6, 1.25], density: (x, z) => (water(x, z) ? 0.36 : 0), onWater: true, yOffset: -0.75 },
      { model: 'iceberg', spacing: 13, scale: [0.7, 1.3], density: (x, z) => (z > hd + 9 && water(x, z) ? 0.4 : z < -hd - 6 && water(x, z) ? 0.08 : 0), onWater: true, yOffset: -0.8 },
      { model: 'piersnow', spacing: 9, scale: [0.9, 1.1], density: (x, z) => shoreFoot(x, z) * 0.45, underwater: true, yaw: face },
      { model: 'snowcrane', spacing: 15, scale: [0.9, 1.1], density: (x, z) => (this.outside(x, z) > 3 && this.channel(x, z) > -2 && this.channel(x, z) < -0.6 ? 0.5 : 0), yaw: face },
      { model: 'snowrock', spacing: 4.4, scale: [0.6, 1.3], density: (x, z) => drift(x, z) * 0.3 + shoreFoot(x, z) * 0.25, underwater: true },
      { model: 'icerock', spacing: 2.8, scale: [0.6, 1.2], density: (x, z) => drift(x, z) * 0.4 },
      { model: 'snowbush', spacing: 2, scale: [0.7, 1.2], density: (x, z) => drift(x, z) * 0.35 },
      { model: 'iceshard', spacing: 2.6, scale: [0.7, 1.5], density: (x, z) => (this.outside(x, z) > 1 && this.cliffs(x, z) === 0 && this.cliffs(x, z - 1.6) > 3 ? 0.5 : 0), castShadow: true },
    ];
  }

  details(q: Quality): BackdropRule[] {
    if (q === 'low') return [];
    const rich = q === 'high' || q === 'ultra';
    const plats = this.map.platforms ?? [];
    const offDeck = (x: number, z: number) => {
      for (const p of plats) if (Math.hypot(x - p.x, z - p.z) < Math.max(p.w, p.d) / 2 + 0.5) return false;
      return true;
    };
    const inPlay = (x: number, z: number) => Math.abs(x) < this.halfW - 0.3 && Math.abs(z) < this.halfD - 0.3 && this.plazaDist(x, z) > 0.3 && offDeck(x, z);
    return [
      { model: 'pebble', spacing: rich ? 1.2 : 1.8, scale: [0.7, 1.3], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -this.bankW && c < 0.1 ? 0.45 : 0; } },
      { model: 'icebits', spacing: rich ? 1.4 : 2.2, scale: [0.6, 1.2], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -1 && c < 0.12 ? 0.5 : 0; } },
      { model: 'pebble', spacing: rich ? 1.3 : 2, scale: [0.9, 1.6], density: (x, z) => (inPlay(x, z) && this.channel(x, z) > 2 ? (this.dry ? 0.6 : 0.3) : 0), underwater: true },
    ];
  }

  extraDecor(): Decor[] {
    if (!this.dry) return [];
    const inBed = (x: number, z: number) => this.channel(x, z) > 1.6 && Math.abs(z) < this.halfD - 0.5;
    return [
      ...scatter(this.map, { kind: 'pebbles', count: 46, seed: 941, scale: [0.8, 1.4], accept: inBed }),
      ...scatter(this.map, { kind: 'snowtuft', count: 18, seed: 943, scale: [0.6, 1.0], accept: (x, z) => { const c = this.channel(x, z); return c > 0.3 && c < 1.4; } }),
    ];
  }

  /** Sea smoke drifting over the open harbour. */
  mist(): MistDef[] {
    const out: MistDef[] = [];
    for (let i = 0; i < 18; i++) {
      const far = i < 12;
      out.push({
        x: (hashVox(i, 1, 0, 540) - 0.5) * 64,
        y: this.fullY + 0.5 + hashVox(i, 2, 0, 541) * 0.6,
        z: far ? -this.halfD - 2 - hashVox(i, 3, 0, 542) * 9 : this.halfD + 4 + hashVox(i, 4, 0, 543) * 10,
        w: 10 + hashVox(i, 5, 0, 544) * 8,
        h: 2 + hashVox(i, 6, 0, 545) * 1.5,
        drift: 0.3,
        opacity: 0.16,
      });
    }
    return out;
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
