// Tab scoreboard: both teams side by side with kills, deaths, assists, hooks, accuracy, saves, gold.
import type { PlayerInfo, ScoreRow, Team } from '../../../shared/types.ts';
import { TEAM_COLORS } from '../../render/contracts.ts';
import { fmtTime, h } from '../dom.ts';
import { icon } from '../icons.ts';
import { RIVER_INFO } from '../info.ts';
import type { HudFrame } from '../types.ts';

export function statsTable(rows: ScoreRow[], players: Map<number, PlayerInfo> | PlayerInfo[], team: Team, youId: number, cols: 'board' | 'end'): HTMLElement {
  const get = (id: number) => (players instanceof Map ? players.get(id) : players.find((p) => p.id === id));
  const list = rows.filter((r) => get(r.i)?.team === team).sort((a, b) => b.k - a.k || a.d - b.d || b.hh - a.hh);
  const heads = cols === 'board' ? ['K', 'D', 'A', 'Hooks', 'Acc', 'Saves', 'Gold'] : ['K', 'D', 'A', 'Hooks', 'Acc', 'Drowns', 'Saves', 'Dmg', 'Gold'];
  const table = h('table', { class: `stats t${team}` });
  table.append(h('thead', {}, h('tr', {}, h('th', { class: 'st-name', scope: 'col' }, h('span', { class: 'st-team', text: TEAM_COLORS[team].name })), ...heads.map((x) => h('th', { scope: 'col', text: x })))));
  const body = h('tbody');
  for (const r of list) {
    const p = get(r.i);
    const acc = r.ht ? `${Math.round((r.hh / r.ht) * 100)}%` : '-';
    const vals = cols === 'board'
      ? [r.k, r.d, r.a, `${r.hh}/${r.ht}`, acc, r.sv, r.g]
      : [r.k, r.d, r.a, `${r.hh}/${r.ht}`, acc, r.dr, r.sv, r.dmg, r.g];
    body.append(h('tr', { class: r.i === youId ? 'you' : '' },
      h('td', { class: 'st-name' }, p ? icon(p.family, 'st-fam') : null, h('span', { class: 'st-pname', text: p?.name ?? '?' }), p?.isBot ? h('span', { class: 'st-bot', text: 'BOT' }) : null),
      ...vals.map((v) => h('td', { text: String(v) }))));
  }
  if (list.length === 0) body.append(h('tr', {}, h('td', { class: 'st-empty', colspan: heads.length + 1, text: 'Nobody here' })));
  table.append(body);
  return table;
}

export class Scoreboard {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly score: HTMLElement;
  private readonly meta: HTMLElement;
  private lastRows: ScoreRow[] | null = null;
  visible = false;

  constructor() {
    this.score = h('div', { class: 'sb-score' });
    this.meta = h('div', { class: 'sb-meta' });
    this.body = h('div', { class: 'sb-body' });
    this.el = h('div', { class: 'scoreboard hidden', role: 'dialog', 'aria-label': 'Scoreboard' },
      h('div', { class: 'panel sb-panel' },
        h('header', { class: 'panel-head' }, h('h2', { class: 'panel-title', text: 'Scoreboard' }), this.score, this.meta),
        this.body));
  }

  reset(): void {
    this.lastRows = null;
  }

  show(on: boolean, f: HudFrame | null): void {
    this.visible = on;
    this.el.classList.toggle('hidden', !on);
    if (on && f) {
      this.lastRows = null;
      this.frame(f);
    }
  }

  frame(f: HudFrame): void {
    if (!this.visible || f.scoreboard === this.lastRows) return;
    this.lastRows = f.scoreboard;
    this.score.replaceChildren(
      h('span', { class: 'sbs t0', text: String(f.score[0]) }),
      h('span', { class: 'sbs-dash', text: '–' }),
      h('span', { class: 'sbs t1', text: String(f.score[1]) }));
    const river = f.config.riverMode === 'tidal' && !f.map.tide ? 'deep' : f.config.riverMode;
    this.meta.textContent = `${f.map.name} · ${RIVER_INFO[river].name} · first to ${f.config.killsToWin} · ${f.overtime ? 'overtime' : fmtTime(f.timeLeft)}`;
    this.body.replaceChildren(statsTable(f.scoreboard, f.players, 0, f.youId, 'board'), statsTable(f.scoreboard, f.players, 1, f.youId, 'board'));
  }
}
