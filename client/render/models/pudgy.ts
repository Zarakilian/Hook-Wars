// Pudgy characters: Harbour Brawler, Swamp Ogre, Butcher-Bot.
// Articulated voxel rigs (separately meshed parts on proper pivots, geometry shared per
// family / piece / option / team) with procedural animation. See ./pudgy/ for the pieces:
//   grid.ts      voxel grid with surface channels, meshing
//   material.ts  one shared shader, per-unit uniforms (glow pulses, hit flash, team rim)
//   rig.ts       joint hierarchy
//   anim.ts      procedural animation
//   brawler.ts, ogre.ts, bot.ts  the three families and all their cosmetics
import * as THREE from 'three';
import type { Cosmetics, FamilyId, Team } from '../../../shared/types.ts';
import { UnitState } from '../../../shared/types.ts';
import { TEAM_COLORS, type PudgyAnimInput, type PudgyOneShot, type PudgyOptions, type PudgyPalette, type PudgyView } from '../contracts.ts';
import { PudgyAnimator } from './pudgy/anim.ts';
import { buildBot, botPalette } from './pudgy/bot.ts';
import { brawlerPalette, buildBrawler } from './pudgy/brawler.ts';
import { cacheStats, releaseGeo } from './pudgy/cache.ts';
import { makePudgyMaterial, makeUniforms } from './pudgy/material.ts';
import { buildOgre, ogrePalette } from './pudgy/ogre.ts';
import { buildRig } from './pudgy/rig.ts';
import type { FamilyBuild } from './pudgy/types.ts';

export function pudgyPalette(family: FamilyId, cosmetics: Cosmetics, team: Team): PudgyPalette {
  if (family === 'ogre') return ogrePalette(cosmetics, team);
  if (family === 'bot') return botPalette(cosmetics, team);
  return brawlerPalette(cosmetics, team);
}

function familyBuild(family: FamilyId, cosmetics: Cosmetics, team: Team): FamilyBuild {
  if (family === 'ogre') return buildOgre(cosmetics, team);
  if (family === 'bot') return buildBot(cosmetics, team);
  return buildBrawler(cosmetics, team);
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
  const fb = familyBuild(o.family, o.cosmetics, o.team);
  const tc = TEAM_COLORS[o.team];
  const uniforms = makeUniforms(o.isLocal ? 0.38 : 0.26, tc.light);
  const solid = makePudgyMaterial(uniforms, false);
  let ghost: THREE.MeshStandardMaterial | null = null;
  let twins: THREE.Mesh[] | null = null;
  const nodes = buildRig(fb, solid, o.quality);
  const root = new THREE.Group();
  root.name = `pudgy:${o.name}`;
  root.add(nodes.rig);
  const seed = seedCounter++ * 7919;
  const anim = new PudgyAnimator(nodes, fb, uniforms, seed);
  const shadowFlags = nodes.meshes.map((m) => m.castShadow);
  let alpha = 1;
  const headProbe = new THREE.Object3D();
  headProbe.position.set(0, 0.62, 0.1);
  nodes.neck.add(headProbe);

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
      if (a.state === UnitState.Dead) return;
    },
    play(kind: PudgyOneShot): void {
      anim.play(kind);
    },
    setOpacity(a: number): void {
      const q = a >= 0.99 ? 1 : Math.max(0.05, Math.round(a * 20) / 20);
      if (q === alpha) return;
      alpha = q;
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
      solid.dispose();
      ghost?.dispose();
      root.remove(nodes.rig);
    },
  };
  Object.defineProperty(view, '_anim', { value: anim, enumerable: false });
  return view;
}

// ---------------------------------------------------------------------------------------------
// Debug lineup (only with ?debug in the URL): every family x cosmetic x team in a grid.
//   __pudgyLineup(scene, x, z, { family?, team?, what?: 'hats' | 'accents' | 'faces' | 'all' })
//   __pudgyLineup.set({ state, speed, hookOut, hpFrac, flags, castKind }) / .play('throw') / .clear()
// ---------------------------------------------------------------------------------------------

interface LineupOpts {
  family?: FamilyId;
  team?: Team;
  what?: 'hats' | 'accents' | 'faces' | 'all' | 'mix';
  spacing?: number;
  /** explicit cosmetics list (overrides what) */
  combos?: Cosmetics[];
  /** ground height for the lineup (default 1.2) */
  y?: number;
}

if (typeof window !== 'undefined' && typeof location !== 'undefined' && location.search.includes('debug')) {
  const views: PudgyViewEx[] = [];
  let input: PudgyAnimInput = { state: UnitState.Alive, speed: 0, hpFrac: 1, flags: 0, hookOut: false, stateTime: 0, time: 0 };
  let host: THREE.Object3D | null = null;
  const lineup = (scene: THREE.Object3D, x: number, z: number, opts: LineupOpts = {}): number => {
    lineup.clear();
    const fams: FamilyId[] = opts.family ? [opts.family] : ['brawler', 'ogre', 'bot'];
    const teams: Team[] = opts.team !== undefined ? [opts.team] : [0, 1];
    const what = opts.what ?? 'mix';
    const sp = opts.spacing ?? 2.1;
    const g = new THREE.Group();
    g.name = 'pudgy-lineup';
    scene.add(g);
    host = g;
    let row = 0;
    for (const f of fams)
      for (const tm of teams) {
        const combos: Cosmetics[] = opts.combos ? opts.combos.slice() : [];
        if (!opts.combos) {
          if (what === 'hats' || what === 'all') for (let i = 0; i < 8; i++) combos.push({ hat: i, accent: 0, face: 0 });
          if (what === 'accents' || what === 'all') for (let i = 0; i < 8; i++) combos.push({ hat: 0, accent: i, face: 0 });
          if (what === 'faces' || what === 'all') for (let i = 0; i < 6; i++) combos.push({ hat: 0, accent: 0, face: i });
          if (what === 'mix') for (let i = 0; i < 8; i++) combos.push({ hat: i, accent: (i * 3 + 1) % 8, face: i % 6 });
        }
        combos.forEach((c, i) => {
          const v = createPudgy({ family: f, cosmetics: c, team: tm, name: `${f}${i}`, isLocal: false, quality: 'high' });
          v.root.position.set(x + (i - (combos.length - 1) / 2) * sp, opts.y ?? 1.2, z + row * sp * 1.2);
          g.add(v.root);
          views.push(v);
        });
        row++;
      }
    const driver = new THREE.Mesh(new THREE.PlaneGeometry(0.001, 0.001), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    driver.frustumCulled = false;
    driver.onBeforeRender = () => {
      const dt = 1 / 60;
      input = { ...input, time: input.time + dt, stateTime: input.stateTime + dt };
      for (const v of views) v.update(dt, input);
    };
    g.add(driver);
    return views.length;
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
  lineup.views = views;
  lineup.stats = cacheStats;
  (window as unknown as Record<string, unknown>).__pudgyLineup = lineup;
}
