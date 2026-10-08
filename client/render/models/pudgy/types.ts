// Types shared by the family builders, the rig and the animator.
import type * as THREE from 'three';
import type { PudgyPalette } from '../../contracts.ts';
import type { FamilyId } from '../../../../shared/types.ts';

export type V3 = readonly [number, number, number];

/**
 * Joint positions in skeleton voxel coordinates (see RGrid): ground centre is the origin,
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
  /** left hand socket (bind pose) */
  hand: V3;
  jaw: V3;
  eyes: V3;
  hat: V3;
  /** pivot of the animated hat piece (spinning dish, bobbing pom-pom) */
  hatExtra: V3;
  /** sweat drop / spark start, left side of the head */
  drop: V3;
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

export type PartName =
  | 'body' | 'head' | 'jaw' | 'eyes' | 'hat' | 'hatExtra'
  | 'upperL' | 'lowerL' | 'upperR' | 'lowerR' | 'hook' | 'legL' | 'legR' | 'drop';

export interface PartDef {
  /** geometry cache key (family, piece, option, team) */
  key: string;
  build: () => THREE.BufferGeometry;
}

export interface FamilyBuild {
  family: FamilyId;
  sk: Skeleton;
  rest: RestPose;
  style: MotionStyle;
  hatMode: HatMode;
  /** spin speed (rad/s) for 'spin' hats, axis is the hatExtra node's local Y */
  hatSpin: number;
  parts: Partial<Record<PartName, PartDef>>;
  palette: PudgyPalette;
  /** uniform scale of the whole character */
  scale: number;
  /** the held hook hangs on a rope and dangles straight down with a pendulum swing */
  hookDangles: boolean;
}
