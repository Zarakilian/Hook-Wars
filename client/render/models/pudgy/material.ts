// Pudgy material: MeshStandardMaterial patched to read the per-vertex `surf` attribute
// (roughness, metalness, two emissive weights; roughness above 1.5 marks a premium sparkling voxel)
// plus per-character uniforms for glow pulses, hit flash, a soft team rim light and the sparkle clock.
// Every character gets its own small material instance (uniform values differ per unit), but all
// instances report the same program cache key, so the GPU compiles one shader for all of them.
import * as THREE from 'three';

export interface PudgyUniforms {
  uGlowA: { value: number };
  uGlowB: { value: number };
  uFlash: { value: number };
  uFlashColor: { value: THREE.Color };
  uRim: { value: number };
  uRimColor: { value: THREE.Color };
  /** sparkle clock (seconds) */
  uTime: { value: number };
  /** 0..1 strength of premium sparkles (0 turns them off) */
  uSparkle: { value: number };
}

export function makeUniforms(rim: number, rimColor: number): PudgyUniforms {
  return {
    uGlowA: { value: 2.2 },
    uGlowB: { value: 1.5 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uRim: { value: rim },
    uRimColor: { value: new THREE.Color(rimColor) },
    uTime: { value: 0 },
    uSparkle: { value: 1 },
  };
}

const VERT_HEAD = /* glsl */ `
attribute vec4 surf;
varying vec4 vSurf;
varying vec3 vObjPos;
`;
const FRAG_HEAD = /* glsl */ `
varying vec4 vSurf;
varying vec3 vObjPos;
uniform float uGlowA;
uniform float uGlowB;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uRim;
uniform vec3 uRimColor;
uniform float uTime;
uniform float uSparkle;
float pudgyHash(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}
`;

export function makePudgyMaterial(u: PudgyUniforms, transparent: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0,
    transparent,
    opacity: 1,
    depthWrite: true,
  });
  m.name = transparent ? 'pudgy-ghost' : 'pudgy';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlowA = u.uGlowA;
    sh.uniforms.uGlowB = u.uGlowB;
    sh.uniforms.uFlash = u.uFlash;
    sh.uniforms.uFlashColor = u.uFlashColor;
    sh.uniforms.uRim = u.uRim;
    sh.uniforms.uRimColor = u.uRimColor;
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uSparkle = u.uSparkle;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSurf = surf;\n  vObjPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  float pudgyPrem = step(1.5, vSurf.x);\n  roughnessFactor = vSurf.x - 2.0 * pudgyPrem;',
      )
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = vSurf.y;')
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * (vSurf.z * uGlowA + vSurf.w * uGlowB);
  {
    vec3 pudgyView = normalize(vViewPosition);
    float pudgyFres = 1.0 - clamp(dot(normal, pudgyView), 0.0, 1.0);
    pudgyFres = pudgyFres * pudgyFres * pudgyFres;
    totalEmissiveRadiance += uRimColor * (pudgyFres * uRim) + uFlashColor * uFlash;
    if (pudgyPrem > 0.5 && uSparkle > 0.0) {
      // premium glints: a few voxel faces at a time flare up and fade
      vec3 cell = floor(vObjPos * 40.0 + 0.001);
      float h = pudgyHash(cell);
      float tw = sin(uTime * (1.7 + h * 2.6) + h * 61.0);
      tw = pow(max(tw, 0.0), 28.0) * step(0.72, h);
      totalEmissiveRadiance += mix(diffuseColor.rgb, vec3(1.0), 0.7) * tw * 2.6 * uSparkle;
      totalEmissiveRadiance += diffuseColor.rgb * 0.06 * uSparkle;
    }
  }`,
      );
  };
  m.customProgramCacheKey = () => 'pudgy-surf-v2';
  return m;
}
