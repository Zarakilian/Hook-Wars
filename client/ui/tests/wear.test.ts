// Finding 40: the Locker's Hook slot. An empty hands slot still renders the family's default hook, so
// the Locker must not offer "Bare" or "Unequip" for it, and the default hook counts as equipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COSMETIC_SLOTS, cosmeticById, DEFAULT_ITEM_IDS, DEFAULT_LOADOUT } from '../../../shared/cosmetics.ts';
import { FAMILIES } from '../../../shared/types.ts';
import { canUnequip, slotCanBeBare, wornLoadout } from '../wear.ts';

const ownsDefaults = (id: string) => DEFAULT_ITEM_IDS.includes(id);

test('only the hook slot has no Bare option', () => {
  for (const s of COSMETIC_SLOTS) assert.equal(slotCanBeBare(s), s !== 'hands', s);
});

test('a missing hook is shown as the default hook the model really holds', () => {
  for (const f of FAMILIES) {
    const worn = wornLoadout(f, { head: DEFAULT_LOADOUT[f].head }, ownsDefaults);
    assert.equal(worn.hands, DEFAULT_LOADOUT[f].hands, f);
    assert.equal(worn.head, DEFAULT_LOADOUT[f].head, f);
    // other slots left empty on purpose stay empty
    assert.equal(worn.body, undefined, f);
  }
});

test('an owned hook stays, an unowned one falls back to the default hook', () => {
  const other = 'brawler.harpoon_hook';
  assert.ok(cosmeticById(other));
  assert.equal(wornLoadout('brawler', { hands: other }, (id) => id === other || ownsDefaults(id)).hands, other);
  assert.equal(wornLoadout('brawler', { hands: other }, ownsDefaults).hands, DEFAULT_LOADOUT.brawler.hands);
});

test('Unequip is offered for every slot except the hook', () => {
  for (const f of FAMILIES) {
    for (const s of COSMETIC_SLOTS) {
      const id = DEFAULT_LOADOUT[f][s];
      if (!id) continue;
      assert.equal(canUnequip(cosmeticById(id)!), s !== 'hands', id);
    }
  }
});
