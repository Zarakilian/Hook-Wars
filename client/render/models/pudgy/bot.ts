// Butcher-Bot: a riveted, barrel-bellied steam robot with team-coloured armour plates and
// pauldrons, glowing vents on its back, a glowing visor and a crane-claw hook on its right arm.
import { COSMETIC_NAMES, TEAM_COLORS, type PudgyPalette } from '../../contracts.ts';
import type { Cosmetics, Team } from '../../../../shared/types.ts';
import { dropGrid, part, partMirrored, wrap, type TeamCols } from './common.ts';
import { CH, hashVox, mix, RGrid, shade, type ColorFn } from './grid.ts';
import type { FamilyBuild, HatMode, PartDef, PartName, Skeleton, V3 } from './types.ts';

const STEEL = 0x8c949e;
const STEEL_LIGHT = 0xb4bcc6;
const STEEL_DARK = 0x4c535c;
const GUNMETAL = 0x3a4048;
const CHROME = 0xd6dde5;
const BRASS = 0xd9a441;
const COPPER = 0xc8743a;
const RUBBER = 0x24262b;
const HAZARD = 0xf2c230;
const RUST = [0x8a4a2a, 0xa65a2e, 0x6e3c22] as const;
const EMBER = 0xff9a3a;

const SK: Skeleton = {
  core: 13,
  hip: [0, 6.5, 0],
  leg: [4.5, 6.5, 0],
  body: [0, 13.5, 0.5],
  neck: [0, 21, 0.5],
  shoulder: [10.5, 18.5, 0],
  elbow: [10.5, 13, 0],
  hand: [10.5, 7, 0.5],
  jaw: [0, 23.5, 1.5],
  eyes: [0, 26, 6],
  hat: [0, 30, 0.5],
  hatExtra: [0, 33, 0.5],
  drop: [6, 27, 3],
};
const HEAD_C: V3 = [0, 25.6, 0.5];

const steel = (base: number, seed: number): ColorFn => (x, y, z) => {
  const h = hashVox(x, y, z, seed);
  return shade(base, 0.93 + h * 0.12);
};

function rusty(g: RGrid, amount: number, seed: number): void {
  g.each((c, x, y, z) => {
    const ch = c & 7;
    if (ch !== CH.iron && ch !== CH.rubber) return;
    const blot = hashVox(Math.floor(x / 3), Math.floor(y / 3), Math.floor(z / 3), seed);
    if (blot > 1 - amount && hashVox(x, y, z, seed + 1) > 0.25) return RUST[Math.floor(hashVox(x, y, z, seed + 2) * 3) % 3];
    return undefined;
  }, true);
}

// ---------------------------------------------------------------------------------------------
// Body: riveted barrel
// ---------------------------------------------------------------------------------------------

function barrelR(y: number): number {
  // bulge in the middle, rounded at the ends
  const t = (y - 13.5) / 8.5;
  const bulge = 1 + 0.07 * Math.cos(t * Math.PI * 0.5);
  const end = t > 0.82 ? Math.sqrt(Math.max(0, 1 - ((t - 0.82) / 0.3) ** 2)) * 0.25 + 0.75 : t < -0.85 ? Math.sqrt(Math.max(0, 1 - ((-t - 0.85) / 0.3) ** 2)) * 0.3 + 0.7 : 1;
  return bulge * end;
}

function inBarrel(x: number, y: number, z: number, grow = 0): boolean {
  if (y < 5 || y > 21) return false;
  const k = barrelR(y + 0.5);
  const a = 10 * k + grow;
  const b = 8.8 * k + grow;
  const dx = Math.abs(x + 0.5) / a;
  const dz = Math.abs(z + 0.5 - 0.5) / b;
  return dx ** 2.6 + dz ** 2.6 <= 1;
}

function buildBody(accent: number, t: TeamCols): RGrid {
  const g = new RGrid(28, 27, 26, -14, 3, -13);
  // frame
  g.on(CH.iron, () => {
    for (let y = 5; y <= 21; y++) for (let z = -12; z <= 12; z++) for (let x = -13; x <= 12; x++) if (inBarrel(x, y, z)) g.set(x, y, z, steel(STEEL, 1)(x, y, z));
  });
  // hoops top, middle-back and bottom with rivets
  const hoop = (y: number, col: number) => {
    g.on(accent === 3 ? CH.brass : CH.iron, () => {
      for (let z = -12; z <= 12; z++)
        for (let x = -13; x <= 12; x++) if (inBarrel(x, y, z, 1) && !inBarrel(x, y, z)) g.set(x, y, z, (x + z) % 3 === 0 ? (accent === 3 ? 0xf6cf6a : STEEL_LIGHT) : col);
    });
  };
  hoop(6, accent === 3 ? BRASS : GUNMETAL);
  hoop(20, accent === 3 ? BRASS : GUNMETAL);
  // team armour: big front belly plate and side plates, standing one voxel proud
  const plate = (test: (x: number, y: number, z: number) => boolean, rim: number) => {
    g.on(CH.rubber, () => {
      for (let y = 5; y <= 21; y++)
        for (let z = -12; z <= 12; z++)
          for (let x = -13; x <= 12; x++) {
            if (!inBarrel(x, y, z, 1) || inBarrel(x, y, z) || !test(x, y, z)) continue;
            const edge = !test(x + 1, y, z) || !test(x - 1, y, z) || !test(x, y + 1, z) || !test(x, y - 1, z);
            const h = hashVox(x, y, z, 3);
            g.set(x, y, z, edge ? rim : shade(h > 0.94 ? t.light : t.main, 0.92 + (y - 8) * 0.012 + h * 0.06));
          }
    });
  };
  const rim = accent === 3 ? BRASS : t.dark;
  plate((x, y, z) => z > 2 && y >= 8 && y <= 18 && Math.abs(x + 0.5) < 7.5, rim);
  plate((x, y, z) => Math.abs(x + 0.5) > 8 && y >= 9 && y <= 17 && Math.abs(z) < 5, rim);
  if (accent === 3) g.repaint((x, y, z) => (z > 2 && (y === 8 || y === 18) && Math.abs(x + 0.5) < 7.5), CH.brass, BRASS, true);
  // rivets around the belly plate
  g.on(CH.iron, () => {
    for (let y = 8; y <= 18; y += 2)
      for (const x of [-8, 7]) {
        for (let z = 12; z > 0; z--)
          if (g.has(x, y, z)) {
            g.set(x, y, z + 1, STEEL_LIGHT);
            break;
          }
      }
  });
  if (accent === 4) {
    // extra rivet rows all over
    g.each((c, x, y, z) => {
      if ((c & 7) === CH.iron && y % 3 === 0 && (x + z) % 3 === 0) return STEEL_LIGHT;
      return undefined;
    }, true);
    g.on(CH.brass, () => {
      for (let y = 9; y <= 17; y += 2)
        for (let x = -6; x <= 5; x += 2) {
          for (let z = 13; z > 0; z--)
            if (g.has(x, y, z)) {
              g.set(x, y, z + 1, (x + y) % 4 === 1 ? 0xf6cf6a : BRASS);
              break;
            }
        }
    });
    g.on(CH.iron, () => {
      for (let y = 7; y <= 19; y += 3)
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          const k = barrelR(y + 0.5);
          g.add(Math.cos(a) * (10 * k + 0.6), y, 0.5 + Math.sin(a) * (8.8 * k + 0.6), STEEL_LIGHT);
        }
    });
  }
  // collar on top
  g.on(CH.iron, () => g.cyl('y', 0, 0.5, 6.2, 21, 22, (x, y, z) => ((x + z) % 2 === 0 ? GUNMETAL : STEEL_DARK)));
  // back: two glowing steam vents with louvres, pipes to the shoulders
  const vent = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        let zb = -13;
        for (let z = -12; z <= 0; z++)
          if (g.has(x, y, z)) {
            zb = z;
            break;
          }
        if (zb <= -13) continue;
        const slat = (y - y0) % 2 === 0;
        g.on(slat ? CH.iron : CH.pulse, () => g.set(x, y, zb, slat ? GUNMETAL : EMBER));
        if (x === x0 || x === x1 || y === y0 || y === y1) g.on(CH.iron, () => g.set(x, y, zb - 1, STEEL_DARK));
      }
  };
  const big = accent === 5;
  vent(-6, -2, 11, big ? 18 : 16);
  vent(1, 5, 11, big ? 18 : 16);
  g.on(CH.brass, () => {
    for (const s of [1, -1]) {
      g.tube(s * 4, 17, -8.5, s * 7, 21, -6, 0.9, COPPER);
      g.tube(s * 7, 21, -6, s * 9.5, 21, -2, 0.9, COPPER);
    }
  });
  switch (accent) {
    case 1:
      rusty(g, 0.28, 31);
      break;
    case 2:
      // hazard stripes across the belly plate
      g.repaint((x, y, z) => z > 2 && y >= 15 && y <= 17 && Math.abs(x + 0.5) < 7.5, CH.rubber, (x, y) => ((x + y + 40) % 4 < 2 ? HAZARD : 0x1f2026), true);
      break;
    case 5:
      // pipe bundle
      g.on(CH.brass, () => {
        for (let i = 0; i < 4; i++) {
          const x = -4.5 + i * 3;
          const col = i % 2 ? COPPER : 0x9aa2ab;
          g.tube(x, 6, -10.6, x, 21, -10.2, 1.1, col);
          g.tube(x, 21, -10.2, x * 1.6, 24.5, -5, 1.1, col);
          g.tube(x * 1.6, 24.5, -5, x * 1.9, 22.5, 1, 1.1, col);
          g.set(x, 9, -12, BRASS);
          g.set(x, 15, -12, BRASS);
        }
      });
      break;
    case 6:
      // gauge panel: two big dials mounted proud of the belly plate, and a glowing indicator lamp
      {
        /** first empty cell in front of the belly surface at (x, y) */
        const front = (x: number, y: number): number => {
          for (let z = 13; z > 0; z--) if (g.has(x, y, z)) return z + 1;
          return 11;
        };
        for (const [cx, cy] of [[-4, 13], [3, 14]] as const) {
          const zf = front(cx, cy);
          for (let y = -3; y <= 2; y++)
            for (let x = -3; x <= 2; x++) {
              const r = Math.hypot(x + 0.5, y + 0.5);
              if (r > 3.1) continue;
              const rim = r > 2.2;
              g.on(rim ? CH.brass : CH.wet, () => g.set(cx + x, cy + y, zf, rim ? ((x + y) % 2 ? BRASS : 0xf6cf6a) : 0xf4f1e6));
            }
          // needle and tick marks
          g.on(CH.wet, () => {
            g.set(cx, cy, zf + 1, 0x1d1f24);
            g.set(cx + 1, cy + 1, zf + 1, 0xd8302a);
            g.set(cx + 1, cy - 2, zf, 0x2a2c33);
            g.set(cx - 2, cy + 1, zf, 0x2a2c33);
          });
        }
        g.on(CH.pulse, () => g.box(-1, 9, front(-1, 9), 0, 10, front(0, 10), 0x6aff7a));
      }
      break;
    case 7:
      // copper coils with glowing tops
      for (const x of [-8, 7]) {
        g.on(CH.brass, () => {
          for (let y = 19; y <= 26; y++) g.cyl('y', x + 0.5, -4, y % 2 ? 1.7 : 1.2, y, y, y % 2 ? COPPER : 0xa65a28);
        });
        g.on(CH.pulse, () => g.blob(x + 0.5, 27.6, -4, 1.4, 1.2, 1.4, 0x9fd8ff));
      }
      break;
    default:
      break;
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Head, jaw, eyes
// ---------------------------------------------------------------------------------------------

function inHead(x: number, y: number, z: number): boolean {
  const [cx, cy, cz] = HEAD_C;
  if (y < 21.5 || y > 30.5) return false;
  const top = y > 27 ? Math.sqrt(Math.max(0, 1 - ((y + 0.5 - 27) / 3.6) ** 2)) : 1;
  const dx = Math.abs(x + 0.5 - cx) / (5.6 * (0.35 + 0.65 * top));
  const dz = Math.abs(z + 0.5 - cz) / (5.3 * (0.35 + 0.65 * top));
  void cy;
  return dx ** 3 + dz ** 3 <= 1;
}

function buildHead(face: number, t: TeamCols, bare: boolean): RGrid {
  const g = new RGrid(16, 14, 16, -8, 20, -7);
  g.on(CH.iron, () => {
    for (let y = 21; y <= 31; y++) for (let z = -7; z <= 8; z++) for (let x = -8; x <= 7; x++) if (inHead(x, y, z)) g.set(x, y, z, steel(y > 27 ? STEEL_LIGHT : STEEL, 41)(x, y, z));
  });
  // team stripe over the dome (reads from above)
  g.repaint((x, y, z) => Math.abs(x + 0.5) < 1.6 && y >= 27, CH.rubber, (x, y, z) => shade(t.main, 0.95 + hashVox(x, y, z, 42) * 0.08), true);
  // ear bolts
  g.on(CH.brass, () => {
    g.cyl('x', 25, 0.5, 1.4, 5, 6, BRASS);
    g.cyl('x', 25, 0.5, 1.4, -7, -6, BRASS);
    g.set(6, 25, 0, 0xf6cf6a);
    g.set(-7, 25, 0, 0xf6cf6a);
  });
  // jaw recess
  g.carve((x, y, z) => y < 23.5 && z > 1 && Math.abs(x + 0.5) < 4.6);
  g.on(CH.iron, () => {
    for (let x = -4; x <= 3; x++) for (let z = 1; z <= 5; z++) g.add(x, 23, z, 0x1c1f24);
  });
  // face plate recess for the eyes
  if (face === 5) {
    g.on(CH.wet, () => g.box(-4, 24, 5, 3, 28, 6, 0x101418));
  } else {
    g.carve((x, y, z) => z >= 5 && y >= 25 && y <= 27 && Math.abs(x + 0.5) < (face === 3 ? 2.6 : 4.6));
    g.on(CH.iron, () => {
      for (let y = 25; y <= 27; y++) for (let x = -5; x <= 4; x++) g.add(x, y, 4, GUNMETAL);
    });
    if (face === 3 || face === 4) {
      g.on(CH.brass, () => {
        const cx = face === 3 ? -0.5 : 1.5;
        for (let a = 0; a < 16; a++) g.add(cx + Math.cos((a / 16) * Math.PI * 2) * 2.6, 26 + Math.sin((a / 16) * Math.PI * 2) * 2.6, 6, BRASS);
      });
    }
  }
  if (bare) {
    // antenna with a blinking tip
    g.on(CH.iron, () => g.box(2, 30, -1, 2, 33, -1, STEEL_DARK));
    g.on(CH.glow, () => g.set(2, 34, -1, t.light));
  }
  return g;
}

function buildJaw(face: number, t: TeamCols): RGrid {
  const g = new RGrid(12, 6, 10, -6, 20, -1);
  g.on(CH.iron, () => {
    for (let y = 21; y <= 23; y++) for (let z = 1; z <= 6; z++) for (let x = -5; x <= 4; x++) if (inHead(x, y, z)) g.set(x, y, z, steel(STEEL_DARK, 51)(x, y, z));
  });
  if (face === 2) {
    // speaker grille
    g.repaint((x, y, z) => z >= 4 && y <= 22, CH.iron, (x, y) => (y % 2 === 0 ? 0x15171b : STEEL_LIGHT), true);
  } else if (face === 5) {
    // pixel smile
    g.repaint((x, y, z) => z >= 4, CH.wet, 0x101418, true);
    g.on(CH.glow, () => {
      for (const x of [-3, 2]) g.set(x, 23, 6, t.light);
      for (let x = -2; x <= 1; x++) g.set(x, 22, 6, t.light);
    });
  } else {
    g.repaint((x, y, z) => z >= 5 && y === 22 && (x + 10) % 2 === 0, CH.iron, 0x15171b, true);
  }
  return g;
}

function buildEyes(face: number, t: TeamCols): RGrid {
  const g = new RGrid(14, 8, 4, -7, 23, 4);
  const hot = mix(t.light, 0xffffff, 0.45);
  g.on(CH.glow, () => {
    switch (face) {
      case 0:
        for (let x = -4; x <= 3; x++) g.set(x, 26, 6, Math.abs(x + 0.5) < 2 ? hot : t.light);
        for (let x = -3; x <= 2; x++) g.set(x, 25, 5, shade(t.light, 0.7));
        break;
      case 1:
        for (const cx of [2, -3]) {
          g.box(cx, 25, 6, cx + 1, 26, 6, t.light);
          g.set(cx + (cx > 0 ? 1 : 0), 26, 7, hot);
        }
        break;
      case 2:
        for (let x = -4; x <= 3; x++) g.set(x, 26, 5, t.light);
        g.set(-2, 26, 6, hot);
        g.set(1, 26, 6, hot);
        break;
      case 3:
        g.box(-2, 25, 6, 1, 27, 6, t.light);
        g.box(-1, 25, 7, 0, 26, 7, hot);
        break;
      case 4:
        g.box(0, 25, 6, 2, 27, 6, t.light);
        g.set(1, 26, 7, hot);
        g.set(-3, 26, 6, t.light);
        break;
      case 5:
        // pixel eyes: happy arches
        for (const cx of [2, -3]) {
          g.set(cx, 26, 6, t.light);
          g.set(cx + 1, 26, 6, t.light);
          g.set(cx - 1, 25, 6, t.light);
          g.set(cx + 2, 25, 6, t.light);
        }
        break;
      default:
        break;
    }
  });
  if (face === 1) {
    g.on(CH.iron, () => {
      for (const cx of [2.5, -2.5]) for (let a = 0; a < 12; a++) g.add(cx + Math.cos((a / 12) * Math.PI * 2) * 1.9, 26 + Math.sin((a / 12) * Math.PI * 2) * 1.9, 5, GUNMETAL);
    });
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Hats
// ---------------------------------------------------------------------------------------------

interface HatMeta {
  hat: boolean;
  extra: boolean;
  mode: HatMode;
  spin: number;
  extraJoint: V3;
}
const HC = HEAD_C[2];
const HAT_META: readonly HatMeta[] = [
  { hat: false, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: true, mode: 'spin', spin: 1.6, extraJoint: [0, 33, HC - 1] },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: true, mode: 'spin', spin: 0.8, extraJoint: [0, 30, HC] },
  { hat: true, extra: true, mode: 'spin', spin: 14, extraJoint: [0, 34, HC] },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
];

function buildHat(hat: number, t: TeamCols): { hat: RGrid | null; extra: RGrid | null } {
  const cz = HC;
  const g = new RGrid(20, 14, 20, -10, 27, cz - 10);
  switch (hat) {
    case 1: {
      // smokestack with a brass band and an ember glow at the top
      g.on(CH.iron, () => {
        g.cyl('y', -1.5, cz - 1, 2.2, 29, 35, steel(GUNMETAL, 61));
        g.cyl('y', -1.5, cz - 1, 2.8, 35, 36, STEEL_DARK);
      });
      g.on(CH.brass, () => g.cyl('y', -1.5, cz - 1, 2.5, 32, 32, BRASS));
      g.on(CH.pulse, () => g.cyl('y', -1.5, cz - 1, 1.4, 36, 36, EMBER));
      g.on(CH.rubber, () => g.cyl('y', -1.5, cz - 1, 2.5, 30, 30, t.main));
      return { hat: g, extra: null };
    }
    case 2: {
      // radar dish on a mast (dish spins)
      g.on(CH.iron, () => g.box(-1, 29, cz - 2, 0, 32, cz - 1, STEEL_DARK));
      const d = new RGrid(14, 8, 10, -7, 31, cz - 6);
      d.on(CH.iron, () => {
        for (let y = -3; y <= 3; y++)
          for (let x = -5; x <= 4; x++) {
            const r = Math.hypot(x + 0.5, y + 0.5);
            if (r <= 4.6) d.set(x, 34 + y * 0.8, cz - 1 + 3 - r * 0.5, r > 3.8 ? t.main : steel(STEEL_LIGHT, 62)(x, y, 0));
          }
        d.box(-1, 34, cz - 1, 0, 34, cz + 2, STEEL_DARK);
      });
      d.on(CH.glow, () => d.set(-1, 34, cz + 3, t.light));
      return { hat: g, extra: d };
    }
    case 3: {
      // searchlight lamp head
      g.on(CH.iron, () => {
        g.box(-4, 29, cz - 3, 3, 33, cz + 3, steel(GUNMETAL, 63));
        g.box(-3, 34, cz - 2, 2, 34, cz + 1, STEEL_DARK);
      });
      g.on(CH.glow, () => g.box(-3, 30, cz + 4, 2, 32, cz + 4, 0xfff4c8));
      g.on(CH.brass, () => {
        for (let x = -4; x <= 3; x++) {
          g.set(x, 29, cz + 4, BRASS);
          g.set(x, 33, cz + 4, BRASS);
        }
      });
      g.on(CH.rubber, () => g.box(-4, 31, cz - 3, -4, 31, cz + 3, t.main));
      return { hat: g, extra: null };
    }
    case 4: {
      // gear crown (turns slowly)
      g.on(CH.rubber, () => g.cyl('y', 0, cz, 4.4, 29, 29, t.main));
      const c = new RGrid(16, 6, 16, -8, 28, cz - 8);
      c.on(CH.brass, () => {
        for (let i = 0; i < 36; i++) {
          const a = (i / 36) * Math.PI * 2;
          c.set(Math.cos(a) * 4.8, 30, cz + Math.sin(a) * 4.8, BRASS);
          if (i % 4 < 2) {
            c.set(Math.cos(a) * 4.8, 31, cz + Math.sin(a) * 4.8, shade(BRASS, 1.1));
            c.set(Math.cos(a) * 4.8, 32, cz + Math.sin(a) * 4.8, shade(BRASS, 1.2));
          }
        }
      });
      return { hat: g, extra: c };
    }
    case 5: {
      // propeller beanie: team cap, mast, spinning blades
      g.on(CH.rubber, () => g.blob(0, 29, cz, 4.4, 2.4, 4.2, (x, y, z) => ((x + 40) % 4 < 2 ? t.main : t.light), (x, y) => y >= 29));
      g.on(CH.iron, () => g.box(-1, 31, cz - 1, 0, 33, cz, STEEL_DARK));
      const p = new RGrid(18, 3, 6, -9, 33, cz - 3);
      p.on(CH.rubber, () => {
        p.box(-8, 34, cz - 1, -2, 34, cz, t.main);
        p.box(1, 34, cz - 1, 7, 34, cz, HAZARD);
      });
      p.on(CH.brass, () => p.box(-1, 34, cz - 1, 0, 35, cz, BRASS));
      return { hat: g, extra: p };
    }
    case 6: {
      // welding mask flipped up on the forehead
      g.on(CH.iron, () => {
        for (let x = -5; x <= 4; x++) for (let y = 28; y <= 32; y++) for (let z = cz + 1; z <= cz + 3; z++) if (Math.hypot(x + 0.5, (y - 30) * 1.2) < 5.5 && (z === cz + 1 + Math.floor(Math.abs(x + 0.5) / 3) || y === 32)) g.set(x, y, z - 1 + (y - 28) * 0.4, steel(GUNMETAL, 64)(x, y, z));
      });
      g.on(CH.wet, () => g.box(-2, 30, cz + 3, 1, 31, cz + 3, 0x1d3a2a));
      g.on(CH.rubber, () => g.box(-5, 28, cz - 1, 4, 28, cz + 1, t.main));
      return { hat: g, extra: null };
    }
    case 7: {
      // kettle lid with a knob and a steaming spout
      g.on(CH.iron, () => {
        g.blob(0, 29, cz, 5.4, 2.6, 5.2, steel(STEEL_LIGHT, 65), (x, y) => y >= 29);
        g.cyl('y', 0, cz, 5.8, 29, 29, STEEL_DARK);
      });
      g.on(CH.rubber, () => g.blob(0, 32.5, cz, 1.6, 1.3, 1.6, t.main));
      g.on(CH.brass, () => g.tube(4, 30, cz + 2, 6.5, 32, cz + 4, 0.8, COPPER));
      g.on(CH.pulse, () => g.set(6, 33, cz + 4, 0xe8f4ff));
      return { hat: g, extra: null };
    }
    default:
      return { hat: null, extra: null };
  }
}

// ---------------------------------------------------------------------------------------------
// Arms, legs, claw
// ---------------------------------------------------------------------------------------------

function buildUpperArm(accent: number, t: TeamCols): RGrid {
  const g = new RGrid(10, 12, 10, 5, 11, -5);
  const [sx, sy, sz] = SK.shoulder;
  g.on(CH.iron, () => {
    g.blob(sx, sy, sz, 2.3, 2.3, 2.3, steel(STEEL_DARK, 71));
    g.cyl('y', sx, sz, 1.6, 14, 17, steel(GUNMETAL, 72));
    g.cyl('y', sx, sz, 1.0, 13, 15, CHROME);
  });
  // pauldron
  g.on(CH.rubber, () => {
    g.blob(sx + 0.3, sy + 0.2, sz, 3.6, 3, 3.6, (x, y, z) => {
      if (accent === 2 && y >= sy + 1 && (x + z + 40) % 4 < 2) return HAZARD;
      return shade(y > sy + 1.5 ? t.light : t.main, 0.94 + hashVox(x, y, z, 73) * 0.08);
    }, (x, y) => y >= sy - 0.5);
    for (let a = 0; a < 14; a++) g.set(sx + 0.3 + Math.cos((a / 14) * Math.PI * 2) * 3.4, sy - 0.5, sz + Math.sin((a / 14) * Math.PI * 2) * 3.4, accent === 3 ? BRASS : t.dark);
  });
  g.on(CH.iron, () => {
    g.set(sx + 3, sy + 1, sz, STEEL_LIGHT);
    g.set(sx, sy + 3, sz + 2, STEEL_LIGHT);
    g.set(sx, sy + 3, sz - 2, STEEL_LIGHT);
  });
  if (accent === 1) rusty(g, 0.3, 74);
  if (accent === 7) g.on(CH.brass, () => {
    for (let y = 14; y <= 16; y++) g.cyl('y', sx, sz, 1.9, y, y, y % 2 ? COPPER : 0xa65a28);
  });
  return g;
}

function buildLowerArm(accent: number, t: TeamCols, clawArm: boolean): RGrid {
  const g = new RGrid(10, 12, 10, 5, 1, -5);
  const [ex, ey, ez] = SK.elbow;
  const [hx, hy, hz] = SK.hand;
  g.on(CH.iron, () => {
    g.blob(ex, ey, ez, 1.9, 1.9, 1.9, steel(STEEL_DARK, 81));
    g.cyl('y', ex, ez + 0.3, 2.4, 8, 12, steel(STEEL, 82));
  });
  g.on(CH.rubber, () => g.cyl('y', ex, ez + 0.3, 2.6, 10, 11, accent === 2 ? (x, y) => ((x + y + 40) % 2 ? HAZARD : 0x1f2026) : t.main));
  if (clawArm) {
    // wrist coupling and cable spool; the claw itself is the hook part
    g.on(CH.brass, () => g.cyl('y', hx, hz, 2.2, 7, 7, BRASS));
    g.on(CH.iron, () => {
      g.cyl('x', hy + 1.5, hz, 1.2, Math.floor(hx) - 2, Math.floor(hx) + 1, STEEL_DARK);
      g.cyl('y', hx, hz, 1.2, 6, 6, 0x15171b);
    });
  } else {
    // three-finger gripper
    g.on(CH.iron, () => {
      g.box(Math.floor(hx) - 1, 6, Math.floor(hz) - 1, Math.floor(hx) + 1, 7, Math.floor(hz) + 1, steel(GUNMETAL, 83));
      for (const [dx, dz] of [[-1, 2], [1, 2], [0, -2]] as const) {
        g.box(Math.floor(hx) + dx, 4, Math.floor(hz) + dz, Math.floor(hx) + dx, 6, Math.floor(hz) + dz, STEEL_DARK);
        g.set(Math.floor(hx) + dx, 3, Math.floor(hz) + dz - Math.sign(dz), CHROME);
      }
    });
  }
  if (accent === 1) rusty(g, 0.3, 84);
  return g;
}

function buildLeg(accent: number, t: TeamCols): RGrid {
  const g = new RGrid(10, 10, 12, 0, 0, -5);
  const lx = SK.leg[0];
  g.on(CH.iron, () => {
    g.cyl('y', lx, 0, 2.1, 5, 8, steel(GUNMETAL, 91));
    g.cyl('y', lx, 0, 1.3, 3, 5, CHROME);
    g.blob(lx, 2.6, 0, 1.6, 1.4, 1.6, steel(STEEL_DARK, 92));
    // boxy foot
    g.box(Math.floor(lx) - 2, 0, -2, Math.floor(lx) + 2, 1, 4, steel(STEEL, 93));
  });
  g.on(CH.rubber, () => {
    g.box(Math.floor(lx) - 2, 0, -3, Math.floor(lx) + 2, 0, 4, RUBBER);
    g.box(Math.floor(lx) - 2, 1, 3, Math.floor(lx) + 2, 2, 5, (x, y, z) => (accent === 2 && (x + y + z) % 3 === 0 ? HAZARD : t.main));
  });
  if (accent === 1) rusty(g, 0.3, 94);
  return g;
}

function buildClaw(t: TeamCols): RGrid {
  // hand frame: the socket is the origin; claw hangs below the wrist coupling
  const g = new RGrid(10, 12, 12, -5, -10, -6);
  g.on(CH.iron, () => {
    // housing
    g.box(-2, -2, -2, 1, 0, 1, steel(STEEL, 101));
    // piston
    g.box(-1, -3, -1, 0, -3, 0, CHROME);
    g.box(-2, -4, -2, 1, -4, 1, STEEL_DARK);
    // two curved jaws (front and back) closing toward the tips
    const path: [number, number][] = [[-4, 2], [-5, 3], [-6, 3], [-7, 3], [-8, 2], [-8, 1]];
    for (const [y, z] of path) {
      g.box(-1, y, z, 0, y, z, steel(STEEL_DARK, 102));
      g.box(-1, y, -1 - z, 0, y, -1 - z, steel(STEEL_DARK, 103));
    }
    g.box(-1, -8, 0, 0, -8, 0, CHROME);
    g.box(-1, -8, -1, 0, -8, -1, CHROME);
  });
  g.on(CH.rubber, () => {
    for (let z = -2; z <= 1; z++) {
      g.set(2, -1, z, t.main);
      g.set(-3, -1, z, t.main);
    }
    for (let x = -2; x <= 1; x++) for (let z = -2; z <= 1; z++) g.set(x, 1, z, (x + z + 10) % 2 ? HAZARD : 0x22232a);
  });
  g.on(CH.glow, () => g.set(-1, -1, 2, t.light));
  return g;
}

// ---------------------------------------------------------------------------------------------

/** Dominant colour of each accent option (death debris, portraits). */
const ACCENT_COL = [STEEL_LIGHT, RUST[1], HAZARD, BRASS, STEEL_LIGHT, COPPER, 0xf2efe2, COPPER] as const;
/** Dominant colour of each hat option (0 = bare dome). */
const HAT_COL = [STEEL, GUNMETAL, STEEL_LIGHT, 0xfff4c8, BRASS, HAZARD, GUNMETAL, STEEL_LIGHT] as const;

export function botPalette(c: Cosmetics, team: Team): PudgyPalette {
  const n = COSMETIC_NAMES.bot;
  const t = TEAM_COLORS[team];
  const accent = ACCENT_COL[wrap(c.accent, n.accents.length)];
  const hat = HAT_COL[wrap(c.hat, n.hats.length)];
  return { skin: STEEL, skinDark: GUNMETAL, cloth: t.main, accent, metal: CHROME, extra: [STEEL_DARK, HAZARD, t.light, EMBER, hat] };
}

export function buildBot(c: Cosmetics, team: Team): FamilyBuild {
  const n = COSMETIC_NAMES.bot;
  const hat = wrap(c.hat, n.hats.length);
  const accent = wrap(c.accent, n.accents.length);
  const face = wrap(c.face, n.faces.length);
  const t = TEAM_COLORS[team];
  const k = (s: string) => `bot:${s}:${team}`;
  const hm = HAT_META[hat];
  const armKey = accent === 1 || accent === 2 || accent === 3 || accent === 7 ? accent : 0;
  const legKey = accent === 1 || accent === 2 ? accent : 0;
  const parts: Partial<Record<PartName, PartDef>> = {
    body: part(k(`body${accent}`), () => buildBody(accent, t), SK.body),
    head: part(k(`head${face}.${hat === 0 ? 1 : 0}`), () => buildHead(face, t, hat === 0), SK.neck),
    jaw: part(k(`jaw${face}`), () => buildJaw(face, t), SK.jaw),
    eyes: part(k(`eyes${face}`), () => buildEyes(face, t), SK.eyes, 0.2),
    upperL: part(k(`uarm${armKey}`), () => buildUpperArm(armKey, t), SK.shoulder),
    upperR: partMirrored(k(`uarm${armKey}`) + 'R', () => buildUpperArm(armKey, t), SK.shoulder),
    lowerL: part(k(`larm${armKey}`), () => buildLowerArm(armKey, t, false), SK.elbow),
    lowerR: partMirrored(k(`larm${armKey}`) + 'R', () => buildLowerArm(armKey, t, true), SK.elbow),
    legL: part(k(`leg${legKey}`), () => buildLeg(legKey, t), SK.leg),
    legR: partMirrored(k(`leg${legKey}`) + 'R', () => buildLeg(legKey, t), SK.leg),
    hook: part(k('claw'), () => buildClaw(t), [0, 0, 0]),
    drop: part('bot:spark', () => dropGrid(true), [0, 0, 0], 0),
  };
  if (hm.hat) parts.hat = part(k(`hat${hat}`), () => buildHat(hat, t).hat!, SK.hat);
  if (hm.extra) parts.hatExtra = part(k(`hatx${hat}`), () => buildHat(hat, t).extra!, hm.extraJoint);
  return {
    family: 'bot',
    sk: { ...SK, hatExtra: hm.extraJoint },
    rest: { armSplay: 0.32, armFwd: -0.18, elbow: -0.35, legSplay: 0.03, hunch: 0, headPitch: 0, jawRest: 0, holdElbow: -0.8 },
    style: { kind: 'servo', stride: 2, bounce: 0.06, legSwing: 0.6, armSwing: 0.55, roll: 0.06, sway: 0.03, lean: 0.08, stomp: 0.6, breath: 0.4 },
    hatMode: hm.mode,
    hatSpin: hm.spin,
    parts,
    palette: botPalette(c, team),
    scale: 1,
    hookDangles: false,
  };
}
