// Biome registry: one terrain author per map.
import type { Decor, MapDef } from '../../../../../shared/maps/types.ts';
import type { MatchConfig } from '../../../../../shared/types.ts';
import type { Quality } from '../../../contracts.ts';
import type { Biome } from '../field.ts';
import type { BackdropRule } from '../flora.ts';
import { CogwaterBiome } from './cogwater.ts';
import { CoralcoveBiome } from './coralcove.ts';
import { FrostfangBiome } from './frostfang.ts';
import { MuckmireBiome } from './muckmire.ts';

export interface PoolDef {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** fixed water level (not tied to the river) */
  level: number;
  keep?: (x: number, z: number) => boolean;
}

export interface MapBiome extends Biome {
  outside(x: number, z: number): number;
  pathAmount(x: number, z: number): number;
  /** backdrop scatter (trees, rocks, boats ...) outside the play area */
  backdrop(): BackdropRule[];
  /** small non-colliding detail inside the play area (pebbles, roots, shells) */
  details(q: Quality): BackdropRule[];
  /** extra decor for this match's river mode, built through buildDecor */
  extraDecor(): Decor[];
  /** where the river-level backdrop water may appear */
  backwaterKeep(x: number, z: number): boolean;
  /** fixed-level pools (e.g. the stream above a waterfall) */
  pools(): PoolDef[];
  /** snow / sand sparkle strength */
  readonly sparkle: number;
  /** backdrop water held at a fixed level (lock gates) instead of following the river */
  readonly fixedWaterY?: number;
  /** half depth of the hole left for the water module (default: half the map depth) */
  readonly backwaterHoleZ?: number;
  /** colour and height of the far fallback ground */
  readonly farColor: number;
  readonly farY: number;
}

export function createBiome(map: MapDef, config: MatchConfig): MapBiome {
  switch (map.id) {
    case 'frostfang':
      return new FrostfangBiome(map, config);
    case 'coralcove':
      return new CoralcoveBiome(map, config);
    case 'cogwater':
      return new CogwaterBiome(map, config);
    default:
      return new MuckmireBiome(map, config);
  }
}
