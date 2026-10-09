// Showcase stage themes: one staged vignette per map mood, in the style of the reference images (a low
// camera on a lantern-lit dock, a few props, the water, mist, and the Lunker posed in front).
//
// Stage space is map space: the Lunker stands at (0, deck, 0) and the camera looks toward -Z from +Z.
// Screen right (+X) is open water; screen left is the quay or bank. Props come from the props module's
// own builders with the theme's real map (so palettes, mood and the props artist's materials apply),
// placed on a small synthetic layout. Sun / moon directions are "to the light" in stage space.
import type { Atmosphere, Decor, MapDef, MoverDef, Obstacle, Platform } from '../../../shared/maps/types.ts';
import type { MapId } from '../../../shared/types.ts';
import type { SlabStyle } from './landmarks.ts';
import type { StageWaterStyle, Veil } from './materials.ts';

export type ShowcaseThemeId = 'harbourNight' | 'bayouSunset' | 'frozenHarbour' | 'lagoonDay';
export const SHOWCASE_THEMES: readonly ShowcaseThemeId[] = ['harbourNight', 'bayouSunset', 'frozenHarbour', 'lagoonDay'];

/** Which theme suits a map (Locker / Store previews of a map's mood, a lobby backdrop). */
export function themeForMap(id: MapId): ShowcaseThemeId {
  switch (id) {
    case 'mirelight':
    case 'muckmire':
      return 'bayouSunset';
    case 'aurora':
    case 'frostfang':
      return 'frozenHarbour';
    case 'maelstrom':
    case 'coralcove':
      return 'lagoonDay';
    default:
      return 'harbourNight';
  }
}

/** A ground slab (my own voxels): quay, bank, sandbar, snow bank. Heights relative to the map's bank top. */
export interface SlabDef {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** top relative to the bank top (m), or to the dock's deck when onDeck */
  top: number;
  /** a thin layer laid over the dock's planks (snow): top is measured from the deck, and it gets no wet sheen */
  onDeck?: boolean;
  /** body depth below the top (m) */
  depth: number;
  style: SlabStyle;
  seed: number;
  /** voxel size (m) */
  voxel: number;
}

export interface LandmarkDef {
  kind: 'lighthouse' | 'island' | 'ridge';
  x: number;
  z: number;
  /** base height relative to the water line (m) */
  y: number;
  yaw: number;
  /** voxel size (m) */
  size: number;
  seed: number;
  /** island / ridge grid size in voxels and peak height */
  nx?: number;
  nz?: number;
  h?: number;
  palms?: number;
}

export interface MoverPlace {
  def: MoverDef;
  x: number;
  z: number;
  yaw: number;
}

/** The key light: a shadowed spot from the nearest lantern, or a far "sun" spot (decay 0). */
export interface KeyLight {
  kind: 'lantern' | 'sun';
  color: number;
  intensity: number;
  angle: number;
  penumbra: number;
  /** sun only: direction to the light (stage space) */
  dir?: [number, number, number];
}

export interface ShowcaseTheme {
  id: ShowcaseThemeId;
  label: string;
  map: MapId;
  /** the map's atmosphere with the stage's overrides (sun / moon placed in view, no weather) */
  atmosphere: (base: Atmosphere) => Atmosphere;
  /** sky look tweaks on top of resolveAtmosphere(...).sky */
  sky: { cloudCover?: number; stars?: number; sunDisk?: number; sunSize?: number; sunGlow?: number; haze?: number; shafts?: number; cloudSpeed?: number };
  /**
   * the engine sun (moon / sun, unshadowed in the menu): the cool side / rim light. `dir` (to the light,
   * stage space) may differ from the moon disc in the sky: a light from behind the set mirrors itself in
   * every glossy deck and quay top at the low camera, so the light comes from the side instead.
   */
  rim: { intensity: number; color?: number; dir?: [number, number, number] };
  hemi: { sky: number; ground: number; intensity: number };
  fog: { color: number; density: number };
  envIntensity: number;
  key: KeyLight;
  /** multiplier on every lantern light (night high, day low) */
  lanterns: number;
  water: StageWaterStyle;
  /** wet sheen strength on the deck (0 = dry) */
  sheen: number;
  /**
   * mist veils: rows of soft upright veils across the view (z, x from, x to, height in m), lifted clear
   * of the ground under them so no deck or quay cuts a hard line through them, plus flat sheets just
   * above open water (x, z, width, depth, alpha)
   */
  mist: { color: number; glow: number; alpha: number; rows: [number, number, number, number][]; sheets: [number, number, number, number, number][] };
  lunker: { x: number; z: number; yaw: number };
  platforms: Platform[];
  obstacles: Obstacle[];
  decor: Decor[];
  slabs: SlabDef[];
  landmarks: LandmarkDef[];
  movers: MoverPlace[];
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function c(kind: Obstacle['kind'], x: number, z: number, r: number, seed: number, extra: { rot?: number; scale?: number } = {}): Obstacle {
  return { shape: 'circle', kind, x, z, r, seed, ...extra };
}
function w(kind: Obstacle['kind'], ax: number, az: number, bx: number, bz: number, r: number, h: number, seed: number): Obstacle {
  return { shape: 'wall', kind, ax, az, bx, bz, r, h, seed };
}
function d(kind: Decor['kind'], x: number, z: number, scale = 1, seed = 1, rot = 0): Decor {
  return { kind, x, z, rot, scale, seed };
}
const GRANITE: SlabStyle = { body: [0x5d5a58, 0x686462, 0x535150, 0x726c66], top: [0x5e5046, 0x6a5a4c, 0x54483e, 0x74624f], blockW: 6, blockH: 3, ragged: 0, cap: 0 };
const MUD: SlabStyle = { body: [0x2e2418, 0x3a2e1f, 0x261e14, 0x43352a], top: [0x24581e, 0x2c6624, 0x1f4c1a, 0x36742a], blockW: 0, blockH: 0, ragged: 0.25, cap: 0, patch: [0x3a2e1f, 0x43352a, 0x342818] };
const SNOW: SlabStyle = { body: [0x9cc8e2, 0x86b8da, 0xb2d6ec, 0x8cbcdc], top: [0xeaf0f7, 0xe4ebf4, 0xeef3f9], blockW: 0, blockH: 0, ragged: 0.5, cap: 0.7, capColors: [0xf8fbfe, 0xeef3f9], patch: [0xd2deec, 0xc8d6e8, 0xdae4f0], soft: true };
// fresh snow over the dock's planks: ragged rims show the dark wood at the edges, soft drifts on top
const DECK_SNOW: SlabStyle = { body: [0xdfe8f2, 0xd2deec], top: [0xeaf0f7, 0xe6edf5, 0xedf2f8], blockW: 0, blockH: 0, ragged: 0.9, cap: 0.36, capColors: [0xf4f7fb, 0xf1f5fa], patch: [0xdbe4ef, 0xd8e2ee], soft: true };
const SAND: SlabStyle = { body: [0xc09a62, 0xb48e58, 0xcaa46c], top: [0xd8b676, 0xceaa6a, 0xe2c286, 0xc6a062, 0xe6ca92], blockW: 0, blockH: 0, ragged: 0.9, cap: 0 };

// ---------------------------------------------------------------------------------------------
// themes
// ---------------------------------------------------------------------------------------------

// Harbour night (refs 01, 03, 07): wet planks, a gallows lantern at the left, crates and bollards,
// the black harbour on the right full of lantern streaks, warehouses across the water, the moon.
const HARBOUR_NIGHT: ShowcaseTheme = {
  id: 'harbourNight',
  label: 'Harbour night',
  map: 'lanternwharf',
  atmosphere: (a) => ({ ...a, weather: 'none', sunDir: [0.34, 0.3, -1] }),
  sky: { cloudCover: 0.55, stars: 0.35, sunDisk: 5, sunSize: 0.03, sunGlow: 0.9, cloudSpeed: 0.008 },
  rim: { intensity: 1.6, color: 0x9ab4ff, dir: [0.9, 0.45, -0.05] },
  hemi: { sky: 0x22304e, ground: 0x241a14, intensity: 0.55 },
  fog: { color: 0x1a1d2c, density: 0.018 },
  envIntensity: 0.45,
  key: { kind: 'lantern', color: 0xffc890, intensity: 10, angle: 1.2, penumbra: 0.9 },
  lanterns: 1.3,
  water: { color: 0x04070a, glow: 0x000000, glowIntensity: 0, roughness: 0.04, ripple: 0.85, tile: 3.2, env: 0.2 },
  sheen: 1.2,
  mist: {
    color: 0x4a5878,
    glow: 0.45,
    alpha: 0.4,
    rows: [
      [-9.2, -14, 30, 4.5],
      [-15.5, -16, 34, 5],
      [-23, -18, 42, 6],
      [-33, -20, 52, 7],
    ],
    sheets: [
      [6, -8, 9, 4, 0.18],
      [11, -16, 12, 6, 0.2],
      [7, -25, 14, 7, 0.22],
    ],
  },
  lunker: { x: 0, z: 0, yaw: -0.38 },
  platforms: [{ kind: 'dock', x: -0.6, z: -7, w: 5.2, d: 26, rot: 0, seed: 3 }],
  obstacles: [
    c('lanternpost', -2.45, 0.4, 0.3, 2),
    c('crate', -2.6, 2.5, 0.5, 4),
    c('barrel', -1.75, 3.15, 0.36, 5),
    c('cratepile', -2.45, -2.4, 0.9, 6),
    c('barrel', -2.7, -4.7, 0.4, 7),
    c('bollard', 1.62, 2.1, 0.3, 8),
    c('bollard', 1.62, -5.6, 0.3, 9),
    c('gaslamp', 1.58, -15.5, 0.3, 10),
    c('crane', -2.5, -13.2, 1.1, 11),
    c('gaslamp', -2.7, -18.6, 0.3, 12),
    c('gaslamp', -4.0, -7.2, 0.3, 15),
    w('warehouse', -11.5, 4, -11.5, -9, 0.6, 5, 13),
    w('warehouse', -11.5, -12, -11.5, -26, 0.6, 6, 14),
    // across the harbour
    w('warehouse', 4, -48, 17, -48, 0.6, 7, 16),
    w('warehouse', 20, -48, 34, -48, 0.6, 8.5, 17),
    w('warehouse', 37, -48, 52, -48, 0.6, 6.5, 18),
    c('gaslamp', 6, -41.6, 0.3, 19),
    c('gaslamp', 14, -41.6, 0.3, 20),
    c('gaslamp', 22, -41.6, 0.3, 21),
    c('gaslamp', 30, -41.6, 0.3, 22),
    c('gaslamp', 38, -41.6, 0.3, 23),
    c('crane', 26, -43.2, 1.1, 24),
  ],
  decor: [d('lantern', -2.05, 3.7, 1, 3), d('rope', 1.4, 1.5, 1, 4), d('rope', 1.4, -6.2, 0.9, 5), d('rowboat', 3.5, -2.8, 1, 6, 0.15)],
  slabs: [
    { x0: -16, x1: -3.25, z0: -34, z1: 8, top: 0, depth: 3.4, style: GRANITE, seed: 1, voxel: 0.25 },
    { x0: -6, x1: 70, z0: -54, z1: -41, top: 0, depth: 3.4, style: GRANITE, seed: 2, voxel: 0.25 },
  ],
  landmarks: [
    { kind: 'island', x: 31, z: -96, y: -0.6, yaw: 0.4, size: 0.5, seed: 5, nx: 34, nz: 24, h: 8, palms: 0 },
    { kind: 'lighthouse', x: 31, z: -96, y: 2.6, yaw: 0, size: 0.45, seed: 0 },
  ],
  movers: [{ def: { kind: 'barge', r: 1.3, len: 7, lane: 0, speed: 0, offset: 0, seed: 4 }, x: 7, z: -17, yaw: 0.12 }],
};

// Bayou sunset (refs 02, 04): a mossy boardwalk through the marsh, cypresses on the left, cattails and
// lily pads in the black water, a stilt hut across, thick lavender mist and the sun low behind.
const BAYOU_SUNSET: ShowcaseTheme = {
  id: 'bayouSunset',
  label: 'Bayou sunset',
  map: 'mirelight',
  atmosphere: (a) => ({ ...a, weather: 'none', sunDir: [-0.3, 0.075, -1] }),
  sky: { cloudCover: 0.5, sunDisk: 16, sunSize: 0.036, sunGlow: 1.4, shafts: 0.1 },
  rim: { intensity: 1.6, dir: [-0.85, 0.3, -0.4] },
  hemi: { sky: 0x3c3a6c, ground: 0x2a2016, intensity: 0.75 },
  fog: { color: 0x6a4c5a, density: 0.02 },
  envIntensity: 0.55,
  key: { kind: 'lantern', color: 0xffb46a, intensity: 10, angle: 1.2, penumbra: 0.9 },
  lanterns: 1.25,
  water: { color: 0x090d0e, glow: 0x000000, glowIntensity: 0, roughness: 0.05, ripple: 0.45, tile: 3.6, env: 1 },
  sheen: 0.3,
  mist: {
    color: 0xe0a090,
    glow: 0.4,
    alpha: 0.42,
    rows: [
      [-10.6, -14, 26, 3.5],
      [-16.6, -18, 30, 4.5],
      [-23, -20, 36, 5.5],
      [-33, -24, 44, 6.5],
      [-45, -30, 52, 7.5],
    ],
    sheets: [
      [5, -6, 8, 4, 0.3],
      [9, -13, 12, 6, 0.34],
      [4, -20, 14, 7, 0.34],
    ],
  },
  lunker: { x: 0, z: 0, yaw: -0.38 },
  platforms: [{ kind: 'dock', x: -0.4, z: -6, w: 3.8, d: 22, rot: 0, seed: 5 }],
  obstacles: [
    c('lanternpost', -2.3, -0.9, 0.3, 2),
    c('swampstump', -3.9, 2.6, 0.8, 3),
    c('cypress', -6.4, -3.2, 1.2, 4),
    c('cypress', -9.2, -12, 1.4, 5),
    c('cypress', -4.6, -20.5, 1.2, 6),
    c('lanternpost', 1.35, -8.2, 0.3, 7),
    c('deadtree', 8.4, -10, 0.8, 8),
    c('stilthut', 11, -30, 1.6, 9),
    c('cypress', 17, -37, 1.4, 10),
    c('cypress', 26, -44, 1.5, 11),
    c('mossrock', 3.8, -14.5, 0.9, 12),
    c('stilthut', -12, -40, 1.6, 13),
  ],
  decor: [
    d('cattail', 2.1, 2.5, 1.1, 1),
    d('cattail', 2.7, 0.3, 1, 2),
    d('cattail', 3.3, -3.6, 1.2, 3),
    d('reeds', 2.4, 1.3, 1, 4),
    d('reeds', 4.4, -5.2, 1.1, 5),
    d('lilypad', 3.6, -1.2, 1, 6),
    d('lilypad', 4.7, -6.3, 1.2, 7),
    d('lilypad', 3.0, -9.2, 1, 8),
    d('lilypad', 6.2, -3.5, 0.9, 9),
    d('firefly_swarm', 3.2, -5, 1, 10),
    d('firefly_swarm', -4.2, -8, 1, 11),
    d('lantern', -1.75, 3.5, 1, 12),
    d('rowboat', 3.4, -11, 1, 13, -0.3),
  ],
  slabs: [
    { x0: -18, x1: -2.55, z0: -44, z1: 8, top: -0.06, depth: 2.6, style: MUD, seed: 3, voxel: 0.25 },
    { x0: 8, x1: 44, z0: -64, z1: -26, top: -0.12, depth: 2.6, style: MUD, seed: 4, voxel: 0.25 },
  ],
  landmarks: [],
  movers: [],
};

// Frozen harbour (ref 05): a snowy dock, ice floes and shelf ice in the dark lead, a watchtower and
// snow pines on the bank, white peaks under the aurora.
const FROZEN_HARBOUR: ShowcaseTheme = {
  id: 'frozenHarbour',
  label: 'Frozen harbour',
  map: 'aurora',
  atmosphere: (a) => ({ ...a, weather: 'none', sunDir: [0.3, 0.42, -1] }),
  sky: { cloudCover: 0.3, stars: 1, sunDisk: 5, sunGlow: 0.7 },
  rim: { intensity: 1.3, dir: [0.9, 0.5, -0.1] },
  hemi: { sky: 0x2a3c6a, ground: 0x283058, intensity: 0.7 },
  fog: { color: 0x26345a, density: 0.012 },
  envIntensity: 0.6,
  key: { kind: 'lantern', color: 0xffa654, intensity: 18, angle: 1.15, penumbra: 0.85 },
  lanterns: 1.1,
  water: { color: 0x04101c, glow: 0x0a2e48, glowIntensity: 0.12, roughness: 0.05, ripple: 0.5, tile: 3.6, env: 1 },
  sheen: 0.45,
  mist: {
    color: 0x5a6c9c,
    glow: 0.5,
    alpha: 0.32,
    rows: [
      [-13.6, -14, 28, 4],
      [-19.4, -16, 34, 5],
      [-32.5, -20, 46, 6],
      [-43, -24, 56, 7],
    ],
    sheets: [
      [6, -12, 10, 5, 0.14],
      [12, -19, 12, 6, 0.16],
    ],
  },
  lunker: { x: 0, z: 0, yaw: -0.38 },
  // the ice sits in the strip of open water the 16:9 frame shows right of the Lunker (screen x 0.88 to
  // 1.0: x of about 2.3 to 2.8 m at z -5, 4 to 5 m at z -12, 7 to 8.5 m at z -24); further right is off-frame.
  // The nearest piece is a small floe, not an ice rock: the props' glossy ice rock gets only the dim fill on
  // its camera side at night and reads as a black-violet lump there, while a floe's snow cap and glowing
  // pressure ridges read as ice (ref05). It stays in frame across the whole camera drift.
  platforms: [
    { kind: 'dock', x: -0.6, z: -7, w: 5, d: 24, rot: 0, seed: 7 },
    { kind: 'floe', x: 3.4, z: -5.4, w: 1.7, d: 1.4, rot: 0.5, seed: 12 },
    { kind: 'floe', x: 4.5, z: -8.6, w: 2.8, d: 2.2, rot: 0.35, seed: 8 },
    { kind: 'floe', x: 5.9, z: -15.2, w: 3.6, d: 2.8, rot: -0.25, seed: 9 },
    { kind: 'floe', x: 11, z: -27.5, w: 4, d: 3, rot: 0.6, seed: 11 },
    { kind: 'floe', x: 9.4, z: -33, w: 5, d: 3.6, rot: 0.2, seed: 10 },
  ],
  obstacles: [
    c('lanternpost', -2.45, -0.9, 0.3, 2),
    c('crate', -2.55, 2.5, 0.5, 3),
    c('barrel', -2.6, -3.2, 0.4, 4),
    c('snowpine', -6.8, -4.2, 1.0, 5),
    c('snowpine', -7.2, -9.5, 1.2, 6),
    c('watchtower', -5.6, -16.5, 1.4, 7),
    c('snowpine', -9.5, -22, 1.3, 8),
    c('iceshelf', 7.6, -21.5, 1.5, 9),
    c('iceshelf', 12.5, -37, 2.2, 10),
    c('lanternpost', 1.45, -9.4, 0.3, 12),
    c('watchtower', 22, -50, 1.4, 13),
    c('snowpine', 14, -52, 1.4, 14),
    c('snowpine', 30, -54, 1.5, 15),
  ],
  decor: [d('lantern', -2.05, 3.7, 1, 3), d('snowtuft', -2.9, 1.2, 1, 4), d('snowtuft', 1.3, 2.6, 1, 5), d('icicles', -2.4, -5.6, 1, 6)],
  slabs: [
    { x0: -16, x1: -3.15, z0: -36, z1: 8, top: 0.05, depth: 3, style: SNOW, seed: 5, voxel: 0.25 },
    // the props' ice-theme deck top is a high-contrast snow blotch pattern that reads as a cow hide at this
    // low angle: lay an even sheet of fresh snow over the planks instead (their posts, rails and icicles stay)
    { x0: -3.02, x1: 1.82, z0: -18.8, z1: 5, top: 0.08, depth: 0.08, style: DECK_SNOW, seed: 8, voxel: 0.08, onDeck: true },
    { x0: -10, x1: 64, z0: -70, z1: -46, top: 0.4, depth: 3, style: SNOW, seed: 6, voxel: 0.25 },
  ],
  landmarks: [
    { kind: 'ridge', x: 20, z: -150, y: -1, yaw: 0, size: 1.2, seed: 3, nx: 150, nz: 26, h: 52 },
    { kind: 'ridge', x: -70, z: -135, y: -1, yaw: 0.35, size: 1.1, seed: 9, nx: 110, nz: 24, h: 44 },
  ],
  movers: [],
};

// Lagoon day (ref 06): a sun-bleached dock over turquoise water, palms on the sand at the left, sea
// stacks and a wreck across the lagoon, palm islands on the horizon.
const LAGOON_DAY: ShowcaseTheme = {
  id: 'lagoonDay',
  label: 'Lagoon day',
  map: 'maelstrom',
  atmosphere: (a) => ({ ...a, weather: 'none', sunDir: [0.55, 0.62, 0.55] }),
  sky: { cloudCover: 0.42 },
  rim: { intensity: 0.6, color: 0xcfe6ff },
  hemi: { sky: 0x9ccfff, ground: 0xa08e62, intensity: 1.05 },
  fog: { color: 0xc4e8f4, density: 0.0045 },
  envIntensity: 0.7,
  key: { kind: 'sun', color: 0xfff0d2, intensity: 3.4, angle: 0.5, penumbra: 0.2, dir: [0.55, 0.62, 0.55] },
  lanterns: 0.25,
  water: { color: 0x0b6c80, glow: 0x14a8b0, glowIntensity: 0.32, roughness: 0.04, ripple: 0.6, tile: 3.2, env: 1 },
  sheen: 0,
  mist: { color: 0xdcf2f8, glow: 0, alpha: 0.12, rows: [[-26, -20, 40, 3], [-46, -30, 60, 4], [-80, -60, 100, 6]], sheets: [] },
  lunker: { x: 0, z: 0, yaw: -0.38 },
  platforms: [{ kind: 'dock', x: -0.6, z: -7, w: 4.6, d: 24, rot: 0, seed: 9 }],
  obstacles: [
    c('cratepile', -2.3, -2.8, 0.9, 3),
    c('barrel', -2.55, 2.4, 0.4, 4),
    c('palm', -5.8, -3.0, 0.6, 5),
    c('palm', -7.6, -8.2, 0.7, 6),
    c('palm', -5.6, -16, 0.6, 7),
    c('seastack', 7.8, -15, 2, 8),
    c('seastack', -1, -38, 2.6, 9),
    c('coralrock', 4.2, -5.2, 0.6, 10),
    w('shipwreck', 14, -28, 22, -38, 1.5, 3, 11),
    c('palm', -10, -22, 0.7, 12),
  ],
  decor: [d('coralfan', 3.3, -2.2, 1, 1), d('coralfan', 4.6, -8.4, 1.2, 2), d('starfish', -4.2, 1.2, 1, 3), d('shell', -3.8, 2.6, 1, 4), d('treasure', -2.6, -0.9, 0.8, 5)],
  slabs: [{ x0: -18, x1: -3.0, z0: -40, z1: 8, top: -0.05, depth: 2.4, style: SAND, seed: 7, voxel: 0.25 }],
  landmarks: [
    { kind: 'island', x: 70, z: -170, y: -0.6, yaw: 0.3, size: 0.8, seed: 11, nx: 70, nz: 40, h: 14, palms: 4 },
    { kind: 'island', x: -40, z: -210, y: -0.6, yaw: 0.6, size: 1.1, seed: 37, nx: 90, nz: 50, h: 20, palms: 3 },
    { kind: 'island', x: 20, z: -120, y: -0.6, yaw: 1.1, size: 0.55, seed: 21, nx: 30, nz: 22, h: 6, palms: 1 },
  ],
  movers: [],
};

export const THEMES: Record<ShowcaseThemeId, ShowcaseTheme> = {
  harbourNight: HARBOUR_NIGHT,
  bayouSunset: BAYOU_SUNSET,
  frozenHarbour: FROZEN_HARBOUR,
  lagoonDay: LAGOON_DAY,
};

/**
 * The stage layout as a MapDef for the props builders: the theme's real map (its palettes and props
 * theme) with the stage's content. Its time of day is 'day' on purpose: the props module's night / dusk
 * variants add a view-angle fresnel rim that keeps silhouettes readable from the high gameplay camera,
 * but at the showcase's grazing angle it lights every flat deck and quay top pale blue. The stage's own
 * moon rim, lanterns and fill do that job here. The theme's look comes from themeAtmosphere().
 */
export function stageMap(base: MapDef, t: ShowcaseTheme): MapDef {
  return {
    ...base,
    // a 1 x 1 m extent: map-wide procedural clutter (the props module's Epic extraDecor scatters coral,
    // gears and chains over the whole 72 x 48 m map by the real map's river) would land on the wrong
    // ground here (coral on the dry sandbar); the stage dresses itself. Nothing else reads w / d.
    w: 1,
    d: 1,
    atmosphere: { ...t.atmosphere(base.atmosphere), timeOfDay: 'day' },
    platforms: t.platforms,
    obstacles: t.obstacles,
    decor: t.decor,
    movers: [],
    islands: [],
    pools: [],
    channels: [],
  };
}

/** Is (x, z) on the platform's walkable rectangle (its rotation included)? */
export function inPlatform(p: Platform, x: number, z: number): boolean {
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const dx = x - p.x;
  const dz = z - p.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= p.w / 2 && Math.abs(lz) <= p.d / 2;
}

/**
 * The surfaces that get the wet sheen: docks and piers no snow sheet covers, and the bare slab tops
 * (quays, banks, sandbars). Snow never looks wet: no sheen on a deck under snow, nor on the snow itself.
 */
export function sheenSurfaces(t: ShowcaseTheme): { platforms: Platform[]; slabs: SlabDef[] } {
  if (!(t.sheen > 0)) return { platforms: [], slabs: [] };
  const snowed = (p: Platform): boolean => t.slabs.some((s) => s.onDeck && inPlatform(p, (s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2));
  return {
    platforms: t.platforms.filter((p) => (p.kind === 'dock' || p.kind === 'pier') && !snowed(p)),
    slabs: t.slabs.filter((s) => !s.onDeck && !s.style.soft),
  };
}

/** The theme's atmosphere (sky, sun / moon, time of day) for the look. */
export function themeAtmosphere(base: MapDef, t: ShowcaseTheme): Atmosphere {
  return t.atmosphere(base.atmosphere);
}

/**
 * The theme's mist rows as veils. Each veil is lifted clear of the highest ground under it (no deck or
 * quay cuts a hard line through it) and slid along z until it clears every prop standing across its
 * width by the prop's radius plus a margin (a veil through a lamp post shows as a hard edge on it).
 */
export function mistVeils(t: ShowcaseTheme, height: (x: number, z: number) => number, water: number): Veil[] {
  const out: Veil[] = [];
  let seed = 1;
  const w = 9;
  const props = t.obstacles.map((o) =>
    o.shape === 'circle'
      ? { x0: o.x - o.r, x1: o.x + o.r, z0: o.z - o.r, z1: o.z + o.r }
      : { x0: Math.min(o.ax, o.bx) - o.r, x1: Math.max(o.ax, o.bx) + o.r, z0: Math.min(o.az, o.bz) - o.r, z1: Math.max(o.az, o.bz) + o.r },
  );
  const MARGIN = 0.45;
  const clear = (cx: number, z: number) => props.every((p) => p.x1 < cx - w / 2 || p.x0 > cx + w / 2 || z < p.z0 - MARGIN || z > p.z1 + MARGIN);
  for (const [z, x0, x1, h] of t.mist.rows) {
    for (let x = x0; x < x1; x += 7) {
      const cx = x + 3.5;
      let vz = z + (((seed * 0.377) % 1) - 0.5) * 1.2;
      // nearest clear z within 3 m (back first: veils behind props read better than in front)
      let found = clear(cx, vz);
      for (let k = 1; !found && k <= 30; k++) {
        const dz = (k >> 1) * 0.2 * (k % 2 ? -1 : 1);
        if (clear(cx, vz + dz)) {
          vz += dz;
          found = true;
        }
      }
      if (!found) {
        seed++;
        continue;
      }
      let base = water;
      for (let k = -2; k <= 2; k++) base = Math.max(base, height(cx + (k * w) / 4, vz));
      out.push({ x: cx, z: vz, y: base + 0.3, w, h: h * 1.5, yaw: 0, alpha: t.mist.alpha, upright: true, seed: (seed++ * 7.31) % 50 });
    }
  }
  for (const [x, z, sw, sd, a] of t.mist.sheets) out.push({ x, z, y: water + 0.12, w: sw, h: sd, yaw: 0.3 * seed, alpha: a, upright: false, seed: (seed++ * 3.17) % 50 });
  return out;
}
