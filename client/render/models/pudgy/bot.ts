// Butcher-Bot (ref03 default look, ref10 bare base): a riveted steel barrel-belly robot on short
// piston legs with a small dome head and a glowing visor. The right arm is always a chunky crane
// arm (part of the body); the hook skin hangs from its pulley. Bare base: clean grey steel with
// yellow bands, plain dome, plain feet. Default set: grille dome, rusted hazard plates (porthole,
// red valve, pipes), crane hook, twin smokestacks puffing steam, stomper feet.
// Team colour: painted stripes on both shoulder pauldrons and a band round each thigh.
import type { PudgyPalette } from '../../contracts.ts';
import { dropGrid, part, partMirrored, resOf, ring, teamCloth, type Look, type TeamCols } from './common.ts';
import { buildRes, CH, hashVox, hv, mix, P, RGrid, shade, type ColorFn } from './grid.ts';
import type { BackMode, FamilyBuild, HatMode, PartDef, PartName, PuffEmitter, Skeleton, V3 } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Palette (ref03 / ref10)
// ---------------------------------------------------------------------------------------------

const STEEL = 0x948c83;
const STEEL_L = 0xaaa298;
const STEEL_D = 0x5e5852;
const GUN = 0x4a4744;
const RUST = [0x9a5630, 0xb86a34, 0x7e4626, 0xa85e2c] as const;
const HAZ = 0xe0a030;
const HAZ_D = 0x2a2624;
const VALVE = 0xb0402a;
const GLOW = 0xffa040;
const GLOW_HOT = 0xffd080;
const CHROME = 0xdde3ea;
const BRASS = 0xd9a441;
const COPPER = 0xc8743a;
const RUBBER = 0x24262b;
const RUBY = 0xe0203a;

const SCALE = 0.92;

const BELLY_C: V3 = [0, 19.5, 1];
const BELLY_R: V3 = [12.2, 11.5, 11.6];
const HC: V3 = [0, 32.5, 1.5];
const HR: V3 = [5.4, 4.8, 5.2];

const SK: Skeleton = {
  core: 19,
  hip: [0, 10, 0],
  leg: [6.2, 10, 0],
  body: [0, 19.5, 1],
  neck: [0, 30, 1.5],
  shoulder: [14, 27, 0],
  elbow: [14.5, 20, 0.5],
  hand: [14.8, 9.6, 1.5],
  jaw: [0, 30.5, 5],
  eyes: [0, 33, 6.4],
  hat: [0, 35, 1.5],
  hatExtra: [0, 40, 1.5],
  back: [0, 24, -10],
  backExtra: [0, 22, -13],
  drop: [6, 34, 3],
  top: 38,
};

const slug = (id: string | undefined): string => (id ? id.slice(id.indexOf('.') + 1) : '');

// ---------------------------------------------------------------------------------------------
// Paints
// ---------------------------------------------------------------------------------------------

/** Riveted steel plate: per-voxel variation, darker plate seams every few cells. */
function plate(base: number, seed: number, seams = 5): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed);
    const seam = (y + 200) % seams === 0;
    return shade(base, (seam ? 0.8 : 0.93) + h * 0.14);
  };
}

/** Rust streaks running down from rivets and seams (weathering, never blood). */
function rusty(base: ColorFn, amount: number, seed: number): ColorFn {
  return (x, y, z) => {
    const streak = hashVox(x, Math.floor((y + 200) / 4), z, seed);
    const blot = hashVox(Math.floor(x / 3), Math.floor(y / 3), Math.floor(z / 3), seed + 1);
    if (blot > 1 - amount || streak > 1 - amount * 0.35) return shade(RUST[Math.floor(hv(x, y, z, seed + 2) * 4) % 4], 0.85 + hv(x, y, z, seed + 3) * 0.25);
    return base(x, y, z);
  };
}

const gun: ColorFn = (x, y, z) => shade(GUN, 0.85 + hv(x, y, z, 5) * 0.2);
const hazard = (seed: number, along: 'xy' | 'zy' = 'xy'): ColorFn => (x, y, z) => {
  const k = along === 'xy' ? x + y : z + y;
  return Math.floor((k + 400) / 2) % 2 === 0 ? shade(HAZ, 0.88 + hv(x, y, z, seed) * 0.18) : shade(HAZ_D, 0.9 + hv(x, y, z, seed) * 0.2);
};

/** Rust is oxide, not metal: rusty iron voxels become rough and non-metallic so they read warm. */
function dullRust(g: RGrid): void {
  g.rechannel((c) => {
    if ((c & 7) !== CH.iron) return -1;
    const r = (c >> 16) & 255;
    const gg = (c >> 8) & 255;
    return r > 110 && r > gg * 1.3 ? CH.skin : -1;
  });
}

/** Rivet bumps: a ring of studs round a horizontal band. */
function rivetRing(g: RGrid, cx: number, cz: number, r: number, y: number, n: number, col: number): void {
  g.on(CH.iron, () => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      g.put(cx + Math.sin(a) * r, y, cz + Math.cos(a) * r, col);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Body (body slot): barrel belly, collar, hips
// ---------------------------------------------------------------------------------------------

function buildBody(l: Look): RGrid {
  const g = new RGrid(30, 30, 30, -15, 4, -14);
  const body = slug(l.body);
  const [bx, by, bz] = BELLY_C;
  const [rx, ry, rz] = BELLY_R;
  let skinC: ColorFn = plate(STEEL, 1);
  if (body === 'hazard_plates') skinC = rusty(plate(0x877d72, 2), 0.15, 3);
  else if (body === 'clean_chrome') skinC = (x, y, z) => shade(CHROME, 0.88 + hv(x, y, z, 4) * 0.14);
  else if (body === 'brass_boiler') skinC = (x, y, z) => shade(BRASS, 0.86 + hv(x, y, z, 5) * 0.18);
  else if (body === 'copper_coils') skinC = plate(0x6a625c, 6);
  g.on(CH.iron, () => {
    g.blob(bx, by, bz, rx, ry, rz, skinC);
    // hip block and pelvis under the barrel
    g.sblob(0, 10.5, 0, 8.5, 3.6, 6.5, 3, gun);
    // neck collar ring
    g.cyl('y', 0, 1.5, 6.4, 29, 30, gun);
  });
  // vertical plate seams (riveted straps) and horizontal bands
  const straps = body === 'brass_boiler' ? shade(BRASS, 0.7) : body === 'clean_chrome' ? 0xa8b0b8 : STEEL_D;
  g.repaint((x, y, z) => {
    const a = Math.atan2(x + 0.5, z + 0.5 - bz);
    return Math.abs(((a / (Math.PI * 2)) * 8 + 8.5) % 1 - 0.5) < 0.07 && y > 10;
  }, CH.iron, (x, y, z) => shade(straps, 0.9 + hv(x, y, z, 7) * 0.15), true);
  // yellow bands round the barrel (ref10), hazard-orange on the default plates
  const band = body === 'hazard_plates' ? rusty((x, y, z) => shade(HAZ, 0.85 + hv(x, y, z, 8) * 0.2), 0.22, 9) : (x: number, y: number, z: number) => shade(0xd9a030, 0.88 + hv(x, y, z, 10) * 0.15);
  if (body !== 'clean_chrome' && body !== 'brass_boiler') {
    g.repaint((x, y) => y === 23 || y === 24, CH.rubber, band, true);
    g.repaint((x, y) => y === 12, CH.rubber, band, true);
  }
  const at = (y: number) => rx * Math.sqrt(Math.max(0, 1 - ((y + 0.5 - by) / ry) ** 2)) + 0.05;
  rivetRing(g, bx, bz, at(25), 25, 28, shade(STEEL_D, 1.1));
  rivetRing(g, bx, bz, at(22), 22, 28, shade(STEEL_D, 1.1));
  rivetRing(g, bx, bz, at(13), 13, 26, shade(STEEL_D, 1.1));

  switch (body) {
    case 'hazard_plates': {
      // hazard stripe plates on the lower belly sides
      for (const sx of [1, -1]) g.repaint((x, y, z) => y >= 14 && y <= 19 && Math.abs(x + 0.5) > 9 && z > -3 && Math.sign(x + 0.5) === sx, CH.rubber, hazard(11, 'zy'), true);
      // porthole lamp on the upper chest
      g.on(CH.iron, () => g.cyl('z', -3, 26.5, 2.6, 11, 12, gun));
      g.on(CH.glow, () => g.cyl('z', -3, 26.5, 1.7, 12, 13, (x, y, z) => ((x + y + 100) % 3 === 0 ? shade(GLOW, 0.75) : hv(x, y, z, 12) > 0.6 ? GLOW_HOT : GLOW)));
      // red valve wheel and pipes on the left side
      g.on(CH.iron, () => {
        g.tube(11.5, 20, 5, 13, 20, 6, 0.8, gun);
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          g.blob(13.4, 20 + Math.sin(a) * 2.4, 6 + Math.cos(a) * 2.4, 0.55, 0.55, 0.55, VALVE);
        }
        g.tube(13.4, 20, 3.6, 13.4, 20, 8.4, 0.45, VALVE);
        g.tube(13.4, 17.6, 6, 13.4, 22.4, 6, 0.45, VALVE);
        // pipes bending round the belly
        g.tube(10.5, 16, 7.5, 12.4, 13, 4, 0.9, (x, y, z) => shade(0x5a524c, 0.85 + hv(x, y, z, 13) * 0.2));
        g.tube(12.4, 13, 4, 12, 12, -4, 0.9, (x, y, z) => shade(0x5a524c, 0.85 + hv(x, y, z, 13) * 0.2));
        g.tube(-11.5, 27, 3, -12, 22, 7, 0.8, (x, y, z) => shade(0x5a524c, 0.85 + hv(x, y, z, 14) * 0.2));
      });
      break;
    }
    case 'clean_chrome':
      g.repaint((x, y, z) => hv(x, y, z, 15) > 0.97 && z > 0, CH.iron, 0xffffff, true);
      break;
    case 'copper_coils': {
      // glowing copper coils wrapped round the belly
      for (let k = 0; k < 3; k++) {
        const y0 = 14 + k * 4.5;
        const dy = (y0 - by) / ry;
        const rr = Math.sqrt(Math.max(0, 1 - dy * dy));
        for (let i = 0; i < 64; i++) {
          const a = (i / 64) * Math.PI * 2;
          g.on(CH.brass, () => g.blob(Math.sin(a) * (rx * rr + 0.7), y0 + (i / 64) * 1.4, bz + Math.cos(a) * (rz * rr + 0.7), 0.8, 0.8, 0.8, (x, y, z) => shade(COPPER, 0.85 + hv(x, y, z, 16) * 0.25)));
        }
        g.repaint((x, y, z) => Math.abs(y - y0 - 0.7) < 0.6 && hv(x, y, z, 17) > 0.6, CH.pulse, 0xffb070, true);
      }
      break;
    }
    case 'brass_boiler': {
      // pressure gauges and a sight glass
      for (const [gx, gy] of [[-4, 24], [3.5, 25]] as const) {
        const gz = bz + Math.sqrt(Math.max(0, 1 - (gx / rx) ** 2 - ((gy - by) / ry) ** 2)) * rz;
        g.on(CH.brass, () => g.cyl('z', gx, gy, 2.2, Math.floor(gz), Math.floor(gz) + 1, shade(BRASS, 1.1)));
        g.on(CH.wet, () => g.cyl('z', gx, gy, 1.5, Math.floor(gz) + 1, Math.floor(gz) + 1, 0xf2eee0));
        g.on(CH.iron, () => g.tube(gx, gy, Math.floor(gz) + 2, gx + 1, gy + 1, Math.floor(gz) + 2, 0.4, 0x1a1a1a));
      }
      g.on(CH.wet, () => g.box(6, 13, 11, 7, 19, 11, (x, y) => (y < 16 ? 0x5ab0e0 : 0xc8e8f4)));
      break;
    }
    default:
      break;
  }
  dullRust(g);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Head (bare dome with visor; face slot), eyes (visor glow)
// ---------------------------------------------------------------------------------------------

function buildHead(l: Look): RGrid {
  const g = new RGrid(16, 13, 16, -8, 27, -6);
  const [cx, cy, cz] = HC;
  const [rx, ry, rz] = HR;
  const face = slug(l.face);
  g.on(CH.iron, () => {
    g.blob(cx, cy, cz, rx, ry, rz, plate(STEEL_L, 21, 3), (x, y) => y >= 29);
    g.cyl('y', cx, cz, rx, 29, 30, gun);
  });
  // visor slot across the front (the eyes part glows inside it)
  g.carve((x, y, z) => y >= 32 && y <= 33 && z > cz + 2 && Math.abs(x + 0.5) < 4);
  g.on(CH.iron, () => {
    for (let x = -4; x <= 3; x++) for (let y = 32; y <= 33; y++) g.add(x, y, Math.floor(cz + 2), 0x1a1614);
  });
  rivetRing(g, cx, cz, rx * Math.sqrt(1 - ((30.5 - cy) / ry) ** 2) + 0.2, 30, 16, STEEL_D);
  // ear bolts
  g.on(CH.iron, () => {
    for (const sx of [1, -1]) g.cyl('x', 32, cz, 1.4, sx > 0 ? 5 : -6, sx > 0 ? 5 : -6, gun);
  });
  if (face === 'monocle') {
    g.on(CH.brass, () => {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        g.blob(2.2 + Math.cos(ang) * 1.7, 32.5 + Math.sin(ang) * 1.7, cz + 5.4, 0.5, 0.5, 0.5, BRASS);
      }
      g.fineLine(3.8, 31.2, cz + 5.2, 3.6, 30.5, cz + 4.2, BRASS);
    });
    g.on(CH.wet, () => g.cyl('z', 2.2, 32.5, 1.3, Math.floor(cz + 5.3), Math.floor(cz + 5.3), 0xb8e0f0));
  } else if (face === 'screen_smile') {
    g.on(CH.iron, () => g.box(-3, 28, cz + 3, 2, 31, cz + 4, 0x202428));
    g.on(CH.glow, () => {
      g.box(-2, 29, cz + 5, 1, 29, cz + 5, 0x7af0a0);
      g.set(-3, 30, cz + 5, 0x7af0a0);
      g.set(2, 30, cz + 5, 0x7af0a0);
    });
  }
  return g;
}

function buildEyes(l: Look): RGrid {
  const g = new RGrid(10, 4, 4, -5, 31, 4);
  const face = slug(l.face);
  g.on(CH.glow, () => {
    for (let x = -4; x <= 3; x++) g.set(x, 32, Math.floor(HC[2] + 3), (x + 100) % 3 === 0 ? GLOW_HOT : GLOW);
    for (let x = -3; x <= 2; x++) g.set(x, 33, Math.floor(HC[2] + 3), shade(GLOW, 0.85));
    if (face === 'monocle') g.set(2, 32, Math.floor(HC[2] + 3), 0xfff0c0);
  });
  // showcase: scanlines across the visor
  if (buildRes() > 1) g.repaint(() => Math.floor(P.y * 2 + 100) % 2 === 0, CH.glow, shade(GLOW, 0.7), true);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Head slot
// ---------------------------------------------------------------------------------------------

interface HatMeta {
  hat: boolean;
  extra: boolean;
  mode: HatMode;
  spin: number;
  extraJoint: V3;
  top: number;
}

function hatMeta(id: string): HatMeta {
  const cz = HC[2];
  switch (id) {
    case 'grille_dome':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra, top: 39 };
    case 'radar_dish':
      return { hat: true, extra: true, mode: 'spin', spin: 2.2, extraJoint: [0, 41, cz], top: 46 };
    case 'lamp_head':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra, top: 41 };
    case 'kettle_lid':
      return { hat: true, extra: true, mode: 'bob', spin: 0, extraJoint: [0, 38, cz], top: 41 };
    case 'diving_helm':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra, top: 40 };
    case 'chrome_crown':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra, top: 42 };
    default:
      return { hat: false, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra, top: 37.5 };
  }
}

function buildHat(id: string): RGrid {
  const [cx, cy, cz] = HC;
  const g = new RGrid(22, 18, 22, -11, 28, cz - 11);
  switch (id) {
    case 'grille_dome': {
      // riveted dome cap with hazard paint and a furnace grille cage over the visor
      g.on(CH.iron, () => {
        g.blob(cx, cy + 0.6, cz, 5.9, 4.8, 5.7, rusty(plate(0x6e655c, 31, 2), 0.25, 32), (x, y) => y >= 34.5);
        g.cyl('y', cx, cz, 6, 34, 34, gun);
        g.put(0, 38, cz, gun);
      });
      g.repaint((x, y, z) => y >= 36 && (x + z + 100) % 4 < 2 && z < cz + 3, CH.rubber, (x, y, z) => shade(HAZ, 0.85 + hv(x, y, z, 33) * 0.2), true);
      rivetRing(g, cx, cz, 6.1, 35, 18, shade(STEEL_D, 1.15));
      // grille: vertical bars in front of the visor with a frame
      g.on(CH.iron, () => {
        for (let x = -5; x <= 4; x++) {
          if ((x + 100) % 2 === 0) g.box(x, 30, Math.floor(cz + 5.4), x, 34, Math.floor(cz + 5.4), shade(GUN, 1.1));
        }
        g.box(-5, 30, Math.floor(cz + 5.4), 4, 30, Math.floor(cz + 5.4), GUN);
        g.box(-5, 34, Math.floor(cz + 5.4), 4, 34, Math.floor(cz + 5.4), GUN);
        for (const sx of [1, -1]) g.cyl('x', 32, cz + 3, 1.8, sx > 0 ? 5 : -6, sx > 0 ? 6 : -7, gun);
      });
      g.on(CH.glow, () => {
        for (let x = -5; x <= 4; x++) if ((x + 100) % 2 !== 0) g.box(x, 31, Math.floor(cz + 4.4), x, 33, Math.floor(cz + 4.4), x % 3 === 0 ? GLOW_HOT : GLOW);
      });
      dullRust(g);
      return g;
    }
    case 'radar_dish': {
      g.on(CH.iron, () => {
        g.cyl('y', 0, cz, 0.9, 36, 40, gun);
        g.cyl('y', 0, cz, 2, 36, 36, gun);
      });
      return g;
    }
    case 'lamp_head': {
      // a bright searchlight dome on a ring
      g.on(CH.iron, () => {
        g.cyl('y', 0, cz, 4.6, 36, 37, gun);
        g.cyl('z', 0, 38.5, 3, Math.floor(cz - 2), Math.floor(cz + 3), plate(STEEL_L, 34, 2));
      });
      g.on(CH.glow, () => g.cyl('z', 0, 38.5, 2.3, Math.floor(cz + 3), Math.floor(cz + 4), (x, y, z) => (hv(x, y, z, 35) > 0.5 ? 0xfffbe0 : 0xfff0b0)));
      g.on(CH.brass, () => ring(g, 0, cz, 4.4, 5.2, 35, 35, BRASS));
      return g;
    }
    case 'kettle_lid': {
      // an enamelled kettle lid with a little spout that whistles steam
      g.on(CH.rubber, () => g.blob(0, 35, cz, 5.6, 2.6, 5.6, (x, y, z) => shade(0x3a7a8a, 0.86 + hv(x, y, z, 36) * 0.18), (x, y) => y >= 35));
      g.on(CH.iron, () => {
        g.tube(4, 35.5, cz + 2, 7.5, 37.5, cz + 4, 0.8, gun);
        ring(g, 0, cz, 5, 6, 35, 35, gun);
      });
      return g;
    }
    case 'diving_helm': {
      // brass diving helmet with three portholes enclosing the dome
      g.on(CH.brass, () => {
        g.blob(cx, cy + 0.5, cz, 6.6, 6, 6.6, (x, y, z) => shade(BRASS, 0.86 + hv(x, y, z, 37) * 0.2), (x, y) => y >= 29);
        g.cyl('y', cx, cz, 7, 28, 29, (x, y, z) => shade(COPPER, 0.85 + hv(x, y, z, 38) * 0.2));
      });
      g.carveP((px, py, pz) => (Math.hypot(px, py - 33) < 2.6 && pz > cz + 3) || (Math.hypot(py - 33, pz - cz) < 2 && Math.abs(px) > 4));
      g.on(CH.wet, () => {
        g.cyl('z', 0, 33, 2.6, Math.floor(cz + 4.5), Math.floor(cz + 4.5), (x, y, z) => shade(0x9fd0d8, 0.9 + hv(x, y, z, 39) * 0.1));
        for (const sx of [1, -1]) g.cyl('x', 33, cz, 2, sx > 0 ? 5 : -6, sx > 0 ? 5 : -6, 0x9fd0d8);
      });
      g.on(CH.brass, () => {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          g.blob(Math.cos(ang) * 2.9, 33 + Math.sin(ang) * 2.9, cz + 6.1, 0.55, 0.55, 0.55, shade(BRASS, 1.12));
        }
      });
      return g;
    }
    case 'chrome_crown': {
      // Limited: a mirror-chrome crown with ruby lamps
      g.premium(() => {
        g.on(CH.iron, () => {
          ring(g, 0, cz, 4.8, 6.2, 35, 36, (x, y, z) => shade(CHROME, 0.92 + hv(x, y, z, 40) * 0.1));
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            g.tube(Math.sin(a) * 5.6, 36, cz + Math.cos(a) * 5.6, Math.sin(a) * 5.8, 40, cz + Math.cos(a) * 5.8, 0.7, CHROME, 0.4);
          }
        });
        g.on(CH.glow, () => {
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
            g.blob(Math.sin(a) * 6.3, 35.6, cz + Math.cos(a) * 6.3, 0.75, 0.75, 0.75, RUBY);
          }
          g.blob(0, 40.6, cz + 5.6, 0.7, 0.7, 0.7, RUBY);
        });
      });
      return g;
    }
    default:
      return g;
  }
}

function buildHatExtra(id: string): RGrid {
  const cz = HC[2];
  const g = new RGrid(16, 8, 16, -8, 38, cz - 8);
  if (id === 'radar_dish') {
    // the dish spins on its mast
    g.on(CH.iron, () => {
      for (let x = -6; x <= 5; x++)
        for (let y = 39; y <= 45; y++) {
          const dx = x + 0.5;
          const dy = y + 0.5 - 42;
          if (dx * dx + dy * dy <= 36) g.put(x, y, cz + 1 + (dx * dx + dy * dy) * 0.06, (xx, yy, zz) => shade(STEEL_L, 0.88 + hv(xx, yy, zz, 41) * 0.14));
        }
      g.tube(0, 42, cz + 1, 0, 42, cz + 4.5, 0.5, gun);
    });
    g.on(CH.glow, () => g.put(0, 42, cz + 5, 0xff5040));
    return g;
  }
  // kettle lid knob, rattling
  g.on(CH.rubber, () => g.blob(0, 38.6, cz, 1.3, 1, 1.3, 0x2a2a2a));
  return g;
}

// ---------------------------------------------------------------------------------------------
// Arms: left = riveted arm and fist; right = crane arm (always). Team stripes on the pauldrons.
// ---------------------------------------------------------------------------------------------

function pauldron(g: RGrid, t: TeamCols): void {
  const [sx, sy, sz] = SK.shoulder;
  g.on(CH.rubber, () => {
    g.blob(sx + 0.4, sy + 0.8, sz, 5, 3.8, 5, (x, y, z) => shade(STEEL, 0.86 + hv(x, y, z, 51) * 0.18), (x, y) => y >= sy - 1);
  });
  // team stripes: two broad diagonal bands across the top
  g.repaint((x, y, z) => y >= sy && Math.floor((z - x + 100) / 2.5) % 2 === 0, CH.rubber, teamCloth(t, 52), true);
  g.repaint((x, y) => y < sy && y >= sy - 1, CH.iron, gun, true);
  rivetRing(g, sx + 0.4, sz, 4.7, sy - 1, 12, STEEL_D);
}

function buildUpperArm(l: Look, crane: boolean): RGrid {
  const g = new RGrid(14, 14, 14, 7, 18, -7);
  const [sx, sy, sz] = SK.shoulder;
  g.on(CH.iron, () => {
    g.blob(sx, sy - 0.5, sz, 3.4, 3.4, 3.4, gun);
    g.cyl('y', sx + 0.3, sz, crane ? 3.4 : 2.9, 20, 25, plate(STEEL, 53, 3));
    // elbow joint barrel
    g.cyl('z', sx + 0.4, 20.5, 2.6, Math.floor(sz - 3), Math.floor(sz + 3), gun);
    if (crane) {
      // crane housing over the shoulder (behind the pauldron) and a hydraulic piston on the outside
      g.box(sx - 2.5, 20, sz - 3.5, sx + 3, 24, sz + 3.5, plate(0x877d72, 54, 2));
      g.tube(sx + 3.4, 25, sz + 1.5, sx + 3.2, 20, sz + 1.8, 0.75, 0x9aa0a6);
      g.tube(sx + 3.4, 25, sz + 1.5, sx + 3.3, 22, sz + 1.6, 1, 0x4a4846);
    }
  });
  pauldron(g, l.t);
  return g;
}

function buildLowerArm(l: Look): RGrid {
  // the left arm: a riveted forearm with a hazard plate and a big three-finger fist
  const g = new RGrid(13, 14, 14, 8, 5, -7);
  const [ex, , ez] = SK.elbow;
  const [hx, hy, hz] = SK.hand;
  const body = slug(l.body);
  g.on(CH.iron, () => {
    g.sblob(ex + 0.3, 16, ez + 0.6, 3.7, 4.4, 3.7, 3, plate(STEEL, 61, 3));
    g.cyl('y', hx, hz, 2.3, 11, 12, gun);
    g.sblob(hx, hy + 0.6, hz + 0.6, 3.5, 2.6, 3.6, 3, plate(STEEL_L, 62, 2));
    for (let i = 0; i < 3; i++) g.sblob(hx + 2 - i * 2, hy - 2, hz + 2.6, 0.9, 1.6, 1, 2.5, gun);
    g.sblob(hx - 3.2, hy + 0.2, hz + 2.2, 0.9, 1.6, 0.9, 2.5, gun);
  });
  g.repaint((x, y, z) => x > ex + 2.6 && y >= 14 && y <= 18, CH.rubber, body === 'hazard_plates' ? rusty(hazard(63, 'zy'), 0.15, 64) : hazard(63, 'zy'), true);
  return g;
}

function buildCraneArm(): RGrid {
  // the right arm (built on the left, mirrored): a boxy boom with hazard panels and a pulley block
  const g = new RGrid(14, 18, 14, 8, 2, -7);
  const [ex, , ez] = SK.elbow;
  const [hx, hy, hz] = SK.hand;
  g.on(CH.iron, () => {
    g.box(ex - 3.5, 11, ez - 3.5, ex + 3.5, 19, ez + 3.5, plate(0x877d72, 71, 3));
    g.box(ex - 2.5, 10, ez - 2.5, ex + 2.5, 10, ez + 2.5, gun);
    // a gear box on the outer face
    g.cyl('x', 16, ez, 2.2, Math.floor(ex + 3.5), Math.floor(ex + 4.5), gun);
    // pulley block with a sheave the cable runs over
    g.box(hx - 2.5, hy + 0.5, hz - 2, hx + 2, hy + 2.5, hz + 1.5, gun);
    g.cyl('x', hy + 1.5, hz, 1.6, Math.floor(hx - 1), Math.floor(hx + 1), (x, y, z) => shade(0x8a8f96, 0.9 + hv(x, y, z, 72) * 0.15));
    // cable and the chains down the side
    for (let y = 12; y <= 18; y++) g.put(ex - 3.5, y, ez + ((y % 2) ? 1 : 0), (y % 2) ? 0x5a5a5a : 0x3a3a3a);
  });
  g.repaint((x, y, z) => (x >= ex + 2.5 || z >= ez + 2.5) && y >= 12 && y <= 17, CH.rubber, rusty(hazard(73), 0.12, 74), true);
  g.repaint((x, y, z) => y === 18 || y === 11, CH.rubber, (x, y, z) => shade(HAZ, 0.85 + hv(x, y, z, 75) * 0.2), true);
  rivetRing(g, ex, ez, 3.6, 18, 12, STEEL_D);
  dullRust(g);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Legs (feet slot); team band on the thigh
// ---------------------------------------------------------------------------------------------

function buildLeg(l: Look): RGrid {
  const g = new RGrid(14, 14, 18, -1, 0, -8);
  const [lx, , lz] = SK.leg;
  const feet = slug(l.feet);
  g.on(CH.iron, () => {
    // thigh piston and a knee gear
    g.cyl('y', lx, lz, 2.9, 7, 11, plate(STEEL, 81, 3));
    g.cyl('x', 6, lz + 0.5, 2.6, Math.floor(lx - 3), Math.floor(lx + 2), gun);
    g.cyl('y', lx, lz + 0.4, 2.4, 3, 6, (x, y, z) => shade(0x9aa0a6, 0.88 + hv(x, y, z, 82) * 0.14));
  });
  // team band round the thigh
  g.on(CH.rubber, () => g.cyl('y', lx, lz, 3.2, 9, 10, teamCloth(l.t, 83)));
  if (feet === 'stomper_feet') {
    // heavy piston feet with hazard trim
    g.on(CH.iron, () => {
      g.sblob(lx, 2, lz + 1.5, 4.8, 2.2, 6.2, 3, rusty(plate(0x6e655c, 84, 2), 0.25, 85));
      g.box(lx - 4, 0, lz - 4, lx + 3, 0, lz + 7, gun);
      for (const dx of [-3, 2]) g.tube(lx + dx, 4, lz - 1, lx + dx * 0.6, 7, lz, 0.6, 0x9aa0a6);
    });
    g.repaint((x, y, z) => z >= lz + 6 && y >= 1 && y <= 3, CH.rubber, hazard(86), true);
    // toe claws
    g.on(CH.iron, () => {
      for (const dx of [-3, 0, 3]) g.sblob(lx + dx - 0.5, 1.2, lz + 7.6, 1.1, 1.2, 1, 2.5, gun);
    });
    dullRust(g);
  } else if (feet === 'treads') {
    // tank tread units instead of feet
    g.on(CH.rubber, () => {
      g.sblob(lx, 2.6, lz + 1, 3.4, 2.6, 6.8, 4, (x, y, z) => ((z + 100) % 2 === 0 ? RUBBER : shade(RUBBER, 1.6)));
    });
    g.on(CH.iron, () => {
      for (const zz of [-3.5, 1, 5.5]) g.cyl('x', 2.6, lz + zz, 1.5, Math.floor(lx - 4), Math.floor(lx + 3), (x, y, z) => shade(0x8a8f96, 0.85 + hv(x, y, z, 87) * 0.2));
    });
  } else {
    // plain flat feet
    g.on(CH.iron, () => {
      g.sblob(lx, 1.6, lz + 1, 3.8, 1.8, 5, 3, plate(STEEL, 88, 2));
      g.box(lx - 3, 0, lz - 3, lx + 2, 0, lz + 5, gun);
    });
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Held hooks (fallback), hanging from the crane pulley. Grip at the origin, +Z = down the cable.
// ---------------------------------------------------------------------------------------------

function buildHook(id: string): RGrid {
  const g = new RGrid(16, 18, 26, -8, -8, -3);
  g.on(CH.iron, () => {
    // cable from the pulley
    for (let z = 0; z <= 3; z++) g.put(0, 0, z, z % 2 ? 0x4a4a4a : 0x333333);
  });
  switch (id) {
    case 'magnet_hook': {
      // a big red horseshoe magnet with steel tips
      g.on(CH.rubber, () => {
        for (let a = 0; a <= 18; a++) {
          const ang = (a / 18) * Math.PI;
          g.blob(Math.cos(ang) * 4.2, 0, 8 + Math.sin(ang) * 3.4, 1.3, 1.3, 1.3, (x, y, z) => shade(0xc8302a, 0.86 + hv(x, y, z, 91) * 0.18));
        }
        g.tube(4.2, 0, 8, 4.2, 0, 13, 1.3, (x, y, z) => shade(0xc8302a, 0.86 + hv(x, y, z, 92) * 0.18));
        g.tube(-4.2, 0, 8, -4.2, 0, 13, 1.3, (x, y, z) => shade(0xc8302a, 0.86 + hv(x, y, z, 92) * 0.18));
      });
      g.on(CH.iron, () => {
        g.tube(4.2, 0, 13.5, 4.2, 0, 15, 1.3, CHROME);
        g.tube(-4.2, 0, 13.5, -4.2, 0, 15, 1.3, CHROME);
        g.tube(0, 0, 3, 0, 0, 5, 0.9, gun);
      });
      return g;
    }
    case 'claw_grabber': {
      // a three-fingered arcade claw
      g.on(CH.iron, () => {
        g.cyl('z', 0, 0, 2.6, 3, 6, (x, y, z) => shade(CHROME, 0.85 + hv(x, y, z, 93) * 0.15));
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          const ox = Math.cos(a);
          const oy = Math.sin(a);
          g.tube(ox * 1.8, oy * 1.8, 6, ox * 4.2, oy * 4.2, 10, 0.75, CHROME);
          g.tube(ox * 4.2, oy * 4.2, 10, ox * 2.4, oy * 2.4, 13.5, 0.7, CHROME);
        }
      });
      g.on(CH.glow, () => g.cyl('z', 0, 0, 1.2, 6, 6, 0xff70d0));
      return g;
    }
    default: {
      // crane_hook: a pulley block and a fat red and grey crane hook
      g.on(CH.iron, () => {
        g.box(-2, -2, 3, 1, 1, 6, gun);
        g.cyl('x', 0, 4.5, 1.4, -3, 2, (x, y, z) => shade(0x8a8f96, 0.88 + hv(x, y, z, 94) * 0.15));
      });
      const hookC = (seed: number): ColorFn => (x, y, z) => {
        const outer = P.y < -0.5;
        return rusty(outer ? (xx, yy, zz) => shade(0xb03a28, 0.85 + hv(xx, yy, zz, seed) * 0.2) : (xx, yy, zz) => shade(0x9a9690, 0.85 + hv(xx, yy, zz, seed) * 0.2), 0.12, seed + 1)(x, y, z);
      };
      g.on(CH.rubber, () => {
        g.tube(0, 0, 6, 0, 0, 9, 1.6, hookC(95));
        // the C: down, round toward -y (outer, red) and back up with a blunt tip
        for (let a = 0; a <= 22; a++) {
          const ang = (a / 22) * Math.PI * 1.25;
          const r = 1.9 - (a / 22) * 0.5;
          g.blob(0, -4 + Math.cos(ang) * 4.2 + 0.2, 9 + Math.sin(ang) * 4.2, r, r, r, hookC(96));
        }
      });
      return g;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Back slot
// ---------------------------------------------------------------------------------------------

function buildBack(id: string): RGrid {
  const g = new RGrid(28, 26, 16, -14, 14, -20);
  if (id === 'twin_stacks') {
    // two smokestacks standing up behind the shoulders, banded and riveted
    for (const sx of [1, -1]) {
      const x = sx * 6.5;
      g.on(CH.iron, () => {
        g.cyl('y', x, -9.5, 2.2, 22, 37, rusty(plate(0x5a524c, 101, 4), 0.25, 102));
        g.cyl('y', x, -9.5, 2.7, 37, 38, gun);
        g.cyl('y', x, -9.5, 2.6, 26, 26, gun);
        g.box(x - 1, 20, -9, x, 23, -6, gun);
      });
      g.carveP((px, py, pz) => py > 37.5 && Math.hypot(px - x, pz + 9.5) < 1.5);
      g.on(CH.pulse, () => g.cyl('y', x, -9.5, 1.4, 37, 37, 0xff8030));
    }
    dullRust(g);
    return g;
  }
  if (id === 'propeller') {
    // the hub housing; the blades spin (backExtra)
    g.on(CH.iron, () => {
      g.box(-3, 20, -12, 2, 26, -9, plate(STEEL, 103, 2));
      g.cyl('z', 0, 23, 1.6, -15, -12, gun);
    });
    return g;
  }
  // gear_wheel: the axle mount; the cog turns (backExtra)
  g.on(CH.iron, () => {
    g.box(-2, 20, -12, 1, 25, -9, gun);
    g.cyl('z', 0, 22, 1.4, -14, -12, gun);
  });
  return g;
}

function buildBackExtra(id: string): RGrid {
  const [bx, by, bz] = SK.backExtra;
  const g = new RGrid(28, 28, 6, -14, by - 14, bz - 3);
  if (id === 'propeller') {
    g.on(CH.rubber, () => {
      for (const s of [1, -1]) {
        g.sblob(bx + s * 5, by, bz, 4.6, 1.3, 0.6, 2.5, (x, y, z) => shade(0xb8302a, 0.85 + hv(x, y, z, 104) * 0.2));
        g.put(bx + s * 9, by, bz, 0xf2f2f2);
      }
      g.cyl('z', bx, by, 1.2, Math.floor(bz - 1), Math.floor(bz + 1), gun);
    });
    return g;
  }
  // gear wheel: a big turning cog with spokes
  g.on(CH.iron, () => {
    const c = (x: number, y: number, z: number) => shade(0x8a7a5a, 0.85 + hv(x, y, z, 105) * 0.2);
    for (let i = 0; i < 360; i += 3) {
      const a = (i / 180) * Math.PI;
      const tooth = Math.floor(i / 15) % 2 === 0;
      const r = tooth ? 9.5 : 8.4;
      for (let rr = 7; rr <= r; rr += 0.7) g.put(bx + Math.cos(a) * rr, by + Math.sin(a) * rr, bz, c);
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI;
      g.tube(bx - Math.cos(a) * 7, by - Math.sin(a) * 7, bz, bx + Math.cos(a) * 7, by + Math.sin(a) * 7, bz, 0.7, c);
    }
    g.cyl('z', bx, by, 1.8, Math.floor(bz - 1), Math.floor(bz + 1), gun);
  });
  return g;
}

// ---------------------------------------------------------------------------------------------

export function botPalette(l: Look): PudgyPalette {
  const body = slug(l.body);
  const shell = body === 'hazard_plates' ? 0x6e655c : body === 'clean_chrome' ? CHROME : body === 'brass_boiler' ? BRASS : body === 'copper_coils' ? COPPER : STEEL;
  return { skin: shell, skinDark: STEEL_D, cloth: l.t.main, accent: HAZ, metal: slug(l.head) === 'chrome_crown' ? CHROME : GUN, extra: [RUST[0], GLOW, VALVE, l.t.dark, STEEL_L] };
}

export function buildBot(l: Look): FamilyBuild {
  const res = resOf(l.fine);
  const team = l.team;
  const body = slug(l.body);
  const face = slug(l.face);
  const head = slug(l.head);
  const feet = slug(l.feet);
  const back = slug(l.back);
  const hands = slug(l.hands) || 'crane_hook';
  const hm = hatMeta(head);
  const sk: Skeleton = { ...SK, hatExtra: hm.extraJoint, top: hm.top };
  const parts: Partial<Record<PartName, PartDef>> = {
    body: part(`bot:body:${body}`, () => buildBody(l), SK.body, res),
    head: part(`bot:head:${face}`, () => buildHead(l), SK.neck, res),
    eyes: part(`bot:eyes:${face === 'monocle' ? 1 : 0}`, () => buildEyes(l), SK.eyes, res),
    upperL: part(`bot:uarm:${team}`, () => buildUpperArm(l, false), SK.shoulder, res),
    upperR: partMirrored(`bot:uarmC:${team}`, () => buildUpperArm(l, true), SK.shoulder, res),
    lowerL: part(`bot:larm:${body === 'hazard_plates' ? 'h' : ''}`, () => buildLowerArm(l), SK.elbow, res),
    lowerR: partMirrored('bot:crane', () => buildCraneArm(), SK.elbow, res),
    legL: part(`bot:leg:${feet}:${team}`, () => buildLeg(l), SK.leg, res),
    legR: partMirrored(`bot:leg:${feet}:${team}`, () => buildLeg(l), SK.leg, res),
    hook: part(`bot:hook:${hands}`, () => buildHook(hands), [0, 0, 0], res),
    drop: part('bot:drop', () => dropGrid(true), [0, 0, 0], 1),
  };
  if (hm.hat) parts.hat = part(`bot:hat:${head}`, () => buildHat(head), SK.hat, res);
  if (hm.extra) parts.hatExtra = part(`bot:hatx:${head}`, () => buildHatExtra(head), hm.extraJoint, res);
  let backMode: BackMode = 'none';
  let backSpin = 0;
  if (back === 'twin_stacks' || back === 'propeller' || back === 'gear_wheel') parts.back = part(`bot:back:${back}`, () => buildBack(back), SK.back, res);
  if (back === 'propeller' || back === 'gear_wheel') {
    parts.backExtra = part(`bot:backx:${back}`, () => buildBackExtra(back), SK.backExtra, res);
    backMode = back === 'propeller' ? 'spin' : 'turn';
    backSpin = back === 'propeller' ? 9 : 0.8;
  }
  const puffs: PuffEmitter[] = [];
  if (back === 'twin_stacks')
    for (const sx of [1, -1]) puffs.push({ node: 'back', at: [sx * 6.5, 38.5, -9.5], kind: 'steam', rate: 1.6, burst: 5, size: 0.11 });
  if (head === 'kettle_lid') puffs.push({ node: 'hat', at: [7.8, 38, HC[2] + 4.2], kind: 'steam', rate: 0.3, burst: 6, size: 0.08 });
  return {
    family: 'bot',
    sk,
    rest: { armSplay: 0.22, armFwd: -0.12, elbow: -0.3, legSplay: 0.03, hunch: 0, headPitch: 0, jawRest: 0, holdElbow: -0.65 },
    style: { kind: 'servo', stride: 2, bounce: 0.06, legSwing: 0.55, armSwing: 0.5, roll: 0.06, sway: 0.03, lean: 0.08, stomp: 0.6, breath: 0.4 },
    hatMode: hm.mode,
    hatSpin: hm.spin,
    backMode,
    backSpin,
    parts,
    palette: botPalette(l),
    scale: SCALE,
    // the hook hangs on its cable from the crane pulley and swings
    hookDangles: true,
    hookMount: { pos: [0, -0.02, 0], rot: [Math.PI / 2, 0, 0] },
    hangMount: { pos: [0, -0.02, 0], rot: [Math.PI / 2, 0, 0] },
    gripMount: { pos: [0, -0.05, 0.02], rot: [Math.PI / 2, 0, 0] },
    puffs,
    corpseLift: 0.62,
    premium: head === 'chrome_crown',
  };
}

