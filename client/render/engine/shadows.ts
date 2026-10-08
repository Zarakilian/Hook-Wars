// Sun shadow fitting. The orthographic shadow frustum covers exactly the ground the camera can see
// (clamped to the map), its extents are quantised and its centre is snapped to the shadow texel
// grid in light space, so moving the camera never makes shadow edges crawl or shimmer.
import * as THREE from 'three';
import type { Quality } from '../contracts.ts';

export interface ShadowBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** lowest receiver height (river bed) */
  yLow: number;
  /** highest receiver height we care about (tree canopies) */
  yHigh: number;
}

interface TierShadow {
  size: number;
  radius: number;
}

const TIERS: Record<Quality, TierShadow | null> = {
  low: null,
  medium: { size: 2048, radius: 1.25 },
  high: { size: 2048, radius: 2.4 },
  ultra: { size: 4096, radius: 3.0 },
};

const NDC_CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
  [0, 1],
  [0, -1],
];

const DIST = 60; // light camera distance from the snapped centre
const DEPTH_RANGE = 48; // half depth range of the shadow camera

export class ShadowRig {
  private readonly sun: THREE.DirectionalLight;
  private readonly dir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  private readonly ax = new THREE.Vector3();
  private readonly ay = new THREE.Vector3();
  private readonly az = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly ray = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private tier: TierShadow | null = null;
  private enabled = true;
  private halfX = 0;
  private halfY = 0;
  /** world size of one shadow texel (for diagnostics and the water module) */
  texelSize = 0.04;

  constructor(sun: THREE.DirectionalLight) {
    this.sun = sun;
    const s = sun.shadow;
    s.camera.near = DIST - DEPTH_RANGE;
    s.camera.far = DIST + DEPTH_RANGE;
    s.bias = -0.00018;
    s.normalBias = 0.028;
    s.intensity = 1;
    s.autoUpdate = true;
    this.setDirection(this.dir);
  }

  setQuality(q: Quality): void {
    this.tier = TIERS[q];
    const s = this.sun.shadow;
    if (this.tier) {
      if (s.mapSize.x !== this.tier.size) {
        if (s.map) {
          s.map.dispose();
          s.map = null;
        }
        s.mapSize.set(this.tier.size, this.tier.size);
      }
      s.radius = this.tier.radius;
      this.halfX = 0; // force a refit
    }
    this.applyCast();
  }

  /** Off in the menu (nothing worth shadowing). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyCast();
  }

  private applyCast(): void {
    this.sun.castShadow = this.enabled && this.tier !== null;
  }

  setIntensity(v: number): void {
    this.sun.shadow.intensity = v;
  }

  /** direction TO the sun */
  setDirection(d: THREE.Vector3): void {
    this.dir.copy(d).normalize();
    // same basis as Matrix4.lookAt(eye = target + dir, target, up = +Y)
    this.az.copy(this.dir);
    const up = Math.abs(this.dir.y) > 0.999 ? this.tmp.set(0, 0, 1) : this.tmp.set(0, 1, 0);
    this.ax.crossVectors(up, this.az).normalize();
    this.ay.crossVectors(this.az, this.ax);
    this.halfX = 0;
  }

  /**
   * Fit the frustum to what the camera sees. Falls back to a box around the focus point when the
   * camera does not look at the ground (menu, first frames).
   */
  update(camera: THREE.PerspectiveCamera, focusX: number, focusZ: number, b: ShadowBounds): void {
    if (!this.sun.castShadow || !this.tier) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const cp = camera.position;
    let hits = 0;
    const consider = (x: number, y: number, z: number) => {
      x = Math.min(b.maxX, Math.max(b.minX, x));
      z = Math.min(b.maxZ, Math.max(b.minZ, z));
      const lx = x * this.ax.x + y * this.ax.y + z * this.ax.z;
      const ly = x * this.ay.x + y * this.ay.y + z * this.ay.z;
      if (lx < minX) minX = lx;
      if (lx > maxX) maxX = lx;
      if (ly < minY) minY = ly;
      if (ly > maxY) maxY = ly;
    };
    for (const [nx, ny] of NDC_CORNERS) {
      this.ray.set(nx, ny, 0.5).unproject(camera).sub(cp).normalize();
      for (let k = 0; k < 2; k++) {
        const py = k === 0 ? b.yLow : b.yHigh;
        let t = 140;
        if (this.ray.y < -1e-3) {
          const tt = (py - cp.y) / this.ray.y;
          if (tt > 0) {
            t = Math.min(tt, 140);
            hits++;
          }
        }
        consider(cp.x + this.ray.x * t, cp.y + this.ray.y * t, cp.z + this.ray.z * t);
      }
    }
    if (hits < 4) {
      // not looking at the ground: a generous box around the focus
      minX = minY = Infinity;
      maxX = maxY = -Infinity;
      for (const dx of [-38, 38]) for (const dz of [-28, 28]) for (const y of [b.yLow, b.yHigh]) consider(focusX + dx, y, focusZ + dz);
    }
    const size = this.tier.size;
    // quantise the extents (2 m steps) so small camera moves keep the texel size constant
    const hx = Math.ceil(((maxX - minX) * 0.5 + 1.5) / 2) * 2;
    const hy = Math.ceil(((maxY - minY) * 0.5 + 1.5) / 2) * 2;
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    if (hx !== this.halfX || hy !== this.halfY) {
      this.halfX = hx;
      this.halfY = hy;
      sc.left = -hx;
      sc.right = hx;
      sc.top = hy;
      sc.bottom = -hy;
      sc.near = DIST - DEPTH_RANGE;
      sc.far = DIST + DEPTH_RANGE;
      sc.updateProjectionMatrix();
      this.texelSize = (2 * Math.max(hx, hy)) / size;
      this.sun.shadow.normalBias = this.texelSize * 0.85;
    }
    // snap the centre to whole texels in light space
    const tx = (2 * hx) / size;
    const ty = (2 * hy) / size;
    const cx = Math.round(((minX + maxX) * 0.5) / tx) * tx;
    const cy = Math.round(((minY + maxY) * 0.5) / ty) * ty;
    const gy = (b.yLow + b.yHigh) * 0.5;
    const cz = focusX * this.az.x + gy * this.az.y + focusZ * this.az.z;
    this.center
      .copy(this.ax)
      .multiplyScalar(cx)
      .addScaledVector(this.ay, cy)
      .addScaledVector(this.az, cz);
    this.sun.target.position.copy(this.center);
    this.sun.position.copy(this.center).addScaledVector(this.dir, DIST);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }
}
