// Lobby: 5v5 slot grid, spectators, host-only rules, ready and start, room code copy and chat.
import { FAMILY_DEFS, MAX_CHAT_LEN, MAX_TEAM_SIZE } from '../../../shared/constants.ts';
import type { LobbySlot, RoomState } from '../../../shared/protocol.ts';
import type { Team } from '../../../shared/types.ts';
import { TEAM_COLORS } from '../../render/contracts.ts';
import { createConfigForm } from '../configForm.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { icon, setIcon } from '../icons.ts';
import { BOT_NAMES_UI } from '../info.ts';
import type { AppState, ChatLine } from '../types.ts';
import { button, sectionTitle, setButtonLabel } from '../widgets.ts';

interface SlotEl {
  el: HTMLElement;
  fam: SVGSVGElement;
  name: HTMLElement;
  sub: HTMLElement;
  star: HTMLElement;
  ready: HTMLElement;
  ping: HTMLElement;
}

function makeSlot(): SlotEl {
  const fam = icon('brawler', 'slot-fam');
  const name = h('span', { class: 'slot-name' });
  const sub = h('span', { class: 'slot-sub' });
  const star = h('span', { class: 'slot-star', title: 'Host' }, icon('star'));
  const ready = h('span', { class: 'slot-ready' });
  const ping = h('span', { class: 'slot-ping' });
  const el = h('div', { class: 'slot' }, h('span', { class: 'slot-fam-wrap' }, fam), h('span', { class: 'slot-main' }, h('span', { class: 'slot-top' }, name, star), sub), ready, ping);
  return { el, fam, name, sub, star, ready, ping };
}

function pingClass(ms: number): string {
  return ms < 80 ? 'good' : ms < 160 ? 'ok' : 'bad';
}

/** Copy text to the clipboard: the async API first, then a hidden textarea fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the fallback
  }
  try {
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function buildLobby(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;
  let room: RoomState = s0.room!;
  const youId = () => ctx.get().online.youId;

  // ---------------------------------------------------------------- header
  const title = h('h2', { class: 'panel-title lobby-title' });
  const privBadge = h('span', { class: 'priv-badge' }, icon('padlock'), h('span', { text: 'Private' }));
  const codeText = h('span', { class: 'code-text' });
  const copyBtn = button('Copy', async () => {
    const ok = await copyText(room.code);
    setButtonLabel(copyBtn, ok ? 'Copied!' : 'Press Ctrl+C');
    copyBtn.classList.toggle('copied', ok);
    if (!ok) {
      const range = document.createRange();
      range.selectNodeContents(codeText);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    window.setTimeout(() => {
      setButtonLabel(copyBtn, 'Copy');
      copyBtn.classList.remove('copied');
    }, 1600);
  }, { icon: 'copy', cls: 'copy-btn' });
  const codePlate = h('div', { class: 'code-plate' }, h('span', { class: 'code-label', text: 'Room code' }), codeText, copyBtn);

  // ---------------------------------------------------------------- teams
  const teamCols = ([0, 1] as Team[]).map((t) => {
    const count = h('span', { class: 'tc-count' });
    const joinBtn = button('Join', () => a.setTeam(t), { cls: 'small', icon: 'right' });
    const slotsEl = h('div', { class: 'tc-slots' });
    const slots: SlotEl[] = [];
    for (let i = 0; i < MAX_TEAM_SIZE; i++) {
      const sl = makeSlot();
      slots.push(sl);
      slotsEl.append(sl.el);
    }
    const col = h('div', { class: `team-col team-${t}` },
      h('div', { class: 'tc-head' }, icon('flag', 'tc-flag'), h('span', { class: 'tc-name', text: TEAM_COLORS[t].name }), count, joinBtn),
      slotsEl);
    return { t, col, count, joinBtn, slots };
  });

  const specList = h('div', { class: 'spec-list' });
  const specBtn = button('Spectate', () => a.setTeam(-1), { cls: 'small ghost', icon: 'eye' });
  const specRow = h('div', { class: 'spec-row' }, h('span', { class: 'spec-label' }, icon('eye'), h('span', { text: 'Spectators' })), specList, specBtn);

  // ---------------------------------------------------------------- chat
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
  const chatIn = h('input', { class: 'text-in chat-in', maxlength: MAX_CHAT_LEN, placeholder: 'Say something nice (or salty)', 'aria-label': 'Chat message', autocomplete: 'off' });
  const send = () => {
    const v = chatIn.value.trim();
    if (!v) return;
    a.sendChat(v, false);
    chatIn.value = '';
  };
  chatIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  const chat = h('div', { class: 'lobby-chat cloth' }, log, h('div', { class: 'chat-row' }, chatIn, button('Send', send, { cls: 'small', icon: 'enter' })));
  let lastLine: ChatLine | null = null;
  const lineEl = (c: ChatLine) => {
    const row = h('div', { class: `chat-line ${c.system ? 'sys' : ''} ${c.teamId === 0 || c.teamId === 1 ? `t${c.teamId}` : ''}` });
    if (!c.system) row.append(h('span', { class: 'cl-from', text: `${c.from}:` }));
    row.append(h('span', { class: 'cl-text', text: ` ${c.text}` }));
    return row;
  };
  const paintChat = (lines: ChatLine[]) => {
    const idx = lastLine ? lines.lastIndexOf(lastLine) : -1;
    if (lastLine && idx < 0) log.replaceChildren();
    const from = idx >= 0 ? idx + 1 : 0;
    if (from >= lines.length) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    for (let i = from; i < lines.length; i++) log.append(lineEl(lines[i]));
    while (log.childElementCount > 60) log.firstElementChild?.remove();
    lastLine = lines[lines.length - 1];
    if (atBottom || from === 0) log.scrollTop = log.scrollHeight;
  };
  if (s0.chat.length === 0) log.append(h('div', { class: 'chat-line sys' }, h('span', { class: 'cl-text', text: 'Welcome aboard. Share the room code with your friends.' })));

  // ---------------------------------------------------------------- config + footer
  const form = createConfigForm({ variant: 'lobby', cfg: room.config, locked: room.hostId !== youId(), onChange: (c) => a.setConfig(c) });
  const readyBtn = button('Ready', () => {
    const me = room.players.find((p) => p.id === youId());
    a.setReady(!me?.ready);
  }, { cls: 'big ready-btn', icon: 'check' });
  const startBtn = button('Start Match', () => a.startMatch(), { cls: 'primary big', icon: 'play' });
  const status = h('div', { class: 'lobby-status' });
  const matchBanner = h('div', { class: 'match-banner hidden' }, icon('clock'), h('span', { text: 'A match is running in this room. You will join the next one.' }));

  const el = h('div', { class: 'scr scr-lobby' },
    h('div', { class: 'panel wide-panel lobby-panel' },
      h('header', { class: 'panel-head' }, button('Leave', () => a.leaveRoom(), { cls: 'ghost', icon: 'left' }), h('div', { class: 'lobby-head-mid' }, title, privBadge), codePlate),
      matchBanner,
      h('div', { class: 'panel-body lobby-body' },
        h('div', { class: 'lobby-left' },
          h('div', { class: 'teams-row' }, teamCols[0].col, h('div', { class: 'vs-badge', 'aria-hidden': 'true', text: 'VS' }), teamCols[1].col),
          specRow,
          chat),
        h('div', { class: 'lobby-right' }, sectionTitle('Match rules', 'clock'), form.el)),
      h('footer', { class: 'panel-foot' }, status, h('span', { class: 'head-spacer' }), readyBtn, startBtn)));

  function paintSlot(sl: SlotEl, p: LobbySlot | null, t: Team): void {
    const s = ctx.get();
    if (!p) {
      sl.el.className = `slot empty ${room.config.botFill ? 'bot' : 'open'}`;
      setIcon(sl.fam, room.config.botFill ? 'bot' : 'people');
      sl.name.textContent = room.config.botFill ? 'Bot' : 'Open slot';
      sl.sub.textContent = room.config.botFill ? `${BOT_NAMES_UI[room.config.botDifficulty].name} bot fills in` : 'Waiting for a player';
      sl.ready.textContent = '';
      sl.ping.textContent = '';
      sl.star.classList.add('hidden');
      return;
    }
    const me = p.id === s.online.youId;
    sl.el.className = `slot filled ${me ? 'me' : ''} ${p.ready ? 'is-ready' : ''} t${t}`;
    setIcon(sl.fam, p.family);
    sl.name.textContent = p.name;
    sl.sub.textContent = `${FAMILY_DEFS[p.family].name}${me ? ' · you' : ''}`;
    sl.star.classList.toggle('hidden', !p.host);
    sl.ready.replaceChildren(p.ready ? icon('check') : h('span', { text: '...' }));
    sl.ready.className = `slot-ready ${p.ready ? 'on' : ''}`;
    sl.ready.title = p.ready ? 'Ready' : 'Not ready';
    sl.ping.textContent = p.isBot ? '' : `${Math.round(p.ping)} ms`;
    sl.ping.className = `slot-ping ${pingClass(p.ping)}`;
  }

  function paint(s: AppState): void {
    if (!s.room) return;
    room = s.room;
    const me = room.players.find((p) => p.id === s.online.youId) ?? null;
    const isHost = room.hostId === s.online.youId;
    title.textContent = room.name;
    privBadge.classList.toggle('hidden', !room.isPrivate);
    codeText.textContent = room.code;
    for (const tc of teamCols) {
      const players = room.players.filter((p) => p.team === tc.t);
      const n = Math.max(room.config.teamSize, players.length);
      tc.count.textContent = `${players.length}/${room.config.teamSize}`;
      tc.joinBtn.classList.toggle('hidden', !!me && me.team === tc.t);
      tc.joinBtn.disabled = players.length >= room.config.teamSize;
      tc.slots.forEach((sl, i) => {
        sl.el.classList.toggle('hidden', i >= n);
        if (i < n) paintSlot(sl, players[i] ?? null, tc.t);
      });
    }
    const specs = room.players.filter((p) => p.team === -1);
    specList.replaceChildren(...(specs.length ? specs.map((p) => h('span', { class: `spec-chip ${p.id === s.online.youId ? 'me' : ''}` }, p.host ? icon('star') : null, h('span', { text: p.name }))) : [h('span', { class: 'muted', text: 'Nobody yet' })]));
    specBtn.classList.toggle('hidden', !!me && me.team === -1);
    form.set(room.config, !isHost);
    const humans = room.players.filter((p) => p.team !== -1);
    const readyN = humans.filter((p) => p.ready).length;
    status.textContent = humans.length === 0
      ? 'Join a team to play.'
      : `${readyN}/${humans.length} ready${isHost ? ' · you are the host: start when you like' : ' · waiting for the host to start'}`;
    setButtonLabel(readyBtn, me?.ready ? 'Ready!' : 'Ready up');
    readyBtn.classList.toggle('on', !!me?.ready);
    readyBtn.disabled = !me || me.team === -1;
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = room.phase === 'match';
    matchBanner.classList.toggle('hidden', room.phase !== 'match');
  }
  paint(s0);
  paintChat(s0.chat);

  return {
    el,
    update(s: AppState, prev: AppState) {
      if (s.room !== prev.room || s.online.youId !== prev.online.youId) paint(s);
      if (s.chat !== prev.chat) paintChat(s.chat);
    },
    destroy() {},
  };
}
