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
  };
}
