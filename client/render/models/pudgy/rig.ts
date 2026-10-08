// Builds the joint hierarchy for one Pudgy from a FamilyBuild.
//
//   root (owned by the game client: position, yaw, visibility)
//     rig      squash / stretch / spawn pop (pivot at the feet), hop and lunge
//       core   belly-centre pivot: travel yaw, tumble, lying down, flight stretch
//         hips   waddle
//           legL, legR
//           torso  twist and lean
//             body mesh (belly jiggle)
//             back -> back item mesh, backExtra (propeller, gear, bobbing jar)
//             neck -> head mesh, jaw, eyes, hat -> hatExtra, drop
//             shoulderL -> upper arm, elbowL -> forearm, handL
//             shoulderR -> upper arm, elbowR -> forearm, handR (socket) -> grip -> held hook
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
  back: THREE.Group;
  backExtra: THREE.Object3D | null;
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
  /** holds the held hook (fx skin or the built-in fallback), in world metres, business end +Z */
  grip: THREE.Group;
  /** the built-in fallback hook mesh (null when an fx skin is mounted instead) */
  hook: THREE.Mesh | null;
  meshes: THREE.Mesh[];
  /** cache keys this rig holds a reference to */
  keys: string[];
  /** bind positions (metres) for nodes the animator offsets */
  base: { legLY: number; legRY: number; eyes: THREE.Vector3; drop: THREE.Vector3; backExtra: THREE.Vector3 };
}

/** Which parts cast shadows per quality tier. */
const SHADOW: Record<Quality, ReadonlySet<PartName>> = {
  low: new Set(),
  medium: new Set<PartName>(['body', 'head']),
  // legs and jaw sit under the belly / beard and their shadows merge with the body's
  high: new Set<PartName>(['body', 'head', 'hat', 'upperL', 'lowerL', 'upperR', 'lowerR', 'hook', 'back']),
  ultra: new Set<PartName>(['body', 'head', 'hat', 'hatExtra', 'upperL', 'lowerL', 'upperR', 'lowerR', 'legL', 'legR', 'hook', 'jaw', 'back', 'backExtra']),
};

function sub(a: V3, b: V3): THREE.Vector3 {
  return new THREE.Vector3((a[0] - b[0]) * VOX, (a[1] - b[1]) * VOX, (a[2] - b[2]) * VOX);
}
function mirror(a: V3): V3 {
  return [-a[0], a[1], a[2]];
}

/**
 * heldHook: an fx hook skin (world metres, grip at the origin, business end +Z). When null the
 * family's own fallback hook part (built in the same convention) is used.
 */
export function buildRig(fb: FamilyBuild, material: THREE.Material, quality: Quality, heldHook: THREE.Object3D | null): RigNodes {
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
  const back = group('back', torso, sub(sk.back, sk.hip));
  part('back', back);
  let backExtra: THREE.Object3D | null = null;
  if (fb.parts.backExtra) {
    backExtra = group('backExtra', back, sub(sk.backExtra, sk.back));
    part('backExtra', backExtra);
  }
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

  // the held hook lives in world metres: undo the rig scale so fx skins and the fallback match
  const inv = 1 / fb.scale;
  const mp = fb.hookMount.pos;
  const grip = group('grip', handR, new THREE.Vector3(mp[0] * inv, mp[1] * inv, mp[2] * inv));
  grip.rotation.set(fb.hookMount.rot[0], fb.hookMount.rot[1], fb.hookMount.rot[2]);
  grip.scale.setScalar(inv);
  let hook: THREE.Mesh | null = null;
  if (heldHook) {
    heldHook.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = shadow.has('hook');
    });
    grip.add(heldHook);
  } else {
    hook = part('hook', grip);
    // fallback hooks are authored with the curve toward +Y; fx skins curve in their XZ plane
    if (hook) hook.rotation.z = Math.PI / 2;
  }

  rig.scale.setScalar(fb.scale);
  return {
    rig, core, hips, torso, body: bodyNode, back, backExtra, neck, jaw, eyes, hat, hatExtra, drop,
    legL: legLNode, legR: legRNode, shL, elL, handL, shR, elR, handR, grip, hook, meshes, keys,
    base: {
      legLY: legLNode.position.y,
      legRY: legRNode.position.y,
      eyes: eyes ? eyes.position.clone() : new THREE.Vector3(),
      drop: drop ? drop.position.clone() : new THREE.Vector3(),
      backExtra: backExtra ? backExtra.position.clone() : new THREE.Vector3(),
    },
  };
}
