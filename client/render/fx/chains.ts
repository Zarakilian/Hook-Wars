// Hook and grapple chains: instanced voxel links laid out by arc length from the hook head back to
// the thrower's hand, a gentle sag and whip while paying out, taut and rattling while reeling in.
// Chains are pooled per style: GameClient creates one per throw and disposes it when the hook ends,
// so dispose() hands the object back to the pool and GPU resources live until FxSystem.dispose().
import * as THREE from 'three';
import type { FamilyId, Team } from '../../../shared/types.ts';
import { TEAM_COLORS, type ChainView, type Quality } from '../contracts.ts';
import {
  botHead, brawlerHead, cableLink, grappleHead, ogreHead, ropeKnot, ropeLink, springCoil, steelLink, thinVineLink, twineLink,
  vineLeaf, vineLink, type HeadModel, type LinkModel,
} from './chainModels.ts';
import { PF, Shape, type SpriteBatch } from './particles.ts';

const MAX_LEN = 38; // metres of chain a single hook can show (range 26 plus bends)
const UP = new THREE.Vector3(0, 1, 0);

interface FamilyMats {
  metal: THREE.MeshStandardMaterial;
  ember: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  link: THREE.MeshStandardMaterial;
  extra: THREE.MeshStandardMaterial;
}

interface StyleDef {
  link: LinkModel;
  extra: THREE.BufferGeometry | null;
  /** an extra every N links */
  extraEvery: number;
  /** extras alternate sides by rolling 180 degrees */
  extraFlip: boolean;
  /** max sag in metres, and sag per metre of span */
  sagMax: number;
  sagPerM: number;
  head: (team: Team) => HeadModel;
  headScale: number;
}

function vcMat(roughness: number, metalness: number, emissive = 0x000000, emissiveIntensity = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness, emissive, emissiveIntensity });
}

/** Shared flicker for every Ember Barb head. */
const heatUniform = { value: 2.4 };

/** Vertex-coloured material where saturated hot colours (red-orange to yellow) glow. */
function emberMat(roughness: number, metalness: number): THREE.MeshStandardMaterial {
  const m = vcMat(roughness, metalness);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHeat = heatUniform;
    sh.fragmentShader =
      'uniform float uHeat;\n' +
      sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  float hwHot = smoothstep(0.45, 0.8, diffuseColor.r - diffuseColor.b) * step(diffuseColor.g, diffuseColor.r * 0.5);
  totalEmissiveRadiance += diffuseColor.rgb * hwHot * uHeat;`,
      );
  };
  m.customProgramCacheKey = () => 'hw-fx-ember';
  return m;
}

/** All shared chain resources. One per FxSystem. */
export class ChainFactory {
  private readonly root: THREE.Object3D;
  private readonly sprites: SpriteBatch;
  private readonly quality: Quality;
  private readonly styles = new Map<string, StyleDef>();
  private readonly heads = new Map<string, HeadModel>();
  private readonly pools = new Map<string, ChainImpl[]>();
  private readonly all: ChainImpl[] = [];
  readonly mats: Record<FamilyId, FamilyMats>;
  readonly lampMats: Record<Team, THREE.MeshStandardMaterial>;
  readonly coilGeo: THREE.BufferGeometry;
  readonly coilMat: THREE.MeshStandardMaterial;
  private readonly geos: THREE.BufferGeometry[] = [];
  readonly castShadow: boolean;
  readonly emberRate: number;

  constructor(root: THREE.Object3D, sprites: SpriteBatch, quality: Quality) {
    this.root = root;
    this.sprites = sprites;
    this.quality = quality;
    this.castShadow = quality !== 'low';
    this.emberRate = quality === 'low' ? 14 : quality === 'medium' ? 30 : quality === 'high' ? 45 : 60;
    // metalness stays moderate: the scene may have no environment map, and full metal goes black
    this.mats = {
      brawler: { metal: vcMat(0.4, 0.42), ember: emberMat(0.42, 0.35), paint: vcMat(0.45, 0.05), link: vcMat(0.92, 0), extra: vcMat(0.92, 0) },
      ogre: { metal: vcMat(0.62, 0.02), ember: emberMat(0.6, 0.02), paint: vcMat(0.75, 0), link: vcMat(0.85, 0), extra: vcMat(0.7, 0) },
      bot: { metal: vcMat(0.34, 0.5), ember: emberMat(0.36, 0.42), paint: vcMat(0.4, 0.15), link: vcMat(0.36, 0.48), extra: vcMat(0.36, 0.48) },
    };
    this.lampMats = {
      0: new THREE.MeshStandardMaterial({ color: TEAM_COLORS[0].light, emissive: TEAM_COLORS[0].main, emissiveIntensity: 3.2, roughness: 0.3 }),
      1: new THREE.MeshStandardMaterial({ color: TEAM_COLORS[1].light, emissive: TEAM_COLORS[1].main, emissiveIntensity: 3.2, roughness: 0.3 }),
    };
    this.coilGeo = springCoil();
    this.coilMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.4, emissive: 0x2a7fff, emissiveIntensity: 0.55 });
    this.geos.push(this.coilGeo);

    const rope = ropeLink();
    const knot = ropeKnot();
    const vine = vineLink();
    const leaf = vineLeaf();
    const steel = steelLink();
    const twine = twineLink();
    const thinVine = thinVineLink();
    const cable = cableLink();
    this.geos.push(rope.geo, knot, vine.geo, leaf, steel.geo, twine.geo, thinVine.geo, cable.geo);
    const head = (key: string, build: (t: Team) => HeadModel) => (team: Team) => {
      const k = `${key}:${team}`;
      let h = this.heads.get(k);
      if (!h) {
        h = build(team);
        this.heads.set(k, h);
      }
      return h;
    };
    this.styles.set('0:brawler', { link: rope, extra: knot, extraEvery: 9, extraFlip: false, sagMax: 0.5, sagPerM: 0.034, head: head('h:brawler', (t) => brawlerHead(TEAM_COLORS[t])), headScale: 1.5 });
    this.styles.set('0:ogre', { link: vine, extra: leaf, extraEvery: 3, extraFlip: true, sagMax: 0.5, sagPerM: 0.034, head: head('h:ogre', (t) => ogreHead(TEAM_COLORS[t])), headScale: 1.5 });
    this.styles.set('0:bot', { link: steel, extra: null, extraEvery: 0, extraFlip: false, sagMax: 0.42, sagPerM: 0.03, head: head('h:bot', (t) => botHead(TEAM_COLORS[t])), headScale: 1.5 });
    this.styles.set('1:brawler', { link: twine, extra: null, extraEvery: 0, extraFlip: false, sagMax: 0.35, sagPerM: 0.03, head: head('g:brawler', (t) => grappleHead('brawler', TEAM_COLORS[t])), headScale: 1.35 });
    this.styles.set('1:ogre', { link: thinVine, extra: leaf, extraEvery: 7, extraFlip: true, sagMax: 0.35, sagPerM: 0.03, head: head('g:ogre', (t) => grappleHead('ogre', TEAM_COLORS[t])), headScale: 1.35 });
    this.styles.set('1:bot', { link: cable, extra: null, extraEvery: 0, extraFlip: false, sagMax: 0.3, sagPerM: 0.026, head: head('g:bot', (t) => grappleHead('bot', TEAM_COLORS[t])), headScale: 1.35 });
  }

  acquire(kind: 0 | 1, family: FamilyId, team: Team, fxBits: number, radius?: number): ChainImpl {
    const key = `${kind}:${family}`;
    let pool = this.pools.get(key);
    if (!pool) {
      pool = [];
      this.pools.set(key, pool);
    }
    let c = pool.pop();
    if (!c) {
      const style = this.styles.get(key) ?? this.styles.get(`${kind}:brawler`)!;
      c = new ChainImpl(this, style, family, kind, () => pool.push(c!));
      this.root.add(c.group);
      this.all.push(c);
    }
    c.activate(team, fxBits, radius);
    return c;
  }

  get spriteBatch(): SpriteBatch {
    return this.sprites;
  }

  /** Build every style once and keep it pooled, so the first throw never builds geometry. */
  prebuild(): ChainImpl[] {
    const out: ChainImpl[] = [];
    for (const kind of [0, 1] as const)
      for (const fam of ['brawler', 'ogre', 'bot'] as const) {
        const c = this.acquire(kind, fam, 0, 3);
        out.push(c);
      }
    // team 1 head geometries too
    for (const s of this.styles.values()) s.head(1);
    return out;
  }

  dispose(): void {
    for (const c of this.all) {
      this.root.remove(c.group);
      c.destroy();
    }
    this.all.length = 0;
    this.pools.clear();
    for (const h of this.heads.values()) {
      h.metal.dispose();
      h.metalHot.dispose();
      h.metalClosed?.dispose();
      h.metalClosedHot?.dispose();
      h.paint.dispose();
      h.lamp?.dispose();
    }
    this.heads.clear();
    for (const g of this.geos) g.dispose();
    for (const f of Object.values(this.mats)) for (const m of Object.values(f)) m.dispose();
    this.lampMats[0].dispose();
    this.lampMats[1].dispose();
    this.coilMat.dispose();
  }

  get tier(): Quality {
    return this.quality;
  }
}

// scratch buffers shared by every chain (updates run one at a time)
let SP = new Float32Array(64 * 3);
let SC = new Float32Array(64);
const LMAX = Math.ceil(MAX_LEN / 0.1) + 8;
const LP = new Float32Array(LMAX * 3);
const vF = new THREE.Vector3();
const vR = new THREE.Vector3();
const vU = new THREE.Vector3();
const tmpM = new THREE.Matrix4();

export class ChainImpl implements ChainView {
  readonly group = new THREE.Group();
  private readonly factory: ChainFactory;
  private readonly style: StyleDef;
  private readonly family: FamilyId;
  private readonly kind: 0 | 1;
  private readonly links: THREE.InstancedMesh;
  private readonly extras: THREE.InstancedMesh | null;
  private readonly head = new THREE.Group();
  private readonly headTilt = new THREE.Group();
  private readonly metal: THREE.Mesh;
  private readonly paint: THREE.Mesh;
  private readonly lamp: THREE.Mesh;
  private readonly coil: THREE.Mesh;
  private readonly release: () => void;
  private readonly capLinks: number;
  private readonly capExtras: number;
  private model!: HeadModel;
  private active = false;
  private slack = 1;
  private age = 0;
  private ember = false;
  private spring = false;
  private scale = 1;
  private emberAcc = 0;
  private lastFwd = new THREE.Vector3(0, 0, 1);
  private carryK = 0;
  private time = 0;

  constructor(factory: ChainFactory, style: StyleDef, family: FamilyId, kind: 0 | 1, release: () => void) {
    this.factory = factory;
    this.style = style;
    this.family = family;
    this.kind = kind;
    this.release = release;
    const mats = factory.mats[family];
    this.capLinks = Math.min(LMAX, Math.ceil(MAX_LEN / style.link.spacing) + 4);
    this.links = new THREE.InstancedMesh(style.link.geo, mats.link, this.capLinks);
    this.links.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.links.frustumCulled = false;
    this.links.castShadow = factory.castShadow;
    this.links.count = 0;
    this.group.add(this.links);
    if (style.extra && style.extraEvery > 0) {
      this.capExtras = Math.ceil(this.capLinks / style.extraEvery) + 2;
      this.extras = new THREE.InstancedMesh(style.extra, mats.extra, this.capExtras);
      this.extras.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.extras.frustumCulled = false;
      this.extras.castShadow = factory.castShadow;
      this.extras.count = 0;
      this.group.add(this.extras);
    } else {
      this.capExtras = 0;
      this.extras = null;
    }
    const h0 = style.head(0);
    this.metal = new THREE.Mesh(h0.metal, mats.metal);
    this.paint = new THREE.Mesh(h0.paint, mats.paint);
    this.lamp = new THREE.Mesh(h0.lamp ?? h0.paint, factory.lampMats[0]);
    this.coil = new THREE.Mesh(factory.coilGeo, factory.coilMat);
    for (const m of [this.metal, this.paint, this.lamp, this.coil]) {
      m.castShadow = factory.castShadow;
      m.frustumCulled = false;
      this.headTilt.add(m);
    }
    this.head.add(this.headTilt);
    this.group.add(this.head);
    this.group.visible = false;
  }

  activate(team: Team, fxBits: number, radius?: number): void {
    this.active = true;
    this.model = this.style.head(team);
    this.paint.geometry = this.model.paint;
    this.lamp.visible = !!this.model.lamp;
    if (this.model.lamp) this.lamp.geometry = this.model.lamp;
    this.lamp.material = this.factory.lampMats[team];
    this.ember = (fxBits & 1) !== 0;
    this.spring = (fxBits & 2) !== 0;
    this.metal.material = this.ember ? this.factory.mats[this.family].ember : this.factory.mats[this.family].metal;
    this.metal.geometry = this.ember ? this.model.metalHot : this.model.metal;
    this.coil.visible = this.spring;
    this.coil.position.set(this.model.coilX, 0, this.model.coilZ);
    const r = radius ?? 0.45;
    this.scale = this.style.headScale * Math.min(1.33, Math.max(1, Math.pow(r / 0.45, 0.5)));
    this.head.scale.setScalar(this.scale);
    this.slack = 1;
    this.age = 0;
    this.emberAcc = 0;
    this.carryK = 0;
    this.links.count = 0;
    if (this.extras) this.extras.count = 0;
    this.group.visible = false;
  }

  setVisible(v: boolean): void {
    this.group.visible = v && this.active;
  }

  /** Warm-up pose: render once at (x,y,z) at near-zero size so every shader compiles. */
  warm(x: number, y: number, z: number): void {
    this.group.visible = true;
    this.head.position.set(x, y, z);
    this.head.scale.setScalar(1e-4);
    tmpM.makeScale(1e-4, 1e-4, 1e-4).setPosition(x, y, z);
    this.links.setMatrixAt(0, tmpM);
    this.links.count = 1;
    this.links.instanceMatrix.needsUpdate = true;
    if (this.extras) {
      this.extras.setMatrixAt(0, tmpM);
      this.extras.count = 1;
      this.extras.instanceMatrix.needsUpdate = true;
    }
    this.lamp.visible = true;
    this.coil.visible = true;
    this.metal.material = this.factory.mats[this.family].ember;
  }

  update(points: THREE.Vector3[], dt: number, state: { retracting: boolean; carrying: boolean; time: number }): void {
    if (!this.active) return;
    const n = points.length;
    if (n === 0) return;
    this.time = state.time;
    this.age += dt;
    const taut = state.retracting || state.carrying;
    const target = taut ? 0 : 1;
    this.slack += (target - this.slack) * (1 - Math.exp(-dt * (taut ? 14 : 4)));
    this.carryK += ((state.carrying ? 1 : 0) - this.carryK) * (1 - Math.exp(-dt * 10));

    // copy points and cumulative lengths into scratch
    if (SP.length < n * 3) {
      SP = new Float32Array(n * 6);
      SC = new Float32Array(n * 2);
    }
    let L = 0;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      SP[i * 3] = p.x;
      SP[i * 3 + 1] = p.y;
      SP[i * 3 + 2] = p.z;
      if (i > 0) {
        const dx = p.x - SP[i * 3 - 3];
        const dy = p.y - SP[i * 3 - 2];
        const dz = p.z - SP[i * 3 - 1];
        L += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      SC[i] = L;
    }
    // head direction: along the last non-degenerate segment
    const hx = SP[(n - 1) * 3];
    const hy = SP[(n - 1) * 3 + 1];
    const hz = SP[(n - 1) * 3 + 2];
    for (let j = n - 2; j >= 0; j--) {
      const dx = hx - SP[j * 3];
      const dz = hz - SP[j * 3 + 2];
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        this.lastFwd.set(dx / d, 0, dz / d);
        break;
      }
    }
    const fwd = this.lastFwd;
    const eye = this.model.eye * this.scale;

    // head pose: flat, along the last segment, with a little flight wobble
    this.head.position.set(hx, hy, hz);
    this.head.rotation.set(0, Math.atan2(fwd.x, fwd.z), 0);
    const wob = this.slack;
    this.headTilt.rotation.set(
      Math.sin(this.time * 7.1) * 0.08 * wob + this.carryK * 0.18,
      Math.sin(this.time * 5.3) * 0.06 * wob,
      Math.sin(this.time * 9.7) * 0.22 * wob + (1 - wob) * Math.sin(this.time * 47) * 0.05,
    );
    if (this.model.metalClosed) {
      const closed = this.carryK > 0.5 || state.retracting;
      const m = this.model;
      this.metal.geometry = closed ? (this.ember ? m.metalClosedHot! : m.metalClosed!) : this.ember ? m.metalHot : m.metal;
    }
    if (this.ember) heatUniform.value = 2.2 + Math.sin(this.time * 13) * 0.35 + Math.sin(this.time * 31) * 0.2;
    if (this.spring) {
      const s = 1 + Math.sin(this.time * 22) * 0.12 * (0.4 + wob);
      this.coil.scale.set(1, 1, s);
      this.coil.rotation.z = this.time * 3;
    }

    // ---- links, laid out from the eye of the head back toward the hand ----
    const style = this.style;
    const spacing = style.link.spacing;
    const chainLen = L - eye;
    let count = 0;
    if (chainLen > 0.02) {
      let j = n - 2;
      let d = chainLen;
      // the chain ends at the eye: shorten the last segment by `eye`
      while (d > 0 && count < this.capLinks) {
        while (j > 0 && SC[j] > d) j--;
        const sx = SP[j * 3];
        const sy = SP[j * 3 + 1];
        const sz = SP[j * 3 + 2];
        const ex = SP[j * 3 + 3];
        const ey = SP[j * 3 + 4];
        const ez = SP[j * 3 + 5];
        const segLen = SC[j + 1] - SC[j];
        const t = segLen > 1e-5 ? Math.min(1, Math.max(0, (d - SC[j]) / segLen)) : 0;
        let x = sx + (ex - sx) * t;
        let y = sy + (ey - sy) * t;
        let z = sz + (ez - sz) * t;
        // sag within this span (spans between fixed bend points hang on their own)
        const bell = 4 * t * (1 - t);
        const sag = Math.min(style.sagMax, segLen * style.sagPerM) * this.slack;
        y -= sag * bell;
        // lateral whip while paying out, rattle while taut
        if (segLen > 1e-5) {
          const px = -(ez - sz) / segLen;
          const pz = (ex - sx) / segLen;
          const whip = 0.09 * this.slack * bell * Math.sin(d * 2.1 - this.time * 15) * Math.min(1, this.age * 3);
          const rattle = (1 - this.slack) * (0.018 + 0.012 * this.carryK) * Math.sin(this.time * 61 + count * 2.3) * Math.min(1, bell * 3);
          x += px * (whip + rattle * 0.6);
          z += pz * (whip + rattle * 0.6);
          y += rattle;
        }
        LP[count * 3] = x;
        LP[count * 3 + 1] = y;
        LP[count * 3 + 2] = z;
        count++;
        d -= spacing;
      }
    }
    // orientation: each link faces the previous one (toward the head); the first faces the eye
    const arr = this.links.instanceMatrix.array as Float32Array;
    const ex = hx - fwd.x * eye;
    const ey = hy;
    const ez = hz - fwd.z * eye;
    const twist = style.link.twist;
    const alt = style.link.alt;
    const rollJ = (1 - this.slack) * 0.35;
    let extraCount = 0;
    const earr = this.extras ? (this.extras.instanceMatrix.array as Float32Array) : null;
    for (let k = 0; k < count; k++) {
      const x = LP[k * 3];
      const y = LP[k * 3 + 1];
      const z = LP[k * 3 + 2];
      const tx = k === 0 ? ex : LP[k * 3 - 3];
      const ty = k === 0 ? ey : LP[k * 3 - 2];
      const tz = k === 0 ? ez : LP[k * 3 - 1];
      vF.set(tx - x, ty - y, tz - z);
      const fl = vF.length();
      if (fl < 1e-5) vF.copy(fwd);
      else vF.multiplyScalar(1 / fl);
      // stable frame: right = up x fwd
      vR.crossVectors(UP, vF);
      if (vR.lengthSq() < 1e-6) vR.set(1, 0, 0);
      vR.normalize();
      vU.crossVectors(vF, vR);
      let roll = k * twist + (alt && k & 1 ? Math.PI / 2 : 0);
      if (rollJ > 0.01) roll += Math.sin(this.time * 53 + k * 1.7) * rollJ;
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      // rotate right/up about fwd by roll
      const rx = vR.x * c + vU.x * s;
      const ry = vR.y * c + vU.y * s;
      const rz = vR.z * c + vU.z * s;
      const ux = vU.x * c - vR.x * s;
      const uy = vU.y * c - vR.y * s;
      const uz = vU.z * c - vR.z * s;
      // links near the hand pop in so the chain seems to pay out of the fist
      const remain = (count - k) * spacing;
      const sc = remain < 0.3 ? Math.max(0.2, remain / 0.3) : 1;
      const o = k * 16;
      arr[o] = rx * sc;
      arr[o + 1] = ry * sc;
      arr[o + 2] = rz * sc;
      arr[o + 3] = 0;
      arr[o + 4] = ux * sc;
      arr[o + 5] = uy * sc;
      arr[o + 6] = uz * sc;
      arr[o + 7] = 0;
      arr[o + 8] = vF.x;
      arr[o + 9] = vF.y;
      arr[o + 10] = vF.z;
      arr[o + 11] = 0;
      arr[o + 12] = x;
      arr[o + 13] = y;
      arr[o + 14] = z;
      arr[o + 15] = 1;
      if (earr && style.extraEvery > 0 && k % style.extraEvery === style.extraEvery - 1 && extraCount < this.capExtras) {
        // extra (knot or leaf): flip sides for leaves, slight droop
        const flip = style.extraFlip && (extraCount & 1) ? -1 : 1;
        const eo = extraCount * 16;
        const droop = style.extraFlip ? -0.35 : 0;
        // leaf plane: right axis sideways, tilted down a little
        const lx = vR.x * flip;
        const ly = vR.y * flip + droop;
        const lz = vR.z * flip;
        const ll = Math.hypot(lx, ly, lz) || 1;
        const ax = lx / ll;
        const ay = ly / ll;
        const az = lz / ll;
        // up = fwd x right'
        const bx = vF.y * az - vF.z * ay;
        const by = vF.z * ax - vF.x * az;
        const bz = vF.x * ay - vF.y * ax;
        earr[eo] = ax * sc;
        earr[eo + 1] = ay * sc;
        earr[eo + 2] = az * sc;
        earr[eo + 3] = 0;
        earr[eo + 4] = bx * sc;
        earr[eo + 5] = by * sc;
        earr[eo + 6] = bz * sc;
        earr[eo + 7] = 0;
        earr[eo + 8] = vF.x * sc;
        earr[eo + 9] = vF.y * sc;
        earr[eo + 10] = vF.z * sc;
        earr[eo + 11] = 0;
        earr[eo + 12] = x;
        earr[eo + 13] = y;
        earr[eo + 14] = z;
        earr[eo + 15] = 1;
        extraCount++;
      }
    }
    this.links.count = count;
    const im = this.links.instanceMatrix;
    im.clearUpdateRanges();
    if (count > 0) {
      im.addUpdateRange(0, count * 16);
      im.needsUpdate = true;
    }
    if (this.extras) {
      this.extras.count = extraCount;
      const em = this.extras.instanceMatrix;
      em.clearUpdateRanges();
      if (extraCount > 0) {
        em.addUpdateRange(0, extraCount * 16);
        em.needsUpdate = true;
      }
    }

    // Ember Barb: glowing embers stream off the head
    if (this.ember && this.group.visible !== false) {
      this.emberAcc += dt * this.factory.emberRate;
      const sp = this.factory.spriteBatch;
      while (this.emberAcc >= 1) {
        this.emberAcc -= 1;
        if (sp.load() > 0.85) continue;
        const s = sp.begin(Shape.Glow);
        const back = Math.random() * 0.5;
        s.pos(hx - fwd.x * back + (Math.random() - 0.5) * 0.25, hy + (Math.random() - 0.3) * 0.2, hz - fwd.z * back + (Math.random() - 0.5) * 0.25);
        s.vel((Math.random() - 0.5) * 1.2 - fwd.x * 1.5, 0.6 + Math.random() * 1.4, (Math.random() - 0.5) * 1.2 - fwd.z * 1.5);
        s.color(Math.random() < 0.3 ? 0xffe07a : 0xff7a1e, 3.2).colorEnd(0xc0200a, 1.2);
        s.size(0.16 + Math.random() * 0.12, 0.04);
        s.life = 0.35 + Math.random() * 0.45;
        s.drag = 1.5;
        s.grav = 1.2;
        s.wobble = 1.4;
        s.wobbleF = 9;
        s.fin = 0.02;
        sp.emit(s);
        if (Math.random() < 0.18) {
          const k = sp.begin(Shape.Spark);
          k.flags = PF.Stretch;
          k.stretch = 0.05;
          k.pos(hx, hy, hz);
          k.vel((Math.random() - 0.5) * 3 - fwd.x * 2, 1 + Math.random() * 2.5, (Math.random() - 0.5) * 3 - fwd.z * 2);
          k.color(0xffc04a, 3.5).colorEnd(0xff4a10, 2);
          k.size(0.05);
          k.life = 0.3;
          k.grav = -6;
          sp.emit(k);
        }
      }
    }
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.group.visible = false;
    this.links.count = 0;
    if (this.extras) this.extras.count = 0;
    this.head.scale.setScalar(this.scale);
    this.release();
  }

  /** Free per-chain GPU objects (instance buffers). Shared geometry/materials belong to the factory. */
  destroy(): void {
    this.active = false;
    this.links.dispose();
    this.extras?.dispose();
  }
}
