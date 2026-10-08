// Hook and grapple chains: instanced voxel links laid out by arc length from the hook head back to
// the thrower's hand, a gentle sag and whip while paying out, taut and rattling while reeling in.
// The head is the thrower's hook skin (./hookSkins.ts, the same model the Pudgy holds), the line
// style follows the skin (laid rope, tarred rope, gold-wrapped rope, vine, root, steel chain, heavy
// anchor chain, cable, insulated hose).
//
// Power-ups from HookSnap.fx: bit 1 Ember Barb (the head glows hot, embers stream off), bit 2 Ricochet
// Spring / Boing Barb (a pink spring coil round the shank, pink sparkle motes), bit 4 Bendy Eel (a wavy
// glowing eel trail along the curve the hook steered through), bit 8 Long Line (the line glows
// red-orange with pulses running to the head, and a comet streak trails the head).
//
// Chains are pooled per (kind, skin): GameClient creates one per throw and disposes it when the hook
// ends, so dispose() hands the object back to the pool. Geometry and materials are cached by
// hookSkins / sculpt for the page's lifetime; only per-chain instance buffers are freed here.
import * as THREE from 'three';
import { RUNE_COLORS } from '../../../shared/constants.ts';
import type { FamilyId, Team } from '../../../shared/types.ts';
import type { ChainView, Quality } from '../contracts.ts';
import { FLY_SCALE, coilGeometry, grappleGeometry, linkGeometry, skinGeometry, type SkinGeo } from './hookSkins.ts';
import { PF, Shape, type SpriteBatch } from './particles.ts';
import { fxUniforms, surfMaterial, twinkleMesh } from './sculpt.ts';
import { Ribbon } from './trails.ts';
import type { LinkRecipe } from './skinModels.ts';

/** Metres of line one hook can show: Long Line at range level 5 is 39 m, plus Bendy Eel bends. */
const MAX_LEN = 52;
const UP = new THREE.Vector3(0, 1, 0);

export const FxBit = { Ember: 1, Spring: 2, Steer: 4, Longshot: 8 } as const;

interface Style {
  key: string;
  skin: SkinGeo;
  link: LinkRecipe;
  linkGeo: THREE.BufferGeometry;
  extraGeo: THREE.BufferGeometry | null;
}

/** All shared chain state. One per FxSystem. */
export class ChainFactory {
  private readonly root: THREE.Object3D;
  private readonly sprites: SpriteBatch;
  private readonly quality: Quality;
  private readonly styles = new Map<string, Style>();
  private readonly pools = new Map<string, ChainImpl[]>();
  private readonly all: ChainImpl[] = [];
  readonly coilGeo: THREE.BufferGeometry;
  readonly castShadow: boolean;
  readonly emberRate: number;
  readonly moteRate: number;
  /** chains active this frame (for per-frame shared work) */
  activeCount = 0;

  constructor(root: THREE.Object3D, sprites: SpriteBatch, quality: Quality) {
    this.root = root;
    this.sprites = sprites;
    this.quality = quality;
    this.castShadow = quality !== 'low';
    this.emberRate = quality === 'low' ? 14 : quality === 'medium' ? 30 : quality === 'high' ? 45 : 60;
    this.moteRate = quality === 'low' ? 10 : quality === 'medium' ? 18 : quality === 'high' ? 26 : 34;
    this.coilGeo = coilGeometry(quality);
  }

  private style(kind: 0 | 1, family: FamilyId, skin: string | undefined): Style {
    const sg = kind === 1 ? grappleGeometry(family, this.quality) : skinGeometry(family, skin, this.quality);
    const key = `${kind}:${sg.recipe.id}`;
    let s = this.styles.get(key);
    if (!s) {
      const l = linkGeometry(sg.recipe.link, this.quality);
      s = { key, skin: sg, link: l.recipe, linkGeo: l.geo, extraGeo: l.extra };
      this.styles.set(key, s);
    }
    return s;
  }

  acquire(kind: 0 | 1, family: FamilyId, team: Team, fxBits: number, radius?: number, skin?: string): ChainImpl {
    const style = this.style(kind, family, skin);
    let pool = this.pools.get(style.key);
    if (!pool) {
      pool = [];
      this.pools.set(style.key, pool);
    }
    let c = pool.pop();
    if (!c) {
      const p = pool;
      const made: ChainImpl = new ChainImpl(this, style, kind, () => p.push(made));
      c = made;
      this.root.add(c.group);
      this.root.add(c.trail.mesh);
      this.all.push(c);
    }
    c.activate(team, fxBits, radius);
    return c;
  }

  get spriteBatch(): SpriteBatch {
    return this.sprites;
  }

  /** Build the default styles now and keep them pooled, so the first throw never builds geometry. */
  prebuild(skins?: readonly { family: FamilyId; skin?: string }[]): ChainImpl[] {
    const out: ChainImpl[] = [];
    const list = skins ?? (['brawler', 'ogre', 'bot'] as const).map((f) => ({ family: f, skin: undefined }));
    for (const s of list) out.push(this.acquire(0, s.family, 0, 0, undefined, s.skin));
    for (const f of ['brawler', 'ogre', 'bot'] as const) out.push(this.acquire(1, f, 1, 0));
    return out;
  }

  /** Make sure a skin's geometry and one pooled chain exist (call at match start for every player). */
  prepare(kind: 0 | 1, family: FamilyId, skin?: string): void {
    const style = this.style(kind, family, skin);
    const pool = this.pools.get(style.key);
    if (pool && pool.length) return;
    this.acquire(kind, family, 0, 0, undefined, skin).dispose();
  }

  dispose(): void {
    for (const c of this.all) {
      this.root.remove(c.group);
      this.root.remove(c.trail.mesh);
      c.destroy();
    }
    this.all.length = 0;
    this.pools.clear();
    this.styles.clear();
  }

  get tier(): Quality {
    return this.quality;
  }

  /** live chains (debug) */
  get liveChains(): number {
    let n = 0;
    for (const c of this.all) if (c.isActive) n++;
    return n;
  }
}

// scratch buffers shared by every chain (updates run one at a time)
let SP = new Float32Array(64 * 3);
let SC = new Float32Array(64);
const LMAX = Math.ceil(MAX_LEN / 0.09) + 8;
const LP = new Float32Array(LMAX * 3);
const vF = new THREE.Vector3();
const vR = new THREE.Vector3();
const vU = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();

const BENDY = RUNE_COLORS.bendy;
const BOUNCY = RUNE_COLORS.bouncy;
const LONG = RUNE_COLORS.longshot;

export class ChainImpl implements ChainView {
  readonly group = new THREE.Group();
  readonly trail = new Ribbon();
  private readonly factory: ChainFactory;
  private readonly style: Style;
  private readonly kind: 0 | 1;
  private readonly links: THREE.InstancedMesh;
  private readonly extras: THREE.InstancedMesh | null;
  private readonly head = new THREE.Group();
  private readonly headTilt = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly coil: THREE.Mesh;
  private readonly twinkle: THREE.Mesh | null;
  private readonly release: () => void;
  private readonly capLinks: number;
  private readonly capExtras: number;
  private active = false;
  private team: Team = 0;
  private slack = 1;
  private age = 0;
  private ember = false;
  private spring = false;
  private steer = false;
  private longshot = false;
  private scale = 1;
  private emberAcc = 0;
  private moteAcc = 0;
  private lastFwd = new THREE.Vector3(0, 0, 1);
  private carryK = 0;
  private time = 0;

  constructor(factory: ChainFactory, style: Style, kind: 0 | 1, release: () => void) {
    this.factory = factory;
    this.style = style;
    this.kind = kind;
    this.release = release;
    const spacing = style.link.spacing;
    this.capLinks = Math.min(LMAX, Math.ceil(MAX_LEN / spacing) + 4);
    this.links = new THREE.InstancedMesh(style.linkGeo, surfMaterial('base', 0), this.capLinks);
    this.links.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.links.frustumCulled = false;
    this.links.castShadow = factory.castShadow;
    this.links.count = 0;
    this.links.name = 'hw-chain-links';
    this.group.add(this.links);
    if (style.extraGeo && style.link.extraEvery > 0) {
      this.capExtras = Math.ceil(this.capLinks / style.link.extraEvery) + 2;
      this.extras = new THREE.InstancedMesh(style.extraGeo, surfMaterial('base', 0), this.capExtras);
      this.extras.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.extras.frustumCulled = false;
      this.extras.castShadow = factory.castShadow;
      this.extras.count = 0;
      this.group.add(this.extras);
    } else {
      this.capExtras = 0;
      this.extras = null;
    }
    this.body = new THREE.Mesh(style.skin.head, surfMaterial('base', 0));
    this.body.name = 'hw-chain-head';
    this.coil = new THREE.Mesh(factory.coilGeo, surfMaterial('base', 2));
    for (const m of [this.body, this.coil]) {
      m.castShadow = factory.castShadow;
      m.frustumCulled = false;
      this.headTilt.add(m);
    }
    this.twinkle = style.skin.twinkle ? twinkleMesh(style.skin.twinkle) : null;
    if (this.twinkle) this.headTilt.add(this.twinkle);
    this.head.add(this.headTilt);
    this.group.add(this.head);
    this.group.visible = false;
  }

  get isActive(): boolean {
    return this.active;
  }

  activate(team: Team, fxBits: number, radius?: number): void {
    this.active = true;
    this.team = team === 1 ? 1 : 0;
    this.applyScale(radius);
    this.setFx(fxBits);
    this.slack = 1;
    this.age = 0;
    this.emberAcc = 0;
    this.moteAcc = 0;
    this.carryK = 0;
    this.links.count = 0;
    if (this.extras) this.extras.count = 0;
    this.group.visible = false;
  }

  /**
   * Change the power-up bits (and head radius) of a live chain. Online, the predicted ("ghost")
   * chain is handed to the real hook; calling this with HookSnap.fx at the hand-over keeps the
   * power-up visuals right.
   */
  setFx(fxBits: number, radius?: number): void {
    const bits = fxBits | 0;
    const t = this.team;
    this.ember = (bits & FxBit.Ember) !== 0;
    this.spring = (bits & FxBit.Spring) !== 0;
    const steer = (bits & FxBit.Steer) !== 0 && this.kind === 0;
    const longshot = (bits & FxBit.Longshot) !== 0 && this.kind === 0;
    this.body.material = surfMaterial(this.ember ? 'ember' : 'base', t);
    const lm = surfMaterial(longshot ? 'longshot' : 'base', t);
    this.links.material = lm;
    if (this.extras) this.extras.material = lm;
    const sk = this.style.skin;
    this.coil.visible = this.spring;
    this.coil.position.set(sk.coil.x, 0, sk.coil.z);
    if (steer && !this.steer) this.trail.begin('eel', BENDY.main, BENDY.light, 2.2);
    else if (longshot && !this.longshot && !steer) this.trail.begin('streak', LONG.main, LONG.light, 2.4);
    else if (!steer && !longshot) this.trail.stop();
    this.steer = steer;
    this.longshot = longshot;
    if (radius !== undefined) this.applyScale(radius);
  }

  /** Head size: the readability scale times the Width upgrade (HookSnap.r). */
  private applyScale(radius: number | undefined): void {
    const r = radius ?? 0.45;
    const fly = this.kind === 1 ? FLY_SCALE * 0.95 : FLY_SCALE;
    this.scale = fly * Math.min(1.33, Math.max(1, Math.pow(r / 0.45, 0.5)));
    this.head.scale.setScalar(this.scale);
  }

  setVisible(v: boolean): void {
    this.group.visible = v && this.active;
    if (!this.group.visible) this.trail.mesh.visible = false;
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
    this.links.material = surfMaterial('longshot', 0);
    if (this.extras) {
      this.extras.setMatrixAt(0, tmpM);
      this.extras.count = 1;
      this.extras.instanceMatrix.needsUpdate = true;
    }
    this.coil.visible = true;
    this.body.material = surfMaterial('ember', 1);
    this.trail.begin('eel', BENDY.main, BENDY.light, 2);
    this.trail.update(x, y, z, 0.016, 0, true, 1e-4);
    this.trail.update(x + 0.3, y, z, 0.016, 0, true, 1e-4);
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
    const sk = this.style.skin;
    const eye = sk.eye * this.scale;

    // head pose: flat, along the last segment, with a little flight wobble
    this.head.position.set(hx, hy, hz);
    this.head.rotation.set(0, Math.atan2(fwd.x, fwd.z), 0);
    const wob = this.slack;
    this.headTilt.rotation.set(
      Math.sin(this.time * 7.1) * 0.06 * wob + this.carryK * 0.14,
      Math.sin(this.time * 5.3) * 0.05 * wob,
      Math.sin(this.time * 9.7) * 0.16 * wob + (1 - wob) * Math.sin(this.time * 47) * 0.04,
    );
    if (sk.closed) this.body.geometry = this.carryK > 0.5 || state.retracting ? sk.closed : sk.head;
    if (this.ember) fxUniforms.uHeat.value = 2.2 + Math.sin(this.time * 13) * 0.35 + Math.sin(this.time * 31) * 0.2;
    if (this.spring) {
      // boing: the coil squashes and stretches, faster right after a bounce would be nice but the
      // chain does not hear bounces; a lively constant spring reads well
      const k = sk.coil.r / 0.1;
      const s = 1 + Math.sin(this.time * 24) * 0.22 * (0.35 + wob);
      this.coil.scale.set(k, k, k * s);
      this.coil.rotation.z = this.time * 4;
    }

    // ---- links, laid out from the eye of the head back toward the hand ----
    const link = this.style.link;
    const spacing = link.spacing;
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
        const sag = Math.min(link.sagMax, segLen * link.sagPerM) * this.slack;
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
    const twist = link.twist;
    const alt = link.alt;
    const rollJ = (1 - this.slack) * 0.35;
    let extraCount = 0;
    const earr = this.extras ? (this.extras.instanceMatrix.array as Float32Array) : null;
    const every = link.extraEvery;
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
      const rx = vR.x * c + vU.x * s;
      const ry = vR.y * c + vU.y * s;
      const rz = vR.z * c + vU.z * s;
      const ux = vU.x * c - vR.x * s;
      const uy = vU.y * c - vR.y * s;
      const uz = vU.z * c - vR.z * s;
      // links near the hand pop in so the line seems to pay out of the fist
      const remain = (count - k) * spacing;
      const sc = remain < 0.3 ? Math.max(0.2, remain / 0.3) : 1;
      // each link runs from its sample back toward the hand, so the line meets the eye exactly
      const cx = x - vF.x * spacing * 0.5;
      const cy = y - vF.y * spacing * 0.5;
      const cz = z - vF.z * spacing * 0.5;
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
      arr[o + 12] = cx;
      arr[o + 13] = cy;
      arr[o + 14] = cz;
      arr[o + 15] = 1;
      if (earr && every > 0 && k % every === every - 1 && extraCount < this.capExtras) {
        // extra (knot or leaf): flip sides for leaves, slight droop
        const flip = link.extraFlip && extraCount & 1 ? -1 : 1;
        const eo = extraCount * 16;
        const droop = link.extraFlip ? -0.35 : 0;
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

    // ---- power-up trails (Bendy Eel, Long Line) ----
    const flying = !state.retracting && !state.carrying;
    if (this.trail.active) this.trail.update(hx, hy, hz, dt, this.time, flying && this.group.visible, Math.min(1.3, this.scale / FLY_SCALE));
    if (!this.group.visible) return;
    const sp = this.factory.spriteBatch;
    // the hottest point of the skin, in world space (yaw only, the tilt is small)
    const cy = Math.cos(this.head.rotation.y);
    const sy = Math.sin(this.head.rotation.y);
    const hp = sk.hot;
    const wx = hx + (hp.x * cy + hp.z * sy) * this.scale;
    const wz = hz + (-hp.x * sy + hp.z * cy) * this.scale;
    const wy = hy + hp.y * this.scale;

    // Ember Barb: glowing embers stream off the business end
    if (this.ember) {
      this.emberAcc += dt * this.factory.emberRate;
      while (this.emberAcc >= 1) {
        this.emberAcc -= 1;
        if (sp.load() > 0.85) continue;
        const s = sp.begin(Shape.Glow);
        const back = Math.random() * 0.4;
        s.pos(wx - fwd.x * back + (Math.random() - 0.5) * 0.25, wy + (Math.random() - 0.3) * 0.2, wz - fwd.z * back + (Math.random() - 0.5) * 0.25);
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
          k.pos(wx, wy, wz);
          k.vel((Math.random() - 0.5) * 3 - fwd.x * 2, 1 + Math.random() * 2.5, (Math.random() - 0.5) * 3 - fwd.z * 2);
          k.color(0xffc04a, 3.5).colorEnd(0xff4a10, 2);
          k.size(0.05);
          k.life = 0.3;
          k.grav = -6;
          sp.emit(k);
        }
      }
    }

    // power-up motes: pink boing sparkles, yellow eel glints, red-orange speed sparks
    if ((this.spring || this.steer || this.longshot) && flying) {
      this.moteAcc += dt * this.factory.moteRate;
      while (this.moteAcc >= 1) {
        this.moteAcc -= 1;
        if (sp.load() > 0.8) continue;
        const pick = this.longshot && (!this.spring || Math.random() < 0.6) ? 2 : this.steer && (!this.spring || Math.random() < 0.5) ? 1 : 0;
        if (pick === 2) {
          // speed sparks flicking back off the head
          const k = sp.begin(Shape.Spark);
          k.flags = PF.Stretch;
          k.stretch = 0.06;
          const side = (Math.random() - 0.5) * 0.5;
          k.pos(hx - fwd.z * side, hy + (Math.random() - 0.5) * 0.25, hz + fwd.x * side);
          const v = 6 + Math.random() * 6;
          k.vel(-fwd.x * v + (Math.random() - 0.5), Math.random() * 0.8, -fwd.z * v + (Math.random() - 0.5));
          k.color(Math.random() < 0.4 ? LONG.light : LONG.main, 3).colorEnd(0xff2a0a, 1.4);
          k.size(0.07, 0.03);
          k.life = 0.22 + Math.random() * 0.12;
          k.drag = 4;
          sp.emit(k);
        } else if (pick === 1) {
          const s = sp.begin(Shape.Star);
          s.pos(hx + (Math.random() - 0.5) * 0.6, hy + Math.random() * 0.3, hz + (Math.random() - 0.5) * 0.6);
          s.vel((Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6);
          s.color(Math.random() < 0.5 ? BENDY.light : BENDY.main, 2.6);
          s.size(0.22 + Math.random() * 0.12, 0.05);
          s.life = 0.45 + Math.random() * 0.3;
          s.drag = 2;
          s.rotV = (Math.random() - 0.5) * 6;
          s.fin = 0.05;
          sp.emit(s);
        } else {
          // boing: pink sparkles springing up and out of the coil
          const c = this.coil;
          c.getWorldPosition(tmpV);
          const s = sp.begin(Math.random() < 0.5 ? Shape.Star : Shape.Glow);
          s.pos(tmpV.x + (Math.random() - 0.5) * 0.3, tmpV.y + 0.05, tmpV.z + (Math.random() - 0.5) * 0.3);
          s.vel((Math.random() - 0.5) * 1.6, 1.6 + Math.random() * 1.8, (Math.random() - 0.5) * 1.6);
          s.color(Math.random() < 0.4 ? BOUNCY.light : BOUNCY.main, 2.6);
          s.size(0.18 + Math.random() * 0.12, 0.04);
          s.life = 0.4 + Math.random() * 0.25;
          s.grav = -7;
          s.drag = 1;
          s.flags = PF.FloorBounce;
          s.floorY = hy - 0.9;
          s.bounce = 0.6;
          s.rotV = (Math.random() - 0.5) * 8;
          sp.emit(s);
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
    this.trail.stop();
    this.steer = false;
    this.longshot = false;
    this.head.scale.setScalar(this.scale);
    this.release();
  }

  /** Free per-chain GPU objects (instance buffers, the trail). Shared geometry/materials are cached. */
  destroy(): void {
    this.active = false;
    this.links.dispose();
    this.extras?.dispose();
    this.trail.dispose();
  }
}
