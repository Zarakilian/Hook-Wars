// buildProps: every blocking obstacle as an instanced voxel model sized to its collision shape.
import * as THREE from 'three';
import type { MapDef, Obstacle, PropKind } from '../../../../shared/maps/types.ts';
import type { HeightFn, Quality } from '../../contracts.ts';
import { cachedModel, clockDriver, halo, instanceModel, moodOf, propsQuality, qLevel, trs, type PropModel } from './common.ts';
import { buildBarrel, buildBollard, buildCrate, buildLamppost, buildPipe } from './harbour.ts';
import { buildCoralRock, buildIcePillar, buildIceRock, buildMossRock, buildReefPost, buildRunestone, buildTikiTotem } from './rocks.ts';
import { buildCypress, buildDeadTree, buildPalm, buildPine, buildStump } from './trees.ts';
import { buildWall } from './walls.ts';

type CircleBuilder = (r: number, seed: number) => PropModel;

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
};

/** Fallback when a wall kind is used as a circle or a circle kind as a wall. */
function circleModel(kind: PropKind, r: number, seed: number): PropModel {
  const b = CIRCLE_BUILDERS[kind];
  const key = `c|${kind}|${r.toFixed(2)}|${seed}`;
  if (b) return cachedModel(key, () => b(r, seed));
  return cachedModel(key, () => buildMossRock(r, seed));
}

export function buildPropsImpl(obstacles: Obstacle[], map: MapDef, height: HeightFn, quality?: Quality): THREE.Group {
  const t0 = performance.now();
  const q = propsQuality(quality);
  const shadows = qLevel(q) >= 1;
  const group = new THREE.Group();
  group.name = 'props';
  const buckets = new Map<string, { model: PropModel; mats: THREE.Matrix4[] }>();
  const add = (key: string, model: PropModel, m: THREE.Matrix4) => {
    let b = buckets.get(key);
    if (!b) {
      b = { model, mats: [] };
      buckets.set(key, b);
    }
    b.mats.push(m);
  };
  for (const o of obstacles) {
    const seed = o.seed ?? 1;
    if (o.shape === 'circle') {
      const model = circleModel(o.kind, o.r, seed);
      // sit on the lowest ground under the footprint so nothing floats on slopes
      let y = height(o.x, o.z);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        y = Math.min(y, height(o.x + Math.cos(a) * o.r * 0.7, o.z + Math.sin(a) * o.r * 0.7));
      }
      const yaw = (o.rot ?? 0) + ((seed * 2.399) % (Math.PI * 2));
      const s = o.scale ?? 1;
      add(`c|${o.kind}|${o.r.toFixed(2)}|${seed}`, model, trs(o.x, y - 0.04, o.z, yaw, 1, s, 1));
    } else {
      const len = Math.hypot(o.bx - o.ax, o.bz - o.az);
      const h = o.h ?? 1.5;
      const key = `w|${o.kind}|${len.toFixed(2)}|${o.r.toFixed(2)}|${h.toFixed(2)}|${seed}`;
      const model = o.kind.startsWith('wall_') ? cachedModel(key, () => buildWall(o.kind, len, o.r, h, seed)) : circleModel(o.kind, o.r, seed);
      const cx = (o.ax + o.bx) / 2;
      const cz = (o.az + o.bz) / 2;
      let y = height(cx, cz);
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        y = Math.min(y, height(o.ax + (o.bx - o.ax) * t, o.az + (o.bz - o.az) * t));
      }
      const yaw = Math.atan2(o.bx - o.ax, o.bz - o.az);
      add(key, model, trs(cx, y - 0.05, cz, yaw, 1));
    }
  }
  for (const b of buckets.values()) {
    for (const im of instanceModel(b.model, b.mats, shadows, undefined, moodOf(map.atmosphere))) group.add(im);
    if (b.model.halos)
      for (const m of b.mats)
        for (const hl of b.model.halos) {
          const s = halo(hl.color, hl.size, hl.opacity);
          s.position.set(hl.pos[0], hl.pos[1], hl.pos[2]).applyMatrix4(m);
          group.add(s);
        }
  }
  const first = group.children.find((c) => (c as THREE.Mesh).isMesh);
  if (first) clockDriver(first);
  const ms = performance.now() - t0;
  if (ms > 50) console.info(`[props] buildProps ${obstacles.length} obstacles in ${ms.toFixed(0)} ms`);
  return group;
}
