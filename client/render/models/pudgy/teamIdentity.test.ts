// Team identity at the gameplay camera (finding 36): team-coloured voxels carry a self-lit team flag
// so their hue survives tinted map light, and every unit at game detail stands on an unlit ring in
// its team colour (never in the Locker or thumbnails, hidden on corpses and see-through units).
// Run: node --test client/render/models/pudgy/teamIdentity.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEFAULT_LOADOUT } from '../../../../shared/cosmetics.ts';
import type { FamilyId, Team } from '../../../../shared/types.ts';
import { UnitState } from '../../../../shared/types.ts';
import { TEAM_COLORS, type PudgyAnimInput } from '../../contracts.ts';
import { createPudgy, TEAM_GLOW } from '../pudgy.ts';
import { makePudgyMaterial, makeUniforms } from './material.ts';

const FAMILIES: FamilyId[] = ['brawler', 'ogre', 'bot'];
const alive: PudgyAnimInput = { state: UnitState.Alive, speed: 0, hpFrac: 1, flags: 0, hookOut: false, stateTime: 0, time: 0 };

function view(family: FamilyId, team: Team, detail: 'game' | 'showcase') {
  return createPudgy({ family, loadout: { ...DEFAULT_LOADOUT[family] }, team, name: 't', isLocal: false, quality: 'high', detail });
}

test('every unit at game detail stands on a ring in its team colour; the Locker never shows one', () => {
  for (const family of FAMILIES)
    for (const team of [0, 1] as Team[]) {
      const g = view(family, team, 'game');
      const ring = g.root.getObjectByName('pudgy-team-ring') as THREE.Mesh | undefined;
      assert.ok(ring, `${family} team ${team}: no team ring`);
      assert.equal(ring.parent, g.root, 'the ring hangs off the root, not the squashing rig');
      const m = ring.material as THREE.MeshBasicMaterial;
      assert.equal(m.color.getHex(THREE.SRGBColorSpace), TEAM_COLORS[team].main, 'ring in the team colour');
      assert.equal(m.depthWrite, false);
      assert.ok(!(m as unknown as THREE.MeshStandardMaterial).isMeshStandardMaterial, 'unlit, so map light cannot shift its hue');
      // the ring sits outside the body footprint so its front arc shows from the 54 degree camera
      ring.geometry.computeBoundingBox();
      const half = ring.geometry.boundingBox!.max.x;
      assert.ok(half > 0.9 && half < 1.3, `ring plane half size ${half}`);
      g.dispose();
      const s = view(family, team, 'showcase');
      assert.equal(s.root.getObjectByName('pudgy-team-ring'), undefined, `${family}: no ring in the Locker`);
      s.dispose();
    }
});

test('the ring hides on corpses, drowning and see-through (stealthed) units', () => {
  const g = view('ogre', 1, 'game');
  const ring = g.root.getObjectByName('pudgy-team-ring')!;
  g.update(1 / 60, alive);
  assert.equal(ring.visible, true);
  g.setOpacity(0.4);
  assert.equal(ring.visible, false, 'stealthed: hidden');
  g.setOpacity(1);
  assert.equal(ring.visible, true);
  g.update(1 / 60, { ...alive, state: UnitState.Drowning });
  assert.equal(ring.visible, false, 'drowning: hidden');
  g.update(1 / 60, { ...alive, state: UnitState.Dead, hpFrac: 0 });
  assert.equal(ring.visible, false, 'dead: hidden');
  g.update(1 / 60, { ...alive, state: UnitState.Hooked, hpFrac: 0 });
  assert.equal(ring.visible, false, 'a corpse being reeled in: hidden');
  g.update(1 / 60, alive);
  assert.equal(ring.visible, true, 'back after a respawn');
  g.dispose();
});

test('the ring never floats: hidden while the unit is off the ground (dragged, knocked, grappling)', () => {
  // GameClient puts the root at ground + the sim's unit height: 0.35 m while dragged on a hook,
  // an arc up to about 1.4 m while knocked back or flying to a grapple anchor
  for (const family of FAMILIES) {
    const g = view(family, 0, 'game');
    const ring = g.root.getObjectByName('pudgy-team-ring')!;
    for (const [state, label] of [[UnitState.Hooked, 'dragged on a hook'], [UnitState.Knocked, 'knocked back'], [UnitState.Grappling, 'flying to a grapple']] as const) {
      g.update(1 / 60, alive);
      assert.equal(ring.visible, true, `${family}: shown on the ground`);
      g.update(1 / 60, { ...alive, state, speed: 8 });
      assert.equal(ring.visible, false, `${family} ${label}: hidden`);
    }
    g.update(1 / 60, { ...alive, state: UnitState.Casting, castKind: 'hook' });
    assert.equal(ring.visible, true, `${family}: casting is rooted on the ground, ring shown`);
    g.dispose();
  }
});

/** surf.y > 1.5 flags a team voxel (grid.ts TEAM_BIT); returns flagged and unflagged vertex colours (sRGB 0..1). */
function flagged(root: THREE.Object3D): { team: THREE.Color[]; other: number } {
  const team: THREE.Color[] = [];
  let other = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry.getAttribute('surf')) return;
    const surf = m.geometry.getAttribute('surf');
    const col = m.geometry.getAttribute('color');
    for (let i = 0; i < surf.count; i += 4) {
      if (surf.getY(i) > 1.5) team.push(new THREE.Color().setRGB(col.getX(i), col.getY(i), col.getZ(i), THREE.LinearSRGBColorSpace));
      else other++;
    }
  });
  return { team, other };
}

test('team trims carry the self-lit team flag, and only team-coloured voxels do', () => {
  for (const family of FAMILIES)
    for (const team of [0, 1] as Team[]) {
      const g = view(family, team, 'game');
      const f = flagged(g.root);
      const share = f.team.length / (f.team.length + f.other);
      assert.ok(share > 0.01 && share < 0.25, `${family} team ${team}: team share ${share.toFixed(3)}`);
      // flagged voxels are team coloured: red-dominant on Red Tide, blue-dominant on Blue Gill
      let match = 0;
      const hsl = { h: 0, s: 0, l: 0 };
      for (const c of f.team) {
        c.getHSL(hsl, THREE.SRGBColorSpace);
        const deg = hsl.h * 360;
        const red = deg < 25 || deg > 340;
        const blue = deg > 195 && deg < 230;
        if (team === 0 ? red : blue) match++;
      }
      assert.ok(match / f.team.length > 0.9, `${family} team ${team}: ${match}/${f.team.length} flagged faces in the team hue`);
      g.dispose();
    }
});

test('the team glow is on in game and only a touch in the Locker', () => {
  assert.ok(TEAM_GLOW.game >= 0.3, 'game team glow');
  assert.ok(TEAM_GLOW.showcase < TEAM_GLOW.game / 3, 'showcase team glow');
  const u = makeUniforms(0.26, 0xffffff, TEAM_GLOW.game);
  assert.equal(u.uTeamGlow.value, TEAM_GLOW.game);
  // the patched shader decodes the flag before the emissive term uses it
  const m = makePudgyMaterial(u, false);
  const sh = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  m.onBeforeCompile(sh as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
  const fs = sh.fragmentShader;
  const dec = fs.indexOf('float pudgyTeam = step(1.5, vSurf.y);');
  const use = fs.indexOf('pudgyTeam * uTeamGlow');
  assert.ok(dec > 0 && use > dec, 'team flag decoded, then added to the emissive term');
  assert.ok(fs.includes('metalnessFactor = vSurf.y - 2.0 * pudgyTeam;'), 'flag stripped from metalness');
  assert.ok(fs.includes('uniform float uTeamGlow;'));
  assert.equal(sh.uniforms.uTeamGlow, u.uTeamGlow);
  m.dispose();
});
