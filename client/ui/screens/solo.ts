// Solo setup: quick presets (Practice, Skirmish, Full Crew), the full match form with a card per
// map, your team, and a big Start button. Presets only change the match config.
import { getMap } from '../../../shared/maps/index.ts';
import type { MatchConfig, Team } from '../../../shared/types.ts';
import { TEAM_COLORS } from '../../render/contracts.ts';
import { createConfigForm } from '../configForm.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { RIVER_INFO } from '../info.ts';
import type { AppState } from '../types.ts';
import { icon, type IconId } from '../icons.ts';
import { button, clickSound, segmented } from '../widgets.ts';

interface Preset {
  id: string;
  name: string;
  line: string;
  icon: IconId;
  patch: Partial<MatchConfig>;
}

/** Values come from the form's own option lists (kills 5..50, time 3..30 min). */
const PRESETS: Preset[] = [
  { id: 'practice', name: 'Practice', line: '1v1 vs an Easy bot, 30 min, no hazards', icon: 'target', patch: { teamSize: 1, botDifficulty: 'easy', timeLimitSec: 1800, killsToWin: 50, hazards: 'none' } },
  { id: 'skirmish', name: 'Skirmish', line: '3v3 vs Normal bots, first to 15', icon: 'hook', patch: { teamSize: 3, botDifficulty: 'normal', timeLimitSec: 600, killsToWin: 15 } },
  { id: 'crew', name: 'Full Crew', line: '5v5 vs Hard bots, first to 30', icon: 'people', patch: { teamSize: 5, botDifficulty: 'hard', timeLimitSec: 900, killsToWin: 30 } },
];

function matches(cfg: MatchConfig, p: Preset): boolean {
  return (Object.keys(p.patch) as (keyof MatchConfig)[]).every((k) => cfg[k] === p.patch[k]);
}

export function buildSolo(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;
  let cfg: MatchConfig = { ...s0.settings.soloConfig, botFill: true };
  let team: Team = s0.settings.soloTeam;

  const persist = () => {
    const s = ctx.get();
    a.saveSettings({ ...s.settings, soloConfig: cfg, soloTeam: team });
  };

  const teamSeg = segmented<Team>({
    label: 'Your team',
    cls: 'seg-team',
    value: team,
    options: ([0, 1] as Team[]).map((t) => ({ value: t, label: TEAM_COLORS[t].name, sub: t === 0 ? 'West bank' : 'East bank', cls: `team-${t}`, icon: 'flag' })),
    onChange: (t) => {
      team = t;
      persist();
    },
  });
  const teamRow = h('div', { class: 'rule' }, h('span', { class: 'rule-label', text: 'Your team' }), teamSeg.el);

  const form = createConfigForm({
    variant: 'solo',
    cfg,
    extra: teamRow,
    onChange: (c) => {
      cfg = { ...c, botFill: true };
      persist();
      paintSummary();
    },
  });

  const presetBtns = PRESETS.map((p) => {
    const b = h('button', { class: 'preset', type: 'button', title: p.line }, icon(p.icon, 'pr-ico'), h('span', { class: 'pr-texts' }, h('span', { class: 'pr-name', text: p.name }), h('span', { class: 'pr-line', text: p.line })));
    b.addEventListener('click', () => {
      clickSound();
      cfg = { ...cfg, ...p.patch, botFill: true };
      form.set(cfg);
      persist();
      paintSummary();
    });
    return { p, b };
  });
  const presets = h('div', { class: 'presets', role: 'group', 'aria-label': 'Quick presets' }, h('span', { class: 'pr-title', text: 'Quick start' }), ...presetBtns.map((x) => x.b));

  const summary = h('div', { class: 'start-summary' });
  const paintSummary = () => {
    const m = getMap(cfg.mapId);
    summary.textContent = `${m.name} · ${RIVER_INFO[cfg.riverMode].name} · ${cfg.teamSize}v${cfg.teamSize} · first to ${cfg.killsToWin}`;
    for (const x of presetBtns) x.b.classList.toggle('on', matches(cfg, x.p));
  };
  paintSummary();

  const start = button('Start Match', () => a.startSolo({ ...cfg, botFill: true }, team), { cls: 'primary big start-btn', icon: 'play' });
  const el = h('div', { class: 'scr scr-solo' },
    h('div', { class: 'panel wide-panel' },
      h('header', { class: 'panel-head' },
        button('Back', () => a.go('menu'), { cls: 'ghost', icon: 'left' }),
        h('h2', { class: 'panel-title', text: 'Solo vs Bots' }),
        h('span', { class: 'head-spacer' }),
        presets),
      h('div', { class: 'panel-body' }, form.el),
      h('footer', { class: 'panel-foot' }, summary, start)),
  );

  return {
    el,
    update(s: AppState, prev: AppState) {
      if (s.settings.soloConfig !== prev.settings.soloConfig || s.settings.soloTeam !== prev.settings.soloTeam) {
        cfg = { ...s.settings.soloConfig, botFill: true };
        team = s.settings.soloTeam;
        form.set(cfg);
        teamSeg.set(team);
        paintSummary();
      }
    },
    destroy() {},
  };
}
