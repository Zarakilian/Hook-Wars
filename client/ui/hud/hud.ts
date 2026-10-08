// In-match HUD. Hud.frame() runs every frame, so every part writes to the DOM only when a value
// changes (cached setters), positions with transforms, and pools its elements.
import type { MatchEnd } from '../../../shared/protocol.ts';
import { UnitState, type GameEvent } from '../../../shared/types.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../settings.ts';
import type { UiCtx } from '../ctx.ts';
import { h, setClass } from '../dom.ts';
import type { ChatLine, Hud, HudFrame } from '../types.ts';
import { button, setButtonLabel } from '../widgets.ts';
import { Announcer } from './announcer.ts';
import { BottomBar } from './bottombar.ts';
import { HudChat } from './chat.ts';
import { buildEnd } from './endscreen.ts';
import { KillFeed } from './feed.ts';
import './hud.css';
import { Minimap } from './minimap.ts';
import { Overheads } from './overhead.ts';
import { Scoreboard } from './scoreboard.ts';
import { Shop } from './shop.ts';
import { StatusLayers } from './status.ts';
import { TopBar } from './topbar.ts';

export type HudWithSettings = Hud & { settings(s: Settings): void };

export function createHud(root: HTMLElement, ctx: UiCtx): HudWithSettings {
  const actions = ctx.actions;
  let settings: Settings = DEFAULT_SETTINGS;
  let last: HudFrame | null = null;
  let lastT = 0;
  let shopVisible = false;
  let menuVisible = false;

  const overheads = new Overheads();
  const status = new StatusLayers();
  const top = new TopBar();
  const feed = new KillFeed();
  const ann = new Announcer();
  const minimap = new Minimap();
  const bottom = new BottomBar(actions, () => api.toggleShop(true), () => shopVisible);
  const shop = new Shop(actions, () => api.toggleShop(false));
  const board = new Scoreboard();
  const chat = new HudChat(actions);

  // ---------------------------------------------------------------- Esc menu
  const leaveBtn = button('Leave match', () => {
    if (!leaveBtn.classList.contains('confirm')) {
      leaveBtn.classList.add('confirm');
      setButtonLabel(leaveBtn, 'Really leave?');
      window.setTimeout(() => {
        leaveBtn.classList.remove('confirm');
        setButtonLabel(leaveBtn, leaveLabel());
      }, 2500);
      return;
    }
    actions.leaveMatch();
  }, { cls: 'danger', icon: 'left' });
  const leaveLabel = () => ((last?.local ?? true) ? 'Leave match' : 'Leave room');
  const menuTitle = h('h2', { class: 'panel-title', text: 'Paused' });
  const menuSub = h('p', { class: 'menu-sub muted' });
  const menu = h('div', { class: 'esc-menu hidden', role: 'dialog', 'aria-label': 'Menu' },
    h('div', { class: 'panel esc-panel' },
      h('header', { class: 'panel-head' }, menuTitle),
      h('div', { class: 'esc-body' },
        menuSub,
        button('Resume', () => resume(), { cls: 'primary big', icon: 'play' }),
        button('Settings', () => actions.go('settings'), { icon: 'gear' }),
        button('How to Play', () => ctx.openHowTo(), { icon: 'book' }),
        leaveBtn)));

  /** Resume closes the menu through the app, which also un-pauses solo matches. */
  function resume(): void {
    if (shopVisible) api.toggleShop(false);
    actions.resume();
    // if nothing listened (no match running), at least hide the menu
    if (menuVisible) window.setTimeout(() => menuVisible && setMenu(false), 0);
  }

  function setMenu(open: boolean): void {
    menuVisible = open;
    if (!open && menu.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    menu.classList.toggle('hidden', !open);
    if (open) {
      const local = last?.local ?? true;
      menuTitle.textContent = local ? 'Paused' : 'Menu';
      menuSub.textContent = local ? 'The match is paused.' : 'The match keeps going while this menu is open!';
      leaveBtn.classList.remove('confirm');
      setButtonLabel(leaveBtn, leaveLabel());
      board.show(false, null);
    }
  }

  const endHolder = h('div', { class: 'end-holder' });

  const layer = h('div', { class: 'hud-layer' },
    overheads.el,
    status.el,
    top.el,
    top.net,
    feed.el,
    ann.tideEl,
    ann.el,
    ann.countEl,
    minimap.el,
    chat.el,
    bottom.el,
    shop.el,
    board.el,
    menu,
    endHolder);
  root.append(layer);

  function resetAll(): void {
    overheads.reset();
    status.reset();
    top.reset();
    feed.reset();
    ann.reset();
    minimap.reset();
    bottom.reset();
    shop.reset();
    board.reset();
    chat.reset();
    endHolder.replaceChildren();
    shopVisible = false;
    shop.el.classList.add('hidden');
    setClass(root, 'shop-open', false);
    board.show(false, null);
    setMenu(false);
    last = null;
    lastT = 0;
  }

  const name = (f: HudFrame, id: number) => (id < 0 ? null : f.players.get(id)?.name ?? null);

  const api: HudWithSettings = {
    settings(s: Settings) {
      settings = s;
    },
    show() {
      resetAll();
      root.classList.remove('hidden');
    },
    hide() {
      root.classList.add('hidden');
      resetAll();
    },
    frame(f: HudFrame) {
      const now = performance.now();
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      lastT = now;
      last = f;
      overheads.frame(f, dt);
      status.frame(f, settings);
      top.frame(f, settings);
      ann.frame(f);
      minimap.frame(f, now / 1000);
      bottom.frame(f, settings);
      if (shopVisible) shop.update(f.you);
      board.frame(f);
      setClass(root, 'dead', !!f.me && f.me.st === UnitState.Dead);
    },
    event(ev: GameEvent, f: HudFrame) {
      switch (ev.e) {
        case 'kill':
          feed.kill(f, ev.k, ev.v, ev.as, ev.cause);
          if (ev.v === f.youId) status.died(ev.cause, ev.k >= 0 && ev.k !== ev.v ? name(f, ev.k) : null);
          break;
        case 'announce':
          ann.announce(f, ev.key, ev.u, ev.n);
          break;
        case 'tide':
          ann.tide(f, ev.phase);
          break;
        case 'phase':
          if (ev.ph === 'playing') ann.go();
          break;
        case 'runeSpawn':
          minimap.runeSpawn(ev.r, ev.t, ev.x, ev.z);
          break;
        case 'runeGrab':
          minimap.runeGone(ev.r);
          break;
        case 'rune':
          feed.rune(f, ev.u, ev.t);
          break;
        case 'dmg':
          if (ev.tg === f.youId && ev.amt >= 25 && ev.kind !== 'shield') status.hit();
          break;
        default:
          break;
      }
    },
    chat(line: ChatLine) {
      chat.line(line);
    },
    toggleShop(open?: boolean) {
      shopVisible = open ?? !shopVisible;
      shop.el.classList.toggle('hidden', !shopVisible);
      setClass(root, 'shop-open', shopVisible);
      if (shopVisible) {
        actions.uiSound('open');
        shop.reset();
        if (last) shop.update(last.you);
      }
    },
    shopOpen() {
      return shopVisible;
    },
    scoreboard(show: boolean) {
      board.show(show, last);
    },
    openChat(team: boolean) {
      chat.open(team);
    },
    typing() {
      if (chat.focused) return true;
      const ae = document.activeElement as HTMLElement | null;
      if (!ae) return false;
      return ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable;
    },
    showEnd(e: MatchEnd, youId: number, local: boolean) {
      shopVisible = false;
      shop.el.classList.add('hidden');
      setClass(root, 'shop-open', false);
      board.show(false, null);
      setMenu(false);
      const rematch = local
        ? () => {
            const s = ctx.get().settings;
            actions.startSolo(s.soloConfig, s.soloTeam);
          }
        : null;
      endHolder.replaceChildren(buildEnd(e, youId, local, () => actions.leaveMatch(), rematch, local ? null : () => actions.backToLobby()));
    },
    toggleMenu(open?: boolean) {
      setMenu(open ?? !menuVisible);
    },
  };
  return api;
}
