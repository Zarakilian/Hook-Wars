// Every held hook (each 'hands' cosmetic, on its family's default outfit) must hang clear of the
// ground in the idle and run poses, at game and showcase detail (finding 35: the Dredge-Bot's crane
// and magnet hooks used to sink 10 to 20 cm into the floor, two vine-hung ogre hooks a few cm).
// The runs really move the unit, so the hook's pendulum swing is driven as in a match. A dangling
// hook's tether top must also stay where its mount puts it in the forearm: when it turned with the
// hand socket, the Dredge-Bot's cable top (15 cm above the socket) swung out of the crane arm and
// showed as a shackle sticking out of the top of the raised arm in the Locker show-offs.
// Run: node --test client/render/models/pudgy/hookClearance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { COSMETICS, DEFAULT_LOADOUT } from '../../../../shared/cosmetics.ts';
import type { FamilyId } from '../../../../shared/types.ts';
import { UnitState } from '../../../../shared/types.ts';
import type { PudgyAnimInput, PudgyOneShot } from '../../contracts.ts';
import { createPudgy } from '../pudgy.ts';

/** metres the lowest point of a held hook must stay above the feet (root y = 0) */
const CLEARANCE = 0.02;
const DT = 1 / 60;

interface Phase {
  name: string;
  frames: number;
  speed: number;
  hpFrac?: number;
  /** moves the root each frame (the swing is driven by the hand's real acceleration) */
  move?: (i: number, root: THREE.Object3D) => void;
  play?: PudgyOneShot;
}

const forward = (s: number) => (_i: number, r: THREE.Object3D) => {
  r.position.z += s * DT;
};
const RUN_POSES: readonly Phase[] = [
  { name: 'idle', frames: 180, speed: 0 },
  { name: 'run', frames: 150, speed: 4.5, move: forward(4.5) },
  { name: 'sprint', frames: 150, speed: 7, move: forward(7) },
  {
    // stop-and-go: turn round every 0.6 s at full speed
    name: 'zigzag', frames: 252, speed: 6, move: (i, r) => {
      const dir = Math.floor(i / 36) % 2 ? -1 : 1;
      r.position.z += dir * 6 * DT;
      r.rotation.y = dir > 0 ? 0 : Math.PI;
    },
  },
  {
    // sidestep every 0.5 s, facing forward
    name: 'strafe', frames: 210, speed: 6, move: (i, r) => {
      r.position.x += (Math.floor(i / 30) % 2 ? -1 : 1) * 6 * DT;
    },
  },
  { name: 'low-hp idle', frames: 180, speed: 0, hpFrac: 0.12 },
];

const box = new THREE.Box3();
const handsOf = () => COSMETICS.filter((c) => c.slot === 'hands');

function view(family: FamilyId, hands: string, detail: 'game' | 'showcase') {
  return createPudgy({ family, loadout: { ...DEFAULT_LOADOUT[family], hands }, team: 0, name: 'clearance', isLocal: false, quality: 'high', detail });
}

function input(p: Phase, t: number): PudgyAnimInput {
  return { state: UnitState.Alive, speed: p.speed, hpFrac: p.hpFrac ?? 1, flags: 0, hookOut: false, stateTime: t, time: t };
}

/** Runs one phase on a fresh view and calls `each` after every frame. */
function runPhase(family: FamilyId, hands: string, detail: 'game' | 'showcase', p: Phase, each: (v: ReturnType<typeof createPudgy>) => void): void {
  const v = view(family, hands, detail);
  try {
    let t = 0;
    for (let i = 0; i < 30; i++) v.update(DT, input({ name: 'settle', frames: 0, speed: 0 }, (t += DT)));
    if (p.play) v.play(p.play);
    for (let i = 0; i < p.frames; i++) {
      p.move?.(i, v.root);
      v.update(DT, input(p, (t += DT)));
      v.root.updateMatrixWorld(true);
      each(v);
    }
  } finally {
    v.dispose();
  }
}

function hookParts(root: THREE.Object3D): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.name === 'hw-held-head' || o.name === 'hw-held-tether' || (o.name === 'hook' && (o as THREE.Mesh).isMesh)) parts.push(o);
  });
  return parts;
}

for (const detail of ['game', 'showcase'] as const) {
  test(`held hooks clear the ground in every idle and run pose (${detail} detail)`, () => {
    const low: string[] = [];
    const hands = handsOf();
    assert.ok(hands.length >= 10, 'expected every hands cosmetic in the catalog');
    for (const c of hands)
      for (const p of RUN_POSES) {
        let min = Infinity;
        let parts: THREE.Object3D[] | null = null;
        runPhase(c.family, c.id, detail, p, (v) => {
          parts ??= hookParts(v.root);
          assert.ok(parts.length > 0, `${c.id}: no held hook mesh found`);
          for (const o of parts) {
            if (!o.visible) continue;
            box.setFromObject(o, true);
            if (!box.isEmpty()) min = Math.min(min, box.min.y - v.root.position.y);
          }
        });
        if (!(min >= CLEARANCE)) low.push(`${c.id} ${p.name}: lowest point ${min.toFixed(3)} m`);
      }
    assert.deepEqual(low, [], `held hooks below ${CLEARANCE} m:\n${low.join('\n')}`);
  });
}

/** Poses that move the hook arm the most: runs, wind-ups and the Locker's show-offs. */
const ARM_POSES: readonly Phase[] = [
  RUN_POSES[0],
  RUN_POSES[1],
  RUN_POSES[3],
  ...(['melee', 'celebrate', 'throw', 'bash', 'spawn'] as const).map((k) => ({ name: k, frames: 150, speed: 0, play: k })),
];

test('a dangling hook swings about its mount, which stays fixed in the forearm', () => {
  const bad: string[] = [];
  const w = new THREE.Vector3();
  const first = new THREE.Vector3();
  let checked = 0;
  for (const c of handsOf())
    for (const p of ARM_POSES) {
      let grip: THREE.Object3D | undefined;
      let fore: THREE.Object3D | undefined;
      let drift = 0;
      let n = 0;
      runPhase(c.family, c.id, 'game', p, (v) => {
        grip ??= v.root.getObjectByName('grip');
        fore ??= v.root.getObjectByName('elbowR');
        if (!grip || !fore || !v.root.getObjectByName('hw-held-tether') || !grip.visible) return;
        fore.worldToLocal(grip.getWorldPosition(w));
        if (n++ === 0) first.copy(w);
        drift = Math.max(drift, w.distanceTo(first));
      });
      if (n === 0) continue;
      checked++;
      // forearm-local units are metres before the rig scale (0.9 to 0.93)
      if (drift > 1e-4) bad.push(`${c.id} ${p.name}: the tether top moved ${drift.toFixed(3)} m in the forearm`);
    }
  assert.ok(checked >= 7 * ARM_POSES.length - 7, `dangling hooks checked: ${checked}`);
  assert.deepEqual(bad, []);
});

test("the Dredge-Bot's cable top stays inside its crane arm, show-offs included", () => {
  const out: string[] = [];
  const w = new THREE.Vector3();
  for (const c of handsOf().filter((h) => h.family === 'bot'))
    for (const detail of ['game', 'showcase'] as const)
      for (const p of ARM_POSES) {
        let worst = 0;
        let grip: THREE.Object3D | undefined;
        let crane: THREE.Mesh | undefined;
        runPhase('bot', c.id, detail, p, (v) => {
          grip ??= v.root.getObjectByName('grip');
          if (!crane) {
            const fore = v.root.getObjectByName('elbowR');
            crane = fore?.children.find((o) => (o as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
            crane?.geometry.computeBoundingBox();
          }
          if (!grip || !crane || !grip.visible) return;
          crane.worldToLocal(grip.getWorldPosition(w));
          const bb = crane.geometry.boundingBox!;
          const d = Math.hypot(
            Math.max(bb.min.x - w.x, 0, w.x - bb.max.x),
            Math.max(bb.min.y - w.y, 0, w.y - bb.max.y),
            Math.max(bb.min.z - w.z, 0, w.z - bb.max.z),
          );
          worst = Math.max(worst, d);
        });
        assert.ok(crane, 'crane arm mesh found');
        if (worst > 0.005) out.push(`${c.id} ${detail} ${p.name}: cable top ${worst.toFixed(3)} outside the crane arm`);
      }
  assert.deepEqual(out, []);
});
