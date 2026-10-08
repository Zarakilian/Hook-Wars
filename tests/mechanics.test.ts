// Regression tests for the hook mechanics and the review fixes (2026-10-08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSim } from '../shared/sim/sim.ts';
import { riverStateAt } from '../shared/sim/river.ts';
import { BAL, DEFAULT_CONFIG, HOOK_LEVELS, TICK_RATE } from '../shared/constants.ts';
import { getMap } from '../shared/maps/index.ts';
import { Btn, UnitState, type MatchConfig, type PlayerInfo, type Team } from '../shared/types.ts';

function players(teams: Team[]): PlayerInfo[] {
  return teams.map((team, i) => ({ id: i + 1, name: `P${i + 1}`, team, family: 'brawler', loadout: {}, isBot: false }));
}

function setup(teams: Team[], cfg: Partial<MatchConfig> = {}) {
  const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: false, ...cfg }, players(teams), 11);
  for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
  for (const u of sim.units) u.spawnProt = 0;
  return sim;
}

let seq = 1;
function input(sim: GameSim, id: number, mx: number, mz: number, ax: number, az: number, b = 0) {
  sim.queueInput(id, { seq: seq++, mx, mz, ax, az, b });
}

test('you keep walking through the hook wind-up and while the hook flies', () => {
  const sim = setup([0, 1]);
  const a = sim.unitById.get(1)!;
  a.x = -20;
  a.z = -10;
  // walk north for a moment, then throw east while still walking north
  for (let i = 0; i < 10; i++) {
    input(sim, 1, 0, -1, 0, -10);
    sim.step();
  }
  const z0 = a.z;
  input(sim, 1, 0, -1, 10, a.z, Btn.Hook);
  sim.step();
  assert.equal(a.state, UnitState.Alive, 'hook wind-up must not root');
  assert.equal(a.castKind, 'hook');
  for (let i = 0; i < 6; i++) {
    input(sim, 1, 0, -1, 10, a.z);
    sim.step();
  }
  assert.ok(a.activeHook >= 0, 'hook did not launch');
  assert.ok(z0 - a.z > 0.8, `unit did not keep walking (moved ${(z0 - a.z).toFixed(2)} m)`);
  const h = sim.hookById(a.activeHook)!;
  assert.ok(h.dx > 0.95, 'hook should fly where it was aimed (east), not where the unit walks');
  assert.ok(Math.abs(a.moveMul - BAL.hookMoveSlow * 1.08) < 1e-6, `moveMul ${a.moveMul}`);
});

test('Belly Bash still plants your feet for its short lunge', () => {
  const sim = setup([0, 1]);
  const a = sim.unitById.get(1)!;
  input(sim, 1, 1, 0, 10, 0, Btn.Bash);
  sim.step();
  assert.equal(a.state, UnitState.Casting);
});

test('Bendy Eel: the flying hook curves toward the live cursor', () => {
  const sim = setup([0, 1], { riverMode: 'dry' });
  const a = sim.unitById.get(1)!;
  // a lane with nothing in the way for the first stretch, so the hook flies freely
  const lane = [-8, -6, -4, -2, 0, 2, 4, 6, 8].find((z) => sim.world.lineClear(-22, z, -10, z, 0.8) && sim.world.lineClear(-22, z, -14, z + 6, 0.8));
  assert.ok(lane !== undefined, 'no clear lane on this map');
  a.x = -22;
  a.z = lane!;
  sim.grantRune(a, 'bendy');
  input(sim, 1, 0, 0, 0, lane!, Btn.Hook); // aim east
  for (let i = 0; i < 5; i++) {
    input(sim, 1, 0, 0, 0, lane!);
    sim.step();
  }
  const h = sim.hookById(a.activeHook)!;
  assert.ok(h, 'hook did not launch');
  assert.ok(h.steer, 'hook should be steerable');
  for (let i = 0; i < 6; i++) {
    input(sim, 1, 0, 0, -14, lane! + 14); // swing the cursor south
    sim.step();
  }
  assert.ok(h.z > lane! + 0.8, `bendy hook did not curve toward the cursor (dz=${(h.z - lane!).toFixed(2)})`);
  assert.ok(h.pts.length >= 2, 'chain should record bend points');
});

test('Boing Barb ricochets without the Ricochet Spring item; Long Line reaches 50% further', () => {
  const sim = setup([0, 1]);
  const a = sim.unitById.get(1)!;
  sim.grantRune(a, 'bouncy');
  sim.grantRune(a, 'longshot');
  a.x = -20;
  a.z = 0;
  input(sim, 1, 0, 0, -20, -30, Btn.Hook); // straight into the north map edge? use an obstacle-free throw
  for (let i = 0; i < 6; i++) {
    input(sim, 1, 0, 0, -20, -30);
    sim.step();
  }
  const h = sim.hookById(a.activeHook)!;
  assert.ok(h.ricochet && h.bounces >= BAL.bouncyBounces, 'bouncy hook should ricochet');
  assert.equal(h.range, HOOK_LEVELS.range[0] * BAL.longshotRangeMul);
});

test('Iron Gut cannot be sold and re-bought as a free heal', () => {
  const sim = setup([0, 1]);
  const a = sim.unitById.get(1)!;
  a.gold = 5000;
  a.hp = 120;
  for (let i = 0; i < 4; i++) {
    assert.ok(sim.buy(1, 'irongut'));
    const slot = a.items.findIndex((s) => s && s.id === 'irongut');
    sim.sell(1, slot);
  }
  assert.equal(a.hp, 120, 'buy/sell loop changed hp');
  // owned from the start, low hp: the sale is refused
  sim.buy(1, 'irongut');
  a.hp = 200;
  const slot = a.items.findIndex((s) => s && s.id === 'irongut');
  assert.equal(sim.sell(1, slot), false);
});

test('a rising tide never turns lethal before the high-tide moment', () => {
  for (const mapId of ['coralcove', 'cogwater'] as const) {
    const map = getMap(mapId);
    const cfg = { ...DEFAULT_CONFIG, mapId, riverMode: 'tidal' as const };
    let sawHighDeep = false;
    for (let t = 0; t < 200; t += 0.05) {
      const s = riverStateAt(map, cfg, t);
      if (s.phase === 'rising') assert.equal(s.deep, false, `${mapId} deep during rising at t=${t.toFixed(2)}`);
      if (s.phase === 'high' && s.deep) sawHighDeep = true;
    }
    assert.ok(sawHighDeep);
  }
});

test("allies' hooks pass through each other and both can reach the enemy", () => {
  const sim = setup([0, 0, 1], { riverMode: 'dry' });
  const [a, b, e] = [sim.unitById.get(1)!, sim.unitById.get(2)!, sim.unitById.get(3)!];
  a.x = -7;
  a.z = -2;
  b.x = -7;
  b.z = -0.4;
  e.x = 7;
  e.z = -1.2;
  input(sim, 1, 0, 0, e.x, e.z, Btn.Hook);
  input(sim, 2, 0, 0, e.x, e.z, Btn.Hook);
  let clash = false;
  let hit = false;
  for (let i = 0; i < TICK_RATE * 2; i++) {
    sim.step();
    for (const ev of sim.events) {
      if (ev.e === 'hookClash') clash = true;
      if (ev.e === 'hookHit' && ev.tg === 3) hit = true;
    }
  }
  assert.equal(clash, false, 'ally hooks clashed');
  assert.ok(hit, 'neither hook reached the enemy');
});

test('a same-tick double death at the target goes to overtime instead of a wrong winner', () => {
  const sim = setup([0, 1], { killsToWin: 5 });
  sim.score = [4, 4];
  const [a, b] = [sim.unitById.get(1)!, sim.unitById.get(2)!];
  a.hp = 1;
  b.hp = 1;
  a.burnT = b.burnT = 1;
  a.burnDps = b.burnDps = 1000;
  sim.step();
  assert.deepEqual(sim.score, [5, 5]);
  assert.notEqual(sim.phase, 'ended', 'match ended on a tie');
  assert.equal(sim.overtime, true);
});

test('being knocked around while drowning does not reset the drown clock', () => {
  const sim = setup([0, 1]);
  const [a, b] = [sim.unitById.get(1)!, sim.unitById.get(2)!];
  const c = sim.world.riverCenter(5);
  a.x = c.x;
  a.z = 5;
  for (let i = 0; i < Math.round(TICK_RATE * 1.6); i++) sim.step();
  assert.equal(a.state, UnitState.Drowning);
  const before = a.drownT;
  sim.knock(a, 0, 1, 1, 0.2, 0.3);
  let died = -1;
  for (let i = 0; i < TICK_RATE * 2 && died < 0; i++) {
    sim.step();
    for (const ev of sim.events) if (ev.e === 'kill' && ev.v === 1) died = i;
  }
  assert.ok(before > 1.4);
  assert.ok(died >= 0 && died < TICK_RATE * 0.9, `drowned too late (${died} ticks after the knock)`);
  void b;
});

test('an Iron Skin shield that soaks a bash still credits the basher for the drowning', () => {
  const sim = setup([0, 1]);
  const [a, b] = [sim.unitById.get(1)!, sim.unitById.get(2)!];
  const c = sim.world.riverCenter(5);
  a.x = c.x - c.hw - 1;
  a.z = 5;
  b.x = a.x - 1.6;
  b.z = a.z;
  a.shield = BAL.ironskinShield;
  a.shieldT = BAL.ironskinTime;
  input(sim, 2, 0, 0, a.x + 5, a.z, Btn.Bash);
  let killer = -99;
  for (let i = 0; i < TICK_RATE * 4; i++) {
    input(sim, 1, 1, 0, 10, 5);
    sim.step();
    for (const ev of sim.events) if (ev.e === 'kill' && ev.v === 1) killer = ev.k;
  }
  assert.equal(killer, 2, 'drowning kill not credited to the basher');
});

test('grappling a drifting log in Deep Water does not drop you in the river', () => {
  const sim = setup([0, 1]);
  const a = sim.unitById.get(1)!;
  const pose = sim.world.moverPoses[0];
  const c = sim.world.riverCenter(pose.z);
  a.x = c.x - c.hw - 1.2;
  a.z = pose.z;
  input(sim, 1, 0, 0, pose.x, pose.z, Btn.Grapple);
  for (let i = 0; i < TICK_RATE * 2; i++) {
    input(sim, 1, 0, 0, pose.x, pose.z);
    sim.step();
  }
  assert.notEqual(a.state, UnitState.Dead);
  assert.notEqual(a.state, UnitState.Drowning);
});

test('a stealthed unit that gets hooked is revealed to everyone', () => {
  const sim = setup([0, 1, 1], { riverMode: 'dry' });
  const [enemyHooker, ally, ghost] = [sim.unitById.get(1)!, sim.unitById.get(2)!, sim.unitById.get(3)!];
  ghost.puff = 3;
  ghost.x = 10;
  ghost.z = 0;
  ally.x = 18;
  ally.z = 0;
  enemyHooker.x = -20;
  input(sim, 2, 0, 0, ghost.x, ghost.z, Btn.Hook); // its own ally hooks it
  for (let i = 0; i < 12; i++) sim.step();
  assert.equal(ghost.puff, 0, 'hooked unit kept its stealth');
  const snap = sim.snapshotFor(1);
  assert.ok(snap.u.some((u) => u.i === 3));
});
