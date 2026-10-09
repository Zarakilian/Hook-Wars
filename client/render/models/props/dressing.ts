// Epic set dressing (cinematic only) for the four reference maps: the density the references show (refs 04
// to 07): more lanterns hanging from cranes, eaves, walls and dock posts, lit windows, hanging moss and vines,
// ropes, chains, crates and clutter.
//
// Nothing here changes collision or the map data:
//   - builders add their dressing inside their own model (ctx.dress), so it sits in the obstacle's footprint
//     or above the play (hanging from a jib, an eave, a wall)
//   - platforms add theirs under and beside the deck (spec.dress), never on the walkable planks
//   - extraDecor() returns visual-only ground clutter (low: ropes, chains, gears, shells), quay-edge chains and
//     water plants, never anything tall in the open that could read as an obstacle
// While cinematic is off dressingOn() is false and none of it is built (the normal tiers are unchanged).
import type { Decor, DecorKind, MapDef } from '../../../../shared/maps/types.ts';
import { channelDepthAt, clearOf, inCircles, platformAt } from '../../../../shared/maps/helpers.ts';
import { cinematicEnabled } from '../../cinematic.ts';
import { CH, h3, lampAt, mix, PGrid, rngFor, toModel, type CFn, type LAMP_KIND, type PropHalo, type PropLamp, type PropModel } from './common.ts';
import { ironCol, lanternCage, mats } from './kit.ts';

/** The four maps the references show. */
export const DRESSED_MAPS: ReadonlySet<string> = new Set(['lanternwharf', 'mirelight', 'aurora', 'maelstrom']);

/** True while cinematic mode is on and this map gets the Epic set dressing. */
export function dressingOn(map: Pick<MapDef, 'id'>): boolean {
  return cinematicEnabled() && DRESSED_MAPS.has(map.id);
}

/** Collects the lanterns a builder adds: halo pair and lamp per lantern. */
export class LampSet {
  readonly halos: PropHalo[] = [];
  readonly lamps: PropLamp[] = [];
  readonly pivot: [number, number, number];
  readonly V: number;
  constructor(pivot: [number, number, number], V: number) {
    this.pivot = pivot;
    this.V = V;
  }
  /**
   * A lantern with its glass centre at voxel c. `standoff` (model metres) moves only the light away from a
   * surface right next to the glass (a wall, a crate lid): a point light 0.1 to 0.3 m from a face burns it white.
   */
  add(c: [number, number, number], kind: keyof typeof LAMP_KIND, size = 1.8, warm = 0xffa040, standoff: [number, number, number] = [0, 0, 0]): void {
    const l = lampAt(c, this.pivot, this.V, kind);
    this.halos.push({ pos: l.pos, color: warm, size, opacity: 0.44 }, { pos: l.pos, color: 0xfff0c8, size: size * 0.32, opacity: 0.78 });
    this.lamps.push({ ...l, pos: [l.pos[0] + standoff[0], l.pos[1] + standoff[1], l.pos[2] + standoff[2]] });
  }
}

/** Iron chain down from (x, yTop, z), then a lantern cage (half size s, glass height h). Returns the glass centre. */
export function hangLantern(g: PGrid, x: number, yTop: number, z: number, chain: number, s: number, h: number, glow = 0xffc070): [number, number, number] {
  g.on(CH.metal, () => {
    for (let k = 0; k < chain; k++) g.set(x + (k % 2), yTop - k, z, k % 3 === 0 ? 0x4a4e56 : 0x30343a);
  });
  return lanternCage(g, x, yTop - chain - h - 3, z, s, h, glow);
}

/**
 * Epic: an iron lantern post at each end of a wall segment (refs 05 and 07 light their quay walls and fences),
 * in the wall's own frame (along +Z, centred, ground at y = 0). The post stands at the segment end inside the
 * wall body, so only its top and the lantern show above the cap, whatever shape the cap has.
 */
export function wallLanterns(length: number, h: number, seed: number): PropModel {
  const V = 0.05;
  const half = Math.round(length / 2 / V);
  const nz = half * 2 + 9;
  const top = Math.round((h + 0.32) / V);
  const g = new PGrid(9, top + 12, nz);
  const cx = 4;
  const zc = Math.floor(nz / 2);
  const pivot: [number, number, number] = [cx + 0.5, 0, zc + 0.5];
  const lamps = new LampSet(pivot, V);
  const iron = ironCol(seed, 0.12);
  for (const e of [-1, 1]) {
    const z = zc + e * half;
    g.on(CH.metal, () => g.box(cx, 0, z, cx + 1, top, z + 1, iron));
    lamps.add(lanternCage(g, cx, top + 1, z, 2, 4, h3(seed, e, 7) < 0.5 ? 0xffc070 : 0xffb860), 'lantern', 1.8, 0xffa040, [0, 0.3, 0]);
  }
  return { ...toModel(g, V, { [CH.metal]: mats.iron(), [CH.glow]: mats.lamp() }, { pivot }), halos: lamps.halos, lamps: lamps.lamps };
}

/** Pale spanish moss / dark vine strand from (x, y, z) straight down, wandering a little. */
export function strand(g: PGrid, x: number, y: number, z: number, len: number, col: CFn, rnd: () => number): void {
  let ox = 0;
  let oz = 0;
  for (let j = 0; j < len; j++) {
    if (j > 1 && rnd() < 0.25) (rnd() < 0.5 ? (ox += rnd() < 0.5 ? -1 : 1) : (oz += rnd() < 0.5 ? -1 : 1));
    if (g.solid(x + ox, y - j, z + oz)) break;
    g.set(x + ox, y - j, z + oz, col(x + ox, y - j, z + oz));
  }
}

/** Spanish moss colours (ref04): grey-green with paler tips. */
export const mossDrape: CFn = (x, y, z) => (h3(x, y, z, 31) < 0.3 ? 0x9aa47a : h3(x, y, z, 32) < 0.5 ? 0x7f8a62 : 0xb0b48c);
/** Jungle vine colours (ref06). */
export const vineCol: CFn = (x, y, z) => (h3(x, y, z, 41) < 0.25 ? 0x6aaa3a : h3(x, y, z, 42) < 0.5 ? 0x3e7a2a : 0x4f8a30);
/** Wet algae on piles and quay stones. */
export const algae = (c: number, x: number, y: number, z: number): number => mix(c, h3(x, y, z, 51) < 0.5 ? 0x3e5a26 : 0x4f6e2c, 0.6);

// ---------------------------------------------------------------------------------------------
// Extra decor: visual-only clutter in the same kinds the maps already use
// ---------------------------------------------------------------------------------------------

/**
 * Epic-only decor for the dressed maps: low ground clutter, quay-edge chains and ropes, water plants. Point
 * symmetric like the maps (each item has its mirror), deterministic, and clear of obstacles, decks and the
 * fountain plazas.
 */
export function extraDecor(map: MapDef): Decor[] {
  if (!dressingOn(map)) return [];
  const rnd = rngFor(map.id.length * 7919 + map.id.charCodeAt(0) * 31 + 17);
  const depth = (x: number, z: number) => channelDepthAt(map, x, z);
  const offDeck = (x: number, z: number) => !platformAt(map, x, z);
  const plazas = map.fountains.map((f) => ({ x: f.x, z: f.z, r: f.r + 0.8 }));
  const inside = (x: number, z: number, pad: number) => Math.abs(x) < map.w / 2 - pad && Math.abs(z) < map.d / 2 - pad;
  const free = (x: number, z: number, pad: number) => offDeck(x, z) && clearOf(map.obstacles, x, z, pad) && !inCircles(plazas, x, z) && inside(x, z, 0.8);
  const ground = (x: number, z: number) => depth(x, z) < -1.0 && free(x, z, 0.6);
  const quay = (x: number, z: number) => {
    const c = depth(x, z);
    return c > -1.6 && c < -0.4 && free(x, z, 0.35);
  };
  const shallow = (x: number, z: number) => {
    const c = depth(x, z);
    return c > 0.25 && c < 1.4 && free(x, z, 0.25);
  };
  const water = (x: number, z: number) => depth(x, z) > 0.6 && free(x, z, 0.3);
  const out: Decor[] = [];
  const add = (kind: DecorKind, count: number, accept: (x: number, z: number) => boolean, scale: [number, number]) => {
    let n = 0;
    for (let tries = 0; n < count && tries < count * 40; tries++) {
      // one half of the map (x < 0 or the left of the river), mirrored through the centre
      const x = -rnd() * (map.w / 2);
      const z = (rnd() - 0.5) * map.d;
      if (!accept(x, z) || !accept(-x, -z)) continue;
      const rot = rnd() * Math.PI * 2;
      const scale0 = scale[0] + rnd() * (scale[1] - scale[0]);
      const seed = Math.floor(rnd() * (1 << 30));
      out.push({ kind, x, z, rot, scale: scale0, seed }, { kind, x: -x, z: -z, rot: rot + Math.PI, scale: scale0, seed: seed + 1 });
      n++;
    }
  };
  switch (map.id) {
    case 'lanternwharf':
      add('chainhang', 5, quay, [0.85, 1.15]);
      add('rope', 6, quay, [0.8, 1.2]);
      add('gear', 6, ground, [0.6, 1.1]);
      add('pebbles', 10, ground, [0.5, 0.9]);
      break;
    case 'mirelight':
      add('lilypad', 22, water, [0.7, 1.2]);
      add('mushroom', 10, (x, z) => ground(x, z) && !clearOf(map.obstacles, x, z, 2.2), [0.7, 1.2]);
      add('reeds', 10, shallow, [0.7, 1.1]);
      break;
    case 'aurora':
      add('icicles', 6, quay, [0.8, 1.2]);
      add('chainhang', 3, quay, [0.85, 1.1]);
      add('pebbles', 8, ground, [0.5, 0.9]);
      break;
    case 'maelstrom':
      add('coralfan', 16, shallow, [0.7, 1.2]);
      add('seaweed', 10, water, [0.8, 1.2]);
      add('shell', 10, ground, [0.7, 1.2]);
      add('starfish', 6, ground, [0.7, 1.1]);
      break;
  }
  return out;
}

