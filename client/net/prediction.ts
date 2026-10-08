// Client-side prediction for the local unit's walking, with server reconciliation and
// visual error smoothing. Uses the exact same stepMove() as the server.
import { TICK_DT } from '../../shared/constants.ts';
import type { MapDef } from '../../shared/maps/types.ts';
import { stepMove, type MoveBody } from '../../shared/sim/movement.ts';
import { STALE_INPUT_TICKS } from '../../shared/sim/sim.ts';
import { UnitState, type PlayerInput, type RiverState, type UnitSnap, type YouSnap } from '../../shared/types.ts';
import { World } from '../../shared/world.ts';

interface Pending {
  input: PlayerInput;
  mm: number;
}

export class Predictor {
  readonly world: World;
  river: RiverState = { level: 1, deep: true, shallow: false, frozen: false, phase: 'none', phaseLeft: 0, cycle: false };
  readonly body: MoveBody = { x: 0, z: 0, vx: 0, vz: 0 };
  readonly prev = { x: 0, z: 0 };
  /** smoothed render offset after corrections */
  readonly err = { x: 0, z: 0 };
  active = false;
  private pending: Pending[] = [];
  private mm = 1;
  private slowTicks = 0;
  private slowMul = 1;
  private lastDrawnX = NaN;
  private lastDrawnZ = NaN;
  private initialised = false;
  /** server tick at which the current ack was first seen, to count the server's held ticks */
  private ackSeen = -1;
  private ackTick = 0;
  private calls = 0;
  /** held ticks the last reconcile accounted for (diagnostics) */
  holds = 0;

  constructor(map: MapDef) {
    this.world = new World(map);
  }

  /**
   * Predict the server's wind-up speed locally (mul 0 = rooted, e.g. Belly Bash; Hook and Grapple keep
   * walking at a reduced speed) so prediction does not drift and then snap back.
   */
  slowFor(seconds: number, mul: number): void {
    this.slowTicks = Math.max(this.slowTicks, Math.ceil(seconds / TICK_DT));
    this.slowMul = mul;
  }

  /** Where the own unit was last drawn, so re-activation after a forced move blends instead of popping. */
  noteRendered(x: number, z: number): void {
    this.lastDrawnX = x;
    this.lastDrawnZ = z;
  }

  /** Apply one locally generated input (one tick). */
  apply(input: PlayerInput): void {
    this.prev.x = this.body.x;
    this.prev.z = this.body.z;
    if (!this.active) {
      this.pending.push({ input, mm: this.mm });
      if (this.pending.length > 90) this.pending.shift();
      return;
    }
    const mm = this.slowTicks > 0 ? this.mm * this.slowMul : this.mm;
    if (this.slowTicks > 0) this.slowTicks--;
    this.pending.push({ input, mm });
    if (this.pending.length > 90) this.pending.shift();
    stepMove(this.world, this.river, this.body, input.mx, input.mz, mm, TICK_DT);
  }

  /**
   * Server says where we really are; rewind and replay unacknowledged inputs.
   *
   * Held ticks: when an input is late the server repeats our last movement for that tick, and drops a
   * movement-only late input for each such tick once they arrive (shared/sim/sim.ts consumeInput). Those
   * steps are already in the server position, so the replay skips the same inputs instead of walking
   * them twice (which overshot and then snapped back after every stall). Pass the snapshot tick as
   * serverTick; without it every call counts as one tick.
   */
  reconcile(me: UnitSnap, you: YouSnap, river: RiverState, moverClock: number, moversOn: boolean, serverTick?: number): void {
    this.river = river;
    this.world.updateMovers(moverClock, moversOn);
    const controllable = me.st === UnitState.Alive || me.st === UnitState.Drowning || me.st === UnitState.Casting;
    this.mm = you.mm;
    const oldX = this.body.x;
    const oldZ = this.body.z;
    const tick = serverTick ?? ++this.calls;
    if (you.ack !== this.ackSeen || tick < this.ackTick) {
      this.ackSeen = you.ack;
      this.ackTick = tick;
    }
    // ticks the server held since it consumed our acked input (beyond STALE it stopped instead)
    let skip = Math.min(STALE_INPUT_TICKS, Math.max(0, tick - this.ackTick));
    this.holds = skip;
    // drop acknowledged inputs
    while (this.pending.length && this.pending[0].input.seq <= you.ack) this.pending.shift();
    this.body.x = me.x;
    this.body.z = me.z;
    this.body.vx = you.vx;
    this.body.vz = you.vz;
    if (!controllable) {
      this.active = false;
      this.slowTicks = 0;
      this.prev.x = me.x;
      this.prev.z = me.z;
      this.err.x = this.err.z = 0;
      this.initialised = true;
      return;
    }
    const wasActive = this.active;
    this.active = true;
    for (const p of this.pending) {
      if (skip > 0 && p.input.b === 0) {
        skip--; // the server already walked this tick with our previous movement
        continue;
      }
      stepMove(this.world, this.river, this.body, p.input.mx, p.input.mz, p.mm, TICK_DT);
    }
    if (!this.initialised || !wasActive) {
      this.prev.x = this.body.x;
      this.prev.z = this.body.z;
      // blend from where we were last drawn (end of a grapple, drag or knock) instead of popping
      const ok = this.initialised && Number.isFinite(this.lastDrawnX);
      this.err.x = ok ? this.lastDrawnX - this.body.x : 0;
      this.err.z = ok ? this.lastDrawnZ - this.body.z : 0;
      if (this.err.x * this.err.x + this.err.z * this.err.z > 9) this.err.x = this.err.z = 0;
      this.initialised = true;
      return;
    }
    const dx = oldX - this.body.x;
    const dz = oldZ - this.body.z;
    if (dx * dx + dz * dz > 9) {
      this.err.x = this.err.z = 0; // teleport-sized: snap
      this.prev.x = this.body.x;
      this.prev.z = this.body.z;
    } else {
      this.err.x += dx;
      this.err.z += dz;
    }
  }

  /** Render position between the last two predicted ticks plus decaying correction offset. */
  renderPos(alpha: number, dt: number, out: { x: number; z: number }): void {
    const k = Math.exp(-dt * 14);
    this.err.x *= k;
    this.err.z *= k;
    out.x = this.prev.x + (this.body.x - this.prev.x) * alpha + this.err.x;
    out.z = this.prev.z + (this.body.z - this.prev.z) * alpha + this.err.z;
  }
}
