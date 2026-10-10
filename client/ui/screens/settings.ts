// Settings: control scheme with a key reference, graphics quality, volumes and gameplay toggles.
// The Steam build adds the Epic graphics option (the engine's cinematic mode, when the engine has it)
// and a Fullscreen switch for the desktop window; the browser build shows neither. Epic switched during
// a match takes effect from the next match (the match's world is built for one mode); the screen says so.
import type { ControlScheme } from '../../../shared/types.ts';
import type { Quality } from '../../render/contracts.ts';
import type { Settings } from '../../settings.ts';
import type { ScreenView, UiCtx } from '../ctx.ts';
import { h } from '../dom.ts';
import { keyTable } from '../howto.ts';
import type { AppState } from '../types.ts';
import { button, sectionTitle, segmented, slider, toggle } from '../widgets.ts';

type QualityChoice = Quality | 'auto' | 'epic';

const QUALITY_HINT: Record<QualityChoice, string> = {
  auto: 'Picks a tier from your hardware.',
  low: 'Fastest. No shadows, fewer effects.',
  medium: 'Balanced for laptops.',
  high: 'Soft shadows and richer water.',
  ultra: 'Everything on. For strong GPUs.',
  epic: 'Cinematic lighting and colour on top of Ultra. For strong GPUs.',
};

/** What the quality picker shows: Epic while the cinematic mode is on (Steam build only). */
function qualityChoice(s: Settings, epic: boolean): QualityChoice {
  return epic && s.cinematic ? 'epic' : s.quality;
}

export function buildSettings(ctx: UiCtx, s0: AppState): ScreenView {
  const a = ctx.actions;
  const patch = (p: Partial<Settings>) => a.saveSettings({ ...ctx.get().settings, ...p });
  let liveTimer = 0;
  const live = (p: Partial<Settings>) => {
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(() => patch(p), 90);
  };

  const controls = segmented<ControlScheme>({
    label: 'Control scheme',
    cls: 'seg-tall',
    value: s0.settings.controls,
    options: [
      { value: 'modern', label: 'Modern', sub: 'WASD to move, mouse to hook and grapple', icon: 'hook' },
      { value: 'classic', label: 'Classic', sub: 'Right-click to move, Q W E abilities', icon: 'grapple' },
    ],
    onChange: (v) => patch({ controls: v }),
  });
  const keysHolder = h('div', { class: 'keys-holder' }, keyTable(s0.settings.controls));

  // Epic only in the Steam build, and only when the engine has the cinematic mode
  const epic = !!s0.steam && s0.epicAvailable === true;
  const choices: QualityChoice[] = epic ? ['auto', 'low', 'medium', 'high', 'ultra', 'epic'] : ['auto', 'low', 'medium', 'high', 'ultra'];
  const quality = segmented<QualityChoice>({
    label: 'Graphics quality',
    cls: 'seg-small',
    value: qualityChoice(s0.settings, epic),
    options: choices.map((q) => ({ value: q, label: q[0].toUpperCase() + q.slice(1), title: QUALITY_HINT[q] })),
    onChange: (v) => (v === 'epic' ? patch({ cinematic: true }) : patch({ quality: v, cinematic: false })),
  });
  const qHint = h('div', { class: 'rule-hint' });
  // Steam build: an Epic change made during a match waits for the match to end
  const epicNext = epic ? h('div', { class: 'rule-hint stm-epic-next hidden', role: 'status', text: 'Takes effect from the next match.' }) : null;
  const fullscreen = s0.steam ? toggle('Fullscreen', s0.steam.fullscreen, (v) => a.setFullscreen?.(v), 'Fill the whole screen with the game window') : null;

  const master = slider('Master volume', s0.settings.master, (v) => patch({ master: v }), (v) => live({ master: v }));
  const sfx = slider('Effects', s0.settings.sfx, (v) => patch({ sfx: v }), (v) => live({ sfx: v }));
  const music = slider('Music', s0.settings.music, (v) => patch({ music: v }), (v) => live({ music: v }));
  const shake = slider('Screen shake', s0.settings.shake, (v) => patch({ shake: v }), (v) => live({ shake: v }));
  const range = toggle('Hook range ring', s0.settings.showRange, (v) => patch({ showRange: v }), 'A faint circle showing how far your hook reaches');
  const fps = toggle('Show FPS', s0.settings.showFps, (v) => patch({ showFps: v }), 'Frame rate in the top corner');

  const back = button(s0.match ? 'Back to match' : 'Back', () => a.go(ctx.get().match ? 'match' : 'menu'), { cls: 'ghost', icon: 'left' });

  const el = h('div', { class: 'scr scr-settings' },
    h('div', { class: 'panel wide-panel settings-panel' },
      h('header', { class: 'panel-head' }, back, h('h2', { class: 'panel-title', text: 'Settings' }), h('span', { class: 'head-spacer' })),
      h('div', { class: 'panel-body settings-body' },
        h('section', { class: 'set-col' }, sectionTitle('Controls', 'gear'), controls.el, keysHolder),
        h('section', { class: 'set-col' },
          sectionTitle('Graphics', 'eye'), quality.el, qHint, epicNext, fullscreen?.el ?? null,
          sectionTitle('Sound', 'chat'), master.el, sfx.el, music.el,
          sectionTitle('Gameplay', 'target'), shake.el, range.el, fps.el)),
    ));

  // Esc goes back. In a match this also stops the game's own Esc handling from un-pausing
  // the match behind this screen. Synthetic Escapes (no key) from the HUD still pass through.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || document.querySelector('.modal-scrim')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    a.go(ctx.get().match ? 'match' : 'menu');
  };
  window.addEventListener('keydown', onKey, true);

  let shownScheme = s0.settings.controls;
  const paint = (s: Settings) => {
    controls.set(s.controls);
    if (s.controls !== shownScheme) {
      shownScheme = s.controls;
      keysHolder.replaceChildren(keyTable(s.controls));
    }
    const q = qualityChoice(s, epic);
    quality.set(q);
    qHint.textContent = QUALITY_HINT[q];
    master.set(s.master);
    sfx.set(s.sfx);
    music.set(s.music);
    shake.set(s.shake);
    range.set(s.showRange);
    fps.set(s.showFps);
  };
  paint(s0.settings);
  const paintSteam = (s: AppState) => fullscreen?.set(s.steam?.fullscreen ?? false);
  const paintPending = (s: AppState) => epicNext?.classList.toggle('hidden', !(s.epicPending && s.match));
  paintPending(s0);

  return {
    el,
    update(s: AppState, prev: AppState) {
      if (s.settings !== prev.settings) paint(s.settings);
      if (s.steam !== prev.steam) paintSteam(s);
      if (s.epicPending !== prev.epicPending || s.match !== prev.match) paintPending(s);
    },
    destroy() {
      window.clearTimeout(liveTimer);
      window.removeEventListener('keydown', onKey, true);
    },
  };
}
