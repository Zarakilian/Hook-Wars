// Smoke and steam puffs (cigar, pipe, smokestacks, kettle lid): one small InstancedMesh per
// character with a shared cube geometry and one shared material, so a smoking Pudgy costs one
// extra draw call whatever the number of puffs. Puffs live in world space (they trail behind a
// running unit) and are written into the root's local frame every frame. Nothing allocates per frame.
import * as THREE from 'three';
import { VOX } from './grid.ts';
import type { PuffEmitter, Skeleton } from './types.ts';

const CAP = 14;

let sharedGeo: THREE.BoxGeometry | null = null;
let sharedMat: THREE.MeshStandardMaterial | null = null;

function geo(): THREE.BoxGeometry {
  if (!sharedGeo) sharedGeo = new THREE.BoxGeometry(1, 1, 1);
  return sharedGeo;
}
function mat(): THREE.MeshStandardMaterial {
  if (!sharedMat) {
    sharedMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, transparent: true, opacity: 0.62, depthWrite: false });
    sharedMat.name = 'pudgy-puff';
  }
  return sharedMat;
}

interface Puff {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
  spin: number;
  steam: boolean;
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

export class PuffSystem {
  readonly mesh: THREE.InstancedMesh;
  private readonly emitters: PuffEmitter[];
  private readonly nodes: THREE.Object3D[];
  private readonly local: THREE.Vector3[];
  private readonly acc: number[];
  private readonly puffs: Puff[] = [];
  private next = 0;
  private enabled = true;

  constructor(emitters: PuffEmitter[], sk: Skeleton, nodeOf: (n: PuffEmitter['node']) => THREE.Object3D) {
    this.emitters = emitters;
    this.nodes = emitters.map((e) => nodeOf(e.node));
    this.local = emitters.map((e) => {
      const j = e.node === 'neck' ? sk.neck : e.node === 'hat' ? sk.hat : e.node === 'back' ? sk.back : sk.hip;
      return new THREE.Vector3((e.at[0] - j[0]) * VOX, (e.at[1] - j[1]) * VOX, (e.at[2] - j[2]) * VOX);
    });
    this.acc = emitters.map((_, i) => i * 0.37);
    for (let i = 0; i < CAP; i++) this.puffs.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 0, size: 0, spin: 0, steam: false });
    this.mesh = new THREE.InstancedMesh(geo(), mat(), CAP);
    this.mesh.name = 'puffs';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    for (let i = 0; i < CAP; i++) this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.mesh.visible = on;
    if (!on) for (const p of this.puffs) p.age = p.life + 1;
  }

  private spawn(i: number, scale: number): void {
    const e = this.emitters[i];
    const p = this.puffs[this.next];
    this.next = (this.next + 1) % CAP;
    _p.copy(this.local[i]);
    this.nodes[i].localToWorld(_p);
    p.x = _p.x;
    p.y = _p.y;
    p.z = _p.z;
    const steam = e.kind === 'steam';
    p.steam = steam;
    p.vx = (Math.random() - 0.5) * 0.25;
    p.vz = (Math.random() - 0.5) * 0.25;
    p.vy = steam ? 0.75 + Math.random() * 0.35 : 0.35 + Math.random() * 0.2;
    p.age = 0;
    p.life = steam ? 0.7 + Math.random() * 0.35 : 1.4 + Math.random() * 0.5;
    p.size = e.size * scale * (0.8 + Math.random() * 0.4);
    p.spin = Math.random() * 6;
  }

  /** exert 0..1 (throws, bashes, running) raises the rate; root is the unit's root object. */
  update(dt: number, exert: number, scale: number, root: THREE.Object3D, active: boolean): void {
    if (!this.enabled) return;
    if (active && dt > 0) {
      for (let i = 0; i < this.emitters.length; i++) {
        const e = this.emitters[i];
        this.acc[i] += dt * (e.rate + e.burst * exert);
        while (this.acc[i] >= 1) {
          this.acc[i] -= 1;
          this.spawn(i, scale);
        }
      }
    }
    root.updateWorldMatrix(true, false);
    _inv.copy(root.matrixWorld).invert();
    let n = 0;
    for (const p of this.puffs) {
      if (p.age >= p.life) continue;
      p.age += dt;
      if (p.age >= p.life) continue;
      const drag = Math.exp(-dt * 1.4);
      p.vx *= drag;
      p.vz *= drag;
      p.vy *= p.steam ? Math.exp(-dt * 1.8) : 1;
      p.x += p.vx * dt + (p.steam ? 0 : Math.sin(p.age * 2.3 + p.spin) * 0.12 * dt);
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const u = p.age / p.life;
      // grow fast, then shrink away (voxel smoke fades by size)
      const k = Math.min(1, u * 6) * (1 - u * u) * (0.7 + u * 1.3);
      const s = Math.max(0.0001, p.size * k);
      _p.set(p.x, p.y, p.z);
      _e.set(p.spin + u * 1.5, p.spin * 0.7 + u * 2, 0);
      _q.setFromEuler(_e);
      _s.set(s, s, s);
      _m.compose(_p, _q, _s).premultiply(_inv);
      this.mesh.setMatrixAt(n, _m);
      const g = p.steam ? 0.96 - u * 0.12 : 0.74 - u * 0.18;
      _c.setRGB(g, g, p.steam ? g * 1.02 : g * 0.97);
      this.mesh.setColorAt(n, _c);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
