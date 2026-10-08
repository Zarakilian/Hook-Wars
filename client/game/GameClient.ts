// One running match on the client: input -> session, snapshots -> interpolated views,
// events -> effects, audio and HUD. Owns every per-match render object.
import * as THREE from 'three';
import { BAL, TICK_DT } from '../../shared/constants.ts';
import { channelDepthAt } from '../../shared/maps/helpers.ts';
import { getMap } from '../../shared/maps/index.ts';
import type { MapDef } from '../../shared/maps/types.ts';
import { clamp, lerpAngle } from '../../shared/math.ts';
import type { MatchEnd } from '../../shared/protocol.ts';
import { hazardCycle } from '../../shared/sim/hazards.ts';
import { moversPresent } from '../../shared/sim/river.ts';
import {
  Btn, UFlag, UnitState, type GameEvent, type MatchConfig, type PlayerInfo, type ScoreRow, type Snapshot, type UnitSnap, type YouSnap,
} from '../../shared/types.ts';
import type { Frame } from '../net/interp.ts';
import { SnapshotBuffer } from '../net/interp.ts';
import { Predictor } from '../net/prediction.ts';
import type { MatchSession } from '../net/session.ts';
import {
  TEAM_COLORS, groundY, waterY, type AnimatedView, type AudioSystem, type ChainView, type DamageKind, type Engine, type FxSystem,
  type HazardView, type PudgyView, type WaterView, type WorldView,
} from '../render/contracts.ts';
import { createFx } from '../render/fx/fx.ts';
import { createHazardView, createMineView, createMoverView, createRuneView } from '../render/models/props.ts';
import { createPudgy, pudgyPalette } from '../render/models/pudgy.ts';
import { buildWorld } from '../render/world/terrain.ts';
import { createWater } from '../render/world/water.ts';
import type { Settings } from '../settings.ts';
import type { Hud, HudFrame } from '../ui/types.ts';
import { CameraRig } from './camera.ts';
import { InputController } from './input.ts';

export interface GameClientDeps {
  engine: Engine;
  audio: AudioSystem;
  hud: Hud;
  settings: Settings;
  canvas: HTMLCanvasElement;
  onEnd: (e: MatchEnd) => void;
  onEscape: () => void;
}

interface UnitView {
  pudgy: PudgyView;
  state: number;
  stateSince: number;
  x: number;
  z: number;
  y: number;
  face: number;
  speed: number;
  lastSeen: number;
  visible: boolean;
}

const HOOK_Y = 0.95;

export class GameClient {
  readonly session: MatchSession;
  readonly map: MapDef;
  readonly config: MatchConfig;
  private readonly deps: GameClientDeps;
  private readonly engine: Engine;
  private readonly players = new Map<number, PlayerInfo>();
  private readonly youId: number;
  private readonly world: WorldView;
  private readonly water: WaterView;
  private readonly fx: FxSystem;
  private readonly buffer: SnapshotBuffer;
  private readonly predictor: Predictor;
  private readonly input: InputController;
  private readonly cam: CameraRig;
  private readonly views = new Map<number, UnitView>();
  private readonly chains = new Map<number, ChainView>();
  private readonly runes = new Map<number, AnimatedView>();
  private readonly mines = new Map<number, THREE.Object3D>();
  private readonly movers: THREE.Object3D[] = [];
  private readonly hazards: HazardView[] = [];
  private readonly root = new THREE.Group();
  private readonly rangeRing: THREE.Mesh;
  private readonly aimLine: THREE.Line;
  private readonly destMarker: THREE.Mesh;
  private seq = 0;
  private tickAcc = 0;
  private last = -1;
  private time = 0;
  private you: YouSnap | null = null;
  private youAt = 0;
  private me: UnitSnap | null = null;
  private scoreboard: ScoreRow[] = [];
  private hitstop = 0;
  private fps = 60;
  private lastCountdown = -1;
  private predictedCastAt = -10;
  private lastBull = new Map<number, number>();
  private ended: MatchEnd | null = null;
  private frameRef: Frame | null = null;
  private hudFrame: HudFrame | null = null;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private disposed = false;
  private clockNow = 0;
  private wheelFn: (e: WheelEvent) => void;

  constructor(session: MatchSession, deps: GameClientDeps) {
    this.session = session;
    this.deps = deps;
    this.engine = deps.engine;
    this.config = session.start.config;
    this.map = getMap(this.config.mapId);
    this.youId = session.start.you;
    for (const p of session.start.players) this.players.set(p.id, p);

    this.engine.setAtmosphere(this.map, this.config);
    this.world = buildWorld(this.map, this.config, session.start.hazards, this.engine);
    this.root.add(this.world.group);
    this.water = createWater(this.map, this.config, this.engine, this.world);
    this.root.add(this.water.group);
    this.fx = createFx(this.engine, this.engine.quality);
    this.engine.scene.add(this.root);

    for (const m of this.map.movers) {
      const v = createMoverView(m, this.map);
      this.movers.push(v);
      this.root.add(v);
    }
    for (const hz of session.start.hazards) {
      const v = createHazardView(hz, this.map);
      v.root.position.set(hz.x, this.world.groundHeight(hz.x, hz.z), hz.z);
      this.hazards.push(v);
      this.root.add(v.root);
    }

    // aiming helpers
    this.rangeRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }));
    this.rangeRing.rotation.x = -Math.PI / 2;
    this.rangeRing.renderOrder = 5;
    this.aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.55 }));
    this.aimLine.frustumCulled = false;
    this.destMarker = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 24), new THREE.MeshBasicMaterial({ color: 0x9fff7f, transparent: true, opacity: 0.8 }));
    this.destMarker.rotation.x = -Math.PI / 2;
    this.root.add(this.rangeRing, this.aimLine, this.destMarker);

    this.buffer = new SnapshotBuffer(session.local);
    this.predictor = new Predictor(this.map);
    this.cam = new CameraRig(this.engine.camera);
    this.cam.shakeScale = deps.settings.shake;
    const spawn = this.players.get(this.youId);
    const sp = spawn ? this.map.spawns[spawn.team][0] : { x: 0, z: 0 };
    this.cam.snapTo(sp.x, groundY(this.map), sp.z);

    this.input = new InputController(deps.canvas, deps.settings.controls, {
      toggleShop: () => deps.hud.toggleShop(),
      scoreboard: (s) => deps.hud.scoreboard(s),
      openChat: (team) => deps.hud.openChat(team),
      escape: () => {
        if (deps.hud.shopOpen()) deps.hud.toggleShop(false);
        else deps.onEscape();
      },
      typing: () => deps.hud.typing(),
    });
    this.input.onPress = (btn) => this.localPress(btn);
    this.wheelFn = (e: WheelEvent) => this.cam.wheel(e.deltaY);
    deps.canvas.addEventListener('wheel', this.wheelFn, { passive: true });

    session.onSnapshot = (s) => this.onSnapshot(s);
    session.onPlayers = (list) => {
      for (const p of list) this.players.set(p.id, p);
    };
    session.onEnd = (e) => {
      this.ended = e;
      deps.onEnd(e);
    };
    deps.audio.setAmbience(this.map, null);
    deps.audio.setMusic('match');
    deps.hud.show();
  }

  // ------------------------------------------------------------------------------------------
  // Network in
  // ------------------------------------------------------------------------------------------

  private onSnapshot(s: Snapshot): void {
    // local snapshots arrive inside frame(now), so use the frame clock; online ones arrive whenever
    const now = this.session.local ? this.clockNow : performance.now();
    this.buffer.push(s, now);
    if (s.sb) this.scoreboard = s.sb;
    if (s.you) {
      this.you = s.you;
      this.youAt = now;
      const me = s.u.find((u) => u.i === s.you!.id);
      if (me) {
        this.me = me;
        this.predictor.reconcile(me, s.you, s.w, s.mc, moversPresent(s.w, this.config));
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Input out
  // ------------------------------------------------------------------------------------------

  /** Instant local feedback the moment a button goes down (the server confirms later). */
  private localPress(btn: number): void {
    this.deps.audio.unlock();
    const you = this.you;
    const me = this.me;
    if (!you || !me || me.st !== UnitState.Alive) return;
    const elapsed = (performance.now() - this.youAt) / 1000;
    const v = this.views.get(this.youId);
    if (btn & Btn.Hook && you.cd[0] - elapsed <= 0.03) {
      this.predictor.rootFor(BAL.hookWindup);
      v?.pudgy.play('throw');
      this.deps.audio.play('hookThrow', { family: this.players.get(this.youId)?.family });
      this.predictedCastAt = this.time;
    } else if (btn & Btn.Bash && you.cd[2] - elapsed <= 0.03) {
      this.predictor.rootFor(BAL.bashWindup);
      v?.pudgy.play('bash');
      this.predictedCastAt = this.time;
    } else if (btn & Btn.Grapple && you.cd[1] - elapsed <= 0.03) {
      this.predictor.rootFor(BAL.grappleWindup);
      v?.pudgy.play('grapple');
      this.deps.audio.play('grappleThrow');
      this.predictedCastAt = this.time;
    }
  }

  private localTick(): void {
    if (this.youId < 0) return;
    this.input.updateAim(this.engine.camera, groundY(this.map) + 0.2);
    const b = this.predictor.body;
    const mv = this.input.moveDir(b.x, b.z);
    const inp = { seq: ++this.seq, mx: mv.x, mz: mv.z, ax: this.input.aim.x, az: this.input.aim.z, b: this.input.takePressed() };
    this.session.sendInput(inp);
    this.predictor.apply(inp);
  }

  // ------------------------------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------------------------------

  frame(now: number): void {
    if (this.disposed) return;
    if (this.last >= 0 && now < this.last) return; // ignore out-of-order frame times
    this.clockNow = now;
    if (this.last < 0) this.last = now;
    const dtMs = clamp(now - this.last, 0, 100);
    this.last = now;
    const dt = dtMs / 1000;
    this.time += dt;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;

    this.session.pump(now);
    this.tickAcc += dt;
    let n = 0;
    while (this.tickAcc >= TICK_DT && n < 5) {
      this.tickAcc -= TICK_DT;
      this.localTick();
      n++;
    }
    if (n === 5) this.tickAcc = 0;
    const alpha = this.tickAcc / TICK_DT;

    const renderTick = this.buffer.advance(now, dtMs);
    const f = this.buffer.sample(renderTick);
    if (!f) {
      this.engine.update(dt, this.time, this.cam.focusPoint.x, this.cam.focusPoint.z);
      this.engine.render();
      return;
    }
    this.frameRef = f;
    const snap = f.newer;
    const river = snap.w;

    // visual time scale for hit-stop
    let vdt = dt;
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      vdt = dt * 0.08;
    }

    this.updateUnits(f, vdt, alpha, dt);
    this.updateHooks(f, vdt);
    this.updateRunes(f, vdt);
    this.updateMines(snap);
    this.updateMovers(snap, renderTick);
    this.updateHazards(snap, renderTick);
    this.updateHelpers();

    // camera follows the (predicted) local unit, or the action when spectating
    const meView = this.views.get(this.youId);
    let fx = this.cam.focusPoint.x;
    let fz = this.cam.focusPoint.z;
    if (meView && this.me && this.me.st !== UnitState.Dead) {
      fx = meView.x;
      fz = meView.z;
    } else if (this.youId < 0 && f.units.size) {
      let sx = 0;
      let sz = 0;
      for (const u of f.units.values()) {
        sx += u.x;
        sz += u.z;
      }
      fx = sx / f.units.size;
      fz = sz / f.units.size;
    }
    this.cam.update(dt, fx, groundY(this.map), fz, this.input.aim.x, this.input.aim.z);

    // HUD data is built after the camera moves so overhead bars track exactly
    const hudFrame = this.buildHudFrame(snap);
    this.hudFrame = hudFrame;
    const evs: { tick: number; ev: GameEvent }[] = [];
    this.buffer.takeEvents(renderTick, evs);
    for (const { ev } of evs) this.handleEvent(ev, hudFrame);
    this.countdownBeeps(snap);

    this.world.update(vdt, this.time, river);
    this.water.update(vdt, this.time, river, this.engine.camera);
    this.fx.update(vdt, this.time, this.engine.camera);
    this.deps.audio.setListener(fx, fz);
    this.deps.audio.update(dt);
    this.deps.hud.frame(hudFrame);
    this.engine.update(dt, this.time, fx, fz);
    this.engine.render();
  }

  private baseY(x: number, z: number): number {
    const snap = this.frameRef?.newer;
    const gh = this.world.groundHeight(x, z);
    if (!snap) return gh;
    if (channelDepthAt(this.map, x, z) > 0) {
      if (snap.w.frozen) return waterY(this.map, 1) + 0.04;
      if (snap.w.deep) return Math.max(gh, this.water.surfaceHeight(x, z) - 0.25);
    }
    return gh;
  }

  private updateUnits(f: Frame, vdt: number, alpha: number, dt: number): void {
    const hooked = new Set<number>();
    for (const h of f.hooks) if (h.tg >= 0) hooked.add(h.tg);
    const hookOwners = new Set<number>();
    for (const h of f.hooks) hookOwners.add(h.o);
    const units = new Map(f.units);
    // the local unit is drawn where prediction says it is
    const meSnap = this.me;
    for (const [id, u] of units) {
      let v = this.views.get(id);
      const info = this.players.get(id);
      if (!info) continue;
      if (!v) {
        const pudgy = createPudgy({ family: info.family, cosmetics: info.cosmetics, team: info.team, name: info.name, isLocal: id === this.youId, quality: this.engine.quality });
        this.root.add(pudgy.root);
        v = { pudgy, state: u.st, stateSince: this.time, x: u.x, z: u.z, y: 0, face: u.f, speed: 0, lastSeen: this.time, visible: true };
        this.views.set(id, v);
      }
      v.lastSeen = this.time;
      let x = u.x;
      let z = u.z;
      let st: number = u.st;
      if (id === this.youId && this.predictor.active && meSnap && meSnap.st !== UnitState.Dead) {
        const p = { x: 0, z: 0 };
        this.predictor.renderPos(alpha, dt, p);
        x = p.x;
        z = p.z;
      }
      if (st === UnitState.Dead && hooked.has(id)) st = UnitState.Hooked; // corpse being reeled in
      if (st !== v.state) {
        v.state = st;
        v.stateSince = this.time;
      }
      const moved = Math.hypot(x - v.x, z - v.z);
      const inst = dt > 0 ? moved / dt : 0;
      v.speed = v.speed * 0.8 + Math.min(inst, 20) * 0.2;
      // facing: own unit looks where it aims unless running
      let face = u.f;
      if (id === this.youId && (st === UnitState.Alive || st === UnitState.Casting)) {
        const aimFace = Math.atan2(this.input.aim.x - x, this.input.aim.z - z);
        const b = this.predictor.body;
        const running = b.vx * b.vx + b.vz * b.vz > 1;
        face = st === UnitState.Casting || !running ? aimFace : Math.atan2(b.vx, b.vz);
      }
      v.face = lerpAngle(v.face, face, 1 - Math.exp(-dt * 18));
      v.x = x;
      v.z = z;
      v.y = this.baseY(x, z) + u.y;
      v.pudgy.root.position.set(x, v.y, z);
      v.pudgy.root.rotation.y = v.face;
      const showDead = u.st === UnitState.Dead && !hooked.has(id);
      v.pudgy.root.visible = !showDead;
      v.visible = !showDead;
      const ally = info.team === this.players.get(this.youId)?.team;
      v.pudgy.setOpacity(u.fl & UFlag.Stealth && ally ? 0.4 : 1);
      v.pudgy.update(vdt, {
        state: st as UnitSnap['st'],
        castKind: u.ck,
        speed: v.speed,
        hpFrac: u.mhp > 0 ? u.hp / u.mhp : 0,
        flags: u.fl,
        hookOut: hookOwners.has(id),
        stateTime: this.time - v.stateSince,
        time: this.time,
      });
    }
    // hide units we can no longer see; drop long-gone ones
    for (const [id, v] of this.views) {
      if (units.has(id)) continue;
      v.pudgy.root.visible = false;
      v.visible = false;
      if (this.time - v.lastSeen > 20 && !this.players.has(id)) {
        this.root.remove(v.pudgy.root);
        v.pudgy.dispose();
        this.views.delete(id);
      }
    }
  }

  private updateHooks(f: Frame, vdt: number): void {
    const seen = new Set<number>();
    const y = groundY(this.map) + HOOK_Y;
    for (const h of f.hooks) {
      seen.add(h.i);
      let c = this.chains.get(h.i);
      const owner = this.players.get(h.o);
      if (!c) {
        c = this.fx.createChain(h.k, owner?.family ?? 'brawler', owner?.team ?? 0, h.fx);
        this.chains.set(h.i, c);
      }
      const pts: THREE.Vector3[] = [];
      const ov = this.views.get(h.o);
      if (ov && ov.visible) pts.push(ov.pudgy.getHandWorld(new THREE.Vector3()));
      for (let i = 0; i + 1 < h.pts.length; i += 2) pts.push(new THREE.Vector3(h.pts[i], y, h.pts[i + 1]));
      let hx = h.x;
      let hz = h.z;
      if (h.p === 2) {
        // grapple anchor sticks to what it hit
        hx = h.x;
        hz = h.z;
      }
      pts.push(new THREE.Vector3(hx, y, hz));
      if (pts.length < 2) pts.unshift(pts[0].clone());
      c.setVisible(true);
      c.update(pts, vdt, { retracting: h.p === 1, carrying: h.tg >= 0 || h.ru >= 0, time: this.time });
    }
    for (const [id, c] of this.chains) {
      if (seen.has(id)) continue;
      c.dispose();
      this.chains.delete(id);
    }
  }

  private updateRunes(f: Frame, vdt: number): void {
    const seen = new Set<number>();
    for (const r of f.runes) {
      seen.add(r.i);
      let v = this.runes.get(r.i);
      if (!v) {
        v = createRuneView(r.t);
        this.runes.set(r.i, v);
        this.root.add(v.root);
      }
      const base = r.d ? groundY(this.map) + 0.3 : Math.max(this.world.groundHeight(r.x, r.z), this.water.surfaceHeight(r.x, r.z));
      v.root.position.set(r.x, base, r.z);
      v.update(vdt, this.time);
    }
    for (const [id, v] of this.runes) {
      if (seen.has(id)) continue;
      this.root.remove(v.root);
      v.dispose();
      this.runes.delete(id);
    }
  }

  private updateMines(snap: Snapshot): void {
    const seen = new Set<number>();
    for (const m of snap.m) {
      seen.add(m.i);
      let v = this.mines.get(m.i);
      if (!v) {
        v = createMineView(m.o === this.youId);
        this.mines.set(m.i, v);
        this.root.add(v);
      }
      v.position.set(m.x, this.world.groundHeight(m.x, m.z), m.z);
      v.visible = true;
      v.scale.setScalar(m.a ? 1 : 0.7);
    }
    for (const [id, v] of this.mines) {
      if (seen.has(id)) continue;
      this.root.remove(v);
      this.mines.delete(id);
    }
  }

  private updateMovers(snap: Snapshot, renderTick: number): void {
    const w = this.predictor.world;
    const present = moversPresent(snap.w, this.config);
    const floating = present && !snap.w.frozen && snap.w.level > 0.5;
    const mc = snap.mc - (floating ? (snap.t - renderTick) * TICK_DT : 0);
    w.updateMovers(mc, present);
    for (let i = 0; i < this.movers.length; i++) {
      const p = w.moverPoses[i];
      const v = this.movers[i];
      v.visible = present;
      if (!present) continue;
      const wy = snap.w.frozen ? waterY(this.map, 1) : this.water.surfaceHeight(p.x, p.z);
      v.position.set(p.x, Number.isFinite(wy) ? wy : waterY(this.map, snap.w.level), p.z);
      v.rotation.y = Math.atan2(p.bx - p.ax, p.bz - p.az) || 0;
      if (floating) {
        v.rotation.z = Math.sin(this.time * 1.3 + i) * 0.04;
        v.rotation.x = Math.sin(this.time * 1.1 + i * 2) * 0.03;
      }
    }
  }

  private updateHazards(snap: Snapshot, renderTick: number): void {
    const mt = Math.max(0, snap.mt - (snap.t - renderTick) * TICK_DT);
    const hz = this.session.start.hazards;
    for (let i = 0; i < hz.length; i++) {
      const h = hz[i];
      const active = !h.channel || !snap.w.deep;
      this.hazards[i].update(1 / 60, this.time, hazardCycle(h, mt), active);
      this.hazards[i].root.position.y = this.world.groundHeight(h.x, h.z);
    }
  }

  private updateHelpers(): void {
    const v = this.views.get(this.youId);
    const show = !!(v && v.visible && this.me && this.me.st !== UnitState.Dead && this.deps.settings.showRange);
    this.rangeRing.visible = show;
    this.aimLine.visible = show;
    if (show && v && this.you) {
      const r = this.you.hookRange + 0.75;
      const y = v.y + 0.06;
      this.rangeRing.position.set(v.x, y, v.z);
      this.rangeRing.scale.setScalar(r);
      const dx = this.input.aim.x - v.x;
      const dz = this.input.aim.z - v.z;
      const l = Math.hypot(dx, dz) || 1;
      const len = Math.min(l, r);
      const pos = this.aimLine.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, v.x + (dx / l) * 0.9, y + 0.9, v.z + (dz / l) * 0.9);
      pos.setXYZ(1, v.x + (dx / l) * len, y + 0.9, v.z + (dz / l) * len);
      pos.needsUpdate = true;
      (this.rangeRing.material as THREE.MeshBasicMaterial).opacity = this.you.cd[0] > 0 ? 0.08 : 0.2;
    }
    const d = this.input.destination;
    this.destMarker.visible = !!d && this.deps.settings.controls === 'classic';
    if (d) this.destMarker.position.set(d.x, this.world.groundHeight(d.x, d.z) + 0.05, d.z);
  }

  // ------------------------------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------------------------------

  private p3(x: number, z: number, up = 1): THREE.Vector3 {
    return new THREE.Vector3(x, this.baseY(x, z) + up, z);
  }

  private unitPos(id: number, up = 1): THREE.Vector3 | null {
    const v = this.views.get(id);
    return v ? new THREE.Vector3(v.x, v.y + up, v.z) : null;
  }

  private nearMe(x: number, z: number, r: number): number {
    const v = this.views.get(this.youId);
    if (!v) return 0;
    const d = Math.hypot(v.x - x, v.z - z);
    return d < r ? 1 - d / r : 0;
  }

  private handleEvent(ev: GameEvent, hf: HudFrame): void {
    const a = this.deps.audio;
    const me = this.youId;
    switch (ev.e) {
      case 'cast': {
        if (ev.u === me && this.time - this.predictedCastAt < 0.6) break;
        const v = this.views.get(ev.u);
        if (ev.k === 'hook') v?.pudgy.play('throw');
        else if (ev.k === 'bash') v?.pudgy.play('bash');
        else if (ev.k === 'grapple') v?.pudgy.play('grapple');
        else if (ev.k === 'melee') {
          v?.pudgy.play('melee');
        }
        break;
      }
      case 'hookLaunch':
        if (ev.u !== me) a.play(ev.k === 1 ? 'grappleThrow' : 'hookThrow', { x: ev.x, z: ev.z, family: this.players.get(ev.u)?.family });
        break;
      case 'hookHit': {
        const p = this.unitPos(ev.tg, 1) ?? this.p3(ev.x, ev.z);
        this.fx.hookHit(p, ev.bull, ev.ally);
        a.play(ev.ally ? 'hookHitAlly' : ev.bull ? 'bullseye' : 'hookHit', { x: ev.x, z: ev.z });
        if (ev.bull) this.lastBull.set(ev.tg, this.time);
        this.views.get(ev.tg)?.pudgy.play('hit');
        if (ev.u === me || ev.tg === me) {
          this.cam.shake(ev.bull ? 0.5 : 0.32);
          this.hitstop = ev.bull ? 0.09 : 0.06;
        }
        break;
      }
      case 'hookWall':
        this.fx.hookWall(this.p3(ev.x, ev.z, HOOK_Y));
        a.play('hookWall', { x: ev.x, z: ev.z });
        break;
      case 'hookBounce':
        this.fx.hookBounce(this.p3(ev.x, ev.z, HOOK_Y));
        a.play('hookBounce', { x: ev.x, z: ev.z });
        break;
      case 'hookClash':
        this.fx.hookClash(this.p3(ev.x, ev.z, HOOK_Y));
        a.play('hookClash', { x: ev.x, z: ev.z });
        this.cam.shake(0.25 * this.nearMe(ev.x, ev.z, 25));
        break;
      case 'hookDone':
        if (ev.tg >= 0) a.play('hookReturn', { x: ev.x, z: ev.z });
        break;
      case 'hookBreak':
        a.play('hookBreak', { x: ev.x, z: ev.z });
        break;
      case 'grappleHit':
        a.play('grappleLatch', { x: ev.x, z: ev.z });
        this.fx.hookWall(this.p3(ev.x, ev.z, HOOK_Y));
        break;
      case 'grappleLand':
        a.play('grappleLand', { x: ev.x, z: ev.z });
        break;
      case 'bash': {
        this.fx.bash(this.p3(ev.x, ev.z, 0.6), ev.dx, ev.dz);
        a.play('bash', { x: ev.x, z: ev.z });
        if (ev.u === me && ev.hits.length) this.hitstop = 0.05;
        if (ev.hits.includes(me)) this.cam.shake(0.45);
        break;
      }
      case 'melee': {
        const p = this.unitPos(ev.tg, 1.1);
        if (p) this.fx.melee(p);
        a.play('melee', { x: p?.x, z: p?.z });
        break;
      }
      case 'dmg': {
        const p = this.unitPos(ev.tg, 2.2);
        if (!p) break;
        const mine = ev.tg === me || ev.src === me;
        const crit = ev.kind === 'hook' && (this.lastBull.get(ev.tg) ?? -10) > this.time - 0.3;
        this.fx.damageNumber(p, ev.amt, ev.kind as DamageKind, mine, crit);
        if (ev.tg === me && ev.kind !== 'burn' && ev.kind !== 'fountain' && ev.kind !== 'hazard') a.play('hurt');
        break;
      }
      case 'kill':
        a.play('death', { x: ev.x, z: ev.z });
        if (ev.k === me) {
          this.cam.shake(0.2);
          this.views.get(me)?.pudgy.play('celebrate');
        }
        break;
      case 'corpse': {
        const info = this.players.get(ev.v);
        if (info) this.fx.corpseBurst(this.p3(ev.x, ev.z, 0.8), pudgyPalette(info.family, info.cosmetics, info.team));
        a.play('corpse', { x: ev.x, z: ev.z });
        this.cam.shake(0.3 * this.nearMe(ev.x, ev.z, 14));
        break;
      }
      case 'respawn': {
        const info = this.players.get(ev.u);
        this.fx.respawn(this.p3(ev.x, ev.z, 0.2), info?.team ?? 0);
        this.views.get(ev.u)?.pudgy.play('spawn');
        if (ev.u === me) a.play('respawn');
        break;
      }
      case 'drownStart':
        a.play('drown', { x: ev.x, z: ev.z });
        this.fx.drownBubbles(this.p3(ev.x, ev.z, 0));
        break;
      case 'drownSave':
        a.play('drownSave');
        break;
      case 'splash': {
        const p = this.p3(ev.x, ev.z, 0);
        const wy = this.water.surfaceHeight(ev.x, ev.z);
        if (Number.isFinite(wy)) p.y = wy;
        this.fx.splash(p, ev.s);
        this.water.disturb(ev.x, ev.z, ev.s);
        a.play('splash', { x: ev.x, z: ev.z });
        break;
      }
      case 'runeSpawn':
        a.play('runeSpawn', { x: ev.x, z: ev.z });
        break;
      case 'rune': {
        const p = this.unitPos(ev.u, 1.2);
        if (p) this.fx.runePickup(p, ev.t);
        a.play('rune', { x: p?.x, z: p?.z });
        break;
      }
      case 'mineArm':
        a.play('mineArm', { x: ev.x, z: ev.z, volume: 0.6 });
        break;
      case 'mineBoom':
        this.fx.mineBoom(this.p3(ev.x, ev.z, 0.3));
        a.play('mineBoom', { x: ev.x, z: ev.z });
        this.cam.shake(0.6 * this.nearMe(ev.x, ev.z, 18));
        break;
      case 'buy':
        if (ev.u === me) a.play('buy');
        break;
      case 'useItem':
        if (ev.item === 'pie') a.play('pie', { x: ev.x, z: ev.z });
        else if (ev.item === 'puffball') a.play('puff', { x: ev.x, z: ev.z });
        break;
      case 'tide':
        if (ev.phase === 'rising' || ev.phase === 'freezing') a.play('tideHorn');
        if (ev.phase === 'cracking') a.play('iceCrack');
        break;
      case 'hazard': {
        const h = this.session.start.hazards[ev.h];
        if (h) this.fx.hazardBurst(this.p3(ev.x, ev.z, 0.2), h.kind);
        a.play('hazardBurst', { x: ev.x, z: ev.z });
        break;
      }
      case 'announce':
        a.announce(ev.key);
        break;
      case 'phase':
        if (ev.ph === 'playing') {
          a.play('go');
          a.announce('go');
        }
        break;
      case 'end': {
        const team = this.players.get(me)?.team;
        a.setMusic(team === undefined ? 'victory' : ev.winner === team ? 'victory' : 'defeat');
        a.play(team !== undefined && ev.winner === team ? 'victory' : 'defeat');
        break;
      }
      default:
        break;
    }
    this.deps.hud.event(ev, hf);
  }

  private countdownBeeps(snap: Snapshot): void {
    if (snap.ph !== 'countdown') return;
    const c = Math.ceil(snap.cd);
    if (c !== this.lastCountdown && c > 0 && c <= 3) {
      this.deps.audio.play('countdown');
      this.deps.audio.announce(c === 3 ? 'countdown3' : c === 2 ? 'countdown2' : 'countdown1');
    }
    this.lastCountdown = c;
  }

  private readonly ndc = new THREE.Vector3();
  private readonly viewRay = new THREE.Raycaster();
  private readonly viewPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  /** Screen anchors above heads and the camera's ground footprint, for HUD overlays. */
  private projectForHud(): { screen: HudFrame['screen']; view: [number, number][] } {
    const cam = this.engine.camera;
    const w = this.deps.canvas.clientWidth || window.innerWidth;
    const hgt = this.deps.canvas.clientHeight || window.innerHeight;
    const screen: HudFrame['screen'] = new Map();
    for (const [id, v] of this.views) {
      if (!v.visible) continue;
      this.ndc.set(v.x, v.y + 2.75, v.z).project(cam);
      const on = this.ndc.z < 1 && Math.abs(this.ndc.x) < 1.1 && Math.abs(this.ndc.y) < 1.1;
      screen.set(id, { x: ((this.ndc.x + 1) / 2) * w, y: ((1 - this.ndc.y) / 2) * hgt, onScreen: on });
    }
    const view: [number, number][] = [];
    this.viewPlane.constant = -groundY(this.map);
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      this.viewRay.setFromCamera(new THREE.Vector2(nx, ny), cam);
      const hit = this.viewRay.ray.intersectPlane(this.viewPlane, this.tmpV);
      if (hit) view.push([hit.x, hit.z]);
    }
    return { screen, view };
  }

  private buildHudFrame(snap: Snapshot): HudFrame {
    const f = this.frameRef!;
    const proj = this.projectForHud();
    return {
      screen: proj.screen,
      view: proj.view,
      map: this.map,
      config: this.config,
      hazards: this.session.start.hazards,
      players: this.players,
      units: f.units,
      youId: this.youId,
      you: this.you,
      me: this.me,
      score: snap.s,
      timeLeft: snap.tl,
      overtime: snap.ot === 1,
      phase: snap.ph,
      countdown: snap.cd,
      river: snap.w,
      scoreboard: this.scoreboard,
      ping: this.session.rtt(),
      fps: this.fps,
      local: this.session.local,
      focus: { x: this.cam.focusPoint.x, z: this.cam.focusPoint.z },
    };
  }

  setControls(scheme: 'modern' | 'classic'): void {
    this.input.scheme = scheme;
    this.input.clearDestination();
  }

  setShake(s: number): void {
    this.cam.shakeScale = s;
  }

  get hudState(): HudFrame | null {
    return this.hudFrame;
  }

  get matchEnded(): MatchEnd | null {
    return this.ended;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.close();
    this.input.dispose();
    this.deps.canvas.removeEventListener('wheel', this.wheelFn);
    for (const v of this.views.values()) v.pudgy.dispose();
    for (const c of this.chains.values()) c.dispose();
    for (const r of this.runes.values()) r.dispose();
    for (const h of this.hazards) h.dispose();
    this.world.dispose();
    this.water.dispose();
    this.fx.dispose();
    this.engine.scene.remove(this.root);
    this.deps.hud.hide();
    this.deps.audio.setAmbience(null, null);
  }
}

export { TEAM_COLORS };
