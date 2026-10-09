// ECONOMY=trust: the economy of a lobby the Steam desktop app hosts for its players (docs/design.md).
// A player-hosted server has no account server and no database, so nobody is signed in here:
//   - what a player wears comes from their own locker (kept by their client, in Steam Cloud), and the
//     server only checks it is made of real catalog items of their family. Premium items stay stripped
//     until Steam Inventory ownership checks exist (a later phase that needs the Steamworks app).
//   - hello gets one econError 'local_only' (no re), so the client keeps its own locker instead of
//     waiting for an account; every economy message is answered with econError 'local_only' too.
//   - no payouts: each client pays its own locker at match end, like solo play.
import { cleanLoadout, ownedLoadout, type Loadout } from '../../shared/cosmetics.ts';
import { isPremium } from '../../shared/economy.ts';
import type { Profile } from '../../shared/protocol.ts';
import type { FamilyId } from '../../shared/types.ts';
import type { ServerEconomy } from './api.ts';

/** The econError code a trust server sends (after hello, and for every economy message). */
export const LOCAL_ONLY_CODE = 'local_only';
export const LOCAL_ONLY_MESSAGE = 'This lobby is hosted by a player, so your own locker is used here: no accounts, Store or Market on this server. Pearls from matches go to your locker.';

/** Keep only real catalog items of this family in their own slot, and never a premium one. */
export function trustLoadout(family: FamilyId, loadout: Loadout): Loadout {
  return ownedLoadout(cleanLoadout(family, loadout), (id) => !isPremium(id));
}

export function createTrustEconomy(message: string = LOCAL_ONLY_MESSAGE): ServerEconomy {
  const clamp = (p: Profile): Profile => ({ ...p, loadout: trustLoadout(p.family, p.loadout) });
  return {
    onHello: (c, _token) => {
      // after 'welcome', which the game server sends as soon as this returns; the token is ignored
      queueMicrotask(() => c.send({ t: 'econError', code: LOCAL_ONLY_CODE, message }));
      c.accountId = null;
      return clamp(c.profile);
    },
    sanitize: (_c, p) => clamp(p),
    route: (c, msg) => c.send({ t: 'econError', code: LOCAL_ONLY_CODE, message, re: msg.t }),
    onMatchEnd: () => {}, // no payouts: the clients pay their own lockers
    unwatchMarket: () => {},
    onDisconnect: () => {},
    close: () => {},
  };
}
