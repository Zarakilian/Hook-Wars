// Menu backdrop: a warm sunset over a calm sea seen from a gently bobbing boat. The sea reflects
// the same procedural sky (clouds included), the sun lays a glitter path on the water, and voxel
// islands with a lighthouse sweep a soft beam across the dusk. Built and disposed by the engine.
import * as THREE from 'three';
import { VoxelGrid, meshVoxels, hashVox, shade } from '../voxel/voxel.ts';
import type { SkyUniforms } from './sky.ts';
import { NOISE_GLSL, SKY_FN_GLSL, SKY_UNIFORMS_GLSL } from './glsl.ts';

const OCEAN_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const OCEAN_FRAG = /* glsl */ `
${SKY_UNIFORMS_GLSL}
${NOISE_GLSL}
${SKY_FN_GLSL}
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uOceanTime;
varying vec3 vWorld;

vec2 hwWave(vec2 p, vec2 dir, float k, float amp, float speed, float t) {
  float ph = dot(dir, p) * k + t * speed;
  return dir * (cos(ph) * k * amp);
}

void main() {
  float t = uOceanTime;
  vec3 V = vWorld - cameraPosition;
  float dist = length(V);
  vec3 v = V / dist;
  vec2 p = vWorld.xz;
  vec2 g = vec2(0.0);
  g += hwWave(p, normalize(vec2(0.2, 1.0)), 0.21, 0.32, 1.1, t);
  g += hwWave(p, normalize(vec2(-0.7, 1.0)), 0.37, 0.16, 1.6, t);
  g += hwWave(p, normalize(vec2(0.9, 0.6)), 0.61, 0.09, 2.1, t);
  g += hwWave(p, normalize(vec2(-0.3, -1.0)), 1.13, 0.045, 2.9, t);
  g += hwWave(p, normalize(vec2(1.0, -0.2)), 1.87, 0.026, 3.7, t);
  g += hwWave(p, normalize(vec2(-1.0, 0.4)), 3.1, 0.014, 4.6, t);
  // fine chop from noise (cheap finite difference of one octave)
  vec2 q = p * 1.7 + vec2(t * 0.6, t * 0.35);
  float n0 = hw_noise2(q);
  g += vec2(hw_noise2(q + vec2(0.07, 0.0)) - n0, hw_noise2(q + vec2(0.0, 0.07)) - n0) * 0.9;
  float far = 1.0 / (1.0 + dist * 0.018);
  g *= mix(0.32, 1.0, far);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 r = reflect(v, n);
  r.y = abs(r.y) + 0.004;
  r = normalize(r);
  vec3 refl = hw_sky(r);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(-v, n), 0.0), 5.0);
  float facing = max(dot(n, vec3(0.0, 1.0, 0.0)), 0.0);
  vec3 body = mix(uShallow, uDeep, 0.6 + 0.4 * facing);
  body *= uSkyTop * 2.2 + uSkyMid * 0.35 + uSunColor * 0.05 * uSunGlow + 0.02;
  // subsurface glow on wave sides facing the sun
  float sss = pow(max(dot(v, uSunDir) * -1.0 + 0.2, 0.0), 2.0) * (1.0 - facing) * 0.0;
  vec3 col = mix(body, refl, fres) + uShallow * sss;
  float sd = max(dot(r, uSunDir), 0.0);
  float glint = hw_noise2(p * 6.0 + t * 2.0);
  col += uSunColor * (pow(sd, 1400.0) * 60.0 * (0.4 + glint) + pow(sd, 120.0) * 1.1 + pow(sd, 18.0) * 0.12);
  // horizon haze: fade into the sky colour just above the horizon line
  vec3 hd = normalize(vec3(v.x, 0.0, v.z));
  vec3 haze = uSkyHorizon * 1.06 + uSunColor * uSunGlow * (0.06 * pow(max(dot(hd, uSunDir), 0.0), 3.0) + 0.2 * pow(max(dot(hd, uSunDir), 0.0), 24.0));
  col = mix(col, haze, smoothstep(60.0, 360.0, dist) * 0.92);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const BEAM_VERT = /* glsl */ `
varying float vAlong;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vAlong = uv.y;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying float vAlong;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec3 v = normalize(cameraPosition - vWorld);
  float rim = pow(abs(dot(v, normalize(vNormalW))), 1.6);
  float fall = pow(vAlong, 1.6);
  gl_FragColor = vec4(uColor * uIntensity * rim * fall, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const BIRD_VERT = /* glsl */ `
uniform float uBirdTime;
attribute float aPhase;
void main() {
  vec3 p = position;
  float ax = abs(p.x);
  float flap = sin(uBirdTime * (5.0 + aPhase * 2.0) + aPhase * 40.0);
  // glide most of the time, flap in bursts
  float burst = smoothstep(0.2, 0.8, sin(uBirdTime * 0.35 + aPhase * 9.0) * 0.5 + 0.5);
  p.y += ax * (0.22 + flap * 0.55 * burst) - ax * ax * 0.18;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
}
`;
const BIRD_FRAG = /* glsl */ `
uniform vec3 uBirdColor;
void main() {
  gl_FragColor = vec4(uBirdColor, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function birdGeometry(): THREE.BufferGeometry {
  const v = [
    // left wing (two triangles, swept back), body, right wing
    0, 0, 0.22, -0.32, 0.02, 0.08, 0, 0, -0.14,
    -0.32, 0.02, 0.08, -0.85, 0.0, -0.12, -0.3, 0.02, -0.06,
    0, 0, 0.22, 0, 0, -0.14, 0.32, 0.02, 0.08,
    0.32, 0.02, 0.08, 0.3, 0.02, -0.06, 0.85, 0.0, -0.12,
    0, 0, -0.14, -0.3, 0.02, -0.06, -0.32, 0.02, 0.08,
    0, 0, -0.14, 0.32, 0.02, 0.08, 0.3, 0.02, -0.06,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

interface Bird {
  cx: number;
  cy: number;
  cz: number;
  r: number;
  speed: number;
  phase: number;
}

function islandGrid(nx: number, nz: number, maxH: number, seed: number, palms: number): VoxelGrid {
  const ny = maxH + 16;
  const g = new VoxelGrid(nx, ny, nz);
  const rock = [0x4c4440, 0x5a504a, 0x433b38, 0x625750];
  const grass = [0x3f5a2c, 0x4a6632, 0x56713a];
  const sand = 0xc79a62;
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const dx = (x + 0.5) / nx * 2 - 1;
      const dz = (z + 0.5) / nz * 2 - 1;
      const r = Math.sqrt(dx * dx + dz * dz);
      const bump = hashVox(x >> 1, 0, z >> 1, seed) * 0.25 + hashVox(x >> 3, 1, z >> 3, seed) * 0.5;
      const h = Math.floor(maxH * Math.max(0, 1 - r * r * (0.95 + bump * 0.4)) + bump * 2 - 0.5);
      if (h < 0) continue;
      for (let y = 0; y <= h; y++) {
        let c: number;
        if (y === h && h > 2 && r < 0.75) c = grass[Math.floor(hashVox(x, y, z, seed + 3) * grass.length)];
        else if (y <= 1 && r > 0.6) c = shade(sand, 0.9 + hashVox(x, y, z, seed) * 0.2);
        else c = rock[Math.floor(hashVox(x, y, z, seed + 1) * rock.length)];
        g.set(x, y, z, c);
      }
    }
  // palms
  for (let i = 0; i < palms; i++) {
    const px = Math.floor(nx * (0.3 + hashVox(i, 7, 1, seed) * 0.4));
    const pz = Math.floor(nz * (0.3 + hashVox(i, 7, 2, seed) * 0.4));
    let base = 0;
    for (let y = ny - 1; y >= 0; y--)
      if (g.solid(px, y, pz)) {
        base = y + 1;
        break;
      }
    const th = 7 + Math.floor(hashVox(i, 3, 3, seed) * 4);
    const lean = hashVox(i, 4, 4, seed) > 0.5 ? 1 : -1;
    for (let y = 0; y < th; y++) g.set(px + Math.round((y * y) / (th * 3.2)) * lean, base + y, pz, shade(0x6b4a2f, 0.85 + (y % 2) * 0.15));
    const tx = px + Math.round((th * th) / (th * 3.2)) * lean;
    const ty = base + th;
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * Math.PI * 2 + i;
      for (let s = 1; s <= 4; s++) {
        const lx = tx + Math.round(Math.cos(ang) * s);
        const lz = pz + Math.round(Math.sin(ang) * s);
        const ly = ty - Math.floor((s * s) / 6);
        g.set(lx, ly, lz, shade(0x3d6a2a, 0.85 + hashVox(lx, ly, lz, seed) * 0.3));
      }
    }
    g.set(tx, ty, pz, 0x4a7a30);
  }
  return g;
}

function lighthouseGrid(): VoxelGrid {
  const g = new VoxelGrid(9, 34, 9);
  for (let y = 0; y < 26; y++) {
    const r = 3.6 - y * 0.05;
    const band = Math.floor(y / 4) % 2 === 0 ? 0xe9e2d6 : 0xc8463a;
    g.cylinder(4.5, 4.5, r, y, y, (x, yy, z) => shade(band, 0.92 + hashVox(x, yy, z, 5) * 0.12));
  }
  g.cylinder(4.5, 4.5, 3.4, 26, 26, 0x2e2b2a); // gallery
  g.cylinder(4.5, 4.5, 2.2, 31, 32, 0x3a3230); // roof
  g.set(4, 33, 4, 0x3a3230);
  for (let y = 27; y <= 30; y++) {
    g.set(2, y, 2, 0x2e2b2a);
    g.set(6, y, 2, 0x2e2b2a);
    g.set(2, y, 6, 0x2e2b2a);
    g.set(6, y, 6, 0x2e2b2a);
  }
  return g;
}

export class MenuBackdrop {
  readonly group = new THREE.Group();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly oceanMaterial: THREE.ShaderMaterial;
  private readonly beam: THREE.Mesh;
  private readonly lamp: THREE.Mesh;
  private readonly lampMat: THREE.MeshBasicMaterial;
  private readonly beamMat: THREE.ShaderMaterial;
  private readonly birds: THREE.InstancedMesh;
  private readonly birdMat: THREE.ShaderMaterial;
  private readonly flock: Bird[] = [];
  private readonly m4 = new THREE.Matrix4();
  private readonly q4 = new THREE.Quaternion();
  private readonly p4 = new THREE.Vector3();
  private readonly s4 = new THREE.Vector3();
  private readonly e4 = new THREE.Euler();

  constructor(sky: SkyUniforms, cloudOctaves: number, overlayLayer: number) {
    this.group.name = 'HW.MenuBackdrop';
    // ocean
    const oceanGeo = new THREE.PlaneGeometry(900, 900, 1, 1);
    oceanGeo.rotateX(-Math.PI / 2);
    this.oceanMaterial = new THREE.ShaderMaterial({
      name: 'HW.MenuOcean',
      uniforms: {
        ...sky,
        uDeep: { value: new THREE.Color(0x0a1d33) },
        uShallow: { value: new THREE.Color(0x245a70) },
        uOceanTime: { value: 0 },
      },
      defines: { HW_CLOUD_OCTAVES: Math.max(3, cloudOctaves - 1), HW_AURORA_STEPS: 1 },
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      fog: false,
    });
    const ocean = new THREE.Mesh(oceanGeo, this.oceanMaterial);
    ocean.position.set(0, 0, -300);
    ocean.frustumCulled = false;
    this.group.add(ocean);
    this.disposables.push(oceanGeo, this.oceanMaterial);

    // islands
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    this.disposables.push(mat);
    const islands: { nx: number; nz: number; h: number; x: number; z: number; s: number; palms: number; seed: number; rot: number }[] = [
      { nx: 46, nz: 30, h: 9, x: -70, z: -150, s: 0.7, palms: 2, seed: 3, rot: 0.3 },
      { nx: 70, nz: 40, h: 14, x: 95, z: -230, s: 0.9, palms: 4, seed: 11, rot: -0.2 },
      { nx: 30, nz: 22, h: 6, x: 30, z: -120, s: 0.55, palms: 1, seed: 21, rot: 1.1 },
      { nx: 90, nz: 50, h: 20, x: -170, z: -280, s: 1.1, palms: 3, seed: 37, rot: 0.6 },
    ];
    for (const d of islands) {
      const geo = meshVoxels(islandGrid(d.nx, d.nz, d.h, d.seed, d.palms), { size: d.s, aoStrength: 0.55 });
      this.disposables.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(d.x, -0.6, d.z);
      m.rotation.y = d.rot;
      this.group.add(m);
    }
    // lighthouse on the first island
    const lhGeo = meshVoxels(lighthouseGrid(), { size: 0.62, aoStrength: 0.5 });
    this.disposables.push(lhGeo);
    const lh = new THREE.Mesh(lhGeo, mat);
    lh.position.set(-72, 4.6, -151);
    this.group.add(lh);
    const lampY = lh.position.y + 28.5 * 0.62;
    this.lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 7, 4), fog: false });
    const lampGeo = new THREE.BoxGeometry(1.5, 1.6, 1.5);
    this.lamp = new THREE.Mesh(lampGeo, this.lampMat);
    this.lamp.position.set(lh.position.x, lampY, lh.position.z);
    this.group.add(this.lamp);
    this.disposables.push(this.lampMat, lampGeo);
    // beam: a long open cone pointing along +X from the lamp, swept around Y
    const beamGeo = new THREE.ConeGeometry(9, 120, 24, 1, true);
    beamGeo.translate(0, -60, 0);
    beamGeo.rotateZ(Math.PI / 2);
    this.beamMat = new THREE.ShaderMaterial({
      name: 'HW.MenuBeam',
      uniforms: { uColor: { value: new THREE.Color(1, 0.82, 0.55) }, uIntensity: { value: 0.22 } },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.beam = new THREE.Mesh(beamGeo, this.beamMat);
    this.beam.position.copy(this.lamp.position);
    this.beam.layers.set(overlayLayer);
    this.beam.frustumCulled = false;
    this.group.add(this.beam);
    this.disposables.push(beamGeo, this.beamMat);

    // a few gulls gliding in lazy circles against the sunset
    const birdGeo = birdGeometry();
    const n = 7;
    const phases = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = i / n;
      phases[i] = (i * 0.618) % 1;
      this.flock.push({
        cx: -10 + Math.sin(i * 2.4) * 30,
        cy: 17 + (i % 3) * 3.5,
        cz: -105 - (i % 4) * 14,
        r: 10 + k * 18,
        speed: (0.09 + k * 0.05) * (i % 2 === 0 ? 1 : -1),
        phase: i * 1.7,
      });
    }
    birdGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    this.birdMat = new THREE.ShaderMaterial({
      name: 'HW.MenuBirds',
      uniforms: { uBirdTime: { value: 0 }, uBirdColor: { value: new THREE.Color(0x1a1020) } },
      vertexShader: BIRD_VERT,
      fragmentShader: BIRD_FRAG,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.birds = new THREE.InstancedMesh(birdGeo, this.birdMat, n);
    this.birds.frustumCulled = false;
    this.group.add(this.birds);
    this.disposables.push(birdGeo, this.birdMat);
  }

  update(time: number, camera: THREE.PerspectiveCamera): void {
    this.oceanMaterial.uniforms.uOceanTime.value = time;
    this.birdMat.uniforms.uBirdTime.value = time;
    for (let i = 0; i < this.flock.length; i++) {
      const b = this.flock[i];
      const a = b.phase + time * b.speed;
      this.p4.set(b.cx + Math.cos(a) * b.r, b.cy + Math.sin(time * 0.3 + b.phase) * 1.2, b.cz + Math.sin(a) * b.r * 0.5);
      // heading along the circle tangent, banked into the turn
      const yaw = Math.atan2(-Math.sin(a) * b.speed, Math.cos(a) * 0.5 * b.speed);
      this.e4.set(0, yaw, Math.sign(b.speed) * 0.25);
      this.q4.setFromEuler(this.e4);
      this.s4.setScalar(2.3);
      this.m4.compose(this.p4, this.q4, this.s4);
      this.birds.setMatrixAt(i, this.m4);
    }
    this.birds.instanceMatrix.needsUpdate = true;
    this.beam.rotation.y = time * 0.55;
    // the beam is brightest when it swings toward the viewer
    const toward = Math.max(0, Math.cos(time * 0.55 - Math.atan2(-(camera.position.z - this.lamp.position.z), camera.position.x - this.lamp.position.x)));
    this.beamMat.uniforms.uIntensity.value = 0.12 + 0.35 * Math.pow(toward, 6);
    const pulse = 1 + Math.pow(toward, 12) * 2.5;
    this.lampMat.color.setRGB(9 * pulse, 7 * pulse, 4 * pulse);
    // slow boat bob
    const bob = Math.sin(time * 0.45) * 0.22 + Math.sin(time * 0.71) * 0.1;
    camera.position.set(Math.sin(time * 0.04) * 3, 3.4 + bob, 14);
    camera.lookAt(Math.sin(time * 0.05) * 9 + 6, 8.6 + bob * 0.4, -100);
    camera.rotateZ(Math.sin(time * 0.37) * 0.012);
    camera.updateMatrixWorld();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.removeFromParent();
  }
}
