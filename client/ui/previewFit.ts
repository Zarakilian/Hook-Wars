// Keep a whole character inside the preview frame, whatever pose it is in (no DOM, so tests run it
// in Node). The preview camera sits on a fixed tilted ray from its look-at target:
//   camera = target + d * (0, sin tilt, cos tilt), looking at target.
// For a point Q (relative to the target) the camera-space height and sideways offset do not depend on
// d, only the depth does (depth = Q.forward + d). So the smallest distance that keeps a point inside
// the frame has a closed form, and the camera can be pushed out exactly as far as a pose needs.
import * as THREE from 'three';

export interface FitView {
  /** vertical field of view, degrees */
  fov: number;
  /** viewport width / height */
  aspect: number;
  /** camera tilt above the target, radians */
  tilt: number;
  /** look-at target (world) */
  target: THREE.Vector3;
}

/** Margins as fractions of the viewport height (top, bottom) and width (side). */
export interface FitMargin {
  top: number;
  bottom: number;
  side: number;
}

/** Whole-body preview margins: room for the "Drag to spin" pill at the top, a little on the other edges. */
export const BODY_MARGIN: FitMargin = { top: 0.075, bottom: 0.03, side: 0.035 };

/**
 * BODY_MARGIN with the top raised, when needed, to clear an overlay (the menu's "Drag to spin" pill)
 * that reaches clearPx down into a canvas canvasH pixels tall. On a short canvas (the stacked menu on
 * narrow screens) 7.5% of the height is less than the pill. Returns BODY_MARGIN itself whenever 7.5%
 * already clears it, so the framing is unchanged on every screen where it was fine.
 */
export function bodyMargin(canvasH: number, clearPx: number): FitMargin {
  if (!(canvasH > 0) || !(clearPx > 0)) return BODY_MARGIN;
  const top = Math.min(0.4, clearPx / canvasH);
  return top > BODY_MARGIN.top ? { ...BODY_MARGIN, top } : BODY_MARGIN;
}

/** Smallest camera distance at which every point projects inside the margins (0 for no points). */
export function fitDistance(points: readonly THREE.Vector3[], v: FitView, m: FitMargin = BODY_MARGIN): number {
  const t = Math.tan((v.fov * Math.PI) / 360);
  const sin = Math.sin(v.tilt);
  const cos = Math.cos(v.tilt);
  // NDC limits (1 = the edge); a margin of 7.5% of the height is 0.15 in NDC
  const top = (1 - 2 * m.top) * t;
  const bottom = (1 - 2 * m.bottom) * t;
  const side = (1 - 2 * m.side) * t * Math.max(0.1, v.aspect);
  let need = 0;
  for (const p of points) {
    const qx = p.x - v.target.x;
    const qy = p.y - v.target.y;
    const qz = p.z - v.target.z;
    const fwd = -qy * sin - qz * cos; // along the view direction
    const up = qy * cos - qz * sin; // camera-space up
    const vert = up >= 0 ? up / top : -up / bottom;
    const horiz = Math.abs(qx) / side;
    need = Math.max(need, vert - fwd, horiz - fwd);
  }
  return need;
}

/** Where a point lands in NDC (-1..1) for a camera at distance d on the same ray. */
export function projectNdc(p: THREE.Vector3, v: FitView, d: number): { x: number; y: number } {
  const t = Math.tan((v.fov * Math.PI) / 360);
  const sin = Math.sin(v.tilt);
  const cos = Math.cos(v.tilt);
  const qx = p.x - v.target.x;
  const qy = p.y - v.target.y;
  const qz = p.z - v.target.z;
  const depth = -qy * sin - qz * cos + d;
  const up = qy * cos - qz * sin;
  return { x: qx / (depth * t * v.aspect), y: up / (depth * t) };
}

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

/**
 * Corners of every visible, non-instanced mesh's own box in world space (matrixWorld must be
 * current). Much tighter than the corners of one box around the whole model, and cheap enough to
 * run every frame (a character has a few dozen meshes).
 */
export function meshCorners(root: THREE.Object3D, out: THREE.Vector3[] = []): THREE.Vector3[] {
  let n = 0;
  const visit = (o: THREE.Object3D) => {
    if (!o.visible) return;
    const m = o as THREE.Mesh & { isInstancedMesh?: boolean };
    if (m.isMesh && !m.isInstancedMesh && m.geometry) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      _box.copy(m.geometry.boundingBox!);
      for (let i = 0; i < 8; i++) {
        _v.set(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z).applyMatrix4(m.matrixWorld);
        if (!out[n]) out[n] = new THREE.Vector3();
        out[n++].copy(_v);
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  out.length = n;
  return out;
}
