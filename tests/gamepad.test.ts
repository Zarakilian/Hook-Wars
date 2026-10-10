// Gamepad support (client/game/gamepad.ts and its use in client/game/input.ts), driven through a
// stubbed navigator.getGamepads: button mapping, dead zones and the aim curve, where the aim stick puts
// the aim point, one press per button down, hot-plugging, and the hand-over between mouse and pad.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HOOK_LEVELS } from '../shared/constants.ts';
import { Btn, BTN_ITEM } from '../shared/types.ts';
import {
  AIM_MIN,
  DEFAULT_PAD,
  PadBtn,
  PadReader,
  STICK_OUTER,
  aimDistance,
  aimGamma,
  aimReach,
  cleanPadConfig,
  STICK_WAKE,
  lastDevice,
  noteDevice,
  noteHookRange,
  padConfig,
  radial,
  resetPadShared,
  setPadConfig,
  type PadLike,
} from '../client/game/gamepad.ts';

// ---------------------------------------------------------------------------------------------
// browser stand-ins: window (events), the canvas, navigator.getGamepads
// ---------------------------------------------------------------------------------------------

const g = globalThis as unknown as Record<string, unknown>;
if (!g.window) g.window = new EventTarget();
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});
const { InputController, MOUSE_TAKEOVER_PX } = await import('../client/game/input.ts');
const { parseSettings, padSettings, saveSettings, DEFAULT_SETTINGS } = await import('../client/settings.ts');

/** A mutable standard-mapping pad, the shape the Gamepad API hands out. */
class FakePad implements PadLike {
  index: number;
  id: string;
  connected = true;
  mapping = 'standard';
  buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  axes = [0, 0, 0, 0];
  constructor(index = 0, id = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)') {
    this.index = index;
    this.id = id;
  }
  set(i: number, value: number): this {
    this.buttons[i] = { pressed: value >= 0.5, value };
    return this;
  }
  down(i: number): this {
    return this.set(i, 1);
  }
  up(i: number): this {
    return this.set(i, 0);
  }
  stick(lx: number, ly: number, rx = this.axes[2], ry = this.axes[3]): this {
    this.axes = [lx, ly, rx, ry];
    return this;
  }
}

let pads: (FakePad | null)[] = [];
Object.defineProperty(navigator, 'getGamepads', { value: () => pads, configurable: true, writable: true });

function canvas() {
  const el = new EventTarget() as EventTarget & { style: { cursor: string }; getBoundingClientRect(): DOMRect };
  el.style = { cursor: '' };
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return el;
}

function pointer(el: EventTarget, type: string, x: number, y: number, button = 0): void {
  el.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y, button }));
}

function key(type: 'keydown' | 'keyup', code: string): void {
  (g.window as EventTarget).dispatchEvent(Object.assign(new Event(type), { code, key: code, repeat: false, shiftKey: false, preventDefault() {} }));
}

/** A controller wired like GameClient wires it, with every command recorded. */
function rig(scheme: 'modern' | 'classic' = 'modern') {
  let t = 1000;
  let typing = false;
  const log: string[] = [];
  const presses: number[] = [];
  const el = canvas();
  const input = new InputController(el as unknown as HTMLElement, scheme, {
    toggleShop: () => log.push('shop'),
    scoreboard: (s) => log.push(`scoreboard:${s}`),
    openChat: () => log.push('chat'),
    escape: () => log.push('escape'),
    typing: () => typing,
  }, { now: () => t });
  input.onPress = (b) => presses.push(b);
  const cam = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 500);
  cam.position.set(0, 30, 18);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const self = { x: 5, z: 3 };
  return {
    input,
    el,
    log,
    presses,
    self,
    setTyping: (v: boolean) => void (typing = v),
    /** one client tick, in GameClient's order: aim, move, presses, press aim */
    tick(ms = 33) {
      t += ms;
      input.updateAim(cam, () => 1.2, 4.2, -1);
      const mv = input.moveDir(self.x, self.z);
      const b = input.takePressed();
      const pa = input.takePressAim();
      return { mv, b, pa, aim: { ...input.aim } };
    },
  };
}

beforeEach(() => {
  resetPadShared();
  pads = [];
});

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// ---------------------------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------------------------

test('button mapping: triggers, A/RB, D-pad, LB layer, Y shop, Start, View', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick(); // first sighting: baseline only
  const pressOf = (i: number) => {
    p.down(i);
    const out = r.tick();
    p.up(i);
    r.tick();
    return out.b;
  };
  assert.equal(pressOf(PadBtn.RT), Btn.Hook);
  assert.equal(pressOf(PadBtn.LT), Btn.Grapple);
  assert.equal(pressOf(PadBtn.A), Btn.Bash);
  assert.equal(pressOf(PadBtn.RB), Btn.Bash);
  assert.deepEqual([PadBtn.Left, PadBtn.Up, PadBtn.Right, PadBtn.Down].map(pressOf), [...BTN_ITEM]);
  // with LB held, X Y B A are items 1 to 4: no shop toggle and no Bash
  p.down(PadBtn.LB);
  r.tick();
  r.log.length = 0;
  assert.deepEqual([PadBtn.X, PadBtn.Y, PadBtn.B, PadBtn.A].map(pressOf), [...BTN_ITEM]);
  assert.deepEqual(r.log, []);
  p.up(PadBtn.LB);
  r.tick();
  // without LB: X and B do nothing, Y is the shop, Start the menu
  assert.equal(pressOf(PadBtn.X), 0);
  assert.equal(pressOf(PadBtn.B), 0);
  r.log.length = 0;
  pressOf(PadBtn.Y);
  pressOf(PadBtn.Start);
  assert.deepEqual(r.log, ['shop', 'escape']);
  // View shows the scoreboard while held
  r.log.length = 0;
  p.down(PadBtn.Back);
  r.tick();
  r.tick();
  p.up(PadBtn.Back);
  r.tick();
  assert.deepEqual(r.log, ['scoreboard:true', 'scoreboard:false']);
  r.input.dispose();
});

test('each ability press reaches onPress on its own (instant local feedback)', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick();
  p.down(PadBtn.RT).down(PadBtn.RB);
  const out = r.tick();
  assert.equal(out.b, Btn.Hook | Btn.Bash);
  assert.deepEqual(r.presses, [Btn.Hook, Btn.Bash]);
  r.input.dispose();
});

// ---------------------------------------------------------------------------------------------
// dead zones and the response curve
// ---------------------------------------------------------------------------------------------

test('radial dead zone: nothing inside, rescaled from the edge, full before the rim, direction kept', () => {
  assert.deepEqual(radial(0.1, 0.05, 0.15), { x: 0, y: 0, mag: 0 });
  const just = radial(0.16, 0, 0.15);
  assert.ok(just.mag > 0 && just.mag < 0.02, `just past the dead zone: ${just.mag}`);
  near(radial(STICK_OUTER, 0, 0.15).mag, 1);
  near(radial(1, 0, 0.15).mag, 1);
  const d = radial(0.5, -0.5, 0.15);
  near(Math.atan2(d.y, d.x), Math.atan2(-0.5, 0.5));
  near(d.mag, (Math.hypot(0.5, 0.5) - 0.15) / (STICK_OUTER - 0.15));
  // a radial zone: a diagonal push of the same length counts the same as a straight one
  near(radial(0.3, 0.3, 0.15).mag, radial(Math.hypot(0.3, 0.3), 0, 0.15).mag);
});

test('the move stick honours the dead zone setting and is analog', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick();
  p.stick(0.2, 0);
  assert.ok(r.tick().mv.x > 0, 'default dead zone 0.15: 0.2 walks');
  setPadConfig({ ...DEFAULT_PAD, deadzone: 0.25 });
  assert.deepEqual(r.tick().mv, { x: 0, z: 0 }, 'dead zone 0.25: 0.2 does not');
  p.stick(0, -1);
  const up = r.tick().mv;
  near(up.x, 0);
  near(up.z, -1); // stick up = up the screen = -z, like W
  p.stick(0.5, 0);
  const half = r.tick().mv.x;
  assert.ok(half > 0.3 && half < 0.5, `half push walks slower: ${half}`);
  r.input.dispose();
});

test('aim response curve: sensitivity bends it, both ends fixed', () => {
  near(aimGamma(0.5), 1.5);
  near(aimReach(0.5, 0.5), Math.pow(0.5, 1.5));
  assert.ok(aimReach(0.5, 1) > aimReach(0.5, 0.5) && aimReach(0.5, 0.5) > aimReach(0.5, 0));
  for (const s of [0, 0.5, 1]) {
    near(aimReach(0, s), 0);
    near(aimReach(1, s), 1);
  }
  near(aimDistance(0, 20), AIM_MIN);
  near(aimDistance(1, 20), 20);
});

test('settings: the controller fields are clamped and default when missing', () => {
  const s = parseSettings({ padDeadzone: 0.9, padAimSens: 7, padInvertY: true });
  assert.equal(s.padDeadzone, 0.5);
  assert.equal(s.padAimSens, 1);
  assert.equal(s.padInvertY, true);
  assert.equal(s.padEnabled, true);
  assert.deepEqual(padSettings({}), DEFAULT_PAD);
  assert.deepEqual(cleanPadConfig({ deadzone: Number.NaN }), DEFAULT_PAD);
  // saving hands the controller part to the pad reader at once
  saveSettings({ ...DEFAULT_SETTINGS, padEnabled: false, padDeadzone: 0.3 });
  assert.equal(padConfig().enabled, false);
  assert.equal(padConfig().deadzone, 0.3);
});

// ---------------------------------------------------------------------------------------------
// aim placement
// ---------------------------------------------------------------------------------------------

test('aim stick: in front of the unit, scaled by the push, up to the hook range', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick();
  r.input.hookRange = 20;
  p.stick(0, 0, 1, 0);
  let a = r.tick().aim;
  near(a.x, r.self.x + 20, 1e-9);
  near(a.z, r.self.z, 1e-9);
  assert.equal(r.input.aimDevice, 'pad');
  // half push, straight down the screen
  p.stick(0, 0, 0, 0.5);
  a = r.tick().aim;
  const want = aimDistance(aimReach(radial(0, 0.5, DEFAULT_PAD.deadzone).mag, DEFAULT_PAD.aimSens), 20);
  near(a.x, r.self.x, 1e-9);
  near(a.z - r.self.z, want, 1e-9);
  assert.ok(want > AIM_MIN && want < 20);
  // a touch just past the dead zone never aims at your feet
  p.stick(0, 0, 0.16, 0);
  a = r.tick().aim;
  assert.ok(a.x - r.self.x >= AIM_MIN - 1e-9, `min distance: ${a.x - r.self.x}`);
  // invert Y flips the aim stick only
  setPadConfig({ ...DEFAULT_PAD, invertY: true });
  p.stick(0, 0, 0, 1);
  a = r.tick().aim;
  near(a.z, r.self.z - 20, 1e-9);
  r.input.dispose();
});

test('aim stick: reach follows the HUD-noted hook range when GameClient does not set one', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick();
  p.stick(0, 0, -1, 0);
  near(r.tick().aim.x, r.self.x - HOOK_LEVELS.range[0], 1e-9); // base range before any HUD frame
  noteHookRange(24);
  near(r.tick().aim.x, r.self.x - 24, 1e-9);
  r.input.dispose();
});

test('aim stick: let go, the aim stays where it was (not where the spring-back passed), relative to the unit', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick();
  r.input.hookRange = 18;
  p.stick(0, 0, 0.7, -0.7); // full push up-right
  const held = r.tick().aim;
  const off = { x: held.x - r.self.x, z: held.z - r.self.z };
  near(Math.hypot(off.x, off.z), 18, 1e-9);
  // the stick springs back through a small push on its way to the centre
  p.stick(0, 0, 0.2, -0.2);
  r.tick(16);
  p.stick(0, 0, 0, 0);
  const released = r.tick(16).aim;
  near(released.x - r.self.x, off.x, 1e-9);
  near(released.z - r.self.z, off.z, 1e-9);
  // walking keeps the same aim in front of the unit
  r.self.x += 3;
  r.self.z -= 2;
  const walked = r.tick().aim;
  near(walked.x - r.self.x, off.x, 1e-9);
  near(walked.z - r.self.z, off.z, 1e-9);
  // and a press locks exactly that point
  p.down(PadBtn.RT);
  const shot = r.tick();
  assert.equal(shot.b, Btn.Hook);
  assert.deepEqual(shot.pa, walked);
  r.input.dispose();
});

test('aim before the aim stick is used: toward the river, then along the walk', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick();
  r.input.hookRange = 20;
  p.down(PadBtn.RT); // a pad-only player throws at once
  const first = r.tick();
  assert.equal(first.b, Btn.Hook);
  assert.ok(first.pa && first.pa.x < r.self.x, 'unit at x = 5 aims toward x = 0');
  p.up(PadBtn.RT).stick(0, 1); // walk down the screen
  const walk = r.tick().aim;
  near(walk.x, r.self.x, 1e-9);
  assert.ok(walk.z > r.self.z + AIM_MIN);
  r.input.dispose();
});

// ---------------------------------------------------------------------------------------------
// press edges
// ---------------------------------------------------------------------------------------------

test('press edges: one press per button down, however long it is held', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick();
  p.down(PadBtn.RT);
  const bits: number[] = [];
  for (let i = 0; i < 10; i++) bits.push(r.tick().b);
  assert.deepEqual(bits, [Btn.Hook, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  p.up(PadBtn.RT);
  r.tick();
  p.down(PadBtn.RT);
  assert.equal(r.tick().b, Btn.Hook);
  r.input.dispose();
});

test('press edges: the analog trigger has hysteresis (no chatter around one threshold)', () => {
  const reader = new PadReader(() => pads);
  const p = new FakePad();
  pads = [p];
  reader.poll(DEFAULT_PAD);
  const at = (v: number) => {
    p.set(PadBtn.RT, v);
    return reader.poll(DEFAULT_PAD).presses;
  };
  assert.deepEqual([0.6, 0.4, 0.6, 0.45, 0.2, 0.6].map(at), [Btn.Hook, 0, 0, 0, 0, Btn.Hook]);
});

test('typing: pad buttons are read but dropped, and a button held through it does not fire later', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick();
  r.setTyping(true);
  p.down(PadBtn.RT).stick(1, 0);
  const t1 = r.tick();
  assert.equal(t1.b, 0);
  assert.deepEqual(t1.mv, { x: 0, z: 0 });
  r.setTyping(false);
  assert.equal(r.tick().b, 0, 'RT went down while typing: no press when chat closes');
  r.input.dispose();
});

// ---------------------------------------------------------------------------------------------
// hot-plug
// ---------------------------------------------------------------------------------------------

test('hot-plug: a new pad is a baseline (held buttons never fire), unplugging lets go of everything', () => {
  const r = rig();
  assert.equal(r.tick().b, 0); // no pad at all
  const p = new FakePad(2);
  p.down(PadBtn.RT).down(PadBtn.Back).stick(1, 0);
  pads = [null, null, p];
  const first = r.tick();
  assert.equal(first.b, 0, 'RT held while plugging in');
  assert.ok(first.mv.x > 0.99, 'sticks work at once');
  assert.deepEqual(r.log, ['scoreboard:true']);
  assert.equal(r.input.aimDevice, 'pad');
  assert.equal(r.el.style.cursor, 'none');
  // unplugged mid-walk with View held: no more walking, scoreboard closes, mouse and key hints come back
  pads = [null, null, null];
  const gone = r.tick();
  assert.deepEqual(gone.mv, { x: 0, z: 0 });
  assert.deepEqual(r.log, ['scoreboard:true', 'scoreboard:false']);
  assert.equal(r.input.aimDevice, 'mouse');
  assert.equal(lastDevice(), 'kbm');
  assert.equal(r.el.style.cursor, '');
  // plugged back in at another index: works, again without phantom presses
  const q = new FakePad(0);
  q.down(PadBtn.A);
  pads = [q];
  assert.equal(r.tick().b, 0);
  q.up(PadBtn.A);
  r.tick();
  q.down(PadBtn.A);
  assert.equal(r.tick().b, Btn.Bash);
  // a disconnected entry (connected = false) counts as gone
  q.connected = false;
  q.stick(1, 0);
  assert.deepEqual(r.tick().mv, { x: 0, z: 0 });
  r.input.dispose();
});

test('hot-plug: with two pads, the one that last had a button go down is used', () => {
  const r = rig();
  const a = new FakePad(0, 'pad A');
  const b = new FakePad(1, 'pad B');
  pads = [a, b];
  r.tick();
  b.stick(0, 1);
  a.stick(-1, 0);
  assert.ok(r.tick().mv.x < -0.99, 'first pad by default');
  b.down(PadBtn.RT);
  const t = r.tick();
  assert.equal(t.b, Btn.Hook, 'the press that switches pads counts');
  assert.ok(t.mv.z > 0.99, 'and pad B now moves the unit');
  assert.equal(r.input.lastPad?.id, 'pad B');
  r.input.dispose();
});

test('the controller setting off: the pad is ignored', () => {
  setPadConfig({ ...DEFAULT_PAD, enabled: false });
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.tick();
  p.down(PadBtn.RT).stick(1, 0);
  const t = r.tick();
  assert.equal(t.b, 0);
  assert.deepEqual(t.mv, { x: 0, z: 0 });
  r.input.dispose();
});

// ---------------------------------------------------------------------------------------------
// mouse and pad at the same time
// ---------------------------------------------------------------------------------------------

test('mouse and pad: whichever was used last drives the aim; the keyboard keeps working', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.input.hookRange = 20;
  pointer(r.el, 'pointermove', 400, 300);
  const mouseAim = r.tick().aim;
  assert.equal(r.input.aimDevice, 'mouse');
  assert.ok(Math.abs(mouseAim.x) < 1 && Math.abs(mouseAim.z) < 3, `screen centre aims near the origin: ${JSON.stringify(mouseAim)}`);
  // the pad's aim stick takes over: updateAim no longer writes the cursor point, the cursor hides
  p.stick(0, 0, 1, 0);
  const padAim = r.tick().aim;
  assert.equal(r.input.aimDevice, 'pad');
  assert.equal(lastDevice(), 'pad');
  near(padAim.x, r.self.x + 20, 1e-9);
  assert.equal(r.el.style.cursor, 'none');
  // let go of the stick: the pad still aims
  p.stick(0, 0, 0, 0);
  near(r.tick().aim.x, r.self.x + 20, 1e-9);
  // a desk bump of the mouse does not take the aim back
  pointer(r.el, 'pointermove', 400 + MOUSE_TAKEOVER_PX - 2, 300);
  near(r.tick().aim.x, r.self.x + 20, 1e-9);
  assert.equal(r.input.aimDevice, 'pad');
  // a real mouse move does
  pointer(r.el, 'pointermove', 420, 300);
  const back = r.tick().aim;
  assert.equal(r.input.aimDevice, 'mouse');
  assert.equal(lastDevice(), 'kbm');
  assert.equal(r.el.style.cursor, '');
  assert.ok(Math.abs(back.x - (r.self.x + 20)) > 1, 'aim is the cursor point again');
  // any pad button hands it to the pad; a click takes it back at once (no threshold)
  p.down(PadBtn.RT);
  r.tick();
  assert.equal(r.input.aimDevice, 'pad');
  pointer(r.el, 'pointerdown', 420, 300, 0);
  assert.equal(r.input.aimDevice, 'mouse');
  // keyboard and pad together: held keys win the walk, the hint device follows the keyboard
  key('keydown', 'KeyD');
  p.stick(0, 1);
  const mv = r.tick().mv;
  near(mv.x, 1);
  near(mv.z, 0);
  assert.equal(lastDevice(), 'kbm');
  key('keyup', 'KeyD');
  assert.ok(r.tick().mv.z > 0.99, 'keys up: the stick walks');
  r.input.dispose();
});

test('mouse and pad: walking with the stick while aiming with the mouse keeps the mouse aim', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  pointer(r.el, 'pointermove', 400, 300);
  r.tick();
  p.stick(1, 0);
  r.tick();
  assert.equal(r.input.aimDevice, 'mouse');
  r.input.dispose();
});

test('classic scheme: the move stick overrides and drops the right-click destination', () => {
  const r = rig('classic');
  const p = new FakePad();
  pads = [p];
  r.tick();
  pointer(r.el, 'pointerdown', 600, 200, 2);
  assert.ok(r.input.destination, 'right-click set a destination');
  p.stick(-1, 0);
  const mv = r.tick().mv;
  near(mv.x, -1);
  assert.equal(r.input.destination, null);
  r.input.dispose();
});

// ---------------------------------------------------------------------------------------------
// checker pass: Start is the Esc key, drifting sticks, odd devices, hints after a pad match
// ---------------------------------------------------------------------------------------------

test('Start is the Esc key: a screen that catches Esc first (Settings, a dialog) gets it, and the hints stay on the pad', () => {
  // registered before the rig, like the Settings screen's capture listener that runs before the game's
  const seen: string[] = [];
  let swallow = true;
  const catcher = (e: Event) => {
    const k = e as KeyboardEvent;
    seen.push(`${k.key}/${k.code}`);
    if (swallow) e.stopImmediatePropagation();
  };
  (g.window as EventTarget).addEventListener('keydown', catcher, { capture: true });
  try {
    const r = rig();
    const p = new FakePad();
    pads = [p];
    r.tick();
    p.down(PadBtn.Start);
    r.tick();
    assert.deepEqual(seen, ['Escape/Escape'], 'the Settings screen saw an Escape keydown');
    assert.deepEqual(r.log, [], 'and the match menu did not toggle behind it');
    assert.equal(lastDevice(), 'pad', 'the HUD keeps the pad glyphs');
    // nothing catches it: it reaches the game, like the Esc key (menu, or closing the shop)
    swallow = false;
    p.up(PadBtn.Start);
    r.tick();
    p.down(PadBtn.Start);
    r.tick();
    assert.deepEqual(r.log, ['escape']);
    assert.equal(lastDevice(), 'pad');
    r.input.dispose();
  } finally {
    (g.window as EventTarget).removeEventListener('keydown', catcher, { capture: true });
  }
});

test('a drifting aim stick (resting past the dead zone) does not steal the aim back from the mouse; moving it does', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  r.input.hookRange = 20;
  pointer(r.el, 'pointermove', 400, 300);
  r.tick();
  p.stick(0, 0, 0.6, 0); // a real push: the pad aims
  r.tick();
  assert.equal(r.input.aimDevice, 'pad');
  p.stick(0, 0, 0.3, 0); // let go, and the worn stick rests at 0.3 (dead zone 0.15)
  r.tick();
  // the player moves the mouse: from now on the resting stick is not use
  pointer(r.el, 'pointermove', 420, 300);
  assert.equal(r.input.aimDevice, 'mouse');
  for (let i = 0; i < 5; i++) {
    p.stick(0, 0, 0.3 + (i % 2) * 0.02, 0.01 * i); // drift jitter
    r.tick();
    assert.equal(r.input.aimDevice, 'mouse', `tick ${i}: the mouse keeps the aim`);
    assert.equal(r.el.style.cursor, '');
  }
  // a real push of the stick takes the aim
  p.stick(0, 0, 0, -1);
  assert.ok(Math.hypot(0.3, 1) > STICK_WAKE);
  near(r.tick().aim.z, r.self.z - 20, 1e-9);
  assert.equal(r.input.aimDevice, 'pad');
  // after the centre, a light push is still not use (a stick at the dead-zone edge must never wake); a real one is
  pointer(r.el, 'pointermove', 460, 300);
  assert.equal(r.input.aimDevice, 'mouse');
  p.stick(0, 0, 0, 0);
  r.tick();
  p.stick(0, 0, 0.3, 0);
  r.tick();
  assert.equal(r.input.aimDevice, 'mouse');
  p.stick(0, 0, 0.6, 0);
  r.tick();
  assert.equal(r.input.aimDevice, 'pad');
  r.input.dispose();
});

test('a stick jittering at the dead-zone edge (0.14 / 0.16 against 0.15) never takes the aim or drops a classic destination', () => {
  const r = rig();
  const p = new FakePad();
  pads = [p];
  pointer(r.el, 'pointermove', 400, 300);
  r.tick();
  p.down(PadBtn.LB); // the pad was in use
  r.tick();
  p.up(PadBtn.LB);
  pointer(r.el, 'pointermove', 420, 300); // then the mouse took over
  assert.equal(r.input.aimDevice, 'mouse');
  for (let i = 0; i < 10; i++) {
    p.stick(0, 0, i % 2 ? 0.16 : 0.14, 0);
    r.tick();
    assert.equal(r.input.aimDevice, 'mouse', `aim tick ${i}`);
  }
  r.input.dispose();

  const c = rig('classic');
  const q = new FakePad();
  pads = [q];
  pointer(c.el, 'pointermove', 400, 300);
  c.tick();
  pointer(c.el, 'pointerdown', 600, 200, 2);
  const dest = c.input.destination;
  assert.ok(dest);
  for (let i = 0; i < 10; i++) {
    q.stick(i % 2 ? 0.16 : 0.14, 0);
    c.tick();
    assert.deepEqual(c.input.destination, dest, `classic tick ${i}`);
  }
  c.input.dispose();
});

test('classic: with no destination, a light push of the move stick still walks (analog)', () => {
  const r = rig('classic');
  const p = new FakePad();
  pads = [p];
  r.tick();
  p.stick(0.3, 0);
  const mv = r.tick().mv;
  assert.ok(mv.x > 0 && mv.x < 0.3, `light analog walk: ${mv.x}`);
  r.input.dispose();
});

test('classic: a drifting move stick does not drop the right-click destination; moving it does', () => {
  const r = rig('classic');
  const p = new FakePad();
  pads = [p];
  pointer(r.el, 'pointermove', 400, 300);
  p.stick(0.3, 0); // resting past the dead zone
  r.tick();
  pointer(r.el, 'pointerdown', 600, 200, 2);
  const dest = r.input.destination;
  assert.ok(dest, 'right-click set a destination');
  for (let i = 0; i < 5; i++) {
    const mv = r.tick().mv;
    assert.deepEqual(r.input.destination, dest, `tick ${i}: destination kept`);
    const d = Math.hypot(dest.x - r.self.x, dest.z - r.self.z);
    near(mv.x, (dest.x - r.self.x) / d);
    near(mv.z, (dest.z - r.self.z) / d);
  }
  p.stick(-1, 0);
  near(r.tick().mv.x, -1);
  assert.equal(r.input.destination, null, 'a real push takes over');
  r.input.dispose();
});

test('a non-standard device (wheel, flight stick, odd HID) is ignored until a button on it is pressed', () => {
  const r = rig();
  const odd = new FakePad(0, '046d-c29b-Racing Wheel');
  odd.mapping = '';
  odd.axes = [-1, 1.2857, -1, -1]; // axes resting off-centre, as such devices report them
  pads = [odd];
  for (let i = 0; i < 3; i++) {
    const t = r.tick();
    assert.deepEqual(t.mv, { x: 0, z: 0 }, 'the unit does not walk on its own');
    assert.equal(r.input.lastPad?.present, false);
  }
  assert.equal(r.input.aimDevice, 'mouse');
  assert.equal(r.el.style.cursor, '');
  odd.down(PadBtn.A);
  r.tick();
  assert.equal(r.input.lastPad?.present, true, 'pressed: the player chose it');
  r.input.dispose();
});

test('after a match played with the pad, real mouse travel puts the key hints back (a resting mouse does not)', () => {
  noteDevice('pad'); // the previous match ended on the pad; this match starts with a fresh controller
  const r = rig();
  pads = [];
  pointer(r.el, 'pointermove', 400, 300);
  pointer(r.el, 'pointermove', 400 + MOUSE_TAKEOVER_PX - 2, 300);
  assert.equal(lastDevice(), 'pad');
  pointer(r.el, 'pointermove', 420, 300);
  assert.equal(lastDevice(), 'kbm');
  r.input.dispose();
});
