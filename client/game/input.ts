// Keyboard and mouse input for both control schemes.
//   Modern:  WASD/arrows move, LMB Chain Hook, RMB or Q Grapple, Space or E Belly Bash, 1-4 items.
//   Classic: RMB click-to-move, Q Chain Hook, W Belly Bash, E Grapple, S stop, 1-4 items.
// Shared: B shop, Tab scoreboard, Enter chat, Esc menu.
import * as THREE from 'three';
import { Btn, BTN_ITEM, type ControlScheme } from '../../shared/types.ts';

export interface InputCommands {
  toggleShop(): void;
  scoreboard(show: boolean): void;
  openChat(team: boolean): void;
  escape(): void;
  /** true while a text box has focus: game keys are ignored */
  typing(): boolean;
}

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
  private listeners: [EventTarget, string, EventListener][] = [];

  constructor(el: HTMLElement, scheme: ControlScheme, cmd: InputCommands) {
    this.el = el;
    this.scheme = scheme;
    this.cmd = cmd;
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
  }

  private press(btn: number): void {
    this.pressed |= btn;
    this.onPress?.(btn);
  }

  private keyDown(e: KeyboardEvent): void {
    if (this.cmd.typing()) return;
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
  }

  private pointerDown(e: PointerEvent): void {
    this.pointerMove(e);
    if (this.cmd.typing()) return;
    if (this.scheme === 'modern') {
      if (e.button === 0) this.press(Btn.Hook);
      if (e.button === 2) this.press(Btn.Grapple);
    } else {
      if (e.button === 2) this.moveTarget = { x: this.aim.x, z: this.aim.z };
      if (e.button === 0) this.press(Btn.Hook);
    }
  }

  /** Project the mouse onto the ground plane at height y. */
  updateAim(camera: THREE.Camera, y: number): void {
    if (!this.hasMouse) return;
    this.plane.constant = -y;
    this.ray.setFromCamera(this.mouseNdc, camera);
    if (this.ray.ray.intersectPlane(this.plane, this.hit)) {
      this.aim.x = this.hit.x;
      this.aim.z = this.hit.z;
    }
  }

  /** Movement direction for this tick. Classic mode walks toward the last right-click. */
  moveDir(selfX: number, selfZ: number): { x: number; z: number } {
    if (this.cmd.typing()) return { x: 0, z: 0 };
    if (this.scheme === 'modern') {
      let x = 0;
      let z = 0;
      // camera looks toward -z with x to the right: W = -z (up on screen)
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
      const l = Math.hypot(x, z);
      return l > 0 ? { x: x / l, z: z / l } : { x: 0, z: 0 };
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

  /** Button presses since the last call. */
  takePressed(): number {
    const b = this.pressed;
    this.pressed = 0;
    return b;
  }
}
