// One bot's tick: bookkeeping, then (in priority order) wind-up aiming, water escape, the hook
// combo, dodging, decisions at the bot's think rate, positioning at its plan rate, and steering.
// Only ever writes a PlayerInput; shopping goes through sim.buy / sim.upgrade.
import { hash01, Rng } from '../../math.ts';
import { Btn, UnitState, type PlayerInput } from '../../types.ts';
import type { Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import { comboWatch, escapeWater, holdAim, runIntent, thinkBash, thinkGrappleHome, thinkHook } from './combat.ts';
import type { BotContext } from './context.ts';
import { checkDodge, JUDGED } from './dodge.ts';
import { shop, trapStep, useItems } from './items.ts';
import { plan } from './plan.ts';
import { assignRole, ROLES, tuningFor } from './roles.ts';
import { steer } from './steer.ts';
import { Mode, type Brain } from './types.ts';
import { diveFollowUp, thinkDive } from './dive.ts';

const CAST_BITS = Btn.Hook | Btn.Grapple | Btn.Bash;

export function createBrain(sim: GameSim, u: Unit): Brain {
  const role = assignRole(sim.units, u);
  const roleDef = ROLES[role];
  const tune = tuningFor(u.botDifficulty);
  const seed = Math.floor(hash01(sim.seed, u.id, 0x5eed) * 4294967296) >>> 0;
  const rng = new Rng(seed);
  const phase = rng.next() / tune.thinkHz;
  const t = sim.time;
  return {
    role, roleDef, diff: u.botDifficulty, tune, rng, seq: u.input.seq, phase,
    nextThink: t + phase, nextPlan: t + rng.next() / tune.planHz, nextShop: t + rng.next() * 0.5, buildIdx: 0,
    build: sim.config.riverMode === 'dry' ? roleDef.buildDry : roleDef.build,
    mode: Mode.Hold, goalX: u.x, goalZ: u.z, goalScore: 0, laneZ: u.z, exposed: 0, jukeDir: 0, jukeUntil: 0,
    pushTarget: -1, pushKill: false, retreating: false, crossing: false,
    dodgeUntil: 0, dodgeX: 0, dodgeZ: 0, judged: new Int32Array(JUDGED).fill(-0x7fffffff), judgedHead: 0,
    intent: null, aim: null, hookReadySince: -1, baitUntil: 0, lastBankSearch: -99, comboTarget: -1, comboAt: 0, holdStill: false, reeling: false,
    diveTarget: -1, divePurpose: 0, diveUntil: 0, nextDiveCheck: t + 3, trapUntil: 0, lastMineT: -99, itemCdUntil: 0, drownSeen: 0, panicked: false,
    stuckX: u.x, stuckZ: u.z, stuckCheck: t + 0.5, stuckHits: 0, detourUntil: 0, detourX: 0, detourZ: 0, detourSide: 1,
    lastState: u.state,
    stats: { hooks: 0, saves: 0, runes: 0, dodges: 0, combos: 0, dives: 0, bankShots: 0, grappleEscapes: 0 },
  };
}

function onStateChange(sim: GameSim, u: Unit, b: Brain): void {
  const t = sim.time;
  if (u.state === UnitState.Drowning) {
    b.drownSeen = t;
    b.panicked = b.rng.next() >= b.tune.escape;
  }
  if (u.state === UnitState.Dead) {
    b.intent = null;
    b.aim = null;
    b.comboTarget = -1;
    b.retreating = false;
    b.crossing = false;
    b.hookReadySince = -1;
    b.trapUntil = 0;
    b.dodgeUntil = 0;
  }
  if (b.lastState === UnitState.Casting) b.aim = null;
  if (b.lastState === UnitState.Dead) b.nextPlan = t;
  b.lastState = u.state;
}

export function tickBot(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, input: PlayerInput): void {
  const t = sim.time;
  if (u.state !== b.lastState) onStateChange(sim, u, b);
  shop(sim, u, b);
  input.b = 0;
  if (u.state === UnitState.Dead || sim.phase === 'ended') {
    input.mx = 0;
    input.mz = 0;
    return;
  }
  switch (u.state) {
    case UnitState.Hooked:
    case UnitState.Knocked:
    case UnitState.Grappling:
      input.mx = 0;
      input.mz = 0;
      return;
    case UnitState.Casting:
      input.mx = 0;
      input.mz = 0;
      holdAim(sim, ctx, u, b, input);
      return;
    case UnitState.Drowning:
      b.mode = Mode.Swim;
      escapeWater(sim, ctx, u, b, input);
      return;
    default:
      break;
  }
  // Alive
  diveFollowUp(sim, ctx, u, b, input);
  if (!(input.b & CAST_BITS)) comboWatch(sim, ctx, u, b, input);
  if (input.b & CAST_BITS) {
    input.mx = 0;
    input.mz = 0;
    return;
  }
  checkDodge(sim, ctx, u, b);
  if (t >= b.nextThink) {
    b.nextThink = t + 1 / b.tune.thinkHz;
    if (!b.reeling && b.comboTarget < 0) {
      thinkBash(sim, ctx, u, b);
      thinkHook(sim, ctx, u, b);
      thinkDive(sim, ctx, u, b);
      thinkGrappleHome(sim, ctx, u, b);
    }
    useItems(sim, ctx, u, b, input);
  }
  if (!(input.b & CAST_BITS)) runIntent(sim, ctx, u, b, input);
  // the tide is turning while we stand in the channel: re-plan right now, not at the next plan tick
  if (!sim.river.deep && b.mode !== Mode.Leave && ctx.untilDeep < 5 && sim.world.channel(u.x, u.z) > -0.4) b.nextPlan = t;
  if (t >= b.nextPlan) {
    b.nextPlan = t + 1 / b.tune.planHz;
    plan(sim, ctx, u, b);
  }
  if (input.b & CAST_BITS) {
    input.mx = 0;
    input.mz = 0;
    return;
  }
  if (trapStep(sim, u, b, input)) return;
  steer(sim, ctx, u, b, input);
}
