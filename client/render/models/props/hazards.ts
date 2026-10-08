// Hazards: thorns, bristles, quicksand, ice spikes, jellyfish, steam vents.
// The glue owns root.position (y is reset to ground every frame), so all motion lives on `body`.
import * as THREE from 'three';
import type { MapDef } from '../../../../shared/maps/types.ts';
import type { HazardInst } from '../../../../shared/sim/entities.ts';
import type { HazardView } from '../../contracts.ts';
import {
  blob, cachedModel, CH, curve, h3, mix, PGrid, pmat, pmatOwned, PROP_TIME, propsQuality, qLevel, rngFor, seg, setPropTime, shade, taper, toModel, uniformsOf, vn3,
  type PropModel,
} from './common.ts';
import { iceMat } from './rocks.ts';

// ---------------------------------------------------------------------------------------------
// Danger ring decal (per hazard material so it can flash)
// ---------------------------------------------------------------------------------------------

function dangerRing(r: number, color: number, fill: number): { mesh: THREE.Mesh; u: { uI: { value: number }; uColor: { value: THREE.Color } } } {
  const u = { uI: { value: 1 }, uColor: { value: new THREE.Color(color) } };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: PROP_TIME, uR: { value: r }, uFill: { value: fill }, ...u },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uR; uniform float uI; uniform float uFill; uniform vec3 uColor;
      varying vec2 vP;
      void main() {
        float d = length(vP);
        float a = atan(vP.y, vP.x);
        float rim = smoothstep(uR - 0.14, uR - 0.07, d) * (1.0 - smoothstep(uR - 0.04, uR, d));
        float dash = step(-0.2, sin(a * 18.0 + uTime * 1.2));
        float inner = smoothstep(uR * 0.4, uR, d) * uFill;
        float alpha = (rim * dash * 0.5 + inner) * uI;
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(r + 0.05, 48), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.09;
  mesh.renderOrder = 2;
  return { mesh, u };
}

function addModel(parent: THREE.Object3D, m: PropModel, shadow = true): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const q = qLevel(propsQuality()) >= 1;
  for (const p of m.parts) {
    const mesh = new THREE.Mesh(p.geo, p.mat);
    mesh.castShadow = q && shadow && p.shadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    out.push(mesh);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

function thornsModel(r: number, seed: number): PropModel {
  const V = 0.06;
  const rnd = rngFor(seed * 131 + 1);
  const rv = r / V;
  const n = Math.ceil(rv * 2 + 6);
  const g = new PGrid(n, 26, n);
  const c = n / 2;
  const soil = (x: number, y: number, z: number) => (h3(x, y, z) < 0.4 ? 0x2e241c : 0x3a2e22);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - c, z + 0.5 - c) / rv;
      if (d > 0.98 + (vn3(x * 0.2, 0, z * 0.2, seed) - 0.5) * 0.15) continue;
      g.set(x, 0, z, soil(x, 0, z));
      if (d < 0.7 && h3(x, 1, z, seed) < 0.3) g.set(x, 1, z, 0x4a3a28);
    }
  const canes = [0x4a2630, 0x3e3a24, 0x523028, 0x443020];
  g.on(CH.leaf, () => {
    const nc = Math.round(13 + rv * 0.45);
    for (let i = 0; i < nc; i++) {
      const a0 = rnd() * Math.PI * 2;
      const d0 = rnd() * rv * 0.4;
      const a1 = a0 + (rnd() - 0.5) * 1.8;
      const d1 = rv * (0.65 + rnd() * 0.3);
      const hgt = 11 + rnd() * 9;
      const p0: [number, number, number] = [c + Math.cos(a0) * d0, 1, c + Math.sin(a0) * d0];
      const p2: [number, number, number] = [c + Math.cos(a1) * d1, 1, c + Math.sin(a1) * d1];
      const p1: [number, number, number] = [(p0[0] + p2[0]) / 2, hgt * 1.6, (p0[2] + p2[2]) / 2];
      const col = canes[i % canes.length];
      curve(g, p0, p1, p2, 1.6, 0.8, (x, y, z) => shade(col, 0.88 + h3(x, y, z) * 0.22));
      // thorns, leaves and berries along the cane
      for (let k = 1; k < 9; k++) {
        const t = k / 9;
        const it = 1 - t;
        const x = it * it * p0[0] + 2 * it * t * p1[0] + t * t * p2[0];
        const y = it * it * p0[1] + 2 * it * t * p1[1] + t * t * p2[1];
        const z = it * it * p0[2] + 2 * it * t * p1[2] + t * t * p2[2];
        const ta = rnd() * Math.PI * 2;
        const tx = Math.cos(ta);
        const tz = Math.sin(ta);
        if (k % 2 === 0) {
          g.set(x + tx * 1.8, y + 0.5, z + tz * 1.8, 0x9a7a5a);
          g.set(x + tx * 2.6, y + 1, z + tz * 2.6, 0xd8c098);
        }
        if (k % 2 === 1 || rnd() < 0.3) {
          const lc = rnd() < 0.4 ? 0x3a5a26 : rnd() < 0.5 ? 0x4a6a2c : 0x2f4a20;
          const lx = Math.floor(x - tz * 2.5);
          const lz = Math.floor(z + tx * 2.5);
          g.box(lx, Math.floor(y), lz, lx + 2, Math.floor(y), lz + 1, lc);
          g.set(lx + 1, Math.floor(y) + 1, lz, shade(lc, 1.15));
        }
        if (k % 4 === 2 && rnd() < 0.6) {
          g.on(CH.base, () => {
            g.box(Math.floor(x), Math.floor(y - 2), Math.floor(z), Math.floor(x) + 1, Math.floor(y - 1), Math.floor(z) + 1, 0x4a1a4a);
            g.set(Math.floor(x), Math.floor(y - 1), Math.floor(z), 0x7a3a7a);
          });
        }
      }
    }
  });
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.35 }), [CH.leaf]: pmat({ rough: 0.8, sway: 0.025, swayH: 1.2 }) }, { pivot: [c, 0, c] });
}

function urchinModel(rad: number, seed: number): PropModel {
  const V = 0.04;
  const rnd = rngFor(seed * 137 + 3);
  const rv = rad / V;
  const spine = rv * 1.25;
  const n = Math.ceil((rv + spine) * 2 + 4);
  const g = new PGrid(n, n, n);
  const c = n / 2;
  blob(g, c, c, c, rv, rv * 0.88, rv, 0.06, seed, (x, y, z) => (h3(x, y, z) < 0.12 ? 0x6a3a8a : h3(x, y, z, 2) < 0.5 ? 0x2a1238 : 0x341844), 0.3);
  // long, sparse spines: thick purple base, pink shaft, glowing tip
  const ns = Math.round(rv * 3.2);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < ns; i++) {
    const yy = 1 - (i / (ns - 1)) * 1.6;
    if (yy < -0.55) continue;
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
    const a = i * golden + rnd() * 0.3;
    const dx = Math.cos(a) * rr;
    const dy = yy;
    const dz = Math.sin(a) * rr;
    const L = spine * (0.75 + rnd() * 0.45);
    const sx = c + dx * rv * 0.85;
    const sy = c + dy * rv * 0.8;
    const sz = c + dz * rv * 0.85;
    seg(g, sx, sy, sz, sx + dx * L * 0.35, sy + dy * L * 0.35, sz + dz * L * 0.35, 0x5a2478, 0.9);
    seg(g, sx + dx * L * 0.35, sy + dy * L * 0.35, sz + dz * L * 0.35, sx + dx * L * 0.85, sy + dy * L * 0.85, sz + dz * L * 0.85, (x, y2, z) => (h3(x, y2, z) < 0.5 ? 0xa83a9a : 0x8a2a88));
    g.on(CH.glow, () => seg(g, sx + dx * L * 0.86, sy + dy * L * 0.86, sz + dz * L * 0.86, sx + dx * L, sy + dy * L, sz + dz * L, 0xff7ae0));
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.35 }), [CH.glow]: pmat({ glow: 2.6, pulse: 0.5, rough: 0.3 }) }, { pivot: [c, c - rv * 0.6, c] });
}

function mudRim(r: number, seed: number): PropModel {
  const V = 0.07;
  const rnd = rngFor(seed * 149 + 3);
  const rv = r / V;
  const n = Math.ceil(rv * 2.3 + 6);
  const g = new PGrid(n, 14, n);
  const c = n / 2;
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - c;
      const dz = z + 0.5 - c;
      const d = Math.hypot(dx, dz) / rv;
      const wob = (vn3(x * 0.15, 0, z * 0.15, seed) - 0.5) * 0.12;
      if (d < 0.9 + wob || d > 1.12 + wob) continue;
      const hgt = 1 + Math.floor(vn3(x * 0.25, 1, z * 0.25, seed + 1) * 3 * (1 - Math.abs(d - 1.0 - wob) * 5));
      for (let y = 0; y <= hgt; y++) {
        const top = y === hgt;
        const c0 = top ? (h3(x, y, z) < 0.5 ? 0x5a4a36 : 0x66563e) : h3(x, y, z) < 0.5 ? 0x2e2218 : 0x3a2c1e;
        g.set(x, y, z, c0);
      }
    }
  // reed tufts and a sunk branch on the rim
  g.on(CH.leaf, () => {
    for (let k = 0; k < 5; k++) {
      const a = rnd() * Math.PI * 2;
      const x0 = c + Math.cos(a) * rv * 1.02;
      const z0 = c + Math.sin(a) * rv * 1.02;
      for (let b = 0; b < 4; b++) {
        const h = 6 + Math.floor(rnd() * 7);
        const ox = (rnd() - 0.5) * 3;
        const oz = (rnd() - 0.5) * 3;
        for (let y = 2; y < 2 + h; y++) g.set(x0 + ox + (y > h ? 1 : 0), y, z0 + oz, y > h - 1 ? 0x8a9a4a : 0x5a7a32);
      }
    }
  });
  const ba = rnd() * Math.PI * 2;
  seg(g, c + Math.cos(ba) * rv * 1.1, 3, c + Math.sin(ba) * rv * 1.1, c + Math.cos(ba) * rv * 0.6, 0, c + Math.sin(ba) * rv * 0.6, 0x4a3828, 0.9);
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.55 }), [CH.leaf]: pmat({ rough: 0.9, sway: 0.04, swayH: 0.8 }) }, { pivot: [c, 1, c] });
}

function rimRocks(r: number, seed: number, wet: boolean): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 139 + 9);
  const rv = r / V;
  const n = Math.ceil(rv * 2 + 10);
  const g = new PGrid(n, 10, n);
  const c = n / 2;
  const pal = wet ? [0x3a2e22, 0x4a3a2a, 0x2e241a] : [0x7a7468, 0x8a8478, 0x6a645a];
  const k = Math.round(rv * 0.9);
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2 + rnd() * 0.2;
    const d = rv * (0.98 + rnd() * 0.1);
    const s = 1.4 + rnd() * 1.6;
    const col = pal[i % pal.length];
    blob(g, c + Math.cos(a) * d, 1, c + Math.sin(a) * d, s, s * 0.7, s, 0.25, seed + i, (x, y, z) => shade(col, 0.9 + h3(x, y, z) * 0.2 + y * 0.03), 0.4);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: wet ? 0.35 : 0.85 }) }, { pivot: [c, 0, c] });
}

function icePatchModel(r: number, seed: number): PropModel {
  const V = 0.08;
  const rv = r / V;
  const n = Math.ceil(rv * 2 + 4);
  const g = new PGrid(n, 4, n);
  const c = n / 2;
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - c;
      const dz = z + 0.5 - c;
      const d = Math.hypot(dx, dz) / rv;
      if (d > 1 + (vn3(x * 0.25, 0, z * 0.25, seed) - 0.5) * 0.12) continue;
      const a = Math.atan2(dz, dx);
      // radial crack spokes + rings from the centre
      const spoke = Math.abs(Math.sin(a * 3.5 + vn3(x * 0.3, 0, z * 0.3, seed + 1) * 2.2)) < 0.12 && d > 0.1;
      const ring = Math.abs(d - 0.45 - vn3(x * 0.2, 1, z * 0.2, seed) * 0.12) < 0.04;
      const crack = spoke || ring;
      const top = d < 0.85 ? 1 : 0;
      for (let y = 0; y <= top; y++) {
        if (crack && y === top) g.on(CH.glow, () => g.set(x, y, z, 0x7ff0ff));
        else g.on(CH.ice, () => g.set(x, y, z, shade(d < 0.3 ? 0xa8dcf6 : 0xcdeefc, 0.94 + h3(x, y, z) * 0.1)));
      }
    }
  return toModel(g, V, { [CH.ice]: iceMat() }, { pivot: [c, 0, c] });
}

function iceSpikeModel(v: number): PropModel {
  const V = 0.06;
  const g = new PGrid(10, 34, 10);
  const h = 31 - v * 4;
  const tints = [0xe4f8ff, 0xbfe6fa, 0x9ad0f2];
  g.on(CH.ice, () => {
    for (let y = 0; y < h; y++) {
      const t = y / h;
      const rr = 3.4 * Math.pow(1 - t, 0.85) + 0.3;
      for (let z = 0; z < 10; z++)
        for (let x = 0; x < 10; x++) {
          const dx = Math.abs(x + 0.5 - 5);
          const dz = Math.abs(z + 0.5 - 5);
          if (Math.max(dz, dx * 0.866 + dz * 0.5) > rr) continue;
          const face = (dx > dz ? 0 : 1) + (x >= 5 ? 1 : 0);
          const deep = t < 0.25 ? mix(tints[face % 3], 0x4a8ac0, (0.25 - t) * 2.4) : tints[face % 3];
          g.set(x, y, z, t > 0.8 ? 0xf4fcff : deep);
        }
    }
  });
  return toModel(g, V, { [CH.ice]: pmat({ rough: 0.12, metal: 0.05, rim: 0.9, rimColor: 0x9fe6ff, glow: 0.35 }) }, { pivot: [5, 0, 5] });
}

function jellyModel(v: number): { bell: PropModel; tent: PropModel } {
  const V = 0.04;
  const cols = [0xff8ad8, 0xb08aff, 0x7ae8ff];
  const col = cols[v % 3];
  const bg = new PGrid(18, 12, 18);
  const c = 9;
  for (let y = 0; y < 9; y++) {
    const t = y / 8;
    const rr = 7.5 * Math.sqrt(Math.max(0, 1 - t * t)) + (y === 0 ? 0.8 : 0);
    for (let z = 0; z < 18; z++)
      for (let x = 0; x < 18; x++) {
        const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
        if (d > rr) continue;
        if (y === 0 && d < rr - 1.5) continue; // open underside
        const spot = h3(x, y, z, v) < 0.12;
        bg.set(x, y + 2, z, spot ? mix(col, 0xffffff, 0.6) : d < 3 && y > 4 ? mix(col, 0xffffff, 0.35) : col);
      }
  }
  // frilly rim
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    bg.set(c + Math.cos(a) * 8, k % 2 ? 1 : 2, c + Math.sin(a) * 8, mix(col, 0xffffff, 0.3));
  }
  const tg = new PGrid(18, 18, 18);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const rr = i % 2 ? 5 : 2.5;
    const L = 10 + (i % 3) * 3;
    for (let y = 0; y < L; y++) tg.set(c + Math.cos(a) * rr + Math.sin(y * 0.6 + i) * 0.9, 17 - y, c + Math.sin(a) * rr, y % 3 === 0 ? mix(col, 0xffffff, 0.5) : col);
  }
  return {
    bell: toModel(bg, V, { [CH.base]: pmat({ rough: 0.2, glow: 1.3, pulse: 0.35, transparent: true, opacity: 0.78, rim: 0.8, rimColor: col }) }, { pivot: [c, 0, c], shadow: false }),
    tent: toModel(tg, V, { [CH.base]: pmat({ rough: 0.3, glow: 1.0, transparent: true, opacity: 0.6, sway: 0.04, swayH: 0.7 }) }, { pivot: [c, 18, c], shadow: false }),
  };
}

function ventModel(r: number, seed: number): PropModel {
  const V = 0.06;
  const rv = r / V;
  const R = rv * 0.72;
  const n = Math.ceil(rv * 2 + 8);
  const g = new PGrid(n, 34, n);
  const c = n / 2;
  const brick = (x: number, y: number, z: number) => {
    const a = Math.atan2(z - c, x - c);
    const col = Math.floor((a + Math.PI) * 4 + (y % 2) * 0.5);
    return [0x7a3426, 0x8a3a2a, 0x9a4430, 0x6e2e22][(col + y * 3) % 4];
  };
  // brick collar (raised so ground noise never buries the pit)
  for (let y = 0; y < 6; y++)
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
        if (d > R + 3 - (y === 5 ? 1 : 0) || d < R) continue;
        g.set(x, y, z, y === 5 ? (h3(x, y, z) < 0.4 ? 0x8a867e : 0x9a968c) : brick(x, y, z));
      }
  // dark shaft walls and a glowing pit floor under the grate
  for (let y = 0; y < 3; y++)
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
        if (d < R && d > R - 1) g.set(x, y, z, 0x1a1410);
      }
  g.on(CH.glow, () => {
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
        if (d < R - 0.5) g.set(x, 2, z, d < R * 0.45 ? 0xffd890 : h3(x, 2, z) < 0.4 ? 0xff9a40 : 0xff7a30);
      }
  });
  // iron grate bars
  g.on(CH.metal, () => {
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
        if (d > R + 0.5) continue;
        const bar = (x - Math.floor(c)) % 3 === 0 || (z - Math.floor(c)) % 3 === 0 || d > R - 1;
        if (bar) g.set(x, 4, z, d > R - 1 ? 0x6a727a : (x + z) % 2 ? 0x4a525a : 0x545c64);
      }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      g.set(c + Math.cos(a) * (R + 1.5), 6, c + Math.sin(a) * (R + 1.5), 0x8a9098);
    }
    // standpipe with valve and whistle beside the grate
    const px = c + R + 1.5;
    const pz = c - 1;
    taper(g, px, pz, 2, 2, 0, 22, (x, y, z) => (vn3(x * 0.3, y * 0.3, z * 0.3, seed) > 0.7 ? 0x8a4a26 : h3(x, y, z) < 0.3 ? 0x4a5458 : 0x3e484c));
    taper(g, px, pz, 2.6, 2.6, 8, 8, 0x5a6268);
    taper(g, px, pz, 2.6, 2.6, 16, 16, 0x5a6268);
    seg(g, px, 22, pz, px, 25, pz, 0xb8903a, 0.9);
    taper(g, px, pz, 1.3, 0.6, 26, 29, 0xd8b050);
    for (let t = 0; t < 40; t++) {
      const a = (t / 40) * Math.PI * 2;
      g.set(px + Math.cos(a) * 3.5, 18, pz + Math.sin(a) * 3.5, 0xc8382a);
    }
    seg(g, px - 3.5, 18, pz, px + 3.5, 18, pz, 0xa82a20);
    seg(g, px, 18, pz - 3.5, px, 18, pz + 3.5, 0xa82a20);
  });
  // pressure gauge
  g.on(CH.glow2, () => {
    const gx = Math.floor(c + R + 1.5);
    const gz = Math.floor(c - 1 + 2.5);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) if (dx * dx + dy * dy <= 5) g.set(gx + dx, 12 + dy, gz, dx * dx + dy * dy > 3 ? 0xd8b050 : dx === 1 && dy === 1 ? 0xff3a2a : 0xf0ffe0);
  });
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.85 }), [CH.metal]: pmat({ metal: 0.7, rough: 0.45 }), [CH.glow2]: pmat({ glow: 1.4 }) }, { pivot: [c, 0, c], noShadowCh: [CH.glow, CH.glow2] });
}

// ---------------------------------------------------------------------------------------------
// Steam / frost particle bursts (vertex animated points, zero CPU per particle)
// ---------------------------------------------------------------------------------------------

let puffTex: THREE.Texture | null = null;
function puffTexture(): THREE.Texture {
  if (puffTex) return puffTex;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = 64;
  const x = cnv.getContext('2d')!;
  for (let i = 0; i < 6; i++) {
    const gx = 20 + Math.random() * 24;
    const gy = 20 + Math.random() * 24;
    const gr = x.createRadialGradient(gx, gy, 0, gx, gy, 18 + Math.random() * 8);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
  }
  puffTex = new THREE.CanvasTexture(cnv);
  return puffTex;
}

function burstPoints(count: number, r: number, color: number, o: { height: number; spread: number; size: number; life: number; additive?: boolean }): { pts: THREE.Points; uT: { value: number }; uA: { value: number } } {
  const seeds = new Float32Array(count * 4);
  const rnd = rngFor(count * 7 + Math.round(r * 10));
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = rnd() * Math.PI * 2;
    seeds[i * 4 + 1] = rnd();
    seeds[i * 4 + 2] = rnd();
    seeds[i * 4 + 3] = rnd() * 0.25;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const uT = { value: 99 };
  const uA = { value: 1 };
  const uScale = { value: 400 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uT, uA, uScale, uR: { value: r }, uH: { value: o.height }, uSpread: { value: o.spread }, uSize: { value: o.size }, uLife: { value: o.life }, uColor: { value: new THREE.Color(color) }, uMap: { value: puffTexture() } },
    vertexShader: /* glsl */ `
      uniform float uT; uniform float uScale; uniform float uR; uniform float uH; uniform float uSpread; uniform float uSize; uniform float uLife;
      attribute vec4 aSeed;
      varying float vA;
      varying float vRot;
      void main() {
        float t = (uT - aSeed.w) / uLife;
        vec3 p = vec3(0.0);
        float rr = sqrt(aSeed.y) * uR * 0.6;
        p.x = cos(aSeed.x) * rr;
        p.z = sin(aSeed.x) * rr;
        float rise = 1.0 - pow(1.0 - clamp(t, 0.0, 1.0), 2.0);
        p.y = rise * uH * (0.55 + 0.45 * aSeed.z);
        p.xz *= 1.0 + rise * uSpread;
        vA = (t > 0.0 && t < 1.0) ? (1.0 - t) * smoothstep(0.0, 0.08, t) : 0.0;
        vRot = aSeed.x * 3.0 + t * 2.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = vA > 0.0 ? uSize * (0.6 + rise * 1.4) * uScale / -mv.z : 0.0;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform vec3 uColor; uniform float uA;
      varying float vA; varying float vRot;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float s = sin(vRot), co = cos(vRot);
        c = vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;
        vec4 tx = texture2D(uMap, c);
        float a = tx.a * vA * uA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  const v2 = new THREE.Vector2();
  pts.onBeforeRender = (renderer, _s, camera) => {
    renderer.getDrawingBufferSize(v2);
    uScale.value = v2.y / (2 * Math.tan((((camera as THREE.PerspectiveCamera).fov ?? 45) * Math.PI) / 360));
  };
  return { pts, uT, uA };
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

interface Built {
  root: THREE.Group;
  body: THREE.Group;
  anim: (dt: number, time: number, cycle: { phase: number; warning: boolean; firing: boolean }, sub: number) => void;
  dispose: () => void;
}

function base(h: HazardInst, color: number, fill: number): { root: THREE.Group; body: THREE.Group; ring: ReturnType<typeof dangerRing> } {
  const root = new THREE.Group();
  root.name = 'hazard:' + h.kind;
  const body = new THREE.Group();
  root.add(body);
  const ring = dangerRing(h.r, color, fill);
  body.add(ring.mesh);
  return { root, body, ring };
}

function thornsView(h: HazardInst): Built {
  const { root, body, ring } = base(h, 0xd04a8a, 0.05);
  addModel(body, cachedModel(`hz|thorns|${h.r.toFixed(2)}|${h.id % 3}`, () => thornsModel(h.r, 11 + (h.id % 3))));
  return {
    root,
    body,
    anim(_dt, time) {
      ring.u.uI.value = 0.75 + 0.25 * Math.sin(time * 2 + h.id);
    },
    dispose() {
      ring.mesh.geometry.dispose();
      (ring.mesh.material as THREE.Material).dispose();
    },
  };
}

function bristlesView(h: HazardInst): Built {
  const { root, body, ring } = base(h, 0xff5ad0, 0.04);
  const rnd = rngFor(h.id * 17 + 5);
  const urchins: { g: THREE.Group; ph: number; s: number }[] = [];
  addModel(body, cachedModel(`hz|rocks|${h.r.toFixed(2)}`, () => rimRocks(h.r * 0.55, 3, false)));
  const count = 4 + (h.id % 2);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.5;
    const d = i === 0 ? 0 : h.r * (0.5 + rnd() * 0.22);
    const rad = i === 0 ? 0.36 : 0.22 + rnd() * 0.1;
    const v = i % 2;
    const m = cachedModel(`hz|urchin|${v}|${rad.toFixed(2)}`, () => urchinModel(rad, 5 + v));
    const g = new THREE.Group();
    g.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    g.rotation.y = rnd() * 6;
    addModel(g, m);
    body.add(g);
    urchins.push({ g, ph: rnd() * 6, s: 1 });
  }
  return {
    root,
    body,
    anim(_dt, time) {
      for (const u of urchins) {
        const k = 1 + Math.sin(time * 2.6 + u.ph) * 0.05;
        u.g.scale.set(k, 1 / k + 0.04 * Math.sin(time * 5.2 + u.ph), k);
      }
      ring.u.uI.value = 0.7 + 0.3 * Math.sin(time * 3 + h.id);
    },
    dispose() {
      ring.mesh.geometry.dispose();
      (ring.mesh.material as THREE.Material).dispose();
    },
  };
}

function quicksandView(h: HazardInst): Built {
  const { root, body, ring } = base(h, 0xc89a4a, 0.0);
  addModel(body, cachedModel(`hz|mudrim|${h.r.toFixed(2)}`, () => mudRim(h.r, 7)));
  // swirling mud surface
  const mudU = { uTime: PROP_TIME };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, mudU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vQ;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvQ = position.xy;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vQ;\nuniform float uTime;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float d = length(vQ) / ${h.r.toFixed(3)};
          float a = atan(vQ.y, vQ.x);
          float sw = a * 3.0 + d * 9.0 - uTime * 1.4;
          float band = 0.5 + 0.5 * sin(sw);
          float band2 = 0.5 + 0.5 * sin(a * 5.0 - d * 14.0 + uTime * 0.9);
          vec3 dark = vec3(0.035, 0.024, 0.014);
          vec3 mid = vec3(0.085, 0.06, 0.035);
          vec3 light = vec3(0.17, 0.125, 0.07);
          vec3 c = mix(dark, mid, band);
          c = mix(c, light, smoothstep(0.75, 1.0, band2) * 0.6);
          c *= 0.6 + 0.4 * smoothstep(0.0, 0.5, d);
          diffuseColor.rgb = c;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = 0.25 + 0.35 * smoothstep(0.0, 1.0, length(vQ));');
  };
  mat.customProgramCacheKey = () => 'hw-quicksand-' + h.r.toFixed(3);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(h.r * 0.98, 40), mat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.07;
  disc.receiveShadow = true;
  body.add(disc);
  // bubbles that swell and pop
  const bubGeo = new THREE.SphereGeometry(0.1, 8, 6);
  const bubMat = new THREE.MeshStandardMaterial({ color: 0x5a4228, roughness: 0.15 });
  const bubbles = new THREE.InstancedMesh(bubGeo, bubMat, 7);
  bubbles.frustumCulled = false;
  body.add(bubbles);
  const bub = Array.from({ length: 7 }, (_, i) => ({ ph: i / 7, x: 0, z: 0, i }));
  // debris spiralling into the middle
  const stickModel = cachedModel('hz|stick', () => {
    const g = new PGrid(14, 3, 3);
    g.box(0, 1, 1, 13, 1, 1, 0x6a4a2a);
    g.set(4, 2, 1, 0x6a4a2a);
    g.set(9, 0, 1, 0x4a8a30);
    return toModel(g, 0.05, { [CH.base]: pmat({ rough: 0.8 }) });
  });
  const stick = new THREE.Group();
  addModel(stick, stickModel, false);
  body.add(stick);
  const m4 = new THREE.Matrix4();
  return {
    root,
    body,
    anim(_dt, time) {
      for (const b of bub) {
        const t = (time * 0.35 + b.ph) % 1;
        if (t < 0.02 || b.x === 0) {
          const a = h3(b.i, Math.floor(time * 0.35 + b.ph), 3) * Math.PI * 2;
          const d = Math.sqrt(h3(b.i, Math.floor(time * 0.35 + b.ph), 5)) * h.r * 0.75;
          b.x = Math.cos(a) * d;
          b.z = Math.sin(a) * d;
        }
        const s = t < 0.85 ? 0.3 + t * 1.1 : 0.0;
        m4.makeScale(s, s * 0.75, s);
        m4.setPosition(b.x, 0.07, b.z);
        bubbles.setMatrixAt(b.i, m4);
      }
      bubbles.instanceMatrix.needsUpdate = true;
      const st = (time * 0.08 + h.id * 0.37) % 1;
      const sd = h.r * 0.8 * (1 - st);
      const sa = time * 0.6 + st * 9;
      stick.position.set(Math.cos(sa) * sd, 0.07 - st * st * 0.25, Math.sin(sa) * sd);
      stick.rotation.set(0, -sa, st * 0.8);
      stick.visible = st < 0.92;
      ring.u.uI.value = 0;
    },
    dispose() {
      ring.mesh.geometry.dispose();
      (ring.mesh.material as THREE.Material).dispose();
      disc.geometry.dispose();
      mat.dispose();
      bubGeo.dispose();
      bubMat.dispose();
      bubbles.dispose();
    },
  };
}

function iceSpikesView(h: HazardInst): Built {
  const { root, body, ring } = base(h, 0x7ff0ff, 0.03);
  const patch = cachedModel(`hz|icepatch|${h.r.toFixed(2)}`, () => icePatchModel(h.r, 21));
  // per-hazard crack material so each vent glows on its own timer
  const crackMat = pmatOwned({ glow: 0.5, rough: 0.2, tag: 'crack' + h.id });
  const meshes = addModel(body, patch);
  const glowIdx = patch.parts.findIndex((p) => p.ch === CH.glow);
  if (glowIdx >= 0) meshes[glowIdx].material = crackMat;
  const cu = uniformsOf(crackMat);
  const spikeModels = [0, 1, 2].map((v) => cachedModel(`hz|spike|${v}`, () => iceSpikeModel(v)));
  const rnd = rngFor(h.id * 23 + 1);
  const count = 9;
  const spikes: { a: number; d: number; s: number; tilt: number; yaw: number; delay: number; v: number }[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.5;
    spikes.push({ a, d: i === 0 ? 0 : h.r * (0.3 + rnd() * 0.55), s: i === 0 ? 1.25 : 0.7 + rnd() * 0.45, tilt: i === 0 ? 0 : 0.12 + rnd() * 0.2, yaw: rnd() * 6, delay: i === 0 ? 0 : rnd() * 0.06, v: i % 3 });
  }
  const ims = spikeModels.map((m, v) => {
    const n = spikes.filter((s) => s.v === v).length;
    const im = new THREE.InstancedMesh(m.parts[0].geo, m.parts[0].mat, Math.max(1, n));
    im.castShadow = qLevel(propsQuality()) >= 1;
    im.frustumCulled = false;
    body.add(im);
    return im;
  });
  const frost = burstPoints(26, h.r, 0xe8fbff, { height: 1.6, spread: 0.9, size: 0.55, life: 0.9, additive: false });
  body.add(frost.pts);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const period = h.period || 5;
  return {
    root,
    body,
    anim(_dt, time, cycle) {
      const ts = cycle.phase * period; // seconds since the last burst
      const toNext = period - ts;
      const warn = cycle.warning ? 1 - Math.max(0, toNext) / Math.max(0.01, h.telegraph || 1) : 0;
      // cracks glow brighter as the eruption nears, then flash
      const flash = ts < 0.25 ? 1 - ts / 0.25 : 0;
      cu.uGlow.value = 0.5 + warn * 3.5 + flash * 4;
      ring.u.uI.value = 0.6 + warn * 1.4 + flash;
      ring.u.uColor.value.setHex(warn > 0 || flash > 0 ? 0xbff8ff : 0x7ff0ff);
      // shake while warning
      const sh = warn * 0.035;
      body.position.x = Math.sin(time * 53) * sh;
      body.position.z = Math.cos(time * 47) * sh;
      const counters = [0, 0, 0];
      for (const s of spikes) {
        const t = ts - s.delay;
        let k = 0;
        if (t >= 0 && t < 0.09) k = (t / 0.09) * 1.18;
        else if (t >= 0.09 && t < 0.16) k = 1.18 - ((t - 0.09) / 0.07) * 0.18;
        else if (t >= 0.16 && t < 0.55) k = 1;
        else if (t >= 0.55 && t < 1.0) k = 1 - (t - 0.55) / 0.45;
        // a peek of tips during the warning
        if (warn > 0) k = Math.max(k, warn * 0.18);
        k = Math.max(0.001, k);
        e.set(Math.sin(s.a) * s.tilt, s.yaw, -Math.cos(s.a) * s.tilt);
        q.setFromEuler(e);
        p.set(Math.cos(s.a) * s.d, -0.15 * (1 - Math.min(1, k)), Math.sin(s.a) * s.d);
        sc.set(s.s * (0.6 + 0.4 * Math.min(1, k)), s.s * k, s.s * (0.6 + 0.4 * Math.min(1, k)));
        m4.compose(p, q, sc);
        ims[s.v].setMatrixAt(counters[s.v]++, m4);
      }
      for (const im of ims) im.instanceMatrix.needsUpdate = true;
      frost.uT.value = ts;
    },
    dispose() {
      ring.mesh.geometry.dispose();
      (ring.mesh.material as THREE.Material).dispose();
      crackMat.dispose();
      for (const im of ims) im.dispose();
      frost.pts.geometry.dispose();
      (frost.pts.material as THREE.Material).dispose();
    },
  };
}

function jellyfishView(h: HazardInst, _map: MapDef): Built {
  const { root, body, ring } = base(h, 0xff8ad8, 0.05);
  // a shallow tide pool so jellies have somewhere to live when the channel is dry
  addModel(body, cachedModel(`hz|poolrocks|${h.r.toFixed(2)}`, () => rimRocks(h.r * 0.98, 9, false)));
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(h.r * 0.95, 36),
    new THREE.MeshStandardMaterial({ color: 0x3ab8c8, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.55, emissive: 0x0a3a4a, depthWrite: false }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.08;
  pool.renderOrder = 1;
  body.add(pool);
  const rnd = rngFor(h.id * 29 + 3);
  const jellies: { g: THREE.Group; bell: THREE.Group; ph: number; a: number; d: number; sp: number; y: number }[] = [];
  const count = 5;
  for (let i = 0; i < count; i++) {
    const v = i % 3;
    const jm = cachedModel(`hz|jelly|bell|${v}`, () => jellyModel(v).bell);
    const tm = cachedModel(`hz|jelly|tent|${v}`, () => jellyModel(v).tent);
    const g = new THREE.Group();
    const bell = new THREE.Group();
    addModel(bell, jm, false);
    const tent = new THREE.Group();
    addModel(tent, tm, false);
    tent.position.y = 0.1;
    bell.add(tent);
    g.add(bell);
    const s = 0.8 + rnd() * 0.5;
    g.scale.setScalar(s);
    body.add(g);
    jellies.push({ g, bell, ph: rnd() * 6, a: rnd() * 6, d: h.r * (0.2 + rnd() * 0.55), sp: (0.15 + rnd() * 0.2) * (rnd() < 0.5 ? -1 : 1), y: 0.35 + rnd() * 0.5 });
  }
  return {
    root,
    body,
    anim(_dt, time) {
      for (const j of jellies) {
        const a = j.a + time * j.sp;
        const pulse = Math.sin(time * 2.2 + j.ph);
        j.g.position.set(Math.cos(a) * j.d, j.y + pulse * 0.12 + Math.sin(time * 0.7 + j.ph) * 0.08, Math.sin(a) * j.d);
        j.bell.scale.set(1 + pulse * 0.08, 1 - pulse * 0.1, 1 + pulse * 0.08);
        j.g.rotation.y = -a;
        j.g.rotation.z = Math.sin(time * 1.1 + j.ph) * 0.12;
      }
      ring.u.uI.value = 0.7 + 0.3 * Math.sin(time * 1.7 + h.id);
    },
    dispose() {
      ring.mesh.geometry.dispose();
      (ring.mesh.material as THREE.Material).dispose();
      pool.geometry.dispose();
      (pool.material as THREE.Material).dispose();
    },
  };
}

function steamVentView(h: HazardInst): Built {
  const { root, body, ring } = base(h, 0xff7a30, 0.03);
  const model = cachedModel(`hz|vent|${h.r.toFixed(2)}`, () => ventModel(h.r, 31));
  const pitMat = pmatOwned({ glow: 1, rough: 0.5, tag: 'vent' + h.id });
  const meshes = addModel(body, model);
  const pitIdx = model.parts.findIndex((p) => p.ch === CH.glow);
  if (pitIdx >= 0) meshes[pitIdx].material = pitMat;
  const pu = uniformsOf(pitMat);
  const steam = burstPoints(56, h.r * 0.75, 0xf4f6f8, { height: 5.2, spread: 0.7, size: 0.62, life: 1.2 });
  steam.pts.position.y = 0.3;
  body.add(steam.pts);
  const wisp = burstPoints(10, 0.15, 0xffffff, { height: 0.9, spread: 2.5, size: 0.35, life: 1.6 });
  wisp.pts.position.set(h.r * 0.72 + 0.09, 1.7, -0.06);
  body.add(wisp.pts);
  const period = h.period || 4;
  return {
    root,
    body,
    anim(_dt, time, cycle) {
      const ts = cycle.phase * period;
      const toNext = period - ts;
      const warn = cycle.warning ? 1 - Math.max(0, toNext) / Math.max(0.01, h.telegraph || 0.8) : 0;
      const blast = ts < 0.6 ? 1 - ts / 0.6 : 0;
      pu.uGlow.value = 0.8 + warn * 3 + blast * 3;
      ring.u.uI.value = 0.5 + warn * 1.5 + blast;
      const sh = warn * 0.03 + blast * 0.02;
      body.position.x = Math.sin(time * 61) * sh;
      body.position.z = Math.cos(time * 57) * sh;
      steam.uT.value = ts;
      wisp.uT.value = (time * 0.6) % 1.8;
      wisp.uA.value = 0.5 + warn;
    },
    dispose() {
      ring.mesh.geometry.dispose();
      (ring.mesh.material as THREE.Material).dispose();
      pitMat.dispose();
      for (const b of [steam, wisp]) {
        b.pts.geometry.dispose();
        (b.pts.material as THREE.Material).dispose();
      }
    },
  };
}

export function createHazardViewImpl(h: HazardInst, map: MapDef): HazardView {
  let b: Built;
  switch (h.kind) {
    case 'thorns':
      b = thornsView(h);
      break;
    case 'bristles':
      b = bristlesView(h);
      break;
    case 'quicksand':
      b = quicksandView(h);
      break;
    case 'icespikes':
      b = iceSpikesView(h);
      break;
    case 'jellyfish':
      b = jellyfishView(h, map);
      break;
    case 'steamvent':
    default:
      b = steamVentView(h);
      break;
  }
  let sub = 0; // 0 = up, 1 = fully submerged
  const { root, body } = b;
  return {
    root,
    update(dt, time, cycle, active) {
      setPropTime(time);
      sub += ((active ? 0 : 1) - sub) * Math.min(1, dt * 3);
      if (Math.abs(sub - (active ? 0 : 1)) < 0.002) sub = active ? 0 : 1;
      body.visible = sub < 0.999;
      if (!body.visible) return;
      body.position.y = -sub * 1.6;
      b.anim(dt, time, cycle, sub);
    },
    dispose() {
      b.dispose();
    },
  };
}

