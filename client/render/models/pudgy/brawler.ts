// Harbour Brawler: a big-bellied fishmonger in a team-coloured rubber apron, rolled sleeves,
// wellies, a sea-dog face and a barbed iron fishing hook with a little fish lure.
import { COSMETIC_NAMES, TEAM_COLORS, type PudgyPalette } from '../../contracts.ts';
import type { Cosmetics, Team } from '../../../../shared/types.ts';
import { beadEyes, dropGrid, hairPaint, part, partMirrored, teamPaint, wrap, type TeamCols } from './common.ts';
import { CH, hashVox, jitter, mix, ramp, RGrid, shade, type ColorFn } from './grid.ts';
import type { FamilyBuild, HatMode, PartDef, PartName, Skeleton, V3 } from './types.ts';

const SKIN = 0xeba57f;
const SKIN_SHADE = 0xd38a68;
const CHEEK = 0xe77b6c;
const SHIRT = 0xd9ceb2;
const NAVY = 0x27324f;
const TROUSER = 0x3c4258;
const BOOT = 0x2e3a33;
const SOLE = 0x1d211f;
const LEATHER = 0x5d3c24;
const BRASS = 0xe0b04a;
const ROPE = 0xc8a46a;
const OILSKIN = 0xf0c13c;

/** hair colour per face option */
const HAIR = [0xb9592a, 0x6b4426, 0xd6ae5e, 0x2d2522, 0xd2cdc4, 0x4a3122];

const SK: Skeleton = {
  core: 13,
  hip: [0, 6, 0],
  leg: [3.5, 6, 0],
  body: [0, 12, 1],
  neck: [0, 20.5, 1.5],
  shoulder: [9.5, 18, -0.5],
  elbow: [9.5, 13, -0.5],
  hand: [9.5, 7.5, 0],
  jaw: [0, 23, 2],
  eyes: [0, 25.5, 9],
  hat: [0, 29, 2.5],
  hatExtra: [0, 32, 2.5],
  drop: [5.5, 28, 4],
};

const HEAD_C: V3 = [0, 25.4, 2.5];
const HEAD_R: V3 = [6.4, 5.6, 6.1];

function skin(seed: number): ColorFn {
  return (x, y, z) => {
    const h = hashVox(x, y, z, seed);
    const c = h > 0.86 ? shade(SKIN, 1.06) : h < 0.12 ? SKIN_SHADE : SKIN;
    return shade(c, 0.96 + (h - 0.5) * 0.06);
  };
}

function shirtPaint(striped: boolean, seed: number): ColorFn {
  return (x, y, z) => {
    const h = hashVox(x, y, z, seed);
    if (striped && Math.floor(y) % 3 === 0) return shade(NAVY, 0.94 + h * 0.1);
    return shade(SHIRT, 0.93 + h * 0.09);
  };
}

// ---------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------

function buildBody(accent: number, t: TeamCols): RGrid {
  const g = new RGrid(28, 24, 26, -14, 3, -12);
  const striped = accent === 1;
  const coat = accent === 5;
  const shirt = shirtPaint(striped, 3);
  // belly, chest and shoulders
  g.blob(0, 12, 1, 10.5, 7.5, 9.5, shirt);
  g.blob(0, 16.5, -0.5, 8.6, 5.6, 7.6, shirt);
  g.blob(0, 19, -1.5, 7, 3.4, 5.5, shirt);
  // open collar: skin V with chest hair
  g.repaint((x, y, z) => y >= 18 && z > 2 && Math.abs(x) < 1.5 + (y - 18) * 0.9, CH.skin, (x, y, z) => (hashVox(x, y, z, 9) > 0.7 ? HAIR[0] : SKIN), true);

  if (coat) {
    // oilskin coat over everything but the front opening; tails flare at the bottom
    const coatC = ramp(OILSKIN, 21, 0.07, 0.08, 4, 22);
    g.on(CH.rubber, () => {
      g.shell(0, 12, 1, 10.5, 7.5, 9.5, 0.9, 0.6, (x, y, z) => !(z > 3 && Math.abs(x) < 6.5) && y > 3, coatC);
      g.shell(0, 16.5, -0.5, 8.6, 5.6, 7.6, 0.9, 0.6, (x, y, z) => !(z > 2 && Math.abs(x) < 4.5), coatC);
      // collar standing up behind the head
      for (let x = -6; x <= 5; x++) for (let y = 20; y <= 23; y++) g.set(x, y, -4 - (y - 20) * 0.3, shade(OILSKIN, 0.92));
      // coat tails
      for (let x = -9; x <= 8; x++) for (let y = 3; y <= 5; y++) if (Math.abs(x) > 3 || y > 4) g.add(x, y, -7 + Math.abs(x) * 0.35, shade(OILSKIN, 0.85));
      // toggles
      for (const y of [9, 12, 15]) {
        g.set(6, y, 8, 0x6b4a2a);
        g.set(-7, y, 8, 0x6b4a2a);
      }
    });
  }

  // apron: glossy team rubber, bib on the chest, skirt over the belly
  const apron = teamPaint(t, 5, 4, 20);
  const apronW = (y: number) => (y > 15.5 ? 5.2 : y > 13.5 ? 7.2 : 9.6);
  g.on(CH.rubber, () => {
    g.shell(0, 12, 1, 10.5, 7.5, 9.5, 0.95, 0.4, (x, y, z) => z > 1 && y >= 4 && y <= 16 && Math.abs(x + 0.5) < apronW(y), apron);
    g.shell(0, 16.5, -0.5, 8.6, 5.6, 7.6, 0.95, 0.4, (x, y, z) => z > 2 && y >= 15 && y <= 20.5 && Math.abs(x + 0.5) < 5.2, apron);
    // hem and piping
    g.repaint((x, y, z) => y <= 4.5 && z > 1, CH.rubber, shade(t.dark, 0.9), true);
    g.repaint((x, y, z) => y >= 20 && y <= 21 && z > 2 && Math.abs(x + 0.5) < 5.2, CH.rubber, t.dark, true);
    // pocket with a stitched top
    g.repaint((x, y, z) => z > 7 && x >= -3 && x <= 2 && y >= 8 && y <= 10, CH.rubber, shade(t.main, 0.82), true);
    g.repaint((x, y, z) => z > 7 && x >= -3 && x <= 2 && y === 11, CH.rubber, t.light, true);
    // straps: over the shoulders, crossing on the back
    const strapCol = shade(t.dark, 1.05);
    g.repaint((x, y, z) => y >= 19 && z > -3 && Math.abs(Math.abs(x + 0.5) - 4.5) < 1.1, CH.rubber, strapCol, true);
    g.repaint((x, y, z) => z < -2 && y >= 10 && y <= 21 && Math.abs(Math.abs(x + 0.5) - 4.5 * ((y - 10) / 9)) < 1.1, CH.rubber, strapCol, true);
    // waist ties and bow on the back
    g.repaint((x, y, z) => y === 10 && z < 2, CH.rubber, strapCol, true);
    g.blob(0, 10.5, -10, 1.6, 1.2, 1, strapCol);
    g.set(-2, 9, -10, strapCol);
    g.set(1, 9, -10, strapCol);
    g.set(-2, 8, -10, strapCol);
    g.set(1, 8, -10, strapCol);
  });
  // a little fish-scale shine on the apron
  g.repaint((x, y, z) => z > 6 && hashVox(x, y, z, 77) > 0.965 && y > 5 && y < 15, CH.wet, 0xdfe9f2, true);

  // belt peeking out at the sides
  g.on(CH.skin, () => {
    g.repaint((x, y, z) => y >= 7 && y <= 8 && z <= 1, CH.skin, (x, y, z) => shade(LEATHER, 0.92 + hashVox(x, y, z, 4) * 0.12), true);
  });

  switch (accent) {
    case 3: {
      // fish belt: three fish dangling from the belt
      const fish = (fx: number, fz: number, col: number) => {
        g.on(CH.wet, () => {
          g.blob(fx, 4.2, fz, 1.2, 2.6, 1.3, (x, y, z) => (y < 3.5 ? shade(col, 1.18) : shade(col, 0.95 + hashVox(x, y, z, 2) * 0.1)));
          g.set(fx, 1, fz, shade(col, 0.8));
          g.set(fx - 1, 1, fz, shade(col, 0.8));
          g.set(fx + 1, 1, fz, shade(col, 0.8));
          g.set(fx - 1, 0, fz, shade(col, 0.7));
          g.set(fx + 1, 0, fz, shade(col, 0.7));
          g.set(fx, 5, fz + 1, 0x111111);
          g.set(fx, 6, fz + 1, 0xd8dee6);
        });
        g.on(CH.cloth, () => g.box(fx, 7, fz, fx, 8, fz, ROPE));
      };
      fish(9, 5, 0x8fa6b8);
      fish(-10, 4, 0x9fb0a0);
      fish(6, 8, 0xc9a070);
      fish(-7, 8, 0x8fb0c8);
      g.on(CH.brass, () => g.box(-1, 7, 9, 0, 8, 9, BRASS));
      break;
    }
    case 4: {
      // rope braces + a coil of rope slung over the shoulder
      const rope: ColorFn = (x, y, z) => ((x + y + z) % 2 === 0 ? ROPE : shade(ROPE, 0.78));
      g.repaint((x, y, z) => y >= 13 && Math.abs(Math.abs(x + 0.5) - 6.2) < 0.9 && (z > 4 || z < -3), CH.cloth, rope, true);
      g.on(CH.cloth, () => {
        for (let i = 0; i <= 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          const x = 2 + Math.cos(a) * 8.5;
          const y = 15 + Math.sin(a) * 6.5;
          g.blob(x, y, -8.4 + Math.cos(a) * 1.5, 0.9, 0.9, 0.9, rope);
        }
      });
      break;
    }
    case 6: {
      // gold chain necklace
      g.on(CH.brass, () => {
        for (let i = -5; i <= 5; i++) g.set(i, 20 - Math.abs(i) * 0.25 - (Math.abs(i) < 2 ? 0.6 : 0), 6.5 + (5 - Math.abs(i)) * 0.35, i % 2 ? BRASS : shade(BRASS, 1.15));
        g.blob(-0.5, 17.6, 8.8, 1.8, 1.8, 0.8, 0xf6cf5a);
        g.set(-1, 18, 10, 0xb8862a);
        g.set(0, 17, 10, 0xb8862a);
      });
      break;
    }
    case 7: {
      // fishing-net cape with cork floats
      g.on(CH.cloth, () => {
        const netTest = (x: number, y: number, z: number) => y >= 6 && (z < 1 || (y >= 18 && z < 5));
        g.shell(0, 13.5, -0.5, 10.8, 9.5, 9.2, 1.1, 0.1, (x, y, z) => netTest(x, y, z) && (x + y + z) % 2 === 0, (x, y, z) => shade(0xb8a77c, 0.9 + hashVox(x, y, z, 3) * 0.15));
        g.shell(0, 13.5, -0.5, 10.8, 9.5, 9.2, 1.1, 0.1, (x, y, z) => netTest(x, y, z) && x % 2 === 0 && y % 2 === 0, 0x8d8160);
      });
      g.on(CH.cloth, () => {
        for (let x = -9; x <= 9; x += 3) {
          const z = -Math.sqrt(Math.max(0, 1 - (x / 11) ** 2)) * 9.6 - 0.5;
          g.blob(x, 6.5, z, 1, 0.9, 0.9, (xx, yy) => (yy > 6 ? 0xe8763a : 0xf2e2c2));
        }
        for (const sx of [1, -1]) {
          g.blob(sx * 6.5, 21.3, 2.5, 1.3, 1.1, 1.3, (xx, yy) => (yy > 21 ? 0xe8763a : 0xf2e2c2));
          g.blob(sx * 7.5, 20, -3.5, 1.1, 1, 1.1, (xx, yy) => (yy > 20 ? 0xf2e2c2 : 0xe8763a));
        }
      });
      break;
    }
    default:
      break;
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Head, jaw, eyes
// ---------------------------------------------------------------------------------------------

function buildHead(face: number, accent: number, bare: boolean): RGrid {
  const g = new RGrid(16, 16, 16, -8, 18, -5);
  const [cx, cy, cz] = HEAD_C;
  const [rx, ry, rz] = HEAD_R;
  const hair = HAIR[face];
  g.on(CH.skin, () => {
    g.blob(cx, cy, cz, rx, ry, rz, skin(11));
    // chubby cheeks
    g.blob(3.6, 23.6, 6, 2.6, 2.2, 2.4, skin(12));
    g.blob(-3.6, 23.6, 6, 2.6, 2.2, 2.4, skin(12));
    // ears
    g.blob(6.1, 25, 2, 1.1, 1.7, 1.4, skin(13));
    g.blob(-6.1, 25, 2, 1.1, 1.7, 1.4, skin(13));
  });
  // rosy cheeks
  g.repaint((x, y, z) => z > 6 && y >= 23 && y <= 24 && Math.abs(Math.abs(x + 0.5) - 4) < 1.2, CH.skin, CHEEK, true);
  // mouth cavity where the jaw sits: carve the lower front and line it dark
  g.carve((x, y, z) => y < 23 && z > 2 && Math.abs(x + 0.5) < 4.6);
  g.on(CH.wet, () => {
    for (let x = -4; x <= 3; x++) for (let z = 2; z <= 6; z++) g.add(x, 22.5, z, z > 4 ? 0x5a1a1e : 0x3a1014);
    for (let x = -4; x <= 3; x++) for (let y = 21; y <= 22; y++) g.add(x, y, 2, 0x3a1014);
  });
  // potato nose
  g.on(CH.skin, () => g.blob(-0.5, 25, 9.3, 1.8, 1.5, 1.4, (x, y, z) => (z >= 10 && y >= 25 ? shade(CHEEK, 1.05) : shade(SKIN, 0.98))));
  // brows (skipped under an eyepatch strap on that side)
  const brow = hairPaint(hair, 31);
  g.on(CH.cloth, () => {
    const thick = face === 4 ? 1 : 0;
    g.box(1, 27, 7, 4, 27 + thick, 8, brow);
    g.box(-5, 27, 7, -2, 27 + thick, 8, brow);
    g.box(1, 27, 9, 3, 27, 9, brow);
    g.box(-4, 27, 9, -2, 27, 9, brow);
  });
  // eye sockets: shallow dents so the bead eyes sit in
  g.carve((x, y, z) => z >= 8 && y >= 25 && y <= 26 && (Math.abs(x + 0.5 - 3) < 1.2 || Math.abs(x + 0.5 + 3) < 1.2));
  // side and back hair, plus a quiff when bare-headed
  const hp = hairPaint(hair, 33);
  g.on(CH.cloth, () => {
    g.shell(cx, cy, cz, rx, ry, rz, 0.8, 0.5, (x, y, z) => (z < 1 && y >= 23 && y <= 28) || (Math.abs(x + 0.5) > 5 && y >= 25 && y <= 27 && z < 4), hp);
    if (bare) {
      g.shell(cx, cy + 0.3, cz, rx, ry, rz, 1.1, 0.6, (x, y, z) => y >= 28.5 && z < 6, hp);
      g.blob(1, 30.6, 5.5, 2.4, 1.3, 2, hp);
      g.blob(-2, 30.4, 4, 2, 1.2, 2, hp);
    }
  });
  // face extras on the upper lip / cheeks
  switch (face) {
    case 0: {
      // bushy beard: moustache on the lip (the beard itself is on the jaw)
      g.on(CH.cloth, () => {
        g.blob(-2.2, 23.6, 8.2, 2.6, 1.1, 1.2, hp);
        g.blob(1.2, 23.6, 8.2, 2.6, 1.1, 1.2, hp);
        g.shell(cx, cy, cz, rx, ry, rz, 0.9, 0.3, (x, y, z) => y < 25 && z > 0 && Math.abs(x + 0.5) > 4, hp);
      });
      break;
    }
    case 1: {
      // mutton chops: huge sideburns joining the moustache
      g.on(CH.cloth, () => {
        g.shell(cx, cy, cz, rx, ry, rz, 1.3, 0.3, (x, y, z) => y >= 21 && y < 27 && z > -1 && z < 8 && Math.abs(x + 0.5) > 3.6, hp);
        g.blob(-2.5, 23.4, 8.1, 2.4, 1, 1.1, hp);
        g.blob(1.5, 23.4, 8.1, 2.4, 1, 1.1, hp);
      });
      break;
    }
    case 2: {
      // clean grin: a row of upper teeth
      g.on(CH.wet, () => {
        for (let x = -4; x <= 3; x++) for (let z = 7; z <= 8; z++) g.set(x, 23, z, 0xfaf6ea);
        g.set(-5, 23, 7, 0x5a1a1e);
        g.set(4, 23, 7, 0x5a1a1e);
      });
      g.repaint((x, y, z) => y === 24 && z > 6 && Math.abs(x + 0.5) < 4.5, CH.skin, shade(CHEEK, 0.85), true);
      g.repaint((x, y, z) => z > 5 && y >= 22 && y <= 25 && Math.abs(Math.abs(x + 0.5) - 5) < 0.8, CH.skin, shade(CHEEK, 1.05), true);
      break;
    }
    case 3: {
      // eyepatch over the left eye, strap round the head; stubble
      g.on(CH.skin, () => {
        g.box(1, 24, 7, 4, 27, 8, 0x1c1a1d);
        g.box(1, 24, 9, 4, 27, 9, 0x2a272b);
      });
      g.repaint((x, y, z) => Math.abs(y - (27 + (x - 2) * 0.55)) < 0.8 && (z < 7 || x > 4) && x > -6, CH.skin, 0x2a272b, true);
      g.repaint((x, y, z) => y < 25 && z > 3 && hashVox(x, y, z, 5) > 0.55, CH.skin, shade(SKIN_SHADE, 0.85), true);
      break;
    }
    case 4: {
      // walrus moustache drooping over the mouth
      g.on(CH.cloth, () => {
        g.blob(-2.7, 23.2, 8.4, 3, 1.5, 1.4, hp);
        g.blob(1.7, 23.2, 8.4, 3, 1.5, 1.4, hp);
        g.box(-6, 20.5, 7, -5, 23, 8, hp);
        g.box(4, 20.5, 7, 5, 23, 8, hp);
      });
      break;
    }
    case 5: {
      // gap-tooth grin
      g.on(CH.wet, () => {
        g.box(-3, 21, 8, -2, 23, 9, 0xfaf3df);
        g.box(1, 21, 8, 2, 23, 9, 0xfaf3df);
      });
      break;
    }
    default:
      break;
  }
  if (accent === 6) {
    // big gold hoop earrings
    g.on(CH.brass, () => {
      for (const sx of [1, -1]) {
        const x0 = sx > 0 ? 6 : -7;
        for (let a = 0; a < 10; a++) {
          const ang = (a / 10) * Math.PI * 2;
          g.set(x0 + sx * 0.5 + Math.cos(ang) * 1.6 * sx, 22 + Math.sin(ang) * 1.8, 2, a % 3 === 0 ? shade(BRASS, 1.2) : BRASS);
        }
      }
    });
  }
  return g;
}

function buildJaw(face: number): RGrid {
  const g = new RGrid(14, 12, 12, -7, 14, -3);
  const hair = HAIR[face];
  const hp = hairPaint(hair, 35);
  // chin and lower lip filling the mouth cavity
  g.on(CH.skin, () => {
    g.blob(-0.5, 22, 4.6, 4.5, 2.2, 3.9, skin(14), (x, y, z) => y < 23 && z > 2);
  });
  // tongue and lower teeth on the top
  g.on(CH.wet, () => {
    for (let x = -3; x <= 2; x++) for (let z = 3; z <= 5; z++) g.paint(x, 22, z, z === 5 ? 0xd65a6a : 0xb8404f);
    if (face === 2 || face === 5) for (let x = -3; x <= 2; x++) g.paint(x, 22, 7, 0xf6f0e0);
  });
  switch (face) {
    case 0:
      // bushy beard hanging onto the chest
      g.on(CH.cloth, () => {
        g.blob(-0.5, 20.5, 5.5, 5.4, 3.6, 3.4, hp, (x, y, z) => y < 22.6 && z > 1.5);
        g.blob(-0.5, 17.8, 6.2, 3.6, 2.6, 2.4, hp);
        g.set(-1, 15, 6, shade(hair, 0.9));
        g.set(0, 15, 6, shade(hair, 0.9));
      });
      break;
    case 3:
      g.repaint((x, y, z) => hashVox(x, y, z, 6) > 0.45, CH.skin, shade(SKIN_SHADE, 0.82), true);
      break;
    case 4:
      // white walrus tips over the chin corners
      g.on(CH.cloth, () => {
        g.box(-6, 20, 6, -5, 21, 7, hp);
        g.box(4, 20, 6, 5, 21, 7, hp);
      });
      break;
    case 5:
      // goatee
      g.on(CH.cloth, () => g.blob(-0.5, 20.2, 7.2, 1.6, 1.4, 1, hp));
      break;
    default:
      break;
  }
  return g;
}

function buildEyes(face: number): RGrid {
  const g = new RGrid(14, 6, 4, -7, 23, 6);
  beadEyes(g, 2, 25, 9, face === 3 ? 'right' : 'both');
  return g;
}

// ---------------------------------------------------------------------------------------------
// Hats
// ---------------------------------------------------------------------------------------------

interface HatResult {
  hat: RGrid | null;
  extra: RGrid | null;
  mode: HatMode;
  spin: number;
  extraJoint: V3;
}

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
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: true, mode: 'bob', spin: 0, extraJoint: [0, 32, HC] },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: true, mode: 'sway', spin: 0, extraJoint: [0, 27, HC - 6.5] },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: true, mode: 'spin', spin: 2.4, extraJoint: [0, 33, HC] },
];

function ring(g: RGrid, cy: number, cz: number, r0: number, r1: number, y0: number, y1: number, col: ColorFn | number, test?: (x: number, y: number, z: number) => boolean): void {
  for (let y = y0; y <= y1; y++)
    for (let z = Math.floor(cz - r1 - 1); z <= cz + r1 + 1; z++)
      for (let x = -Math.ceil(r1 + 1); x <= r1 + 1; x++) {
        const d = Math.hypot(x + 0.5, z + 0.5 - cz);
        if (d <= r1 && d >= r0 && (!test || test(x, y, z))) g.set(x, y, z, typeof col === 'number' ? col : col(x, y, z));
      }
  void cy;
}

function buildHat(hat: number, t: TeamCols): HatResult {
  const cz = HEAD_C[2];
  const none: HatResult = { hat: null, extra: null, mode: 'none', spin: 0, extraJoint: SK.hatExtra };
  const g = new RGrid(22, 14, 22, -11, 25, cz - 11);
  switch (hat) {
    case 0:
      return none;
    case 1: {
      // captain cap: white crown, team band, black glossy peak, gold anchor badge
      g.on(CH.cloth, () => {
        ring(g, 0, cz, 0, 5.4, 28, 30, jitter(0xf3f0e6, 0.03, 3));
        ring(g, 0, cz + 0.4, 0, 6.2, 31, 31, jitter(0xf8f6ee, 0.03, 4));
      });
      g.on(CH.rubber, () => {
        ring(g, 0, cz, 4.6, 5.8, 28, 28, t.main);
        ring(g, 0, cz + 2.5, 0, 5.2, 28, 28, 0x16181d, (x, y, z) => z > cz + 3);
      });
      g.on(CH.brass, () => {
        g.box(-1, 29, cz + 5, 0, 30, cz + 5, BRASS);
        g.set(-2, 29, cz + 5, BRASS);
        g.set(1, 29, cz + 5, BRASS);
      });
      return { ...none, hat: g };
    }
    case 2: {
      // sou'wester: yellow oilskin dome with a long back brim
      const c = ramp(OILSKIN, 41, 0.07, 0.06, 27, 32);
      g.on(CH.rubber, () => {
        g.blob(0, 28, cz, 6.4, 3.8, 6.2, c, (x, y) => y >= 28);
        for (let z = -10; z <= 14; z++)
          for (let x = -10; x <= 9; x++) {
            const dz = z + 0.5 - cz;
            const dx = x + 0.5;
            const d = Math.hypot(dx, dz * (dz < 0 ? 0.7 : 1.1));
            if (d <= 8.3 && d > 5.6) g.set(x, 28 - Math.max(0, -dz) * 0.32, z, shade(OILSKIN, 0.9));
          }
        ring(g, 0, cz, 5.6, 6.6, 28, 28, t.main);
      });
      return { ...none, hat: g };
    }
    case 3: {
      // bobble beanie in team colour with a ribbed cuff and a bouncy pom-pom
      const knit: ColorFn = (x, y, z) => shade((x + 100) % 2 === 0 ? t.main : shade(t.main, 0.86), 0.95 + hashVox(x, y, z, 7) * 0.08);
      g.on(CH.cloth, () => {
        g.blob(0, 28, cz, 6.3, 5, 6.1, knit, (x, y) => y >= 28);
        ring(g, 0, cz, 5.5, 6.7, 27, 28, (x, y, z) => ((x + z + 100) % 2 === 0 ? t.light : shade(t.light, 0.88)));
      });
      const p = new RGrid(8, 8, 8, -4, 30, cz - 4);
      p.on(CH.cloth, () => p.blob(0, 34, cz, 2.3, 2.1, 2.3, (x, y, z) => (hashVox(x, y, z, 8) > 0.5 ? 0xf6f2ea : t.light)));
      return { hat: g, extra: p, mode: 'bob', spin: 0, extraJoint: [0, 32, cz] };
    }
    case 4: {
      // bucket hat with lures stuck in the band
      const kh = ramp(0xb7a77a, 43, 0.06, 0.05, 27, 31);
      g.on(CH.cloth, () => {
        ring(g, 0, cz, 0, 5.2, 28, 31, kh);
        for (let z = -8; z <= 13; z++)
          for (let x = -9; x <= 8; x++) {
            const d = Math.hypot(x + 0.5, z + 0.5 - cz);
            if (d <= 7.8 && d > 4.6) g.set(x, 27.5 - (d > 6.6 ? 0.6 : 0), z, shade(0xb7a77a, 0.9));
          }
        ring(g, 0, cz, 4.6, 5.6, 28, 28, t.dark);
      });
      g.on(CH.wet, () => {
        g.box(4, 29, cz + 2, 5, 30, cz + 2, 0xe03a2a);
        g.set(5, 31, cz + 2, 0xffffff);
        g.box(-6, 29, cz - 1, -6, 29, cz + 1, 0xd8dfe6);
      });
      g.on(CH.brass, () => g.set(-6, 30, cz, BRASS));
      return { ...none, hat: g };
    }
    case 5: {
      // bandana with polka dots, knotted at the back with flapping tails
      const dot: ColorFn = (x, y, z) => ((x * 3 + y * 5 + z * 7 + 300) % 5 === 0 ? 0xf6f0e6 : shade(t.main, 0.95 + hashVox(x, y, z, 9) * 0.08));
      g.on(CH.cloth, () => {
        g.shell(HEAD_C[0], HEAD_C[1], HEAD_C[2], HEAD_R[0], HEAD_R[1], HEAD_R[2], 0.9, -0.1, (x, y, z) => y >= 27.4 - (z < 3 ? 1.2 : 0), dot);
        g.blob(0, 27, cz - 6.3, 1.5, 1.3, 1.1, t.dark);
      });
      const tails = new RGrid(8, 8, 6, -4, 22, cz - 10);
      tails.on(CH.cloth, () => {
        tails.box(-2, 23, cz - 7, -1, 26, cz - 7, dot);
        tails.box(1, 23, cz - 7, 2, 25, cz - 7, dot);
        tails.set(-2, 22, cz - 8, t.main);
        tails.set(2, 23, cz - 8, t.main);
      });
      return { hat: g, extra: tails, mode: 'sway', spin: 0, extraJoint: [0, 27, cz - 6.5] };
    }
    case 6: {
      // pirate tricorn: black felt, gold trim, team cockade
      const felt = jitter(0x2b2628, 0.06, 13);
      g.on(CH.cloth, () => {
        g.blob(0, 27.6, cz, 6.6, 3.8, 6.4, felt, (x, y) => y >= 27.6);
        for (let z = -9; z <= 14; z++)
          for (let x = -10; x <= 9; x++) {
            const dx = x + 0.5;
            const dz = z + 0.5 - cz;
            const a = Math.atan2(dz, dx);
            const r = Math.hypot(dx, dz);
            const tri = 8.4 + 1.6 * Math.cos(3 * (a - Math.PI / 2));
            if (r <= tri && r > 5.6) {
              const up = (r - 5.6) * 0.55;
              const edge = r > tri - 1;
              g.on(edge ? CH.brass : CH.cloth, () => g.set(x, 28 + up, z, edge ? BRASS : 0x2b2628));
              g.set(x, 28 + up - 1, z, 0x241f21);
            }
          }
      });
      g.on(CH.rubber, () => {
        g.blob(3.5, 30.4, cz + 5.2, 1.3, 1.3, 0.8, t.main);
        g.set(3, 30, cz + 6, t.light);
      });
      return { ...none, hat: g };
    }
    case 7: {
      // lighthouse helm: team/white striped tower, glowing lantern, rotating shutter
      g.on(CH.rubber, () => {
        for (let y = 27; y <= 31; y++) ring(g, 0, cz, 0, 5.4 - (y - 27) * 0.35, y, y, (x, yy) => (Math.floor((yy - 27) / 2) % 2 === 0 ? t.main : 0xf4f1ea));
        ring(g, 0, cz, 0, 4.4, 32, 32, 0x2b3038);
      });
      g.on(CH.glow, () => ring(g, 0, cz, 0, 2.5, 33, 35, 0xfff2b0));
      g.on(CH.iron, () => {
        ring(g, 0, cz, 0, 3.2, 36, 36, 0x3a3f47);
        g.set(0, 37, cz, 0x3a3f47);
        g.set(-1, 37, cz, 0x3a3f47);
      });
      const sh = new RGrid(8, 5, 8, -4, 32, cz - 4);
      sh.on(CH.iron, () => {
        sh.box(-3, 33, cz - 1, -3, 35, cz, 0x2e333b);
        sh.box(2, 33, cz - 1, 2, 35, cz, 0x2e333b);
      });
      return { hat: g, extra: sh, mode: 'spin', spin: 2.4, extraJoint: [0, 33, cz] };
    }
    default:
      return none;
  }
}

// ---------------------------------------------------------------------------------------------
// Arms, legs, hook
// ---------------------------------------------------------------------------------------------

function anchor(g: RGrid, ox: number, y0: number, oz: number, sx: number): void {
  // anchor tattoo on the outer face (x = ox), facing outward along sx
  const ink = 0x2f4a78;
  const pts: [number, number][] = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [-1, 3], [1, 3], [-2, 0], [2, 0], [-2, 1], [2, 1], [-1, -1], [1, -1]];
  for (const [dz, dy] of pts) {
    for (let k = 0; k < 3; k++) {
      const x = ox - sx * k;
      if (g.has(x, y0 + dy, oz + dz)) {
        g.paint(x, y0 + dy, oz + dz, ink);
        break;
      }
    }
  }
  if (g.has(ox, y0 + 5, oz)) g.paint(ox, y0 + 5, oz, 0xc8384a);
}

function buildUpperArm(accent: number, t: TeamCols): RGrid {
  const g = new RGrid(8, 9, 8, 6, 11, -4);
  const sx = SK.shoulder[0];
  const sz = SK.shoulder[2];
  const coat = accent === 5;
  if (accent === 2) {
    // sleeveless: bare beefy arm with a big anchor tattoo
    g.on(CH.skin, () => {
      g.cyl('y', sx, sz, 2.3, 12, 18, skin(54));
      g.blob(sx, 17.6, sz, 2.7, 1.8, 2.6, skin(55));
    });
    g.on(CH.skin, () => anchor(g, Math.floor(sx + 2.2), 13, Math.floor(sz), 1));
    g.on(CH.rubber, () => g.box(Math.floor(sx) - 2, 19, Math.floor(sz) - 1, Math.floor(sx) - 1, 19, Math.floor(sz) + 1, t.dark));
    return g;
  }
  const sleeve = coat ? ramp(OILSKIN, 51, 0.07) : shirtPaint(accent === 1, 52);
  g.on(coat ? CH.rubber : CH.cloth, () => {
    g.cyl('y', sx, sz, 2.3, 14, 18, sleeve);
    g.blob(sx, 17.6, sz, 2.7, 1.8, 2.6, sleeve);
    // rolled cuff
    g.cyl('y', sx, sz, 2.8, 12.5, 13.5, coat ? shade(OILSKIN, 0.86) : jitter(shade(SHIRT, 0.94), 0.05, 53));
  });
  if (!coat && accent !== 4) {
    // apron strap over the shoulder top
    g.on(CH.rubber, () => g.box(Math.floor(sx) - 2, 19, Math.floor(sz) - 1, Math.floor(sx) - 1, 19, Math.floor(sz) + 1, t.dark));
  }
  return g;
}

function buildLowerArm(accent: number, hookHand: boolean): RGrid {
  const g = new RGrid(9, 10, 9, 5, 4, -4);
  const [hx, hy, hz] = SK.hand;
  const sx = SK.elbow[0];
  const sz = SK.elbow[2];
  g.on(CH.skin, () => {
    // Popeye forearm, thicker in the middle
    for (let y = 9; y <= 13; y++) {
      const r = 2.1 + Math.sin(((y - 9) / 4) * Math.PI) * 0.45;
      g.cyl('y', sx, sz + (y < 11 ? 0.3 : 0), r, y, y, skin(61));
    }
    // fist
    g.blob(hx, hy, hz, 2.7, 2.4, 2.7, skin(62));
  });
  // arm hair speckles
  g.repaint((x, y, z) => y >= 9 && y <= 12 && hashVox(x, y, z, 63) > 0.86, CH.cloth, shade(HAIR[0], 0.8), true);
  // knuckles
  g.repaint((x, y, z) => z >= hz + 2 && y >= hy && y <= hy + 1, CH.skin, shade(SKIN, 1.08), true);
  if (hookHand) {
    // fingers curled round the rope
    g.repaint((x, y, z) => y <= hy - 1 && z >= hz, CH.skin, shade(SKIN, 0.94), true);
  }
  if (accent === 2) {
    // anchor tattoo on the outer forearm
    const ox = Math.floor(sx) + 2;
    g.on(CH.skin, () => {
      const ink = 0x2f4a78;
      for (let y = 9; y <= 12; y++) g.paint(ox, y, Math.floor(sz), ink);
      g.paint(ox, 12, Math.floor(sz) - 1, ink);
      g.paint(ox, 12, Math.floor(sz) + 1, ink);
      g.paint(ox, 9, Math.floor(sz) - 1, ink);
      g.paint(ox, 9, Math.floor(sz) + 1, ink);
      g.paint(ox, 10, Math.floor(sz) - 2, ink);
      g.paint(ox, 10, Math.floor(sz) + 2, ink);
      g.paint(ox, 11, Math.floor(sz) + 2, 0xc8384a);
    });
  }
  return g;
}

function buildLeg(t: TeamCols): RGrid {
  const g = new RGrid(9, 10, 10, 0, 0, -4);
  const lx = SK.leg[0];
  // trouser leg disappearing up into the belly
  g.on(CH.cloth, () => g.cyl('y', lx, -0.3, 2.4, 4, 9, ramp(TROUSER, 71, 0.07)));
  // welly boot
  g.on(CH.rubber, () => {
    g.box(1, 1, -2, 6, 4, 1, (x, y, z) => shade(BOOT, 0.92 + hashVox(x, y, z, 72) * 0.12));
    g.blob(lx, 1.6, 2, 2.6, 1.7, 1.9, (x, y, z) => shade(BOOT, 0.95 + hashVox(x, y, z, 73) * 0.1));
    g.box(1, 0, -2, 6, 0, 3, SOLE);
    // team-coloured cuff
    g.cyl('y', lx, -0.4, 2.9, 4, 4, t.main);
  });
  g.carve((x, y, z) => (x === 1 || x === 6) && (z === -2 || z === 3) && y >= 1);
  return g;
}

function buildHook(t: TeamCols): RGrid {
  // in the hand frame (kept hanging straight down): rope from the fist, then the iron hook
  const g = new RGrid(10, 14, 10, -5, -12, -4);
  const iron: ColorFn = (x, y, z) => {
    const h = hashVox(x, y, z, 81);
    if (h > 0.93) return 0x7b5a3c;
    return shade(z > 0 ? 0x80878f : 0x5d636a, 0.92 + h * 0.14);
  };
  // rope out of the bottom of the fist
  g.on(CH.cloth, () => {
    for (let y = -4; y <= -1; y++) g.set(y % 2 ? -1 : 0, y, y % 2 ? 0 : -1, y % 2 ? ROPE : shade(ROPE, 0.8));
    g.set(-1, -4, -1, shade(ROPE, 0.9));
  });
  g.on(CH.iron, () => {
    // eye
    g.box(-1, -5, -1, 0, -5, 0, iron);
    // shank
    g.box(-1, -8, -1, 0, -6, 0, iron);
    // bend
    for (let a = 0; a <= 12; a++) {
      const ang = Math.PI + (a / 12) * Math.PI;
      const y = -8.6 + Math.sin(ang) * 2.2;
      const z = 1.4 + Math.cos(ang) * 2.2;
      g.box(-1, Math.floor(y), Math.floor(z), 0, Math.floor(y), Math.floor(z), iron);
    }
    // point rising up with the barb
    g.box(-1, -8, 3, 0, -7, 3, iron);
  });
  g.on(CH.wet, () => {
    g.box(-1, -6, 3, 0, -6, 3, 0xd0d7df);
    g.box(-1, -7, 2, 0, -7, 2, 0xc4ccd5);
  });
  // little team fish lure on a split ring beside the shank
  g.on(CH.rubber, () => {
    g.blob(1.6, -7.2, 0, 1, 1.7, 1.2, (x, y, z) => (y < -8 ? mix(t.light, 0xffffff, 0.4) : y === -7 ? 0xffffff : t.main));
    g.set(2, -6, 1, 0x111111);
    g.set(1, -9, 0, t.dark);
    g.set(2, -10, 0, t.dark);
  });
  g.on(CH.brass, () => g.set(1, -5, 0, 0xf6c443));
  return g;
}

// ---------------------------------------------------------------------------------------------

export function brawlerPalette(c: Cosmetics, team: Team): PudgyPalette {
  const n = COSMETIC_NAMES.brawler;
  const face = wrap(c.face, n.faces.length);
  const t = TEAM_COLORS[team];
  return { skin: SKIN, skinDark: SKIN_SHADE, cloth: t.main, accent: wrap(c.accent, n.accents.length) === 5 ? OILSKIN : SHIRT, metal: 0x6a7078, extra: [BOOT, HAIR[face], TROUSER, t.dark] };
}

export function buildBrawler(c: Cosmetics, team: Team): FamilyBuild {
  const n = COSMETIC_NAMES.brawler;
  const hat = wrap(c.hat, n.hats.length);
  const accent = wrap(c.accent, n.accents.length);
  const face = wrap(c.face, n.faces.length);
  const t = TEAM_COLORS[team];
  const k = (s: string) => `brawler:${s}:${team}`;
  const hr = HAT_META[hat];
  const sk: Skeleton = { ...SK, hatExtra: hr.extraJoint };
  const parts: Partial<Record<PartName, PartDef>> = {
    body: part(k(`body${accent}`), () => buildBody(accent, t), SK.body),
    head: part(k(`head${face}.${accent === 6 ? 1 : 0}.${hat === 0 ? 1 : 0}`), () => buildHead(face, accent, hat === 0), SK.neck),
    jaw: part(k(`jaw${face}`), () => buildJaw(face), SK.jaw),
    eyes: part(k(`eyes${face === 3 ? 1 : 0}`), () => buildEyes(face), SK.eyes),
    upperL: part(k(`uarm${accent}`), () => buildUpperArm(accent, t), SK.shoulder),
    upperR: partMirrored(k(`uarm${accent}`) + 'R', () => buildUpperArm(accent, t), SK.shoulder),
    lowerL: part(k(`larm${accent}`), () => buildLowerArm(accent, false), SK.elbow),
    lowerR: partMirrored(k(`larm${accent}`) + 'R', () => buildLowerArm(accent, true), SK.elbow),
    legL: part(k('leg'), () => buildLeg(t), SK.leg),
    legR: partMirrored(k('leg') + 'R', () => buildLeg(t), SK.leg),
    hook: part(k('hook'), () => buildHook(t), [0, 0, 0]),
    drop: part('brawler:drop', () => dropGrid(false), [0, 0, 0]),
  };
  if (hr.hat) parts.hat = part(k(`hat${hat}`), () => buildHat(hat, t).hat!, SK.hat);
  if (hr.extra) parts.hatExtra = part(k(`hatx${hat}`), () => buildHat(hat, t).extra!, hr.extraJoint);
  return {
    family: 'brawler',
    sk,
    rest: { armSplay: 0.3, armFwd: -0.18, elbow: -0.3, legSplay: 0.04, hunch: 0, headPitch: 0, jawRest: 0, holdElbow: -0.75 },
    style: { kind: 'swagger', stride: 1.9, bounce: 0.09, legSwing: 0.75, armSwing: 0.65, roll: 0.13, sway: 0.1, lean: 0.12, stomp: 0.5, breath: 0.32 },
    hatMode: hr.mode,
    hatSpin: hr.spin,
    parts,
    palette: brawlerPalette(c, team),
    scale: 1,
    hookDangles: true,
  };
}
