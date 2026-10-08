// River state machine: Deep Water, Dry Bed and the Tidal cycles (tide, lock floods, freeze/thaw).
// Pure function of (map, config, time) so the client can reproduce it exactly.
import type { MapDef } from '../maps/types.ts';
import type { MatchConfig, RiverState, TidePhase } from '../types.ts';

const LOW_LEVEL = 0.04;
const DEEP_AT = 0.82;
const SHALLOW_AT = 0.28;

/** Seconds into the cycle at match start, so the opening is the classic deep river. */
function startOffset(map: MapDef): number {
  const t = map.tide!;
  // start partway through the high/thawed phase
  return t.lowSec + t.risingSec + t.highSec * 0.35;
}

export function tidalActive(map: MapDef, config: MatchConfig): boolean {
  return config.riverMode === 'tidal' && !!map.tide;
}

export function riverStateAt(map: MapDef, config: MatchConfig, time: number, out?: RiverState): RiverState {
  const s: RiverState = out ?? { level: 1, deep: true, shallow: false, frozen: false, phase: 'none', phaseLeft: 0, cycle: false };
  if (config.riverMode === 'dry') {
    s.level = 0;
    s.deep = false;
    s.shallow = false;
    s.frozen = false;
    s.phase = 'none';
    s.phaseLeft = 0;
    s.cycle = false;
    return s;
  }
  // Tidal on a map without a tide definition falls back to Deep Water.
  if (!tidalActive(map, config)) {
    s.level = 1;
    s.deep = true;
    s.shallow = false;
    s.frozen = false;
    s.phase = 'none';
    s.phaseLeft = 0;
    s.cycle = false;
    return s;
  }
  const t = map.tide!;
  const period = t.lowSec + t.risingSec + t.highSec + t.fallingSec;
  const c = (((time + startOffset(map)) % period) + period) % period;
  s.cycle = true;
  if (t.style === 'freeze') {
    // low = frozen, rising = cracking, high = thawed (open water), falling = freezing
    s.level = 1;
    if (c < t.lowSec) {
      setPhase(s, 'frozen', t.lowSec - c);
      s.frozen = true;
      s.deep = false;
      s.shallow = false;
    } else if (c < t.lowSec + t.risingSec) {
      setPhase(s, 'cracking', t.lowSec + t.risingSec - c);
      s.frozen = true;
      s.deep = false;
      s.shallow = false;
    } else if (c < t.lowSec + t.risingSec + t.highSec) {
      setPhase(s, 'thawed', t.lowSec + t.risingSec + t.highSec - c);
      s.frozen = false;
      s.deep = true;
      s.shallow = false;
    } else {
      setPhase(s, 'freezing', period - c);
      s.frozen = false;
      s.deep = true;
      s.shallow = false;
    }
    return s;
  }
  s.frozen = false;
  if (c < t.lowSec) {
    setPhase(s, 'low', t.lowSec - c);
    s.level = LOW_LEVEL;
  } else if (c < t.lowSec + t.risingSec) {
    const k = (c - t.lowSec) / t.risingSec;
    setPhase(s, 'rising', t.lowSec + t.risingSec - c);
    s.level = LOW_LEVEL + (1 - LOW_LEVEL) * smooth(k);
  } else if (c < t.lowSec + t.risingSec + t.highSec) {
    setPhase(s, 'high', t.lowSec + t.risingSec + t.highSec - c);
    s.level = 1;
  } else {
    const k = (c - t.lowSec - t.risingSec - t.highSec) / t.fallingSec;
    setPhase(s, 'falling', period - c);
    s.level = 1 - (1 - LOW_LEVEL) * smooth(k);
  }
  s.deep = s.level >= DEEP_AT;
  s.shallow = !s.deep && s.level >= SHALLOW_AT;
  return s;
}

function setPhase(s: RiverState, p: TidePhase, left: number): void {
  s.phase = p;
  s.phaseLeft = Math.max(0, left);
}

function smooth(k: number): number {
  return k * k * (3 - 2 * k);
}

/** Whether drifting movers (floes, barges, logs) float and move right now. */
export function moversFloat(state: RiverState, config: MatchConfig): boolean {
  if (config.riverMode === 'dry') return false;
  if (state.frozen) return false;
  return state.level > 0.5;
}

/** Whether drifting movers exist at all (they are stranded/hidden in Dry Bed). */
export function moversPresent(state: RiverState, config: MatchConfig): boolean {
  if (config.riverMode === 'dry') return false;
  return state.frozen || state.level > 0.5;
}
