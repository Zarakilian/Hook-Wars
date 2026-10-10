// Keyboard and mouse input for both control schemes.
//   Modern:  WASD/arrows move, LMB Chain Hook, RMB or Q Grapple, Space or E Belly Bash, 1-4 items.
//   Classic: RMB click-to-move, Q Chain Hook, W Belly Bash, E Grapple, S stop, 1-4 items.
// Shared: B shop, Tab scoreboard, Enter chat, Esc menu.
// Gamepad (gamepad.ts, both schemes): left stick move, right stick aim, RT Chain Hook, LT Grapple,
// A or RB Belly Bash, D-pad or LB + X/Y/B/A items 1-4, Y shop, View scoreboard, Start menu.
// Mouse, keyboard and pad all work at once. The aim follows whichever was used last: the mouse (a move
// of a few pixels, or a click) or the pad (the aim stick or any pad button). The pad is read from
// moveDir and takePressed; takePressed also runs while a solo match is paused, so Start still closes
// the menu. Start is the Esc key: it sends a keydown for Escape, so the Settings screen and open dialogs
// handle it exactly as they handle the key. A stick resting past the dead zone (drift) is not use: it
// takes the aim from the mouse, or overrides a classic right-click destination, only once it moves.
import * as THREE from 'three';
import { Btn, BTN_ITEM, type ControlScheme } from '../../shared/types.ts';
import { PadAim, PadReader, lastDevice, noteDevice, notedHookRange, padConfig, stickAwake, type GetPads, type PadPoll } from './gamepad.ts';

export interface InputCommands {
  toggleShop(): void;
  scoreboard(show: boolean): void;
  openChat(team: boolean): void;
  escape(): void;
  /** true while a text box has focus: game keys are ignored */
  typing(): boolean;
}

/** Test seams for the pad: the pad list and the clock (default: the browser's). */
export interface PadDeps {
  getPads?: GetPads;
  now?: () => number;
}

/** Mouse travel (pixels) that hands the aim back from the pad to the mouse: a desk bump does not. */
export const MOUSE_TAKEOVER_PX = 6;

export class InputController {
  scheme: ControlScheme;
  private keys = new Set<string>();
  private pressed = 0;
  private mouseNdc = new THREE.Vector2();
  private hasMouse = false;
  private moveTarget: { x: number; z: number } | null = null;
  private readonly el: HTMLElement;
  private readonly cmd: InputCommands;
  private readonly ray = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();
  /** last world-space aim point */
  readonly aim = { x: 0, z: 0 };
  /** called when a press happens (for instant local feedback) */
  onPress: ((btn: number) => void) | null = null;
  /**
   * Hook range for a full push of the aim stick. null = the range the HUD noted from its last frame
   * (else the base range). GameClient may set it every tick from YouSnap.hookRange.
   */
  hookRange: number | null = null;
  private listeners: [EventTarget, string, EventListener][] = [];

  // gamepad
  private readonly pad: PadReader;
  private readonly padAim = new PadAim();
  private readonly now: () => number;
  /** what drives the aim: the mouse cursor, or the pad's aim stick around the unit */
  private aimSource: 'mouse' | 'pad' = 'mouse';
  private padMove = { x: 0, z: 0, mag: 0 };
  /**
   * Where a stick "rests", for the wake rule (stickAwake): the aim stick's reading when the mouse last took
   * the aim, the move stick's when the last classic right-click destination was set. Back to the centre
   * when the stick is centred, so a stick jittering at the dead-zone edge never wakes; a real push does.
   */
  private aimRef = { x: 0, z: 0 };
  private moveRef = { x: 0, z: 0 };
  /** the keydown being handled is the pad's Start, not the keyboard */
  private padKey = false;
  private readonly self = { x: 0, z: 0, known: false };
  private lastClient: { x: number; y: number } | null = null;
  private mouseAnchor: { x: number; y: number } | null = null;
  /** the last pad reading (tests and the debug hooks look at it) */
  lastPad: PadPoll | null = null;

  constructor(el: HTMLElement, scheme: ControlScheme, cmd: InputCommands, padDeps: PadDeps = {}) {
    this.el = el;
    this.scheme = scheme;
    this.cmd = cmd;
    this.pad = new PadReader(padDeps.getPads);
    this.now = padDeps.now ?? (() => performance.now());
    this.on(window, 'keydown', (e) => this.keyDown(e as KeyboardEvent));
    this.on(window, 'keyup', (e) => this.keyUp(e as KeyboardEvent));
    this.on(window, 'blur', () => {
      this.keys.clear();
      this.cmd.scoreboard(false);
    });
    this.on(el, 'pointermove', (e) => this.pointerMove(e as PointerEvent));
    this.on(el, 'pointerdown', (e) => this.pointerDown(e as PointerEvent));
    this.on(el, 'contextmenu', (e) => e.preventDefault());
  }

  private on(t: EventTarget, type: string, fn: EventListener): void {
    t.addEventListener(type, fn);
    this.listeners.push([t, type, fn]);
  }

  dispose(): void {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.listeners = [];
    this.showCursor(true);
  }

  /** What drives the aim right now. */
  get aimDevice(): 'mouse' | 'pad' {
    return this.aimSource;
  }

  private press(btn: number): void {
    if (btn & (Btn.Hook | Btn.Grapple | Btn.Bash)) {
      // lock the aim at the moment of the press: the exact pixel under the cursor, or the pad's aim point
      if (this.aimSource === 'pad') this.applyPadAim();
      else this.reproject();
      this.pressAim = { x: this.aim.x, z: this.aim.z };
    }
    this.pressed |= btn;
    this.onPress?.(btn);
  }

  /** Aim captured at the last ability press, sent with the tick that carries the press. */
  private pressAim: { x: number; z: number } | null = null;

  peekPressAim(): { x: number; z: number } | null {
    return this.pressAim;
  }

  takePressAim(): { x: number; z: number } | null {
    const a = this.pressAim;
    this.pressAim = null;
    return a;
  }

  // camera and ground used by the last updateAim, so presses can re-project between ticks
  private aimCam: THREE.Camera | null = null;
  private aimHeight: ((x: number, z: number) => number) | null = null;
  private aimTop = 0;
  private aimBottom = 0;

  private reproject(): void {
    if (this.aimCam && this.aimHeight) this.updateAim(this.aimCam, this.aimHeight, this.aimTop, this.aimBottom);
  }

  private keyDown(e: KeyboardEvent): void {
    if (this.cmd.typing()) return;
    if (!this.padKey) noteDevice('kbm');
    const k = e.code;
    if (k === 'Tab') {
      e.preventDefault();
      this.cmd.scoreboard(true);
      return;
    }
    if (k === 'Escape') {
      this.cmd.escape();
      return;
    }
    if (k === 'Enter') {
      e.preventDefault();
      this.cmd.openChat(e.shiftKey);
      return;
    }
    if (k === 'KeyB') {
      this.cmd.toggleShop();
      return;
    }
    if (e.repeat) {
      this.keys.add(k);
      return;
    }
    this.keys.add(k);
    const item = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(k);
    if (item >= 0) this.press(BTN_ITEM[item]);
    if (this.scheme === 'modern') {
      if (k === 'Space') {
        e.preventDefault();
        this.press(Btn.Bash);
      }
      if (k === 'KeyE') this.press(Btn.Bash);
      if (k === 'KeyQ') this.press(Btn.Grapple);
    } else {
      if (k === 'KeyQ') this.press(Btn.Hook);
      if (k === 'KeyW') this.press(Btn.Bash);
      if (k === 'KeyE') this.press(Btn.Grapple);
      if (k === 'KeyS') this.moveTarget = null;
      if (k === 'Space') e.preventDefault();
    }
  }

  private keyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    if (e.code === 'Tab') this.cmd.scoreboard(false);
  }

  private pointerMove(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    this.mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.hasMouse = true;
    this.lastClient = { x: e.clientX, y: e.clientY };
    if (this.aimSource === 'pad' || lastDevice() === 'pad') {
      // the mouse takes the aim back once it really moves (a few pixels from where it rested); also the
      // key hints, when the last match was played with the pad
      if (!this.mouseAnchor) this.mouseAnchor = { x: e.clientX, y: e.clientY };
      else if (Math.hypot(e.clientX - this.mouseAnchor.x, e.clientY - this.mouseAnchor.y) >= MOUSE_TAKEOVER_PX) this.useMouse();
    }
  }

  private pointerDown(e: PointerEvent): void {
    this.pointerMove(e);
    if (this.cmd.typing()) return;
    this.useMouse(); // a click always aims with the mouse
    this.reproject(); // the click point, not where the cursor was on the previous tick
    if (this.scheme === 'modern') {
      if (e.button === 0) this.press(Btn.Hook);
      if (e.button === 2) this.press(Btn.Grapple);
    } else {
      if (e.button === 2) {
        this.moveTarget = { x: this.aim.x, z: this.aim.z };
        // a stick resting past the dead zone now must move before it overrides this destination
        this.moveRef = { x: this.padMove.x, z: this.padMove.z };
      }
      if (e.button === 0) this.press(Btn.Hook);
    }
  }

  /**
   * Find the ground point under the cursor. The ground is not flat (river bed, ice, water surface),
   * so march the cursor ray from the bank top down to the bed and stop where it meets height(x,z).
   * While the pad aims, this only remembers the camera and places the pad's aim point.
   */
  updateAim(camera: THREE.Camera, height: (x: number, z: number) => number, top: number, bottom: number, lift = 0.2): void {
    this.aimCam = camera;
    this.aimHeight = height;
    this.aimTop = top;
    this.aimBottom = bottom;
    if (this.aimSource === 'pad') {
      this.applyPadAim();
      return;
    }
    if (!this.hasMouse) return;
    this.ray.setFromCamera(this.mouseNdc, camera);
    const r = this.ray.ray;
    const flatHit = (y: number): THREE.Vector3 | null => {
      this.plane.constant = -y;
      return r.intersectPlane(this.plane, this.hit);
    };
    const fallback = () => {
      const p = flatHit(top - 3 + lift); // the bank top (callers pass top = bank + 3)
      if (p) {
        this.aim.x = p.x;
        this.aim.z = p.z;
      }
    };
    if (r.direction.y >= -1e-4) return fallback();
    const tA = (top + lift - r.origin.y) / r.direction.y;
    const tB = (bottom + lift - r.origin.y) / r.direction.y;
    if (tA < 0 || tB <= tA) return fallback();
    const at = (t: number) => ({ x: r.origin.x + r.direction.x * t, y: r.origin.y + r.direction.y * t, z: r.origin.z + r.direction.z * t });
    const above = (t: number) => {
      const p = at(t);
      return p.y > height(p.x, p.z) + lift;
    };
    if (!above(tA)) return fallback();
    const horiz = Math.hypot(r.direction.x, r.direction.z) || 1e-3;
    const dt = Math.min(0.25 / horiz, (tB - tA) / 4);
    let lo = tA;
    let hi = -1;
    for (let t = tA + dt; t <= tB + 1e-6; t += dt) {
      if (!above(t)) {
        hi = t;
        break;
      }
      lo = t;
    }
    if (hi < 0) return fallback();
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (above(mid)) lo = mid;
      else hi = mid;
    }
    const p = at(hi);
    this.aim.x = p.x;
    this.aim.z = p.z;
  }

  /**
   * Movement direction for this tick. Classic mode walks toward the last right-click. The pad's move
   * stick works in both schemes (analog: a light push walks slower); held movement keys win over it.
   */
  moveDir(selfX: number, selfZ: number): { x: number; z: number } {
    this.self.x = selfX;
    this.self.z = selfZ;
    this.self.known = true;
    this.pollPad();
    if (this.aimSource === 'pad') this.applyPadAim();
    if (this.cmd.typing()) return { x: 0, z: 0 };
    const pm = this.padMove;
    if (this.scheme === 'modern') {
      let x = 0;
      let z = 0;
      // camera looks toward -z with x to the right: W = -z (up on screen)
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
      const l = Math.hypot(x, z);
      if (l > 0) return { x: x / l, z: z / l };
      return { x: pm.x, z: pm.z };
    }
    // classic: the stick walks (analog) when there is no destination; it overrides (and drops) a
    // right-click destination only once it really moves
    if (pm.mag > 0 && (!this.moveTarget || stickAwake(pm, this.moveRef))) {
      this.moveTarget = null;
      return { x: pm.x, z: pm.z };
    }
    if (!this.moveTarget) return { x: 0, z: 0 };
    const dx = this.moveTarget.x - selfX;
    const dz = this.moveTarget.z - selfZ;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) {
      this.moveTarget = null;
      return { x: 0, z: 0 };
    }
    return { x: dx / d, z: dz / d };
  }

  /** Right-click destination in classic mode (for the move marker). */
  get destination(): { x: number; z: number } | null {
    return this.moveTarget;
  }

  clearDestination(): void {
    this.moveTarget = null;
  }

  /** Button presses since the last call. Also reads the pad, so its buttons work while paused. */
  takePressed(): number {
    this.pollPad();
    const b = this.pressed;
    this.pressed = 0;
    return b;
  }

  // ------------------------------------------------------------------------------------------
  // Gamepad
  // ------------------------------------------------------------------------------------------

  private pollPad(): void {
    const cfg = padConfig();
    const p = this.pad.poll(cfg);
    this.lastPad = p;
    // View let go (or the pad unplugged while it was held) always closes the scoreboard, even while typing
    if (p.scoreboard === false) this.cmd.scoreboard(false);
    if (!p.present) {
      // unplugged (or switched off in Settings): the mouse aims again, the cursor and key hints come back
      this.padMove = { x: 0, z: 0, mag: 0 };
      this.aimRef = { x: 0, z: 0 };
      this.moveRef = { x: 0, z: 0 };
      if (this.aimSource === 'pad') this.useMouse();
      return;
    }
    if (p.aim.mag === 0) this.aimRef = { x: 0, z: 0 };
    if (p.move.mag === 0) this.moveRef = { x: 0, z: 0 };
    if (this.cmd.typing()) {
      // read but thrown away while typing: the edge baseline stays current, so nothing fires later
      this.padMove = { x: 0, z: 0, mag: 0 };
      return;
    }
    this.padMove = { x: p.move.x, z: p.move.z, mag: p.move.mag };
    this.padAim.update(p.aim, p.move, cfg, this.now());
    // the aim stick (a real push, see aimRef) or a pad button hands the aim to the pad; the move stick
    // alone only does when the mouse has not been used in this match (walk with the stick, aim with the mouse)
    if (stickAwake(p.aim, this.aimRef) || p.edge || (p.move.mag > 0 && !this.hasMouse)) this.usePad();
    if (p.scoreboard === true) this.cmd.scoreboard(true);
    if (p.escape) this.padEscape();
    if (p.shop) this.cmd.toggleShop();
    // one press per ability, so each gets its own instant local feedback
    for (const bit of [Btn.Hook, Btn.Grapple, Btn.Bash, ...BTN_ITEM]) if (p.presses & bit) this.press(bit);
  }

  private usePad(): void {
    noteDevice('pad');
    if (this.aimSource === 'pad') return;
    this.aimSource = 'pad';
    this.mouseAnchor = this.lastClient;
    this.showCursor(false);
    this.applyPadAim();
  }

  private useMouse(): void {
    noteDevice('kbm');
    this.mouseAnchor = null;
    if (this.aimSource === 'mouse') return;
    this.aimSource = 'mouse';
    // an aim stick resting where it is now (drift) must move before it takes the aim back
    const a = this.lastPad?.present ? this.lastPad.aim : null;
    this.aimRef = a ? { x: a.x, z: a.z } : { x: 0, z: 0 };
    this.showCursor(true);
    this.reproject();
  }

  /** Start is the Esc key: the Settings screen and open dialogs catch it first, else keyDown sends cmd.escape(). */
  private padEscape(): void {
    const init = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
    const ev = typeof KeyboardEvent === 'function' ? new KeyboardEvent('keydown', init) : Object.assign(new Event('keydown', init), { key: 'Escape', code: 'Escape', repeat: false, shiftKey: false });
    this.padKey = true;
    try {
      window.dispatchEvent(ev);
    } finally {
      this.padKey = false;
    }
  }

  /** The pad's aim point around the unit. Before anything aimed: toward the river (x = 0). */
  private applyPadAim(): void {
    if (!this.self.known) return;
    const range = this.hookRange !== null && this.hookRange > 0 ? this.hookRange : notedHookRange();
    let off = this.padAim.offset(range);
    if (!off) {
      const d = range * 0.6;
      off = { x: this.self.x > 0 ? -d : d, z: 0 };
    }
    this.aim.x = this.self.x + off.x;
    this.aim.z = this.self.z + off.z;
  }

  /** The mouse cursor hides over the game while the pad aims. */
  private showCursor(on: boolean): void {
    const st = (this.el as { style?: CSSStyleDeclaration }).style;
    if (st) st.cursor = on ? '' : 'none';
  }
}
