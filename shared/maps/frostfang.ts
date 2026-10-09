// Frostfang Fjord: icy glacier river with drifting floes. Tidal mode = freeze/thaw cycle.
// Layout is point symmetric: the river and every gameplay element mirror through (0, 0).
import { channelDepthAt, clearOf, inCircles, scatter, symmetricRiver, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle } from './types.ts';

const W = 72;
const D = 48;

const river = { points: symmetricRiver(D, { amp: 2.0, freq: 0.1, amp3: 0.3, hw: 5.2, hwVar: 0.35, hwFreq: 0.17 }), depth: 2.6, bank: 2, flow: 0.9 };
const islands: MapDef['islands'] = [];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const half: Obstacle[] = [
  // bank cover
  { shape: 'circle', kind: 'icerock', x: -7.6, z: 4, r: 1.2, seed: 3 },
  { shape: 'circle', kind: 'icepillar', x: -9.6, z: -8, r: 0.7, seed: 4 },
  { shape: 'circle', kind: 'pine', x: -6.2, z: 12.5, r: 0.85, seed: 1 },
  { shape: 'circle', kind: 'runestone', x: -9.5, z: -17, r: 0.7, seed: 5 },
  // midfield
  { shape: 'circle', kind: 'pine', x: -13, z: -4, r: 0.85, seed: 2 },
  { shape: 'circle', kind: 'pine', x: -15, z: 9, r: 0.85, seed: 7 },
  { shape: 'circle', kind: 'icerock', x: -18.5, z: -12, r: 1.4, seed: 6 },
  { shape: 'circle', kind: 'icepillar', x: -19, z: 2, r: 0.8, seed: 9 },
  { shape: 'circle', kind: 'runestone', x: -17, z: 18, r: 0.7, seed: 10 },
  { shape: 'wall', kind: 'wall_ice', ax: -12, az: 20, bx: -7.5, bz: 21.5, r: 0.45, h: 1.6, seed: 8 },
  // backfield
  { shape: 'circle', kind: 'pine', x: -24, z: -8.5, r: 0.85, seed: 11 },
  { shape: 'circle', kind: 'pine', x: -23.5, z: 12, r: 0.85, seed: 12 },
  { shape: 'circle', kind: 'icerock', x: -27.5, z: -18.5, r: 1.5, seed: 13 },
  { shape: 'circle', kind: 'pine', x: -29.5, z: 18, r: 0.85, seed: 14 },
];
const obstacles = withMirrors(half);

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: -1.2, z: -9, r: 1.8, channel: true },
  { x: -1.2, z: -20, r: 1.6, channel: true },
  { x: -13.5, z: 4, r: 1.6, channel: false },
  { x: -21, z: -4, r: 1.5, channel: false },
  { x: -12.5, z: 15.5, r: 1.4, channel: false },
]);

const partial: Pick<MapDef, 'w' | 'd' | 'river' | 'islands'> = { w: W, d: D, river, islands };
const plazas = fountains.map((f) => ({ x: f.x, z: f.z, r: f.r + 0.6 }));
const onGround = (x: number, z: number) =>
  channelDepthAt(partial, x, z) < -1.2 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 1 && Math.abs(z) < D / 2 - 0.6 && !inCircles(plazas, x, z);

const decor: Decor[] = [
  ...scatter(partial, { kind: 'snowtuft', count: 230, seed: 21, scale: [0.7, 1.45], accept: onGround }),
  ...scatter(partial, { kind: 'grass', count: 50, seed: 25, scale: [0.6, 1.0], accept: (x, z) => onGround(x, z) && !clearOf(obstacles, x, z, 2.5) }),
  ...scatter(partial, { kind: 'pebbles', count: 54, seed: 22, scale: [0.6, 1.25], accept: onGround }),
  ...scatter(partial, { kind: 'icicle', count: 36, seed: 23, scale: [0.6, 1.25], accept: (x, z) => { const c = channelDepthAt(partial, x, z); return c > -1.9 && c < -0.5 && clearOf(obstacles, x, z, 0.4); } }),
  ...scatter(partial, { kind: 'bones', count: 6, seed: 24, scale: [0.8, 1.2], accept: (x, z) => onGround(x, z) && Math.abs(x) > 12 }),
  { kind: 'lantern', x: -8.2, z: -2.5, rot: 0, scale: 1, seed: 1 },
  { kind: 'lantern', x: 8.2, z: 2.5, rot: 0, scale: 1, seed: 2 },
  { kind: 'lantern', x: -10.5, z: 17.6, rot: 0.3, scale: 1, seed: 3 },
  { kind: 'lantern', x: 10.5, z: -17.6, rot: 3.4, scale: 1, seed: 4 },
  { kind: 'lantern', x: -25.2, z: 6.8, rot: 0, scale: 1.1, seed: 5 },
  { kind: 'lantern', x: 25.2, z: -6.8, rot: Math.PI, scale: 1.1, seed: 6 },
  { kind: 'sign', x: -24.8, z: -6.9, rot: Math.PI / 2, scale: 1, seed: 7 },
  { kind: 'sign', x: 24.8, z: 6.9, rot: -Math.PI / 2, scale: 1, seed: 8 },
];

export const frostfang: MapDef = {
  id: 'frostfang',
  name: 'Frostfang Fjord',
  blurb: 'A glacier river under the aurora. Ice floes drift through your shots. On Tidal, the river freezes solid, then cracks.',
  w: W,
  d: D,
  river,
  islands,
  tide: { style: 'freeze', lowSec: 26, risingSec: 6, highSec: 34, fallingSec: 6 },
  special: 'icespikes',
  spawns: [
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }, { x: -27, z: 0 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }, { x: 27, z: 0 }],
  ],
  fountains,
  obstacles,
  movers: [
    { kind: 'icefloe', r: 1.3, len: 0, lane: -0.45, speed: 1.5, offset: -12, seed: 1 },
    { kind: 'icefloe', r: 1.1, len: 0, lane: 0.45, speed: 1.5, offset: 6, seed: 2 },
    { kind: 'icefloe', r: 1.5, len: 0, lane: 0, speed: 1.2, offset: 20, seed: 3 },
  ],
  runeSpots: withMirroredPoints([{ x: 0, z: 0 }, { x: -1.8, z: -14 }]),
  hazardSlots,
  decor,
  atmosphere: {
    timeOfDay: 'night',
    sunDir: [0.4, 0.55, -0.4],
    sunColor: 0xbcd4ff,
    sunIntensity: 1.6,
    skyTop: 0x0b1530,
    skyHorizon: 0x3b5e8c,
    groundAmbient: 0x2a3550,
    ambientIntensity: 1.1,
    fogColor: 0x6d86a8,
    fogDensity: 0.012,
    weather: 'snow',
    aurora: true,
    waterShallow: 0x5fa0b8,
    waterDeep: 0x0e2c44,
    waterFoam: 0xf2f8ff,
    exposure: 1.05,
    saturation: 0.95,
    bloom: 0.6,
  },
  terrain: {
    grass: [0xe8eef5, 0xdfe7f0, 0xf3f6fa, 0xd5dfea, 0xeaf1f8, 0xdbe4ee],
    dirt: [0x6c7686, 0x5d6676, 0x7a8494, 0x667080],
    bank: [0x9aaabd, 0x8797ab, 0xaebdcd, 0xa2b3c6],
    bed: [0x46596c, 0x3a4b5d, 0x52667a, 0x40536a],
    dryBed: [0x8d9aa8, 0x7d8a99, 0x9eabb8, 0x737f8d, 0x8794a3],
    cliff: [0x8fa3b8, 0x7d91a6, 0xa5b7ca, 0x6f86a0],
    baseHeight: 1.3,
    noiseAmp: 0.16,
    noiseScale: 0.1,
    border: 'ice',
  },
};
