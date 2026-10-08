// Tiny DOM helpers. Text always goes through textContent, never innerHTML, so names and chat are safe.

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.setAttribute('class', String(v));
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG element factory (createElementNS). */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (SVGElement | null | undefined | false)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  applyAttrs(el, attrs);
  for (const c of children) if (c) el.append(c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Cached writers for per-frame HUD updates: they only touch the DOM when the value changes.
// ---------------------------------------------------------------------------------------------

interface Cache {
  __t?: string;
  __tf?: string;
  __v?: Record<string, string>;
  __c?: Record<string, boolean>;
  __d?: string;
  __a?: Record<string, string>;
}

export function setText(el: Element, text: string): void {
  const c = el as unknown as Cache;
  if (c.__t === text) return;
  c.__t = text;
  el.textContent = text;
}

export function setTransform(el: HTMLElement | SVGElement, tf: string): void {
  const c = el as unknown as Cache;
  if (c.__tf === tf) return;
  c.__tf = tf;
  el.style.transform = tf;
}

export function setVar(el: HTMLElement | SVGElement, name: string, value: string): void {
  const c = el as unknown as Cache;
  const v = c.__v ?? (c.__v = {});
  if (v[name] === value) return;
  v[name] = value;
  el.style.setProperty(name, value);
}

export function setClass(el: Element, cls: string, on: boolean): void {
  const c = el as unknown as Cache;
  const m = c.__c ?? (c.__c = {});
  if (m[cls] === on) return;
  m[cls] = on;
  el.classList.toggle(cls, on);
}

export function setDisplay(el: HTMLElement, show: boolean): void {
  const c = el as unknown as Cache;
  const d = show ? '' : 'none';
  if (c.__d === d) return;
  c.__d = d;
  el.style.display = d;
}

export function setAttr(el: Element, name: string, value: string): void {
  const c = el as unknown as Cache;
  const m = c.__a ?? (c.__a = {});
  if (m[name] === value) return;
  m[name] = value;
  el.setAttribute(name, value);
}

/** Forget cached values (after a reset that rebuilt or restyled elements). */
export function forget(el: Element): void {
  const c = el as unknown as Cache;
  c.__t = undefined;
  c.__tf = undefined;
  c.__v = undefined;
  c.__c = undefined;
  c.__d = undefined;
  c.__a = undefined;
}

/** Restart a CSS animation class (e.g. a pop) on an element. */
export function pulse(el: Element, cls: string): void {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth; // reflow on purpose, only on discrete events
  el.classList.add(cls);
}

export function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

export function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}

/** Keep a control from taking keyboard focus on mouse press (so Space/Enter never re-trigger it in a match). */
export function noFocus(el: HTMLElement): HTMLElement {
  el.addEventListener('mousedown', (e) => e.preventDefault());
  return el;
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: fine, it just will not be remembered
  }
}
