// One-shot hints passed between screens (app.go() takes only a screen name).
import type { FamilyId } from '../../shared/types.ts';

export const navHint: { storeItem: string | null; lockerFamily: FamilyId | null; lockerItem: string | null } = {
  storeItem: null,
  lockerFamily: null,
  lockerItem: null,
};
