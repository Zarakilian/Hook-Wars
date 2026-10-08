// Movers: ice floes, canal barges, mossy logs and lashed rafts.
// Origin at the waterline, +Z along the capsule axis (the glue sets rotation.y to the travel direction).
import * as THREE from 'three';
import type { MoverDef } from '../../../../shared/maps/types.ts';
import { blob, blotch, cachedModel, CH, h3, halo, modelGroup, PGrid, pmat, propsQuality, qLevel, rngFor, seg, shade, taper, toModel, vn3, type PropModel } from './common.ts';
import { iceMat } from './rocks.ts';

function icefloe(r: number, seed: number): PropModel {
  const V = 0.1;
  const rnd = rngFor(seed * 101 + 1);
  const rv = r / V;
  const n = Math.ceil(rv * 2.3 + 4);
  const WL = 4;
  const g = new PGrid(n, WL + 8, n);
  const cx = n / 2;
  const cz = n / 2;
  const lobes = 5 + Math.floor(rnd() * 3);
  const ph = rnd() * 6;
  const R = (a: number) => rv * (0.86 + 0.12 * Math.sin(a * lobes + ph) + 0.07 * Math.sin(a * 11 + ph * 2));
  const snow = (x: number, y: number, z: number) => (h3(x, y, z) < 0.25 ? 0xdfeaf7 : 0xf4f9ff);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - cx;
      const dz = z + 0.5 - cz;
      const d = Math.hypot(dx, dz);
      const rr = R(Math.atan2(dz, dx));
      for (let y = 0; y < WL + 3; y++) {
        // slab narrows below the water, so it reads as a floating block
        const shrink = y < WL ? (WL - y) * 0.9 : 0;
        if (d > rr - shrink) continue;
        const edge = d > rr - shrink - 1.5;
        if (y >= WL + 1) {
          const snowy = vn3(x * 0.15, 0, z * 0.15, seed) > 0.42;
          if (y === WL + 2 && !snowy) continue;
          g.on(snowy ? CH.base : CH.ice, () => g.set(x, y, z, snowy ? snow(x, y, z) : edge ? 0xa8daf4 : 0xcdeefc));
        } else {
          g.on(CH.ice, () => g.set(x, y, z, y < WL - 1 ? 0x5aa0c8 : edge ? 0x8ac8ea : 0xb5e2f8));
        }
      }
    }
  // cracks on the top
  g.recolor((c, x, y, z) => (y >= WL + 1 && Math.abs(vn3(x * 0.2, 0, z * 0.2, seed + 5) - 0.5) < 0.025 ? 0x7ab8e0 : c));
  // a snow heap and an ice chunk for silhouette
  const a = rnd() * Math.PI * 2;
  blob(g, cx + Math.cos(a) * rv * 0.3, WL + 2, cz + Math.sin(a) * rv * 0.3, rv * 0.3, 2.6, rv * 0.25, 0.25, seed + 2, snow, 0.3);
  g.on(CH.ice, () => {
    const b = a + 2.4;
    const x0 = cx + Math.cos(b) * rv * 0.45;
    const z0 = cz + Math.sin(b) * rv * 0.45;
    for (let y = 0; y < 5; y++) g.box(Math.floor(x0 - 1.5 + y * 0.3), WL + 2 + y, Math.floor(z0 - 1), Math.floor(x0 + 1.5 - y * 0.4), WL + 2 + y, Math.floor(z0 + 1), 0xd4f2ff);
  });
  if (seed % 2 === 0) {
    // a frozen cartoon fish
    const fx = Math.floor(cx - rv * 0.2);
    const fz = Math.floor(cz + rv * 0.35);
    for (let k = 0; k < 5; k++) g.set(fx + k, WL + 2, fz, k === 0 ? 0x22303a : k < 4 ? 0xe88a5a : 0xd86a3a);
    g.set(fx + 4, WL + 2, fz + 1, 0xd86a3a);
    g.set(fx + 4, WL + 2, fz - 1, 0xd86a3a);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.7 }), [CH.ice]: iceMat() }, { pivot: [cx, WL - 0.5, cz] });
}

function barge(r: number, len: number, seed: number): PropModel {
  const V = 0.1;
  const W = Math.round((r * 2) / V);
  const L = Math.round((len + 2 * r) / V);
  const nx = W + 6;
  const nz = L + 4;
  const WL = 5;
  const deck = WL + 6;
  const g = new PGrid(nx, deck + 16, nz);
  const cx = nx / 2;
  const z0 = 2;
  const z1 = z0 + L - 1;
  const hullCols = [[0x2f5a3a, 0x3a6a44], [0x7a2a2a, 0x8a3434], [0x24406a, 0x2e4e7a]][seed % 3];
  const halfAt = (z: number) => {
    const fromBow = z1 - z;
    const fromStern = z - z0;
    const bow = Math.min(1, fromBow / (r / V * 1.1));
    const stern = Math.min(1, fromStern / (r / V * 0.45));
    return (W / 2) * Math.sqrt(Math.max(0, bow)) * (0.75 + 0.25 * Math.sqrt(stern));
  };
  // hull shell
  for (let z = z0; z <= z1; z++) {
    const hw = halfAt(z);
    for (let y = 0; y <= deck; y++) {
      const t = y / deck;
      const hwy = hw * (0.82 + 0.18 * t);
      for (let x = 0; x < nx; x++) {
        const dx = Math.abs(x + 0.5 - cx);
        if (dx > hwy) continue;
        let c: number;
        if (y < WL) c = 0x1a1c20;
        else if (y === WL) c = 0x2a2a2a;
        else if (y === deck - 1) c = 0xd8b040; // gold trim line
        else if (y === deck) c = 0x8a3a2a;
        else c = shade(hullCols[0], 0.94 + h3(x, y, z) * 0.12);
        if (dx < hwy - 1.2 && y > WL && y < deck) continue; // hollow
        g.set(x, y, z, c);
      }
    }
  }
  // deck planks
  for (let z = z0 + 1; z < z1; z++) {
    const hw = halfAt(z) - 1;
    for (let x = 0; x < nx; x++) if (Math.abs(x + 0.5 - cx) < hw) g.set(x, deck - 1, z, (z % 3 === 0 ? 0x6a4a2a : 0x8a6a42));
  }
  // cabin
  const cz0 = z0 + Math.round(L * 0.18);
  const cz1 = z0 + Math.round(L * 0.62);
  const chw = Math.floor(W / 2) - 2;
  const cabinTop = deck + 8;
  for (let z = cz0; z <= cz1; z++)
    for (let y = deck; y <= cabinTop; y++)
      for (let x = Math.floor(cx - chw); x < Math.ceil(cx + chw); x++) {
        const edgeX = x === Math.floor(cx - chw) || x === Math.ceil(cx + chw) - 1;
        const edgeZ = z === cz0 || z === cz1;
        if (!edgeX && !edgeZ && y < cabinTop) continue;
        let c = shade(hullCols[1], 0.94 + h3(x, y, z) * 0.1);
        if (y === cabinTop) c = Math.abs(x + 0.5 - cx) < chw - 1 ? 0x3a3a3a : 0xc8a040;
        if (y === deck + 1) c = 0xd8b040;
        g.set(x, y, z, c);
      }
  // windows (warm glow)
  g.on(CH.glow, () => {
    for (let z = cz0 + 3; z < cz1 - 2; z += 6)
      for (const xs of [Math.floor(cx - chw), Math.ceil(cx + chw) - 1])
        g.box(xs, deck + 4, z, xs, deck + 6, z + 2, (x, y, zz) => (y === deck + 6 ? 0xffc870 : h3(x, y, zz) < 0.3 ? 0xffd890 : 0xffe8b0));
    g.box(Math.floor(cx - 1), deck + 3, cz0, Math.floor(cx), deck + 6, cz0, 0xffd890);
  });
  // roof: flower pots and a brass chimney
  for (let k = 0; k < 3; k++) {
    const pz = cz0 + 4 + k * 5;
    const px = Math.floor(cx + (k % 2 ? 1 : -2));
    g.box(px, cabinTop + 1, pz, px + 1, cabinTop + 2, pz + 1, 0xb85a32);
    g.set(px, cabinTop + 3, pz, k % 2 ? 0xff5a6a : 0xffe060);
    g.set(px + 1, cabinTop + 3, pz + 1, 0x4a8a30);
  }
  g.on(CH.metal, () => {
    const chz = cz1 - 3;
    taper(g, cx + 2, chz, 1.3, 1.3, cabinTop + 1, cabinTop + 6, (x, y, z) => (y === cabinTop + 6 ? 0xe8c060 : 0xb8903a));
    // tyre fenders along the sides
    for (let z = z0 + 8; z < z1 - 6; z += 12)
      for (const side of [-1, 1]) {
        const x = Math.floor(cx + side * (halfAt(z) + 0.5));
        g.box(x, WL + 2, z, x, WL + 4, z + 2, 0x1c1c1c);
        g.set(x, WL + 3, z + 1, 0x101010);
      }
  });
  // cargo at the bow: coal heap or crates
  const bz0 = cz1 + 3;
  const bz1 = z1 - Math.round(r / V * 0.6);
  if (seed % 2) {
    for (let z = bz0; z < bz1; z++)
      for (let x = Math.floor(cx - chw); x < cx + chw; x++) {
        const hh = Math.floor(3 * Math.sin(((z - bz0) / (bz1 - bz0)) * Math.PI) * (1 - Math.abs(x + 0.5 - cx) / (chw + 1)) + h3(x, 0, z) * 1.5);
        for (let y = 0; y <= hh; y++) g.set(x, deck + y, z, h3(x, y, z) < 0.3 ? 0x2a2a30 : 0x1a1a20);
      }
  } else {
    for (let k = 0; k < 2; k++) {
      const zz = bz0 + k * 6;
      g.box(Math.floor(cx - 3), deck, zz, Math.floor(cx + 2), deck + 4, zz + 4, (x, y, z) => ((y - deck) % 2 ? 0xa87a48 : 0x8e6236));
    }
  }
  // tiller at the stern
  seg(g, cx, deck + 1, z0 + 2, cx, deck + 6, z0 - 1, 0x6a4a2a, 0.6);
  return {
    ...toModel(g, V, { [CH.base]: pmat({ rough: 0.6 }), [CH.glow]: pmat({ glow: 2.8, flicker: 0.1 }), [CH.metal]: pmat({ metal: 0.85, rough: 0.3 }) }, { pivot: [cx, WL, z0 + L / 2] }),
  };
}

function log(r: number, len: number, seed: number): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 107 + 3);
  const rv = r / V * 0.95;
  const L = Math.round((len + 2 * r * 0.8) / V);
  const n = Math.ceil(rv * 2 + 8);
  const nz = L + 4;
  const cyv = rv + 1;
  const g = new PGrid(n, Math.ceil(rv * 2 + 10), nz);
  const cx = n / 2;
  const bark = blotch([0x4a3828, 0x56422e, 0x5f4a34, 0x3f3022], 0.25, seed, 0.3);
  for (let z = 2; z < 2 + L; z++)
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cyv;
        const d = Math.hypot(dx, dy);
        const rr = rv * (1 + 0.06 * Math.sin(Math.atan2(dy, dx) * 9 + z * 0.4));
        if (d > rr) continue;
        const end = z === 2 || z === 1 + L;
        if (end) {
          const ring = Math.floor(d * 0.9) % 2;
          g.set(x, y, z, d > rv - 1.2 ? 0x4a3828 : ring ? 0xc8a46c : 0xb08a5a);
        } else g.set(x, y, z, bark(x, y, z));
      }
  // moss on the top
  const moss = blotch([0x4c6a28, 0x5a7a2e, 0x668a34], 0.3, seed + 1, 0.3);
  g.recolor((c, x, y, z) => (y > cyv + rv * 0.55 && vn3(x * 0.2, y * 0.2, z * 0.1, seed) > 0.45 ? moss(x, y, z) : c));
  // branch stub
  const sz = Math.floor(2 + L * (0.3 + rnd() * 0.3));
  seg(g, cx, cyv + rv - 1, sz, cx + 3, cyv + rv + 5, sz + 2, bark, 1.2);
  // mushrooms
  for (let k = 0; k < 3; k++) {
    const z = Math.floor(2 + L * 0.65 + k * 2);
    const y = Math.floor(cyv + rv);
    g.set(cx - 1 + k, y, z, 0xe8dcc0);
    g.box(cx - 2 + k, y + 1, z - 1, cx + k, y + 1, z + 1, 0xd86a3a);
  }
  if (seed % 2) {
    // a little frog hitching a ride
    const fz = Math.floor(2 + L * 0.2);
    const fy = Math.floor(cyv + rv);
    g.box(cx - 2, fy, fz - 2, cx + 1, fy + 2, fz + 1, 0x5aa83a);
    g.box(cx - 2, fy + 3, fz, cx - 2, fy + 3, fz, 0xf0f0e0);
    g.box(cx + 1, fy + 3, fz, cx + 1, fy + 3, fz, 0xf0f0e0);
    g.set(cx - 2, fy + 3, fz + 1, 0x101010);
    g.set(cx + 1, fy + 3, fz + 1, 0x101010);
    g.box(cx - 1, fy + 1, fz + 2, cx, fy + 1, fz + 2, 0xd85a5a);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.9 }) }, { pivot: [cx, cyv - rv * 0.35, 2 + L / 2] });
}

function raft(r: number, len: number, seed: number): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 109 + 5);
  const W = Math.round((r * 2) / V);
  const L = Math.round((len + 2 * r * 0.8) / V);
  const nx = W + 4;
  const nz = L + 4;
  const WL = 3;
  const g = new PGrid(nx, WL + 40, nz);
  const logR = 2.2;
  const nLogs = Math.floor(W / (logR * 2));
  const x0 = (nx - nLogs * logR * 2) / 2;
  const bamboo = [0xc8a860, 0xb89850, 0xd8b870];
  for (let i = 0; i < nLogs; i++) {
    const lx = x0 + logR + i * logR * 2;
    const extra = Math.floor(rnd() * 4) - 2;
    for (let z = 2 - Math.min(0, extra); z < 2 + L + extra; z++)
      for (let y = 0; y < WL + 3; y++)
        for (let x = Math.floor(lx - logR - 1); x <= lx + logR + 1; x++) {
          const d = Math.hypot(x + 0.5 - lx, y + 0.5 - (WL + 0.5));
          if (d > logR) continue;
          const node = z % 9 === 0;
          g.set(x, y, z, node ? 0x8a7040 : shade(bamboo[i % 3], 0.93 + h3(x, y, z) * 0.12));
        }
  }
  // cross beams with rope lashing
  for (const bz of [4, Math.floor(L / 2), L - 2])
    for (let x = 1; x < nx - 1; x++) {
      g.set(x, WL + 3, bz, 0x7a5a32);
      g.set(x, WL + 3, bz + 1, 0x7a5a32);
      if (x % 4 === 0) g.set(x, WL + 4, bz, 0xd8c08a);
    }
  // mast with a patched sail
  const mx = Math.floor(nx / 2);
  const mz = Math.floor(2 + L * 0.55);
  g.box(mx, WL + 3, mz, mx, WL + 34, mz, 0x6a4a2a);
  for (let y = WL + 12; y < WL + 33; y++) {
    const w = Math.floor(2 + (y - WL - 12) * 0.35);
    for (let z = mz - w; z < mz; z++) g.set(mx, y, z, y % 6 < 2 ? 0xd84a3a : h3(y, z, 1) < 0.1 ? 0xc8b890 : 0xf0e6cc);
  }
  // little crate and a coconut
  g.box(mx - 6, WL + 4, 4, mx - 3, WL + 7, 7, (x, y, z) => ((y + z) % 3 ? 0xa87a48 : 0x8e6236));
  blob(g, mx + 4, WL + 5, 6, 1.5, 1.5, 1.5, 0.05, 1, 0x5a3e22);
  // tiki torch at the stern corner
  const tx = nx - 4;
  const tz = 4;
  g.box(tx, WL + 3, tz, tx, WL + 16, tz, 0x7a5a32);
  g.box(tx - 1, WL + 15, tz - 1, tx + 1, WL + 17, tz + 1, 0x5a3a22);
  g.on(CH.glow, () => {
    g.box(tx - 1, WL + 18, tz - 1, tx + 1, WL + 19, tz + 1, 0xff9a30);
    g.set(tx, WL + 20, tz, 0xffd060);
    g.set(tx, WL + 21, tz, 0xfff0a0);
  });
  const cx = nx / 2;
  const cz = 2 + L / 2;
  return {
    ...toModel(g, V, { [CH.base]: pmat({ rough: 0.8 }), [CH.glow]: pmat({ glow: 3.2, flicker: 0.4 }) }, { pivot: [cx, WL - 1.5, cz] }),
    halos: [{ pos: [(tx - cx) * V, (WL + 19 - WL + 1.5) * V, (tz - cz) * V], color: 0xff9a40, size: 1.6, opacity: 0.6 }],
  };
}

export function createMoverViewImpl(def: MoverDef, mood: 'night' | 'dusk' | null = null): THREE.Object3D {
  const seed = def.seed ?? 1;
  const key = `m|${def.kind}|${def.r.toFixed(2)}|${def.len.toFixed(2)}|${seed}`;
  const model = cachedModel(key, () => {
    switch (def.kind) {
      case 'icefloe':
        return icefloe(def.r, seed);
      case 'barge':
        return barge(def.r, Math.max(def.len, 1), seed);
      case 'log':
        return log(def.r, Math.max(def.len, 0.5), seed);
      case 'raft':
      default:
        return raft(def.r, Math.max(def.len, 0.5), seed);
    }
  });
  const g = modelGroup(model, qLevel(propsQuality()) >= 1, mood);
  if (model.halos)
    for (const hl of model.halos) {
      const s = halo(hl.color, hl.size, hl.opacity);
      s.position.set(hl.pos[0], hl.pos[1], hl.pos[2]);
      g.add(s);
    }
  g.name = 'mover:' + def.kind;
  return g;
}

