// Epic (cinematic) water: what the river adds under the Steam build's "Epic" graphics setting.
//
// Built only when cinematic mode is on as the match starts (createWater reads cinematicEnabled()). With it
// off nothing here runs: the river shader sources, its uniforms and every uniform value stay the normal
// ones, byte for byte. The Epic fragment shader is the normal one with code inserted at fixed anchors
// (epicFragment); a missing anchor throws, so when the normal shader changes its Epic variant must follow.
//
// On top of the ultra water, tuned against the reference images (refs 04 to 07):
// - the engine's lantern pool (LANTERN_UNIFORMS: the same lights as the cinematic PointLights, so the water
//   follows the props' exact lamp positions too): warm glints on the ripple facets and a soft wet sheen,
//   both stretched toward the camera into broken streaks, and lantern light caught by rain rings, ripple
//   crests, foam and the swamp film
// - longer, brighter, more broken lamp streaks (the water's own anchored lamp streaks) with a fainter
//   round pool under each lamp
// - a sharper, stronger mirror (less ripple smear on the planar reflection, less calming of the normal)
// - a denser, sharper sun / moon glitter path
// - aurora maps: green and violet ribbons laid across the leads in world space (the sky-dome mirror of the
//   aurora mostly misses at the gameplay pitch)
// - per map: Maelstrom's turquoise clarity, Aurora's teal under the aurora, Mirelight's dark sunset mirror,
//   Lanternwharf's black canal with long warm streaks
// The planar reflection itself is left as it is (half resolution): at this camera pitch it shows the sky,
// and the voxel lamp heads have no bottom faces, so they never appear in the mirror.
import * as THREE from 'three';
import type { MapDef } from '../../../../shared/maps/types.ts';
import { LANTERN_GLSL, LANTERN_UNIFORMS, MAX_LANTERN_UNIFORMS } from '../../look/lanterns.ts';
import type { WaterStyle } from './style.ts';

/** WaterStyle values Epic may replace: shading only (never the waves, whirlpool or plips: those feed the CPU height and random calls) */
export type EpicStyle = Partial<
  Pick<
    WaterStyle,
    | 'clarity'
    | 'choppy'
    | 'caustics'
    | 'streaks'
    | 'oil'
    | 'reflect'
    | 'glitter'
    | 'sss'
    | 'nightLift'
    | 'refract'
    | 'murk'
    | 'hueDepth'
    | 'scumGain'
    | 'sunsetGlow'
    | 'auroraRefl'
    | 'lampStreak'
  >
>;

export interface EpicWater {
  style: EpicStyle;
  /** water colours (sRGB hex) replacing the atmosphere's on the river sheet, -1 = keep */
  shallow: number;
  deep: number;
  /** planar reflection: mix toward it (normal 0.85), ripple smear scale (normal 1), calm-normal scale (lower = livelier, normal 1) */
  reflMix: number;
  reflWarp: number;
  calm: number;
  /** the anchored lamp streaks: length scale, width scale, ripple highlight gain, broken-bar glow gain (normal 1, 1, 1, 1) */
  lampLen: number;
  lampWidth: number;
  lampGain: number;
  lampGlow: number;
  /** the round warm pool under each lamp (its glow in the water body), normal 1 */
  lampBlob: number;
  /** the glitter dots in the lamp streaks, normal 1 */
  lampSpark: number;
  /** metres a bank lamp's streak starts further out in open water than the normal anchor (normal 0) */
  lampReach: number;
  /** least break-up of a streak into ripple bars, 0..1 (normal: the map's lampStreak) */
  lampBreak: number;
  /**
   * the lantern pool's reflection: a sharp glint on the ripple facets and a soft wet sheen on the calm
   * normal, both stretched toward the camera into streaks (anisotropic lobes). Glint gain, glint
   * half-width across the streak and its length along it (slope units: smaller = sharper / shorter),
   * sheen gain, and the light caught by rain rings / ripple crests / foam / film
   */
  poolGlint: number;
  poolWidth: number;
  poolLength: number;
  poolSheen: number;
  poolRipple: number;
  /** sun / moon glitter path: shimmer gain, sparkle gain, path lobe exponent (lower = wider), sparkle floor off the path */
  pathGain: number;
  sparkGain: number;
  pathPow: number;
  sparkFloor: number;
  /** how much of the scene fog the river keeps (1 = all; the river ends always keep all, to meet the backdrop water) */
  fogKeep: number;
  /**
   * aurora maps: green and violet ribbons laid across the leads in world space, broken by the ripples
   * (the sky-dome mirror of the aurora mostly misses at the gameplay pitch). 0 = none
   */
  auroraWorld: number;
  /** where the green and the violet ribbons start (smoothstep low edge on their wave, 0..1: higher = narrower bands) */
  auroraEdge: number;
  auroraEdge2: number;
}

const BASE: EpicWater = {
  style: {},
  shallow: -1,
  deep: -1,
  reflMix: 0.9,
  reflWarp: 0.6,
  calm: 1,
  lampLen: 1.3,
  lampWidth: 0.85,
  lampGain: 1.6,
  lampGlow: 1.8,
  lampBlob: 0.6,
  lampSpark: 0.6,
  lampReach: 0.3,
  lampBreak: 0.8,
  poolGlint: 2.4,
  poolWidth: 0.03,
  poolLength: 0.5,
  poolSheen: 0.15,
  poolRipple: 1,
  pathGain: 1,
  sparkGain: 0.5,
  pathPow: 60,
  sparkFloor: 0.006,
  fogKeep: 0.85,
  auroraWorld: 0,
  auroraEdge: 0.55,
  auroraEdge2: 0.7,
};

const BY_MAP: Partial<Record<MapDef['id'], Partial<EpicWater>>> = {
  // rainy canal city: a black, glossy canal; long broken warm streaks under every lamp, rain rings that
  // catch the lamplight, a cool sheen from the moon
  lanternwharf: {
    style: { oil: 0.3, nightLift: 0.012, reflect: 0.9, murk: 0.05 },
    shallow: 0x0e1418,
    deep: 0x010203,
    reflMix: 0.92,
    reflWarp: 0.5,
    lampLen: 1.8,
    lampWidth: 0.7,
    lampGain: 2.4,
    lampGlow: 2.6,
    lampBlob: 0.5,
    lampSpark: 0.5,
    lampReach: 0.7,
    poolGlint: 4.8,
    poolLength: 0.7,
    poolSheen: 0.6,
    poolRipple: 1.3,
    pathGain: 0.8,
    sparkGain: 0.4,
    pathPow: 50,
    sparkFloor: 0.002,
    fogKeep: 0.45,
  },
  // braided sunset marsh: a dark, still mirror of the dusk sky, the low sun laying a broken path across it.
  // The mirror stays at the normal strength (a stronger one turns the marsh mauve); the water goes darker
  mirelight: {
    style: { murk: 0.2, sunsetGlow: 1.5, nightLift: 0.012, lampStreak: 0.5 },
    shallow: 0x1a2022,
    deep: 0x030506,
    reflMix: 0.92,
    reflWarp: 0.5,
    lampLen: 1.4,
    lampGain: 1.8,
    lampGlow: 2.0,
    lampBlob: 0.25,
    poolGlint: 2.4,
    // short warm columns under each lamp, as in ref04 (0.6 drew unbroken ribbons to the frame edge on the calm marsh)
    poolLength: 0.3,
    poolSheen: 0.08,
    sparkGain: 0.6,
    fogKeep: 0.7,
  },
  // night harbour of floes: deep navy-black leads (ref05), the aurora laid across them as narrow, bright green
  // and violet bands, warm lamp streaks. A lighter mirror and a weaker sky aurora than before: the Fresnel sky
  // plus a wide ribbon washed the leads out to a milky teal
  aurora: {
    style: { clarity: 1.3, hueDepth: 0.55, auroraRefl: 1.0, reflect: 0.95, nightLift: 0.03, lampStreak: 0.55 },
    shallow: 0x135a6a,
    deep: 0x020f1c,
    reflMix: 0.9,
    reflWarp: 0.55,
    lampLen: 1.5,
    lampWidth: 0.75,
    lampGain: 1.8,
    lampGlow: 2.0,
    lampBlob: 0.3,
    // lower than the other night maps: at 2.4 the lantern glint clipped to a white streak along the floes
    poolGlint: 1.3,
    poolLength: 0.6,
    poolSheen: 0.1,
    pathGain: 1.2,
    sparkGain: 0.8,
    fogKeep: 0.7,
    auroraWorld: 2.2,
    auroraEdge: 0.8,
    auroraEdge2: 0.86,
  },
  // bright turquoise cove: clear teal-turquoise water over white sand (ref06 measures ~#388590 to #2a6973 in
  // open water: greener and deeper than the normal sky-tinted cyan), a lighter mirror and softer caustics so
  // the colour reads, the whirlpool's white foam, a little sun sparkle
  maelstrom: {
    style: { clarity: 3.8, hueDepth: 0.6, reflect: 0.3, choppy: 0.3, sss: 1.25, caustics: 0.6 },
    shallow: 0x30bcb0,
    deep: 0x053e50,
    reflMix: 0.85,
    reflWarp: 0.7,
    lampGain: 1,
    lampGlow: 1,
    lampBlob: 1,
    poolGlint: 1.6,
    poolSheen: 0.05,
    pathGain: 0.7,
    sparkGain: 0.3,
    pathPow: 45,
    sparkFloor: 0.001,
    fogKeep: 1,
  },
};

/** The Epic look for a map (the defaults for maps without their own entry). */
export function epicWater(map: MapDef): EpicWater {
  const own = BY_MAP[map.id] ?? {};
  return { ...BASE, ...own, style: { ...(own.style ?? {}) } };
}

/** Epic uniforms (shared by the surface and the caps), plus the engine's lantern pool. */
export function epicUniforms(e: EpicWater): Record<string, THREE.IUniform> {
  return {
    uEpicA: { value: new THREE.Vector4(e.reflMix, e.reflWarp, e.calm, e.lampBlob) },
    uEpicB: { value: new THREE.Vector4(e.lampLen, e.lampWidth, e.lampGain, e.lampGlow) },
    uEpicC: { value: new THREE.Vector4(e.poolGlint, e.poolWidth, e.poolSheen, e.poolRipple) },
    uEpicD: { value: new THREE.Vector4(e.pathGain, e.sparkGain, e.pathPow, e.sparkFloor) },
    uEpicE: { value: new THREE.Vector4(e.fogKeep, e.lampSpark, e.lampBreak, e.poolLength) },
    uEpicF: { value: new THREE.Vector4(e.auroraWorld, e.auroraEdge, e.auroraEdge2, 0) },
    hwLanternPos: LANTERN_UNIFORMS.hwLanternPos,
    hwLanternCol: LANTERN_UNIFORMS.hwLanternCol,
    hwLanternCount: LANTERN_UNIFORMS.hwLanternCount,
  };
}

interface Edit {
  at: string;
  /** inserted after the anchor */
  add?: string;
  /** replaces the anchor */
  put?: string;
}

/** Insert code at fixed anchors (each must occur exactly once). Throws on a missing or repeated anchor. */
export function cineEdit(src: string, edits: Edit[]): string {
  let s = src;
  for (const e of edits) {
    const i = s.indexOf(e.at);
    if (i < 0) throw new Error('[water] Epic shader anchor missing: ' + e.at.trim());
    if (s.indexOf(e.at, i + 1) >= 0) throw new Error('[water] Epic shader anchor not unique: ' + e.at.trim());
    s = s.slice(0, i) + (e.put ?? e.at + (e.add ?? '')) + s.slice(i + e.at.length);
  }
  return s;
}

const DECL = /* glsl */ `${LANTERN_GLSL}
uniform vec4 uEpicA; // planar reflection mix, ripple smear, calm-normal scale, lamp pool (blob) gain
uniform vec4 uEpicB; // lamp streaks: length, width, ripple highlight gain, broken-bar glow gain
uniform vec4 uEpicC; // lantern pool: glint gain, streak half-width (slope), wet sheen gain, ring / crest / foam light
uniform vec4 uEpicD; // glitter path gain, sparkle gain, path lobe exponent, sparkle floor off the path
uniform vec4 uEpicE; // fog kept on the river (1 = all), lamp sparkle gain, lamp streak break-up floor, pool streak length (slope)
uniform vec4 uEpicF; // aurora ribbons across the leads (world space): gain, green ribbon edge, violet ribbon edge, 0
`;

// the river keeps only part of the scene fog (a darker, clearer surface); the river ends keep all of it,
// so the river still meets the terrain's backdrop water without an edge
const FOG = /* glsl */ `  #ifdef USE_FOG
  #ifdef FOG_EXP2
  float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * mix(uEpicE.x, 1.0, endK));
  #endif
`;

// the lantern pool at this point: a sharp glint on the ripple facets, a soft wet sheen on the calm normal,
// and the light arriving (for rain rings, ripple crests, foam and film). One loop over the pool.
// Both lobes are anisotropic (Ward-like, on the half vector's tilt away from the normal): narrow across
// the view and long along it, so each lantern lays a broken warm streak toward the camera, as lamps do on
// a wet canal, instead of a round spot or an even salt of glints.
const POOL = /* glsl */ `  vec3 epicGlint = vec3(0.0);
  vec3 epicSheen = vec3(0.0);
  vec3 epicLight = vec3(0.0);
  {
    vec3 Ne = normalize(vec3(-slDet.x - fineS.x, 1.0, -slDet.y - fineS.y));
    vec2 efw = normalize(uCamFwd.xz + vec2(0.0, 1e-4));
    vec3 eT = vec3(efw.y, 0.0, -efw.x);
    vec3 eB = vec3(efw.x, 0.0, efw.y);
    vec2 gW = 1.0 / vec2(uEpicC.y, uEpicE.w);
    vec2 sW = gW / vec2(2.5, 1.6);
    for (int i = 0; i < ${MAX_LANTERN_UNIFORMS}; i++) {
      if (i >= hwLanternCount) break;
      vec3 d = hwLanternPos[i].xyz - vWorld;
      float d2 = max(dot(d, d), 1e-4);
      float range = hwLanternPos[i].w;
      float fall = pow(clamp(1.0 - d2 * d2 / pow(range * 1.6, 4.0), 0.0, 1.0), 2.0) / max(d2, 0.25);
      if (fall <= 0.0) continue;
      vec3 l = d * inversesqrt(d2);
      vec3 h = normalize(l + V);
      float hg = max(dot(h, Ne), 0.05);
      vec3 tg = h - Ne * hg;
      vec2 ga = vec2(dot(tg, eT), dot(tg, eB)) * gW / hg;
      float g = exp(-dot(ga, ga));
      float hs = max(dot(h, Nr), 0.05);
      vec3 ts = h - Nr * hs;
      vec2 sa = vec2(dot(ts, eT), dot(ts, eB)) * sW / hs;
      float s = exp(-dot(sa, sa));
      vec3 lc = hwLanternCol[i] * fall;
      epicGlint += lc * g;
      epicSheen += lc * s;
      epicLight += lc;
    }
  }
`;

// aurora maps: green-to-teal ribbons with a violet fringe laid across the water in world space and broken
// by the ripples, so the leads glow with the aurora at the gameplay pitch too (goes through the mirror's
// Fresnel weight like the rest of the sky)
const AURORA = /* glsl */ `  if (uStyleF.y > 0.0 && uEpicF.x > 0.0) {
    vec2 aq = p + slDet * 9.0;
    float w1 = sin(aq.y * 0.35 + 1.5 * sin(aq.x * 0.2 + uTime * 0.05) + uTime * 0.04);
    float w2 = sin(aq.y * 0.23 + aq.x * 0.1 - 1.2 * sin(aq.x * 0.15 - uTime * 0.03) + 2.1);
    float rib = smoothstep(uEpicF.y, 1.0, w1);
    float rib2 = smoothstep(uEpicF.z, 1.0, w2) * 0.7;
    float arays = 0.4 + 0.6 * texture2D(uNoise, vec2(aq.x * 0.06 + uTime * 0.006, aq.y * 0.02)).g;
    vec3 agw = mix(vec3(0.1, 1.0, 0.45), vec3(0.15, 0.8, 1.0), 0.3 + 0.3 * sin(aq.x * 0.05 + aq.y * 0.07));
    epicSky += (agw * rib + mix(agw, vec3(0.7, 0.28, 1.0), 0.7) * rib2) * arays * uStyleF.y * uEpicF.x;
  }
`;

// the glitter path: a second, finer and sharper sparkle layer that gathers under the (folded) sun / moon,
// and a brighter shimmer along the path itself
const GLITTER = /* glsl */ `  {
    vec2 eq = pA * 23.0 + uScroll.zw * 9.0;
    vec2 ec = floor(eq);
    float eh = hash12(ec + 11.3);
    vec2 ep = ec + 0.3 + 0.4 * hash22(ec + 2.9);
    float edot = 1.0 - smoothstep(0.05, 0.24, length(eq - ep));
    vec2 ej = (hash22(ec + 8.1) - 0.5) * 0.7;
    vec3 Ne2 = normalize(N + vec3(ej.x, 0.0, ej.y));
    float etw = 0.5 + 0.5 * sin(uTime * (4.0 + eh * 7.0) + eh * 40.0);
    float ePath = pow(max(dot(Nr, H2), 0.0), uEpicD.z);
    spec += uSunCol * pow(max(dot(Ne2, H2), 0.0), 800.0) * step(0.6, eh) * etw * edot * 7.0 * detailFade * (uEpicD.w + ePath * 2.2) * uEpicD.y * uStyleC.x * sunUp;
    spec += uSunCol * ePath * pow(max(dot(Nf, H2), 0.0), 220.0) * 0.05 * uEpicD.x * uStyleC.x * sunUp;
  }
`;

/** The Epic fragment shader: the normal river fragment shader with the Epic code inserted at its anchors. */
export function epicFragment(fragment: string): string {
  return cineEdit(fragment, [
    { at: 'uniform mat4 uReflectMat;\n', add: DECL },
    // a livelier mirror normal, a sharper planar reflection
    {
      at: '  vec3 Nr = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.35 + 0.45 * uStyleF.x));\n',
      put: '  vec3 Nr = normalize(mix(N, vec3(0.0, 1.0, 0.0), (0.35 + 0.45 * uStyleF.x) * uEpicA.z));\n',
    },
    { at: '    vec2 ruv2 = rp.xy / rp.w + sl * 0.035;\n', put: '    vec2 ruv2 = rp.xy / rp.w + sl * (0.035 * uEpicA.y);\n' },
    { at: '    sky = mix(sky, rc.rgb, 0.85);\n', put: '    sky = mix(sky, rc.rgb, uEpicA.x);\n' },
    // the sunset path and the aurora go on top of the mirror (the planar reflection would otherwise
    // replace most of them: at this pitch it only sees the zenith of the sky dome)
    { at: '  if (uStyleF.x > 0.0) {\n', put: '  vec3 epicSky = vec3(0.0);\n  if (uStyleF.x > 0.0) {\n' },
    { at: '    sky += (uSunCol * 0.3 + uSkyHorizon * 0.9) * path * low * uStyleF.x;\n', put: '    epicSky += (uSunCol * 0.3 + uSkyHorizon * 0.9) * path * low * uStyleF.x;\n' },
    { at: '    sky += ac * rays * uStyleF.y * 0.75;\n', put: '    epicSky += ac * rays * uStyleF.y * 0.75;\n' },
    { at: '  if (uHasReflect > 0.5) {\n', put: AURORA + '  if (uHasReflect > 0.5) {\n' },
    { at: '  float NdV = clamp(dot(Nr, V), 0.0, 1.0);\n', put: '  sky += epicSky;\n  float NdV = clamp(dot(Nr, V), 0.0, 1.0);\n' },
    // the glitter path: finer, sharper sparkle under the sun / moon
    { at: '  spec += uSunCol * glintPath * pow(max(dot(Nf, H2), 0.0), 160.0) * 0.04 * uStyleC.x * sunUp;\n', add: GLITTER },
    { at: '  float glit = pow(max(dot(Nm, H2), 0.0), 500.0) * step(0.55, gh) * tw * gdot * 6.0 * detailFade * (0.008 + glintPath * 1.8);\n', put: '  float glit = pow(max(dot(Nm, H2), 0.0), 500.0) * step(0.55, gh) * tw * gdot * 6.0 * detailFade * (uEpicD.w + glintPath * 1.8);\n' },
    // lamp streaks: longer, narrower, more broken, brighter, with a fainter round pool
    { at: '  float stretch = 1.0 + uStyleF.z * 2.8;\n', put: '  float stretch = 1.0 + uStyleF.z * 2.8 * uEpicB.x;\n' },
    {
      at: '  float dashes = mix(1.0, 0.08 + 1.9 * smoothstep(0.42, 0.85, dashN), uStyleF.z);\n',
      put: '  float dashes = mix(1.0, 0.04 + 2.1 * smoothstep(0.45, 0.82, dashN), max(min(uStyleF.z, 1.0), uEpicE.z));\n',
    },
    { at: '    float W = 1.0 - 0.4 * uStyleF.z;\n', put: '    float W = (1.0 - 0.4 * min(uStyleF.z, 1.0)) * uEpicB.y;\n' },
    {
      at: '    lampSpec += uLampC[i] * pool * (0.006 + (shimmer * (1.5 + uStyleF.z * 2.6) + sparkle * 4.0 + uStyleF.z * 0.07) * bands);\n',
      put: '    lampSpec += uLampC[i] * pool * (0.006 * uEpicA.w + (shimmer * (1.5 + uStyleF.z * 2.6) * uEpicB.z + sparkle * 4.0 * uEpicE.y + uStyleF.z * 0.07 * uEpicB.w) * bands);\n',
    },
    { at: '  // --- foam\n', put: POOL + '\n  // --- foam\n' },
    { at: '  col += body * lampDiff * 0.35 * (1.0 - F);\n', put: '  col += body * lampDiff * 0.35 * uEpicA.w * (1.0 - F);\n' },
    {
      at: '  col += lampSpec * (1.0 - foam * 0.7) * (1.0 - scum * 0.8);\n',
      add: '  col += (epicGlint * uEpicC.x + epicSheen * uEpicC.z) * (1.0 - foam * 0.7) * (1.0 - scum * 0.8);\n',
    },
    {
      at: '  col += uFoamCol * (irr + uStyleC.z * 2.0 + 0.01) * clamp(rip.x * 6.0, 0.0, 0.5) * (1.0 - foam);\n',
      add: '  col += uFoamCol * epicLight * (rainRing * 0.12 + clamp(rip.x * 6.0, 0.0, 0.5) * 0.2 * (1.0 - foam)) * uEpicC.w;\n',
    },
    {
      at: '  vec3 scumLit = uScumCol * (irr * 0.9 + uStyleC.z + lampDiff * 0.3) * (0.75 + lace * 0.4) * uStyleE.y;\n',
      put: '  vec3 scumLit = uScumCol * (irr * 0.9 + uStyleC.z + lampDiff * 0.3 + epicLight * 0.03 * uEpicC.w) * (0.75 + lace * 0.4) * uStyleE.y;\n',
    },
    {
      at: '  vec3 foamLit = uFoamCol * (irr * 1.15 + uStyleC.z * 3.0 + 0.012 + lampDiff * 0.3);\n',
      put: '  vec3 foamLit = uFoamCol * (irr * 1.15 + uStyleC.z * 3.0 + 0.012 + lampDiff * 0.3 + epicLight * 0.025 * uEpicC.w);\n',
    },
    { at: '  #include <fog_fragment>\n', put: FOG },
  ]);
}
