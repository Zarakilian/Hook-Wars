// Backdrop waterfalls (Maelstrom Lagoon's cliffs): curved sheets that pour off a cliff lip with
// scrolling streaks and foam, one merged draw call. The river's own waterfall in the play area belongs
// to the water module; these only dress the cliffs past the map edges. The splash at each foot is a
// mist billboard (see mist.ts).
import * as THREE from 'three';

export interface CascadeDef {
  x: number;
  z: number;
  /** lip and foot heights */
  top: number;
  bottom: number;
  w: number;
  /** direction the water pours toward (radians, 0 = +Z) */
  yaw: number;
}

export interface CascadeView {
  mesh: THREE.Mesh;
  /** surfY: the current level of the pools the falls pour into (the sheets end on it) */
  update(time: number, surfY: number): void;
  dispose(): void;
}

const vert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float aSeed;
uniform float uSurf;
varying vec2 vUv;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = aSeed;
  // the sheet is built down to the pool floor; everything below the live pool level folds onto it
  vec3 p = position;
  p.y = max(p.y, uSurf);
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform vec3 uWater;
uniform vec3 uFoam;
varying vec2 vUv;
varying float vSeed;
float hwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hwNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hwHash(i), hwHash(i + vec2(1.0, 0.0)), f.x), mix(hwHash(i + vec2(0.0, 1.0)), hwHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float u = vUv.x;
  float v = 1.0 - vUv.y; // 0 at the lip
  float t = uTime * 1.6;
  float n = hwNoise(vec2(u * 14.0 + vSeed * 9.0, v * 4.0 - t)) * 0.65 + hwNoise(vec2(u * 31.0, v * 9.0 - t * 1.7)) * 0.35;
  float edge = smoothstep(0.0, 0.14, u) * smoothstep(1.0, 0.86, u);
  float a = edge * mix(0.55, 0.95, n) * smoothstep(0.0, 0.04, v);
  // ragged sides and gaps in the sheet
  a *= smoothstep(0.18, 0.4, n + edge * 0.3);
  vec3 col = mix(uWater, uFoam, clamp(n * 0.9 + v * 0.35, 0.0, 1.0));
  col = mix(col, uFoam, smoothstep(0.75, 1.0, v)); // churned foam at the foot
  if (a < 0.01) discard;
  gl_FragColor = vec4(col * 1.15, a);
  #include <fog_fragment>
}
`;

export function buildCascades(defs: CascadeDef[], water: number, foam: number): CascadeView | null {
  if (!defs.length) return null;
  const pos: number[] = [];
  const uv: number[] = [];
  const seed: number[] = [];
  const idx: number[] = [];
  const SEG = 10;
  defs.forEach((d, k) => {
    const dx = Math.sin(d.yaw);
    const dz = Math.cos(d.yaw);
    const sx = Math.cos(d.yaw);
    const sz = -Math.sin(d.yaw);
    const H = d.top - d.bottom;
    const base = pos.length / 3;
    for (let j = 0; j <= SEG; j++) {
      const v = j / SEG;
      // ballistic: the sheet leaves the lip moving outward, then falls almost straight
      const out = Math.sqrt(v) * Math.min(1.6, H * 0.12) + 0.15;
      const y = d.top - H * v;
      const spread = 1 + v * 0.25;
      for (let i = 0; i <= 1; i++) {
        const s = (i - 0.5) * d.w * spread;
        pos.push(d.x + dx * out + sx * s, y, d.z + dz * out + sz * s);
        uv.push(i, 1 - v);
        seed.push(k * 0.37);
      }
      if (j < SEG) {
        const a = base + j * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uSurf: { value: -100 }, uWater: { value: new THREE.Color(water) }, uFoam: { value: new THREE.Color(foam) } }]),
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const uTime = mat.uniforms.uTime as { value: number };
  const uSurf = mat.uniforms.uSurf as { value: number };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'backdrop-cascades';
  mesh.renderOrder = 4;
  return {
    mesh,
    update(time: number, surfY: number) {
      uTime.value = time;
      uSurf.value = surfY;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
