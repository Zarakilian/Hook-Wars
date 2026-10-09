// Aurora Harbour: a frozen fjord harbour at night under the aurora (reference: the ice-floe harbour
// with a watchtower rock, timber dock frames and cranes, a rope bridge and a lantern-lit village).
// Frozen floe decks and timber docks hug both banks as forward hooking spots; the watchtower rock
// and its ice-rock islets are grapple perches. Tidal mode: the harbour freezes solid, then cracks.
// Point symmetric: every gameplay element mirrors through (0, 0).
import { channelDepthAt, clearOf, inCircles, platformAt, riverAt, scatter, symmetricRiver, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle, Platform, RiverDef } from './types.ts';

const W = 72;
const D = 48;

const river: RiverDef = { points: symmetricRiver(D, { amp: 1.3, freq: 0.09, amp3: 0.3, hw: 5.15, hwVar: 0.35, hwFreq: 0.18 }), depth: 2.8, bank: 1.6, flow: 0.7 };
// the watchtower rock and two ice-rock islets per half, on the centreline (the floes drift either side)
const isleA = riverAt(river.points, 9.2).x;
const isleB = riverAt(river.points, 17.5).x;
const islands = [
  { x: 0, z: 0, r: 1.9 },
  { x: -isleA, z: -9.2, r: 1.2 },
  { x: isleA, z: 9.2, r: 1.2 },
  { x: -isleB, z: -17.5, r: 1.3 },
  { x: isleB, z: 17.5, r: 1.3 },
];
const half: Platform[] = [
  // frozen floe decks and a timber dock frame on each bank: forward hooking spots
  // (the floes float about a quarter over the water, clear of the drifting icefloe lanes)
  { kind: 'floe', x: -5.4, z: 4.4, w: 3.0, d: 2.6, rot: 0.25, seed: 1 },
  { kind: 'dock', x: -6.9, z: -13.6, w: 3.2, d: 1.9, rot: 0, seed: 3 },
  { kind: 'floe', x: -4.6, z: 20.6, w: 2.6, d: 2.2, rot: -0.3, seed: 5 },
];
const platforms: Platform[] = [...half, ...half.map((p) => ({ ...p, x: -p.x, z: -p.z, seed: (p.seed ?? 0) + 1 }))];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const westHalf: Obstacle[] = [
  // bank cover
  { shape: 'circle', kind: 'iceshelf', x: -9.4, z: -5.6, r: 1.3, seed: 2 },
  { shape: 'circle', kind: 'lanternpost', x: -8.0, z: 1.6, r: 0.3, seed: 4 },
  { shape: 'circle', kind: 'crane', x: -8.8, z: -16.6, r: 1.1, seed: 10 },
  { shape: 'circle', kind: 'snowpine', x: -10.6, z: 9.4, r: 0.85, seed: 3 },
  { shape: 'circle', kind: 'cratepile', x: -9.2, z: 16.0, r: 1.0, seed: 5 },
  // midfield
  { shape: 'circle', kind: 'snowpine', x: -17.2, z: -3.6, r: 0.85, seed: 6 },
  { shape: 'circle', kind: 'iceshelf', x: -19.6, z: 12.6, r: 1.5, seed: 7 },
  { shape: 'circle', kind: 'barrel', x: -14.6, z: -11.4, r: 0.55, seed: 11 },
  { shape: 'circle', kind: 'snowpine', x: -15.6, z: 20.0, r: 0.85, seed: 12 },
  // backfield
  { shape: 'circle', kind: 'runestone', x: -23.2, z: -12.2, r: 0.7, seed: 8 },
  { shape: 'circle', kind: 'snowpine', x: -26.2, z: 5.4, r: 0.85, seed: 9 },
  { shape: 'circle', kind: 'snowpine', x: -28.6, z: -18.4, r: 0.85, seed: 13 },
  { shape: 'wall', kind: 'wall_ice', ax: -24.5, az: 17.5, bx: -20.5, bz: 19.2, r: 0.4, h: 1.4, seed: 14 },
];
// the watchtower stands alone on the centre rock (its own mirror)
const obstacles: Obstacle[] = [...withMirrors(westHalf), { shape: 'circle', kind: 'watchtower', x: 0, z: 0, r: 1.1, seed: 1 }];

const partial = { w: W, d: D, river, platforms, islands };
const depth = (x: number, z: number) => channelDepthAt(partial, x, z);
const plazas = fountains.map((f) => ({ x: f.x, z: f.z, r: f.r + 0.8 }));
const offDeck = (x: number, z: number) => !platformAt(partial, x, z);
const onGround = (x: number, z: number) =>
  depth(x, z) < -1.0 && offDeck(x, z) && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 1 && Math.abs(z) < D / 2 - 0.6 && !inCircles(plazas, x, z);

const decor: Decor[] = [
  ...scatter(partial, { kind: 'snowtuft', count: 240, seed: 61, scale: [0.7, 1.4], accept: onGround }),
  ...scatter(partial, { kind: 'pebbles', count: 40, seed: 62, scale: [0.6, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'icicles', count: 30, seed: 63, scale: [0.7, 1.2], accept: (x, z) => { const c = depth(x, z); return c > -1.6 && c < -0.4 && offDeck(x, z) && clearOf(obstacles, x, z, 0.5); } }),
  ...scatter(partial, { kind: 'grass', count: 30, seed: 64, scale: [0.6, 1.0], accept: (x, z) => onGround(x, z) && Math.abs(x) > 20 }),
  // the rope bridge from the watchtower rock to the islets, high above play
  { kind: 'ropebridge', x: -isleA / 2, z: -4.6, rot: Math.atan2(-isleA, -9.2), scale: 1, seed: 1 },
  { kind: 'ropebridge', x: isleA / 2, z: 4.6, rot: Math.atan2(isleA, 9.2), scale: 1, seed: 2 },
  { kind: 'banner', x: 0, z: 0, rot: 0, scale: 1, seed: 3 },
  { kind: 'lantern', x: -7.8, z: 2.2, rot: 0, scale: 1, seed: 4 },
  { kind: 'lantern', x: 7.8, z: -2.2, rot: Math.PI, scale: 1, seed: 5 },
  { kind: 'lantern', x: -6.0, z: -12.4, rot: 0, scale: 0.9, seed: 6 },
  { kind: 'lantern', x: 6.0, z: 12.4, rot: Math.PI, scale: 0.9, seed: 7 },
  { kind: 'chainhang', x: -8.8, z: -15.4, rot: 0, scale: 1, seed: 8 },
  { kind: 'chainhang', x: 8.8, z: 15.4, rot: Math.PI, scale: 1, seed: 9 },
  { kind: 'flag', x: -25.4, z: 7.6, rot: 0, scale: 1, seed: 10 },
  { kind: 'flag', x: 25.4, z: -7.6, rot: Math.PI, scale: 1, seed: 11 },
  { kind: 'sign', x: -24.8, z: -6.9, rot: Math.PI / 2, scale: 1, seed: 12 },
  { kind: 'sign', x: 24.8, z: 6.9, rot: -Math.PI / 2, scale: 1, seed: 13 },
];

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: 2.8, z: -4.4, r: 1.5, channel: true },
  { x: -2.6, z: -21.0, r: 1.4, channel: true },
  { x: -0.4, z: 12.8, r: 1.4, channel: true },
  { x: -12.6, z: 2.4, r: 1.5, channel: false },
  { x: -18.0, z: -9.6, r: 1.5, channel: false },
]);

export const aurora: MapDef = {
  id: 'aurora',
  name: 'Aurora Harbour',
  blurb: 'A frozen harbour under the northern lights. Floe decks and timber docks reach into the water, a watchtower rock stands in the middle. On Tidal, the whole harbour freezes solid, then cracks.',
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
    // lanes 0.55 of the half width: clear of the bank floes and of the watchtower rock (0.5 hits it)
    { kind: 'icefloe', r: 0.95, len: 0, lane: -0.55, speed: 1.3, offset: -14, seed: 1 },
    { kind: 'icefloe', r: 0.95, len: 0, lane: 0.55, speed: -1.3, offset: 14, seed: 2 },
  ],
  runeSpots: withMirroredPoints([{ x: -isleA, z: -9.2 }, { x: 0.8, z: -4.8 }]),
  hazardSlots,
  decor,
  atmosphere: {
    timeOfDay: 'night',
    sunDir: [-0.3, 0.52, -0.5],
    // a whiter moon than Frostfang's: the snow caps read white, the glowing ice and lanterns carry the colour
    sunColor: 0xc2d4ff,
    sunIntensity: 1.7,
    skyTop: 0x070c26,
    skyHorizon: 0x284a78,
    groundAmbient: 0x283058,
    ambientIntensity: 1.1,
    // a darker, thinner sea smoke than Frostfang's haze: the glowing ice and the dark leads keep their contrast
    fogColor: 0x34426a,
    fogDensity: 0.0085,
    weather: 'snow',
    aurora: true,
    waterShallow: 0x2aa6c0,
    waterDeep: 0x08223e,
    waterFoam: 0xeaf6ff,
    exposure: 1.15,
    saturation: 1.05,
    bloom: 0.75,
  },
  terrain: {
    // snow caps on the harbour ice (the slabs, leads and shelf ice are painted by the biome), trodden
    // blue snow on the paths, glassy shelf ice, a dark harbour floor
    grass: [0xeef3f9, 0xe2eaf4, 0xf8fbfe, 0xd6e2f0, 0xe8eff7],
    dirt: [0x8a9cb4, 0x7c8ea8, 0x9aaac0],
    bank: [0x9cc8e2, 0x86b8da, 0xb2d6ec, 0x8cbcdc],
    bed: [0x1c3a46, 0x16323c, 0x24444f],
    // the drained harbour floor: dark grey-green silt (the biome adds black stones and frost)
    dryBed: [0x4a5458, 0x3e484c, 0x565f5e, 0x353f43],
    cliff: [0x8ea2b8, 0x7c90a6, 0xa4b6ca],
    baseHeight: 1.3,
    noiseAmp: 0.17,
    noiseScale: 0.1,
    border: 'ice',
  },
};
