// The lantern pool: a fixed number of lights, given to the nearest sources (brighter ones count as nearer),
// and a new source list (the props' exact lamps replacing the derived ones) starts lit at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { LanternRig, type LanternSource } from './lanterns.ts';

const src = (x: number, z: number, intensity: number): LanternSource => ({ x, y: 2, z, color: new THREE.Color(1, 0.7, 0.4), intensity, range: 6, seed: x + z });

function lit(rig: LanternRig): number[][] {
  return rig.lights.filter((l) => l.intensity > 0).map((l) => [l.position.x, l.position.z]);
}

test('the pool keeps its size and lights the nearest sources at once after setSources', () => {
  const rig = new LanternRig(2);
  rig.setSources([src(10, 0, 9), src(1, 0, 9), src(2, 0, 9), src(30, 0, 9)]);
  rig.update(1 / 60, 0, 0, 0);
  assert.equal(rig.lights.length, 2);
  assert.deepEqual(lit(rig).sort((a, b) => a[0] - b[0]), [[1, 0], [2, 0]]);
  // a new list (e.g. the props' exact lamps) snaps too: no fade-in from dark
  rig.setSources([src(0, 5, 9), src(0, 6, 9), src(0, 40, 9)]);
  rig.update(1 / 60, 0, 0, 0);
  assert.deepEqual(lit(rig).sort((a, b) => a[1] - b[1]), [[0, 5], [0, 6]]);
  rig.dispose();
});

test('a street lamp a little further out wins over a dim crate lantern nearer the player', () => {
  const rig = new LanternRig(1);
  // a 6 cd lantern at 4 m against a 13 cd lamp at 5.5 m
  rig.setSources([src(4, 0, 6), src(5.5, 0, 13)]);
  rig.update(1 / 60, 0, 0, 0);
  assert.deepEqual(lit(rig), [[5.5, 0]]);
  // plain nearest when the weighting is off
  rig.pickIntensity = 0;
  rig.setSources([src(4, 0, 6), src(5.5, 0, 13)]);
  rig.update(1 / 60, 0, 0, 0);
  assert.deepEqual(lit(rig), [[4, 0]]);
  // but a dim lantern right next to the player still beats a bright lamp far away
  rig.pickIntensity = 9;
  rig.setSources([src(2, 0, 6), src(8, 0, 13)]);
  rig.update(1 / 60, 0, 0, 0);
  assert.deepEqual(lit(rig), [[2, 0]]);
  rig.dispose();
});

test('active limits the lit lights inside the pool', () => {
  const rig = new LanternRig(4);
  rig.active = 2;
  rig.setSources([src(1, 0, 9), src(2, 0, 9), src(3, 0, 9), src(4, 0, 9)]);
  rig.update(1 / 60, 0, 0, 0);
  assert.equal(lit(rig).length, 2);
  rig.dispose();
});
