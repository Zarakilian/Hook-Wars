// Lantern lights (cinematic): real warm PointLights derived from the map itself.
//
// Every lamp-bearing obstacle kind (lamppost, gaslamp, lanternpost, stilthut, watchtower, crane,
// bridgepier) and decor kind (lantern, lanternstring) becomes a light source at the height and reach of
// its lantern, read from the prop builders (heights are approximate; props can report exact ones later
// with setLanternSources). Each frame the rig picks the nearest few sources to the camera focus and
// drives a fixed pool of shadowless PointLights at them, fading each one in and out as it enters and
// leaves the budget. The pool size never changes while cinematic is on, because the light count is part
// of every material's program: adding or removing a light would recompile the whole scene.
import * as THREE from 'three';
import type { MapDef, Obstacle } from '../../../shared/maps/types.ts';
import { groundY } from '../contracts.ts';

export interface LanternSource {
  x: number;
  y: number;
  z: number;
  /** linear colour */
  color: THREE.Color;
  /** peak intensity (candela) */
  intensity: number;
  /** cut-off distance in metres */
  range: number;
  /** per-source flicker phase */
  seed: number;
}

interface KindLamp {
  /** lantern height above the bank top (m) */
  h: number;
  /** reach toward the river along the prop's front (+Z after the face-the-river yaw), m; r-scaled part */
  reach: number;
  reachR: number;
  /** sideways offset (local +X), fixed and r-scaled parts */
  side: number;
  sideR: number;
  color: number;
  intensity: number;
  range: number;
}

// Heights and reaches from the prop builders (client/render/models/props/*): lantern cage centres.
const KINDS: Partial<Record<string, KindLamp>> = {
  lamppost: { h: 3.2, reach: 0, reachR: 0, side: 0, sideR: 0, color: 0xffb468, intensity: 13, range: 7 },
  gaslamp: { h: 2.15, reach: 0.5, reachR: 0, side: 0, sideR: 0, color: 0xffac5a, intensity: 10.5, range: 6.5 },
  lanternpost: { h: 1.95, reach: 0.57, reachR: 0, side: 0, sideR: 0, color: 0xffa64e, intensity: 9.5, range: 6 },
  stilthut: { h: 1.45, reach: 0.25, reachR: 0.72, side: 0.08, sideR: 0.72, color: 0xffa04a, intensity: 9, range: 6 },
  watchtower: { h: 3.3, reach: 0.2, reachR: 0.82, side: 0, sideR: 0.7, color: 0xffbe6a, intensity: 12, range: 7 },
  crane: { h: 2.9, reach: 0.1, reachR: 0.55, side: 0.16, sideR: 0.55, color: 0xffb060, intensity: 10.5, range: 6.5 },
  bridgepier: { h: 1.9, reach: 0, reachR: 0, side: 0, sideR: 0, color: 0xffb468, intensity: 7.5, range: 5.5 },
};
/** obstacle kinds whose front faces the river (same rule as the props module) */
const FACE_RIVER = new Set(['stilthut', 'lanternpost', 'crane', 'gaslamp', 'bridgepier', 'watchtower']);

function lampOf(o: Obstacle, base: number, out: LanternSource[]): void {
  const k = KINDS[o.kind];
  if (!k) return;
  let x: number;
  let z: number;
  let r: number;
  let yaw: number;
  if (o.shape === 'circle') {
    x = o.x;
    z = o.z;
    r = o.r;
    const seed = o.seed ?? 1;
    yaw = FACE_RIVER.has(o.kind) ? Math.atan2(-Math.sign(o.x || 1), 0) : (o.rot ?? 0) + ((seed * 2.399) % (Math.PI * 2));
  } else {
    x = (o.ax + o.bx) / 2;
    z = (o.az + o.bz) / 2;
    r = o.r;
    yaw = Math.atan2(o.bx - o.ax, o.bz - o.az);
  }
  const fwd = k.reach + k.reachR * r;
  const side = k.side + k.sideR * r;
  // local +Z (front) -> world (sin yaw, cos yaw); local +X -> (cos yaw, -sin yaw)
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const sc = o.shape === 'circle' ? (o.scale ?? 1) : 1;
  out.push({
    x: x + s * fwd + c * side,
    y: base + k.h * sc,
    z: z + c * fwd - s * side,
    color: new THREE.Color(k.color),
    intensity: k.intensity,
    range: k.range,
    seed: (o.seed ?? 1) * 1.37 + x * 0.11 + z * 0.07,
  });
}

/** Light sources a map's own props and decor imply. */
export function lanternSources(map: MapDef): LanternSource[] {
  const out: LanternSource[] = [];
  const base = groundY(map);
  for (const o of map.obstacles) lampOf(o, base, out);
  for (const d of map.decor) {
    if (d.kind === 'lantern') {
      out.push({ x: d.x, y: base + 1.48 * d.scale, z: d.z, color: new THREE.Color(0xffae5c), intensity: 7.5, range: 5.5, seed: d.seed * 0.71 });
    } else if (d.kind === 'lanternstring') {
      out.push({ x: d.x, y: base + 1.8, z: d.z, color: new THREE.Color(0xffb862), intensity: 9, range: 6.5, seed: d.seed * 0.53 });
    }
  }
  return out;
}

const _v = new THREE.Vector3();

export const MAX_LANTERN_UNIFORMS = 16;

/**
 * The live lantern pool for materials that light themselves (the water ShaderMaterial, custom glows):
 * PointLights only reach three.js lit materials. The engine fills these every frame while cinematic is
 * on (position xyz + range w, colour * intensity, count); while it is off count stays 0 and nothing
 * here costs anything. Share the objects: shader.uniforms.hwLanternPos = LANTERN_UNIFORMS.hwLanternPos.
 */
export const LANTERN_UNIFORMS = {
  hwLanternPos: { value: Array.from({ length: MAX_LANTERN_UNIFORMS }, () => new THREE.Vector4(0, -1000, 0, 1)) },
  hwLanternCol: { value: Array.from({ length: MAX_LANTERN_UNIFORMS }, () => new THREE.Vector3()) },
  hwLanternCount: { value: 0 },
};

/**
 * GLSL for LANTERN_UNIFORMS: warm reflections and glow from the pooled lanterns at a surface point.
 * hwLanternSpec(worldPos, worldNormal, toCameraDir, shininess) returns linear radiance to add, e.g. on
 * wet water: col += hwLanternSpec(vWorld, n, normalize(cameraPosition - vWorld), 180.0);
 * hwLanternLight(worldPos) is the unshadowed light reaching a point (no normal), for particles: the
 * cinematic rain and snow use it so streaks and flakes catch the lantern light.
 */
export const LANTERN_GLSL = /* glsl */ `
uniform vec4 hwLanternPos[${MAX_LANTERN_UNIFORMS}];
uniform vec3 hwLanternCol[${MAX_LANTERN_UNIFORMS}];
uniform int hwLanternCount;
vec3 hwLanternSpec(vec3 p, vec3 n, vec3 v, float shininess) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_LANTERN_UNIFORMS}; i++) {
    if (i >= hwLanternCount) break;
    vec3 d = hwLanternPos[i].xyz - p;
    float dist = length(d);
    vec3 l = d / max(dist, 1e-3);
    float range = hwLanternPos[i].w;
    float fall = pow(clamp(1.0 - pow(dist / (range * 1.6), 4.0), 0.0, 1.0), 2.0) / max(dist * dist, 0.25);
    float spec = pow(max(dot(n, normalize(l + v)), 0.0), shininess) * (shininess + 8.0) * 0.04;
    acc += hwLanternCol[i] * (spec * fall);
  }
  return acc;
}
// unshadowed light arriving at a point from the pooled lanterns (no normal): rain, snow, motes, mist
vec3 hwLanternLight(vec3 p) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_LANTERN_UNIFORMS}; i++) {
    if (i >= hwLanternCount) break;
    vec3 d = hwLanternPos[i].xyz - p;
    float d2 = dot(d, d);
    float r = hwLanternPos[i].w * 1.15;
    float f = clamp(1.0 - d2 / (r * r), 0.0, 1.0);
    acc += hwLanternCol[i] * (f * f / max(d2, 0.6));
  }
  return acc;
}
`;

/**
 * A fixed pool of shadowless warm PointLights that follows the camera focus through the map's lanterns.
 * The lights live in `group` (add it to the scene once); their count is `budget` for the rig's life.
 */
export class LanternRig {
  readonly group = new THREE.Group();
  readonly lights: THREE.PointLight[] = [];
  private sources: LanternSource[] = [];
  /** current fade 0..1 per source */
  private fade = new Float32Array(0);
  /** source index per light (-1 = free) */
  private slot: Int32Array;
  private readonly want = new Set<number>();
  private readonly order: number[] = [];
  /** global multiplier (per map) */
  strength = 1;
  /**
   * how many of the pool's lights are used (the rest stay dark). The pool size is quantised across
   * maps (fewer program variants); this is the map's own budget within it.
   */
  active = Number.POSITIVE_INFINITY;
  /** fade speed (1/s) */
  fadeRate = 2.5;
  private snap = true;

  constructor(budget: number) {
    this.group.name = 'HW.LanternRig';
    this.slot = new Int32Array(budget).fill(-1);
    for (let i = 0; i < budget; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 8, 2);
      l.name = 'HW.Lantern' + i;
      l.castShadow = false;
      l.layers.enableAll();
      l.position.set(0, -1000, 0);
      this.lights.push(l);
      this.group.add(l);
    }
  }

  get budget(): number {
    return this.lights.length;
  }

  get sourceCount(): number {
    return this.sources.length;
  }

  setSources(list: LanternSource[]): void {
    this.sources = list;
    this.fade = new Float32Array(list.length);
    this.slot.fill(-1);
    // a new map starts with the nearest lanterns already lit (no fade-in at the first frame)
    this.snap = true;
    for (const l of this.lights) {
      l.intensity = 0;
      l.position.set(0, -1000, 0);
    }
  }

  /** Pick the nearest sources to the focus, fade, and place the pool's lights. */
  update(dt: number, time: number, focusX: number, focusZ: number): void {
    const n = this.sources.length;
    const budget = this.lights.length;
    if (budget === 0) return;
    // nearest `budget` sources to the focus (with a little hysteresis for the ones already lit)
    const order = this.order;
    order.length = 0;
    for (let i = 0; i < n; i++) order.push(i);
    const src = this.sources;
    const score = (i: number) => {
      const s = src[i];
      const d = (s.x - focusX) * (s.x - focusX) + (s.z - focusZ) * (s.z - focusZ);
      return this.fade[i] > 0 ? d * 0.8 : d;
    };
    order.sort((a, b) => score(a) - score(b));
    this.want.clear();
    for (let k = 0; k < Math.min(budget, this.active, n); k++) this.want.add(order[k]);
    const step = this.snap ? 1 : Math.min(1, dt * this.fadeRate);
    // fade every source that holds a light
    for (let li = 0; li < budget; li++) {
      const si = this.slot[li];
      if (si < 0) continue;
      const target = this.want.has(si) ? 1 : 0;
      this.fade[si] += Math.sign(target - this.fade[si]) * Math.min(step, Math.abs(target - this.fade[si]));
      if (this.fade[si] <= 0 && target === 0) this.slot[li] = -1;
    }
    // give free lights to wanted sources that have none
    for (const si of this.want) {
      let has = false;
      for (let li = 0; li < budget; li++) if (this.slot[li] === si) has = true;
      if (has) continue;
      for (let li = 0; li < budget; li++) {
        if (this.slot[li] < 0) {
          this.slot[li] = si;
          this.fade[si] = this.snap ? 1 : 0;
          break;
        }
      }
    }
    this.snap = false;
    for (let li = 0; li < budget; li++) {
      const l = this.lights[li];
      const si = this.slot[li];
      if (si < 0) {
        l.intensity = 0;
        continue;
      }
      const s = src[si];
      const f = this.fade[si];
      const e = f * f * (3 - 2 * f);
      // a slow candle flicker
      const fl = 1 + 0.06 * Math.sin(time * 7.3 + s.seed * 13.1) + 0.04 * Math.sin(time * 17.9 + s.seed * 5.3);
      l.position.set(s.x, s.y, s.z);
      l.color.copy(s.color);
      l.intensity = s.intensity * this.strength * e * fl;
      l.distance = s.range;
    }
  }

  /** world positions (xyz, w = range) and colour * intensity of the pool, for the mist glow. */
  fill(pos: THREE.Vector4[], col: THREE.Vector3[]): number {
    let k = 0;
    for (let li = 0; li < this.lights.length && k < pos.length; li++) {
      const l = this.lights[li];
      if (l.intensity <= 1e-3) continue;
      _v.copy(l.position);
      pos[k].set(_v.x, _v.y, _v.z, l.distance);
      col[k].set(l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity);
      k++;
    }
    for (let j = k; j < pos.length; j++) {
      pos[j].set(0, -1000, 0, 1);
      col[j].set(0, 0, 0);
    }
    return k;
  }

  dispose(): void {
    for (const l of this.lights) l.dispose();
    this.group.clear();
  }
}
