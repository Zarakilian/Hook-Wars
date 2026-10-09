// Shared infrastructure for props: clock, quality tier, material factory (sway, glow, rim, wobble),
// noise and shape helpers, the PropModel type and instancing helpers.
// Every material here is created by this module. voxel.ts's cached materials are never touched.
import * as THREE from 'three';
import { cinematicEnabled, onCinematicChange } from '../../cinematic.ts';
import type { Quality } from '../../contracts.ts';
import { applyVoxelLook } from '../../look/voxelLook.ts';
import { hashVox, mix, shade } from '../../voxel/voxel.ts';
import { meshPGrid, PGrid } from './mesher.ts';

export { PGrid };

// ---------------------------------------------------------------------------------------------
// Clock. Fountain / rune / hazard updates push the game time; otherwise it free-runs on wall time.
// ---------------------------------------------------------------------------------------------

/** Shared time uniform for every animated prop shader. */
export const PROP_TIME = { value: 0 };
/** Current water surface height (world y) used by floating and underwater decor. */
export const WATER_LEVEL = { value: 0 };
let lastWall = 0;
let lastExplicit = -1e9;

/** Push the game clock (seconds). Called from every update(dt, time) this module receives. */
export function setPropTime(t: number): void {
  PROP_TIME.value = t;
  lastExplicit = performance.now();
  lastWall = lastExplicit;
}

/** Free-running fallback: advances the clock when nobody has pushed a time recently. */
export function autoClock(): void {
  const now = performance.now();
  if (lastWall === 0) lastWall = now;
  const dt = Math.min(0.1, (now - lastWall) / 1000);
  lastWall = now;
  if (now - lastExplicit > 400) PROP_TIME.value += dt;
}

/** Attach to a mesh so the clock keeps running even if no update() is ever called. */
export function clockDriver(o: THREE.Object3D): void {
  o.onBeforeRender = autoClock;
}

// ---------------------------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------------------------

let QUALITY: Quality = 'medium';
/** Default quality for props built without an explicit quality argument. */
export function setPropsQuality(q: Quality): void {
  QUALITY = q;
}
export function propsQuality(q?: Quality): Quality {
  return q ?? QUALITY;
}
export function qLevel(q: Quality): number {
  return q === 'low' ? 0 : q === 'medium' ? 1 : q === 'high' ? 2 : 3;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

export interface MatOpts {
  rough?: number;
  metal?: number;
  /** emissive from vertex colour, strength (AgX needs about 2..4 to read as lit) */
  glow?: number;
  /** flicker amount for glow 0..1 */
  flicker?: number;
  /** slow pulse amount for glow 0..1 */
  pulse?: number;
  /** fresnel rim strength and colour */
  rim?: number;
  rimColor?: number;
  /** wind sway amplitude in metres at swayH */
  sway?: number;
  swayH?: number;
  /** rubbery wobble amplitude (bouncy posts) */
  wobble?: number;
  /** float on the water surface (WATER_LEVEL), instance y = ground under it */
  float?: boolean;
  /** underwater plant: height scales with water depth above the instance base */
  kelp?: boolean;
  /** moored boat: rests on the ground, floats and rocks once the water rises above its keel */
  boat?: boolean;
  /** cloth wave amplitude in metres (flags along +x from the pole, banners hanging down from clothTop) */
  cloth?: number;
  /** metres of cloth over which the wave builds up */
  clothLen?: number;
  /** 'x': a flag flying along +x; 'down': a banner hanging below clothTop (model y, metres) */
  clothAxis?: 'x' | 'down';
  clothTop?: number;
  transparent?: boolean;
  opacity?: number;
  doubleSide?: boolean;
  depthWrite?: boolean;
  /** flat emissive colour added on top (team glow etc.) */
  emissive?: number;
  emissiveIntensity?: number;
  /** unique tag to force a separate (animatable) instance */
  tag?: string;
}

export interface PropUniforms {
  uGlow: { value: number };
  uFlicker: { value: number };
  uPulse: { value: number };
  uRim: { value: number };
  uRimColor: { value: THREE.Color };
  uSway: { value: number };
  uSwayH: { value: number };
  uWobble: { value: number };
  uCloth: { value: number };
  uClothLen: { value: number };
  uClothTop: { value: number };
  uClothAxis: { value: number };
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();

/** Cached prop material. Pass `tag` for a private instance whose uniforms you animate. */
export function pmat(o: MatOpts = {}): THREE.MeshStandardMaterial {
  const key = JSON.stringify(o);
  let m = matCache.get(key);
  if (m) return m;
  m = makeMat(o);
  if (!o.tag) matCache.set(key, m);
  return m;
}

/**
 * Night/dusk variant of a prop material: adds a soft moonlit (or warm) fresnel rim so silhouettes
 * stay readable in dark maps. Materials that already have a rim, or are not ours, are returned as is.
 */
export function moodVariant(m: THREE.Material, mood: 'night' | 'dusk' | null): THREE.Material {
  if (!mood) return m;
  const o = m.userData.opts as MatOpts | undefined;
  if (!o || o.rim || o.tag) return m;
  const v = pmat({ ...o, rim: mood === 'night' ? 0.42 : 0.22, rimColor: mood === 'night' ? 0x7f9fe8 : 0xffb070 });
  // the night / dusk variant sits on the same voxel geometry as its source
  if (m.userData.hwVox) adoptVoxelLook(v);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Epic (cinematic) voxel look: per-voxel bevels, seams and glints (client/render/look/voxelLook.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Every prop bucket mixes models with different voxel sizes: each geometry carries its own (hwVoxelSize).
 * Bevels tilt half as far as the default and glint less: with the full tilt every cube edge of a night prop
 * caught the cool sky as a pale-blue grid line, where the references show warm wood with dark gaps between
 * the boards (slightly deeper seams, narrower bevel). Uniform-only options: no extra program variant.
 */
const VOX_LOOK = { voxelSize: 'attribute', fallbackSize: 0.05, seam: 0.4, bevel: 0.14, tilt: 0.3, glint: 0.35 } as const;
/**
 * Register a prop material for the Epic voxel look. While cinematic is off this only records the material
 * (same program, same pixels). Transparent and vertex-animated materials are left out: the look floors the
 * displaced vertex positions, so seams would crawl on swaying leaves, flags, floating and bobbing parts.
 */
export function adoptVoxelLook(m: THREE.Material): void {
  if (m.userData.hwVox) return;
  const o = m.userData.opts as MatOpts | undefined;
  if (!o || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial || m.transparent) return;
  if (o.sway || o.wobble || o.float || o.kelp || o.boat || o.cloth) return;
  m.userData.hwVox = true;
  applyVoxelLook(m, VOX_LOOK);
}

/** Give a voxel geometry its per-vertex voxel size (Epic only; userData.hwV is set by toModel). */
export function ensureVoxelSize(geo: THREE.BufferGeometry, fallback = 0.05): void {
  if (geo.getAttribute('hwVoxelSize')) return;
  const n = geo.getAttribute('position').count;
  geo.setAttribute('hwVoxelSize', new THREE.Float32BufferAttribute(new Float32Array(n).fill((geo.userData.hwV as number | undefined) ?? fallback), 1));
}

/**
 * A voxel size so small (0.1 mm) that every pixel spans hundreds of voxels: the look's seams, bevels and
 * glints all fade to exactly nothing, so geometry carrying it renders as it does without the look.
 */
const NEUTRAL_VOXEL = 1e-4;

/** Give geometry built while cinematic was off a neutral hwVoxelSize (see trackOffGeometry). */
export function neutralVoxelSize(geo: THREE.BufferGeometry): void {
  if (geo.getAttribute('hwVoxelSize')) return;
  const n = geo.getAttribute('position').count;
  geo.setAttribute('hwVoxelSize', new THREE.Float32BufferAttribute(new Float32Array(n).fill(NEUTRAL_VOXEL), 1));
}

// Epic switched on mid-match (the Steam settings screen opens from the in-match menu): the props on screen
// were built with it off, so their geometry has no hwVoxelSize. The attribute-mode look would then read the
// context's generic attribute value at that location, which another program's default (1.0 for a missing
// colour) can leave behind: 1 m seams across the props. The attribute cannot be added at draw time (in an
// onBeforeRender hook it is not uploaded yet, and three.js caches the vertex array without it for good), so
// every geometry built while cinematic is off and drawn with a registered material is tracked here and gets
// the neutral size at the switch, before the next frame uploads it. Props built before the switch keep their
// normal look until the next match (the foundation's rule for runtime toggles). With cinematic off nothing is
// added, and the attribute stays unused by the normal programs after a later switch back.
const offGeos = new Set<WeakRef<THREE.BufferGeometry>>();
let offSweep = 4096;

/** Track geometry built while cinematic is off that draws with a registered prop material. */
export function trackOffGeometry(geo: THREE.BufferGeometry): void {
  offGeos.add(new WeakRef(geo));
  if (offGeos.size > offSweep) {
    for (const r of offGeos) if (!r.deref()) offGeos.delete(r);
    offSweep = Math.max(4096, offGeos.size * 2);
  }
}

onCinematicChange((on) => {
  if (!on) return;
  for (const r of offGeos) {
    const g = r.deref();
    if (!g) offGeos.delete(r);
    else neutralVoxelSize(g);
  }
});

export function moodOf(atmo: { timeOfDay: string }): 'night' | 'dusk' | null {
  return atmo.timeOfDay === 'night' ? 'night' : atmo.timeOfDay === 'dusk' ? 'dusk' : null;
}

/** Uncached material (caller disposes). */
export function pmatOwned(o: MatOpts): THREE.MeshStandardMaterial {
  return makeMat(o);
}

export function uniformsOf(m: THREE.Material): PropUniforms {
  return m.userData.pu as PropUniforms;
}

function makeMat(o: MatOpts): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: o.rough ?? 0.85,
    metalness: o.metal ?? 0,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    side: o.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    depthWrite: o.depthWrite ?? !(o.transparent ?? false),
    emissive: new THREE.Color(o.emissive ?? 0),
    emissiveIntensity: o.emissiveIntensity ?? 1,
  });
  const flags: string[] = [];
  if (o.glow) flags.push('GLOW');
  if (o.rim) flags.push('RIM');
  if (o.sway) flags.push('SWAY');
  if (o.wobble) flags.push('WOBBLE');
  if (o.float) flags.push('FLOAT');
  if (o.kelp) flags.push('KELP');
  if (o.boat) flags.push('BOAT');
  if (o.cloth) flags.push('CLOTH');
  const pu: PropUniforms = {
    uGlow: { value: o.glow ?? 0 },
    uFlicker: { value: o.flicker ?? 0 },
    uPulse: { value: o.pulse ?? 0 },
    uRim: { value: o.rim ?? 0 },
    uRimColor: { value: new THREE.Color(o.rimColor ?? 0xffffff) },
    uSway: { value: o.sway ?? 0 },
    uSwayH: { value: o.swayH ?? 1 },
    uWobble: { value: o.wobble ?? 0 },
    uCloth: { value: o.cloth ?? 0 },
    uClothLen: { value: o.clothLen ?? 1 },
    uClothTop: { value: o.clothTop ?? 0 },
    uClothAxis: { value: o.clothAxis === 'down' ? 1 : 0 },
  };
  m.userData.pu = pu;
  m.userData.opts = o;
  if (flags.length === 0) return m;
  const defs: Record<string, string> = {};
  for (const f of flags) defs['P_' + f] = '';
  m.defines = { ...(m.defines ?? {}), ...defs };
  const cacheKey = 'hwprop:' + flags.join(',');
  m.customProgramCacheKey = () => cacheKey;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = PROP_TIME;
    shader.uniforms.uWaterY = WATER_LEVEL;
    Object.assign(shader.uniforms, pu);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_MAIN}`);
  };
  return m;
}

const VERT_PARS = /* glsl */ `
uniform float uTime;
uniform float uWaterY;
uniform float uSway;
uniform float uSwayH;
uniform float uWobble;
uniform float uCloth;
uniform float uClothLen;
uniform float uClothTop;
uniform float uClothAxis;
`;

const VERT_MAIN = /* glsl */ `
#if defined(P_SWAY) || defined(P_WOBBLE) || defined(P_FLOAT) || defined(P_KELP) || defined(P_BOAT) || defined(P_CLOTH)
{
  vec3 pIp = vec3(0.0);
  float pSy = 1.0;
  #ifdef USE_INSTANCING
  pIp = instanceMatrix[3].xyz;
  pSy = max(0.001, length(instanceMatrix[1].xyz));
  #endif
  #ifdef USE_BATCHING
  pIp = batchingMatrix[3].xyz;
  pSy = max(0.001, length(batchingMatrix[1].xyz));
  #endif
  vec3 pWp = (modelMatrix * vec4(pIp, 1.0)).xyz;
  #ifdef P_KELP
  float kDepth = uWaterY - pWp.y;
  transformed.y *= clamp(kDepth / 1.3, 0.18, 1.0);
  #endif
  #ifdef P_SWAY
  float pH = clamp(transformed.y / uSwayH, 0.0, 1.6);
  float pK = pH * pH;
  float pPh = uTime * 1.7 + pWp.x * 0.37 + pWp.z * 0.29;
  float pGust = 0.65 + 0.35 * sin(uTime * 0.41 + pWp.x * 0.06 + pWp.z * 0.04);
  transformed.x += (sin(pPh) + 0.35 * sin(pPh * 2.7 + 1.1)) * uSway * pK * pGust;
  transformed.z += cos(pPh * 0.83 + 0.4) * uSway * 0.6 * pK * pGust;
  #endif
  #ifdef P_WOBBLE
  float wH = max(transformed.y, 0.0);
  float wPh = uTime * 6.3 + pWp.x * 1.3 + pWp.z * 0.7;
  float wA = uWobble * (0.6 + 0.4 * sin(uTime * 0.9 + pWp.z));
  transformed.x += sin(wPh) * wA * wH * wH;
  transformed.z += cos(wPh * 1.13) * wA * wH * wH;
  transformed.y *= 1.0 + sin(wPh * 2.0) * wA * 0.4;
  #endif
  #ifdef P_FLOAT
  float fWet = smoothstep(pWp.y + 0.04, pWp.y + 0.22, uWaterY);
  transformed *= fWet;
  float fBob = sin(uTime * 1.3 + pWp.x * 0.9 + pWp.z * 0.6) * 0.018;
  float fY = max(pWp.y + 0.03, uWaterY + 0.01) + fBob;
  transformed.y += (fY - pWp.y) / pSy;
  transformed.x += sin(uTime * 0.31 + pWp.z) * 0.04 / pSy;
  #endif
  #ifdef P_BOAT
  float bWet = smoothstep(pWp.y + 0.02, pWp.y + 0.2, uWaterY);
  float bLift = max(0.0, uWaterY - 0.1 - pWp.y);
  float bPh = uTime * 1.15 + pWp.x * 0.7 + pWp.z * 0.4;
  transformed.y += bLift / pSy + (transformed.x * sin(bPh) * 0.05 + transformed.z * sin(bPh * 0.7 + 1.3) * 0.02 + sin(bPh * 1.3) * 0.02) * bWet;
  #endif
  #ifdef P_CLOTH
  float cAlong = uClothAxis > 0.5 ? max(0.0, uClothTop - transformed.y) : max(0.0, transformed.x);
  float cK = clamp(cAlong / uClothLen, 0.0, 1.0);
  float cPh = uTime * 3.4 + pWp.x * 0.7 + pWp.z * 0.5 - cAlong * 4.5;
  float cGust = 0.7 + 0.3 * sin(uTime * 0.53 + pWp.x * 0.1);
  transformed.z += (sin(cPh) * 0.8 + sin(cPh * 2.3 + 1.0) * 0.2) * uCloth * cK * cGust;
  transformed.x += uClothAxis > 0.5 ? sin(cPh * 0.7 + 0.5) * uCloth * 0.35 * cK * cGust : 0.0;
  #endif
}
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uGlow;
uniform float uFlicker;
uniform float uPulse;
uniform float uRim;
uniform vec3 uRimColor;
`;

const FRAG_MAIN = /* glsl */ `
#ifdef P_GLOW
{
  float fl = 1.0 - uFlicker * (0.5 + 0.25 * sin(uTime * 17.0) + 0.25 * sin(uTime * 7.3 + 1.7)) * 0.6;
  float pl = 1.0 - uPulse * (0.5 + 0.5 * sin(uTime * 2.4));
  totalEmissiveRadiance += vColor.rgb * uGlow * fl * pl;
}
#endif
#ifdef P_RIM
{
  float rimF = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 2.5);
  totalEmissiveRadiance += uRimColor * rimF * uRim;
}
#endif
`;

// ---------------------------------------------------------------------------------------------
// Halo sprite (additive radial glow) used for lamps, runes, fountains, fireflies
// ---------------------------------------------------------------------------------------------

let haloTex: THREE.Texture | null = null;
export function haloTexture(): THREE.Texture {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  gr.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  haloTex = new THREE.CanvasTexture(c);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  return haloTex;
}

const haloMats = new Map<string, THREE.SpriteMaterial>();
/** Shared additive halo sprite material for a colour. */
export function haloMaterial(color: number, opacity = 0.8): THREE.SpriteMaterial {
  const key = color + ':' + opacity;
  let m = haloMats.get(key);
  if (!m) {
    m = new THREE.SpriteMaterial({ map: haloTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
    haloMats.set(key, m);
  }
  return m;
}

export function halo(color: number, size: number, opacity = 0.8): THREE.Sprite {
  const s = new THREE.Sprite(haloMaterial(color, opacity));
  s.scale.set(size, size, size);
  s.renderOrder = 3;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

export interface PropPart {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  shadow: boolean;
  /** voxel channel the part came from (CH.*) */
  ch: number;
}
export interface PropHalo {
  /** local position in metres (model space) */
  pos: [number, number, number];
  color: number;
  size: number;
  opacity: number;
}
/** A real lantern in a model: where its flame is, for the Epic lantern lights (engine.setLanternSources). */
export interface PropLamp {
  /** local position in metres (model space): the centre of the glass */
  pos: [number, number, number];
  /** sRGB hex */
  color: number;
  /** peak intensity (candela) */
  intensity: number;
  /** cut-off distance (m) */
  range: number;
}
export interface PropModel {
  parts: PropPart[];
  /** additive glow sprites placed with each instance */
  halos?: PropHalo[];
  /** lamp flames placed with each instance (Epic lantern lights; nothing renders them directly) */
  lamps?: PropLamp[];
}

/** Light per lamp kind: sRGB colour, candela, range (the same scale as look/lanterns.ts). */
export const LAMP_KIND = {
  lamppost: [0xffb468, 13, 7],
  gaslamp: [0xffac5a, 10.5, 6.5],
  lanternpost: [0xffa64e, 9.5, 6],
  stilthut: [0xffa04a, 9, 6],
  watchtower: [0xffbe6a, 12, 7],
  crane: [0xffb060, 10.5, 6.5],
  bridgepier: [0xffb468, 7.5, 5.5],
  lantern: [0xffae5c, 7.5, 5.5],
  string: [0xffb862, 9, 6.5],
  small: [0xffb060, 6, 4.5],
  /** the green glass of the older swamp maps' decor lanterns */
  marshlight: [0xc8f080, 6, 5],
} as const satisfies Record<string, readonly [number, number, number]>;

/** A lamp at voxel centre `c` of a grid meshed with `pivot` and voxel size V. */
export function lampAt(c: [number, number, number], pivot: [number, number, number], V: number, kind: keyof typeof LAMP_KIND): PropLamp {
  const [color, intensity, range] = LAMP_KIND[kind];
  return { pos: [(c[0] - pivot[0]) * V, (c[1] - pivot[1]) * V, (c[2] - pivot[2]) * V], color, intensity, range };
}

/** Channel ids used by every builder. */
export const CH = {
  base: 0,
  glow: 1,
  metal: 2,
  ice: 3,
  leaf: 4,
  wet: 5,
  glow2: 6,
  extra: 7,
} as const;

/** Epic set dressing pass over a builder's grid before it is meshed (may add materials for new channels). */
export type GridHook = (g: PGrid, size: number, mats: Partial<Record<number, THREE.Material>>) => void;
let gridHook: GridHook | null = null;

/** Run a builder with a dressing pass on every grid it meshes (Epic only: nothing sets a hook otherwise). */
export function withGridHook<T>(hook: GridHook | null, fn: () => T): T {
  const prev = gridHook;
  gridHook = hook;
  try {
    return fn();
  } finally {
    gridHook = prev;
  }
}

/**
 * Epic: keep the voxel lattice robust for the voxel look. It floors (position / size + 0.25) per vertex, which
 * is exact when the pivot sits on a whole or half voxel; a pivot at about a quarter voxel would put the vertex
 * lattice next to a floor step, so it moves to the whole voxel (under 2 cm).
 */
function latticePivot(p: [number, number, number]): [number, number, number] {
  return p.map((v) => {
    const f = v - Math.floor(v);
    return f > 0.1 && f < 0.4 ? Math.floor(v) : v;
  }) as [number, number, number];
}

/** Mesh a PGrid and pair each channel with a material. Channels without a material use `base`. */
export function toModel(
  g: PGrid,
  size: number,
  mats: Partial<Record<number, THREE.Material>>,
  o: { pivot?: [number, number, number]; shadow?: boolean; noShadowCh?: number[]; ao?: number } = {},
): PropModel {
  const epic = cinematicEnabled();
  if (gridHook) {
    mats = { ...mats };
    gridHook(g, size, mats);
  }
  const geos = meshPGrid(g, { size, pivot: epic && o.pivot ? latticePivot(o.pivot) : o.pivot, aoStrength: o.ao });
  const parts: PropPart[] = [];
  const baseMat = mats[0] ?? pmat();
  for (let c = 0; c < geos.length; c++) {
    const geo = geos[c];
    if (!geo) continue;
    // the voxel size travels with the geometry: Epic buckets mix 0.04 .. 0.12 m models
    geo.userData.hwV = size;
    if (epic) ensureVoxelSize(geo);
    else trackOffGeometry(geo);
    const mat = mats[c] ?? baseMat;
    adoptVoxelLook(mat);
    parts.push({ geo, mat, ch: c, shadow: (o.shadow ?? true) && !(o.noShadowCh ?? [CH.glow, CH.glow2]).includes(c) });
  }
  return { parts };
}

/** Merge models (parts sharing a material are kept separate; fine for small counts). */
export function modelGroup(m: PropModel, castShadow: boolean, mood: 'night' | 'dusk' | null = null): THREE.Group {
  const g = new THREE.Group();
  for (const p of m.parts) {
    const mesh = new THREE.Mesh(p.geo, moodVariant(p.mat, mood));
    mesh.castShadow = castShadow && p.shadow;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

/** Instanced meshes for one model at many transforms. */
export function instanceModel(m: PropModel, mats: THREE.Matrix4[], castShadow: boolean, colors?: THREE.Color[], mood: 'night' | 'dusk' | null = null): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  for (const p of m.parts) {
    const im = new THREE.InstancedMesh(p.geo, moodVariant(p.mat, mood), mats.length);
    for (let i = 0; i < mats.length; i++) {
      im.setMatrixAt(i, mats[i]);
      if (colors) im.setColorAt(i, colors[i]);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = castShadow && p.shadow;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    im.computeBoundingBox();
    out.push(im);
  }
  return out;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
export function trs(x: number, y: number, z: number, yaw: number, sx: number, sy = sx, sz = sx, pitch = 0, roll = 0): THREE.Matrix4 {
  _e.set(pitch, yaw, roll, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

// ---------------------------------------------------------------------------------------------
// Noise and colour helpers
// ---------------------------------------------------------------------------------------------

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 3D value noise in [0,1]. */
export function vn3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);
  const h = (a: number, b: number, c: number) => hashVox(a, b, c, seed);
  const x00 = h(xi, yi, zi) * (1 - u) + h(xi + 1, yi, zi) * u;
  const x10 = h(xi, yi + 1, zi) * (1 - u) + h(xi + 1, yi + 1, zi) * u;
  const x01 = h(xi, yi, zi + 1) * (1 - u) + h(xi + 1, yi, zi + 1) * u;
  const x11 = h(xi, yi + 1, zi + 1) * (1 - u) + h(xi + 1, yi + 1, zi + 1) * u;
  return (x00 * (1 - v) + x10 * v) * (1 - w) + (x01 * (1 - v) + x11 * v) * w;
}

/** Two-octave noise in [0,1]. */
export function fbm3(x: number, y: number, z: number, seed = 0): number {
  return vn3(x, y, z, seed) * 0.66 + vn3(x * 2.13, y * 2.13, z * 2.13, seed + 7) * 0.34;
}

export function h3(x: number, y: number, z: number, seed = 0): number {
  return hashVox(x, y, z, seed);
}

/** Pick from a palette by blotchy noise plus a little per-voxel speckle. Keeps greedy merging useful. */
export function blotch(palette: readonly number[], scale: number, seed = 0, speck = 0.15): (x: number, y: number, z: number) => number {
  return (x, y, z) => {
    let t = fbm3(x * scale, y * scale, z * scale, seed);
    if (speck > 0) t += (hashVox(x, y, z, seed + 3) - 0.5) * speck;
    t = Math.max(0, Math.min(0.9999, (t - 0.2) / 0.6));
    return palette[Math.floor(t * palette.length)];
  };
}

/** Palette pick by a parameter t in [0,1). */
export function palAt(palette: readonly number[], t: number): number {
  return palette[Math.max(0, Math.min(palette.length - 1, Math.floor(t * palette.length)))];
}

export { hashVox, mix, shade };

// ---------------------------------------------------------------------------------------------
// Shape helpers (voxel coordinates)
// ---------------------------------------------------------------------------------------------

export type CFn = (x: number, y: number, z: number) => number;
export type Col = number | CFn;
export function cc(c: Col, x: number, y: number, z: number): number {
  return typeof c === 'function' ? c(x, y, z) : c;
}

/** Tapered vertical cylinder, radius r0 at y0 to r1 at y1, optional per-height x/z offset (bend). */
export function taper(g: PGrid, cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, col: Col, bend?: (y: number) => [number, number]): void {
  for (let y = y0; y <= y1; y++) {
    const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
    const r = r0 + (r1 - r0) * t;
    const [ox, oz] = bend ? bend(y) : [0, 0];
    const x0 = cx + ox;
    const z0 = cz + oz;
    for (let z = Math.floor(z0 - r - 1); z <= Math.ceil(z0 + r + 1); z++)
      for (let x = Math.floor(x0 - r - 1); x <= Math.ceil(x0 + r + 1); x++) {
        const dx = x + 0.5 - x0;
        const dz = z + 0.5 - z0;
        if (dx * dx + dz * dz <= r * r) g.set(x, y, z, cc(col, x, y, z));
      }
  }
}

/** Noisy blob (sphere with fbm-displaced surface). */
export function blob(g: PGrid, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, amp: number, seed: number, col: Col, freq = 0.25): void {
  const m = 1 + amp;
  for (let z = Math.floor(cz - rz * m); z <= Math.ceil(cz + rz * m); z++)
    for (let y = Math.floor(cy - ry * m); y <= Math.ceil(cy + ry * m); y++)
      for (let x = Math.floor(cx - rx * m); x <= Math.ceil(cx + rx * m); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const dz = (z + 0.5 - cz) / rz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const n = (fbm3(x * freq, y * freq, z * freq, seed) - 0.5) * 2 * amp;
        if (d <= 1 + n) g.set(x, y, z, cc(col, x, y, z));
      }
}

/** Recolour the top-facing surface voxels (those with air above) within a predicate. */
export function capTop(g: PGrid, depth: number, pred: (x: number, y: number, z: number) => boolean, col: Col): void {
  for (let z = 0; z < g.nz; z++)
    for (let x = 0; x < g.nx; x++) {
      let d = 0;
      for (let y = g.ny - 1; y >= 0; y--) {
        if (!g.solid(x, y, z)) {
          d = 0;
          continue;
        }
        if (d < depth && pred(x, y, z)) g.set(x, y, z, cc(col, x, y, z));
        d++;
      }
    }
}

/** Thin straight line of voxels (radius 0 = single voxel path), cheap. */
export function seg(g: PGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Col, r = 0): void {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)) * 1.5) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const z = z0 + (z1 - z0) * t;
    if (r <= 0) {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const zi = Math.floor(z);
      g.set(xi, yi, zi, cc(col, xi, yi, zi));
    } else {
      const rr = r * r;
      for (let zz = Math.floor(z - r); zz <= Math.ceil(z + r); zz++)
        for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++)
          for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
            const dx = xx + 0.5 - x;
            const dy = yy + 0.5 - y;
            const dz = zz + 0.5 - z;
            if (dx * dx + dy * dy + dz * dz <= rr) g.set(xx, yy, zz, cc(col, xx, yy, zz));
          }
    }
  }
}

/** Quadratic bezier tube. */
export function curve(g: PGrid, a: [number, number, number], b: [number, number, number], c: [number, number, number], r0: number, r1: number, col: Col): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) + Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
  const steps = Math.ceil(len * 1.5) + 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const it = 1 - t;
    const x = it * it * a[0] + 2 * it * t * b[0] + t * t * c[0];
    const y = it * it * a[1] + 2 * it * t * b[1] + t * t * c[1];
    const z = it * it * a[2] + 2 * it * t * b[2] + t * t * c[2];
    const r = r0 + (r1 - r0) * t;
    if (r < 0.6) {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const zi = Math.floor(z);
      g.set(xi, yi, zi, cc(col, xi, yi, zi));
    } else {
      const rr = r * r;
      for (let zz = Math.floor(z - r); zz <= Math.ceil(z + r); zz++)
        for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++)
          for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
            const dx = xx + 0.5 - x;
            const dy = yy + 0.5 - y;
            const dz = zz + 0.5 - z;
            if (dx * dx + dy * dy + dz * dz <= rr) g.set(xx, yy, zz, cc(col, xx, yy, zz));
          }
    }
  }
}

/** Geometry cache shared across matches (bounded by map content). Epic models (dressing, voxel sizes) are kept apart. */
const modelCache = new Map<string, PropModel>();
export function cachedModel(key: string, build: () => PropModel): PropModel {
  if (cinematicEnabled()) key += '|E';
  let m = modelCache.get(key);
  if (!m) {
    m = build();
    modelCache.set(key, m);
  }
  return m;
}

export function rngFor(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
