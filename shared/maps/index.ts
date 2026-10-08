import type { MapId } from '../types.ts';
import type { MapDef } from './types.ts';
import { muckmire } from './muckmire.ts';
import { frostfang } from './frostfang.ts';
import { coralcove } from './coralcove.ts';
import { cogwater } from './cogwater.ts';

export const MAPS: Record<MapId, MapDef> = { muckmire, frostfang, coralcove, cogwater };

export function getMap(id: MapId): MapDef {
  return MAPS[id] ?? muckmire;
}

export function mapSupportsTidal(id: MapId): boolean {
  return !!getMap(id).tide;
}
