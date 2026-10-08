// Hook skins: one voxel model per 'hands' cosmetic (shared/cosmetics.ts), used both for the hook a
// Pudgy holds (characters mount it in the hand socket) and for the flying hook head (fx chains), so the
// two always match.
//
// Recipes live in ./skinModels.ts and draw into a metric voxel builder (./skinKit.ts, on ./sculpt.ts).
// Each skin meshes to ONE geometry per voxel size with per-vertex PBR (rust, steel, rope, ivory, gold,
// pearl, glowing lamps) and baked AO, drawn with one shared material per team, so a hook is a single
// draw call. Team-coloured bits are flagged voxels the material tints, so geometry is team agnostic.
// Everything here is cached for the life of the page: the Locker and menu previews keep using held
// hooks after a match ends, so FxSystem.dispose never frees these.
import * as THREE from 'three';
import { cosmeticById } from '../../../shared/cosmetics.ts';
import type { FamilyId, Team } from '../../../shared/types.ts';
import type { Quality } from '../contracts.ts';
import { surfMaterial, twinkleGeometry, twinkleMesh } from './sculpt.ts';
import { Builder, VOXEL_M } from './skinKit.ts';
import {
  DEFAULT_SKIN, SKIN_RECIPES, drawCoil, drawTether, grappleRecipe, linkRecipe, tetherBounds, type LinkKind, type LinkRecipe, type SkinRecipe,
} from './skinModels.ts';

export type { LinkKind, SkinRecipe };

/** Flying heads are drawn larger than the held hook so they read from the game camera. */
export const FLY_SCALE = 1.85;

export interface SkinGeo {
  recipe: SkinRecipe;
  /** head frame, metres: origin at the catch centre, +Z business end, curve in XZ */
  head: THREE.BufferGeometry;
  /** claws: jaws shut (carrying, reeling in) */
  closed: THREE.BufferGeometry | null;
  twinkle: THREE.BufferGeometry | null;
  /** metres from the origin back (-Z) to the tie-on point */
  eye: number;
  /** spring coil centre and radius (metres, head frame) */
  coil: { x: number; z: number; r: number };
  /** the hottest point (metres, head frame) for Ember Barb sparks */
  hot: THREE.Vector3;
  /** length along Z from the tie-on point to the front (metres) */
  length: number;
  /** half width in X (metres) */
  halfWidth: number;
  /** held: grip (origin) to the tie-on point along +Z (metres, may be negative = the grip is on the head) */
  tetherLen: number;
  tether: THREE.BufferGeometry | null;
  tris: number;
  buildMs: number;
}

const skinCache = new Map<string, SkinGeo>();
const linkCache = new Map<string, { recipe: LinkRecipe; geo: THREE.BufferGeometry; extra: THREE.BufferGeometry | null }>();
const coilCache = new Map<number, THREE.BufferGeometry>();

const BY_ID = new Map(SKIN_RECIPES.map((r) => [r.id, r]));

/** The recipe for a hands cosmetic; unknown ids, other families' items or no item = the family default. */
export function resolveSkin(family: FamilyId, skin: string | undefined): SkinRecipe {
  if (skin) {
    const r = BY_ID.get(skin);
    const def = cosmeticById(skin);
    if (r && r.family === family && (!def || def.slot === 'hands')) return r;
  }
  return BY_ID.get(DEFAULT_SKIN[family]) ?? SKIN_RECIPES[0];
}

function voxelFor(q: Quality): number {
  return VOXEL_M[q] ?? VOXEL_M.medium;
}

function triCount(g: THREE.BufferGeometry | null): number {
  if (!g) return 0;
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

function buildSkin(r: SkinRecipe, voxelM: number): SkinGeo {
  const t0 = performance.now();
  const b = new Builder(r.bounds, r.scale, voxelM);
  r.draw(b, false);
  const head = b.mesh({ heat: r.heat });
  head.name = `hw-skin-${r.id}`;
  let closed: THREE.BufferGeometry | null = null;
  if (r.closable) {
    const c = new Builder(r.bounds, r.scale, voxelM);
    r.draw(c, true);
    closed = c.mesh({ heat: r.heat });
  }
  let tether: THREE.BufferGeometry | null = null;
  const tl = r.tetherLen * r.scale;
  if (r.tether !== 'none' && tl > 0.02) {
    const tb = new Builder(tetherBounds(tl), 1, Math.min(voxelM, 0.028));
    drawTether(tb, r.tether, tl);
    tether = tb.mesh();
  }
  const s = r.scale;
  const twinkle = r.sparkles ? twinkleGeometry(r.sparkles.map(([x, y, z]) => [x * s, y * s, z * s] as const)) : null;
  head.computeBoundingBox();
  const bb = head.boundingBox!;
  const geo: SkinGeo = {
    recipe: r,
    head,
    closed,
    twinkle,
    eye: r.eye * s,
    coil: { x: r.coil.x * s, z: r.coil.z * s, r: r.coil.r * s },
    hot: new THREE.Vector3(r.hot[0] * s, r.hot[1] * s, r.hot[2] * s),
    length: bb.max.z + r.eye * s,
    halfWidth: Math.max(-bb.min.x, bb.max.x),
    tetherLen: tl,
    tether,
    tris: triCount(head) + triCount(closed) + triCount(tether),
    buildMs: 0,
  };
  geo.buildMs = performance.now() - t0;
  return geo;
}

/** Cached skin geometry for a hands cosmetic at a quality tier. */
export function skinGeometry(family: FamilyId, skin: string | undefined, quality: Quality): SkinGeo {
  const r = resolveSkin(family, skin);
  const v = voxelFor(quality);
  const key = `${r.id}@${v}`;
  let g = skinCache.get(key);
  if (!g) {
    g = buildSkin(r, v);
    skinCache.set(key, g);
  }
  return g;
}

/** Cached grapple claw (kind 1) for a family. */
export function grappleGeometry(family: FamilyId, quality: Quality): SkinGeo {
  const v = voxelFor(quality);
  const key = `grapple.${family}@${v}`;
  let g = skinCache.get(key);
  if (!g) {
    g = buildSkin(grappleRecipe(family), v);
    skinCache.set(key, g);
  }
  return g;
}

const LINK_VOXEL: Record<Quality, number> = { low: 0.036, medium: 0.029, high: 0.023, ultra: 0.019 };

/** Cached chain link (and its extra: knot or leaf) for a link style. */
export function linkGeometry(kind: LinkKind, quality: Quality): { recipe: LinkRecipe; geo: THREE.BufferGeometry; extra: THREE.BufferGeometry | null } {
  const v = LINK_VOXEL[quality] ?? LINK_VOXEL.medium;
  const key = `${kind}@${v}`;
  let l = linkCache.get(key);
  if (!l) {
    const recipe = linkRecipe(kind);
    const b = new Builder(recipe.bounds, 1, v);
    recipe.draw(b);
    const geo = b.mesh({ ao: 0.35 });
    let extra: THREE.BufferGeometry | null = null;
    if (recipe.extraEvery > 0 && recipe.drawExtra && recipe.extraBounds) {
      const e = new Builder(recipe.extraBounds, 1, v);
      recipe.drawExtra(e);
      extra = e.mesh({ ao: 0.4 });
    }
    l = { recipe, geo, extra };
    linkCache.set(key, l);
  }
  return l;
}

/** Cached spring coil (unit radius 0.1 m, length 0.16 m along Z): scale it to the skin's coil. */
export function coilGeometry(quality: Quality): THREE.BufferGeometry {
  const v = LINK_VOXEL[quality] ?? LINK_VOXEL.medium;
  let g = coilCache.get(v);
  if (!g) {
    const b = new Builder({ x0: -0.13, x1: 0.13, y0: -0.13, y1: 0.13, z0: -0.11, z1: 0.11 }, 1, v);
    drawCoil(b, 0.1, 0.16, 3.4, 0.017);
    g = b.mesh({ ao: 0.3 });
    coilCache.set(v, g);
  }
  return g;
}

/** Info for mounting a held hook (the characters' HookMount tuning). Metres, held frame. */
export function heldHookInfo(family: FamilyId, skin: string | undefined, quality: Quality = 'medium'): { id: string; length: number; halfWidth: number; tetherLen: number; dangles: boolean } {
  const g = skinGeometry(family, skin, quality);
  return { id: g.recipe.id, length: Math.max(0, g.tetherLen) + g.length, halfWidth: g.halfWidth, tetherLen: g.tetherLen, dangles: g.recipe.tether !== 'none' };
}

/**
 * The held hook for a hands cosmetic (undefined skin = the family default).
 * Origin at the grip (where the hand or arm socket holds it), the business end pointing +Z,
 * sized in metres for the base hook radius (HOOK_LEVELS.width[0] = 0.45 m).
 * The hook's curve lies in the local XZ plane (Y is its thin axis). Brawler and bot skins hang from
 * a short rope, chain or cable tether (grip -> tie-on point), Swamp Ogre skins are gripped directly.
 * Returns null when no model exists yet; the caller then shows its own. The caller owns the result
 * and calls disposeHeldHook on it when done (geometry and materials are shared and cached, so this
 * only detaches it).
 */
export function createHeldHook(family: FamilyId, skin: string | undefined, team: Team, quality: Quality): THREE.Object3D | null {
  let g: SkinGeo;
  try {
    g = skinGeometry(family, skin, quality);
  } catch (err) {
    console.warn('[fx] hook skin build failed', skin, err);
    return null;
  }
  const mat = surfMaterial('base', team === 1 ? 1 : 0);
  const shadow = quality !== 'low';
  const root = new THREE.Group();
  root.name = 'hw-held-hook';
  root.userData.skin = g.recipe.id;
  root.userData.length = Math.max(0, g.tetherLen) + g.length;
  if (g.tether) {
    const t = new THREE.Mesh(g.tether, mat);
    t.name = 'hw-held-tether';
    t.castShadow = shadow;
    root.add(t);
  }
  const head = new THREE.Mesh(g.head, mat);
  head.name = 'hw-held-head';
  head.position.z = g.tetherLen + g.eye;
  head.castShadow = shadow;
  root.add(head);
  if (g.twinkle) head.add(twinkleMesh(g.twinkle));
  return root;
}

export function disposeHeldHook(obj: THREE.Object3D): void {
  obj.removeFromParent();
}

/** Build (and cache) every skin at a tier now; returns the time it took (ms). */
export function prebuildSkins(quality: Quality, ids?: readonly string[]): number {
  const t0 = performance.now();
  for (const r of SKIN_RECIPES) if (!ids || ids.includes(r.id)) skinGeometry(r.family, r.id, quality);
  return performance.now() - t0;
}

/** Debug: per-skin triangle counts and build times at a tier. */
export function skinStats(quality: Quality): { id: string; tris: number; ms: number; length: number }[] {
  return SKIN_RECIPES.map((r) => {
    const g = skinGeometry(r.family, r.id, quality);
    return { id: r.id, tris: Math.round(g.tris), ms: +g.buildMs.toFixed(1), length: +g.length.toFixed(3) };
  });
}
