// Runes (floating, spinning, pulsing pickups) and bramble mines.
import * as THREE from 'three';
import { RUNE_COLORS } from '../../../../shared/constants.ts';
import type { RuneType } from '../../../../shared/types.ts';
import type { AnimatedView } from '../../contracts.ts';
import { cachedModel, CH, curve, h3, halo, mix, PGrid, pmat, PROP_TIME, propsQuality, qLevel, rngFor, setPropTime, shade, toModel, type PropModel } from './common.ts';

/** Rune palette: main hue, light core, dark frame (shared with fx, minimap and HUD). */
export const RUNE_STYLE: Record<RuneType, { main: number; light: number; dark: number }> = RUNE_COLORS;

type Mask = (x: number, y: number) => number; // 0 empty, 1 frame, 2 core, 3 detail (dark)

function pointInPoly(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Turn a filled mask into frame (outline) and core. */
function framed(inside: (x: number, y: number) => boolean, detail?: (x: number, y: number) => boolean): Mask {
  return (x, y) => {
    if (!inside(x, y)) return 0;
    if (detail && detail(x, y)) return 3;
    const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
    return edge ? 1 : 2;
  };
}

const SHAPES: Record<RuneType, { mask: Mask; depth: number; frame?: number }> = {
  bendy: {
    // an eel swimming up in an S: wide head with an eye at the top, tapering to a forked tail fin
    mask: framed(
      (x, y) => {
        const cx = x + 0.5;
        const cy = y + 0.5;
        if (cy < 1 || cy > 20) return false;
        const mid = 10 + Math.sin((cy - 3) * 0.36) * 4.6;
        const w = cy > 15.5 ? 2.9 - Math.max(0, cy - 18.2) * 1.1 : 1.15 + (cy / 15.5) * 1.4;
        if (Math.abs(cx - mid) < w) return true;
        // forked tail
        if (cy < 3.2) {
          const t0 = 10 + Math.sin((3 - 3) * 0.36) * 4.6;
          return Math.abs(cx - t0 - (3.2 - cy) * 1.4) < 0.9 || Math.abs(cx - t0 + (3.2 - cy) * 1.4) < 0.9;
        }
        return false;
      },
      (x, y) => {
        const mid = 10 + Math.sin((y + 0.5 - 3) * 0.36) * 4.6;
        if (y === 17 && Math.abs(x + 0.5 - (mid + 1.1)) < 0.6) return true; // eye
        if (y === 15 && Math.abs(x + 0.5 - (mid + 1.6)) < 0.6) return true; // gill
        return y > 4 && y < 14 && y % 3 === 0 && Math.abs(x + 0.5 - mid) < 0.6; // spine spots
      },
    ),
    depth: 4,
    frame: 0.2,
  },
  bouncy: {
    // a coil spring on a base plate with a ball bouncing off the top
    mask: framed((x, y) => {
      const cx = x + 0.5;
      const cy = y + 0.5;
      if (cy > 1 && cy < 3.2 && Math.abs(cx - 10) < 6) return true; // base
      if (Math.hypot(cx - 10, cy - 16.8) < 3.4) return true; // ball
      if (cy >= 3.2 && cy <= 12.5) {
        const t = ((cy - 3.2) / 2.4) % 2;
        const zig = t < 1 ? 5 + t * 10 : 15 - (t - 1) * 10;
        return Math.abs(cx - zig) < 2.3;
      }
      return false;
    }, (x, y) => Math.hypot(x + 0.5 - 8.8, y + 0.5 - 18) < 0.9),
    depth: 4,
    frame: 0.12,
  },
  longshot: {
    // a long-shank fishing hook with an eye and a barb, speed lines trailing beside it
    mask: framed(
      (x, y) => {
        const cx = x + 0.5;
        const cy = y + 0.5;
        if (cy > 5 && cy < 17.5 && Math.abs(cx - 12.5) < 1.9) return true; // shank
        const er = Math.hypot(cx - 12.5, cy - 18.6);
        if (er < 2.4 && er > 0.9) return true; // eye
        const br = Math.hypot(cx - 9, cy - 5.6);
        if (cy <= 5.6 && br < 5.4 && br > 1.8) return true; // bend
        if (cy > 5.6 && cy < 10 && Math.abs(cx - 5.4) < 1.8) return true; // point
        if (cy > 7.2 && cy < 9.2 && cx > 5.4 && cx < 8.2 && cy - 7.2 > (cx - 5.4) * 0.6) return true; // barb
        if (cx > 15.5 && cx < 20 && (Math.abs(cy - 9) < 0.7 || Math.abs(cy - 12.5) < 0.7 || Math.abs(cy - 16) < 0.7) && cx > 15.5 + Math.abs(cy - 12.5) * 0.3) return true; // speed lines
        return false;
      },
    ),
    depth: 4,
    frame: 0.12,
  },
  haste: {
    // lightning bolt
    mask: framed((x, y) => pointInPoly(x + 0.5, y + 0.5, [[12, 20], [4, 9.5], [9, 9.5], [6, 0], [16, 12], [11, 12], [15, 20]])),
    depth: 5,
  },
  double: {
    // two overlapping diamonds
    mask: framed((x, y) => {
      const d1 = Math.abs(x + 0.5 - 7) + Math.abs(y + 0.5 - 10);
      const d2 = Math.abs(x + 0.5 - 13) + Math.abs(y + 0.5 - 10);
      return d1 <= 6.5 || d2 <= 6.5;
    }, (x, y) => Math.abs(x + 0.5 - 10) < 0.6 && Math.abs(y + 0.5 - 10) < 3.6),
    depth: 5,
  },
  ironskin: {
    // heater shield with a rivet cross
    mask: framed(
      (x, y) => {
        const cx = x + 0.5 - 10;
        const cy = y + 0.5;
        if (cy > 18 || cy < 1) return false;
        if (cy > 9) return Math.abs(cx) <= 7.5;
        const w = 7.5 * Math.sqrt(Math.max(0, (cy - 1) / 8));
        return Math.abs(cx) <= w;
      },
      (x, y) => (x === 10 || x === 9) && y > 4 && y < 16 ? true : (y === 12 || y === 11) && x > 4 && x < 15,
    ),
    depth: 5,
  },
  ghost: {
    // friendly ghost with a wavy hem and two eyes
    mask: framed(
      (x, y) => {
        const cx = x + 0.5 - 10;
        const cy = y + 0.5;
        if (cy > 10) return cx * cx + (cy - 10) * (cy - 10) <= 49;
        if (Math.abs(cx) > 7) return false;
        const hem = 2 + Math.sin((cx + 7) * 0.9) * 1.6;
        return cy >= hem;
      },
      (x, y) => (y === 11 || y === 12) && (x === 7 || x === 12),
    ),
    depth: 5,
  },
  bounty: {
    // coin with an embossed fish
    mask: framed(
      (x, y) => (x + 0.5 - 10) ** 2 + (y + 0.5 - 10) ** 2 <= 72,
      (x, y) => {
        const cx = x + 0.5 - 10;
        const cy = y + 0.5 - 10;
        const body = (cx + 1) * (cx + 1) / 16 + cy * cy / 6 <= 1;
        const tail = cx > 3 && cx < 6.5 && Math.abs(cy) < (cx - 3) * 0.9;
        const ring = Math.abs(Math.hypot(cx, cy) - 6.6) < 0.5;
        return body || tail || ring;
      },
    ),
    depth: 5,
  },
};

function runeModel(type: RuneType): PropModel {
  const V = 0.045;
  const st = RUNE_STYLE[type];
  const { mask, depth, frame = 0.45 } = SHAPES[type];
  const g = new PGrid(22, 22, depth + 4);
  const z0 = 2;
  for (let y = 0; y < 21; y++)
    for (let x = 0; x < 21; x++) {
      const m = mask(x, y);
      if (!m) continue;
      for (let z = z0; z < z0 + depth; z++) {
        const face = z === z0 || z === z0 + depth - 1;
        // thin power-up glyphs glow along their outline too (a dark metal frame would swallow the stroke)
        if (m === 1) g.on(frame < 0.3 ? CH.glow : CH.metal, () => g.set(x + 1, y + 1, z, shade(mix(st.main, st.dark, frame < 0.3 ? 0.42 : frame), 0.9 + h3(x, y, z) * 0.2)));
        else if (m === 3) g.on(CH.metal, () => g.set(x + 1, y + 1, z, face ? mix(st.main, st.dark, 0.3) : st.dark));
        else g.on(CH.glow, () => g.set(x + 1, y + 1, z, face ? mix(st.main, st.light, 0.25 + h3(x, y, z) * 0.25) : st.main));
      }
    }
  // bevel: raise the core one voxel on each face
  for (let y = 0; y < 21; y++)
    for (let x = 0; x < 21; x++) {
      if (mask(x, y) !== 2) continue;
      if (mask(x - 1, y) === 2 && mask(x + 1, y) === 2 && mask(x, y - 1) === 2 && mask(x, y + 1) === 2) {
        g.on(CH.glow, () => {
          g.set(x + 1, y + 1, z0 - 1, st.light);
          g.set(x + 1, y + 1, z0 + depth, st.light);
        });
      }
    }
  const ghost = type === 'ghost';
  return toModel(
    g,
    V,
    {
      [CH.metal]: pmat({ metal: type === 'ironskin' ? 0.9 : 0.6, rough: 0.3, transparent: ghost, opacity: ghost ? 0.8 : 1 }),
      [CH.glow]: pmat({ glow: ghost ? 2.2 : 3.4, pulse: 0.3, rough: 0.25, transparent: ghost, opacity: ghost ? 0.75 : 1 }),
    },
    { pivot: [11.5, 11, (depth + 4) / 2], noShadowCh: [] },
  );
}

const ringGeo = new THREE.CircleGeometry(0.9, 40);
const ringMats = new Map<string, THREE.ShaderMaterial>();
/** Soft additive glow pool under a floating pickup. Shared per colour. */
function glowPool(color: number, kind: 'pool' | 'dash'): THREE.ShaderMaterial {
  const key = color + kind;
  let m = ringMats.get(key);
  if (m) return m;
  m = new THREE.ShaderMaterial({
    uniforms: { uTime: PROP_TIME, uColor: { value: new THREE.Color(color) }, uDash: { value: kind === 'dash' ? 1 : 0 } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uDash; varying vec2 vP;
      void main(){
        float d = length(vP) / 0.9;
        float a = atan(vP.y, vP.x);
        float pool = (1.0 - smoothstep(0.0, 1.0, d)) * 0.55;
        float ring = smoothstep(0.72, 0.84, d) * (1.0 - smoothstep(0.88, 0.98, d));
        float dash = mix(1.0, step(0.0, sin(a * 8.0 - uTime * 2.0)), uDash);
        float pulse = 0.75 + 0.25 * sin(uTime * 3.0);
        float alpha = (pool * (1.0 - uDash) + ring * dash) * pulse;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor * alpha, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  ringMats.set(key, m);
  return m;
}

const moteGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07);
const moteMats = new Map<number, THREE.MeshBasicMaterial>();
function moteMat(color: number): THREE.MeshBasicMaterial {
  let m = moteMats.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.5) });
    moteMats.set(color, m);
  }
  return m;
}

export function createRuneViewImpl(type: RuneType): AnimatedView {
  const st = RUNE_STYLE[type];
  const model = cachedModel('rune|' + type, () => runeModel(type));
  const root = new THREE.Group();
  root.name = 'rune:' + type;
  // spin (yaw bursts) > tilt (face leans back toward the top-down camera) > model
  const spin = new THREE.Group();
  const tilt = new THREE.Group();
  tilt.rotation.x = -0.5;
  for (const p of model.parts) {
    const m = new THREE.Mesh(p.geo, p.mat);
    m.castShadow = qLevel(propsQuality()) >= 1;
    tilt.add(m);
  }
  spin.add(tilt);
  root.add(spin);
  const phase0 = Math.random() * 3.2;
  const h = halo(st.main, 2.1, 0.55);
  const core = halo(st.light, 0.8, 0.7);
  root.add(h, core);
  const pool = new THREE.Mesh(ringGeo, glowPool(st.main, 'pool'));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.06;
  pool.renderOrder = 2;
  root.add(pool);
  const motes: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(moteGeo, moteMat(i % 2 ? st.light : st.main));
    root.add(m);
    motes.push(m);
  }
  let age = 0;
  return {
    root,
    update(dt, time) {
      setPropTime(time);
      age += dt;
      const appear = Math.min(1, age / 0.35);
      const pop = appear < 1 ? 1 + Math.sin(appear * Math.PI) * 0.35 : 1;
      const bob = Math.sin(time * 2.4) * 0.12;
      const y = 0.95 + bob;
      spin.position.y = y;
      // hold facing the camera, then a quick full spin every few seconds
      const cyc = ((time + phase0) % 3.2) / 3.2;
      const sp = cyc < 0.24 ? cyc / 0.24 : 0;
      const ease = sp * sp * (3 - 2 * sp);
      spin.rotation.y = ease * Math.PI * 2 + Math.sin(time * 1.4) * 0.28;
      spin.rotation.z = Math.sin(time * 1.3) * 0.08;
      const s = appear * pop * (1 + Math.sin(time * 4.2) * 0.04);
      spin.scale.setScalar(s);
      h.position.y = y;
      core.position.y = y;
      h.scale.setScalar(2.1 * appear * (0.9 + 0.15 * Math.sin(time * 3.1)));
      core.scale.setScalar(0.8 * appear);
      pool.scale.setScalar(appear * (1 - bob * 0.6));
      for (let i = 0; i < motes.length; i++) {
        const a = time * 2.2 + (i / motes.length) * Math.PI * 2;
        const rr = 0.55 + Math.sin(time * 1.7 + i) * 0.08;
        motes[i].position.set(Math.cos(a) * rr, y + Math.sin(a * 2 + i) * 0.25, Math.sin(a) * rr);
        motes[i].rotation.set(a, a * 1.3, 0);
        motes[i].scale.setScalar(appear);
      }
    },
    dispose() {
      // geometry and materials are shared caches; nothing per-instance to free
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Bramble mine
// ---------------------------------------------------------------------------------------------

function mineModel(): PropModel {
  const V = 0.035;
  const rnd = rngFor(777);
  const g = new PGrid(22, 14, 22);
  const c = 11;
  // half-buried soil mound
  for (let z = 0; z < 22; z++)
    for (let x = 0; x < 22; x++) {
      const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
      if (d < 9 && h3(x, 0, z) < 0.85 - d * 0.05) g.set(x, 0, z, h3(x, 1, z) < 0.5 ? 0x3a2e22 : 0x4a3a2a);
    }
  // glowing seed core
  g.on(CH.glow, () => {
    for (let z = c - 3; z <= c + 3; z++)
      for (let y = 1; y <= 6; y++)
        for (let x = c - 3; x <= c + 3; x++) {
          const d = ((x + 0.5 - c) ** 2 + (z + 0.5 - c) ** 2) / 7.5 + ((y + 0.5 - 3.4) ** 2) / 6;
          if (d <= 1) g.set(x, y, z, d < 0.45 ? 0xf0ffb0 : (x + y + z) % 2 ? 0xd8ff6a : 0xb8f040);
        }
  });
  // tangle of thorny canes around the core
  g.on(CH.leaf, () => {
    for (let i = 0; i < 9; i++) {
      const a0 = rnd() * Math.PI * 2;
      const a1 = a0 + 1.5 + rnd() * 1.5;
      const r0 = 5 + rnd() * 2;
      curve(g, [c + Math.cos(a0) * r0, 1, c + Math.sin(a0) * r0], [c + Math.cos((a0 + a1) / 2) * (r0 + 1), 8 + rnd() * 4, c + Math.sin((a0 + a1) / 2) * (r0 + 1)], [c + Math.cos(a1) * r0, 1, c + Math.sin(a1) * r0], 0.5, 0.5, i % 2 ? 0x4a3a26 : 0x3e4a22);
    }
    for (let k = 0; k < 18; k++) {
      const a = rnd() * Math.PI * 2;
      const y = 3 + Math.floor(rnd() * 7);
      const rr = 6.5 + rnd();
      g.set(c + Math.cos(a) * rr, y, c + Math.sin(a) * rr, 0xe8d8b0);
    }
    // two leaves
    g.box(c + 5, 6, c - 1, c + 7, 6, c, 0x4a7a2e);
    g.box(c - 7, 5, c + 1, c - 5, 5, c + 2, 0x3e6a28);
  });
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.95 }), [CH.leaf]: pmat({ rough: 0.8 }), [CH.glow]: pmat({ glow: 2.4, pulse: 0.8, rough: 0.4 }) }, { pivot: [c, 1, c], noShadowCh: [CH.glow] });
}

const mineRingGeo = new THREE.CircleGeometry(0.9, 40);

/** Bramble mine. Only allies ever receive mines; `own` marks the local player's mines (brighter ring). */
export function createMineViewImpl(own: boolean): THREE.Object3D {
  const model = cachedModel('mine', mineModel);
  const root = new THREE.Group();
  root.name = 'mine';
  for (const p of model.parts) {
    const m = new THREE.Mesh(p.geo, p.mat);
    m.castShadow = p.shadow;
    m.receiveShadow = true;
    root.add(m);
  }
  const ring = new THREE.Mesh(mineRingGeo, glowPool(own ? 0xb09030 : 0x2e7a5a, 'dash'));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  ring.scale.setScalar(own ? 0.85 : 0.7);
  ring.renderOrder = 2;
  root.add(ring);
  return root;
}
