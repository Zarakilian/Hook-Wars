// buildProps: every blocking obstacle as a voxel model sized to its collision shape, drawn through
// StaticBatch (one BatchedMesh per material, culled per instance in the camera and shadow passes).
import * as THREE from 'three';
import type { MapDef, Obstacle, PropKind } from '../../../../shared/maps/types.ts';
import { bedY, type HeightFn, type Quality } from '../../contracts.ts';
import { StaticBatch, tickMesh } from './batch.ts';
import { autoClock, cachedModel, moodOf, propsQuality, qLevel, trs, type PropModel } from './common.ts';
import { buildBarrel, buildBollard, buildCrate, buildLamppost, buildPipe } from './harbour.ts';
import { themeOf, type Theme } from './kit.ts';
import { buildCratePile, buildSeastack, buildShipwreck } from './lagoon.ts';
import { buildLanternPost, buildStiltHut, buildSwampStump } from './marsh.ts';
import { buildCoralRock, buildIcePillar, buildIceRock, buildMossRock, buildReefPost, buildRunestone, buildTikiTotem } from './rocks.ts';
import { buildIceShelf, buildSnowPine, buildWatchtower } from './snowy.ts';
import { buildCypress, buildDeadTree, buildPalm, buildPine, buildStump } from './trees.ts';
import { buildWall } from './walls.ts';
import { buildBridgePier, buildCrane, buildGasLamp, buildWarehouse } from './wharf.ts';

/** What a builder may know about where it stands. */
export interface PropCtx {
  map: MapDef;
  theme: Theme;
  /** metres from the model origin down to the river bed (bridge piers and sea stacks reach it) */
  below: number;
}

type CircleBuilder = (r: number, seed: number, ctx: PropCtx) => PropModel;
type WallBuilder = (length: number, r: number, h: number, seed: number, ctx: PropCtx) => PropModel;

const CIRCLE_BUILDERS: Partial<Record<PropKind, CircleBuilder>> = {
  cypress: buildCypress,
  deadtree: buildDeadTree,
  mossrock: buildMossRock,
  stump: buildStump,
  pine: buildPine,
  icerock: buildIceRock,
  icepillar: buildIcePillar,
  runestone: buildRunestone,
  palm: buildPalm,
  coralrock: buildCoralRock,
  reefpost: buildReefPost,
  tikitotem: buildTikiTotem,
  crate: buildCrate,
  barrel: buildBarrel,
  bollard: buildBollard,
  lamppost: buildLamppost,
  pipe: buildPipe,
  // reference maps
  stilthut: buildStiltHut,
  swampstump: buildSwampStump,
  lanternpost: buildLanternPost,
  watchtower: buildWatchtower,
  snowpine: buildSnowPine,
  iceshelf: buildIceShelf,
  seastack: buildSeastack,
  cratepile: buildCratePile,
  crane: buildCrane,
  gaslamp: buildGasLamp,
  bridgepier: buildBridgePier,
};

const WALL_BUILDERS: Partial<Record<PropKind, WallBuilder>> = {
  shipwreck: buildShipwreck,
  warehouse: buildWarehouse,
};

/** Kinds whose model depends on the map (theme palette or the depth to the bed). */
const MAP_DEPENDENT = new Set<PropKind>(['lanternpost', 'cratepile', 'bridgepier', 'seastack', 'stilthut', 'watchtower', 'crane', 'gaslamp', 'shipwreck', 'warehouse']);
/** Kinds that need the depth to the bed in their cache key. */
const DEEP = new Set<PropKind>(['bridgepier', 'seastack', 'watchtower', 'shipwreck']);
/** Directional kinds: their front (+Z) faces the river so arms, jibs and doors reach over the water. */
const FACE_RIVER = new Set<PropKind>(['stilthut', 'lanternpost', 'crane', 'gaslamp', 'bridgepier', 'watchtower']);

function ctxFor(map: MapDef, below: number): PropCtx {
  return { map, theme: themeOf(map), below };
}

function circleModel(kind: PropKind, r: number, seed: number, ctx: PropCtx): PropModel {
  const b = CIRCLE_BUILDERS[kind] ?? buildMossRock;
  const mapKey = MAP_DEPENDENT.has(kind) ? ctx.map.id : '';
  const deep = DEEP.has(kind) ? ctx.below.toFixed(1) : '';
  return cachedModel(`c|${kind}|${r.toFixed(2)}|${seed}|${mapKey}|${deep}`, () => b(r, seed, ctx));
}

export function buildPropsImpl(obstacles: Obstacle[], map: MapDef, height: HeightFn, quality?: Quality): THREE.Group {
  const t0 = performance.now();
  const q = propsQuality(quality);
  const shadows = qLevel(q) >= 1;
  const group = new THREE.Group();
  group.name = 'props';
  const batch = new StaticBatch(moodOf(map.atmosphere), true);
  const by = bedY(map);
  for (const o of obstacles) {
    const seed = o.seed ?? 1;
    if (o.shape === 'circle') {
      // sit on the lowest ground under the footprint so nothing floats on slopes
      let y = height(o.x, o.z);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        y = Math.min(y, height(o.x + Math.cos(a) * o.r * 0.7, o.z + Math.sin(a) * o.r * 0.7));
      }
      const ctx = ctxFor(map, Math.max(0, Math.round((y - by) * 10) / 10));
      const model = circleModel(o.kind, o.r, seed, ctx);
      let yaw = (o.rot ?? 0) + ((seed * 2.399) % (Math.PI * 2));
      if (FACE_RIVER.has(o.kind)) yaw = Math.atan2(-Math.sign(o.x || 1), 0) + (o.kind === 'stilthut' ? ((seed * 0.77) % 0.6) - 0.3 : 0);
      const s = o.scale ?? 1;
      batch.add(model, trs(o.x, y - 0.04, o.z, yaw, 1, s, 1), shadows);
    } else {
      const len = Math.hypot(o.bx - o.ax, o.bz - o.az);
      const h = o.h ?? 1.5;
      const cx = (o.ax + o.bx) / 2;
      const cz = (o.az + o.bz) / 2;
      let y = height(cx, cz);
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        y = Math.min(y, height(o.ax + (o.bx - o.ax) * t, o.az + (o.bz - o.az) * t));
      }
      const ctx = ctxFor(map, Math.max(0, Math.round((y - by) * 10) / 10));
      const wb = WALL_BUILDERS[o.kind];
      const mapKey = MAP_DEPENDENT.has(o.kind) ? map.id : '';
      const deep = DEEP.has(o.kind) ? ctx.below.toFixed(1) : '';
      const key = `w|${o.kind}|${len.toFixed(2)}|${o.r.toFixed(2)}|${h.toFixed(2)}|${seed}|${mapKey}|${deep}`;
      const model = wb
        ? cachedModel(key, () => wb(len, o.r, h, seed, ctx))
        : o.kind.startsWith('wall_')
          ? cachedModel(key, () => buildWall(o.kind, len, o.r, h, seed))
          : circleModel(o.kind, o.r, seed, ctx);
      const yaw = Math.atan2(o.bx - o.ax, o.bz - o.az);
      batch.add(model, trs(cx, y - 0.05, cz, yaw, 1), shadows);
    }
  }
  batch.build(group, 'props-batch');
  // keeps the shared prop clock running even when nothing pushes the game time
  group.add(tickMesh(autoClock));
  const ms = performance.now() - t0;
  if (ms > 50) console.info(`[props] buildProps ${obstacles.length} obstacles in ${ms.toFixed(0)} ms (${batch.instances} instances)`);
  return group;
}
