// Pooled, GPU-friendly particle batches shared by every effect.
//
//  SpriteBatch  one instanced quad draw for every billboard particle. Shapes are procedural in the
//               fragment shader (glow, spark streak, smoke puff, ring, star, droplet, bubble, leaf,
//               shard, scorch, slash arc, light pillar). Premultiplied blending lets additive and
//               alpha particles share the draw: blend 0 = additive, 1 = normal alpha.
//  CubeBatch    lit voxel cubes (debris, juice bits, corpse chunks, ice shards) with ground bounce,
//               tumble, settle and shrink-out. Per-instance glow drives the emissive term.
//  LightPool    a fixed set of point lights (never added or removed at runtime, so no shader
//               recompiles) used for impact flashes.
//
// State lives in flat Float32Arrays; dead particles are swap-removed so the live range stays
// contiguous and only that range is uploaded each frame. Nothing allocates per frame.
import * as THREE from 'three';

export const Shape = {
  Glow: 0,
  Spark: 1,
  Puff: 2,
  Ring: 3,
  Star: 4,
  Drop: 5,
  Bubble: 6,
  Leaf: 7,
  Shard: 8,
  Scorch: 9,
  Arc: 10,
  Pillar: 11,
  Burst: 12,
} as const;

/** Spawn flags. */
export const PF = {
  Flat: 1, // lies on the ground plane (XZ) instead of facing the camera
  Stretch: 2, // streak along velocity
  Axis: 4, // streak along a fixed axis (vel fields at spawn), particle does not move
  EaseSize: 8, // size grows with an ease-out curve (shockwaves)
  FloorKill: 16, // dies when it drops below floorY
  FloorBounce: 32, // bounces on floorY
  Orbit: 64, // circles around (ocx, ocz)
  FloorStop: 128, // lands and stays (droplets on ground, leaves)
} as const;

const tmpColor = new THREE.Color();

/** Mutable spawn description. Reset with SpriteBatch.begin(), fill, then SpriteBatch.emit(). */
export class SpriteSpec {
  shape = 0;
  blend = 0;
  flags = 0;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  life = 1;
  size0 = 1;
  size1 = 1;
  alpha = 1;
  r0 = 1;
  g0 = 1;
  b0 = 1;
  r1 = -1;
  g1 = 0;
  b1 = 0;
  rot = 0;
  rotV = 0;
  drag = 0;
  grav = 0;
  fin = 0.06;
  fpow = 1;
  floorY = -1e9;
  bounce = 0.3;
  stretch = 0;
  param = 0.2;
  seed = 0;
  ocx = 0;
  ocz = 0;
  orad = 0;
  orv = 0;
  oang = 0;
  ow = 0;
  wobble = 0;
  wobbleF = 0;

  reset(shape: number): this {
    this.shape = shape;
    this.blend = 0;
    this.flags = 0;
    this.x = this.y = this.z = 0;
    this.vx = this.vy = this.vz = 0;
    this.life = 1;
    this.size0 = this.size1 = 1;
    this.alpha = 1;
    this.r0 = this.g0 = this.b0 = 1;
    this.r1 = -1;
    this.g1 = this.b1 = 0;
    this.rot = Math.random() * Math.PI * 2;
    this.rotV = 0;
    this.drag = 0;
    this.grav = 0;
    this.fin = 0.06;
    this.fpow = 1;
    this.floorY = -1e9;
    this.bounce = 0.3;
    this.stretch = 0;
    this.param = 0.2;
    this.seed = Math.random();
    this.ocx = this.ocz = this.orad = this.orv = this.oang = this.ow = 0;
    this.wobble = this.wobbleF = 0;
    return this;
  }

  pos(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  vel(x: number, y: number, z: number): this {
    this.vx = x;
    this.vy = y;
    this.vz = z;
    return this;
  }

  /** Start colour, hex sRGB times an HDR intensity. */
  color(hex: number, k = 1): this {
    tmpColor.setHex(hex);
    this.r0 = tmpColor.r * k;
    this.g0 = tmpColor.g * k;
    this.b0 = tmpColor.b * k;
    return this;
  }

  /** End colour (lerped over life). */
  colorEnd(hex: number, k = 1): this {
    tmpColor.setHex(hex);
    this.r1 = tmpColor.r * k;
    this.g1 = tmpColor.g * k;
    this.b1 = tmpColor.b * k;
    return this;
  }

  size(a: number, b = a): this {
    this.size0 = a;
    this.size1 = b;
    return this;
  }
}

// CPU state layout (stride C)
const C = 36;
const AGE = 0, LIFE = 1, VX = 2, VY = 3, VZ = 4, S0 = 5, S1 = 6, A0 = 7, R0 = 8, G0 = 9, B0 = 10, R1 = 11, G1 = 12, B1 = 13;
const ROTV = 14, DRAG = 15, GRAV = 16, FIN = 17, FPOW = 18, FLAGS = 19, FLOOR = 20, OCX = 21, OCZ = 22, ORAD = 23, ORV = 24;
const OANG = 25, OW = 26, BOUNCE = 27, WOB = 28, WOBF = 29, PHASE = 30, ROT = 31, STRETCH = 32;

const SPRITE_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iColor;
attribute vec4 iData; // size, rotation, stretch, flat
attribute vec4 iMisc; // shape, blend, param, seed
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vMisc;
void main() {
  vUv = position.xy * 2.0;
  vColor = iColor;
  vMisc = iMisc;
  float size = iData.x;
  float rot = iData.y;
  float stretch = iData.z;
  vec2 c = position.xy;
  if (iData.w > 0.5) {
    float cs = cos(rot), sn = sin(rot);
    vec2 o = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y) * size;
    gl_Position = projectionMatrix * viewMatrix * vec4(iPos + vec3(o.x, 0.0, o.y), 1.0);
    return;
  }
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  vec2 o;
  if (stretch > 0.0) {
    vec2 d = (viewMatrix * vec4(iVel, 0.0)).xy;
    float l = length(d);
    vec2 dir = l > 1e-5 ? d / l : vec2(1.0, 0.0);
    vec2 perp = vec2(-dir.y, dir.x);
    float len = size + l * stretch;
    o = dir * c.x * len + perp * c.y * size;
  } else {
    float cs = cos(rot), sn = sin(rot);
    o = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y) * size;
  }
  mv.xy += o;
  gl_Position = projectionMatrix * mv;
}
`;

const SPRITE_FRAG = /* glsl */ `
uniform vec3 uLit;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vMisc;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  float shape = vMisc.x;
  vec2 uv = vUv;
  float r = length(uv);
  float a = 0.0;
  vec3 col = vColor.rgb;
  if (shape < 0.5) {
    // glow: soft falloff with a hot core
    a = exp(-r * r * 4.5) * (1.0 - smoothstep(0.8, 1.0, r));
    col *= 1.0 + 1.6 * exp(-r * r * 22.0);
  } else if (shape < 1.5) {
    // spark streak, head at +x
    float across = 1.0 - smoothstep(0.0, 1.0, abs(uv.y));
    float along = smoothstep(-1.0, 0.4, uv.x) * (1.0 - smoothstep(0.75, 1.0, uv.x));
    a = across * along;
    col *= 1.0 + 1.8 * across * across * along;
  } else if (shape < 2.5) {
    // smoke / dust puff with noisy edge and top light
    float s = vMisc.w * 37.0;
    float n = vnoise(uv * 2.2 + s) * 0.62 + vnoise(uv * 4.7 - s) * 0.38;
    a = 1.0 - smoothstep(0.3, 1.0, r + (n - 0.5) * 0.6);
    col *= 0.72 + 0.28 * (uv.y * 0.5 + 0.5) + (n - 0.5) * 0.35;
  } else if (shape < 3.5) {
    // ring; param = thickness fraction
    float th = max(vMisc.z, 0.02);
    float d = abs(r - (1.0 - th)) / th;
    a = (1.0 - smoothstep(0.0, 1.0, d)) * (1.0 - step(1.0, r));
    col *= 1.0 + 0.6 * (1.0 - smoothstep(0.0, 0.5, d));
  } else if (shape < 4.5) {
    // four point star
    vec2 q = abs(uv);
    float beams = exp(-q.x * 16.0) * exp(-q.y * 1.8) + exp(-q.y * 16.0) * exp(-q.x * 1.8);
    a = clamp(beams + exp(-r * r * 12.0), 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, r));
    col *= 1.0 + exp(-r * r * 30.0);
  } else if (shape < 5.5) {
    // droplet with a specular dot
    a = 1.0 - smoothstep(0.62, 1.0, r);
    vec2 h = uv - vec2(-0.28, 0.32);
    float hl = exp(-dot(h, h) * 16.0);
    col = mix(col * (0.85 + 0.25 * uv.y), vec3(1.0), hl * 0.85);
  } else if (shape < 6.5) {
    // bubble: rim and highlight
    float rim = smoothstep(0.58, 0.84, r) * (1.0 - smoothstep(0.9, 1.0, r));
    vec2 h = uv - vec2(-0.32, 0.34);
    float hl = exp(-dot(h, h) * 28.0);
    a = max(rim, hl) + 0.1 * (1.0 - r);
    col = mix(col, vec3(1.0), hl);
  } else if (shape < 7.5) {
    // leaf with a midrib, pointed along y
    float w = 0.52 * (1.0 - uv.y * uv.y);
    a = (1.0 - smoothstep(w - 0.1, w, abs(uv.x))) * (1.0 - smoothstep(0.9, 1.0, abs(uv.y)));
    float rib = 1.0 - smoothstep(0.0, 0.08, abs(uv.x));
    col *= 0.9 - 0.35 * rib + 0.3 * uv.x;
  } else if (shape < 8.5) {
    // crystal shard: two-tone diamond
    float d = abs(uv.x) * 2.4 + abs(uv.y);
    a = 1.0 - smoothstep(0.86, 1.0, d);
    col *= (uv.x < 0.0 ? 1.25 : 0.8) + 0.5 * (1.0 - d);
  } else if (shape < 9.5) {
    // scorch mark
    float n = vnoise(uv * 3.0 + vMisc.w * 13.0);
    a = 1.0 - smoothstep(0.25, 1.0, r + (n - 0.5) * 0.55);
    col *= 0.6 + 0.6 * n;
  } else if (shape < 10.5) {
    // slash arc: crescent with a bright leading edge
    float outer = 1.0 - smoothstep(0.9, 1.0, r);
    float inner = smoothstep(0.6, 0.78, length(uv - vec2(0.0, -0.3)));
    float ends = smoothstep(-0.45, 0.45, uv.y);
    a = outer * inner * ends;
    col *= 1.0 + 1.5 * smoothstep(0.75, 0.95, r);
  } else if (shape < 11.5) {
    // light pillar along x (axis), soft across y
    float across = exp(-uv.y * uv.y * 4.0);
    float along = (1.0 - smoothstep(0.2, 1.0, uv.x)) * smoothstep(-1.0, -0.75, uv.x);
    a = across * along;
    col *= 1.0 + 1.4 * exp(-uv.y * uv.y * 30.0);
  } else {
    // comic impact burst: fat jagged spikes, thin dark outline, warm core; param = core size
    float ang = atan(uv.y, uv.x) / 6.2831853 + 0.5;
    float sp = 9.0;
    float f = ang * sp + vMisc.w * 7.0;
    float idx = floor(f);
    float tri = 1.0 - abs(fract(f) * 2.0 - 1.0);
    float len = 0.7 + 0.3 * hash12(vec2(idx, floor(vMisc.w * 97.0)));
    float edge = mix(0.52, len, pow(tri, 1.6));
    a = 1.0 - smoothstep(edge - 0.035, edge, r);
    float rim = smoothstep(edge - 0.09, edge - 0.06, r);
    float coreR = edge * vMisc.z;
    float core = 1.0 - smoothstep(coreR - 0.06, coreR, r);
    vec3 hot = vec3(1.0, 0.96, 0.72) * max(1.0, max(col.r, max(col.g, col.b)));
    col = mix(mix(col, hot, core), col * 0.42, rim);
  }
  // alpha-blended particles (dust, smoke, foam) take the scene light; additive ones glow on their own
  col *= mix(vec3(1.0), uLit, vMisc.y);
  float alpha = clamp(a, 0.0, 1.0) * vColor.a;
  gl_FragColor = vec4(col * alpha, alpha * vMisc.y);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SpriteBatch {
  readonly mesh: THREE.Mesh;
  readonly cap: number;
  live = 0;
  private readonly st: Float32Array;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly data: Float32Array;
  private readonly misc: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly lit = new THREE.Color(1, 1, 1);
  readonly spec = new SpriteSpec();

  constructor(cap: number) {
    this.cap = cap;
    this.st = new Float32Array(cap * C);
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.data = new Float32Array(cap * 4);
    this.misc = new Float32Array(cap * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    const mk = (arr: Float32Array, size: number, name: string) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.attrs = [mk(this.pos, 3, 'iPos'), mk(this.vel, 3, 'iVel'), mk(this.col, 4, 'iColor'), mk(this.data, 4, 'iData'), mk(this.misc, 4, 'iMisc')];
    geo.instanceCount = 0;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uLit: { value: this.lit } },
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    // Transparent and on layer 0: the engine routes transparent objects to its overlay pass, which
    // draws after the water so splashes and mist sit on top of the river; a plain forward render
    // draws transparents last anyway.
    this.mesh.renderOrder = 20;
  }

  /** Light tint for alpha-blended particles (1,1,1 = daylight). */
  setLight(r: number, g: number, b: number): void {
    this.lit.setRGB(r, g, b);
  }

  /** Fraction of the pool in use (0..1). Low-priority effects skip when this is high. */
  load(): number {
    return this.live / this.cap;
  }

  begin(shape: number): SpriteSpec {
    return this.spec.reset(shape);
  }

  emit(s: SpriteSpec = this.spec): boolean {
    if (this.live >= this.cap) return false;
    const i = this.live++;
    const o = i * C;
    const st = this.st;
    st[o + AGE] = 0;
    st[o + LIFE] = Math.max(0.01, s.life);
    st[o + VX] = s.vx;
    st[o + VY] = s.vy;
    st[o + VZ] = s.vz;
    st[o + S0] = s.size0;
    st[o + S1] = s.size1;
    st[o + A0] = s.alpha;
    st[o + R0] = s.r0;
    st[o + G0] = s.g0;
    st[o + B0] = s.b0;
    if (s.r1 < 0) {
      st[o + R1] = s.r0;
      st[o + G1] = s.g0;
      st[o + B1] = s.b0;
    } else {
      st[o + R1] = s.r1;
      st[o + G1] = s.g1;
      st[o + B1] = s.b1;
    }
    st[o + ROTV] = s.rotV;
    st[o + DRAG] = s.drag;
    st[o + GRAV] = s.grav;
    st[o + FIN] = Math.max(0.001, s.fin);
    st[o + FPOW] = s.fpow;
    st[o + FLAGS] = s.flags;
    st[o + FLOOR] = s.floorY;
    st[o + OCX] = s.ocx;
    st[o + OCZ] = s.ocz;
    st[o + ORAD] = s.orad;
    st[o + ORV] = s.orv;
    st[o + OANG] = s.oang;
    st[o + OW] = s.ow;
    st[o + BOUNCE] = s.bounce;
    st[o + WOB] = s.wobble;
    st[o + WOBF] = s.wobbleF;
    st[o + PHASE] = Math.random() * 6.283;
    st[o + ROT] = s.rot;
    st[o + STRETCH] = s.stretch;
    let x = s.x;
    let z = s.z;
    if (s.flags & PF.Orbit) {
      x = s.ocx + Math.cos(s.oang) * s.orad;
      z = s.ocz + Math.sin(s.oang) * s.orad;
    }
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = s.y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = s.vx;
    this.vel[i * 3 + 1] = s.vy;
    this.vel[i * 3 + 2] = s.vz;
    const c4 = i * 4;
    this.col[c4] = s.r0;
    this.col[c4 + 1] = s.g0;
    this.col[c4 + 2] = s.b0;
    this.col[c4 + 3] = 0;
    this.data[c4] = s.size0;
    this.data[c4 + 1] = s.rot;
    this.data[c4 + 2] = s.flags & (PF.Stretch | PF.Axis) ? Math.max(0.0001, s.stretch) : 0;
    this.data[c4 + 3] = s.flags & PF.Flat ? 1 : 0;
    this.misc[c4] = s.shape;
    this.misc[c4 + 1] = s.blend;
    this.misc[c4 + 2] = s.param;
    this.misc[c4 + 3] = s.seed;
    return true;
  }

  private kill(i: number): void {
    const last = --this.live;
    if (i === last) return;
    this.st.copyWithin(i * C, last * C, last * C + C);
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.col.copyWithin(i * 4, last * 4, last * 4 + 4);
    this.data.copyWithin(i * 4, last * 4, last * 4 + 4);
    this.misc.copyWithin(i * 4, last * 4, last * 4 + 4);
  }

  update(dt: number): void {
    const st = this.st;
    const pos = this.pos;
    const vel = this.vel;
    const col = this.col;
    const data = this.data;
    let i = 0;
    while (i < this.live) {
      const o = i * C;
      const age = st[o + AGE] + dt;
      const life = st[o + LIFE];
      if (age >= life) {
        this.kill(i);
        continue;
      }
      st[o + AGE] = age;
      const flags = st[o + FLAGS] | 0;
      const p3 = i * 3;
      const c4 = i * 4;
      if (!(flags & PF.Axis)) {
        let vx = st[o + VX];
        let vy = st[o + VY];
        let vz = st[o + VZ];
        const drag = st[o + DRAG];
        if (drag > 0) {
          const k = Math.exp(-drag * dt);
          vx *= k;
          vy *= k;
          vz *= k;
        }
        vy += st[o + GRAV] * dt;
        let x = pos[p3] + vx * dt;
        let y = pos[p3 + 1] + vy * dt;
        let z = pos[p3 + 2] + vz * dt;
        if (flags & PF.Orbit) {
          const ang = st[o + OANG] + st[o + OW] * dt;
          const rad = Math.max(0, st[o + ORAD] + st[o + ORV] * dt);
          st[o + OANG] = ang;
          st[o + ORAD] = rad;
          x = st[o + OCX] + Math.cos(ang) * rad;
          z = st[o + OCZ] + Math.sin(ang) * rad;
        }
        const wob = st[o + WOB];
        if (wob > 0) {
          const ph = st[o + PHASE] + st[o + WOBF] * dt;
          st[o + PHASE] = ph;
          x += Math.cos(ph) * wob * dt;
          z += Math.sin(ph * 1.3) * wob * dt;
        }
        const floor = st[o + FLOOR];
        if (y < floor) {
          if (flags & PF.FloorKill) {
            this.kill(i);
            continue;
          }
          y = floor;
          if (flags & PF.FloorBounce && vy < -0.8) {
            vy = -vy * st[o + BOUNCE];
            vx *= 0.6;
            vz *= 0.6;
          } else {
            vy = 0;
            vx *= 0.5;
            vz *= 0.5;
          }
        }
        st[o + VX] = vx;
        st[o + VY] = vy;
        st[o + VZ] = vz;
        pos[p3] = x;
        pos[p3 + 1] = y;
        pos[p3 + 2] = z;
        if (flags & PF.Stretch) {
          vel[p3] = vx;
          vel[p3 + 1] = vy;
          vel[p3 + 2] = vz;
        }
      }
      const k = age / life;
      const fin = st[o + FIN];
      const fade = Math.min(1, k / fin) * Math.pow(1 - k, st[o + FPOW]);
      const e = flags & PF.EaseSize ? 1 - (1 - k) * (1 - k) * (1 - k) : k;
      col[c4] = st[o + R0] + (st[o + R1] - st[o + R0]) * k;
      col[c4 + 1] = st[o + G0] + (st[o + G1] - st[o + G0]) * k;
      col[c4 + 2] = st[o + B0] + (st[o + B1] - st[o + B0]) * k;
      col[c4 + 3] = st[o + A0] * fade;
      data[c4] = st[o + S0] + (st[o + S1] - st[o + S0]) * e;
      const rot = st[o + ROT] + st[o + ROTV] * dt;
      st[o + ROT] = rot;
      data[c4 + 1] = rot;
      i++;
    }
    this.geo.instanceCount = this.live;
    const n = this.live;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      if (n > 0) {
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  /** Make the batch render once with an invisible particle so its shader compiles now. */
  warm(x: number, y: number, z: number): void {
    const s = this.begin(Shape.Glow);
    s.pos(x, y, z);
    s.alpha = 0;
    s.life = 0.05;
    this.emit(s);
  }

  clear(): void {
    this.live = 0;
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Lit voxel cubes
// ---------------------------------------------------------------------------------------------

const K = 26;
const PX = 0, PY = 1, PZ = 2, CVX = 3, CVY = 4, CVZ = 5, EX = 6, EY = 7, EZ = 8, WX = 9, WY = 10, WZ = 11;
const SX = 12, SY = 13, SZ = 14, CAGE = 15, CLIFE = 16, CFLOOR = 17, CBOUNCE = 18, CSTATE = 19, CGRAV = 20, CDRAG = 21, CSHRINK = 22, CGROW = 23, CFLOAT = 24;

export class CubeSpec {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  wx = 0;
  wy = 0;
  wz = 0;
  sx = 0.15;
  sy = 0.15;
  sz = 0.15;
  life = 2;
  floorY = -1e9;
  bounce = 0.35;
  grav = -22;
  drag = 0.3;
  shrink = 0.4;
  grow = 0.04;
  glow = 0;
  color = 0xffffff;
  /** 1 = sinks slowly on landing (water); 0 = rests */
  float = 0;

  reset(): this {
    this.x = this.y = this.z = 0;
    this.vx = this.vy = this.vz = 0;
    this.wx = (Math.random() - 0.5) * 16;
    this.wy = (Math.random() - 0.5) * 10;
    this.wz = (Math.random() - 0.5) * 16;
    this.sx = this.sy = this.sz = 0.15;
    this.life = 2;
    this.floorY = -1e9;
    this.bounce = 0.35;
    this.grav = -22;
    this.drag = 0.3;
    this.shrink = 0.4;
    this.grow = 0.04;
    this.glow = 0;
    this.color = 0xffffff;
    this.float = 0;
    return this;
  }

  cube(s: number): this {
    this.sx = this.sy = this.sz = s;
    return this;
  }
}

const CUBE_SHADER_HEAD = /* glsl */ `
attribute float aGlow;
varying float vGlow;
`;

export class CubeBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly cap: number;
  live = 0;
  private readonly st: Float32Array;
  private readonly glow: Float32Array;
  private readonly glowAttr: THREE.InstancedBufferAttribute;
  private readonly colArr: Float32Array;
  private readonly uploads: THREE.BufferAttribute[];
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.MeshStandardMaterial;
  readonly spec = new CubeSpec();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(cap: number, castShadow: boolean) {
    this.cap = cap;
    this.st = new Float32Array(cap * K);
    // a chunky cube with baked top-light shading in vertex colours (top bright, bottom dark)
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const n = geo.getAttribute('normal');
    const cols = new Float32Array(n.count * 3);
    for (let i = 0; i < n.count; i++) {
      const ny = n.getY(i);
      const nx = n.getX(i);
      const k = ny > 0.5 ? 1.0 : ny < -0.5 ? 0.72 : nx !== 0 ? 0.86 : 0.92;
      cols[i * 3] = cols[i * 3 + 1] = cols[i * 3 + 2] = k;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.glow = new Float32Array(cap);
    this.glowAttr = new THREE.InstancedBufferAttribute(this.glow, 1);
    this.glowAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGlow', this.glowAttr);
    this.geo = geo;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = CUBE_SHADER_HEAD + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;');
      sh.fragmentShader =
        'varying float vGlow;\n' +
        sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vGlow;');
    };
    mat.customProgramCacheKey = () => 'hw-fx-cube';
    this.mat = mat;
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // instanceColor must exist before the first compile or colours are ignored
    this.colArr = new Float32Array(cap * 3).fill(1);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colArr, 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    this.mesh = mesh;
    this.uploads = [mesh.instanceMatrix, mesh.instanceColor, this.glowAttr];
  }

  load(): number {
    return this.live / this.cap;
  }

  begin(): CubeSpec {
    return this.spec.reset();
  }

  emit(c: CubeSpec = this.spec): boolean {
    if (this.live >= this.cap) return false;
    const i = this.live++;
    const o = i * K;
    const st = this.st;
    st[o + PX] = c.x;
    st[o + PY] = c.y;
    st[o + PZ] = c.z;
    st[o + CVX] = c.vx;
    st[o + CVY] = c.vy;
    st[o + CVZ] = c.vz;
    st[o + EX] = Math.random() * 6.283;
    st[o + EY] = Math.random() * 6.283;
    st[o + EZ] = Math.random() * 6.283;
    st[o + WX] = c.wx;
    st[o + WY] = c.wy;
    st[o + WZ] = c.wz;
    st[o + SX] = c.sx;
    st[o + SY] = c.sy;
    st[o + SZ] = c.sz;
    st[o + CAGE] = 0;
    st[o + CLIFE] = Math.max(0.05, c.life);
    st[o + CFLOOR] = c.floorY;
    st[o + CBOUNCE] = c.bounce;
    st[o + CSTATE] = 0;
    st[o + CGRAV] = c.grav;
    st[o + CDRAG] = c.drag;
    st[o + CSHRINK] = Math.max(0.05, Math.min(c.shrink, c.life));
    st[o + CGROW] = Math.max(0.001, c.grow);
    st[o + CFLOAT] = c.float;
    tmpColor.setHex(c.color);
    this.colArr[i * 3] = tmpColor.r;
    this.colArr[i * 3 + 1] = tmpColor.g;
    this.colArr[i * 3 + 2] = tmpColor.b;
    this.glow[i] = c.glow;
    return true;
  }

  private kill(i: number): void {
    const last = --this.live;
    if (i === last) return;
    this.st.copyWithin(i * K, last * K, last * K + K);
    this.colArr.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.glow[i] = this.glow[last];
  }

  update(dt: number): void {
    const st = this.st;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    let i = 0;
    while (i < this.live) {
      const o = i * K;
      const age = st[o + CAGE] + dt;
      const life = st[o + CLIFE];
      if (age >= life) {
        this.kill(i);
        continue;
      }
      st[o + CAGE] = age;
      let state = st[o + CSTATE];
      let x = st[o + PX];
      let y = st[o + PY];
      let z = st[o + PZ];
      const half = st[o + SY] * 0.5;
      const floor = st[o + CFLOOR] + half;
      if (state < 2) {
        let vx = st[o + CVX];
        let vy = st[o + CVY];
        let vz = st[o + CVZ];
        const dk = Math.exp(-st[o + CDRAG] * dt);
        vx *= dk;
        vz *= dk;
        vy = vy * dk + st[o + CGRAV] * dt;
        x += vx * dt;
        y += vy * dt;
        z += vz * dt;
        let wx = st[o + WX];
        let wy = st[o + WY];
        let wz = st[o + WZ];
        if (y < floor) {
          y = floor;
          if (vy < -1.2) {
            vy = -vy * st[o + CBOUNCE];
            vx *= 0.68;
            vz *= 0.68;
            wx = wx * 0.55 + (Math.random() - 0.5) * 4;
            wz = wz * 0.55 + (Math.random() - 0.5) * 4;
            wy *= 0.6;
          } else {
            vy = 0;
            state = 1; // sliding on the ground
          }
        }
        if (state === 1) {
          const f = Math.exp(-7 * dt);
          vx *= f;
          vz *= f;
          wx *= f;
          wy *= f;
          wz *= f;
          if (vx * vx + vz * vz < 0.02) state = 2; // asleep
        }
        st[o + CVX] = vx;
        st[o + CVY] = vy;
        st[o + CVZ] = vz;
        st[o + WX] = wx;
        st[o + WY] = wy;
        st[o + WZ] = wz;
        st[o + EX] += wx * dt;
        st[o + EY] += wy * dt;
        st[o + EZ] += wz * dt;
      }
      if (state >= 1) {
        // settle flat: ease tilt toward the nearest quarter turn
        const s = Math.min(1, dt * 10);
        const qx = Math.round(st[o + EX] / 1.5708) * 1.5708;
        const qz = Math.round(st[o + EZ] / 1.5708) * 1.5708;
        st[o + EX] += (qx - st[o + EX]) * s;
        st[o + EZ] += (qz - st[o + EZ]) * s;
        if (st[o + CFLOAT] > 0) y -= dt * 0.25 * st[o + CFLOAT];
      }
      st[o + CSTATE] = state;
      st[o + PX] = x;
      st[o + PY] = y;
      st[o + PZ] = z;
      // pop in, shrink out
      const rem = life - age;
      const shrink = st[o + CSHRINK];
      let k = rem < shrink ? rem / shrink : 1;
      k *= Math.min(1, age / st[o + CGROW]);
      k = k * k * (3 - 2 * k);
      this.e.set(st[o + EX], st[o + EY], st[o + EZ]);
      this.q.setFromEuler(this.e);
      this.p.set(x, y, z);
      this.s.set(st[o + SX] * k + 1e-5, st[o + SY] * k + 1e-5, st[o + SZ] * k + 1e-5);
      this.m.compose(this.p, this.q, this.s);
      this.m.toArray(arr, i * 16);
      i++;
    }
    const n = this.live;
    this.mesh.count = n;
    for (const a of this.uploads) {
      a.clearUpdateRanges();
      if (n > 0) {
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  warm(x: number, y: number, z: number): void {
    const c = this.begin();
    c.x = x;
    c.y = y;
    c.z = z;
    c.cube(0.0001);
    c.life = 0.05;
    c.grav = 0;
    this.emit(c);
  }

  clear(): void {
    this.live = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Flash lights
// ---------------------------------------------------------------------------------------------

interface LightSlot {
  light: THREE.PointLight;
  age: number;
  life: number;
  peak: number;
}

export class LightPool {
  readonly group = new THREE.Group();
  private readonly slots: LightSlot[] = [];

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 9, 2);
      light.castShadow = false;
      light.position.set(0, -50, 0);
      this.group.add(light);
      this.slots.push({ light, age: 1, life: 1, peak: 0 });
    }
  }

  flash(x: number, y: number, z: number, hex: number, intensity: number, distance: number, life: number): void {
    if (!this.slots.length) return;
    // take a free slot, else the one closest to done, but never steal a brighter fresh flash
    let best = this.slots[0];
    let bestLeft = Infinity;
    for (const s of this.slots) {
      const left = s.age >= s.life ? -1 : (1 - s.age / s.life) * s.peak;
      if (left < bestLeft) {
        bestLeft = left;
        best = s;
      }
    }
    if (bestLeft > intensity) return;
    best.light.position.set(x, y, z);
    best.light.color.setHex(hex);
    best.light.distance = distance;
    best.age = 0;
    best.life = life;
    best.peak = intensity;
    best.light.intensity = intensity;
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.age >= s.life) {
        s.light.intensity = 0;
        continue;
      }
      s.age += dt;
      const k = Math.max(0, 1 - s.age / s.life);
      s.light.intensity = s.peak * k * k;
    }
  }

  dispose(): void {
    for (const s of this.slots) s.light.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Small random helpers
// ---------------------------------------------------------------------------------------------

export function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export function pick<T>(arr: readonly T[]): T {
  return arr[(Math.random() * arr.length) | 0];
}

/** Random unit-ish direction in the upper hemisphere biased by `up` (0..1), written into out. */
export function randDir(out: { x: number; y: number; z: number }, up: number): void {
  const a = Math.random() * Math.PI * 2;
  const y = up + Math.random() * (1 - up);
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  out.x = Math.cos(a) * r;
  out.y = y;
  out.z = Math.sin(a) * r;
}
