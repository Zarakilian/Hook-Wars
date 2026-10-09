// Epic (cinematic) terrain must leave the normal tiers untouched: the same terrain shader while cinematic
// mode is off, and an Epic colour pass that never moves the ground units stand on. The Epic variants
// must still find every anchor in the shaders they patch (insertAt throws when one goes missing).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DEFAULT_CONFIG } from '../../../../shared/constants.ts';
import { getMap } from '../../../../shared/maps/index.ts';
import { MAP_IDS, type RiverMode } from '../../../../shared/types.ts';
import { setCinematic } from '../../cinematic.ts';
import { LANTERN_UNIFORMS } from '../../look/lanterns.ts';
import { applyVoxelLook } from '../../look/voxelLook.ts';
import { createBiome } from './biomes/index.ts';
import { SIDE } from './biome.ts';
import { epicBiome, epicStyle } from './epic.ts';
import { newCell, type SideOut } from './field.ts';
import { terrainEpicUniforms, terrainMaterial, terrainUniforms } from './material.ts';
import { buildMist, type MistDef } from './mist.ts';

/** What the renderer compiles for a standard material: its onBeforeCompile run on the stock source. */
function compiled(m: THREE.MeshStandardMaterial): { vs: string; fs: string; uniforms: string[]; key: string } {
  const lib = THREE.ShaderLib.standard;
  const sh = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, defines: m.defines } as unknown as THREE.WebGLProgramParametersWithUniforms;
  m.onBeforeCompile(sh, undefined as unknown as THREE.WebGLRenderer);
  return { vs: sh.vertexShader, fs: sh.fragmentShader, uniforms: Object.keys(sh.uniforms).sort(), key: m.customProgramCacheKey() };
}

const tex = (): THREE.DataTexture => new THREE.DataTexture(new Uint8Array(4), 1, 1);
const look = (epic: boolean) => ({ base: -0.5, epic, uniforms: terrainEpicUniforms([2, 1, 0.8, 0.1], [0.7, 0.16, 4.5, 0.9], -0.5) });

test('normal tiers: the terrain shader is the same with or without the Epic options', () => {
  const plain = compiled(terrainMaterial(tex(), tex(), terrainUniforms()));
  for (const epic of [false, true]) {
    const m = terrainMaterial(tex(), tex(), terrainUniforms(), look(epic));
    // while cinematic mode is off the voxel look only registers the material
    applyVoxelLook(m, epicStyle(getMap('lanternwharf')).near);
    const c = compiled(m);
    assert.equal(c.vs, plain.vs);
    assert.equal(c.fs, plain.fs);
    assert.deepEqual(c.uniforms, plain.uniforms);
    assert.equal(c.key, 'hw-terrain-v3');
    assert.deepEqual(m.defines, new THREE.MeshStandardMaterial().defines);
  }
});

test('Epic: the terrain, lattice and mist variants find every anchor and share the lantern pool', () => {
  setCinematic(true);
  try {
    const m = terrainMaterial(tex(), tex(), terrainUniforms(), look(true));
    applyVoxelLook(m, epicStyle(getMap('lanternwharf')).near);
    const c = compiled(m);
    assert.notEqual(c.key, 'hw-terrain-v3');
    assert.ok(c.vs.includes('vHwVox = (vWPos - vec3(0.0, uHwtBase, 0.0)) / hwVoxA.x;'), 'continuous world lattice');
    for (const s of ['hwtStreaks(', 'hwtGloss', 'hwtCalm', 'uniform vec4 uHwtSpec;']) assert.ok(c.fs.includes(s), s);
    const u = {} as Record<string, unknown>;
    const sh = { uniforms: u, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(sh, undefined as unknown as THREE.WebGLRenderer);
    assert.equal(u.hwLanternPos, LANTERN_UNIFORMS.hwLanternPos);
    assert.equal(u.hwLanternCount, LANTERN_UNIFORMS.hwLanternCount);
    // a match built with cinematic off that turns it on later gets the lattice only (no Epic wet shading)
    const late = compiled(applyVoxelLook(terrainMaterial(tex(), tex(), terrainUniforms(), look(false)), epicStyle(getMap('lanternwharf')).near));
    assert.ok(late.vs.includes('uHwtBase'));
    assert.equal(late.fs.includes('hwtStreaks('), false);
    const defs: MistDef[] = [{ x: 50, y: 0, z: 0, w: 8, h: 2, drift: 0.3, opacity: 0.3 }];
    const mist = buildMist(defs, 0x808080, true)!;
    const mm = mist.mesh.material as THREE.ShaderMaterial;
    assert.ok(mm.vertexShader.includes('hwLanternLight(p)'));
    assert.equal(mm.uniforms.hwLanternPos, LANTERN_UNIFORMS.hwLanternPos);
  } finally {
    setCinematic(false);
  }
  const plainMist = buildMist([{ x: 50, y: 0, z: 0, w: 8, h: 2, drift: 0.3, opacity: 0.3 }], 0x808080)!.mesh.material as THREE.ShaderMaterial;
  assert.equal(plainMist.vertexShader.includes('hwLantern'), false);
  assert.equal(plainMist.uniforms.hwLanternPos, undefined);
});

test('Epic colour pass: colours and roughness only, never a height, quantum, side id, tag or glow', () => {
  const a = newCell();
  const b = newCell();
  const sa: SideOut = { color: 0, rough: 0, emit: 0 };
  const sb: SideOut = { color: 0, rough: 0, emit: 0 };
  for (const id of MAP_IDS) {
    const map = getMap(id);
    for (const riverMode of ['deep', 'dry'] as RiverMode[]) {
      const config = { ...DEFAULT_CONFIG, mapId: id, riverMode };
      const biome = createBiome(map, config);
      const epic = epicBiome(map, config, biome, biome, epicStyle(map));
      assert.equal(epic.base, biome.base);
      let changed = 0;
      for (let z = -map.d / 2 - 6; z <= map.d / 2 + 6; z += 0.61) {
        for (let x = -map.w / 2 - 6; x <= map.w / 2 + 6; x += 0.61) {
          const ix = Math.floor(x / 0.25);
          const iz = Math.floor(z / 0.25);
          biome.sample(x, z, ix, iz, 0.25, a);
          epic.sample(x, z, ix, iz, 0.25, b);
          assert.equal(b.h, a.h, `${id} h at ${x},${z}`);
          assert.equal(b.q, a.q);
          assert.equal(b.side, a.side);
          assert.equal(b.tag, a.tag);
          assert.equal(b.sparkle, a.sparkle);
          assert.equal(b.glow ?? 0, a.glow ?? 0);
          if (b.top !== a.top || b.rough !== a.rough) changed++;
          biome.sideColor(a.side, a.tag, ix, 3, iz, 0, a.h - 0.5, a.h - 0.25, a.h, 0.25, sa);
          epic.sideColor(a.side, a.tag, ix, 3, iz, 0, a.h - 0.5, a.h - 0.25, a.h, 0.25, sb);
          assert.equal(sb.emit, sa.emit);
        }
      }
      assert.ok(changed > 0, `${id}: the Epic pass recolours something`);
    }
  }
});

test('Epic style: the per-pixel lantern streak loop runs on wet night maps only', () => {
  const on = MAP_IDS.filter((id) => epicStyle(getMap(id)).streak[0] > 0);
  assert.ok(on.includes('lanternwharf'));
  for (const id of on) {
    const a = getMap(id).atmosphere;
    assert.ok(a.timeOfDay === 'night' && a.weather !== 'snow', id);
  }
});

test('Epic mist banks stay outside the play area (they never veil a fight)', () => {
  for (const id of ['mirelight', 'muckmire'] as const) {
    const map = getMap(id);
    const style = epicStyle(map);
    assert.ok(style.mist, id);
    const biome = createBiome(map, { ...DEFAULT_CONFIG, mapId: id });
    const defs = style.mist({ map, biome, fullY: 0, halfW: map.w / 2, halfD: map.d / 2 });
    assert.ok(defs.length > 10);
    for (const d of defs) assert.ok(Math.abs(d.x) > map.w / 2 || Math.abs(d.z) > map.d / 2, `${id} bank at ${d.x},${d.z}`);
  }
});

test('Epic snow keeps only a hint of the cube grid (Frostfang read as a tiled floor at calm 0.55)', () => {
  for (const id of ['frostfang', 'aurora'] as const) {
    const map = getMap(id);
    const config = { ...DEFAULT_CONFIG, mapId: id };
    const biome = createBiome(map, config);
    const epic = epicBiome(map, config, biome, biome, epicStyle(map));
    const c = newCell();
    let snow = 0;
    for (let z = -map.d / 2; z <= map.d / 2; z += 0.73) {
      for (let x = -map.w / 2; x <= map.w / 2; x += 0.73) {
        epic.sample(x, z, Math.floor(x / 0.25), Math.floor(z / 0.25), 0.25, c);
        if (c.side !== SIDE.SNOWROCK) continue;
        snow++;
        assert.ok((c.calm ?? 0) >= 0.8, `${id} snow calm ${c.calm} at ${x},${z}`);
      }
    }
    assert.ok(snow > 100, `${id}: snow tops sampled`);
  }
});

test('Epic mist colour: Mirelight banks are lit (its dusk fog colour hid them), Muckmire keeps its own', () => {
  const lum = (c: number) => ((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11;
  const mire = getMap('mirelight');
  const tint = epicStyle(mire).mistColor;
  assert.ok(tint !== undefined && lum(tint) > 2 * lum(mire.atmosphere.fogColor));
  assert.equal(epicStyle(getMap('muckmire')).mistColor, undefined);
});
