// Maelstrom Lagoon props: grey sea stacks crowned with a palm, the broken shipwreck hull, crate piles.
// Origins at ground contact. The shipwreck uses the wall frame (runs along +Z, thickness along X).
import { bedY, waterY } from '../../contracts.ts';
import type { PropCtx } from './buildProps.ts';
import { blob, blotch, capTop, CH, curve, h3, mix, PGrid, pmat, rngFor, seg, shade, taper, toModel, vn3, type CFn, type PropModel } from './common.ts';
import { crateBox } from './harbour.ts';
import { grain, mats, ropeCol, snowCol, WOOD } from './kit.ts';
import { coralBranch } from './rocks.ts';

const SINK = 2;
const CORALS = [0xff6f86, 0xff8f5a, 0xffb04a, 0xff5fa8, 0xb070e8, 0xffd84a];

function miniPalm(g: PGrid, x0: number, y0: number, z0: number, h: number, frond: number, seed: number): void {
  const rnd = rngFor(seed * 13 + 1);
  const lean = rnd() * Math.PI * 2;
  let tx = x0;
  let tz = z0;
  for (let y = 0; y <= h; y++) {
    const t = y / h;
    tx = x0 + Math.cos(lean) * t * t * 3;
    tz = z0 + Math.sin(lean) * t * t * 3;
    const col = y % 3 === 0 ? 0x8a6a42 : 0xa8875a;
    taper(g, tx, tz, 1.3, 1.3, y0 + y, y0 + y, col);
  }
  const top = y0 + h;
  for (let k = 0; k < 3; k++) blob(g, tx + Math.cos(k * 2.1) * 1.2, top - 1, tz + Math.sin(k * 2.1) * 1.2, 0.9, 0.9, 0.9, 0.1, seed + k, 0x5a3e22);
  g.on(CH.leaf, () => {
    const nf = 7;
    for (let i = 0; i < nf; i++) {
      const a = (i / nf) * Math.PI * 2 + rnd() * 0.4;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let prev: [number, number, number] = [tx, top + 1, tz];
      for (let s = 1; s <= frond; s++) {
        const t = s / frond;
        const p: [number, number, number] = [tx + ca * s, top + 1 + Math.sin(t * 2.2) * 3 - t * t * 5, tz + sa * s];
        seg(g, prev[0], prev[1], prev[2], p[0], p[1], p[2], mix(0x6a9a3a, 0xa8c860, t));
        prev = p;
        if (s % 2 || t < 0.15) continue;
        const ll = 3 * Math.sin(t * Math.PI) + 0.5;
        const leaf = i % 2 ? 0x4e9a32 : 0x5aae3a;
        seg(g, p[0], p[1], p[2], p[0] - sa * ll, p[1] - 1.5, p[2] + ca * ll, leaf);
        seg(g, p[0], p[1], p[2], p[0] + sa * ll, p[1] - 1.5, p[2] - ca * ll, leaf);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Sea stack: a tall column of blocky grey rock, vines down its sides, a palm on top, coral at its foot
// ---------------------------------------------------------------------------------------------

export function buildSeastack(r: number, seed: number, ctx: PropCtx): PropModel {
  const V = 0.1;
  const rnd = rngFor(seed * 71 + 3);
  const rv = r / V;
  const skirt = Math.round(Math.min(ctx.below, 3) / V);
  const P = skirt + SINK; // pivot (ground contact) in voxels
  const Hs = Math.round((4.0 + (seed % 3) * 0.3) / V);
  const n = Math.ceil(rv * 3 + 18);
  const g = new PGrid(n, P + Hs + 24, n);
  const cx = n / 2;
  const cz = n / 2;
  const originY = bedY(ctx.map) + ctx.below;
  const wy = Math.round(P + (waterY(ctx.map, 1) - originY) / V);
  const rockPal = [0x7a7a76, 0x86847e, 0x6c6a66, 0x92908a, 0x5e5c58, 0x8c8a84];
  // bands of blocky rock
  let y = 0;
  let band = 0;
  while (y < P + Hs) {
    const bh = 5 + Math.floor(h3(band, 1, 1, seed) * 5);
    const ox = (h3(band, 2, 1, seed) - 0.5) * 2;
    const oz = (h3(band, 3, 1, seed) - 0.5) * 2;
    const ledge = h3(band, 4, 1, seed) < 0.3 ? 1.12 : 1;
    for (let yy = y; yy < Math.min(P + Hs, y + bh); yy++) {
      const t = (yy - P) / Hs;
      const R = rv * (yy < wy ? 1.28 : t < 0.45 ? 1.0 : 1.0 - (t - 0.45) * 0.25) * (yy === y + bh - 1 ? ledge : 1) * (0.96 + h3(band, 5, 1, seed) * 0.1);
      for (let z = Math.floor(cz - R - 3); z <= cz + R + 3; z++)
        for (let x = Math.floor(cx - R - 3); x <= cx + R + 3; x++) {
          const dx = Math.abs(x + 0.5 - cx - ox);
          const dz = Math.abs(z + 0.5 - cz - oz);
          const d = Math.pow(dx ** 3 + dz ** 3, 1 / 3) * (0.94 + vn3(x * 0.25, yy * 0.1, z * 0.25, seed) * 0.14);
          if (d > R) continue;
          const facet = Math.floor((x + z * 1.3) / 4) + band * 7;
          let c = shade(rockPal[Math.floor(h3(facet, band, 2, seed) * rockPal.length)], 0.9 + h3(x, yy, z, seed) * 0.14);
          if (yy === y) c = shade(c, 0.72);
          if (yy < wy + 1) c = h3(x, yy, z, 9) < 0.2 ? 0xe8e0d0 : mix(c, 0x3a4a44, 0.45);
          else if (yy < wy + 4) c = mix(c, 0x5a6a50, 0.35);
          g.set(x, yy, z, c);
        }
    }
    y += bh;
    band++;
  }
  // green cap on top, bushes, a palm
  const topY = P + Hs - 1;
  capTop(g, 2, (x, yy, z) => yy >= topY - 1 || (yy > P + Hs * 0.5 && vn3(x * 0.2, yy * 0.2, z * 0.2, seed + 4) > 0.68), (x, yy, z) => (h3(x, yy, z, 2) < 0.3 ? 0x6a9a3a : h3(x, yy, z, 3) < 0.5 ? 0x5a8a30 : 0x4a7a2a));
  g.on(CH.leaf, () => {
    for (let k = 0; k < 5; k++) {
      const a = rnd() * Math.PI * 2;
      blob(g, cx + Math.cos(a) * rv * 0.6, topY + 2, cz + Math.sin(a) * rv * 0.6, 2.4, 1.8, 2.4, 0.3, seed + k, (x, yy, z) => (h3(x, yy, z) < 0.4 ? 0x3e7a2a : 0x56963a), 0.4);
    }
  });
  miniPalm(g, cx + 1, topY + 1, cz - 1, 16 + (seed % 3) * 2, 13, seed);
  // vines hanging down the sides
  g.on(CH.leaf, () => {
    for (let k = 0; k < 16; k++) {
      const a = rnd() * Math.PI * 2;
      let x = cx + Math.cos(a) * (rv + 2);
      let z = cz + Math.sin(a) * (rv + 2);
      // walk in until we touch rock
      for (let s = 0; s < 6 && !g.solid(Math.floor(x - Math.cos(a)), topY - 2, Math.floor(z - Math.sin(a))); s++) {
        x -= Math.cos(a);
        z -= Math.sin(a);
      }
      const len = 8 + Math.floor(rnd() * Hs * 0.5);
      for (let j = 0; j < len; j++) {
        const yy = topY - j;
        const wob = Math.round(Math.sin(j * 0.5 + k) * 0.7);
        g.set(x + wob * -Math.sin(a), yy, z + wob * Math.cos(a), j % 4 === 0 ? 0x6aaa3a : 0x3e7a2a);
        if (j % 3 === 1) g.set(x + Math.cos(a), yy, z + Math.sin(a), 0x5a9a34);
      }
    }
  });
  // coral garden around the foot (inside the collision radius plus a hand's width)
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 + rnd() * 0.4;
    const d = rv * (1.05 + rnd() * 0.2);
    const x = cx + Math.cos(a) * d;
    const z = cz + Math.sin(a) * d;
    if (k % 3 === 0) blob(g, x, P, z, 2.2, 1.6, 2.2, 0.1, seed + k, (xx, yy, zz) => (Math.sin(xx * 1.3 + Math.sin(zz * 0.9) * 2) > 0.4 ? 0xb8cc58 : 0xd2e070), 0.3);
    else coralBranch(g, x, P, z, Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3, 2 + rnd() * 2, 2, CORALS[k % CORALS.length], rnd);
  }
  const pivot: [number, number, number] = [cx, P, cz];
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.9 }), [CH.leaf]: mats.leaf(0.06, 3) }, { pivot });
}

// ---------------------------------------------------------------------------------------------
// Shipwreck: a heeled, broken hull with exposed ribs, verdigris sheathing, a snapped mast and a torn sail
// ---------------------------------------------------------------------------------------------

export function buildShipwreck(length: number, r: number, h: number, seed: number, ctx: PropCtx): PropModel {
  void ctx;
  const V = 0.1;
  const rnd = rngFor(seed * 83 + 11);
  const L = Math.ceil((length + 2 * r) / V);
  const T = Math.max(8, Math.round((2 * r) / V));
  const H = Math.round(h / V);
  const nx = T + 16;
  const nz = L + 4;
  const g = new PGrid(nx, H + SINK + 10, nz);
  const cx = nx / 2;
  const z0 = 2;
  const keel = SINK - 2;
  const phi = 0.22 * (seed % 2 ? 1 : -1); // heel
  const cs = Math.cos(phi);
  const sn = Math.sin(phi);
  const hh0 = H * 0.36;
  const wood = grain(WOOD.tropic.map((c) => shade(mix(c, 0x5a4a3a, 0.45), 0.85)), seed, 2);
  const copper: CFn = (x, y, z) => (vn3(x * 0.3, y * 0.3, z * 0.3, seed) > 0.6 ? 0x3a7a6a : h3(x, y, z, 2) < 0.3 ? 0x5aa08a : 0x4a8a7a);
  const brokenAt = 0.2;
  for (let z = z0; z < z0 + L; z++) {
    const t = (z - z0) / L;
    const hw = (T / 2) * (t < 0.72 ? 1 : Math.pow(Math.cos(((t - 0.72) / 0.28) * Math.PI * 0.5), 0.6)) + 0.01;
    const hh = hh0 + Math.pow(t, 3) * 7;
    const broken = t < brokenAt;
    const rib = (z - z0) % 4 === 0;
    const jag = broken ? hh * (0.4 + h3(z, 1, 1, seed) * 0.8) : 99;
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < nx; x++) {
        const u = x + 0.5 - cx;
        const v = y + 0.5 - keel;
        const uh = u * cs + v * sn;
        const vh = -u * sn + v * cs;
        if (vh < 0 || vh > hh + 4) continue;
        const inside = (k: number) => {
          const w = hw - k;
          if (w <= 0) return false;
          if (vh < hh) return (uh / w) ** 2 + ((vh - hh) / (hh - k * 0.6)) ** 2 <= 1;
          return Math.abs(uh) <= w;
        };
        if (!inside(0) || inside(1.7)) continue;
        if (Math.abs(u) > T / 2 + 1.5) continue;
        if (broken && (!rib || vh > jag)) {
          // only a few plank stubs remain between the ribs
          if (!(vh < hh * 0.3 && h3(x, y, z, seed) < 0.5)) continue;
        }
        if (!broken && vh > hh * 0.45 && vh < hh && h3(Math.floor(z / 4), Math.floor(vh / 3), Math.sign(uh), seed + 5) < 0.05) continue; // holes
        let c = vh < hh * 0.32 ? copper(x, y, z) : wood(x, y, z);
        if (Math.floor(vh) % 3 === 0) c = shade(c, 0.8);
        else if (Math.floor(vh / 3) % 2 === 0) c = shade(c, 1.08);
        if (vh > hh + 2.6) c = shade(0x8a7458, 0.92 + h3(x, y, z) * 0.12); // gunwale rail
        if (vh < hh * 0.18 && h3(x, y, z, 7) < 0.18) c = 0xe8e0d0;
        if (rib && broken) c = shade(wood(x, y, z), 0.9);
        g.set(x, y, z, c);
      }
    // a collapsed deck
    if (!broken && t < 0.95)
      for (let x = 0; x < nx; x++) {
        const u = x + 0.5 - cx;
        const vh = hh * 0.92;
        const uh = u;
        if (Math.abs(uh) > hw - 1.5) continue;
        if (h3(Math.floor(z / 2), x, 3, seed) < 0.3) continue;
        const yy = keel + uh * sn + vh * cs;
        const xx = cx + uh * cs - vh * sn;
        g.set(xx, yy, z, (z + x) % 4 === 0 ? 0x4a3a2a : 0x6a5640);
      }
  }
  // portholes
  g.on(CH.metal, () => {
    for (let z = z0 + Math.round(L * 0.35); z < z0 + L * 0.85; z += 7)
      for (const side of [-1, 1]) {
        const t = (z - z0) / L;
        const hw = T / 2;
        const vh = (hh0 + Math.pow(t, 3) * 7) * 0.68;
        const uh = side * (hw - 0.3);
        const x = cx + uh * cs - vh * sn;
        const y = keel + uh * sn + vh * cs;
        g.set(x, y, z, 0xc8a050);
        g.set(x, y + 1, z, 0xb08a40);
        g.set(x, y - 1, z, 0xb08a40);
      }
  });
  // snapped mast leaning with the heel, a yard and a torn sail
  const mz = z0 + Math.round(L * 0.55);
  const mvh = hh0 * 0.9;
  const mx = cx - mvh * sn;
  const my = keel + mvh * cs;
  const mh = H + 2 - mvh;
  const tipX = mx - sn * mh * 0.9;
  const tipY = my + cs * mh * 0.9;
  const tipZ = mz + 3;
  seg(g, mx, my, mz, tipX, tipY, tipZ, (x, y, z) => shade(0x6a5034, 0.9 + h3(x, y, z) * 0.2), 1.2);
  // jagged break at the top
  g.set(tipX, tipY + 1, tipZ, 0x8a7050);
  const yardY = my + cs * mh * 0.72;
  const yardX = mx - sn * mh * 0.72;
  const yz = mz + 2;
  seg(g, yardX - 9 * cs, yardY - 9 * sn, yz, yardX + 9 * cs, yardY + 9 * sn, yz, 0x5a4430, 0.7);
  g.on(CH.extra, () => {
    for (let i = -8; i <= 8; i++)
      for (let j = 1; j <= 12; j++) {
        const ragged = j > 6 + Math.floor(h3(i, 1, 1, seed) * 7);
        const hole = vn3(i * 0.4, j * 0.4, 1, seed + 3) > 0.72;
        if (ragged || hole) continue;
        const x = yardX + i * cs + j * sn * 0.25;
        const y = yardY + i * sn - j;
        const c = h3(i, j, 2, seed) < 0.2 ? 0xa89870 : (j + Math.floor(i / 3)) % 5 === 0 ? 0xc8b890 : 0xdccca4;
        g.set(x, y, yz + 1 + Math.round(Math.sin(i * 0.5) * 0.6), c);
      }
  });
  // rigging lines from the mast top to bow and stern
  seg(g, tipX, tipY, tipZ, cx, keel + hh0 + 5, z0 + L - 2, ropeCol);
  seg(g, tipX, tipY - 2, tipZ, cx - sn * hh0, keel + hh0 * 0.9, z0 + Math.round(L * 0.25), ropeCol);
  // sand drift and seaweed along the keel
  for (let z = z0; z < z0 + L; z++)
    for (let x = 0; x < nx; x++) {
      const d = Math.abs(x + 0.5 - cx) / (T / 2 + 2);
      if (d > 1) continue;
      const hh = Math.floor((1 - d) * 3 * vn3(x * 0.3, 0, z * 0.2, seed + 9));
      for (let y = 0; y <= SINK + hh - 1; y++) if (!g.solid(x, y, z)) g.set(x, y, z, h3(x, y, z) < 0.4 ? 0xe2cf9c : 0xeedcae);
    }
  g.on(CH.leaf, () => {
    for (let k = 0; k < 10; k++) {
      const z = z0 + Math.floor(rnd() * L);
      const x = cx + (rnd() - 0.5) * T;
      for (let j = 0; j < 4 + Math.floor(rnd() * 5); j++) g.set(x + Math.round(Math.sin(j * 0.8)), SINK + j, z, j % 2 ? 0x2f7a3a : 0x3a8a44);
    }
  });
  return toModel(
    g,
    V,
    { [CH.base]: pmat({ rough: 0.9 }), [CH.metal]: mats.brass(), [CH.extra]: pmat({ rough: 0.95, doubleSide: true, sway: 0.08, swayH: 3 }), [CH.leaf]: mats.leaf(0.08, 0.6) },
    { pivot: [cx, SINK, z0 + L / 2] },
  );
}

// ---------------------------------------------------------------------------------------------
// Crate pile: crates, a barrel, a sack and rope, themed (snow, nets, tarps, moss)
// ---------------------------------------------------------------------------------------------

export function buildCratePile(r: number, seed: number, ctx: PropCtx): PropModel {
  const V = 0.07;
  const rnd = rngFor(seed * 97 + 5);
  const rv = r / V;
  const n = Math.ceil(rv * 2 + 10);
  const g = new PGrid(n, Math.round(2.0 / V) + SINK + 4, n);
  const cx = n / 2;
  const cz = n / 2;
  const a = Math.round(rv * 0.42); // big crate half size
  const b = Math.round(rv * 0.36);
  crateBox(g, Math.floor(cx - a * 1.6), SINK, Math.floor(cz - a * 1.1), a * 2, a * 2, a * 2, seed, true);
  crateBox(g, Math.floor(cx + 1), SINK, Math.floor(cz - b * 0.6), b * 2, Math.round(b * 1.7), b * 2, seed + 1, false);
  const c = Math.round(rv * 0.3);
  crateBox(g, Math.floor(cx - a * 1.2 + rnd() * 3), SINK + a * 2, Math.floor(cz - a * 0.8 + rnd() * 2), c * 2, c * 2, c * 2, seed + 2, seed % 2 === 0);
  // a barrel at the front
  const bx = cx - a * 0.3;
  const bz = cz + a * 1.25;
  const br = rv * 0.27;
  const BH = Math.round(0.85 / V);
  for (let y = SINK; y <= SINK + BH; y++) {
    const t = (y - SINK) / BH;
    const rr = br * (0.86 + 0.12 * Math.sin(t * Math.PI));
    const hoop = [2, Math.round(BH * 0.5), BH - 2].some((hy) => Math.abs(y - SINK - hy) < 1);
    g.on(hoop ? CH.metal : CH.base, () => taper(g, bx, bz, hoop ? rr + 0.5 : rr, hoop ? rr + 0.5 : rr, y, y, (x, yy, z) => (hoop ? 0x3e434a : shade([0x8a5a30, 0x9a6838, 0x7e5029][Math.floor(((Math.atan2(z - bz, x - bx) + Math.PI) / (Math.PI * 2)) * 14) % 3], 0.92 + h3(x, yy, z) * 0.14))));
  }
  taper(g, bx, bz, br * 0.84, br * 0.84, SINK + BH + 1, SINK + BH + 1, 0x6a4a2a);
  // a sack slumped against the crates
  const sx = cx + b * 1.3;
  const sz = cz + b * 1.2;
  for (let y = 0; y < 8; y++)
    for (let z = -5; z <= 5; z++)
      for (let x = -4; x <= 4; x++) {
        if ((x * x) / 18 + (z * z) / 28 + (y * y) / 50 > 1) continue;
        g.set(sx + x, SINK + y, sz + z, h3(x, y, z) < 0.3 ? 0xb8a478 : 0xcab68a);
      }
  g.box(sx, SINK + 8, sz - 1, sx, SINK + 9, sz, 0x8a6a42);
  // rope coil on the ground
  for (let k = 0; k < 2; k++)
    for (let t = 0; t < 40; t++) {
      const an = (t / 40) * Math.PI * 2;
      g.set(cx - a * 1.4 + Math.cos(an) * (4 - k * 1.5), SINK + k, cz + a * 1.4 + Math.sin(an) * (4 - k * 1.5), ropeCol(t, k, 0));
    }
  // theme dressing
  if (ctx.theme === 'ice') capTop(g, 2, (x, y, z) => y > SINK + 2 && h3(x, y, z, 4) < 0.85, snowCol);
  else if (ctx.theme === 'tropic') {
    // a fishing net thrown over the stack
    capTop(g, 1, (x, y, z) => y > SINK + a && ((x + z) % 4 === 0 || (x - z + 400) % 4 === 0), 0x9c8a64);
    g.set(cx - a * 1.2, SINK + a * 2 + c * 2, cz, 0xff8a3a);
  } else if (ctx.theme === 'wharf') {
    // tarred canvas over the big crate
    capTop(g, 1, (x, y, z) => y >= SINK + a * 2 - 1 && y < SINK + a * 2 + 1, (x, y, z) => (h3(x, y, z) < 0.3 ? 0x2e3430 : 0x3a423c));
  } else g.recolor((col, x, y, z) => (y < SINK + 4 && h3(x, y, z, 3) < 0.4 ? mix(col, 0x4a6a2a, 0.6) : col));
  void blotch;
  void curve;
  return toModel(g, V, { [CH.base]: mats.wood(ctx.theme === 'wharf' ? 'wharf' : 'tropic'), [CH.metal]: mats.iron() }, { pivot: [cx, SINK, cz] });
}
