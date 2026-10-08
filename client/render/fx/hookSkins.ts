// Hook skins: one voxel model per 'hands' cosmetic (shared/cosmetics.ts), used both for the hook a
// Pudgy holds (characters mount it in the hand socket) and for the flying hook head (fx chains), so the
// two always match. The fx pass owns this file and fills it in; until then createHeldHook returns null
// and the character models keep their built-in hook.
import type * as THREE from 'three';
import type { FamilyId, Team } from '../../../shared/types.ts';
import type { Quality } from '../contracts.ts';

/**
 * The held hook for a hands cosmetic (undefined skin = the family default).
 * Origin at the grip (where the hand or arm socket holds it), the business end pointing +Z,
 * sized in metres for the base hook radius (HOOK_LEVELS.width[0] = 0.45 m).
 * Returns null when no model exists yet; the caller then shows its own. The caller owns the result
 * and calls disposeHeldHook on it when done (geometry and materials are shared and cached, so this
 * only detaches it).
 */
export function createHeldHook(_family: FamilyId, _skin: string | undefined, _team: Team, _quality: Quality): THREE.Object3D | null {
  return null;
}

export function disposeHeldHook(obj: THREE.Object3D): void {
  obj.removeFromParent();
}
