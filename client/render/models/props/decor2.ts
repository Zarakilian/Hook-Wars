// Decor for the four reference maps: cattails, mist banks, lantern strings, rope bridges, banners,
// hanging icicles, coral fans, treasure, hanging chains, cargo nets, rowboats and flags.
// Small kinds are variant models (instanced through the decor batch); lanternstring, ropebridge and
// banner read the map around them (platforms, the watchtower, islands) and are built per placement.
import * as THREE from 'three';
import { platformAt, waterDepthAt } from '../../../../shared/maps/helpers.ts';
import type { Decor, MapDef, Obstacle } from '../../../../shared/maps/types.ts';
import { platformDeckY, type HeightFn, type Quality } from '../../contracts.ts';
import { blob, blotch, cachedModel, CH, h3, mix, PGrid, pmat, PROP_TIME, qLevel, rngFor, seg, shade, taper, toModel, trs, WATER_LEVEL, type CFn, type PropModel } from './common.ts';
import { coralBranch } from './rocks.ts';
import { grain, ironCol, lanternCage, mats, post, ropeCol, ropeDark, ropeWrap, sagRope, snowCol, themeOf, WOOD } from './kit.ts';

type Halos = NonNullable<PropModel['halos']>;

function haloAt(c: [number, number, number], pivot: [number, number, number], V: number, color: number, size: number, opacity = 0.4): Halos {
  return [{ pos: [(c[0] - pivot[0]) * V, (c[1] - pivot[1]) * V, (c[2] - pivot[2]) * V], color, size, opacity }];
}

// ---------------------------------------------------------------------------------------------
// Variant builders (v = variant index)
// ---------------------------------------------------------------------------------------------

export function cattail(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 43 + 7);
  const g = new PGrid(22, 40, 22);
  const stems = [0x5a7a32, 0x6a8a3a, 0x4f6a2c, 0x7a8f40];
  g.on(CH.leaf, () => {
    const n = 6 + v * 2;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 4.5;
      const x0 = 11 + Math.cos(a) * d;
      const z0 = 11 + Math.sin(a) * d;
      const h = 20 + Math.floor(rnd() * 14);
      const lx = (rnd() - 0.5) * 0.14;
      const lz = (rnd() - 0.5) * 0.14;
      const c = stems[i % stems.length];
      const head = i % 3 !== 2;
      for (let y = 0; y < h; y++) g.set(x0 + lx * y, y, z0 + lz * y, y < 3 ? shade(c, 0.7) : c);
      if (head) {
        // the brown sausage head with a thin spike above it
        for (let y = h - 8; y < h - 1; y++)
          for (const [ox, oz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g.set(x0 + lx * y + ox, y, z0 + lz * y + oz, h3(i, y, ox + oz * 2) < 0.3 ? 0x4a2e1a : y === h - 8 || y === h - 2 ? 0x6a4428 : 0x5a3820);
        g.set(x0 + lx * h, h, z0 + lz * h, 0xa8a070);
        g.set(x0 + lx * h, h + 1, z0 + lz * h, 0xa8a070);
      } else {
        // a long blade leaf arching out
        for (let k = 0; k < 14; k++) g.set(x0 + Math.cos(a) * k * 0.6, 3 + k * 1.4 - (k * k) / 9, z0 + Math.sin(a) * k * 0.6, mix(c, 0xb8c070, k / 16));
      }
    }
  });
  return toModel(g, V, { [CH.leaf]: pmat({ rough: 0.9, sway: 0.1, swayH: 1.5 }) }, { shadow: false, ao: 0.3 });
}

export function coralfan(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 61 + 3);
  const g = new PGrid(28, 26, 28);
  const c = 14;
  // a rock base
  blob(g, c, 0, c, 6, 2.5, 5, 0.25, v, blotch([0xc4b28c, 0xb8a680, 0xa89870], 0.3, v, 0.3), 0.3);
  if (v === 0) {
    // purple sea fan lattice
    for (let i = -9; i <= 9; i++)
      for (let j = 0; j <= 18; j++) {
        if (i * i * 0.8 + (j - 10) * (j - 10) > 95) continue;
        if ((i + j) % 2 && j % 3 && h3(i, j, 1) < 0.65) continue;
        g.set(c + i, 2 + j, c + Math.round(Math.sin(i * 0.3) * 1.2), j > 15 ? 0xd08af0 : (i + j) % 4 === 0 ? 0x8a48c0 : 0xa45ad8);
      }
  } else if (v === 1) {
    // staghorn branches, coral orange and pink
    for (let k = 0; k < 5; k++) coralBranch(g, c + (rnd() - 0.5) * 6, 2, c + (rnd() - 0.5) * 6, (rnd() - 0.5) * 0.6, 1, (rnd() - 0.5) * 0.6, 4 + rnd() * 3, 2, k % 2 ? 0xff7a50 : 0xff6a8a, rnd);
  } else if (v === 2) {
    // tube sponges, sunny yellow with dark mouths
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + rnd();
      const x = c + Math.cos(a) * (2 + rnd() * 3);
      const z = c + Math.sin(a) * (2 + rnd() * 3);
      const h = 5 + Math.floor(rnd() * 9);
      taper(g, x, z, 1.7, 1.5, 2, 2 + h, (xx, yy, zz) => (h3(xx, yy, zz) < 0.3 ? 0xffc83a : 0xffd84a));
      g.set(x, 2 + h, z, 0x6a3a10);
    }
  } else {
    // brain coral dome with a ring of anemone fingers
    blob(g, c, 3, c, 6, 4.5, 6, 0.08, v + 3, (x, y, z) => (Math.sin(x * 1.2 + Math.sin(z * 0.9) * 2.4) > 0.35 ? 0xa8c858 : 0xc8e070), 0.3);
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      const x = c + Math.cos(a) * 7.5;
      const z = c + Math.sin(a) * 7.5;
      for (let y = 1; y < 4 + (k % 3); y++) g.set(x, y, z, y > 2 ? 0xffb0d8 : 0xff7ab8);
    }
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.7, sway: v === 0 ? 0.05 : 0.0001, swayH: 1 }) }, { shadow: false, ao: 0.35 });
}

export function treasure(v: number): PropModel {
  const V = 0.04;
  const rnd = rngFor(v * 71 + 9);
  const g = new PGrid(34, 30, 30);
  const cx = 17;
  const cz = 15;
  const wood = grain([0x6a4428, 0x7a5030, 0x5a3a22], v, 0);
  const gold: CFn = (x, y, z) => (h3(x, y, z, 3) < 0.25 ? 0xffe07a : h3(x, y, z, 4) < 0.5 ? 0xe8b840 : 0xd4a030);
  // sand mound
  blob(g, cx, 0, cz, 15, 2.5, 13, 0.25, v, (x, y, z) => (h3(x, y, z) < 0.4 ? 0xe2cf9c : 0xeedcae), 0.3);
  if (v === 0) {
    // the chest: banded box, lid flipped open toward -z, heaped with coins and pearls
    const x0 = cx - 8;
    const x1 = cx + 8;
    const z0 = cz - 5;
    const z1 = cz + 5;
    g.box(x0, 2, z0, x1, 10, z1, (x, y, z) => (x === x0 || x === x1 || z === z0 || z === z1 ? wood(x, y, z) : 0x3a2414));
    g.on(CH.metal, () => {
      for (const x of [x0 + 3, x1 - 3]) g.box(x, 2, z0 - 1, x, 10, z1 + 1, gold);
      g.box(cx - 1, 7, z1 + 1, cx + 1, 9, z1 + 1, gold);
      // coin heap
      for (let z = z0 + 1; z < z1; z++)
        for (let x = x0 + 1; x < x1; x++) {
          const hh = 10 + Math.round(3 * Math.cos(((x - cx) / 8) * 1.4) * Math.cos(((z - cz) / 5) * 1.4) + h3(x, 0, z) * 1.5);
          for (let y = 10; y <= hh; y++) g.set(x, y, z, gold(x, y, z));
        }
    });
    // open lid leaning back
    for (let k = 0; k <= 8; k++) g.box(x0, 10 + k, z0 - 1 - Math.round(k * 0.35), x1, 10 + k, z0 - 1 - Math.round(k * 0.35), k % 4 === 0 ? 0x8a6a30 : wood(0, k, 0));
    g.on(CH.glow2, () => {
      for (let k = 0; k < 5; k++) g.set(x0 + 2 + Math.floor(rnd() * 13), 14 + Math.floor(rnd() * 2), z0 + 2 + Math.floor(rnd() * 6), k % 2 ? 0x6af0ff : 0xff7ad8);
    });
    // pearls
    for (let k = 0; k < 6; k++) g.set(x0 + 1 + Math.floor(rnd() * 15), 12 + Math.floor(rnd() * 3), z0 + 1 + Math.floor(rnd() * 8), 0xf8f4ea);
  } else {
    // a spilled pot of coins with a goblet
    g.on(CH.metal, () => {
      blob(g, cx - 3, 2, cz, 7, 3.5, 6, 0.3, v + 2, gold, 0.4);
      taper(g, cx + 7, cz - 3, 2.6, 1.2, 2, 6, gold);
      taper(g, cx + 7, cz - 3, 1.2, 3.2, 7, 12, gold);
    });
    taper(g, cx - 8, cz + 4, 3.5, 2.4, 2, 9, (x, y, z) => (y % 3 === 0 ? 0x5a4a3a : 0x7a6a5a));
    g.on(CH.glow2, () => g.set(cx + 7, 11, cz - 6, 0xff7ad8));
  }
  // a few loose coins in the sand
  g.on(CH.metal, () => {
    for (let k = 0; k < 10; k++) g.set(Math.floor(rnd() * 34), 3, Math.floor(rnd() * 30), 0xe8b840);
  });
  const pivot: [number, number, number] = [cx, 2, cz];
  return {
    ...toModel(g, V, { [CH.base]: pmat({ rough: 0.8 }), [CH.metal]: pmat({ metal: 0.55, rough: 0.32, glow: 0.45 }), [CH.glow2]: pmat({ glow: 2.2, pulse: 0.6, rough: 0.2 }) }, { pivot, shadow: true }),
    halos: haloAt([cx, 14, cz], pivot, V, 0xffc040, 1.4, 0.25),
  };
}

export function chainhang(v: number): PropModel {
  const V = 0.05;
  const g = new PGrid(24, 34, 40);
  const cx = 12;
  const iron = ironCol(v + 5, 0.4);
  // a squat iron mooring post with a ring, chain running to the quay edge (+z) and down into the water
  g.on(CH.metal, () => {
    taper(g, cx, 8, 3.2, 2.6, 12, 18, iron);
    taper(g, cx, 8, 3.6, 3.6, 19, 20, iron);
    for (let a = 0; a < 1; a += 0.04) g.set(cx + Math.cos(a * Math.PI * 2) * 2.5, 15 + Math.sin(a * Math.PI * 2) * 2.5, 11, 0x5a4a3a);
    const pts: [number, number, number][] = [];
    for (let t = 0; t <= 1; t += 0.02) {
      const z = 11 + t * 22;
      const y = t < 0.55 ? 13 - Math.sin((t / 0.55) * Math.PI) * 1.5 : 13 - ((t - 0.55) / 0.45) * 13;
      pts.push([cx + Math.sin(t * 9) * 0.6, y, Math.min(z, 30)]);
    }
    pts.forEach(([x, y, z], i) => {
      g.set(x, y, z, i % 3 === 0 ? 0x4a3e34 : 0x2e3036);
      if (i % 3 === 1) g.set(x + 1, y, z, 0x8a5a30);
    });
    if (v === 1) {
      // a small anchor on the end of the chain
      g.box(cx, 0, 30, cx, 4, 30, iron);
      g.box(cx - 3, 0, 30, cx + 3, 0, 30, iron);
      g.set(cx - 3, 1, 30, 0x2e3036);
      g.set(cx + 3, 1, 30, 0x2e3036);
    }
  });
  // stone footing block
  g.box(cx - 4, 0, 4, cx + 4, 11, 12, (x, y, z) => (y === 11 ? 0x8a847a : shade(0x6a6560, 0.9 + h3(x, y, z) * 0.15)));
  return toModel(g, V, { [CH.base]: mats.stone(true), [CH.metal]: mats.rust() }, { pivot: [cx, 11, 8], shadow: true });
}

export function cargonet(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 83 + 1);
  const g = new PGrid(30, 16, 30);
  const c = 15;
  const sack: CFn = (x, y, z) => (h3(x, y, z) < 0.3 ? 0xb8a478 : 0xcab68a);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + rnd();
    const d = k === 0 ? 0 : 6;
    blob(g, c + Math.cos(a) * d, 4, c + Math.sin(a) * d, 5, 4, 4.5, 0.15, v + k, k % 2 && v === 1 ? grain([0x8e6236, 0x9c6e3e], k, 0) : sack, 0.4);
  }
  if (v === 1) g.box(c - 3, 6, c - 3, c + 3, 12, c + 3, grain([0x8e6236, 0x9c6e3e, 0xa87a48], 3, 0));
  // the net: a rope lattice over the top surfaces, gathered into a knot on top
  for (let z = 0; z < 30; z++)
    for (let x = 0; x < 30; x++) {
      if ((x + z) % 4 && (x - z + 64) % 4) continue;
      let top = -1;
      for (let y = 15; y >= 0; y--)
        if (g.solid(x, y, z)) {
          top = y;
          break;
        }
      if (top > 0) g.set(x, top + 1, z, (x + z) % 8 < 4 ? 0x9c8a64 : 0x8a7854);
    }
  taper(g, c, c, 1.5, 0.8, 12, 15, ropeCol);
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.95 }) }, { pivot: [c, 1, c], shadow: true });
}

export function rowboat(v: number, map: MapDef): PropModel {
  const V = 0.05;
  const L = 52;
  const W = 20;
  const g = new PGrid(W + 6, 18, L + 6);
  const cx = (W + 6) / 2;
  const z0 = 3;
  const theme = themeOf(map);
  const hullPal = WOOD[theme === 'tropic' ? 'tropic' : 'marsh'];
  const stripe = theme === 'ice' ? 0x2e6a6a : theme === 'tropic' ? 0x2a8a8a : 0x3e6a3a;
  for (let z = z0; z < z0 + L; z++) {
    const t = (z - z0) / L;
    const hw = (W / 2) * Math.pow(Math.sin(Math.min(1, t * 1.15 + 0.08) * Math.PI), 0.55);
    const sheer = 8 + Math.pow(Math.abs(t - 0.45) * 2, 2) * 3;
    for (let y = 0; y <= sheer; y++) {
      const k = y / sheer;
      const w = hw * (0.55 + 0.45 * Math.sqrt(k));
      for (let x = Math.floor(cx - w - 1); x <= Math.ceil(cx + w + 1); x++) {
        const dx = Math.abs(x + 0.5 - cx);
        if (dx > w) continue;
        const shell = dx > w - 1.3 || y === 0;
        if (!shell) continue;
        let c = shade(hullPal[(Math.floor(y / 2) + (z >> 3)) % hullPal.length], 0.9 + h3(x, y, z) * 0.15);
        if (y >= sheer - 1) c = shade(hullPal[0], 0.7);
        else if (y === sheer - 3 || y === sheer - 2) c = dx > w - 1.3 ? stripe : c;
        if (y < 3 && dx > w - 1.3) c = mix(c, 0x26302a, 0.5);
        g.set(x, y, z, c);
      }
    }
  }
  // thwarts (seats) and the floor boards
  for (const tz of [0.3, 0.55, 0.78]) {
    const z = Math.round(z0 + L * tz);
    g.box(Math.floor(cx - W / 2 + 2), 6, z, Math.ceil(cx + W / 2 - 2), 6, z + 2, shade(hullPal[2], 1.05));
  }
  g.box(Math.floor(cx - 4), 1, z0 + 6, Math.ceil(cx + 4), 1, z0 + L - 8, (x, y, z) => (x % 3 === 0 ? shade(hullPal[1], 0.7) : hullPal[1]));
  if (v === 0) {
    // oars resting across the seats
    for (const s of [-1, 1]) {
      seg(g, cx + s * 3, 7, z0 + 8, cx + s * 5, 7, z0 + L - 6, 0xb89060, 0.6);
      g.box(cx + s * 5 - 1, 7, z0 + L - 9, cx + s * 5 + 1, 7, z0 + L - 4, 0xc8a070);
    }
  } else {
    // a lantern on the stern seat and a coil of rope
    const c = lanternCage(g, Math.round(cx), 7, z0 + Math.round(L * 0.3), 1, 3, 0xffc060);
    void c;
    for (let t = 0; t < 30; t++) {
      const a = (t / 30) * Math.PI * 2;
      g.set(cx + Math.cos(a) * 3, 2, z0 + L * 0.65 + Math.sin(a) * 3, ropeCol(t, 0, 0));
    }
  }
  // bow rope trailing to the shore
  seg(g, cx, 9, z0 + L - 1, cx, 2, z0 + L + 4, ropeDark, 0.5);
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.7, boat: true }), [CH.metal]: pmat({ metal: 0.7, rough: 0.4, boat: true }), [CH.glow]: pmat({ glow: 3, flicker: 0.2, boat: true }) }, { pivot: [cx, 0, z0 + L / 2], shadow: true });
}

export function flag(v: number): PropModel {
  const V = 0.05;
  const g = new PGrid(30, 66, 8);
  const px = 3;
  const pz = 4;
  const pole = grain([0x6a5034, 0x5a4430], v, 1);
  taper(g, px, pz, 1.2, 0.8, 0, 60, pole);
  g.set(px, 61, pz, 0xc8a050);
  g.set(px, 62, pz, 0xd8b860);
  const cols = [
    [0xe8c840, 0x2a8a8a],
    [0x2a8a8a, 0xf0ece0],
    [0x6a3a8a, 0xe8c840],
  ][v % 3];
  g.on(CH.extra, () => {
    for (let x = 1; x <= 22; x++)
      for (let y = 0; y < 14; y++) {
        if (v === 0 && Math.abs(y - 6.5) > 7 * (1 - x / 23)) continue; // pennant
        if (v === 1 && x > 16 && Math.abs(y - 6.5) < (x - 16) * 0.9) continue; // swallowtail
        const band = v === 2 ? Math.hypot(x - 9, y - 6.5) < 3.5 : y > 4 && y < 9;
        g.set(px + x, 58 - y, pz, band ? cols[1] : shade(cols[0], 0.92 + h3(x, y, v) * 0.12));
      }
  });
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.8 }), [CH.extra]: pmat({ rough: 0.9, doubleSide: true, cloth: 0.12, clothLen: 1.1, clothAxis: 'x' }) }, { pivot: [px + 0.5, 0, pz + 0.5], shadow: true, noShadowCh: [CH.glow, CH.glow2, CH.extra] });
}

/** A snow lip over the bank edge with icicles hanging toward +z (placement turns +z toward the water). */
export function icicles(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 89 + 5);
  const w = 26 + v * 5;
  const g = new PGrid(w + 4, 34, 20);
  const top = 26;
  // the snow lip (slightly rounded) and a crust of ice under it
  for (let x = 2; x < w + 2; x++) {
    const reach = 9 + Math.round(Math.sin(x * 0.4 + v) * 2 + h3(x, 1, v) * 2);
    for (let z = 0; z < reach; z++) {
      const th = z > reach - 3 ? 2 : 3;
      for (let y = top - th; y <= top; y++) g.set(x, y, z, snowCol(x, y, z));
    }
  }
  g.on(CH.ice, () => {
    for (let x = 2; x < w + 2; x++) {
      if (rnd() < 0.3) continue;
      const reach = 9 + Math.round(Math.sin(x * 0.4 + v) * 2 + h3(x, 1, v) * 2);
      const len = 3 + Math.floor(rnd() * (x % 5 === 0 ? 18 : 9));
      const z = reach - 1 - Math.floor(rnd() * 2);
      for (let j = 0; j < len; j++) {
        const thick = j < len * 0.4 && len > 8;
        const c = j > len - 3 ? 0xf0fbff : j % 4 === 0 ? 0xa8dcf6 : 0xc8ecfa;
        g.set(x, top - 3 - j, z, c);
        if (thick) g.set(x, top - 3 - j, z - 1, c);
      }
    }
  });
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.72 }), [CH.ice]: mats.ice() }, { pivot: [(w + 4) / 2, top + 1, 0], shadow: false, ao: 0.3 });
}

// ---------------------------------------------------------------------------------------------
// Placement-aware builders
// ---------------------------------------------------------------------------------------------

/** Unit vector (dx, dz) from (x, z) toward the nearest deeper water, or null on open ground far from it. */
export function towardWater(map: MapDef, x: number, z: number): [number, number] | null {
  let best = -Infinity;
  let bx = 0;
  let bz = 0;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const d = waterDepthAt(map, x + Math.cos(a) * 1.6, z + Math.sin(a) * 1.6);
    if (d > best) {
      best = d;
      bx = Math.cos(a);
      bz = Math.sin(a);
    }
  }
  return best > -1.5 ? [bx, bz] : null;
}

export interface Placed {
  model: PropModel;
  m: THREE.Matrix4;
}

/** Lanterns strung on ropes along both long edges of the deck under (d.x, d.z), or a single string. */
export function lanternString(d: Decor, map: MapDef, height: HeightFn): Placed {
  const p = platformAt(map, d.x, d.z);
  const theme = themeOf(map);
  const V = 0.05;
  const long = p ? Math.max(p.w, p.d) : 5;
  const wide = p ? Math.min(p.w, p.d) : 0;
  const key = `lstr|${map.id}|${long.toFixed(2)}|${wide.toFixed(2)}|${d.seed}`;
  const model = cachedModel(key, () => {
    const nx = Math.round(long / V) + 12;
    const nz = Math.round(wide / V) + 12;
    const H = Math.round(2.3 / V);
    const g = new PGrid(nx, H + 8, nz);
    const iron = theme === 'wharf';
    const postCol = iron ? ironCol(d.seed, 0.1) : grain(WOOD[theme].map((c) => shade(c, 0.8)), d.seed, 1);
    const xs = [4, nx - 5];
    const zs = p ? [4, nz - 5] : [Math.floor(nz / 2)];
    const halos: Halos = [];
    const pivot: [number, number, number] = [nx / 2, 0, nz / 2];
    const glowPal = theme === 'marsh' ? [0xffb050, 0xffd070, 0xff9a50] : theme === 'tropic' ? [0xffc060, 0xff9a60, 0xffe080] : [0xffc870, 0xffd890, 0xffb860];
    for (const z of zs) {
      for (const x of xs) {
        g.on(iron ? CH.metal : CH.base, () => post(g, x + 0.5, z + 0.5, 1.6, 0, H, postCol));
        if (!iron) ropeWrap(g, x + 0.5, z + 0.5, 2.1, H - 6, 2);
        g.on(iron ? CH.metal : CH.base, () => g.box(x - 1, H + 1, z - 1, x + 1, H + 1, z + 1, iron ? 0x8a7a40 : shade(WOOD[theme][0], 0.6)));
      }
      const a: [number, number, number] = [xs[0] + 0.5, H - 1, z + 0.5];
      const b: [number, number, number] = [xs[1] + 0.5, H - 1, z + 0.5];
      const sag = 4 + long * 0.6;
      sagRope(g, a, b, sag / 2, iron ? (() => 0x2a2c30) : ropeCol, 0.5);
      const nL = Math.max(3, Math.round(long / 0.85));
      for (let k = 1; k < nL; k++) {
        const t = k / nL;
        const x = Math.round(a[0] + (b[0] - a[0]) * t);
        const y = Math.round(a[1] - sag * 4 * t * (1 - t) * 0.5) - 1;
        const glow = glowPal[k % glowPal.length];
        g.on(CH.metal, () => g.set(x, y, z, 0x2a2a2a));
        const c = lanternCage(g, x, y - 5, Math.round(z), 1, 2, glow);
        halos.push(...haloAt(c, pivot, V, glow, 1.45, 0.42));
      }
    }
    return {
      ...toModel(g, V, { [CH.base]: mats.wood(theme), [CH.metal]: mats.iron(), [CH.glow]: mats.lamp() }, { pivot, shadow: false }),
      halos,
    };
  });
  let yaw = d.rot;
  let x = d.x;
  let z = d.z;
  let y = height(d.x, d.z);
  if (p) {
    yaw = p.rot + (p.d > p.w ? Math.PI / 2 : 0);
    x = p.x;
    z = p.z;
    y = platformDeckY(map, p);
  }
  return { model, m: trs(x, y, z, yaw, 1) };
}

/** Rope bridges from the watchtower near (d.x, d.z) out to the islands around it, high above play. */
export function ropeBridges(d: Decor, map: MapDef, height: HeightFn): Placed[] {
  const tower = map.obstacles.find((o): o is Extract<Obstacle, { shape: 'circle' }> => o.shape === 'circle' && o.kind === 'watchtower' && Math.hypot(o.x - d.x, o.z - d.z) < 8);
  const ends: [number, number, number, number, number, number][] = [];
  if (tower) {
    const ty = height(tower.x, tower.z) + 2.75;
    const atTower = Math.hypot(tower.x - d.x, tower.z - d.z) < 1.5;
    // placed between the tower and an islet: one bridge to the islet across from the tower through (d.x, d.z);
    // placed on the tower itself: bridges to every islet in reach
    const far: [number, number] = [2 * d.x - tower.x, 2 * d.z - tower.z];
    const cands = map.islands.filter((isl) => {
      const dist = Math.hypot(isl.x - tower.x, isl.z - tower.z);
      return dist > isl.r + tower.r + 1 && dist < 14;
    });
    if (!atTower && cands.length) {
      cands.sort((a, b) => Math.hypot(a.x - far[0], a.z - far[1]) - Math.hypot(b.x - far[0], b.z - far[1]));
      cands.length = 1;
    }
    for (const isl of cands) {
      const dist = Math.hypot(isl.x - tower.x, isl.z - tower.z);
      const dx = (isl.x - tower.x) / dist;
      const dz = (isl.z - tower.z) / dist;
      const sx = tower.x + dx * (tower.r + 0.35);
      const sz = tower.z + dz * (tower.r + 0.35);
      const ex = isl.x - dx * Math.max(0.3, isl.r - 0.5);
      const ez = isl.z - dz * Math.max(0.3, isl.r - 0.5);
      ends.push([sx, ty, sz, ex, height(ex, ez) + 1.9, ez]);
    }
  }
  if (!ends.length) {
    const c = Math.cos(d.rot);
    const s = Math.sin(d.rot);
    const y = height(d.x, d.z) + 2.4;
    ends.push([d.x - c * 6, y, d.z + s * 6, d.x + c * 6, y, d.z - s * 6]);
  }
  const theme = themeOf(map);
  return ends.map(([sx, sy, sz, ex, ey, ez], i) => {
    const L = Math.hypot(ex - sx, ez - sz);
    const V = 0.06;
    const dy = ey - sy;
    const key = `rbr|${map.id}|${L.toFixed(2)}|${dy.toFixed(2)}|${d.seed + i}`;
    const model = cachedModel(key, () => {
      const nx = Math.round(L / V) + 6;
      const H = Math.round((Math.abs(dy) + 2.4) / V);
      const y0 = Math.round(1.6 / V) + Math.max(0, Math.round(-dy / V));
      const g = new PGrid(nx, H + 10, 20);
      const yAt = (t: number) => y0 + (dy / V) * t - (0.45 / V) * 4 * t * (1 - t);
      const plank = grain(WOOD[theme], d.seed, 2);
      const postCol = grain(WOOD[theme].map((c) => shade(c, 0.75)), d.seed + 1, 1);
      // planks hanging on two foot ropes
      for (let x = 3; x < nx - 3; x++) {
        const t = (x - 3) / (nx - 7);
        const y = Math.round(yAt(t));
        if (x % 3 !== 0) g.box(x, y, 6, x, y, 13, (xx, yy, zz) => (h3(xx, 0, 0, d.seed) < 0.12 ? -1 : plank(xx, yy, zz)));
        if (theme === 'ice' && x % 3 !== 0 && h3(x, 2, 2) < 0.6) g.box(x, y + 1, 7, x, y + 1, 12, snowCol);
      }
      // the end posts on the island (the tower end ties into the lookout)
      for (const z of [5, 14]) post(g, nx - 3.5, z + 0.5, 1.4, Math.round(yAt(1)) - Math.round(1.9 / V), Math.round(yAt(1)) + 12, postCol);
      // foot ropes and hand ropes
      for (const z of [5, 14]) {
        const pts: [number, number, number][] = [];
        for (let k = 0; k <= 12; k++) {
          const t = k / 12;
          pts.push([3 + t * (nx - 7), yAt(t), z]);
        }
        for (let k = 0; k + 1 < pts.length; k++) {
          seg(g, pts[k][0], pts[k][1], pts[k][2], pts[k + 1][0], pts[k + 1][1], pts[k + 1][2], ropeCol);
          seg(g, pts[k][0], pts[k][1] + 10 - Math.sin((k / 12) * Math.PI) * 2, pts[k][2], pts[k + 1][0], pts[k + 1][1] + 10 - Math.sin(((k + 1) / 12) * Math.PI) * 2, pts[k + 1][2], ropeCol);
        }
        // vertical hangers between hand and foot ropes
        for (let x = 6; x < nx - 6; x += 6) {
          const t = (x - 3) / (nx - 7);
          const y = yAt(t);
          seg(g, x, y, z, x, y + 10 - Math.sin(t * Math.PI) * 2, z, ropeDark);
        }
      }
      if (theme === 'ice')
        g.on(CH.ice, () => {
          for (let x = 4; x < nx - 4; x += 2) if (h3(x, 3, 3, d.seed) < 0.35) g.box(x, Math.round(yAt((x - 3) / (nx - 7))) - 3, 6 + (x % 7), x, Math.round(yAt((x - 3) / (nx - 7))) - 1, 6 + (x % 7), 0xc8ecfa);
        });
      return toModel(g, V, { [CH.base]: mats.wood(theme), [CH.ice]: mats.ice() }, { pivot: [3, y0, 9.5], shadow: true });
    });
    const yaw = Math.atan2(ex - sx, ez - sz) - Math.PI / 2;
    return { model, m: trs(sx, sy, sz, yaw, 1) };
  });
}

/** A hanging banner: off the camera side of the obstacle under it, or on its own pole. */
export function banner(d: Decor, map: MapDef, height: HeightFn): Placed {
  const host = map.obstacles.find((o): o is Extract<Obstacle, { shape: 'circle' }> => o.shape === 'circle' && Math.hypot(o.x - d.x, o.z - d.z) < o.r + 0.6);
  const v = d.seed % 3;
  const mounted = !!host;
  const key = `banner|${map.id}|${v}|${mounted}`;
  const model = cachedModel(key, () => {
    const V = 0.05;
    const g = new PGrid(34, 90, 10);
    const cx = 17;
    const z = 5;
    const topY = mounted ? 72 : 80;
    const pole = grain([0x5a4430, 0x6a5034], d.seed, 0);
    const theme = themeOf(map);
    if (!mounted) taper(g, 4, z, 1.4, 1.0, 0, topY + 4, pole);
    // the crossbar with brass caps
    g.box(mounted ? 2 : 4, topY + 1, z, 31, topY + 2, z, pole);
    g.on(CH.metal, () => {
      g.box(31, topY, z, 32, topY + 3, z, 0xc8a050);
      if (mounted) g.box(1, topY, z, 2, topY + 3, z, 0xc8a050);
    });
    const main = [0x4a2a6a, 0x1e5a5a, 0x5a3a1e][v];
    const trim = 0xd8b050;
    g.on(CH.extra, () => {
      for (let x = 7; x <= 29; x++)
        for (let y = 0; y <= 34; y++) {
          const lx = x - 18;
          const tail = y > 28 && Math.abs(lx) < (y - 28) * 1.8;
          if (tail) continue; // swallowtail cut
          let c = shade(main, 0.9 + h3(x, y, v) * 0.14);
          if (x === 7 || x === 29 || y === 0 || y === 1) c = trim;
          // emblem: a hook (v0), a fish (v1), a star (v2)
          const ex = lx;
          const ey = y - 13;
          const emb =
            v === 0
              ? (Math.abs(ex) < 1 && ey > -7 && ey < 4) || (Math.abs(Math.hypot(ex + 3, ey - 4) - 3) < 0.9 && ey > 4)
              : v === 1
                ? (ex * ex) / 30 + (ey * ey) / 9 < 1 || (ex > 5 && ex < 9 && Math.abs(ey) < (ex - 5) * 0.9)
                : Math.max(Math.abs(ex), Math.abs(ey)) < 2 || ((Math.abs(ex) < 1 || Math.abs(ey) < 1) && Math.max(Math.abs(ex), Math.abs(ey)) < 7);
          if (emb) c = theme === 'ice' ? 0xf0f6ff : 0xf0e6c8;
          g.set(x, topY - y, z, c);
        }
    });
    return toModel(
      g,
      V,
      { [CH.base]: pmat({ rough: 0.85 }), [CH.metal]: mats.brass(), [CH.extra]: pmat({ rough: 0.92, doubleSide: true, cloth: 0.07, clothLen: 1.6, clothAxis: 'down', clothTop: topY * V }) },
      { pivot: [mounted ? 2 : 4.5, 0, z + 0.5], shadow: true, noShadowCh: [CH.extra] },
    );
  });
  if (host) {
    // hang off the camera-facing (+z) side, crossbar sticking out over the edge
    const y = height(host.x, host.z) + (host.kind === 'watchtower' ? 0 : -0.8);
    return { model, m: trs(host.x + host.r * 0.25, y, host.z + host.r + 0.12, 0, 1) };
  }
  return { model, m: trs(d.x, height(d.x, d.z), d.z, d.rot, d.scale) };
}

// ---------------------------------------------------------------------------------------------
// Mist: soft low sheets drifting just above the water, one transparent draw for the whole map
// ---------------------------------------------------------------------------------------------

let mistMat: THREE.ShaderMaterial | null = null;
function mistMaterial(color: THREE.Color): THREE.ShaderMaterial {
  if (!mistMat) {
    mistMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uWaterY: { value: 0 }, uColor: { value: new THREE.Color() } }]),
      vertexShader: /* glsl */ `
        attribute vec4 aSheet; // x: lift above water, y: seed, z: alpha, w: drift radius
        uniform float uTime;
        uniform float uWaterY;
        varying vec2 vUv;
        varying float vSeed;
        varying float vA;
        #include <fog_pars_vertex>
        void main() {
          vec3 p = position;
          float s = aSheet.y;
          p.y = uWaterY + aSheet.x + sin(uTime * 0.4 + s) * 0.05;
          p.x += sin(uTime * 0.07 + s * 3.1) * aSheet.w;
          p.z += cos(uTime * 0.05 + s * 1.7) * aSheet.w;
          vUv = uv;
          vSeed = s;
          vA = aSheet.z;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying float vSeed;
        varying float vA;
        #include <fog_pars_fragment>
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
          vec2 c = vUv - 0.5;
          float edge = 1.0 - smoothstep(0.18, 0.5, length(c * vec2(1.0, 1.25)));
          vec2 q = vUv * 3.0 + vec2(uTime * 0.035 + vSeed, uTime * 0.02);
          float n = n2(q) * 0.6 + n2(q * 2.3 + 4.0) * 0.4;
          float a = edge * smoothstep(0.2, 0.95, n) * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    mistMat.uniforms.uTime = PROP_TIME;
    mistMat.uniforms.uWaterY = WATER_LEVEL;
  }
  mistMat.uniforms.uColor.value.copy(color);
  return mistMat;
}

export function mistMesh(list: Decor[], map: MapDef, q: Quality): THREE.Mesh | null {
  if (!list.length) return null;
  const layers = qLevel(q) === 0 ? 1 : qLevel(q) === 1 ? 2 : 3;
  const n = list.length * layers;
  const pos = new Float32Array(n * 12);
  const uv = new Float32Array(n * 8);
  const sheet = new Float32Array(n * 16);
  const idx = new Uint16Array(n * 6);
  let k = 0;
  for (const d of list) {
    const rnd = rngFor(d.seed);
    for (let l = 0; l < layers; l++, k++) {
      const a = rnd() * Math.PI;
      const w = (4.2 + rnd() * 2.6) * d.scale;
      const dd = (2.2 + rnd() * 1.2) * d.scale;
      const ox = d.x + (rnd() - 0.5) * 2;
      const oz = d.z + (rnd() - 0.5) * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const corners: [number, number][] = [[-w / 2, -dd / 2], [w / 2, -dd / 2], [w / 2, dd / 2], [-w / 2, dd / 2]];
      const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
      const lift = 0.12 + l * 0.22 + rnd() * 0.1;
      const s = rnd() * 100;
      const alpha = 0.2 - l * 0.04;
      for (let c = 0; c < 4; c++) {
        const [lx, lz] = corners[c];
        pos[(k * 4 + c) * 3] = ox + lx * ca - lz * sa;
        pos[(k * 4 + c) * 3 + 1] = 0;
        pos[(k * 4 + c) * 3 + 2] = oz + lx * sa + lz * ca;
        uv[(k * 4 + c) * 2] = uvs[c * 2];
        uv[(k * 4 + c) * 2 + 1] = uvs[c * 2 + 1];
        sheet.set([lift, s, alpha, 0.8 + rnd() * 0.6], (k * 4 + c) * 4);
      }
      idx.set([k * 4, k * 4 + 2, k * 4 + 1, k * 4, k * 4 + 3, k * 4 + 2], k * 6);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aSheet', new THREE.BufferAttribute(sheet, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  if (geo.boundingSphere) {
    geo.boundingSphere.center.y = map.terrain.baseHeight;
    geo.boundingSphere.radius += 4;
  }
  const atmo = map.atmosphere;
  const col = new THREE.Color(atmo.fogColor).lerp(new THREE.Color(0xffffff), 0.22);
  if (atmo.timeOfDay === 'dusk') col.lerp(new THREE.Color(0xffc8b0), 0.25);
  const mesh = new THREE.Mesh(geo, mistMaterial(col));
  mesh.name = 'mist';
  mesh.renderOrder = 5;
  mesh.userData.ownsGeometry = true;
  return mesh;
}
