// Headless simulation tests: soak every map x river mode x hazard mode with 10 bots,
// plus targeted mechanics checks. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSim } from '../shared/sim/sim.ts';
import { DEFAULT_CONFIG, TICK_RATE, UNIT_RADIUS } from '../shared/constants.ts';
import { MAP_IDS, RIVER_MODES, HAZARD_MODES, UnitState, Btn, type MatchConfig, type PlayerInfo, type Team } from '../shared/types.ts';
import { getMap } from '../shared/maps/index.ts';

function bots(n: number): PlayerInfo[] {
  const out: PlayerInfo[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1,
      name: `Bot ${i + 1}`,
      team: (i % 2) as Team,
      family: (['brawler', 'ogre', 'bot'] as const)[i % 3],
      cosmetics: { hat: i, accent: i, face: i },
      isBot: true,
      botDifficulty: (['easy', 'normal', 'hard', 'brutal'] as const)[i % 4],
    });
  }
  return out;
}

function finite(n: number): boolean {
  return Number.isFinite(n);
}

test('soak: every map x river mode x hazard mode runs 3 minutes of 5v5 bots', () => {
  for (const mapId of MAP_IDS) {
    for (const riverMode of RIVER_MODES) {
      for (const hazards of HAZARD_MODES) {
        const config: MatchConfig = { ...DEFAULT_CONFIG, mapId, riverMode, hazards, killsToWin: 999, timeLimitSec: 900 };
        const sim = new GameSim(config, bots(10), 1234);
        let kills = 0;
        let hooksHit = 0;
        for (let i = 0; i < TICK_RATE * 180; i++) {
          sim.step();
          for (const e of sim.events) {
            if (e.e === 'kill') kills++;
            if (e.e === 'hookHit') hooksHit++;
          }
          if (i % 300 === 0) {
            for (const u of sim.units) {
              assert.ok(finite(u.x) && finite(u.z) && finite(u.hp), `${mapId}/${riverMode}/${hazards} non-finite unit ${u.id}`);
              assert.ok(Math.abs(u.x) <= sim.map.w / 2 && Math.abs(u.z) <= sim.map.d / 2, `${mapId}/${riverMode} unit ${u.id} out of bounds`);
            }
            const snap = sim.snapshotFor(1);
            assert.ok(JSON.stringify(snap).length < 20000, 'snapshot too large');
          }
        }
        assert.ok(hooksHit > 0, `${mapId}/${riverMode}/${hazards}: bots never landed a hook`);
        assert.ok(kills > 0, `${mapId}/${riverMode}/${hazards}: no kills in 3 minutes`);
      }
    }
  }
});

test('spawns and fountains are on land and clear of obstacles on every map', () => {
  for (const mapId of MAP_IDS) {
    const sim = new GameSim({ ...DEFAULT_CONFIG, mapId }, [], 1);
    for (const team of [0, 1] as const) {
      for (const p of sim.map.spawns[team]) {
        assert.ok(sim.world.channel(p.x, p.z) < -1, `${mapId} spawn in river`);
        const out = { x: 0, z: 0, hit: false };
        sim.world.resolveCircle(p.x, p.z, UNIT_RADIUS, out);
        assert.ok(!out.hit, `${mapId} spawn ${p.x},${p.z} overlaps an obstacle`);
      }
    }
  }
});

function duel(mapId = 'muckmire' as const, riverMode: MatchConfig['riverMode'] = 'deep') {
  const players: PlayerInfo[] = [
    { id: 1, name: 'A', team: 0, family: 'brawler', cosmetics: { hat: 0, accent: 0, face: 0 }, isBot: false },
    { id: 2, name: 'B', team: 1, family: 'ogre', cosmetics: { hat: 0, accent: 0, face: 0 }, isBot: false },
  ];
  const sim = new GameSim({ ...DEFAULT_CONFIG, mapId, riverMode, hazards: 'none', botFill: false }, players, 7);
  // skip countdown
  for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
  const a = sim.unitById.get(1)!;
  const b = sim.unitById.get(2)!;
  a.spawnProt = 0;
  b.spawnProt = 0;
  return { sim, a, b };
}

test('hook across the river hits, drags the target to the caster and lands it on dry ground', () => {
  const { sim, a, b } = duel();
  const ca = sim.world.riverCenter(0);
  a.x = ca.x - ca.hw - 1.5;
  a.z = 0;
  b.x = ca.x + ca.hw + 1.5;
  b.z = 0.5;
  let seq = 1;
  sim.queueInput(1, { seq: seq++, mx: 0, mz: 0, ax: b.x, az: b.z, b: Btn.Hook });
  let hit = false;
  let done = false;
  for (let i = 0; i < TICK_RATE * 3 && !done; i++) {
    sim.step();
    for (const e of sim.events) {
      if (e.e === 'hookHit') hit = true;
      if (e.e === 'hookDone') done = true;
    }
  }
  assert.ok(hit, 'hook did not hit');
  assert.ok(done, 'hook did not return');
  assert.equal(b.state, UnitState.Alive);
  assert.ok(sim.world.channel(b.x, b.z) <= 0, 'target was dropped in the water');
  assert.ok(Math.hypot(b.x - a.x, b.z - a.z) < 3, 'target not delivered next to the caster');
  assert.ok(b.hp < b.maxHp, 'no hook damage');
});

test('units on land cannot walk into deep water, but drown if knocked in', () => {
  const { sim, a, b } = duel();
  const c = sim.world.riverCenter(5);
  a.x = c.x - c.hw - 1;
  a.z = 5;
  let seq = 1;
  for (let i = 0; i < TICK_RATE * 2; i++) {
    sim.queueInput(1, { seq: seq++, mx: 1, mz: 0, ax: 10, az: 5, b: 0 });
    sim.step();
  }
  assert.ok(sim.world.channel(a.x, a.z) <= 0.01, 'walked into deep water');
  assert.equal(a.state, UnitState.Alive);
  // B bashes A into the river
  b.x = a.x - 1.6;
  b.z = a.z;
  sim.queueInput(2, { seq: 1, mx: 0, mz: 0, ax: a.x + 5, az: a.z, b: Btn.Bash });
  let drowned = false;
  for (let i = 0; i < TICK_RATE * 4; i++) {
    sim.queueInput(1, { seq: seq++, mx: 1, mz: 0, ax: 10, az: 5, b: 0 }); // keeps swimming the wrong way
    sim.step();
    for (const e of sim.events) if (e.e === 'kill' && e.cause === 'drown' && e.v === 1) drowned = true;
  }
  assert.ok(drowned, 'knocked unit did not drown');
  assert.equal(sim.score[1], 1, 'drown kill not credited to the basher team');
});

test('dry bed is walkable', () => {
  const { sim, a } = duel('muckmire', 'dry');
  const c = sim.world.riverCenter(-5);
  a.x = c.x - c.hw - 1;
  a.z = -5;
  for (let i = 0; i < TICK_RATE * 2; i++) {
    sim.queueInput(1, { seq: i + 1, mx: 1, mz: 0, ax: 10, az: -5, b: 0 });
    sim.step();
  }
  assert.ok(sim.world.channel(a.x, a.z) > 0 || a.x > c.x, 'could not walk into the dry channel');
  assert.equal(a.state, UnitState.Alive);
});

test('tidal maps cycle through low and high water', () => {
  for (const mapId of ['coralcove', 'cogwater', 'frostfang'] as const) {
    const sim = new GameSim({ ...DEFAULT_CONFIG, mapId, riverMode: 'tidal' }, [], 3);
    const phases = new Set<string>();
    for (let i = 0; i < TICK_RATE * 200; i++) {
      sim.step();
      phases.add(sim.river.phase);
    }
    const tide = getMap(mapId).tide!;
    if (tide.style === 'freeze') assert.ok(phases.has('frozen') && phases.has('thawed'), `${mapId} phases ${[...phases]}`);
    else assert.ok(phases.has('low') && phases.has('high') && phases.has('rising') && phases.has('falling'), `${mapId} phases ${[...phases]}`);
  }
});

test('hooks that meet in flight clash and both retract', () => {
  const { sim, a, b } = duel();
  a.x = -8;
  a.z = 0;
  b.x = 8;
  b.z = 0;
  // aim slightly off each other so neither hits the other body before the heads meet
  sim.queueInput(1, { seq: 1, mx: 0, mz: 0, ax: 8, az: 3, b: Btn.Hook });
  sim.queueInput(2, { seq: 1, mx: 0, mz: 0, ax: -8, az: 3, b: Btn.Hook });
  let clash = false;
  for (let i = 0; i < TICK_RATE * 2; i++) {
    sim.step();
    for (const e of sim.events) if (e.e === 'hookClash') clash = true;
  }
  assert.ok(clash, 'hooks did not clash');
});

test('snapshots hide stealthed enemies and enemy mines', () => {
  const { sim, a, b } = duel();
  b.puff = 3;
  b.x = 20;
  a.x = -20;
  sim.mines.push({ id: 999, owner: 2, team: 1, x: 10, z: 0, armT: 0, dead: false });
  sim.step();
  const snapA = sim.snapshotFor(1);
  assert.ok(!snapA.u.some((u) => u.i === 2), 'stealthed enemy leaked');
  assert.ok(!snapA.m.some((m) => m.i === 999), 'enemy mine leaked');
  const snapB = sim.snapshotFor(2);
  assert.ok(snapB.u.some((u) => u.i === 2), 'own unit missing');
  assert.ok(snapB.m.some((m) => m.i === 999), 'own mine missing');
});
