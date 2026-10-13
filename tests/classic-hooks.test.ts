import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAL, DEFAULT_CONFIG, TICK_RATE } from '../shared/constants.ts';
import { GameSim } from '../shared/sim/sim.ts';
import type { Hook } from '../shared/sim/entities.ts';
import { World } from '../shared/world.ts';
import { Btn, HookKind, HookPhase, UnitState, type PlayerInfo, type Team } from '../shared/types.ts';
import { createBrain } from '../shared/sim/bots/brain.ts';
import { BotContext } from '../shared/sim/bots/context.ts';
import { checkDodge } from '../shared/sim/bots/dodge.ts';

// A clear arena keeps these collision fixtures independent of map dressing and bot decisions.
function arena(teams: Team[] = [0, 1, 1]) {
  const players: PlayerInfo[] = teams.map((team, i) => ({ id: i + 1, name: `P${i + 1}`, team, family: 'brawler', loadout: {}, isBot: false }));
  const sim = new GameSim({ ...DEFAULT_CONFIG, riverMode: 'dry', botFill: false, hazards: 'none' }, players, 71);
  Object.defineProperty(sim, 'world', { value: new World({ ...sim.map, obstacles: [], movers: [] }) });
  sim.phase = 'playing';
  sim.time = 5;
  for (const [i, u] of sim.units.entries()) {
    u.x = i === 0 ? -10 : 15 + i * 4;
    u.z = 0;
    u.spawnProt = 0;
  }
  return sim;
}

function head(sim: GameSim, owner: number, x: number, z: number, dx: number, dz: number, phase: 0 | 1 = HookPhase.Out): Hook {
  const h: Hook = {
    id: 900 + sim.hooks.length, owner, kind: HookKind.Hook, phase, x, z, dx, dz,
    speed: 46, r: 0.45, range: 26, traveled: 3, pts: [], bounces: 0,
    tg: -1, ru: -1, ember: false, ricochet: false, steer: false, longshot: false,
    dmg: 180, anchorUnit: -1, flightT: 0, dead: false, bendAcc: 0, tier: 0,
  };
  sim.hooks.push(h);
  sim.unitById.get(owner)!.activeHook = h.id;
  return h;
}

test('an empty returning hook sweeps the first enemy, deals damage once, and delivers only that catch', () => {
  const sim = arena();
  const [owner, first, behind] = sim.units;
  first.x = -4;
  behind.x = -7;
  const h = head(sim, owner.id, -1, 0, -1, 0, HookPhase.Back);
  const hits: number[] = [];
  for (let i = 0; i < TICK_RATE && !h.dead; i++) {
    sim.step();
    for (const e of sim.events) if (e.e === 'hookHit') hits.push(e.tg);
  }
  assert.deepEqual(hits, [first.id]);
  assert.equal(first.hp, first.maxHp - h.dmg);
  assert.equal(behind.hp, behind.maxHp);
  assert.equal(first.hookedBy, -1);
  assert.equal(first.state, UnitState.Alive);
  assert.ok(Math.hypot(first.x - owner.x, first.z - owner.z) < 2);
});

test('return catches skip dead and spawn-protected units and can rescue an ally', () => {
  const sim = arena([0, 0, 1, 1]);
  const [owner, ally, protectedEnemy, deadEnemy] = sim.units;
  ally.x = -6;
  ally.hp = 100;
  protectedEnemy.x = -3;
  protectedEnemy.spawnProt = 2;
  deadEnemy.x = -4;
  deadEnemy.state = UnitState.Dead;
  deadEnemy.respawnT = 10;
  const h = head(sim, owner.id, -1, 0, -1, 0, HookPhase.Back);
  let hit;
  for (let i = 0; i < 10 && !hit; i++) {
    sim.step();
    hit = sim.events.find((e) => e.e === 'hookHit');
  }
  assert.ok(hit?.e === 'hookHit');
  assert.equal(hit.tg, ally.id);
  assert.equal(hit.ally, true);
  assert.equal(hit.dmg, 0);
});

test('a returning hook carrying a rune cannot also take a unit', () => {
  const sim = arena();
  const [owner, enemy] = sim.units;
  enemy.x = -5;
  const h = head(sim, owner.id, -1, 0, -1, 0, HookPhase.Back);
  h.ru = 800;
  sim.runes.push({ id: 800, x: h.x, z: h.z, type: 'bounty', dragged: true, spot: 0 });
  const hits: unknown[] = [];
  for (let i = 0; i < 15 && !h.dead; i++) {
    sim.step();
    hits.push(...sim.events.filter((e) => e.e === 'hookHit'));
  }
  assert.equal(hits.length, 0);
  assert.equal(sim.runes.length, 0);
});

test('a return catch steals a dragged ally without double ownership', () => {
  const sim = arena([0, 1, 0]);
  const [owner, foe, ally] = sim.units;
  foe.x = 10;
  ally.x = -3;
  const old = head(sim, foe.id, ally.x, 0, 1, 0, HookPhase.Back);
  old.tg = ally.id;
  ally.hookedBy = old.id;
  ally.state = UnitState.Hooked;
  const saving = head(sim, owner.id, -1, 0, -1, 0, HookPhase.Back);
  let stolen = false;
  for (let i = 0; i < 8 && !stolen; i++) {
    sim.step();
    stolen = sim.events.some((e) => e.e === 'hookSteal');
  }
  assert.ok(stolen);
  assert.equal(ally.hookedBy, saving.id);
  assert.equal(old.tg, -1);
  assert.equal(owner.stats.sv, 1);
});

test('opposing heads that cross within one tick clash at first contact at base and maximum speed', () => {
  for (const speed of [30, 46, 46 * BAL.longshotSpeedMul]) {
    const sim = arena();
    const a = head(sim, 1, -0.6, 0, 1, 0);
    const b = head(sim, 2, 0.6, 0, -1, 0);
    a.speed = b.speed = speed;
    sim.step();
    const clashes = sim.events.filter((e) => e.e === 'hookClash');
    assert.equal(clashes.length, 1, `speed ${speed}`);
    assert.equal(a.phase, HookPhase.Back);
    assert.equal(b.phase, HookPhase.Back);
    assert.ok(a.x < b.x, 'heads crossed through each other before clashing');
    assert.ok(Math.abs(b.x - a.x - (a.r + b.r + 0.1)) < 1e-6);
  }
});

test('perpendicular and grazing heads clash even when both endpoint pairs are outside the radius', () => {
  for (const [x, z] of [[-0.8, 0.8], [-1.46, 0.073]]) {
    const sim = arena();
    const a = head(sim, 1, x, 0, 1, 0);
    const b = head(sim, 2, 0, z, 0, -1);
    const delta = a.speed / TICK_RATE;
    assert.ok(Math.hypot(x, z) > 1);
    assert.ok(Math.hypot(x + delta, z - delta) > 1);
    sim.step();
    assert.ok(sim.events.some((e) => e.e === 'hookClash'));
  }
});

test('a head that reaches its range remains a stationary clash target for the rest of that tick', () => {
  const sim = arena();
  const a = head(sim, 1, 0, 0, 1, 0);
  a.range = a.traveled + 0.1;
  head(sim, 2, 1.4, 0, -1, 0);
  sim.step();
  assert.equal(sim.events.filter((e) => e.e === 'hookClash').length, 1);
});

test('clashed heads retract harmlessly rather than catching targets behind them', () => {
  const sim = arena();
  const a = head(sim, 1, -0.6, 0, 1, 0);
  head(sim, 2, 0.6, 0, -1, 0);
  sim.step();
  sim.units[2].x = -5;
  const hp = sim.units[2].hp;
  for (let i = 0; i < 20 && !a.dead; i++) {
    sim.step();
    assert.ok(!sim.events.some((e) => e.e === 'hookHit'));
  }
  assert.equal(sim.units[2].hp, hp);
});

test('a returning empty head cannot catch a unit through intervening cover', () => {
  const sim = arena();
  Object.defineProperty(sim, 'world', { value: new World({ ...sim.map, movers: [], obstacles: [{ shape: 'circle', kind: 'mossrock', x: -3, z: 0, r: 0.25, seed: 1 }] }) });
  sim.units[1].x = -5;
  const h = head(sim, 1, -1, 0, -1, 0, HookPhase.Back);
  for (let i = 0; i < 20 && !h.dead; i++) {
    sim.step();
    assert.ok(!sim.events.some((e) => e.e === 'hookHit'));
  }
  assert.ok(h.dead, 'cover stopped retrieval permanently');
});

test('return catches respect bridge layers and can rescue a drowning ally', () => {
  for (const tier of [0, 1] as const) {
    const sim = new GameSim({ ...DEFAULT_CONFIG, mapId: 'lanternwharf', riverMode: 'dry', hazards: 'none', botFill: false },
      [0, 1].map((team, i) => ({ id: i + 1, team: team as Team, name: `P${i}`, family: 'brawler', loadout: {}, isBot: false })), 71);
    Object.defineProperty(sim, 'world', { value: new World({ ...sim.map, obstacles: [], movers: [] }) });
    sim.phase = 'playing';
    const [owner, enemy] = sim.units;
    owner.x = -10; owner.z = enemy.z = -10;
    enemy.x = 0; enemy.under = true;
    owner.spawnProt = enemy.spawnProt = 0;
    const h = head(sim, 1, 3, -10, -1, 0, HookPhase.Back);
    h.tier = tier;
    let hit = false;
    for (let i = 0; i < 15 && !h.dead; i++) {
      sim.step();
      hit ||= sim.events.some((e) => e.e === 'hookHit');
    }
    assert.equal(hit, tier === 1);
  }
  const sim = arena([0, 0, 1]);
  sim.config.riverMode = 'deep';
  const [owner, ally] = sim.units;
  owner.z = ally.z = -5;
  ally.x = 0;
  ally.state = UnitState.Drowning;
  ally.drownT = 1.7;
  const h = head(sim, 1, 3, -5, -1, 0, HookPhase.Back);
  for (let i = 0; i < 12 && !h.dead; i++) sim.step();
  assert.equal(owner.stats.sv, 1);
  assert.notEqual(ally.state, UnitState.Dead);
  assert.equal(ally.drownT, 0);
});

test('owner death and interruptions drop a return catch without leaving control locked', () => {
  for (const death of [false, true]) {
    const sim = arena();
    const [owner, enemy] = sim.units;
    enemy.x = -4;
    const h = head(sim, 1, -1, 0, -1, 0, HookPhase.Back);
    for (let i = 0; i < 5 && h.tg < 0; i++) sim.step();
    assert.equal(h.tg, enemy.id);
    if (death) sim.kill(owner, enemy.id, 'hook');
    else sim.breakHook(h);
    assert.equal(h.dead, true);
    assert.equal(enemy.hookedBy, -1);
    assert.equal(enemy.state, UnitState.Alive);
    assert.equal(owner.activeHook, -1);
  }
});

test('bots recognize an empty return as a new threat after dodging the outward head', () => {
  const sim = arena();
  const [bot, owner] = sim.units;
  owner.x = -20;
  const h = head(sim, owner.id, -15, 0, 1, 0);
  const brain = createBrain(sim, bot);
  brain.tune = { ...brain.tune, dodge: 1, dodgeReact: 0 };
  const ctx = new BotContext(sim);
  ctx.update();
  checkDodge(sim, ctx, bot, brain);
  assert.equal(brain.stats.dodges, 1);
  sim.time += 0.5; sim.tick += 15;
  h.phase = HookPhase.Back;
  h.x = -5; h.dx = -1;
  ctx.update();
  checkDodge(sim, ctx, bot, brain);
  assert.equal(brain.stats.dodges, 2, 'outward judgement hid the returning threat');
  sim.time += 0.5; sim.tick += 15;
  h.tg = 3;
  ctx.update();
  checkDodge(sim, ctx, bot, brain);
  assert.equal(brain.stats.dodges, 2, 'loaded return was treated as a fresh threat');
});

test('allied heads pass through; a loaded returning hook is not a clash shield', () => {
  const sim = arena([0, 0, 1]);
  head(sim, 1, -0.6, 0, 1, 0);
  head(sim, 2, 0.6, 0, -1, 0);
  sim.step();
  assert.ok(!sim.events.some((e) => e.e === 'hookClash'));
  const sim2 = arena();
  const loaded = head(sim2, 2, 0.6, 0, 1, 0, HookPhase.Back);
  sim2.units[1].x = -10;
  sim2.units[1].z = 4;
  loaded.tg = 3;
  sim2.units[2].hookedBy = loaded.id;
  sim2.units[2].state = UnitState.Hooked;
  head(sim2, 1, -0.6, 0, 1, 0);
  sim2.step();
  assert.ok(!sim2.events.some((e) => e.e === 'hookClash'));
});

test('a wall before the head crossing takes precedence; a later wall does not cancel an earlier clash', () => {
  for (const x of [0, 3]) {
    const sim = arena();
    Object.defineProperty(sim, 'world', { value: new World({ ...sim.map, movers: [], obstacles: [{ shape: 'circle', kind: 'mossrock', x, z: 0, r: 0.2, seed: 1 }] }) });
    head(sim, 1, -1.5, 0, 1, 0);
    head(sim, 2, 1.5, 0, -1, 0);
    sim.step();
    assert.equal(sim.events.some((e) => e.e === 'hookClash'), x === 3);
    if (x === 0) assert.ok(sim.events.some((e) => e.e === 'hookWall'));
  }
});

test('catching the other caster before a clash interrupts its head first', () => {
  const sim = arena();
  sim.units[1].x = -0.3;
  const a = head(sim, 1, -0.6, 0, 1, 0);
  const b = head(sim, 2, 0.6, 0, -1, 0);
  sim.step();
  assert.equal(a.tg, 2);
  assert.equal(b.dead, true);
  assert.ok(!sim.events.some((e) => e.e === 'hookClash'));
});

test('clash resolution is deterministic when the hook storage order is reversed', () => {
  const run = (reverse: boolean) => {
    const sim = arena();
    head(sim, 1, -0.6, 0, 1, 0);
    head(sim, 2, 0.6, 0, -1, 0);
    if (reverse) sim.hooks.reverse();
    sim.step();
    return { events: sim.events, heads: sim.hooks.map((h) => ({ id: h.id, x: h.x, z: h.z, phase: h.phase })).sort((a, b) => a.id - b.id) };
  };
  assert.deepEqual(run(false), run(true));
});

test('caster movement bends the ordinary chain and its return, while the outbound head keeps its aimed heading', () => {
  const sim = arena();
  const owner = sim.units[0];
  owner.x = -22;
  owner.z = -6;
  sim.queueInput(owner.id, { seq: 1, mx: 0, mz: 0, ax: 8, az: -6, b: Btn.Hook });
  for (let i = 0; i < 5; i++) sim.step();
  const h = sim.hookById(owner.activeHook)!;
  assert.ok(h);
  const launchZ = h.z;
  for (let i = 0; i < 8; i++) {
    sim.queueInput(owner.id, { seq: i + 2, mx: 0, mz: 1, ax: 8, az: -6, b: 0 });
    sim.step();
  }
  assert.equal(h.phase, HookPhase.Out);
  assert.ok(Math.abs(h.z - launchZ) < 1e-8, 'ordinary outward head homed toward caster or cursor');
  assert.ok(h.pts.length >= 4, 'no flexible chain links');
  assert.ok(h.pts.some((v, i) => i % 2 === 1 && Math.abs(v - launchZ) > 0.1), 'chain did not bend with caster movement');
  let returns = 0;
  const directions: number[] = [];
  for (let i = 0; i < 45 && !h.dead; i++) {
    sim.queueInput(owner.id, { seq: i + 20, mx: 0, mz: 1, ax: -22, az: -20, b: 0 });
    const x = h.x, z = h.z;
    const phase = Number(h.phase);
    sim.step();
    if (phase === HookPhase.Back && !h.dead) {
      directions.push(Math.atan2(h.z - z, h.x - x));
      returns++;
    }
  }
  assert.ok(h.dead, 'moving caster never got the hook back');
  assert.ok(returns > 3);
  assert.ok(Math.max(...directions) - Math.min(...directions) > 0.05, 'return head stayed on a fixed straight path');
});
