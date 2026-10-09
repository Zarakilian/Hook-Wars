// The predicted ("ghost") hook drawn online from the moment of release until the server's hook arrives.
// Its flight must match the hook the server will launch (shared/sim/sim.ts launchHook), or the head
// lurches when the real one takes over.
import { BAL, HOOK_LEVELS } from '../../shared/constants.ts';
import type { YouSnap } from '../../shared/types.ts';

export interface GhostHookParams {
  /** m/s, Long Line included */
  speed: number;
  /** head radius in m */
  radius: number;
  /** m, Long Line included (YouSnap.hookRange already carries it) */
  range: number;
  /** HookSnap.fx bits: 1 ember, 2 ricochet, 4 bendy, 8 longshot */
  fx: number;
}

export function ghostHookParams(you: YouSnap): GhostHookParams {
  const has = (t: string) => you.buffs.some((b) => b.t === t);
  const item = (id: string) => you.items.some((s) => s && s.id === id);
  const longshot = has('longshot');
  return {
    speed: HOOK_LEVELS.speed[you.up.speed] * (longshot ? BAL.longshotSpeedMul : 1),
    radius: HOOK_LEVELS.width[you.up.width],
    range: you.hookRange,
    fx: (item('ember') ? 1 : 0) | (item('ricochet') || has('bouncy') ? 2 : 0) | (has('bendy') ? 4 : 0) | (longshot ? 8 : 0),
  };
}
