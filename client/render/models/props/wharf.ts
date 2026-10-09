// Lantern Wharf props: the dockside timber crane with its hanging load, brick warehouse frontages with
// lit windows, gas street lamps and the stone pier columns that stand on the bridges.
// Origins at ground contact (deck top for bridge piers). Fronts (+Z) face the canal.
import { waterY } from '../../contracts.ts';
import type { PropCtx } from './buildProps.ts';
import { blotch, CH, h3, lampAt, mix, PGrid, pmat, rngFor, seg, shade, taper, toModel, vn3, type CFn, type PropModel } from './common.ts';
import { hangLantern, LampSet } from './dressing.ts';
import { blocks, grain, ironCol, lanternCage, mats, post, ropeDark, WOOD } from './kit.ts';
import { bedY } from '../../contracts.ts';

const SINK = 3;

function halo2(c: [number, number, number], pivot: [number, number, number], V: number, size = 2.4, warm = 0xffa040): NonNullable<PropModel['halos']> {
  const pos: [number, number, number] = [(c[0] - pivot[0]) * V, (c[1] - pivot[1]) * V, (c[2] - pivot[2]) * V];
  return [
    { pos, color: warm, size, opacity: 0.44 },
    { pos, color: 0xfff0c8, size: size * 0.32, opacity: 0.78 },
  ];
}

/** Iron chain: alternating link orientation along a straight run. */
function chain(g: PGrid, a: [number, number, number], b: [number, number, number], col = 0x30343a): void {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  g.on(CH.metal, () => {
    for (let i = 0; i <= n; i++) {
      const t = i / Math.max(1, n);
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      g.set(x, y, z, i % 3 === 0 ? 0x4a4e56 : col);
      if (i % 3 === 1) g.set(x + 1, y, z, col);
      if (i % 3 === 2) g.set(x, y, z + 1, col);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Crane: stone plinth, braced timber tower, operator cabin, a jib over the canal, chain, hook, load
// ---------------------------------------------------------------------------------------------

export function buildCrane(r: number, seed: number, ctx: PropCtx): PropModel {
  const V = 0.08;
  const rv = r / V;
  const half = Math.round(rv * 0.66);
  const jibLen = Math.round(4.0 / V);
  const NZ = half + jibLen + 18;
  const zc = half + 8; // tower centre z in the grid
  const NX = half * 2 + 20;
  const NY = Math.round(5.6 / V) + SINK;
  const g = new PGrid(NX, NY, NZ);
  const cx = Math.floor(NX / 2);
  const pal = WOOD[ctx.theme];
  const timber = grain(pal, seed, 1);
  const dark = grain(pal.map((c) => shade(c, 0.7)), seed + 1, 1);
  const stone = blocks([0x5e5a56, 0x6a6560, 0x55514e, 0x726c66], 5, 3, seed);
  const iron = ironCol(seed, 0.22);
  // plinth
  const ph = Math.round(0.45 / V);
  g.box(cx - half - 1, 0, zc - half - 1, cx + half + 1, SINK + ph, zc + half + 1, stone);
  g.box(cx - half - 2, SINK + ph + 1, zc - half - 2, cx + half + 2, SINK + ph + 1, zc + half + 2, 0x7a746c);
  const base = SINK + ph + 2;
  // tower: corner posts and X bracing up to the cabin
  const towerTop = SINK + Math.round(2.4 / V);
  const th = half - 1;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.box(cx + sx * th - (sx < 0 ? 0 : 1), base, zc + sz * th - (sz < 0 ? 0 : 1), cx + sx * th + (sx < 0 ? 1 : 0), towerTop, zc + sz * th + (sz < 0 ? 1 : 0), dark);
  for (const [ya, yb] of [[base + 1, Math.round((base + towerTop) / 2)], [Math.round((base + towerTop) / 2), towerTop]])
    for (const s of [-1, 1]) {
      seg(g, cx - th, ya, zc + s * th, cx + th, yb, zc + s * th, timber, 0.7);
      seg(g, cx + th, ya, zc + s * th, cx - th, yb, zc + s * th, timber, 0.7);
      seg(g, cx + s * th, ya, zc - th, cx + s * th, yb, zc + th, timber, 0.7);
      seg(g, cx + s * th, ya, zc + th, cx + s * th, yb, zc - th, timber, 0.7);
      g.box(cx - th, yb, zc + s * th, cx + th, yb, zc + s * th, dark);
      g.box(cx + s * th, yb, zc - th, cx + s * th, yb, zc + th, dark);
    }
  // cabin with a lit window and a pitched roof
  const cy0 = towerTop + 1;
  const cy1 = cy0 + Math.round(0.95 / V);
  const ch = half;
  for (let y = cy0; y <= cy1; y++)
    for (let k = -ch; k <= ch; k++)
      for (const [x, z] of [[cx + k, zc - ch], [cx + k, zc + ch], [cx - ch, zc + k], [cx + ch, zc + k]]) {
        const win = y > cy0 + 3 && y < cy1 - 2 && Math.abs(k) < ch - 2 && Math.abs(k) % 4 !== 0;
        if (win) g.on(CH.glow, () => g.set(x, y, z, h3(x, y, z) < 0.3 ? 0xffb050 : 0xffd080));
        else g.set(x, y, z, Math.abs(k) === ch ? shade(pal[0], 0.6) : (x + z) % 3 === 0 ? shade(timber(x, y, z), 0.75) : timber(x, y, z));
      }
  g.box(cx - ch + 1, cy0, zc - ch + 1, cx + ch - 1, cy0, zc + ch - 1, 0x2a2018);
  const slate = blotch([0x3a3e46, 0x444852, 0x30343a], 0.3, seed + 3, 0.2);
  for (let k = 0; k <= ch + 2; k++)
    for (let z = zc - ch - 2; z <= zc + ch + 2; z++) {
      g.set(cx - ch - 2 + k, cy1 + 1 + k, z, (z + k) % 3 === 0 ? shade(slate(z, k, 0), 0.75) : slate(cx + k, k, z));
      g.set(cx + ch + 2 - k, cy1 + 1 + k, z, (z + k) % 3 === 0 ? shade(slate(z, k, 1), 0.75) : slate(cx - k, k, z));
    }
  // counterweight box at the back
  g.on(CH.metal, () => g.box(cx - 3, cy0 - 2, zc - ch - 5, cx + 3, cy0 + 4, zc - ch - 1, iron));
  // big gear wheel on the side
  g.on(CH.metal, () => {
    const gy = Math.round((base + towerTop) / 2) + 2;
    const gz = zc;
    const gx = cx + half + 1;
    for (let a = 0; a < 1; a += 0.01) {
      const an = a * Math.PI * 2;
      const R = Math.cos(an * 12) > 0.2 ? 6 : 5;
      for (let rr = 4; rr <= R; rr++) g.set(gx, gy + Math.sin(an) * rr, gz + Math.cos(an) * rr, 0x4a4036);
      if (Math.abs(Math.sin(an * 3)) < 0.12) for (let rr = 1; rr < 4; rr++) g.set(gx, gy + Math.sin(an) * rr, gz + Math.cos(an) * rr, 0x3a342c);
    }
    g.box(gx, gy - 1, gz - 1, gx + 1, gy + 1, gz + 1, 0x8a7a40);
  });
  // jib: two timbers with a lattice, rising toward +z over the canal
  const jy0 = cy0 + 3;
  const jz0 = zc + ch;
  const ang = 0.5;
  const jy1 = jy0 + Math.round(Math.sin(ang) * jibLen);
  const jz1 = jz0 + Math.round(Math.cos(ang) * jibLen);
  for (const sx of [-2, 2]) seg(g, cx + sx, jy0, jz0, cx + sx * 0.5, jy1, jz1, dark, 1.0);
  for (let k = 0; k < 8; k++) {
    const t0 = k / 8;
    const t1 = (k + 1) / 8;
    const p = (t: number, s: number): [number, number, number] => [cx + s * (2 - 1.5 * t), jy0 + (jy1 - jy0) * t, jz0 + (jz1 - jz0) * t];
    const a = p(t0, k % 2 ? -1 : 1);
    const b = p(t1, k % 2 ? 1 : -1);
    seg(g, a[0], a[1], a[2], b[0], b[1], b[2], timber, 0.5);
  }
  // back stay from the cabin roof to the jib tip
  seg(g, cx, cy1 + ch + 3, zc, cx, jy1 + 1, jz1, ropeDark, 0.5);
  // pulley at the tip
  g.on(CH.metal, () => {
    for (let a = 0; a < 1; a += 0.05) g.set(cx, jy1 + Math.sin(a * Math.PI * 2) * 2, jz1 + Math.cos(a * Math.PI * 2) * 2, 0x3a3a3e);
  });
  // chain, hook and a netted load, all above 2.2 m
  const loadTop = SINK + Math.round(2.95 / V);
  chain(g, [cx, jy1 - 2, jz1], [cx, loadTop + 7, jz1]);
  g.on(CH.metal, () => {
    // hook
    g.box(cx - 1, loadTop + 5, jz1, cx + 1, loadTop + 6, jz1, 0x50565e);
    for (let a = 0; a < 1; a += 0.06) g.set(cx + Math.cos(a * Math.PI) * 2, loadTop + 4 - Math.sin(a * Math.PI) * 2, jz1, 0x50565e);
  });
  const lh = Math.round(0.62 / V);
  const lw = Math.round(0.36 / V);
  const loadBot = loadTop - lh;
  const plank = grain([0x8e6236, 0x9c6e3e, 0xa87a48, 0x7a5430], seed + 7, 0);
  g.box(cx - lw, loadBot, jz1 - lw, cx + lw, loadTop, jz1 + lw, (x, y, z) => ((y - loadBot) % 3 === 2 ? shade(plank(x, y, z), 0.62) : plank(x, y, z)));
  for (const sx of [-lw, lw]) for (const sz of [-lw, lw]) seg(g, cx + sx, loadTop, jz1 + sz, cx, loadTop + 4, jz1, ropeDark);
  // rope net over the load
  g.recolor((c, x, y, z) => (y >= loadBot && y <= loadTop && Math.abs(z - jz1) <= lw && Math.abs(x - cx) <= lw && ((x + y) % 4 === 0 || (z + y) % 4 === 0) && (Math.abs(x - cx) === lw || Math.abs(z - jz1) === lw || y === loadTop) ? 0x9c8a64 : c));
  // a lantern on the cabin corner
  g.on(CH.metal, () => g.box(cx + ch + 1, cy1 - 1, zc + ch + 1, cx + ch + 2, cy1 - 1, zc + ch + 1, 0x2a2a2e));
  const lc = lanternCage(g, cx + ch + 2, cy1 - 7, zc + ch + 1, 1, 4, 0xffc070);
  const pivot: [number, number, number] = [cx + 0.5, SINK, zc + 0.5];
  const dressed = new LampSet(pivot, V);
  if (ctx.dress) {
    // Epic: a lantern hanging from the jib out over the water, like the reference cranes and gantries
    const t = 0.42;
    dressed.add(hangLantern(g, cx, Math.floor(jy0 + (jy1 - jy0) * t) - 1, Math.round(jz0 + (jz1 - jz0) * t), 7, 2, 5), 'crane', 2.2);
  }
  return {
    ...toModel(g, V, { [CH.base]: mats.wood(ctx.theme), [CH.metal]: mats.rust(), [CH.glow]: mats.lamp() }, { pivot }),
    halos: [...halo2(lc, pivot, V, 2.0), { pos: [0, (cy0 + 6 - SINK) * V, (ch + 1) * V], color: 0xffa850, size: 1.8, opacity: 0.25 }, ...dressed.halos],
    lamps: [lampAt(lc, pivot, V, 'crane'), ...dressed.lamps],
  };
}

// ---------------------------------------------------------------------------------------------
// Warehouse: a brick frontage (wall frame) with lit arched windows, a loading door and a slate roof
// ---------------------------------------------------------------------------------------------

export function buildWarehouse(length: number, r: number, h: number, seed: number, ctx: PropCtx): PropModel {
  void ctx;
  const V = 0.1;
  const L = Math.ceil((length + 2 * r) / V);
  const T = Math.max(6, Math.round((2 * r) / V));
  const H = Math.round(h / V);
  const roofH = Math.round(T * 0.75) + 2;
  const nx = T + 10;
  const nz = L + 4;
  const g = new PGrid(nx, SINK + H + roofH + 8, nz);
  const x0 = Math.floor((nx - T) / 2);
  const x1 = x0 + T - 1;
  const z0 = 2;
  const z1 = z0 + L - 1;
  const cxm = (x0 + x1 + 1) / 2;
  const brickPal = [0x7a3a2a, 0x8a4430, 0x6e3424, 0x94503a, 0x7e4232];
  const brick = blocks(brickPal, 4, 2, seed, 0.62);
  const stone = blocks([0x8a847a, 0x7a746c, 0x948e84], 6, 3, seed + 1);
  const plinthTop = SINK + 4;
  const floor2 = SINK + Math.round(H * 0.52);
  // shell: brick walls, stone plinth, string course, quoins
  for (let z = z0; z <= z1; z++)
    for (let y = 0; y < SINK + H; y++)
      for (let x = x0; x <= x1; x++) {
        const shell = x === x0 || x === x1 || z === z0 || z === z1;
        if (!shell && y > plinthTop) continue;
        let c = y <= plinthTop ? stone(x, y, z) : brick(x, y, z);
        if (y === floor2 || y === SINK + H - 1) c = stone(x, y, z);
        if ((z - z0 < 2 || z1 - z < 2) && (x === x0 || x === x1) && Math.floor(y / 3) % 2 === 0 && y > plinthTop) c = stone(x, y, z);
        // soot and rain streaks
        if (vn3(x * 0.6, y * 0.05, z * 0.6, seed + 4) > 0.7) c = shade(c, 0.78);
        g.set(x, y, z, c);
      }
  // windows: arched, lit or dark, on both long faces; a loading door on the +x face
  const halos: NonNullable<PropModel['halos']> = [];
  const doorZ = Math.round((z0 + z1) / 2);
  const bays = Math.max(2, Math.floor((L - 6) / 11));
  for (const side of [-1, 1]) {
    const fx = side < 0 ? x0 : x1;
    for (let b = 0; b < bays; b++) {
      const wz = Math.round(z0 + 5 + ((b + 0.5) * (L - 10)) / bays);
      for (const [wy0, wh] of [[plinthTop + 3, Math.round(H * 0.28)], [floor2 + 3, Math.round(H * 0.24)]] as const) {
        if (side > 0 && Math.abs(wz - doorZ) < 6 && wy0 < floor2) continue;
        // Epic: nearly every window lit, as the reference quays are
        const lit = h3(b, wy0, side, seed) < (ctx.dress ? 0.9 : 0.62);
        for (let y = wy0; y <= wy0 + wh; y++)
          for (let k = -2; k <= 2; k++) {
            const arch = y > wy0 + wh - 2 && Math.abs(k) === 2;
            if (arch) continue;
            const mull = k === 0 || y === wy0 + Math.round(wh / 2);
            const z = wz + k;
            if (mull) g.set(fx, y, z, 0x2a2420);
            else if (lit) g.on(CH.glow, () => g.set(fx, y, z, h3(fx, y, z) < 0.3 ? 0xffb050 : 0xffd088));
            else g.set(fx, y, z, 0x1c2026);
          }
        // stone sill and arch voussoirs
        g.box(fx + side, wy0 - 1, wz - 3, fx + side, wy0 - 1, wz + 3, 0x9a948a);
        for (let k = -3; k <= 3; k++) g.set(fx, wy0 + wh + 1 - (Math.abs(k) === 3 ? 1 : 0), wz + k, 0x9a948a);
        if (lit) halos.push({ pos: [(fx + side * 1.5 - cxm) * V, (wy0 + wh / 2 - SINK) * V, (wz + 0.5 - (z0 + L / 2)) * V], color: 0xffa850, size: 1.3, opacity: 0.28 });
      }
    }
  }
  // loading door with a hoist beam above
  const dw = 4;
  g.box(x1, plinthTop - 3, doorZ - dw, x1, plinthTop + Math.round(H * 0.36), doorZ + dw, (x, y, z) => (Math.abs(z - doorZ) === dw ? 0x3a2a1c : (z + 400) % 2 ? 0x5a4028 : 0x6a4c30));
  g.on(CH.metal, () => {
    for (const y of [plinthTop, plinthTop + Math.round(H * 0.3)]) g.box(x1 + 1, y, doorZ - dw + 1, x1 + 1, y, doorZ + dw - 1, ironCol(seed, 0.3));
  });
  g.box(x1 + 1, SINK + H - 3, doorZ, x1 + 4, SINK + H - 2, doorZ, grain(WOOD.wharf, seed, 0));
  seg(g, x1 + 4, SINK + H - 4, doorZ, x1 + 4, floor2 + 2, doorZ, ropeDark);
  // gable roof: slates, ridge along z, gables on the ends
  const slate = blotch([0x343a44, 0x3e444e, 0x2c3038, 0x484e58], 0.25, seed + 6, 0.2);
  const ry0 = SINK + H;
  for (let k = 0; k < roofH; k++) {
    const xa = x0 - 1 + k;
    const xb = x1 + 1 - k;
    if (xa > xb) break;
    for (let z = z0 - 1; z <= z1 + 1; z++) {
      const c = (z + k * 2) % 4 === 0 ? shade(slate(z, k, 0), 0.7) : slate(xa, k, z);
      g.set(xa, ry0 + k, z, c);
      g.set(xb, ry0 + k, z, c);
      if (xb - xa <= 1) for (let x = xa; x <= xb; x++) g.set(x, ry0 + k, z, 0x585e68);
    }
    for (const z of [z0, z1]) for (let x = xa + 1; x < xb; x++) g.set(x, ry0 + k, z, brick(x, ry0 + k, z));
  }
  // round gable window on the south (+z) end, lit
  g.on(CH.glow, () => {
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) if (x * x + y * y <= 4) g.set(Math.floor(cxm) + x, ry0 + 3 + y, z1, x === 0 || y === 0 ? 0xffc070 : 0xffd898);
  });
  // chimney with soot
  const chz = z0 + Math.round(L * 0.25);
  g.box(x0 + 1, ry0, chz, x0 + 3, ry0 + roofH + 3, chz + 2, brick);
  g.box(x0 + 1, ry0 + roofH + 4, chz, x0 + 3, ry0 + roofH + 4, chz + 2, 0x1e1e1e);
  // gutter and down pipe
  g.on(CH.metal, () => {
    for (const x of [x0 - 1, x1 + 1]) g.box(x, ry0 - 1, z0, x, ry0 - 1, z1, 0x2e3238);
    g.box(x1 + 1, SINK, z1 - 1, x1 + 1, ry0 - 1, z1 - 1, 0x2e3238);
  });
  const pivotW: [number, number, number] = [cxm, SINK, z0 + L / 2];
  const dressed = new LampSet(pivotW, V);
  if (ctx.dress) {
    // Epic: wall lanterns on iron brackets between the window bays of the canal-facing (+x) front
    for (let b = 0; b + 1 < bays; b++) {
      const lz = Math.round(z0 + 5 + ((b + 1) * (L - 10)) / bays);
      if (Math.abs(lz - doorZ) < dw + 2) continue;
      const by = floor2 + 1;
      g.on(CH.metal, () => g.box(x1 + 1, by, lz, x1 + 4, by, lz, ironCol(seed, 0.2)));
      dressed.add(hangLantern(g, x1 + 4, by - 1, lz, 1, 2, 4), 'lantern', 1.7, 0xffa040, [0.45, 0.1, 0]);
    }
  }
  return {
    ...toModel(g, V, { [CH.base]: pmat({ rough: 0.62 }), [CH.glow]: mats.window(), [CH.metal]: mats.iron() }, { pivot: pivotW }),
    halos: [...halos, ...dressed.halos],
    lamps: dressed.lamps,
  };
}

// ---------------------------------------------------------------------------------------------
// Gas lamp: cast plinth, fluted post, scroll bracket and a glazed lantern reaching over the canal
// ---------------------------------------------------------------------------------------------

export function buildGasLamp(r: number, seed: number, ctx: PropCtx): PropModel {
  void ctx;
  const V = 0.05;
  const rv = r / V;
  const H = Math.round(2.55 / V);
  const reach = Math.round(0.45 / V);
  const n = Math.ceil(rv * 2 + 10);
  const g = new PGrid(n, SINK + H + 12, n + reach + 6);
  const cx = Math.floor(n / 2);
  const cz = Math.floor(n / 2);
  const iron: CFn = (x, y, z) => (h3(x, y, z, seed) < 0.15 ? 0x3a414a : 0x20262c);
  const green: CFn = (x, y, z) => (h3(x, y, z, seed + 1) < 0.2 ? 0x2e4a40 : 0x243c34);
  const brass = 0xa8904a;
  g.on(CH.metal, () => {
    // stepped plinth
    for (let y = 0; y <= SINK + 11; y++) {
      const rr = y <= SINK + 2 ? rv * 0.95 : y <= SINK + 9 ? rv * 0.8 : rv * 0.62;
      for (let z = Math.floor(cz - rr - 1); z <= cz + rr + 1; z++)
        for (let x = Math.floor(cx - rr - 1); x <= cx + rr + 1; x++) {
          const ax = Math.abs(x + 0.5 - cx - 0.5);
          const az = Math.abs(z + 0.5 - cz - 0.5);
          if (Math.max(ax, az) <= rr && ax + az <= rr * 1.4) g.set(x, y, z, y === SINK + 2 || y === SINK + 9 ? brass : green(x, y, z));
        }
    }
    // fluted post
    for (let y = SINK + 12; y <= SINK + H; y++) {
      const rr = y < SINK + 22 ? 3.3 : 2.5;
      for (let z = cz - 3; z <= cz + 4; z++)
        for (let x = cx - 3; x <= cx + 4; x++) {
          const dx = x + 0.5 - cx - 0.5;
          const dz = z + 0.5 - cz - 0.5;
          if (dx * dx + dz * dz <= rr * rr) g.set(x, y, z, (x + z) % 2 ? iron(x, y, z) : green(x, y, z));
        }
    }
    for (const yy of [SINK + 22, SINK + H - 12, SINK + H]) taper(g, cx + 0.5, cz + 0.5, 3.6, 3.6, yy, yy, brass);
    // ladder rest bar
    g.box(cx - 5, SINK + H - 8, cz, cx + 6, SINK + H - 8, cz, iron);
    // scroll bracket toward +z
    const by = SINK + H - 2;
    for (let k = 0; k <= reach; k++) g.set(cx, by + Math.round(Math.sin((k / reach) * Math.PI) * 2), cz + 1 + k, iron(cx, by, k));
    for (let a = 0; a < 1; a += 0.04) g.set(cx, by - 3 + Math.sin(a * Math.PI * 2) * 2, cz + 4 + Math.cos(a * Math.PI * 2) * 2, iron(0, 0, 0));
    g.box(cx, by - 4, cz + reach + 1, cx + 1, by, cz + reach + 1, iron);
  });
  // lantern hanging from the bracket tip
  const lz = cz + reach + 1;
  const ly = SINK + H - 13;
  g.on(CH.metal, () => {
    for (let k = 0; k < 4; k++) g.box(cx - 3 + k, ly + 9 + k, lz - 3 + k, cx + 4 - k, ly + 9 + k, lz + 4 - k, k === 0 ? brass : iron);
    g.set(cx, ly + 13, lz, brass);
    g.box(cx - 2, ly - 1, lz - 2, cx + 3, ly - 1, lz + 3, iron);
    g.set(cx, ly - 2, lz, brass);
    for (const sx of [-2, 3]) for (const sz of [-2, 3]) g.box(cx + sx, ly, lz + sz, cx + sx, ly + 8, lz + sz, iron);
  });
  g.on(CH.glow, () => g.box(cx - 1, ly, lz - 1, cx + 2, ly + 8, lz + 2, (x, y, z) => (y > ly + 1 && y < ly + 7 && x > cx - 1 && x < cx + 2 && z > lz - 1 && z < lz + 2 ? 0xfff0c0 : h3(x, y, z) < 0.3 ? 0xffc870 : 0xffe0a0)));
  const pivot: [number, number, number] = [cx + 1, SINK, cz + 1];
  return {
    ...toModel(g, V, { [CH.metal]: mats.iron(), [CH.glow]: mats.lamp() }, { pivot }),
    halos: halo2([cx + 1, ly + 4.5, lz + 1], pivot, V, 2.6, 0xffa850),
    lamps: [lampAt([cx + 1, ly + 4.5, lz + 1], pivot, V, 'gaslamp')],
  };
}

// ---------------------------------------------------------------------------------------------
// Bridge pier: a stone column from the canal bed up through the deck, a pillar with a lamp above it
// ---------------------------------------------------------------------------------------------

export function buildBridgePier(r: number, seed: number, ctx: PropCtx): PropModel {
  const V = 0.08;
  const rv = r / V;
  const below = Math.round(Math.min(ctx.below, 4.5) / V);
  const P = below + 1; // pivot (deck top) in voxels
  const H = Math.round(2.35 / V);
  const n = Math.ceil(rv * 2 + 16);
  const g = new PGrid(n, P + H + 12, n);
  const cx = n / 2;
  const cz = n / 2;
  const stone = blocks([0x6a6560, 0x5e5a56, 0x726c66, 0x625c58], 5, 3, seed);
  const light = blocks([0x8a847a, 0x948e84, 0x7e786e], 4, 3, seed + 1);
  const originY = bedY(ctx.map) + ctx.below;
  const wy = Math.round(P + (waterY(ctx.map, 1) - originY) / V);
  const oct = (R: number, y: number, col: CFn) => {
    for (let z = Math.floor(cz - R - 1); z <= cz + R + 1; z++)
      for (let x = Math.floor(cx - R - 1); x <= cx + R + 1; x++) {
        const ax = Math.abs(x + 0.5 - cx);
        const az = Math.abs(z + 0.5 - cz);
        if (Math.max(ax, az) <= R && ax + az <= R * 1.38) g.set(x, y, z, col(x, y, z));
      }
  };
  // footing with cutwaters (pointed along the canal, z), then the column under the deck
  for (let y = 0; y < P; y++) {
    const foot = y < 6;
    const R = foot ? rv * 1.15 : rv * 0.95;
    oct(R, y, (x, yy, z) => {
      let c = stone(x, yy, z);
      if (yy < wy + 1) c = h3(x, yy, z, 3) < 0.25 ? mix(c, 0x2e4a30, 0.6) : mix(c, 0x26302c, 0.45);
      return c;
    });
    if (y < wy + 2)
      for (const s of [-1, 1])
        for (let k = 1; k <= 5; k++) {
          const hw = R * (1 - k / 6);
          for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw); x++) if (Math.abs(x + 0.5 - cx) <= hw) g.set(x, y, cz + s * (R + k - 0.5), mix(stone(x, y, k), 0x26302c, 0.4));
        }
  }
  // the pillar above the deck: plinth, shaft, cornice, lamp
  for (let y = P; y < P + H; y++) {
    const t = (y - P) / H;
    const R = t < 0.12 ? rv * 1.0 : t > 0.82 && t < 0.9 ? rv * 0.98 : rv * 0.82;
    oct(R, y, t < 0.12 || (t > 0.82 && t < 0.9) ? light : stone);
  }
  // brass plaque with an anchor on the canal-facing side
  g.on(CH.metal, () => {
    const pz = Math.floor(cz + rv * 0.82) + 1;
    const py = P + Math.round(H * 0.45);
    g.box(Math.floor(cx) - 2, py - 2, pz, Math.floor(cx) + 2, py + 2, pz, 0x9a8040);
    g.box(Math.floor(cx), py - 1, pz + 1, Math.floor(cx), py + 2, pz + 1, 0xd8b860);
    g.box(Math.floor(cx) - 1, py - 1, pz + 1, Math.floor(cx) + 1, py - 1, pz + 1, 0xd8b860);
  });
  const top = P + H;
  g.on(CH.metal, () => taper(g, cx, cz, 1.2, 1.2, top, top + 1, 0x2a2c30));
  const c = lanternCage(g, Math.floor(cx), top + 2, Math.floor(cz), 2, 5, 0xffc070);
  void rngFor;
  const pivot: [number, number, number] = [cx, P, cz];
  return {
    ...toModel(g, V, { [CH.base]: mats.stone(true), [CH.metal]: mats.iron(), [CH.glow]: mats.lamp() }, { pivot }),
    halos: halo2(c, pivot, V, 2.6),
    lamps: [lampAt(c, pivot, V, 'bridgepier')],
  };
}

export { post };
