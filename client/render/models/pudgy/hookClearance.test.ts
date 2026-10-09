// Every held hook (each 'hands' cosmetic, on its family's default outfit) must hang clear of the
// ground in the idle and run poses, at game and showcase detail (finding 35: the Dredge-Bot's crane
// and magnet hooks used to sink 10 to 20 cm into the floor, two vine-hung ogre hooks a few cm).
// Run: node --test client/render/models/pudgy/hookClearance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { COSMETICS, DEFAULT_LOADOUT } from '../../../../shared/cosmetics.ts';
import { UnitState } from '../../../../shared/types.ts';
import { createPudgy } from '../pudgy.ts';

/** metres the lowest point of a held hook must stay above the feet (root y = 0) */
const CLEARANCE = 0.02;
const FRAMES = 240;
const PHASES: readonly (readonly [string, number])[] = [['idle', 0], ['run', 4.5], ['sprint', 7]];

const box = new THREE.Box3();

function lowestHookPoint(detail: 'game' | 'showcase', hands: string, family: 'brawler' | 'ogre' | 'bot'): { phase: string; y: number }[] {
  const v = createPudgy({ family, loadout: { ...DEFAULT_LOADOUT[family], hands }, team: 0, name: 'clearance', isLocal: false, quality: 'high', detail });
  const parts: THREE.Object3D[] = [];
  v.root.traverse((o) => {
    if (o.name === 'hw-held-head' || o.name === 'hw-held-tether' || (o.name === 'hook' && (o as THREE.Mesh).isMesh)) parts.push(o);
  });
  assert.ok(parts.length > 0, `${hands}: no held hook mesh found`);
  const out: { phase: string; y: number }[] = [];
  let t = 0;
  try {
    for (const [phase, speed] of PHASES) {
      let min = Infinity;
      for (let i = 0; i < FRAMES; i++) {
        t += 1 / 60;
        v.update(1 / 60, { state: UnitState.Alive, speed, hpFrac: 1, flags: 0, hookOut: false, stateTime: t, time: t });
        v.root.updateMatrixWorld(true);
        for (const p of parts) {
          if (!p.visible) continue;
          box.setFromObject(p, true);
          if (!box.isEmpty()) min = Math.min(min, box.min.y);
        }
      }
      out.push({ phase, y: min });
    }
  } finally {
    v.dispose();
  }
  return out;
}

for (const detail of ['game', 'showcase'] as const) {
  test(`held hooks clear the ground (${detail} detail)`, () => {
    const low: string[] = [];
    const hands = COSMETICS.filter((c) => c.slot === 'hands');
    assert.ok(hands.length >= 10, 'expected every hands cosmetic in the catalog');
    for (const c of hands) {
      for (const r of lowestHookPoint(detail, c.id, c.family)) {
        if (!(r.y >= CLEARANCE)) low.push(`${c.id} ${r.phase}: lowest point ${r.y.toFixed(3)} m`);
      }
    }
    assert.deepEqual(low, [], `held hooks below ${CLEARANCE} m:\n${low.join('\n')}`);
  });
}
