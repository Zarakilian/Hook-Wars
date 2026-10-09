// Market: player listings with filters (family, slot) and price sorting; your own listings with
// Cancel; and a Sell tab of your tradable copies with a price dialog and a 5% fee preview. Every
// trade is in Pearls and only Epic items trade here (Premium items trade on the Steam Community
// Market in the Steam version). The server settles every trade (docs/economy.md). Offline there is
// nobody to trade with, so the screen says how to get online instead.
import { FAMILY_DEFS } from '../../../shared/constants.ts';
import { COSMETIC_SLOTS, cosmeticById, SLOT_NAMES, type CosmeticDef, type CosmeticSlot } from '../../../shared/cosmetics.ts';
import { MAX_LISTINGS_PER_ACCOUNT, type Listing, type OwnedItem } from '../../../shared/economy.ts';
import { isSteam } from '../../platform.ts';
import { FAMILIES, type FamilyId } from '../../../shared/types.ts';
import type { EconomyState } from '../../economy/types.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { FEE_PCT, fmtPearls, fmtPrice, LIST_LIMITS, marketFee, marketLockNote, marketTradable, sellerReceives, SLOT_ICON, suggestPrice } from '../econ.ts';
import { icon } from '../icons.ts';
import { itemArt, itemCard, rarityPill, type ItemCard } from '../items.ts';
import { econUnavailable, hubShell } from '../shell.ts';
import type { AppState } from '../types.ts';
import { button, iconButton, segmented } from '../widgets.ts';

type Tab = 'browse' | 'mine' | 'sell';
type Sort = 'low' | 'high' | 'new';
type Any<T> = T | 'all';

function ago(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} days ago`;
}

export function buildMarket(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;
  const shell = hubShell(ctx, 'market', 'Market', `Trade with other players · ${FEE_PCT}% fee on every sale`, 'scr-market');
  const econ = ctx.economy;
  void s0;
  if (!econ) {
    shell.body.append(econUnavailable('The Market'));
    return { el: shell.el, update: (s) => shell.update(s), destroy: () => shell.destroy() };
  }
  const releaseThumbs = ctx.thumbs.hold();
  // live listing updates only while this screen is open (they would share the line with a match)
  const unwatch = econ.watchMarket();

  let tab: Tab = 'browse';
  let fam: Any<FamilyId> = 'all';
  let slot: Any<CosmeticSlot> = 'all';
  let sort: Sort = 'low';

  // ---------------------------------------------------------------- filters (left)
  const tabs = segmented<Tab>({
    label: 'Market section',
    cls: 'seg-small mk-tabs',
    value: tab,
    options: [
      { value: 'browse', label: 'Browse', icon: 'market' },
      { value: 'mine', label: 'My Listings', icon: 'tag' },
      { value: 'sell', label: 'Sell', icon: 'pearl' },
    ],
    onChange: (t) => {
      tab = t;
      paint(true);
    },
  });
  const famSeg = segmented<Any<FamilyId>>({
    label: 'Family',
    cls: 'seg-tall mk-filter',
    value: fam,
    options: [{ value: 'all' as Any<FamilyId>, label: 'All families', icon: 'people' }, ...FAMILIES.map((f) => ({ value: f as Any<FamilyId>, label: FAMILY_DEFS[f].name, icon: f }))],
    onChange: (v) => {
      fam = v;
      paint(true);
    },
  });
  const slotSeg = segmented<Any<CosmeticSlot>>({
    label: 'Slot',
    cls: 'seg-grid mk-filter mk-slots',
    value: slot,
    options: [{ value: 'all' as Any<CosmeticSlot>, label: 'Any' }, ...COSMETIC_SLOTS.map((s) => ({ value: s as Any<CosmeticSlot>, label: SLOT_NAMES[s], icon: SLOT_ICON[s] }))],
    onChange: (v) => {
      slot = v;
      paint(true);
    },
  });
  const sortSeg = segmented<Sort>({
    label: 'Sort',
    cls: 'seg-small mk-sort',
    value: sort,
    options: [{ value: 'low', label: 'Price ↑', title: 'Cheapest first' }, { value: 'high', label: 'Price ↓', title: 'Priciest first' }, { value: 'new', label: 'Newest' }],
    onChange: (v) => {
      sort = v;
      paint(true);
    },
  });
  const refresh = iconButton('refresh', 'Refresh listings', () => econ.refreshMarket(), 'ghost small');
  const filters = h('aside', { class: 'mk-filters' },
    h('div', { class: 'mk-f-title', text: 'Family' }), famSeg.el,
    h('div', { class: 'mk-f-title', text: 'Slot' }), slotSeg.el,
    h('div', { class: 'mk-fee cloth' },
      h('span', { class: 'mk-fee-big', text: `${FEE_PCT}%` }),
      h('span', { class: 'mk-fee-text', text: 'Market fee on every sale. It is taken from the seller, so the buyer pays the listed price.' })));

  // ---------------------------------------------------------------- main
  const offline = h('div', { class: 'mk-offline cloth hidden' },
    icon('globe', 'mk-off-ico'),
    h('div', { class: 'mk-off-texts' },
      h('strong', { text: 'Connect to an online server to trade' }),
      h('span', { text: 'The Market runs on the game server, which settles every trade. Your offline locker cannot trade.' })),
    button('Play Online', () => a.go('online'), { cls: 'primary', icon: 'globe' }));
  const signingText = h('span', { text: 'Signing in to your account on this server...' });
  const signing = h('div', { class: 'info-note hidden' }, icon('clock'), signingText);
  // a new account can look but not trade yet: say so before the player tries
  const lockText = h('span');
  const locked = h('div', { class: 'info-note mk-locked hidden' }, icon('clock'), lockText);
  const count = h('span', { class: 'mk-count' });
  const bar = h('div', { class: 'mk-bar' }, tabs.el, count, h('span', { class: 'head-spacer' }), sortSeg.el, refresh);
  const grid = h('div', { class: 'mk-grid', role: 'list' });
  const empty = h('div', { class: 'empty-state hidden' });
  const main = h('section', { class: 'mk-main' }, bar, offline, signing, locked, grid, empty);
  shell.body.append(h('div', { class: 'mk-layout' }, filters, main));

  // ---------------------------------------------------------------- helpers
  const matches = (d: CosmeticDef | undefined): d is CosmeticDef =>
    !!d && (fam === 'all' || d.family === fam) && (slot === 'all' || d.slot === slot);
  const myId = () => ctx.econ()?.account?.id ?? '';
  const sorted = (ls: Listing[]) => {
    const out = [...ls];
    if (sort === 'new') out.sort((x, y) => y.created - x.created);
    else out.sort((x, y) => (sort === 'low' ? 1 : -1) * (priceValue(x) - priceValue(y)) || y.created - x.created);
    return out;
  };
  const priceValue = (l: Listing) => l.price.amount;

  let cards: { card: ItemCard; listing?: Listing; copy?: OwnedItem }[] = [];
  let lastKey = '';

  function listingCard(l: Listing, d: CosmeticDef, mine: boolean): ItemCard {
    const c = itemCard(ctx, d, () => (mine ? confirmCancel(l, d) : confirmBuy(l, d)), { compact: false });
    c.el.classList.add('mk-card');
    const seller = h('span', { class: 'mk-seller' }, icon('user'), h('span', { text: mine ? 'You' : l.sellerName }));
    seller.title = mine ? 'Your listing' : `Seller: ${l.sellerName}`;
    c.el.append(h('span', { class: 'mk-card-foot' }, seller, h('span', { class: 'mk-age', text: ago(l.created) })));
    if (mine) c.el.classList.add('mine');
    return c;
  }

  function paint(force = false): void {
    const e = ctx.econ();
    if (!e) return;
    const local = e.mode === 'local';
    offline.classList.toggle('hidden', !local);
    signing.classList.toggle('hidden', local || !!e.account);
    signingText.textContent = e.accountError ?? 'Signing in to your account on this server...';
    const lock = marketLockNote(e.mode, e.account);
    locked.classList.toggle('hidden', !lock);
    lockText.textContent = lock ?? '';
    const key = `${tab}|${fam}|${slot}|${sort}|${e.mode}|${e.listings.map((l) => l.id).join(',')}|${(e.account?.owned ?? []).map((o) => `${o.instance}${o.listed ?? ''}`).join(',')}`;
    if (!force && key === lastKey) {
      paintCards(e);
      return;
    }
    lastKey = key;
    cards = [];
    grid.replaceChildren();
    const me = myId();
    if (tab === 'browse' || tab === 'mine') {
      const ls = sorted(e.listings.filter((l) => (tab === 'mine' ? l.seller === me : true) && matches(cosmeticById(l.item))));
      for (const l of ls) {
        const d = cosmeticById(l.item)!;
        const c = listingCard(l, d, l.seller === me);
        cards.push({ card: c, listing: l });
        grid.append(c.el);
      }
      count.textContent = `${ls.length} listing${ls.length === 1 ? '' : 's'}`;
      empty.classList.toggle('hidden', ls.length > 0 || local);
      empty.replaceChildren(icon(tab === 'mine' ? 'tag' : 'market'), h('span', { text: tab === 'mine' ? 'You have nothing for sale. Open Sell to list an Epic item.' : e.listings.length ? 'Nothing matches these filters.' : 'No listings yet. Be the first to sell something.' }));
    } else {
      const copies = (e.account?.owned ?? []).filter((o) => marketTradable(cosmeticById(o.item)) && matches(cosmeticById(o.item)));
      for (const o of copies) {
        const d = cosmeticById(o.item)!;
        const c = itemCard(ctx, d, () => openSell(o, d));
        c.el.classList.add('mk-card', 'sell');
        cards.push({ card: c, copy: o });
        grid.append(c.el);
      }
      const n = (e.account?.owned ?? []).filter((o) => o.listed).length;
      count.textContent = `${copies.length} tradable · ${n}/${MAX_LISTINGS_PER_ACCOUNT} listed`;
      empty.classList.toggle('hidden', copies.length > 0);
      empty.replaceChildren(icon('pearl'), h('span', { text: `No tradable items. Epic items from the Store can be sold here; Common, Rare and starter items cannot.${isSteam() ? ' Premium items trade on the Steam Community Market.' : ''}` }));
    }
    // an empty grid would take the space and push the empty-state note to the bottom
    grid.classList.toggle('hidden', cards.length === 0);
    grid.scrollTop = 0;
    paintCards(e);
  }

  function paintCards(e: EconomyState): void {
    const pearls = e.account?.pearls ?? 0;
    const local = e.mode === 'local';
    for (const x of cards) {
      if (x.listing) {
        const l = x.listing;
        const mine = l.seller === myId();
        x.card.set({ owned: true, price: l.price });
        x.card.el.classList.toggle('cant', !mine && (local || pearls < l.price.amount));
      } else if (x.copy) {
        const o = x.copy;
        x.card.set({ owned: true, price: null, note: o.listed ? 'Listed for sale' : 'Click to sell' });
        x.card.el.classList.toggle('listed', !!o.listed);
      }
    }
  }

  // ---------------------------------------------------------------- dialogs
  function header(title: string, ico: 'market' | 'tag' | 'pearl', close: () => void): HTMLElement {
    return h('header', { class: 'panel-head' }, icon(ico, 'wp-head-ico'), h('h2', { class: 'panel-title', text: title }), h('span', { class: 'head-spacer' }), iconButton('close', 'Close', () => close(), 'ghost'));
  }
  function itemHead(d: CosmeticDef, extra?: string): HTMLElement {
    return h('div', { class: 'mk-d-item' }, itemArt(ctx, d, 'big'),
      h('div', { class: 'mk-d-texts' },
        h('div', { class: 'mk-d-name', text: d.name }),
        h('div', { class: 'mk-d-meta' }, rarityPill(d), h('span', { class: 'lk-d-slot' }, icon(d.family), h('span', { text: FAMILY_DEFS[d.family].name })), h('span', { class: 'lk-d-slot' }, icon(SLOT_ICON[d.slot]), h('span', { text: SLOT_NAMES[d.slot] }))),
        h('div', { class: 'mk-d-blurb', text: extra ?? d.blurb })));
  }

  function confirmBuy(l: Listing, d: CosmeticDef): void {
    const e = ctx.econ();
    if (!e) return;
    let close = () => {};
    const pearls = e.account?.pearls ?? 0;
    const local = e.mode === 'local';
    const short = l.price.amount - pearls;
    const why = local ? 'Connect to an online server to trade.' : short > 0 ? `You need ${fmtPearls(short)} more Pearls.` : '';
    const buy = button(`Buy for ${fmtPrice(l.price)}`, () => {
      ctx.buyListing(l);
      close();
    }, { cls: 'primary buy-btn', icon: 'pearl', disabled: !!why || e.busy });
    const body = h('div', { class: 'panel-body mk-dialog' },
      itemHead(d),
      h('div', { class: 'mk-d-rows' },
        row('Seller', l.sellerName),
        row('Listed', ago(l.created)),
        row('Price', fmtPrice(l.price), 'strong'),
        !local ? row('Your Pearls after', fmtPearls(Math.max(0, pearls - l.price.amount))) : null),
      why ? h('p', { class: 'err-box', text: why }) : null);
    const dlg = h('div', { class: 'panel market-dialog' }, header('Buy from the Market', 'market', () => close()), body,
      h('footer', { class: 'panel-foot' }, h('span', { class: 'head-spacer' }), button('Cancel', () => close(), { cls: 'ghost' }), buy));
    close = ctx.modal(dlg, { label: 'Buy listing' });
  }

  function confirmCancel(l: Listing, d: CosmeticDef): void {
    let close = () => {};
    const dlg = h('div', { class: 'panel market-dialog' }, header('Your listing', 'tag', () => close()),
      h('div', { class: 'panel-body mk-dialog' }, itemHead(d),
        h('div', { class: 'mk-d-rows' }, row('Price', fmtPrice(l.price), 'strong'), row('You receive', `${fmtPearls(sellerReceives(l.price))} Pearls`), row('Listed', ago(l.created)))),
      h('footer', { class: 'panel-foot' }, h('span', { class: 'head-spacer' }), button('Keep it listed', () => close(), { cls: 'ghost' }),
        button('Cancel listing', () => {
          ctx.noteCancel(l.id, l.instance);
          econ!.cancelListing(l.id);
          close();
        }, { cls: 'danger', icon: 'close' })));
    close = ctx.modal(dlg, { label: 'Your listing' });
  }

  function openSell(o: OwnedItem, d: CosmeticDef): void {
    const e = ctx.econ();
    if (!e) return;
    if (o.listed) {
      const l = e.listings.find((x) => x.id === o.listed || x.instance === o.instance);
      if (l) confirmCancel(l, d);
      else ctx.toast('That copy is already listed. Open My Listings to cancel it.', 'info');
      return;
    }
    let close = () => {};
    const local = e.mode === 'local';
    const pearlTrade = marketTradable(d);
    const listedNow = (e.account?.owned ?? []).filter((x) => x.listed).length;
    const input = h('input', { class: 'text-in mk-price-in', type: 'number', inputmode: 'numeric', min: LIST_LIMITS.min, max: LIST_LIMITS.max, step: 1, 'aria-label': 'Price in Pearls' });
    input.value = String(suggestPrice(d));
    const fee = h('span', { class: 'mk-fee-num' });
    const get = h('span', { class: 'mk-get-num' });
    const err = h('p', { class: 'err-box hidden', role: 'alert' });
    const list = button('List for sale', () => {
      const v = Number(input.value);
      if (!valid(v)) return;
      econ!.listForSale(o.instance, v);
      ctx.toast(`${d.name} listed for ${fmtPearls(v)} Pearls`, 'good');
      close();
    }, { cls: 'primary', icon: 'tag' });
    const valid = (v: number): boolean => {
      let why = '';
      if (local) why = 'Connect to an online server to trade.';
      else if (!pearlTrade) why = 'Only Epic items trade for Pearls here.';
      else if (listedNow >= MAX_LISTINGS_PER_ACCOUNT) why = `You already have ${MAX_LISTINGS_PER_ACCOUNT} items listed. Cancel one first.`;
      else if (!Number.isInteger(v)) why = 'Use a whole number of Pearls.';
      else if (v < LIST_LIMITS.min) why = `The lowest price is ${fmtPearls(LIST_LIMITS.min)} Pearls.`;
      else if (v > LIST_LIMITS.max) why = `The highest price is ${fmtPearls(LIST_LIMITS.max)} Pearls.`;
      err.textContent = why;
      err.classList.toggle('hidden', !why);
      list.disabled = !!why;
      return !why;
    };
    const update = () => {
      const v = Math.floor(Number(input.value) || 0);
      const ok = Number.isFinite(v) && v > 0;
      fee.textContent = ok ? `-${fmtPearls(marketFee({ amount: v }))}` : '-';
      get.textContent = ok ? fmtPearls(sellerReceives({ amount: v })) : '-';
      valid(Number(input.value));
    };
    input.addEventListener('input', update);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !list.disabled) list.click();
    });
    const nudge = (k: number) => {
      const v = Math.max(LIST_LIMITS.min, Math.min(LIST_LIMITS.max, Math.round((Number(input.value) || 0) * k)));
      input.value = String(v);
      update();
    };
    const body = h('div', { class: 'panel-body mk-dialog' },
      itemHead(d),
      h('label', { class: 'mk-price' },
        h('span', { class: 'mk-price-label', text: 'Your price' }),
        h('span', { class: 'mk-price-row' }, icon('pearl', 'mk-price-ico'), input, h('span', { class: 'mk-price-cur', text: 'Pearls' }),
          button('-10%', () => nudge(0.9), { cls: 'ghost small' }), button('+10%', () => nudge(1.1), { cls: 'ghost small' }))),
      h('div', { class: 'mk-d-rows' },
        h('div', { class: 'mk-row' }, h('span', { text: `Market fee (${FEE_PCT}%)` }), fee),
        h('div', { class: 'mk-row strong' }, h('span', { text: 'You receive' }), h('span', { class: 'mk-get' }, icon('pearl'), get))),
      h('p', { class: 'muted mk-limits', text: `Prices from ${fmtPearls(LIST_LIMITS.min)} to ${fmtPearls(LIST_LIMITS.max)} Pearls. While it is listed you cannot wear it. Cancel any time to get it back.` }),
      err);
    const dlg = h('div', { class: 'panel market-dialog' }, header('Sell an item', 'pearl', () => close()), body,
      h('footer', { class: 'panel-foot' }, h('span', { class: 'head-spacer' }), button('Cancel', () => close(), { cls: 'ghost' }), list));
    close = ctx.modal(dlg, { label: 'Sell an item' });
    update();
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  function row(label: string, value: string, cls = ''): HTMLElement {
    return h('div', { class: `mk-row ${cls}`.trim() }, h('span', { text: label }), h('span', { class: 'mk-row-v', text: value }));
  }

  const unsub = ctx.onEcon(() => paint());
  paint(true);

  return {
    el: shell.el,
    update(s: AppState) {
      shell.update(s);
    },
    destroy() {
      unsub();
      unwatch();
      shell.destroy();
      releaseThumbs();
    },
  };
}
