// Player-driven movement. Shared by the server sim and the client's own-unit prediction,
// so it must give identical results for identical inputs.
import { BAL, UNIT_RADIUS } from '../constants.ts';
import { channelDepthAt, platformAt } from '../maps/helpers.ts';
import type { RiverState } from '../types.ts';
import { surfaceAt, type Surface, type World } from '../world.ts';

export interface MoveBody {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** under a deck, on the water or bed below it (see deckLayer) */
  under?: boolean;
}

/**
 * Deck layering. The sim is flat, so a dock, bridge or pier footprint is land for whoever walks onto it
 * from the bank (or climbs on from deep water or ice, which sit just under the deck). Whoever walks in
 * from a dry bed or a low tide, 1.5 to 3 m below the deck, stays UNDER it, on the bed. The layer holds
 * while the body stays inside the footprint over the channel, and clears anywhere else.
 * (px, pz) is the position before the move. Airborne or dragged bodies (grapple, hook) land on top.
 */
export function deckLayer(world: World, river: RiverState, b: MoveBody, px: number, pz: number, airborne = false): void {
  const map = world.map;
  if (!map.platforms || map.platforms.length === 0 || airborne) {
    b.under = false;
    return;
  }
  // over the bank (or an island), or out in the open channel: no layer
  if (channelDepthAt(map, b.x, b.z, true) <= 0 || !platformAt(map, b.x, b.z)) {
    b.under = false;
    return;
  }
  const prevOverChannel = channelDepthAt(map, px, pz, true) > 0;
  const prevOnDeck = !!platformAt(map, px, pz);
  if (prevOnDeck && prevOverChannel) return; // still inside the footprint: keep the layer
  // entering the footprint: from the open channel goes under it, unless the water is deep or frozen
  b.under = prevOverChannel && !prevOnDeck && !river.deep && !river.frozen;
}

const tmp = { x: 0, z: 0, hit: false };

/** Speed multiplier from the ground surface. */
export function surfaceSpeed(s: Surface): number {
  switch (s) {
    case 'shallow':
      return BAL.shallowSlow;
    case 'channelDry':
      return BAL.mudSlow;
    case 'deep':
      return BAL.swimSpeed;
    case 'ice':
      return 1.12;
    default:
      return 1;
  }
}

/**
 * Advance one body by dt with a desired move direction (mx, mz).
 * moveMul folds in family, items, buffs, slows and roots (0 = rooted).
 * Units standing on land can never walk into deep water. Units already in the water can swim out.
 */
export function stepMove(world: World, river: RiverState, b: MoveBody, mx: number, mz: number, moveMul: number, dt: number): Surface {
  const ml = Math.sqrt(mx * mx + mz * mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
  }
  const surface = surfaceAt(world, river, b.x, b.z, b.under);
  const speed = BAL.moveSpeed * moveMul * surfaceSpeed(surface);
  const tx = mx * speed;
  const tz = mz * speed;

  if (surface === 'ice') {
    const a = BAL.iceAccel * dt;
    let dvx = tx - b.vx;
    let dvz = tz - b.vz;
    const dl = Math.sqrt(dvx * dvx + dvz * dvz);
    if (dl > a) {
      dvx = (dvx / dl) * a;
      dvz = (dvz / dl) * a;
    }
    b.vx += dvx;
    b.vz += dvz;
    if (ml < 0.05) {
      const k = Math.exp(-BAL.iceFriction * dt);
      b.vx *= k;
      b.vz *= k;
    }
  } else {
    const a = BAL.accel * dt;
    let dvx = tx - b.vx;
    let dvz = tz - b.vz;
    const dl = Math.sqrt(dvx * dvx + dvz * dvz);
    if (dl > a) {
      dvx = (dvx / dl) * a;
      dvz = (dvz / dl) * a;
    }
    b.vx += dvx;
    b.vz += dvz;
  }

  const ox = b.x;
  const oz = b.z;
  let nx = ox + b.vx * dt;
  let nz = oz + b.vz * dt;

  const wasOnLand = world.channelFor(ox, oz, b.under) <= 0;
  if (river.deep && wasOnLand) {
    const res = blockWater(world, nx, nz);
    nx = res.x;
    nz = res.z;
  }

  world.resolveCircle(nx, nz, UNIT_RADIUS, tmp);
  nx = tmp.x;
  nz = tmp.z;
  if (river.deep && wasOnLand) {
    const res = blockWater(world, nx, nz);
    nx = res.x;
    nz = res.z;
  }

  // Velocity follows the real displacement so sliding along walls and edges feels right.
  if (dt > 0) {
    const rvx = (nx - ox) / dt;
    const rvz = (nz - oz) / dt;
    if (surface === 'ice') {
      // keep momentum unless something actually stopped us
      if (tmp.hit) {
        b.vx = rvx;
        b.vz = rvz;
      }
    } else {
      b.vx = rvx;
      b.vz = rvz;
    }
  }
  b.x = nx;
  b.z = nz;
  deckLayer(world, river, b, ox, oz);
  return surface;
}

const blk = { x: 0, z: 0 };

/** If (x,z) is inside the channel, project it back onto the bank edge. */
export function blockWater(world: World, x: number, z: number): { x: number; z: number } {
  let c = world.channel(x, z);
  blk.x = x;
  blk.z = z;
  let guard = 0;
  while (c > -0.001 && guard < 4) {
    const g = world.channelGradient(blk.x, blk.z);
    blk.x += g.nx * (c + 0.01);
    blk.z += g.nz * (c + 0.01);
    c = world.channel(blk.x, blk.z);
    guard++;
  }
  return blk;
}
