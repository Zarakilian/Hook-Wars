// What a family wears, as the Locker shows it. Pure rules (no DOM), shared by the Locker and its tests.
// The hands slot is never bare: an empty hands slot still renders the family's default hook (the
// character model and the hook skins both fall back to it), so the Locker treats a missing hook as
// the default hook instead of offering a "Bare" card that would change nothing on screen.
import { DEFAULT_LOADOUT, ownedLoadout, type CosmeticDef, type CosmeticSlot, type Loadout } from '../../shared/cosmetics.ts';
import type { FamilyId } from '../../shared/types.ts';

/** Slots that can be left empty on purpose (everything except the hook). */
export function slotCanBeBare(slot: CosmeticSlot): boolean {
  return slot !== 'hands';
}

/** Can the Locker offer "Unequip" for this item? Not for a hook: the slot would fall back to the default hook. */
export function canUnequip(def: CosmeticDef): boolean {
  return slotCanBeBare(def.slot);
}

/** The owned items a family wears, with a missing hook filled in as the default hook it really holds. */
export function wornLoadout(family: FamilyId, raw: Loadout, owns: (id: string) => boolean): Loadout {
  const out = ownedLoadout(raw, owns);
  if (!out.hands && DEFAULT_LOADOUT[family].hands) out.hands = DEFAULT_LOADOUT[family].hands;
  return out;
}
