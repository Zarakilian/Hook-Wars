// IPC channel names between the preload script and the main process. Every call is an invoke that
// resolves to a Reply, so the page sees a plain Error with the main process's message on failure.
export const IPC = {
  player: 'hw:player',
  hostLobby: 'hw:hostLobby',
  joinLobby: 'hw:joinLobby',
  leaveLobby: 'hw:leaveLobby',
  listLobbies: 'hw:listLobbies',
  setLobbyInfo: 'hw:setLobbyInfo',
  inviteFriends: 'hw:inviteFriends',
  cloudRead: 'hw:cloudRead',
  cloudWrite: 'hw:cloudWrite',
  openOverlayUrl: 'hw:openOverlayUrl',
  setFullscreen: 'hw:setFullscreen',
  isFullscreen: 'hw:isFullscreen',
  quit: 'hw:quit',
  takePendingJoin: 'hw:takePendingJoin',
} as const;

/** main -> page event: a join asked for from outside the game */
export const JOIN_REQUEST_EVENT = 'hw:joinRequest';

/** Additional arguments main gives the page's preload (the preload cannot ask synchronously). */
export const ARG_APP_ID = '--hookwars-app-id=';
export const ARG_FAKE = '--hookwars-fake=';

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
