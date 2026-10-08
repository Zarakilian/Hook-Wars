// Procedural animation for a Pudgy rig.
// Every frame builds a target pose (a flat array of joint offsets) from layers:
//   locomotion (idle breathing, look-around, run cycle)  or  a special-state pose
//   + held-hook arm  + one-shots (throw, grapple, bash, melee, hit, celebrate, spawn, land)
// then crossfades from the previous pose on state changes, runs springs for secondary motion
// (belly jiggle, hat wobble), applies the bot's servo stepping and writes the joints.
// Nothing here allocates per frame.
import * as THREE from 'three';
import { UFlag, UnitState } from '../../../../shared/types.ts';
import type { PudgyAnimInput, PudgyOneShot } from '../../contracts.ts';
import { VOX } from './grid.ts';
import type { PudgyUniforms } from './material.ts';
import type { RigNodes } from './rig.ts';
import type { FamilyBuild } from './types.ts';

// pose channels
const RY = 0; // rig hop (m)
const RZ = 1; // rig lunge forward (m)
const SXZ = 2; // squash width offset
const SY = 3; // squash height offset
const POP = 4; // uniform scale offset (spawn)
const YAW = 5; // core yaw
const TX = 6; // core pitch (+ = lean forward)
const TZ = 7; // core roll
const CSY = 8; // core stretch along the body axis
const HX = 9;
const HY = 10;
const HZ = 11;
const BX = 12; // torso pitch
const BY = 13; // torso twist (+ = right shoulder forward)
const BZ = 14;
const NX = 15; // head pitch (+ = look down)
const NY = 16;
const NZ = 17;
const JAW = 18;
const LSX = 19; // left shoulder (- = forward/up)
const LSY = 20;
const LSZ = 21; // + = out
const LE = 22; // left elbow (- = bend forward)
const RSX = 23;
const RSY = 24;
const RSZ = 25; // - = out
const RE = 26;
const LLX = 27; // left leg (- = forward)
const LLZ = 28;
const LLY = 29; // left foot lift (m)
const RLX = 30;
const RLZ = 31;
const RLY = 32;
const EYE = 33; // 1 = closed, negative = wide
const EX = 34;
const EY = 35;
const BELLY = 36; // belly bulge
const N = 37;
const ANGLES = [YAW, TX, TZ];

const TAU = Math.PI * 2;

type ShotKind = PudgyOneShot | 'land';
interface Shot {
  kind: ShotKind;
  t: number;
  dur: number;
  /** arm side for melee (1 = left, -1 = right), random sign for hits */
  side: number;
  active: boolean;
}

function smooth01(u: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
}

/** Keyframe track with smoothstep easing between keys. */
function kf(t: number, ts: readonly number[], vs: readonly number[]): number {
  if (t <= ts[0]) return vs[0];
  const n = ts.length;
  for (let i = 1; i < n; i++) {
    if (t < ts[i]) {
      const u = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
      return vs[i - 1] + (vs[i] - vs[i - 1]) * u * u * (3 - 2 * u);
    }
  }
  return vs[n - 1];
}

function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Cheap smooth noise in -1..1. */
function wobble(t: number, seed: number): number {
  return Math.sin(t * 1.31 + seed) * 0.6 + Math.sin(t * 2.71 + seed * 3.1) * 0.4;
}

class Spring {
  x = 0;
  v = 0;
  readonly k: number;
  readonly c: number;
  constructor(freqHz: number, damping: number) {
    const w = TAU * freqHz;
    this.k = w * w;
    this.c = 2 * damping * w;
  }
  step(target: number, dt: number, force = 0): number {
    // substep so stiff springs stay stable on long frames
    const n = Math.min(12, Math.ceil(dt * 120));
    const h = dt / Math.max(1, n);
    for (let i = 0; i < n; i++) {
      this.v += (this.k * (target - this.x) - this.c * this.v + force) * h;
      this.x += this.v * h;
    }
    if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) this.x = this.v = 0;
    return this.x;
  }
  kick(v: number): void {
    this.v += v;
  }
}

const SHOT_DUR: Record<ShotKind, number> = {
  throw: 0.55,
  grapple: 0.5,
  bash: 0.6,
  melee: 0.6,
  hit: 0.42,
  celebrate: 1.6,
  spawn: 0.62,
  land: 0.36,
};
const ACTIONS: ReadonlySet<ShotKind> = new Set<ShotKind>(['throw', 'grapple', 'bash', 'melee', 'celebrate']);
const CAST_SHOT = { hook: 'throw', grapple: 'grapple', bash: 'bash', melee: 'melee' } as const;

export class PudgyAnimator {
  private readonly n: RigNodes;
  private readonly fb: FamilyBuild;
  private readonly u: PudgyUniforms;
  private readonly seed: number;

  private readonly pose = new Float32Array(N);
  private readonly out = new Float32Array(N);
  private readonly from = new Float32Array(N);
  private readonly held = new Float32Array(N);
  private readonly servo = new Float32Array(N);
  private readonly servoV = new Float32Array(N);
  private xf = 1;
  private xfDur = 0.14;
  private servoClock = 0;
  private servoInit = false;

  private state = -1;
  private stateT = 0;
  private time = 0;

  // travel
  private hasPrev = false;
  private px = 0;
  private pz = 0;
  private pyaw = 0;
  private vx = 0;
  private vz = 0;
  /** local travel direction (unit) and speed */
  private dirX = 0;
  private dirZ = 1;
  private travel = 0;
  private yawRate = 0;
  private accel = 0;
  private lastSpeed = 0;

  // locomotion
  private phase = 0;
  private runW = 0;
  private stepIndex = 0;
  private hookW = 0;
  private lowW = 0;
  private wadeW = 0;
  private iceW = 0;

  // idle life
  private nextBlink = 1.5;
  private blinkT = -1;
  private doubleBlink = false;
  private nextLook = 2;
  private lookYaw = 0;
  private lookPitch = 0;
  private readonly headYaw = new Spring(2.2, 0.75);
  private readonly headPitch = new Spring(2.2, 0.8);

  // secondary motion
  private readonly belly = new Spring(3.2, 0.18);
  private readonly hatX = new Spring(3.4, 0.22);
  private readonly hatZ = new Spring(3.1, 0.22);
  private readonly bobX = new Spring(2.6, 0.12);
  private readonly bobZ = new Spring(2.4, 0.12);
  private holdW = 1;
  private rBusy = 0;
  private readonly swingX = new Spring(1.5, 0.1);
  private readonly swingZ = new Spring(1.4, 0.1);
  private hasHand = false;
  private readonly handPrev = new THREE.Vector3();
  private readonly handVel = new THREE.Vector3();
  private prevHop = 0;
  private hopV = 0;
  private hatSpinA = 0;

  // one-shots
  private readonly shots: Shot[] = [];
  private meleeSide = 1;
  private flash = 0;
  private exert = 0;
  private dropT = 0;
  private dropSide = 1;

  /** Optional footstep callback (foot 0 = left, 1 = right; heavy = landing or stomp). */
  onFootstep: ((foot: 0 | 1, heavy: boolean) => void) | null = null;

  constructor(nodes: RigNodes, fb: FamilyBuild, uniforms: PudgyUniforms, seed: number) {
    this.n = nodes;
    this.fb = fb;
    this.u = uniforms;
    this.seed = seed;
    for (let i = 0; i < 5; i++) this.shots.push({ kind: 'hit', t: 0, dur: 0, side: 1, active: false });
    this.nextBlink = 1 + (seed % 7) * 0.4;
    this.nextLook = 1.5 + (seed % 5) * 0.6;
    this.phase = (seed % 13) / 13;
  }

  play(kind: ShotKind): void {
    // debounce: a press-predicted shot and the server's cast event arrive close together
    for (const s of this.shots) if (s.active && s.kind === kind && s.t < 0.15 && kind !== 'hit') return;
    if (ACTIONS.has(kind)) for (const s of this.shots) if (s.active && ACTIONS.has(s.kind)) s.active = false;
    let slot = this.shots.find((s) => s.active && s.kind === kind) ?? this.shots.find((s) => !s.active);
    if (!slot) slot = this.shots[0];
    slot.kind = kind;
    slot.t = 0;
    slot.dur = SHOT_DUR[kind];
    slot.active = true;
    slot.side = 1;
    if (kind === 'melee') {
      this.meleeSide = -this.meleeSide;
      slot.side = this.hookW > 0.5 ? 1 : this.meleeSide;
    } else if (kind === 'hit') {
      slot.side = Math.random() < 0.5 ? -1 : 1;
      this.flash = 1;
      this.belly.kick(-2.2);
      this.hatX.kick(-5);
    } else if (kind === 'spawn') {
      this.xf = 1;
    }
    if (kind === 'throw' || kind === 'bash' || kind === 'grapple') this.exert = 1;
  }

  private shotActive(kind: ShotKind): boolean {
    for (const s of this.shots) if (s.active && s.kind === kind) return true;
    return false;
  }

  update(dt: number, a: PudgyAnimInput, root: THREE.Object3D): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;
    const t = this.time;
    const p = this.pose;
    const fb = this.fb;
    const st = fb.style;

    this.trackTravel(dt, root);

    // state changes: crossfade from the pose we were showing
    if (a.state !== this.state) {
      const prev = this.state;
      this.from.set(this.out);
      for (const c of ANGLES) this.from[c] = wrapAngle(this.from[c]);
      this.xf = prev < 0 ? 1 : 0;
      this.xfDur = a.state === UnitState.Knocked || a.state === UnitState.Hooked ? 0.08 : 0.16;
      if ((prev === UnitState.Knocked || prev === UnitState.Grappling || prev === UnitState.Hooked) && a.state === UnitState.Alive) {
        this.play('land');
        this.onFootstep?.(0, true);
      }
      if (a.state === UnitState.Hooked && a.hpFrac > 0) {
        this.belly.kick(-3);
        this.flash = Math.max(this.flash, 0.6);
      }
      this.state = a.state;
      this.stateT = 0;
    } else this.stateT += dt;

    if (a.state === UnitState.Dead) return; // hidden by the game client

    // auto-start a wind-up if the cast arrived without play()
    if (a.state === UnitState.Casting && a.castKind) {
      const k = CAST_SHOT[a.castKind];
      if (!this.shotActive(k) && this.stateT < 0.05) this.play(k);
    }

    p.fill(0);
    const special = a.state === UnitState.Hooked || a.state === UnitState.Knocked || a.state === UnitState.Grappling || a.state === UnitState.Drowning;
    this.hookW += ((a.hookOut && !special ? 1 : 0) - this.hookW) * (1 - Math.exp(-dt * 14));
    this.lowW += ((a.hpFrac > 0 && a.hpFrac < 0.3 ? 1 : 0) - this.lowW) * (1 - Math.exp(-dt * 3));
    this.wadeW += ((a.flags & UFlag.Shallow ? 1 : 0) - this.wadeW) * (1 - Math.exp(-dt * 6));
    this.iceW += ((a.flags & UFlag.OnIce ? 1 : 0) - this.iceW) * (1 - Math.exp(-dt * 6));

    if (a.state === UnitState.Hooked) {
      if (a.hpFrac <= 0) this.poseCorpse(t);
      else this.poseHooked(t);
    } else if (a.state === UnitState.Knocked) this.poseKnocked(t);
    else if (a.state === UnitState.Grappling) this.poseGrapple(t);
    else if (a.state === UnitState.Drowning) this.poseDrown(t);
    else this.poseLocomotion(dt, a, t);

    this.idleLife(dt, t, special, a.state === UnitState.Hooked && a.hpFrac <= 0);
    if (this.hookW > 0.001) this.poseHookOut(t);
    this.runShots(dt, t);

    // crossfade
    const out = this.out;
    if (this.xf < 1) {
      this.xf = Math.min(1, this.xf + dt / this.xfDur);
      const e = smooth01(this.xf);
      for (let i = 0; i < N; i++) out[i] = this.from[i] + (p[i] - this.from[i]) * e;
      for (const c of ANGLES) out[c] = this.from[c] + wrapAngle(p[c] - this.from[c]) * e;
    } else out.set(p);

    if (st.kind === 'servo') this.applyServo(dt);
    this.glow(dt, a, t);
    this.apply(dt, a, t);
  }

  // ------------------------------------------------------------------------------------------
  // Travel tracking: direction of motion in the model's local frame, turn rate, acceleration
  // ------------------------------------------------------------------------------------------

  private trackTravel(dt: number, root: THREE.Object3D): void {
    const x = root.position.x;
    const z = root.position.z;
    const yaw = root.rotation.y;
    if (!this.hasPrev || dt <= 0) {
      this.hasPrev = true;
      this.px = x;
      this.pz = z;
      this.pyaw = yaw;
      return;
    }
    let vx = (x - this.px) / dt;
    let vz = (z - this.pz) / dt;
    if (vx * vx + vz * vz > 60 * 60) vx = vz = 0; // teleport / respawn
    const k = 1 - Math.exp(-dt * 14);
    this.vx += (vx - this.vx) * k;
    this.vz += (vz - this.vz) * k;
    const yr = wrapAngle(yaw - this.pyaw) / dt;
    this.yawRate += (Math.max(-12, Math.min(12, yr)) - this.yawRate) * (1 - Math.exp(-dt * 10));
    this.px = x;
    this.pz = z;
    this.pyaw = yaw;
    const sp = Math.hypot(this.vx, this.vz);
    this.travel = sp;
    if (sp > 0.6) {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      // world -> local (inverse yaw)
      const lx = (this.vx * c - this.vz * s) / sp;
      const lz = (this.vx * s + this.vz * c) / sp;
      const kk = 1 - Math.exp(-dt * 10);
      this.dirX += (lx - this.dirX) * kk;
      this.dirZ += (lz - this.dirZ) * kk;
      const l = Math.hypot(this.dirX, this.dirZ) || 1;
      this.dirX /= l;
      this.dirZ /= l;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------------------------------------

  private poseLocomotion(dt: number, a: PudgyAnimInput, t: number): void {
    const p = this.pose;
    const st = this.fb.style;
    const speed = a.state === UnitState.Casting ? 0 : a.speed;
    const target = smooth01((speed - 0.35) / 3.2);
    this.runW += (target - this.runW) * (1 - Math.exp(-dt * 9));
    const w = this.runW;
    // acceleration lean
    const acc = (speed - this.lastSpeed) / Math.max(dt, 1e-3);
    this.lastSpeed = speed;
    this.accel += (Math.max(-40, Math.min(40, acc)) - this.accel) * (1 - Math.exp(-dt * 8));

    const wade = this.wadeW;
    const stride = st.stride * (1 - wade * 0.35);
    const cyc = speed / stride;
    this.phase = (this.phase + dt * Math.max(cyc, w * 0.6)) % 1;
    const ph = this.phase * TAU;
    const s = Math.sin(ph);
    const c = Math.cos(ph);

    // footsteps on contact (legs spread)
    const idx = Math.floor(this.phase * 2 + 0.25);
    if (idx !== this.stepIndex) {
      this.stepIndex = idx;
      if (w > 0.35) {
        this.onFootstep?.(idx % 2 === 0 ? 0 : 1, st.kind === 'stomp');
        this.belly.kick(-st.stomp * 1.4 * w);
        this.hatX.kick(-st.stomp * 1.2 * w);
        if (st.kind === 'servo') this.exert = Math.max(this.exert, 0.35);
      }
    }

    const swing = st.legSwing * w * (1 - wade * 0.3);
    p[LLX] = -s * swing;
    p[RLX] = s * swing;
    const lift = (st.kind === 'stomp' ? 0.12 : 0.09) * w * (1 + wade * 0.5);
    p[LLY] = Math.max(0, c) * lift;
    p[RLY] = Math.max(0, -c) * lift;
    // body hop: high when the legs pass, low at contact
    const hopShape = st.kind === 'stomp' ? Math.pow(c * c, 0.6) : c * c;
    p[RY] = st.bounce * w * hopShape * (1 - wade * 0.4);
    p[SY] = (0.06 * hopShape - st.stomp * 0.11 * s * s) * w;
    p[SXZ] = (-0.03 * hopShape + st.stomp * 0.07 * s * s) * w;
    // arms swing against the legs
    const arm = st.armSwing * w;
    p[LSX] = s * arm;
    p[RSX] = -s * arm * (1 - 0.55 * this.holdW);
    p[LE] = -0.25 * w - Math.max(0, -s) * 0.35 * w;
    p[RE] = -0.25 * w - Math.max(0, s) * 0.35 * w;
    // waddle, twist and swagger
    p[HZ] = s * st.roll * w;
    p[HY] = -s * 0.08 * w;
    p[BY] = s * 0.12 * w;
    p[BZ] = -s * st.sway * w;
    if (st.kind === 'swagger') {
      p[LSZ] += 0.12 * w;
      p[RSZ] -= 0.12 * w;
      p[BX] -= 0.06 * w; // chest out
      p[NZ] = s * 0.06 * w;
    } else if (st.kind === 'stomp') {
      p[BX] += 0.12 * w;
      p[LSZ] += 0.18 * w;
      p[RSZ] -= 0.18 * w;
      p[NX] += s * s * 0.1 * w;
    }
    // lean into speed, acceleration and turns
    const haste = a.flags & UFlag.Haste ? 0.08 : 0;
    p[TX] = (st.lean + haste) * w + Math.max(-0.12, Math.min(0.14, this.accel * 0.004));
    p[TZ] = Math.max(-0.22, Math.min(0.22, -this.yawRate * 0.035 * (0.3 + w)));
    p[NX] -= p[TX] * 0.5;
    p[NY] += Math.max(-0.4, Math.min(0.4, this.yawRate * 0.05)); // head leads the turn

    // wading: arms up out of the water, high steps
    if (wade > 0.01) {
      p[LSZ] += 0.55 * wade;
      p[RSZ] -= 0.55 * wade;
      p[LSX] += -0.35 * wade;
      p[RSX] += -0.35 * wade;
      p[LE] += -0.7 * wade;
      p[RE] += -0.7 * wade;
      p[RY] += Math.sin(t * 3.1) * 0.02 * wade;
    }
    // ice: arms out, wobbly balance
    if (this.iceW > 0.01) {
      const k = this.iceW;
      p[LSZ] += 0.75 * k;
      p[RSZ] -= 0.75 * k;
      p[TZ] += wobble(t * 2.2, this.seed) * 0.12 * k * (0.4 + w);
      p[LSX] += Math.sin(t * 5.3) * 0.3 * k;
      p[RSX] += Math.sin(t * 4.7 + 1) * 0.3 * k;
    }
    // burning: hot-foot hops and flapping
    if (a.flags & UFlag.Burning) {
      p[RY] += Math.abs(Math.sin(t * 15)) * 0.07;
      p[LSZ] += 0.6 + Math.sin(t * 22) * 0.4;
      p[RSZ] -= 0.6 + Math.sin(t * 22 + 1) * 0.4;
      p[JAW] += 0.4;
      p[EYE] -= 0.3;
    }
    // low HP: woozy wobble, droopy head
    if (this.lowW > 0.01) {
      const k = this.lowW;
      p[TZ] += wobble(t * 1.6, this.seed + 4) * 0.07 * k;
      p[NX] += 0.12 * k;
      p[NZ] += Math.sin(t * 1.9) * 0.08 * k;
    }
    // idle breathing and weight shifts (fade out while running)
    const idle = 1 - w;
    const rate = st.breath * (1 + this.lowW * 0.9);
    const br = Math.sin(t * TAU * rate);
    const deep = 1 + this.lowW * 0.8;
    p[SY] += 0.012 * br * deep * idle;
    p[BELLY] += 0.035 * br * deep * idle;
    p[BX] += -0.025 * br * idle;
    p[LSZ] += 0.04 * br * idle;
    p[RSZ] -= 0.04 * br * idle;
    p[NX] += 0.02 * br * idle;
    p[HZ] += Math.sin(t * 0.55 + this.seed) * 0.035 * idle;
    p[RZ] += 0;
    if (st.kind === 'stomp') p[BX] += 0.05 * idle; // hunched
    if (st.kind === 'swagger') {
      // thumbs-in-belt swagger at rest: elbows out
      p[LE] += -0.2 * idle;
      p[RE] += -0.2 * idle;
    }
  }

  /** Blinking and look-around: runs in every state, attenuated when busy. */
  private idleLife(dt: number, t: number, special: boolean, dead: boolean): void {
    const p = this.pose;
    if (dead) {
      p[EYE] = 1;
      return;
    }
    // blink
    if (t >= this.nextBlink) {
      this.blinkT = 0;
      this.nextBlink = t + 1.8 + Math.random() * 3.4;
      if (this.doubleBlink) this.doubleBlink = false;
      else if (Math.random() < 0.25) {
        this.doubleBlink = true;
        this.nextBlink = t + 0.22;
      }
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const b = this.blinkT / 0.13;
      if (b >= 1) this.blinkT = -1;
      else p[EYE] = Math.max(p[EYE], Math.sin(b * Math.PI));
    }
    if (special) return;
    // look around (mostly at rest)
    const calm = (1 - this.runW) * (1 - this.hookW);
    if (t >= this.nextLook) {
      const servo = this.fb.style.kind === 'servo';
      this.nextLook = t + (servo ? 1.2 : 1.8) + Math.random() * 3;
      const r = Math.random();
      this.lookYaw = r < 0.3 ? 0 : (Math.random() - 0.5) * 1.3;
      this.lookPitch = (Math.random() - 0.4) * 0.3;
    }
    const yaw = this.headYaw.step(this.lookYaw * calm, dt);
    const pitch = this.headPitch.step(this.lookPitch * calm, dt);
    p[NY] += yaw;
    p[NX] += pitch;
    p[EX] += Math.max(-1, Math.min(1, this.lookYaw * calm * 1.4));
    p[EY] += -this.lookPitch * calm * 2;
  }

  private poseHookOut(t: number): void {
    const p = this.pose;
    const w = this.hookW;
    const mixTo = (c: number, v: number) => {
      p[c] += (v - p[c]) * w;
    };
    mixTo(RSX, -1.16 + Math.sin(t * 31) * 0.02);
    mixTo(RSY, 0);
    mixTo(RSZ, 0.3);
    mixTo(RE, 0.05);
    p[BY] += 0.28 * w;
    p[LSX] += 0.3 * w;
    p[LSZ] += 0.22 * w;
    p[LE] += -0.4 * w;
    p[NY] -= 0.15 * w;
  }

  private poseHooked(t: number): void {
    const p = this.pose;
    p[YAW] = Math.atan2(this.dirX, this.dirZ);
    p[TX] = -0.32 + Math.sin(t * 9) * 0.05;
    p[TZ] = Math.sin(t * 7.3) * 0.12;
    p[CSY] = 0.07;
    p[BX] = -0.42;
    p[BELLY] = 0.18;
    p[LLX] = 0.75 + Math.sin(t * 16) * 0.45;
    p[RLX] = 0.75 - Math.sin(t * 16) * 0.45;
    p[LLZ] = 0.25;
    p[RLZ] = -0.25;
    p[LSX] = -2.3 + Math.sin(t * 13) * 0.6;
    p[LSZ] = 0.55 + Math.sin(t * 10.7) * 0.3;
    p[LE] = -0.6 + Math.sin(t * 17) * 0.4;
    p[RSX] = -2.1 + Math.sin(t * 13 + 2) * 0.6;
    p[RSZ] = -0.55 - Math.sin(t * 9.1) * 0.3;
    p[RE] = -0.6 + Math.sin(t * 15 + 1) * 0.4;
    p[NX] = -0.45;
    p[NZ] = Math.sin(t * 8) * 0.15;
    p[JAW] = 0.7 + Math.sin(t * 23) * 0.2;
    p[EYE] = -0.45;
  }

  private poseCorpse(t: number): void {
    const p = this.pose;
    p[YAW] = Math.atan2(this.dirX, this.dirZ);
    p[TX] = -1.32;
    p[TZ] = Math.sin(t * 13) * 0.05;
    // lying on its back: drop the belly centre to about half the body depth above the ground
    p[RY] = 0.52 - this.fb.sk.core * VOX * this.fb.scale + Math.abs(Math.sin(t * 15)) * 0.03;
    p[LSX] = -0.5;
    p[RSX] = -0.5;
    p[LSZ] = 1.2;
    p[RSZ] = -1.2;
    p[LE] = -0.3;
    p[RE] = -0.3;
    p[LLX] = -0.25;
    p[RLX] = -0.15;
    p[LLZ] = 0.3;
    p[RLZ] = -0.3;
    p[NX] = -0.45;
    p[NZ] = 0.5;
    p[JAW] = 0.5;
    p[EYE] = 1;
  }

  private poseKnocked(t: number): void {
    const p = this.pose;
    const th = this.stateT;
    p[YAW] = Math.atan2(-this.dirX, -this.dirZ);
    const spin = smooth01(th / 0.42);
    p[TX] = -TAU * spin - Math.max(0, th - 0.42) * 7;
    p[CSY] = 0.1 * Math.sin(Math.PI * spin);
    p[LSZ] = 1.5 + Math.sin(t * 21) * 0.3;
    p[RSZ] = -1.5 - Math.sin(t * 19) * 0.3;
    p[LSX] = -0.8 + Math.sin(t * 17) * 0.5;
    p[RSX] = -0.8 - Math.sin(t * 17) * 0.5;
    p[LE] = -0.4;
    p[RE] = -0.4;
    p[LLZ] = 0.45;
    p[RLZ] = -0.45;
    p[LLX] = Math.sin(t * 20) * 0.6;
    p[RLX] = -Math.sin(t * 20) * 0.6;
    p[JAW] = 0.7;
    p[EYE] = 1;
    p[NX] = 0.3;
  }

  private poseGrapple(t: number): void {
    const p = this.pose;
    p[YAW] = Math.atan2(this.dirX, this.dirZ);
    p[TX] = 1.18 + Math.sin(t * 6) * 0.04;
    p[TZ] = Math.sin(t * 4) * 0.08;
    p[CSY] = 0.12;
    p[RSX] = -2.95;
    p[RSZ] = 0.1;
    p[RE] = 0;
    p[LSX] = 0.35;
    p[LSZ] = 0.3;
    p[LE] = -0.25;
    p[LLX] = 0.25;
    p[RLX] = 0.4 + Math.sin(t * 9) * 0.08;
    p[LLZ] = 0.05;
    p[RLZ] = -0.05;
    p[NX] = -0.85;
    p[JAW] = 0.25;
    p[EYE] = -0.2;
    p[BELLY] = -0.05;
  }

  private poseDrown(t: number): void {
    const p = this.pose;
    const th = this.stateT;
    const panic = 1 + Math.min(1, th / 2) * 0.6;
    const f = 9 * panic;
    p[RSX] = -2.5 + Math.sin(t * f) * 0.65;
    p[LSX] = -2.5 + Math.sin(t * f + Math.PI) * 0.65;
    p[RSZ] = -0.55 - Math.sin(t * f * 0.5) * 0.25;
    p[LSZ] = 0.55 + Math.sin(t * f * 0.5 + 1) * 0.25;
    p[RE] = -0.6 + Math.sin(t * f + 1) * 0.5;
    p[LE] = -0.6 + Math.sin(t * f + 1 + Math.PI) * 0.5;
    p[BX] = -0.22;
    p[NX] = -0.55 + Math.sin(t * 7) * 0.15;
    p[NZ] = Math.sin(t * 5.3) * 0.12;
    p[JAW] = 0.45 + Math.sin(t * 11) * 0.35;
    p[RY] = Math.sin(t * 6) * 0.08 + Math.sin(t * 2.3) * 0.04;
    p[TZ] = Math.sin(t * 3.3) * 0.14;
    p[TX] = -0.08 + Math.sin(t * 2.7) * 0.06;
    p[LLX] = Math.sin(t * 12) * 0.5;
    p[RLX] = -Math.sin(t * 12) * 0.5;
    p[EYE] = -0.5;
    p[BELLY] = 0.05;
  }

  // ------------------------------------------------------------------------------------------
  // One-shots
  // ------------------------------------------------------------------------------------------

  private runShots(dt: number, t: number): void {
    this.rBusy = 0;
    for (const s of this.shots) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t >= s.dur) {
        s.active = false;
        continue;
      }
      this.shot(s, t);
    }
  }

  private shot(s: Shot, time: number): void {
    const p = this.pose;
    const t = s.t;
    const dur = s.dur;
    // envelope: in fast, out over the tail
    const w = Math.min(1, t / 0.035) * (1 - smooth01((t - (dur - 0.16)) / 0.16));
    const ov = (c: number, v: number) => {
      p[c] += (v - p[c]) * w;
    };
    const ad = (c: number, v: number) => {
      p[c] += v * w;
    };
    if (s.kind !== 'hit' && s.kind !== 'land' && !(s.kind === 'melee' && s.side > 0)) this.rBusy = Math.max(this.rBusy, w);
    switch (s.kind) {
      case 'throw': {
        // side-arm whip: wind back (0.1 s), release (0.12-0.16 s), follow through
        const T = [0, 0.1, 0.16, 0.3, 0.55];
        ov(RSX, kf(t, T, [0.2, 1.0, -1.7, -1.25, -1.16]));
        ov(RSZ, kf(t, T, [-0.3, -1.0, -0.2, 0.25, 0.3]));
        ov(RSY, kf(t, T, [0, 0.5, -0.2, 0, 0]));
        ov(RE, kf(t, T, [-0.4, -1.7, 0.05, 0.05, 0.05]));
        ad(BY, kf(t, T, [0, -0.6, 0.5, 0.35, 0]));
        ad(TX, kf(t, T, [0, -0.13, 0.24, 0.1, 0]));
        ad(SY, kf(t, T, [0, -0.1, 0.13, 0.01, 0]));
        ad(SXZ, kf(t, T, [0, 0.06, -0.06, 0, 0]));
        ad(LSX, kf(t, T, [0, -0.7, 0.6, 0.3, 0]));
        ad(LSZ, kf(t, T, [0, 0.4, 0.2, 0.1, 0]));
        ad(JAW, kf(t, T, [0, 0.1, 0.65, 0.2, 0]));
        ad(NY, kf(t, T, [0, 0.35, -0.25, -0.1, 0]));
        ad(EYE, kf(t, T, [0, 0.55, -0.2, 0, 0]));
        ad(RZ, kf(t, T, [0, -0.05, 0.08, 0.03, 0]));
        break;
      }
      case 'grapple': {
        // overhead lob
        const T = [0, 0.09, 0.15, 0.3, 0.5];
        ov(RSX, kf(t, T, [0, 0.8, -2.9, -2.4, -2.0]));
        ov(RSZ, kf(t, T, [0, -0.4, -0.1, 0, 0]));
        ov(RE, kf(t, T, [-0.2, -1.5, -0.1, -0.2, -0.3]));
        ad(SY, kf(t, T, [0, -0.15, 0.16, 0.05, 0]));
        ad(SXZ, kf(t, T, [0, 0.08, -0.06, 0, 0]));
        ad(RY, kf(t, T, [0, -0.04, 0.1, 0.03, 0]));
        ad(TX, kf(t, T, [0, -0.15, 0.18, 0.1, 0]));
        ad(LSX, kf(t, T, [0, -0.4, 0.5, 0.3, 0]));
        ad(JAW, kf(t, T, [0, 0.1, 0.55, 0.3, 0]));
        ad(NX, kf(t, T, [0, 0.1, -0.35, -0.2, 0]));
        break;
      }
      case 'bash': {
        // belly thrust lunge
        const T = [0, 0.11, 0.17, 0.32, 0.6];
        ad(TX, kf(t, T, [0, -0.24, 0.4, 0.25, 0]));
        ad(RZ, kf(t, T, [0, -0.1, 0.42, 0.32, 0]));
        ad(SY, kf(t, T, [0, -0.15, 0.08, 0.02, 0]));
        ad(SXZ, kf(t, T, [0, 0.1, -0.03, 0, 0]));
        ad(BELLY, kf(t, T, [0, -0.08, 0.5, 0.3, 0]));
        ad(BX, kf(t, T, [0, -0.12, -0.3, -0.18, 0]));
        ov(RSX, kf(t, T, [0, 0.5, 1.0, 0.7, 0]));
        ov(LSX, kf(t, T, [0, 0.5, 1.0, 0.7, 0]));
        ov(RSZ, kf(t, T, [0, -0.3, -1.1, -0.8, 0]));
        ov(LSZ, kf(t, T, [0, 0.3, 1.1, 0.8, 0]));
        ad(LLX, kf(t, T, [0, 0, -0.35, -0.2, 0]));
        ad(RLX, kf(t, T, [0, 0, 0.35, 0.2, 0]));
        ad(JAW, kf(t, T, [0, 0, 0.75, 0.4, 0]));
        ad(EYE, kf(t, T, [0, 0.6, -0.35, 0, 0]));
        ad(NX, kf(t, T, [0, 0.1, -0.3, -0.1, 0]));
        if (t > 0.15 && t - 0.017 <= 0.15) this.belly.kick(4);
        break;
      }
      case 'melee': {
        // overhead wallop with one hand
        const T = [0, 0.18, 0.25, 0.38, 0.6];
        const side = s.side;
        const sx = side > 0 ? LSX : RSX;
        const sz = side > 0 ? LSZ : RSZ;
        const el = side > 0 ? LE : RE;
        ov(sx, kf(t, T, [0, -2.9, -0.85, -1.0, 0]));
        ov(el, kf(t, T, [-0.3, -1.6, -0.15, -0.3, 0]));
        ov(sz, kf(t, T, [0, 0.25 * side, 0.05 * side, 0, 0]));
        ad(TX, kf(t, T, [0, -0.15, 0.26, 0.15, 0]));
        ad(SY, kf(t, T, [0, 0.08, -0.13, 0, 0]));
        ad(SXZ, kf(t, T, [0, -0.03, 0.08, 0, 0]));
        ad(BY, kf(t, T, [0, 0.2 * side, -0.35 * side, -0.2 * side, 0]));
        ad(JAW, kf(t, T, [0, 0.25, 0.55, 0.2, 0]));
        ad(EYE, kf(t, T, [0, -0.2, 0.6, 0, 0]));
        if (t > 0.25 && t - 0.017 <= 0.25) {
          this.belly.kick(-2.5);
          this.hatX.kick(4);
        }
        break;
      }
      case 'hit': {
        const T = [0, 0.05, 0.16, 0.42];
        const sg = s.side;
        ad(NX, kf(t, T, [0, -0.5, 0.1, 0]));
        ad(NZ, kf(t, T, [0, 0.28 * sg, -0.06 * sg, 0]));
        ad(BX, kf(t, T, [0, -0.26, 0.05, 0]));
        ad(BY, kf(t, T, [0, 0.2 * sg, -0.05 * sg, 0]));
        ad(TX, kf(t, T, [0, -0.12, 0.03, 0]));
        ad(SY, kf(t, T, [0, -0.13, 0.05, 0]));
        ad(SXZ, kf(t, T, [0, 0.09, -0.02, 0]));
        ad(LSX, kf(t, T, [0, -0.6, 0, 0]));
        ad(RSX, kf(t, T, [0, -0.5, 0, 0]));
        ad(LSZ, kf(t, T, [0, 0.45, 0, 0]));
        ad(RSZ, kf(t, T, [0, -0.45, 0, 0]));
        ad(EYE, kf(t, T, [0, 1.2, 0.4, 0]));
        ad(JAW, kf(t, T, [0, 0.55, 0.2, 0]));
        break;
      }
      case 'spawn': {
        const T = [0, 0.14, 0.28, 0.42, 0.62];
        // full override of scale and spin, independent of the envelope fade-in
        p[POP] += kf(t, T, [-0.9, 0.24, -0.08, 0.03, 0]);
        p[YAW] += kf(t, [0, 0.3, 0.62], [-Math.PI, 0.15, 0]);
        ad(LSX, kf(t, T, [-2.2, -2.5, -1.2, -0.3, 0]));
        ad(RSX, kf(t, T, [-2.2, -2.5, -1.2, -0.3, 0]));
        ad(LSZ, kf(t, T, [0.6, 0.5, 0.2, 0, 0]));
        ad(RSZ, kf(t, T, [-0.6, -0.5, -0.2, 0, 0]));
        ad(JAW, kf(t, T, [0.3, 0.6, 0.3, 0.1, 0]));
        ad(EYE, kf(t, T, [0.8, -0.3, 0, 0, 0]));
        if (t > 0.14 && t - 0.017 <= 0.14) {
          this.belly.kick(3);
          this.hatX.kick(-6);
        }
        break;
      }
      case 'land': {
        const T = [0, 0.06, 0.18, 0.36];
        ad(SY, kf(t, T, [0, -0.22, 0.06, 0]));
        ad(SXZ, kf(t, T, [0, 0.14, -0.03, 0]));
        ad(LSZ, kf(t, T, [0, 0.5, 0.1, 0]));
        ad(RSZ, kf(t, T, [0, -0.5, -0.1, 0]));
        ad(NX, kf(t, T, [0, 0.2, -0.05, 0]));
        ad(EYE, kf(t, T, [0, 0.8, 0, 0]));
        if (t < 0.02) {
          this.belly.kick(-3);
          this.hatX.kick(6);
        }
        break;
      }
      case 'celebrate':
        this.celebrate(t, time, w);
        break;
    }
  }

  private celebrate(t: number, time: number, w: number): void {
    const p = this.pose;
    const ov = (c: number, v: number) => {
      p[c] += (v - p[c]) * w;
    };
    const ad = (c: number, v: number) => {
      p[c] += v * w;
    };
    const kind = this.fb.style.kind;
    if (kind === 'swagger') {
      // belly drum
      const d = Math.sin(t * 15);
      ov(LSX, -0.55 + d * 0.35);
      ov(RSX, -0.55 - d * 0.35);
      ov(LE, -1.5);
      ov(RE, -1.5);
      ov(LSZ, 0.1);
      ov(RSZ, -0.1);
      ad(RY, Math.max(0, Math.sin(t * Math.PI * 2.4)) * 0.12);
      ad(NX, -0.38);
      ad(JAW, 0.35 + Math.sin(t * 21) * 0.3);
      ad(EYE, 0.75);
      ad(BX, -0.1);
      if (Math.abs(d) > 0.97) this.belly.kick(0.6 * w);
    } else if (kind === 'stomp') {
      // chest pound and roar
      const d = Math.sin(t * 12);
      ov(LSX, -1.35 + d * 0.4);
      ov(RSX, -1.35 - d * 0.4);
      ov(LE, -2.0);
      ov(RE, -2.0);
      ov(LSZ, -0.25);
      ov(RSZ, 0.25);
      ad(NX, -0.55);
      ad(JAW, 0.9);
      ad(BX, -0.12);
      ad(SY, Math.max(0, Math.sin(t * 6)) * 0.05);
      ad(RY, Math.max(0, Math.sin(t * Math.PI * 1.6)) * 0.08);
      if (Math.abs(d) > 0.97) this.belly.kick(0.5 * w);
    } else {
      // fist pump with a steam burst
      const pump = Math.max(0, Math.sin(t * 10));
      ov(RSX, -2.9 + pump * 0.25);
      ov(RE, -0.2 - pump * 0.7);
      ov(RSZ, -0.15);
      ov(LSX, 0.3);
      ov(LSZ, 0.45);
      ad(RY, Math.max(0, Math.sin(t * Math.PI * 2)) * 0.1);
      ad(NX, -0.3);
      ad(NY, Math.sin(time * 9) * 0.2);
      this.exert = Math.max(this.exert, 0.8 * w);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Bot servo: joints step at ~16 Hz and snap to each new target with a little overshoot
  // ------------------------------------------------------------------------------------------

  private applyServo(dt: number): void {
    const out = this.out;
    this.servoClock += dt;
    const step = this.servoClock >= 1 / 16;
    if (step) this.servoClock = 0;
    const k = 1400;
    const c = 2 * 0.45 * Math.sqrt(k);
    if (!this.servoInit) {
      this.servoInit = true;
      for (const ch of SERVO_CHANNELS) this.servo[ch] = this.held[ch] = out[ch];
    }
    const n = Math.min(16, Math.ceil(dt * 240));
    const h = dt / Math.max(1, n);
    for (const ch of SERVO_CHANNELS) {
      if (step) this.held[ch] = out[ch];
      let x = this.servo[ch];
      let v = this.servoV[ch];
      for (let i = 0; i < n; i++) {
        v += (k * (this.held[ch] - x) - c * v) * h;
        x += v * h;
      }
      if (!Number.isFinite(x) || !Number.isFinite(v)) {
        x = out[ch];
        v = 0;
      }
      this.servo[ch] = x;
      this.servoV[ch] = v;
      out[ch] = x;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Emissive pulses and flashes
  // ------------------------------------------------------------------------------------------

  private glow(dt: number, a: PudgyAnimInput, t: number): void {
    const u = this.u;
    this.flash = Math.max(0, this.flash - dt / 0.13);
    this.exert = Math.max(0, this.exert - dt * 1.6);
    let flash = this.flash * this.flash;
    const fc = u.uFlashColor.value;
    fc.setRGB(1, 0.95, 0.85);
    if (a.flags & UFlag.Burning) {
      const b = 0.22 + 0.12 * Math.abs(wobble(t * 9, this.seed));
      if (b > flash) {
        flash = b;
        fc.setRGB(1, 0.42, 0.1);
      }
    } else if (a.flags & UFlag.SpawnProt) {
      const sp = 0.12 + 0.1 * Math.sin(t * 9);
      if (sp > flash) {
        flash = sp;
        fc.copy(u.uRimColor.value);
      }
    }
    u.uFlash.value = flash * 0.75;
    const eye = this.out[EYE];
    if (this.fb.style.kind === 'servo') {
      // visor: steady hum, dims when "blinking", flickers on hits
      const flick = this.flash > 0.2 ? (Math.sin(t * 90) > 0 ? 0.3 : 1) : 1;
      u.uGlowA.value = (2.3 + Math.sin(t * 2.4) * 0.35) * (1 - Math.max(0, eye) * 0.6) * flick * (a.hpFrac <= 0 ? 0.15 : 1);
      // steam vents: idle pulse plus exertion bursts
      u.uGlowB.value = 0.7 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin(t * 1.7 + this.seed), 3) + this.exert * 2.4;
    } else {
      u.uGlowA.value = 2.2 + Math.sin(t * 3.1) * 0.25;
      u.uGlowB.value = 1.1 + 0.6 * (0.5 + 0.5 * Math.sin(t * 1.3 + this.seed)) + this.exert * 0.5;
    }
  }

  /** Rope-hung hook: keep it hanging straight down from the fist and let it swing. */
  private dangle(dt: number): void {
    const n = this.n;
    const root = n.rig.parent;
    n.elR.updateWorldMatrix(true, false);
    n.handR.updateWorldMatrix(false, false);
    n.handR.getWorldPosition(_v);
    if (!this.hasHand || dt <= 0) {
      this.handPrev.copy(_v);
      this.handVel.set(0, 0, 0);
      this.hasHand = true;
    }
    const vx = dt > 0 ? (_v.x - this.handPrev.x) / dt : 0;
    const vy = dt > 0 ? (_v.y - this.handPrev.y) / dt : 0;
    const vz = dt > 0 ? (_v.z - this.handPrev.z) / dt : 0;
    const ax = Math.max(-60, Math.min(60, dt > 0 ? (vx - this.handVel.x) / dt : 0));
    const az = Math.max(-60, Math.min(60, dt > 0 ? (vz - this.handVel.z) / dt : 0));
    void vy;
    this.handVel.set(vx, vy, vz);
    this.handPrev.copy(_v);
    const yaw = root ? root.rotation.y : 0;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // acceleration in the unit's local frame
    const lx = ax * c - az * s;
    const lz = ax * s + az * c;
    const sx = Math.max(-1.1, Math.min(1.1, this.swingX.step(0, dt, lz * 1.6)));
    const sz = Math.max(-1.1, Math.min(1.1, this.swingZ.step(0, dt, -lx * 1.6)));
    n.elR.getWorldQuaternion(_q0);
    _e.set(sx, yaw, sz, 'YXZ');
    _q1.setFromEuler(_e);
    n.handR.quaternion.copy(_q0.invert().multiply(_q1));
  }

  // ------------------------------------------------------------------------------------------
  // Apply pose + secondary motion to the joints
  // ------------------------------------------------------------------------------------------

  private apply(dt: number, a: PudgyAnimInput, t: number): void {
    const o = this.out;
    const n = this.n;
    const fb = this.fb;
    const r = fb.rest;
    const sc = fb.scale;

    // vertical acceleration of the hop drives jiggle
    const hv = dt > 0 ? (o[RY] - this.prevHop) / dt : 0;
    const ay = dt > 0 ? (hv - this.hopV) / dt : 0;
    this.prevHop = o[RY];
    this.hopV = hv;
    const ayc = Math.max(-80, Math.min(80, ay));
    const jig = Math.max(-0.12, Math.min(0.12, this.belly.step(0, dt, -ayc * 0.012)));
    const hx = this.hatX.step(-o[NX] * 0.15, dt, -ayc * 0.05 - this.accel * 0.3);
    const hz = this.hatZ.step(-o[NZ] * 0.15, dt, this.yawRate * 6);

    const pop = 1 + o[POP];
    n.rig.position.set(0, o[RY], o[RZ]);
    n.rig.scale.set(sc * pop * (1 + o[SXZ]), sc * pop * (1 + o[SY]), sc * pop * (1 + o[SXZ]));
    n.rig.visible = pop > 0.02;

    n.core.rotation.set(o[TX], o[YAW], o[TZ]);
    const cs = o[CSY];
    n.core.scale.set(1 - cs * 0.45, 1 + cs, 1 - cs * 0.45);

    n.hips.rotation.set(o[HX], o[HY], o[HZ]);
    n.torso.rotation.set(o[BX] + r.hunch, o[BY], o[BZ]);
    const bel = o[BELLY];
    n.body.scale.set(1 + bel * 0.25 + jig * 0.6, 1 - jig + bel * 0.05, 1 + bel * 0.55 + jig * 0.6);

    n.neck.rotation.set(o[NX] + r.headPitch, o[NY], o[NZ]);
    if (n.jaw) n.jaw.rotation.x = Math.max(0, Math.min(1.1, o[JAW])) * 0.55 + r.jawRest;
    if (n.eyes) {
      const e = o[EYE];
      const sy = e >= 0 ? Math.max(0.1, 1 - e * 0.92) : 1 - e * 0.35;
      n.eyes.scale.set(e < 0 ? 1 - e * 0.2 : 1, sy, 1);
      n.eyes.position.set(n.base.eyes.x + o[EX] * 0.022, n.base.eyes.y + o[EY] * 0.016, n.base.eyes.z);
    }
    n.hat.rotation.set(hx, 0, hz);

    if (n.hatExtra) {
      if (fb.hatMode === 'spin') {
        this.hatSpinA += dt * fb.hatSpin * (1 + this.runW * 1.5 + (a.state === UnitState.Grappling ? 3 : 0));
        n.hatExtra.rotation.set(0, this.hatSpinA % TAU, 0);
      } else if (fb.hatMode === 'bob' || fb.hatMode === 'sway') {
        const k = fb.hatMode === 'bob' ? 1.6 : 0.8;
        const bx = this.bobX.step(0, dt, -ayc * 0.09 * k - this.accel * 0.4 * k + hx * 30);
        const bz = this.bobZ.step(0, dt, this.yawRate * 9 * k + hz * 30);
        n.hatExtra.rotation.set(Math.max(-0.9, Math.min(0.9, bx)), 0, Math.max(-0.9, Math.min(0.9, bz)));
      }
    }

    // arms (right arm mirrors the rest pose)
    n.shL.rotation.set(o[LSX] + r.armFwd, o[LSY], o[LSZ] + r.armSplay);
    n.elL.rotation.set(o[LE] + r.elbow, 0, 0);
    n.shR.rotation.set(o[RSX] + r.armFwd, o[RSY], o[RSZ] - r.armSplay);
    const holdT = a.hookOut ? 0 : 1 - this.rBusy;
    this.holdW += (holdT - this.holdW) * (1 - Math.exp(-dt * 12));
    n.elR.rotation.set(o[RE] + r.elbow + r.holdElbow * this.holdW, 0, 0);

    // legs: counter the hip lean so feet stay under the body
    n.legL.rotation.set(o[LLX] - o[HX], 0, o[LLZ] + r.legSplay - o[HZ]);
    n.legR.rotation.set(o[RLX] - o[HX], 0, o[RLZ] - r.legSplay - o[HZ]);
    n.legL.position.y = n.base.legLY + o[LLY] / sc;
    n.legR.position.y = n.base.legRY + o[RLY] / sc;

    // held hook: hidden while it is out
    if (n.hook) {
      n.hook.visible = !a.hookOut;
      if (fb.hookDangles && n.hook.visible) this.dangle(dt);
      else if (this.hasHand) {
        n.handR.quaternion.identity();
        this.hasHand = false;
      }
    }

    // sweat drops (or sparks) at low HP
    if (n.drop) {
      if (this.lowW > 0.5 && a.state !== UnitState.Drowning) {
        this.dropT += dt;
        const cyc = 0.85;
        if (this.dropT > cyc) {
          this.dropT -= cyc;
          this.dropSide = -this.dropSide;
        }
        const u = this.dropT / 0.6;
        if (u < 1) {
          n.drop.visible = true;
          const b = n.base.drop;
          n.drop.position.set(b.x * this.dropSide + this.dropSide * 0.16 * u, b.y + 0.12 * u - 0.5 * u * u, b.z + 0.04 * u);
          const s = 1 - u * 0.6;
          n.drop.scale.setScalar(s);
        } else n.drop.visible = false;
      } else n.drop.visible = false;
    }
  }
}

const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();

const SERVO_CHANNELS = [NX, NY, NZ, BY, BZ, LSX, LSY, LSZ, LE, RSX, RSY, RSZ, RE, JAW];
