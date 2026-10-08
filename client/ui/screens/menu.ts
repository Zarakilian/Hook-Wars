// Main menu: animated logo, the big buttons, and the profile card with a live 3D Pudgy.
import { FAMILY_DEFS, GAME_VERSION, MAX_NAME_LEN } from '../../../shared/constants.ts';
import { cleanName, type Profile } from '../../../shared/protocol.ts';
import { FAMILIES, type FamilyId } from '../../../shared/types.ts';
import { COSMETIC_SLOTS, cosmeticById, DEFAULT_LOADOUT, itemsFor, SLOT_NAMES, type CosmeticSlot } from '../../../shared/cosmetics.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { TIPS } from '../info.ts';
import { createLogo } from '../logo.ts';
import type { AppState } from '../types.ts';
import { arrowPicker, button, iconButton, segmented } from '../widgets.ts';

export function buildMenu(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;
  let profile: Profile = s0.profile;

  const save = (p: Profile) => {
    profile = p;
    a.saveProfile(p);
  };

  // ---------------------------------------------------------------- left: logo + nav
  const navBtn = (label: string, sub: string, ico: Parameters<typeof icon>[0], fn: () => void, cls = '') => {
    const b = button('', fn, { cls: `nav-btn ${cls}` });
    b.append(h('span', { class: 'nav-ico' }, icon(ico)), h('span', { class: 'nav-text' }, h('span', { class: 'nav-label', text: label }), h('span', { class: 'nav-sub', text: sub })));
    return b;
  };
  const nav = h('nav', { class: 'menu-nav', 'aria-label': 'Main menu' },
    navBtn('Play Solo', 'You and the bots, right now', 'play', () => a.go('solo'), 'primary'),
    navBtn('Play Online', 'Rooms, quick play, friends', 'globe', () => a.go('online')),
    navBtn('Settings', 'Controls, sound, graphics', 'gear', () => a.go('settings')),
    navBtn('How to Play', 'Hooks, rivers and runes', 'book', () => ctx.openHowTo()),
  );
  const tipText = h('span', { class: 'tip-text' });
  let tipIdx = Math.floor(Math.random() * TIPS.length);
  const showTip = () => {
    tipText.textContent = TIPS[tipIdx % TIPS.length];
    tipText.classList.remove('tip-in');
    void tipText.offsetWidth;
    tipText.classList.add('tip-in');
    tipIdx++;
  };
  showTip();
  const tipTimer = window.setInterval(showTip, 8000);
  const tip = h('div', { class: 'menu-tip' }, h('span', { class: 'tip-tag', text: 'Tip' }), tipText);

  // ---------------------------------------------------------------- right: profile card
  const stage = h('div', { class: 'pc-stage' });
  const famBadge = h('div', { class: 'pc-badge' });
  stage.append(h('div', { class: 'pc-porthole', 'aria-hidden': 'true' }), famBadge, h('div', { class: 'pc-hint', text: 'Drag to spin. Click to show off.' }));

  const nameIn = h('input', { class: 'text-in name-in', maxlength: MAX_NAME_LEN, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Your name' });
  nameIn.value = profile.name;
  const nameErr = h('span', { class: 'field-hint err hidden', text: 'Pick a name with at least one letter.' });
  const commitName = () => {
    const n = cleanName(nameIn.value);
    if (!n) {
      nameErr.classList.remove('hidden');
      return;
    }
    nameErr.classList.add('hidden');
    if (n !== nameIn.value) nameIn.value = n;
    if (n !== profile.name) save({ ...profile, name: n });
  };
  nameIn.addEventListener('change', commitName);
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commitName();
      nameIn.blur();
    }
  });

  const famSeg = segmented<FamilyId>({
    label: 'Family',
    cls: 'fam-seg',
    value: profile.family,
    options: FAMILIES.map((f) => ({ value: f, label: FAMILY_DEFS[f].name, icon: f, sub: FAMILY_DEFS[f].passive, title: `${FAMILY_DEFS[f].passive}: ${FAMILY_DEFS[f].passiveBlurb}` })),
    onChange: (f) => save({ ...profile, family: f, loadout: { ...DEFAULT_LOADOUT[f] } }),
  });
  const famTitle = h('div', { class: 'fam-title' });
  const famPassive = h('div', { class: 'fam-passive' });
  const famBlurb = h('div', { class: 'fam-blurb' });
  const famDesc = h('div', { class: 'fam-desc cloth' }, famTitle, h('div', { class: 'fam-row' }, h('span', { class: 'fam-tag', text: 'Passive' }), famPassive), famBlurb);

  // one picker per slot over [bare, ...catalog items for this family]
  const slotOptions = (slot: CosmeticSlot) => ['', ...itemsFor(profile.family, slot).map((c) => c.id)];
  const slotNames = (slot: CosmeticSlot) => slotOptions(slot).map((id) => (id ? cosmeticById(id)!.name : 'Bare'));
  const slotIndex = (slot: CosmeticSlot) => Math.max(0, slotOptions(slot).indexOf(profile.loadout[slot] ?? ''));
  const pick = (slot: CosmeticSlot) => arrowPicker(SLOT_NAMES[slot], slotNames(slot), slotIndex(slot), (i) => {
    const id = slotOptions(slot)[i];
    const loadout = { ...profile.loadout };
    if (id) loadout[slot] = id;
    else delete loadout[slot];
    save({ ...profile, loadout });
  });
  const pickers = COSMETIC_SLOTS.map((slot) => ({ slot, p: pick(slot) }));

  const dice = iconButton('dice', 'Default look', () => {
    save({ ...profile, loadout: { ...DEFAULT_LOADOUT[profile.family] } });
  }, 'dice-btn');

  const card = h('section', { class: 'panel profile-card', 'aria-label': 'Your Pudgy' },
    h('header', { class: 'panel-head' }, h('h2', { class: 'panel-title', text: 'Your Pudgy' }), dice),
    stage,
    h('label', { class: 'name-field' }, h('span', { class: 'field-label', text: 'Name' }), nameIn, nameErr),
    famSeg.el,
    famDesc,
    h('div', { class: 'cosm' }, ...pickers.map((x) => x.p.el)),
  );

  const el = h('div', { class: 'scr scr-menu' },
    h('div', { class: 'menu-left' }, createLogo(), nav, tip),
    h('div', { class: 'menu-right' }, card),
    h('footer', { class: 'menu-foot' }, h('span', { text: `Hook Wars v${GAME_VERSION}` }), h('span', { class: 'dot-sep', text: '·' }), h('span', { text: 'Up to 5 v 5 across the river' })),
  );

  const paint = (s: AppState) => {
    profile = s.profile;
    const def = FAMILY_DEFS[profile.family];
    famSeg.set(profile.family);
    famTitle.textContent = def.title;
    famPassive.textContent = def.passive;
    famBlurb.textContent = def.passiveBlurb;
    famBadge.textContent = '';
    famBadge.append(icon(profile.family), h('span', { text: def.name }));
    for (const { slot, p } of pickers) p.set(slotIndex(slot), slotNames(slot));
    if (document.activeElement !== nameIn && nameIn.value !== profile.name) nameIn.value = profile.name;
    ctx.preview.set(profile, s.settings.soloTeam);
  };

  // mount the preview after the element is in the document so it can measure itself
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    ctx.preview.mount(stage);
    ctx.preview.set(ctx.get().profile, ctx.get().settings.soloTeam);
  });
  queueMicrotask(() => {
    if (!el.isConnected) return;
    ctx.preview.mount(stage);
    paint(ctx.get());
  });
  paint(s0);

  return {
    el,
    update(s: AppState, prev: AppState) {
      if (s.profile !== prev.profile || s.settings.soloTeam !== prev.settings.soloTeam) paint(s);
    },
    destroy() {
      window.clearInterval(tipTimer);
      ctx.preview.unmount();
    },
  };
}
