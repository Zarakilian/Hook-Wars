// Terrain, banks, river bed, borders, backdrop, props, decor and fountains for one match.
//
// The ground is a heightfield of voxel columns: 0.25 m columns over the play area and its borders,
// 1 m columns for the outer landscape. One sampled array per field drives both the chunked meshes and
// groundHeight(), so units stand exactly on what is drawn. Each map's look lives in terrain/biomes/*.
import * as THREE from 'three';
import { channelDepthAt, riverAt } from '../../../shared/maps/helpers.ts';
import type { Decor, MapDef } from '../../../shared/maps/types.ts';
import type { HazardInst } from '../../../shared/sim/entities.ts';
import type { MatchConfig, RiverState } from '../../../shared/types.ts';
import { bedY, waterY, type AnimatedView, type Engine, type Quality, type WorldView } from '../contracts.ts';
import { buildDecor, buildProps, createFountainView, disposePropGroup } from '../models/props.ts';
import { buildBackwater, type Backwater } from './terrain/backwater.ts';
import { createBiome, type MapBiome } from './terrain/biomes/index.ts';
import { HeightField, newCell } from './terrain/field.ts';
import { buildFlora, type FloraView } from './terrain/flora.ts';
import { terrainMaterial, terrainUniforms } from './terrain/material.ts';
import { meshChunk } from './terrain/mesher.ts';

/** Fine field: 0.25 m columns. Covers the play area plus the borders the camera sees up close. */
export const NEAR = { x0: -48, z0: -36, nx: 384, nz: 304, s: 0.25 } as const;
/** Coarse field: 1 m columns for the outer landscape. */
export const OUTER = { x0: -112, z0: -96, nx: 224, nz: 160, s: 1 } as const;
const NEAR_CHUNK = 64;
const OUTER_CHUNK = 56;

interface Fields {
  biome: MapBiome;
  near: HeightField;
  outer: HeightField;
  height: (x: number, z: number) => number;
}

function buildFields(map: MapDef, config: MatchConfig): Fields {
  const biome = createBiome(map, config);
  const near = new HeightField(NEAR.x0, NEAR.z0, NEAR.nx, NEAR.nz, NEAR.s);
  near.fill(biome);
  const outer = new HeightField(OUTER.x0, OUTER.z0, OUTER.nx, OUTER.nz, OUTER.s);
  outer.fill(biome, (x, z) => near.contains(x, z));
  const cell = newCell();
  const height = (x: number, z: number): number => {
    if (near.contains(x, z)) return near.heightAt(x, z);
    if (outer.contains(x, z)) {
      const h = outer.heightAt(x, z);
      if (h === h) return h;
    }
    biome.sample(x, z, Math.floor(x), Math.floor(z), 1, cell);
    return cell.h;
  };
  return { biome, near, outer, height };
}

/** Shared ground height function (kept for callers of the slice API). Builds the fields, so cache it. */
export function makeHeightFn(map: MapDef, config?: MatchConfig): (x: number, z: number) => number {
  return buildFields(map, config ?? { mapId: map.id, riverMode: 'deep', hazards: 'none', killsToWin: 30, timeLimitSec: 900, teamSize: 5, botFill: true, botDifficulty: 'normal' }).height;
}

function decorForMode(map: MapDef, config: MatchConfig, biome: MapBiome): Decor[] {
  const out: Decor[] = [];
  const dry = config.riverMode === 'dry';
  for (const d of map.decor) {
    const c = channelDepthAt(map, d.x, d.z);
    if (dry && (d.kind === 'lilypad' || (d.kind === 'seaweed' && c > 0))) continue;
    if ((d.kind === 'grass' || d.kind === 'fern' || d.kind === 'flower' || d.kind === 'snowtuft' || d.kind === 'mushroom') && biome.pathAmount(d.x, d.z) > 0.45) continue;
    out.push(d);
  }
  // lilypads belong on warm water only
  return out.concat(biome.extraDecor().filter((d) => !(d.kind === 'lilypad' && map.id === 'frostfang')));
}

export function buildWorld(map: MapDef, config: MatchConfig, _hazards: HazardInst[], engine: Engine): WorldView {
  const quality: Quality = engine.quality;
  const group = new THREE.Group();
  group.name = 'world';
  const f = buildFields(map, config);
  const { biome, near, outer, height } = f;

  // ---------------------------------------------------------------- terrain meshes
  const u = terrainUniforms();
  u.uRain.value = map.atmosphere.weather === 'rain' ? 1 : 0;
  u.uSparkle.value = biome.sparkle;
  const nt = near.textures();
  const ot = outer.textures();
  const nearMat = terrainMaterial(nt.color, nt.rough, u);
  const outerMat = terrainMaterial(ot.color, ot.rough, u);
  const geos: THREE.BufferGeometry[] = [];
  const nearCast = quality !== 'low';
  // -Z side faces are never seen by the follow camera; they only matter as shadow casters when the
  // sun is on the +Z side (three.js renders back faces into the shadow map)
  const cullAway = map.atmosphere.sunDir[2] < 0;
  const outerCast = quality === 'high' || quality === 'ultra';
  for (let j = 0; j < near.nz; j += NEAR_CHUNK) {
    for (let i = 0; i < near.nx; i += NEAR_CHUNK) {
      const geo = meshChunk(near, biome, i, j, Math.min(near.nx, i + NEAR_CHUNK), Math.min(near.nz, j + NEAR_CHUNK), {
        segH: 0.25,
        aoTop: 0.5,
        aoSide: 0.42,
        floor: (x, z) => outer.columnAt(x, z),
        skirt: 1.5,
        cullAway,
      });
      if (!geo) continue;
      geos.push(geo);
      const m = new THREE.Mesh(geo, nearMat);
      m.receiveShadow = true;
      m.castShadow = nearCast;
      m.name = `terrain-near-${i}-${j}`;
      group.add(m);
    }
  }
  for (let j = 0; j < outer.nz; j += OUTER_CHUNK) {
    for (let i = 0; i < outer.nx; i += OUTER_CHUNK) {
      const geo = meshChunk(outer, biome, i, j, Math.min(outer.nx, i + OUTER_CHUNK), Math.min(outer.nz, j + OUTER_CHUNK), {
        segH: 1,
        aoTop: 0.45,
        aoSide: 0.35,
        floor: (x, z) => (near.contains(x, z) ? near.heightAt(x, z) : NaN),
        skirt: 4,
        cullAway,
      });
      if (!geo) continue;
      geos.push(geo);
      const m = new THREE.Mesh(geo, outerMat);
      m.receiveShadow = true;
      m.castShadow = outerCast;
      m.name = `terrain-outer-${i}-${j}`;
      group.add(m);
    }
  }
  // far fallback ground around the outer field, in case an ultra-wide view peeks past it
  const edgeHs: number[] = [];
  for (let i = 0; i < outer.nx; i += 4) edgeHs.push(outer.h[i], outer.h[i + (outer.nz - 1) * outer.nx]);
  for (let j = 0; j < outer.nz; j += 4) edgeHs.push(outer.h[j * outer.nx], outer.h[outer.nx - 1 + j * outer.nx]);
  edgeHs.sort((a, b) => a - b);
  const farY = Math.min(biome.farY, edgeHs[Math.floor(edgeHs.length / 2)] ?? biome.farY);
  const ox0 = OUTER.x0 + 0.5;
  const ox1 = OUTER.x0 + OUTER.nx - 0.5;
  const oz0 = OUTER.z0 + 0.5;
  const oz1 = OUTER.z0 + OUTER.nz - 0.5;
  const R = 700;
  const ring = [
    [-R, -R, R, oz0],
    [-R, oz1, R, R],
    [-R, oz0, ox0, oz1],
    [ox1, oz0, R, oz1],
  ];
  const rp: number[] = [];
  for (const [a, b, c, d] of ring) rp.push(a, farY, b, a, farY, d, c, farY, d, a, farY, b, c, farY, d, c, farY, b);
  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
  skirtGeo.computeVertexNormals();
  const skirtMat = new THREE.MeshStandardMaterial({ color: biome.farColor, roughness: 1 });
  const skirt = new THREE.Mesh(skirtGeo, skirtMat);
  skirt.name = 'far-ground';
  group.add(skirt);

  // ---------------------------------------------------------------- backdrop water
  const dry = config.riverMode === 'dry';
  const fixedY = dry ? undefined : biome.fixedWaterY;
  const backwaterLevel = (level: number) => (fixedY !== undefined ? fixedY : dry ? bedY(map) - 0.25 : waterY(map, level) - 0.03);
  // The water module draws the river along the full length of map.river.points (to |z| = d/2 + 4),
  // channel plus a bank margin, stopping just behind a waterfall. Leave that footprint to it.
  const pts = map.river.points;
  let rz0 = pts[0].z;
  const rz1 = pts[pts.length - 1].z;
  for (const d of map.decor) if (d.kind === 'waterfall' && d.z < 0) rz0 = Math.max(rz0, d.z - 0.9);
  const rext = Math.min(map.river.bank, 2.4) + 0.4;
  const riverHole = (x: number, z: number) => {
    if (dry || z < rz0 || z > rz1) return false;
    const r = riverAt(pts, z);
    return Math.abs(x - r.x) < r.hw + rext;
  };
  const waters: Backwater[] = [];
  const bw = buildBackwater({
    x0: OUTER.x0,
    x1: OUTER.x0 + OUTER.nx,
    z0: OUTER.z0,
    z1: OUTER.z0 + OUTER.nz,
    hx: map.w / 2,
    hz: biome.backwaterHoleZ ?? map.d / 2,
    cell: 1,
    maxLevel: backwaterLevel(1),
    ground: height,
    colors: { shallow: map.atmosphere.waterShallow, deep: map.atmosphere.waterDeep, foam: map.atmosphere.waterFoam },
    keep: (x, z) => biome.backwaterKeep(x, z),
    hole: riverHole,
  });
  if (bw.mesh) {
    waters.push(bw);
    group.add(bw.mesh);
  }
  for (const pool of dry ? [] : biome.pools()) {
    const p = buildBackwater({ ...pool, hx: 0, hz: 0, cell: 0.5, maxLevel: pool.level, ground: height, colors: { shallow: map.atmosphere.waterShallow, deep: map.atmosphere.waterDeep, foam: map.atmosphere.waterFoam } });
    if (!p.mesh) continue;
    p.u.uLevel.value = pool.level;
    p.u.uWave.value = 0.7;
    waters.push(p);
    group.add(p.mesh);
  }

  // ---------------------------------------------------------------- backdrop flora
  let level = config.riverMode === 'dry' ? 0 : 1;
  const flora: FloraView = buildFlora(biome.backdrop(), {
    ground: height,
    water: () => backwaterLevel(1),
    outside: (x, z) => biome.outside(x, z),
    quality,
    bounds: { x0: OUTER.x0 + 2, x1: OUTER.x0 + OUTER.nx - 2, z0: OUTER.z0 + 2, z1: OUTER.z0 + OUTER.nz - 2 },
    halfW: map.w / 2,
    halfD: map.d / 2,
  }, map.id.length * 101 + 7);
  group.add(flora.group);
  const details: FloraView = buildFlora(biome.details(quality), {
    ground: height,
    water: () => backwaterLevel(1),
    outside: () => 0,
    quality,
    bounds: { x0: -map.w / 2, x1: map.w / 2, z0: -map.d / 2, z1: map.d / 2 },
    halfW: map.w / 2,
    halfD: map.d / 2,
    inside: true,
  }, map.id.length * 53 + 3);
  group.add(details.group);

  // ---------------------------------------------------------------- props, decor, fountains
  const propsGroup = buildProps(map.obstacles, map, height, quality);
  group.add(propsGroup);
  const decorGroup = buildDecor(decorForMode(map, config, biome), map, height, () => waterY(map, level), quality);
  group.add(decorGroup);
  const fountains: AnimatedView[] = [0, 1].map((t) => {
    const c = map.fountains[t];
    const v = createFountainView(t as 0 | 1, c, map, height);
    v.root.position.set(c.x, height(c.x, c.z), c.z);
    group.add(v.root);
    return v;
  });

  // ---------------------------------------------------------------- per frame
  let wetY = dry ? -100 : waterY(map, 1) + 0.02;
  let frozen = 0;
  u.uWetY.value = wetY;
  for (const w of waters.slice(0, bw.mesh ? 1 : 0)) w.u.uLevel.value = backwaterLevel(level);

  return {
    group,
    groundHeight: height,
    update(dt: number, time: number, river: RiverState) {
      level = river.level;
      // wet line: jumps up with the water, dries slowly as it falls
      const target = dry ? -100 : waterY(map, river.level) + 0.02;
      wetY = target > wetY ? target : Math.max(target, wetY - dt * 0.05);
      u.uWetY.value = wetY;
      u.uTime.value = time;
      frozen += ((river.frozen ? 1 : 0) - frozen) * Math.min(1, dt * 1.5);
      for (let i = 0; i < waters.length; i++) {
        const w = waters[i];
        w.u.uTime.value = time;
        if (i === 0 && bw.mesh) {
          w.u.uLevel.value = backwaterLevel(river.level);
          w.u.uFrozen.value = frozen;
        }
      }
      flora.update(time);
      for (const fv of fountains) fv.update(dt, time);
    },
    dispose() {
      for (const g of geos) g.dispose();
      nearMat.dispose();
      outerMat.dispose();
      near.dispose();
      outer.dispose();
      skirtGeo.dispose();
      skirtMat.dispose();
      for (const w of waters) w.dispose();
      flora.dispose();
      details.dispose();
      for (const fv of fountains) fv.dispose();
      disposePropGroup(propsGroup);
      disposePropGroup(decorGroup);
    },
  };
}
