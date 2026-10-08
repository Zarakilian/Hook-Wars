// Store: featured items, Pearl items grouped by rarity, and Limited items priced in devnet USDC.
// The right side is a fitting room: the selected item on your Pudgy in the 3D preview, its price,
// and the one button that applies (Buy, Connect Wallet, or the reason you cannot buy yet).
import { FAMILY_DEFS } from '../../../shared/constants.ts';
import { COSMETICS, cosmeticById, DEFAULT_LOADOUT, ownedLoadout, SLOT_NAMES, type CosmeticDef, type Loadout, type Rarity } from '../../../shared/cosmetics.ts';
import { FAMILIES, type FamilyId } from '../../../shared/types.ts';
import type { EconomyState } from '../../economy/types.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { byRarity, fmtPearls, fmtUsdc, networkLabel, RARITY_INFO, SLOT_ICON, sourceLine } from '../econ.ts';
import { icon } from '../icons.ts';
import { itemCard, rarityPill, type ItemCard } from '../items.ts';
import { navHint } from '../nav.ts';
import { econUnavailable, hubShell } from '../shell.ts';
import type { AppState } from '../types.ts';
import { button, segmented, setButtonLabel } from '../widgets.ts';

type Tab = 'featured' | 'pearls' | 'limited';
type FamFilter = FamilyId | 'all';

/** Featured rotation: every Limited item, then the priciest Epic of each family. */
function featuredItems(): CosmeticDef[] {
  const out = COSMETICS.filter((c) => c.rarity === 'limited');
  for (const f of FAMILIES) {
    const epic = COSMETICS.filter((c) => c.family === f && c.rarity === 'epic').sort((a, b) => (b.pearls ?? 0) - (a.pearls ?? 0))[0];
    if (epic) out.push(epic);
  }
  return out;
}

const PEARL_RARITIES: Rarity[] = ['epic', 'rare', 'common'];

export function buildStore(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;
  const shell = hubShell(ctx, 'store', 'Store', 'Spend Pearls, collect Limited editions', 'scr-store');
  const releaseThumbs = ctx.thumbs.hold();
  const econ = ctx.economy;

  let tab: Tab = 'featured';
  let fam: FamFilter = 'all';
  let selected: CosmeticDef = featuredItems()[0];
  if (navHint.storeItem) {
    const d = cosmeticById(navHint.storeItem);
    if (d && d.rarity !== 'default') {
      selected = d;
      tab = d.rarity === 'limited' ? 'limited' : 'pearls';
    }
  }
  navHint.storeItem = null;

  if (!econ) {
    shell.body.append(econUnavailable('The Store'));
    return { el: shell.el, update: (s) => shell.update(s), destroy: () => { shell.destroy(); releaseThumbs(); } };
  }

  // ---------------------------------------------------------------- left: tabs, filters, grids
  const tabs = segmented<Tab>({
    label: 'Store section',
    cls: 'seg-small st-tabs',
    value: tab,
    options: [
      { value: 'featured', label: 'Featured', icon: 'star' },
      { value: 'pearls', label: 'Pearl Shop', icon: 'pearl' },
      { value: 'limited', label: 'Limited', icon: 'sparkle' },
    ],
    onChange: (t) => {
      tab = t;
      rebuild();
    },
  });
  const famSeg = segmented<FamFilter>({
    label: 'Family',
    cls: 'seg-small st-fams',
    value: fam,
    options: [{ value: 'all' as FamFilter, label: 'All' }, ...FAMILIES.map((f) => ({ value: f as FamFilter, label: FAMILY_DEFS[f].name.split(' ').pop() ?? f, icon: f, title: FAMILY_DEFS[f].name }))],
    onChange: (f) => {
      fam = f;
      rebuild();
    },
  });
  const listWrap = h('div', { class: 'st-list' });
  const left = h('section', { class: 'st-left' }, h('div', { class: 'st-bar' }, tabs.el, h('span', { class: 'head-spacer' }), famSeg.el), listWrap);

  let cards: ItemCard[] = [];
  const famOk = (d: CosmeticDef) => fam === 'all' || d.family === fam;
  const makeCards = (defs: CosmeticDef[], big = false) => {
    const grid = h('div', { class: `st-grid ${big ? 'big' : ''}`.trim(), role: 'list' });
    for (const d of defs) {
      const c = itemCard(ctx, d, () => select(d));
      if (big) c.el.classList.add('feature');
      if (big) c.el.append(h('span', { class: 'ic-fam' }, icon(d.family), h('span', { text: FAMILY_DEFS[d.family].name })));
      cards.push(c);
      grid.append(c.el);
    }
    return grid;
  };

  function rebuild(): void {
    cards = [];
    listWrap.replaceChildren();
    listWrap.scrollTop = 0;
    famSeg.el.classList.toggle('hidden', tab === 'featured');
    if (tab === 'featured') {
      const defs = featuredItems();
      listWrap.append(
        h('div', { class: 'st-banner' },
          h('span', { class: 'stb-kicker' }, icon('sparkle'), h('span', { text: 'This season' })),
          h('span', { class: 'stb-title', text: 'Tides of Plenty' }),
          h('span', { class: 'stb-sub', text: 'Three Limited editions and the finest Epics from every family.' })),
        makeCards(defs, true));
    } else if (tab === 'pearls') {
      for (const r of PEARL_RARITIES) {
        const defs = COSMETICS.filter((c) => c.rarity === r && famOk(c)).sort(byRarity);
        if (!defs.length) continue;
        const info = RARITY_INFO[r];
        listWrap.append(
          h('div', { class: 'st-sec-title', style: `--rc:${info.color}` }, h('span', { class: 'st-sec-dot' }), h('span', { text: info.name }), h('span', { class: 'st-sec-count', text: `${defs.length}` }), r === 'epic' ? h('span', { class: 'st-sec-note', text: 'Tradable on the Market' }) : null),
          makeCards(defs));
      }
    } else {
      const defs = COSMETICS.filter((c) => c.rarity === 'limited' && famOk(c)).sort(byRarity);
      listWrap.append(
        h('div', { class: 'devnet-note big' }, icon('info'), h('span', {},
          h('strong', { text: 'Devnet test tokens only, no real money. ' }),
          h('span', { text: 'Limited items are numbered editions, minted as NFTs on Solana devnet and paid in test USDC. You need a linked wallet and an online server.' }))),
        defs.length ? makeCards(defs, true) : h('div', { class: 'empty-state', text: 'No Limited items for this family yet.' }));
    }
    paint();
  }

  // ---------------------------------------------------------------- right: fitting room
  const stage = h('div', { class: 'st-stage' });
  const dName = h('div', { class: 'st-d-name' });
  const dMeta = h('div', { class: 'st-d-meta' });
  const dBlurb = h('div', { class: 'st-d-blurb' });
  const dSource = h('div', { class: 'st-d-source' });
  const dPrice = h('div', { class: 'st-d-price' });
  const dActions = h('div', { class: 'st-d-actions' });
  const dReason = h('div', { class: 'st-d-reason hidden' });
  const dNote = h('div', { class: 'devnet-note hidden' }, icon('info'), h('span', { text: 'Devnet test tokens only, no real money.' }));
  const right = h('section', { class: 'st-right' },
    h('div', { class: 'st-stage-wrap' }, stage, h('div', { class: 'lk-hint', text: 'Drag to spin' }), h('div', { class: 'st-fit', text: 'Fitting room' })),
    h('div', { class: 'st-detail cloth' }, dName, dMeta, dBlurb, dSource, h('div', { class: 'st-d-buy' }, dPrice, dActions), dReason, dNote));
  shell.body.append(h('div', { class: 'st-layout' }, left, right));

  function select(d: CosmeticDef): void {
    selected = d;
    paint();
  }

  /** The selected item worn over your current look for that family. */
  function lookWith(d: CosmeticDef): Loadout {
    const e = ctx.econ();
    const p = ctx.get().profile;
    const raw = e?.account?.loadouts[d.family] ?? (d.family === p.family ? p.loadout : DEFAULT_LOADOUT[d.family]);
    return { ...ownedLoadout(raw, ctx.owns), [d.slot]: d.id };
  }

  let lastLook = '';
  const pending = new Set<string>();

  function paintDetail(e: EconomyState): void {
    const d = selected;
    const look = lookWith(d);
    const key = `${d.family}|${JSON.stringify(look)}|${ctx.get().settings.soloTeam}`;
    if (key !== lastLook) {
      lastLook = key;
      ctx.preview.focus(d.slot);
      ctx.preview.show({ family: d.family, loadout: look, team: ctx.get().settings.soloTeam, name: ctx.get().profile.name }, 'celebrate');
    }
    dName.textContent = d.name;
    dMeta.replaceChildren(rarityPill(d),
      h('span', { class: 'lk-d-slot' }, icon(d.family), h('span', { text: FAMILY_DEFS[d.family].name })),
      h('span', { class: 'lk-d-slot' }, icon(SLOT_ICON[d.slot]), h('span', { text: SLOT_NAMES[d.slot] })));
    dBlurb.textContent = d.blurb;
    dSource.textContent = sourceLine(d);
    const owned = ctx.owns(d.id);
    const acc = e.account;
    dActions.replaceChildren();
    dReason.classList.add('hidden');
    dNote.classList.toggle('hidden', d.rarity !== 'limited');
    const reason = (text: string) => {
      dReason.textContent = text;
      dReason.classList.remove('hidden');
    };

    if (d.rarity === 'limited') {
      dPrice.replaceChildren(icon('usdc', 'stp-ico'), h('span', { class: 'stp-num', text: (d.usdc ?? 0).toFixed(2) }), h('span', { class: 'stp-cur', text: 'USDC' }), h('span', { class: 'stp-supply', text: `Edition of ${d.supply ?? '?'}` }));
    } else {
      dPrice.replaceChildren(icon('pearl', 'stp-ico'), h('span', { class: 'stp-num', text: fmtPearls(d.pearls ?? 0) }), h('span', { class: 'stp-cur', text: 'Pearls' }));
    }

    if (owned) {
      dActions.append(button('Equip in Locker', () => {
        navHint.lockerItem = d.id;
        a.go('locker');
      }, { cls: 'good', icon: 'locker' }));
      dActions.prepend(h('span', { class: 'lk-eq-badge' }, icon('check'), h('span', { text: 'Owned' })));
      return;
    }

    if (d.rarity === 'limited') {
      if (e.mode === 'local') {
        reason('Limited items are sold by an online server. Connect to one to buy.');
        dActions.append(button('Play Online', () => a.go('online'), { icon: 'globe' }));
        return;
      }
      if (e.network === 'off') {
        reason('This server has its Solana link switched off, so Limited items are not on sale here.');
        return;
      }
      if (!acc?.wallet) {
        reason(e.walletAvailable ? 'Link a wallet first. Signing in costs nothing and moves no tokens.' : 'No Solana wallet was found in this browser. Install a wallet extension, then reload.');
        const c = button('Connect Wallet', () => {
          c.disabled = true;
          setButtonLabel(c, 'Waiting for the wallet...');
          econ!.connectWallet().catch((err: unknown) => ctx.toast(err instanceof Error ? err.message : 'The wallet did not connect.', 'error')).finally(() => paint());
        }, { cls: 'primary', icon: 'wallet', disabled: e.busy || !e.walletAvailable });
        dActions.append(c);
        return;
      }
      const busy = e.busy || pending.has(d.id);
      const b = button(busy ? 'Waiting for the wallet...' : `Buy for ${fmtUsdc(d.usdc ?? 0)}`, () => {
        pending.add(d.id);
        ctx.buyUsdc(d.id);
        paint();
      }, { cls: 'primary limited-btn', icon: 'usdc', disabled: busy });
      dActions.append(b);
      dReason.textContent = `Paid from ${networkLabel(e.network)} wallet. Your wallet asks you to approve it.`;
      dReason.classList.remove('hidden');
      return;
    }

    if (!acc) {
      reason(e.mode === 'server' ? 'Signing in to your account on this server...' : 'Your locker is not loaded yet.');
      dActions.append(button(`Buy for ${fmtPearls(d.pearls ?? 0)}`, () => {}, { cls: 'ghost', icon: 'pearl', disabled: true }));
      return;
    }
    const have = acc.pearls;
    const price = d.pearls ?? 0;
    const short = price - have;
    if (short > 0) {
      reason(`You need ${fmtPearls(short)} more Pearls. Win matches to earn them faster.`);
      dActions.append(button(`Need ${fmtPearls(short)} more`, () => {}, { cls: 'ghost', icon: 'pearl', disabled: true }));
      return;
    }
    const busy = e.busy || pending.has(d.id);
    dActions.append(button(busy ? 'Buying...' : `Buy for ${fmtPearls(price)}`, () => {
      pending.add(d.id);
      ctx.buyPearls(d.id);
      paint();
    }, { cls: 'primary buy-btn', icon: 'pearl', disabled: busy }));
    dReason.textContent = `You have ${fmtPearls(have)} Pearls. ${fmtPearls(have - price)} left after this.`;
    dReason.classList.remove('hidden');
  }

  function paint(): void {
    const e = ctx.econ();
    if (!e) return;
    for (const id of [...pending]) if (ctx.owns(id) || (!e.busy && e.error)) pending.delete(id);
    for (const c of cards) {
      c.set({ owned: ctx.owns(c.def.id), selected: c.def.id === selected.id });
    }
    paintDetail(e);
  }

  const unsub = ctx.onEcon(() => paint());
  rebuild();
  queueMicrotask(() => {
    if (!shell.el.isConnected) return;
    ctx.preview.mount(stage);
    lastLook = '';
    paint();
  });
  void s0;

  return {
    el: shell.el,
    update(s: AppState, prev: AppState) {
      shell.update(s);
      if (s.profile !== prev.profile || s.settings.soloTeam !== prev.settings.soloTeam) paint();
    },
    destroy() {
      unsub();
      shell.destroy();
      releaseThumbs();
      ctx.preview.unmount();
    },
  };
}
