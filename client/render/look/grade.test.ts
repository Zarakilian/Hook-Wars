// The cinematic grade keeps saturated team red out of the warm lean on every map, and turns the guard off
// with the grade (the off state is the identity grade).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { getMap } from '../../../shared/maps/index.ts';
import { MAP_IDS } from '../../../shared/types.ts';
import { LookGradeEffect } from '../engine/cinema.ts';
import { cinematicLook } from './grade.ts';

test('every map grade guards team red from the warm lean', () => {
  for (const id of MAP_IDS) {
    const m = getMap(id);
    const g = cinematicLook(m, m.atmosphere).grade;
    assert.equal(g.teamGuard, 1, id);
    assert.ok(g.teamShadow > 0 && g.teamShadow <= 1, id);
  }
});

test('the grade effect carries the guard while on and clears it while off', () => {
  const fx = new LookGradeEffect();
  const team = (fx.uniforms.get('hwlTeam') as THREE.Uniform).value as THREE.Vector2;
  const m = getMap('lanternwharf');
  fx.set(cinematicLook(m, m.atmosphere), true);
  assert.deepEqual(team.toArray(), [1, 0.5]);
  fx.set(cinematicLook(m, m.atmosphere), false);
  assert.deepEqual(team.toArray(), [0, 0]);
  assert.ok(fx.getFragmentShader()!.includes('teamRed'));
  fx.dispose();
});
