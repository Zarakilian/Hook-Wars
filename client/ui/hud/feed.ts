// Kill feed (top right): killer, cause icon, victim. Also rune grabs, in a lighter style.
import { RUNE_NAMES } from '../../../shared/constants.ts';
import type { KillCause, RuneType } from '../../../shared/types.ts';
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { CAUSE_ICON } from '../info.ts';
import type { HudFrame } from '../types.ts';

const SOLO_VERB: Record<KillCause, string> = {
  hook: 'was hooked',
  melee: 'was walloped',
  bash: 'was bashed',
  drown: 'drowned',
  mine: 'stepped on a mine',
  burn: 'burnt up',
  hazard: 'met a hazard',
  fountain: 'got scorched',
};

export class KillFeed {
  readonly el: HTMLElement;

  constructor() {
    this.el = h('div', { class: 'feed', role: 'log', 'aria-label': 'Kill feed' });
  }

  reset(): void {
    this.el.replaceChildren();
  }

  private push(row: HTMLElement): void {
    this.el.prepend(row);
    while (this.el.childElementCount > 6) this.el.lastElementChild?.remove();
    window.setTimeout(() => row.classList.add('out'), 7000);
    window.setTimeout(() => row.remove(), 7600);
  }

  private nameEl(f: HudFrame, id: number): HTMLElement {
    const p = f.players.get(id);
    return h('span', { class: `fd-name t${p?.team ?? 0} ${id === f.youId ? 'you' : ''}`, text: id === f.youId ? 'You' : p?.name ?? '?' });
  }

  kill(f: HudFrame, k: number, v: number, assists: number[], cause: KillCause): void {
    const mine = k === f.youId || v === f.youId || assists.includes(f.youId);
    const row = h('div', { class: `fd-row ${mine ? 'mine' : ''} ${v === f.youId ? 'died' : ''}` });
    if (k >= 0 && k !== v) {
      row.append(this.nameEl(f, k));
      if (assists.length) row.append(h('span', { class: 'fd-assist', text: `+${assists.length}` }));
      row.append(h('span', { class: 'fd-cause', title: cause }, icon(CAUSE_ICON[cause])));
      row.append(this.nameEl(f, v));
    } else {
      row.append(h('span', { class: 'fd-cause', title: cause }, icon(CAUSE_ICON[cause])));
      row.append(this.nameEl(f, v));
      row.append(h('span', { class: 'fd-verb', text: SOLO_VERB[cause] }));
    }
    this.push(row);
  }

  rune(f: HudFrame, u: number, t: RuneType): void {
    const row = h('div', { class: `fd-row rune ${u === f.youId ? 'mine' : ''}` }, this.nameEl(f, u), h('span', { class: 'fd-verb', text: 'grabbed' }), h('span', { class: 'fd-cause' }, icon(t)), h('span', { class: 'fd-rune', text: RUNE_NAMES[t] }));
    this.push(row);
  }
}
