// Epic water must leave the normal river shader untouched, and its own variant must still find every
// anchor in the normal shader (cineEdit throws when the normal shader changes under it).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MapDef } from '../../../../shared/maps/types.ts';
import { LANTERN_UNIFORMS } from '../../look/lanterns.ts';
import { cineEdit, epicUniforms, epicWater } from './epic.ts';
import { createSurfaceMaterial } from './surface.ts';

const fakeMap = (id: string): MapDef => ({ id }) as unknown as MapDef;

test('normal tiers: the river shader has no Epic code', () => {
  for (const detail of [0, 1, 2]) {
    const m = createSurfaceMaterial({}, 4, detail);
    assert.equal(m.fragmentShader.includes('uEpic'), false);
    assert.equal(m.fragmentShader.includes('hwLantern'), false);
    assert.equal(m.uniforms.uEpicA, undefined);
    assert.equal(m.uniforms.hwLanternCount, undefined);
  }
});

test('Epic: every anchor applies to the current normal shader', () => {
  const normal = createSurfaceMaterial({}, 4, 2).fragmentShader;
  const epic = createSurfaceMaterial({}, 4, 2, true).fragmentShader;
  assert.notEqual(epic, normal);
  for (const s of ['uniform vec4 uEpicF;', 'uniform int hwLanternCount;', 'epicGlint', 'epicSky', 'uEpicE.x, 1.0, endK']) assert.ok(epic.includes(s), s);
  // the normal fog include is replaced by the Epic fog (the river keeps part of it)
  assert.equal(epic.includes('#include <fog_fragment>'), false);
  assert.ok(normal.includes('#include <fog_fragment>'));
});

test('Epic uniforms share the engine lantern pool', () => {
  const u = epicUniforms(epicWater(fakeMap('lanternwharf')));
  assert.equal(u.hwLanternPos, LANTERN_UNIFORMS.hwLanternPos);
  assert.equal(u.hwLanternCol, LANTERN_UNIFORMS.hwLanternCol);
  assert.equal(u.hwLanternCount, LANTERN_UNIFORMS.hwLanternCount);
});

test('Epic style only touches shading (never waves, whirlpool or plips: CPU heights and random calls)', () => {
  const allowed = new Set(['clarity', 'choppy', 'caustics', 'streaks', 'oil', 'reflect', 'glitter', 'sss', 'nightLift', 'refract', 'murk', 'hueDepth', 'scumGain', 'sunsetGlow', 'auroraRefl', 'lampStreak']);
  for (const id of ['lanternwharf', 'mirelight', 'aurora', 'maelstrom', 'cogwater', 'muckmire', 'frostfang', 'coralcove']) {
    for (const k of Object.keys(epicWater(fakeMap(id)).style)) assert.ok(allowed.has(k), id + ': ' + k);
  }
});

test('cineEdit throws on a missing or repeated anchor', () => {
  assert.equal(cineEdit('a b c', [{ at: 'b', put: 'x' }]), 'a x c');
  assert.equal(cineEdit('a b c', [{ at: 'b', add: '!' }]), 'a b! c');
  assert.throws(() => cineEdit('a b c', [{ at: 'z', put: 'x' }]));
  assert.throws(() => cineEdit('a b b', [{ at: 'b', put: 'x' }]));
});
