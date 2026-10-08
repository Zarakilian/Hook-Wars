// Live 3D preview of your Pudgy for the profile card: its own small WebGLRenderer, a wooden dock
// pedestal, a turntable you can drag, and an idle animation. Fully disposed when hidden.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Profile } from '../../shared/protocol.ts';
import { UnitState, type Team } from '../../shared/types.ts';
import type { PudgyOneShot, PudgyView } from '../render/contracts.ts';
import { createPudgy } from '../render/models/pudgy.ts';

const ONE_SHOTS: PudgyOneShot[] = ['celebrate', 'throw', 'bash', 'grapple', 'melee'];

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
  private used = false;

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
    if (this.failed) return;
    if (!this.renderer) {
      // a canvas whose context was force-lost cannot host a new renderer: start fresh
      if (this.used) this.canvas = this.makeCanvas();
      this.used = true;
    }
    if (this.canvas.parentElement !== parent) parent.append(this.canvas);
    if (!this.renderer) this.init();
    if (!this.renderer) return;
    this.resizeObs?.disconnect();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.canvas);
    this.resize();
    this.start();
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
      return;
    }
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
    const water = new THREE.MeshStandardMaterial({ color: 0x1d6f8a, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.55 });
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
    add(new THREE.CircleGeometry(2.4, 48), water, -0.34, true).rotation.x = -Math.PI / 2;
    return g;
  }

  /** Show this profile (rebuilds the model only when family or cosmetics change). */
  set(p: Profile, team: Team): void {
    if (!this.renderer || !this.scene) return;
    const key = `${p.family}|${p.cosmetics.hat}|${p.cosmetics.accent}|${p.cosmetics.face}|${team}`;
    if (key === this.key) return;
    const firstBuild = this.key === '';
    const familyChanged = !firstBuild && this.key.split('|')[0] !== p.family;
    this.key = key;
    this.disposePudgy();
    try {
      const v = createPudgy({ family: p.family, cosmetics: p.cosmetics, team, name: p.name, isLocal: true, quality: 'high' });
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
      v.play(familyChanged || firstBuild ? 'spawn' : 'celebrate');
    } catch (err) {
      console.warn('[preview] could not build the Pudgy model', err);
      this.pudgy = null;
    }
    this.renderOnce(0);
  }

  private frameModel(): void {
    if (!this.camera) return;
    // Pudgies are roughly 2 to 3 m tall. Clamp the measured box so a one-shot pose (or a model
    // that starts its spawn pop at scale 0) never makes the camera crop or lose the character.
    let height = 2.5;
    let width = 2;
    if (this.pudgy) {
      const box = new THREE.Box3().setFromObject(this.pudgy.root);
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3());
        height = Math.max(2.1, Math.min(3.2, size.y));
        width = Math.max(1.6, Math.min(3, Math.max(size.x, size.z)));
      }
    }
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.6, this.camera.aspect);
    const fitH = (height * 1.4) / 2 / Math.tan(fov / 2);
    const fitW = (width * 1.5) / 2 / Math.tan(fov / 2) / aspect;
    this.dist = Math.max(fitH, fitW) + width * 0.5;
    this.target.set(0, height * 0.5, 0);
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
      this.yaw += (0.32 + this.yawVel * 0.02) * dt;
    }
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

  /** Stop and free every GPU resource (the canvas element itself stays reusable). */
  unmount(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.disposePudgy();
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
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
    this.key = '';
    this.canvas.remove();
  }
}
