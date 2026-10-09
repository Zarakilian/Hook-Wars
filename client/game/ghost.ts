// The predicted ("ghost") hook drawn online from the moment of release until the server's hook arrives.
// Its flight must match the hook the server will launch (shared/sim/sim.ts launchHook), or the head
// lurches when the real one takes over.
import { BAL, HOOK_LEVELS, TICK_DT } from '../../shared/constants.ts';
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
}

/**
 * How long the ghost keeps flying once the server's hook is in the newer snapshot but cannot be
 * interpolated yet (it takes one tick, more if the snapshot stream stutters), counted from when it
 * first showed up.
 */
export const HANDOVER_GRACE = 0.25;
/** Past the deadline, at most this long waiting on a stalled snapshot stream (s). */
export const GHOST_STALL_CAP = 2;
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

export function ghostHead(g: GhostFlight, time: number, out: { x: number; z: number }): { x: number; z: number } {
  const travel = Math.min(g.range, g.speed * Math.max(0, time - g.start));
  out.x = g.ox + g.dx * travel;
  out.z = g.oz + g.dz * travel;
  return out;
}

/**
 * What the ghost does this frame:
 * - 'before': still winding up, nothing to draw
 * - 'fly': draw the ghost; the server's hook may already be in the frame (`own`), but it is not drawn yet
 * - 'take': the server's hook takes over now (`own`)
 * - 'drop': no server hook came, or we were knocked, hooked or killed: remove the ghost
 * The server's hook takes over only once it is interpolated. A hook only in the newer snapshot stands
 * at that snapshot's position for up to a tick, and blending into a standing head pulls it backwards.
 * Records when our server hook was first seen (g.seenAt).
 */
export function ghostStep(
  g: GhostFlight,
  frame: { tick: number; hooks: HookSnap[]; freshHooks: ReadonlySet<number> },
  youId: number,
  time: number,
  disabled: boolean,
): { act: 'before' | 'fly' | 'take' | 'drop'; own: HookSnap | null } {
  const own = frame.hooks.find((h) => h.o === youId && h.k === 0) ?? null;
  if (own) {
    if (g.seenAt < 0) g.seenAt = time;
    const waiting = frame.freshHooks.has(own.i) && g.launched && time - g.seenAt <= HANDOVER_GRACE;
    return { act: waiting ? 'fly' : 'take', own };
  }
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

/** The blend at hand-over, or null when the head should snap (the hook already caught or turned back). */
export function startHeadBlend(g: GhostFlight, own: HookSnap, time: number): HeadBlend | null {
  if (!g.launched || own.p !== 0 || own.tg >= 0 || own.ru >= 0) return null;
  const head = ghostHead(g, time, { x: 0, z: 0 });
  const ox = head.x - own.x;
  const oz = head.z - own.z;
  return { id: own.i, ox, oz, t: 0, dur: 0.06 + Math.hypot(ox, oz) / g.speed, started: false, dx: g.dx, dz: g.dz, lx: head.x, lz: head.z };
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
    f: { tick: number; hooks: HookSnap[]; freshHooks: ReadonlySet<number> },
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
