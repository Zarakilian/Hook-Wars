// Frostfang Fjord: sparkling snow banks, icy gravel shores, frost-stone plazas. Glacier walls rise
// behind the far edge with the river cutting an ice canyon through them, snowy cliffs and pine
// plateaus flank the sides, and past the near edge the river spills into a fjord lake that freezes
// with the river on Tidal.
import { scatter } from '../../../../../shared/maps/helpers.ts';
import type { Decor, MapDef } from '../../../../../shared/maps/types.ts';
import { fbm2, valueNoise2 } from '../../../../../shared/math.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import type { Quality } from '../../../contracts.ts';
import { hashVox } from '../../../voxel/voxel.ts';
import { BaseBiome, SIDE, SURF, clamp01, h01, jit, mix, mosaic, pathSegs, pick, shade, sstep, strata } from '../biome.ts';
import type { Cell, SideOut } from '../field.ts';
import type { BackdropRule } from '../flora.ts';
import type { MapBiome, PoolDef } from './index.ts';

const GLACIER = [0x9ccbe6, 0x86b9da, 0xb4daee, 0x74a8cc, 0xc8e6f4];
const ROCK = [0x5a6474, 0x4e5868, 0x666f80, 0x434c5a];
const FROST_TILE = [0x8796a8, 0x7a899c, 0x93a2b3, 0x6f7e91, 0x9eacbc];

export class FrostfangBiome extends BaseBiome implements MapBiome {
  private readonly zone = { z: 0, t: 0 };
  readonly sparkle = 1.3;
  readonly farColor = 0xdfe8f2;
  readonly farY: number;
  private readonly snow: number[];

  constructor(map: MapDef, config: MatchConfig) {
    super(map, config);
    this.farY = this.T + 3;
    this.bankDrop = 0.16;
    this.wallW = 1.6;
    this.snow = byLum(map.terrain.grass);
    this.paths = pathSegs(
      [
        [-25.8, 1.4, -21, 3.2, -16.5, 5.4, -11.5, 6.6, -6.8, 7],
        [-26.4, -3.8, -21.6, -6.4, -16.2, -8.6, -12.4, -10.6],
        [-26.2, 4.8, -22.6, 9.6, -19.6, 13.8, -14.6, 17.2],
      ],
      0.7,
    );
  }

  /** The river widens into the fjord lake past the near edge. */
  override channel(x: number, z: number): number {
    let c = super.channel(x, z);
    if (z > 26) c += (z - 26) * 0.7 + (valueNoise2(x * 0.15, z * 0.15, 32) - 0.5) * Math.min(1, (z - 26) / 4) * 4;
    return c;
  }

  /** Glacier height behind the far edge (0 = none). */
  private glacier(x: number, z: number): number {
    const dFar = -this.halfD - z;
    if (dFar <= 0) return 0;
    const start = 1.6 + valueNoise2(x * 0.18, 3, 51) * 1.6;
    if (dFar < start) return 0;
    // canyon around the river channel
    const c = super.channel(x, z);
    const canyon = c > -2.2 - Math.max(0, dFar - 8) * 0.04;
    const caveWall = dFar > 21 + valueNoise2(x * 0.3, 9, 52) * 2;
    if (canyon && !caveWall) return 0;
    return 6.6 + (fbm2(x * 0.05, z * 0.05, 2, 53) - 0.5) * 1.4 + sstep(14, 60, dFar) * 7;
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
      if (z > this.halfD) {
        // snowfield sloping down to the fjord shore
        const k = sstep(0.3, 7, z - this.halfD);
        land += (this.fullY + 0.14 - land) * k;
        land += (fbm2(x * 0.2, z * 0.2, 2, 54) - 0.5) * 0.5 * (1 - k * 0.6);
      } else {
        // drifts, then snowy cliffs on the sides, glacier at the far end
        const drift = sstep(0.2, 2.6, o);
        land += drift * (0.35 + (fbm2(x * 0.22, z * 0.22, 2, 55) - 0.4) * 0.6);
        const g = this.glacier(x, z);
        const sideCliff = Math.abs(x) > this.halfW && o > 3.2 + valueNoise2(z * 0.2, 7, 56) * 2.2;
        if (g > 0) {
          land = T + g;
          cliff = 2;
        } else if (sideCliff && z > -this.halfD + 2) {
          land = T + 4.2 + (fbm2(x * 0.06, z * 0.06, 2, 57) - 0.5) * 1.6 + sstep(10, 50, o) * 4;
          cliff = 1;
        }
      }
    }
    let path = 0;
    if (pd < 0) {
      land = T;
      surf = pd > -0.3 ? SURF.KERB : SURF.PLAZA;
      if (surf === SURF.KERB) land = T + 0.0625;
    } else if (o < 0 && fine) {
      path = this.pathAmount(x, z);
      if (path > 0) land -= 0.06 * sstep(0, 0.6, path);
    }
    const zn = this.zone;
    let h = land;
    if (cliff === 0) {
      h = this.profile(c, land, zn, x, z);
      if (zn.z >= 2) {
        surf = zn.z === 2 ? SURF.WALL : SURF.BED;
        if (zn.z === 3) h += this.bedNoise(x, z);
        if (this.dry && zn.z === 3 && fine) {
          // gravel bed with scattered cobbles
          if (h01(ix >> 1, iz >> 1, 71) < 0.08) h += 0.07;
        }
      } else if (zn.z === 1 && surf !== SURF.PLAZA && surf !== SURF.KERB) surf = SURF.BANK;
      if (z > this.halfD + 2 && h < this.fullY - 0.05) {
        h = Math.max(h, this.B - 0.6 + (valueNoise2(x * 0.2, z * 0.2, 58) - 0.5) * 0.6);
        surf = SURF.SEABED;
      }
    } else {
      zn.z = 0;
      surf = cliff === 2 ? SURF.ICE : SURF.SNOW;
      side = cliff === 2 ? SIDE.ICE : SIDE.SNOWROCK;
    }
    out.h = h;
    out.q = surf === SURF.WALL || cliff ? 0.25 : !fine ? 0.5 : 1 / 16;
    if (cliff === 0) side = surf === SURF.WALL || surf === SURF.BED || surf === SURF.BANK || surf === SURF.SEABED ? SIDE.ROCK : surf === SURF.PLAZA || surf === SURF.KERB ? SIDE.STONE : SIDE.SNOWROCK;
    out.side = side;
    out.tag = 0;
    let col: number;
    let rough = 0.9;
    let spk = 0;
    switch (surf) {
      case SURF.PLAZA: {
        // frost stone tiles in rings around the fountain
        const f = x < 0 ? this.fountains[0] : this.fountains[1];
        const r = Math.hypot(x - f.x, z - f.z);
        const a = Math.atan2(z - f.z, x - f.x);
        const ring = Math.floor(r / 0.9);
        const seg = Math.floor(((a + Math.PI) / (Math.PI * 2)) * (8 + ring * 6));
        col = FROST_TILE[Math.floor(hashVox(ring, seg, 0, 81) * FROST_TILE.length)];
        col = shade(col, 0.95 + hashVox(ring, seg, 1, 82) * 0.12);
        const fr = r / 0.9 - ring;
        if (fr < 0.22) col = shade(col, 0.72);
        if (h01(ix, iz, 83) < 0.18) col = mix(col, 0xe8f0f8, 0.6); // frost
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
        const g = h01(ix, iz, 21);
        if (g > t * 1.5 - 0.2) col = mosaic(this.snow, valueNoise2(x * 0.3, z * 0.3, 85), ix, iz, 1, 0.04, 0.08);
        else col = shade(pick(tr.bank, ix, iz, 2), 1 - t * 0.18);
        if (h01(ix, iz, 22) < 0.05) col = pick(ROCK, ix, iz, 3);
        rough = 0.5 - t * 0.2;
        spk = 0.6;
        break;
      }
      case SURF.WALL:
        col = shade(mix(pick(tr.bank, ix, iz, 6), pick(ROCK, ix, iz, 7), 0.5), 0.9 - zn.t * 0.15);
        if (h01(ix, iz, 24) < 0.18) col = mix(col, 0xcfe4f2, 0.5); // icy crust
        rough = 0.4;
        break;
      case SURF.BED:
        if (this.dry) {
          col = jit(pick(tr.dryBed, ix, iz, 17), ix, iz, 0.08);
          if (h01(ix >> 1, iz >> 1, 71) < 0.08) col = shade(pick(ROCK, ix >> 1, iz >> 1, 72), 1.25);
          if (h01(ix, iz, 73) < 0.04) col = 0xdfe9f3; // snow patch
          rough = 0.9;
        } else {
          col = shade(jit(pick(tr.bed, ix, iz, 18), ix, iz, 0.08), 1 - zn.t * 0.15);
          rough = 0.55;
        }
        break;
      case SURF.SEABED:
        col = jit(shade(tr.bed[1], 0.9), ix, iz, 0.08);
        rough = 0.5;
        break;
      case SURF.ICE:
        col = jit(pick(GLACIER, ix, iz, 30), ix, iz, 0.05);
        if (h01(ix, iz, 31) < 0.7) col = mosaic(this.snow, 0.6, ix, iz, 32, 0.03, 0.05); // snow on top
        rough = 0.6;
        spk = 1;
        break;
      default: {
        // snow: soft drifts of near-white, blue in the hollows, scattered glints
        const patch = valueNoise2(x * 0.08, z * 0.08, 46) * 0.7 + valueNoise2(x * 0.35, z * 0.35, 49) * 0.3;
        col = mosaic(this.snow, patch, ix, iz, 13, 0.035, 0.08);
        if (cliff === 1) col = shade(col, 0.97);
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

  sideColor(side: number, _tag: number, ix: number, iy: number, iz: number, _dir: number, _y0: number, y1: number, top: number, _cs: number, out: SideOut): void {
    const tr = this.map.terrain;
    out.emit = 0;
    out.rough = 0.8;
    const depth = top - y1;
    switch (side) {
      case SIDE.ICE: {
        // glacier: blue ice strata under a snow cap, darker blue deep down
        if (depth < 0.3 || top - _y0 < 0.6) {
          out.color = shade(this.snow[3], 0.97);
          out.rough = 0.7;
          return;
        }
        let c = strata(GLACIER, ix >> 1, iy >> 1, iz >> 1, 90, 0.05);
        out.emit = 0.28;
        if (hashVox(0, iy, 0, 91) < 0.18) c = mix(c, 0xeaf4fa, 0.6); // snow band
        if (hashVox(ix >> 2, 0, iz >> 2, 92) < 0.1) c = shade(c, 0.7); // crevasse streak
        out.color = shade(c, 1 - clamp01(depth / 14) * 0.35);
        out.rough = 0.22;
        return;
      }
      case SIDE.SNOWROCK: {
        if (depth < 0.3 || top - _y0 < 0.6) {
          out.color = shade(this.snow[2], 0.95);
          out.rough = 0.75;
          return;
        }
        let c = strata(ROCK, ix >> 1, iy >> 1, iz >> 1, 93, 0.08);
        if (hashVox(ix, iy, iz, 94) < 0.22) c = mix(c, 0xe6eef6, 0.7); // snow in cracks
        if (hashVox(ix >> 1, iy, iz >> 1, 95) < 0.06) c = mix(c, GLACIER[1], 0.6);
        out.color = c;
        out.rough = 0.85;
        return;
      }
      case SIDE.STONE:
        out.color = strata(FROST_TILE, ix, iy, iz, 96, 0.06);
        out.rough = 0.6;
        return;
      default: {
        let c = strata(tr.bank, ix, iy, iz, 97, 0.08);
        if (hashVox(ix, iy, iz, 98) < 0.2) c = mix(c, 0xcfe4f2, 0.5);
        out.color = shade(c, 1 - clamp01(depth / 2.6) * 0.2);
        out.rough = 0.45;
      }
    }
  }

  backdrop(): BackdropRule[] {
    const plateau = (x: number, z: number) => {
      const o = this.outside(x, z);
      if (o < 4.5 || z > this.halfD + 3) return 0;
      if (this.glacier(x, z) > 0) return this.outside(x, z) > 18 ? 0.25 : 0;
      return Math.abs(x) > this.halfW + 4 ? 1 : 0;
    };
    const drift = (x: number, z: number) => {
      const o = this.outside(x, z);
      if (o < 0.3 || o > 3.2 || this.plazaDist(x, z) < 0.8) return 0;
      if (this.channel(x, z) > -1 || this.glacier(x, z) > 0) return 0;
      return 1;
    };
    const shore = (x: number, z: number) => {
      if (z < this.halfD + 0.5 || this.outside(x, z) < 0.4) return 0;
      const c = this.channel(x, z);
      return c > -3 && c < -0.5 ? 1 : 0;
    };
    const glacierFoot = (x: number, z: number) => {
      if (z > -this.halfD - 0.5 || this.glacier(x, z) > 0) return 0;
      return this.glacier(x, z - 1.5) > 0 && this.channel(x, z) < -1 ? 1 : 0;
    };
    const lake = (x: number, z: number) => (z > this.halfD + 9 && this.channel(x, z) > 3 ? 1 : 0);
    return [
      { model: 'pine', spacing: 3.6, scale: [0.85, 1.3], density: (x, z) => plateau(x, z) * 0.75, castShadow: true },
      { model: 'snowpine', spacing: 3.2, scale: [0.8, 1.25], density: (x, z) => plateau(x, z) * 0.6 + drift(x, z) * 0.12 + shore(x, z) * 0.2, castShadow: true },
      { model: 'icerock', spacing: 2.6, scale: [0.6, 1.3], density: (x, z) => drift(x, z) * 0.45 + shore(x, z) * 0.35 + glacierFoot(x, z) * 0.4 },
      { model: 'snowbush', spacing: 2, scale: [0.7, 1.2], density: (x, z) => drift(x, z) * 0.35 + shore(x, z) * 0.2 },
      { model: 'iceshard', spacing: 2.4, scale: [0.7, 1.5], density: (x, z) => glacierFoot(x, z) * 0.55 + drift(x, z) * 0.06, castShadow: true },
      { model: 'iceberg', spacing: 12, scale: [0.7, 1.4], density: (x, z) => lake(x, z) * 0.45, onWater: true, yOffset: -0.6 },
      { model: 'floe', spacing: 6, scale: [0.7, 1.3], density: (x, z) => (z > this.halfD + 3 && this.channel(x, z) > 1.5 ? 0.35 : 0), onWater: true, yOffset: -0.25 },
    ];
  }

  details(q: Quality): BackdropRule[] {
    if (q === 'low') return [];
    const rich = q === 'high' || q === 'ultra';
    const inPlay = (x: number, z: number) => Math.abs(x) < this.halfW - 0.3 && Math.abs(z) < this.halfD - 0.3 && this.plazaDist(x, z) > 0.3;
    return [
      { model: 'pebble', spacing: rich ? 1.2 : 1.8, scale: [0.7, 1.3], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -this.bankW && c < 0.1 ? 0.45 : 0; } },
      { model: 'icebits', spacing: rich ? 1.5 : 2.4, scale: [0.6, 1.2], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -1 && c < 0.12 ? 0.45 : 0; } },
      { model: 'pebble', spacing: rich ? 1.3 : 2, scale: [0.9, 1.6], density: (x, z) => (inPlay(x, z) && this.channel(x, z) > 2 ? (this.dry ? 0.6 : 0.3) : 0), underwater: true },
    ];
  }

  extraDecor(): Decor[] {
    if (!this.dry) return [];
    const inBed = (x: number, z: number) => this.channel(x, z) > 1.6 && Math.abs(z) < this.halfD - 0.5;
    return [
      ...scatter(this.map, { kind: 'pebbles', count: 46, seed: 911, scale: [0.8, 1.4], accept: inBed }),
      ...scatter(this.map, { kind: 'bones', count: 4, seed: 912, scale: [0.8, 1.1], accept: inBed }),
      ...scatter(this.map, { kind: 'snowtuft', count: 18, seed: 913, scale: [0.6, 1.0], accept: (x, z) => { const c = this.channel(x, z); return c > 0.3 && c < 1.4; } }),
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
