// Frozen river: a walkable ice sheet (MeshStandardMaterial + onBeforeCompile so it gets the engine's
// lights and receives unit shadows) with clear black ice in the middle, milky frost at the banks,
// a Voronoi crack network that grows during 'cracking', glints, drifting snow dust, a slushy front
// that spreads from the banks while 'freezing', and a break-up when the thaw arrives.
import * as THREE from 'three';
import { FIELD_GLSL } from './field.ts';
import { CAP_GLSL, HASH_GLSL, ICE_MASK_GLSL } from './surface.ts';

const VORONOI_GLSL = /* glsl */ `
// x = F1, y = distance to the nearest cell border, z = cell id hash
vec3 voronoi(vec2 p) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  vec2 mg = vec2(0.0);
  vec2 mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float be = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    vec2 r = g + o - f;
    if (dot(mr - r, mr - r) > 0.00001) be = min(be, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec3(sqrt(md), be, hash12(n + mg));
}
`;

export interface IceUniforms {
  [k: string]: THREE.IUniform;
}

export function createIceMaterial(u: IceUniforms, detail: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.2,
    metalness: 0,
    transparent: true,
    depthWrite: true,
  });
  m.name = 'hw-water-ice';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.defines = { ...(shader.defines ?? {}), ICE_DETAIL: detail };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${FIELD_GLSL}
uniform float uIceY;
uniform float uTime;
uniform vec4 uIce;
varying vec2 vIceP;
varying float vIceChan;`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
vec4 fI = fieldAt(position.xz);
vIceChan = fieldChan(fI);
vIceP = position.xz;
float wob = sin(position.x * 1.9 + uTime * 13.0) * sin(position.z * 1.4 - uTime * 11.0);
transformed.y = uIceY + wob * 0.014 * uIce.z * (1.0 - uIce.z * 0.3) * smoothstep(0.5, 1.5, vIceChan) - smoothstep(0.65, 1.0, uIce.w) * 0.14;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${FIELD_GLSL}
${ICE_MASK_GLSL}
${HASH_GLSL}
${VORONOI_GLSL}
${CAP_GLSL}
uniform float uUnderGlow;
uniform vec3 uGlowCol;
uniform float uTime;
uniform sampler2D uNoise;
uniform vec3 uIceDeep;
uniform vec3 uIceMilky;
uniform vec3 uSnowCol;
uniform vec3 uCrackGlow;
uniform vec3 uSpecDir;
uniform vec3 uSunCol;
uniform vec2 uWind;
varying vec2 vIceP;
varying float vIceChan;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec2 ip = vIceP;
float chanI = vIceChan;
float nA = texture2D(uNoise, ip * 0.09).a;
float cover = iceCover(chanI, nA);
// big plates and fine hairline cracks
vec3 vb = voronoi(ip * 0.42 + vec2(nA * 0.6, 0.0));
vec3 vf = voronoi(ip * 1.35 + 7.3);
float brk = uIce.w;
float plateGone = smoothstep(vb.z - 0.06, vb.z + 0.02, brk * 1.25 - 0.1);
cover *= 1.0 - plateGone;
if (cover < 0.01) discard;
float crack = uIce.z;
float deep = smoothstep(0.4, 3.6, chanI);
float frost = texture2D(uNoise, ip * 0.31).r;
float frost2 = texture2D(uNoise, ip * 0.11 + 0.5).a;
vec3 c = mix(uIceMilky, uIceDeep, deep * (0.62 + 0.38 * frost2));
c = mix(c, uIceMilky, smoothstep(0.58, 0.9, frost) * 0.55);
// trapped bubbles in the clear ice
float bub = texture2D(uNoise, ip * 0.75).g;
c = mix(c, uIceMilky * 1.05, bub * 0.22 * deep);
// hairline cracks always there, white (fractured ice scatters light)
float hair = (1.0 - smoothstep(0.0, 0.018, vf.y)) * smoothstep(0.35, 0.75, hash12(floor(ip * 1.35 + 7.3) + 0.5) + 0.25);
c = mix(c, uIceMilky * 1.08, hair * 0.55);
// big plate cracks: faint seams while frozen, open dark water cracks with a white rim while cracking
float seamW = 0.02 + crack * 0.07 + brk * 0.12;
float seam = 1.0 - smoothstep(0.0, seamW, vb.y);
float rim = (1.0 - smoothstep(seamW, seamW + 0.06 + crack * 0.05, vb.y)) - seam;
float grown = smoothstep(vb.z - 0.15, vb.z + 0.05, crack * 1.25);
float openC = seam * max(grown, brk);
c = mix(c, uIceMilky * 1.1, max(rim, 0.0) * (0.25 + grown * 0.6) + seam * 0.3 * (1.0 - grown));
c = mix(c, uIceDeep * 0.35, openC * 0.92);
// snow dust: drifts at the banks and wind-blown streaks crossing the ice
float drift = texture2D(uNoise, vec2(ip.x * 0.14, ip.y * 0.05) + uWind).r;
float dust = smoothstep(0.58, 0.82, drift) * 0.6 + (1.0 - smoothstep(-0.6, 1.4, chanI)) * 0.85;
dust += smoothstep(0.7, 0.95, texture2D(uNoise, ip * 0.5 + uWind * 2.5).g) * 0.25;
// glowing-ice maps keep more clear ice between the drifts
dust = clamp(dust * (1.0 - openC) * (1.0 - 0.35 * uUnderGlow), 0.0, 1.0);
c = mix(c, uSnowCol, dust);
// slushy freezing front
float frontRim = smoothstep(0.0, 0.5, cover) * (1.0 - smoothstep(0.55, 1.0, cover));
c = mix(c, uSnowCol, frontRim * 0.8);
// thaw: plates darken as they go under
c *= 1.0 - 0.45 * brk;
diffuseColor.rgb = c;
diffuseColor.a *= clamp(cover * 1.15, 0.0, 1.0);
// past the river ends the sheet fades into the terrain's frozen backdrop water (and the cap mesh's side
// bands fade out over it beside the river)
diffuseColor.a *= smoothstep(0.0, 1.0, capFade(ip.y)) * bandFade(chanI);
float iceRough = mix(0.07, 0.8, max(dust, hair * 0.4));
iceRough = mix(iceRough, 0.05, openC);`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = iceRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  // bevelled crack edges and a slightly wavy frozen surface
  float e = 0.05;
  vec2 tilt = vec2(0.0);
  tilt += (vec2(texture2D(uNoise, (ip + vec2(e, 0.0)) * 0.6).r, texture2D(uNoise, (ip + vec2(0.0, e)) * 0.6).r) - texture2D(uNoise, ip * 0.6).r) * 1.2;
  float edgeT = (1.0 - smoothstep(0.0, seamW + 0.05, vb.y)) * (0.6 + crack);
  tilt += (hash22(floor(ip * 0.42 + vec2(nA * 0.6, 0.0))) - 0.5) * 0.08;
  tilt *= 1.0 - dust * 0.6;
  vec3 tw = vec3(tilt.x, 0.0, tilt.y) * (1.0 + edgeT * 2.0);
  normal = normalize(normal + (viewMatrix * vec4(tw, 0.0)).xyz);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  // glints: tiny facets that catch the light as the camera moves
  vec2 gc = floor(ip * 6.5);
  float gh = hash12(gc);
  vec2 gj = (hash22(gc + 9.1) - 0.5) * 0.7;
  vec3 Nm = normalize(vec3(gj.x, 1.0, gj.y));
  vec3 Hh = normalize(normalize(cameraPosition - vec3(ip.x, 0.0, ip.y)) + uSpecDir);
  float tw = 0.5 + 0.5 * sin(uTime * (1.5 + gh * 4.0) + gh * 40.0);
  float glint = pow(max(dot(Nm, Hh), 0.0), 420.0) * step(0.74, gh) * tw * (0.3 + dust * 0.9);
  totalEmissiveRadiance += uSunCol * glint * 0.9;
  // cracks glow faintly cyan while they open, pulsing before the thaw
  float pulse = 0.6 + 0.4 * sin(uTime * (6.0 + crack * 10.0));
  totalEmissiveRadiance += uCrackGlow * openC * crack * pulse * 0.6;
  totalEmissiveRadiance += uCrackGlow * max(rim, 0.0) * grown * crack * 0.12;
  // under-ice glow: blue light welling up through the clear ice from below, mottled, brightest along
  // the hairlines and plate seams, dimmed by snow dust; it pulses faster while the ice cracks
  if (uUnderGlow > 0.0) {
    float mott = texture2D(uNoise, ip * 0.07 + uWind * 0.3).a;
    float well = smoothstep(0.25, 0.85, mott) * 0.8 + 0.2;
    float glow = deep * well * (1.0 - dust * 0.85) * (1.0 - openC * 0.6);
    glow += (hair * 0.35 + seam * 0.6) * deep * (1.0 - dust);
    glow *= 0.85 + 0.15 * sin(uTime * (1.3 + crack * 6.0) + mott * 6.0);
    totalEmissiveRadiance += uGlowCol * glow * uUnderGlow * 0.55 * (1.0 - brk * 0.7);
  }
}`,
      );
  };
  m.customProgramCacheKey = () => `hw-ice-${detail}`;
  return m;
}
