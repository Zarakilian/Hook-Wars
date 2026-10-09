// Which build is running, and the bridge to Steam in the desktop build.
//
// The Steam desktop app (Electron, desktop/**) exposes `window.hookwarsSteam` from its preload script
// (contextIsolation on, no Node in the page). Every call goes over IPC to the Electron main process,
// which owns steamworks.js, the local game server and the Steam P2P relay. The plain browser build has
// no bridge, so isSteam() is false there and premium cosmetics are shown as "Available in the Steam version".
//
// Multiplayer in the Steam build: the HOST's main process runs the normal Node game server on
// 127.0.0.1 and creates a Steam lobby; each JOINER's main process runs a small local relay that carries
// one WebSocket connection over Steam P2P packets to the host. Either way the page just connects a
// normal WebSocket to the `url` it is given, so the game client and server code stay the same.

export interface SteamLobbySummary {
  id: string; // Steam lobby id (a 64-bit number as a decimal string)
  name: string;
  host: string; // host persona name
  members: number;
  max: number;
  /** lobby metadata the host publishes with setLobbyInfo (map id, river mode, phase, version) */
  info: Record<string, string>;
}

export interface SteamPlayer {
  steamId: string; // 64-bit SteamID as a decimal string
  name: string; // persona name
}

export interface SteamBridge {
  readonly kind: 'steam';
  readonly appId: number;
  /** true when the stand-in is running instead of Steam (no Steam client, or HOOKWARS_FAKE_STEAM=1) */
  readonly fake: boolean;

  player(): Promise<SteamPlayer>;

  /** Host: start the local game server and a Steam lobby. url = the ws URL this page connects to. */
  hostLobby(opts: { name: string; maxMembers: number; isPrivate: boolean }): Promise<{ lobbyId: string; url: string }>;
  /** Join a lobby: sets up the P2P relay to its host. url = the local ws URL this page connects to. */
  joinLobby(lobbyId: string): Promise<{ url: string }>;
  /** Leave the current lobby (as host this also stops the local server once the match is over). */
  leaveLobby(): Promise<void>;
  listLobbies(): Promise<SteamLobbySummary[]>;
  /**
   * Host: publish metadata for the lobby browser (keys and values are short strings). The desktop app
   * writes game, v and host itself when it creates the lobby; the page must not send those keys.
   */
  setLobbyInfo(info: Record<string, string>): Promise<void>;
  /** Open the Steam overlay's invite dialog for the current lobby. */
  inviteFriends(): void;
  /** A join asked for from outside the game (a friend's invite or "Join game" in Steam). */
  onJoinRequest(cb: (lobbyId: string) => void): () => void;

  /** Steam Cloud save files (the Steam build keeps the offline locker here). */
  cloudRead(name: string): Promise<string | null>;
  cloudWrite(name: string, data: string): Promise<boolean>;

  /** Open a web page in the Steam overlay (the Item Store, once premium items are on sale). */
  openOverlayUrl(url: string): void;

  setFullscreen(on: boolean): void;
  isFullscreen(): Promise<boolean>;
  quit(): void;
}

export function steamBridge(): SteamBridge | null {
  const b = (globalThis as { hookwarsSteam?: unknown }).hookwarsSteam;
  return b && typeof b === 'object' && (b as { kind?: unknown }).kind === 'steam' ? (b as SteamBridge) : null;
}

export function isSteam(): boolean {
  return steamBridge() !== null;
}
