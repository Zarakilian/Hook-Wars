// Voxel models for hook chains: link segments (rope, vine, steel link, cable, twine) and hook heads
// (barbed fishing hook with lure, bone hook, hydraulic crane claw, three-pronged grappling claws),
// plus the Ricochet Spring coil. Every model lies with its length along +Z (direction of travel).
// Heads are split in a "metal" part and a "paint" part so each gets a fitting PBR material.
import type * as THREE from 'three';
import type { FamilyId } from '../../../shared/types.ts';
import { hashVox, meshVoxels, mix, shade, VoxelGrid } from '../voxel/voxel.ts';

type Pal = readonly number[];

function centerPivot(g: VoxelGrid): [number, number, number] {
  return [g.nx / 2, g.ny / 2, g.nz / 2];
}

// ---------------------------------------------------------------------------------------------
// Link segments
// ---------------------------------------------------------------------------------------------

export interface LinkModel {
  geo: THREE.BufferGeometry;
  /** metres between consecutive links */
  spacing: number;
  /** roll added per link (radians) */
  twist: number;
  /** alternate every other link by 90 degrees (interlocking chain) */
  alt: boolean;
}

/** Twisted strand cord, n x n cross-section, len voxels long. */
function strandGrid(n: number, len: number, strands: number, light: number, mid: number, dark: number, groove: number, seed: number): VoxelGrid {
  const g = new VoxelGrid(n, n, len);
  const c = (n - 1) / 2;
  const rr = (n / 2) * (n / 2) + 0.3;
  for (let z = 0; z < len; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const dx = x - c;
        const dy = y - c;
        if (dx * dx + dy * dy > rr) continue;
        const ang = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
        const f = (ang * strands + z / len) % 1;
        let col: number;
        if (f < 0.2) col = groove;
        else {
          const s = Math.sin(((f - 0.2) / 0.8) * Math.PI);
          col = s > 0.7 ? light : s > 0.35 ? mid : dark;
        }
        // fake top light: upper voxels a touch brighter
        col = shade(col, 0.92 + 0.16 * (y / Math.max(1, n - 1)) + (hashVox(x, y, z, seed) - 0.5) * 0.12);
        g.set(x, y, z, col);
      }
  return g;
}

export function ropeLink(): LinkModel {
  const g = strandGrid(4, 5, 3, 0xd9bd86, 0xc2a066, 0x9c7a46, 0x6e5230, 11);
  return { geo: meshVoxels(g, { size: 0.036, pivot: centerPivot(g), aoStrength: 0.35 }), spacing: 0.165, twist: (Math.PI * 2) / 3, alt: false };
}

export function ropeKnot(): THREE.BufferGeometry {
  const g = new VoxelGrid(6, 6, 5);
  g.ellipsoid(3, 3, 2.5, 3, 3, 2.6, (x, y, z) => {
    const band = z === 1 || z === 3;
    const base = band ? 0x8a6a3c : (x + y + z) % 3 === 0 ? 0xc9a870 : 0xb79458;
    return shade(base, 0.9 + 0.2 * (y / 5) + (hashVox(x, y, z, 5) - 0.5) * 0.1);
  });
  return meshVoxels(g, { size: 0.036, pivot: centerPivot(g), aoStrength: 0.4 });
}

export function vineLink(): LinkModel {
  const g = strandGrid(4, 5, 2, 0x6f8f3a, 0x587a2c, 0x45601f, 0x33461a, 23);
  // a few bark nubs
  g.set(0, 2, 2, 0x5a4a2a);
  g.set(3, 1, 4, 0x5a4a2a);
  return { geo: meshVoxels(g, { size: 0.038, pivot: centerPivot(g), aoStrength: 0.4 }), spacing: 0.18, twist: 1.4, alt: false };
}

/** Leaf that sticks out sideways (+X) from the vine axis. */
export function vineLeaf(): THREE.BufferGeometry {
  const g = new VoxelGrid(8, 1, 5);
  for (let x = 1; x < 8; x++) {
    const t = (x - 1) / 6;
    const w = Math.sin(t * Math.PI) * 2.6 + 0.3;
    for (let z = 0; z < 5; z++) {
      const dz = Math.abs(z - 2);
      if (dz > w) continue;
      const vein = z === 2;
      const base = vein ? 0x4d7f25 : dz > w - 1 ? 0x5f9a30 : 0x7cbf3e;
      g.set(x, 0, z, shade(base, 0.92 + (hashVox(x, 0, z, 7) - 0.5) * 0.16));
    }
  }
  g.set(0, 0, 2, 0x4a6a22); // stem
  return meshVoxels(g, { size: 0.04, pivot: [0.5, 0.5, 2.5], ao: false });
}

export function steelLink(): LinkModel {
  const g = new VoxelGrid(4, 2, 7);
  for (let z = 0; z < 7; z++)
    for (let x = 0; x < 4; x++) {
      const corner = (x === 0 || x === 3) && (z === 0 || z === 6);
      const hole = x >= 1 && x <= 2 && z >= 2 && z <= 4;
      if (corner || hole) continue;
      for (let y = 0; y < 2; y++) {
        const edge = x === 0 || x === 3 || z === 0 || z === 6;
        const base = y === 1 ? (edge ? 0xbac1ca : 0xa3abb4) : edge ? 0x8e959e : 0x7a8189;
        g.set(x, y, z, shade(base, 0.95 + (hashVox(x, y, z, 3) - 0.5) * 0.1));
      }
    }
  return { geo: meshVoxels(g, { size: 0.036, pivot: centerPivot(g), aoStrength: 0.3 }), spacing: 0.18, twist: 0, alt: true };
}

export function twineLink(): LinkModel {
  const g = strandGrid(3, 4, 2, 0xe4cf9e, 0xcdb27a, 0xa98d58, 0x7d6540, 31);
  return { geo: meshVoxels(g, { size: 0.03, pivot: centerPivot(g), aoStrength: 0.3 }), spacing: 0.11, twist: Math.PI, alt: false };
}

export function thinVineLink(): LinkModel {
  const g = strandGrid(3, 4, 2, 0x7a9c40, 0x62832f, 0x4a6423, 0x37491a, 37);
  return { geo: meshVoxels(g, { size: 0.03, pivot: centerPivot(g), aoStrength: 0.3 }), spacing: 0.11, twist: 1.2, alt: false };
}

export function cableLink(): LinkModel {
  const g = strandGrid(3, 4, 3, 0xa3aab3, 0x858c95, 0x6a7079, 0x4b5058, 41);
  return { geo: meshVoxels(g, { size: 0.03, pivot: centerPivot(g), aoStrength: 0.3 }), spacing: 0.11, twist: 2.1, alt: false };
}

// ---------------------------------------------------------------------------------------------
// Heads
// ---------------------------------------------------------------------------------------------

export interface HeadModel {
  metal: THREE.BufferGeometry;
  /** Ember Barb variant: the business end glows red hot */
  metalHot: THREE.BufferGeometry;
  /** bot claw: closed jaws while carrying */
  metalClosed?: THREE.BufferGeometry;
  metalClosedHot?: THREE.BufferGeometry;
  paint: THREE.BufferGeometry;
  /** small emissive lamp (bot) */
  lamp?: THREE.BufferGeometry;
  /** distance from the head pivot back to where the chain ties on */
  eye: number;
  /** local z of the spring coil centre */
  coilZ: number;
  /** local x offset of the coil */
  coilX: number;
}

const IRON: Pal = [0x676d75, 0x737a82, 0x80878f];
const IRON_TOP = 0x9ea5ae;
const IRON_TIP = 0xd0d7df;
const RUST = 0x7b5a3c;

/** Stamp a 1 x h column of voxels at (x, z) for y in [y0, y1]. */
function col(g: VoxelGrid, x: number, z: number, y0: number, y1: number, c: (x: number, y: number, z: number) => number): void {
  for (let y = y0; y <= y1; y++) g.set(x, y, z, c(x, y, z));
}

/**
 * Copy of a grid with everything from z0 forward heated: dull red first, then glowing orange to
 * yellow at z1. The ember material makes those saturated hot colours emissive.
 */
function heat(src: VoxelGrid, z0: number, z1: number): VoxelGrid {
  const g = new VoxelGrid(src.nx, src.ny, src.nz);
  g.data.set(src.data);
  g.recolor((c, x, y, z) => {
    if (z < z0) return c;
    const t = Math.min(1, (z - z0) / Math.max(1, z1 - z0));
    const n = 0.92 + hashVox(x, y, z, 71) * 0.16;
    if (t < 0.3) return shade(mix(c, 0x7a2a12, (t / 0.3) * 0.75), n);
    return shade(mix(0xff3a0a, 0xffb040, (t - 0.3) / 0.7), n);
  });
  return g;
}

function ironColor(x: number, y: number, z: number): number {
  const h = hashVox(x, y, z, 17);
  if (h > 0.94) return RUST;
  const base = y >= 2 ? IRON_TOP : IRON[Math.floor(h * IRON.length) % IRON.length];
  return shade(base, 0.94 + h * 0.12);
}

/** Draw a thick J-hook in the XZ plane (y = 1..2). Returns nothing; colours via fn. */
function jHook(g: VoxelGrid, o: { shankX: number; shankZ0: number; shankZ1: number; bendCx: number; bendCz: number; rOut: number; rIn: number; pointX0: number; pointX1: number; tipZ: number }, c: (x: number, y: number, z: number) => number): void {
  // shank (2 wide)
  for (let z = o.shankZ0; z <= o.shankZ1; z++) {
    col(g, o.shankX, z, 1, 2, c);
    col(g, o.shankX + 1, z, 1, 2, c);
  }
  // bend: front half annulus
  for (let z = Math.floor(o.bendCz); z <= Math.ceil(o.bendCz + o.rOut); z++)
    for (let x = Math.floor(o.bendCx - o.rOut); x <= Math.ceil(o.bendCx + o.rOut); x++) {
      const dx = x + 0.5 - o.bendCx;
      const dz = z + 0.5 - o.bendCz;
      const d = Math.hypot(dx, dz);
      if (dz >= -0.5 && d <= o.rOut && d >= o.rIn) col(g, x, z, 1, 2, c);
    }
  // point, running back toward the eye and tapering
  for (let z = o.tipZ; z <= Math.floor(o.bendCz); z++) {
    col(g, o.pointX0, z, 1, 2, c);
    if (z > o.tipZ + 1) col(g, o.pointX1, z, 1, 2, c);
  }
}

/** Harbour Brawler: iron barbed fishing hook with a team-coloured fish lure. */
export function brawlerHead(team: { main: number; dark: number; light: number }): HeadModel {
  const v = 0.056;
  const g = new VoxelGrid(13, 4, 18);
  // eye ring at the back
  for (let z = 0; z <= 4; z++)
    for (let x = 4; x <= 10; x++) {
      const d = Math.hypot(x + 0.5 - 7.5, z + 0.5 - 2.2);
      if (d >= 1.05 && d <= 2.15) col(g, x, z, 1, 2, ironColor);
    }
  jHook(g, { shankX: 6, shankZ0: 4, shankZ1: 12, bendCx: 4.4, bendCz: 12.4, rOut: 3.9, rIn: 1.3, pointX0: 1, pointX1: 2, tipZ: 7 }, ironColor);
  // polished point and barb
  for (let z = 7; z <= 8; z++) col(g, 1, z, 1, 2, () => IRON_TIP);
  col(g, 2, 9, 1, 2, () => IRON_TIP);
  col(g, 3, 9, 1, 2, () => shade(IRON_TIP, 0.9));
  col(g, 3, 10, 1, 2, ironColor);
  // a lashing of rope where the line ties on
  col(g, 6, 4, 0, 3, (x, y) => (y % 2 ? 0xc2a066 : 0x9c7a46));
  col(g, 7, 4, 0, 3, (x, y) => (y % 2 ? 0x9c7a46 : 0xc2a066));

  // lure: little fish beside the shank, plus a gold spinner blade
  const p = new VoxelGrid(13, 4, 18);
  p.ellipsoid(10.5, 1.6, 7.2, 1.45, 1.4, 2.7, (x, y, z) => {
    if (y <= 0) return mix(team.light, 0xffffff, 0.45); // pale belly
    if (z === 7 && y >= 2) return 0xffffff; // stripe
    return shade(y >= 2 ? team.main : team.dark, 0.95 + hashVox(x, y, z, 2) * 0.1);
  });
  p.set(10, 2, 9, 0x111111);
  p.set(11, 2, 9, 0x111111); // eyes
  p.set(10, 1, 10, 0xffe9a0);
  // tail fin
  for (let x = 9; x <= 12; x++) p.set(x, 1, 4, team.dark);
  p.set(9, 2, 3, team.dark);
  p.set(12, 2, 3, team.dark);
  // spinner blade and split ring
  p.box(11, 2, 11, 12, 2, 12, 0xf6c443);
  p.set(11, 3, 11, 0xffe58a);
  p.set(9, 1, 3, 0xb8bfc8);
  p.set(8, 1, 3, 0xb8bfc8);
  const pivot: [number, number, number] = [7.5, 1.5, 10];
  return {
    metal: meshVoxels(g, { size: v, pivot, aoStrength: 0.45 }),
    metalHot: meshVoxels(heat(g, 6, 16), { size: v, pivot, aoStrength: 0.45 }),
    paint: meshVoxels(p, { size: v, pivot, aoStrength: 0.45 }),
    eye: (10 - 1.2) * v,
    coilZ: (8.5 - 10) * v,
    coilX: (7 - 7.5) * v,
  };
}

const BONE: Pal = [0xeee3c8, 0xe2d5b6, 0xd3c39f];
function boneColor(x: number, y: number, z: number): number {
  const h = hashVox(x, y, z, 29);
  const base = y >= 2 ? 0xf6eedb : BONE[Math.floor(h * BONE.length) % BONE.length];
  return shade(h > 0.93 ? 0xb9a982 : base, 0.95 + h * 0.08);
}

/** Swamp Ogre: big curved bone hook with a fang barb and a vine lashing. */
export function ogreHead(team: { main: number; dark: number; light: number }): HeadModel {
  const v = 0.058;
  const g = new VoxelGrid(13, 4, 18);
  // knobbly bone end at the back
  g.ellipsoid(6.2, 1.5, 2.2, 1.6, 1.6, 1.6, boneColor);
  g.ellipsoid(8.6, 1.5, 2.0, 1.5, 1.5, 1.5, boneColor);
  jHook(g, { shankX: 6, shankZ0: 3, shankZ1: 12, bendCx: 4.4, bendCz: 12.3, rOut: 4, rIn: 1.3, pointX0: 1, pointX1: 2, tipZ: 6 }, boneColor);
  // fang barb: yellowed tooth at the point
  for (let z = 5; z <= 7; z++) col(g, 1, z, 1, 2, () => 0xfff6d8);
  col(g, 2, 8, 1, 2, () => 0xf0e2b8);
  col(g, 3, 9, 1, 2, () => 0xe2cf9c);
  // groove along the shank
  for (let z = 5; z <= 11; z += 2) g.set(6, 2, z, 0xc9b88f);

  const p = new VoxelGrid(13, 4, 18);
  // vine lashing round the shank
  for (const z of [4, 5, 7]) {
    for (let x = 5; x <= 8; x++) {
      p.set(x, 0, z, 0x4b7426);
      p.set(x, 3, z, 0x5f8f32);
    }
    p.set(5, 1, z, 0x4b7426);
    p.set(5, 2, z, 0x5f8f32);
    p.set(8, 1, z, 0x4b7426);
    p.set(8, 2, z, 0x5f8f32);
  }
  // little leaf off the lashing
  p.box(9, 2, 5, 11, 2, 6, 0x7cbf3e);
  p.set(12, 2, 5, 0x6aa836);
  // team-coloured clay bead and feather
  p.box(9, 0, 7, 10, 1, 8, (x, y, z) => shade(team.main, 0.9 + hashVox(x, y, z, 4) * 0.2));
  for (let z = 8; z <= 11; z++) p.set(11, 1, z, z % 2 ? team.light : team.main);
  p.set(12, 1, 11, team.light);
  const pivot: [number, number, number] = [7.5, 1.5, 10];
  return {
    metal: meshVoxels(g, { size: v, pivot, aoStrength: 0.45 }),
    metalHot: meshVoxels(heat(g, 6, 16), { size: v, pivot, aoStrength: 0.45 }),
    paint: meshVoxels(p, { size: v, pivot, aoStrength: 0.45 }),
    eye: (10 - 0.8) * v,
    coilZ: (9 - 10) * v,
    coilX: (7 - 7.5) * v,
  };
}

const STEEL_DARK = 0x5d636b;
function steelColor(x: number, y: number, z: number): number {
  const h = hashVox(x, y, z, 53);
  const base = y >= 4 ? 0xa3abb4 : y >= 2 ? 0x868d96 : STEEL_DARK;
  return shade(base, 0.94 + h * 0.12);
}
function chromeColor(x: number, y: number, z: number): number {
  return shade(y >= 3 ? 0xdfe5ec : 0xaeb6bf, 0.96 + hashVox(x, y, z, 59) * 0.08);
}

function botJaws(g: VoxelGrid, closed: boolean): void {
  // two curved jaws hinged at the claw plate, voxel path per side (x, z) mirrored around x = 6
  const open: [number, number][] = [[4, 9], [3, 10], [2, 11], [1, 12], [1, 13], [1, 14], [2, 15], [3, 16], [4, 16]];
  const shut: [number, number][] = [[4, 9], [3, 10], [3, 11], [3, 12], [3, 13], [4, 14], [5, 15], [6, 15]];
  const path = closed ? shut : open;
  for (const [x, z] of path) {
    for (const xx of [x, 12 - x]) {
      col(g, xx, z, 1, 3, steelColor);
      col(g, xx + (xx < 6 ? 1 : -1), z, 1, 3, steelColor);
    }
  }
  // tooth tips
  const tip = path[path.length - 1];
  for (const xx of [tip[0], 12 - tip[0]]) col(g, xx, tip[1], 1, 3, () => 0xe6ebf0);
}

/** Butcher-Bot: hydraulic crane claw with a piston, hazard-striped housing and a team lamp. */
export function botHead(team: { main: number; dark: number; light: number }): HeadModel {
  const v = 0.054;
  const build = (closed: boolean) => {
    const g = new VoxelGrid(13, 6, 17);
    // housing
    g.box(3, 1, 0, 9, 3, 5, steelColor);
    // rivets
    for (const [x, z] of [[3, 0], [9, 0], [3, 5], [9, 5]] as const) g.set(x, 4, z, 0xb7bec7);
    // piston
    for (let z = 6; z <= 8; z++) for (let x = 5; x <= 7; x++) col(g, x, z, 1, 3, z === 8 ? steelColor : chromeColor);
    // claw plate
    g.box(3, 1, 8, 9, 3, 8, steelColor);
    botJaws(g, closed);
    return g;
  };
  const g = build(false);
  const gc = build(true);
  const p = new VoxelGrid(13, 6, 17);
  // hazard stripes on the housing roof
  for (let z = 0; z <= 5; z++) for (let x = 3; x <= 9; x++) p.set(x, 4, z, (x + z) % 4 < 2 ? 0xf2c230 : 0x22232a);
  // team plates on the sides
  for (let z = 1; z <= 4; z++) {
    p.set(2, 2, z, team.main);
    p.set(10, 2, z, team.main);
  }
  const lamp = new VoxelGrid(13, 6, 17);
  lamp.box(5, 5, 2, 7, 5, 3, 0xffffff);
  const pivot: [number, number, number] = [6.5, 2.5, 9];
  return {
    metal: meshVoxels(g, { size: v, pivot, aoStrength: 0.45 }),
    metalHot: meshVoxels(heat(g, 8, 16), { size: v, pivot, aoStrength: 0.45 }),
    metalClosed: meshVoxels(gc, { size: v, pivot, aoStrength: 0.45 }),
    metalClosedHot: meshVoxels(heat(gc, 8, 15), { size: v, pivot, aoStrength: 0.45 }),
    paint: meshVoxels(p, { size: v, pivot, aoStrength: 0.4 }),
    lamp: meshVoxels(lamp, { size: v, pivot, ao: false }),
    eye: (9 - 0.2) * v,
    coilZ: (6.5 - 9) * v,
    coilX: 0,
  };
}

/** Three-pronged grappling claw. Prongs at 90, 210 and 330 degrees round the shaft (symmetric from above). */
export function grappleHead(family: FamilyId, team: { main: number; dark: number; light: number }): HeadModel {
  const v = 0.046;
  const n = 14;
  const g = new VoxelGrid(n, n, 13);
  const cx = 6.5;
  const cy = 6.5;
  const mat =
    family === 'ogre'
      ? boneColor
      : family === 'bot'
        ? (x: number, y: number, z: number) => shade(y > cy + 1 ? 0x9aa2ab : 0x6c737c, 0.94 + hashVox(x, y, z, 61) * 0.12)
        : ironColor;
  // shaft 2 x 2
  for (let z = 0; z <= 8; z++) for (let y = 6; y <= 7; y++) for (let x = 6; x <= 7; x++) g.set(x, y, z, mat(x, y, z));
  // tow ring at the back
  for (let y = 4; y <= 9; y++)
    for (let x = 4; x <= 9; x++) {
      const d = Math.hypot(x + 0.5 - 7, y + 0.5 - 7);
      if (d >= 1.6 && d <= 2.6) g.set(x, y, 0, mat(x, y, 0));
    }
  // prongs: out and forward, then curling back to a point
  for (const deg of [90, 210, 330]) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // radius grows then holds, z goes forward then back
      const rad = 1 + 4.6 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.5);
      const z = 8 + 3.6 * Math.sin(t * Math.PI) - t * 3.2;
      const x = cx + 0.5 + dx * rad;
      const y = cy + 0.5 + dy * rad;
      const tipc = t > 0.85 ? (family === 'ogre' ? 0xfff6d8 : 0xd8dee5) : -1;
      for (const [ox, oy] of [[0, 0], [0.5, 0.5]] as const) {
        const X = Math.floor(x + ox - 0.5);
        const Y = Math.floor(y + oy - 0.5);
        const Z = Math.floor(z);
        g.set(X, Y, Z, tipc >= 0 ? tipc : mat(X, Y, Z));
      }
    }
  }
  const p = new VoxelGrid(n, n, 13);
  // team wrap on the shaft
  for (let z = 2; z <= 4; z++)
    for (let y = 5; y <= 8; y++)
      for (let x = 5; x <= 8; x++) {
        if (x > 5 && x < 8 && y > 5 && y < 8) continue;
        const c = family === 'ogre' ? (z === 3 ? team.main : 0x5f8f32) : family === 'bot' ? (z === 3 ? 0xf2c230 : 0x2a2c33) : z === 3 ? team.light : team.main;
        p.set(x, y, z, c);
      }
  let lamp: THREE.BufferGeometry | undefined;
  if (family === 'bot') {
    const l = new VoxelGrid(n, n, 13);
    l.box(6, 8, 5, 7, 8, 6, 0xffffff);
    lamp = meshVoxels(l, { size: v, pivot: [7, 7, 8], ao: false });
  }
  const pivot: [number, number, number] = [7, 7, 8];
  return {
    metal: meshVoxels(g, { size: v, pivot, aoStrength: 0.4 }),
    metalHot: meshVoxels(heat(g, 7, 11), { size: v, pivot, aoStrength: 0.4 }),
    paint: meshVoxels(p, { size: v, pivot, aoStrength: 0.4 }),
    lamp,
    eye: 8 * v,
    coilZ: (4 - 8) * v,
    coilX: 0,
  };
}

/** Ricochet Spring: springy coil that wraps the shank. */
export function springCoil(): THREE.BufferGeometry {
  const g = new VoxelGrid(9, 9, 11);
  const turns = 3.2;
  const steps = 260;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2;
    const x = Math.floor(4.5 + Math.cos(a) * 3.6);
    const y = Math.floor(4.5 + Math.sin(a) * 3.6);
    const z = Math.floor(1 + t * 8.6);
    const lit = Math.sin(a) > 0.2;
    g.set(x, y, z, lit ? 0x9fd8ff : 0x4f9ee8);
  }
  return meshVoxels(g, { size: 0.034, pivot: [4.5, 4.5, 5.5], aoStrength: 0.3 });
}
