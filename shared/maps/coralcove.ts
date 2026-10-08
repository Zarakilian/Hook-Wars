// Coral Cove: tropical turquoise lagoon with a central whirlpool that bends hooks. Real tides.
import { channelDepthAt, clearOf, curvyRiver, scatter, withMirrors } from './helpers.ts';
import type { Decor, MapDef, Obstacle } from './types.ts';

const W = 72;
const D = 48;

const river = { points: curvyRiver(D, { amp: 1.6, freq: 0.13, phase: 2.1, hw: 5.3, hwVar: 0.7 }), depth: 2.4, bank: 3.5, flow: 0.25 };
const islands = [{ x: 0, z: -13, r: 1.8 }, { x: 0, z: 13, r: 1.8 }];

const half: Obstacle[] = [
  { shape: 'circle', kind: 'palm', x: -11, z: -10, r: 0.7, seed: 1 },
  { shape: 'circle', kind: 'palm', x: -14, z: 10, r: 0.7, seed: 2 },
  { shape: 'circle', kind: 'coralrock', x: -9.6, z: 2, r: 1.2, seed: 3 },
  { shape: 'circle', kind: 'reefpost', x: -8.2, z: -16, r: 0.5, bouncy: true, seed: 4 },
  { shape: 'circle', kind: 'reefpost', x: -8.4, z: 17, r: 0.5, bouncy: true, seed: 5 },
  { shape: 'circle', kind: 'tikitotem', x: -19, z: 0, r: 0.75, seed: 6 },
  { shape: 'circle', kind: 'coralrock', x: -22, z: -13, r: 1.4, seed: 7 },
  { shape: 'circle', kind: 'palm', x: -26, z: 9, r: 0.7, seed: 8 },
];
const obstacles = withMirrors(half);

const partial: Pick<MapDef, 'w' | 'd' | 'river' | 'islands'> = { w: W, d: D, river, islands };
const onGround = (x: number, z: number) => channelDepthAt(partial, x, z) < -1.2 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 2;
const inWater = (x: number, z: number) => channelDepthAt(partial, x, z) > 1;

const decor: Decor[] = [
  ...scatter(partial, { kind: 'grass', count: 150, seed: 31, scale: [0.6, 1.1], accept: (x, z) => onGround(x, z) && Math.abs(x) > 14 }),
  ...scatter(partial, { kind: 'shell', count: 50, seed: 32, scale: [0.6, 1.2], accept: (x, z) => { const c = channelDepthAt(partial, x, z); return c > -3.5 && c < 0.2; } }),
  ...scatter(partial, { kind: 'starfish', count: 30, seed: 33, scale: [0.6, 1.2], accept: (x, z) => { const c = channelDepthAt(partial, x, z); return c > -2 && c < 2; } }),
  ...scatter(partial, { kind: 'seaweed', count: 50, seed: 34, scale: [0.7, 1.3], accept: inWater }),
  { kind: 'waterfall', x: 0, z: -D / 2, rot: 0, scale: 1, seed: 1 },
];

export const coralcove: MapDef = {
  id: 'coralcove',
  name: 'Coral Cove',
  blurb: 'A sunlit lagoon. Reef posts ricochet hooks and the whirlpool bends them. On Tidal, the sea rolls in and out.',
  w: W,
  d: D,
  river,
  islands,
  tide: { style: 'tide', lowSec: 24, risingSec: 9, highSec: 30, fallingSec: 9 },
  special: 'jellyfish',
  spawns: [
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }],
  ],
  fountains: [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }],
  obstacles,
  movers: [{ kind: 'raft', r: 1.1, len: 1.6, lane: 0.3, speed: 1.2, offset: 0, seed: 1 }],
  whirlpool: { x: 0, z: 0, r: 4.2, strength: 2.4 },
  runeSpots: [{ x: 0, z: -13 }, { x: 0, z: 13 }, { x: 0, z: 0 }],
  hazardSlots: [
    { x: 2, z: -6, r: 1.7, channel: true },
    { x: -2, z: 6, r: 1.7, channel: true },
    { x: 2.5, z: 19, r: 1.6, channel: true },
    { x: -2.5, z: -19, r: 1.6, channel: true },
    { x: -13, z: -4, r: 1.6, channel: false },
    { x: 13, z: 4, r: 1.6, channel: false },
  ],
  decor,
  atmosphere: {
    timeOfDay: 'day',
    sunDir: [0.3, 0.85, 0.25],
    sunColor: 0xfff1d6,
    sunIntensity: 3.2,
    skyTop: 0x3d8fe0,
    skyHorizon: 0xbfe6ff,
    groundAmbient: 0x6a5a3c,
    ambientIntensity: 1.1,
    fogColor: 0xb8e2f2,
    fogDensity: 0.006,
    weather: 'pollen',
    aurora: false,
    waterShallow: 0x3fe0d0,
    waterDeep: 0x0a5a8a,
    waterFoam: 0xffffff,
    exposure: 1,
    saturation: 1.12,
    bloom: 0.4,
  },
  terrain: {
    grass: [0x7fb04a, 0x8cbc52, 0x6fa040],
    dirt: [0xe8d6a6, 0xdcc894, 0xf0e0b4],
    bank: [0xeedcae, 0xe4d09c, 0xf6e8c2],
    bed: [0xd8c79a, 0xc9b788, 0xe2d3a8],
    dryBed: [0xe9dbb3, 0xdccca0, 0xf2e6c4, 0xcfbf92],
    cliff: [0x9a8a6a, 0x8a7a5c, 0xaa9a78],
    baseHeight: 1.1,
    noiseAmp: 0.15,
    noiseScale: 0.14,
    border: 'jungle',
  },
};
