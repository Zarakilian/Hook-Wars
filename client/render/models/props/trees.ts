// Trees and stumps: cypress, dead tree, stump (Muckmire), pine (Frostfang), palm (Coral Cove).
// Built at 0.1 m voxels. Trunks at hook height match the collision radius.
import type { PropCtx } from './buildProps.ts';
import { blob, blotch, capTop, CH, curve, h3, mix, PGrid, pmat, rngFor, seg, shade, taper, toModel, vn3, type PropModel } from './common.ts';
import { mossDrape, strand } from './dressing.ts';

const V = 0.1;
const SINK = 3;

const leafMat = (sway: number, swayH: number) => pmat({ rough: 0.92, sway, swayH });
const barkMat = () => pmat({ rough: 0.95 });

/** Fluted buttress trunk: radius by height with angular lobes. */
function buttress(g: PGrid, cx: number, cz: number, rBase: number, rTop: number, y0: number, y1: number, lobes: number, lobeAmp: number, seed: number, col: (x: number, y: number, z: number) => number, expo = 2.2): void {
  for (let y = y0; y <= y1; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    const flare = Math.pow(1 - t, expo);
    const r = rTop + (rBase - rTop) * flare;
    const amp = lobeAmp * flare;
    const R = r * (1 + amp) + 1;
    for (let z = Math.floor(cz - R); z <= Math.ceil(cz + R); z++)
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        const dx = x + 0.5 - cx;
        const dz = z + 0.5 - cz;
        const a = Math.atan2(dz, dx);
        const rr = r * (1 + amp * Math.cos(a * lobes + seed)) * (0.94 + 0.12 * vn3(x * 0.3, y * 0.1, z * 0.3, seed));
        if (dx * dx + dz * dz <= rr * rr) g.set(x, y, z, col(x, y, z));
      }
  }
}

function barkCol(pal: readonly number[], seed: number): (x: number, y: number, z: number) => number {
  return (x, y, z) => {
    const t = vn3(x * 0.55, y * 0.06, z * 0.55, seed) * 0.8 + h3(x, y, z, seed) * 0.2;
    return pal[Math.min(pal.length - 1, Math.floor(t * pal.length))];
  };
}

// ---------------------------------------------------------------------------------------------

export function buildCypress(r: number, seed: number, ctx?: PropCtx): PropModel {
  const rnd = rngFor(seed * 31 + 7);
  const rv = r / V;
  const Rc = 17;
  const n = Math.ceil(Rc * 2 + 10);
  const H = 54;
  const g = new PGrid(n, H + SINK, n);
  const cx = n / 2;
  const cz = n / 2;
  const bark = barkCol([0x4a4238, 0x564c40, 0x5e5448, 0x686054, 0x403a32], seed);
  // knees around the base
  for (let k = 0; k < 5; k++) {
    const a = rnd() * Math.PI * 2;
    const d = rv + 2 + rnd() * 3;
    const kx = cx + Math.cos(a) * d;
    const kz = cz + Math.sin(a) * d;
    taper(g, kx, kz, 1.6, 0.4, 0, SINK + 2 + Math.floor(rnd() * 4), bark);
  }
  buttress(g, cx, cz, rv * 1.1, 3.6, 0, SINK + 24, 5, 0.2, seed, bark, 1.25);
  const bend = (y: number): [number, number] => [Math.sin(y * 0.07 + seed) * 1.2, Math.cos(y * 0.05 + seed) * 0.8];
  taper(g, cx, cz, 3.6, 2.4, SINK + 24, SINK + 44, bark, bend);
  // mossy collar at the base
  g.recolor((c, x, y, z) => (y < SINK + 4 && y >= SINK - 1 && h3(x, y, z, 5) < 0.55 ? mix(c, 0x4f6a2a, 0.75) : c));
  // branches and layered canopy pads (flat, distinct tiers so the silhouette reads from above)
  const leafPal = [0x3a5a22, 0x46682a, 0x527530, 0x5c8236, 0x68903e];
  const leaf = blotch(leafPal, 0.2, seed + 11, 0.22);
  const padList: [number, number, number, number, number][] = [[cx, SINK + 50, cz, 6.5, 3]];
  const ring = 4 + Math.floor(rnd() * 2);
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2 + rnd() * 0.6;
    const d = 6 + rnd() * 3;
    padList.push([cx + Math.cos(a) * d, SINK + 41 + rnd() * 5, cz + Math.sin(a) * d, 6 + rnd() * 2, 2.6 + rnd() * 0.8]);
  }
  for (let i = 0; i < 2; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 9 + rnd() * 2;
    padList.push([cx + Math.cos(a) * d, SINK + 34 + rnd() * 3, cz + Math.sin(a) * d, 5 + rnd(), 2.4]);
  }
  for (const [px, py, pz] of padList) {
    if (Math.hypot(px - cx, pz - cz) < 1) continue;
    seg(g, cx, Math.min(py - 6, SINK + 36), cz, px, py - 1.5, pz, bark, 1.1);
  }
  g.on(CH.leaf, () => {
    padList.forEach(([px, py, pz, pr, ph], i) => blob(g, px, py, pz, pr, ph, pr * 0.92, 0.14, seed + i * 13, leaf, 0.3));
  });
  // depth: darker undersides, sunlit tops
  g.recolor((c, x, y, z) => (g.chanAt(x, y, z) === CH.leaf ? shade(c, 0.62 + 0.5 * Math.min(1, Math.max(0, (y - SINK - 33) / 18))) : c));
  capTop(g, 1, (x, y, z) => g.chanAt(x, y, z) === CH.leaf && h3(x, y, z, 21) < 0.75, (x, y, z) => mix(leaf(x, y, z), 0x9ab454, 0.4));
  // a few drapes of spanish moss under the pads
  g.on(CH.leaf, () => {
    for (let k = 0; k < 26; k++) {
      const x = Math.floor(cx + (rnd() - 0.5) * Rc * 1.7);
      const z = Math.floor(cz + (rnd() - 0.5) * Rc * 1.7);
      let y = -1;
      for (let yy = SINK + 30; yy < H + SINK; yy++)
        if (g.solid(x, yy, z) && g.chanAt(x, yy, z) === CH.leaf) {
          y = yy;
          break;
        }
      if (y < 0) continue;
      const len = 2 + Math.floor(rnd() * 4);
      let ox = 0;
      for (let j = 1; j <= len; j++) {
        if (j > 1 && rnd() < 0.35) ox += rnd() < 0.5 ? -1 : 1;
        g.set(x + ox, y - j, z, shade(j === len ? 0x5f6b4c : 0x6f7c5a, 0.9 + h3(x, j, z) * 0.2));
      }
    }
  });
  if (ctx?.dress) {
    // Epic: long curtains of pale spanish moss under every canopy pad (ref04)
    const mr = rngFor(seed * 389 + 5);
    g.on(CH.leaf, () => {
      for (let k = 0; k < 70; k++) {
        const x = Math.floor(cx + (mr() - 0.5) * Rc * 1.9);
        const z = Math.floor(cz + (mr() - 0.5) * Rc * 1.9);
        let y = -1;
        for (let yy = SINK + 30; yy < H + SINK; yy++)
          if (g.solid(x, yy, z) && g.chanAt(x, yy, z) === CH.leaf) {
            y = yy;
            break;
          }
        if (y > 0) strand(g, x, y - 1, z, 5 + Math.floor(mr() * 11), mossDrape, mr);
      }
    });
  }
  return toModel(g, V, { [CH.base]: barkMat(), [CH.leaf]: leafMat(0.07, 5) }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------

export function buildDeadTree(r: number, seed: number): PropModel {
  const rnd = rngFor(seed * 17 + 3);
  const rv = r / V;
  const n = 46;
  const H = 46;
  const g = new PGrid(n, H + SINK, n);
  const cx = n / 2;
  const cz = n / 2;
  const bark = barkCol([0x5a5048, 0x675c52, 0x74685c, 0x4c443d, 0x807468], seed);
  // roots
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + rnd() * 0.5;
    const d = rv + 3 + rnd() * 3;
    seg(g, cx, SINK + 3, cz, cx + Math.cos(a) * d, SINK - 1, cz + Math.sin(a) * d, bark, 1.4);
  }
  const bend = (y: number): [number, number] => [Math.sin(y * 0.11 + seed) * 2, Math.sin(y * 0.08 + seed * 2) * 1.5];
  buttress(g, cx, cz, rv * 1.05, 3.2, 0, SINK + 22, 4, 0.18, seed, bark);
  taper(g, cx, cz, 3.2, 1.6, SINK + 22, SINK + 36, bark, bend);
  // hollow knot
  const ha = rnd() * Math.PI * 2;
  const hx = cx + Math.cos(ha) * (rv * 0.85);
  const hz = cz + Math.sin(ha) * (rv * 0.85);
  for (let y = SINK + 8; y <= SINK + 13; y++)
    for (let z = Math.floor(hz - 2); z <= hz + 2; z++)
      for (let x = Math.floor(hx - 2); x <= hx + 2; x++) {
        const dy = (y - (SINK + 10.5)) / 3;
        const d = Math.hypot(x + 0.5 - hx, z + 0.5 - hz) / 2.2;
        if (d * d + dy * dy < 1) g.set(x, y, z, d < 0.6 ? 0x1c1612 : 0x2e251e);
      }
  // twisted branches with twigs
  const nb = 4 + Math.floor(rnd() * 2);
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + rnd() * 0.7;
    const y0 = SINK + 20 + rnd() * 14;
    const [ox, oz] = bend(Math.floor(y0));
    const L = 10 + rnd() * 8;
    const ex = cx + ox + Math.cos(a) * L;
    const ez = cz + oz + Math.sin(a) * L;
    const ey = y0 + 6 + rnd() * 8;
    curve(g, [cx + ox, y0, cz + oz], [cx + ox + Math.cos(a) * L * 0.5, y0 + 1, cz + oz + Math.sin(a) * L * 0.5], [ex, ey, ez], 1.5, 0.5, bark);
    for (let t = 0; t < 3; t++) {
      const ta = a + (rnd() - 0.5) * 1.6;
      const tl = 3 + rnd() * 4;
      seg(g, ex, ey, ez, ex + Math.cos(ta) * tl, ey + 2 + rnd() * 4, ez + Math.sin(ta) * tl, bark);
    }
  }
  // glowing bracket fungi on the trunk
  g.on(CH.glow, () => {
    for (let k = 0; k < 4; k++) {
      const a = rnd() * Math.PI * 2;
      const y = SINK + 5 + Math.floor(rnd() * 18);
      const t = (y - SINK) / 22;
      const rr = rv * 1.05 * Math.pow(1 - t, 2.2) + 3.2 * (1 - Math.pow(1 - t, 2.2)) + 0.5;
      const fx = cx + Math.cos(a) * rr;
      const fz = cz + Math.sin(a) * rr;
      const c = k % 2 ? 0x5fe3c0 : 0x8af0a8;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dz * dz <= 4) g.set(fx + dx, y, fz + dz, shade(c, 0.85 + h3(dx, y, dz) * 0.3));
    }
  });
  // hanging moss
  g.on(CH.leaf, () => {
    for (let k = 0; k < 30; k++) {
      const x = Math.floor(cx + (rnd() - 0.5) * 30);
      const z = Math.floor(cz + (rnd() - 0.5) * 30);
      let y = -1;
      for (let yy = H + SINK - 1; yy > SINK + 18; yy--)
        if (g.solid(x, yy, z)) {
          y = yy;
          break;
        }
      if (y < 0) continue;
      const len = 2 + Math.floor(rnd() * 6);
      for (let j = 1; j <= len; j++) g.set(x, y - j, z, j % 3 === 0 ? 0x7d8c6a : 0x8f9d7c);
    }
  });
  return toModel(g, V, { [CH.base]: barkMat(), [CH.leaf]: leafMat(0.05, 4), [CH.glow]: pmat({ glow: 1.6, pulse: 0.35, rough: 0.6 }) }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------

export function buildStump(r: number, seed: number): PropModel {
  const rnd = rngFor(seed * 13 + 5);
  const rv = r / V;
  const n = Math.ceil(rv * 2 + 12);
  const H = 14;
  const g = new PGrid(n, H + SINK, n);
  const cx = n / 2;
  const cz = n / 2;
  const bark = barkCol([0x4f3b28, 0x5c4630, 0x664f36, 0x47352a], seed);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + rnd() * 0.6;
    const d = rv + 3 + rnd() * 2;
    seg(g, cx, SINK + 3, cz, cx + Math.cos(a) * d, SINK - 1, cz + Math.sin(a) * d, bark, 1.3);
  }
  const topY = SINK + 9;
  buttress(g, cx, cz, rv * 1.08, rv * 0.88, 0, topY, 6, 0.08, seed, bark);
  // jagged broken rim + flat cut with rings
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
      if (d > rv * 0.9) continue;
      const rings = Math.floor(d * 0.9 + vn3(x * 0.3, 0, z * 0.3, seed) * 1.5);
      const c = d > rv * 0.78 ? 0x5a4430 : rings % 2 ? 0xb8925e : 0xc9a46c;
      g.set(x, topY, z, d < 1.2 ? 0x9a7448 : c);
      if (d > rv * 0.7 && h3(x, 0, z, seed) < 0.35) g.set(x, topY + 1, z, bark(x, topY + 1, z));
    }
  // moss patches on top edge
  g.recolor((c, x, y, z) => (y >= topY - 2 && h3(x, y, z, 9) < 0.18 ? 0x5a7a2e : c));
  // mushrooms cluster on one side
  const ma = rnd() * Math.PI * 2;
  for (let k = 0; k < 3; k++) {
    const a = ma + (k - 1) * 0.35;
    const d = rv * 0.95 + 1;
    const mx = cx + Math.cos(a) * d;
    const mz = cz + Math.sin(a) * d;
    const my = SINK + 1 + k * 2;
    g.set(mx, my, mz, 0xe8dcc0);
    g.set(mx, my + 1, mz, 0xe8dcc0);
    g.on(CH.glow, () => {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) g.set(mx + dx, my + 2, mz + dz, (dx + dz) % 2 ? 0xf0a040 : 0xff8a30);
    });
  }
  return toModel(g, V, { [CH.base]: barkMat(), [CH.glow]: pmat({ glow: 0.9, rough: 0.6 }) }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------

export function buildPine(r: number, seed: number): PropModel {
  const rnd = rngFor(seed * 19 + 11);
  const rv = r / V;
  const n = 34;
  const H = 60;
  const g = new PGrid(n, H + SINK, n);
  const cx = n / 2;
  const cz = n / 2;
  const bark = barkCol([0x4a3426, 0x553c2a, 0x3f2d22], seed);
  const snow = (x: number, y: number, z: number) => (h3(x, y, z, 3) < 0.25 ? 0xdbe8f6 : h3(x, y, z, 4) < 0.5 ? 0xf2f8ff : 0xe8f1fc);
  // snow mound around the base at collision radius
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) / rv;
      if (d > 1.05) continue;
      const hh = Math.floor((1 - d * d) * 4 + vn3(x * 0.4, 0, z * 0.4, seed) * 2);
      for (let y = 0; y <= SINK + hh; y++) g.set(x, y, z, snow(x, y, z));
    }
  taper(g, cx, cz, 3.2, 1.2, 0, SINK + 52, bark);
  const tiers = 5;
  const needle = blotch([0x1f4a3e, 0x245446, 0x2c5e4e, 0x1a4036, 0x33685a], 0.22, seed + 5, 0.2);
  const lobes = 7 + Math.floor(rnd() * 3);
  g.on(CH.leaf, () => {
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const y0 = SINK + 8 + i * 9;
      const R = 14 - t * 9;
      const th = 8;
      for (let y = y0; y < y0 + th + 3; y++) {
        const k = (y - y0) / (th + 3);
        const rr = R * (1 - k) + 1;
        for (let z = Math.floor(cz - R - 2); z <= cz + R + 2; z++)
          for (let x = Math.floor(cx - R - 2); x <= cx + R + 2; x++) {
            const dx = x + 0.5 - cx;
            const dz = z + 0.5 - cz;
            const a = Math.atan2(dz, dx);
            const lr = rr * (0.86 + 0.14 * Math.cos(a * lobes + i * 1.3 + seed));
            const d = Math.sqrt(dx * dx + dz * dz);
            // droop: the outer edge hangs lower
            const droop = Math.max(0, d - R * 0.5) * 0.35;
            if (d <= lr && y - y0 >= -droop) g.set(x, Math.floor(y - droop), z, needle(x, y, z));
          }
      }
    }
    // tip
    taper(g, cx, cz, 2, 0.3, SINK + 52, SINK + 58, needle);
  });
  // snow caps on every tier
  capTop(g, 2, (x, y, z) => g.chanAt(x, y, z) === CH.leaf && vn3(x * 0.3, y * 0.3, z * 0.3, seed + 2) > 0.32, (x, y, z) => snow(x, y, z));
  return toModel(g, V, { [CH.base]: barkMat(), [CH.leaf]: leafMat(0.05, 6) }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------

export function buildPalm(r: number, seed: number): PropModel {
  const rnd = rngFor(seed * 23 + 1);
  const rv = r / V;
  const n = 56;
  const H = 52;
  const g = new PGrid(n, H + SINK, n);
  const cx = n / 2;
  const cz = n / 2;
  const sand = (x: number, y: number, z: number) => (h3(x, y, z, 1) < 0.3 ? 0xe2cf9c : h3(x, y, z, 2) < 0.5 ? 0xeedcae : 0xf4e6bf);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) / (rv * 1.05);
      if (d > 1) continue;
      const hh = Math.floor((1 - d * d) * 3.5 + vn3(x * 0.4, 0, z * 0.4, seed) * 1.5);
      for (let y = 0; y <= SINK + hh; y++) g.set(x, y, z, sand(x, y, z));
    }
  // a few shells and a pebble ring on the mound
  for (let k = 0; k < 6; k++) {
    const a = rnd() * Math.PI * 2;
    const d = rv * (0.5 + rnd() * 0.45);
    const x = Math.floor(cx + Math.cos(a) * d);
    const z = Math.floor(cz + Math.sin(a) * d);
    let y = SINK + 6;
    while (y > 0 && !g.solid(x, y - 1, z)) y--;
    g.set(x, y, z, k % 2 ? 0xffc8b4 : 0xf6efe2);
  }
  const lean = rnd() * Math.PI * 2;
  const lx = Math.cos(lean);
  const lz = Math.sin(lean);
  const TOP = SINK + 44;
  const bendAt = (y: number): [number, number] => {
    const t = (y - SINK) / (TOP - SINK);
    const o = t * t * 7;
    return [lx * o, lz * o];
  };
  // ringed trunk
  for (let y = 0; y <= TOP; y++) {
    const t = y / TOP;
    const rr = 3.3 - t * 1.2 + (y % 4 === 0 ? 0.55 : 0);
    const [ox, oz] = bendAt(y);
    const col = y % 4 === 0 ? 0x8a6a42 : y % 4 === 1 ? 0xa8875a : 0x9c7c50;
    taper(g, cx + ox, cz + oz, rr, rr, y, y, (x, yy, z) => shade(col, 0.92 + h3(x, yy, z) * 0.16));
  }
  const [tx, tz] = bendAt(TOP);
  const topX = cx + tx;
  const topZ = cz + tz;
  // coconuts
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    blob(g, topX + Math.cos(a) * 2.2, TOP - 2, topZ + Math.sin(a) * 2.2, 1.6, 1.6, 1.6, 0.1, seed + k, k % 2 ? 0x5a3e22 : 0x6b4a2a);
  }
  // fronds
  const nf = 8 + Math.floor(rnd() * 2);
  const leafPal = [0x3f8a2a, 0x4e9a32, 0x5aae3a, 0x6bc04a];
  g.on(CH.leaf, () => {
    for (let i = 0; i < nf; i++) {
      const a = (i / nf) * Math.PI * 2 + rnd() * 0.3;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const L = 19 + rnd() * 5;
      const rise = 5 + rnd() * 4;
      const drop = 7 + rnd() * 6;
      const steps = Math.ceil(L * 1.4);
      const lc = leafPal[i % leafPal.length];
      let prev: [number, number, number] | null = null;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const d = t * L;
        const y = TOP + 1 + rise * Math.sin(t * Math.PI * 0.6) * (1 - t) * 1.6 - drop * t * t;
        const x = topX + ca * d;
        const z = topZ + sa * d;
        const spine = mix(0x7a9a3a, 0xb8c860, t * 0.7);
        if (prev) seg(g, prev[0], prev[1], prev[2], x, y, z, spine);
        prev = [x, y, z];
        if (t < 0.08 || s % 2) continue;
        const ll = 5.5 * Math.sin(Math.min(1, t * 1.15) * Math.PI) + 1;
        for (const side of [-1, 1]) {
          const px = -sa * side;
          const pz = ca * side;
          const tip = mix(lc, 0xa8c850, t * 0.6);
          seg(g, x, y, z, x + px * ll + ca * 1.2, y - 2.2 - t * 1.5, z + pz * ll + sa * 1.2, (xx, yy, zz) => (h3(xx, yy, zz, i) < 0.25 ? shade(tip, 0.85) : tip));
        }
      }
    }
  });
  return toModel(g, V, { [CH.base]: barkMat(), [CH.leaf]: leafMat(0.1, 4.6) }, { pivot: [cx, SINK, cz] });
}
