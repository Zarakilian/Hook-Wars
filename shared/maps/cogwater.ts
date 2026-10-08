// Cogwater Canal: a rainy night harbour. Barges drift through. Tidal mode = lock gates flood the canal.
import { channelDepthAt, clearOf, scatter, withMirrors } from './helpers.ts';
import type { Decor, MapDef, Obstacle, RiverPoint } from './types.ts';

const W = 72;
const D = 48;

// Straight engineered canal.
const points: RiverPoint[] = [];
for (let z = -D / 2 - 4; z <= D / 2 + 4; z += 4) points.push({ z, x: 0, hw: 4.8 });
const river = { points, depth: 2.8, bank: 0.6, flow: 0.4 };
const islands: MapDef['islands'] = [];

const half: Obstacle[] = [
  { shape: 'circle', kind: 'bollard', x: -6.6, z: -10, r: 0.4, seed: 1 },
  { shape: 'circle', kind: 'bollard', x: -6.6, z: 10, r: 0.4, seed: 2 },
  { shape: 'circle', kind: 'crate', x: -10, z: 3, r: 0.9, seed: 3 },
  { shape: 'circle', kind: 'barrel', x: -11.2, z: 4.6, r: 0.55, seed: 4 },
  { shape: 'circle', kind: 'lamppost', x: -7.4, z: -2, r: 0.3, seed: 5 },
  { shape: 'circle', kind: 'crate', x: -16, z: -12, r: 1, seed: 6 },
  { shape: 'circle', kind: 'pipe', x: -20, z: 12, r: 0.8, seed: 7 },
  { shape: 'wall', kind: 'wall_brick', ax: -14, az: 16, bx: -14, bz: 20, r: 0.45, h: 2, seed: 8 },
  { shape: 'wall', kind: 'wall_brick', ax: -24, az: -6, bx: -24, bz: -1, r: 0.45, h: 2, seed: 9 },
];
const obstacles = withMirrors(half);

const partial: Pick<MapDef, 'w' | 'd' | 'river' | 'islands'> = { w: W, d: D, river, islands };
const onGround = (x: number, z: number) => channelDepthAt(partial, x, z) < -1 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 2;

const decor: Decor[] = [
  ...scatter(partial, { kind: 'gear', count: 18, seed: 41, scale: [0.6, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'rope', count: 14, seed: 42, scale: [0.8, 1.2], accept: (x, z) => { const c = channelDepthAt(partial, x, z); return c > -2 && c < -0.5; } }),
  ...scatter(partial, { kind: 'pebbles', count: 40, seed: 43, scale: [0.6, 1.1], accept: onGround }),
  { kind: 'lockgate', x: 0, z: -D / 2 + 1, rot: 0, scale: 1, seed: 1 },
  { kind: 'lockgate', x: 0, z: D / 2 - 1, rot: Math.PI, scale: 1, seed: 2 },
  { kind: 'lantern', x: -6.8, z: 0, rot: 0, scale: 1, seed: 3 },
  { kind: 'lantern', x: 6.8, z: 0, rot: 0, scale: 1, seed: 4 },
];

export const cogwater: MapDef = {
  id: 'cogwater',
  name: 'Cogwater Canal',
  blurb: 'A rainy night harbour of brick and brass. Barges drift past. On Tidal, the lock gates open and flood the canal.',
  w: W,
  d: D,
  river,
  islands,
  tide: { style: 'locks', lowSec: 28, risingSec: 7, highSec: 30, fallingSec: 7 },
  special: 'steamvent',
  spawns: [
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }],
  ],
  fountains: [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }],
  obstacles,
  movers: [
    { kind: 'barge', r: 1.2, len: 5, lane: -0.35, speed: 1.5, offset: -8, seed: 1 },
    { kind: 'barge', r: 1.0, len: 3.6, lane: 0.4, speed: -1.2, offset: 10, seed: 2 },
  ],
  runeSpots: [{ x: 0, z: 0 }, { x: 0, z: -14 }, { x: 0, z: 14 }],
  hazardSlots: [
    { x: 2, z: -7, r: 1.6, channel: true },
    { x: -2, z: 7, r: 1.6, channel: true },
    { x: 0, z: 18, r: 1.6, channel: true },
    { x: 0, z: -18, r: 1.6, channel: true },
    { x: -13, z: -5, r: 1.5, channel: false },
    { x: 13, z: 5, r: 1.5, channel: false },
  ],
  decor,
  atmosphere: {
    timeOfDay: 'night',
    sunDir: [-0.3, 0.6, 0.5],
    sunColor: 0x9fb4ff,
    sunIntensity: 1.2,
    skyTop: 0x0a0d18,
    skyHorizon: 0x2d2a3e,
    groundAmbient: 0x2a2420,
    ambientIntensity: 0.8,
    fogColor: 0x2c2f3c,
    fogDensity: 0.018,
    weather: 'rain',
    aurora: false,
    waterShallow: 0x3c5560,
    waterDeep: 0x0b1418,
    waterFoam: 0xb8c4c8,
    exposure: 1.1,
    saturation: 0.9,
    bloom: 0.8,
  },
  terrain: {
    grass: [0x5a4e48, 0x524640, 0x625650, 0x4a403b],
    dirt: [0x6e3b2c, 0x7a4332, 0x623426],
    bank: [0x5d5d62, 0x52525a, 0x68686e],
    bed: [0x2c2c30, 0x34343a, 0x26262a],
    dryBed: [0x45403c, 0x3c3834, 0x504a44],
    cliff: [0x6e3b2c, 0x7a4332, 0x5c3124],
    baseHeight: 1.4,
    noiseAmp: 0.05,
    noiseScale: 0.2,
    border: 'wall',
  },
};
