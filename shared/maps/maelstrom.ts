// Maelstrom Lagoon: a sunlit cove with a great whirlpool in a round lagoon (reference: the tropical
// lagoon with waterfalls down the cliffs, sea stacks topped with palms, wooden piers and a shipwreck).
// The river pours in over the waterfall cliff at z = -24, swirls round the whirlpool and runs out over
// the beach to the open sea past z = +24. The whirlpool bends every hook that crosses it. A rocky sea
// stack headland and a pier on each shore are forward spots. Tidal mode: the sea rolls in and out.
// Point symmetric through (0, 0).
import { channelDepthAt, clearOf, inCircles, platformAt, riverAt, scatter, symmetricRiver, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle, Platform, Pool, RiverDef } from './types.ts';

const W = 72;
const D = 48;

const river: RiverDef = { points: symmetricRiver(D, { amp: 0.8, freq: 0.12, hw: 5.0, hwVar: 0.3, hwFreq: 0.2 }), depth: 2.6, bank: 3.2, flow: 0.3 };
// the lagoon: a little taller than wide, so the hook still reaches shore to shore (14.8 m) at its middle
const pools: Pool[] = [{ x: 0, z: 0, rx: 7.4, rz: 10, rot: 0 }];
const isleX = riverAt(river.points, 14).x;
const islands = [
  { x: -6.0, z: 4.6, r: 1.8 }, // sea stack headlands on the lagoon rim
  { x: 6.0, z: -4.6, r: 1.8 },
  { x: -isleX, z: -14, r: 1.2 }, // rocky islets in the river
  { x: isleX, z: 14, r: 1.2 },
];
const halfPl: Platform[] = [
  { kind: 'pier', x: -8.2, z: -3.0, w: 4.4, d: 1.7, rot: 0, seed: 1 },
  { kind: 'pier', x: -6.8, z: 15.6, w: 3.0, d: 1.6, rot: -0.2, seed: 3 },
];
const platforms: Platform[] = [...halfPl, ...halfPl.map((p) => ({ ...p, x: -p.x, z: -p.z, seed: (p.seed ?? 0) + 1 }))];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const half: Obstacle[] = [
  // the sea stack on the headland (the headland's tip stays free to stand on)
  { shape: 'circle', kind: 'seastack', x: -6.7, z: 5.0, r: 1.0, seed: 1 },
  // beach cover
  { shape: 'circle', kind: 'palm', x: -11.6, z: -7.6, r: 0.7, seed: 2 },
  { shape: 'circle', kind: 'cratepile', x: -11.4, z: 1.8, r: 1.0, seed: 3 },
  { shape: 'circle', kind: 'reefpost', x: -10.4, z: 9.6, r: 0.5, bouncy: true, seed: 4 },
  { shape: 'circle', kind: 'coralrock', x: -8.6, z: -13.4, r: 1.1, seed: 5 },
  { shape: 'wall', kind: 'shipwreck', ax: -10.8, az: 14.6, bx: -7.8, bz: 19.8, r: 0.9, h: 3, seed: 9 },
  // midfield
  { shape: 'circle', kind: 'palm', x: -17.2, z: 11.8, r: 0.7, seed: 6 },
  { shape: 'circle', kind: 'tikitotem', x: -19.6, z: -2.2, r: 0.75, seed: 7 },
  { shape: 'circle', kind: 'coralrock', x: -16.4, z: -17.6, r: 1.2, seed: 10 },
  { shape: 'circle', kind: 'reefpost', x: -15.0, z: 4.4, r: 0.5, bouncy: true, seed: 11 },
  // backfield
  { shape: 'circle', kind: 'palm', x: -24.2, z: -13.2, r: 0.7, seed: 8 },
  { shape: 'circle', kind: 'palm', x: -26.6, z: 14.6, r: 0.7, seed: 12 },
  { shape: 'circle', kind: 'cratepile', x: -23.0, z: 7.6, r: 1.0, seed: 13 },
];
const obstacles = withMirrors(half);

const partial = { w: W, d: D, river, pools, platforms, islands };
const depth = (x: number, z: number) => channelDepthAt(partial, x, z);
const plazas = fountains.map((f) => ({ x: f.x, z: f.z, r: f.r + 0.8 }));
const offDeck = (x: number, z: number) => !platformAt(partial, x, z);
const onGround = (x: number, z: number) =>
  depth(x, z) < -1.0 && offDeck(x, z) && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 1 && Math.abs(z) < D / 2 - 0.6 && !inCircles(plazas, x, z);
const beach = (x: number, z: number) => { const c = depth(x, z); return c > -3.2 && c < 0.1 && offDeck(x, z) && clearOf(obstacles, x, z, 0.5); };
const reef = (x: number, z: number) => depth(x, z) > 1 && Math.hypot(x, z) > 5.6 && offDeck(x, z) && !inCircles(islands, x, z, 0.6);

const decor: Decor[] = [
  ...scatter(partial, { kind: 'grass', count: 150, seed: 71, scale: [0.6, 1.1], accept: (x, z) => onGround(x, z) && Math.abs(x) > 14 }),
  ...scatter(partial, { kind: 'flower', count: 34, seed: 76, scale: [0.6, 1.0], accept: (x, z) => onGround(x, z) && Math.abs(x) > 15 }),
  ...scatter(partial, { kind: 'fern', count: 26, seed: 77, scale: [0.7, 1.2], accept: (x, z) => onGround(x, z) && Math.abs(x) > 19 }),
  ...scatter(partial, { kind: 'shell', count: 50, seed: 72, scale: [0.6, 1.2], accept: beach }),
  ...scatter(partial, { kind: 'starfish', count: 30, seed: 73, scale: [0.6, 1.2], accept: (x, z) => { const c = depth(x, z); return c > -2 && c < 2 && offDeck(x, z); } }),
  ...scatter(partial, { kind: 'coralfan', count: 46, seed: 74, scale: [0.7, 1.3], accept: reef }),
  ...scatter(partial, { kind: 'seaweed', count: 40, seed: 75, scale: [0.7, 1.3], accept: reef }),
  { kind: 'waterfall', x: 0, z: -D / 2, rot: 0, scale: 1, seed: 1 },
  { kind: 'treasure', x: -5.0, z: 4.0, rot: 0.3, scale: 1, seed: 2 }, // on the sea stack headlands
  { kind: 'treasure', x: 5.0, z: -4.0, rot: 0.3 + Math.PI, scale: 1, seed: 3 },
  { kind: 'treasure', x: -11.6, z: 17.8, rot: 1.2, scale: 0.9, seed: 4 }, // spilled from the wreck
  { kind: 'treasure', x: 11.6, z: -17.8, rot: 1.2 + Math.PI, scale: 0.9, seed: 5 },
  { kind: 'lantern', x: -7.0, z: -4.2, rot: 0, scale: 1, seed: 6 },
  { kind: 'lantern', x: 7.0, z: 4.2, rot: Math.PI, scale: 1, seed: 7 },
  { kind: 'rope', x: -9.6, z: -2.1, rot: 0.2, scale: 1, seed: 8 },
  { kind: 'rope', x: 9.6, z: 2.1, rot: 0.2 + Math.PI, scale: 1, seed: 9 },
  { kind: 'flag', x: -9.4, z: 18.6, rot: 0.6, scale: 1, seed: 10 },
  { kind: 'flag', x: 9.4, z: -18.6, rot: 0.6 + Math.PI, scale: 1, seed: 11 },
  { kind: 'sign', x: -24.8, z: -6.9, rot: Math.PI / 2, scale: 1, seed: 12 },
  { kind: 'sign', x: 24.8, z: 6.9, rot: -Math.PI / 2, scale: 1, seed: 13 },
];

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: 4.4, z: 7.4, r: 1.3, channel: true }, // jellyfish at the lagoon's edge, outside the whirlpool
  { x: -1.8, z: 20.4, r: 1.5, channel: true },
  { x: -2.2, z: -10.4, r: 1.3, channel: true },
  { x: -13.2, z: -10.6, r: 1.4, channel: false },
  { x: -16.4, z: 0.4, r: 1.5, channel: false },
]);

export const maelstrom: MapDef = {
  id: 'maelstrom',
  name: 'Maelstrom Lagoon',
  blurb: 'A sunny cove around a giant whirlpool that bends every hook crossing it. Sea stacks, piers and a shipwreck frame the lagoon. On Tidal, the sea rolls in and out.',
  w: W,
  d: D,
  river,
  pools,
  platforms,
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
    { kind: 'raft', r: 0.85, len: 1.6, lane: -0.5, speed: 0.9, offset: -10, seed: 1 },
    { kind: 'raft', r: 0.85, len: 1.6, lane: 0.5, speed: -0.9, offset: 10, seed: 2 },
  ],
  whirlpool: { x: 0, z: 0, r: 5.0, strength: 3.2 },
  runeSpots: withMirroredPoints([{ x: 0, z: 0 }, { x: -isleX, z: -14 }]),
  hazardSlots,
  decor,
  atmosphere: {
    timeOfDay: 'day',
    sunDir: [0.4, 0.8, 0.32],
    sunColor: 0xfff0d2,
    sunIntensity: 3.3,
    skyTop: 0x3a8ee6,
    skyHorizon: 0xc4ecff,
    groundAmbient: 0x6a5a3a,
    ambientIntensity: 1.1,
    fogColor: 0xb8e4f2,
    fogDensity: 0.006,
    weather: 'pollen',
    aurora: false,
    waterShallow: 0x36e2d2,
    waterDeep: 0x086088,
    waterFoam: 0xffffff,
    exposure: 1,
    saturation: 1.16,
    bloom: 0.4,
  },
  terrain: {
    grass: [0x74ac46, 0x82b84e, 0x66a03c, 0x8ec258, 0x5e9638],
    dirt: [0xe2cc96, 0xd6be88, 0xecdaaa],
    bank: [0xf0dcaa, 0xe6d098, 0xf8e8c0, 0xeed6a0],
    bed: [0xd2c092, 0xc4b080, 0xdccca0],
    dryBed: [0xe6d6aa, 0xd8c898, 0xf0e2bc, 0xccbc8e],
    cliff: [0x8e8a80, 0x7e7a70, 0x9e9a8e, 0x6e6a62],
    baseHeight: 1.15,
    noiseAmp: 0.12,
    noiseScale: 0.14,
    border: 'jungle',
  },
};
