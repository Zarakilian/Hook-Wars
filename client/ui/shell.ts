// Shared chrome for the menu and the economy screens: the profile chip (name, family, Pearls) and
// the hub header with Locker / Store / Market / Career tabs.
import { FAMILY_DEFS } from '../../shared/constants.ts';
import type { EconomyState } from '../economy/types.ts';
import type { UiCtx } from './ctx.ts';
import { h, pulse } from './dom.ts';
import { fmtPearls } from './econ.ts';
import { icon, setIcon, type IconId } from './icons.ts';
import type { AppState, Screen } from './types.ts';
import { button, clickSound } from './widgets.ts';

export interface ProfileChip {
  el: HTMLElement;
  update(s: AppState): void;
  destroy(): void;
}

export function profileChip(ctx: UiCtx): ProfileChip {
  const a = ctx.actions;
  const fam = icon('brawler', 'pcp-fam-ico');
  const name = h('span', { class: 'pcp-name' });
  const sub = h('span', { class: 'pcp-sub' });
  const who = h('button', { class: 'pcp-who', type: 'button', title: 'Open the Locker' }, h('span', { class: 'pcp-fam' }, fam), h('span', { class: 'pcp-texts' }, name, sub));
  who.addEventListener('click', () => {
    clickSound();
    a.go('locker');
  });
  const pearlsNum = h('span', { class: 'pcp-pearls-num', text: '0' });
  const pearls = h('button', { class: 'pcp-pearls', type: 'button', title: 'Pearls: earned by playing. Spend them in the Store.' }, icon('pearl', 'pcp-pearl-ico'), pearlsNum);
  pearls.addEventListener('click', () => {
    clickSound();
    a.go('store');
  });
  const el = h('div', { class: 'pchip', role: 'group', 'aria-label': 'Your profile' }, who, pearls);

  let shownPearls = -1;
  const paintEcon = (e: EconomyState | null) => {
    const acc = e?.account ?? null;
    const p = acc ? acc.pearls : 0;
    if (p !== shownPearls) {
      if (shownPearls >= 0 && p > shownPearls) pulse(pearls, 'gain');
      shownPearls = p;
      pearlsNum.textContent = fmtPearls(p);
    }
    pearls.classList.toggle('hidden', !e);
  };
  const unsub = ctx.onEcon(paintEcon);
  paintEcon(ctx.econ());

  let famShown = '';
  const update = (s: AppState) => {
    name.textContent = s.profile.name;
    sub.textContent = FAMILY_DEFS[s.profile.family].name;
    if (famShown !== s.profile.family) {
      famShown = s.profile.family;
      setIcon(fam, s.profile.family);
    }
  };
  update(ctx.get());
  return { el, update, destroy: unsub };
}

// ---------------------------------------------------------------------------------------------
// Hub header
// ---------------------------------------------------------------------------------------------

const HUB: { screen: Screen; label: string; icon: IconId }[] = [
  { screen: 'locker', label: 'Locker', icon: 'locker' },
  { screen: 'store', label: 'Store', icon: 'shop' },
  { screen: 'market', label: 'Market', icon: 'market' },
  { screen: 'career', label: 'Career', icon: 'career' },
];

export interface HubShell {
  el: HTMLElement;
  body: HTMLElement;
  update(s: AppState): void;
  destroy(): void;
}

export function hubShell(ctx: UiCtx, active: Screen, title: string, subtitle: string, cls: string): HubShell {
  const a = ctx.actions;
  const chip = profileChip(ctx);
  const tabs = h('nav', { class: 'hub-tabs', 'aria-label': 'Hub' });
  for (const t of HUB) {
    const b = h('button', { class: `hub-tab ${t.screen === active ? 'on' : ''}`, type: 'button', 'aria-current': t.screen === active ? 'page' : 'false' }, icon(t.icon, 'ht-ico'), h('span', { text: t.label }));
    b.addEventListener('click', () => {
      if (t.screen === active) return;
      clickSound();
      a.go(t.screen);
    });
    tabs.append(b);
  }
  const head = h('header', { class: 'hub-head' },
    button('Back', () => a.go('menu'), { cls: 'ghost hub-back', icon: 'left' }),
    h('div', { class: 'hub-title' }, h('h2', { class: 'panel-title', text: title }), h('span', { class: 'hub-sub', text: subtitle })),
    tabs,
    h('span', { class: 'head-spacer' }),
    chip.el);
  const body = h('div', { class: 'hub-body' });
  const el = h('div', { class: `scr scr-hub ${cls}` }, head, body);

  // Esc goes back to the menu (unless a modal is open)
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || document.querySelector('.modal-scrim')) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
    e.preventDefault();
    a.go('menu');
  };
  window.addEventListener('keydown', onKey);
  return {
    el,
    body,
    update: (s) => chip.update(s),
    destroy() {
      chip.destroy();
      window.removeEventListener('keydown', onKey);
    },
  };
}

/** "The economy is not available" placeholder for builds without one. */
export function econUnavailable(what: string): HTMLElement {
  return h('div', { class: 'empty-state big' }, icon('lifebuoy'), h('span', { text: `${what} is not available in this build.` }));
}
