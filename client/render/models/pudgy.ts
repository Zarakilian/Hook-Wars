// Pudgy characters: Harbour Brawler, Swamp Ogre, Butcher-Bot.
// Each family is a bare base body (the character sheets) plus one cosmetic per slot
// (shared/cosmetics.ts). Articulated voxel rigs: separately meshed parts on proper pivots, geometry
// cached per (family, part, the item ids that part reads, team only where it is team-tinted) and
// shared across instances, one shared shader, procedural animation. See ./pudgy/ for the pieces:
//   grid.ts      voxel grid with surface channels, fine (showcase) resolution, meshing
//   material.ts  one shared shader, per-unit uniforms (glow pulses, hit flash, team rim, sparkle)
//   rig.ts       joint hierarchy, hook grip
//   anim.ts      procedural animation
//   puffs.ts     cigar smoke and smokestack steam
//   brawler.ts, ogre.ts, bot.ts  the three families and every catalog item
import * as THREE from 'three';
import { COSMETICS, COSMETIC_SLOTS, DEFAULT_LOADOUT, type CosmeticSlot } from '../../../shared/cosmetics.ts';
import type { FamilyId, Loadout, Team } from '../../../shared/types.ts';
import { UnitState } from '../../../shared/types.ts';
import { TEAM_COLORS, type PudgyAnimInput, type PudgyOneShot, type PudgyOptions, type PudgyPalette, type PudgyView } from '../contracts.ts';
import { createHeldHook, disposeHeldHook } from '../fx/hookSkins.ts';
import { PudgyAnimator } from './pudgy/anim.ts';
import { botPalette, buildBot } from './pudgy/bot.ts';
import { brawlerPalette, buildBrawler } from './pudgy/brawler.ts';
import { cacheStats, releaseGeo } from './pudgy/cache.ts';
import { islandReport } from './pudgy/check.ts';
import { lookOf, type Look } from './pudgy/common.ts';
import { VOX } from './pudgy/grid.ts';
import { makePudgyMaterial, makeUniforms } from './pudgy/material.ts';
import { buildOgre, ogrePalette } from './pudgy/ogre.ts';
import { PuffSystem } from './pudgy/puffs.ts';
import { buildRig } from './pudgy/rig.ts';
import type { FamilyBuild } from './pudgy/types.ts';

function look(family: FamilyId, loadout: Loadout, team: Team, fine: boolean, quality: PudgyOptions['quality']): Look {
  void family;
  const t = TEAM_COLORS[team];
  return lookOf(loadout ?? {}, team, { main: t.main, dark: t.dark, light: t.light }, fine, quality);
}

/** Colours of the model as built (death voxel burst, chain tint, portraits). */
export function pudgyPalette(family: FamilyId, loadout: Loadout, team: Team): PudgyPalette {
  const l = look(family, loadout, team, false, 'medium');
  if (family === 'ogre') return ogrePalette(l);
  if (family === 'bot') return botPalette(l);
  return brawlerPalette(l);
}

function familyBuild(family: FamilyId, l: Look): FamilyBuild {
  if (family === 'ogre') return buildOgre(l);
  if (family === 'bot') return buildBot(l);
  return buildBrawler(l);
}

let seedCounter = 1;

/** Transparent-queue order of the stealth depth pre-pass; the ghost parts draw right after it. */
const GHOST_DEPTH_ORDER = 10;
let ghostDepth: THREE.MeshBasicMaterial | null = null;
/** One shared depth-only material for every stealthed unit (lives for the page, never disposed). */
function ghostDepthMaterial(): THREE.MeshBasicMaterial {
  if (!ghostDepth) {
    // transparent so it sorts into the transparent queue (after all opaque scenery), never writes colour
    ghostDepth = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true, opacity: 0 });
    ghostDepth.name = 'pudgy-ghost-depth';
  }
  return ghostDepth;
}

/** PudgyView plus optional extras the game client may use. */
export interface PudgyViewEx extends PudgyView {
  /** Called on each footstep while running (foot 0 = left, 1 = right) and on heavy landings. */
  onFootstep: ((foot: 0 | 1, heavy: boolean) => void) | null;
  /** World position of the top of the head (for name tags / health bars). */
  getHeadWorld(out: THREE.Vector3): THREE.Vector3;
}

export function createPudgy(o: PudgyOptions): PudgyViewEx {
  const fine = o.detail === 'showcase';
  const l = look(o.family, o.loadout, o.team, fine, o.quality);
  const fb = familyBuild(o.family, l);
  const tc = TEAM_COLORS[o.team];
  const uniforms = makeUniforms(o.isLocal ? 0.38 : 0.26, tc.light);
  uniforms.uSparkle.value = fb.premium ? 1 : 0;
  const solid = makePudgyMaterial(uniforms, false);
  let ghost: THREE.MeshStandardMaterial | null = null;
  let twins: THREE.Mesh[] | null = null;
  let held: THREE.Object3D | null = null;
  try {
    held = createHeldHook(o.family, o.loadout?.hands, o.team, o.quality);
  } catch (err) {
    console.warn('[pudgy] hook skin failed, using the built-in hook', err);
    held = null;
  }
  if (held) {
    // fx skins on a rope, chain or cable tether hang from the hand; gripped ones (ogre) do not
    const tethered = !!held.getObjectByName('hw-held-tether');
    if (tethered !== fb.hookDangles) {
      fb.hookDangles = tethered;
      fb.hookMount = tethered ? fb.hangMount ?? fb.hookMount : fb.gripMount ?? fb.hookMount;
    }
  }
  const nodes = buildRig(fb, solid, o.quality, held);
  const root = new THREE.Group();
  root.name = `pudgy:${o.name}`;
  root.add(nodes.rig);
  const seed = seedCounter++ * 7919;
  const anim = new PudgyAnimator(nodes, fb, uniforms, seed);
  const shadowFlags = nodes.meshes.map((m) => m.castShadow);
  let alpha = 1;
  const headProbe = new THREE.Object3D();
  headProbe.position.set(0, (fb.sk.top - fb.sk.neck[1]) * VOX, 0);
  nodes.neck.add(headProbe);

  let puffs: PuffSystem | null = null;
  if (fb.puffs.length && o.quality !== 'low') {
    puffs = new PuffSystem(fb.puffs, fb.sk, (n) => (n === 'neck' ? nodes.neck : n === 'hat' ? nodes.hat : n === 'back' ? nodes.back : nodes.torso));
    root.add(puffs.mesh);
  }

  const view: PudgyViewEx = {
    root,
    onFootstep: null,
    getHandWorld(out: THREE.Vector3): THREE.Vector3 {
      return nodes.handR.getWorldPosition(out);
    },
    getHeadWorld(out: THREE.Vector3): THREE.Vector3 {
      return headProbe.getWorldPosition(out);
    },
    update(dt: number, a: PudgyAnimInput): void {
      anim.onFootstep = view.onFootstep;
      anim.update(dt, a, root);
      if (puffs) {
        const live = a.state !== UnitState.Dead && a.state !== UnitState.Drowning && alpha >= 1 && root.visible;
        puffs.update(dt, anim.exertion, fb.scale, root, live);
      }
    },
    play(kind: PudgyOneShot): void {
      anim.play(kind);
    },
    setOpacity(a: number): void {
      const q = a >= 0.99 ? 1 : Math.max(0.05, Math.round(a * 20) / 20);
      if (q === alpha) return;
      alpha = q;
      // the fx hook skin's materials are shared and cached by the fx module: never swap or fade
      // them, just hide the skin while see-through (the puffs too)
      if (held) held.visible = q >= 1;
      if (q >= 1) {
        for (let i = 0; i < nodes.meshes.length; i++) {
          const m = nodes.meshes[i];
          m.material = solid;
          m.castShadow = shadowFlags[i];
          m.renderOrder = 0;
        }
        if (twins) for (const t of twins) t.visible = false;
      } else {
        if (!ghost) ghost = makePudgyMaterial(uniforms, true);
        ghost.opacity = q;
        // depth-only twins (children of each part, so they follow its transform and visibility) draw
        // first, then the ghost draws only the front-most surface: one clean see-through layer
        // instead of arms and belly showing through each other.
        if (!twins) {
          twins = [];
          for (const m of nodes.meshes) {
            const t = new THREE.Mesh(m.geometry, ghostDepthMaterial());
            t.name = 'ghost-depth';
            t.renderOrder = GHOST_DEPTH_ORDER;
            t.castShadow = false;
            t.receiveShadow = false;
            m.add(t);
            twins.push(t);
          }
        }
        for (const t of twins) t.visible = true;
        for (const m of nodes.meshes) {
          m.material = ghost;
          m.castShadow = false;
          m.renderOrder = GHOST_DEPTH_ORDER + 1;
        }
      }
    },
    dispose(): void {
      for (const k of nodes.keys) releaseGeo(k);
      if (held) disposeHeldHook(held);
      held = null;
      puffs?.dispose();
      puffs = null;
      solid.dispose();
      ghost?.dispose();
      root.remove(nodes.rig);
    },
  };
  Object.defineProperty(view, '_anim', { value: anim, enumerable: false });
  Object.defineProperty(view, '_fb', { value: fb, enumerable: false });
  return view;
}

// ---------------------------------------------------------------------------------------------
// Debug lineup (only with ?debug in the URL).
//   __pudgyLineup(scene, x, z, { family?, team?, slot?, bare?, loadouts?, detail?, spacing?, y? })
//     no slot / loadouts: bare base and default set of every family
//     slot: every catalog item of that slot (on the default set, or on the bare base with bare: true)
//   __pudgyLineup.set({ state, speed, hookOut, hpFrac, flags, castKind }) / .play('throw') / .step(ms)
//   __pudgyLineup.islands() lists every part grid with detached voxel islands, for every item
// ---------------------------------------------------------------------------------------------

interface LineupOpts {
  family?: FamilyId;
  team?: Team;
  slot?: CosmeticSlot;
  bare?: boolean;
  loadouts?: Loadout[];
  detail?: 'game' | 'showcase';
  spacing?: number;
  /** ground height for the lineup (default 1.2) */
  y?: number;
  /** rotate every unit (radians, 0 = facing +Z) */
  yaw?: number;
}

if (typeof window !== 'undefined' && typeof location !== 'undefined' && location.search.includes('debug')) {
  const views: PudgyViewEx[] = [];
  let input: PudgyAnimInput = { state: UnitState.Alive, speed: 0, hpFrac: 1, flags: 0, hookOut: false, stateTime: 0, time: 0 };
  let host: THREE.Object3D | null = null;
  const lineup = (scene: THREE.Object3D, x: number, z: number, opts: LineupOpts = {}): string[] => {
    lineup.clear();
    const fams: FamilyId[] = opts.family ? [opts.family] : ['brawler', 'ogre', 'bot'];
    const teams: Team[] = opts.team !== undefined ? [opts.team] : [0, 1];
    const sp = opts.spacing ?? 2.1;
    const g = new THREE.Group();
    g.name = 'pudgy-lineup';
    scene.add(g);
    host = g;
    const labels: string[] = [];
    let row = 0;
    for (const f of fams)
      for (const tm of teams) {
        let outfits: Loadout[];
        if (opts.loadouts) outfits = opts.loadouts;
        else if (opts.slot) {
          const base: Loadout = opts.bare ? {} : { ...DEFAULT_LOADOUT[f] };
          const empty: Loadout = { ...base };
          delete empty[opts.slot];
          outfits = [empty, ...COSMETICS.filter((c) => c.family === f && c.slot === opts.slot).map((c) => ({ ...base, [opts.slot as CosmeticSlot]: c.id }))];
        } else outfits = [{}, { ...DEFAULT_LOADOUT[f] }];
        outfits.forEach((lo, i) => {
          const v = createPudgy({ family: f, loadout: lo, team: tm, name: `${f}${i}`, isLocal: false, quality: 'high', detail: opts.detail ?? 'game' });
          v.root.position.set(x + (i - (outfits.length - 1) / 2) * sp, opts.y ?? 1.2, z + row * sp * 1.25);
          v.root.rotation.y = opts.yaw ?? 0;
          g.add(v.root);
          views.push(v);
          if (row === 0) labels.push(COSMETIC_SLOTS.map((s) => lo[s] ?? '-').join(' '));
        });
        row++;
      }
    return labels;
  };
  lineup.clear = () => {
    for (const v of views) v.dispose();
    views.length = 0;
    if (host) host.removeFromParent();
    host = null;
  };
  lineup.set = (patch: Partial<PudgyAnimInput>) => {
    input = { ...input, ...patch, stateTime: 0 };
  };
  lineup.play = (k: PudgyOneShot) => {
    for (const v of views) v.play(k);
  };
  /** step every lineup unit manually (the browser pane may pause rAF) */
  lineup.step = (ms: number, step = 16.7) => {
    for (let t = 0; t < ms; t += step) {
      input = { ...input, time: input.time + step / 1000, stateTime: input.stateTime + step / 1000 };
      for (const v of views) v.update(step / 1000, input);
    }
  };
  lineup.islands = () => {
    const out: string[] = [];
    for (const f of ['brawler', 'ogre', 'bot'] as FamilyId[]) {
      const outfits: Loadout[] = [{}, { ...DEFAULT_LOADOUT[f] }, ...COSMETICS.filter((c) => c.family === f).map((c) => ({ [c.slot]: c.id }) as Loadout)];
      for (const lo of outfits) out.push(...islandReport(familyBuild(f, look(f, lo, 0, false, 'high')), JSON.stringify(lo)));
    }
    return out;
  };
  /** neutral grey studio for character shots: hides everything but lights and the lineup */
  let studioFloor: THREE.Mesh | null = null;
  const hidden: THREE.Object3D[] = [];
  let prevBg: THREE.Scene['background'] = null;
  let prevFog: THREE.Scene['fog'] = null;
  lineup.studio = (scene: THREE.Scene, on: boolean, floorY = 1.2, bg = 0x9a9ea4) => {
    if (on) {
      if (studioFloor) return;
      for (const c of scene.children) {
        if ((c as THREE.Light).isLight || c === host || !c.visible) continue;
        c.visible = false;
        hidden.push(c);
      }
      prevBg = scene.background;
      prevFog = scene.fog;
      scene.background = new THREE.Color(bg);
      scene.fog = null;
      studioFloor = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshStandardMaterial({ color: bg, roughness: 0.9 }));
      studioFloor.rotation.x = -Math.PI / 2;
      studioFloor.position.y = floorY;
      studioFloor.receiveShadow = true;
      scene.add(studioFloor);
    } else {
      for (const c of hidden) c.visible = true;
      hidden.length = 0;
      if (studioFloor) {
        scene.remove(studioFloor);
        studioFloor.geometry.dispose();
        (studioFloor.material as THREE.Material).dispose();
        studioFloor = null;
        scene.background = prevBg;
        scene.fog = prevFog;
      }
    }
  };
  // screenshot helpers driving the debug hooks of the game (window.__hookwars)
  type HW = {
    solo(p: Record<string, unknown>): void;
    advance(ms: number): void;
    game(): { cam: { camera: THREE.PerspectiveCamera; update: (...a: unknown[]) => void } };
    app: { engine: { scene: THREE.Scene } };
  };
  const hw = () => (window as unknown as { __hookwars: HW }).__hookwars;
  let camO: number[] | null = null;
  /** start a solo match, take over the camera, hide the HUD */
  lineup.setup = (map = 'coralcove') => {
    hw().solo({ mapId: map, riverMode: 'dry', hazards: 'none', teamSize: 1 });
    hw().advance(100);
    const cam = hw().game().cam;
    const orig = cam.update.bind(cam);
    cam.update = (...a: unknown[]) => {
      if (!camO) return orig(...a);
      const c = cam.camera;
      c.position.set(camO[0], camO[1], camO[2]);
      c.lookAt(camO[3], camO[4], camO[5]);
      c.fov = camO[6];
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
    };
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = 'none';
    return 'ok';
  };
  /** lineup in the grey studio (or on the map with studio = false) */
  lineup.lu = (opts: LineupOpts, x = -20, z = 10, studio = true) => {
    const sc = hw().app.engine.scene;
    lineup.studio(sc, false);
    const labels = lineup(sc, x, z, { y: studio ? 0 : 1.1, spacing: 2.4, ...opts });
    if (studio) lineup.studio(sc, true, 0);
    lineup.step(300);
    return labels;
  };
  /** studio camera: dist in front (+z), height, look-at height */
  lineup.cam = (x: number, z: number, dist: number, h: number, look: number, fov = 30, side = 0) => {
    camO = [x + side, h, z + dist, x, look, z, fov];
    hw().advance(34);
    return 'ok';
  };
  /** the gameplay camera angle (pitch 0.95, 34 m x zoom) with a narrow fov to magnify */
  lineup.gcam = (x: number, z: number, fov = 15, zoom = 1.25, y = 1.1) => {
    const d = 34 * zoom;
    camO = [x, y + Math.sin(0.95) * d, z + Math.cos(0.95) * d, x, y, z, fov];
    hw().advance(34);
    return 'ok';
  };
  lineup.free = () => {
    camO = null;
  };
  lineup.views = views;
  lineup.stats = cacheStats;
  (window as unknown as Record<string, unknown>).__pudgyLineup = lineup;
}
