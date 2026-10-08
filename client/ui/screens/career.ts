// Career: your account stats (matches, wins, kills, hooks hit) with a win ring and per-match bars,
// a rank on the harbour ladder, today's Pearl earnings and how much of the catalog you own.
import { FAMILY_DEFS } from '../../../shared/constants.ts';
import { COSMETICS } from '../../../shared/cosmetics.ts';
import { DAILY_PEARL_CAP, type AccountView } from '../../../shared/economy.ts';
import { FAMILIES } from '../../../shared/types.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h, s } from '../dom.ts';
import { fmtPearls, RARITY_INFO } from '../econ.ts';
import { icon, type IconId } from '../icons.ts';
import { hubShell } from '../shell.ts';
import type { AppState } from '../types.ts';
import { button } from '../widgets.ts';

/** The harbour ladder: wins needed for each rank. */
const RANKS: { name: string; wins: number; icon: IconId }[] = [
  { name: 'Deckhand', wins: 0, icon: 'anchor' },
  { name: 'Net Mender', wins: 3, icon: 'fish' },
  { name: 'Bosun', wins: 10, icon: 'hook' },
  { name: 'First Mate', wins: 25, icon: 'lifebuoy' },
  { name: 'Captain', wins: 50, icon: 'star' },
  { name: 'Harbour Master', wins: 100, icon: 'crown' },
];

function rankOf(wins: number): { cur: (typeof RANKS)[number]; next: (typeof RANKS)[number] | null } {
  let i = 0;
  while (i + 1 < RANKS.length && wins >= RANKS[i + 1].wins) i++;
  return { cur: RANKS[i], next: RANKS[i + 1] ?? null };
}

function ring(frac: number, label: string, sub: string): SVGSVGElement {
  const r = 46;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  const svg = s('svg', { class: `cr-ring ${frac <= 0 && label === '-' ? 'empty' : ''}`.trim(), viewBox: '0 0 120 120', role: 'img', 'aria-label': `${label} ${sub}` },
    s('circle', { cx: 60, cy: 60, r, class: 'cr-ring-bg' }),
    f <= 0 ? null : s('circle', { cx: 60, cy: 60, r, class: 'cr-ring-fg', 'stroke-dasharray': `${(c * f).toFixed(1)} ${c.toFixed(1)}`, transform: 'rotate(-90 60 60)' }),
    s('text', { x: 60, y: 62, class: 'cr-ring-num', 'text-anchor': 'middle' }),
    s('text', { x: 60, y: 82, class: 'cr-ring-sub', 'text-anchor': 'middle' }));
  const t = svg.querySelectorAll('text');
  t[0].textContent = label;
  t[1].textContent = sub;
  return svg;
}

/** Horizontal bars: each value against its own scale, labelled. */
function bars(rows: { label: string; value: number; max: number; text: string; color: string }[]): HTMLElement {
  return h('div', { class: 'cr-bars' }, ...rows.map((r) => h('div', { class: 'cr-bar' },
    h('span', { class: 'crb-label', text: r.label }),
    h('span', { class: 'crb-track' }, h('span', { class: 'crb-fill', style: `width:${(Math.max(0.02, Math.min(1, r.value / Math.max(1e-6, r.max))) * 100).toFixed(1)}%;--c:${r.color}` })),
    h('span', { class: 'crb-val', text: r.text }))));
}

function statTile(ico: IconId, value: string, label: string): HTMLElement {
  return h('div', { class: 'cr-tile' }, icon(ico, 'crt-ico'), h('span', { class: 'crt-val', text: value }), h('span', { class: 'crt-label', text: label }));
}

export function buildCareer(ctx: UiCtx, s0: AppState): ScreenView {
  const shell = hubShell(ctx, 'career', 'Career', 'Your record on the river', 'scr-career');
  const body = h('div', { class: 'cr-layout' });
  shell.body.append(body);
  let lastKey = '';

  function paint(acc: AccountView | null, mode: 'local' | 'server' | null): void {
    const key = acc ? `${mode}|${JSON.stringify(acc.stats)}|${acc.pearls}|${acc.owned.length}|${acc.earnedToday ?? -1}` : 'none';
    if (key === lastKey) return;
    lastKey = key;
    if (!acc) {
      body.replaceChildren(h('div', { class: 'empty-state big' }, icon('career'), h('span', { text: 'Career stats are kept with your account. Play a match to start your record.' })),
        button('Play Solo', () => ctx.actions.go('solo'), { cls: 'primary', icon: 'play' }));
      return;
    }
    const st = acc.stats;
    const losses = Math.max(0, st.matches - st.wins);
    const winRate = st.matches ? st.wins / st.matches : 0;
    const kpm = st.matches ? st.kills / st.matches : 0;
    const hpm = st.matches ? st.hooksHit / st.matches : 0;
    const { cur, next } = rankOf(st.wins);
    const toNext = next ? next.wins - st.wins : 0;
    const rankFrac = next ? (st.wins - cur.wins) / Math.max(1, next.wins - cur.wins) : 1;

    const rank = h('section', { class: 'cr-rank panel-lite' },
      h('span', { class: 'cr-rank-badge' }, icon(cur.icon)),
      h('div', { class: 'cr-rank-texts' },
        h('span', { class: 'cr-kicker', text: 'Rank' }),
        h('span', { class: 'cr-rank-name', text: cur.name }),
        h('span', { class: 'cr-rank-next', text: next ? `${toNext} more win${toNext === 1 ? '' : 's'} to ${next.name}` : 'Top of the ladder' }),
        h('span', { class: 'crb-track wide' }, h('span', { class: 'crb-fill', style: `width:${(Math.max(0.02, rankFrac) * 100).toFixed(1)}%;--c:var(--gold)` }))),
      h('div', { class: 'cr-ladder' }, ...RANKS.map((r) => h('span', { class: `cr-step ${st.wins >= r.wins ? 'on' : ''}`, title: `${r.name}: ${r.wins} wins` }, icon(r.icon)))));

    const tiles = h('section', { class: 'cr-tiles' },
      statTile('flag', fmtPearls(st.matches), 'Matches'),
      statTile('trophy', fmtPearls(st.wins), 'Wins'),
      statTile('skullsea', fmtPearls(st.kills), 'Kills'),
      statTile('hook', fmtPearls(st.hooksHit), 'Hooks hit'));

    const chart = h('section', { class: 'cr-chart panel-lite' },
      h('div', { class: 'cr-sec-title', text: 'Win record' }),
      h('div', { class: 'cr-chart-row' },
        ring(winRate, st.matches ? `${Math.round(winRate * 100)}%` : '-', 'win rate'),
        h('div', { class: 'cr-chart-side' },
          h('div', { class: 'cr-wl' }, h('span', { class: 'cr-w' }, h('b', { text: String(st.wins) }), h('span', { text: ' won' })), h('span', { class: 'cr-l' }, h('b', { text: String(losses) }), h('span', { text: ' lost' }))),
          bars([
            { label: 'Kills per match', value: kpm, max: Math.max(10, kpm), text: kpm.toFixed(1), color: 'var(--red)' },
            { label: 'Hooks per match', value: hpm, max: Math.max(20, hpm), text: hpm.toFixed(1), color: 'var(--brass)' },
            { label: 'Hooks per kill', value: st.kills ? st.hooksHit / st.kills : 0, max: 6, text: st.kills ? (st.hooksHit / st.kills).toFixed(1) : '-', color: 'var(--sea-3)' },
          ]))));

    // collection: owned (non-default) items per family against the catalog
    const coll = h('section', { class: 'cr-coll panel-lite' }, h('div', { class: 'cr-sec-title', text: 'Collection' }));
    const ownedIds = new Set(acc.owned.map((o) => o.item));
    for (const f of FAMILIES) {
      const all = COSMETICS.filter((c) => c.family === f && c.rarity !== 'default');
      const have = all.filter((c) => ownedIds.has(c.id)).length;
      coll.append(h('div', { class: 'cr-coll-row' }, icon(f, 'crc-ico'), h('span', { class: 'crc-name', text: FAMILY_DEFS[f].name }),
        h('span', { class: 'crb-track' }, h('span', { class: 'crb-fill', style: `width:${(Math.max(0.02, have / Math.max(1, all.length)) * 100).toFixed(1)}%;--c:${RARITY_INFO.epic.color}` })),
        h('span', { class: 'crb-val', text: `${have}/${all.length}` })));
    }

    const purse = h('section', { class: 'cr-purse panel-lite' },
      h('div', { class: 'cr-sec-title', text: 'Pearls' }),
      h('div', { class: 'cr-pearls' }, icon('pearl', 'crp-ico'), h('span', { class: 'crp-num', text: fmtPearls(acc.pearls) })),
      acc.earnedToday !== undefined
        ? h('div', { class: 'cr-today' }, h('span', { class: 'crb-label', text: `Earned today: ${fmtPearls(acc.earnedToday)} of ${fmtPearls(DAILY_PEARL_CAP)}` }),
          h('span', { class: 'crb-track wide' }, h('span', { class: 'crb-fill', style: `width:${(Math.max(0.02, acc.earnedToday / DAILY_PEARL_CAP) * 100).toFixed(1)}%;--c:var(--foam)` })))
        : h('p', { class: 'muted cr-note', text: mode === 'local' ? 'Offline: solo matches pay half Pearls into this browser\'s locker.' : 'Online matches pay Pearls to your server account.' }),
      button('Spend in the Store', () => ctx.actions.go('store'), { cls: 'ghost small', icon: 'shop' }));

    body.replaceChildren(h('div', { class: 'cr-col' }, rank, tiles, chart), h('div', { class: 'cr-col side' }, purse, coll));
  }

  const repaint = () => {
    const e = ctx.econ();
    paint(e?.account ?? null, e?.mode ?? null);
  };
  const unsub = ctx.onEcon(repaint);
  repaint();
  void s0;

  return {
    el: shell.el,
    update(st: AppState) {
      shell.update(st);
    },
    destroy() {
      unsub();
      shell.destroy();
    },
  };
}
