// Cogwater Canal props: crate, barrel, bollard, lamppost, pipe.
import type { PropCtx } from './buildProps.ts';
import { blotch, CH, h3, lampAt, PGrid, pmat, rngFor, seg, shade, taper, toModel, vn3, type PropModel } from './common.ts';
import { LampSet } from './dressing.ts';
import { lanternCage, mats } from './kit.ts';

const SINK = 2;
const woodMat = () => pmat({ rough: 0.82 });
const ironMat = () => pmat({ metal: 0.7, rough: 0.42 });
const brassMat = () => pmat({ metal: 0.9, rough: 0.28 });

export function plankWood(seed: number): (x: number, y: number, z: number) => number {
  const pal = [0x8e6236, 0x9c6e3e, 0xa87a48, 0xb68852, 0x8a5c32];
  return (x, y, z) => {
    const t = vn3(x * 0.15, y * 0.9, z * 0.15, seed) * 0.75 + h3(x, y, z, seed) * 0.25;
    return pal[Math.min(pal.length - 1, Math.floor(t * pal.length))];
  };
}

/** One crate box with planks, frame boards, iron corners and a stencil. */
export function crateBox(g: PGrid, x0: number, y0: number, z0: number, sx: number, sy: number, sz: number, seed: number, stencil: boolean): void {
  const wood = plankWood(seed);
  const x1 = x0 + sx - 1;
  const y1 = y0 + sy - 1;
  const z1 = z0 + sz - 1;
  g.box(x0 + 1, y0, z0 + 1, x1 - 1, y1, z1 - 1, (x, y, z) => {
    const c = wood(x, y, z);
    return (y - y0) % 4 === 3 ? shade(c, 0.62) : c; // plank gaps
  });
  // raised frame boards along every edge
  const frame = (x: number, y: number, z: number) => shade(wood(x, y, z), 0.86);
  for (const xx of [x0, x1])
    for (const zz of [z0, z1]) g.box(xx, y0, zz, xx, y1, zz, frame);
  g.box(x0, y0, z0, x1, y0, z0, frame);
  g.box(x0, y1, z0, x1, y1, z0, frame);
  g.box(x0, y0, z1, x1, y0, z1, frame);
  g.box(x0, y1, z1, x1, y1, z1, frame);
  g.box(x0, y0, z0, x0, y0, z1, frame);
  g.box(x0, y1, z0, x0, y1, z1, frame);
  g.box(x1, y0, z0, x1, y0, z1, frame);
  g.box(x1, y1, z0, x1, y1, z1, frame);
  // diagonal braces on the x faces
  for (let i = 0; i < Math.min(sy, sz); i++) {
    const t = i / Math.min(sy, sz);
    const zz = Math.floor(z0 + t * (sz - 1));
    const yy = Math.floor(y0 + t * (sy - 1));
    g.set(x0, yy, zz, frame(x0, yy, zz));
    g.set(x1, yy, z1 - (zz - z0), frame(x1, yy, zz));
  }
  // iron corner brackets with rivets
  g.on(CH.metal, () => {
    for (const xx of [x0, x1])
      for (const yy of [y0, y1])
        for (const zz of [z0, z1]) {
          const dx = xx === x0 ? 1 : -1;
          const dy = yy === y0 ? 1 : -1;
          const dz = zz === z0 ? 1 : -1;
          for (let k = 0; k < 3; k++) {
            g.set(xx + dx * k, yy, zz, 0x50555e);
            g.set(xx, yy + dy * k, zz, 0x50555e);
            g.set(xx, yy, zz + dz * k, 0x50555e);
          }
          g.set(xx + dx, yy + dy, zz, 0x8a9098);
        }
  });
  if (stencil) {
    // faded fish stencil on the +z face
    const fish = ['..####...#', '.######.##', '#.#######.', '.######.##', '..####...#'];
    const cxs = Math.floor(x0 + sx / 2 - 5);
    const cys = Math.floor(y0 + sy / 2 + 2);
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 10; col++) if (fish[row][col] === '#' && h3(col, row, seed) < 0.85) g.set(cxs + col, cys - row, z1, 0xc84a32);
  }
}

export function buildCrate(r: number, seed: number, ctx?: PropCtx): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 67 + 3);
  const a = Math.round((r * 0.74) / V);
  const n = a * 2 + 6;
  const g = new PGrid(n, 40, n);
  const cx = n / 2;
  const cz = n / 2;
  const h = Math.round(1.15 / V);
  crateBox(g, cx - a, SINK, cz - a, a * 2, h, a * 2, seed, true);
  const variant = seed % 3;
  if (variant === 0) {
    // smaller crate on top, offset
    const b = Math.round(a * 0.62);
    crateBox(g, Math.floor(cx - b + (rnd() - 0.5) * 3), SINK + h, Math.floor(cz - b + (rnd() - 0.5) * 3), b * 2, Math.round(b * 1.6), b * 2, seed + 1, false);
  } else if (variant === 1) {
    // coiled rope on top
    const ry = SINK + h;
    for (let k = 0; k < 3; k++)
      for (let t = 0; t < 64; t++) {
        const an = (t / 64) * Math.PI * 2;
        const rr = a * 0.55 - k * 1.3;
        g.set(cx + Math.cos(an) * rr, ry + (k === 1 ? 1 : 0), cz + Math.sin(an) * rr, t % 4 < 2 ? 0xd2b07a : 0xb8945e);
      }
  } else {
    // sack slumped on top
    for (let y = 0; y < 7; y++)
      for (let z = -6; z <= 6; z++)
        for (let x = -5; x <= 5; x++) {
          const d = (x * x) / 30 + (z * z) / 40 + (y * y) / 30;
          if (d < 1) g.set(cx + x - 1, SINK + h + y, cz + z, h3(x, y, z) < 0.3 ? 0xb8a478 : 0xcab68a);
        }
    g.set(cx - 1, SINK + h + 7, cz, 0x8a6a42);
  }
  const dressed = new LampSet([cx, SINK, cz], V);
  // Epic: a lantern set down inside the rope coil
  if (ctx?.dress && variant === 1) dressed.add(lanternCage(g, Math.floor(cx), SINK + h, Math.floor(cz), 1, 3, 0xffc070), 'small', 1.5, 0xffa040, [0, 0.9, 0]);
  return {
    // (the lamp glass material is only asked for when there is a lamp: material creation order is draw order)
    ...toModel(g, V, dressed.lamps.length ? { [CH.base]: woodMat(), [CH.metal]: ironMat(), [CH.glow]: mats.lamp() } : { [CH.base]: woodMat(), [CH.metal]: ironMat() }, { pivot: [cx, SINK, cz] }),
    halos: dressed.halos,
    lamps: dressed.lamps,
  };
}

export function buildBarrel(r: number, seed: number, ctx?: PropCtx): PropModel {
  const V = 0.06;
  const rv = r / V;
  const n = Math.ceil(rv * 2 + 6);
  const H = Math.round(1.12 / V);
  // Epic (reference maps): a lantern stands on the closed lids, so it needs headroom
  const lit = !!ctx?.dress && seed % 2 === 1;
  const g = new PGrid(n, H + SINK + (lit ? 13 : 6), n);
  const cx = n / 2;
  const cz = n / 2;
  const staves = [0x8a5a30, 0x9a6838, 0x7e5029, 0xa47240];
  const hoopYs = [3, Math.floor(H * 0.3), Math.floor(H * 0.7), H - 3];
  for (let y = 0; y <= SINK + H; y++) {
    const t = Math.max(0, (y - SINK) / H);
    const rr = rv * (0.84 + 0.12 * Math.sin(t * Math.PI));
    const hoop = hoopYs.some((hy) => Math.abs(y - SINK - hy) < 1);
    for (let z = Math.floor(cz - rr - 1); z <= cz + rr + 1; z++)
      for (let x = Math.floor(cx - rr - 1); x <= cx + rr + 1; x++) {
        const dx = x + 0.5 - cx;
        const dz = z + 0.5 - cz;
        const d = Math.hypot(dx, dz);
        const R = hoop ? rr + 0.6 : rr;
        if (d > R) continue;
        if (hoop) {
          g.on(CH.metal, () => g.set(x, y, z, h3(x, y, z, 2) < 0.15 ? 0x8a4e2a : 0x4a4e56));
        } else {
          const st = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2)) * 18);
          const c = staves[st % staves.length];
          g.set(x, y, z, shade(c, 0.92 + vn3(x * 0.2, y * 0.5, z * 0.2, seed) * 0.16));
        }
      }
  }
  const topY = SINK + H;
  const rTop = rv * 0.84;
  if (seed % 2 === 0) {
    // open barrel full of cartoon fish
    for (let z = Math.floor(cz - rTop); z <= cz + rTop; z++)
      for (let x = Math.floor(cx - rTop); x <= cx + rTop; x++) {
        const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
        if (d < rTop - 1.2) g.set(x, topY, z, 0x3a2a1e);
      }
    const fishes: [number, number, number][] = [
      [-3, 0, 0.5],
      [2, -3, 2.1],
      [1, 3, 4],
      [-2, -3, 5.5],
    ];
    for (const [fx, fz, a] of fishes) {
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      for (let k = 0; k < 6; k++) {
        const x = cx + fx + dx * (k - 3);
        const z = cz + fz + dz * (k - 3);
        const y = topY + 1 + (k > 3 ? 1 : 0);
        g.set(x, y, z, k === 0 ? 0x22303a : k < 5 ? (k % 2 ? 0x9ab8c8 : 0xb8d0dc) : 0x6a90a8);
        if (k === 5) {
          g.set(x, y + 1, z, 0x6a90a8);
          g.set(x + dz, y + 1, z - dx, 0x6a90a8);
        }
      }
    }
  } else {
    // closed lid with planks and a bung
    for (let z = Math.floor(cz - rTop); z <= cz + rTop; z++)
      for (let x = Math.floor(cx - rTop); x <= cx + rTop; x++) {
        const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
        if (d < rTop) g.set(x, topY, z, (x - Math.floor(cx)) % 4 === 0 ? 0x6e4626 : 0x9a6a3a);
      }
    g.set(cx + 3, topY + 1, cz + 2, 0x5a3a20);
    // painted band
    g.recolor((c, x, y, z) => (g.chanAt(x, y, z) === CH.base && y === SINK + Math.floor(H * 0.5) ? 0xd8b440 : c));
  }
  if (!lit) return toModel(g, V, { [CH.base]: woodMat(), [CH.metal]: ironMat() }, { pivot: [cx, SINK, cz] });
  const dressed = new LampSet([cx, SINK, cz], V);
  dressed.add(lanternCage(g, Math.floor(cx) - 1, topY + 1, Math.floor(cz) - 1, 1, 3, 0xffc070), 'small', 1.5, 0xffa040, [0, 0.9, 0]);
  return {
    ...toModel(g, V, { [CH.base]: woodMat(), [CH.metal]: ironMat(), [CH.glow]: mats.lamp() }, { pivot: [cx, SINK, cz] }),
    halos: dressed.halos,
    lamps: dressed.lamps,
  };
}

export function buildBollard(r: number, seed: number): PropModel {
  const V = 0.05;
  const rv = r / V;
  const n = Math.ceil(rv * 2 + 8);
  const H = 19;
  const g = new PGrid(n, H + SINK + 4, n);
  const cx = n / 2;
  const cz = n / 2;
  const paint = (x: number, y: number, z: number) => {
    const rust = vn3(x * 0.3, y * 0.3, z * 0.3, seed) > 0.72;
    return rust ? (h3(x, y, z) < 0.5 ? 0x7a4a2a : 0x8a5a32) : h3(x, y, z, 1) < 0.2 ? 0x353a42 : 0x262a31;
  };
  g.on(CH.metal, () => {
    // flange base
    taper(g, cx, cz, rv * 1.0, rv * 0.95, 0, SINK + 2, paint);
    // waisted body
    for (let y = SINK + 3; y <= SINK + 14; y++) {
      const t = (y - SINK - 3) / 11;
      const rr = rv * (0.72 - 0.12 * Math.sin(t * Math.PI));
      taper(g, cx, cz, rr, rr, y, y, paint);
    }
    // mushroom cap
    taper(g, cx, cz, rv * 0.95, rv * 0.95, SINK + 15, SINK + 16, paint);
    taper(g, cx, cz, rv * 0.8, rv * 0.45, SINK + 17, SINK + 19, paint);
    // polished wear on the cap rim
    g.recolor((c, x, y, z) => (y === SINK + 16 && h3(x, y, z) < 0.5 ? 0x5a616c : c));
  });
  // rope wound around the waist with a trailing end
  for (let k = 0; k < 3; k++) {
    for (let t = 0; t < 80; t++) {
      const a = (t / 80) * Math.PI * 2;
      const y = SINK + 6 + k * 2;
      const rr = rv * 0.66 + 1;
      g.set(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr, (t + k * 2) % 5 < 3 ? 0xd2b07a : 0xa8844e);
    }
  }
  seg(g, cx + rv * 0.66 + 1, SINK + 6, cz, cx + rv + 3, SINK, cz + 3, (x, y, z) => ((x + y + z) % 3 ? 0xd2b07a : 0xa8844e), 0.7);
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.95 }), [CH.metal]: pmat({ metal: 0.55, rough: 0.45 }) }, { pivot: [cx, SINK, cz] });
}

export function buildLamppost(r: number, seed: number): PropModel {
  const V = 0.05;
  const rv = r / V;
  const n = 30;
  const H = 74;
  const g = new PGrid(n, H + SINK + 2, n);
  const cx = n / 2;
  const cz = n / 2;
  const iron = (x: number, y: number, z: number) => (h3(x, y, z, seed) < 0.15 ? 0x3a414a : 0x232a31);
  const teal = (x: number, y: number, z: number) => (h3(x, y, z, seed) < 0.2 ? 0x2f5a5a : 0x244848);
  g.on(CH.metal, () => {
    // octagonal plinth with a ring
    for (let y = 0; y <= SINK + 8; y++) {
      const rr = y > SINK + 6 ? rv * 0.75 : y === SINK + 4 ? rv * 1.05 : rv * 0.92;
      for (let z = Math.floor(cz - rr - 1); z <= cz + rr + 1; z++)
        for (let x = Math.floor(cx - rr - 1); x <= cx + rr + 1; x++) {
          const ax = Math.abs(x + 0.5 - cx);
          const az = Math.abs(z + 0.5 - cz);
          if (Math.max(ax, az) <= rr && ax + az <= rr * 1.35) g.set(x, y, z, y === SINK + 4 ? 0x8a7a40 : teal(x, y, z));
        }
    }
    // fluted pole
    for (let y = SINK + 9; y <= SINK + 58; y++) {
      const rr = y < SINK + 14 ? 2.8 : 2.1;
      for (let z = Math.floor(cz - 3); z <= cz + 3; z++)
        for (let x = Math.floor(cx - 3); x <= cx + 3; x++) {
          const dx = x + 0.5 - cx;
          const dz = z + 0.5 - cz;
          if (dx * dx + dz * dz <= rr * rr) g.set(x, y, z, (x + z) % 2 ? iron(x, y, z) : teal(x, y, z));
        }
    }
    // collar rings and ladder bar
    for (const yy of [SINK + 14, SINK + 40, SINK + 57]) taper(g, cx, cz, 3.2, 3.2, yy, yy, 0x8a7a40);
    g.box(cx - 6, SINK + 52, cz, cx + 6, SINK + 52, cz, iron);
    g.set(cx - 6, SINK + 51, cz, 0x8a7a40);
    g.set(cx + 6, SINK + 51, cz, 0x8a7a40);
    // lantern cage
    const ly0 = SINK + 59;
    const ly1 = SINK + 69;
    for (let y = ly0; y <= ly1; y++) {
      const t = (y - ly0) / (ly1 - ly0);
      const hw = Math.round(4 + Math.sin(t * Math.PI) * 1.2);
      for (const sx of [-hw, hw])
        for (const sz of [-hw, hw]) g.set(cx + sx, y, cz + sz, iron(cx, y, cz));
    }
    g.box(cx - 5, ly0 - 1, cz - 5, cx + 5, ly0 - 1, cz + 5, iron);
    g.box(cx - 4, ly0 - 2, cz - 4, cx + 4, ly0 - 2, cz + 4, 0x8a7a40);
    // roof
    for (let k = 0; k < 5; k++) g.box(cx - 6 + k, ly1 + 1 + k, cz - 6 + k, cx + 6 - k, ly1 + 1 + k, cz + 6 - k, k === 0 ? 0x8a7a40 : iron);
    g.set(cx, ly1 + 6, cz, 0x8a7a40);
    g.set(cx, ly1 + 7, cz, 0xb8a050);
  });
  // glowing glass panes
  g.on(CH.glow, () => {
    for (let y = SINK + 60; y <= SINK + 68; y++) {
      const t = (y - SINK - 59) / 10;
      const hw = Math.round(4 + Math.sin(t * Math.PI) * 1.2) - 1;
      g.box(cx - hw, y, cz - hw, cx + hw, y, cz + hw, (x, yy, z) => (Math.max(Math.abs(x - cx), Math.abs(z - cz)) < hw - 1 ? 0xffe8a8 : h3(x, yy, z) < 0.3 ? 0xffc870 : 0xffd890));
    }
  });
  const lampY = (SINK + 64 - SINK) * V;
  return {
    ...toModel(g, V, { [CH.base]: pmat({ rough: 0.9 }), [CH.metal]: ironMat(), [CH.glow]: pmat({ glow: 3.4, flicker: 0.12 }) }, { pivot: [cx, SINK, cz] }),
    halos: [
      { pos: [0, lampY, 0], color: 0xffb060, size: 2.6, opacity: 0.42 },
      { pos: [0, lampY, 0], color: 0xffe0a0, size: 0.9, opacity: 0.75 },
    ],
    lamps: [lampAt([cx, SINK + 64, cz], [cx, SINK, cz], V, 'lamppost')],
  };
}

export function buildPipe(r: number, seed: number): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 71 + 9);
  const rv = r / V;
  const n = Math.ceil(rv * 2.4 + 10);
  const H = 26;
  const g = new PGrid(n, H + SINK + 8, n);
  const cx = n / 2;
  const cz = n / 2;
  const iron = blotch([0x3e4c50, 0x465658, 0x52615f, 0x384446], 0.25, seed, 0.25);
  const rusty = (x: number, y: number, z: number) => (vn3(x * 0.25, y * 0.25, z * 0.25, seed + 3) > 0.7 ? (h3(x, y, z) < 0.5 ? 0x8a4a26 : 0x9a5a30) : iron(x, y, z));
  const brass = (x: number, y: number, z: number) => (h3(x, y, z, 2) < 0.3 ? 0xd8b050 : 0xb8903a);
  const R = rv * 0.62;
  g.on(CH.metal, () => {
    taper(g, cx, cz, R, R, 0, SINK + H, rusty);
    // flanges with bolts
    for (const fy of [SINK + 1, SINK + 11, SINK + 21]) {
      taper(g, cx, cz, rv * 0.86, rv * 0.86, fy, fy + 1, iron);
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        g.set(cx + Math.cos(a) * rv * 0.8, fy + 2, cz + Math.sin(a) * rv * 0.8, 0x8a9498);
      }
    }
    // cap
    taper(g, cx, cz, R + 0.8, R + 0.8, SINK + H + 1, SINK + H + 1, iron);
    taper(g, cx, cz, R * 0.6, R * 0.3, SINK + H + 2, SINK + H + 3, iron);
    // side branch pipe going into the ground with an elbow
    const a = rnd() * Math.PI * 2;
    const ex = Math.cos(a);
    const ez = Math.sin(a);
    seg(g, cx + ex * R, SINK + 16, cz + ez * R, cx + ex * (rv * 0.95), SINK + 16, cz + ez * (rv * 0.95), rusty, 2.2);
    seg(g, cx + ex * (rv * 0.95), SINK + 16, cz + ez * (rv * 0.95), cx + ex * (rv * 0.95), 0, cz + ez * (rv * 0.95), rusty, 2.2);
  });
  // brass valve wheel on top and a copper pipe spiral
  g.on(CH.extra, () => {
    const wy = SINK + H + 5;
    seg(g, cx, SINK + H + 2, cz, cx, wy, cz, brass, 0.7);
    for (let t = 0; t < 48; t++) {
      const an = (t / 48) * Math.PI * 2;
      g.set(cx + Math.cos(an) * 5, wy, cz + Math.sin(an) * 5, 0xc8382a);
    }
    for (let k = 0; k < 4; k++) {
      const an = (k / 4) * Math.PI * 2;
      seg(g, cx, wy, cz, cx + Math.cos(an) * 5, wy, cz + Math.sin(an) * 5, 0xa82a20);
    }
    for (let t = 0; t < 1; t += 0.006) {
      const an = t * Math.PI * 2 * 2.2;
      const y = SINK + 2 + t * 18;
      g.set(cx + Math.cos(an) * (R + 1.2), y, cz + Math.sin(an) * (R + 1.2), (Math.floor(t * 100) % 3 ? 0xc87a4a : 0xd88a5a));
    }
  });
  // glowing pressure gauge on the front
  g.on(CH.glow, () => {
    const gy = SINK + 8;
    const gz = Math.floor(cz + R + 1);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > 5) continue;
        const c = dx * dx + dy * dy > 3 ? 0xd8b050 : dx === 0 && dy >= 0 ? 0xff5a3a : 0xc8ffd8;
        g.set(cx + dx, gy + dy, gz, c);
      }
  });
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.9 }), [CH.metal]: pmat({ metal: 0.6, rough: 0.5 }), [CH.extra]: brassMat(), [CH.glow]: pmat({ glow: 1.6, rough: 0.3 }) }, { pivot: [cx, SINK, cz] });
}

