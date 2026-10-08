// Interfaces between the game client and every render/audio/UI module.
// Each module may improve its implementation freely but must keep these signatures.
import type * as THREE from 'three';
import type { Circle, Decor, MapDef, MoverDef, Obstacle } from '../../shared/maps/types.ts';
import type { HazardInst } from '../../shared/sim/entities.ts';
import type {
  AnnounceKey, CastKind, Cosmetics, FamilyId, HazardKind, MatchConfig, RiverState, RuneType, Team, UnitStateId,
} from '../../shared/types.ts';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

/** Render layer used by water meshes. The engine renders it after capturing the opaque scene. */
export const WATER_LAYER = 2;

export const TEAM_COLORS: Record<Team, { main: number; dark: number; light: number; name: string }> = {
  0: { main: 0xe0533d, dark: 0x8f2a1e, light: 0xffa48f, name: 'Red Tide' },
  1: { main: 0x3d8be0, dark: 0x1e4f8f, light: 0x8fc4ff, name: 'Blue Gill' },
};

/**
 * Cosmetic option names per family. Cosmetics indices are taken modulo these lengths.
 * client/render/models/pudgy.ts must build a distinct look for every entry; the UI shows these names.
 */
export const COSMETIC_NAMES: Record<FamilyId, { hats: readonly string[]; accents: readonly string[]; faces: readonly string[] }> = {
  brawler: {
    hats: ['Bare Head', 'Captain Cap', 'Sou\'wester', 'Bobble Beanie', 'Bucket Hat', 'Bandana', 'Pirate Tricorn', 'Lighthouse Helm'],
    accents: ['Plain Apron', 'Striped Shirt', 'Anchor Tattoo', 'Fish Belt', 'Rope Braces', 'Oilskin Coat', 'Gold Earring', 'Net Cape'],
    faces: ['Bushy Beard', 'Mutton Chops', 'Clean Grin', 'Eyepatch', 'Walrus Tache', 'Gap Tooth'],
  },
  ogre: {
    hats: ['Bare Head', 'Mushroom Cap', 'Lily Crown', 'Skull Helm', 'Antler Rack', 'Moss Wig', 'Turtle Shell', 'Firefly Halo'],
    accents: ['Leaf Sash', 'Bone Necklace', 'Mud Paint', 'Reed Skirt', 'Frog Pouch', 'Vine Wraps', 'Shell Belt', 'Glow Spots'],
    faces: ['Big Tusks', 'Snaggle Fang', 'Warty Nose', 'One Eye', 'Toothy Grin', 'Whisker Moss'],
  },
  bot: {
    hats: ['Bare Dome', 'Smokestack', 'Radar Dish', 'Lamp Head', 'Gear Crown', 'Propeller', 'Welding Mask', 'Kettle Lid'],
    accents: ['Clean Plates', 'Rust Patches', 'Hazard Stripes', 'Brass Trim', 'Rivet Rows', 'Pipe Bundle', 'Gauge Panel', 'Copper Coils'],
    faces: ['Visor Eye', 'Twin Lenses', 'Grille Mouth', 'Cyclops Lamp', 'Monocle Sensor', 'Screen Smile'],
  },
};

// ---------------------------------------------------------------------------------------------
// Vertical layout. All modules place things with these, so units, water and terrain line up.
// ---------------------------------------------------------------------------------------------

/** Bank top / playable ground height. */
export function groundY(map: MapDef): number {
  return map.terrain.baseHeight;
}
/** River bed height (deepest point of the channel). */
export function bedY(map: MapDef): number {
  return map.terrain.baseHeight - map.river.depth;
}
/** Water surface height for a river level 0..1 (1 = full, just under the bank top). */
export function waterY(map: MapDef, level: number): number {
  const full = map.terrain.baseHeight - 0.32;
  const low = bedY(map) + 0.05;
  return low + (full - low) * Math.max(0, Math.min(1, level));
}

// ---------------------------------------------------------------------------------------------
// Engine (client/render/engine.ts)
// ---------------------------------------------------------------------------------------------

/** Opaque scene capture for refraction / depth effects. Null when the quality tier skips it. */
export interface SceneCapture {
  color: THREE.Texture;
  depth: THREE.DepthTexture;
  /** render target size in pixels */
  size: THREE.Vector2;
}

export interface Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly quality: Quality;
  /** Updated every frame before the WATER_LAYER is drawn. */
  readonly capture: SceneCapture | null;
  setQuality(q: Quality): void;
  /** Sky, fog, sun, ambient, grading, weather for one match. Pass null for the menu backdrop. */
  setAtmosphere(map: MapDef | null, config: MatchConfig | null): void;
  /** Per frame: frame dt, elapsed seconds, the point the camera looks at (shadow frustum, weather volume). */
  update(dt: number, time: number, focusX: number, focusZ: number): void;
  render(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// World (client/render/world/terrain.ts)
// ---------------------------------------------------------------------------------------------

export interface WorldView {
  readonly group: THREE.Group;
  /** Visual ground height (bank, slopes, bed, islands) at x,z. */
  groundHeight(x: number, z: number): number;
  update(dt: number, time: number, river: RiverState): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Water (client/render/world/water.ts)
// ---------------------------------------------------------------------------------------------

export interface WaterView {
  readonly group: THREE.Group;
  /** Water surface height at x,z including waves. Returns -Infinity where there is no water. */
  surfaceHeight(x: number, z: number): number;
  update(dt: number, time: number, river: RiverState, camera: THREE.Camera): void;
  /** Splashes, ripples and wakes. strength 0..1. */
  disturb(x: number, z: number, strength: number, radius?: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Characters (client/render/models/pudgy.ts)
// ---------------------------------------------------------------------------------------------

export interface PudgyOptions {
  family: FamilyId;
  cosmetics: Cosmetics;
  team: Team;
  name: string;
  isLocal: boolean;
  quality: Quality;
}

export interface PudgyAnimInput {
  state: UnitStateId;
  castKind?: CastKind;
  /** planar speed in m/s */
  speed: number;
  hpFrac: number;
  flags: number; // UFlag bits
  /** true while this unit's own hook or grapple is out (hand is empty / arm extended) */
  hookOut: boolean;
  /** seconds since this unit entered its current state (approximate is fine) */
  stateTime: number;
  time: number;
}

export type PudgyOneShot = 'throw' | 'grapple' | 'bash' | 'melee' | 'hit' | 'celebrate' | 'spawn';

export interface PudgyView {
  /** Positioned and yawed by the game client. Model faces +Z at rotation.y = 0. */
  readonly root: THREE.Object3D;
  /** World position of the hook hand (chain origin). Valid after update(). */
  getHandWorld(out: THREE.Vector3): THREE.Vector3;
  update(dt: number, a: PudgyAnimInput): void;
  play(kind: PudgyOneShot): void;
  /** 1 = solid, < 1 = see-through (stealthed ally) */
  setOpacity(alpha: number): void;
  dispose(): void;
}

/** Colours used for death debris, chain tinting, UI portraits. */
export interface PudgyPalette {
  skin: number;
  skinDark: number;
  cloth: number; // team-coloured apron / plating
  accent: number;
  metal: number;
  extra: number[];
}

// ---------------------------------------------------------------------------------------------
// Props (client/render/models/props.ts)
// ---------------------------------------------------------------------------------------------

export type HeightFn = (x: number, z: number) => number;

export interface HazardView {
  readonly root: THREE.Object3D;
  /** cycle: periodic hazards report phase 0..1, warning (telegraph) and firing; active = false when under deep water */
  update(dt: number, time: number, cycle: { phase: number; warning: boolean; firing: boolean }, active: boolean): void;
  dispose(): void;
}

export interface AnimatedView {
  readonly root: THREE.Object3D;
  update(dt: number, time: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Effects (client/render/fx/fx.ts)
// ---------------------------------------------------------------------------------------------

export interface ChainView {
  /** points: world positions from the hand (first) to the hook head (last). */
  update(points: THREE.Vector3[], dt: number, state: { retracting: boolean; carrying: boolean; time: number }): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

export type DamageKind = 'hook' | 'melee' | 'bash' | 'drown' | 'mine' | 'burn' | 'hazard' | 'fountain' | 'shield' | 'heal';

export interface FxSystem {
  update(dt: number, time: number, camera: THREE.Camera): void;
  createChain(kind: 0 | 1, family: FamilyId, team: Team, fxBits: number): ChainView;
  hookHit(p: THREE.Vector3, bullseye: boolean, ally: boolean): void;
  hookClash(p: THREE.Vector3): void;
  hookWall(p: THREE.Vector3): void;
  hookBounce(p: THREE.Vector3): void;
  splash(p: THREE.Vector3, strength: number): void;
  bash(p: THREE.Vector3, dirX: number, dirZ: number): void;
  melee(p: THREE.Vector3): void;
  damageNumber(p: THREE.Vector3, amount: number, kind: DamageKind, mine: boolean, crit: boolean): void;
  corpseBurst(p: THREE.Vector3, palette: PudgyPalette): void;
  runePickup(p: THREE.Vector3, type: RuneType): void;
  mineBoom(p: THREE.Vector3): void;
  hazardBurst(p: THREE.Vector3, kind: HazardKind): void;
  respawn(p: THREE.Vector3, team: Team): void;
  drownBubbles(p: THREE.Vector3): void;
  footstep(p: THREE.Vector3, surface: 'ground' | 'shallow' | 'ice' | 'snow' | 'sand' | 'mud'): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Audio (client/audio/audio.ts)
// ---------------------------------------------------------------------------------------------

export type SfxId =
  | 'hookThrow' | 'hookHit' | 'hookHitAlly' | 'bullseye' | 'hookWall' | 'hookBounce' | 'hookClash' | 'hookReturn' | 'hookBreak'
  | 'grappleThrow' | 'grappleLatch' | 'grappleLand'
  | 'bash' | 'melee' | 'hurt' | 'death' | 'corpse' | 'splash' | 'drown' | 'drownSave' | 'respawn'
  | 'rune' | 'runeSpawn' | 'mineArm' | 'mineBoom' | 'buy' | 'deny' | 'pie' | 'puff'
  | 'tideHorn' | 'iceCrack' | 'hazardBurst' | 'countdown' | 'go' | 'victory' | 'defeat'
  | 'uiClick' | 'uiHover' | 'uiOpen' | 'chat' | 'footstep';

export type MusicMood = 'menu' | 'match' | 'tense' | 'victory' | 'defeat' | 'none';

export interface AudioSystem {
  /** Call from a user gesture (click/key) so the browser lets audio start. */
  unlock(): void;
  play(id: SfxId, o?: { x?: number; z?: number; volume?: number; pitch?: number; family?: FamilyId }): void;
  announce(key: AnnounceKey | 'countdown3' | 'countdown2' | 'countdown1' | 'go'): void;
  setListener(x: number, z: number): void;
  setAmbience(map: MapDef | null, river: RiverState | null): void;
  setMusic(mood: MusicMood): void;
  setVolumes(master: number, sfx: number, music: number): void;
  update(dt: number): void;
  dispose(): void;
}

// Re-exports so module authors import everything from one place.
export type { Circle, Decor, HazardInst, MapDef, MoverDef, Obstacle };
