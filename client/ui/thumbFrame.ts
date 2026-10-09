// Finding the item on a character model, for the item thumbnails (no DOM, so tests run it in Node).
//
// Character parts come from a shared, reference-counted geometry cache (client/render/models/pudgy/
// cache.ts) and hook skins from a page-lifetime cache (client/render/fx/hookSkins.ts). Two views
// built at the same time therefore share the very same BufferGeometry object for every part they
// have in common. So "the item" is simply the visible meshes whose geometry the base view does not
// have. That does not depend on the pose, unlike comparing world-space boxes: every createPudgy call
// seeds its animator differently, so two builds never stand exactly alike.
import * as THREE from 'three';
import { DEFAULT_LOADOUT, itemsFor, type CosmeticDef, type Loadout } from '../../shared/cosmetics.ts';
import { UnitState, type FamilyId } from '../../shared/types.ts';
import type { PudgyView } from '../render/contracts.ts';
import { createPudgy } from '../render/models/pudgy.ts';

/** Animator seed used for every thumbnail build, so a thumbnail looks the same in every session. */
export const THUMB_SEED = 7919;

function isPlainMesh(o: THREE.Object3D): o is THREE.Mesh {
  const m = o as THREE.Mesh & { isInstancedMesh?: boolean };
  // InstancedMesh = the smoke puffs: a shared unit box whose geometry bounds mean nothing
  return !!m.isMesh && !m.isInstancedMesh && !!m.geometry;
}

/** Is this object and every parent up to root visible? */
function shown(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return true;
}

/** Every visible, non-instanced mesh under root. */
export function visibleMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (isPlainMesh(o) && shown(o, root)) out.push(o);
  });
  return out;
}

/** The geometry objects of every visible mesh under root. */
export function meshGeometries(root: THREE.Object3D): Set<THREE.BufferGeometry> {
  return new Set(visibleMeshes(root).map((m) => m.geometry));
}

/** Visible meshes of root whose geometry is not in `base` (the item's own meshes). */
export function newMeshes(root: THREE.Object3D, base: ReadonlySet<THREE.BufferGeometry>): THREE.Mesh[] {
  return visibleMeshes(root).filter((m) => !base.has(m.geometry));
}

/** Same geometry objects, in any order? */
export function sameGeometries(a: readonly THREE.Mesh[], b: readonly THREE.Mesh[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b.map((m) => m.geometry));
  return a.every((m) => set.has(m.geometry));
}

/** World box around these meshes (matrixWorld must be current). Empty box for an empty list. */
export function worldBox(meshes: readonly THREE.Mesh[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const m of meshes) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
  }
  return box;
}

/**
 * The box to frame for an item, or null to fall back to slot framing: nothing new, or a change that
 * spans most of the body (a re-meshed torso), which is no help for framing.
 */
export function itemFrameBox(root: THREE.Object3D, item: readonly THREE.Mesh[]): THREE.Box3 | null {
  if (!item.length) return null;
  root.updateMatrixWorld(true);
  const box = worldBox(item);
  if (box.isEmpty()) return null;
  const full = worldBox(visibleMeshes(root)).getSize(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  if (sz.y > full.y * 0.85 && sz.x > full.x * 0.85) return null;
  return box;
}

/**
 * Pin a freshly built view's idle pose to one seed, so every build of the same look stands the same
 * way. Uses the animator the characters module exposes as a hidden `_anim` property; without it
 * (or if its shape changes) nothing happens and the pose stays slightly random.
 */
export function pinPose(view: PudgyView, seed = THUMB_SEED): boolean {
  const a = (view as unknown as { _anim?: { seed?: unknown; phase?: unknown; nextBlink?: unknown; nextLook?: unknown } })._anim;
  if (!a || typeof a.seed !== 'number') return false;
  a.seed = seed;
  // the animator derives these from its seed in its constructor (walk phase, first blink and glance)
  if (typeof a.phase === 'number') a.phase = (seed % 13) / 13;
  if (typeof a.nextBlink === 'number') a.nextBlink = 1 + (seed % 7) * 0.4;
  if (typeof a.nextLook === 'number') a.nextLook = 1.5 + (seed % 5) * 0.6;
  return true;
}

/** Build a still view of one look for a thumbnail: pinned seed, half a second into the idle. */
export function buildThumbView(family: FamilyId, loadout: Loadout): PudgyView {
  const v = createPudgy({ family, loadout, team: 0, name: 'thumb', isLocal: false, quality: 'high', detail: 'showcase' });
  pinPose(v);
  v.update(1 / 60, { state: UnitState.Alive, speed: 0, hpFrac: 1, flags: 0, hookOut: false, stateTime: 0.5, time: 0.5 });
  v.root.updateMatrixWorld(true);
  return v;
}

/**
 * What an item is compared against. Usually the bare base. The hands slot is never bare (an empty slot
 * still shows the family's default hook, so held and flying hooks match), so a hook is compared
 * against the same family holding a different hook.
 */
export function baseLoadout(def: CosmeticDef): Loadout {
  if (def.slot !== 'hands') return {};
  const other = itemsFor(def.family, 'hands').find((c) => c.id !== def.id);
  return other ? { hands: other.id } : {};
}

export interface ItemShot {
  /** the item worn on its base, turned to `yaw`; the caller disposes it */
  view: PudgyView;
  /** the item's own meshes */
  meshes: THREE.Mesh[];
  /** box to frame, or null for slot framing (see itemFrameBox) */
  box: THREE.Box3 | null;
}

/**
 * Finds items on their models. Keeps one reference view per base look alive while in use, so the
 * shared part geometry stays cached and identity comparisons hold (a released geometry is rebuilt
 * as a new object). dispose() frees them; the next locate() builds them again.
 */
export class ItemLocator {
  private readonly refs = new Map<string, { view: PudgyView; geos: Set<THREE.BufferGeometry> }>();

  private ref(family: FamilyId, loadout: Loadout): Set<THREE.BufferGeometry> {
    const k = `${family}|${JSON.stringify(loadout)}`;
    let r = this.refs.get(k);
    if (!r) {
      const view = buildThumbView(family, loadout);
      r = { view, geos: meshGeometries(view.root) };
      this.refs.set(k, r);
    }
    return r.geos;
  }

  /** The item on its base at this yaw, or null when the model does not draw it (keep the slot glyph). */
  locate(def: CosmeticDef, yaw: number): ItemShot | null {
    const base = this.ref(def.family, baseLoadout(def));
    const view = buildThumbView(def.family, { [def.slot]: def.id });
    try {
      const meshes = newMeshes(view.root, base);
      if (!meshes.length) {
        view.dispose();
        return null; // not modelled yet: the model draws the base unchanged
      }
      // an item the model does not draw yet may fall back to the family's default piece
      const dflt = DEFAULT_LOADOUT[def.family][def.slot];
      if (dflt && dflt !== def.id) {
        const dGeos = [...this.ref(def.family, { [def.slot]: dflt })].filter((g) => !base.has(g));
        const mine = new Set(meshes.map((m) => m.geometry));
        if (dGeos.length === mine.size && dGeos.every((g) => mine.has(g))) {
          view.dispose();
          return null;
        }
      }
      view.root.rotation.y = yaw;
      view.root.updateMatrixWorld(true);
      // a hook on a rope or chain: frame the hook, not the length of tether above it
      const body = meshes.filter((m) => m.name !== 'hw-held-tether');
      return { view, meshes, box: itemFrameBox(view.root, body.length ? body : meshes) };
    } catch (err) {
      view.dispose();
      throw err;
    }
  }

  dispose(): void {
    for (const r of this.refs.values()) {
      try {
        r.view.dispose();
      } catch {
        // ignore
      }
    }
    this.refs.clear();
  }
}
