// Skin and shell colours against samples of the reference sheets (finding 34): the Swamp Ogre's
// hide was a pale mint-cream (CIE L* 70, dE 18 to 22 from ref09) and the Dredge-Bot's steel a light
// grey (L* 59, dE 14 to 17 from ref10). Samples are medians of reference patches (verify2-visual/dE.py):
// ref09 belly and upper chest, ref10 belly panels, and for the bot's rusted default set (ref03) a
// belly panel away from the paint stain.
// Run: node --test client/render/models/pudgy/palette.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOADOUT } from '../../../../shared/cosmetics.ts';
import type { FamilyId, Loadout } from '../../../../shared/types.ts';
import * as THREE from 'three';
import { createPudgy, ENV_LIGHT, pudgyPalette } from '../pudgy.ts';

function lab(hex: number): [number, number, number] {
  const lin = (v: number) => (v / 255 > 0.04045 ? ((v / 255 + 0.055) / 1.055) ** 2.4 : v / 255 / 12.92);
  return labLin(lin((hex >> 16) & 255), lin((hex >> 8) & 255), lin(hex & 255));
}

/** CIE L*a*b* of a linear-sRGB colour (mesh vertex colours are linear). */
function labLin(r: number, g: number, b: number): [number, number, number] {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

function dE(a: number, b: number): number {
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const SAMPLES: Record<'ogre' | 'bot', { bare: number[]; default: number[] }> = {
  ogre: { bare: [0xaa875c, 0x91764b], default: [0xaa875c, 0x91764b] },
  bot: { bare: [0x8f7160, 0x7c6653], default: [0x8f7160, 0x7c6653, 0x54362e] },
};
const MAX_DE = 12;

function skin(family: FamilyId, loadout: Loadout): number {
  return pudgyPalette(family, loadout, 0).skin;
}

for (const family of ['ogre', 'bot'] as const) {
  test(`${family} skin is within dE ${MAX_DE} of the reference sheet (bare base and default set)`, () => {
    for (const [label, lo] of [['bare', {}], ['default', DEFAULT_LOADOUT[family]]] as const) {
      const c = skin(family, lo);
      const ref = SAMPLES[family][label];
      const best = Math.min(...ref.map((s) => dE(c, s)));
      assert.ok(best < MAX_DE, `${family} ${label} skin #${c.toString(16)}: dE ${best.toFixed(1)} from the closest reference sample`);
      // never paler than the reference: the Locker and the game light both brighten what is authored
      assert.ok(lab(c)[0] <= Math.max(...ref.map((s) => lab(s)[0])), `${family} ${label} skin L* ${lab(c)[0].toFixed(1)} is paler than the reference`);
    }
  });
}

/**
 * Median CIE L* of the bare reference sheets' character pixels (ref08 Brawler, ref09 Ogre, ref10 Bot;
 * fix-characters/palette.py: sRGB luminance medians 125, 89 and 73 over the front views).
 */
const SHEET_L: Record<FamilyId, number> = { brawler: 52.3, ogre: 37.8, bot: 31.1 };
const MAX_SHEET_DL = 8;

/** Area-weighted median L* (and the p25 to p75 spread) of every meshed part's vertex colours (AO baked in). */
function bodyValue(family: FamilyId): { p25: number; p50: number; p75: number } {
  const v = createPudgy({ family, loadout: {}, team: 0, name: 'value', isLocal: false, quality: 'high', detail: 'showcase' });
  const samples: [number, number][] = [];
  v.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry.getAttribute('surf')) return;
    const pos = m.geometry.getAttribute('position');
    const col = m.geometry.getAttribute('color');
    const surf = m.geometry.getAttribute('surf');
    for (let q = 0; q + 3 < col.count; q += 4) {
      if (surf.getY(q) > 1.5) continue; // team-coloured voxels are not part of the base palette
      const ax = pos.getX(q + 1) - pos.getX(q), ay = pos.getY(q + 1) - pos.getY(q), az = pos.getZ(q + 1) - pos.getZ(q);
      const bx = pos.getX(q + 3) - pos.getX(q), by = pos.getY(q + 3) - pos.getY(q), bz = pos.getZ(q + 3) - pos.getZ(q);
      const area = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < 4; k++) {
        r += col.getX(q + k) / 4;
        g += col.getY(q + k) / 4;
        b += col.getZ(q + k) / 4;
      }
      samples.push([labLin(r, g, b)[0], area]);
    }
  });
  v.dispose();
  samples.sort((p, q) => p[0] - q[0]);
  const total = samples.reduce((a, s) => a + s[1], 0);
  const at = (f: number) => {
    let acc = 0;
    for (const [l, w] of samples) if ((acc += w) >= total * f) return l;
    return samples[samples.length - 1][0];
  };
  return { p25: at(0.25), p50: at(0.5), p75: at(0.75) };
}

test(`meshed bare bodies sit within ${MAX_SHEET_DL} L* of their reference sheet's median value (Brawler is the control)`, () => {
  // the authored skin alone is not enough: moss coverage, the gunmetal straps and the dark creases
  // all move what the eye reads. Before finding 34 the ogre meshed at L* 54 and the bot at 49.
  const off: string[] = [];
  for (const family of ['brawler', 'ogre', 'bot'] as const) {
    const v = bodyValue(family);
    const d = v.p50 - SHEET_L[family];
    if (Math.abs(d) > MAX_SHEET_DL) off.push(`${family}: median L* ${v.p50.toFixed(1)}, sheet ${SHEET_L[family]} (${d > 0 ? '+' : ''}${d.toFixed(1)})`);
  }
  assert.deepEqual(off, []);
});

test('the swamp ogre keeps a wide value range (dark creases and moss against the tan hide)', () => {
  const v = bodyValue('ogre');
  // ref09 is a checker of tan, olive and deep shadowed voxels; the old hide spread 17 L* (p25 to p75)
  assert.ok(v.p75 - v.p25 >= 19, `ogre p25..p75 spread ${(v.p75 - v.p25).toFixed(1)} L*`);
});

// The Locker's bright studio room environment (preview.ts, environmentIntensity 0.55) laid the same
// grey veil over all three families: Locker median luminance = 0.69 x the reference sheet + 81, and
// saturation about 0.6 x (fix-characters-check/palette.py). With the palettes fixed the remaining
// paleness was this veil, so in showcase detail the body takes only a share of the environment light;
// premium voxels (chrome, gold, crystal) keep all of it for their reflections.
test('showcase bodies take a reduced share of the environment light, premium voxels all of it', () => {
  assert.ok(ENV_LIGHT.showcase > 0 && ENV_LIGHT.showcase <= 0.4, `showcase share ${ENV_LIGHT.showcase}`);
  assert.equal(ENV_LIGHT.game, 1, 'game maps keep their environment light');
  for (const detail of ['showcase', 'game'] as const) {
    const v = createPudgy({ family: 'bot', loadout: { ...DEFAULT_LOADOUT.bot }, team: 0, name: 'env', isLocal: false, quality: 'high', detail });
    let n = 0;
    v.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      const u = m?.userData?.pudgyUniforms as { uEnv?: { value: number } } | undefined;
      if (!u) return;
      n++;
      assert.equal(u.uEnv?.value, ENV_LIGHT[detail], `${detail}: body env share`);
    });
    assert.ok(n > 0, 'pudgy body materials found');
    // the patched shader scales the image-based diffuse and specular light, exempting premium voxels
    let mat: THREE.MeshStandardMaterial | undefined;
    v.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!mat && m?.userData?.pudgyUniforms) mat = m;
    });
    const sh = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    mat!.onBeforeCompile(sh as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
    const fs = sh.fragmentShader;
    const maps = fs.indexOf('#include <lights_fragment_maps>');
    const scale = fs.indexOf('float pudgyEnv = mix(uEnv, 1.0, pudgyPrem);');
    assert.ok(maps > 0 && scale > maps && scale < fs.indexOf('#include <lights_fragment_end>'), 'env share applied after the IBL terms, before they are used');
    assert.ok(fs.includes('iblIrradiance *= pudgyEnv;') && fs.includes('radiance *= pudgyEnv;'));
    assert.ok(fs.indexOf('float pudgyPrem') < scale, 'premium flag decoded first');
    v.dispose();
  }
});
