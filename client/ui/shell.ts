// Shared chrome for the menu and the economy screens: the profile chip (name, family, Pearls,
// wallet, network), the hub header with Locker / Store / Market / Career tabs, and the wallet panel.
import { FAMILY_DEFS } from '../../shared/constants.ts';
import type { EconomyState } from '../economy/types.ts';
import type { UiCtx } from './ctx.ts';
import { h, pulse } from './dom.ts';
import { fmtPearls, networkLabel, shortAddr } from './econ.ts';
import { icon, setIcon, type IconId } from './icons.ts';
import type { AppState, Screen } from './types.ts';
import { button, clickSound, iconButton, setButtonLabel } from './widgets.ts';

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
  const walletText = h('span', { class: 'pcp-wallet-text', text: 'Wallet' });
  const wallet = h('button', { class: 'pcp-wallet', type: 'button', title: 'Wallet: only needed for Limited items' }, icon('wallet', 'pcp-wallet-ico'), walletText);
  wallet.addEventListener('click', () => {
    clickSound();
    ctx.openWallet();
  });
  const net = h('span', { class: 'pcp-net hidden', title: 'Solana devnet: test tokens only, no real money' });
  const el = h('div', { class: 'pchip', role: 'group', 'aria-label': 'Your profile' }, who, pearls, wallet, net);

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
    const linked = !!acc?.wallet;
    wallet.classList.toggle('linked', linked);
    walletText.textContent = linked && acc?.wallet ? shortAddr(acc.wallet) : 'Wallet';
    wallet.title = linked ? 'Wallet linked. Click for details.' : 'Wallet: only needed for Limited items';
    wallet.classList.toggle('hidden', !e);
    const n = e?.network ?? 'off';
    net.classList.toggle('hidden', n === 'off');
    net.classList.toggle('mainnet', n === 'mainnet');
    net.textContent = networkLabel(n);
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

// ---------------------------------------------------------------------------------------------
// Wallet panel
// ---------------------------------------------------------------------------------------------

export function openWallet(ctx: UiCtx): void {
  const econ = ctx.economy;
  const status = h('div', { class: 'wl-status' });
  const addr = h('div', { class: 'wl-addr hidden' });
  const err = h('p', { class: 'err-box hidden', role: 'alert' });
  const note = h('div', { class: 'devnet-note' }, icon('info'), h('span', { text: 'Devnet test tokens only, no real money.' }));
  const explain = h('p', { class: 'muted wl-explain', text: 'You only need a wallet for Limited items. Pearls, the Store and the Locker all work without one. Linking signs a message: it costs nothing and cannot move any tokens.' });
  const connect = button('Connect Wallet', () => {
    if (!econ) return;
    connect.disabled = true;
    setButtonLabel(connect, 'Waiting for the wallet...');
    econ.connectWallet().catch((e: unknown) => ctx.toast(e instanceof Error ? e.message : 'The wallet did not connect.', 'error')).finally(() => paint(econ.state()));
  }, { cls: 'primary big', icon: 'link' });
  const goOnline = button('Play Online', () => {
    close();
    ctx.actions.go('online');
  }, { icon: 'globe' });

  const paint = (e: EconomyState | null) => {
    status.replaceChildren();
    if (!e) {
      status.append(icon('lifebuoy', 'wl-ico'), h('span', { class: 'wl-st-text', text: 'Wallets are not available in this build.' }));
      connect.classList.add('hidden');
      goOnline.classList.add('hidden');
      return;
    }
    const acc = e.account;
    const linked = !!acc?.wallet;
    const net = e.network;
    status.append(
      icon('wallet', 'wl-ico'),
      h('span', { class: 'wl-st-texts' },
        h('span', { class: 'wl-st-text', text: linked ? 'Wallet linked' : 'No wallet linked' }),
        h('span', { class: 'wl-st-sub', text: e.mode === 'local' ? 'Offline locker: wallets link to an online account.' : net === 'off' ? 'This server has its Solana link switched off.' : e.walletAvailable ? `${e.walletName ?? 'A Solana wallet'} was found in this browser.` : 'No Solana wallet extension found in this browser.' })),
      h('span', { class: `net-badge ${net}`, text: networkLabel(net) }));
    addr.classList.toggle('hidden', !linked);
    if (linked && acc?.wallet) {
      const full = acc.wallet;
      const copy = iconButton('copy', 'Copy address', () => {
        void navigator.clipboard?.writeText(full).then(() => ctx.toast('Address copied', 'good'), () => ctx.toast('Copy failed: select the address and press Ctrl+C', 'error'));
      }, 'small');
      addr.replaceChildren(h('span', { class: 'wl-addr-label', text: 'Address' }), h('code', { class: 'wl-addr-code', text: shortAddr(full), title: full }), copy);
    }
    err.textContent = e.error ?? '';
    err.classList.toggle('hidden', !e.error);
    const canLink = e.mode === 'server' && net !== 'off';
    connect.classList.toggle('hidden', linked || !canLink);
    connect.disabled = e.busy || !e.walletAvailable;
    setButtonLabel(connect, e.busy ? 'Waiting for the wallet...' : e.walletAvailable ? (e.walletName ? `Connect ${e.walletName}` : 'Connect Wallet') : 'No wallet found');
    goOnline.classList.toggle('hidden', e.mode !== 'local');
    note.classList.toggle('hidden', net === 'off' && e.mode === 'local');
  };

  const unsub = ctx.onEcon(paint);
  paint(ctx.econ());
  let close = () => {};
  const dlg = h('div', { class: 'panel wallet-panel' },
    h('header', { class: 'panel-head' }, icon('wallet', 'wp-head-ico'), h('h2', { class: 'panel-title', text: 'Wallet' }), h('span', { class: 'head-spacer' }), iconButton('close', 'Close', () => close(), 'ghost')),
    h('div', { class: 'panel-body wl-body' }, status, addr, explain, note, err),
    h('footer', { class: 'panel-foot' }, goOnline, h('span', { class: 'head-spacer' }), connect, button('Close', () => close(), { cls: 'ghost' })));
  close = ctx.modal(dlg, { label: 'Wallet', onClose: unsub });
}
