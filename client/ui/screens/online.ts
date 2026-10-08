// Online: server address and connection status, quick play, join by code, the room browser and
// the Create Room dialog.
import { DEFAULT_CONFIG } from '../../../shared/constants.ts';
import { getMap } from '../../../shared/maps/index.ts';
import type { RoomSummary } from '../../../shared/protocol.ts';
import type { MatchConfig } from '../../../shared/types.ts';
import { mapThumb } from '../chart.ts';
import { createConfigForm } from '../configForm.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { RIVER_INFO } from '../info.ts';
import type { AppState, OnlineState } from '../types.ts';
import { button, iconButton, sectionTitle, setButtonLabel, toggle } from '../widgets.ts';

const STATUS_TEXT: Record<OnlineState['status'], string> = {
  idle: 'Not connected',
  connecting: 'Connecting...',
  connected: 'Connected',
  error: 'Connection failed',
};

export function buildOnline(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;

  // ---------------------------------------------------------------- connection bar
  const url = h('input', { class: 'text-in url-in', placeholder: 'This site (leave empty)', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Server address', maxlength: 200 });
  url.value = s0.settings.serverUrl;
  const lamp = h('span', { class: 'lamp', 'aria-hidden': 'true' });
  const statusText = h('span', { class: 'conn-status-text' });
  const statusSub = h('span', { class: 'conn-status-sub' });
  const connectBtn = button('Connect', () => {
    if (ctx.get().online.status === 'connected') a.disconnect();
    else a.connect(url.value);
  }, { cls: 'primary', icon: 'globe' });
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && ctx.get().online.status !== 'connected') a.connect(url.value);
  });
  const connBar = h('div', { class: 'conn-bar cloth' },
    h('label', { class: 'conn-field' }, h('span', { class: 'field-label', text: 'Server' }), url),
    connectBtn,
    h('div', { class: 'conn-status', role: 'status' }, lamp, h('span', { class: 'conn-status-texts' }, statusText, statusSub)));

  // ---------------------------------------------------------------- left column
  const quick = button('Quick Play', () => a.quickPlay(), { cls: 'primary big', icon: 'play' });
  const code = h('input', { class: 'text-in code-in', placeholder: 'ABCDE', maxlength: 5, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Room code' });
  code.addEventListener('input', () => {
    const v = code.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
    if (v !== code.value) code.value = v;
  });
  const join = () => a.joinRoom(code.value);
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join();
  });
  const create = button('Create a Room', () => openCreate(), { icon: 'flag' });
  const left = h('div', { class: 'online-left' },
    h('div', { class: 'ol-block' }, sectionTitle('Jump in', 'play'), h('p', { class: 'muted', text: 'Drops you into the busiest open room, or makes one.' }), quick),
    h('div', { class: 'ol-block' }, sectionTitle('Join a friend', 'people'), h('div', { class: 'code-row' }, code, button('Join', join, { icon: 'right' }))),
    h('div', { class: 'ol-block' }, sectionTitle('Host', 'crown'), h('p', { class: 'muted', text: 'Pick the map, river and rules. Make it private to play with friends only.' }), create));

  // ---------------------------------------------------------------- room browser
  const list = h('div', { class: 'room-list', role: 'list' });
  const refresh = iconButton('refresh', 'Refresh rooms', () => a.refreshRooms(), 'refresh-btn');
  const browser = h('div', { class: 'online-right' }, sectionTitle('Open rooms', 'flag', refresh), list);

  const offline = h('div', { class: 'online-offline' },
    h('div', { class: 'oo-art', 'aria-hidden': 'true' }, icon('lifebuoy')),
    h('h3', { class: 'oo-title', text: 'Find a harbour' }),
    h('p', { class: 'muted', text: 'Connect to a Hook Wars server to see rooms. Leave the address empty to use the server this page came from, or type host:port.' }));
  const errBox = h('p', { class: 'err-box hidden', role: 'alert' });
  offline.append(errBox);

  const body = h('div', { class: 'panel-body online-body' });
  const el = h('div', { class: 'scr scr-online' },
    h('div', { class: 'panel wide-panel' },
      h('header', { class: 'panel-head' }, button('Back', () => a.go('menu'), { cls: 'ghost', icon: 'left' }), h('h2', { class: 'panel-title', text: 'Play Online' }), h('span', { class: 'head-spacer' })),
      connBar,
      body));

  function roomRow(r: RoomSummary): HTMLElement {
    const m = getMap(r.mapId);
    const full = r.humans >= r.slots;
    return h('div', { class: `room-row ${r.phase}`, role: 'listitem' },
      h('img', { class: 'rr-thumb', alt: '', src: mapThumb(r.mapId, r.riverMode === 'dry' ? 'dry' : 'deep', 120), draggable: 'false' }),
      h('span', { class: 'rr-main' },
        h('span', { class: 'rr-name', text: r.name }),
        h('span', { class: 'rr-meta' },
          h('span', { text: m.name }),
          h('span', { class: 'chip' }, icon(RIVER_INFO[r.riverMode].icon), h('span', { text: RIVER_INFO[r.riverMode].name })))),
      h('span', { class: 'rr-players', title: 'Players / slots' }, icon('people'), h('span', { text: `${r.humans}/${r.slots}` })),
      h('span', { class: `rr-phase ${r.phase}`, text: r.phase === 'match' ? 'In match' : 'Lobby' }),
      button(full ? 'Full' : 'Join', () => a.joinRoom(r.code), { cls: full ? '' : 'primary', disabled: full }));
  }

  let lastRooms: RoomSummary[] | null = null;
  function paintRooms(rooms: RoomSummary[]): void {
    if (rooms === lastRooms) return;
    lastRooms = rooms;
    list.replaceChildren();
    if (rooms.length === 0) {
      list.append(h('div', { class: 'empty-state' }, icon('fish'), h('span', { text: 'No public rooms right now. Host one and your friends can join by code.' })));
      return;
    }
    for (const r of rooms) list.append(roomRow(r));
  }

  let shownStatus: OnlineState['status'] | null = null;
  function paint(s: AppState): void {
    const o = s.online;
    lamp.className = `lamp ${o.status}`;
    statusText.textContent = o.status === 'connected' ? (o.serverName ?? 'Connected') : STATUS_TEXT[o.status];
    statusSub.textContent = o.status === 'connected' ? (o.motd ?? '') : o.status === 'error' ? (o.error ?? 'Could not reach the server.') : o.status === 'connecting' ? o.url : '';
    setButtonLabel(connectBtn, o.status === 'connected' ? 'Disconnect' : o.status === 'connecting' ? 'Connecting...' : 'Connect');
    connectBtn.classList.toggle('primary', o.status !== 'connected');
    connectBtn.disabled = o.status === 'connecting';
    url.disabled = o.status === 'connected' || o.status === 'connecting';
    if (o.status !== shownStatus) {
      shownStatus = o.status;
      body.replaceChildren(o.status === 'connected' ? h('div', { class: 'online-grid' }, left, browser) : offline);
      lastRooms = null;
    }
    errBox.textContent = o.status === 'error' ? (o.error ?? 'Could not reach the server.') : '';
    errBox.classList.toggle('hidden', o.status !== 'error');
    if (o.status === 'connected') paintRooms(o.rooms);
  }
  paint(s0);

  // auto refresh the room list while you look at it
  const timer = window.setInterval(() => {
    if (ctx.get().online.status === 'connected') a.refreshRooms();
  }, 6000);

  function openCreate(): void {
    let cfg: MatchConfig = { ...DEFAULT_CONFIG, ...ctx.get().settings.soloConfig, botFill: true };
    let priv = false;
    const name = h('input', { class: 'text-in', maxlength: 28, spellcheck: 'false', 'aria-label': 'Room name' });
    name.value = `${ctx.get().profile.name}'s room`.slice(0, 28);
    const form = createConfigForm({ variant: 'room', cfg, onChange: (c) => (cfg = c) });
    const privT = toggle('Private room', false, (v) => (priv = v), 'Hidden from the list: friends join with the code');
    let close = () => {};
    const go = button('Create Room', () => {
      a.createRoom(name.value.trim() || `${ctx.get().profile.name}'s room`, priv, cfg);
      close();
    }, { cls: 'primary', icon: 'check' });
    const dlg = h('div', { class: 'panel wide-panel create-room' },
      h('header', { class: 'panel-head' }, h('h2', { class: 'panel-title', text: 'Create a Room' }), h('span', { class: 'head-spacer' }), iconButton('close', 'Cancel', () => close(), 'ghost')),
      h('div', { class: 'panel-body' },
        h('div', { class: 'create-top' }, h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Room name' }), name), privT.el),
        form.el),
      h('footer', { class: 'panel-foot' }, button('Cancel', () => close(), { cls: 'ghost' }), h('span', { class: 'head-spacer' }), go));
    close = ctx.modal(dlg, { label: 'Create a room' });
  }

  return {
    el,
    update(s: AppState, prev: AppState) {
      if (s.online !== prev.online) paint(s);
    },
    destroy() {
      window.clearInterval(timer);
    },
  };
}
