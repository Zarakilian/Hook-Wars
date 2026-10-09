// Menus, lobby, economy screens and HUD. The app owns state and calls render(state); screens are
// built once when entered and then updated in place, so typing, focus and hover survive frequent
// re-renders. The cosmetic economy (optional) is watched here once, so a purchase or a sale gets its
// sound and toast whichever screen is open.
import { COSMETIC_SLOTS, cosmeticById, ownedLoadout, cleanLoadout, DEFAULT_ITEM_IDS, type Loadout } from '../../shared/cosmetics.ts';
import type { EconomyClient, EconomyState } from '../economy/types.ts';
import type { ScreenView, UiCtx } from './ctx.ts';
import { h, storageGet, storageSet } from './dom.ts';
import { fmtPrice } from './econ.ts';
import { createHowTo } from './howto.ts';
import { createHud } from './hud/hud.ts';
import { icon } from './icons.ts';
import { PudgyPreview } from './preview.ts';
import { buildCareer } from './screens/career.ts';
import { buildLobby } from './screens/lobby.ts';
import { buildLocker } from './screens/locker.ts';
import { buildMarket } from './screens/market.ts';
import { buildMenu } from './screens/menu.ts';
import { buildOnline } from './screens/online.ts';
import { buildSettings } from './screens/settings.ts';
import { buildSolo } from './screens/solo.ts';
import { buildSteam } from './screens/steam.ts';
import { buildStore } from './screens/store.ts';
import { ItemThumbs } from './thumbs.ts';
import type { AppActions, AppState, Screen, UI } from './types.ts';
import './v2.css';
import { button, setUiSound } from './widgets.ts';

const HOWTO_KEY = 'hookwars.howto.seen.v1';

function sameLoadout(a: Loadout | undefined, b: Loadout | undefined): boolean {
  for (const slot of COSMETIC_SLOTS) if ((a?.[slot] ?? '') !== (b?.[slot] ?? '')) return false;
  return true;
}

export function createUI(root: HTMLElement, actions: AppActions, economy?: EconomyClient): UI {
  setUiSound(actions.uiSound);
  root.classList.add('hw-ui');

  const backdrop = h('div', { class: 'menu-bg', 'aria-hidden': 'true' },
    h('div', { class: 'mb-vignette' }),
    h('div', { class: 'mb-lantern' }),
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
  let profileSynced = false;

  const preview = new PudgyPreview();
  const thumbs = new ItemThumbs();
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as Record<string, unknown>).__hwUi = { preview, thumbs };

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

  // ------------------------------------------------------------------------------------ toast
  function showToast(text: string, kind: 'info' | 'error' | 'good'): void {
    const t = h('div', { class: `toast ${kind}` }, icon(kind === 'error' ? 'hazard' : kind === 'good' ? 'sparkle' : 'anchor', 'toast-ico'), h('span', { text }));
    toastWrap.append(t);
    while (toastWrap.childElementCount > 3) toastWrap.firstElementChild?.remove();
    window.setTimeout(() => t.classList.add('out'), 3600);
    window.setTimeout(() => t.remove(), 4100);
  }

  // ------------------------------------------------------------------------------------ economy
  const owns = (id: string): boolean => (economy ? economy.owns(id) : DEFAULT_ITEM_IDS.includes(id));
  const pending = new Set<string>();
  const pendingCopies = new Map<string, { item: string; count: number }>(); // listed instance -> item and copies owned before (market buys)
  const cancelled = new Set<string>();
  let prevEcon: EconomyState | null = economy ? economy.state() : null;

  function watchEconomy(e: EconomyState): void {
    const prev = prevEcon;
    prevEcon = e;
    if (e.error && e.error !== prev?.error) {
      showToast(e.error, 'error');
      pending.clear();
      pendingCopies.clear();
    }
    if (pendingCopies.size && e.account) {
      const owned = e.account.owned;
      for (const [inst, want] of [...pendingCopies]) {
        // the server may keep the listed instance id or issue a new one: either way a new copy arrived
        const got = owned.some((o) => o.instance === inst) || owned.filter((o) => o.item === want.item).length > want.count;
        if (!got) continue;
        pendingCopies.delete(inst);
        actions.uiSound('purchase');
        showToast(`${cosmeticById(want.item)?.name ?? 'Item'} bought from the Market. Equip it in the Locker.`, 'good');
      }
    }
    // Store purchases: the item is owned now
    for (const id of [...pending]) {
      if (!owns(id)) continue;
      pending.delete(id);
      actions.uiSound('purchase');
      showToast(`${cosmeticById(id)?.name ?? 'Item'} is yours! Equip it in the Locker.`, 'good');
    }
    const sameAccount = !!prev?.account && !!e.account && prev.account.id === e.account.id;
    if (sameAccount) {
      const now = new Set(e.account!.owned.map((o) => o.instance));
      for (const o of prev.account!.owned) {
        if (!o.listed || now.has(o.instance)) continue;
        if (cancelled.delete(o.instance)) continue;
        const listing = prev.listings.find((l) => l.id === o.listed || l.instance === o.instance);
        actions.uiSound('listingSold');
        showToast(`Sold: your ${cosmeticById(o.item)?.name ?? 'item'}${listing ? ` for ${fmtPrice(listing.price)}` : ''}`, 'good');
      }
    }
  }
  economy?.onChange(watchEconomy);

  /**
   * Offline, the local account is the source of truth for what each family wears: keep the saved
   * profile (what the sim and the server see) in step with it. Online, app.ts does the same from
   * the server's 'account' message. Never the other way round, so an old or empty profile cannot
   * wipe the account's loadouts.
   */
  function syncProfile(): void {
    if (!economy || !current) return;
    const e = economy.state();
    if (e.mode !== 'local' || !e.account) return;
    const p = current.profile;
    const raw = e.account.loadouts[p.family];
    if (!raw) return;
    const wear = ownedLoadout(cleanLoadout(p.family, raw), owns);
    if (!sameLoadout(wear, p.loadout)) {
      profileSynced = true;
      queueMicrotask(() => {
        profileSynced = false;
        const now = ctx.get().profile;
        if (now.family === p.family && !sameLoadout(wear, now.loadout)) actions.saveProfile({ ...now, loadout: wear });
      });
    }
  }
  economy?.onChange(() => {
    if (!profileSynced) syncProfile();
  });

  const ctx: UiCtx = {
    actions,
    get: () => current!,
    preview,
    openHowTo: (page = 0) => {
      const how = createHowTo(ctx, page, () => close());
      const close = modal(how.el, { cls: 'howto-scrim', label: 'How to play', onClose: () => storageSet(HOWTO_KEY, '1') });
    },
    modal,
    toast: (text, kind = 'info') => showToast(text, kind),
    economy,
    econ: () => (economy ? economy.state() : null),
    onEcon: (cb) => (economy ? economy.onChange(cb) : () => {}),
    owns,
    buyPearls(itemId: string) {
      if (!economy) return;
      if (owns(itemId)) {
        showToast('You already own that.', 'info');
        return;
      }
      pending.add(itemId);
      economy.buyWithPearls(itemId);
    },
    buyListing(l) {
      if (!economy) return;
      const count = economy.state().account?.owned.filter((o) => o.item === l.item).length ?? 0;
      pendingCopies.set(l.instance, { item: l.item, count });
      economy.buyListing(l.id);
    },
    noteCancel(_listing: string, instance: string) {
      cancelled.add(instance);
    },
    thumbs,
  };

  const hud = createHud(hudRoot, ctx);

  // ------------------------------------------------------------------------------------ screens
  function build(scr: Screen, s: AppState): ScreenView | null {
    switch (scr) {
      case 'menu':
        return buildMenu(ctx, s);
      case 'locker':
      case 'profile':
        return buildLocker(ctx, s);
      case 'store':
        return buildStore(ctx, s);
      case 'market':
        return buildMarket(ctx, s);
      case 'career':
        return buildCareer(ctx, s);
      case 'solo':
        return buildSolo(ctx, s);
      case 'online':
        return buildOnline(ctx, s);
      case 'lobby':
        return s.room ? buildLobby(ctx, s) : buildOnline(ctx, s);
      case 'settings':
        return buildSettings(ctx, s);
      case 'steam':
        return s.steam ? buildSteam(ctx, s) : buildMenu(ctx, s);
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------------------------ Steam invite
  // A friend's invite that arrived during a live match (Steam build only): join now, or not now.
  let inviteShown: string | null = null;
  let inviteClose: (() => void) | null = null;
  function paintInvite(s: AppState): void {
    const id = s.steam?.invite ?? null;
    if (id === inviteShown) return;
    inviteShown = id;
    if (inviteClose) {
      const c = inviteClose;
      inviteClose = null; // closed by us, not a "not now"
      c();
    }
    if (!id) return;
    const answer = (join: boolean) => {
      const c = inviteClose;
      inviteClose = null;
      c?.();
      if (join) actions.steamAcceptInvite?.();
      else actions.steamDismissInvite?.();
    };
    const box = h('div', { class: 'panel stm-invite' },
      h('header', { class: 'panel-head' }, h('h2', { class: 'panel-title', text: 'Steam invite' }), h('span', { class: 'head-spacer' })),
      h('div', { class: 'panel-body' }, h('p', { text: 'A friend invited you to their Hook Wars lobby.' }), h('p', { class: 'muted', text: 'Joining now leaves this match.' })),
      h('footer', { class: 'panel-foot' }, button('Not now', () => answer(false), { cls: 'ghost' }), h('span', { class: 'head-spacer' }), button('Join lobby', () => answer(true), { cls: 'primary', icon: 'people' })));
    inviteClose = modal(box, {
      label: 'Steam invite',
      onClose: () => {
        if (!inviteClose) return;
        inviteClose = null;
        actions.steamDismissInvite?.(); // Esc or a click outside
      },
    });
  }

  function render(s: AppState): void {
    const prev = current ?? s;
    current = s;
    if (!profileSynced) syncProfile();
    if (s.toast && s.toast.id !== lastToast) {
      lastToast = s.toast.id;
      showToast(s.toast.text, s.toast.kind);
    }
    if (s.steam) paintInvite(s);
    hud.settings(s.settings);
    const inMatch = s.match !== null && (s.screen === 'match' || s.screen === 'settings');
    root.classList.toggle('in-match', inMatch);
    backdrop.classList.toggle('hidden', inMatch);
    let scr: Screen = s.screen === 'profile' ? 'locker' : s.screen;
    if (scr === 'lobby' && !s.room) scr = s.steam && s.steam.phase !== 'idle' ? 'steam' : 'online';
    root.dataset.screen = scr;
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
