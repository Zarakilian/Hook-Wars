// Regression tests for the hook mechanics and the review fixes (2026-10-08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSim } from '../shared/sim/sim.ts';
import { riverStateAt } from '../shared/sim/river.ts';
import { BAL, DEFAULT_CONFIG, HOOK_LEVELS, TICK_RATE } from '../shared/constants.ts';
import { getMap } from '../shared/maps/index.ts';
import { Btn, MAP_IDS, UFlag, UnitState, type MapId, type MatchConfig, type PlayerInfo, type Team } from '../shared/types.ts';
import { channelDepthAt, platformAt, riverAt } from '../shared/maps/helpers.ts';
import { stepMove, type MoveBody } from '../shared/sim/movement.ts';
import { buildHazards } from '../shared/sim/hazards.ts';
import type { CircleObstacle, MapDef } from '../shared/maps/types.ts';
import { World } from '../shared/world.ts';

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

// ---------------------------------------------------------------------------------------------
// Deck layering (2026-10-09): docks and bridges are land from the bank, a roof from the bed
// ---------------------------------------------------------------------------------------------

/** A Mirelight deck over a channel, a point in the open channel next to it and a point on the bank next to it. */
function deckApproach(mapId: 'mirelight' | 'lanternwharf') {
  const map = getMap(mapId);
  for (const p of map.platforms ?? []) {
    if (channelDepthAt(map, p.x, p.z, true) <= 0) continue;
    let fromChannel: { x: number; z: number } | null = null;
    let fromBank: { x: number; z: number } | null = null;
    for (let a = 0; a < Math.PI * 2 && (!fromChannel || !fromBank); a += Math.PI / 24) {
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      let d = 0;
      while (d < 20 && platformAt(map, p.x + dx * d, p.z + dz * d) === p) d += 0.1;
      const x = p.x + dx * (d + 0.9);
      const z = p.z + dz * (d + 0.9);
      if (platformAt(map, x, z) || Math.abs(x) > 34 || Math.abs(z) > 22) continue;
      const inner = channelDepthAt(map, p.x + dx * (d - 0.3), p.z + dz * (d - 0.3), true);
      if (!fromChannel && channelDepthAt(map, x, z) > 0.6 && inner > 0) fromChannel = { x, z };
      if (!fromBank && channelDepthAt(map, x, z) < -0.6 && inner < 0) fromBank = { x, z };
    }
    if (fromChannel && fromBank) return { map, p, fromChannel, fromBank };
  }
  throw new Error(`${mapId}: no deck with both a channel and a bank approach`);
}

function walkTo(sim: GameSim, id: number, x: number, z: number, ticks: number, each?: () => void) {
  const u = sim.unitById.get(id)!;
  for (let i = 0; i < ticks; i++) {
    const dx = x - u.x;
    const dz = z - u.z;
    const l = Math.hypot(dx, dz) || 1;
    input(sim, id, dx / l, dz / l, x, z);
    sim.step();
    each?.();
    if (l < 0.3) break;
  }
}

test('dry bed: walking into a dock from the bed goes UNDER it, from the bank goes ON it', () => {
  const { p, fromChannel, fromBank } = deckApproach('mirelight');
  const sim = setup([0, 1], { mapId: 'mirelight', riverMode: 'dry' });
  const a = sim.unitById.get(1)!;
  a.x = fromChannel.x;
  a.z = fromChannel.z;
  let sawUnder = false;
  walkTo(sim, 1, p.x, p.z, TICK_RATE * 6, () => {
    if (a.under) sawUnder = true;
  });
  assert.ok(sawUnder && a.under, 'a unit walking in from the bed must stay under the deck');
  assert.ok(sim.world.channelFor(a.x, a.z, a.under) > 0, 'under the deck the unit is in the channel');
  const me = sim.snapshotFor(1).u.find((u) => u.i === 1)!;
  assert.ok(me.fl & UFlag.UnderDeck, 'the snapshot carries UnderDeck');
  // back out into the open channel: the layer clears
  walkTo(sim, 1, fromChannel.x, fromChannel.z, TICK_RATE * 6);
  assert.equal(a.under, false);

  // from the bank: on top the whole way
  a.x = fromBank.x;
  a.z = fromBank.z;
  for (let i = 0; i < 2; i++) sim.step();
  let everUnder = false;
  let onDeck = false;
  walkTo(sim, 1, p.x, p.z, TICK_RATE * 6, () => {
    if (a.under) everUnder = true;
    if (platformAt(sim.map, a.x, a.z) && channelDepthAt(sim.map, a.x, a.z, true) > 0) onDeck = true;
  });
  assert.ok(onDeck, 'the unit never walked out over the channel on the deck');
  assert.equal(everUnder, false, 'a unit walking on from the bank must stay on top of the deck');
  assert.ok(sim.world.channelFor(a.x, a.z, a.under) <= 0, 'on the deck the unit is on land');
});

test('deep water: a swimmer climbs onto a dock like onto the bank', () => {
  const { p, fromChannel } = deckApproach('mirelight');
  const sim = setup([0, 1], { mapId: 'mirelight', riverMode: 'deep' });
  const a = sim.unitById.get(1)!;
  // start right at the deck edge, in the water
  const dx = p.x - fromChannel.x;
  const dz = p.z - fromChannel.z;
  const l = Math.hypot(dx, dz);
  a.x = fromChannel.x + (dx / l) * 0.7;
  a.z = fromChannel.z + (dz / l) * 0.7;
  walkTo(sim, 1, p.x, p.z, TICK_RATE * 3);
  assert.equal(a.under, false, 'deep water never puts a unit under a deck');
  assert.ok(platformAt(sim.map, a.x, a.z), 'the swimmer should end on the deck');
  assert.equal(a.state, UnitState.Alive, 'on the deck the swimmer is out of the water');
  assert.notEqual(a.state, UnitState.Dead, 'the swimmer should reach the deck before drowning');
});

test('prediction and the server agree on the deck layer (same stepMove)', () => {
  const { map, p, fromChannel } = deckApproach('mirelight');
  const world = new World(map);
  const river = { level: 0, deep: false, shallow: false, frozen: false, phase: 'none' as const, phaseLeft: 0, cycle: false };
  const body: MoveBody = { x: fromChannel.x, z: fromChannel.z, vx: 0, vz: 0, under: false };
  let entered = false;
  for (let i = 0; i < TICK_RATE * 6; i++) {
    const dx = p.x - body.x;
    const dz = p.z - body.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.3) break;
    stepMove(world, river, body, dx / l, dz / l, 1, 1 / TICK_RATE);
    if (platformAt(map, body.x, body.z)) entered = true;
  }
  assert.ok(entered, 'the body never reached the deck');
  assert.equal(body.under, true, 'stepMove alone must apply the deck layer, so the predictor matches the sim');
});

// ---------------------------------------------------------------------------------------------
// v2 review fixes, mechanics lens (2026-10-09): findings 1 to 9
// ---------------------------------------------------------------------------------------------

/** First matchTime (to 1/600 s) at which a tidal river turns deep after having been not deep. */
function deepAt(map: MapDef, cfg: MatchConfig): number {
  let was = true;
  let seen = false;
  for (let t = 0; t < 400; t += 1 / 600) {
    const s = riverStateAt(map, cfg, t);
    if (!s.deep) seen = true;
    if (seen && s.deep && !was) return t;
    was = s.deep;
  }
  throw new Error(`${map.id}: the river never turns deep`);
}

/** Freeze drifting logs, floes and barges so they never wander into a scripted test. */
function noMovers(sim: GameSim) {
  Object.assign(sim.world, { updateMovers: () => {} });
  for (const p of sim.world.moverPoses) p.active = false;
}

function place(u: { x: number; z: number; tickX: number; tickZ: number; under: boolean; vx: number; vz: number }, x: number, z: number, under = false) {
  u.x = x;
  u.z = z;
  u.tickX = x;
  u.tickZ = z;
  u.under = under;
  u.vx = u.vz = 0;
}

// --- 1 --------------------------------------------------------------------------------------
test('1: a grapple winding up or flying when the tide turns deep is not cancelled: it latches and the unit lives', () => {
  const mapId: MapId = 'mirelight';
  const map = getMap(mapId);
  const cfg: MatchConfig = { ...DEFAULT_CONFIG, mapId, riverMode: 'tidal', hazards: 'none', botFill: false };
  // a unit on the main river's centre line, too far from the bank to swim out in time, and a post on land
  // with a clear line (same pick as the review's f1_grapple_flood)
  let pick: { ux: number; uz: number; ox: number; oz: number } | null = null;
  const world = new World(map);
  world.updateMovers(0, false);
  for (let z = -12; z <= 12 && !pick; z += 1) {
    const c = riverAt(map.river.points, z);
    if (channelDepthAt(map, c.x, z, true) < 1.5 || platformAt(map, c.x, z)) continue;
    const cands = map.obstacles
      .filter((o): o is CircleObstacle => o.shape === 'circle' && channelDepthAt(map, o.x, o.z) < -0.5)
      .map((o) => ({ o, d: Math.hypot(o.x - c.x, o.z - z) }))
      .filter((q) => q.d > 5 && q.d < 15)
      .sort((a, b) => a.d - b.d);
    for (const q of cands) {
      const hit = world.sweep(c.x, z, q.o.x, q.o.z, 0.35);
      if (hit && hit.what === 'obstacle' && map.obstacles[hit.index] === q.o) {
        pick = { ux: c.x, uz: z, ox: q.o.x, oz: q.o.z };
        break;
      }
    }
  }
  assert.ok(pick, 'no river spot with a clear anchor');
  const tDeep = deepAt(map, cfg);
  let sawWindup = 0;
  let sawFlying = 0;
  for (let lead = 1; lead <= 12; lead++) {
    const sim = setup([0, 1], cfg);
    noMovers(sim);
    const u = sim.unitById.get(1)!;
    place(sim.unitById.get(2)!, 30, 18);
    sim.matchTime = tDeep - (lead + 6) / TICK_RATE + 1e-4; // the press goes out on step 7, `lead` steps before the deep one
    place(u, pick!.ux, pick!.uz);
    let latched = false;
    let dead = false;
    let launches = 0;
    for (let i = 0; i < TICK_RATE * 4 && !dead; i++) {
      const wasDeep = sim.river.deep;
      const preWind = u.castKind === 'grapple';
      const g = u.activeGrapple >= 0 ? sim.hookById(u.activeGrapple) : undefined;
      const preFly = !!g && g.phase === 0;
      input(sim, 1, 0, 0, pick!.ox, pick!.oz, i === 6 ? Btn.Grapple : 0);
      sim.step();
      if (!wasDeep && sim.river.deep && i > 6) {
        if (preWind) sawWindup++;
        if (preFly) sawFlying++;
      }
      for (const ev of sim.events) if (ev.e === 'hookLaunch' && ev.u === 1 && ev.k === 1) launches++;
      if (u.state === UnitState.Grappling) latched = true;
      if (u.state === UnitState.Dead) dead = true;
    }
    assert.ok(latched, `grapple pressed ${lead} tick(s) before the flood never latched (cooldown ${u.cdGrapple.toFixed(1)} s spent)`);
    assert.equal(dead, false, `grapple pressed ${lead} tick(s) before the flood: the unit drowned`);
    assert.equal(launches, 1, 'exactly one grapple per press');
  }
  assert.ok(sawWindup > 0, 'no case had the grapple still winding up at the flood');
  assert.ok(sawFlying > 0, 'no case had the grapple in flight at the flood');
});

test('1: a grapple press buffered just before the flood fires once and still pays the full cooldown', () => {
  const mapId: MapId = 'mirelight';
  const cfg: MatchConfig = { ...DEFAULT_CONFIG, mapId, riverMode: 'tidal', hazards: 'none', botFill: false };
  const sim = setup([0, 1], cfg);
  noMovers(sim);
  const u = sim.unitById.get(1)!;
  place(sim.unitById.get(2)!, 30, 18);
  const tDeep = deepAt(sim.map, cfg);
  sim.matchTime = tDeep - 2 / TICK_RATE - 0.001;
  const c = riverAt(sim.map.river.points, -9);
  place(u, c.x, -9);
  const o = sim.map.obstacles
    .filter((q): q is CircleObstacle => q.shape === 'circle')
    .sort((a, b) => Math.hypot(a.x - u.x, a.z - u.z) - Math.hypot(b.x - u.x, b.z - u.z))
    .find((q) => q.x < u.x - 4)!;
  u.cdGrapple = 0.25; // pressed a moment early: the press is buffered
  input(sim, 1, 0, 0, o.x, o.z, Btn.Grapple);
  sim.step();
  assert.equal(u.buffered?.kind, 'grapple', 'precondition: the early press is buffered');
  let launches = 0;
  let cdAtLaunch = -1;
  let wentDeep = false;
  for (let i = 0; i < TICK_RATE * 1.5; i++) {
    input(sim, 1, 0, 0, o.x, o.z);
    sim.step();
    if (sim.river.deep) wentDeep = true;
    for (const ev of sim.events) {
      if (ev.e === 'hookLaunch' && ev.u === 1 && ev.k === 1) {
        launches++;
        if (cdAtLaunch < 0) cdAtLaunch = u.cdGrapple;
      }
    }
  }
  assert.ok(wentDeep, 'precondition: the water turned deep');
  assert.equal(launches, 1, 'the buffered grapple must still fire once after the flood');
  assert.ok(cdAtLaunch > BAL.grappleCooldown - 0.1, `the buffered grapple fired without paying its cooldown (cd ${cdAtLaunch.toFixed(2)})`);
});

// --- 2 --------------------------------------------------------------------------------------
test('2: a unit under a bridge when the locks flood climbs onto the deck instead of drowning under it', () => {
  const cfg: MatchConfig = { ...DEFAULT_CONFIG, mapId: 'lanternwharf', riverMode: 'tidal', hazards: 'none', botFill: false };
  for (const sx of [0, 2.5, -3.5]) {
    const sim = setup([0, 1], cfg);
    noMovers(sim);
    const u = sim.unitById.get(1)!;
    place(sim.unitById.get(2)!, 30, -18);
    const tDeep = deepAt(sim.map, cfg);
    sim.matchTime = tDeep - 2.5;
    place(u, sx, 6.5); // in the open canal, wading in under the z = 10 bridge during the rising tide
    let wasUnder = false;
    while (sim.matchTime < tDeep - 1e-6) {
      const dx = sx - u.x;
      const dz = 10 - u.z;
      const l = Math.hypot(dx, dz);
      input(sim, 1, l > 0.1 ? dx / l : 0, l > 0.1 ? dz / l : 0, 0, 0);
      sim.step();
      if (!sim.river.deep) wasUnder = u.under;
    }
    assert.ok(wasUnder, 'precondition: the unit waded in under the bridge');
    assert.ok(sim.river.deep, 'precondition: the canal is deep');
    assert.ok(platformAt(sim.map, u.x, u.z), 'precondition: the unit is inside the bridge footprint');
    assert.equal(u.under, false, `x=${sx}: still under the bridge in deep water`);
    assert.equal(u.state, UnitState.Alive, `x=${sx}: the unit should be on the deck, out of the water`);
    for (let i = 0; i < TICK_RATE * 3; i++) {
      input(sim, 1, 0, 0, 0, 0);
      sim.step();
    }
    assert.notEqual(u.state, UnitState.Dead, `x=${sx}: drowned under the bridge`);
  }
  // the client predictor runs the same stepMove: it must clear the layer too
  const map = getMap('lanternwharf');
  const body: MoveBody = { x: 0, z: 10, vx: 0, vz: 0, under: true };
  const deep = { level: 1, deep: true, shallow: false, frozen: false, phase: 'high' as const, phaseLeft: 10, cycle: true };
  stepMove(new World(map), deep, body, 0, 0, 1, 1 / TICK_RATE);
  assert.equal(body.under, false, 'stepMove keeps a body under a deck in deep water');
});

// --- 3 --------------------------------------------------------------------------------------
test('3: the whirlpool bends hooks only where there is water deep enough to show it', () => {
  for (const mapId of ['coralcove', 'maelstrom'] as const) {
    for (const mode of ['dry', 'tidal-low', 'deep'] as const) {
      const sim = setup([0, 1], { mapId, riverMode: mode === 'tidal-low' ? 'tidal' : mode });
      if (mode === 'tidal-low') {
        for (let t = 0; t < 200; t += 0.5) {
          const s = riverStateAt(sim.map, sim.config, t);
          if (s.phase === 'low' && s.phaseLeft > 10) {
            sim.matchTime = t;
            break;
          }
        }
      }
      noMovers(sim);
      const u = sim.unitById.get(1)!;
      place(sim.unitById.get(2)!, 30, 20);
      const wp = sim.map.whirlpool!;
      // a throw from the west bank straight across the whirlpool's edge (start spot clear of rocks)
      const free = { x: 0, z: 0, hit: false };
      const z0 = [0.3, -0.3, 0.1, -0.1, 0.5, -0.5, 0.2, -0.2, 0.4, -0.4].map((k) => wp.z + wp.r * k).find((z) => {
        sim.world.resolveCircle(wp.x - 7.6, z, 0.75, free);
        return !free.hit;
      })!;
      assert.ok(z0 !== undefined, `${mapId}: no clear spot to throw from`);
      place(u, wp.x - 7.6, z0);
      input(sim, 1, 0, 0, wp.x + 7.6, z0, Btn.Hook);
      let start: { x: number; z: number; dx: number; dz: number } | null = null;
      let off = 0;
      let inside = false;
      for (let i = 0; i < TICK_RATE; i++) {
        input(sim, 1, 0, 0, wp.x + 7.6, z0, 0);
        sim.step();
        const h = sim.hookById(u.activeHook);
        if (!h || h.phase !== 0) continue;
        start ??= { x: h.x, z: h.z, dx: h.dx, dz: h.dz };
        off = Math.max(off, Math.abs((h.x - start.x) * start.dz - (h.z - start.z) * start.dx));
        if (Math.hypot(h.x - wp.x, h.z - wp.z) < wp.r * 0.8) inside = true;
      }
      assert.ok(start && inside, `${mapId}/${mode}: precondition: the hook flew through the whirlpool`);
      if (mode === 'deep') {
        assert.ok(off > 1, `${mapId}: the whirlpool should still bend hooks in deep water (off-line ${off.toFixed(2)} m)`);
        assert.ok(sim.activeWhirlpool(), `${mapId}: deep water shows the whirlpool`);
      } else {
        assert.ok(off < 0.02, `${mapId}/${mode} (level ${sim.river.level.toFixed(2)}): hook bent ${off.toFixed(2)} m off its line by an invisible whirlpool`);
        assert.equal(sim.activeWhirlpool(), undefined);
      }
    }
  }
});

// --- 4 --------------------------------------------------------------------------------------
test('4: Mixed hazards: a slot and its mirror get the same kind, and mirrored periodic hazards fire together', () => {
  let pairs = 0;
  for (const mapId of MAP_IDS) {
    const map = getMap(mapId);
    for (const riverMode of ['deep', 'dry', 'tidal'] as const) {
      for (const hazards of ['mixed', 'special'] as const) {
        for (let seed = 1; seed <= 12; seed++) {
          const hs = buildHazards(map, { ...DEFAULT_CONFIG, mapId, riverMode, hazards }, seed * 7919);
          hs.forEach((h, i) => assert.equal(h.id, i, 'hazard ids stay the filtered index'));
          for (const a of hs) {
            const b = hs.find((h) => Math.abs(h.x + a.x) < 1e-6 && Math.abs(h.z + a.z) < 1e-6);
            if (!b || b === a) continue;
            pairs++;
            const where = `${mapId}/${riverMode}/${hazards} seed ${seed}: (${a.x},${a.z}) vs (${b.x},${b.z})`;
            assert.equal(a.kind, b.kind, `${where} kinds differ`);
            assert.equal(a.offset, b.offset, `${where} timing differs`);
          }
        }
      }
    }
  }
  assert.ok(pairs > 500, `only ${pairs} mirrored pairs checked`);
});

// --- 5 --------------------------------------------------------------------------------------
test('5: an input burst over the queue cap keeps every press on its own input with its own aim', () => {
  for (const n of [21, 25, 30, 45]) {
    const sim = setup([0, 1], { mapId: 'cogwater', riverMode: 'dry' });
    const u = sim.unitById.get(1)!;
    place(u, -20, 0);
    place(sim.unitById.get(2)!, 25, 18);
    // after an uplink stall a burst arrives between two ticks: a hook aimed due east, then a cursor
    // drifting north at 0.2 m per input, and a grapple press a few inputs later
    for (let k = 0; k < n; k++) {
      const b = k === 0 ? Btn.Hook : k === 3 ? Btn.Grapple : 0;
      sim.queueInput(1, { seq: 1000 + k, mx: 0, mz: 0, ax: -10, az: 0.2 * k, b });
    }
    const presses = u.queue.filter((q) => q.b !== 0);
    assert.equal(presses.length, 2, `burst ${n}: presses were fused`);
    assert.deepEqual(presses.map((q) => [q.b, q.az]), [[Btn.Hook, 0], [Btn.Grapple, 0.2 * 3]], `burst ${n}: a press moved to another input`);
    sim.step();
    assert.equal(u.castKind, 'hook');
    assert.equal(u.castAz, 0, `burst ${n}: the hook took a later input's aim`);
  }
});

// --- 6 --------------------------------------------------------------------------------------
test('6: a grapple onto an ally on a bridge lands on the deck, never on the bed under it', () => {
  let n = 0;
  let inFoot = 0;
  for (const allyZ of [9.0, 9.4, 9.8, 10.2, 10.6, 11.0, 11.4]) {
    for (const gz of [0, 1.3, 2.6, 3.4, 4.1, 5.0]) {
      for (const gx of [-2, 0, 2]) {
        const sim = setup([0, 0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
        const g = sim.unitById.get(1)!;
        const a = sim.unitById.get(2)!;
        place(sim.unitById.get(3)!, 30, 0);
        place(a, gx, allyZ);
        place(g, gx, gz);
        input(sim, 1, 0, 0, a.x, a.z, Btn.Grapple);
        let flew = false;
        for (let i = 0; i < TICK_RATE * 2; i++) {
          input(sim, 1, 0, 0, a.x, a.z);
          sim.step();
          a.x = gx;
          a.z = allyZ;
          if (g.state === UnitState.Grappling) flew = true;
          if (flew && g.state === UnitState.Alive) break;
        }
        if (!flew) continue;
        n++;
        if (!platformAt(sim.map, g.x, g.z)) continue;
        inFoot++;
        assert.equal(g.under, false, `ally z=${allyZ}, from (${gx},${gz}): landed under the deck at (${g.x.toFixed(2)},${g.z.toFixed(2)})`);
      }
    }
  }
  assert.ok(n > 60 && inFoot > 30, `precondition: ${n} grapples, ${inFoot} landed on the deck`);
});

test('6: a hooked unit delivered onto a bridge lands on the deck, never on the bed under it', () => {
  let delivered = 0;
  for (const ls of [false, true]) {
    for (const ownerZ of [10.2, 10.6, 11.0, 11.4]) {
      const sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
      const a = sim.unitById.get(1)!;
      const t = sim.unitById.get(2)!;
      a.up.speed = 5;
      if (ls) sim.grantRune(a, 'longshot');
      place(a, 0, ownerZ);
      place(t, 0, 0);
      for (let i = 0; i < 2; i++) {
        input(sim, 1, 0, 0, t.x, t.z);
        sim.step();
      }
      input(sim, 1, 0, 0, t.x, t.z, Btn.Hook);
      let hit = false;
      for (let i = 0; i < TICK_RATE * 3; i++) {
        input(sim, 1, 0, 0, t.x, t.z);
        sim.step();
        if (t.state === UnitState.Hooked) hit = true;
        if (hit && t.state === UnitState.Alive) break;
      }
      assert.ok(hit && t.state === UnitState.Alive, `owner z=${ownerZ}: the hook never delivered`);
      if (!platformAt(sim.map, t.x, t.z)) continue;
      delivered++;
      assert.equal(t.under, false, `owner z=${ownerZ}${ls ? ' +Long Line' : ''}: delivered under the bridge at z=${t.z.toFixed(2)}`);
    }
  }
  assert.ok(delivered >= 6, `precondition: only ${delivered} deliveries onto the deck`);
});

// --- 7 --------------------------------------------------------------------------------------
/** Dry Lanternwharf: walk unit `id` along the open canal into the z = zBridge bridge's footprint (it goes UNDER). */
function walkUnder(sim: GameSim, id: number, x: number, zBridge: number) {
  const u = sim.unitById.get(id)!;
  const side = Math.sign(zBridge);
  place(u, x, zBridge - side * 3.5);
  walkTo(sim, id, x, zBridge, TICK_RATE * 3);
  assert.ok(u.under && platformAt(sim.map, u.x, u.z), 'precondition: the unit is under the bridge');
}

test('7: on a bridge and on the bed under it: no body-block, no wallop, no bash', () => {
  const sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
  const a = sim.unitById.get(1)!;
  const b = sim.unitById.get(2)!;
  place(a, -30, 0);
  walkUnder(sim, 2, 0.2, 10);
  place(a, 0, 10); // on the deck, right above b
  let wallops = 0;
  for (let i = 0; i < TICK_RATE * 3; i++) {
    input(sim, 1, 0, 0, 0, 0);
    input(sim, 2, 0, 0, 0, 0);
    sim.step();
    a.x = 0;
    a.z = 10;
    for (const ev of sim.events) if (ev.e === 'melee') wallops++;
  }
  assert.ok(b.under, 'b stays under the bridge');
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.8, `the deck unit pushed the bed unit away (${Math.hypot(a.x - b.x, a.z - b.z).toFixed(2)} m)`);
  assert.equal(wallops, 0, 'units 2.9 m apart vertically walloped each other');
  assert.equal(a.hp, a.maxHp);
  assert.equal(b.hp, b.maxHp);
  input(sim, 1, 0, 0, b.x, b.z, Btn.Bash);
  input(sim, 2, 0, 0, 0, 0);
  let hits: number[] | null = null;
  for (let i = 0; i < 10; i++) {
    sim.step();
    for (const ev of sim.events) if (ev.e === 'bash' && ev.u === 1) hits = ev.hits;
    input(sim, 1, 0, 0, 0, 0);
    input(sim, 2, 0, 0, 0, 0);
  }
  assert.deepEqual(hits, [], 'a bash on the deck hit the bed below');
});

test('7: guard: a unit on a dock still bashes the swimmer beside it in deep water', () => {
  const { p, fromChannel } = deckApproach('mirelight');
  const sim = setup([0, 1], { mapId: 'mirelight', riverMode: 'deep' });
  noMovers(sim);
  const a = sim.unitById.get(1)!;
  const b = sim.unitById.get(2)!;
  const l = Math.hypot(fromChannel.x - p.x, fromChannel.z - p.z);
  const dx = (fromChannel.x - p.x) / l;
  const dz = (fromChannel.z - p.z) / l;
  place(a, fromChannel.x - dx * 1.2, fromChannel.z - dz * 1.2);
  place(b, fromChannel.x, fromChannel.z);
  input(sim, 2, 0, 0, 0, 0);
  sim.step();
  assert.equal(b.state, UnitState.Drowning, 'precondition: b swims');
  assert.ok(platformAt(sim.map, a.x, a.z), 'precondition: a is on the dock');
  input(sim, 1, 0, 0, b.x, b.z, Btn.Bash);
  let hits: number[] | null = null;
  for (let i = 0; i < 10; i++) {
    sim.step();
    for (const ev of sim.events) if (ev.e === 'bash' && ev.u === 1) hits = ev.hits;
  }
  assert.deepEqual(hits, [2], 'a dock bash must still hit the swimmer beside it');
});

test('7: hooks: a hook at deck height passes over units under a bridge; one thrown along the bed catches them', () => {
  const caught = (sim: GameSim, from: { x: number; z: number }, at: { x: number; z: number }, tg: number) => {
    const a = sim.unitById.get(1)!;
    place(a, from.x, from.z);
    input(sim, 1, 0, 0, at.x, at.z, Btn.Hook);
    for (let i = 0; i < TICK_RATE * 2; i++) {
      input(sim, 1, 0, 0, at.x, at.z);
      input(sim, tg, 0, 0, 0, 0);
      sim.step();
      for (const ev of sim.events) if (ev.e === 'hookHit' && ev.tg === tg) return true;
    }
    return false;
  };
  // from the quay beside the bridge end, along the bridge: it flies over the unit under it
  let sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
  place(sim.unitById.get(1)!, -30, 0);
  walkUnder(sim, 2, 0.2, 10);
  assert.equal(caught(sim, { x: -8, z: 10 }, { x: 0.2, z: 10 }, 2), false, 'a hook flying over the deck caught a unit on the bed under it');
  // from the open bed: it flies under the deck and catches it
  sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
  place(sim.unitById.get(1)!, -30, 0);
  walkUnder(sim, 2, 0.2, 10);
  assert.ok(caught(sim, { x: 0.2, z: 4.5 }, { x: 0.2, z: 10 }, 2), 'a hook thrown along the bed should catch a unit under the bridge');
  // guard: from the deck, a unit out on the open bed is caught as always
  sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
  place(sim.unitById.get(2)!, 0, 3);
  assert.ok(caught(sim, { x: 0, z: 10 }, { x: 0, z: 3 }, 2), 'a hook from the deck must still catch a unit on the open bed');
});

test('7: a mine dropped on the bed under a bridge is not set off from the deck above', () => {
  {
    const sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
    const a = sim.unitById.get(1)!;
    const b = sim.unitById.get(2)!;
    place(a, -30, 0);
    walkUnder(sim, 2, 0.2, 10);
    b.items[0] = { id: 'mine', charges: 1 };
    input(sim, 2, 0, 0, 0, 0, Btn.Item1);
    sim.step();
    const m = sim.mines.find((q) => q.owner === 2)!;
    assert.ok(m, 'precondition: the mine is down');
    m.armT = 0;
    place(b, 30, 0); // b walks off; a stands on the deck right above the mine
    place(a, m.x, m.z);
    let boom = false;
    for (let i = 0; i < 10; i++) {
      sim.step();
      a.x = m.x;
      a.z = m.z;
      for (const ev of sim.events) if (ev.e === 'mineBoom') boom = true;
    }
    assert.equal(boom, false, 'a mine on the bed went off under a unit on the bridge');
    assert.equal(m.under, true, 'a mine dropped under the deck keeps its layer');
    m.under = false; // the same mine on the deck does go off
    sim.step();
    assert.ok(sim.events.some((ev) => ev.e === 'mineBoom'), 'a mine on the deck should go off');
  }
});

test('7: the steam vent on a bridge never hits the bed under it; on the deck it does', () => {
  for (const under of [true, false]) {
    const sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry', hazards: 'special' });
    place(sim.unitById.get(1)!, -30, 0);
    const vent = sim.hazards.find((h) => Math.abs(h.x) < 1e-6 && Math.abs(h.z + 10) < 1e-6);
    assert.ok(vent && vent.kind === 'steamvent', 'precondition: the bridge vent');
    const u = sim.unitById.get(2)!;
    if (under) walkUnder(sim, 2, 0, -10);
    else place(u, 0, -10);
    let hit = false;
    for (let i = 0; i < TICK_RATE * 5; i++) {
      input(sim, 2, 0, 0, 0, 0);
      const hp = u.hp;
      sim.step();
      if (u.hp < hp) hit = true;
      if (!under) place(u, 0, -10);
    }
    if (under) assert.equal(hit, false, 'the bridge vent hit a unit on the bed under the bridge');
    else assert.ok(hit, 'the bridge vent should hit a unit standing on it');
  }
});

test('7: thorns on a bridge do not slow or scratch the bed under it', () => {
  {
    const sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry', hazards: 'thorns' });
    place(sim.unitById.get(1)!, -30, 0);
    walkUnder(sim, 2, 0, -10);
    const u = sim.unitById.get(2)!;
    input(sim, 2, 0, 0, 0, 0);
    sim.step();
    assert.equal(u.inHazard, false, 'thorns on the bridge reached the bed under it');
    assert.ok(sim.moveMultiplier(u) > 0.99, `slowed by thorns on the bridge (moveMul ${sim.moveMultiplier(u).toFixed(2)})`);
  }
});

// --- 6 and 7 together (checker, 2026-10-09): landings must stay on a layer that touches the caster -----
// The layer rules of 7 mean a body landed on the wrong layer can no longer be walloped or bashed, so a
// landing that crosses a deck edge must pick the caster's (or the anchor's) layer, judged by deck tier:
// an `under` flag alone cannot tell a unit out on the open bed from one up on a deck.

test('6/7: a hook delivery lands the catch where the caster can wallop it, on a bridge or on the bed', () => {
  const bad: string[] = [];
  const cases: [number, number, number, number, string][] = [
    [0, 10, 0, 3, 'caster mid-bridge, catch from the bed south'],
    [-3, 10, -3, 2.5, 'caster on the bridge (west), catch from the bed south'],
    [0, 10.8, 0, 3, 'caster on the bridge (north half), catch from the bed south'],
    [0, 7.6, 0, 13.5, 'caster on the open bed beside the bridge, catch from across it'],
    [0, 12.4, 0, 6.5, 'caster on the open bed north of the bridge, hook along the bed under it'],
    [0, 7.6, 0, 1.5, 'caster on the open bed, catch from the open bed'],
  ];
  for (const [ox, oz, tx, tz, label] of cases) {
    const sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
    noMovers(sim);
    const a = sim.unitById.get(1)!;
    const t = sim.unitById.get(2)!;
    place(a, ox, oz);
    place(t, tx, tz);
    for (let i = 0; i < 2; i++) {
      input(sim, 1, 0, 0, t.x, t.z);
      input(sim, 2, 0, 0, 0, 0);
      sim.step();
    }
    input(sim, 1, 0, 0, t.x, t.z, Btn.Hook);
    let hit = false;
    let delivered = false;
    let wallops = 0;
    for (let i = 0; i < TICK_RATE * 4; i++) {
      input(sim, 1, 0, 0, t.x, t.z);
      input(sim, 2, 0, 0, 0, 0);
      sim.step();
      if (t.state === UnitState.Hooked) hit = true;
      if (hit && t.state === UnitState.Alive) delivered = true;
      for (const ev of sim.events) if (ev.e === 'melee' && ev.u === 1) wallops++;
      if (delivered && wallops > 0) break;
    }
    assert.ok(delivered, `${label}: precondition: the hook delivered`);
    if (!sim.sameLayer(a, t) || wallops === 0) {
      bad.push(`${label}: caster tier ${sim.tierOf(a)}, catch at (${t.x.toFixed(2)},${t.z.toFixed(2)}) under=${t.under} tier ${sim.tierOf(t)}, wallops ${wallops}`);
    }
  }
  assert.deepEqual(bad, [], 'a delivered catch landed on a layer its caster cannot reach');
});

test('6/7: a grapple from a bridge onto a unit on the bed below lands down on the bed with it', () => {
  const bad: string[] = [];
  let n = 0;
  for (const az of [7.0, 7.4, 7.8]) {
    for (const gx of [-2, 0, 2]) {
      const sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
      noMovers(sim);
      const g = sim.unitById.get(1)!;
      const a = sim.unitById.get(2)!;
      place(a, gx, az); // out on the open bed, just south of the z = 10 bridge
      place(g, gx, 10.6); // on the bridge deck
      assert.equal(sim.tierOf(g), 1, 'precondition: the grappler is on the deck');
      input(sim, 1, 0, 0, a.x, a.z, Btn.Grapple);
      let flew = false;
      for (let i = 0; i < TICK_RATE * 2; i++) {
        input(sim, 1, 0, 0, a.x, a.z);
        input(sim, 2, 0, 0, 0, 0);
        sim.step();
        place(a, gx, az);
        if (g.state === UnitState.Grappling) flew = true;
        if (flew && g.state === UnitState.Alive) break;
      }
      assert.ok(flew && g.state === UnitState.Alive, 'precondition: the grapple flew and landed');
      n++;
      if (!sim.sameLayer(g, a)) bad.push(`anchor z=${az} x=${gx}: landed (${g.x.toFixed(2)},${g.z.toFixed(2)}) under=${g.under} tier ${sim.tierOf(g)}`);
    }
  }
  assert.equal(n, 9);
  assert.deepEqual(bad, [], 'the grappler landed up on the deck, out of reach of the unit it flew to');
});

test('7: a mine dropped from the open bed that rolls in under a bridge lies on the bed', () => {
  const sim = setup([0, 1], { mapId: 'lanternwharf', riverMode: 'dry' });
  noMovers(sim);
  const d = sim.unitById.get(1)!;
  const e = sim.unitById.get(2)!;
  place(e, 30, 0);
  place(d, 0, 8.0); // on the open bed, right at the south edge of the z = 10 bridge
  d.face = Math.PI; // facing south: the mine drops 0.6 m behind, inside the footprint
  d.items[0] = { id: 'mine', charges: 1 };
  assert.equal(sim.tierOf(d), 2, 'precondition: the dropper is on the open bed');
  input(sim, 1, 0, 0, 0, 0, Btn.Item1);
  input(sim, 2, 0, 0, 0, 0);
  sim.step();
  const m = sim.mines.find((q) => q.owner === 1)!;
  assert.ok(m && platformAt(sim.map, m.x, m.z), 'precondition: the mine lies inside the bridge footprint');
  m.armT = 0;
  place(d, 30, 5);
  // an enemy walks along the bed from the south, in under the bridge, over the mine
  place(e, m.x, 5.5);
  let boom = false;
  for (let i = 0; i < TICK_RATE * 2 && !boom; i++) {
    input(sim, 2, 0, 1, m.x, 12);
    input(sim, 1, 0, 0, 0, 0);
    sim.step();
    for (const ev of sim.events) if (ev.e === 'mineBoom') boom = true;
  }
  assert.ok(boom, 'a bed unit walked under the bridge over a mine dropped from the bed, and it never went off');
});

// --- 8 --------------------------------------------------------------------------------------
test('8: a grapple rescue to a bank anchor lands the swimmer on dry ground, on every map', () => {
  const bad: string[] = [];
  let tried = 0;
  for (const mapId of MAP_IDS) {
    const map = getMap(mapId);
    for (const o of map.obstacles) {
      if (o.shape !== 'circle') continue;
      // direction from the obstacle to the nearest water, and a swimmer 2.5 m further out
      let best: { a: number; r: number } | null = null;
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        for (let r = o.r + 0.1; r < o.r + 3; r += 0.1) {
          if (channelDepthAt(map, o.x + Math.sin(a) * r, o.z + Math.cos(a) * r) > 0) {
            if (!best || r < best.r) best = { a, r };
            break;
          }
        }
      }
      if (!best) continue;
      const ux = o.x + Math.sin(best.a) * (best.r + 2.5);
      const uz = o.z + Math.cos(best.a) * (best.r + 2.5);
      if (channelDepthAt(map, ux, uz) < 0.6) continue;
      const sim = setup([0, 1], { mapId, riverMode: 'deep' });
      noMovers(sim);
      const u = sim.unitById.get(1)!;
      place(sim.unitById.get(2)!, 33, 20);
      place(u, ux, uz);
      sim.step();
      if (u.state !== UnitState.Drowning) continue;
      tried++;
      input(sim, 1, 0, 0, o.x, o.z, Btn.Grapple);
      let landed: { x: number; z: number } | null = null;
      let dead = false;
      for (let i = 0; i < TICK_RATE * 3 && !dead; i++) {
        input(sim, 1, 0, 0, o.x, o.z); // keys released after the press
        sim.step();
        for (const ev of sim.events) if (ev.e === 'grappleLand' && ev.u === 1) landed = { x: u.x, z: u.z };
        if (sim.isDead(u)) dead = true;
      }
      if (!landed) continue; // blocked on the way: not a landing case
      const depth = sim.world.channel(landed.x, landed.z);
      if (depth > 0 || dead) bad.push(`${mapId} ${o.kind} (${o.x},${o.z}): landed (${landed.x.toFixed(2)},${landed.z.toFixed(2)}) depth ${depth.toFixed(2)}${dead ? ', drowned' : ''}`);
    }
  }
  assert.ok(tried >= 50, `precondition: only ${tried} rescues tried`);
  assert.deepEqual(bad, [], `${bad.length} rescues landed in the water`);
});

// --- 9 --------------------------------------------------------------------------------------
test('9: a unit taken back from the stand-in bot stands still until the new client sends input', () => {
  const sim = setup([0, 1], { mapId: 'muckmire', riverMode: 'dry' });
  const u = sim.unitById.get(1)!;
  sim.setController(1, true, 'Stand-in');
  for (let i = 0; i < TICK_RATE * 2; i++) sim.step();
  place(u, -30, 0);
  for (let i = 0; i < TICK_RATE * 6 && Math.hypot(u.input.mx, u.input.mz) < 0.5; i++) sim.step();
  assert.ok(Math.hypot(u.input.mx, u.input.mz) >= 0.5, 'precondition: the stand-in bot is walking');
  // Room.reclaim: setController(false) then resetInput
  sim.setController(1, false, 'Owner');
  sim.resetInput(1);
  const x0 = u.x;
  const z0 = u.z;
  for (let i = 0; i < 20; i++) sim.step();
  const moved = Math.hypot(u.x - x0, u.z - z0);
  assert.ok(moved < 0.4, `walked ${moved.toFixed(2)} m on the bot's last movement`);
  const q = sim.inputQueueInfo(1)!;
  assert.equal(q.debt, 0, 'ticks before the new client spoke were counted as input debt');
  assert.equal(q.holds, 0);

  // resetInput alone (a rejoin onto a unit the old connection was walking)
  const s2 = setup([0, 1], { mapId: 'muckmire', riverMode: 'dry' });
  const w = s2.unitById.get(1)!;
  place(w, -30, 0);
  for (let i = 0; i < 10; i++) {
    input(s2, 1, 1, 0, 0, 0);
    s2.step();
  }
  s2.resetInput(1);
  const wx = w.x;
  for (let i = 0; i < 20; i++) s2.step();
  assert.ok(Math.abs(w.x - wx) < 0.4, `walked ${Math.abs(w.x - wx).toFixed(2)} m after resetInput`);
  assert.equal(s2.inputQueueInfo(1)!.debt, 0);
});

// --- extra: quicksand pits -------------------------------------------------------------------
test('quicksand eats a unit standing still in any pit, whatever order the pits are listed in', () => {
  const sim = setup([0, 1], { mapId: 'muckmire', riverMode: 'dry', hazards: 'special' });
  const pits = sim.hazards.filter((h) => h.kind === 'quicksand');
  assert.ok(pits.length >= 2, 'precondition: several pits');
  const u = sim.unitById.get(1)!;
  place(sim.unitById.get(2)!, 30, 20);
  place(u, pits[0].x, pits[0].z); // the first pit: every later pit used to reset its clock
  const hp0 = u.hp;
  for (let i = 0; i < TICK_RATE * 3; i++) {
    input(sim, 1, 0, 0, 0, 0);
    sim.step();
  }
  assert.ok(u.inHazard, 'precondition: in the pit');
  assert.ok(hp0 - u.hp > 30, `standing still in quicksand for 3 s cost only ${(hp0 - u.hp).toFixed(0)} hp`);
});
