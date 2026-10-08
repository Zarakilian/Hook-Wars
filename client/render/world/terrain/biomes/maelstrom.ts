// Maelstrom Lagoon: lush grass and golden sand round a turquoise lagoon. High grey stone cliffs hung
// with vines ring the cove: the river pours in over the cliff behind the far edge (z = -24) through a
// square notch, and more waterfalls spill off the far and side cliffs into plunge pools. Palms and
// jungle crown the cliff tops. Past the near edge the river runs out over a beach into the open sea,
// with palm-topped sea stacks standing offshore and an old wreck on the sand.
import { riverAt, scatter } from '../../../../../shared/maps/helpers.ts';
import type { Decor, MapDef } from '../../../../../shared/maps/types.ts';
import { fbm2, valueNoise2 } from '../../../../../shared/math.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import type { Quality } from '../../../contracts.ts';
import { hashVox } from '../../../voxel/voxel.ts';
import { BaseBiome, SIDE, SURF, clamp01, h01, jit, mix, mosaic, pathSegs, pick, shade, soilSide, sstep, strata } from '../biome.ts';
import type { CascadeDef } from '../cascades.ts';
import type { Cell, SideOut } from '../field.ts';
import type { BackdropRule } from '../flora.ts';
import type { MistDef } from '../mist.ts';
import type { MapBiome, PoolDef } from './index.ts';

const MOSS = [0x4f8a32, 0x5a9a3a, 0x447a2c];
const VINES = [0x3f7a2e, 0x4c8a36, 0x356a26, 0x5a9a40];
const TILE = [0xe8d6aa, 0xdcc89a, 0xf0e0ba, 0xd0bc8e];
const SHELLS = [0xf4e6d4, 0xf0c8b8, 0xe8d8c0];
const JUNGLE_FLOOR = [0x4c7a2c, 0x588634, 0x426c26, 0x629038];
const OUTER_Z0 = -96;

/** Cliff lip above the bank top where the river falls in: the water module hangs its sheet at groundY + 2.7. */
export const MAEL_LIP = 2.62;
const LIP_Z = -25.3;
/** extra waterfalls on the far cliff (x) and the side cliffs (z, west side; the east mirrors) */
const FAR_FALLS = [-14.5, 14.5, -27.5, 27.5];
const SIDE_FALLS = [-13.5, 13.5];

export class MaelstromBiome extends BaseBiome implements MapBiome {
  private readonly zone = { z: 0, t: 0 };
  readonly sparkle = 0.35;
  readonly farColor = 0x3a8a9a;
  readonly farY: number;
  readonly mistColor = 0xf4fbff;
  private readonly grass: number[];
  private readonly sand: number[];
  private readonly lipY: number;
  private readonly cliffZ: number;

  constructor(map: MapDef, config: MatchConfig) {
    super(map, config);
    this.farY = this.B - 1;
    this.bankDrop = 0.17;
    this.wallW = 2.2;
    this.grass = byLum(map.terrain.grass);
    this.sand = byLum(map.terrain.bank);
    this.lipY = this.T + MAEL_LIP;
    this.cliffZ = -this.halfD - 0.7;
    this.paths = pathSegs(
      [
        [-25.6, 1.6, -21, 2.8, -16.4, 0.6, -12.6, -2.0, -10.4, -3.0],
        [-26.6, -3.6, -22, -9.6, -18.6, -13.2, -13.4, -14.4],
        [-26.2, 4.8, -23, 9.6, -19.6, 13.6, -14.6, 15.0],
      ],
      0.75,
    );
  }

  /** z of the far cliff face: ragged, square at the river notch, set back round the plunge pools. */
  cliffLine(x: number): number {
    const r = riverAt(this.map.river.points, -this.halfD);
    const dx = Math.abs(x - r.x);
    let z = this.cliffZ - valueNoise2(x * 0.35, 5, 61) * 0.9 - valueNoise2(x * 0.08, 6, 62) * 1.4;
    if (dx < 5.2) return LIP_Z;
    if (dx < 7) z = LIP_Z + (z - LIP_Z) * ((dx - 5.2) / 1.8);
    // set back round each plunge pool
    const back = -this.halfD - 5.2;
    for (const fx of FAR_FALLS) {
      const d = Math.abs(x - fx);
      if (d < 4.2 && back < z) z += (back - z) * sstep(4.2, 2.2, d);
    }
    return z;
  }

  /** |x| of a side cliff face at z: set back round the side plunge pools. */
  private sideLine(x: number, z: number): number {
    let s = this.halfW + 3.8 + valueNoise2(z * 0.3, x < 0 ? 7 : 8, 63) * 1.2;
    const zz = x < 0 ? z : -z; // the east side mirrors the west
    for (const fz of SIDE_FALLS) {
      const d = Math.abs(zz - fz);
      if (d < 4.4) s += 3.6 * sstep(4.4, 2.2, d);
    }
    return s;
  }

  /** The river opens into the sea past the near edge; plunge pools sit under the extra falls. */
  override channel(x: number, z: number): number {
    let c = super.channel(x, z);
    if (z > 25) c += (z - 25) * (z - 25) * 0.12 + (valueNoise2(x * 0.18, z * 0.18, 33) - 0.5) * Math.min(1, (z - 25) / 4) * 3;
    if (z < -this.halfD - 0.6) {
      for (const fx of FAR_FALLS) {
        const d = Math.hypot(x - fx, (z + this.halfD + 3.2) * 1.2);
        if (2.9 - d > c) c = 2.9 - d;
      }
    }
    if (Math.abs(x) > this.halfW + 0.4) {
      const zz = x < 0 ? z : -z;
      const sx = Math.abs(x);
      for (const fz of SIDE_FALLS) {
        const d = Math.hypot((sx - this.halfW - 3.6) * 1.2, zz - fz);
        if (2.8 - d > c) c = 2.8 - d;
      }
    }
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
    let mode = 0; // 0 normal, 1 cliff, 2 notch / stream, 3 jungle fringe
    const cz = this.cliffLine(x);
    const sl = this.sideLine(x, z);
    if (z < cz) {
      const r = riverAt(this.map.river.points, z);
      const dx = Math.abs(x - r.x);
      const notch = 4.6 + (cz - z) * 0.02;
      if (dx < notch) {
        // stream bed above the main falls
        mode = 2;
        const k = clamp01((notch - dx) / 1.6);
        land = this.lipY + 0.35 - k * 0.95 + (valueNoise2(x * 0.5, z * 0.5, 63) - 0.5) * 0.12;
        if (cz - z < 0.7) land = Math.max(land, this.lipY - 0.22);
        surf = k > 0.75 ? SURF.SEABED : SURF.ROCK;
      } else {
        mode = 1;
        land = T + 6.4 + fbm2(x * 0.07, z * 0.07, 3, 64) * 2.4 + sstep(6, 40, cz - z) * 8;
        // a little stream notch at the top of each extra fall
        for (const fx of FAR_FALLS) {
          const d = Math.abs(x - fx);
          if (d < 1.6) land -= (1.6 - d) * 0.9 * sstep(5, 2, cz - z);
        }
        surf = SURF.FLOOR;
      }
      side = SIDE.ROCK;
    } else if (Math.abs(x) > sl && z < this.halfD + 1.5 && pd > 0.6) {
      mode = 1;
      const ax = Math.abs(x) - this.halfW;
      land = T + 5.6 + fbm2(x * 0.06, z * 0.06, 3, 65) * 2.2 + sstep(5, 32, ax) * 7;
      const zz = x < 0 ? z : -z;
      for (const fz of SIDE_FALLS) {
        const d = Math.abs(zz - fz);
        if (d < 1.6) land -= (1.6 - d) * 0.9 * sstep(5, 2, Math.abs(x) - sl);
      }
      surf = SURF.FLOOR;
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
        if (Math.abs(x) > this.halfW + 2) {
          const hill = Math.max(0, (fbm2(x * 0.05, z * 0.05, 3, 69) - 0.4) * 10) * sstep(2, 10, Math.abs(x) - this.halfW);
          if (hill > 0.3) {
            land = Math.max(land, T + hill * 0.8 - (z - this.halfD) * 0.1);
            surf = SURF.FLOOR;
            side = SIDE.ROCK;
          }
        }
      } else {
        // a strip of jungle and sand at the cliff feet
        mode = 3;
        const k = sstep(0.4, 3.0, o);
        land += k * (0.3 + Math.max(0, fbm2(x * 0.1, z * 0.1, 2, 66) - 0.4) * 1.6);
        surf = k > 0.4 ? (h01(ix >> 1, iz >> 1, 70) < 0.5 ? SURF.FLOOR : SURF.SAND) : SURF.LAND;
        side = SIDE.SAND;
      }
    }
    let path = 0;
    if (pd < 0) {
      land = T;
      surf = pd > -0.3 ? SURF.KERB : SURF.PLAZA;
      if (surf === SURF.KERB) land = T + 0.0625;
      side = SIDE.STONE;
      mode = 0;
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
      if (o > 0.4 && zn.z >= 2 && z <= this.halfD + 1) {
        // plunge pools: dark rock floor
        surf = SURF.ROCK;
        side = SIDE.ROCK;
      }
    } else {
      zn.z = 0;
      c = -9;
    }
    out.h = h;
    out.q = mode === 1 || mode === 2 || surf === SURF.WALL ? 0.25 : !fine ? 0.5 : surf === SURF.FLOOR ? 0.125 : 1 / 16;
    if (mode === 1 && !fine) out.q = 0.5;
    out.side = side;
    out.tag = 0;
    let col: number;
    let rough = 0.9;
    let spk = 0;
    switch (surf) {
      case SURF.PLAZA: {
        // sandstone tiles with a shell-mosaic sunburst
        const f = x < 0 ? this.fountains[0] : this.fountains[1];
        const dx = x - f.x;
        const dz = z - f.z;
        const r = Math.hypot(dx, dz);
        const a = Math.atan2(dz, dx);
        const ray = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 18);
        col = pick(TILE, ix, iz, 40);
        if (r > 2 && r < 5.2 && ray % 2 === 0) col = mix(col, 0x5fd0c8, 0.5);
        if (r > 5.5 && r < 5.9) col = pick(SHELLS, ix, iz, 41);
        if (r < 1.9) col = shade(col, 1.06);
        col = jit(col, ix, iz, 0.04);
        rough = 0.75;
        break;
      }
      case SURF.KERB:
        col = jit(0x9a958a, ix, iz, 0.08); // grey stone kerb
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
        if (h01(ix, iz, 25) < 0.014) col = h01(ix, iz, 26) < 0.5 ? 0xe8806a : 0xb070d0; // coral bits
        rough = this.dry ? 0.95 : 0.7;
        spk = this.dry ? 0.8 : 0;
        break;
      }
      case SURF.SEABED:
        col = mosaic(this.sand, 0.5, ix, iz, 8, 0.05, 0.1);
        col = shade(col, 0.9);
        if (h01(ix >> 2, iz >> 2, 27) < 0.04) col = pick(MOSS, ix, iz, 28);
        rough = 0.6;
        break;
      case SURF.ROCK:
        col = jit(pick(tr.cliff, ix, iz, 9), ix, iz, 0.06);
        if (h01(ix, iz, 26) < 0.25) col = pick(MOSS, ix, iz, 10);
        rough = 0.75;
        break;
      case SURF.FLOOR: {
        col = mosaic(JUNGLE_FLOOR, valueNoise2(x * 0.1, z * 0.1, 45), ix, iz, 11, 0.07, 0.12);
        if (h01(ix, iz, 27) < 0.06) col = pick(tr.cliff, ix, iz, 12);
        rough = 0.95;
        break;
      }
      default: {
        const patch = valueNoise2(x * 0.07, z * 0.07, 46) * 0.7 + valueNoise2(x * 0.3, z * 0.3, 49) * 0.3;
        col = mosaic(this.grass, patch, ix, iz, 13, 0.06, 0.1);
        const r = h01(ix, iz, 28);
        if (r < 0.015) col = 0xf2d24a;
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
        // grey stone in blocky courses, vines hanging from the lip, moss and wet streaks low down
        let c = strata(tr.cliff, ix >> 1, iy >> 1, iz >> 1, 110, 0.08);
        if ((hashVox(ix >> 1, iy >> 1, iz >> 1, 111) < 0.08)) c = shade(c, 0.78); // block joints
        const vine = hashVox(ix, 0, iz, 112);
        if (depth < 0.3) c = pick(JUNGLE_FLOOR, ix, iz, 113);
        else if (vine < 0.32 && depth < 1.2 + vine * 9) c = pick(VINES, ix, iz + iy, 114);
        else if (hashVox(ix, iy, iz, 115) < 0.08) c = mix(c, MOSS[0], 0.6);
        const y = (_y0 + y1) * 0.5;
        if (y < this.fullY + 0.4) c = shade(mix(c, 0x3a5a4a, 0.35), 0.85);
        out.color = c;
        out.rough = 0.8;
        return;
      }
      case SIDE.STONE:
        out.color = strata(TILE, ix, iy, iz, 116, 0.05);
        return;
      default: {
        const c = strata(this.sand, ix, iy, iz, 117, 0.06);
        out.color = shade(c, 1 - clamp01(depth / 2.6) * 0.15);
        out.rough = 0.92;
      }
    }
  }

  backdrop(): BackdropRule[] {
    const hd = this.halfD;
    const cliffTop = (x: number, z: number) => {
      if (z < this.cliffLine(x) - 1.4 && Math.abs(x - riverAt(this.map.river.points, z).x) > 6.5) return 1;
      if (Math.abs(x) > this.sideLine(x, z) + 1.4 && z < hd) return 1;
      return 0;
    };
    const fringe = (x: number, z: number) => {
      const o = this.outside(x, z);
      if (o < 0.6 || this.plazaDist(x, z) < 1 || z > hd + 0.5 || cliffTop(x, z) || this.channel(x, z) > -1.2) return 0;
      if (z < this.cliffLine(x) + 0.4 || Math.abs(x) > this.sideLine(x, z) - 0.4) return 0;
      return 1;
    };
    const beach = (x: number, z: number) => (z > hd + 0.5 && this.channel(x, z) < -1 ? 1 : 0);
    const sea = (x: number, z: number) => (z > hd + 6 && this.channel(x, z) > 3 ? 1 : 0);
    const shallows = (x: number, z: number) => {
      if (this.outside(x, z) < 1) return 0;
      const c = this.channel(x, z);
      return c > 0.3 && c < 2.2 ? 1 : 0;
    };
    const wreckSpot = (x: number, z: number) => (Math.hypot(x + 21, z - (hd + 11)) < 3.4 ? 1 : 0);
    return [
      { model: 'palm', spacing: 4.2, scale: [0.85, 1.25], density: (x, z) => cliffTop(x, z) * (this.outside(x, z) < 18 ? 0.5 : 0.25) + beach(x, z) * 0.22 + fringe(x, z) * 0.4, castShadow: true },
      { model: 'jbush', spacing: 2.6, scale: [0.9, 1.5], density: (x, z) => cliffTop(x, z) * (this.outside(x, z) < 16 ? 0.45 : 0.15) + fringe(x, z) * 0.4 },
      { model: 'fern', spacing: 1.7, scale: [0.7, 1.2], density: (x, z) => fringe(x, z) * 0.4 + cliffTop(x, z) * (this.outside(x, z) < 12 ? 0.12 : 0) },
      { model: 'sandrock', spacing: 3.4, scale: [0.6, 1.4], density: (x, z) => fringe(x, z) * 0.18 + beach(x, z) * 0.06 },
      { model: 'beachgrass', spacing: 1.4, scale: [0.7, 1.3], density: (x, z) => beach(x, z) * 0.35 + fringe(x, z) * 0.2 },
      { model: 'driftwood', spacing: 6, scale: [0.8, 1.3], density: (x, z) => beach(x, z) * 0.18 },
      { model: 'seastackbig', spacing: 11, scale: [0.75, 1.15], density: (x, z) => (sea(x, z) && (Math.abs(x) > this.halfW + 6 || z > hd + 26) ? 0.45 : 0), underwater: true, yOffset: -1.2, castShadow: true },
      { model: 'searock', spacing: 6, scale: [0.8, 1.7], density: (x, z) => sea(x, z) * 0.22, yOffset: -0.4, underwater: true },
      { model: 'coral', spacing: 1.9, scale: [0.7, 1.3], density: (x, z) => shallows(x, z) * 0.35, underwater: true },
      { model: 'wreck', spacing: 7, scale: [1, 1], density: wreckSpot, underwater: true, yOffset: -0.4, yaw: () => 0.5 },
      { model: 'pierwood', spacing: 1, scale: [1, 1], density: () => 0, underwater: true, points: [{ x: -17, z: hd + 7, yaw: Math.PI / 2 + 0.1 }, { x: 19, z: hd + 7.5, yaw: Math.PI / 2 - 0.15 }, { x: -this.halfW - 2.6, z: 13.5, yaw: 0 }, { x: this.halfW + 2.6, z: -13.5, yaw: Math.PI }] },
      { model: 'searock', spacing: 4, scale: [0.6, 1.2], density: (x, z) => (Math.abs(z - this.cliffLine(x)) < 1.2 && Math.abs(x - riverAt(this.map.river.points, z).x) > 5 && Math.abs(x - riverAt(this.map.river.points, z).x) < 9 ? 0.5 : 0) },
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
      { model: 'shellbits', spacing: rich ? 1.1 : 1.7, scale: [0.7, 1.3], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -this.bankW && c < 0.1 ? 0.45 : 0; } },
      { model: 'shellbits', spacing: rich ? 1.3 : 2, scale: [0.8, 1.4], density: (x, z) => (inPlay(x, z) && this.channel(x, z) > 2.4 ? (this.dry ? 0.55 : 0.3) : 0), underwater: true },
      { model: 'coral', spacing: rich ? 2.6 : 3.6, scale: [0.6, 1.0], density: (x, z) => (inPlay(x, z) && this.channel(x, z) > 2.6 && Math.hypot(x, z) > 6 ? 0.3 : 0), underwater: true },
      { model: 'pebble', spacing: rich ? 2 : 3, scale: [0.6, 1.1], density: (x, z) => (inPlay(x, z) && this.channel(x, z) < -this.bankW - 0.5 ? 0.15 : 0) },
    ];
  }

  extraDecor(): Decor[] {
    if (!this.dry) return [];
    const inBed = (x: number, z: number) => this.channel(x, z) > 1.8 && Math.abs(z) < this.halfD - 0.5;
    return [
      ...scatter(this.map, { kind: 'shell', count: 44, seed: 951, scale: [0.7, 1.3], accept: inBed }),
      ...scatter(this.map, { kind: 'starfish', count: 22, seed: 952, scale: [0.7, 1.2], accept: inBed }),
      ...scatter(this.map, { kind: 'coralfan', count: 16, seed: 953, scale: [0.6, 1.1], accept: inBed }),
    ];
  }

  /** Waterfalls off the far and side cliffs into their plunge pools. */
  cascades(): CascadeDef[] {
    const out: CascadeDef[] = [];
    // down to the pool floors: the sheets fold up onto the live pool level (tides drain the pools)
    const foot = this.B;
    for (const fx of FAR_FALLS) {
      const z = this.cliffLine(fx);
      const top = this.T + 6.4 + fbm2(fx * 0.07, (z - 0.6) * 0.07, 3, 64) * 2.4 - 1.2;
      out.push({ x: fx, z: z + 0.1, top, bottom: foot, w: 1.9, yaw: 0 });
    }
    for (const fz of SIDE_FALLS) {
      for (const s of [-1, 1]) {
        const z = s < 0 ? fz : -fz;
        const x = s * this.sideLine(s, z);
        const top = this.T + 5.6 + fbm2(x * 0.06, z * 0.06, 3, 65) * 2.2 + sstep(5, 32, Math.abs(x) - this.halfW) * 7 - 1.2;
        out.push({ x: x - s * 0.1, z, top, bottom: foot, w: 1.7, yaw: s < 0 ? Math.PI / 2 : -Math.PI / 2 });
      }
    }
    return out;
  }

  /** Spray at the foot of every fall. */
  mist(): MistDef[] {
    const out: MistDef[] = [];
    if (this.dry || this.tidal) return out; // no falls in Dry Bed; on Tidal the pools drain away from the spray
    let i = 0;
    for (const c of this.cascades()) {
      const dx = Math.sin(c.yaw);
      const dz = Math.cos(c.yaw);
      for (let k = 0; k < 2; k++, i++) out.push({ x: c.x + dx * (1.4 + k), y: this.fullY + 0.6 + k * 0.5, z: c.z + dz * (1.4 + k), w: 4 + k * 2, h: 2.4, drift: 0.8, opacity: 0.38 - k * 0.12 });
    }
    // and the river's own falls
    const r = riverAt(this.map.river.points, -this.halfD);
    out.push({ x: r.x, y: this.fullY + 0.8, z: -this.halfD + 1.2, w: 9, h: 3, drift: 0.8, opacity: 0.3 });
    return out;
  }

  backwaterKeep(x: number, z: number): boolean {
    // the stream above the main falls has its own fixed-level pool
    return z > this.cliffLine(x) + 0.05;
  }

  pools(): PoolDef[] {
    return [
      {
        x0: -20,
        x1: 20,
        z0: OUTER_Z0,
        z1: -this.halfD - 0.5,
        level: this.lipY + 0.06,
        keep: (x, z) => z < this.cliffLine(x) + 0.12 && Math.abs(x - riverAt(this.map.river.points, z).x) < 6.5,
      },
    ];
  }
}

function byLum(p: readonly number[]): number[] {
  const l = (c: number) => ((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11;
  return [...p].sort((a, b) => l(a) - l(b));
}
