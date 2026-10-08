// Per-map look of the river. Colours come from map.atmosphere; these are the "how it behaves" knobs.
import type { MapDef } from '../../../../shared/maps/types.ts';

export interface WaterStyle {
  /** metres of water before the bed is mostly hidden (absorption length) */
  clarity: number;
  /** Gerstner amplitude multiplier */
  waveAmp: number;
  /** wavelength multiplier */
  waveLen: number;
  /** detail normal strength */
  choppy: number;
  /** caustic brightness on the bed */
  caustics: number;
  /** flowing foam streak amount */
  streaks: number;
  /** shoreline foam width multiplier */
  shoreFoam: number;
  /** swamp surface film (duckweed / algae) amount and colour */
  scum: number;
  scumColor: number;
  /** oily rainbow sheen (harbour canal) */
  oil: number;
  /** rain ripple rings on the surface */
  rain: number;
  /** sky reflection strength */
  reflect: number;
  /** stylised sun glitter */
  glitter: number;
  /** light scattering glow through wave crests */
  sss: number;
  /** floor brightness for night maps so the river always reads */
  nightLift: number;
  /** ambient ripples per second (fish, bubbles, drips) */
  plips: number;
  /** refraction distortion */
  refract: number;
  /** turbid water: how much of the shallow colour survives into deep water (0 = clear) */
  murk: number;
  /** slow drifting debris specks (leaves, petals, ice dust) colour, 0 = none */
  speckColor: number;
  speck: number;
  /** metres for the water's own colour to go from waterShallow to waterDeep (0 = clarity * 0.5) */
  hueDepth: number;
  /** brightness of the swamp film */
  scumGain: number;
}

const BASE: WaterStyle = {
  clarity: 1.6,
  waveAmp: 0.8,
  waveLen: 1,
  choppy: 0.4,
  caustics: 0.5,
  streaks: 0.5,
  shoreFoam: 1,
  scum: 0,
  scumColor: 0x6f8f2a,
  oil: 0,
  rain: 0,
  reflect: 1,
  glitter: 1,
  sss: 0.6,
  nightLift: 0.02,
  plips: 0.3,
  refract: 1,
  murk: 0,
  speckColor: 0,
  speck: 0,
  hueDepth: 0,
  scumGain: 1,
};

const BY_MAP: Partial<Record<MapDef['id'], Partial<WaterStyle>>> = {
  muckmire: {
    clarity: 0.75,
    waveAmp: 0.55,
    choppy: 0.34,
    caustics: 0.22,
    streaks: 0.4,
    shoreFoam: 0.8,
    scum: 1,
    scumColor: 0x6d8f2a,
    reflect: 1.4,
    glitter: 0.9,
    sss: 0.35,
    nightLift: 0.02,
    plips: 0.9,
    refract: 0.8,
    murk: 0.15,
    speckColor: 0x8a6a2a,
    speck: 0.6,
    hueDepth: 0.55,
    scumGain: 0.8,
  },
  frostfang: {
    clarity: 2.4,
    waveAmp: 0.9,
    choppy: 0.45,
    caustics: 0.3,
    streaks: 0.75,
    shoreFoam: 1.1,
    reflect: 1.15,
    glitter: 1.0,
    sss: 0.7,
    nightLift: 0.035,
    plips: 0.25,
    speckColor: 0xeaf4ff,
    speck: 0.5,
    hueDepth: 1.1,
  },
  coralcove: {
    clarity: 4.2,
    waveAmp: 0.85,
    choppy: 0.34,
    caustics: 1.0,
    streaks: 0.4,
    shoreFoam: 1.15,
    reflect: 0.85,
    glitter: 1.1,
    sss: 1.0,
    nightLift: 0,
    plips: 0.35,
    refract: 1.2,
    speckColor: 0xfff2a8,
    speck: 0.25,
    hueDepth: 1.25,
  },
  cogwater: {
    clarity: 0.95,
    waveAmp: 0.45,
    choppy: 0.36,
    caustics: 0,
    streaks: 0.2,
    shoreFoam: 0.7,
    oil: 1,
    murk: 0.12,
    reflect: 1.5,
    glitter: 0.8,
    sss: 0.3,
    nightLift: 0.04,
    plips: 0.2,
    refract: 0.8,
    speckColor: 0,
    speck: 0,
    hueDepth: 0.7,
  },
};

export function waterStyle(map: MapDef): WaterStyle {
  const s: WaterStyle = { ...BASE, ...(BY_MAP[map.id] ?? {}) };
  s.rain = map.atmosphere.weather === 'rain' ? 1 : 0;
  if (!(s.hueDepth > 0)) s.hueDepth = Math.max(0.3, s.clarity * 0.5);
  return s;
}
