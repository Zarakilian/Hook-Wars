// Ring buffer of ripple sources (splashes, drownings, hook drags, wakes) packed into shader uniforms.
import * as THREE from 'three';

export const MAX_RIPPLES = 24;

export class Ripples {
  readonly x = new Float32Array(MAX_RIPPLES);
  readonly z = new Float32Array(MAX_RIPPLES);
  readonly t0 = new Float32Array(MAX_RIPPLES);
  readonly s = new Float32Array(MAX_RIPPLES);
  readonly r = new Float32Array(MAX_RIPPLES);
  /** 1 = ambient (waterfall churn, plips): never pushes out a gameplay splash */
  readonly amb = new Uint8Array(MAX_RIPPLES);
  /** most ambient ripples alive at once */
  maxAmbient = 7;
  /** shader data: (x, z, age, strength) and radius, compacted to the live ones */
  readonly uA: THREE.Vector4[] = [];
  readonly uR: number[] = [];
  count = 0;
  private now = 0;
  limit = MAX_RIPPLES;

  constructor() {
    for (let i = 0; i < MAX_RIPPLES; i++) {
      this.t0[i] = -1e4;
      this.uA.push(new THREE.Vector4(0, 0, 1e4, 0));
      this.uR.push(1);
    }
  }

  static life(radius: number, strength: number): number {
    return 1.6 + radius * 0.55 + strength * 1.2;
  }

  add(x: number, z: number, strength: number, radius: number, ambient = false): void {
    const now = this.now;
    const st = Math.max(0.02, Math.min(1.5, strength));
    const rad = Math.max(0.2, Math.min(4, radius));
    // merge rapid repeats at the same spot (hook drags, wakes called every frame)
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const age = now - this.t0[i];
      if (age > 0.16) continue;
      const dx = this.x[i] - x;
      const dz = this.z[i] - z;
      if (dx * dx + dz * dz < 0.36) {
        this.s[i] = Math.min(1.5, Math.max(this.s[i], st) + st * 0.15);
        this.r[i] = Math.max(this.r[i], rad);
        if (!ambient) this.amb[i] = 0;
        return;
      }
    }
    let liveAmb = 0;
    let oldestAmb = -1;
    let oldestAge = -1;
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const age = now - this.t0[i];
      if (this.amb[i] && age <= Ripples.life(this.r[i], this.s[i])) {
        liveAmb++;
        if (age > oldestAge) {
          oldestAge = age;
          oldestAmb = i;
        }
      }
    }
    let best = -1;
    if (ambient && liveAmb >= this.maxAmbient) best = oldestAmb;
    else {
      // free slot first, else the one with the least energy left (ambient ones count for half)
      let bestE = Infinity;
      for (let i = 0; i < MAX_RIPPLES; i++) {
        const age = now - this.t0[i];
        const life = Ripples.life(this.r[i], this.s[i]);
        let e = age >= life ? -1 : this.s[i] * (1 - age / life) * (this.amb[i] ? 0.5 : 1);
        if (ambient && e >= 0 && !this.amb[i]) e = Infinity;
        if (e < bestE) {
          bestE = e;
          best = i;
        }
      }
      if (bestE === Infinity) best = -1;
    }
    if (best < 0) return;
    this.x[best] = x;
    this.z[best] = z;
    this.t0[best] = now;
    this.s[best] = st;
    this.r[best] = rad;
    this.amb[best] = ambient ? 1 : 0;
  }

  /** Advance the clock and repack live ripples (newest and strongest first if over the limit). */
  update(now: number): void {
    this.now = now;
    let n = 0;
    // gameplay ripples first so a low tier's limit never drops a splash in favour of ambience
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < MAX_RIPPLES && n < this.limit; i++) {
        if (this.amb[i] !== pass) continue;
        const age = now - this.t0[i];
        if (age < 0 || age > Ripples.life(this.r[i], this.s[i])) continue;
        this.uA[n].set(this.x[i], this.z[i], age, this.s[i]);
        // negative radius tells the shader this is ambient churn: waves only, no crisp foam rings
        this.uR[n] = this.amb[i] ? -this.r[i] : this.r[i];
        n++;
      }
    }
    for (let i = n; i < MAX_RIPPLES; i++) this.uA[i].set(0, 0, 1e4, 0);
    this.count = n;
  }

  get time(): number {
    return this.now;
  }
}

/** GLSL ripple field: height, slope and foam from all live sources. Needs uRip, uRipR, uRipN. */
export const RIPPLE_GLSL = /* glsl */ `
uniform vec4 uRip[${MAX_RIPPLES}];
uniform float uRipR[${MAX_RIPPLES}];
uniform int uRipN;

// out: x = height, yz = slope (d/dx, d/dz), w = foam
vec4 rippleField(vec2 p, bool withFoam) {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    if (i >= uRipN) break;
    vec4 r = uRip[i];
    float rad = abs(uRipR[i]);
    float gameplay = step(0.0, uRipR[i]);
    float age = r.z;
    vec2 d = p - r.xy;
    float dist = length(d) + 1e-4;
    float speed = 1.6 + rad * 0.55;
    float front = age * speed;
    float reach = front + rad * 1.4 + 1.2;
    if (dist > reach) continue;
    float life = 1.6 + rad * 0.55 + r.w * 1.2;
    float fade = (1.0 - age / life);
    fade *= fade;
    float k = 6.2832 / (0.7 + rad * 0.3);
    float x = dist - front;
    float w = 0.35 + rad * 0.25 + age * 0.3;
    // trailing wave train behind the front
    float env = exp(-(x * x) / (w * w)) * step(-w * 3.0, x) + 0.0;
    env += exp(-max(-x, 0.0) * 1.2) * step(x, 0.0) * 0.35 * smoothstep(-w * 4.0, 0.0, x);
    float a = 0.11 * r.w * fade * env / (1.0 + front * 0.3);
    float c = cos(k * x);
    float s = sin(k * x);
    acc.x += a * c;
    vec2 dir = d / dist;
    acc.yz += dir * (-a * k * s);
    if (withFoam) {
      // white ring right at the front while young, plus a churned patch at the centre.
      // The ring is torn into arcs (angular breakup, different per ripple) so it never reads as a
      // perfect drawn circle, and it thins out as it expands.
      float young = 1.0 - smoothstep(0.0, 0.9 + rad * 0.3, age);
      float ang = atan(d.y, d.x);
      float seed = fract(r.x * 0.731 + r.y * 0.457) * 6.2832;
      float tear = 0.55 + 0.45 * sin(ang * 5.0 + seed) * sin(ang * 3.0 - seed * 1.7 + age * 1.3);
      tear = smoothstep(0.15, 0.85, tear);
      float ring = exp(-pow(x / (0.09 + rad * 0.06), 2.0)) * young * min(r.w * 1.6, 1.0) * tear;
      // second, fainter ring trailing the first
      float x2 = x + 0.9 / k * 6.2832;
      float ring2 = exp(-pow(x2 / (0.07 + rad * 0.04), 2.0)) * young * min(r.w * 1.6, 1.0) * 0.5 * (1.0 - tear * 0.6);
      float burst = 1.0 - smoothstep(0.0, 0.45 + rad * 0.15, age);
      float core = (1.0 - smoothstep(0.0, rad * (0.55 + burst * 0.4) + 0.15, dist)) * (1.0 - smoothstep(0.0, 1.3 + rad * 0.5, age)) * min(r.w * 1.4, 1.0);
      // ambient churn (waterfall base, plips) only roughs up the water: a faint core, no rings
      acc.w += (ring * 0.95 + ring2) * gameplay + core * (0.8 + burst * 0.6) * mix(0.25, 1.0, gameplay);
    }
  }
  return acc;
}
`;
