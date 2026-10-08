// Reusable menu widgets: chunky buttons, segmented pickers, arrow pickers, switches, sliders.
// Every widget is built once and updated in place with set(), so focus and hover survive re-renders.
import { h } from './dom.ts';
import { icon, type IconId } from './icons.ts';
import type { AppActions } from './types.ts';

let sound: AppActions['uiSound'] | null = null;
let lastHover = 0;

/** Wire UI sounds once (called by createUI). */
export function setUiSound(fn: AppActions['uiSound']): void {
  sound = fn;
}

export function clickSound(): void {
  sound?.('click');
}

function hoverSound(): void {
  const now = performance.now();
  if (now - lastHover < 70) return;
  lastHover = now;
  sound?.('hover');
}

export interface ButtonOpts {
  cls?: string;
  icon?: IconId;
  title?: string;
  disabled?: boolean;
  /** play the click sound (default true) */
  sound?: boolean;
  type?: 'button' | 'submit';
}

export function button(label: string, onClick: (e: MouseEvent) => void, o: ButtonOpts = {}): HTMLButtonElement {
  const b = h('button', { class: `btn ${o.cls ?? ''}`.trim(), type: o.type ?? 'button', title: o.title, disabled: o.disabled });
  if (o.icon) b.append(icon(o.icon, 'btn-ico'));
  if (label) b.append(h('span', { class: 'btn-label', text: label }));
  b.addEventListener('click', (e) => {
    if (b.disabled) return;
    if (o.sound !== false) clickSound();
    onClick(e);
  });
  b.addEventListener('pointerenter', () => {
    if (!b.disabled) hoverSound();
  });
  return b;
}

export function setButtonLabel(b: HTMLButtonElement, label: string): void {
  const l = b.querySelector('.btn-label');
  if (l && l.textContent !== label) l.textContent = label;
}

export function iconButton(id: IconId, title: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = button('', onClick, { cls: `icon-btn ${cls}`, icon: id, title });
  b.setAttribute('aria-label', title);
  return b;
}

export function sectionTitle(text: string, ico?: IconId, extra?: Node | null): HTMLElement {
  return h('div', { class: 'section-title' }, ico ? icon(ico, 'st-ico') : null, h('span', { text }), extra ?? null);
}

export function rope(): HTMLElement {
  return h('div', { class: 'rope', 'aria-hidden': 'true' });
}

// ---------------------------------------------------------------------------------------------
// Segmented picker (radio group of chunky tiles)
// ---------------------------------------------------------------------------------------------

export interface SegOption<T> {
  value: T;
  label: string;
  icon?: IconId;
  sub?: string;
  title?: string;
  disabled?: boolean;
  /** extra class on the option, e.g. team colours */
  cls?: string;
}

export interface Segmented<T> {
  el: HTMLElement;
  set(value: T, disabled?: boolean): void;
  setDisabled(value: T, disabled: boolean, title?: string): void;
  setSub(value: T, sub: string): void;
}

export function segmented<T extends string | number>(o: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  cls?: string;
}): Segmented<T> {
  const el = h('div', { class: `seg ${o.cls ?? ''}`.trim(), role: 'radiogroup', 'aria-label': o.label });
  let value = o.value;
  let allOff = false;
  const btns = new Map<T, HTMLButtonElement>();
  const subs = new Map<T, HTMLElement>();
  const optDisabled = new Map<T, boolean>();
  for (const opt of o.options) {
    const b = h('button', { class: `seg-opt ${opt.cls ?? ''}`.trim(), type: 'button', role: 'radio', title: opt.title });
    if (opt.icon) b.append(icon(opt.icon, 'seg-ico'));
    const text = h('span', { class: 'seg-text' }, h('span', { class: 'seg-label', text: opt.label }));
    if (opt.sub !== undefined) {
      const sub = h('span', { class: 'seg-sub', text: opt.sub });
      subs.set(opt.value, sub);
      text.append(sub);
    }
    b.append(text);
    b.addEventListener('click', () => {
      if (b.disabled || opt.value === value) return;
      clickSound();
      value = opt.value;
      paint();
      o.onChange(opt.value);
    });
    b.addEventListener('pointerenter', () => {
      if (!b.disabled) hoverSound();
    });
    b.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'ArrowDown' && k !== 'ArrowUp') return;
      e.preventDefault();
      const list = [...btns.values()].filter((x) => !x.disabled);
      const i = list.indexOf(b);
      const n = list[(i + (k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
      n?.focus();
      n?.click();
    });
    optDisabled.set(opt.value, !!opt.disabled);
    btns.set(opt.value, b);
    el.append(b);
  }
  function paint(): void {
    for (const [v, b] of btns) {
      const on = v === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.disabled = allOff || !!optDisabled.get(v);
    }
    // keep one tabbable stop even if the current value is disabled
    if (![...btns.values()].some((b) => b.tabIndex === 0)) {
      const first = [...btns.values()][0];
      if (first) first.tabIndex = 0;
    }
  }
  paint();
  return {
    el,
    set(v: T, disabled = false) {
      value = v;
      allOff = disabled;
      el.classList.toggle('locked', disabled);
      paint();
    },
    setDisabled(v: T, d: boolean, title?: string) {
      optDisabled.set(v, d);
      const b = btns.get(v);
      if (b && title !== undefined) b.title = title;
      paint();
    },
    setSub(v: T, sub: string) {
      const e = subs.get(v);
      if (e && e.textContent !== sub) e.textContent = sub;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Arrow picker:  [<]  Captain Cap  3/8  [>]
// ---------------------------------------------------------------------------------------------

export interface ArrowPicker {
  el: HTMLElement;
  set(index: number, names: readonly string[]): void;
}

export function arrowPicker(label: string, names: readonly string[], index: number, onChange: (i: number) => void): ArrowPicker {
  let list = names;
  let idx = index;
  const nameEl = h('span', { class: 'ap-name', 'aria-live': 'polite' });
  const countEl = h('span', { class: 'ap-count' });
  const step = (d: number) => {
    idx = (((idx + d) % list.length) + list.length) % list.length;
    paint();
    onChange(idx);
    nameEl.classList.remove('ap-pop');
    void nameEl.offsetWidth;
    nameEl.classList.add('ap-pop');
  };
  const prev = iconButton('left', `Previous ${label.toLowerCase()}`, () => step(-1), 'ap-btn');
  const next = iconButton('right', `Next ${label.toLowerCase()}`, () => step(1), 'ap-btn');
  const el = h('div', { class: 'arrow-picker' }, h('span', { class: 'ap-label', text: label }), prev, h('span', { class: 'ap-mid' }, nameEl, countEl), next);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    }
  });
  function paint(): void {
    const i = ((idx % list.length) + list.length) % list.length;
    nameEl.textContent = list[i] ?? '';
    countEl.textContent = `${i + 1}/${list.length}`;
  }
  paint();
  return {
    el,
    set(i: number, n: readonly string[]) {
      list = n;
      idx = i;
      paint();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Switch and slider
// ---------------------------------------------------------------------------------------------

export interface Toggle {
  el: HTMLElement;
  set(on: boolean, disabled?: boolean): void;
}

export function toggle(label: string, on: boolean, onChange: (v: boolean) => void, hint?: string): Toggle {
  let v = on;
  const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': label }, h('span', { class: 'switch-knob' }));
  const el = h('div', { class: 'field toggle-field' }, h('span', { class: 'field-text' }, h('span', { class: 'field-label', text: label }), hint ? h('span', { class: 'field-hint', text: hint }) : null), sw);
  const paint = () => {
    sw.setAttribute('aria-checked', v ? 'true' : 'false');
    sw.classList.toggle('on', v);
  };
  sw.addEventListener('click', () => {
    if (sw.disabled) return;
    clickSound();
    v = !v;
    paint();
    onChange(v);
  });
  paint();
  return {
    el,
    set(nv: boolean, disabled = false) {
      v = nv;
      sw.disabled = disabled;
      paint();
    },
  };
}

export interface Slider {
  el: HTMLElement;
  set(v: number): void;
}

export function slider(label: string, value: number, onCommit: (v: number) => void, onLive?: (v: number) => void): Slider {
  const input = h('input', { type: 'range', min: 0, max: 100, step: 1, class: 'range', 'aria-label': label });
  const out = h('span', { class: 'range-val' });
  const paint = (n: number) => {
    out.textContent = `${n}%`;
    input.style.setProperty('--fill', `${n}%`);
  };
  input.value = String(Math.round(value * 100));
  paint(Math.round(value * 100));
  input.addEventListener('input', () => {
    const n = Number(input.value);
    paint(n);
    onLive?.(n / 100);
  });
  input.addEventListener('change', () => onCommit(Number(input.value) / 100));
  const el = h('label', { class: 'field slider-field' }, h('span', { class: 'field-label', text: label }), input, out);
  return {
    el,
    set(v: number) {
      if (document.activeElement === input) return;
      const n = Math.round(v * 100);
      if (Number(input.value) !== n) input.value = String(n);
      paint(n);
    },
  };
}

export function field(label: string, control: Node, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-text' }, h('span', { class: 'field-label', text: label }), hint ? h('span', { class: 'field-hint', text: hint }) : null), control);
}

/** Small keycap element. */
export function keycap(text: string, cls = ''): HTMLElement {
  return h('kbd', { class: `keycap ${cls}`.trim(), text });
}
