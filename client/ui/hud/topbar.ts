// Top of the HUD: team score plaque, match clock or OVERTIME, first-to target, the river phase
// widget (tide, locks or ice) and the ping / FPS tag.
import { TEAM_COLORS } from '../../render/contracts.ts';
import type { Settings } from '../../settings.ts';
import { fmtTime, h, pulse, setAttr, setClass, setDisplay, setText, setTransform } from '../dom.ts';
import { icon, setIcon, type IconId } from '../icons.ts';
import { phaseInfo, RIVER_INFO } from '../info.ts';
import type { HudFrame } from '../types.ts';

export class TopBar {
  readonly el: HTMLElement;
  readonly net: HTMLElement;
  private readonly score: [HTMLElement, HTMLElement];
  private readonly teams: [HTMLElement, HTMLElement];
  private readonly you: [HTMLElement, HTMLElement];
  private readonly time: HTMLElement;
  private readonly target: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly river: HTMLElement;
  private readonly riverIco: SVGSVGElement;
  private readonly riverLabel: HTMLElement;
  private readonly riverHint: HTMLElement;
  private readonly riverSecs: HTMLElement;
  private readonly riverBar: HTMLElement;
  private readonly ping: HTMLElement;
  private readonly fps: HTMLElement;
  private last: [number, number] = [-1, -1];
  private fpsShown = -1;
  private fpsAt = 0;

  constructor() {
    const team = (t: 0 | 1) => {
      const sc = h('span', { class: 'sp-score', text: '0' });
      const you = h('span', { class: 'sp-you', text: 'YOU' });
      const el = h('div', { class: `sp-team t${t}` },
        h('span', { class: 'sp-flag' }, icon('flag')),
        h('span', { class: 'sp-texts' }, h('span', { class: 'sp-name', text: TEAM_COLORS[t].name }), you),
        sc);
      return { el, sc, you };
    };
    const a = team(0);
    const b = team(1);
    this.score = [a.sc, b.sc];
    this.teams = [a.el, b.el];
    this.you = [a.you, b.you];
    this.time = h('span', { class: 'sp-time', text: '0:00' });
    this.target = h('span', { class: 'sp-target' });
    this.clock = h('div', { class: 'sp-clock' }, this.time, this.target);
    const plaque = h('div', { class: 'score-plaque' }, a.el, this.clock, b.el);

    this.riverIco = icon('wave', 'rc-ico');
    this.riverLabel = h('span', { class: 'rc-label' });
    this.riverHint = h('span', { class: 'rc-hint' });
    this.riverSecs = h('span', { class: 'rc-secs' });
    this.riverBar = h('span', { class: 'rc-bar-fill' });
    this.river = h('div', { class: 'river-chip' },
      this.riverIco,
      h('span', { class: 'rc-texts' }, this.riverLabel, this.riverHint),
      this.riverSecs,
      h('span', { class: 'rc-bar' }, this.riverBar));
    this.el = h('div', { class: 'hud-top' }, plaque, this.river);

    this.ping = h('span', { class: 'net-ping' });
    this.fps = h('span', { class: 'net-fps' });
    this.net = h('div', { class: 'hud-net' }, this.ping, this.fps);
  }

  reset(): void {
    this.last = [-1, -1];
    this.fpsShown = -1;
    for (const e of this.score) e.textContent = '0';
  }

  frame(f: HudFrame, settings: Settings): void {
    // scores
    for (const t of [0, 1] as const) {
      const v = f.score[t];
      if (v !== this.last[t]) {
        setText(this.score[t], String(v));
        if (this.last[t] >= 0 && v > this.last[t]) pulse(this.score[t], 'bump');
        this.last[t] = v;
      }
      setClass(this.teams[t], 'lead', f.score[t] > f.score[t === 0 ? 1 : 0]);
    }
    const myTeam = f.youId >= 0 ? f.players.get(f.youId)?.team : undefined;
    setDisplay(this.you[0], myTeam === 0);
    setDisplay(this.you[1], myTeam === 1);

    // clock
    if (f.phase === 'countdown') {
      setText(this.time, 'READY');
      setClass(this.clock, 'ot', false);
      setClass(this.clock, 'late', false);
    } else if (f.overtime) {
      setText(this.time, 'OVERTIME');
      setClass(this.clock, 'ot', true);
    } else {
      setText(this.time, fmtTime(f.timeLeft));
      setClass(this.clock, 'ot', false);
      setClass(this.clock, 'late', f.timeLeft <= 60 && f.phase === 'playing');
    }
    setText(this.target, f.overtime ? 'NEXT CATCH WINS' : `FIRST TO ${f.config.killsToWin}`);

    // river widget
    const r = f.river;
    if (r.cycle) {
      const p = phaseInfo(r.phase, f.map);
      setIcon(this.riverIco, p.icon);
      setText(this.riverLabel, p.label);
      setText(this.riverHint, p.hint);
      setText(this.riverSecs, `${Math.max(0, Math.ceil(r.phaseLeft))}s`);
      const frac = Math.max(0, Math.min(1, r.phaseLeft / Math.max(0.1, p.total)));
      setTransform(this.riverBar, `scaleX(${frac.toFixed(3)})`);
      setAttr(this.river, 'data-tone', p.tone);
      setDisplay(this.riverSecs, true);
      setClass(this.river, 'cycle', true);
    } else {
      const mode = f.config.riverMode === 'dry' ? 'dry' : 'deep';
      const info = RIVER_INFO[mode];
      setIcon(this.riverIco, info.icon as IconId);
      setText(this.riverLabel, info.name);
      setText(this.riverHint, mode === 'dry' ? 'walk the channel' : 'falling in drowns you');
      setDisplay(this.riverSecs, false);
      setAttr(this.river, 'data-tone', mode === 'dry' ? 'safe' : 'deep');
      setClass(this.river, 'cycle', false);
    }

    // network and fps (fps text refreshes 4 times a second so it is readable)
    setDisplay(this.ping, !f.local);
    if (!f.local) {
      const ms = Math.round(f.ping);
      setText(this.ping, `${ms} ms`);
      setClass(this.ping, 'bad', ms > 160);
    }
    setDisplay(this.fps, settings.showFps);
    if (settings.showFps) {
      const now = performance.now();
      if (now - this.fpsAt > 250) {
        this.fpsAt = now;
        const v = Math.round(f.fps);
        if (v !== this.fpsShown) {
          this.fpsShown = v;
          setText(this.fps, `${v} fps`);
        }
      }
    }
    setDisplay(this.net, !f.local || settings.showFps);
  }
}
