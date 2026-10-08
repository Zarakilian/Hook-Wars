// Bot navigation, built at runtime from the map: a 0.5 m walkability grid, connected components,
// A* with string pulling, and the bank model (where each team's main-river edge is, and how deep
// the dry strip behind it runs before the next side channel or pool).
//
// Nothing here is hard-coded per map. Docks, piers and bridges count as dry ground exactly like the
// sim's channelDepthAt; water follows the river state through two cached variants:
//   NAV_LAND  water is blocked (deep river, or holding the bank)
//   NAV_WADE  water is walkable, just slower (dry bed, low tide, ice)
// Static grids are cached per MapDef and shared by every match on that map. The per-bot path state
// lives in the Brain; searches are capped per tick by the BotContext so cost stays flat.
import { UNIT_RADIUS } from '../../constants.ts';
import { channelDepthAt, riverAt, waterDepthAt } from '../../maps/helpers.ts';
import type { MapDef } from '../../maps/types.ts';
import type { Team } from '../../types.ts';
import { mapInfo } from './mapinfo.ts';

export const NAV_CELL = 0.5;
export const NAV_LAND = 0;
export const NAV_WADE = 1;
export type NavVariant = 0 | 1;

/**
 * Dry-only paths keep unit centres this far from the water. Steering refuses to step where the
 * ground 0.9 m ahead is within 0.25 m of the water, so paths must stay a little inside that.
 */
const WATER_PAD = 0.35;
/** Most cells a single A* may expand before it settles for the closest node it found. */
const MAX_EXPAND = 7000;
/** Most waypoints kept per path (a long path is simply re-planned when its end is reached). */
export const NAV_MAXWP = 32;
const SQRT2 = Math.SQRT2;

export interface NavStatic {
  map: MapDef;
  nx: number;
  nz: number;
  ox: number;
  oz: number;
  inv: number;
  /** channelDepthAt at each cell centre (decks are dry). */
  depth: Float32Array;
  /** 1 where there is water (decks excluded, so this is "walking here means wading"). */
  wet: Uint8Array;
  /** Per variant: 1 where a unit centre may not path. */
  block: [Uint8Array, Uint8Array];
  /** Per variant: connected component of each free cell (-1 = blocked). */
  comp: [Int32Array, Int32Array];
  /** Per team, per row: x of the main-river bank edge (the water's edge facing the enemy). */
  edgeX: [Float32Array, Float32Array];
  /** Per team, per row: metres of dry ground behind the edge before water again (0 = no bank). */
  frontLen: [Float32Array, Float32Array];
  /** Per team: the NAV_LAND component its spawns stand in (-1 if none): "home ground". */
  homeComp: [number, number];
}

const cache = new WeakMap<MapDef, NavStatic>();

function labelComponents(nx: number, nz: number, free: (i: number) => boolean, out: Int32Array, queue: Int32Array): void {
  out.fill(-1);
  let label = 0;
  const n = nx * nz;
  for (let s = 0; s < n; s++) {
    if (out[s] !== -1 || !free(s)) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    out[s] = label;
    while (head < tail) {
      const i = queue[head++];
      const ix = i % nx;
      const iz = (i - ix) / nx;
      if (ix > 0 && out[i - 1] === -1 && free(i - 1)) { out[i - 1] = label; queue[tail++] = i - 1; }
      if (ix < nx - 1 && out[i + 1] === -1 && free(i + 1)) { out[i + 1] = label; queue[tail++] = i + 1; }
      if (iz > 0 && out[i - nx] === -1 && free(i - nx)) { out[i - nx] = label; queue[tail++] = i - nx; }
      if (iz < nz - 1 && out[i + nx] === -1 && free(i + nx)) { out[i + nx] = label; queue[tail++] = i + nx; }
    }
    label++;
  }
}

/** Build (or fetch) the static navigation data for a map. */
export function navStatic(map: MapDef): NavStatic {
  const hit = cache.get(map);
  if (hit) return hit;
  const info = mapInfo(map);
  const nx = info.nx;
  const nz = info.nz;
  const ox = info.ox;
  const oz = info.oz;
  const n = nx * nz;
  const depth = new Float32Array(n);
  const water = new Float32Array(n); // waterDepthAt: where the water really is (decks do not count)
  const wet = new Uint8Array(n);
  const dryLand = new Uint8Array(n); // waterDepthAt <= 0: real ground, decks are not ground here
  const decks = !!map.platforms && map.platforms.length > 0;
  for (let iz = 0; iz < nz; iz++) {
    const z = oz + (iz + 0.5) * NAV_CELL;
    for (let ix = 0; ix < nx; ix++) {
      const x = ox + (ix + 0.5) * NAV_CELL;
      const i = ix + iz * nx;
      const w = waterDepthAt(map, x, z);
      water[i] = w;
      // decks only ever lower the depth, so away from the water's edge they change nothing we test
      const d = decks && w > -WATER_PAD - 0.05 ? channelDepthAt(map, x, z) : w;
      depth[i] = d;
      if (d > 0) wet[i] = 1;
      if (w <= 0) dryLand[i] = 1;
    }
  }
  const walk = info.walkGrid;
  const blockLand = new Uint8Array(n);
  const blockWade = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    blockWade[i] = walk[i];
    blockLand[i] = walk[i] || depth[i] > -WATER_PAD ? 1 : 0;
  }
  const queue = new Int32Array(n);
  const compLand = new Int32Array(n);
  const compWade = new Int32Array(n);
  labelComponents(nx, nz, (i) => blockLand[i] === 0, compLand, queue);
  labelComponents(nx, nz, (i) => blockWade[i] === 0, compWade, queue);

  // Bank model. "Our bank" is dry ground our fountain can walk to: decks count as links (a dock over
  // a side channel joins the forward strip to the home bank) but not as bank themselves, so a floe,
  // an island or a pier standing in the river is never mistaken for the edge.
  const ground = new Int32Array(n);
  labelComponents(nx, nz, (i) => depth[i] <= 0, ground, queue);
  const cellOf = (x: number, z: number): number => {
    const ix = Math.floor((x - ox) / NAV_CELL);
    const iz = Math.floor((z - oz) / NAV_CELL);
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return -1;
    return ix + iz * nx;
  };
  const home: [number, number] = [-1, -1];
  for (const t of [0, 1] as const) {
    const f = map.fountains[t];
    const c = cellOf(f.x, f.z);
    home[t] = c >= 0 ? ground[c] : -1;
  }
  const edgeX: [Float32Array, Float32Array] = [new Float32Array(nz), new Float32Array(nz)];
  const frontLen: [Float32Array, Float32Array] = [new Float32Array(nz), new Float32Array(nz)];
  const halfW = map.w / 2;
  const limX = halfW - UNIT_RADIUS - 0.2;
  // Scan each row on the cell grid; the water depth is a signed distance, so the exact edge sits
  // where it crosses zero between two cell centres.
  const cross = (xa: number, wa: number, xb: number, wb: number): number => (wa === wb ? xb : xa + ((xb - xa) * wa) / (wa - wb));
  for (let iz = 0; iz < nz; iz++) {
    const z = oz + (iz + 0.5) * NAV_CELL;
    const r = riverAt(map.river.points, z);
    const row = iz * nx;
    const c0 = Math.max(0, Math.min(nx - 1, Math.floor((r.x - ox) / NAV_CELL)));
    for (const t of [0, 1] as const) {
      const side = t === 0 ? -1 : 1;
      let seenWater = false;
      let edge = NaN;
      let ix = c0;
      for (; ix >= 0 && ix < nx; ix += side) {
        const x = ox + (ix + 0.5) * NAV_CELL;
        if (Math.abs(x) > halfW - 0.5) break;
        const i = row + ix;
        if (water[i] > 0) {
          seenWater = true;
          continue;
        }
        if (!seenWater) {
          if (Math.abs(x - r.x) > r.hw + 3) break; // no water on this row at all
          continue; // an island on the centreline
        }
        if (home[t] >= 0 && ground[i] !== home[t]) continue; // an island cut off by water, not our bank
        const p = i - side;
        edge = water[p] > 0 ? cross(x - side * NAV_CELL, water[p], x, water[i]) : x;
        break;
      }
      if (!Number.isFinite(edge)) {
        edgeX[t][iz] = r.x + side * r.hw;
        frontLen[t][iz] = 0;
        continue;
      }
      let last = edge;
      for (ix += side; ix >= 0 && ix < nx; ix += side) {
        const x = ox + (ix + 0.5) * NAV_CELL;
        const i = row + ix;
        if (Math.abs(x) > limX) {
          last = side * limX;
          break;
        }
        if (water[i] > 0) {
          last = cross(x - side * NAV_CELL, water[i - side], x, water[i]);
          break;
        }
        last = x;
      }
      edgeX[t][iz] = edge;
      frontLen[t][iz] = Math.max(0, (last - edge) * side);
    }
  }
  const ns: NavStatic = {
    map, nx, nz, ox, oz, inv: 1 / NAV_CELL, depth, wet,
    block: [blockLand, blockWade], comp: [compLand, compWade], edgeX, frontLen, homeComp: [-1, -1],
  };
  for (const t of [0, 1] as const) {
    // the component most of the team's spawns stand in (the fountain if the spawns say nothing)
    let best = -1;
    let bestN = 0;
    const sp = map.spawns[t];
    for (const a of sp) {
      const c = compAt(ns, NAV_LAND, a.x, a.z, 4);
      if (c < 0) continue;
      let k = 0;
      for (const o of sp) if (compAt(ns, NAV_LAND, o.x, o.z, 4) === c) k++;
      if (k > bestN) {
        bestN = k;
        best = c;
      }
    }
    if (best < 0) best = compAt(ns, NAV_LAND, map.fountains[t].x, map.fountains[t].z, 6);
    ns.homeComp[t] = best;
  }
  cache.set(map, ns);
  return ns;
}

export function navCell(ns: NavStatic, x: number, z: number): number {
  const ix = Math.floor((x - ns.ox) * ns.inv);
  const iz = Math.floor((z - ns.oz) * ns.inv);
  if (ix < 0 || iz < 0 || ix >= ns.nx || iz >= ns.nz) return -1;
  return ix + iz * ns.nx;
}

function rowOf(ns: NavStatic, z: number): number {
  const iz = Math.floor((z - ns.oz) * ns.inv);
  return iz < 0 ? 0 : iz >= ns.nz ? ns.nz - 1 : iz;
}

// ---------------------------------------------------------------------------------------------
// Bank model
// ---------------------------------------------------------------------------------------------

/** x of `team`'s main-river bank edge at depth z. */
export function mainEdgeX(ns: NavStatic, team: Team, z: number): number {
  return ns.edgeX[team][rowOf(ns, z)];
}

/**
 * Metres a point sits behind `team`'s main-river edge, measured along x, if it is on that team's
 * front strip (between the main river and the next water behind it). -1 when it is not.
 */
export function holdDepth(ns: NavStatic, team: Team, x: number, z: number): number {
  const iz = rowOf(ns, z);
  const L = ns.frontLen[team][iz];
  if (L <= 0) return -1;
  const s = (x - ns.edgeX[team][iz]) * (team === 0 ? -1 : 1);
  return s >= 0 && s <= L ? s : -1;
}

/** Usable depth of the front strip at z (metres behind the edge a holder may stand). */
export function stripDepth(ns: NavStatic, team: Team, z: number): number {
  return ns.frontLen[team][rowOf(ns, z)];
}

/**
 * A spot on `team`'s front strip at depth z, `s` metres back from the main river (clamped so it
 * never lands past the strip). Returns false where the row has no usable strip.
 */
export function holdPoint(ns: NavStatic, team: Team, z: number, s: number, out: { x: number; z: number }): boolean {
  const iz = rowOf(ns, z);
  const L = ns.frontLen[team][iz] - 0.7;
  if (L < 1.2) return false;
  const ss = s > L ? L : s < 0.6 ? 0.6 : s;
  out.x = ns.edgeX[team][iz] + (team === 0 ? -ss : ss);
  out.z = z;
  return true;
}

/** Signed metres from `team`'s main-river edge at depth z, positive on the dry side (away from the river). */
export function edgeDist(ns: NavStatic, team: Team, x: number, z: number): number {
  return (x - ns.edgeX[team][rowOf(ns, z)]) * (team === 0 ? -1 : 1);
}

/**
 * Where `team` can hold at depth z, `s` metres back from the water in front of it, standing in walk
 * component `comp` (of NAV_LAND; -1 = any). Normally that is the forward strip on the main river.
 * When the strip is cut off (no dock, or the bot is stuck behind a side channel), it is the first
 * ground behind the channel that `comp` can stand on, so a bot never paths to a spot it cannot reach.
 * The spot stays at least 0.5 m clear of the water behind it. Returns false where nothing fits.
 */
export function holdSpot(ns: NavStatic, team: Team, z: number, s: number, comp: number, out: { x: number; z: number }): boolean {
  const iz = rowOf(ns, z);
  const side = team === 0 ? -1 : 1;
  const block = ns.block[NAV_LAND];
  const cmp = ns.comp[NAV_LAND];
  const zc = ns.oz + (iz + 0.5) * NAV_CELL;
  const lim = ns.map.w / 2 - 1;
  const ex = ns.edgeX[team][iz];
  let first = NaN;
  for (let k = 0; k < ns.nx; k++) {
    const x = ex + side * k * NAV_CELL;
    if (Math.abs(x) > lim) break;
    const c = navCell(ns, x, zc);
    if (c < 0) break;
    if (block[c] === 0 && (comp < 0 || cmp[c] === comp)) {
      first = x;
      break;
    }
  }
  if (!Number.isFinite(first)) return false;
  const onStrip = Math.abs(first - ex) < 1.2;
  const edge = onStrip ? ex : first - side * 0.45;
  let depth: number;
  if (onStrip) depth = ns.frontLen[team][iz]; // the forward strip: measured once per map
  else {
    // dry run behind the channel (obstacles do not end it: the caller nudges spots off trees and rocks)
    let last = first;
    for (let k = 1; k < ns.nx; k++) {
      const x = first + side * k * NAV_CELL;
      if (Math.abs(x) > lim) break;
      const c = navCell(ns, x, zc);
      if (c < 0 || ns.depth[c] > -WATER_PAD) break;
      last = x;
    }
    depth = Math.abs(last - edge);
  }
  const maxS = depth - 0.5;
  if (maxS < 0.9) return false;
  const ss = s > maxS ? maxS : s < 0.9 ? 0.9 : s;
  out.x = edge + side * ss;
  out.z = z;
  return true;
}

/** Walk component (of variant v) of the free cell nearest (x, z) within R cells, -1 if none. */
export function compAt(ns: NavStatic, v: NavVariant, x: number, z: number, R = 3): number {
  const c = navCell(ns, x, z);
  if (c < 0) return -1;
  if (ns.block[v][c] === 0) return ns.comp[v][c];
  const f = snapFree(ns, v, c, R, -1);
  return f < 0 ? -1 : ns.comp[v][f];
}

/** True if (x, z) is free on variant v and in walk component `comp`. */
export function inComp(ns: NavStatic, v: NavVariant, x: number, z: number, comp: number): boolean {
  const c = navCell(ns, x, z);
  return c >= 0 && ns.block[v][c] === 0 && ns.comp[v][c] === comp;
}

let bfsQ = new Int32Array(0);
let bfsD = new Float32Array(0);
let bfsSeen = new Uint32Array(0);
let bfsStamp = 0;

/**
 * Nearest dry ground (free on NAV_LAND) from a unit wading in the water, by a breadth-first walk over
 * wadeable cells. Prefers ground on `team`'s side of the main river when it is at most `bias` metres
 * further. Writes the cell centre to out and returns the walking distance in metres (Infinity if none
 * within `maxM`). Used when the tide turns: get out of whichever channel we stand in, not only the main one.
 */
export function nearestDry(ns: NavStatic, x: number, z: number, team: Team, bias: number, maxM: number, out: { x: number; z: number }): number {
  const n = ns.nx * ns.nz;
  if (bfsQ.length < n) {
    bfsQ = new Int32Array(n);
    bfsD = new Float32Array(n);
    bfsSeen = new Uint32Array(n);
    bfsStamp = 0;
  }
  const st = ++bfsStamp;
  let s = navCell(ns, x, z);
  if (s < 0) return Infinity;
  const wade = ns.block[NAV_WADE];
  const land = ns.block[NAV_LAND];
  if (wade[s] === 1) s = snapFree(ns, NAV_WADE, s, 3, -1);
  if (s < 0) return Infinity;
  const nx = ns.nx;
  let head = 0;
  let tail = 0;
  bfsQ[tail++] = s;
  bfsD[s] = 0;
  bfsSeen[s] = st;
  let anyD = Infinity;
  let anyC = -1;
  let ownD = Infinity;
  let ownC = -1;
  const pts = ns.map.river.points;
  while (head < tail) {
    const i = bfsQ[head++];
    const d = bfsD[i];
    if (d > maxM || d > ownD || d > anyD + bias) break;
    const ix = i % nx;
    const iz = (i - ix) / nx;
    if (land[i] === 0) {
      const cx = ns.ox + (ix + 0.5) * NAV_CELL;
      const cz = ns.oz + (iz + 0.5) * NAV_CELL;
      const own = (cx < riverAt(pts, cz).x ? 0 : 1) === team;
      if (own && d < ownD) {
        ownD = d;
        ownC = i;
      }
      if (d < anyD) {
        anyD = d;
        anyC = i;
      }
      continue; // do not walk on through dry ground
    }
    for (let k = 0; k < 4; k++) {
      const jx = ix + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const jz = iz + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (jx < 0 || jz < 0 || jx >= nx || jz >= ns.nz) continue;
      const j = jx + jz * nx;
      if (bfsSeen[j] === st || wade[j] === 1) continue;
      bfsSeen[j] = st;
      bfsD[j] = d + NAV_CELL;
      bfsQ[tail++] = j;
    }
  }
  const c = ownC >= 0 && ownD <= anyD + bias ? ownC : anyC;
  if (c < 0) return Infinity;
  const cx = c % nx;
  out.x = ns.ox + (cx + 0.5) * NAV_CELL;
  out.z = ns.oz + ((c - cx) / nx + 0.5) * NAV_CELL;
  return c === ownC ? ownD : anyD;
}

// ---------------------------------------------------------------------------------------------
// Line tests and snapping
// ---------------------------------------------------------------------------------------------

/**
 * True if a unit centre can walk the straight segment on this variant. Blocked cells within `lead`
 * metres of either end are tolerated (a unit pressed against a bank edge, a goal beside a post).
 * Exact grid traversal, so it never slips diagonally between two blocked cells.
 */
export function lineWalk(ns: NavStatic, v: NavVariant, x0: number, z0: number, x1: number, z1: number, lead = 0.6): boolean {
  const block = ns.block[v];
  const nx = ns.nx;
  const nz = ns.nz;
  const inv = ns.inv;
  const fx0 = (x0 - ns.ox) * inv;
  const fz0 = (z0 - ns.oz) * inv;
  const fx1 = (x1 - ns.ox) * inv;
  const fz1 = (z1 - ns.oz) * inv;
  let ix = Math.floor(fx0);
  let iz = Math.floor(fz0);
  const ex = Math.floor(fx1);
  const ez = Math.floor(fz1);
  const dx = fx1 - fx0;
  const dz = fz1 - fz0;
  const len = Math.sqrt(dx * dx + dz * dz); // in cells
  const leadC = lead * inv;
  const sx = dx > 0 ? 1 : -1;
  const sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx !== 0 ? (dx > 0 ? ix + 1 - fx0 : fx0 - ix) * tdx : Infinity;
  let tmz = dz !== 0 ? (dz > 0 ? iz + 1 - fz0 : fz0 - iz) * tdz : Infinity;
  let t = 0;
  for (let guard = 0; guard < 2048; guard++) {
    const along = t * len;
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) {
      if (along > leadC && along < len - leadC) return false;
    } else if (block[ix + iz * nx] === 1 && along > leadC && (len - along) > leadC) return false;
    if (ix === ex && iz === ez) return true;
    if (tmx < tmz) {
      t = tmx;
      tmx += tdx;
      ix += sx;
    } else {
      t = tmz;
      tmz += tdz;
      iz += sz;
    }
    if (t > 1 + 1e-9) return true;
  }
  return true;
}

/** Nearest free cell to `c` within `R` cells (optionally in component `want`), or -1. */
function snapFree(ns: NavStatic, v: NavVariant, c: number, R: number, want: number): number {
  const block = ns.block[v];
  const comp = ns.comp[v];
  const nx = ns.nx;
  const cx = c % nx;
  const cz = (c - cx) / nx;
  let best = -1;
  let bd = Infinity;
  for (let dz = -R; dz <= R; dz++) {
    const z = cz + dz;
    if (z < 0 || z >= ns.nz) continue;
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= nx) continue;
      const i = x + z * nx;
      if (block[i] === 1 || (want >= 0 && comp[i] !== want)) continue;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
  }
  return best;
}

/** Can a unit at (x0, z0) reach (x1, z1) on foot on this variant (same connected component)? */
export function navReachable(ns: NavStatic, v: NavVariant, x0: number, z0: number, x1: number, z1: number): boolean {
  let a = navCell(ns, x0, z0);
  let b = navCell(ns, x1, z1);
  if (a < 0 || b < 0) return false;
  if (ns.block[v][a] === 1) a = snapFree(ns, v, a, 4, -1);
  if (a < 0) return false;
  const want = ns.comp[v][a];
  if (ns.block[v][b] === 1 || ns.comp[v][b] !== want) b = snapFree(ns, v, b, 4, want);
  return b >= 0;
}

// ---------------------------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------------------------

let cap = 0;
let gScore = new Float32Array(0);
let parent = new Int32Array(0);
let seenAt = new Uint32Array(0);
let closedAt = new Uint32Array(0);
let cells = new Int32Array(0);
let stamp = 0;
const HEAP_CAP = 1 << 16;
const heapI = new Int32Array(HEAP_CAP);
const heapF = new Float32Array(HEAP_CAP);
let heapN = 0;

function ensure(n: number): void {
  if (cap >= n) return;
  cap = n;
  gScore = new Float32Array(n);
  parent = new Int32Array(n);
  seenAt = new Uint32Array(n);
  closedAt = new Uint32Array(n);
  cells = new Int32Array(n);
  stamp = 0;
}

function heapPush(i: number, f: number): void {
  if (heapN >= HEAP_CAP) return;
  let k = heapN++;
  while (k > 0) {
    const p = (k - 1) >> 1;
    if (heapF[p] <= f) break;
    heapI[k] = heapI[p];
    heapF[k] = heapF[p];
    k = p;
  }
  heapI[k] = i;
  heapF[k] = f;
}

function heapPop(): number {
  const top = heapI[0];
  const li = heapI[--heapN];
  const lf = heapF[heapN];
  let k = 0;
  for (;;) {
    let c = 2 * k + 1;
    if (c >= heapN) break;
    if (c + 1 < heapN && heapF[c + 1] < heapF[c]) c++;
    if (heapF[c] >= lf) break;
    heapI[k] = heapI[c];
    heapF[k] = heapF[c];
    k = c;
  }
  heapI[k] = li;
  heapF[k] = lf;
  return top;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

/** Scratch result of findPath: waypoints in world metres. */
export interface NavPath {
  wp: Float32Array; // x0, z0, x1, z1, ...
  n: number;
  /** cells A* expanded (for tests and tuning) */
  expanded: number;
  /** the goal was reached (false: the path ends at the closest point found) */
  complete: boolean;
}

export function newNavPath(): NavPath {
  return { wp: new Float32Array(NAV_MAXWP * 2), n: 0, expanded: 0, complete: false };
}

/**
 * A* from (x0, z0) to (x1, z1) on a variant, then string-pull the cell path into at most NAV_MAXWP
 * waypoints. `waterMul` is the cost of a wet cell relative to dry ground (NAV_WADE only), `keepOut`
 * a circle to stay out of when there is any other way (the enemy fountain), `avoid`
 * an optional per-cell flag (hazards) that costs extra. Deterministic and allocation-free.
 */
export function findPath(
  ns: NavStatic, v: NavVariant, x0: number, z0: number, x1: number, z1: number, waterMul: number, avoid: Uint8Array | null, out: NavPath,
  keepOut: { x: number; z: number; r: number } | null = null,
): boolean {
  out.n = 0;
  out.expanded = 0;
  out.complete = false;
  const block = ns.block[v];
  const comp = ns.comp[v];
  const wet = ns.wet;
  const nx = ns.nx;
  const nz = ns.nz;
  let s = navCell(ns, x0, z0);
  let g = navCell(ns, x1, z1);
  if (s < 0 || g < 0) return false;
  if (block[s] === 1) s = snapFree(ns, v, s, 4, -1);
  if (s < 0) return false;
  const want = comp[s];
  let snappedGoal = false;
  if (block[g] === 1 || comp[g] !== want) {
    g = snapFree(ns, v, g, 8, want);
    snappedGoal = true;
    if (g < 0) return false;
  }
  ensure(nx * nz);
  stamp++;
  if (stamp >= 0xfffffff0) {
    seenAt.fill(0);
    closedAt.fill(0);
    stamp = 1;
  }
  const st = stamp;
  const gx = g % nx;
  const gz = (g - gx) / nx;
  const wm = v === NAV_WADE ? waterMul - 1 : 0;
  heapN = 0;
  gScore[s] = 0;
  parent[s] = -1;
  seenAt[s] = st;
  const h0 = octile(s % nx, (s - (s % nx)) / nx, gx, gz);
  heapPush(s, h0);
  let bestNode = s;
  let bestH = h0;
  let found = false;
  let expanded = 0;
  while (heapN > 0) {
    const i = heapPop();
    if (closedAt[i] === st) continue;
    closedAt[i] = st;
    if (i === g) {
      found = true;
      break;
    }
    if (++expanded > MAX_EXPAND) break;
    const ix = i % nx;
    const iz = (i - ix) / nx;
    const gi = gScore[i];
    for (let k = 0; k < 8; k++) {
      const jx = ix + DX[k];
      const jz = iz + DZ[k];
      if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
      const j = jx + jz * nx;
      if (block[j] === 1 || closedAt[j] === st) continue;
      if (k >= 4 && (block[jx + iz * nx] === 1 || block[ix + jz * nx] === 1)) continue; // no corner cutting
      let c = k >= 4 ? SQRT2 : 1;
      let mul = 1;
      if (wm !== 0 && wet[j] === 1) mul += wm;
      if (avoid !== null && avoid[j] === 1) mul += 3;
      if (keepOut !== null) {
        const kx = ns.ox + (jx + 0.5) * NAV_CELL - keepOut.x;
        const kz = ns.oz + (jz + 0.5) * NAV_CELL - keepOut.z;
        if (kx * kx + kz * kz < keepOut.r * keepOut.r) mul += 12;
      }
      c *= mul;
      const ng = gi + c;
      if (seenAt[j] === st && ng >= gScore[j]) continue;
      seenAt[j] = st;
      gScore[j] = ng;
      parent[j] = i;
      const h = octile(jx, jz, gx, gz);
      if (h < bestH) {
        bestH = h;
        bestNode = j;
      }
      heapPush(j, ng + h);
    }
  }
  out.expanded = expanded;
  const end = found ? g : bestNode;
  // walk back to the start
  let n = 0;
  for (let c = end; c >= 0 && n < cells.length; c = parent[c]) cells[n++] = c;
  if (n === 0) return false;
  // cells[n-1] is the start; reverse into forward order
  for (let a = 0, b2 = n - 1; a < b2; a++, b2--) {
    const tmp = cells[a];
    cells[a] = cells[b2];
    cells[b2] = tmp;
  }
  // string pulling: from the anchor, keep the farthest cell centre still in a straight walkable line
  const cx = (c: number): number => ns.ox + ((c % nx) + 0.5) * NAV_CELL;
  const cz = (c: number): number => ns.oz + (((c - (c % nx)) / nx) + 0.5) * NAV_CELL;
  let ax = x0;
  let az = z0;
  let anchor = -1;
  let last = 0;
  let k = 1;
  let truncated = false;
  while (k < n) {
    if (lineWalk(ns, v, ax, az, cx(cells[k]), cz(cells[k]), 0.45)) {
      last = k;
      k++;
      continue;
    }
    // even the next cell is not a clean line (we start pressed into a corner): take it anyway
    if (last <= anchor || (anchor < 0 && last === 0)) last = Math.min(n - 1, Math.max(anchor + 1, 1));
    if (out.n >= NAV_MAXWP - 1) {
      truncated = true;
      break;
    }
    const c = cells[last];
    ax = cx(c);
    az = cz(c);
    out.wp[out.n * 2] = ax;
    out.wp[out.n * 2 + 1] = az;
    out.n++;
    anchor = last;
    k = last + 1;
  }
  // final point: the real goal when we reached it, else the last cell we got to
  if (!truncated) {
    out.wp[out.n * 2] = found && !snappedGoal ? x1 : cx(end);
    out.wp[out.n * 2 + 1] = found && !snappedGoal ? z1 : cz(end);
    out.n++;
  }
  out.complete = found && !truncated;
  return true;
}

function octile(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dz = az > bz ? az - bz : bz - az;
  return dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx;
}

/** Path length in metres along a NavPath from (x0, z0), for tests and estimates. */
export function pathLength(p: NavPath, x0: number, z0: number): number {
  let L = 0;
  let x = x0;
  let z = z0;
  for (let i = 0; i < p.n; i++) {
    const wx = p.wp[i * 2];
    const wz = p.wp[i * 2 + 1];
    L += Math.hypot(wx - x, wz - z);
    x = wx;
    z = wz;
  }
  return L;
}
