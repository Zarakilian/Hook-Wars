// Play with Steam (the Steam build only, next to Play Online): host a Steam lobby, browse and join
// your friends' lobbies, and see why a lobby ended. Hosting starts the game server on this computer
// and players reach it through Steam, so nobody's IP address is shown and there is no server to rent.
// Text from other players (lobby and persona names) only ever goes through textContent.
import { getMap } from '../../../shared/maps/index.ts';
import { MAP_IDS, RIVER_MODES, type MapId, type RiverMode } from '../../../shared/types.ts';
import { LOBBY_MAX_CHOICES, LOBBY_NAME_MAX } from '../../net/steamLobby.ts';
import type { SteamPlayState } from '../../net/steamPlay.ts';
import type { SteamLobbySummary } from '../../platform.ts';
import { mapThumb } from '../chart.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { RIVER_INFO } from '../info.ts';
import type { AppState } from '../types.ts';
import { button, iconButton, sectionTitle, segmented, setButtonLabel, toggle } from '../widgets.ts';
import './steam.css';

/** The list refreshes by itself this often while the screen is open. */
const AUTO_REFRESH_MS = 10_000;

const isMap = (v: string): v is MapId => (MAP_IDS as readonly string[]).includes(v);
const isMode = (v: string): v is RiverMode => (RIVER_MODES as readonly string[]).includes(v);

export function buildSteam(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;
  const st0 = s0.steam!;

  // ---------------------------------------------------------------- who you are on Steam
  const lamp = h('span', { class: 'lamp connected', 'aria-hidden': 'true' });
  const who = h('span', { class: 'conn-status-text' });
  const whoSub = h('span', { class: 'conn-status-sub' });
  const fakeBadge = h('span', { class: 'stm-fake hidden', text: 'Stand-in Steam', title: 'Testing without the Steam client: lobbies are the rooms on this page’s own server' });
  const statusBar = h('div', { class: 'conn-bar cloth stm-bar' },
    h('div', { class: 'conn-status', role: 'status' }, lamp, h('span', { class: 'conn-status-texts' }, who, whoSub)),
    fakeBadge);

  // ---------------------------------------------------------------- host a lobby
  const nameIn = h('input', { class: 'text-in', maxlength: LOBBY_NAME_MAX, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Lobby name' });
  const defaultName = () => `${ctx.get().steam?.player?.name ?? ctx.get().profile.name}'s lobby`.slice(0, LOBBY_NAME_MAX);
  nameIn.value = defaultName();
  let nameTouched = false;
  nameIn.addEventListener('input', () => (nameTouched = true));
  let isPrivate = false;
  const privT = toggle('Friends only', false, (v) => (isPrivate = v), 'Hidden from the lobby list: friends join with Invite');
  let maxPlayers = 10;
  const maxSeg = segmented<number>({
    label: 'Max players',
    cls: 'seg-small',
    value: maxPlayers,
    options: LOBBY_MAX_CHOICES.map((n) => ({ value: n, label: String(n), title: `${n / 2} v ${n / 2}` })),
    onChange: (v) => (maxPlayers = v),
  });
  const hostBtn = button('Host Lobby', () => {
    a.steamHost?.({ name: nameIn.value.trim() || defaultName(), maxPlayers, isPrivate });
  }, { cls: 'primary big', icon: 'crown' });
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !hostBtn.disabled) hostBtn.click();
  });
  const hostBlock = h('div', { class: 'ol-block' },
    sectionTitle('Host a lobby', 'crown'),
    h('p', { class: 'muted', text: 'Runs the match on this computer. Friends join through Steam: no server to rent, and nobody sees your IP address.' }),
    h('label', { class: 'field stm-field' }, h('span', { class: 'field-label', text: 'Lobby name' }), nameIn),
    h('div', { class: 'field stm-field' }, h('span', { class: 'field-label', text: 'Max players' }), maxSeg.el),
    privT.el,
    hostBtn);

  // where you are right now (hosting, joining, in a lobby)
  const busyText = h('span', { class: 'stm-busy-text' });
  const backToLobby = button('Back to the lobby', () => a.go('lobby'), { cls: 'primary', icon: 'anchor' });
  const leaveBtn = button('Leave', () => a.steamLeave?.(), { cls: 'ghost', icon: 'left' });
  const busyBlock = h('div', { class: 'ol-block stm-busy hidden', role: 'status' }, h('span', { class: 'stm-spin', 'aria-hidden': 'true' }), busyText, h('span', { class: 'stm-busy-btns' }, backToLobby, leaveBtn));

  const serversBlock = h('div', { class: 'ol-block' },
    sectionTitle('Dedicated servers', 'globe'),
    h('p', { class: 'muted', text: 'Playing on a Hook Wars server instead? Type its address on the Online screen.' }),
    button('Play Online', () => a.go('online'), { icon: 'globe' }));

  const errBox = h('p', { class: 'err-box hidden', role: 'alert' });

  // ---------------------------------------------------------------- lobby browser
  const list = h('div', { class: 'room-list stm-list', role: 'list' });
  const refresh = iconButton('refresh', 'Refresh lobbies', () => a.steamRefresh?.(), 'refresh-btn');
  const listNote = h('span', { class: 'stm-list-note muted' });
  const browser = h('div', { class: 'online-right' }, sectionTitle('Steam lobbies', 'people', refresh), list, listNote);

  const el = h('div', { class: 'scr scr-online scr-steam' },
    h('div', { class: 'panel wide-panel' },
      h('header', { class: 'panel-head' }, button('Back', () => a.go('menu'), { cls: 'ghost', icon: 'left' }), h('h2', { class: 'panel-title', text: 'Play with Steam' }), h('span', { class: 'head-spacer' })),
      statusBar,
      h('div', { class: 'panel-body online-body' },
        errBox,
        h('div', { class: 'online-grid' }, h('div', { class: 'online-left' }, busyBlock, hostBlock, serversBlock), browser))));

  function lobbyRow(l: SteamLobbySummary, st: SteamPlayState): HTMLElement {
    const map = isMap(l.info.map) ? getMap(l.info.map) : null;
    const mode = isMode(l.info.mode) ? RIVER_INFO[l.info.mode] : null;
    const humans = Number(l.info.humans) || l.members;
    const max = Number(l.info.max) || l.max;
    const full = l.max > 0 && l.members >= l.max;
    const busy = st.phase !== 'idle';
    const thumb = map
      ? h('img', { class: 'rr-thumb', alt: '', src: mapThumb(map.id, l.info.mode === 'dry' ? 'dry' : 'deep', 120), draggable: 'false' })
      : h('span', { class: 'rr-thumb stm-thumb-none', 'aria-hidden': 'true' }, icon('fish'));
    const meta = h('span', { class: 'rr-meta' },
      h('span', { class: 'stm-host' }, icon('user'), h('span', { text: l.host || 'Steam player' })),
      map ? h('span', { text: map.name }) : null,
      mode ? h('span', { class: 'chip' }, icon(mode.icon), h('span', { text: mode.name })) : null);
    const joinBtn = button(full ? 'Full' : 'Join', () => a.steamJoin?.(l.id), { cls: full ? '' : 'primary', disabled: full || busy });
    return h('div', { class: `room-row ${l.info.phase}`, role: 'listitem' },
      thumb,
      h('span', { class: 'rr-main' }, h('span', { class: 'rr-name', text: l.name }), meta),
      h('span', { class: 'rr-players', title: 'Players / slots' }, icon('people'), h('span', { text: `${humans}/${max}` })),
      h('span', { class: `rr-phase ${l.info.phase}`, text: l.info.phase === 'match' ? 'In match' : 'Lobby' }),
      joinBtn);
  }

  // rows are rebuilt only when what they show changed (a refresh with the same lobbies keeps the
  // buttons under the pointer)
  let lastKey = '';
  function paintList(st: SteamPlayState): void {
    const key = JSON.stringify([st.phase, st.listedAt > 0, st.lobbies]);
    if (key === lastKey) return;
    lastKey = key;
    list.replaceChildren();
    if (st.lobbies.length === 0) {
      list.append(h('div', { class: 'empty-state' }, icon('fish'), h('span', { text: st.listedAt ? 'No Hook Wars lobbies right now. Host one, then invite your friends.' : 'Looking for lobbies...' })));
      return;
    }
    for (const l of st.lobbies) list.append(lobbyRow(l, st));
  }

  function paint(s: AppState): void {
    const st = s.steam;
    if (!st) return;
    who.textContent = st.player ? `Signed in to Steam as ${st.player.name}` : 'Signing in to Steam...';
    whoSub.textContent = st.fake ? 'Testing with the stand-in: lobbies are this server’s rooms.' : 'Lobbies are hosted by players and joined through Steam.';
    fakeBadge.classList.toggle('hidden', !st.fake);
    if (!nameTouched && document.activeElement !== nameIn) nameIn.value = defaultName();
    const busy = st.phase !== 'idle';
    hostBtn.disabled = busy;
    setButtonLabel(hostBtn, st.phase === 'hosting' ? 'Starting your lobby...' : 'Host Lobby');
    busyBlock.classList.toggle('hidden', !busy);
    busyBlock.classList.toggle('in-lobby', st.phase === 'lobby');
    busyText.textContent = st.phase === 'hosting'
      ? 'Starting the game server and your Steam lobby...'
      : st.phase === 'joining'
        ? `Joining ${st.lobbyName || 'the lobby'} through Steam...`
        : st.phase === 'lobby'
          ? `You are in ${st.lobbyName || 'a Steam lobby'}.`
          : '';
    backToLobby.classList.toggle('hidden', !(st.phase === 'lobby' && s.room));
    setButtonLabel(leaveBtn, st.phase === 'lobby' ? 'Leave lobby' : 'Cancel');
    errBox.textContent = st.error ?? '';
    errBox.classList.toggle('hidden', !st.error);
    refresh.disabled = st.listing;
    refresh.classList.toggle('spinning', st.listing);
    listNote.textContent = st.listedAt ? `Updated ${new Date(st.listedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '';
    paintList(st);
  }
  paint(s0);
  void st0;

  // keep the list fresh while the screen is open (not while hosting or joining)
  const timer = window.setInterval(() => {
    const st = ctx.get().steam;
    if (st && st.phase === 'idle' && !st.listing) a.steamRefresh?.();
  }, AUTO_REFRESH_MS);
  // never from inside the build: the answer re-renders the screen that is being built
  const first = window.setTimeout(() => a.steamRefresh?.(), 0);

  return {
    el,
    update(s: AppState, prev: AppState) {
      if (s.steam !== prev.steam || s.room !== prev.room || s.profile !== prev.profile) paint(s);
    },
    destroy() {
      window.clearInterval(timer);
      window.clearTimeout(first);
    },
  };
}
