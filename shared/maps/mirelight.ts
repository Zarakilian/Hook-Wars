// Mirelight Marsh: a braided sunset swamp (reference: the misty bayou with stump islands and docks).
// Side channels cut off a forward island strip on each bank; docks cross them. Lily pads, lanterns,
// stilt huts and mist. Tidal mode: the marsh floods and drains.
// Point symmetric: every gameplay element mirrors through (0, 0).
import { channelDepthAt, clearOf, scatter, symmetricRiver, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle, Platform, RiverDef, RiverPoint } from './types.ts';

const W = 72;
const D = 48;

const river: RiverDef = { points: symmetricRiver(D, { amp: 1.0, freq: 0.1, amp3: 0.25, hw: 4.4, hwVar: 0.3, hwFreq: 0.22 }), depth: 2.2, bank: 2.2, flow: 0.45 };

function sideChannel(x0: number, sign: number): RiverPoint[] {
  const pts: RiverPoint[] = [];
  for (let z = -17; z <= 17; z += 1) {
    const zz = z * sign;
    pts.push({ z: zz, x: x0 + Math.sin(zz * 0.21) * 0.8 * sign, hw: 1.7 + Math.cos(zz * 0.3) * 0.2 });
  }
  return pts.sort((a, b) => a.z - b.z);
}
const channels: RiverDef[] = [
  { points: sideChannel(-13.5, 1), depth: 1.8, bank: 1.6, flow: 0.3 },
  { points: sideChannel(13.5, -1), depth: 1.8, bank: 1.6, flow: -0.3 },
];

const platforms: Platform[] = [
  // docks across the side channels (the only dry way onto the forward strip in Deep Water)
  { kind: 'dock', x: -13.5, z: -8, w: 5.4, d: 2.2, rot: 0, seed: 1 },
  { kind: 'dock', x: -13.5, z: 9, w: 5.4, d: 2.2, rot: 0, seed: 2 },
  { kind: 'dock', x: 13.5, z: 8, w: 5.4, d: 2.2, rot: 0, seed: 3 },
  { kind: 'dock', x: 13.5, z: -9, w: 5.4, d: 2.2, rot: 0, seed: 4 },
  // short piers poking into the main river: forward hooking spots
  { kind: 'pier', x: -5.4, z: 2, w: 2.6, d: 1.8, rot: 0, seed: 5 },
  { kind: 'pier', x: 5.4, z: -2, w: 2.6, d: 1.8, rot: 0, seed: 6 },
];

const islands = [{ x: 0, z: 0, r: 1.9 }, { x: 0.6, z: -12, r: 1.5 }, { x: -0.6, z: 12, r: 1.5 }];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const half: Obstacle[] = [
  { shape: 'circle', kind: 'stilthut', x: -9.4, z: -15, r: 1.6, seed: 1 },
  { shape: 'circle', kind: 'swampstump', x: -8.6, z: 5.5, r: 1.0, seed: 2 },
  { shape: 'circle', kind: 'lanternpost', x: -7.0, z: -4.5, r: 0.3, seed: 3 },
  { shape: 'circle', kind: 'cypress', x: -10.2, z: 13.5, r: 0.9, seed: 4 },
  { shape: 'circle', kind: 'cypress', x: -18.5, z: -3, r: 0.9, seed: 5 },
  { shape: 'circle', kind: 'mossrock', x: -20, z: 12, r: 1.3, seed: 6 },
  { shape: 'circle', kind: 'lanternpost', x: -16.5, z: 15, r: 0.3, seed: 7 },
  { shape: 'circle', kind: 'stilthut', x: -24, z: -14, r: 1.6, seed: 8 },
  { shape: 'circle', kind: 'swampstump', x: -25.5, z: 9, r: 1.0, seed: 9 },
];
const obstacles = withMirrors(half);

const partial = { w: W, d: D, river, channels, platforms, islands };
const depth = (x: number, z: number) => channelDepthAt(partial, x, z);
const onGround = (x: number, z: number) => depth(x, z) < -1.0 && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 2;
const inWater = (x: number, z: number) => depth(x, z) > 0.6;

const decor: Decor[] = [
  ...scatter(partial, { kind: 'grass', count: 200, seed: 51, scale: [0.7, 1.3], accept: onGround }),
  ...scatter(partial, { kind: 'cattail', count: 70, seed: 52, scale: [0.8, 1.4], accept: (x, z) => { const c = depth(x, z); return c > -2 && c < 0.5; } }),
  ...scatter(partial, { kind: 'lilypad', count: 70, seed: 53, scale: [0.7, 1.4], accept: inWater }),
  ...scatter(partial, { kind: 'fern', count: 40, seed: 54, scale: [0.7, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'mushroom', count: 26, seed: 55, scale: [0.6, 1.1], accept: onGround }),
  ...scatter(partial, { kind: 'firefly_swarm', count: 12, seed: 56, scale: [1, 1], accept: (x, z) => Math.abs(x) < 20 && clearOf(obstacles, x, z, 0.5) }),
  ...scatter(partial, { kind: 'mist', count: 10, seed: 57, scale: [1, 1.6], accept: (x, z) => depth(x, z) > 0 }),
  { kind: 'rowboat', x: -6.6, z: -9, rot: 0.4, scale: 1, seed: 1 },
  { kind: 'rowboat', x: 6.6, z: 9, rot: 0.4 + Math.PI, scale: 1, seed: 2 },
  { kind: 'lanternstring', x: -13.5, z: -8, rot: 0, scale: 1, seed: 3 },
  { kind: 'lanternstring', x: 13.5, z: 8, rot: Math.PI, scale: 1, seed: 4 },
];

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: 1.6, z: -6, r: 1.6, channel: true },
  { x: -1.8, z: 18, r: 1.6, channel: true },
  { x: -13.2, z: 0, r: 1.3, channel: true },
  { x: -9.5, z: -1, r: 1.5, channel: false },
  { x: -19, z: 6, r: 1.5, channel: false },
]);

export const mirelight: MapDef = {
  id: 'mirelight',
  name: 'Mirelight Marsh',
  blurb: 'A braided sunset marsh. Side channels cut off a forward strip on each bank: cross the docks, or grapple. On Tidal, the marsh floods and drains.',
  w: W,
  d: D,
  river,
  channels,
  platforms,
  islands,
  tide: { style: 'tide', lowSec: 24, risingSec: 9, highSec: 30, fallingSec: 9 },
  special: 'quicksand',
  spawns: [
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }],
  ],
  fountains,
  obstacles,
  movers: [
    { kind: 'log', r: 0.5, len: 2.8, lane: -0.4, speed: 1.2, offset: -6, seed: 1 },
    { kind: 'raft', r: 0.9, len: 1.4, lane: 0.45, speed: -1.0, offset: 10, seed: 2 },
  ],
  runeSpots: [{ x: 0, z: 0 }, { x: 0.6, z: -12 }, { x: -0.6, z: 12 }],
  hazardSlots,
  decor,
  atmosphere: {
    timeOfDay: 'dusk',
    sunDir: [-0.2, 0.16, -0.95],
    sunColor: 0xffa060,
    sunIntensity: 2.4,
    skyTop: 0x3a2a58,
    skyHorizon: 0xff9a5a,
    groundAmbient: 0x3a2e28,
    ambientIntensity: 0.95,
    fogColor: 0x9a7a88,
    fogDensity: 0.013,
    weather: 'fireflies',
    aurora: false,
    waterShallow: 0x6a6648,
    waterDeep: 0x162624,
    waterFoam: 0xe8dcc8,
    exposure: 1.02,
    saturation: 1.12,
    bloom: 0.7,
  },
  terrain: {
    grass: [0x4a6a2a, 0x557632, 0x3e5e26, 0x5f7e38, 0x445f2a],
    dirt: [0x5a4430, 0x4e3c2a, 0x684f36],
    bank: [0x4a3c2a, 0x56462e, 0x3e3324],
    bed: [0x352f22, 0x2c281d, 0x403726],
    dryBed: [0x6a5840, 0x5c4d38, 0x766248, 0x524438],
    cliff: [0x4a4a3c, 0x55554a, 0x3e3f34],
    baseHeight: 1.2,
    noiseAmp: 0.16,
    noiseScale: 0.12,
    border: 'jungle',
  },
};
