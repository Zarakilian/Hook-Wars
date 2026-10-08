// Builds the joint hierarchy for one Pudgy from a FamilyBuild.
//
//   root (owned by the game client: position, yaw, visibility)
//     rig      squash / stretch / spawn pop (pivot at the feet), hop and lunge
//       core   belly-centre pivot: travel yaw, tumble, lying down, flight stretch
//         hips   waddle
//           legL, legR
//           torso  twist and lean
//             body mesh (belly jiggle)
//             neck -> head mesh, jaw, eyes, hat -> hatExtra, drop
//             shoulderL -> upper arm, elbowL -> forearm, handL
//             shoulderR -> upper arm, elbowR -> forearm, handR (socket) -> held hook
import * as THREE from 'three';
import type { Quality } from '../../contracts.ts';
import { acquireGeo } from './cache.ts';
import { VOX } from './grid.ts';
import type { FamilyBuild, PartName, V3 } from './types.ts';

export interface RigNodes {
  rig: THREE.Group;
  core: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  body: THREE.Object3D;
  neck: THREE.Group;
  jaw: THREE.Object3D | null;
  eyes: THREE.Object3D | null;
  hat: THREE.Group;
  hatExtra: THREE.Object3D | null;
  drop: THREE.Mesh | null;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  shL: THREE.Group;
  elL: THREE.Group;
  handL: THREE.Object3D;
  shR: THREE.Group;
  elR: THREE.Group;
  handR: THREE.Object3D;
  hook: THREE.Mesh | null;
  meshes: THREE.Mesh[];
  /** cache keys this rig holds a reference to */
  keys: string[];
  /** bind positions (metres) for nodes the animator offsets */
  base: { legLY: number; legRY: number; eyes: THREE.Vector3; drop: THREE.Vector3 };
}

/** Which parts cast shadows per quality tier. */
const SHADOW: Record<Quality, ReadonlySet<PartName>> = {
  low: new Set(),
  medium: new Set<PartName>(['body', 'head']),
  high: new Set<PartName>(['body', 'head', 'hat', 'upperL', 'lowerL', 'upperR', 'lowerR', 'legL', 'legR', 'hook', 'jaw']),
  ultra: new Set<PartName>(['body', 'head', 'hat', 'hatExtra', 'upperL', 'lowerL', 'upperR', 'lowerR', 'legL', 'legR', 'hook', 'jaw']),
};

function sub(a: V3, b: V3): THREE.Vector3 {
  return new THREE.Vector3((a[0] - b[0]) * VOX, (a[1] - b[1]) * VOX, (a[2] - b[2]) * VOX);
}
function mirror(a: V3): V3 {
  return [-a[0], a[1], a[2]];
}

export function buildRig(fb: FamilyBuild, material: THREE.Material, quality: Quality): RigNodes {
  const sk = fb.sk;
  const meshes: THREE.Mesh[] = [];
  const keys: string[] = [];
  const shadow = SHADOW[quality];

  const part = (name: PartName, parent: THREE.Object3D, pos?: THREE.Vector3): THREE.Mesh | null => {
    const def = fb.parts[name];
    if (!def) return null;
    const geo = acquireGeo(def);
    keys.push(def.key);
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    m.castShadow = shadow.has(name);
    m.receiveShadow = quality !== 'low';
    if (pos) m.position.copy(pos);
    parent.add(m);
    meshes.push(m);
    return m;
  };
  const group = (name: string, parent: THREE.Object3D, pos: THREE.Vector3): THREE.Group => {
    const g = new THREE.Group();
    g.name = name;
    g.position.copy(pos);
    parent.add(g);
    return g;
  };

  const rig = new THREE.Group();
  rig.name = 'pudgy-rig';
  const core = group('core', rig, new THREE.Vector3(0, sk.core * VOX, 0));
  core.rotation.order = 'YXZ';
  const coreJ: V3 = [0, sk.core, 0];
  const hips = group('hips', core, sub(sk.hip, coreJ));
  const legLNode = group('legL', hips, sub(sk.leg, sk.hip));
  const legRNode = group('legR', hips, sub(mirror(sk.leg), sk.hip));
  part('legL', legLNode);
  part('legR', legRNode);
  const torso = group('torso', hips, new THREE.Vector3());
  const bodyNode = group('body', torso, sub(sk.body, sk.hip));
  part('body', bodyNode);
  const neck = group('neck', torso, sub(sk.neck, sk.hip));
  part('head', neck);
  let jaw: THREE.Object3D | null = null;
  if (fb.parts.jaw) {
    jaw = group('jaw', neck, sub(sk.jaw, sk.neck));
    part('jaw', jaw);
  }
  let eyes: THREE.Object3D | null = null;
  if (fb.parts.eyes) {
    eyes = group('eyes', neck, sub(sk.eyes, sk.neck));
    part('eyes', eyes);
  }
  const hat = group('hat', neck, sub(sk.hat, sk.neck));
  part('hat', hat);
  let hatExtra: THREE.Object3D | null = null;
  if (fb.parts.hatExtra) {
    hatExtra = group('hatExtra', hat, sub(sk.hatExtra, sk.hat));
    part('hatExtra', hatExtra);
  }
  const drop = part('drop', neck, sub(sk.drop, sk.neck));
  if (drop) drop.visible = false;

  const shL = group('shoulderL', torso, sub(sk.shoulder, sk.hip));
  part('upperL', shL);
  const elL = group('elbowL', shL, sub(sk.elbow, sk.shoulder));
  part('lowerL', elL);
  const handL = group('handL', elL, sub(sk.hand, sk.elbow));
  const shR = group('shoulderR', torso, sub(mirror(sk.shoulder), sk.hip));
  part('upperR', shR);
  const elR = group('elbowR', shR, sub(mirror(sk.elbow), mirror(sk.shoulder)));
  part('lowerR', elR);
  const handR = group('handR', elR, sub(mirror(sk.hand), mirror(sk.elbow)));
  const hook = part('hook', handR);

  rig.scale.setScalar(fb.scale);
  return {
    rig, core, hips, torso, body: bodyNode, neck, jaw, eyes, hat, hatExtra, drop,
    legL: legLNode, legR: legRNode, shL, elL, handL, shR, elR, handR, hook, meshes, keys,
    base: {
      legLY: legLNode.position.y,
      legRY: legRNode.position.y,
      eyes: eyes ? eyes.position.clone() : new THREE.Vector3(),
      drop: drop ? drop.position.clone() : new THREE.Vector3(),
    },
  };
}
