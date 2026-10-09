// Walkable decks over water: docks, piers, bridges, ice floes and raft decks.
//
// Contract: the deck top of every platform sits exactly at platformDeckY(map, p) and covers exactly the
// walkable rectangle that platformAt() tests (p.w along local x, p.d along local z, yaw p.rot), so what
// you see is what you stand on. Piles, pier stones and ice bodies run down to the river bed, so nothing
// hovers when the water drains (dry bed, low tide, frozen harbour).
//
// Geometry is cached per map and merged per map quadrant and per material: a whole map's decks cost
// a handful of draws, cull by quadrant and need no disposal (bounded by map content, like the other prop caches).
import * as THREE from 'three';
import { waterDepthAt } from '../../../../shared/maps/helpers.ts';
import type { MapDef, Platform } from '../../../../shared/maps/types.ts';
import { cinematicEnabled } from '../../cinematic.ts';
import { bedY, platformDeckY, waterY, type Quality } from '../../contracts.ts';
import { addLamps, haloGeometry, haloMeshOf, StaticBatch, type HaloItem, type LampItem } from './batch.ts';
import { blotch, CH, h3, lampAt, mix, moodOf, moodVariant, PGrid, pmat, propsQuality, qLevel, rngFor, shade, toModel, trackOffGeometry, vn3, type CFn, type PropLamp, type PropModel } from './common.ts';
import { dressingOn, mossDrape, strand, vineCol } from './dressing.ts';
import { blocks, grain, ironCol, lanternCage, mats, post, ropeCol, ropeDark, ropeWrap, sagRope, snowCol, themeOf, WOOD, waterline, type Theme } from './kit.ts';

interface Spec {
  kind: Platform['kind'];
  w: number;
  d: number;
  seed: number;
  theme: Theme;
  /** deck top minus river bed, metres */
  bedDrop: number;
  /** deck top minus full water surface, metres */
  wetDrop: number;
  /** is the local -x / +x end on dry land? */
  land: [boolean, boolean];
  /** local x range that is over water (metres, -w/2..w/2), null when none */
  wet: [number, number] | null;
  /** Epic set dressing (cinematic, reference maps only); absent otherwise, so the normal cache keys are unchanged */
  dress?: true;
}

// ---------------------------------------------------------------------------------------------
// Wooden decks: dock, pier, plank bridge
// ---------------------------------------------------------------------------------------------

function woodDeck(s: Spec): PropModel {
  const V = 0.08;
  const M = 6;
  const nxD = Math.max(6, Math.round(s.w / V));
  const nzD = Math.max(6, Math.round(s.d / V));
  const down = Math.ceil((s.bedDrop + 0.3) / V);
  const up = Math.ceil(2.1 / V);
  const NX = nxD + M * 2;
  const NZ = nzD + M * 2;
  const g = new PGrid(NX, down + up, NZ);
  const rnd = rngFor(s.seed * 131 + 7);
  const pal = WOOD[s.theme];
  const wy = Math.round(down - s.wetDrop / V); // full waterline (voxel y)
  const wl = waterline(s.theme);
  const plankPal = pal;
  const darkPal = pal.map((c) => shade(c, 0.72));
  const pileCol = grain(darkPal, s.seed + 3, 1);
  const wetPile: CFn = (x, y, z) => wl(pileCol(x, y, z), x, y, z, wy);
  const x0 = M;
  const x1 = M + nxD - 1;
  const z0 = M;
  const z1 = M + nzD - 1;
  const pierLike = s.land[0] !== s.land[1];
  const waterEnd = pierLike ? (s.land[0] ? 1 : -1) : 0; // +1: the +x end is over water

  // --- stringers and pile caps under the planks
  const under = grain(darkPal, s.seed + 5, 0);
  for (const zz of [z0 + 1, z0 + Math.floor(nzD / 2), z1 - 2]) g.box(x0, down - 4, zz, x1, down - 3, zz + 1, under);

  // --- piles: two rows along the long edges, a middle row on wide decks
  const span = s.kind === 'pier' ? 1.0 : 1.3;
  const n = Math.max(2, Math.round(s.w / span) + 1);
  const pileX: number[] = [];
  for (let k = 0; k < n; k++) pileX.push(Math.round(x0 + 2 + (k * (nxD - 5)) / (n - 1)));
  const railTop = down + 9;
  const rows = [z0 + 1, z1 - 1];
  // piles deep in the bank are buried: only their rail posts are drawn
  const buried = (px: number) => {
    if (!s.wet) return false;
    const lx = (px + 0.5 - (M + nxD / 2)) * V;
    return lx < s.wet[0] - 1.1 || lx > s.wet[1] + 1.1;
  };
  for (const px of pileX) {
    for (const pz of rows) {
      post(g, px + 0.5, pz + 0.5, 1.75, buried(px) ? down - 5 : 0, railTop, pileCol, wy + 2, wetPile);
      // dark cap and a rope collar at the rail
      g.box(px - 1, railTop + 1, pz - 1, px + 1, railTop + 1, pz + 1, shade(pal[1], 0.6));
      if (s.theme !== 'wharf') ropeWrap(g, px + 0.5, pz + 0.5, 2.2, down + 6, 2);
    }
    if (nzD >= 22 && !buried(px)) post(g, px + 0.5, z0 + nzD / 2, 1.6, 0, down - 3, pileCol, wy + 2, wetPile);
    // pile cap beam across the deck
    g.box(px - 1, down - 3, z0, px + 1, down - 3, z1, under);
  }
  // diagonal bracing between piles (shows when the river drains)
  for (let k = 0; k + 1 < pileX.length; k++) {
    if (buried(pileX[k]) && buried(pileX[k + 1])) continue;
    for (const pz of rows) {
      const a = pileX[k];
      const b = pileX[k + 1];
      const lo = Math.max(2, wy - 6);
      g.line(a + 0.5, down - 5, pz + 0.5, b + 0.5, lo, pz + 0.5, 0.7, (x, y, z) => wl(under(x, y, z), x, y, z, wy));
    }
  }

  // --- planks across the deck (along z), 3 voxels wide, seams, worn ends, nails
  const pw = 3;
  for (let x = x0; x <= x1; x++) {
    const i = x - x0;
    const pi = Math.floor(i / pw);
    const tone = plankPal[Math.floor(h3(pi, 1, 2, s.seed) * plankPal.length)];
    const zs = z0 - (h3(pi, 3, 1, s.seed) < 0.3 ? 1 : 0);
    const ze = z1 + (h3(pi, 4, 1, s.seed) < 0.3 ? 1 : 0);
    const worn = h3(pi, 5, 1, s.seed) < 0.18;
    for (let z = zs; z <= ze; z++) {
      for (const y of [down - 2, down - 1]) {
        let c = shade(tone, 0.86 + vn3(x * 0.6, y, z * 0.07, s.seed + pi) * 0.26);
        if (i % pw === 0) c = shade(c, y === down - 1 ? 0.6 : 0.75);
        if (worn) c = mix(c, s.theme === 'tropic' ? 0xd8c8a0 : 0x8a7a64, 0.25);
        if (y === down - 1 && (z === zs || z === ze)) c = shade(c, 0.82);
        g.set(x, y, z, c);
      }
    }
    // nails over the stringers
    if (i % pw === 1)
      g.on(CH.metal, () => {
        for (const zz of [z0 + 1, z1 - 2]) g.set(x, down - 1, zz, h3(x, zz, 9) < 0.5 ? 0x5a4a3a : 0x3a3a3e);
      });
  }
  // theme dressing on the top layer: snow drifts, moss, sun-bleach
  g.recolor((c, x, y, z) => {
    if (y !== down - 1 || x < x0 || x > x1) return c;
    const n0 = vn3(x * 0.18, 0, z * 0.18, s.seed + 11);
    if (s.theme === 'ice' && n0 > 0.5) return snowCol(x, y, z);
    if (s.theme === 'marsh' && (z <= z0 + 1 || z >= z1 - 1) && n0 > 0.55) return mix(c, 0x4a6a2a, 0.55);
    if (s.theme === 'wharf' && n0 > 0.62) return mix(c, 0x2a2622, 0.4);
    return c;
  });

  // --- rope rails along the long sides (open at land ends so units walk on and off)
  for (const pz of rows) {
    for (let k = 0; k + 1 < pileX.length; k++) {
      const a: [number, number, number] = [pileX[k] + 0.5, down + 7, pz + 0.5];
      const b: [number, number, number] = [pileX[k + 1] + 0.5, down + 7, pz + 0.5];
      sagRope(g, a, b, 1.2, s.theme === 'wharf' ? ropeDark : ropeCol, 0.7);
      if (s.theme === 'ice') sagRope(g, [a[0], a[1] + 1, a[2]], [b[0], b[1] + 1, b[2]], 1.2, snowCol, 0.5);
    }
  }
  // snow caps on posts
  if (s.theme === 'ice')
    for (const px of pileX) for (const pz of rows) g.box(px - 1, railTop + 2, pz - 1, px + 1, railTop + 2, pz + 1, snowCol);

  const halos: PropModel['halos'] = [];
  const lamps: PropLamp[] = [];
  const pivotD: [number, number, number] = [M + nxD / 2, down, M + nzD / 2];
  // --- pier furniture at the water end: bollards, fender rope, a lantern post
  if (waterEnd !== 0) {
    const ex = waterEnd > 0 ? x1 - 2 : x0 + 2;
    for (const pz of [z0 + 4, z1 - 4]) {
      const bcol = s.theme === 'wharf' ? ironCol(s.seed, 0.25) : grain(darkPal, s.seed + 9, 1);
      if (s.theme === 'wharf') g.on(CH.metal, () => post(g, ex + 0.5, pz + 0.5, 2.2, down, down + 5, bcol));
      else post(g, ex + 0.5, pz + 0.5, 2.2, down, down + 5, bcol);
      g.on(s.theme === 'wharf' ? CH.metal : CH.base, () => post(g, ex + 0.5, pz + 0.5, 2.8, down + 6, down + 6, bcol));
      ropeWrap(g, ex + 0.5, pz + 0.5, 2.6, down + 2, 2);
    }
    // fender: coiled rope hanging on the end face
    const fx = waterEnd > 0 ? x1 + 1 : x0 - 1;
    for (let k = 0; k < 3; k++) {
      const fz = z0 + Math.round(((k + 1) * nzD) / 4);
      for (let t = 0; t < 18; t++) {
        const a = (t / 18) * Math.PI * 2;
        g.set(fx + waterEnd * (1 + Math.cos(a) * 0.6), down - 4 + Math.sin(a) * 2.4, fz + Math.cos(a) * 2.4, ropeCol(t, k, 0));
      }
    }
    // lantern post at the water-end corner
    const lx = waterEnd > 0 ? x1 - 1 : x0 + 1;
    const lz = h3(s.seed, 2, 2) < 0.5 ? z0 + 1 : z1 - 1;
    const postTop = down + 24;
    post(g, lx + 0.5, lz + 0.5, 1.75, down, postTop, pileCol);
    const armDir = lz === z0 + 1 ? -1 : 1;
    g.box(lx, postTop - 1, lz, lx, postTop, lz + armDir * 5, shade(pal[0], 0.7));
    g.on(CH.metal, () => g.box(lx, postTop - 3, lz + armDir * 5, lx, postTop - 2, lz + armDir * 5, 0x2a2a2e));
    const glow = s.theme === 'ice' ? 0xffd890 : s.theme === 'tropic' ? 0xffc870 : 0xffb860;
    const c = lanternCage(g, lx, postTop - 10, lz + armDir * 5, 2, 5, glow);
    halos.push({ pos: [(c[0] - (M + nxD / 2)) * V, (c[1] - down) * V, (c[2] - (M + nzD / 2)) * V], color: 0xffa850, size: 1.9, opacity: 0.4 });
    halos.push({ pos: [(c[0] - (M + nxD / 2)) * V, (c[1] - down) * V, (c[2] - (M + nzD / 2)) * V], color: 0xfff0c0, size: 0.6, opacity: 0.7 });
    lamps.push(lampAt(c, pivotD, V, 'lanternpost'));
  }
  if (s.dress) {
    // Epic: lantern posts at the land end(s) too, as on the reference docks (refs 04 to 06)
    for (const e of waterEnd !== 0 ? [-waterEnd] : [-1, 1]) {
      const lx = e > 0 ? x1 - 1 : x0 + 1;
      const lz = h3(s.seed, 5, e + 3) < 0.5 ? z0 + 1 : z1 - 1;
      const postTop = down + 24;
      post(g, lx + 0.5, lz + 0.5, 1.75, down, postTop, pileCol);
      const armDir = lz === z0 + 1 ? -1 : 1;
      g.box(lx, postTop - 1, lz, lx, postTop, lz + armDir * 5, shade(pal[0], 0.7));
      g.on(CH.metal, () => g.box(lx, postTop - 3, lz + armDir * 5, lx, postTop - 2, lz + armDir * 5, 0x2a2a2e));
      const glow = s.theme === 'ice' ? 0xffd890 : s.theme === 'tropic' ? 0xffc870 : 0xffb860;
      const c = lanternCage(g, lx, postTop - 10, lz + armDir * 5, 2, 5, glow);
      const l = lampAt(c, pivotD, V, 'lanternpost');
      lamps.push(l);
      halos.push({ pos: l.pos, color: 0xffa850, size: 1.9, opacity: 0.4 }, { pos: l.pos, color: 0xfff0c0, size: 0.6, opacity: 0.7 });
    }
    // moss (marsh) or weed (cove) hanging off the deck edges, under the planks
    if (s.theme === 'marsh' || s.theme === 'tropic') {
      const mr = rngFor(s.seed * 211 + 3);
      for (let k = 0; k < Math.round(nxD / 3); k++) {
        const x = x0 + Math.floor(mr() * nxD);
        strand(g, x, down - 3, mr() < 0.5 ? z0 - 1 : z1 + 1, 3 + Math.floor(mr() * 7), s.theme === 'marsh' ? mossDrape : vineCol, mr);
      }
    }
  }
  // icicles hanging under the long edges
  if (s.theme === 'ice')
    g.on(CH.ice, () => {
      for (let x = x0; x <= x1; x += 2) {
        if (rnd() > 0.45) continue;
        const len = 2 + Math.floor(rnd() * 5);
        const zz = rnd() < 0.5 ? z0 - 1 : z1 + 1;
        for (let k = 0; k < len; k++) g.set(x, down - 3 - k, zz, k === len - 1 ? 0xe8f8ff : 0xb8e4f8);
      }
    });
  // marsh: a few glowing toadstools at the pile feet on land ends
  if (s.theme === 'marsh')
    g.on(CH.glow2, () => {
      for (let k = 0; k < 4; k++) {
        const px = pileX[Math.floor(rnd() * pileX.length)] + (rnd() < 0.5 ? -2 : 2);
        const pz = rows[k % 2] + (rnd() < 0.5 ? -2 : 2);
        g.box(px, wy + 3, pz, px, wy + 3, pz, 0x9affd8);
      }
    });

  const model = toModel(
    g,
    V,
    {
      [CH.base]: mats.wood(s.theme),
      [CH.metal]: s.theme === 'wharf' ? mats.rust() : mats.iron(),
      [CH.glow]: mats.lamp(),
      [CH.glow2]: pmat({ glow: 1.6, pulse: 0.5, rough: 0.5 }),
      [CH.ice]: mats.ice(),
    },
    { pivot: [M + nxD / 2, down, M + nzD / 2], ao: 0.5 },
  );
  model.halos = halos;
  model.lamps = lamps;
  (model as Sized).fit = [nxD * V, nzD * V];
  return model;
}

// ---------------------------------------------------------------------------------------------
// Stone arch bridge (Lantern Wharf)
// ---------------------------------------------------------------------------------------------

function stoneBridge(s: Spec): PropModel {
  const V = 0.1;
  const M = 3;
  const nxD = Math.max(8, Math.round(s.w / V));
  const nzD = Math.max(6, Math.round(s.d / V));
  const down = Math.ceil((s.bedDrop + 0.3) / V);
  const up = 16;
  const NX = nxD + M * 2;
  const NZ = nzD + M * 2 + 12;
  const ZO = 6; // extra room for the cutwaters
  const g = new PGrid(NX, down + up, NZ);
  const x0 = M;
  const x1 = M + nxD - 1;
  const z0 = M + ZO;
  const z1 = z0 + nzD - 1;
  const wy = Math.round(down - s.wetDrop / V);
  const yBed = Math.max(1, Math.round(down - s.bedDrop / V));
  const stonePal = [0x5e5a56, 0x6a6560, 0x55514e, 0x726c66, 0x625c58];
  const face = blocks(stonePal, 6, 3, s.seed);
  const ring = blocks([0x7a746c, 0x847c72, 0x6e6860], 3, 4, s.seed + 1, 0.7);
  const wl = waterline('wharf');
  // canal span in voxels
  const wet = s.wet ?? [-s.w * 0.4, s.w * 0.4];
  const ca = Math.round(x0 + (wet[0] + s.w / 2) / V);
  const cb = Math.round(x0 + (wet[1] + s.w / 2) / V);
  const arches: [number, number][] = [];
  const pierW = Math.round(0.9 / V);
  if ((cb - ca) * V > 6.5) {
    const mid = Math.round((ca + cb) / 2);
    arches.push([ca + 1, mid - Math.ceil(pierW / 2)], [mid + Math.floor(pierW / 2) + 1, cb - 1]);
  } else arches.push([ca + 1, cb - 1]);
  const yS = yBed + Math.round(0.6 / V);
  const yA = down - 5;
  const inArch = (x: number, y: number): number => {
    for (const [a0, a1] of arches) {
      const xm = (a0 + a1 + 1) / 2;
      const hx = (a1 - a0 + 1) / 2;
      const dx = (x + 0.5 - xm) / hx;
      if (Math.abs(dx) >= 1) continue;
      if (y < yS) return 1 - Math.abs(dx);
      const dy = (y + 0.5 - yS) / (yA - yS);
      const k = dx * dx + dy * dy;
      if (k < 1) return 1 - Math.sqrt(k);
    }
    return -1;
  };
  // body below the deck
  for (let z = z0; z <= z1; z++)
    for (let y = 0; y < down - 3; y++)
      for (let x = x0; x <= x1; x++) {
        const a = inArch(x, y);
        if (a >= 0) continue;
        if ((x < ca - 6 || x > cb + 6) && y < down - 6) continue; // abutments are buried in the quay
        const onFace = z === z0 || z === z1;
        let c = face(x, y, z);
        // voussoir ring around the opening on the faces
        if (onFace) {
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, 2], [2, 0], [-2, 0], [0, 3]])
            if (inArch(x + dx, y - dy) >= 0 || inArch(x + dx, y + dy) >= 0) {
              c = ring(x, y, z);
              break;
            }
        }
        g.set(x, y, z, wl(c, x, y, z, wy));
      }
  // keystones
  for (const [a0, a1] of arches) {
    const xm = Math.round((a0 + a1) / 2);
    for (const z of [z0 - 1, z1 + 1]) g.box(xm - 1, yA - 1, z, xm + 1, yA + 2, z, 0x8a8278);
  }
  // cutwaters on the central pier
  if (arches.length === 2) {
    const px0 = arches[0][1] + 1;
    const px1 = arches[1][0] - 1;
    const pm = (px0 + px1) / 2;
    const half = (px1 - px0 + 1) / 2;
    for (let k = 1; k <= ZO; k++) {
      const hw = half * (1 - k / (ZO + 1));
      for (let y = 0; y <= wy + 3; y++)
        for (let x = Math.floor(pm - hw); x <= Math.ceil(pm + hw); x++) {
          if (Math.abs(x + 0.5 - pm) > hw) continue;
          g.set(x, y, z0 - k, wl(face(x, y, z0 - k), x, y, z0 - k, wy));
          g.set(x, y, z1 + k, wl(face(x, y, z1 + k), x, y, z1 + k, wy));
        }
    }
  }
  // the deck slab: flagstones with a wet sheen (CH.wet)
  const flag = (x: number, y: number, z: number): number => {
    const fx = Math.floor((x + (Math.floor(z / 5) % 2) * 3) / 6);
    const fz = Math.floor(z / 5);
    const joint = (x + (Math.floor(z / 5) % 2) * 3) % 6 === 0 || z % 5 === 0;
    const base = [0x6a645e, 0x5e5852, 0x746e66, 0x625c56][Math.floor(h3(fx, fz, 1, s.seed) * 4)];
    return joint ? shade(base, 0.62) : shade(base, 0.92 + h3(x, y, z, s.seed) * 0.12);
  };
  g.box(x0, down - 3, z0, x1, down - 2, z1, face);
  g.on(CH.wet, () => g.box(x0, down - 1, z0, x1, down - 1, z1, flag));
  // string course under the parapet
  g.box(x0, down - 3, z0 - 1, x1, down - 3, z0 - 1, 0x7a746c);
  g.box(x0, down - 3, z1 + 1, x1, down - 3, z1 + 1, 0x7a746c);
  // parapets straddling the long edges, coping on top, pillars at the corners and the canal edges
  for (const [za, zb] of [[z0 - 1, z0], [z1, z1 + 1]]) {
    g.box(x0, down, za, x1, down + 5, zb, face);
    g.box(x0, down + 6, za, x1, down + 6, zb, (x, y, z) => shade(0x8a847a, 0.9 + h3(x, y, z) * 0.12));
  }
  const halos: PropModel['halos'] = [];
  const lamps: PropLamp[] = [];
  const pillarsX = [x0 + 1, ca, cb, x1 - 1];
  for (const px of pillarsX)
    for (const pz of [z0, z1]) {
      g.box(px - 2, down, pz - 2, px + 2, down + 9, pz + 2, face);
      g.box(px - 2, down + 10, pz - 2, px + 2, down + 10, pz + 2, 0x8a847a);
      if (px === ca || px === cb) {
        // a little iron lamp on the canal-edge pillars
        g.on(CH.metal, () => g.box(px, down + 11, pz, px, down + 12, pz, 0x2a2c30));
        const c = lanternCage(g, px, down + 13, pz, 1, 3, 0xffc070);
        halos.push({ pos: [(c[0] - (M + nxD / 2)) * V, (c[1] - down) * V, (c[2] - (z0 + nzD / 2)) * V], color: 0xffa040, size: 2.0, opacity: 0.4 });
        lamps.push(lampAt(c, [M + nxD / 2, down, z0 + nzD / 2], V, 'small'));
      }
    }
  // grime: moss in the joints above the waterline, wet streaks down the faces
  g.recolor((c, x, y, z) => {
    if (y >= down - 3) return c;
    if (y > wy && y < wy + 6 && h3(x, y, z, 31) < 0.12) return mix(c, 0x3e5a2e, 0.6);
    if (vn3(x * 0.4, y * 0.05, z * 0.4, s.seed + 5) > 0.68) return shade(c, 0.8);
    return c;
  });
  const model = toModel(
    g,
    V,
    { [CH.base]: mats.stone(false), [CH.wet]: mats.stone(true), [CH.metal]: mats.iron(), [CH.glow]: mats.lamp() },
    { pivot: [M + nxD / 2, down, z0 + nzD / 2], ao: 0.5 },
  );
  model.halos = halos;
  model.lamps = lamps;
  (model as Sized).fit = [nxD * V, nzD * V];
  return model;
}

// ---------------------------------------------------------------------------------------------
// Ice floe (Aurora Harbour): a glowing blue slab with a snow cap and icicles
// ---------------------------------------------------------------------------------------------

function floe(s: Spec): PropModel {
  const V = 0.08;
  const M = 6;
  const nxD = Math.max(6, Math.round(s.w / V));
  const nzD = Math.max(6, Math.round(s.d / V));
  const down = Math.ceil((s.bedDrop + 0.2) / V);
  const g = new PGrid(nxD + M * 2, down + 6, nzD + M * 2);
  const x0 = M;
  const x1 = M + nxD - 1;
  const z0 = M;
  const z1 = M + nzD - 1;
  const wy = Math.round(down - s.wetDrop / V);
  const yBed = Math.max(0, Math.round(down - s.bedDrop / V) - 2);
  const cx = M + nxD / 2;
  const cz = M + nzD / 2;
  const iceAt = (x: number, y: number, z: number): number => {
    const col = h3(x, 0, z, s.seed) * 0.5 + vn3(x * 0.3, 0, z * 0.3, s.seed) * 0.5; // vertical striations
    const depth = (down - y) / Math.max(1, down - yBed);
    const top = mix(0xdaf2ff, 0xa8dcf8, col);
    const deep = mix(0x4a9ad0, 0x2a6aa8, col);
    return mix(top, deep, Math.min(1, depth * 1.3));
  };
  // body: tapers inward toward the bed, with a lumpy lip just under the cap
  for (let y = yBed; y <= down - 3; y++) {
    const dd = down - 3 - y;
    for (let z = 0; z < g.nz; z++)
      for (let x = 0; x < g.nx; x++) {
        const ex = Math.max(x0 - x, x - x1, 0);
        const ez = Math.max(z0 - z, z - z1, 0);
        const inX = Math.min(x - x0, x1 - x);
        const inZ = Math.min(z - z0, z1 - z);
        const inside = Math.min(inX, inZ);
        const n0 = vn3(x * 0.22, y * 0.12, z * 0.22, s.seed + 3);
        let ok: boolean;
        if (dd < 4) ok = Math.max(ex, ez) <= (n0 > 0.55 ? 1 : 0) || inside >= 0; // lip: up to 1 voxel proud
        else ok = inside >= dd * 0.16 + (n0 - 0.5) * 3;
        if (!ok) continue;
        const ch = dd >= 1 && dd <= 3 && inside <= 1 ? CH.glow2 : CH.ice;
        g.on(ch, () => g.set(x, y, z, ch === CH.glow2 ? mix(0x8ff0ff, 0xcff8ff, h3(x, y, z)) : iceAt(x, y, z)));
      }
  }
  // snow cap: exactly the walkable rectangle, 3 voxels thick; the outer band of the top is bare blue ice
  for (let y = down - 3; y <= down - 1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const rim = Math.min(x - x0, x1 - x, z - z0, z1 - z);
        const band = rim < 2 + (vn3(x * 0.3, 0, z * 0.3, s.seed + 4) > 0.6 ? 1 : 0);
        if (y === down - 1 && band) {
          g.on(CH.ice, () => g.set(x, y, z, mix(0xbfe8fb, 0x8fd0f2, h3(x, y, z, s.seed))));
          continue;
        }
        let c = snowCol(x, y, z);
        if (rim === 0 && y < down - 1) c = mix(c, 0x9fd0f0, 0.5);
        if (y === down - 1 && vn3(x * 0.2, 0, z * 0.2, s.seed + 8) > 0.66) c = mix(c, 0xcfe6ff, 0.5);
        g.set(x, y, z, c);
      }
  // pressure ridges: jagged glowing ice blocks heaped just outside the walkable rectangle
  const rnd = rngFor(s.seed * 17 + 5);
  for (let z = z0 - 2; z <= z1 + 2; z++)
    for (let x = x0 - 2; x <= x1 + 2; x++) {
      const ex = Math.max(x0 - x, x - x1, 0);
      const ez = Math.max(z0 - z, z - z1, 0);
      const out = Math.max(ex, ez);
      if (out < 1) continue;
      const n0 = vn3(x * 0.22, 0, z * 0.22, s.seed + 13);
      const hgt = Math.round((out === 1 ? 1 : 0) + n0 * 3.4 - 0.6 - (out - 1) * 1.2);
      for (let y = down - 4; y < down + hgt; y++) {
        const glow = y < down - 1 && h3(x, y, z, s.seed + 2) < 0.55;
        g.on(glow ? CH.glow2 : CH.ice, () => g.set(x, y, z, glow ? mix(0x8ff0ff, 0xcff8ff, h3(x, y, z)) : y === down + hgt - 1 && h3(x, 1, z) < 0.5 ? 0xf2f9ff : mix(0xd8f2ff, 0x9fd6f4, n0)));
      }
    }
  // icicles off the ridges
  g.on(CH.ice, () => {
    for (let k = 0; k < 26; k++) {
      const side = Math.floor(rnd() * 4);
      const t = rnd();
      const x = side < 2 ? Math.round(x0 + t * nxD) : side === 2 ? x0 - 2 : x1 + 2;
      const z = side >= 2 ? Math.round(z0 + t * nzD) : side === 0 ? z0 - 2 : z1 + 2;
      const len = 2 + Math.floor(rnd() * 6);
      for (let j = 0; j < len; j++) g.set(x, down - 5 - j, z, j === len - 1 ? 0xf0fbff : 0xbfe8fb);
    }
  });
  void cx;
  void cz;
  const model = toModel(
    g,
    V,
    { [CH.base]: pmat({ rough: 0.72 }), [CH.ice]: mats.ice(), [CH.glow2]: pmat({ glow: 1.7, pulse: 0.25, rough: 0.2, rim: 0.4, rimColor: 0x9fe6ff }) },
    { pivot: [M + nxD / 2, down, M + nzD / 2], ao: 0.4, noShadowCh: [CH.glow2] },
  );
  (model as Sized).fit = [nxD * V, nzD * V];
  return model;
}

// ---------------------------------------------------------------------------------------------
// Raft deck: lashed logs moored on poles
// ---------------------------------------------------------------------------------------------

function raftDeck(s: Spec): PropModel {
  const V = 0.08;
  const M = 4;
  const nxD = Math.max(6, Math.round(s.w / V));
  const nzD = Math.max(6, Math.round(s.d / V));
  const down = Math.ceil((s.bedDrop + 0.3) / V);
  const g = new PGrid(nxD + M * 2, down + 14, nzD + M * 2);
  const x0 = M;
  const x1 = M + nxD - 1;
  const z0 = M;
  const z1 = M + nzD - 1;
  const bark = blotch([0x5a4430, 0x664e36, 0x725a3e, 0x4e3a2a], 0.25, s.seed, 0.2);
  const logs = Math.max(2, Math.floor(nzD / 4));
  const lw = nzD / logs;
  for (let k = 0; k < logs; k++) {
    const zc = z0 + lw * (k + 0.5);
    const r = lw / 2;
    for (let x = x0 - (k % 2); x <= x1 + ((k + 1) % 2); x++)
      for (let y = down - 5; y <= down - 1; y++)
        for (let z = Math.floor(zc - r); z <= Math.ceil(zc + r); z++) {
          const dy = (y + 0.5 - (down - 1.5)) / 2.6;
          const dz = (z + 0.5 - zc) / r;
          if (dy * dy + dz * dz > 1.15 || z < z0 - 1 || z > z1 + 1) continue;
          const endGrain = x === x0 - (k % 2) || x === x1 + ((k + 1) % 2);
          g.set(x, y, z, endGrain ? (Math.hypot(dy, dz) < 0.5 ? 0xc8a070 : 0xa8804e) : y === down - 1 ? shade(bark(x, y, z), 1.15) : bark(x, y, z));
        }
  }
  for (const lx of [x0 + 3, Math.round((x0 + x1) / 2), x1 - 3]) g.box(lx, down - 6, z0 - 1, lx + 1, down - 1, z1 + 1, ropeCol);
  for (const [px, pz] of [[x0 - 2, z0 - 2], [x1 + 2, z1 + 2]]) post(g, px + 0.5, pz + 0.5, 1.6, 0, down + 8, grain(WOOD[s.theme], s.seed, 1));
  const model = toModel(g, V, { [CH.base]: mats.wood(s.theme) }, { pivot: [M + nxD / 2, down, M + nzD / 2], ao: 0.5 });
  (model as Sized).fit = [nxD * V, nzD * V];
  return model;
}

// ---------------------------------------------------------------------------------------------

/** A model plus the exact size its voxel deck covers, so placement can stretch it to p.w by p.d. */
type Sized = PropModel & { fit?: [number, number] };

function specOf(p: Platform, map: MapDef): Spec {
  const deck = platformDeckY(map, p);
  const cs = Math.cos(p.rot);
  const sn = Math.sin(p.rot);
  const world = (lx: number): [number, number] => [p.x + lx * cs, p.z - lx * sn];
  const landAt = (lx: number): boolean => {
    const [x, z] = world(lx);
    return waterDepthAt(map, x, z) < -0.25;
  };
  let a = Infinity;
  let b = -Infinity;
  for (let lx = -p.w / 2; lx <= p.w / 2 + 1e-6; lx += 0.1) {
    const [x, z] = world(lx);
    if (waterDepthAt(map, x, z) > 0) {
      a = Math.min(a, lx);
      b = Math.max(b, lx);
    }
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    kind: p.kind,
    w: p.w,
    d: p.d,
    seed: p.seed ?? 1,
    theme: themeOf(map),
    bedDrop: r1(deck - bedY(map)),
    wetDrop: Math.round((deck - waterY(map, 1)) * 100) / 100,
    land: [landAt(-p.w / 2 + 0.15), landAt(p.w / 2 - 0.15)],
    wet: a <= b ? [r1(a), r1(b)] : null,
    ...(dressingOn(map) ? { dress: true as const } : {}),
  };
}

function modelFor(s: Spec): Sized {
  switch (s.kind) {
    case 'floe':
      return floe(s);
    case 'raftdeck':
      return raftDeck(s);
    case 'bridge':
      return s.theme === 'wharf' ? stoneBridge(s) : woodDeck(s);
    case 'pier':
    case 'dock':
    default:
      return woodDeck(s);
  }
}

interface MergedPart {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  shadow: boolean;
}
interface Built {
  parts: MergedPart[];
  halo: THREE.BufferGeometry | null;
  /** lamp flames in world space (Epic lantern lights) */
  lamps: LampItem[];
}

const builtCache = new Map<string, Built>();
const specCache = new Map<string, Sized>();

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/** Merge geometries (position, normal, colour, index) into one, each with its own matrix. */
function merge(items: { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[]): THREE.BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const it of items) {
    nv += it.geo.attributes.position.count;
    ni += it.geo.index ? it.geo.index.count : it.geo.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const it of items) {
    const P = it.geo.attributes.position as THREE.BufferAttribute;
    const N = it.geo.attributes.normal as THREE.BufferAttribute;
    const C = it.geo.attributes.color as THREE.BufferAttribute;
    _nm.getNormalMatrix(it.m);
    for (let i = 0; i < P.count; i++) {
      _v.fromBufferAttribute(P, i).applyMatrix4(it.m);
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize();
      const o = (vo + i) * 3;
      pos[o] = _v.x;
      pos[o + 1] = _v.y;
      pos[o + 2] = _v.z;
      nrm[o] = _n.x;
      nrm[o + 1] = _n.y;
      nrm[o + 2] = _n.z;
      col[o] = C.getX(i);
      col[o + 1] = C.getY(i);
      col[o + 2] = C.getZ(i);
    }
    if (it.geo.index) {
      const I = it.geo.index.array;
      for (let i = 0; i < I.length; i++) idx[io + i] = I[i] + vo;
      io += I.length;
    } else {
      for (let i = 0; i < P.count; i++) idx[io + i] = vo + i;
      io += P.count;
    }
    vo += P.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** The cached deck model for a platform (Epic models are kept apart: their spec carries `dress`, their key '|E'). */
function deckModel(p: Platform, map: MapDef): Sized {
  const s = specOf(p, map);
  const key = JSON.stringify(s) + (cinematicEnabled() ? '|E' : '');
  let model = specCache.get(key);
  if (!model) {
    model = modelFor(s);
    specCache.set(key, model);
  }
  return model;
}

/** World placement of a deck model: deck top at platformDeckY, stretched to exactly p.w by p.d. */
function deckMatrix(p: Platform, map: MapDef, model: Sized): THREE.Matrix4 {
  const fit = model.fit ?? [p.w, p.d];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(p.x, platformDeckY(map, p), p.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot),
    new THREE.Vector3(p.w / fit[0], 1, p.d / fit[1]),
  );
}

function buildAll(platforms: Platform[], map: MapDef): Built {
  const mood = moodOf(map.atmosphere);
  // bucket by river side (so each half culls on its own) and material
  const buckets = new Map<string, { mat: THREE.Material; shadow: boolean; items: { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[] }>();
  const halos: HaloItem[] = [];
  const lamps: LampItem[] = [];
  for (const p of platforms) {
    const model = deckModel(p, map);
    const m = deckMatrix(p, map, model);
    // bucket by quadrant so each part of the map culls on its own (the camera sees about two at a time)
    const side = (p.x < 0 ? 'w' : 'e') + (p.z < 0 ? 'n' : 's');
    for (const part of model.parts) {
      const mat = moodVariant(part.mat, mood);
      const k = side + '|' + mat.uuid + '|' + part.shadow;
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = { mat, shadow: part.shadow, items: [] }));
      b.items.push({ geo: part.geo, m });
    }
    if (model.halos)
      for (const h of model.halos) {
        _v.set(h.pos[0], h.pos[1], h.pos[2]).applyMatrix4(m);
        halos.push({ x: _v.x, y: _v.y, z: _v.z, color: h.color, size: h.size, opacity: h.opacity });
      }
    if (model.lamps)
      for (const l of model.lamps) {
        _v.set(l.pos[0], l.pos[1], l.pos[2]).applyMatrix4(m);
        lamps.push({ x: _v.x, y: _v.y, z: _v.z, color: l.color, intensity: l.intensity, range: l.range });
      }
  }
  const parts: MergedPart[] = [];
  for (const b of buckets.values()) {
    const geo = merge(b.items);
    // normal tiers only (Epic decks are batched): a mid-match Epic switch gives it the neutral voxel size
    trackOffGeometry(geo);
    parts.push({ geo, mat: b.mat, shadow: b.shadow });
  }
  return { parts, halo: halos.length ? haloGeometry(halos) : null, lamps };
}

/**
 * Epic decks: one BatchedMesh per material with a matrix per deck (culled per deck), plus the deck dressing.
 * The voxel look reads each deck's own voxel lattice; the merged geometry of the normal tiers bakes the
 * deck's rotation and fit scale into world-space vertices, which would put the lattice off the voxels.
 */
function buildEpic(platforms: Platform[], map: MapDef, shadows: boolean): { objs: THREE.Object3D[]; lamps: LampItem[] } {
  const batch = new StaticBatch(moodOf(map.atmosphere), true);
  for (const p of platforms) {
    const model = deckModel(p, map);
    batch.add(model, deckMatrix(p, map, model), shadows);
  }
  const tmp = new THREE.Group();
  batch.build(tmp, 'platform');
  const lamps = (tmp.userData.hwLamps as LampItem[] | undefined) ?? [];
  return { objs: [...tmp.children], lamps };
}

/** Epic deck batches per map (bounded by map content, like builtCache; disposeBatchGroup skips them). */
const epicCache = new Map<string, { objs: THREE.Object3D[]; lamps: LampItem[] }>();

function inScene(o: THREE.Object3D): boolean {
  let p = o;
  while (p.parent) p = p.parent;
  return (p as THREE.Scene).isScene === true;
}

function epicDecks(platforms: Platform[], map: MapDef, shadows: boolean, key: string, group: THREE.Group): void {
  let hit = epicCache.get(key);
  // the cached batches are in use by another live view (showcase and match at once): build a private set
  const shared = !!hit && hit.objs.some((o) => o.parent !== null && inScene(o));
  if (!hit || shared) {
    const built = buildEpic(platforms, map, shadows);
    if (!shared) {
      for (const o of built.objs) o.userData.hwCached = true;
      epicCache.set(key, built);
    }
    hit = built;
  }
  for (const o of hit.objs) group.add(o);
  if (hit.lamps.length) addLamps(group, hit.lamps);
}

/**
 * Walkable decks for one map. World-space group; deck tops at platformDeckY(map, p).
 * Cached per map content: the returned group needs no disposal (disposePropGroup on it is harmless).
 */
export function buildPlatformsImpl(platforms: Platform[], map: MapDef, quality?: Quality): THREE.Group {
  const t0 = performance.now();
  const q = propsQuality(quality);
  const shadows = qLevel(q) >= 1;
  const group = new THREE.Group();
  group.name = 'platforms';
  if (!platforms.length) return group;
  const key = map.id + '|' + JSON.stringify(platforms) + '|' + map.terrain.baseHeight + '|' + map.river.depth;
  if (cinematicEnabled()) {
    epicDecks(platforms, map, shadows, key + '|' + shadows, group);
    return group;
  }
  let built = builtCache.get(key);
  if (!built) {
    built = buildAll(platforms, map);
    builtCache.set(key, built);
  }
  for (const p of built.parts) {
    const mesh = new THREE.Mesh(p.geo, p.mat);
    mesh.castShadow = shadows && p.shadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'platform';
    group.add(mesh);
  }
  if (built.halo) group.add(haloMeshOf(built.halo, false));
  if (built.lamps.length) addLamps(group, built.lamps);
  const ms = performance.now() - t0;
  if (ms > 50) console.info(`[props] buildPlatforms ${platforms.length} decks in ${ms.toFixed(0)} ms`);
  return group;
}
