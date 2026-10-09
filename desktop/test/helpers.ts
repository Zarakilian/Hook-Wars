// Shared bits for the desktop tests: a node child process as the server spawner, a WebSocket client
// with an inbox, and small wait helpers. Every test closes what it opens (node --test waits on handles).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import { defaultProfile, type ServerMsg } from '../../shared/protocol.ts';
import { APP_ORIGIN } from '../src/constants.ts';
import { forEachLine, type ChildHandle, type SpawnServer } from '../src/serverLauncher.ts';

export const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const rootDir = resolve(desktopDir, '..');
export const SERVER_SOURCE = join(rootDir, 'server', 'index.ts');

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `hw-desktop-${prefix}-`));
}

/** Spawn `node <entry>` with exactly the environment the launcher builds (what utilityProcess does in the app). */
export function nodeSpawner(entry: string, spawned: ChildHandle[] = []): SpawnServer {
  return (env) => {
    const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let exitCb: ((code: number | null) => void) | null = null;
    let exited = false;
    child.on('exit', (code) => {
      if (exited) return;
      exited = true;
      exitCb?.(code);
    });
    const h: ChildHandle = {
      get pid() {
        return child.pid;
      },
      kill: () => {
        child.kill();
      },
      onExit: (cb) => {
        exitCb = cb;
        if (exited) cb(child.exitCode);
      },
      onOutput: (cb) => {
        forEachLine(child.stdout, cb);
        forEachLine(child.stderr, cb);
      },
    };
    spawned.push(h);
    return h;
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until(pred: () => boolean, ms = 4000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

export interface TestClient {
  ws: WebSocket;
  inbox: ServerMsg[];
  open: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  bytes: () => number;
  send(m: unknown): void;
  wait<T extends ServerMsg['t']>(t: T, pred?: (m: Extract<ServerMsg, { t: T }>) => boolean, ms?: number): Promise<Extract<ServerMsg, { t: T }>>;
}

/** A game client: by default it presents itself as the app's page (Origin app://hookwars). */
export function client(url: string, opts: { origin?: string | null } = {}): TestClient {
  const origin = opts.origin === undefined ? APP_ORIGIN : opts.origin;
  const ws = new WebSocket(url, origin ? { origin } : {});
  const inbox: ServerMsg[] = [];
  let received = 0;
  const waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  ws.on('message', (d) => {
    const text = d.toString();
    received += text.length;
    const m = JSON.parse(text) as ServerMsg;
    inbox.push(m);
    if (inbox.length > 2000) inbox.splice(0, 1000);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        waiters[i].res(m);
        waiters.splice(i, 1);
      }
    }
  });
  const open = new Promise<void>((r, j) => {
    ws.once('open', () => r());
    ws.once('error', j);
  });
  open.catch(() => {});
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));
  return {
    ws,
    inbox,
    open,
    closed,
    bytes: () => received,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (t, pred = () => true, ms = 5000) =>
      new Promise((res, rej) => {
        type M = Extract<ServerMsg, { t: typeof t }>;
        const match = (m: ServerMsg) => m.t === t && pred(m as M);
        const found = inbox.find(match);
        if (found) return res(found as M);
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), ms);
        waiters.push({
          pred: match,
          res: (m) => {
            clearTimeout(timer);
            res(m as M);
          },
        });
      }),
  };
}

export function hello(c: TestClient, name: string): void {
  c.send({ t: 'hello', v: PROTOCOL_VERSION, profile: { ...defaultProfile(), name } });
}

export function closeQuietly(c: TestClient | null | undefined): void {
  if (!c) return;
  try {
    c.ws.terminate();
  } catch {
    // already gone
  }
}
