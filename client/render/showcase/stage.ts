// Showcase stage: the reference images' staged vignette, as a reusable set.
//
// A low camera close to a lantern-lit dock, a few props from the props module's own builders, the
// stage's own harbour water with lantern streaks and wet planks, mist veils, and the player's Lunker
// (createPudgy at detail 'showcase') posed in front, with a slow camera drift. Four themes follow the
// map moods (themes.ts). Two modes:
//   'backdrop'  the main-menu backdrop inside the engine's scene (Epic only). The stage drives the
//               engine camera and, while active, sets the engine's sky, moon / sun, fill, fog and
//               environment to the theme's (hostLook.ts), putting them back when it stops.
//   'preview'   a small separate renderer (the Locker / Store turntable, client/ui/preview.ts). The stage
//               brings its own sky dome, environment, moon and fill and leaves the camera to the host;
//               put the turntable at `anchor` (the stage is offset so the anchor is the world origin).
// Nothing here changes a material or a cached model another module owns: props, platforms and the
// Lunker are used as their builders return them (their own voxel-look adoption applies as it lands).
import * as THREE from 'three';
import type { Loadout } from '../../../shared/cosmetics.ts';
import { getMap } from '../../../shared/maps/index.ts';
import type { MapDef, Obstacle } from '../../../shared/maps/types.ts';
import { UnitState, type FamilyId, type Team } from '../../../shared/types.ts';
import { groundY, platformDeckY, waterY, type PudgyOneShot, type PudgyView, type Quality } from '../contracts.ts';
import { resolveAtmosphere, type ResolvedAtmosphere, type SkyLook } from '../engine/atmosphere.ts';
import { SkyDome, type SkyUniforms } from '../engine/sky.ts';
import { lanternSources, type LanternSource } from '../look/lanterns.ts';
import { applyVoxelLook } from '../look/voxelLook.ts';
import { buildDecor, buildPlatforms, buildProps, createMoverView, disposePropGroup } from '../models/props.ts';
import { createPudgy } from '../models/pudgy.ts';
import { meshVoxels } from '../voxel/voxel.ts';
import { EnvSwap, HostLook } from './hostLook.ts';
import { islandGrid, lighthouseGrid, ridgeGrid, slabGrid } from './landmarks.ts';
import { createLanternUniforms, createMist, createStageWater, createWetSheen, puddleTexture, rippleNormalTexture, type StageLanternUniforms, type StageMist, type StageWater } from './materials.ts';
import { THEMES, inPlatform as inRect, mistVeils, sheenSurfaces, stageMap, themeAtmosphere, type ShowcaseTheme, type ShowcaseThemeId, type SlabDef } from './themes.ts';

export interface ShowcaseLook {
  family: FamilyId;
  loadout: Loadout;
  team: Team;
  name?: string;
}

/** What the stage draws into. An Engine fits (scene, camera, renderer); so does the Locker preview. */
export interface ShowcaseHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** optional: the stage captures it from its first rendered frame when missing (menu backdrop) */
  renderer?: THREE.WebGLRenderer | null;
  /** backdrop mode: the engine's sky uniforms (the stage restyles the engine's own sky dome) */
  sky?: SkyUniforms | null;
}

/** Where the Lunker sits in the frame (backdrop mode): fractions of the screen from the left / top. */
export interface ShowcaseFrame {
  x: number;
  feet: number;
  head: number;
}

export interface ShowcaseOptions {
  theme?: ShowcaseThemeId;
  mode?: 'backdrop' | 'preview';
  /** props detail (Epic menu: 'ultra'; Locker preview: 'high') */
  quality?: Quality;
  /** the Lunker to pose (null = none until setLook; a preview host that keeps its own turntable model passes none) */
  look?: ShowcaseLook | null;
  frame?: Partial<ShowcaseFrame>;
  /** slow camera drift (backdrop mode), default true */
  drift?: boolean;
}

export interface ShowcaseStage {
  readonly group: THREE.Group;
  readonly mode: 'backdrop' | 'preview';
  readonly theme: ShowcaseThemeId;
  /** where the Lunker stands (preview mode: the world origin; add your turntable here or at the origin) */
  readonly anchor: THREE.Group;
  setTheme(id: ShowcaseThemeId): void;
  /** the posed Lunker; null removes it */
  setLook(look: ShowcaseLook | null): void;
  play(shot: PudgyOneShot): void;
  /** spin the posed Lunker by a horizontal drag in pixels */
  drag(dx: number): void;
  setFrame(f: Partial<ShowcaseFrame>): void;
  /** backdrop mode: show or hide the stage; hiding puts the engine's own look back */
  setActive(on: boolean): void;
  readonly active: boolean;
  /** per frame (backdrop mode also places the camera) */
  update(dt: number, time: number): void;
  /** debug / proof: numbers about the current build */
  stats(): { theme: ShowcaseThemeId; lights: number; meshes: number; lunker: boolean; height: number };
  /** debug: live look tuning (env / moon / fill strengths, light multipliers) until the next theme change */
  tune(p: { env?: number; rim?: number; hemi?: number; fog?: number; key?: number; lamps?: number }): void;
  dispose(): void;
}

const DEFAULT_FRAME: ShowcaseFrame = { x: 0.678, feet: 0.775, head: 0.15 };
/** camera eye height above the deck (m): the references' low angle */
const EYE = 0.8;
const ONE_SHOTS: readonly PudgyOneShot[] = ['celebrate', 'throw', 'bash', 'melee'];
const WHITE = new THREE.Color(1, 1, 1);
/** lamps the water mirrors beyond the four lit ones, and lamps that glow in the mist (per-pixel loops) */
const MAX_FAR = 10;
const MAX_NEAR = 6;

interface Built {
  theme: ShowcaseTheme;
  map: MapDef;
  atmo: ResolvedAtmosphere;
  sky: SkyLook;
  root: THREE.Group;
  /** where the Lunker's feet are: the dock deck, or the top of a snow sheet laid over it */
  standY: number;
  water: number;
  disposables: { dispose(): void }[];
  propGroups: THREE.Object3D[];
  waterMat: StageWater;
  mist: StageMist;
  key: THREE.SpotLight;
  points: THREE.PointLight[];
  /** base intensity of key and points (flicker multiplies these) */
  base: number[];
  seeds: number[];
  nearPool: StageLanternUniforms;
  farPool: StageLanternUniforms;
  env: THREE.Texture | null;
  envSky: SkyDome | null;
  /** preview mode: own lights and sky */
  own: THREE.Object3D[];
  ownSky: SkyDome | null;
  hostLook: ReturnType<typeof hostValues>;
}

function hostValues(t: ShowcaseTheme, atmo: ResolvedAtmosphere, sky: SkyLook) {
  return {
    sky,
    sunColor: t.rim.color !== undefined ? new THREE.Color(t.rim.color) : atmo.sunColor.clone(),
    sunIntensity: t.rim.intensity,
    sunDir: t.rim.dir ? new THREE.Vector3(...t.rim.dir).normalize() : atmo.sunDir.clone(),
    hemiSky: new THREE.Color(t.hemi.sky),
    hemiGround: new THREE.Color(t.hemi.ground),
    hemiIntensity: t.hemi.intensity,
    fogColor: new THREE.Color(t.fog.color),
    fogDensity: t.fog.density,
    environment: null as THREE.Texture | null,
    envIntensity: t.envIntensity,
  };
}

/** Lamp positions of the stage's props and decor, at their real heights (deck, quay or bank). */
function stageLamps(map: MapDef, height: (x: number, z: number) => number): LanternSource[] {
  const gy = groundY(map);
  const out: LanternSource[] = [];
  for (const o of map.obstacles) {
    const one = lanternSources({ ...map, obstacles: [o], decor: [] });
    const bx = o.shape === 'circle' ? o.x : (o.ax + o.bx) / 2;
    const bz = o.shape === 'circle' ? o.z : (o.az + o.bz) / 2;
    const dy = height(bx, bz) - gy;
    for (const s of one) out.push({ ...s, y: s.y + dy });
  }
  for (const dcr of map.decor) {
    const one = lanternSources({ ...map, obstacles: [], decor: [dcr] });
    const dy = height(dcr.x, dcr.z) - gy;
    for (const s of one) out.push({ ...s, y: s.y + dy });
  }
  return out;
}

export function createShowcaseStage(host: ShowcaseHost, opts: ShowcaseOptions = {}): ShowcaseStage {
  const mode = opts.mode ?? 'backdrop';
  const quality: Quality = opts.quality ?? (mode === 'backdrop' ? 'ultra' : 'high');
  const drift = opts.drift ?? true;
  const frame: ShowcaseFrame = { ...DEFAULT_FRAME, ...(opts.frame ?? {}) };
  const group = new THREE.Group();
  group.name = 'HW.Showcase';
  const anchor = new THREE.Group();
  anchor.name = 'HW.ShowcaseAnchor';
  group.add(anchor);
  const ripple = rippleNormalTexture(256, 7);
  const puddles = puddleTexture(256, 11);
  const voxMat = new THREE.MeshStandardMaterial({ name: 'HW.ShowcaseVoxels', vertexColors: true, roughness: 0.9, metalness: 0 });
  // my own voxel slabs and landmarks get the bevelled-cube look in cinematic (a no-op while it is off)
  applyVoxelLook(voxMat, { voxelSize: 'attribute', fallbackSize: 0.25, seam: 0.22, bevel: 0.13, glint: 0.55 });
  // snow: the same cubes with soft seams and no per-cube sparkle or tint (otherwise a snow field reads as
  // bathroom tiles at the low camera)
  const snowMat = new THREE.MeshStandardMaterial({ name: 'HW.ShowcaseSnow', vertexColors: true, roughness: 0.82, metalness: 0 });
  applyVoxelLook(snowMat, { voxelSize: 'attribute', fallbackSize: 0.25, seam: 0.06, bevel: 0.07, tilt: 0.35, glint: 0.15, tile: 0 });
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 7, 4), fog: false });
  const hostLook = mode === 'backdrop' ? new HostLook(host.scene, host.sky ?? null) : null;
  const envSwap = mode === 'preview' ? new EnvSwap(host.scene) : null;

  let renderer: THREE.WebGLRenderer | null = host.renderer ?? null;
  let ownFog: THREE.FogExp2 | null = null;
  let built: Built | null = null;
  let themeId: ShowcaseThemeId = opts.theme ?? 'harbourNight';
  let active = mode === 'preview';
  let look: ShowcaseLook | null = opts.look ?? null;
  let pudgy: PudgyView | null = null;
  let modelH = 2.3;
  let refitIn = 0;
  let yaw = 0;
  let yawVel = 0;
  let t = 0;
  let nextShot = 14;
  let disposed = false;
  let lookKey = '';

  const camTarget = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  function build(id: ShowcaseThemeId): Built {
    const theme = THEMES[id];
    const baseMap = getMap(theme.map);
    const map = stageMap(baseMap, theme);
    const atmo = resolveAtmosphere(themeAtmosphere(baseMap, theme), false);
    const sky: SkyLook = { ...atmo.sky, ...theme.sky } as SkyLook;
    sky.below = new THREE.Color(theme.fog.color);
    const root = new THREE.Group();
    root.name = 'HW.ShowcaseSet:' + id;
    const disposables: { dispose(): void }[] = [];
    const gy = groundY(map);
    const water = waterY(map, 1);
    const dock = theme.platforms.find((p) => p.kind === 'dock') ?? theme.platforms[0];
    const deckY = dock ? platformDeckY(map, dock) : gy;
    // a slab's top: above the bank top, or above the dock's deck (a snow sheet laid over the planks)
    const slabTop = (s: SlabDef): number => (s.onDeck ? deckY : gy) + s.top;
    const L = theme.lunker;
    const under = theme.slabs.find((s) => s.onDeck && L.x >= s.x0 && L.x <= s.x1 && L.z >= s.z0 && L.z <= s.z1);
    const standY = under ? slabTop(under) : deckY;
    const height = (x: number, z: number): number => {
      for (const p of theme.platforms) if (inRect(p, x, z)) return platformDeckY(map, p);
      for (const s of theme.slabs) if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) return slabTop(s);
      // open water: anything standing here rises from below the surface
      return water - 0.35;
    };

    // props module: decks, obstacles, decor, a moored barge
    const propGroups: THREE.Object3D[] = [];
    const plat = buildPlatforms(theme.platforms, map, quality);
    const props = buildProps(theme.obstacles as Obstacle[], map, height, quality);
    const decor = buildDecor(theme.decor, map, height, () => water, quality);
    propGroups.push(plat, props, decor);
    root.add(plat, props, decor);
    for (const mv of theme.movers) {
      const v = createMoverView(mv.def, map);
      v.position.set(mv.x, water, mv.z);
      v.rotation.y = mv.yaw;
      root.add(v);
      propGroups.push(v);
    }
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.receiveShadow = true;
    });

    // my slabs (quays, banks) and landmarks
    for (const s of theme.slabs) {
      const nx = Math.max(1, Math.round((s.x1 - s.x0) / s.voxel));
      const nz = Math.max(1, Math.round((s.z1 - s.z0) / s.voxel));
      const ny = Math.max(1, Math.round(s.depth / s.voxel));
      // no drift or tussock where the Lunker stands (his boots stay on the surface he is posed on)
      const keep = [{ x: (L.x - s.x0) / s.voxel, z: (L.z - s.z0) / s.voxel, r: 0.85 / s.voxel }];
      const geo = meshVoxels(slabGrid(nx, ny, nz, s.style, s.seed, keep), { size: s.voxel, aoStrength: 0.5, pivot: [0, 0, 0] });
      disposables.push(geo);
      const m = new THREE.Mesh(geo, s.style.soft ? snowMat : voxMat);
      m.position.set(s.x0, slabTop(s) - ny * s.voxel, s.z0);
      m.receiveShadow = true;
      m.castShadow = false;
      root.add(m);
    }
    for (const l of theme.landmarks) {
      let geo: THREE.BufferGeometry;
      if (l.kind === 'lighthouse') geo = meshVoxels(lighthouseGrid(), { size: l.size, aoStrength: 0.5 });
      else if (l.kind === 'island') geo = meshVoxels(islandGrid(l.nx ?? 40, l.nz ?? 30, l.h ?? 10, l.seed, l.palms ?? 0), { size: l.size, aoStrength: 0.55 });
      else geo = meshVoxels(ridgeGrid(l.nx ?? 120, l.nz ?? 24, l.h ?? 40, l.seed, [0x5a6478, 0x4c5668, 0x687286], [0xe8eef8, 0xd6e0ee, 0xf4f8fc], 0.45), { size: l.size, aoStrength: 0.5 });
      disposables.push(geo);
      const m = new THREE.Mesh(geo, voxMat);
      m.position.set(l.x, water + l.y, l.z);
      m.rotation.y = l.yaw;
      root.add(m);
      if (l.kind === 'lighthouse') {
        const lampGeo = new THREE.BoxGeometry(1.5 * l.size / 0.62, 1.6 * l.size / 0.62, 1.5 * l.size / 0.62);
        disposables.push(lampGeo);
        const lamp = new THREE.Mesh(lampGeo, lampMat);
        lamp.position.set(l.x, water + l.y + 28.5 * l.size, l.z);
        root.add(lamp);
      }
    }

    // water
    const nearPool = createLanternUniforms();
    const farPool = createLanternUniforms();
    const waterMat = createStageWater(theme.water, ripple, farPool, theme.lanterns * 0.6);
    disposables.push(waterMat);
    const wgeo = new THREE.PlaneGeometry(900, 900, 1, 1);
    wgeo.rotateX(-Math.PI / 2);
    const uv = wgeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (900 / theme.water.tile), uv.getY(i) * (900 / theme.water.tile));
    disposables.push(wgeo);
    const wmesh = new THREE.Mesh(wgeo, waterMat.material);
    wmesh.name = 'HW.ShowcaseWater';
    wmesh.position.set(0, water, -250);
    wmesh.receiveShadow = true;
    wmesh.frustumCulled = false;
    // the menu backdrop has no renderer handle: take it from the first frame that draws the water
    wmesh.onBeforeRender = (r) => {
      renderer = r;
    };
    root.add(wmesh);

    // wet sheen on the decks and quay tops (night and dusk themes); never on snow (sheenSurfaces)
    const wet = sheenSurfaces(theme);
    if (wet.platforms.length + wet.slabs.length > 0) {
      const sheenMat = createWetSheen(puddles, ripple, theme.sheen);
      disposables.push(sheenMat);
      const tops: { x: number; z: number; w: number; d: number; rot: number; y: number }[] = [];
      for (const p of wet.platforms) tops.push({ x: p.x, z: p.z, w: p.w, d: p.d, rot: p.rot, y: platformDeckY(map, p) });
      for (const s of wet.slabs) tops.push({ x: (s.x0 + s.x1) / 2, z: (s.z0 + s.z1) / 2, w: s.x1 - s.x0, d: s.z1 - s.z0, rot: 0, y: slabTop(s) });
      for (const tp of tops) {
        const g = new THREE.PlaneGeometry(tp.w, tp.d, 1, 1);
        g.rotateX(-Math.PI / 2);
        const u = g.getAttribute('uv') as THREE.BufferAttribute;
        for (let i = 0; i < u.count; i++) u.setXY(i, u.getX(i) * (tp.w / 4), u.getY(i) * (tp.d / 4));
        disposables.push(g);
        const m = new THREE.Mesh(g, sheenMat);
        m.name = 'HW.ShowcaseSheen';
        m.position.set(tp.x, tp.y + 0.004, tp.z);
        m.rotation.y = tp.rot;
        m.renderOrder = 2;
        root.add(m);
      }
    }

    // lights: the nearest lamp is the shadowed key; the next three are point lights; the rest are
    // mirrored in the water and glow in the mist only
    const lamps = stageLamps(map, height);
    lamps.sort((a, b) => Math.hypot(a.x - L.x, a.z - L.z) - Math.hypot(b.x - L.x, b.z - L.z));
    const key = new THREE.SpotLight(theme.key.color, 0, 0, theme.key.angle, theme.key.penumbra, 2);
    key.name = 'HW.ShowcaseKey';
    key.castShadow = true;
    // the key's cone covers a few metres of deck: 1024 texels are about 1 cm there
    const sm = 1024;
    key.shadow.mapSize.set(sm, sm);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.camera.near = 0.2;
    key.shadow.camera.far = 40;
    const base: number[] = [];
    const seeds: number[] = [];
    if (theme.key.kind === 'sun' && theme.key.dir) {
      const dir = new THREE.Vector3(...theme.key.dir).normalize();
      key.position.set(L.x, standY, L.z).addScaledVector(dir, 30);
      key.decay = 0;
      key.distance = 0;
      key.shadow.camera.near = 20;
      key.shadow.camera.far = 44;
      key.target.position.set(L.x, standY, L.z - 2);
      base.push(theme.key.intensity);
      seeds.push(0);
    } else {
      const k = lamps.shift();
      if (k) {
        key.position.set(k.x, k.y, k.z);
        seeds.push(k.seed);
      } else {
        key.position.set(L.x - 1.8, standY + 2, L.z + 0.6);
        seeds.push(1);
      }
      key.distance = 0;
      key.decay = 2;
      key.target.position.set(L.x + 0.5, standY, L.z - 0.8);
      base.push(theme.key.intensity * theme.lanterns);
      key.shadow.camera.far = 18;
    }
    key.color.set(theme.key.color);
    root.add(key, key.target);
    const points: THREE.PointLight[] = [];
    for (let i = 0; i < 3; i++) {
      const s = lamps.shift();
      // a little whiter than the flame: the grade already warms the frame and the Lunker keeps its colours
      const p = new THREE.PointLight(s ? s.color.clone().lerp(WHITE, 0.3) : new THREE.Color(0xffa850), 0, s ? s.range * 1.3 : 6, 2);
      p.name = 'HW.ShowcaseLamp' + i;
      p.castShadow = false;
      if (s) p.position.set(s.x, s.y, s.z);
      else p.position.set(0, -50, 0);
      base.push(s ? s.intensity * theme.lanterns : 0);
      seeds.push(s ? s.seed : 0);
      points.push(p);
      root.add(p);
    }
    // pools: near = the four lit lamps (mist glow), far = every other lamp (water mirror, mist glow)
    const lit: { p: THREE.Vector3; c: THREE.Color; i: number; r: number }[] = [];
    if (theme.key.kind !== 'sun') lit.push({ p: key.position, c: key.color, i: base[0], r: 7 });
    for (let i = 0; i < points.length; i++) if (base[i + 1] > 0) lit.push({ p: points[i].position, c: points[i].color, i: base[i + 1], r: points[i].distance });
    let n = 0;
    for (const l of lit) {
      nearPool.hwLanternPos.value[n].set(l.p.x, l.p.y, l.p.z, l.r);
      nearPool.hwLanternCol.value[n].set(l.c.r * l.i, l.c.g * l.i, l.c.b * l.i);
      n++;
    }
    let fn = 0;
    for (const s of lamps) {
      if (fn >= MAX_FAR) break;
      const k = s.intensity * theme.lanterns * 0.12;
      farPool.hwLanternPos.value[fn].set(s.x, s.y, s.z, s.range);
      farPool.hwLanternCol.value[fn].set(s.color.r * k, s.color.g * k, s.color.b * k);
      fn++;
      if (n < MAX_NEAR) {
        nearPool.hwLanternPos.value[n].set(s.x, s.y, s.z, s.range);
        nearPool.hwLanternCol.value[n].set(s.color.r * s.intensity * theme.lanterns, s.color.g * s.intensity * theme.lanterns, s.color.b * s.intensity * theme.lanterns);
        n++;
      }
    }
    nearPool.hwLanternCount.value = n;
    farPool.hwLanternCount.value = fn;

    // mist veils
    const mist = createMist(mistVeils(theme, height, water), new THREE.Color(theme.mist.color), nearPool, theme.mist.glow);
    disposables.push(mist);
    root.add(mist.mesh);

    // preview mode: own moon / sun, fill and sky
    const own: THREE.Object3D[] = [];
    let ownSky: SkyDome | null = null;
    if (mode === 'preview') {
      const hv = hostValues(theme, atmo, sky);
      const hemi = new THREE.HemisphereLight(hv.hemiSky, hv.hemiGround, hv.hemiIntensity);
      const moon = new THREE.DirectionalLight(hv.sunColor, hv.sunIntensity);
      moon.position.copy(hv.sunDir).multiplyScalar(60);
      own.push(hemi, moon, moon.target);
      ownSky = new SkyDome(quality);
      ownSky.apply(sky);
      own.push(ownSky.mesh);
      for (const o of own) root.add(o);
    }

    // the stage space puts the Lunker spot at the anchor; preview mode moves the whole set so the
    // anchor is the world origin
    anchor.position.set(L.x, standY, L.z);
    if (mode === 'preview') group.position.set(-L.x, -standY, -L.z);
    else group.position.set(0, 0, 0);

    return {
      theme,
      map,
      atmo,
      sky,
      root,
      standY,
      water,
      disposables,
      propGroups,
      waterMat,
      mist,
      key,
      points,
      base,
      seeds,
      nearPool,
      farPool,
      env: null,
      envSky: null,
      own,
      ownSky,
      hostLook: hostValues(theme, atmo, sky),
    };
  }

  function teardown(b: Built): void {
    // never leave a disposed environment on the host's scene
    if (b.env && host.scene.environment === b.env) {
      if (hostLook) hostLook.restore();
      if (envSwap) envSwap.release(b.env);
    }
    b.root.removeFromParent();
    for (const g of b.propGroups) disposePropGroup(g);
    for (const d of b.disposables) d.dispose();
    b.key.dispose();
    for (const p of b.points) p.dispose();
    if (b.envSky) b.envSky.dispose();
    if (b.ownSky) b.ownSky.dispose();
  }

  function ensureBuilt(): Built {
    if (!built) {
      built = build(themeId);
      group.add(built.root);
      yaw = built.theme.lunker.yaw;
    }
    return built;
  }

  function buildEnv(b: Built): void {
    if (b.env || !renderer) return;
    try {
      const s = new SkyDome(quality);
      s.apply(b.sky);
      b.env = s.buildEnvironment(renderer, 128);
      b.envSky = s;
      b.hostLook.environment = b.env;
      if (envSwap && b.env) envSwap.set(b.env, b.theme.envIntensity);
    } catch (err) {
      console.warn('[showcase] environment build failed', err);
    }
  }

  function disposePudgy(): void {
    if (!pudgy) return;
    pudgy.root.removeFromParent();
    try {
      pudgy.dispose();
    } catch {
      // ignore
    }
    pudgy = null;
  }

  function rebuildLunker(): void {
    const key = look ? `${look.family}|${JSON.stringify(look.loadout)}|${look.team}` : '';
    if (key === lookKey) return;
    lookKey = key;
    disposePudgy();
    if (!look) return;
    try {
      const v = createPudgy({ family: look.family, loadout: look.loadout, team: look.team, name: look.name ?? 'Lunker', isLocal: true, quality: 'high', detail: 'showcase' });
      v.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      anchor.add(v.root);
      v.root.rotation.y = 0;
      v.update(1 / 60, anim());
      pudgy = v;
      refitIn = 0.25;
    } catch (err) {
      console.warn('[showcase] could not build the Lunker', err);
      pudgy = null;
    }
  }

  function anim() {
    return { state: UnitState.Alive, speed: 0, hpFrac: 1, flags: 0, hookOut: false, stateTime: t, time: t };
  }

  function measure(): void {
    if (!pudgy) return;
    const r = pudgy.root;
    const y0 = r.rotation.y;
    r.rotation.y = 0;
    r.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(r);
    r.rotation.y = y0;
    if (!box.isEmpty()) {
      const h = box.max.y - anchor.getWorldPosition(tmp).y;
      if (h > 0.8) modelH = Math.max(1.4, Math.min(3.4, h));
    }
  }

  /** place the engine camera: low, close, the Lunker framed at `frame`, slow drift */
  function placeCamera(b: Built): void {
    const cam = host.camera;
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    const tv = Math.tan(vfov / 2);
    const aspect = Math.max(0.5, cam.aspect);
    // narrow screens: the UI stacks; centre the Lunker
    const fx = aspect >= 1.45 ? frame.x : 0.5;
    const aF = Math.atan((1 - 2 * frame.feet) * tv);
    const aH = Math.atan((1 - 2 * frame.head) * tv);
    const span = aH - aF;
    const H = modelH;
    const eye = EYE + (drift ? Math.sin(t * 0.13) * 0.05 : 0);
    let lo = 0.5;
    let hi = 60;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const s = Math.atan((H - eye) / mid) + Math.atan(eye / mid);
      if (s > span) lo = mid;
      else hi = mid;
    }
    // lo..hi solved the view-axis depth; the Lunker sits yawOff off the axis, so it is further away
    const depth = (lo + hi) / 2;
    const pitch = Math.atan((H - eye) / depth) - aH;
    const yawOff = Math.atan((2 * fx - 1) * tv * aspect);
    let d = depth / Math.cos(yawOff);
    const L = b.theme.lunker;
    const phi = drift ? 0.06 * Math.sin(t * 0.045) + 0.025 * Math.sin(t * 0.11 + 1.3) : 0;
    if (drift) d *= 1 + 0.025 * Math.sin(t * 0.07 + 0.4);
    const ax = L.x;
    const az = L.z;
    const cx = ax + Math.sin(phi) * d;
    const cz = az + Math.cos(phi) * d;
    // forward toward the Lunker axis, then turned left by yawOff so the Lunker lands right of centre
    let fxv = ax - cx;
    let fzv = az - cz;
    const fl = Math.hypot(fxv, fzv) || 1;
    fxv /= fl;
    fzv /= fl;
    const cy = Math.cos(yawOff);
    const sy = Math.sin(yawOff);
    const rx = fxv * cy + fzv * sy;
    const rz = -fxv * sy + fzv * cy;
    const cp = Math.cos(pitch);
    const wy = b.standY + eye;
    cam.position.set(cx, wy, cz);
    camTarget.set(cx + rx * cp, wy + Math.sin(pitch), cz + rz * cp);
    group.localToWorld(cam.position);
    group.localToWorld(camTarget);
    cam.up.set(0, 1, 0);
    cam.lookAt(camTarget);
    if (drift) cam.rotateZ(Math.sin(t * 0.21) * 0.004);
    cam.updateMatrixWorld();
  }

  function flicker(b: Built): void {
    for (let i = 0; i < b.base.length; i++) {
      const s = b.seeds[i];
      const isSun = i === 0 && b.theme.key.kind === 'sun';
      const fl = isSun ? 1 : 1 + 0.06 * Math.sin(t * 7.3 + s * 13.1) + 0.04 * Math.sin(t * 17.9 + s * 5.3);
      const light = i === 0 ? b.key : b.points[i - 1];
      light.intensity = b.base[i] * fl;
    }
  }

  const stage: ShowcaseStage = {
    group,
    mode,
    anchor,
    get theme() {
      return themeId;
    },
    get active() {
      return active;
    },
    setTheme(id: ShowcaseThemeId) {
      if (!THEMES[id] || id === themeId) return;
      themeId = id;
      if (built) {
        teardown(built);
        built = null;
      }
      if (active) {
        ensureBuilt();
        if (pudgy) anchor.add(pudgy.root);
      }
    },
    setLook(l: ShowcaseLook | null) {
      look = l ? { ...l, loadout: { ...l.loadout } } : null;
      if (active) rebuildLunker();
    },
    play(shot: PudgyOneShot) {
      try {
        pudgy?.play(shot);
      } catch {
        // a broken model never takes the menu down
      }
    },
    drag(dx: number) {
      yaw += dx * 0.012;
      yawVel = dx * 0.7;
    },
    setFrame(f: Partial<ShowcaseFrame>) {
      Object.assign(frame, f);
    },
    setActive(on: boolean) {
      if (on === active) return;
      active = on;
      group.visible = on;
      if (on) {
        ensureBuilt();
        rebuildLunker();
      } else if (hostLook) hostLook.restore();
    },
    update(dt: number, time: number) {
      if (disposed || !active) return;
      t = time;
      const b = ensureBuilt();
      buildEnv(b);
      b.waterMat.update(time);
      b.mist.update(time);
      flicker(b);
      if (pudgy) {
        if (Math.abs(yawVel) > 1e-3) {
          yawVel *= Math.exp(-dt * 3);
          yaw += yawVel * 0.02 * dt;
        }
        pudgy.root.rotation.y = yaw;
        try {
          pudgy.update(dt, anim());
        } catch {
          // ignore animation errors
        }
        if (refitIn > 0) {
          refitIn -= dt;
          if (refitIn <= 0) measure();
        }
        nextShot -= dt;
        if (nextShot <= 0) {
          nextShot = 14 + ((time * 7.13) % 1) * 8;
          stage.play(ONE_SHOTS[Math.floor(((time * 3.71) % 1) * ONE_SHOTS.length)]);
        }
      }
      if (mode === 'backdrop') {
        if (hostLook) hostLook.apply(b.hostLook, group.getWorldPosition(tmp));
        placeCamera(b);
      } else {
        // preview mode: the host's own fog for the theme, and the sky dome follows the host camera
        if (!host.scene.fog) {
          ownFog = new THREE.FogExp2(b.theme.fog.color, b.theme.fog.density);
          host.scene.fog = ownFog;
        } else if (host.scene.fog === ownFog && ownFog) {
          ownFog.color.set(b.theme.fog.color);
          ownFog.density = b.theme.fog.density;
        }
        if (b.ownSky) b.ownSky.update(time, host.camera);
      }
    },
    stats() {
      let meshes = 0;
      group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes++;
      });
      return { theme: themeId, lights: built ? 1 + built.points.length : 0, meshes, lunker: pudgy !== null, height: modelH };
    },
    tune(p) {
      const b = built;
      if (!b) return;
      if (p.env !== undefined) b.hostLook.envIntensity = p.env;
      if (p.rim !== undefined) b.hostLook.sunIntensity = p.rim;
      if (p.hemi !== undefined) b.hostLook.hemiIntensity = p.hemi;
      if (p.fog !== undefined) b.hostLook.fogDensity = p.fog;
      if (p.key !== undefined) b.base[0] *= p.key;
      if (p.lamps !== undefined) for (let i = 1; i < b.base.length; i++) b.base[i] *= p.lamps;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (hostLook) hostLook.restore();
      if (ownFog && host.scene.fog === ownFog) host.scene.fog = null;
      disposePudgy();
      if (built) teardown(built);
      built = null;
      ripple.dispose();
      puddles.dispose();
      voxMat.dispose();
      snowMat.dispose();
      lampMat.dispose();
      group.removeFromParent();
    },
  };

  group.visible = active;
  if (active) {
    ensureBuilt();
    rebuildLunker();
  }
  return stage;
}
