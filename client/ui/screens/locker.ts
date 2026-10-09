// Locker: a big 3D showcase of your character, family tabs, slot tabs and an item grid per slot.
// Owned items equip on click (economy.equip, and the saved profile stays in step); locked items are
// tried on in the preview only, with a buy button right there. Nothing unowned is ever saved.
import { FAMILY_DEFS } from '../../../shared/constants.ts';
import { COSMETIC_SLOTS, cosmeticById, DEFAULT_LOADOUT, ownedLoadout, SLOT_NAMES, type CosmeticDef, type CosmeticSlot, type Loadout } from '../../../shared/cosmetics.ts';
import { isSteam } from '../../platform.ts';
import { FAMILIES, type FamilyId, type Team } from '../../../shared/types.ts';
import { TEAM_COLORS } from '../../render/contracts.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { catalogFor, fmtPearls, premiumOffer, SLOT_ICON, sourceLine } from '../econ.ts';
import { icon, type IconId } from '../icons.ts';
import { itemArt, itemCard, rarityPill, type ItemCard } from '../items.ts';
import { navHint } from '../nav.ts';
import { hubShell } from '../shell.ts';
import type { AppState } from '../types.ts';
import { button, clickSound, segmented, setButtonLabel } from '../widgets.ts';
import { canUnequip, slotCanBeBare, wornLoadout } from '../wear.ts';

export function buildLocker(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;
  const shell = hubShell(ctx, 'locker', 'Locker', 'Try on, buy and equip', 'scr-locker');
  const releaseThumbs = ctx.thumbs.hold();

  let family: FamilyId = navHint.lockerFamily ?? s0.profile.family;
  let slot: CosmeticSlot = 'head';
  let team: Team = s0.settings.soloTeam;
  let tryOn: Loadout = {};
  let selected: string | null = null; // item id ('' = bare) shown in the detail panel
  const buyThenEquip = new Set<string>();
  if (navHint.lockerItem) {
    const d = cosmeticById(navHint.lockerItem);
    if (d) {
      family = d.family;
      slot = d.slot;
      selected = d.id;
      if (!ctx.owns(d.id)) tryOn[d.slot] = d.id;
    }
  }
  navHint.lockerFamily = null;
  navHint.lockerItem = null;

  /** What this family wears right now (owned items only; a missing hook is the default hook it holds). */
  const equipped = (f: FamilyId): Loadout => {
    const e = ctx.econ();
    const p = ctx.get().profile;
    const raw = e?.account?.loadouts[f] ?? (f === p.family ? p.loadout : DEFAULT_LOADOUT[f]);
    return wornLoadout(f, raw, ctx.owns);
  };
  const lookFor = (f: FamilyId): Loadout => {
    const out: Loadout = { ...equipped(f) };
    for (const sl of COSMETIC_SLOTS) {
      if (!(sl in tryOn)) continue;
      const id = tryOn[sl];
      if (id) out[sl] = id;
      else delete out[sl];
    }
    return out;
  };

  function doEquip(f: FamilyId, loadout: Loadout): void {
    const wear = ownedLoadout(loadout, ctx.owns);
    ctx.economy?.equip(f, wear);
    const p = ctx.get().profile;
    if (f === p.family) a.saveProfile({ ...p, loadout: wear });
    a.uiSound('equip');
    ctx.preview.play('celebrate');
  }

  // ---------------------------------------------------------------- left: family tabs + stage
  const famBtns = new Map<FamilyId, { b: HTMLButtonElement; main: HTMLElement }>();
  const famTabs = h('div', { class: 'lk-fams', role: 'tablist', 'aria-label': 'Family' });
  for (const f of FAMILIES) {
    const main = h('span', { class: 'lkf-main', title: 'You play as this family' }, icon('star'));
    const b = h('button', { class: 'lk-fam', type: 'button', role: 'tab' }, icon(f, 'lkf-ico'), h('span', { class: 'lkf-texts' }, h('span', { class: 'lkf-name', text: FAMILY_DEFS[f].name }), h('span', { class: 'lkf-passive', text: FAMILY_DEFS[f].passive })), main);
    b.addEventListener('click', () => {
      if (f === family) return;
      clickSound();
      family = f;
      tryOn = {};
      selected = null;
      rebuildGrid();
      paint();
    });
    famBtns.set(f, { b, main });
    famTabs.append(b);
  }
  const stage = h('div', { class: 'lk-stage' });
  const teamSeg = segmented<Team>({
    label: 'Team colours',
    cls: 'seg-small lk-team',
    value: team,
    options: ([0, 1] as Team[]).map((t) => ({ value: t, label: TEAM_COLORS[t].name, cls: `team-${t}`, icon: 'flag' })),
    onChange: (t) => {
      team = t;
      paintPreview(null);
    },
  });
  const tryBadge = h('div', { class: 'lk-trying hidden' }, icon('eye'), h('span', { text: 'Trying on' }));
  const famTitle = h('div', { class: 'lk-fam-title' });
  const famBlurb = h('div', { class: 'lk-fam-blurb' });
  const playAs = button('Play as this family', () => {
    const p = ctx.get().profile;
    a.saveProfile({ ...p, family, loadout: equipped(family) });
    a.uiSound('equip');
    ctx.toast(`You now play as the ${FAMILY_DEFS[family].name}`, 'good');
  }, { cls: 'primary', icon: 'star' });
  const mainBadge = h('span', { class: 'lk-main-badge' }, icon('star'), h('span', { text: 'Your main' }));
  const revert = button('Take it all off', () => {
    tryOn = {};
    selected = null;
    paint();
  }, { cls: 'ghost small', icon: 'refresh' });
  const reset = button('Default look', () => {
    tryOn = {};
    doEquip(family, DEFAULT_LOADOUT[family]);
    paint();
  }, { cls: 'ghost small', icon: 'dice', title: 'Wear the family starter set' });
  const left = h('section', { class: 'lk-left' },
    famTabs,
    h('div', { class: 'lk-stage-wrap' }, stage, h('div', { class: 'lk-stage-top' }, teamSeg.el, tryBadge), h('div', { class: 'lk-hint', text: 'Drag to spin' })),
    h('div', { class: 'lk-fam-info' }, h('div', { class: 'lk-fam-texts' }, famTitle, famBlurb), mainBadge, playAs),
    h('div', { class: 'lk-left-foot' }, reset, revert));

  // ---------------------------------------------------------------- right: slot tabs, grid, detail
  const slotBtns = new Map<CosmeticSlot, { b: HTMLButtonElement; worn: HTMLElement }>();
  const slotTabs = h('div', { class: 'lk-slots', role: 'tablist', 'aria-label': 'Slot' });
  for (const sl of COSMETIC_SLOTS) {
    const worn = h('span', { class: 'lks-worn' });
    const b = h('button', { class: 'lk-slot', type: 'button', role: 'tab' }, icon(SLOT_ICON[sl], 'lks-ico'), h('span', { class: 'lks-texts' }, h('span', { class: 'lks-name', text: SLOT_NAMES[sl] }), worn));
    b.addEventListener('click', () => {
      if (sl === slot) return;
      clickSound();
      slot = sl;
      selected = null;
      ctx.preview.focus(slot);
      rebuildGrid();
      paint();
    });
    slotBtns.set(sl, { b, worn });
    slotTabs.append(b);
  }
  const grid = h('div', { class: 'lk-grid', role: 'list' });
  let cards: ItemCard[] = [];
  const bareCard = h('button', { class: 'item-card bare', type: 'button', title: 'Leave this slot empty' },
    h('span', { class: 'ic-art-wrap' }, h('span', { class: 'item-art' }, icon('close', 'ia-glyph'))),
    h('span', { class: 'ic-body' }, h('span', { class: 'ic-rarity', text: 'Empty' }), h('span', { class: 'ic-name', text: 'Bare' }), h('span', { class: 'ic-status' }, h('span', { class: 'ic-own', text: 'Show the base' }))));
  bareCard.addEventListener('click', () => {
    clickSound();
    selected = '';
    delete tryOn[slot];
    const lo = { ...equipped(family) };
    delete lo[slot];
    doEquip(family, lo);
    paint();
  });

  const onCard = (def: CosmeticDef) => {
    selected = def.id;
    if (ctx.owns(def.id)) {
      delete tryOn[def.slot];
      const lo = { ...equipped(family), [def.slot]: def.id };
      doEquip(family, lo);
    } else {
      tryOn[def.slot] = def.id;
      paintPreview('celebrate');
    }
    paint();
  };

  function rebuildGrid(): void {
    cards = catalogFor(family, slot).map((def) => itemCard(ctx, def, () => onCard(def)));
    // no Bare card for the hook: an empty hands slot still holds the default hook
    grid.replaceChildren(...(slotCanBeBare(slot) ? [bareCard] : []), ...cards.map((c) => c.el));
    grid.scrollTop = 0;
  }

  // detail panel
  const dArt = h('div', { class: 'lk-d-art' });
  const dName = h('div', { class: 'lk-d-name' });
  const dMeta = h('div', { class: 'lk-d-meta' });
  const dBlurb = h('div', { class: 'lk-d-blurb' });
  const dSource = h('div', { class: 'lk-d-source' });
  const dActions = h('div', { class: 'lk-d-actions' });
  const detail = h('div', { class: 'lk-detail cloth' }, dArt, h('div', { class: 'lk-d-texts' }, dName, dMeta, dBlurb, dSource), dActions);

  const right = h('section', { class: 'lk-right' }, slotTabs, grid, detail);
  shell.body.append(h('div', { class: 'lk-layout' }, left, right));

  // ---------------------------------------------------------------- painting
  let lastLookKey = '';
  function paintPreview(anim: 'celebrate' | null): void {
    const lo = lookFor(family);
    const key = `${family}|${team}|${JSON.stringify(lo)}`;
    if (key === lastLookKey) return;
    lastLookKey = key;
    ctx.preview.show({ family, loadout: lo, team, name: ctx.get().profile.name }, anim);
  }

  function paintDetail(): void {
    const eq = equipped(family);
    const id = selected ?? (slot in tryOn ? tryOn[slot] ?? '' : eq[slot] ?? '');
    const def = id ? cosmeticById(id) : undefined;
    dArt.replaceChildren(def ? itemArt(ctx, def, 'big') : h('span', { class: 'item-art big' }, icon('close', 'ia-glyph')));
    dActions.replaceChildren();
    if (!def) {
      dName.textContent = `No ${SLOT_NAMES[slot].toLowerCase()} item`;
      dMeta.replaceChildren(h('span', { class: 'rarity-pill', text: 'Bare' }));
      dBlurb.textContent = 'The slot is empty, so the bare base shows here.';
      dSource.textContent = '';
      return;
    }
    const owned = ctx.owns(def.id);
    const isEq = eq[def.slot] === def.id;
    const trying = tryOn[def.slot] === def.id;
    dName.textContent = def.name;
    dMeta.replaceChildren(rarityPill(def), h('span', { class: 'lk-d-slot' }, icon(SLOT_ICON[def.slot]), h('span', { text: SLOT_NAMES[def.slot] })));
    dBlurb.textContent = def.blurb;
    dSource.textContent = sourceLine(def);
    if (owned) {
      if (isEq) {
        dActions.append(h('span', { class: 'lk-eq-badge' }, icon('check'), h('span', { text: 'Equipped' })));
        if (canUnequip(def)) {
          dActions.append(button('Unequip', () => {
            const lo = { ...eq };
            delete lo[def.slot];
            doEquip(family, lo);
            paint();
          }, { cls: 'ghost small', icon: 'close' }));
        }
      } else {
        dActions.append(button('Equip', () => {
          delete tryOn[def.slot];
          doEquip(family, { ...eq, [def.slot]: def.id });
          paint();
        }, { cls: 'primary', icon: 'check' }));
      }
      return;
    }
    // locked: buy or go to the store
    const e = ctx.econ();
    if (def.rarity === 'premium') {
      // sold for real money in the Steam version only; the browser never offers to buy it
      const offer = premiumOffer(def, isSteam());
      if (offer.buyable) {
        dActions.append(button(`${offer.text} in Store`, () => {
          navHint.storeItem = def.id;
          a.go('store');
        }, { cls: 'primary premium-btn', icon: 'sparkle' }));
      } else dActions.append(h('span', { class: 'lk-steam-note' }, icon('sparkle'), h('span', { text: offer.text })));
    } else if (def.pearls !== undefined) {
      const have = e?.account?.pearls ?? 0;
      const short = def.pearls - have;
      const buy = button(short > 0 ? `Need ${fmtPearls(short)} more` : `Buy ${fmtPearls(def.pearls)}`, () => {
        if (short > 0) {
          ctx.toast(`You need ${fmtPearls(short)} more Pearls. Play matches to earn them.`, 'info');
          return;
        }
        buyThenEquip.add(def.id);
        ctx.buyPearls(def.id);
        setButtonLabel(buy, 'Buying...');
        buy.disabled = true;
      }, { cls: short > 0 ? 'ghost' : 'primary buy-btn', icon: 'pearl', disabled: !e || e.busy });
      dActions.append(buy);
    }
    if (trying) {
      dActions.append(button('Take off', () => {
        delete tryOn[def.slot];
        selected = null;
        paint();
      }, { cls: 'ghost small', icon: 'close' }));
    } else {
      dActions.append(button('Try on', () => {
        tryOn[def.slot] = def.id;
        paint();
      }, { cls: 'ghost small', icon: 'eye' }));
    }
  }

  function paint(): void {
    const s = ctx.get();
    const p = s.profile;
    for (const [f, x] of famBtns) {
      x.b.classList.toggle('on', f === family);
      x.b.setAttribute('aria-selected', f === family ? 'true' : 'false');
      x.main.classList.toggle('hidden', f !== p.family);
    }
    const def = FAMILY_DEFS[family];
    famTitle.textContent = def.title;
    famBlurb.textContent = `${def.passive}: ${def.passiveBlurb}`;
    playAs.classList.toggle('hidden', family === p.family);
    mainBadge.classList.toggle('hidden', family !== p.family);
    const eq = equipped(family);
    const look = lookFor(family);
    for (const [sl, x] of slotBtns) {
      x.b.classList.toggle('on', sl === slot);
      x.b.setAttribute('aria-selected', sl === slot ? 'true' : 'false');
      const id = look[sl];
      x.worn.textContent = id ? cosmeticById(id)?.name ?? '' : 'Bare';
      x.b.classList.toggle('trying', sl in tryOn && tryOn[sl] !== eq[sl]);
    }
    const anyTry = COSMETIC_SLOTS.some((sl) => sl in tryOn && tryOn[sl] !== eq[sl]);
    tryBadge.classList.toggle('hidden', !anyTry);
    revert.classList.toggle('hidden', !anyTry);
    for (const c of cards) {
      const owned = ctx.owns(c.def.id);
      c.set({
        owned,
        equipped: eq[slot] === c.def.id,
        selected: selected === c.def.id,
        trying: tryOn[slot] === c.def.id && !owned,
      });
    }
    bareCard.classList.toggle('equipped', !eq[slot]);
    bareCard.classList.toggle('selected', selected === '');
    paintPreview(null);
    paintDetail();
  }

  // equip things the moment a purchase from this screen lands
  const unsub = ctx.onEcon(() => {
    for (const id of [...buyThenEquip]) {
      if (!ctx.owns(id)) continue;
      buyThenEquip.delete(id);
      const d = cosmeticById(id);
      if (d && d.family === family) {
        delete tryOn[d.slot];
        doEquip(family, { ...equipped(family), [d.slot]: id });
      }
    }
    paint();
  });

  rebuildGrid();
  queueMicrotask(() => {
    if (!shell.el.isConnected) return;
    ctx.preview.mount(stage);
    lastLookKey = '';
    ctx.preview.focus(navHint.lockerItem === null && selected ? slot : null);
    paint();
  });
  paint();
  void (null as unknown as IconId);

  return {
    el: shell.el,
    update(s: AppState, prev: AppState) {
      shell.update(s);
      if (s.profile !== prev.profile) paint();
    },
    destroy() {
      unsub();
      shell.destroy();
      releaseThumbs();
      ctx.preview.unmount();
    },
  };
}
