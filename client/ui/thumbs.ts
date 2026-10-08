// Item thumbnails for the Locker, Store and Market: the item worn on its family's bare base, framed
// on its slot, rendered by one small offscreen WebGLRenderer and cached as data URLs for the page.
// Progressive: every card shows an SVG slot glyph first; the render replaces it when ready. If the
// character model does not change for an item (not modelled yet), the glyph stays, so a thumbnail
// never shows the wrong thing. Work is time-sliced (one item per frame) and only runs while a
// screen holds the renderer.
import * as THREE from 'three';
import { cosmeticById, type CosmeticSlot, type Loadout } from '../../shared/cosmetics.ts';
import { UnitState, type FamilyId } from '../../shared/types.ts';
import type { PudgyView } from '../render/contracts.ts';
import { createPudgy } from '../render/models/pudgy.ts';

const SIZE = 192;

/** Framing per slot: centre height and region size as fractions of the model height. */
const FRAME: Record<CosmeticSlot, { y: number; s: number; yaw: number }> = {
  head: { y: 0.84, s: 0.46, yaw: 0.45 },
  face: { y: 0.76, s: 0.36, yaw: 0.3 },
  body: { y: 0.5, s: 0.7, yaw: 0.45 },
  hands: { y: 0.5, s: 0.62, yaw: -0.6 },
  feet: { y: 0.14, s: 0.42, yaw: 0.55 },
  back: { y: 0.6, s: 0.7, yaw: Math.PI - 0.5 },
};

type Cb = (url: string | null) => void;

export class ItemThumbs {
  private readonly cache = new Map<string, string | null>();
  private readonly waiting = new Map<string, Cb[]>();
  private readonly order: string[] = [];
  private readonly baseSig = new Map<FamilyId, string>();
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private holders = 0;
  private raf = 0;
  private failed = false;
  private disposeTimer = 0;

  /** Cached thumbnail: a data URL, null (use the glyph) or undefined (not rendered yet). */
  peek(itemId: string): string | null | undefined {
    return this.cache.get(itemId);
  }

  /** Ask for a thumbnail. cb runs once, now if cached, else when rendered (null = keep the glyph). */
  request(itemId: string, cb: Cb): void {
    const hit = this.cache.get(itemId);
    if (hit !== undefined) {
      cb(hit);
      return;
    }
    const list = this.waiting.get(itemId);
    if (list) list.push(cb);
    else {
      this.waiting.set(itemId, [cb]);
      this.order.push(itemId);
    }
    this.kick();
  }

  /** A screen that shows thumbnails holds the renderer while it is open. */
  hold(): () => void {
    this.holders++;
    window.clearTimeout(this.disposeTimer);
    this.kick();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.holders = Math.max(0, this.holders - 1);
      if (this.holders === 0) {
        // keep the context briefly so hopping between Locker and Store does not rebuild it
        this.disposeTimer = window.setTimeout(() => this.disposeGl(), 4000);
      }
    };
  }

  private kick(): void {
    if (this.raf || this.holders === 0 || this.order.length === 0) return;
    this.raf = requestAnimationFrame(() => this.pump());
  }

  private pump(): void {
    this.raf = 0;
    if (this.holders === 0) return;
    const t0 = performance.now();
    // at most a couple per frame, inside an 10 ms budget, so the menu stays smooth
    while (this.order.length && performance.now() - t0 < 10) {
      const id = this.order.shift()!;
      const url = this.failed ? null : this.renderItem(id);
      this.cache.set(id, url);
      const cbs = this.waiting.get(id) ?? [];
      this.waiting.delete(id);
      for (const cb of cbs) cb(url);
    }
    this.kick();
  }

  private ensureGl(): boolean {
    if (this.renderer) return true;
    if (this.failed) return false;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
      r.setPixelRatio(1);
      r.setSize(SIZE, SIZE, false);
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.toneMapping = THREE.AgXToneMapping;
      r.toneMappingExposure = 1.2;
      r.setClearColor(0x000000, 0);
      this.renderer = r;
    } catch {
      this.failed = true;
      return false;
    }
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff0d8, 0x2a3a48, 1.4));
    const key = new THREE.DirectionalLight(0xffe2b8, 2.8);
    key.position.set(2.5, 4, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fd0ff, 2.4);
    rim.position.set(-3, 2.5, -3);
    scene.add(rim);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
    return true;
  }

  private disposeGl(): void {
    if (this.holders > 0) return;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }

  private build(family: FamilyId, loadout: Loadout): PudgyView {
    const v = createPudgy({ family, loadout, team: 0, name: 'thumb', isLocal: false, quality: 'high', detail: 'showcase' });
    v.update(1 / 60, { state: UnitState.Alive, speed: 0, hpFrac: 1, flags: 0, hookOut: false, stateTime: 0.5, time: 0.5 });
    v.root.updateMatrixWorld(true);
    return v;
  }

  /** Geometry fingerprint: vertex count plus the rounded bounding box. */
  private signature(root: THREE.Object3D): string {
    let verts = 0;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && m.geometry) verts += m.geometry.getAttribute('position')?.count ?? 0;
    });
    const b = new THREE.Box3().setFromObject(root);
    const sz = b.getSize(new THREE.Vector3());
    return `${verts}|${sz.x.toFixed(2)}|${sz.y.toFixed(2)}|${sz.z.toFixed(2)}`;
  }

  private renderItem(id: string): string | null {
    const def = cosmeticById(id);
    if (!def || !this.ensureGl() || !this.renderer || !this.scene || !this.camera) return null;
    let view: PudgyView | null = null;
    try {
      // the bare base of this family, once, to detect items the model does not draw yet
      let base = this.baseSig.get(def.family);
      if (base === undefined) {
        const b = this.build(def.family, {});
        base = this.signature(b.root);
        b.dispose();
        this.baseSig.set(def.family, base);
      }
      view = this.build(def.family, { [def.slot]: id });
      if (this.signature(view.root) === base) return null;
      const f = FRAME[def.slot];
      view.root.rotation.y = f.yaw;
      view.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(view.root);
      const size = box.getSize(new THREE.Vector3());
      const H = Math.max(1.2, size.y);
      const centre = new THREE.Vector3(0, box.min.y + H * f.y, 0);
      if (def.slot === 'hands') {
        const hand = view.getHandWorld(new THREE.Vector3());
        centre.set(hand.x * 0.6, hand.y, hand.z * 0.6);
      }
      const region = H * f.s;
      const cam = this.camera;
      const dist = (region / 2) / Math.tan((cam.fov * Math.PI) / 360) * 1.12;
      cam.position.set(centre.x, centre.y + dist * 0.28, centre.z + dist);
      cam.lookAt(centre);
      cam.updateMatrixWorld();
      this.scene.add(view.root);
      this.renderer.render(this.scene, cam);
      this.scene.remove(view.root);
      return this.renderer.domElement.toDataURL('image/png');
    } catch (err) {
      console.warn('[thumbs] item render failed', id, err);
      return null;
    } finally {
      try {
        view?.dispose();
      } catch {
        // ignore
      }
    }
  }
}
