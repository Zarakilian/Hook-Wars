// Team ring: a thin unlit ring in the team colour on the ground under every unit at game detail.
// Map light (Mirelight's sunset, Lanternwharf's moonlight) shifts the hue of the team trims on the
// body; an unlit ring with a dark outline reads the same on every map, bright sand or night cobbles.
// It sits outside the body footprint (bellies are about 0.56 m) and outside the hook power-up rings
// (auras.ts, about 0.55 to 0.67 m), so the front arc shows at the 54 degree gameplay camera.
// Geometry, texture and the two team materials are shared and live for the page (never disposed).
import * as THREE from 'three';
import type { Team } from '../../../../shared/types.ts';
import { UnitState } from '../../../../shared/types.ts';
import { TEAM_COLORS, type PudgyAnimInput } from '../../contracts.ts';

/** radius of the ring's bright core (metres) */
export const TEAM_RING_RADIUS = 0.86;
/** height above the unit's feet, clear of the ground decals of auras.ts (0.015 m) */
const LIFT = 0.03;
/** the core's radius as a share of the plane's half size */
const CORE = 0.82;
const TEX = 128;

let geo: THREE.BufferGeometry | null = null;
let tex: THREE.DataTexture | null = null;
const mats = new Map<string, THREE.MeshBasicMaterial>();

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Radial profile: a soft inner glow, the bright core and a dark outline for contrast on bright ground. */
function ringTexture(): THREE.DataTexture {
  if (tex) return tex;
  const data = new Uint8Array(TEX * TEX * 4);
  for (let j = 0; j < TEX; j++)
    for (let i = 0; i < TEX; i++) {
      const r = Math.hypot((i + 0.5) / TEX * 2 - 1, (j + 0.5) / TEX * 2 - 1);
      const core = smooth(CORE - 0.06, CORE - 0.035, r) * (1 - smooth(CORE + 0.025, CORE + 0.045, r));
      const glow = smooth(CORE - 0.3, CORE - 0.04, r) * (1 - smooth(CORE - 0.04, CORE, r)) * 0.32;
      const edge = smooth(CORE + 0.03, CORE + 0.05, r) * (1 - smooth(CORE + 0.075, CORE + 0.1, r)) * 0.5;
      const a = Math.min(1, core + glow + edge);
      // brightness: full in the core and the glow, dark in the outline
      const lum = a > 0 ? (core + glow + edge * 0.18) / a : 0;
      const o = (j * TEX + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.round(Math.min(1, lum) * 255);
      data[o + 3] = Math.round(a * 255);
    }
  tex = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.name = 'pudgy-team-ring';
  tex.needsUpdate = true;
  return tex;
}

function ringGeometry(): THREE.BufferGeometry {
  if (!geo) {
    const half = TEAM_RING_RADIUS / CORE;
    geo = new THREE.PlaneGeometry(half * 2, half * 2);
    geo.rotateX(-Math.PI / 2);
    geo.name = 'pudgy-team-ring';
  }
  return geo;
}

function ringMaterial(team: Team, local: boolean): THREE.MeshBasicMaterial {
  const key = `${team}:${local ? 1 : 0}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: TEAM_COLORS[team].main,
      map: ringTexture(),
      transparent: true,
      opacity: local ? 1 : 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    m.name = `pudgy-team-ring-${key}`;
    mats.set(key, m);
  }
  return m;
}

/** The ring for one unit (a child of its root, so it follows position but not squash or hops). */
export function createTeamRing(team: Team, local: boolean): THREE.Mesh {
  const ring = new THREE.Mesh(ringGeometry(), ringMaterial(team, local));
  ring.name = 'pudgy-team-ring';
  ring.position.y = LIFT;
  ring.castShadow = false;
  ring.receiveShadow = false;
  ring.renderOrder = 1;
  return ring;
}

/** Shown while the unit is alive and fully visible: hidden on corpses, drowning and see-through units. */
export function teamRingShown(a: PudgyAnimInput, opacity: number): boolean {
  return opacity >= 1 && a.hpFrac > 0 && a.state !== UnitState.Dead && a.state !== UnitState.Drowning;
}
