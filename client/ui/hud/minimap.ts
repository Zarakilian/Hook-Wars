// Minimap: a cached nautical-chart layer per water state (deep, shallow, dry, frozen) plus a
// dynamic layer at ~30 Hz with units, you, runes, hook lines and the camera footprint.
import { RUNE_COLORS } from '../../../shared/constants.ts';
import type { MapDef } from '../../../shared/maps/types.ts';
import type { HookSnap, RiverState, RuneType } from '../../../shared/types.ts';
import { UnitState } from '../../../shared/types.ts';
import { TEAM_COLORS } from '../../render/contracts.ts';
import { drawChart, type WaterClass } from '../chart.ts';
import { h, hex, setText } from '../dom.ts';
import { icon } from '../icons.ts';
import type { HudFrame } from '../types.ts';

/** Minimap rune fills, from the shared rune palette (models, effects and HUD use the same). */
const RUNE_FILL = Object.fromEntries((Object.keys(RUNE_COLORS) as RuneType[]).map((t) => [t, hex(RUNE_COLORS[t].main)])) as Record<RuneType, string>;
/** Hook power-ups get a round marker with a ring, the classic runes a diamond. */
const POWER_UP: Partial<Record<RuneType, true>> = { bendy: true, bouncy: true, longshot: true };

interface TrackedRune {
  i: number;
  t: RuneType;
  x: number;
  z: number;
}

export function waterClass(r: RiverState): WaterClass {
  if (r.frozen) return 'ice';
  if (r.deep) return 'deep';
  if (r.shallow) return 'shallow';
  return r.level > 0.35 ? 'shallow' : 'dry';
}

export class Minimap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly label: HTMLElement;
  private readonly cache = new Map<WaterClass, HTMLCanvasElement>();
  private map: MapDef | null = null;
  private hazardsKey = '';
  private W = 0;
  private H = 0;
  private dpr = 1;
  private frameNo = 0;
  private readonly tracked = new Map<number, TrackedRune>();
  private resizeObs: ResizeObserver;
  private dirtySize = true;

  constructor() {
    this.canvas = h('canvas', { class: 'mm-canvas' });
    this.ctx = this.canvas.getContext('2d');
    this.label = h('span', { class: 'mm-label' });
    this.el = h('div', { class: 'minimap' },
      h('div', { class: 'mm-frame' }, this.canvas, h('span', { class: 'mm-compass', 'aria-hidden': 'true' }, h('span', { text: 'N' }))),
      h('div', { class: 'mm-foot' }, icon('flag', 'mm-ico'), this.label));
    this.resizeObs = new ResizeObserver(() => (this.dirtySize = true));
    this.resizeObs.observe(this.canvas);
  }

  reset(): void {
    this.tracked.clear();
    this.cache.clear();
    this.map = null;
    this.dirtySize = true;
  }

  // ---------------------------------------------------------------- rune tracking from events
  runeSpawn(i: number, t: RuneType, x: number, z: number): void {
    this.tracked.set(i, { i, t, x, z });
  }

  runeGone(i: number): void {
    this.tracked.delete(i);
  }

  private ensureSize(): void {
    if (!this.dirtySize) return;
    this.dirtySize = false;
    const cssW = this.canvas.clientWidth || 240;
    const cssH = this.canvas.clientHeight || 160;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cssW * this.dpr);
    const H = Math.round(cssH * this.dpr);
    if (W !== this.W || H !== this.H) {
      this.W = W;
      this.H = H;
      this.canvas.width = W;
      this.canvas.height = H;
      this.cache.clear();
    }
  }

  private layer(map: MapDef, wc: WaterClass, f: HudFrame): HTMLCanvasElement | null {
    const hk = `${map.id}:${f.hazards.length}`;
    if (this.map !== map || hk !== this.hazardsKey) {
      this.map = map;
      this.hazardsKey = hk;
      this.cache.clear();
      this.warm(map, f);
    }
    return this.build(map, wc, f);
  }

  private build(map: MapDef, wc: WaterClass, f: Pick<HudFrame, 'hazards'>): HTMLCanvasElement | null {
    let c = this.cache.get(wc);
    if (!c) {
      c = document.createElement('canvas');
      c.width = this.W;
      c.height = this.H;
      const cx = c.getContext('2d');
      if (!cx) return null;
      drawChart(cx, map, this.W, this.H, wc, { hazards: f.hazards, detail: true });
      this.cache.set(wc, c);
    }
    return c;
  }

  /** Pre-draw the other water states in idle time so a tide change never costs a frame. */
  private warm(map: MapDef, f: HudFrame): void {
    const hazards = f.hazards;
    const classes: WaterClass[] = map.tide ? ['deep', 'shallow', 'dry', 'ice'] : ['deep', 'dry'];
    const idle = (fn: () => void) => {
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(fn, { timeout: 1500 });
      else window.setTimeout(fn, 200);
    };
    const step = (i: number) => {
      if (i >= classes.length || this.map !== map) return;
      idle(() => {
        if (this.map !== map || this.W === 0) return;
        this.build(map, classes[i], { hazards });
        step(i + 1);
      });
    };
    step(0);
  }

  frame(f: HudFrame, t: number): void {
    this.frameNo++;
    // 30 Hz is plenty for a minimap
    if (this.frameNo % 2 !== 0) return;
    const ctx = this.ctx;
    if (!ctx) return;
    this.ensureSize();
    if (this.W === 0 || this.H === 0) return;
    const map = f.map;
    setText(this.label, map.name);
    const wc = waterClass(f.river);
    const bg = this.layer(map, wc, f);
    const W = this.W;
    const H = this.H;
    const k = W / map.w;
    const sx = (x: number) => ((x + map.w / 2) / map.w) * W;
    const sz = (z: number) => ((z + map.d / 2) / map.d) * H;
    if (bg) ctx.drawImage(bg, 0, 0);
    else ctx.clearRect(0, 0, W, H);

    // camera footprint
    if (f.view.length === 4) {
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const [x, z] = f.view[i];
        if (i === 0) ctx.moveTo(sx(x), sz(z));
        else ctx.lineTo(sx(x), sz(z));
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,248,220,0.75)';
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.stroke();
    }

    // runes: the live list if the glue passes it, else the event-tracked list
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    if (f.runes) for (const r of f.runes) this.drawRune(ctx, sx(r.x), sz(r.z), r.t, pulse);
    else for (const r of this.tracked.values()) this.drawRune(ctx, sx(r.x), sz(r.z), r.t, pulse);

    // hook lines
    const hooks: readonly HookSnap[] | undefined = f.hooks;
    if (hooks) {
      ctx.lineCap = 'round';
      for (const hk of hooks) {
        const owner = f.units.get(hk.o);
        const team = f.players.get(hk.o)?.team ?? 0;
        ctx.beginPath();
        if (owner) ctx.moveTo(sx(owner.x), sz(owner.z));
        else ctx.moveTo(sx(hk.x), sz(hk.z));
        for (let i = 0; i + 1 < hk.pts.length; i += 2) ctx.lineTo(sx(hk.pts[i]), sz(hk.pts[i + 1]));
        ctx.lineTo(sx(hk.x), sz(hk.z));
        ctx.strokeStyle = 'rgba(20,10,4,0.7)';
        ctx.lineWidth = 3.2 * this.dpr;
        ctx.stroke();
        ctx.strokeStyle = hk.k === 1 ? '#e8d6a8' : hex(TEAM_COLORS[team].light);
        ctx.lineWidth = 1.6 * this.dpr;
        if (hk.k === 1) ctx.setLineDash([3 * this.dpr, 2 * this.dpr]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(sx(hk.x), sz(hk.z), 2.2 * this.dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#f2f6f8';
        ctx.fill();
      }
    }

    // units (you last, on top)
    const r = Math.max(2.6, k * 0.85) * (this.dpr >= 1.5 ? 1 : 1.15);
    let meX = 0;
    let meZ = 0;
    let meF = 0;
    let haveMe = false;
    for (const [id, u] of f.units) {
      if (u.st === UnitState.Dead) continue;
      if (id === f.youId) {
        meX = u.x;
        meZ = u.z;
        meF = u.f;
        haveMe = true;
        continue;
      }
      const team = f.players.get(id)?.team ?? 0;
      const x = sx(u.x);
      const y = sz(u.z);
      ctx.beginPath();
      ctx.arc(x, y, r + this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#1a0e05';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = hex(TEAM_COLORS[team].main);
      ctx.fill();
      if (u.st === UnitState.Drowning) {
        ctx.strokeStyle = `rgba(160,230,255,${0.4 + pulse * 0.6})`;
        ctx.lineWidth = 1.5 * this.dpr;
        ctx.beginPath();
        ctx.arc(x, y, r + 3 * this.dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (haveMe) {
      // prefer the predicted focus point so your dot never lags your feet
      const px = sx(meX);
      const py = sz(meZ);
      const team = f.players.get(f.youId)?.team ?? 0;
      const rr = r * 1.45;
      ctx.beginPath();
      ctx.arc(px, py, rr + (3 + pulse * 3) * this.dpr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,232,140,${0.75 - pulse * 0.55})`;
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.stroke();
      // facing wedge
      const fx = Math.sin(meF);
      const fz = Math.cos(meF);
      ctx.beginPath();
      ctx.moveTo(px + fx * rr * 2.3, py + fz * rr * 2.3);
      ctx.lineTo(px + fz * rr * 0.9, py - fx * rr * 0.9);
      ctx.lineTo(px - fz * rr * 0.9, py + fx * rr * 0.9);
      ctx.closePath();
      ctx.fillStyle = '#fff2b0';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, rr + this.dpr * 1.2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.fillStyle = hex(TEAM_COLORS[team].main);
      ctx.fill();
    }
  }

  private drawRune(ctx: CanvasRenderingContext2D, x: number, y: number, t: RuneType, pulse: number): void {
    const s = (3.2 + pulse * 1.2) * this.dpr;
    ctx.beginPath();
    ctx.arc(x, y, s * 2.1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,240,180,0.22)';
    ctx.fill();
    ctx.beginPath();
    if (POWER_UP[t]) {
      ctx.arc(x, y, s * 0.9, 0, Math.PI * 2);
    } else {
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
    }
    ctx.fillStyle = RUNE_FILL[t];
    ctx.fill();
    ctx.strokeStyle = '#2a190d';
    ctx.lineWidth = this.dpr;
    ctx.stroke();
    if (POWER_UP[t]) {
      ctx.beginPath();
      ctx.arc(x, y, s * 1.45, 0, Math.PI * 2);
      ctx.strokeStyle = RUNE_FILL[t];
      ctx.lineWidth = 1.2 * this.dpr;
      ctx.stroke();
    }
  }

  dispose(): void {
    this.resizeObs.disconnect();
  }
}
