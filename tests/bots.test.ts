// Bot AI tests: skill ordering, hook accuracy, water safety, the core combos, fair play, navigation
// on braided maps, power-up play and cost. Everything runs on fixed seeds, so results are
// deterministic. The map tests derive every spot from the map data (maps keep changing). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSim } from '../shared/sim/sim.ts';
import type { Unit } from '../shared/sim/entities.ts';
import { botInfo, botProfile, resetBotProfile, setBotProfiling } from '../shared/sim/bots.ts';
import { compAt, edgeDist, findPath, holdSpot, NAV_LAND, navStatic, newNavPath } from '../shared/sim/bots/nav.ts';
import { hookLineClear, mapInfo, standable } from '../shared/sim/bots/mapinfo.ts';
import { ROLES } from '../shared/sim/bots/roles.ts';
import { hookCanCatch, hookTierOf } from '../shared/sim/movement.ts';
import { Mode, type Brain } from '../shared/sim/bots/types.ts';
import { DEFAULT_CONFIG, MAX_TEAM_SIZE, TICK_RATE } from '../shared/constants.ts';
import { getMap } from '../shared/maps/index.ts';
import {
  MAP_IDS, UnitState, type BotDifficulty, type FamilyId, type HazardMode, type MapId, type MatchConfig, type PlayerInfo, type RiverMode, type Team,
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

test('6v6: a full squad is two Harpooners, two Bruisers and two Lifeguards, and every bot plays its part', () => {
  const size = MAX_TEAM_SIZE;
  const sim = new GameSim({ ...config('cogwater', 'dry'), teamSize: size }, team5(size, () => 'hard'), 11);
  run(sim, 60);
  for (const team of [0, 1] as const) {
    const roles = sim.units.filter((u) => u.team === team).map((u) => botInfo(u)!.role);
    assert.equal(roles.length, size);
    for (const r of ['harpooner', 'bruiser', 'lifeguard'] as const) assert.equal(roles.filter((x) => x === r).length, 2, roles.join(','));
  }
  for (const u of sim.units) {
    assert.ok(u.stats.ht > 0, `bot ${u.id} never threw`);
    const spent = u.up.damage + u.up.range + u.up.speed + u.up.width + u.items.filter((s) => s).length;
    assert.ok(spent > 0, `bot ${u.id} never shopped`);
  }
});

test('6v6: six bots a side spread along their bank on every map (no clumping on a spot, no blocking at the edge)', (t) => {
  const size = MAX_TEAM_SIZE;
  const diffs = ['normal', 'hard', 'easy', 'brutal', 'normal', 'hard'] as const;
  let pairs = 0;
  let clumped = 0;
  let edgeTouch = 0;
  let nnSum = 0;
  let nnN = 0;
  let spanSum = 0;
  let spanN = 0;
  const worst: string[] = [];
  for (const [mi, mapId] of MAP_IDS.entries()) {
    for (const [ri, riverMode] of (['deep', 'dry'] as const).entries()) {
      const sim = new GameSim({ ...config(mapId, riverMode, 'mixed'), teamSize: size }, team5(size, (_t, s) => diffs[s]), 500 + mi * 10 + ri);
      const ns = navStatic(sim.map);
      let p = 0;
      let c = 0;
      let e = 0;
      for (let i = 0; i < TICK_RATE * 64; i++) {
        sim.step();
        if (i < TICK_RATE * 6 || i % 10 !== 0) continue; // after the countdown and the walk to the bank
        for (const team of [0, 1] as const) {
          // holders: alive bots holding their bank (pushing, retreating and rune runs are meant to bunch up)
          const hold = sim.units.filter((u) => u.team === team && u.state === UnitState.Alive && botInfo(u)!.mode === Mode.Hold);
          const goals = hold.map((u) => botInfo(u)!);
          for (let a = 0; a < hold.length; a++) {
            let nn = Infinity;
            for (let b = 0; b < hold.length; b++) {
              if (a === b) continue;
              const d = Math.hypot(goals[a].goalX - goals[b].goalX, goals[a].goalZ - goals[b].goalZ);
              nn = Math.min(nn, d);
              if (b < a) continue;
              p++;
              if (d < 2) c++;
              // two bodies pressed together (radius 0.75 each) right at the water's edge: one blocks the other's throw
              if (Math.hypot(hold[a].x - hold[b].x, hold[a].z - hold[b].z) < 1.6) {
                const ea = edgeDist(ns, team, hold[a].x, hold[a].z);
                const eb = edgeDist(ns, team, hold[b].x, hold[b].z);
                if (ea >= 0 && ea < 3.5 && eb >= 0 && eb < 3.5) e++;
              }
            }
            if (Number.isFinite(nn)) {
              nnSum += nn;
              nnN++;
            }
          }
          if (hold.length >= size - 1) {
            const zs = goals.map((g) => g.goalZ);
            spanSum += Math.max(...zs) - Math.min(...zs);
            spanN++;
          }
        }
      }
      pairs += p;
      clumped += c;
      edgeTouch += e;
      if (p > 0 && (c + e) / p > 0.01) worst.push(`${mapId}/${riverMode} ${((100 * c) / p).toFixed(1)}% / ${((100 * e) / p).toFixed(1)}%`);
    }
  }
  const nn = nnSum / nnN;
  const span = spanSum / spanN;
  t.diagnostic(`6v6 holders: ${pairs} pairs sampled, goals under 2 m apart ${((100 * clumped) / pairs).toFixed(2)}%, bodies touching at the bank edge ${((100 * edgeTouch) / pairs).toFixed(2)}%, nearest teammate's spot ${nn.toFixed(1)} m on average, squad spread along the bank ${span.toFixed(1)} m`);
  assert.ok(pairs > 20000, `only ${pairs} holder pairs sampled`);
  assert.ok(clumped / pairs < 0.01, `holders picked the same spot ${((100 * clumped) / pairs).toFixed(2)}% of the time`);
  assert.ok(edgeTouch / pairs < 0.01, `holders pressed together at the edge ${((100 * edgeTouch) / pairs).toFixed(2)}% of the time`);
  assert.deepEqual(worst, [], 'maps where holders bunch up');
  assert.ok(nn > 5, `a holder's nearest teammate stands only ${nn.toFixed(1)} m away on average`);
  assert.ok(span > 18, `the squad covers only ${span.toFixed(1)} m of its bank`);
});

test('lanes and roles follow the spawn points along the bank, team 1 the mirror of team 0, at every team size on every map', () => {
  for (const [mi, mapId] of MAP_IDS.entries()) {
    for (let size = 1; size <= MAX_TEAM_SIZE; size++) {
      const sim = new GameSim({ ...config(mapId, 'deep'), teamSize: size }, team5(size, () => 'normal'), 900 + mi);
      run(sim, 1.2); // every bot has planned at least once
      const lane = (team: Team, slot: number): number => {
        const u = sim.units.find((x) => x.team === team && x.spawnIndex === slot)!;
        return (u.brain as { laneZ: number }).laneZ;
      };
      const seen = new Set<string>();
      for (let i = 0; i < size; i++) {
        // the fairness rule of the maps: team 1's slot i does what team 0's slot i does, mirrored
        assert.ok(Math.abs(lane(1, i) + lane(0, i)) < 1e-9, `${mapId} ${size}v${size} slot ${i}: lanes ${lane(0, i)} / ${lane(1, i)} not mirrored`);
        seen.add(lane(0, i).toFixed(6));
        for (let j = 0; j < size; j++) {
          // nobody walks across a teammate's path: a spawn point further along z gets a lane further along z
          for (const team of [0, 1] as const) {
            const zi = sim.map.spawns[team][i].z;
            const zj = sim.map.spawns[team][j].z;
            if (zi < zj) assert.ok(lane(team, i) < lane(team, j), `${mapId} ${size}v${size} team ${team}: slot ${i} (z ${zi}) has lane ${lane(team, i)}, slot ${j} (z ${zj}) lane ${lane(team, j)}`);
          }
        }
      }
      assert.equal(seen.size, size, `${mapId} ${size}v${size}: two bots share a lane`);
      // roles go in the same order, so they alternate along the bank (the 6th spawn stands mid-bank)
      for (const team of [0, 1] as const) {
        const side = team === 0 ? 1 : -1;
        const along = sim.units.filter((u) => u.team === team).sort((a, b) => side * ((a.brain as { laneZ: number }).laneZ - (b.brain as { laneZ: number }).laneZ));
        const want = (['harpooner', 'bruiser', 'lifeguard', 'harpooner', 'bruiser', 'lifeguard'] as const).slice(0, size);
        assert.deepEqual(along.map((u) => botInfo(u)!.role), want, `${mapId} ${size}v${size} team ${team}: roles along the bank`);
      }
    }
  }
});

test('walking out of the fountain at the start, neither team piles up (5v5 and 6v6, every map x river mode)', (t) => {
  const rows: string[] = [];
  for (const size of [5, MAX_TEAM_SIZE]) {
    const touch = [0, 0];
    let held = 0;
    for (const [mi, mapId] of MAP_IDS.entries()) {
      for (const [ri, riverMode] of (['deep', 'dry', 'tidal'] as const).entries()) {
        const sim = new GameSim({ ...config(mapId, riverMode), teamSize: size }, team5(size, (_t, s) => (s % 2 ? 'hard' : 'normal')), 4200 + mi * 10 + ri);
        const slow = new Map<number, number>();
        const prev = new Map(sim.units.map((u) => [u.id, { x: u.x, z: u.z }]));
        run(sim, 4, () => {
          for (const u of sim.units) {
            const p = prev.get(u.id)!;
            const v = Math.hypot(u.x - p.x, u.z - p.z) * TICK_RATE;
            prev.set(u.id, { x: u.x, z: u.z });
            // wants to walk but barely moves for half a second: held up by somebody
            const n = Math.hypot(u.input.mx, u.input.mz) > 0.5 && v < 1.5 ? (slow.get(u.id) ?? 0) + 1 : 0;
            slow.set(u.id, n);
            if (n === TICK_RATE / 2) held++;
            for (const o of sim.units) if (o.team === u.team && o.id > u.id && Math.hypot(o.x - u.x, o.z - u.z) < 1.55) touch[u.team]++;
          }
        });
      }
    }
    rows.push(`${size}v${size}: teammates touching ${touch[0]} / ${touch[1]} ticks (team 0 / team 1), held up ${held}`);
    // before lanes followed the spawn points, team 1 crossed its own fountain: 3088 (5v5) and 3580 (6v6) ticks, and a 4-bot jam at 6v6
    assert.equal(held, 0, `${size}v${size}: ${held} bots held up walking out`);
    for (const team of [0, 1] as const) assert.ok(touch[team] < 1500, `${size}v${size} team ${team}: teammates touching ${touch[team]} ticks walking out`);
  }
  t.diagnostic(rows.join('; '));
});

test('ten bots (5v5) and twelve bots (6v6) cost well under a millisecond per tick, pathfinding included', (t) => {
  // mirelight (side channels and docks) and maelstrom (a lagoon, tides) make the bots path the most
  const cases: [MapId, RiverMode][] = [['coralcove', 'tidal'], ['cogwater', 'deep'], ['mirelight', 'deep'], ['maelstrom', 'tidal']];
  const diffs = ['easy', 'normal', 'hard', 'brutal', 'brutal', 'hard'] as const;
  // all the bots of a tick together: 0.5 ms for ten, and the same per bot for twelve
  for (const [size, limit] of [[5, 0.5], [MAX_TEAM_SIZE, 0.6]] as const) {
    // Wall-clock timing: a busy machine (parallel test runs, builds) inflates it. The work is
    // deterministic, so the cheapest of up to three identical runs is the honest figure.
    let best = Infinity;
    let worst = 0;
    let paths = 0;
    const tries: string[] = [];
    for (let attempt = 0; attempt < 3 && best >= limit; attempt++) {
      setBotProfiling(true);
      resetBotProfile();
      paths = 0;
      let stepMs = 0;
      for (const [gi, [mapId, riverMode]] of cases.entries()) {
        const sim = new GameSim({ ...config(mapId, riverMode, 'mixed'), teamSize: size }, team5(size, (_t, s) => diffs[s]), 300 + gi);
        const t0 = performance.now();
        run(sim, 120);
        stepMs += performance.now() - t0;
        for (const u of sim.units) paths += botInfo(u)!.stats.paths;
      }
      setBotProfiling(false);
      const p = botProfile();
      const avg = p.totalMs / Math.max(1, p.ticks);
      tries.push(`${(avg * 1000).toFixed(0)} us (${((100 * p.totalMs) / stepMs).toFixed(0)}% of the whole tick)`);
      if (avg < best) {
        best = avg;
        worst = p.maxMs;
      }
    }
    t.diagnostic(`updateBots for ${size * 2} bots: ${(best * 1000).toFixed(1)} us per tick on average (runs: ${tries.join(', ')}), worst tick ${worst.toFixed(2)} ms (the first run includes the one-off nav grid build), ${paths} A* searches per run`);
    assert.ok(best < limit, `${size * 2} bots cost ${best.toFixed(3)} ms per tick`);
  }
});

// ---------------------------------------------------------------------------------------------
// Navigation on braided maps (side channels, docks, piers, lagoons, bridges)
// ---------------------------------------------------------------------------------------------

test('navigation: A* finds a dry path from every spawn to a hold spot on its own bank, on every map', (t) => {
  const path = newNavPath();
  const spot = { x: 0, z: 0 };
  let n = 0;
  for (const mapId of MAP_IDS) {
    const map = getMap(mapId);
    const ns = navStatic(map);
    for (const team of [0, 1] as const) {
      const comp = compAt(ns, NAV_LAND, map.fountains[team].x, map.fountains[team].z, 6);
      for (const sp of map.spawns[team]) {
        for (const z of [-12, -6, 0, 6, 12]) {
          if (!holdSpot(ns, team, z, 2.2, comp, spot)) continue;
          n++;
          assert.ok(findPath(ns, NAV_LAND, sp.x, sp.z, spot.x, spot.z, 1, null, path), `${mapId}: no path from spawn (${sp.x}, ${sp.z})`);
          assert.ok(path.complete, `${mapId}: path from (${sp.x}, ${sp.z}) to (${spot.x.toFixed(1)}, ${z}) stops short`);
          // never through the water: every waypoint is dry ground or a deck
          for (let i = 0; i < path.n; i++) {
            const c = Math.floor((path.wp[i * 2] - ns.ox) * ns.inv) + Math.floor((path.wp[i * 2 + 1] - ns.oz) * ns.inv) * ns.nx;
            assert.ok(ns.depth[c] <= 0, `${mapId}: waypoint in the water`);
          }
        }
      }
    }
  }
  t.diagnostic(`${n} spawn-to-bank paths checked`);
  assert.ok(n > 300, `only ${n} hold spots found`);
});

test('navigation: from spawn, every bot reaches the edge of its own main river on every map (deep water)', (t) => {
  const rows: string[] = [];
  for (const [gi, mapId] of MAP_IDS.entries()) {
    const sim = new GameSim(config(mapId, 'deep'), team5(5, (_t, s) => (['normal', 'hard', 'easy', 'brutal', 'normal'] as const)[s]), 600 + gi);
    const ns = navStatic(sim.map);
    const reached = new Map<number, number>();
    run(sim, 4 + 16, () => {
      for (const u of sim.units) {
        if (reached.has(u.id) || u.state !== UnitState.Alive) continue;
        // on dry ground on our own side, at a hold distance from the main river (the furthest a
        // bot waits is about 5.5 m back; stuck behind a side channel would be 9 m or more)
        const e = edgeDist(ns, u.team, u.x, u.z);
        if (e >= 0 && e < 6 && sim.world.channel(u.x, u.z) <= 0) reached.set(u.id, sim.time - 4);
      }
    });
    const worst = reached.size > 0 ? Math.max(...reached.values()) : NaN;
    rows.push(`${mapId} ${reached.size}/${sim.units.length} by ${worst.toFixed(1)} s`);
    assert.equal(reached.size, sim.units.length, `${mapId}: only ${reached.size} of ${sim.units.length} bots reached their bank edge`);
  }
  t.diagnostic(rows.join(', '));
});

test('navigation: at 6v6, every bot (the sixth spawn included) reaches the edge of its own main river on every map', (t) => {
  const size = MAX_TEAM_SIZE;
  const rows: string[] = [];
  for (const [gi, mapId] of MAP_IDS.entries()) {
    const sim = new GameSim({ ...config(mapId, 'deep'), teamSize: size }, team5(size, (_t, s) => (['normal', 'hard', 'easy', 'brutal', 'normal', 'hard'] as const)[s]), 600 + gi);
    const ns = navStatic(sim.map);
    const reached = new Map<number, number>();
    run(sim, 4 + 16, () => {
      for (const u of sim.units) {
        if (reached.has(u.id) || u.state !== UnitState.Alive) continue;
        const e = edgeDist(ns, u.team, u.x, u.z);
        if (e >= 0 && e < 6 && sim.world.channel(u.x, u.z) <= 0) reached.set(u.id, sim.time - 4);
      }
    });
    const worst = reached.size > 0 ? Math.max(...reached.values()) : NaN;
    rows.push(`${mapId} ${reached.size}/${sim.units.length} by ${worst.toFixed(1)} s`);
    assert.equal(sim.units.length, size * 2);
    assert.equal(reached.size, sim.units.length, `${mapId}: only ${reached.size} of ${sim.units.length} bots reached their bank edge`);
  }
  t.diagnostic(rows.join(', '));
});

test('navigation: bots leave side channels and lagoons before the tide turns deep', (t) => {
  let voluntary = 0;
  let forced = 0;
  const cases: [MapId, RiverMode][] = [['mirelight', 'tidal'], ['maelstrom', 'tidal'], ['aurora', 'tidal']];
  for (const [gi, [mapId, riverMode]] of cases.entries()) {
    const sim = new GameSim(config(mapId, riverMode, 'mixed'), team5(5, (_tm, s) => (['easy', 'normal', 'hard', 'brutal', 'normal'] as const)[s]), 9100 + gi);
    const prev = new Map<number, number>();
    const forcedAt = new Map<number, number>();
    run(sim, 150, () => {
      for (const e of sim.events) {
        if (e.e !== 'drownStart') continue;
        const p = prev.get(e.u);
        const free = sim.time - (forcedAt.get(e.u) ?? -99);
        if ((p === UnitState.Alive || p === UnitState.Casting) && free >= 1.5) voluntary++;
        else forced++;
      }
      for (const u of sim.units) {
        prev.set(u.id, u.state);
        if (u.state !== UnitState.Alive && u.state !== UnitState.Casting) forcedAt.set(u.id, sim.time);
      }
    });
  }
  t.diagnostic(`drownings: ${forced} knocked, hooked or dropped in, ${voluntary} caught by the tide`);
  assert.equal(voluntary, 0, 'a bot was caught standing in water that turned deep');
});

// ---------------------------------------------------------------------------------------------
// Power-ups: Bendy Eel, Long Line, and chasing power-up runes
// ---------------------------------------------------------------------------------------------

/** A dry, open spot on the enemy bank `d0`..`d1` metres from (bx, bz) with a clear static hook line. */
function openSpot(sim: GameSim, bx: number, bz: number, d0: number, d1: number, room: number): { x: number; z: number } | null {
  const info = mapInfo(sim.map);
  const ok = (x: number, z: number) =>
    sim.world.channel(x, z) < -1.2 && standable(info, x, z) && hookLineClear(info, bx, bz, x, z, 0.9, 0.6) && x > sim.world.riverCenter(z).x;
  for (let d = d0; d <= d1; d += 0.5) {
    for (let k = 0; k <= 10; k++) {
      for (const s of [1, -1]) {
        const a = s * k * 0.07;
        const x = bx + Math.cos(a) * d;
        const z = bz + Math.sin(a) * d;
        if (ok(x, z) && (room <= 0 || ok(x, z + room) || ok(x, z - room))) return { x, z };
      }
    }
  }
  return null;
}

/**
 * Put the dummy on its spot and let the bot watch it stand there for a moment before it may throw:
 * a 20 m teleport would otherwise read as a 40 m/s sprint and every shot would be led off into space.
 */
function placed(sim: GameSim, bot: Unit, dummy: Unit, sp: { x: number; z: number }): void {
  for (let i = 0; i < 12; i++) {
    dummy.x = sp.x;
    dummy.z = sp.z;
    bot.cdHook = Math.max(bot.cdHook, 0.2);
    sim.step();
  }
}

function duelOn(mapId: MapId, diff: BotDifficulty, seed: number) {
  const r = duel(mapId, diff, seed);
  r.bot.gold = 0; // no shopping: keep the hook at its base range and speed
  return r;
}

/** Throws at a dummy that sidesteps 0.6 s along the bank the moment each hook leaves the hand. */
function sidestepThrows(mapId: MapId, seed: number, bendy: boolean): { throws: number; hits: number; steers: number } {
  const { sim, bot, dummy } = duelOn(mapId, 'hard', seed);
  run(sim, 7);
  const sp = openSpot(sim, bot.x, bot.z, 12.5, 16.5, 2.6);
  if (!sp) return { throws: 0, hits: 0, steers: 0 };
  placed(sim, bot, dummy, sp);
  const info = mapInfo(sim.map);
  let throws = 0;
  let hits = 0;
  let launched = -1;
  let dir = 1;
  for (let i = 0; i < TICK_RATE * 8 && throws < 3; i++) {
    if (bendy) bot.bendy = 15;
    if (dummy.state === UnitState.Alive && dummy.hookedBy < 0) {
      if (launched < 0) {
        dummy.x = sp.x;
        dummy.z = sp.z;
      } else if (sim.tick - launched < 18) dummy.z += (dir * 6.2) / TICK_RATE;
      dummy.spawnProt = 0;
    }
    sim.step();
    for (const e of sim.events) {
      if (e.e === 'hookLaunch' && e.u === 1 && e.k === 0) {
        launched = sim.tick;
        throws++;
        dir = standable(info, sp.x, sp.z + 2.6) && hookLineClear(info, bot.x, bot.z, sp.x, sp.z + 2.6, 0.9, 0.6) ? 1 : -1;
      }
      if (e.e === 'hookHit' && e.u === 1 && e.tg === 2) hits++;
      if (e.e === 'hookDone' && e.u === 1) launched = -1;
    }
    if (dummy.state === UnitState.Dead) break;
  }
  return { throws, hits, steers: botInfo(bot)!.stats.bendySteers };
}

test('power-ups: a Bendy Eel hook steers into a target that sidesteps (a plain hook misses)', (t) => {
  let bt = 0;
  let bh = 0;
  let pt = 0;
  let ph = 0;
  let steers = 0;
  for (const [gi, mapId] of MAP_IDS.entries()) {
    const a = sidestepThrows(mapId, 40 + gi, true);
    const b = sidestepThrows(mapId, 40 + gi, false);
    bt += a.throws;
    bh += a.hits;
    steers += a.steers;
    pt += b.throws;
    ph += b.hits;
  }
  t.diagnostic(`sidestepping target: Bendy Eel ${bh}/${bt} hit (${steers} ticks steered), plain hook ${ph}/${pt} hit`);
  assert.ok(bt >= 8 && pt >= 8, 'the bot should throw at the dummy with and without the rune');
  assert.ok(steers > bt * 3, 'the bot should steer its Bendy Eel hooks in flight');
  assert.ok(bh / bt >= 0.6, `Bendy Eel hooks hit only ${bh} of ${bt}`);
  assert.ok(bh / bt > ph / pt + 0.3, 'steering should beat a plain hook against a sidestep');
});

test('power-ups: Long Line lets a bot hook a target beyond its normal range, and only then', (t) => {
  let hits = 0;
  let longshots = 0;
  let tried = 0;
  let plainThrows = 0;
  for (const [gi, mapId] of MAP_IDS.entries()) {
    for (const long of [true, false]) {
      const { sim, bot, dummy } = duelOn(mapId, 'brutal', 70 + gi);
      run(sim, 7);
      // past the base reach (16 m + hand and bodies, about 17.9 m), inside Long Line's (24 m + about 1.9 m)
      const sp = openSpot(sim, bot.x, bot.z, 21, 22.5, 0);
      if (!sp) continue;
      placed(sim, bot, dummy, sp);
      if (long) tried++;
      let hit = false;
      for (let i = 0; i < TICK_RATE * 9 && !hit; i++) {
        if (long) bot.longshot = 15;
        if (dummy.state === UnitState.Alive && dummy.hookedBy < 0) {
          dummy.x = sp.x;
          dummy.z = sp.z;
          dummy.spawnProt = 0;
        }
        sim.step();
        for (const e of sim.events) {
          if (e.e === 'hookLaunch' && e.u === 1 && e.k === 0 && !long) plainThrows++;
          if (e.e === 'hookHit' && e.u === 1 && e.tg === 2) hit = true;
        }
      }
      if (long && hit) hits++;
      if (long) longshots += botInfo(bot)!.stats.longshots;
    }
  }
  t.diagnostic(`Long Line: ${hits}/${tried} long-range catches (${longshots} long throws); without it, ${plainThrows} throws at the same target`);
  assert.ok(tried >= 6, `only ${tried} maps had a long open line`);
  assert.ok(hits >= tried - 1, `Long Line caught only ${hits} of ${tried}`);
  assert.ok(longshots >= hits, 'long throws should be counted');
  assert.equal(plainThrows, 0, 'without Long Line the target is out of reach');
});

test('power-ups: bots hook power-up runes off the river', (t) => {
  let grabbed = 0;
  let n = 0;
  for (const [gi, mapId] of (['muckmire', 'cogwater', 'mirelight', 'lanternwharf'] as const).entries()) {
    for (const type of ['bendy', 'longshot', 'bouncy'] as const) {
      n++;
      const { sim, bot, dummy } = duelOn(mapId, 'normal', 90 + gi);
      run(sim, 6);
      const c = sim.world.riverCenter(bot.z);
      // a rune floating mid-river right across from the bot, nobody else around
      sim.runes.push({ id: 900 + n, type, x: c.x, z: bot.z, spot: -1, dragged: false });
      let got = false;
      for (let i = 0; i < TICK_RATE * 5 && !got; i++) {
        dummy.x = 30;
        sim.step();
        for (const e of sim.events) if (e.e === 'rune' && e.u === 1 && e.t === type) got = true;
      }
      if (got) grabbed++;
    }
  }
  t.diagnostic(`power-up runes hooked: ${grabbed}/${n}`);
  assert.ok(grabbed >= n - 1, `bots hooked only ${grabbed} of ${n} power-up runes`);
});

// ---------------------------------------------------------------------------------------------
// Deck layers (dry Lanternwharf): a bridge is a roof for the bed below it. A hook thrown from the
// bank or a deck flies over a unit under it, a bash or a wallop on the deck never reaches the bed.
// Bots must not waste throws, bashes or brawls on units they cannot touch, and must still hit them
// from the layer that can.
// ---------------------------------------------------------------------------------------------

interface Spot {
  x: number;
  z: number;
  under: boolean;
}

/** Hold a unit still at a spot on a deck layer, with its tick history there (no teleport sprint). */
function pin(u: Unit, s: Spot): void {
  u.x = s.x;
  u.z = s.z;
  u.tickX = s.x;
  u.tickZ = s.z;
  u.under = s.under;
  u.vx = 0;
  u.vz = 0;
}

/**
 * One brutal bot (team 0) against a still human dummy (team 1) on dry Lanternwharf, both held on their
 * spots every tick. The bot first watches for 12 ticks with everything on cooldown (so it perceives the
 * dummy where it stands), then plays for `seconds`. `each` runs before every tick.
 */
function deckDuel(seed: number, botAt: Spot, dummyAt: Spot, seconds: number, each?: (sim: GameSim, bot: Unit, dummy: Unit) => void) {
  const players: PlayerInfo[] = [
    { id: 1, name: 'Bot', team: 0, family: 'brawler', loadout: {}, isBot: true, botDifficulty: 'brutal' },
    { id: 2, name: 'Dummy', team: 1, family: 'ogre', loadout: {}, isBot: false },
  ];
  const sim = new GameSim({ ...config('lanternwharf', 'dry'), botFill: false }, players, seed);
  const bot = sim.unitById.get(1)!;
  const dummy = sim.unitById.get(2)!;
  bot.gold = 0; // no shopping: the base kit, no Ricochet Spring bank shots
  run(sim, 5);
  // layered: the two could touch (body, wallop, bash) on every tick; catchable: the bot's hook could catch the dummy
  const r = { throws: 0, hits: 0, bashes: 0, pushTicks: 0, layered: true, catchable: true };
  for (let i = 0; i < 12 + TICK_RATE * seconds; i++) {
    if (bot.state === UnitState.Alive || bot.state === UnitState.Casting) pin(bot, botAt);
    if (dummy.state === UnitState.Alive && dummy.hookedBy < 0) pin(dummy, dummyAt);
    dummy.spawnProt = 0;
    if (i < 12) {
      bot.cdHook = Math.max(bot.cdHook, 0.2);
      bot.cdBash = Math.max(bot.cdBash, 0.2);
    }
    each?.(sim, bot, dummy);
    sim.step();
    if (i < 12) continue;
    if (!sim.sameLayer(bot, dummy)) r.layered = false;
    if (!hookCanCatch(sim.world, sim.river, hookTierOf(sim.world, sim.river, bot), dummy)) r.catchable = false;
    for (const e of sim.events) {
      if (e.e === 'hookLaunch' && e.u === 1 && e.k === 0) r.throws++;
      if (e.e === 'hookHit' && e.u === 1 && e.tg === 2) r.hits++;
      if (e.e === 'bash' && e.u === 1) r.bashes++;
    }
    const info = botInfo(bot)!;
    if (info.mode === Mode.Push && Math.hypot(info.goalX - dummy.x, info.goalZ - dummy.z) < 0.6) r.pushTicks++;
    if (r.hits > 0) break;
  }
  return r;
}

test('deck layers: from the bank a bot never throws at a unit under a bridge, but still hooks it from the bed (and one on the deck from the bank)', (t) => {
  const lines: string[] = [];
  for (const [k, zb] of [10, -10].entries()) {
    const quay: Spot = { x: -8, z: zb, under: false }; // on our quay beside the bridge end
    const bed: Spot = { x: 0.2, z: zb - Math.sign(zb) * 5.5, under: false }; // out on the open bed beside the bridge
    const underIt: Spot = { x: 0.2, z: zb, under: true };
    const onTop: Spot = { x: 0.2, z: zb, under: false };
    const fromBank = deckDuel(300 + k, quay, underIt, 4);
    const guard = deckDuel(300 + k, quay, onTop, 4);
    const fromBed = deckDuel(300 + k, bed, underIt, 4);
    lines.push(`z=${zb}: bank->under ${fromBank.throws} throws; bank->deck ${guard.hits}/${guard.throws} hit; bed->under ${fromBed.hits}/${fromBed.throws} hit`);
    assert.equal(fromBank.catchable, false, 'precondition: a hook from the quay flies over a unit under the bridge');
    assert.ok(guard.catchable && fromBed.catchable, 'precondition: a hook from the quay catches a unit on the deck, one from the bed a unit under it');
    assert.equal(fromBank.throws, 0, `z=${zb}: the bot threw ${fromBank.throws} hooks from the quay at a unit under the bridge (they fly over it)`);
    assert.ok(guard.hits >= 1, `z=${zb}: the bot must still hook a unit standing on the bridge deck from the quay`);
    assert.ok(fromBed.hits >= 1, `z=${zb}: a bot on the open bed must still hook a unit under the bridge (${fromBed.throws} throws)`);
  }
  t.diagnostic(lines.join(' | '));
});

test('deck layers: a bot on a bridge never bashes the bed below it, and still bashes a unit beside it on the deck', () => {
  const noWallop = (_sim: GameSim, bot: Unit, dummy: Unit) => {
    bot.cdMelee = 9; // measure the bash decision alone
    bot.cdHook = Math.max(bot.cdHook, 1);
    dummy.hp = 50; // one bash finishes them: a bash the bot wants badly
  };
  for (const [k, zb] of [10, -10].entries()) {
    const deck: Spot = { x: 0, z: zb, under: false };
    const below = deckDuel(320 + k, deck, { x: 0.7, z: zb, under: true }, 2, noWallop);
    const beside = deckDuel(320 + k, deck, { x: 1.1, z: zb, under: false }, 2, noWallop);
    assert.equal(below.layered, false, 'precondition: the deck and the bed under it are different layers');
    assert.equal(below.bashes, 0, `z=${zb}: the bot bashed ${below.bashes} times from the deck at a unit on the bed below it`);
    assert.ok(beside.bashes >= 1, `z=${zb}: the bot must still bash a low enemy beside it on the deck`);
  }
});

/** Make the duel bot a bruiser with its hook and bash held on cooldown, to watch where it wants to walk. */
const asBruiser = (_sim: GameSim, bot: Unit) => {
  const br = bot.brain as Brain;
  br.role = 'bruiser';
  br.roleDef = ROLES.bruiser;
  bot.cdHook = Math.max(bot.cdHook, 2); // no hooking: watch where it wants to walk
  bot.cdBash = Math.max(bot.cdBash, 2);
};

test('deck layers: a bruiser out on the bed does not push to brawl a unit up on a bridge deck, and still pushes one on the bed', () => {
  for (const [k, zb] of [10, -10].entries()) {
    const bed: Spot = { x: 0, z: zb - Math.sign(zb) * 6, under: false };
    const up = deckDuel(340 + k, bed, { x: 0.2, z: zb, under: false }, 3, asBruiser);
    const down = deckDuel(340 + k, bed, { x: 0.2, z: zb - Math.sign(zb) * 3, under: false }, 3, asBruiser);
    assert.equal(up.layered, false, 'precondition: the bed and the bridge deck are different layers');
    assert.equal(up.pushTicks, 0, `z=${zb}: the bruiser on the bed pushed at a unit on the deck above it for ${up.pushTicks} ticks (it can never wallop it from there)`);
    assert.ok(down.pushTicks > 0, `z=${zb}: the bruiser must still push at an enemy on the open bed`);
  }
});

test('deck layers: a bruiser up on a bridge deck still pushes at an enemy out on the open bed (it steps off the side), never at one under its own deck', () => {
  for (const [k, zb] of [10, -10].entries()) {
    const deck: Spot = { x: 0, z: zb, under: false };
    // beside the bridge, out on the open bed: a different layer now, but one step off the deck's side reaches it
    const beside = deckDuel(360 + k, deck, { x: 0.5, z: zb - Math.sign(zb) * 4.5, under: false }, 3, asBruiser);
    // on the bed under the very deck we stand on: walking to it keeps us on top, so no wallop ever reaches it
    const below = deckDuel(360 + k, deck, { x: 1.5, z: zb, under: true }, 3, asBruiser);
    assert.equal(beside.layered, false, 'precondition: the deck and the open bed beside it are different layers');
    assert.equal(below.layered, false, 'precondition: the deck and the bed under it are different layers');
    assert.ok(beside.pushTicks > 0, `z=${zb}: the bruiser on the deck must still push at an enemy on the open bed beside the bridge`);
    assert.equal(below.pushTicks, 0, `z=${zb}: the bruiser on the deck pushed at a unit under its own deck for ${below.pushTicks} ticks (it can never wallop it from on top)`);
  }
});
