// Contract between the game server and the economy service (accounts, inventory, store, market,
// wallet link, Solana devnet). The economy pass replaces createServerEconomy() in ./index.ts with
// the real service; the game server only ever talks to this interface.
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
  onDisconnect(c: EconomyConn): void;
  close(): void;
}

/** Fallback with no accounts: everyone wears default items only, economy messages get a polite error. */
export function createNullEconomy(): ServerEconomy {
  const isDefault = (id: string) => DEFAULT_ITEM_IDS.includes(id);
  const clamp = (p: Profile): Profile => ({ ...p, loadout: ownedLoadout(p.loadout, isDefault) });
  return {
    onHello: (_c, _t) => clamp(_c.profile),
    sanitize: (_c, p) => clamp(p),
    route: (c) => c.send({ t: 'econError', code: 'disabled', message: 'This server has no store or marketplace.' }),
    onMatchEnd: () => {},
    onDisconnect: () => {},
    close: () => {},
  };
}
