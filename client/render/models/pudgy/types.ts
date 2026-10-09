// Types shared by the family builders, the rig and the animator.
import type * as THREE from 'three';
import type { PudgyPalette } from '../../contracts.ts';
import type { FamilyId } from '../../../../shared/types.ts';
import type { RGrid } from './grid.ts';

export type V3 = readonly [number, number, number];

/**
 * Joint positions in skeleton unit coordinates (VOX metres, see RGrid): ground centre is the origin,
 * +x is the character's left, +y up, +z forward. Right-side joints mirror the left ones (x -> -x).
 * Arms are modelled hanging straight down; the rest pose splay comes from RestPose.
 */
export interface Skeleton {
  /** height of the spin pivot (belly centre) used for tumbling, flying and lying down */
  core: number;
  hip: V3;
  /** left hip joint */
  leg: V3;
  /** body mesh pivot (belly centre, for jiggle) */
  body: V3;
  neck: V3;
  /** left shoulder */
  shoulder: V3;
  /** left elbow (bind pose) */
  elbow: V3;
  /** left hand socket (bind pose); the right one holds the hook */
  hand: V3;
  jaw: V3;
  eyes: V3;
  hat: V3;
  /** pivot of the animated hat piece (spinning dish, bobbing pom-pom) */
  hatExtra: V3;
  /** back item pivot (on the torso) */
  back: V3;
  /** pivot of the animated back piece (propeller, gear) */
  backExtra: V3;
  /** sweat drop / spark start, left side of the head */
  drop: V3;
  /** top of the head with the tallest hat, for name tags and health bars */
  top: number;
}

export interface RestPose {
  /** outward shoulder roll so the arms clear the belly (radians) */
  armSplay: number;
  /** forward shoulder swing at rest */
  armFwd: number;
  /** elbow bend at rest (negative = forearm forward) */
  elbow: number;
  /** leg splay */
  legSplay: number;
  /** static torso pitch (hunch) */
  hunch: number;
  /** head pitch at rest */
  headPitch: number;
  /** jaw opening at rest (radians) */
  jawRest: number;
  /** extra elbow bend on the hook arm while the hook is held (hand raised, ready) */
  holdElbow: number;
  /** extra forward swing of the hook arm's shoulder while the hook is held (keeps long hooks off the ground) */
  holdShoulder?: number;
}

/** Family flavour in motion. */
export interface MotionStyle {
  kind: 'swagger' | 'stomp' | 'servo';
  /** metres travelled per full run cycle (two steps) */
  stride: number;
  /** body hop height at full run (m) */
  bounce: number;
  legSwing: number;
  armSwing: number;
  /** hip roll (waddle) */
  roll: number;
  /** shoulder roll / chest sway */
  sway: number;
  /** forward lean at full run */
  lean: number;
  /** contact squash strength */
  stomp: number;
  /** breaths per second at rest */
  breath: number;
}

export type HatMode = 'none' | 'spin' | 'bob' | 'sway';
/** spin = fast about local Z (propeller), turn = slow about local Z (gear), bob = springy */
export type BackMode = 'none' | 'spin' | 'turn' | 'bob';

export type PartName =
  | 'body' | 'head' | 'jaw' | 'eyes' | 'hat' | 'hatExtra'
  | 'upperL' | 'lowerL' | 'upperR' | 'lowerR' | 'hook' | 'legL' | 'legR' | 'drop'
  | 'back' | 'backExtra';

export interface PartDef {
  /** geometry cache key: family, part, every item id and flag it depends on, team, detail */
  key: string;
  build: () => THREE.BufferGeometry;
  /** the voxel grid behind it (debug checks: islands, triangle budgets) */
  grid?: () => RGrid;
}

/** Smoke / steam emitter, in the frame of a rig node. */
export interface PuffEmitter {
  node: 'neck' | 'hat' | 'torso' | 'back';
  /** skeleton unit coordinates (absolute, like the joints) */
  at: V3;
  kind: 'smoke' | 'steam';
  /** puffs per second at rest */
  rate: number;
  /** extra puffs per second while exerting (throws, bashes, running) */
  burst: number;
  /** puff size (m) */
  size: number;
}

/** How the held hook (fx skin or the built-in fallback) sits in the right hand socket. */
export interface HookMount {
  /**
   * offset from the hand socket in metres (rig scale already compensated), in the forearm frame: a
   * dangling hook swings about this point and it stays fixed in the forearm (common.ts hangPoint)
   */
  pos: V3;
  /** Euler XYZ rotation that turns the skin's +Z (business end) where it should point */
  rot: V3;
}

export interface FamilyBuild {
  family: FamilyId;
  sk: Skeleton;
  rest: RestPose;
  style: MotionStyle;
  hatMode: HatMode;
  /** spin speed (rad/s) for 'spin' hats, axis is the hatExtra node's local Y */
  hatSpin: number;
  backMode: BackMode;
  backSpin: number;
  parts: Partial<Record<PartName, PartDef>>;
  palette: PudgyPalette;
  /** uniform scale of the whole character */
  scale: number;
  /** the held hook hangs (rope, crane cable) and dangles straight down with a pendulum swing */
  hookDangles: boolean;
  hookMount: HookMount;
  /** mounts to switch to when an fx skin turns out to hang on a tether (hang) or be gripped (grip) */
  hangMount?: HookMount;
  gripMount?: HookMount;
  puffs: PuffEmitter[];
  /** lying on its back, how high the belly centre sits (m, before scale) */
  corpseLift: number;
  /** a premium item is worn: premium sparkles on */
  premium: boolean;
}
