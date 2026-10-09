// Epic (cinematic) adoption of the characters and hook skins: nothing changes while cinematic mode is off
// (same program keys, same GLSL, no extra attributes), and while it is on the Lunker and surf shaders get
// the voxel look, the gloss (re-applied after their own roughness decode) and the macro-normal rim.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DEFAULT_LOADOUT } from '../../../../shared/cosmetics.ts';
import { cinematicEnabled, setCinematic } from '../../cinematic.ts';
import { TEAM_COLORS } from '../../contracts.ts';
import { surfMaterial } from '../../fx/sculpt.ts';
import { createPudgy } from '../pudgy.ts';
import { RGrid, atRes, meshPart } from './grid.ts';
import { makePudgyMaterial, makeUniforms } from './material.ts';

function compile(m: THREE.Material): { vs: string; fs: string; uniforms: Record<string, unknown> } {
  const lib = THREE.ShaderLib.standard;
  const sh = { uniforms: {} as Record<string, unknown>, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  m.onBeforeCompile(sh as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
  return { vs: sh.vertexShader, fs: sh.fragmentShader, uniforms: sh.uniforms };
}

test('off: Pudgy and surf materials keep their program keys and GLSL', () => {
  assert.equal(cinematicEnabled(), false);
  const m = makePudgyMaterial(makeUniforms(0.26, 0xffffff, 0.45), false);
  assert.equal(m.customProgramCacheKey(), 'pudgy-surf-v4');
  const { vs, fs, uniforms } = compile(m);
  assert.ok(!vs.includes('pudgyN') && !fs.includes('uPudgyEpic') && !fs.includes('HW_VOXEL_LOOK'));
  assert.equal(uniforms.uPudgyEpic, undefined);
  assert.ok(!('HW_VOXEL_LOOK' in (m.defines ?? {})));
  const s = surfMaterial('base', 0);
  assert.equal(s.customProgramCacheKey(), 'hw-surf-base');
  assert.ok(!compile(s).fs.includes('uSurfEpic'));
  m.dispose();
});

test('off: part geometry has no Epic attributes and units build no level of detail', () => {
  assert.equal(cinematicEnabled(), false);
  const g = atRes(1, () => {
    const r = new RGrid(8, 8, 8, -4, 0, -4);
    r.box(-2, 1, -2, 1, 4, 1, 0x808080);
    return r;
  });
  const geo = meshPart(g, [0, 0, 0]);
  assert.equal(geo.getAttribute('pudgyN'), undefined);
  assert.equal(geo.getAttribute('hwVoxelSize'), undefined);
  const v = createPudgy({ family: 'brawler', loadout: DEFAULT_LOADOUT.brawler, team: 0, name: 'off', isLocal: false, quality: 'high' });
  assert.equal((v as unknown as { _lod?: unknown })._lod, undefined);
  v.dispose();
});

test('a runtime Epic toggle disposes live Pudgy and surf materials (fresh compile, fresh uniforms)', () => {
  // three reuses a material's earlier program with the uniforms of its last compile, so a needsUpdate
  // after Epic -> off -> Epic would leave the Epic-only uniforms stale; dispose() forces onBeforeCompile
  assert.equal(cinematicEnabled(), false);
  const m = makePudgyMaterial(makeUniforms(0.26, 0xffffff, 0.45), false);
  const s = surfMaterial('base', 0);
  let dm = 0;
  let ds = 0;
  m.addEventListener('dispose', () => dm++);
  s.addEventListener('dispose', () => ds++);
  setCinematic(true);
  setCinematic(false);
  assert.equal(dm, 2);
  assert.equal(ds, 2);
  m.dispose();
});

test('on: Epic GLSL, the gloss after the roughness decode, macro normals with bulk', () => {
  setCinematic(true);
  try {
    const m = makePudgyMaterial(makeUniforms(0.26, TEAM_COLORS[1].light, 0.45), false);
    assert.equal(m.customProgramCacheKey(), 'pudgy-surf-v4|epic1|hwvox1|local|u|');
    const { vs, fs } = compile(m);
    assert.ok(vs.includes('attribute vec4 pudgyN;'));
    // the voxel look's roughness jitter is re-applied after the Pudgy decode (which overwrites it)
    const decode = fs.indexOf('roughnessFactor = vSurf.x - 2.0 * pudgyPrem;');
    const again = fs.indexOf('roughnessFactor = clamp(roughnessFactor * (1.0 - 0.4 * hwBev', decode);
    assert.ok(decode > 0 && again > decode, 'gloss and jitter come after the decode');
    assert.ok(fs.includes('uPudgyTeamRim * (uRim * uPudgyEpic2.z * pudgySt)'), 'team rim on the macro normal, as a pixel-wide band');
    // form shading on the macro normal comes after the voxel look's bevel / jitter block, so it keeps both
    const tilt = fs.indexOf('vec2 hwTilt');
    const bend = fs.indexOf('normal = normalize(normal + pudgyK * (pudgyMn - nonPerturbedNormal));');
    const lights = fs.indexOf('#include <lights_fragment_begin>');
    assert.ok(tilt > 0 && bend > tilt && lights > bend, 'macro-normal shading after the voxel look, before the lights');
    // ghosts never adopt the voxel look
    const ghost = makePudgyMaterial(makeUniforms(0.26, 0xffffff), true);
    assert.ok(!('HW_VOXEL_LOOK' in (ghost.defines ?? {})));
    // the Locker / Store / thumbnails (showcase) take the voxel look only, not the in-match extras
    const shown = makePudgyMaterial(makeUniforms(0.38, 0xffffff, 0.08, 0.2), false, 2, false);
    assert.equal(shown.customProgramCacheKey(), 'pudgy-surf-v4|hwvox1|local|u|');
    assert.ok(!compile(shown).fs.includes('uPudgyEpic'));
    shown.dispose();
    // macro normals point outward on a ball and fade (bulk) on a one-voxel strand
    const g = atRes(1, () => {
      const r = new RGrid(24, 24, 24, -12, 0, -12);
      r.blob(0, 8, 0, 6, 6, 6, 0x808080);
      r.box(8, 2, 0, 8, 14, 0, 0x808080);
      return r;
    });
    const geo = meshPart(g, [0, 8, 0]);
    const n = geo.getAttribute('pudgyN') as THREE.BufferAttribute;
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    assert.ok(n && n.normalized && n.itemSize === 4);
    let ballOut = 0;
    let ball = 0;
    let strandBulk = 0;
    let strand = 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      if (x > 0.35) {
        strand++;
        strandBulk += n.getW(i);
      } else if (Math.hypot(x, y, z) > 0.2) {
        ball++;
        if (n.getX(i) * x + n.getY(i) * y + n.getZ(i) * z > 0) ballOut++;
      }
    }
    assert.ok(ballOut / ball > 0.98, `ball normals outward ${ballOut}/${ball}`);
    assert.ok(strandBulk / strand < 0.2, `strand bulk ${(strandBulk / strand).toFixed(2)}`);
    // sculpted hook meshes carry their voxel size while Epic is on
    const s = surfMaterial('ember', 1);
    assert.match(s.customProgramCacheKey(), /^hw-surf-ember\|epic1\|hwvox1\|local\|a\|r$/);
    assert.ok(compile(s).fs.includes('uniform vec4 uSurfEpic;'));
    m.dispose();
    ghost.dispose();
  } finally {
    setCinematic(false);
  }
});
