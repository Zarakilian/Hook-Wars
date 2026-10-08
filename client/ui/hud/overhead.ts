// Overhead name plates and health bars for every visible unit. A DOM pool positioned with
// transforms only (no layout reads), team coloured, your own plate distinct, hidden for the dead.
import { UFlag, UnitState } from '../../../shared/types.ts';
import { forget, h, setClass, setDisplay, setText, setTransform } from '../dom.ts';
import type { HudFrame } from '../types.ts';

interface Plate {
  el: HTMLElement;
  name: HTMLElement;
  fill: HTMLElement;
  trail: HTMLElement;
  id: number;
  seen: number;
  trailV: number;
  hpV: number;
  team: number;
  me: boolean;
  ally: boolean;
}

export class Overheads {
  readonly el: HTMLElement;
  private readonly byId = new Map<number, Plate>();
  private readonly free: Plate[] = [];
  private stamp = 0;

  constructor() {
    this.el = h('div', { class: 'overheads', 'aria-hidden': 'true' });
  }

  private make(): Plate {
    const name = h('span', { class: 'oh-name' });
    const trail = h('span', { class: 'oh-trail' });
    const fill = h('span', { class: 'oh-fill' });
    const el = h('div', { class: 'oh' }, name, h('span', { class: 'oh-bar' }, trail, fill, h('span', { class: 'oh-ticks' })), h('span', { class: 'oh-sos', text: 'SOS' }));
    this.el.append(el);
    return { el, name, fill, trail, id: -1, seen: 0, trailV: 1, hpV: 1, team: -1, me: false, ally: false };
  }

  reset(): void {
    for (const p of this.byId.values()) {
      setDisplay(p.el, false);
      p.id = -1;
      this.free.push(p);
    }
    this.byId.clear();
  }

  frame(f: HudFrame, dt: number): void {
    const stamp = ++this.stamp;
    const myTeam = f.youId >= 0 ? f.players.get(f.youId)?.team : undefined;
    for (const [id, sp] of f.screen) {
      const u = f.units.get(id);
      if (!u || u.st === UnitState.Dead || !sp.onScreen) continue;
      const info = f.players.get(id);
      if (!info) continue;
      let p = this.byId.get(id);
      if (!p) {
        p = this.free.pop() ?? this.make();
        p.id = id;
        p.trailV = u.mhp > 0 ? u.hp / u.mhp : 1;
        p.hpV = p.trailV;
        this.byId.set(id, p);
        setText(p.name, info.name);
        p.team = -1;
      }
      p.seen = stamp;
      const me = id === f.youId;
      const ally = myTeam !== undefined && info.team === myTeam;
      if (p.team !== info.team || p.me !== me || p.ally !== ally) {
        p.team = info.team;
        p.me = me;
        p.ally = ally;
        p.el.className = `oh t${info.team} ${me ? 'me' : ally ? 'ally' : 'enemy'}`;
        forget(p.el); // className was replaced, so drop the cached class and style values
      }
      setText(p.name, info.name);
      setDisplay(p.el, true);
      setTransform(p.el, `translate3d(${sp.x.toFixed(1)}px,${sp.y.toFixed(1)}px,0)`);
      const frac = u.mhp > 0 ? Math.max(0, Math.min(1, u.hp / u.mhp)) : 0;
      if (frac > p.trailV) p.trailV = frac;
      else p.trailV += (frac - p.trailV) * Math.min(1, dt * 3.5);
      p.hpV = frac;
      setTransform(p.fill, `scaleX(${frac.toFixed(3)})`);
      setTransform(p.trail, `scaleX(${p.trailV.toFixed(3)})`);
      setClass(p.el, 'low', frac <= 0.25);
      setClass(p.el, 'shield', (u.fl & UFlag.Shield) !== 0);
      setClass(p.el, 'burn', (u.fl & UFlag.Burning) !== 0);
      setClass(p.el, 'ghost', (u.fl & UFlag.Stealth) !== 0);
      setClass(p.el, 'prot', (u.fl & UFlag.SpawnProt) !== 0);
      setClass(p.el, 'sos', ally && !me && u.st === UnitState.Drowning);
      setClass(p.el, 'hooked', u.st === UnitState.Hooked);
    }
    for (const [id, p] of this.byId) {
      if (p.seen === stamp) continue;
      setDisplay(p.el, false);
      this.byId.delete(id);
      p.id = -1;
      this.free.push(p);
    }
  }
}
