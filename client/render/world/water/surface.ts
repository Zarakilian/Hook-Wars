// The river surface material: Gerstner waves, scrolled detail normals, ripples, depth absorption,
// refraction (scene capture) or tinted transparency, Fresnel sky + planar reflection, sun glints,
// and every kind of foam (shore, streaks, crests, movers, whirlpool, pours, splashes, tidal surge).
import * as THREE from 'three';
import { FIELD_GLSL } from './field.ts';
import { MAX_RIPPLES, RIPPLE_GLSL } from './ripples.ts';
import { MAX_WAVES } from './waves.ts';

export const MAX_MOVERS = 6;
export const MAX_POURS = 4;
export const MAX_LAMPS = 8;

/** Shared GLSL: ice coverage from the freeze front. uIce = (front m, on, crack, break). */
export const ICE_MASK_GLSL = /* glsl */ `
uniform vec4 uIce;
float iceCover(float chan, float n) {
  if (uIce.y < 0.5) return 0.0;
  // ragged but mostly continuous shelf: few isolated open holes behind the front
  float d = chan + (n - 0.5) * 1.6;
  return 1.0 - smoothstep(uIce.x - 0.4, uIce.x, d);
}
`;

export const HASH_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
mat2 rot2(float a) { float c = cos(a); float s = sin(a); return mat2(c, s, -s, c); }
`;

const vertex = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${FIELD_GLSL}
${RIPPLE_GLSL}
attribute float aFixed;
uniform vec4 uWaveA[${MAX_WAVES}];
uniform vec4 uWaveB[${MAX_WAVES}];
uniform float uLevelY;
uniform float uFullY;
uniform float uWaveDamp;
uniform vec4 uWhirl;
uniform float uWhirlDepth;
uniform float uPuddleMode;
varying vec3 vWorld;
varying vec3 vGN;
varying float vCrest;
varying vec4 vClip;
varying float vViewZ;
varying float vFixed;

void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 f = fieldAt(p.xz);
  float bed = fieldBed(f);
  float chan = fieldChan(f);
  float baseY = mix(uLevelY, uFullY, aFixed);
  // puddles and the low-tide film hug the bed, so they show whatever height the bed has
  baseY = max(baseY, mix(baseY, bed + 0.035, uPuddleMode));
  float depth = baseY - bed;
  float damp = uWaveDamp * smoothstep(-0.8, 1.4, chan) * smoothstep(0.02, 0.7, depth);
  vec3 disp = vec3(0.0);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float crest = 0.0;
  for (int i = 0; i < WAVES; i++) {
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];
    float A = a.z * damp;
    float th = a.w * dot(a.xy, p.xz) - b.x;
    float s = sin(th);
    float c = cos(th);
    disp.xz += b.y * A * a.xy * c;
    disp.y += A * s;
    n.xz -= a.xy * (a.w * A * c);
    n.y -= b.y * a.w * A * s;
    crest += A * s;
  }
  if (uWhirl.w > 0.0) {
    vec2 dv = p.xz - uWhirl.xy;
    float dl = max(length(dv), 1e-3);
    float d = dl / uWhirl.z;
    float g = exp(-d * d * 5.0);
    float fun = g * 0.75 + (1.0 - smoothstep(0.0, 1.0, d)) * 0.25;
    float funP = g * 0.75 * (-10.0 * d) - 0.25 * 6.0 * d * (1.0 - d) * step(d, 1.0);
    float D = uWhirlDepth * uWhirl.w;
    disp.y -= D * fun;
    n.xz += (dv / dl) * (D * funP / uWhirl.z);
  }
  vec4 rip = rippleField(p.xz, false);
  disp.y += rip.x * smoothstep(0.0, 0.3, depth);
  vec3 wp = vec3(p.x + disp.x, baseY + disp.y, p.z + disp.z);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vWorld = wp;
  vGN = n;
  vCrest = crest;
  vClip = gl_Position;
  vViewZ = mvPosition.z;
  vFixed = aFixed;
  #include <fog_vertex>
}
`;

const fragment = /* glsl */ `
#include <common>
#include <packing>
#include <fog_pars_fragment>
${FIELD_GLSL}
${RIPPLE_GLSL}
${ICE_MASK_GLSL}
${HASH_GLSL}
uniform float uTime;
uniform vec4 uScroll;
uniform vec4 uScroll2;
uniform float uSurge;
uniform vec2 uSurgeDir;
uniform float uSurgePhase;
uniform float uPuddleMode;
uniform vec4 uWhirl;
uniform vec3 uWhirlSpin;
uniform float uWhirlSign;
uniform vec4 uMovA[${MAX_MOVERS}];
uniform vec4 uMovB[${MAX_MOVERS}];
uniform int uMovN;
uniform vec4 uPour[${MAX_POURS}];
uniform int uPourN;
uniform vec4 uLampP[${MAX_LAMPS}];
uniform vec3 uLampC[${MAX_LAMPS}];
uniform int uLampN;
uniform vec4 uStyleE; // hue depth (m), scum colour gain, shore band scale, 0
uniform sampler2D uSlope;
uniform sampler2D uNoise;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoamCol;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSpecDir;
uniform vec3 uAmbient;
uniform vec3 uScumCol;
uniform vec4 uStyleA; // clarity, choppy, streaks, shoreFoam
uniform vec4 uStyleB; // scum, oil, rain, reflect
uniform vec4 uStyleC; // glitter, sss, nightLift, refract
uniform vec4 uStyleD; // speck amount, plip, detail tier, puddle level
uniform vec3 uSpeckCol;
uniform float uMurk;
uniform float uHasCapture;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uCamNF;
uniform vec3 uCamFwd;
uniform float uHasReflect;
uniform sampler2D tReflect;
uniform mat4 uReflectMat;
varying vec3 vWorld;
varying vec3 vGN;
varying float vCrest;
varying vec4 vClip;
varying float vViewZ;
varying float vFixed;

vec2 slopeAt(vec2 uv) { return texture2D(uSlope, uv).rg * 2.0 - 1.0; }

vec2 detailSlope(vec2 q) {
  return slopeAt(q * 0.19 + uScroll.xy) * 0.62 + slopeAt(q * 0.47 + uScroll.zw) * 0.38;
}

// expanding rings from raindrops, two staggered cell layers
vec3 rainField(vec2 p) {
  vec3 acc = vec3(0.0);
  for (int l = 0; l < RAIN_LAYERS; l++) {
    float fl = float(l);
    vec2 q = p * 1.9 + fl * vec2(0.37, 0.71);
    vec2 cell = floor(q);
    vec2 h = hash22(cell + fl * 17.0);
    vec2 c = cell + 0.2 + 0.6 * h;
    float ph = fract(uTime * (0.9 + h.x * 0.5) + h.y);
    vec2 d = q - c;
    float dist = length(d) + 1e-4;
    float r = ph * 0.55;
    float x = (dist - r) * 18.0;
    float ring = exp(-x * x) * (1.0 - ph) * (1.0 - ph);
    acc.xy += (d / dist) * (-sin(x * 1.6) * ring) * 0.9;
    acc.z += ring;
  }
  return acc;
}

void main() {
  vec2 p = vWorld.xz;
  vec4 f = fieldAt(p);
  float bed = fieldBed(f);
  float chan = fieldChan(f);
  float noiseA = texture2D(uNoise, p * 0.09).a;

  float ice = iceCover(chan, noiseA);
  // no 'discard' anywhere in this shader: it would switch off early depth rejection for the whole
  // river, and most of the sheet hides under the banks. Hidden fragments write nothing instead.
  if (ice > 0.65) { gl_FragColor = vec4(0.0); return; }

  // puddles / low-tide film: wet rim (darkened sand) around the actual water
  float pmask = 1.0;
  float wetRim = 0.0;
  if (uPuddleMode > 0.001) {
    float raw = max(f.b, f.a * uStyleD.w) + (noiseA - 0.5) * 0.3;
    float wet = mix(1.0, smoothstep(0.06, 0.24, raw), uPuddleMode);
    if (wet < 0.01) { gl_FragColor = vec4(0.0); return; }
    pmask = mix(1.0, smoothstep(0.24, 0.42, raw), uPuddleMode);
    wetRim = (1.0 - pmask) * wet;
  }

  vec3 toCam = cameraPosition - vWorld;
  float viewDist = length(toCam);
  vec3 V = toCam / viewDist;

  // --- whirlpool swirl (two cross-faded phases, like a flow map, so it never winds up)
  float whirlK = 0.0;
  vec2 pA = p;
  vec2 pB = p;
  if (uWhirl.w > 0.0) {
    vec2 d = p - uWhirl.xy;
    float dist = length(d);
    whirlK = (1.0 - smoothstep(0.0, uWhirl.z, dist)) * uWhirl.w;
    float g = whirlK * (uWhirl.z / (dist + 0.9));
    pA = uWhirl.xy + rot2(-uWhirlSpin.x * g * uWhirlSign) * d;
    pB = uWhirl.xy + rot2(-uWhirlSpin.y * g * uWhirlSign) * d;
  }

  // --- slopes: detail layers + Gerstner + ripples (+ rain)
  vec2 sl = detailSlope(pA);
  if (whirlK > 0.001) sl = mix(detailSlope(pB), sl, uWhirlSpin.z);
  float detailFade = 1.0 / (1.0 + viewDist * 0.012);
  sl *= uStyleA.y * 0.32 * detailFade;
  #if DETAIL >= 2
  sl += slopeAt(pA * 1.31 - uScroll.zw * 1.7).rg * 0.07 * uStyleA.y * detailFade;
  #endif
  vec3 gn = normalize(vGN);
  sl += -gn.xz / max(gn.y, 0.2);
  vec4 rip = rippleField(p, true);
  sl += rip.yz;
  float rainRing = 0.0;
  if (uStyleB.z > 0.0) {
    vec3 rf = rainField(p);
    sl += rf.xy * 0.22 * uStyleB.z;
    rainRing = rf.z * uStyleB.z;
  }
  // flatten in puddles and very thin water
  float thickA = max(vWorld.y - bed, 0.0);
  sl *= mix(1.0, 0.35, uPuddleMode) * smoothstep(0.0, 0.08, thickA);
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));

  // --- thickness and refraction
  float thick = thickA;
  vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
  vec3 refr = vec3(0.0);
  bool cap = uHasCapture > 0.5;
  if (cap) {
    float sz = perspectiveDepthToViewZ(texture2D(tDepth, suv).x, uCamNF.x, uCamNF.y);
    float cosA = max(dot(-V, uCamFwd), 0.2);
    float tz = max(vViewZ - sz, 0.0);
    thick = tz / cosA * V.y;
    vec2 off = sl * (0.045 * uStyleC.w) * clamp(thick, 0.0, 1.2) * (34.0 / max(viewDist, 8.0));
    vec2 ruv = suv + off;
    float rz = perspectiveDepthToViewZ(texture2D(tDepth, ruv).x, uCamNF.x, uCamNF.y);
    if (rz > vViewZ - 0.05) ruv = suv;
    refr = texture2D(tColor, ruv).rgb;
  }

  // --- lighting terms
  vec3 irr = (uSunCol * max(uSunDir.y, 0.0) + uAmbient) * RECIPROCAL_PI;
  float clar = uStyleA.x;
  // two depth scales: how far you can see the bed (clarity) and how fast the water's own colour
  // goes from the shallow tint to the deep one (hue depth), so clear lagoons still get a blue middle
  float fogT = 1.0 - exp(-thick / clar);
  float hueT = 1.0 - exp(-thick / uStyleE.x);
  vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 1.0, hueT) * (1.0 - uMurk));
  body *= 1.0 - 0.7 * whirlK * whirlK;
  // the funnel: a dark, deep-looking eye that also swallows the refracted bed
  float whirlEye = 0.0;
  if (uWhirl.w > 0.0) whirlEye = (1.0 - smoothstep(0.0, uWhirl.z * 0.5, length(p - uWhirl.xy))) * min(uWhirl.w, 1.0);
  vec3 bodyLit = body * (irr + uStyleC.z);
  // light glowing through wave crests
  float crestK = smoothstep(0.0, 0.14, vCrest);
  bodyLit += uShallow * irr * uStyleC.y * crestK * 0.9 * (1.0 - fogT * 0.4);

  vec3 under;
  float alpha;
  if (cap) {
    // the bed seen through the water takes the water's hue: turquoise at the edges, blue in the middle
    vec3 hue = body / max(max(body.r, body.g), max(body.b, 1e-3));
    vec3 tint = mix(vec3(1.0), hue, clamp(thick * 0.7 + 0.12 + 0.3 * uPuddleMode, 0.0, 0.85));
    // sand under a film of water looks darker and richer
    tint *= mix(0.7, 1.0, smoothstep(0.0, 0.45, thick));
    under = mix(refr * tint, bodyLit, max(fogT, 0.18 * uPuddleMode));
    alpha = 1.0;
  } else {
    // no capture: a tinted veil over the bed (the bed shows through, coloured like shallow water)
    under = mix(uShallow * (irr + uStyleC.z) * 1.12, bodyLit, smoothstep(0.0, 0.8, max(fogT, hueT * 0.85)));
    alpha = mix(0.5, 1.0, max(fogT, hueT * 0.6));
  }

  under *= 1.0 - 0.55 * whirlEye * whirlEye;

  // --- reflection
  // reflections use a slightly calmer normal so long swells don't paint big sky-coloured blotches
  vec3 Nr = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.35));
  vec3 R = reflect(-V, Nr);
  float ry = clamp(R.y, 0.0, 1.0);
  vec3 sky = mix(uSkyHorizon, uSkyTop, pow(ry, 0.65));
  if (uHasReflect > 0.5) {
    vec4 rp = uReflectMat * vec4(vWorld, 1.0);
    vec2 ruv2 = rp.xy / rp.w + sl * 0.035;
    vec4 rc = texture2D(tReflect, ruv2);
    sky = mix(sky, rc.rgb, 0.85);
  }
  float NdV = clamp(dot(Nr, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  float F = clamp((fres * 3.0 + 0.05) * uStyleB.w * (cap ? 1.0 : 0.75), 0.0, 1.0);

  // oily rainbow sheen
  if (uStyleB.y > 0.0) {
    float on = texture2D(uNoise, pA * 0.11 + uScroll2.zw * 0.08).a;
    float on2 = texture2D(uNoise, pA * 0.29 - uScroll2.zw * 0.05).r;
    float m = smoothstep(0.62, 0.86, on * 0.7 + on2 * 0.4) * uStyleB.y;
    vec3 irid = 0.5 + 0.5 * cos(6.2832 * (on2 * 2.2 + NdV * 1.3 + vec3(0.0, 0.33, 0.67)));
    irid = mix(vec3(dot(irid, vec3(0.333))), irid, 0.55);
    sky = mix(sky, sky * 0.6 + irid * (irr * 0.9 + 0.012), m * 0.45);
    F = mix(F, max(F, 0.22), m);
  }

  // --- sun specular (real sun) and stylised glitter (sun folded in front of the camera)
  // the sharp sun lobe uses an extra-fine normal so the highlight shatters into glitter, not blobs
  #if DETAIL >= 2
  vec2 fineS = (slopeAt(pA * 1.63 + uScroll.xy * 2.6) + slopeAt(pA * 2.71 - uScroll.zw * 1.9)) * 0.11 * uStyleA.y * detailFade;
  #elif DETAIL == 1
  vec2 fineS = slopeAt(pA * 1.63 + uScroll.xy * 2.6) * 0.16 * uStyleA.y * detailFade;
  #else
  vec2 fineS = vec2(0.0);
  #endif
  vec3 Nf = normalize(N + vec3(-fineS.x, 0.0, -fineS.y));
  vec3 H = normalize(V + uSunDir);
  float NdH = max(dot(Nf, H), 0.0);
  float sunUp = smoothstep(-0.05, 0.2, uSunDir.y);
  vec3 spec = uSunCol * (pow(NdH, 3000.0) * 5.0 + pow(max(dot(N, H), 0.0), 220.0) * 0.22) * (0.3 + fres) * sunUp;
  #if DETAIL >= 1
  vec3 H2 = normalize(V + uSpecDir);
  vec2 gq = pA * 11.0 + uScroll.xy * 14.0;
  vec2 gcell = floor(gq);
  float gh = hash12(gcell);
  vec2 gpos = gcell + 0.3 + 0.4 * hash22(gcell + 5.1);
  float gdot = 1.0 - smoothstep(0.08, 0.3, length(gq - gpos));
  vec2 gj = (hash22(gcell + 3.7) - 0.5) * 0.6;
  vec3 Nm = normalize(N + vec3(gj.x, 0.0, gj.y));
  float tw = 0.5 + 0.5 * sin(uTime * (2.5 + gh * 6.0) + gh * 50.0);
  // glitter gathers into a glint path under the (folded) sun instead of salting the whole river:
  // a broad lobe on the calm normal decides where sparkles may live
  float glintPath = pow(max(dot(Nr, H2), 0.0), 70.0);
  float glit = pow(max(dot(Nm, H2), 0.0), 500.0) * step(0.55, gh) * tw * gdot * 6.0 * detailFade * (0.008 + glintPath * 1.8);
  spec += uSunCol * glit * uStyleC.x * 0.5 * sunUp;
  // and the path itself shimmers faintly (broken up by the fine normal so it never reads as marble)
  spec += uSunCol * glintPath * pow(max(dot(Nf, H2), 0.0), 160.0) * 0.04 * uStyleC.x * sunUp;
  #endif

  // --- lamp and lantern light: a warm pool on the water around every lamp, shimmering with the
  // ripples, with sparkles on facets that catch the flame. Stylised on purpose: the lamps stand back
  // from the edge, so a strict mirror reflection would land on the bank and never show.
  vec3 lampSpec = vec3(0.0);
  vec3 lampDiff = vec3(0.0);
  #if DETAIL >= 1
  for (int i = 0; i < ${MAX_LAMPS}; i++) {
    if (i >= uLampN) break;
    vec3 toL = uLampP[i].xyz - vWorld;
    float dh2 = dot(toL.xz, toL.xz);
    float rr = uLampP[i].w;
    if (dh2 > rr * rr * 6.0) continue;
    float d2 = dh2 + toL.y * toL.y;
    vec3 Ld = toL * inversesqrt(d2);
    vec3 Hl = normalize(V + Ld);
    float pool = exp(-dh2 / (rr * rr));
    // high-contrast ripple highlights: broken golden streaks rather than a smooth glow
    float shimmer = pow(max(dot(Nf, Hl), 0.0), 40.0);
    float sparkle = pow(max(dot(Nm, Hl), 0.0), 90.0) * step(0.45, gh) * gdot * (0.6 + 0.4 * tw);
    lampSpec += uLampC[i] * pool * (0.01 + shimmer * 2.2 + sparkle * 4.0);
    lampDiff += uLampC[i] * pool;
  }
  #endif

  // --- foam
  float lace = texture2D(uNoise, pA * 0.42 + uScroll2.zw).g;
  float lace2 = texture2D(uNoise, pA * 0.93 - uScroll2.zw * 1.4).g;
  float foamN = lace * 0.65 + lace2 * 0.5;
  float boilN = 0.0;
  if (uPourN > 0) boilN = texture2D(uNoise, p * 0.7 + vec2(uTime * 0.21, -uTime * 0.17)).g + texture2D(uNoise, p * 1.3 - vec2(uTime * 0.31, uTime * 0.13)).g;
  // the shore band shrinks when the whole river is thin (early flood, low tide), so the middle of a
  // shallow channel never counts as 'shore' and fills with lace
  float sw = (0.2 + 0.32 * uSurge) * uStyleA.w * uStyleE.z;
  float shore = 1.0 - smoothstep(0.0, sw, thick);
  float lap = 0.5 + 0.5 * sin(uTime * 1.4 + chan * 2.5 + noiseA * 7.0);
  float shore2 = exp(-pow((thick - sw * (1.7 + lap * 0.9)) / (sw * 0.4), 2.0)) * (0.45 + uSurge * 0.4);
  float foam = smoothstep(0.3, 0.8, (shore * 1.1 + shore2) * (0.3 + foamN));
  // crisp bright line where the water meets the land, advancing and retreating as it laps
  float lapEdge = 0.05 + 0.07 * lap + uSurge * 0.06;
  float edgeLine = (1.0 - smoothstep(lapEdge * 0.55, lapEdge, thick)) * (0.7 + 0.3 * foamN);
  foam = max(foam, edgeLine * uStyleA.w * mix(1.0, 0.4, uPuddleMode));
  // flowing streaks
  vec2 su = vec2(pA.x * 0.26, pA.y * 0.045) + uScroll2.xy;
  float sn = texture2D(uNoise, su).r;
  // wide soft bands along noise contours, filled with bubbly lace: drifting foam lines, not scratches
  float ridge = 1.0 - smoothstep(0.0, 0.075 + uSurge * 0.04, abs(sn - 0.5));
  #if DETAIL >= 1
  float sn2 = texture2D(uNoise, su * vec2(1.9, 1.4) + 0.37).a;
  ridge = max(ridge, (1.0 - smoothstep(0.0, 0.05, abs(sn2 - 0.5))) * 0.65);
  #endif
  float patchy = smoothstep(0.4, 0.75, texture2D(uNoise, su * 0.45 + vec2(0.13, 0.71)).a);
  float streak = ridge * patchy * smoothstep(0.4, 2.2, chan) * uStyleA.z;
  streak = smoothstep(0.35, 0.95, streak * (0.25 + foamN * 1.05));
  foam = max(foam, streak * (0.75 + uSurge * 0.5));
  // crest whitecaps
  foam = max(foam, smoothstep(0.17 - uSurge * 0.06, 0.28, vCrest) * foamN * 0.45);
  // drifting movers: contact foam, V wake, churned trail
  for (int i = 0; i < ${MAX_MOVERS}; i++) {
    if (i >= uMovN) break;
    vec4 a = uMovA[i];
    vec4 b = uMovB[i];
    vec2 mc = (a.xy + a.zw) * 0.5;
    vec2 ab = a.zw - a.xy;
    if (length(p - mc) > length(ab) * 0.5 + b.x + 7.0) continue;
    float l2 = max(dot(ab, ab), 1e-4);
    float t = clamp(dot(p - a.xy, ab) / l2, 0.0, 1.0);
    float ds = length(p - (a.xy + ab * t)) - b.x;
    if (ds > 9.0) continue;
    float contact = (1.0 - smoothstep(-0.05, 0.32, ds)) * step(-0.4, ds);
    float spd = abs(b.y);
    vec2 md = vec2(0.0, b.y >= 0.0 ? 1.0 : -1.0);
    vec2 rel = p - (a.xy + a.zw) * 0.5;
    float along = dot(rel, md);
    float halfLen = sqrt(l2) * 0.5 + b.x;
    float behind = -along - halfLen * 0.5;
    float lat = abs(rel.x * md.y - rel.y * md.x);
    float bh = max(behind, 0.0);
    float vline = abs(lat - (b.x * 0.8 + bh * 0.36));
    float breakup = smoothstep(0.35, 0.85, foamN + (lace2 - 0.5) * 0.4);
    float wake = (1.0 - smoothstep(0.0, 0.12 + bh * 0.06, vline)) * step(0.0, behind) * exp(-bh * 0.6) * breakup;
    float trail = (1.0 - smoothstep(0.0, b.x * 1.0, lat)) * smoothstep(-halfLen, 0.0, behind) * exp(-bh * 0.8) * 0.6 * breakup;
    float bow = (1.0 - smoothstep(0.0, 0.4, abs(ds - 0.2))) * smoothstep(0.0, halfLen, along) * 0.5;
    float k = clamp(spd * 0.7, 0.0, 1.0);
    foam = max(foam, smoothstep(0.1, 0.9, (contact * (0.2 + foamN * 0.7) + (wake * 0.75 + trail + bow) * k * (0.3 + foamN * 0.7)) * b.z));
  }
  // whirlpool spiral arms
  if (whirlK > 0.001) {
    vec2 d = p - uWhirl.xy;
    float dist = length(d);
    float ang = atan(d.y, d.x);
    float arms = sin(ang * 3.0 + (log(dist + 0.25) * 7.5 - uTime * 2.4) * uWhirlSign);
    float arms2 = sin(ang * 5.0 + (log(dist + 0.25) * 11.0 - uTime * 3.1) * uWhirlSign + 1.3);
    float spiral = (smoothstep(0.5, 0.95, arms) + smoothstep(0.75, 1.0, arms2) * 0.5) * whirlK * smoothstep(0.2, 1.2, dist);
    foam = max(foam, spiral * (0.35 + foamN) * 0.95);
  }
  // pours (waterfall base, lock sluices)
  for (int i = 0; i < ${MAX_POURS}; i++) {
    if (i >= uPourN) break;
    vec4 pr = uPour[i];
    // radius sign = the direction the water pours along z; the boil trails off downstream
    float rad = abs(pr.z);
    vec2 dd = (p - pr.xy) / rad;
    float down = dd.y * sign(pr.z);
    dd.y *= down > 0.0 ? 0.42 : 1.0;
    float d = length(dd);
    if (d > 1.0) continue;
    float churn = (1.0 - smoothstep(0.15, 1.0, d)) * pr.w;
    // no texture fetches inside the loop (derivatives are undefined in divergent loops)
    float boil = boilN + 0.35 * sin(d * 9.0 - uTime * 7.0 + noiseA * 6.0);
    // dense white boil at the plunge, breaking into lace as it drifts away
    float lacy = mix(1.0, foamN * 1.3, smoothstep(0.25, 0.9, max(down, 0.0) * 0.42 + d * 0.5));
    foam = max(foam, smoothstep(0.2, 0.8, churn * (0.42 + boil * 0.6) * lacy));
  }
  // splashes and wakes
  foam = max(foam, smoothstep(0.12, 0.8, clamp(rip.w, 0.0, 1.2) * (0.45 + foamN * 0.75)));
  // rising tide: rolling surge bands
  if (uSurge > 0.001) {
    // (0,0) = lock floods: bands roll inward from both ends of the canal
    float along = dot(uSurgeDir, uSurgeDir) > 0.0 ? dot(p, uSurgeDir) : -abs(p.y);
    float band = sin(along * 0.85 - uSurgePhase + noiseA * 2.0);
    float bands = smoothstep(0.72, 1.0, band) * uSurge * (0.35 + foamN) * smoothstep(0.2, 1.4, chan);
    foam = max(foam, bands);
  }
  // slush at the ice edge
  foam = max(foam, smoothstep(0.05, 0.6, ice) * (0.6 + foamN * 0.4));
  foam = clamp(foam, 0.0, 1.0) * mix(1.0, 0.1, uPuddleMode);
  foam = max(foam, clamp(rip.w, 0.0, 1.0) * (0.4 + foamN * 0.75) * uPuddleMode * 0.7);

  // --- swamp film (duckweed) and drifting specks
  float scum = 0.0;
  if (uStyleB.x > 0.0) {
    float sn = texture2D(uNoise, pA * 0.09 + uScroll2.zw * 0.12).r;
    float sn2 = texture2D(uNoise, pA * 0.31 - uScroll2.zw * 0.2).a;
    // mats cling to the banks and drift in a few loose rafts mid-channel, so most of the swamp
    // stays open, glossy water that reads as water from the camera
    float near = 1.0 - smoothstep(0.1, 2.2, chan);
    float sm = sn * 0.75 + sn2 * 0.35 + near * 0.34;
    float mat = smoothstep(0.71, 0.83, sm);
    // duckweed reads as dots at the ragged edge of each mat
    float dots = smoothstep(0.5, 0.82, lace2);
    scum = max(mat * (0.75 + lace * 0.3), smoothstep(0.6, 0.71, sm) * dots * 0.75);
    scum *= uStyleB.x * (1.0 - whirlK);
    scum = clamp(scum, 0.0, 0.95);
  }
  float speck = 0.0;
  if (uStyleD.x > 0.0) {
    vec2 sc = pA * 3.2 + uScroll2.xy * 6.0;
    vec2 cell = floor(sc);
    float hs = hash12(cell);
    vec2 cp = cell + 0.25 + 0.5 * hash22(cell + 1.7);
    speck = (1.0 - smoothstep(0.03, 0.09, length(sc - cp))) * step(0.93, hs) * uStyleD.x * smoothstep(0.3, 1.5, chan);
  }

  // --- compose
  vec3 col = mix(under, sky, F);
  // lamplight scattering in the water body, then the glints on top
  col += body * lampDiff * 0.35 * (1.0 - F);
  col += spec * (1.0 - foam) * (1.0 - scum);
  col += lampSpec * (1.0 - foam * 0.7) * (1.0 - scum * 0.8);
  col += uFoamCol * rainRing * 0.04 * (irr + 0.05);
  // ripple crests catch the light so rings read even on calm, dark water
  col += uFoamCol * (irr + uStyleC.z * 2.0 + 0.01) * clamp(rip.x * 6.0, 0.0, 0.5) * (1.0 - foam);
  vec3 scumLit = uScumCol * (irr * 0.9 + uStyleC.z + lampDiff * 0.3) * (0.75 + lace * 0.4) * uStyleE.y;
  col = mix(col, scumLit, scum);
  col = mix(col, uSpeckCol * (irr + uStyleC.z), speck);
  vec3 foamLit = uFoamCol * (irr * 1.15 + uStyleC.z * 3.0 + 0.012 + lampDiff * 0.3);
  col = mix(col, foamLit, foam);

  alpha = max(alpha, max(F * 0.9, max(foam, max(scum, speck))));
  float edge = smoothstep(0.0, 0.018, thick);
  alpha *= edge * pmask;
  if (wetRim > 0.001) {
    // the damp ring around a puddle: no reflection, just darker sand
    vec3 wetCol = cap ? refr * 0.64 : vec3(0.0);
    float wetA = cap ? 1.0 : 0.3;
    col = mix(col, wetCol, wetRim * (1.0 - pmask * 0.0));
    alpha = max(alpha, wetRim * wetA * smoothstep(0.0, 0.03, thickA + 0.02));
  }
  alpha *= 1.0 - smoothstep(0.3, 0.65, ice);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface SurfaceUniforms {
  [k: string]: THREE.IUniform;
}

export function createSurfaceMaterial(uniforms: SurfaceUniforms, waves: number, detail: number): THREE.ShaderMaterial {
  const all: SurfaceUniforms = { ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]), ...uniforms };
  const m = new THREE.ShaderMaterial({
    uniforms: all,
    vertexShader: vertex,
    fragmentShader: fragment,
    defines: { WAVES: waves, DETAIL: detail, RAIN_LAYERS: detail >= 2 ? 2 : 1 },
    transparent: true,
    depthWrite: true,
    fog: true,
    side: THREE.FrontSide,
  });
  m.name = 'hw-water-surface';
  return m;
}
