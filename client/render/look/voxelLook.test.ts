// The voxel look must not touch a material while cinematic mode is off, must patch it (chaining the
// material's own hook and cache key) while on, and must restore it exactly when cinematic turns off.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { cinematicEnabled, setCinematic } from '../cinematic.ts';
import { applyVoxelLook, injectVoxelLook, voxelLookStats } from './voxelLook.ts';

function standardShader(): THREE.WebGLProgramParametersWithUniforms {
  const lib = THREE.ShaderLib.standard;
  return { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

test('off: applyVoxelLook only registers the material', () => {
  assert.equal(cinematicEnabled(), false);
  const m = new THREE.MeshStandardMaterial({ vertexColors: true });
  const hook = m.onBeforeCompile;
  const defines = JSON.stringify(m.defines);
  const version = m.version;
  applyVoxelLook(m, { voxelSize: 0.05 });
  assert.equal(m.onBeforeCompile, hook);
  assert.equal(Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey'), false);
  assert.equal(JSON.stringify(m.defines), defines);
  assert.equal(m.version, version);
});

test('on: patches and chains the existing hook; off: restores it', () => {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true });
  let ran = 0;
  const own = (s: THREE.WebGLProgramParametersWithUniforms) => {
    ran++;
    s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n// own patch');
  };
  m.onBeforeCompile = own;
  m.customProgramCacheKey = () => 'own-key';
  applyVoxelLook(m, { voxelSize: 0.25, space: 'world', rim: 0.5 });
  setCinematic(true);
  try {
    assert.notEqual(m.onBeforeCompile, own);
    assert.match(m.customProgramCacheKey(), /^own-key\|hwvox1\|world\|u\|r$/);
    assert.ok('HW_VOXEL_LOOK' in (m.defines as object));
    const sh = standardShader();
    m.onBeforeCompile(sh, undefined as unknown as THREE.WebGLRenderer);
    assert.equal(ran, 1);
    assert.ok(sh.fragmentShader.includes('// own patch'));
    assert.ok(sh.fragmentShader.includes('vHwVox'));
    assert.ok(sh.vertexShader.includes('hwW = modelMatrix * hwW'));
    assert.ok(sh.fragmentShader.includes('#define HW_VOX_RIM'));
    assert.ok(voxelLookStats().patched >= 1);
  } finally {
    setCinematic(false);
  }
  assert.equal(m.onBeforeCompile, own);
  assert.equal(m.customProgramCacheKey(), 'own-key');
  assert.equal('HW_VOXEL_LOOK' in (m.defines as object), false);
});

test('inject works on the stock standard shader in both size modes', () => {
  for (const voxelSize of [0.1, 'attribute'] as const) {
    const sh = standardShader();
    const ok = injectVoxelLook(sh, { opts: { voxelSize, fallbackSize: 0.1, space: 'local', shift: 0.25, seam: 0.3, bevel: 0.15, tilt: 0.6, glint: 0.5, tile: 0.05, rim: 0 }, uA: { value: new THREE.Vector4() }, uB: { value: new THREE.Vector4() } });
    assert.ok(ok);
    assert.equal(sh.vertexShader.includes('#define HW_VOX_ATTR'), voxelSize === 'attribute');
    for (const k of ['hwVoxA', 'hwVoxB', 'hwLookRim', 'hwLookOn']) assert.ok(k in sh.uniforms);
  }
});
