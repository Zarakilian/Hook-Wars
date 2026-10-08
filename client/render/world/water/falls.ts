// Falling water: the Coral Cove waterfall and the Cogwater lock-gate sluices.
// A ballistic sheet that always lands on the current water surface, streaky and foamy, plus mist puffs.
import * as THREE from 'three';
import { WATER_LAYER } from '../../contracts.ts';

const sheetVertex = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform vec3 uLip;
uniform vec2 uDir;
uniform float uWidth;
uniform float uSurfY;
uniform float uVel;
uniform float uTime;
uniform float uApproach;
varying vec2 vUv2;
varying float vDrop;
varying float vFall;
void main() {
  float u = uv.x;
  float v = 1.0 - uv.y; // 0 at the lip, 1 at the base
  float vv = v * (1.0 + uApproach) - uApproach;
  vec2 side = vec2(uDir.y, -uDir.x);
  float H = max(uLip.y - uSurfY, 0.05);
  float T = sqrt(2.0 * H / 9.81);
  vec3 p;
  float x = (u - 0.5) * uWidth;
  if (vv < 0.0) {
    p = vec3(uLip.x, uLip.y, uLip.z) + vec3(uDir.x, 0.0, uDir.y) * (vv * 1.4);
    p.xz += side * x;
    p.y += 0.04 * sin(u * 31.0 + uTime * 3.0);
  } else {
    float t = vv * T;
    float along = uVel * t;
    p = vec3(uLip.x, uLip.y - 0.5 * 9.81 * t * t, uLip.z) + vec3(uDir.x, 0.0, uDir.y) * along;
    float spread = 1.0 + vv * 0.16;
    p.xz += side * x * spread;
    // the sheet ripples a little as it falls
    p.xz += vec2(uDir.x, uDir.y) * sin(u * 23.0 + vv * 9.0 - uTime * 5.0) * 0.05 * vv;
    p.y = max(p.y, uSurfY - 0.08);
  }
  vUv2 = vec2(u, vv);
  vDrop = H;
  vFall = clamp(vv, 0.0, 1.0);
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const sheetFragment = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uNoise;
uniform float uTime;
uniform float uWidth;
uniform float uStrength;
uniform float uJets;
uniform vec3 uFoamCol;
uniform vec3 uWaterCol;
uniform vec3 uIrr;
uniform float uLift;
varying vec2 vUv2;
varying float vDrop;
varying float vFall;
void main() {
  float u = vUv2.x;
  float v = vUv2.y;
  float fallLen = vDrop * 1.1 + 0.5;
  vec2 q = vec2(u * uWidth * 0.55, v * fallLen * 0.28 - uTime * 1.25);
  float s1 = texture2D(uNoise, q * vec2(1.0, 0.35)).r;
  float s2 = texture2D(uNoise, q * vec2(2.3, 0.7) + vec2(0.31, -uTime * 0.4)).a;
  float lace = texture2D(uNoise, q * vec2(1.6, 0.9)).g;
  float streak = s1 * 0.6 + s2 * 0.4;
  float edge = smoothstep(0.0, 0.08, u) * smoothstep(1.0, 0.92, u);
  float jets = 1.0;
  if (uJets > 0.5) {
    float j = fract(u * uJets);
    jets = smoothstep(0.1, 0.24, j) * smoothstep(0.9, 0.76, j);
    edge *= jets;
  }
  float white = smoothstep(0.35, 0.85, streak) * 0.55 + smoothstep(0.65, 1.0, vFall) * 0.6 + (1.0 - smoothstep(-0.1, 0.15, v)) * 0.5;
  white = clamp(white + lace * 0.25, 0.0, 1.0);
  float a = (0.42 + 0.5 * smoothstep(0.25, 0.75, streak)) * edge * uStrength;
  // ragged, thinning bottom where it plunges into the pool
  a *= 1.0 - smoothstep(0.88, 1.0, vFall) * (0.5 + 0.5 * streak);
  if (a < 0.01) discard;
  vec3 col = mix(uWaterCol, uFoamCol, white) * (uIrr + uLift);
  col += uFoamCol * white * 0.02;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const mistVertex = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aSeed;
uniform vec3 uBase;
uniform vec2 uDir;
uniform float uWidth;
uniform float uTime;
uniform float uStrength;
uniform float uRise;
varying vec2 vUv;
varying float vA;
void main() {
  float life = fract(uTime * (0.16 + aSeed.w * 0.12) + aSeed.y);
  vec2 side = vec2(uDir.y, -uDir.x);
  vec3 c = uBase;
  c.xz += side * (aSeed.x - 0.5) * uWidth * 1.15;
  c.xz += uDir * (life * 1.8 + aSeed.z * 0.6);
  c.y += life * uRise * (0.6 + aSeed.z * 0.7) + 0.1;
  float size = (0.7 + aSeed.z * 1.1) * (0.5 + life * 1.1) * (0.6 + uRise * 0.25);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float rotA = aSeed.y * 6.28 + life * (aSeed.x - 0.5) * 2.0;
  vec2 pr = mat2(cos(rotA), sin(rotA), -sin(rotA), cos(rotA)) * position.xy;
  vec3 p = c + (camRight * pr.x + camUp * pr.y) * size;
  vUv = uv;
  vA = sin(life * 3.14159) * uStrength;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const mistFragment = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uPuff;
uniform vec3 uFoamCol;
uniform vec3 uIrr;
uniform float uLift;
uniform float uOpacity;
varying vec2 vUv;
varying float vA;
void main() {
  float a = texture2D(uPuff, vUv).a * vA * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uFoamCol * (uIrr * 1.2 + uLift), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

let sheetGeo: THREE.PlaneGeometry | null = null;
let sheetUsers = 0;

export interface FallOptions {
  lip: THREE.Vector3;
  dir: THREE.Vector2;
  width: number;
  vel: number;
  approach: number;
  jets: number;
  mistCount: number;
  mistRise: number;
  mistOpacity: number;
  noise: THREE.Texture;
  puff: THREE.Texture;
  foam: THREE.Color;
  water: THREE.Color;
}

export class FallSheet {
  readonly group = new THREE.Group();
  readonly opts: FallOptions;
  readonly sheet: THREE.Mesh;
  readonly mist: THREE.Mesh | null;
  private readonly su: Record<string, THREE.IUniform>;
  private readonly mu: Record<string, THREE.IUniform> | null;
  private readonly mistGeo: THREE.InstancedBufferGeometry | null;
  strength = 0;
  /** world landing point of the sheet centre (valid after update) */
  readonly land = new THREE.Vector2();

  constructor(o: FallOptions, irr: THREE.Color) {
    this.opts = o;
    if (!sheetGeo) sheetGeo = new THREE.PlaneGeometry(1, 1, 28, 22);
    sheetUsers++;
    this.su = {
      ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      uLip: { value: o.lip.clone() },
      uDir: { value: o.dir.clone() },
      uWidth: { value: o.width },
      uSurfY: { value: o.lip.y - 1 },
      uVel: { value: o.vel },
      uTime: { value: 0 },
      uApproach: { value: o.approach },
      uNoise: { value: o.noise },
      uStrength: { value: 0 },
      uJets: { value: o.jets },
      uFoamCol: { value: o.foam },
      uWaterCol: { value: o.water },
      uIrr: { value: irr },
      uLift: { value: 0.02 },
    };
    const sm = new THREE.ShaderMaterial({
      uniforms: this.su,
      vertexShader: sheetVertex,
      fragmentShader: sheetFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    sm.name = 'hw-water-fall';
    this.sheet = new THREE.Mesh(sheetGeo, sm);
    this.sheet.frustumCulled = false;
    this.sheet.layers.set(WATER_LAYER);
    this.sheet.renderOrder = 4;
    this.group.add(this.sheet);

    if (o.mistCount > 0) {
      const base = new THREE.PlaneGeometry(1, 1);
      const g = new THREE.InstancedBufferGeometry();
      g.index = base.index;
      g.setAttribute('position', base.getAttribute('position'));
      g.setAttribute('uv', base.getAttribute('uv'));
      const seeds = new Float32Array(o.mistCount * 4);
      for (let i = 0; i < o.mistCount; i++) {
        seeds[i * 4] = Math.random();
        seeds[i * 4 + 1] = Math.random();
        seeds[i * 4 + 2] = Math.random();
        seeds[i * 4 + 3] = Math.random();
      }
      g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
      g.instanceCount = o.mistCount;
      this.mistGeo = g;
      this.mu = {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        uBase: { value: new THREE.Vector3() },
        uDir: { value: o.dir.clone() },
        uWidth: { value: o.width },
        uTime: { value: 0 },
        uStrength: { value: 0 },
        uRise: { value: o.mistRise },
        uPuff: { value: o.puff },
        uFoamCol: { value: o.foam },
        uIrr: { value: irr },
        uLift: { value: 0.02 },
        uOpacity: { value: o.mistOpacity },
      };
      const mm = new THREE.ShaderMaterial({
        uniforms: this.mu,
        vertexShader: mistVertex,
        fragmentShader: mistFragment,
        transparent: true,
        depthWrite: false,
        fog: true,
      });
      mm.name = 'hw-water-mist';
      this.mist = new THREE.Mesh(g, mm);
      this.mist.frustumCulled = false;
      this.mist.layers.set(WATER_LAYER);
      this.mist.renderOrder = 5;
      this.group.add(this.mist);
    } else {
      this.mist = null;
      this.mu = null;
      this.mistGeo = null;
    }
  }

  update(time: number, surfY: number, strength: number, lift: number): void {
    this.strength = strength;
    const vis = strength > 0.005;
    this.group.visible = vis;
    const o = this.opts;
    const H = Math.max(o.lip.y - surfY, 0.05);
    const T = Math.sqrt((2 * H) / 9.81);
    const along = o.vel * T;
    this.land.set(o.lip.x + o.dir.x * along, o.lip.z + o.dir.y * along);
    if (!vis) return;
    this.su.uSurfY.value = surfY;
    this.su.uTime.value = time;
    this.su.uStrength.value = strength;
    this.su.uLift.value = lift;
    if (this.mu) {
      (this.mu.uBase.value as THREE.Vector3).set(this.land.x, surfY, this.land.y);
      this.mu.uTime.value = time;
      this.mu.uStrength.value = strength;
      this.mu.uLift.value = lift;
    }
  }

  dispose(): void {
    (this.sheet.material as THREE.Material).dispose();
    if (this.mist) (this.mist.material as THREE.Material).dispose();
    this.mistGeo?.dispose();
    sheetUsers--;
    if (sheetUsers <= 0 && sheetGeo) {
      sheetGeo.dispose();
      sheetGeo = null;
      sheetUsers = 0;
    }
  }
}
