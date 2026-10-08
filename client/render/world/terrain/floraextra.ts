// Backdrop set pieces for the four reference maps (Mirelight Marsh, Aurora Harbour, Maelstrom Lagoon,
// Lantern Wharf): giant mossy cypress, stilt huts, cattails, flowering lily pads, glowing ice floes,
// snowy log cabins, timber cranes and piers, sea stacks, coral, a shipwreck, a lighthouse, tall ships,
// cargo barges and a stone arched bridge. Built through the same voxel builder and batching as
// flora.ts. Voxel colours tagged with glow() light up (lit windows, lanterns, the lighthouse lamp).
// Tone rule: rust, grime, paint and weathering only. Nothing red reads as stains.
import type { Rng } from '../../../../shared/math.ts';
import { hashVox, mix, shade } from '../../voxel/voxel.ts';
import { VB, sp, type ModelDef } from './vb.ts';
import { GLOW } from './vmesh.ts';

export type ExtraKind =
  | 'giantcypress' | 'stilthut' | 'cattails' | 'lilyflowers' | 'swampstump' | 'lanternpole' | 'dockruin'
  | 'floeblock' | 'cabin' | 'snowcrane' | 'piersnow' | 'snowrock'
  | 'seastackbig' | 'coral' | 'wreck' | 'pierwood'
  | 'lighthouse' | 'ship' | 'cargobarge' | 'archbridge' | 'timbercrane' | 'gaslamp2';

/** Colour with a glow level (1..15, 4 = full). Apply after any shading: shade() and mix() drop it. */
export function glow(c: number, level: number): number {
  return (c & 0xffffff) | (GLOW * level);
}
const glowing = (c: number) => c >= GLOW;

const TAU = Math.PI * 2;
const CYP_BARK = [0x5e4030, 0x6a4a36, 0x4e3628, 0x735440, 0x553a2c];
const CYP_LEAF = [0x4a6a2a, 0x567a30, 0x415e26, 0x628638, 0x3c5622, 0x6e9040];
const MOSS_HANG = [0xb4c088, 0xc4cc98, 0xa4b278, 0xd2d6a8, 0x98a872];
const PLANK = [0x7a5a3c, 0x6a4c32, 0x86643f, 0x5e4430];
const PLANK_WET = [0x5a4430, 0x4e3a28, 0x664c34, 0x463424];
const PLANK_SNOW = [0x6e5238, 0x5e4430, 0x7a5c3e, 0x543c2a];
const SHINGLE = [0x4a3a2c, 0x3e3024, 0x564434, 0x34281e];
const ROOF_SLATE = [0x3a3e48, 0x444955, 0x32363f, 0x4a4e58];
const SNOW = [0xf2f6fb, 0xe6eef6, 0xfafcfe, 0xdfe8f2];
const ICE_BLUE = [0x9ed8f2, 0x86c8ea, 0xb6e4f6, 0x74bce4];
const ICE_DEEP = [0x4aa6d8, 0x3a94cc, 0x5cb6e2];
const ROCK_GREY = [0x7a7670, 0x6a6660, 0x8a8680, 0x5e5a54, 0x726e66];
const ROCK_DARK = [0x55524e, 0x4a4744, 0x605c58];
const VINE = [0x3f7a2e, 0x4c8a36, 0x356a26, 0x5a9a40];
const PALM_BARK = [0x8a6a44, 0x7a5c3a, 0x9a7a52, 0x6e5232];
const PALM_LEAF = [0x3f8a2e, 0x4c9a36, 0x5aaa40, 0x357a28, 0x2f6e24];
const CORAL = [[0xe8607a, 0xf07a90, 0xd84c68], [0xf2903a, 0xf8a850, 0xe07a2a], [0xa860d0, 0xb878e0, 0x9050c0], [0xf4d04a, 0xf8e070, 0xe0b830]];
const HULL = [0x4a3424, 0x3e2c1e, 0x56402c, 0x34261a];
const SAIL = [0xd8ccb0, 0xccc0a4, 0xe2d8c0, 0xbfb498];
const BRICK = [0x7a3b2a, 0x6e3424, 0x84422e, 0x733826, 0x8c4a32];
const STONE = [0x6e6a64, 0x625e58, 0x7a766e, 0x58544e, 0x84807a];
const IRON = [0x34363a, 0x3e4044, 0x2c2e32];
const RUSTY = [0x6a4a36, 0x7a5236, 0x5a3e2e];
const LAMP = 0xffc070;
const WINDOW = 0xffb458;

/** Small palm at (x, z) standing on y0 (metres, builder space). */
function palmAt(b: VB, r: Rng, x: number, z: number, y0: number, s: number): void {
  const h = r.range(2.6, 3.6) * s;
  const bend = r.range(0.3, 0.8) * s;
  const a0 = r.range(0, TAU);
  const pts: number[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    pts.push(x + Math.cos(a0) * bend * t * t, y0 + h * t, z + Math.sin(a0) * bend * t * t);
  }
  b.trunk(pts, 0.17 * s, 0.11 * s, (xx, y, zz) => (y % 3 === 0 ? shade(PALM_BARK[3], 0.9) : sp(PALM_BARK, 2)(xx, y, zz)));
  const tx = x + Math.cos(a0) * bend;
  const tz = z + Math.sin(a0) * bend;
  const ty = y0 + h;
  const fr = r.int(6, 8);
  for (let i = 0; i < fr; i++) {
    const a = (i / fr) * TAU + r.range(-0.2, 0.2);
    const l = r.range(1.3, 1.8) * s;
    const leaf = sp(PALM_LEAF, 3 + i, 0.08);
    const mx = tx + Math.cos(a) * l * 0.5;
    const mz = tz + Math.sin(a) * l * 0.5;
    b.line(tx, ty, tz, mx, ty + 0.3 * s, mz, 0.09, leaf);
    b.line(mx, ty + 0.3 * s, mz, tx + Math.cos(a) * l, ty - r.range(0.4, 0.8) * s, tz + Math.sin(a) * l, 0.07, leaf);
  }
}

/** Hanging lantern: iron frame and cap, glowing core. (x, y, z) is the bottom. */
function lanternAt(b: VB, x: number, y: number, z: number, s = 1): void {
  const w = 0.16 * s;
  b.box(x - w, y, z - w, x + w, y + 0.06 * s, z + w, IRON[0]);
  b.box(x - w * 0.8, y + 0.06 * s, z - w * 0.8, x + w * 0.8, y + 0.34 * s, z + w * 0.8, glow(LAMP, 6));
  b.box(x - w, y + 0.34 * s, z - w, x + w, y + 0.42 * s, z + w, IRON[1]);
}

/** Timber crane: two posts, a brace, a boom out over +x with a rope, a hook and a hanging load. */
function crane(b: VB, r: Rng, snow: boolean): void {
  const wood = sp(snow ? PLANK_SNOW : PLANK_WET, 1, 0.08);
  const h = r.range(5.6, 6.6);
  b.box(-1.1, 0, -0.55, -0.6, h, -0.1, wood);
  b.box(-1.1, 0, 0.1, -0.6, h, 0.55, wood);
  b.box(-1.25, 0, -0.75, -0.45, 0.5, 0.75, sp(STONE, 2, 0.06)); // footing
  b.box(-1.2, h, -0.6, 3.4, h + 0.45, 0.6, wood); // boom
  b.line(-0.85, h * 0.45, 0, 1.4, h - 0.05, 0, 0.16, wood); // brace
  for (let y = 0.9; y < h - 0.6; y += 1.3) b.box(-1.1, y, -0.55, -0.6, y + 0.12, 0.55, wood);
  // rope and iron ring wraps
  b.box(-1.15, h * 0.62, -0.6, -0.55, h * 0.62 + 0.14, 0.6, IRON[0]);
  const hookY = r.range(1.6, 2.8);
  b.line(3.0, h, 0, 3.0, hookY + 0.6, 0, 0, sp([0x9a8a6a, 0x8a7a5a], 3));
  if (r.chance(0.5)) {
    // a cargo crate swinging off the hook
    b.box(2.55, hookY - 0.3, -0.45, 3.45, hookY + 0.55, 0.45, (x, y, z) => (y % 3 === 0 ? shade(PLANK[3], 0.8) : sp(PLANK, 4)(x, y, z)));
    b.line(3.0, hookY + 0.6, 0, 2.6, hookY + 0.55, -0.4, 0, IRON[1]);
    b.line(3.0, hookY + 0.6, 0, 3.4, hookY + 0.55, 0.4, 0, IRON[1]);
  } else {
    b.box(2.9, hookY + 0.35, -0.08, 3.1, hookY + 0.6, 0.08, IRON[1]);
    b.line(3.0, hookY + 0.35, 0, 3.2, hookY, 0, 0, IRON[2]);
    b.line(3.2, hookY, 0, 3.05, hookY - 0.12, 0, 0, IRON[2]);
  }
  lanternAt(b, 1.9, h - 0.75, 0, 1.1);
  b.line(1.9, h, 0, 1.9, h - 0.33, 0, 0, IRON[0]);
  if (snow) b.caps((c, x, y, z) => (glowing(c) ? c : hashVox(x, y, z, 7) < 0.85 ? sp(SNOW, 8, 0.03)(x, y, z) : c));
}

/** Timber pier on piles with a rope rail and a lantern post at the end. Deck top 1.0 m above the base. */
function pier(b: VB, r: Rng, snow: boolean): void {
  const deck = sp(snow ? PLANK_SNOW : PLANK, 1, 0.08);
  const post = sp(snow ? PLANK_SNOW : PLANK_WET, 2, 0.06);
  const len = r.range(4.2, 5.4);
  const y = 1.0;
  for (let x = -len / 2; x <= len / 2 + 0.01; x += 1.4) {
    b.cyl(x, -0.75, 0.13, 0, y + 0.55, post);
    b.cyl(x, 0.75, 0.13, 0, y + 0.55, post);
    b.box(x - 0.14, y + 0.5, -0.9, x + 0.14, y + 0.6, -0.6, sp([0x9a8a6a, 0x8a7a5a], 4)); // rope wraps
  }
  b.box(-len / 2 - 0.1, y - 0.14, -0.85, len / 2 + 0.1, y, 0.85, (x, yy, z) => (x % 3 === 0 ? shade(PLANK[3], 0.78) : deck(x, yy, z)));
  b.line(-len / 2, y + 0.42, 0.75, len / 2, y + 0.42, 0.75, 0, sp([0xa8966e, 0x96845e], 5)); // rope rail
  b.line(-len / 2, y + 0.42, -0.75, len / 2, y + 0.42, -0.75, 0, sp([0xa8966e, 0x96845e], 5));
  b.cyl(len / 2, 0.75, 0.09, y, y + 1.7, post);
  b.box(len / 2 - 0.05, y + 1.6, 0.75, len / 2 + 0.35, y + 1.7, 0.85, post);
  lanternAt(b, len / 2 + 0.3, y + 1.15, 0.8, 0.9);
  if (r.chance(0.6)) b.box(-0.6, y, -0.5, 0.2, y + 0.75, 0.3, (x, yy, z) => (yy % 3 === 0 ? shade(PLANK[3], 0.8) : sp(PLANK, 6)(x, yy, z)));
  if (snow) b.caps((c, x, yy, z) => (glowing(c) ? c : hashVox(x, yy, z, 7) < 0.8 ? sp(SNOW, 8, 0.03)(x, yy, z) : c));
}

export const EXTRA_MODELS: Record<ExtraKind, ModelDef> = {
  // ------------------------------------------------------------------ Mirelight Marsh
  giantcypress: {
    size: [11, 15, 11], vox: [0.3, 0.45], mat: 'leaf', sway: 0.35,
    build(b, r) {
      const bark = sp(CYP_BARK, 1, 0.1);
      const h = r.range(8.4, 10.2);
      const lean = r.range(-0.3, 0.3);
      // flared buttress base with root flanges and knees
      for (let y = 0; y < 2.6; y += 1 / b.v) {
        const t = y / 2.6;
        b.cyl(lean * t * 0.15, 0, 1.6 - t * t * 0.8, y, y + 1 / b.v, bark);
      }
      const fl = r.int(5, 7);
      for (let k = 0; k < fl; k++) {
        const a = (k / fl) * TAU + r.range(-0.3, 0.3);
        const d = r.range(1.9, 2.8);
        b.line(0, 1.7, 0, Math.cos(a) * d, 0, Math.sin(a) * d, 0.3, bark);
      }
      for (let k = 0; k < 5; k++) {
        const a = r.range(0, TAU);
        const d = r.range(2.4, 3.8);
        b.cyl(Math.cos(a) * d, Math.sin(a) * d, 0.18, 0, r.range(0.35, 0.9), bark);
      }
      b.trunk([0, 2.4, 0, lean * 0.5, h * 0.6, 0.1, lean, h, -0.1], 0.85, 0.5, bark);
      // limbs ending in flat umbrella pads
      const pads: number[][] = [];
      const limbs = r.int(4, 6);
      for (let i = 0; i < limbs; i++) {
        const a = (i / limbs) * TAU + r.range(-0.35, 0.35);
        const y0 = h * r.range(0.6, 0.9);
        const len = r.range(2.0, 3.1);
        const ex = lean + Math.cos(a) * len;
        const ez = Math.sin(a) * len;
        const ey = y0 + r.range(0.9, 1.7);
        b.line(lean * (y0 / h), y0, 0, ex, ey, ez, 0.24, bark);
        pads.push([ex, ey + 0.3, ez, r.range(1.5, 2.2)]);
      }
      pads.push([lean, h + 0.7, 0, r.range(2.0, 2.4)]);
      pads.forEach(([px, py, pz, rad], i) => {
        const leaf = sp(CYP_LEAF, 3 + i, 0.1);
        // flat layered pads: the cypress umbrella
        b.ell(px, py, pz, rad, rad * 0.2, rad * 0.95, leaf);
        b.ell(px + r.range(-0.5, 0.5), py + rad * 0.3, pz + r.range(-0.5, 0.5), rad * 0.6, rad * 0.16, rad * 0.6, leaf);
        // Spanish moss hanging from under the pad
        const n = r.int(7, 11);
        for (let s = 0; s < n; s++) {
          const a = r.range(0, TAU);
          const d = r.range(0.3, rad * 0.92);
          const sx = px + Math.cos(a) * d;
          const sz = pz + Math.sin(a) * d;
          b.line(sx, py - 0.2, sz, sx + r.range(-0.15, 0.15), py - r.range(1.3, 3.6), sz + r.range(-0.15, 0.15), 0, sp(MOSS_HANG, 9 + (s & 3)));
        }
      });
      // sunset-lit tops
      b.caps((c, x, y, z) => (y > b.g.ny * 0.5 && hashVox(x, y, z, 11) < 0.6 ? mix(shade(c, 1.22), 0x9a8a3a, 0.12) : c));
    },
  },
  stilthut: {
    size: [5.4, 6.4, 5.4], vox: [0.13, 0.26], mat: 'leaf', sway: 0,
    build(b, r) {
      const post = sp(PLANK_WET, 2, 0.06);
      const board = sp(PLANK, 1, 0.07);
      const deckY = r.range(1.5, 1.9);
      for (const sx of [-1.75, 0, 1.75]) for (const sz of [-1.45, 1.45]) b.cyl(sx, sz, 0.12, 0, deckY, post);
      b.line(-1.75, 0.3, 1.45, 0, deckY - 0.1, 1.45, 0.06, post);
      b.line(1.75, 0.3, 1.45, 0, deckY - 0.1, 1.45, 0.06, post);
      b.line(-1.75, 0.3, -1.45, -1.75, deckY - 0.1, 1.45, 0.06, post);
      b.box(-2.15, deckY, -1.85, 2.15, deckY + 0.14, 1.85, (x, y, z) => (x % 3 === 0 ? shade(PLANK[3], 0.78) : board(x, y, z)));
      const y0 = deckY + 0.14;
      const y1 = y0 + r.range(1.9, 2.2);
      b.box(-1.5, y0, -1.2, 1.5, y1, 1.2, (x, y, z) => ((x + z) % 4 === 0 ? shade(PLANK[3], 0.72) : board(x, y, z)));
      // door, lit windows, porch rail
      b.box(-0.35, y0, 1.18, 0.35, y0 + 1.5, 1.3, 0x2a1c12);
      b.box(0.55, y0 + 0.8, 1.18, 1.1, y0 + 1.3, 1.28, glow(WINDOW, 3));
      b.box(1.48, y0 + 0.8, -0.5, 1.58, y0 + 1.3, 0.2, glow(WINDOW, 3));
      b.box(-1.58, y0 + 0.8, -0.3, -1.48, y0 + 1.3, 0.3, r.chance(0.5) ? glow(WINDOW, 2) : 0x1e2228);
      b.box(-2.1, y0, 1.75, 2.1, y0 + 0.08, 1.85, post);
      for (let x = -2.0; x <= 2.01; x += 1.0) b.box(x - 0.05, y0, 1.75, x + 0.05, y0 + 0.7, 1.85, post);
      b.box(-2.1, y0 + 0.62, 1.75, 2.1, y0 + 0.72, 1.85, post);
      // gable roof along x with mossy shingles
      const shingle = sp(SHINGLE, 4, 0.08);
      for (let y = y1, k = 0; ; y += 1 / b.v, k++) {
        const hw = 1.65 - (y - y1) * 1.05;
        if (hw < 0.1) break;
        b.box(-1.9, y, -hw, 1.9, y + 1 / b.v, hw, (x, yy, z) => (hashVox(x, yy, z, 5) < 0.14 ? sp([0x4a6a2a, 0x557632], 6)(x, yy, z) : shingle(x, yy, z)));
        void k;
      }
      // stovepipe and the porch lantern
      b.box(0.8, y1 + 0.6, -0.4, 1.05, y1 + 1.8, -0.15, IRON[1]);
      b.line(1.9, y0 + 1.95, 1.8, 1.9, y0 + 1.6, 1.8, 0, IRON[0]);
      lanternAt(b, 1.9, y0 + 1.2, 1.8, 1.0);
      // ladder down to the water
      b.box(-0.5, 0, 1.95, -0.42, deckY, 2.03, post);
      b.box(0.02, 0, 1.95, 0.1, deckY, 2.03, post);
      for (let y = 0.2; y < deckY; y += 0.32) b.box(-0.5, y, 1.95, 0.1, y + 0.06, 2.03, post);
    },
  },
  cattails: {
    size: [1.5, 2.4, 1.5], vox: [0.06, 0.2], mat: 'leaf', sway: 1.1,
    build(b, r) {
      const n = r.int(9, 15);
      for (let i = 0; i < n; i++) {
        const x = r.range(-0.55, 0.55);
        const z = r.range(-0.55, 0.55);
        const h = r.range(1.1, 2.1);
        const tx = x + r.range(-0.12, 0.12);
        const tz = z + r.range(-0.12, 0.12);
        b.line(x, 0, z, tx, h, tz, 0, sp([0x6a7f36, 0x5f7430, 0x748a3e, 0x82944a], 1 + (i & 3)));
        if (r.chance(0.7)) b.cyl(tx, tz, 0.065, h - 0.42, h - 0.08, sp([0x6a4426, 0x5a3820, 0x7a5030], 6));
        if (r.chance(0.5)) {
          const a = r.range(0, TAU);
          b.line(x, 0.1, z, x + Math.cos(a) * 0.5, h * 0.75, z + Math.sin(a) * 0.5, 0, sp([0x7a8a3e, 0x8a9a4a], 7));
        }
      }
    },
  },
  lilyflowers: {
    size: [2.8, 0.36, 2.8], vox: [0.06, 0.12], mat: 'leaf', sway: 0,
    build(b, r) {
      const n = r.int(4, 7);
      for (let i = 0; i < n; i++) {
        const x = r.range(-0.95, 0.95);
        const z = r.range(-0.95, 0.95);
        const rad = r.range(0.2, 0.42);
        const notch = r.range(0, TAU);
        const pad = sp([0x4f7a2e, 0x5a8a34, 0x46702a, 0x62923a], 1 + i, 0.08);
        b.cyl(x, z, rad, 0, 0.04, (gx, gy, gz) => {
          // a wedge notch out of every pad
          const a = Math.atan2(gz / b.v - b.cz / b.v - z, gx / b.v - b.cx / b.v - x);
          const d = Math.abs(((a - notch + Math.PI * 3) % TAU) - Math.PI);
          return d < 0.25 ? -1 : pad(gx, gy, gz);
        });
        if (i < 3 && r.chance(0.75)) {
          // white water-lily: petals around a yellow heart, faintly luminous at dusk
          const fx = x + r.range(-0.08, 0.08);
          const fz = z + r.range(-0.08, 0.08);
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * TAU;
            b.ell(fx + Math.cos(a) * 0.09, 0.1, fz + Math.sin(a) * 0.09, 0.07, 0.05, 0.07, glow(k & 1 ? 0xf6f2ee : 0xfbe8f0, 1));
          }
          b.ell(fx, 0.13, fz, 0.05, 0.05, 0.05, glow(0xf2d24a, 2));
        }
      }
    },
  },
  swampstump: {
    size: [2.8, 3.4, 2.8], vox: [0.12, 0.24], mat: 'leaf', sway: 0,
    build(b, r) {
      const bark = sp(CYP_BARK, 2, 0.1);
      const ph = r.range(0, TAU);
      const top = r.range(1.3, 2.3);
      for (let y = 0; y < top + 0.5; y += 1 / b.v) {
        const rr = 0.82 + 0.4 * Math.max(0, 1 - y / 0.9);
        b.cyl(0, 0, rr, y, y + 1 / b.v, (x, yy, z) => {
          const a = Math.atan2(z - b.cz, x - b.cx);
          const jag = top + Math.sin(a * 3 + ph) * 0.26 + Math.sin(a * 7 + ph * 2) * 0.12;
          return yy / b.v > jag ? -1 : bark(x, yy, z);
        });
      }
      // hollow core, dark inside
      for (let y = 0.7; y < top + 0.6; y += 1 / b.v) b.cyl(0, 0, 0.52, y, y + 1 / b.v, -1);
      b.cyl(0, 0, 0.52, 0.55, 0.7, 0x241a12);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * TAU + r.range(-0.3, 0.3);
        b.line(0, 0.7, 0, Math.cos(a) * 1.35, 0, Math.sin(a) * 1.35, 0.17, bark);
      }
      b.caps((c, x, y, z) => (hashVox(x, y, z, 4) < 0.7 ? sp([0x4a6b26, 0x3f5f22, 0x56762e], 5)(x, y, z) : c));
      if (r.chance(0.5)) {
        b.line(0.6, top - 0.2, 0.6, 1.0, top + 0.3, 1.0, 0.05, IRON[0]);
        lanternAt(b, 1.0, top - 0.25, 1.0, 1.0);
      }
    },
  },
  lanternpole: {
    size: [1.2, 3.2, 1.2], vox: [0.08, 0.16], mat: 'leaf', sway: 0,
    build(b, r) {
      const post = sp(PLANK_WET, 1, 0.06);
      const h = r.range(2.4, 2.9);
      b.cyl(0, 0, 0.11, 0, h, post);
      b.box(-0.06, h - 0.12, -0.06, 0.45, h, 0.06, post);
      b.line(0.38, h - 0.12, 0, 0.38, h - 0.35, 0, 0, IRON[0]);
      lanternAt(b, 0.38, h - 0.78, 0, 1.0);
      b.box(-0.14, 0.9, -0.14, 0.14, 1.04, 0.14, sp([0x9a8a6a, 0x8a7a5a], 3));
    },
  },
  dockruin: {
    size: [5.6, 2.4, 2.6], vox: [0.12, 0.24], mat: 'leaf', sway: 0,
    build(b, r) {
      const post = sp(PLANK_WET, 2, 0.06);
      const deck = sp(PLANK, 1, 0.08);
      const y = 0.75;
      for (let x = -2.4; x <= 2.41; x += 1.2) {
        for (const z of [-0.9, 0.9]) if (r.chance(0.85)) b.cyl(x, z, 0.13, 0, y + r.range(0.1, 0.9), post);
        b.box(x - 0.15, y + 0.2, -1.05, x + 0.15, y + 0.3, -0.75, sp([0x9a8a6a, 0x8a7a5a], 3));
      }
      for (let x = -2.5; x < 2.5; x += 1 / b.v) {
        if (hashVox(Math.floor(x * b.v), 0, 0, 3) < 0.12) continue; // missing planks
        b.box(x, y - 0.12, -1.0, x + 1 / b.v, y, 1.0, (gx, gy, gz) => (gx % 3 === 0 ? shade(PLANK[3], 0.78) : deck(gx, gy, gz)));
      }
      if (r.chance(0.5)) lanternAt(b, 2.4, y + 0.95, 0.9, 0.9);
      b.line(-2.4, y + 0.55, 0.9, 2.4, y + 0.45, 0.9, 0, sp([0xa8966e, 0x96845e], 5));
    },
  },
  // ------------------------------------------------------------------ Aurora Harbour
  floeblock: {
    size: [5.4, 1.9, 5.4], vox: [0.2, 0.4], mat: 'shiny', sway: 0,
    build(b, r) {
      const n = r.int(2, 4);
      const parts: number[][] = [];
      for (let i = 0; i < n; i++) {
        const x0 = r.range(-2.1, 0.2);
        const z0 = r.range(-2.1, 0.2);
        const x1 = x0 + r.range(1.6, 2.4);
        const z1 = z0 + r.range(1.6, 2.4);
        const top = r.range(1.0, 1.45);
        parts.push([x0, z0, x1, z1, top]);
        b.box(x0, 0, z0, x1, top, z1, (x, y, z) => {
          const yy = y / b.v;
          if (yy < 0.75) return glow(sp(ICE_DEEP, 2, 0.06)(x, y, z), 1); // luminous blue under the waterline
          return sp(ICE_BLUE, 3, 0.06)(x, y, z);
        });
      }
      b.caps((c, x, y, z) => (hashVox(x, y, z, 5) < 0.9 ? sp(SNOW, 6, 0.03)(x, y, z) : c));
      if (r.chance(0.6)) {
        const p = parts[0];
        const cx = (p[0] + p[2]) / 2;
        const cz = (p[1] + p[3]) / 2;
        if (r.chance(0.5)) b.box(cx - 0.4, p[4], cz - 0.4, cx + 0.4, p[4] + 0.8, cz + 0.4, (x, y, z) => (y % 3 === 0 ? shade(PLANK[3], 0.8) : sp(PLANK_SNOW, 7)(x, y, z)));
        else b.cyl(cx, cz, 0.36, p[4], p[4] + 0.85, (x, y, z) => (y % 2 === 0 ? IRON[0] : sp(PLANK_SNOW, 8)(x, y, z)));
        b.caps((c, x, y, z) => (y > p[4] * b.v && hashVox(x, y, z, 9) < 0.6 ? sp(SNOW, 10, 0.03)(x, y, z) : c));
      }
    },
  },
  cabin: {
    size: [6.4, 7.4, 5.6], vox: [0.2, 0.4], mat: 'leaf', sway: 0,
    build(b, r) {
      const logs = sp(PLANK_SNOW, 1, 0.07);
      const w = r.range(2.2, 2.8);
      const d = r.range(1.8, 2.2);
      const eave = r.range(2.6, 3.6);
      b.box(-w - 0.1, 0, -d - 0.1, w + 0.1, 0.5, d + 0.1, sp(STONE, 2, 0.06));
      b.box(-w, 0.5, -d, w, eave, d, (x, y, z) => (y % 2 === 0 ? shade(logs(x, y, z), 0.82) : logs(x, y, z)));
      // lit windows on the front and sides
      const wy = 1.2;
      for (let x = -w + 0.6; x < w - 0.5; x += 1.3) b.box(x, wy, d - 0.05, x + 0.6, wy + 0.8, d + 0.08, hashVox(Math.round(x * 10), 1, 0, 3) < 0.8 ? glow(WINDOW, 3) : 0x202430);
      b.box(w - 0.05, wy, -0.4, w + 0.08, wy + 0.8, 0.4, glow(WINDOW, 3));
      b.box(-0.4, 0.5, d - 0.02, 0.2, 2.0, d + 0.1, 0x3a2618);
      // steep snowy gable roof (ridge along x)
      for (let y = eave; ; y += 1 / b.v) {
        const hw = d + 0.55 - (y - eave) * 1.35;
        if (hw < 0.1) break;
        b.box(-w - 0.4, y, -hw, w + 0.4, y + 1 / b.v, hw, sp(ROOF_SLATE, 4, 0.06));
      }
      b.caps((c, x, y, z) => (glowing(c) ? c : sp(SNOW, 5, 0.03)(x, y, z)));
      // chimney and icicles along the front eave
      b.box(w - 1.0, eave + 0.6, -0.5, w - 0.5, eave + 2.6, 0, sp(STONE, 6, 0.08));
      b.box(w - 1.05, eave + 2.6, -0.55, w - 0.45, eave + 2.75, 0.05, SNOW[0]);
      for (let x = -w - 0.3; x < w + 0.3; x += 1 / b.v) if (hashVox(Math.round(x * b.v), 2, 0, 8) < 0.45) b.line(x, eave + 0.05, d + 0.5, x, eave - r.range(0.2, 0.7), d + 0.5, 0, sp(ICE_BLUE, 9, 0.04));
      lanternAt(b, 0.6, 1.8, d + 0.3, 1.1);
    },
  },
  snowcrane: {
    size: [7.4, 7.6, 2.6], vox: [0.16, 0.32], mat: 'leaf', sway: 0,
    build(b, r) {
      crane(b, r, true);
    },
  },
  piersnow: {
    size: [6, 3, 2.6], vox: [0.14, 0.28], mat: 'leaf', sway: 0,
    build(b, r) {
      pier(b, r, true);
    },
  },
  snowrock: {
    size: [4.4, 3.4, 4.4], vox: [0.18, 0.36], mat: 'shiny', sway: 0,
    build(b, r) {
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) b.ell(r.range(-0.8, 0.8), r.range(0.5, 1.2), r.range(-0.8, 0.8), r.range(1.0, 1.7), r.range(0.9, 1.6), r.range(1.0, 1.7), sp([0x6c7a8e, 0x5c6a7e, 0x7c8a9c, 0x52607a], 1 + i, 0.08));
      b.caps((c, x, y, z) => (hashVox(x, y, z, 4) < 0.9 ? sp(SNOW, 5, 0.03)(x, y, z) : c));
      // icicles round the overhangs
      const g = b.g;
      for (let z = 0; z < g.nz; z++)
        for (let x = 0; x < g.nx; x++)
          for (let y = 2; y < g.ny; y++) {
            if (!g.solid(x, y, z) || g.solid(x, y - 1, z) || hashVox(x, y, z, 6) > 0.35) continue;
            const len = 1 + Math.floor(hashVox(x, y, z, 7) * 3);
            for (let k = 1; k <= len && y - k >= 0; k++) if (!g.solid(x, y - k, z)) g.set(x, y - k, z, sp(ICE_BLUE, 8, 0.04)(x, y - k, z));
          }
    },
  },
  // ------------------------------------------------------------------ Maelstrom Lagoon
  seastackbig: {
    size: [7.4, 17.5, 7.4], vox: [0.26, 0.5], mat: 'leaf', sway: 0.3,
    build(b, r) {
      const h = r.range(7.5, 10.5);
      const rock = (x: number, y: number, z: number) => shade(ROCK_GREY[Math.floor(hashVox(x >> 1, y >> 1, z >> 1, 3) * ROCK_GREY.length)], 0.86 + hashVox(x, y, z, 4) * 0.22);
      // a weathered pillar: irregular stacked slabs drifting off-centre, a jutting cap on top
      let ox = 0;
      let oz = 0;
      for (let y = 0; y < h; y += 0.55) {
        const t = y / h;
        ox += r.range(-0.18, 0.18);
        oz += r.range(-0.18, 0.18);
        const rx = 1.9 - t * 0.35 + r.range(-0.3, 0.3);
        const rz = 1.6 - t * 0.3 + r.range(-0.3, 0.3);
        b.ell(ox, y + 0.3, oz, rx, 0.42, rz, rock);
        if (r.chance(0.35)) b.box(ox + r.range(-rx, rx * 0.4), y, oz + r.range(-rz, rz * 0.4), ox + r.range(rx * 0.4, rx + 0.3), y + 0.55, oz + r.range(rz * 0.4, rz + 0.3), rock);
      }
      b.ell(ox, h + 0.1, oz, 2.25, 0.5, 2.0, rock);
      b.box(-2.9, 0, -2.6, 2.9, 0.9, 2.6, sp(ROCK_DARK, 4, 0.08)); // wave-worn foot
      // grassy top with palms and bushes
      b.ell(ox, h + 0.55, oz, 2.0, 0.32, 1.8, sp([0x5a9a3a, 0x6aaa44, 0x4c8a32, 0x78b84a], 5, 0.1));
      palmAt(b, r, ox + r.range(-0.8, 0.2), oz + r.range(-0.6, 0.4), h + 0.7, 1.45);
      if (r.chance(0.75)) palmAt(b, r, ox + r.range(0.4, 1.1), oz + r.range(-0.3, 0.8), h + 0.6, 1.1);
      for (let k = 0; k < 3; k++) b.ell(ox + r.range(-1.4, 1.4), h + 0.8, oz + r.range(-1.2, 1.2), 0.5, 0.35, 0.5, sp([0x3a8a3a, 0x4a9a40, 0x2f7a32], 9 + k, 0.12));
      // hanging vines down the faces (front faces most)
      for (let k = 0; k < 18; k++) {
        const a = r.range(-Math.PI * 0.95, Math.PI * 0.95) + Math.PI / 2;
        const x = ox + Math.cos(a) * 2.0;
        const z = oz + Math.sin(a) * 1.8;
        b.line(x, h + 0.5, z, x * 1.02, h - r.range(1.5, 5.5), z * 1.02, 0, sp(VINE, 6 + (k & 3)));
      }
      // coral and barnacles at the waterline
      for (let k = 0; k < 8; k++) {
        const a = r.range(0, TAU);
        b.ell(Math.cos(a) * 2.6, r.range(0.9, 1.4), Math.sin(a) * 2.4, 0.38, 0.32, 0.38, sp(CORAL[k % CORAL.length], 7 + k, 0.08));
      }
    },
  },
  coral: {
    size: [1.8, 1.4, 1.8], vox: [0.08, 0.16], mat: 'leaf', sway: 0.2,
    build(b, r) {
      const pal = r.pick(CORAL);
      const col = sp(pal, 1, 0.08);
      const n = r.int(3, 6);
      for (let i = 0; i < n; i++) {
        const a = r.range(0, TAU);
        const l = r.range(0.4, 0.75);
        const mx = Math.cos(a) * l * 0.4;
        const mz = Math.sin(a) * l * 0.4;
        b.line(0, 0, 0, mx, l * 0.8, mz, 0.07, col);
        b.line(mx, l * 0.8, mz, Math.cos(a) * l * 0.7, l * 1.3, Math.sin(a) * l * 0.7, 0.05, col);
        b.line(mx, l * 0.8, mz, mx + r.range(-0.2, 0.2), l * 1.25, mz + r.range(-0.2, 0.2), 0.05, col);
      }
      if (r.chance(0.6)) b.ell(r.range(-0.4, 0.4), 0.18, r.range(-0.4, 0.4), 0.26, 0.2, 0.26, sp(r.pick(CORAL), 3, 0.1));
    },
  },
  wreck: {
    size: [11, 10, 4.6], vox: [0.22, 0.44], mat: 'leaf', sway: 0,
    build(b, r) {
      const hull = sp(HULL, 1, 0.08);
      // listing hull: half-sunk, broken open at the bow
      for (let x = -4.8; x <= 4.8; x += 1 / b.v) {
        const t = (x + 4.8) / 9.6;
        const w = 1.9 * Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(t - 0.45) * 2.05, 3)));
        if (w < 0.2) continue;
        const top = 2.4 + t * 0.8;
        const broken = t > 0.78 && hashVox(Math.round(x * b.v), 0, 0, 3) < 0.5;
        b.box(x, 0, -w, x + 1 / b.v, broken ? top * 0.6 : top, w, (gx, gy, gz) => (gy % 4 === 0 ? shade(hull(gx, gy, gz), 0.75) : hull(gx, gy, gz)));
        b.box(x, 0.4, -w + 0.25, x + 1 / b.v, top + 0.1, w - 0.25, -1); // open hold
      }
      b.box(-4.4, 1.6, -1.3, 1.5, 1.75, 1.3, sp(PLANK, 2, 0.08)); // a deck section left
      // broken mast with a torn sail and slack rigging
      b.line(-0.6, 0.5, 0, 0.9, 8.6, 0.25, 0.17, sp(HULL, 4));
      b.line(0.55, 6.6, -1.8, 0.75, 6.8, 1.9, 0.08, sp(HULL, 5));
      for (let y = 4.0; y < 6.6; y += 1 / b.v)
        for (let z = -1.7; z < 1.8; z += 1 / b.v) {
          if (hashVox(Math.round(y * b.v), Math.round(z * b.v), 1, 6) < 0.18) continue; // tatters
          const sag = Math.sin(((z + 1.7) / 3.5) * Math.PI) * 0.25;
          b.box(0.55 + (6.6 - y) * 0.08 + sag, y, z, 0.55 + (6.6 - y) * 0.08 + sag + 1 / b.v, y + 1 / b.v, z + 1 / b.v, sp(SAIL, 7, 0.06));
        }
      b.line(0.9, 8.4, 0.2, 4.6, 2.6, 0, 0, sp([0x8a7a5a, 0x7a6a4a], 8));
      b.line(0.8, 8.2, 0.2, -4.4, 2.2, 0, 0, sp([0x8a7a5a, 0x7a6a4a], 8));
      b.caps((c, x, y, z) => (y < 6 && hashVox(x, y, z, 9) < 0.15 ? sp([0x5a8a3a, 0x4a7a32], 10)(x, y, z) : c));
      lanternAt(b, -4.2, 2.6, 0.8, 1.1);
    },
  },
  pierwood: {
    size: [6, 3, 2.6], vox: [0.14, 0.28], mat: 'leaf', sway: 0,
    build(b, r) {
      pier(b, r, false);
    },
  },
  // ------------------------------------------------------------------ Lantern Wharf
  lighthouse: {
    size: [6, 21, 6], vox: [0.25, 0.5], mat: 'leaf', sway: 0,
    build(b, r) {
      b.ell(0, 0.6, 0, 2.9, 1.6, 2.7, sp(ROCK_DARK, 1, 0.08));
      const h = r.range(14, 16);
      for (let y = 1.4; y < h; y += 1 / b.v) {
        const t = (y - 1.4) / (h - 1.4);
        const rr = 1.7 - t * 0.55;
        const band = Math.floor((y - 1.4) / 2.2) % 2 === 0;
        b.cyl(0, 0, rr, y, y + 1 / b.v, band ? sp([0xe8e2d6, 0xdcd6ca, 0xf0eade], 2, 0.04) : sp([0x9a3a2e, 0x8a3428, 0xa44434], 3, 0.05));
      }
      // small lit windows up the tower
      for (let y = 3; y < h - 1; y += 3) b.box(-0.2, y, 1.2 + (1 - (y - 1.4) / (h - 1.4)) * 0.3, 0.2, y + 0.5, 1.9, glow(WINDOW, 2));
      // gallery, lamp room and dome
      b.cyl(0, 0, 1.75, h, h + 0.25, sp(IRON, 4));
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU;
        b.cyl(Math.cos(a) * 1.6, Math.sin(a) * 1.6, 0.05, h + 0.25, h + 0.9, IRON[0]);
      }
      b.cyl(0, 0, 1.0, h + 0.25, h + 1.9, glow(0xfff0c0, 10));
      b.cyl(0, 0, 1.15, h + 1.9, h + 2.2, sp(IRON, 5));
      b.ell(0, h + 2.3, 0, 0.9, 0.7, 0.9, sp([0x2e4a3a, 0x365442], 6));
      b.cyl(0, 0, 0.08, h + 2.8, h + 3.5, IRON[0]);
    },
  },
  ship: {
    size: [15, 17, 5], vox: [0.3, 0.6], mat: 'leaf', sway: 0,
    build(b, r) {
      const hull = sp(HULL, 1, 0.08);
      const paint = r.pick([0x2a3a4a, 0x3a2a2a, 0x2a3a2e]);
      for (let x = -6.6; x <= 6.6; x += 1 / b.v) {
        const t = Math.abs(x) / 6.6;
        const w = 2.1 * Math.sqrt(Math.max(0, 1 - t * t * t * t));
        const top = 2.2 + (x < -4.5 ? 1.0 : 0) + t * 0.4;
        b.box(x, 0, -w, x + 1 / b.v, top, w, (gx, gy, gz) => (gy === Math.floor(1.6 * b.v) ? shade(0xc8b070, 0.9) : gy < 1.2 * b.v ? shade(paint, 0.85 + hashVox(gx, gy, gz, 2) * 0.2) : hull(gx, gy, gz)));
      }
      // stern castle windows lit, masts with furled sails and yards, rigging
      for (let z = -1.4; z < 1.5; z += 0.7) b.box(-6.5, 2.4, z, -6.2, 2.9, z + 0.4, glow(WINDOW, 3));
      const masts = [-3.2, 0.6, 4.2];
      masts.forEach((mx, i) => {
        const mh = i === 1 ? 14.5 : 12;
        b.line(mx, 2, 0, mx, mh, 0, 0.14, sp(HULL, 3));
        for (const yy of [mh * 0.45, mh * 0.7, mh * 0.9]) {
          const span = 2.6 * (1 - yy / mh * 0.5);
          b.line(mx, yy, -span, mx, yy, span, 0.07, sp(HULL, 4));
          b.box(mx - 0.15, yy - 0.35, -span * 0.9, mx + 0.15, yy, span * 0.9, sp(SAIL, 5, 0.05)); // furled sail
        }
        b.line(mx, mh, 0, mx + (i === 2 ? 2.4 : -2.4), 2.4, 0, 0, sp([0x6a5a40, 0x5a4a34], 6));
      });
      b.line(6.6, 3.0, 0, 8.4 - 1.4, 4.4, 0, 0.08, sp(HULL, 7)); // bowsprit
      lanternAt(b, -6.4, 3.6, 0, 1.2);
    },
  },
  cargobarge: {
    size: [7.6, 2.8, 2.8], vox: [0.16, 0.32], mat: 'leaf', sway: 0,
    build(b, r) {
      const hull = sp([0x2e2a28, 0x36302c, 0x26221e], 1, 0.06);
      for (let x = -3.6; x <= 3.6; x += 1 / b.v) {
        const t = Math.abs(x) / 3.6;
        const w = 1.2 * Math.sqrt(Math.max(0, 1 - Math.pow(t, 6)));
        b.box(x, 0, -w, x + 1 / b.v, 0.7, w, (gx, gy, gz) => (gy === Math.floor(0.6 * b.v) ? sp(RUSTY, 2)(gx, gy, gz) : hull(gx, gy, gz)));
      }
      // crates and a tarp-covered stack
      for (let i = 0; i < 4; i++) {
        const x0 = -2.8 + i * 1.35 + r.range(-0.1, 0.1);
        const hh = r.range(0.55, 1.1);
        b.box(x0, 0.7, -0.75, x0 + 1.1, 0.7 + hh, 0.75, i === 2 ? sp([0x3a4a3a, 0x445444, 0x324232], 3, 0.06) : (x, y, z) => (y % 3 === 0 ? shade(PLANK[3], 0.8) : sp(PLANK, 4)(x, y, z)));
      }
      b.cyl(3.0, 0, 0.05, 0.7, 2.1, IRON[0]);
      lanternAt(b, 3.0, 1.6, 0.1, 1.0);
    },
  },
  archbridge: {
    size: [16, 7.4, 4.4], vox: [0.25, 0.5], mat: 'leaf', sway: 0,
    build(b, r) {
      const stone = (x: number, y: number, z: number) => {
        const course = y;
        const blk = Math.floor((x + (course & 1) * 2) / 3);
        return shade(STONE[Math.floor(hashVox(blk, course, z >> 2, 3) * STONE.length)], 0.9 + hashVox(x, y, z, 4) * 0.15);
      };
      const deckY = 4.2;
      b.box(-7.8, 0, -1.8, 7.8, deckY, 1.8, stone);
      // carve three arches
      for (const ax of [-4.6, 0, 4.6]) {
        const span = ax === 0 ? 2.1 : 1.6;
        for (let x = ax - span; x <= ax + span; x += 1 / b.v) {
          const k = (x - ax) / span;
          const ay = 2.4 + Math.sqrt(Math.max(0, 1 - k * k)) * (ax === 0 ? 1.3 : 0.9);
          b.box(x, 0, -1.9, x + 1 / b.v, ay, 1.9, -1);
        }
      }
      // brick parapets, coping and lamps
      b.box(-7.8, deckY, 1.5, 7.8, deckY + 0.8, 1.8, sp(BRICK, 5, 0.06));
      b.box(-7.8, deckY, -1.8, 7.8, deckY + 0.8, -1.5, sp(BRICK, 5, 0.06));
      b.box(-7.8, deckY + 0.8, 1.45, 7.8, deckY + 0.95, 1.85, sp(STONE, 6, 0.05));
      for (const lx of [-6.6, -2.2, 2.2, 6.6]) {
        b.cyl(lx, 1.65, 0.1, deckY + 0.9, deckY + 2.4, IRON[0]);
        b.box(lx - 0.22, deckY + 2.4, 1.43, lx + 0.22, deckY + 2.9, 1.87, glow(LAMP, 6));
        b.box(lx - 0.26, deckY + 2.9, 1.39, lx + 0.26, deckY + 3.0, 1.91, IRON[1]);
      }
      // grime and moss low down on the piers
      b.caps((c, x, y, z) => (y < 6 && hashVox(x, y, z, 7) < 0.25 ? sp([0x3a4a2e, 0x445436], 8)(x, y, z) : c));
      void r;
    },
  },
  timbercrane: {
    size: [7.4, 7.6, 2.6], vox: [0.16, 0.32], mat: 'leaf', sway: 0,
    build(b, r) {
      crane(b, r, false);
    },
  },
  gaslamp2: {
    size: [0.9, 4.2, 0.9], vox: [0.08, 0.16], mat: 'glow', sway: 0,
    build(b, r) {
      b.cyl(0, 0, 0.2, 0, 0.35, sp(IRON, 1));
      b.cyl(0, 0, 0.08, 0.35, 3.3, sp(IRON, 2));
      b.box(-0.07, 2.9, -0.32, 0.07, 3.0, 0.32, sp(IRON, 3)); // ladder bar
      b.box(-0.24, 3.3, -0.24, 0.24, 3.38, 0.24, IRON[0]);
      b.box(-0.2, 3.38, -0.2, 0.2, 3.85, 0.2, glow(LAMP, 6));
      b.box(-0.27, 3.85, -0.27, 0.27, 3.95, 0.27, IRON[1]);
      b.cyl(0, 0, 0.1, 3.95, 4.1, IRON[1]);
      void r;
    },
  },
};
