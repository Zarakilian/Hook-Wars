// Cinematic post (only built while cinematic mode is on; see client/render/cinematic.ts).
//
// CinematicPass runs between the scene pass and the final EffectPass, in HDR:
//   1. mist march (shaftScale resolution): rays from the camera through a low slab of height mist,
//      each step lit by the sun / moon through the sun shadow map (light shafts) plus a sky ambient,
//      plus closed-form in-scatter around each pooled lantern light (glow in the mist and rain)
//   2. depth of field (half resolution): downsample with a circle of confusion, separable blur. In a
//      match it is a tilt-shift that never blurs play; on the Epic menu stage (menuFocus) it is a plain
//      depth of field around the posed Lunker: the Lunker sharp, the town, lighthouse and peaks soft
//   3. composite (full resolution): tilt-shift blend, depth rim / back light, mist (bilateral upsample)
// LookGradeEffect runs last in the EffectPass, after GradeEffect: split toning, S-curve, vibrance.
//
// Depth is the opaque capture depth (targets.depth): water is not in it, so rays stop at the water
// plane instead (CineMist.waterY), which also keeps the rim and the blur from seeing the river bed.
import * as THREE from 'three';
import { BlendFunction, Effect, Pass } from 'postprocessing';
import type { CinematicConfig } from '../cinematic.ts';
import type { CineLook } from '../look/grade.ts';
import type { LanternRig } from '../look/lanterns.ts';
import type { CaptureTargets } from './post.ts';

const MAX_LIGHTS = 16;
/** menu stage depth of field: in-focus depth around the Lunker (m), blur ramp as a fraction of the focus distance, radius scale */
const MENU_DOF_RANGE = 1.5;
const MENU_DOF_RAMP = 0.6;
const MENU_DOF_RADIUS = 1.6;

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/** depth -> world helpers shared by the march and the composite */
const DEPTH_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec2 uNearFar;
uniform float uWaterY;
// view-space depth (metres along the view axis) of a depth buffer value
float hwViewZ(float d) {
  float n = uNearFar.x;
  float f = uNearFar.y;
  return (n * f) / (f - d * (f - n));
}
// world ray direction through uv, and the distance to the first opaque surface or the water plane
float hwRay(vec2 uv, out vec3 rd) {
  float d = texture2D(tDepth, uv).r;
  vec4 vp = uProjInv * vec4(uv * 2.0 - 1.0, min(d, 0.999999) * 2.0 - 1.0, 1.0);
  vp /= vp.w;
  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
  vec3 r = wp - uCamPos;
  float t = length(r);
  rd = r / max(t, 1e-4);
  if (d >= 0.999999) t = 400.0;
  if (rd.y < -1e-4) {
    float tw = (uWaterY - uCamPos.y) / rd.y;
    if (tw > 0.0) t = min(t, tw);
  }
  return t;
}
`;

const NOISE_GLSL = /* glsl */ `
float hwH12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hwN2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hwH12(i), hwH12(i + vec2(1.0, 0.0)), u.x), mix(hwH12(i + vec2(0.0, 1.0)), hwH12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const MARCH_FRAG = /* glsl */ `
${DEPTH_GLSL}
${NOISE_GLSL}
uniform vec4 uMist;      // density, falloff, base, top
uniform vec3 uMistAmb;
uniform vec3 uMistSun;
uniform vec3 uSunDir;
uniform vec3 uMistMisc;  // g, patchy, time
uniform vec2 uRiver[9];  // river centre x and half width at 9 evenly spaced z
uniform vec3 uRiverZ;    // first z, z step, mist density far from the river (fraction)
uniform vec2 uLowRes;
#ifdef HW_SHADOW
uniform sampler2DShadow tShadow;
uniform mat4 uShadowMat;
uniform float uShadowBias;
#endif
#if HW_LIGHTS > 0
uniform vec4 uLPos[HW_LIGHTS];
uniform vec3 uLCol[HW_LIGHTS];
uniform float uLGlow;
#endif
varying vec2 vUv;

// the mist gathers over the river and thins out over the banks (as in the references)
float hwRiverW(vec3 p) {
  float fi = clamp((p.z - uRiverZ.x) / uRiverZ.y, 0.0, 7.999);
  int i = int(fi);
  vec2 a = mix(uRiver[i], uRiver[i + 1], fract(fi));
  float d = abs(p.x - a.x) - a.y;
  return mix(1.0, uRiverZ.z, smoothstep(-1.0, 10.0, d));
}

float hwDensity(vec3 p) {
  float h = max(p.y - uMist.z, 0.0);
  float d = uMist.x * exp(-h / uMist.y) * hwRiverW(p);
  vec2 w = vec2(0.31, 0.12) * uMistMisc.z;
  float n = hwN2(p.xz * 0.055 + w) * 0.65 + hwN2(p.xz * 0.16 - w * 1.7) * 0.35;
  return d * mix(1.0, 0.2 + 1.6 * n, uMistMisc.y);
}

void main() {
  vec3 rd;
  float tMax = hwRay(vUv, rd);
  vec3 ro = uCamPos;
  vec3 S = vec3(0.0);
  float T = 1.0;
#ifdef HW_MIST
  float yb = uMist.z - 1.0;
  float yt = uMist.w;
  float t0 = 0.0;
  float t1 = tMax;
  if (abs(rd.y) > 1e-4) {
    float ta = (yt - ro.y) / rd.y;
    float tb = (yb - ro.y) / rd.y;
    t0 = max(t0, min(ta, tb));
    t1 = min(t1, max(ta, tb));
  } else if (ro.y > yt || ro.y < yb) {
    t1 = -1.0;
  }
  if (t1 > t0) {
    float g = uMistMisc.x;
    float mu = dot(rd, uSunDir);
    float ph = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * mu, 1e-3), 1.5);
    float dt = (t1 - t0) / float(HW_STEPS);
    // interleaved gradient noise: static per pixel, hidden by the upsample
    float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float t = t0 + dt * jit;
    for (int i = 0; i < HW_STEPS; i++) {
      vec3 p = ro + rd * t;
      float dn = hwDensity(p);
      float vis = 1.0;
#ifdef HW_SHADOW
      vec4 sc = uShadowMat * vec4(p, 1.0);
      if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0) vis = texture(tShadow, vec3(sc.xy, sc.z + uShadowBias));
#endif
      vec3 L = uMistAmb + uMistSun * (ph * vis);
      float a = exp(-dn * dt);
      S += T * L * (1.0 - a);
      T *= a;
      t += dt;
    }
  }
#endif
#if HW_LIGHTS > 0
  // lantern glow: single scattering of a point light along the whole ray, closed form
  for (int i = 0; i < HW_LIGHTS; i++) {
    vec4 lp = uLPos[i];
    vec3 oc = lp.xyz - ro;
    float tc = dot(oc, rd);
    vec3 pr = oc - rd * tc;
    float h = sqrt(dot(pr, pr) + 0.06);
    float I = (atan((tMax - tc) / h) + atan(tc / h)) / h;
    float dl = uMist.x * exp(-max(lp.y - uMist.z, 0.0) / uMist.y) + 0.012;
    float fall = 1.0 - smoothstep(lp.w * 0.2, lp.w * 0.8, h);
    S += uLCol[i] * (I * dl * fall * uLGlow * 0.0796);
  }
#endif
  gl_FragColor = vec4(S, T);
}
`;

const COC_GLSL = /* glsl */ `
uniform vec4 uDof;  // focus distance, in-focus range (m), band start (0..1 from the centre), blur radius in full-res px at coc 1
uniform vec4 uPlay; // play rectangle half width and half depth, bank top y, blur ramp outside it (m)
uniform vec2 uDofMenu; // x 1 = the menu stage's depth of field (no play rectangle), y = blur ramp beyond the in-focus range (m)
// Miniature (tilt-shift) depth of field that never touches play: inside the play rectangle nothing
// below ~3.5 m above the bank (units, hooks, low props) is ever blurred. Outside it (the backdrop
// scenery past the map edge) the blur grows with the distance out; tall props far from the focus
// depth (right under the camera, or far beyond it) soften too. Stronger toward the top and bottom.
float hwCoc(vec2 uv, float dist, vec3 wp) {
  float edge = abs(uv.y - 0.5) * 2.0;
  float sy = smoothstep(uDof.z, 1.0, edge);
  if (uDofMenu.x > 0.5) {
    // the menu stage: sharp within uDof.y of the posed Lunker, softening over uDofMenu.y beyond that
    return clamp((abs(dist - uDof.x) - uDof.y) / uDofMenu.y, 0.0, 1.0) * mix(0.85, 1.0, sy);
  }
  vec2 o = abs(wp.xz) - uPlay.xy;
  float outside = smoothstep(0.0, uPlay.w, max(o.x, o.y));
  float dz = clamp((abs(dist - uDof.x) - uDof.y) / (uDof.x * 0.5), 0.0, 1.0);
  float tall = smoothstep(uPlay.z + 3.4, uPlay.z + 5.0, wp.y);
  return max(outside, dz * tall) * mix(0.6, 1.0, sy);
}
`;

const DOWN_FRAG = /* glsl */ `
${DEPTH_GLSL}
${COC_GLSL}
uniform sampler2D tColor;
uniform vec2 uSrcTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tColor, vUv + uSrcTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tColor, vUv + uSrcTexel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tColor, vUv + uSrcTexel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tColor, vUv + uSrcTexel * vec2(0.5, 0.5)).rgb;
  vec3 rd;
  float dist = hwRay(vUv, rd);
  gl_FragColor = vec4(c * 0.25, hwCoc(vUv, dist, uCamPos + rd * dist));
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;     // texel step along the blur axis
uniform float uMaxR;   // radius in texels at coc = 1
varying vec2 vUv;
void main() {
  vec4 c0 = texture2D(tSrc, vUv);
  float r = c0.a * uMaxR;
  vec3 acc = c0.rgb;
  float ws = 1.0;
  for (int i = 1; i <= 4; i++) {
    float fi = float(i) / 4.0;
    float g = exp(-fi * fi * 2.0);
    vec2 o = uDir * (fi * r);
    vec4 a = texture2D(tSrc, vUv + o);
    vec4 b = texture2D(tSrc, vUv - o);
    // sharp pixels do not bleed into the blurred ones
    float wa = g * clamp(a.a * 3.0, 0.0, 1.0);
    float wb = g * clamp(b.a * 3.0, 0.0, 1.0);
    acc += a.rgb * wa + b.rgb * wb;
    ws += wa + wb;
  }
  gl_FragColor = vec4(acc / ws, c0.a);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${DEPTH_GLSL}
${COC_GLSL}
uniform sampler2D tColor;
uniform sampler2D tFog;
uniform sampler2D tDof;
uniform vec2 uTexel;
uniform vec2 uFogTexel;
uniform vec3 uRimColor;
uniform vec2 uRim;      // strength, offset in pixels
uniform vec2 uGate;     // mist on, blur on (0 in the menu)
varying vec2 vUv;

vec4 hwFogUp(vec2 uv, float zc) {
  vec2 lp = uv / uFogTexel - 0.5;
  vec2 f = fract(lp);
  vec2 b = (floor(lp) + 0.5) * uFogTexel;
  vec2 o = uFogTexel;
  vec4 s0 = texture2D(tFog, b);
  vec4 s1 = texture2D(tFog, b + vec2(o.x, 0.0));
  vec4 s2 = texture2D(tFog, b + vec2(0.0, o.y));
  vec4 s3 = texture2D(tFog, b + o);
  float z0 = hwViewZ(texture2D(tDepth, b).r);
  float z1 = hwViewZ(texture2D(tDepth, b + vec2(o.x, 0.0)).r);
  float z2 = hwViewZ(texture2D(tDepth, b + vec2(0.0, o.y)).r);
  float z3 = hwViewZ(texture2D(tDepth, b + o).r);
  float k = 12.0 / max(zc, 1.0);
  vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  w *= 1.0 / (1.0 + k * abs(vec4(z0, z1, z2, z3) - zc));
  w += 1e-4;
  return (s0 * w.x + s1 * w.y + s2 * w.z + s3 * w.w) / (w.x + w.y + w.z + w.w);
}

void main() {
  vec4 c = texture2D(tColor, vUv);
  vec3 rd;
  float dist = hwRay(vUv, rd);
#ifdef HW_DOF
  {
    vec4 b = texture2D(tDof, vUv);
    // swap to the half-resolution blur only where the blur radius is well above a pixel
    float rpx = hwCoc(vUv, dist, uCamPos + rd * dist) * uDof.w;
    c.rgb = mix(c.rgb, b.rgb, smoothstep(0.9, 2.2, rpx) * uGate.y);
  }
#endif
#ifdef HW_RIM
  {
    // a surface pixel whose neighbours above it are much farther is a top silhouette edge: back light
    vec2 px = uTexel * uRim.y;
    vec3 r1;
    float d1 = hwRay(vUv + vec2(0.0, px.y), r1);
    float d2 = hwRay(vUv + vec2(px.x, px.y) * 0.75, r1);
    float d3 = hwRay(vUv + vec2(-px.x, px.y) * 0.75, r1);
    float th = 0.9 + dist * 0.02;
    float m = smoothstep(th, th * 3.0, max(d1, max(d2, d3)) - dist);
    m *= 1.0 - smoothstep(90.0, 160.0, dist);
    // only things standing in play near the ground (Lunkers, hooks, low props): tall props, buildings
    // and the backdrop past the map edge would get a drawn outline instead of a back light
    vec3 wp = uCamPos + rd * dist;
    vec2 po = abs(wp.xz) - uPlay.xy;
    m *= (1.0 - smoothstep(-1.0, 0.5, max(po.x, po.y))) * (1.0 - smoothstep(uPlay.z + 2.4, uPlay.z + 3.4, wp.y));
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    c.rgb += uRimColor * (m * uRim.x) * (0.25 + min(l, 2.0));
  }
#endif
#ifdef HW_FOG
  {
    vec4 f = hwFogUp(vUv, hwViewZ(texture2D(tDepth, vUv).r));
    c.rgb = mix(c.rgb, c.rgb * f.a + f.rgb, uGate.x);
  }
#endif
  gl_FragColor = c;
}
`;

function fsMaterial(name: string, frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string | number> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    uniforms,
    defines,
    vertexShader: FS_VERT,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
}

function lowTarget(w: number, h: number, name: string): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.name = name;
  return rt;
}

export interface CineTimer {
  begin(label: string): void;
  end(): void;
}

/** Fog, shafts, lantern glow, depth of field and rim, between the scene pass and the EffectPass. */
export class CinematicPass extends Pass {
  private readonly view: THREE.PerspectiveCamera;
  private readonly targets: CaptureTargets;
  private readonly sun: THREE.DirectionalLight;
  private readonly cfg: CinematicConfig;
  private lanterns: LanternRig | null;
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly marchMat: THREE.ShaderMaterial;
  private readonly marchMatNoShadow: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly compMat: THREE.ShaderMaterial;
  private readonly fogRT: THREE.WebGLRenderTarget;
  private readonly dofA: THREE.WebGLRenderTarget;
  private readonly dofB: THREE.WebGLRenderTarget;
  private readonly lPos: THREE.Vector4[] = [];
  private readonly lCol: THREE.Vector3[] = [];
  private readonly focus = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private look: CineLook | null = null;
  private hasMap = false;
  private time = 0;
  private fullW = 1;
  private fullH = 1;
  /**
   * The Epic menu stage is showing (no map): the depth of field runs as a plain depth of field around
   * the focus point (the stage anchor, where the Lunker stands) instead of staying off. Set per frame.
   */
  menuFocus = false;
  /** optional GPU timer (profiling) */
  timer: CineTimer | null = null;

  constructor(camera: THREE.PerspectiveCamera, targets: CaptureTargets, sun: THREE.DirectionalLight, cfg: CinematicConfig, lanterns: LanternRig | null) {
    super('HW.CinematicPass');
    this.view = camera;
    this.targets = targets;
    this.sun = sun;
    this.cfg = cfg;
    this.lanterns = lanterns;
    this.needsSwap = true;
    // glow slots for the largest pool the config allows (the pool itself is resized per map)
    const nl = cfg.lights && cfg.lanternGlow ? Math.min(MAX_LIGHTS, cfg.lightBudget) : 0;
    for (let i = 0; i < Math.max(1, nl); i++) {
      this.lPos.push(new THREE.Vector4(0, -1000, 0, 1));
      this.lCol.push(new THREE.Vector3());
    }
    this.shared = {
      tDepth: { value: targets.depth },
      uProjInv: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uNearFar: { value: new THREE.Vector2(1, 400) },
      uWaterY: { value: -1e3 },
      uDof: { value: new THREE.Vector4(40, 6, 0.7, 0) },
      uPlay: { value: new THREE.Vector4(1e4, 1e4, 0, 6) },
      uDofMenu: { value: new THREE.Vector2(0, 4) },
    };
    const marchU = (): Record<string, THREE.IUniform> => ({
      ...this.shared,
      uMist: { value: new THREE.Vector4(0.04, 1.5, 0, 6) },
      uMistAmb: { value: new THREE.Color() },
      uMistSun: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMistMisc: { value: new THREE.Vector3(0.4, 0.5, 0) },
      uRiver: { value: Array.from({ length: 9 }, () => new THREE.Vector2(0, 4)) },
      uRiverZ: { value: new THREE.Vector3(-24, 6, 1) },
      uLowRes: { value: new THREE.Vector2(1, 1) },
      tShadow: { value: null },
      uShadowMat: { value: new THREE.Matrix4() },
      uShadowBias: { value: 0 },
      uLPos: { value: this.lPos },
      uLCol: { value: this.lCol },
      uLGlow: { value: 1 },
    });
    const marchDefs = (shadow: boolean): Record<string, string | number> => {
      const d: Record<string, string | number> = { HW_STEPS: cfg.shaftSteps, HW_LIGHTS: nl };
      if (cfg.mist || cfg.shafts) d.HW_MIST = '';
      if (shadow && cfg.shafts) d.HW_SHADOW = '';
      return d;
    };
    this.marchMat = fsMaterial('HW.CineMarch', MARCH_FRAG, marchU(), marchDefs(true));
    this.marchMatNoShadow = fsMaterial('HW.CineMarchNoShadow', MARCH_FRAG, marchU(), marchDefs(false));
    // share the per-frame uniform objects between both march variants
    for (const k of Object.keys(this.marchMat.uniforms)) this.marchMatNoShadow.uniforms[k] = this.marchMat.uniforms[k];
    this.downMat = fsMaterial('HW.CineDofDown', DOWN_FRAG, { ...this.shared, tColor: { value: null }, uSrcTexel: { value: new THREE.Vector2() } });
    this.blurMat = fsMaterial('HW.CineDofBlur', BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() }, uMaxR: { value: 4 } });
    const compDefs: Record<string, string> = {};
    if (cfg.dof && cfg.dofRadius > 0) compDefs.HW_DOF = '';
    if (cfg.rim) compDefs.HW_RIM = '';
    if (cfg.mist || cfg.shafts || nl > 0) compDefs.HW_FOG = '';
    this.compMat = fsMaterial(
      'HW.CineComposite',
      COMPOSITE_FRAG,
      {
        ...this.shared,
        tColor: { value: null },
        tFog: { value: null },
        tDof: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uFogTexel: { value: new THREE.Vector2() },
        uRimColor: { value: new THREE.Color() },
        uRim: { value: new THREE.Vector2(1, 2.5) },
        uGate: { value: new THREE.Vector2(1, 1) },
      },
      compDefs,
    );
    this.fogRT = lowTarget(1, 1, 'HW.CineFog');
    this.dofA = lowTarget(1, 1, 'HW.CineDofA');
    this.dofB = lowTarget(1, 1, 'HW.CineDofB');
    this.fullscreenMaterial = this.compMat;
  }

  get fogOn(): boolean {
    return 'HW_FOG' in (this.compMat.defines as object);
  }

  get dofOn(): boolean {
    return 'HW_DOF' in (this.compMat.defines as object);
  }

  /** the lantern pool whose lights glow in the mist (resized per map by the engine) */
  setLanterns(rig: LanternRig | null): void {
    this.lanterns = rig;
  }

  /** per map (null = menu: the pass only grades, no mist) */
  apply(look: CineLook | null, hasMap: boolean): void {
    this.look = look;
    this.hasMap = hasMap;
    if (!look) return;
    const u = this.marchMat.uniforms;
    const m = look.mist;
    (u.uMist.value as THREE.Vector4).set(m.density, m.falloff, m.base, m.top);
    (u.uMistAmb.value as THREE.Color).copy(m.ambient);
    (u.uMistSun.value as THREE.Color).copy(m.sun);
    (u.uMistMisc.value as THREE.Vector3).set(m.g, m.patchy, 0);
    const rv = u.uRiver.value as THREE.Vector2[];
    for (let i = 0; i < rv.length; i++) rv[i].set(m.river[i * 2] ?? 0, m.river[i * 2 + 1] ?? 1e3);
    (u.uRiverZ.value as THREE.Vector3).set(m.riverZ0, m.riverDz, m.bankMist);
    (this.shared.uPlay.value as THREE.Vector4).set(look.play.x, look.play.y, look.play.z, look.play.w);
    u.uLGlow.value = m.lanternGlow;
    this.shared.uWaterY.value = m.waterY;
    (this.compMat.uniforms.uRimColor.value as THREE.Color).copy(look.rimColor);
    (this.compMat.uniforms.uRim.value as THREE.Vector2).x = look.rim;
  }

  /** per frame, before render: the point the camera looks at (tilt-shift focus) and the clock */
  update(time: number, focusX: number, focusY: number, focusZ: number): void {
    this.time = time;
    this.focus.set(focusX, focusY, focusZ);
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null, outputBuffer: THREE.WebGLRenderTarget | null): void {
    if (!inputBuffer) return;
    const cam = this.view;
    const sh = this.shared;
    (sh.uProjInv.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (sh.uCamWorld.value as THREE.Matrix4).copy(cam.matrixWorld);
    (sh.uCamPos.value as THREE.Vector3).setFromMatrixPosition(cam.matrixWorld);
    (sh.uNearFar.value as THREE.Vector2).set(cam.near, cam.far);
    sh.tDepth.value = this.targets.depth;
    const camPos = sh.uCamPos.value as THREE.Vector3;
    const fd = this.tmp.copy(this.focus).sub(camPos).length();
    const dof = sh.uDof.value as THREE.Vector4;
    const menu = this.menuFocus && !this.hasMap;
    // the menu stage: the Lunker (about a metre deep) in focus, a stronger blur on the set behind it
    const radius = this.cfg.dofRadius * (menu ? MENU_DOF_RADIUS : 1);
    dof.set(fd, menu ? MENU_DOF_RANGE : fd * 0.3, 0.7, radius * (this.fullH / 1080));
    (sh.uDofMenu.value as THREE.Vector2).set(menu ? 1 : 0, menu ? Math.max(1, fd * MENU_DOF_RAMP) : 4);
    const timer = this.timer;

    // 1. mist / shafts / lantern glow
    const fogOn = this.fogOn && this.hasMap;
    if (fogOn) {
      if (timer) timer.begin('cine.mist');
      const map = this.sun.castShadow && this.sun.shadow.map ? this.sun.shadow.map.depthTexture : null;
      const mat = map && this.cfg.shafts ? this.marchMat : this.marchMatNoShadow;
      const u = mat.uniforms;
      u.tShadow.value = map;
      (u.uShadowMat.value as THREE.Matrix4).copy(this.sun.shadow.matrix);
      u.uShadowBias.value = this.sun.shadow.bias;
      (u.uSunDir.value as THREE.Vector3).copy(this.sun.position).sub(this.sun.target.position).normalize();
      (u.uMistMisc.value as THREE.Vector3).z = this.time;
      if (this.lanterns) this.lanterns.fill(this.lPos, this.lCol);
      else for (let i = 0; i < this.lPos.length; i++) this.lCol[i].set(0, 0, 0);
      this.fullscreenMaterial = mat;
      renderer.setRenderTarget(this.fogRT);
      renderer.render(this.scene, this.camera);
      if (timer) timer.end();
    }

    // 2. depth of field
    const dofOn = this.dofOn && (this.hasMap || menu);
    if (dofOn) {
      if (timer) timer.begin('cine.dof');
      const du = this.downMat.uniforms;
      du.tColor.value = inputBuffer.texture;
      (du.uSrcTexel.value as THREE.Vector2).set(1 / this.fullW, 1 / this.fullH);
      this.fullscreenMaterial = this.downMat;
      renderer.setRenderTarget(this.dofA);
      renderer.render(this.scene, this.camera);
      const bu = this.blurMat.uniforms;
      // radius: cfg.dofRadius pixels at 1080p (menu stage: MENU_DOF_RADIUS times that), in half-resolution texels
      bu.uMaxR.value = (radius * (this.fullH / 1080)) * 0.5;
      bu.tSrc.value = this.dofA.texture;
      (bu.uDir.value as THREE.Vector2).set(1 / this.dofA.width, 0);
      this.fullscreenMaterial = this.blurMat;
      renderer.setRenderTarget(this.dofB);
      renderer.render(this.scene, this.camera);
      bu.tSrc.value = this.dofB.texture;
      (bu.uDir.value as THREE.Vector2).set(0, 1 / this.dofA.height);
      renderer.setRenderTarget(this.dofA);
      renderer.render(this.scene, this.camera);
      if (timer) timer.end();
    }

    // 3. composite
    if (timer) timer.begin('cine.composite');
    const cu = this.compMat.uniforms;
    cu.tColor.value = inputBuffer.texture;
    cu.tFog.value = this.fogRT.texture;
    cu.tDof.value = this.dofA.texture;
    (cu.uTexel.value as THREE.Vector2).set(1 / this.fullW, 1 / this.fullH);
    (cu.uFogTexel.value as THREE.Vector2).set(1 / this.fogRT.width, 1 / this.fogRT.height);
    (cu.uRim.value as THREE.Vector2).set(this.hasMap && this.look ? this.look.rim : 0, 2.5 * Math.max(1, this.fullH / 1080));
    // the menu has no mist (and no blur unless the stage is up): gate those blocks off (their inputs are stale there)
    (cu.uGate.value as THREE.Vector2).set(fogOn ? 1 : 0, dofOn ? 1 : 0);
    this.fullscreenMaterial = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
    if (timer) timer.end();
  }

  override setSize(width: number, height: number): void {
    this.fullW = Math.max(1, width);
    this.fullH = Math.max(1, height);
    const s = this.cfg.shaftScale;
    this.fogRT.setSize(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)));
    this.dofA.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
    this.dofB.setSize(this.dofA.width, this.dofA.height);
  }

  override dispose(): void {
    // only our own resources: the depth and shadow textures belong to the engine
    this.marchMat.dispose();
    this.marchMatNoShadow.dispose();
    this.downMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.fogRT.dispose();
    this.dofA.dispose();
    this.dofB.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Cinematic grade (display-referred, after GradeEffect)
// ---------------------------------------------------------------------------------------------

const LOOK_GRADE_FRAG = /* glsl */ `
uniform vec4 hwlShadow; // rgb = shadow hue (luma 1), a = lean
uniform vec4 hwlHigh;   // rgb = highlight hue (luma 1), a = lean
uniform vec4 hwlCurve;  // curve, black, vibrance, warm saturation
uniform vec4 hwlMisc;   // shadow desaturation, complementary split, exposure, extra vignette
uniform vec2 hwlRange;  // luma where the highlight lean starts and where it is full
uniform vec2 hwlTeam;   // team-colour guard: x = warm lean and orange split kept off team red, y = share of the shadow desaturation / teal lean kept off it
const vec3 HWL_LUMA = vec3(0.2126, 0.7152, 0.0722);
// lean a colour toward a luma-1 hue while keeping its luma
vec3 hwlLean(vec3 g, vec3 h, float k) {
  return mix(g, h * dot(g, HWL_LUMA), k);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 g = pow(max(inputColor.rgb * hwlMisc.z, vec3(0.0)), vec3(1.0 / 2.2));
  float l = dot(g, HWL_LUMA);
  float mx = max(g.r, max(g.g, g.b));
  float mn = min(g.r, min(g.g, g.b));
  float sat = mx - mn;
  // team red (the Red Tide's rims, rings, trims and glow): a saturated red whose hue sits at pure red or
  // past it toward magenta (green no higher than about blue). Measured on the colour as it arrives, before
  // any lean. The warm lean and the orange split below would turn it lantern orange (the night grade made
  // the red team read orange at the gameplay camera), so it keeps its hue. Lantern flames, skin, rust and
  // wood have green well above blue: they still warm up.
  float hry = (g.g - g.b) / max(g.r - min(g.g, g.b), 1e-3);
  float teamRed = step(mx, g.r) * smoothstep(0.2, 0.4, sat) * (1.0 - smoothstep(0.12, 0.3, hry));
  float keepW = 1.0 - teamRed * hwlTeam.x;
  float keepS = 1.0 - teamRed * hwlTeam.y;
  // split toning that keeps luma: the deep tones lose some colour and lean teal, the bright ones warm
  float ws = 1.0 - smoothstep(0.02, 0.45, l);
  float wh = smoothstep(hwlRange.x, hwlRange.y, l);
  g = mix(g, vec3(l), ws * hwlMisc.x * keepS);
  g = hwlLean(g, hwlShadow.rgb, ws * hwlShadow.a * keepS);
  g = hwlLean(g, hwlHigh.rgb, wh * hwlHigh.a * keepW);
  // complementary split: coloured warm pixels lean further orange, coloured cool ones further teal
  float warmth = clamp((g.r - g.b) / max(sat, 1e-3), -1.0, 1.0);
  float k = smoothstep(0.03, 0.3, sat) * abs(warmth) * hwlMisc.y * 0.5 * (warmth > 0.0 ? keepW : 1.0);
  g = hwlLean(g, warmth > 0.0 ? hwlHigh.rgb : hwlShadow.rgb, k);
  // black point and filmic S-curve (deep contrast)
  g = clamp((g - hwlCurve.y) / (1.0 - hwlCurve.y), 0.0, 1.0);
  g = mix(g, g * g * (3.0 - 2.0 * g), hwlCurve.x);
  // vibrance (muted colours gain the most) and extra warmth saturation for lanterns and sunsets
  mx = max(g.r, max(g.g, g.b));
  mn = min(g.r, min(g.g, g.b));
  float l2 = dot(g, HWL_LUMA);
  float warm = clamp((g.r - g.b) * 2.0, 0.0, 1.0);
  g = mix(vec3(l2), g, 1.0 + hwlCurve.z * (1.0 - (mx - mn)) + hwlCurve.w * warm);
  // a little more vignette than the map's own: the eye settles on the play band
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p) / length(vec2(aspect, 1.0) * 0.5);
  g *= 1.0 - hwlMisc.w * smoothstep(0.42, 1.15, r);
  outputColor = vec4(pow(max(g, vec3(0.0)), vec3(2.2)), inputColor.a);
}
`;

export class LookGradeEffect extends Effect {
  constructor() {
    super('HWLookGradeEffect', LOOK_GRADE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['hwlShadow', new THREE.Uniform(new THREE.Vector4(1, 1, 1, 0))],
        ['hwlHigh', new THREE.Uniform(new THREE.Vector4(1, 1, 1, 0))],
        ['hwlCurve', new THREE.Uniform(new THREE.Vector4(0, 0, 0, 0))],
        ['hwlMisc', new THREE.Uniform(new THREE.Vector4(0, 0, 1, 0))],
        ['hwlRange', new THREE.Uniform(new THREE.Vector2(0.36, 0.95))],
        ['hwlTeam', new THREE.Uniform(new THREE.Vector2(0, 0))],
      ]),
    });
  }

  set(look: CineLook | null, on: boolean): void {
    const u = this.uniforms;
    const s = (u.get('hwlShadow') as THREE.Uniform).value as THREE.Vector4;
    const h = (u.get('hwlHigh') as THREE.Uniform).value as THREE.Vector4;
    const c = (u.get('hwlCurve') as THREE.Uniform).value as THREE.Vector4;
    const m = (u.get('hwlMisc') as THREE.Uniform).value as THREE.Vector4;
    const team = (u.get('hwlTeam') as THREE.Uniform).value as THREE.Vector2;
    if (!look || !on) {
      s.set(1, 1, 1, 0);
      h.set(1, 1, 1, 0);
      c.set(0, 0, 0, 0);
      m.set(0, 0, 1, 0);
      team.set(0, 0);
      return;
    }
    const g = look.grade;
    s.set(g.shadowHue.x, g.shadowHue.y, g.shadowHue.z, g.shadowAmt);
    h.set(g.highHue.x, g.highHue.y, g.highHue.z, g.highAmt);
    c.set(g.curve, g.black, g.vibrance, g.warmSat);
    m.set(g.shadowDesat, g.split, g.exposure, g.vignette);
    ((u.get('hwlRange') as THREE.Uniform).value as THREE.Vector2).set(g.highLo, g.highHi);
    team.set(g.teamGuard, g.teamShadow);
  }
}
