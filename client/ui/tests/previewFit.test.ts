// Finding 39: the whole-body preview (main menu, Locker) must keep the whole character in frame,
// with room for the "Drag to spin" pill, through the spawn pop and every show-off. Runs the real
// character models through the preview's camera rule and checks the result with three's own camera
// projection (an independent check of the closed-form fit).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DEFAULT_LOADOUT } from '../../../shared/cosmetics.ts';
import { FAMILIES, UnitState, type FamilyId } from '../../../shared/types.ts';
import type { PudgyOneShot, PudgyView } from '../../render/contracts.ts';
import { createPudgy } from '../../render/models/pudgy.ts';
import { BODY_MARGIN, fitDistance, meshCorners, projectNdc } from '../previewFit.ts';

// the preview's camera (client/ui/preview.ts): fov 28, tilt 0.28, menu canvas 545 x 493 at 1280x720
const FOV = 28;
const TILT = 0.28;
const ASPECT = 545 / 493;
const LIMIT_TOP = 1 - 2 * BODY_MARGIN.top;

/** The preview's resting framing (frameModel with FOCUS.all = { y: 0.42, d: 1.14 }). */
function restFrame(v: PudgyView, aspect: number): { dist: number; target: THREE.Vector3 } {
  v.root.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(v.root).getSize(new THREE.Vector3());
  const height = Math.max(1.2, Math.min(3.4, size.y));
  const width = Math.max(1.2, Math.min(3, Math.max(size.x, size.z)));
  const t = Math.tan((FOV * Math.PI) / 360);
  const fitH = (height * 1.18) / 2 / t;
  const fitW = (width * 1.3) / 2 / t / Math.max(0.6, aspect);
  return { dist: (Math.max(fitH, fitW) + width * 0.3) * 1.14, target: new THREE.Vector3(0, height * 0.42, 0) };
}

function camAt(target: THREE.Vector3, d: number, aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 60);
  cam.position.set(0, target.y + Math.sin(TILT) * d, Math.cos(TILT) * d);
  cam.lookAt(target);
  cam.updateMatrixWorld(true);
  return cam;
}

/** Highest point of the model in NDC (three's projection), over all mesh-box corners. */
function topNdc(v: PudgyView, cam: THREE.PerspectiveCamera): number {
  let top = -Infinity;
  for (const p of meshCorners(v.root)) top = Math.max(top, p.clone().project(cam).y);
  return top;
}

const input = (t: number) => ({ state: UnitState.Alive, speed: 0, hpFrac: 1, flags: 0, hookOut: false, stateTime: t, time: t });

/** Play one animation as the preview does: eased camera, plus (when guard) the keep-in-frame floor. */
function run(family: FamilyId, shot: PudgyOneShot, yaw: number, guard: boolean): number {
  const holder = new THREE.Group();
  const v = createPudgy({ family, loadout: DEFAULT_LOADOUT[family], team: 0, name: 'p', isLocal: true, quality: 'high', detail: 'showcase' });
  holder.add(v.root);
  holder.rotation.y = yaw;
  v.update(1 / 60, input(0));
  holder.updateMatrixWorld(true);
  const rest = restFrame(v, ASPECT);
  let camDist = rest.dist;
  v.play(shot);
  let worst = -Infinity;
  for (let i = 0; i < 80; i++) {
    const dt = 1 / 60;
    v.update(dt, input(i * dt));
    holder.updateMatrixWorld(true);
    camDist += (rest.dist - camDist) * (1 - Math.exp(-dt * 6));
    if (guard) camDist = Math.max(camDist, fitDistance(meshCorners(v.root), { fov: FOV, aspect: ASPECT, tilt: TILT, target: rest.target }));
    worst = Math.max(worst, topNdc(v, camAt(rest.target, camDist, ASPECT)));
  }
  v.dispose();
  return worst;
}

test('the closed-form fit matches three.js projection', () => {
  const target = new THREE.Vector3(0, 0.9, 0);
  const pts = [new THREE.Vector3(0.4, 2.3, 0.6), new THREE.Vector3(-1.1, 0.2, -0.3), new THREE.Vector3(0.9, 1.4, 0.9)];
  const view = { fov: FOV, aspect: ASPECT, tilt: TILT, target };
  const d = fitDistance(pts, view);
  const cam = camAt(target, d, ASPECT);
  let onEdge = false;
  for (const p of pts) {
    const ours = projectNdc(p, view, d);
    const theirs = p.clone().project(cam);
    assert.ok(Math.abs(ours.x - theirs.x) < 1e-6 && Math.abs(ours.y - theirs.y) < 1e-6, 'same projection');
    assert.ok(theirs.y <= LIMIT_TOP + 1e-9 && theirs.y >= -(1 - 2 * BODY_MARGIN.bottom) - 1e-9);
    assert.ok(Math.abs(theirs.x) <= 1 - 2 * BODY_MARGIN.side + 1e-9);
    if (Math.abs(theirs.y - LIMIT_TOP) < 1e-6 || Math.abs(Math.abs(theirs.x) - (1 - 2 * BODY_MARGIN.side)) < 1e-6) onEdge = true;
  }
  assert.ok(onEdge, 'the tightest point sits exactly on its margin');
});

test('the menu show-offs leave out the grapple (it throws the hook over the head)', async () => {
  // preview.ts needs a DOM, so read its list from the source
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../preview.ts', import.meta.url), 'utf8');
  const m = src.match(/ONE_SHOTS[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(m);
  assert.doesNotMatch(m[1], /grapple/);
});

test('without the guard the spawn pop leaves the frame (the bug), with it every pose stays inside', () => {
  // one view per family held for the whole test keeps the shared part cache warm (each run builds fast)
  const keep = FAMILIES.map((f) => createPudgy({ family: f, loadout: DEFAULT_LOADOUT[f], team: 0, name: 'keep', isLocal: true, quality: 'high', detail: 'showcase' }));
  const before = Math.max(...FAMILIES.map((f) => run(f, 'spawn', 0.5, false)));
  assert.ok(before > 1, `old framing peaks at NDC ${before.toFixed(3)}, past the top edge`);
  console.log(`old framing: spawn pop peaks at NDC ${before.toFixed(3)} (1 = top edge)`);
  for (const f of FAMILIES) {
    for (const shot of ['spawn', 'celebrate', 'throw', 'bash', 'melee', 'grapple'] as PudgyOneShot[]) {
      for (const yaw of [0.5, 3.6]) {
        const top = run(f, shot, yaw, true);
        assert.ok(top <= LIMIT_TOP + 1e-6, `${f} ${shot} yaw ${yaw}: top at NDC ${top.toFixed(3)} (limit ${LIMIT_TOP})`);
      }
    }
  }
  for (const v of keep) v.dispose();
});
