// Lantern Wharf: Cogwater's rain-slick cobbles, granite coping and sheer stone canal, in a taller
// brick harbour town. Lit warehouse frontages line the canal past the far lock gate, where a stone
// arched bridge with lamps crosses it; beyond, the canal opens into the outer harbour with tall ships
// at anchor. The harbour lighthouse stands on the far-east corner of the town quay. Gas lamps light the side streets, timber cranes lean
// over the quays and cargo barges lie moored along the far canal.
import type { MapDef } from '../../../../../shared/maps/types.ts';
import { valueNoise2 } from '../../../../../shared/math.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import { SIDE, jit, pick, shade } from '../biome.ts';
import type { Cell } from '../field.ts';
import type { BackdropRule } from '../flora.ts';
import type { MistDef } from '../mist.ts';
import { hashVox } from '../../../voxel/voxel.ts';
import { CogwaterBiome, type Bld } from './cogwater.ts';

const GRANITE = [0x8a8a90, 0x7e7e85, 0x96969c, 0x74747b];

export class LanternwharfBiome extends CogwaterBiome {
  override readonly farColor: number = 0x1c1c22;
  readonly mistColor = 0x5a5468;
  readonly lampLight = 1.6;
  readonly lampColor = 0xffc27a;
  /** the outer harbour opens past this z (far end) */
  private readonly harbourZ: number;
  /** the harbour lighthouse stands on the far-east corner of the town quay, where the camera can see it */
  private readonly light = { x: 40.6, z: -27.6 };

  constructor(map: MapDef, config: MatchConfig) {
    super(map, config);
    this.harbourZ = -this.halfD - 16;
  }

  /** Taller warehouses; none past the outer harbour quay. */
  protected override building(x: number, z: number): Bld | null {
    if (z < this.harbourZ + 1.5) return null;
    if (Math.hypot(x - this.light.x, z - this.light.z) < 5.2) return null;
    const b = super.building(x, z);
    if (!b) return null;
    b.h = b.h * 1.2 + 1.2;
    if (b.style === 2 || b.style === 4) b.style = hashVox(Math.floor(b.x0), 0, Math.floor(b.z0), 600) < 0.6 ? 0 : 1; // mostly brick
    return b;
  }

  /** The outer harbour past the far end. */
  override channel(x: number, z: number): number {
    let c = super.channel(x, z);
    const hz = this.harbourZ;
    if (z < hz) {
      const open = (hz - z) * 1.6 + 1;
      if (open > c) c = open;

    }
    return c;
  }

  override sample(x: number, z: number, ix: number, iz: number, cs: number, out: Cell): void {
    if (z >= this.harbourZ) {
      super.sample(x, z, ix, iz, cs, out);
      // matt slate roofs: rain-slick glossy ones throw a glaring moon highlight at the camera
      if (out.side === SIDE.BUILDING) out.rough = 0.95;
      return;
    }
    const c = this.channel(x, z);
    const fine = cs < 0.5;
    out.tag = 0;
    out.sparkle = 0;
    if (c <= 0) {
      // granite
      out.h = this.T + 0.5;
      out.q = 0.25;
      out.side = SIDE.STONE;
      let col = jit(pick(GRANITE, ix >> 1, iz >> 1, 31), ix, iz, 0.04);
      if ((ix & 7) === 0 || (iz & 7) === 0) col = shade(col, 0.82);
      out.top = col;
      out.rough = 0.45;
      return;
    }
    out.h = this.B - 1.6 + (valueNoise2(x * 0.1, z * 0.1, 140) - 0.5) * 0.6;
    out.q = fine ? 1 / 16 : 0.5;
    out.side = SIDE.STONE;
    out.top = jit(shade(this.map.terrain.bed[0], 0.9), ix, iz, 0.08);
    out.rough = 0.5;
  }

  /** Street gas lamps past the side edges and along the far quays (flora set pieces and baked light). */
  lamps(): { x: number; z: number; r: number; k: number }[] {
    const out: { x: number; z: number; r: number; k: number }[] = [];
    for (const s of [-1, 1]) {
      for (let z = -21; z <= 21; z += 7) {
        const x = s * (this.halfW + 3.1);
        if (this.plazaDist(x, z) < 1.2 || this.building(x, z)) continue;
        out.push({ x, z: s * z, r: 5.4, k: 0.9 });
      }
      for (const z of [-27.5, -31, -37]) out.push({ x: s * 6.3, z: s < 0 ? z : z - 1.5, r: 5, k: 0.85 });
    }
    out.push({ x: this.light.x, z: this.light.z, r: 7, k: 0.9 });
    return out;
  }

  override backdrop(): BackdropRule[] {
    const hd = this.halfD;
    const hz = this.harbourZ;
    const rules = super.backdrop();
    rules.push(
      { model: 'gaslamp2', spacing: 1, scale: [1, 1], density: () => 0, castShadow: true, points: this.lamps().map((l) => ({ x: l.x, z: l.z, yaw: 0, scale: 1 })) },
      { model: 'archbridge', spacing: 1, scale: [1, 1], density: () => 0, points: [{ x: 0, z: -hd - 9.6, yaw: 0, scale: 1 }] },
      { model: 'lighthouse', spacing: 1, scale: [1, 1], density: () => 0, points: [{ x: this.light.x, z: this.light.z, yaw: 0.4, scale: 1.15 }] },
      { model: 'ship', spacing: 1, scale: [1, 1], density: () => 0, waterline: true, points: [{ x: -16, z: hz - 5, yaw: 0.25, scale: 1 }, { x: 16, z: hz - 6, yaw: -0.4, scale: 0.95 }, { x: 34, z: hz - 4.5, yaw: 1.3, scale: 0.9 }] },
      { model: 'cargobarge', spacing: 1, scale: [1, 1], density: () => 0, waterline: true, yOffset: -0.25, points: [{ x: -2.7, z: -hd - 13.2, yaw: Math.PI / 2 }, { x: -7, z: hz - 3, yaw: 0.3 }] },
      { model: 'timbercrane', spacing: 1, scale: [1, 1], density: () => 0, points: [{ x: -7.4, z: -hd - 13.6, yaw: 0 }, { x: 7.4, z: -hd - 5.8, yaw: Math.PI }] },
    );
    return rules;
  }

  /** Rain haze lying low over the far canal and the harbours. */
  mist(): MistDef[] {
    const out: MistDef[] = [];
    for (let i = 0; i < 14; i++) {
      const far = i < 9;
      out.push({
        x: (hashVox(i, 1, 0, 610) - 0.5) * (far ? 30 : 60),
        y: this.fullY + 0.9 + hashVox(i, 2, 0, 611) * 0.8,
        z: far ? -this.halfD - 6 - hashVox(i, 3, 0, 612) * 30 : this.halfD + 8 + hashVox(i, 4, 0, 613) * 10,
        w: 9 + hashVox(i, 5, 0, 614) * 8,
        h: 2.6,
        drift: 0.3,
        opacity: 0.14,
      });
    }
    return out;
  }
}
