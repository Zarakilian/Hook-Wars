// Reverb rooms: generated impulse responses per map and the menu hall.
import type { MapId } from '../../shared/types.ts';
import type { IRSpec } from './core.ts';

export const ROOMS: Record<MapId | 'menu', IRSpec> = {
  menu: { dur: 2.0, decay: 1.9, pre: 0.02, damp: 0.6, early: 0.3, seed: 1 },
  muckmire: { dur: 1.9, decay: 1.5, pre: 0.015, damp: 0.75, early: 0.25, seed: 2 },
  frostfang: { dur: 3.1, decay: 3.0, pre: 0.03, damp: 0.35, early: 0.4, slap: 0.19, slapAmp: 0.25, seed: 3 },
  coralcove: { dur: 1.5, decay: 1.15, pre: 0.01, damp: 0.5, early: 0.15, seed: 4 },
  cogwater: { dur: 2.6, decay: 2.1, pre: 0.02, damp: 0.55, early: 0.5, slap: 0.11, slapAmp: 0.3, seed: 5 },
  mirelight: { dur: 2.0, decay: 1.6, pre: 0.015, damp: 0.72, early: 0.25, seed: 6 },
  aurora: { dur: 3.2, decay: 3.1, pre: 0.03, damp: 0.33, early: 0.42, slap: 0.2, slapAmp: 0.25, seed: 7 },
  maelstrom: { dur: 1.7, decay: 1.3, pre: 0.012, damp: 0.5, early: 0.2, seed: 8 },
  lanternwharf: { dur: 2.8, decay: 2.3, pre: 0.022, damp: 0.55, early: 0.55, slap: 0.12, slapAmp: 0.32, seed: 9 },
};
