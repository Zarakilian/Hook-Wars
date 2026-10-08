// River water: the showpiece. Gerstner waves, scrolled detail normals, depth absorption, refraction,
// Fresnel sky and planar reflection, sun glints, every kind of foam, ripples from splashes, caustics,
// the Coral Cove whirlpool and waterfall, Cogwater lock floods, Frostfang ice, and Dry Bed puddles.
// Files: water/field (baked channel data), water/surface (main shader), water/ice, water/caustics,
// water/falls, water/reflection, water/ripples, water/waves, water/textures, water/style.
import * as THREE from 'three';
import { riverAt } from '../../../shared/maps/helpers.ts';
import type { MapDef } from '../../../shared/maps/types.ts';
import { moversFloat, moversPresent, riverStateAt, tidalActive } from '../../../shared/sim/river.ts';
import type { MatchConfig, RiverState } from '../../../shared/types.ts';
import { World } from '../../../shared/world.ts';
import { WATER_LAYER, groundY, waterY, type Engine, type WaterView, type WorldView } from '../contracts.ts';
import { createCausticsMaterial } from './water/caustics.ts';
import { FallSheet } from './water/falls.ts';
import { bakeField, buildRiverGrid, fieldUniforms, sampleField, type GridSpan } from './water/field.ts';
import { createIceMaterial } from './water/ice.ts';
import { PlanarReflection } from './water/reflection.ts';
import { Ripples } from './water/ripples.ts';
import { waterStyle } from './water/style.ts';
import { MAX_MOVERS, MAX_POURS, createSurfaceMaterial } from './water/surface.ts';
import { createPuffTexture, createWaterTextures } from './water/textures.ts';
import { advanceWaves, makeWaves, waveHeight } from './water/waves.ts';

/** Ice top sits this far above the full water line. */
const ICE_LIFT = 0.03;
/** Seconds the ice takes to break up and sink when the thaw begins. */
const BREAK_SEC = 1.7;

interface Extras {
  syncedClock: number;
  syncedAt: number;
}
const extras = new WeakMap<WaterView, Extras>();

/**
 * Optional, for exact mover wakes: pass the snapshot mover clock (Snapshot.mc, as used for the mover
 * views) every frame. Without it the water integrates its own clock, which can drift a little online.
 */
export function syncWaterMovers(view: WaterView, moverClock: number): void {
  const e = extras.get(view);
  if (!e) return;
  e.syncedClock = moverClock;
  e.syncedAt = performance.now();
}

function lin(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function createWater(map: MapDef, config: MatchConfig, engine: Engine, world: WorldView): WaterView {
  const quality = engine.quality;
  const tier = quality === 'low' ? 0 : quality === 'medium' ? 1 : quality === 'high' ? 2 : 3;
  const style = waterStyle(map);
  const atm = map.atmosphere;
  const dry = config.riverMode === 'dry';
  const tidal = tidalActive(map, config);
  const tide = map.tide;
  const freezeMap = tidal && tide?.style === 'freeze';
  const lockMap = tidal && tide?.style === 'locks';
  const fullY = waterY(map, 1);
  const lowY = waterY(map, 0);
  const iceY = fullY + ICE_LIFT;
  const flowSign = map.river.flow < 0 ? -1 : 1;
  const flowAbs = Math.abs(map.river.flow);
  const night = atm.timeOfDay === 'night' || atm.timeOfDay === 'dusk';

  const group = new THREE.Group();
  group.name = 'water';

  // ---- baked data and textures
  const waterfallMap = map.decor.some((d) => d.kind === 'waterfall');
  const field = bakeField(map, (x, z) => world.groundHeight(x, z), tier >= 2 ? 0.2 : 0.25, waterfallMap && tidal);
  const fu = fieldUniforms(field);
  const aniso = Math.min(8, engine.renderer.capabilities.getMaxAnisotropy());
  const tex = createWaterTextures(tier >= 2, tier === 0 ? 1 : aniso);
  const waves = makeWaves(map, style, tier >= 2 ? 6 : tier === 1 ? 5 : 4);
  const ripples = new Ripples();
  ripples.limit = [10, 18, 24, 24][tier];
  ripples.maxAmbient = [3, 6, 8, 8][tier];

  // ---- decor the water owns: waterfall and lock gates
  const waterfalls = map.decor.filter((d) => d.kind === 'waterfall');
  const gates = map.decor.filter((d) => d.kind === 'lockgate').sort((a, b) => a.z - b.z);

  // ---- surface mesh spans (lock reservoirs are separate patches held at full level)
  const pts = map.river.points;
  let z0 = pts[0].z;
  let z1 = pts[pts.length - 1].z;
  for (const wf of waterfalls) {
    // the pool ends just behind the plunge line, tucked under the cliff
    if (wf.z < 0) z0 = Math.max(z0, wf.z - 0.9);
    else z1 = Math.min(z1, wf.z + 0.9);
  }
  const spans: GridSpan[] = [];
  if (lockMap && gates.length >= 2) {
    const gN = gates[0].z;
    const gS = gates[gates.length - 1].z;
    spans.push({ z0, z1: gN, fixed: 1 }, { z0: gN, z1: gS, fixed: 0 }, { z0: gS, z1, fixed: 1 });
  } else {
    spans.push({ z0, z1, fixed: 0 });
  }
  const step = [0.5, 0.36, 0.28, 0.22][tier];
  const surfGeo = buildRiverGrid(map, step, field.ext, spans);

  // ---- shared uniform values
  const sunDir = new THREE.Vector3(atm.sunDir[0], atm.sunDir[1], atm.sunDir[2]).normalize();
  const specDir = new THREE.Vector3();
  const sunCol = new THREE.Color(atm.sunColor).multiplyScalar(atm.sunIntensity);
  const ambient = lin(atm.skyTop).multiplyScalar(atm.ambientIntensity).lerp(lin(atm.groundAmbient).multiplyScalar(atm.ambientIntensity), 0.15);
  const irr = new THREE.Color();
  const fieldTexel = new THREE.Vector2(1 / field.nx, 1 / field.nz);
  const waterIceU = new THREE.Vector4(-10, 0, 0, 0); // what the water sees (hidden under the ice)
  const sheetIceU = new THREE.Vector4(-10, 0, 0, 0); // what the ice sheet draws
  const scroll = new THREE.Vector4();
  const scroll2 = new THREE.Vector4();
  const whirlU = new THREE.Vector4(0, 0, 1, 0);
  const whirlSpin = new THREE.Vector3(0, 0, 1);
  const movA: THREE.Vector4[] = [];
  const movB: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_MOVERS; i++) {
    movA.push(new THREE.Vector4());
    movB.push(new THREE.Vector4());
  }
  const pours: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_POURS; i++) pours.push(new THREE.Vector4(0, 0, 1, 0));
  const camFwd = new THREE.Vector3(0, -1, 0);
  const camNF = new THREE.Vector2(0.5, 400);
  const surgeDir = new THREE.Vector2(0, -1);
  if (lockMap) surgeDir.set(0, 0); // shader: (0,0) = bands roll in from both ends
  else if (tide?.style === 'tide') surgeDir.set(0, -flowSign);

  const su: Record<string, THREE.IUniform> = {
    uField: { value: field.texture },
    uFieldBox: { value: fu.box },
    uFieldRange: { value: fu.range },
    uFieldTexel: { value: fieldTexel },
    uWaveA: { value: waves.uA },
    uWaveB: { value: waves.uB },
    uLevelY: { value: fullY },
    uFullY: { value: fullY },
    uWaveDamp: { value: 1 },
    uWhirl: { value: whirlU },
    uWhirlDepth: { value: 0.42 },
    uWhirlSpin: { value: whirlSpin },
    uWhirlSign: { value: 1 },
    uRip: { value: ripples.uA },
    uRipR: { value: ripples.uR },
    uRipN: { value: 0 },
    uTime: { value: 0 },
    uScroll: { value: scroll },
    uScroll2: { value: scroll2 },
    uSurge: { value: 0 },
    uSurgeDir: { value: surgeDir },
    uSurgePhase: { value: 0 },
    uPuddleMode: { value: dry ? 1 : 0 },
    uIce: { value: waterIceU },
    uMovA: { value: movA },
    uMovB: { value: movB },
    uMovN: { value: 0 },
    uPour: { value: pours },
    uPourN: { value: 0 },
    uSlope: { value: tex.slope },
    uNoise: { value: tex.noise },
    uShallow: { value: lin(atm.waterShallow) },
    uDeep: { value: lin(atm.waterDeep) },
    uFoamCol: { value: lin(atm.waterFoam) },
    uSkyTop: { value: lin(atm.skyTop) },
    uSkyHorizon: { value: lin(atm.skyHorizon) },
    uSunDir: { value: sunDir },
    uSunCol: { value: sunCol },
    uSpecDir: { value: specDir },
    uAmbient: { value: ambient },
    uScumCol: { value: lin(style.scumColor) },
    uStyleA: { value: new THREE.Vector4(style.clarity, style.choppy, style.streaks, style.shoreFoam) },
    uStyleB: { value: new THREE.Vector4(style.scum, style.oil, style.rain, style.reflect) },
    uStyleC: { value: new THREE.Vector4(style.glitter, style.sss, night ? style.nightLift : style.nightLift * 0.3, style.refract) },
    uStyleD: { value: new THREE.Vector4(tier >= 1 ? style.speck : 0, style.plips, tier >= 1 ? 1 : 0, waterfallMap && tidal ? 1 : 0) },
    uSpeckCol: { value: lin(style.speckColor || 0x888888) },
    uMurk: { value: style.murk },
    uHasCapture: { value: 0 },
    tColor: { value: null },
    tDepth: { value: null },
    uCamNF: { value: camNF },
    uCamFwd: { value: camFwd },
    uHasReflect: { value: 0 },
    tReflect: { value: null },
    uReflectMat: { value: new THREE.Matrix4() },
  };
  const surfMat = createSurfaceMaterial(su, waves.n, Math.min(2, tier));
  const surface = new THREE.Mesh(surfGeo, surfMat);
  surface.name = 'water-surface';
  surface.layers.set(WATER_LAYER);
  surface.frustumCulled = false;
  // first among transparents when the engine renders in one pass (low tier): FX draw over the water
  surface.renderOrder = -2;
  group.add(surface);

  // ---- caustics on the bed
  let caustics: THREE.Mesh | null = null;
  let causticGeo: THREE.BufferGeometry | null = null;
  const causticU: Record<string, THREE.IUniform> = {
    uField: { value: field.texture },
    uFieldBox: { value: fu.box },
    uFieldRange: { value: fu.range },
    uFieldTexel: { value: fieldTexel },
    uNoise: { value: tex.noise },
    uScroll: { value: new THREE.Vector4() },
    uLevelY: { value: fullY },
    uSunDir: { value: sunDir },
    uCausticCol: { value: new THREE.Color() },
    uStrength: { value: style.caustics },
    uClarity: { value: style.clarity },
    uPuddleMode: su.uPuddleMode,
    uChroma: { value: tier >= 2 ? 1 : 0 },
    uIce: su.uIce,
  };
  if (!dry && tier >= 1 && style.caustics > 0) {
    causticGeo = buildRiverGrid(map, Math.max(0.3, step), 0.4, [{ z0, z1, fixed: 0 }]);
    const cm = createCausticsMaterial(causticU);
    caustics = new THREE.Mesh(causticGeo, cm);
    caustics.name = 'water-caustics';
    caustics.frustumCulled = false;
    caustics.renderOrder = 10;
    group.add(caustics);
  }

  // ---- ice sheet (Frostfang tidal: freeze / crack / thaw)
  let ice: THREE.Mesh | null = null;
  const windU = new THREE.Vector2();
  const iceMatU: Record<string, THREE.IUniform> = {
    uField: { value: field.texture },
    uFieldBox: { value: fu.box },
    uFieldRange: { value: fu.range },
    uFieldTexel: { value: fieldTexel },
    uIceY: { value: iceY },
    uTime: { value: 0 },
    uIce: { value: sheetIceU },
    uNoise: { value: tex.noise },
    uIceDeep: { value: lin(atm.waterDeep).lerp(lin(atm.waterShallow), 0.25).multiplyScalar(1.15) },
    uIceMilky: { value: lin(0xdcebf7) },
    uSnowCol: { value: lin(0xf4f8fc) },
    uCrackGlow: { value: lin(0x52c8ff) },
    uSpecDir: { value: specDir },
    uSunCol: { value: sunCol },
    uWind: { value: windU },
  };
  if (freezeMap) {
    const im = createIceMaterial(iceMatU, tier);
    ice = new THREE.Mesh(surfGeo, im);
    ice.name = 'water-ice';
    ice.frustumCulled = false;
    ice.receiveShadow = tier >= 1;
    // on the water layer: drawn after the opaque capture (units' feet occlude it correctly) and before
    // transparent FX, so splashes and dust are never painted over by the ice
    ice.layers.set(WATER_LAYER);
    ice.renderOrder = -1;
    ice.visible = false;
    group.add(ice);
  }

  // ---- waterfall and lock sluices
  const puff = createPuffTexture();
  const falls: { sheet: FallSheet; kind: 'waterfall' | 'lock' }[] = [];
  const foamC = lin(atm.waterFoam);
  const waterC = lin(atm.waterShallow).lerp(lin(atm.waterFoam), 0.35);
  for (const wf of waterfalls) {
    if (dry) break;
    const inward = wf.z < 0 ? 1 : -1;
    const r = riverAt(pts, wf.z);
    const width = Math.min(r.hw * 1.25, 6.4) * wf.scale;
    const sheet = new FallSheet(
      {
        lip: new THREE.Vector3(r.x, groundY(map) + 2.7, wf.z - inward * 1.25),
        dir: new THREE.Vector2(0, inward),
        width,
        vel: 1.5,
        approach: 0.12,
        jets: 0,
        mistCount: [6, 14, 22, 30][tier],
        mistRise: 2.4,
        mistOpacity: 0.32,
        noise: tex.noise,
        puff,
        foam: foamC,
        water: waterC,
      },
      irr,
    );
    falls.push({ sheet, kind: 'waterfall' });
    group.add(sheet.group);
  }
  if (lockMap) {
    for (const g of gates) {
      const inward = g.z < 0 ? 1 : -1;
      const r = riverAt(pts, g.z);
      const sheet = new FallSheet(
        {
          lip: new THREE.Vector3(r.x, fullY + 0.18, g.z + inward * 0.25),
          dir: new THREE.Vector2(0, inward),
          width: r.hw * 1.7,
          vel: 2.6,
          approach: 0.05,
          jets: 3,
          mistCount: [4, 8, 12, 16][tier],
          mistRise: 1.4,
          mistOpacity: 0.26,
          noise: tex.noise,
          puff,
          foam: foamC,
          water: waterC,
        },
        irr,
      );
      falls.push({ sheet, kind: 'lock' });
      group.add(sheet.group);
    }
  }

  // ---- movers (logs, floes, barges, rafts) for wakes
  const moverWorld = map.movers.length ? new World(map) : null;
  let moverClock = 0;

  // ---- planar reflection (high / ultra)
  let reflection: PlanarReflection | null = null;

  // ---- state
  const init = riverStateAt(map, config, 0);
  let level = dry ? 0 : init.level;
  let levelY = waterY(map, level);
  let frozenNow = !dry && init.frozen;
  let puddleMode = dry ? 1 : 0;
  let waveDamp = 1;
  let surge = 0;
  let surgePhase = 0;
  let lastTime = -1;
  let firstUpdate = true;
  let whirlStrength = 0;
  let thawT = 0;
  let plipAcc = 0;
  let disposed = false;
  const tmpV = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const shallowLin = lin(atm.waterShallow);
  const causticTint = new THREE.Color();

  const view: WaterView = {
    group,
    surfaceHeight(x: number, z: number): number {
      if (dry) {
        const pm = sampleField(field, field.puddle, x, z);
        if (!(pm > 0.42)) return -Infinity;
        const bed = sampleField(field, field.bed, x, z);
        return Math.max(lowY, bed + 0.035);
      }
      const c = sampleField(field, field.chan, x, z);
      if (!(c > -field.ext)) return -Infinity;
      if (frozenNow) return c > -0.4 ? iceY : -Infinity;
      let base = levelY;
      if (lockMap && gates.length >= 2 && (z < gates[0].z || z > gates[gates.length - 1].z)) base = fullY;
      const bed = sampleField(field, field.bed, x, z);
      const damp = waveDamp * smooth(-0.8, 1.4, c) * smooth(0.02, 0.7, base - bed);
      if (puddleMode > 0) base = Math.max(base, base + (bed + 0.035 - base) * puddleMode);
      let y = base + waveHeight(waves, x, z, damp);
      const wp = map.whirlpool;
      if (wp && whirlStrength > 0) {
        const d = Math.hypot(x - wp.x, z - wp.z) / wp.r;
        const fun = Math.exp(-d * d * 5) * 0.75 + (1 - smooth(0, 1, d)) * 0.25;
        y -= 0.42 * whirlStrength * fun;
      }
      if (y <= bed + 0.01) return -Infinity;
      if (puddleMode > 0.5 && !(Math.max(sampleField(field, field.puddle, x, z), sampleField(field, field.stream, x, z)) > 0.3)) return -Infinity;
      return y;
    },

    update(dt: number, time: number, river: RiverState, camera: THREE.Camera): void {
      if (disposed) return;
      const rdt = lastTime < 0 ? Math.min(dt, 0.05) : Math.max(0, Math.min(0.1, time - lastTime));
      lastTime = time;
      const phase = river.phase;

      // -- level, smoothed so 30 Hz snapshots never step the surface
      const target = dry ? 0 : river.level;
      level = firstUpdate ? target : level + (target - level) * (1 - Math.exp(-rdt * 7));
      levelY = waterY(map, level);
      frozenNow = !dry && river.frozen;

      // -- tide surge (rising), puddles at low tide
      const rising = phase === 'rising' && !freezeMap;
      surge += ((rising ? 1 : 0) - surge) * (1 - Math.exp(-rdt * (rising ? 2.5 : 0.8)));
      surgePhase = (surgePhase + rdt * 2.8) % 6283.0;
      puddleMode = dry ? 1 : tidal && !freezeMap ? 1 - smooth(0.06, 0.32, level) : 0;
      const flowMul = 1 + surge * 1.9 + (phase === 'falling' && !freezeMap ? 0.5 : 0);

      // -- ice state
      let freezeProg = 0;
      let iceFront = -10;
      let crack = 0;
      let brk = 0;
      let iceVisible = false;
      if (freezeMap && tide) {
        if (phase === 'freezing') {
          freezeProg = Math.max(0, Math.min(1, 1 - river.phaseLeft / Math.max(0.1, tide.fallingSec)));
          iceFront = -0.6 + freezeProg * (field.maxChan + 1.6);
          iceVisible = freezeProg > 0.001;
          thawT = 0;
        } else if (phase === 'frozen' || phase === 'cracking') {
          freezeProg = 1;
          iceFront = 99;
          iceVisible = true;
          if (phase === 'cracking') crack = Math.max(0, Math.min(1, 1 - river.phaseLeft / Math.max(0.1, tide.risingSec)));
          thawT = 0;
        } else if (phase === 'thawed') {
          thawT += rdt;
          if (firstUpdate) thawT = BREAK_SEC + 1;
          if (thawT < BREAK_SEC) {
            brk = thawT / BREAK_SEC;
            iceFront = 99;
            crack = 1;
            iceVisible = true;
          }
        }
      }
      waterIceU.set(phase === 'thawed' ? -10 : iceFront, iceVisible && phase !== 'thawed' ? 1 : 0, crack, 0);
      sheetIceU.set(iceFront, iceVisible ? 1 : 0, crack, brk);
      if (ice) {
        ice.visible = iceVisible;
        iceMatU.uTime.value = time;
      }
      const fullyFrozen = phase === 'frozen' || phase === 'cracking';
      surface.visible = !(freezeMap && fullyFrozen);
      waveDamp = (1 - freezeProg * 0.88) * (1 - puddleMode * 0.92) * (1 + surge * 0.45);
      // while the plates break up the water stays calm and a touch low so it never pokes through them
      let breakDip = 0;
      if (freezeMap && phase === 'thawed' && thawT < BREAK_SEC + 1.5) {
        waveDamp *= 0.3 + 0.7 * smooth(0, BREAK_SEC + 1.5, thawT);
        breakDip = 0.06 * (1 - smooth(BREAK_SEC * 0.6, BREAK_SEC + 1, thawT));
      }

      // -- scrolling (accumulated so speed changes never jump the texture)
      const v = (flowAbs * flowMul + 0.06) * rdt;
      const fz = flowSign;
      scroll.x = (scroll.x + v * 0.19 * 0.08) % 1;
      scroll.y = (scroll.y - fz * v * 0.19) % 1;
      scroll.z = (scroll.z - v * 0.47 * 0.05) % 1;
      scroll.w = (scroll.w - fz * v * 0.47 * 1.3) % 1;
      scroll2.x = (scroll2.x) % 1;
      scroll2.y = (scroll2.y - fz * v * 0.055 * 1.1) % 1;
      scroll2.z = (scroll2.z + v * 0.42 * 0.04) % 1;
      scroll2.w = (scroll2.w - fz * v * 0.42 * 0.95) % 1;
      const cs = causticU.uScroll.value as THREE.Vector4;
      cs.x = (cs.x + rdt * 0.021) % 1;
      cs.y = (cs.y + rdt * 0.017 * fz) % 1;
      cs.z = (cs.z - rdt * 0.019) % 1;
      cs.w = (cs.w + rdt * 0.026 * fz) % 1;
      advanceWaves(waves, rdt, 1 + surge * 0.9);
      windU.set((windU.x + rdt * 0.012) % 1, (windU.y + rdt * 0.004) % 1);

      // -- whirlpool (fades out when the water is low or frozen)
      const wp = map.whirlpool;
      const wTarget = wp && !dry && !frozenNow ? smooth(0.55, 0.95, level) : 0;
      whirlStrength += (wTarget - whirlStrength) * (1 - Math.exp(-rdt * 2));
      if (wp) {
        whirlU.set(wp.x, wp.z, wp.r, whirlStrength * Math.min(1.6, wp.strength / 2.4));
        const P = 2.2;
        const w0 = 0.85 * Math.min(1.6, wp.strength / 2.4);
        const ph = (time / P) % 1;
        const phB = (ph + 0.5) % 1;
        whirlSpin.set((ph - 0.5) * P * w0, (phB - 0.5) * P * w0, 1 - Math.abs(2 * ph - 1));
      }

      // -- movers: replicate (or follow) the sim mover clock
      let nMov = 0;
      if (moverWorld) {
        const ex = extras.get(view);
        const floating = moversFloat(river, config);
        const present = moversPresent(river, config);
        if (ex && performance.now() - ex.syncedAt < 600) moverClock = ex.syncedClock;
        else if (floating) moverClock += rdt;
        moverWorld.updateMovers(moverClock, present);
        if (floating && !frozenNow) {
          for (let i = 0; i < map.movers.length && nMov < MAX_MOVERS; i++) {
            const pz = moverWorld.moverPoses[i];
            const m = map.movers[i];
            movA[nMov].set(pz.ax, pz.az, pz.bx, pz.bz);
            movB[nMov].set(m.r, m.speed - map.river.flow * 0.6, 1, 0);
            nMov++;
          }
        }
      }
      su.uMovN.value = nMov;

      // -- falls: waterfall always pours, lock sluices pour while the lock floods
      let nPour = 0;
      const lift = night ? style.nightLift : style.nightLift * 0.3;
      for (const f of falls) {
        let s = 0;
        if (f.kind === 'waterfall') s = 1;
        else if (phase === 'rising') s = Math.min(1, (tide!.risingSec - river.phaseLeft) / 0.6) * Math.min(1, river.phaseLeft / 0.9);
        else if (phase === 'high') s = Math.max(0, 1 - (tide!.highSec - river.phaseLeft) / 1.2) * 0.4;
        s = Math.max(0, Math.min(1, s));
        f.sheet.update(time, levelY, s, lift);
        if (s > 0.01 && nPour < MAX_POURS) {
          const w = f.sheet.opts.width;
          const dz = f.sheet.opts.dir.y;
          pours[nPour].set(f.sheet.land.x, f.sheet.land.y + dz * 0.35, w * (f.kind === 'lock' ? 0.48 : 0.42), s * (f.kind === 'lock' ? 1 : 0.95));
          nPour++;
          // churn: a steady patter of ripples along the landing line
          const rate = (f.kind === 'lock' ? 5 : 3) * s * rdt;
          if (Math.random() < rate) {
            const side = (Math.random() - 0.5) * w * 0.9;
            ripples.add(f.sheet.land.x + side, f.sheet.land.y + dz * Math.random() * 0.6, 0.28 + Math.random() * 0.2, 0.5 + Math.random() * 0.4, true);
          }
        }
      }
      su.uPourN.value = nPour;

      // -- ambient plips (fish, swamp bubbles, drips) near where the camera looks
      if (!dry && !frozenNow && style.plips > 0 && level > 0.3) {
        plipAcc += rdt * style.plips * (tier === 0 ? 0.5 : 1);
        while (plipAcc > 1) {
          plipAcc -= 1;
          camera.getWorldPosition(focus);
          camera.getWorldDirection(tmpV);
          if (tmpV.y < -0.1) {
            const t = (levelY - focus.y) / tmpV.y;
            const px = focus.x + tmpV.x * t + (Math.random() - 0.5) * 26;
            const pz = focus.z + tmpV.z * t + (Math.random() - 0.5) * 18;
            const c = sampleField(field, field.chan, px, pz);
            if (c > 0.9) ripples.add(px, pz, 0.08 + Math.random() * 0.12, 0.25 + Math.random() * 0.25, true);
          }
        }
      }

      // -- ripples
      ripples.update(time);
      su.uRipN.value = ripples.count;

      // -- lighting from the engine's sun
      const sun = engine.sun;
      tmpV.subVectors(sun.position, sun.target.position);
      if (tmpV.lengthSq() > 1e-4) sunDir.copy(tmpV.normalize());
      sunCol.copy(sun.color).multiplyScalar(sun.intensity);
      // stylised glint direction: the sun folded in front of the camera so every map gets sparkle
      if (sunDir.z > -0.25) specDir.set(sunDir.x * 0.55, Math.max(0.55, sunDir.y * 0.8 + 0.25), -0.7).normalize();
      else specDir.copy(sunDir);
      irr.copy(sunCol).multiplyScalar(Math.max(sunDir.y, 0)).add(ambient).multiplyScalar(1 / Math.PI);
      const sunUpK = 0.2 * Math.max(0, sunDir.y);
      causticTint.copy(shallowLin).multiplyScalar(sunCol.g * sunUpK);
      (causticU.uCausticCol.value as THREE.Color).copy(sunCol).multiplyScalar(sunUpK).lerp(causticTint, 0.3);

      // -- camera + capture
      const pc = camera as THREE.PerspectiveCamera;
      if (pc.isPerspectiveCamera) camNF.set(pc.near, pc.far);
      camera.getWorldDirection(camFwd);
      const cap = engine.capture;
      if (cap && tier >= 1) {
        su.uHasCapture.value = 1;
        su.tColor.value = cap.color;
        su.tDepth.value = cap.depth;
      } else {
        su.uHasCapture.value = 0;
        su.tColor.value = null;
        su.tDepth.value = null;
      }

      // -- uniforms
      su.uTime.value = time;
      su.uLevelY.value = levelY - (freezeMap && freezeProg > 0 ? 0.05 * freezeProg : 0) - breakDip;
      su.uWaveDamp.value = waveDamp;
      su.uSurge.value = surge;
      su.uSurgePhase.value = surgePhase;
      su.uPuddleMode.value = puddleMode;
      // puddles and the low-tide film are thin and partly invisible: they must not write depth
      surfMat.depthWrite = puddleMode < 0.02;
      su.uFullY.value = fullY;
      causticU.uLevelY.value = su.uLevelY.value;
      if (caustics) caustics.visible = !dry && !(freezeMap && fullyFrozen) && level > 0.02;

      // -- planar reflection, ultra only: it re-renders the whole scene (measured ~10 ms extra on an
      // integrated GPU at 1280x960) and at this camera pitch it mostly shows sky, which the analytic
      // Fresnel sky already covers
      const q = engine.quality;
      const wantRefl = q === 'ultra' && surface.visible && pc.isPerspectiveCamera;
      if (wantRefl) {
        if (!reflection) reflection = new PlanarReflection(0.5);
        try {
          const ok = reflection.render(engine.renderer, engine.scene, pc, levelY);
          su.uHasReflect.value = ok ? 1 : 0;
          su.tReflect.value = reflection.target.texture;
          (su.uReflectMat.value as THREE.Matrix4).copy(reflection.textureMatrix);
        } catch {
          su.uHasReflect.value = 0;
          reflection.dispose();
          reflection = null;
        }
      } else {
        su.uHasReflect.value = 0;
        if (reflection) {
          reflection.dispose();
          reflection = null;
        }
      }
      firstUpdate = false;
    },

    disturb(x: number, z: number, strength: number, radius?: number): void {
      if (disposed) return;
      if (dry && !(sampleField(field, field.puddle, x, z) > 0.3)) return;
      ripples.add(x, z, strength, radius ?? 0.5 + strength * 1.1);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      surfGeo.dispose();
      surfMat.dispose();
      causticGeo?.dispose();
      if (caustics) (caustics.material as THREE.Material).dispose();
      if (ice) (ice.material as THREE.Material).dispose();
      for (const f of falls) f.sheet.dispose();
      puff.dispose();
      tex.dispose();
      field.texture.dispose();
      reflection?.dispose();
      group.clear();
    },
  };

  extras.set(view, { syncedClock: 0, syncedAt: -1e9 });
  return view;
}
