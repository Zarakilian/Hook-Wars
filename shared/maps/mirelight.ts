// Mirelight Marsh: a braided sunset bayou (reference: the misty marsh with giant cypress, stump
// islands with lanterns, plank docks on piles and stilt huts). A side channel on each bank cuts off a
// forward strip by the main river: cross the plank docks, walk round the channel ends, or grapple.
// Stump islands sit in the main river. Tidal mode: the marsh floods and drains.
// Point symmetric: every gameplay element mirrors through (0, 0).
import { channelDepthAt, clearOf, inCircles, platformAt, riverAt, scatter, symmetricRiver, withMirroredPoints, withMirrors } from './helpers.ts';
import { valueNoise2 } from '../math.ts';
import type { Decor, HazardSlot, MapDef, Obstacle, Platform, RiverDef, RiverPoint } from './types.ts';

/**
 * The marsh's wet ground: above 0.58 the terrain draws wet mud, above 0.71 a standing puddle (visual
 * only: the sim ground is flat). Shared with the terrain biome so reeds can ring the puddles.
 */
export function mireMud(x: number, z: number): number {
  return valueNoise2(x * 0.13, z * 0.13, 501) * 0.72 + valueNoise2(x * 0.55, z * 0.55, 502) * 0.28;
}

const W = 72;
const D = 48;

const river: RiverDef = { points: symmetricRiver(D, { amp: 1.0, freq: 0.1, amp3: 0.25, hw: 5.0, hwVar: 0.3, hwFreq: 0.22 }), depth: 2.2, bank: 2.2, flow: 0.45 };

/** West side channel (team 0's). Rounded ends: the half width tapers to nothing at |z| = 16. */
const westChannel: RiverPoint[] = [];
for (let z = -16; z <= 16; z += 1) {
  const taper = Math.min(1, (16 - Math.abs(z)) / 3.2);
  westChannel.push({ z, x: -14 + Math.sin(z * 0.21) * 0.8, hw: (1.65 + Math.cos(z * 0.3) * 0.2) * Math.sqrt(taper) });
}
// the east channel is its exact point mirror
const eastChannel: RiverPoint[] = westChannel.map((p) => ({ z: -p.z, x: -p.x, hw: p.hw })).sort((a, b) => a.z - b.z);
const channels: RiverDef[] = [
  { points: westChannel, depth: 1.8, bank: 1.6, flow: 0.3 },
  { points: eastChannel, depth: 1.8, bank: 1.6, flow: -0.3 },
];

const half: Platform[] = [
  // plank docks across the side channel: the dry way onto the forward strip in Deep Water
  { kind: 'dock', x: -14.1, z: -6.5, w: 5.6, d: 2.2, rot: 0, seed: 1 },
  { kind: 'dock', x: -13.6, z: 7.5, w: 5.6, d: 2.2, rot: 0, seed: 2 },
  // a short pier poking into the main river: a forward hooking spot
  { kind: 'pier', x: -5.6, z: 2.2, w: 2.8, d: 1.8, rot: 0, seed: 5 },
];
const platforms: Platform[] = [...half, ...half.map((p) => ({ ...p, x: -p.x, z: -p.z, seed: (p.seed ?? 0) + 10 }))];

// stump islands on the main river's centreline (the drifting log and raft pass either side)
const islandX = riverAt(river.points, 12.5).x;
const islands = [{ x: 0, z: 0, r: 1.9 }, { x: -islandX, z: -12.5, r: 1.5 }, { x: islandX, z: 12.5, r: 1.5 }];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const westHalf: Obstacle[] = [
  // forward strip (between the side channel and the main river)
  { shape: 'circle', kind: 'swampstump', x: -8.9, z: 5.2, r: 1.0, seed: 2 },
  { shape: 'circle', kind: 'lanternpost', x: -7.6, z: -3.6, r: 0.3, seed: 3 },
  { shape: 'circle', kind: 'cypress', x: -9.4, z: 13.2, r: 0.9, seed: 4 },
  { shape: 'circle', kind: 'mossrock', x: -9.2, z: -11.6, r: 1.0, seed: 10 },
  // past the channel ends
  { shape: 'circle', kind: 'stilthut', x: -10.6, z: -19.6, r: 1.6, seed: 1 },
  { shape: 'circle', kind: 'lanternpost', x: -15.6, z: 19.4, r: 0.3, seed: 7 },
  // backfield
  { shape: 'circle', kind: 'cypress', x: -19.2, z: -3.2, r: 0.9, seed: 5 },
  { shape: 'circle', kind: 'mossrock', x: -20.4, z: 12.2, r: 1.3, seed: 6 },
  { shape: 'circle', kind: 'stilthut', x: -24.2, z: -14.2, r: 1.6, seed: 8 },
  { shape: 'circle', kind: 'swampstump', x: -25.4, z: 9.2, r: 1.0, seed: 9 },
  { shape: 'circle', kind: 'cypress', x: -29.6, z: 18.4, r: 0.9, seed: 11 },
  { shape: 'circle', kind: 'lanternpost', x: -19.4, z: -10.4, r: 0.3, seed: 12 },
  { shape: 'wall', kind: 'wall_wood', ax: -30.5, az: -19.5, bx: -26.5, bz: -21, r: 0.35, h: 1.3, seed: 13 },
];
const obstacles = withMirrors(westHalf);

const partial = { w: W, d: D, river, channels, platforms, islands };
const depth = (x: number, z: number) => channelDepthAt(partial, x, z);
const plazas = fountains.map((f) => ({ x: f.x, z: f.z, r: f.r + 0.8 }));
const offDeck = (x: number, z: number) => !platformAt(partial, x, z);
const onGround = (x: number, z: number) =>
  depth(x, z) < -1.0 && offDeck(x, z) && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 1 && Math.abs(z) < D / 2 - 0.6 && !inCircles(plazas, x, z);
const shore = (x: number, z: number) => { const c = depth(x, z); return c > -2.6 && c < 0.45 && offDeck(x, z) && clearOf(obstacles, x, z, 0.4); };
const inWater = (x: number, z: number) => depth(x, z) > 0.7 && offDeck(x, z) && !inCircles(islands, x, z, 0.8);

const decor: Decor[] = [
  ...scatter(partial, { kind: 'grass', count: 150, seed: 51, scale: [0.7, 1.35], accept: onGround }),
  ...scatter(partial, { kind: 'cattail', count: 150, seed: 52, scale: [0.8, 1.45], accept: shore }),
  ...scatter(partial, { kind: 'reeds', count: 70, seed: 58, scale: [0.8, 1.3], accept: shore }),
  // cattails and reeds round the puddles out on the moss
  ...scatter(partial, { kind: 'cattail', count: 70, seed: 60, scale: [0.7, 1.2], accept: (x, z) => { const m = mireMud(x, z); return m > 0.62 && m < 0.72 && onGround(x, z); } }),
  ...scatter(partial, { kind: 'lilypad', count: 150, seed: 53, scale: [0.7, 1.4], accept: inWater }),
  ...scatter(partial, { kind: 'fern', count: 46, seed: 54, scale: [0.7, 1.2], accept: (x, z) => onGround(x, z) && Math.abs(x) > 8 }),
  ...scatter(partial, { kind: 'mushroom', count: 30, seed: 55, scale: [0.6, 1.1], accept: (x, z) => onGround(x, z) && !clearOf(obstacles, x, z, 2.2) }),
  ...scatter(partial, { kind: 'flower', count: 8, seed: 59, scale: [0.6, 1.0], accept: onGround }),
  ...scatter(partial, { kind: 'firefly_swarm', count: 14, seed: 56, scale: [1, 1], accept: (x, z) => Math.abs(x) < 22 && clearOf(obstacles, x, z, 0.5) }),
  // thin mist only: the reference's water stays dark and clear between the wisps
  ...scatter(partial, { kind: 'mist', count: 8, seed: 57, scale: [1, 1.5], accept: (x, z) => depth(x, z) > 1.2 }),
  // set dressing: moored rowboats, lantern strings over the docks, a rope on each pier
  { kind: 'rowboat', x: -6.3, z: -9.4, rot: 0.35, scale: 1, seed: 1 },
  { kind: 'rowboat', x: 6.3, z: 9.4, rot: 0.35 + Math.PI, scale: 1, seed: 2 },
  { kind: 'lanternstring', x: -14.1, z: -6.5, rot: 0, scale: 1, seed: 3 },
  { kind: 'lanternstring', x: 14.1, z: 6.5, rot: Math.PI, scale: 1, seed: 4 },
  { kind: 'lantern', x: 0.9, z: 0.9, rot: 0, scale: 1, seed: 5 }, // stump island lanterns
  { kind: 'lantern', x: -0.9, z: -0.9, rot: Math.PI, scale: 1, seed: 6 },
  { kind: 'lantern', x: -islandX + 0.6, z: -12.0, rot: 0.5, scale: 0.9, seed: 7 },
  { kind: 'lantern', x: islandX - 0.6, z: 12.0, rot: 0.5 + Math.PI, scale: 0.9, seed: 8 },
  { kind: 'rope', x: -6.4, z: 3.0, rot: 0.2, scale: 1, seed: 9 },
  { kind: 'rope', x: 6.4, z: -3.0, rot: 0.2 + Math.PI, scale: 1, seed: 10 },
  { kind: 'sign', x: -24.8, z: 6.9, rot: Math.PI / 2, scale: 1, seed: 11 },
  { kind: 'sign', x: 24.8, z: -6.9, rot: -Math.PI / 2, scale: 1, seed: 12 },
];

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: 1.8, z: -6.2, r: 1.6, channel: true },
  { x: -1.6, z: 19.0, r: 1.5, channel: true },
  { x: -14.0, z: 0.4, r: 1.2, channel: true }, // in the side channel
  { x: -9.6, z: -0.6, r: 1.4, channel: false }, // forward strip
  { x: -20.0, z: 5.6, r: 1.5, channel: false },
]);

export const mirelight: MapDef = {
  id: 'mirelight',
  name: 'Mirelight Marsh',
  blurb: 'A braided sunset marsh. Side channels cut off a forward strip on each bank: cross the plank docks, or grapple. On Tidal, the marsh floods and drains.',
  w: W,
  d: D,
  river,
  channels,
  platforms,
  islands,
  tide: { style: 'tide', lowSec: 24, risingSec: 9, highSec: 30, fallingSec: 9 },
  special: 'quicksand',
  spawns: [
    [{ x: -30, z: -6 }, { x: -30, z: -3 }, { x: -30, z: 0 }, { x: -30, z: 3 }, { x: -30, z: 6 }, { x: -27, z: 0 }],
    [{ x: 30, z: 6 }, { x: 30, z: 3 }, { x: 30, z: 0 }, { x: 30, z: -3 }, { x: 30, z: -6 }, { x: 27, z: 0 }],
  ],
  fountains,
  obstacles,
  movers: [
    { kind: 'log', r: 0.5, len: 2.8, lane: -0.55, speed: 1.15, offset: -6, seed: 1 },
    { kind: 'raft', r: 0.8, len: 1.4, lane: 0.55, speed: -1.15, offset: 6, seed: 2 },
  ],
  runeSpots: withMirroredPoints([{ x: 0, z: 0 }, { x: -islandX, z: -12.5 }]),
  hazardSlots,
  decor,
  atmosphere: {
    timeOfDay: 'dusk',
    // the sun sets behind the far end of the marsh: long backlit shadows toward the camera
    sunDir: [-0.34, 0.36, -0.87],
    // a lower, less orange sun and a bluer sky fill than Muckmire's: the moss stays green under it
    sunColor: 0xffb486,
    sunIntensity: 2.4,
    // a deep blue zenith: it fills the shadows with the reference's lavender and darkens the water's mirror
    skyTop: 0x22387c,
    skyHorizon: 0xff8a4e,
    groundAmbient: 0x26341f,
    ambientIntensity: 1.35,
    // a dark, thin dusk haze: the moss, the dark water and the lanterns read through it
    fogColor: 0x433c4c,
    fogDensity: 0.0072,
    weather: 'fireflies',
    aurora: false,
    // dark slate bayou water (the reference's), not Muckmire's olive: the sunset shows in it as glints
    waterShallow: 0x34403e,
    waterDeep: 0x0c1214,
    waterFoam: 0xf0d8c0,
    exposure: 1.06,
    saturation: 1.1,
    bloom: 0.75,
  },
  terrain: {
    // deep green moss mats (green-heavy so they stay green under the sunset), wet peat, black shore mud
    // (the reference's marsh, not a lawn)
    grass: [0x24581e, 0x2c6624, 0x1f4c1a, 0x36742a, 0x285e20, 0x3e7e30],
    dirt: [0x4a3826, 0x3e3020, 0x564230, 0x3a2c1e],
    bank: [0x2e2418, 0x3a2e1f, 0x261e14, 0x43352a],
    bed: [0x2a251b, 0x221e16, 0x332c21, 0x28221a],
    dryBed: [0x6a5840, 0x5c4d38, 0x766248, 0x524438, 0x635340],
    cliff: [0x4a4a3c, 0x55554a, 0x3e3f34],
    baseHeight: 1.2,
    noiseAmp: 0.15,
    noiseScale: 0.12,
    border: 'jungle',
  },
};
