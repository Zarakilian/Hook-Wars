// Dancing caustics on the river bed: an additive sheet a couple of centimetres above the bed,
// lit by the sun through the waves. Lives on the default layer so the scene capture refracts it.
import * as THREE from 'three';
import { FIELD_GLSL } from './field.ts';
import { ICE_MASK_GLSL } from './surface.ts';

const vertex = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${FIELD_GLSL}
varying vec3 vWorld;
varying float vChan;
void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 f = fieldAt(p.xz);
  p.y = fieldBed(f) + 0.025;
  vChan = fieldChan(f);
  vWorld = p;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragment = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
${FIELD_GLSL}
${ICE_MASK_GLSL}
uniform sampler2D uNoise;
uniform vec4 uScroll;
uniform float uLevelY;
uniform vec3 uSunDir;
uniform vec3 uCausticCol;
uniform float uStrength;
uniform float uClarity;
uniform float uPuddleMode;
uniform float uChroma;
varying vec3 vWorld;
varying float vChan;

float causticAt(vec2 p) {
  float a = texture2D(uNoise, p * 0.19 + uScroll.xy).b;
  float b = texture2D(uNoise, p * 0.23 * vec2(1.0, -1.0) + uScroll.zw).b;
  return pow(min(a, b), 0.8) * 1.15 + (a + b) * 0.1;
}

void main() {
  vec4 f = fieldAt(vWorld.xz);
  float depth = uLevelY - (vWorld.y - 0.025);
  if (depth <= 0.005) { gl_FragColor = vec4(0.0); return; } // additive: black adds nothing (no discard, keeps early-z)
  // project along the sun so the pattern sits where the light actually lands
  vec2 sp = vWorld.xz - uSunDir.xz / max(uSunDir.y, 0.25) * depth * 0.6;
  float c;
  vec3 rgb;
  if (uChroma > 0.5) {
    float ch = 0.02 * smoothstep(0.2, 1.2, depth);
    rgb = vec3(causticAt(sp + vec2(ch, 0.0)), causticAt(sp), causticAt(sp - vec2(ch, 0.0)));
  } else {
    rgb = vec3(causticAt(sp));
  }
  rgb = pow(rgb, vec3(1.5)) * 1.6;
  float k = smoothstep(0.02, 0.45, depth) * exp(-depth / (uClarity * 1.6 + 0.3));
  k *= smoothstep(-0.2, 0.4, vChan);
  float n = texture2D(uNoise, vWorld.xz * 0.09).a;
  k *= 1.0 - smoothstep(0.3, 0.6, iceCover(vChan, n));
  if (uPuddleMode > 0.001) {
    float pm = smoothstep(0.24, 0.42, max(f.b, f.a) + (n - 0.5) * 0.3);
    k *= mix(1.0, pm, uPuddleMode);
  }
  vec3 col = uCausticCol * rgb * k * uStrength;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef USE_FOG
    // additive: fade out with fog instead of tinting toward the fog colour
    #ifdef FOG_EXP2
      float fogFactorC = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactorC = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.rgb *= 1.0 - fogFactorC;
  #endif
}
`;

export function createCausticsMaterial(u: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]), ...u },
    vertexShader: vertex,
    fragmentShader: fragment,
    // not 'transparent': it must stay in the opaque pass so the engine's scene capture (and so the
    // water's refraction) contains it. renderOrder puts it after the terrain it lies on.
    transparent: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  m.name = 'hw-water-caustics';
  return m;
}
