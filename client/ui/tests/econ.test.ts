// Premium items and Pearl prices as the Store, Locker and Market show them (standard edition).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COSMETICS, RARITIES } from '../../../shared/cosmetics.ts';
import { fmtPearls, fmtPrice, fmtUsd, marketFee, marketTradable, premiumOffer, RARITY_INFO, sellerReceives, sourceLine, STEAM_ONLY } from '../econ.ts';

const premium = COSMETICS.filter((c) => c.rarity === 'premium');

test('every rarity has a label and colour, and the top one is Premium', () => {
  for (const r of RARITIES) assert.ok(RARITY_INFO[r], r);
  assert.equal(RARITY_INFO.premium.name, 'Premium');
  assert.ok(!('limited' in RARITY_INFO));
});

test('the browser shows Premium items as Steam-only and never as buyable', () => {
  assert.ok(premium.length >= 3);
  for (const d of premium) {
    const o = premiumOffer(d, false);
    assert.equal(o.text, STEAM_ONLY);
    assert.equal(o.text, 'Available in the Steam version');
    assert.equal(o.buyable, false);
    assert.match(sourceLine(d, false), /Steam version/);
    assert.doesNotMatch(sourceLine(d, false), /NFT|Solana|USDC|devnet|wallet/i);
  }
});

test('the Steam version shows the Steam price in US dollars', () => {
  for (const d of premium) {
    const o = premiumOffer(d, true);
    assert.equal(o.buyable, true);
    assert.equal(o.text, fmtUsd(d.usd!));
    assert.match(o.text, /^US\$\d+\.\d\d$/);
  }
  assert.equal(fmtUsd(1.99), 'US$1.99');
  // in Node there is no Steam bridge, so the default is the browser build
  assert.equal(premiumOffer(premium[0]).buyable, false);
});

test('the Pearl market lists Epic items only, never Premium or starter items', () => {
  for (const d of COSMETICS) assert.equal(marketTradable(d), d.rarity === 'epic', d.id);
  assert.equal(marketTradable(undefined), false);
});

test('market prices are Pearls with the shared 5% fee', () => {
  assert.equal(fmtPrice({ amount: 2500 }), `${fmtPearls(2500)} Pearls`);
  assert.equal(marketFee({ amount: 2501 }), 126);
  assert.equal(sellerReceives({ amount: 2501 }), 2375);
  assert.equal(marketFee({ amount: 50 }), 3);
});
