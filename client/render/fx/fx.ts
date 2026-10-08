// Effects: hook chains, impacts, splashes, debris, damage numbers. (Slice version: lines and flashes.)
import * as THREE from 'three';
import type { FamilyId, HazardKind, RuneType, Team } from '../../../shared/types.ts';
import { TEAM_COLORS, type ChainView, type DamageKind, type Engine, type FxSystem, type PudgyPalette, type Quality } from '../contracts.ts';

interface Flash {
  mesh: THREE.Mesh;
  life: number;
  max: number;
}

export function createFx(engine: Engine, _quality: Quality): FxSystem {
  const scene = engine.scene;
  const flashes: Flash[] = [];
  const flashGeo = new THREE.SphereGeometry(0.4, 8, 6);

  function flash(p: THREE.Vector3, color: number, size: number, life = 0.25) {
    const mesh = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
    mesh.position.copy(p);
    mesh.scale.setScalar(size);
    scene.add(mesh);
    flashes.push({ mesh, life, max: life });
  }

  return {
    update(dt: number) {
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i];
        f.life -= dt;
        const k = Math.max(0, f.life / f.max);
        (f.mesh.material as THREE.MeshBasicMaterial).opacity = k;
        f.mesh.scale.multiplyScalar(1 + dt * 3);
        if (f.life <= 0) {
          scene.remove(f.mesh);
          (f.mesh.material as THREE.Material).dispose();
          flashes.splice(i, 1);
        }
      }
    },
    createChain(kind: 0 | 1, _family: FamilyId, team: Team): ChainView {
      const geo = new THREE.BufferGeometry();
      const max = 40;
      const arr = new Float32Array(max * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: kind === 1 ? 0xc8b48a : 0x2a2a2a }));
      line.frustumCulled = false;
      const head = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.08, 6, 10, Math.PI * 1.4), new THREE.MeshStandardMaterial({ color: TEAM_COLORS[team].light, metalness: 0.8, roughness: 0.3 }));
      scene.add(line, head);
      return {
        update(points: THREE.Vector3[]) {
          const n = Math.min(points.length, max);
          for (let i = 0; i < n; i++) {
            arr[i * 3] = points[i].x;
            arr[i * 3 + 1] = points[i].y;
            arr[i * 3 + 2] = points[i].z;
          }
          geo.setDrawRange(0, n);
          (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
          const last = points[points.length - 1];
          head.position.copy(last);
          if (points.length > 1) head.lookAt(points[points.length - 2]);
        },
        setVisible(v: boolean) {
          line.visible = v;
          head.visible = v;
        },
        dispose() {
          scene.remove(line, head);
          geo.dispose();
          head.geometry.dispose();
        },
      };
    },
    hookHit(p: THREE.Vector3, bull: boolean, ally: boolean) {
      flash(p, ally ? 0x80ff80 : bull ? 0xffe040 : 0xff3020, bull ? 2 : 1.2);
    },
    hookClash(p: THREE.Vector3) {
      flash(p, 0xffffff, 1.6);
    },
    hookWall(p: THREE.Vector3) {
      flash(p, 0xccbb99, 0.6);
    },
    hookBounce(p: THREE.Vector3) {
      flash(p, 0x99ddff, 0.8);
    },
    splash(p: THREE.Vector3, s: number) {
      flash(p, 0xcfefff, 1 + s);
    },
    bash(p: THREE.Vector3) {
      flash(p, 0xffaa55, 2.2, 0.3);
    },
    melee(p: THREE.Vector3) {
      flash(p, 0xffffff, 0.5, 0.15);
    },
    damageNumber(_p: THREE.Vector3, _a: number, _k: DamageKind) {},
    corpseBurst(p: THREE.Vector3, pal: PudgyPalette) {
      flash(p, pal.cloth, 2.5, 0.5);
    },
    runePickup(p: THREE.Vector3, _t: RuneType) {
      flash(p, 0xffffaa, 2);
    },
    mineBoom(p: THREE.Vector3) {
      flash(p, 0xff7722, 3.5, 0.45);
    },
    hazardBurst(p: THREE.Vector3, _k: HazardKind) {
      flash(p, 0xddeeff, 1.8);
    },
    respawn(p: THREE.Vector3, team: Team) {
      flash(p, TEAM_COLORS[team].light, 2, 0.5);
    },
    drownBubbles(p: THREE.Vector3) {
      flash(p, 0xbfe8ff, 0.4, 0.3);
    },
    footstep() {},
    dispose() {
      for (const f of flashes) scene.remove(f.mesh);
      flashes.length = 0;
      flashGeo.dispose();
    },
  };
}
