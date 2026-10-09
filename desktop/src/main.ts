// Electron main process of the Hook Wars Steam desktop app. Deliberately thin: everything that can run
// without Electron lives in ./desktopBridge.ts and the modules it uses, and is tested with Node.
//
// Security: contextIsolation, sandbox, no Node in the page; the client is served from app://hookwars
// (./appProtocol.ts) with a strict CSP; no remote content (http and https requests are cancelled);
// navigation, new windows and webviews are blocked; every permission request is denied; IPC is only
// answered for our own page and every argument is checked (./validate.ts, inside DesktopBridge).
import { BrowserWindow, Menu, app, ipcMain, protocol, session, utilityProcess, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { appHeaders, resolveAppRequest } from './appProtocol.ts';
import { APP_ORIGIN, APP_SCHEME, isSteamId64 } from './constants.ts';
import { DesktopBridge, JoinRequestQueue } from './desktopBridge.ts';
import { DEFAULT_HUB_PORT, FakeSteamBackend, connectOrHostHub, randomFakeSteamId } from './fakeSteam.ts';
import { ARG_APP_ID, ARG_FAKE, IPC, JOIN_REQUEST_EVENT, type Reply } from './ipc.ts';
import { chooseAppId, parseLaunchArgs } from './launchArgs.ts';
import { forEachLine, type ChildHandle, type SpawnServer } from './serverLauncher.ts';
import type { SteamBackend } from './steamBackend.ts';
import { SteamworksBackend, type SwModule } from './steamworksBackend.ts';
import * as check from './validate.ts';

// ---- before ready: profile folder, single instance, Steam, the app:// scheme ------------------------

const args = parseLaunchArgs(process.argv, process.env);
const appDir = app.getAppPath(); // desktop/ in development, resources/app.asar when packaged
const buildDir = join(appDir, 'build');
const clientDir = join(buildDir, 'client');
// the server bundle is unpacked from the asar archive (package.json build.asarUnpack)
const serverEntry = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'build', 'server.mjs') : join(buildDir, 'server.mjs');

// a second window on one PC with the stand-in gets its own profile (and so its own lock and locker)
if (args.instance && args.instance > 1) app.setPath('userData', `${app.getPath('userData')}-${args.instance}`);
const dataDir = app.getPath('userData');
mkdirSync(dataDir, { recursive: true });

const logFile = join(dataDir, 'hookwars-desktop.log');
function log(s: string): void {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  try {
    if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 2 * 1024 * 1024) renameSync(logFile, `${logFile}.old`);
    appendFileSync(logFile, `${line}\n`);
  } catch {
    // logging must never take the app down
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// one window per profile; a second launch (Steam's +connect_lobby while we run) reaches 'second-instance'
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);

/** The real Steam, or null (stand-in asked for, steamworks.js missing, or Steam not running). */
function startSteamworks(): SteamworksBackend | null {
  if (args.fake) {
    log('[steam] stand-in requested (HOOKWARS_FAKE_STEAM=1 or --fake-steam)');
    return null;
  }
  let mod: SwModule;
  try {
    mod = createRequire(join(appDir, 'package.json'))('steamworks.js') as SwModule;
  } catch (err) {
    log(`[steam] steamworks.js could not be loaded (${(err as Error).message}): using the stand-in`);
    return null;
  }
  const appId = chooseAppId(process.env, readText(join(process.cwd(), 'steam_appid.txt')) ?? (app.isPackaged ? null : readText(join(appDir, 'steam_appid.txt'))));
  try {
    const backend = new SteamworksBackend({ module: mod, appId, log });
    mod.electronEnableSteamOverlay?.(); // must run before the app is ready
    log(`[steam] Steam is running: app ${appId ?? '(from Steam)'}, player ${backend.me().name}`);
    return backend;
  } catch (err) {
    log(`[steam] Steam is not running or not logged in (${(err as Error).message}): using the stand-in`);
    return null;
  }
}

const steam = primary ? startSteamworks() : null;

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);

// ---- the stand-in -----------------------------------------------------------------------------------

async function startFakeSteam(): Promise<SteamBackend> {
  const port = Number(process.env.HOOKWARS_FAKE_STEAM_PORT) || DEFAULT_HUB_PORT;
  const { link, server } = await connectOrHostHub(port);
  log(server ? `[fakesteam] started the stand-in hub on 127.0.0.1:${port}` : `[fakesteam] joined the stand-in hub on 127.0.0.1:${port}`);
  // a stable stand-in id per profile, so this window is the same "player" after a restart
  const idFile = join(dataDir, 'fake-steam-id.txt');
  let steamId = (readText(idFile) ?? '').trim();
  if (!isSteamId64(steamId)) {
    steamId = randomFakeSteamId();
    try {
      writeFileSync(idFile, steamId);
    } catch {
      // a new id next time, no harm
    }
  }
  return FakeSteamBackend.connect({ link, server, steamId, name: args.fakeName ?? undefined, cloudDir: join(dataDir, 'fake-cloud'), log });
}

// ---- the local game server as an Electron utility process ------------------------------------------

const spawnServer: SpawnServer = (env) => {
  const child = utilityProcess.fork(serverEntry, [], { env, cwd: dataDir, stdio: 'pipe', serviceName: 'Hook Wars game server' });
  let exitCb: ((code: number | null) => void) | null = null;
  let exited = false;
  child.on('exit', (code) => {
    if (exited) return;
    exited = true;
    exitCb?.(code);
  });
  const handle: ChildHandle = {
    get pid() {
      return child.pid;
    },
    kill: () => {
      child.kill();
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    onOutput: (cb) => {
      forEachLine(child.stdout, cb);
      forEachLine(child.stderr, cb);
    },
  };
  return handle;
};

// ---- window, protocol, IPC --------------------------------------------------------------------------

let win: BrowserWindow | null = null;
let bridge: DesktopBridge | null = null;
const joins = new JoinRequestQueue((id) => {
  if (win && !win.isDestroyed()) win.webContents.send(JOIN_REQUEST_EVENT, id);
});

app.on('second-instance', (_e, argv) => {
  const a = parseLaunchArgs(argv);
  if (a.joinLobby) joins.push(a.joinLobby);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

function fromOurPage(e: IpcMainInvokeEvent): boolean {
  return !!win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame === e.sender.mainFrame && check.isTrustedSender(e.senderFrame?.url);
}

/** An IPC handler: only for our page, exact argument count, errors returned as a message. */
function handle(channel: string, arity: number, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (e, ...a): Promise<Reply<unknown>> => {
    if (!fromOurPage(e)) return { ok: false, error: 'refused' };
    if (a.length !== arity) return { ok: false, error: 'wrong number of arguments' };
    try {
      return { ok: true, value: (await fn(...a)) ?? null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function registerIpc(b: DesktopBridge): void {
  handle(IPC.player, 0, () => b.player());
  handle(IPC.hostLobby, 1, (o) => b.hostLobby(o));
  handle(IPC.joinLobby, 1, (id) => b.joinLobby(id));
  handle(IPC.leaveLobby, 0, () => b.leaveLobby());
  handle(IPC.listLobbies, 0, () => b.listLobbies());
  handle(IPC.setLobbyInfo, 1, (info) => b.setLobbyInfo(info));
  handle(IPC.inviteFriends, 0, () => b.inviteFriends());
  handle(IPC.cloudRead, 1, (name) => b.cloudRead(name));
  handle(IPC.cloudWrite, 2, (name, data) => b.cloudWrite(name, data));
  handle(IPC.openOverlayUrl, 1, (url) => b.openOverlayUrl(url));
  handle(IPC.setFullscreen, 1, (on) => {
    const v = check.flag(on);
    if (!v.ok) throw new Error(v.error);
    win?.setFullScreen(v.value);
  });
  handle(IPC.isFullscreen, 0, () => win?.isFullScreen() ?? false);
  handle(IPC.quit, 0, () => {
    setImmediate(() => app.quit());
  });
  handle(IPC.takePendingJoin, 0, () => joins.take());
}

function createWindow(b: DesktopBridge): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Hook Wars',
    backgroundColor: '#0e1420',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(buildDir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
      additionalArguments: [`${ARG_APP_ID}${b.info.appId}`, `${ARG_FAKE}${b.info.fake ? 1 : 0}`],
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  win.webContents.on('did-start-loading', () => joins.reset());
  win.webContents.on('render-process-gone', (_e, d) => log(`[app] the page crashed (${d.reason}, ${d.exitCode})`));
  void win.loadURL(`${APP_ORIGIN}/index.html`);
}

app.on('window-all-closed', () => app.quit());

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !bridge) return;
  e.preventDefault();
  quitting = true;
  const b = bridge;
  bridge = null;
  void b.shutdown().finally(() => app.quit());
});

void app.whenReady().then(async () => {
  if (!primary) return;
  Menu.setApplicationMenu(null);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // no remote content: the page is app://, game traffic is ws:// and wss://
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
  protocol.handle(APP_SCHEME, async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });
    const r = resolveAppRequest(req.url, clientDir);
    if (!r.ok) return new Response(null, { status: r.status });
    try {
      const body = await readFile(r.file);
      return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers: appHeaders(r.mime) });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  let backend: SteamBackend;
  try {
    backend = steam ?? (await startFakeSteam());
  } catch (err) {
    log(`[fakesteam] ${(err as Error).message}`);
    app.exit(1);
    return;
  }
  const b = new DesktopBridge({ backend, spawnServer, dataDir, onJoinRequest: (id) => joins.push(id), log });
  bridge = b;
  registerIpc(b);
  createWindow(b);
  if (args.joinLobby) joins.push(args.joinLobby);
});
