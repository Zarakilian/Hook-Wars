// In-match chat: lines fade out after a while; Enter opens the box for all, Shift+Enter for team.
import { MAX_CHAT_LEN } from '../../../shared/constants.ts';
import { h } from '../dom.ts';
import type { AppActions, ChatLine } from '../types.ts';

export class HudChat {
  readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly tag: HTMLElement;
  private readonly box: HTMLElement;
  private team = false;
  private readonly actions: AppActions;
  focused = false;

  constructor(actions: AppActions) {
    this.actions = actions;
    this.log = h('div', { class: 'hc-log', role: 'log', 'aria-live': 'polite' });
    this.tag = h('span', { class: 'hc-tag' });
    this.input = h('input', { class: 'hc-in', maxlength: MAX_CHAT_LEN, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Chat message' });
    this.box = h('div', { class: 'hc-box hidden' }, this.tag, this.input, h('span', { class: 'hc-help', text: 'Enter send · Esc cancel' }));
    this.el = h('div', { class: 'hud-chat' }, this.log, this.box);
    this.input.addEventListener('focus', () => (this.focused = true));
    this.input.addEventListener('blur', () => this.close());
    this.input.addEventListener('keydown', (e) => {
      const k = e.key;
      e.stopPropagation();
      if (k === 'Enter') {
        e.preventDefault();
        const v = this.input.value.trim();
        if (v) this.actions.sendChat(v, this.team);
        this.input.value = '';
        this.input.blur();
      } else if (k === 'Escape') {
        e.preventDefault();
        this.input.value = '';
        this.input.blur();
      } else if (k === 'Tab') {
        e.preventDefault();
        this.setTeam(!this.team);
      }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  private setTeam(team: boolean): void {
    this.team = team;
    this.tag.textContent = team ? 'TEAM' : 'ALL';
    this.tag.classList.toggle('team', team);
    this.input.placeholder = team ? 'Message your team (Tab: all)' : 'Message everyone (Tab: team)';
  }

  reset(): void {
    this.log.replaceChildren();
    this.input.value = '';
    this.close();
  }

  private close(): void {
    this.focused = false;
    this.box.classList.add('hidden');
    this.el.classList.remove('open');
  }

  open(team: boolean): void {
    this.setTeam(team);
    this.box.classList.remove('hidden');
    this.el.classList.add('open');
    this.input.focus({ preventScroll: true });
  }

  line(c: ChatLine): void {
    const row = h('div', { class: `hc-line ${c.system ? 'sys' : ''} ${c.teamId === 0 || c.teamId === 1 ? `t${c.teamId}` : ''}` });
    if (c.team) row.append(h('span', { class: 'hc-team', text: '[team]' }));
    if (!c.system) row.append(h('span', { class: 'hc-from', text: c.from }));
    row.append(h('span', { class: 'hc-text', text: c.text }));
    this.log.append(row);
    while (this.log.childElementCount > 9) this.log.firstElementChild?.remove();
  }
}
