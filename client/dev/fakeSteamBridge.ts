// Debug only: a stand-in Steam bridge for clicking through the Steam screens in a normal browser.
// Installed only when the page address has both ?debug and ?fakesteam, and never over a real bridge
// (the Steam desktop app's preload script). It implements the SteamBridge contract
// (client/platform.ts) against the web server that served this page:
//   hostLobby   -> the page's own server; the game then creates its room there by itself
//   listLobbies -> that server's public rooms, as Hook Wars lobbies (plus two lobbies of other games
//                  and builds, which the lobby browser must filter out)
//   joinLobby   -> the page's own server again; the game joins the room by its code
//   cloudRead/cloudWrite -> localStorage (hookwars.fakecloud.<name>)
// Console: window.__fakeSteam.requestJoin('ABCDE') fakes a friend's invite to that room,
// __fakeSteam.cloudFail = true makes every Cloud call fail, __fakeSteam.published lists the
// lobby info the game published, __fakeSteam.invites counts invite dialogs.
// ?fakesteam=Name picks the persona name.
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import type { RoomSummary, ServerMsg } from '../../shared/protocol.ts';
import { defaultServerUrl } from '../net/connection.ts';
import { steamBridge, type SteamBridge, type SteamLobbySummary } from '../platform.ts';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A room code as a decimal lobby id ('9' and two digits per letter), and back. */
export function codeToLobbyId(code: string): string {
  return `9${[...code].map((c) => String(LETTERS.indexOf(c) + 10)).join('')}`;
}

export function lobbyIdToCode(id: string): string | null {
  if (!/^9(\d\d){5}$/.test(id)) return null;
  let out = '';
  for (let i = 1; i < id.length; i += 2) {
    const n = Number(id.slice(i, i + 2)) - 10;
    if (n < 0 || n >= LETTERS.length) return null;
    out += LETTERS[n];
  }
  return out;
}

/** The lobby a room on the page's server stands for. */
export function roomToLobby(r: RoomSummary, version: number = PROTOCOL_VERSION): SteamLobbySummary {
  return {
    id: codeToLobbyId(r.code),
    name: r.name,
    host: 'Stand-in host',
    members: r.humans,
    max: r.slots,
    info: { game: 'hookwars', v: String(version), name: r.name, room: r.code, map: r.mapId, mode: r.riverMode, phase: r.phase, humans: String(r.humans), max: String(r.slots) },
  };
}

export interface FakeSteamControls {
  published: Record<string, string>[];
  invites: number;
  cloudFail: boolean;
  overlay: string[];
  /** the unfiltered lobby list the last listLobbies returned */
  lastRaw: SteamLobbySummary[];
  requestJoin(codeOrLobbyId: string): void;
}

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function store(kind: 'local' | 'session'): Storage | null {
  try {
    const s = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/** Ask the page's server for its room list over a short-lived socket of its own. */
function listRooms(serverUrl: string, tokenStore: Storage | null): Promise<RoomSummary[]> {
  return new Promise((resolve, reject) => {
    const tokenKey = 'hookwars.fakesteam.listtoken';
    let token: string | null = null;
    try {
      token = tokenStore?.getItem(tokenKey) ?? null;
    } catch {
      token = null;
    }
    const ws = new WebSocket(serverUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('the server did not answer'));
    }, 4000);
    ws.addEventListener('open', () => {
      // reuse one guest token, so refreshing never counts as a new account on a server with accounts
      const hello = { t: 'hello', v: PROTOCOL_VERSION, profile: { name: 'Lobby list', family: 'brawler', loadout: {} }, ...(token ? { account: token } : {}) };
      ws.send(JSON.stringify(hello));
    });
    ws.addEventListener('message', (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      if (m.t === 'account' && m.token) {
        try {
          tokenStore?.setItem(tokenKey, m.token);
        } catch {
          // no storage: a new guest next time
        }
      }
      if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'listRooms' }));
      if (m.t === 'rooms') {
        clearTimeout(timer);
        ws.close();
        resolve(m.rooms);
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('could not reach the server'));
    });
  });
}

export function createFakeSteamBridge(o: { serverUrl: string; name?: string }): SteamBridge & { controls: FakeSteamControls } {
  const session = store('session');
  const local = store('local');
  let steamId = '';
  try {
    steamId = session?.getItem('hookwars.fakesteam.id') ?? '';
  } catch {
    steamId = '';
  }
  if (!/^\d{17}$/.test(steamId)) {
    steamId = `7656119${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
    try {
      session?.setItem('hookwars.fakesteam.id', steamId);
    } catch {
      // a new id per page load
    }
  }
  const name = (o.name ?? '').replace(/[^\w ]/g, '').slice(0, 24) || `Stand-in ${steamId.slice(-3)}`;
  const joinCbs = new Set<(id: string) => void>();
  let fullscreen = false;
  const controls: FakeSteamControls = {
    published: [],
    invites: 0,
    cloudFail: false,
    overlay: [],
    lastRaw: [],
    requestJoin(codeOrId: string) {
      const v = String(codeOrId).trim().toUpperCase();
      const id = /^[A-Z]{5}$/.test(v) ? codeToLobbyId(v) : v;
      for (const cb of joinCbs) cb(id);
    },
  };
  const bridge: SteamBridge & { controls: FakeSteamControls } = {
    kind: 'steam',
    appId: 480,
    fake: true,
    controls,
    player: async () => ({ steamId, name }),
    async hostLobby(opts) {
      console.info('[fakesteam] hostLobby', opts);
      return { lobbyId: String(Date.now()).slice(-12), url: o.serverUrl };
    },
    async joinLobby(lobbyId) {
      console.info('[fakesteam] joinLobby', lobbyId, lobbyIdToCode(lobbyId));
      return { url: o.serverUrl };
    },
    async leaveLobby() {
      console.info('[fakesteam] leaveLobby');
    },
    async listLobbies() {
      const rooms = await listRooms(o.serverUrl, session);
      const raw: SteamLobbySummary[] = [
        ...rooms.map((r) => roomToLobby(r)),
        // app 480 is shared with other developers: the lobby browser must hide these two
        { id: '424242', name: 'Spacewar dogfight', host: 'someone else', members: 2, max: 4, info: { game: 'spacewar' } },
        { id: '434343', name: 'An older Hook Wars', host: 'old build', members: 1, max: 6, info: { game: 'hookwars', v: String(PROTOCOL_VERSION - 1), room: 'QQQQQ' } },
      ];
      controls.lastRaw = raw;
      return raw;
    },
    async setLobbyInfo(info) {
      // like the desktop app (desktop/src/validate.ts lobbyInfo): game, v and host are its own keys
      for (const k of ['game', 'v', 'host']) if (k in info) throw new Error(`key ${k} is set by the app`);
      controls.published.push({ ...info });
      console.info('[fakesteam] setLobbyInfo', info);
    },
    inviteFriends() {
      controls.invites++;
      console.info('[fakesteam] invite dialog (Steam overlay)');
    },
    onJoinRequest(cb) {
      joinCbs.add(cb);
      return () => joinCbs.delete(cb);
    },
    async cloudRead(file) {
      if (controls.cloudFail) throw new Error('fake Steam Cloud is off');
      return local?.getItem(`hookwars.fakecloud.${file}`) ?? null;
    },
    async cloudWrite(file, data) {
      if (controls.cloudFail) return false;
      try {
        local?.setItem(`hookwars.fakecloud.${file}`, data);
        return true;
      } catch {
        return false;
      }
    },
    openOverlayUrl(url) {
      controls.overlay.push(url);
      console.info('[fakesteam] overlay', url);
    },
    setFullscreen(on) {
      fullscreen = on;
      const d = globalThis.document;
      try {
        if (on && !d?.fullscreenElement) void d?.documentElement.requestFullscreen?.().catch(() => {});
        if (!on && d?.fullscreenElement) void d.exitFullscreen?.().catch(() => {});
      } catch {
        // the browser refused (no click): the fake still reports the choice
      }
    },
    isFullscreen: async () => fullscreen || !!globalThis.document?.fullscreenElement,
    quit() {
      console.info('[fakesteam] quit');
    },
  };
  return bridge;
}

/**
 * Install the stand-in when the address has ?debug and ?fakesteam, there is no real bridge, and the
 * page came from a game server. True when installed.
 */
export function installFakeSteamFromUrl(): boolean {
  const g = globalThis as { location?: { search: string }; hookwarsSteam?: unknown; __fakeSteam?: unknown };
  if (!g.location) return false;
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(g.location.search);
  } catch {
    return false;
  }
  if (!q.has('debug') || !q.has('fakesteam')) return false;
  if (steamBridge() || g.hookwarsSteam !== undefined) return false; // never over a real bridge
  const url = defaultServerUrl();
  if (!url) return false;
  const b = createFakeSteamBridge({ serverUrl: url, name: q.get('fakesteam') ?? '' });
  g.hookwarsSteam = b;
  g.__fakeSteam = b.controls;
  console.info('[fakesteam] stand-in Steam bridge installed (debug build)');
  return true;
}
