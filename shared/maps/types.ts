// Map definition format. One MapDef drives both the simulation (collision, river, spawns)
// and the renderer (terrain, props, decor, atmosphere).
//
// Coordinates: world X/Z ground plane, Y up. Team 0 lives on -X, team 1 on +X.
// The river runs roughly along Z through x = 0. Map spans x in [-w/2, w/2], z in [-d/2, d/2].
import type { HazardKind, MapId } from '../types.ts';
import type { Vec2 } from '../math.ts';

/** Blocking props. Every kind must have a voxel model in client/render/models/props.ts. */
export type PropKind =
  // Muckmire Bayou
  | 'cypress'
  | 'deadtree'
  | 'mossrock'
  | 'stump'
  // Frostfang Fjord
  | 'pine'
  | 'icerock'
  | 'icepillar'
  | 'runestone'
  // Coral Cove
  | 'palm'
  | 'coralrock'
  | 'reefpost' // bouncy: hooks always ricochet off it
  | 'tikitotem'
  // Cogwater Canal
  | 'crate'
  | 'barrel'
  | 'bollard'
  | 'lamppost'
  | 'pipe'
  // Mirelight Marsh (braided swamp)
  | 'stilthut' // a little hut on stilts (circle, r ~ 1.6)
  | 'swampstump' // a big hollow cypress stump
  | 'lanternpost' // tall wooden post with a hanging lantern (emissive)
  // Aurora Harbour (ice floes, fjord village)
  | 'watchtower' // timber watchtower with a lit lamp (circle, r ~ 1.4)
  | 'snowpine'
  | 'iceshelf' // a chunky block of glacier ice
  // Maelstrom Lagoon (whirlpool cove)
  | 'seastack' // a tall rock pillar standing in the water, palms and vines on top
  | 'shipwreck' // the broken hull of a ship (wall segment)
  | 'cratepile'
  // Lantern Wharf (canal city)
  | 'crane' // a dockside timber crane with a hanging hook and load
  | 'warehouse' // a brick warehouse frontage (wall segment, tall)
  | 'gaslamp'
  | 'bridgepier' // stone pier column under a bridge
  // Walls (segments)
  | 'wall_wood'
  | 'wall_stone'
  | 'wall_ice'
  | 'wall_brick'
  | 'wall_hedge';

/** Moving obstacles that drift along the river and block hooks. */
export type MoverKind = 'icefloe' | 'barge' | 'log' | 'raft';

/** Visual only, never collides. */
export type DecorKind =
  | 'grass'
  | 'reeds'
  | 'lilypad'
  | 'mushroom'
  | 'flower'
  | 'fern'
  | 'snowtuft'
  | 'icicle'
  | 'shell'
  | 'starfish'
  | 'seaweed'
  | 'pebbles'
  | 'bones'
  | 'lantern'
  | 'rope'
  | 'gear'
  | 'sign'
  | 'firefly_swarm'
  | 'waterfall'
  | 'lockgate'
  // added for the four reference maps
  | 'cattail'
  | 'mist' // a low drifting mist bank
  | 'lanternstring' // a rope of little lanterns between two posts
  | 'ropebridge' // a high rope bridge (visual only, above play)
  | 'banner'
  | 'icicles'
  | 'coralfan'
  | 'treasure'
  | 'chainhang'
  | 'cargonet'
  | 'rowboat' // a moored rowboat
  | 'flag';

/** Walkable decks over water: docks, bridges, piers, frozen floes. Hooks fly over them. */
export type PlatformKind = 'dock' | 'bridge' | 'pier' | 'floe' | 'raftdeck';

export interface Platform {
  kind: PlatformKind;
  x: number;
  z: number;
  w: number; // size along the platform's local x
  d: number; // size along the platform's local z
  rot: number; // yaw in radians
  seed?: number;
}

/** Extra open water: lagoons, harbour basins (a rotated ellipse). */
export interface Pool {
  x: number;
  z: number;
  rx: number;
  rz: number;
  rot: number;
}

export interface CircleObstacle {
  shape: 'circle';
  kind: PropKind;
  x: number;
  z: number;
  r: number; // collision radius
  bouncy?: boolean;
  rot?: number; // visual yaw
  scale?: number; // visual scale
  seed?: number; // visual variation
}

export interface WallObstacle {
  shape: 'wall';
  kind: PropKind;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number; // half thickness
  bouncy?: boolean;
  h?: number; // visual height in metres
  seed?: number;
}

export type Obstacle = CircleObstacle | WallObstacle;

export interface RiverPoint {
  z: number; // sorted ascending, first <= -d/2, last >= d/2
  x: number; // centreline x
  hw: number; // half width of the channel
}

export interface RiverDef {
  points: RiverPoint[];
  depth: number; // visual depth of the bed below the bank top (metres)
  bank: number; // visual width of the sloped bank outside the channel edge (metres)
  flow: number; // visual flow speed along +z (m/s), negative flows to -z
}

export interface MoverDef {
  kind: MoverKind;
  r: number; // radius (circle) or half width (capsule)
  len: number; // 0 = circle, > 0 = capsule length along the river
  lane: number; // -1..1 fraction of the half width from the centreline
  speed: number; // m/s along z (sign = direction)
  offset: number; // starting z
  seed?: number;
}

export interface TideDef {
  style: 'tide' | 'locks' | 'freeze';
  // For 'tide'/'locks': low -> rising -> high -> falling.
  // For 'freeze': frozen (=low) -> cracking (=falling... see sim/river.ts) -> thawed (=high) -> freezing.
  lowSec: number;
  risingSec: number;
  highSec: number;
  fallingSec: number;
}

export interface HazardSlot {
  x: number;
  z: number;
  r: number;
  channel: boolean; // inside the river channel (only used when the bed is not deep water)
}

export interface Circle {
  x: number;
  z: number;
  r: number;
}

export interface Whirlpool extends Circle {
  strength: number; // radians per second of hook bend at the rim, more toward the centre
}

export interface Decor {
  kind: DecorKind;
  x: number;
  z: number;
  rot: number;
  scale: number;
  seed: number;
}

export type Weather = 'none' | 'fireflies' | 'snow' | 'rain' | 'pollen';

export interface Atmosphere {
  timeOfDay: 'dawn' | 'day' | 'dusk' | 'night';
  sunDir: [number, number, number]; // direction TO the sun, normalised by the renderer
  sunColor: number;
  sunIntensity: number;
  skyTop: number;
  skyHorizon: number;
  groundAmbient: number;
  ambientIntensity: number;
  fogColor: number;
  fogDensity: number; // FogExp2 density
  weather: Weather;
  aurora: boolean;
  waterShallow: number;
  waterDeep: number;
  waterFoam: number;
  exposure: number;
  saturation: number; // 1 = neutral
  bloom: number; // 0..1 bloom strength hint
}

export interface TerrainStyle {
  grass: number[]; // palette for ground top voxels
  dirt: number[]; // ground side voxels and paths
  bank: number[]; // sloped bank voxels
  bed: number[]; // wet river bed
  dryBed: number[]; // dry river bed (cracked mud, sand, cobbles)
  cliff: number[]; // map border cliffs
  baseHeight: number; // bank top height above y = 0
  noiseAmp: number; // visual height jitter on the playable ground (keep < 0.35)
  noiseScale: number;
  border: 'cliff' | 'ice' | 'wall' | 'jungle';
}

export interface MapDef {
  id: MapId;
  name: string;
  blurb: string;
  w: number; // x extent
  d: number; // z extent
  river: RiverDef;
  /** extra braided channels (points need only cover their own z range; outside it they add nothing) */
  channels?: RiverDef[];
  /** extra open water (lagoons, basins) */
  pools?: Pool[];
  /** walkable decks over water (docks, bridges, piers, floes): channelDepthAt is negative on them */
  platforms?: Platform[];
  islands: Circle[]; // ground islands inside the channel
  tide?: TideDef; // present = map supports the Tidal river mode
  special: HazardKind; // the map's own special hazard
  spawns: [Vec2[], Vec2[]]; // 5 per team
  fountains: [Circle, Circle];
  obstacles: Obstacle[];
  movers: MoverDef[];
  whirlpool?: Whirlpool;
  runeSpots: Vec2[];
  hazardSlots: HazardSlot[];
  decor: Decor[];
  atmosphere: Atmosphere;
  terrain: TerrainStyle;
}
