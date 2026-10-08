// Hook skin recipes: one per 'hands' cosmetic (shared/cosmetics.ts), plus the grapple claws, held
// tethers, chain links and the spring coil. Every recipe draws in design units (du) into a Builder;
// hookSkins.ts meshes and caches the results per voxel size.
//
// Head frame (the flying hook and the held hook share it): origin at the catch centre, +Z is the
// business end (direction of travel), the hook's curve lies in the XZ plane and Y is its thin axis,
// so it reads from the 55 degree game camera when it flies flat. The tether ties on at z = -eye.
// Tone: no blood. Red on aprons and hooks is rust, paint and grime.
import type { FamilyId } from '../../../shared/types.ts';
import {
  Builder, Surf, bark, chippedPaint, crocHide, gold, hashVox, ivory, leafy, mix, moss, pathLen, pk, pkTeam, rope, rustyIron, shade,
  smooth01, solid, steelEdge, teamPaint, teamWhite, vine, vnoise, type Bounds, type MPaint, type MPt,
} from './skinKit.ts';

export type LinkKind =
  | 'rope' | 'tar' | 'goldrope' | 'heavychain' | 'chain' | 'vine' | 'jawvine' | 'root' | 'cable' | 'hose' | 'steelcable'
  | 'twine' | 'thinvine' | 'thincable';

export interface SkinRecipe {
  id: string;
  family: FamilyId;
  /** design unit -> metres for the held hook */
  scale: number;
  bounds: Bounds;
  draw(b: Builder, closed: boolean): void;
  /** Ember Barb heat weight 0..1 in design units */
  heat(x: number, y: number, z: number): number;
  /** tie-on point distance behind the origin (du) */
  eye: number;
  /** spring coil centre and radius (du) for the Ricochet Spring / Boing Barb */
  coil: { x: number; z: number; r: number };
  /** twinkle points (du), Limited items */
  sparkles?: readonly (readonly [number, number, number])[];
  /** has a closed variant (claws) */
  closable?: boolean;
  link: LinkKind;
  /** held: what joins the grip (origin) to the tie-on point, and how long it is (du, may be <= 0) */
  tether: 'rope' | 'tar' | 'goldrope' | 'heavychain' | 'cable' | 'vine' | 'none';
  tetherLen: number;
  /** ember particle anchor (du, head frame): the hottest point */
  hot: readonly [number, number, number];
}

// ---------------------------------------------------------------------------------------------
// path helpers (design units)
// ---------------------------------------------------------------------------------------------

/** Catmull-Rom through control points, radius interpolated linearly. */
export function spline(ctrl: readonly MPt[], perSeg = 8): MPt[] {
  const out: MPt[] = [];
  const n = ctrl.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(n - 1, i + 2)];
    for (let k = 0; k < perSeg; k++) {
      const t = k / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const ry1 = p1.ry ?? p1.r;
      const ry2 = p2.ry ?? p2.r;
      out.push({ x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y), z: cr(p0.z, p1.z, p2.z, p3.z), r: p1.r + (p2.r - p1.r) * t, ry: ry1 + (ry2 - ry1) * t });
    }
  }
  out.push({ ...ctrl[n - 1] });
  return out;
}

/** Arc in the XZ plane, angle from +X toward +Z (radians). */
export function arc(cx: number, cz: number, R: number, a0: number, a1: number, n: number, r0: number, r1: number, ry0?: number, ry1?: number, y = 0): MPt[] {
  const out: MPt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + (a1 - a0) * t;
    const ry = ry0 !== undefined && ry1 !== undefined ? ry0 + (ry1 - ry0) * t : undefined;
    out.push({ x: cx + Math.cos(a) * R, y, z: cz + Math.sin(a) * R, r: r0 + (r1 - r0) * t, ry });
  }
  return out;
}

interface Frame {
  x: number;
  y: number;
  z: number;
  r: number;
  ry: number;
  /** tangent */
  tx: number;
  ty: number;
  tz: number;
  /** in-plane normal (XZ), pointing to the left of travel */
  nx: number;
  nz: number;
}

/** Sample a polyline at arc fraction s (0..1). */
export function frameAt(path: readonly MPt[], s: number): Frame {
  const L = pathLen(path);
  let d = Math.max(0, Math.min(1, s)) * L;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (d <= l || i === path.length - 1) {
      const t = l > 1e-9 ? Math.min(1, d / l) : 0;
      const il = 1 / Math.max(1e-9, l);
      const tx = (b.x - a.x) * il;
      const ty = (b.y - a.y) * il;
      const tz = (b.z - a.z) * il;
      const nl = 1 / Math.max(1e-9, Math.hypot(tx, tz));
      const ar = a.ry ?? a.r;
      const br = b.ry ?? b.r;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        r: a.r + (b.r - a.r) * t,
        ry: ar + (br - ar) * t,
        tx,
        ty,
        tz,
        nx: -tz * nl,
        nz: tx * nl,
      };
    }
    d -= l;
  }
  const p = path[path.length - 1];
  return { x: p.x, y: p.y, z: p.z, r: p.r, ry: p.ry ?? p.r, tx: 0, ty: 0, tz: 1, nx: -1, nz: 0 };
}

/**
 * A lashing drawn as a sleeve over a path with a spiral pattern: turns of cord (duty = fraction of
 * each turn that is cord) and either a dark groove or a gap between turns (groove < 0 leaves the
 * surface underneath showing). Reads as tight coils even at coarse voxel sizes, unlike a true
 * helix whose turns merge. The cord paint gets s = 0..1 across the cord (for round shading).
 */
function sleeve(b: Builder, path: readonly MPt[], s0: number, s1: number, turns: number, thick: number, cord: MPaint, duty: number, groove: number, phase = 0): void {
  const pts: MPt[] = [];
  const n = Math.max(3, Math.ceil((s1 - s0) * 48));
  for (let i = 0; i <= n; i++) {
    const f = frameAt(path, s0 + ((s1 - s0) * i) / n);
    pts.push({ x: f.x, y: f.y, z: f.z, r: f.r + thick, ry: f.ry + thick });
  }
  b.tube(
    pts,
    (x, y, z, s, d, a) => {
      const f = (((s * turns + a + phase) % 1) + 1) % 1;
      if (f < duty) return cord(x, y, z, f / duty, d, a);
      return groove;
    },
    true,
  );
}

/** Laid cord seen as a coil: round shading across each turn, a few strand lines. */
function coilCord(seed: number, tone: 0 | 1 | 2 | 3): MPaint {
  const P =
    tone === 1
      ? [0x1a1714, 0x26211c, 0x332b24, 0x41372e]
      : tone === 2
        ? [0x8e7450, 0xa88c60, 0xc0a474, 0xd4bc8a]
        : tone === 3
          ? [0x7a3c16, 0x9a5220, 0xb8692c, 0xd08440]
          : [0x4a311c, 0x5e4026, 0x765232, 0x8c6640];
  const g = gold(seed + 1);
  return (x, y, z, s, d, a) => {
    const h = hashVox(Math.floor(x * 113), Math.floor(y * 113), Math.floor(z * 113), seed);
    const k = Math.sin(Math.max(0, Math.min(1, s)) * Math.PI);
    if (tone === 2 && s > 0.3 && s < 0.62 && ((a * 6) % 1) < 0.5) return g(x, y, z, s, d, a);
    const strand = ((s * 3 + a * 9) % 1) < 0.18;
    const c = shade(P[Math.min(3, Math.floor(k * 3.99))], (strand ? 0.78 : 1) * (0.95 + h * 0.1));
    return pk(c, tone === 1 ? Surf.Tar : tone === 3 ? Surf.Brass : Surf.Rope);
  };
}

/** Conical spike from a surface point along a direction. */
function spike(b: Builder, x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, r0: number, paint: MPaint): void {
  const l = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const uz = dz / l;
  b.tube(
    [
      { x: x - ux * r0, y: y - uy * r0, z: z - uz * r0, r: r0 },
      { x: x + ux * len * 0.5, y: y + uy * len * 0.5, z: z + uz * len * 0.5, r: r0 * 0.62 },
      { x: x + ux * len, y: y + uy * len, z: z + uz * len, r: r0 * 0.22 },
    ],
    paint,
  );
}

/** Hanging moss strand from a point, drooping down (-Y) with a little sway. */
function drip(b: Builder, x: number, y: number, z: number, len: number, r: number, seed: number, paint: MPaint): void {
  const sx = (hashVox(seed, 1, 2, 3) - 0.5) * 0.05;
  const sz = (hashVox(seed, 4, 5, 6) - 0.5) * 0.05;
  b.tube(
    [
      { x, y, z, r },
      { x: x + sx * 0.5, y: y - len * 0.45, z: z + sz * 0.5, r: r * 0.8 },
      { x: x + sx, y: y - len, z: z + sz, r: r * 0.45 },
    ],
    paint,
  );
  b.ball(x + sx, y - len, z + sz, r * 0.8, r * 1.1, r * 0.8, paint);
}

/** Flat leaf blade in the plane spanned by the direction and the plane's up (lies mostly flat). */
function leaf(b: Builder, x: number, y: number, z: number, dx: number, dz: number, len: number, w: number, paint: MPaint, tilt = 0.25): void {
  const l = Math.hypot(dx, dz) || 1;
  const ux = dx / l;
  const uz = dz / l;
  const steps = Math.max(4, Math.ceil(len / (b.vd * 0.7)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const half = Math.sin(t * Math.PI) * w * (1 - t * 0.35) + b.vd * 0.3;
    const cx = x + ux * len * t;
    const cz = z + uz * len * t;
    const cy = y + Math.sin(t * Math.PI * 0.8) * len * tilt;
    b.tube(
      [
        { x: cx - uz * half, y: cy, z: cz + ux * half, r: b.vd * 0.55 },
        { x: cx + uz * half, y: cy, z: cz - ux * half, r: b.vd * 0.55 },
      ],
      paint,
    );
  }
}

const HOT_FRONT = (z0: number, z1: number) => (_x: number, _y: number, z: number) => smooth01(z0, z1, z);

// ---------------------------------------------------------------------------------------------
// Harbour Brawler
// ---------------------------------------------------------------------------------------------

/** rope_hook (default, ref01): big rusty barbed J hook, braided rope lashing at the eye. */
const ropeHook: SkinRecipe = {
  id: 'brawler.rope_hook',
  family: 'brawler',
  scale: 0.6,
  bounds: { x0: -0.42, x1: 0.32, y0: -0.16, y1: 0.16, z0: -0.86, z1: 0.38 },
  eye: 0.82,
  coil: { x: 0.17, z: -0.12, r: 0.12 },
  link: 'rope',
  tether: 'rope',
  tetherLen: 0.32,
  hot: [-0.22, 0, -0.18],
  heat: (x, _y, z) => (z < -0.3 ? 0 : Math.max(smooth01(-0.25, 0.12, z), x < -0.08 ? smooth01(-0.5, -0.3, z) : 0)),
  draw(b) {
    const iron = rustyIron(11, 0.5);
    const ironLight = rustyIron(12, 0.3);
    // shank, slightly flattened in Y
    b.tube([{ x: 0.17, y: 0, z: -0.62, r: 0.068, ry: 0.06 }, { x: 0.17, y: 0, z: 0.05, r: 0.078, ry: 0.07 }], iron);
    // eye: a flat ring at the top of the shank
    b.ring(0.17, 0, -0.68, 1, 0.07, 0.034, iron);
    // the bend, then the point running back up
    const bend = arc(-0.045, 0.05, 0.215, 0, Math.PI, 18, 0.078, 0.06, 0.07, 0.055);
    b.tube(bend, iron);
    const point: MPt[] = [
      { x: -0.26, y: 0, z: 0.05, r: 0.06, ry: 0.055 },
      { x: -0.25, y: 0, z: -0.12, r: 0.05, ry: 0.046 },
      { x: -0.235, y: 0, z: -0.22, r: 0.042, ry: 0.04 },
    ];
    b.tube(point, ironLight);
    // arrowhead barb: broad blade, bright worked edges, two swept-back wings
    const edge = steelEdge(13);
    const zt = -0.52;
    const zb = -0.2;
    b.fill(
      { x0: -0.42, x1: -0.04, y0: -0.06, y1: 0.06, z0: zt - 0.02, z1: zb + 0.1 },
      (x, y, z) => {
        const t = (z - zt) / (zb - zt);
        const xc = -0.235;
        const ax = Math.abs(x - xc);
        let inside = false;
        if (t >= 0 && t <= 1) inside = ax < 0.16 * t + 0.012;
        // wings drop back below the base line at the outside: the barbs
        if (!inside && ax > 0.06 && ax < 0.16) inside = z >= zb && z <= zb + (ax - 0.06) * 0.85;
        if (!inside) return false;
        const th = 0.018 + 0.03 * Math.max(0, Math.min(1, t)) * (1 - ax / 0.2);
        return Math.abs(y) < th + 0.005;
      },
      (x, y, z, s, d, a) => {
        const t = (z - zt) / (zb - zt);
        const ax = Math.abs(x + 0.235);
        const rim = ax > 0.16 * Math.min(1, t) - 0.045 || t < 0.12;
        return rim ? edge(x, y, z, s, d, a) : ironLight(x, y, z, s, d, a);
      },
    );
    // a raised spine down the blade centre
    b.tube([{ x: -0.235, y: 0, z: zt + 0.04, r: 0.02 }, { x: -0.235, y: 0, z: zb, r: 0.038 }], ironLight);
    // rope lashing: a tight coil of laid rope round the top of the shank
    const shank: MPt[] = [{ x: 0.17, y: 0, z: -0.66, r: 0.068, ry: 0.06 }, { x: 0.17, y: 0, z: -0.32, r: 0.072, ry: 0.064 }];
    sleeve(b, shank, 0.04, 0.97, 5, 0.05, coilCord(14, 0), 0.8, pk(0x24170e, Surf.Rope));
    // the rope tail running off the eye (where the line ties on)
    const tail: MPt[] = [{ x: 0.17, y: 0.02, z: -0.66, r: 0.045 }, { x: 0.17, y: 0.0, z: -0.74, r: 0.047 }, { x: 0.17, y: 0, z: -0.84, r: 0.045 }];
    b.tube(tail, rope(15, 0, 3, 3));
    b.ball(0.17, 0.01, -0.72, 0.065, 0.06, 0.05, rope(16, 0, 3, 2)); // the hitch knot
    // team paint band on the shank, chipped
    b.tube([{ x: 0.17, y: 0, z: -0.27, r: 0.083, ry: 0.074 }, { x: 0.17, y: 0, z: -0.17, r: 0.084, ry: 0.075 }], teamPaint(17, 0.2));
    b.wear(18);
  },
};

function harpoonDraw(b: Builder, golden: boolean): void {
  const metal: MPaint = golden ? gold(21) : rustyIron(22, 0.35);
  const edge: MPaint = golden ? (x, y, z) => pk(shade(0xfff0b0, 0.95 + vnoise(x / 0.03, y / 0.03, z / 0.03, 1, 23) * 0.1), Surf.Gold) : steelEdge(24);
  // shaft with collars
  b.tube([{ x: 0, y: 0, z: -0.66, r: 0.046 }, { x: 0, y: 0, z: 0.0, r: 0.05 }], metal);
  for (const z of [-0.5, -0.12]) b.tube([{ x: 0, y: 0, z: z - 0.025, r: 0.068 }, { x: 0, y: 0, z: z + 0.025, r: 0.068 }], golden ? gold(25) : rustyIron(26, 0.65));
  // socket flare into the blade
  b.tube([{ x: 0, y: 0, z: -0.04, r: 0.055, ry: 0.05 }, { x: 0, y: 0, z: 0.1, r: 0.075, ry: 0.045 }], metal);
  // broad leaf blade: widest near the base, a thick central ridge
  const zb = 0.06;
  const zt = 0.5;
  b.fill(
    { x0: -0.18, x1: 0.18, y0: -0.07, y1: 0.07, z0: zb - 0.01, z1: zt + 0.01 },
    (x, y, z) => {
      const t = (z - zb) / (zt - zb);
      if (t < 0 || t > 1) return false;
      const w = 0.15 * Math.sin(Math.min(1, t * 2.6 + 0.25) * Math.PI * 0.5) * (1 - t) ** 0.75 + 0.01;
      const ax = Math.abs(x);
      if (ax > w) return false;
      const th = 0.012 + 0.04 * (1 - ax / w) * (1 - t * 0.6);
      return Math.abs(y) < th;
    },
    (x, y, z, s, d, a) => {
      const t = (z - zb) / (zt - zb);
      const w = 0.15 * Math.sin(Math.min(1, t * 2.6 + 0.25) * Math.PI * 0.5) * (1 - t) ** 0.75 + 0.01;
      return Math.abs(x) > w - 0.035 || t > 0.86 ? edge(x, y, z, s, d, a) : metal(x, y, z, s, d, a);
    },
  );
  // two swept-back barbs off the blade base
  for (const sx of [-1, 1]) {
    b.tube(
      [
        { x: sx * 0.08, y: 0, z: 0.13, r: 0.034, ry: 0.026 },
        { x: sx * 0.17, y: 0, z: 0.02, r: 0.026, ry: 0.02 },
        { x: sx * 0.215, y: 0, z: -0.09, r: 0.012, ry: 0.012 },
      ],
      metal,
    );
    b.dot(sx * 0.215, 0, -0.1, golden ? pk(0xfff4c0, Surf.Gold) : pk(0xd8dde2, Surf.Steel));
  }
  if (golden) {
    // pearl inlay set in the blade, ringed with bright gold
    b.ring(0, 0, 0.21, 1, 0.055, 0.02, edge);
    b.ball(0, 0, 0.21, 0.05, 0.045, 0.05, (x, y, z) => {
      const n = vnoise(x / 0.02, y / 0.02, z / 0.02, 1, 27);
      return pk(mix(0xf6f0ec, n > 0.6 ? 0xf2d6ea : 0xd8ecf4, 0.35 + n * 0.2), Surf.Pearl);
    });
    // a tiny pearl at the pommel
    b.ball(0, 0, -0.69, 0.04, 0.04, 0.04, solid(0xf4eee8, Surf.Pearl, 28, 0.03));
  }
  // lashing of tarred (or gold-wrapped) rope round the shaft end
  const shaft: MPt[] = [{ x: 0, y: 0, z: -0.64, r: 0.046 }, { x: 0, y: 0, z: -0.34, r: 0.048 }];
  sleeve(b, shaft, 0.03, 0.97, 4.5, 0.04, coilCord(golden ? 29 : 30, golden ? 2 : 1), 0.8, golden ? pk(0x6a5030, Surf.Rope) : pk(0x0c0a08, Surf.Tar));
  b.tube([{ x: 0, y: 0.0, z: -0.66, r: 0.04 }, { x: 0, y: 0, z: -0.78, r: 0.042 }], golden ? goldRope(31) : rope(32, 1, 3, 3));
  if (!golden) {
    // a team rag tied round the shaft, two short tails trailing back and down
    b.tube([{ x: 0, y: 0, z: -0.28, r: 0.064 }, { x: 0, y: 0, z: -0.22, r: 0.064 }], teamWhite(33, Surf.Rope));
    for (const sx of [-1, 1]) {
      b.tube(
        [
          { x: sx * 0.05, y: -0.02, z: -0.25, r: 0.026, ry: 0.012 },
          { x: sx * 0.1, y: -0.05, z: -0.34, r: 0.03, ry: 0.012 },
          { x: sx * 0.12, y: -0.08, z: -0.44, r: 0.022, ry: 0.01 },
        ],
        teamWhite(34 + sx, Surf.Rope),
      );
    }
  } else {
    // gold filigree band with a team-coloured jewel
    b.tube([{ x: 0, y: 0, z: -0.27, r: 0.066 }, { x: 0, y: 0, z: -0.21, r: 0.066 }], gold(36));
    b.ball(0, 0.06, -0.24, 0.03, 0.025, 0.03, teamWhite(37, Surf.Glow, 0xd8d8d8));
  }
  b.wear(golden ? 38 : 39, 0.2);
}

/** Gold-wrapped rope: pale manila with one strand gilded. */
function goldRope(seed: number): MPaint {
  const base = rope(seed, 2, 3, 18);
  const g = gold(seed + 1);
  return (x, y, z, s, d, a) => {
    const f = (((a * 3 + s * 18) % 1) + 1) % 1;
    return f > 0.2 && f < 0.5 && d > 0.5 ? g(x, y, z, s, d, a) : base(x, y, z, s, d, a);
  };
}

const harpoonHook: SkinRecipe = {
  id: 'brawler.harpoon_hook',
  family: 'brawler',
  scale: 0.62,
  bounds: { x0: -0.26, x1: 0.26, y0: -0.12, y1: 0.12, z0: -0.82, z1: 0.54 },
  eye: 0.78,
  coil: { x: 0, z: -0.1, r: 0.1 },
  link: 'tar',
  tether: 'tar',
  tetherLen: 0.3,
  hot: [0, 0, 0.32],
  heat: HOT_FRONT(-0.1, 0.25),
  draw: (b) => harpoonDraw(b, false),
};

const goldenHarpoon: SkinRecipe = {
  ...harpoonHook,
  id: 'brawler.golden_harpoon',
  link: 'goldrope',
  tether: 'goldrope',
  sparkles: [
    [0, 0.05, 0.48],
    [0.2, 0.03, -0.08],
    [-0.2, 0.03, -0.08],
    [0, 0.07, 0.21],
    [0.06, 0.06, -0.24],
    [0, 0.06, -0.69],
  ],
  draw: (b) => harpoonDraw(b, true),
};

/** anchor_hook: a little ship's anchor, heavy and rusty, barnacles and a strand of weed. */
const anchorHook: SkinRecipe = {
  id: 'brawler.anchor_hook',
  family: 'brawler',
  scale: 0.6,
  bounds: { x0: -0.44, x1: 0.44, y0: -0.2, y1: 0.14, z0: -0.86, z1: 0.42 },
  eye: 0.8,
  coil: { x: 0, z: -0.18, r: 0.11 },
  link: 'heavychain',
  tether: 'heavychain',
  tetherLen: 0.26,
  hot: [0, 0, 0.32],
  heat: HOT_FRONT(-0.15, 0.25),
  draw(b) {
    const iron = rustyIron(41, 0.6);
    const iron2 = rustyIron(42, 0.45);
    // shank, square-ish
    b.tube([{ x: 0, y: 0, z: -0.62, r: 0.06, ry: 0.06 }, { x: 0, y: 0, z: 0.28, r: 0.074, ry: 0.07 }], iron);
    // ring at the top
    b.ring(0, 0, -0.72, 1, 0.1, 0.036, iron2);
    // stock: crossbar with ball ends
    b.tube([{ x: -0.27, y: 0, z: -0.47, r: 0.042 }, { x: 0.27, y: 0, z: -0.47, r: 0.042 }], iron2);
    for (const sx of [-1, 1]) b.ball(sx * 0.29, 0, -0.47, 0.058, 0.058, 0.058, iron2);
    // crown and arms sweeping back on both sides
    b.ball(0, 0, 0.3, 0.09, 0.075, 0.08, iron);
    for (const sx of [-1, 1]) {
      const armPts = arc(0, 0.02, 0.29, Math.PI / 2, Math.PI / 2 - sx * 1.25, 12, 0.07, 0.05, 0.065, 0.048);
      b.tube(armPts, iron);
      // fluke: a flat spade at the tip of each arm, pointing back and out
      const tip = armPts[armPts.length - 1];
      const dx = sx * 0.55;
      const dz = -0.85;
      b.fill(
        { x0: tip.x - 0.16, x1: tip.x + 0.16, y0: -0.05, y1: 0.05, z0: tip.z - 0.2, z1: tip.z + 0.12 },
        (x, y, z) => {
          // triangle pointing along (dx, dz) from the arm tip
          const px = x - tip.x;
          const pz = z - tip.z;
          const along = (px * dx + pz * dz) / Math.hypot(dx, dz);
          const across = Math.abs((-px * dz + pz * dx) / Math.hypot(dx, dz));
          if (along < -0.06 || along > 0.15) return false;
          const w = along < 0 ? 0.09 + along * 0.6 : 0.09 * (1 - along / 0.15);
          return across < w && Math.abs(y) < 0.03;
        },
        iron2,
      );
    }
    // barnacles: little ivory volcanoes on the crown and arms
    const barn = (x: number, z: number, r: number, seed: number) => {
      b.ball(x, 0.05, z, r, r * 0.7, r, (bx, by, bz) => pk(shade(mix(0xd8d2c0, 0x9a948a, vnoise(bx / 0.02, by / 0.02, bz / 0.02, 1, seed)), 1), Surf.Ivory), true);
      b.dot(x, 0.05 + r * 0.6, z, pk(0x2a2622, Surf.Iron));
    };
    barn(0.05, 0.31, 0.04, 43);
    barn(-0.17, 0.25, 0.034, 44);
    barn(0.21, 0.2, 0.03, 45);
    barn(0.02, -0.08, 0.03, 46);
    // a strand of wet weed draped over the right arm
    const weed = moss(47, true);
    b.tube(
      [
        { x: 0.12, y: 0.07, z: 0.3, r: 0.022 },
        { x: 0.2, y: 0.06, z: 0.24, r: 0.024 },
        { x: 0.27, y: -0.02, z: 0.18, r: 0.02 },
        { x: 0.3, y: -0.12, z: 0.16, r: 0.014 },
      ],
      weed,
    );
    // team paint band on the shank
    b.tube([{ x: 0, y: 0, z: -0.32, r: 0.079, ry: 0.078 }, { x: 0, y: 0, z: -0.2, r: 0.08, ry: 0.079 }], teamPaint(48, 0.25));
    b.wear(49);
  },
};

// ---------------------------------------------------------------------------------------------
// Swamp Ogre
// ---------------------------------------------------------------------------------------------

const TUSK_PATH: readonly MPt[] = spline(
  [
    { x: 0.13, y: 0, z: -0.74, r: 0.12, ry: 0.115 },
    { x: 0.16, y: 0, z: -0.42, r: 0.112, ry: 0.105 },
    { x: 0.15, y: 0, z: -0.1, r: 0.096, ry: 0.09 },
    { x: 0.06, y: 0, z: 0.18, r: 0.08, ry: 0.075 },
    { x: -0.12, y: 0, z: 0.31, r: 0.064, ry: 0.06 },
    { x: -0.29, y: 0, z: 0.22, r: 0.048, ry: 0.046 },
    { x: -0.36, y: 0, z: 0.02, r: 0.03, ry: 0.03 },
    { x: -0.355, y: 0, z: -0.1, r: 0.014, ry: 0.014 },
  ],
  6,
);

/** vine_tusk_hook (default, ref02): a huge curved tusk with spikes, bound in vines, dripping moss. */
const vineTusk: SkinRecipe = {
  id: 'ogre.vine_tusk_hook',
  family: 'ogre',
  scale: 0.66,
  bounds: { x0: -0.48, x1: 0.36, y0: -0.36, y1: 0.2, z0: -0.88, z1: 0.46 },
  eye: 0.82,
  coil: { x: 0.155, z: -0.2, r: 0.15 },
  link: 'vine',
  tether: 'none',
  tetherLen: -0.18,
  hot: [-0.3, 0, 0.1],
  heat: (x, _y, z) => Math.max(smooth01(-0.2, 0.2, z), x < -0.15 ? 1 : 0) * (z > -0.5 ? 1 : 0),
  draw(b) {
    const tusk = ivory(51, 11);
    b.tube(TUSK_PATH, tusk);
    // the cut root end: darker, rough
    b.ball(0.13, 0, -0.75, 0.115, 0.11, 0.05, (x, y, z) => pk(shade(mix(0x8a7a5a, 0x5a4a32, vnoise(x / 0.02, y / 0.02, z / 0.02, 1, 52)), 1), Surf.Ivory));
    // spikes: three hooked barbs on the inner curve, a row of small ones down the back
    const bone = ivory(53, 4);
    const inner: [number, number, number][] = [
      [0.3, 0.07, 0.75],
      [0.5, 0.08, 0.95],
      [0.68, 0.075, 1.0],
    ];
    for (const [s, len, k] of inner) {
      const f = frameAt(TUSK_PATH, s);
      // inner side = toward the curve centre = right of travel here (negative normal)
      const dx = -f.nx * k + f.tx * 0.55;
      const dz = -f.nz * k + f.tz * 0.55;
      spike(b, f.x - f.nx * f.r * 0.7, 0, f.z - f.nz * f.r * 0.7, dx, 0, dz, len + f.r * 0.4, 0.034, bone);
    }
    for (let i = 0; i < 4; i++) {
      const f = frameAt(TUSK_PATH, 0.24 + i * 0.13);
      spike(b, f.x + f.nx * f.r * 0.75, 0.01, f.z + f.nz * f.r * 0.75, f.nx - f.tx * 0.5, 0.15, f.nz - f.tz * 0.5, 0.055 + f.r * 0.25, 0.026, bone);
    }
    // vine bindings: a long wrap at the grip and two bands up the tusk
    const vn = vine(54, 0.4);
    sleeve(b, TUSK_PATH, 0.0, 0.2, 4, 0.036, vn, 0.5, -1);
    sleeve(b, TUSK_PATH, 0.39, 0.47, 1.4, 0.032, vine(55, 0.3), 0.62, -1, 0.3);
    sleeve(b, TUSK_PATH, 0.6, 0.66, 1.2, 0.028, vine(56, 0.3), 0.62, -1, 0.7);
    // moss clumps riding on the bindings, and strands dripping down
    const mossP = moss(57, true);
    for (const [s, r] of [[0.06, 0.06], [0.16, 0.055], [0.44, 0.05], [0.63, 0.04]] as const) {
      const f = frameAt(TUSK_PATH, s);
      b.ball(f.x + f.nx * 0.02, f.ry * 0.8, f.z + f.nz * 0.02, r * 1.2, r * 0.7, r, mossP, true);
    }
    const drips: [number, number, number][] = [
      [0.05, 0.16, 1],
      [0.12, 0.22, -1],
      [0.19, 0.12, 1],
      [0.43, 0.2, -1],
      [0.46, 0.12, 1],
      [0.64, 0.16, -1],
    ];
    drips.forEach(([s, len, side], i) => {
      const f = frameAt(TUSK_PATH, s);
      drip(b, f.x + f.nx * f.r * 0.6 * side, -f.ry * 0.6, f.z + f.nz * f.r * 0.6 * side, len, 0.024, 58 + i, mossP);
    });
    // team charm: a clay bead and a feather tied off the grip binding
    const bead = frameAt(TUSK_PATH, 0.18);
    b.tube([{ x: bead.x + bead.nx * bead.r, y: -0.02, z: bead.z, r: 0.012 }, { x: bead.x + bead.nx * (bead.r + 0.06), y: -0.08, z: bead.z + 0.02, r: 0.012 }], vine(61, 0.6));
    b.ball(bead.x + bead.nx * (bead.r + 0.07), -0.11, bead.z + 0.02, 0.042, 0.042, 0.042, teamWhite(62, Surf.Paint, 0xe0e0e0));
    for (let i = 0; i < 5; i++) b.dot(bead.x + bead.nx * (bead.r + 0.09 + i * 0.022), -0.12 - i * 0.012, bead.z + 0.06 + i * 0.03, i % 2 ? pkTeam(0xf0f0f0, Surf.Rope) : pk(0xe8e2d4, Surf.Rope));
    b.wear(63, 0.1);
  },
};

/** croc_jaw_hook: a crocodile's lower jaw, scaly hide outside, a row of teeth along the top. */
const crocJaw: SkinRecipe = {
  id: 'ogre.croc_jaw_hook',
  family: 'ogre',
  scale: 0.62,
  bounds: { x0: -0.3, x1: 0.3, y0: -0.12, y1: 0.24, z0: -0.82, z1: 0.48 },
  eye: 0.76,
  coil: { x: 0, z: -0.42, r: 0.12 },
  link: 'jawvine',
  tether: 'vine',
  tetherLen: 0.24,
  hot: [0, 0.08, 0.36],
  heat: HOT_FRONT(-0.2, 0.3),
  draw(b) {
    const hide = crocHide(71);
    const bone = ivory(72, 3);
    const tooth: MPaint = (x, y, z) => pk(shade(mix(0xf4ecd6, 0xc8b88e, smooth01(0.12, 0.0, y)), 0.96 + hashVox(Math.floor(x * 97), Math.floor(y * 97), Math.floor(z * 97), 73) * 0.08), Surf.Ivory);
    for (const sx of [-1, 1]) {
      // each jaw half: from the hinge at the back, converging to the chin
      const ramus: MPt[] = spline(
        [
          { x: sx * 0.2, y: 0.02, z: -0.5, r: 0.066, ry: 0.08 },
          { x: sx * 0.18, y: 0.0, z: -0.2, r: 0.06, ry: 0.07 },
          { x: sx * 0.12, y: 0.0, z: 0.12, r: 0.056, ry: 0.06 },
          { x: sx * 0.05, y: 0.0, z: 0.38, r: 0.056, ry: 0.06 },
        ],
        6,
      );
      b.tube(ramus, (x, y, z, s, d, a) => ((x * sx > Math.abs(ramus[0].x) * 0.9 - (z + 0.5) * 0.14 && d > 0.55) || y < -0.03 ? hide(x, y, z, s, d, a) : bone(x, y, z, s, d, a)));
      // teeth along the top inner edge: big ones at the front
      for (let i = 0; i < 7; i++) {
        const f = frameAt(ramus, 0.12 + i * 0.13);
        const big = i === 5 || i === 2;
        spike(b, f.x - sx * 0.01, f.y + f.ry * 0.7, f.z, -sx * 0.25, 1, 0.12, big ? 0.13 : 0.075, big ? 0.03 : 0.022, tooth);
      }
      // a ridge of scutes along the outside
      for (let i = 0; i < 5; i++) {
        const f = frameAt(ramus, 0.1 + i * 0.18);
        b.ball(f.x + sx * f.r * 0.8, f.y + 0.03, f.z, 0.026, 0.03, 0.04, hide, true);
      }
    }
    // chin: a fused knob with two fangs that poke up and forward
    b.ball(0, 0.01, 0.4, 0.075, 0.07, 0.06, bone);
    for (const sx of [-1, 1]) spike(b, sx * 0.045, 0.05, 0.42, sx * 0.2, 1, 0.45, 0.15, 0.03, tooth);
    // vine lashing bar across the hinge ends, where the rope ties on
    b.tube([{ x: -0.22, y: 0.02, z: -0.55, r: 0.04 }, { x: 0.22, y: 0.02, z: -0.55, r: 0.04 }], vine(74, 0.5));
    for (const sx of [-1, 1]) sleeve(b, [{ x: sx * 0.2, y: 0.02, z: -0.6, r: 0.066 }, { x: sx * 0.2, y: 0.02, z: -0.42, r: 0.066 }], 0, 1, 2.5, 0.03, vine(76 + sx, 0.4), 0.55, -1);
    b.tube([{ x: 0, y: 0.02, z: -0.56, r: 0.036 }, { x: 0, y: 0.02, z: -0.74, r: 0.036 }], vine(78, 0.5));
    // team clay stripes painted on the hide
    for (const sx of [-1, 1])
      for (const z of [-0.3, -0.16])
        b.tube([{ x: sx * 0.205, y: 0.07, z: z, r: 0.03, ry: 0.025 }, { x: sx * 0.2, y: 0.07, z: z + 0.05, r: 0.03, ry: 0.025 }], teamWhite(79, Surf.Paint, 0xdcdcdc));
    // moss in the hinge
    b.ball(0, 0.06, -0.52, 0.09, 0.04, 0.05, moss(80, true), true);
    drip(b, 0.08, -0.02, -0.53, 0.12, 0.02, 81, moss(82, true));
    b.wear(83, 0.1);
  },
};

const ROOT_PATH: readonly MPt[] = spline(
  [
    { x: 0.12, y: 0, z: -0.72, r: 0.1, ry: 0.09 },
    { x: 0.17, y: 0.01, z: -0.46, r: 0.088, ry: 0.08 },
    { x: 0.12, y: -0.01, z: -0.2, r: 0.08, ry: 0.074 },
    { x: 0.16, y: 0.01, z: 0.04, r: 0.072, ry: 0.066 },
    { x: 0.04, y: 0, z: 0.26, r: 0.064, ry: 0.06 },
    { x: -0.16, y: 0.01, z: 0.28, r: 0.052, ry: 0.05 },
    { x: -0.28, y: 0, z: 0.12, r: 0.038, ry: 0.036 },
    { x: -0.27, y: 0, z: -0.06, r: 0.024, ry: 0.024 },
    { x: -0.21, y: 0, z: -0.15, r: 0.012, ry: 0.012 },
  ],
  6,
);

/** root_hook: a living root that still grows leaves. */
const rootHook: SkinRecipe = {
  id: 'ogre.root_hook',
  family: 'ogre',
  scale: 0.64,
  bounds: { x0: -0.44, x1: 0.42, y0: -0.2, y1: 0.24, z0: -0.86, z1: 0.46 },
  eye: 0.8,
  coil: { x: 0.14, z: -0.3, r: 0.13 },
  link: 'root',
  tether: 'vine',
  tetherLen: 0.24,
  hot: [-0.26, 0, 0.0],
  heat: (x, _y, z) => Math.max(smooth01(-0.1, 0.22, z), x < -0.12 ? smooth01(-0.3, -0.1, z) : 0),
  draw(b) {
    const bk = bark(91);
    b.tube(ROOT_PATH, bk);
    // knots and burls
    for (const [s, r] of [[0.12, 0.05], [0.33, 0.045], [0.5, 0.04]] as const) {
      const f = frameAt(ROOT_PATH, s);
      b.ball(f.x + f.nx * f.r * 0.6, 0.02, f.z + f.nz * f.r * 0.6, r, r * 0.9, r, bk);
    }
    // rootlets branching off the back
    for (const [s, len, side] of [[0.08, 0.16, 1], [0.22, 0.14, -1], [0.41, 0.12, 1]] as const) {
      const f = frameAt(ROOT_PATH, s);
      const ox = f.nx * side;
      const oz = f.nz * side;
      b.tube(
        [
          { x: f.x + ox * f.r * 0.5, y: 0, z: f.z + oz * f.r * 0.5, r: 0.026 },
          { x: f.x + ox * (f.r + len * 0.55) - f.tx * 0.04, y: -0.02, z: f.z + oz * (f.r + len * 0.55) - f.tz * 0.04, r: 0.018 },
          { x: f.x + ox * (f.r + len) - f.tx * 0.1, y: -0.05, z: f.z + oz * (f.r + len) - f.tz * 0.1, r: 0.008 },
        ],
        bk,
      );
    }
    // fresh leaves sprouting along the top, two at the base of the hook point
    const lf = leafy(92);
    const lf2 = leafy(93);
    const leaves: [number, number, number, number][] = [
      [0.14, 1, 0.16, 0.06],
      [0.27, -1, 0.14, 0.055],
      [0.38, 1, 0.15, 0.055],
      [0.55, -1, 0.12, 0.05],
      [0.62, 1, 0.12, 0.045],
      [0.74, -1, 0.1, 0.04],
    ];
    leaves.forEach(([s, side, len, w], i) => {
      const f = frameAt(ROOT_PATH, s);
      const dx = f.nx * side + f.tx * 0.6;
      const dz = f.nz * side + f.tz * 0.6;
      b.tube([{ x: f.x, y: f.ry * 0.6, z: f.z, r: 0.012 }, { x: f.x + dx * f.r, y: f.ry * 0.9, z: f.z + dz * f.r, r: 0.01 }], solid(0x4a6a20, Surf.Leaf, 94));
      leaf(b, f.x + dx * f.r, f.ry * 0.9, f.z + dz * f.r, dx, dz, len, w, i & 1 ? lf2 : lf, 0.3);
    });
    // a team-coloured bloom near the grip, with a pale centre
    const fl = frameAt(ROOT_PATH, 0.2);
    const fx = fl.x + fl.nx * fl.r * 0.9;
    const fz = fl.z + fl.nz * fl.r * 0.9;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.ball(fx + Math.cos(a) * 0.035, fl.ry + 0.03, fz + Math.sin(a) * 0.035, 0.03, 0.016, 0.03, teamWhite(95 + i, Surf.Leaf, 0xf0f0f0));
    }
    b.ball(fx, fl.ry + 0.045, fz, 0.018, 0.016, 0.018, solid(0xffe27a, Surf.Glow, 96, 0.02));
    // a vine tie at the base, where the rope joins
    sleeve(b, ROOT_PATH, 0.0, 0.07, 2, 0.03, vine(97, 0.3), 0.55, -1);
    b.tube([{ x: 0.12, y: 0, z: -0.74, r: 0.034 }, { x: 0.12, y: 0, z: -0.84, r: 0.034 }], vine(98, 0.4));
    b.wear(99, 0.1);
  },
};

// ---------------------------------------------------------------------------------------------
// Butcher-Bot
// ---------------------------------------------------------------------------------------------

const HAZ: MPaint = (x, y, z) => {
  const stripe = ((((x + z) / 0.07) % 2) + 2) % 2 < 1;
  const h = hashVox(Math.floor(x * 97), Math.floor(y * 97), Math.floor(z * 97), 101);
  if (vnoise(x / 0.03, y / 0.03, z / 0.03, 1, 102) < 0.16) return pk(shade(0x5a3a24, 0.9 + h * 0.2), Surf.Rust);
  return pk(shade(stripe ? 0xe8a81e : 0x1e1c1a, 0.92 + h * 0.12), Surf.Paint);
};

/** The block every bot skin hangs from: riveted steel housing with a pin, hazard top and team lamp. */
function shackleBlock(b: Builder, z0: number, z1: number, w: number, paint: MPaint): void {
  const h = 0.09;
  b.fill({ x0: -w, x1: w, y0: -h, y1: h, z0, z1 }, (x, y, z) => {
    // bevelled corners
    const ex = Math.max(0, Math.abs(x) - (w - 0.035));
    const ey = Math.max(0, Math.abs(y) - (h - 0.035));
    const ez = Math.max(0, Math.max(z0 + 0.035 - z, z - (z1 - 0.035)));
    return ex * ex + ey * ey + ez * ez < 0.035 * 0.035;
  }, paint);
  // a narrow hazard-striped strip across the top, at the front edge
  b.fill({ x0: -w + 0.03, x1: w - 0.03, y0: h - 0.01, y1: h + 0.02, z0: z1 - 0.085, z1: z1 - 0.03 }, () => true, HAZ);
  // pin through the sides with hex nuts
  const pz = (z0 + z1) / 2;
  b.tube([{ x: -w - 0.04, y: 0, z: pz, r: 0.035 }, { x: w + 0.04, y: 0, z: pz, r: 0.035 }], steelEdge(103));
  for (const sx of [-1, 1]) b.tube([{ x: sx * (w + 0.005), y: 0, z: pz, r: 0.055 }, { x: sx * (w + 0.035), y: 0, z: pz, r: 0.055 }], rustyIron(104, 0.3));
  // rivets on the faces
  for (const sx of [-1, 1]) for (const z of [z0 + 0.04, z1 - 0.04]) b.dot(sx * (w - 0.03), h + 0.005, z, pk(0xa8aeb6, Surf.Steel));
  // team lamp on top
  b.ball(0, h + 0.04, pz, 0.045, 0.03, 0.045, teamWhite(105, Surf.Glow, 0xf4f4f4));
  b.ring(0, h + 0.03, pz, 1, 0.05, 0.015, solid(0x3a3c40, Surf.Steel, 106));
}

/** crane_hook (default, ref03): a chunky red and grey crane hook, rust-streaked. */
const craneHook: SkinRecipe = {
  id: 'bot.crane_hook',
  family: 'bot',
  scale: 0.6,
  bounds: { x0: -0.42, x1: 0.42, y0: -0.16, y1: 0.2, z0: -0.88, z1: 0.46 },
  eye: 0.82,
  coil: { x: 0, z: -0.42, r: 0.1 },
  link: 'chain',
  tether: 'cable',
  tetherLen: 0.2,
  hot: [-0.2, 0, 0.06],
  heat: HOT_FRONT(-0.25, 0.1),
  draw(b) {
    const red = chippedPaint(0x9a2e1e, 111, 0.2, 0.05);
    const grey = rustyIron(112, 0.35, 0.06);
    const cx = 0.03;
    const cz = 0.1;
    const R = 0.25;
    // the C: thick, flattened, tapering to the tip
    const body = arc(cx, cz, R, -Math.PI / 2, Math.PI * 1.1, 28, 0.158, 0.07, 0.118, 0.07);
    b.tube(body, (x, y, z, s, d, a) => {
      const rr = Math.hypot(x - cx, z - cz);
      // inner face and the tip are worn bare grey; the outside is red paint
      return rr < R - 0.04 || s > 0.86 ? grey(x, y, z, s, d, a) : red(x, y, z, s, d, a);
    });
    // a steel saddle where the shank meets the C, and the shank up to the swivel
    b.tube([{ x: cx, y: 0, z: -0.38, r: 0.08, ry: 0.075 }, { x: cx, y: 0, z: -0.12, r: 0.13, ry: 0.105 }], red);
    b.tube([{ x: cx, y: 0, z: -0.31, r: 0.098, ry: 0.088 }, { x: cx, y: 0, z: -0.27, r: 0.104, ry: 0.092 }], grey);
    // swivel neck and nut
    b.tube([{ x: cx, y: 0, z: -0.5, r: 0.05 }, { x: cx, y: 0, z: -0.38, r: 0.055 }], steelEdge(113));
    b.tube([{ x: cx, y: 0, z: -0.44, r: 0.075 }, { x: cx, y: 0, z: -0.4, r: 0.075 }], grey);
    shackleBlock(b, -0.74, -0.5, 0.13, chippedPaint(0x8a8e94, 114, 0.25, 0.045));
    // tie-on eye at the back of the block
    b.ring(cx, 0, -0.8, 1, 0.045, 0.022, steelEdge(115));
    // grime: dark rust streaks running round the C
    b.repaint((v, x, _y, z) => {
      const rr = Math.hypot(x - cx, z - cz);
      if (rr < R * 0.7 || (v & 0xffffff) === 0) return v;
      const n = vnoise(Math.atan2(z - cz, x - cx) * 6, rr / 0.02, 0, 1, 116);
      return n > 0.86 ? pk(shade(0x4a2414, 0.9 + n * 0.2), Surf.Rust) : v;
    });
    b.wear(117, 0.3);
  },
};

/** magnet_hook: a big red horseshoe magnet with bright pole shoes. */
const magnetHook: SkinRecipe = {
  id: 'bot.magnet_hook',
  family: 'bot',
  scale: 0.58,
  bounds: { x0: -0.36, x1: 0.36, y0: -0.14, y1: 0.2, z0: -0.86, z1: 0.36 },
  eye: 0.8,
  coil: { x: 0, z: -0.42, r: 0.09 },
  link: 'hose',
  tether: 'cable',
  tetherLen: 0.2,
  hot: [0, 0, 0.26],
  heat: HOT_FRONT(-0.05, 0.25),
  draw(b) {
    const red = chippedPaint(0xb4281e, 121, 0.12, 0.06);
    const pole = steelEdge(122);
    const R = 0.21;
    // U arc (open toward +Z), then two straight arms with pole shoes
    const u = arc(0, -0.12, R, Math.PI, Math.PI * 2, 18, 0.085, 0.085, 0.085, 0.085);
    b.tube(u, red);
    for (const sx of [-1, 1]) {
      b.tube([{ x: sx * R, y: 0, z: -0.12, r: 0.085 }, { x: sx * R, y: 0, z: 0.12, r: 0.085 }], red);
      b.tube([{ x: sx * R, y: 0, z: 0.12, r: 0.09 }, { x: sx * R, y: 0, z: 0.28, r: 0.09 }], pole);
      // a white band before each shoe
      b.tube([{ x: sx * R, y: 0, z: 0.09, r: 0.091 }, { x: sx * R, y: 0, z: 0.13, r: 0.091 }], solid(0xe8e6e0, Surf.Paint, 123));
    }
    // copper coil windings round the bend
    sleeve(b, u, 0.28, 0.72, 7, 0.028, coilCord(124, 3), 0.72, pk(0x4a2410, Surf.Brass));
    // mount: a stem up to the block
    b.tube([{ x: 0, y: 0, z: -0.5, r: 0.05 }, { x: 0, y: 0, z: -0.31, r: 0.06 }], rustyIron(125, 0.3));
    shackleBlock(b, -0.72, -0.5, 0.11, chippedPaint(0x5a5e66, 126, 0.25, 0.045));
    b.ring(0, 0, -0.8, 1, 0.045, 0.022, steelEdge(127));
    b.wear(128, 0.25);
  },
};

function clawDraw(b: Builder, closed: boolean): void {
  const chrome: MPaint = (x, y, z) => pk(shade(y > 0.02 ? 0xd8dde4 : 0xa8b0ba, 0.94 + vnoise(x / 0.03, y / 0.03, z / 0.03, 1, 131) * 0.12), Surf.Chrome);
  const dark = solid(0x2a2c30, Surf.Steel, 132);
  // hub: a domed chrome housing with a glowing team ring
  b.tube([{ x: 0, y: 0, z: -0.46, r: 0.07 }, { x: 0, y: 0, z: -0.36, r: 0.14 }, { x: 0, y: 0, z: -0.18, r: 0.17 }, { x: 0, y: 0, z: -0.12, r: 0.15 }], chrome);
  b.ring(0, 0, -0.26, 2, 0.172, 0.022, teamWhite(133, Surf.Glow, 0xf2f2f2));
  b.tube([{ x: 0, y: 0, z: -0.12, r: 0.1 }, { x: 0, y: 0, z: -0.06, r: 0.1 }], dark);
  // three fingers round the travel axis (90, 210, 330 degrees): symmetric from above
  for (const deg of [90, 210, 330]) {
    const a = (deg * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a) * 0.62; // squash the vertical spread so it lies flatter
    const P = (rad: number, z: number, r: number): MPt => ({ x: ux * rad, y: uy * rad, z, r });
    const pts = closed
      ? [P(0.12, -0.1, 0.045), P(0.21, 0.0, 0.042), P(0.2, 0.14, 0.038), P(0.1, 0.24, 0.032), P(0.04, 0.27, 0.028)]
      : [P(0.12, -0.1, 0.045), P(0.27, -0.0, 0.042), P(0.32, 0.14, 0.038), P(0.24, 0.27, 0.032), P(0.14, 0.31, 0.028)];
    const path = spline(pts, 5);
    b.tube(path, chrome);
    // knuckle joints
    for (const s of [0.0, 0.42]) {
      const f = frameAt(path, s);
      b.ball(f.x, f.y, f.z, 0.055, 0.055, 0.055, dark);
    }
    // rubber tips
    const f = frameAt(path, 0.93);
    b.ball(f.x, f.y, f.z, 0.042, 0.042, 0.05, solid(0xd83a2a, Surf.Rubber, 134));
  }
  b.ring(0, 0, -0.5, 1, 0.045, 0.022, steelEdge(135));
  b.wear(136, 0.2);
}

/** claw_grabber: a three-fingered arcade claw (chrome, rubber tips, glowing ring). */
const clawGrabber: SkinRecipe = {
  id: 'bot.claw_grabber',
  family: 'bot',
  scale: 0.62,
  bounds: { x0: -0.4, x1: 0.4, y0: -0.3, y1: 0.3, z0: -0.56, z1: 0.4 },
  eye: 0.52,
  coil: { x: 0, z: -0.3, r: 0.18 },
  closable: true,
  link: 'steelcable',
  tether: 'cable',
  tetherLen: 0.22,
  hot: [0, 0, 0.26],
  heat: HOT_FRONT(-0.05, 0.25),
  draw: (b, closed) => clawDraw(b, closed),
};

export const SKIN_RECIPES: readonly SkinRecipe[] = [ropeHook, harpoonHook, anchorHook, goldenHarpoon, vineTusk, crocJaw, rootHook, craneHook, magnetHook, clawGrabber];

export const DEFAULT_SKIN: Record<FamilyId, string> = { brawler: 'brawler.rope_hook', ogre: 'ogre.vine_tusk_hook', bot: 'bot.crane_hook' };

// ---------------------------------------------------------------------------------------------
// Grapple claws (kind 1): three prongs round a shaft, per family material
// ---------------------------------------------------------------------------------------------

export function grappleRecipe(family: FamilyId): SkinRecipe {
  const mat: MPaint = family === 'ogre' ? ivory(141, 3) : family === 'bot' ? (x, y, z) => pk(shade(0x8a929c, 0.9 + vnoise(x / 0.03, y / 0.03, z / 0.03, 1, 142) * 0.2), Surf.Steel) : rustyIron(143, 0.35);
  const tipP: MPaint = family === 'ogre' ? solid(0xfff4d8, Surf.Ivory, 144) : steelEdge(145);
  return {
    id: `grapple.${family}`,
    family,
    scale: 0.55,
    bounds: { x0: -0.36, x1: 0.36, y0: -0.3, y1: 0.3, z0: -0.5, z1: 0.36 },
    eye: 0.46,
    coil: { x: 0, z: -0.2, r: 0.08 },
    link: family === 'ogre' ? 'thinvine' : family === 'bot' ? 'thincable' : 'twine',
    tether: 'none',
    tetherLen: 0,
    hot: [0, 0, 0.2],
    heat: HOT_FRONT(-0.1, 0.2),
    draw(b) {
      b.tube([{ x: 0, y: 0, z: -0.4, r: 0.045 }, { x: 0, y: 0, z: 0.12, r: 0.05 }], mat);
      b.ring(0, 0, -0.44, 1, 0.06, 0.022, mat);
      for (const deg of [90, 210, 330]) {
        const a = (deg * Math.PI) / 180;
        const ux = Math.cos(a);
        const uy = Math.sin(a) * 0.62;
        const P = (rad: number, z: number, r: number): MPt => ({ x: ux * rad, y: uy * rad, z, r });
        const path = spline([P(0.03, 0.1, 0.045), P(0.16, 0.2, 0.04), P(0.28, 0.16, 0.034), P(0.3, 0.02, 0.026), P(0.24, -0.08, 0.016)], 5);
        b.tube(path, (x, y, z, s, d, aa) => (s > 0.8 ? tipP(x, y, z, s, d, aa) : mat(x, y, z, s, d, aa)));
      }
      // team wrap on the shaft
      b.tube([{ x: 0, y: 0, z: -0.24, r: 0.064 }, { x: 0, y: 0, z: -0.12, r: 0.064 }], family === 'bot' ? HAZ : teamWhite(146, Surf.Rope));
      if (family === 'bot') b.ball(0, 0.07, -0.3, 0.03, 0.025, 0.03, teamWhite(147, Surf.Glow, 0xf0f0f0));
      b.wear(148, 0.2);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Held tethers: from the grip (origin) along +Z to the tie-on point at z = len (metres)
// ---------------------------------------------------------------------------------------------

export function drawTether(b: Builder, kind: SkinRecipe['tether'], len: number): void {
  if (kind === 'rope' || kind === 'tar' || kind === 'goldrope') {
    const tone = kind === 'tar' ? 1 : kind === 'goldrope' ? 2 : 0;
    const pts: MPt[] = [
      { x: 0, y: 0, z: -0.02, r: 0.03 },
      { x: 0.008, y: 0.004, z: len * 0.4, r: 0.03 },
      { x: -0.006, y: 0, z: len * 0.75, r: 0.03 },
      { x: 0, y: 0, z: len + 0.02, r: 0.03 },
    ];
    b.tube(pts, kind === 'goldrope' ? goldRope(151) : rope(152, tone as 0 | 1 | 2, 3, len / 0.05));
    // an overhand knot partway down
    b.ball(0, 0, len * 0.45, 0.046, 0.044, 0.04, kind === 'goldrope' ? goldRope(153) : rope(154, tone as 0 | 1 | 2, 3, 2));
    // a frayed coil of slack wound round the fist
    b.ring(0, 0, 0.02, 2, 0.045, 0.02, kind === 'goldrope' ? goldRope(155) : rope(156, tone as 0 | 1 | 2, 3, 4));
  } else if (kind === 'heavychain') {
    const n = Math.max(2, Math.round(len / 0.07));
    for (let i = 0; i < n; i++) {
      const z = (i + 0.5) * (len / n);
      b.ring(0, 0, z, i & 1 ? 0 : 1, 0.03, 0.013, rustyIron(157 + i, 0.5), 1.6);
    }
  } else if (kind === 'cable') {
    b.tube([{ x: 0, y: 0, z: 0, r: 0.02 }, { x: 0, y: 0, z: len, r: 0.02 }], (x, y, z, s, d, a) =>
      pk(shade(((a * 3 + s * 8) % 1) < 0.25 ? 0x5a6068 : 0x9aa2ac, 0.95 + hashVox(Math.floor(x * 300), Math.floor(y * 300), Math.floor(z * 300), 158) * 0.1), Surf.Steel),
    );
    // swaged ferrules at both ends
    b.tube([{ x: 0, y: 0, z: -0.01, r: 0.03 }, { x: 0, y: 0, z: 0.05, r: 0.03 }], steelEdge(159));
    b.tube([{ x: 0, y: 0, z: len - 0.05, r: 0.03 }, { x: 0, y: 0, z: len + 0.01, r: 0.03 }], steelEdge(160));
  } else if (kind === 'vine') {
    b.tube([{ x: 0, y: 0, z: -0.02, r: 0.026 }, { x: 0.01, y: 0, z: len * 0.5, r: 0.028 }, { x: 0, y: 0, z: len + 0.02, r: 0.026 }], vine(161, 0.4));
    leaf(b, 0.02, 0, len * 0.5, 1, 0.4, 0.06, 0.022, leafy(162), 0.2);
  }
}

export function tetherBounds(len: number): Bounds {
  return { x0: -0.08, x1: 0.08, y0: -0.07, y1: 0.07, z0: -0.04, z1: Math.max(0.05, len) + 0.05 };
}

// ---------------------------------------------------------------------------------------------
// Chain links (real metres). Each is one link along +Z, `spacing` long, meeting the next seamlessly.
// ---------------------------------------------------------------------------------------------

export interface LinkRecipe {
  spacing: number;
  /** roll per link (radians) */
  twist: number;
  /** alternate every other link by 90 degrees (interlocking chain) */
  alt: boolean;
  /** sag (max metres, per metre of span) */
  sagMax: number;
  sagPerM: number;
  bounds: Bounds;
  draw(b: Builder): void;
  /** an extra (knot, leaf) every N links */
  extraEvery: number;
  extraFlip: boolean;
  extraBounds?: Bounds;
  drawExtra?(b: Builder): void;
}

function ropeLinkRecipe(kind: 'rope' | 'tar' | 'goldrope' | 'twine', r: number, spacing: number): LinkRecipe {
  const tone = kind === 'tar' ? 1 : kind === 'goldrope' || kind === 'twine' ? 2 : 0;
  const paint = kind === 'goldrope' ? goldRopeLink() : rope(171, tone as 0 | 1 | 2, 3, 1);
  return {
    spacing,
    twist: 0,
    alt: false,
    sagMax: kind === 'twine' ? 0.35 : 0.5,
    sagPerM: kind === 'twine' ? 0.03 : 0.034,
    bounds: { x0: -r - 0.02, x1: r + 0.02, y0: -r - 0.02, y1: r + 0.02, z0: -spacing / 2 - 0.01, z1: spacing / 2 + 0.01 },
    draw: (b) => b.tube([{ x: 0, y: 0, z: -spacing / 2, r }, { x: 0, y: 0, z: spacing / 2, r }], paint),
    extraEvery: kind === 'twine' ? 0 : 9,
    extraFlip: false,
    extraBounds: { x0: -r * 1.9, x1: r * 1.9, y0: -r * 1.9, y1: r * 1.9, z0: -r * 1.6, z1: r * 1.6 },
    drawExtra: (b) => {
      b.ball(0, 0, 0, r * 1.6, r * 1.55, r * 1.35, kind === 'goldrope' ? goldRopeLink() : rope(172, tone as 0 | 1 | 2, 3, 2));
    },
  };
}

function goldRopeLink(): MPaint {
  const base = rope(173, 2, 3, 1);
  const g = gold(174);
  return (x, y, z, s, d, a) => {
    const f = (((a * 3 + s) % 1) + 1) % 1;
    return f > 0.2 && f < 0.5 ? g(x, y, z, s, d, a) : base(x, y, z, s, d, a);
  };
}

function vineLinkRecipe(thin: boolean, kind: 'vine' | 'jawvine' | 'root' | 'thinvine'): LinkRecipe {
  const r = thin ? 0.027 : kind === 'root' ? 0.044 : 0.038;
  const spacing = thin ? 0.1 : 0.14;
  const paint = kind === 'root' ? bark(181) : vine(182, kind === 'jawvine' ? 0.55 : 0.3);
  return {
    spacing,
    twist: 1.3,
    alt: false,
    sagMax: thin ? 0.35 : 0.5,
    sagPerM: thin ? 0.03 : 0.034,
    bounds: { x0: -r - 0.02, x1: r + 0.02, y0: -r - 0.02, y1: r + 0.02, z0: -spacing / 2 - 0.01, z1: spacing / 2 + 0.01 },
    draw: (b) => b.tube([{ x: 0, y: 0, z: -spacing / 2, r }, { x: 0.004, y: 0, z: 0, r: r * 1.05 }, { x: 0, y: 0, z: spacing / 2, r }], paint),
    extraEvery: kind === 'jawvine' ? 5 : kind === 'root' ? 4 : thin ? 7 : 3,
    extraFlip: true,
    extraBounds: { x0: -0.02, x1: 0.2, y0: -0.04, y1: 0.06, z0: -0.07, z1: 0.07 },
    drawExtra: (b) => {
      b.tube([{ x: 0, y: 0, z: 0, r: 0.01 }, { x: 0.03, y: 0, z: 0, r: 0.01 }], solid(0x3e5a1c, Surf.Leaf, 183));
      leaf(b, 0.03, 0, 0, 1, 0, thin ? 0.09 : 0.13, thin ? 0.03 : 0.045, leafy(184), 0.15);
    },
  };
}

function steelLinkRecipe(heavy: boolean): LinkRecipe {
  const R = heavy ? 0.054 : 0.04;
  const r = heavy ? 0.021 : 0.016;
  const stretch = 1.55;
  const spacing = heavy ? 0.15 : 0.115;
  const paint = heavy ? rustyIron(191, 0.65, 0.04) : (x: number, y: number, z: number) => pk(shade(0x8e969e, 0.88 + vnoise(x / 0.02, y / 0.02, z / 0.02, 1, 192) * 0.24), Surf.Steel);
  return {
    spacing,
    twist: 0,
    alt: true,
    sagMax: heavy ? 0.55 : 0.42,
    sagPerM: heavy ? 0.036 : 0.03,
    bounds: { x0: -R - r - 0.02, x1: R + r + 0.02, y0: -R - r - 0.02, y1: R + r + 0.02, z0: -R * stretch - r - 0.03, z1: R * stretch + r + 0.03 },
    draw: (b) => b.ring(0, 0, 0, 0, R, r, paint, stretch),
    extraEvery: 0,
    extraFlip: false,
  };
}

function cableLinkRecipe(kind: 'cable' | 'thincable' | 'steelcable' | 'hose'): LinkRecipe {
  const r = kind === 'hose' ? 0.036 : kind === 'thincable' ? 0.02 : 0.027;
  const spacing = 0.1;
  const paint: MPaint =
    kind === 'hose'
      ? (x, y, z, s) => pk(shade(s > 0.42 && s < 0.58 ? 0xe2a81e : 0x1c1c1e, 0.9 + vnoise(x / 0.02, y / 0.02, z / 0.02, 1, 201) * 0.2), Surf.Rubber)
      : (x, y, z, s, _d, a) => pk(shade(((a * 4 + s) % 1) < 0.22 ? 0x4e545c : 0x9aa2ac, 0.94 + hashVox(Math.floor(x * 300), Math.floor(y * 300), Math.floor(z * 300), 202) * 0.1), Surf.Steel);
  return {
    spacing,
    twist: kind === 'hose' ? 0 : Math.PI / 2,
    alt: false,
    sagMax: kind === 'hose' ? 0.45 : 0.3,
    sagPerM: kind === 'hose' ? 0.032 : 0.026,
    bounds: { x0: -r - 0.02, x1: r + 0.02, y0: -r - 0.02, y1: r + 0.02, z0: -spacing / 2 - 0.01, z1: spacing / 2 + 0.01 },
    draw: (b) => b.tube([{ x: 0, y: 0, z: -spacing / 2, r }, { x: 0, y: 0, z: spacing / 2, r }], paint),
    extraEvery: 0,
    extraFlip: false,
  };
}

export function linkRecipe(kind: LinkKind): LinkRecipe {
  switch (kind) {
    case 'rope':
      return ropeLinkRecipe('rope', 0.042, 0.13);
    case 'tar':
      return ropeLinkRecipe('tar', 0.038, 0.12);
    case 'goldrope':
      return ropeLinkRecipe('goldrope', 0.04, 0.13);
    case 'twine':
      return ropeLinkRecipe('twine', 0.026, 0.1);
    case 'heavychain':
      return steelLinkRecipe(true);
    case 'chain':
      return steelLinkRecipe(false);
    case 'vine':
    case 'jawvine':
    case 'root':
      return vineLinkRecipe(false, kind);
    case 'thinvine':
      return vineLinkRecipe(true, 'thinvine');
    default:
      return cableLinkRecipe(kind);
  }
}

// ---------------------------------------------------------------------------------------------
// The spring coil (Ricochet Spring / Boing Barb), pink enamel wire, along +Z, metres
// ---------------------------------------------------------------------------------------------

export function drawCoil(b: Builder, R: number, len: number, turns: number, wire: number): void {
  const pts: MPt[] = [];
  const steps = Math.ceil(turns * 18);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2;
    pts.push({ x: Math.cos(a) * R, y: Math.sin(a) * R, z: -len / 2 + t * len, r: wire });
  }
  b.tube(pts, (x, y, z) => pk(shade(y > 0 ? 0xff8ad8 : 0xd8409e, 0.94 + vnoise(x / 0.01, y / 0.01, z / 0.01, 1, 211) * 0.12), Surf.Paint));
}
