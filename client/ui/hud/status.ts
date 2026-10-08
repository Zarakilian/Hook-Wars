// Full-screen status layers: the respawn card, the drowning warning with its countdown, the low
// health vignette and a quick red flash when you take a hit.
import { UnitState, type KillCause } from '../../../shared/types.ts';
import type { Settings } from '../../settings.ts';
import { h, pulse, setClass, setDisplay, setText, setVar } from '../dom.ts';
import { icon } from '../icons.ts';
import { ABILITY_KEYS, DEATH_TITLES, TIPS, deathLine } from '../info.ts';
import type { HudFrame } from '../types.ts';

export class StatusLayers {
  readonly el: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly respawn: HTMLElement;
  private readonly rsTitle: HTMLElement;
  private readonly rsLine: HTMLElement;
  private readonly rsSecs: HTMLElement;
  private readonly rsRing: HTMLElement;
  private readonly rsTip: HTMLElement;
  private readonly drown: HTMLElement;
  private readonly drSecs: HTMLElement;
  private readonly drHint: HTMLElement;
  private wasDead = false;
  private rtMax = 5;
  private lastCause: KillCause | null = null;
  private lastKiller: string | null = null;

  constructor() {
    this.vignette = h('div', { class: 'vignette' });
    this.flash = h('div', { class: 'hit-flash' });
    this.rsTitle = h('div', { class: 'rs-title' });
    this.rsLine = h('div', { class: 'rs-line' });
    this.rsSecs = h('span', { class: 'rs-secs' });
    this.rsRing = h('div', { class: 'rs-ring' }, this.rsSecs);
    this.rsTip = h('div', { class: 'rs-tip' });
    this.respawn = h('div', { class: 'respawn hidden' },
      h('div', { class: 'rs-card' }, this.rsTitle, this.rsLine, this.rsRing, h('div', { class: 'rs-label', text: 'Back on the bank in' }), this.rsTip));
    this.drSecs = h('span', { class: 'dr-secs' });
    this.drHint = h('span', { class: 'dr-hint' });
    this.drown = h('div', { class: 'drown hidden' },
      h('div', { class: 'dr-bubbles', 'aria-hidden': 'true' }, ...Array.from({ length: 14 }, (_, i) => h('span', { class: 'dr-b', style: `--i:${i};--x:${(i * 37) % 100}%` }))),
      h('div', { class: 'dr-card' }, icon('drown', 'dr-ico'), h('div', { class: 'dr-texts' }, h('span', { class: 'dr-title', text: 'DROWNING!' }), this.drHint), this.drSecs));
    this.el = h('div', { class: 'status-layers' }, this.vignette, this.flash, this.drown, this.respawn);
  }

  reset(): void {
    this.wasDead = false;
    this.lastCause = null;
    this.lastKiller = null;
    this.respawn.classList.add('hidden');
    this.drown.classList.add('hidden');
    setClass(this.vignette, 'low', false);
  }

  /** Remember how you died, for the respawn card. */
  died(cause: KillCause, killer: string | null): void {
    this.lastCause = cause;
    this.lastKiller = killer;
  }

  hit(): void {
    pulse(this.flash, 'on');
  }

  frame(f: HudFrame, settings: Settings): void {
    const me = f.me;
    const you = f.you;
    const dead = !!me && me.st === UnitState.Dead;
    if (dead && !this.wasDead) {
      this.rtMax = Math.max(1, me.rt ?? 5);
      setText(this.rsTitle, DEATH_TITLES[Math.floor(Math.random() * DEATH_TITLES.length)]);
      setText(this.rsTip, `Tip: ${TIPS[Math.floor(Math.random() * TIPS.length)]}`);
      this.respawn.classList.remove('hidden');
      pulse(this.respawn, 'in');
    } else if (!dead && this.wasDead) {
      this.respawn.classList.add('hidden');
      this.lastCause = null;
      this.lastKiller = null;
    }
    this.wasDead = dead;
    if (dead && me) {
      setText(this.rsLine, this.lastCause ? deathLine(this.lastCause, this.lastKiller) : '\u00a0');
      const rt = Math.max(0, me.rt ?? 0);
      setText(this.rsSecs, String(Math.ceil(rt)));
      setVar(this.rsRing, '--p', Math.max(0, Math.min(1, rt / this.rtMax)).toFixed(3));
    }

    const drowning = !!you && you.drown > 0 && !dead;
    if (drowning && you) {
      if (this.drown.classList.contains('hidden')) {
        this.drown.classList.remove('hidden');
        pulse(this.drown, 'in');
      }
      setText(this.drSecs, you.drown.toFixed(1));
      const grappleReady = you.cd[1] <= 0.05;
      setText(this.drHint, grappleReady ? `Grapple out NOW! (${ABILITY_KEYS[settings.controls][1]})` : 'Swim for the bank, or hope for a friendly hook!');
      setClass(this.drown, 'urgent', you.drown < 0.9);
    } else if (!this.drown.classList.contains('hidden')) {
      this.drown.classList.add('hidden');
    }

    const frac = me && me.mhp > 0 ? me.hp / me.mhp : 1;
    setClass(this.vignette, 'low', !dead && frac <= 0.25);
    setClass(this.vignette, 'drowning', drowning);
    setDisplay(this.vignette, true);
  }
}
