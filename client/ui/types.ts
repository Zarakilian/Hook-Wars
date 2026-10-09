// Contract between the app controller (client/app.ts) and the UI layer (client/ui/*).
// The app owns state and calls ui.render(state) whenever it changes; the UI calls actions.
import type { MatchEnd, Profile, RoomState, RoomSummary } from '../../shared/protocol.ts';
import type {
  GameEvent, HookSnap, ItemId, MatchConfig, PlayerInfo, RiverState, RuneSnap, ScoreRow, Team, UnitSnap, UpgradeStat, YouSnap,
} from '../../shared/types.ts';
import type { MapDef } from '../../shared/maps/types.ts';
import type { HazardInst } from '../../shared/sim/entities.ts';
import type { Settings } from '../settings.ts';
import type { SteamPlayState } from '../net/steamPlay.ts';

/**
 * 'locker' | 'store' | 'market' | 'career' are the cosmetic economy screens (v2). app.go() routes them generically.
 * 'steam' is the Steam lobby screen, only in the Steam build (AppState.steam is set there).
 */
export type Screen = 'menu' | 'solo' | 'online' | 'lobby' | 'match' | 'settings' | 'profile' | 'locker' | 'store' | 'market' | 'career' | 'steam';

export interface ChatLine {
  from: string;
  fromId: number;
  text: string;
  team: boolean;
  teamId: Team | -1;
  system?: boolean;
  time: number;
}

export interface OnlineState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  url: string;
  error?: string;
  serverName?: string;
  motd?: string;
  youId: number;
  rooms: RoomSummary[];
}

export interface AppState {
  screen: Screen;
  profile: Profile;
  settings: Settings;
  online: OnlineState;
  room: RoomState | null;
  /** set while a match is running or just ended */
  match: { local: boolean; ended: MatchEnd | null } | null;
  chat: ChatLine[];
  toast: { text: string; kind: 'info' | 'error'; id: number } | null;
  /** Steam build only (client/platform.ts isSteam()): Steam lobbies. Absent in the browser build. */
  steam?: SteamPlayState;
  /** Steam build only: the engine has the cinematic mode behind the Epic graphics option. */
  epicAvailable?: boolean;
}

export interface AppActions {
  go(screen: Screen): void;
  saveProfile(p: Profile): void;
  saveSettings(s: Settings): void;
  /** Solo vs bots */
  startSolo(config: MatchConfig, team: Team): void;
  /** Online */
  connect(url: string): void;
  disconnect(): void;
  refreshRooms(): void;
  createRoom(name: string, isPrivate: boolean, config: MatchConfig): void;
  joinRoom(code: string): void;
  quickPlay(): void;
  leaveRoom(): void;
  setTeam(team: Team | -1): void;
  setConfig(config: MatchConfig): void;
  setReady(ready: boolean): void;
  startMatch(): void;
  sendChat(text: string, team: boolean): void;
  /** In match */
  buy(item: ItemId): void;
  sell(slot: number): void;
  upgrade(stat: UpgradeStat): void;
  leaveMatch(): void;
  /** Close the in-match Esc menu (un-pauses a solo match). */
  resume(): void;
  /** Online, after a match ends: close the end screen and wait in the room's lobby (stays in the room). */
  backToLobby(): void;
  /** UI sound hooks */
  uiSound(kind: 'click' | 'hover' | 'open' | 'purchase' | 'equip' | 'listingSold'): void;

  // ------------------------------------------------------------------ Steam build only (AppState.steam)
  /** Ask Steam for the lobby list again. */
  steamRefresh?(): void;
  /** Start a lobby: the local game server, the Steam lobby and its room. */
  steamHost?(o: { name: string; maxPlayers: number; isPrivate: boolean }): void;
  /** Join a lobby from the browser. */
  steamJoin?(lobbyId: string): void;
  /** Leave the Steam lobby, back to the Steam screen. */
  steamLeave?(): void;
  /** Open the Steam overlay's invite dialog. */
  steamInvite?(): void;
  /** A friend's invite that arrived during a live match: join it now (leaving the match), or not. */
  steamAcceptInvite?(): void;
  steamDismissInvite?(): void;
  /** The desktop window's fullscreen. */
  setFullscreen?(on: boolean): void;
}

/** Everything the HUD needs for one frame. */
export interface HudFrame {
  map: MapDef;
  config: MatchConfig;
  hazards: HazardInst[];
  players: Map<number, PlayerInfo>;
  units: Map<number, UnitSnap>; // interpolated, visible units
  youId: number; // -1 spectating
  you: YouSnap | null;
  me: UnitSnap | null;
  score: [number, number];
  timeLeft: number;
  overtime: boolean;
  phase: 'countdown' | 'playing' | 'ended';
  countdown: number;
  river: RiverState;
  scoreboard: ScoreRow[];
  ping: number;
  fps: number;
  local: boolean;
  /** world position of the local unit and the camera focus, for the minimap */
  focus: { x: number; z: number };
  /** screen-space anchor above each visible unit's head (CSS pixels), for health bars and names */
  screen: Map<number, { x: number; y: number; onScreen: boolean }>;
  /** world-space camera view rectangle corners on the ground (x,z pairs), for the minimap frustum */
  view: [number, number][];
  /** Optional: live hooks (interpolated frame) for minimap hook lines. Not required by the HUD. */
  hooks?: HookSnap[];
  /** Optional: live runes (interpolated frame) for the minimap. Without it the HUD tracks runes from events. */
  runes?: RuneSnap[];
}

export interface Hud {
  show(): void;
  hide(): void;
  frame(f: HudFrame): void;
  event(ev: GameEvent, f: HudFrame): void;
  chat(line: ChatLine): void;
  toggleShop(open?: boolean): void;
  shopOpen(): boolean;
  scoreboard(show: boolean): void;
  openChat(team: boolean): void;
  /** true while the chat box (or any HUD text field) has focus */
  typing(): boolean;
  showEnd(e: MatchEnd, youId: number, local: boolean): void;
  /** Escape menu inside a match (resume / settings / leave). */
  toggleMenu(open?: boolean): void;
}

export interface UI {
  render(state: AppState): void;
  readonly hud: Hud;
}
