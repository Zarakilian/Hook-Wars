// Player-facing words for modes, hazards, keys, phases and announcements. One place, so the
// menus, the HUD and How to Play always say the same thing.
import type { MapDef } from '../../shared/maps/types.ts';
import { HAZARD_INFO } from '../../shared/sim/hazards.ts';
import type {
  AnnounceKey, BotDifficulty, ControlScheme, HazardMode, KillCause, MapId, RiverMode, TidePhase,
} from '../../shared/types.ts';
import type { IconId } from './icons.ts';

export const RIVER_INFO: Record<RiverMode, { name: string; line: string; icon: IconId }> = {
  deep: { name: 'Deep Water', line: 'Falling in drowns you. Hook them in, or hook them across.', icon: 'wave' },
  dry: { name: 'Dry Bed', line: 'Walk the channel. Slow footing, nowhere to hide.', icon: 'dry' },
  tidal: { name: 'Tidal', line: 'The water comes and goes on a timer. Watch the warnings.', icon: 'tidal' },
};

/** One line on how this map does Tidal, or null when it has no tide. */
export function tidalLine(map: MapDef): string | null {
  const t = map.tide;
  if (!t) return null;
  if (t.style === 'locks') return 'The lock gates flood the canal, then drain it again.';
  if (t.style === 'freeze') return 'The river freezes solid, then cracks and thaws.';
  return 'The sea rolls in and out: wade at low tide, swim for it at high.';
}

export function tidalShort(map: MapDef): string {
  const t = map.tide;
  if (!t) return 'No tide here';
  if (t.style === 'locks') return 'Lock floods';
  if (t.style === 'freeze') return 'Freeze & thaw';
  return 'Tides';
}

export function hazardInfo(mode: HazardMode, map: MapDef): { name: string; line: string; icon: IconId } {
  switch (mode) {
    case 'none':
      return { name: 'None', line: 'Clean banks. Pure hook skill.', icon: 'close' };
    case 'thorns':
      return { name: 'Thorns', line: 'Bramble patches: slow you 30% and scratch 18 a second.', icon: 'thorns' };
    case 'bristles':
      return { name: 'Bristles', line: 'Spiky clumps: touch one for 35 damage and a shove.', icon: 'bristles' };
    case 'special': {
      const sp = HAZARD_INFO[map.special];
      return { name: sp.name, line: sp.blurb, icon: map.special };
    }
    case 'mixed':
      return { name: 'Mixed', line: `A bit of everything: thorns, bristles and ${HAZARD_INFO[map.special].name.toLowerCase()}.`, icon: 'hazard' };
  }
}

export function hazardPlacement(river: RiverMode): string {
  return river === 'deep'
    ? 'Deep Water: hazards sit on the banks only.'
    : 'Dry Bed and Tidal: hazards also sit in the river bed.';
}

export const BOT_NAMES_UI: Record<BotDifficulty, { name: string; line: string }> = {
  easy: { name: 'Easy', line: 'Slow to react. Great for learning.' },
  normal: { name: 'Normal', line: 'A fair fight.' },
  hard: { name: 'Hard', line: 'Leads shots and dodges.' },
  brutal: { name: 'Brutal', line: 'Hooks you from across the map.' },
};

export const MAP_ICON: Record<MapId, IconId> = { muckmire: 'thorns', frostfang: 'ice', coralcove: 'fish', cogwater: 'lock' };

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** Labels shown on the ability bar, per scheme: hook, grapple, bash. */
export const ABILITY_KEYS: Record<ControlScheme, [string, string, string]> = {
  modern: ['LMB', 'RMB', 'SPACE'],
  classic: ['Q', 'E', 'W'],
};

export const KEY_TABLE: Record<ControlScheme, [string, string[]][]> = {
  modern: [
    ['Move', ['WASD', 'Arrow keys']],
    ['Chain Hook', ['Left mouse']],
    ['Grapple', ['Right mouse', 'Q']],
    ['Belly Bash', ['Space', 'E']],
    ['Use items', ['1 to 4']],
    ['Shop', ['B']],
    ['Scoreboard', ['Tab']],
    ['Chat / team chat', ['Enter', 'Shift+Enter']],
    ['Zoom', ['Mouse wheel']],
    ['Menu', ['Esc']],
  ],
  classic: [
    ['Move', ['Right-click']],
    ['Stop', ['S']],
    ['Chain Hook', ['Q', 'Left mouse']],
    ['Grapple', ['E']],
    ['Belly Bash', ['W']],
    ['Use items', ['1 to 4']],
    ['Shop', ['B']],
    ['Scoreboard', ['Tab']],
    ['Chat / team chat', ['Enter', 'Shift+Enter']],
    ['Menu', ['Esc']],
  ],
};

// ---------------------------------------------------------------------------------------------
// River phases
// ---------------------------------------------------------------------------------------------

export type Tone = 'safe' | 'warn' | 'deep' | 'calm' | 'ice';

export function phaseInfo(phase: TidePhase, map: MapDef): { label: string; hint: string; icon: IconId; tone: Tone; total: number } {
  const t = map.tide;
  const locks = t?.style === 'locks';
  const tot = (k: 'lowSec' | 'risingSec' | 'highSec' | 'fallingSec') => (t ? t[k] : 1);
  switch (phase) {
    case 'low':
      return { label: locks ? 'Locks Drained' : 'Low Tide', hint: 'walk the bed', icon: 'dry', tone: 'safe', total: tot('lowSec') };
    case 'rising':
      return { label: locks ? 'Gates Opening' : 'Tide Rising', hint: 'get out of the channel!', icon: 'tidal', tone: 'warn', total: tot('risingSec') };
    case 'high':
      return { label: locks ? 'Canal Flooded' : 'High Tide', hint: 'deep water drowns', icon: 'wave', tone: 'deep', total: tot('highSec') };
    case 'falling':
      return { label: locks ? 'Canal Draining' : 'Tide Falling', hint: 'the bed opens soon', icon: 'tidal', tone: 'calm', total: tot('fallingSec') };
    case 'frozen':
      return { label: 'Frozen Solid', hint: 'cross the ice', icon: 'ice', tone: 'ice', total: tot('lowSec') };
    case 'cracking':
      return { label: 'Ice Cracking', hint: 'get off the ice!', icon: 'crack', tone: 'warn', total: tot('risingSec') };
    case 'thawed':
      return { label: 'Open Water', hint: 'deep water drowns', icon: 'wave', tone: 'deep', total: tot('highSec') };
    case 'freezing':
      return { label: 'Freezing Over', hint: 'ice forms soon', icon: 'ice', tone: 'calm', total: tot('fallingSec') };
    default:
      return { label: '', hint: '', icon: 'wave', tone: 'deep', total: 1 };
  }
}

/** Banner text when the river changes phase. */
export function tideBanner(phase: TidePhase, map: MapDef): { text: string; tone: Tone } | null {
  const locks = map.tide?.style === 'locks';
  switch (phase) {
    case 'rising':
      return { text: locks ? 'THE LOCK GATES ARE OPENING!' : 'THE TIDE IS COMING IN!', tone: 'warn' };
    case 'high':
      return { text: locks ? 'THE CANAL IS FLOODED!' : 'HIGH TIDE: THE RIVER IS DEEP!', tone: 'deep' };
    case 'falling':
      return { text: locks ? 'The canal is draining' : 'The tide is going out', tone: 'calm' };
    case 'low':
      return { text: locks ? 'THE LOCKS ARE DRY: CROSS!' : 'LOW TIDE: WALK THE BED!', tone: 'safe' };
    case 'frozen':
      return { text: 'FROZEN SOLID: CROSS THE ICE!', tone: 'ice' };
    case 'cracking':
      return { text: 'THE ICE IS CRACKING!', tone: 'warn' };
    case 'thawed':
      return { text: 'THE ICE IS GONE!', tone: 'deep' };
    case 'freezing':
      return { text: 'The river is freezing over', tone: 'calm' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Announcements and kills
// ---------------------------------------------------------------------------------------------

export const ANNOUNCE: Record<AnnounceKey, { text: string; tone: string; icon: IconId; sub: (name: string, n: number) => string }> = {
  firstBlood: { text: 'FIRST HOOK!', tone: 'gold', icon: 'hook', sub: (n) => `${n} lands the first catch` },
  doubleHook: { text: 'DOUBLE HOOK!', tone: 'orange', icon: 'hook', sub: (n) => n },
  tripleHook: { text: 'TRIPLE HOOK!', tone: 'red', icon: 'hook', sub: (n) => n },
  ultraHook: { text: 'ULTRA HOOK!', tone: 'purple', icon: 'hook', sub: (n, k) => `${n} x${k}` },
  spree3: { text: 'REEL DEAL!', tone: 'teal', icon: 'fish', sub: (n) => `${n}: 3 catches in a row` },
  spree5: { text: 'CATCH OF THE DAY!', tone: 'purple', icon: 'fish', sub: (n) => `${n}: 5 catches in a row` },
  spree8: { text: 'KRAKEN UNLEASHED!', tone: 'kraken', icon: 'crown', sub: (n) => `${n}: 8 catches in a row` },
  shutdown: { text: 'SHUT DOWN!', tone: 'red', icon: 'anchor', sub: (n, k) => `${n} ended a ${k} catch streak` },
  bullseye: { text: 'BULLSEYE!', tone: 'gold', icon: 'target', sub: (n) => n },
  save: { text: 'SAVED!', tone: 'green', icon: 'lifebuoy', sub: (n) => `${n} reeled a friend to safety` },
  drowned: { text: 'DROWNED!', tone: 'blue', icon: 'drown', sub: (n) => `${n} sleeps with the fishes` },
  overtime: { text: 'OVERTIME!', tone: 'red', icon: 'clock', sub: () => 'Next catch wins!' },
};

export const CAUSE_ICON: Record<KillCause, IconId> = {
  hook: 'hook',
  melee: 'melee',
  bash: 'bash',
  drown: 'drown',
  mine: 'mine',
  burn: 'burn',
  hazard: 'hazard',
  fountain: 'fountain',
};

/** What killed you, for the respawn card. */
export function deathLine(cause: KillCause, killer: string | null): string {
  const k = killer ?? 'someone';
  switch (cause) {
    case 'hook':
      return `Reeled in by ${k}`;
    case 'melee':
      return `Walloped by ${k}`;
    case 'bash':
      return `Belly-bashed by ${k}`;
    case 'drown':
      return killer ? `Dunked by ${k}` : 'You forgot how to swim';
    case 'mine':
      return killer ? `Stepped on ${k}'s Bramble Mine` : 'Stepped on a Bramble Mine';
    case 'burn':
      return killer ? `Toasted by ${k}'s Ember Barb` : 'Burnt to a crisp';
    case 'hazard':
      return killer ? `Shoved into a hazard by ${k}` : 'The hazards got you';
    case 'fountain':
      return 'The enemy fountain scorched you';
  }
}

export const DEATH_TITLES = ['REELED IN!', 'GONE FISHING', 'SUNK!', 'FISH FOOD!', 'OVERBOARD!', 'WASHED UP!'];

export const TIPS = [
  'Hook an ally out of the river to SAVE them.',
  'Two hooks that meet in the air clash and both bounce home.',
  'Grapple works while drowning. Latch onto a tree and fly out!',
  'Belly Bash interrupts enemy hooks. Time it well.',
  'Runes spawn in the river every 40 s. Hook them to claim them.',
  'Your home fountain heals you, and burns invaders.',
  'A Lucky Sinker gives every hook a 15% chance of a BULLSEYE: double damage.',
  'Drowning kills count as kills. Shove them in!',
  'Bramble Mines are invisible to the enemy team.',
  'A Puffball turns you invisible for 3 s. Casting reveals you.',
];
