// Runs the normal Hook Wars game server as a child process for a lobby this player hosts:
//   - on 127.0.0.1 only, on a free port (picked by binding port 0: the server reads PORT=0 as "use 8080")
//   - ECONOMY=trust (no accounts, no database), RELAY_SECRET = fresh random per run, ALLOWED_ORIGINS = the app
//   - ready once a WebSocket hello gets a welcome of our protocol version while the child is alive
//   - restarted when it crashes (same port first, so the page's rejoin goes to the same address)
//   - stopped cleanly with the lobby
// The process itself comes from an injected spawn function: Electron's utilityProcess in the app
// (main.ts), child_process.spawn of node in the tests.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import { defaultProfile } from '../../shared/protocol.ts';
import { APP_ORIGIN } from './constants.ts';

export interface ChildHandle {
  readonly pid?: number;
  kill(): void;
  /** called once when the process ends (code null when it was killed) */
  onExit(cb: (code: number | null) => void): void;
  /** stdout and stderr, a line at a time */
  onOutput(cb: (line: string) => void): void;
}

export type SpawnServer = (env: Record<string, string>) => ChildHandle;

export type EconomyMode = 'trust' | 'off';

export interface LauncherOptions {
  spawn: SpawnServer;
  /** shown to players as the server name (the lobby name) */
  serverName: string;
  economy?: EconomyMode;
  /** an empty folder for STATIC_DIR (the page is served by the app, not by this server) */
  staticDir: string;
  /** where ECONOMY_DATA_DIR points, only as a safety net (trust mode never opens it) */
  dataDir: string;
  /** inherited environment; only a safe allowlist of it is passed on */
  parentEnv?: Record<string, string | undefined>;
  readyTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  log?: (s: string) => void;
}

/** Environment variables a child process may inherit (paths and locale; nothing that changes Node or the server). */
const INHERIT = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL'];

/** Call cb with each line a stream prints (stdout or stderr of the server). */
export function forEachLine(stream: NodeJS.ReadableStream | null | undefined, cb: (line: string) => void): void {
  if (!stream) return;
  let rest = '';
  stream.on('data', (chunk: Buffer | string) => {
    rest += chunk.toString();
    if (rest.length > 64 * 1024) rest = rest.slice(-64 * 1024); // a line that never ends
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) cb(l.slice(0, 1000));
  });
  stream.on('end', () => {
    if (rest.trim()) cb(rest.slice(0, 1000));
    rest = '';
  });
}

/** A port nobody is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.once('error', reject);
    s.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** One WebSocket hello: true when a Hook Wars server of our protocol version answers with this server name. */
export function probeServer(url: string, serverName: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close(1000, 'probe');
      } catch {
        ws.terminate();
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, profile: defaultProfile() })));
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d.toString()) as { t?: string; v?: number; serverName?: string };
        if (m.t === 'welcome') finish(m.v === PROTOCOL_VERSION && m.serverName === serverName);
        else if (m.t === 'error') finish(false);
      } catch {
        finish(false);
      }
    });
    ws.on('error', () => finish(false));
    ws.on('close', () => finish(false));
  });
}

/** The SERVER_NAME the server will report (server/config.ts strips control characters and <>, max 40). */
export function serverNameAsReported(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 40) || 'Hook Wars Server';
}

export class ServerLauncher {
  /** RELAY_SECRET for this run: 64 hex characters (the server accepts [A-Za-z0-9_-]{16,128}) */
  readonly secret = randomBytes(32).toString('hex');
  private readonly opts: LauncherOptions;
  private readonly log: (s: string) => void;
  /** every process this launcher started that has not exited yet */
  private readonly alive = new Set<ChildHandle>();
  /** the process that answered and serves the lobby (null while starting or stopped) */
  private serving: ChildHandle | null = null;
  private port: number | null = null;
  private stopping = false;
  private restarts: number[] = [];
  private exitWaiters: (() => void)[] = [];
  /** called with the (possibly new) url after a crash and restart */
  onRestart: ((url: string) => void) | null = null;
  /** called when the server crashed and could not be brought back */
  onFailed: ((reason: string) => void) | null = null;
  /** the last lines the server printed (for error reports) */
  readonly recent: string[] = [];

  constructor(opts: LauncherOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((s) => console.log(s));
  }

  get url(): string | null {
    return this.serving && this.port ? `ws://127.0.0.1:${this.port}/ws` : null;
  }

  get running(): boolean {
    return this.serving !== null;
  }

  /** The environment the server runs with (exported for tests). */
  envFor(port: number): Record<string, string> {
    const env: Record<string, string> = {};
    const parent = this.opts.parentEnv ?? process.env;
    for (const k of INHERIT) {
      const v = parent[k];
      if (typeof v === 'string') env[k] = v;
    }
    Object.assign(env, {
      HOST: '127.0.0.1',
      PORT: String(port),
      ECONOMY: this.opts.economy ?? 'trust',
      ECONOMY_DATA_DIR: this.opts.dataDir,
      RELAY_SECRET: this.secret,
      ALLOWED_ORIGINS: APP_ORIGIN,
      SERVER_NAME: this.opts.serverName,
      MOTD: 'Hosted from a Steam lobby.',
      STATIC_DIR: this.opts.staticDir,
      // relayed players are keyed by their SteamID (RELAY_SECRET); these caps only matter if that is off
      MAX_CLIENTS: '48',
      MAX_PER_IP: '12',
      MAX_ROOMS: '4',
      MAX_ROOMS_PER_IP: '2',
      NODE_ENV: 'production',
    });
    return env;
  }

  /** Start the server and wait until it answers. Returns its ws URL. */
  async start(): Promise<string> {
    const running = this.url;
    if (running) return running;
    this.stopping = false;
    return this.launch(await freePort(), true);
  }

  private async launch(port: number, firstTry: boolean): Promise<string> {
    const timeout = this.opts.readyTimeoutMs ?? 15_000;
    const child = this.opts.spawn(this.envFor(port));
    this.alive.add(child);
    let exited = false;
    let exitCode: number | null = null;
    child.onOutput((line) => {
      this.recent.push(line);
      if (this.recent.length > 40) this.recent.shift();
      this.log(`[server] ${line}`);
    });
    child.onExit((code) => {
      exited = true;
      exitCode = code;
      this.alive.delete(child);
      for (const w of this.exitWaiters.splice(0)) w();
      if (this.serving === child) this.onCrash(code);
    });
    const url = `ws://127.0.0.1:${port}/ws`;
    const name = serverNameAsReported(this.opts.serverName);
    const t0 = Date.now();
    while (Date.now() - t0 < timeout && !exited && !this.stopping) {
      if (await probeServer(url, name)) {
        if (exited || this.stopping) break;
        this.serving = child;
        this.port = port;
        return url;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!exited) child.kill();
    if (this.stopping) throw new Error('stopped');
    if (exited && firstTry) {
      // most likely the port was taken in the moment between choosing it and binding it: once more
      this.log(`[server] exited during start (code ${exitCode}); trying another port`);
      return this.launch(await freePort(), false);
    }
    throw new Error(exited ? `The game server stopped while starting (code ${exitCode}). ${this.recent.slice(-3).join(' | ')}` : 'The game server did not start in time.');
  }

  /** The serving process died on its own: bring it back (same port first), a few times at most. */
  private onCrash(code: number | null): void {
    this.serving = null;
    const samePort = this.port;
    if (this.stopping) return;
    const now = Date.now();
    const windowMs = this.opts.restartWindowMs ?? 60_000;
    this.restarts = this.restarts.filter((t) => now - t < windowMs);
    if (this.restarts.length >= (this.opts.maxRestarts ?? 3)) {
      this.log(`[server] crashed again (code ${code}); giving up`);
      this.port = null;
      this.onFailed?.(`The game server keeps crashing (code ${code}).`);
      return;
    }
    this.restarts.push(now);
    this.log(`[server] crashed (code ${code}); restarting`);
    void (async () => {
      try {
        let url: string;
        try {
          url = await this.launch(samePort ?? (await freePort()), false);
        } catch (err) {
          if (this.stopping) return;
          this.log(`[server] restart on port ${samePort} failed (${(err as Error).message}); trying a new port`);
          url = await this.launch(await freePort(), false);
        }
        if (!this.stopping) this.onRestart?.(url);
      } catch (err) {
        if (!this.stopping) this.onFailed?.((err as Error).message);
      }
    })();
  }

  /** Stop the server: kill every process this launcher started, then wait (at most waitMs) for them to exit. */
  async stop(waitMs = 3000): Promise<void> {
    this.stopping = true;
    this.serving = null;
    this.port = null;
    if (this.alive.size === 0) return;
    const gone = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      const check = () => {
        if (this.alive.size === 0) {
          clearTimeout(timer);
          resolve();
        } else this.exitWaiters.push(check);
      };
      this.exitWaiters.push(check);
    });
    for (const c of [...this.alive]) c.kill();
    await gone;
  }
}
