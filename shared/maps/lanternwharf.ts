// Lantern Wharf: a rainy canal city at night (reference: the lantern-lit harbour with stone bridges,
// cranes and barges). Two stone bridges cross the canal even in Deep Water: hold them or hook
// whoever tries. Tidal mode: the lock gates flood and drain the canal. Point symmetric through (0, 0).
import { channelDepthAt, clearOf, scatter, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle, Platform, RiverDef, RiverPoint } from './types.ts';

const W = 72;
const D = 48;

const points: RiverPoint[] = [];
for (let z = -D / 2 - 4; z <= D / 2 + 4; z += 4) points.push({ z, x: 0, hw: 4.6 });
const river: RiverDef = { points, depth: 2.9, bank: 0.5, flow: 0.35 };
const islands: MapDef['islands'] = [];
const platforms: Platform[] = [
  // stone bridges spanning the whole canal
  { kind: 'bridge', x: 0, z: -10, w: 12.4, d: 3.2, rot: 0, seed: 1 },
  { kind: 'bridge', x: 0, z: 10, w: 12.4, d: 3.2, rot: 0, seed: 2 },
];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const half: Obstacle[] = [
  { shape: 'circle', kind: 'crane', x: -7.4, z: 2.6, r: 1.1, seed: 1 },
  { shape: 'circle', kind: 'gaslamp', x: -5.6, z: -4, r: 0.3, seed: 2 },
  { shape: 'circle', kind: 'bollard', x: -5.4, z: 6, r: 0.4, seed: 3 },
  { shape: 'circle', kind: 'cratepile', x: -9.6, z: -6.5, r: 1.0, seed: 4 },
  { shape: 'circle', kind: 'barrel', x: -8.8, z: 14.5, r: 0.55, seed: 5 },
  { shape: 'circle', kind: 'gaslamp', x: -6.2, z: -12.2, r: 0.3, seed: 6 },
  { shape: 'circle', kind: 'bridgepier', x: -4.0, z: 10, r: 0.6, seed: 7 },
  { shape: 'circle', kind: 'crate', x: -15, z: 4, r: 0.9, seed: 8 },
  { shape: 'circle', kind: 'crane', x: -18, z: -15, r: 1.1, seed: 9 },
  { shape: 'wall', kind: 'warehouse', ax: -24, az: 9, bx: -24, bz: 16, r: 0.6, h: 4, seed: 10 },
  { shape: 'wall', kind: 'wall_brick', ax: -14, az: -18, bx: -10, bz: -18, r: 0.45, h: 1.8, seed: 11 },
];
const obstacles = withMirrors(half);

const partial = { w: W, d: D, river, platforms, islands };
const depth = (x: number, z: number) => channelDepthAt(partial, x, z);
const onGround = (x: number, z: number) => depth(x, z) < -1.0 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 2;

const decor: Decor[] = [
  ...scatter(partial, { kind: 'pebbles', count: 40, seed: 81, scale: [0.6, 1.1], accept: onGround }),
  ...scatter(partial, { kind: 'gear', count: 14, seed: 82, scale: [0.6, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'rope', count: 14, seed: 83, scale: [0.8, 1.2], accept: (x, z) => { const c = depth(x, z); return c > -1.6 && c < -0.4; } }),
  ...scatter(partial, { kind: 'chainhang', count: 8, seed: 84, scale: [0.8, 1.2], accept: (x, z) => { const c = depth(x, z); return c > -1.2 && c < -0.5; } }),
  { kind: 'lockgate', x: 0, z: -D / 2 + 1, rot: 0, scale: 1, seed: 1 },
  { kind: 'lockgate', x: 0, z: D / 2 - 1, rot: Math.PI, scale: 1, seed: 2 },
  { kind: 'lanternstring', x: 0, z: -10, rot: Math.PI / 2, scale: 1, seed: 3 },
  { kind: 'lanternstring', x: 0, z: 10, rot: Math.PI / 2, scale: 1, seed: 4 },
  { kind: 'cargonet', x: -7.4, z: 4.2, rot: 0, scale: 1, seed: 5 },
  { kind: 'cargonet', x: 7.4, z: -4.2, rot: Math.PI, scale: 1, seed: 6 },
];

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: 2, z: -4, r: 1.5, channel: true },
  { x: -1.6, z: 17, r: 1.5, channel: true },
  { x: 0, z: -10, r: 1.2, channel: false }, // on the bridge itself
  { x: -12, z: -1, r: 1.4, channel: false },
  { x: -19, z: 8, r: 1.4, channel: false },
]);

export const lanternwharf: MapDef = {
  id: 'lanternwharf',
  name: 'Lantern Wharf',
  blurb: 'A rainy canal city lit by lanterns. Two stone bridges cross the canal even in Deep Water: hold them, or hook whoever tries. On Tidal, the lock gates flood the canal.',
  w: W,
  d: D,
  river,
  platforms,
  islands,
  tide: { style: 'locks', lowSec: 26, risingSec: 7, highSec: 30, fallingSec: 7 },
  special: 'steamvent',
  spawns: [
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }],
  ],
  fountains,
  obstacles,
  movers: [
    { kind: 'barge', r: 1.1, len: 4.6, lane: -0.4, speed: 1.3, offset: -4, seed: 1 },
    { kind: 'barge', r: 1.0, len: 3.6, lane: 0.42, speed: -1.1, offset: 12, seed: 2 },
  ],
  runeSpots: [{ x: 0, z: 0 }, { x: 0, z: -17 }, { x: 0, z: 17 }],
  hazardSlots,
  decor,
  atmosphere: {
    timeOfDay: 'night',
    sunDir: [0.35, 0.55, -0.6],
    sunColor: 0xa8b8ff,
    sunIntensity: 1.25,
    skyTop: 0x0b0e1c,
    skyHorizon: 0x3a3050,
    groundAmbient: 0x2c2420,
    ambientIntensity: 0.85,
    fogColor: 0x2c2c3c,
    fogDensity: 0.016,
    weather: 'rain',
    aurora: false,
    waterShallow: 0x3a5462,
    waterDeep: 0x0a1418,
    waterFoam: 0xc0ccd0,
    exposure: 1.12,
    saturation: 0.95,
    bloom: 0.9,
  },
  terrain: {
    grass: [0x5c5048, 0x544842, 0x645852, 0x4c423c],
    dirt: [0x6e3c2c, 0x7a4432, 0x623628],
    bank: [0x5e5e64, 0x54545c, 0x6a6a70],
    bed: [0x2c2c30, 0x34343a, 0x26262a],
    dryBed: [0x46413c, 0x3d3934, 0x514b44],
    cliff: [0x6e3c2c, 0x7a4432, 0x5c3226],
    baseHeight: 1.45,
    noiseAmp: 0.04,
    noiseScale: 0.2,
    border: 'wall',
  },
};
