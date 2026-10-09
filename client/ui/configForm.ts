// Match setup form, shared by Solo, Create Room and the lobby host: map cards, river mode,
// hazards and rules. Built once, updated in place.
import { MAX_TEAM_SIZE, suggestedKills } from '../../shared/constants.ts';
import { getMap, mapSupportsTidal } from '../../shared/maps/index.ts';
import {
  BOT_DIFFICULTIES, HAZARD_MODES, MAP_IDS, RIVER_MODES,
  type BotDifficulty, type HazardMode, type MapId, type MatchConfig, type RiverMode,
} from '../../shared/types.ts';
import { mapThumb, moodGradient, moodLabel, moodSwatch } from './chart.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { BOT_NAMES_UI, RIVER_INFO, hazardInfo, hazardPlacement, tidalLine, tidalShort } from './info.ts';
import { clickSound, sectionTitle, segmented, toggle } from './widgets.ts';

export interface ConfigForm {
  el: HTMLElement;
  set(cfg: MatchConfig, locked?: boolean): void;
}

export type FormVariant = 'solo' | 'room' | 'lobby';

const KILLS = [5, 10, 15, 20, 30, 35, 40, 50];
/** How many maps have a tide, for the "this map has no tide" hint. */
const TIDAL_COUNT = MAP_IDS.filter((id) => mapSupportsTidal(id)).length;
const TIMES = [180, 300, 600, 900, 1200, 1800];

export function createConfigForm(o: { variant: FormVariant; cfg: MatchConfig; onChange: (c: MatchConfig) => void; locked?: boolean; extra?: HTMLElement | null }): ConfigForm {
  let cfg = { ...o.cfg };
  let locked = !!o.locked;
  const compact = o.variant === 'lobby';
  const emit = (patch: Partial<MatchConfig>) => {
    if (locked) return;
    const next: MatchConfig = { ...cfg, ...patch };
    if (next.riverMode === 'tidal' && !mapSupportsTidal(next.mapId)) next.riverMode = 'deep';
    cfg = next;
    paint();
    o.onChange(next);
  };

  // ---------------------------------------------------------------- maps
  const mapBtns = new Map<MapId, HTMLButtonElement>();
  const mapThumbs = new Map<MapId, HTMLImageElement>();
  const mapGrid = h('div', { class: `map-cards ${compact ? 'compact' : ''}`, role: 'radiogroup', 'aria-label': 'Map' });
  for (const id of MAP_IDS) {
    const m = getMap(id);
    const chips = h('div', { class: 'mc-chips' },
      h('span', { class: 'chip chip-deep', title: RIVER_INFO.deep.line }, icon('wave'), h('span', { text: 'Deep' })),
      h('span', { class: 'chip chip-dry', title: RIVER_INFO.dry.line }, icon('dry'), h('span', { text: 'Dry' })),
      m.tide
        ? h('span', { class: 'chip chip-tidal', title: tidalLine(m) ?? '' }, icon(m.tide.style === 'freeze' ? 'ice' : m.tide.style === 'locks' ? 'lock' : 'tidal'), h('span', { text: tidalShort(m) }))
        : h('span', { class: 'chip chip-none', title: 'This map has no tide: Tidal plays as Deep Water.' }, h('span', { text: 'No tide' })),
    );
    const thumb = h('img', { class: 'mc-thumb', alt: '', src: mapThumb(id, 'deep'), draggable: 'false' });
    mapThumbs.set(id, thumb);
    const b = h('button', { class: 'map-card', type: 'button', role: 'radio', 'aria-label': m.name, title: `${m.name}: ${m.blurb} Mood: ${moodLabel(m)}.`, style: `--mood:${moodGradient(m)}` },
      h('span', { class: 'mc-art' }, thumb, h('span', { class: 'mc-mood', 'aria-hidden': 'true' }), h('span', { class: 'mc-check', 'aria-hidden': 'true' }, icon('check')),
        h('span', { class: 'mc-swatch', title: `Mood: ${moodLabel(m)}` }, ...moodSwatch(m).map((c) => h('span', { class: 'mc-sw', style: `background:${c}` })), h('span', { class: 'mc-sw-label', text: moodLabel(m) }))),
      h('span', { class: 'mc-body' },
        h('span', { class: 'mc-name', text: m.name }),
        compact ? null : h('span', { class: 'mc-blurb', text: m.blurb }),
        chips),
    );
    b.addEventListener('click', () => {
      if (b.disabled || cfg.mapId === id) return;
      clickSound();
      emit({ mapId: id });
    });
    b.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'ArrowDown' && k !== 'ArrowUp') return;
      e.preventDefault();
      const i = MAP_IDS.indexOf(id);
      const n = MAP_IDS[(i + (k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1) + MAP_IDS.length) % MAP_IDS.length];
      mapBtns.get(n)?.focus();
      mapBtns.get(n)?.click();
    });
    mapBtns.set(id, b);
    mapGrid.append(b);
  }

  // ---------------------------------------------------------------- river
  const river = segmented<RiverMode>({
    label: 'River',
    cls: 'seg-tall seg-river',
    value: cfg.riverMode,
    options: RIVER_MODES.map((r) => ({ value: r, label: RIVER_INFO[r].name, icon: RIVER_INFO[r].icon, sub: RIVER_INFO[r].line })),
    onChange: (r) => emit({ riverMode: r }),
  });

  // ---------------------------------------------------------------- hazards
  const hazards = segmented<HazardMode>({
    label: 'Hazards',
    cls: 'seg-grid seg-hazard',
    value: cfg.hazards,
    options: HAZARD_MODES.map((hz) => {
      const info = hazardInfo(hz, getMap(cfg.mapId));
      return { value: hz, label: hz === 'special' ? 'Map Special' : info.name, icon: info.icon, title: info.line };
    }),
    onChange: (v) => emit({ hazards: v }),
  });
  const hazIco = h('span', { class: 'hx-ico' });
  const hazName = h('span', { class: 'hx-name' });
  const hazLine = h('span', { class: 'hx-line' });
  const hazWhere = h('span', { class: 'hx-where' });
  const hazExplain = h('div', { class: 'hazard-explain cloth', 'aria-live': 'polite' }, hazIco, h('span', { class: 'hx-text' }, hazName, hazLine, hazWhere));

  // ---------------------------------------------------------------- rules
  const teamSize = segmented<number>({ label: 'Team size', cls: 'seg-small', value: cfg.teamSize, options: Array.from({ length: MAX_TEAM_SIZE }, (_, i) => i + 1).map((n) => ({ value: n, label: `${n}v${n}` })), onChange: (n) => emit(cfg.killsToWin === suggestedKills(cfg.teamSize) ? { teamSize: n, killsToWin: suggestedKills(n) } : { teamSize: n }) });
  const kills = segmented<number>({ label: 'Kills to win', cls: 'seg-small', value: cfg.killsToWin, options: KILLS.map((n) => ({ value: n, label: String(n) })), onChange: (n) => emit({ killsToWin: n }) });
  const times = segmented<number>({ label: 'Time limit', cls: 'seg-small', value: cfg.timeLimitSec, options: TIMES.map((n) => ({ value: n, label: `${n / 60}m` })), onChange: (n) => emit({ timeLimitSec: n }) });
  const bots = segmented<BotDifficulty>({ label: 'Bot skill', cls: 'seg-small', value: cfg.botDifficulty, options: BOT_DIFFICULTIES.map((d) => ({ value: d, label: BOT_NAMES_UI[d].name, title: BOT_NAMES_UI[d].line })), onChange: (d) => emit({ botDifficulty: d }) });
  const botLine = h('div', { class: 'rule-hint' });
  const fill = o.variant === 'solo' ? null : toggle('Fill empty slots with bots', cfg.botFill, (v) => emit({ botFill: v }), 'Off: humans only, both teams need a player');

  const rule = (label: string, ctl: HTMLElement, extra?: HTMLElement | null) => h('div', { class: 'rule' }, h('span', { class: 'rule-label', text: label }), ctl, extra ?? null);

  const lockNote = h('div', { class: 'lock-note hidden' }, icon('padlock'), h('span', { text: 'Only the host can change the rules.' }));

  const el = h('div', { class: `cfg cfg-${o.variant}` },
    h('section', { class: 'cfg-maps' }, sectionTitle('Choose a map', 'flag'), mapGrid),
    h('section', { class: 'cfg-col cfg-river' }, sectionTitle('The river', 'wave'), river.el),
    h('section', { class: 'cfg-col cfg-hazards' }, sectionTitle('Hazards', 'thorns'), hazards.el, hazExplain),
    h('section', { class: 'cfg-col cfg-rules' }, sectionTitle('Rules', 'clock'),
      o.extra ?? null,
      rule('Team size', teamSize.el),
      rule('Kills to win', kills.el),
      rule('Time limit', times.el),
      rule('Bots', bots.el, botLine),
      fill ? fill.el : null),
    lockNote,
  );

  function paint(): void {
    const m = getMap(cfg.mapId);
    // the cards preview the chosen river: water, a dry bed, or the tide / ice state
    for (const [id, img] of mapThumbs) {
      const mm = getMap(id);
      const wc = cfg.riverMode === 'dry' ? 'dry' : cfg.riverMode === 'tidal' && mm.tide ? (mm.tide.style === 'freeze' ? 'ice' : 'shallow') : 'deep';
      const src = mapThumb(id, wc);
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    }
    for (const [id, b] of mapBtns) {
      const on = id === cfg.mapId;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.disabled = locked;
    }
    const tl = tidalLine(m);
    river.setDisabled('tidal', !tl, tl ? '' : `${m.name} has no tide`);
    river.setSub('tidal', tl ?? `${m.name} has no tide. ${TIDAL_COUNT} other maps do.`);
    river.set(cfg.riverMode, locked);
    // hazard tile names follow the map's special
    hazards.set(cfg.hazards, locked);
    const sp = hazardInfo('special', m);
    const spBtn = hazards.el.querySelectorAll<HTMLButtonElement>('.seg-opt')[HAZARD_MODES.indexOf('special')];
    if (spBtn) {
      spBtn.title = `${sp.name}: ${sp.line}`;
      const lbl = spBtn.querySelector('.seg-label');
      if (lbl && lbl.textContent !== sp.name) lbl.textContent = sp.name;
      const old = spBtn.querySelector('svg');
      if (old && old.dataset.k !== m.special) {
        const ni = icon(sp.icon, 'seg-ico');
        ni.dataset.k = m.special;
        old.replaceWith(ni);
      }
    }
    const hi = hazardInfo(cfg.hazards, m);
    hazIco.textContent = '';
    hazIco.append(icon(hi.icon));
    hazName.textContent = hi.name;
    hazLine.textContent = hi.line;
    hazWhere.textContent = cfg.hazards === 'none' ? '' : hazardPlacement(cfg.riverMode === 'tidal' && !m.tide ? 'deep' : cfg.riverMode);
    teamSize.set(cfg.teamSize, locked);
    kills.set(cfg.killsToWin, locked);
    times.set(cfg.timeLimitSec, locked);
    bots.set(cfg.botDifficulty, locked);
    botLine.textContent = BOT_NAMES_UI[cfg.botDifficulty].line;
    fill?.set(cfg.botFill, locked);
    lockNote.classList.toggle('hidden', !locked);
    el.classList.toggle('locked', locked);
  }
  paint();

  return {
    el,
    set(c: MatchConfig, l = false) {
      cfg = { ...c };
      locked = l;
      paint();
    },
  };
}
