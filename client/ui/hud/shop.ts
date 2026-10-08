// The Bait & Tackle shop (B): hook upgrades with level pips, current and next values and costs;
// items with descriptions, buy buttons that explain why they are disabled, and sell buttons.
import { HOOK_LEVELS, ITEM_IDS, ITEMS, MAX_UPGRADE, UPGRADE_COST } from '../../../shared/constants.ts';
import { UPGRADE_STATS, type ItemId, type UpgradeStat, type YouSnap } from '../../../shared/types.ts';
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
    const itemList = h('div', { class: 'shop-list items-list' });
    for (const id of ITEM_IDS) {
      const def = ITEMS[id];
      const btnText = h('span', { text: String(def.cost) });
      const why = h('span', { class: 'si-why' });
      const owned = h('span', { class: 'si-owned' });
      const btn = hudButton('shop-buy', () => this.tryBuy(id, btn), icon('coin', 'sb-coin'), btnText);
      const row = h('div', { class: `shop-row item-row ${def.consumable ? 'consumable' : ''}` },
        h('span', { class: 'sr-ico' }, icon(id)),
        h('span', { class: 'sr-main' },
          h('span', { class: 'sr-top' }, h('span', { class: 'sr-name', text: def.name }), def.consumable ? h('span', { class: 'si-tag', text: `x${def.charges} · max ${def.maxCharges}` }) : h('span', { class: 'si-tag passive', text: 'passive' }), owned),
          h('span', { class: 'sr-blurb', text: def.blurb }),
          why),
        btn);
      itemList.append(row);
      this.items.set(id, { row, btn, btnText, why, owned });
    }

    this.el = h('div', { class: 'shop hidden', role: 'dialog', 'aria-label': 'Shop' },
      head,
      h('div', { class: 'shop-body' },
        h('div', { class: 'shop-section' }, h('div', { class: 'shop-title', text: 'Hook upgrades' }), upList),
        h('div', { class: 'shop-section' }, h('div', { class: 'shop-title', text: 'Your items' }), sellRow),
        h('div', { class: 'shop-section' }, h('div', { class: 'shop-title', text: 'Items' }), itemList)),
      h('div', { class: 'shop-foot' }, h('kbd', { class: 'keycap', text: 'B' }), h('span', { text: 'close' }), h('span', { class: 'dot-sep', text: '·' }), h('span', { text: 'Right-click an item slot to sell it' })));
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reset(): void {
    this.key = '';
    this.you = null;
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
      r.btn.classList.toggle('no', why !== '');
      r.row.classList.toggle('owned', !!slot);
      r.owned.textContent = slot ? (def.consumable ? `have ${slot.charges}` : 'owned') : '';
      r.btn.title = why || `Buy for ${def.cost} gold`;
    }

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
