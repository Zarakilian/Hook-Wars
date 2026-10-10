// Bottom of the HUD: buffs and status tags, the HP bar (damage trail, shield, ticks), the three
// ability portholes with cooldown sweeps, four item crates and the gold purse.
// Key hints follow the device in use: the scheme's keys, or gamepad glyphs (RT, LT, A, the D-pad arms
// for items, Y for the shop) while a controller is being played with.
import { BAL, ITEMS, RUNE_BLURBS, RUNE_COLORS, RUNE_NAMES } from '../../../shared/constants.ts';
import { UFlag, UnitState, type BuffSnap, type ItemSlot } from '../../../shared/types.ts';
import { PAD_ABILITY_GLYPHS, PAD_ITEM_DPAD, PAD_SHOP_GLYPH, lastDevice, noteHookRange } from '../../game/gamepad.ts';
import type { Settings } from '../../settings.ts';
import { h, hex, noFocus, pulse, setClass, setDisplay, setText, setTransform, setVar } from '../dom.ts';
import { icon, setIcon, type IconId } from '../icons.ts';
import { ABILITY_KEYS } from '../info.ts';
import type { AppActions, HudFrame } from '../types.ts';

const AB_NAMES = ['Chain Hook', 'Grapple', 'Belly Bash'];
const AB_ICONS: IconId[] = ['hook', 'grapple', 'bash'];

const BUFF_MAX: Record<BuffSnap['t'], number> = {
  haste: BAL.hasteTime,
  double: BAL.doubleTime,
  ironskin: BAL.ironskinTime,
  ghost: BAL.ghostTime,
  bounty: 1,
  pie: BAL.pieTime,
  puffball: BAL.puffTime,
  burn: BAL.emberTime,
  spawn: BAL.spawnProt,
  bendy: BAL.powerHookTime,
  bouncy: BAL.powerHookTime,
  longshot: BAL.powerHookTime,
};
const BUFF_NAME: Record<BuffSnap['t'], string> = {
  ...RUNE_NAMES,
  pie: 'Healing Pie', puffball: 'Puffball', burn: 'Burning', spawn: 'Spawn shield',
};
const BUFF_ICON: Record<BuffSnap['t'], IconId> = {
  haste: 'haste', double: 'double', ironskin: 'ironskin', ghost: 'ghost', bounty: 'bounty',
  pie: 'pie', puffball: 'puffball', burn: 'burn', spawn: 'spawn',
  bendy: 'bendy', bouncy: 'bouncy', longshot: 'longshot',
};
const BUFF_BAD: Partial<Record<BuffSnap['t'], boolean>> = { burn: true };
/** Hook power-ups: shown bigger, with their name, because they change how you aim. */
const BUFF_POWER: Partial<Record<BuffSnap['t'], boolean>> = { bendy: true, bouncy: true, longshot: true };
const isRune = (t: BuffSnap['t']): t is keyof typeof RUNE_COLORS => t in RUNE_COLORS;
const BUFF_TITLE = (t: BuffSnap['t']): string => (isRune(t) ? `${RUNE_NAMES[t]}: ${RUNE_BLURBS[t]}` : BUFF_NAME[t]);

interface Ability {
  el: HTMLElement;
  sweep: HTMLElement;
  cd: HTMLElement;
  key: HTMLElement;
  shown: number; // displayed seconds left
  base: number; // last value received
  baseAt: number;
  ready: boolean;
}

interface ItemEl {
  el: HTMLButtonElement;
  ico: SVGSVGElement;
  charges: HTMLElement;
  key: HTMLElement;
  id: string;
}

/** Xbox face-button colours, darkened to read on the cream key pill. */
const FACE_INK: Record<string, string> = { A: '#1d7a2c', B: '#b3261e', X: '#1f5fbf', Y: '#946400' };
const SVG_NS = 'http://www.w3.org/2000/svg';

/** A small D-pad cross with one arm lit: the glyph of item i (left, up, right, down). */
function dpadGlyph(i: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'it-dpad');
  // as tall as the item number it stands in for, a little bigger so the lit arm reads
  svg.style.width = '1.25em';
  svg.style.height = '1.25em';
  svg.style.display = 'block';
  svg.style.filter = 'drop-shadow(0 0.08rem 0 #0a0503)';
  const arms: Record<(typeof PAD_ITEM_DPAD)[number], [number, number]> = { left: [0, 4], up: [4, 0], right: [8, 4], down: [4, 8] };
  const lit = PAD_ITEM_DPAD[i];
  for (const [dir, [x, y]] of Object.entries(arms)) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', String(x));
    r.setAttribute('y', String(y));
    r.setAttribute('width', '4');
    r.setAttribute('height', '4');
    r.setAttribute('rx', '0.8');
    r.setAttribute('fill', dir === lit ? '#fff3d9' : 'rgba(255, 243, 217, 0.28)');
    svg.append(r);
  }
  const c = document.createElementNS(SVG_NS, 'rect');
  c.setAttribute('x', '4');
  c.setAttribute('y', '4');
  c.setAttribute('width', '4');
  c.setAttribute('height', '4');
  c.setAttribute('fill', 'rgba(255, 243, 217, 0.28)');
  svg.append(c);
  return svg;
}

interface BuffEl {
  /** the timer ring */
  el: HTMLElement;
  /** what sits in the row: the ring, or for a hook power-up a column of its name over the ring */
  root: HTMLElement;
  secs: HTMLElement;
  seen: number;
  maxSeen: number;
}

export class BottomBar {
  readonly el: HTMLElement;
  private readonly abilities: Ability[] = [];
  private readonly items: ItemEl[] = [];
  private readonly buffsEl: HTMLElement;
  private readonly buffs = new Map<string, BuffEl>();
  private readonly tags: Record<string, HTMLElement> = {};
  private readonly hpFill: HTMLElement;
  private readonly hpTrail: HTMLElement;
  private readonly hpShield: HTMLElement;
  private readonly hpBar: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly gold: HTMLElement;
  private readonly goldWrap: HTMLElement;
  private readonly goldFloat: HTMLElement;
  private readonly shopKey: HTMLElement;
  private readonly spec: HTMLElement;
  private readonly main: HTMLElement;
  private trail = 1;
  private trailHold = 0;
  private hpFrac = 1;
  private goldShown = -1;
  private goldTarget = 0;
  private goldPrev = -1;
  private frameNo = 0;
  private lastT = 0;
  private scheme = '';
  /** the item and shop hints currently show gamepad glyphs */
  private padGlyphs = false;
  private mhpShown = -1;
  private readonly actions: AppActions;
  private readonly openShop: () => void;
  private readonly shopOpen: () => boolean;

  constructor(actions: AppActions, openShop: () => void, shopOpen: () => boolean) {
    this.actions = actions;
    this.openShop = openShop;
    this.shopOpen = shopOpen;
    // abilities
    const abRow = h('div', { class: 'abilities' });
    for (let i = 0; i < 3; i++) {
      const sweep = h('span', { class: 'ab-sweep' });
      const cd = h('span', { class: 'ab-cd' });
      const key = h('span', { class: 'ab-key' });
      const el = h('div', { class: `ab ab-${i}`, title: AB_NAMES[i] },
        h('span', { class: 'ab-ring' }, h('span', { class: 'ab-face' }, icon(AB_ICONS[i])), sweep, cd, h('span', { class: 'ab-glint' })),
        key,
        h('span', { class: 'ab-name', text: AB_NAMES[i] }));
      abRow.append(el);
      this.abilities.push({ el, sweep, cd, key, shown: 0, base: 0, baseAt: 0, ready: true });
    }
    // items
    const itemRow = h('div', { class: 'items' });
    for (let i = 0; i < 4; i++) {
      const ico = icon('pie', 'it-ico');
      const charges = h('span', { class: 'it-charges' });
      const key = h('span', { class: 'it-key', text: String(i + 1) });
      const el = noFocus(h('button', { class: 'item-slot empty', type: 'button', tabindex: -1 }, ico, charges, key)) as HTMLButtonElement;
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // selling only while the shop is open, so a classic-controls right-click move never sells
        if (this.shopOpen() && !el.classList.contains('empty')) {
          this.actions.uiSound('click');
          this.actions.sell(i);
          pulse(el, 'sold');
        }
      });
      el.addEventListener('click', () => {
        el.blur();
        this.openShop();
      });
      itemRow.append(el);
      this.items.push({ el, ico, charges, key, id: '' });
    }
    // gold
    this.gold = h('span', { class: 'gold-num', text: '0' });
    this.goldFloat = h('span', { class: 'gold-float' });
    this.shopKey = h('kbd', { class: 'keycap', text: 'B' });
    this.goldWrap = noFocus(h('button', { class: 'gold', type: 'button', tabindex: -1, title: 'Gold. Press B for the shop.' }, icon('coin', 'gold-ico'), this.gold, h('span', { class: 'gold-shop' }, this.shopKey, h('span', { text: 'Shop' })), this.goldFloat));
    this.goldWrap.addEventListener('click', () => {
      this.goldWrap.blur();
      this.openShop();
    });

    // hp
    this.hpTrail = h('span', { class: 'hp-trail' });
    this.hpFill = h('span', { class: 'hp-fill' });
    this.hpShield = h('span', { class: 'hp-shield' });
    this.hpText = h('span', { class: 'hp-text' });
    this.hpBar = h('div', { class: 'hp-bar' }, this.hpTrail, this.hpFill, this.hpShield, h('span', { class: 'hp-ticks' }), h('span', { class: 'hp-shine' }));
    const hp = h('div', { class: 'hp-wrap' }, this.hpBar, this.hpText);

    this.buffsEl = h('div', { class: 'buffs' });
    for (const [k, label] of [['ice', 'Slippery ice'], ['wade', 'Wading: slow'], ['hazard', 'In a hazard!'], ['heal', 'Healing'], ['stealth', 'Hidden']] as const) {
      const t = h('span', { class: `status-tag st-${k}`, text: label });
      t.style.display = 'none';
      this.tags[k] = t;
      this.buffsEl.append(t);
    }

    this.main = h('div', { class: 'hb-main' }, hp, h('div', { class: 'hb-row' }, abRow, h('span', { class: 'hb-sep' }), itemRow, goldSep(), this.goldWrap));
    this.spec = h('div', { class: 'spec-tag' }, icon('eye'), h('span', { text: 'Spectating' }));
    this.el = h('div', { class: 'hud-bottom' }, this.buffsEl, this.main, this.spec);
  }

  reset(): void {
    this.trail = 1;
    this.hpFrac = 1;
    this.goldShown = -1;
    this.goldPrev = -1;
    this.mhpShown = -1;
    this.scheme = '';
    for (const a of this.abilities) {
      a.shown = 0;
      a.base = 0;
      a.ready = true;
      a.el.classList.remove('flash');
    }
    for (const it of this.items) it.id = '#';
    for (const b of this.buffs.values()) b.root.remove();
    this.buffs.clear();
  }

  frame(f: HudFrame, settings: Settings): void {
    const now = performance.now();
    const dt = this.lastT ? Math.min(0.1, (now - this.lastT) / 1000) : 0;
    this.lastT = now;
    this.frameNo++;
    const you = f.you;
    const me = f.me;
    const active = !!(you && me);
    setDisplay(this.main, active);
    setDisplay(this.buffsEl, active);
    setDisplay(this.spec, !active);
    if (!you || !me) return;

    const dead = me.st === UnitState.Dead;
    const busy = me.st === UnitState.Hooked || me.st === UnitState.Knocked;

    // the aim stick's full push reaches the current hook range (input.ts reads it)
    noteHookRange(you.hookRange);

    // key labels follow the chosen scheme, or show gamepad glyphs while a controller is in use
    const mode = lastDevice() === 'pad' ? 'pad' : settings.controls;
    if (mode !== this.scheme) {
      this.scheme = mode;
      this.paintKeys(mode === 'pad', settings);
    }

    // abilities: extrapolate between snapshots so the sweep is smooth at any frame rate
    for (let i = 0; i < 3; i++) {
      const a = this.abilities[i];
      const v = you.cd[i];
      if (v !== a.base) {
        a.base = v;
        a.baseAt = now;
      }
      const left = Math.max(0, a.base - (now - a.baseAt) / 1000);
      const max = Math.max(0.1, you.cdMax[i] || 1);
      const ready = left <= 0.02;
      setVar(a.sweep, '--p', ready ? '0' : Math.min(1, left / max).toFixed(3));
      setText(a.cd, ready ? '' : left >= 1 ? String(Math.ceil(left)) : left.toFixed(1));
      setClass(a.el, 'cooling', !ready);
      setClass(a.el, 'off', dead || busy);
      if (ready && !a.ready && !dead) pulse(a.el, 'flash');
      a.ready = ready;
    }
    // grapple works while drowning: make that obvious
    setClass(this.abilities[1].el, 'urge', you.drown > 0 && this.abilities[1].ready);

    // hp bar with a lagging damage trail
    const frac = me.mhp > 0 ? Math.max(0, Math.min(1, me.hp / me.mhp)) : 0;
    if (frac > this.trail) this.trail = frac;
    if (frac < this.hpFrac - 0.001) this.trailHold = 0.45;
    this.hpFrac = frac;
    if (this.trailHold > 0) this.trailHold -= dt;
    else this.trail += (frac - this.trail) * Math.min(1, dt * 5);
    setTransform(this.hpFill, `scaleX(${frac.toFixed(4)})`);
    setTransform(this.hpTrail, `scaleX(${this.trail.toFixed(4)})`);
    const shielded = (me.fl & UFlag.Shield) !== 0;
    setDisplay(this.hpShield, shielded);
    if (shielded) {
      const sw = Math.min(1, BAL.ironskinShield / Math.max(1, me.mhp));
      const x = Math.min(frac, 1 - sw);
      setTransform(this.hpShield, `translateX(${(x * 100).toFixed(2)}%) scaleX(${sw.toFixed(3)})`);
    }
    setClass(this.hpBar, 'mid', frac <= 0.5 && frac > 0.25);
    setClass(this.hpBar, 'low', frac <= 0.25 && !dead);
    setClass(this.hpBar, 'dead', dead);
    setText(this.hpText, dead ? 'Down!' : `${Math.ceil(me.hp)} / ${me.mhp}`);
    if (me.mhp !== this.mhpShown) {
      this.mhpShown = me.mhp;
      setVar(this.hpBar, '--tick', `${((100 / Math.max(100, me.mhp)) * 100).toFixed(3)}%`);
    }

    // items
    for (let i = 0; i < 4; i++) this.paintItem(this.items[i], you.items[i] ?? null);

    // gold: count up quickly, float a "+N" for chunky gains
    this.goldTarget = you.gold;
    if (this.goldPrev >= 0 && you.gold - this.goldPrev >= 15) {
      this.goldFloat.textContent = `+${you.gold - this.goldPrev}`;
      pulse(this.goldFloat, 'go');
      pulse(this.goldWrap, 'bump');
    }
    this.goldPrev = you.gold;
    if (this.goldShown < 0) this.goldShown = you.gold;
    else if (this.goldShown !== this.goldTarget) {
      const d = this.goldTarget - this.goldShown;
      const step = Math.sign(d) * Math.max(1, Math.round(Math.abs(d) * Math.min(1, dt * 10)));
      this.goldShown = Math.abs(step) >= Math.abs(d) ? this.goldTarget : this.goldShown + step;
    }
    setText(this.gold, String(this.goldShown));

    // buffs (pooled by type) and status tags
    if (this.frameNo % 3 === 0) this.paintBuffs(you.buffs);
    setDisplay(this.tags.ice, !dead && (me.fl & UFlag.OnIce) !== 0);
    setDisplay(this.tags.wade, !dead && (me.fl & UFlag.Shallow) !== 0);
    setDisplay(this.tags.hazard, !dead && (me.fl & UFlag.InHazard) !== 0);
    setDisplay(this.tags.heal, !dead && (me.fl & UFlag.Healing) !== 0);
    setDisplay(this.tags.stealth, !dead && (me.fl & UFlag.Stealth) !== 0);
  }

  private paintKeys(pad: boolean, settings: Settings): void {
    const keys = pad ? PAD_ABILITY_GLYPHS : ABILITY_KEYS[settings.controls];
    this.abilities.forEach((a, i) => {
      setText(a.key, keys[i]);
      inkKey(a.key, pad ? FACE_INK[keys[i]] : undefined);
    });
    // the item and shop hints only change once a pad was used (the keyboard look stays untouched)
    if (pad === this.padGlyphs) return;
    this.padGlyphs = pad;
    this.items.forEach((it, i) => {
      if (pad) it.key.replaceChildren(dpadGlyph(i));
      else it.key.textContent = String(i + 1);
    });
    this.shopKey.textContent = pad ? PAD_SHOP_GLYPH : 'B';
    inkKey(this.shopKey, pad ? FACE_INK[PAD_SHOP_GLYPH] : undefined);
    this.goldWrap.title = pad ? `Gold. Press ${PAD_SHOP_GLYPH} for the shop.` : 'Gold. Press B for the shop.';
  }

  private paintItem(it: ItemEl, slot: ItemSlot | null): void {
    const key = slot ? `${slot.id}:${slot.charges}` : '';
    if (key === it.id) return;
    const prevId = it.id.split(':')[0];
    it.id = key;
    if (!slot) {
      it.el.classList.add('empty');
      it.el.title = 'Empty slot. Buy items in the shop (B).';
      it.charges.textContent = '';
      return;
    }
    const def = ITEMS[slot.id];
    it.el.classList.remove('empty');
    setIcon(it.ico, slot.id);
    it.charges.textContent = def.consumable ? String(slot.charges) : '';
    const refund = def.consumable ? Math.floor((def.cost / 2) * (slot.charges / Math.max(1, def.charges))) : Math.floor(def.cost / 2);
    it.el.title = `${def.name}: ${def.blurb}${def.consumable ? ' Press the number key to use.' : ''} With the shop open, right-click to sell for ${refund} gold.`;
    if (prevId !== slot.id) pulse(it.el, 'got');
  }

  private paintBuffs(list: BuffSnap[]): void {
    const stamp = this.frameNo;
    for (const b of list) {
      if (b.left <= 0.05 && b.t === 'bounty') continue;
      let el = this.buffs.get(b.t);
      if (!el) {
        const secs = h('span', { class: 'bf-secs' });
        const node = h('span', { class: `buff ${BUFF_BAD[b.t] ? 'bad' : ''} ${BUFF_POWER[b.t] ? 'power' : ''}`.trim(), title: BUFF_TITLE(b.t) }, icon(BUFF_ICON[b.t]), secs);
        if (isRune(b.t)) node.style.setProperty('--bc', hex(RUNE_COLORS[b.t].main));
        // a hook power-up's name sits in the row's flow above its ring, so the column is as wide as
        // the name and two or three named power-ups never overlap (the gap does the spacing)
        let root = node;
        if (BUFF_POWER[b.t]) {
          root = h('span', { class: 'buff-col' }, h('span', { class: 'bf-name', text: RUNE_NAMES[b.t as keyof typeof RUNE_NAMES] }), node);
          if (isRune(b.t)) root.style.setProperty('--bc', hex(RUNE_COLORS[b.t].main));
        }
        el = { el: node, root, secs, seen: stamp, maxSeen: b.left };
        this.buffs.set(b.t, el);
        this.buffsEl.prepend(root);
      }
      el.seen = stamp;
      el.maxSeen = Math.max(el.maxSeen, b.left);
      const max = Math.max(BUFF_MAX[b.t], el.maxSeen);
      setVar(el.el, '--p', Math.max(0, Math.min(1, b.left / max)).toFixed(3));
      setText(el.secs, String(Math.max(0, Math.ceil(b.left))));
      setClass(el.el, 'ending', b.left < 2);
      // a named power-up's label sits outside the ring, so the column blinks with it too
      if (el.root !== el.el) setClass(el.root, 'ending', b.left < 2);
    }
    for (const [k, el] of this.buffs) {
      if (el.seen === stamp) continue;
      el.root.remove();
      this.buffs.delete(k);
    }
  }
}

/** Colour a key hint like its pad button, or drop the inline style (the keyboard look is the stylesheet's). */
function inkKey(el: HTMLElement, ink: string | undefined): void {
  if (ink) el.style.color = ink;
  else if (el.hasAttribute('style')) el.removeAttribute('style');
}

function goldSep(): HTMLElement {
  return h('span', { class: 'hb-sep' });
}
