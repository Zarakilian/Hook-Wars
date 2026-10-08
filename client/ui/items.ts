// Item art and item cards shared by the Locker, Store and Market. Cards are built once and updated
// in place with set(), so hover and focus survive re-renders.
import type { CosmeticDef } from '../../shared/cosmetics.ts';
import type { UiCtx } from './ctx.ts';
import { h } from './dom.ts';
import { fmtPearls, RARITY_INFO, SLOT_ICON } from './econ.ts';
import { icon } from './icons.ts';
import { clickSound } from './widgets.ts';

/** Slot glyph now, the 3D render when it is ready. */
export function itemArt(ctx: UiCtx, def: CosmeticDef | undefined, cls = ''): HTMLElement {
  const el = h('span', { class: `item-art ${cls}`.trim() });
  if (!def) {
    el.append(icon('close', 'ia-glyph'));
    return el;
  }
  el.style.setProperty('--rc', RARITY_INFO[def.rarity].color);
  el.style.setProperty('--rg', RARITY_INFO[def.rarity].glow);
  el.append(h('span', { class: 'ia-halo', 'aria-hidden': 'true' }), icon(SLOT_ICON[def.slot], 'ia-glyph'));
  const show = (url: string | null) => {
    if (!url) return;
    const img = h('img', { class: 'ia-img', alt: '', src: url, draggable: 'false' });
    el.append(img);
    el.classList.add('has-img');
  };
  const cached = ctx.thumbs.peek(def.id);
  if (cached !== undefined) show(cached);
  else ctx.thumbs.request(def.id, show);
  return el;
}

export interface CardState {
  owned: boolean;
  equipped?: boolean;
  selected?: boolean;
  trying?: boolean;
  /** extra line under the name (serial, seller...) */
  note?: string;
  /** override the price area */
  price?: { cur: 'pearls' | 'usdc'; amount: number } | null;
}

export interface ItemCard {
  el: HTMLButtonElement;
  def: CosmeticDef;
  set(st: CardState): void;
}

export function itemCard(ctx: UiCtx, def: CosmeticDef, onClick: () => void, o: { onHover?: (on: boolean) => void; compact?: boolean } = {}): ItemCard {
  const r = RARITY_INFO[def.rarity];
  const status = h('span', { class: 'ic-status' });
  const note = h('span', { class: 'ic-note' });
  const flag = h('span', { class: 'ic-flag' });
  const el = h('button', { class: `item-card r-${def.rarity} ${o.compact ? 'compact' : ''}`.trim(), type: 'button', style: `--rc:${r.color};--rg:${r.glow}`, title: `${def.name}: ${def.blurb}` },
    h('span', { class: 'ic-art-wrap' }, itemArt(ctx, def), flag),
    h('span', { class: 'ic-body' },
      h('span', { class: 'ic-rarity', text: r.name }),
      h('span', { class: 'ic-name', text: def.name }),
      note,
      status));
  if (def.rarity === 'limited') el.append(h('span', { class: 'ic-limited' }, icon('sparkle'), h('span', { text: `Limited · ${def.supply ?? '?'}` })));
  el.addEventListener('click', () => {
    clickSound();
    onClick();
  });
  if (o.onHover) {
    el.addEventListener('pointerenter', () => o.onHover?.(true));
    el.addEventListener('pointerleave', () => o.onHover?.(false));
  }
  let lastKey = '';
  return {
    el,
    def,
    set(st: CardState) {
      const key = `${st.owned}|${st.equipped}|${st.selected}|${st.trying}|${st.note}|${st.price?.cur}${st.price?.amount}`;
      if (key === lastKey) return;
      lastKey = key;
      el.classList.toggle('owned', st.owned);
      el.classList.toggle('locked', !st.owned);
      el.classList.toggle('equipped', !!st.equipped);
      el.classList.toggle('selected', !!st.selected);
      el.classList.toggle('trying', !!st.trying);
      el.setAttribute('aria-pressed', st.selected ? 'true' : 'false');
      note.textContent = st.note ?? '';
      note.classList.toggle('hidden', !st.note);
      flag.replaceChildren();
      if (st.equipped) flag.append(icon('check'));
      else if (!st.owned) flag.append(icon('padlock'));
      flag.className = `ic-flag ${st.equipped ? 'on' : !st.owned ? 'lock' : ''}`;
      status.replaceChildren();
      const price = st.price === undefined ? (st.owned ? null : def.usdc !== undefined ? { cur: 'usdc' as const, amount: def.usdc } : def.pearls !== undefined ? { cur: 'pearls' as const, amount: def.pearls } : null) : st.price;
      if (st.equipped) status.append(h('span', { class: 'ic-eq', text: 'Equipped' }));
      else if (price) {
        status.append(icon(price.cur === 'usdc' ? 'usdc' : 'pearl', 'ic-cur'), h('span', { class: 'ic-price', text: price.cur === 'usdc' ? price.amount.toFixed(2) : fmtPearls(price.amount) }));
        if (price.cur === 'usdc') status.append(h('span', { class: 'ic-cur-name', text: 'USDC' }));
      }
      else if (st.owned) status.append(h('span', { class: 'ic-own', text: def.rarity === 'default' ? 'Starter' : 'Owned' }));
    },
  };
}

/** Rarity pill. */
export function rarityPill(def: CosmeticDef): HTMLElement {
  const r = RARITY_INFO[def.rarity];
  return h('span', { class: `rarity-pill r-${def.rarity}`, style: `--rc:${r.color}`, text: r.name });
}
