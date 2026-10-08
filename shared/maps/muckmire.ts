// Muckmire Bayou: the classic straight-ish river at dusk. Cypress, moss, fireflies. No tide.
import { channelDepthAt, clearOf, curvyRiver, scatter, withMirrors } from './helpers.ts';
import type { Decor, MapDef, Obstacle } from './types.ts';

const W = 72;
const D = 48;

const river = { points: curvyRiver(D, { amp: 1.2, freq: 0.11, phase: 0.4, hw: 5, hwVar: 0.4 }), depth: 2.2, bank: 2.5, flow: 0.6 };
const islands = [{ x: 0, z: 0, r: 2.2 }];

const half: Obstacle[] = [
  { shape: 'circle', kind: 'cypress', x: -11, z: -9, r: 0.9, seed: 1 },
  { shape: 'circle', kind: 'cypress', x: -13, z: 11, r: 0.9, seed: 2 },
  { shape: 'circle', kind: 'mossrock', x: -9.5, z: 3, r: 1.1, seed: 3 },
  { shape: 'circle', kind: 'stump', x: -17, z: -2, r: 0.7, seed: 4 },
  { shape: 'circle', kind: 'deadtree', x: -20, z: 15, r: 0.8, seed: 5 },
  { shape: 'circle', kind: 'mossrock', x: -22, z: -14, r: 1.4, seed: 6 },
  { shape: 'circle', kind: 'cypress', x: -26, z: 6, r: 0.9, seed: 7 },
  { shape: 'wall', kind: 'wall_wood', ax: -15, az: -19, bx: -9, bz: -20, r: 0.35, h: 1.4, seed: 8 },
];
const obstacles = withMirrors(half);

const partial: Pick<MapDef, 'w' | 'd' | 'river' | 'islands'> = { w: W, d: D, river, islands };
const onGround = (x: number, z: number) => channelDepthAt(partial, x, z) < -1.2 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 2;
const inWater = (x: number, z: number) => channelDepthAt(partial, x, z) > 0.8;

const decor: Decor[] = [
  ...scatter(partial, { kind: 'grass', count: 260, seed: 11, scale: [0.7, 1.3], accept: onGround }),
  ...scatter(partial, { kind: 'reeds', count: 70, seed: 12, scale: [0.8, 1.4], accept: (x, z) => { const c = channelDepthAt(partial, x, z); return c > -2.5 && c < 0.6; } }),
  ...scatter(partial, { kind: 'lilypad', count: 40, seed: 13, scale: [0.7, 1.3], accept: inWater }),
  ...scatter(partial, { kind: 'mushroom', count: 30, seed: 14, scale: [0.6, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'fern', count: 40, seed: 15, scale: [0.7, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'firefly_swarm', count: 10, seed: 16, scale: [1, 1], accept: (x, z) => Math.abs(x) < 18 && clearOf(obstacles, x, z, 0.5) }),
  { kind: 'lantern', x: -7.8, z: -6, rot: 0, scale: 1, seed: 1 },
  { kind: 'lantern', x: 7.8, z: 6, rot: 0, scale: 1, seed: 2 },
];

export const muckmire: MapDef = {
  id: 'muckmire',
  name: 'Muckmire Bayou',
  blurb: 'The classic. A lazy bayou river at dusk, cypress cover and a mud island in the middle.',
  w: W,
  d: D,
  river,
  islands,
  special: 'quicksand',
  spawns: [
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }],
  ],
  fountains: [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }],
  obstacles,
  movers: [
    { kind: 'log', r: 0.55, len: 3.2, lane: -0.45, speed: 1.4, offset: -10, seed: 1 },
    { kind: 'log', r: 0.55, len: 2.6, lane: 0.5, speed: 1.1, offset: 14, seed: 2 },
  ],
  runeSpots: [{ x: 0, z: 0 }, { x: 0.6, z: -15 }, { x: -0.6, z: 15 }],
  hazardSlots: [
    { x: 1.5, z: -9, r: 1.8, channel: true },
    { x: -1.5, z: 9, r: 1.8, channel: true },
    { x: 2, z: 19, r: 1.6, channel: true },
    { x: -2, z: -19, r: 1.6, channel: true },
    { x: -14, z: -4, r: 1.6, channel: false },
    { x: 14, z: 4, r: 1.6, channel: false },
  ],
  decor,
  atmosphere: {
    timeOfDay: 'dusk',
    sunDir: [-0.55, 0.32, 0.35],
    sunColor: 0xffb27a,
    sunIntensity: 2.6,
    skyTop: 0x283a6b,
    skyHorizon: 0xf3a46e,
    groundAmbient: 0x3b3326,
    ambientIntensity: 0.9,
    fogColor: 0x8a7a86,
    fogDensity: 0.011,
    weather: 'fireflies',
    aurora: false,
    waterShallow: 0x6f8a52,
    waterDeep: 0x1b3226,
    waterFoam: 0xe2e6cf,
    exposure: 1,
    saturation: 1.08,
    bloom: 0.55,
  },
  terrain: {
    grass: [0x4f6b2c, 0x5a7631, 0x46622a, 0x617d36, 0x3f5a26],
    dirt: [0x5b4630, 0x4f3d2a, 0x665036],
    bank: [0x4a3d2b, 0x55462f, 0x3f3424],
    bed: [0x3a3424, 0x2f2b1f, 0x443b29],
    dryBed: [0x6b5a42, 0x5e4f3a, 0x77654a, 0x54463a],
    cliff: [0x4a4a3e, 0x55554a, 0x3e3f35],
    baseHeight: 1.2,
    noiseAmp: 0.18,
    noiseScale: 0.12,
    border: 'jungle',
  },
};
