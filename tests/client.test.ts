// Client glue: auto-rejoin cancelling (finding 27), the solo render clock after a long frame (28),
// the predicted hook matching the server's (29) and the default server address (desktop readiness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAL, DEFAULT_CONFIG, HOOK_LEVELS, TICK_RATE } from '../shared/constants.ts';
import { GameSim } from '../shared/sim/sim.ts';
import { Btn, type MatchConfig, type PlayerInfo, type Snapshot, type Team } from '../shared/types.ts';
import type { Profile, ServerMsg } from '../shared/protocol.ts';
import { AutoRejoin, REJOIN_RETRY_MS, type RetryTimers } from '../client/net/autorejoin.ts';
import { Connection, defaultServerUrl, normaliseServerUrl, setDefaultServerUrl, type PageOrigin } from '../client/net/connection.ts';
import { SnapshotBuffer, clockStepMs } from '../client/net/interp.ts';
import { RejoinStore, type KeyValueStore } from '../client/net/rejoin.ts';
import { LocalSession } from '../client/net/session.ts';
import { ghostHookParams } from '../client/game/ghost.ts';

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

test('online render clock is unchanged: frameTick is advance with the 100 ms clamp, and the delay still covers jitter', () => {
  // the solo fix must not touch online play: drive one buffer the new way (frameTick, even with a stray
  // paused flag, which only solo honours) and one the old way (advance(now, clamp(raw, 0, 100)))
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
