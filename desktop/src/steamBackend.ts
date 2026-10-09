// What the desktop app needs from Steam, as one small interface with two implementations:
//   SteamworksBackend (./steamworksBackend.ts)  a thin adapter over steamworks.js (the real Steam client)
//   FakeSteamBackend  (./fakeSteam.ts)          the stand-in: a local hub so several app windows on one
//                                               machine can find each other's lobbies and swap packets
// Ids (players and lobbies) are 64-bit numbers as decimal strings everywhere in this app.

export type LobbyVisibility = 'public' | 'private';

export interface LobbyListing {
  id: string;
  owner: string;
  members: number;
  max: number;
  data: Record<string, string>;
}

export interface BackendEvents {
  /** a P2P packet arrived (already accepted: see sessionRequest) */
  packet: (from: string, data: Buffer) => void;
  /** a player we have no session with wants to send us packets: call acceptSession to let them */
  sessionRequest: (from: string) => void;
  /** Steam could not reach this player any more */
  sessionFailed: (from: string) => void;
  /** members, owner or data of a lobby we are in changed */
  lobbyChanged: (lobbyId: string) => void;
  /** the player asked to join a lobby from outside the game (a friend's invite, "Join game") */
  joinRequested: (lobbyId: string) => void;
  /** the stand-in lost its hub (fake only): every lobby and session is gone */
  disconnected: (reason: string) => void;
}

export interface SteamBackend {
  readonly appId: number;
  /** true for the stand-in */
  readonly fake: boolean;
  me(): { steamId: string; name: string };

  createLobby(visibility: LobbyVisibility, maxMembers: number): Promise<string>;
  joinLobby(lobbyId: string): Promise<void>;
  leaveLobby(lobbyId: string): void;
  /** lobbies other players host (public and joinable), unfiltered: the caller filters by metadata */
  listLobbies(): Promise<LobbyListing[]>;
  lobbyOwner(lobbyId: string): string | null;
  lobbyMembers(lobbyId: string): string[];
  lobbyMemberLimit(lobbyId: string): number;
  lobbyData(lobbyId: string): Record<string, string>;
  /** owner only: merge these keys into the lobby's metadata */
  setLobbyData(lobbyId: string, data: Record<string, string>): boolean;
  setLobbyJoinable(lobbyId: string, joinable: boolean): void;
  openInviteDialog(lobbyId: string): void;

  /** reliable, ordered P2P packet */
  sendPacket(to: string, data: Buffer): boolean;
  acceptSession(from: string): void;
  /** forget a session (after the player left) so a later packet asks again */
  closeSession(with_: string): void;

  /** the file's text; null only when there is no such file; throws when it cannot be read */
  cloudRead(name: string): string | null;
  /** true once saved; false (never a throw) when it could not be saved */
  cloudWrite(name: string, data: string): boolean;
  openOverlayUrl(url: string): void;

  on<E extends keyof BackendEvents>(event: E, cb: BackendEvents[E]): () => void;
  close(): void;
}

/** A tiny typed event list, so the backends need no EventEmitter typing tricks. */
export class Emitter<Events extends { [K in keyof Events]: (...args: never[]) => void }> {
  private readonly lists = new Map<keyof Events, Set<(...args: never[]) => void>>();

  on<E extends keyof Events>(event: E, cb: Events[E]): () => void {
    let set = this.lists.get(event);
    if (!set) {
      set = new Set();
      this.lists.set(event, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    const set = this.lists.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as (...a: Parameters<Events[E]>) => void)(...args);
      } catch (err) {
        console.error(`[steam] ${String(event)} handler failed:`, err);
      }
    }
  }

  clear(): void {
    this.lists.clear();
  }
}
