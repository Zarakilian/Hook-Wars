// Big announcement banners (queued so a DOUBLE HOOK and a REEL DEAL from one kill both show),
// tide and ice warnings, and the 3, 2, 1, HOOK! countdown splash.
import { getMap } from '../../../shared/maps/index.ts';
import type { AnnounceKey, TidePhase } from '../../../shared/types.ts';
import { h, pulse, setClass, setDisplay, setText } from '../dom.ts';
import { icon, type IconId } from '../icons.ts';
import { ANNOUNCE, RIVER_INFO, phaseInfo, tideBanner } from '../info.ts';
import type { HudFrame } from '../types.ts';

interface Banner {
  text: string;
  sub: string;
  tone: string;
  icon: IconId;
  big: boolean;
}

export class Announcer {
  readonly el: HTMLElement;
  readonly tideEl: HTMLElement;
  readonly countEl: HTMLElement;
  private readonly countNum: HTMLElement;
  private readonly countSub: HTMLElement;
  private queue: Banner[] = [];
  private busy = false;
  private timers: number[] = [];
  private tideTimer = 0;
  private lastCount = -1;
  private goUntil = 0;
  private generation = 0;

  constructor() {
    this.el = h('div', { class: 'announce', role: 'status', 'aria-live': 'assertive' });
    this.tideEl = h('div', { class: 'tide-warn hidden', role: 'status' });
    this.countNum = h('span', { class: 'cd-num' });
    this.countSub = h('span', { class: 'cd-sub' });
    this.countEl = h('div', { class: 'countdown hidden', 'aria-live': 'assertive' }, this.countNum, this.countSub);
  }

  reset(): void {
    this.generation++;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.queue = [];
    this.busy = false;
    this.el.replaceChildren();
    window.clearTimeout(this.tideTimer);
    this.tideEl.classList.add('hidden');
    this.lastCount = -1;
    this.goUntil = 0;
    this.countEl.classList.add('hidden');
  }

  private later(fn: () => void, ms: number): void {
    const gen = this.generation;
    const id = window.setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== id);
      if (gen === this.generation) fn();
    }, ms);
    this.timers.push(id);
  }

  announce(f: HudFrame, key: AnnounceKey, u: number, n: number): void {
    const a = ANNOUNCE[key];
    const name = u < 0 ? '' : u === f.youId ? 'You' : f.players.get(u)?.name ?? '';
    const big = key === 'spree8' || key === 'ultraHook' || key === 'overtime' || key === 'firstBlood';
    this.queue.push({ text: a.text, sub: u < 0 && key !== 'overtime' ? '' : a.sub(name, n), tone: a.tone, icon: a.icon, big });
    // collapse long backlogs: never more than three waiting
    if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3);
    if (!this.busy) this.next();
  }

  private next(): void {
    const b = this.queue.shift();
    if (!b) {
      this.busy = false;
      return;
    }
    this.busy = true;
    const el = h('div', { class: `ann tone-${b.tone} ${b.big ? 'big' : ''}` },
      h('div', { class: 'ann-ribbon' }, h('span', { class: 'ann-ico' }, icon(b.icon)), h('span', { class: 'ann-text', text: b.text })),
      b.sub ? h('div', { class: 'ann-sub', text: b.sub }) : null,
      h('div', { class: 'ann-burst', 'aria-hidden': 'true' }));
    this.el.replaceChildren(el);
    const hold = this.queue.length > 0 ? 1150 : 1900;
    this.later(() => el.classList.add('leave'), hold);
    this.later(() => {
      el.remove();
      this.next();
    }, hold + 260);
  }

  tide(f: HudFrame, phase: TidePhase): void {
    const b = tideBanner(phase, f.map ?? getMap(f.config.mapId));
    if (!b) return;
    const p = phaseInfo(phase, f.map);
    this.tideEl.replaceChildren(icon(p.icon, 'tw-ico'), h('span', { class: 'tw-text', text: b.text }));
    this.tideEl.className = `tide-warn tone-${b.tone}`;
    pulse(this.tideEl, 'in');
    window.clearTimeout(this.tideTimer);
    this.tideTimer = window.setTimeout(() => this.tideEl.classList.add('hidden'), 3400);
  }

  go(): void {
    this.goUntil = performance.now() + 950;
    setText(this.countNum, 'HOOK!');
    setText(this.countSub, '');
    setDisplay(this.countSub, false);
    this.countEl.classList.remove('hidden');
    setClass(this.countEl, 'is-go', true);
    pulse(this.countNum, 'pop');
  }

  frame(f: HudFrame): void {
    const now = performance.now();
    if (f.phase === 'countdown') {
      const c = Math.ceil(f.countdown);
      this.countEl.classList.remove('hidden');
      setClass(this.countEl, 'is-go', false);
      if (c !== this.lastCount) {
        this.lastCount = c;
        if (c > 3) {
          setText(this.countNum, 'GET READY');
          setClass(this.countEl, 'ready', true);
          setDisplay(this.countSub, true);
          const river = f.config.riverMode === 'tidal' && !f.map.tide ? 'deep' : f.config.riverMode;
          setText(this.countSub, `${f.map.name} · ${RIVER_INFO[river].name} · first to ${f.config.killsToWin}`);
        } else {
          setClass(this.countEl, 'ready', false);
          setDisplay(this.countSub, false);
          setText(this.countNum, String(Math.max(1, c)));
          pulse(this.countNum, 'pop');
        }
      }
      return;
    }
    this.lastCount = -1;
    if (now < this.goUntil) return;
    if (!this.countEl.classList.contains('hidden')) this.countEl.classList.add('hidden');
  }
}
