// Lantern Wharf: a rainy night canal in a brick harbour town (reference: the lantern-lit quays with
// warehouses, stone arched bridges, dockside cranes with hanging cargo and barges). Two stone bridges
// cross the canal even in Deep Water: hold them, or hook whoever tries. Cranes, crate stacks and
// bollards give cover along the granite quays. Tidal mode: the lock gates flood and drain the canal.
// Point symmetric through (0, 0).
import { channelDepthAt, clearOf, inCircles, platformAt, scatter, withMirroredPoints, withMirrors } from './helpers.ts';
import type { Decor, HazardSlot, MapDef, Obstacle, Platform, RiverDef, RiverPoint } from './types.ts';

const W = 72;
const D = 48;
const HW = 4.7;

const points: RiverPoint[] = [];
for (let z = -D / 2 - 4; z <= D / 2 + 4; z += 4) points.push({ z, x: 0, hw: HW });
const river: RiverDef = { points, depth: 2.9, bank: 0.5, flow: 0.35 };
const islands: MapDef['islands'] = [];
const platforms: Platform[] = [
  // stone bridges spanning the whole canal, resting 1.5 m onto each quay
  { kind: 'bridge', x: 0, z: -10, w: 12.4, d: 3.2, rot: 0, seed: 1 },
  { kind: 'bridge', x: 0, z: 10, w: 12.4, d: 3.2, rot: 0, seed: 2 },
];
const fountains: MapDef['fountains'] = [{ x: -32, z: 0, r: 6.5 }, { x: 32, z: 0, r: 6.5 }];

const half: Obstacle[] = [
  // quayside: cranes with hanging cargo, gas lamps and bollards along the granite edge
  { shape: 'circle', kind: 'crane', x: -7.6, z: 2.8, r: 1.1, seed: 1 },
  { shape: 'circle', kind: 'gaslamp', x: -6.0, z: -4.2, r: 0.3, seed: 2 },
  { shape: 'circle', kind: 'bollard', x: -6.1, z: 6.4, r: 0.4, seed: 3 },
  { shape: 'circle', kind: 'bollard', x: -6.1, z: -1.2, r: 0.4, seed: 15 },
  { shape: 'circle', kind: 'gaslamp', x: -6.7, z: -12.2, r: 0.3, seed: 6 },
  { shape: 'circle', kind: 'gaslamp', x: -6.7, z: 12.2, r: 0.3, seed: 16 },
  { shape: 'circle', kind: 'barrel', x: -6.4, z: 18.4, r: 0.55, seed: 17 },
  // midfield cover
  { shape: 'circle', kind: 'cratepile', x: -9.8, z: -6.8, r: 1.0, seed: 4 },
  { shape: 'circle', kind: 'barrel', x: -9.0, z: 15.0, r: 0.55, seed: 5 },
  { shape: 'circle', kind: 'crate', x: -15.0, z: 4.0, r: 0.9, seed: 8 },
  { shape: 'circle', kind: 'cratepile', x: -12.6, z: 11.6, r: 1.0, seed: 18 },
  { shape: 'circle', kind: 'crane', x: -18.0, z: -15.0, r: 1.1, seed: 9 },
  { shape: 'circle', kind: 'barrel', x: -16.6, z: -6.2, r: 0.55, seed: 19 },
  // backfield: a brick warehouse front and a low brick wall
  { shape: 'wall', kind: 'warehouse', ax: -24, az: 9, bx: -24, bz: 16, r: 0.6, h: 4, seed: 10 },
  { shape: 'wall', kind: 'wall_brick', ax: -14, az: -18.4, bx: -10, bz: -18.4, r: 0.45, h: 1.8, seed: 11 },
  { shape: 'circle', kind: 'gaslamp', x: -21.6, z: -4.6, r: 0.3, seed: 12 },
  { shape: 'circle', kind: 'crate', x: -27.6, z: -16.4, r: 0.9, seed: 13 },
];
const obstacles = withMirrors(half);

const partial = { w: W, d: D, river, platforms, islands };
const depth = (x: number, z: number) => channelDepthAt(partial, x, z);
const plazas = fountains.map((f) => ({ x: f.x, z: f.z, r: f.r + 0.8 }));
const offDeck = (x: number, z: number) => !platformAt(partial, x, z);
const onGround = (x: number, z: number) =>
  depth(x, z) < -1.0 && offDeck(x, z) && clearOf(obstacles, x, z, 0.6) && Math.abs(x) < W / 2 - 1 && Math.abs(z) < D / 2 - 0.6 && !inCircles(plazas, x, z);
const quayEdge = (x: number, z: number) => { const c = depth(x, z); return c > -1.6 && c < -0.4 && offDeck(x, z) && clearOf(obstacles, x, z, 0.3); };

const decor: Decor[] = [
  ...scatter(partial, { kind: 'pebbles', count: 40, seed: 81, scale: [0.6, 1.1], accept: onGround }),
  ...scatter(partial, { kind: 'gear', count: 12, seed: 82, scale: [0.6, 1.2], accept: onGround }),
  ...scatter(partial, { kind: 'grass', count: 40, seed: 85, scale: [0.5, 0.9], accept: (x, z) => onGround(x, z) && Math.abs(x) > 10 }),
  ...scatter(partial, { kind: 'rope', count: 10, seed: 83, scale: [0.8, 1.2], accept: quayEdge }),
  ...scatter(partial, { kind: 'chainhang', count: 6, seed: 84, scale: [0.8, 1.2], accept: quayEdge }),
  { kind: 'lockgate', x: 0, z: -D / 2 + 1, rot: 0, scale: 1, seed: 1 },
  { kind: 'lockgate', x: 0, z: D / 2 - 1, rot: Math.PI, scale: 1, seed: 2 },
  { kind: 'lanternstring', x: 0, z: -10, rot: Math.PI / 2, scale: 1, seed: 3 },
  { kind: 'lanternstring', x: 0, z: 10, rot: Math.PI / 2, scale: 1, seed: 4 },
  { kind: 'cargonet', x: -7.6, z: 4.6, rot: 0, scale: 1, seed: 5 },
  { kind: 'cargonet', x: 7.6, z: -4.6, rot: Math.PI, scale: 1, seed: 6 },
  // ropes and chains on the bollards
  { kind: 'rope', x: -5.5, z: 6.4, rot: 0.3, scale: 1, seed: 7 },
  { kind: 'rope', x: 5.5, z: -6.4, rot: 0.3 + Math.PI, scale: 1, seed: 8 },
  { kind: 'chainhang', x: -5.5, z: -1.2, rot: 0, scale: 1, seed: 9 },
  { kind: 'chainhang', x: 5.5, z: 1.2, rot: Math.PI, scale: 1, seed: 10 },
  { kind: 'lantern', x: -5.6, z: 0.6, rot: 0, scale: 1, seed: 11 },
  { kind: 'lantern', x: 5.6, z: -0.6, rot: Math.PI, scale: 1, seed: 12 },
  { kind: 'lantern', x: -9.6, z: -8.6, rot: 0.4, scale: 0.9, seed: 13 },
  { kind: 'lantern', x: 9.6, z: 8.6, rot: 0.4 + Math.PI, scale: 0.9, seed: 14 },
  // more lamp light on the quays and round the crate stacks (the reference is lit by dozens of lamps)
  { kind: 'lantern', x: -6.2, z: -16.8, rot: 0.2, scale: 0.9, seed: 20 },
  { kind: 'lantern', x: 6.2, z: 16.8, rot: 0.2 + Math.PI, scale: 0.9, seed: 21 },
  { kind: 'lantern', x: -6.2, z: 9.0, rot: 0.0, scale: 0.9, seed: 22 },
  { kind: 'lantern', x: 6.2, z: -9.0, rot: 0.0 + Math.PI, scale: 0.9, seed: 23 },
  { kind: 'lantern', x: -13.9, z: 10.4, rot: 0.6, scale: 0.9, seed: 24 },
  { kind: 'lantern', x: 13.9, z: -10.4, rot: 0.6 + Math.PI, scale: 0.9, seed: 25 },
  { kind: 'lantern', x: -16.3, z: 4.9, rot: 1.1, scale: 0.9, seed: 26 },
  { kind: 'lantern', x: 16.3, z: -4.9, rot: 1.1 + Math.PI, scale: 0.9, seed: 27 },
  { kind: 'lantern', x: -17.4, z: -7.0, rot: 0.3, scale: 0.9, seed: 28 },
  { kind: 'lantern', x: 17.4, z: 7.0, rot: 0.3 + Math.PI, scale: 0.9, seed: 29 },
  { kind: 'lantern', x: -20.6, z: -14.0, rot: 0.9, scale: 0.9, seed: 30 },
  { kind: 'lantern', x: 20.6, z: 14.0, rot: 0.9 + Math.PI, scale: 0.9, seed: 31 },
  { kind: 'lantern', x: -22.6, z: 8.4, rot: 1.6, scale: 0.9, seed: 32 },
  { kind: 'lantern', x: 22.6, z: -8.4, rot: 1.6 + Math.PI, scale: 0.9, seed: 33 },
  { kind: 'sign', x: -24.8, z: 6.9, rot: Math.PI / 2, scale: 1, seed: 15 },
  { kind: 'sign', x: 24.8, z: -6.9, rot: -Math.PI / 2, scale: 1, seed: 16 },
  { kind: 'flag', x: -23.4, z: 16.6, rot: 0, scale: 1, seed: 17 },
  { kind: 'flag', x: 23.4, z: -16.6, rot: Math.PI, scale: 1, seed: 18 },
];

const hazardSlots: HazardSlot[] = withMirroredPoints([
  { x: 2.0, z: -4.0, r: 1.5, channel: true },
  { x: -1.6, z: 17.0, r: 1.5, channel: true },
  { x: 0, z: -10, r: 1.2, channel: false }, // a steam vent on the bridge itself
  { x: -12.0, z: -1.0, r: 1.4, channel: false },
  { x: -19.0, z: 8.0, r: 1.4, channel: false },
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
    // they shuttle between the two bridges: a bridge deck sits only 0.32 m above full water
    { kind: 'barge', r: 1.1, len: 4.6, lane: -0.42, speed: 1.2, offset: -4, range: [-4.6, 4.6], seed: 1 },
    { kind: 'barge', r: 1.1, len: 4.6, lane: 0.42, speed: -1.2, offset: 4, range: [-4.6, 4.6], seed: 2 },
  ],
  runeSpots: withMirroredPoints([{ x: 0, z: 0 }, { x: 0, z: -17 }]),
  hazardSlots,
  decor,
  atmosphere: {
    timeOfDay: 'night',
    // the moon sits behind the camera, as on Cogwater: in front of it, the rain-gloss ground mirrored it
    // into a fixed glare patch at the top right of the screen
    sunDir: [0.3, 0.55, 0.62],
    sunColor: 0x9cb0f0,
    // a dimmer moon than Cogwater's: the lamps, not the moon, light the wharf
    sunIntensity: 0.95,
    skyTop: 0x0a0d1a,
    skyHorizon: 0x34304c,
    groundAmbient: 0x3c2c22,
    ambientIntensity: 0.95,
    fogColor: 0x2a2c3a,
    fogDensity: 0.016,
    weather: 'rain',
    aurora: false,
    waterShallow: 0x34505e,
    waterDeep: 0x091316,
    waterFoam: 0xc0ccd0,
    exposure: 1.12,
    saturation: 0.98,
    bloom: 0.95,
  },
  terrain: {
    // rain-dark warm setts (the biome lays them in a running bond and adds the granite quay edge, steps,
    // mooring rings and wharf timber), a silted harbour-canal bed with green weed, black mud when drained
    grass: [0x5e5046, 0x6a5a4c, 0x54483e, 0x74624f, 0x5a4c40],
    dirt: [0x6e3c2c, 0x7a4432, 0x623628],
    bank: [0x8e8780, 0x837c74, 0x99928a],
    bed: [0x2a2a1e, 0x323224, 0x24241a],
    dryBed: [0x3e3e2c, 0x484632, 0x34342a, 0x524e38],
    cliff: [0x6e3c2c, 0x7a4432, 0x5c3226],
    baseHeight: 1.45,
    noiseAmp: 0.04,
    noiseScale: 0.2,
    border: 'wall',
  },
};
