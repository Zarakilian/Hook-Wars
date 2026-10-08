// End of match: the winner banner, final score, fun awards and the full stats table.
import type { MatchEnd } from '../../../shared/protocol.ts';
import type { PlayerInfo, ScoreRow, Team } from '../../../shared/types.ts';
import { TEAM_COLORS } from '../../render/contracts.ts';
import { h } from '../dom.ts';
import { icon, type IconId } from '../icons.ts';
import { button } from '../widgets.ts';
import { statsTable } from './scoreboard.ts';

interface Award {
  title: string;
  icon: IconId;
  line: string;
  pick: (r: ScoreRow) => number;
  fmt: (v: number, r: ScoreRow) => string;
  ok?: (r: ScoreRow) => boolean;
}

const AWARDS: Award[] = [
  { title: 'Most Hooks', icon: 'hook', line: 'Landed the most hooks', pick: (r) => r.hh, fmt: (v) => `${v} ${v === 1 ? 'hook' : 'hooks'}` },
  { title: 'Sharpshooter', icon: 'target', line: 'Best accuracy (5+ throws)', pick: (r) => (r.ht ? r.hh / r.ht : 0), fmt: (v, r) => `${Math.round(v * 100)}% (${r.hh}/${r.ht})`, ok: (r) => r.ht >= 5 },
  { title: 'Drowner', icon: 'drown', line: 'Sent the most to the bottom', pick: (r) => r.dr, fmt: (v) => `${v} dunked` },
  { title: 'Lifeguard', icon: 'lifebuoy', line: 'Hooked allies to safety', pick: (r) => r.sv, fmt: (v) => `${v} ${v === 1 ? 'save' : 'saves'}` },
  { title: 'Tank', icon: 'ironskin', line: 'Dealt the most damage', pick: (r) => r.dmg, fmt: (v) => `${Math.round(v)} damage` },
];

function confetti(): HTMLElement {
  const colors = ['#ffd25a', '#ff8f45', '#7ff0ff', '#e0533d', '#3d8be0', '#9fe07a', '#fff3d9'];
  const wrap = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < 46; i++) {
    const x = (i * 61) % 100;
    const d = ((i * 37) % 100) / 100;
    wrap.append(h('span', { class: 'cf', style: `--x:${x}%;--d:${(d * 1.6).toFixed(2)}s;--r:${(i * 47) % 360}deg;--c:${colors[i % colors.length]};--s:${0.7 + ((i * 13) % 10) / 14}` }));
  }
  return wrap;
}

export function buildEnd(e: MatchEnd, youId: number, local: boolean, onLeave: () => void, onRematch: (() => void) | null, onLobby: (() => void) | null = null): HTMLElement {
  const you = e.players.find((p) => p.id === youId);
  const myTeam = you?.team;
  const won = myTeam !== undefined && e.winner === myTeam;
  const draw = e.winner === -1;
  const title = draw ? 'DRAW!' : myTeam === undefined ? `${TEAM_COLORS[e.winner as Team].name.toUpperCase()} WINS` : won ? 'VICTORY!' : 'DEFEAT';
  const sub = draw
    ? 'Nobody caught enough fish.'
    : won
      ? `${TEAM_COLORS[e.winner as Team].name} rules the river`
      : myTeam === undefined
        ? 'What a match.'
        : `${TEAM_COLORS[e.winner as Team].name} took the catch this time`;
  const tone = draw ? 'draw' : won || myTeam === undefined ? `win t${e.winner}` : `lose t${e.winner}`;

  const byId = new Map<number, PlayerInfo>(e.players.map((p) => [p.id, p]));
  const awards = h('div', { class: 'awards' });
  AWARDS.forEach((a, i) => {
    let best: ScoreRow | null = null;
    let bv = 0;
    for (const r of e.rows) {
      if (a.ok && !a.ok(r)) continue;
      const v = a.pick(r);
      if (v > bv) {
        bv = v;
        best = r;
      }
    }
    const p = best ? byId.get(best.i) : undefined;
    awards.append(h('div', { class: `award ${best ? '' : 'none'} ${best && best.i === youId ? 'you' : ''}`, style: `--i:${i}` },
      h('span', { class: 'aw-ico' }, icon(a.icon)),
      h('span', { class: 'aw-title', text: a.title }),
      h('span', { class: `aw-who t${p?.team ?? 0}`, text: best ? (best.i === youId ? `${p?.name ?? '?'} (you)` : p?.name ?? '?') : 'Nobody' }),
      h('span', { class: 'aw-val', text: best ? a.fmt(bv, best) : a.line })));
  });

  const scoreRow = h('div', { class: 'end-score' },
    h('span', { class: `es-team t0 ${e.winner === 0 ? 'won' : ''}` }, h('span', { class: 'es-name', text: TEAM_COLORS[0].name }), h('span', { class: 'es-num', text: String(e.score[0]) })),
    h('span', { class: 'es-dash', text: '–' }),
    h('span', { class: `es-team t1 ${e.winner === 1 ? 'won' : ''}` }, h('span', { class: 'es-num', text: String(e.score[1]) }), h('span', { class: 'es-name', text: TEAM_COLORS[1].name })));

  const buttons = h('div', { class: 'end-buttons' });
  if (onRematch) buttons.append(button('Rematch', onRematch, { cls: 'big', icon: 'refresh' }));
  if (onLobby) buttons.append(button('Back to lobby', onLobby, { cls: 'primary big', icon: 'anchor' }));
  buttons.append(button(local ? 'Back to setup' : 'Leave room', onLeave, { cls: local ? 'primary big' : 'big', icon: 'left' }));
  const note = local ? null : h('div', { class: 'end-note' }, icon('clock'), h('span', { text: 'Returning to the lobby automatically...' }));

  return h('div', { class: `end-screen ${tone}`, role: 'dialog', 'aria-label': 'Match over' },
    won || (myTeam === undefined && !draw) ? confetti() : null,
    h('div', { class: 'panel end-panel' },
      h('div', { class: 'end-banner' }, h('span', { class: 'eb-ico' }, icon(draw ? 'anchor' : won ? 'trophy' : myTeam === undefined ? 'crown' : 'drown')), h('span', { class: 'eb-text', text: title })),
      h('div', { class: 'end-sub', text: sub }),
      scoreRow,
      awards,
      h('div', { class: 'end-tables' }, statsTable(e.rows, e.players, 0, youId, 'end'), statsTable(e.rows, e.players, 1, youId, 'end')),
      note,
      buttons));
}
