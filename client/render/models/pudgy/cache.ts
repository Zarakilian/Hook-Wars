// Shared, reference-counted geometry cache for Pudgy parts.
// Keys are (family, piece, option, team) so every unit with the same piece shares one buffer.
import type * as THREE from 'three';
import type { PartDef } from './types.ts';

interface Entry {
  geo: THREE.BufferGeometry;
  refs: number;
}

const cache = new Map<string, Entry>();

export function acquireGeo(def: PartDef): THREE.BufferGeometry {
  let e = cache.get(def.key);
  if (!e) {
    e = { geo: def.build(), refs: 0 };
    cache.set(def.key, e);
  }
  e.refs++;
  return e.geo;
}

/** True when the geometry for a key is built and cached (acquiring it is then free). */
export function hasGeo(key: string): boolean {
  return cache.has(key);
}

export function releaseGeo(key: string): void {
  const e = cache.get(key);
  if (!e) return;
  e.refs--;
  if (e.refs <= 0) {
    e.geo.dispose();
    cache.delete(key);
  }
}

/** Debug: number of cached geometries and total triangles. */
export function cacheStats(): { geometries: number; triangles: number } {
  let tris = 0;
  for (const e of cache.values()) tris += (e.geo.index ? e.geo.index.count : e.geo.getAttribute('position').count) / 3;
  return { geometries: cache.size, triangles: Math.round(tris) };
}
