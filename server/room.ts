// A room: lobby (teams, settings, ready-up) and, once started, one authoritative match.
//
// Unit ids and connection ids: a fresh player's unit id is its connection id, but the two can part
// ways. A player whose socket drops gets a single-use rejoin token (sent in MatchStart); a new
// connection that presents it within REJOIN_GRACE_MS takes the old unit back (gold, upgrades, items,
// K/D), while a bot drives it in between. Every per-player call (input, buy, sell, upgrade, snapshot)
// is routed through Member.unit, never through the connection id.
//
// Snapshot flow control: once a client acks snapshot ticks (input.a, or 'ack' for spectators), the
// stream to it is paced by those acks. More than LAG_TICKS (plus its base round trip) unacked and it
// gets no new frames, only a probe once a second, until its acks catch up; then it resumes with the
// latest full snapshot. Events from skipped frames ride along with the next one.
//
// Spectators watch SPECTATOR_DELAY_TICKS (3 s) behind live, under the spectator visibility rules.
import { randomBytes, randomInt } from 'node:crypto';
import { BOT_NAMES, MAX_TEAM_SIZE, TICK_DT } from '../shared/constants.ts';
import {
  REJOIN_GRACE_MS, SPECTATOR_DELAY_TICKS,
  type LobbySlot, type MatchEnd, type MatchStart, type Profile, type RoomState, type RoomSummary, type ServerMsg,
} from '../shared/protocol.ts';
import { GameSim } from '../shared/sim/sim.ts';
import { warmBots } from '../shared/sim/bots.ts';
import { randomBotLoadout } from '../shared/cosmetics.ts';
import type { MatchResult } from './economy/api.ts';
import {
  FAMILIES, UnitState,
  type GameEvent, type ItemId, type MatchConfig, type PlayerInfo, type PlayerInput, type ScoreRow, type Snapshot, type Team, type UpgradeStat,
} from '../shared/types.ts';

export interface RoomClient {
  id: number;
  profile: Profile;
  ping: number;
  send(msg: ServerMsg): void;
  /** Pre-serialised send for snapshots (skipped when the socket is backed up). */
  sendRaw(data: string, droppable: boolean): void;
}

const RETURN_TO_LOBBY_SEC = 14;
const BOT_ID_BASE = 1_000_000;
/** Unit ids for players whose connection id is already taken by a unit (ids wrap after a million). */
const ALT_UNIT_ID_BASE = 2_000_000;
const TICK_MS = TICK_DT * 1000;

/** Unacked snapshot ticks a client may have in flight on top of its base round trip (8 ticks = 267 ms). */
export const LAG_TICKS = 8;
/** A paused stream resumes once the client has acked all but this many of the frames sent. */
const RESUME_INFLIGHT = 2;
/** While paused, one probe frame this often, so a stream can never stall for good. */
const PROBE_EVERY_TICKS = 30;
/** Events from skipped frames older than this are dropped rather than replayed late. */
const EVENT_KEEP_TICKS = 60;
const EVENT_KEEP_MAX = 96;
const RTT_RING = 64;
const RTT_WINDOW_MS = 10_000;

/** Ack-based pacing of one member's snapshot stream. */
interface Flow {
  /** the client has acked at least once: from then on its stream is paced by acks */
  acked: boolean;
  ack: number;
  lastSent: number;
  firstSent: number;
  paused: boolean;
  probeAt: number;
  /** next frame carries the scoreboard (first frame after a pause or probe) */
  resume: boolean;
  sentTick: Int32Array;
  sentAt: Float64Array;
  rttCur: number;
  rttPrev: number;
  rttWinAt: number;
  backlog: { t: number; ev: GameEvent[] }[];
  skipped: number;
  pauses: number;
}

function newFlow(): Flow {
  return {
    acked: false, ack: -1, lastSent: -1, firstSent: -1, paused: false, probeAt: 0, resume: false,
    sentTick: new Int32Array(RTT_RING).fill(-1), sentAt: new Float64Array(RTT_RING),
    rttCur: Infinity, rttPrev: Infinity, rttWinAt: 0, backlog: [], skipped: 0, pauses: 0,
  };
}

interface Member {
  client: RoomClient;
  team: Team | -1;
  ready: boolean;
  /** unit this member drives in the running match, -1 = none (spectating or in the lobby) */
  unit: number;
  flow: Flow;
  /** sim tick of the member's last input (diagnostics) */
  lastInput: number;
  /** got a 'start' for the running match */
  started: boolean;
  /** spectators: got the delayed 'end' */
  endSent: boolean;
}

/** A human-owned unit in the running match, with its rejoin token. */
interface Seat {
  unit: number;
  /** connection id driving it, -1 while a bot covers for a dropped owner */
  owner: number;
  /** last connection that drove it (the same socket may take it back without a token) */
  lastOwner: number;
  token: string;
  /** Date.now() when the owner left, 0 while owned */
  leftAt: number;
  /**
   * The owner's gold while a stand-in bot drives: bots shop on their own, and the player should come
   * back to the gold they left, not to upgrades a bot picked. The bot can spend only what it earns.
   */
  escrow: number;
}

interface SpecFrame {
  snap: Snapshot;
  json: string | null;
}

/** Diagnostics for tests and logs. */
export interface FlowInfo {
  acked: boolean;
  ack: number;
  lastSent: number;
  paused: boolean;
  skipped: number;
  pauses: number;
  minRtt: number;
  limit: number;
}

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export class Room {
  readonly code: string;
  name: string;
  readonly isPrivate: boolean;
  config: MatchConfig;
  hostId: number;
  phase: 'lobby' | 'match' = 'lobby';
  readonly members = new Map<number, Member>();
  sim: GameSim | null = null;
  private players: PlayerInfo[] = [];
  private botCounter = 0;
  private altCounter = 0;
  private endTimer = 0;
  private ended = false;
  lastActivity = Date.now();
  private onEmpty: (room: Room) => void;
  /** set when the lobby state changed; flushed once per tick so spam cannot multiply the fan-out */
  private dirty = false;
  /** economy hook: rewards and stats for the humans still in the room when a match ends */
  onMatchEnd: ((results: MatchResult[]) => void) | null = null;
  /** a member was pushed out because a new connection reclaimed its unit with the rejoin token (a half-open old socket) */
  onEvict: ((clientId: number) => void) | null = null;
  private readonly seats = new Map<number, Seat>();
  private readonly tokens = new Map<string, number>();
  /** spectator frames, oldest first; spectators get the one SPECTATOR_DELAY_TICKS behind live */
  private specRing: SpecFrame[] = [];
  private specSb: ScoreRow[] | null = null;
  private endMsg: MatchEnd | null = null;
  private endTick = -1;
  private sweepAt = 0;

  constructor(code: string, name: string, isPrivate: boolean, config: MatchConfig, host: RoomClient, onEmpty: (room: Room) => void) {
    this.code = code;
    this.name = name;
    this.isPrivate = isPrivate;
    this.config = config;
    this.hostId = host.id;
    this.onEmpty = onEmpty;
  }

  get humans(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.team !== -1 || this.phase === 'lobby') n++;
    return n;
  }

  summary(): RoomSummary {
    return {
      code: this.code,
      name: this.name,
      mapId: this.config.mapId,
      riverMode: this.config.riverMode,
      humans: this.members.size,
      slots: this.config.teamSize * 2,
      phase: this.phase,
    };
  }

  isFull(): boolean {
    // players beyond the team slots join as spectators, so allow a few extra
    return this.members.size >= this.config.teamSize * 2 + 4;
  }

  // ------------------------------------------------------------------------------------------
  // Membership
  // ------------------------------------------------------------------------------------------

  join(c: RoomClient, rejoin?: string): void {
    this.lastActivity = Date.now();
    const team = this.pickTeam();
    const m: Member = { client: c, team, ready: false, unit: -1, flow: newFlow(), lastInput: 0, started: false, endSent: false };
    this.members.set(c.id, m);
    // during the 14 s end screen there is nothing to join: wait in the lobby for the next match
    if (this.phase === 'match' && this.sim && this.sim.phase !== 'ended') this.joinMidMatch(m, rejoin);
    this.dirty = true;
  }

  leave(clientId: number): void {
    const m = this.members.get(clientId);
    if (!m) return;
    this.members.delete(clientId);
    this.lastActivity = Date.now();
    const sim = this.sim;
    if (sim && m.unit >= 0 && sim.unitById.has(m.unit)) {
      const seat = this.seats.get(m.unit);
      if (seat && seat.owner === clientId) {
        seat.owner = -1;
        seat.lastOwner = clientId;
        seat.leftAt = Date.now();
      }
      // A bot covers for the owner, even without bot fill, so the unit (and its progress) is still
      // there to reclaim. Without bot fill it is removed once the grace window runs out.
      sim.setController(m.unit, true, this.botName());
      if (seat && seat.owner < 0) {
        const u = sim.unitById.get(m.unit)!;
        seat.escrow += u.gold;
        u.gold = 0;
      }
      const p = this.players.find((x) => x.id === m.unit);
      if (p) {
        p.isBot = true;
        p.botDifficulty = this.config.botDifficulty;
        p.name = sim.unitById.get(m.unit)!.name;
      }
      this.broadcast({ t: 'players', players: this.players });
    }
    if (this.hostId === clientId) {
      const next = this.members.keys().next();
      if (!next.done) this.hostId = next.value;
    }
    if (this.members.size === 0) {
      this.onEmpty(this);
      return;
    }
    this.dirty = true;
  }

  /** Would this token reclaim a unit right now? (A valid token gets in even when the room is full.) */
  canRejoin(token: string): boolean {
    return this.seatForToken(token) !== null;
  }

  private seatForToken(token: string): Seat | null {
    const sim = this.sim;
    if (!sim || this.phase !== 'match' || sim.phase === 'ended') return null;
    const unit = this.tokens.get(token);
    if (unit === undefined) return null;
    const seat = this.seats.get(unit);
    if (!seat || seat.token !== token || !sim.unitById.has(unit)) return null;
    if (seat.owner < 0) return Date.now() - seat.leftAt <= REJOIN_GRACE_MS ? seat : null;
    // Still owned: after a real network drop the old socket stays half-open here for 10 to 20 s,
    // while the player is already back on a new one. The token is unguessable, single use and
    // only ever sent to the owner, so it is proof enough: the old connection is evicted.
    return seat;
  }

  /** Same socket coming back after Leave: its own unit, without a token. */
  private seatForReturn(clientId: number): Seat | null {
    for (const seat of this.seats.values()) {
      if (seat.owner < 0 && seat.lastOwner === clientId && this.sim!.unitById.has(seat.unit)) return seat;
    }
    return null;
  }

  private inGrace(unit: number): boolean {
    const seat = this.seats.get(unit);
    return !!seat && seat.owner < 0 && Date.now() - seat.leftAt <= REJOIN_GRACE_MS;
  }

  private pickTeam(): Team | -1 {
    const counts = [0, 0];
    for (const m of this.members.values()) if (m.team !== -1) counts[m.team]++;
    if (this.phase === 'match' && this.sim) {
      // count humans in the running match (a unit waiting for its dropped owner counts as taken)
      const human = (p: PlayerInfo) => !p.isBot || this.inGrace(p.id);
      counts[0] = this.players.filter((p) => p.team === 0 && human(p)).length;
      counts[1] = this.players.filter((p) => p.team === 1 && human(p)).length;
    }
    const t: Team = counts[0] <= counts[1] ? 0 : 1;
    if (counts[t] >= this.config.teamSize) return -1;
    return t;
  }

  private joinMidMatch(m: Member, rejoin: string | undefined): void {
    const sim = this.sim!;
    const c = m.client;
    // Coming back to a unit we left (a bot has been driving it): take it back with its progress.
    const seat = (rejoin ? this.seatForToken(rejoin) : null) ?? this.seatForReturn(c.id);
    if (seat) {
      this.reclaim(m, seat);
      return;
    }
    if (m.team !== -1) {
      // take over a bot on that team if there is one, else add a fresh unit if a slot is free
      const safe = (id: number) => {
        const u = sim.unitById.get(id);
        return !!u && (u.state === UnitState.Alive || u.state === UnitState.Casting) && u.burnT <= 0 && u.hookedBy < 0;
      };
      // never a unit whose owner may still come back for it
      const free = (p: PlayerInfo) => p.team === m.team && p.isBot && safe(p.id) && !this.inGrace(p.id);
      const bot = this.players.find((p) => free(p) && !this.seats.has(p.id)) ?? this.players.find(free);
      if (bot) {
        sim.removePlayer(bot.id);
        this.players = this.players.filter((p) => p.id !== bot.id);
        this.dropSeat(bot.id);
      }
      const onTeam = this.players.filter((p) => p.team === m.team).length;
      if (onTeam < this.config.teamSize) {
        const info = this.playerInfo(c, m.team, this.unitIdFor(c.id));
        this.players.push(info);
        sim.addPlayer(info);
        this.seat(m, info.id);
      } else m.team = -1;
      this.broadcast({ t: 'players', players: this.players });
    }
    this.sendStart(m);
  }

  /** Hand a seat's unit to this member (rejoin): new token, human control, same progress. */
  private reclaim(m: Member, seat: Seat): void {
    const sim = this.sim!;
    const prev = seat.owner;
    if (prev >= 0 && prev !== m.client.id) this.evict(prev);
    this.tokens.delete(seat.token);
    seat.token = newToken();
    this.tokens.set(seat.token, seat.unit);
    seat.owner = m.client.id;
    seat.lastOwner = m.client.id;
    seat.leftAt = 0;
    const u = sim.unitById.get(seat.unit)!;
    u.gold += seat.escrow;
    seat.escrow = 0;
    m.unit = seat.unit;
    m.team = u.team;
    sim.setController(seat.unit, false, m.client.profile.name);
    sim.resetInput(seat.unit); // the new client numbers its inputs from 1
    const p = this.players.find((x) => x.id === seat.unit);
    if (p) {
      p.isBot = false;
      p.name = m.client.profile.name;
      delete p.botDifficulty;
    }
    this.broadcast({ t: 'players', players: this.players });
    this.sendStart(m);
  }

  /** The old connection of a unit reclaimed with its token (usually a dead socket): drop it from the room. */
  private evict(clientId: number): void {
    const m = this.members.get(clientId);
    if (!m) return;
    this.members.delete(clientId);
    if (this.hostId === clientId) {
      const next = this.members.keys().next();
      if (!next.done) this.hostId = next.value;
    }
    this.onEvict?.(clientId);
    this.dirty = true;
  }

  private seat(m: Member, unit: number): void {
    m.unit = unit;
    const token = newToken();
    this.seats.set(unit, { unit, owner: m.client.id, lastOwner: m.client.id, token, leftAt: 0, escrow: 0 });
    this.tokens.set(token, unit);
  }

  private dropSeat(unit: number): void {
    const seat = this.seats.get(unit);
    if (!seat) return;
    this.tokens.delete(seat.token);
    this.seats.delete(unit);
  }

  /** The connection id, unless a unit (or a seat waiting for its owner) already uses it. */
  private unitIdFor(clientId: number): number {
    const sim = this.sim;
    const taken = (id: number) => !!sim?.unitById.has(id) || this.seats.has(id) || this.players.some((p) => p.id === id);
    if (!taken(clientId)) return clientId;
    let id = ALT_UNIT_ID_BASE + ++this.altCounter;
    while (taken(id)) id = ALT_UNIT_ID_BASE + ++this.altCounter;
    return id;
  }

  /** Grace windows that ran out: the token stops working; without bot fill the stand-in bot goes too. */
  private sweepSeats(): void {
    const sim = this.sim;
    if (!sim) return;
    const now = Date.now();
    let changed = false;
    for (const seat of [...this.seats.values()]) {
      if (seat.owner >= 0 || now - seat.leftAt <= REJOIN_GRACE_MS) continue;
      this.tokens.delete(seat.token);
      const u = sim.unitById.get(seat.unit);
      if (u && seat.escrow > 0) u.gold += seat.escrow; // nobody is coming back: the bot gets the purse
      seat.escrow = 0;
      if (!this.config.botFill && sim.phase !== 'ended') {
        sim.removePlayer(seat.unit);
        this.players = this.players.filter((p) => p.id !== seat.unit);
        this.seats.delete(seat.unit);
        changed = true;
      }
    }
    if (changed) this.broadcast({ t: 'players', players: this.players });
  }

  setProfile(clientId: number, profile: Profile): void {
    const m = this.members.get(clientId);
    if (!m) return;
    m.client.profile = profile;
    if (this.phase === 'lobby') this.dirty = true;
  }

  setTeam(clientId: number, team: Team | -1): void {
    const m = this.members.get(clientId);
    if (!m || this.phase !== 'lobby' || m.team === team) return;
    if (team !== -1) {
      let n = 0;
      for (const x of this.members.values()) if (x.team === team && x !== m) n++;
      if (n >= this.config.teamSize) return;
    }
    m.team = team;
    m.ready = false;
    this.lastActivity = Date.now();
    this.dirty = true;
  }

  setConfig(clientId: number, config: MatchConfig): void {
    if (clientId !== this.hostId || this.phase !== 'lobby') return;
    this.config = config;
    // push anyone over the new team size to spectators
    for (const t of [0, 1] as const) {
      const onTeam = [...this.members.values()].filter((m) => m.team === t);
      for (let i = config.teamSize; i < onTeam.length; i++) onTeam[i].team = -1;
    }
    for (const m of this.members.values()) m.ready = false;
    this.lastActivity = Date.now();
    this.dirty = true;
  }

  setReady(clientId: number, ready: boolean): void {
    const m = this.members.get(clientId);
    if (!m || this.phase !== 'lobby' || m.ready === ready) return;
    m.ready = ready;
    this.lastActivity = Date.now();
    this.dirty = true;
  }

  // ------------------------------------------------------------------------------------------
  // Match
  // ------------------------------------------------------------------------------------------

  start(clientId: number): ServerMsg | null {
    if (clientId !== this.hostId) return { t: 'error', code: 'not_host', message: 'Only the host can start the match.' };
    if (this.phase !== 'lobby') return null;
    const humansOnTeams = [...this.members.values()].filter((m) => m.team !== -1);
    if (humansOnTeams.length === 0) return { t: 'error', code: 'no_players', message: 'Join a team first.' };
    if (!this.config.botFill && !(humansOnTeams.some((m) => m.team === 0) && humansOnTeams.some((m) => m.team === 1))) {
      return { t: 'error', code: 'need_opponent', message: 'Both teams need a player, or turn on bot fill.' };
    }
    this.resetMatchState();
    this.players = [];
    for (const m of humansOnTeams) this.players.push(this.playerInfo(m.client, m.team as Team, m.client.id));
    if (this.config.botFill) {
      for (const team of [0, 1] as const) {
        let n = this.players.filter((p) => p.team === team).length;
        while (n < this.config.teamSize) {
          this.players.push(this.botInfo(team));
          n++;
        }
      }
    }
    const seed = randomInt(1, 2 ** 31 - 1);
    this.sim = new GameSim(this.config, this.players, seed);
    warmBots(this.sim.map);
    this.phase = 'match';
    this.ended = false;
    this.endTimer = 0;
    for (const m of humansOnTeams) this.seat(m, m.client.id);
    for (const m of this.members.values()) this.sendStart(m);
    this.dirty = true;
    return null;
  }

  private resetMatchState(): void {
    this.seats.clear();
    this.tokens.clear();
    this.specRing = [];
    this.specSb = null;
    this.endMsg = null;
    this.endTick = -1;
    for (const m of this.members.values()) {
      m.unit = -1;
      m.started = false;
      m.endSent = false;
      m.flow = newFlow();
    }
  }

  private unitOf(m: Member): number {
    return m.unit >= 0 && this.sim?.unitById.has(m.unit) ? m.unit : -1;
  }

  private matchStart(m: Member): MatchStart {
    const sim = this.sim!;
    const you = this.unitOf(m);
    const ms: MatchStart = {
      config: this.config,
      seed: sim.seed,
      players: this.players,
      hazards: sim.hazards,
      you,
      tick: you >= 0 ? sim.tick : Math.max(0, sim.tick - SPECTATOR_DELAY_TICKS),
      room: this.code,
    };
    const seat = you >= 0 ? this.seats.get(you) : undefined;
    if (seat && seat.owner === m.client.id) ms.rejoin = seat.token;
    if (you < 0) ms.delay = SPECTATOR_DELAY_TICKS;
    return ms;
  }

  private sendStart(m: Member): void {
    m.started = true;
    m.endSent = false;
    m.flow = newFlow(); // the client starts a new session: its acks count from here
    m.lastInput = this.sim?.tick ?? 0;
    m.client.send({ t: 'start', m: this.matchStart(m) });
  }

  private playerInfo(c: RoomClient, team: Team, id: number): PlayerInfo {
    return { id, name: c.profile.name, team, family: c.profile.family, loadout: c.profile.loadout, isBot: false };
  }

  private botName(): string {
    const used = new Set(this.players.map((p) => p.name));
    for (let i = 0; i < BOT_NAMES.length; i++) {
      const n = BOT_NAMES[(this.botCounter + i) % BOT_NAMES.length];
      if (!used.has(n)) {
        this.botCounter += i + 1;
        return n;
      }
    }
    return `Bot ${++this.botCounter}`;
  }

  private botInfo(team: Team): PlayerInfo {
    const id = BOT_ID_BASE + ++this.botCounter;
    const family = FAMILIES[randomInt(0, FAMILIES.length)];
    return {
      id,
      name: this.botName(),
      team,
      family,
      loadout: randomBotLoadout(family, () => randomInt(0, 1_000_000) / 1_000_000),
      isBot: true,
      botDifficulty: this.config.botDifficulty,
    };
  }

  /** The unit this connection drives, or -1. */
  unitFor(clientId: number): number {
    const m = this.members.get(clientId);
    return m ? this.unitOf(m) : -1;
  }

  input(clientId: number, i: PlayerInput, ack?: number): void {
    const m = this.members.get(clientId);
    if (!m) return;
    if (ack !== undefined) this.takeAck(m.flow, ack);
    if (!this.sim || this.phase !== 'match') return;
    const unit = this.unitOf(m);
    if (unit < 0) return;
    this.sim.queueInput(unit, i);
    m.lastInput = this.sim.tick;
  }

  /** Snapshot ack without an input (spectators). */
  ack(clientId: number, tick: number): void {
    const m = this.members.get(clientId);
    if (m) this.takeAck(m.flow, tick);
  }

  buy(clientId: number, item: ItemId): void {
    const unit = this.unitFor(clientId);
    if (unit >= 0) this.sim?.buy(unit, item);
  }

  sell(clientId: number, slot: number): void {
    const unit = this.unitFor(clientId);
    if (unit >= 0) this.sim?.sell(unit, slot);
  }

  upgrade(clientId: number, stat: UpgradeStat): void {
    const unit = this.unitFor(clientId);
    if (unit >= 0) this.sim?.upgrade(unit, stat);
  }

  /** The current rejoin token of this connection's unit (tests and tools). */
  rejoinToken(clientId: number): string | null {
    const unit = this.unitFor(clientId);
    const seat = unit >= 0 ? this.seats.get(unit) : undefined;
    return seat && seat.owner === clientId ? seat.token : null;
  }

  flowInfo(clientId: number): FlowInfo | null {
    const m = this.members.get(clientId);
    if (!m) return null;
    const f = m.flow;
    return { acked: f.acked, ack: f.ack, lastSent: f.lastSent, paused: f.paused, skipped: f.skipped, pauses: f.pauses, minRtt: this.minRtt(f), limit: this.lagLimit(f) };
  }

  /** Advance one tick and send each member its own view. */
  tick(): void {
    if (this.dirty) {
      this.dirty = false;
      this.broadcastState();
    }
    const sim = this.sim;
    if (!sim || this.phase !== 'match') return;
    sim.step();
    const now = performance.now();
    const spec = this.pushSpectatorFrame(sim);
    for (const m of this.members.values()) {
      const unit = this.unitOf(m);
      if (unit >= 0) this.streamPlayer(m, sim, unit, now);
      else if (spec) this.streamSpectator(m, spec, now);
    }
    if (sim.tick % 30 === 0 && Date.now() >= this.sweepAt) {
      this.sweepAt = Date.now() + 1000;
      this.sweepSeats();
    }
    if (sim.phase === 'ended') {
      if (!this.ended) {
        this.ended = true;
        const e: MatchEnd = { winner: sim.winner, score: [sim.score[0], sim.score[1]], rows: sim.scoreboard(), players: this.players };
        this.endMsg = e;
        this.endTick = sim.tick;
        // players now; spectators when their delayed feed reaches the final tick
        const data = JSON.stringify({ t: 'end', e } satisfies ServerMsg);
        for (const m of this.members.values()) {
          if (this.unitOf(m) >= 0) {
            m.endSent = true;
            m.client.sendRaw(data, false);
          }
        }
        if (this.onMatchEnd) {
          const results: MatchResult[] = [];
          for (const p of this.players) {
            if (p.isBot) continue;
            const owner = this.seats.get(p.id)?.owner ?? -1; // the connection driving the unit now
            if (owner < 0 || !this.members.has(owner)) continue;
            const row = e.rows.find((r) => r.i === p.id);
            if (row) results.push({ connId: owner, won: e.winner === p.team, row });
          }
          this.onMatchEnd(results);
        }
      }
      if (this.endMsg && sim.tick >= this.endTick + SPECTATOR_DELAY_TICKS) {
        let data: string | null = null;
        for (const m of this.members.values()) {
          if (m.endSent || !m.started) continue;
          m.endSent = true;
          data ??= JSON.stringify({ t: 'end', e: this.endMsg } satisfies ServerMsg);
          m.client.sendRaw(data, false);
        }
      }
      this.endTimer += TICK_DT;
      if (this.endTimer >= RETURN_TO_LOBBY_SEC) this.backToLobby();
    }
  }

  private backToLobby(): void {
    this.sim = null;
    this.phase = 'lobby';
    this.players = [];
    this.resetMatchState();
    for (const m of this.members.values()) m.ready = false;
    this.lastActivity = Date.now(); // a fresh idle window after every match
    this.dirty = true;
  }

  // ------------------------------------------------------------------------------------------
  // Snapshot streaming and flow control
  // ------------------------------------------------------------------------------------------

  /** Record this tick's spectator view; returns the one spectators should see now (3 s old), if any. */
  private pushSpectatorFrame(sim: GameSim): SpecFrame | null {
    const ring = this.specRing;
    ring.push({ snap: sim.snapshotFor(-1), json: null });
    if (ring.length <= SPECTATOR_DELAY_TICKS) return null;
    while (ring.length > SPECTATOR_DELAY_TICKS + 1) ring.shift();
    const f = ring[0];
    if (f.snap.sb) this.specSb = f.snap.sb;
    return f;
  }

  private streamPlayer(m: Member, sim: GameSim, unit: number, now: number): void {
    const f = m.flow;
    if (!this.mayStream(f, sim.tick)) {
      if (sim.events.length) this.stash(f, sim.tick, sim.snapshotFor(unit, false).ev);
      return;
    }
    const s = sim.snapshotFor(unit, f.resume ? true : undefined);
    f.resume = false;
    if (f.backlog.length) s.ev = this.takeBacklog(f, sim.tick, s.ev);
    this.record(f, s.t, now);
    m.client.sendRaw(JSON.stringify({ t: 's', s } satisfies ServerMsg), true);
  }

  private streamSpectator(m: Member, frame: SpecFrame, now: number): void {
    if (!m.started) return; // no session on the client to take it yet
    const f = m.flow;
    const t = frame.snap.t;
    if (!this.mayStream(f, t)) {
      if (frame.snap.ev.length) this.stash(f, t, frame.snap.ev);
      return;
    }
    this.record(f, t, now);
    if (f.backlog.length || (f.resume && !frame.snap.sb && this.specSb)) {
      const s: Snapshot = { ...frame.snap, ev: this.takeBacklog(f, t, frame.snap.ev) };
      if (f.resume && !s.sb && this.specSb) s.sb = this.specSb;
      f.resume = false;
      m.client.sendRaw(JSON.stringify({ t: 's', s } satisfies ServerMsg), true);
      return;
    }
    f.resume = false;
    frame.json ??= JSON.stringify({ t: 's', s: frame.snap } satisfies ServerMsg);
    m.client.sendRaw(frame.json, true);
  }

  private minRtt(f: Flow): number {
    const r = Math.min(f.rttCur, f.rttPrev);
    return Number.isFinite(r) ? r : 0;
  }

  /** Frames allowed in flight: LAG_TICKS of queueing on top of the client's base round trip. */
  private lagLimit(f: Flow): number {
    return LAG_TICKS + Math.min(30, Math.ceil(this.minRtt(f) / TICK_MS));
  }

  /** Pace the stream by acks: pause when too far behind, probe while paused, resume when caught up. */
  private mayStream(f: Flow, tick: number): boolean {
    if (!f.acked) return true; // a client that never acks (tools, old builds) only has the byte guard
    const inflight = f.lastSent - f.ack;
    if (f.paused) {
      if (inflight <= RESUME_INFLIGHT) {
        f.paused = false;
        f.resume = true;
        return true;
      }
      if (tick - f.probeAt >= PROBE_EVERY_TICKS) {
        f.probeAt = tick; // stay paused; its ack (if it is alive) resumes the stream
        f.resume = true;
        return true;
      }
      f.skipped++;
      return false;
    }
    if (inflight > this.lagLimit(f)) {
      f.paused = true;
      f.probeAt = tick;
      f.pauses++;
      f.skipped++;
      return false;
    }
    return true;
  }

  private record(f: Flow, t: number, now: number): void {
    if (f.firstSent < 0) f.firstSent = t;
    f.lastSent = t;
    const k = t & (RTT_RING - 1);
    f.sentTick[k] = t;
    f.sentAt[k] = now;
  }

  private takeAck(f: Flow, tick: number): void {
    if (f.firstSent < 0 || tick < f.firstSent) return; // an ack from the client's previous session
    const a = Math.min(tick, f.lastSent);
    f.acked = true;
    if (a <= f.ack) return;
    f.ack = a;
    const k = a & (RTT_RING - 1);
    if (f.sentTick[k] !== a) return;
    const now = performance.now();
    const rtt = now - f.sentAt[k];
    if (now - f.rttWinAt > RTT_WINDOW_MS) {
      f.rttPrev = f.rttCur;
      f.rttCur = Infinity;
      f.rttWinAt = now;
    }
    if (rtt < f.rttCur) f.rttCur = rtt;
  }

  private stash(f: Flow, tick: number, ev: GameEvent[]): void {
    if (ev.length === 0) return;
    f.backlog.push({ t: tick, ev });
    while (f.backlog.length && f.backlog[0].t < tick - EVENT_KEEP_TICKS) f.backlog.shift();
  }

  private takeBacklog(f: Flow, tick: number, ev: GameEvent[]): GameEvent[] {
    const out: GameEvent[] = [];
    for (const b of f.backlog) if (b.t >= tick - EVENT_KEEP_TICKS) for (const e of b.ev) out.push(e);
    f.backlog = [];
    if (out.length > EVENT_KEEP_MAX) out.splice(0, out.length - EVENT_KEEP_MAX);
    for (const e of ev) out.push(e);
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Messaging
  // ------------------------------------------------------------------------------------------

  state(): RoomState {
    const players: LobbySlot[] = [];
    for (const m of this.members.values()) {
      players.push({
        id: m.client.id,
        name: m.client.profile.name,
        team: m.team,
        family: m.client.profile.family,
        loadout: m.client.profile.loadout,
        isBot: false,
        ready: m.ready,
        host: m.client.id === this.hostId,
        ping: m.client.ping,
      });
    }
    return { code: this.code, name: this.name, isPrivate: this.isPrivate, hostId: this.hostId, config: this.config, players, phase: this.phase };
  }

  broadcastState(): void {
    this.broadcast({ t: 'room', room: this.state() });
  }

  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) m.client.sendRaw(data, false);
  }

  chat(clientId: number, text: string, teamOnly: boolean): void {
    const m = this.members.get(clientId);
    if (!m) return;
    this.lastActivity = Date.now();
    const msg: ServerMsg = { t: 'chat', from: m.client.profile.name, fromId: clientId, text, team: teamOnly, teamId: m.team };
    const data = JSON.stringify(msg);
    for (const o of this.members.values()) {
      if (teamOnly && o.team !== m.team) continue;
      if (this.phase === 'match' && m.team === -1 && o.team !== -1) continue;
      o.client.sendRaw(data, false);
    }
  }
}

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function makeRoomCode(taken: (code: string) => boolean): string {
  for (let tries = 0; tries < 1000; tries++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += CODE_LETTERS[randomInt(0, CODE_LETTERS.length)];
    if (!taken(s)) return s;
  }
  throw new Error('room code space exhausted');
}

export { MAX_TEAM_SIZE };
