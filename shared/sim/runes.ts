// Runes spawn on river spots. Hook one to drag it home, or walk over it when the bed is walkable.
import { BAL, UNIT_RADIUS } from '../constants.ts';
import { dist2, q2 } from '../math.ts';
import { RUNE_TYPES, UnitState } from '../types.ts';
import type { GameSim } from './sim.ts';

const MAX_RUNES = 2;

export function updateRunes(sim: GameSim, dt: number): void {
  sim.runeTimer -= dt;
  if (sim.runeTimer <= 0) {
    sim.runeTimer = BAL.runeEvery;
    spawnRune(sim);
  }
  // walking pickup (only possible where the ground is walkable)
  for (let i = sim.runes.length - 1; i >= 0; i--) {
    const r = sim.runes[i];
    if (r.dragged) continue;
    for (const u of sim.units) {
      if (u.state !== UnitState.Alive && u.state !== UnitState.Casting) continue;
      const rr = UNIT_RADIUS + BAL.runeRadius;
      if (dist2(u.x, u.z, r.x, r.z) < rr * rr) {
        sim.runes.splice(i, 1);
        sim.emit({ e: 'runeGrab', u: u.id, r: r.id, t: r.type });
        sim.grantRune(u, r.type);
        break;
      }
    }
  }
}

function spawnRune(sim: GameSim): void {
  if (sim.runes.length >= MAX_RUNES) return;
  const spots = sim.map.runeSpots;
  const free = spots.map((_, i) => i).filter((i) => !sim.runes.some((r) => r.spot === i));
  if (free.length === 0) return;
  const spot = sim.rng.pick(free);
  const type = sim.rng.pick(RUNE_TYPES);
  const p = spots[spot];
  const id = 100000 + sim.tick; // unique per tick, runes spawn at most once per tick
  sim.runes.push({ id, type, x: p.x, z: p.z, spot, dragged: false });
  sim.emit({ e: 'runeSpawn', r: id, t: type, x: q2(p.x), z: q2(p.z) });
}
