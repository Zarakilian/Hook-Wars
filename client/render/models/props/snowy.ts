// Aurora Harbour props: the lantern-lit timber watchtower, snow-laden pines and chunky glacier ice shelves.
// Origins at ground contact; the watchtower's front (+Z, ladder side) faces the river.
import type { PropCtx } from './buildProps.ts';
import { blob, blotch, capTop, CH, h3, lampAt, mix, PGrid, pmat, rngFor, seg, shade, taper, toModel, vn3, type CFn, type PropModel } from './common.ts';
import { LampSet } from './dressing.ts';
import { grain, ironCol, lanternCage, mats, post, ropeWrap, snowCol, WOOD } from './kit.ts';

const SINK = 3;

// ---------------------------------------------------------------------------------------------
// Watchtower: rock plinth, four braced timber legs, a lit lookout cabin, snowy hip roof, icicles
// ---------------------------------------------------------------------------------------------

export function buildWatchtower(r: number, seed: number, ctx: PropCtx): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 29 + 5);
  const rv = r / V;
  const skirt = Math.min(Math.round(ctx.below / V), Math.round(1.2 / V));
  const base = skirt + SINK;
  const legHalf = Math.round(rv * 0.66);
  const topHalf = Math.round(rv * 0.56);
  const deckY = base + Math.round(2.6 / V);
  const cab = Math.round(rv * 0.82);
  const cabH = Math.round(1.05 / V);
  const roofH = Math.round(0.9 / V);
  const ov = 4;
  const n = (cab + ov + 4) * 2;
  const g = new PGrid(n, deckY + cabH + roofH + 10, n);
  const cx = n / 2;
  const cz = n / 2;
  const pal = WOOD.ice;
  const timber = grain(pal, seed, 1);
  const dark = grain(pal.map((c) => shade(c, 0.7)), seed + 1, 1);
  // --- rock plinth with snow, reaching down over the island edge
  const rock = blotch([0x6a7488, 0x7a8498, 0x5c6678, 0x8a94a6], 0.2, seed, 0.25);
  for (let y = 0; y <= base + 6; y++) {
    const t = y / (base + 6);
    const R = rv * (1.05 - t * 0.12);
    for (let z = Math.floor(cz - R - 2); z <= cz + R + 2; z++)
      for (let x = Math.floor(cx - R - 2); x <= cx + R + 2; x++) {
        const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) * (0.92 + vn3(x * 0.2, y * 0.2, z * 0.2, seed) * 0.18);
        if (d <= R) g.set(x, y, z, rock(x, y, z));
      }
  }
  capTop(g, 2, (x, y, z) => vn3(x * 0.25, y, z * 0.25, seed + 3) > 0.3, snowCol);
  // --- legs, tapering in, with X bracing on every side at two levels
  const legAt = (y: number) => legHalf + ((topHalf - legHalf) * (y - base)) / (deckY - base);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      for (let y = base + 4; y <= deckY + cabH; y++) {
        const h = y > deckY ? topHalf : legAt(y);
        g.box(Math.floor(cx + sx * h - 1), y, Math.floor(cz + sz * h - 1), Math.floor(cx + sx * h), y, Math.floor(cz + sz * h), y > deckY ? shade(pal[0], 0.6) : dark);
      }
  const lv = [base + 8, Math.round((base + deckY) / 2), deckY - 2];
  for (let i = 0; i + 1 < lv.length; i++) {
    const ya = lv[i];
    const yb = lv[i + 1];
    const ha = legAt(ya);
    const hb = legAt(yb);
    for (const s of [-1, 1]) {
      seg(g, cx - ha, ya, cz + s * ha, cx + hb, yb, cz + s * hb, timber, 0.6);
      seg(g, cx + ha, ya, cz + s * ha, cx - hb, yb, cz + s * hb, timber, 0.6);
      seg(g, cx + s * ha, ya, cz - ha, cx + s * hb, yb, cz + hb, timber, 0.6);
      seg(g, cx + s * ha, ya, cz + ha, cx + s * hb, yb, cz - hb, timber, 0.6);
    }
    for (const s of [-1, 1]) {
      g.box(Math.floor(cx - hb), yb, Math.floor(cz + s * hb), Math.floor(cx + hb), yb, Math.floor(cz + s * hb), timber);
      g.box(Math.floor(cx + s * hb), yb, Math.floor(cz - hb), Math.floor(cx + s * hb), yb, Math.floor(cz + hb), timber);
    }
  }
  // ladder up the front
  const lzF = Math.floor(cz + legHalf + 1);
  for (let y = base + 5; y < deckY; y += 3) g.box(Math.floor(cx - 2), y, lzF, Math.floor(cx + 2), y, lzF, timber);
  for (const lx of [-2, 2]) seg(g, cx + lx, base + 4, lzF, cx + lx, deckY, Math.floor(cz + topHalf + 1), dark, 0.5);
  // --- lookout deck with a rail
  g.box(Math.floor(cx - cab - 2), deckY, Math.floor(cz - cab - 2), Math.floor(cx + cab + 1), deckY + 1, Math.floor(cz + cab + 1), (x, y, z) => (x % 3 === 0 ? shade(timber(x, y, z), 0.7) : timber(x, y, z)));
  for (let k = -cab - 2; k <= cab + 1; k += 3)
    for (const [x, z] of [[cx + k, cz - cab - 2], [cx + k, cz + cab + 1], [cx - cab - 2, cz + k], [cx + cab + 1, cz + k]])
      g.box(Math.floor(x), deckY + 2, Math.floor(z), Math.floor(x), deckY + 5, Math.floor(z), dark);
  for (const [a, b] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const h = cab + 1.5;
    if (a) g.box(Math.floor(cx + a * h - (a > 0 ? 0 : 0.5)), deckY + 6, Math.floor(cz - h), Math.floor(cx + a * h), deckY + 6, Math.floor(cz + h), timber);
    else g.box(Math.floor(cx - h), deckY + 6, Math.floor(cz + b * h), Math.floor(cx + h), deckY + 6, Math.floor(cz + b * h), timber);
  }
  // --- cabin: board walls with big lit windows on every side
  const cy0 = deckY + 2;
  const cy1 = deckY + cabH;
  const ch = cab - 2;
  for (let y = cy0; y <= cy1; y++)
    for (let k = -ch; k <= ch; k++) {
      const winRow = y >= cy0 + 4 && y <= cy1 - 2;
      const winCol = Math.abs(k) <= ch - 2 && Math.abs(k) % 5 !== 0;
      for (const [x, z] of [[cx + k, cz - ch], [cx + k, cz + ch], [cx - ch, cz + k], [cx + ch, cz + k]]) {
        const xi = Math.floor(x);
        const zi = Math.floor(z);
        if (winRow && winCol) g.on(CH.glow, () => g.set(xi, y, zi, h3(xi, y, zi) < 0.25 ? 0xffb860 : 0xffd898));
        else g.set(xi, y, zi, Math.abs(k) === ch ? shade(pal[0], 0.6) : (xi + zi) % 3 === 0 ? shade(timber(xi, y, zi), 0.75) : timber(xi, y, zi));
      }
    }
  g.box(Math.floor(cx - ch + 1), cy0, Math.floor(cz - ch + 1), Math.floor(cx + ch - 1), cy0, Math.floor(cz + ch - 1), 0x2a2018);
  // --- hip roof: dark shingles under a heavy snow cap, icicles at the eaves
  const shingle = blotch([0x3a3436, 0x444042, 0x322c2e], 0.3, seed + 4, 0.2);
  const rTop = cy1 + 1;
  for (let k = 0; k <= roofH; k++) {
    const h = cab + ov - Math.round((k * (cab + ov)) / roofH);
    if (h < 0) break;
    for (let z = Math.floor(cz - h); z <= Math.floor(cz + h); z++)
      for (let x = Math.floor(cx - h); x <= Math.floor(cx + h); x++) {
        const edge = Math.max(Math.abs(x + 0.5 - cx), Math.abs(z + 0.5 - cz)) > h - 1.6;
        if (!edge && k < roofH) continue;
        g.set(x, rTop + k, z, (x + z + k) % 4 === 0 ? shade(shingle(x, k, z), 0.7) : shingle(x, k, z));
      }
  }
  capTop(g, 2, (x, y, z) => y > rTop + 3 && vn3(x * 0.3, y * 0.3, z * 0.3, seed + 6) > 0.35, snowCol);
  g.set(Math.floor(cx), rTop + roofH + 1, Math.floor(cz), 0x2a2a2e);
  g.set(Math.floor(cx), rTop + roofH + 2, Math.floor(cz), 0xb8a050);
  g.on(CH.ice, () => {
    const h = cab + ov;
    for (let k = -h; k <= h; k++) {
      if (rnd() > 0.55) continue;
      const len = 2 + Math.floor(rnd() * 5);
      for (const [x, z] of [[cx + k, cz - h], [cx + k, cz + h], [cx - h, cz + k], [cx + h, cz + k]])
        for (let j = 1; j <= len; j++) if (rnd() < 0.5 || j === 1) g.set(Math.floor(x), rTop - j, Math.floor(z), j === len ? 0xf0fbff : 0xbfe8fb);
    }
  });
  // snow on the deck rail and the bracing
  capTop(g, 1, (x, y, z) => y < rTop && y > base + 6 && h3(x, y, z, 8) < 0.6, snowCol);
  // a lantern hanging under the front eave, a coil of rope on the deck
  const lx = Math.floor(cx + cab - 1);
  const lz = Math.floor(cz + cab + 2);
  g.on(CH.metal, () => g.box(lx, rTop - 3, lz, lx, rTop - 1, lz, 0x2a2a2e));
  const c = lanternCage(g, lx, rTop - 10, lz, 2, 4, 0xffcc70);
  ropeWrap(g, cx - cab + 1, cz + cab - 1, 1.5, deckY + 2, 2);
  const pv: [number, number, number] = [cx, base, cz];
  const dressed = new LampSet(pv, V);
  if (ctx.dress) {
    // Epic: lanterns under the other three eave corners, so the tower reads as a beacon (ref05)
    for (const [ex, ez] of [
      [Math.floor(cx - cab), lz],
      [lx, Math.floor(cz - cab - 3)],
      [Math.floor(cx - cab), Math.floor(cz - cab - 3)],
    ]) {
      g.on(CH.metal, () => g.box(ex, rTop - 3, ez, ex, rTop - 1, ez, 0x2a2a2e));
      dressed.add(lanternCage(g, ex, rTop - 10, ez, 2, 4, 0xffcc70), 'lanternpost', 2.0, 0xffb050);
    }
  }
  const lp: [number, number, number] = [(c[0] - pv[0]) * V, (c[1] - pv[1]) * V, (c[2] - pv[2]) * V];
  return {
    ...toModel(g, V, { [CH.base]: mats.wood('ice'), [CH.glow]: mats.window(), [CH.metal]: mats.iron(), [CH.ice]: mats.ice() }, { pivot: pv }),
    halos: [
      { pos: lp, color: 0xffb050, size: 2.2, opacity: 0.45 },
      { pos: lp, color: 0xfff0c8, size: 0.7, opacity: 0.75 },
      { pos: [0, (cy0 + cabH / 2 - base) * V, 0], color: 0xffa850, size: 4.6, opacity: 0.22 },
      ...dressed.halos,
    ],
    lamps: [lampAt(c, pv, V, 'watchtower'), ...dressed.lamps],
  };
}

// ---------------------------------------------------------------------------------------------
// Snow pine: blue-green tiers bowed under thick snow, snow clumps sliding off the tips
// ---------------------------------------------------------------------------------------------

export function buildSnowPine(r: number, seed: number): PropModel {
  const V = 0.1;
  const rnd = rngFor(seed * 37 + 3);
  const rv = r / V;
  const n = 34;
  const H = 54 + (seed % 3) * 4;
  const g = new PGrid(n, H + SINK + 4, n);
  const cx = n / 2;
  const cz = n / 2;
  const bark: CFn = (x, y, z) => (h3(x, y, z, seed) < 0.3 ? 0x3a2a20 : 0x4a3426);
  // snow drift at the base sized to the collision radius
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) / (rv * 1.1);
      if (d > 1) continue;
      const hh = Math.floor((1 - d * d) * 5 + vn3(x * 0.35, 0, z * 0.35, seed) * 2);
      for (let y = 0; y <= SINK + hh; y++) g.set(x, y, z, snowCol(x, y, z));
    }
  taper(g, cx, cz, rv * 0.42, 1.2, 0, SINK + H - 6, bark);
  const needle = blotch([0x1c3e3a, 0x214844, 0x285250, 0x18363a, 0x2e5a56], 0.22, seed + 5, 0.2);
  const tiers = 6;
  const lobes = 7 + (seed % 3);
  g.on(CH.leaf, () => {
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const y0 = SINK + 5 + i * 8;
      // the lowest tiers stay inside the collision radius (hook height), the upper ones may spread
      const R = Math.min(14.5 - t * 10, rv * 1.15 + i * 2.2);
      const th = 7;
      for (let y = y0; y < y0 + th + 3; y++) {
        const k = (y - y0) / (th + 3);
        const rr = R * (1 - k) + 1;
        for (let z = Math.floor(cz - R - 2); z <= cz + R + 2; z++)
          for (let x = Math.floor(cx - R - 2); x <= cx + R + 2; x++) {
            const dx = x + 0.5 - cx;
            const dz = z + 0.5 - cz;
            const a = Math.atan2(dz, dx);
            const lr = rr * (0.84 + 0.16 * Math.cos(a * lobes + i * 1.7 + seed));
            const d = Math.hypot(dx, dz);
            const droop = Math.max(0, d - R * 0.45) * 0.5;
            if (d <= lr) g.set(x, Math.floor(y - droop), z, needle(x, y, z));
          }
      }
    }
    taper(g, cx, cz, 2, 0.3, SINK + H - 8, SINK + H, needle);
  });
  // heavy snow: deep caps on every tier, clumps hanging off the tips
  capTop(g, 2, (x, y, z) => g.chanAt(x, y, z) === CH.leaf && vn3(x * 0.3, y * 0.3, z * 0.3, seed + 2) > 0.4, snowCol);
  for (let k = 0; k < 7; k++) {
    const a = rnd() * Math.PI * 2;
    const i = Math.floor(rnd() * (tiers - 1));
    const R = Math.min(14.5 - (i / (tiers - 1)) * 10, rv * 1.15 + i * 2.2) * 0.9;
    const y = SINK + 5 + i * 8 - Math.round(R * 0.25);
    blob(g, cx + Math.cos(a) * R, y, cz + Math.sin(a) * R, 1.6, 1.3, 1.6, 0.2, seed + k, snowCol, 0.5);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.8 }), [CH.leaf]: pmat({ rough: 0.9, sway: 0.035, swayH: 6 }) }, { pivot: [cx, SINK, cz] });
}

// ---------------------------------------------------------------------------------------------
// Ice shelf: stepped blocks of glacier ice, vertical striations, snow caps, icicles, glowing cracks
// ---------------------------------------------------------------------------------------------

export function buildIceShelf(r: number, seed: number): PropModel {
  const V = 0.1;
  const rnd = rngFor(seed * 53 + 9);
  const rv = r / V;
  const n = Math.ceil(rv * 2 + 10);
  const H = Math.round((1.5 + (seed % 3) * 0.3) / V);
  const g = new PGrid(n, H + SINK + 8, n);
  const cx = n / 2;
  const cz = n / 2;
  // 3-5 overlapping blocks inside the collision circle
  const nb = 3 + (seed % 3);
  const boxes: [number, number, number, number, number][] = [];
  for (let i = 0; i < nb; i++) {
    const a = rnd() * Math.PI * 2;
    const d = i === 0 ? 0 : rv * (0.25 + rnd() * 0.3);
    const hw = rv * (i === 0 ? 0.62 : 0.32 + rnd() * 0.18);
    const hd = rv * (i === 0 ? 0.55 : 0.3 + rnd() * 0.18);
    const h = Math.round(H * (i === 0 ? 1 : 0.45 + rnd() * 0.4));
    boxes.push([cx + Math.cos(a) * d, cz + Math.sin(a) * d, hw, hd, h]);
  }
  g.on(CH.ice, () => {
    for (const [bx, bz, hw, hd, h] of boxes)
      for (let y = 0; y <= SINK + h; y++)
        for (let z = Math.floor(bz - hd); z <= Math.ceil(bz + hd); z++)
          for (let x = Math.floor(bx - hw); x <= Math.ceil(bx + hw); x++) {
            const ex = Math.abs(x + 0.5 - bx) / hw;
            const ez = Math.abs(z + 0.5 - bz) / hd;
            const top = y > SINK + h - 2;
            // eroded corners
            if (Math.max(ex, ez) > 1 || (ex > 0.8 && ez > 0.8 && h3(x, y, z, seed) < 0.6) || (top && Math.max(ex, ez) > 0.9 && h3(x, y, z, seed + 1) < 0.5)) continue;
            if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) > rv * 1.02) continue;
            const stripe = h3(x, 0, z, seed + 2) * 0.6 + vn3(x * 0.25, 0, z * 0.25, seed) * 0.4;
            const depth = 1 - (y - SINK) / Math.max(1, h);
            const c = mix(mix(0xd8f2ff, 0xa0d6f4, stripe), mix(0x4c98cc, 0x2c6ca4, stripe), Math.max(0, Math.min(1, depth * 0.9)));
            g.set(x, y, z, c);
          }
  });
  // glowing cracks low down
  g.on(CH.glow2, () => {
    for (let k = 0; k < 5; k++) {
      const [bx, bz, hw] = boxes[k % boxes.length];
      const a = rnd() * Math.PI * 2;
      let x = bx + Math.cos(a) * hw;
      let z = bz + Math.sin(a) * hw;
      let y = SINK + 1 + rnd() * 4;
      for (let j = 0; j < 9; j++) {
        if (g.solid(Math.floor(x), Math.floor(y), Math.floor(z))) g.set(x, y, z, 0x9ff4ff);
        y += 0.8;
        x += (rnd() - 0.5) * 1.4;
        z += (rnd() - 0.5) * 1.4;
      }
    }
  });
  // snow caps (2 deep) and hanging icicles off every ledge
  capTop(g, 2, (x, y, z) => vn3(x * 0.25, y * 0.2, z * 0.25, seed + 5) > 0.25, snowCol);
  g.on(CH.ice, () => {
    for (let k = 0; k < 40; k++) {
      const x = Math.floor(rnd() * n);
      const z = Math.floor(rnd() * n);
      let top = -1;
      for (let y = g.ny - 1; y > SINK + 3; y--)
        if (g.solid(x, y, z)) {
          top = y;
          break;
        }
      if (top < 0) continue;
      // find an outward neighbour that is empty below the ledge
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (g.solid(x + dx, top - 1, z + dz)) continue;
        const len = 2 + Math.floor(rnd() * 5);
        for (let j = 0; j < len; j++) if (!g.solid(x + dx, top - 1 - j, z + dz)) g.set(x + dx, top - 1 - j, z + dz, j === len - 1 ? 0xf0fbff : 0xbfe8fb);
        break;
      }
    }
  });
  // packed snow around the foot
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) / rv;
      if (d < 0.8 || d > 1.08) continue;
      const hh = Math.floor((1.08 - d) * 10 * vn3(x * 0.3, 0, z * 0.3, seed + 9));
      for (let y = 0; y <= SINK + hh; y++) if (!g.solid(x, y, z)) g.set(x, y, z, snowCol(x, y, z));
    }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.72 }), [CH.ice]: mats.ice(), [CH.glow2]: pmat({ glow: 2.0, pulse: 0.4, rough: 0.2 }) }, { pivot: [cx, SINK, cz], noShadowCh: [CH.glow2] });
}

export { ironCol, post };
