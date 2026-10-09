// Lantern Wharf: warm, lamp-lit setts, a broad granite quay edge with mooring rings and stone steps
// down into the water, and timber wharf decking along the quays (the reference's wharf, not
// Cogwater's grey pavement), round Cogwater's sheer stone canal, in a taller brick harbour town. Lit warehouse frontages line the canal past the far lock gate, where a stone
// arched bridge with lamps crosses it; beyond, the canal opens into the outer harbour with tall ships
// at anchor. The harbour lighthouse stands on the far-east corner of the town quay. Gas lamps light the side streets, timber cranes lean
// over the quays and cargo barges lie moored along the far canal.
import type { MapDef } from '../../../../../shared/maps/types.ts';
import { valueNoise2 } from '../../../../../shared/math.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import { LIP, SIDE, h01, jit, mix, pick, shade } from '../biome.ts';
import type { Cell, SideOut } from '../field.ts';
import type { BackdropRule } from '../flora.ts';
import type { MistDef } from '../mist.ts';
import { hashVox } from '../../../voxel/voxel.ts';
import { CogwaterBiome, type Bld } from './cogwater.ts';

const GRANITE = [0x8a8a90, 0x7e7e85, 0x96969c, 0x74747b];
/** warm granite of the broad quay edge */
const QUAY = [0x7e7872, 0x726c66, 0x88827a, 0x6a645e];
/** dark, rain-soaked wharf timber */
const TIMBER = [0x5a3c26, 0x4e3420, 0x664630, 0x46301e, 0x5e402a];
const IRON = [0x2a2c30, 0x34363a, 0x23252a];
/** rain-dark setts: warm grey-brown stones (the reference's wharf cobbles) */
const SETT = [0x5e5046, 0x6a5a4c, 0x54483e, 0x74624f, 0x5a4c40, 0x665448];
/** quay edge width (m from the canal), wharf decking out to this */
const EDGE = 1.1;
const WHARF = 3.6;
/**
 * Stone steps down into the canal, west quay (z ranges; the east quay mirrors them through the
 * centre). Clear of the bridges, the gas lamps and the bollards.
 */
const STEPS: readonly [number, number][] = [[-8.0, -6.2], [14.6, 16.4], [-20.4, -18.6]];
/** Wharf decking sections along the west quay (the east mirrors). */
const DECKS: readonly [number, number][] = [[-23, -15.6], [-3.4, 4.6], [13.2, 21]];

export class LanternwharfBiome extends CogwaterBiome {
  override readonly farColor: number = 0x1c1c22;
  readonly mistColor = 0x5a5468;
  readonly lampLight = 3.2;
  readonly lampColor = 0xffb468;
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
      if (cs < 0.5 && this.outside(x, z) < 0 && this.plazaDist(x, z) > 0.05) {
        if (this.channel(x, z) < -0.6 && out.side === SIDE.STONE) this.setts(x, z, ix, iz, out);
        this.wharf(x, z, ix, iz, out);
      }
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

  /**
   * The open quay: chunky 0.5 m setts in a running bond (2 x 2 columns each, one tone per stone, a dark
   * joint at the corner), rain-glossy, with standing puddles that mirror the lamps. Heights are left alone.
   */
  private setts(x: number, z: number, ix: number, iz: number, out: Cell): void {
    const row = Math.floor(z / 0.5);
    const sx = x / 0.5 + (row & 1) * 0.5;
    const stone = Math.floor(sx);
    const fx = sx - stone;
    const fz = z / 0.5 - row;
    let col = SETT[Math.floor(hashVox(stone, row, 0, 620) * SETT.length)];
    col = shade(col, 0.82 + hashVox(stone, row, 1, 621) * 0.32);
    if (fx < 0.5 && fz < 0.5) col = shade(col, 0.62); // the joint corner
    else if (fx < 0.5 || fz < 0.5) col = shade(col, 0.9); // a worn, rounded edge
    let rough = 0.5;
    const pud = valueNoise2(x * 0.2, z * 0.2, 622) + valueNoise2(x * 0.7, z * 0.7, 623) * 0.25;
    if (pud < 0.32) {
      // a standing puddle over the setts: dark, mirror-wet
      col = shade(mix(col, 0x1c222c, 0.45), 0.8);
      rough = 0.05;
    }
    out.top = col;
    out.rough = rough;
  }

  /**
   * The quays inside the play area: the broad granite edge (mooring rings, steps down into the water),
   * timber wharf decking behind it in sections, and Cogwater's setts elsewhere (warm, from the palette).
   * Land stays at or above the bank top minus 0.19 m, well above the full water line; the steps under
   * the water stay a hand below it, so a swimmer is never drawn standing on them.
   */
  private wharf(x: number, z: number, ix: number, iz: number, out: Cell): void {
    const c = this.channel(x, z);
    if (c > 1.85 || c < -WHARF) return;
    const T = this.T;
    const zz = x < 0 ? z : -z; // the east quay mirrors the west through the centre
    const flight = STEPS.find(([a, b]) => zz >= a && zz <= b);
    if (c > LIP) {
      if (!flight) return;
      // under the water: treads 0.4 m deep, dropping 0.4 m each, down to the canal bed
      const k = Math.floor((c - LIP) / 0.4);
      const top = this.fullY - 0.3 - k * 0.4;
      if (top <= out.h) return;
      out.h = top;
      out.q = 1 / 16;
      out.side = SIDE.STONE;
      out.top = jit(pick(QUAY, ix >> 1, k, 40), ix, iz, 0.05);
      out.rough = 0.5;
      return;
    }
    if (c > -EDGE) {
      // the broad granite edge: big dressed blocks, a darker joint every 0.75 m along the quay
      let col = jit(pick(QUAY, ix >> 1, Math.floor((zz + 40) / 0.75), 41), ix, iz, 0.04);
      if (Math.floor((zz + 40) / 0.75) !== Math.floor((zz + 40 - 0.25) / 0.75)) col = shade(col, 0.78);
      let h = T + 0.0625;
      if (flight) {
        // three steps down to the water's edge, then the flight carries on under the water
        const k = c > -0.2 ? 3 : c > -0.6 ? 2 : 1;
        h = T - 0.0625 * k;
        col = shade(jit(pick(QUAY, k, Math.floor(zz * 2), 42), ix, iz, 0.04), 1.04 - k * 0.06);
        if (((zz + 40) * 4) % 8 < 1) col = shade(col, 0.8); // the stone handrail kerb
      } else {
        // a mooring ring set into the coping every 6 m
        const rz = Math.round((zz - 3) / 6) * 6 + 3;
        const d = Math.hypot((zz - rz) * 1, (c + 0.5) * 1);
        if (d > 0.14 && d < 0.32) col = pick(IRON, ix, iz, 43);
        else if (d <= 0.08) col = shade(IRON[1], 1.4);
      }
      out.h = h;
      out.q = 1 / 16;
      out.side = SIDE.STONE;
      out.top = col;
      out.rough = 0.45;
      return;
    }
    if (DECKS.some(([a, b]) => zz >= a && zz <= b) && this.building(x, z) === null) {
      // wharf decking: planks running out to the water, one per 0.25 m row, staggered butt joints
      const plank = Math.floor(z / 0.25);
      let col = jit(pick(TIMBER, plank, 0, 44), ix, iz, 0.05);
      const seg = Math.floor((Math.abs(x) + h01(plank, 0, 45) * 3) / 3);
      if (Math.floor((Math.abs(x) - 0.25 + h01(plank, 0, 45) * 3) / 3) !== seg) col = shade(col, 0.6); // butt joint
      if ((ix & 7) === 0 && h01(ix, iz, 46) < 0.8) col = pick(IRON, ix, iz, 47); // nail heads over the bearers
      if (plank & 1) col = shade(col, 0.9);
      out.h = T + 0.0625;
      out.q = 1 / 16;
      out.side = SIDE.PLANK;
      out.top = col;
      out.rough = 0.3;
    }
  }

  override sideColor(side: number, tag: number, ix: number, iy: number, iz: number, dir: number, y0: number, y1: number, top: number, cs: number, out: SideOut): void {
    if (side === SIDE.PLANK) {
      out.color = shade(pick(TIMBER, ix + iz, iy, 48), 0.75);
      out.rough = 0.5;
      out.emit = 0;
      return;
    }
    super.sideColor(side, tag, ix, iy, iz, dir, y0, y1, top, cs, out);
  }

  /** Street gas lamps past the side edges and along the far quays, plus the wide warm halo round every lamp in play. */
  lamps(): { x: number; z: number; r: number; k: number }[] {
    // strong, tight pools round every lamp (the reference's wet stone glows orange under each lantern
    // and goes dark blue between them), not a wash of orange over the whole quay
    const out = this.streetLamps();
    for (const o of this.map.obstacles) if (o.shape === 'circle' && o.kind === 'gaslamp') out.push({ x: o.x, z: o.z, r: 7.5, k: 0.45 });
    for (const d of this.map.decor) {
      if (d.kind === 'lantern') out.push({ x: d.x, z: d.z, r: 6.5, k: 0.45 });
      else if (d.kind === 'lanternstring') out.push({ x: d.x, z: d.z, r: 4.5, k: 0.3 });
    }
    return out;
  }

  /** Street gas lamps past the side edges and along the far quays (flora set pieces and baked light). */
  private streetLamps(): { x: number; z: number; r: number; k: number }[] {
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
      { model: 'gaslamp2', spacing: 1, scale: [1, 1], density: () => 0, castShadow: true, points: this.streetLamps().map((l) => ({ x: l.x, z: l.z, yaw: 0, scale: 1 })) },
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
