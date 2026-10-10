// Client glue: auto-rejoin cancelling (finding 27), the solo render clock after a long frame (28),
// the predicted hook matching the server's and its hand-over (29) and the default server address
// (desktop readiness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAL, DEFAULT_CONFIG, HOOK_LEVELS, TICK_DT, TICK_RATE } from '../shared/constants.ts';
import { GameSim } from '../shared/sim/sim.ts';
import { Btn, type HookSnap, type MatchConfig, type PlayerInfo, type PlayerInput, type Snapshot, type Team, type YouSnap } from '../shared/types.ts';
import type { Profile, ServerMsg } from '../shared/protocol.ts';
import { AutoRejoin, REJOIN_RETRY_MS, type RetryTimers } from '../client/net/autorejoin.ts';
import { Connection, defaultServerUrl, normaliseServerUrl, setDefaultServerUrl, type PageOrigin } from '../client/net/connection.ts';
import { SnapshotBuffer, clockStepMs } from '../client/net/interp.ts';
import { RejoinStore, type KeyValueStore } from '../client/net/rejoin.ts';
import { LocalSession } from '../client/net/session.ts';
import { GHOST_STALL_CAP, HANDOVER_GRACE, OwnHookPredictor, flightReach, ghostHead, ghostHookParams } from '../client/game/ghost.ts';

// ---------------------------------------------------------------------------------------------
// helpers

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

/** Timers run by hand: fire() runs every due callback. */
function manualTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: RetryTimers = {
    set(fn, ms) {
      const id = next++;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear(h) {
      due.delete(h as number);
    },
  };
  return {
    timers,
    delays: () => [...due.values()].map((d) => d.at - now),
    pendingCount: () => due.size,
    advance(ms: number) {
      now += ms;
      for (const [id, d] of [...due]) {
        if (d.at <= now) {
          due.delete(id);
          d.fn();
        }
      }
    },
  };
}

/** Stand-in for the browser WebSocket: records what the client sends, lets the test play the server. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static last: FakeSocket | null = null;
  readonly url: string;
  readyState = 0;
  readonly sent: { t: string; [k: string]: unknown }[] = [];
  private readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { t: string });
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  private fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  serverOpens(): void {
    this.readyState = FakeSocket.OPEN;
    this.fire('open', {});
  }
  serverSends(m: ServerMsg): void {
    this.fire('message', { data: JSON.stringify(m) });
  }
  socketCloses(code = 1006): void {
    this.readyState = FakeSocket.CLOSED;
    this.fire('close', { code, reason: '' });
  }
}

function withFakeSocket<T>(fn: () => T): T {
  const g = globalThis as { WebSocket?: unknown };
  const real = g.WebSocket;
  g.WebSocket = FakeSocket;
  try {
    return fn();
  } finally {
    g.WebSocket = real;
  }
}

const PROFILE: Profile = { name: 'Tester', family: 'brawler', loadout: {} };
const URL_A = 'ws://127.0.0.1:8144/ws';
const WELCOME: ServerMsg = { t: 'welcome', id: 7, v: 1, serverName: 'test', motd: '' } as ServerMsg;

/** A match on URL_A that dropped mid-play: what the store holds right after the socket closed. */
function droppedStore(): RejoinStore {
  const store = new RejoinStore(memoryStore());
  store.put(URL_A, 'ABCDE', 'tok-1234567890');
  store.markDropped(URL_A, 'ABCDE');
  return store;
}

// ---------------------------------------------------------------------------------------------
// Finding 27: a background auto-rejoin must never end a solo match started while it waits

test('auto-rejoin: retries back off 0.5 s, 1.5 s, 3 s, then every 5 s, and a match start resets it', () => {
  const t = manualTimers();
  const ar = new AutoRejoin(new RejoinStore(memoryStore()), t.timers);
  const got = [0, 1, 2, 3, 4].map(() => ar.schedule(() => {}, () => true));
  assert.deepEqual(got, [500, 1500, 3000, 5000, 5000]);
  assert.equal(t.pendingCount(), 1, 'scheduling again replaces the pending retry');
  ar.reset();
  assert.equal(ar.schedule(() => {}, () => true), REJOIN_RETRY_MS[0]);
});

test('auto-rejoin: a retry does not run while a match (a solo one) is running', () => {
  const t = manualTimers();
  const ar = new AutoRejoin(new RejoinStore(memoryStore()), t.timers);
  let ran = 0;
  let gameRunning = false;
  ar.schedule(() => ran++, () => !gameRunning);
  gameRunning = true; // the player started a solo match while waiting
  t.advance(10_000);
  assert.equal(ran, 0, 'the retry ran and would have replaced the solo match');
  gameRunning = false;
  ar.schedule(() => ran++, () => !gameRunning);
  t.advance(10_000);
  assert.equal(ran, 1, 'with nothing running the retry goes ahead');
});

test('auto-rejoin: starting solo cancels the pending retry for good but keeps the token for a manual rejoin', () => {
  const t = manualTimers();
  const store = droppedStore();
  const ar = new AutoRejoin(store, t.timers);
  let ran = 0;
  ar.schedule(() => ran++, () => true);
  assert.ok(store.dropped(URL_A), 'setup: the match should be auto-rejoinable');

  ar.cancel(); // App.startSolo
  t.advance(120_000);
  assert.equal(ran, 0, 'the pending retry still ran after the player started a solo match');
  assert.equal(ar.pending, false);
  assert.equal(store.dropped(URL_A), null, 'the dropped match is still marked for auto-rejoin');
  assert.equal(store.get(URL_A, 'ABCDE')?.token, 'tok-1234567890', 'the token must survive for a manual rejoin by code');
});

test('auto-rejoin: a retry handshake already in flight does not auto-join once the player started solo', () => {
  const open: Connection[] = [];
  try {
    withFakeSocket(() => {
      // control: without the cancel, the retry connection takes the dropped match back at 'welcome'
      const s1 = droppedStore();
      const c1 = new Connection(URL_A, PROFILE, null, { rejoinStore: s1 });
      open.push(c1);
      const ws1 = FakeSocket.last!;
      ws1.serverOpens();
      ws1.serverSends(WELCOME);
      assert.ok(ws1.sent.some((m) => m.t === 'joinRoom' && m.code === 'ABCDE' && m.rejoin === 'tok-1234567890'), 'control: auto-rejoin at welcome');

      // the retry socket is open and waiting for 'welcome' when the player starts a solo match
      const s2 = droppedStore();
      const c2 = new Connection(URL_A, PROFILE, null, { rejoinStore: s2 });
      open.push(c2);
      const ws2 = FakeSocket.last!;
      ws2.serverOpens();
      new AutoRejoin(s2, manualTimers().timers).cancel(); // App.startSolo -> leaveOnlineForSolo
      ws2.serverSends(WELCOME);
      assert.equal(ws2.sent.filter((m) => m.t === 'joinRoom').length, 0, 'the in-flight retry auto-joined the online match over the solo one');
      assert.equal(c2.autoRejoining, null);

      // joining the room by its code later still brings the token
      c2.send({ t: 'joinRoom', code: 'ABCDE' });
      assert.ok(ws2.sent.some((m) => m.t === 'joinRoom' && m.rejoin === 'tok-1234567890'), 'manual rejoin by code lost its token');
    });
  } finally {
    for (const c of open) c.close(); // stops their ping timers
  }
});

test('auto-rejoin: a retry closed for a solo match stays closed, even if its rejoin start still arrives', () => {
  // App.leaveOnlineForSolo closes a retry whose auto-rejoin is in flight. A 'start' the server already
  // sent must not re-arm the match as ours: the socket's close would then count as a fresh drop and the
  // next connection to this server would auto-rejoin it over whatever the player is doing.
  const open: Connection[] = [];
  try {
    withFakeSocket(() => {
      const store = droppedStore();
      const c = new Connection(URL_A, PROFILE, null, { rejoinStore: store });
      open.push(c);
      const got: string[] = [];
      c.onMessage = (m) => got.push(m.t);
      const ws = FakeSocket.last!;
      ws.serverOpens();
      ws.serverSends(WELCOME);
      assert.equal(c.autoRejoining, 'ABCDE', 'setup: the retry is rejoining');
      new AutoRejoin(store, manualTimers().timers).cancel(); // App.startSolo -> leaveOnlineForSolo
      c.close();
      ws.serverSends({ t: 'start', m: { you: 3, room: 'ABCDE', rejoin: 'tok-new' } } as unknown as ServerMsg);
      ws.socketCloses(1000);
      assert.equal(store.dropped(URL_A), null, 'the late start re-armed auto-rejoin for the next connection');
      assert.deepEqual(got.filter((t) => t === 'start'), [], 'a message after close() reached the app');
      assert.equal(store.get(URL_A, 'ABCDE')?.token, 'tok-1234567890', 'the token for a manual rejoin by code is kept');
    });
  } finally {
    for (const c of open) c.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Finding 28: solo, after one long frame, others must not be drawn up to 12 ticks late

interface ClockRun {
  /** latest snapshot tick minus the render tick, per frame (after warm-up) */
  lags: number[];
  maxDelay: number;
  /** frames that drew exactly the newest snapshot (nothing left to interpolate towards) */
  capped: number;
  /** frames whose render tick did not move forward */
  stalled: number;
  /** lag on the frames right after the first frame longer than 100 ms */
  afterHitch: number[];
}

/** Drive a real LocalSession and SnapshotBuffer exactly like GameClient.frame() does in solo. */
function runSoloClock(frameTimes: number[], opts: { warmup?: number; pauses?: { at: number; until: number }[] } = {}): ClockRun {
  const cfg: MatchConfig = { ...DEFAULT_CONFIG, teamSize: 1, botFill: true, hazards: 'none' };
  const session = new LocalSession(cfg, PROFILE, 0);
  const buffer = new SnapshotBuffer(true);
  let clockNow = 0;
  session.onSnapshot = (s: Snapshot) => buffer.push(s, clockNow); // local snapshots use the frame clock
  const warm = opts.warmup ?? 60;
  const run: ClockRun = { lags: [], maxDelay: 0, capped: 0, stalled: 0, afterHitch: [] };
  let last = -1;
  let prevRender = -Infinity;
  let hitchAt = -1;
  for (let i = 0; i < frameTimes.length; i++) {
    const now = frameTimes[i];
    clockNow = now;
    if (last < 0) last = now;
    const rawMs = now - last;
    last = now;
    const paused = (opts.pauses ?? []).some((p) => now >= p.at && now < p.until);
    session.setPaused(paused);
    session.pump(now);
    const renderTick = buffer.frameTick(now, rawMs, paused);
    if (renderTick < 0 || !buffer.latest) continue;
    run.maxDelay = Math.max(run.maxDelay, buffer.delay);
    if (hitchAt < 0 && rawMs > 100) hitchAt = i;
    const lag = buffer.latest.t - renderTick;
    if (i >= warm && !paused) {
      run.lags.push(lag);
      if (renderTick >= buffer.latest.t) run.capped++;
      if (renderTick <= prevRender) run.stalled++;
    }
    if (hitchAt >= 0 && i > hitchAt && i <= hitchAt + 30) run.afterHitch.push(lag);
    prevRender = renderTick;
  }
  return run;
}

const steady = (ms: number, count: number, t0 = 1000) => Array.from({ length: count }, (_, i) => t0 + i * ms);

test('solo render clock: one 400 ms frame does not leave other units drawn up to 12 ticks in the past', () => {
  const before = steady(1000 / 60, 200);
  const frames = before.concat(steady(1000 / 60, 60, before[before.length - 1] + 400));
  const r = runSoloClock(frames);
  const worst = Math.max(...r.afterHitch);
  assert.ok(worst <= 1.5, `after the long frame others were drawn ${worst.toFixed(2)} ticks late (first frames: ${r.afterHitch.slice(0, 6).map((v) => v.toFixed(2)).join(' ')})`);
  assert.equal(r.maxDelay, 1, `solo interpolation delay grew to ${r.maxDelay.toFixed(2)} ticks (local snapshots are not network jitter)`);
});

test('solo render clock: steady and jittered frame rates interpolate on every frame, never stall', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const jittered = (mean: number, spread: number, count: number) => {
    const out: number[] = [];
    let t = 1000;
    for (let i = 0; i < count; i++) {
      out.push(t);
      t += mean + (rnd() * 2 - 1) * spread;
    }
    return out;
  };
  const cases: Record<string, number[]> = {
    '30 fps': steady(1000 / 30, 300),
    '45 fps': steady(1000 / 45, 450),
    '60 fps': steady(1000 / 60, 600),
    '144 fps': steady(1000 / 144, 1400),
    '33+-10 ms': jittered(33.3, 10, 300),
    '16.7+-8 ms': jittered(16.7, 8, 600),
  };
  for (const [name, frames] of Object.entries(cases)) {
    const r = runSoloClock(frames);
    const avg = r.lags.reduce((a, b) => a + b, 0) / r.lags.length;
    assert.equal(r.stalled, 0, `${name}: render tick stalled on ${r.stalled} frames`);
    assert.equal(r.capped, 0, `${name}: ${r.capped} frames drew the newest snapshot with nothing to interpolate towards`);
    assert.ok(avg <= 1.5, `${name}: average lag ${avg.toFixed(2)} ticks`);
  }
});

test('solo render clock: pausing and resuming the match does not leave the picture behind', () => {
  for (const pauseMs of [300, 2000]) {
    const frames = steady(1000 / 60, 400);
    const at = frames[150];
    const r = runSoloClock(frames, { pauses: [{ at, until: at + pauseMs }] });
    const tail = r.lags.slice(-60);
    assert.equal(r.stalled, 0, `pause ${pauseMs} ms: render tick stalled on ${r.stalled} frames after resuming`);
    assert.ok(Math.max(...tail) <= 1.5, `pause ${pauseMs} ms: lag ${Math.max(...tail).toFixed(2)} ticks a second after resuming`);
  }
});

// ---------------------------------------------------------------------------------------------
// The online render clock only moves forward

/**
 * Recorded snapshot timings: how late each of 300 consecutive snapshots reached the page, in ms, measured
 * in the browser against the real server (2026-10-10, loopback, `ws` message events in the page). Idle:
 * nothing else on the main thread. Busy: the page drawing frames, with two GC-sized hitches (43 and 52 ms).
 * The harness replays them on top of a one-way latency, on the way down and (offset) on the way up.
 */
const TRACE_IDLE = [
  0.4, 0.4, 0.7, 0.6, 0.5, 0.6, 0.7, 0.7, 0.6, 1, 0.9, 0.6, 0.8, 1.1, 0.9, 0.9, 0.4, 1.1, 0.9, 1.1, 0.7, 0.7, 0.6, 0.6, 0.8, 0.6, 0.6, 0.6, 0.6, 0.6,
  0.6, 0.5, 0.9, 0.9, 0.9, 0.5, 0.6, 0.7, 0.4, 0.7, 0.6, 0.8, 0.5, 0.5, 0.5, 0.8, 0.7, 0.7, 1.2, 0.7, 0.8, 0.6, 0.6, 0.4, 0.5, 0.8, 0.3, 0.7, 0.9, 0.4,
  0.7, 0.8, 0.6, 1, 1.9, 1, 0.8, 0.3, 0.6, 0.6, 0.7, 0.6, 0.8, 0.5, 0.4, 0.7, 1.1, 0.6, 0.8, 0.9, 0.7, 0.8, 0.8, 0.4, 0.5, 0.8, 0.9, 0.5, 0.5, 0.5,
  1.3, 0.9, 0.8, 0.8, 0.6, 0.4, 1.6, 0.6, 1.3, 0.8, 1.2, 1.1, 0.6, 0.8, 0.6, 0.6, 0.9, 0.6, 0.7, 0.6, 0.4, 0.4, 0.8, 0.9, 0.5, 1, 0.8, 1.1, 0.5, 0.3,
  0.4, 0.5, 0.8, 1.4, 0.7, 1.3, 0.7, 0.5, 0.4, 0.5, 0.4, 0.8, 1.1, 0.7, 0.4, 0.5, 0.6, 0.6, 0.9, 0.9, 1.1, 0.4, 0.4, 0.4, 0.5, 1, 0.6, 0.5, 0.4, 0.5,
  0.4, 0.5, 0.8, 0.7, 0.5, 0.8, 0.6, 0.6, 0.7, 0.4, 1.3, 0.7, 1.4, 0.7, 1, 0.4, 0.5, 0.5, 1, 0.7, 0.7, 0.4, 0.6, 0.7, 0.5, 0.7, 0.1, 1, 0.9, 0.5,
  0.6, 0.5, 0.7, 0.7, 0.9, 0.5, 0.6, 0.7, 0.5, 0.8, 0.7, 0.6, 0.5, 1, 0.6, 0.8, 0.8, 0.7, 1.4, 0.9, 0.6, 0.6, 0.3, 1, 0.5, 0.7, 0.9, 0.6, 0.5, 0.8,
  0.8, 0.5, 0.5, 0.6, 0.9, 0.5, 0.6, 1, 0.6, 0.7, 0.8, 1.2, 0.8, 0.6, 0.5, 0.7, 0.9, 0.8, 1, 1, 0.7, 0.6, 0.8, 1, 0.8, 0.6, 0.7, 0.7, 0.6, 0.7,
  0.7, 0.6, 0.9, 0.7, 0.8, 0.5, 0.3, 0.4, 0.9, 0.5, 0.6, 0.6, 0.6, 0.4, 0.2, 0.4, 0.6, 0.8, 0.8, 1.3, 0.6, 0.7, 0.7, 0.4, 0.8, 0.5, 0.9, 0.5, 0.3, 0.6,
  0.8, 1.1, 0.5, 0.6, 0.5, 0.7, 0.5, 1.1, 0.6, 0.5, 0.5, 0.7, 1.2, 0.5, 1.2, 1, 0.6, 0.9, 1.2, 0.7, 1, 0.6, 1.4, 0.8, 1.3, 0.5, 0.7, 0.6, 1, 1.3,
];
const TRACE_BUSY = [
  0.5, 0.4, 0.5, 0.6, 43.5, 10.3, 3.9, 1.9, 0.5, 0.1, 0.5, 0.4, 0, 0.2, 1.1, 0.2, 0.5, 0.6, 0.3, 0.1, 1.1, 0.5, 0.1, 0.5, 0.2, 0.3, 0.8, 1, 7.1, 0.9,
  1.2, 0.6, 0.4, 1.7, 0.4, 0.3, 0.7, 0.4, 0, 0.9, 0.5, 1, 0.3, 0.1, 0, 1.2, 0.4, 0.6, 0.5, 0.2, 0, 0.6, 0.5, 4.1, 2.3, 1.7, 0.5, 0.3, 0.8, 0,
  0.2, 0.1, 0.1, 0.4, 0.4, 0.1, 0.2, 0.2, 0.5, 0.3, 0.4, 0.7, 1.1, 0.3, 0.2, 0.2, 0.3, 6.4, 1.1, 0.5, 0.3, 0.3, 1.1, 0.2, 0.2, 0.3, 0.2, 0.2, 0.2, 0.6,
  0.7, 0.4, 0.2, 0.3, 0.8, 0.5, 0.2, 0.4, 0, 0.2, 5.1, 2.6, 3.7, 1.5, 1.1, 0.6, 0.9, 0.8, 0.7, 0.2, 0.4, 0.3, 0.3, 0.2, 0.7, 0.4, 0, 1, 0.3, 0.2,
  0.2, 0.2, 0.1, 0.3, 0.1, 2, 3, 0.2, 0.3, 0.7, 0.3, 0.3, 0.4, 0.5, 0.5, 0.7, 0.5, 0.3, 2.5, 0.3, 4.1, 0.4, 0.3, 0.7, 0.3, 0.7, 0.7, 0.8, 0.4, 1.2,
  0.4, 0.5, 0.4, 0.7, 0.3, 0.3, 0.8, 0.4, 0, 0.3, 0.4, 3, 2.6, 1.6, 0.4, 0.5, 0.5, 0.2, 0.8, 0.3, 1.1, 0.8, 0.6, 1.2, 1.7, 0.6, 0.5, 0.4, 0.4, 0.4,
  1, 0.5, 0.2, 2.1, 0.6, 2.1, 0.7, 1.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.1, 0.1, 0.2, 1.3, 1.2, 2.2, 0.3, 0.5, 0.4, 0.3, 0.4, 0.2, 0.4, 0.5, 0.3, 0.4, 3,
  2.9, 1.9, 0.7, 0.4, 0.3, 0.3, 0.6, 0.7, 0.5, 0.6, 0.6, 1.1, 0.4, 0.8, 0.1, 0.4, 0.5, 0.6, 0.4, 0.2, 0.1, 0.3, 0.3, 2.6, 1, 3.4, 0.9, 0.2, 0.3, 0,
  0.5, 0.4, 1.3, 0.4, 0.3, 0.2, 1.6, 0.2, 1.4, 0.3, 0.6, 0.3, 0.5, 0.6, 0.4, 0.6, 0.3, 4.4, 2.2, 1.5, 0.2, 0.4, 0.5, 0.3, 0.7, 0.7, 0.4, 0.6, 0.4, 0.7,
  52.4, 19.3, 0.4, 0.4, 0.4, 0.4, 0.6, 0.6, 0.2, 0.3, 5.7, 5.8, 4.9, 2.7, 0.7, 0.5, 0.4, 4, 0.6, 0.7, 0, 0.5, 1.3, 0.3, 0.1, 0.6, 0.5, 0.6, 0.4, 0,
];

test('online render clock: frameTick is advance with the 100 ms clamp, the solo pause never leaks online, and the delay still covers jitter', () => {
  // drive one buffer the GameClient way (frameTick, even with a stray paused flag, which only solo
  // honours) and one directly (advance(now, clamp(raw, 0, 100)))
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const snap = (t: number) => ({ t, u: [], h: [], r: [], ev: [] }) as unknown as Snapshot;
  const tickMs = 1000 / TICK_RATE;
  const viaFrameTick = new SnapshotBuffer(false);
  const viaPausedFlag = new SnapshotBuffer(false);
  const viaAdvance = new SnapshotBuffer(false);
  const arrivals: { at: number; t: number }[] = [];
  for (let k = 0; k < 600; k++) if (rnd() > 0.05) arrivals.push({ at: 1000 + k * tickMs + 40 + 60 * rnd(), t: k });
  arrivals.sort((a, b) => a.at - b.at);
  let ai = 0;
  let last = -1;
  let maxDelay = 0;
  let frames = 0;
  for (let now = 1000; now < 1000 + 600 * tickMs; now += 1000 / 60 + (rnd() < 0.02 ? 300 : 0)) {
    for (; ai < arrivals.length && arrivals[ai].at <= now; ai++) {
      for (const b of [viaFrameTick, viaPausedFlag, viaAdvance]) b.push(snap(arrivals[ai].t), arrivals[ai].at);
    }
    if (last < 0) last = now;
    const raw = now - last;
    last = now;
    const old = viaAdvance.advance(now, Math.min(100, Math.max(0, raw)));
    assert.equal(viaFrameTick.frameTick(now, raw, false), old, `frame ${frames}: online render tick changed`);
    assert.equal(viaPausedFlag.frameTick(now, raw, true), old, `frame ${frames}: the solo pause hold leaked into online play`);
    assert.equal(viaFrameTick.delay, viaAdvance.delay);
    maxDelay = Math.max(maxDelay, viaFrameTick.delay);
    frames++;
  }
  assert.ok(maxDelay > 2.5, `online interpolation delay no longer grows with network jitter (max ${maxDelay.toFixed(2)})`);
});

interface OnlineClockRun {
  /** frames whose render tick went back, and the worst step (ticks) */
  back: number;
  worst: number;
  /** frames where the interpolated walking unit went back, and the worst step (m) */
  unitBack: number;
  /** render ticks per tick of real time, per frame (after warm-up, outside a stall and its catch-up second) */
  rates: number[];
  /** newest snapshot tick minus the render tick, per frame (after warm-up) */
  lags: number[];
  maxDelay: number;
  /** lag per frame in the second after a stall ended */
  afterStall: number[];
}

/**
 * The online SnapshotBuffer the way GameClient drives it (frameTick at a fixed frame rate), snapshots
 * arriving in order with jitter (a seeded random one, or a recorded trace), one unit walking +x at
 * 6 m/s in them, and optionally a stall on the line (everything inside it arrives at its end).
 */
function runOnlineClock(o: { jitter: number; fps: number; seed: number; trace?: readonly number[]; stall?: { at: number; ms: number }; ticks?: number }): OnlineClockRun {
  let seed = o.seed;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const tickMs = 1000 / TICK_RATE;
  const buf = new SnapshotBuffer(false);
  const snap = (t: number) => ({ t, u: [{ i: 7, x: t * 0.2, z: 0, y: 0, f: 0, hp: 100 }], h: [], r: [], ev: [] }) as unknown as Snapshot;
  const n = o.ticks ?? 1200;
  const arrivals: { at: number; t: number }[] = [];
  let lastAt = 0;
  for (let k = 0; k < n; k++) {
    let at = 1000 + k * tickMs + 40 + (o.trace ? o.trace[k % o.trace.length] : rnd() * o.jitter);
    if (o.stall && at >= o.stall.at && at < o.stall.at + o.stall.ms) at = o.stall.at + o.stall.ms;
    lastAt = Math.max(lastAt, at);
    arrivals.push({ at: lastAt, t: k });
  }
  const run: OnlineClockRun = { back: 0, worst: 0, unitBack: 0, rates: [], lags: [], maxDelay: 0, afterStall: [] };
  let ai = 0;
  let last = -1;
  let prevTick = Number.NaN;
  let prevX = Number.NaN;
  let newest = -1;
  const stallEnd = o.stall ? o.stall.at + o.stall.ms : Infinity;
  for (let now = 1000; now < 1000 + n * tickMs; now += 1000 / o.fps) {
    for (; ai < arrivals.length && arrivals[ai].at <= now; ai++) {
      buf.push(snap(arrivals[ai].t), arrivals[ai].at);
      newest = arrivals[ai].t;
    }
    if (last < 0) last = now;
    const raw = now - last;
    last = now;
    const tick = buf.frameTick(now, raw, false);
    const f = buf.sample(tick);
    if (!f || now < 2000) {
      prevTick = tick;
      prevX = f?.units.get(7)?.x ?? Number.NaN;
      continue;
    }
    const x = f.units.get(7)!.x;
    if (tick < prevTick - 1e-9) {
      run.back++;
      run.worst = Math.min(run.worst, tick - prevTick);
    }
    if (x < prevX - 1e-9) run.unitBack++;
    const inStall = o.stall && now >= o.stall.at - 200 && now < stallEnd + 1000;
    if (!inStall && raw > 0) run.rates.push((tick - prevTick) / (raw / tickMs));
    run.lags.push(newest - tick);
    if (o.stall && now >= stallEnd && now < stallEnd + 1000) run.afterStall.push(newest - tick);
    run.maxDelay = Math.max(run.maxDelay, buf.delay);
    prevTick = tick;
    prevX = x;
  }
  return run;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

test('online render clock never steps back (0 to 80 ms jitter, 60 to 240 fps, recorded timings), so no interpolated unit does', () => {
  // the old clock followed its server-clock estimate directly: under jitter at high frame rates it went
  // back (2398 -> 2395 seen in play; one frame at -6 m/s at 60 ms jitter and 144 fps)
  const RATE_MIN = 0.5; // client/net/interp.ts RENDER_RATE_MIN / MAX
  const RATE_MAX = 2;
  for (const jitter of [0, 10, 20, 40, 60, 80]) {
    for (const fps of [60, 90, 144, 240]) {
      for (const seed of [3, 17, 4242]) {
        const label = `${jitter} ms jitter at ${fps} fps (seed ${seed})`;
        const r = runOnlineClock({ jitter, fps, seed });
        assert.equal(r.back, 0, `${label}: the render tick went back on ${r.back} frames (worst ${r.worst.toFixed(3)} ticks)`);
        assert.equal(r.unitBack, 0, `${label}: an interpolated unit walking forward went back on ${r.unitBack} frames`);
        const lo = Math.min(...r.rates);
        const hi = Math.max(...r.rates);
        assert.ok(lo >= RATE_MIN - 1e-9 && hi <= RATE_MAX + 1e-9, `${label}: the picture ran at ${lo.toFixed(2)}..${hi.toFixed(2)} x real time`);
        // still about the interpolation delay behind the newest snapshot: delay changes are absorbed, not dropped
        assert.ok(mean(r.lags) <= r.maxDelay + 1, `${label}: the picture fell ${mean(r.lags).toFixed(2)} ticks behind (delay up to ${r.maxDelay.toFixed(2)})`);
        if (jitter >= 40) assert.ok(r.maxDelay > 2.5, `${label}: the delay no longer grows with jitter`);
      }
    }
  }
  for (const [name, trace] of [['idle page', TRACE_IDLE], ['busy page', TRACE_BUSY]] as const) {
    for (const fps of [60, 144, 240]) {
      const r = runOnlineClock({ jitter: 0, fps, seed: 1, trace });
      assert.equal(r.back, 0, `recorded ${name} at ${fps} fps: the render tick went back on ${r.back} frames`);
      assert.equal(r.unitBack, 0, `recorded ${name} at ${fps} fps: a unit went back`);
    }
  }
});

test('online render clock: after the line stalls the picture catches up without stepping back', () => {
  for (const ms of [150, 300, 500, 1000]) {
    for (const fps of [60, 144]) {
      const label = `${ms} ms stall at ${fps} fps`;
      const r = runOnlineClock({ jitter: 10, fps, seed: 9, stall: { at: 12_000, ms } });
      assert.equal(r.back, 0, `${label}: the render tick went back on ${r.back} frames`);
      assert.equal(r.unitBack, 0, `${label}: a unit went back`);
      const before = mean(r.lags.slice(0, 300));
      const settled = r.afterStall.slice(-10);
      assert.ok(Math.max(...settled) <= before + 1.5, `${label}: a second after the stall the picture was still ${Math.max(...settled).toFixed(2)} ticks behind (normally ${before.toFixed(2)})`);
    }
  }
});

test('render clock step: online keeps the 100 ms clamp, solo follows the 0.5 s catch-up', () => {
  assert.equal(clockStepMs(false, 400), 100);
  assert.equal(clockStepMs(true, 400), 400);
  assert.equal(clockStepMs(true, 3000), 500);
  assert.equal(clockStepMs(true, -5), 0);
  assert.equal(clockStepMs(false, 16.7), 16.7);
});

// ---------------------------------------------------------------------------------------------
// Finding 29: the predicted hook flies like the server's hook, Long Line included

function players(teams: Team[]): PlayerInfo[] {
  return teams.map((team, i) => ({ id: i + 1, name: `P${i + 1}`, team, family: 'brawler', loadout: {}, isBot: false }));
}

function throwAndCompare(setup: (sim: GameSim) => void, label: string) {
  const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: false }, players([0, 1]), 11);
  for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
  const a = sim.unitById.get(1)!;
  a.spawnProt = 0;
  a.x = -20;
  a.z = 0;
  setup(sim);
  // what the client knows at the moment of the key press
  const you = sim.snapshotFor(1).you!;
  const ghost = ghostHookParams(you);
  let seq = 1;
  sim.queueInput(1, { seq: seq++, mx: 0, mz: 0, ax: -20, az: -30, b: Btn.Hook });
  for (let i = 0; i < 8 && a.activeHook < 0; i++) {
    sim.step();
    sim.queueInput(1, { seq: seq++, mx: 0, mz: 0, ax: -20, az: -30, b: 0 });
  }
  const h = sim.hookById(a.activeHook);
  assert.ok(h, `${label}: the hook did not launch`);
  const snapHook = sim.snapshotFor(1).h.find((x) => x.i === h.id);
  assert.ok(Math.abs(ghost.speed - h.speed) < 1e-9, `${label}: ghost flies ${ghost.speed} m/s, the server hook ${h.speed} m/s`);
  assert.ok(Math.abs(ghost.range - h.range) < 1e-9, `${label}: ghost range ${ghost.range} m, the server hook ${h.range} m`);
  assert.ok(Math.abs(ghost.radius - h.r) < 1e-9, `${label}: ghost radius ${ghost.radius}, the server hook ${h.r}`);
  if (snapHook) assert.equal(ghost.fx, snapHook.fx, `${label}: ghost skin bits ${ghost.fx}, the server hook ${snapHook.fx}`);
  return { ghost, h };
}

test('predicted hook: same speed, range, width and look as the hook the server launches', () => {
  throwAndCompare(() => {}, 'no rune');
  const long = throwAndCompare((sim) => sim.grantRune(sim.unitById.get(1)!, 'longshot'), 'Long Line');
  assert.equal(long.ghost.speed, HOOK_LEVELS.speed[0] * BAL.longshotSpeedMul, 'Long Line speed');
  assert.equal(long.ghost.range, HOOK_LEVELS.range[0] * BAL.longshotRangeMul, 'Long Line range is applied once, not twice');
  throwAndCompare((sim) => {
    const u = sim.unitById.get(1)!;
    u.up.speed = 2;
    u.up.range = 1;
    u.up.width = 1;
    sim.grantRune(u, 'longshot');
  }, 'upgraded + Long Line');
  throwAndCompare((sim) => {
    const u = sim.unitById.get(1)!;
    sim.grantRune(u, 'bouncy');
    sim.grantRune(u, 'bendy');
  }, 'Boing Barb + Bendy Eel');
});

test('predicted hook: the ghost stops where the server hook turns, at every speed and range level, with and without Long Line', () => {
  // the hand-over waits at the tip for the server head: a tip that is off by a step (0.35 m) hitches
  // there for upgraded players. Walls are switched off so every range fits on the map.
  const misses: string[] = [];
  for (const longLine of [false, true]) {
    for (let sp = 0; sp < HOOK_LEVELS.speed.length; sp++) {
      for (let rg = 0; rg < HOOK_LEVELS.range.length; rg++) {
        const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: false }, players([0, 1]), 11);
        for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
        (sim.world as { sweep: (...a: unknown[]) => null }).sweep = () => null;
        const a = sim.unitById.get(1)!;
        const b = sim.unitById.get(2)!;
        a.spawnProt = 0;
        a.x = -20;
        a.z = 0;
        a.up.speed = sp;
        a.up.range = rg;
        if (longLine) sim.grantRune(a, 'longshot');
        b.x = 30; // nowhere near the throw
        b.z = 30;
        const g = ghostHookParams(sim.snapshotFor(1).you!);
        let seq = 1;
        sim.queueInput(1, { seq: seq++, mx: 0, mz: 0, ax: -20, az: -60, b: Btn.Hook });
        let turned = Number.NaN;
        for (let i = 0; i < 90 && Number.isNaN(turned); i++) {
          sim.step();
          sim.queueInput(1, { seq: seq++, mx: 0, mz: 0, ax: -20, az: -60, b: 0 });
          const h = a.activeHook >= 0 ? sim.hookById(a.activeHook) : undefined;
          if (h && h.phase !== 0) turned = h.traveled;
        }
        const label = `speed ${sp}, range ${rg}${longLine ? ', Long Line' : ''}`;
        assert.ok(!Number.isNaN(turned), `${label}: the hook never turned`);
        assert.equal(g.reach, flightReach(g.speed, g.range), `${label}: ghostHookParams.reach`);
        if (Math.abs(g.reach - turned) > 1e-6) misses.push(`${label}: ghost ${g.reach.toFixed(3)} m, server ${turned.toFixed(3)} m`);
      }
    }
  }
  assert.deepEqual(misses, [], 'the ghost tip is off the server turn point');
});

/** Our hook flies out on a straight line (no catch, no bend, no Bendy Eel steering): what the ghost predicts. */
const straight = (h: HookSnap) => h.p === 0 && h.tg < 0 && h.ru < 0 && h.pts.length === 0 && !(h.fx & 4);

interface OwnThrow {
  v: number;
  /** the drawn head's distance along the throw (m), one entry per frame from the ghost's first frame */
  s: number[];
  /** each frame's step (s) */
  dt: number[];
  /** first frame our server hook was in the picture: the old hand-over (-1 = never) */
  seenIdx: number;
  /** frame the server's hook took the drawing over from the ghost (-1 = never) */
  takeIdx: number;
  /** first frame the picture showed our hook turned (-1 = never) */
  turnIdx: number;
  /** on the server: where the hook stopped flying out, m along the throw (NaN = not seen) */
  turnS: number;
  /** on the server: it stopped because it caught a unit */
  caught: boolean;
  /** frames with no head drawn before the hook came in */
  gaps: number;
  /** from the take on: drawn head to server head (m), per frame, while the hook is in the picture */
  offs: number[];
  /** frame the blend ended, the head the server's own again (-1 = not before the hook came in) */
  blendEndIdx: number;
}

/**
 * Our own hook online, the way GameClient draws it: a real GameSim stepping at 30 Hz, inputs and
 * snapshots each delayed by a one-way latency plus jitter (in order, like a WebSocket; a recorded trace
 * or a seeded random one), the online SnapshotBuffer driven by frameTick at the frame rate, and the
 * OwnHookPredictor GameClient uses (frame() then head() per frame, drawing the ghost with ghostHead).
 */
function runOwnHook(
  net: { up: number; down: number; jitter: number; trace?: readonly number[] },
  o: { fps?: number; throws?: number; targetAt?: number; longLine?: boolean; stall?: { after: number; ms: number }; freeze?: { after: number; ms: number } } = {},
): OwnThrow[] {
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let downK = 0;
  let upK = 150; // the way up replays another stretch of the trace
  const jitter = (k: number) => (net.trace ? net.trace[k % net.trace.length] : rnd() * net.jitter);
  const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: false }, players([0, 1]), 11);
  for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
  const a = sim.unitById.get(1)!;
  const b = sim.unitById.get(2)!;
  // Long Line reaches 24 m: a lane with nothing in the way for that long, inside the map
  const x0 = o.longLine ? -22 : -20;
  const z0 = o.longLine ? 3 : 0;
  const stage = () => {
    a.spawnProt = 0;
    a.x = x0;
    a.z = z0;
    if (o.longLine) sim.grantRune(a, 'longshot');
    b.spawnProt = 0;
    b.hp = b.maxHp;
    b.x = o.targetAt ? x0 : x0 - 10; // in the path, or well out of it
    b.z = o.targetAt ? z0 - o.targetAt : z0;
  };
  stage();
  const aim = { x: x0, z: -30 };
  const tickMs = TICK_DT * 1000;
  const frameMs = 1000 / (o.fps ?? 60);
  const buffer = new SnapshotBuffer(false);
  const own = new OwnHookPredictor();
  const down: { at: number; s: Snapshot }[] = [];
  const up: { at: number; i: PlayerInput }[] = [];
  let lastDown = 0;
  let lastUp = 0;
  let serverAt = 1003.3;
  let seq = 0;
  let pressed = false;
  let time = 0;
  let last = -1;
  let tickAcc = 0;
  let you: YouSnap | null = null;
  let body = { x: a.x, z: a.z };
  let playing = false;
  const presses = Array.from({ length: o.throws ?? 4 }, (_, i) => 3000 + i * 5137 + rnd() * 40);
  type Rec = OwnThrow & { on: boolean; done: boolean; ox: number; oz: number; dx: number; dz: number; tx: number; tz: number };
  const throws: Rec[] = [];
  let pi = 0;
  let cur = null as Rec | null; // set by press(), which TypeScript cannot follow
  const tmp = { x: 0, z: 0 };
  const press = () => {
    own.press(you!, time, aim, net.up + net.down, buffer.delay, buffer.latest?.t ?? -1);
    pressed = true;
    cur = { v: ghostHookParams(you!).speed, s: [], dt: [], seenIdx: -1, takeIdx: -1, turnIdx: -1, turnS: Number.NaN, caught: false, gaps: 0, offs: [], blendEndIdx: -1, on: false, done: false, ox: 0, oz: 0, dx: 0, dz: 0, tx: Number.NaN, tz: Number.NaN };
    throws.push(cur);
    pi++;
  };
  for (let now = 1000; now < presses[presses.length - 1] + 3000; now += frameMs) {
    while (serverAt <= now) {
      while (up.length && up[0].at <= serverAt) sim.queueInput(1, up.shift()!.i);
      if (pi < presses.length && Math.abs(serverAt - (presses[pi] - 1000)) < tickMs / 2) stage();
      sim.step();
      // on the server: where our hook stops flying out
      const sh = a.activeHook >= 0 ? sim.hookById(a.activeHook) : undefined;
      if (cur && sh && Number.isNaN(cur.tx) && (sh.phase !== 0 || sh.tg >= 0 || sh.ru >= 0 || sh.pts.length > 0)) {
        cur.tx = sh.x;
        cur.tz = sh.z;
        cur.caught = sh.tg >= 0;
      }
      let at = Math.max(lastDown, serverAt + net.down + jitter(downK++));
      // a stalled line (a Wi-Fi hiccup): what would arrive inside the window arrives at its end, all at once
      const st = o.stall;
      if (st) for (const pr of presses) if (at >= pr + st.after && at < pr + st.after + st.ms) at = pr + st.after + st.ms;
      lastDown = at;
      down.push({ at, s: sim.snapshotFor(1) });
      serverAt += tickMs;
    }
    // a frozen page (a long GC pause, a slow machine) runs no frames and reads no messages; afterwards
    // it reads everything that came in meanwhile at once
    const fz = o.freeze;
    let resumeAt = -1;
    if (fz) {
      // the key press itself lands just before the freeze
      if (pi < presses.length && presses[pi] <= now && you && playing) press();
      if (presses.some((pr) => now >= pr + fz.after && now < pr + fz.after + fz.ms)) continue;
      for (const pr of presses) if (now >= pr + fz.after + fz.ms) resumeAt = pr + fz.after + fz.ms;
    }
    while (down.length && down[0].at <= now) {
      const d = down.shift()!;
      buffer.push(d.s, Math.max(d.at, resumeAt));
      if (d.s.you) you = d.s.you;
      const me = d.s.u.find((u) => u.i === 1);
      if (me) body = { x: me.x, z: me.z };
    }
    // the key goes down between frames: GameClient.localPress -> startGhost, with the time of the last frame
    if (pi < presses.length && presses[pi] <= now && you && playing) press();
    // GameClient.frame, online
    if (last < 0) last = now;
    const rawMs = now - last;
    last = now;
    const dt = Math.min(100, Math.max(0, rawMs)) / 1000;
    time += dt;
    tickAcc += Math.min(500, Math.max(0, rawMs)) / 1000;
    while (tickAcc >= TICK_DT) {
      tickAcc -= TICK_DT;
      lastUp = Math.max(lastUp, now + net.up + jitter(upK++));
      up.push({ at: lastUp, i: { seq: ++seq, mx: 0, mz: 0, ax: aim.x, az: aim.z, b: pressed ? Btn.Hook : 0 } });
      if (pressed) own.sent(buffer.latest?.t ?? -1, net.up + net.down); // GameClient.localTick
      pressed = false;
    }
    const f = buffer.sample(buffer.frameTick(now, rawMs, false));
    if (!f) continue;
    playing = f.newer.ph === 'playing';
    // updateGhost, then updateHooks
    const step = own.frame(f, 1, time, body, false);
    let drawn: { x: number; z: number } | null = step.act === 'fly' && own.ghost ? ghostHead(own.ghost, time, { x: 0, z: 0 }) : null;
    let mine: HookSnap | null = null;
    let inPicture: HookSnap | null = null;
    for (const h of f.hooks) {
      if (h.o === 1 && h.k === 0) inPicture = h;
      const at = own.head(h, 1, dt, tmp);
      if (at && h.o === 1 && h.k === 0) {
        drawn = { x: at.x, z: at.z };
        mine = h;
      }
    }
    const c: Rec | null = cur;
    if (!c || c.done) continue;
    if (!c.on) {
      if (!drawn) continue;
      c.on = true;
      const l = Math.hypot(aim.x - body.x, aim.z - body.z);
      c.dx = (aim.x - body.x) / l;
      c.dz = (aim.z - body.z) / l;
      c.ox = body.x;
      c.oz = body.z;
    }
    const i = c.s.length;
    if (inPicture && c.seenIdx < 0) c.seenIdx = i;
    if (inPicture && !straight(inPicture) && c.turnIdx < 0) c.turnIdx = i;
    if (step.act === 'take') c.takeIdx = i;
    if (!drawn) {
      // the hook came in (or the ghost was dropped with nothing to take over: a gap)
      if (c.takeIdx >= 0 || (c.seenIdx >= 0 && !inPicture)) c.done = true;
      else c.gaps++;
      continue;
    }
    c.s.push((drawn.x - c.ox) * c.dx + (drawn.z - c.oz) * c.dz);
    c.dt.push(dt);
    if (mine && c.takeIdx >= 0) {
      c.offs.push(Math.hypot(drawn.x - mine.x, drawn.z - mine.z));
      if (c.blendEndIdx < 0 && !own.blend) c.blendEndIdx = i;
    }
  }
  for (const t of throws) if (!Number.isNaN(t.tx)) t.turnS = (t.tx - t.ox) * t.dx + (t.tz - t.oz) * t.dz;
  return throws;
}

/**
 * Per throw, over the flight out (from the ghost's first frame to the furthest point the head is drawn
 * at, whoever draws it): the worst step back, the slowest and fastest frame from the hand-over (our
 * server hook in the picture) until the turn point, how far past the server's turn point the head went,
 * how long it waited there, and the take-over and blend times.
 */
function throwStats(t: OwnThrow) {
  let peakIdx = 0;
  for (let i = 1; i < t.s.length; i++) if (t.s[i] > t.s[peakIdx] + 1e-9) peakIdx = i;
  let minSpeed = Infinity;
  let maxSpeed = 0;
  let worstBack = 0;
  for (let i = 1; i <= peakIdx; i++) {
    const d = t.s[i] - t.s[i - 1];
    worstBack = Math.min(worstBack, d);
    // flying: after the hand-over and not yet at the turn point (the frame that lands on it is a part step)
    if (t.seenIdx >= 0 && i > t.seenIdx && t.s[i] < t.turnS - 1e-3 && t.dt[i] > 0) {
      minSpeed = Math.min(minSpeed, d / t.dt[i]);
      maxSpeed = Math.max(maxSpeed, d / t.dt[i]);
    }
  }
  let reachedAt = -1; // frame the head reached the turn point
  for (let i = 0; i < t.s.length && reachedAt < 0; i++) if (t.s[i] >= t.turnS - 1e-3) reachedAt = i;
  const span = (from: number, to: number) => t.dt.slice(from + 1, to + 1).reduce((x, y) => x + y, 0);
  return {
    minSpeed,
    maxSpeed,
    worstBack,
    overshoot: t.s[peakIdx] - t.turnS,
    hold: reachedAt >= 0 && t.takeIdx >= reachedAt ? span(reachedAt, t.takeIdx) : Number.NaN,
    takeAfterTurn: t.turnIdx >= 0 && t.takeIdx >= t.turnIdx ? span(t.turnIdx, t.takeIdx) : Number.NaN,
    blendFor: t.blendEndIdx >= 0 && t.takeIdx >= 0 ? span(t.takeIdx, t.blendEndIdx) : Number.NaN,
  };
}

const speedsAround = (t: OwnThrow) =>
  t.s.slice(Math.max(1, t.seenIdx - 1), t.seenIdx + 6).map((v, k) => ((v - t.s[Math.max(1, t.seenIdx - 1) + k - 1]) / t.dt[Math.max(1, t.seenIdx - 1) + k]).toFixed(1)).join(', ');

test('own hook online: through the hand-over the head keeps its full flight speed and never moves back, at 0, 50, 100 and 150 ms RTT (recorded snapshot timings)', (tc) => {
  // the old hand-over blended into the server's head, drawn a round trip plus the interpolation delay
  // behind the ghost: 14-16 m/s for 0.1 s on a LAN, 7-9 m/s for 0.25 s at 100 ms RTT, against 30 m/s
  const lines = [
    { name: 'LAN', up: 1, down: 1 },
    { name: '50 ms RTT', up: 25, down: 25 },
    { name: '100 ms RTT', up: 50, down: 50 },
    { name: '150 ms RTT', up: 75, down: 75 },
  ];
  const holds: string[] = [];
  for (const line of lines) {
    for (const [traceName, trace] of [['idle page', TRACE_IDLE], ['busy page', TRACE_BUSY]] as const) {
      for (const fps of [60, 144]) {
        for (const longLine of [false, true]) {
          const label = `${line.name}, ${traceName}, ${fps} fps${longLine ? ', Long Line' : ''}`;
          const throws = runOwnHook({ up: line.up, down: line.down, jitter: 0, trace }, { fps, throws: 3, longLine });
          assert.equal(throws.length, 3, label);
          for (const [k, t] of throws.entries()) {
            const tl = `${label}, throw ${k + 1}`;
            assert.equal(t.v, HOOK_LEVELS.speed[0] * (longLine ? BAL.longshotSpeedMul : 1), `${tl}: flight speed`);
            assert.ok(t.seenIdx >= 0, `${tl}: our server hook never showed up`);
            assert.ok(t.takeIdx >= 0, `${tl}: the server hook never took over`);
            assert.ok(!Number.isNaN(t.turnS), `${tl}: the hook never turned on the server`);
            assert.equal(t.gaps, 0, `${tl}: ${t.gaps} frames drew no head`);
            const st = throwStats(t);
            assert.ok(st.worstBack >= -1e-9, `${tl}: the head moved back ${(-st.worstBack * 100).toFixed(1)} cm in one frame while flying out`);
            assert.ok(st.minSpeed >= t.v * (1 - 1e-6), `${tl}: after the hand-over the head slowed to ${st.minSpeed.toFixed(1)} m/s (flight ${t.v} m/s; ${speedsAround(t)} m/s around it)`);
            assert.ok(st.maxSpeed <= t.v * 1.4, `${tl}: the head lurched forward at ${st.maxSpeed.toFixed(1)} m/s`);
            // it goes all the way to where the hook turned on the server, and no further
            assert.ok(Math.abs(st.overshoot) < 0.05, `${tl}: the head stopped ${st.overshoot.toFixed(2)} m from the server's turn point (turn at ${t.turnS.toFixed(2)} m, caught ${t.caught})`);
            // the time it was ahead is given back at the turn point, then the server's head takes over: a
            // round trip, the interpolation delay (2.5 ticks), up to 2 ticks of input pacing and a frame, no
            // more (measured: at most 0.12 s past the round trip)
            assert.ok(st.hold <= (line.up + line.down) / 1000 + 0.17, `${tl}: the head waited ${st.hold.toFixed(3)} s at the turn (round trip ${(line.up + line.down) / 1000} s)`);
            assert.ok(st.takeAfterTurn <= 0.1 + 2 / fps + 1e-9, `${tl}: the server head took over ${st.takeAfterTurn.toFixed(2)} s after the picture showed the turn`);
            assert.ok(st.blendFor >= 0 && st.blendFor <= 0.12, `${tl}: the head was off the server's for ${st.blendFor.toFixed(2)} s after it took over`);
            if (fps === 60 && traceName === 'idle page' && k === 0) holds.push(`${line.name}${longLine ? ' LL' : ''} ${(st.hold * 1000).toFixed(0)} ms`);
          }
        }
      }
    }
  }
  tc.diagnostic(`wait at the turn point (60 fps, idle page, first throw): ${holds.join(', ')}`);
});

test('own hook online: the hand-over holds with random jitter and high frame rates as well', () => {
  for (const n of [{ up: 50, down: 50, jitter: 10 }, { up: 75, down: 75, jitter: 20 }, { up: 30, down: 30, jitter: 60 }]) {
    for (const fps of [60, 144, 240]) {
      for (const [k, t] of runOwnHook(n, { fps, throws: 3 }).entries()) {
        const tl = `${n.up + n.down} ms RTT +-${n.jitter} ms at ${fps} fps, throw ${k + 1}`;
        assert.ok(t.takeIdx >= 0 && t.seenIdx >= 0, `${tl}: the server hook never took over`);
        assert.equal(t.gaps, 0, `${tl}: ${t.gaps} frames drew no head`);
        const st = throwStats(t);
        assert.ok(st.worstBack >= -1e-9, `${tl}: the head moved back ${(-st.worstBack * 100).toFixed(1)} cm while flying out`);
        assert.ok(st.minSpeed >= t.v * (1 - 1e-6), `${tl}: after the hand-over the head slowed to ${st.minSpeed.toFixed(1)} m/s`);
        assert.ok(Math.abs(st.overshoot) < 0.05, `${tl}: the head stopped ${st.overshoot.toFixed(2)} m from the server's turn point (turn at ${t.turnS.toFixed(2)} m, caught ${t.caught})`);
      }
    }
  }
});

test('own hook online: a hook that catches someone stops at the catch, or comes straight back to it, and lands on the server head', () => {
  for (const n of [{ up: 1, down: 1, jitter: 0, trace: TRACE_IDLE }, { up: 50, down: 50, jitter: 0, trace: TRACE_BUSY }, { up: 75, down: 75, jitter: 0, trace: TRACE_IDLE }]) {
    for (const targetAt of [7, 12]) {
      for (const [k, t] of runOwnHook(n, { targetAt, throws: 3 }).entries()) {
        const rtt = n.up + n.down;
        const tl = `${rtt} ms RTT, target ${targetAt} m, throw ${k + 1}`;
        assert.ok(t.takeIdx >= 0, `${tl}: the server hook never took over`);
        assert.ok(t.caught, `${tl}: the hook did not catch the target on the server`);
        assert.equal(t.gaps, 0, `${tl}: ${t.gaps} frames drew no head`);
        const st = throwStats(t);
        assert.ok(st.worstBack >= -1e-9, `${tl}: the head moved back while flying out`);
        // the news of the catch takes a round trip (and a tick of input pacing) to come back: the ghost may
        // pass the catch by that much, never more (it stops where it is when the news arrives)
        const allowance = t.v * ((rtt + 2 * TICK_DT * 1000) / 1000) + 0.05;
        assert.ok(st.overshoot <= allowance, `${tl}: the head passed the catch by ${st.overshoot.toFixed(2)} m (allowance ${allowance.toFixed(2)} m)`);
        // after the take the drawn head closes on the server's every frame and is on it when the hook comes in
        for (let j = 1; j < t.offs.length; j++) assert.ok(t.offs[j] <= t.offs[j - 1] + 1e-9, `${tl}: after the catch the head drifted away from the server head (${t.offs.map((g) => g.toFixed(2)).join(', ')} m)`);
        assert.ok(t.offs.length > 0 && t.offs[t.offs.length - 1] < 0.5, `${tl}: the hook came in ${t.offs[t.offs.length - 1]?.toFixed(2)} m off the server head`);
      }
    }
  }
});

test('interpolation marks hooks it could not interpolate (only in the newer snapshot)', () => {
  const hook = (i: number, z: number): HookSnap => ({ i, o: 1, k: 0, p: 0, x: 0, z, r: 0.45, pts: [], tg: -1, ru: -1, fx: 0 });
  const snap = (t: number, h: HookSnap[]) => ({ t, u: [], h, r: [], ev: [] }) as unknown as Snapshot;
  const buf = new SnapshotBuffer(false);
  buf.push(snap(10, [hook(1, 0)]), 0);
  buf.push(snap(11, [hook(1, -1), hook(2, -1)]), 33);
  const f = buf.sample(10.5)!;
  assert.deepEqual([...f.freshHooks], [2], 'hook 2 appeared in the newer snapshot only');
  assert.equal(f.hooks.find((h) => h.i === 1)!.z, -0.5, 'hook 1 is interpolated');
  assert.equal(f.hooks.find((h) => h.i === 2)!.z, -1, 'hook 2 stands at its newer position');
  buf.push(snap(12, [hook(1, -2), hook(2, -2)]), 66);
  assert.equal(buf.sample(11.5)!.freshHooks.size, 0, 'one tick later both hooks are interpolated');
});

test('own hook online: a snapshot stream that stalls mid-throw does not make the hook vanish, pop in behind or move back', () => {
  for (const n of [{ up: 1, down: 1, jitter: 0 }, { up: 50, down: 50, jitter: 10 }]) {
    // during the throw, or from before the press (the newest snapshot at the press is already old)
    for (const stall of [{ after: 150, ms: 400 }, { after: 250, ms: 700 }, { after: -300, ms: 700 }, { after: -600, ms: 1000 }]) {
      for (const [i, t] of runOwnHook(n, { throws: 3, stall }).entries()) {
        const tl = `${n.up + n.down} ms RTT, ${stall.ms} ms stall, throw ${i + 1}`;
        assert.ok(t.takeIdx >= 0, `${tl}: the server hook never took over`);
        assert.equal(t.gaps, 0, `${tl}: the ghost vanished for ${t.gaps} frames before the server hook showed up`);
        const st = throwStats(t);
        assert.ok(st.worstBack >= -1e-9, `${tl}: the head moved back ${(-st.worstBack * 100).toFixed(1)} cm while flying out`);
        assert.ok(st.overshoot < 0.05, `${tl}: the head went ${st.overshoot.toFixed(2)} m past the server's turn point`);
      }
    }
  }
});

test('own hook online: a page that freezes right after the press does not make the hook vanish, pop in behind or move back', () => {
  for (const n of [{ up: 1, down: 1, jitter: 0 }, { up: 50, down: 50, jitter: 10 }]) {
    for (const freeze of [{ after: 1, ms: 300 }, { after: 1, ms: 600 }, { after: 60, ms: 450 }]) {
      for (const [i, t] of runOwnHook(n, { throws: 3, freeze }).entries()) {
        const tl = `${n.up + n.down} ms RTT, ${freeze.ms} ms freeze ${freeze.after} ms after the press, throw ${i + 1}`;
        assert.ok(t.takeIdx >= 0, `${tl}: the server hook never took over (the ghost was dropped)`);
        assert.equal(t.gaps, 0, `${tl}: the ghost vanished for ${t.gaps} frames before the server hook showed up`);
        assert.ok(throwStats(t).worstBack >= -1e-9, `${tl}: the head moved back while flying out`);
      }
    }
  }
});

test('hand-over blend: a hook that bounces or steers back while flying out is followed, not held', () => {
  const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: false }, players([0, 1]), 11);
  for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
  const you = sim.snapshotFor(1).you!;
  const body = { x: -20, z: 0 };
  const dt = 1 / 60;
  // ricochet or Boing Barb: the bounce adds a bend point; Bendy Eel: the steer bit, a bend point only later
  const cases: { name: string; fx: number; turned: Partial<HookSnap> }[] = [
    { name: 'ricochet bounce', fx: 2, turned: { pts: [-20, -6], fx: 2 } },
    { name: 'Bendy Eel turning back', fx: 4, turned: { fx: 4 } },
  ];
  for (const c of cases) {
    const own = new OwnHookPredictor();
    own.press(you, 10, { x: -20, z: -30 }, 100, 2.5, 1000);
    const g = own.ghost!;
    own.frame({ tick: 1000, hooks: [], freshHooks: new Set() }, 1, g.start + 0.01, body, false); // the ghost leaves the hand
    let t = g.start + 0.2; // the ghost is about 6 m out, the server head (drawn in the past) about 2 m
    let hz = -3;
    const hook = (z: number, extra: Partial<HookSnap> = {}): HookSnap => ({ i: 60, o: 1, k: 0, p: 0, x: -20, z, r: 0.45, pts: [], tg: -1, ru: -1, fx: c.fx, ...extra });
    const out = { x: 0, z: 0 };
    let took = false;
    let k = 0;
    let off = Infinity;
    for (; t < g.start + 1.5; k++) {
      t += dt;
      // two more frames out, then it comes back along the throw (a bounce, or Bendy Eel steering), still phase 0
      hz += k <= 2 ? -0.5 : 0.5;
      const h = hook(hz, k <= 2 ? {} : c.turned);
      const step = own.frame({ tick: 1006 + k, hooks: [h], freshHooks: new Set() }, 1, t, body, false);
      if (step.act === 'take') took = true;
      const at = own.head(h, 1, dt, out);
      if (took && at) off = Math.hypot(out.x - h.x, out.z - h.z);
      if (took && !own.blend) break;
    }
    assert.ok(took, `${c.name}: the server's hook never took over`);
    assert.ok(t < g.start + 0.2 + 0.6, `${c.name}: the blend ran ${(t - g.start - 0.2).toFixed(2)} s`);
    assert.ok(off < 1e-6, `${c.name}: ${off.toFixed(2)} m off the server head after the blend (the head was held at its furthest point)`);
    assert.equal(own.blend, null, `${c.name}: the blend never ended`);
  }
});

test('hand-over rules: the ghost flies while our hook flies out straight, stops at the turn, and the server head takes over there', () => {
  const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: false }, players([0, 1]), 11);
  for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
  const you = sim.snapshotFor(1).you!;
  const v = ghostHookParams(you).speed;
  const mineAt = (z: number, extra: Partial<HookSnap> = {}): HookSnap => ({ i: 50, o: 1, k: 0, p: 0, x: -20, z, r: 0.45, pts: [], tg: -1, ru: -1, fx: 0, ...extra });
  const theirs: HookSnap = { ...mineAt(3), i: 51, o: 2 };
  const body = { x: -20, z: 0 };
  const at = (tick: number, hooks: HookSnap[] = [], fresh: number[] = [], latest?: HookSnap[]) => ({ tick, hooks, freshHooks: new Set(fresh), latest: latest ? { h: latest } : undefined });
  const headZ = (own: OwnHookPredictor, time: number) => ghostHead(own.ghost!, time, { x: 0, z: 0 }).z;
  const own = new OwnHookPredictor();
  // pressed at render tick 997 with snapshot 1000 the newest, 100 ms round trip
  own.press(you, 10, { x: -20, z: -30 }, 100, 2.5, 1000);
  const g = own.ghost!;
  assert.equal(own.frame(at(997), 1, 10.05, body, false).act, 'before', 'winding up');
  assert.equal(own.frame(at(998), 1, g.start + 0.05, body, false).act, 'fly');
  // our hook shows up, only in the newer snapshot, 2 m behind the ghost: keep flying the ghost, never draw ours twice
  let time = g.start + 0.1;
  const z1 = headZ(own, time) + 2;
  assert.equal(own.frame(at(1004, [mineAt(z1), theirs], [50, 51]), 1, time, body, false).act, 'fly', 'the server hook only in the newer snapshot: the ghost keeps flying');
  assert.equal(own.head(mineAt(z1), 1, 1 / 60, { x: 0, z: 0 }), null, 'our server hook is not drawn while the ghost still is');
  assert.ok(own.head(theirs, 1, 1 / 60, { x: 0, z: 0 }), 'a new hook of someone else is drawn as usual');
  // long past the old hand-over grace, still flying straight: still the ghost, at full speed
  time = g.start + 0.1 + HANDOVER_GRACE + 0.05;
  const before = headZ(own, time - 1 / 60);
  assert.equal(own.frame(at(1012, [mineAt(headZ(own, time) + 3)]), 1, time, body, false).act, 'fly', 'a hook flying out straight is not handed over');
  assert.ok(Math.abs(before - headZ(own, time) - v / 60) < 1e-6, 'the ghost flies at the full speed');
  // the picture catches up past the ghost (it froze, or the stream came back): never behind the server's head
  time += 1 / 60;
  const ahead = headZ(own, time) - 1;
  own.frame(at(1013, [mineAt(ahead)]), 1, time, body, false);
  assert.ok(Math.abs(headZ(own, time) - ahead) < 1e-6, 'the ghost was drawn behind the server head');
  // the newest snapshot says the hook turned 2 m further on: the ghost goes there and stops
  const turnZ = ahead - 2;
  time += 1 / 60;
  own.frame(at(1014, [mineAt(ahead + 0.5)], [], [mineAt(turnZ, { p: 1 })]), 1, time, body, false);
  assert.ok(headZ(own, time) > turnZ, 'the ghost jumped to the turn');
  time += 0.2;
  assert.equal(own.frame(at(1020, [mineAt(turnZ + 0.6)], [], [mineAt(turnZ + 3, { p: 1 })]), 1, time, body, false).act, 'fly');
  assert.ok(Math.abs(headZ(own, time) - turnZ) < 1e-6, `the ghost did not stop at the turn (${headZ(own, time).toFixed(2)} vs ${turnZ.toFixed(2)})`);
  // the picture shows it turned while the drawn head still comes up to the turn: wait there ...
  time += 1 / 60;
  assert.equal(own.frame(at(1021, [mineAt(turnZ + 0.3, { p: 1 })]), 1, time, body, false).act, 'fly', 'handed over before the drawn head reached the turn');
  // ... and hand over once it has come up and turns back
  time += 1 / 60;
  const st = own.frame(at(1022, [mineAt(turnZ + 0.4, { p: 1 })]), 1, time, body, false);
  assert.equal(st.act, 'take', 'the drawn server head turned back: it takes over');
  assert.equal(own.ghost, null);
  assert.ok(own.blend, 'and blends from where the ghost stood');

  // a ghost already past the turn when the news arrives stops where it is: it never goes back while out
  own.press(you, 20, { x: -20, z: -30 }, 100, 2.5, 1500);
  const p = own.ghost!;
  own.frame(at(1500), 1, p.start + 0.01, body, false);
  time = p.start + 0.3;
  own.frame(at(1505, [mineAt(-3)]), 1, time, body, false);
  const z = headZ(own, time);
  time += 1 / 60;
  own.frame(at(1506, [mineAt(-3.5)], [], [mineAt(z + 1.5, { p: 1, tg: 2 })]), 1, time, body, false);
  const held = headZ(own, time);
  assert.ok(held <= z && held > z - v / 60 - 1e-9, 'past the catch: the ghost stops where it is this frame, it does not go back to the catch');
  time += 0.1;
  own.frame(at(1508, [mineAt(-4)]), 1, time, body, false);
  assert.ok(Math.abs(headZ(own, time) - held) < 1e-9, 'and stays there');
  // our hook leaves the picture without a turn ever shown (a stall skipped past it): the ghost goes
  assert.equal(own.frame(at(1540), 1, time + 0.5, body, false).act, 'drop');

  // Bendy Eel steers toward the live cursor on the server: handed over once interpolated, never forever
  const bendy = new OwnHookPredictor();
  bendy.press(you, 30, { x: -20, z: -30 }, 100, 2.5, 3000);
  const bg = bendy.ghost!;
  bendy.frame(at(3000), 1, bg.start + 0.05, body, false);
  const steer = mineAt(-2, { fx: 4 });
  assert.equal(bendy.frame(at(3004, [steer], [50]), 1, bg.start + 0.1, body, false).act, 'fly', 'only in the newer snapshot: wait for it to interpolate');
  assert.equal(bendy.frame(at(3005, [steer], [50]), 1, bg.start + 0.1 + HANDOVER_GRACE + 0.01, body, false).act, 'take', 'a steering hook that never interpolates still takes over');

  // no hook comes: the cast failed on the server
  own.press(you, 40, { x: -20, z: -30 }, 100, 2.5, 2000);
  const h = own.ghost!;
  assert.ok(h.deadTick >= 2000 + 3 + 4, `the render-clock deadline ${h.deadTick} leaves no room for a round trip and the wind-up`);
  assert.equal(own.frame(at(h.deadTick - 1), 1, h.start + 0.05, body, false).act, 'fly');
  assert.equal(own.frame(at(h.deadTick + 1), 1, h.deadline - 0.01, body, false).act, 'fly', 'never dropped before the client-clock deadline');
  // the snapshot stream stalls: the render clock stands still before the tick the hook should be on
  assert.equal(own.frame(at(h.deadTick - 3), 1, h.deadline + 0.5, body, false).act, 'fly', 'a stalled stream dropped the ghost, and the hook would pop in behind it');
  assert.equal(own.frame(at(h.deadTick + 1), 1, h.deadline + 0.6, body, false).act, 'drop', 'the picture passed the tick the hook should be on: the cast failed');
  // a stream that never comes back still lets the ghost go
  own.press(you, 50, { x: -20, z: -30 }, 100, 2.5, 3000);
  assert.equal(own.frame(at(2999), 1, own.ghost!.deadline + GHOST_STALL_CAP + 0.01, body, false).act, 'drop');
  // knocked, hooked or killed: gone at once
  own.press(you, 60, { x: -20, z: -30 }, 100, 2.5, 4000);
  assert.equal(own.frame(at(3999), 1, own.ghost!.start + 0.05, body, true).act, 'drop');
});

// ---------------------------------------------------------------------------------------------
// Desktop readiness: only the browser build's empty address means "the host that served the page"

const HTTP: PageOrigin = { protocol: 'http:', host: 'localhost:8144' };
const HTTPS: PageOrigin = { protocol: 'https:', host: 'hookwars.example' };
const DISK: PageOrigin = { protocol: 'file:', host: '' };
const APP: PageOrigin = { protocol: 'app:', host: 'hookwars' };

test('server address: the browser default is unchanged, byte for byte (it keys account and rejoin tokens)', () => {
  // the old defaultServerUrl() was `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
  assert.equal(defaultServerUrl(HTTP), 'ws://localhost:8144/ws');
  assert.equal(defaultServerUrl(HTTPS), 'wss://hookwars.example/ws');
  assert.equal(normaliseServerUrl('', HTTP), 'ws://localhost:8144/ws');
  assert.equal(normaliseServerUrl('  ', HTTPS), 'wss://hookwars.example/ws');
  assert.equal(normaliseServerUrl('play.example.com:8080', HTTP), 'ws://play.example.com:8080/ws');
  assert.equal(normaliseServerUrl('play.example.com', HTTPS), 'wss://play.example.com/ws');
  assert.equal(normaliseServerUrl('https://play.example.com', HTTP), 'wss://play.example.com/ws');
  assert.equal(normaliseServerUrl('ftp://play.example.com', HTTP), null);
});

test('server address: a page loaded from disk (desktop app) has no implicit server', () => {
  for (const page of [DISK, APP, null]) {
    assert.equal(defaultServerUrl(page), null, `${page?.protocol}: no host served this page, so no default server`);
    assert.equal(normaliseServerUrl('', page), null);
  }
  // a dedicated server gets TLS, a server on this machine or the LAN does not
  assert.equal(normaliseServerUrl('play.example.com', DISK), 'wss://play.example.com/ws');
  assert.equal(normaliseServerUrl('localhost:8080', DISK), 'ws://localhost:8080/ws');
  assert.equal(normaliseServerUrl('127.0.0.1:8080', APP), 'ws://127.0.0.1:8080/ws');
  assert.equal(normaliseServerUrl('192.168.1.20:8080', DISK), 'ws://192.168.1.20:8080/ws');
  assert.equal(normaliseServerUrl('[::1]:8080', DISK), 'ws://[::1]:8080/ws');
  assert.equal(normaliseServerUrl('wss://10.0.0.5:8443', DISK), 'wss://10.0.0.5:8443/ws');
});

test('server address: a desktop build can point the empty address at a dedicated server', () => {
  try {
    assert.equal(setDefaultServerUrl('play.example.com'), true);
    assert.equal(defaultServerUrl(DISK), 'wss://play.example.com/ws');
    assert.equal(normaliseServerUrl('', DISK), 'wss://play.example.com/ws');
    assert.equal(setDefaultServerUrl('localhost:8080'), true);
    assert.equal(normaliseServerUrl('', APP), 'ws://localhost:8080/ws');
    assert.equal(setDefaultServerUrl('ftp://nope'), false, 'a bad address is refused');
    assert.equal(defaultServerUrl(DISK), 'ws://localhost:8080/ws', 'and the previous default stays');
  } finally {
    setDefaultServerUrl(null);
  }
  assert.equal(defaultServerUrl(HTTP), 'ws://localhost:8144/ws', 'cleared: back to the page host');
});
