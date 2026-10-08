// Client-side prediction for the local unit's walking, with server reconciliation and
// visual error smoothing. Uses the exact same stepMove() as the server.
import { TICK_DT } from '../../shared/constants.ts';
import type { MapDef } from '../../shared/maps/types.ts';
import { stepMove, type MoveBody } from '../../shared/sim/movement.ts';
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
  private rootTicks = 0;
  private initialised = false;

  constructor(map: MapDef) {
    this.world = new World(map);
  }

  /** Locally root the unit for a cast wind-up so prediction does not drift then snap back. */
  rootFor(seconds: number): void {
    this.rootTicks = Math.max(this.rootTicks, Math.ceil(seconds / TICK_DT));
  }

  /** Apply one locally generated input (one tick). */
  apply(input: PlayerInput): void {
    this.prev.x = this.body.x;
    this.prev.z = this.body.z;
    if (!this.active) return;
    const mm = this.rootTicks > 0 ? 0 : this.mm;
    if (this.rootTicks > 0) this.rootTicks--;
    this.pending.push({ input, mm });
    if (this.pending.length > 90) this.pending.shift();
    stepMove(this.world, this.river, this.body, input.mx, input.mz, mm, TICK_DT);
  }

  /** Server says where we really are; rewind and replay unacknowledged inputs. */
  reconcile(me: UnitSnap, you: YouSnap, river: RiverState, moverClock: number, moversOn: boolean): void {
    this.river = river;
    this.world.updateMovers(moverClock, moversOn);
    const controllable = me.st === UnitState.Alive || me.st === UnitState.Drowning || me.st === UnitState.Casting;
    this.mm = you.mm;
    const oldX = this.body.x;
    const oldZ = this.body.z;
    // drop acknowledged inputs
    while (this.pending.length && this.pending[0].input.seq <= you.ack) this.pending.shift();
    this.body.x = me.x;
    this.body.z = me.z;
    this.body.vx = you.vx;
    this.body.vz = you.vz;
    if (!controllable) {
      this.active = false;
      this.pending.length = 0;
      this.rootTicks = 0;
      this.prev.x = me.x;
      this.prev.z = me.z;
      this.err.x = this.err.z = 0;
      this.initialised = true;
      return;
    }
    const wasActive = this.active;
    this.active = true;
    for (const p of this.pending) stepMove(this.world, this.river, this.body, p.input.mx, p.input.mz, p.mm, TICK_DT);
    if (!this.initialised || !wasActive) {
      this.prev.x = this.body.x;
      this.prev.z = this.body.z;
      this.err.x = this.err.z = 0;
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
