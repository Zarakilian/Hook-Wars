// Aurora Harbour: a wide fjord harbour of ice floes under the aurora (reference: the frozen harbour
// with a watchtower island, rope bridges and a lantern-lit village). Floe decks give forward spots,
// floe islands are grapple-only perches. Tidal mode: the harbour freezes solid, then thaws.
// Point symmetric: every gameplay element mirrors through (0, 0).
import { channelDepthAt, clearOf, scatter, symmetricRiver, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle, Platform, RiverDef } from './types.ts';

const W = 72;
const D = 48;

const river: RiverDef = { points: symmetricRiver(D, { amp: 1.4, freq: 0.09, amp3: 0.3, hw: 5.6, hwVar: 0.4, hwFreq: 0.18 }), depth: 2.8, bank: 1.6, flow: 0.7 };
const islands = [
  { x: 0, z: 0, r: 2.3 }, // watchtower rock
  { x: -2.4, z: -9, r: 1.4 },
  { x: 2.4, z: 9, r: 1.4 },
  { x: 1.6, z: -17, r: 1.6 },
  { x: -1.6, z: 17, r: 1.6 },
];
const platforms: Platform[] = [
  // frozen floe decks hugging each bank: forward hooking spots
  { kind: 'floe', x: -5.2, z: 4, w: 3.2, d: 2.6, rot: 0.25, seed: 1 },
  { kind: 'floe', x: 5.2, z: -4, w: 3.2, d: 2.6, rot: 0.25, seed: 2 },
  { kind: 'dock', x: -5.6, z: -14, w: 3.0, d: 1.8, rot: 0, seed: 3 },
  { kind: 'dock', x: 5.6, z: 14, w: 3.0, d: 1.8, rot: 0, seed: 4 },
];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const half: Obstacle[] = [
  { shape: 'circle', kind: 'watchtower', x: 0.6, z: 0.4, r: 1.2, seed: 1 },
  { shape: 'circle', kind: 'iceshelf', x: -8.6, z: -6, r: 1.3, seed: 2 },
  { shape: 'circle', kind: 'snowpine', x: -10.5, z: 9, r: 0.85, seed: 3 },
  { shape: 'circle', kind: 'lanternpost', x: -7.4, z: 1, r: 0.3, seed: 4 },
  { shape: 'circle', kind: 'cratepile', x: -12, z: -16, r: 1.0, seed: 5 },
  { shape: 'circle', kind: 'snowpine', x: -17, z: -4, r: 0.85, seed: 6 },
  { shape: 'circle', kind: 'iceshelf', x: -19.5, z: 13, r: 1.5, seed: 7 },
  { shape: 'circle', kind: 'runestone', x: -23, z: -12, r: 0.7, seed: 8 },
  { shape: 'circle', kind: 'snowpine', x: -26, z: 5, r: 0.85, seed: 9 },
];
const obstacles = withMirrors(half);

const partial = { w: W, d: D, river, platforms, islands };
const depth = (x: number, z: number) => channelDepthAt(partial, x, z);
const onGround = (x: number, z: number) => depth(x, z) < -1.0 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 2;

const decor: Decor[] = [
  ...scatter(partial, { kind: 'snowtuft', count: 230, seed: 61, scale: [0.7, 1.4], accept: onGround }),
  ...scatter(partial, { kind: 'pebbles', count: 50, seed: 62, scale: [0.6, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'icicles', count: 26, seed: 63, scale: [0.7, 1.2], accept: (x, z) => { const c = depth(x, z); return c > -1.8 && c < -0.4; } }),
  { kind: 'ropebridge', x: 0, z: 0, rot: Math.PI / 2, scale: 1, seed: 1 },
  { kind: 'banner', x: 0.6, z: 0.4, rot: 0, scale: 1, seed: 2 },
  { kind: 'lantern', x: -7.2, z: 1.2, rot: 0, scale: 1, seed: 3 },
  { kind: 'lantern', x: 7.2, z: -1.2, rot: 0, scale: 1, seed: 4 },
];

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: 2.6, z: -4, r: 1.6, channel: true },
  { x: -2.8, z: -20, r: 1.5, channel: true },
  { x: 0, z: 12, r: 1.4, channel: true },
  { x: -11, z: 2, r: 1.5, channel: false },
  { x: -18, z: -10, r: 1.5, channel: false },
]);

export const aurora: MapDef = {
  id: 'aurora',
  name: 'Aurora Harbour',
  blurb: 'A frozen harbour under the northern lights. Floe decks and a watchtower rock in the middle. On Tidal, the whole harbour freezes solid, then cracks.',
  w: W,
  d: D,
  river,
  platforms,
  islands,
  tide: { style: 'freeze', lowSec: 24, risingSec: 6, highSec: 34, fallingSec: 6 },
  special: 'icespikes',
  spawns: [
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }],
  ],
  fountains,
  obstacles,
  movers: [
    { kind: 'icefloe', r: 1.2, len: 0, lane: -0.45, speed: 1.4, offset: -14, seed: 1 },
    { kind: 'icefloe', r: 0.9, len: 0, lane: 0.5, speed: -1.7, offset: 6, seed: 2 },
    { kind: 'icefloe', r: 1.5, len: 0, lane: 0.1, speed: 1.1, offset: 20, seed: 3 },
  ],
  runeSpots: [{ x: -2.4, z: -9 }, { x: 2.4, z: 9 }, { x: 0, z: -4 }],
  hazardSlots,
  decor,
  atmosphere: {
    timeOfDay: 'night',
    sunDir: [-0.35, 0.5, -0.45],
    sunColor: 0xb4ccff,
    sunIntensity: 1.5,
    skyTop: 0x0a0f2c,
    skyHorizon: 0x30507e,
    groundAmbient: 0x2a3258,
    ambientIntensity: 1.15,
    fogColor: 0x5c6c9e,
    fogDensity: 0.012,
    weather: 'snow',
    aurora: true,
    waterShallow: 0x3ab8c8,
    waterDeep: 0x0a2846,
    waterFoam: 0xf0f8ff,
    exposure: 1.06,
    saturation: 1.02,
    bloom: 0.7,
  },
  terrain: {
    grass: [0xeaf0f7, 0xdfe7f1, 0xf4f7fb, 0xd4dfeb],
    dirt: [0x6a7486, 0x5b6576, 0x7a8494],
    bank: [0x98a8bc, 0x8696aa, 0xadbccc],
    bed: [0x44576a, 0x384a5c, 0x506478],
    dryBed: [0x8a98a6, 0x7c8998, 0x9caab8],
    cliff: [0x8ea2b8, 0x7c90a6, 0xa4b6ca],
    baseHeight: 1.3,
    noiseAmp: 0.18,
    noiseScale: 0.1,
    border: 'ice',
  },
};
