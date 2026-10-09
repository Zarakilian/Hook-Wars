// Showcase stage: public API.
//
//   createShowcaseStage(host, opts)   a staged vignette (dock, lanterns, water, mist, props, the Lunker)
//                                     in one of four map moods; see stage.ts for the two modes.
//   menuShowcase                      the Epic main-menu backdrop's controls for the UI, which cannot
//                                     reach the engine's backdrop: who to pose, which mood, spin, show-off.
//
// The main menu only builds the stage in cinematic mode (the Steam "Epic" setting); with it off the
// classic sunset backdrop renders exactly as before and nothing in this folder runs.
import type { PudgyOneShot } from '../contracts.ts';
import { createShowcaseStage, type ShowcaseFrame, type ShowcaseLook } from './stage.ts';
import { SHOWCASE_THEMES, type ShowcaseThemeId } from './themes.ts';

export { createShowcaseStage, type ShowcaseFrame, type ShowcaseHost, type ShowcaseLook, type ShowcaseOptions, type ShowcaseStage } from './stage.ts';
export { SHOWCASE_THEMES, THEMES, themeForMap, type ShowcaseThemeId } from './themes.ts';

export interface MenuShowcaseState {
  /** who the Epic menu backdrop poses (null = nobody: the UI's own preview shows the Lunker) */
  look: ShowcaseLook | null;
  theme: ShowcaseThemeId;
  frame: Partial<ShowcaseFrame>;
  /** bumped on every change; the backdrop re-reads the state when it differs */
  version: number;
  /** pending input, consumed by the backdrop each frame */
  dragPx: number;
  shots: PudgyOneShot[];
}

const state: MenuShowcaseState = { look: null, theme: 'harbourNight', frame: {}, version: 0, dragPx: 0, shots: [] };

/**
 * Controls for the Epic main-menu backdrop. Safe to call any time (before the engine exists, with
 * cinematic off): the backdrop reads them when it shows the stage.
 */
export const menuShowcase = {
  /** Pose this Lunker in the backdrop (the player's profile look). null hides it. */
  setLook(look: ShowcaseLook | null): void {
    state.look = look ? { ...look, loadout: { ...look.loadout } } : null;
    state.version++;
  },
  /** The backdrop's mood. Default 'harbourNight'. */
  setTheme(theme: ShowcaseThemeId): void {
    if (!SHOWCASE_THEMES.includes(theme)) return;
    state.theme = theme;
    state.version++;
  },
  /** Where the Lunker sits on screen, as fractions from the left / top (default x 0.678, feet 0.775, head 0.15: the UI's .menu-stage box at 1920 x 1080). */
  setFrame(frame: Partial<ShowcaseFrame>): void {
    state.frame = { ...frame };
    state.version++;
  },
  /** Spin the posed Lunker (pointer drag, horizontal pixels). */
  drag(dxPixels: number): void {
    state.dragPx += dxPixels;
  },
  /** Play a show-off one-shot ('celebrate', 'throw', 'bash', 'melee'). */
  play(shot: PudgyOneShot): void {
    if (state.shots.length < 4) state.shots.push(shot);
  },
  /** read-only view of the state (the backdrop uses it) */
  get state(): Readonly<MenuShowcaseState> {
    return state;
  },
  /** the backdrop consumes pending input */
  takeInput(): { dragPx: number; shots: PudgyOneShot[] } {
    const out = { dragPx: state.dragPx, shots: state.shots.slice() };
    state.dragPx = 0;
    state.shots.length = 0;
    return out;
  },
};

// Dev only (?debug): reach the stage factory from the console and from automated checks.
try {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')) {
    (globalThis as unknown as Record<string, unknown>).__hwShowcase = { createShowcaseStage, menuShowcase };
  }
} catch {
  // no location (tests): nothing to expose
}
