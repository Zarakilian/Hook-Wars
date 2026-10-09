// Epic (cinematic) terrain: per-map styles and the Epic-only biome wrapper. Nothing here runs while
// cinematic mode is off: buildWorld() only wraps the biome and uses these numbers when the match is
// built with cinematicEnabled() (the Steam build's "Epic" graphics setting, ?cinematic in the browser).
//
// The wrapper changes column colours and roughness only (never a height, a quantum or a side id, so
// units, groundHeight() and online play stand on exactly the same ground):
//   - damp ground along the water: darker and glossier toward the shore (the wet reference banks)
//   - rain: standing puddles on open ground, mirror-flat and dark, that pick up the lantern lights
//   - the river bed: silt toward deep water, scattered stones, sand ripples (Maelstrom)
//   - channel walls: a wet stain band between the low and full water lines, moss on the top courses
// It all lands in the field's colour and roughness textures, so it costs nothing on the GPU. The wet
// gloss itself (specular boost, flat puddles, a damp fringe on walls) is the Epic terrain shader
// (material.ts), and the voxel bevels come from applyVoxelLook (look/voxelLook.ts).
import { channelDepthAt } from '../../../../shared/maps/helpers.ts';
import type { MapDef } from '../../../../shared/maps/types.ts';
import { valueNoise2 } from '../../../../shared/math.ts';
import type { MatchConfig } from '../../../../shared/types.ts';
import { bedY, groundY, waterY } from '../../contracts.ts';
import type { VoxelLookOptions } from '../../look/voxelLook.ts';
import { hashVox } from '../../voxel/voxel.ts';
import { SIDE, clamp01, h01, mix, shade, smooth01 } from './biome.ts';
import type { MapBiome } from './biomes/index.ts';
import type { Biome, Cell, SideOut } from './field.ts';
import type { MistDef } from './mist.ts';

export interface EpicStyle {
  /** voxel look of the fine (0.25 m columns) and outer (1 m columns) fields */
  near: VoxelLookOptions;
  outer: VoxelLookOptions;
  /**
   * wet gloss in the Epic terrain shader: x = direct specular boost on glossy ground (lantern and
   * moon highlights), y = environment reflection boost, z = 0..1 how flat standing water lies (no
   * per-cube bevel tilt in puddles), w = height (m) of the damp fringe on walls above the wet line
   */
  spec: [number, number, number, number];
  /**
   * the lanterns' glare on wet ground stretched into wet-street streaks: x strength (0 = off), y lateral
   * width, z length / width, w how far wet ground calms the per-cube bevel and jitter normals (0..1).
   * The streaks are a per-pixel loop over the lantern pool, so only the wet night maps pay for them
   * (x = 0 skips the loop; dusk, snow and day keep the boosted PointLight highlight only).
   */
  streak: [number, number, number, number];
  /** multiplier on the baked lamp-light pools (the real lantern lights now light the ground as well) */
  lamp: number;
  /** damp ground along the water: width on land (m), darkening 0..1, the roughness it tends to */
  damp?: { w: number; dark: number; rough: number };
  /** rain: puddle threshold on a 0..1 noise (about the covered fraction), the sky colour they mirror */
  puddles?: { cover: number; sky: number };
  /** river bed: scattered stones (rate per column), silt colour and amount toward deep water, sand ripples */
  bed?: { stones: readonly number[]; rate: number; silt: number; siltAmt: number; ripple?: number };
  /** channel walls: a wet stain band between the low and full water lines, moss on the top courses */
  wall?: { stain: number; stainAmt: number; moss?: readonly number[]; mossAmt?: number };
  /** extra low mist banks over the backdrop water (ref04) */
  mist?: (ctx: EpicCtx) => MistDef[];
  /**
   * the colour every mist bank takes in Epic (the biome's own and the extra ones); unset keeps the biome's
   * mist colour (or the fog colour). Mirelight's dusk fog colour is so dark that its banks vanished
   * against the forest; ref04's marsh mist is a sun-lit lavender.
   */
  mistColor?: number;
}

export interface EpicCtx {
  map: MapDef;
  biome: MapBiome;
  fullY: number;
  halfW: number;
  halfD: number;
}

const NIGHT_RAIN: EpicStyle = {
  near: { voxelSize: 0.25, space: 'world', seam: 0.26, bevel: 0.14, glint: 0.45 },
  outer: { voxelSize: 0.5, space: 'world', seam: 0.22, bevel: 0.13, glint: 0.45 },
  spec: [2.2, 1.4, 0.85, 0.14],
  // wet setts: the glare stays one long streak per lamp (at 0.7 calm the bevels split it into a grid of squares)
  streak: [0.75, 0.16, 4.5, 0.9],
  lamp: 0.8,
  damp: { w: 1.2, dark: 0.18, rough: 0.22 },
  puddles: { cover: 0.3, sky: 0x1a202c },
  bed: { stones: [0x2a2c30, 0x3a3836, 0x1e2024, 0x45423c], rate: 0.07, silt: 0x121518, siltAmt: 0.4 },
  wall: { stain: 0x1c261f, stainAmt: 0.45, moss: [0x2b3c22, 0x33472a, 0x26351d], mossAmt: 0.22 },
};

const DUSK_MARSH: EpicStyle = {
  near: { voxelSize: 0.25, space: 'world', seam: 0.2, bevel: 0.13, glint: 0.55 },
  outer: { voxelSize: 0.5, space: 'world', seam: 0.2, bevel: 0.13, glint: 0.5 },
  spec: [1.5, 1.0, 0.8, 0.12],
  streak: [0, 0.12, 3.0, 0.45],
  lamp: 0.85,
  damp: { w: 1.5, dark: 0.24, rough: 0.3 },
  bed: { stones: [0x3a3426, 0x4c4434, 0x1a1812, 0x2e2a1e], rate: 0.06, silt: 0x14130e, siltAmt: 0.5 },
  wall: { stain: 0x1d2315, stainAmt: 0.42, moss: [0x34481e, 0x3f5a22, 0x2c3c18], mossAmt: 0.45 },
  mist: marshMist,
  mistColor: 0xb49eb0,
};

const SNOW_NIGHT: EpicStyle = {
  near: { voxelSize: 0.25, space: 'world', seam: 0.16, bevel: 0.13, glint: 0.6 },
  outer: { voxelSize: 0.5, space: 'world', seam: 0.16, bevel: 0.13, glint: 0.55 },
  spec: [1.2, 0.7, 0.5, 0],
  streak: [0, 0.1, 2.5, 0.3],
  // bright snow: the lantern light plus the full baked pool burned out to white round every lamp post
  lamp: 0.4,
  bed: { stones: [0x2a3448, 0x1e2838, 0x3a465a, 0x161e2c], rate: 0.09, silt: 0x0e1622, siltAmt: 0.35 },
};

const TROPIC_DAY: EpicStyle = {
  near: { voxelSize: 0.25, space: 'world', seam: 0.15, bevel: 0.12, glint: 0.5 },
  outer: { voxelSize: 0.5, space: 'world', seam: 0.16, bevel: 0.12, glint: 0.45 },
  spec: [0.6, 0.5, 0.6, 0.12],
  streak: [0, 0.1, 3, 0.3],
  lamp: 1,
  damp: { w: 1.4, dark: 0.3, rough: 0.38 },
  bed: { stones: [0x5e605c, 0x7a766a, 0x4a4c48, 0x8c8676], rate: 0.045, silt: 0x2f7478, siltAmt: 0.22, ripple: 0.1 },
  wall: { stain: 0x5e5440, stainAmt: 0.22, moss: [0x4a7a2e, 0x3d6a26, 0x568a34], mossAmt: 0.3 },
};

/** The Epic style for a map (per-map tuning against the references; other maps by their atmosphere). */
export function epicStyle(map: MapDef): EpicStyle {
  const a = map.atmosphere;
  switch (map.id) {
    case 'lanternwharf':
      return NIGHT_RAIN;
    case 'mirelight':
      return DUSK_MARSH;
    case 'muckmire':
      // the owner's favourite normal look: Epic keeps its lawn and mud, a gentler damp and fewer banks of
      // mist, in its own (already light) fog colour
      return { ...DUSK_MARSH, near: { ...DUSK_MARSH.near, seam: 0.18 }, damp: { w: 1.4, dark: 0.22, rough: 0.34 }, spec: [1.2, 0.8, 0.7, 0.12], streak: [0, 0.12, 3.0, 0.45], lamp: 0.9, mistColor: undefined };
    case 'aurora':
      return SNOW_NIGHT;
    case 'maelstrom':
      return TROPIC_DAY;
  }
  if (a.weather === 'snow') return SNOW_NIGHT;
  if (a.weather === 'rain') return NIGHT_RAIN;
  if (a.timeOfDay === 'day') return TROPIC_DAY;
  // a clear night: the wet night look without rain puddles (no marsh mist or moss)
  if (a.timeOfDay === 'night') return { ...NIGHT_RAIN, puddles: undefined, streak: [0.4, 0.14, 4, 0.85] };
  return DUSK_MARSH;
}

/**
 * How much the voxel look calms its seams and bevels per top surface (by the column's side id): soft
 * ground (lawn, moss, sand, mud, snow) keeps a hint of the cube grid instead of reading as bathroom tiles;
 * cut stone, setts, planks, rock, ice and roofs keep the full bevels.
 */
const CALM: Partial<Record<number, number>> = {
  [SIDE.SOIL]: 0.85,
  [SIDE.SAND]: 0.8,
  [SIDE.BANK]: 0.6,
  // snow: bright, so even a faint seam reads as a tiled floor (Frostfang's whole field did at 0.55)
  [SIDE.SNOWROCK]: 0.85,
  // Aurora's snow-capped ice slabs and shelf blocks (biome-local side ids): a little more cube than snow
  21: 0.75,
  22: 0.7,
};

/** The parts of BaseBiome the wrapper reads (every map biome extends BaseBiome). */
interface Shape {
  channel(x: number, z: number): number;
  plazaDist(x: number, z: number): number;
  outside(x: number, z: number): number;
}

/**
 * Wrap a biome (or a deck-clamped view of one) with the Epic colour pass. `shape` is the map's own
 * biome (channel, plaza and edge distances). Heights, quanta and side ids pass through untouched.
 */
export function epicBiome(map: MapDef, config: MatchConfig, inner: Biome, shape: MapBiome, style: EpicStyle): Biome {
  const s = shape as unknown as Shape;
  const T = groundY(map);
  const B = bedY(map);
  const fullY = waterY(map, 1);
  const lowY = waterY(map, 0);
  const dry = config.riverMode === 'dry';
  const span = Math.max(0.5, fullY - B);
  const { damp, puddles, bed, wall } = style;

  function bedPass(x: number, z: number, ix: number, iz: number, cs: number, out: Cell): void {
    if (!bed || (out.glow ?? 0) > 0) return;
    const d01 = clamp01((fullY - out.h) / span);
    let col = out.top;
    // silt settles in the deep water, the shallows keep the biome's own colours
    col = mix(col, bed.silt, bed.siltAmt * smooth01((d01 - 0.25) / 0.75));
    if (bed.ripple) {
      // sand ripples across the current, broken up by a slow wobble
      const ph = (x * 0.9 + z * 0.43) * 5.2 + valueNoise2(x * 0.3, z * 0.3, 9101) * 6;
      col = shade(col, 1 + bed.ripple * Math.sin(ph) * (1 - d01 * 0.6));
    }
    if (cs < 0.5) {
      // stones lie in clumps on the bed
      const clump = 0.35 + 1.3 * valueNoise2(x * 0.35, z * 0.35, 9104);
      if (h01(ix, iz, 9103) < bed.rate * clump) {
        col = shade(bed.stones[Math.floor(h01(ix, iz, 9105) * bed.stones.length) % bed.stones.length], 0.85 + h01(ix, iz, 9106) * 0.3);
        out.rough = Math.min(out.rough, 0.55);
      }
    }
    out.top = col;
  }

  function landPass(x: number, z: number, ix: number, iz: number, cs: number, out: Cell): void {
    if (out.side === SIDE.BUILDING || out.side === SIDE.ROOF) return;
    const groundLevel = out.h < T + 0.2 && out.h > fullY;
    if (damp && !dry && out.h < fullY + 0.65) {
      const c = s.channel(x, z);
      const edge = (valueNoise2(x * 0.7, z * 0.7, 9107) - 0.5) * damp.w * 0.7;
      const t = smooth01((c + damp.w + edge) / damp.w);
      if (t > 0 && s.plazaDist(x, z) > 0.3) {
        out.top = shade(out.top, 1 - damp.dark * t);
        if (damp.rough < out.rough) out.rough = out.rough + (damp.rough - out.rough) * t;
      }
    }
    if (puddles && groundLevel && cs < 0.5 && out.rough > 0.1 && s.outside(x, z) < 6 && s.plazaDist(x, z) > 0.25) {
      if (out.side !== SIDE.STONE && out.side !== SIDE.SOIL && out.side !== SIDE.BANK && out.side !== SIDE.SAND && out.side !== SIDE.BRICK) return;
      if (channelDepthAt(map, x, z) > -0.4) return;
      const n = valueNoise2(x * 0.16, z * 0.16, 9108) * 0.65 + valueNoise2(x * 0.55, z * 0.55, 9109) * 0.35;
      const thr = 0.22 + puddles.cover * 0.3;
      if (n < thr) {
        // standing water: dark, mirror-flat, the night sky in it
        out.top = mix(shade(out.top, 0.5), puddles.sky, 0.35);
        out.rough = 0.04;
      } else if (n < thr + 0.035) {
        // the wet rim round it
        out.top = shade(out.top, 0.78);
        out.rough = Math.min(out.rough, 0.2);
      }
    }
  }

  return {
    base: inner.base,
    sample(x, z, ix, iz, cs, out) {
      inner.sample(x, z, ix, iz, cs, out);
      out.calm = CALM[out.side] ?? 0;
      if (out.h < fullY - 0.04) bedPass(x, z, ix, iz, cs, out);
      else landPass(x, z, ix, iz, cs, out);
    },
    sideColor(side, tag, ix, iy, iz, dir, y0, y1, top, cs, out: SideOut) {
      inner.sideColor(side, tag, ix, iy, iz, dir, y0, y1, top, cs, out);
      if (!wall || iy === -999 || side === SIDE.BUILDING || side === SIDE.ROOF || side === SIDE.ICE || side === SIDE.PLANK) return;
      const ym = (y0 + y1) * 0.5;
      if (ym > fullY + 0.6) return;
      if (ym < fullY + 0.04 && ym > lowY - 0.3) {
        // the band the river wets and dries: dark, a little green, glossier
        const k = wall.stainAmt * (0.65 + 0.35 * hashVox(ix, iy, iz, 9111)) * (0.55 + 0.45 * clamp01((ym - lowY) / Math.max(0.3, fullY - lowY)));
        out.color = mix(out.color, wall.stain, k);
        out.rough = Math.min(out.rough, 0.55);
      } else if (wall.moss && wall.mossAmt && ym >= fullY + 0.04 && top - y1 < 0.3 && hashVox(ix, iy, iz, 9112) < wall.mossAmt) {
        // moss creeping over the top courses of the bank wall
        out.color = shade(wall.moss[Math.floor(hashVox(ix, iy, iz, 9113) * wall.moss.length) % wall.moss.length], 0.8 + hashVox(ix, iy, iz, 9114) * 0.25);
      }
    },
  };
}

/**
 * Low mist banks for the marsh maps (ref04), where the gameplay camera sees past the play area: between
 * the cypress just outside the side edges, over the far bayou and the near marsh. Their centres stay
 * outside the play rectangle and their half width plus drift inside 1 m of it, so they never veil a fight.
 */
function marshMist(ctx: EpicCtx): MistDef[] {
  const out: MistDef[] = [];
  const { halfW, halfD, fullY, map } = ctx;
  const muck = map.id === 'muckmire';
  const n = muck ? 22 : 40;
  for (let i = 0; i < n; i++) {
    const r = (k: number) => hashVox(i, k, 7, 9120);
    const band = r(0);
    let x: number;
    let z: number;
    let w = 6 + r(5) * 8;
    if (band < 0.5) {
      // between the cypress beside the side edges, the whole length of the map
      const sx = r(3) < 0.5 ? -1 : 1;
      const out0 = 4 + r(1) * 14;
      x = sx * (halfW + out0);
      // the shader drifts each bank by up to a quarter of its width along x
      w = Math.min(w, ((out0 + 1) * 4) / 3);
      z = (r(2) - 0.5) * 2 * (halfD + 4);
    } else if (band < 0.8) {
      // the far bayou toward the sun, banks lying across it
      x = (r(1) - 0.5) * 60;
      z = -halfD - 4 - r(2) * 22;
    } else {
      // the near marsh
      x = (r(1) - 0.5) * 56;
      z = halfD + 5 + r(2) * 10;
    }
    out.push({
      x,
      y: fullY + 0.4 + r(4) * 0.5,
      z,
      w,
      h: 1.5 + r(6) * 1.1,
      drift: 0.2 + r(7) * 0.3,
      // dense enough to read against the dark forest and the dusk water at the gameplay camera
      opacity: (muck ? 0.18 : 0.3) + r(8) * (muck ? 0.1 : 0.2),
    });
  }
  return out;
}
