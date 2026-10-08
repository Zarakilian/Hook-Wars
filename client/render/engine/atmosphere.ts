// Turns a map's Atmosphere block (or the menu preset) into every derived number the engine uses:
// sky look, lights, fog, bloom and colour grade. All colours here are linear (THREE.Color.set
// converts the sRGB hex values of the map data).
import * as THREE from 'three';
import type { Atmosphere, Weather } from '../../../shared/maps/types.ts';

export interface SkyLook {
  top: THREE.Color;
  horizon: THREE.Color;
  /** what the dome shows below the horizon in play (blends into fog) */
  below: THREE.Color;
  /** what the environment capture shows below the horizon (ground bounce for reflections) */
  envBelow: THREE.Color;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunDisk: number;
  sunSize: number;
  sunGlow: number;
  moon: boolean;
  cloudCover: number;
  cloudSpeed: number;
  cloudScale: number;
  cloudLit: THREE.Color;
  cloudDark: THREE.Color;
  stars: number;
  aurora: number;
  shafts: number;
  haze: number;
  horizonSharp: number;
  /** how fast the gradient turns from horizon to zenith colour */
  curve: number;
  mid: THREE.Color;
  midAmount: number;
}

export interface GradeLook {
  saturation: number;
  contrast: number;
  lift: THREE.Vector3;
  gain: THREE.Vector3;
  vignette: number;
}

export interface ResolvedAtmosphere {
  src: Atmosphere;
  menu: boolean;
  sky: SkyLook;
  fogColor: THREE.Color;
  fogDensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  sunDir: THREE.Vector3;
  exposure: number;
  envIntensity: number;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomRadius: number;
  grade: GradeLook;
  shadowIntensity: number;
  weather: Weather;
  /** slow colour drift of the ambient light (aurora maps) */
  ambientDrift: number;
}

/** Menu backdrop: a warm sunset over a calm sea. */
export const MENU_ATMOSPHERE: Atmosphere = {
  timeOfDay: 'dusk',
  sunDir: [0.36, 0.06, -1],
  sunColor: 0xffa35a,
  sunIntensity: 2.4,
  skyTop: 0x1a2350,
  skyHorizon: 0xf2875e,
  groundAmbient: 0x2b2034,
  ambientIntensity: 0.75,
  fogColor: 0xe08a68,
  fogDensity: 0.0022,
  weather: 'none',
  aurora: false,
  waterShallow: 0x2f6f8a,
  waterDeep: 0x0b2238,
  waterFoam: 0xffe3c8,
  exposure: 1,
  saturation: 1.1,
  bloom: 0.75,
};

function luminance(c: THREE.Color): number {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

/** Raise a colour's linear luminance to at least `min`, keeping its hue. */
function liftTo(c: THREE.Color, min: number): THREE.Color {
  const l = luminance(c);
  if (l >= min) return c;
  if (l < 1e-5) return c.setRGB(min, min, min);
  return c.multiplyScalar(min / l);
}

export function resolveAtmosphere(a: Atmosphere, menu: boolean): ResolvedAtmosphere {
  const tod = a.timeOfDay;
  const night = tod === 'night';
  const low = tod === 'dusk' || tod === 'dawn';
  const rain = a.weather === 'rain';
  const snow = a.weather === 'snow';

  const sunDir = new THREE.Vector3(a.sunDir[0], a.sunDir[1], a.sunDir[2]).normalize();
  const top = new THREE.Color(a.skyTop);
  const horizon = new THREE.Color(a.skyHorizon);
  const fog = new THREE.Color(a.fogColor);
  const ground = new THREE.Color(a.groundAmbient);
  const sunCol = new THREE.Color(a.sunColor);

  // the dome below the horizon: mostly fog, a hint of the horizon colour
  const below = fog.clone().lerp(horizon, 0.12);
  const envBelow = ground.clone().lerp(fog, 0.25).multiplyScalar(0.8);

  const mid = horizon.clone().lerp(new THREE.Color(0xa8457e), 0.65).lerp(top, 0.2);
  // clouds
  let cloudCover = night ? 0.36 : low ? 0.5 : 0.44;
  if (rain) cloudCover = 0.9;
  if (snow) cloudCover = 0.58;
  if (menu) cloudCover = 0.44;
  const cloudLit = night
    ? top.clone().lerp(horizon, 0.6).multiplyScalar(1.6).lerp(sunCol, 0.25)
    : low
      ? sunCol.clone().lerp(new THREE.Color(0xffd7c8), 0.35).multiplyScalar(1.25)
      : new THREE.Color(0xffffff).lerp(sunCol, 0.2).multiplyScalar(1.15);
  const cloudDark = night
    ? top.clone().lerp(horizon, 0.3).multiplyScalar(0.7)
    : low
      ? top.clone().lerp(mid, 0.22).multiplyScalar(1.5)
      : horizon.clone().lerp(top, 0.35).multiplyScalar(0.82);
  if (rain) {
    cloudLit.multiplyScalar(0.55);
    cloudDark.multiplyScalar(0.55);
  }

  const sky: SkyLook = {
    top,
    horizon,
    below,
    envBelow,
    sunDir: sunDir.clone(),
    sunColor: sunCol.clone(),
    sunDisk: night ? (rain ? 1.5 : 5) : low ? 14 : 40,
    sunSize: night ? 0.032 : low ? 0.034 : 0.024,
    sunGlow: night ? (rain ? 0.35 : 0.7) : low ? 1.25 : 0.9,
    moon: night,
    cloudCover,
    cloudSpeed: rain ? 0.035 : menu ? 0.012 : 0.018,
    cloudScale: rain ? 0.55 : 0.42,
    cloudLit,
    cloudDark,
    stars: night ? (rain ? 0 : 1) : low ? 0.25 : 0,
    aurora: a.aurora ? 1 : 0,
    shafts: menu ? 0.12 : low ? 0.06 : 0,
    haze: night ? 0.4 : low ? 0.6 : 0.5,
    horizonSharp: low ? 9 : 11,
    curve: night ? 3.2 : low ? 4.6 : 3.4,
    mid,
    midAmount: low ? 0.42 : 0,
  };

  // ambient: blend of the sky, lifted so night maps stay readable
  const hemiSky = top.clone().lerp(horizon, 0.4);
  liftTo(hemiSky, night ? 0.085 : low ? 0.115 : 0.12);
  const hemiGround = ground.clone();
  liftTo(hemiGround, night ? 0.025 : 0.035);

  const grade: GradeLook = {
    // AgX is deliberately soft; this is our "punchy" look on top of the map's saturation hint
    saturation: a.saturation * 1.16,
    contrast: night ? 1.12 : low ? 1.1 : 1.1,
    lift: night ? new THREE.Vector3(0.0, 0.008, 0.024) : low ? new THREE.Vector3(0.014, 0.0, 0.02) : new THREE.Vector3(0.0, 0.004, 0.012),
    gain: night ? new THREE.Vector3(0.97, 1.0, 1.04) : low ? new THREE.Vector3(1.04, 0.995, 0.94) : new THREE.Vector3(1.015, 1.0, 0.98),
    vignette: night ? 0.36 : low ? 0.3 : 0.22,
  };

  return {
    src: a,
    menu,
    sky,
    fogColor: fog,
    fogDensity: a.fogDensity,
    hemiSky,
    hemiGround,
    // dusk and night keep a little more fill so the action stays readable
    hemiIntensity: a.ambientIntensity * (night || low ? 0.95 : 0.85),
    sunColor: sunCol,
    sunIntensity: a.sunIntensity,
    sunDir,
    exposure: a.exposure,
    envIntensity: night ? 0.2 : low ? 0.24 : 0.26,
    bloomIntensity: 0.45 + a.bloom * 1.15,
    bloomThreshold: night ? 0.82 : low ? 0.95 : 1.12,
    bloomRadius: 0.72,
    grade,
    shadowIntensity: night ? 0.82 : rain ? 0.75 : 0.92,
    weather: a.weather,
    ambientDrift: a.aurora ? 1 : 0,
  };
}
