// Voxel look: per-voxel bevels, seams and glints for greedy-meshed voxel models, as a shader chunk
// patched into MeshStandardMaterial / MeshPhysicalMaterial through onBeforeCompile.
//
// A greedy mesher merges many voxel faces into one big quad, so a flat wall of cubes renders as one
// flat colour. The references show every small cube with a bevelled edge that catches the light. This
// chunk rebuilds the cube grid per fragment: every vertex of a greedy quad lies on the voxel lattice, so
// floor(position / voxelSize + shift) is the integer lattice coordinate at each vertex and its
// interpolation is the exact lattice coordinate at each fragment, whatever pivot the model has. The face
// normal (from screen derivatives of that coordinate) picks the two in-plane axes; near each cube edge
// the chunk darkens a thin seam, lifts a bevel, and tilts the normal outward, and each cube gets a little
// normal and roughness jitter so lit surfaces sparkle cube by cube.
//
// Cinematic only. applyVoxelLook() only registers the material while cinematic mode is off: the
// material is not touched at all (same program, same pixels, same cost). When cinematic mode turns on
// (and its voxelLook switch is on) every registered material is patched and recompiled; when it turns
// off they are restored. Existing onBeforeCompile hooks are chained (they run first) and the program
// cache key is extended, so materials that already patch their shaders (props, terrain, pudgy) adopt it
// safely.
//
// Adoption (wave 2): call applyVoxelLook(material, { voxelSize }) once on each voxel material you own.
//   - voxelSize: metres per voxel in the geometry's own space (meshVoxels' `size`), or 'attribute' to
//     read a per-vertex float attribute `hwVoxelSize` (for BatchedMesh buckets that mix voxel sizes).
//   - space: 'local' (default; geometry space, so it follows rotation, batching and instancing) or
//     'world' (static, world-aligned meshes such as terrain chunks).
//   - Bevels show where a voxel covers more than ~3 pixels and fade out below that (they would alias);
//     the per-cube glint stays down to ~1.2 pixels per voxel.
import * as THREE from 'three';
import { cinematicConfig, cinematicEnabled, onCinematicChange } from '../cinematic.ts';

export interface VoxelLookOptions {
  /** metres per voxel in the chosen space, or 'attribute' (per-vertex float `hwVoxelSize`). Default 0.1 */
  voxelSize?: number | 'attribute';
  /** voxel size used where the `hwVoxelSize` attribute is missing or 0 (attribute mode). Default 0.1 */
  fallbackSize?: number;
  /** 'local' (geometry space, default) or 'world' (world-aligned static meshes) */
  space?: 'local' | 'world';
  /** lattice phase shift in voxels; only change it if the model's lattice sits at ~0.75 voxel (default 0.25) */
  shift?: number;
  /** 0..1 darkening of the seam between neighbouring cubes (default 0.32) */
  seam?: number;
  /** bevel width as a fraction of a voxel (default 0.16) */
  bevel?: number;
  /** how far the bevel tilts the normal outward (default 0.6) */
  tilt?: number;
  /** 0..1 per-cube sparkle: normal and roughness jitter per cube, glossier bevels (default 0.5) */
  glint?: number;
  /** per-cube brightness variation, 0..0.2 (default 0.05) */
  tile?: number;
  /** fresnel rim light strength (0 = none, default 0); the colour comes from LOOK_UNIFORMS (set per map) */
  rim?: number;
}

type Resolved = Required<Omit<VoxelLookOptions, 'voxelSize'>> & { voxelSize: number | 'attribute' };

const DEFAULTS: Resolved = {
  voxelSize: 0.1,
  fallbackSize: 0.1,
  space: 'local',
  shift: 0.25,
  seam: 0.32,
  bevel: 0.16,
  tilt: 0.6,
  glint: 0.5,
  tile: 0.05,
  rim: 0,
};

/**
 * Uniforms shared by every patched material. The engine sets them per map while cinematic is on:
 * hwLookRim = rim light colour (linear, already scaled), hwLookOn = global 0..1 strength.
 */
export const LOOK_UNIFORMS = {
  hwLookRim: { value: new THREE.Color(0.35, 0.42, 0.6) },
  hwLookOn: { value: 1 },
};

type PatchableMaterial = THREE.MeshStandardMaterial;

interface Entry {
  opts: Resolved;
  /** per-material uniforms: hwVoxA = (size, seam, bevel, tilt), hwVoxB = (glint, tile, rim, shift) */
  uA: { value: THREE.Vector4 };
  uB: { value: THREE.Vector4 };
  patched: boolean;
  prevCompile: PatchableMaterial['onBeforeCompile'] | null;
  /** own customProgramCacheKey the material had before patching (null = the prototype default) */
  prevKey: (() => string) | null;
  hadDefines: boolean;
}

const entries = new WeakMap<THREE.Material, Entry>();
const live = new Set<WeakRef<THREE.Material>>();
let warned = false;

function resolve(o: VoxelLookOptions | undefined, base: Resolved = DEFAULTS): Resolved {
  return { ...base, ...(o ?? {}) } as Resolved;
}

function fillUniforms(e: Entry): void {
  const o = e.opts;
  const size = o.voxelSize === 'attribute' ? o.fallbackSize : o.voxelSize;
  e.uA.value.set(Math.max(1e-4, size), o.seam, Math.max(0.01, o.bevel), o.tilt);
  e.uB.value.set(o.glint, o.tile, o.rim, o.shift);
}

function wantPatched(): boolean {
  return cinematicEnabled() && cinematicConfig().voxelLook;
}

function isPatchable(m: THREE.Material): m is PatchableMaterial {
  return (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
}

/**
 * Give a MeshStandardMaterial / MeshPhysicalMaterial the cinematic voxel look. Safe to call at material
 * creation time in every mode: while cinematic is off the material is only registered, never changed.
 * Calling it again updates the options (uniform-only options apply live, without a recompile).
 */
export function applyVoxelLook<M extends THREE.Material>(material: M, opts?: VoxelLookOptions): M {
  if (!isPatchable(material)) {
    if (!warned) {
      warned = true;
      console.warn('[voxelLook] only MeshStandardMaterial / MeshPhysicalMaterial can adopt the voxel look:', material.type);
    }
    return material;
  }
  let e = entries.get(material);
  if (e) {
    const before = programKey(e.opts);
    e.opts = resolve(opts, e.opts);
    fillUniforms(e);
    if (e.patched && programKey(e.opts) !== before) material.needsUpdate = true;
  } else {
    e = {
      opts: resolve(opts),
      uA: { value: new THREE.Vector4() },
      uB: { value: new THREE.Vector4() },
      patched: false,
      prevCompile: null,
      prevKey: null,
      hadDefines: false,
    };
    fillUniforms(e);
    entries.set(material, e);
    live.add(new WeakRef(material));
  }
  if (wantPatched() && !e.patched) patch(material, e);
  return material;
}

/** Stop managing a material (restores it if it was patched). */
export function removeVoxelLook(material: THREE.Material): void {
  const e = entries.get(material);
  if (!e) return;
  if (e.patched && isPatchable(material)) unpatch(material, e);
  entries.delete(material);
  for (const r of live) if (r.deref() === material) live.delete(r);
}

/** Number of live registered materials and how many are patched (debug / tests). */
export function voxelLookStats(): { registered: number; patched: number } {
  let registered = 0;
  let patched = 0;
  for (const r of live) {
    const m = r.deref();
    if (!m) {
      live.delete(r);
      continue;
    }
    registered++;
    if (entries.get(m)?.patched) patched++;
  }
  return { registered, patched };
}

function programKey(o: Resolved): string {
  return `hwvox1|${o.space}|${o.voxelSize === 'attribute' ? 'a' : 'u'}|${o.rim > 0 ? 'r' : ''}`;
}

function patch(m: PatchableMaterial, e: Entry): void {
  e.prevCompile = m.onBeforeCompile;
  e.prevKey = Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey') ? m.customProgramCacheKey : null;
  const prevCompile = e.prevCompile;
  const prevKey = e.prevKey;
  // three's default cache key is onBeforeCompile.toString(): keep the previous hook's identity in ours
  const baseKey = prevKey ? null : prevCompile.toString();
  m.onBeforeCompile = function (this: PatchableMaterial, shader, renderer) {
    prevCompile.call(this, shader, renderer);
    injectVoxelLook(shader, e);
  };
  m.customProgramCacheKey = () => (prevKey ? prevKey.call(m) : (baseKey as string)) + '|' + programKey(e.opts);
  const defs = (m.defines ??= {}) as Record<string, unknown>;
  e.hadDefines = 'HW_VOXEL_LOOK' in defs;
  defs.HW_VOXEL_LOOK = '';
  e.patched = true;
  m.needsUpdate = true;
}

function unpatch(m: PatchableMaterial, e: Entry): void {
  if (e.prevCompile) m.onBeforeCompile = e.prevCompile;
  if (e.prevKey) m.customProgramCacheKey = e.prevKey;
  else delete (m as { customProgramCacheKey?: unknown }).customProgramCacheKey;
  if (!e.hadDefines && m.defines) delete (m.defines as Record<string, unknown>).HW_VOXEL_LOOK;
  e.prevCompile = null;
  e.prevKey = null;
  e.patched = false;
  m.needsUpdate = true;
}

function syncAll(): void {
  const want = wantPatched();
  for (const r of live) {
    const m = r.deref();
    if (!m) {
      live.delete(r);
      continue;
    }
    const e = entries.get(m);
    if (!e || !isPatchable(m)) continue;
    if (want && !e.patched) patch(m, e);
    else if (!want && e.patched) unpatch(m, e);
  }
}

onCinematicChange(syncAll);

// ---------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------

const VERT_HEAD = /* glsl */ `
#ifdef HW_VOXEL_LOOK
uniform vec4 hwVoxA;
uniform vec4 hwVoxB;
varying vec3 vHwVox;
#ifdef HW_VOX_ATTR
attribute float hwVoxelSize;
#endif
#endif
`;

// after project_vertex: `transformed` is the geometry-space position, batchingMatrix / instanceMatrix exist
const VERT_BODY_LOCAL = /* glsl */ `
#ifdef HW_VOXEL_LOOK
{
  float hwS = hwVoxA.x;
  #ifdef HW_VOX_ATTR
  if (hwVoxelSize > 0.0) hwS = hwVoxelSize;
  #endif
  vHwVox = floor(transformed / hwS + hwVoxB.w);
}
#endif
`;

const VERT_BODY_WORLD = /* glsl */ `
#ifdef HW_VOXEL_LOOK
{
  float hwS = hwVoxA.x;
  #ifdef HW_VOX_ATTR
  if (hwVoxelSize > 0.0) hwS = hwVoxelSize;
  #endif
  vec4 hwW = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
  hwW = batchingMatrix * hwW;
  #endif
  #ifdef USE_INSTANCING
  hwW = instanceMatrix * hwW;
  #endif
  hwW = modelMatrix * hwW;
  vHwVox = floor(hwW.xyz / hwS + hwVoxB.w);
}
#endif
`;

const FRAG_HEAD = /* glsl */ `
#ifdef HW_VOXEL_LOOK
uniform vec4 hwVoxA;
uniform vec4 hwVoxB;
uniform vec3 hwLookRim;
uniform float hwLookOn;
varying vec3 vHwVox;
float hwVoxHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
#endif
`;

// after color_fragment: rebuild the cube grid, seams, bevel weights and per-cube randoms
const FRAG_GRID = /* glsl */ `
#ifdef HW_VOXEL_LOOK
  vec3 hwG = vHwVox;
  vec3 hwGx = dFdx(hwG);
  vec3 hwGy = dFdy(hwG);
  vec3 hwNg = abs(cross(hwGx, hwGy));
  vec2 hwUv; vec2 hwDx; vec2 hwDy; float hwPlane;
  if (hwNg.x >= hwNg.y && hwNg.x >= hwNg.z) { hwUv = hwG.yz; hwDx = hwGx.yz; hwDy = hwGy.yz; hwPlane = hwG.x; }
  else if (hwNg.y >= hwNg.z) { hwUv = hwG.zx; hwDx = hwGx.zx; hwDy = hwGy.zx; hwPlane = hwG.y; }
  else { hwUv = hwG.xy; hwDx = hwGx.xy; hwDy = hwGy.xy; hwPlane = hwG.z; }
  // voxels per pixel along each in-plane axis
  vec2 hwFw = abs(hwDx) + abs(hwDy);
  float hwPx = max(hwFw.x, hwFw.y);
  vec2 hwF = fract(hwUv);
  vec2 hwE = min(hwF, 1.0 - hwF);
  // bevel band and the thin seam crease, widened to the pixel footprint so they never alias
  vec2 hwB = 1.0 - smoothstep(vec2(0.0), vec2(hwVoxA.z) + hwFw * 0.75, hwE);
  vec2 hwS2 = 1.0 - smoothstep(vec2(0.0), vec2(hwVoxA.z * 0.28) + hwFw * 0.6, hwE);
  // bevels need ~3+ pixels per voxel, the per-cube glint ~1.2+
  float hwFadeB = (1.0 - smoothstep(0.14, 0.34, hwPx)) * hwLookOn;
  float hwFadeG = (1.0 - smoothstep(0.45, 0.85, hwPx)) * hwLookOn;
  vec3 hwCell = vec3(floor(hwUv), floor(hwPlane + 0.5));
  float hwH1 = hwVoxHash(hwCell + vec3(17.0, 3.0, 11.0));
  float hwH2 = hwVoxHash(hwCell.yzx + vec3(5.0, 29.0, 7.0));
  float hwH3 = hwVoxHash(hwCell.zxy + vec3(41.0, 13.0, 23.0));
  // the dark seam needs the most pixels: a 1 px line every few pixels reads as graph paper, not cubes
  float hwFadeS = (1.0 - smoothstep(0.05, 0.3, hwPx)) * hwLookOn;
  float hwSeam = max(hwS2.x, hwS2.y) * hwFadeS;
  float hwBev = max(hwB.x, hwB.y) * hwFadeB;
  diffuseColor.rgb *= (1.0 - hwVoxA.y * hwSeam)
    * (1.0 + (hwH1 - 0.5) * 2.0 * hwVoxB.y * hwFadeG)
    * (1.0 + 0.1 * hwBev * (1.0 - hwSeam));
#endif
`;

const FRAG_ROUGH = /* glsl */ `
#ifdef HW_VOXEL_LOOK
  roughnessFactor = clamp(roughnessFactor * (1.0 - 0.4 * hwBev * hwVoxB.x) * mix(1.0, 0.72 + 0.56 * hwH2, hwVoxB.x * hwFadeG), 0.04, 1.0);
#endif
`;

// after normal_fragment_maps: tilt the (view-space) normal outward on the bevels, jitter it per cube
const FRAG_NORMAL = /* glsl */ `
#ifdef HW_VOXEL_LOOK
{
  vec3 hwQx = dFdx(-vViewPosition);
  vec3 hwQy = dFdy(-vViewPosition);
  float hwDet = hwDx.x * hwDy.y - hwDx.y * hwDy.x;
  if (abs(hwDet) > 1e-10 && (hwFadeB + hwFadeG) > 0.0) {
    vec3 hwT = (hwQx * hwDy.y - hwQy * hwDx.y) / hwDet;
    vec3 hwBt = (hwQy * hwDx.x - hwQx * hwDy.x) / hwDet;
    hwT = normalize(hwT - normal * dot(normal, hwT) + 1e-6);
    hwBt = normalize(hwBt - normal * dot(normal, hwBt) + 1e-6);
    vec2 hwTilt = sign(hwF - 0.5) * hwB * (hwVoxA.w * hwFadeB);
    // glossy (wet) surfaces keep coherent reflections: less per-cube jitter where roughness is low
    vec2 hwJit = (vec2(hwH2, hwH3) - 0.5) * (0.32 * hwVoxB.x * hwFadeG * clamp(roughnessFactor * 2.0, 0.2, 1.0));
    normal = normalize(normal + hwT * (hwTilt.x + hwJit.x) + hwBt * (hwTilt.y + hwJit.y));
  }
}
#endif
`;

const FRAG_RIM = /* glsl */ `
#if defined(HW_VOXEL_LOOK) && defined(HW_VOX_RIM)
{
  float hwFr = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  totalEmissiveRadiance += hwLookRim * (hwFr * hwFr * hwFr * hwVoxB.z * hwLookOn);
}
#endif
`;

function after(src: string, anchor: string, code: string): string | null {
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  const j = i + anchor.length;
  return src.slice(0, j) + '\n' + code + src.slice(j);
}

let anchorWarned = false;

/** Insert the voxel look into a standard / physical shader. Exported for tests. */
export function injectVoxelLook(shader: THREE.WebGLProgramParametersWithUniforms, e: Pick<Entry, 'opts' | 'uA' | 'uB'>): boolean {
  const o = e.opts;
  shader.uniforms.hwVoxA = e.uA;
  shader.uniforms.hwVoxB = e.uB;
  shader.uniforms.hwLookRim = LOOK_UNIFORMS.hwLookRim;
  shader.uniforms.hwLookOn = LOOK_UNIFORMS.hwLookOn;
  let defs = '';
  if (o.voxelSize === 'attribute') defs += '#define HW_VOX_ATTR\n';
  if (o.rim > 0) defs += '#define HW_VOX_RIM\n';
  let v: string | null = shader.vertexShader;
  let f: string | null = shader.fragmentShader;
  v = after(v, '#include <common>', defs + VERT_HEAD);
  if (v) v = after(v, '#include <project_vertex>', o.space === 'world' ? VERT_BODY_WORLD : VERT_BODY_LOCAL);
  f = after(f, '#include <common>', defs + FRAG_HEAD);
  // the grid block must come first; fall back to the roughness anchor if a material replaced color_fragment
  const gridAnchor = f && f.includes('#include <color_fragment>') ? '#include <color_fragment>' : '#include <map_fragment>';
  if (f) f = after(f, gridAnchor, FRAG_GRID);
  if (f) f = after(f, '#include <roughnessmap_fragment>', FRAG_ROUGH);
  if (f) f = after(f, '#include <normal_fragment_maps>', FRAG_NORMAL);
  if (f) f = after(f, '#include <emissivemap_fragment>', FRAG_RIM);
  if (!v || !f) {
    if (!anchorWarned) {
      anchorWarned = true;
      console.warn('[voxelLook] a shader anchor is missing (another patch replaced a three.js include); the look is skipped for that material');
    }
    // leave the shader as the previous hooks made it; HW_VOXEL_LOOK has no effect without the chunk
    return false;
  }
  shader.vertexShader = v;
  shader.fragmentShader = f;
  return true;
}
