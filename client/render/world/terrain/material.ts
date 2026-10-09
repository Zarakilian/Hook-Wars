// Terrain and backdrop-water materials. Standard PBR materials patched with onBeforeCompile so they
// keep three.js lighting, shadows and fog, plus:
//   terrain: per-vertex roughness/emissive, a wet band below the (lagging) water line, rain sheen,
//            snow sparkle from the roughness map's blue channel
//   water:   depth tint from the bed height under each vertex, shore foam, ripples, freeze to ice
import * as THREE from 'three';
import { cinematicEnabled } from '../../cinematic.ts';
import { LANTERN_GLSL, LANTERN_UNIFORMS, MAX_LANTERN_UNIFORMS } from '../../look/lanterns.ts';

export interface TerrainUniforms {
  uWetY: { value: number };
  uRain: { value: number };
  uSparkle: { value: number };
  uTime: { value: number };
  uEmit: { value: number };
  /** strength and colour of the lamp light baked into the roughness map's red channel (0 = off) */
  uLamp: { value: number };
  uLampColor: { value: THREE.Color };
  /** strength and colour of the self-lit glow painted into the roughness map's alpha (255 - glow; 0 = off) */
  uGlow: { value: number };
  uGlowColor: { value: THREE.Color };
}

export function terrainUniforms(): TerrainUniforms {
  return { uWetY: { value: -100 }, uRain: { value: 0 }, uSparkle: { value: 0 }, uTime: { value: 0 }, uEmit: { value: 1 }, uLamp: { value: 0 }, uLampColor: { value: new THREE.Color(0xffb060) }, uGlow: { value: 0 }, uGlowColor: { value: new THREE.Color(0x7fd8ff) } };
}

/**
 * Cinematic ("Epic") options of a terrain material. While cinematic mode is off they change nothing: the
 * material compiles exactly the shader it always did.
 *   - base: the field's quantisation base. When the voxel look (look/voxelLook.ts) patches the material
 *     it gets a continuous world-space lattice here (column edges at x0 + i * s, strata at base + k * segH)
 *     instead of the per-vertex floor, which collapsed column sides that end off the lattice (partial
 *     tops, 1/16 m lips, skirts) into one dark seam band.
 *   - epic: the match was built in cinematic mode; while it stays on, the Epic wet shading compiles in
 *     (gloss boost on wet and glossy ground, the lanterns' glare stretched into wet-street streaks,
 *     calmer per-cube normals on wet ground and flat standing water, a damp fringe on walls above the wet
 *     line). Turning cinematic off recompiles the normal shader.
 */
export interface TerrainLook {
  base: number;
  epic: boolean;
  uniforms: TerrainEpicUniforms;
}

export interface TerrainEpicUniforms {
  /** x direct specular boost, y environment boost, z puddle flattening 0..1, w wall damp fringe (m) */
  uHwtSpec: { value: THREE.Vector4 };
  /** lantern streaks: x strength (0 = off), y lateral width, z length / width, w normal calming on wet ground */
  uHwtStreak: { value: THREE.Vector4 };
  uHwtBase: { value: number };
}

export function terrainEpicUniforms(spec: readonly number[], streak: readonly number[], base: number): TerrainEpicUniforms {
  return {
    uHwtSpec: { value: new THREE.Vector4(spec[0], spec[1], spec[2], spec[3]) },
    uHwtStreak: { value: new THREE.Vector4(streak[0], streak[1], streak[2], streak[3]) },
    uHwtBase: { value: base },
  };
}

/** Insert code at anchors; throws if one is missing (so an Epic variant can never silently drift). */
function insertAt(src: string, edits: { at: string; add: string }[]): string {
  let s = src;
  for (const e of edits) {
    const i = s.indexOf(e.at);
    if (i < 0) throw new Error('[terrain] Epic shader anchor missing: ' + e.at.trim());
    const j = i + e.at.length;
    s = s.slice(0, j) + e.add + s.slice(j);
  }
  return s;
}

// Epic: the pooled lanterns' glare on wet ground, an anisotropic lobe stretched toward the viewer (the
// reference's wet-street streaks under every lamp). The diffuse light and the round highlight are the
// engine's lantern PointLights; this only adds the long glare, so it never needs a second light pass.
const STREAK_GLSL = `
${LANTERN_GLSL}
vec3 hwtStreaks(vec3 p, vec3 n, vec3 v, float rough) {
  vec3 b = v - n * dot(v, n);
  float bl = length(b);
  b = bl > 1e-4 ? b / bl : vec3(0.0, 0.0, 1.0);
  vec3 t = cross(n, b);
  float ax = uHwtStreak.y * (0.35 + 1.3 * rough);
  float ay = ax * uHwtStreak.z;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_LANTERN_UNIFORMS}; i++) {
    if (i >= hwLanternCount) break;
    vec3 d = hwLanternPos[i].xyz - p;
    // the falloff below is exactly 0 past 1.6 x range: skip those lanterns (a pixel is in reach of one to three)
    float reach = hwLanternPos[i].w * 1.6;
    float d2 = dot(d, d);
    if (d2 >= reach * reach) continue;
    float dist = sqrt(d2);
    vec3 l = d / max(dist, 1e-3);
    vec3 h = normalize(l + v);
    float hn = max(dot(h, n), 0.05);
    float ht = dot(h, t) / (hn * ax);
    float hb = dot(h, b) / (hn * ay);
    float fall = pow(clamp(1.0 - pow(dist / reach, 4.0), 0.0, 1.0), 2.0) / max(d2, 0.25);
    acc += hwLanternCol[i] * (exp(-(ht * ht + hb * hb)) * fall * max(dot(n, l), 0.0));
  }
  return acc;
}`;

// voxel look lattice (only while voxelLook.ts has patched the material: it declares vHwVox and hwVoxA)
const LATTICE_VERT = `
#ifdef HW_VOXEL_LOOK
vHwVox = (vWPos - vec3(0.0, uHwtBase, 0.0)) / hwVoxA.x;
#endif`;

export function terrainMaterial(color: THREE.Texture, rough: THREE.Texture, u: TerrainUniforms, look?: TerrainLook): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: color, roughnessMap: rough, roughness: 1, metalness: 0 });
  const epicNow = () => !!look && look.epic && cinematicEnabled();
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
uniform float uGlow;
uniform vec3 uGlowColor;
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
if (uGlow > 0.0) {
  // self-lit tops (glowing harbour ice), painted per column into the alpha channel
  float hwGlow = 1.0 - texture2D(roughnessMap, vRoughnessMapUv).a;
  if (hwGlow > 0.0) totalEmissiveRadiance += uGlowColor * hwGlow * uGlow * vUp;
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
    // ---- cinematic only: nothing below runs while cinematic mode is off (same source, same program)
    if (!look) return;
    const vox = !!m.defines && 'HW_VOXEL_LOOK' in m.defines;
    const epic = epicNow();
    if (!vox && !epic) return;
    shader.uniforms.uHwtBase = look.uniforms.uHwtBase;
    shader.uniforms.uHwtSpec = look.uniforms.uHwtSpec;
    shader.uniforms.uHwtStreak = look.uniforms.uHwtStreak;
    // the engine's lantern pool (filled every frame while cinematic is on, count 0 otherwise)
    shader.uniforms.hwLanternPos = LANTERN_UNIFORMS.hwLanternPos;
    shader.uniforms.hwLanternCol = LANTERN_UNIFORMS.hwLanternCol;
    shader.uniforms.hwLanternCount = LANTERN_UNIFORMS.hwLanternCount;
    shader.vertexShader = insertAt(shader.vertexShader, [
      { at: 'varying vec3 vWPos;', add: '\nuniform float uHwtBase;' },
      { at: 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;', add: vox ? LATTICE_VERT : '' },
    ]);
    if (!epic) return;
    shader.fragmentShader = insertAt(shader.fragmentShader, [
      { at: 'varying vec3 vWPos;', add: '\nuniform vec4 uHwtSpec;\nuniform vec4 uHwtStreak;' + STREAK_GLSL },
      {
        // damp fringe: walls stay dark and wet a hand above the (lagging) wet line
        at: 'diffuseColor.rgb *= mix(1.0, 0.84, uRain * vUp);',
        add: `
float hwtFr = (1.0 - vUp) * (1.0 - smoothstep(uWetY, uWetY + uHwtSpec.w + 1e-4, vWPos.y)) * (1.0 - hwWet);
diffuseColor.rgb *= 1.0 - 0.24 * hwtFr;
// soft ground (lawn, sand, mud, snow; A = 255 - calm, side faces read the white texel): the voxel look
// fades back to a hint of the cube grid. Its whole colour factor (seam, per-cube tint, bevel lift) is
// divided out by calm, and the bevel tilt, glint jitter and glossy bevels that follow step back with it.
float hwtCalm = 1.0 - sampledDiffuseColor.a;
#ifdef HW_VOXEL_LOOK
if (hwtCalm > 0.0) {
  float hwtF = (1.0 - hwVoxA.y * hwSeam) * (1.0 + (hwH1 - 0.5) * 2.0 * hwVoxB.y * hwFadeG) * (1.0 + 0.1 * hwBev * (1.0 - hwSeam));
  diffuseColor.rgb *= mix(1.0, 1.0 / max(hwtF, 0.3), hwtCalm);
  hwFadeB *= 1.0 - hwtCalm;
  hwFadeG *= 1.0 - hwtCalm;
  hwBev *= 1.0 - hwtCalm;
}
#endif`,
      },
      {
        at: 'roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.42, uRain * vUp);',
        add: `
roughnessFactor = mix(roughnessFactor, min(roughnessFactor, 0.3), hwtFr);
// how glossy (wet) the ground is: puddles, wet setts, the wash line, glassy ice
float hwtGloss = 1.0 - smoothstep(0.1, 0.55, roughnessFactor);`,
      },
      {
        // standing water lies flat (no bevel tilt or per-cube jitter under it), wet ground calmer, so the
        // lanterns mirror in it as one coherent glare instead of a glitter of cube edges
        at: '#include <normal_fragment_maps>',
        add: `
normal = normalize(mix(normal, nonPerturbedNormal, max(uHwtSpec.z * (1.0 - smoothstep(0.05, 0.12, roughnessFactor)), uHwtStreak.w * hwtGloss)));`,
      },
      {
        // wet ground mirrors the lantern lights (the engine's lantern PointLights) and the sky
        at: '#include <lights_fragment_end>',
        add: `
reflectedLight.directSpecular *= 1.0 + uHwtSpec.x * hwtGloss;
reflectedLight.indirectSpecular *= 1.0 + uHwtSpec.y * hwtGloss;
if (uHwtStreak.x > 0.0 && hwtGloss > 0.02) {
  vec3 hwtN = inverseTransformDirection(nonPerturbedNormal, viewMatrix);
  reflectedLight.directSpecular += hwtStreaks(vWPos, hwtN, normalize(cameraPosition - vWPos), roughnessFactor) * (uHwtStreak.x * hwtGloss);
}`,
      },
    ]);
  };
  m.customProgramCacheKey = () => (epicNow() ? 'hw-terrain-v3|hwte1' : 'hw-terrain-v3');
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
