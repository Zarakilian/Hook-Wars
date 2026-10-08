// Skin kit: a metric front end for Sculpt plus the shared surface palettes the hook skins, tethers
// and chain links paint with. Models are drawn in "design units" (du); a Builder maps du to voxels
// for the requested voxel size, so the same recipe meshes at every quality tier, and every paint
// function receives design-unit coordinates (noise scale does not change with resolution).
import type * as THREE from 'three';
import type { Quality } from '../contracts.ts';
import { Sculpt, Surf, TEAM_BIT, fbm, hashVox, meshSculpt, mix, pk, pkTeam, shade, smooth01, surfOf, vnoise, type SurfId } from './sculpt.ts';

export { Surf, TEAM_BIT, pk, pkTeam, mix, shade, hashVox, vnoise, fbm, smooth01 };
export type { SurfId };

/** Voxel edge in real metres per quality tier (the characters use 0.05 m voxels). */
export const VOXEL_M: Record<Quality, number> = { low: 0.036, medium: 0.026, high: 0.021, ultra: 0.018 };

/** Paint in design units. s = 0..1 along a tube, d = 0 axis .. 1 skin, a = 0..1 angle round the axis. */
export type MPaint = (x: number, y: number, z: number, s: number, d: number, a: number) => number;

export interface MPt {
  x: number;
  y: number;
  z: number;
  r: number;
  ry?: number;
}

export interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export class Builder {
  readonly sc: Sculpt;
  /** voxel edge in design units */
  readonly vd: number;
  /** design unit -> metres */
  readonly scale: number;
  private readonly b: Bounds;

  constructor(b: Bounds, scale: number, voxelM: number) {
    this.b = b;
    this.scale = scale;
    this.vd = voxelM / scale;
    const nx = Math.ceil((b.x1 - b.x0) / this.vd) + 2;
    const ny = Math.ceil((b.y1 - b.y0) / this.vd) + 2;
    const nz = Math.ceil((b.z1 - b.z0) / this.vd) + 2;
    this.sc = new Sculpt(nx, ny, nz);
  }

  // design units <-> voxel coordinates (continuous)
  X(x: number): number {
    return (x - this.b.x0) / this.vd + 1;
  }
  Y(y: number): number {
    return (y - this.b.y0) / this.vd + 1;
  }
  Z(z: number): number {
    return (z - this.b.z0) / this.vd + 1;
  }
  /** voxel index -> design-unit centre */
  mx(i: number): number {
    return (i + 0.5 - 1) * this.vd + this.b.x0;
  }
  my(i: number): number {
    return (i + 0.5 - 1) * this.vd + this.b.y0;
  }
  mz(i: number): number {
    return (i + 0.5 - 1) * this.vd + this.b.z0;
  }
  /** Radius in voxels. 0.72 is the smallest radius that always hits a voxel centre. */
  R(r: number): number {
    return Math.max(0.72, r / this.vd);
  }

  private wrap(p: MPaint | number): (x: number, y: number, z: number, s: number, d: number, a: number) => number {
    if (typeof p === 'number') return () => p;
    return (x, y, z, s, d, a) => p(this.mx(x), this.my(y), this.mz(z), s, d, a);
  }

  tube(pts: readonly MPt[], paint: MPaint | number, onlyEmpty = false): this {
    const vp = pts.map((p) => ({ x: this.X(p.x), y: this.Y(p.y), z: this.Z(p.z), r: this.R(p.r), ry: p.ry !== undefined ? this.R(p.ry) : undefined }));
    this.sc.tube(vp, this.wrap(paint), onlyEmpty);
    return this;
  }

  ball(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, paint: MPaint | number, onlyEmpty = false): this {
    const w = this.wrap(paint);
    this.sc.ball(this.X(cx), this.Y(cy), this.Z(cz), this.R(rx), this.R(ry), this.R(rz), (x, y, z) => w(x, y, z, 0, 0, 0), onlyEmpty);
    return this;
  }

  /** Torus. axis 0 = ring in YZ (around X), 1 = ring in XZ (lying flat, around Y), 2 = ring in XY (around Z). */
  ring(cx: number, cy: number, cz: number, axis: 0 | 1 | 2, R: number, r: number, paint: MPaint | number, stretch = 1): this {
    const w = this.wrap(paint);
    this.sc.ring(this.X(cx), this.Y(cy), this.Z(cz), axis, R / this.vd, Math.max(0.72, r / this.vd), (x, y, z) => w(x, y, z, 0, 0, 0), stretch);
    return this;
  }

  /** Fill every voxel whose centre passes the test (design units). Use a tight box to stay cheap. */
  fill(b: Bounds, test: (x: number, y: number, z: number) => boolean, paint: MPaint | number, onlyEmpty = false): this {
    const w = this.wrap(paint);
    const i0 = Math.max(0, Math.floor(this.X(b.x0)));
    const i1 = Math.min(this.sc.nx - 1, Math.ceil(this.X(b.x1)));
    const j0 = Math.max(0, Math.floor(this.Y(b.y0)));
    const j1 = Math.min(this.sc.ny - 1, Math.ceil(this.Y(b.y1)));
    const k0 = Math.max(0, Math.floor(this.Z(b.z0)));
    const k1 = Math.min(this.sc.nz - 1, Math.ceil(this.Z(b.z1)));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          if (!test(this.mx(i), this.my(j), this.mz(k))) continue;
          if (onlyEmpty && this.sc.solid(i, j, k)) continue;
          this.sc.set(i, j, k, w(i, j, k, 0, 0, 0));
        }
    return this;
  }

  /** One voxel at a design-unit point. */
  dot(x: number, y: number, z: number, v: number): this {
    this.sc.set(this.X(x), this.Y(y), this.Z(z), v);
    return this;
  }

  /** Recolour every solid voxel (design-unit centre, packed value). */
  repaint(fn: (v: number, x: number, y: number, z: number, exposure: number) => number): this {
    const sc = this.sc;
    sc.repaint((v, i, j, k) => fn(v, this.mx(i), this.my(j), this.mz(k), sc.exposure(i, j, k)));
    return this;
  }

  carve(fn: (x: number, y: number, z: number) => boolean): this {
    this.sc.carve((i, j, k) => fn(this.mx(i), this.my(j), this.mz(k)));
    return this;
  }

  /**
   * Worn edges: exposed metal and paint voxels (3+ open faces) get brighter, a few paint chips
   * show bare metal, and deep crevices (0-1 open faces next to many solids) darken with grime.
   */
  wear(seed: number, chip = 0.35): this {
    const sc = this.sc;
    const out = new Int32Array(sc.data);
    for (let k = 0; k < sc.nz; k++)
      for (let j = 0; j < sc.ny; j++)
        for (let i = 0; i < sc.nx; i++) {
          const idx = sc.idx(i, j, k);
          const v = sc.data[idx];
          if (v < 0) continue;
          const e = sc.exposure(i, j, k);
          const s = surfOf(v);
          const c = v & 0xffffff;
          const tb = v & TEAM_BIT;
          const h = hashVox(i, j, k, seed);
          if (e >= 3 && (s === Surf.Iron || s === Surf.Steel || s === Surf.Brass || s === Surf.Gold || s === Surf.Chrome)) {
            out[idx] = pk(shade(c, 1.14 + h * 0.1), s === Surf.Iron && h > 0.6 ? Surf.Steel : (s as SurfId)) + tb;
          } else if (e >= 3 && s === Surf.Paint && h < chip) {
            out[idx] = pk(mix(0x8d8a86, 0x6e6a66, h), Surf.Steel);
          } else if (e === 1 && (s === Surf.Iron || s === Surf.Rust || s === Surf.Paint)) {
            out[idx] = pk(shade(c, 0.82), s as SurfId) + tb;
          }
        }
    sc.data.set(out);
    return this;
  }

  /** Mesh with the design-unit origin at the model origin, scaled to metres. */
  mesh(o: { ao?: number; heat?: (x: number, y: number, z: number) => number } = {}): THREE.BufferGeometry {
    const heat = o.heat;
    const vd = this.vd;
    const geo = meshSculpt(this.sc, {
      size: vd * this.scale,
      pivot: [1 - this.b.x0 / vd, 1 - this.b.y0 / vd, 1 - this.b.z0 / vd],
      ao: o.ao ?? 0.5,
      // heat sees voxel-corner coordinates; convert back to design units
      heat: heat ? (x, y, z) => heat((x - 1) * vd + this.b.x0, (y - 1) * vd + this.b.y0, (z - 1) * vd + this.b.z0) : undefined,
    });
    return geo;
  }

  get empty(): boolean {
    for (let i = 0; i < this.sc.data.length; i++) if (this.sc.data[i] >= 0) return false;
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Surface palettes (all return packed colour + surface)
// ---------------------------------------------------------------------------------------------

/** Pick from a palette with smooth noise (patchy, not salt and pepper), plus a little jitter. */
export function pal(p: readonly number[], t: number, jitter: number, h: number): number {
  const i = Math.max(0, Math.min(p.length - 1, Math.floor(t * p.length)));
  return shade(p[i], 1 + (h - 0.5) * 2 * jitter);
}

const IRON_P = [0x6a6762, 0x77736d, 0x85807a, 0x928d86];
const RUST_P = [0x6a3418, 0x86421c, 0x9c5022, 0xb2602a, 0xc87634];
const GRIME = 0x3a302a;

/** Weathered iron with rust blooms. rust 0..1 = how much of the surface is rusted. */
export function rustyIron(seed: number, rust = 0.4, scale = 0.07): MPaint {
  return (x, y, z) => {
    const n = fbm(x / scale, y / scale, z / scale, 1, seed);
    const m = vnoise(x / (scale * 0.4), y / (scale * 0.4), z / (scale * 0.4), 1, seed + 7);
    const h = hashVox(Math.floor(x * 97), Math.floor(y * 97), Math.floor(z * 97), seed);
    const r = n + m * 0.25;
    if (r > 1.05 - rust * 0.55) return pk(pal(RUST_P, smooth01(1.05 - rust * 0.55, 1.2, r), 0.05, h), Surf.Rust);
    if (r > 0.98 - rust * 0.55) return pk(mix(pal(IRON_P, m, 0.04, h), 0x7a4a2a, 0.45), Surf.Iron);
    if (m < 0.18) return pk(shade(GRIME, 1 + (h - 0.5) * 0.2), Surf.Iron);
    return pk(pal(IRON_P, m, 0.05, h), Surf.Iron);
  };
}

/** Bright worked steel (cutting edges). */
export function steelEdge(seed: number): MPaint {
  return (x, y, z) => {
    const h = hashVox(Math.floor(x * 97), Math.floor(y * 97), Math.floor(z * 97), seed);
    return pk(shade(h > 0.5 ? 0xc9ced3 : 0xb3b9c0, 0.95 + h * 0.1), Surf.Steel);
  };
}

/** Chipped enamel over iron. chips 0..1. */
export function chippedPaint(base: number, seed: number, chips = 0.18, scale = 0.05): MPaint {
  const iron = rustyIron(seed + 3, 0.7, scale * 1.2);
  return (x, y, z, s, d, a) => {
    const n = vnoise(x / scale, y / scale, z / scale, 1, seed);
    if (n < chips) return iron(x, y, z, s, d, a);
    const h = hashVox(Math.floor(x * 89), Math.floor(y * 89), Math.floor(z * 89), seed);
    const fade = vnoise(x / (scale * 3), y / (scale * 3), z / (scale * 3), 1, seed + 11);
    // rust streaks running down from the chips (toward -y on the held model, -z in flight it is fine)
    const streak = vnoise(x / (scale * 0.35), 0, z / (scale * 2.5), 1, seed + 5);
    const c = streak > 0.82 ? mix(base, 0x7a3c1a, 0.45) : shade(base, 0.86 + fade * 0.22 + (h - 0.5) * 0.06);
    return pk(c, Surf.Paint);
  };
}

/**
 * Laid rope for tubes: `a` (angle round the axis) and `s` (along) make the strands spiral.
 * tone 0 = hemp brown, 1 = dark tarred, 2 = pale manila. lay = strand turns over the whole tube.
 */
export function rope(seed: number, tone: 0 | 1 | 2 = 0, strands = 3, lay = 9): MPaint {
  const P =
    tone === 1
      ? [0x1e1a17, 0x2a241f, 0x352d26, 0x40372e]
      : tone === 2
        ? [0x9c8056, 0xb59a6a, 0xc8ae7c, 0xd8c08e]
        : [0x4e341e, 0x664428, 0x7c5532, 0x93683e];
  const groove = tone === 1 ? 0x100d0b : tone === 2 ? 0x6e5838 : 0x2e1e12;
  const surf = tone === 1 ? Surf.Tar : Surf.Rope;
  return (x, y, z, s, d, a) => {
    const f = (((a * strands + s * lay) % 1) + 1) % 1;
    const h = hashVox(Math.floor(x * 113), Math.floor(y * 113), Math.floor(z * 113), seed);
    if (f < 0.17) return pk(shade(groove, 0.9 + h * 0.2), surf);
    const k = Math.sin(((f - 0.17) / 0.83) * Math.PI);
    return pk(pal(P, k * 0.999, 0.06, h), surf);
  };
}

/** Length of a design-unit polyline (for lay counts). */
export function pathLen(pts: readonly MPt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  return L;
}

const IVORY_P = [0xb8a888, 0xcbbc98, 0xdccdaa, 0xe8dcbe, 0xf2e8d0];
/** Old ivory: growth bands along the tusk, yellowed and grimy toward the base. */
export function ivory(seed: number, bands = 9): MPaint {
  return (x, y, z, s, d) => {
    const h = hashVox(Math.floor(x * 101), Math.floor(y * 101), Math.floor(z * 101), seed);
    const n = vnoise(x / 0.05, y / 0.05, z / 0.05, 1, seed);
    const band = Math.abs(((s * bands) % 1) - 0.5) < 0.07 && d > 0.6;
    const age = smooth01(0.6, 0.05, s); // base is older and darker
    let c = pal(IVORY_P, Math.min(0.999, 0.25 + n * 0.75 - age * 0.25), 0.04, h);
    if (band) c = shade(c, 0.78);
    if (n < 0.12) c = mix(c, 0x6e6a3a, 0.35); // grime in the pores
    return pk(c, Surf.Ivory);
  };
}

const MOSS_P = [0x2f4a16, 0x3d5e1c, 0x4f7424, 0x648c2e, 0x7ea23a];
export function moss(seed: number, wet = true): MPaint {
  return (x, y, z) => {
    const h = hashVox(Math.floor(x * 131), Math.floor(y * 131), Math.floor(z * 131), seed);
    const n = vnoise(x / 0.03, y / 0.03, z / 0.03, 1, seed);
    return pk(pal(MOSS_P, n * 0.999, 0.08, h), wet && n > 0.45 ? Surf.Wet : Surf.Leaf);
  };
}

const VINE_P = [0x2c3a14, 0x3a4c1a, 0x4b5e22, 0x5a6e2a];
const BARK_P = [0x2e2014, 0x3c2a1a, 0x4a3420, 0x5a4028, 0x6a4c30];
/** Twisted vine: green with bark ribs. */
export function vine(seed: number, barky = 0.35): MPaint {
  return (x, y, z, s, _d, a) => {
    const h = hashVox(Math.floor(x * 127), Math.floor(y * 127), Math.floor(z * 127), seed);
    const n = vnoise(x / 0.04, y / 0.04, z / 0.04, 1, seed);
    const rib = Math.abs(((s * 14 + a * 2) % 1) - 0.5) < 0.12;
    if (n < barky || rib) return pk(pal(BARK_P, n, 0.06, h), Surf.Wood);
    return pk(pal(VINE_P, n * 0.999, 0.06, h), Surf.Leaf);
  };
}

/** Gnarled root bark with knots. */
export function bark(seed: number): MPaint {
  return (x, y, z, s, d) => {
    const h = hashVox(Math.floor(x * 127), Math.floor(y * 127), Math.floor(z * 127), seed);
    const n = fbm(x / 0.05, y / 0.05, z / 0.05, 1, seed);
    const groove = Math.abs(((s * 22 + n * 1.3) % 1) - 0.5) < 0.1 && d > 0.6;
    const c = pal(BARK_P, Math.min(0.999, n), 0.07, h);
    return pk(groove ? shade(c, 0.62) : c, Surf.Wood);
  };
}

const LEAF_P = [0x3e6e1e, 0x4f8424, 0x62982c, 0x78ae36, 0x8ec444];
export function leafy(seed: number): MPaint {
  return (x, y, z) => {
    const h = hashVox(Math.floor(x * 131), Math.floor(y * 131), Math.floor(z * 131), seed);
    const n = vnoise(x / 0.025, y / 0.025, z / 0.025, 1, seed);
    return pk(pal(LEAF_P, n * 0.999, 0.05, h), Surf.Leaf);
  };
}

const GOLD_P = [0xc08a1c, 0xd8a426, 0xecbc34, 0xf8d050, 0xffe486];
export function gold(seed: number): MPaint {
  return (x, y, z) => {
    const h = hashVox(Math.floor(x * 97), Math.floor(y * 97), Math.floor(z * 97), seed);
    const n = vnoise(x / 0.045, y / 0.045, z / 0.045, 1, seed);
    return pk(pal(GOLD_P, Math.min(0.999, 0.15 + n * 0.85), 0.03, h), Surf.Gold);
  };
}

const SCALE_P = [0x2a3a1a, 0x34481e, 0x3e5424, 0x4a602a];
/** Croc hide: scutes in a grid with dark seams. */
export function crocHide(seed: number): MPaint {
  return (x, y, z) => {
    const h = hashVox(Math.floor(x * 131), Math.floor(y * 131), Math.floor(z * 131), seed);
    const gx = Math.abs(((x / 0.06) % 1 + 1) % 1 - 0.5);
    const gz = Math.abs(((z / 0.07) % 1 + 1) % 1 - 0.5);
    if (gx > 0.4 || gz > 0.42) return pk(shade(0x1a2210, 0.9 + h * 0.2), Surf.Leaf);
    const n = vnoise(x / 0.05, y / 0.05, z / 0.05, 1, seed);
    return pk(pal(SCALE_P, n * 0.999, 0.06, h), Surf.Wet);
  };
}

/** Team-tinted voxel: neutral light grey with the team flag (the material multiplies the team colour). */
export function teamWhite(seed: number, surf: SurfId = Surf.Paint, base = 0xeaeaea): MPaint {
  return (x, y, z) => {
    const h = hashVox(Math.floor(x * 97), Math.floor(y * 97), Math.floor(z * 97), seed);
    const n = vnoise(x / 0.04, y / 0.04, z / 0.04, 1, seed);
    return pkTeam(shade(base, 0.84 + n * 0.18 + (h - 0.5) * 0.06), surf);
  };
}

/** Team paint chipped down to the iron underneath. */
export function teamPaint(seed: number, chips = 0.22, scale = 0.04): MPaint {
  const iron = rustyIron(seed + 9, 0.6, scale);
  const tw = teamWhite(seed);
  return (x, y, z, s, d, a) => (vnoise(x / scale, y / scale, z / scale, 1, seed) < chips ? iron(x, y, z, s, d, a) : tw(x, y, z, s, d, a));
}

export function solid(c: number, surf: SurfId, seed = 1, jitter = 0.05): MPaint {
  return (x, y, z) => pk(shade(c, 1 + (hashVox(Math.floor(x * 97), Math.floor(y * 97), Math.floor(z * 97), seed) - 0.5) * 2 * jitter), surf);
}
