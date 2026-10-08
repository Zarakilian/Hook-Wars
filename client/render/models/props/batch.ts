// Static batching for props and decor.
//
// Every static model instance is collected here, then emitted as one THREE.BatchedMesh per
// (material, shadow) pair. BatchedMesh frustum-culls each instance on its own, in the camera pass and
// in the shadow pass, so the far bank and off-screen props cost nothing, and a whole kind-set draws
// with one multi-draw call. Static glow halos are merged into a single additive billboard mesh.
import * as THREE from 'three';
import { haloTexture, moodVariant, PROP_TIME, type PropModel } from './common.ts';

interface Item {
  geo: THREE.BufferGeometry;
  m: THREE.Matrix4;
}
interface Bucket {
  mat: THREE.Material;
  shadow: boolean;
  items: Item[];
}
interface HaloItem {
  x: number;
  y: number;
  z: number;
  color: number;
  size: number;
  opacity: number;
}

const _v = new THREE.Vector3();

export class StaticBatch {
  private readonly buckets = new Map<string, Bucket>();
  private readonly halos: HaloItem[] = [];
  /** triangles per instance, for the build log */
  tris = 0;
  instances = 0;
  private readonly mood: 'night' | 'dusk' | null;
  private readonly sort: boolean;
  constructor(mood: 'night' | 'dusk' | null, sort: boolean) {
    this.mood = mood;
    this.sort = sort;
  }

  /** One model instance. `moodRim` false keeps the material as is (no night rim variant). */
  add(model: PropModel, m: THREE.Matrix4, castShadow: boolean, moodRim = true): void {
    this.instances++;
    for (const p of model.parts) {
      const mat = moodRim ? moodVariant(p.mat, this.mood) : p.mat;
      const shadow = castShadow && p.shadow;
      const key = mat.uuid + (shadow ? '|s' : '|n');
      let b = this.buckets.get(key);
      if (!b) {
        b = { mat, shadow, items: [] };
        this.buckets.set(key, b);
      }
      b.items.push({ geo: p.geo, m });
      this.tris += (p.geo.index ? p.geo.index.count : p.geo.attributes.position.count) / 3;
    }
    if (model.halos)
      for (const h of model.halos) {
        _v.set(h.pos[0], h.pos[1], h.pos[2]).applyMatrix4(m);
        this.halos.push({ x: _v.x, y: _v.y, z: _v.z, color: h.color, size: h.size, opacity: h.opacity });
      }
  }

  /** A loose halo in world space. */
  addHalo(x: number, y: number, z: number, color: number, size: number, opacity: number): void {
    this.halos.push({ x, y, z, color, size, opacity });
  }

  /** Emit the meshes into `group`. */
  build(group: THREE.Group, name: string): void {
    for (const b of this.buckets.values()) {
      if (b.items.length === 1) {
        // a single instance: a plain mesh is cheaper than a batch
        const it = b.items[0];
        const mesh = new THREE.Mesh(it.geo, b.mat);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(it.m);
        mesh.castShadow = b.shadow;
        mesh.receiveShadow = true;
        mesh.name = name;
        group.add(mesh);
        continue;
      }
      const geos = new Map<THREE.BufferGeometry, number>();
      let nv = 0;
      let ni = 0;
      for (const it of b.items) {
        if (geos.has(it.geo)) continue;
        geos.set(it.geo, -1);
        nv += it.geo.attributes.position.count;
        ni += it.geo.index ? it.geo.index.count : it.geo.attributes.position.count;
      }
      const bm = new THREE.BatchedMesh(b.items.length, nv, ni, b.mat);
      for (const g of geos.keys()) geos.set(g, bm.addGeometry(g));
      for (const it of b.items) {
        const id = bm.addInstance(geos.get(it.geo)!);
        bm.setMatrixAt(id, it.m);
      }
      bm.perObjectFrustumCulled = true;
      bm.sortObjects = this.sort;
      bm.castShadow = b.shadow;
      bm.receiveShadow = true;
      bm.name = name;
      bm.computeBoundingBox();
      bm.computeBoundingSphere();
      group.add(bm);
    }
    if (this.halos.length) group.add(haloMesh(this.halos));
  }
}

// ---------------------------------------------------------------------------------------------
// Merged halos: 4 vertices per glow, expanded to a camera-facing quad in the vertex shader.
// One additive draw for every static lamp glow of a group. Fog fades them like THREE.Sprite.
// ---------------------------------------------------------------------------------------------

let haloMat: THREE.ShaderMaterial | null = null;
function haloMaterial(): THREE.ShaderMaterial {
  if (haloMat) return haloMat;
  haloMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, uTime: { value: 0 } }]),
    vertexShader: /* glsl */ `
      attribute vec2 aCorner;
      attribute vec4 aColor;
      attribute float aSize;
      uniform float uTime;
      varying vec2 vUv;
      varying vec4 vCol;
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float tw = 1.0 + 0.05 * sin(uTime * 2.3 + position.x * 1.7 + position.z * 1.3);
        mvPosition.xy += aCorner * aSize * tw;
        gl_Position = projectionMatrix * mvPosition;
        vUv = aCorner + 0.5;
        vCol = aColor;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv;
      varying vec4 vCol;
      #include <fog_pars_fragment>
      void main() {
        float a = texture2D(map, vUv).a * vCol.a;
        vec3 c = vCol.rgb * a;
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          c *= 1.0 - fogFactor;
        #endif
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  haloMat.uniforms.map.value = haloTexture();
  haloMat.uniforms.uTime = PROP_TIME;
  return haloMat;
}

const _c = new THREE.Color();
function haloMesh(list: HaloItem[]): THREE.Mesh {
  const n = list.length;
  const pos = new Float32Array(n * 12);
  const corner = new Float32Array(n * 8);
  const col = new Float32Array(n * 16);
  const size = new Float32Array(n * 4);
  const idx = new (n * 4 > 65535 ? Uint32Array : Uint16Array)(n * 6);
  const CX = [-0.5, 0.5, 0.5, -0.5];
  const CY = [-0.5, -0.5, 0.5, 0.5];
  for (let i = 0; i < n; i++) {
    const h = list[i];
    _c.setHex(h.color, THREE.SRGBColorSpace);
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      pos[v * 3] = h.x;
      pos[v * 3 + 1] = h.y;
      pos[v * 3 + 2] = h.z;
      corner[v * 2] = CX[k];
      corner[v * 2 + 1] = CY[k];
      col[v * 4] = _c.r;
      col[v * 4 + 1] = _c.g;
      col[v * 4 + 2] = _c.b;
      col[v * 4 + 3] = h.opacity;
      size[v] = h.size;
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  // grow the bounds by the largest halo so the quads are never culled while visible
  let maxS = 0;
  for (const h of list) maxS = Math.max(maxS, h.size);
  if (geo.boundingSphere) geo.boundingSphere.radius += maxS;
  const mesh = new THREE.Mesh(geo, haloMaterial());
  mesh.name = 'halos';
  mesh.renderOrder = 3;
  mesh.userData.ownsGeometry = true;
  return mesh;
}

/** Free per-match GPU buffers of a props / decor / platforms group (shared caches stay). */
export function disposeBatchGroup(group: THREE.Object3D): void {
  group.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    else if ((o as THREE.BatchedMesh).isBatchedMesh) (o as THREE.BatchedMesh).dispose();
    else if (o.userData.ownsGeometry && (o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
  });
}

// ---------------------------------------------------------------------------------------------
// Always-drawn tick: a degenerate triangle whose onBeforeRender fires every frame.
// ---------------------------------------------------------------------------------------------

const TICK_GEO = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
const TICK_MAT = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });

export function tickMesh(fn: () => void): THREE.Mesh {
  const m = new THREE.Mesh(TICK_GEO, TICK_MAT);
  m.frustumCulled = false;
  m.renderOrder = -10;
  m.name = 'tick';
  m.onBeforeRender = fn;
  return m;
}
