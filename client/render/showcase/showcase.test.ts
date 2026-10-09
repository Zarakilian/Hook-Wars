// Showcase stage: the backdrop must hand the engine back exactly what it borrowed, and the theme
// layouts must keep the rules the look depends on (props without the night rim variant, the Lunker on
// a deck, mist veils clear of every prop, the camera's near plane clear of the foreground).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { getMap } from '../../../shared/maps/index.ts';
import { resolveAtmosphere } from '../engine/atmosphere.ts';
import { createSkyUniforms } from '../engine/sky.ts';
import { EnvSwap, HostLook, type HostLookValues } from './hostLook.ts';
import { slabGrid } from './landmarks.ts';
import { SHOWCASE_THEMES, THEMES, mistVeils, sheenSurfaces, stageMap, themeAtmosphere, themeForMap } from './themes.ts';

function engineLike() {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffa35a, 2.4);
  sun.name = 'HW.Sun';
  sun.position.set(0.36, 0.06, -1).multiplyScalar(60);
  const hemi = new THREE.HemisphereLight(0x223355, 0x221111, 0.71);
  scene.add(hemi, sun, sun.target);
  scene.fog = new THREE.FogExp2(0xe08a68, 0.0022);
  const env = new THREE.Texture();
  scene.environment = env;
  scene.environmentIntensity = 0.24;
  const sky = createSkyUniforms();
  return { scene, sun, hemi, sky, env };
}

function themeValues(): HostLookValues {
  const t = THEMES.harbourNight;
  const atmo = resolveAtmosphere(themeAtmosphere(getMap(t.map), t), false);
  return {
    sky: atmo.sky,
    sunColor: new THREE.Color(0x9ab4ff),
    sunIntensity: 1.1,
    sunDir: new THREE.Vector3(0.9, 0.45, -0.05).normalize(),
    hemiSky: new THREE.Color(t.hemi.sky),
    hemiGround: new THREE.Color(t.hemi.ground),
    hemiIntensity: t.hemi.intensity,
    fogColor: new THREE.Color(t.fog.color),
    fogDensity: t.fog.density,
    environment: new THREE.Texture(),
    envIntensity: t.envIntensity,
  };
}

function snapshot(e: ReturnType<typeof engineLike>) {
  return JSON.stringify({
    sun: [e.sun.color.getHex(), e.sun.intensity, e.sun.position.toArray()],
    hemi: [e.hemi.color.getHex(), e.hemi.groundColor.getHex(), e.hemi.intensity],
    fog: [(e.scene.fog as THREE.FogExp2).color.getHex(), (e.scene.fog as THREE.FogExp2).density],
    env: [e.scene.environment === e.env, e.scene.environmentIntensity],
    sky: Object.fromEntries(Object.entries(e.sky).map(([k, u]) => [k, (u.value as { toArray?: () => number[] }).toArray ? (u.value as { toArray: () => number[] }).toArray() : u.value])),
  });
}

test('HostLook: apply writes the theme, restore gives the engine back exactly what it had', () => {
  const e = engineLike();
  const before = snapshot(e);
  const h = new HostLook(e.scene, e.sky);
  const v = themeValues();
  h.apply(v, new THREE.Vector3());
  h.apply(v, new THREE.Vector3());
  assert.equal(e.sun.intensity, 1.1);
  assert.equal(e.scene.environment, v.environment);
  assert.notEqual(snapshot(e), before);
  h.restore();
  assert.equal(snapshot(e), before);
});

test('HostLook: a value the engine rewrote meanwhile becomes the new snapshot, and is not overwritten on restore', () => {
  const e = engineLike();
  const h = new HostLook(e.scene, e.sky);
  const v = themeValues();
  h.apply(v, new THREE.Vector3());
  // the engine re-applies only part of its atmosphere (setQuality / a cinematic toggle): fog and fill
  (e.scene.fog as THREE.FogExp2).density = 0.005;
  e.hemi.intensity = 0.9;
  h.apply(v, new THREE.Vector3());
  h.restore();
  // fog and fill go back to the engine's newer values, sun and sky to its original ones
  assert.equal((e.scene.fog as THREE.FogExp2).density, 0.005);
  assert.equal(e.hemi.intensity, 0.9);
  assert.equal(e.sun.intensity, 2.4);
  assert.equal(e.scene.environment, e.env);
  // the engine takes over everything at a match start: restore must then change nothing
  h.apply(v, new THREE.Vector3());
  e.sun.intensity = 3;
  (e.scene.fog as THREE.FogExp2).density = 0.016;
  const engineNow = snapshot(e);
  h.restore();
  assert.equal(JSON.parse(snapshot(e)).sun[1], 3);
  assert.equal(JSON.parse(snapshot(e)).fog[1], 0.016);
  assert.notEqual(engineNow, '');
});

test('themes: props are built without the night / dusk rim variant, the look keeps its time of day', () => {
  for (const id of SHOWCASE_THEMES) {
    const t = THEMES[id];
    const base = getMap(t.map);
    assert.equal(stageMap(base, t).atmosphere.timeOfDay, 'day', id);
    assert.equal(themeAtmosphere(base, t).timeOfDay, base.atmosphere.timeOfDay, id);
    assert.equal(stageMap(base, t).atmosphere.weather, 'none', id);
    // map-wide procedural decor keeps a margin of 0.8 m from the map's edge: a 1 m map leaves no room
    assert.ok(stageMap(base, t).w / 2 < 0.8 && stageMap(base, t).d / 2 < 0.8, id + ': stage map extent');
  }
  assert.equal(themeForMap('lanternwharf'), 'harbourNight');
  assert.equal(themeForMap('mirelight'), 'bayouSunset');
  assert.equal(themeForMap('aurora'), 'frozenHarbour');
  assert.equal(themeForMap('maelstrom'), 'lagoonDay');
});

test('themes: the Lunker stands on a deck and the foreground clears the camera', () => {
  for (const id of SHOWCASE_THEMES) {
    const t = THEMES[id];
    const L = t.lunker;
    const onDeck = t.platforms.some((p) => {
      const c = Math.cos(p.rot);
      const s = Math.sin(p.rot);
      const lx = (L.x - p.x) * c - (L.z - p.z) * s;
      const lz = (L.x - p.x) * s + (L.z - p.z) * c;
      return Math.abs(lx) <= p.w / 2 - 0.5 && Math.abs(lz) <= p.d / 2 - 0.5;
    });
    assert.ok(onDeck, id + ': Lunker off the deck');
    for (const o of t.obstacles) {
      if (o.shape !== 'circle') continue;
      // the camera sits about 4 m in front of the Lunker (+z); nothing may stand within 1.2 m of it
      assert.ok(Math.hypot(o.x - L.x, o.z - (L.z + 4)) > 1.2 + o.r, `${id}: ${o.kind} at the camera`);
    }
  }
});

test('themes: every floe and other deck floats clear of the dock (its ridges included), with open water between', () => {
  for (const id of SHOWCASE_THEMES) {
    const t = THEMES[id];
    const dock = t.platforms.find((p) => p.kind === 'dock');
    assert.ok(dock && dock.rot === 0, id + ': the stage dock is axis-aligned');
    const L = dock.x - dock.w / 2;
    const R = dock.x + dock.w / 2;
    const B = dock.z - dock.d / 2;
    const F = dock.z + dock.d / 2;
    for (const p of t.platforms) {
      if (p === dock) continue;
      // a floe's pressure ridges and icicles stand 2 voxels (0.16 m) proud of its rectangle
      const hw = p.w / 2 + 0.16;
      const hd = p.d / 2 + 0.16;
      const c = Math.abs(Math.cos(p.rot));
      const s = Math.abs(Math.sin(p.rot));
      const ex = hw * c + hd * s;
      const ez = hw * s + hd * c;
      const gap = 0.15;
      const clear = p.x - ex > R + gap || p.x + ex < L - gap || p.z - ez > F + gap || p.z + ez < B - gap;
      assert.ok(clear, `${id}: ${p.kind} at (${p.x}, ${p.z}) touches the dock`);
    }
  }
});

test('the wet sheen never lands on snow: bare decks and quays stay wet, snow banks and snowed decks are dry', () => {
  for (const id of SHOWCASE_THEMES) {
    const t = THEMES[id];
    const wet = sheenSurfaces(t);
    for (const s of wet.slabs) assert.ok(!s.style.soft && !s.onDeck, `${id}: sheen on snow`);
    if (!(t.sheen > 0)) assert.equal(wet.platforms.length + wet.slabs.length, 0, id + ': a dry theme has no sheen');
  }
  // the frozen harbour is all snow (bank, far shore and a snow sheet over the dock): nothing is wet
  const frozen = sheenSurfaces(THEMES.frozenHarbour);
  assert.equal(frozen.platforms.length + frozen.slabs.length, 0);
  // the night harbour keeps its wet planks and granite quays
  const harbour = sheenSurfaces(THEMES.harbourNight);
  assert.ok(harbour.platforms.some((p) => p.kind === 'dock'));
  assert.equal(harbour.slabs.length, THEMES.harbourNight.slabs.length);
});

test('mist veils clear every prop across their width and stay above the ground', () => {
  for (const id of SHOWCASE_THEMES) {
    const t = THEMES[id];
    const flat = () => 1;
    const veils = mistVeils(t, flat, 1);
    assert.ok(veils.filter((v) => v.upright).length >= t.mist.rows.length, id + ': rows dropped');
    for (const v of veils) {
      if (!v.upright) continue;
      assert.ok(v.y >= 1.3 - 1e-9, id + ': veil below the ground');
      for (const o of t.obstacles) {
        const x0 = o.shape === 'circle' ? o.x - o.r : Math.min(o.ax, o.bx) - o.r;
        const x1 = o.shape === 'circle' ? o.x + o.r : Math.max(o.ax, o.bx) + o.r;
        const z0 = o.shape === 'circle' ? o.z - o.r : Math.min(o.az, o.bz) - o.r;
        const z1 = o.shape === 'circle' ? o.z + o.r : Math.max(o.az, o.bz) + o.r;
        if (x1 < v.x - v.w / 2 || x0 > v.x + v.w / 2) continue;
        assert.ok(v.z < z0 - 0.4 || v.z > z1 + 0.4, `${id}: veil at z ${v.z.toFixed(2)} cuts ${o.kind} at ${z0.toFixed(1)}..${z1.toFixed(1)}`);
      }
    }
  }
});

test('EnvSwap (preview mode): the host turntable gets its own environment back when the stage lets go', () => {
  const scene = new THREE.Scene();
  const room = new THREE.Texture();
  scene.environment = room;
  scene.environmentIntensity = 0.55;
  const swap = new EnvSwap(scene);
  const night = new THREE.Texture();
  swap.set(night, 0.45);
  assert.equal(scene.environment, night);
  assert.equal(scene.environmentIntensity, 0.45);
  // a theme change: the next theme's environment replaces ours, the saved room stays the restore target
  const frost = new THREE.Texture();
  swap.release(night);
  assert.equal(scene.environment, room);
  swap.set(frost, 0.6);
  swap.release(frost);
  assert.equal(scene.environment, room);
  assert.equal(scene.environmentIntensity, 0.55);
  // the host replaced the environment itself: release leaves the host's choice alone
  swap.set(night, 0.45);
  const mine = new THREE.Texture();
  scene.environment = mine;
  swap.release(night);
  assert.equal(scene.environment, mine);
});

test('slab caps grow in patches, never as scattered single voxels, and keep clear of the Lunker spot', () => {
  for (const id of SHOWCASE_THEMES) {
    for (const sd of THEMES[id].slabs) {
      if (sd.style.cap <= 0) continue;
      const nx = Math.max(1, Math.round((sd.x1 - sd.x0) / sd.voxel));
      const nz = Math.max(1, Math.round((sd.z1 - sd.z0) / sd.voxel));
      const ny = Math.max(1, Math.round(sd.depth / sd.voxel));
      const L = THEMES[id].lunker;
      const keep = { x: (L.x - sd.x0) / sd.voxel, z: (L.z - sd.z0) / sd.voxel, r: 0.85 / sd.voxel };
      const g = slabGrid(nx, ny, nz, sd.style, sd.seed, [keep]);
      // a cap voxel is any voxel above the slab's full top
      let caps = 0;
      let lonely = 0;
      const cap = (x: number, z: number) => x >= 0 && z >= 0 && x < nx && z < nz && g.solid(x, ny, z);
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
          if (!cap(x, z)) continue;
          caps++;
          if (!cap(x - 1, z) && !cap(x + 1, z) && !cap(x, z - 1) && !cap(x, z + 1)) lonely++;
          assert.ok(Math.hypot(x + 0.5 - keep.x, z + 0.5 - keep.z) > keep.r, `${id}: a drift under the Lunker`);
        }
      assert.ok(caps > 0, id + ': no cap at all');
      assert.ok(lonely / caps < 0.05, `${id}: ${lonely} of ${caps} cap voxels stand alone`);
    }
  }
});

test('a snow sheet laid on the deck covers the Lunker spot (he stands on its top, not buried in it)', () => {
  const t = THEMES.frozenHarbour;
  const sheet = t.slabs.find((s) => s.onDeck);
  assert.ok(sheet, 'frozen harbour: no snow sheet on the dock');
  assert.ok(t.lunker.x >= sheet.x0 + 1 && t.lunker.x <= sheet.x1 - 1 && t.lunker.z >= sheet.z0 + 1 && t.lunker.z <= sheet.z1 - 1, 'the sheet does not reach under the Lunker');
  assert.ok(sheet.top > 0 && sheet.top < 0.2, 'sheet thickness');
});
