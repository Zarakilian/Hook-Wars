// Sky dome: a camera-following inverted sphere with a procedural gradient, sun or moon, animated
// fbm clouds, stars, aurora and light shafts. It is drawn last among the opaques at the far plane,
// so the expensive shader only runs on pixels nothing else covered.
// It also renders a PMREM environment map of itself for reflections (scene.environment).
import * as THREE from 'three';
import type { Quality } from '../contracts.ts';
import type { SkyLook } from './atmosphere.ts';
import { NOISE_GLSL, SKY_FN_GLSL, SKY_UNIFORMS_GLSL } from './glsl.ts';

export interface SkyUniforms {
  [name: string]: THREE.IUniform;
  uSkyTop: THREE.IUniform<THREE.Color>;
  uSkyHorizon: THREE.IUniform<THREE.Color>;
  uSkyBelow: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunDisk: THREE.IUniform<number>;
  uSunSize: THREE.IUniform<number>;
  uSunGlow: THREE.IUniform<number>;
  uMoon: THREE.IUniform<number>;
  uSkyTime: THREE.IUniform<number>;
  uCloudCover: THREE.IUniform<number>;
  uCloudSpeed: THREE.IUniform<number>;
  uCloudScale: THREE.IUniform<number>;
  uCloudLit: THREE.IUniform<THREE.Color>;
  uCloudDark: THREE.IUniform<THREE.Color>;
  uStars: THREE.IUniform<number>;
  uAurora: THREE.IUniform<number>;
  uShafts: THREE.IUniform<number>;
  uHaze: THREE.IUniform<number>;
  uHorizonSharp: THREE.IUniform<number>;
  uSkyCurve: THREE.IUniform<number>;
  uSkyMid: THREE.IUniform<THREE.Color>;
  uSkyMidAmt: THREE.IUniform<number>;
}

export function createSkyUniforms(): SkyUniforms {
  return {
    uSkyTop: { value: new THREE.Color(0x284a8c) },
    uSkyHorizon: { value: new THREE.Color(0xbcd4ea) },
    uSkyBelow: { value: new THREE.Color(0x8aa0b8) },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(0xffffff) },
    uSunDisk: { value: 30 },
    uSunSize: { value: 0.03 },
    uSunGlow: { value: 1 },
    uMoon: { value: 0 },
    uSkyTime: { value: 0 },
    uCloudCover: { value: 0.4 },
    uCloudSpeed: { value: 0.02 },
    uCloudScale: { value: 0.42 },
    uCloudLit: { value: new THREE.Color(0xffffff) },
    uCloudDark: { value: new THREE.Color(0x8899aa) },
    uStars: { value: 0 },
    uAurora: { value: 0 },
    uShafts: { value: 0 },
    uHaze: { value: 0.5 },
    uHorizonSharp: { value: 10 },
    uSkyCurve: { value: 3.5 },
    uSkyMid: { value: new THREE.Color(0xb0507a) },
    uSkyMidAmt: { value: 0 },
  };
}

export function applySkyLook(u: SkyUniforms, look: SkyLook): void {
  u.uSkyTop.value.copy(look.top);
  u.uSkyHorizon.value.copy(look.horizon);
  u.uSkyBelow.value.copy(look.below);
  u.uSunDir.value.copy(look.sunDir);
  u.uSunColor.value.copy(look.sunColor);
  u.uSunDisk.value = look.sunDisk;
  u.uSunSize.value = look.sunSize;
  u.uSunGlow.value = look.sunGlow;
  u.uMoon.value = look.moon ? 1 : 0;
  u.uCloudCover.value = look.cloudCover;
  u.uCloudSpeed.value = look.cloudSpeed;
  u.uCloudScale.value = look.cloudScale;
  u.uCloudLit.value.copy(look.cloudLit);
  u.uCloudDark.value.copy(look.cloudDark);
  u.uStars.value = look.stars;
  u.uAurora.value = look.aurora;
  u.uShafts.value = look.shafts;
  u.uHaze.value = look.haze;
  u.uHorizonSharp.value = look.horizonSharp;
  u.uSkyCurve.value = look.curve;
  u.uSkyMid.value.copy(look.mid);
  u.uSkyMidAmt.value = look.midAmount;
}

export function skyDefines(q: Quality): Record<string, number> {
  return {
    HW_CLOUD_OCTAVES: q === 'low' ? 3 : q === 'medium' ? 4 : q === 'high' ? 5 : 6,
    HW_AURORA_STEPS: q === 'low' ? 5 : q === 'medium' ? 7 : q === 'high' ? 10 : 14,
  };
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position * 300.0, 1.0);
  gl_Position = p.xyww;
}
`;

const FRAG = /* glsl */ `
${SKY_UNIFORMS_GLSL}
${NOISE_GLSL}
${SKY_FN_GLSL}
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  gl_FragColor = vec4(hw_sky(d), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: SkyUniforms;
  private readonly geometry: THREE.SphereGeometry;
  private readonly envScene = new THREE.Scene();
  private readonly envMesh: THREE.Mesh;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private look: SkyLook | null = null;

  constructor(quality: Quality) {
    this.uniforms = createSkyUniforms();
    this.geometry = new THREE.SphereGeometry(1, 48, 24);
    this.material = new THREE.ShaderMaterial({
      name: 'HW.Sky',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: skyDefines(quality),
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'HW.SkyDome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1e6; // last opaque: early-z skips covered pixels
    this.mesh.matrixAutoUpdate = true;
    this.envMesh = new THREE.Mesh(this.geometry, this.material);
    this.envMesh.frustumCulled = false;
    this.envScene.add(this.envMesh);
  }

  setQuality(q: Quality): void {
    const d = skyDefines(q);
    const cur = this.material.defines as Record<string, number>;
    if (cur.HW_CLOUD_OCTAVES !== d.HW_CLOUD_OCTAVES || cur.HW_AURORA_STEPS !== d.HW_AURORA_STEPS) {
      this.material.defines = d;
      this.material.needsUpdate = true;
    }
  }

  apply(look: SkyLook): void {
    this.look = look;
    applySkyLook(this.uniforms, look);
  }

  update(time: number, camera: THREE.Camera): void {
    this.uniforms.uSkyTime.value = time;
    this.mesh.position.copy(camera.position);
  }

  /**
   * Renders the current sky (no sun disk, ground colour below the horizon) into a PMREM
   * environment map. The previous map is disposed. Returns the new texture.
   */
  buildEnvironment(renderer: THREE.WebGLRenderer, size = 128): THREE.Texture | null {
    if (!this.look) return null;
    if (!this.pmrem) this.pmrem = new THREE.PMREMGenerator(renderer);
    const u = this.uniforms;
    const disk = u.uSunDisk.value;
    const shafts = u.uShafts.value;
    const glow = u.uSunGlow.value;
    u.uSunDisk.value = 0;
    u.uShafts.value = 0;
    u.uSunGlow.value = glow * 0.6;
    u.uSkyBelow.value.copy(this.look.envBelow);
    this.material.depthTest = false;
    const prevTarget = renderer.getRenderTarget();
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 100, { size });
    renderer.setRenderTarget(prevTarget);
    this.material.depthTest = true;
    u.uSunDisk.value = disk;
    u.uShafts.value = shafts;
    u.uSunGlow.value = glow;
    u.uSkyBelow.value.copy(this.look.below);
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = rt;
    return rt.texture;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = null;
    if (this.pmrem) this.pmrem.dispose();
    this.pmrem = null;
  }
}
