// Showcase stage materials, all owned by this module: the harbour water, the wet sheen on the deck, the
// mist veils, the procedural ripple and puddle textures, and the stage's own lantern pool uniforms.
// Nothing here touches a material another module owns. The water and the sheen are three.js standard
// materials (so the moon, the lantern lights, their shadows, the fog and the environment all reach
// them); the mist is a small ShaderMaterial lit by the stage's lanterns through LANTERN_GLSL.
import * as THREE from 'three';
import { LANTERN_GLSL, MAX_LANTERN_UNIFORMS } from '../look/lanterns.ts';

/** The stage's own lantern pool (same layout as LANTERN_UNIFORMS, which the engine zeroes in the menu). */
export interface StageLanternUniforms {
  hwLanternPos: { value: THREE.Vector4[] };
  hwLanternCol: { value: THREE.Vector3[] };
  hwLanternCount: { value: number };
}

export function createLanternUniforms(): StageLanternUniforms {
  return {
    hwLanternPos: { value: Array.from({ length: MAX_LANTERN_UNIFORMS }, () => new THREE.Vector4(0, -1000, 0, 1)) },
    hwLanternCol: { value: Array.from({ length: MAX_LANTERN_UNIFORMS }, () => new THREE.Vector3()) },
    hwLanternCount: { value: 0 },
  };
}

// ---------------------------------------------------------------------------------------------
// Procedural textures (no assets)
// ---------------------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tileable ripple normal map: a sum of integer-frequency sine waves (so it wraps exactly), mostly
 * running across the view so lantern reflections stretch into vertical streaks.
 */
export function rippleNormalTexture(size = 256, seed = 7, across = 0.75): THREE.DataTexture {
  const r = rng(seed);
  const waves: { kx: number; ky: number; a: number; p: number }[] = [];
  for (let i = 0; i < 18; i++) {
    const f = 1 + Math.floor(r() * (i < 6 ? 4 : i < 12 ? 9 : 18));
    // bias the wave vectors toward the V axis (waves that run across the camera's view)
    const ang = (r() - 0.5) * Math.PI * (1 - across) + (r() < 0.5 ? Math.PI / 2 : -Math.PI / 2) * (r() < across ? 1 : 0);
    let kx = Math.round(Math.cos(ang) * f);
    let ky = Math.round(Math.sin(ang) * f);
    if (kx === 0 && ky === 0) ky = 1;
    waves.push({ kx, ky, a: 1 / Math.pow(Math.hypot(kx, ky), 1.25), p: r() * Math.PI * 2 });
  }
  const data = new Uint8Array(size * size * 4);
  const tau = Math.PI * 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let dx = 0;
      let dy = 0;
      const u = x / size;
      const v = y / size;
      for (const w of waves) {
        const c = Math.cos(tau * (w.kx * u + w.ky * v) + w.p) * w.a;
        dx += c * w.kx;
        dy += c * w.ky;
      }
      const s = 0.09;
      const nx = -dx * s;
      const ny = -dy * s;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((nx / l) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((ny / l) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((1 / l) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** value noise on a wrapping lattice */
function tileNoise(size: number, cells: number, seed: number): (x: number, y: number) => number {
  const r = rng(seed);
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  return (x, y) => {
    const fx = (x / size) * cells;
    const fy = (y / size) * cells;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const at = (a: number, b: number) => lat[((((a % cells) + cells) % cells) + (((b % cells) + cells) % cells) * cells)];
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/**
 * Puddle map for the wet sheen, in the green channel (three reads roughness from G): low values are
 * glossy puddles and wet streaks along the planks, high values the drier wood between them.
 */
export function puddleTexture(size = 256, seed = 11): THREE.DataTexture {
  const n1 = tileNoise(size, 6, seed);
  const n2 = tileNoise(size, 17, seed + 1);
  const n3 = tileNoise(size, 41, seed + 2);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const n = n1(x, y) * 0.6 + n2(x, y) * 0.3 + n3(x, y) * 0.1;
      // streaks along the boards (V axis) and a few round puddles
      const streak = 0.5 + 0.5 * Math.sin((x / size) * Math.PI * 2 * 14 + n2(x, y) * 3);
      let wet = Math.max(0, Math.min(1, (n - 0.42) * 3.2)) * 0.8 + streak * 0.2;
      wet = Math.max(0, Math.min(1, wet));
      // crisp puddles (sharp lantern streaks) and matt wood between them: no mid-roughness haze
      const k = Math.max(0, Math.min(1, (wet - 0.44) / 0.18));
      const rough = 0.95 - (0.95 - 0.12) * k * k * (3 - 2 * k);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = Math.round(rough * 255);
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------------------------

export interface StageWaterStyle {
  /** body colour (linear-converted from sRGB hex) */
  color: number;
  /** self-lit body tint (shallow tropical water glows a little), sRGB hex */
  glow: number;
  glowIntensity: number;
  roughness: number;
  /** ripple normal strength near the camera */
  ripple: number;
  /** metres per ripple tile */
  tile: number;
  /** environment reflection strength */
  env: number;
}

export interface StageWater {
  readonly material: THREE.MeshStandardMaterial;
  update(time: number): void;
  dispose(): void;
}

const MAPN_LINE = 'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;';

// Distant lamps mirrored in the water (the long streaks across the harbour in the references). A light
// would fall off with distance; a mirror image does not, it only gets smaller, so this is a sharp
// specular lobe per pooled lamp with no range cut-off, smeared into streaks by the ripples.
const FAR_SPEC_GLSL = /* glsl */ `
uniform vec4 hwLanternPos[${MAX_LANTERN_UNIFORMS}];
uniform vec3 hwLanternCol[${MAX_LANTERN_UNIFORMS}];
uniform int hwLanternCount;
uniform float hwFarGain;
varying vec3 vHwWorld;
vec3 hwFarSpec(vec3 p, vec3 n, vec3 v) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_LANTERN_UNIFORMS}; i++) {
    if (i >= hwLanternCount) break;
    vec3 d = hwLanternPos[i].xyz - p;
    float dist = length(d);
    vec3 l = d / max(dist, 1e-3);
    float nh = max(dot(n, normalize(l + v)), 0.0);
    // a tight image plus a softer smear; brightness eases off only gently with distance
    float s = pow(nh, 900.0) * 3.0 + pow(nh, 140.0) * 0.18;
    acc += hwLanternCol[i] * (s / (1.0 + dist * 0.02));
  }
  return acc;
}
`;

/** Rippled harbour water: two scrolled ripple layers that calm down with distance (no far shimmer). */
export function createStageWater(style: StageWaterStyle, normal: THREE.Texture, far: StageLanternUniforms | null = null, farGain = 1): StageWater {
  const scrollA = { value: new THREE.Vector2() };
  const scrollB = { value: new THREE.Vector2() };
  const fade = { value: 0.045 };
  const gain = { value: farGain };
  const m = new THREE.MeshStandardMaterial({
    name: 'HW.ShowcaseWater',
    color: style.color,
    emissive: style.glow,
    emissiveIntensity: style.glowIntensity,
    roughness: style.roughness,
    metalness: 0,
    normalMap: normal,
    normalScale: new THREE.Vector2(style.ripple, style.ripple),
    envMapIntensity: style.env,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.hwScrollA = scrollA;
    shader.uniforms.hwScrollB = scrollB;
    shader.uniforms.hwRippleFade = fade;
    const chunk = THREE.ShaderChunk.normal_fragment_maps;
    if (!chunk.includes(MAPN_LINE)) return;
    const two = chunk.replace(
      MAPN_LINE,
      `vec3 hwN1 = texture2D( normalMap, vNormalMapUv + hwScrollA ).xyz * 2.0 - 1.0;
	vec3 hwN2 = texture2D( normalMap, vNormalMapUv * vec2( 1.7, 2.3 ) + hwScrollB ).xyz * 2.0 - 1.0;
	vec3 mapN = normalize( vec3( hwN1.xy + hwN2.xy * 0.7, hwN1.z * hwN2.z ) );
	mapN.xy *= 1.0 / ( 1.0 + length( vViewPosition ) * hwRippleFade );`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec2 hwScrollA;\nuniform vec2 hwScrollB;\nuniform float hwRippleFade;')
      .replace('#include <normal_fragment_maps>', two);
    if (far) {
      shader.uniforms.hwLanternPos = far.hwLanternPos;
      shader.uniforms.hwLanternCol = far.hwLanternCol;
      shader.uniforms.hwLanternCount = far.hwLanternCount;
      shader.uniforms.hwFarGain = gain;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vHwWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n\tvHwWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + FAR_SPEC_GLSL).replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
	{
		vec3 hwNw = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
		totalEmissiveRadiance += hwFarSpec( vHwWorld, hwNw, normalize( cameraPosition - vHwWorld ) ) * hwFarGain;
	}`,
      );
    }
  };
  m.customProgramCacheKey = () => (far ? 'hw-showcase-water-far-1' : 'hw-showcase-water-1');
  return {
    material: m,
    update(time: number) {
      scrollA.value.set(time * 0.011, time * 0.023);
      scrollB.value.set(-time * 0.017, time * 0.031);
    },
    dispose() {
      m.dispose();
    },
  };
}

/**
 * Wet sheen: a black, additive, glossy standard material laid over a deck. It adds only reflections
 * (the lanterns' highlights with their shadows, the moon, the sky), so the boards below keep their own
 * colour and the planks read rain-wet like the references.
 */
export function createWetSheen(puddles: THREE.Texture, normal: THREE.Texture, strength: number): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    name: 'HW.ShowcaseWetSheen',
    color: 0x000000,
    roughness: 1,
    roughnessMap: puddles,
    metalness: 0,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.18, 0.18),
    // warm-weighted reflectance: the lanterns' streaks carry the wet look, the moonlit sky only a hint
    specularColor: new THREE.Color(1.0, 0.78, 0.56),
    specularIntensity: Math.min(1, 0.8 * strength),
    envMapIntensity: 0.06 * strength,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  return m;
}

// ---------------------------------------------------------------------------------------------
// Mist veils
// ---------------------------------------------------------------------------------------------

const MIST_VERT = /* glsl */ `
attribute vec4 aVeil; // x: seed, y: alpha, z: height (m), w: 1 = upright veil, 0 = flat sheet
varying vec2 vUv;
varying float vSeed;
varying float vAlpha;
varying float vUpright;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vSeed = aVeil.x;
  vAlpha = aVeil.y;
  vUpright = aVeil.w;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const MIST_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uMistColor;
uniform float uLanternGlow;
uniform float uNearFade;
varying vec2 vUv;
varying float vSeed;
varying float vAlpha;
varying float vUpright;
varying vec3 vWorld;
${LANTERN_GLSL}
#include <fog_pars_fragment>
float hwh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hwn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hwh(i), hwh(i + vec2(1, 0)), f.x), mix(hwh(i + vec2(0, 1)), hwh(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  // soft rim on every side; an upright veil is thick at its foot and thins upward
  float sideFade = smoothstep(0.0, 0.22, vUv.x) * smoothstep(0.0, 0.22, 1.0 - vUv.x);
  float vert = vUpright > 0.5 ? smoothstep(0.0, 0.1, vUv.y) * (1.0 - vUv.y) * (1.0 - vUv.y * 0.5) : smoothstep(0.0, 0.25, vUv.y) * smoothstep(0.0, 0.25, 1.0 - vUv.y);
  // never a flat sheet in the camera's face
  float a0 = sideFade * vert * vAlpha * smoothstep(uNearFade, uNearFade * 2.5, distance(cameraPosition, vWorld));
  // most veil pixels are faint rims: skip the noise and the lantern loop there
  if (a0 < 0.004) discard;
  vec2 q = vUv * vec2(3.2, 1.4) + vec2(uTime * 0.018 + vSeed, uTime * 0.006);
  float n = hwn(q) * 0.65 + hwn(q * 2.3 + 3.7 + uTime * 0.01) * 0.35;
  // a soft floor of haze everywhere plus the drifting banks on top
  float a = (0.35 + 0.65 * smoothstep(0.15, 0.85, n)) * a0;
  if (a < 0.003) discard;
  vec3 c = uMistColor + hwLanternLight(vWorld) * uLanternGlow;
  gl_FragColor = vec4(c, a);
  #include <fog_fragment>
}
`;

export interface Veil {
  x: number;
  z: number;
  /** base height (world y) */
  y: number;
  w: number;
  h: number;
  /** yaw of an upright veil (0 = facing +Z), or of a flat sheet */
  yaw: number;
  alpha: number;
  upright: boolean;
  seed: number;
}

export interface StageMist {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  update(time: number): void;
  dispose(): void;
}

export function createMist(veils: Veil[], color: THREE.Color, lanterns: StageLanternUniforms, lanternGlow: number): StageMist {
  const n = veils.length;
  const pos = new Float32Array(n * 12);
  const uv = new Float32Array(n * 8);
  const attr = new Float32Array(n * 16);
  const idx = new Uint16Array(n * 6);
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  veils.forEach((v, k) => {
    const c = Math.cos(v.yaw);
    const s = Math.sin(v.yaw);
    const corners: [number, number, number][] = v.upright
      ? [
          [-v.w / 2, 0, 0],
          [v.w / 2, 0, 0],
          [v.w / 2, v.h, 0],
          [-v.w / 2, v.h, 0],
        ]
      : [
          [-v.w / 2, 0, v.h / 2],
          [v.w / 2, 0, v.h / 2],
          [v.w / 2, 0, -v.h / 2],
          [-v.w / 2, 0, -v.h / 2],
        ];
    for (let i = 0; i < 4; i++) {
      const [lx, ly, lz] = corners[i];
      pos[(k * 4 + i) * 3] = v.x + lx * c + lz * s;
      pos[(k * 4 + i) * 3 + 1] = v.y + ly;
      pos[(k * 4 + i) * 3 + 2] = v.z - lx * s + lz * c;
      uv[(k * 4 + i) * 2] = uvs[i * 2];
      uv[(k * 4 + i) * 2 + 1] = uvs[i * 2 + 1];
      attr.set([v.seed, v.alpha, v.h, v.upright ? 1 : 0], (k * 4 + i) * 4);
    }
    idx.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aVeil', new THREE.BufferAttribute(attr, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  const time = { value: 0 };
  const material = new THREE.ShaderMaterial({
    name: 'HW.ShowcaseMist',
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uMistColor: { value: color.clone() }, uLanternGlow: { value: lanternGlow }, uNearFade: { value: 2.5 } },
    ]),
    vertexShader: MIST_VERT,
    fragmentShader: MIST_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  material.uniforms.uTime = time;
  material.uniforms.hwLanternPos = lanterns.hwLanternPos;
  material.uniforms.hwLanternCol = lanterns.hwLanternCol;
  material.uniforms.hwLanternCount = lanterns.hwLanternCount;
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'HW.ShowcaseMist';
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  return {
    mesh,
    material,
    update(t: number) {
      time.value = t;
    },
    dispose() {
      geo.dispose();
      material.dispose();
    },
  };
}
