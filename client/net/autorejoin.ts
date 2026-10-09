// Automatic rejoin after a dropped online match: the retry schedule, and how it stops for good when
// the player starts something else (a solo match), so a late reconnect never replaces what they play.
import { RejoinStore } from './rejoin.ts';

/** Delay before each retry: 0.5 s, 1.5 s, 3 s, then every 5 s until the grace window is over. */
export const REJOIN_RETRY_MS: readonly number[] = [500, 1500, 3000, 5000];

/** setTimeout / clearTimeout, injectable so tests can run the schedule by hand. */
export interface RetryTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: RetryTimers = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (handle) => globalThis.clearTimeout(handle as number),
};

export class AutoRejoin {
  private handle: unknown = null;
  private tries = 0;
  private readonly store: RejoinStore;
  private readonly timers: RetryTimers;

  constructor(store: RejoinStore = new RejoinStore(), timers: RetryTimers = realTimers) {
    this.store = store;
    this.timers = timers;
  }

  /** A retry is waiting to run. */
  get pending(): boolean {
    return this.handle !== null;
  }

  /**
   * Schedule the next retry with backoff. When the timer fires, `retry` runs only if `allowed()` still
   * says yes (no connection open, no match running). Returns the delay in ms.
   */
  schedule(retry: () => void, allowed: () => boolean): number {
    this.clearTimer();
    const delay = REJOIN_RETRY_MS[Math.min(this.tries++, REJOIN_RETRY_MS.length - 1)];
    this.handle = this.timers.set(() => {
      this.handle = null;
      if (allowed()) retry();
    }, delay);
    return delay;
  }

  /** A match started: the next drop starts the backoff from the beginning. */
  reset(): void {
    this.tries = 0;
  }

  /** Drop the pending retry (the player disconnected on purpose). The next manual connect still rejoins. */
  stop(): void {
    this.clearTimer();
    this.tries = 0;
  }

  /**
   * The player started something else: drop the pending retry and mark every dropped match as left,
   * so no connection (not even a handshake already in flight) auto-rejoins it at 'welcome'. The tokens
   * stay, so joining the room by its code inside the grace window still takes the unit back.
   */
  cancel(): void {
    this.stop();
    this.store.cancelAuto();
  }

  private clearTimer(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }
}
