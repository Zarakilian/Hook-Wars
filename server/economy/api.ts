// Contract between the game server and the economy service (accounts, inventory, the Pearl store
// and the Pearl market). The game server only ever talks to this interface; ./index.ts builds the
// real service (./service.ts) or the null economy below.
import { DEFAULT_ITEM_IDS, ownedLoadout } from '../../shared/cosmetics.ts';
import type { EconomyClientMsg } from '../../shared/economy.ts';
import type { Profile, ServerMsg } from '../../shared/protocol.ts';
import type { ScoreRow } from '../../shared/types.ts';

export interface EconomyConn {
  readonly id: number; // connection id (also the player id in matches)
  readonly ip: string;
  profile: Profile;
  /** set by the economy service once the account is known */
  accountId: string | null;
  send(msg: ServerMsg): void;
}

export interface MatchResult {
  /**
   * The LIVE connection id of the human driving the unit when the match ended (after a rejoin this
   * is the new socket, not the unit id). The economy looks the account up by this id.
   */
  connId: number;
  won: boolean;
  row: ScoreRow;
}

export interface ServerEconomy {
  /** hello: load the account for this token (or create a guest one) and return the profile clamped to owned items */
  onHello(c: EconomyConn, token: string | undefined): Profile;
  /** clamp a requested profile (setProfile) to what the account owns */
  sanitize(c: EconomyConn, p: Profile): Profile;
  route(c: EconomyConn, msg: EconomyClientMsg): void;
  /** called once when a server match ends, for Pearl rewards and stats */
  onMatchEnd(results: MatchResult[]): void;
  /**
   * Stop pushing market updates to this connection. The game server calls it when the connection's
   * match starts, so market traffic never shares the line with snapshots.
   */
  unwatchMarket(c: EconomyConn): void;
  onDisconnect(c: EconomyConn): void;
  close(): void;
}

export const ECONOMY_OFF_MESSAGE = 'This server runs without accounts, the Store or the Market. You can still play with the default sets.';

/**
 * Fallback with no accounts: everyone wears default items only. Hello gets one econError
 * ('disabled') so the client shows why instead of "Signing in..."; economy messages get a polite error.
 */
export function createNullEconomy(message: string = ECONOMY_OFF_MESSAGE): ServerEconomy {
  const isDefault = (id: string) => DEFAULT_ITEM_IDS.includes(id);
  const clamp = (p: Profile): Profile => ({ ...p, loadout: ownedLoadout(p.loadout, isDefault) });
  return {
    onHello: (c, _t) => {
      // after 'welcome', which the game server sends as soon as this returns
      queueMicrotask(() => c.send({ t: 'econError', code: 'disabled', message }));
      return clamp(c.profile);
    },
    sanitize: (_c, p) => clamp(p),
    route: (c, msg) => c.send({ t: 'econError', code: 'disabled', message, re: msg.t }),
    onMatchEnd: () => {},
    unwatchMarket: () => {},
    onDisconnect: () => {},
    close: () => {},
  };
}
