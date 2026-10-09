// Weather off the cinematic path must build the normal shaders byte for byte (no lantern code, no extra
// uniforms); in cinematic mode rain and snow get the lantern-lit variants that share the lantern pool.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { LANTERN_UNIFORMS } from '../look/lanterns.ts';
import { WeatherSystem, type WeatherOptions } from './weather.ts';

function build(kind: 'rain' | 'snow', cinematic?: boolean): THREE.ShaderMaterial[] {
  const o: WeatherOptions = {
    kind,
    quality: 'high',
    groundY: 0,
    tint: new THREE.Color(0.6, 0.7, 0.8),
    sunColor: new THREE.Color(1, 1, 1),
    groundMask: null,
    maskRect: new THREE.Vector4(-36, -24, 72, 48),
    overlayLayer: 2,
    seed: 7,
  };
  if (cinematic !== undefined) o.cinematic = cinematic;
  const w = new WeatherSystem(o);
  const out: THREE.ShaderMaterial[] = [];
  w.group.traverse((obj) => {
    const m = (obj as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (m && m.isShaderMaterial) out.push(m);
  });
  return out;
}

for (const kind of ['rain', 'snow'] as const) {
  test(`${kind}: cinematic off builds the normal shaders`, () => {
    const plain = build(kind);
    const off = build(kind, false);
    assert.ok(plain.length > 0);
    assert.equal(off.length, plain.length);
    for (let i = 0; i < off.length; i++) {
      assert.equal(off[i].vertexShader, plain[i].vertexShader);
      assert.equal(off[i].fragmentShader, plain[i].fragmentShader);
      assert.deepEqual(Object.keys(off[i].uniforms).sort(), Object.keys(plain[i].uniforms).sort());
      assert.doesNotMatch(off[i].vertexShader + off[i].fragmentShader, /hwLantern|vLit|HW_CINE/);
      assert.equal(off[i].uniforms.hwLanternCount, undefined);
    }
  });

  test(`${kind}: cinematic on builds the lantern-lit variant`, () => {
    const on = build(kind, true);
    const lit = on.filter((m) => m.vertexShader.includes('hwLanternLight('));
    assert.equal(lit.length, 1, 'exactly the falling-particle material is lantern lit');
    const m = lit[0];
    assert.match(m.vertexShader, /varying vec3 vLit;/);
    assert.match(m.fragmentShader, /varying vec3 vLit;/);
    assert.match(m.fragmentShader, /vLit/);
    assert.equal(m.uniforms.hwLanternCount, LANTERN_UNIFORMS.hwLanternCount);
    assert.equal(m.uniforms.hwLanternPos, LANTERN_UNIFORMS.hwLanternPos);
  });
}
