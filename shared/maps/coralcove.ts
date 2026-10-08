// Coral Cove: tropical turquoise lagoon with a central whirlpool that bends hooks. Real tides.
// The river falls in over a waterfall cliff at z = -24 and runs out to the sea past z = +24.
// Layout is point symmetric: the river and every gameplay element mirror through (0, 0).
import { channelDepthAt, clearOf, inCircles, riverAt, scatter, symmetricRiver, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle } from './types.ts';

const W = 72;
const D = 48;

const points = symmetricRiver(D, { amp: 1.6, freq: 0.13, amp3: 0.3, hw: 5.1, hwVar: 0.45, hwFreq: 0.2 });
const river = { points, depth: 2.4, bank: 3.5, flow: 0.25 };
const islandX = riverAt(points, 13).x;
const islands = [{ x: -islandX, z: -13, r: 1.8 }, { x: islandX, z: 13, r: 1.8 }];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const half: Obstacle[] = [
  // bank cover: coral rocks and palms, plus bouncy reef posts that ricochet hooks
  { shape: 'circle', kind: 'coralrock', x: -7.6, z: 2, r: 1.2, seed: 3 },
  { shape: 'circle', kind: 'reefpost', x: -8.4, z: -16, r: 0.5, bouncy: true, seed: 4 },
  { shape: 'circle', kind: 'reefpost', x: -6.0, z: 17, r: 0.5, bouncy: true, seed: 5 },
  { shape: 'circle', kind: 'palm', x: -9.6, z: -9.5, r: 0.7, seed: 1 },
  { shape: 'circle', kind: 'palm', x: -7.0, z: 10, r: 0.7, seed: 2 },
  // midfield
  { shape: 'circle', kind: 'coralrock', x: -14, z: -3, r: 1.1, seed: 9 },
  { shape: 'circle', kind: 'tikitotem', x: -17.5, z: 8, r: 0.75, seed: 6 },
  { shape: 'circle', kind: 'palm', x: -15, z: -15, r: 0.7, seed: 10 },
  { shape: 'circle', kind: 'palm', x: -13, z: 19, r: 0.7, seed: 11 },
  { shape: 'circle', kind: 'coralrock', x: -20.5, z: 15, r: 1.3, seed: 12 },
  // backfield
  { shape: 'circle', kind: 'tikitotem', x: -22.5, z: -7, r: 0.75, seed: 13 },
  { shape: 'circle', kind: 'palm', x: -25, z: 11, r: 0.7, seed: 14 },
  { shape: 'circle', kind: 'coralrock', x: -24, z: -17, r: 1.4, seed: 7 },
  { shape: 'circle', kind: 'palm', x: -29, z: -15, r: 0.7, seed: 15 },
  { shape: 'circle', kind: 'palm', x: -28.5, z: 16, r: 0.7, seed: 8 },
];
const obstacles = withMirrors(half);

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: -1.4, z: -6.5, r: 1.6, channel: true },
  { x: -1.0, z: -19.5, r: 1.6, channel: true },
  { x: -12.5, z: 5, r: 1.6, channel: false },
  { x: -19.5, z: -9, r: 1.5, channel: false },
  { x: -11.5, z: -21, r: 1.4, channel: false },
]);

const partial: Pick<MapDef, 'w' | 'd' | 'river' | 'islands'> = { w: W, d: D, river, islands };
const plazas = fountains.map((f) => ({ x: f.x, z: f.z, r: f.r + 0.6 }));
const onGround = (x: number, z: number) =>
  channelDepthAt(partial, x, z) < -1.2 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 1 && Math.abs(z) < D / 2 - 0.6 && !inCircles(plazas, x, z);
const beach = (x: number, z: number) => { const c = channelDepthAt(partial, x, z); return c > -3.6 && c < 0.2 && clearOf(obstacles, x, z, 0.5); };
const inWater = (x: number, z: number) => channelDepthAt(partial, x, z) > 1 && Math.hypot(x, z) > 4.6;
const wf = riverAt(points, -D / 2);

const decor: Decor[] = [
  ...scatter(partial, { kind: 'grass', count: 160, seed: 31, scale: [0.6, 1.15], accept: (x, z) => onGround(x, z) && Math.abs(x) > 13 }),
  ...scatter(partial, { kind: 'flower', count: 40, seed: 35, scale: [0.6, 1.1], accept: (x, z) => onGround(x, z) && Math.abs(x) > 14 }),
  ...scatter(partial, { kind: 'fern', count: 30, seed: 36, scale: [0.7, 1.2], accept: (x, z) => onGround(x, z) && Math.abs(x) > 19 }),
  ...scatter(partial, { kind: 'shell', count: 60, seed: 32, scale: [0.6, 1.2], accept: beach }),
  ...scatter(partial, { kind: 'starfish', count: 34, seed: 33, scale: [0.6, 1.2], accept: (x, z) => { const c = channelDepthAt(partial, x, z); return c > -2 && c < 2.2; } }),
  ...scatter(partial, { kind: 'seaweed', count: 54, seed: 34, scale: [0.7, 1.35], accept: inWater }),
  ...scatter(partial, { kind: 'pebbles', count: 30, seed: 37, scale: [0.6, 1.1], accept: beach }),
  { kind: 'waterfall', x: wf.x, z: -D / 2, rot: 0, scale: 1, seed: 1 },
  { kind: 'lantern', x: -9.2, z: -4.5, rot: 0, scale: 1, seed: 2 },
  { kind: 'lantern', x: 9.2, z: 4.5, rot: 0, scale: 1, seed: 3 },
  { kind: 'lantern', x: -25.2, z: 6.8, rot: 0, scale: 1.1, seed: 4 },
  { kind: 'lantern', x: 25.2, z: -6.8, rot: Math.PI, scale: 1.1, seed: 5 },
  { kind: 'rope', x: -8.9, z: -15.4, rot: 0.8, scale: 1, seed: 6 },
  { kind: 'rope', x: 8.9, z: 15.4, rot: 3.9, scale: 1, seed: 7 },
  { kind: 'sign', x: -24.8, z: -6.9, rot: Math.PI / 2, scale: 1, seed: 8 },
  { kind: 'sign', x: 24.8, z: 6.9, rot: -Math.PI / 2, scale: 1, seed: 9 },
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
  fountains,
  obstacles,
  movers: [
    { kind: 'raft', r: 1.1, len: 1.6, lane: 0.35, speed: 1.1, offset: 0, seed: 1 },
    { kind: 'raft', r: 1.0, len: 1.4, lane: -0.35, speed: 1.1, offset: 30, seed: 2 },
  ],
  whirlpool: { x: 0, z: 0, r: 4.2, strength: 2.4 },
  runeSpots: withMirroredPoints([{ x: 0, z: 0 }, { x: -islandX, z: -13 }]),
  hazardSlots,
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
    fogDensity: 0.007,
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
    grass: [0x7fb04a, 0x8cbc52, 0x6fa040, 0x78a845, 0x93c25a, 0x689a3c],
    dirt: [0xe8d6a6, 0xdcc894, 0xf0e0b4, 0xe2cf9d],
    bank: [0xeedcae, 0xe4d09c, 0xf6e8c2, 0xe9d5a4, 0xf1e2b8],
    bed: [0xd8c79a, 0xc9b788, 0xe2d3a8, 0xcfbe90],
    dryBed: [0xe9dbb3, 0xdccca0, 0xf2e6c4, 0xcfbf92, 0xe3d4aa],
    cliff: [0x9a8a6a, 0x8a7a5c, 0xaa9a78, 0xb5a37f, 0x7f7055],
    baseHeight: 1.1,
    noiseAmp: 0.13,
    noiseScale: 0.14,
    border: 'jungle',
  },
};
