// Post-processing and the opaque scene capture.
//
// Frame (medium and up):
//   1. opaques (every layer except WATER_LAYER and OVERLAY_LAYER) -> opaqueRT (HDR colour + float depth)
//   2. high+: N8AO ambient occlusion opaqueRT -> aoRT
//   3. capture = { colour of 1 or 2, depth of 1 }   <- water samples these
//   4. copy capture colour + depth (gl_FragDepth) into the composer buffer
//   5. WATER_LAYER objects, depth-tested against the opaque depth (no feedback loop: they read the capture)
//   6. OVERLAY_LAYER objects (transparent FX, weather, aim helpers) after water so water never hides them
//   7. EffectPass: SMAA, bloom, AgX tone mapping, colour grade + vignette + dither
import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  EdgeDetectionMode,
  FXAAEffect,
  Effect,
  EffectComposer,
  EffectPass,
  Pass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { WATER_LAYER, type Quality, type SceneCapture } from '../contracts.ts';
import type { ResolvedAtmosphere } from './atmosphere.ts';

/** Render layer drawn after water: transparent effects, weather, aim helpers. */
export const OVERLAY_LAYER = 3;
export const WATER_BIT = 1 << WATER_LAYER;
export const OVERLAY_BIT = 1 << OVERLAY_LAYER;

// ---------------------------------------------------------------------------------------------
// Capture targets: live for the engine's lifetime so the Texture objects never change identity.
// ---------------------------------------------------------------------------------------------

export class CaptureTargets {
  readonly opaque: THREE.WebGLRenderTarget;
  readonly ao: THREE.WebGLRenderTarget;
  readonly depth: THREE.DepthTexture;
  readonly capture: SceneCapture;

  constructor(w: number, h: number) {
    this.depth = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.depth.name = 'HW.CaptureDepth';
    this.depth.minFilter = THREE.NearestFilter;
    this.depth.magFilter = THREE.NearestFilter;
    this.opaque = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: this.depth,
    });
    this.opaque.texture.name = 'HW.CaptureColor';
    this.ao = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.ao.texture.name = 'HW.CaptureColorAO';
    this.capture = { color: this.opaque.texture, depth: this.depth, size: new THREE.Vector2(w, h) };
  }

  setSize(w: number, h: number): void {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (this.opaque.width !== w || this.opaque.height !== h) {
      this.opaque.setSize(w, h);
      this.ao.setSize(w, h);
    }
    this.capture.size.set(w, h);
  }

  /** free GPU memory (low tier); the JS objects stay valid and are re-allocated on next use */
  release(): void {
    this.opaque.dispose();
    this.ao.dispose();
  }

  dispose(): void {
    this.opaque.dispose();
    this.ao.dispose();
    this.depth.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Colour grade, vignette and dither (runs after tone mapping, display-referred).
// ---------------------------------------------------------------------------------------------

const GRADE_FRAG = /* glsl */ `
uniform float hwgSaturation;
uniform float hwgContrast;
uniform vec3 hwgLift;
uniform vec3 hwgGain;
uniform float hwgVignette;
uniform float hwgDither;
float hwgHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 g = pow(max(inputColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l), g, hwgSaturation);
  g = (g - 0.5) * hwgContrast + 0.5;
  g = g * hwgGain + hwgLift * (1.0 - g);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p) / length(vec2(aspect, 1.0) * 0.5);
  g *= 1.0 - hwgVignette * smoothstep(0.3, 1.1, r) * (0.75 + 0.25 * r);
  g += (hwgHash(gl_FragCoord.xy + fract(time * 7.13) * 97.0) - 0.5) * hwgDither;
  outputColor = vec4(pow(max(g, vec3(0.0)), vec3(2.2)), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('HWGradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['hwgSaturation', new THREE.Uniform(1)],
        ['hwgContrast', new THREE.Uniform(1)],
        ['hwgLift', new THREE.Uniform(new THREE.Vector3())],
        ['hwgGain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['hwgVignette', new THREE.Uniform(0.25)],
        ['hwgDither', new THREE.Uniform(1 / 255)],
      ]),
    });
  }

  set(saturation: number, contrast: number, lift: THREE.Vector3, gain: THREE.Vector3, vignette: number): void {
    const u = this.uniforms;
    (u.get('hwgSaturation') as THREE.Uniform).value = saturation;
    (u.get('hwgContrast') as THREE.Uniform).value = contrast;
    ((u.get('hwgLift') as THREE.Uniform).value as THREE.Vector3).copy(lift);
    ((u.get('hwgGain') as THREE.Uniform).value as THREE.Vector3).copy(gain);
    (u.get('hwgVignette') as THREE.Uniform).value = vignette;
  }
}

// ---------------------------------------------------------------------------------------------
// Scene pass: opaque -> AO -> capture -> water -> overlay, all into the composer input buffer.
// ---------------------------------------------------------------------------------------------

const COPY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;
const COPY_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tColor, vUv);
  gl_FragDepth = texture2D(tDepth, vUv).r;
}
`;

export class ScenePass extends Pass {
  private readonly world: THREE.Scene;
  private readonly view: THREE.PerspectiveCamera;
  private readonly targets: CaptureTargets;
  private readonly copyMaterial: THREE.ShaderMaterial;
  ao: N8AOPostPass | null = null;
  readonly clearColor = new THREE.Color(0x000000);
  /** set false to skip the overlay sub-pass when nothing is on it (saves a scene traversal) */
  overlayActive = true;
  waterActive = true;
  /** re-render the sun shadow map every N frames (1 = every frame). Stale maps stay consistent
   * because three only updates the shadow matrix when it re-renders the map. */
  shadowEvery = 1;
  /** the shadow-casting sun, so a missing shadow map is always rendered before it is sampled */
  sun: THREE.DirectionalLight | null = null;
  private frameNo = 0;

  constructor(world: THREE.Scene, view: THREE.PerspectiveCamera, targets: CaptureTargets) {
    super('HW.ScenePass');
    this.world = world;
    this.view = view;
    this.targets = targets;
    this.needsSwap = false;
    this.copyMaterial = new THREE.ShaderMaterial({
      name: 'HW.CaptureCopy',
      uniforms: { tColor: { value: null }, tDepth: { value: null } },
      vertexShader: COPY_VERT,
      fragmentShader: COPY_FRAG,
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.fullscreenMaterial = this.copyMaterial;
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null): void {
    const scene = this.world;
    const cam = this.view;
    const t = this.targets;
    // the engine camera always sees every engine layer; deriving it here also self-heals a mask
    // left behind by an aborted frame
    const mask = cam.layers.mask | 1 | WATER_BIT | OVERLAY_BIT;
    const bg = scene.background;
    const auto = scene.matrixWorldAutoUpdate;
    scene.background = null;
    try {
      // 1. opaques
      const noMap = this.sun !== null && this.sun.castShadow && this.sun.shadow.map === null;
      renderer.shadowMap.needsUpdate = this.frameNo++ % this.shadowEvery === 0 || noMap;
      cam.layers.mask = mask & ~(WATER_BIT | OVERLAY_BIT);
      renderer.setRenderTarget(t.opaque);
      renderer.setClearColor(this.clearColor, 1);
      renderer.clear(true, true, false);
      renderer.render(scene, cam);

      // 2. ambient occlusion
      let src: THREE.Texture = t.opaque.texture;
      if (this.ao) {
        this.ao.render(renderer, t.opaque, t.ao);
        src = t.ao.texture;
      }
      // 3. capture for water
      t.capture.color = src;

      // 4. copy colour + depth into the composer buffer
      this.copyMaterial.uniforms.tColor.value = src;
      this.copyMaterial.uniforms.tDepth.value = t.depth;
      renderer.setRenderTarget(inputBuffer);
      renderer.render(this.scene, this.camera);

      // 5 + 6. water, then overlay (matrices were updated by the opaque render)
      scene.matrixWorldAutoUpdate = false;
      if (this.waterActive) {
        cam.layers.mask = WATER_BIT;
        renderer.render(scene, cam);
      }
      if (this.overlayActive) {
        cam.layers.mask = OVERLAY_BIT;
        renderer.render(scene, cam);
      }
    } finally {
      scene.matrixWorldAutoUpdate = auto;
      cam.layers.mask = mask;
      scene.background = bg;
    }
  }

  override setSize(width: number, height: number): void {
    this.targets.setSize(width, height);
    if (this.ao) this.ao.setSize(width, height);
  }

  override dispose(): void {
    this.copyMaterial.dispose();
    if (this.ao) this.ao.dispose();
    this.ao = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Pipeline per tier
// ---------------------------------------------------------------------------------------------

interface TierPost {
  aa: { kind: 'fxaa' } | { kind: 'smaa'; preset: SMAAPreset; edges: EdgeDetectionMode };
  /** resolution scale of the bloom threshold pass (the mip chain starts at half res anyway) */
  bloomLumScale: number;
  bloomLevels: number;
  bloomScale: number;
  ao: null | { samples: number; denoise: number; halfRes: boolean };
  grade: boolean;
}

const TIERS: Record<Exclude<Quality, 'low'>, TierPost> = {
  medium: { aa: { kind: 'fxaa' }, bloomLumScale: 0.5, bloomLevels: 4, bloomScale: 0.85, ao: null, grade: true },
  high: { aa: { kind: 'smaa', preset: SMAAPreset.HIGH, edges: EdgeDetectionMode.COLOR }, bloomLumScale: 0.5, bloomLevels: 6, bloomScale: 1, ao: { samples: 12, denoise: 4, halfRes: true }, grade: true },
  ultra: { aa: { kind: 'smaa', preset: SMAAPreset.ULTRA, edges: EdgeDetectionMode.COLOR }, bloomLumScale: 1, bloomLevels: 7, bloomScale: 1, ao: { samples: 16, denoise: 8, halfRes: false }, grade: true },
};

export class PostPipeline {
  readonly composer: EffectComposer;
  readonly scenePass: ScenePass;
  private readonly effectPass: EffectPass;
  private readonly bloom: BloomEffect;
  private readonly grade: GradeEffect;
  private readonly tier: TierPost;
  private readonly renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, targets: CaptureTargets, quality: Exclude<Quality, 'low'>) {
    this.renderer = renderer;
    this.tier = TIERS[quality];
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, multisampling: 0 });
    this.scenePass = new ScenePass(scene, camera, targets);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.tier.ao) {
      const ao = new N8AOPostPass(scene, camera, size.x, size.y);
      ao.autoDetectTransparency = false;
      ao.configuration.transparencyAware = false;
      ao.configuration.gammaCorrection = false;
      ao.configuration.halfRes = this.tier.ao.halfRes;
      ao.configuration.aoSamples = this.tier.ao.samples;
      ao.configuration.denoiseSamples = this.tier.ao.denoise;
      ao.configuration.denoiseRadius = 10;
      ao.configuration.aoRadius = 1.6;
      ao.configuration.distanceFalloff = 0.8;
      ao.configuration.intensity = 2.6;
      ao.configuration.screenSpaceRadius = false;
      ao.configuration.color = new THREE.Color(0x000000);
      ao.setDepthTexture(targets.depth);
      this.scenePass.ao = ao;
    }
    // AA must stay the first effect: on edge pixels FXAA returns raw input samples and ignores chained colour
    const tierAa = this.tier.aa;
    const smaa = tierAa.kind === 'fxaa' ? new FXAAEffect() : new SMAAEffect({ preset: tierAa.preset, edgeDetectionMode: tierAa.edges });
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 1.0,
      luminanceSmoothing: 0.3,
      intensity: 1,
      radius: 0.72,
      levels: this.tier.bloomLevels,
    });
    this.bloom.luminancePass.resolution.scale = this.tier.bloomLumScale;
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.grade = new GradeEffect();
    this.effectPass = new EffectPass(camera, smaa, this.bloom, tone, this.grade);
    this.composer.addPass(this.scenePass);
    this.composer.addPass(this.effectPass);
    // the composer turns autoClear off for the whole renderer; we only need it off while we render
    renderer.autoClear = true;
  }

  get ao(): N8AOPostPass | null {
    return this.scenePass.ao;
  }

  apply(a: ResolvedAtmosphere): void {
    this.bloom.intensity = a.bloomIntensity * this.tier.bloomScale;
    this.bloom.luminanceMaterial.threshold = a.bloomThreshold;
    this.bloom.luminanceMaterial.smoothing = 0.3;
    this.bloom.mipmapBlurPass.radius = a.bloomRadius;
    const g = a.grade;
    if (this.tier.grade) this.grade.set(g.saturation, g.contrast, g.lift, g.gain, g.vignette);
    this.scenePass.clearColor.copy(a.sky.below);
    const ao = this.scenePass.ao;
    if (ao) {
      // night maps get a slightly softer AO so dark scenes do not go muddy
      ao.configuration.intensity = a.src.timeOfDay === 'night' ? 2.1 : 2.6;
    }
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
    this.renderer.autoClear = true;
  }

  render(dt: number): void {
    const r = this.renderer;
    r.autoClear = false;
    this.composer.render(dt);
    r.autoClear = true;
  }

  dispose(): void {
    this.composer.dispose();
    this.renderer.autoClear = true;
  }
}
