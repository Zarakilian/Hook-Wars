// The Bait & Tackle shop (B): two tabs so nothing needs scrolling at 1280x720. Upgrades: hook
// upgrades with level pips, current and next values and costs. Items: your four slots (sell) over
// a two-column grid of items with buy buttons that explain why they are disabled. The panel sits on
// your own team's side so it never covers the enemy bank.
import { HOOK_LEVELS, ITEM_IDS, ITEMS, MAX_UPGRADE, UPGRADE_COST } from '../../../shared/constants.ts';
import { UPGRADE_STATS, type ItemId, type Team, type UpgradeStat, type YouSnap } from '../../../shared/types.ts';
import { h, noFocus, pulse } from '../dom.ts';
import { icon, setIcon, type IconId } from '../icons.ts';
import type { AppActions } from '../types.ts';

const STAT: Record<UpgradeStat, { name: string; icon: IconId; unit: (v: number) => string; line: string }> = {
  damage: { name: 'Hook Damage', icon: 'wallop', unit: (v) => `${v}`, line: 'Damage when your hook lands' },
  range: { name: 'Hook Range', icon: 'target', unit: (v) => `${v} m`, line: 'How far the chain reaches' },
  speed: { name: 'Hook Speed', icon: 'haste', unit: (v) => `${v} m/s`, line: 'Faster hooks are harder to dodge' },
  width: { name: 'Hook Width', icon: 'hook', unit: (v) => `${v.toFixed(2)} m`, line: 'A fatter hook clips more targets' },
};

interface UpRow {
  pips: HTMLElement[];
  now: HTMLElement;
  next: HTMLElement;
  btn: HTMLButtonElement;
  btnText: HTMLElement;
}

interface ItemRow {
  row: HTMLElement;
  btn: HTMLButtonElement;
  btnText: HTMLElement;
  why: HTMLElement;
  owned: HTMLElement;
}

interface SellSlot {
  el: HTMLElement;
  ico: SVGSVGElement;
  name: HTMLElement;
  btn: HTMLButtonElement;
  id: string;
}

function refundOf(id: ItemId, charges: number): number {
  const def = ITEMS[id];
  return def.consumable ? Math.floor((def.cost / 2) * (charges / Math.max(1, def.charges))) : Math.floor(def.cost / 2);
}

function hudButton(cls: string, onClick: () => void, ...children: Node[]): HTMLButtonElement {
  const b = h('button', { class: cls, type: 'button', tabindex: -1 }, ...children);
  noFocus(b);
  b.addEventListener('click', () => {
    b.blur();
    onClick();
  });
  return b;
}

export class Shop {
  readonly el: HTMLElement;
  private readonly gold: HTMLElement;
  private readonly ups = new Map<UpgradeStat, UpRow>();
  private readonly items = new Map<ItemId, ItemRow>();
  private readonly sells: SellSlot[] = [];
  private key = '';
  private you: YouSnap | null = null;
  private readonly actions: AppActions;
  private tab: 'up' | 'items' = 'up';
  private readonly tabBtns: Record<'up' | 'items', HTMLButtonElement>;
  private readonly pages: Record<'up' | 'items', HTMLElement>;
  private readonly tabBadge: HTMLElement;
  private side: Team | -1 = -1;

  constructor(actions: AppActions, close: () => void) {
    this.actions = actions;
    this.gold = h('span', { class: 'shop-gold-num', text: '0' });
    const head = h('div', { class: 'shop-head' },
      h('div', { class: 'shop-sign' }, h('span', { class: 'shop-sign-top', text: 'Bait & Tackle' }), h('span', { class: 'shop-sign-sub', text: 'Upgrades and odd gadgets' })),
      h('div', { class: 'shop-gold' }, icon('coin'), this.gold),
      hudButton('shop-x', close, icon('close')));

    // upgrades
    const upList = h('div', { class: 'shop-list' });
    for (const st of UPGRADE_STATS) {
      const info = STAT[st];
      const pips = Array.from({ length: MAX_UPGRADE }, () => h('span', { class: 'pip' }));
      const now = h('span', { class: 'up-now' });
      const next = h('span', { class: 'up-next' });
      const btnText = h('span', {});
      const btn = hudButton('shop-buy', () => this.tryUpgrade(st, btn), icon('coin', 'sb-coin'), btnText);
      upList.append(h('div', { class: 'shop-row up-row' },
        h('span', { class: 'sr-ico' }, icon(info.icon)),
        h('span', { class: 'sr-main' },
          h('span', { class: 'sr-name', text: info.name }),
          h('span', { class: 'up-pips' }, ...pips),
          h('span', { class: 'up-vals' }, now, h('span', { class: 'up-arrow', text: '→' }), next)),
        btn));
      this.ups.set(st, { pips, now, next, btn, btnText });
    }

    // your items (sell)
    const sellRow = h('div', { class: 'sell-row' });
    for (let i = 0; i < 4; i++) {
      const ico = icon('pie', 'ss-ico');
      const name = h('span', { class: 'ss-name' });
      const btn = hudButton('ss-sell', () => {
        this.actions.uiSound('click');
        this.actions.sell(i);
      }, h('span', {}));
      const el = h('div', { class: 'sell-slot empty' }, h('span', { class: 'ss-key', text: String(i + 1) }), ico, name, btn);
      sellRow.append(el);
      this.sells.push({ el, ico, name, btn, id: '#' });
    }

    // items
    const itemList = h('div', { class: 'items-grid' });
    for (const id of ITEM_IDS) {
      const def = ITEMS[id];
      const btnText = h('span', { text: String(def.cost) });
      const why = h('span', { class: 'si-why' });
      const owned = h('span', { class: 'si-owned' });
      const btn = hudButton('shop-buy', () => this.tryBuy(id, btn), icon('coin', 'sb-coin'), btnText);
      const row = h('div', { class: `shop-row item-row ${def.consumable ? 'consumable' : ''}`, title: `${def.name}: ${def.blurb}` },
        h('span', { class: 'sr-ico' }, icon(id)),
        h('span', { class: 'sr-main' },
          h('span', { class: 'sr-name', text: def.name }),
          h('span', { class: 'sr-top' }, def.consumable ? h('span', { class: 'si-tag', text: `x${def.charges} · max ${def.maxCharges}` }) : h('span', { class: 'si-tag passive', text: 'passive' }), owned)),
        btn,
        h('span', { class: 'sr-blurb', text: def.blurb }),
        why);
      itemList.append(row);
      this.items.set(id, { row, btn, btnText, why, owned });
    }

    const tabBtn = (k: 'up' | 'items', label: string, ico: IconId, extra?: HTMLElement) => {
      const b = hudButton('shop-tab', () => {
        if (this.tab === k) return;
        this.actions.uiSound('click');
        this.setTab(k);
      }, icon(ico, 'stab-ico'), h('span', { text: label }));
      if (extra) b.append(extra);
      return b;
    };
    this.tabBadge = h('span', { class: 'stab-badge hidden' });
    this.tabBtns = { up: tabBtn('up', 'Hook Upgrades', 'hook'), items: tabBtn('items', 'Items', 'pie', this.tabBadge) };
    this.pages = {
      up: h('div', { class: 'shop-page' }, upList),
      items: h('div', { class: 'shop-page' }, sellRow, itemList),
    };
    this.el = h('div', { class: 'shop hidden', role: 'dialog', 'aria-label': 'Shop' },
      head,
      h('div', { class: 'shop-tabs', role: 'tablist' }, this.tabBtns.up, this.tabBtns.items),
      h('div', { class: 'shop-body' }, this.pages.up, this.pages.items),
      h('div', { class: 'shop-foot' }, h('kbd', { class: 'keycap', text: 'B' }), h('span', { text: 'close' }), h('span', { class: 'dot-sep', text: '·' }), h('span', { text: 'Right-click an item slot to sell it' })));
    this.setTab('up');
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reset(): void {
    this.key = '';
    this.you = null;
  }

  private setTab(k: 'up' | 'items'): void {
    this.tab = k;
    for (const t of ['up', 'items'] as const) {
      this.tabBtns[t].classList.toggle('on', t === k);
      this.tabBtns[t].setAttribute('aria-selected', t === k ? 'true' : 'false');
      this.pages[t].classList.toggle('hidden', t !== k);
    }
  }

  /** Anchor the panel on your own bank: left for Red Tide (west), right for Blue Gill (east). */
  setSide(team: Team | -1): void {
    if (team === this.side) return;
    this.side = team;
    this.el.classList.toggle('side-left', team === 0);
    this.el.classList.toggle('side-right', team !== 0);
  }

  private tryUpgrade(st: UpgradeStat, btn: HTMLButtonElement): void {
    if (btn.classList.contains('no')) {
      pulse(btn, 'deny');
      return;
    }
    this.actions.upgrade(st);
  }

  private tryBuy(id: ItemId, btn: HTMLButtonElement): void {
    if (btn.classList.contains('no')) {
      pulse(btn, 'deny');
      return;
    }
    this.actions.buy(id);
  }

  /** Repaint when gold, upgrades or items change (cheap no-op otherwise). */
  update(you: YouSnap | null): void {
    if (!you) return;
    const key = `${you.gold}|${you.up.damage}${you.up.range}${you.up.speed}${you.up.width}|${you.items.map((s) => (s ? `${s.id}${s.charges}` : '-')).join(',')}`;
    if (key === this.key) return;
    this.key = key;
    this.you = you;
    this.gold.textContent = String(you.gold);

    for (const st of UPGRADE_STATS) {
      const r = this.ups.get(st)!;
      const lvl = you.up[st];
      r.pips.forEach((p, i) => p.classList.toggle('on', i < lvl));
      r.now.textContent = STAT[st].unit(HOOK_LEVELS[st][lvl]);
      const max = lvl >= MAX_UPGRADE;
      r.next.textContent = max ? 'MAX' : STAT[st].unit(HOOK_LEVELS[st][lvl + 1]);
      const cost = max ? 0 : UPGRADE_COST[lvl];
      r.btnText.textContent = max ? 'MAX' : String(cost);
      const no = max || you.gold < cost;
      r.btn.classList.toggle('no', no);
      r.btn.classList.toggle('maxed', max);
      r.btn.title = max ? 'Fully upgraded' : no ? `Need ${cost - you.gold} more gold` : `Upgrade for ${cost} gold`;
    }

    const free = you.items.some((s) => s === null);
    let canBuy = 0;
    for (const id of ITEM_IDS) {
      const def = ITEMS[id];
      const r = this.items.get(id)!;
      const slot = you.items.find((s) => s && s.id === id) ?? null;
      let why = '';
      if (!def.consumable && slot) why = 'Owned';
      else if (def.consumable && slot && slot.charges >= def.maxCharges) why = 'Max charges';
      else if (!slot && !free) why = 'No free slot: sell something';
      else if (you.gold < def.cost) why = `Need ${def.cost - you.gold} more`;
      r.why.textContent = why;
      r.row.classList.toggle('has-why', why !== '');
      r.btn.classList.toggle('no', why !== '');
      r.row.classList.toggle('owned', !!slot);
      r.owned.textContent = slot ? (def.consumable ? `have ${slot.charges}` : 'owned') : '';
      r.btn.title = why || `Buy for ${def.cost} gold`;
      if (!why) canBuy++;
    }

    this.tabBadge.textContent = String(canBuy);
    this.tabBadge.classList.toggle('hidden', canBuy === 0);
    you.items.forEach((s, i) => {
      const ss = this.sells[i];
      const k = s ? `${s.id}:${s.charges}` : '';
      if (k === ss.id) return;
      ss.id = k;
      ss.el.classList.toggle('empty', !s);
      if (!s) {
        ss.name.textContent = 'Empty';
        (ss.btn.firstChild as HTMLElement).textContent = '';
        ss.btn.disabled = true;
        return;
      }
      setIcon(ss.ico, s.id);
      ss.name.textContent = ITEMS[s.id].consumable ? `${ITEMS[s.id].name} x${s.charges}` : ITEMS[s.id].name;
      (ss.btn.firstChild as HTMLElement).textContent = `Sell +${refundOf(s.id, s.charges)}`;
      ss.btn.disabled = false;
    });
  }
}
