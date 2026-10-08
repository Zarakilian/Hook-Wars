// Angled top-down follow camera with aim lookahead, zoom, trauma-based shake and kick.
import * as THREE from 'three';
import { clamp } from '../../shared/math.ts';

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private focus = new THREE.Vector3();
  private target = new THREE.Vector3();
  private zoom = 1.25;
  private zoomTarget = 1.25;
  private trauma = 0;
  private kick = new THREE.Vector3();
  private t = 0;
  shakeScale = 1;
  /** world-space distance multiplier range */
  minZoom = 0.7;
  maxZoom = 1.8;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  wheel(deltaY: number): void {
    this.zoomTarget = clamp(this.zoomTarget * (1 + Math.sign(deltaY) * 0.08), this.minZoom, this.maxZoom);
  }

  /** Add screen shake (0..1). Stacks, decays quickly. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount * this.shakeScale);
  }

  /** Short directional nudge, e.g. toward a hook impact. */
  punch(dx: number, dz: number, amount: number): void {
    this.kick.x += dx * amount * this.shakeScale;
    this.kick.z += dz * amount * this.shakeScale;
  }

  snapTo(x: number, y: number, z: number): void {
    this.focus.set(x, y, z);
    this.target.set(x, y, z);
  }

  update(dt: number, fx: number, fy: number, fz: number, aimX: number, aimZ: number): void {
    this.t += dt;
    // look a little toward where the player is aiming
    let lx = (aimX - fx) * 0.22;
    let lz = (aimZ - fz) * 0.22;
    const ll = Math.hypot(lx, lz);
    if (ll > 4.5) {
      lx = (lx / ll) * 4.5;
      lz = (lz / ll) * 4.5;
    }
    this.target.set(fx + lx, fy, fz + lz);
    this.focus.lerp(this.target, 1 - Math.exp(-dt * 8));
    this.zoom += (this.zoomTarget - this.zoom) * (1 - Math.exp(-dt * 10));
    const dist = 34 * this.zoom;
    const pitch = 0.95; // radians above the horizon
    // look a little past the player toward the camera, so the HUD bar does not cover the near half of the hook range
    const biasZ = this.focus.z + 0.11 * dist;
    const cam = this.camera;
    cam.position.set(this.focus.x, this.focus.y + Math.sin(pitch) * dist, biasZ + Math.cos(pitch) * dist);
    // shake
    const s = this.trauma * this.trauma;
    const sx = (Math.sin(this.t * 47.3) + Math.sin(this.t * 31.1) * 0.5) * s * 0.35;
    const sy = (Math.sin(this.t * 53.7) + Math.sin(this.t * 23.9) * 0.5) * s * 0.35;
    cam.position.x += sx + this.kick.x;
    cam.position.y += sy;
    cam.position.z += this.kick.z;
    cam.lookAt(this.focus.x + this.kick.x * 0.5, this.focus.y, biasZ + this.kick.z * 0.5);
    cam.updateMatrixWorld();
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.kick.multiplyScalar(Math.exp(-dt * 12));
  }

  get focusPoint(): THREE.Vector3 {
    return this.focus;
  }
}
