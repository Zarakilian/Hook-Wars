// Voxel toolkit: a colour grid, shape painting helpers, and a greedy mesher with baked ambient
// occlusion (per-vertex, Minecraft-style) and optional per-voxel colour jitter.
// Every voxel model in the game (characters, props, terrain chunks) is built with this.
import * as THREE from 'three';
import { cinematicEnabled } from '../cinematic.ts';
import { applyVoxelLook } from '../look/voxelLook.ts';

const EMPTY = -1;

export class VoxelGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly data: Int32Array;

  constructor(nx: number, ny: number, nz: number) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.data = new Int32Array(nx * ny * nz).fill(EMPTY);
  }

  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz;
  }

  index(x: number, y: number, z: number): number {
    return x + this.nx * (y + this.ny * z);
  }

  /** Colour 0xRRGGBB, or -1 to clear. Out of range writes are ignored. */
  set(x: number, y: number, z: number, color: number): void {
    x |= 0;
    y |= 0;
    z |= 0;
    if (!this.inside(x, y, z)) return;
    this.data[this.index(x, y, z)] = color;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return EMPTY;
    return this.data[this.index(x, y, z)];
  }

  solid(x: number, y: number, z: number): boolean {
    return this.get(x, y, z) !== EMPTY;
  }

  /** Inclusive box. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number | ColorFn): void {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, z, pick(color, x, y, z));
  }

  /** Filled ellipsoid centred at (cx,cy,cz) with radii (rx,ry,rz) in voxels. */
  ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: number | ColorFn): void {
    for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++)
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          const dz = (z + 0.5 - cz) / rz;
          if (dx * dx + dy * dy + dz * dz <= 1) this.set(x, y, z, pick(color, x, y, z));
        }
  }

  /** Vertical cylinder (along y) from y0 to y1 inclusive. */
  cylinder(cx: number, cz: number, r: number, y0: number, y1: number, color: number | ColorFn): void {
    for (let y = y0; y <= y1; y++)
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++)
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const dx = x + 0.5 - cx;
          const dz = z + 0.5 - cz;
          if (dx * dx + dz * dz <= r * r) this.set(x, y, z, pick(color, x, y, z));
        }
  }

  /** Thick 3D line of voxels (radius in voxels). */
  line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, color: number | ColorFn): void {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)) * 2) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const z = z0 + (z1 - z0) * t;
      if (r <= 0.5) this.set(Math.round(x), Math.round(y), Math.round(z), pick(color, Math.round(x), Math.round(y), Math.round(z)));
      else this.ellipsoid(x, y, z, r, r, r, color);
    }
  }

  /** Mirror everything with x < nx/2 onto the other side (symmetric models). */
  mirrorX(): void {
    for (let z = 0; z < this.nz; z++)
      for (let y = 0; y < this.ny; y++)
        for (let x = 0; x < Math.floor(this.nx / 2); x++) {
          const c = this.get(x, y, z);
          if (c !== EMPTY) this.set(this.nx - 1 - x, y, z, c);
        }
  }

  /** Recolour every solid voxel through fn (e.g. add speckle). */
  recolor(fn: (c: number, x: number, y: number, z: number) => number): void {
    for (let z = 0; z < this.nz; z++)
      for (let y = 0; y < this.ny; y++)
        for (let x = 0; x < this.nx; x++) {
          const i = this.index(x, y, z);
          const c = this.data[i];
          if (c !== EMPTY) this.data[i] = fn(c, x, y, z);
        }
  }

  clear(x: number, y: number, z: number): void {
    this.set(x, y, z, EMPTY);
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] !== EMPTY) n++;
    return n;
  }
}

export type ColorFn = (x: number, y: number, z: number) => number;

function pick(c: number | ColorFn, x: number, y: number, z: number): number {
  return typeof c === 'function' ? c(x, y, z) : c;
}

// ---------------------------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------------------------

export function hashVox(x: number, y: number, z: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Multiply an 0xRRGGBB colour by k (0..2), clamped. */
export function shade(c: number, k: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) * k)));
  const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) * k)));
  const b = Math.min(255, Math.max(0, Math.round((c & 255) * k)));
  return (r << 16) | (g << 8) | b;
}

export function mix(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Pick from a palette with a deterministic per-voxel hash, for natural speckle. */
export function speckle(palette: readonly number[], seed = 0): ColorFn {
  return (x, y, z) => palette[Math.floor(hashVox(x, y, z, seed) * palette.length) % palette.length];
}

/** Base colour with +-amount brightness noise per voxel. */
export function noisy(base: number, amount: number, seed = 0): ColorFn {
  return (x, y, z) => shade(base, 1 + (hashVox(x, y, z, seed) - 0.5) * 2 * amount);
}

// ---------------------------------------------------------------------------------------------
// Greedy mesher with ambient occlusion
// ---------------------------------------------------------------------------------------------

export interface MeshOptions {
  /** metres per voxel */
  size: number;
  /** pivot in voxel coordinates; default = bottom centre (nx/2, 0, nz/2) */
  pivot?: [number, number, number];
  /** bake ambient occlusion into vertex colours (default true) */
  ao?: boolean;
  /** 0..1, how dark fully occluded corners get (default 0.5) */
  aoStrength?: number;
}

const AO_CURVE = [0, 0.38, 0.68, 1];

/**
 * Build a BufferGeometry (position, normal, color) for a voxel grid.
 * Faces with the same colour and the same corner AO are merged into larger quads.
 * Colours are linear-converted (sRGB -> linear) for correct lighting.
 */
export function meshVoxels(grid: VoxelGrid, opts: MeshOptions): THREE.BufferGeometry {
  const size = opts.size;
  const pivot = opts.pivot ?? [grid.nx / 2, 0, grid.nz / 2];
  const useAo = opts.ao ?? true;
  const aoStrength = opts.aoStrength ?? 0.5;
  const dims = [grid.nx, grid.ny, grid.nz];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const col = new THREE.Color();

  const solid = (p: number[]) => grid.solid(p[0], p[1], p[2]);

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const du = dims[u];
    const dv = dims[v];
    const mask = new Float64Array(du * dv);
    for (const sign of [1, -1]) {
      for (let slice = 0; slice < dims[axis]; slice++) {
        // build mask for faces of voxels in this slice facing `sign`
        let n = 0;
        const p = [0, 0, 0];
        const q = [0, 0, 0];
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; i++, n++) {
            p[axis] = slice;
            p[u] = i;
            p[v] = j;
            const c = grid.get(p[0], p[1], p[2]);
            if (c === EMPTY) {
              mask[n] = 0;
              continue;
            }
            q[0] = p[0];
            q[1] = p[1];
            q[2] = p[2];
            q[axis] += sign;
            if (solid(q)) {
              mask[n] = 0;
              continue;
            }
            let aoKey = 255; // all corners fully lit
            if (useAo) {
              // neighbours on the empty side of the face
              const ao = [0, 0, 0, 0];
              const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
              for (let k = 0; k < 4; k++) {
                const cu = corners[k][0];
                const cv = corners[k][1];
                const s1 = [q[0], q[1], q[2]];
                s1[u] += cu;
                const s2 = [q[0], q[1], q[2]];
                s2[v] += cv;
                const cc = [q[0], q[1], q[2]];
                cc[u] += cu;
                cc[v] += cv;
                const a = solid(s1) ? 1 : 0;
                const b = solid(s2) ? 1 : 0;
                const d = solid(cc) ? 1 : 0;
                ao[k] = a && b ? 0 : 3 - (a + b + d);
              }
              aoKey = ao[0] | (ao[1] << 2) | (ao[2] << 4) | (ao[3] << 6);
            }
            mask[n] = c * 256 + aoKey + 1;
          }
        }
        // greedy merge
        n = 0;
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; ) {
            const key = mask[n];
            if (key === 0) {
              i++;
              n++;
              continue;
            }
            let w = 1;
            while (i + w < du && mask[n + w] === key) w++;
            let h = 1;
            outer: while (j + h < dv) {
              for (let k = 0; k < w; k++) if (mask[n + k + h * du] !== key) break outer;
              h++;
            }
            emitQuad(axis, u, v, sign, slice, i, j, w, h, key - 1);
            for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * du] = 0;
            i += w;
            n += w;
          }
        }
      }
    }
  }

  function emitQuad(axis: number, u: number, v: number, sign: number, slice: number, i: number, j: number, w: number, h: number, key: number) {
    const color = Math.floor(key / 256);
    const aoKey = key % 256;
    const plane = sign > 0 ? slice + 1 : slice;
    const base = positions.length / 3;
    const corners = [
      [i, j],
      [i + w, j],
      [i + w, j + h],
      [i, j + h],
    ];
    col.setHex(color, THREE.SRGBColorSpace);
    const aos: number[] = [];
    for (let k = 0; k < 4; k++) {
      const pos = [0, 0, 0];
      pos[axis] = plane;
      pos[u] = corners[k][0];
      pos[v] = corners[k][1];
      positions.push((pos[0] - pivot[0]) * size, (pos[1] - pivot[1]) * size, (pos[2] - pivot[2]) * size);
      const nrm = [0, 0, 0];
      nrm[axis] = sign;
      normals.push(nrm[0], nrm[1], nrm[2]);
      const ao = (aoKey >> (k * 2)) & 3;
      aos.push(ao);
      const lit = 1 - aoStrength * (1 - AO_CURVE[ao]);
      colors.push(col.r * lit, col.g * lit, col.b * lit);
    }
    // flip the diagonal to avoid AO anisotropy
    const flip = aos[0] + aos[2] < aos[1] + aos[3];
    if (sign > 0) {
      if (flip) indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
      else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    } else {
      if (flip) indices.push(base + 1, base + 3, base + 2, base + 1, base, base + 3);
      else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  // cinematic only: the voxel size per vertex, so the shared voxelMaterial() bevels any model correctly
  // (and BatchedMesh buckets that mix voxel sizes). Off the attribute is never created.
  if (cinematicEnabled()) geo.setAttribute('hwVoxelSize', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3).fill(size), 1));
  if (positions.length / 3 > 65535) geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  else geo.setIndex(new THREE.Uint16BufferAttribute(indices, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

const materialCache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * Shared vertex-coloured standard material. Variants are cached by key.
 * Every variant adopts the cinematic voxel look (a no-op while cinematic is off). Without `voxelSize`
 * the look reads the per-vertex size meshVoxels emits in cinematic mode; pass `voxelSize` (metres) to
 * use a fixed size instead (it then becomes part of the cache key).
 */
export function voxelMaterial(o: { roughness?: number; metalness?: number; emissive?: number; emissiveIntensity?: number; transparent?: boolean; opacity?: number; voxelSize?: number } = {}): THREE.MeshStandardMaterial {
  const key = JSON.stringify(o);
  let m = materialCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: o.roughness ?? 0.82,
      metalness: o.metalness ?? 0,
      emissive: new THREE.Color(o.emissive ?? 0x000000),
      emissiveIntensity: o.emissiveIntensity ?? 1,
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
    });
    materialCache.set(key, m);
    if (!m.transparent) applyVoxelLook(m, o.voxelSize ? { voxelSize: o.voxelSize } : { voxelSize: 'attribute', fallbackSize: 0.1 });
  }
  return m;
}

/** Convenience: grid -> shadow-casting mesh. */
export function voxelMesh(grid: VoxelGrid, opts: MeshOptions & { material?: THREE.Material }): THREE.Mesh {
  const mesh = new THREE.Mesh(meshVoxels(grid, opts), opts.material ?? voxelMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
