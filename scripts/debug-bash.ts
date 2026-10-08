import { GameSim } from '../shared/sim/sim.ts';
import { DEFAULT_CONFIG, TICK_RATE } from '../shared/constants.ts';
import { Btn, type PlayerInfo } from '../shared/types.ts';
const players: PlayerInfo[] = [
  { id: 1, name: 'A', team: 0, family: 'brawler', cosmetics: { hat: 0, accent: 0, face: 0 }, isBot: false },
  { id: 2, name: 'B', team: 1, family: 'ogre', cosmetics: { hat: 0, accent: 0, face: 0 }, isBot: false },
];
const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: false }, players, 7);
for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
const a = sim.unitById.get(1)!, b = sim.unitById.get(2)!;
a.spawnProt = 0; b.spawnProt = 0;
const c = sim.world.riverCenter(5);
a.x = c.x - c.hw - 1; a.z = 5;
b.x = a.x - 1.6; b.z = a.z;
sim.queueInput(2, { seq: 1, mx: 0, mz: 0, ax: a.x + 5, az: a.z, b: Btn.Bash });
for (let i = 0; i < TICK_RATE * 4; i++) {
  sim.queueInput(1, { seq: i + 2, mx: 1, mz: 0, ax: 10, az: 5, b: 0 });
  sim.step();
  const ev = sim.events.map(e => e.e).join(',');
  if (i % 3 === 0 || ev) console.log(i, 'A', a.x.toFixed(2), a.z.toFixed(2), 'st', a.state, 'ch', sim.world.channel(a.x, a.z).toFixed(2), 'B st', b.state, ev);
}
