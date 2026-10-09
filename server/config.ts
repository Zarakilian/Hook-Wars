// Server settings from environment variables. Safe defaults for running on your own machine.
//   HOST            interface to bind. Default 127.0.0.1 (this machine only). Use 0.0.0.0 to accept LAN/internet players.
//   PORT            default 8080
//   SERVER_NAME     shown in the server browser
//   MOTD            one line shown to players when they connect
//   MAX_CLIENTS     total websocket connections (default 200)
//   MAX_PER_IP      connections per IP address (default 6)
//   MAX_ROOMS       concurrent rooms (default 24)
//   TRUST_PROXY     "1" if your reverse proxy runs on this machine, or a comma list of proxy IPs.
//                   X-Forwarded-For is only read from those addresses (the right-most entry).
//   MAX_ROOMS_PER_IP rooms one IP address can have open at once (default 2)
//   ALLOWED_ORIGINS comma separated list of extra browser origins allowed to connect (default: same host only)
//   STATIC_DIR      folder with the built client (default ./dist)
//   TICK_PRECISE    "0" turns off the precise tick timer. On Windows the default timer only wakes every
//                   15.6 ms, so the loop finishes each tick wait with a short spin (about 1 ms cadence,
//                   some extra CPU). With 0, ticks land within about 15 ms of their deadline instead.
//   RELAY_SECRET    set only by the Steam desktop app when it hosts a lobby: a fresh random value per run,
//                   16 to 128 characters of A-Z a-z 0-9 _ -. A websocket from 127.0.0.1 that carries
//                   x-hookwars-relay: <this secret> and x-hookwars-peer: steam:<steamid64> is a Steam player
//                   relayed by the app, and that peer id replaces the IP address for every per-IP limit and
//                   for the economy. Unset (the default), empty or malformed: both headers are ignored.

/** The Steam desktop app's relay headers (see RELAY_SECRET above). */
export const RELAY_SECRET_HEADER = 'x-hookwars-relay';
export const RELAY_PEER_HEADER = 'x-hookwars-peer';
/** A relayed Steam player: "steam:" and a 64-bit SteamID in decimal. */
export const RELAY_PEER_RE = /^steam:[0-9]{1,20}$/;
/** The shape RELAY_SECRET must have to be used at all. */
export const RELAY_SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** RELAY_SECRET, or null when it is unset, empty or not in the RELAY_SECRET_RE shape. */
export function relaySecretFrom(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  return RELAY_SECRET_RE.test(v) ? v : null;
}

function intEnv(name: string, def: number, lo: number, hi: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < lo || n > hi) return def;
  return n;
}

function strEnv(name: string, def: string, maxLen: number): string {
  const raw = process.env[name];
  if (!raw) return def;
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, maxLen);
}

export interface ServerConfig {
  host: string;
  port: number;
  serverName: string;
  motd: string;
  maxClients: number;
  maxPerIp: number;
  maxRooms: number;
  trustedProxies: string[];
  maxRoomsPerIp: number;
  allowedOrigins: string[];
  staticDir: string;
  /** spin the last few ms of each tick wait for an even 33 ms cadence (default true) */
  preciseTicks?: boolean;
  /** ws ping interval; a socket that neither answers a ping nor sends anything for this long is closed */
  heartbeatMs?: number;
  /** RELAY_SECRET: trust the Steam relay headers on sockets from 127.0.0.1 (null or absent = never) */
  relaySecret?: string | null;
}

export function loadConfig(): ServerConfig {
  return {
    host: strEnv('HOST', '127.0.0.1', 64),
    port: intEnv('PORT', 8080, 1, 65535),
    serverName: strEnv('SERVER_NAME', 'Hook Wars Server', 40),
    motd: strEnv('MOTD', 'Welcome to Hook Wars. Mind the river.', 120),
    maxClients: intEnv('MAX_CLIENTS', 200, 1, 5000),
    maxPerIp: intEnv('MAX_PER_IP', 6, 1, 100),
    maxRooms: intEnv('MAX_ROOMS', 24, 1, 500),
    trustedProxies: (() => {
      const raw = (process.env.TRUST_PROXY ?? '').trim();
      if (!raw) return [];
      if (raw === '1') return ['127.0.0.1', '::1']; // a proxy on this machine
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    })(),
    maxRoomsPerIp: intEnv('MAX_ROOMS_PER_IP', 2, 1, 500),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    staticDir: process.env.STATIC_DIR ?? 'dist',
    preciseTicks: (process.env.TICK_PRECISE ?? '1').trim() !== '0',
    relaySecret: relaySecretFrom(process.env.RELAY_SECRET),
  };
}
