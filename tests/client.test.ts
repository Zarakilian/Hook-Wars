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
import { GHOST_STALL_CAP, HANDOVER_GRACE, OwnHookPredictor, ghostHead, ghostHookParams } from '../client/game/ghost.ts';

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

interface OwnThrow {
  /** frames from the ghost's first frame until the hook turns or catches: progress along the throw, m */
  steps: number[];
  /** index into steps of the hand-over frame (-1 = the server's hook never took over) */
  handIdx: number;
  /** speed along the throw of the server's head as drawn (what the blend rides on), first frames after the hand-over */
  baseSpeeds: number[];
  /** frames with no head drawn between the ghost's first frame and the turn */
  gaps: number;
  /** s from the hand-over until the head is the server's again (-1 = not within the throw) */
  blendFor: number;
  /** index into steps where the blend ended (steps.length if it ended after the hook turned) */
  blendEndIdx: number;
  /** after the hook turned or caught: distance from the drawn head to the server's, per frame, until the blend ends or the hook is gone */
  turnGaps: number[];
  v: number;
}

/**
 * Our own hook online, the way GameClient draws it: a real GameSim stepping at 30 Hz, inputs and
 * snapshots each delayed by a one-way latency plus jitter (in order, like a WebSocket), the online
 * SnapshotBuffer driven by frameTick at the frame rate, and the OwnHookPredictor GameClient uses.
 */
function runOwnHook(
  net: { up: number; down: number; jitter: number },
  o: { fps?: number; throws?: number; targetAt?: number; stall?: { after: number; ms: number }; freeze?: { after: number; ms: number } } = {},
): OwnThrow[] {
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: false }, players([0, 1]), 11);
  for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
  const a = sim.unitById.get(1)!;
  const b = sim.unitById.get(2)!;
  const stage = () => {
    a.spawnProt = 0;
    a.x = -20;
    a.z = 0;
    b.spawnProt = 0;
    b.hp = b.maxHp;
    b.x = -20;
    b.z = o.targetAt ? -o.targetAt : 30; // in the path, or well out of it
  };
  stage();
  const aim = { x: -20, z: -30 };
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
  const throws: OwnThrow[] = [];
  let pi = 0;
  let cur: (OwnThrow & { on: boolean; done: boolean; handAt: number; ox: number; oz: number; dx: number; dz: number; prevS: number; prevBase: number }) | null = null;
  const tmp = { x: 0, z: 0 };
  for (let now = 1000; now < presses[presses.length - 1] + 3000; now += frameMs) {
    while (serverAt <= now) {
      while (up.length && up[0].at <= serverAt) sim.queueInput(1, up.shift()!.i);
      if (pi < presses.length && Math.abs(serverAt - (presses[pi] - 1000)) < tickMs / 2) stage();
      sim.step();
      let at = Math.max(lastDown, serverAt + net.down + rnd() * net.jitter);
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
      if (pi < presses.length && presses[pi] <= now && you && playing) {
        own.press(you, time, aim, net.up + net.down, buffer.delay, (buffer.latest?.t ?? -1));
        pressed = true;
        if (cur) throws.push(cur);
        cur = { steps: [], handIdx: -1, baseSpeeds: [], gaps: 0, blendFor: -1, blendEndIdx: -1, turnGaps: [], v: ghostHookParams(you).speed, on: false, done: false, handAt: 0, ox: 0, oz: 0, dx: 0, dz: 0, prevS: NaN, prevBase: NaN };
        pi++;
      }
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
    if (pi < presses.length && presses[pi] <= now && you && playing) {
      own.press(you, time, aim, net.up + net.down, buffer.delay, (buffer.latest?.t ?? -1));
      pressed = true;
      if (cur) throws.push(cur);
      cur = { steps: [], handIdx: -1, baseSpeeds: [], gaps: 0, blendFor: -1, blendEndIdx: -1, turnGaps: [], v: ghostHookParams(you).speed, on: false, done: false, handAt: 0, ox: 0, oz: 0, dx: 0, dz: 0, prevS: NaN, prevBase: NaN };
      pi++;
    }
    // GameClient.frame, online
    if (last < 0) last = now;
    const rawMs = now - last;
    last = now;
    const dt = Math.min(100, Math.max(0, rawMs)) / 1000;
    time += dt;
    tickAcc += Math.min(500, Math.max(0, rawMs)) / 1000;
    while (tickAcc >= TICK_DT) {
      tickAcc -= TICK_DT;
      lastUp = Math.max(lastUp, now + net.up + rnd() * net.jitter);
      up.push({ at: lastUp, i: { seq: ++seq, mx: 0, mz: 0, ax: aim.x, az: aim.z, b: pressed ? Btn.Hook : 0 } });
      if (pressed) own.sent((buffer.latest?.t ?? -1), net.up + net.down); // GameClient.localTick
      pressed = false;
    }
    const f = buffer.sample(buffer.frameTick(now, rawMs, false));
    if (!f) continue;
    playing = f.newer.ph === 'playing';
    // updateGhost, then updateHooks
    const step = own.frame(f, 1, time, body, false);
    let drawn: { x: number; z: number } | null = step.act === 'fly' && own.ghost ? ghostHead(own.ghost, time, { x: 0, z: 0 }) : null;
    let mine: HookSnap | null = null;
    for (const h of f.hooks) {
      const at = own.head(h, 1, dt, tmp);
      if (at && h.o === 1 && h.k === 0) {
        drawn = { x: at.x, z: at.z };
        mine = h;
      }
    }
    if (!cur || cur.done) continue;
    if (!cur.on) {
      if (!drawn) continue;
      cur.on = true;
      const l = Math.hypot(aim.x - body.x, aim.z - body.z);
      cur.dx = (aim.x - body.x) / l;
      cur.dz = (aim.z - body.z) / l;
      cur.ox = body.x;
      cur.oz = body.z;
    }
    if (step.act === 'take') {
      cur.handIdx = cur.steps.length;
      cur.handAt = time;
    }
    if (cur.handIdx >= 0 && cur.blendFor < 0 && !own.blend) {
      cur.blendFor = time - cur.handAt;
      cur.blendEndIdx = cur.steps.length;
    }
    const turned = mine !== null && (mine.p !== 0 || mine.tg >= 0 || mine.ru >= 0);
    if (turned || (!mine && cur.turnGaps.length)) {
      // turned or caught: only the end of the blend is still watched, until it ends or the hook is in
      if (!mine || cur.blendFor >= 0) cur.done = true;
      else if (drawn) cur.turnGaps.push(Math.hypot(drawn.x - mine.x, drawn.z - mine.z));
      continue;
    }
    if (!drawn) {
      cur.gaps++;
      continue;
    }
    const c = cur;
    const along = (x: number, z: number) => (x - c.ox) * c.dx + (z - c.oz) * c.dz;
    const sNow = along(drawn.x, drawn.z);
    if (!Number.isNaN(cur.prevS)) cur.steps.push(sNow - cur.prevS);
    cur.prevS = sNow;
    if (mine && cur.handIdx >= 0) {
      const base = along(mine.x, mine.z);
      if (!Number.isNaN(cur.prevBase) && cur.baseSpeeds.length < 4) cur.baseSpeeds.push((base - cur.prevBase) / dt);
      cur.prevBase = base;
    }
  }
  if (cur) throws.push(cur);
  return throws;
}

const around = (t: OwnThrow, fps: number) => t.steps.slice(Math.max(0, t.handIdx - 1), t.handIdx + 5).map((d) => (d * fps).toFixed(0)).join(', ');

test('own hook online: when the server hook takes over, the head never stands still or moves back (finding 29)', () => {
  // holdOk: on a jittery line the interpolated server head itself slows and speeds up; the head may then
  // wait a few frames for it (it never goes back), and after the blend it is the interpolation's own motion
  const nets = [
    { name: 'LAN', up: 1, down: 1, jitter: 0, holdOk: false },
    { name: '100 ms RTT', up: 50, down: 50, jitter: 10, holdOk: false },
    { name: '150 ms RTT, 20 ms jitter', up: 75, down: 75, jitter: 20, holdOk: true },
    { name: '60 ms RTT, 60 ms jitter', up: 30, down: 30, jitter: 60, holdOk: true },
  ];
  for (const n of nets) {
    for (const fps of [60, 144]) {
      const label = `${n.name} at ${fps} fps`;
      const throws = runOwnHook(n, { fps, throws: 3 });
      assert.equal(throws.length, 3, label);
      for (const [i, t] of throws.entries()) {
        const tl = `${label}, throw ${i + 1}`;
        assert.ok(t.handIdx >= 0, `${tl}: the server hook never took over`);
        assert.equal(t.gaps, 0, `${tl}: ${t.gaps} frames drew no head (the ghost was dropped before the server hook took over)`);
        // the server head the blend rides on must be moving: a hook only in the newer snapshot stands still
        // (old code: exactly 0 on the first frame after the hand-over, on every line)
        const base = n.holdOk ? t.baseSpeeds[0] : Math.min(...t.baseSpeeds);
        assert.ok(base > 0.25 * t.v, `${tl}: right after the hand-over the server head stood still (${t.baseSpeeds.map((v) => v.toFixed(1)).join(', ')} m/s)`);
        const blended = t.steps.slice(0, t.blendEndIdx); // the ghost, the hand-over and the blend
        const worst = Math.min(...blended);
        assert.ok(worst >= -1e-9, `${tl}: the head moved back ${(-worst * 100).toFixed(1)} cm in one frame (${around(t, fps)} m/s around the hand-over)`);
        if (!n.holdOk) {
          // one 144 fps frame can dip to nothing with the interpolation's own jitter; a hold you can see cannot
          let run = 0;
          let longest = 0;
          for (const d of blended) {
            run = d * fps < 0.02 * t.v ? run + 1 : 0;
            longest = Math.max(longest, run);
          }
          assert.ok((longest * 1000) / fps <= 20, `${tl}: the head stood still for ${((longest * 1000) / fps).toFixed(0)} ms (${around(t, fps)} m/s around the hand-over)`);
        }
        assert.ok(Math.max(...blended) * fps <= t.v * 1.4, `${tl}: the head lurched forward at ${(Math.max(...t.steps) * fps).toFixed(1)} m/s`);
        assert.ok(t.blendFor >= 0 && t.blendFor < 0.6, `${tl}: the head was still off the server's ${t.blendFor.toFixed(2)} s after the hand-over`);
      }
    }
  }
});

test('own hook online: a hook that catches someone during the blend still lands on the server head', () => {
  for (const n of [{ up: 1, down: 1, jitter: 0 }, { up: 50, down: 50, jitter: 10 }]) {
    for (const [i, t] of runOwnHook(n, { targetAt: 7, throws: 3 }).entries()) {
      const tl = `${n.up + n.down} ms RTT, throw ${i + 1}`;
      assert.ok(t.handIdx >= 0, `${tl}: the server hook never took over`);
      assert.ok(Math.min(...t.steps) >= -1e-9, `${tl}: the head moved back while flying out`);
      assert.ok(t.turnGaps.length > 0 || t.blendFor >= 0, `${tl}: the catch was never seen`);
      // after the catch the drawn head closes on the server's every frame and is on it when the hook comes in
      for (let k = 1; k < t.turnGaps.length; k++) assert.ok(t.turnGaps[k] <= t.turnGaps[k - 1] + 1e-9, `${tl}: after the catch the head drifted away from the server head (${t.turnGaps.map((g) => g.toFixed(2)).join(', ')} m)`);
      if (t.turnGaps.length) assert.ok(t.turnGaps[t.turnGaps.length - 1] < 0.5, `${tl}: the hook came in ${t.turnGaps[t.turnGaps.length - 1].toFixed(2)} m off the server head`);
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

test('own hook online: a snapshot stream that stalls mid-throw does not make the hook vanish and pop in behind', () => {
  for (const n of [{ up: 1, down: 1, jitter: 0 }, { up: 50, down: 50, jitter: 10 }]) {
    // during the throw, or from before the press (the newest snapshot at the press is already old)
    for (const stall of [{ after: 150, ms: 400 }, { after: 250, ms: 700 }, { after: -300, ms: 700 }, { after: -600, ms: 1000 }]) {
      for (const [i, t] of runOwnHook(n, { throws: 3, stall }).entries()) {
        const tl = `${n.up + n.down} ms RTT, ${stall.ms} ms stall, throw ${i + 1}`;
        assert.ok(t.handIdx >= 0, `${tl}: the server hook never took over`);
        assert.equal(t.gaps, 0, `${tl}: the ghost vanished for ${t.gaps} frames before the server hook showed up`);
        assert.ok(Math.min(...t.steps.slice(0, t.blendEndIdx)) >= -1e-9, `${tl}: the head moved back (${around(t, 60)} m/s around the hand-over)`);
      }
    }
  }
});

test('own hook online: a page that freezes right after the press does not make the hook vanish and pop in behind', () => {
  for (const n of [{ up: 1, down: 1, jitter: 0 }, { up: 50, down: 50, jitter: 10 }]) {
    for (const freeze of [{ after: 1, ms: 300 }, { after: 1, ms: 600 }, { after: 60, ms: 450 }]) {
      for (const [i, t] of runOwnHook(n, { throws: 3, freeze }).entries()) {
        const tl = `${n.up + n.down} ms RTT, ${freeze.ms} ms freeze ${freeze.after} ms after the press, throw ${i + 1}`;
        assert.ok(t.handIdx >= 0, `${tl}: the server hook never took over (the ghost was dropped)`);
        assert.equal(t.gaps, 0, `${tl}: the ghost vanished for ${t.gaps} frames before the server hook showed up`);
        assert.ok(Math.min(...t.steps.slice(0, t.blendEndIdx)) >= -1e-9, `${tl}: the head moved back (${around(t, 60)} m/s around the hand-over)`);
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
  const cases: { name: string; turned: Partial<HookSnap> }[] = [
    { name: 'ricochet bounce', turned: { pts: [-20, -6], fx: 2 } },
    { name: 'Bendy Eel turning back', turned: { fx: 4 } },
  ];
  for (const c of cases) {
    const own = new OwnHookPredictor();
    own.press(you, 10, { x: -20, z: -30 }, 100, 2.5, 1000);
    const g = own.ghost!;
    own.frame({ tick: 1000, hooks: [], freshHooks: new Set() }, 1, g.start + 0.01, body, false); // the ghost leaves the hand
    let t = g.start + 0.2; // the ghost is about 6 m out, the server head (drawn in the past) about 2 m
    let hz = -3;
    const hook = (z: number, extra: Partial<HookSnap> = {}): HookSnap => ({ i: 60, o: 1, k: 0, p: 0, x: -20, z, r: 0.45, pts: [], tg: -1, ru: -1, fx: c.turned.fx ?? 0, ...extra });
    assert.equal(own.frame({ tick: 1006, hooks: [hook(hz)], freshHooks: new Set() }, 1, t, body, false).act, 'take', `${c.name}: setup`);
    const dur = own.blend!.dur;
    const out = { x: 0, z: 0 };
    own.head(hook(hz), 1, dt, out); // the hand-over frame
    let off = Infinity;
    for (let k = 1; t < g.start + 0.2 + dur + 3 * dt; k++) {
      t += dt;
      // two more frames out, then it comes back along the throw, still flying out (phase 0)
      hz += k <= 2 ? -0.5 : 0.5;
      const h = hook(hz, k <= 2 ? {} : c.turned);
      own.frame({ tick: 1006 + k, hooks: [h], freshHooks: new Set() }, 1, t, body, false);
      own.head(h, 1, dt, out);
      off = Math.hypot(out.x - h.x, out.z - h.z);
    }
    assert.ok(off < 1e-6, `${c.name}: ${off.toFixed(2)} m off the server head after the blend time (the head was held at its furthest point)`);
    assert.equal(own.blend, null, `${c.name}: the blend never ended`);
  }
});

test('hand-over rules: wait for an interpolated server hook, but never forever, and never draw our hook twice', () => {
  const sim = new GameSim({ ...DEFAULT_CONFIG, hazards: 'none', botFill: false }, players([0, 1]), 11);
  for (let i = 0; i < TICK_RATE * 5; i++) sim.step();
  const you = sim.snapshotFor(1).you!;
  const mineH: HookSnap = { i: 50, o: 1, k: 0, p: 0, x: -20, z: -3, r: 0.45, pts: [], tg: -1, ru: -1, fx: 0 };
  const theirs: HookSnap = { ...mineH, i: 51, o: 2, z: 3 };
  const body = { x: -20, z: 0 };
  const at = (tick: number, hooks: HookSnap[] = [], fresh: number[] = []) => ({ tick, hooks, freshHooks: new Set(fresh) });
  const own = new OwnHookPredictor();
  // pressed at render tick 997 with snapshot 1000 the newest, 100 ms round trip
  own.press(you, 10, { x: -20, z: -30 }, 100, 2.5, 1000);
  const g = own.ghost!;
  assert.equal(own.frame(at(997), 1, 10.05, body, false).act, 'before', 'winding up');
  assert.equal(own.frame(at(998), 1, g.start + 0.05, body, false).act, 'fly');
  const fresh = at(1004, [mineH, theirs], [50, 51]);
  assert.equal(own.frame(fresh, 1, g.start + 0.1, body, false).act, 'fly', 'the server hook is only in the newer snapshot: keep flying the ghost');
  assert.equal(own.head(mineH, 1, 1 / 60, { x: 0, z: 0 }), null, 'our server hook is not drawn while the ghost still is');
  assert.ok(own.head(theirs, 1, 1 / 60, { x: 0, z: 0 }), 'a new hook of someone else is drawn as usual');
  assert.equal(own.frame({ ...fresh, tick: 1005 }, 1, g.start + 0.1 + HANDOVER_GRACE - 0.01, body, false).act, 'fly', 'still waiting for it to interpolate');
  assert.equal(own.frame({ ...fresh, tick: 1005 }, 1, g.start + 0.1 + HANDOVER_GRACE + 0.01, body, false).act, 'take', 'a hook that never interpolates (the stream stalled) still takes over');
  assert.equal(own.ghost, null);
  assert.ok(own.blend, 'and blends from where the ghost was');

  // no hook comes: the cast failed on the server
  own.press(you, 20, { x: -20, z: -30 }, 100, 2.5, 2000);
  const h = own.ghost!;
  assert.ok(h.deadTick >= 2000 + 3 + 4, `the render-clock deadline ${h.deadTick} leaves no room for a round trip and the wind-up`);
  assert.equal(own.frame(at(h.deadTick - 1), 1, h.start + 0.05, body, false).act, 'fly');
  assert.equal(own.frame(at(h.deadTick + 1), 1, h.deadline - 0.01, body, false).act, 'fly', 'never dropped before the client-clock deadline');
  // the snapshot stream stalls: the render clock stands still before the tick the hook should be on
  assert.equal(own.frame(at(h.deadTick - 3), 1, h.deadline + 0.5, body, false).act, 'fly', 'a stalled stream dropped the ghost, and the hook would pop in behind it');
  assert.equal(own.frame(at(h.deadTick + 1), 1, h.deadline + 0.6, body, false).act, 'drop', 'the picture passed the tick the hook should be on: the cast failed');
  // the stream comes back after a long stall and our hook shows up only in the newer snapshot: it is
  // still given its tick to interpolate, counted from when it showed up, not from the deadline
  own.press(you, 25, { x: -20, z: -30 }, 100, 2.5, 2500);
  const lg = own.ghost!;
  assert.equal(own.frame(at(lg.deadTick - 4), 1, lg.start + 0.05, body, false).act, 'fly');
  const late = at(lg.deadTick - 2, [mineH], [50]);
  assert.equal(own.frame(late, 1, lg.deadline + 1, body, false).act, 'fly', 'a hook that shows up late is taken over before it interpolates');
  assert.equal(own.frame({ ...late, freshHooks: new Set<number>() }, 1, lg.deadline + 1.02, body, false).act, 'take');
  // a stream that never comes back still lets the ghost go
  own.press(you, 30, { x: -20, z: -30 }, 100, 2.5, 3000);
  assert.equal(own.frame(at(2999), 1, own.ghost!.deadline + GHOST_STALL_CAP + 0.01, body, false).act, 'drop');
  // knocked, hooked or killed: gone at once
  own.press(you, 40, { x: -20, z: -30 }, 100, 2.5, 4000);
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
