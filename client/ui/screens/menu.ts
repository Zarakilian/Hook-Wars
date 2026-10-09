// Main menu: the animated logo, Play (Solo, Online, and Steam lobbies in the Steam build), the hub (Locker, Store, Market, Career),
// Settings and How to Play, the profile chip, and your character on its dock post over the live scene.
import { FAMILY_DEFS, GAME_VERSION, MAX_NAME_LEN, UNIT_NOUN } from '../../../shared/constants.ts';
import { cleanName } from '../../../shared/protocol.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { icon, setIcon, type IconId } from '../icons.ts';
import { TIPS } from '../info.ts';
import { createLogo } from '../logo.ts';
import { profileChip } from '../shell.ts';
import type { AppState } from '../types.ts';
import { button } from '../widgets.ts';

export function buildMenu(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;

  // ---------------------------------------------------------------- left: logo + nav
  const navBtn = (label: string, sub: string, ico: IconId, fn: () => void, cls = '') => {
    const b = button('', fn, { cls: `nav-btn ${cls}` });
    b.append(h('span', { class: 'nav-ico' }, icon(ico)), h('span', { class: 'nav-text' }, h('span', { class: 'nav-label', text: label }), h('span', { class: 'nav-sub', text: sub })));
    return b;
  };
  const tile = (label: string, sub: string, ico: IconId, fn: () => void, cls = '') => {
    const b = button('', fn, { cls: `hub-tile ${cls}` });
    b.append(h('span', { class: 'ht-art' }, icon(ico)), h('span', { class: 'ht-label', text: label }), h('span', { class: 'ht-sub', text: sub }));
    return b;
  };
  const econ = ctx.econ();
  const nav = h('nav', { class: 'menu-nav', 'aria-label': 'Main menu' },
    h('div', { class: 'mn-play' },
      navBtn('Play Solo', 'You and the bots, right now', 'play', () => a.go('solo'), 'primary'),
      navBtn('Play Online', 'Rooms, quick play, friends', 'globe', () => a.go('online'))),
    h('div', { class: 'mn-hub' },
      tile('Locker', 'Outfits and hooks', 'locker', () => a.go('locker')),
      tile('Store', 'Spend your Pearls', 'shop', () => a.go('store'), econ ? '' : 'dim'),
      tile('Market', 'Trade with players', 'market', () => a.go('market'), econ ? '' : 'dim'),
      tile('Career', 'Your stats', 'career', () => a.go('career'))),
    h('div', { class: 'mn-small' },
      button('Settings', () => a.go('settings'), { cls: 'ghost', icon: 'gear' }),
      button('How to Play', () => ctx.openHowTo(), { cls: 'ghost', icon: 'book' })),
  );
  // Steam build only: Steam lobbies next to Play Online (added once the Steam state exists, so the
  // browser build's menu is exactly as before)
  let steamBtn: HTMLButtonElement | null = null;
  const addSteam = (s: AppState) => {
    if (steamBtn || !s.steam) return;
    steamBtn = navBtn('Play with Steam', 'Host or join your friends’ lobbies', 'people', () => a.go('steam'), 'steam-nav');
    const play = nav.querySelector('.mn-play');
    play?.insertBefore(steamBtn, play.lastElementChild);
  };
  addSteam(s0);
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

  // ---------------------------------------------------------------- right: your character on its post
  const stage = h('div', { class: 'menu-stage' });
  const glow = h('div', { class: 'ms-glow', 'aria-hidden': 'true' });
  const nameIn = h('input', { class: 'np-name', maxlength: MAX_NAME_LEN, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Your name', title: 'Click to rename' });
  nameIn.value = s0.profile.name;
  const famIco = icon(s0.profile.family, 'np-fam-ico');
  const famName = h('span', { class: 'np-fam-name' });
  const famPassive = h('span', { class: 'np-passive' });
  const nameErr = h('span', { class: 'np-err hidden', text: 'Pick a name with at least one letter.' });
  const commitName = () => {
    const n = cleanName(nameIn.value);
    const p = ctx.get().profile;
    if (!n) {
      nameErr.classList.remove('hidden');
      return;
    }
    nameErr.classList.add('hidden');
    if (n !== nameIn.value) nameIn.value = n;
    if (n !== p.name) a.saveProfile({ ...p, name: n });
  };
  nameIn.addEventListener('change', commitName);
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commitName();
      nameIn.blur();
    }
  });
  const plate = h('div', { class: 'nameplate' },
    h('span', { class: 'np-rivet l', 'aria-hidden': 'true' }),
    h('label', { class: 'np-name-wrap' }, nameIn, icon('tag', 'np-edit')),
    h('span', { class: 'np-fam' }, famIco, famName, h('span', { class: 'dot-sep', text: '·' }), famPassive),
    nameErr,
    h('span', { class: 'np-rivet r', 'aria-hidden': 'true' }));
  const look = button('Change Look', () => a.go('locker'), { cls: 'primary', icon: 'locker' });
  const hint = h('div', { class: 'ms-hint', text: 'Drag to spin · click to show off' });
  const stageWrap = h('section', { class: 'menu-right', 'aria-label': `Your ${UNIT_NOUN.one}` }, glow, stage, hint, plate, look);

  const chip = profileChip(ctx);
  const el = h('div', { class: 'scr scr-menu' },
    h('div', { class: 'menu-top' }, chip.el),
    h('div', { class: 'menu-left' }, createLogo(), nav, tip),
    stageWrap,
    h('footer', { class: 'menu-foot' }, h('span', { text: `Hook Wars v${GAME_VERSION}` }), h('span', { class: 'dot-sep', text: '·' }), h('span', { text: 'Up to 5 v 5 across the river' })),
  );

  const paint = (s: AppState) => {
    const p = s.profile;
    const def = FAMILY_DEFS[p.family];
    setIcon(famIco, p.family);
    famName.textContent = def.name;
    famPassive.textContent = def.passive;
    famPassive.title = def.passiveBlurb;
    if (document.activeElement !== nameIn && nameIn.value !== p.name) nameIn.value = p.name;
    chip.update(s);
    ctx.preview.focus(null);
    ctx.preview.show({ family: p.family, loadout: p.loadout, team: s.settings.soloTeam, name: p.name });
  };

  // mount the preview after the element is in the document so it can measure itself
  queueMicrotask(() => {
    if (!el.isConnected) return;
    ctx.preview.mount(stage);
    paint(ctx.get());
  });
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    ctx.preview.mount(stage);
    paint(ctx.get());
  });
  paint(s0);

  return {
    el,
    update(s: AppState, prev: AppState) {
      if (s.profile !== prev.profile || s.settings.soloTeam !== prev.settings.soloTeam) paint(s);
      if (s.steam && !steamBtn) addSteam(s);
    },
    destroy() {
      window.clearInterval(tipTimer);
      chip.destroy();
      ctx.preview.unmount();
    },
  };
}
