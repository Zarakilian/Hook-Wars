// Menus, lobby and HUD. The app owns state and calls render(state); screens are built once when
// entered and then updated in place, so typing, focus and hover survive frequent re-renders.
import type { ScreenView, UiCtx } from './ctx.ts';
import { h, storageGet, storageSet } from './dom.ts';
import { createHowTo } from './howto.ts';
import { createHud } from './hud/hud.ts';
import { icon } from './icons.ts';
import { PudgyPreview } from './preview.ts';
import { buildLobby } from './screens/lobby.ts';
import { buildMenu } from './screens/menu.ts';
import { buildOnline } from './screens/online.ts';
import { buildSettings } from './screens/settings.ts';
import { buildSolo } from './screens/solo.ts';
import type { AppActions, AppState, Screen, UI } from './types.ts';
import { setUiSound } from './widgets.ts';

import type { EconomyClient } from '../economy/types.ts';

const HOWTO_KEY = 'hookwars.howto.seen.v1';

export function createUI(root: HTMLElement, actions: AppActions, economy?: EconomyClient): UI {
  void economy; // Locker, Store and Marketplace screens build on this (see client/economy/types.ts)
  setUiSound(actions.uiSound);
  root.classList.add('hw-ui');

  const backdrop = h('div', { class: 'menu-bg', 'aria-hidden': 'true' },
    h('div', { class: 'mb-vignette' }),
    h('div', { class: 'mb-waves' }, h('div', { class: 'mb-wave w1' }), h('div', { class: 'mb-wave w2' }), h('div', { class: 'mb-wave w3' })));
  const screens = h('div', { class: 'screens' });
  const hudRoot = h('div', { class: 'hud hidden' });
  const overlays = h('div', { class: 'overlays' });
  const toastWrap = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  root.append(backdrop, hudRoot, screens, overlays, toastWrap);

  let current: AppState | null = null;
  let view: ScreenView | null = null;
  let viewScreen: Screen | null = null;
  let lastToast = -1;
  let howtoShown = false;

  const preview = new PudgyPreview();

  // ------------------------------------------------------------------------------------ modals
  const modalStack: { el: HTMLElement; close: () => void; prevFocus: Element | null }[] = [];
  function modal(content: HTMLElement, o: { onClose?: () => void; cls?: string; label?: string } = {}): () => void {
    const scrim = h('div', { class: `modal-scrim ${o.cls ?? ''}`.trim() });
    const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.label ?? 'Dialog' }, content);
    scrim.append(dlg);
    let closed = false;
    const entry = { el: scrim, close: () => {}, prevFocus: document.activeElement };
    const close = () => {
      if (closed) return;
      closed = true;
      scrim.classList.add('closing');
      const i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      window.setTimeout(() => scrim.remove(), 180);
      o.onClose?.();
      const pf = entry.prevFocus as HTMLElement | null;
      if (pf && pf.isConnected && typeof pf.focus === 'function') pf.focus();
    };
    entry.close = close;
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close();
    });
    overlays.append(scrim);
    modalStack.push(entry);
    requestAnimationFrame(() => {
      const f = dlg.querySelector<HTMLElement>('[data-autofocus], button.primary, button, input');
      f?.focus({ preventScroll: true });
    });
    return close;
  }
  // Esc closes the top modal (capture phase, so the in-match input never sees it)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || modalStack.length === 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    modalStack[modalStack.length - 1].close();
  }, true);

  const ctx: UiCtx = {
    actions,
    get: () => current!,
    preview,
    openHowTo: (page = 0) => {
      const how = createHowTo(ctx, page, () => close());
      const close = modal(how.el, { cls: 'howto-scrim', label: 'How to play', onClose: () => storageSet(HOWTO_KEY, '1') });
    },
    modal,
  };

  const hud = createHud(hudRoot, ctx);

  // ------------------------------------------------------------------------------------ toast
  function showToast(text: string, kind: 'info' | 'error'): void {
    const t = h('div', { class: `toast ${kind}` }, icon(kind === 'error' ? 'hazard' : 'anchor', 'toast-ico'), h('span', { text }));
    toastWrap.append(t);
    while (toastWrap.childElementCount > 3) toastWrap.firstElementChild?.remove();
    window.setTimeout(() => t.classList.add('out'), 3600);
    window.setTimeout(() => t.remove(), 4100);
  }

  // ------------------------------------------------------------------------------------ screens
  function build(scr: Screen, s: AppState): ScreenView | null {
    switch (scr) {
      case 'menu':
      case 'profile':
        return buildMenu(ctx, s);
      case 'solo':
        return buildSolo(ctx, s);
      case 'online':
        return buildOnline(ctx, s);
      case 'lobby':
        return s.room ? buildLobby(ctx, s) : buildOnline(ctx, s);
      case 'settings':
        return buildSettings(ctx, s);
      default:
        return null;
    }
  }

  function render(s: AppState): void {
    const prev = current ?? s;
    current = s;
    if (s.toast && s.toast.id !== lastToast) {
      lastToast = s.toast.id;
      showToast(s.toast.text, s.toast.kind);
    }
    hud.settings(s.settings);
    const inMatch = s.match !== null && (s.screen === 'match' || s.screen === 'settings');
    root.classList.toggle('in-match', inMatch);
    backdrop.classList.toggle('hidden', inMatch);
    let scr: Screen = s.screen === 'profile' ? 'menu' : s.screen;
    if (scr === 'lobby' && !s.room) scr = 'online';
    if (scr === 'match') {
      if (view) {
        view.destroy();
        view.el.remove();
        view = null;
        viewScreen = null;
      }
      screens.classList.add('hidden');
      return;
    }
    screens.classList.remove('hidden');
    screens.classList.toggle('over-match', inMatch);
    if (scr !== viewScreen || !view) {
      if (view) {
        view.destroy();
        view.el.remove();
      }
      view = build(scr, s);
      viewScreen = scr;
      if (view) {
        view.el.classList.add('scr-enter');
        screens.append(view.el);
      }
    } else {
      view.update(s, prev);
    }
    if (!howtoShown && scr === 'menu') {
      howtoShown = true;
      if (storageGet(HOWTO_KEY) !== '1') window.setTimeout(() => ctx.openHowTo(), 450);
    }
  }

  return {
    render,
    hud,
  };
}
