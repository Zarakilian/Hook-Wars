// Solo setup: the full match form, your team, and a big Start button.
import { getMap } from '../../../shared/maps/index.ts';
import type { MatchConfig, Team } from '../../../shared/types.ts';
import { TEAM_COLORS } from '../../render/contracts.ts';
import { createConfigForm } from '../configForm.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { RIVER_INFO } from '../info.ts';
import type { AppState } from '../types.ts';
import { button, segmented } from '../widgets.ts';

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

  const summary = h('div', { class: 'start-summary' });
  const paintSummary = () => {
    const m = getMap(cfg.mapId);
    summary.textContent = `${m.name} · ${RIVER_INFO[cfg.riverMode].name} · ${cfg.teamSize}v${cfg.teamSize} · first to ${cfg.killsToWin}`;
  };
  paintSummary();

  const start = button('Start Match', () => a.startSolo({ ...cfg, botFill: true }, team), { cls: 'primary big start-btn', icon: 'play' });
  const el = h('div', { class: 'scr scr-solo' },
    h('div', { class: 'panel wide-panel' },
      h('header', { class: 'panel-head' },
        button('Back', () => a.go('menu'), { cls: 'ghost', icon: 'left' }),
        h('h2', { class: 'panel-title', text: 'Solo vs Bots' }),
        h('span', { class: 'head-spacer' })),
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
