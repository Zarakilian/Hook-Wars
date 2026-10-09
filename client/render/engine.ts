// Renderer, scene, camera, lighting, sky, shadows, post-processing, weather and the opaque scene
// capture the water module samples. See client/render/engine/* for the parts.
//
// Layers:
//   0              opaque world (terrain, props, characters, sky dome)
//   WATER_LAYER    water meshes: drawn after the opaque capture, depth-tested against it
//   OVERLAY_LAYER  transparent effects, weather, aim helpers: drawn after water.
//                  Objects on layer 0 with a transparent material are moved here automatically
//                  every frame, so water never hides splashes, rings or particles.
import * as THREE from 'three';
import { channelDepthAt } from '../../shared/maps/helpers.ts';
import type { MapDef } from '../../shared/maps/types.ts';
import type { MatchConfig } from '../../shared/types.ts';
import { cinematicConfig, cinematicEnabled, onCinematicChange, setCinematic as setCinematicMode, setCinematicConfig, type CinematicConfig } from './cinematic.ts';
import { WATER_LAYER, bedY, groundY, type Engine, type Quality, type SceneCapture } from './contracts.ts';
import { MENU_ATMOSPHERE, resolveAtmosphere, type ResolvedAtmosphere } from './engine/atmosphere.ts';
import { CinematicPass, LookGradeEffect } from './engine/cinema.ts';
import { MenuBackdrop } from './engine/menu.ts';
import { CaptureTargets, OVERLAY_BIT, OVERLAY_LAYER, PostPipeline, WATER_BIT } from './engine/post.ts';
import { GpuProfiler } from './engine/profiler.ts';
import { ShadowRig, type ShadowBounds } from './engine/shadows.ts';
import { SkyDome, skyDefines } from './engine/sky.ts';
import { WeatherSystem } from './engine/weather.ts';
import { cinematicLook, type CineLook } from './look/grade.ts';
import { LANTERN_UNIFORMS, LanternRig, lanternSources, type LanternSource } from './look/lanterns.ts';
import { LOOK_UNIFORMS, applyVoxelLook, removeVoxelLook, type VoxelLookOptions } from './look/voxelLook.ts';

export { OVERLAY_LAYER } from './engine/post.ts';

// 'low' renders straight to the screen without a grade pass, so it gets the same "punchy AgX"
// look through three's CustomToneMapping hook: AgX, then saturation and contrast, per material.
const CUSTOM_TM = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
if (THREE.ShaderChunk.tonemapping_pars_fragment.includes(CUSTOM_TM)) {
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
    CUSTOM_TM,
    `vec3 CustomToneMapping( vec3 color ) {
  vec3 g = pow( max( AgXToneMapping( color ), vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
  float l = dot( g, vec3( 0.2126, 0.7152, 0.0722 ) );
  g = mix( vec3( l ), g, 1.24 );
  g = ( g - 0.5 ) * 1.08 + 0.5;
  return pow( max( g, vec3( 0.0 ) ), vec3( 2.2 ) );
}`,
  );
}

const BASE_RATIO: Record<Quality, number> = { low: 1, medium: 1.25, high: 1.6, ultra: 2 };
/** drawing-buffer pixel caps so huge monitors do not melt integrated GPUs */
const PIXEL_CAP: Record<Quality, number> = { low: 2.1e6, medium: 3.7e6, high: 5.5e6, ultra: 8.9e6 };
const MIN_DYN_SCALE = 0.65;
const MENU_FAR = 900;
const PLAY_FAR = 400;
/** debugVoxelLook() preview numbers: the values the adoption notes recommend for wave 2 */
const PREVIEW_TERRAIN: VoxelLookOptions = { voxelSize: 0.25, space: 'world', seam: 0.22, bevel: 0.13, glint: 0.55 };
const PREVIEW_PUDGY: VoxelLookOptions = { voxelSize: 0.05, space: 'local', rim: 0.8, glint: 0.6 };

class HookEngine implements Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sky: SkyDome;
  private readonly shadows: ShadowRig;
  private readonly fog: THREE.FogExp2;
  private q: Quality;
  private targets: CaptureTargets | null = null;
  private post: PostPipeline | null = null;
  private weather: WeatherSystem | null = null;
  private menu: MenuBackdrop | null = null;
  private map: MapDef | null = null;
  private atmo: ResolvedAtmosphere;
  private groundMask: THREE.DataTexture | null = null;
  private readonly maskRect = new THREE.Vector4(-36, -24, 72, 48);
  private readonly bounds: ShadowBounds = { minX: -42, maxX: 42, minZ: -30, maxZ: 30, yLow: 0, yHigh: 7 };
  private width = 1;
  private height = 1;
  private clock = 0;
  private lastTime = Number.NaN;
  private lastDt = 1 / 60;
  // dynamic resolution
  private dynScale = 1;
  private frameEma = 1 / 60;
  private slowFor = 0;
  private fastFor = 0;
  private lastDropAt = -1e9;
  private shadowEvery = 1;
  /** the shadow update rate this tier starts at and recovers to (medium: every other frame) */
  private baseShadowEvery = 1;
  // ambient animation
  private readonly hemiBase = new THREE.Color();
  private readonly tmpColor = new THREE.Color();
  private nextFlash = 18;
  private flash = 0;
  private overlayCount = 0;
  private waterCount = 0;
  private disposed = false;
  /**
   * Lower the shadow update rate, then the pixel ratio, while frames stay slow. On by default,
   * off under ?debug so frame-stepped verification (advance()) renders at full resolution.
   */
  dynamicResolution = typeof location === 'undefined' || !new URLSearchParams(location.search).has('debug');
  private envKey = '';
  // cinematic mode (client/render/cinematic.ts): everything below stays null / unused while it is off
  /** the tier asked for by setQuality (cinematic renders 'ultra' on top of it) */
  private requested: Quality;
  private cine = false;
  private cineCfg: CinematicConfig | null = null;
  private cineLook: CineLook | null = null;
  private cinePass: CinematicPass | null = null;
  private cineGrade: LookGradeEffect | null = null;
  private lanterns: LanternRig | null = null;
  private lanternOverride: LanternSource[] | null = null;
  private readonly unsubCine: () => void;
  private profiler: GpuProfiler | null = null;
  /** cinematic: ambient scale so lantern pools read (1 = off) */
  private hemiScale = 1;
  /** materials adopted by debugVoxelLook() */
  private readonly previewLook = new Set<THREE.Material>();

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.AgXToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    r.autoClear = true;

    this.scene = new THREE.Scene();
    this.scene.name = 'HW.Scene';
    this.scene.background = null;
    this.fog = new THREE.FogExp2(0x87a8c8, 0.01);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(45, 1, 1, PLAY_FAR);
    this.camera.layers.mask = 1 | WATER_BIT | OVERLAY_BIT;

    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x3b3326, 1);
    this.hemi.layers.enableAll();
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.name = 'HW.Sun';
    this.sun.layers.enableAll();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.shadows = new ShadowRig(this.sun);

    this.requested = quality;
    this.cine = cinematicEnabled();
    if (this.cine) {
      quality = 'ultra';
      this.enterCinematic();
    }
    this.q = quality;
    this.sky = new SkyDome(quality);
    this.scene.add(this.sky.mesh);
    this.atmo = resolveAtmosphere(MENU_ATMOSPHERE, true);

    this.setQuality(this.requested);
    this.setAtmosphere(null, null);
    this.unsubCine = onCinematicChange((on) => this.onCinematic(on));
  }

  /** the effective tier: 'ultra' while cinematic mode is on */
  get quality(): Quality {
    return this.q;
  }

  /** true while cinematic mode is on */
  get cinematic(): boolean {
    return this.cine;
  }

  /** Turn cinematic mode on or off (it owns its state in client/render/cinematic.ts). */
  setCinematic(on: boolean): void {
    setCinematicMode(on);
  }

  /**
   * Replace the lantern lights derived from the map (props can report exact lamp positions here).
   * null goes back to the derived list. Only used while cinematic mode is on.
   */
  setLanternSources(list: LanternSource[] | null): void {
    this.lanternOverride = list;
    if (this.lanterns) this.lanterns.setSources(list ?? (this.map ? lanternSources(this.map) : []));
  }

  /**
   * Cinematic effect switches for profiling and weaker GPUs, e.g. configureCinematic({ dof: false }).
   * Same as setCinematicConfig() in client/render/cinematic.ts; returns the current switches.
   */
  configureCinematic(patch: Partial<CinematicConfig> = {}): Readonly<CinematicConfig> {
    setCinematicConfig(patch);
    return cinematicConfig();
  }

  /** Debug: GPU timer queries around every pass (null = off). Returns the profiler. */
  profileGpu(on: boolean): GpuProfiler | null {
    if (this.profiler) {
      this.profiler.dispose();
      this.profiler = null;
    }
    if (on) this.profiler = new GpuProfiler(this.renderer);
    this.wrapPasses();
    return this.profiler;
  }

  /**
   * Debug preview of wave-2 adoption (under ?debug&cinematic): give the voxel look to materials other
   * modules own, at runtime and without touching their files. Terrain chunks (vertex colours + colour
   * map, 0.25 m world-aligned columns) and the Lunkers ('pudgy', 0.05 m local voxels, plus the fresnel
   * rim). Props are BatchedMesh buckets that mix voxel sizes, so they need the attribute mode in their
   * own mesher and are left out here. Returns how many materials were adopted. Optional options override
   * the preview defaults (for tuning the wave-2 numbers live). The preview ends at the next map change.
   */
  debugVoxelLook(on: boolean, opts: { terrain?: VoxelLookOptions; pudgy?: VoxelLookOptions } = {}): number {
    for (const m of this.previewLook) removeVoxelLook(m);
    this.previewLook.clear();
    if (!on) return 0;
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (o as THREE.BatchedMesh).isBatchedMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of list) {
        const m = mat as THREE.MeshStandardMaterial;
        if (!m || !m.isMeshStandardMaterial || m.transparent || this.previewLook.has(m)) continue;
        if (m.name === 'pudgy') {
          applyVoxelLook(m, { ...PREVIEW_PUDGY, ...opts.pudgy });
          this.previewLook.add(m);
        } else if (m.vertexColors && m.map && !(o as THREE.InstancedMesh).isInstancedMesh) {
          applyVoxelLook(m, { ...PREVIEW_TERRAIN, ...opts.terrain });
          this.previewLook.add(m);
        }
      }
    });
    return this.previewLook.size;
  }

  private enterCinematic(): void {
    this.cineCfg = { ...cinematicConfig() };
    // the lantern pool is sized per map in applyCinematicAtmosphere (light count is part of every program)
    this.setLanternPool(0);
  }

  /** Resize the lantern light pool (0 = none). Changing the size recompiles lit materials: map changes only. */
  private setLanternPool(n: number): void {
    if ((this.lanterns ? this.lanterns.budget : 0) === n) return;
    if (this.lanterns) {
      this.scene.remove(this.lanterns.group);
      this.lanterns.dispose();
      this.lanterns = null;
    }
    if (n > 0) {
      this.lanterns = new LanternRig(n);
      this.scene.add(this.lanterns.group);
    }
    if (this.cinePass) this.cinePass.setLanterns(this.lanterns);
  }

  private leaveCinematic(): void {
    this.setLanternPool(0);
    LANTERN_UNIFORMS.hwLanternCount.value = 0;
    this.cinePass = null;
    this.cineGrade = null;
    this.cineLook = null;
    this.cineCfg = null;
  }

  private onCinematic(on: boolean): void {
    if (this.disposed) return;
    if (!on && !this.cine) return;
    this.cine = on;
    if (on) this.enterCinematic();
    else this.leaveCinematic();
    // the atmosphere values the cinematic look scaled go back to the map's own
    this.fog.density = this.atmo.fogDensity;
    this.hemiScale = 1;
    this.hemi.intensity = this.atmo.hemiIntensity;
    // rebuild the post pipeline (cinematic passes or none); applyCinematicAtmosphere runs in there
    this.setQuality(this.requested);
  }

  private buildCinematicPost(): { pass: CinematicPass; grade: LookGradeEffect } {
    const cfg = this.cineCfg ?? { ...cinematicConfig() };
    this.cinePass = new CinematicPass(this.camera, this.targets as CaptureTargets, this.sun, cfg, this.lanterns);
    this.cineGrade = new LookGradeEffect();
    return { pass: this.cinePass, grade: this.cineGrade };
  }

  /** Per-map cinematic look: grade, mist, rim, bloom, lights. */
  private applyCinematicAtmosphere(): void {
    const cfg = this.cineCfg;
    if (!cfg) return;
    const map = this.map;
    const look = cinematicLook(map, this.atmo.src);
    this.cineLook = look;
    this.fog.density = this.atmo.fogDensity * (map ? look.fogScale : 1);
    this.hemiScale = map ? look.ambient : 1;
    this.hemi.intensity = this.atmo.hemiIntensity * this.hemiScale;
    LOOK_UNIFORMS.hwLookRim.value.copy(look.fresnelRim);
    if (this.post && cfg.bloom) this.post.applyCinematicBloom(look.bloomIntensity, look.bloomThreshold, look.bloomRadius);
    if (this.post && cfg.grade && map) this.post.applyCinematicLift(look.grade.lift);
    if (this.cinePass) this.cinePass.apply(look, map !== null);
    if (this.cineGrade) this.cineGrade.set(look, cfg.grade);
    // lantern lights: as many as the map needs, up to the budget (day maps few, night maps many, menu none)
    const sources = map ? (this.lanternOverride ?? lanternSources(map)) : [];
    const want = cfg.lights ? Math.min(cfg.lightBudget, look.lightBudget, sources.length) : 0;
    // the light count is part of every lit program, so the pool size is quantised to two sizes: map
    // changes then reuse the same few program variants instead of compiling one per light count
    this.setLanternPool(want === 0 ? 0 : want <= 4 ? Math.min(4, cfg.lightBudget) : cfg.lightBudget);
    if (this.lanterns) {
      this.lanterns.strength = look.lanterns;
      this.lanterns.active = want;
      this.lanterns.setSources(sources);
    }
  }

  /** Debug profiling: time each composer pass (and N8AO) with GPU queries. */
  private wrapPasses(): void {
    const prof = this.profiler;
    if (!this.post) return;
    const passes = this.post.composer.passes as unknown as { name: string; render: (...a: unknown[]) => void; hwOrig?: (...a: unknown[]) => void }[];
    const ao = this.post.scenePass.ao as unknown as { render: (...a: unknown[]) => void; hwOrig?: (...a: unknown[]) => void } | null;
    const list = ao ? [...passes, Object.assign(ao, { name: 'N8AO' })] : passes;
    for (const p of list) {
      const orig = p.hwOrig ?? p.render;
      p.hwOrig = orig;
      if (!prof) {
        p.render = orig;
        continue;
      }
      // queries cannot nest: N8AO runs inside the scene pass, so it splits it into opaque | AO | water+overlay
      const isAo = p === (ao as unknown);
      const label = p.name === 'HW.ScenePass' ? 'scene.opaque+shadow' : p.name;
      p.render = function (this: unknown, ...a: unknown[]) {
        prof.begin(label);
        try {
          orig.apply(this, a);
        } finally {
          if (isAo) prof.begin('scene.water+overlay');
          else prof.end();
        }
      };
    }
    if (prof && this.cinePass) this.cinePass.timer = prof;
    else if (this.cinePass) this.cinePass.timer = null;
  }

  /** null on 'low' (water renders directly, no refraction source). Same object on every other tier. */
  get capture(): SceneCapture | null {
    return this.post && this.targets ? this.targets.capture : null;
  }

  /** world size of one shadow texel (debug / tuning) */
  get shadowTexelSize(): number {
    return this.shadows.texelSize;
  }

  /** current dynamic resolution scale (1 = tier pixel ratio) */
  get resolutionScale(): number {
    return this.dynScale;
  }

  setQuality(q: Quality): void {
    this.requested = q;
    // cinematic mode always renders the ultra tier
    if (this.cine) q = 'ultra';
    this.q = q;
    // direct-to-screen materials tone map themselves on 'low'; render targets never tone map
    this.renderer.toneMapping = q === 'low' ? THREE.CustomToneMapping : THREE.AgXToneMapping;
    this.shadows.setQuality(q);
    this.shadows.setEnabled(this.map !== null);
    this.sky.setQuality(q);
    if (this.post) {
      this.post.dispose();
      this.post = null;
    }
    this.dynScale = 1;
    this.applySize();
    if (q !== 'low') {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      if (!this.targets) this.targets = new CaptureTargets(size.x, size.y);
      this.targets.setSize(size.x, size.y);
      this.post = this.cine
        ? new PostPipeline(this.renderer, this.scene, this.camera, this.targets, q, this.buildCinematicPost())
        : new PostPipeline(this.renderer, this.scene, this.camera, this.targets, q);
      this.post.apply(this.atmo);
      if (this.cine) this.applyCinematicAtmosphere();
      if (this.profiler) this.wrapPasses();
      this.post.scenePass.sun = this.sun;
      this.baseShadowEvery = q === 'medium' ? 2 : 1;
      this.setShadowEvery(this.baseShadowEvery);
    } else {
      if (this.targets) this.targets.release();
      this.renderer.autoClear = true;
      this.renderer.setRenderTarget(null);
    }
    this.rebuildWeather();
  }

  setAtmosphere(map: MapDef | null, _config: MatchConfig | null): void {
    // the debug voxel-look preview holds the previous map's materials: let them go
    if (this.previewLook.size) this.debugVoxelLook(false);
    this.map = map;
    const a = resolveAtmosphere(map ? map.atmosphere : MENU_ATMOSPHERE, !map);
    this.atmo = a;

    if (map) {
      // the backdrop is kept (hidden) so returning to the menu does not re-mesh the islands
      if (this.menu) this.menu.group.visible = false;
      const gy = groundY(map);
      this.bounds.minX = -map.w / 2 - 6;
      this.bounds.maxX = map.w / 2 + 6;
      this.bounds.minZ = -map.d / 2 - 6;
      this.bounds.maxZ = map.d / 2 + 6;
      this.bounds.yLow = bedY(map);
      this.bounds.yHigh = gy + 6;
      this.camera.far = PLAY_FAR;
      // a sensible gameplay pose until the camera rig takes over
      this.camera.position.set(0, gy + 27.5, 19.8);
      this.camera.lookAt(0, gy, 0);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      this.buildGroundMask(map);
    } else {
      if (!this.menu) {
        this.menu = new MenuBackdrop(this.sky.uniforms, skyDefines(this.q).HW_CLOUD_OCTAVES, OVERLAY_LAYER);
        this.scene.add(this.menu.group);
      }
      this.menu.group.visible = true;
      this.camera.far = MENU_FAR;
      this.camera.updateProjectionMatrix();
      this.menu.update(this.clock, this.camera);
    }
    this.shadows.setEnabled(map !== null);

    this.fog.color.copy(a.fogColor);
    this.fog.density = a.fogDensity;
    this.hemiBase.copy(a.hemiSky);
    this.hemi.color.copy(a.hemiSky);
    this.hemi.groundColor.copy(a.hemiGround);
    this.hemi.intensity = a.hemiIntensity;
    this.sun.color.copy(a.sunColor);
    this.sun.intensity = a.sunIntensity;
    this.shadows.setDirection(a.sunDir);
    this.shadows.setIntensity(a.shadowIntensity);
    this.sun.target.position.set(0, 0, 0);
    this.sun.position.copy(a.sunDir).multiplyScalar(60);
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    this.renderer.toneMappingExposure = a.exposure;
    this.renderer.setClearColor(a.sky.below, 1);

    this.sky.apply(a.sky);
    this.sky.update(this.clock, this.camera);
    const envSize = this.q === 'low' ? 64 : 128;
    const key = (map ? map.id : 'menu') + ':' + envSize;
    if (key !== this.envKey || !this.scene.environment) {
      this.scene.environment = this.sky.buildEnvironment(this.renderer, envSize);
      this.envKey = key;
    }
    this.scene.environmentIntensity = a.envIntensity;
    if (this.post) this.post.apply(a);
    if (this.cine) this.applyCinematicAtmosphere();
    this.flash = 0;
    this.nextFlash = this.clock + 12 + Math.random() * 10;
    this.rebuildWeather();
  }

  private buildGroundMask(map: MapDef): void {
    if (this.groundMask) {
      this.groundMask.dispose();
      this.groundMask = null;
    }
    const res = 2; // texels per metre
    const nx = Math.ceil(map.w * res);
    const nz = Math.ceil(map.d * res);
    const data = new Uint8Array(nx * nz);
    const edge = -(map.river.bank + 0.35);
    for (let j = 0; j < nz; j++) {
      const z = -map.d / 2 + (j + 0.5) / res;
      for (let i = 0; i < nx; i++) {
        const x = -map.w / 2 + (i + 0.5) / res;
        data[i + j * nx] = channelDepthAt(map, x, z) < edge ? 255 : 0;
      }
    }
    const tex = new THREE.DataTexture(data, nx, nz, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.groundMask = tex;
    this.maskRect.set(-map.w / 2, -map.d / 2, map.w, map.d);
  }

  private rebuildWeather(): void {
    if (this.weather) {
      this.weather.dispose();
      this.weather = null;
    }
    const a = this.atmo;
    if (!this.map || a.weather === 'none') return;
    // particle tint: what a white flake looks like under this sky
    const tint = new THREE.Color()
      .copy(a.sunColor)
      .multiplyScalar(a.sunIntensity * 0.2)
      .add(this.tmpColor.copy(a.hemiSky).multiplyScalar(a.hemiIntensity * 1.6));
    const l = tint.r * 0.2126 + tint.g * 0.7152 + tint.b * 0.0722;
    const target = a.weather === 'rain' ? 0.6 : 0.8;
    tint.multiplyScalar(target / Math.max(l, 1e-3));
    this.weather = new WeatherSystem({
      kind: a.weather,
      quality: this.q,
      groundY: groundY(this.map),
      tint,
      sunColor: a.sunColor,
      groundMask: this.groundMask,
      maskRect: this.maskRect,
      overlayLayer: OVERLAY_LAYER,
      seed: this.map.id.length * 977 + 13,
      cinematic: this.cine,
    });
    this.scene.add(this.weather.group);
    this.updateWeatherView();
  }

  private updateWeatherView(): void {
    if (!this.weather) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const ps = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.weather.setView(ps, size.x, size.y, this.renderer.getPixelRatio());
  }

  update(dt: number, time: number, focusX: number, focusZ: number): void {
    if (this.disposed) return;
    let d = time - this.lastTime;
    if (!(d >= 0 && d < 0.25)) d = Math.min(Math.max(dt, 0), 0.1);
    this.lastTime = time;
    this.lastDt = d;
    this.clock += d;
    if (this.clock > 3600) {
      // keep shader time small for precision; shift the timers that are scheduled on it too
      this.clock -= 3600;
      this.nextFlash -= 3600;
      this.lastDropAt -= 3600;
    }
    const t = this.clock;

    if (this.menu && !this.map) this.menu.update(t, this.camera);
    this.sky.update(t, this.camera);
    if (this.map) this.shadows.update(this.camera, focusX, focusZ, this.bounds);
    if (this.weather) this.weather.update(t, focusX, focusZ);
    this.animateAmbient(t, d);
    this.adaptResolution(d);
    if (this.cine) {
      if (this.lanterns) {
        this.lanterns.update(d, t, focusX, focusZ);
        // the same pool for materials that light themselves (water): see LANTERN_UNIFORMS
        LANTERN_UNIFORMS.hwLanternCount.value = this.lanterns.fill(LANTERN_UNIFORMS.hwLanternPos.value, LANTERN_UNIFORMS.hwLanternCol.value);
      } else LANTERN_UNIFORMS.hwLanternCount.value = 0;
      if (this.cinePass) this.cinePass.update(t, focusX, this.map ? groundY(this.map) : 0, focusZ);
    }
  }

  private animateAmbient(t: number, d: number): void {
    const a = this.atmo;
    if (a.ambientDrift > 0) {
      // aurora light slowly washing over the ground: green to teal to violet
      const k = 0.5 + 0.5 * Math.sin(t * 0.11);
      const k2 = 0.5 + 0.5 * Math.sin(t * 0.07 + 1.3);
      this.tmpColor.setRGB(0.08 + 0.25 * k2, 0.55 + 0.3 * k, 0.45 + 0.4 * (1 - k));
      this.hemi.color.copy(this.hemiBase).lerp(this.tmpColor.multiplyScalar(this.hemiBase.r + this.hemiBase.g + this.hemiBase.b), 0.18);
    }
    if (a.weather === 'rain' && this.map) {
      // distant lightning: a double flicker every 15 to 35 s, lights the clouds and a little of the ground
      if (t >= this.nextFlash) {
        this.flash = 0.42;
        this.nextFlash = t + 15 + Math.random() * 20;
      }
      if (this.flash > 0) this.flash = Math.max(0, this.flash - d);
      const f = this.flash;
      const pulse = f > 0 ? Math.max(0, Math.sin(((0.42 - f) / 0.42) * Math.PI * 3)) * (f / 0.42) : 0;
      this.hemi.intensity = a.hemiIntensity * this.hemiScale * (1 + pulse * 0.55);
      this.sky.uniforms.uCloudLit.value.copy(a.sky.cloudLit).multiplyScalar(1 + pulse * 5);
    }
  }

  private setShadowEvery(n: number): void {
    this.shadowEvery = n;
    if (this.post) this.post.scenePass.shadowEvery = n;
  }

  private adaptResolution(d: number): void {
    if (!this.dynamicResolution) {
      if (this.dynScale !== 1) {
        this.dynScale = 1;
        this.applySize();
      }
      if (this.shadowEvery !== this.baseShadowEvery) this.setShadowEvery(this.baseShadowEvery);
      return;
    }
    if (d <= 0 || d > 0.1) return;
    this.frameEma = this.frameEma * 0.94 + d * 0.06;
    if (this.frameEma > 1 / 47) {
      this.slowFor += d;
      this.fastFor = 0;
    } else if (this.frameEma < 1 / 57.5) {
      this.fastFor += d;
      this.slowFor = 0;
    } else {
      this.slowFor = 0;
      this.fastFor = 0;
    }
    // ladder: first halve the shadow map update rate (not on ultra), then lower the resolution
    if (this.slowFor > 2.5) {
      this.slowFor = 0;
      this.lastDropAt = this.clock;
      if (this.shadowEvery === 1 && this.q !== 'ultra' && this.map) this.setShadowEvery(2);
      else if (this.dynScale > MIN_DYN_SCALE) {
        this.dynScale = Math.max(MIN_DYN_SCALE, this.dynScale * 0.85);
        this.applySize();
      }
    } else if (this.fastFor > 6 && Math.abs(this.clock - this.lastDropAt) > 20) {
      this.fastFor = 0;
      if (this.dynScale < 1) {
        this.dynScale = Math.min(1, this.dynScale / 0.85);
        this.applySize();
      } else if (this.shadowEvery !== this.baseShadowEvery) this.setShadowEvery(this.baseShadowEvery);
    }
  }

  /** Route transparent layer-0 objects to the overlay layer and make every light see all layers. */
  private routeLayers(): void {
    this.overlayCount = 0;
    this.waterCount = 0;
    this.scene.traverse(this.routeFn);
  }

  private readonly routeFn = (o: THREE.Object3D): void => {
    const m = o.layers.mask;
    if ((o as THREE.Light).isLight) {
      if ((m & 1) !== 0 && (m & (WATER_BIT | OVERLAY_BIT)) !== (WATER_BIT | OVERLAY_BIT)) o.layers.mask = m | WATER_BIT | OVERLAY_BIT;
      return;
    }
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    if (m & WATER_BIT) {
      this.waterCount++;
      return;
    }
    let transparent = false;
    if (Array.isArray(mat)) {
      for (let i = 0; i < mat.length; i++) if (mat[i].transparent) transparent = true;
    } else transparent = mat.transparent;
    const ud = o.userData as { hwAuto?: boolean };
    if (transparent) {
      if (m & 1) {
        o.layers.mask = (m & ~1) | OVERLAY_BIT;
        ud.hwAuto = true;
      }
      this.overlayCount++;
    } else if (ud.hwAuto) {
      o.layers.mask = (m & ~OVERLAY_BIT) | 1;
      ud.hwAuto = false;
    } else if (m & OVERLAY_BIT) this.overlayCount++;
  };

  render(): void {
    if (this.disposed) return;
    const r = this.renderer;
    if (this.post) {
      this.routeLayers();
      this.post.scenePass.overlayActive = this.overlayCount > 0;
      this.post.scenePass.waterActive = this.waterCount > 0;
      this.post.render(this.lastDt);
    } else {
      r.setRenderTarget(null);
      r.autoClear = true;
      r.setClearColor(this.atmo.sky.below, 1);
      r.shadowMap.needsUpdate = true;
      this.camera.layers.mask |= 1 | WATER_BIT | OVERLAY_BIT;
      r.render(this.scene, this.camera);
    }
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.applySize();
  }

  private pixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    let pr = this.q === 'low' ? 1 : Math.min(dpr, BASE_RATIO[this.q]);
    const px = this.width * this.height * pr * pr;
    const cap = PIXEL_CAP[this.q];
    if (px > cap) pr *= Math.sqrt(cap / px);
    return Math.max(0.5, pr * this.dynScale);
  }

  private applySize(): void {
    const r = this.renderer;
    r.setPixelRatio(this.pixelRatio());
    r.setSize(this.width, this.height, false);
    if (this.post) this.post.setSize(this.width, this.height);
    this.updateWeatherView();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubCine();
    if (this.profiler) this.profiler.dispose();
    this.profiler = null;
    this.leaveCinematic();
    if (this.post) this.post.dispose();
    this.post = null;
    if (this.targets) this.targets.dispose();
    this.targets = null;
    if (this.weather) this.weather.dispose();
    this.weather = null;
    if (this.menu) this.menu.dispose();
    this.menu = null;
    if (this.groundMask) this.groundMask.dispose();
    this.groundMask = null;
    this.scene.environment = null;
    this.sky.dispose();
    if (this.sun.shadow.map) this.sun.shadow.map.dispose();
    this.renderer.dispose();
  }
}

export function createEngine(canvas: HTMLCanvasElement, quality: Quality): Engine {
  return new HookEngine(canvas, quality);
}
