// Sculpt: a voxel grid where every voxel carries a colour AND a surface class (rusty iron, polished
// steel, enamel paint, rope, ivory, wet moss, gold, pearl, glow...). It meshes in ONE greedy pass with
// baked AO (shared across all surfaces, so a rope lashing darkens the iron under it) and writes a
// per-vertex aSurf attribute (roughness, metalness, emissive, heat). One shared material reads it, so
// a whole hook is a single mesh and a single draw call, with PBR that still changes voxel by voxel.
//
// Hook skins, chain links, grapples and the spring coil are all built with this. Everything here is
// module level and cached for the life of the page: FxSystem.dispose never frees it, because the
// Locker and menu previews keep using the held hooks after a match ends.
import * as THREE from 'three';
import { hashVox, mix, shade } from '../voxel/voxel.ts';

const EMPTY = -1;

/** Surface classes. Index into SURF. */
export const Surf = {
  Iron: 0, // weathered iron
  Steel: 1, // polished steel edge
  Rust: 2, // heavy rust
  Paint: 3, // chipped enamel
  Rope: 4, // fibre, cloth
  Tar: 5, // tarred rope (glossy)
  Ivory: 6, // bone, tusk, teeth
  Wood: 7, // bark, root
  Leaf: 8, // leaves, dry moss, scaly hide
  Wet: 9, // wet moss, slime
  Gold: 10,
  Pearl: 11,
  Glow: 12, // lamps, energy
  Rubber: 13,
  Chrome: 14,
  Brass: 15,
} as const;
export type SurfId = (typeof Surf)[keyof typeof Surf];

/** roughness, metalness, emissive per surface */
const SURF: readonly (readonly [number, number, number])[] = [
  [0.62, 0.55, 0], // Iron
  [0.28, 0.85, 0], // Steel
  [0.88, 0.22, 0], // Rust
  [0.46, 0.08, 0], // Paint
  [0.93, 0, 0], // Rope
  [0.5, 0.05, 0], // Tar
  [0.4, 0, 0], // Ivory
  [0.9, 0, 0], // Wood
  [0.72, 0, 0], // Leaf
  [0.28, 0, 0.02], // Wet
  [0.24, 0.92, 0.04], // Gold
  [0.16, 0.12, 0.18], // Pearl
  [0.4, 0, 2.6], // Glow
  [0.7, 0, 0], // Rubber
  [0.14, 0.95, 0], // Chrome
  [0.34, 0.8, 0], // Brass
];

/** Colour 0xRRGGBB plus a surface class, packed into one grid value. */
export function pk(color: number, surf: SurfId): number {
  return (color & 0xffffff) + surf * 0x1000000;
}

export type Paint = (x: number, y: number, z: number) => number;
/** Paint for tube stamps: s = 0..1 along the path, d = 0..1 distance from the axis to the surface. */
export type TubePaint = (x: number, y: number, z: number, s: number, d: number) => number;

export interface TubePt {
  x: number;
  y: number;
  z: number;
  /** radius in x/z (voxels) */
  r: number;
  /** radius in y, default r */
  ry?: number;
}

export class Sculpt {
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

  idx(x: number, y: number, z: number): number {
    return x + this.nx * (y + this.ny * z);
  }

  set(x: number, y: number, z: number, v: number): void {
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    if (!this.inside(x, y, z)) return;
    this.data[this.idx(x, y, z)] = v;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return EMPTY;
    return this.data[this.idx(x, y, z)];
  }

  solid(x: number, y: number, z: number): boolean {
    return this.get(x, y, z) !== EMPTY;
  }

  clear(x: number, y: number, z: number): void {
    this.set(x, y, z, EMPTY);
  }

  /** Empty 6-neighbours (0..6): edges and corners score high (chipped paint, worn highlights). */
  exposure(x: number, y: number, z: number): number {
    let n = 0;
    if (!this.solid(x + 1, y, z)) n++;
    if (!this.solid(x - 1, y, z)) n++;
    if (!this.solid(x, y + 1, z)) n++;
    if (!this.solid(x, y - 1, z)) n++;
    if (!this.solid(x, y, z + 1)) n++;
    if (!this.solid(x, y, z - 1)) n++;
    return n;
  }

  /** Filled ellipsoid (continuous coords: voxel i spans [i, i+1)). */
  ball(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, paint: Paint | number, onlyEmpty = false): void {
    for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++)
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          const dz = (z + 0.5 - cz) / rz;
          if (dx * dx + dy * dy + dz * dz > 1) continue;
          if (onlyEmpty && this.solid(x, y, z)) continue;
          this.set(x, y, z, typeof paint === 'number' ? paint : paint(x, y, z));
        }
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, paint: Paint | number): void {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, z, typeof paint === 'number' ? paint : paint(x, y, z));
  }

  /**
   * Sweep a round (or elliptic) cross-section along a polyline. Radius interpolates between points.
   * The paint gets the path position s (0..1) and the radial distance (0 = axis, 1 = skin), so
   * strands, growth rings and tapering colours are easy.
   */
  tube(pts: readonly TubePt[], paint: TubePaint, onlyEmpty = false): void {
    if (pts.length < 2) return;
    const lens: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      lens.push(lens[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const total = Math.max(1e-6, lens[lens.length - 1]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const segL = lens[i] - lens[i - 1];
      const steps = Math.max(1, Math.ceil(segL / 0.3));
      for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
        const t = k / steps;
        const cx = a.x + (b.x - a.x) * t;
        const cy = a.y + (b.y - a.y) * t;
        const cz = a.z + (b.z - a.z) * t;
        const r = a.r + (b.r - a.r) * t;
        const ar = a.ry ?? a.r;
        const br = b.ry ?? b.r;
        const ry = ar + (br - ar) * t;
        const s = (lens[i - 1] + segL * t) / total;
        this.stamp(cx, cy, cz, Math.max(0.35, r), Math.max(0.35, ry), s, paint, onlyEmpty);
      }
    }
  }

  private stamp(cx: number, cy: number, cz: number, r: number, ry: number, s: number, paint: TubePaint, onlyEmpty: boolean): void {
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++)
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const dx = (x + 0.5 - cx) / r;
          const dy = (y + 0.5 - cy) / ry;
          const dz = (z + 0.5 - cz) / r;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > 1) continue;
          if (onlyEmpty && this.solid(x, y, z)) continue;
          this.set(x, y, z, paint(x, y, z, s, Math.sqrt(d2)));
        }
  }

  /** Torus. axis 0 = ring in the YZ plane, 1 = ring in XZ (lying flat), 2 = ring in XY. */
  ring(cx: number, cy: number, cz: number, axis: 0 | 1 | 2, R: number, r: number, paint: Paint | number, stretch = 1): void {
    const ext = R * Math.max(1, stretch) + r + 1;
    for (let z = Math.floor(cz - ext); z <= Math.ceil(cz + ext); z++)
      for (let y = Math.floor(cy - ext); y <= Math.ceil(cy + ext); y++)
        for (let x = Math.floor(cx - ext); x <= Math.ceil(cx + ext); x++) {
          const px = x + 0.5 - cx;
          const py = y + 0.5 - cy;
          const pz = z + 0.5 - cz;
          // in-plane coords (a, b) and the axis coord c
          let a: number;
          let b: number;
          let c: number;
          if (axis === 0) {
            a = py;
            b = pz / stretch;
            c = px;
          } else if (axis === 1) {
            a = px;
            b = pz / stretch;
            c = py;
          } else {
            a = px;
            b = py / stretch;
            c = pz;
          }
          const q = Math.hypot(a, b) - R;
          if (q * q + c * c > r * r) continue;
          this.set(x, y, z, typeof paint === 'number' ? paint : paint(x, y, z));
        }
  }

  /** Recolour every solid voxel. */
  repaint(fn: (v: number, x: number, y: number, z: number) => number): void {
    for (let z = 0; z < this.nz; z++)
      for (let y = 0; y < this.ny; y++)
        for (let x = 0; x < this.nx; x++) {
          const i = this.idx(x, y, z);
          const v = this.data[i];
          if (v !== EMPTY) this.data[i] = fn(v, x, y, z);
        }
  }

  /** Clear every voxel matching fn. */
  carve(fn: (x: number, y: number, z: number) => boolean): void {
    for (let z = 0; z < this.nz; z++)
      for (let y = 0; y < this.ny; y++)
        for (let x = 0; x < this.nx; x++) if (fn(x, y, z)) this.data[this.idx(x, y, z)] = EMPTY;
  }

  copy(): Sculpt {
    const c = new Sculpt(this.nx, this.ny, this.nz);
    c.data.set(this.data);
    return c;
  }
}

export function colorOf(v: number): number {
  return v & 0xffffff;
}
export function surfOf(v: number): number {
  return Math.floor(v / 0x1000000);
}

// ---------------------------------------------------------------------------------------------
// Noise and palette helpers
// ---------------------------------------------------------------------------------------------

/** Smooth 3D value noise in 0..1 with lattice spacing s (voxels). */
export function vnoise(x: number, y: number, z: number, s: number, seed: number): number {
  const fx = x / s;
  const fy = y / s;
  const fz = z / s;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);
  let tx = fx - ix;
  let ty = fy - iy;
  let tz = fz - iz;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  tz = tz * tz * (3 - 2 * tz);
  const h = (a: number, b: number, c: number) => hashVox(ix + a, iy + b, iz + c, seed);
  const x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * tx;
  const x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * tx;
  const x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * tx;
  const x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * tx;
  const y0 = x00 + (x10 - x00) * ty;
  const y1 = x01 + (x11 - x01) * ty;
  return y0 + (y1 - y0) * tz;
}

/** Two octaves of value noise. */
export function fbm(x: number, y: number, z: number, s: number, seed: number): number {
  return vnoise(x, y, z, s, seed) * 0.65 + vnoise(x, y, z, s * 0.45, seed + 101) * 0.35;
}

/** Pick from a palette by a smooth noise value (patchy, not salt-and-pepper). */
export function band(pal: readonly number[], t: number): number {
  const i = Math.max(0, Math.min(pal.length - 1, Math.floor(t * pal.length)));
  return pal[i];
}

/** Per-voxel brightness jitter. */
export function jit(c: number, x: number, y: number, z: number, amt: number, seed: number): number {
  return shade(c, 1 + (hashVox(x, y, z, seed) - 0.5) * 2 * amt);
}

export function smooth01(e0: number, e1: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export { mix, shade, hashVox };

// ---------------------------------------------------------------------------------------------
// Greedy mesher with shared AO and a per-vertex surface attribute
// ---------------------------------------------------------------------------------------------

const AO_CURVE = [0, 0.38, 0.68, 1];

export interface SculptMeshOptions {
  /** metres per voxel */
  size: number;
  /** pivot in voxel coordinates (continuous) */
  pivot: [number, number, number];
  /** 0..1 corner darkening (default 0.45) */
  ao?: number;
  /** Ember Barb heat weight 0..1 at a vertex (voxel coords); default none */
  heat?: (x: number, y: number, z: number) => number;
}

export function meshSculpt(sc: Sculpt, o: SculptMeshOptions): THREE.BufferGeometry {
  const size = o.size;
  const pv = o.pivot;
  const aoStrength = o.ao ?? 0.45;
  const dims = [sc.nx, sc.ny, sc.nz];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const surfs: number[] = [];
  const indices: number[] = [];
  const col = new THREE.Color();
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  const s1 = [0, 0, 0];
  const s2 = [0, 0, 0];
  const cc = [0, 0, 0];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const ao = [0, 0, 0, 0];
  const solidA = (a: number[]) => sc.solid(a[0], a[1], a[2]);

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const du = dims[u];
    const dv = dims[v];
    const mask = new Float64Array(du * dv);
    for (const sign of [1, -1]) {
      for (let slice = 0; slice < dims[axis]; slice++) {
        let n = 0;
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; i++, n++) {
            p[axis] = slice;
            p[u] = i;
            p[v] = j;
            const c = sc.get(p[0], p[1], p[2]);
            if (c === EMPTY) {
              mask[n] = 0;
              continue;
            }
            q[0] = p[0];
            q[1] = p[1];
            q[2] = p[2];
            q[axis] += sign;
            if (solidA(q)) {
              mask[n] = 0;
              continue;
            }
            for (let k = 0; k < 4; k++) {
              s1[0] = q[0];
              s1[1] = q[1];
              s1[2] = q[2];
              s1[u] += corners[k][0];
              s2[0] = q[0];
              s2[1] = q[1];
              s2[2] = q[2];
              s2[v] += corners[k][1];
              cc[0] = q[0];
              cc[1] = q[1];
              cc[2] = q[2];
              cc[u] += corners[k][0];
              cc[v] += corners[k][1];
              const a = solidA(s1) ? 1 : 0;
              const b = solidA(s2) ? 1 : 0;
              const d = solidA(cc) ? 1 : 0;
              ao[k] = a && b ? 0 : 3 - (a + b + d);
            }
            const aoKey = ao[0] | (ao[1] << 2) | (ao[2] << 4) | (ao[3] << 6);
            mask[n] = c * 256 + aoKey + 1;
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
            emit(axis, u, v, sign, slice, i, j, w, h, key - 1);
            for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * du] = 0;
            i += w;
            n += w;
          }
        }
      }
    }
  }

  function emit(axis: number, u: number, v: number, sign: number, slice: number, i: number, j: number, w: number, h: number, key: number): void {
    const packed = Math.floor(key / 256);
    const aoKey = key % 256;
    const color = packed & 0xffffff;
    const surf = SURF[Math.min(SURF.length - 1, Math.floor(packed / 0x1000000))];
    const plane = sign > 0 ? slice + 1 : slice;
    const base = positions.length / 3;
    const cs = [
      [i, j],
      [i + w, j],
      [i + w, j + h],
      [i, j + h],
    ];
    col.setHex(color, THREE.SRGBColorSpace);
    const aos = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const pos = [0, 0, 0];
      pos[axis] = plane;
      pos[u] = cs[k][0];
      pos[v] = cs[k][1];
      positions.push((pos[0] - pv[0]) * size, (pos[1] - pv[1]) * size, (pos[2] - pv[2]) * size);
      const nrm = [0, 0, 0];
      nrm[axis] = sign;
      normals.push(nrm[0], nrm[1], nrm[2]);
      const a = (aoKey >> (k * 2)) & 3;
      aos[k] = a;
      const lit = 1 - aoStrength * (1 - AO_CURVE[a]);
      colors.push(col.r * lit, col.g * lit, col.b * lit);
      const ht = o.heat ? Math.max(0, Math.min(1, o.heat(pos[0], pos[1], pos[2]))) : 0;
      surfs.push(surf[0], surf[1], surf[2], ht);
    }
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
  geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(surfs, 4));
  if (positions.length / 3 > 65535) geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  else geo.setIndex(new THREE.Uint16BufferAttribute(indices, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------------------------
// Shared materials
// ---------------------------------------------------------------------------------------------

/** Game-clock uniforms driven by FxSystem.update (chain pulses, ember flicker). */
export const fxUniforms = {
  uTime: { value: 0 },
  uHeat: { value: 2.4 },
  uLong: { value: new THREE.Color(0xff5a2a) },
};
/** Wall-clock time for things nothing updates (the golden sparkle on a held hook in the Locker). */
export const wallUniform = { value: 0 };

export type SurfMatKind = 'base' | 'ember' | 'longshot';

const EMBER_COLOR = /* glsl */ `
  float hwH = vSurf.w;
  vec3 hwHot = mix(vec3(0.36, 0.035, 0.006), vec3(1.0, 0.5, 0.09), smoothstep(0.3, 1.0, hwH));
  diffuseColor.rgb = mix(diffuseColor.rgb, hwHot, smoothstep(0.0, 0.5, hwH) * 0.92);`;
const EMBER_EMIT = /* glsl */ `
  totalEmissiveRadiance += hwHot * smoothstep(0.12, 0.85, hwH) * uHeat * 0.75;`;
const LONG_EMIT = /* glsl */ `
  float hwP = 0.5 + 0.5 * sin(vInst * 0.55 + uTime * 17.0);
  totalEmissiveRadiance += uLong * (0.55 + 1.5 * hwP * hwP) + diffuseColor.rgb * uLong * 0.6;`;

const matCache = new Map<SurfMatKind, THREE.MeshStandardMaterial>();

/**
 * The one material every sculpted mesh uses (per-vertex roughness / metalness / emissive from aSurf).
 * 'ember' heats the business end (aSurf.w) red to yellow; 'longshot' makes chain links glow with
 * pulses running down the line toward the head (instanced meshes only).
 */
export function surfMaterial(kind: SurfMatKind = 'base'): THREE.MeshStandardMaterial {
  let m = matCache.get(kind);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2, envMapIntensity: 1 });
  m.name = `hw-surf-${kind}`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = fxUniforms.uTime;
    sh.uniforms.uHeat = fxUniforms.uHeat;
    sh.uniforms.uLong = fxUniforms.uLong;
    const inst = kind === 'longshot';
    sh.vertexShader =
      'attribute vec4 aSurf;\nvarying vec4 vSurf;\n' +
      (inst ? 'varying float vInst;\n' : '') +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vSurf = aSurf;' + (inst ? '\n#ifdef USE_INSTANCING\n  vInst = float(gl_InstanceID);\n#else\n  vInst = 0.0;\n#endif' : ''),
      );
    let fs = 'uniform float uTime;\nuniform float uHeat;\nuniform vec3 uLong;\nvarying vec4 vSurf;\n' + (inst ? 'varying float vInst;\n' : '') + sh.fragmentShader;
    if (kind === 'ember') fs = fs.replace('#include <color_fragment>', '#include <color_fragment>' + EMBER_COLOR);
    fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = vSurf.x;');
    fs = fs.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = vSurf.y;');
    fs = fs.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vSurf.z;' + (kind === 'ember' ? EMBER_EMIT : kind === 'longshot' ? LONG_EMIT : ''),
    );
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => `hw-surf-${kind}`;
  matCache.set(kind, m);
  return m;
}

/** Add a constant aSurf attribute to a geometry built elsewhere (so it can use surfMaterial). */
export function withSurf(geo: THREE.BufferGeometry, surf: SurfId, heat = 0): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  const a = new Float32Array(n * 4);
  const s = SURF[surf];
  for (let i = 0; i < n; i++) {
    a[i * 4] = s[0];
    a[i * 4 + 1] = s[1];
    a[i * 4 + 2] = s[2];
    a[i * 4 + 3] = heat;
  }
  geo.setAttribute('aSurf', new THREE.BufferAttribute(a, 4));
  return geo;
}

// ---------------------------------------------------------------------------------------------
// Twinkles: camera-facing star glints baked at model-space points (Limited items)
// ---------------------------------------------------------------------------------------------

const TWINKLE_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec3 aInfo; // corner x, corner y, phase
uniform float uWall;
uniform float uSize;
varying vec2 vUv;
varying float vTw;
void main() {
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  float ph = aInfo.z;
  float tw = pow(max(0.0, sin(uWall * (1.7 + ph * 0.9) + ph * 6.2831)), 8.0);
  float rot = uWall * 1.3 + ph * 3.0;
  float cs = cos(rot), sn = sin(rot);
  vec2 c = aInfo.xy;
  vec2 o = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
  mv.xy += o * uSize * (0.18 + 0.82 * tw);
  vUv = c;
  vTw = 0.15 + 0.85 * tw;
  gl_Position = projectionMatrix * mv;
}
`;
const TWINKLE_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
varying float vTw;
void main() {
  vec2 q = abs(vUv);
  float r = length(vUv);
  float beams = exp(-q.x * 14.0) * exp(-q.y * 2.0) + exp(-q.y * 14.0) * exp(-q.x * 2.0);
  float a = clamp(beams + exp(-r * r * 10.0), 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, r)) * vTw;
  gl_FragColor = vec4(uColor * a * (1.0 + exp(-r * r * 25.0)), 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

let twinkleMat: THREE.ShaderMaterial | null = null;

function twinkleMaterial(): THREE.ShaderMaterial {
  if (twinkleMat) return twinkleMat;
  twinkleMat = new THREE.ShaderMaterial({
    uniforms: { uWall: wallUniform, uSize: { value: 0.16 }, uColor: { value: new THREE.Color(1.6, 1.35, 0.8) } },
    vertexShader: TWINKLE_VERT,
    fragmentShader: TWINKLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  return twinkleMat;
}

/** Geometry of star glints at the given model-space points (metres). */
export function twinkleGeometry(points: readonly (readonly [number, number, number])[]): THREE.BufferGeometry {
  const n = points.length;
  const center = new Float32Array(n * 4 * 3);
  const info = new Float32Array(n * 4 * 3);
  const idx: number[] = [];
  const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < n; i++) {
    const ph = hashVox(i, 7, 3, 99);
    for (let k = 0; k < 4; k++) {
      const o = (i * 4 + k) * 3;
      center[o] = points[i][0];
      center[o + 1] = points[i][1];
      center[o + 2] = points[i][2];
      info[o] = cs[k][0];
      info[o + 1] = cs[k][1];
      info[o + 2] = ph;
    }
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  // position is needed by three for bounds; the shader uses aCenter
  g.setAttribute('position', new THREE.BufferAttribute(center.slice(), 3));
  g.setAttribute('aCenter', new THREE.BufferAttribute(center, 3));
  g.setAttribute('aInfo', new THREE.BufferAttribute(info, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += 0.3;
  return g;
}

/** A twinkle mesh. It advances the wall clock itself, so it sparkles even where nothing calls update. */
export function twinkleMesh(geo: THREE.BufferGeometry): THREE.Mesh {
  const m = new THREE.Mesh(geo, twinkleMaterial());
  m.name = 'hw-twinkle';
  m.renderOrder = 22;
  m.castShadow = false;
  m.receiveShadow = false;
  m.onBeforeRender = () => {
    wallUniform.value = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  };
  return m;
}
