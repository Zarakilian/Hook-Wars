// Low drifting mist banks for the backdrop (Mirelight's bayou, Aurora's sea smoke, Lantern Wharf's
// canal haze): camera-facing soft billboards, one instanced draw call, noise and drift in the shader.
// Transparent, so the engine draws them in its overlay pass after the water.
// Epic (cinematic) builds add more banks (terrain/epic.ts) and light them with the lantern pool.
import * as THREE from 'three';
import { LANTERN_GLSL, LANTERN_UNIFORMS } from '../../look/lanterns.ts';

export interface MistDef {
  x: number;
  y: number; // centre height
  z: number;
  w: number; // width (m)
  h: number; // height (m)
  /** drift speed along +x (m/s, wraps within +-w) */
  drift: number;
  opacity: number;
}

export interface MistView {
  mesh: THREE.InstancedMesh;
  update(time: number): void;
  dispose(): void;
}

const vert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aMist; // drift, opacity, seed, aspect
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
uniform float uTime;
void main() {
  vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float sx = length(instanceMatrix[0].xyz);
  float sy = length(instanceMatrix[1].xyz);
  c.x += sin(uTime * 0.05 * aMist.x + aMist.z * 6.28) * sx * 0.25;
  c.z += cos(uTime * 0.04 * aMist.x + aMist.z * 4.0) * 1.2;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 p = c + right * position.x * sx + up * position.y * sy;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vUv = uv;
  vAlpha = aMist.y;
  vSeed = aMist.z;
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform float uTime;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
float hwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hwNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hwHash(i), hwHash(i + vec2(1.0, 0.0)), f.x), mix(hwHash(i + vec2(0.0, 1.0)), hwHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(q * vec2(1.0, 1.15));
  float edge = 1.0 - smoothstep(0.35, 1.0, r);
  vec2 np = vUv * vec2(3.0, 1.6) + vec2(uTime * 0.03 + vSeed * 7.0, vSeed * 3.0);
  float n = hwNoise(np) * 0.6 + hwNoise(np * 2.3 + 1.7) * 0.4;
  float a = edge * smoothstep(0.25, 0.75, n) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <fog_fragment>
}
`;

/** Insert code after anchors; throws if one is missing. */
function insertAt(src: string, edits: { at: string; add: string }[]): string {
  let s = src;
  for (const e of edits) {
    const i = s.indexOf(e.at);
    if (i < 0) throw new Error('[mist] Epic shader anchor missing: ' + e.at.trim());
    const j = i + e.at.length;
    s = s.slice(0, j) + e.add + s.slice(j);
  }
  return s;
}

/** Epic: the banks glow warm where they drift past a lantern (the engine's lantern pool). */
function epicShaders(): { vert: string; frag: string } {
  return {
    vert: insertAt(vert, [
      { at: 'uniform float uTime;\n', add: `${LANTERN_GLSL}\nvarying vec3 vHwLit;\n` },
      { at: '  gl_Position = projectionMatrix * mvPosition;\n', add: '  vHwLit = hwLanternLight(p);\n' },
    ]),
    frag: insertAt(frag, [
      { at: 'varying float vSeed;\n', add: 'varying vec3 vHwLit;\n' },
      {
        at: '  gl_FragColor = vec4(uColor, a);\n',
        add: '  gl_FragColor.rgb += vHwLit * 0.16;\n  gl_FragColor.a = min(1.0, a * (1.0 + dot(vHwLit, vec3(0.08))));\n',
      },
    ]),
  };
}

export function buildMist(defs: MistDef[], color: number, epic = false): MistView | null {
  if (!defs.length) return null;
  const geo = new THREE.PlaneGeometry(1, 1);
  const attr = new Float32Array(defs.length * 4);
  defs.forEach((d, i) => {
    attr[i * 4] = d.drift;
    attr[i * 4 + 1] = d.opacity;
    attr[i * 4 + 2] = (i * 0.6180339) % 1;
    attr[i * 4 + 3] = d.w / d.h;
  });
  geo.setAttribute('aMist', new THREE.InstancedBufferAttribute(attr, 4));
  const u = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(color) },
  };
  const sh = epic ? epicShaders() : null;
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, u]),
    vertexShader: sh ? sh.vert : vert,
    fragmentShader: sh ? sh.frag : frag,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  if (sh) {
    // shared with the engine, which fills them every frame (merge() above would have cloned them)
    mat.uniforms.hwLanternPos = LANTERN_UNIFORMS.hwLanternPos;
    mat.uniforms.hwLanternCol = LANTERN_UNIFORMS.hwLanternCol;
    mat.uniforms.hwLanternCount = LANTERN_UNIFORMS.hwLanternCount;
  }
  // UniformsUtils.merge clones: keep our handles on the material's copies
  const uTime = mat.uniforms.uTime as { value: number };
  const mesh = new THREE.InstancedMesh(geo, mat, defs.length);
  const m = new THREE.Matrix4();
  defs.forEach((d, i) => {
    m.makeScale(d.w, d.h, 1);
    m.setPosition(d.x, d.y, d.z);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.name = 'backdrop-mist';
  return {
    mesh,
    update(time: number) {
      uTime.value = time;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
