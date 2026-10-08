// Terrain and backdrop-water materials. Standard PBR materials patched with onBeforeCompile so they
// keep three.js lighting, shadows and fog, plus:
//   terrain: per-vertex roughness/emissive, a wet band below the (lagging) water line, rain sheen,
//            snow sparkle from the roughness map's blue channel
//   water:   depth tint from the bed height under each vertex, shore foam, ripples, freeze to ice
import * as THREE from 'three';

export interface TerrainUniforms {
  uWetY: { value: number };
  uRain: { value: number };
  uSparkle: { value: number };
  uTime: { value: number };
  uEmit: { value: number };
  /** strength and colour of the lamp light baked into the roughness map's red channel (0 = off) */
  uLamp: { value: number };
  uLampColor: { value: THREE.Color };
}

export function terrainUniforms(): TerrainUniforms {
  return { uWetY: { value: -100 }, uRain: { value: 0 }, uSparkle: { value: 0 }, uTime: { value: 0 }, uEmit: { value: 1 }, uLamp: { value: 0 }, uLampColor: { value: new THREE.Color(0xffb060) } };
}

export function terrainMaterial(color: THREE.Texture, rough: THREE.Texture, u: TerrainUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: color, roughnessMap: rough, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aRough;
attribute float aEmit;
varying float vRough;
varying float vEmit;
varying float vUp;
varying vec3 vWPos;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vRough = aRough;
vEmit = aEmit;
vUp = step(0.5, objectNormal.y);
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uWetY;
uniform float uRain;
uniform float uSparkle;
uniform float uTime;
uniform float uEmit;
uniform float uLamp;
uniform vec3 uLampColor;
varying float vRough;
varying float vEmit;
varying float vUp;
varying vec3 vWPos;
float hwHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float hwWet = 1.0 - smoothstep(uWetY - 0.04, uWetY + 0.05, vWPos.y);
diffuseColor.rgb *= mix(1.0, 0.56, hwWet);
diffuseColor.rgb *= mix(1.0, 0.84, uRain * vUp);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor *= vRough;
roughnessFactor = mix(roughnessFactor, 0.14, hwWet * 0.92);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.42, uRain * vUp);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vEmit * uEmit;
#ifdef USE_ROUGHNESSMAP
if (uLamp > 0.0) {
  // warm pools of lamp light on the ground round lanterns and gas lamps (baked), a little flicker
  float hwLamp = texture2D(roughnessMap, vRoughnessMapUv).r;
  if (hwLamp > 0.0) totalEmissiveRadiance += diffuseColor.rgb * uLampColor * hwLamp * uLamp * vUp * (0.93 + 0.07 * sin(uTime * 6.3 + vWPos.x * 1.7 + vWPos.z));
}
if (uSparkle > 0.0) {
  float hwSpk = texture2D(roughnessMap, vRoughnessMapUv).b;
  if (hwSpk > 0.0) {
    vec2 hwCell = floor(vWPos.xz * 11.0);
    float hwH = hwHash(hwCell);
    float hwTw = step(0.986, hwH) * max(0.0, sin(dot(cameraPosition.xz, vec2(0.9, 0.7)) * 0.8 + hwH * 80.0 + uTime * 0.7));
    totalEmissiveRadiance += vec3(0.85, 0.92, 1.0) * hwTw * hwSpk * uSparkle * vUp * (1.0 - hwWet);
  }
}
#endif`,
      );
  };
  m.customProgramCacheKey = () => 'hw-terrain-v2';
  return m;
}

export interface WaterUniforms {
  uLevel: { value: number };
  uTime: { value: number };
  uShallow: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  uFoam: { value: THREE.Color };
  uIce: { value: THREE.Color };
  uFrozen: { value: number };
  uWave: { value: number };
}

export function waterUniforms(shallow: number, deep: number, foam: number): WaterUniforms {
  return {
    uLevel: { value: 0 },
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color(shallow) },
    uDeep: { value: new THREE.Color(deep) },
    uFoam: { value: new THREE.Color(foam) },
    uIce: { value: new THREE.Color(shallow).lerp(new THREE.Color(0xffffff), 0.6) },
    uFrozen: { value: 0 },
    uWave: { value: 1 },
  };
}

/** Backdrop water (sea, swamp, harbour, river beyond the map). Needs an `aBed` attribute. */
export function backdropWaterMaterial(u: WaterUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0.05, transparent: true, depthWrite: false });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aBed;
uniform float uLevel;
uniform float uTime;
uniform float uFrozen;
uniform float uWave;
varying float vDepth;
varying vec3 vWPos2;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 hwW = modelMatrix * vec4(transformed, 1.0);
float hwA = (1.0 - uFrozen) * uWave * 0.035;
transformed.y = uLevel + hwA * (sin(hwW.x * 0.7 + uTime * 1.3) + sin(hwW.z * 0.9 - uTime * 1.1) * 0.7);
vDepth = uLevel - aBed;
vWPos2 = vec3(hwW.x, uLevel, hwW.z);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uFrozen;
uniform float uWave;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uIce;
varying float vDepth;
varying vec3 vWPos2;
float hwH2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hwVN(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hwH2(i), hwH2(i + vec2(1.0, 0.0)), f.x), mix(hwH2(i + vec2(0.0, 1.0)), hwH2(i + vec2(1.0, 1.0)), f.x), f.y);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float hwD = max(vDepth, 0.0);
vec3 hwCol = mix(uShallow, uDeep, smoothstep(0.3, 7.0, hwD));
float hwFoamLine = smoothstep(0.16, 0.0, hwD) * (0.55 + 0.45 * sin(uTime * 1.7 + vWPos2.x * 1.3 + vWPos2.z * 0.7));
hwFoamLine += smoothstep(0.42, 0.3, hwD) * smoothstep(0.22, 0.3, hwD) * 0.35 * (0.5 + 0.5 * sin(uTime * 1.2 - vWPos2.x * 0.9));
hwCol = mix(hwCol, uFoam, clamp(hwFoamLine * (1.0 - uFrozen), 0.0, 1.0) * uWave);
float hwN = hwVN(vWPos2.xz * 0.28) * 0.55 + hwVN(vWPos2.xz * 1.1) * 0.3 + hwVN(vWPos2.xz * 4.0) * 0.15;
vec3 hwIce = uIce * (0.8 + 0.32 * hwN);
float hwCr = abs(hwVN(vWPos2.xz * 0.6 + 7.0) - 0.5);
hwIce = mix(hwIce, uIce * 1.18, smoothstep(0.035, 0.0, hwCr) * 0.6);
hwIce = mix(hwIce, uDeep * 1.6, smoothstep(0.55, 1.0, hwVN(vWPos2.xz * 0.12 + 3.0)) * 0.35);
diffuseColor.rgb = mix(hwCol, hwIce, uFrozen);
diffuseColor.a = mix(mix(0.42, 0.93, smoothstep(0.0, 1.4, hwD)), 0.97, uFrozen);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.32, uFrozen);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  float hwK = (1.0 - uFrozen) * uWave;
  vec2 p = vWPos2.xz;
  float nx = cos(p.x * 1.9 + uTime * 1.6) * 0.5 + cos(p.x * 4.3 - p.y * 2.1 + uTime * 2.3) * 0.3 + cos((p.x + p.y) * 7.7 + uTime * 3.1) * 0.12;
  float nz = cos(p.y * 2.3 - uTime * 1.4) * 0.5 + cos(p.y * 3.7 + p.x * 1.7 - uTime * 2.0) * 0.3 + cos((p.y - p.x) * 8.3 - uTime * 2.7) * 0.12;
  vec3 hwN = vec3(nx, 0.0, nz) * 0.12 * hwK;
  normal = normalize(normal + (viewMatrix * vec4(hwN, 0.0)).xyz);
}`,
      );
  };
  m.customProgramCacheKey = () => 'hw-backwater-v1';
  return m;
}
