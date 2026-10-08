// Rocks and standing things: mossrock, icerock, icepillar, runestone, coralrock, reefpost, tikitotem.
import { blob, blotch, capTop, CH, curve, fbm3, h3, mix, PGrid, pmat, rngFor, seg, shade, taper, toModel, vn3, type PropModel } from './common.ts';

const SINK = 3;

export const iceMat = () => pmat({ rough: 0.16, metal: 0.05, rim: 0.55, rimColor: 0x9fe6ff });
const stoneMat = () => pmat({ rough: 0.93 });

// ---------------------------------------------------------------------------------------------

export function buildMossRock(r: number, seed: number): PropModel {
  const V = 0.1;
  const rnd = rngFor(seed * 41 + 9);
  const rv = r / V;
  const n = Math.ceil(rv * 2.6 + 6);
  const g = new PGrid(n, Math.ceil(rv * 1.6) + SINK + 4, n);
  const cx = n / 2;
  const cz = n / 2;
  const stone = blotch([0x55574f, 0x5f6158, 0x6b6c62, 0x76776c, 0x828377], 0.16, seed, 0.3);
  const ry = rv * 0.92;
  blob(g, cx, SINK + ry * 0.42, cz, rv * 1.02, ry, rv * 0.96, 0.18, seed, stone, 0.12);
  // a smaller shoulder boulder
  const a = rnd() * Math.PI * 2;
  blob(g, cx + Math.cos(a) * rv * 0.55, SINK + rv * 0.2, cz + Math.sin(a) * rv * 0.55, rv * 0.55, rv * 0.5, rv * 0.5, 0.2, seed + 5, stone, 0.18);
  // cracks
  g.recolor((c, x, y, z) => {
    const k = Math.abs(vn3(x * 0.18, y * 0.18, z * 0.18, seed + 31) - 0.5);
    return k < 0.025 ? shade(c, 0.55) : c;
  });
  // thick moss cap and dripping moss down the sides
  const moss = blotch([0x3f5a22, 0x4c6a28, 0x5a7a2e, 0x668a34, 0x76983c], 0.22, seed + 3, 0.3);
  capTop(g, 3, (x, y, z) => y > SINK + rv * 0.35 && fbm3(x * 0.15, y * 0.1, z * 0.15, seed + 2) > 0.36, moss);
  g.recolor((c, x, y, z) => (y > SINK && y < SINK + rv && fbm3(x * 0.2, y * 0.35, z * 0.2, seed + 8) > 0.66 ? moss(x, y, z) : c));
  // tiny glowing toadstools and fern sprigs on top
  for (let k = 0; k < 4; k++) {
    const x = Math.floor(cx + (rnd() - 0.5) * rv * 1.1);
    const z = Math.floor(cz + (rnd() - 0.5) * rv * 1.1);
    let y = g.ny - 1;
    while (y > 0 && !g.solid(x, y, z)) y--;
    if (y <= SINK) continue;
    if (k < 2) {
      g.set(x, y + 1, z, 0xe8e0c8);
      g.on(CH.glow, () => {
        g.set(x, y + 2, z, 0x6ae8ff);
        g.set(x + 1, y + 2, z, 0x58d0f0);
        g.set(x, y + 2, z + 1, 0x58d0f0);
      });
    } else {
      g.on(CH.leaf, () => {
        for (let j = 1; j < 4; j++) {
          g.set(x, y + j, z, 0x6f9a38);
          if (j > 1) g.set(x + (j % 2 ? 1 : -1), y + j, z, 0x7fa842);
        }
      });
    }
  }
  return toModel(g, V, { [CH.base]: stoneMat(), [CH.leaf]: pmat({ rough: 0.9, sway: 0.03, swayH: 1.6 }), [CH.glow]: pmat({ glow: 2.2, pulse: 0.3, rough: 0.5 }) }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------

/** Faceted crystal body: intersection of half-spaces. Returns facet index or -1. */
function facetTest(planes: { n: [number, number, number]; d: number }[], dx: number, dy: number, dz: number): number {
  let best = -1;
  let bestGap = 1e9;
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    const v = dx * p.n[0] + dy * p.n[1] + dz * p.n[2];
    if (v > p.d) return -1;
    const gap = p.d - v;
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

export function buildIceRock(r: number, seed: number): PropModel {
  const V = 0.1;
  const rnd = rngFor(seed * 43 + 1);
  const rv = r / V;
  const n = Math.ceil(rv * 2.4 + 6);
  const H = Math.ceil(rv * 1.5) + SINK + 4;
  const g = new PGrid(n, H, n);
  const cx = n / 2;
  const cz = n / 2;
  const cy = SINK + rv * 0.35;
  const planes: { n: [number, number, number]; d: number }[] = [];
  const np = 11;
  for (let i = 0; i < np; i++) {
    const a = (i / np) * Math.PI * 2 + rnd() * 0.4;
    const el = i % 3 === 0 ? 0.9 + rnd() * 0.3 : 0.15 + rnd() * 0.5;
    const nx = Math.cos(a) * Math.cos(el);
    const ny = Math.sin(el);
    const nz = Math.sin(a) * Math.cos(el);
    planes.push({ n: [nx, ny, nz], d: rv * (0.82 + rnd() * 0.2) * (ny > 0.6 ? 0.95 : 1) });
  }
  planes.push({ n: [0, 1, 0], d: rv * 1.05 });
  const tints = [0xcdeefc, 0xb5e2f8, 0xa2d6f4, 0xd9f4ff, 0x92cbee, 0xbfe8fa];
  g.on(CH.ice, () => {
    for (let z = 0; z < n; z++)
      for (let y = 0; y < H; y++)
        for (let x = 0; x < n; x++) {
          const f = facetTest(planes, x + 0.5 - cx, (y + 0.5 - cy) * 1.15, z + 0.5 - cz);
          if (f < 0) continue;
          const base = tints[f % tints.length];
          const deep = y < SINK + 2 ? 0.82 : 1;
          g.set(x, y, z, shade(base, deep * (0.96 + h3(x, y, z, seed) * 0.08)));
        }
  });
  // internal fracture lines show as darker blue veins
  g.recolor((c, x, y, z) => (Math.abs(vn3(x * 0.15, y * 0.15, z * 0.15, seed + 9) - 0.5) < 0.02 ? mix(c, 0x5aa0d8, 0.6) : c));
  // snow caps on the flatter top facets
  const snow = (x: number, y: number, z: number) => (h3(x, y, z, 2) < 0.3 ? 0xe6f0fb : 0xf6fbff);
  g.on(CH.base, () => capTop(g, 1, (x, y, z) => y > cy + rv * 0.35 && vn3(x * 0.25, 0, z * 0.25, seed + 4) > 0.4, snow));
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.8 }), [CH.ice]: iceMat() }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------

function hexD(dx: number, dz: number): number {
  const ax = Math.abs(dx);
  const az = Math.abs(dz);
  return Math.max(az, ax * 0.866 + az * 0.5);
}

function prism(g: PGrid, cx: number, cz: number, r: number, y0: number, h: number, leanX: number, leanZ: number, seed: number, glowVeins: boolean): void {
  const tipStart = h - r * 1.4;
  const tints = [0xbfe8fb, 0xa8dcf6, 0xd4f2ff, 0x96cdef];
  for (let yy = 0; yy <= h; yy++) {
    const rr = yy < tipStart ? r : r * (1 - (yy - tipStart) / (h - tipStart));
    if (rr <= 0.2) continue;
    const ox = cx + leanX * yy;
    const oz = cz + leanZ * yy;
    for (let z = Math.floor(oz - rr - 1); z <= oz + rr + 1; z++)
      for (let x = Math.floor(ox - rr - 1); x <= ox + rr + 1; x++) {
        const dx = x + 0.5 - ox;
        const dz = z + 0.5 - oz;
        const d = hexD(dx, dz);
        if (d > rr) continue;
        const y = y0 + yy;
        const face = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2)) * 6 + 0.5) % 6;
        const vein = glowVeins && d > rr - 1.2 && Math.abs(vn3(x * 0.3, y * 0.08, z * 0.3, seed) - 0.5) < 0.05;
        if (vein) g.on(CH.glow, () => g.set(x, y, z, h3(x, y, z) < 0.5 ? 0x7ff4ff : 0x5ae0ff));
        else g.on(CH.ice, () => g.set(x, y, z, shade(tints[face % tints.length], 0.95 + h3(x, y, z, seed) * 0.08)));
      }
  }
}

export function buildIcePillar(r: number, seed: number): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 47 + 3);
  const rv = r / V;
  const n = Math.ceil(rv * 3 + 8);
  const H = 40;
  const g = new PGrid(n, H + SINK + 2, n);
  const cx = n / 2;
  const cz = n / 2;
  // frosty base mound
  const snow = (x: number, y: number, z: number) => (h3(x, y, z, 2) < 0.3 ? 0xdde9f6 : 0xf2f8ff);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) / (rv * 1.15);
      if (d > 1) continue;
      const hh = Math.floor((1 - d * d) * 3 + vn3(x * 0.3, 0, z * 0.3, seed) * 2);
      for (let y = 0; y <= SINK + hh; y++) g.set(x, y, z, snow(x, y, z));
    }
  prism(g, cx, cz, rv * 0.78, SINK, H - 2, 0.02, -0.015, seed, true);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + rnd();
    const d = rv * 0.75;
    const px = cx + Math.cos(a) * d;
    const pz = cz + Math.sin(a) * d;
    prism(g, px, pz, rv * (0.3 + rnd() * 0.15), SINK - 1, Math.floor(10 + rnd() * 12), Math.cos(a) * 0.18, Math.sin(a) * 0.18, seed + k, k % 2 === 0);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.8 }), [CH.ice]: iceMat(), [CH.glow]: pmat({ glow: 2.4, pulse: 0.5, rough: 0.2 }) }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------

const GLYPHS: readonly string[][] = [
  ['#...#', '.#.#.', '..#..', '..#..', '..#..'],
  ['#####', '#...#', '..#..', '#...#', '#####'],
  ['..#..', '.###.', '#.#.#', '..#..', '.#.#.'],
  ['####.', '...#.', '.#.#.', '.###.', '.....'],
  ['#.#.#', '#.#.#', '.###.', '..#..', '..#..'],
  ['.###.', '#...#', '#.#.#', '#...#', '.###.'],
];

export function buildRunestone(r: number, seed: number): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 53 + 7);
  const rv = r / V;
  const W = Math.round(rv * 1.6);
  const D = Math.round(rv * 1.0);
  const n = Math.ceil(rv * 2.6 + 6);
  const H = 34;
  const g = new PGrid(n, H + SINK + 3, n);
  const cx = n / 2;
  const cz = n / 2;
  const granite = blotch([0x545b66, 0x5e6571, 0x69707b, 0x737a85, 0x4b525d], 0.2, seed, 0.35);
  const x0 = Math.floor(cx - W / 2);
  const z0 = Math.floor(cz - D / 2);
  for (let y = 0; y <= SINK + H; y++) {
    const t = (y - SINK) / H;
    const shrink = t > 0.75 ? Math.pow((t - 0.75) / 0.25, 1.6) * W * 0.4 : 0;
    const lean = Math.floor(t * 2);
    for (let z = z0; z < z0 + D; z++)
      for (let x = x0; x < x0 + W; x++) {
        const ex = Math.min(x - x0, x0 + W - 1 - x);
        const ez = Math.min(z - z0, z0 + D - 1 - z);
        if (ex < shrink * 0.5 || (t > 0.75 && ex + ez < shrink * 0.7)) continue;
        if (ex === 0 && ez === 0 && h3(x, y, z, 1) < 0.5) continue; // chipped corners
        g.set(x + lean, y, z, granite(x, y, z));
      }
  }
  // carved glowing glyphs on front and back
  const order = [Math.floor(rnd() * 6), Math.floor(rnd() * 6), Math.floor(rnd() * 6)];
  g.on(CH.glow, () => {
    for (let k = 0; k < 3; k++) {
      const gl = GLYPHS[order[k]];
      const gy = SINK + H - 12 - k * 7;
      const lean = Math.floor(((gy - SINK) / H) * 2);
      for (let row = 0; row < 5; row++)
        for (let col = 0; col < 5; col++) {
          if (gl[row][col] !== '#') continue;
          const x = Math.floor(cx - 2 + col) + lean;
          const y = gy + (4 - row);
          g.set(x, y, z0 + D - 1, 0x6af7d0);
          g.set(Math.floor(cx + 2 - col) + lean, y, z0, 0x6af7d0);
        }
    }
  });
  // lichen and snow cap
  g.recolor((c, x, y, z) => (g.chanAt(x, y, z) === CH.base && fbm3(x * 0.25, y * 0.25, z * 0.25, seed + 4) > 0.68 ? mix(c, 0x9aa86a, 0.5) : c));
  capTop(g, 1, (x, y, z) => g.chanAt(x, y, z) === CH.base && y > SINK + H * 0.6, (x, y, z) => (h3(x, y, z) < 0.4 ? 0xe8f1fb : 0xf7fbff));
  // ring of small stones
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + rnd() * 0.3;
    const d = rv * 1.05;
    blob(g, cx + Math.cos(a) * d, SINK, cz + Math.sin(a) * d, 1.8, 1.5, 1.8, 0.2, seed + k, granite, 0.4);
  }
  return toModel(g, V, { [CH.base]: stoneMat(), [CH.glow]: pmat({ glow: 3, pulse: 0.45, rough: 0.4 }) }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------

export function coralBranch(g: PGrid, x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, depth: number, col: number, rnd: () => number): void {
  const ex = x + dx * len;
  const ey = y + dy * len;
  const ez = z + dz * len;
  seg(g, x, y, z, ex, ey, ez, (xx, yy, zz) => shade(col, 0.9 + h3(xx, yy, zz) * 0.2), depth > 1 ? 0.7 : 0);
  if (depth <= 0) {
    g.set(ex, ey + 1, ez, mix(col, 0xffffff, 0.45));
    return;
  }
  for (let k = 0; k < 2; k++) {
    const a = rnd() * Math.PI * 2;
    const ndx = dx * 0.5 + Math.cos(a) * 0.6;
    const ndz = dz * 0.5 + Math.sin(a) * 0.6;
    const ndy = 0.8;
    const l = Math.hypot(ndx, ndy, ndz);
    coralBranch(g, ex, ey, ez, ndx / l, ndy / l, ndz / l, len * 0.7, depth - 1, col, rnd);
  }
}

export function buildCoralRock(r: number, seed: number): PropModel {
  const V = 0.1;
  const rnd = rngFor(seed * 59 + 5);
  const rv = r / V;
  const n = Math.ceil(rv * 2.6 + 8);
  const g = new PGrid(n, Math.ceil(rv * 1.8) + SINK + 6, n);
  const cx = n / 2;
  const cz = n / 2;
  const lime = blotch([0xc4b28c, 0xd2c29e, 0xddd0ae, 0xb8a680, 0xe6dcbe], 0.2, seed, 0.35);
  blob(g, cx, SINK + rv * 0.3, cz, rv * 1.0, rv * 0.78, rv * 0.95, 0.22, seed, lime, 0.14);
  // pores
  g.recolor((c, x, y, z) => (h3(x, y, z, seed + 1) < 0.07 ? shade(c, 0.62) : c));
  // pastel algae fringe at the base
  g.recolor((c, x, y, z) => (y <= SINK + 1 && h3(x, y, z, 3) < 0.6 ? mix(c, 0x7aa860, 0.5) : c));
  const topAt = (x: number, z: number) => {
    let y = g.ny - 1;
    while (y > 0 && !g.solid(Math.floor(x), y, Math.floor(z))) y--;
    return y;
  };
  // branching coral
  const corals = [0xff6f86, 0xff8f5a, 0xffb04a, 0xff5fa8];
  for (let k = 0; k < 4; k++) {
    const x = cx + (rnd() - 0.5) * rv * 1.1;
    const z = cz + (rnd() - 0.5) * rv * 1.1;
    const y = topAt(x, z);
    if (y <= SINK) continue;
    coralBranch(g, x, y, z, 0, 1, 0, 3 + rnd() * 2, 2, corals[k % corals.length], rnd);
  }
  // brain coral dome
  {
    const a = rnd() * Math.PI * 2;
    const x = cx + Math.cos(a) * rv * 0.5;
    const z = cz + Math.sin(a) * rv * 0.5;
    const y = topAt(x, z);
    blob(g, x, y, z, 3.2, 2.4, 3.2, 0.1, seed + 3, (xx, yy, zz) => (Math.sin(xx * 1.3 + Math.sin(zz * 0.9) * 2) > 0.4 ? 0xb8cc58 : 0xd2e070), 0.3);
  }
  // purple sea fan: a flat lattice
  {
    const a = rnd() * Math.PI * 2;
    const x0 = cx + Math.cos(a) * rv * 0.3;
    const z0 = cz + Math.sin(a) * rv * 0.3;
    const y0 = topAt(x0, z0);
    const px = -Math.sin(a);
    const pz = Math.cos(a);
    for (let i = -6; i <= 6; i++)
      for (let j = 0; j <= 9; j++) {
        if (i * i * 0.6 + (j - 5) * (j - 5) > 30) continue;
        if ((i + j) % 2 && j % 3 && h3(i, j, seed) < 0.6) continue;
        g.set(x0 + px * i, y0 + j, z0 + pz * i, j > 7 ? 0xc07ae8 : 0x9a58d0);
      }
  }
  // tube sponges
  for (let k = 0; k < 3; k++) {
    const a = rnd() * Math.PI * 2;
    const x = cx + Math.cos(a) * rv * 0.75;
    const z = cz + Math.sin(a) * rv * 0.75;
    const y = topAt(x, z);
    const h = 3 + Math.floor(rnd() * 4);
    taper(g, x, z, 1.6, 1.6, y, y + h, 0xff9a3a);
    g.set(x, y + h, z, 0x7a3a1a);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.88 }) }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------

/** Bouncy reef post: rubber bumper on a coil spring with glowing rings. Wobbles. */
export function buildReefPost(r: number, seed: number): PropModel {
  const V = 0.06;
  const rv = r / V;
  const n = Math.ceil(rv * 2.4 + 6);
  const H = 30;
  const g = new PGrid(n, H + SINK + 2, n);
  const cx = n / 2;
  const cz = n / 2;
  const lime = blotch([0xc4b28c, 0xd2c29e, 0xddd0ae, 0xb8a680], 0.25, seed, 0.3);
  // coral stone footing
  blob(g, cx, SINK, cz, rv * 1.05, 4, rv * 1.05, 0.15, seed, lime, 0.3);
  // coil spring
  g.on(CH.metal, () => {
    for (let t = 0; t < 1; t += 0.004) {
      const a = t * Math.PI * 2 * 3.5;
      const y = SINK + 3 + t * 7;
      const rr = rv * 0.68;
      seg(g, cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr, cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr, (x, yy, z) => (h3(x, yy, z) < 0.3 ? 0xd8dee6 : 0xaab4c0), 0.9);
    }
    taper(g, cx, cz, rv * 0.3, rv * 0.3, SINK + 2, SINK + 11, 0x6a7480);
  });
  // rubber body: banded, bulging bumper with rounded top
  const y0 = SINK + 10;
  const y1 = SINK + H;
  for (let y = y0; y <= y1; y++) {
    const t = (y - y0) / (y1 - y0);
    const bulge = 1 + 0.08 * Math.sin(t * Math.PI);
    const cap = t > 0.85 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.85) / 0.15, 2))) : 1;
    const rr = rv * 0.92 * bulge * cap;
    const band = Math.floor((y - y0) / 4) % 2 === 0;
    const isRing = y >= y0 + 6 && y <= y0 + 7;
    const isRing2 = y >= y1 - 5 && y <= y1 - 5;
    const ch = isRing || isRing2 ? CH.glow : CH.extra;
    const col = band ? 0xff5f7a : 0xfff0e2;
    g.on(ch, () => {
      const R = isRing ? rr + 1.2 : isRing2 ? rr + 0.6 : rr;
      for (let z = Math.floor(cz - R - 1); z <= cz + R + 1; z++)
        for (let x = Math.floor(cx - R - 1); x <= cx + R + 1; x++) {
          const dx = x + 0.5 - cx;
          const dz = z + 0.5 - cz;
          if (dx * dx + dz * dz > R * R) continue;
          if (ch === CH.glow) g.set(x, y, z, h3(x, y, z) < 0.5 ? 0x4ff4ff : 0x7ffaff);
          else g.set(x, y, z, shade(col, 0.96 + h3(x, y, z, seed) * 0.06));
        }
    });
  }
  // little starfish stuck on the post
  g.on(CH.extra, () => {
    const sy = y0 + 12;
    const sz = Math.floor(cz + rv * 0.98);
    for (let k = -2; k <= 2; k++) {
      g.set(cx + k, sy, sz, 0xffa040);
      g.set(cx, sy + k, sz, 0xffa040);
    }
  });
  const wob = 0.014;
  return {
    ...toModel(g, V, {
      [CH.base]: pmat({ rough: 0.9 }),
      [CH.metal]: pmat({ metal: 0.85, rough: 0.3, wobble: wob }),
      [CH.extra]: pmat({ rough: 0.42, wobble: wob }),
      [CH.glow]: pmat({ glow: 2.6, pulse: 0.45, rough: 0.3, wobble: wob }),
    }, { pivot: [cx, SINK, cz] }),
    halos: [{ pos: [0, (y0 + 6.5 - SINK) * V, 0], color: 0x4ff4ff, size: 1.7, opacity: 0.45 }],
  };
}

// ---------------------------------------------------------------------------------------------

// Tiki face rows, 13 wide. '.' wood, B brow (raised), E eye (glow), P pupil, N nose (raised),
// M mouth (carved), W tooth, T tongue, S teal paint, R red paint.
const TIKI_FACES: readonly string[][] = [
  [
    'SSSSSSSSSSSSS',
    '.BBBB...BBBB.',
    '.EEPE...EPEE.',
    '.EEEE...EEEE.',
    '.....NNN.....',
    '.....NNN.....',
    '..MMMMMMMMM..',
    '..MWWWWWWWM..',
    '..MMMTTTMMM..',
    '...MMMMMMM...',
    'RRRRRRRRRRRRR',
  ],
  [
    '.............',
    'BBBBB...BBBBB',
    '.EEE.....EEE.',
    '.EPE.....EPE.',
    '.EEE..N..EEE.',
    '.....NNN.....',
    '.....NNN.....',
    '.MMMMMMMMMMM.',
    '.MWMWMWMWMWM.',
    '.MMMMMMMMMMM.',
    'SSSSSSSSSSSSS',
  ],
  [
    'RRRRRRRRRRRRR',
    '..BBB...BBB..',
    '..EPE...EPE..',
    '...E.....E...',
    '......N......',
    '.....NNN.....',
    '...MMMMMMM...',
    '..MMTTTTTMM..',
    '..MMTTTTTMM..',
    '...MMMMMMM...',
    '.............',
  ],
];

export function buildTikiTotem(r: number, seed: number): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 61 + 1);
  const rv = r / V;
  const half = Math.min(7, Math.floor(rv * 0.78));
  const n = 34;
  const H = 38;
  const g = new PGrid(n, H + SINK + 10, n);
  const cx = Math.floor(n / 2);
  const cz = Math.floor(n / 2);
  const wood = (x: number, y: number, z: number) => {
    const t = vn3(x * 0.7, y * 0.12, z * 0.7, seed) * 0.8 + h3(x, y, z, seed) * 0.2;
    return [0x7a4e2c, 0x8a5a34, 0x9a6a3e, 0xa87a4a][Math.min(3, Math.floor(t * 4))];
  };
  // stone base
  const stone = blotch([0x7a7468, 0x8a8478, 0x6a645a], 0.3, seed, 0.3);
  for (let y = 0; y <= SINK + 1; y++)
    for (let z = cz - half - 2; z <= cz + half + 2; z++)
      for (let x = cx - half - 2; x <= cx + half + 2; x++) {
        const ex = Math.abs(x - cx);
        const ez = Math.abs(z - cz);
        if (ex + ez > half * 2 + 1) continue;
        g.set(x, y, z, stone(x, y, z));
      }
  // column
  const top = SINK + 2 + 34;
  g.box(cx - half, SINK + 2, cz - half, cx + half, top, cz + half, wood);
  // faces on all four sides, each tier rotated so every angle has a grin
  const tierH = 11;
  for (let tier = 0; tier < 3; tier++) {
    const yTop = top - 1 - tier * tierH;
    for (let side = 0; side < 4; side++) {
      const face = TIKI_FACES[(tier + side) % 3];
      for (let row = 0; row < face.length; row++) {
        const y = yTop - row;
        for (let col = 0; col < 13; col++) {
          const ch = face[row][col];
          if (ch === '.') continue;
          const u = col - 6;
          // map (u, depth) on the side to grid x,z. depth 0 = surface layer, +1 = raised, -1 = carved
          const put = (depth: number, color: number, chan: number = CH.base) => {
            let x = cx;
            let z = cz;
            if (side === 0) {
              x = cx + u;
              z = cz + half + depth;
            } else if (side === 1) {
              x = cx + half + depth;
              z = cz - u;
            } else if (side === 2) {
              x = cx - u;
              z = cz - half - depth;
            } else {
              x = cx - half - depth;
              z = cz + u;
            }
            g.on(chan, () => g.set(x, y, z, color));
          };
          const clear = () => {
            let x = cx;
            let z = cz;
            if (side === 0) {
              x = cx + u;
              z = cz + half;
            } else if (side === 1) {
              x = cx + half;
              z = cz - u;
            } else if (side === 2) {
              x = cx - u;
              z = cz - half;
            } else {
              x = cx - half;
              z = cz + u;
            }
            g.clear(x, y, z);
          };
          switch (ch) {
            case 'B':
              put(1, 0x5a3820);
              break;
            case 'N':
              put(1, 0x9a6a3e);
              if (row % 2) put(2, 0x8a5a34);
              break;
            case 'E':
              put(0, 0xffb040, CH.glow);
              break;
            case 'P':
              put(0, 0x2a1408);
              break;
            case 'M':
              clear();
              put(-1, 0x2a160c);
              break;
            case 'W':
              put(0, 0xf6f0e0);
              break;
            case 'T':
              clear();
              put(-1, 0xd8443a);
              break;
            case 'S':
              put(0, 0x2fb8a8);
              break;
            case 'R':
              put(0, 0xd8543a);
              break;
          }
        }
      }
    }
  }
  // stubby carved arms on the middle tier
  const armY = top - tierH - 6;
  g.box(cx - half - 3, armY, cz - 1, cx - half - 1, armY + 2, cz + 1, wood);
  g.box(cx + half + 1, armY, cz - 1, cx + half + 3, armY + 2, cz + 1, wood);
  // palm-leaf crown
  g.on(CH.leaf, () => {
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + rnd() * 0.3;
      const L = 8 + rnd() * 3;
      curve(g, [cx, top + 1, cz], [cx + Math.cos(a) * L * 0.4, top + 7, cz + Math.sin(a) * L * 0.4], [cx + Math.cos(a) * L, top + 3, cz + Math.sin(a) * L], 0.5, 0.5, k % 2 ? 0x4e9a32 : 0x6bbf48);
    }
  });
  g.box(cx - half + 1, top + 1, cz - half + 1, cx + half - 1, top + 1, cz + half - 1, 0xd8543a);
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.8 }), [CH.leaf]: pmat({ rough: 0.9, sway: 0.05, swayH: 3.2 }), [CH.glow]: pmat({ glow: 2.4, flicker: 0.25 }) }, { pivot: [cx + 0.5, SINK, cz + 0.5] });
}

