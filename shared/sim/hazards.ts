// Hazards: thorns, bristles and each map's special (quicksand, ice spikes, jellyfish, steam vents).
// Placement comes from the map's hazard slots and the match's Hazards option.
import { UNIT_RADIUS } from '../constants.ts';
import type { MapDef } from '../maps/types.ts';
import { dist2, hash01, q2 } from '../math.ts';
import { UnitState, type HazardKind, type MatchConfig } from '../types.ts';
import type { HazardInst } from './entities.ts';
import { deckTier, tiersTouch, type DeckTier } from './movement.ts';
import type { GameSim } from './sim.ts';

export const HAZARD_INFO: Record<HazardKind, { name: string; blurb: string; periodic: boolean; period: number; telegraph: number }> = {
  thorns: { name: 'Thorns', blurb: 'Bramble thickets: slow and scratch anyone inside.', periodic: false, period: 0, telegraph: 0 },
  bristles: { name: 'Bristles', blurb: 'Spiky bristle clumps: touch one and it stabs and shoves you.', periodic: false, period: 0, telegraph: 0 },
  quicksand: { name: 'Quicksand', blurb: 'Bog pits: heavy slow, and they start eating you if you stand still.', periodic: false, period: 0, telegraph: 0 },
  icespikes: { name: 'Ice Spikes', blurb: 'Frost vents that crack, then erupt every few seconds.', periodic: true, period: 5, telegraph: 1 },
  jellyfish: { name: 'Jellyfish', blurb: 'Stinging jellies: slow and burn while you wade through them.', periodic: false, period: 0, telegraph: 0 },
  steamvent: { name: 'Steam Vents', blurb: 'Pipes that hiss, then blast you off your feet.', periodic: true, period: 4, telegraph: 0.8 },
};

const DPS: Partial<Record<HazardKind, number>> = { thorns: 18, jellyfish: 24, quicksand: 30 };

/**
 * Index of the slot's point mirror (-x, -z) in the map's slot list, or the slot itself (a centre slot,
 * or one without a mirror). Maps author slots as [list..., mirrors...] (withMirroredPoints).
 */
function mirrorSlotIndex(map: MapDef, i: number): number {
  const s = map.hazardSlots[i];
  for (let j = 0; j < map.hazardSlots.length; j++) {
    const m = map.hazardSlots[j];
    if (Math.abs(m.x + s.x) < 1e-6 && Math.abs(m.z + s.z) < 1e-6) return j;
  }
  return i;
}

export function buildHazards(map: MapDef, config: MatchConfig, seed: number): HazardInst[] {
  if (config.hazards === 'none') return [];
  const cycle: HazardKind[] = ['thorns', 'bristles', map.special];
  const shift = Math.floor(hash01(seed, 7) * 3);
  const out: HazardInst[] = [];
  map.hazardSlots.forEach((s, i) => {
    if (config.riverMode === 'deep' && s.channel) return; // Deep Water: bank slots only
    // Fairness: a slot and its point mirror (the other team's copy) get the same kind and the same timing.
    // Both come from the pair's lower index in the full slot list, so the Deep Water filter keeps pairs matched.
    const k = Math.min(i, mirrorSlotIndex(map, i));
    let kind: HazardKind;
    if (config.hazards === 'thorns') kind = 'thorns';
    else if (config.hazards === 'bristles') kind = 'bristles';
    else if (config.hazards === 'special') kind = map.special;
    else kind = cycle[(k + shift) % 3];
    const info = HAZARD_INFO[kind];
    out.push({
      id: out.length,
      kind,
      x: s.x,
      z: s.z,
      r: s.r,
      channel: s.channel,
      period: info.periodic ? info.period : 0,
      offset: info.periodic ? hash01(seed, k, 13) * info.period : 0,
      telegraph: info.telegraph,
    });
  });
  return out;
}

/** Visual/timing state of a periodic hazard: progress through its cycle (0..1) and whether it is warning. */
export function hazardCycle(h: HazardInst, matchTime: number): { phase: number; warning: boolean; firing: boolean } {
  if (h.period <= 0) return { phase: 0, warning: false, firing: false };
  const c = (((matchTime + h.offset) % h.period) + h.period) % h.period;
  return { phase: c / h.period, warning: c >= h.period - h.telegraph, firing: c < 0.3 };
}

/**
 * Deck tier of a hazard slot (see deckTier in sim/movement.ts): a bank slot on a bridge or dock over a dry
 * channel is up on the deck, a channel slot is down on the bed. Contact needs tiersTouch with the unit's tier.
 */
export function hazardTier(sim: GameSim, hz: HazardInst): DeckTier {
  return deckTier(sim.world, sim.river, hz.x, hz.z, hz.channel);
}

/** Whether a unit at (u.x, u.z) on its own deck layer can touch this hazard (the distance is checked by the caller). */
export function hazardTouches(sim: GameSim, hz: HazardInst, u: { x: number; z: number; under?: boolean }): boolean {
  return tiersTouch(hazardTier(sim, hz), deckTier(sim.world, sim.river, u.x, u.z, u.under));
}

export function updateHazards(sim: GameSim, dt: number): void {
  for (const u of sim.units) u.inHazard = false;
  if (sim.hazards.length === 0) return;
  const mt = sim.matchTime;
  // quicksand: one decision per unit per tick (inside any pit or not), whatever order the pits are listed in
  let sunk: Set<number> | null = null;
  for (const hz of sim.hazards) {
    if (!sim.hazardActive(hz)) continue;
    let burst = false;
    if (hz.period > 0) {
      const prev = (((mt - dt + hz.offset) % hz.period) + hz.period) % hz.period;
      const cur = (((mt + hz.offset) % hz.period) + hz.period) % hz.period;
      burst = cur < prev;
      if (burst) sim.emit({ e: 'hazard', h: hz.id, x: q2(hz.x), z: q2(hz.z) });
    }
    let tier: DeckTier | null = null; // computed once, only when someone is in reach
    for (const u of sim.units) {
      if (u.state !== UnitState.Alive && u.state !== UnitState.Casting && u.state !== UnitState.Drowning) continue;
      const d2 = dist2(u.x, u.z, hz.x, hz.z);
      const touch = hz.r + UNIT_RADIUS;
      if (d2 >= touch * touch) continue; // out of reach of every kind
      const ht = tier ?? (tier = hazardTier(sim, hz));
      // a unit on the bed under a bridge never touches the vent or thorns on the bridge, and the other way round
      if (!tiersTouch(ht, deckTier(sim.world, sim.river, u.x, u.z, u.under))) continue;
      const inner = hz.r + UNIT_RADIUS * 0.5;
      switch (hz.kind) {
        case 'thorns':
        case 'jellyfish':
          if (d2 < inner * inner) {
            u.inHazard = true;
            sim.damage(u, DPS[hz.kind]! * dt, -1, 'hazard');
          }
          break;
        case 'quicksand':
          if (d2 < inner * inner && !(sunk && sunk.has(u.id))) {
            (sunk ??= new Set()).add(u.id);
            u.inHazard = true;
            const still = u.vx * u.vx + u.vz * u.vz < 1;
            u.hazardT = still ? u.hazardT + dt : Math.max(0, u.hazardT - dt * 2);
            if (u.hazardT > 1.2) sim.damage(u, DPS.quicksand! * dt, -1, 'hazard');
          }
          break;
        case 'bristles': {
          if (u.bristleCd <= 0) {
            u.bristleCd = 0.9;
            sim.damage(u, 35, -1, 'hazard');
            if (!sim.isDead(u)) sim.knock(u, u.x - hz.x || 0.01, u.z - hz.z, 2.6, 0.25, 0.4);
          }
          break;
        }
        case 'icespikes':
          if (burst) {
            sim.damage(u, 90, -1, 'hazard');
            if (!sim.isDead(u)) sim.knock(u, u.x - hz.x || 0.01, u.z - hz.z, 1.2, 0.45, 1.8);
          }
          break;
        case 'steamvent':
          if (burst) {
            sim.damage(u, 60, -1, 'hazard');
            if (!sim.isDead(u)) sim.knock(u, u.x - hz.x || 0.01, u.z - hz.z, 4, 0.35, 1.2);
          }
          break;
      }
    }
  }
  // out of every quicksand pit this tick: the sinking clock starts over
  for (const u of sim.units) if (!(sunk && sunk.has(u.id))) u.hazardT = 0;
}
