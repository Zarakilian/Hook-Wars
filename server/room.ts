// A room: lobby (teams, settings, ready-up) and, once started, one authoritative match.
import { randomInt } from 'node:crypto';
import { BOT_NAMES, MAX_TEAM_SIZE, TICK_DT } from '../shared/constants.ts';
import type { LobbySlot, MatchEnd, MatchStart, Profile, RoomState, RoomSummary, ServerMsg } from '../shared/protocol.ts';
import { GameSim } from '../shared/sim/sim.ts';
import { FAMILIES, type ItemId, type MatchConfig, type PlayerInfo, type PlayerInput, type Team, type UpgradeStat } from '../shared/types.ts';

export interface RoomClient {
  id: number;
  profile: Profile;
  ping: number;
  send(msg: ServerMsg): void;
  /** Pre-serialised send for snapshots (skipped when the socket is backed up). */
  sendRaw(data: string, droppable: boolean): void;
}

interface Member {
  client: RoomClient;
  team: Team | -1;
  ready: boolean;
}

const RETURN_TO_LOBBY_SEC = 14;
const BOT_ID_BASE = 1_000_000;

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
  private endTimer = 0;
  private ended = false;
  lastActivity = Date.now();
  private onEmpty: (room: Room) => void;

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

  join(c: RoomClient): void {
    this.lastActivity = Date.now();
    const team = this.pickTeam();
    this.members.set(c.id, { client: c, team, ready: false });
    if (this.phase === 'match' && this.sim) this.joinMidMatch(c, team);
    this.broadcastState();
  }

  leave(clientId: number): void {
    const m = this.members.get(clientId);
    if (!m) return;
    this.members.delete(clientId);
    this.lastActivity = Date.now();
    if (this.sim && this.sim.unitById.has(clientId)) {
      if (this.config.botFill) {
        this.sim.setController(clientId, true, this.botName());
        const p = this.players.find((x) => x.id === clientId);
        if (p) {
          p.isBot = true;
          p.botDifficulty = this.config.botDifficulty;
          p.name = this.sim.unitById.get(clientId)!.name;
        }
      } else {
        this.sim.removePlayer(clientId);
        this.players = this.players.filter((p) => p.id !== clientId);
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
    this.broadcastState();
  }

  private pickTeam(): Team | -1 {
    const counts = [0, 0];
    for (const m of this.members.values()) if (m.team !== -1) counts[m.team]++;
    if (this.phase === 'match' && this.sim) {
      // count humans in the running match
      counts[0] = this.players.filter((p) => p.team === 0 && !p.isBot).length;
      counts[1] = this.players.filter((p) => p.team === 1 && !p.isBot).length;
    }
    const t: Team = counts[0] <= counts[1] ? 0 : 1;
    if (counts[t] >= this.config.teamSize) return -1;
    return t;
  }

  private joinMidMatch(c: RoomClient, team: Team | -1): void {
    const sim = this.sim!;
    if (team !== -1) {
      // take over a bot on that team if there is one, else add a fresh unit if a slot is free
      const bot = this.players.find((p) => p.team === team && p.isBot);
      if (bot) {
        sim.removePlayer(bot.id);
        this.players = this.players.filter((p) => p.id !== bot.id);
      }
      const onTeam = this.players.filter((p) => p.team === team).length;
      if (onTeam < this.config.teamSize) {
        const info = this.playerInfo(c, team);
        this.players.push(info);
        sim.addPlayer(info);
      } else this.members.get(c.id)!.team = -1;
      this.broadcast({ t: 'players', players: this.players });
    }
    c.send({ t: 'start', m: this.matchStart(c.id) });
  }

  setProfile(clientId: number, profile: Profile): void {
    const m = this.members.get(clientId);
    if (!m) return;
    m.client.profile = profile;
    if (this.phase === 'lobby') this.broadcastState();
  }

  setTeam(clientId: number, team: Team | -1): void {
    const m = this.members.get(clientId);
    if (!m || this.phase !== 'lobby') return;
    if (team !== -1) {
      let n = 0;
      for (const x of this.members.values()) if (x.team === team && x !== m) n++;
      if (n >= this.config.teamSize) return;
    }
    m.team = team;
    m.ready = false;
    this.broadcastState();
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
    this.broadcastState();
  }

  setReady(clientId: number, ready: boolean): void {
    const m = this.members.get(clientId);
    if (!m || this.phase !== 'lobby') return;
    m.ready = ready;
    this.broadcastState();
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
    this.players = [];
    for (const m of humansOnTeams) this.players.push(this.playerInfo(m.client, m.team as Team));
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
    this.phase = 'match';
    this.ended = false;
    this.endTimer = 0;
    for (const m of this.members.values()) m.client.send({ t: 'start', m: this.matchStart(m.client.id) });
    this.broadcastState();
    return null;
  }

  private matchStart(clientId: number): MatchStart {
    const sim = this.sim!;
    return {
      config: this.config,
      seed: sim.seed,
      players: this.players,
      hazards: sim.hazards,
      you: sim.unitById.has(clientId) ? clientId : -1,
      tick: sim.tick,
    };
  }

  private playerInfo(c: RoomClient, team: Team): PlayerInfo {
    return { id: c.id, name: c.profile.name, team, family: c.profile.family, cosmetics: c.profile.cosmetics, isBot: false };
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
    return {
      id,
      name: this.botName(),
      team,
      family: FAMILIES[randomInt(0, FAMILIES.length)],
      cosmetics: { hat: randomInt(0, 8), accent: randomInt(0, 8), face: randomInt(0, 8) },
      isBot: true,
      botDifficulty: this.config.botDifficulty,
    };
  }

  input(clientId: number, i: PlayerInput): void {
    if (this.sim && this.phase === 'match') this.sim.queueInput(clientId, i);
  }

  buy(clientId: number, item: ItemId): void {
    this.sim?.buy(clientId, item);
  }

  sell(clientId: number, slot: number): void {
    this.sim?.sell(clientId, slot);
  }

  upgrade(clientId: number, stat: UpgradeStat): void {
    this.sim?.upgrade(clientId, stat);
  }

  /** Advance one tick and send each member its own view. */
  tick(): void {
    const sim = this.sim;
    if (!sim || this.phase !== 'match') return;
    sim.step();
    let shared: string | null = null;
    for (const m of this.members.values()) {
      const inMatch = sim.unitById.has(m.client.id);
      if (inMatch) m.client.sendRaw(JSON.stringify({ t: 's', s: sim.snapshotFor(m.client.id) }), true);
      else {
        shared ??= JSON.stringify({ t: 's', s: sim.snapshotFor(-1) });
        m.client.sendRaw(shared, true);
      }
    }
    if (sim.phase === 'ended') {
      if (!this.ended) {
        this.ended = true;
        const e: MatchEnd = { winner: sim.winner, score: [sim.score[0], sim.score[1]], rows: sim.scoreboard(), players: this.players };
        this.broadcast({ t: 'end', e });
      }
      this.endTimer += TICK_DT;
      if (this.endTimer >= RETURN_TO_LOBBY_SEC) this.backToLobby();
    }
  }

  private backToLobby(): void {
    this.sim = null;
    this.phase = 'lobby';
    this.players = [];
    for (const m of this.members.values()) m.ready = false;
    this.broadcastState();
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
        cosmetics: m.client.profile.cosmetics,
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
