// Steering: turn the planned goal into a move direction every tick. Dodges override everything,
// juking makes a bot hard to read while it is exposed, and a set of filters keeps it out of deep
// water, hazards, the enemy fountain and walls (with a simple stuck detector as a last resort).
import { dist2 } from '../../math.ts';
import type { PlayerInput } from '../../types.ts';
import type { Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import type { BotContext } from './context.ts';
import { hazardHot, waterDir, type P2 } from './geom.ts';
import { standable } from './mapinfo.ts';
import { Mode, type Brain } from './types.ts';

const wd: P2 = { x: 0, z: 0 };
const ROT = [0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.5, -2.5];

function feelersClear(ctx: BotContext, u: Unit, dx: number, dz: number): boolean {
  return standable(ctx.info, u.x + dx * 0.8, u.z + dz * 0.8) && standable(ctx.info, u.x + dx * 1.5, u.z + dz * 1.5);
}

export function steer(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, input: PlayerInput): void {
  const t = sim.time;
  const tune = b.tune;
  let mx = 0;
  let mz = 0;
  if (t < b.dodgeUntil) {
    mx = b.dodgeX;
    mz = b.dodgeZ;
  } else if (t < b.detourUntil) {
    mx = b.detourX;
    mz = b.detourZ;
  } else if (!b.holdStill && !(b.intent && b.intent.purpose === 9)) {
    const gx = b.goalX - u.x;
    const gz = b.goalZ - u.z;
    const d = Math.sqrt(gx * gx + gz * gz);
    const arrive = b.mode === Mode.Push ? 1.5 : 0.35;
    if (d > arrive) {
      mx = gx / d;
      mz = gz / d;
      if (d < 1.2 && b.mode !== Mode.Push) {
        mx *= d / 1.2;
        mz *= d / 1.2;
      }
    }
    // Juke along the bank while a loaded enemy hook has a line to us (or while baiting a throw).
    const jukey = (b.exposed > 0 || t < b.baitUntil) && (b.mode === Mode.Hold || b.mode === Mode.Stranded) && d < 2.5 && u.activeHook < 0;
    if (jukey && tune.juke > 0) {
      if (t >= b.jukeUntil) {
        b.jukeDir = b.rng.next() < 0.5 ? -1 : 1;
        if (b.rng.next() > tune.juke) b.jukeDir = 0; // sometimes they just stand there
        b.jukeUntil = t + 0.2 + b.rng.next() * 0.5 * (1.3 - tune.juke);
      }
      if (b.jukeDir !== 0) {
        if ((u.z - b.goalZ) * b.jukeDir > 1.8) b.jukeDir = -b.jukeDir;
        mx = mx * 0.35;
        mz = mz * 0.35 + b.jukeDir;
      }
    }
  }
  let l = Math.sqrt(mx * mx + mz * mz);
  if (l > 1e-3) {
    if (l > 1) {
      mx /= l;
      mz /= l;
      l = 1;
    }
    // --- keep out of hazards ---
    for (const hz of sim.hazards) {
      if (!hazardHot(sim, hz, 1.3)) continue; // periodic vents are safe to cross between bursts
      const nx = u.x + mx * 1.2;
      const nz = u.z + mz * 1.2;
      const R = hz.r + 0.8;
      if (dist2(nx, nz, hz.x, hz.z) > R * R) continue;
      let rx = u.x - hz.x;
      let rz = u.z - hz.z;
      const rl = Math.sqrt(rx * rx + rz * rz) || 1;
      rx /= rl;
      rz /= rl;
      if (rl < hz.r + 0.4) {
        mx = rx; // inside: straight out
        mz = rz;
      } else {
        // slide around the edge on the side we were heading
        const s = mx * -rz + mz * rx >= 0 ? 1 : -1;
        mx = -rz * s * 0.85 + rx * 0.45;
        mz = rx * s * 0.85 + rz * 0.45;
      }
    }
    // --- keep off the enemy fountain unless finishing a kill ---
    if (!b.pushKill) {
      const f = sim.map.fountains[u.team === 0 ? 1 : 0];
      const R = f.r + 1.2;
      if (dist2(u.x + mx, u.z + mz, f.x, f.z) < R * R) {
        let rx = u.x - f.x;
        let rz = u.z - f.z;
        const rl = Math.sqrt(rx * rx + rz * rz) || 1;
        rx /= rl;
        rz /= rl;
        const dot = mx * rx + mz * rz;
        if (dot < 0) {
          mx -= rx * dot * 1.2;
          mz -= rz * dot * 1.2;
        }
      }
    }
    // --- never step toward water that is (or will soon be) deep ---
    const onLand = sim.world.channel(u.x, u.z) <= 0;
    const floodSoon = !sim.river.deep && ctx.untilDeep < tune.tideMargin + 2.5 && b.mode !== Mode.Push && b.mode !== Mode.Rune;
    if (onLand && (sim.river.deep || floodSoon || (b.mode === Mode.Hold && !b.crossing))) {
      if (sim.world.channel(u.x + mx * 0.9, u.z + mz * 0.9) > -0.25) {
        waterDir(sim, u.x, u.z, wd);
        const dot = mx * wd.x + mz * wd.z;
        if (dot > 0) {
          mx -= wd.x * dot;
          mz -= wd.z * dot;
        }
      }
    }
    // --- walls and trees: rotate the heading until the feelers are clear ---
    l = Math.sqrt(mx * mx + mz * mz);
    if (l > 0.15) {
      const ux = mx / l;
      const uz = mz / l;
      if (!feelersClear(ctx, u, ux, uz)) {
        for (let i = 0; i < ROT.length; i++) {
          const a = ROT[i] * (b.detourSide || 1);
          const c = Math.cos(a);
          const s = Math.sin(a);
          const rx = ux * c - uz * s;
          const rz = ux * s + uz * c;
          if (feelersClear(ctx, u, rx, rz)) {
            mx = rx * l;
            mz = rz * l;
            b.detourSide = a >= 0 ? 1 : -1;
            break;
          }
        }
      }
    } else {
      mx = 0;
      mz = 0;
    }
  }
  // --- stuck detector ---
  if (t >= b.stuckCheck) {
    const want = mx * mx + mz * mz > 0.4 && t >= b.dodgeUntil;
    const moved = dist2(u.x, u.z, b.stuckX, b.stuckZ);
    if (want && moved < 0.12) {
      b.stuckHits++;
      if (b.stuckHits >= 2) {
        const s = b.rng.next() < 0.5 ? 1 : -1;
        b.detourX = -mz * s;
        b.detourZ = mx * s;
        b.detourUntil = t + 0.5 + b.rng.next() * 0.4;
        b.detourSide = s;
        b.stuckHits = 0;
        b.nextPlan = t + 0.6;
      }
    } else b.stuckHits = 0;
    b.stuckX = u.x;
    b.stuckZ = u.z;
    b.stuckCheck = t + 0.5;
  }
  input.mx = mx;
  input.mz = mz;
}
