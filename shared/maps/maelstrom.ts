// Maelstrom Lagoon: a sunlit cove with a great whirlpool in a round lagoon (reference: the tropical cove
// with waterfalls, sea stacks, piers and a shipwreck). The whirlpool bends every hook that crosses it.
// Tidal mode: the sea rolls in and out. Point symmetric through (0, 0).
import { channelDepthAt, clearOf, scatter, symmetricRiver, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle, Platform, Pool, RiverDef } from './types.ts';

const W = 72;
const D = 48;

const river: RiverDef = { points: symmetricRiver(D, { amp: 0.8, freq: 0.12, hw: 3.6, hwVar: 0.3, hwFreq: 0.2 }), depth: 2.6, bank: 3.2, flow: 0.3 };
const pools: Pool[] = [{ x: 0, z: 0, rx: 10.5, rz: 8.6, rot: 0 }];
const islands = [
  { x: -5.6, z: 5.2, r: 1.7 }, // sea-stack islets
  { x: 5.6, z: -5.2, r: 1.7 },
  { x: 0.3, z: -14, r: 1.3 },
  { x: -0.3, z: 14, r: 1.3 },
];
const platforms: Platform[] = [
  { kind: 'pier', x: -9.6, z: -3.2, w: 3.6, d: 1.6, rot: 0, seed: 1 },
  { kind: 'pier', x: 9.6, z: 3.2, w: 3.6, d: 1.6, rot: 0, seed: 2 },
];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const half: Obstacle[] = [
  { shape: 'circle', kind: 'seastack', x: -5.6, z: 5.2, r: 1.1, seed: 1 },
  { shape: 'circle', kind: 'palm', x: -13.5, z: -7, r: 0.7, seed: 2 },
  { shape: 'circle', kind: 'cratepile', x: -12.5, z: 2.5, r: 1.0, seed: 3 },
  { shape: 'circle', kind: 'reefpost', x: -11.2, z: 8.6, r: 0.5, bouncy: true, seed: 4 },
  { shape: 'circle', kind: 'coralrock', x: -6.8, z: -14, r: 1.1, seed: 5 },
  { shape: 'circle', kind: 'palm', x: -17, z: 12, r: 0.7, seed: 6 },
  { shape: 'circle', kind: 'tikitotem', x: -20, z: -2, r: 0.75, seed: 7 },
  { shape: 'circle', kind: 'palm', x: -24, z: -13, r: 0.7, seed: 8 },
  { shape: 'wall', kind: 'shipwreck', ax: -9.5, az: 16.5, bx: -5.8, bz: 19.5, r: 0.9, h: 3, seed: 9 },
];
const obstacles = withMirrors(half);

const partial = { w: W, d: D, river, pools, platforms, islands };
const depth = (x: number, z: number) => channelDepthAt(partial, x, z);
const onGround = (x: number, z: number) => depth(x, z) < -1.0 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 2;

const decor: Decor[] = [
  ...scatter(partial, { kind: 'grass', count: 140, seed: 71, scale: [0.6, 1.1], accept: (x, z) => onGround(x, z) && Math.abs(x) > 15 }),
  ...scatter(partial, { kind: 'shell', count: 40, seed: 72, scale: [0.6, 1.2], accept: (x, z) => { const c = depth(x, z); return c > -3.2 && c < 0.2; } }),
  ...scatter(partial, { kind: 'starfish', count: 30, seed: 73, scale: [0.6, 1.2], accept: (x, z) => { const c = depth(x, z); return c > -2 && c < 2; } }),
  ...scatter(partial, { kind: 'coralfan', count: 40, seed: 74, scale: [0.7, 1.3], accept: (x, z) => depth(x, z) > 1 }),
  ...scatter(partial, { kind: 'seaweed', count: 40, seed: 75, scale: [0.7, 1.3], accept: (x, z) => depth(x, z) > 1 }),
  { kind: 'waterfall', x: 0, z: -D / 2, rot: 0, scale: 1, seed: 1 },
  { kind: 'treasure', x: -5.6, z: 6.6, rot: 0.3, scale: 1, seed: 2 },
  { kind: 'treasure', x: 5.6, z: -6.6, rot: 0.3 + Math.PI, scale: 1, seed: 3 },
];

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: 6, z: 4, r: 1.6, channel: true },
  { x: -1.6, z: 20, r: 1.5, channel: true },
  { x: -10.5, z: -11, r: 1.4, channel: false },
  { x: -16, z: 5, r: 1.5, channel: false },
]);

export const maelstrom: MapDef = {
  id: 'maelstrom',
  name: 'Maelstrom Lagoon',
  blurb: 'A sunny cove around a giant whirlpool that bends every hook crossing it. Piers and sea stacks frame the lagoon. On Tidal, the sea rolls in and out.',
  w: W,
  d: D,
  river,
  pools,
  platforms,
  islands,
  tide: { style: 'tide', lowSec: 24, risingSec: 9, highSec: 30, fallingSec: 9 },
  special: 'jellyfish',
  spawns: [
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }],
  ],
  fountains,
  obstacles,
  movers: [{ kind: 'raft', r: 1.0, len: 1.6, lane: 0.3, speed: 1.0, offset: 4, seed: 1 }],
  whirlpool: { x: 0, z: 0, r: 6.2, strength: 3.2 },
  runeSpots: [{ x: 0.3, z: -14 }, { x: -0.3, z: 14 }, { x: 0, z: 0 }],
  hazardSlots,
  decor,
  atmosphere: {
    timeOfDay: 'day',
    sunDir: [0.35, 0.82, 0.3],
    sunColor: 0xfff0d0,
    sunIntensity: 3.3,
    skyTop: 0x3e92e6,
    skyHorizon: 0xc8ecff,
    groundAmbient: 0x6a5a3a,
    ambientIntensity: 1.1,
    fogColor: 0xbfe6f4,
    fogDensity: 0.006,
    weather: 'pollen',
    aurora: false,
    waterShallow: 0x3ee6d6,
    waterDeep: 0x0a628e,
    waterFoam: 0xffffff,
    exposure: 1,
    saturation: 1.16,
    bloom: 0.4,
  },
  terrain: {
    grass: [0x7ab048, 0x88bc50, 0x6aa03e, 0x94c45a],
    dirt: [0xe8d4a2, 0xdcc690, 0xf0e0b2],
    bank: [0xf0dcaa, 0xe6d098, 0xf8e8c0],
    bed: [0xd6c496, 0xc8b484, 0xe0d0a4],
    dryBed: [0xe8d8ae, 0xdaca9c, 0xf2e4c0, 0xcebe90],
    cliff: [0x9a8c70, 0x8a7c60, 0xaa9c7e, 0x7e7058],
    baseHeight: 1.15,
    noiseAmp: 0.13,
    noiseScale: 0.14,
    border: 'jungle',
  },
};
