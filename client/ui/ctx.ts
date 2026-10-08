// Shared context handed to every screen and to the HUD.
import type { EconomyClient, EconomyState } from '../economy/types.ts';
import type { PudgyPreview } from './preview.ts';
import type { ItemThumbs } from './thumbs.ts';
import type { AppActions, AppState } from './types.ts';

export interface UiCtx {
  actions: AppActions;
  /** latest state passed to ui.render */
  get(): AppState;
  preview: PudgyPreview;
  openHowTo(page?: number): void;
  /** Show a modal dialog. Returns a close function. */
  modal(content: HTMLElement, opts?: { onClose?: () => void; cls?: string; label?: string }): () => void;
  /** UI-side toast (the app's own toasts arrive through AppState). */
  toast(text: string, kind?: 'info' | 'error' | 'good'): void;

  // ------------------------------------------------------------------ cosmetic economy
  /** The client economy, or undefined when the app runs without one (screens show an "unavailable" state). */
  economy: EconomyClient | undefined;
  /** Current economy state, or null without an economy. */
  econ(): EconomyState | null;
  /** Subscribe to economy changes; returns an unsubscribe function (a no-op without an economy). */
  onEcon(cb: (s: EconomyState) => void): () => void;
  /** Ownership check that also works without an economy (defaults only). */
  owns(itemId: string): boolean;
  /** Buy with Pearls; plays the purchase sound and toasts when ownership actually lands. */
  buyPearls(itemId: string): void;
  /** Buy a Limited item with devnet USDC (wallet flow); same feedback as buyPearls. */
  buyUsdc(itemId: string): void;
  /** Remember that the player cancelled this listing, so its disappearance is not reported as a sale. */
  noteCancel(listingId: string, instance: string): void;
  /** Open the wallet panel. */
  openWallet(): void;
  /** Item thumbnails (3D renders with an SVG fallback). */
  thumbs: ItemThumbs;
}

export interface ScreenView {
  el: HTMLElement;
  update(s: AppState, prev: AppState): void;
  destroy(): void;
}
