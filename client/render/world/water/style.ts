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
  /** whirlpool: funnel depth (m), spiral arm count, foam gain, how far the arms reach (x radius), eye darkness */
  whirlDepth: number;
  whirlArms: number;
  whirlFoam: number;
  whirlReach: number;
  whirlEye: number;
  /** reflected sun path toward a low sun (sunset maps) */
  sunsetGlow: number;
  /** aurora curtains reflected in the water (needs atmosphere.aurora) */
  auroraRefl: number;
  /** lamp reflections stretched toward the camera into long broken streaks (canal maps) */
  lampStreak: number;
  /** blue light glowing up through the ice from below (freeze maps) */
  underGlow: number;
  /** waterfall mist amount (1 = the Coral Cove falls) */
  mist: number;
  /** brightness of the backdrop-water look the river takes on past the play area (match the terrain's) */
  endGain: number;
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
  whirlDepth: 0.42,
  whirlArms: 3,
  whirlFoam: 1,
  whirlReach: 1,
  whirlEye: 0.55,
  sunsetGlow: 0,
  auroraRefl: 0,
  lampStreak: 0,
  underGlow: 0,
  mist: 1,
  endGain: 1,
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
    lampStreak: 0.5,
  },
  // braided sunset marsh: murky tea water, mirror-calm, the low sun laying a path across it
  mirelight: {
    clarity: 0.62,
    waveAmp: 0.38,
    waveLen: 1.2,
    choppy: 0.26,
    caustics: 0.12,
    streaks: 0.28,
    shoreFoam: 0.55,
    scum: 0.45,
    scumColor: 0x5f7a2c,
    // the dark tea-brown water must show through: a stronger mirror turns the whole marsh mauve
    reflect: 1.0,
    glitter: 0.75,
    sss: 0.3,
    nightLift: 0.02,
    plips: 0.8,
    refract: 0.7,
    murk: 0.3,
    speckColor: 0xc8903e,
    speck: 0.55,
    hueDepth: 0.5,
    scumGain: 0.75,
    sunsetGlow: 1,
    lampStreak: 0.35,
  },
  // night harbour of floes: deep teal, the aurora rippling in it, ice that glows from below
  aurora: {
    clarity: 2.6,
    waveAmp: 0.7,
    choppy: 0.42,
    caustics: 0.28,
    streaks: 0.55,
    shoreFoam: 1.0,
    reflect: 1.3,
    glitter: 1.0,
    sss: 0.8,
    nightLift: 0.04,
    plips: 0.2,
    speckColor: 0xeaf4ff,
    speck: 0.45,
    hueDepth: 1.0,
    auroraRefl: 1,
    underGlow: 1,
    lampStreak: 0.4,
  },
  // bright turquoise cove around a great whirlpool, waterfalls pouring off the cliffs
  maelstrom: {
    // a saturated turquoise that deepens to teal fast, with a light mirror so the warm sky never
    // washes it out (measured against the reference: saturation ~0.35 instead of ~0.24)
    clarity: 3.4,
    waveAmp: 0.95,
    choppy: 0.36,
    caustics: 1.0,
    streaks: 0.5,
    shoreFoam: 1.25,
    reflect: 0.6,
    glitter: 1.15,
    sss: 1.1,
    nightLift: 0,
    plips: 0.35,
    refract: 1.2,
    speckColor: 0xfff2a8,
    speck: 0.2,
    hueDepth: 0.8,
    whirlDepth: 1.15,
    whirlArms: 4,
    whirlFoam: 1.35,
    whirlReach: 1.65,
    whirlEye: 1.0,
    mist: 1.5,
  },
  // rainy canal city: blue-black water, warm lamp streaks, rain rings everywhere
  lanternwharf: {
    clarity: 0.85,
    waveAmp: 0.36,
    choppy: 0.42,
    caustics: 0,
    streaks: 0.14,
    shoreFoam: 0.55,
    oil: 0.55,
    murk: 0.1,
    reflect: 1.65,
    glitter: 0.7,
    sss: 0.25,
    nightLift: 0.03,
    plips: 0.15,
    refract: 0.8,
    speckColor: 0,
    speck: 0,
    hueDepth: 0.6,
    lampStreak: 1,
  },
};

export function waterStyle(map: MapDef): WaterStyle {
  const s: WaterStyle = { ...BASE, ...(BY_MAP[map.id] ?? {}) };
  s.rain = map.atmosphere.weather === 'rain' ? 1 : 0;
  if (!(s.hueDepth > 0)) s.hueDepth = Math.max(0.3, s.clarity * 0.5);
  return s;
}
