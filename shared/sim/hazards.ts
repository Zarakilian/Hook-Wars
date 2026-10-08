// Hazards: thorns, bristles and each map's special (quicksand, ice spikes, jellyfish, steam vents).
// Placement comes from the map's hazard slots and the match's Hazards option.
import { UNIT_RADIUS } from '../constants.ts';
import type { MapDef } from '../maps/types.ts';
import { dist2, hash01, q2 } from '../math.ts';
import { UnitState, type HazardKind, type MatchConfig } from '../types.ts';
import type { HazardInst } from './entities.ts';
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

export function buildHazards(map: MapDef, config: MatchConfig, seed: number): HazardInst[] {
  if (config.hazards === 'none') return [];
  const slots = map.hazardSlots.filter((s) => config.riverMode !== 'deep' || !s.channel);
  const cycle: HazardKind[] = ['thorns', 'bristles', map.special];
  const out: HazardInst[] = [];
  slots.forEach((s, i) => {
    let kind: HazardKind;
    if (config.hazards === 'thorns') kind = 'thorns';
    else if (config.hazards === 'bristles') kind = 'bristles';
    else if (config.hazards === 'special') kind = map.special;
    else kind = cycle[(i + Math.floor(hash01(seed, 7) * 3)) % 3];
    const info = HAZARD_INFO[kind];
    out.push({
      id: i,
      kind,
      x: s.x,
      z: s.z,
      r: s.r,
      channel: s.channel,
      period: info.periodic ? info.period : 0,
      offset: info.periodic ? hash01(seed, i, 13) * info.period : 0,
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

export function updateHazards(sim: GameSim, dt: number): void {
  for (const u of sim.units) u.inHazard = false;
  if (sim.hazards.length === 0) return;
  const mt = sim.matchTime;
  for (const hz of sim.hazards) {
    if (!sim.hazardActive(hz)) continue;
    let burst = false;
    if (hz.period > 0) {
      const prev = (((mt - dt + hz.offset) % hz.period) + hz.period) % hz.period;
      const cur = (((mt + hz.offset) % hz.period) + hz.period) % hz.period;
      burst = cur < prev;
      if (burst) sim.emit({ e: 'hazard', h: hz.id, x: q2(hz.x), z: q2(hz.z) });
    }
    for (const u of sim.units) {
      if (u.state !== UnitState.Alive && u.state !== UnitState.Casting && u.state !== UnitState.Drowning) continue;
      const d2 = dist2(u.x, u.z, hz.x, hz.z);
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
          if (d2 < inner * inner) {
            u.inHazard = true;
            const still = u.vx * u.vx + u.vz * u.vz < 1;
            u.hazardT = still ? u.hazardT + dt : Math.max(0, u.hazardT - dt * 2);
            if (u.hazardT > 1.2) sim.damage(u, DPS.quicksand! * dt, -1, 'hazard');
          } else u.hazardT = 0;
          break;
        case 'bristles': {
          const touch = hz.r + UNIT_RADIUS;
          if (d2 < touch * touch && u.bristleCd <= 0) {
            u.bristleCd = 0.9;
            sim.damage(u, 35, -1, 'hazard');
            if (!sim.isDead(u)) sim.knock(u, u.x - hz.x || 0.01, u.z - hz.z, 2.6, 0.25, 0.4);
          }
          break;
        }
        case 'icespikes':
          if (burst && d2 < (hz.r + UNIT_RADIUS) ** 2) {
            sim.damage(u, 90, -1, 'hazard');
            if (!sim.isDead(u)) sim.knock(u, u.x - hz.x || 0.01, u.z - hz.z, 1.2, 0.45, 1.8);
          }
          break;
        case 'steamvent':
          if (burst && d2 < (hz.r + UNIT_RADIUS) ** 2) {
            sim.damage(u, 60, -1, 'hazard');
            if (!sim.isDead(u)) sim.knock(u, u.x - hz.x || 0.01, u.z - hz.z, 4, 0.35, 1.2);
          }
          break;
      }
    }
  }
}
