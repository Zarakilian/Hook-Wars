// How to Play: a tabbed field guide (goal, controls, moves, river, hazards, runes and shop).
import { BAL, HOOK_LEVELS, ITEM_IDS, ITEMS, RUNE_BLURBS, RUNE_COLORS, RUNE_NAMES } from '../../shared/constants.ts';
import { MAPS } from '../../shared/maps/index.ts';
import { HAZARD_INFO } from '../../shared/sim/hazards.ts';
import { MAP_IDS, type ControlScheme, type HazardKind, type RuneType } from '../../shared/types.ts';
import type { UiCtx } from './ctx.ts';
import { h, hex } from './dom.ts';
import { icon, type IconId } from './icons.ts';
import { KEY_TABLE, RIVER_INFO } from './info.ts';
import { button, keycap, segmented } from './widgets.ts';

interface Page {
  title: string;
  icon: IconId;
  body: () => HTMLElement;
}

function card(ico: IconId, title: string, text: string, cls = ''): HTMLElement {
  return h('div', { class: `ht-card ${cls}`.trim() }, h('span', { class: 'ht-ico' }, icon(ico)), h('span', { class: 'ht-text' }, h('span', { class: 'ht-title', text: title }), h('span', { class: 'ht-line', text })));
}

export function keyTable(scheme: ControlScheme): HTMLElement {
  const t = h('table', { class: 'key-table' });
  const body = h('tbody');
  for (const [action, keys] of KEY_TABLE[scheme]) {
    const kc = h('td', { class: 'kt-keys' });
    keys.forEach((k, i) => {
      if (i > 0) kc.append(h('span', { class: 'kt-or', text: 'or' }));
      kc.append(keycap(k));
    });
    body.append(h('tr', {}, h('th', { scope: 'row', text: action }), kc));
  }
  t.append(body);
  return t;
}

/** Classic runes and hook power-ups, as two groups. Names, blurbs and colours live in shared/constants.ts. */
const BUFF_RUNES: RuneType[] = ['haste', 'double', 'ironskin', 'ghost', 'bounty'];
const POWER_RUNES: RuneType[] = ['bendy', 'bouncy', 'longshot'];

/** Maps grouped by how they do Tidal, e.g. "Coral Cove, Maelstrom Lagoon and Mirelight Marsh". */
function tidalMaps(style: 'tide' | 'locks' | 'freeze'): string {
  const names = MAP_IDS.map((id) => MAPS[id]).filter((m) => m.tide?.style === style).map((m) => m.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function runeCard(r: RuneType): HTMLElement {
  const c = card(r, RUNE_NAMES[r], RUNE_BLURBS[r], 'mini');
  c.style.setProperty('--rune', hex(RUNE_COLORS[r].main));
  return c;
}

export function createHowTo(ctx: UiCtx, start: number, close: () => void): { el: HTMLElement } {
  let scheme: ControlScheme = ctx.get().settings.controls;
  const pages: Page[] = [
    {
      title: 'The Goal',
      icon: 'fish',
      body: () => h('div', { class: 'ht-page' },
        h('p', { class: 'ht-lead', text: 'Think of it as fishing for your friends. Your hook is the rod, the river is the danger, and the catch is an enemy Pudgy dragged onto your bank.' }),
        h('div', { class: 'ht-grid' },
          card('hook', 'Hook them across', 'Throw your Chain Hook over the river. The first Pudgy it hits is dragged straight back to you.'),
          card('melee', 'Wallop the catch', 'Stand next to an enemy and you swing at them automatically. Hooks deal big damage too.'),
          card('trophy', 'First to the target wins', 'Every death scores a point for the other team, drownings and hazards included. A tie at the buzzer goes to overtime.'),
          card('fountain', 'Mind the fountains', 'Your home fountain heals your team. The enemy fountain burns you, so do not get dragged into it.'),
        )),
    },
    {
      title: 'Controls',
      icon: 'gear',
      body: () => {
        const holder = h('div', { class: 'ht-keys' }, keyTable(scheme));
        const seg = segmented<ControlScheme>({
          label: 'Control scheme',
          value: scheme,
          cls: 'seg-small',
          options: [
            { value: 'modern', label: 'Modern', sub: 'WASD + mouse' },
            { value: 'classic', label: 'Classic', sub: 'Right-click to move' },
          ],
          onChange: (v) => {
            scheme = v;
            holder.replaceChildren(keyTable(v));
          },
        });
        return h('div', { class: 'ht-page' },
          h('p', { class: 'ht-lead', text: 'Two control schemes. Pick one in Settings. Here is what each key does.' }),
          seg.el, holder);
      },
    },
    {
      title: 'Hooks & Moves',
      icon: 'hook',
      body: () => h('div', { class: 'ht-page' },
        h('div', { class: 'ht-grid' },
          card('hook', 'Chain Hook', 'A quick wind-up, then a skillshot. Drags the first unit it hits back to you. Hook an ally to SAVE them. Two hooks that meet in the air clash and bounce home.'),
          card('grapple', 'Grapple', 'Latch onto a tree, rock, wall or unit and fly to it. Crosses the river, and works while you are drowning.'),
          card('bash', 'Belly Bash', `A short shove: ${BAL.bashDamage} damage and a big knockback. Interrupts hooks. Bash them into the water!`),
          card('target', 'Aim tips', 'Lead your shots, hide behind trees, and watch for movers drifting down the river. They block hooks.'),
        )),
    },
    {
      title: 'The River',
      icon: 'wave',
      body: () => h('div', { class: 'ht-page' },
        h('p', { class: 'ht-lead', text: 'Every match picks a river mode. Some maps also have their own tide.' }),
        h('div', { class: 'ht-grid' },
          card('wave', RIVER_INFO.deep.name, `Nobody can walk in. Fall, get bashed or get dropped in and you drown in ${BAL.drownTime} s, unless you grapple out or a friend hooks you.`),
          card('dry', RIVER_INFO.dry.name, 'The channel is a walkable river bed. A little slower, and hazards may wait down there.'),
          card('tidal', 'Tidal: tides', `${tidalMaps('tide')}. The sea rolls out (walk the bed), rises with a horn warning (wading), floods (deep), then drains.`),
          card('lock', 'Tidal: lock gates', `${tidalMaps('locks')}. The lock gates open on a timer and flood the canal, then drain it again.`),
          card('ice', 'Tidal: freeze and thaw', `${tidalMaps('freeze')}. The water freezes solid (slippery ice), cracks with a warning, thaws into deep water, then freezes again.`),
          card('drown', 'Drowning', 'A countdown appears when you are in deep water. Grapple to anything solid, or pray for an ally hook.'),
        )),
    },
    {
      title: 'Hazards',
      icon: 'thorns',
      body: () => h('div', { class: 'ht-page' },
        h('p', { class: 'ht-lead', text: 'Pick None, Thorns, Bristles, the map Special, or Mixed. In Deep Water they sit on the banks. In Dry Bed and Tidal they also sit in the river bed.' }),
        h('div', { class: 'ht-grid three' },
          ...(['thorns', 'bristles', 'quicksand', 'icespikes', 'jellyfish', 'steamvent'] as HazardKind[]).map((k) => card(k, HAZARD_INFO[k].name, HAZARD_INFO[k].blurb)),
        )),
    },
    {
      title: 'Runes & Shop',
      icon: 'coin',
      body: () => h('div', { class: 'ht-page' },
        h('p', { class: 'ht-lead', text: `Runes appear on river spots every ${BAL.runeEvery} s. Hook one to drag it home, or walk over it when the bed is dry.` }),
        h('div', { class: 'ht-rune-group' }, h('span', { class: 'ht-rg-title', text: 'Runes' }), h('div', { class: 'ht-runes' }, ...BUFF_RUNES.map(runeCard))),
        h('div', { class: 'ht-rune-group power' }, h('span', { class: 'ht-rg-title', text: `Hook power-ups · ${BAL.powerHookTime} s` }), h('div', { class: 'ht-runes power' }, ...POWER_RUNES.map(runeCard))),
        h('p', { class: 'ht-lead', text: `Press B for the shop. Gold comes from kills, hook hits and time. Upgrade your hook (damage up to ${HOOK_LEVELS.damage[5]}, range up to ${HOOK_LEVELS.range[5]} m) or buy items. With the shop open, right-click an item slot to sell it.` }),
        h('div', { class: 'ht-items' }, ...ITEM_IDS.map((id) => h('span', { class: 'ht-item', title: `${ITEMS[id].name}: ${ITEMS[id].blurb}` }, icon(id), h('span', { text: ITEMS[id].name })))),
      ),
    },
  ];

  let idx = Math.max(0, Math.min(pages.length - 1, start));
  const tabs = h('div', { class: 'ht-tabs', role: 'tablist', 'aria-label': 'How to play' });
  const pageHolder = h('div', { class: 'ht-body', role: 'tabpanel' });
  const tabBtns: HTMLButtonElement[] = pages.map((p, i) => {
    const b = h('button', { class: 'ht-tab', type: 'button', role: 'tab' }, icon(p.icon), h('span', { text: p.title }));
    b.addEventListener('click', () => go(i));
    tabs.append(b);
    return b;
  });
  const prev = button('Back', () => go(idx - 1), { cls: 'ghost', icon: 'left' });
  const next = button('Next', () => go(idx + 1), { icon: 'right' });
  const done = button('Got it!', () => close(), { cls: 'primary', icon: 'check' });
  done.dataset.autofocus = '1';
  const title = h('h2', { class: 'panel-title' });

  function go(i: number): void {
    idx = Math.max(0, Math.min(pages.length - 1, i));
    tabBtns.forEach((b, k) => {
      b.classList.toggle('on', k === idx);
      b.setAttribute('aria-selected', k === idx ? 'true' : 'false');
    });
    title.textContent = pages[idx].title;
    const body = pages[idx].body();
    body.classList.add('ht-in');
    pageHolder.replaceChildren(body);
    prev.disabled = idx === 0;
    next.disabled = idx === pages.length - 1;
  }
  go(idx);

  const el = h('div', { class: 'panel howto' },
    h('header', { class: 'panel-head' }, h('span', { class: 'ht-kicker', text: 'Field Guide' }), title, button('', () => close(), { cls: 'ghost icon-btn', icon: 'close', title: 'Close' })),
    h('div', { class: 'ht-main' }, tabs, pageHolder),
    h('footer', { class: 'panel-foot' }, prev, next, h('span', { class: 'head-spacer' }), done));
  return { el };
}
