// The predicted ("ghost") hook drawn online from the moment of release until the server's hook turns.
// Its flight must match the hook the server will launch (shared/sim/sim.ts launchHook), or the head
// lurches when the real one takes over.
//
// The ghost flies in the present; the server's hook is drawn on the render clock, a round trip plus the
// interpolation delay behind it (0.1 s on a LAN, 0.3 s at 150 ms). Blending into that timeline while the
// hook flies out can only slow the head down (it did: 14-16 m/s for 0.1 s on a LAN, 7-9 m/s for 0.25 s
// at 100 ms, against a 30 m/s flight). So the ghost keeps flying for as long as the server's hook flies
// out straight: on the server's line, never behind the server's head, at the full flight speed. The time
// it is ahead is given back where the hook stops flying out anyway: the ghost stops at the point where
// the newest snapshot says the hook turned (its range, a wall, a catch), or where it is when that news
// arrives, and the server's head takes over once the picture reaches the turn.
import { BAL, HOOK_LEVELS, TICK_DT } from '../../shared/constants.ts';
import { clamp } from '../../shared/math.ts';
import type { HookSnap, YouSnap } from '../../shared/types.ts';

export interface GhostHookParams {
  /** m/s, Long Line included */
  speed: number;
  /** head radius in m */
  radius: number;
  /** m, Long Line included (YouSnap.hookRange already carries it) */
  range: number;
  /** HookSnap.fx bits: 1 ember, 2 ricochet, 4 bendy, 8 longshot */
  fx: number;
  /** m from the hand where the server's hook turns at the end of a straight flight (range, rounded up to its 0.35 m step) */
  reach: number;
}

/** shared/sim/sim.ts HOOK_SUBSTEP: the sim moves a flying hook in steps this long (m). */
const SIM_HOOK_SUBSTEP = 0.35;

/**
 * Where the server's hook turns on a straight flight: the sim adds its steps (shared/sim/sim.ts hookOut)
 * and turns on the one that reaches the range, up to a step past it. Same arithmetic, same number.
 */
export function flightReach(speed: number, range: number): number {
  let traveled = 0;
  for (let tick = 0; tick < 100_000; tick++) {
    let remaining = speed * TICK_DT;
    while (remaining > 1e-6) {
      const step = Math.min(remaining, SIM_HOOK_SUBSTEP);
      remaining -= step;
      traveled += step;
      if (traveled >= range) return traveled;
    }
  }
  return range;
}

export function ghostHookParams(you: YouSnap): GhostHookParams {
  const has = (t: string) => you.buffs.some((b) => b.t === t);
  const item = (id: string) => you.items.some((s) => s && s.id === id);
  const longshot = has('longshot');
  const speed = HOOK_LEVELS.speed[you.up.speed] * (longshot ? BAL.longshotSpeedMul : 1);
  return {
    speed,
    radius: HOOK_LEVELS.width[you.up.width],
    range: you.hookRange,
    fx: (item('ember') ? 1 : 0) | (item('ricochet') || has('bouncy') ? 2 : 0) | (has('bendy') ? 4 : 0) | (longshot ? 8 : 0),
    reach: flightReach(speed, you.hookRange),
  };
}

/** The ghost's flight, in the client's own clock (GameClient.time, seconds). */
export interface GhostFlight extends GhostHookParams {
  /** when the head leaves the hand (press + wind-up) */
  start: number;
  /** no server hook by then (client clock) and none by deadTick (render clock): the cast failed */
  deadline: number;
  /**
   * Render tick by which the server's hook must be in the picture: the newest snapshot tick when the
   * press went out (OwnHookPredictor.sent; until then, at the key press), plus a round trip, the
   * wind-up and a margin. While the snapshot stream stalls the render clock stands still, so the ghost keeps
   * waiting instead of vanishing and the hook popping in behind it. -1 = unknown (only the
   * client-clock deadline applies).
   */
  deadTick: number;
  /** when our server hook first showed up in the picture (client clock), -1 = not yet */
  seenAt: number;
  aimX: number;
  aimZ: number;
  /** throw direction and the hand it leaves from: set when the head first shows (launchGhost) */
  dx: number;
  dz: number;
  ox: number;
  oz: number;
  launched: boolean;
  /** m along the throw the head stops at: where the server's hook turned (Infinity = not known yet) */
  cap: number;
  /** furthest our hook was seen flying out straight in the newest snapshot (m along the throw) */
  peak: number;
  /** where our hook was drawn on the render clock last frame (m along the throw), NaN = not yet */
  srvS: number;
  /** when the picture first showed our hook turned (client clock), -1 = not yet */
  turnAt: number;
  /** client clock of the last frame */
  lastTime: number;
}

/**
 * How long the ghost keeps flying once the server's hook is in the newer snapshot but cannot be
 * interpolated yet (it takes one tick, more if the snapshot stream stutters), counted from when it
 * first showed up.
 */
export const HANDOVER_GRACE = 0.25;
/** Past the deadline, at most this long waiting on a stalled snapshot stream (s). */
export const GHOST_STALL_CAP = 2;
/**
 * Once the picture shows our hook turned, the ghost waits (standing at the turn) at most this long for
 * the drawn server head to come up to it: the turn shows up to a tick early (interpolation takes the
 * newer snapshot's phase), two ticks of real time when the render clock runs slow.
 */
export const TURN_WAIT = 0.1;
/** How fast the ghost slides sideways onto the server's line (m/s): the body it left from was predicted. */
const LINE_SLIDE = 2;
/** Render ticks of margin on deadTick (input queueing on the server, one tick of input pacing). */
const DEAD_TICK_MARGIN = 8;

/** The render tick a hook pressed now (newest snapshot latestTick, -1 if none) shows up by, at the latest. */
export function deadTickFor(latestTick: number, rttMs: number): number {
  if (latestTick < 0) return -1;
  return latestTick + Math.ceil(rttMs / 1000 / TICK_DT) + Math.ceil(BAL.hookWindup / TICK_DT) + DEAD_TICK_MARGIN;
}

export function startGhostFlight(
  you: YouSnap,
  time: number,
  aim: { x: number; z: number },
  rttMs: number,
  delayTicks: number,
  latestTick = -1,
): GhostFlight {
  const start = time + BAL.hookWindup;
  return {
    ...ghostHookParams(you),
    start,
    deadline: start + rttMs / 1000 + (delayTicks + 1) * TICK_DT + 0.1,
    seenAt: -1,
    deadTick: deadTickFor(latestTick, rttMs),
    aimX: aim.x,
    aimZ: aim.z,
    dx: 0,
    dz: 0,
    ox: 0,
    oz: 0,
    launched: false,
    cap: Infinity,
    peak: -Infinity,
    srvS: Number.NaN,
    turnAt: -1,
    lastTime: Number.NaN,
  };
}

/** The head leaves the hand now: aim from where the (predicted) body stands. */
export function launchGhost(g: GhostFlight, body: { x: number; z: number }): void {
  let dx = g.aimX - body.x;
  let dz = g.aimZ - body.z;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l;
  dz /= l;
  g.dx = dx;
  g.dz = dz;
  g.ox = body.x + dx * BAL.hookHand;
  g.oz = body.z + dz * BAL.hookHand;
  g.launched = true;
}

/** How far the ghost's head is from the hand along the throw (m). */
export function ghostTravel(g: GhostFlight, time: number): number {
  return Math.min(g.cap === Infinity ? g.reach : g.cap, g.speed * Math.max(0, time - g.start));
}

export function ghostHead(g: GhostFlight, time: number, out: { x: number; z: number }): { x: number; z: number } {
  const travel = ghostTravel(g, time);
  out.x = g.ox + g.dx * travel;
  out.z = g.oz + g.dz * travel;
  return out;
}

/** A point's distance along the ghost's throw, from the hand it left (m). */
function along(g: GhostFlight, x: number, z: number): number {
  return (x - g.ox) * g.dx + (z - g.oz) * g.dz;
}

/** The hook flies out on a straight line, the flight the ghost predicts (no catch, no bend, no steering). */
export function fliesStraight(h: Pick<HookSnap, 'p' | 'tg' | 'ru' | 'pts' | 'fx'>): boolean {
  return h.p === 0 && h.tg < 0 && h.ru < 0 && h.pts.length === 0 && !(h.fx & 4);
}

/** Bendy Eel: flying out, but steered toward the live cursor on the server, which the ghost cannot follow. */
function steers(h: Pick<HookSnap, 'p' | 'tg' | 'ru' | 'pts' | 'fx'>): boolean {
  return h.p === 0 && h.tg < 0 && h.ru < 0 && h.pts.length === 0 && (h.fx & 4) !== 0;
}

/**
 * The newest snapshot (ahead of the picture by the interpolation delay) tells early where our hook
 * stopped flying out: the ghost may go up to that point and no further. If it is already past it (the
 * news takes a round trip), it stops where it is: it never goes back while the hook is out.
 */
function learnTurn(g: GhostFlight, latest: { h: HookSnap[] } | undefined, youId: number, time: number): void {
  if (!latest || g.cap !== Infinity) return;
  const h = latest.h.find((x) => x.o === youId && x.k === 0);
  if (!h) {
    // seen in an older newest snapshot and gone from this one: the hook is already over
    if (g.peak > -Infinity) g.cap = Math.max(g.peak, ghostTravel(g, time));
    return;
  }
  const s = along(g, h.x, h.z);
  if (fliesStraight(h) || steers(h)) g.peak = Math.max(g.peak, s);
  else g.cap = Math.max(g.peak, s, ghostTravel(g, time));
}

/**
 * The server's hook is in the picture and flies out straight: keep the ghost on its line and never
 * behind its head (a page that froze, a picture catching up after a stall).
 */
function followServer(g: GhostFlight, own: HookSnap, time: number, dt: number): void {
  const s = along(g, own.x, own.z);
  if (s > g.speed * (time - g.start)) g.start = time - s / g.speed;
  const side = (own.x - g.ox) * -g.dz + (own.z - g.oz) * g.dx;
  const k = clamp(side, -LINE_SLIDE * dt, LINE_SLIDE * dt);
  g.ox -= g.dz * k;
  g.oz += g.dx * k;
}

/**
 * What the ghost does this frame:
 * - 'before': still winding up, nothing to draw
 * - 'fly': draw the ghost; the server's hook may already be in the frame (`own`), but it is not drawn
 * - 'take': the server's hook takes over now (`own`)
 * - 'drop': no server hook came, or we were knocked, hooked or killed: remove the ghost
 * While our server hook flies out straight the ghost keeps flying (see the top of this file). Once it
 * has turned, the ghost stands at the turn until the drawn server head has come up to it, then hands
 * over. A Bendy Eel hook steers on the server toward the live cursor: it is handed over as soon as it
 * is interpolated (a hook only in the newer snapshot stands at that snapshot's position for up to a
 * tick, and blending into a standing head pulls it backwards). Records when our server hook was first
 * seen (g.seenAt).
 */
export function ghostStep(
  g: GhostFlight,
  frame: { tick: number; hooks: HookSnap[]; freshHooks: ReadonlySet<number>; latest?: { h: HookSnap[] } },
  youId: number,
  time: number,
  disabled: boolean,
): { act: 'before' | 'fly' | 'take' | 'drop'; own: HookSnap | null } {
  const dt = Number.isNaN(g.lastTime) ? 0 : Math.max(0, time - g.lastTime);
  g.lastTime = time;
  if (g.launched) learnTurn(g, frame.latest, youId, time);
  const own = frame.hooks.find((h) => h.o === youId && h.k === 0) ?? null;
  if (own) {
    if (g.seenAt < 0) g.seenAt = time;
    if (!g.launched) return { act: 'take', own };
    if (fliesStraight(own)) {
      followServer(g, own, time, dt);
      g.srvS = along(g, own.x, own.z);
      return { act: 'fly', own };
    }
    if (steers(own)) {
      const waiting = frame.freshHooks.has(own.i) && time - g.seenAt <= HANDOVER_GRACE;
      return { act: waiting ? 'fly' : 'take', own };
    }
    // turned: caught a unit or a rune, hit a wall, bounced, bent in a whirlpool, clashed or reached its range
    const s = ghostTravel(g, time);
    if (g.cap > s) g.cap = s;
    if (g.turnAt < 0) g.turnAt = time;
    const srv = along(g, own.x, own.z);
    const coming = srv > g.srvS + 1e-6 && srv < s - 1e-3 && time - g.turnAt <= TURN_WAIT;
    g.srvS = srv;
    return { act: coming ? 'fly' : 'take', own };
  }
  // our hook was in the picture and is gone (it came back between two frames, or a stall skipped it)
  if (g.seenAt >= 0) return { act: 'drop', own: null };
  // never earlier than the client-clock deadline; later only while the render clock has not yet
  // reached the tick the hook should show up on (a stalled stream), and never past the cap
  const late = time > g.deadline && (g.deadTick < 0 || frame.tick > g.deadTick || time > g.deadline + GHOST_STALL_CAP);
  if (late || disabled) return { act: 'drop', own: null };
  return { act: time < g.start ? 'before' : 'fly', own: null };
}

/** After the hand-over, the real head is drawn with a shrinking offset so it does not jump back. */
export interface HeadBlend {
  id: number;
  /** offset at hand-over (ghost head minus the server head), shrinking to 0 over dur seconds */
  ox: number;
  oz: number;
  /** seconds since hand-over: the hand-over frame itself draws the ghost head, the clock starts on the next */
  t: number;
  dur: number;
  started: boolean;
  /** throw direction, and the head drawn last frame */
  dx: number;
  dz: number;
  lx: number;
  lz: number;
}

/**
 * The blend at hand-over, from where the ghost is drawn to the server's head (null: the ghost never
 * left the hand, the head snaps). Also after a turn: a ghost that overshot a catch comes back to it
 * instead of jumping.
 */
export function startHeadBlend(g: GhostFlight, own: HookSnap, time: number): HeadBlend | null {
  if (!g.launched) return null;
  const head = ghostHead(g, time, { x: 0, z: 0 });
  const ox = head.x - own.x;
  const oz = head.z - own.z;
  // after a turn the hook is coming back (with what it caught): the head rejoins it fast, before it is in
  const d = Math.hypot(ox, oz);
  const dur = fliesStraight(own) || steers(own) ? 0.06 + d / g.speed : 0.04 + d / (3 * g.speed);
  return { id: own.i, ox, oz, t: 0, dur, started: false, dx: g.dx, dz: g.dz, lx: head.x, lz: head.z };
}

/**
 * The own head to draw this frame; returns true once the blend is over. While the hook still flies
 * out straight, the head never moves back along the throw: on a jittery line the interpolated server
 * head speeds up and slows down, and the shrinking offset would pull a slow frame backwards. The head
 * then waits for the server's to come level, and only then is the blend over (no jump back at the
 * end). A hook that bounced (a bend point) or steers (Bendy Eel) may really come back along the
 * throw: it is followed, the offset shrinking as usual.
 */
export function blendHead(bl: HeadBlend, h: Pick<HookSnap, 'x' | 'z' | 'p' | 'tg' | 'ru' | 'pts' | 'fx'>, dt: number, out: { x: number; z: number }): boolean {
  if (bl.started) bl.t += dt;
  bl.started = true;
  const k = Math.max(0, 1 - bl.t / bl.dur);
  out.x = h.x + bl.ox * k;
  out.z = h.z + bl.oz * k;
  if (h.p === 0 && h.tg < 0 && h.ru < 0 && h.pts.length === 0 && !(h.fx & 4)) {
    const along = (out.x - bl.lx) * bl.dx + (out.z - bl.lz) * bl.dz;
    if (along < 0) {
      out.x -= bl.dx * along;
      out.z -= bl.dz * along;
    }
  }
  bl.lx = out.x;
  bl.lz = out.z;
  return k <= 0 && Math.abs(out.x - h.x) + Math.abs(out.z - h.z) < 1e-3;
}

/**
 * Our own hook online, from the key press until the server's hook is drawn on its own: the ghost, the
 * hand-over and the blend. GameClient keeps the chain meshes; this decides where the head goes.
 * Per frame: frame() once, before the hooks are drawn, then head() for every hook in the frame.
 * frame() takes the interpolated Frame (client/net/interp.ts): its `latest` snapshot tells the ghost
 * early where the hook turned.
 */
export class OwnHookPredictor {
  ghost: GhostFlight | null = null;
  blend: HeadBlend | null = null;

  /** latestTick: the newest snapshot tick received (for the render-clock deadline), -1 if none */
  press(you: YouSnap, time: number, aim: { x: number; z: number }, rttMs: number, delayTicks: number, latestTick = -1): void {
    this.ghost = startGhostFlight(you, time, aim, rttMs, delayTicks, latestTick);
  }

  /**
   * The press just went out to the server (GameClient.localTick). A frozen page (a long frame, a GC
   * pause) sends it late, and the hook then shows up later than the key press alone says.
   */
  sent(latestTick: number, rttMs: number): void {
    const g = this.ghost;
    if (g && latestTick >= 0) g.deadTick = Math.max(g.deadTick, deadTickFor(latestTick, rttMs));
  }

  /** 'fly' with the ghost to draw at ghostHead(); 'take' and 'drop' end the ghost; 'none' = no ghost */
  frame(
    f: { tick: number; hooks: HookSnap[]; freshHooks: ReadonlySet<number>; latest?: { h: HookSnap[] } },
    youId: number,
    time: number,
    body: { x: number; z: number },
    disabled: boolean,
  ): { act: 'none' | 'before' | 'fly' | 'take' | 'drop'; own: HookSnap | null } {
    const g = this.ghost;
    if (!g) return { act: 'none', own: null };
    const step = ghostStep(g, f, youId, time, disabled);
    if (step.act === 'take') {
      this.blend = step.own ? startHeadBlend(g, step.own, time) : null;
      this.ghost = null;
    } else if (step.act === 'drop') this.ghost = null;
    else if (step.act === 'fly' && !g.launched) launchGhost(g, body);
    return step;
  }

  /** Where to draw hook h's head this frame, or null to skip it (ours, while the ghost still flies). */
  head(h: HookSnap, youId: number, dt: number, out: { x: number; z: number }): { x: number; z: number } | null {
    if (this.ghost && h.o === youId && h.k === 0) return null;
    out.x = h.x;
    out.z = h.z;
    if (this.blend && this.blend.id === h.i && blendHead(this.blend, h, dt, out)) this.blend = null;
    return out;
  }
}
