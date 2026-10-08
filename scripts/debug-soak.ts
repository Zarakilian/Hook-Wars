import { GameSim } from '../shared/sim/sim.ts';
import { DEFAULT_CONFIG, TICK_RATE } from '../shared/constants.ts';
import type { PlayerInfo, Team } from '../shared/types.ts';
const players: PlayerInfo[] = [];
for (let i = 0; i < 10; i++) players.push({ id: i + 1, name: 'b' + i, team: (i % 2) as Team, family: 'brawler', cosmetics: { hat: 0, accent: 0, face: 0 }, isBot: true, botDifficulty: 'hard' });
const sim = new GameSim({ ...DEFAULT_CONFIG, mapId: (process.argv[2] as any) ?? 'muckmire', riverMode: (process.argv[3] as any) ?? 'deep', killsToWin: 999 }, players, 1234);
const counts: Record<string, number> = {};
for (let i = 0; i < TICK_RATE * 60; i++) {
  sim.step();
  for (const e of sim.events) counts[e.e] = (counts[e.e] ?? 0) + 1;
  if (i % 300 === 0) console.log(i, sim.phase, sim.units.slice(0, 4).map(u => `${u.id}:${u.x.toFixed(1)},${u.z.toFixed(1)} st${u.state} hp${Math.round(u.hp)} cd${u.cdHook.toFixed(1)} ah${u.activeHook}`).join(' | '));
}
console.log(counts, 'score', sim.score);
