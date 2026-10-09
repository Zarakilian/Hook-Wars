// Per-map cinematic look, derived from the map's Atmosphere block: colour grade (teal shadows, warm
// highlights, deeper contrast), height mist and light shafts, rim light, bloom and lantern strength.
// Tuned against the reference images (scratchpad refs 04 to 07): Mirelight dusk mist, Aurora night
// snow, Maelstrom tropical day, Lanternwharf rainy night.
import * as THREE from 'three';
import type { Atmosphere, MapDef } from '../../../shared/maps/types.ts';
import { groundY } from '../contracts.ts';

export interface CineGrade {
  /** shadow hue (display space, luma 1): the deep tones lean toward it (teal) */
  shadowHue: THREE.Vector3;
  /** 0..1 how far the shadows lean toward shadowHue (luma is kept) */
  shadowAmt: number;
  /** 0..1 desaturation of the deep shadows before the lean (moonlit navy -> blue-black) */
  shadowDesat: number;
  /** highlight hue (display space, luma 1): the bright tones lean toward it (warm) */
  highHue: THREE.Vector3;
  /** 0..1 how far the highlights lean toward highHue (luma is kept) */
  highAmt: number;
  /** display luma where the highlight lean starts, and where it is full */
  highLo: number;
  highHi: number;
  /** 0..1 complementary split: warm hues lean further orange, cool hues further teal */
  split: number;
  /** 0..1 filmic S-curve strength */
  curve: number;
  /** black point crush (display space) */
  black: number;
  /** vibrance: saturation boost for less saturated colours */
  vibrance: number;
  /** extra saturation on warm hues (lanterns, sunsets) */
  warmSat: number;
  /** exposure multiplier on top of the map's (applied before the grade) */
  exposure: number;
  /** extra vignette on top of the map's (0..1) */
  vignette: number;
  /** replaces the map's own lift (the blue lift that keeps night maps readable turns blacks navy) */
  lift: THREE.Vector3;
}

export interface CineMist {
  /** extinction at the mist base (1/m) */
  density: number;
  /** height falloff scale (m) */
  falloff: number;
  /** mist base height (world y) */
  base: number;
  /** top of the raymarch slab (world y) */
  top: number;
  /** ambient in-scatter colour (linear) */
  ambient: THREE.Color;
  /** sun / moon in-scatter colour (linear, includes intensity) */
  sun: THREE.Color;
  /** Henyey-Greenstein anisotropy */
  g: number;
  /** drifting mist banks: 0 = uniform, 1 = patchy */
  patchy: number;
  /** lantern glow in the mist, multiplier */
  lanternGlow: number;
  /** water surface height (rays stop there; the capture depth is the bed) */
  waterY: number;
  /** river centre x and half width at 9 evenly spaced z (x0, hw0, x1, hw1, ...) */
  river: number[];
  /** z of the first river sample and the step between samples */
  riverZ0: number;
  riverDz: number;
  /** mist density over the banks, as a fraction of the density over the river */
  bankMist: number;
}

export interface CineLook {
  grade: CineGrade;
  mist: CineMist;
  /** play rectangle for the depth of field: half width, half depth, bank top y, blur ramp outside it (m) */
  play: THREE.Vector4;
  /** screen rim / back light colour (linear) and strength */
  rimColor: THREE.Color;
  rim: number;
  /** fresnel rim colour for adopted materials (LOOK_UNIFORMS.hwLookRim) */
  fresnelRim: THREE.Color;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomRadius: number;
  /** lantern PointLight strength multiplier */
  lanterns: number;
  /** most lantern lights this map wants at once (night maps many, day maps few: each costs every lit pixel) */
  lightBudget: number;
  /** FogExp2 density multiplier (the mist takes over the near field) */
  fogScale: number;
  /** hemisphere ambient multiplier: darker fill so lantern pools and the rim light read */
  ambient: number;
}

function v3(r: number, g: number, b: number): THREE.Vector3 {
  return new THREE.Vector3(r, g, b);
}

/** the river centreline sampled at 9 evenly spaced z across the map (for the mist) */
function riverSamples(map: MapDef | null): { pts: number[]; z0: number; dz: number } {
  if (!map || map.river.points.length === 0) return { pts: Array.from({ length: 18 }, (_, i) => (i % 2 ? 1e3 : 0)), z0: -24, dz: 6 };
  const p = map.river.points;
  const z0 = -map.d / 2;
  const dz = map.d / 8;
  const pts: number[] = [];
  for (let i = 0; i < 9; i++) {
    const z = z0 + dz * i;
    let k = 0;
    while (k < p.length - 2 && p[k + 1].z < z) k++;
    const a = p[k];
    const b = p[Math.min(k + 1, p.length - 1)];
    const t = b.z > a.z ? Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z))) : 0;
    pts.push(a.x + (b.x - a.x) * t, a.hw + (b.hw - a.hw) * t);
  }
  return { pts, z0, dz };
}

/** a display-space hue scaled to luma 1 (so leaning toward it keeps brightness) */
function hue(r: number, g: number, b: number): THREE.Vector3 {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return new THREE.Vector3(r / l, g / l, b / l);
}

/** The cinematic look for a map (null = the menu backdrop). */
export function cinematicLook(map: MapDef | null, a: Atmosphere): CineLook {
  const tod = a.timeOfDay;
  const night = tod === 'night';
  const low = tod === 'dusk' || tod === 'dawn';
  const rain = a.weather === 'rain';
  const snow = a.weather === 'snow';
  const gy = map ? groundY(map) : 0;
  const sun = new THREE.Color(a.sunColor).multiplyScalar(a.sunIntensity);
  const fog = new THREE.Color(a.fogColor);
  const sky = new THREE.Color(a.skyHorizon);

  // Display-space grade on top of the map's own (GradeEffect): hues are normalised to luma 1 so the
  // lean keeps brightness; the deep contrast comes from the black point and the S-curve.
  const grade: CineGrade = night
    ? snow
      ? {
          // snowy night (Aurora): blue-black water, near-white snow, warm lanterns; little warm lean
          shadowHue: hue(0.55, 0.95, 1.25),
          shadowAmt: 0.42,
          shadowDesat: 0.3,
          highHue: hue(1.0, 0.97, 0.94),
          highAmt: 0.4,
          // moonlit snow sits in the mid tones: start the (near-white) lean early so it reads white
          highLo: 0.22,
          highHi: 0.75,
          split: 0.4,
          curve: 0.55,
          black: 0.03,
          vibrance: 0.12,
          warmSat: 0.4,
          exposure: 1.04,
          vignette: 0.2,
          lift: v3(0.0, 0.002, 0.008),
        }
      : {
          // rainy or clear night (Lanternwharf, Cogwater): near-black blue-teal shadows, lantern orange
          shadowHue: hue(0.6, 1.0, 1.15),
          shadowAmt: 0.5,
          shadowDesat: 0.4,
          highHue: hue(1.0, 0.64, 0.34),
          highAmt: 0.3,
          highLo: 0.36,
          highHi: 0.95,
          split: 0.45,
          curve: 0.5,
          black: 0.022,
          vibrance: 0.1,
          warmSat: 0.45,
          exposure: 1.08,
          vignette: 0.22,
          lift: v3(0.0, 0.002, 0.007),
        }
    : low
      ? {
          // dusk (Mirelight): violet-teal shadows, peach-gold highlights
          shadowHue: hue(0.68, 0.95, 1.2),
          shadowAmt: 0.32,
          shadowDesat: 0.15,
          highHue: hue(1.0, 0.72, 0.46),
          highAmt: 0.26,
          highLo: 0.32,
          highHi: 0.92,
          split: 0.35,
          // dusk keeps its glow: a gentler curve and black point than night (the marsh must not go muddy)
          curve: 0.32,
          black: 0.012,
          vibrance: 0.18,
          warmSat: 0.3,
          exposure: 1.12,
          vignette: 0.16,
          lift: v3(0.006, 0.0, 0.01),
        }
      : {
          // tropical day (Maelstrom): teal-cyan shadows and water, warm sun, punchy
          shadowHue: hue(0.5, 1.0, 1.12),
          shadowAmt: 0.3,
          shadowDesat: 0.0,
          highHue: hue(1.0, 0.82, 0.58),
          highAmt: 0.2,
          highLo: 0.4,
          highHi: 0.95,
          split: 0.35,
          curve: 0.45,
          black: 0.022,
          vibrance: 0.28,
          warmSat: 0.18,
          exposure: 1.0,
          vignette: 0.14,
          lift: v3(0.0, 0.0, 0.004),
        };

  // mist: low and thick at dusk (Mirelight), rain haze at night, a thin sea haze by day
  // the mist in shadow takes the fog colour cooled by the sky; the sun adds the warm where it reaches
  const ambient = low ? fog.clone().lerp(new THREE.Color(a.skyTop), 0.35).multiplyScalar(0.8) : fog.clone().lerp(sky, 0.3).multiplyScalar(night ? 0.7 : 1.1);
  const rs = riverSamples(map);
  const mist: CineMist = {
    density: night ? (rain ? 0.08 : snow ? 0.045 : 0.06) : low ? 0.05 : 0.03,
    falloff: night ? 1.4 : low ? 1.35 : 1.1,
    base: gy - 0.5,
    top: gy + 7,
    ambient,
    sun: sun.clone().multiplyScalar(night ? 0.55 : low ? 0.17 : 0.2),
    g: low ? 0.55 : night ? 0.45 : 0.35,
    patchy: low ? 0.6 : night ? 0.5 : 0.4,
    lanternGlow: night ? (snow ? 1.2 : 1.6) : low ? 1.2 : 0.5,
    waterY: map ? map.terrain.baseHeight - 0.32 : -1e3,
    river: rs.pts,
    riverZ0: rs.z0,
    riverDz: rs.dz,
    bankMist: night ? 0.55 : low ? 0.4 : 0.6,
  };

  const rimColor = night
    ? new THREE.Color(a.sunColor).lerp(new THREE.Color(0x9ec4ff), 0.4).multiplyScalar(0.55)
    : low
      ? new THREE.Color(a.sunColor).lerp(new THREE.Color(0xffd0a0), 0.3).multiplyScalar(0.6)
      : new THREE.Color(0xfff2dc).multiplyScalar(0.45);

  return {
    grade,
    mist,
    play: map ? new THREE.Vector4(map.w / 2, map.d / 2, gy, 7) : new THREE.Vector4(1e4, 1e4, 0, 7),
    rimColor,
    rim: night ? 1 : low ? 0.9 : 0.6,
    fresnelRim: rimColor.clone().multiplyScalar(0.8),
    bloomIntensity: night ? 1.45 : low ? 1.3 : 1.12,
    bloomThreshold: night ? 0.78 : low ? 0.82 : 0.9,
    bloomRadius: 0.82,
    lanterns: night ? 1.3 : low ? 0.9 : 0.45,
    lightBudget: night ? 10 : low ? 8 : 4,
    fogScale: 0.85,
    ambient: night ? 0.72 : low ? 1 : 0.95,
  };
}
