// Which build is running. The Steam desktop app (Electron) exposes a small bridge on window before
// the page loads; the plain browser build has none. Premium cosmetics are sold only in the Steam build.
export interface SteamBridge {
  readonly kind: 'steam';
}

export function steamBridge(): SteamBridge | null {
  const b = (globalThis as { hookwarsSteam?: unknown }).hookwarsSteam;
  return b && typeof b === 'object' && (b as { kind?: unknown }).kind === 'steam' ? (b as SteamBridge) : null;
}

export function isSteam(): boolean {
  return steamBridge() !== null;
}
