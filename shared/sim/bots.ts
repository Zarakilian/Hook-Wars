// Bot brains. Bots act only through PlayerInput (the same path as humans) plus sim.buy / sim.upgrade.
// They see only what their team sees (stealth respected, enemies perceived with a reaction delay),
// never read enemy inputs, cooldowns, items or mines, and are deterministic for a given match seed.
//
// Layout (shared/sim/bots/):
//   context.ts  per-match blackboard: observed positions, public cooldown estimates, tide forecast
//   mapinfo.ts  static grids for cheap line-of-sight and walkability, cover and grapple anchors
//   roles.ts    Harpooner / Bruiser / Lifeguard and the per-difficulty tuning
//   plan.ts     where to stand; steer.ts how to get there; dodge.ts sidesteps and wind-up reads
//   combat.ts   hook shots, saves, runes, the hook-then-bash combo, grappling out of the water
//   dive.ts     bruiser grapple dives; items.ts shopping and consumables; brain.ts the per-tick loop
import type { Unit } from './entities.ts';
import type { GameSim } from './sim.ts';
import { createBrain, tickBot } from './bots/brain.ts';
import { contextFor } from './bots/context.ts';
import type { Brain, BotRole, BotStats, ModeId } from './bots/types.ts';
import type { PlayerInput } from '../types.ts';

export type { BotRole, BotStats } from './bots/types.ts';

/** Opt-in timing of updateBots (for tests and the debug overlay). Never affects decisions. */
export interface BotProfile {
  ticks: number;
  totalMs: number;
  maxMs: number;
}

let profiling = false;
const profile: BotProfile = { ticks: 0, totalMs: 0, maxMs: 0 };
const inputs = new WeakMap<Unit, PlayerInput>();

export function setBotProfiling(on: boolean): void {
  profiling = on;
}

export function botProfile(): BotProfile {
  return { ...profile };
}

export function resetBotProfile(): void {
  profile.ticks = 0;
  profile.totalMs = 0;
  profile.maxMs = 0;
}

function brainOf(sim: GameSim, u: Unit): Brain {
  const b = u.brain as Brain | null;
  if (b && b.diff === u.botDifficulty) return b;
  const nb = createBrain(sim, u);
  u.brain = nb;
  return nb;
}

/** Run every bot for this tick: each pushes exactly one PlayerInput into its unit's queue. */
export function updateBots(sim: GameSim): void {
  const t0 = profiling ? performance.now() : 0;
  let any = false;
  for (const u of sim.units) {
    if (u.isBot) {
      any = true;
      break;
    }
  }
  if (any) {
    const ctx = contextFor(sim);
    ctx.update();
    for (const u of sim.units) {
      if (!u.isBot) continue;
      const b = brainOf(sim, u);
      let input = inputs.get(u);
      if (!input) {
        input = { seq: 0, mx: 0, mz: 0, ax: u.input.ax, az: u.input.az, b: 0 };
        inputs.set(u, input);
      }
      input.seq = ++b.seq;
      tickBot(sim, ctx, u, b, input);
      u.queue.length = 0;
      u.queue.push(input);
    }
  }
  if (profiling) {
    const ms = performance.now() - t0;
    profile.ticks++;
    profile.totalMs += ms;
    if (ms > profile.maxMs) profile.maxMs = ms;
  }
}

/** Read-only view of a bot's brain, for tests and debug overlays. */
export function botInfo(u: Unit): { role: BotRole; mode: ModeId; goalX: number; goalZ: number; stats: BotStats } | null {
  const b = u.brain as Brain | null;
  if (!u.isBot || !b) return null;
  return { role: b.role, mode: b.mode, goalX: b.goalX, goalZ: b.goalZ, stats: b.stats };
}
