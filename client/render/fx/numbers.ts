// Floating damage numbers: pooled sprites, each with its own small canvas that is redrawn only when
// the number spawns (or when a damage-over-time tick merges into it). Pop with overshoot, float up,
// fade late. Lilita One with a thick round outline; crits get a golden "BULLSEYE!" banner.
import * as THREE from 'three';
import type { DamageKind } from '../contracts.ts';

const FONT = '"Lilita One", "Arial Black", Impact, system-ui, sans-serif';

interface Style {
  top: string;
  mid: string;
  bottom: string;
  outline: string;
  prefix: string;
  /** relative size */
  k: number;
}

const STYLES: Record<DamageKind, Style> = {
  hook: { top: '#ffe2d6', mid: '#ff5a36', bottom: '#c8231a', outline: '#3b0806', prefix: '', k: 1 },
  melee: { top: '#fffbe8', mid: '#ffd36a', bottom: '#ef9a22', outline: '#3a2006', prefix: '', k: 0.9 },
  bash: { top: '#fff1cc', mid: '#ffae3a', bottom: '#e0661a', outline: '#3a1600', prefix: '', k: 0.95 },
  drown: { top: '#ecfaff', mid: '#6cc8ff', bottom: '#2a7fd6', outline: '#06223a', prefix: '', k: 0.85 },
  mine: { top: '#fff4cc', mid: '#ff7a2a', bottom: '#d23a10', outline: '#3a0a00', prefix: '', k: 1.1 },
  burn: { top: '#fff0a0', mid: '#ff9a2a', bottom: '#e0500e', outline: '#401202', prefix: '', k: 0.75 },
  hazard: { top: '#f4e4ff', mid: '#c084ff', bottom: '#8a3ee0', outline: '#1e0838', prefix: '', k: 0.8 },
  fountain: { top: '#ffe4f4', mid: '#ff6ac0', bottom: '#d42a86', outline: '#3a0822', prefix: '', k: 0.8 },
  shield: { top: '#fffbe0', mid: '#ffd84a', bottom: '#e0a01a', outline: '#3a2a04', prefix: '', k: 0.85 },
  heal: { top: '#e8ffe0', mid: '#6ae05a', bottom: '#2aa83a', outline: '#08300e', prefix: '+', k: 0.85 },
};

const MERGE: Partial<Record<DamageKind, true>> = { burn: true, hazard: true, fountain: true, drown: true, heal: true, shield: true };

interface Num {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  crit: boolean;
  active: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  height: number;
  aspect: number;
  kind: DamageKind;
  amount: number;
  mine: boolean;
  bump: number;
  seq: number;
}

export class DamageNumbers {
  readonly group = new THREE.Group();
  private readonly normal: Num[] = [];
  private readonly crits: Num[] = [];
  private readonly pools: Num[][] = [this.normal, this.crits];
  private seq = 0;

  constructor(count: number, critCount: number) {
    for (let i = 0; i < count; i++) this.normal.push(this.make(256, 128, false));
    for (let i = 0; i < critCount; i++) this.crits.push(this.make(512, 256, true));
    try {
      void document.fonts?.load(`64px "Lilita One"`);
    } catch {
      /* fonts API unavailable: canvas falls back to the next family */
    }
  }

  private make(w: number, h: number, crit: boolean): Num {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 2;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 1000;
    sprite.visible = false;
    sprite.frustumCulled = false;
    this.group.add(sprite);
    return { sprite, mat, tex, canvas, ctx, crit, active: false, age: 0, life: 1, x: 0, y: 0, z: 0, dx: 0, height: 1, aspect: w / h, kind: 'hook', amount: 0, mine: false, bump: 0, seq: 0 };
  }

  private draw(n: Num): void {
    const { ctx, canvas } = n;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    const st = STYLES[n.kind] ?? STYLES.hook;
    const text = st.prefix + Math.max(0, Math.round(n.amount));
    if (n.crit) {
      // banner
      this.drawText(ctx, 'BULLSEYE!', w / 2, h * 0.3, h * 0.3, w * 0.94, '#fffbe6', '#ffd23a', '#ff9200', '#3a1c00');
      this.drawText(ctx, text, w / 2, h * 0.7, h * 0.44, w * 0.9, '#fff8e0', '#ffc02a', '#ff6a00', '#3a1000');
    } else {
      let x = w / 2;
      if (n.kind === 'shield') {
        // little shield icon to the left of the number
        ctx.font = `${h * 0.66}px ${FONT}`;
        const tw = ctx.measureText(text).width;
        const sx = w / 2 - tw / 2 - h * 0.12;
        this.drawShield(ctx, sx, h * 0.5, h * 0.28);
        x += h * 0.14;
      }
      this.drawText(ctx, text, x, h * 0.54, h * 0.66, w * 0.8, st.top, st.mid, st.bottom, st.outline);
    }
    n.tex.needsUpdate = true;
  }

  private drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, maxW: number, top: string, mid: string, bottom: string, outline: string): void {
    ctx.font = `${size}px ${FONT}`;
    let tw = ctx.measureText(text).width;
    if (tw > maxW) {
      size *= maxW / tw;
      ctx.font = `${size}px ${FONT}`;
      tw = maxW;
    }
    const lw = size * 0.2;
    // drop shadow
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeText(text, x, y + size * 0.08);
    // outline
    ctx.strokeStyle = outline;
    ctx.strokeText(text, x, y);
    // gradient fill
    const g = ctx.createLinearGradient(0, y - size * 0.45, 0, y + size * 0.4);
    g.addColorStop(0, top);
    g.addColorStop(0.45, mid);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillText(text, x, y);
    // glossy highlight on the top half
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - tw, y - size, tw * 2, size * 0.62);
    ctx.clip();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawShield(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.quadraticCurveTo(cx + r * 0.9, cy - r * 0.8, cx + r * 0.85, cy - r * 0.6);
      ctx.quadraticCurveTo(cx + r * 0.8, cy + r * 0.5, cx, cy + r);
      ctx.quadraticCurveTo(cx - r * 0.8, cy + r * 0.5, cx - r * 0.85, cy - r * 0.6);
      ctx.quadraticCurveTo(cx - r * 0.9, cy - r * 0.8, cx, cy - r);
      ctx.closePath();
    };
    path();
    ctx.lineWidth = r * 0.45;
    ctx.strokeStyle = '#3a2a04';
    ctx.stroke();
    const g = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    g.addColorStop(0, '#fff6c0');
    g.addColorStop(1, '#e0a01a');
    ctx.fillStyle = g;
    path();
    ctx.fill();
  }

  spawn(x: number, y: number, z: number, amount: number, kind: DamageKind, mine: boolean, crit: boolean): void {
    if (!(amount > 0)) return;
    // damage-over-time ticks merge into a fresh number of the same kind on the same unit
    if (MERGE[kind] && !crit) {
      for (const n of this.normal) {
        if (!n.active || n.kind !== kind || n.age > 0.55) continue;
        const dx = n.x - x;
        const dz = n.z - z;
        if (dx * dx + dz * dz > 1.2) continue;
        n.amount += amount;
        n.bump = 1;
        n.age = Math.min(n.age, 0.12);
        n.life = Math.max(n.life, n.age + 0.9);
        this.draw(n);
        return;
      }
    }
    const pool = crit ? this.crits : this.normal;
    let n: Num | null = null;
    for (const c of pool) if (!c.active) {
      n = c;
      break;
    }
    if (!n) {
      // recycle the oldest
      n = pool[0];
      for (const c of pool) if (c.seq < n.seq) n = c;
    }
    n.active = true;
    n.crit = crit;
    n.kind = kind;
    n.amount = amount;
    n.mine = mine;
    n.age = 0;
    n.bump = 0;
    n.seq = ++this.seq;
    const st = STYLES[kind] ?? STYLES.hook;
    n.life = crit ? 1.55 : kind === 'burn' || kind === 'fountain' || kind === 'hazard' ? 0.95 : 1.15;
    n.x = x + (Math.random() - 0.5) * 0.7;
    n.y = y + (Math.random() - 0.5) * 0.2;
    n.z = z + (Math.random() - 0.5) * 0.35;
    // stack above young numbers on the same unit instead of overlapping them
    let stack = 0;
    for (const pool2 of this.pools)
      for (const o of pool2) {
        if (!o.active || o === n || o.age > 0.4) continue;
        const dx = o.x - x;
        const dz = o.z - z;
        if (dx * dx + dz * dz < 1.4) stack += o.crit ? 1.25 : 0.55;
      }
    n.y += Math.min(stack, 2.6);
    n.dx = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.35);
    // bigger hits read bigger
    const big = Math.min(1.35, 0.85 + amount / 600);
    n.height = crit ? 2.0 : (mine ? 1.2 : 0.9) * st.k * big;
    this.draw(n);
    n.sprite.visible = true;
    n.mat.opacity = 0;
    n.mat.rotation = 0;
  }

  update(dt: number): void {
    for (const pool of this.pools) {
      for (let i = 0; i < pool.length; i++) {
        const n = pool[i];
        if (!n.active) continue;
        n.age += dt;
        const t = n.age;
        if (t >= n.life) {
          n.active = false;
          n.sprite.visible = false;
          continue;
        }
        // pop: overshoot then settle
        let s: number;
        if (t < 0.08) {
          const u = t / 0.08;
          s = 0.3 + u * 1.05;
        } else if (t < 0.22) {
          const u = (t - 0.08) / 0.14;
          s = 1.35 - 0.35 * (u * (2 - u));
        } else s = 1;
        if (n.bump > 0) {
          s += n.bump * 0.25;
          n.bump = Math.max(0, n.bump - dt * 6);
        }
        const fadeStart = n.life * 0.62;
        const a = t < fadeStart ? 1 : 1 - (t - fadeStart) / (n.life - fadeStart);
        s *= 0.8 + 0.2 * a;
        const rise = (n.crit ? 1.9 : 1.5) * (1 - Math.exp(-t * 2.6));
        const side = n.dx * (1 - Math.exp(-t * 3));
        n.sprite.position.set(n.x + side, n.y + rise, n.z);
        const h = n.height * s;
        n.sprite.scale.set(h * n.aspect, h, 1);
        n.mat.opacity = Math.min(1, t / 0.03) * a * (n.mine || n.crit ? 1 : 0.88);
        if (n.crit) n.mat.rotation = Math.sin(t * 34) * 0.14 * Math.exp(-t * 3.5);
      }
    }
  }

  warm(x: number, y: number, z: number): void {
    const n = this.normal[0];
    if (!n) return;
    n.active = true;
    n.age = 0;
    n.life = 0.02;
    n.x = x;
    n.y = y;
    n.z = z;
    n.sprite.visible = true;
    n.mat.opacity = 0;
  }

  dispose(): void {
    for (const n of [...this.normal, ...this.crits]) {
      n.tex.dispose();
      n.mat.dispose();
    }
    this.normal.length = 0;
    this.crits.length = 0;
  }
}
