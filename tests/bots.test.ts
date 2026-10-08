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
import { DEFAULT_CONFIG, TICK_RATE } from '../shared/constants.ts';
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

test('ten bots cost well under a millisecond per tick, pathfinding included', (t) => {
  // mirelight (side channels and docks) and maelstrom (a lagoon, tides) make the bots path the most
  const cases: [MapId, RiverMode][] = [['coralcove', 'tidal'], ['cogwater', 'deep'], ['mirelight', 'deep'], ['maelstrom', 'tidal']];
  // Wall-clock timing: a busy machine (parallel test runs, builds) inflates it. The work is
  // deterministic, so the cheapest of up to three identical runs is the honest figure.
  let best = Infinity;
  let worst = 0;
  let paths = 0;
  const tries: string[] = [];
  for (let attempt = 0; attempt < 3 && best >= 0.5; attempt++) {
    setBotProfiling(true);
    resetBotProfile();
    paths = 0;
    let stepMs = 0;
    for (const [gi, [mapId, riverMode]] of cases.entries()) {
      const sim = new GameSim(config(mapId, riverMode, 'mixed'), team5(5, (_t, s) => (['easy', 'normal', 'hard', 'brutal', 'brutal'] as const)[s]), 300 + gi);
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
  t.diagnostic(`updateBots for 10 bots: ${(best * 1000).toFixed(1)} us per tick on average (runs: ${tries.join(', ')}), worst tick ${worst.toFixed(2)} ms (the first run includes the one-off nav grid build), ${paths} A* searches per run`);
  assert.ok(best < 0.5, `bots cost ${best.toFixed(3)} ms per tick`);
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
