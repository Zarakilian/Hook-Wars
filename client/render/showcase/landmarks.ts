// Voxel landmarks shared by the classic menu backdrop (client/render/engine/menu.ts) and the showcase
// stage: palm islands, the striped lighthouse, and the stage's own stone quays and shorelines.
// islandGrid and lighthouseGrid are the menu's original builders, moved here unchanged (same grids,
// same colours), so the classic menu still meshes exactly the same islands and lighthouse.
import { VoxelGrid, hashVox, shade } from '../voxel/voxel.ts';

export function islandGrid(nx: number, nz: number, maxH: number, seed: number, palms: number): VoxelGrid {
  const ny = maxH + 16;
  const g = new VoxelGrid(nx, ny, nz);
  const rock = [0x4c4440, 0x5a504a, 0x433b38, 0x625750];
  const grass = [0x3f5a2c, 0x4a6632, 0x56713a];
  const sand = 0xc79a62;
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const dx = (x + 0.5) / nx * 2 - 1;
      const dz = (z + 0.5) / nz * 2 - 1;
      const r = Math.sqrt(dx * dx + dz * dz);
      const bump = hashVox(x >> 1, 0, z >> 1, seed) * 0.25 + hashVox(x >> 3, 1, z >> 3, seed) * 0.5;
      const h = Math.floor(maxH * Math.max(0, 1 - r * r * (0.95 + bump * 0.4)) + bump * 2 - 0.5);
      if (h < 0) continue;
      for (let y = 0; y <= h; y++) {
        let c: number;
        if (y === h && h > 2 && r < 0.75) c = grass[Math.floor(hashVox(x, y, z, seed + 3) * grass.length)];
        else if (y <= 1 && r > 0.6) c = shade(sand, 0.9 + hashVox(x, y, z, seed) * 0.2);
        else c = rock[Math.floor(hashVox(x, y, z, seed + 1) * rock.length)];
        g.set(x, y, z, c);
      }
    }
  // palms
  for (let i = 0; i < palms; i++) {
    const px = Math.floor(nx * (0.3 + hashVox(i, 7, 1, seed) * 0.4));
    const pz = Math.floor(nz * (0.3 + hashVox(i, 7, 2, seed) * 0.4));
    let base = 0;
    for (let y = ny - 1; y >= 0; y--)
      if (g.solid(px, y, pz)) {
        base = y + 1;
        break;
      }
    const th = 7 + Math.floor(hashVox(i, 3, 3, seed) * 4);
    const lean = hashVox(i, 4, 4, seed) > 0.5 ? 1 : -1;
    for (let y = 0; y < th; y++) g.set(px + Math.round((y * y) / (th * 3.2)) * lean, base + y, pz, shade(0x6b4a2f, 0.85 + (y % 2) * 0.15));
    const tx = px + Math.round((th * th) / (th * 3.2)) * lean;
    const ty = base + th;
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * Math.PI * 2 + i;
      for (let s = 1; s <= 4; s++) {
        const lx = tx + Math.round(Math.cos(ang) * s);
        const lz = pz + Math.round(Math.sin(ang) * s);
        const ly = ty - Math.floor((s * s) / 6);
        g.set(lx, ly, lz, shade(0x3d6a2a, 0.85 + hashVox(lx, ly, lz, seed) * 0.3));
      }
    }
    g.set(tx, ty, pz, 0x4a7a30);
  }
  return g;
}

export function lighthouseGrid(): VoxelGrid {
  const g = new VoxelGrid(9, 34, 9);
  for (let y = 0; y < 26; y++) {
    const r = 3.6 - y * 0.05;
    const band = Math.floor(y / 4) % 2 === 0 ? 0xe9e2d6 : 0xc8463a;
    g.cylinder(4.5, 4.5, r, y, y, (x, yy, z) => shade(band, 0.92 + hashVox(x, yy, z, 5) * 0.12));
  }
  g.cylinder(4.5, 4.5, 3.4, 26, 26, 0x2e2b2a); // gallery
  g.cylinder(4.5, 4.5, 2.2, 31, 32, 0x3a3230); // roof
  g.set(4, 33, 4, 0x3a3230);
  for (let y = 27; y <= 30; y++) {
    g.set(2, y, 2, 0x2e2b2a);
    g.set(6, y, 2, 0x2e2b2a);
    g.set(2, y, 6, 0x2e2b2a);
    g.set(6, y, 6, 0x2e2b2a);
  }
  return g;
}

/** Palette and finish of a stage slab (quay, shore, sandbar, snow bank). */
export interface SlabStyle {
  /** side / body colours */
  body: readonly number[];
  /** top layer colours */
  top: readonly number[];
  /** stone courses: block width and height in voxels (0 = plain fill with speckle) */
  blockW: number;
  blockH: number;
  /** 0..1 how ragged the top edge and corners are (sand and snow banks: high; cut granite: 0) */
  ragged: number;
  /**
   * 0..1 how much of the top carries a raised layer (snow drifts, moss tussocks). The layer grows in
   * smooth patches a few voxels across, one voxel high and two in the middle of a big patch, never as
   * single scattered voxels (those read as dice strewn over the bank at the showcase's low angle).
   */
  cap: number;
  capColors?: readonly number[];
  /** optional second top palette in broad patches (bare mud between the moss, wind-scoured snow) */
  patch?: readonly number[];
  /** soft seams between the voxels (snow) */
  soft?: boolean;
}

/** smooth value noise (0..1) on a lattice of `cell` voxels */
function vnoise(x: number, z: number, cell: number, seed: number): number {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  let tx = fx - ix;
  let tz = fz - iz;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = hashVox(ix, 3, iz, seed);
  const b = hashVox(ix + 1, 3, iz, seed);
  const c = hashVox(ix, 3, iz + 1, seed);
  const d = hashVox(ix + 1, 3, iz + 1, seed);
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

/**
 * A rectangular slab of voxels: a granite quay, a sandbar, a mud bank or a snow bank. nx, nz, ny in
 * voxels; the slab's origin is its bottom-left-back corner (mesh it with meshVoxels at the voxel size).
 * `keep` lists circles (in voxels) that get no raised cap: where the Lunker stands.
 */
export function slabGrid(nx: number, ny: number, nz: number, style: SlabStyle, seed: number, keep: readonly { x: number; z: number; r: number }[] = []): VoxelGrid {
  const g = new VoxelGrid(nx, ny + 2, nz);
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      // ragged edges: columns near the rim lose a voxel or two of height
      const edge = Math.min(x, nx - 1 - x, z, nz - 1 - z);
      let h = ny;
      if (style.ragged > 0 && edge < 3) {
        const k = hashVox(x >> 1, 9, z >> 1, seed);
        h -= Math.floor(k * style.ragged * (3 - edge) * 1.4);
      }
      const topPal = style.patch && vnoise(x, z, 6, seed + 31) * 0.7 + vnoise(x, z, 2.5, seed + 32) * 0.3 < 0.42 ? style.patch : style.top;
      for (let y = 0; y < h; y++) {
        let c: number;
        if (y === h - 1) c = topPal[Math.floor(hashVox(x, y, z, seed + 1) * topPal.length)];
        else if (style.blockW > 0) {
          // running-bond courses with dark mortar lines
          const course = Math.floor(y / style.blockH);
          const off = course % 2 === 0 ? 0 : Math.floor(style.blockW / 2);
          const bx = Math.floor((x + z + off) / style.blockW);
          const mortar = y % style.blockH === 0 || (x + z + off) % style.blockW === 0;
          const base = style.body[Math.floor(hashVox(bx, course, 0, seed + 2) * style.body.length)];
          c = mortar ? shade(base, 0.62) : shade(base, 0.92 + hashVox(x, y, z, seed + 3) * 0.16);
        } else c = shade(style.body[Math.floor(hashVox(x, y, z, seed + 4) * style.body.length)], 0.9 + hashVox(x, y, z, seed + 5) * 0.2);
        g.set(x, y, z, c);
      }
      if (style.cap > 0 && style.capColors && h > 0 && keep.every((k) => Math.hypot(x + 0.5 - k.x, z + 0.5 - k.z) > k.r)) {
        // smooth patches: big soft blobs plus a little finer wobble on their outline
        const n = vnoise(x, z, 7, seed + 21) * 0.75 + vnoise(x, z, 3, seed + 22) * 0.25;
        const thr = 1 - style.cap * 0.62;
        if (n > thr) {
          const k = n > thr + (1 - thr) * 0.45 ? 2 : 1;
          for (let y = h; y < h + k; y++) g.set(x, y, z, style.capColors[Math.floor(hashVox(x, y, z, seed + 6) * style.capColors.length)]);
        }
      }
    }
  return g;
}

/** A jagged mountain ridge (background silhouettes), snow above `snowLine` (0..1 of the height). */
export function ridgeGrid(nx: number, nz: number, maxH: number, seed: number, rock: readonly number[], snow: readonly number[], snowLine: number): VoxelGrid {
  const g = new VoxelGrid(nx, maxH + 1, nz);
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const t = x / nx;
      // a few peaks: sum of tents plus noise
      let h = 0;
      for (let p = 0; p < 4; p++) {
        const c = 0.12 + p * 0.25 + (hashVox(p, 1, 1, seed) - 0.5) * 0.12;
        const w = 0.1 + hashVox(p, 2, 1, seed) * 0.12;
        const ph = 0.55 + hashVox(p, 3, 1, seed) * 0.45;
        h = Math.max(h, ph * Math.max(0, 1 - Math.abs(t - c) / w));
      }
      const dz = Math.abs((z + 0.5) / nz - 0.5) * 2;
      h = h * (1 - dz * dz * 0.7) + hashVox(x >> 1, 4, z >> 1, seed) * 0.06;
      const top = Math.floor(h * maxH);
      for (let y = 0; y <= top; y++) {
        const snowy = y > maxH * snowLine + hashVox(x, 5, z, seed) * 3;
        const pal = snowy ? snow : rock;
        g.set(x, y, z, shade(pal[Math.floor(hashVox(x, y, z, seed + 7) * pal.length)], 0.9 + hashVox(x, y, z, seed + 8) * 0.2));
      }
    }
  return g;
}
