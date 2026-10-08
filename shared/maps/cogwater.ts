// Cogwater Canal: a rainy night harbour. Barges drift through. Tidal mode = lock gates flood the canal.
// Layout is point symmetric: the canal and every gameplay element mirror through (0, 0).
import { channelDepthAt, clearOf, inCircles, scatter, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle, RiverPoint } from './types.ts';

const W = 72;
const D = 48;

// Straight engineered canal with stone quay walls.
const points: RiverPoint[] = [];
for (let z = -D / 2 - 4; z <= D / 2 + 4; z += 4) points.push({ z, x: 0, hw: 4.8 });
const river = { points, depth: 2.8, bank: 0.6, flow: 0.4 };
const islands: MapDef['islands'] = [];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const half: Obstacle[] = [
  // quay-side cover
  { shape: 'circle', kind: 'bollard', x: -6.5, z: -10, r: 0.4, seed: 1 },
  { shape: 'circle', kind: 'bollard', x: -6.5, z: 10, r: 0.4, seed: 2 },
  { shape: 'circle', kind: 'lamppost', x: -6.8, z: -2, r: 0.3, seed: 5 },
  { shape: 'circle', kind: 'crate', x: -8.6, z: 4, r: 0.9, seed: 3 },
  { shape: 'circle', kind: 'barrel', x: -9.7, z: 5.6, r: 0.55, seed: 4 },
  { shape: 'circle', kind: 'crate', x: -8.4, z: -16, r: 1.0, seed: 6 },
  // midfield
  { shape: 'circle', kind: 'crate', x: -14, z: -8, r: 1.0, seed: 10 },
  { shape: 'circle', kind: 'pipe', x: -18, z: 12, r: 0.8, seed: 7 },
  { shape: 'circle', kind: 'barrel', x: -13, z: 14.5, r: 0.55, seed: 11 },
  { shape: 'circle', kind: 'lamppost', x: -16, z: 1, r: 0.3, seed: 12 },
  { shape: 'wall', kind: 'wall_brick', ax: -14, az: 16.5, bx: -14, bz: 20.5, r: 0.45, h: 2, seed: 8 },
  { shape: 'wall', kind: 'wall_brick', ax: -22, az: -6, bx: -22, bz: -1.5, r: 0.45, h: 2, seed: 9 },
  // backfield
  { shape: 'circle', kind: 'crate', x: -24, z: 9, r: 1.0, seed: 13 },
  { shape: 'circle', kind: 'barrel', x: -25, z: -11, r: 0.55, seed: 14 },
  { shape: 'circle', kind: 'pipe', x: -27, z: -18, r: 0.8, seed: 15 },
  { shape: 'circle', kind: 'lamppost', x: -26.4, z: 14.6, r: 0.3, seed: 16 },
];
const obstacles = withMirrors(half);

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: -1.5, z: -7, r: 1.6, channel: true },
  { x: -1.2, z: -18, r: 1.6, channel: true },
  { x: -12.5, z: -2.5, r: 1.5, channel: false },
  { x: -19, z: 5, r: 1.4, channel: false },
  { x: -18.5, z: -16.5, r: 1.4, channel: false },
]);

const partial: Pick<MapDef, 'w' | 'd' | 'river' | 'islands'> = { w: W, d: D, river, islands };
const plazas = fountains.map((f) => ({ x: f.x, z: f.z, r: f.r + 0.6 }));
const onGround = (x: number, z: number) =>
  channelDepthAt(partial, x, z) < -1 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 1 && Math.abs(z) < D / 2 - 0.6 && !inCircles(plazas, x, z);

const decor: Decor[] = [
  ...scatter(partial, { kind: 'gear', count: 20, seed: 41, scale: [0.6, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'rope', count: 16, seed: 42, scale: [0.8, 1.2], accept: (x, z) => { const c = channelDepthAt(partial, x, z); return c > -2 && c < -0.5 && clearOf(obstacles, x, z, 0.4); } }),
  ...scatter(partial, { kind: 'pebbles', count: 32, seed: 43, scale: [0.6, 1.1], accept: onGround }),
  ...scatter(partial, { kind: 'grass', count: 40, seed: 44, scale: [0.5, 0.9], accept: (x, z) => onGround(x, z) && !clearOf(obstacles, x, z, 1.8) }),
  ...scatter(partial, { kind: 'bones', count: 4, seed: 45, scale: [0.7, 1], accept: (x, z) => onGround(x, z) && Math.abs(x) < 12 }),
  { kind: 'lockgate', x: 0, z: -D / 2 + 1, rot: 0, scale: 1, seed: 1 },
  { kind: 'lockgate', x: 0, z: D / 2 - 1, rot: Math.PI, scale: 1, seed: 2 },
  { kind: 'lantern', x: -6.8, z: 0, rot: 0, scale: 1, seed: 3 },
  { kind: 'lantern', x: 6.8, z: 0, rot: 0, scale: 1, seed: 4 },
  { kind: 'lantern', x: -6.8, z: -19, rot: 0, scale: 1, seed: 5 },
  { kind: 'lantern', x: 6.8, z: 19, rot: 0, scale: 1, seed: 6 },
  { kind: 'lantern', x: -6.8, z: 15, rot: 0, scale: 1, seed: 7 },
  { kind: 'lantern', x: 6.8, z: -15, rot: 0, scale: 1, seed: 8 },
  { kind: 'sign', x: -24.8, z: -6.9, rot: Math.PI / 2, scale: 1, seed: 9 },
  { kind: 'sign', x: 24.8, z: 6.9, rot: -Math.PI / 2, scale: 1, seed: 10 },
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
  fountains,
  obstacles,
  movers: [
    { kind: 'barge', r: 1.2, len: 5, lane: -0.4, speed: 1.4, offset: -8, seed: 1 },
    { kind: 'barge', r: 1.15, len: 4.4, lane: 0.4, speed: -1.4, offset: 8, seed: 2 },
  ],
  runeSpots: withMirroredPoints([{ x: 0, z: 0 }, { x: -1.5, z: -13 }]),
  hazardSlots,
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
    fogDensity: 0.016,
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
    grass: [0x6a5e57, 0x62564f, 0x72665f, 0x5a4f49, 0x675b54, 0x786a60],
    dirt: [0x6e3b2c, 0x7a4332, 0x623426, 0x713e2e],
    bank: [0x5d5d62, 0x52525a, 0x68686e, 0x606066],
    bed: [0x2c2c30, 0x34343a, 0x26262a, 0x303034],
    dryBed: [0x45403c, 0x3c3834, 0x504a44, 0x48423d, 0x3a3532],
    cliff: [0x6e3b2c, 0x7a4332, 0x5c3124, 0x83492f],
    baseHeight: 1.4,
    noiseAmp: 0.04,
    noiseScale: 0.2,
    border: 'wall',
  },
};
