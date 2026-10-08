// Home fountains: a team-coloured centrepiece themed to the biome (well, crystal, clam, brazier)
// with a terrain-hugging healing aura ring of radius circle.r and rising motes.
import * as THREE from 'three';
import type { Circle, MapDef } from '../../../../shared/maps/types.ts';
import type { Team } from '../../../../shared/types.ts';
import { groundY, TEAM_COLORS, type AnimatedView, type HeightFn } from '../../contracts.ts';
import { blob, blotch, cachedModel, CH, h3, halo, mix, PGrid, pmat, PROP_TIME, propsQuality, qLevel, rngFor, seg, setPropTime, shade, taper, toModel, vn3, type PropModel } from './common.ts';

type Theme = 'well' | 'crystal' | 'clam' | 'brazier';
function themeOf(map: MapDef): Theme {
  switch (map.id) {
    case 'frostfang':
      return 'crystal';
    case 'coralcove':
      return 'clam';
    case 'cogwater':
      return 'brazier';
    default:
      return 'well';
  }
}

// ---------------------------------------------------------------------------------------------
// Centrepiece models (static part). Animated parts are separate meshes.
// ---------------------------------------------------------------------------------------------

function wellModel(team: Team): PropModel {
  const V = 0.08;
  const tc = TEAM_COLORS[team];
  const n = 40;
  const g = new PGrid(n, 46, n);
  const c = n / 2;
  const R = 12;
  const stone = blotch([0x6a6a60, 0x76766a, 0x828275, 0x5e5f57], 0.25, 3, 0.3);
  for (let y = 0; y < 11; y++)
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
        if (d > R || d < R - 3) continue;
        const a = Math.atan2(z - c, x - c);
        const brick = Math.floor((a + Math.PI) * 3.2 + (Math.floor(y / 3) % 2) * 0.5);
        const joint = y % 3 === 0 || ((a + Math.PI) * 3.2 + (Math.floor(y / 3) % 2) * 0.5) % 1 < 0.1;
        let col = joint ? 0x4a4a42 : shade(stone(brick, y, 0), 0.95 + h3(brick, Math.floor(y / 3), 1) * 0.12);
        if (y > 7 && h3(x, y, z) < 0.3) col = mix(col, 0x5a7a2e, 0.7);
        g.set(x, y, z, col);
      }
  // coping stones
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
      if (d <= R + 0.6 && d >= R - 3.4) g.set(x, 11, z, h3(x, 11, z) < 0.4 ? 0x8a8a7e : 0x9a9a8c);
    }
  // glowing team water inside
  g.on(CH.glow, () => {
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
        if (d < R - 3) g.set(x, 7, z, d < 4 ? tc.light : h3(x, 7, z) < 0.3 ? tc.light : tc.main);
      }
  });
  // posts, crossbeam, winch and a little shingled roof in team colours
  const wood = (x: number, y: number, z: number) => shade(0x6a4a2a, 0.88 + vn3(x * 0.3, y * 0.1, z * 0.3, 2) * 0.24);
  for (const s of [-1, 1]) g.box(c + s * (R - 1) - 1, 11, c - 1, c + s * (R - 1), 32, c, wood);
  g.box(c - R + 1, 30, c - 1, c + R - 1, 31, c, wood);
  for (let t = 0; t < 40; t++) {
    const a = (t / 40) * Math.PI * 2;
    g.set(c + Math.cos(a) * 1.5, 30.5 + Math.sin(a) * 1.5, c + 1, 0xc8a46a);
  }
  // steep little gable roof: dark team shingles in rows, light ridge cap
  for (let k = 0; k < 8; k++) {
    const y = 32 + k;
    const hw = 7.5 - k * 0.95;
    g.box(Math.floor(c - R + 1), y, Math.floor(c - hw), Math.ceil(c + R - 2), y, Math.ceil(c + hw - 1), (x, yy, z) => {
      const edge = Math.abs(z + 0.5 - c) > hw - 1.2;
      const row = (yy + (x % 2)) % 2 === 0;
      return edge ? shade(row ? tc.main : tc.dark, 0.85 + h3(x, yy, z) * 0.15) : shade(tc.dark, 0.55 + h3(x, yy, z) * 0.1);
    });
  }
  g.box(Math.floor(c - R), 40, c - 1, Math.ceil(c + R - 1), 40, c, (x, y, z) => shade(tc.light, 0.85 + h3(x, y, z) * 0.15));
  // rope down to the water
  for (let y = 12; y < 30; y++) g.set(c, y, c + 1, y % 2 ? 0xc8a46a : 0xa88a50);
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.88 }), [CH.glow]: pmat({ glow: 1.8, pulse: 0.25, rough: 0.1 }) }, { pivot: [c, 0, c] });
}

function plinthModel(team: Team): PropModel {
  const V = 0.08;
  const tc = TEAM_COLORS[team];
  const n = 36;
  const g = new PGrid(n, 14, n);
  const c = n / 2;
  const granite = blotch([0x545b66, 0x5e6571, 0x69707b, 0x4b525d], 0.25, 4, 0.3);
  for (let y = 0; y < 10; y++) {
    const R = y < 3 ? 15 : y < 7 ? 12 : 10;
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const dx = Math.abs(x + 0.5 - c);
        const dz = Math.abs(z + 0.5 - c);
        if (Math.max(dz, dx * 0.866 + dz * 0.5) > R) continue;
        const rim = Math.max(dz, dx * 0.866 + dz * 0.5) > R - 1;
        const rune = rim && y >= 4 && y <= 5 && h3(Math.floor(x / 2), y, Math.floor(z / 2)) < 0.45;
        if (rune) g.on(CH.glow, () => g.set(x, y, z, tc.light));
        else g.set(x, y, z, granite(x, y, z));
      }
  }
  // snow on the steps
  g.recolor((col, x, y, z) => (g.chanAt(x, y, z) === CH.base && (y === 2 || y === 6 || y === 9) && h3(x, y, z, 5) < 0.6 ? 0xf2f8ff : col));
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.9 }), [CH.glow]: pmat({ glow: 2.6, pulse: 0.4 }) }, { pivot: [c, 0, c] });
}

function crystalModel(team: Team, small: boolean): PropModel {
  const V = 0.07;
  const tc = TEAM_COLORS[team];
  const R = small ? 2.4 : 5.5;
  const H = small ? 9 : 26;
  const n = Math.ceil(R * 2 + 4);
  const g = new PGrid(n, H + 2, n);
  const c = n / 2;
  for (let y = 0; y <= H; y++) {
    const t = y / H;
    const rr = R * (t < 0.3 ? 0.4 + t * 2 : t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35);
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const dx = Math.abs(x + 0.5 - c);
        const dz = Math.abs(z + 0.5 - c);
        const d = Math.max(dz, dx * 0.866 + dz * 0.5);
        if (d > rr) continue;
        const face = Math.floor(((Math.atan2(z - c, x - c) + Math.PI) / (Math.PI * 2)) * 6);
        const col = face % 2 ? tc.main : mix(tc.main, tc.light, 0.55);
        g.on(CH.glow, () => g.set(x, y, z, d > rr - 1 ? shade(col, 0.9 + h3(x, y, z) * 0.15) : tc.light));
      }
  }
  return toModel(g, V, { [CH.glow]: pmat({ glow: 1.7, pulse: 0.3, rough: 0.12, rim: 1.2, rimColor: 0xffffff }) }, { pivot: [c, H / 2, c] });
}

function clamModel(team: Team): PropModel {
  const V = 0.08;
  const n = 44;
  const g = new PGrid(n, 30, n);
  const c = n / 2;
  const sand = (x: number, y: number, z: number) => (h3(x, y, z) < 0.3 ? 0xe2cf9c : 0xeedcae);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - c, z + 0.5 - c) / 20;
      if (d > 1) continue;
      const hh = Math.floor((1 - d * d) * 4);
      for (let y = 0; y <= hh; y++) g.set(x, y, z, sand(x, y, z));
    }
  // two scalloped shell halves: a ridged bowl and a fan-shaped lid hinged open at the back
  const R = 13;
  const ridge = (a: number) => Math.sin(a * 11) > 0.25;
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - c;
      const dz = z + 0.5 - c;
      const d = Math.hypot(dx, dz);
      const a = Math.atan2(dz, dx);
      const Rs = R + Math.cos(a * 11) * 0.9;
      if (d > Rs) continue;
      const yb = 4 + Math.floor((d / R) * (d / R) * 4);
      const outer = ridge(a) ? 0xffc8c0 : 0xfff0e6;
      g.set(x, yb, z, d < R - 1.5 ? (d < 9 ? 0xffb8c8 : 0xffd2da) : outer);
      g.set(x, yb - 1, z, shade(outer, 0.85));
      if (d > Rs - 1.2) g.set(x, yb + 1, z, shade(outer, 1.04));
    }
  // lid: fan in a plane tilted ~62 degrees, hinged along the back edge of the bowl
  const hz = c - R * 0.82;
  const sinT = Math.sin(1.08);
  const cosT = Math.cos(1.08);
  for (let v = 0; v <= R; v += 0.5)
    for (let u = -R; u <= R; u += 0.5) {
      const dd = Math.hypot(u, v);
      const a = Math.atan2(v, u);
      const Rs = R + Math.cos(a * 11) * 0.9;
      if (dd > Rs) continue;
      for (let t = 0; t < 2; t++) {
        const x = c + u;
        const y = 8 + v * sinT + t * cosT;
        const z = hz - v * cosT + t * sinT;
        const inner = t === 1;
        const col = inner ? (dd < R - 1.5 ? 0xffb8c8 : 0xffd2da) : ridge(a) ? 0xffc8c0 : 0xfff0e6;
        g.set(x, y, z, col);
      }
    }
  // corals around the base
  const corals = [0xff6f86, 0xff8f5a, 0xb07ae8];
  const rnd = rngFor(17 + team);
  for (let k = 0; k < 5; k++) {
    const a = rnd() * Math.PI * 2;
    const x = c + Math.cos(a) * 17;
    const z = c + Math.sin(a) * 17;
    const col = corals[k % 3];
    for (let b = 0; b < 3; b++) seg(g, x, 2, z, x + (rnd() - 0.5) * 6, 8 + rnd() * 4, z + (rnd() - 0.5) * 6, col, 0.7);
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.45 }) }, { pivot: [c, 0, c] });
}

function pearlModel(team: Team): PropModel {
  const V = 0.06;
  const tc = TEAM_COLORS[team];
  const g = new PGrid(16, 16, 16);
  g.on(CH.glow, () => blob(g, 8, 8, 8, 6.5, 6.5, 6.5, 0, 1, (x, y, z) => (y > 10 && x < 8 ? 0xffffff : h3(x, y, z) < 0.3 ? tc.main : tc.light)));
  return toModel(g, V, { [CH.glow]: pmat({ glow: 2.2, pulse: 0.3, rough: 0.1, rim: 1.4, rimColor: 0xffffff }) }, { pivot: [8, 8, 8] });
}

function brazierModel(): PropModel {
  const V = 0.08;
  const n = 34;
  const g = new PGrid(n, 30, n);
  const c = n / 2;
  const stone = blotch([0x6a6660, 0x7a766e, 0x86827a], 0.3, 6, 0.3);
  // stepped stone base
  for (let y = 0; y < 5; y++) taper(g, c, c, y < 2 ? 15 : 12, y < 2 ? 15 : 12, y, y, stone);
  g.on(CH.metal, () => {
    // three iron legs
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      seg(g, c + Math.cos(a) * 9, 5, c + Math.sin(a) * 9, c + Math.cos(a) * 6, 15, c + Math.sin(a) * 6, 0x2a2f36, 1);
    }
    // riveted brass bowl
    for (let y = 14; y < 22; y++) {
      const t = (y - 14) / 8;
      const rr = 4 + t * 7;
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++) {
          const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
          if (d > rr || (d < rr - 1.6 && y > 15)) continue;
          const rivet = y === 20 && Math.floor((Math.atan2(z - c, x - c) + Math.PI) * 4) % 2 === 0;
          g.set(x, y, z, rivet ? 0xf0d070 : y === 21 ? 0xd8b050 : h3(x, y, z) < 0.25 ? 0x9a7030 : 0xb8903a);
        }
    }
  });
  // coals
  g.on(CH.glow, () => {
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
        if (d < 9) g.set(x, 19 + (h3(x, 0, z) < 0.4 ? 1 : 0), z, h3(x, 1, z) < 0.5 ? 0xff7a30 : 0xffb050);
      }
  });
  // a gear leaning on the base
  for (let t = 0; t < 1; t += 0.01) {
    const a = t * Math.PI * 2;
    const rr = Math.cos(a * 10) > 0 ? 4.5 : 3.6;
    g.on(CH.metal, () => g.set(c + 13, 5 + Math.sin(a) * rr + 4, c + Math.cos(a) * rr, 0xb8903a));
  }
  return toModel(g, V, { [CH.base]: pmat({ rough: 0.9 }), [CH.metal]: pmat({ metal: 0.85, rough: 0.32 }), [CH.glow]: pmat({ glow: 2.6, flicker: 0.4 }) }, { pivot: [c, 0, c] });
}

function flameModel(team: Team, v: number): PropModel {
  const V = 0.06;
  const tc = TEAM_COLORS[team];
  const g = new PGrid(24, 34, 24);
  const c = 12;
  const rnd = rngFor(v * 13 + 1);
  // several licking tongues around a hot core: white at the root, team light, team main at the tips
  const tongues: [number, number, number, number, number][] = [[0, 0, 4.2, 26, 0]];
  const nt = v === 0 ? 6 : 5;
  for (let i = 0; i < nt; i++) {
    const a = (i / nt) * Math.PI * 2 + v * 0.5 + rnd() * 0.3;
    const d = 3.2 + rnd() * 1.6;
    tongues.push([Math.cos(a) * d, Math.sin(a) * d, 2.2 + rnd() * 0.9, 12 + rnd() * 12, a]);
  }
  g.on(CH.glow, () => {
    for (const [ox, oz, r0, h, a] of tongues) {
      const lean = 0.06 + rnd() * 0.05;
      for (let y = 0; y < h; y++) {
        const t = y / h;
        const rr = r0 * Math.pow(1 - t, 0.9) * (t < 0.15 ? 0.7 + t * 2 : 1) + 0.35;
        const cx = c + ox * (1 - t * 0.3) + Math.sin(t * 5 + a + v) * 1.1 * t + Math.cos(a) * lean * y;
        const cz = c + oz * (1 - t * 0.3) + Math.sin(a) * lean * y;
        for (let z = Math.floor(cz - rr - 1); z <= cz + rr + 1; z++)
          for (let x = Math.floor(cx - rr - 1); x <= cx + rr + 1; x++) {
            const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
            if (d > rr) continue;
            const hot = d < rr * 0.35 && t < 0.3;
            g.set(x, y, z, hot ? mix(tc.light, 0xffffff, 0.6) : t < 0.5 ? tc.light : t < 0.78 ? mix(tc.light, tc.main, 0.5) : tc.main);
          }
      }
    }
  });
  return toModel(g, V, { [CH.glow]: pmat({ glow: 1.5, flicker: 0.45, transparent: true, opacity: 0.82 }) }, { pivot: [c, 0, c], noShadowCh: [CH.glow] });
}

// ---------------------------------------------------------------------------------------------
// Aura ring that hugs the terrain
// ---------------------------------------------------------------------------------------------

function fallbackHeight(map: MapDef): HeightFn {
  // Flat bank top. Terrain levels the ground around the fountains, so this is within a few cm;
  // pass the real height function as createFountainView's 4th argument to hug it exactly.
  const top = groundY(map);
  return () => top;
}

function auraRing(c: Circle, team: Team, height: HeightFn, baseY: number): { group: THREE.Group; u: { uPulse: { value: number } }; dispose: () => void } {
  const tc = TEAM_COLORS[team];
  const seg = 128;
  const rings = 10;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const rr = (j / rings) * c.r;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      pos.push(x, height(c.x + x, c.z + z) - baseY + 0.07, z);
      uv.push(i / seg, j / rings);
    }
  }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + seg + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const u = { uPulse: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: PROP_TIME, uColor: { value: new THREE.Color(tc.main) }, uLight: { value: new THREE.Color(tc.light) }, ...u },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform vec3 uLight; uniform float uPulse;
      varying vec2 vUv;
      void main(){
        float d = vUv.y;
        float a = vUv.x * 6.2831853;
        float rim = smoothstep(0.9, 0.975, d) * (1.0 - smoothstep(0.985, 1.0, d));
        float glyph = step(0.6, fract(vUv.x * 48.0 - uTime * 0.12)) * smoothstep(0.855, 0.87, d) * (1.0 - smoothstep(0.885, 0.9, d));
        float wave = smoothstep(0.06, 0.0, abs(d - fract(uTime * 0.28))) * d;
        float fill = 0.05 + 0.04 * sin(uTime * 1.6);
        float a1 = rim * (0.8 + 0.2 * sin(uTime * 2.0)) + glyph * 0.4 + wave * 0.35 + fill * smoothstep(0.2, 0.9, d) + uPulse * 0.2;
        vec3 col = mix(uColor, uLight, rim * 0.6 + wave);
        gl_FragColor = vec4(col * a1, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  // a soft glowing curtain at the rim so the circle reads from the angled camera
  const cpos: number[] = [];
  const cuv: number[] = [];
  const cidx: number[] = [];
  const ch = 0.55;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const x = Math.cos(a) * c.r;
    const z = Math.sin(a) * c.r;
    const y = height(c.x + x, c.z + z) - baseY;
    cpos.push(x, y - 0.05, z, x, y + ch, z);
    cuv.push(i / seg, 0, i / seg, 1);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    cidx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  const cgeo = new THREE.BufferGeometry();
  cgeo.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
  cgeo.setAttribute('uv', new THREE.Float32BufferAttribute(cuv, 2));
  cgeo.setIndex(cidx);
  const cmat = new THREE.ShaderMaterial({
    uniforms: { uTime: PROP_TIME, uColor: { value: new THREE.Color(tc.light) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      void main(){
        float f = pow(1.0 - vUv.y, 2.2);
        float shimmer = 0.75 + 0.25 * sin(vUv.x * 80.0 + uTime * 3.0) * sin(vUv.x * 23.0 - uTime * 1.3);
        gl_FragColor = vec4(uColor * f * shimmer * 0.42, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const curtain = new THREE.Mesh(cgeo, cmat);
  curtain.renderOrder = 2;
  curtain.frustumCulled = false;
  const group = new THREE.Group();
  group.add(mesh, curtain);
  return {
    group,
    u,
    dispose() {
      geo.dispose();
      mat.dispose();
      cgeo.dispose();
      cmat.dispose();
    },
  };
}

function healMotes(c: Circle, team: Team, height: HeightFn, baseY: number, count: number): { pts: THREE.Points; dispose: () => void } {
  const tc = TEAM_COLORS[team];
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const rnd = rngFor(91 + team);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * c.r * 0.95;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    pos[i * 3] = x;
    pos[i * 3 + 1] = height(c.x + x, c.z + z) - baseY;
    pos[i * 3 + 2] = z;
    seed[i] = rnd();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const uScale = { value: 400 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: PROP_TIME, uScale, uColor: { value: new THREE.Color(tc.light) } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uScale; attribute float aSeed; varying float vA;
      void main(){
        float t = fract(uTime * (0.22 + aSeed * 0.12) + aSeed * 7.0);
        vec3 p = position;
        p.y += t * (1.8 + aSeed * 1.4);
        p.x += sin(t * 6.0 + aSeed * 30.0) * 0.12;
        p.z += cos(t * 5.0 + aSeed * 20.0) * 0.12;
        vA = sin(t * 3.14159) * (0.6 + 0.4 * aSeed);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (0.09 + 0.06 * aSeed) * uScale / -mv.z;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(uColor * (1.2 + 2.0 * smoothstep(0.18, 0.0, d)) * a * a * vA, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  const v2 = new THREE.Vector2();
  pts.onBeforeRender = (renderer, _s, camera) => {
    renderer.getDrawingBufferSize(v2);
    uScale.value = v2.y / (2 * Math.tan((((camera as THREE.PerspectiveCamera).fov ?? 45) * Math.PI) / 360));
  };
  return {
    pts,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

function addModel(parent: THREE.Object3D, m: PropModel): void {
  const q = qLevel(propsQuality()) >= 1;
  for (const p of m.parts) {
    const mesh = new THREE.Mesh(p.geo, p.mat);
    mesh.castShadow = q && p.shadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
}

export function createFountainViewImpl(team: Team, c: Circle, map: MapDef, height?: HeightFn): AnimatedView {
  const tc = TEAM_COLORS[team];
  const theme = themeOf(map);
  const h = height ?? fallbackHeight(map);
  const baseY = h(c.x, c.z);
  const root = new THREE.Group();
  root.name = 'fountain:' + team;
  const ring = auraRing(c, team, h, baseY);
  root.add(ring.group);
  const motes = healMotes(c, team, h, baseY, 46);
  root.add(motes.pts);
  const piece = new THREE.Group();
  root.add(piece);
  let animate: (t: number) => void = () => {};
  let glowY = 1.2;
  if (theme === 'well') {
    addModel(piece, cachedModel('ft|well|' + team, () => wellModel(team)));
    glowY = 0.7;
    // shimmering water surface over the voxel water
    const bucket = new THREE.Group();
    addModel(
      bucket,
      cachedModel('ft|bucket', () => {
        const g = new PGrid(8, 8, 8);
        taper(g, 4, 4, 3, 3.5, 0, 5, (x, y, z) => (y === 1 || y === 4 ? 0x4a4f56 : shade(0x8a6a42, 0.9 + h3(x, y, z) * 0.2)));
        for (let y = 1; y < 5; y++) for (let z = 2; z < 6; z++) for (let x = 2; x < 6; x++) g.clear(x, y, z);
        return toModel(g, 0.08, { [CH.base]: pmat({ rough: 0.8 }) }, { pivot: [4, 0, 4] });
      }),
    );
    bucket.position.set(0, 1.0, 0.08);
    piece.add(bucket);
    animate = (t) => {
      bucket.position.y = 1.15 + Math.sin(t * 0.8) * 0.12;
      bucket.rotation.y = Math.sin(t * 0.6) * 0.3;
    };
  } else if (theme === 'crystal') {
    addModel(piece, cachedModel('ft|plinth|' + team, () => plinthModel(team)));
    const big = new THREE.Group();
    addModel(big, cachedModel('ft|crystal|' + team, () => crystalModel(team, false)));
    piece.add(big);
    const smalls: THREE.Group[] = [];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Group();
      addModel(s, cachedModel('ft|crystal-s|' + team, () => crystalModel(team, true)));
      piece.add(s);
      smalls.push(s);
    }
    glowY = 1.9;
    animate = (t) => {
      big.position.y = 1.85 + Math.sin(t * 1.2) * 0.12;
      big.rotation.y = t * 0.45;
      for (let i = 0; i < smalls.length; i++) {
        const a = t * 0.8 + (i / smalls.length) * Math.PI * 2;
        smalls[i].position.set(Math.cos(a) * 1.25, 1.7 + Math.sin(t * 1.6 + i) * 0.25, Math.sin(a) * 1.25);
        smalls[i].rotation.y = -a * 2;
        smalls[i].rotation.z = 0.3;
      }
    };
  } else if (theme === 'clam') {
    addModel(piece, cachedModel('ft|clam|' + team, () => clamModel(team)));
    const pearl = new THREE.Group();
    addModel(pearl, cachedModel('ft|pearl|' + team, () => pearlModel(team)));
    piece.add(pearl);
    glowY = 0.95;
    animate = (t) => {
      pearl.position.set(0, 0.95 + Math.sin(t * 1.4) * 0.07, 0.1);
      pearl.rotation.y = t * 0.6;
    };
  } else {
    addModel(piece, cachedModel('ft|brazier', brazierModel));
    const flames: THREE.Group[] = [];
    for (let v = 0; v < 2; v++) {
      const f = new THREE.Group();
      addModel(f, cachedModel('ft|flame|' + team + '|' + v, () => flameModel(team, v)));
      f.position.y = 1.62;
      piece.add(f);
      flames.push(f);
    }
    glowY = 2.2;
    animate = (t) => {
      for (let i = 0; i < flames.length; i++) {
        const f = flames[i];
        const k = 0.86 + 0.12 * Math.sin(t * (9 + i * 3) + i) + 0.07 * Math.sin(t * 23 + i * 2);
        f.scale.set((i ? 0.72 : 0.9) * (1.04 - k * 0.05), k * (i ? 0.8 : 1), (i ? 0.72 : 0.9) * (1.04 - k * 0.05));
        f.rotation.y = t * (i ? -1.6 : 1.1);
      }
    };
  }
  const haloSize = theme === 'well' ? 2.2 : theme === 'clam' ? 2.8 : 3.4;
  const glowA = halo(tc.main, haloSize, 0.3);
  glowA.position.y = glowY;
  const glowB = halo(theme === 'brazier' ? tc.main : tc.light, haloSize * 0.38, theme === 'brazier' ? 0.35 : 0.6);
  glowB.position.y = glowY;
  root.add(glowA, glowB);
  return {
    root,
    update(_dt, time) {
      setPropTime(time);
      animate(time);
      const p = 0.5 + 0.5 * Math.sin(time * 2.1);
      glowA.scale.setScalar(haloSize * (0.95 + p * 0.12));
      ring.u.uPulse.value = p * 0.3;
    },
    dispose() {
      ring.dispose();
      motes.dispose();
    },
  };
}

