// Player-driven movement. Shared by the server sim and the client's own-unit prediction,
// so it must give identical results for identical inputs.
import { BAL, UNIT_RADIUS } from '../constants.ts';
import type { RiverState } from '../types.ts';
import { surfaceAt, type Surface, type World } from '../world.ts';

export interface MoveBody {
  x: number;
  z: number;
  vx: number;
  vz: number;
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
  const surface = surfaceAt(world, river, b.x, b.z);
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

  const wasOnLand = world.channel(ox, oz) <= 0;
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
