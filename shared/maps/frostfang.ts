// Frostfang Fjord: icy river with drifting floes. Tidal mode = freeze/thaw cycle.
import { channelDepthAt, clearOf, curvyRiver, scatter, withMirrors } from './helpers.ts';
import type { Decor, MapDef, Obstacle } from './types.ts';

const W = 72;
const D = 48;

const river = { points: curvyRiver(D, { amp: 2.2, freq: 0.09, phase: 1.3, hw: 5.2, hwVar: 0.6 }), depth: 2.6, bank: 2, flow: 0.9 };
const islands: MapDef['islands'] = [];

const half: Obstacle[] = [
  { shape: 'circle', kind: 'pine', x: -12, z: -8, r: 0.85, seed: 1 },
  { shape: 'circle', kind: 'pine', x: -15, z: 12, r: 0.85, seed: 2 },
  { shape: 'circle', kind: 'icerock', x: -9.8, z: 4, r: 1.2, seed: 3 },
  { shape: 'circle', kind: 'icepillar', x: -18, z: -1, r: 0.8, seed: 4 },
  { shape: 'circle', kind: 'runestone', x: -21, z: 16, r: 0.7, seed: 5 },
  { shape: 'circle', kind: 'icerock', x: -23, z: -15, r: 1.5, seed: 6 },
  { shape: 'circle', kind: 'pine', x: -27, z: 8, r: 0.85, seed: 7 },
  { shape: 'wall', kind: 'wall_ice', ax: -16, az: -18, bx: -10, bz: -19.5, r: 0.45, h: 1.6, seed: 8 },
];
const obstacles = withMirrors(half);

const partial: Pick<MapDef, 'w' | 'd' | 'river' | 'islands'> = { w: W, d: D, river, islands };
const onGround = (x: number, z: number) => channelDepthAt(partial, x, z) < -1.2 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 2;

const decor: Decor[] = [
  ...scatter(partial, { kind: 'snowtuft', count: 220, seed: 21, scale: [0.7, 1.4], accept: onGround }),
  ...scatter(partial, { kind: 'pebbles', count: 60, seed: 22, scale: [0.6, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'icicle', count: 30, seed: 23, scale: [0.6, 1.2], accept: (x, z) => { const c = channelDepthAt(partial, x, z); return c > -2 && c < -0.6; } }),
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
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }],
  ],
  fountains: [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }],
  obstacles,
  movers: [
    { kind: 'icefloe', r: 1.3, len: 0, lane: -0.4, speed: 1.6, offset: -12, seed: 1 },
    { kind: 'icefloe', r: 1.0, len: 0, lane: 0.45, speed: 1.9, offset: 4, seed: 2 },
    { kind: 'icefloe', r: 1.6, len: 0, lane: 0.05, speed: 1.3, offset: 18, seed: 3 },
  ],
  runeSpots: [{ x: 0, z: -2 }, { x: 0.5, z: -15 }, { x: -0.5, z: 14 }],
  hazardSlots: [
    { x: 1.5, z: -8, r: 1.8, channel: true },
    { x: -1.5, z: 8, r: 1.8, channel: true },
    { x: 0, z: 19, r: 1.6, channel: true },
    { x: 0, z: -19, r: 1.6, channel: true },
    { x: -14, z: -3, r: 1.6, channel: false },
    { x: 14, z: 3, r: 1.6, channel: false },
  ],
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
    grass: [0xe8eef5, 0xdfe7f0, 0xf3f6fa, 0xd5dfea],
    dirt: [0x6c7686, 0x5d6676, 0x7a8494],
    bank: [0x9aaabd, 0x8797ab, 0xaebdcd],
    bed: [0x46596c, 0x3a4b5d, 0x52667a],
    dryBed: [0x8d9aa8, 0x7d8a99, 0x9eabb8],
    cliff: [0x8fa3b8, 0x7d91a6, 0xa5b7ca],
    baseHeight: 1.3,
    noiseAmp: 0.2,
    noiseScale: 0.1,
    border: 'ice',
  },
};
