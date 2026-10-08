// Channel-aware greedy voxel mesher for props.
// Same output style as voxel.ts meshVoxels (position, normal, colour with baked per-vertex AO),
// but every voxel also carries a material channel (base, glow, metal, ice, foliage...).
// Occlusion and hidden-face removal use the whole grid, so AO is correct across channels,
// and each channel comes out as its own BufferGeometry. No per-face allocations.
import * as THREE from 'three';
import { VoxelGrid } from '../../voxel/voxel.ts';

const EMPTY = -1;

/** VoxelGrid that also records a material channel for every voxel it paints. */
export class PGrid extends VoxelGrid {
  readonly chan: Uint8Array;
  /** channel written by every set() call */
  ch = 0;

  constructor(nx: number, ny: number, nz: number) {
    super(nx, ny, nz);
    this.chan = new Uint8Array(nx * ny * nz);
  }

  override set(x: number, y: number, z: number, color: number): void {
    x |= 0;
    y |= 0;
    z |= 0;
    if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return;
    const i = x + this.nx * (y + this.ny * z);
    this.data[i] = color;
    this.chan[i] = color === EMPTY ? 0 : this.ch;
  }

  /** Paint with channel `ch` inside fn. */
  on(ch: number, fn: () => void): void {
    const prev = this.ch;
    this.ch = ch;
    fn();
    this.ch = prev;
  }

  chanAt(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return 0;
    return this.chan[this.index(x, y, z)];
  }
}

const AO_CURVE = [0, 0.38, 0.68, 1];

export interface PMeshOpts {
  size: number;
  /** pivot in voxel coords, default bottom centre */
  pivot?: [number, number, number];
  aoStrength?: number;
  /** number of channels to emit (default 8) */
  channels?: number;
}

/** Mesh a PGrid. Returns one geometry per channel (null when the channel is empty). */
export function meshPGrid(grid: PGrid, o: PMeshOpts): (THREE.BufferGeometry | null)[] {
  const size = o.size;
  const pivot = o.pivot ?? [grid.nx / 2, 0, grid.nz / 2];
  const aoStrength = o.aoStrength ?? 0.55;
  const nCh = o.channels ?? 8;
  const nx = grid.nx;
  const ny = grid.ny;
  const nz = grid.nz;
  const data = grid.data;
  const chan = grid.chan;
  const dims = [nx, ny, nz];

  // padded occupancy (1 voxel border) so neighbour lookups never need bounds checks
  const PX = nx + 2;
  const PY = ny + 2;
  const PZ = nz + 2;
  const occ = new Uint8Array(PX * PY * PZ);
  let x0 = nx, y0 = ny, z0 = nz, x1 = -1, y1 = -1, z1 = -1;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      const row = nx * (y + ny * z);
      const prow = 1 + PX * (y + 1 + PY * (z + 1));
      for (let x = 0; x < nx; x++) {
        if (data[row + x] === EMPTY) continue;
        occ[prow + x] = 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
    }
  const out0: (THREE.BufferGeometry | null)[] = [];
  if (x1 < 0) {
    for (let c = 0; c < nCh; c++) out0.push(null);
    return out0;
  }
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  const PS = [1, PX, PX * PY];
  const DS = [1, nx, nx * ny];
  const pBase = PS[0] + PS[1] + PS[2];

  const pos: number[][] = [];
  const nrm: number[][] = [];
  const colA: number[][] = [];
  const idx: number[][] = [];
  for (let c = 0; c < nCh; c++) {
    pos.push([]);
    nrm.push([]);
    colA.push([]);
    idx.push([]);
  }

  const col = new THREE.Color();
  const ao = [0, 0, 0, 0];
  const CU = [-1, 1, 1, -1];
  const CV = [-1, -1, 1, 1];
  const corner = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const du = dims[u];
    const dv = dims[v];
    const iu0 = lo[u];
    const iu1 = hi[u];
    const jv0 = lo[v];
    const jv1 = hi[v];
    const pA = PS[axis];
    const pU = PS[u];
    const pV = PS[v];
    const dA = DS[axis];
    const dU = DS[u];
    const dV = DS[v];
    const mask = new Float64Array(du * dv);
    for (let si = 0; si < 2; si++) {
      const sign = si === 0 ? 1 : -1;
      const pStep = sign * pA;
      for (let slice = lo[axis]; slice <= hi[axis]; slice++) {
        for (let j = jv0; j <= jv1; j++) {
          let n = j * du + iu0;
          let di = slice * dA + iu0 * dU + j * dV;
          let pi = pBase + slice * pA + iu0 * pU + j * pV;
          for (let i = iu0; i <= iu1; i++, n++, di += dU, pi += pU) {
            const c = data[di];
            if (c === EMPTY) {
              mask[n] = 0;
              continue;
            }
            const q = pi + pStep;
            if (occ[q]) {
              mask[n] = 0;
              continue;
            }
            let aoKey = 0;
            for (let k = 0; k < 4; k++) {
              const a = occ[q + CU[k] * pU];
              const b = occ[q + CV[k] * pV];
              const d = occ[q + CU[k] * pU + CV[k] * pV];
              const val = a && b ? 0 : 3 - (a + b + d);
              aoKey |= val << (k * 2);
            }
            const ch = chan[di] < nCh ? chan[di] : nCh - 1;
            mask[n] = (ch * 16777216 + c) * 256 + aoKey + 1;
          }
        }
        for (let j = jv0; j <= jv1; j++) {
          let n = j * du + iu0;
          for (let i = iu0; i <= iu1; ) {
            const key = mask[n];
            if (key === 0) {
              i++;
              n++;
              continue;
            }
            let w = 1;
            while (i + w <= iu1 && mask[n + w] === key) w++;
            let h = 1;
            outer: while (j + h <= jv1) {
              for (let k = 0; k < w; k++) if (mask[n + k + h * du] !== key) break outer;
              h++;
            }
            const kk = key - 1;
            const aoKey = kk % 256;
            const rest = (kk - aoKey) / 256;
            const color = rest % 16777216;
            const ch = (rest - color) / 16777216;
            const P = pos[ch];
            const N = nrm[ch];
            const C = colA[ch];
            const I = idx[ch];
            const plane = sign > 0 ? slice + 1 : slice;
            const base = P.length / 3;
            col.setHex(color, THREE.SRGBColorSpace);
            for (let k = 0; k < 4; k++) {
              corner[axis] = plane;
              corner[u] = k === 0 || k === 3 ? i : i + w;
              corner[v] = k < 2 ? j : j + h;
              P.push((corner[0] - pivot[0]) * size, (corner[1] - pivot[1]) * size, (corner[2] - pivot[2]) * size);
              N.push(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
              const a = (aoKey >> (k * 2)) & 3;
              ao[k] = a;
              const lit = 1 - aoStrength * (1 - AO_CURVE[a]);
              C.push(col.r * lit, col.g * lit, col.b * lit);
            }
            const flip = ao[0] + ao[2] < ao[1] + ao[3];
            if (sign > 0) {
              if (flip) I.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
              else I.push(base, base + 1, base + 2, base, base + 2, base + 3);
            } else {
              if (flip) I.push(base + 1, base + 3, base + 2, base + 1, base, base + 3);
              else I.push(base, base + 2, base + 1, base, base + 3, base + 2);
            }
            for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * du] = 0;
            i += w;
            n += w;
          }
        }
      }
    }
  }

  const out: (THREE.BufferGeometry | null)[] = [];
  for (let c = 0; c < nCh; c++) {
    if (pos[c].length === 0) {
      out.push(null);
      continue;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos[c], 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm[c], 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colA[c], 3));
    if (pos[c].length / 3 > 65535) geo.setIndex(new THREE.Uint32BufferAttribute(idx[c], 1));
    else geo.setIndex(new THREE.Uint16BufferAttribute(idx[c], 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    out.push(geo);
  }
  return out;
}
