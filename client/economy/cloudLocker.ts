// Steam Cloud copy of the offline locker (the Steam build only; client/economy/index.ts useCloud).
// localStorage stays the first copy: it is written on every change, at once. The Cloud copy follows
// a moment later (debounced, latest data wins), and a failed Cloud write keeps the data and tries
// again later, so the locker is never lost because Steam Cloud is off, full or slow.

/** What the Steam bridge offers for Cloud files (SteamBridge.cloudRead / cloudWrite). */
export interface CloudStore {
  /** the file's text, or null when there is no such file; rejects when the Cloud cannot be read */
  read(name: string): Promise<string | null>;
  /** true once saved */
  write(name: string, data: string): Promise<boolean>;
}

/** The Cloud file that holds the locker. */
export const CLOUD_LOCKER_FILE = 'locker.v1.json';
/** A locker bigger than this is not sent to (or read from) the Cloud: something is wrong with it. */
export const CLOUD_MAX_BYTES = 256 * 1024;
/** Cloud writes wait this long after the last change, so a burst of changes is one write. */
export const CLOUD_DEBOUNCE_MS = 1500;
/** First retry after a failed write; doubles up to CLOUD_RETRY_MAX_MS. */
export const CLOUD_RETRY_MS = 5000;
export const CLOUD_RETRY_MAX_MS = 60_000;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = globalThis.setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.(); // never keeps a test process alive
    return t;
  },
  clearTimeout: (t) => globalThis.clearTimeout(t as number),
};

export interface CloudSaverOptions {
  file?: string;
  debounceMs?: number;
  retryMs?: number;
  retryMaxMs?: number;
  timers?: Timers;
  log?: (s: string) => void;
}

/**
 * Debounced writer for one Cloud file. schedule() takes the newest data; the write happens
 * debounceMs after the last call. While held (hold(true)) nothing is written: the locker waits for
 * its first Cloud read, so a stale copy here never overwrites a newer one from another computer.
 */
export class CloudSaver {
  private readonly store: CloudStore;
  readonly file: string;
  private readonly debounceMs: number;
  private readonly retryMs: number;
  private readonly retryMaxMs: number;
  private readonly timers: Timers;
  private readonly log: (s: string) => void;
  private pending: string | null = null;
  private timer: unknown = null;
  private inflight: Promise<boolean> | null = null;
  private held = false;
  private backoff: number;
  /** writes that succeeded / failed (tests and the debug hook) */
  readonly stats = { ok: 0, failed: 0 };

  constructor(store: CloudStore, o: CloudSaverOptions = {}) {
    this.store = store;
    this.file = o.file ?? CLOUD_LOCKER_FILE;
    this.debounceMs = o.debounceMs ?? CLOUD_DEBOUNCE_MS;
    this.retryMs = o.retryMs ?? CLOUD_RETRY_MS;
    this.retryMaxMs = o.retryMaxMs ?? CLOUD_RETRY_MAX_MS;
    this.timers = o.timers ?? realTimers;
    this.log = o.log ?? ((s) => console.warn(s));
    this.backoff = this.retryMs;
  }

  /** Data waiting to reach the Cloud (null = the Cloud has the newest copy). */
  get dirty(): boolean {
    return this.pending !== null;
  }

  /** Hold every write (true) until the first Cloud read is done; releasing schedules what is pending. */
  hold(on: boolean): void {
    this.held = on;
    if (!on && this.pending !== null) this.arm(this.debounceMs);
  }

  schedule(data: string): void {
    if (data.length > CLOUD_MAX_BYTES) {
      this.log(`[cloud] the locker is ${data.length} bytes, over the ${CLOUD_MAX_BYTES} byte limit: kept on this computer only`);
      return;
    }
    this.pending = data;
    this.backoff = this.retryMs;
    if (!this.held) this.arm(this.debounceMs);
  }

  /** Write what is pending now (page hidden, app closing). True when the Cloud has the newest copy. */
  async flush(): Promise<boolean> {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.held) return this.pending === null;
    while (this.inflight) await this.inflight;
    if (this.pending === null) return true;
    return this.write();
  }

  dispose(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(ms: number): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.write();
    }, ms);
  }

  private async write(): Promise<boolean> {
    // one write at a time: the next one starts when the one in flight is done
    while (this.inflight) await this.inflight;
    const data = this.pending;
    if (data === null || this.held) return data === null;
    const run = (async () => {
      let ok = false;
      try {
        ok = (await this.store.write(this.file, data)) === true;
      } catch {
        ok = false;
      }
      if (ok) {
        this.stats.ok++;
        if (this.pending === data) this.pending = null; // a newer change waits for its own write
        else if (this.pending !== null && !this.held) this.arm(this.debounceMs);
        this.backoff = this.retryMs;
      } else {
        this.stats.failed++;
        // keep the data (localStorage has it too) and try again later
        if (!this.held) this.arm(this.backoff);
        this.backoff = Math.min(this.retryMaxMs, this.backoff * 2);
      }
      return ok;
    })();
    this.inflight = run;
    try {
      return await run;
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }
}
