// GPU weather: every particle lives in a static buffer of random seeds and is animated entirely in
// the vertex shader (wrapping around the focus point with mod()), so there are no per-frame CPU
// writes. Snow (soft drifting flakes), rain (velocity-aligned streaks plus ground splash rings),
// fireflies (blinking HDR glows for bloom) and pollen (sunlit floating motes).
import * as THREE from 'three';
import type { Weather } from '../../../shared/maps/types.ts';
import type { Quality } from '../contracts.ts';

export const WEATHER_COUNTS: Record<Exclude<Weather, 'none'>, Record<Quality, number>> = {
  snow: { low: 700, medium: 1700, high: 2800, ultra: 4200 },
  rain: { low: 400, medium: 1000, high: 1600, ultra: 2400 },
  fireflies: { low: 50, medium: 120, high: 190, ultra: 280 },
  pollen: { low: 260, medium: 620, high: 950, ultra: 1400 },
};
const SPLASH_COUNTS: Record<Quality, number> = { low: 90, medium: 220, high: 340, ultra: 520 };

export interface WeatherOptions {
  kind: Weather;
  quality: Quality;
  /** bank top height */
  groundY: number;
  /** lit particle colour (linear) */
  tint: THREE.Color;
  sunColor: THREE.Color;
  /** 1 on the flat ground, 0 in the river channel and on banks (rain splashes) */
  groundMask: THREE.DataTexture | null;
  /** world rect covered by groundMask: minX, minZ, sizeX, sizeZ */
  maskRect: THREE.Vector4;
  overlayLayer: number;
  /** stable seed so particle layout is the same between matches */
  seed?: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedAttribute(count: number, seed: number): THREE.BufferAttribute {
  const r = rng(seed);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < a.length; i++) a[i] = r();
  return new THREE.BufferAttribute(a, 4);
}

const COMMON_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec3 uFocus;
uniform vec3 uBox;
uniform float uBase;
uniform float uPixelScale;
`;

/** wraps a world xz into the box around the focus and returns an edge fade */
const WRAP_GLSL = /* glsl */ `
vec3 hwWrap(vec3 p) {
  vec2 o = uFocus.xz - uBox.xz * 0.5;
  p.xz = mod(p.xz - o, uBox.xz) + o;
  return p;
}
float hwEdge(vec3 p) {
  vec2 e = abs(p.xz - uFocus.xz) / (uBox.xz * 0.5);
  return 1.0 - smoothstep(0.78, 1.0, max(e.x, e.y));
}
`;

const SNOW_VERT = /* glsl */ `
${COMMON_UNIFORMS}
uniform vec2 uWind;
attribute vec4 aSeed;
varying float vAlpha;
${WRAP_GLSL}
void main() {
  vec3 b = aSeed.xyz * uBox;
  float fall = 0.75 + aSeed.w * 0.8;
  vec3 p = b;
  p.y = mod(b.y - uTime * fall, uBox.y);
  float sway = 0.45 + aSeed.w * 0.5;
  p.x += uTime * uWind.x + sin(uTime * (0.55 + aSeed.w * 0.7) + aSeed.x * 31.0) * sway;
  p.z += uTime * uWind.y + cos(uTime * (0.47 + aSeed.z * 0.6) + aSeed.z * 29.0) * sway;
  p = hwWrap(p);
  float hy = p.y;
  p.y += uBase - 0.15;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.1);
  float yfade = smoothstep(0.0, 0.5, hy) * (1.0 - smoothstep(uBox.y * 0.82, uBox.y, hy));
  vAlpha = hwEdge(p) * yfade * smoothstep(2.5, 9.0, dist);
  float size = mix(0.06, 0.17, aSeed.w * aSeed.w);
  gl_PointSize = max(size * uPixelScale / dist, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const SNOW_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = (1.0 - d) * (1.0 - d) * vAlpha;
  gl_FragColor = vec4(uColor * (0.85 + 0.3 * (1.0 - d)), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RAIN_VERT = /* glsl */ `
${COMMON_UNIFORMS}
uniform vec3 uVel;
uniform float uLen;
uniform float uWidth;
uniform vec2 uViewport;
attribute vec4 aSeed;
varying float vAlpha;
varying float vAlong;
${WRAP_GLSL}
void main() {
  vec3 b = aSeed.xyz * uBox;
  vec3 v = uVel * (0.85 + aSeed.w * 0.3);
  float period = uBox.y / -v.y;
  float ph = fract(uTime / period + aSeed.w * 7.31 + aSeed.y);
  vec3 head = vec3(b.x, uBox.y, b.z) + v * ph * period;
  head = hwWrap(head);
  float hy = head.y;
  head.y += uBase;
  vec3 tail = head - normalize(v) * uLen * (0.7 + aSeed.x * 0.6);
  vec4 ch = projectionMatrix * viewMatrix * vec4(head, 1.0);
  vec4 ct = projectionMatrix * viewMatrix * vec4(tail, 1.0);
  vec2 sh = ch.xy / max(ch.w, 0.01);
  vec2 st = ct.xy / max(ct.w, 0.01);
  vec2 dpx = (sh - st) * uViewport;
  vec2 n = normalize(vec2(-dpx.y, dpx.x) + vec2(1e-5, 0.0));
  vec4 c = mix(ct, ch, position.y);
  c.xy += n / uViewport * position.x * uWidth * c.w;
  gl_Position = c;
  float dist = c.w;
  vAlong = position.y;
  vAlpha = hwEdge(head) * smoothstep(0.0, 0.6, hy) * smoothstep(3.0, 9.0, dist);
}
`;

const RAIN_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
varying float vAlong;
void main() {
  float a = vAlpha * smoothstep(0.0, 0.85, vAlong) * 0.3;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPLASH_VERT = /* glsl */ `
${COMMON_UNIFORMS}
uniform sampler2D uMask;
uniform vec4 uMaskRect;
attribute vec4 aSeed;
varying float vLife;
varying float vAlpha;
float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  float rate = 1.4 + aSeed.w * 1.2;
  float ph = uTime * rate + aSeed.z * 13.0;
  float cyc = floor(ph);
  float f = fract(ph);
  vec2 r = vec2(h11(cyc + aSeed.x * 113.0), h11(cyc * 1.37 + aSeed.y * 71.0));
  vec2 o = uFocus.xz - uBox.xz * 0.5;
  vec3 p = vec3(o.x + r.x * uBox.x, uBase + 0.03, o.y + r.y * uBox.z);
  vec2 muv = (p.xz - uMaskRect.xy) / uMaskRect.zw;
  float m = texture2D(uMask, muv).r;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.1);
  vLife = f;
  vAlpha = m * (1.0 - smoothstep(0.35, 1.0, f));
  gl_PointSize = (0.06 + f * 0.32) * uPixelScale / dist;
  gl_Position = projectionMatrix * mv;
}
`;

const SPLASH_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vLife;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  c.y *= 1.9; // flattened, reads as a ring on the ground from the tilted camera
  float d = length(c);
  if (d > 1.0 || vAlpha <= 0.001) discard;
  float ring = smoothstep(0.55, 0.85, d) * (1.0 - smoothstep(0.85, 1.0, d));
  float dot0 = (1.0 - smoothstep(0.0, 0.45, d)) * (1.0 - smoothstep(0.0, 0.25, vLife));
  float a = (ring * 0.7 + dot0) * vAlpha * 0.55;
  gl_FragColor = vec4(uColor * 1.15, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FIREFLY_VERT = /* glsl */ `
${COMMON_UNIFORMS}
attribute vec4 aSeed;
varying float vBright;
${WRAP_GLSL}
void main() {
  vec3 b = aSeed.xyz * uBox;
  float t = uTime;
  float r = 0.9 + aSeed.w * 1.6;
  vec3 off = vec3(
    sin(t * (0.21 + aSeed.w * 0.33) + aSeed.x * 40.0) + 0.5 * sin(t * 0.93 + aSeed.z * 17.0),
    sin(t * (0.43 + aSeed.z * 0.41) + aSeed.w * 21.0) * 0.32,
    cos(t * (0.19 + aSeed.y * 0.29) + aSeed.z * 37.0) + 0.5 * cos(t * 0.71 + aSeed.x * 11.0)
  ) * r;
  vec3 p = vec3(b.x, 0.0, b.z) + off;
  p = hwWrap(p);
  p.y = uBase + 0.35 + aSeed.y * 2.3 + off.y;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.1);
  float s = sin(t * (0.55 + aSeed.w * 1.1) + aSeed.x * 61.0) * 0.5 + 0.5;
  float blink = smoothstep(0.45, 1.0, s);
  vBright = (0.1 + 0.9 * blink * blink) * hwEdge(p);
  gl_PointSize = (0.5 + aSeed.w * 0.25) * uPixelScale / dist;
  gl_Position = projectionMatrix * mv;
}
`;

const FIREFLY_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vBright;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float core = exp(-d * 45.0);
  float halo = exp(-d * 6.0) * 0.32;
  vec3 col = uColor * (core * 8.0 + halo) * vBright;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const POLLEN_VERT = /* glsl */ `
${COMMON_UNIFORMS}
uniform vec2 uWind;
attribute vec4 aSeed;
varying float vBright;
varying float vAlpha;
${WRAP_GLSL}
void main() {
  vec3 b = aSeed.xyz * uBox;
  float t = uTime;
  vec3 p = b;
  p.x += t * uWind.x + sin(t * (0.3 + aSeed.w * 0.4) + aSeed.y * 20.0) * 0.8;
  p.z += t * uWind.y + cos(t * (0.27 + aSeed.x * 0.3) + aSeed.z * 20.0) * 0.8;
  float hy = mod(b.y + t * (0.05 + aSeed.w * 0.08), uBox.y);
  p = hwWrap(p);
  p.y = uBase + 0.15 + hy + sin(t * 0.8 + aSeed.x * 9.0) * 0.15;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.1);
  float sp = pow(sin(t * (1.6 + aSeed.w * 2.6) + aSeed.x * 50.0) * 0.5 + 0.5, 10.0);
  vBright = 0.35 + sp * 2.6;
  vAlpha = hwEdge(p) * smoothstep(0.0, 0.4, hy) * (1.0 - smoothstep(uBox.y * 0.8, uBox.y, hy)) * smoothstep(3.0, 8.0, dist);
  gl_PointSize = max((0.045 + aSeed.w * 0.05) * uPixelScale / dist, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const POLLEN_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vBright;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = exp(-d * 4.0);
  gl_FragColor = vec4(uColor * vBright * a * vAlpha, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface Layer {
  object: THREE.Object3D;
  material: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
  /** focus offset in z (toward the camera) */
  zOffset: number;
}

export class WeatherSystem {
  readonly group = new THREE.Group();
  readonly kind: Weather;
  private readonly layers: Layer[] = [];
  private readonly sharedTime = { value: 0 };
  private readonly sharedPixel = { value: 1000 };
  private readonly sharedViewport = { value: new THREE.Vector2(1280, 720) };

  constructor(o: WeatherOptions) {
    this.kind = o.kind;
    this.group.name = 'HW.Weather';
    const q = o.quality;
    const seed = o.seed ?? 1234;
    const base = o.groundY;
    if (o.kind === 'snow') {
      this.addPoints(WEATHER_COUNTS.snow[q], seed, SNOW_VERT, SNOW_FRAG, new THREE.Vector3(80, 22, 60), base, 0, {
        uColor: { value: o.tint.clone() },
        uWind: { value: new THREE.Vector2(0.55, 0.25) },
      }, THREE.NormalBlending, o.overlayLayer);
    } else if (o.kind === 'rain') {
      this.addRain(WEATHER_COUNTS.rain[q], seed, new THREE.Vector3(76, 20, 58), base, o.tint, o.overlayLayer);
      if (o.groundMask) {
        this.addPoints(SPLASH_COUNTS[q], seed + 7, SPLASH_VERT, SPLASH_FRAG, new THREE.Vector3(70, 1, 46), base, -4, {
          uColor: { value: o.tint.clone() },
          uMask: { value: o.groundMask },
          uMaskRect: { value: o.maskRect.clone() },
        }, THREE.NormalBlending, o.overlayLayer);
      }
    } else if (o.kind === 'fireflies') {
      const c = new THREE.Color(0xd8ff6a).lerp(new THREE.Color(0xffd36a), 0.35);
      this.addPoints(WEATHER_COUNTS.fireflies[q], seed, FIREFLY_VERT, FIREFLY_FRAG, new THREE.Vector3(72, 3, 50), base, -4, {
        uColor: { value: c },
      }, THREE.AdditiveBlending, o.overlayLayer);
    } else if (o.kind === 'pollen') {
      const c = new THREE.Color(0xfff2c8).lerp(o.sunColor, 0.4);
      this.addPoints(WEATHER_COUNTS.pollen[q], seed, POLLEN_VERT, POLLEN_FRAG, new THREE.Vector3(74, 6, 54), base, -2, {
        uColor: { value: c },
        uWind: { value: new THREE.Vector2(0.28, 0.12) },
      }, THREE.AdditiveBlending, o.overlayLayer);
    }
  }

  private makeMaterial(vert: string, frag: string, box: THREE.Vector3, base: number, extra: Record<string, THREE.IUniform>, blending: THREE.Blending): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      name: 'HW.Weather',
      uniforms: {
        uTime: this.sharedTime,
        uPixelScale: this.sharedPixel,
        uFocus: { value: new THREE.Vector3() },
        uBox: { value: box },
        uBase: { value: base },
        ...extra,
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
      fog: false,
    });
  }

  private addPoints(count: number, seed: number, vert: string, frag: string, box: THREE.Vector3, base: number, zOffset: number, extra: Record<string, THREE.IUniform>, blending: THREE.Blending, layer: number): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('aSeed', seedAttribute(count, seed));
    // position is unused by the shaders but three needs it for draw counts
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const material = this.makeMaterial(vert, frag, box, base, extra, blending);
    const pts = new THREE.Points(geometry, material);
    pts.frustumCulled = false;
    pts.renderOrder = 20;
    pts.layers.set(layer);
    this.group.add(pts);
    this.layers.push({ object: pts, material, geometry, zOffset });
  }

  private addRain(count: number, seed: number, box: THREE.Vector3, base: number, tint: THREE.Color, layer: number): void {
    const geometry = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]);
    geometry.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = seedAttribute(count, seed);
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds.array as Float32Array, 4));
    geometry.instanceCount = count;
    const material = this.makeMaterial(RAIN_VERT, RAIN_FRAG, box, base, {
      uColor: { value: tint.clone() },
      uVel: { value: new THREE.Vector3(2.4, -17, 1.6) },
      uLen: { value: 1.05 },
      uWidth: { value: 1.3 },
      uViewport: this.sharedViewport,
    }, THREE.NormalBlending);
    material.side = THREE.DoubleSide; // the streak quad's winding flips with the screen direction
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 21;
    mesh.layers.set(layer);
    this.group.add(mesh);
    this.layers.push({ object: mesh, material, geometry, zOffset: 2 });
  }

  /** pixelScale = drawing buffer height / (2 tan(fov/2)); viewport in drawing buffer pixels */
  setView(pixelScale: number, vw: number, vh: number, pixelRatio: number): void {
    this.sharedPixel.value = pixelScale;
    this.sharedViewport.value.set(vw, vh);
    for (const l of this.layers) {
      const w = l.material.uniforms.uWidth;
      if (w) w.value = Math.max(1.1, 1.3 * pixelRatio);
    }
  }

  update(time: number, focusX: number, focusZ: number): void {
    this.sharedTime.value = time;
    for (const l of this.layers) (l.material.uniforms.uFocus.value as THREE.Vector3).set(focusX, 0, focusZ + l.zOffset);
  }

  dispose(): void {
    for (const l of this.layers) {
      l.geometry.dispose();
      l.material.dispose();
    }
    this.layers.length = 0;
    this.group.removeFromParent();
  }
}
