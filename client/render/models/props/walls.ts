// Wall segments: wood palisade, dry stone, ice blocks, brick, hedge.
// Local frame: the wall runs along +Z (length = segment length + 2r), thickness 2r along X, height h.
import type { PropKind } from '../../../../shared/maps/types.ts';
import { blob, blotch, CH, fbm3, h3, mix, PGrid, pmat, rngFor, shade, toModel, vn3, type PropModel } from './common.ts';
import { iceMat } from './rocks.ts';

const SINK = 3;

export function buildWall(kind: PropKind, length: number, r: number, h: number, seed: number): PropModel {
  switch (kind) {
    case 'wall_wood':
      return woodWall(length, r, h, seed);
    case 'wall_ice':
      return iceWall(length, r, h, seed);
    case 'wall_brick':
      return brickWall(length, r, h, seed);
    case 'wall_hedge':
      return hedgeWall(length, r, h, seed);
    case 'wall_stone':
    default:
      return stoneWall(length, r, h, seed);
  }
}

function dims(V: number, length: number, r: number, h: number, extraX = 4, extraY = 6) {
  const L = Math.ceil((length + 2 * r) / V);
  const T = Math.max(3, Math.round((2 * r) / V));
  const Hh = Math.round(h / V);
  const nx = T + extraX * 2;
  const nz = L + 4;
  const ny = Hh + SINK + extraY;
  return { L, T, Hh, nx, ny, nz, x0: extraX, z0: 2 };
}

function woodWall(length: number, r: number, h: number, seed: number): PropModel {
  const V = 0.07;
  const rnd = rngFor(seed * 73 + 1);
  const d = dims(V, length, r, h, 3);
  const g = new PGrid(d.nx, d.ny, d.nz);
  const cx = d.nx / 2;
  const logR = d.T * 0.5;
  const step = Math.max(4, Math.round(logR * 2));
  const barkPal = [0x5a4430, 0x664e36, 0x725a3e, 0x4e3a2a];
  const count = Math.floor(d.L / step);
  const off = (d.L - count * step) / 2;
  for (let i = 0; i < count; i++) {
    const zc = d.z0 + off + i * step + step / 2;
    const top = SINK + d.Hh + Math.floor((rnd() - 0.5) * 4);
    const lr = logR * (0.9 + rnd() * 0.15);
    for (let y = 0; y <= top + 3; y++) {
      const tip = y > top ? (y - top) / 3.5 : 0;
      const rr = lr * (1 - tip);
      if (rr < 0.4) continue;
      for (let z = Math.floor(zc - rr - 1); z <= zc + rr + 1; z++)
        for (let x = Math.floor(cx - rr - 1); x <= cx + rr + 1; x++) {
          const dx = x + 0.5 - cx;
          const dz = z + 0.5 - zc;
          if (dx * dx + dz * dz > rr * rr) continue;
          const t = vn3(x * 0.5, y * 0.08, z * 0.5, seed + i) * 0.8 + h3(x, y, z) * 0.2;
          let c = barkPal[Math.min(3, Math.floor(t * 4))];
          if (y > top) c = 0xb08a5a; // carved point
          if (y < SINK + 3 && h3(x, y, z, 7) < 0.5) c = mix(c, 0x4f6a2a, 0.7);
          g.set(x, y, z, c);
        }
    }
  }
  // two horizontal rails each side, lashed with rope
  const railYs = [SINK + Math.round(d.Hh * 0.3), SINK + Math.round(d.Hh * 0.72)];
  for (const ry of railYs)
    for (const side of [-1, 1]) {
      const x = Math.floor(cx + side * (logR + 0.5));
      g.box(x, ry, d.z0 + 1, x, ry + 1, d.z0 + d.L - 2, (xx, yy, zz) => shade(0x7a5a3a, 0.9 + vn3(xx, yy, zz * 0.2, seed) * 0.2));
      for (let i = 0; i < count; i++) {
        const zc = Math.floor(d.z0 + off + i * step + step / 2);
        if (i % 2) continue;
        g.set(x + side, ry, zc, 0xd8b884);
        g.set(x + side, ry + 1, zc, 0xc4a06a);
        g.set(x, ry + 2, zc, 0xd8b884);
        g.set(x, ry - 1, zc, 0xc4a06a);
      }
    }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.9 }) }, { pivot: [cx, SINK, d.z0 + d.L / 2] });
}

function stoneWall(length: number, r: number, h: number, seed: number): PropModel {
  const V = 0.1;
  const d = dims(V, length, r, h, 2);
  const g = new PGrid(d.nx, d.ny, d.nz);
  const cx = d.nx / 2;
  const pal = [0x6a6a60, 0x76766a, 0x828275, 0x5e5f57, 0x8d8b7c];
  const cell = 3.2;
  for (let z = d.z0; z < d.z0 + d.L; z++)
    for (let y = 0; y <= SINK + d.Hh; y++) {
      const t = Math.max(0, (y - SINK) / d.Hh);
      const half = (d.T / 2) * (1.15 - t * 0.3);
      for (let x = 0; x < d.nx; x++) {
        const dx = Math.abs(x + 0.5 - cx);
        if (dx > half) continue;
        // irregular stones: jittered cells, carve the joints
        const fy = (y + (Math.floor(z / cell) % 2) * 1.5) / (cell * 0.8);
        const fz = z / cell;
        const iy = Math.floor(fy);
        const iz = Math.floor(fz);
        const jy = fy - iy;
        const jz = fz - iz;
        const joint = jy < 0.14 || jz < 0.12;
        if (joint && dx > half - 1) continue;
        const c = pal[Math.floor(h3(iy, iz, 0, seed) * pal.length)];
        g.set(x, y, z, joint ? shade(c, 0.6) : shade(c, 0.92 + h3(x, y, z) * 0.14));
      }
    }
  // cap stones and moss on top
  const moss = blotch([0x4c6a28, 0x5a7a2e, 0x668a34], 0.3, seed, 0.3);
  for (let z = d.z0; z < d.z0 + d.L; z++)
    for (let x = 0; x < d.nx; x++) {
      let y = d.ny - 1;
      while (y > 0 && !g.solid(x, y, z)) y--;
      if (y < SINK + d.Hh - 2) continue;
      if (fbm3(x * 0.3, 0, z * 0.2, seed + 1) > 0.48) g.set(x, y + 1, z, moss(x, y, z));
    }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.94 }) }, { pivot: [cx, SINK, d.z0 + d.L / 2] });
}

function iceWall(length: number, r: number, h: number, seed: number): PropModel {
  const V = 0.1;
  const rnd = rngFor(seed * 79 + 5);
  const d = dims(V, length, r, h, 2, 8);
  const g = new PGrid(d.nx, d.ny, d.nz);
  const cx = d.nx / 2;
  const tints = [0xcdeefc, 0xb5e2f8, 0xa2d6f4, 0xd9f4ff, 0xbfe8fa];
  const bw = 6;
  const bh = 4;
  g.on(CH.ice, () => {
    for (let y = 0; y <= SINK + d.Hh; y++) {
      const row = Math.floor(y / bh);
      const shift = (row % 2) * 3;
      for (let z = d.z0; z < d.z0 + d.L; z++) {
        const col = Math.floor((z + shift) / bw);
        const seam = (z + shift) % bw === 0 || y % bh === 0;
        const bump = h3(row, col, 1, seed) < 0.3 ? 1 : 0;
        const half = d.T / 2 + bump * 0.5;
        const c = tints[Math.floor(h3(row, col, 0, seed) * tints.length)];
        for (let x = 0; x < d.nx; x++) {
          const dx = Math.abs(x + 0.5 - cx);
          if (dx > half) continue;
          if (seam && dx > half - 1) continue;
          g.set(x, y, z, seam ? mix(c, 0x6aa8d8, 0.5) : shade(c, 0.95 + h3(x, y, z) * 0.08));
        }
      }
    }
  });
  // snow drift along the top
  const snow = (x: number, y: number, z: number) => (h3(x, y, z) < 0.3 ? 0xe4eef9 : 0xf6fbff);
  for (let z = d.z0; z < d.z0 + d.L; z++) {
    const depth = 1 + Math.floor(vn3(0, 0, z * 0.15, seed) * 3);
    for (let x = 0; x < d.nx; x++) {
      if (Math.abs(x + 0.5 - cx) > d.T / 2 + 0.5) continue;
      for (let k = 1; k <= depth; k++) {
        if (Math.abs(x + 0.5 - cx) > d.T / 2 - k + 1.5) continue;
        g.set(x, SINK + d.Hh + k, z, snow(x, k, z));
      }
    }
  }
  // icicles hanging off both faces
  g.on(CH.ice, () => {
    for (let k = 0; k < Math.floor(d.L / 3); k++) {
      const z = Math.floor(d.z0 + rnd() * d.L);
      const side = rnd() < 0.5 ? -1 : 1;
      const x = Math.floor(cx + side * (d.T / 2 + 0.5));
      const len = 2 + Math.floor(rnd() * 4);
      for (let j = 0; j < len; j++) g.set(x, SINK + d.Hh - j, z, j === len - 1 ? 0xeaf8ff : 0xc8ecff);
    }
  });
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.8 }), [CH.ice]: iceMat() }, { pivot: [cx, SINK, d.z0 + d.L / 2] });
}

function brickWall(length: number, r: number, h: number, seed: number): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 83 + 3);
  const d = dims(V, length, r, h, 3, 6);
  const g = new PGrid(d.nx, d.ny, d.nz);
  const cx = d.nx / 2;
  const bricks = [0x9a4430, 0xa84e36, 0xb45840, 0x8a3c2c, 0xbc6448, 0x7e3626];
  const mortar = 0x8f8778;
  const half = d.T / 2;
  const capY = SINK + d.Hh;
  // stone footing
  g.box(Math.floor(cx - half - 1), 0, d.z0, Math.ceil(cx + half), SINK + 1, d.z0 + d.L - 1, (x, y, z) => (h3(x, y, z) < 0.4 ? 0x6a6660 : 0x7a766e));
  for (let y = SINK + 2; y < capY; y++) {
    const row = Math.floor((y - SINK - 2) / 2);
    const shift = (row % 2) * 2;
    const courseBottom = (y - SINK - 2) % 2 === 0;
    for (let z = d.z0; z < d.z0 + d.L; z++) {
      const col = Math.floor((z + shift) / 4);
      const vjoint = (z + shift) % 4 === 0;
      const c = shade(bricks[Math.floor(h3(row, col, 0, seed) * bricks.length)], 0.94 + h3(row, col, 2) * 0.12);
      for (let x = 0; x < d.nx; x++) {
        const dx = Math.abs(x + 0.5 - cx);
        if (dx > half) continue;
        const surface = dx > half - 1;
        if (surface && vjoint) continue; // recessed vertical joint
        let cc = surface && courseBottom ? shade(c, 0.9) : c;
        if (surface && vjoint) cc = mortar;
        // soot and moss near the bottom
        if (y < SINK + 5 && fbm3(x * 0.4, y * 0.4, z * 0.15, seed) > 0.55) cc = mix(cc, 0x4a5a2a, 0.6);
        if (fbm3(x * 0.2, y * 0.2, z * 0.1, seed + 9) > 0.7) cc = shade(cc, 0.75);
        g.set(x, y, z, cc);
      }
      // mortar fill behind recessed joints
      if (vjoint)
        for (const side of [-1, 1]) {
          const x = Math.floor(cx + side * (half - 1.5));
          g.set(x, y, z, mortar);
        }
    }
  }
  // stone coping cap
  g.box(Math.floor(cx - half - 1), capY, d.z0, Math.ceil(cx + half), capY + 1, d.z0 + d.L - 1, (x, y, z) => (h3(x, y, z) < 0.3 ? 0x9a968c : 0xaaa69a));
  g.box(Math.floor(cx - half), capY + 2, d.z0, Math.ceil(cx + half) - 1, capY + 2, d.z0 + d.L - 1, 0x8e8a80);
  // drainpipe on one face
  const dz = Math.floor(d.z0 + d.L * (0.2 + rnd() * 0.6));
  const dside = rnd() < 0.5 ? -1 : 1;
  const dx = Math.floor(cx + dside * (half + 1));
  g.on(CH.metal, () => {
    g.box(dx, 0, dz, dx, capY + 1, dz, 0x3a4048);
    g.box(dx - (dside > 0 ? 1 : 0), capY + 1, dz - 1, dx + (dside > 0 ? 0 : 1), capY + 1, dz + 1, 0x3a4048);
    for (let y = SINK + 3; y < capY; y += 6) g.set(dx, y, dz + 1, 0x5a626c);
  });
  // a faded fish poster on the other face
  const pz = Math.floor(d.z0 + d.L * 0.5 + (dz < d.z0 + d.L / 2 ? 6 : -6));
  const px = Math.floor(cx - dside * (half + 0.5)) + (dside > 0 ? -0 : 0);
  const fish = ['.......', '.##..#.', '#####..', '.##..#.', '.......', '.#.#.#.'];
  for (let row = 0; row < 7; row++)
    for (let col = 0; col < 7; col++) {
      const y = SINK + Math.round(d.Hh * 0.62) - row;
      const z = pz - 3 + col;
      const ch = row < 6 ? fish[row][col] : '.';
      g.set(px, y, z, ch === '#' ? 0x3a6a8a : 0xe8dcc0);
    }
  // ivy strands
  g.on(CH.leaf, () => {
    for (let k = 0; k < Math.floor(d.L / 8); k++) {
      const z = Math.floor(d.z0 + rnd() * d.L);
      const side = rnd() < 0.5 ? -1 : 1;
      const x = Math.floor(cx + side * (half + 0.5));
      const len = 4 + Math.floor(rnd() * 10);
      for (let j = 0; j < len; j++) {
        const zz = z + Math.round(Math.sin(j * 0.7 + k) * 1.2);
        g.set(x, capY - j, zz, j % 3 ? 0x3f6a2a : 0x4f7a32);
      }
    }
  });
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.88 }), [CH.metal]: pmat({ metal: 0.6, rough: 0.4 }), [CH.leaf]: pmat({ rough: 0.9, sway: 0.02, swayH: 2 }) }, { pivot: [cx, SINK, d.z0 + d.L / 2] });
}

function hedgeWall(length: number, r: number, h: number, seed: number): PropModel {
  const V = 0.1;
  const rnd = rngFor(seed * 89 + 7);
  const d = dims(V, length, r, h, 3, 6);
  const g = new PGrid(d.nx, d.ny, d.nz);
  const cx = d.nx / 2;
  const leaf = blotch([0x2f5a22, 0x3a6a28, 0x467a2e, 0x528a34, 0x2a4e1e], 0.25, seed, 0.3);
  // trunk/roots strip
  g.box(Math.floor(cx - 1), 0, d.z0 + 2, Math.ceil(cx), SINK + 2, d.z0 + d.L - 3, 0x4a3a26);
  for (let z = d.z0; z < d.z0 + d.L; z++)
    for (let y = SINK; y <= SINK + d.Hh; y++)
      for (let x = 0; x < d.nx; x++) {
        const dx = Math.abs(x + 0.5 - cx) / (d.T / 2 + 0.8);
        const dyTop = (y - (SINK + d.Hh - 3)) / 3;
        const ez = Math.min(z - d.z0, d.z0 + d.L - 1 - z) / 3;
        const n = (fbm3(x * 0.4, y * 0.4, z * 0.4, seed) - 0.5) * 0.5;
        const k = dx * dx + Math.max(0, dyTop) * Math.max(0, dyTop) + (ez < 1 ? (1 - ez) * (1 - ez) : 0);
        if (k <= 1 + n) g.set(x, y, z, leaf(x, y, z));
      }
  // sunlit top
  g.recolor((c, x, y, z) => (y > SINK + d.Hh - 3 && h3(x, y, z) < 0.5 ? mix(c, 0x8ab84a, 0.3) : c));
  // little flowers
  for (let k = 0; k < Math.floor(d.L / 4); k++) {
    const z = Math.floor(d.z0 + rnd() * d.L);
    const x = Math.floor(rnd() * d.nx);
    let y = d.ny - 1;
    while (y > 0 && !g.solid(x, y, z)) y--;
    if (y < SINK) continue;
    g.set(x, y + 1, z, k % 3 === 0 ? 0xffffff : k % 3 === 1 ? 0xff9ac8 : 0xffe060);
  }
  blob(g, cx, SINK, d.z0 + 2, 2, 2, 2, 0.2, seed, leaf);
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.92 }) }, { pivot: [cx, SINK, d.z0 + d.L / 2] });
}

