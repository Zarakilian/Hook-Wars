// Decor: every DecorKind as instanced voxel models with several variants each.
// Plants sway in the wind (shared clock), lilypads float on the live water level,
// seaweed shrinks when the water drops, fireflies drift, lanterns glow.
import * as THREE from 'three';
import type { Decor, DecorKind, MapDef } from '../../../../shared/maps/types.ts';
import { riverAt } from '../../../../shared/maps/helpers.ts';
import { bedY, groundY, type HeightFn, type Quality } from '../../contracts.ts';
import {
  autoClock, blob, blotch, cachedModel, CH, h3, halo, instanceModel, mix, moodOf, PGrid, pmat, propsQuality, PROP_TIME, qLevel, rngFor, seg, shade, taper,
  toModel, trs, vn3, WATER_LEVEL, type PropModel,
} from './common.ts';
import { iceMat } from './rocks.ts';
import { StaticBatch, tickMesh } from './batch.ts';
import { banner, cargonet, cattail, chainhang, coralfan, flag, icicles, lanternString, mistMesh, ropeBridges, rowboat, towardWater, treasure } from './decor2.ts';

const VARIANTS: Record<DecorKind, number> = {
  grass: 4, reeds: 3, lilypad: 3, mushroom: 3, flower: 4, fern: 3, snowtuft: 3, icicle: 3, shell: 3, starfish: 3, seaweed: 3,
  pebbles: 3, bones: 2, lantern: 1, rope: 2, gear: 2, sign: 2, firefly_swarm: 1, waterfall: 1, lockgate: 1,
  // reference-map decor (decor2.ts); mist, lanternstring, ropebridge and banner are built per placement
  cattail: 3, mist: 1, lanternstring: 1, ropebridge: 1, banner: 3, icicles: 3, coralfan: 4, treasure: 2, chainhang: 2, cargonet: 2, rowboat: 2, flag: 3,
};

const sway = (amp: number, h: number) => pmat({ rough: 0.9, sway: amp, swayH: h });

// ---------------------------------------------------------------------------------------------
// Small decor builders. All origins at ground contact, +Z forward.
// ---------------------------------------------------------------------------------------------

function grass(v: number, map: MapDef): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 7 + 1);
  const g = new PGrid(16, 14, 16);
  const pal = map.terrain.grass;
  const blades = 6 + v * 2;
  g.on(CH.leaf, () => {
    for (let i = 0; i < blades; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 3;
      const x0 = 8 + Math.cos(a) * d;
      const z0 = 8 + Math.sin(a) * d;
      const h = 5 + Math.floor(rnd() * 7);
      const lean = 0.25 + rnd() * 0.25;
      const base = pal[Math.floor(rnd() * pal.length)];
      for (let y = 0; y < h; y++) {
        const t = y / h;
        const c = mix(shade(base, 0.75), mix(base, 0xd8e88a, 0.25), t);
        g.set(x0 + Math.cos(a) * y * lean * t, y, z0 + Math.sin(a) * y * lean * t, c);
      }
    }
    if (v === 3) {
      // a tiny wildflower in one tuft variant
      g.set(8, 9, 8, 0xfff2a0);
      g.set(8, 8, 8, 0x6a8a3a);
    }
  });
  return toModel(g, V, { [CH.leaf]: sway(0.05, 0.5) }, { shadow: false, ao: 0.35 });
}

function reeds(v: number, map: MapDef): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 11 + 3);
  const g = new PGrid(18, 32, 18);
  const swamp = map.id === 'muckmire';
  const stems = [0x5a7a32, 0x6a8a3a, 0x4f6a2c, 0x7a8f40];
  g.on(CH.leaf, () => {
    const n = 6 + v * 2;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 4;
      const x0 = 9 + Math.cos(a) * d;
      const z0 = 9 + Math.sin(a) * d;
      const h = 16 + Math.floor(rnd() * 13);
      const lx = (rnd() - 0.5) * 0.12;
      const lz = (rnd() - 0.5) * 0.12;
      const c = stems[i % stems.length];
      for (let y = 0; y < h; y++) g.set(x0 + lx * y, y, z0 + lz * y, y < 3 ? shade(c, 0.7) : c);
      if (swamp && i % 2 === 0) {
        // cattail head
        for (let y = h - 6; y < h - 1; y++) {
          g.set(x0 + lx * y, y, z0 + lz * y, h3(i, y, 0) < 0.3 ? 0x3a2618 : 0x4a3220);
          g.set(x0 + lx * y + 1, y, z0 + lz * y, 0x3a2618);
        }
      } else if (i % 3 === 0) {
        // long leaf arching out
        for (let k = 0; k < 9; k++) g.set(x0 + Math.cos(a) * k * 0.7, 4 + k - Math.floor((k * k) / 9), z0 + Math.sin(a) * k * 0.7, mix(c, 0xa8b860, k / 12));
      }
    }
  });
  return toModel(g, V, { [CH.leaf]: sway(0.09, 1.3) }, { shadow: false, ao: 0.3 });
}

function lilypad(v: number): PropModel {
  const V = 0.05;
  const g = new PGrid(20, 4, 20);
  const r = 7 + v;
  const notch = v * 1.7;
  const pal = [0x3f7a2a, 0x4a8a30, 0x56963a];
  for (let z = 0; z < 20; z++)
    for (let x = 0; x < 20; x++) {
      const dx = x + 0.5 - 10;
      const dz = z + 0.5 - 10;
      const d = Math.hypot(dx, dz);
      if (d > r) continue;
      const a = Math.atan2(dz, dx);
      if (Math.abs(((a - notch + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.22 && d > 1.5) continue;
      const vein = Math.abs(Math.sin(a * 4.5)) < 0.12;
      const rim = d > r - 1.2;
      g.set(x, 0, z, rim ? 0x6aa84a : vein ? 0x2f6a22 : pal[Math.floor(h3(x, 0, z, v) * 3)]);
    }
  if (v === 1) {
    // pink water-lily flower
    const petals = [0xffb8d8, 0xff9ac8, 0xfff0f6];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      g.set(10 + Math.cos(a) * 2, 1, 10 + Math.sin(a) * 2, petals[k % 3]);
      g.set(10 + Math.cos(a) * 1.4, 2, 10 + Math.sin(a) * 1.4, petals[(k + 1) % 3]);
    }
    g.set(10, 1, 10, 0xffe060);
    g.set(10, 2, 10, 0xffd040);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.45, float: true }) }, { shadow: false, ao: 0.3 });
}

function mushroom(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 13 + 5);
  const g = new PGrid(20, 16, 20);
  const n = 2 + v;
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const d = i === 0 ? 0 : 3 + rnd() * 3;
    const x0 = 10 + Math.cos(a) * d;
    const z0 = 10 + Math.sin(a) * d;
    const h = (i === 0 ? 7 : 3) + Math.floor(rnd() * 3);
    const cr = i === 0 ? 3.6 : 2.2;
    taper(g, x0, z0, 1.2, 0.9, 0, h, 0xeae0c8);
    const glow = v === 2;
    const capCol = v === 0 ? 0xd8382a : v === 1 ? 0x9a6a3e : 0x4ae0d8;
    g.on(glow ? CH.glow : CH.base, () => {
      for (let y = 0; y < 3; y++) {
        const rr = cr * (1 - y * 0.28);
        for (let z = Math.floor(z0 - rr - 1); z <= z0 + rr + 1; z++)
          for (let x = Math.floor(x0 - rr - 1); x <= x0 + rr + 1; x++) {
            const dd = Math.hypot(x + 0.5 - x0, z + 0.5 - z0);
            if (dd > rr) continue;
            const spot = v === 0 && y > 0 && h3(x, y, z, i) < 0.22;
            g.set(x, h + 1 + y, z, spot ? 0xfff6e8 : shade(capCol, 0.9 + h3(x, y, z) * 0.2));
          }
      }
    });
    // gills
    g.set(x0, h, z0, 0xc8b8a0);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.6 }), [CH.glow]: pmat({ glow: 2.2, pulse: 0.35, rough: 0.4 }) }, { shadow: false });
}

function flower(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 17 + 7);
  const g = new PGrid(18, 14, 18);
  const petals = [[0xff6a8a, 0xff9ab0], [0xffd84a, 0xfff0a0], [0xa87aff, 0xc8a8ff], [0xffffff, 0xf0e8ff]][v % 4];
  g.on(CH.leaf, () => {
    for (let i = 0; i < 4; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 4;
      const x0 = 9 + Math.cos(a) * d;
      const z0 = 9 + Math.sin(a) * d;
      const h = 5 + Math.floor(rnd() * 5);
      for (let y = 0; y < h; y++) g.set(x0, y, z0, 0x4f7a2e);
      g.set(x0 + 1, 2, z0, 0x5f8a36);
      g.set(x0 - 1, 3, z0, 0x5f8a36);
      for (let k = 0; k < 4; k++) {
        const pa = (k / 4) * Math.PI * 2;
        g.set(x0 + Math.round(Math.cos(pa)), h, z0 + Math.round(Math.sin(pa)), petals[k % 2]);
      }
      g.set(x0, h, z0, 0xffc030);
      g.set(x0, h + 1, z0, petals[1]);
    }
  });
  return toModel(g, V, { [CH.leaf]: sway(0.05, 0.45) }, { shadow: false, ao: 0.3 });
}

function fern(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 19 + 9);
  const g = new PGrid(30, 16, 30);
  const pal = [0x3f6a26, 0x4a7a2c, 0x568a34];
  g.on(CH.leaf, () => {
    const n = 5 + v;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.4;
      const L = 10 + rnd() * 4;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let prev: [number, number, number] = [15, 1, 15];
      const c = pal[i % pal.length];
      for (let s = 1; s <= L; s++) {
        const t = s / L;
        const p: [number, number, number] = [15 + ca * s, 1 + Math.sin(t * Math.PI * 0.8) * 9 - t * t * 4, 15 + sa * s];
        seg(g, prev[0], prev[1], prev[2], p[0], p[1], p[2], shade(c, 0.85));
        prev = p;
        const ll = Math.round(3 * Math.sin(t * Math.PI) + 0.5);
        for (let k = 1; k <= ll; k++) {
          g.set(p[0] - sa * k, p[1] - k * 0.4, p[2] + ca * k, mix(c, 0x8ab84a, t * 0.5));
          g.set(p[0] + sa * k, p[1] - k * 0.4, p[2] - ca * k, mix(c, 0x8ab84a, t * 0.5));
        }
      }
    }
  });
  return toModel(g, V, { [CH.leaf]: sway(0.06, 0.6) }, { shadow: false, ao: 0.35 });
}

function snowtuft(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 23 + 1);
  const g = new PGrid(22, 12, 22);
  const snow = (x: number, y: number, z: number) => (h3(x, y, z) < 0.3 ? 0xdde9f6 : 0xf4f9ff);
  blob(g, 11, 0, 11, 7 + v, 3 + v * 0.5, 6 + v, 0.25, v, snow, 0.3);
  g.on(CH.leaf, () => {
    for (let i = 0; i < 4 + v; i++) {
      const x0 = 11 + (rnd() - 0.5) * 8;
      const z0 = 11 + (rnd() - 0.5) * 8;
      const h = 3 + Math.floor(rnd() * 5);
      let y0 = 6;
      while (y0 > 0 && !g.solid(Math.floor(x0), y0 - 1, Math.floor(z0))) y0--;
      const c = v === 2 ? 0x6a4a32 : 0x8a9a6a;
      for (let y = 0; y < h; y++) g.set(x0 + (y > 2 ? 1 : 0), y0 + y, z0, y === h - 1 ? 0xeef6ff : c);
    }
  });
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.7 }), [CH.leaf]: sway(0.03, 0.4) }, { shadow: false, ao: 0.4 });
}

function icicle(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 29 + 3);
  const g = new PGrid(20, 26, 20);
  const tints = [0xcdeefc, 0xa8dcf6, 0xe0f6ff];
  g.on(CH.ice, () => {
    for (let i = 0; i < 3 + v; i++) {
      const x0 = 10 + (rnd() - 0.5) * 9;
      const z0 = 10 + (rnd() - 0.5) * 9;
      const h = 8 + Math.floor(rnd() * 16);
      const r0 = 1.6 + rnd() * 1.2;
      const lx = (rnd() - 0.5) * 0.25;
      const lz = (rnd() - 0.5) * 0.25;
      for (let y = 0; y < h; y++) {
        const rr = r0 * (1 - y / h) + 0.3;
        for (let z = Math.floor(z0 - rr - 1); z <= z0 + rr + 1; z++)
          for (let x = Math.floor(x0 - rr - 1); x <= x0 + rr + 1; x++)
            if (Math.abs(x + 0.5 - x0 - lx * y) + Math.abs(z + 0.5 - z0 - lz * y) <= rr) g.set(x + lx * y, y, z + lz * y, tints[(i + (y > h * 0.7 ? 1 : 0)) % 3]);
      }
    }
  });
  return toModel(g, V, { [CH.ice]: iceMat() }, { shadow: false, ao: 0.3 });
}

function shell(v: number): PropModel {
  const V = 0.04;
  const g = new PGrid(16, 8, 16);
  if (v === 0) {
    // scallop fan with ridges
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) {
        const dx = x + 0.5 - 8;
        const dz = z + 0.5 - 4;
        const d = Math.hypot(dx, dz);
        const a = Math.atan2(dz, dx);
        if (d > 7 || a < 0.2 || a > Math.PI - 0.2) continue;
        const ridge = Math.sin(a * 9) > 0.3;
        const hh = Math.floor((1 - d / 7) * 3) + (ridge ? 1 : 0);
        for (let y = 0; y <= hh; y++) g.set(x, y, z, ridge ? 0xffb8a0 : 0xfff0e0);
      }
  } else if (v === 1) {
    // spiral conch
    for (let t = 0; t < 1; t += 0.01) {
      const a = t * Math.PI * 5;
      const rr = 1 + t * 4;
      const x = 8 + Math.cos(a) * rr * 0.6;
      const z = 8 + Math.sin(a) * rr * 0.6 + (1 - t) * 3;
      seg(g, x, rr * 0.5, z, x, rr * 0.5, z, t > 0.85 ? 0xffd0c0 : t % 0.2 < 0.1 ? 0xe8c8a0 : 0xf8e4c8, rr * 0.45);
    }
  } else {
    // little spotted cowrie
    blob(g, 8, 1, 8, 4, 2.4, 3, 0.05, 3, (x, y, z) => (h3(x, y, z) < 0.25 ? 0x8a5a3a : 0xf0d8b0));
    g.box(5, 3, 8, 11, 3, 8, 0x5a3a24);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.35 }) }, { shadow: false, ao: 0.35 });
}

function starfish(v: number): PropModel {
  const V = 0.04;
  const g = new PGrid(22, 4, 22);
  const col = [0xff8a3a, 0xff5a7a, 0xa86ad8][v % 3];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + v * 0.3;
    for (let s = 0; s < 10; s++) {
      const w = 2.4 * (1 - s / 11);
      const cx = 11 + Math.cos(a) * s;
      const cz = 11 + Math.sin(a) * s;
      for (let z = Math.floor(cz - w); z <= cz + w; z++)
        for (let x = Math.floor(cx - w); x <= cx + w; x++) {
          if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) > w) continue;
          g.set(x, 0, z, col);
          if (s < 6 && Math.hypot(x + 0.5 - cx, z + 0.5 - cz) < w * 0.5) g.set(x, 1, z, h3(x, s, z) < 0.3 ? 0xfff0d8 : shade(col, 1.1));
        }
    }
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.55 }) }, { shadow: false, ao: 0.3 });
}

function seaweed(v: number): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 31 + 5);
  const g = new PGrid(16, 34, 16);
  const pal = v === 2 ? [0xc84a6a, 0xd85a7a, 0xa83a5a] : [0x2f7a3a, 0x3a8a44, 0x4a9a50, 0x5aa85a];
  g.on(CH.leaf, () => {
    for (let i = 0; i < 4 + v; i++) {
      const x0 = 8 + (rnd() - 0.5) * 6;
      const z0 = 8 + (rnd() - 0.5) * 6;
      const h = 14 + Math.floor(rnd() * 18);
      const ph = rnd() * 6;
      for (let y = 0; y < h; y++) {
        const x = x0 + Math.sin(y * 0.35 + ph) * 1.4;
        const c = pal[(i + Math.floor(y / 5)) % pal.length];
        g.set(x, y, z0, c);
        if (y % 4 === 1) g.set(x + 1, y, z0, shade(c, 1.1));
        if (y % 5 === 3) g.set(x, y, z0 + 1, shade(c, 0.9));
      }
    }
  });
  return toModel(g, V, { [CH.leaf]: pmat({ rough: 0.6, sway: 0.16, swayH: 1.4, kelp: true }) }, { shadow: false, ao: 0.3 });
}

function pebbles(v: number, map: MapDef): PropModel {
  const V = 0.05;
  const rnd = rngFor(v * 37 + 7);
  const g = new PGrid(24, 6, 24);
  const pal = map.terrain.cliff;
  for (let i = 0; i < 3 + v * 2; i++) {
    const x = 12 + (rnd() - 0.5) * 16;
    const z = 12 + (rnd() - 0.5) * 16;
    const r = 1.2 + rnd() * 2;
    const c = pal[Math.floor(rnd() * pal.length)];
    blob(g, x, 0, z, r, r * 0.65, r * 0.9, 0.15, i, (xx, yy, zz) => shade(c, 0.9 + h3(xx, yy, zz) * 0.2 + yy * 0.04), 0.4);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.8 }) }, { shadow: false, ao: 0.45 });
}

function bones(v: number): PropModel {
  const V = 0.04;
  const g = new PGrid(30, 8, 20);
  const bone = (x: number, y: number, z: number) => (h3(x, y, z) < 0.2 ? 0xe0d4b8 : 0xf4ecd8);
  if (v === 0) {
    // cartoon fish skeleton: round skull, spine, ribs, tail fan
    blob(g, 6, 2, 10, 3.5, 3, 3.2, 0.05, 1, bone);
    g.set(4, 4, 8, 0x2a2a2a);
    g.set(4, 4, 12, 0x2a2a2a);
    seg(g, 9, 2, 10, 23, 2, 10, bone, 0.7);
    for (let k = 0; k < 5; k++) {
      const x = 11 + k * 2.4;
      const l = 5 - Math.abs(k - 1.5);
      seg(g, x, 2, 10, x + 1, 2, 10 + l, bone);
      seg(g, x, 2, 10, x + 1, 2, 10 - l, bone);
    }
    for (let k = -3; k <= 3; k++) seg(g, 23, 2, 10, 28, 2, 10 + k, bone);
  } else {
    // big comic bone
    seg(g, 6, 2, 10, 24, 2, 10, bone, 1.4);
    for (const x of [5, 25])
      for (const dz of [-2, 2]) blob(g, x, 2, 10 + dz, 2.2, 2, 2.2, 0.05, 2, bone);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.7 }) }, { shadow: false, ao: 0.4 });
}

function rope(v: number): PropModel {
  const V = 0.04;
  const g = new PGrid(30, 8, 30);
  const col = (k: number) => (k % 4 < 2 ? 0xd2b07a : 0xa8844e);
  let k = 0;
  for (let ring = 0; ring < 3; ring++) {
    const rr = 9 - ring * 2.2;
    for (let t = 0; t < 1; t += 0.008) {
      const a = t * Math.PI * 2;
      seg(g, 15 + Math.cos(a) * rr, 1 + ring, 15 + Math.sin(a) * rr, 15 + Math.cos(a) * rr, 1 + ring, 15 + Math.sin(a) * rr, col(k++), 1.1);
    }
  }
  // trailing end
  for (let t = 0; t < 1; t += 0.03) seg(g, 24 + t * 5, 1, 15 + Math.sin(t * 6) * 3, 24 + t * 5, 1, 15 + Math.sin(t * 6) * 3, col(k++), 0.9);
  if (v === 1) {
    // iron mooring ring
    for (let t = 0; t < 1; t += 0.02) {
      const a = t * Math.PI * 2;
      g.on(CH.metal, () => g.set(15 + Math.cos(a) * 3, 3 + Math.sin(a) * 3 + 3, 15, 0x50555e));
    }
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.95 }), [CH.metal]: pmat({ metal: 0.7, rough: 0.4 }) }, { shadow: false, ao: 0.45 });
}

function gear(v: number): PropModel {
  const V = 0.05;
  const g = new PGrid(28, 14, 28);
  const R = 9 + v * 2;
  const teeth = 10 + v * 2;
  const tilt = 0.35;
  g.on(CH.metal, () => {
    for (let z = 0; z < 28; z++)
      for (let x = 0; x < 28; x++) {
        const dx = x + 0.5 - 14;
        const dz = z + 0.5 - 14;
        const d = Math.hypot(dx, dz);
        const a = Math.atan2(dz, dx);
        const tooth = Math.cos(a * teeth) > 0.2 ? 2 : 0;
        if (d > R + tooth || (d < R * 0.35 && d > R * 0.18)) continue;
        const spoke = d > R * 0.35 && d < R - 2 && Math.abs(Math.sin(a * 3)) > 0.25;
        if (spoke) continue;
        const y = Math.round(dx * tilt) + 4;
        const c = vn3(x * 0.3, 0, z * 0.3, v) > 0.65 ? 0x7a4a26 : vn3(x * 0.5, 1, z * 0.5, v + 3) > 0.55 ? 0xd8b050 : 0xb8903a;
        g.set(x, y, z, c);
        g.set(x, y + 1, z, c);
      }
  });
  // half buried: dirt mound over one side
  blob(g, 4, 0, 14, 5, 3, 7, 0.3, v, (x, y, z) => (h3(x, y, z) < 0.5 ? 0x4a3d30 : 0x5a4a3a));
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.95 }), [CH.metal]: pmat({ metal: 0.85, rough: 0.35 }) }, { shadow: false, ao: 0.4 });
}

function sign(v: number): PropModel {
  const V = 0.05;
  const g = new PGrid(30, 34, 12);
  const wood = (x: number, y: number, z: number) => shade(0x8a6a42, 0.88 + vn3(x * 0.3, y * 0.3, z, 3) * 0.24);
  g.box(14, 0, 5, 15, 26, 6, wood);
  const boards: [number, number][] = v === 0 ? [[22, 1], [16, -1]] : [[20, 1]];
  for (const [y, dir] of boards) {
    const x0 = dir > 0 ? 15 : 2;
    const x1 = dir > 0 ? 27 : 14;
    g.box(x0, y, 4, x1, y + 4, 4, (x, yy, z) => shade(0xb08a5a, 0.9 + h3(x, yy, z) * 0.15));
    // arrow tip
    const tipX = dir > 0 ? x1 + 1 : x0 - 1;
    g.box(tipX, y + 1, 4, tipX, y + 3, 4, 0xa07a4a);
    g.set(tipX + dir, y + 2, 4, 0xa07a4a);
    // painted fish pictogram
    const px = Math.floor((x0 + x1) / 2) - 2;
    for (let k = 0; k < 5; k++) g.set(px + k, y + 2, 3, k === 4 ? 0x2a4a6a : 0x3a6a9a);
    g.set(px + 1, y + 3, 3, 0x3a6a9a);
    g.set(px + 1, y + 1, 3, 0x3a6a9a);
  }
  g.box(13, 26, 5, 16, 27, 6, 0x6a4a2a);
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.85 }) }, { pivot: [14.5, 0, 5.5], shadow: true });
}

function lantern(_v: number, map: MapDef): PropModel {
  const V = 0.05;
  const g = new PGrid(24, 44, 24);
  const dock = map.id === 'cogwater' || map.id === 'frostfang';
  const cx = 12;
  const cz = 12;
  const wood = (x: number, y: number, z: number) => shade(0x5a4430, 0.85 + vn3(x * 0.4, y * 0.15, z * 0.4, 2) * 0.3);
  const iron = (x: number, y: number, z: number) => (h3(x, y, z) < 0.2 ? 0x3a414a : 0x262c33);
  if (dock) {
    g.on(CH.metal, () => {
      taper(g, cx, cz, 3, 2.5, 0, 3, iron);
      taper(g, cx, cz, 1.4, 1.2, 4, 38, iron);
      seg(g, cx, 37, cz, cx + 7, 37, cz, iron);
      g.set(cx + 7, 36, cz, iron(0, 0, 0));
      g.set(cx + 7, 35, cz, iron(0, 0, 0));
    });
  } else {
    // crooked swamp stick
    for (let y = 0; y < 38; y++) {
      const ox = Math.sin(y * 0.15) * 1.5;
      taper(g, cx + ox, cz, 1.4, 1.4, y, y, wood);
    }
    seg(g, cx + Math.sin(37 * 0.15) * 1.5, 37, cz, cx + 7, 38, cz, wood, 0.6);
    g.set(cx + 7, 37, cz, 0x2a2a2a);
    g.set(cx + 7, 36, cz, 0x2a2a2a);
  }
  // hanging lantern body
  const lx = cx + 7;
  const ly = 27;
  g.on(CH.metal, () => {
    g.box(lx - 3, ly + 6, cz - 3, lx + 3, ly + 6, cz + 3, iron);
    g.box(lx - 2, ly + 7, cz - 2, lx + 2, ly + 7, cz + 2, iron);
    g.set(lx, ly + 8, cz, iron(0, 0, 0));
    g.box(lx - 3, ly - 1, cz - 3, lx + 3, ly - 1, cz + 3, iron);
    for (const sx of [-3, 3]) for (const sz of [-3, 3]) g.box(lx + sx, ly, cz + sz, lx + sx, ly + 5, cz + sz, iron);
  });
  const glowCol = dock ? 0xffd890 : 0xe8ff9a;
  g.on(CH.glow, () => g.box(lx - 2, ly, cz - 2, lx + 2, ly + 5, cz + 2, (x, y, z) => (Math.abs(x - lx) < 2 && Math.abs(z - cz) < 2 ? 0xfff4c0 : h3(x, y, z) < 0.3 ? shade(glowCol, 0.85) : glowCol)));
  return {
    ...toModel(g, V, { [CH.base]: pmat({ rough: 0.9 }), [CH.metal]: pmat({ metal: 0.6, rough: 0.45 }), [CH.glow]: pmat({ glow: 3.2, flicker: 0.2 }) }, { pivot: [cx + 0.5, 0, cz + 0.5], shadow: true }),
    halos: [
      { pos: [(lx - cx) * V, (ly + 2.5) * V, 0], color: dock ? 0xffb060 : 0xb8e060, size: 1.7, opacity: 0.32 },
      { pos: [(lx - cx) * V, (ly + 2.5) * V, 0], color: 0xfff0c0, size: 0.6, opacity: 0.7 },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Big one-off decor: waterfall lip and lock gates. Built in world-relative metres.
// ---------------------------------------------------------------------------------------------

function waterfallLip(d: Decor, map: MapDef): THREE.Group {
  const r = riverAt(map.river.points, d.z);
  const hw = r.hw + map.river.bank * 0.4;
  const model = cachedModel(`wf|${map.id}|${d.seed}|${hw.toFixed(2)}`, () => waterfallModel(d, map, hw));
  const grp = new THREE.Group();
  for (const p of model.parts) {
    const m = new THREE.Mesh(p.geo, p.mat);
    m.castShadow = qLevel(propsQuality()) >= 1;
    m.receiveShadow = true;
    grp.add(m);
  }
  // local z = 0 is the map edge, rocks extend outward (-z when rot = 0 at z = -d/2)
  grp.position.set(r.x, bedY(map), d.z);
  grp.rotation.y = d.rot + Math.PI;
  return grp;
}

function waterfallModel(d: Decor, map: MapDef, hw: number): PropModel {
  const V = 0.12;
  const span = hw * 2 + 9;
  const nx = Math.ceil(span / V);
  const depth = 3.4;
  const nz = Math.ceil(depth / V);
  const gy = groundY(map);
  const by = bedY(map);
  const top = gy + 2.6;
  const ny = Math.ceil((top - by) / V) + 2;
  const g = new PGrid(nx, ny, nz);
  const rock = blotch([0x8a7a62, 0x9a8a70, 0x7a6a54, 0xa89880, 0x6e6050], 0.12, d.seed, 0.3);
  const moss = blotch([0x4c7a2e, 0x5a8a34, 0x6a9a3a], 0.2, d.seed + 2, 0.3);
  const cxv = nx / 2;
  const rnd = rngFor(d.seed * 97 + 3);
  // back cliff: tall boulders behind the edge, with a notch where the channel is
  for (let i = 0; i < 26; i++) {
    const side = i % 2 ? 1 : -1;
    const off = hw * 0.75 + rnd() * (span / 2 - hw * 0.75);
    const x = cxv + (side * off) / V;
    const z = nz * (0.35 + rnd() * 0.65);
    const rr = (0.7 + rnd() * 0.9) / V;
    const yTop = (top - by) / V - rnd() * 6;
    blob(g, x, yTop * 0.55, z, rr, yTop * 0.55, rr * 0.9, 0.25, d.seed + i, rock, 0.15);
  }
  // the sill the water pours over (recessed, low)
  for (let i = 0; i < 9; i++) {
    const x = cxv + ((i - 4) / 4) * (hw * 0.8) / V;
    const yy = (gy - 0.15 - by) / V;
    blob(g, x, yy * 0.5, nz * 0.85, (0.6 + rnd() * 0.3) / V, yy * 0.5, 0.55 / V, 0.2, d.seed + 50 + i, rock, 0.2);
  }
  capTop(g, 2, (x, y, z) => fbm3(x * 0.1, y * 0.1, z * 0.1, d.seed) > 0.42, moss);
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.88 }) }, { pivot: [cxv, 0, 0] });
}

function capTop(g: PGrid, depth: number, pred: (x: number, y: number, z: number) => boolean, col: (x: number, y: number, z: number) => number): void {
  for (let z = 0; z < g.nz; z++)
    for (let x = 0; x < g.nx; x++) {
      let dd = 0;
      for (let y = g.ny - 1; y >= 0; y--) {
        if (!g.solid(x, y, z)) {
          dd = 0;
          continue;
        }
        if (dd < depth && pred(x, y, z)) g.set(x, y, z, col(x, y, z));
        dd++;
      }
    }
}

function fbm3(x: number, y: number, z: number, seed: number): number {
  return vn3(x, y, z, seed) * 0.66 + vn3(x * 2.1, y * 2.1, z * 2.1, seed + 7) * 0.34;
}

interface LockGateView {
  group: THREE.Group;
  leaves: THREE.Object3D[];
  open: number;
}

function lockGate(d: Decor, map: MapDef): LockGateView {
  const r = riverAt(map.river.points, d.z);
  const hw = r.hw;
  const gy = groundY(map);
  const by = bedY(map);
  const grp = new THREE.Group();
  grp.position.set(r.x, 0, d.z);
  grp.rotation.y = d.rot;
  const key = `lockgate|${hw.toFixed(2)}|${gy.toFixed(2)}|${by.toFixed(2)}`;
  const V = 0.1;
  // --- stone lock walls on each bank (static)
  const walls = cachedModel(key + '|walls', () => {
    const W = 2.6;
    const nx = Math.ceil((hw * 2 + W * 2) / V);
    const nz = Math.ceil(3.2 / V);
    const ny = Math.ceil((gy + 0.5 - by) / V) + 2;
    const g = new PGrid(nx, ny, nz);
    const stone = (x: number, y: number, z: number) => {
      const row = Math.floor(y / 4);
      const col = Math.floor((x + z + (row % 2) * 3) / 6);
      const joint = y % 4 === 0 || (x + z + (row % 2) * 3) % 6 === 0;
      const base = [0x6a6660, 0x7a766e, 0x86827a, 0x5e5a54][Math.floor(h3(row, col, 1) * 4)];
      return joint ? shade(base, 0.7) : shade(base, 0.95 + h3(x, y, z) * 0.1);
    };
    const inner = Math.round(hw / V);
    const cx = nx / 2;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const dx = Math.abs(x + 0.5 - cx);
          if (dx < inner) continue;
          // coping stones on top
          const yTop = Math.round((gy - by) / V);
          if (y > yTop + 1) continue;
          g.set(x, y, z, y >= yTop ? (h3(x, y, z) < 0.3 ? 0x9a968c : 0xaaa69a) : stone(x, y, z));
        }
    // iron bollards and the paddle gear posts on the copings
    const yTop = Math.round((gy - by) / V) + 2;
    g.on(CH.metal, () => {
      for (const side of [-1, 1]) {
        const x = cx + side * (inner + 6);
        taper(g, x, nz * 0.25, 2.2, 1.6, yTop, yTop + 7, 0x2a2f36);
        taper(g, x, nz * 0.25, 2.6, 2.6, yTop + 8, yTop + 8, 0x3a4048);
        // paddle gear: post + gear wheel + rack
        const px = cx + side * (inner + 3);
        g.box(px, yTop, Math.floor(nz * 0.7), px + 1, yTop + 9, Math.floor(nz * 0.7) + 1, 0x2a2f36);
        for (let t = 0; t < 1; t += 0.03) {
          const a = t * Math.PI * 2;
          const gr = Math.cos(a * 8) > 0 ? 3 : 2.3;
          g.set(px + 2, yTop + 7 + Math.sin(a) * gr, Math.floor(nz * 0.7) + Math.cos(a) * gr, 0xb8903a);
        }
        g.box(px + 3, yTop + 2, Math.floor(nz * 0.7), px + 3, yTop + 12, Math.floor(nz * 0.7), 0x4a5058);
      }
    });
    // moss and wet stain near the waterline
    g.recolor((c, x, y, z) => (y < (gy - 0.4 - by) / V && h3(x, y, z, 4) < 0.35 ? mix(c, 0x3a5a3a, 0.5) : c));
    return toModel(g, V, { [CH.base]: pmat({ rough: 0.9 }), [CH.metal]: pmat({ metal: 0.7, rough: 0.4 }) }, { pivot: [cx, 0, nz / 2] });
  });
  for (const p of walls.parts) {
    const m = new THREE.Mesh(p.geo, p.mat);
    m.position.y = by;
    m.castShadow = p.shadow;
    m.receiveShadow = true;
    grp.add(m);
  }
  // --- two gate leaves (mitre gates), each hinged at a bank and meeting in the middle
  const leafModel = cachedModel(key + '|leaf', () => {
    const len = hw + 0.15;
    const nx = Math.ceil((len + 3.2) / V);
    const nz = Math.ceil(0.9 / V);
    const H = Math.ceil((gy + 0.55 - by) / V);
    const g = new PGrid(nx, H + 6, nz + 4);
    const wood = (x: number, y: number, z: number) => shade([0x5a4028, 0x664a2e, 0x704f30, 0x4e3824][Math.floor(vn3(x * 0.08, y * 0.6, z, 2) * 4) % 4], 0.92 + h3(x, y, z) * 0.12);
    const gateLen = Math.ceil(len / V);
    // heel post at x = 0 (hinge), gate body to gateLen
    g.box(0, 0, 2, gateLen, H, nz + 1, (x, y, z) => {
      const c = wood(x, y, z);
      return y % 5 === 0 ? shade(c, 0.7) : c;
    });
    g.box(0, 0, 1, 2, H + 1, nz + 2, (x, y, z) => shade(wood(x, y, z), 0.85));
    // iron straps and rivets on both faces
    g.on(CH.metal, () => {
      for (let k = 0; k < 4; k++) {
        const y = Math.round(3 + (k / 3) * (H - 6));
        g.box(0, y, 1, gateLen, y + 1, 1, 0x3a3f46);
        g.box(0, y, nz + 2, gateLen, y + 1, nz + 2, 0x3a3f46);
        for (let x = 2; x < gateLen; x += 4) {
          g.set(x, y + 1, 0, 0x6a7078);
          g.set(x, y + 1, nz + 3, 0x6a7078);
        }
      }
      // diagonal brace
      for (let x = 0; x < gateLen; x++) {
        const y = Math.round((x / gateLen) * (H - 4)) + 2;
        g.set(x, y, 1, 0x4a4f56);
        g.set(x, y + 1, 1, 0x4a4f56);
      }
      // walkway handrail
      for (let x = 2; x < gateLen; x += 6) g.box(x, H + 1, 1, x, H + 4, 1, 0x2a2f36);
      g.box(0, H + 4, 1, gateLen, H + 4, 1, 0x3a4048);
    });
    // walkway planks on top
    g.box(0, H + 1, 2, gateLen, H + 1, nz + 1, (x, y, z) => (x % 3 === 0 ? 0x5a4028 : 0x8a6a42));
    return toModel(g, V, { [CH.base]: pmat({ rough: 0.85 }), [CH.metal]: pmat({ metal: 0.65, rough: 0.45 }) }, { pivot: [0, 0, (nz + 4) / 2] });
  });
  const beamModel = cachedModel('lockgate|beam', () => {
    const g = new PGrid(32, 6, 6);
    g.box(0, 1, 1, 31, 4, 4, (x, y, z) => shade(0xe8e0d0, 0.9 + h3(x, y, z) * 0.1)); // white painted beam
    g.box(26, 1, 1, 31, 4, 4, 0x2a2a2a); // black tip
    return toModel(g, 0.1, { [CH.base]: pmat({ rough: 0.7 }) }, { pivot: [0, 0, 3] });
  });
  const leaves: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(side * (hw + 0.05), by, 0);
    // leaf extends from hinge toward the centre
    const leaf = new THREE.Group();
    leaf.rotation.y = side > 0 ? Math.PI : 0;
    for (const p of leafModel.parts) {
      const m = new THREE.Mesh(p.geo, p.mat);
      m.castShadow = p.shadow;
      m.receiveShadow = true;
      leaf.add(m);
    }
    const beam = new THREE.Group();
    for (const p of beamModel.parts) {
      const m = new THREE.Mesh(p.geo, p.mat);
      m.castShadow = p.shadow;
      m.receiveShadow = true;
      beam.add(m);
    }
    beam.position.set(0, gy - by + 0.15, -0.2);
    beam.rotation.y = Math.PI + 0.25; // points back over the bank
    leaf.add(beam);
    hinge.add(leaf);
    hinge.userData.side = side;
    grp.add(hinge);
    leaves.push(hinge);
  }
  return { group: grp, leaves, open: 0 };
}

// ---------------------------------------------------------------------------------------------
// Fireflies: one Points cloud for every swarm, animated in the vertex shader.
// ---------------------------------------------------------------------------------------------

const fireflyCache = new Map<string, THREE.Points>();

/** One Points cloud per map (cached: positions are deterministic per map, so the set is bounded). */
function fireflies(list: Decor[], height: HeightFn, q: Quality, mapId: string): THREE.Points | null {
  if (!list.length) return null;
  const per = qLevel(q) === 0 ? 7 : qLevel(q) === 1 ? 12 : 18;
  const key = `${mapId}|${list.length}|${list[0].seed}|${per}`;
  const hit = fireflyCache.get(key);
  if (hit) {
    // a Points object can only live in one scene graph; clone shares geometry and material
    const c = new THREE.Points(hit.geometry, hit.material);
    c.frustumCulled = false;
    c.renderOrder = 4;
    c.onBeforeRender = hit.onBeforeRender;
    return c;
  }
  const n = list.length * per;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  let k = 0;
  for (const d of list) {
    const rnd = rngFor(d.seed);
    const base = height(d.x, d.z);
    for (let i = 0; i < per; i++, k++) {
      const a = rnd() * Math.PI * 2;
      const r = rnd() * 2.2 * d.scale;
      pos[k * 3] = d.x + Math.cos(a) * r;
      pos[k * 3 + 1] = base + 0.5 + rnd() * 1.8;
      pos[k * 3 + 2] = d.z + Math.sin(a) * r;
      seed[k] = rnd() * 100;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const uScale = { value: 400 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: PROP_TIME, uScale, uColor: { value: new THREE.Color(0xd8ff70) } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uScale;
      attribute float aSeed;
      varying float vA;
      void main() {
        vec3 p = position;
        float t = uTime * 0.6 + aSeed;
        p.x += sin(t * 1.3) * 0.7 + sin(t * 2.9) * 0.2;
        p.y += sin(t * 1.7 + 1.0) * 0.35;
        p.z += cos(t * 1.1) * 0.7 + cos(t * 3.1) * 0.2;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float blink = 0.5 + 0.5 * sin(uTime * 2.3 + aSeed * 7.0);
        vA = 0.25 + 0.75 * blink * blink;
        gl_PointSize = (0.13 + 0.07 * blink) * uScale / -mv.z;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float a = smoothstep(0.5, 0.0, d);
        a = a * a;
        gl_FragColor = vec4(uColor * (1.5 + 2.5 * smoothstep(0.2, 0.0, d)) * a * vA, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  const v2 = new THREE.Vector2();
  pts.onBeforeRender = (renderer, _scene, camera) => {
    autoClock();
    renderer.getDrawingBufferSize(v2);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 45;
    uScale.value = v2.y / (2 * Math.tan((fov * Math.PI) / 360));
  };
  fireflyCache.set(key, pts);
  return pts;
}

// ---------------------------------------------------------------------------------------------

type DecorBuilder = (v: number, map: MapDef) => PropModel;
const BUILDERS: Partial<Record<DecorKind, DecorBuilder>> = {
  grass, reeds, lilypad, mushroom, flower, fern, snowtuft, icicle, shell, starfish, seaweed, pebbles, bones, rope, gear, sign, lantern,
  cattail, coralfan, treasure, chainhang, cargonet, rowboat, flag, icicles,
};

/** Kinds whose variant models depend on the map palette. */
const MAP_TINTED = new Set<DecorKind>(['grass', 'reeds', 'pebbles', 'lantern', 'rowboat']);
/** Vertex-lifted kinds move far outside their static bounds: drawn as never-culled InstancedMesh. */
const NO_CULL = new Set<DecorKind>(['lilypad', 'seaweed', 'rowboat']);
/** Man-made kinds that get the night / dusk rim so they read in the dark. */
const RIMMED = new Set<DecorKind>(['sign', 'gear', 'rope', 'bones', 'treasure', 'chainhang', 'cargonet', 'rowboat', 'flag', 'banner', 'lanternstring', 'ropebridge']);
/** Larger kinds that cast shadows from 'high' up (ropebridge from 'medium'). */
const SHADOWED = new Set<DecorKind>(['sign', 'lantern', 'treasure', 'chainhang', 'cargonet', 'rowboat', 'flag', 'banner', 'lanternstring']);
/** Kinds that turn their +z toward the nearest water. */
const FACE_WATER = new Set<DecorKind>(['icicles', 'chainhang']);

export function buildDecorImpl(decor: Decor[], map: MapDef, height: HeightFn, waterYFn: (x: number, z: number) => number, quality?: Quality): THREE.Group {
  const t0 = performance.now();
  const q = propsQuality(quality);
  const lvl = qLevel(q);
  const group = new THREE.Group();
  group.name = 'decor';
  WATER_LEVEL.value = waterYFn(0, 0);
  const mood = moodOf(map.atmosphere);
  const batch = new StaticBatch(mood, false);
  const byKind = new Map<DecorKind, Decor[]>();
  for (const d of decor) {
    let l = byKind.get(d.kind);
    if (!l) byKind.set(d.kind, (l = []));
    l.push(d);
  }
  const gates: LockGateView[] = [];
  for (const [kind, list] of byKind) {
    const shadows = SHADOWED.has(kind) && lvl >= 2;
    const rim = RIMMED.has(kind);
    if (kind === 'firefly_swarm') {
      const p = fireflies(list, height, q, map.id);
      if (p) group.add(p);
      continue;
    }
    if (kind === 'waterfall') {
      for (const d of list) group.add(waterfallLip(d, map));
      continue;
    }
    if (kind === 'lockgate') {
      for (const d of list) {
        const gv = lockGate(d, map);
        gates.push(gv);
        group.add(gv.group);
      }
      continue;
    }
    if (kind === 'mist') {
      const m = mistMesh(list, map, q);
      if (m) group.add(m);
      continue;
    }
    if (kind === 'lanternstring') {
      for (const d of list) {
        const p = lanternString(d, map, height);
        batch.add(p.model, p.m, shadows, rim);
      }
      continue;
    }
    if (kind === 'ropebridge') {
      for (const d of list) for (const p of ropeBridges(d, map, height)) batch.add(p.model, p.m, lvl >= 1, rim);
      continue;
    }
    if (kind === 'banner') {
      for (const d of list) {
        const p = banner(d, map, height);
        batch.add(p.model, p.m, shadows, rim);
      }
      continue;
    }
    const b = BUILDERS[kind];
    const nv = VARIANTS[kind];
    if (!b || !nv) continue;
    // thin out the densest ground cover: half on low, three quarters on medium (Intel UHD budget)
    const dense = kind === 'grass' || kind === 'snowtuft' || kind === 'pebbles' || kind === 'cattail' || kind === 'reeds' || kind === 'fern';
    const skip = (i: number) => dense && ((lvl === 0 && i % 2 === 1) || (lvl === 1 && i % 4 === 3));
    const buckets: THREE.Matrix4[][] = [];
    for (let i = 0; i < nv; i++) buckets.push([]);
    list.forEach((d, i) => {
      if (skip(i)) return;
      const v = Math.abs(d.seed | 0) % nv;
      const y = height(d.x, d.z);
      let yaw = d.rot;
      if (FACE_WATER.has(kind)) {
        const w = towardWater(map, d.x, d.z);
        if (w) yaw = Math.atan2(w[0], w[1]);
      }
      buckets[v].push(trs(d.x, y - 0.02, d.z, yaw, d.scale));
    });
    for (let v = 0; v < nv; v++) {
      if (!buckets[v].length) continue;
      const key = `d|${kind}|${v}|${MAP_TINTED.has(kind) ? map.id : ''}`;
      const model = cachedModel(key, () => b(v, map));
      if (NO_CULL.has(kind)) {
        // vertex-animated sets move outside their static bounds
        for (const im of instanceModel(model, buckets[v], shadows, undefined, rim ? mood : null)) {
          im.frustumCulled = false;
          group.add(im);
        }
        continue;
      }
      for (const m of buckets[v]) batch.add(model, m, shadows, rim);
    }
  }
  batch.build(group, 'decor-batch');
  // per-frame hook: free-running clock, live water level, lock gates follow the water
  let lastTick = performance.now();
  group.add(
    tickMesh(() => {
      autoClock();
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastTick) / 1000);
      lastTick = now;
      WATER_LEVEL.value = waterYFn(0, 0);
      if (gates.length) {
        const by = bedY(map);
        const gy = groundY(map);
        const lvlW = Math.max(0, Math.min(1, (WATER_LEVEL.value - by - 0.3) / (gy - by - 0.6)));
        for (const gv of gates) {
          const target = lvlW > 0.6 ? 1 : 0;
          gv.open += (target - gv.open) * Math.min(1, dt * 1.2);
          for (const leaf of gv.leaves) leaf.rotation.y = -leaf.userData.side * gv.open * 1.2;
        }
      }
    }),
  );
  const ms = performance.now() - t0;
  if (ms > 50) console.info(`[props] buildDecor ${decor.length} items in ${ms.toFixed(0)} ms (${batch.instances} batched)`);
  return group;
}
