// Classic chain kinematics. The aimed outward head stays independent of its chain:
// links follow their neighbour toward the head on extension, toward the moving hand on return.
// Original implementation for Hook Wars; no Warcraft code or assets are included.
import { BAL } from '../constants.ts';
import type { Hook } from './entities.ts';

export const HOOK_SUBSTEP = 0.35;
const MAX_CHAIN_POINTS = 32;
const EPS = 1e-8;

function approach(points: number[], i: number, x: number, z: number, move: number): void {
  const dx = x - points[i], dz = z - points[i + 1];
  const d = Math.hypot(dx, dz);
  const k = d > EPS ? Math.min(1, move / d) : 1;
  points[i] += dx * k;
  points[i + 1] += dz * k;
}

export function extendChain(points: number[], headX: number, headZ: number, handX: number, handZ: number, move: number): void {
  let x = headX, z = headZ;
  for (let i = points.length - 2; i >= 0; i -= 2) {
    approach(points, i, x, z, move);
    x = points[i]; z = points[i + 1];
  }
  if (Math.hypot(x - handX, z - handZ) >= BAL.hookChainSpacing && points.length < MAX_CHAIN_POINTS * 2) {
    points.unshift(handX, handZ);
  }
}

export function retractChain(points: number[], handX: number, handZ: number, move: number): void {
  let x = handX, z = handZ;
  for (let i = 0; i < points.length; i += 2) {
    approach(points, i, x, z, move);
    x = points[i]; z = points[i + 1];
  }
  while (points.length && Math.hypot(points[0] - handX, points[1] - handZ) < EPS) points.splice(0, 2);
}

/** Loaded, stolen-from and clashed hooks never get a second bite on return. */
export function emptyReturn(h: Hook): boolean {
  return h.kind === 0 && h.phase === 1 && !h.spent && h.tg < 0 && h.ru < 0;
}
