// Minimal type declarations for the parts of Electron that main.ts and preload.ts use, so the desktop
// code typechecks on a machine without Electron installed (desktop/tsconfig.json maps 'electron' here).
// Signatures follow Electron 44's electron.d.ts. On a machine with `npm install` done in desktop/,
// `npm run typecheck:electron` checks the same files against the real types instead.

export interface Event {
  preventDefault(): void;
}

export interface WebFrameMain {
  readonly url: string;
}

export interface WebContents {
  readonly id: number;
  readonly mainFrame: WebFrameMain;
  send(channel: string, ...args: unknown[]): void;
  on(event: 'will-navigate' | 'will-redirect', listener: (event: Event, url: string) => void): this;
  on(event: 'will-attach-webview', listener: (event: Event) => void): this;
  on(event: 'did-start-loading', listener: () => void): this;
  on(event: 'render-process-gone', listener: (event: Event, details: { reason: string; exitCode: number }) => void): this;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' } | { action: 'allow' }): void;
}

export interface IpcMainInvokeEvent {
  readonly sender: WebContents;
  readonly senderFrame: WebFrameMain | null;
}

export interface IpcRendererEvent {
  readonly sender: unknown;
}

export interface WebPreferences {
  preload?: string;
  contextIsolation?: boolean;
  sandbox?: boolean;
  nodeIntegration?: boolean;
  nodeIntegrationInWorker?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  webviewTag?: boolean;
  spellcheck?: boolean;
  navigateOnDragDrop?: boolean;
  devTools?: boolean;
  backgroundThrottling?: boolean;
  additionalArguments?: string[];
}

export interface BrowserWindowConstructorOptions {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  show?: boolean;
  title?: string;
  backgroundColor?: string;
  autoHideMenuBar?: boolean;
  webPreferences?: WebPreferences;
}

export declare class BrowserWindow {
  constructor(options?: BrowserWindowConstructorOptions);
  readonly webContents: WebContents;
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  restore(): void;
  isMinimized(): boolean;
  isDestroyed(): boolean;
  setFullScreen(flag: boolean): void;
  isFullScreen(): boolean;
  once(event: 'ready-to-show', listener: () => void): this;
  on(event: 'closed', listener: () => void): this;
}

export interface CommandLine {
  appendSwitch(the_switch: string, value?: string): void;
}

export interface App {
  readonly isPackaged: boolean;
  readonly commandLine: CommandLine;
  whenReady(): Promise<void>;
  quit(): void;
  exit(exitCode?: number): void;
  getAppPath(): string;
  getPath(name: 'userData' | 'logs' | 'temp'): string;
  setPath(name: 'userData', path: string): void;
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: (event: Event, argv: string[], workingDirectory: string) => void): this;
  on(event: 'window-all-closed', listener: () => void): this;
  on(event: 'before-quit', listener: (event: Event) => void): this;
  on(event: 'web-contents-created', listener: (event: Event, contents: WebContents) => void): this;
}
export declare const app: App;

export interface IpcMain {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
}
export declare const ipcMain: IpcMain;

export interface CustomScheme {
  scheme: string;
  privileges?: { standard?: boolean; secure?: boolean; supportFetchAPI?: boolean; codeCache?: boolean; corsEnabled?: boolean; stream?: boolean };
}

export interface Protocol {
  registerSchemesAsPrivileged(customSchemes: CustomScheme[]): void;
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
}
export declare const protocol: Protocol;

export interface OnBeforeRequestListenerDetails {
  url: string;
}

export interface Session {
  setPermissionRequestHandler(handler: ((webContents: WebContents, permission: string, callback: (granted: boolean) => void) => void) | null): void;
  setPermissionCheckHandler(handler: ((webContents: WebContents | null, permission: string) => boolean) | null): void;
  setDevicePermissionHandler(handler: ((details: unknown) => boolean) | null): void;
  webRequest: {
    onBeforeRequest(filter: { urls: string[] }, listener: (details: OnBeforeRequestListenerDetails, callback: (response: { cancel?: boolean }) => void) => void): void;
  };
}
export declare const session: { readonly defaultSession: Session };

export interface UtilityProcess {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(): boolean;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'spawn', listener: () => void): this;
}

export interface ForkOptions {
  env?: Record<string, string>;
  cwd?: string;
  stdio?: 'pipe' | 'ignore' | 'inherit';
  serviceName?: string;
}

export declare const utilityProcess: {
  fork(modulePath: string, args?: string[], options?: ForkOptions): UtilityProcess;
};

export declare const Menu: {
  setApplicationMenu(menu: null): void;
};

export interface ContextBridge {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}
export declare const contextBridge: ContextBridge;

export interface IpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): this;
  removeListener(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): this;
}
export declare const ipcRenderer: IpcRenderer;

declare global {
  namespace NodeJS {
    interface Process {
      /** Electron: the folder with the app's resources (app.asar, app.asar.unpacked) */
      readonly resourcesPath: string;
    }
  }
}
