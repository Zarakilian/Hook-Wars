// Gamepad support through the browser Gamepad API (W3C "standard" mapping, Xbox names). The same code
// runs in the Steam desktop app (its app:// scheme is a secure context), and it is the base for Steam
// Deck support later. No DOM or three.js here: InputController (input.ts) drives it once per tick and
// the tests drive it with a stubbed pad list.
//
// Twin-stick layout (the same for both control schemes):
//   left stick move, right stick aim, RT Chain Hook, LT Grapple, A or RB Belly Bash,
//   D-pad left/up/right/down = items 1 to 4, or hold LB and press X/Y/B/A = items 1 to 4,
//   Y shop, View (Back) scoreboard while held, Start (Menu) menu / escape.
// While LB is held, Y and A are item buttons (no shop toggle, no Bash). That is decided when the face
// button goes down, so letting go of LB first never turns an item press into a Bash.
import { HOOK_LEVELS } from '../../shared/constants.ts';
import { Btn, BTN_ITEM } from '../../shared/types.ts';

/** Standard-mapping button indices (PlayStation: A = Cross, B = Circle, X = Square, Y = Triangle). */
export const PadBtn = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Back: 8,
  Start: 9,
  LS: 10,
  RS: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
} as const;

/** What one connected pad looks like to us: the parts of the DOM Gamepad that we read. */
export interface PadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}
export interface PadLike {
  readonly index: number;
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly buttons: readonly PadButtonLike[];
  readonly axes: readonly number[];
}
export type GetPads = () => readonly (PadLike | null)[] | null | undefined;

export interface PadConfig {
  enabled: boolean;
  /** inner radial dead zone of both sticks, 0..DEADZONE_MAX of full deflection */
  deadzone: number;
  /** 0..1: how far a light push of the aim stick reaches (the power curve, see aimGamma) */
  aimSens: number;
  /** aim stick: push up to aim down the screen */
  invertY: boolean;
}

export const DEFAULT_PAD: PadConfig = { enabled: true, deadzone: 0.15, aimSens: 0.5, invertY: false };
export const DEADZONE_MAX = 0.5;
/** Full push is reached a little before the stick's rim (worn sticks rarely reach 1.0). */
export const STICK_OUTER = 0.92;
/** Analog triggers: down at 50%, up again below 30% (no chatter around one threshold). */
export const TRIGGER_DOWN = 0.5;
export const TRIGGER_UP = 0.3;
/** Closest aim point to the unit, metres. A touch past the dead zone must never aim at your own feet. */
export const AIM_MIN = 1.75;
/** When the aim stick springs back to the centre, keep the furthest aim of this last stretch. */
export const RELEASE_HOLD_MS = 120;
/** Before the aim stick is first used, the aim follows the walking direction at this share of the range. */
export const SEED_REACH = 0.6;
/**
 * A stick resting past the dead zone (a worn, drifting stick, a pad on the desk, or one jittering at the
 * dead-zone edge) is not "use": it must move this far (after the dead zone) from where it rests. From the
 * centre that is a push of about 0.3 at the default dead zone.
 */
export const STICK_WAKE = 0.2;

/** A stick reading counts as use: past the dead zone and at least STICK_WAKE from where it rests (`ref`). */
export function stickAwake(v: { x: number; z: number; mag: number }, ref: { x: number; z: number }): boolean {
  return v.mag > 0 && Math.hypot(v.x - ref.x, v.z - ref.z) >= STICK_WAKE;
}

/** Key hints on the HUD while a pad is in use: Chain Hook, Grapple, Belly Bash. */
export const PAD_ABILITY_GLYPHS: readonly [string, string, string] = ['RT', 'LT', 'A'];
/** D-pad directions of items 1 to 4, and the face buttons that pick them with LB held. */
export const PAD_ITEM_DPAD = ['left', 'up', 'right', 'down'] as const;
export const PAD_ITEM_FACE = ['X', 'Y', 'B', 'A'] as const;
export const PAD_SHOP_GLYPH = 'Y';

/** The button reference shown in Settings. */
export const PAD_TABLE: readonly [string, readonly string[]][] = [
  ['Move', ['Left stick']],
  ['Aim', ['Right stick']],
  ['Chain Hook', ['RT']],
  ['Grapple', ['LT']],
  ['Belly Bash', ['A', 'RB']],
  ['Use items 1 to 4', ['D-pad', 'LB + X Y B A']],
  ['Shop', ['Y']],
  ['Scoreboard', ['View (hold)']],
  ['Menu', ['Start']],
];

// ---------------------------------------------------------------------------------------------
// Shared state: the pad settings (pushed by client/settings.ts when settings load or change), the
// device in use (the HUD shows its glyphs) and the current hook range (the aim stick's reach).
// ---------------------------------------------------------------------------------------------

export type InputDevice = 'kbm' | 'pad';

let config: PadConfig = { ...DEFAULT_PAD };
let device: InputDevice = 'kbm';
let notedRange = 0;

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/** Sanitise a pad config (any field missing or out of range takes the default). */
export function cleanPadConfig(c: Partial<PadConfig> | null | undefined): PadConfig {
  const num = (v: unknown, d: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : d);
  return {
    enabled: c?.enabled !== false,
    deadzone: num(c?.deadzone, DEFAULT_PAD.deadzone, DEADZONE_MAX),
    aimSens: num(c?.aimSens, DEFAULT_PAD.aimSens, 1),
    invertY: c?.invertY === true,
  };
}

export function setPadConfig(c: Partial<PadConfig>): void {
  config = cleanPadConfig(c);
  if (!config.enabled) device = 'kbm';
}

export function padConfig(): PadConfig {
  return config;
}

/** The device the player used last: the HUD shows gamepad glyphs while it is 'pad'. */
export function lastDevice(): InputDevice {
  return device;
}

export function noteDevice(d: InputDevice): void {
  device = d;
}

/** The HUD notes the current hook range every frame (upgrades and Long Line change it). */
export function noteHookRange(r: number): void {
  if (Number.isFinite(r) && r > 0) notedRange = r;
}

/** Hook range for the aim stick's full push: the noted one, else the base range. */
export function notedHookRange(): number {
  return notedRange > 0 ? notedRange : HOOK_LEVELS.range[0];
}

/** Test helper: back to a fresh page. */
export function resetPadShared(): void {
  config = { ...DEFAULT_PAD };
  device = 'kbm';
  notedRange = 0;
}

/**
 * The page's pads, looked up fresh on every call (Chrome hands back new snapshot objects each poll).
 * Empty when the Gamepad API is missing: old browsers, and plain http:// pages that are not localhost
 * (browsers only expose it in secure contexts), or a Permissions Policy that blocks it.
 */
export function browserPads(): readonly (PadLike | null)[] {
  try {
    const nav = typeof navigator === 'undefined' ? null : (navigator as Partial<Navigator> | null);
    if (!nav || typeof nav.getGamepads !== 'function') return [];
    return (nav.getGamepads() as readonly (PadLike | null)[] | null) ?? [];
  } catch {
    return [];
  }
}

/** The page can read controllers at all (the API exists and the page is a secure context). */
export function gamepadApi(): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof (navigator as Partial<Navigator>).getGamepads !== 'function') return false;
    return typeof window === 'undefined' || window.isSecureContext !== false;
  } catch {
    return false;
  }
}

/** A pad's id for people: the vendor/product hex prefix dropped, the length capped. */
export function padName(id: string): string {
  const t = id.replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').replace(/\s+/g, ' ').trim();
  return (t.length > 48 ? `${t.slice(0, 47)}…` : t) || 'Controller';
}

// ---------------------------------------------------------------------------------------------
// Stick shaping
// ---------------------------------------------------------------------------------------------

/**
 * Radial dead zone: nothing inside `inner`, then the push is rescaled so it starts at 0 just past the
 * dead zone and reaches 1 at `outer`. The direction is kept exactly.
 */
export function radial(x: number, y: number, inner: number, outer = STICK_OUTER): { x: number; y: number; mag: number } {
  const m = Math.hypot(x, y);
  if (!Number.isFinite(m) || m <= inner || m <= 1e-6) return { x: 0, y: 0, mag: 0 };
  const mag = clamp01((m - inner) / Math.max(1e-3, outer - inner));
  return { x: (x / m) * mag, y: (y / m) * mag, mag };
}

/** Power-curve exponent of the aim stick: 2.5 at sensitivity 0 (fine near the centre), 1.5 at the default 0.5, 0.5 at 1. */
export function aimGamma(sens: number): number {
  return 2.5 - 2 * clamp01(sens);
}

/** Share of the hook range for an aim push (0..1, after the dead zone). */
export function aimReach(mag: number, sens: number): number {
  return mag <= 0 ? 0 : Math.pow(clamp01(mag), aimGamma(sens));
}

/** Distance from the unit to the aim point for a reach: AIM_MIN at a light touch, the hook range at a full push. */
export function aimDistance(reach: number, range: number): number {
  const r = Math.max(AIM_MIN, range);
  return AIM_MIN + (r - AIM_MIN) * clamp01(reach);
}

// ---------------------------------------------------------------------------------------------
// The aim point of the right stick, relative to the unit
// ---------------------------------------------------------------------------------------------

interface AimSample {
  t: number;
  dx: number;
  dz: number;
  reach: number;
}

/**
 * Where the aim stick points, as a direction and a share of the hook range, relative to the unit (so
 * walking keeps the aim in front of you instead of leaving a fixed spot on the map behind). When the
 * stick is let go it springs back through small pushes, so the aim keeps the furthest point of the
 * last RELEASE_HOLD_MS instead. Until the stick is first used, the aim follows the walking direction.
 */
export class PadAim {
  private dx = 0;
  private dz = 0;
  private reach = 0;
  private known = false;
  private stickUsed = false;
  private holding = false;
  private hist: AimSample[] = [];

  /** stick: aim stick after the dead zone (z = down the screen); move: move stick after the dead zone. */
  update(stick: { x: number; z: number; mag: number }, move: { x: number; z: number }, cfg: PadConfig, now: number): void {
    if (stick.mag > 0) {
      const l = Math.hypot(stick.x, stick.z) || 1;
      this.dx = stick.x / l;
      this.dz = stick.z / l;
      this.reach = aimReach(stick.mag, cfg.aimSens);
      this.known = true;
      this.stickUsed = true;
      this.holding = true;
      this.hist.push({ t: now, dx: this.dx, dz: this.dz, reach: this.reach });
      while (this.hist.length && this.hist[0].t < now - RELEASE_HOLD_MS) this.hist.shift();
      return;
    }
    if (this.holding) {
      // the stick just came back into the dead zone: undo the spring-back
      this.holding = false;
      let best: AimSample | null = null;
      for (const s of this.hist) if (s.t >= now - RELEASE_HOLD_MS && (!best || s.reach > best.reach)) best = s;
      if (best) {
        this.dx = best.dx;
        this.dz = best.dz;
        this.reach = best.reach;
      }
      this.hist = [];
      return;
    }
    if (!this.stickUsed) {
      const l = Math.hypot(move.x, move.z);
      if (l > 0) {
        this.dx = move.x / l;
        this.dz = move.z / l;
        this.reach = SEED_REACH;
        this.known = true;
      }
    }
  }

  /** Aim point offset from the unit for a hook range, or null before anything set it. */
  offset(range: number): { x: number; z: number } | null {
    if (!this.known) return null;
    const d = aimDistance(this.reach, range);
    return { x: this.dx * d, z: this.dz * d };
  }

  reset(): void {
    this.known = false;
    this.stickUsed = false;
    this.holding = false;
    this.hist = [];
    this.reach = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the pad: picking one, press edges, mapping
// ---------------------------------------------------------------------------------------------

export interface PadPoll {
  /** a pad is connected and the controller setting is on */
  present: boolean;
  /** id of the pad in use ('' when none) */
  id: string;
  /** move stick after the dead zone; z is down the screen (the camera looks toward -z) */
  move: { x: number; z: number; mag: number };
  /** aim stick after the dead zone and the invert setting */
  aim: { x: number; z: number; mag: number };
  /** Btn bits that went down this poll */
  presses: number;
  /** any pad button went down this poll */
  edge: boolean;
  escape: boolean;
  shop: boolean;
  /** View went down (true) or up (false) this poll, or no change (null) */
  scoreboard: boolean | null;
}

function emptyPoll(): PadPoll {
  return { present: false, id: '', move: { x: 0, z: 0, mag: 0 }, aim: { x: 0, z: 0, mag: 0 }, presses: 0, edge: false, escape: false, shop: false, scoreboard: null };
}

const isTrigger = (i: number) => i === PadBtn.LT || i === PadBtn.RT;

/** Button i down, with hysteresis on the analog triggers. */
function buttonDown(b: PadButtonLike | undefined, i: number, wasDown: boolean): boolean {
  if (!b) return false;
  const v = typeof b.value === 'number' && Number.isFinite(b.value) ? b.value : b.pressed ? 1 : 0;
  if (isTrigger(i)) return wasDown ? v > TRIGGER_UP || (b.pressed && v === 0) : v >= TRIGGER_DOWN || (b.pressed && v === 0);
  return b.pressed || v >= 0.5;
}

/**
 * Reads the pads once per call. The pad in use is the one that last had a button go down; a pad seen
 * for the first time (plugged in, or woken by its first press) only sets the baseline, so buttons
 * already held never fire. Unplugging releases everything (a held View closes the scoreboard).
 */
export class PadReader {
  private readonly getPads: GetPads;
  private index = -1;
  private readonly seen = new Map<number, { id: string; down: boolean[] }>();
  private backHeld = false;

  constructor(getPads: GetPads = browserPads) {
    this.getPads = getPads;
  }

  /** Index of the pad in use, -1 when none. */
  get current(): number {
    return this.index;
  }

  poll(cfg: PadConfig): PadPoll {
    const out = emptyPoll();
    let pads: readonly (PadLike | null)[] = [];
    if (cfg.enabled) {
      try {
        pads = this.getPads() ?? [];
      } catch {
        pads = [];
      }
    }
    // press edges of every live pad (a pad's first sighting is only its baseline)
    const live: PadLike[] = [];
    const edges = new Map<number, number[]>();
    for (const p of pads) {
      if (!p || !p.connected || !p.buttons) continue;
      live.push(p);
      const prev = this.seen.get(p.index);
      const fresh = !prev || prev.id !== p.id;
      const down: boolean[] = [];
      const went: number[] = [];
      for (let i = 0; i < p.buttons.length; i++) {
        down[i] = buttonDown(p.buttons[i], i, !fresh && !!prev?.down[i]);
        if (!fresh && down[i] && !prev?.down[i]) went.push(i);
      }
      this.seen.set(p.index, { id: p.id, down });
      if (went.length) edges.set(p.index, went);
    }
    for (const k of [...this.seen.keys()]) if (!live.some((p) => p.index === k)) this.seen.delete(k);

    // which pad: the current one, unless another pad just had a button go down. By default only a
    // standard-mapping pad: other devices (wheels, flight sticks, odd HID gadgets with axes resting at -1)
    // are used once a button on them is pressed, so they never walk the unit or steal the aim on their own.
    let pad = live.find((p) => p.index === this.index) ?? null;
    if (!pad || !edges.has(pad.index)) {
      const other = live.find((p) => p.index !== this.index && edges.has(p.index));
      if (other) pad = other;
    }
    if (!pad) pad = live.find((p) => p.mapping === 'standard') ?? null;
    if (!pad) {
      this.release(out);
      this.index = -1;
      return out;
    }
    if (pad.index !== this.index) {
      this.release(out);
      this.index = pad.index;
    }

    out.present = true;
    out.id = pad.id;
    const ax = (i: number) => {
      const v = pad.axes[i];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    const mv = radial(ax(0), ax(1), cfg.deadzone);
    out.move = { x: mv.x, z: mv.y, mag: mv.mag };
    const am = radial(ax(2), ax(3) * (cfg.invertY ? -1 : 1), cfg.deadzone);
    out.aim = { x: am.x, z: am.y, mag: am.mag };

    const state = this.seen.get(pad.index)?.down ?? [];
    const went = edges.get(pad.index) ?? [];
    const layer = !!state[PadBtn.LB];
    for (const i of went) {
      out.edge = true;
      if (i === PadBtn.RT) out.presses |= Btn.Hook;
      else if (i === PadBtn.LT) out.presses |= Btn.Grapple;
      else if (i === PadBtn.RB) out.presses |= Btn.Bash;
      else if (i === PadBtn.Left) out.presses |= BTN_ITEM[0];
      else if (i === PadBtn.Up) out.presses |= BTN_ITEM[1];
      else if (i === PadBtn.Right) out.presses |= BTN_ITEM[2];
      else if (i === PadBtn.Down) out.presses |= BTN_ITEM[3];
      else if (i === PadBtn.X && layer) out.presses |= BTN_ITEM[0];
      else if (i === PadBtn.Y) {
        if (layer) out.presses |= BTN_ITEM[1];
        else out.shop = true;
      } else if (i === PadBtn.B && layer) out.presses |= BTN_ITEM[2];
      else if (i === PadBtn.A) out.presses |= layer ? BTN_ITEM[3] : Btn.Bash;
      else if (i === PadBtn.Start) out.escape = true;
    }
    const back = !!state[PadBtn.Back];
    if (back !== this.backHeld) {
      this.backHeld = back;
      out.scoreboard = back;
    }
    return out;
  }

  /** The pad in use went away or changed: let go of what it held. */
  private release(out: PadPoll): void {
    if (this.backHeld) {
      this.backHeld = false;
      out.scoreboard = false;
    }
  }
}
