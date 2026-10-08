// Menus, lobby and HUD. (Slice version: functional, plain styling.)
import { FAMILY_DEFS, HOOK_LEVELS, ITEM_IDS, ITEMS, MAX_UPGRADE, UPGRADE_COST } from '../../shared/constants.ts';
import { getMap, mapSupportsTidal } from '../../shared/maps/index.ts';
import type { MatchEnd } from '../../shared/protocol.ts';
import {
  BOT_DIFFICULTIES, FAMILIES, HAZARD_MODES, MAP_IDS, RIVER_MODES, UPGRADE_STATS, UnitState,
  type GameEvent, type MatchConfig, type Team,
} from '../../shared/types.ts';
import { TEAM_COLORS } from '../render/contracts.ts';
import { clear, fmtTime, h } from './dom.ts';
import type { AppActions, AppState, ChatLine, Hud, HudFrame, UI } from './types.ts';

export function createUI(root: HTMLElement, actions: AppActions): UI {
  const screens = h('div', { class: 'screens' });
  const hudRoot = h('div', { class: 'hud hidden' });
  const toast = h('div', { class: 'toast hidden' });
  root.append(screens, hudRoot, toast);
  let lastToast = -1;
  let current: AppState | null = null;

  const hud = createHud(hudRoot, actions);

  function configForm(cfg: MatchConfig, onChange: (c: MatchConfig) => void, disabled = false) {
    const sel = <T extends string | number>(label: string, value: T, options: readonly T[], names: (v: T) => string, set: (v: T) => void) =>
      h('label', { class: 'field' }, label,
        (() => {
          const s = h('select', { disabled });
          for (const o of options) s.append(h('option', { value: String(o), selected: o === value, text: names(o) }));
          s.addEventListener('change', () => set((typeof value === 'number' ? Number(s.value) : s.value) as T));
          return s;
        })());
    const tidal = mapSupportsTidal(cfg.mapId);
    return h('div', { class: 'config' },
      sel('Map', cfg.mapId, MAP_IDS, (v) => getMap(v).name, (v) => onChange({ ...cfg, mapId: v, riverMode: cfg.riverMode === 'tidal' && !mapSupportsTidal(v) ? 'deep' : cfg.riverMode })),
      sel('River', cfg.riverMode, tidal ? RIVER_MODES : RIVER_MODES.filter((r) => r !== 'tidal'), (v) => ({ deep: 'Deep Water', dry: 'Dry Bed', tidal: 'Tidal' })[v], (v) => onChange({ ...cfg, riverMode: v })),
      sel('Hazards', cfg.hazards, HAZARD_MODES, (v) => ({ none: 'None', thorns: 'Thorns', bristles: 'Bristles', special: 'Map Special', mixed: 'Mixed' })[v], (v) => onChange({ ...cfg, hazards: v })),
      sel('Team size', cfg.teamSize, [1, 2, 3, 4, 5], (v) => `${v} v ${v}`, (v) => onChange({ ...cfg, teamSize: v })),
      sel('Kills to win', cfg.killsToWin, [10, 15, 20, 30, 40, 50], String, (v) => onChange({ ...cfg, killsToWin: v })),
      sel('Time limit', cfg.timeLimitSec, [300, 600, 900, 1200, 1800], (v) => `${v / 60} min`, (v) => onChange({ ...cfg, timeLimitSec: v })),
      sel('Bots', cfg.botDifficulty, BOT_DIFFICULTIES, (v) => v[0].toUpperCase() + v.slice(1), (v) => onChange({ ...cfg, botDifficulty: v })),
      h('label', { class: 'field' }, 'Fill with bots', (() => {
        const c = h('input', { type: 'checkbox', checked: cfg.botFill, disabled });
        c.addEventListener('change', () => onChange({ ...cfg, botFill: c.checked }));
        return c;
      })()),
    );
  }

  function profileBox(s: AppState) {
    const name = h('input', { value: s.profile.name, maxlength: 16 });
    const fam = h('select');
    for (const f of FAMILIES) fam.append(h('option', { value: f, selected: f === s.profile.family, text: `${FAMILY_DEFS[f].name} (${FAMILY_DEFS[f].passive})` }));
    const save = () => actions.saveProfile({ ...s.profile, name: name.value || s.profile.name, family: fam.value as typeof s.profile.family });
    name.addEventListener('change', save);
    fam.addEventListener('change', save);
    return h('div', { class: 'profile' }, h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Pudgy', fam));
  }

  function render(s: AppState) {
    current = s;
    if (s.toast && s.toast.id !== lastToast) {
      lastToast = s.toast.id;
      toast.textContent = s.toast.text;
      toast.className = `toast ${s.toast.kind}`;
      setTimeout(() => toast.classList.add('hidden'), 3500);
    }
    clear(screens);
    screens.classList.toggle('hidden', s.screen === 'match');
    if (s.screen === 'match') return;
    const btn = (text: string, fn: () => void, cls = '') => h('button', { class: `btn ${cls}`, onclick: () => { actions.uiSound('click'); fn(); } }, text);
    const panel = h('div', { class: 'panel' });
    screens.append(panel);
    switch (s.screen) {
      case 'menu':
        panel.append(
          h('h1', { class: 'title', text: 'HOOK WARS' }),
          h('p', { class: 'tag', text: 'Hook them across the river. Mind the water.' }),
          profileBox(s),
          btn('Play Solo vs Bots', () => actions.go('solo'), 'primary'),
          btn('Play Online', () => actions.go('online')),
          btn('Settings', () => actions.go('settings')),
        );
        break;
      case 'solo': {
        let cfg = s.settings.soloConfig;
        let team: Team = s.settings.soloTeam;
        const holder = h('div');
        const draw = () => {
          clear(holder);
          holder.append(configForm(cfg, (c) => { cfg = c; actions.saveSettings({ ...s.settings, soloConfig: c, soloTeam: team }); draw(); }));
        };
        draw();
        const teamSel = h('select');
        for (const t of [0, 1] as Team[]) teamSel.append(h('option', { value: String(t), selected: t === team, text: TEAM_COLORS[t].name }));
        teamSel.addEventListener('change', () => { team = Number(teamSel.value) as Team; });
        panel.append(h('h2', { text: 'Solo vs Bots' }), holder, h('label', { class: 'field' }, 'Your team', teamSel), btn('Start', () => actions.startSolo(cfg, team), 'primary'), btn('Back', () => actions.go('menu')));
        break;
      }
      case 'online': {
        const o = s.online;
        if (o.status !== 'connected') {
          const url = h('input', { value: s.settings.serverUrl, placeholder: 'Leave empty for this site, or host:port' });
          panel.append(
            h('h2', { text: 'Play Online' }),
            h('label', { class: 'field' }, 'Server', url),
            o.status === 'error' ? h('p', { class: 'error', text: o.error ?? 'Connection failed.' }) : '',
            btn(o.status === 'connecting' ? 'Connecting...' : 'Connect', () => actions.connect(url.value), 'primary'),
            btn('Back', () => actions.go('menu')),
          );
          break;
        }
        const code = h('input', { placeholder: 'ROOM CODE', maxlength: 5 });
        const list = h('div', { class: 'rooms' });
        if (o.rooms.length === 0) list.append(h('p', { class: 'muted', text: 'No public rooms yet. Create one!' }));
        for (const r of o.rooms) {
          list.append(h('div', { class: 'room' },
            h('span', { text: `${r.name}` }),
            h('span', { class: 'muted', text: `${getMap(r.mapId).name} · ${r.humans}/${r.slots} · ${r.phase}` }),
            btn('Join', () => actions.joinRoom(r.code))));
        }
        let cfg = { ...s.settings.soloConfig };
        const cfgHolder = h('div');
        const drawCfg = () => {
          clear(cfgHolder);
          cfgHolder.append(configForm(cfg, (c) => { cfg = c; drawCfg(); }));
        };
        drawCfg();
        const priv = h('input', { type: 'checkbox' });
        panel.append(
          h('h2', { text: o.serverName ?? 'Server' }),
          o.motd ? h('p', { class: 'muted', text: o.motd }) : '',
          btn('Quick Play', () => actions.quickPlay(), 'primary'),
          h('div', { class: 'row' }, code, btn('Join by code', () => actions.joinRoom(code.value))),
          h('h3', { text: 'Rooms' }), list, btn('Refresh', () => actions.refreshRooms()),
          h('h3', { text: 'Create a room' }), cfgHolder, h('label', { class: 'field' }, 'Private', priv),
          btn('Create', () => actions.createRoom(`${s.profile.name}'s room`, priv.checked, cfg)),
          btn('Disconnect', () => actions.disconnect()),
        );
        break;
      }
      case 'lobby': {
        const r = s.room;
        if (!r) break;
        const isHost = r.hostId === s.online.youId;
        const me = r.players.find((p) => p.id === s.online.youId);
        const teamCol = (t: Team | -1) => {
          const col = h('div', { class: 'teamcol' }, h('h3', { text: t === -1 ? 'Spectators' : TEAM_COLORS[t].name }));
          for (const p of r.players.filter((x) => x.team === t)) {
            col.append(h('div', { class: 'slot' }, h('span', { text: `${p.host ? '★ ' : ''}${p.name}` }), h('span', { class: 'muted', text: `${FAMILY_DEFS[p.family].name}${p.ready ? ' · READY' : ''} · ${p.ping}ms` })));
          }
          if (t !== -1) {
            const empty = r.config.teamSize - r.players.filter((x) => x.team === t).length;
            for (let i = 0; i < empty; i++) col.append(h('div', { class: 'slot empty', text: r.config.botFill ? 'Bot' : 'Open' }));
          }
          if (me && me.team !== t) col.append(btn('Join', () => actions.setTeam(t)));
          return col;
        };
        const chatLog = h('div', { class: 'chatlog' });
        for (const c of s.chat.slice(-12)) chatLog.append(h('div', { text: `${c.from}: ${c.text}` }));
        const chatIn = h('input', { placeholder: 'Say something', maxlength: 120 });
        chatIn.addEventListener('keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Enter' && chatIn.value.trim()) {
            actions.sendChat(chatIn.value, false);
            chatIn.value = '';
          }
        });
        panel.append(
          h('h2', { text: `${r.name}  ·  code ${r.code}` }),
          h('div', { class: 'teams' }, teamCol(0), teamCol(1), teamCol(-1)),
          configForm(r.config, (c) => actions.setConfig(c), !isHost),
          h('div', { class: 'row' },
            btn(me?.ready ? 'Not ready' : 'Ready', () => actions.setReady(!me?.ready)),
            isHost ? btn(r.phase === 'match' ? 'Match running' : 'Start match', () => actions.startMatch(), 'primary') : null,
            btn('Leave room', () => actions.leaveRoom())),
          chatLog, chatIn,
        );
        break;
      }
      case 'settings': {
        const st = s.settings;
        const ctrl = h('select');
        for (const c of ['modern', 'classic'] as const) ctrl.append(h('option', { value: c, selected: st.controls === c, text: c === 'modern' ? 'Modern (WASD + mouse)' : 'Classic (right-click move, QWE)' }));
        ctrl.addEventListener('change', () => actions.saveSettings({ ...st, controls: ctrl.value as typeof st.controls }));
        const qual = h('select');
        for (const q of ['auto', 'low', 'medium', 'high', 'ultra'] as const) qual.append(h('option', { value: q, selected: st.quality === q, text: q }));
        qual.addEventListener('change', () => actions.saveSettings({ ...st, quality: qual.value as typeof st.quality }));
        const slider = (label: string, v: number, set: (n: number) => void) => {
          const i = h('input', { type: 'range', min: 0, max: 100, value: Math.round(v * 100) });
          i.addEventListener('change', () => set(Number(i.value) / 100));
          return h('label', { class: 'field' }, label, i);
        };
        panel.append(
          h('h2', { text: 'Settings' }),
          h('label', { class: 'field' }, 'Controls', ctrl),
          h('label', { class: 'field' }, 'Graphics', qual),
          slider('Master volume', st.master, (n) => actions.saveSettings({ ...st, master: n })),
          slider('Effects', st.sfx, (n) => actions.saveSettings({ ...st, sfx: n })),
          slider('Music', st.music, (n) => actions.saveSettings({ ...st, music: n })),
          slider('Screen shake', st.shake, (n) => actions.saveSettings({ ...st, shake: n })),
          btn('Back', () => actions.go(s.match ? 'match' : 'menu')),
        );
        break;
      }
      case 'profile':
        panel.append(profileBox(s), btn('Back', () => actions.go('menu')));
        break;
    }
  }

  return {
    render,
    hud,
    get state() {
      return current;
    },
  } as UI;
}

// ---------------------------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------------------------

function createHud(root: HTMLElement, actions: AppActions): Hud {
  const top = h('div', { class: 'hud-top' });
  const feed = h('div', { class: 'feed' });
  const announce = h('div', { class: 'announce' });
  const bottom = h('div', { class: 'hud-bottom' });
  const shop = h('div', { class: 'shop hidden' });
  const board = h('div', { class: 'board hidden' });
  const chatBox = h('div', { class: 'chatbox' });
  const chatIn = h('input', { class: 'chatin hidden', maxlength: 120, placeholder: 'Enter to send, Esc to cancel' });
  const end = h('div', { class: 'end hidden' });
  const menu = h('div', { class: 'ingame-menu hidden' },
    h('button', { class: 'btn', onclick: () => menuToggle(false) }, 'Resume'),
    h('button', { class: 'btn', onclick: () => actions.go('settings') }, 'Settings'),
    h('button', { class: 'btn', onclick: () => actions.leaveMatch() }, 'Leave match'));
  root.append(top, feed, announce, bottom, shop, board, chatBox, chatIn, end, menu);
  let chatTeam = false;
  let typingNow = false;
  let lastFrame: HudFrame | null = null;
  let shopVisible = false;
  let annT = 0;

  chatIn.addEventListener('focus', () => (typingNow = true));
  chatIn.addEventListener('blur', () => {
    typingNow = false;
    chatIn.classList.add('hidden');
  });
  chatIn.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter') {
      if (chatIn.value.trim()) actions.sendChat(chatIn.value, chatTeam);
      chatIn.value = '';
      chatIn.blur();
    } else if (k === 'Escape') chatIn.blur();
    e.stopPropagation();
  });

  function menuToggle(open?: boolean) {
    const show = open ?? menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !show);
  }

  function name(f: HudFrame, id: number): string {
    return f.players.get(id)?.name ?? '?';
  }

  function drawShop(f: HudFrame) {
    clear(shop);
    const you = f.you;
    if (!you) return;
    shop.append(h('h3', { text: `Shop · ${you.gold} gold` }));
    for (const st of UPGRADE_STATS) {
      const lvl = you.up[st];
      const cost = lvl < MAX_UPGRADE ? UPGRADE_COST[lvl] : 0;
      shop.append(h('button', { class: 'btn small', disabled: lvl >= MAX_UPGRADE || you.gold < cost, onclick: () => actions.upgrade(st) },
        `Hook ${st} ${lvl}/5 ${lvl < MAX_UPGRADE ? `(${cost}g) → ${HOOK_LEVELS[st][lvl + 1]}` : 'MAX'}`));
    }
    for (const id of ITEM_IDS) {
      const it = ITEMS[id];
      shop.append(h('button', { class: 'btn small', title: it.blurb, disabled: you.gold < it.cost, onclick: () => actions.buy(id) }, `${it.name} (${it.cost}g)`));
    }
  }

  const hudApi: Hud = {
    show() {
      root.classList.remove('hidden');
    },
    hide() {
      root.classList.add('hidden');
      end.classList.add('hidden');
      menu.classList.add('hidden');
    },
    frame(f: HudFrame) {
      lastFrame = f;
      const ph = f.phase === 'countdown' ? `Starting in ${Math.ceil(f.countdown)}` : f.overtime ? 'OVERTIME: next kill wins' : fmtTime(f.timeLeft);
      const tide = f.river.cycle ? ` · ${f.river.phase} ${Math.ceil(f.river.phaseLeft)}s` : '';
      top.textContent = `${TEAM_COLORS[0].name} ${f.score[0]}  —  ${f.score[1]} ${TEAM_COLORS[1].name}   ·   ${ph}${tide}   ·   first to ${f.config.killsToWin}${f.local ? '' : `   ·   ${Math.round(f.ping)} ms`}`;
      const you = f.you;
      const me = f.me;
      if (you && me) {
        const cds = ['Hook', 'Grapple', 'Bash'].map((n, i) => `${n} ${you.cd[i] > 0 ? you.cd[i].toFixed(1) : 'READY'}`).join('   ');
        const items = you.items.map((s, i) => (s ? `[${i + 1}] ${ITEMS[s.id].name}${s.charges ? ` x${s.charges}` : ''}` : `[${i + 1}] -`)).join('  ');
        const status = me.st === UnitState.Dead ? `  ·  respawn in ${Math.ceil(me.rt ?? 0)}` : you.drown > 0 ? `  ·  DROWNING ${you.drown.toFixed(1)}s` : '';
        bottom.textContent = `HP ${me.hp}/${me.mhp}   ·   ${you.gold}g   ·   ${cds}   ·   ${items}${status}`;
      } else bottom.textContent = 'Spectating';
      if (shopVisible) drawShop(f);
      if (annT > 0 && performance.now() > annT) {
        announce.textContent = '';
        annT = 0;
      }
      if (!board.classList.contains('hidden')) drawBoard(f);
    },
    event(ev: GameEvent, f: HudFrame) {
      if (ev.e === 'kill') {
        const line = h('div', { text: `${ev.k >= 0 ? name(f, ev.k) : 'The river'} ${ev.cause === 'drown' ? 'drowned' : 'hooked'} ${name(f, ev.v)}` });
        feed.prepend(line);
        while (feed.childElementCount > 6) feed.lastChild?.remove();
        setTimeout(() => line.remove(), 8000);
      } else if (ev.e === 'announce') {
        const text: Record<string, string> = {
          firstBlood: 'FIRST HOOK!', doubleHook: 'DOUBLE HOOK!', tripleHook: 'TRIPLE HOOK!', ultraHook: 'ULTRA HOOK!',
          spree3: 'REEL DEAL!', spree5: 'CATCH OF THE DAY!', spree8: 'KRAKEN UNLEASHED!', shutdown: 'SHUT DOWN!', bullseye: 'BULLSEYE!',
          save: 'SAVED!', drowned: 'DROWNED!', overtime: 'OVERTIME!',
        };
        announce.textContent = `${text[ev.key] ?? ev.key}${ev.u >= 0 ? `  ${name(f, ev.u)}` : ''}`;
        annT = performance.now() + 2200;
      } else if (ev.e === 'tide') {
        const t: Record<string, string> = { rising: 'THE TIDE IS COMING IN!', falling: 'The tide is going out', cracking: 'THE ICE IS CRACKING!', freezing: 'The river is freezing over', frozen: 'Frozen solid: cross the ice!', low: 'Low tide: the bed is walkable', high: 'High tide!', thawed: 'The ice is gone!' };
        if (t[ev.phase]) {
          announce.textContent = t[ev.phase];
          annT = performance.now() + 2500;
        }
      }
    },
    chat(line: ChatLine) {
      const el = h('div', { text: `${line.team ? '[team] ' : ''}${line.from}: ${line.text}` });
      chatBox.append(el);
      while (chatBox.childElementCount > 6) chatBox.firstChild?.remove();
      setTimeout(() => el.remove(), 12000);
    },
    toggleShop(open?: boolean) {
      shopVisible = open ?? !shopVisible;
      shop.classList.toggle('hidden', !shopVisible);
      if (shopVisible && lastFrame) drawShop(lastFrame);
    },
    shopOpen() {
      return shopVisible;
    },
    scoreboard(show: boolean) {
      board.classList.toggle('hidden', !show);
      if (show && lastFrame) drawBoard(lastFrame);
    },
    openChat(team: boolean) {
      chatTeam = team;
      chatIn.classList.remove('hidden');
      chatIn.placeholder = team ? 'Team chat' : 'All chat';
      chatIn.focus();
    },
    typing() {
      return typingNow;
    },
    showEnd(e: MatchEnd, youId: number, local: boolean) {
      clear(end);
      const you = e.players.find((p) => p.id === youId);
      const won = you ? e.winner === you.team : false;
      end.append(h('h1', { text: e.winner === -1 ? 'DRAW' : won ? 'VICTORY!' : you ? 'DEFEAT' : `${TEAM_COLORS[e.winner as Team].name} wins` }), h('p', { text: `${e.score[0]} - ${e.score[1]}` }));
      const table = h('table');
      table.append(h('tr', {}, ...['Player', 'K', 'D', 'A', 'Hooks', 'Acc', 'Drowns'].map((x) => h('th', { text: x }))));
      for (const r of e.rows) {
        const p = e.players.find((x) => x.id === r.i);
        table.append(h('tr', { style: `color:#${TEAM_COLORS[(p?.team ?? 0) as Team].light.toString(16)}` }, ...[p?.name ?? '?', r.k, r.d, r.a, r.hh, r.ht ? `${Math.round((r.hh / r.ht) * 100)}%` : '-', r.dr].map((x) => h('td', { text: String(x) }))));
      }
      end.append(table, h('button', { class: 'btn primary', onclick: () => actions.leaveMatch() }, local ? 'Back to menu' : 'Back to lobby'));
      end.classList.remove('hidden');
    },
    toggleMenu(open?: boolean) {
      menuToggle(open);
    },
  };

  function drawBoard(f: HudFrame) {
    clear(board);
    const table = h('table');
    table.append(h('tr', {}, ...['Player', 'K', 'D', 'A', 'Hooks', 'Acc', 'Gold'].map((x) => h('th', { text: x }))));
    const rows = [...f.scoreboard].sort((a, b) => (f.players.get(a.i)?.team ?? 0) - (f.players.get(b.i)?.team ?? 0) || b.k - a.k);
    for (const r of rows) {
      const p = f.players.get(r.i);
      table.append(h('tr', { style: `color:#${TEAM_COLORS[(p?.team ?? 0) as Team].light.toString(16)}` }, ...[p?.name ?? '?', r.k, r.d, r.a, `${r.hh}/${r.ht}`, r.ht ? `${Math.round((r.hh / r.ht) * 100)}%` : '-', r.g].map((x) => h('td', { text: String(x) }))));
    }
    board.append(table);
  }

  return hudApi;
}
