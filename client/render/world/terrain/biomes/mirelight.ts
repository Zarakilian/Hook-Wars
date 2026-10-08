// Mirelight Marsh: Muckmire's mossy banks and mud channels, braided. Past the far edge the bayou
// runs on toward the setting sun, widening into misty open water dotted with hummock islands of
// giant moss-hung cypress, stilt huts and lantern posts. A cypress forest with pools closes in on the
// sides, and past the near edge the river spills into a cattail and lily-pad marsh.
import { riverAt } from '../../../../../shared/maps/helpers.ts';
import type { MapDef } from '../../../../../shared/maps/types.ts';
import { fbm2, valueNoise2 } from '../../../../../shared/math.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import type { Quality } from '../../../contracts.ts';
import { hashVox } from '../../../voxel/voxel.ts';
import { BaseBiome, pathSegs, sstep } from '../biome.ts';
import type { BackdropRule } from '../flora.ts';
import type { MistDef } from '../mist.ts';
import { MuckmireBiome } from './muckmire.ts';

export class MirelightBiome extends MuckmireBiome {
  override readonly farColor = 0x1c2618;
  readonly lampLight = 1.1;

  constructor(map: MapDef, config: MatchConfig) {
    super(map, config);
    // worn paths from the plaza to the two dock crossings and round the side-channel end
    this.paths = pathSegs(
      [
        [-25.6, 1.4, -21.4, 3.2, -18.4, 6.2, -16.6, 7.5],
        [-26.4, -3.4, -22.2, -5.2, -18.6, -6.4, -17.0, -6.5],
        [-26.2, 4.8, -23.0, 10.4, -20.4, 15.6, -16.4, 18.0, -12.4, 18.2],
        [-10.8, 7.5, -9.6, 9.6, -8.4, 11.6],
      ],
      0.75,
    );
  }

  /** Signed distance outside the nearest hummock island in the far waterway (negative inside). */
  hummock(x: number, z: number): number {
    const S = 9.5;
    const gx = Math.floor(x / S);
    const gz = Math.floor(z / S);
    let best = 1e9;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const cx = gx + i;
        const cz = gz + j;
        if (hashVox(cx, 0, cz, 301) > 0.62) continue;
        const px = (cx + 0.2 + hashVox(cx, 1, cz, 302) * 0.6) * S;
        const pz = (cz + 0.2 + hashVox(cx, 2, cz, 303) * 0.6) * S;
        const rad = 1.9 + hashVox(cx, 3, cz, 304) * 2.4;
        const d = Math.hypot(x - px, (z - pz) * 1.15) - rad - (valueNoise2(x * 0.6, z * 0.6, 305) - 0.5) * 0.8;
        if (d < best) best = d;
      }
    return best;
  }

  /**
   * Terrain channel: the sim channel inside the map. Past the far edge the bayou widens into open
   * water with hummocks, past the near edge it spills into the marsh, and forest pools dot the sides.
   */
  override channel(x: number, z: number): number {
    let c = BaseBiome.prototype.channel.call(this, x, z);
    const hd = this.halfD;
    if (z < -hd) {
      const d = -hd - z;
      const r = riverAt(this.map.river.points, -hd);
      const wob = Math.sin(z * 0.09 + 1.3) * 3 * sstep(4, 24, d);
      const hw = r.hw + sstep(0.5, 13, d) * 15 + (valueNoise2(x * 0.11, z * 0.11, 35) - 0.5) * 5 * sstep(2, 10, d);
      c = Math.max(c, hw - Math.abs(x - r.x - wob));
      if (d > 3.5) c = Math.min(c, this.hummock(x, z) + (d < 7 ? (7 - d) * 0.8 : 0));
    } else if (z > hd + 1) {
      c += (z - hd - 1) * 0.45 + (valueNoise2(x * 0.2, z * 0.2, 31) - 0.5) * Math.min(1, (z - hd - 1) / 4) * 3;
    }
    const ax = Math.abs(x);
    if (ax > this.halfW + 4.5 && z < hd + 4) {
      // forest pools
      const p = (fbm2(x * 0.06, z * 0.06, 3, 36) - 0.55) * 22 * sstep(4.5, 11, ax - this.halfW);
      if (p > c) c = p;
    }
    return c;
  }

  override backdrop(): BackdropRule[] {
    const hd = this.halfD;
    const hw = this.halfW;
    const tidal = this.tidal;
    const forest = (x: number, z: number) => {
      const o = this.outside(x, z);
      if (o < 1.6 || this.plazaDist(x, z) < 1.4) return 0;
      if (z > hd && Math.abs(x) < hw + 6) return 0;
      return this.channel(x, z) > -1.6 ? 0 : 1;
    };
    const hummockCore = (x: number, z: number) => (z < -hd - 4 && this.hummock(x, z) < -1.3 ? 1 : 0);
    const shoreLand = (x: number, z: number) => {
      if (this.outside(x, z) < 2) return 0;
      const c = this.channel(x, z);
      return c > -2.4 && c < -0.5 ? 1 : 0;
    };
    // shallow water right by a shore: the ground is just under the full water line, so things placed
    // here stand on the ground and stay grounded when the tide drains
    const shallows = (x: number, z: number) => {
      if (this.outside(x, z) < 1.5) return 0;
      const c = this.channel(x, z);
      return c > 0.22 && c < 0.75 ? 1 : 0;
    };
    const openWater = (x: number, z: number) => (this.outside(x, z) > 1 && this.channel(x, z) > 1.4 ? 1 : 0);
    const face = (x: number, z: number) => this.faceRiver(x, z);
    const rules: BackdropRule[] = [
      { model: 'giantcypress', spacing: 6.2, scale: [0.85, 1.25], density: (x, z) => hummockCore(x, z) * 0.95 + forest(x, z) * (this.outside(x, z) > 6 ? 0.5 : 0.18), castShadow: true },
      { model: 'cypress', spacing: 4.4, scale: [1.0, 1.4], density: (x, z) => forest(x, z) * (this.outside(x, z) < 16 ? 0.55 : 0.25) + hummockCore(x, z) * 0.25, castShadow: true },
      { model: 'swampoak', spacing: 7, scale: [1.0, 1.3], density: (x, z) => forest(x, z) * (this.outside(x, z) > 10 ? 0.4 : 0) },
      { model: 'stilthut', spacing: 9, scale: [0.9, 1.1], density: (x, z) => shoreLand(x, z) * (this.outside(x, z) > 4 ? 0.75 : 0), yaw: face },
      { model: 'stilthut', spacing: 11, scale: [0.9, 1.05], density: (x, z) => shallows(x, z) * (this.outside(x, z) > 5 ? 0.6 : 0), underwater: true, yaw: face },
      { model: 'swampstump', spacing: 6, scale: [0.8, 1.3], density: (x, z) => shallows(x, z) * 0.3 + hummockCore(x, z) * 0.06, underwater: true },
      { model: 'snag', spacing: 9, scale: [0.8, 1.2], density: (x, z) => shallows(x, z) * 0.18 + forest(x, z) * 0.05, underwater: true },
      { model: 'lanternpole', spacing: 5, scale: [0.9, 1.1], density: (x, z) => shallows(x, z) * 0.22 + shoreLand(x, z) * 0.1, underwater: true },
      { model: 'dockruin', spacing: 7, scale: [0.9, 1.15], density: (x, z) => shallows(x, z) * 0.6, underwater: true, yaw: face },
      { model: 'cattails', spacing: 1.7, scale: [0.8, 1.4], density: (x, z) => { const o = this.outside(x, z); if (o < 0.6 || o > 16) return 0; const c = this.channel(x, z); return c > -1.5 && c < 0.9 ? 0.55 : 0; }, underwater: true },
      { model: 'reeds', spacing: 1.8, scale: [0.8, 1.3], density: (x, z) => { if (z < hd + 0.5) return 0; const c = this.channel(x, z); return c > -2 && c < 3 ? 0.6 : 0; }, underwater: true },
      { model: 'bush', spacing: 1.8, scale: [0.7, 1.25], density: (x, z) => this.edge(x, z) * 0.7 },
      { model: 'fern', spacing: 1.5, scale: [0.7, 1.2], density: (x, z) => this.edge(x, z) * 0.6 + forest(x, z) * (this.outside(x, z) < 14 ? 0.2 : 0.05) },
      { model: 'mossrock', spacing: 2.6, scale: [0.6, 1.2], density: (x, z) => (this.edge(x, z) > 0.5 ? 0.45 : 0) },
      { model: 'log', spacing: 7, scale: [0.8, 1.2], density: (x, z) => this.edge(x, z) * 0.3 + forest(x, z) * 0.05 },
    ];
    if (!tidal) {
      // floating pads only where the water level never changes
      rules.push({ model: 'lilyflowers', spacing: 2.4, scale: [0.8, 1.3], density: (x, z) => openWater(x, z) * 0.42, onWater: true });
      rules.push({ model: 'lilypads', spacing: 2.8, scale: [0.8, 1.2], density: (x, z) => openWater(x, z) * 0.3, onWater: true });
    }
    return rules;
  }

  /** The first band of ground past the play edge. */
  private edge(x: number, z: number): number {
    const o = this.outside(x, z);
    if (o < 0.25 || o > 3 || this.plazaDist(x, z) < 0.6 || this.channel(x, z) > -0.8) return 0;
    if (z > this.halfD && Math.abs(x) < this.halfW + 4) return 0.25;
    return 1;
  }

  override details(q: Quality): BackdropRule[] {
    if (q === 'low') return [];
    const rich = q === 'high' || q === 'ultra';
    const plats = this.map.platforms ?? [];
    const offDeck = (x: number, z: number) => {
      for (const p of plats) if (Math.abs(x - p.x) < p.w / 2 + 0.4 && Math.abs(z - p.z) < p.d / 2 + 0.4) return false;
      return true;
    };
    const inPlay = (x: number, z: number) => Math.abs(x) < this.halfW - 0.3 && Math.abs(z) < this.halfD - 0.3 && this.plazaDist(x, z) > 0.3 && offDeck(x, z);
    return [
      { model: 'pebble', spacing: rich ? 1.1 : 1.6, scale: [0.7, 1.3], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -this.bankW && c < 0.1 ? 0.45 : 0; } },
      { model: 'root', spacing: rich ? 1.4 : 2.2, scale: [0.7, 1.2], density: (x, z) => { const c = this.channel(x, z); return inPlay(x, z) && c > -0.6 && c < 0.15 && !this.nearIsland(x, z) ? 0.6 : 0; }, yaw: (x, z) => this.faceRiver(x, z) },
      { model: 'pebble', spacing: rich ? 1.4 : 2.2, scale: [0.8, 1.5], density: (x, z) => (inPlay(x, z) && this.channel(x, z) > 2 ? (this.dry ? 0.55 : 0.3) : 0), underwater: true },
    ];
  }

  /** Low mist banks over the far waterway and the marsh past the near edge. */
  mist(): MistDef[] {
    const out: MistDef[] = [];
    const y = this.fullY;
    for (let i = 0; i < 26; i++) {
      const far = i < 18;
      const x = (hashVox(i, 1, 0, 401) - 0.5) * (far ? 70 : 60);
      const z = far ? -this.halfD - 4 - hashVox(i, 2, 0, 402) * 30 : this.halfD + 3 + hashVox(i, 3, 0, 403) * 8;
      out.push({ x, y: y + 0.6 + hashVox(i, 4, 0, 404) * 0.9, z, w: 12 + hashVox(i, 5, 0, 405) * 10, h: 3 + hashVox(i, 6, 0, 406) * 2.5, drift: 0.25 + hashVox(i, 7, 0, 407) * 0.35, opacity: far ? 0.32 : 0.2 });
    }
    // the sides: wisps between the forest trunks
    for (let i = 0; i < 10; i++) {
      const s = i & 1 ? 1 : -1;
      out.push({ x: s * (this.halfW + 6 + hashVox(i, 8, 0, 408) * 18), y: y + 0.8, z: (hashVox(i, 9, 0, 409) - 0.5) * 50, w: 10 + hashVox(i, 10, 0, 410) * 8, h: 3, drift: 0.2, opacity: 0.22 });
    }
    return out;
  }
}
