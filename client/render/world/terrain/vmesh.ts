// Allocation-free greedy voxel mesher with baked AO, same output layout as voxel.ts meshVoxels
// (position, normal, color, index) but several times faster, for the many backdrop models built at
// match start.
import * as THREE from 'three';
import type { VoxelGrid } from '../../voxel/voxel.ts';

const AO_CURVE = [0, 0.38, 0.68, 1];
const col = new THREE.Color();
const linCache = new Map<number, number>();

function lin(c: number, k: number): number {
  // returns linear channel k of sRGB colour c (cached per colour)
  let packed = linCache.get(c);
  if (packed === undefined) {
    col.setHex(c, THREE.SRGBColorSpace);
    packed = Math.round(col.r * 1023) | (Math.round(col.g * 1023) << 10) | (Math.round(col.b * 1023) << 20);
    linCache.set(c, packed);
  }
  return ((packed >> (k * 10)) & 1023) / 1023;
}

let pos = new Float32Array(1 << 15);
let nrm = new Float32Array(1 << 15);
let clr = new Float32Array(1 << 15);
let idx = new Uint32Array(1 << 14);
let mask = new Float64Array(64 * 64);

export function meshVoxelsFast(grid: VoxelGrid, size: number, aoStrength = 0.45): THREE.BufferGeometry {
  const data = grid.data;
  const dims = [grid.nx, grid.ny, grid.nz];
  const stride = [1, grid.nx, grid.nx * grid.ny];
  const px = grid.nx / 2;
  const pz = grid.nz / 2;
  let nv = 0;
  let ni = 0;
  const ensure = () => {
    if ((nv + 4) * 3 > pos.length) {
      const g = (a: Float32Array) => {
        const b = new Float32Array(a.length * 2);
        b.set(a);
        return b;
      };
      pos = g(pos);
      nrm = g(nrm);
      clr = g(clr);
    }
    if (ni + 6 > idx.length) {
      const b = new Uint32Array(idx.length * 2);
      b.set(idx);
      idx = b;
    }
  };
  const ao = [0, 0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const du = dims[u];
    const dv = dims[v];
    const sa = stride[axis];
    const su = stride[u];
    const sv = stride[v];
    if (mask.length < du * dv) mask = new Float64Array(du * dv);
    for (let sign = 1; sign >= -1; sign -= 2) {
      for (let slice = 0; slice < dims[axis]; slice++) {
        const qs = slice + sign;
        const qIn = qs >= 0 && qs < dims[axis];
        let n = 0;
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; i++, n++) {
            const p = slice * sa + i * su + j * sv;
            const c = data[p];
            if (c === -1) {
              mask[n] = 0;
              continue;
            }
            const q = p + sign * sa;
            if (qIn && data[q] !== -1) {
              mask[n] = 0;
              continue;
            }
            let key = 255;
            if (qIn) {
              // corners: (-u,-v) (+u,-v) (+u,+v) (-u,+v) on the empty side
              const um = i > 0;
              const up = i < du - 1;
              const vm = j > 0;
              const vp = j < dv - 1;
              const sUm = um && data[q - su] !== -1 ? 1 : 0;
              const sUp = up && data[q + su] !== -1 ? 1 : 0;
              const sVm = vm && data[q - sv] !== -1 ? 1 : 0;
              const sVp = vp && data[q + sv] !== -1 ? 1 : 0;
              const c00 = um && vm && data[q - su - sv] !== -1 ? 1 : 0;
              const c10 = up && vm && data[q + su - sv] !== -1 ? 1 : 0;
              const c11 = up && vp && data[q + su + sv] !== -1 ? 1 : 0;
              const c01 = um && vp && data[q - su + sv] !== -1 ? 1 : 0;
              const a0 = sUm && sVm ? 0 : 3 - (sUm + sVm + c00);
              const a1 = sUp && sVm ? 0 : 3 - (sUp + sVm + c10);
              const a2 = sUp && sVp ? 0 : 3 - (sUp + sVp + c11);
              const a3 = sUm && sVp ? 0 : 3 - (sUm + sVp + c01);
              key = a0 | (a1 << 2) | (a2 << 4) | (a3 << 6);
            }
            mask[n] = c * 256 + key + 1;
          }
        }
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
            for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * du] = 0;
            // emit
            const kk = key - 1;
            const color = Math.floor(kk / 256);
            const aoKey = kk % 256;
            const plane = sign > 0 ? slice + 1 : slice;
            ensure();
            const base = nv;
            const r = lin(color, 0);
            const g = lin(color, 1);
            const bl = lin(color, 2);
            for (let k = 0; k < 4; k++) {
              const cu = k === 1 || k === 2 ? i + w : i;
              const cv = k >= 2 ? j + h : j;
              let x = 0;
              let y = 0;
              let z = 0;
              if (axis === 0) {
                x = plane;
                y = cu;
                z = cv;
              } else if (axis === 1) {
                y = plane;
                z = cu;
                x = cv;
              } else {
                z = plane;
                x = cu;
                y = cv;
              }
              const o3 = nv * 3;
              pos[o3] = (x - px) * size;
              pos[o3 + 1] = y * size;
              pos[o3 + 2] = (z - pz) * size;
              nrm[o3] = axis === 0 ? sign : 0;
              nrm[o3 + 1] = axis === 1 ? sign : 0;
              nrm[o3 + 2] = axis === 2 ? sign : 0;
              const a = (aoKey >> (k * 2)) & 3;
              ao[k] = a;
              const lit = 1 - aoStrength * (1 - AO_CURVE[a]);
              clr[o3] = r * lit;
              clr[o3 + 1] = g * lit;
              clr[o3 + 2] = bl * lit;
              nv++;
            }
            const flip = ao[0] + ao[2] < ao[1] + ao[3];
            if (sign > 0) {
              if (flip) {
                idx[ni++] = base + 1; idx[ni++] = base + 2; idx[ni++] = base + 3;
                idx[ni++] = base + 1; idx[ni++] = base + 3; idx[ni++] = base;
              } else {
                idx[ni++] = base; idx[ni++] = base + 1; idx[ni++] = base + 2;
                idx[ni++] = base; idx[ni++] = base + 2; idx[ni++] = base + 3;
              }
            } else if (flip) {
              idx[ni++] = base + 1; idx[ni++] = base + 3; idx[ni++] = base + 2;
              idx[ni++] = base + 1; idx[ni++] = base; idx[ni++] = base + 3;
            } else {
              idx[ni++] = base; idx[ni++] = base + 2; idx[ni++] = base + 1;
              idx[ni++] = base; idx[ni++] = base + 3; idx[ni++] = base + 2;
            }
            i += w;
            n += w;
          }
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, nv * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm.slice(0, nv * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(clr.slice(0, nv * 3), 3));
  geo.setIndex(new THREE.BufferAttribute(nv > 65535 ? idx.slice(0, ni) : Uint16Array.from(idx.subarray(0, ni)), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
