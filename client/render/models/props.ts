// Props, decor, movers, hazards, runes, mines and fountains, all as detailed voxel models.
// This file keeps the public contract; the implementation lives in ./props/.
//
// Notes for callers:
// - Every builder caches geometry and materials at module level (bounded by map content), so the
//   groups returned by buildProps / buildDecor / createMoverView / createMineView need no disposal.
// - createHazardView / createRuneView / createFountainView return views whose dispose() frees only
//   their per-instance resources.
// - Animated shaders read one shared clock. update() calls on hazards, runes and fountains push the
//   game time into it; when nothing calls update(), it free-runs on wall time.
import * as THREE from 'three';
import type { Circle, Decor, MapDef, MoverDef, Obstacle, Platform } from '../../../shared/maps/types.ts';
import type { HazardInst } from '../../../shared/sim/entities.ts';
import type { RuneType, Team } from '../../../shared/types.ts';
import { groundY, platformDeckY, type AnimatedView, type HazardView, type HeightFn, type Quality } from '../contracts.ts';
import { buildPropsImpl } from './props/buildProps.ts';
import { moodOf, setPropsQuality, setPropTime } from './props/common.ts';
import { buildDecorImpl } from './props/decor.ts';
import { createFountainViewImpl } from './props/fountains.ts';
import { createHazardViewImpl } from './props/hazards.ts';
import { createMoverViewImpl } from './props/movers.ts';
import { createMineViewImpl, createRuneViewImpl, RUNE_STYLE } from './props/runes.ts';

export { RUNE_STYLE, setPropsQuality, setPropTime };

/**
 * Optional teardown for groups from buildProps / buildDecor / createMoverView: frees the per-match
 * instance buffers only. Shared geometry, materials and textures stay cached for the next match.
 */
export function disposePropGroup(group: THREE.Object3D): void {
  group.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
  });
}

/**
 * Every blocking obstacle as an instanced voxel model sized to its collision shape.
 * quality (optional, default from setPropsQuality, else 'medium'): 'low' disables prop shadows.
 */
export function buildProps(obstacles: Obstacle[], map: MapDef, height: HeightFn, quality?: Quality): THREE.Group {
  return buildPropsImpl(obstacles, map, height, quality);
}

/**
 * Every decor item, instanced by kind and variant. Plants sway, lilypads float and seaweed shrinks
 * with the water level, fireflies drift, lanterns glow, lock gates swing open when the canal floods.
 * waterY is sampled every frame, so pass a live closure (e.g. () => waterY(map, river.level)).
 */
export function buildDecor(decor: Decor[], map: MapDef, height: HeightFn, waterY: (x: number, z: number) => number, quality?: Quality): THREE.Group {
  return buildDecorImpl(decor, map, height, waterY, quality);
}

/** Ice floe, barge, log or raft sized to r and len. Origin at the waterline, +Z along the capsule axis. */
/**
 * Walkable decks over water (docks, stone bridges, piers, frozen floes): one group for the whole map.
 * Origin is world space; deck tops sit at platformDeckY(map, p). Called by the terrain module. (Stub until the props pass.)
 */
export function buildPlatforms(platforms: Platform[], map: MapDef, quality?: Quality): THREE.Group {
  void map;
  void quality;
  const g = new THREE.Group();
  g.name = 'platforms';
  const mat = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 });
  for (const p of platforms) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(p.w, 0.3, p.d), mat);
    m.position.set(p.x, platformDeckY(map, p) - 0.15, p.z);
    m.rotation.y = -p.rot;
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

export function createMoverView(def: MoverDef, map: MapDef): THREE.Object3D {
  return createMoverViewImpl(def, moodOf(map.atmosphere));
}

/** Animated hazard sized to h.r. Motion lives on an inner group; active = false sinks and hides it. */
export function createHazardView(h: HazardInst, map: MapDef): HazardView {
  return createHazardViewImpl(h, map);
}

/** Floating, spinning, pulsing rune with a distinct colour, shape and glow per type. */
export function createRuneView(type: RuneType): AnimatedView {
  return createRuneViewImpl(type);
}

/** Bramble mine. own = placed by the local player (brighter ring). Shared resources, no disposal needed. */
export function createMineView(own: boolean): THREE.Object3D {
  return createMineViewImpl(own);
}

/**
 * Team home fountain themed to the biome (well, crystal, clam or brazier) with a healing aura ring of
 * radius circle.r. Pass the terrain height function so the ring hugs the ground exactly; without it
 * the ring follows the map's bank-top noise.
 */
export function createFountainView(team: Team, circle: Circle, map: MapDef, height?: HeightFn): AnimatedView {
  return createFountainViewImpl(team, circle, map, height);
}
