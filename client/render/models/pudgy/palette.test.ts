// Skin and shell colours against samples of the reference sheets (finding 34): the Swamp Ogre's
// hide was a pale mint-cream (CIE L* 70, dE 18 to 22 from ref09) and the Dredge-Bot's steel a light
// grey (L* 59, dE 14 to 17 from ref10). Samples are medians of reference patches (verify2-visual/dE.py):
// ref09 belly and upper chest, ref10 belly panels, and for the bot's rusted default set (ref03) a
// belly panel away from the paint stain.
// Run: node --test client/render/models/pudgy/palette.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOADOUT } from '../../../../shared/cosmetics.ts';
import type { FamilyId, Loadout } from '../../../../shared/types.ts';
import { pudgyPalette } from '../pudgy.ts';

function lab(hex: number): [number, number, number] {
  const lin = (v: number) => (v / 255 > 0.04045 ? ((v / 255 + 0.055) / 1.055) ** 2.4 : v / 255 / 12.92);
  const r = lin((hex >> 16) & 255);
  const g = lin((hex >> 8) & 255);
  const b = lin(hex & 255);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

function dE(a: number, b: number): number {
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const SAMPLES: Record<'ogre' | 'bot', { bare: number[]; default: number[] }> = {
  ogre: { bare: [0xaa875c, 0x91764b], default: [0xaa875c, 0x91764b] },
  bot: { bare: [0x8f7160, 0x7c6653], default: [0x8f7160, 0x7c6653, 0x54362e] },
};
const MAX_DE = 12;

function skin(family: FamilyId, loadout: Loadout): number {
  return pudgyPalette(family, loadout, 0).skin;
}

for (const family of ['ogre', 'bot'] as const) {
  test(`${family} skin is within dE ${MAX_DE} of the reference sheet (bare base and default set)`, () => {
    for (const [label, lo] of [['bare', {}], ['default', DEFAULT_LOADOUT[family]]] as const) {
      const c = skin(family, lo);
      const ref = SAMPLES[family][label];
      const best = Math.min(...ref.map((s) => dE(c, s)));
      assert.ok(best < MAX_DE, `${family} ${label} skin #${c.toString(16)}: dE ${best.toFixed(1)} from the closest reference sample`);
      // never paler than the reference: the Locker and the game light both brighten what is authored
      assert.ok(lab(c)[0] <= Math.max(...ref.map((s) => lab(s)[0])), `${family} ${label} skin L* ${lab(c)[0].toFixed(1)} is paler than the reference`);
    }
  });
}
