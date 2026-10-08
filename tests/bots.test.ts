// Bot AI tests: skill ordering, hook accuracy, water safety, the core combos, fair play and cost.
// Everything runs on fixed seeds, so results are deterministic. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSim } from '../shared/sim/sim.ts';
import { botInfo, botProfile, resetBotProfile, setBotProfiling } from '../shared/sim/bots.ts';
import { DEFAULT_CONFIG, TICK_RATE } from '../shared/constants.ts';
import {
  UnitState, type BotDifficulty, type FamilyId, type HazardMode, type MapId, type MatchConfig, type PlayerInfo, type RiverMode, type Team,
} from '../shared/types.ts';

const FAMS: readonly FamilyId[] = ['brawler', 'ogre', 'bot'];

function team5(size: number, diffOf: (team: Team, slot: number) => BotDifficulty): PlayerInfo[] {
  const out: PlayerInfo[] = [];
  for (let i = 0; i < size * 2; i++) {
    const team = (i % 2) as Team;
    const slot = i >> 1;
    out.push({
      id: i + 1, name: `Bot ${i + 1}`, team, family: FAMS[slot % 3], loadout: {},
      isBot: true, botDifficulty: diffOf(team, slot),
    });
  }
  return out;
}

function config(mapId: MapId, riverMode: RiverMode, hazards: HazardMode = 'none'): MatchConfig {
  return { ...DEFAULT_CONFIG, mapId, riverMode, hazards, killsToWin: 999, timeLimitSec: 900 };
}

function run(sim: GameSim, seconds: number, onTick?: () => void): void {
  for (let i = 0; i < TICK_RATE * seconds; i++) {
    sim.step();
    onTick?.();
  }
}

const SERIES: [MapId, RiverMode, HazardMode][] = [
  ['muckmire', 'deep', 'none'],
  ['coralcove', 'tidal', 'mixed'],
  ['cogwater', 'dry', 'none'],
  ['frostfang', 'deep', 'special'],
];

function series(a: BotDifficulty, b: BotDifficulty, seconds: number): { ka: number; kb: number; wins: number; accA: number; accB: number } {
  let ka = 0;
  let kb = 0;
  let wins = 0;
  const hits = [0, 0];
  const thrown = [0, 0];
  SERIES.forEach(([mapId, riverMode, hazards], gi) => {
    const aTeam = (gi % 2) as Team; // swap sides every match
    const sim = new GameSim(config(mapId, riverMode, hazards), team5(5, (t) => (t === aTeam ? a : b)), 4000 + gi * 101);
    run(sim, seconds);
    const sa = sim.score[aTeam];
    const sb = sim.score[aTeam === 0 ? 1 : 0];
    ka += sa;
    kb += sb;
    if (sa > sb) wins++;
    for (const u of sim.units) {
      const k = u.team === aTeam ? 0 : 1;
      hits[k] += u.stats.hh;
      thrown[k] += u.stats.ht;
    }
  });
  return { ka, kb, wins, accA: hits[0] / Math.max(1, thrown[0]), accB: hits[1] / Math.max(1, thrown[1]) };
}

test('hard and brutal bots beat easy bots over a short series', (t) => {
  for (const strong of ['hard', 'brutal'] as const) {
    const r = series(strong, 'easy', 120);
    t.diagnostic(`${strong} vs easy: kills ${r.ka}:${r.kb}, wins ${r.wins}/${SERIES.length}, hook accuracy ${(r.accA * 100).toFixed(0)}% vs ${(r.accB * 100).toFixed(0)}%`);
    assert.ok(r.wins >= SERIES.length - 1, `${strong} won only ${r.wins} of ${SERIES.length}`);
    assert.ok(r.ka > r.kb * 2, `${strong} kills ${r.ka} vs easy ${r.kb}`);
    assert.ok(r.accA > r.accB, `${strong} should aim better than easy`);
  }
  const r = series('brutal', 'hard', 120);
  t.diagnostic(`brutal vs hard: kills ${r.ka}:${r.kb}, wins ${r.wins}/${SERIES.length}`);
  assert.ok(r.ka > r.kb, 'brutal should out-kill hard');
});

test('bots land a reasonable share of their hooks at every difficulty', (t) => {
  const acc: Record<string, number> = {};
  for (const d of ['easy', 'normal', 'hard', 'brutal'] as const) {
    let hh = 0;
    let ht = 0;
    for (const [gi, mapId] of (['muckmire', 'coralcove', 'cogwater', 'frostfang'] as const).entries()) {
      // the tested difficulty on one side, a normal squad on the other
      const sim = new GameSim(config(mapId, 'deep'), team5(5, (tm) => (tm === 0 ? d : 'normal')), 7000 + gi);
      run(sim, 90);
      for (const u of sim.units) {
        if (u.team !== 0) continue;
        hh += u.stats.hh;
        ht += u.stats.ht;
      }
    }
    acc[d] = hh / Math.max(1, ht);
    t.diagnostic(`${d}: ${hh}/${ht} hooks hit (${(acc[d] * 100).toFixed(1)}%) against normal bots`);
    assert.ok(ht > 40, `${d} bots barely threw (${ht})`);
  }
  assert.ok(acc.easy >= 0.12, 'easy bots should still land some hooks');
  assert.ok(acc.hard >= 0.3 && acc.brutal >= 0.3, 'hard and brutal bots should land at least 30%');
  assert.ok(acc.brutal > acc.easy && acc.hard > acc.easy, 'skill should show in accuracy');
});

test('bots never stay in water that turns deep, and never walk into the enemy fountain', (t) => {
  let voluntary = 0;
  let forced = 0;
  let fountainTicks = 0;
  const cases: [MapId, RiverMode][] = [['coralcove', 'tidal'], ['cogwater', 'tidal'], ['frostfang', 'tidal'], ['muckmire', 'deep']];
  for (const [gi, [mapId, riverMode]] of cases.entries()) {
    const sim = new GameSim(config(mapId, riverMode, 'mixed'), team5(5, (_tm, s) => (['easy', 'normal', 'hard', 'brutal', 'normal'] as const)[s]), 9000 + gi);
    const prev = new Map<number, number>();
    const forcedAt = new Map<number, number>();
    run(sim, 180, () => {
      for (const e of sim.events) {
        if (e.e !== 'drownStart') continue;
        const p = prev.get(e.u);
        // free for 1.5 s or more before the water got them: the bot walked in or stayed too long
        const free = sim.time - (forcedAt.get(e.u) ?? -99);
        if ((p === UnitState.Alive || p === UnitState.Casting) && free >= 1.5) voluntary++;
        else forced++;
      }
      for (const u of sim.units) {
        prev.set(u.id, u.state);
        if (u.state !== UnitState.Alive && u.state !== UnitState.Casting) forcedAt.set(u.id, sim.time);
        if (u.state === UnitState.Alive) {
          const f = sim.map.fountains[u.team === 0 ? 1 : 0];
          if (Math.hypot(u.x - f.x, u.z - f.z) < f.r) fountainTicks++;
        }
      }
    });
  }
  t.diagnostic(`drownings: ${forced} knocked, hooked or dropped in, ${voluntary} walked in or caught by the tide`);
  t.diagnostic(`bot ticks spent inside the enemy fountain: ${fountainTicks}`);
  assert.equal(voluntary, 0, 'a bot was caught standing in water that turned deep');
  assert.ok(fountainTicks < TICK_RATE * 3, `bots spent ${(fountainTicks / TICK_RATE).toFixed(1)} s in the enemy fountain`);
});

function duel(mapId: MapId, diff: BotDifficulty, seed: number) {
  const players: PlayerInfo[] = [
    { id: 1, name: 'Bot', team: 0, family: 'brawler', loadout: {}, isBot: true, botDifficulty: diff },
    { id: 2, name: 'Dummy', team: 1, family: 'ogre', loadout: {}, isBot: false },
  ];
  const sim = new GameSim({ ...config(mapId, 'deep'), botFill: false }, players, seed);
  return { sim, bot: sim.unitById.get(1)!, dummy: sim.unitById.get(2)! };
}

test('combo: a bot hooks an enemy across the river and bashes them in to drown', (t) => {
  let drowned = 0;
  let n = 0;
  for (const mapId of ['muckmire', 'cogwater', 'frostfang'] as const) {
    for (const diff of ['hard', 'brutal'] as const) {
      for (const z of [-3, 4]) {
        n++;
        const { sim, dummy } = duel(mapId, diff, 31 + z);
        const c = sim.world.riverCenter(z);
        let caught = false;
        let kill = false;
        for (let i = 0; i < TICK_RATE * 14 && !kill; i++) {
          if (!caught && dummy.state === UnitState.Alive) {
            dummy.x = c.x + c.hw + 1.4; // a careless enemy loitering at the far edge
            dummy.z = z;
            if (sim.phase === 'playing') dummy.spawnProt = 0;
          }
          sim.step();
          for (const e of sim.events) {
            if (e.e === 'hookDone' && e.tg === 2) caught = true;
            if (e.e === 'kill' && e.v === 2 && e.cause === 'drown') kill = true;
          }
        }
        if (kill) drowned++;
      }
    }
  }
  t.diagnostic(`hook, bash, drown: ${drowned}/${n} scripted duels`);
  assert.ok(drowned >= n - 2, `only ${drowned} of ${n} catches ended in a drowning`);
});

test('saves: a bot hooks a drowning ally out of the river', () => {
  const players: PlayerInfo[] = [
    { id: 1, name: 'Guard', team: 0, family: 'bot', loadout: {}, isBot: true, botDifficulty: 'normal' },
    { id: 2, name: 'Swimmer', team: 0, family: 'ogre', loadout: {}, isBot: false },
    { id: 3, name: 'Far', team: 1, family: 'brawler', loadout: {}, isBot: false },
  ];
  const sim = new GameSim({ ...config('muckmire', 'deep'), botFill: false }, players, 77);
  const far = sim.unitById.get(3)!;
  const guard = sim.unitById.get(1)!;
  const swim = sim.unitById.get(2)!;
  run(sim, 5); // countdown, guard walks to the bank
  far.x = 30; // keep the enemy out of the picture
  const c = sim.world.riverCenter(guard.z);
  swim.x = c.x; // dumped in the middle of the river
  swim.z = guard.z + 3;
  swim.spawnProt = 0;
  guard.cdHook = 0;
  let saved = false;
  for (let i = 0; i < TICK_RATE * 2.5 && !saved; i++) {
    sim.step();
    for (const e of sim.events) if (e.e === 'hookHit' && e.u === 1 && e.tg === 2 && e.ally) saved = true;
  }
  assert.ok(saved, 'the guard did not hook its drowning teammate');
});

test('drowning bots grapple out when they cannot swim to land', () => {
  let escaped = 0;
  for (const [i, mapId] of (['muckmire', 'frostfang', 'cogwater', 'coralcove'] as const).entries()) {
    // brutal bots never forget their grapple (easier ones sometimes panic and flail)
    const { sim, bot, dummy } = duel(mapId, 'brutal', 50 + i);
    run(sim, 5);
    dummy.x = 30;
    const c = sim.world.riverCenter(-6);
    bot.x = c.x;
    bot.z = -6;
    bot.state = UnitState.Alive;
    bot.cdGrapple = 0;
    let out = false;
    for (let k = 0; k < TICK_RATE * 2.5 && !out; k++) {
      sim.step();
      for (const e of sim.events) if (e.e === 'grappleLand' && e.u === 1) out = true;
    }
    if (out && bot.state === UnitState.Alive && sim.world.channel(bot.x, bot.z) <= 0) escaped++;
  }
  assert.ok(escaped >= 3, `only ${escaped} of 4 bots grappled out of the river`);
});

test('fair play: bots do not hook what their team cannot see', () => {
  const { sim, bot, dummy } = duel('muckmire', 'brutal', 5);
  run(sim, 5);
  let thrown = 0;
  for (let i = 0; i < TICK_RATE * 6; i++) {
    const c = sim.world.riverCenter(bot.z);
    dummy.x = c.x + c.hw + 1.5; // right across from the bot, but under a puffball
    dummy.z = bot.z;
    dummy.puff = 3;
    dummy.spawnProt = 0;
    sim.step();
    for (const e of sim.events) if (e.e === 'hookLaunch' && e.u === 1) thrown++;
  }
  assert.equal(thrown, 0, 'the bot threw at an enemy it could not see');
});

test('bots are deterministic for a given seed', () => {
  const make = () => new GameSim(config('coralcove', 'tidal', 'mixed'), team5(5, (_t, s) => (['easy', 'normal', 'hard', 'brutal', 'hard'] as const)[s]), 4242);
  const a = make();
  const b = make();
  run(a, 60);
  run(b, 60);
  assert.deepEqual(a.score, b.score);
  for (let i = 0; i < a.units.length; i++) {
    assert.equal(a.units[i].x, b.units[i].x);
    assert.equal(a.units[i].z, b.units[i].z);
    assert.equal(a.units[i].stats.ht, b.units[i].stats.ht);
  }
});

test('roles are assigned per team and every bot plays its part', () => {
  const sim = new GameSim(config('cogwater', 'dry'), team5(5, () => 'hard'), 11);
  run(sim, 60);
  for (const team of [0, 1] as const) {
    const roles = sim.units.filter((u) => u.team === team).map((u) => botInfo(u)!.role);
    assert.ok(roles.includes('harpooner') && roles.includes('bruiser') && roles.includes('lifeguard'), roles.join(','));
  }
  // every bot threw hooks and bought something
  for (const u of sim.units) {
    assert.ok(u.stats.ht > 0, `bot ${u.id} never threw`);
    const spent = u.up.damage + u.up.range + u.up.speed + u.up.width + u.items.filter((s) => s).length;
    assert.ok(spent > 0, `bot ${u.id} never shopped`);
  }
});

test('ten bots cost well under a millisecond per tick', (t) => {
  setBotProfiling(true);
  resetBotProfile();
  for (const [gi, mapId] of (['coralcove', 'cogwater'] as const).entries()) {
    const sim = new GameSim(config(mapId, gi === 0 ? 'tidal' : 'deep', 'mixed'), team5(5, (_t, s) => (['easy', 'normal', 'hard', 'brutal', 'brutal'] as const)[s]), 300 + gi);
    run(sim, 120);
  }
  setBotProfiling(false);
  const p = botProfile();
  const avg = p.totalMs / Math.max(1, p.ticks);
  t.diagnostic(`updateBots for 10 bots: ${(avg * 1000).toFixed(1)} us per tick on average, worst tick ${p.maxMs.toFixed(2)} ms, ${p.ticks} ticks`);
  assert.ok(avg < 0.5, `bots cost ${avg.toFixed(3)} ms per tick`);
});
