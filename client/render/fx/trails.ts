// Power-up trails behind a flying hook head: a flat glowing ribbon laid along the head's recent path.
//   eel    (Bendy Eel, fx bit 4): long, wavy and segmented like an eel, so the curve the hook steered
//          through stays visible for a moment.
//   streak (Long Line, fx bit 8): a short straight comet streak with a white-hot core.
// One ribbon per pooled chain. The CPU rebuilds the strip each frame (at most 2 x 56 vertices, no
// allocation); one small shader draws it additively.
import * as THREE from 'three';

const MAXS = 56;

const VERT = /* glsl */ `
attribute vec4 aData; // along 0..1 (head..tail), across -1..1, alpha, segment phase
varying vec4 vData;
void main() {
  vData = aData;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uCol;
uniform vec3 uCore;
uniform float uTime;
uniform float uKind; // 0 eel, 1 streak
uniform float uAlpha;
varying vec4 vData;
void main() {
  float along = vData.x;
  float across = vData.y;
  float a = vData.z * uAlpha;
  float edge = 1.0 - smoothstep(0.62, 1.0, abs(across));
  float core = exp(-across * across * 7.0);
  vec3 col;
  float cover;
  if (uKind < 0.5) {
    // eel: a glowing body with travelling segment bands, a bright dorsal line and two eyes
    float seg = 0.5 + 0.5 * sin(vData.w * 2.4 - uTime * 10.0);
    float dorsal = exp(-across * across * 30.0);
    float rim = smoothstep(0.45, 0.85, abs(across)) * edge;
    col = mix(uCol * 0.75, uCore, core * 0.45 + seg * 0.25) + uCore * dorsal * 0.9 + uCol * rim * 0.8;
    float eyes = exp(-pow((along - 0.03) / 0.012, 2.0)) * exp(-pow((abs(across) - 0.42) / 0.12, 2.0));
    col = mix(col, vec3(0.02, 0.02, 0.03), eyes * 0.85);
    a *= edge * (0.7 + 0.3 * seg);
    cover = 0.55;
  } else {
    // streak: white-hot core, coloured fringe, flickering
    float fl = 0.85 + 0.15 * sin(along * 40.0 - uTime * 60.0);
    col = mix(uCol, uCore, core) * (1.0 + 1.6 * core) * fl;
    a *= edge * (1.0 - along * 0.5);
    cover = 0.3;
  }
  // part normal coverage so the trail reads on bright water and sand, part additive glow
  gl_FragColor = vec4(col * a, a * cover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export type TrailKind = 'eel' | 'streak';

export class Ribbon {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly data: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly dataAttr: THREE.BufferAttribute;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  /** sample history, newest first */
  private readonly hx = new Float32Array(MAXS);
  private readonly hy = new Float32Array(MAXS);
  private readonly hz = new Float32Array(MAXS);
  private n = 0;
  private kind: TrailKind = 'eel';
  private maxLen = 6;
  private width = 0.3;
  private fade = 0;
  private live = false;

  constructor() {
    this.pos = new Float32Array(MAXS * 2 * 3);
    this.data = new Float32Array(MAXS * 2 * 4);
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.dataAttr = new THREE.BufferAttribute(this.data, 4);
    this.dataAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aData', this.dataAttr);
    const idx: number[] = [];
    for (let i = 0; i < MAXS - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uCol: { value: new THREE.Color() },
        uCore: { value: new THREE.Color() },
        uTime: { value: 0 },
        uKind: { value: 0 },
        uAlpha: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21;
    this.mesh.visible = false;
    this.mesh.name = 'hw-trail';
  }

  /** Start a fresh trail. colours are sRGB hex; HDR boost k. */
  begin(kind: TrailKind, col: number, core: number, k: number): void {
    this.kind = kind;
    this.n = 0;
    this.fade = 1;
    this.live = true;
    this.maxLen = kind === 'eel' ? 7 : 3.4;
    this.width = kind === 'eel' ? 0.36 : 0.34;
    const u = this.mat.uniforms;
    (u.uCol.value as THREE.Color).setHex(col).multiplyScalar(k);
    (u.uCore.value as THREE.Color).setHex(core).multiplyScalar(k * 1.2);
    u.uKind.value = kind === 'eel' ? 0 : 1;
    u.uAlpha.value = 1;
    this.mesh.visible = false;
  }

  stop(): void {
    this.live = false;
    this.n = 0;
    this.fade = 0;
    this.mesh.visible = false;
    this.geo.setDrawRange(0, 0);
  }

  get active(): boolean {
    return this.live;
  }

  /**
   * Per frame. flying = the head is still going out (samples are added); otherwise the trail fades.
   * scale widens the ribbon with the head (Width upgrade).
   */
  update(x: number, y: number, z: number, dt: number, time: number, flying: boolean, scale: number): void {
    if (!this.live) return;
    if (flying) {
      // add a sample once the head has moved far enough from the newest one
      const step = this.kind === 'eel' ? 0.16 : 0.12;
      if (this.n === 0 || Math.hypot(x - this.hx[0], z - this.hz[0]) >= step) {
        for (let i = Math.min(this.n, MAXS - 1); i > 0; i--) {
          this.hx[i] = this.hx[i - 1];
          this.hy[i] = this.hy[i - 1];
          this.hz[i] = this.hz[i - 1];
        }
        this.hx[0] = x;
        this.hy[0] = y;
        this.hz[0] = z;
        if (this.n < MAXS) this.n++;
      }
    } else {
      this.fade -= dt * 3.2;
      if (this.fade <= 0) {
        this.stop();
        return;
      }
    }
    const u = this.mat.uniforms;
    u.uTime.value = time;
    u.uAlpha.value = Math.max(0, Math.min(1, this.fade));
    // build the strip from the head (exact position) back through the samples
    const pos = this.pos;
    const data = this.data;
    let along = 0;
    let px = x;
    let pz = z;
    let count = 0;
    const eel = this.kind === 'eel';
    const W = this.width * scale;
    for (let i = -1; i < this.n && count < MAXS; i++) {
      const sx = i < 0 ? x : this.hx[i];
      const sy = (i < 0 ? y : this.hy[i]) - 0.04;
      const sz = i < 0 ? z : this.hz[i];
      if (i >= 0) along += Math.hypot(sx - px, sz - pz);
      if (along > this.maxLen) break;
      // direction toward the head (or the next sample) and its perpendicular in XZ
      const j = Math.min(this.n - 1, i + 1);
      let dx: number;
      let dz: number;
      if (i < 0) {
        dx = this.n > 0 ? x - this.hx[0] : 0;
        dz = this.n > 0 ? z - this.hz[0] : 1;
        if (Math.abs(dx) + Math.abs(dz) < 1e-4 && this.n > 1) {
          dx = this.hx[0] - this.hx[1];
          dz = this.hz[0] - this.hz[1];
        }
      } else {
        dx = (i === 0 ? x : this.hx[i - 1]) - (j > i ? this.hx[j] : sx);
        dz = (i === 0 ? z : this.hz[i - 1]) - (j > i ? this.hz[j] : sz);
      }
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l;
      const nz = dx / l;
      const t = along / this.maxLen;
      let wave = 0;
      let w: number;
      if (eel) {
        // head swells, body tapers to a thin tail; the body undulates
        const env = Math.sin(Math.min(1, t * 1.4) * Math.PI) * 0.9 + 0.1;
        wave = Math.sin(along * 1.9 - time * 9) * 0.38 * scale * Math.min(1, t * 6) * (1 - t * 0.35);
        w = W * (t < 0.06 ? 0.7 + t * 5 : (1 - t) * 1.05 + 0.08) * (0.65 + 0.35 * env);
      } else {
        w = W * (1 - t) * (t < 0.04 ? 0.6 + t * 10 : 1);
      }
      const cx = sx + nx * wave;
      const cz = sz + nz * wave;
      const o = count * 6;
      pos[o] = cx + nx * w;
      pos[o + 1] = sy;
      pos[o + 2] = cz + nz * w;
      pos[o + 3] = cx - nx * w;
      pos[o + 4] = sy;
      pos[o + 5] = cz - nz * w;
      const fadeA = Math.min(1, t < 0.02 ? 1 : (1 - t) * 1.6);
      const d = count * 8;
      data[d] = t;
      data[d + 1] = 1;
      data[d + 2] = fadeA;
      data[d + 3] = along * 3;
      data[d + 4] = t;
      data[d + 5] = -1;
      data[d + 6] = fadeA;
      data[d + 7] = along * 3;
      count++;
      px = sx;
      pz = sz;
    }
    this.posAttr.clearUpdateRanges();
    this.dataAttr.clearUpdateRanges();
    if (count < 2) {
      this.mesh.visible = false;
      return;
    }
    this.posAttr.addUpdateRange(0, count * 6);
    this.dataAttr.addUpdateRange(0, count * 8);
    this.posAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
    this.geo.setDrawRange(0, (count - 1) * 6);
    this.mesh.visible = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
