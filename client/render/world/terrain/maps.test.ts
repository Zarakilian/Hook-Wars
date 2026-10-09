// Map art and map data guards for the four v2 maps (Mirelight, Aurora, Maelstrom, Lanternwharf), and
// the freeze on the four v1 maps (Muckmire, Frostfang, Coral Cove, Cogwater).
// Run: node --test client/render/world/terrain/maps.test.ts
// Re-record the frozen fingerprints (only when a v1 change is intended): HW_WRITE_BASELINE=1 node --test ...
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { DEFAULT_CONFIG } from '../../../../shared/constants.ts';
import { channelDepthAt, platformAt, riverAt, waterDepthAt } from '../../../../shared/maps/helpers.ts';
import { getMap } from '../../../../shared/maps/index.ts';
import type { MapDef, Obstacle, Platform } from '../../../../shared/maps/types.ts';
import { MAP_IDS, type MapId, type RiverMode } from '../../../../shared/types.ts';
import { CameraRig } from '../../../game/camera.ts';
import { waterY } from '../../contracts.ts';
import { createBiome, type MapBiome } from './biomes/index.ts';
import { HeightField, type SideOut } from './field.ts';

// the near and outer fields of terrain.ts (NEAR / OUTER)
const NEAR = { x0: -48, z0: -36, nx: 384, nz: 304, s: 0.25 } as const;
const OUTER = { x0: -112, z0: -96, nx: 224, nz: 160, s: 1 } as const;
const FROZEN: readonly MapId[] = ['muckmire', 'frostfang', 'coralcove', 'cogwater'];
const NEW_MAPS: readonly MapId[] = ['mirelight', 'aurora', 'maelstrom', 'lanternwharf'];
const SIBLING: Record<string, MapId> = { mirelight: 'muckmire', aurora: 'frostfang', maelstrom: 'coralcove', lanternwharf: 'cogwater' };
const MODES: readonly RiverMode[] = ['deep', 'dry', 'tidal'];
const BASELINE = new URL('./maps.baseline.json', import.meta.url);

function cfg(mapId: MapId, riverMode: RiverMode) {
  return { ...DEFAULT_CONFIG, mapId, riverMode };
}

function fields(mapId: MapId, riverMode: RiverMode): { biome: MapBiome; near: HeightField; outer: HeightField } {
  const map = getMap(mapId);
  const biome = createBiome(map, cfg(mapId, riverMode));
  const near = new HeightField(NEAR.x0, NEAR.z0, NEAR.nx, NEAR.nz, NEAR.s);
  near.fill(biome);
  const outer = new HeightField(OUTER.x0, OUTER.z0, OUTER.nx, OUTER.nz, OUTER.s);
  outer.fill(biome, (x, z) => near.contains(x, z));
  return { biome, near, outer };
}

const sha = (h: ReturnType<typeof createHash>) => h.digest('hex').slice(0, 24);

/** Everything a biome hands the renderer: both height fields, side colours and every backdrop / detail rule. */
function biomeFingerprint(mapId: MapId, riverMode: RiverMode): string {
  const { biome, near, outer } = fields(mapId, riverMode);
  const h = createHash('sha1');
  for (const f of [near, outer]) {
    h.update(Buffer.from(f.h.buffer));
    h.update(f.colorData);
    h.update(f.roughData);
    h.update(f.side);
    h.update(f.tag);
  }
  const so: SideOut = { color: 0, rough: 0, emit: 0 };
  for (let side = 0; side < 14; side++)
    for (const tag of [0, 1, 2, 3, 17, 35, 66])
      for (let dir = 0; dir < 4; dir++)
        for (let ix = -3; ix < 9; ix += 2)
          for (let iy = -12; iy < 40; iy += 3)
            for (const cs of [0.25, 1]) {
              const y0 = iy * 0.25;
              biome.sideColor(side, tag, ix * 7 + iy, iy, ix * 3 - iy, dir, y0, y0 + 0.25, y0 + 0.25 + (ix & 3) * 0.5, cs, so);
              h.update(`${so.color},${so.rough.toFixed(4)},${so.emit.toFixed(4)};`);
            }
  const rules = [...biome.backdrop(), ...biome.details('medium'), ...biome.details('high')];
  for (const r of rules) {
    h.update(`${r.model}|${r.spacing}|${r.scale}|${r.castShadow}|${r.waterline}|${r.onWater}|${r.yOffset}|${r.underwater}|${JSON.stringify(r.points ?? null)}`);
    for (let z = -95; z < 64; z += 1.37)
      for (let x = -111; x < 111; x += 1.41) {
        h.update(r.density(x, z).toFixed(4));
        if (r.yaw) h.update(r.yaw(x, z).toFixed(4));
      }
  }
  h.update(JSON.stringify(biome.extraDecor()));
  h.update(JSON.stringify(biome.pools().map((p) => ({ ...p, keep: undefined }))));
  h.update(JSON.stringify(biome.mist?.() ?? null));
  h.update(JSON.stringify(biome.cascades?.() ?? null));
  h.update(JSON.stringify(biome.lamps?.() ?? null));
  h.update(`${biome.sparkle}|${biome.fixedWaterY}|${biome.backwaterHoleZ}|${biome.farColor}|${biome.farY}|${biome.mistColor}|${biome.lampLight}|${biome.lampColor}`);
  for (let z = -95; z < 64; z += 0.93) for (let x = -111; x < 111; x += 0.97) h.update(`${biome.backwaterKeep(x, z) ? 1 : 0}${biome.pathAmount(x, z).toFixed(3)}`);
  return sha(h);
}

/** The sim's water footprint (no decks): what hook reach and bot navigation are built on. */
function waterFingerprint(map: MapDef): string {
  const h = createHash('sha1');
  for (let z = -map.d / 2; z <= map.d / 2; z += 0.25) for (let x = -map.w / 2; x <= map.w / 2; x += 0.25) h.update(waterDepthAt(map, x, z).toFixed(3));
  return sha(h);
}

function currentFingerprints(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of FROZEN) {
    out[`${id}/data`] = sha(createHash('sha1').update(JSON.stringify(getMap(id))));
    for (const m of MODES) out[`${id}/${m}`] = biomeFingerprint(id, m);
  }
  for (const id of MAP_IDS) out[`${id}/water`] = waterFingerprint(getMap(id));
  return out;
}

if (process.env.HW_WRITE_BASELINE) writeFileSync(BASELINE, JSON.stringify(currentFingerprints(), null, 2) + '\n');
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, string>;

test('frozen v1 maps: map data and every terrain field, side colour and backdrop rule are exactly as recorded', () => {
  for (const id of FROZEN) {
    assert.equal(sha(createHash('sha1').update(JSON.stringify(getMap(id)))), baseline[`${id}/data`], `${id} map data changed`);
    for (const m of MODES) assert.equal(biomeFingerprint(id, m), baseline[`${id}/${m}`], `${id} ${m} terrain look changed`);
  }
});

test('every map keeps its deep-water footprint (hook reach and bot navigation are built on it)', () => {
  for (const id of MAP_IDS) assert.equal(waterFingerprint(getMap(id)), baseline[`${id}/water`], `${id} water footprint changed`);
});

// ------------------------------------------------------------------------------------------------
// set pieces that belong in the water (finding 33)

/** Fraction of a deck's footprint that lies over the sim's water. */
function overWater(map: MapDef, p: Platform): number {
  let n = 0;
  let w = 0;
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  for (let a = -p.w / 2; a <= p.w / 2 + 1e-6; a += 0.1)
    for (let b = -p.d / 2; b <= p.d / 2 + 1e-6; b += 0.1) {
      const x = p.x + a * c + b * s;
      const z = p.z - a * s + b * c;
      n++;
      if (waterDepthAt(map, x, z) > 0) w++;
    }
  return w / n;
}

/** Distance (m) from a wall obstacle's footprint to the nearest water (negative: it overlaps the water). */
function wallToWater(map: MapDef, o: Obstacle): number {
  if (o.shape !== 'wall') throw new Error('wall expected');
  let worst = -1e9;
  for (let t = 0; t <= 1.0001; t += 0.05) worst = Math.max(worst, waterDepthAt(map, o.ax + (o.bx - o.ax) * t, o.az + (o.bz - o.az) * t) + o.r);
  return -worst;
}

test('Maelstrom: both pier pairs and the beached shipwreck reach the waterline', () => {
  const map = getMap('maelstrom');
  const piers = (map.platforms ?? []).filter((p) => p.kind === 'pier');
  assert.equal(piers.length, 4);
  for (const p of piers) assert.ok(overWater(map, p) >= 0.18, `pier ${p.x},${p.z} only ${(overWater(map, p) * 100).toFixed(0)}% over water`);
  const wrecks = map.obstacles.filter((o) => o.kind === 'shipwreck');
  assert.equal(wrecks.length, 2);
  for (const o of wrecks) {
    const d = wallToWater(map, o);
    // on the wet sand band right by the water, outside the 0.9 m the obstacle rules keep clear
    assert.ok(d >= 0.9 && d <= 1.3, `shipwreck ${d.toFixed(2)} m from the water`);
  }
});

test('Aurora: every floe deck floats at least partly over the water', () => {
  const map = getMap('aurora');
  const floes = (map.platforms ?? []).filter((p) => p.kind === 'floe');
  assert.equal(floes.length, 4);
  for (const p of floes) assert.ok(overWater(map, p) >= 0.18, `floe ${p.x},${p.z} only ${(overWater(map, p) * 100).toFixed(0)}% over water`);
});

// ------------------------------------------------------------------------------------------------
// the four v2 maps keep the layout rules (scratchpad maps-validate, the parts these fixes touch)

for (const id of NEW_MAPS) {
  test(`${id}: obstacles stay off the water and decks, movers have clear lanes, the river stays hookable`, () => {
    const map = getMap(id);
    const hw2 = map.w / 2;
    const hd2 = map.d / 2;
    const pts = (o: Obstacle) => (o.shape === 'circle' ? [{ x: o.x, z: o.z }] : Array.from({ length: 11 }, (_, i) => ({ x: o.ax + ((o.bx - o.ax) * i) / 10, z: o.az + ((o.bz - o.az) * i) / 10 })));
    const local = (pl: Platform, x: number, z: number) => {
      const c = Math.cos(pl.rot);
      const s = Math.sin(pl.rot);
      return { lx: (x - pl.x) * c - (z - pl.z) * s, lz: (x - pl.x) * s + (z - pl.z) * c };
    };
    for (const o of map.obstacles) {
      let worst = -1e9;
      let onIsland = false;
      for (const p of pts(o)) {
        const isl = map.islands.find((i) => Math.hypot(i.x - p.x, i.z - p.z) < i.r);
        if (isl) {
          onIsland = true;
          assert.ok(Math.hypot(isl.x - p.x, isl.z - p.z) + o.r <= isl.r + 0.25, `${o.kind} overhangs its island`);
          continue;
        }
        worst = Math.max(worst, channelDepthAt(map, p.x, p.z) + o.r);
        for (const pl of map.platforms ?? []) {
          const { lx, lz } = local(pl, p.x, p.z);
          assert.ok(!(Math.abs(lx) < pl.w / 2 + o.r && Math.abs(lz) < pl.d / 2 + o.r), `${o.kind} at ${p.x},${p.z} overlaps ${pl.kind} ${pl.x},${pl.z}`);
        }
      }
      if (!onIsland) assert.ok(worst <= -0.9, `${o.kind} ${JSON.stringify(pts(o)[0])} too close to the water (${(-worst).toFixed(2)} m)`);
    }
    for (const m of map.movers) {
      for (let z = -hd2 - 2; z <= hd2 + 2; z += 0.25) {
        const r = riverAt(map.river.points, z);
        const x = r.x + m.lane * r.hw;
        for (const k of [-1, 0, 1]) {
          const pz = z + (k * m.len) / 2;
          for (const isl of map.islands) assert.ok(Math.hypot(isl.x - x, isl.z - pz) - isl.r - m.r >= 0.05, `${m.kind} lane ${m.lane} hits island ${isl.x},${isl.z}`);
          for (const pl of map.platforms ?? []) {
            if (pl.kind === 'bridge') continue;
            const { lx, lz } = local(pl, x, pz);
            assert.ok(Math.max(Math.abs(lx) - pl.w / 2, Math.abs(lz) - pl.d / 2) - m.r >= 0.05, `${m.kind} lane ${m.lane} hits ${pl.kind} ${pl.x},${pl.z} at z=${pz}`);
          }
          for (const o of map.obstacles) for (const p of pts(o)) assert.ok(Math.hypot(p.x - x, p.z - pz) - o.r - m.r >= 0.05, `${m.kind} lane ${m.lane} hits ${o.kind}`);
          if (Math.abs(pz) < hd2) assert.ok(channelDepthAt({ ...map, islands: [], platforms: [] }, x, pz) - m.r >= 0.05, `${m.kind} lane ${m.lane} scrapes the bank at z=${pz}`);
        }
      }
    }
    // a base hook (16 m) reaches shore to shore, with 0.8 m to spare
    for (let z = -hd2 + 1; z <= hd2 - 1; z += 0.25) {
      const r = riverAt(map.river.points, z);
      const land = (x: number) => channelDepthAt({ ...map, islands: [] }, x, z) <= 0;
      let w = r.x;
      while (w > -hw2 && !land(w)) w -= 0.05;
      let e = r.x;
      while (e < hw2 && !land(e)) e += 0.05;
      assert.ok(e - w <= 16 - 0.8, `river ${(e - w).toFixed(1)} m wide at z=${z}`);
    }
    // ground decor never lands on a deck
    const groundKinds = new Set(['grass', 'reeds', 'fern', 'mushroom', 'flower', 'snowtuft', 'cattail', 'icicles', 'shell', 'starfish', 'pebbles', 'bones', 'coralfan', 'seaweed', 'lilypad']);
    for (const d of map.decor) {
      assert.ok(Math.abs(d.x) <= hw2 + 0.01 && Math.abs(d.z) <= hd2 + 0.01, `decor ${d.kind} outside the map`);
      if (groundKinds.has(d.kind)) assert.ok(!platformAt(map, d.x, d.z), `decor ${d.kind} at ${d.x.toFixed(1)},${d.z.toFixed(1)} sits on a deck`);
    }
  });
}

// ------------------------------------------------------------------------------------------------
// the moon on the rain maps (finding 32)

test('rain maps: the moon is never mirrored on the wet ground into the gameplay camera', () => {
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 1, 500);
  const rig = new CameraRig(camera);
  rig.snapTo(0, 1.2, 0);
  rig.update(1 / 60, 0, 1.2, 0, 0, 0);
  const ray = new THREE.Vector3();
  for (const id of MAP_IDS) {
    const map = getMap(id);
    if (map.atmosphere.weather !== 'rain') continue;
    const L = new THREE.Vector3(...map.atmosphere.sunDir).normalize();
    // the wet ground is a mirror: a camera ray d bounces to (dx, -dy, dz). The highlight sits where that
    // bounce lines up with the light. Rain gloss keeps the lobe within about 25 degrees.
    let best = 180;
    for (let v = -1; v <= 1; v += 0.05)
      for (let u = -1; u <= 1; u += 0.05) {
        ray.set(u, v, 0.5).unproject(camera).sub(camera.position).normalize();
        if (ray.y >= 0) continue;
        const ang = (Math.acos(Math.max(-1, Math.min(1, ray.x * L.x - ray.y * L.y + ray.z * L.z))) * 180) / Math.PI;
        best = Math.min(best, ang);
      }
    assert.ok(best > 40, `${id}: the moon glints ${best.toFixed(0)} degrees from a screen ray (sunDir ${map.atmosphere.sunDir})`);
  }
});

// ------------------------------------------------------------------------------------------------
// the look of the v2 maps (finding 30)

function lab(c: number): [number, number, number] {
  const f = (v: number) => {
    v /= 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const r = f((c >> 16) & 255);
  const g = f((c >> 8) & 255);
  const b = f(c & 255);
  const t = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const X = t((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const Y = t(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = t((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

/**
 * Mean Lab of the drawn column tops in a band of sim channel offsets (c), inside the play area, off decks
 * and plazas. `bed` measures the river bed (under the docks too, away from the islands).
 */
function meanGround(id: MapId, cLo: number, cHi: number, mode: RiverMode = 'deep', bed = false): [number, number, number] {
  const map = getMap(id);
  const { near } = fields(id, mode);
  const acc = [0, 0, 0];
  let n = 0;
  for (let j = 0; j < near.nz; j += 2)
    for (let i = 0; i < near.nx; i += 2) {
      const x = near.x0 + (i + 0.5) * near.s;
      const z = near.z0 + (j + 0.5) * near.s;
      if (Math.abs(x) > map.w / 2 - 0.5 || Math.abs(z) > map.d / 2 - 0.5) continue;
      if (bed ? map.islands.some((q) => Math.hypot(x - q.x, z - q.z) < q.r + 1.5) : platformAt(map, x, z)) continue;
      if (map.fountains.some((f) => Math.hypot(x - f.x, z - f.z) < f.r + 1.4)) continue;
      const c = bed ? waterDepthAt(map, x, z) : channelDepthAt(map, x, z);
      if (c < cLo || c > cHi) continue;
      const t = (i + j * (near.nx + 1)) * 4;
      const L = lab((near.colorData[t] << 16) | (near.colorData[t + 1] << 8) | near.colorData[t + 2]);
      acc[0] += L[0];
      acc[1] += L[1];
      acc[2] += L[2];
      n++;
    }
  return [acc[0] / n, acc[1] / n, acc[2] / n];
}
const dE = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Before the fix (v2 as delivered) the copied bands measured: Aurora ground 0.9, shore 0.7, bed 1.4,
// dry bed 2.3; Maelstrom 3.1 / 3.9 / 1.0 / 2.2; Lanternwharf 6.2 / 6.6 / 0.5 / 0.6; Mirelight shore 9.4,
// bed 2.9 (its moss ground, 11.3, was already its own). A copy reads under about 4; a material of its
// own is 10 or more on the land, 6 or more on the dark river bed.
for (const id of NEW_MAPS) {
  test(`${id}: its ground, shore strip and river bed are not a recolour of ${SIBLING[id]}`, () => {
    const mine = getMap(id);
    const s = SIBLING[id];
    const sib = getMap(s);
    const ground = dE(meanGround(id, -40, -mine.river.bank - 0.5), meanGround(s, -40, -sib.river.bank - 0.5));
    const shore = dE(meanGround(id, -3.5, 0), meanGround(s, -3.5, 0));
    const bed = dE(meanGround(id, 2.6, 40, 'deep', true), meanGround(s, 2.6, 40, 'deep', true));
    const dryBed = dE(meanGround(id, 2.6, 40, 'dry', true), meanGround(s, 2.6, 40, 'dry', true));
    assert.ok(ground >= 10, `open ground only dE ${ground.toFixed(1)} from ${s}`);
    assert.ok(shore >= 10, `shore strip only dE ${shore.toFixed(1)} from ${s}`);
    assert.ok(bed >= 6, `river bed only dE ${bed.toFixed(1)} from ${s}`);
    assert.ok(dryBed >= 6, `dry river bed only dE ${dryBed.toFixed(1)} from ${s}`);
  });
}

/**
 * Share of the drawn column tops in the river channel (off the islands) with a saturated colour (Lab chroma > 40).
 * With `above`, only the columns standing above that water height count as saturated (what a low tide uncovers).
 */
function channelChroma(id: MapId, mode: RiverMode, above = -1e9): number {
  const map = getMap(id);
  const { near } = fields(id, mode);
  let n = 0;
  let sat = 0;
  for (let j = 0; j < near.nz; j++)
    for (let i = 0; i < near.nx; i++) {
      const x = near.x0 + (i + 0.5) * near.s;
      const z = near.z0 + (j + 0.5) * near.s;
      if (Math.abs(x) > map.w / 2 - 0.5 || Math.abs(z) > map.d / 2 - 0.5) continue;
      if (map.islands.some((q) => Math.hypot(x - q.x, z - q.z) < q.r + 1.5) || waterDepthAt(map, x, z) <= 0) continue;
      const t = (i + j * (near.nx + 1)) * 4;
      const L = lab((near.colorData[t] << 16) | (near.colorData[t + 1] << 8) | near.colorData[t + 2]);
      n++;
      if (Math.hypot(L[1], L[2]) > 40 && near.heightAt(x, z) > above) sat++;
    }
  return sat / n;
}

// Maelstrom's lagoon floor carries a coral reef under the water. Drained, that reef in its live colours
// read as confetti (13% of the channel; Coral Cove's floor is 0.5%), so on a Dry Bed, and on Tidal (the
// terrain is baked once and the low tide uncovers 95% of the reef for about half of every cycle), it is
// sparse, sun-bleached bone. Only Deep Water, which never drains, keeps the live reef.
test('Maelstrom: the lagoon floor a Dry Bed or a low tide uncovers is calm, the Deep Water reef keeps its colour', () => {
  const dry = channelChroma('maelstrom', 'dry');
  const lowTide = channelChroma('maelstrom', 'tidal', waterY(getMap('maelstrom'), 0.04));
  const deep = channelChroma('maelstrom', 'deep');
  assert.ok(dry <= 0.03, `Dry Bed: ${(dry * 100).toFixed(1)}% of the drained lagoon floor is coral-coloured`);
  assert.ok(lowTide <= 0.03, `Tidal: the low tide uncovers coral colour on ${(lowTide * 100).toFixed(1)}% of the lagoon floor`);
  assert.ok(deep >= 0.08, `Deep Water: only ${(deep * 100).toFixed(1)}% of the lagoon floor is reef`);
});

test('v2 maps: dry land is always drawn above the full water line (units never stand in drawn water)', () => {
  for (const id of NEW_MAPS) {
    const map = getMap(id);
    for (const mode of MODES) {
      const { near } = fields(id, mode);
      const full = waterY(map, 1);
      let low = 1e9;
      let at = '';
      for (let z = -map.d / 2 + 0.2; z < map.d / 2; z += 0.137)
        for (let x = -map.w / 2 + 0.2; x < map.w / 2; x += 0.131) {
          // under a dock or bridge over water the terrain is the river bed: units stand on the deck there
          if (channelDepthAt(map, x, z) > 0 || waterDepthAt(map, x, z) > 0) continue;
          const h = near.heightAt(x, z);
          if (h < low) {
            low = h;
            at = `${x.toFixed(1)},${z.toFixed(1)}`;
          }
        }
      assert.ok(low >= full + 0.02, `${id}/${mode}: land at ${at} drawn ${(full - low).toFixed(2)} m under the full water line`);
    }
  }
});

test('Mirelight: the puddles hold standing water, and its sheet never floats over drier ground', () => {
  const { biome, near } = fields('mirelight', 'deep');
  const pools = biome.pools();
  assert.equal(pools.length, 1);
  const pool = pools[0];
  assert.equal(pool.wave, 0);
  let quads = 0;
  for (let z = pool.z0 + 0.25; z < pool.z1; z += 0.5)
    for (let x = pool.x0 + 0.25; x < pool.x1; x += 0.5) {
      if (!pool.keep?.(x, z)) continue;
      quads++;
      // every column under the quad is a puddle floor below the water...
      for (const [dx, dz] of [[-0.125, -0.125], [0.125, -0.125], [-0.125, 0.125], [0.125, 0.125]]) assert.ok(near.columnAt(x + dx, z + dz) <= pool.level - 0.04, `puddle floor at ${x + dx},${z + dz} not under the water`);
      // ...and every column round the quad's edge is either puddle floor or a rim above the water
      for (let k = -0.375; k <= 0.376; k += 0.25)
        for (const [px, pz] of [[x + k, z - 0.375], [x + k, z + 0.375], [x - 0.375, z + k], [x + 0.375, z + k]]) {
          const h = near.columnAt(px, pz);
          const floor = (biome as unknown as { puddleAt(x: number, z: number): number }).puddleAt(px, pz) === 2 && h <= pool.level - 0.04;
          assert.ok(floor || h >= pool.level + 0.02, `the water's edge shows over ${px.toFixed(3)},${pz.toFixed(3)} (ground ${(h - pool.level).toFixed(3)} m from the water)`);
        }
    }
  assert.ok(quads > 300, `only ${quads} puddle quads`);
  // dry land everywhere else stays above the full water line (checked for all maps above); the puddle
  // water itself sits well above the river's full line
  assert.ok(pool.level > waterY(getMap('mirelight'), 1) + 0.15);
  // on a Dry Bed there is no water sheet, so there must be no empty, glossy puddle pits either
  const dry = fields('mirelight', 'dry');
  assert.equal(dry.biome.pools().length, 0);
  const wetDeep = fields('mirelight', 'deep');
  let pits = 0;
  let glossy = 0;
  for (let z = pool.z0 + 0.125; z < pool.z1; z += 0.25)
    for (let x = pool.x0 + 0.125; x < pool.x1; x += 0.25) {
      if (!pool.keep?.(x, z)) continue;
      // where Deep Water has a puddle, Dry Bed has plain ground at the moss height, matt
      if (dry.near.columnAt(x, z) < wetDeep.near.columnAt(x, z) + 0.05) pits++;
      const i = Math.floor((x - dry.near.x0) / dry.near.s);
      const j = Math.floor((z - dry.near.z0) / dry.near.s);
      if (dry.near.roughData[(i + j * (dry.near.nx + 1)) * 4 + 1] < 0.6 * 255) glossy++;
    }
  assert.equal(pits, 0, `${pits} dry puddle pits`);
  assert.equal(glossy, 0, `${glossy} glossy columns where the dried puddles were`);
});
