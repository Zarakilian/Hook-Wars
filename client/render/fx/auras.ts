// Buff auras drawn under and around units from their UFlag bits:
//   Haste (Tailwind)        lime wind spirals on the ground, rising wisps, speed lines when running
//   DoubleDmg (Kraken Ink)  a purple ink pool with a slow tentacle swirl, ink drips, purple bubbles
//   Shield (Barnacle Hide)  a steel-blue shimmering barnacle bubble with sparkles (RUNE_COLORS.ironskin)
//   Burning                 embers and a little smoke rising, a warm glow underfoot
//   Bendy / Bouncy / Longshot  a small coloured ring in the rune colour, and motes
// GameClient calls aura() every frame per visible unit. A unit with no buff bits and no live state
// costs one Map lookup. States are pooled; a unit not refreshed for a few frames fades out.
// Ground decals are one instanced draw, shield bubbles another; motes use the shared sprite batch.
import * as THREE from 'three';
import { RUNE_COLORS } from '../../../shared/constants.ts';
import { UFlag, type Team } from '../../../shared/types.ts';
import type { Quality } from '../contracts.ts';
import { PF, Shape, type SpriteBatch } from './particles.ts';

/** Buff slots, in draw order. */
const B_HASTE = 0;
const B_INK = 1;
const B_SHIELD = 2;
const B_BURN = 3;
const B_BENDY = 4;
const B_BOUNCY = 5;
const B_LONG = 6;
const NB = 7;
const BITS = [UFlag.Haste, UFlag.DoubleDmg, UFlag.Shield, UFlag.Burning, UFlag.Bendy, UFlag.Bouncy, UFlag.Longshot] as const;
export const AURA_MASK = BITS.reduce((a, b) => a | b, 0);

/** decal kinds in the shader */
const K_WIND = 0;
const K_INK = 1;
const K_RING_BENDY = 2;
const K_RING_BOUNCY = 3;
const K_RING_LONG = 4;
const K_BURN = 5;

const DECAL_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iParam; // size, kind, alpha, phase
attribute vec3 iCol;
attribute vec3 iCol2;
varying vec2 vUv;
varying vec4 vParam;
varying vec3 vCol;
varying vec3 vCol2;
void main() {
  vUv = position.xy * 2.0;
  vParam = iParam;
  vCol = iCol;
  vCol2 = iCol2;
  vec3 p = iPos + vec3(position.x, 0.0, -position.y) * iParam.x * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const DECAL_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec4 vParam;
varying vec3 vCol;
varying vec3 vCol2;
const float TAU = 6.2831853;
void main() {
  float kind = vParam.y;
  float alpha = vParam.z;
  float t = uTime + vParam.w * 7.0;
  float r = length(vUv);
  if (r > 1.0) discard;
  float ang = atan(vUv.y, vUv.x) / TAU + 0.5;
  vec3 col = vCol;
  float a = 0.0;
  float blend = 0.0; // 0 additive, 1 normal alpha
  if (kind < 0.5) {
    // wind: three spiral gusts sweeping round
    float f = fract(ang * 3.0 + r * 1.3 - t * 0.9);
    float band = smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.12, 0.5, f));
    float mask = smoothstep(0.22, 0.45, r) * (1.0 - smoothstep(0.8, 1.0, r));
    a = band * mask * 1.25;
    col = mix(vCol, vCol2, (1.0 - smoothstep(0.0, 0.2, f)) * 0.8 + 0.2);
    blend = 0.45;
  } else if (kind < 1.5) {
    // kraken ink: a dark pool, glowing rim, four curling tentacles turning slowly
    float pool = (1.0 - smoothstep(0.5, 0.82, r));
    float f = fract(ang * 4.0 + r * r * 1.7 - t * 0.18);
    float w = 0.17 * (1.0 - r * 0.85);
    float arm = (1.0 - smoothstep(w * 0.5, w, abs(f - 0.5))) * smoothstep(0.2, 0.35, r) * (1.0 - smoothstep(0.86, 1.0, r));
    float rim = exp(-pow((r - 0.78) / 0.05, 2.0));
    // suckers: little dots along each arm
    float sk = step(0.6, fract(r * 9.0 - t * 0.3)) * arm * step(abs(f - 0.5), w * 0.3);
    vec3 dark = vCol2 * 0.25;
    col = mix(dark, vCol * 1.6, max(arm * 0.85, rim)) + vec3(0.9, 0.7, 1.0) * sk * 0.6;
    a = max(pool * 0.55, max(arm, rim * 0.9));
    blend = 1.0 - max(arm, rim) * 0.6;
  } else if (kind < 4.5) {
    float rr = r;
    float ring;
    if (kind < 2.5) {
      // bendy: a wavy ring, like a swimming eel
      rr = r + sin(ang * TAU * 5.0 + t * 5.0) * 0.05;
      ring = exp(-pow((rr - 0.78) / 0.075, 2.0));
    } else if (kind < 3.5) {
      // bouncy: the ring springs in and out, with six bouncing beads on it
      float b = abs(sin(t * 5.5));
      float R = 0.7 + 0.12 * b;
      ring = exp(-pow((r - R) / 0.065, 2.0));
      float da = fract(ang * 6.0) - 0.5;
      float bead = exp(-(da * da) * 90.0) * exp(-pow((r - R - 0.05 * b) / 0.08, 2.0));
      ring = max(ring, bead * 1.4);
    } else {
      // longshot: a ring with eight chevrons pointing out, turning
      ring = exp(-pow((r - 0.72) / 0.065, 2.0));
      float da = fract(ang * 8.0 - t * 0.25) - 0.5;
      float chev = 1.0 - smoothstep(0.03, 0.07, abs(abs(da) * 0.9 - (0.96 - r) * 0.55));
      chev *= step(0.8, r) * (1.0 - smoothstep(0.94, 1.0, r));
      ring = max(ring, chev);
    }
    a = min(1.0, ring * 1.2);
    col = mix(vCol, vCol2, ring * 0.5);
    blend = 0.4;
  } else {
    // burning: a flickering warm glow underfoot
    float fl = 0.75 + 0.25 * sin(t * 13.0) * sin(t * 7.3);
    a = exp(-r * r * 3.5) * 0.75 * fl;
    blend = 0.2;
    col = mix(vCol, vCol2, exp(-r * r * 9.0));
  }
  a *= alpha;
  gl_FragColor = vec4(col * a, a * blend);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const BUBBLE_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iParam; // alpha, phase
varying vec3 vN;
varying vec3 vV;
varying vec3 vL;
varying vec2 vParam;
void main() {
  vParam = iParam;
  vL = position;
  vec3 p = iPos + position * vec3(1.15, 1.1, 1.15);
  vec4 wp = vec4(p, 1.0);
  vN = normalize(normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BUBBLE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uGold;
uniform vec3 uHot;
varying vec3 vN;
varying vec3 vV;
varying vec3 vL;
varying vec2 vParam;
void main() {
  float t = uTime + vParam.y * 9.0;
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
  // barnacle cells: a hex-ish lattice from two sine grids, drifting slowly
  vec2 q = vec2(atan(vL.z, vL.x) * 2.2, vL.y * 3.4 + t * 0.15);
  float cell = abs(sin(q.x * 3.1) * sin(q.y * 3.1 + q.x * 1.55));
  float lines = smoothstep(0.12, 0.0, cell);
  // a shimmer band sweeping up the bubble
  float sweep = exp(-pow(fract(vL.y * 0.45 - t * 0.55) - 0.5, 2.0) * 60.0);
  float a = (fres * 0.85 + lines * 0.22 + sweep * 0.35 * (0.3 + fres)) * vParam.x;
  vec3 col = mix(uGold, uHot, sweep * 0.7 + fres * 0.3);
  gl_FragColor = vec4(col * a, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RINGS: readonly (readonly [number, number, 'bendy' | 'bouncy' | 'longshot', number])[] = [
  [B_BENDY, K_RING_BENDY, 'bendy', 0.78],
  [B_BOUNCY, K_RING_BOUNCY, 'bouncy', 0.72],
  [B_LONG, K_RING_LONG, 'longshot', 0.86],
];

interface AuraState {
  id: number;
  x: number;
  y: number;
  z: number;
  lx: number;
  lz: number;
  vx: number;
  vz: number;
  team: Team;
  flags: number;
  seen: number;
  phase: number;
  k: Float32Array;
  acc: Float32Array;
}

const MAX_DECALS = 96;
const MAX_BUBBLES = 16;

export class AuraSystem {
  readonly group = new THREE.Group();
  private readonly sprites: SpriteBatch;
  private readonly states = new Map<number, AuraState>();
  private readonly free: AuraState[] = [];
  private frame = 0;
  private readonly rate: number;
  // decals
  private readonly dPos: Float32Array;
  private readonly dParam: Float32Array;
  private readonly dCol: Float32Array;
  private readonly dCol2: Float32Array;
  private readonly dAttrs: THREE.InstancedBufferAttribute[];
  private readonly dGeo: THREE.InstancedBufferGeometry;
  private readonly dMat: THREE.ShaderMaterial;
  private readonly decals: THREE.Mesh;
  private nDecals = 0;
  // bubbles
  private readonly bPos: Float32Array;
  private readonly bParam: Float32Array;
  private readonly bAttrs: THREE.InstancedBufferAttribute[];
  private readonly bGeo: THREE.InstancedBufferGeometry;
  private readonly bMat: THREE.ShaderMaterial;
  private readonly bubbles: THREE.Mesh;
  private nBubbles = 0;
  private readonly tmpC = new THREE.Color();
  // emission context for the state being drawn (no per-frame closures)
  private cur: AuraState | null = null;
  private curRate = 0;
  private curBusy = 0;
  private readonly emitFn = (i: number, perSec: number): number => {
    const st = this.cur!;
    st.acc[i] += perSec * this.curRate * st.k[i];
    const n = Math.floor(st.acc[i]);
    st.acc[i] -= n;
    return this.curBusy > 0.82 ? 0 : n;
  };

  constructor(sprites: SpriteBatch, quality: Quality) {
    this.sprites = sprites;
    this.rate = quality === 'low' ? 0.45 : quality === 'medium' ? 0.75 : quality === 'high' ? 1 : 1.3;
    this.group.name = 'fx-auras';
    // ground decals
    this.dPos = new Float32Array(MAX_DECALS * 3);
    this.dParam = new Float32Array(MAX_DECALS * 4);
    this.dCol = new Float32Array(MAX_DECALS * 3);
    this.dCol2 = new Float32Array(MAX_DECALS * 3);
    const quad = new THREE.PlaneGeometry(1, 1);
    const dg = new THREE.InstancedBufferGeometry();
    dg.index = quad.index;
    dg.setAttribute('position', quad.getAttribute('position'));
    const mk = (geo: THREE.InstancedBufferGeometry, arr: Float32Array, size: number, name: string) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.dAttrs = [mk(dg, this.dPos, 3, 'iPos'), mk(dg, this.dParam, 4, 'iParam'), mk(dg, this.dCol, 3, 'iCol'), mk(dg, this.dCol2, 3, 'iCol2')];
    dg.instanceCount = 0;
    this.dGeo = dg;
    const blendOpts = {
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    } as const;
    this.dMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      ...blendOpts,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.decals = new THREE.Mesh(dg, this.dMat);
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 19;
    this.decals.name = 'fx-aura-decals';
    // shield bubbles
    this.bPos = new Float32Array(MAX_BUBBLES * 3);
    this.bParam = new Float32Array(MAX_BUBBLES * 2);
    const sphere = new THREE.IcosahedronGeometry(1, quality === 'low' ? 1 : 2);
    const bg = new THREE.InstancedBufferGeometry();
    bg.index = sphere.index;
    bg.setAttribute('position', sphere.getAttribute('position'));
    bg.setAttribute('normal', sphere.getAttribute('normal'));
    this.bAttrs = [mk(bg, this.bPos, 3, 'iPos'), mk(bg, this.bParam, 2, 'iParam')];
    bg.instanceCount = 0;
    this.bGeo = bg;
    this.bMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uGold: { value: new THREE.Color(RUNE_COLORS.ironskin.main).multiplyScalar(1.6) }, uHot: { value: new THREE.Color(RUNE_COLORS.ironskin.light).multiplyScalar(2.2) } },
      vertexShader: BUBBLE_VERT,
      fragmentShader: BUBBLE_FRAG,
      ...blendOpts,
      side: THREE.DoubleSide,
    });
    this.bubbles = new THREE.Mesh(bg, this.bMat);
    this.bubbles.frustumCulled = false;
    this.bubbles.renderOrder = 22;
    this.bubbles.name = 'fx-aura-shields';
    this.group.add(this.decals, this.bubbles);
  }

  /** Per unit per frame. p is only read (x, y, z), never stored. */
  aura(id: number, p: { x: number; y: number; z: number }, flags: number, team: Team): void {
    const f = flags & AURA_MASK;
    let st = this.states.get(id);
    if (!st) {
      if (!f) return;
      st = this.free.pop() ?? { id, x: 0, y: 0, z: 0, lx: 0, lz: 0, vx: 0, vz: 0, team: 0, flags: 0, seen: 0, phase: 0, k: new Float32Array(NB), acc: new Float32Array(NB) };
      st.id = id;
      st.k.fill(0);
      st.acc.fill(0);
      st.x = st.lx = p.x;
      st.z = st.lz = p.z;
      st.vx = st.vz = 0;
      st.phase = Math.random();
      this.states.set(id, st);
    }
    st.x = p.x;
    st.y = p.y;
    st.z = p.z;
    st.team = team;
    st.flags = f;
    st.seen = this.frame;
  }

  get count(): number {
    return this.states.size;
  }

  update(dt: number, time: number): void {
    this.frame++;
    this.nDecals = 0;
    this.nBubbles = 0;
    this.dMat.uniforms.uTime.value = time;
    this.bMat.uniforms.uTime.value = time;
    if (this.states.size === 0) {
      this.dGeo.instanceCount = 0;
      this.bGeo.instanceCount = 0;
      return;
    }
    const up = 1 - Math.exp(-dt * 7);
    const down = 1 - Math.exp(-dt * 3.5);
    for (const st of this.states.values()) {
      if (this.frame - st.seen > 3) st.flags = 0;
      // velocity estimate for speed lines (smoothed)
      if (dt > 0) {
        const ivx = (st.x - st.lx) / dt;
        const ivz = (st.z - st.lz) / dt;
        const ok = ivx * ivx + ivz * ivz < 400;
        st.vx += ((ok ? ivx : 0) - st.vx) * 0.3;
        st.vz += ((ok ? ivz : 0) - st.vz) * 0.3;
      }
      st.lx = st.x;
      st.lz = st.z;
      let any = false;
      for (let i = 0; i < NB; i++) {
        const target = st.flags & BITS[i] ? 1 : 0;
        st.k[i] += (target - st.k[i]) * (target > st.k[i] ? up : down);
        if (st.k[i] < 0.005 && !target) st.k[i] = 0;
        if (st.k[i] > 0) any = true;
      }
      if (!any && !st.flags) {
        this.states.delete(st.id);
        this.free.push(st);
        continue;
      }
      this.draw(st, dt, time);
    }
    this.dGeo.instanceCount = this.nDecals;
    this.bGeo.instanceCount = this.nBubbles;
    for (const a of this.dAttrs) {
      a.clearUpdateRanges();
      if (this.nDecals > 0) {
        a.addUpdateRange(0, this.nDecals * a.itemSize);
        a.needsUpdate = true;
      }
    }
    for (const a of this.bAttrs) {
      a.clearUpdateRanges();
      if (this.nBubbles > 0) {
        a.addUpdateRange(0, this.nBubbles * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  private decal(x: number, y: number, z: number, size: number, kind: number, alpha: number, phase: number, c1: number, c2: number, k1 = 1, k2 = 1): void {
    if (this.nDecals >= MAX_DECALS || alpha <= 0.003) return;
    const i = this.nDecals++;
    this.dPos[i * 3] = x;
    this.dPos[i * 3 + 1] = y;
    this.dPos[i * 3 + 2] = z;
    this.dParam[i * 4] = size;
    this.dParam[i * 4 + 1] = kind;
    this.dParam[i * 4 + 2] = alpha;
    this.dParam[i * 4 + 3] = phase;
    this.tmpC.setHex(c1).multiplyScalar(k1);
    this.dCol[i * 3] = this.tmpC.r;
    this.dCol[i * 3 + 1] = this.tmpC.g;
    this.dCol[i * 3 + 2] = this.tmpC.b;
    this.tmpC.setHex(c2).multiplyScalar(k2);
    this.dCol2[i * 3] = this.tmpC.r;
    this.dCol2[i * 3 + 1] = this.tmpC.g;
    this.dCol2[i * 3 + 2] = this.tmpC.b;
  }

  private draw(st: AuraState, dt: number, time: number): void {
    const { x, y, z } = st;
    const k = st.k;
    const sp = this.sprites;
    const busy = sp.load();
    const g = y + 0.06;
    this.cur = st;
    this.curRate = this.rate * dt;
    this.curBusy = busy;
    const emit = this.emitFn;
    const speed = Math.hypot(st.vx, st.vz);

    // ---- Tailwind (Haste)
    if (k[B_HASTE] > 0) {
      const c = RUNE_COLORS.haste;
      this.decal(x, g, z, 1.25, K_WIND, k[B_HASTE] * 0.95, st.phase, c.main, c.light, 1.6, 2.2);
      for (let n = emit(B_HASTE, 26); n > 0; n--) {
        const s = sp.begin(Shape.Glow);
        s.flags = PF.Orbit;
        s.ocx = x;
        s.ocz = z;
        s.orad = 0.55 + Math.random() * 0.4;
        s.orv = 0.25;
        s.oang = Math.random() * Math.PI * 2;
        s.ow = 7;
        s.pos(x, y + 0.15 + Math.random() * 0.4, z).vel(0, 1.4 + Math.random() * 1.2, 0);
        s.color(Math.random() < 0.4 ? c.light : c.main, 2.4).colorEnd(c.dark, 1.2).size(0.2, 0.05);
        s.life = 0.55 + Math.random() * 0.25;
        s.fin = 0.1;
        s.fpow = 0.8;
        sp.emit(s);
      }
      if (speed > 1.5) {
        for (let n = emit(B_HASTE, 18); n > 0; n--) {
          const sx = -st.vx / speed;
          const sz = -st.vz / speed;
          const side = (Math.random() - 0.5) * 1.1;
          const s = sp.begin(Shape.Spark);
          s.flags = PF.Stretch;
          s.stretch = 0.07;
          s.pos(x - sz * side - sx * 0.3, y + 0.3 + Math.random() * 1.0, z + sx * side - sz * 0.3).vel(sx * 9, 0, sz * 9);
          s.color(c.light, 2).colorEnd(c.main, 1).size(0.07, 0.03);
          s.life = 0.2 + Math.random() * 0.1;
          s.drag = 5;
          sp.emit(s);
        }
      }
    }

    // ---- Kraken Ink (DoubleDmg)
    if (k[B_INK] > 0) {
      const c = RUNE_COLORS.double;
      this.decal(x, g + 0.005, z, 1.15, K_INK, k[B_INK], st.phase, c.main, c.dark, 1.5, 1);
      for (let n = emit(B_INK, 9); n > 0; n--) {
        // ink drips sliding off the body and hands
        const a = Math.random() * Math.PI * 2;
        const r = 0.45 + Math.random() * 0.35;
        const s = sp.begin(Shape.Drop);
        s.pos(x + Math.cos(a) * r, y + 0.7 + Math.random() * 0.7, z + Math.sin(a) * r).vel(Math.cos(a) * 0.3, -0.4, Math.sin(a) * 0.3);
        s.color(Math.random() < 0.5 ? c.dark : 0x4a1e8a).size(0.13 + Math.random() * 0.06, 0.08);
        s.blend = 1;
        s.alpha = 0.95;
        s.grav = -9;
        s.floorY = y + 0.03;
        s.flags = PF.FloorKill;
        s.life = 1.2;
        s.fin = 0.03;
        s.fpow = 0.3;
        sp.emit(s);
      }
      for (let n = emit(B_INK, 7); n > 0; n--) {
        const s = sp.begin(Math.random() < 0.6 ? Shape.Bubble : Shape.Glow);
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.7;
        s.pos(x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r).vel(0, 0.5 + Math.random() * 0.6, 0);
        s.color(Math.random() < 0.5 ? c.light : c.main, 1.8).size(0.12 + Math.random() * 0.1, 0.18);
        s.life = 0.7 + Math.random() * 0.4;
        s.wobble = 1.2;
        s.wobbleF = 7;
        s.fin = 0.1;
        sp.emit(s);
      }
    }

    // ---- Barnacle Hide (Shield): steel-blue shimmer bubble
    if (k[B_SHIELD] > 0 && this.nBubbles < MAX_BUBBLES) {
      const i = this.nBubbles++;
      this.bPos[i * 3] = x;
      this.bPos[i * 3 + 1] = y + 0.95;
      this.bPos[i * 3 + 2] = z;
      this.bParam[i * 2] = k[B_SHIELD] * (0.85 + 0.15 * Math.sin(time * 9 + st.phase * 6));
      this.bParam[i * 2 + 1] = st.phase;
      for (let n = emit(B_SHIELD, 8); n > 0; n--) {
        const a = Math.random() * Math.PI * 2;
        const v = Math.random() * 0.9 + 0.1;
        const s = sp.begin(Shape.Star);
        s.pos(x + Math.cos(a) * 1.1 * Math.sqrt(1 - v * v * 0.6), y + 0.95 + (v - 0.4) * 1.1, z + Math.sin(a) * 1.1 * Math.sqrt(1 - v * v * 0.6));
        s.color(Math.random() < 0.5 ? RUNE_COLORS.ironskin.light : 0xffffff, 2.6).size(0.26, 0.04);
        s.life = 0.45;
        s.rotV = 3;
        s.fin = 0.2;
        sp.emit(s);
      }
    }

    // ---- Burning: embers and a wisp of smoke
    if (k[B_BURN] > 0) {
      this.decal(x, g + 0.01, z, 0.95, K_BURN, k[B_BURN], st.phase, 0xff5a10, 0xffc040, 1.6, 2.2);
      for (let n = emit(B_BURN, 28); n > 0; n--) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.6;
        const s = sp.begin(Shape.Glow);
        s.pos(x + Math.cos(a) * r, y + 0.3 + Math.random() * 1.0, z + Math.sin(a) * r).vel((Math.random() - 0.5) * 0.6, 1.2 + Math.random() * 1.6, (Math.random() - 0.5) * 0.6);
        s.color(Math.random() < 0.3 ? 0xffe07a : 0xff7a1e, 3).colorEnd(0xb0200a, 1.1).size(0.15 + Math.random() * 0.1, 0.03);
        s.life = 0.45 + Math.random() * 0.4;
        s.wobble = 1.6;
        s.wobbleF = 10;
        s.drag = 0.8;
        s.fin = 0.03;
        sp.emit(s);
      }
      for (let n = emit(B_BURN, 3); n > 0; n--) {
        const s = sp.begin(Shape.Puff);
        s.pos(x + (Math.random() - 0.5) * 0.5, y + 1.3, z + (Math.random() - 0.5) * 0.5).vel((Math.random() - 0.5) * 0.3, 0.9, (Math.random() - 0.5) * 0.3);
        s.color(0x3a3230).size(0.4, 1.1);
        s.blend = 1;
        s.alpha = 0.35;
        s.life = 1;
        s.fin = 0.2;
        sp.emit(s);
      }
    }

    // ---- hook power-ups: a small ring in the rune colour, and motes
    let ringN = 0;
    for (const [bi, kind, rune, size] of RINGS) {
      if (k[bi] <= 0) continue;
      const c = RUNE_COLORS[rune];
      this.decal(x, g + 0.015 + ringN * 0.004, z, size + ringN * 0.16, kind, k[bi], st.phase + ringN, c.main, c.light, 2, 2.4);
      ringN++;
      for (let n = emit(bi, 7); n > 0; n--) {
        const s = sp.begin(rune === 'bouncy' ? Shape.Star : Shape.Glow);
        const a = Math.random() * Math.PI * 2;
        s.flags = PF.Orbit;
        s.ocx = x;
        s.ocz = z;
        s.orad = size * (0.9 + Math.random() * 0.25);
        s.oang = a;
        s.ow = rune === 'longshot' ? 3 : rune === 'bendy' ? -2.4 : 1.6;
        s.pos(x, y + 0.1, z).vel(0, 0.7 + Math.random() * 0.6, 0);
        s.color(Math.random() < 0.4 ? c.light : c.main, 2.4).size(rune === 'bouncy' ? 0.22 : 0.16, 0.04);
        if (rune === 'bouncy') {
          s.grav = -3;
          s.vy = 2;
          s.rotV = 5;
        }
        s.life = 0.7 + Math.random() * 0.3;
        s.fin = 0.1;
        sp.emit(s);
      }
    }
  }

  /** compile the shaders now (rendered once at near-zero size) */
  warm(x: number, y: number, z: number): void {
    this.decal(x, y, z, 1e-4, K_WIND, 1, 0, 0xffffff, 0xffffff);
    this.dGeo.instanceCount = this.nDecals;
    for (const a of this.dAttrs) a.needsUpdate = true;
    this.bPos[0] = x;
    this.bPos[1] = y;
    this.bPos[2] = z;
    this.bParam[0] = 0;
    this.bGeo.instanceCount = 1;
    for (const a of this.bAttrs) a.needsUpdate = true;
  }

  dispose(): void {
    this.dGeo.dispose();
    this.dMat.dispose();
    this.bGeo.dispose();
    this.bMat.dispose();
    this.states.clear();
    this.free.length = 0;
  }
}
