// A match session hides whether the sim runs here (solo) or on a server (online).
import { BOT_NAMES, TICK_DT } from '../../shared/constants.ts';
import type { MatchEnd, MatchStart, Profile } from '../../shared/protocol.ts';
import { GameSim } from '../../shared/sim/sim.ts';
import { randomBotLoadout } from '../../shared/cosmetics.ts';

/** tiny seeded RNG for bot outfits */
function mulberry(a: number): () => number {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
import { FAMILIES, type ItemId, type MatchConfig, type PlayerInfo, type PlayerInput, type Snapshot, type Team, type UpgradeStat } from '../../shared/types.ts';
import type { Connection } from './connection.ts';

export interface MatchSession {
  readonly local: boolean;
  start: MatchStart;
  onSnapshot: ((s: Snapshot) => void) | null;
  onPlayers: ((p: PlayerInfo[]) => void) | null;
  onEnd: ((e: MatchEnd) => void) | null;
  sendInput(i: PlayerInput): void;
  buy(item: ItemId): void;
  sell(slot: number): void;
  upgrade(stat: UpgradeStat): void;
  chat(text: string, team: boolean): void;
  /** Local sessions advance their sim here (called every frame). */
  pump(nowMs: number): void;
  /** Round trip time in ms (0 for local). */
  rtt(): number;
  close(): void;
}

// ---------------------------------------------------------------------------------------------

export class LocalSession implements MatchSession {
  readonly local = true;
  start: MatchStart;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onPlayers: ((p: PlayerInfo[]) => void) | null = null;
  onEnd: ((e: MatchEnd) => void) | null = null;
  readonly sim: GameSim;
  private acc = 0;
  private last = -1;
  private ended = false;
  private readonly you: number;
  private paused = false;

  constructor(config: MatchConfig, profile: Profile, team: Team) {
    const players: PlayerInfo[] = [];
    this.you = 1;
    players.push({ id: this.you, name: profile.name, team, family: profile.family, loadout: profile.loadout, isBot: false });
    let n = 0;
    const used = new Set<string>([profile.name]);
    const botName = () => {
      for (let i = 0; i < BOT_NAMES.length; i++) {
        const name = BOT_NAMES[(n * 7 + i) % BOT_NAMES.length];
        if (!used.has(name)) {
          used.add(name);
          n++;
          return name;
        }
      }
      return `Bot ${++n}`;
    };
    for (const t of [0, 1] as Team[]) {
      let count = players.filter((p) => p.team === t).length;
      while (count < config.teamSize) {
        const id = 100 + players.length;
        players.push({
          id,
          name: botName(),
          team: t,
          family: FAMILIES[id % FAMILIES.length],
          loadout: randomBotLoadout(FAMILIES[id % FAMILIES.length], mulberry(id * 7919 + 17)),
          isBot: true,
          botDifficulty: config.botDifficulty,
        });
        count++;
      }
    }
    const seed = (Math.random() * 2 ** 31) | 0;
    this.sim = new GameSim(config, players, seed);
    this.sim.inputSlack = 0; // solo: never keep a standing input backlog
    this.start = { config, seed, players, hazards: this.sim.hazards, you: this.you, tick: 0 };
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  sendInput(i: PlayerInput): void {
    this.sim.queueInput(this.you, i);
  }
  buy(item: ItemId): void {
    this.sim.buy(this.you, item);
  }
  sell(slot: number): void {
    this.sim.sell(this.you, slot);
  }
  upgrade(stat: UpgradeStat): void {
    this.sim.upgrade(this.you, stat);
  }
  chat(): void {}

  pump(nowMs: number): void {
    if (this.last < 0) this.last = nowMs;
    if (nowMs <= this.last) return; // clocks must only move forward
    // catch up as far as the input side does (GameClient: 0.5 s, 15 ticks), so every input has its tick
    const dt = Math.min(0.5, (nowMs - this.last) / 1000);
    this.last = nowMs;
    if (this.paused) return;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= TICK_DT && steps < 15) {
      this.acc -= TICK_DT;
      steps++;
      this.sim.step();
      this.onSnapshot?.(this.sim.snapshotFor(this.you));
      if (this.sim.phase === 'ended' && !this.ended) {
        this.ended = true;
        this.onEnd?.({ winner: this.sim.winner, score: [this.sim.score[0], this.sim.score[1]], rows: this.sim.scoreboard(), players: this.start.players });
      }
    }
  }

  rtt(): number {
    return 0;
  }

  close(): void {
    this.onSnapshot = null;
    this.onEnd = null;
  }
}

// ---------------------------------------------------------------------------------------------

/** Spectators ack every this many snapshot ticks (players ack on every input instead). */
const SPECTATOR_ACK_EVERY = 2;

export class OnlineSession implements MatchSession {
  readonly local = false;
  start: MatchStart;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onPlayers: ((p: PlayerInfo[]) => void) | null = null;
  onEnd: ((e: MatchEnd) => void) | null = null;
  private conn: Connection;
  /** newest snapshot tick received: echoed to the server, which stops streaming to us when we fall behind */
  private lastTick = -1;
  private ackedTick = -1;

  constructor(conn: Connection, start: MatchStart) {
    this.conn = conn;
    this.start = start;
  }

  /** Newest snapshot tick this session has received (-1 before the first). */
  get receivedTick(): number {
    return this.lastTick;
  }

  /** Called by the app for match messages. */
  receiveSnapshot(s: Snapshot): void {
    if (s.t > this.lastTick) this.lastTick = s.t;
    // a spectator sends no inputs, so it acks here; a player's ack rides on every input
    if (this.start.you < 0 && this.lastTick - this.ackedTick >= SPECTATOR_ACK_EVERY) {
      this.ackedTick = this.lastTick;
      this.conn.send({ t: 'ack', a: this.lastTick });
    }
    this.onSnapshot?.(s);
  }
  receivePlayers(p: PlayerInfo[]): void {
    this.start = { ...this.start, players: p };
    this.onPlayers?.(p);
  }
  receiveEnd(e: MatchEnd): void {
    this.onEnd?.(e);
  }

  sendInput(i: PlayerInput): void {
    this.conn.send(this.lastTick >= 0 ? { t: 'input', i, a: this.lastTick } : { t: 'input', i });
  }
  buy(item: ItemId): void {
    this.conn.send({ t: 'buy', item });
  }
  sell(slot: number): void {
    this.conn.send({ t: 'sell', slot });
  }
  upgrade(stat: UpgradeStat): void {
    this.conn.send({ t: 'upgrade', stat });
  }
  chat(text: string, team: boolean): void {
    this.conn.send({ t: 'chat', text, team });
  }
  pump(): void {}
  rtt(): number {
    return this.conn.rtt;
  }
  close(): void {
    this.onSnapshot = null;
    this.onEnd = null;
    this.onPlayers = null;
  }
}
