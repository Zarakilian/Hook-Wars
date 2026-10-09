// Names and limits shared by the desktop app's modules. The relay header names are part of the
// contract with the game server (server/gameServer.ts reads them): keep them byte for byte.
import { MAX_TEAM_SIZE, PROTOCOL_VERSION } from '../../shared/constants.ts';

/** Custom scheme and host the built client is served from: the page's origin is exactly APP_ORIGIN. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'hookwars';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Header carrying the per-run relay secret on the host relay's connections to the local server. */
export const RELAY_SECRET_HEADER = 'x-hookwars-relay';
/** Header naming the remote player a relayed connection belongs to: `steam:<steamid64>`. */
export const RELAY_PEER_HEADER = 'x-hookwars-peer';
export const RELAY_PEER_PREFIX = 'steam:';

/** Lobby metadata every Hook Wars lobby carries. App 480 (Spacewar) is shared by every developer. */
export const LOBBY_GAME_KEY = 'game';
export const LOBBY_GAME_VALUE = 'hookwars';
export const LOBBY_VERSION_KEY = 'v';
export const LOBBY_VERSION_VALUE = String(PROTOCOL_VERSION);
/** Keys the desktop app writes itself; setLobbyInfo from the page cannot overwrite them. */
export const RESERVED_LOBBY_KEYS: readonly string[] = [LOBBY_GAME_KEY, LOBBY_VERSION_KEY, 'host'];

/** Steam's public test app (Spacewar), used until the owner's own Steamworks app exists. */
export const DEV_APP_ID = 480;

/** Humans per lobby: both full teams (MAX_TEAM_SIZE a side, so 5v5 today and 6v6 once that lands). */
export const MIN_LOBBY_MEMBERS = 2;
export const MAX_LOBBY_MEMBERS = 2 * MAX_TEAM_SIZE;

/** The game server refuses client messages above this many bytes (server/gameServer.ts MAX_PAYLOAD). */
export const MAX_CLIENT_MESSAGE = 4096;

/** A valid SteamID64 or lobby id: a decimal 64-bit number. */
export function isSteamId64(s: unknown): s is string {
  if (typeof s !== 'string' || !/^[1-9]\d{0,19}$/.test(s)) return false;
  return BigInt(s) <= 0xffff_ffff_ffff_ffffn;
}
