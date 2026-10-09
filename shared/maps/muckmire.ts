// Muckmire Bayou: the classic gently winding river at dusk. Cypress, moss, fireflies. No tide.
// Layout is point symmetric: the river and every gameplay element mirror through (0, 0).
import { channelDepthAt, clearOf, inCircles, scatter, symmetricRiver, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle } from './types.ts';

const W = 72;
const D = 48;

const river = { points: symmetricRiver(D, { amp: 1.4, freq: 0.12, amp3: 0.35, hw: 5.0, hwVar: 0.35, hwFreq: 0.19 }), depth: 2.2, bank: 2.5, flow: 0.6 };
const islands = [{ x: 0, z: 0, r: 2.2 }];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

// Team 0 half (west). withMirrors adds the east half.
const half: Obstacle[] = [
  // bank cover: hide behind these, hook through the gaps between them
  { shape: 'circle', kind: 'mossrock', x: -7.2, z: 3.5, r: 1.1, seed: 3 },
  { shape: 'circle', kind: 'stump', x: -8.2, z: -13, r: 0.7, seed: 4 },
  { shape: 'circle', kind: 'cypress', x: -6.6, z: 16, r: 0.9, seed: 1 },
  // midfield: grapple anchors and flanking cover
  { shape: 'circle', kind: 'cypress', x: -12, z: -6, r: 0.9, seed: 2 },
  { shape: 'circle', kind: 'cypress', x: -13.5, z: 9, r: 0.9, seed: 7 },
  { shape: 'circle', kind: 'deadtree', x: -16.5, z: -16, r: 0.8, seed: 5 },
  { shape: 'circle', kind: 'mossrock', x: -18.5, z: 1.5, r: 1.3, seed: 6 },
  { shape: 'circle', kind: 'stump', x: -15.5, z: 19.5, r: 0.7, seed: 9 },
  { shape: 'wall', kind: 'wall_wood', ax: -14, az: -21, bx: -9.5, bz: -22.2, r: 0.35, h: 1.3, seed: 8 },
  // backfield
  { shape: 'circle', kind: 'cypress', x: -23.5, z: -10, r: 0.9, seed: 10 },
  { shape: 'circle', kind: 'cypress', x: -24.5, z: 12.5, r: 0.9, seed: 11 },
  { shape: 'circle', kind: 'mossrock', x: -27, z: -18.5, r: 1.4, seed: 12 },
  { shape: 'circle', kind: 'deadtree', x: -29, z: 17.5, r: 0.8, seed: 13 },
  { shape: 'circle', kind: 'stump', x: -21, z: 6, r: 0.6, seed: 14 },
];
const obstacles = withMirrors(half);

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: -1.0, z: -9, r: 1.8, channel: true },
  { x: -1.5, z: -19, r: 1.6, channel: true },
  { x: -14, z: -2, r: 1.6, channel: false },
  { x: -20.5, z: 11, r: 1.5, channel: false },
  { x: -10.5, z: -18, r: 1.4, channel: false },
]);

const partial: Pick<MapDef, 'w' | 'd' | 'river' | 'islands'> = { w: W, d: D, river, islands };
const plazas = fountains.map((f) => ({ x: f.x, z: f.z, r: f.r + 0.6 }));
const onGround = (x: number, z: number) =>
  channelDepthAt(partial, x, z) < -1.2 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 1 && Math.abs(z) < D / 2 - 0.6 && !inCircles(plazas, x, z);
const bankEdge = (x: number, z: number) => {
  const c = channelDepthAt(partial, x, z);
  return c > -2.4 && c < -0.5 && clearOf(obstacles, x, z, 0.4);
};
const inWater = (x: number, z: number) => channelDepthAt(partial, x, z) > 0.8;

const decor: Decor[] = [
  ...scatter(partial, { kind: 'grass', count: 300, seed: 11, scale: [0.7, 1.35], accept: onGround }),
  ...scatter(partial, { kind: 'reeds', count: 90, seed: 12, scale: [0.8, 1.45], accept: (x, z) => { const c = channelDepthAt(partial, x, z); return c > -2.2 && c < 0.7 && clearOf(obstacles, x, z, 0.4); } }),
  ...scatter(partial, { kind: 'lilypad', count: 46, seed: 13, scale: [0.7, 1.35], accept: inWater }),
  ...scatter(partial, { kind: 'mushroom', count: 36, seed: 14, scale: [0.6, 1.25], accept: (x, z) => onGround(x, z) && !clearOf(obstacles, x, z, 2.2) }),
  ...scatter(partial, { kind: 'fern', count: 54, seed: 15, scale: [0.7, 1.25], accept: (x, z) => onGround(x, z) && Math.abs(x) > 9 }),
  ...scatter(partial, { kind: 'flower', count: 28, seed: 17, scale: [0.6, 1.1], accept: onGround }),
  ...scatter(partial, { kind: 'pebbles', count: 34, seed: 18, scale: [0.6, 1.1], accept: bankEdge }),
  ...scatter(partial, { kind: 'bones', count: 6, seed: 19, scale: [0.8, 1.1], accept: (x, z) => onGround(x, z) && Math.abs(x) > 12 }),
  ...scatter(partial, { kind: 'firefly_swarm', count: 12, seed: 16, scale: [1, 1], accept: (x, z) => Math.abs(x) < 20 && clearOf(obstacles, x, z, 0.5) }),
  { kind: 'lantern', x: -7.8, z: -6, rot: 0, scale: 1, seed: 1 },
  { kind: 'lantern', x: 7.8, z: 6, rot: 0, scale: 1, seed: 2 },
  { kind: 'lantern', x: -9.4, z: 12.2, rot: 0.6, scale: 1, seed: 3 },
  { kind: 'lantern', x: 9.4, z: -12.2, rot: 3.7, scale: 1, seed: 4 },
  { kind: 'lantern', x: -25.2, z: -6.8, rot: 0, scale: 1.1, seed: 5 },
  { kind: 'lantern', x: 25.2, z: 6.8, rot: Math.PI, scale: 1.1, seed: 6 },
  { kind: 'rope', x: -8.8, z: -12.2, rot: 0.4, scale: 1, seed: 7 },
  { kind: 'rope', x: 8.8, z: 12.2, rot: 3.5, scale: 1, seed: 8 },
  { kind: 'sign', x: -24.8, z: 6.9, rot: Math.PI / 2, scale: 1, seed: 9 },
  { kind: 'sign', x: 24.8, z: -6.9, rot: -Math.PI / 2, scale: 1, seed: 10 },
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
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }, { x: -27, z: 0 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }, { x: 27, z: 0 }],
  ],
  fountains,
  obstacles,
  movers: [
    { kind: 'log', r: 0.55, len: 3.2, lane: -0.45, speed: 1.3, offset: -10, seed: 1 },
    { kind: 'log', r: 0.55, len: 2.8, lane: 0.45, speed: 1.3, offset: 14, seed: 2 },
  ],
  runeSpots: withMirroredPoints([{ x: 0, z: 0 }, { x: -1.0, z: -15 }]),
  hazardSlots,
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
    fogDensity: 0.012,
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
    grass: [0x4f6b2c, 0x5a7631, 0x46622a, 0x617d36, 0x3f5a26, 0x55702e, 0x687f38],
    dirt: [0x5b4630, 0x4f3d2a, 0x665036, 0x584530],
    bank: [0x4a3d2b, 0x55462f, 0x3f3424, 0x5c4b33],
    bed: [0x3a3424, 0x2f2b1f, 0x443b29, 0x35301f],
    dryBed: [0x8a7856, 0x7e6d4f, 0x958262, 0x77684c, 0x86745a],
    cliff: [0x4a4a3e, 0x55554a, 0x3e3f35, 0x5d5c4c],
    baseHeight: 1.2,
    noiseAmp: 0.14,
    noiseScale: 0.12,
    border: 'jungle',
  },
};
