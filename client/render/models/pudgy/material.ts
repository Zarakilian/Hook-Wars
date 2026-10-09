// Pudgy material: MeshStandardMaterial patched to read the per-vertex `surf` attribute
// (roughness, metalness, two emissive weights; roughness above 1.5 marks a premium sparkling voxel,
// metalness above 1.5 a team-coloured voxel) plus per-character uniforms for glow pulses, hit flash,
// a soft team rim light, the self-lit team accent, the sparkle clock and the share of the scene's
// environment (image-based) light the body takes.
// Every character gets its own small material instance (uniform values differ per unit), but all
// instances report the same program cache key, so the GPU compiles one shader for all of them.
//
// Epic (cinematic mode, client/render/cinematic.ts) adds, only while it is on:
//   - the voxel look (look/voxelLook.ts): per-cube bevels, seams and glints in geometry space, sized to
//     the part's voxels (VOX / res), adopted by every opaque Pudgy material;
//   - glossier wet, rubber, metal and skin voxels (cloth stays matte), full only where the cubes are big
//     enough on screen to break the highlight up (voxelLook's glint fade), so flat faces never flash;
//   - a back light from behind the subject on the side away from the key light, in the map's rim colour
//     (LOOK_UNIFORMS.hwLookRim: moonlight at night, peach at dusk), so Lunkers separate from the ground
//     the way the reference sheets do (ref01 to ref03), and a team rim in a deeper Epic team colour
//     (uPudgyTeamRim); both follow the silhouette (grid.ts macro normals) as bands a few pixels wide
//     (uPudgyPx, measured by lod.ts), at the gameplay camera and in close-ups alike;
//   - form shading: the lighting normal bends toward the macro normal, so a belly shades as one round
//     shape with the cube detail on it, plus per-cube glints on glossy voxels and glossier metal where
//     cubes are a few pixels wide (wet oilskin, slime, rusty iron).
// While cinematic is off none of it is compiled: the program, its cache key and every uniform are the
// same as before, so the normal tiers render exactly as they did.
import * as THREE from 'three';
import { cinematicEnabled, onCinematicChange } from '../../cinematic.ts';
import { LOOK_UNIFORMS, applyVoxelLook, removeVoxelLook, type VoxelLookOptions } from '../../look/voxelLook.ts';
import { VOX } from './grid.ts';

export interface PudgyUniforms {
  uGlowA: { value: number };
  uGlowB: { value: number };
  uFlash: { value: number };
  uFlashColor: { value: THREE.Color };
  uRim: { value: number };
  uRimColor: { value: THREE.Color };
  /** sparkle clock (seconds) */
  uTime: { value: number };
  /** 0..1 strength of premium sparkles (0 turns them off) */
  uSparkle: { value: number };
  /**
   * Self-lit share of team-coloured voxels (emissive = albedo * uTeamGlow). Keeps the team hue on the
   * body under tinted map light (sunset, moonlight), where a lit-only trim turns mauve or brown.
   */
  uTeamGlow: { value: number };
  /**
   * Share of the scene's environment light (diffuse and reflected) on the body; premium voxels always
   * take all of it, so chrome and gold keep their reflections. The Locker's bright studio room
   * environment otherwise lays an even grey veil over every character (finding 34 check: Locker
   * luminance = 0.69 x the reference sheets + 81, for all three families alike).
   */
  uEnv: { value: number };
  /**
   * Epic only (never bound while cinematic is off): projected size of one game voxel of this unit in
   * drawing-buffer pixels (lod.ts measures it every frame), so the rim bands stay a few pixels wide
   * from the gameplay camera to a close-up.
   */
  uPudgyPx: { value: number };
  /**
   * Epic only: the team colour of the silhouette rim and the extra team glow. Deeper than the rim
   * colour of the normal tiers, so the night grade's warm lean lands on red, not on lantern orange.
   */
  uPudgyTeamRim: { value: THREE.Color };
}

/** projected game-voxel size (px) the Epic rims assume until lod.ts has measured one (gameplay camera, 1080p) */
export const PUDGY_PX_DEFAULT = 1.4;

export function makeUniforms(rim: number, rimColor: number, teamGlow = 0, env = 1, epicTeamRim = rimColor): PudgyUniforms {
  return {
    uGlowA: { value: 2.2 },
    uGlowB: { value: 1.5 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uRim: { value: rim },
    uRimColor: { value: new THREE.Color(rimColor) },
    uTime: { value: 0 },
    uSparkle: { value: 1 },
    uTeamGlow: { value: teamGlow },
    uEnv: { value: env },
    uPudgyPx: { value: PUDGY_PX_DEFAULT },
    uPudgyTeamRim: { value: new THREE.Color(epicTeamRim) },
  };
}

const VERT_HEAD = /* glsl */ `
attribute vec4 surf;
varying vec4 vSurf;
varying vec3 vObjPos;
`;
const FRAG_HEAD = /* glsl */ `
varying vec4 vSurf;
varying vec3 vObjPos;
uniform float uGlowA;
uniform float uGlowB;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uRim;
uniform vec3 uRimColor;
uniform float uTime;
uniform float uSparkle;
uniform float uTeamGlow;
uniform float uEnv;
float pudgyHash(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}
`;

// ---------------------------------------------------------------------------------------------
// Epic only (never compiled while cinematic is off)
// ---------------------------------------------------------------------------------------------

/**
 * Epic strengths shared by every Pudgy material (live: changing them never recompiles).
 * uPudgyEpic: x = back light (far side), y = gloss (0 = the normal tier's roughness), z = extra team
 * glow, w = metal lift. uPudgyEpic2: x = back light on the key side (share of x), y = how far the extra
 * team glow leans to the Epic team rim colour (0 = the voxel's own colour), z = team rim on the
 * silhouette (macro normal, x uRim), w = how much of the per-face team rim is taken out (1 = all: on
 * voxel faces it lights every grazing step of the body, not the outline).
 */
export const PUDGY_EPIC = {
  uPudgyEpic: { value: new THREE.Vector4(0.6, 1, 0.1, 0.15) },
  uPudgyEpic2: { value: new THREE.Vector4(0.3, 0.6, 1.6, 0.7) },
  /**
   * Rim band widths on the macro normal, in drawing-buffer pixels whatever the distance:
   * x = back light, y = team rim, w = extra width per pixel of body radius (a close-up gets a little
   * more than a few pixels); z = the facing below which the rims fade out (macro normals that face away
   * from the camera on a visible surface are undersides and concave seams, never the outline).
   */
  uPudgyEpic3: { value: new THREE.Vector4(3, 2.6, -0.3, 0.02) },
  /**
   * Form shading: x = how far the lighting normal bends from the voxel face toward the macro normal
   * (0 = faceted like the normal tiers; the refs shade a belly as one round shape with cube detail on
   * it), y = per-cube normal jitter on glossy voxels (wet glints), z, w = the projected voxels per pixel
   * where that jitter fades out (it needs cubes of a few pixels, or it shimmers).
   */
  uPudgyEpic4: { value: new THREE.Vector4(0.6, 0.3, 0.2, 0.45) },
  /** x = roughness multiplier of metal voxels where cubes are a few pixels wide (1 = the gloss above only); y, z, w spare */
  uPudgyEpic5: { value: new THREE.Vector4(0.5, 0, 0, 0) },
};

/** Epic silhouette rim colours per team (Red Tide crimson, Blue Gill azure): see uPudgyTeamRim. */
export const PUDGY_EPIC_TEAM_RIM: Readonly<Record<0 | 1, number>> = { 0: 0xff3a4c, 1: 0x5aa8ff };

// vertex: the smooth macro normal of the shape (grid.ts writes pudgyN while Epic is on)
const VERT_HEAD_EPIC = /* glsl */ `
attribute vec4 pudgyN;
varying vec4 vPudgyN;
`;
const VERT_BODY_EPIC = /* glsl */ `
  vPudgyN = vec4(normalMatrix * pudgyN.xyz, pudgyN.w);`;

const FRAG_HEAD_EPIC = /* glsl */ `
varying vec4 vPudgyN;
uniform vec3 uPudgyBack;
uniform vec4 uPudgyEpic;
uniform vec4 uPudgyEpic2;
uniform vec4 uPudgyEpic3;
uniform float uPudgyPx;
uniform vec3 uPudgyTeamRim;
uniform vec4 uPudgyEpic4;
uniform vec4 uPudgyEpic5;
`;

// after the voxel look's normal block (voxelLook inserts it right after normal_fragment_maps, before
// this): bend the lighting normal toward the smooth macro normal, so big shapes shade round (the belly
// of ref01 to ref03 is one lit sphere, not flat steps) while the bevel tilt and per-cube jitter the voxel
// look added stay on top of it; thin strands (low bulk) and faces that point away from the macro normal
// (concave steps) keep their own normal. Then a per-cube jitter on glossy voxels, only where cubes are a
// few pixels wide, so lanterns and the key light break into glints on wet oilskin, slime and metal.
const FRAG_NORMAL_EPIC = /* glsl */ `
  {
    if (dot(vPudgyN.xyz, vPudgyN.xyz) > 1e-6) {
      vec3 pudgyMn = normalize(vPudgyN.xyz);
      float pudgyK = uPudgyEpic4.x * clamp(vPudgyN.w, 0.0, 1.0) * smoothstep(0.0, 0.35, dot(pudgyMn, nonPerturbedNormal));
      normal = normalize(normal + pudgyK * (pudgyMn - nonPerturbedNormal));
    }
#ifdef HW_VOXEL_LOOK
    float pudgyGl = uPudgyEpic4.y * (1.0 - smoothstep(uPudgyEpic4.z, uPudgyEpic4.w, hwPx)) * hwLookOn
      * (1.0 - smoothstep(0.22, 0.6, roughnessFactor)) * (1.0 - pudgyPrem);
    if (pudgyGl > 0.0) {
      vec3 pudgyJ = vec3(hwH1, hwH2, hwH3) - 0.5;
      pudgyJ -= normal * dot(pudgyJ, normal);
      normal = normalize(normal + pudgyGl * pudgyJ);
    }
#endif
  }
`;

// right after the roughness decode: glossier wet / rubber / metal / skin, gated by the cube footprint,
// then voxelLook's per-cube roughness jitter again (its own block ran before the decode overwrote it)
const FRAG_ROUGH_EPIC = /* glsl */ `
  float pudgyNear = 0.0;
#ifdef HW_VOXEL_LOOK
  pudgyNear = hwFadeG;
#endif
  {
    float g = uPudgyEpic.y * mix(0.4, 1.0, pudgyNear) * (1.0 - pudgyPrem);
    roughnessFactor *= mix(1.0, 0.68, g * (1.0 - smoothstep(0.7, 0.9, roughnessFactor)));
  }
#ifdef HW_VOXEL_LOOK
  {
    // metal voxels (iron, brass) glossier still where cubes are a few pixels wide: the satin roughness
    // the normal tiers need (a flat iron face would mirror the sky across a whole forearm) is not needed
    // on the round, per-cube jittered normals below; full detail only, so the gameplay camera is unchanged
    float pudgyMetal = step(0.3, vSurf.y - 2.0 * step(1.5, vSurf.y)) * (1.0 - pudgyPrem);
    roughnessFactor *= mix(1.0, uPudgyEpic5.x, pudgyMetal * (1.0 - smoothstep(uPudgyEpic4.z, uPudgyEpic4.w, hwPx)));
  }
  roughnessFactor = clamp(roughnessFactor * (1.0 - 0.4 * hwBev * hwVoxB.x) * mix(1.0, 0.72 + 0.56 * hwH2, hwVoxB.x * hwFadeG), 0.04, 1.0);
#endif
`;

const FRAG_METAL_EPIC = /* glsl */ `
  metalnessFactor = min(1.0, metalnessFactor * (1.0 + uPudgyEpic.w * step(0.3, metalnessFactor)));
`;

// inside the emissive block: the back light and the team rim. The back light comes, in view space, from
// behind the subject (-z) and a little above, on the screen side away from the key light (a share of it
// on the key side too); both follow the macro normal (grid.ts), so they outline the silhouette of the
// whole shape, not every grazing voxel face. Each rim is a band from the outline inward whose width is
// set in pixels (uPudgyEpic3) from the unit's projected voxel size (uPudgyPx; a body is about 10 game
// voxels in radius): about 3 px at the gameplay camera, a crisp line in a close-up, never a veil over
// the whole side. Macro normals that face away from the camera on a visible surface (undersides, the
// apron hem, inner arms: the blur tilts them there) and thin strands (low bulk) stay unlit.
const FRAG_EMIT_EPIC = /* glsl */ `
    {
#if NUM_DIR_LIGHTS > 0
      vec3 pudgyKey = directionalLights[0].direction;
#else
      vec3 pudgyKey = vec3(1.0, 1.0, 0.0);
#endif
      float pudgySide = pudgyKey.x >= 0.0 ? -1.0 : 1.0;
      vec3 pudgyBackL = normalize(vec3(0.62 * pudgySide, 0.36, -0.7));
      vec3 pudgyBackK = normalize(vec3(-0.62 * pudgySide, 0.36, -0.7));
      // the macro normal (no macro normal on this geometry: the face normal, full bulk)
      bool pudgyHasM = dot(vPudgyN.xyz, vPudgyN.xyz) > 1e-6;
      vec3 pudgyM = pudgyHasM ? normalize(vPudgyN.xyz) : normal;
      float pudgyD = dot(pudgyM, pudgyView);
      float pudgyBulk = pudgyHasM ? clamp(vPudgyN.w, 0.0, 1.0) : 1.0;
      float pudgyGate = smoothstep(uPudgyEpic3.z, 0.0, pudgyD) * pudgyBulk;
      // band depth in facing for a band w px wide on a sphere of radius R px: about sqrt(2 w / R)
      float pudgyR = 10.0 * max(uPudgyPx, 0.5);
      float pudgyWb = clamp(sqrt(2.0 * (uPudgyEpic3.x + uPudgyEpic3.w * pudgyR) / pudgyR), 0.08, 0.75);
      float pudgyWt = clamp(sqrt(2.0 * (uPudgyEpic3.y + uPudgyEpic3.w * pudgyR) / pudgyR), 0.08, 0.75);
      float pudgySb = 1.0 - clamp(pudgyD / pudgyWb, 0.0, 1.0);
      float pudgySt = 1.0 - clamp(pudgyD / pudgyWt, 0.0, 1.0);
      pudgySb *= pudgySb * pudgyGate;
      pudgySt *= pudgySt * pudgyGate;
      float pudgyBk = clamp(dot(pudgyM, pudgyBackL), 0.0, 1.0) + uPudgyEpic2.x * clamp(dot(pudgyM, pudgyBackK), 0.0, 1.0);
      pudgyBk *= mix(0.5, 1.0, clamp(dot(normal, pudgyBackL) + 0.5, 0.0, 1.0));
      // the map's rim hue at luma 1, part way to white (moonlight reads white-blue, never team blue)
      vec3 pudgyRimHue = mix(uPudgyBack / max(dot(uPudgyBack, vec3(0.2126, 0.7152, 0.0722)), 1e-3), vec3(1.0), 0.4);
      totalEmissiveRadiance += pudgyRimHue * (uPudgyEpic.x * pudgyBk * pudgySb) * (0.6 + 0.4 * diffuseColor.rgb);
      // the team rim on the outline instead of on every grazing voxel face, in the deeper Epic team colour
      totalEmissiveRadiance += uPudgyTeamRim * (uRim * uPudgyEpic2.z * pudgySt) - uRimColor * (uRim * uPudgyEpic2.w * pudgyFres);
      totalEmissiveRadiance += mix(diffuseColor.rgb, uPudgyTeamRim * dot(diffuseColor.rgb, vec3(0.3333)), uPudgyEpic2.y) * (pudgyTeam * uPudgyEpic.z);
    }
`;

/** Epic extras on (debug A/B for profiling: off keeps only the voxel look). */
let epicExtras = true;

const live = new Set<WeakRef<THREE.MeshStandardMaterial>>();

function epicOn(): boolean {
  return cinematicEnabled() && epicExtras;
}

/**
 * Recompile every live Pudgy material. dispose(), not needsUpdate: three keeps each material's compiled
 * programs and, when the material switches back to one of them, reuses it with the uniforms object of
 * its LAST compile (the other mode's). After an Epic -> off -> Epic round trip the Epic-only uniforms
 * (uPudgyPx, uPudgyTeamRim, the voxel look's cube size) would then never be uploaded again, and every
 * unit would draw with whatever the shared program last held: a veil of rim light over close-ups and
 * the other team's rim colour. dispose() drops the cached programs, so the next draw runs
 * onBeforeCompile again; three re-initialises a disposed material that is still in use.
 */
function touchAll(): void {
  for (const r of live) {
    const m = r.deref();
    if (!m) live.delete(r);
    else m.dispose();
  }
}

// a runtime toggle of cinematic mode recompiles every live Pudgy material with or without the Epic code
onCinematicChange(touchAll);

/** Debug / profiling: switch the Epic extras (gloss, back light) off or on; the voxel look stays. */
export function setPudgyEpicExtras(on: boolean): void {
  if (on === epicExtras) return;
  epicExtras = on;
  if (cinematicEnabled()) touchAll();
}

/**
 * The voxel look on Lunkers (look/voxelLook.ts options; the cube size comes from the detail level):
 * thinner seams and wider, steeper bevels than the defaults, so cube edges catch the light more than a
 * dark grid shows (ref01 to ref03).
 */
const PUDGY_LOOK: Omit<VoxelLookOptions, 'voxelSize' | 'space' | 'fallbackSize'> = { seam: 0.22, bevel: 0.22, tilt: 1.0, glint: 0.7, tile: 0.05, rim: 0 };

/** voxel look options for a Pudgy material at a detail level (res = fine voxels per skeleton unit) */
function voxelOpts(res: number): VoxelLookOptions {
  return { ...PUDGY_LOOK, voxelSize: VOX / res, space: 'local' };
}

/** Debug / tuning: change the voxel look options on every live Pudgy material (uniform-only, no recompile). */
export function setPudgyLook(patch: Omit<VoxelLookOptions, 'voxelSize' | 'space' | 'fallbackSize' | 'rim'>): Readonly<typeof PUDGY_LOOK> {
  Object.assign(PUDGY_LOOK, patch);
  for (const r of live) {
    const m = r.deref();
    const res = m?.userData.pudgyVoxRes as number | undefined;
    if (m && res !== undefined) applyVoxelLook(m, voxelOpts(res));
  }
  return PUDGY_LOOK;
}

/**
 * The voxel look's cube size for a material whose parts switched detail (Epic level of detail):
 * uniform-only, no recompile. No-op on materials that never adopted it (ghosts).
 */
export function setPudgyVoxelRes(m: THREE.MeshStandardMaterial, res: number): void {
  if (m.userData.pudgyVoxRes === undefined || m.userData.pudgyVoxRes === res) return;
  m.userData.pudgyVoxRes = res;
  applyVoxelLook(m, voxelOpts(res));
}

/** Debug / profiling: take the voxel look off a Pudgy material (on = put it back). */
export function setPudgyVoxelLook(m: THREE.MeshStandardMaterial, on: boolean): void {
  const res = m.userData.pudgyVoxRes as number | undefined;
  if (res === undefined) return;
  if (on) applyVoxelLook(m, voxelOpts(res));
  else removeVoxelLook(m);
}

/**
 * res: fine voxels per skeleton unit of the geometry drawn with it (1 = game, 2 = showcase), for the
 * Epic voxel look. Transparent (ghost) materials never adopt it. inMatch: the Epic extras (gloss, back
 * light, silhouette team rim) are for units in a match only; the Locker, Store and thumbnails (showcase)
 * keep their tuned studio look and take only the voxel look.
 */
export function makePudgyMaterial(u: PudgyUniforms, transparent: boolean, res = 1, inMatch = true): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0,
    transparent,
    opacity: 1,
    depthWrite: true,
  });
  m.name = transparent ? 'pudgy-ghost' : 'pudgy';
  m.onBeforeCompile = (sh) => {
    const epic = inMatch && epicOn();
    sh.uniforms.uGlowA = u.uGlowA;
    sh.uniforms.uGlowB = u.uGlowB;
    sh.uniforms.uFlash = u.uFlash;
    sh.uniforms.uFlashColor = u.uFlashColor;
    sh.uniforms.uRim = u.uRim;
    sh.uniforms.uRimColor = u.uRimColor;
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uSparkle = u.uSparkle;
    sh.uniforms.uTeamGlow = u.uTeamGlow;
    sh.uniforms.uEnv = u.uEnv;
    if (epic) {
      sh.uniforms.uPudgyBack = LOOK_UNIFORMS.hwLookRim;
      sh.uniforms.uPudgyEpic = PUDGY_EPIC.uPudgyEpic;
      sh.uniforms.uPudgyEpic2 = PUDGY_EPIC.uPudgyEpic2;
      sh.uniforms.uPudgyEpic3 = PUDGY_EPIC.uPudgyEpic3;
      sh.uniforms.uPudgyPx = u.uPudgyPx;
      sh.uniforms.uPudgyTeamRim = u.uPudgyTeamRim;
      sh.uniforms.uPudgyEpic4 = PUDGY_EPIC.uPudgyEpic4;
      sh.uniforms.uPudgyEpic5 = PUDGY_EPIC.uPudgyEpic5;
    }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}${epic ? VERT_HEAD_EPIC : ''}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSurf = surf;\n  vObjPos = position;' + (epic ? VERT_BODY_EPIC : ''));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}${epic ? FRAG_HEAD_EPIC : ''}`)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  float pudgyPrem = step(1.5, vSurf.x);\n  roughnessFactor = vSurf.x - 2.0 * pudgyPrem;' + (epic ? FRAG_ROUGH_EPIC : ''),
      )
      .replace(
        '#include <lights_fragment_maps>',
        /* glsl */ `#include <lights_fragment_maps>
  {
    float pudgyEnv = mix(uEnv, 1.0, pudgyPrem);
    iblIrradiance *= pudgyEnv;
    radiance *= pudgyEnv;
  }`,
      )
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  float pudgyTeam = step(1.5, vSurf.y);\n  metalnessFactor = vSurf.y - 2.0 * pudgyTeam;' + (epic ? FRAG_METAL_EPIC : ''))
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * (vSurf.z * uGlowA + vSurf.w * uGlowB + pudgyTeam * uTeamGlow);
  {
    vec3 pudgyView = normalize(vViewPosition);
    float pudgyFres = 1.0 - clamp(dot(normal, pudgyView), 0.0, 1.0);
    pudgyFres = pudgyFres * pudgyFres * pudgyFres;
    totalEmissiveRadiance += uRimColor * (pudgyFres * uRim) + uFlashColor * uFlash;${epic ? FRAG_EMIT_EPIC : ''}
    if (pudgyPrem > 0.5 && uSparkle > 0.0) {
      // premium glints: a few voxel faces at a time flare up and fade
      vec3 cell = floor(vObjPos * 40.0 + 0.001);
      float h = pudgyHash(cell);
      float tw = sin(uTime * (1.7 + h * 2.6) + h * 61.0);
      tw = pow(max(tw, 0.0), 28.0) * step(0.72, h);
      totalEmissiveRadiance += mix(diffuseColor.rgb, vec3(1.0), 0.7) * tw * 2.6 * uSparkle;
      totalEmissiveRadiance += diffuseColor.rgb * 0.06 * uSparkle;
    }
  }`,
      );
    if (epic) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL_EPIC}`);
  };
  // the Epic variant is its own program (the predicate is read again whenever three rebuilds the key)
  m.customProgramCacheKey = () => (inMatch && epicOn() ? 'pudgy-surf-v4|epic1' : 'pudgy-surf-v4');
  m.userData.pudgyUniforms = u;
  live.add(new WeakRef(m));
  if (!transparent) {
    // registers only while cinematic is off (no change to the material); patched while it is on
    m.userData.pudgyVoxRes = res;
    applyVoxelLook(m, voxelOpts(res));
  }
  return m;
}
