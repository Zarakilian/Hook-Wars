// The authoritative game simulation. Runs on the server for online play and in the browser for solo.
// Fixed tick (TICK_DT). Everything gameplay-relevant happens here; clients only predict their own walking.
import {
  BAL, COUNTDOWN_SEC, FAMILY_DEFS, HOOK_LEVELS, ITEMS, MAX_UPGRADE, SCOREBOARD_EVERY, TICK_DT, UNIT_RADIUS, UPGRADE_COST,
} from '../constants.ts';
import { getMap } from '../maps/index.ts';
import type { MapDef } from '../maps/types.ts';
import { angleDelta, clamp, dist, dist2, q2, Rng, sweepCircle } from '../math.ts';
import {
  Btn, BTN_ITEM, HookKind, HookPhase, otherTeam, UFlag, UnitState,
  type AnnounceKey, type BuffSnap, type CastKind, type GameEvent, type HookSnap, type ItemId, type KillCause, type MatchConfig,
  type MatchPhase, type MineSnap, type PlayerInfo, type PlayerInput, type RiverState, type RuneSnap, type RuneType, type ScoreRow,
  type Snapshot, type Team, type UnitSnap, type UpgradeStat, type YouSnap,
} from '../types.ts';
import { World } from '../world.ts';
import type { HazardInst, Hook, Mine, Rune, Unit } from './entities.ts';
import { buildHazards, updateHazards } from './hazards.ts';
import { blockWater, stepMove } from './movement.ts';
import { moversFloat, moversPresent, riverStateAt } from './river.ts';
import { updateRunes } from './runes.ts';
import { updateBots } from './bots.ts';

const HOOK_SUBSTEP = 0.35;
const MAX_BEND_PTS = 64; // numbers, i.e. 32 points
const BUFFER_TIME = 0.3;
/** Ticks with no input before a human's held movement is dropped (jitter is fine, a hidden tab is not). */
const STALE_INPUT_TICKS = 15;
const tmpPos = { x: 0, z: 0, hit: false };

export class GameSim {
  readonly config: MatchConfig;
  readonly map: MapDef;
  readonly world: World;
  readonly rng: Rng;
  readonly seed: number;

  tick = 0;
  time = 0;
  matchTime = 0;
  phase: MatchPhase = 'countdown';
  countdown = COUNTDOWN_SEC;
  overtime = false;
  winner: Team | -1 = -1;
  score: [number, number] = [0, 0];
  firstBlood = false;
  moverClock = 0;

  units: Unit[] = [];
  readonly unitById = new Map<number, Unit>();
  hooks: Hook[] = [];
  runes: Rune[] = [];
  mines: Mine[] = [];
  hazards: HazardInst[];
  river: RiverState;
  events: GameEvent[] = [];
  runeTimer: number = BAL.runeFirstAt;
  private nextId = 1;
  private lastTidePhase = '';

  constructor(config: MatchConfig, players: PlayerInfo[], seed: number) {
    this.config = config;
    this.map = getMap(config.mapId);
    this.world = new World(this.map);
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.river = riverStateAt(this.map, config, 0);
    this.lastTidePhase = this.river.phase;
    this.hazards = buildHazards(this.map, config, this.seed);
    for (const p of players) this.addPlayer(p);
  }

  // ------------------------------------------------------------------------------------------
  // Players
  // ------------------------------------------------------------------------------------------

  addPlayer(p: PlayerInfo): Unit {
    if (this.unitById.has(p.id)) this.removePlayer(p.id);
    const fam = FAMILY_DEFS[p.family] ?? FAMILY_DEFS.brawler;
    const used = new Set(this.units.filter((u) => u.team === p.team).map((u) => u.spawnIndex));
    let spawnIndex = 0;
    while (used.has(spawnIndex)) spawnIndex++;
    const sp = this.spawnPoint(p.team, spawnIndex);
    const maxHp = Math.round(BAL.maxHp * fam.hpMul);
    const u: Unit = {
      id: p.id, team: p.team, family: p.family, name: p.name, cosmetics: { ...p.cosmetics }, isBot: p.isBot,
      botDifficulty: p.botDifficulty ?? 'normal', spawnIndex,
      x: sp.x, z: sp.z, vx: 0, vz: 0, y: 0, face: p.team === 0 ? Math.PI / 2 : -Math.PI / 2,
      hp: maxHp, maxHp, state: UnitState.Alive, stateT: 0,
      castKind: null, castT: 0, castAx: 0, castAz: 0, buffered: null,
      cdHook: 0, cdGrapple: 0, cdBash: 0, cdMelee: 0, meleeT: 0, meleeTarget: -1,
      knockVx: 0, knockVz: 0, knockT: 0, knockDur: 0, knockH: 0,
      hookedBy: -1, activeHook: -1, activeGrapple: -1,
      drownT: 0, respawnT: 0, spawnProt: BAL.spawnProt,
      haste: 0, double: 0, bendy: 0, bouncy: 0, longshot: 0, shield: 0, shieldT: 0, ghost: 0, puff: 0, pieT: 0, burnT: 0, burnDps: 0, burnSrc: -1,
      lastDamageT: -99, damagers: new Map(),
      gold: BAL.startGold, up: { damage: 0, range: 0, speed: 0, width: 0 }, items: [null, null, null, null],
      stats: { k: 0, d: 0, a: 0, hh: 0, ht: 0, bs: 0, dr: 0, sv: 0, dmg: 0, g: 0 },
      streak: 0, multi: 0, lastKillT: -99,
      input: { seq: 0, mx: 0, mz: 0, ax: sp.x + (p.team === 0 ? 5 : -5), az: sp.z, b: 0 }, queue: [], ack: 0, idleTicks: 0, moveMul: 1,
      healAcc: 0, hazardT: 0, bristleCd: 0, inHazard: false, surface: 'ground',
      brain: null,
    };
    this.units.push(u);
    this.unitById.set(u.id, u);
    return u;
  }

  removePlayer(id: number): void {
    const u = this.unitById.get(id);
    if (!u) return;
    this.releaseUnit(u);
    for (const h of this.hooks) if (h.owner === id && !h.dead) this.breakHook(h);
    this.mines = this.mines.filter((m) => m.owner !== id);
    this.units = this.units.filter((x) => x.id !== id);
    this.unitById.delete(id);
  }

  /** Swap a unit between human and bot control without resetting its progress. */
  setController(id: number, isBot: boolean, name?: string): void {
    const u = this.unitById.get(id);
    if (!u) return;
    u.isBot = isBot;
    u.brain = null;
    u.queue.length = 0;
    u.input.b = 0;
    if (name) u.name = name;
  }

  queueInput(id: number, input: PlayerInput): void {
    const u = this.unitById.get(id);
    if (!u || u.isBot) return;
    if (u.queue.length >= 8) {
      // Client is flooding or lagging badly: merge the oldest pair so presses are never lost.
      const a = u.queue.shift()!;
      u.queue[0].b |= a.b;
    }
    u.queue.push(input);
  }

  buy(id: number, item: ItemId): boolean {
    const u = this.unitById.get(id);
    const def = ITEMS[item];
    if (!u || !def || this.phase === 'ended') return false;
    if (u.gold < def.cost) return false;
    if (def.consumable) {
      const slot = u.items.find((s) => s && s.id === item);
      if (slot) {
        if (slot.charges >= def.maxCharges) return false;
        slot.charges = Math.min(def.maxCharges, slot.charges + def.charges);
      } else {
        const free = u.items.indexOf(null);
        if (free < 0) return false;
        u.items[free] = { id: item, charges: def.charges };
      }
    } else {
      if (u.items.some((s) => s && s.id === item)) return false;
      const free = u.items.indexOf(null);
      if (free < 0) return false;
      u.items[free] = { id: item, charges: 0 };
      if (item === 'irongut') {
        u.maxHp += BAL.irongutHp;
        if (u.state !== UnitState.Dead) u.hp += BAL.irongutHp;
      }
    }
    u.gold -= def.cost;
    this.emit({ e: 'buy', u: u.id, item });
    return true;
  }

  sell(id: number, slotIndex: number): boolean {
    const u = this.unitById.get(id);
    if (!u || slotIndex < 0 || slotIndex > 3) return false;
    const slot = u.items[slotIndex];
    if (!slot) return false;
    const def = ITEMS[slot.id];
    const alive = u.state !== UnitState.Dead;
    // Iron Gut gave +irongutHp on purchase; selling takes it back. Refuse when that would kill,
    // so a sell/buy loop can never act as a free heal.
    if (slot.id === 'irongut' && alive && u.hp <= BAL.irongutHp) return false;
    const refund = def.consumable ? Math.floor((def.cost / 2) * (slot.charges / Math.max(1, def.charges))) : Math.floor(def.cost / 2);
    if (slot.id === 'irongut') {
      u.maxHp -= BAL.irongutHp;
      if (alive) u.hp -= BAL.irongutHp;
      u.hp = Math.min(u.hp, u.maxHp);
    }
    u.items[slotIndex] = null;
    u.gold += refund;
    return true;
  }

  upgrade(id: number, stat: UpgradeStat): boolean {
    const u = this.unitById.get(id);
    if (!u || !(stat in u.up) || this.phase === 'ended') return false;
    const lvl = u.up[stat];
    if (lvl >= MAX_UPGRADE) return false;
    const cost = UPGRADE_COST[lvl];
    if (u.gold < cost) return false;
    u.gold -= cost;
    u.up[stat] = lvl + 1;
    this.emit({ e: 'buy', u: u.id, item: stat });
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Tick
  // ------------------------------------------------------------------------------------------

  step(): void {
    const dt = TICK_DT;
    this.tick++;
    this.time += dt;
    this.events = [];

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = 'playing';
        this.emit({ e: 'phase', ph: 'playing' });
      }
    }
    if (this.phase === 'playing') this.matchTime += dt;

    // River and drifting obstacles
    riverStateAt(this.map, this.config, this.matchTime, this.river);
    if (this.river.phase !== this.lastTidePhase) {
      this.lastTidePhase = this.river.phase;
      this.emit({ e: 'tide', phase: this.river.phase, left: q2(this.river.phaseLeft) });
    }
    if (moversFloat(this.river, this.config)) this.moverClock += dt;
    this.world.updateMovers(this.moverClock, moversPresent(this.river, this.config));

    if (this.phase !== 'ended') updateBots(this);

    for (const u of this.units) this.consumeInput(u);
    for (const u of this.units) this.updateTimers(u, dt);
    if (this.phase === 'playing') for (const u of this.units) this.handleActions(u, dt);
    for (const u of this.units) this.updateUnit(u, dt);

    for (const h of this.hooks) if (!h.dead) this.updateHook(h, dt);
    this.checkClashes();
    this.hooks = this.hooks.filter((h) => !h.dead);

    this.separateUnits();
    for (const u of this.units) this.postMove(u, dt);
    if (this.tick % 15 === 0) this.flushHeals();

    if (this.phase === 'playing') {
      updateHazards(this, dt);
      updateRunes(this, dt);
      this.updateMines(dt);
      if (this.tick % 30 === 0) for (const u of this.units) this.giveGold(u, BAL.goldPerSec);
      // every kill source of this tick has run: decide the match once, so same-tick kills are fair
      this.checkWin();
      this.checkTime();
    }
  }

  /** Inputs allowed to stay queued after a consume. Solo sets 0 so a frame hitch never adds lag. */
  inputSlack = 2;

  // ------------------------------------------------------------------------------------------
  // Input and actions
  // ------------------------------------------------------------------------------------------

  private consumeInput(u: Unit): void {
    const q = u.queue;
    if (q.length === 0) {
      u.input.b = 0; // hold last movement and aim, but never repeat a press
      if (!u.isBot && ++u.idleTicks > STALE_INPUT_TICKS) u.input.mx = u.input.mz = 0;
      return;
    }
    u.idleTicks = 0;
    let inp = q.shift()!;
    // Keep latency low: if the client got ahead, collapse the backlog into one input.
    while (q.length > this.inputSlack) {
      const n = q.shift()!;
      n.b |= inp.b;
      inp = n;
    }
    u.input = inp;
    u.ack = inp.seq;
  }

  private handleActions(u: Unit, dt: number): void {
    const inp = u.input;
    const b = inp.b;
    // The aim is locked at the press: the throw goes where you clicked, even while you keep walking.
    // (Bendy Eel steers toward the live cursor after release; see steerHook.)
    if (b & Btn.Hook) this.tryCast(u, 'hook', inp.ax, inp.az);
    if (b & Btn.Grapple) this.tryCast(u, 'grapple', inp.ax, inp.az);
    if (b & Btn.Bash) this.tryCast(u, 'bash', inp.ax, inp.az);
    for (let i = 0; i < 4; i++) if (b & BTN_ITEM[i]) this.useItem(u, i);
    if (u.buffered && !(b & (Btn.Hook | Btn.Grapple | Btn.Bash))) {
      u.buffered.t -= dt;
      if (u.buffered.t <= 0) u.buffered = null;
      else {
        const bf = u.buffered;
        // buffered presses follow the live cursor, which is what the player is looking at
        if (this.tryCast(u, bf.kind, inp.ax, inp.az, true)) u.buffered = null;
      }
    }
  }

  private canStartCast(u: Unit, kind: CastKind): boolean {
    if (kind === 'grapple') return u.state === UnitState.Alive || u.state === UnitState.Drowning;
    return u.state === UnitState.Alive;
  }

  /** Returns true if the cast started. Presses that arrive slightly early are buffered. */
  tryCast(u: Unit, kind: 'hook' | 'grapple' | 'bash', ax: number, az: number, fromBuffer = false): boolean {
    if (this.phase !== 'playing') return false;
    const cd = kind === 'hook' ? u.cdHook : kind === 'grapple' ? u.cdGrapple : u.cdBash;
    const busy = (kind === 'hook' && u.activeHook >= 0) || (kind === 'grapple' && u.activeGrapple >= 0) || u.castKind !== null;
    if (!this.canStartCast(u, kind) || cd > 0 || busy) {
      if (!fromBuffer && u.state !== UnitState.Dead && (cd <= BUFFER_TIME || u.state === UnitState.Casting || u.castKind !== null)) {
        u.buffered = { kind, ax, az, t: BUFFER_TIME };
      }
      return false;
    }
    const fam = FAMILY_DEFS[u.family];
    if (kind === 'hook') u.cdHook = BAL.hookCooldown * fam.hookCdMul;
    else if (kind === 'grapple') u.cdGrapple = BAL.grappleCooldown;
    else u.cdBash = BAL.bashCooldown;
    u.spawnProt = 0;
    this.breakStealth(u);
    u.meleeT = 0;
    u.castAx = ax;
    u.castAz = az;
    this.faceToward(u, ax, az);
    this.emit({ e: 'cast', u: u.id, k: kind, x: q2(u.x), z: q2(u.z), ax: q2(ax), az: q2(az) });
    if (u.state === UnitState.Drowning) {
      // grapple out of the water: no wind-up, keep drowning until it latches
      this.launch(u, kind);
      return true;
    }
    u.castKind = kind;
    u.castT = kind === 'hook' ? BAL.hookWindup : kind === 'grapple' ? BAL.grappleWindup : BAL.bashWindup;
    // Hook and Grapple are thrown on the move: the unit keeps walking through the wind-up.
    // Belly Bash plants your feet for its short lunge.
    if (kind === 'bash') u.state = UnitState.Casting;
    return true;
  }

  private launch(u: Unit, kind: CastKind): void {
    if (kind === 'hook') this.spawnHook(u, HookKind.Hook);
    else if (kind === 'grapple') this.spawnHook(u, HookKind.Grapple);
    else if (kind === 'bash') this.doBash(u);
  }

  private useItem(u: Unit, i: number): void {
    const slot = u.items[i];
    if (!slot) return;
    const def = ITEMS[slot.id];
    if (!def.consumable || slot.charges <= 0) return;
    if (u.state === UnitState.Dead || u.state === UnitState.Hooked) return;
    if (slot.id === 'mine') {
      if (this.world.channel(u.x, u.z) > 0 && this.river.deep) return;
      const own = this.mines.filter((m) => m.owner === u.id && !m.dead);
      if (own.length >= BAL.maxMines) own[0].dead = true;
      const back = u.face + Math.PI;
      this.mines.push({ id: this.nextId++, owner: u.id, team: u.team, x: u.x + Math.sin(back) * 0.6, z: u.z + Math.cos(back) * 0.6, armT: BAL.mineArmTime, dead: false });
    } else if (slot.id === 'pie') {
      if (u.hp >= u.maxHp) return;
      u.pieT = BAL.pieTime;
    } else if (slot.id === 'puffball') {
      u.puff = BAL.puffTime;
    }
    slot.charges--;
    this.emit({ e: 'useItem', u: u.id, item: slot.id, x: q2(u.x), z: q2(u.z) });
    if (slot.charges <= 0) u.items[i] = null;
  }

  // ------------------------------------------------------------------------------------------
  // Unit update
  // ------------------------------------------------------------------------------------------

  private updateTimers(u: Unit, dt: number): void {
    u.stateT += dt;
    u.cdHook = Math.max(0, u.cdHook - dt);
    u.cdGrapple = Math.max(0, u.cdGrapple - dt);
    u.cdBash = Math.max(0, u.cdBash - dt);
    u.cdMelee = Math.max(0, u.cdMelee - dt);
    u.haste = Math.max(0, u.haste - dt);
    u.double = Math.max(0, u.double - dt);
    u.ghost = Math.max(0, u.ghost - dt);
    u.puff = Math.max(0, u.puff - dt);
    u.bendy = Math.max(0, u.bendy - dt);
    u.bouncy = Math.max(0, u.bouncy - dt);
    u.longshot = Math.max(0, u.longshot - dt);
    u.bristleCd = Math.max(0, u.bristleCd - dt);
    if (u.shieldT > 0) {
      u.shieldT -= dt;
      if (u.shieldT <= 0) u.shield = 0;
    }
    if (u.state === UnitState.Dead) {
      u.respawnT -= dt;
      if (u.respawnT <= 0 && u.hookedBy < 0 && this.phase !== 'ended') this.respawn(u);
      return;
    }
    u.spawnProt = Math.max(0, u.spawnProt - dt);
    if (u.burnT > 0) {
      u.burnT -= dt;
      this.damage(u, u.burnDps * dt, u.burnSrc, 'burn');
      if (this.isDead(u)) return;
    }
    if (u.pieT > 0) {
      u.pieT -= dt;
      this.heal(u, (BAL.pieHeal / BAL.pieTime) * dt, true);
    }
    const regen = FAMILY_DEFS[u.family].regenOutOfCombat;
    if (this.time - u.lastDamageT > 4 && u.hp < u.maxHp) this.heal(u, regen * dt);
  }

  private updateUnit(u: Unit, dt: number): void {
    switch (u.state) {
      case UnitState.Dead:
        u.vx = u.vz = 0;
        if (u.hookedBy < 0) u.y = Math.max(-1.5, u.y - dt * 0.5);
        return;
      case UnitState.Hooked:
        u.vx = u.vz = 0;
        u.y = 0.35;
        return; // the hook drags us
      case UnitState.Grappling:
        return; // the grapple flies us
      case UnitState.Knocked:
        this.updateKnock(u, dt);
        return;
      case UnitState.Casting:
        u.castT -= dt;
        this.faceToward(u, u.castAx, u.castAz);
        u.vx *= 0.5;
        u.vz *= 0.5;
        u.moveMul = 0;
        if (u.castT <= 0) {
          const kind = u.castKind!;
          u.state = UnitState.Alive;
          u.castKind = null;
          this.launch(u, kind);
        }
        return;
      default:
        break;
    }
    // Alive or Drowning: player-driven movement
    u.moveMul = this.moveMultiplier(u);
    const mx = this.phase === 'ended' ? 0 : u.input.mx;
    const mz = this.phase === 'ended' ? 0 : u.input.mz;
    const surf = stepMove(this.world, this.river, u, mx, mz, u.moveMul, dt);
    u.surface = surf;
    u.y = u.state === UnitState.Drowning ? -0.55 - Math.min(1, u.drownT / BAL.drownTime) * 0.5 : 0;
    const sp2 = u.vx * u.vx + u.vz * u.vz;
    if (sp2 > 0.25) u.face = Math.atan2(u.vx, u.vz);
    // Hook / Grapple wind-up runs while walking; the throw leaves from wherever the hand is now.
    if (u.castKind && u.state === UnitState.Alive) {
      u.castT -= dt;
      if (u.castT <= 0) {
        const kind = u.castKind;
        u.castKind = null;
        u.castT = 0;
        this.launch(u, kind);
      }
    }
    this.updateMelee(u, dt);
  }

  moveMultiplier(u: Unit): number {
    const fam = FAMILY_DEFS[u.family];
    let m = fam.speedMul;
    if (u.items.some((s) => s && s.id === 'wellies')) m *= BAL.welliesMul;
    if (u.haste > 0) m *= BAL.hasteMul;
    if (u.castKind && u.state === UnitState.Alive) m *= BAL.castMoveMul;
    if (u.activeHook >= 0) m *= BAL.hookMoveSlow;
    if (u.meleeT > 0) m *= 0.75;
    if (u.inHazard) m *= this.hazardSlow(u);
    return m;
  }

  private hazardSlow(u: Unit): number {
    let m = 1;
    for (const hz of this.hazards) {
      if (!this.hazardActive(hz)) continue;
      if (dist2(u.x, u.z, hz.x, hz.z) > (hz.r + UNIT_RADIUS * 0.5) ** 2) continue;
      if (hz.kind === 'thorns') m = Math.min(m, 0.7);
      else if (hz.kind === 'quicksand') m = Math.min(m, 0.45);
      else if (hz.kind === 'jellyfish') m = Math.min(m, 0.75);
    }
    return m;
  }

  hazardActive(hz: HazardInst): boolean {
    if (!hz.channel) return true;
    return !this.river.deep;
  }

  private updateKnock(u: Unit, dt: number): void {
    const t = u.knockDur - u.knockT;
    const prog = clamp(t / u.knockDur, 0, 1);
    const k = 1 - prog;
    let nx = u.x + u.knockVx * k * dt;
    let nz = u.z + u.knockVz * k * dt;
    this.world.resolveCircle(nx, nz, UNIT_RADIUS, tmpPos);
    nx = tmpPos.x;
    nz = tmpPos.z;
    u.vx = (nx - u.x) / dt;
    u.vz = (nz - u.z) / dt;
    u.x = nx;
    u.z = nz;
    u.y = Math.sin(prog * Math.PI) * u.knockH;
    u.knockT -= dt;
    if (u.knockT <= 0) {
      u.state = UnitState.Alive;
      u.y = 0;
      u.vx *= 0.2;
      u.vz *= 0.2;
    }
  }

  private updateMelee(u: Unit, dt: number): void {
    if (this.phase !== 'playing' || u.state !== UnitState.Alive) {
      u.meleeT = 0;
      return;
    }
    if (u.meleeT > 0) {
      u.meleeT -= dt;
      if (u.meleeT <= 0) {
        const t = this.unitById.get(u.meleeTarget);
        if (t && this.isHittable(t) && dist(u.x, u.z, t.x, t.z) <= BAL.meleeRange + 0.6) {
          const dmg = BAL.meleeDamage * (u.double > 0 ? 2 : 1);
          this.emit({ e: 'melee', u: u.id, tg: t.id, dmg });
          this.damage(t, dmg, u.id, 'melee');
        }
      }
      return;
    }
    // no wallop while winding up a throw, while stealthed, or while spawn-protected (immune units do not hit)
    if (u.cdMelee > 0 || u.castKind || u.spawnProt > 0 || this.isStealthed(u)) return;
    let best: Unit | null = null;
    let bd = BAL.meleeRange * BAL.meleeRange;
    for (const e of this.units) {
      if (e.team === u.team || !this.isHittable(e)) continue;
      if (e.state === UnitState.Hooked || e.state === UnitState.Grappling) continue;
      if (!this.visibleTo(e, u.team)) continue;
      const d2v = dist2(u.x, u.z, e.x, e.z);
      if (d2v < bd) {
        bd = d2v;
        best = e;
      }
    }
    if (best) {
      u.meleeT = BAL.meleeWindup;
      u.meleeTarget = best.id;
      u.cdMelee = BAL.meleeCooldown;
      this.faceToward(u, best.x, best.z);
      this.emit({ e: 'cast', u: u.id, k: 'melee', x: q2(u.x), z: q2(u.z), ax: q2(best.x), az: q2(best.z) });
    }
  }

  private postMove(u: Unit, dt: number): void {
    if (u.state === UnitState.Dead) return;
    const inWaterZone = this.world.channel(u.x, u.z) > 0;
    const free = u.state === UnitState.Alive || u.state === UnitState.Casting || u.state === UnitState.Drowning;
    if (free) {
      if (inWaterZone && this.river.deep) {
        if (u.state !== UnitState.Drowning) {
          // drownT is NOT reset here: a unit knocked about while drowning keeps its clock
          this.interrupt(u);
          u.state = UnitState.Drowning;
          u.stateT = 0;
          this.emit({ e: 'drownStart', u: u.id, x: q2(u.x), z: q2(u.z) });
          this.emit({ e: 'splash', u: u.id, x: q2(u.x), z: q2(u.z), s: 1 });
        } else {
          if (this.phase !== 'ended') u.drownT += dt;
          if (u.drownT >= BAL.drownTime) {
            this.kill(u, -1, 'drown');
            return;
          }
        }
      } else {
        u.drownT = 0; // any free unit out of deep water starts the next swim with a clean timer
        if (u.state === UnitState.Drowning) {
          u.state = UnitState.Alive;
          u.y = 0;
          this.emit({ e: 'drownSave', u: u.id });
        }
      }
    }
    // fountains
    for (let t = 0; t < 2; t++) {
      const f = this.map.fountains[t];
      if (dist2(u.x, u.z, f.x, f.z) > f.r * f.r) continue;
      if (t === u.team) this.heal(u, BAL.fountainHeal * u.maxHp * dt, true);
      else if (this.phase === 'playing') this.damage(u, BAL.fountainBurn * u.maxHp * dt, -1, 'fountain');
    }
  }

  private separateUnits(): void {
    const us = this.units;
    for (let i = 0; i < us.length; i++) {
      const a = us[i];
      if (!this.isSolid(a)) continue;
      for (let j = i + 1; j < us.length; j++) {
        const b = us[j];
        if (!this.isSolid(b)) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2v = dx * dx + dz * dz;
        const min = UNIT_RADIUS * 2;
        if (d2v >= min * min || d2v < 1e-8) continue;
        const d = Math.sqrt(d2v);
        const push = (min - d) * 0.5;
        const nx = dx / d;
        const nz = dz / d;
        this.nudge(a, -nx * push, -nz * push);
        this.nudge(b, nx * push, nz * push);
      }
    }
  }

  /** Move a unit by a small offset without ever shoving it from land into deep water. */
  private nudge(u: Unit, dx: number, dz: number): void {
    let nx = u.x + dx;
    let nz = u.z + dz;
    if (this.river.deep && this.world.channel(u.x, u.z) <= 0 && this.world.channel(nx, nz) > 0) {
      const r = blockWater(this.world, nx, nz);
      nx = r.x;
      nz = r.z;
    }
    this.world.resolveCircle(nx, nz, UNIT_RADIUS, tmpPos);
    u.x = tmpPos.x;
    u.z = tmpPos.z;
  }

  private isSolid(u: Unit): boolean {
    return u.state === UnitState.Alive || u.state === UnitState.Casting || u.state === UnitState.Drowning;
  }

  // ------------------------------------------------------------------------------------------
  // Hooks and grapples
  // ------------------------------------------------------------------------------------------

  private spawnHook(u: Unit, kind: 0 | 1): void {
    let dx = u.castAx - u.x;
    let dz = u.castAz - u.z;
    let l = Math.sqrt(dx * dx + dz * dz);
    if (l < 0.3) {
      dx = Math.sin(u.face);
      dz = Math.cos(u.face);
      l = 1;
    }
    dx /= l;
    dz /= l;
    u.face = Math.atan2(dx, dz);
    const isHook = kind === HookKind.Hook;
    // power-up runes: Boing Barb (bouncy), Long Line (longshot), Bendy Eel (steer toward the cursor)
    const bouncy = isHook && u.bouncy > 0;
    const longshot = isHook && u.longshot > 0;
    const ricochet = isHook && (bouncy || u.items.some((s) => s && s.id === 'ricochet'));
    const r = isHook ? HOOK_LEVELS.width[u.up.width] : BAL.grappleRadius;
    let hx = u.x + dx * BAL.hookHand;
    let hz = u.z + dz * BAL.hookHand;
    // hugging a wall or post: never spawn the head on the far side of it
    const wall = this.world.sweep(u.x, u.z, hx, hz, r);
    if (wall && wall.what !== 'bounds') {
      hx = u.x + (hx - u.x) * Math.max(0, wall.t - 0.02);
      hz = u.z + (hz - u.z) * Math.max(0, wall.t - 0.02);
    }
    const h: Hook = {
      id: this.nextId++,
      owner: u.id,
      kind,
      phase: HookPhase.Out,
      x: hx,
      z: hz,
      dx,
      dz,
      speed: isHook ? HOOK_LEVELS.speed[u.up.speed] * (longshot ? BAL.longshotSpeedMul : 1) : BAL.grappleSpeed,
      r,
      range: isHook ? HOOK_LEVELS.range[u.up.range] * (longshot ? BAL.longshotRangeMul : 1) : BAL.grappleRange,
      traveled: 0,
      pts: [],
      bounces: ricochet ? (bouncy ? Math.max(BAL.ricochetBounces, BAL.bouncyBounces) : BAL.ricochetBounces) : 0,
      tg: -1,
      ru: -1,
      ember: isHook && u.items.some((s) => s && s.id === 'ember'),
      ricochet,
      steer: isHook && u.bendy > 0,
      longshot,
      dmg: isHook ? HOOK_LEVELS.damage[u.up.damage] * (u.double > 0 ? 2 : 1) : 0,
      anchorUnit: -1,
      flightT: 0,
      dead: false,
      bendAcc: 0,
    };
    this.hooks.push(h);
    if (isHook) {
      u.activeHook = h.id;
      u.stats.ht++;
    } else u.activeGrapple = h.id;
    this.emit({ e: 'hookLaunch', u: u.id, h: h.id, k: kind, x: q2(h.x), z: q2(h.z), dx: q2(dx), dz: q2(dz) });
    if (wall && wall.what !== 'bounds') {
      // the head is already against the wall: it clinks and comes straight back
      if (h.kind === HookKind.Grapple) this.grappleLatch(h, u, h.x, h.z, -1);
      else {
        this.emit({ e: 'hookWall', u: u.id, x: q2(h.x), z: q2(h.z) });
        this.startRetract(h);
      }
    }
  }

  hookById(id: number): Hook | undefined {
    for (const h of this.hooks) if (h.id === id && !h.dead) return h;
    return undefined;
  }

  private handPos(u: Unit): { x: number; z: number } {
    return { x: u.x + Math.sin(u.face) * BAL.hookHand * 0.8, z: u.z + Math.cos(u.face) * BAL.hookHand * 0.8 };
  }

  private updateHook(h: Hook, dt: number): void {
    const owner = this.unitById.get(h.owner);
    if (!owner || owner.state === UnitState.Dead) {
      this.breakHook(h);
      return;
    }
    if (h.phase === HookPhase.Out) this.hookOut(h, owner, dt);
    else if (h.phase === HookPhase.Back) this.hookBack(h, owner, dt);
    else this.grapplePull(h, owner, dt);
  }

  private hookOut(h: Hook, owner: Unit, dt: number): void {
    let remaining = h.speed * dt;
    const wp = this.map.whirlpool;
    while (remaining > 1e-6 && h.phase === HookPhase.Out && !h.dead) {
      const step = Math.min(remaining, HOOK_SUBSTEP);
      remaining -= step;
      if (h.steer) this.steerHook(h, owner, step);
      if (wp) {
        const d = dist(h.x, h.z, wp.x, wp.z);
        if (d < wp.r) {
          const w = wp.strength * (1 - d / wp.r);
          const a = w * (step / h.speed);
          const c = Math.cos(a);
          const s = Math.sin(a);
          const ndx = h.dx * c - h.dz * s;
          const ndz = h.dx * s + h.dz * c;
          h.dx = ndx;
          h.dz = ndz;
          h.bendAcc += Math.abs(a);
          if (h.bendAcc > 0.1 && h.pts.length < MAX_BEND_PTS) {
            h.pts.push(q2(h.x), q2(h.z));
            h.bendAcc = 0;
          }
        }
      }
      const nx = h.x + h.dx * step;
      const nz = h.z + h.dz * step;
      let bestT = 2;
      let hitUnit: Unit | null = null;
      let hitRune: Rune | null = null;
      for (const u of this.units) {
        if (u.id === h.owner || u.state === UnitState.Dead || u.spawnProt > 0) continue;
        if (h.kind === HookKind.Hook && u.hookedBy === h.id) continue;
        const t = sweepCircle(h.x, h.z, nx, nz, u.x, u.z, h.r + UNIT_RADIUS);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hitUnit = u;
        }
      }
      if (h.kind === HookKind.Hook) {
        for (const r of this.runes) {
          if (r.dragged) continue;
          const t = sweepCircle(h.x, h.z, nx, nz, r.x, r.z, h.r + BAL.runeRadius);
          if (t >= 0 && t < bestT) {
            bestT = t;
            hitRune = r;
            hitUnit = null;
          }
        }
      }
      const c = this.world.sweep(h.x, h.z, nx, nz, h.r);
      if (c && c.t < bestT) {
        bestT = c.t;
        hitUnit = null;
        hitRune = null;
      } else if (bestT > 1) {
        h.x = nx;
        h.z = nz;
        h.traveled += step;
        if (h.traveled >= h.range) this.startRetract(h);
        continue;
      }
      // move to contact
      h.x += h.dx * step * bestT;
      h.z += h.dz * step * bestT;
      h.traveled += step * bestT;
      if (hitUnit) {
        if (h.kind === HookKind.Hook) this.hookHitUnit(h, owner, hitUnit);
        else this.grappleLatch(h, owner, hitUnit.x, hitUnit.z, hitUnit.id);
      } else if (hitRune) {
        hitRune.dragged = true;
        h.ru = hitRune.id;
        this.emit({ e: 'runeGrab', u: owner.id, r: hitRune.id, t: hitRune.type });
        this.startRetract(h);
      } else if (c) {
        if (h.kind === HookKind.Grapple) {
          if (c.what === 'mover' && this.river.deep) {
            // a log or barge floating in deep water is no anchor: latching would drop you in the river
            this.emit({ e: 'hookWall', u: owner.id, x: q2(h.x), z: q2(h.z) });
            this.startRetract(h);
          } else this.grappleLatch(h, owner, h.x, h.z, -1);
        } else if (c.bouncy || h.bounces > 0) {
          if (!c.bouncy) h.bounces--;
          const dot = h.dx * c.nx + h.dz * c.nz;
          h.dx -= 2 * dot * c.nx;
          h.dz -= 2 * dot * c.nz;
          const l = Math.sqrt(h.dx * h.dx + h.dz * h.dz) || 1;
          h.dx /= l;
          h.dz /= l;
          h.x += c.nx * 0.02;
          h.z += c.nz * 0.02;
          if (h.pts.length < MAX_BEND_PTS) h.pts.push(q2(h.x), q2(h.z));
          this.emit({ e: 'hookBounce', u: owner.id, x: q2(h.x), z: q2(h.z) });
        } else {
          this.emit({ e: 'hookWall', u: owner.id, x: q2(h.x), z: q2(h.z) });
          this.startRetract(h);
        }
      }
    }
  }

  /** Bendy Eel: the flying hook curves toward the thrower's live cursor at a limited turn rate. */
  private steerHook(h: Hook, owner: Unit, step: number): void {
    const tx = owner.input.ax - h.x;
    const tz = owner.input.az - h.z;
    if (tx * tx + tz * tz < 1) return; // cursor on top of the head: keep going straight
    const cur = Math.atan2(h.dx, h.dz);
    let d = angleDelta(cur, Math.atan2(tx, tz));
    if (Math.abs(d) > 2.6) return; // never loop back on itself
    const maxTurn = BAL.bendyTurn * (step / h.speed);
    d = clamp(d, -maxTurn, maxTurn);
    const a = cur + d;
    h.dx = Math.sin(a);
    h.dz = Math.cos(a);
    h.bendAcc += Math.abs(d);
    if (h.bendAcc > 0.07 && h.pts.length < MAX_BEND_PTS) {
      h.pts.push(q2(h.x), q2(h.z));
      h.bendAcc = 0;
    }
  }

  private startRetract(h: Hook): void {
    h.phase = HookPhase.Back;
  }

  private hookHitUnit(h: Hook, owner: Unit, t: Unit): void {
    const ally = t.team === owner.team;
    let saved = false;
    if (t.hookedBy >= 0) {
      const old = this.hookById(t.hookedBy);
      if (old) {
        old.tg = -1;
        this.startRetract(old);
        this.emit({ e: 'hookSteal', u: owner.id, from: old.owner, tg: t.id });
        const oldOwner = this.unitById.get(old.owner);
        if (ally && oldOwner && oldOwner.team !== owner.team) saved = true;
      }
    }
    if (ally && t.state === UnitState.Drowning) saved = true;
    if (ally && t.hp < t.maxHp * 0.3) {
      for (const e of this.units) {
        if (e.team !== owner.team && e.state !== UnitState.Dead && dist2(e.x, e.z, t.x, t.z) < 36) {
          saved = true;
          break;
        }
      }
    }
    // the target loses control: break its own hook, grapple, cast; the chain on it gives it away
    this.interrupt(t);
    this.breakStealth(t);
    if (t.state !== UnitState.Dead) {
      t.state = UnitState.Hooked;
      t.stateT = 0;
      t.drownT = 0;
    }
    t.hookedBy = h.id;
    h.tg = t.id;
    let dmg = 0;
    let bull = false;
    if (!ally && t.state !== UnitState.Dead) {
      dmg = h.dmg;
      if (owner.items.some((s) => s && s.id === 'sinker') && this.rng.chance(BAL.sinkerChance)) {
        dmg *= BAL.sinkerMul;
        bull = true;
        owner.stats.bs++;
      }
      owner.stats.hh++;
      this.giveGold(owner, BAL.goldHookHit);
    }
    this.emit({ e: 'hookHit', u: owner.id, tg: t.id, ally, dmg: Math.round(dmg), bull, x: q2(h.x), z: q2(h.z) });
    if (bull) this.announce('bullseye', owner.id, 1);
    if (saved) {
      owner.stats.sv++;
      this.announce('save', owner.id, 1);
    }
    if (dmg > 0) {
      this.damage(t, dmg, owner.id, 'hook');
      if (h.ember && t.state !== UnitState.Dead) {
        t.burnT = BAL.emberTime;
        t.burnDps = BAL.emberDps;
        t.burnSrc = owner.id;
      }
    }
    this.startRetract(h);
  }

  private grappleLatch(h: Hook, owner: Unit, x: number, z: number, unitId: number): void {
    h.phase = HookPhase.Pull;
    h.x = x;
    h.z = z;
    h.anchorUnit = unitId;
    if (unitId >= 0) {
      const a = this.unitById.get(unitId);
      if (a) this.breakStealth(a);
    }
    h.pts.length = 0;
    h.flightT = 0;
    this.interruptCastOnly(owner);
    owner.state = UnitState.Grappling;
    owner.stateT = 0;
    owner.drownT = 0;
    if (owner.activeHook >= 0) {
      const oh = this.hookById(owner.activeHook);
      if (oh) this.breakHook(oh);
    }
    this.emit({ e: 'grappleHit', u: owner.id, x: q2(x), z: q2(z) });
  }

  private hookBack(h: Hook, owner: Unit, dt: number): void {
    let move = h.speed * BAL.hookRetractMul * dt;
    const hand = this.handPos(owner);
    while (move > 1e-6) {
      const hasPt = h.pts.length >= 2;
      const tx = hasPt ? h.pts[h.pts.length - 2] : hand.x;
      const tz = hasPt ? h.pts[h.pts.length - 1] : hand.z;
      const d = dist(h.x, h.z, tx, tz);
      if (d <= move) {
        h.x = tx;
        h.z = tz;
        move -= d;
        if (hasPt) {
          h.pts.length -= 2;
          continue;
        }
        this.finishHook(h, owner);
        return;
      }
      h.x += ((tx - h.x) / d) * move;
      h.z += ((tz - h.z) / d) * move;
      move = 0;
    }
    this.dragAttached(h);
  }

  private dragAttached(h: Hook): void {
    if (h.tg >= 0) {
      const t = this.unitById.get(h.tg);
      if (t) {
        t.x = h.x;
        t.z = h.z;
        t.vx = t.vz = 0;
      } else h.tg = -1;
    }
    if (h.ru >= 0) {
      const r = this.runes.find((x) => x.id === h.ru);
      if (r) {
        r.x = h.x;
        r.z = h.z;
      } else h.ru = -1;
    }
  }

  private finishHook(h: Hook, owner: Unit): void {
    h.dead = true;
    if (h.kind === HookKind.Hook) owner.activeHook = -1;
    else owner.activeGrapple = -1;
    let tgId = -1;
    if (h.tg >= 0) {
      const t = this.unitById.get(h.tg);
      if (t) {
        tgId = t.id;
        const p = this.deliveryPoint(owner, t);
        t.x = p.x;
        t.z = p.z;
        t.hookedBy = -1;
        t.y = 0;
        if (t.state === UnitState.Dead) this.emit({ e: 'corpse', v: t.id, x: q2(t.x), z: q2(t.z) });
        else {
          t.state = UnitState.Alive;
          t.stateT = 0;
          t.vx = t.vz = 0;
        }
      }
    }
    if (h.ru >= 0) {
      const ri = this.runes.findIndex((x) => x.id === h.ru);
      if (ri >= 0) {
        const r = this.runes[ri];
        this.runes.splice(ri, 1);
        this.grantRune(owner, r.type);
      }
    }
    this.emit({ e: 'hookDone', u: owner.id, tg: tgId, x: q2(h.x), z: q2(h.z) });
  }

  /** Where a hooked target lands: next to the caster, on land, clear of obstacles. */
  private deliveryPoint(owner: Unit, t: Unit): { x: number; z: number } {
    let ax = t.x - owner.x;
    let az = t.z - owner.z;
    let l = Math.sqrt(ax * ax + az * az);
    if (l < 1e-3) {
      ax = Math.sin(owner.face);
      az = Math.cos(owner.face);
      l = 1;
    }
    const base = Math.atan2(ax / l, az / l);
    const ownerDry = this.world.channel(owner.x, owner.z) <= 0;
    for (let i = 0; i < 12; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      const a = base + sign * Math.ceil(i / 2) * (Math.PI / 6);
      const px = owner.x + Math.sin(a) * BAL.hookDeliver;
      const pz = owner.z + Math.cos(a) * BAL.hookDeliver;
      this.world.resolveCircle(px, pz, UNIT_RADIUS, tmpPos);
      if (Math.abs(tmpPos.x - px) + Math.abs(tmpPos.z - pz) > 0.3) continue;
      if (this.river.deep && ownerDry && this.world.channel(px, pz) > -0.1) continue;
      return { x: px, z: pz };
    }
    this.world.resolveCircle(owner.x + Math.sin(base) * 0.4, owner.z + Math.cos(base) * 0.4, UNIT_RADIUS, tmpPos);
    return { x: tmpPos.x, z: tmpPos.z };
  }

  private grapplePull(h: Hook, owner: Unit, dt: number): void {
    if (h.anchorUnit >= 0) {
      const a = this.unitById.get(h.anchorUnit);
      if (a && a.state !== UnitState.Dead) {
        h.x = a.x;
        h.z = a.z;
      } else h.anchorUnit = -1;
    }
    const stop = h.anchorUnit >= 0 ? UNIT_RADIUS * 2 + 0.1 : UNIT_RADIUS + 0.15;
    const dx = h.x - owner.x;
    const dz = h.z - owner.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1e-4;
    h.flightT += dt;
    const step = BAL.grapplePull * dt;
    const travel = Math.min(step, Math.max(0, d - stop));
    if (d - stop <= step || h.flightT >= BAL.grappleMaxFlight) {
      owner.x += (dx / d) * travel;
      owner.z += (dz / d) * travel;
      this.world.resolveCircle(owner.x, owner.z, UNIT_RADIUS, tmpPos);
      owner.x = tmpPos.x;
      owner.z = tmpPos.z;
      owner.y = 0;
      owner.state = UnitState.Alive;
      owner.stateT = 0;
      owner.vx = (dx / d) * 3;
      owner.vz = (dz / d) * 3;
      owner.activeGrapple = -1;
      h.dead = true;
      this.emit({ e: 'grappleLand', u: owner.id, x: q2(owner.x), z: q2(owner.z) });
      return;
    }
    owner.x += (dx / d) * step;
    owner.z += (dz / d) * step;
    owner.face = Math.atan2(dx, dz);
    owner.y = Math.sin(clamp(h.flightT / 0.6, 0, 1) * Math.PI) * 1.2 + 0.2;
  }

  /** Break a hook early (owner interrupted or died): drop whatever it carries where it is. */
  breakHook(h: Hook): void {
    if (h.dead) return;
    h.dead = true;
    const owner = this.unitById.get(h.owner);
    if (owner) {
      if (h.kind === HookKind.Hook && owner.activeHook === h.id) owner.activeHook = -1;
      if (h.kind === HookKind.Grapple && owner.activeGrapple === h.id) {
        owner.activeGrapple = -1;
        if (owner.state === UnitState.Grappling) {
          owner.state = UnitState.Alive;
          owner.y = 0;
        }
      }
    }
    let tgId = -1;
    if (h.tg >= 0) {
      const t = this.unitById.get(h.tg);
      if (t && t.hookedBy === h.id) {
        tgId = t.id;
        t.hookedBy = -1;
        this.world.resolveCircle(t.x, t.z, UNIT_RADIUS, tmpPos);
        t.x = tmpPos.x;
        t.z = tmpPos.z;
        t.y = 0;
        if (t.state === UnitState.Dead) this.emit({ e: 'corpse', v: t.id, x: q2(t.x), z: q2(t.z) });
        else t.state = UnitState.Alive; // postMove decides if they now drown
      }
    }
    if (h.ru >= 0) {
      const r = this.runes.find((x) => x.id === h.ru);
      if (r) r.dragged = false;
    }
    this.emit({ e: 'hookBreak', u: h.owner, tg: tgId, x: q2(h.x), z: q2(h.z) });
  }

  private checkClashes(): void {
    const hs = this.hooks;
    for (let i = 0; i < hs.length; i++) {
      const a = hs[i];
      if (a.dead || a.kind !== HookKind.Hook || a.phase !== HookPhase.Out) continue;
      const aTeam = this.unitById.get(a.owner)?.team;
      for (let j = 0; j < hs.length; j++) {
        if (i === j) continue;
        const b = hs[j];
        if (b.dead || b.kind !== HookKind.Hook || b.owner === a.owner) continue;
        if (this.unitById.get(b.owner)?.team === aTeam) continue; // allies' hooks pass through each other
        if (b.phase === HookPhase.Back && b.tg >= 0) continue;
        const rr = a.r + b.r + 0.1;
        if (dist2(a.x, a.z, b.x, b.z) < rr * rr) {
          this.startRetract(a);
          this.startRetract(b);
          this.emit({ e: 'hookClash', a: a.owner, b: b.owner, x: q2((a.x + b.x) / 2), z: q2((a.z + b.z) / 2) });
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Bash, knockback, interrupts
  // ------------------------------------------------------------------------------------------

  private doBash(u: Unit): void {
    let dx = u.castAx - u.x;
    let dz = u.castAz - u.z;
    let l = Math.sqrt(dx * dx + dz * dz);
    if (l < 0.3) {
      dx = Math.sin(u.face);
      dz = Math.cos(u.face);
      l = 1;
    }
    dx /= l;
    dz /= l;
    u.face = Math.atan2(dx, dz);
    const hits: number[] = [];
    const cosHalf = Math.cos(BAL.bashArc / 2);
    for (const t of this.units) {
      if (t.team === u.team || !this.isHittable(t)) continue;
      if (t.state === UnitState.Hooked) continue;
      const tx = t.x - u.x;
      const tz = t.z - u.z;
      const d = Math.sqrt(tx * tx + tz * tz);
      if (d > BAL.bashRange + UNIT_RADIUS) continue;
      if (d > 1.2 && (tx * dx + tz * dz) / d < cosHalf) continue;
      hits.push(t.id);
      const kx = dx * 0.6 + (d > 1e-3 ? (tx / d) * 0.4 : 0);
      const kz = dz * 0.6 + (d > 1e-3 ? (tz / d) * 0.4 : 0);
      this.damage(t, BAL.bashDamage * (u.double > 0 ? 2 : 1), u.id, 'bash');
      if (t.state !== UnitState.Dead) this.knock(t, kx, kz, BAL.bashKnock, BAL.bashKnockTime, 0.7);
    }
    this.emit({ e: 'bash', u: u.id, x: q2(u.x), z: q2(u.z), dx: q2(dx), dz: q2(dz), hits });
  }

  knock(t: Unit, dx: number, dz: number, distance: number, dur: number, height: number): void {
    if (t.state === UnitState.Dead || t.state === UnitState.Hooked || t.spawnProt > 0) return;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    this.interrupt(t);
    t.state = UnitState.Knocked;
    t.stateT = 0;
    t.knockDur = dur;
    t.knockT = dur;
    t.knockH = height;
    const v0 = (2 * distance) / dur;
    t.knockVx = (dx / l) * v0;
    t.knockVz = (dz / l) * v0;
  }

  /** Cancel everything a unit was doing: wind-ups, own hook, grapple flight. */
  interrupt(u: Unit): void {
    this.interruptCastOnly(u);
    if (u.activeHook >= 0) {
      const h = this.hookById(u.activeHook);
      if (h) this.breakHook(h);
      u.activeHook = -1;
    }
    if (u.activeGrapple >= 0) {
      const h = this.hookById(u.activeGrapple);
      if (h) this.breakHook(h);
      u.activeGrapple = -1;
    }
    if (u.state === UnitState.Grappling || u.state === UnitState.Knocked) {
      u.state = UnitState.Alive;
      u.y = 0;
    }
  }

  private interruptCastOnly(u: Unit): void {
    if (u.state === UnitState.Casting) u.state = UnitState.Alive;
    u.castKind = null;
    u.castT = 0;
    u.meleeT = 0;
    u.buffered = null;
  }

  /** Detach a unit from anything holding it (used on removal). */
  private releaseUnit(u: Unit): void {
    if (u.hookedBy >= 0) {
      const h = this.hookById(u.hookedBy);
      if (h) h.tg = -1;
      u.hookedBy = -1;
    }
    this.interrupt(u);
  }

  // ------------------------------------------------------------------------------------------
  // Damage, healing, kills
  // ------------------------------------------------------------------------------------------

  isDead(u: Unit): boolean {
    return u.state === UnitState.Dead;
  }

  isHittable(u: Unit): boolean {
    return u.state !== UnitState.Dead && u.spawnProt <= 0;
  }

  damage(t: Unit, amount: number, src: number, cause: KillCause): number {
    if (t.state === UnitState.Dead || t.spawnProt > 0 || amount <= 0 || this.phase === 'ended') return 0;
    let amt = amount;
    if (t.shield > 0) {
      const absorbed = Math.min(t.shield, amt);
      t.shield -= absorbed;
      amt -= absorbed;
      if (absorbed >= 1 && cause !== 'burn' && cause !== 'fountain' && cause !== 'hazard') {
        this.emit({ e: 'dmg', tg: t.id, src, amt: Math.round(absorbed), kind: 'shield' });
      }
    }
    // credit and combat timer first: a shield that soaks a bash must not erase the drowning credit
    t.lastDamageT = this.time;
    const s = src >= 0 ? this.unitById.get(src) : undefined;
    if (s && s.team !== t.team) t.damagers.set(s.id, this.time);
    if (amt <= 0) return 0;
    t.hp -= amt;
    t.pieT = 0;
    if (s && s.team !== t.team) {
      s.stats.dmg += amt;
    }
    const dot = cause === 'burn' || cause === 'fountain' || cause === 'hazard';
    if (!dot) this.emit({ e: 'dmg', tg: t.id, src, amt: Math.round(amt), kind: cause });
    else if (this.tick % 10 === 0) this.emit({ e: 'dmg', tg: t.id, src, amt: Math.max(1, Math.round(amt * 10)), kind: cause });
    if (t.hp <= 0) {
      t.hp = 0;
      this.kill(t, src, cause);
    }
    return amt;
  }

  /** visible: pie and fountain healing is shown as rising numbers (batched every half second) */
  heal(u: Unit, amt: number, visible = false): void {
    if (u.state === UnitState.Dead || u.hp >= u.maxHp) return;
    const before = u.hp;
    u.hp = Math.min(u.maxHp, u.hp + amt);
    if (visible) u.healAcc += u.hp - before;
  }

  private flushHeals(): void {
    for (const u of this.units) {
      if (u.healAcc >= 5) this.emit({ e: 'heal', tg: u.id, amt: Math.round(u.healAcc) });
      u.healAcc = 0;
    }
  }

  private creditKiller(v: Unit, src: number): Unit | null {
    const s = src >= 0 ? this.unitById.get(src) : undefined;
    if (s && s.team !== v.team) return s;
    let best: Unit | null = null;
    let bestT = this.time - BAL.creditWindow;
    for (const [id, t] of v.damagers) {
      if (t < bestT) continue;
      const u = this.unitById.get(id);
      if (u && u.team !== v.team) {
        best = u;
        bestT = t;
      }
    }
    return best;
  }

  kill(v: Unit, src: number, cause: KillCause): void {
    if (v.state === UnitState.Dead || this.phase === 'ended') return;
    const killer = this.creditKiller(v, src);
    const wasHooked = v.hookedBy >= 0;
    // Cancel what the victim was doing but keep it attached if a hook is dragging the corpse.
    this.interruptCastOnly(v);
    if (v.activeHook >= 0) {
      const h = this.hookById(v.activeHook);
      if (h) this.breakHook(h);
    }
    if (v.activeGrapple >= 0) {
      const h = this.hookById(v.activeGrapple);
      if (h) this.breakHook(h);
    }
    v.state = UnitState.Dead;
    v.stateT = 0;
    v.hp = 0;
    v.burnT = 0;
    v.pieT = 0;
    v.haste = v.double = v.ghost = v.puff = 0;
    v.bendy = v.bouncy = v.longshot = 0;
    v.shield = v.shieldT = 0;
    v.drownT = 0;
    v.stats.d++;
    v.respawnT = Math.min(BAL.respawnMax, BAL.respawnBase + BAL.respawnPerDeath * (v.stats.d - 1));
    const victimStreak = v.streak;
    v.streak = 0;
    const assists: number[] = [];
    for (const [id, t] of v.damagers) {
      if (this.time - t > BAL.assistWindow) continue;
      if (killer && id === killer.id) continue;
      const a = this.unitById.get(id);
      if (!a || a.team === v.team) continue;
      a.stats.a++;
      this.giveGold(a, BAL.goldAssist);
      assists.push(id);
    }
    v.damagers.clear();
    if (killer) {
      killer.stats.k++;
      killer.streak++;
      this.giveGold(killer, BAL.goldKill + BAL.goldStreakBonus * Math.floor(victimStreak / 3));
      if (cause === 'drown') killer.stats.dr++;
      if (!this.firstBlood) {
        this.firstBlood = true;
        this.announce('firstBlood', killer.id, 1);
      }
      if (this.time - killer.lastKillT < 10) killer.multi++;
      else killer.multi = 1;
      killer.lastKillT = this.time;
      if (killer.multi === 2) this.announce('doubleHook', killer.id, 2);
      else if (killer.multi === 3) this.announce('tripleHook', killer.id, 3);
      else if (killer.multi >= 4) this.announce('ultraHook', killer.id, killer.multi);
      if (killer.streak === 3) this.announce('spree3', killer.id, 3);
      else if (killer.streak === 5) this.announce('spree5', killer.id, 5);
      else if (killer.streak === 8) this.announce('spree8', killer.id, 8);
    }
    if (victimStreak >= 3 && killer) this.announce('shutdown', killer.id, victimStreak);
    if (cause === 'drown') this.announce('drowned', v.id, 1);
    this.emit({ e: 'kill', k: killer ? killer.id : -1, v: v.id, as: assists, cause, x: q2(v.x), z: q2(v.z) });
    if (!wasHooked) this.emit({ e: 'corpse', v: v.id, x: q2(v.x), z: q2(v.z) });
    const scorer = otherTeam(v.team);
    this.score[scorer]++;
  }

  /** Called once per tick after every kill source ran. A same-tick tie at the target goes to overtime. */
  private checkWin(): void {
    const [s0, s1] = this.score;
    if (s0 === s1) {
      if (s0 >= this.config.killsToWin && !this.overtime) {
        this.overtime = true;
        this.announce('overtime', -1, 0);
      }
      return;
    }
    if (this.overtime || s0 >= this.config.killsToWin || s1 >= this.config.killsToWin) this.endMatch(s0 > s1 ? 0 : 1);
  }

  private respawn(u: Unit): void {
    const sp = this.spawnPoint(u.team, u.spawnIndex);
    u.x = sp.x + this.rng.range(-0.4, 0.4);
    u.z = sp.z + this.rng.range(-0.4, 0.4);
    u.vx = u.vz = 0;
    u.y = 0;
    u.hp = u.maxHp;
    u.state = UnitState.Alive;
    u.stateT = 0;
    u.spawnProt = BAL.spawnProt;
    u.cdHook = 0;
    u.cdBash = Math.min(u.cdBash, 1);
    u.cdGrapple = Math.min(u.cdGrapple, 2);
    u.face = u.team === 0 ? Math.PI / 2 : -Math.PI / 2;
    this.emit({ e: 'respawn', u: u.id, x: q2(u.x), z: q2(u.z) });
  }

  spawnPoint(team: Team, index: number): { x: number; z: number } {
    const list = this.map.spawns[team];
    return list[index % list.length];
  }

  giveGold(u: Unit, amt: number): void {
    u.gold += amt;
    u.stats.g += amt;
  }

  grantRune(u: Unit, type: RuneType): void {
    switch (type) {
      case 'haste':
        u.haste = BAL.hasteTime;
        break;
      case 'double':
        u.double = BAL.doubleTime;
        break;
      case 'ironskin':
        u.shield = BAL.ironskinShield;
        u.shieldT = BAL.ironskinTime;
        break;
      case 'ghost':
        u.ghost = BAL.ghostTime;
        break;
      case 'bendy':
        u.bendy = BAL.powerHookTime;
        break;
      case 'bouncy':
        u.bouncy = BAL.powerHookTime;
        break;
      case 'longshot':
        u.longshot = BAL.powerHookTime;
        break;
      case 'bounty':
        this.giveGold(u, BAL.goldBounty);
        for (const a of this.units) if (a.team === u.team && a.id !== u.id) this.giveGold(a, 60);
        break;
    }
    this.emit({ e: 'rune', u: u.id, t: type });
  }

  isStealthed(u: Unit): boolean {
    return u.puff > 0 || u.ghost > 0;
  }

  private breakStealth(u: Unit): void {
    u.puff = 0;
    u.ghost = 0;
  }

  /** Can `team` see unit `u` right now? */
  visibleTo(u: Unit, team: Team): boolean {
    if (u.team === team || !this.isStealthed(u) || u.state === UnitState.Dead) return true;
    const r2 = BAL.stealthRevealDist * BAL.stealthRevealDist;
    for (const o of this.units) {
      if (o.team !== team || o.state === UnitState.Dead) continue;
      if (dist2(o.x, o.z, u.x, u.z) < r2) return true;
    }
    return false;
  }

  faceToward(u: Unit, x: number, z: number): void {
    const dx = x - u.x;
    const dz = z - u.z;
    if (dx * dx + dz * dz > 0.01) u.face = Math.atan2(dx, dz);
  }

  // ------------------------------------------------------------------------------------------
  // Mines, time, end
  // ------------------------------------------------------------------------------------------

  private updateMines(dt: number): void {
    for (const m of this.mines) {
      if (m.dead) continue;
      if (m.armT > 0) {
        m.armT -= dt;
        if (m.armT <= 0) this.emit({ e: 'mineArm', o: m.owner, m: m.id, x: q2(m.x), z: q2(m.z) });
        continue;
      }
      let trig = false;
      for (const u of this.units) {
        if (u.team === m.team || !this.isHittable(u) || u.state === UnitState.Hooked || u.state === UnitState.Grappling) continue;
        if (dist2(u.x, u.z, m.x, m.z) < BAL.mineRadius * BAL.mineRadius) {
          trig = true;
          break;
        }
      }
      if (!trig) continue;
      m.dead = true;
      this.emit({ e: 'mineBoom', m: m.id, x: q2(m.x), z: q2(m.z) });
      const r = BAL.mineRadius * 1.35;
      for (const u of this.units) {
        if (u.team === m.team || !this.isHittable(u)) continue;
        const d = dist(u.x, u.z, m.x, m.z);
        if (d > r) continue;
        this.damage(u, BAL.mineDamage, m.owner, 'mine');
        if (u.state !== UnitState.Dead) this.knock(u, u.x - m.x || 0.01, u.z - m.z, BAL.mineKnock, 0.4, 1.4);
      }
    }
    this.mines = this.mines.filter((m) => !m.dead);
  }

  private checkTime(): void {
    const left = this.config.timeLimitSec - this.matchTime;
    if (left > 0 || this.overtime) return;
    if (this.score[0] !== this.score[1]) this.endMatch(this.score[0] > this.score[1] ? 0 : 1);
    else {
      this.overtime = true;
      this.announce('overtime', -1, 0);
    }
  }

  private endMatch(winner: Team | -1): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.winner = winner;
    for (const h of this.hooks) if (!h.dead) this.breakHook(h);
    for (const u of this.units) this.interruptCastOnly(u);
    this.emit({ e: 'phase', ph: 'ended' });
    this.emit({ e: 'end', winner });
  }

  announce(key: AnnounceKey, u: number, n: number): void {
    this.emit({ e: 'announce', key, u, n });
  }

  emit(ev: GameEvent): void {
    this.events.push(ev);
  }

  // ------------------------------------------------------------------------------------------
  // Snapshots
  // ------------------------------------------------------------------------------------------

  timeLeft(): number {
    return Math.max(0, this.config.timeLimitSec - this.matchTime);
  }

  snapshotFor(viewerId: number, withScoreboard = this.tick % SCOREBOARD_EVERY === 0): Snapshot {
    const viewer = this.unitById.get(viewerId);
    const team: Team = viewer ? viewer.team : 0;
    const spectator = !viewer;
    const units: UnitSnap[] = [];
    for (const u of this.units) {
      // a spectator sees a unit only when both teams can (a second tab must not be a wallhack)
      if (!this.visibleTo(u, spectator ? otherTeam(u.team) : team)) continue;
      units.push(this.unitSnap(u));
    }
    const hooks: HookSnap[] = this.hooks.map((h) => ({
      i: h.id, o: h.owner, k: h.kind, p: h.phase, x: q2(h.x), z: q2(h.z), r: h.r, pts: h.pts.slice(), tg: h.tg, ru: h.ru,
      fx: (h.ember ? 1 : 0) | (h.ricochet ? 2 : 0) | (h.steer ? 4 : 0) | (h.longshot ? 8 : 0),
    }));
    const runes: RuneSnap[] = this.runes.map((r) => ({ i: r.id, t: r.type, x: q2(r.x), z: q2(r.z), d: r.dragged ? 1 : 0 }));
    const mines: MineSnap[] = this.mines
      .filter((m) => !spectator && m.team === team)
      .map((m) => ({ i: m.id, o: m.owner, x: q2(m.x), z: q2(m.z), a: m.armT <= 0 ? 1 : 0 }));
    const ev = spectator ? this.events.filter((e) => this.eventVisible(e, 0) && this.eventVisible(e, 1)) : this.events.filter((e) => this.eventVisible(e, team));
    const snap: Snapshot = {
      t: this.tick,
      ph: this.phase,
      cd: q2(this.countdown),
      tl: q2(this.timeLeft()),
      ot: this.overtime ? 1 : 0,
      s: [this.score[0], this.score[1]],
      mc: q2(this.moverClock),
      mt: Math.round(this.matchTime * 1000) / 1000,
      u: units,
      h: hooks,
      r: runes,
      m: mines,
      w: { ...this.river, level: Math.round(this.river.level * 1000) / 1000, phaseLeft: q2(this.river.phaseLeft) },
      ev,
    };
    if (viewer) snap.you = this.youSnap(viewer);
    if (withScoreboard) snap.sb = this.scoreboard();
    return snap;
  }

  private hiddenFrom(id: number, team: Team): boolean {
    const u = this.unitById.get(id);
    return !!u && !this.visibleTo(u, team);
  }

  /** Never tell a team where a stealthed enemy is, or about enemy mines and purchases. */
  private eventVisible(e: GameEvent, team: Team): boolean {
    if (e.e === 'mineArm') return this.unitById.get(e.o)?.team === team;
    if (e.e === 'buy') return this.unitById.get(e.u)?.team === team;
    if (e.e === 'useItem') {
      const u = this.unitById.get(e.u);
      if (!u || u.team === team) return true;
      if (e.item === 'mine') return false;
      return e.item === 'puffball' || this.visibleTo(u, team);
    }
    if (e.e === 'drownStart' || e.e === 'drownSave' || e.e === 'splash') return !this.hiddenFrom(e.u, team);
    if (e.e === 'heal') return !this.hiddenFrom(e.tg, team);
    if (e.e === 'dmg') return !this.hiddenFrom(e.tg, team) || this.unitById.get(e.src)?.team === team;
    return true;
  }

  private unitSnap(u: Unit): UnitSnap {
    let fl = 0;
    if (u.spawnProt > 0) fl |= UFlag.SpawnProt;
    if (this.isStealthed(u)) fl |= UFlag.Stealth;
    if (u.shield > 0) fl |= UFlag.Shield;
    if (u.burnT > 0) fl |= UFlag.Burning;
    if (u.haste > 0) fl |= UFlag.Haste;
    if (u.double > 0) fl |= UFlag.DoubleDmg;
    if (u.surface === 'ice') fl |= UFlag.OnIce;
    if (u.surface === 'shallow') fl |= UFlag.Shallow;
    if (u.pieT > 0) fl |= UFlag.Healing;
    if (u.inHazard) fl |= UFlag.InHazard;
    if (u.state === UnitState.Drowning) fl |= UFlag.Swimming;
    if (u.bendy > 0) fl |= UFlag.Bendy;
    if (u.bouncy > 0) fl |= UFlag.Bouncy;
    if (u.longshot > 0) fl |= UFlag.Longshot;
    const s: UnitSnap = { i: u.id, x: q2(u.x), z: q2(u.z), y: q2(u.y), f: q2(u.face), hp: Math.ceil(u.hp), mhp: u.maxHp, st: u.state, fl };
    if (u.castKind) s.ck = u.castKind;
    else if (u.meleeT > 0) s.ck = 'melee';
    if (u.state === UnitState.Dead) s.rt = q2(Math.max(0, u.respawnT));
    return s;
  }

  private youSnap(u: Unit): YouSnap {
    const fam = FAMILY_DEFS[u.family];
    const buffs: BuffSnap[] = [];
    if (u.haste > 0) buffs.push({ t: 'haste', left: q2(u.haste) });
    if (u.double > 0) buffs.push({ t: 'double', left: q2(u.double) });
    if (u.shield > 0) buffs.push({ t: 'ironskin', left: q2(u.shieldT) });
    if (u.ghost > 0) buffs.push({ t: 'ghost', left: q2(u.ghost) });
    if (u.puff > 0) buffs.push({ t: 'puffball', left: q2(u.puff) });
    if (u.pieT > 0) buffs.push({ t: 'pie', left: q2(u.pieT) });
    if (u.burnT > 0) buffs.push({ t: 'burn', left: q2(u.burnT) });
    if (u.spawnProt > 0) buffs.push({ t: 'spawn', left: q2(u.spawnProt) });
    if (u.bendy > 0) buffs.push({ t: 'bendy', left: q2(u.bendy) });
    if (u.bouncy > 0) buffs.push({ t: 'bouncy', left: q2(u.bouncy) });
    if (u.longshot > 0) buffs.push({ t: 'longshot', left: q2(u.longshot) });
    return {
      id: u.id,
      ack: u.ack,
      gold: Math.floor(u.gold),
      cd: [q2(u.cdHook), q2(u.cdGrapple), q2(u.cdBash)],
      cdMax: [q2(BAL.hookCooldown * fam.hookCdMul), BAL.grappleCooldown, BAL.bashCooldown],
      items: u.items.map((s) => (s ? { id: s.id, charges: s.charges } : null)),
      up: { ...u.up },
      buffs,
      drown: u.state === UnitState.Drowning ? q2(Math.max(0, BAL.drownTime - u.drownT)) : 0,
      hookRange: HOOK_LEVELS.range[u.up.range] * (u.longshot > 0 ? BAL.longshotRangeMul : 1),
      mm: q3m(this.moveMultiplier(u)),
      vx: q2(u.vx),
      vz: q2(u.vz),
    };
  }

  scoreboard(): ScoreRow[] {
    return this.units.map((u) => ({ i: u.id, ...u.stats, dmg: Math.round(u.stats.dmg), g: Math.round(u.stats.g) }));
  }
}

function q3m(v: number): number {
  return Math.round(v * 1000) / 1000;
}
