// Shared context handed to every screen and to the HUD.
import type { PudgyPreview } from './preview.ts';
import type { AppActions, AppState } from './types.ts';

export interface UiCtx {
  actions: AppActions;
  /** latest state passed to ui.render */
  get(): AppState;
  preview: PudgyPreview;
  openHowTo(page?: number): void;
  /** Show a modal dialog. Returns a close function. */
  modal(content: HTMLElement, opts?: { onClose?: () => void; cls?: string; label?: string }): () => void;
}

export interface ScreenView {
  el: HTMLElement;
  update(s: AppState, prev: AppState): void;
  destroy(): void;
}
