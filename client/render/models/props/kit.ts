// Shared building kit for the reference-map props, decor and platforms: biome themes, wood, rope,
// iron, stone and snow colour functions, lantern cages and the materials they use.
// All helpers paint into a PGrid in voxel coordinates.
import type { MapDef } from '../../../../shared/maps/types.ts';
import { CH, curve, h3, mix, PGrid, pmat, seg, shade, vn3, type CFn } from './common.ts';
import { iceMat } from './rocks.ts';

export type Theme = 'marsh' | 'ice' | 'tropic' | 'wharf';

/** Visual theme for a map (wood tone, grime, snow, barnacles). */
export function themeOf(map: Pick<MapDef, 'id' | 'atmosphere'>): Theme {
  switch (map.id) {
    case 'muckmire':
    case 'mirelight':
      return 'marsh';
    case 'frostfang':
    case 'aurora':
      return 'ice';
    case 'coralcove':
    case 'maelstrom':
      return 'tropic';
    case 'cogwater':
    case 'lanternwharf':
      return 'wharf';
    default:
      return map.atmosphere.weather === 'snow' ? 'ice' : map.atmosphere.weather === 'rain' ? 'wharf' : 'marsh';
  }
}

/** Plank palettes per theme: dark wet swamp wood, cold weathered timber, sun-bleached driftwood, tarred harbour oak. */
export const WOOD: Record<Theme, readonly number[]> = {
  marsh: [0x5a3e26, 0x664629, 0x70502f, 0x4e3622, 0x7a5834, 0x5f4428],
  ice: [0x5a4634, 0x66503b, 0x4c3b2c, 0x725a40, 0x5e4a36],
  tropic: [0x9a7a52, 0xa8885c, 0x8a6c48, 0xb69868, 0x947450],
  wharf: [0x4a3828, 0x56412e, 0x3e3022, 0x624a34, 0x4f3c2b],
};

/** Wood roughness per theme: the rainy wharf and the swamp are wet, the cove is dry and bleached. */
export function woodRough(t: Theme): number {
  return t === 'wharf' ? 0.52 : t === 'marsh' ? 0.68 : t === 'ice' ? 0.82 : 0.86;
}

export const mats = {
  wood: (t: Theme) => pmat({ rough: woodRough(t) }),
  dry: () => pmat({ rough: 0.9 }),
  iron: () => pmat({ metal: 0.72, rough: 0.42 }),
  rust: () => pmat({ metal: 0.35, rough: 0.78 }),
  brass: () => pmat({ metal: 0.9, rough: 0.3 }),
  glow: (s = 3.2, flicker = 0.22) => pmat({ glow: s, flicker }),
  /** shared lantern flame glass: one material (one batch) for every lamp on a map */
  lamp: () => pmat({ glow: 3.3, flicker: 0.18 }),
  /** shared lit-window glass */
  window: () => pmat({ glow: 2.7, flicker: 0.1 }),
  ice: () => iceMat(),
  stone: (wet = false) => pmat({ rough: wet ? 0.58 : 0.9 }),
  leaf: (sway = 0.05, h = 2) => pmat({ rough: 0.9, sway, swayH: h }),
  gold: () => pmat({ metal: 0.95, rough: 0.22 }),
};

/** Wood with grain streaks along an axis (0 = x, 1 = y, 2 = z) and per-board tone. */
export function grain(pal: readonly number[], seed: number, axis: 0 | 1 | 2 = 1): CFn {
  const sx = axis === 0 ? 0.05 : 0.45;
  const sy = axis === 1 ? 0.05 : 0.45;
  const sz = axis === 2 ? 0.05 : 0.45;
  return (x, y, z) => {
    const t = vn3(x * sx, y * sy, z * sz, seed) * 0.78 + h3(x, y, z, seed) * 0.22;
    return pal[Math.min(pal.length - 1, Math.floor(t * pal.length))];
  };
}

/** Twisted rope colour. */
export const ropeCol: CFn = (x, y, z) => ((x + y * 2 + z) % 4 < 2 ? 0xc8a46e : 0x9c7c4c);
/** Old dark rope (wet, tarred). */
export const ropeDark: CFn = (x, y, z) => ((x + y * 2 + z) % 4 < 2 ? 0x8a7050 : 0x6a5438);

/** Iron with a few rust (orange-brown) and worn spots. Rust is weathering, never red stains. */
export function ironCol(seed = 0, rust = 0.18): CFn {
  return (x, y, z) => {
    const r = vn3(x * 0.35, y * 0.35, z * 0.35, seed + 41);
    if (r > 1 - rust) return h3(x, y, z, seed) < 0.5 ? 0x7a4a26 : 0x8e5a30;
    return h3(x, y, z, seed + 1) < 0.18 ? 0x3c434c : 0x272c33;
  };
}

/** Running-bond block pattern: bw x bh voxel blocks with dark mortar joints. Works on x/z faces. */
export function blocks(pal: readonly number[], bw: number, bh: number, seed: number, mortar = 0.66): CFn {
  return (x, y, z) => {
    const row = Math.floor(y / bh);
    const u = x + z + (row % 2) * Math.floor(bw / 2);
    const col = Math.floor(u / bw);
    if (y % bh === 0 || u % bw === 0) return shade(pal[Math.floor(h3(row, col, 7, seed) * pal.length)], mortar);
    const base = pal[Math.floor(h3(row, col, 3, seed) * pal.length)];
    return shade(base, 0.9 + h3(x, y, z, seed) * 0.16);
  };
}

/** Snow with soft blue shading. */
export const snowCol: CFn = (x, y, z) => (h3(x, y, z, 3) < 0.22 ? 0xd8e6f6 : h3(x, y, z, 4) < 0.5 ? 0xf4f8ff : 0xe8f0fb);

/** Sagging rope between two voxel points, sag in voxels. */
export function sagRope(g: PGrid, a: [number, number, number], b: [number, number, number], sag: number, col: CFn = ropeCol, r = 0.5): void {
  const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - sag * 2, (a[2] + b[2]) / 2];
  curve(g, a, mid, b, r, r, col);
}

/** Rope wound around a vertical post (a band of rings). */
export function ropeWrap(g: PGrid, cx: number, cz: number, rr: number, y0: number, turns: number, col: CFn = ropeCol): void {
  for (let k = 0; k < turns; k++) {
    const n = Math.max(8, Math.ceil(rr * 8));
    for (let t = 0; t < n; t++) {
      const a = (t / n) * Math.PI * 2;
      g.set(cx + Math.cos(a) * rr, y0 + k, cz + Math.sin(a) * rr, col(t, k, 0));
    }
  }
}

/**
 * A hanging lantern: iron cap, frame corners and base, glowing panes inside. Bottom at y0, half size s
 * (s = 2 makes a 5 x 5 lantern). Returns the voxel centre of the light for the halo.
 */
export function lanternCage(g: PGrid, cx: number, y0: number, cz: number, s: number, h: number, glow: number, iron: CFn = ironCol(3, 0.08)): [number, number, number] {
  g.on(CH.metal, () => {
    g.box(cx - s, y0, cz - s, cx + s, y0, cz + s, iron);
    for (const sx of [-s, s]) for (const sz of [-s, s]) g.box(cx + sx, y0 + 1, cz + sz, cx + sx, y0 + h, cz + sz, iron);
    g.box(cx - s, y0 + h + 1, cz - s, cx + s, y0 + h + 1, cz + s, iron);
    g.box(cx - s + 1, y0 + h + 2, cz - s + 1, cx + s - 1, y0 + h + 2, cz + s - 1, iron);
    g.set(cx, y0 + h + 3, cz, iron(cx, y0, cz));
  });
  const warm = mix(glow, 0xffffff, 0.45);
  g.on(CH.glow, () =>
    g.box(cx - s + 1, y0 + 1, cz - s + 1, cx + s - 1, y0 + h, cz + s - 1, (x, y, z) => (Math.abs(x - cx) < s - 1 && Math.abs(z - cz) < s - 1 ? warm : h3(x, y, z) < 0.3 ? shade(glow, 0.85) : glow)),
  );
  return [cx + 0.5, y0 + 1 + h / 2, cz + 0.5];
}

/** A round post (log) between y0 and y1 with grain, optional dark wet foot below wetY. */
export function post(g: PGrid, cx: number, cz: number, r: number, y0: number, y1: number, col: CFn, wetY = -1e9, wet: CFn | null = null): void {
  for (let y = y0; y <= y1; y++)
    for (let z = Math.floor(cz - r - 1); z <= Math.ceil(cz + r + 1); z++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const dx = x + 0.5 - cx;
        const dz = z + 0.5 - cz;
        if (dx * dx + dz * dz > r * r) continue;
        g.set(x, y, z, y < wetY && wet ? wet(x, y, z) : col(x, y, z));
      }
}

/** Square timber between two points (radius r voxels), cheap wrapper over seg. */
export function beam(g: PGrid, a: [number, number, number], b: [number, number, number], col: CFn, r = 1): void {
  seg(g, a[0], a[1], a[2], b[0], b[1], b[2], col, r);
}

/** Grime toward the waterline: algae green on marsh/wharf, barnacles on tropic, frost on ice. */
export function waterline(t: Theme): (c: number, x: number, y: number, z: number, wy: number) => number {
  return (c, x, y, z, wy) => {
    const d = y - wy;
    if (d > 3) return c;
    if (t === 'ice') return d > -2 ? (h3(x, y, z, 9) < 0.55 ? mix(c, 0xe8f4ff, 0.75) : c) : mix(c, 0x2a3a4a, 0.35);
    if (t === 'tropic') return d > -3 && h3(x, y, z, 5) < 0.22 ? 0xe8e0d0 : d < 0 ? mix(c, 0x3a5a4a, 0.4) : mix(c, 0x6a7a50, 0.25);
    return d > -1 ? mix(c, 0x3a5a2a, h3(x, y, z, 6) < 0.6 ? 0.55 : 0.3) : mix(c, 0x26302a, 0.45);
  };
}

export { CH, h3, mix, shade, vn3 };
