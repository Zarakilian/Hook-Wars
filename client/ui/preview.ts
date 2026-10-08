// Live 3D preview of your Pudgy (menu, Locker, Store): one small WebGLRenderer for the whole session,
// a wooden dock pedestal, a turntable you can drag, and an idle animation. Leaving a screen stops
// rendering and frees the model, but keeps the context: creating and force-losing a context on every
// screen change makes Chrome block WebGL for the page.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CosmeticSlot, Loadout } from '../../shared/cosmetics.ts';
import type { Profile } from '../../shared/protocol.ts';
import { UnitState, type FamilyId, type Team } from '../../shared/types.ts';
import type { PudgyOneShot, PudgyView } from '../render/contracts.ts';
import { createPudgy } from '../render/models/pudgy.ts';

const ONE_SHOTS: PudgyOneShot[] = ['celebrate', 'throw', 'bash', 'grapple', 'melee'];

/** Camera framing per slot: look-at height (fraction of the model height) and distance multiplier. */
const FOCUS: Record<CosmeticSlot | 'all', { y: number; d: number }> = {
  all: { y: 0.42, d: 1.14 },
  head: { y: 0.74, d: 0.74 },
  face: { y: 0.7, d: 0.68 },
  body: { y: 0.5, d: 0.9 },
  hands: { y: 0.5, d: 0.92 },
  feet: { y: 0.3, d: 0.8 },
  back: { y: 0.56, d: 0.92 },
};

export interface PreviewLook {
  family: FamilyId;
  loadout: Loadout;
  team: Team;
  name?: string;
}

export class PudgyPreview {
  canvas: HTMLCanvasElement;
  private dragMoved = 0;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private envTex: THREE.Texture | null = null;
  private pedestal: THREE.Group | null = null;
  private pedestalGeoms: THREE.BufferGeometry[] = [];
  private pedestalMats: THREE.Material[] = [];
  private spinner = new THREE.Group();
  private pudgy: PudgyView | null = null;
  private key = '';
  private raf = 0;
  private last = 0;
  private time = 0;
  private yaw = 0.5;
  private yawVel = 0;
  private dragging = false;
  private dragX = 0;
  private idleSince = 0;
  private nextShot = 6;
  private resizeObs: ResizeObserver | null = null;
  private target = new THREE.Vector3(0, 1, 0);
  private dist = 5;
  private failed = false;
  private failedAt = 0;
  private focusKey: CosmeticSlot | 'all' = 'all';
  private modelH = 0;
  /** seconds until the model is measured again (after a spawn pop or a one-shot settles) */
  private refitIn = 0;
  private baseDist = 5;
  private camY = 1.25;
  private camDist = 0;
  private idleSpin = true;
  /** last look shown, so a remount (renderer re-created) restores it */
  private look: PreviewLook | null = null;

  constructor() {
    this.canvas = this.makeCanvas();
  }

  private makeCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.className = 'preview-canvas';
    c.setAttribute('aria-label', 'Your Pudgy. Drag to spin, click to show off.');
    c.setAttribute('role', 'img');
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragX = e.clientX;
      this.yawVel = 0;
      this.dragMoved = 0;
      c.setPointerCapture(e.pointerId);
      this.idleSince = this.time;
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragX;
      this.dragX = e.clientX;
      this.dragMoved += Math.abs(dx);
      this.yaw += dx * 0.012;
      this.yawVel = dx * 0.7;
    });
    const up = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.dragMoved < 4 && e.type === 'pointerup') this.showOff();
      this.idleSince = this.time;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    return c;
  }

  get active(): boolean {
    return this.renderer !== null;
  }

  /** Attach to a container and start rendering. */
  mount(parent: HTMLElement): void {
    // a failed context creation is retried after a pause instead of disabling the preview for good
    if (this.failed && performance.now() - this.failedAt < 3000) return;
    if (this.canvas.parentElement !== parent) parent.append(this.canvas);
    if (!this.renderer) {
      if (this.failed) this.canvas = this.replaceCanvas(parent);
      this.failed = false;
      this.init();
    }
    if (!this.renderer) return;
    if (this.look && this.key === '') this.show(this.look, 'spawn');
    this.resizeObs?.disconnect();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.canvas);
    this.resize();
    this.start();
  }

  /** A fresh canvas element in place of one whose context creation failed. */
  private replaceCanvas(parent: HTMLElement): HTMLCanvasElement {
    const c = this.makeCanvas();
    this.canvas.remove();
    parent.append(c);
    return c;
  }

  private init(): void {
    try {
      const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.toneMapping = THREE.AgXToneMapping;
      r.toneMappingExposure = 1.15;
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFShadowMap;
      r.setClearColor(0x000000, 0);
      this.renderer = r;
    } catch {
      this.failed = true;
      this.failedAt = performance.now();
      this.renderer = null;
      return;
    }
    this.canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTex = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    scene.environment = this.envTex;
    scene.environmentIntensity = 0.55;

    const hemi = new THREE.HemisphereLight(0xfff0d8, 0x2a3a48, 0.9);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffe2b8, 2.6);
    key.position.set(2.6, 5, 3.4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = -2.2;
    sc.right = 2.2;
    sc.top = 3.2;
    sc.bottom = -1;
    sc.near = 0.5;
    sc.far = 14;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fd0ff, 2.2);
    rim.position.set(-3, 2.6, -3.5);
    scene.add(rim);
    const fill = new THREE.PointLight(0xffa860, 6, 6, 1.6);
    fill.position.set(-1.8, 0.6, 2.2);
    scene.add(fill);

    this.pedestal = this.buildPedestal();
    scene.add(this.pedestal);
    scene.add(this.spinner);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 60);
    this.key = '';
  }

  /** A round wooden dock post with rope trim and brass bolts. */
  private buildPedestal(): THREE.Group {
    const g = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], y: number, shadow = true) => {
      this.pedestalGeoms.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.y = y;
      m.receiveShadow = shadow;
      m.castShadow = false;
      g.add(m);
      return m;
    };
    // plank texture drawn on a canvas (no external assets)
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 256;
    const ctx = cv.getContext('2d');
    let tex: THREE.CanvasTexture | null = null;
    if (ctx) {
      ctx.fillStyle = '#7a5232';
      ctx.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 8; i++) {
        const x = i * 32;
        ctx.fillStyle = i % 2 ? '#835a37' : '#6f4a2c';
        ctx.fillRect(x, 0, 31, 256);
        ctx.fillStyle = 'rgba(30,15,5,0.7)';
        ctx.fillRect(x + 31, 0, 2, 256);
        for (let k = 0; k < 14; k++) {
          ctx.fillStyle = `rgba(${k % 2 ? '40,20,8' : '180,130,80'},0.18)`;
          ctx.fillRect(x + ((k * 7) % 28), 0, 1, 256);
        }
        ctx.fillStyle = '#d9a441';
        ctx.beginPath();
        ctx.arc(x + 16, 40 + ((i * 53) % 170), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
    }
    const top = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.82, metalness: 0 });
    const side = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 });
    const rope = new THREE.MeshStandardMaterial({ color: 0xc9a062, roughness: 0.95 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.32, metalness: 0.9 });
    // soft contact shadow under the post (radial gradient, no lighting)
    const sc = document.createElement('canvas');
    sc.width = 128;
    sc.height = 128;
    const sctx = sc.getContext('2d');
    let shadowTex: THREE.CanvasTexture | null = null;
    if (sctx) {
      const g = sctx.createRadialGradient(64, 64, 20, 64, 64, 64);
      g.addColorStop(0, 'rgba(0,0,0,0.75)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.35)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, 128, 128);
      shadowTex = new THREE.CanvasTexture(sc);
    }
    const water = new THREE.MeshBasicMaterial({ map: shadowTex, color: 0xffffff, transparent: true, depthWrite: false });
    if (shadowTex) (water as THREE.MeshBasicMaterial & { userData: { tex?: THREE.Texture } }).userData.tex = shadowTex;
    this.pedestalMats.push(top, side, rope, brass, water);
    if (tex) (top as THREE.MeshStandardMaterial & { userData: { tex?: THREE.Texture } }).userData.tex = tex;
    add(new THREE.CylinderGeometry(1.15, 1.2, 0.32, 40), [side, top, side], -0.16);
    add(new THREE.TorusGeometry(1.19, 0.055, 8, 48), rope, -0.06).rotation.x = Math.PI / 2;
    add(new THREE.TorusGeometry(1.21, 0.05, 8, 48), rope, -0.2).rotation.x = Math.PI / 2;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const b = add(new THREE.SphereGeometry(0.045, 10, 8), brass, -0.13);
      b.position.x = Math.cos(a) * 1.21;
      b.position.z = Math.sin(a) * 1.21;
    }
    add(new THREE.CircleGeometry(1.55, 40), water, -0.33, false).rotation.x = -Math.PI / 2;
    return g;
  }

  /** Show this profile (rebuilds the model only when family or cosmetics change). */
  set(p: Profile, team: Team): void {
    this.show({ family: p.family, loadout: p.loadout, team, name: p.name });
  }

  /**
   * Show any look (Locker try-on, Store preview). Rebuilds only when family, loadout or team change.
   * anim: one-shot to play after a rebuild ('celebrate' by default when only the outfit changed).
   */
  show(look: PreviewLook, anim?: PudgyOneShot | null): void {
    this.look = { ...look, loadout: { ...look.loadout } };
    if (!this.renderer || !this.scene) return;
    const key = `${look.family}|${JSON.stringify(look.loadout)}|${look.team}`;
    if (key === this.key) return;
    const firstBuild = this.key === '';
    const familyChanged = !firstBuild && this.key.split('|')[0] !== look.family;
    this.key = key;
    if (familyChanged || firstBuild) this.modelH = 0;
    this.disposePudgy();
    try {
      const v = createPudgy({ family: look.family, loadout: look.loadout, team: look.team, name: look.name ?? 'Pudgy', isLocal: true, quality: 'high', detail: 'showcase' });
      v.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      this.spinner.add(v.root);
      this.pudgy = v;
      v.update(1 / 60, this.anim(0));
      this.spinner.updateMatrixWorld(true);
      this.frameModel();
      const shot = anim === undefined ? (familyChanged || firstBuild ? 'spawn' : 'celebrate') : anim;
      if (shot) v.play(shot);
      this.refitIn = shot === 'spawn' ? 0.9 : 0.15;
    } catch (err) {
      console.warn('[preview] could not build the Pudgy model', err);
      this.pudgy = null;
    }
    this.renderOnce(0);
  }

  /** Ease the camera onto one cosmetic slot (null = whole body). The back slot turns the model around. */
  focus(slot: CosmeticSlot | null): void {
    this.focusKey = slot ?? 'all';
    this.idleSpin = slot !== 'back';
    if (slot === 'back') {
      // shortest turn to face away from the camera
      const t = Math.PI;
      const cur = ((this.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      this.yaw += ((t - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    }
  }

  /** Play a one-shot (equip feedback). */
  play(kind: PudgyOneShot): void {
    try {
      this.pudgy?.play(kind);
    } catch {
      // ignore
    }
  }

  private frameModel(): void {
    if (!this.camera) return;
    // Pudgies are roughly 2 to 3 m tall. Clamp the measured box so a one-shot pose (or a model
    // that starts its spawn pop at scale 0) never makes the camera crop or lose the character.
    let height = this.modelH > 0 ? this.modelH : 2;
    let width = 1.8;
    if (this.pudgy) {
      this.pudgy.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.pudgy.root);
      const size = box.isEmpty() ? null : box.getSize(new THREE.Vector3());
      if (size && size.y > 0.8) {
        // a real pose; a spawn pop that starts near scale 0 is ignored and re-measured later
        height = Math.max(1.2, Math.min(3.4, size.y));
        width = Math.max(1.2, Math.min(3, Math.max(size.x, size.z)));
      } else this.refitIn = Math.max(this.refitIn, 0.3);
    }
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.6, this.camera.aspect);
    const fitH = (height * 1.18) / 2 / Math.tan(fov / 2);
    const fitW = (width * 1.3) / 2 / Math.tan(fov / 2) / aspect;
    this.baseDist = Math.max(fitH, fitW) + width * 0.3;
    this.modelH = height;
    const f = FOCUS[this.focusKey];
    this.dist = this.baseDist * f.d;
    this.target.set(0, height * f.y, 0);
    if (this.camDist <= 0.01 || !Number.isFinite(this.camDist)) {
      this.camDist = this.dist;
      this.camY = this.target.y;
    }
  }

  private anim(dt: number) {
    return { state: UnitState.Alive, speed: 0, hpFrac: 1, flags: 0, hookOut: false, stateTime: this.time + dt, time: this.time + dt };
  }

  private showOff(): void {
    const shot = ONE_SHOTS[Math.floor(Math.random() * ONE_SHOTS.length)];
    try {
      this.pudgy?.play(shot);
    } catch {
      // a broken model never takes the menu down
    }
  }

  private start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.renderOnce(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Step the animation by dt and draw one frame. */
  renderOnce(dt: number): void {
    const r = this.renderer;
    if (!r || !this.scene || !this.camera) return;
    this.time += dt;
    if (!this.dragging) {
      this.yawVel *= Math.exp(-dt * 3);
      this.yaw += ((this.idleSpin ? 0.32 : 0) + this.yawVel * 0.02) * dt;
    }
    if (this.refitIn > 0 && dt > 0) {
      this.refitIn -= dt;
      if (this.refitIn <= 0) {
        this.refitIn = 0;
        const yaw = this.spinner.rotation.y;
        this.spinner.rotation.y = 0;
        this.frameModel();
        this.spinner.rotation.y = yaw;
      }
    }
    const f = FOCUS[this.focusKey];
    const wantD = this.baseDist * f.d;
    const wantY = this.modelH * f.y;
    const k = dt > 0 ? 1 - Math.exp(-dt * 6) : 0;
    this.camDist += (wantD - this.camDist) * k;
    this.camY += (wantY - this.camY) * k;
    this.dist = this.camDist;
    this.target.y = this.camY;
    this.spinner.rotation.y = this.yaw;
    if (this.pudgy) {
      try {
        this.pudgy.update(dt, this.anim(0));
      } catch {
        // ignore animation errors from a model that is mid-rewrite
      }
      if (this.time - this.idleSince > this.nextShot) {
        this.idleSince = this.time;
        this.nextShot = 7 + Math.random() * 6;
        this.showOff();
      }
    }
    const cam = this.camera;
    const tilt = 0.28;
    cam.position.set(0, this.target.y + Math.sin(tilt) * this.dist, Math.cos(tilt) * this.dist);
    cam.lookAt(this.target);
    r.render(this.scene, cam);
  }

  private resize(): void {
    const r = this.renderer;
    if (!r || !this.camera) return;
    const w = Math.max(1, Math.round(this.canvas.clientWidth));
    const hgt = Math.max(1, Math.round(this.canvas.clientHeight));
    r.setSize(w, hgt, false);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    this.frameModel();
    this.renderOnce(0);
  }

  private disposePudgy(): void {
    if (!this.pudgy) return;
    this.spinner.remove(this.pudgy.root);
    try {
      this.pudgy.dispose();
    } catch {
      // ignore
    }
    this.pudgy = null;
  }

  /** Leave the screen: stop rendering, free the model, keep the renderer and pedestal for the next screen. */
  unmount(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.disposePudgy();
    this.key = '';
    this.camDist = 0;
    this.dragging = false;
    this.canvas.remove();
  }

  /** Free every GPU resource for good (not used by the screens, which share one preview). */
  dispose(): void {
    this.unmount();
    for (const g of this.pedestalGeoms) g.dispose();
    for (const m of this.pedestalMats) {
      const t = (m.userData as { tex?: THREE.Texture }).tex;
      t?.dispose();
      m.dispose();
    }
    this.pedestalGeoms = [];
    this.pedestalMats = [];
    this.envTex?.dispose();
    this.envTex = null;
    this.pedestal = null;
    this.scene = null;
    this.camera = null;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
