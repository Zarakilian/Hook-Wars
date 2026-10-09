// Preload for the game page (sandboxed, context-isolated). Exposes window.hookwarsSteam, exactly the
// SteamBridge of client/platform.ts, and nothing else: every call is an IPC invoke the main process
// checks. The build bundles this file into one CommonJS file whose only require is 'electron'.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { SteamBridge, SteamLobbySummary, SteamPlayer } from '../../client/platform.ts';
import { ARG_APP_ID, ARG_FAKE, IPC, JOIN_REQUEST_EVENT, type Reply } from './ipc.ts';

function argValue(prefix: string): string | null {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : null;
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Reply<T> | undefined;
  if (r && r.ok === true) return r.value;
  throw new Error(r && r.ok === false ? r.error : 'The Steam bridge did not answer.');
}

const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {});
};

const bridge: SteamBridge = {
  kind: 'steam',
  appId: Number(argValue(ARG_APP_ID)) || 0,
  fake: argValue(ARG_FAKE) === '1',
  player: () => call<SteamPlayer>(IPC.player),
  hostLobby: (opts) => call<{ lobbyId: string; url: string }>(IPC.hostLobby, opts),
  joinLobby: (lobbyId) => call<{ url: string }>(IPC.joinLobby, lobbyId),
  leaveLobby: async () => {
    await call<null>(IPC.leaveLobby);
  },
  listLobbies: () => call<SteamLobbySummary[]>(IPC.listLobbies),
  setLobbyInfo: async (info) => {
    await call<null>(IPC.setLobbyInfo, info);
  },
  inviteFriends: () => quiet(call(IPC.inviteFriends)),
  onJoinRequest: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e: IpcRendererEvent, id: unknown) => {
      if (typeof id === 'string') cb(id);
    };
    ipcRenderer.on(JOIN_REQUEST_EVENT, listener);
    // a join that arrived before the page listened (Steam started the game with +connect_lobby)
    quiet(
      call<string | null>(IPC.takePendingJoin).then((id) => {
        if (typeof id === 'string') cb(id);
      }),
    );
    return () => {
      ipcRenderer.removeListener(JOIN_REQUEST_EVENT, listener);
    };
  },
  cloudRead: (name) => call<string | null>(IPC.cloudRead, name),
  cloudWrite: (name, data) => call<boolean>(IPC.cloudWrite, name, data),
  openOverlayUrl: (url) => quiet(call(IPC.openOverlayUrl, url)),
  setFullscreen: (on) => quiet(call(IPC.setFullscreen, on)),
  isFullscreen: () => call<boolean>(IPC.isFullscreen),
  quit: () => quiet(call(IPC.quit)),
};

contextBridge.exposeInMainWorld('hookwarsSteam', bridge);
