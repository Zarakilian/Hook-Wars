// Pudgy material: MeshStandardMaterial patched to read the per-vertex `surf` attribute
// (roughness, metalness, two emissive weights) plus per-character uniforms for glow pulses,
// hit flash and a soft team rim light.
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
}

export function makeUniforms(rim: number, rimColor: number): PudgyUniforms {
  return {
    uGlowA: { value: 2.2 },
    uGlowB: { value: 1.5 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uRim: { value: rim },
    uRimColor: { value: new THREE.Color(rimColor) },
  };
}

const VERT_HEAD = /* glsl */ `
attribute vec4 surf;
varying vec4 vSurf;
`;
const FRAG_HEAD = /* glsl */ `
varying vec4 vSurf;
uniform float uGlowA;
uniform float uGlowB;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uRim;
uniform vec3 uRimColor;
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
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSurf = surf;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = vSurf.x;')
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
  }`,
      );
  };
  m.customProgramCacheKey = () => 'pudgy-surf-v1';
  return m;
}
