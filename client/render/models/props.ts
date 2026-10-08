// Props, decor, movers, hazards, runes, mines, fountains. (Slice version: simple shapes.)
import * as THREE from 'three';
import type { Circle, Decor, MapDef, MoverDef, Obstacle } from '../../../shared/maps/types.ts';
import type { HazardInst } from '../../../shared/sim/entities.ts';
import type { RuneType, Team } from '../../../shared/types.ts';
import { TEAM_COLORS, type AnimatedView, type HazardView, type HeightFn } from '../contracts.ts';

const RUNE_COLORS: Record<RuneType, number> = { haste: 0xff4040, double: 0x4080ff, ironskin: 0xffc030, ghost: 0xb0f0ff, bounty: 0xffe060 };

function std(color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
}

export function buildProps(obstacles: Obstacle[], _map: MapDef, height: HeightFn): THREE.Group {
  const g = new THREE.Group();
  for (const o of obstacles) {
    let m: THREE.Mesh;
    if (o.shape === 'circle') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r * 1.1, 2.2, 8), std(o.bouncy ? 0xff8866 : 0x6b5a45));
      m.position.set(o.x, height(o.x, o.z) + 1.1, o.z);
    } else {
      const len = Math.hypot(o.bx - o.ax, o.bz - o.az);
      m = new THREE.Mesh(new THREE.BoxGeometry(o.r * 2, o.h ?? 1.5, len + o.r * 2), std(0x7a6a55));
      const cx = (o.ax + o.bx) / 2;
      const cz = (o.az + o.bz) / 2;
      m.position.set(cx, height(cx, cz) + (o.h ?? 1.5) / 2, cz);
      m.rotation.y = Math.atan2(o.bx - o.ax, o.bz - o.az);
    }
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

export function buildDecor(decor: Decor[], _map: MapDef, height: HeightFn, _waterY: (x: number, z: number) => number): THREE.Group {
  const g = new THREE.Group();
  const grass = decor.filter((d) => d.kind === 'grass' || d.kind === 'reeds' || d.kind === 'snowtuft' || d.kind === 'fern');
  if (grass.length) {
    const geo = new THREE.ConeGeometry(0.12, 0.45, 4);
    const inst = new THREE.InstancedMesh(geo, std(0x5f8a3a), grass.length);
    const m = new THREE.Matrix4();
    grass.forEach((d, i) => {
      m.makeScale(d.scale, d.scale, d.scale);
      m.setPosition(d.x, height(d.x, d.z) + 0.2 * d.scale, d.z);
      inst.setMatrixAt(i, m);
    });
    g.add(inst);
  }
  return g;
}

export function createMoverView(def: MoverDef, _map: MapDef): THREE.Object3D {
  const g = new THREE.Group();
  const geo = def.len > 0 ? new THREE.CapsuleGeometry(def.r, def.len, 4, 8) : new THREE.CylinderGeometry(def.r, def.r, 0.4, 10);
  const m = new THREE.Mesh(geo, std(def.kind === 'icefloe' ? 0xe8f4ff : 0x7a5a3a));
  if (def.len > 0) m.rotation.x = Math.PI / 2;
  m.castShadow = true;
  g.add(m);
  return g;
}

export function createHazardView(h: HazardInst, _map: MapDef): HazardView {
  const root = new THREE.Group();
  const mat = std(h.kind === 'thorns' ? 0x3d5a22 : h.kind === 'bristles' ? 0x4a2a4a : 0x887755, { transparent: true, opacity: 0.85 });
  const m = new THREE.Mesh(new THREE.CylinderGeometry(h.r, h.r, 0.3, 16), mat);
  m.position.y = 0.15;
  root.add(m);
  return {
    root,
    update(_dt, _time, cycle, active) {
      root.visible = active;
      mat.emissive.set(cycle.warning ? 0xff3300 : 0x000000);
      m.scale.y = cycle.firing ? 6 : 1;
    },
    dispose() {
      m.geometry.dispose();
      mat.dispose();
    },
  };
}

export function createRuneView(type: RuneType): AnimatedView {
  const root = new THREE.Group();
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.45), std(RUNE_COLORS[type], { emissive: RUNE_COLORS[type], emissiveIntensity: 1.5 }));
  m.position.y = 0.9;
  root.add(m);
  return {
    root,
    update(_dt, time) {
      m.rotation.y = time * 2;
      m.position.y = 0.9 + Math.sin(time * 3) * 0.12;
    },
    dispose() {
      m.geometry.dispose();
    },
  };
}

export function createMineView(own: boolean): THREE.Object3D {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 0.15, 8), std(own ? 0x6a8a3a : 0x553322));
  m.position.y = 0.08;
  return m;
}

export function createFountainView(team: Team, c: Circle, _map: MapDef): AnimatedView {
  const root = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(c.r - 0.25, c.r, 48), new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team].main, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  root.add(ring);
  return {
    root,
    update(_dt, time) {
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(time * 2) * 0.15;
    },
    dispose() {},
  };
}
