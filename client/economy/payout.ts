// Pearls a client pays itself at the end of an online match on a server that keeps no accounts
// (ECONOMY=trust: a lobby hosted by a player in the Steam build). The same rules the account server
// applies: matchPearls() for the result, nothing for a player who never threw a hook, the full rate
// with 2 or more humans in the match and the solo rate otherwise. No daily cap: like solo play, the
// offline locker belongs to this player alone.
import { matchPearls } from '../../shared/cosmetics.ts';
import { SOLO_PEARL_RATE } from '../../shared/economy.ts';
import type { MatchEnd } from '../../shared/protocol.ts';

export interface LocalPayout {
  pearls: number;
  /** words for the toast and the end screen */
  reason: string;
}

export function trustPayout(e: MatchEnd, youId: number): LocalPayout {
  const me = e.players.find((p) => p.id === youId && !p.isBot);
  const row = e.rows.find((r) => r.i === youId);
  if (!me || !row) return { pearls: 0, reason: 'spectating' };
  if (row.ht === 0) return { pearls: 0, reason: 'no hooks thrown, no Pearls' };
  const humans = e.players.filter((p) => !p.isBot).length;
  const rate = humans >= 2 ? 1 : SOLO_PEARL_RATE;
  const won = e.winner === me.team;
  const pearls = Math.round(matchPearls(won, row.k, row.hh, row.sv) * rate);
  return { pearls, reason: `${won ? 'win' : 'match'}${rate < 1 ? ', half rate: no other players' : ''}` };
}

/**
 * One key per match (its room and its random seed), so a repeated 'end', a second end screen or the
 * same match seen again after a rejoin never pays twice.
 */
export function matchKey(room: string | null | undefined, seed: number): string {
  return `${room ?? '-'}:${seed}`;
}
