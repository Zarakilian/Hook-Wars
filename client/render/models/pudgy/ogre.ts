// Swamp Ogre: a mossy, warty, tusked bog troll with mushrooms growing on its shoulders, a leaf
// loincloth, a team-coloured sash and wrist wraps, and a bone hook lashed with vine.
import { COSMETIC_NAMES, TEAM_COLORS, type PudgyPalette } from '../../contracts.ts';
import type { Cosmetics, Team } from '../../../../shared/types.ts';
import { beadEyes, dropGrid, part, partMirrored, teamPaint, wrap, type TeamCols } from './common.ts';
import { CH, hashVox, mix, RGrid, shade, type ColorFn } from './grid.ts';
import type { FamilyBuild, HatMode, PartDef, PartName, Skeleton, V3 } from './types.ts';

const SKIN = 0x6c9a80;
const SKIN_DARK = 0x547a66;
const SKIN_LIGHT = 0x86b29a;
const BELLY = 0xd2cf98;
const WART = 0x5b8068;
const MOSS = [0x4b7426, 0x5f8f32, 0x76a83e, 0x689a36] as const;
const BONE = 0xeee3c8;
const BONE_DARK = 0xcdbf9c;
const LEAF = 0x4f7a2a;
const LEAF_LIGHT = 0x6e9e36;
const REED = 0xc2a85a;
const MUSH = 0xc4562e;
const MUSH_SPOT = 0xf2e2c2;
/** body mushrooms: a team-neutral tan so they never read as a team colour from above */
const SHROOM = 0xb98a52;
const STEM = 0xe6dac0;
const MUD = 0x5b4128;
const VINE = 0x3f6a22;
const CLAW = 0x2f2a24;

const SK: Skeleton = {
  core: 12,
  hip: [0, 5.5, 0],
  leg: [4, 5.5, 0],
  body: [0, 11.5, 1.5],
  neck: [0, 19.5, 4.5],
  shoulder: [10.5, 17.5, -0.5],
  elbow: [10.5, 11.5, -0.5],
  hand: [10.5, 5.5, 0.5],
  jaw: [0, 21.5, 4.5],
  eyes: [0, 24.5, 13],
  hat: [0, 27, 7],
  hatExtra: [0, 30, 7],
  drop: [6, 26, 8],
};
const HEAD_C: V3 = [0, 23.2, 7.5];
const HEAD_R: V3 = [7, 5.2, 5.8];

function skin(seed: number, belly = false): ColorFn {
  return (x, y, z) => {
    const h = hashVox(x, y, z, seed);
    const base = belly ? BELLY : h > 0.93 ? SKIN_LIGHT : h < 0.07 ? SKIN_DARK : SKIN;
    return shade(base, 0.97 + (h - 0.5) * 0.05);
  };
}
const moss: ColorFn = (x, y, z) => shade(MOSS[Math.floor(hashVox(x, y, z, 91) * MOSS.length) % MOSS.length], 0.92 + hashVox(x, y, z, 92) * 0.16);

/** Wart spots painted over a surface region (no loose voxels, so the silhouette stays clean). */
function warts(g: RGrid, test: (x: number, y: number, z: number) => boolean, density: number, seed: number): void {
  g.each((c, x, y, z) => {
    if ((c & 7) !== CH.skin || !test(x, y, z)) return undefined;
    const h = hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), seed);
    if (h > 1 - density) return hashVox(x, y, z, seed + 1) > 0.4 ? WART : shade(SKIN_DARK, 0.92);
    if (h < density * 0.5) return SKIN_LIGHT;
    return undefined;
  }, true);
}

/** A few deliberate raised warts. */
function bigWarts(g: RGrid, pts: readonly (readonly [number, number, number])[]): void {
  g.on(CH.skin, () => {
    for (const [x, y, z] of pts) g.blob(x, y, z, 0.95, 0.95, 0.95, (xx, yy) => (yy > y ? shade(WART, 1.12) : WART));
  });
}

function mossPatch(g: RGrid, cx: number, cy: number, cz: number, r: number, seed: number): void {
  g.on(CH.cloth, () => {
    for (let z = Math.floor(cz - r - 1); z <= cz + r + 1; z++)
      for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
        for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
          if (d > r + hashVox(x, y, z, seed) * 1.2) continue;
          if (g.has(x, y, z)) g.paint(x, y, z, moss(x, y, z));
          else if (d < r - 0.5 && hashVox(x, y, z, seed + 3) > 0.6 && g.has(x, y - 1, z)) g.set(x, y, z, moss(x, y, z));
        }
  });
}

function mushroom(g: RGrid, x: number, y: number, z: number, s: number, lean = 0): void {
  g.on(CH.cloth, () => {
    g.box(x, y, z, x, y + Math.round(s), z, STEM);
    g.blob(x + 0.5 + lean, y + s + 1, z + 0.5, s * 0.9 + 0.6, s * 0.45 + 0.4, s * 0.9 + 0.6, (xx, yy, zz) => (hashVox(xx, yy, zz, 19) > 0.78 && yy >= y + s + 1 ? MUSH_SPOT : shade(SHROOM, 0.92 + hashVox(xx, yy, zz, 18) * 0.15)), (_x, yy) => yy >= y + s + 0.5);
  });
}

// ---------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------

function buildBody(accent: number, t: TeamCols): RGrid {
  const g = new RGrid(30, 24, 28, -15, 2, -13);
  g.on(CH.skin, () => {
    g.blob(0, 11.5, 1.5, 11, 7.6, 9.5, skin(1));
    g.blob(0, 16.5, -2.5, 9, 5.2, 7, skin(2));
    g.blob(0, 19.5, 0.5, 7.5, 3.6, 6, skin(3));
  });
  // pale belly
  g.repaint((x, y, z) => z > 4 && y < 17 && Math.abs(x + 0.5) < 7.5 - Math.max(0, y - 13) * 0.6, CH.skin, skin(4, true), true);
  g.repaint((x, y, z) => z > 4 && y < 17 && Math.abs(x + 0.5) < 7.5 && (y + Math.floor(Math.abs(x + 0.5) / 3)) % 3 === 0 && hashVox(x, y, z, 5) > 0.3, CH.skin, shade(BELLY, 0.9), true);
  warts(g, (x, y, z) => z < 2 || y > 17, 0.12, 7);
  bigWarts(g, [[8.5, 14, 5], [-9, 12, 3], [4, 19, -7], [-6, 17, -8]]);
  // moss on the hump and one shoulder, mushrooms growing out of it
  mossPatch(g, 0, 20.5, -5, 3.6, 11);
  mossPatch(g, 7, 19.5, -1.5, 2.2, 12);
  mushroom(g, 6, 21, -2, 1.6, 0.4);
  mushroom(g, 8, 20, 0, 1, 0);
  mushroom(g, -2, 23, -5, 1.2, -0.3);

  // leaf loincloth (or reed skirt) round the hips
  if (accent === 3) {
    g.on(CH.cloth, () => {
      g.shell(0, 9, 1.5, 11, 7.6, 9.5, 1.9, 0.2, (x, y, z) => y <= 9 && y >= 0, (x, y, z) => (hashVox(x, 0, z, 23) > 0.2 ? shade(0xd8bf66, 0.85 + hashVox(x, 0, z, 24) * 0.25) : shade(REED, 0.62)));
      g.carve((x, y, z) => y <= 3 && (x + z) % 2 === 0 && y < 1 + hashVox(x, 0, z, 25) * 3);
      g.repaint((x, y) => y === 8, CH.cloth, 0x7a5a2e, true);
    });
  } else {
    g.on(CH.cloth, () => {
      g.shell(0, 9, 1.5, 11, 7.6, 9.5, 1.1, 0.2, (x, y, z) => y <= 8 && y >= 3, (x, y, z) => {
        const leaf = Math.floor((Math.atan2(z - 1.5, x + 0.5) + Math.PI) * 3);
        return shade(leaf % 2 ? LEAF : LEAF_LIGHT, 0.88 + hashVox(x, y, z, 26) * 0.2 - (8 - y) * 0.02);
      });
      // leaf tips hanging lower
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = Math.cos(ang) * 11.2;
        const z = 1.5 + Math.sin(ang) * 9.8;
        g.set(x, 2, z, a % 2 ? LEAF : LEAF_LIGHT);
        g.set(x, 1, z, shade(LEAF, 0.85));
      }
    });
    // team front flap
    g.on(CH.cloth, () => {
      g.shell(0, 9, 1.5, 11, 7.6, 9.5, 1.5, -0.6, (x, y, z) => z > 7 && y <= 8 && y >= 0 && Math.abs(x + 0.5) < 3.5 - (8 - y) * 0.12, teamPaint(t, 27, 0, 8));
    });
  }
  // belt of twisted vine
  g.repaint((x, y) => y === 8, CH.cloth, (x, y, z) => ((x + z) % 2 === 0 ? VINE : shade(VINE, 1.25)), true);

  // team sash: left shoulder to right hip, front and back
  const sash = teamPaint(t, 28, 4, 22);
  const onSash = (x: number, y: number) => Math.abs(y - (8.5 + (x + 10) * 0.62)) < 3.0;
  g.on(CH.cloth, () => {
    g.shell(0, 11.5, 1.5, 11, 7.6, 9.5, 0.95, 0.2, (x, y, z) => onSash(x, y) && y > 7, sash);
    g.shell(0, 16.5, -2.5, 9, 5.2, 7, 0.95, 0.2, (x, y, z) => onSash(x, y) && y > 7, sash);
    // knot on the right hip with tails
    g.blob(-9.5, 9.5, 5, 1.8, 1.6, 1.6, sash);
    g.box(-10, 5, 6, -9, 8, 6, shade(t.main, 0.9));
    g.box(-12, 5, 5, -11, 7, 5, shade(t.dark, 1));
  });
  if (accent === 0) {
    // big leaf pauldron on the left shoulder
    g.on(CH.cloth, () => {
      for (let i = 0; i < 3; i++) g.shell(7, 19.5, -1, 3.6 - i * 0.6, 2.2, 3.6 - i * 0.6, 0.9, 0.1, (x, y, z) => y > 18 + i, i % 2 ? LEAF : LEAF_LIGHT);
    });
    // leaves pinned on the sash
    g.on(CH.cloth, () => {
      for (const [x, y, z] of [[4, 17, 8], [-1, 14, 10], [7, 21, 3]] as const) {
        g.box(x, y, z, x + 1, y, z + 1, LEAF_LIGHT);
        g.set(x + 2, y + 1, z, LEAF);
      }
    });
  }

  switch (accent) {
    case 1: {
      // long necklace of bones and teeth hanging on the belly
      g.on(CH.wet, () => {
        for (let i = -7; i <= 7; i++) {
          const x = i;
          const y = 17 - (49 - i * i) * 0.06;
          const z = 1.5 + 9.5 * Math.sqrt(Math.max(0, 1 - (x / 11.4) ** 2 - ((y - 11.5) / 7.9) ** 2)) + 0.8;
          g.set(x, y, z, VINE);
          if (i % 2 === 0) {
            g.box(x, y - 2, z, x, y - 1, z, i % 4 === 0 ? BONE : 0xfffaf0);
            g.set(x, y - 3, z - 0.3, BONE_DARK);
          }
        }
        g.blob(-0.5, 11.8, 11.2, 1.6, 1.4, 0.8, BONE);
        g.set(-1, 12, 12, 0x2a2420);
        g.set(0, 12, 12, 0x2a2420);
      });
      break;
    }
    case 2: {
      // mud war paint: stripes and a handprint
      g.repaint((x, y, z) => z > 3 && Math.abs((y - 10) - Math.abs(x + 0.5) * 0.4) < 0.6 && Math.abs(x + 0.5) > 2, CH.skin, MUD, true);
      g.repaint((x, y, z) => z > 3 && Math.abs((y - 13) - Math.abs(x + 0.5) * 0.4) < 0.6 && Math.abs(x + 0.5) > 3, CH.skin, MUD, true);
      g.repaint((x, y, z) => z < -3 && Math.hypot(x + 0.5 - 4, y - 14) < 2.2, CH.skin, shade(MUD, 1.1), true);
      break;
    }
    case 4: {
      // frog pouch on the belt with a frog peeking out
      g.on(CH.skin, () => g.blob(4.5, 6.5, 10.6, 2.4, 2.3, 1.8, (x, y, z) => shade(0x7a5434, 0.9 + hashVox(x, y, z, 31) * 0.15)));
      g.on(CH.wet, () => {
        g.blob(4.5, 9, 10.8, 2, 1.2, 1.4, 0x5fae3a);
        g.set(3, 10, 11, 0xfff1a0);
        g.set(6, 10, 11, 0xfff1a0);
        g.set(3, 10, 12, 0x111111);
        g.set(6, 10, 12, 0x111111);
        g.set(4, 9, 12, 0x2d5a1c);
        g.set(5, 9, 12, 0x2d5a1c);
      });
      break;
    }
    case 6: {
      // snail shell belt
      g.on(CH.wet, () => {
        for (let a = 0; a < 9; a++) {
          const ang = 0.35 + (a / 8) * (Math.PI - 0.7);
          const x = Math.cos(ang) * 11.6;
          const z = 1.5 + Math.sin(ang) * 10.2;
          g.blob(x, 8, z, 1.4, 1.4, 1.4, (xx, yy, zz) => ((xx * 2 + yy + zz) % 3 === 0 ? 0xa56f3e : yy > 8 ? 0xf2e2bc : 0xe0c898));
        }
      });
      break;
    }
    case 5: {
      // vines wrapped round the belly
      g.repaint((x, y, z) => Math.abs(y - (11 + (x + 0.5) * 0.45)) < 0.7 || Math.abs(y - (15 - (x + 0.5) * 0.35)) < 0.6, CH.cloth, (x, y, z) => (hashVox(x, y, z, 43) > 0.8 ? LEAF_LIGHT : VINE), true);
      break;
    }
    case 7: {
      // bioluminescent spots
      g.repaint((x, y, z) => hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), 41) > 0.8, CH.pulse, (x, y, z) => (hashVox(x, y, z, 42) > 0.5 ? 0x6ff0e0 : 0x9cfff0), true);
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

function buildHead(face: number, bare: boolean): RGrid {
  const g = new RGrid(26, 16, 20, -13, 16, -2);
  const [cx, cy, cz] = HEAD_C;
  const [rx, ry, rz] = HEAD_R;
  g.on(CH.skin, () => {
    g.blob(cx, cy, cz, rx, ry, rz, skin(51));
    // heavy brow ridge
    g.blob(-0.5, 25.9, 11.6, 5.6, 1.3, 1.7, skin(52));
    // big pointy ears sticking out sideways
    for (const s of [1, -1]) {
      g.tube(s * 6, 23.5, 6, s * 9.5, 25, 5, 1.4, skin(53));
      g.tube(s * 9.5, 25, 5, s * 11.5, 26.5, 4, 0.9, skin(54));
      g.blob(s * 8, 24.2, 6.2, 1.1, 0.8, 0.6, SKIN_DARK);
    }
  });
  warts(g, (x, y, z) => y > 25 || z < 5, 0.14, 55);
  bigWarts(g, [[4.5, 27, 10], [-5.5, 22, 11]]);
  // mouth cavity for the big jaw
  g.carve((x, y, z) => y < 21.6 && z > 4 && Math.abs(x + 0.5) < 5.6);
  g.on(CH.wet, () => {
    for (let x = -5; x <= 4; x++) for (let z = 4; z <= 10; z++) g.add(x, 21, z, z > 8 ? 0x5c1f22 : 0x351014);
  });
  // eye sockets under the brow
  g.carve((x, y, z) => z >= 12 && y >= 24 && y <= 25 && (Math.abs(x + 0.5 - 2.5) < 1.2 || Math.abs(x + 0.5 + 2.5) < 1.2));
  // nose: broad snout, or a giant warty conk
  g.on(CH.skin, () => {
    if (face === 2) {
      g.blob(-0.5, 22.8, 13.6, 2.6, 2.2, 2.3, skin(56));
      g.set(1, 24, 15, WART);
      g.set(-2, 23, 15, WART);
      g.set(0, 22, 15, WART);
      g.set(-1, 24, 16, shade(WART, 1.1));
    } else {
      g.blob(-0.5, 23.2, 13.1, 2, 1.4, 1.4, skin(56));
      g.set(-2, 22, 14, SKIN_DARK);
      g.set(1, 22, 14, SKIN_DARK);
    }
  });
  // reed tuft on a bare head
  if (bare) {
    g.on(CH.cloth, () => {
      g.box(0, 28, 6, 0, 31, 6, REED);
      g.box(-1, 28, 7, -1, 30, 7, shade(REED, 0.85));
      g.box(1, 28, 5, 1, 29, 5, LEAF_LIGHT);
      g.set(-2, 28, 6, LEAF_LIGHT);
    });
  }
  if (face === 3) {
    // cyclops: one big socket and a unibrow
    g.carve((x, y, z) => z >= 11 && y >= 23 && y <= 26 && Math.abs(x + 0.5) < 2.2);
    g.on(CH.cloth, () => g.box(-3, 27, 10, 2, 27, 11, shade(SKIN_DARK, 0.7)));
  }
  if (face === 5) {
    // mossy eyebrows
    g.on(CH.cloth, () => {
      g.box(1, 26, 11, 4, 27, 12, moss);
      g.box(-5, 26, 11, -2, 27, 12, moss);
    });
  }
  if (face === 4) {
    // upper teeth row
    g.on(CH.wet, () => {
      for (let x = -4; x <= 3; x++) g.set(x, 21, 12, x % 2 === 0 ? BONE : BONE_DARK);
    });
  }
  return g;
}

function buildJaw(face: number): RGrid {
  const g = new RGrid(16, 14, 16, -8, 14, 1);
  // underbite: the jaw juts out past the upper lip
  g.on(CH.skin, () => g.blob(-0.5, 20.2, 9.4, 5.9, 2.6, 4.6, skin(61), (x, y, z) => y < 21.8 && z > 3.5));
  // dark lip line along the top front edge
  g.each((c, x, y, z) => (y === 21 && !g.has(x, y + 1, z) && z >= 11 ? shade(SKIN_DARK, 0.7) : undefined), true);
  warts(g, (x, y) => y < 19, 0.12, 62);
  g.on(CH.wet, () => {
    for (let x = -4; x <= 3; x++) for (let z = 5; z <= 10; z++) g.paint(x, 21, z, z > 8 ? 0xc85068 : 0xa83c52);
  });
  const tusk = (x: number, h: number, lean: number) => {
    g.on(CH.wet, () => {
      for (let i = 0; i <= h; i++) {
        const w = i < h - 1 ? 1 : 0;
        g.box(x, 21 + i, 13 + Math.round(lean * i), x + w, 21 + i, 13 + Math.round(lean * i), i > h - 2 ? 0xfffaf0 : i < 1 ? BONE_DARK : BONE);
      }
    });
  };
  switch (face) {
    case 0:
    case 2:
      tusk(3, face === 0 ? 4 : 2, 0.15);
      tusk(-5, face === 0 ? 4 : 2, 0.15);
      break;
    case 1:
      tusk(2, 4, 0.3);
      tusk(-4, 1, 0);
      break;
    case 3:
      tusk(3, 2, 0);
      tusk(-5, 2, 0);
      break;
    case 4:
      g.on(CH.wet, () => {
        for (let x = -5; x <= 4; x++) g.set(x, 22, 13, x % 2 ? BONE : 0xfffaf0);
      });
      tusk(4, 2, 0);
      tusk(-6, 2, 0);
      break;
    case 5:
      // moss beard hanging off the chin
      g.on(CH.cloth, () => {
        g.blob(-0.5, 17.8, 10.6, 4.8, 2.6, 3, moss, (x, y, z) => z > 6);
        g.blob(-0.5, 15.6, 11, 2.6, 1.5, 1.8, moss);
      });
      tusk(3, 2, 0.2);
      tusk(-5, 2, 0.2);
      break;
    default:
      break;
  }
  return g;
}

function buildEyes(face: number): RGrid {
  const g = new RGrid(14, 8, 6, -7, 22, 10);
  if (face === 3) {
    // single big eye: white, amber iris, black pupil
    g.on(CH.wet, () => {
      g.box(-2, 23, 12, 1, 26, 12, 0xf4efe0);
      g.box(-1, 24, 13, 0, 25, 13, 0xe0a030);
      g.set(-1, 24, 14, 0x16120e);
      g.set(0, 25, 14, 0xffffff);
    });
  } else {
    beadEyes(g, 2, 24, 13);
    // amber ring around the beads
    g.on(CH.wet, () => {
      g.set(1, 24, 12, 0xd99a2a);
      g.set(-2, 24, 12, 0xd99a2a);
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
  { hat: true, extra: true, mode: 'bob', spin: 0, extraJoint: [0, 28.5, HC] },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: SK.hatExtra },
  { hat: false, extra: true, mode: 'spin', spin: 0.9, extraJoint: [0, 30, HC] },
];

function headShell(g: RGrid, out: number, inner: number, test: (x: number, y: number, z: number) => boolean, col: ColorFn | number): void {
  g.shell(HEAD_C[0], HEAD_C[1], HEAD_C[2], HEAD_R[0], HEAD_R[1], HEAD_R[2], out, inner, test, col);
}

function buildHat(hat: number, t: TeamCols): { hat: RGrid | null; extra: RGrid | null } {
  const cz = HC;
  const g = new RGrid(28, 16, 26, -14, 22, cz - 13);
  switch (hat) {
    case 1: {
      // toadstool cap
      g.on(CH.cloth, () => {
        g.blob(0, 27, cz, 8.2, 4.4, 8, (x, y, z) => {
          const spot = hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), 71) > 0.72;
          // team-tinted cap so a big red toadstool never reads as the wrong team from above
          return spot && y > 27 ? MUSH_SPOT : shade(mix(t.main, MUSH, 0.2), 0.9 + hashVox(x, y, z, 72) * 0.16 + (y - 27) * 0.03);
        }, (x, y) => y >= 27);
        // gills underneath
        for (let z = cz - 7; z <= cz + 7; z++)
          for (let x = -8; x <= 7; x++) if (Math.hypot(x + 0.5, z + 0.5 - cz) < 7.6 && Math.hypot(x + 0.5, z + 0.5 - cz) > 4.8) g.add(x, 26, z, (x + z) % 2 ? 0xe9d6b4 : 0xd8c39c);
      });
      g.on(CH.rubber, () => {
        // team-coloured band of woven grass round the stem
        for (let z = cz - 6; z <= cz + 6; z++) for (let x = -6; x <= 5; x++) if (Math.abs(Math.hypot(x + 0.5, z + 0.5 - cz) - 5.6) < 0.7) g.add(x, 26, z, t.dark);
      });
      return { hat: g, extra: null };
    }
    case 2: {
      // lily pad with a lotus flower (bobs)
      g.on(CH.wet, () => {
        for (let z = cz - 8; z <= cz + 8; z++)
          for (let x = -9; x <= 8; x++) {
            const dx = x + 0.5;
            const dz = z + 0.5 - cz;
            const d = Math.hypot(dx, dz);
            const notch = dz > 0 && Math.abs(dx) < 1.2;
            if (d <= 7.6 && !notch) g.set(x, 27.6 - (d > 6 ? 0.6 : 0), z, shade(d > 6.6 ? 0x3f7d2c : 0x5a9e3a, 0.9 + hashVox(x, 0, z, 73) * 0.15));
          }
      });
      const f = new RGrid(10, 7, 10, -5, 27, cz - 5);
      f.on(CH.cloth, () => {
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const px = Math.cos(a) * 2.2;
          const pz = cz + Math.sin(a) * 2.2;
          f.box(px, 29, pz, px, 30, pz, i % 2 ? t.light : mix(t.light, 0xffffff, 0.45));
          f.set(px * 1.5, 30.6, cz + (pz - cz) * 1.5, t.light);
        }
        f.box(-1, 29, cz - 1, 0, 29, cz, 0xf6d24a);
        f.set(0, 30, cz, 0xffe680);
      });
      return { hat: g, extra: f };
    }
    case 3: {
      // cartoon beast skull helm
      g.on(CH.wet, () => {
        headShell(g, 1.4, 0, (x, y, z) => y >= 24.5 && !(z > 9 && y < 26.5 && Math.abs(x + 0.5) < 5), (x, y, z) => shade(hashVox(x, y, z, 74) > 0.85 ? BONE_DARK : BONE, 0.95 + hashVox(x, y, z, 75) * 0.08));
        // snout plate and eye holes
        g.box(-3, 26, 12, 2, 27, 13, BONE);
        g.box(-4, 27, 11, -2, 28, 12, 0x2c2622);
        g.box(1, 27, 11, 3, 28, 12, 0x2c2622);
        // horns
        for (const s of [1, -1]) {
          for (let i = 0; i <= 5; i++) g.blob(s * (6 + i * 0.9), 28 + i * 0.7 - (i > 3 ? (i - 3) * 0.6 : 0), cz - 1 + i * 0.3, 1.2 - i * 0.12, 1.2 - i * 0.12, 1.2 - i * 0.12, i > 3 ? 0xfaf3e2 : BONE_DARK);
        }
      });
      g.on(CH.cloth, () => headShell(g, 1.8, 0.6, (x, y, z) => y >= 24 && y <= 24.9 && z < 10, t.main));
      return { hat: g, extra: null };
    }
    case 4: {
      // branching antlers
      const ant: ColorFn = (x, y, z) => shade(hashVox(x, y, z, 76) > 0.5 ? 0x8a6a46 : 0x9c7c56, 0.92 + (y - 26) * 0.02);
      g.on(CH.cloth, () => {
        for (const s of [1, -1]) {
          g.tube(s * 3, 27, cz - 1, s * 7, 31, cz - 2, 0.9, ant);
          g.tube(s * 7, 31, cz - 2, s * 11, 34, cz - 3, 0.7, ant);
          g.tube(s * 6, 30, cz - 2, s * 6.5, 34, cz, 0.6, ant);
          g.tube(s * 9, 32.5, cz - 2.5, s * 9.5, 36, cz - 1, 0.6, ant);
          g.tube(s * 11, 34, cz - 3, s * 12.5, 36.5, cz - 4, 0.6, 0xd8c8a6);
        }
      });
      g.on(CH.cloth, () => headShell(g, 0.9, 0.2, (x, y, z) => y >= 26.6 && y <= 27.6, (x, y, z) => ((x + z) % 3 === 0 ? t.light : t.main)));
      return { hat: g, extra: null };
    }
    case 5: {
      // shaggy moss wig with tiny flowers
      g.on(CH.cloth, () => {
        headShell(g, 1.6, -0.2, (x, y, z) => (y >= 25.5 || z < 5) && !(z > 9 && y < 27), moss);
        for (let z = cz - 7; z <= cz + 1; z++) for (let x = -7; x <= 6; x++) if (Math.hypot(x + 0.5, z + 0.5 - (cz - 1)) < 7) for (let y = 18; y < 23; y++) if (hashVox(x, y, z, 77) > 0.35 && z < cz - 3) g.add(x, y, z, moss(x, y, z));
        g.set(3, 29, 9, 0xf2e86a);
        g.set(-4, 28, 4, t.light);
        g.set(-1, 30, 5, 0xffffff);
        g.set(5, 27, 3, t.light);
      });
      g.carve((x, y, z) => z > 9 && y < 27);
      return { hat: g, extra: null };
    }
    case 6: {
      // turtle shell helmet with hex plates
      g.on(CH.rubber, () => {
        g.blob(0, 25, cz - 0.5, 7.4, 5.6, 7.2, (x, y, z) => {
          const hx = Math.floor((x + 20) / 3);
          const hz = Math.floor((z + 20 + (hx % 2) * 1.5) / 3);
          const edge = (x + 20) % 3 === 0 || (z + 20 + (hx % 2) * 1.5) % 3 < 0.6;
          return edge ? 0x6a5a2a : shade(hashVox(hx, 0, hz, 78) > 0.5 ? 0x4c6b2a : 0x5d7c30, 0.95 + hashVox(x, y, z, 79) * 0.1);
        }, (x, y, z) => y >= 26);
        // rim in team colour
        for (let z = cz - 8; z <= cz + 8; z++) for (let x = -8; x <= 7; x++) if (Math.abs(Math.hypot((x + 0.5) / 7.6, (z + 0.5 - cz + 0.5) / 7.4) - 1) < 0.1) g.set(x, 26, z, t.main);
      });
      return { hat: g, extra: null };
    }
    case 7: {
      // firefly halo: a thin vine ring with glowing bugs, slowly orbiting
      const r = new RGrid(22, 4, 22, -11, 29, cz - 11);
      r.on(CH.cloth, () => {
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * Math.PI * 2;
          r.set(Math.cos(a) * 7.5, 30 + Math.sin(a * 3) * 0.6, cz + Math.sin(a) * 7.5, i % 3 ? VINE : LEAF_LIGHT);
        }
      });
      r.on(CH.pulse, () => {
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2 + 0.3;
          const x = Math.cos(a) * 7.5;
          const z = cz + Math.sin(a) * 7.5;
          r.set(x, 31, z, 0xfff27a);
          r.set(x, 31, z + 1, 0xd8ff6a);
        }
      });
      return { hat: null, extra: r };
    }
    default:
      return { hat: null, extra: null };
  }
}

// ---------------------------------------------------------------------------------------------
// Arms, legs, hook
// ---------------------------------------------------------------------------------------------

function buildUpperArm(accent: number, t: TeamCols): RGrid {
  const g = new RGrid(9, 10, 9, 6, 10, -5);
  const [sx, , sz] = SK.shoulder;
  g.on(CH.skin, () => {
    g.cyl('y', sx, sz, 2.6, 12, 17, skin(81));
    g.blob(sx, 17.2, sz, 3.1, 2.4, 3, skin(82));
  });
  warts(g, () => true, 0.12, 83);
  mossPatch(g, sx + 1, 19, sz - 1, 1.8, 84);
  // woven team armband (reads from the top-down camera)
  g.on(CH.cloth, () => g.cyl('y', sx, sz, 2.95, 14, 15, (x, y, z) => ((x + y + z) % 3 === 0 ? t.light : shade(t.main, 0.95 + hashVox(x, y, z, 86) * 0.08))));
  if (accent === 2) g.repaint((x, y) => Math.abs(y - 15) < 0.6 || Math.abs(y - 13) < 0.6, CH.skin, MUD, true);
  if (accent === 7) g.repaint((x, y, z) => hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), 85) > 0.78, CH.pulse, 0x7ff4e4, true);
  return g;
}

function buildLowerArm(accent: number, t: TeamCols, hookHand: boolean): RGrid {
  const g = new RGrid(11, 11, 11, 5, 1, -5);
  const [hx, hy, hz] = SK.hand;
  const [sx, , sz] = SK.elbow;
  g.on(CH.skin, () => {
    for (let y = 8; y <= 12; y++) g.cyl('y', sx, sz + 0.3, 2.3 + (12 - y) * 0.12, y, y, skin(91));
    // big knuckly fist
    g.blob(hx, hy, hz, 3.1, 2.7, 3.1, skin(92));
  });
  warts(g, (x, y) => y > 8, 0.12, 93);
  // claws on the knuckles
  g.on(CH.wet, () => {
    for (const dx of [-1.5, 0, 1.5]) g.add(hx + dx, hy - 1, hz + 3.2, CLAW);
  });
  // team cloth wrist wrap
  g.on(CH.cloth, () => g.cyl('y', sx, sz + 0.3, 2.95, 8, 9, (x, y, z) => ((x + y + z) % 3 === 0 ? t.light : t.main)));
  if (accent === 5) {
    // vine spiralling round the forearm
    g.on(CH.cloth, () => {
      for (let i = 0; i <= 40; i++) {
        const a = i * 0.42;
        const y = 12.4 - i * 0.11;
        g.set(sx + Math.cos(a) * 2.8, y, sz + 0.3 + Math.sin(a) * 2.8, i % 5 === 0 ? LEAF_LIGHT : VINE);
      }
    });
  }
  if (accent === 2) g.repaint((x, y) => Math.abs(y - 11) < 0.6, CH.skin, MUD, true);
  if (accent === 7) g.repaint((x, y, z) => y > 8 && hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), 94) > 0.8, CH.pulse, 0x7ff4e4, true);
  if (hookHand) {
    g.carve((x, y, z) => Math.abs(x + 0.5 - hx) < 1.01 && Math.abs(z + 0.5 - hz - 0.5) < 1.01 && y >= hy - 4 && y <= hy + 4);
    g.on(CH.skin, () => g.box(Math.floor(hx) - 1, Math.floor(hy) - 1, Math.floor(hz) + 2, Math.floor(hx), Math.floor(hy) + 1, Math.floor(hz) + 2, skin(95)));
  }
  return g;
}

function buildLeg(accent: number): RGrid {
  const g = new RGrid(10, 9, 12, -1, 0, -5);
  const lx = SK.leg[0];
  g.on(CH.skin, () => {
    g.cyl('y', lx, 0, 2.9, 2, 8, skin(101));
    // wide flat foot
    g.blob(lx, 1.2, 1.2, 3.2, 1.6, 3.8, skin(102), (x, y) => y >= 0);
  });
  g.on(CH.wet, () => {
    for (const dx of [-2, 0, 2]) g.add(lx - 0.5 + dx, 0, 5, CLAW);
  });
  warts(g, (x, y) => y > 2, 0.12, 103);
  if (accent === 5) g.on(CH.cloth, () => {
    for (let y = 2; y <= 7; y += 2) g.cyl('y', lx, 0, 3.15, y, y, VINE);
  });
  return g;
}

function buildHook(t: TeamCols): RGrid {
  // gripped in the fist: knob above, shank through the fist, bend below
  const g = new RGrid(10, 16, 11, -5, -11, -4);
  const bone: ColorFn = (x, y, z) => {
    const h = hashVox(x, y, z, 111);
    return shade(h > 0.9 ? BONE_DARK : BONE, 0.94 + h * 0.08 + (z > 0 ? 0.04 : 0));
  };
  g.on(CH.wet, () => {
    g.blob(-0.5, 3.6, -0.5, 1.5, 1.3, 1.4, bone);
    g.box(-1, -5, -1, 0, 3, 0, bone);
    for (let a = 0; a <= 12; a++) {
      const ang = Math.PI + (a / 12) * Math.PI;
      const y = Math.floor(-5.6 + Math.sin(ang) * 2.4);
      const z = Math.floor(1.6 + Math.cos(ang) * 2.4);
      g.box(-1, y, z, 0, y, z, bone);
    }
    g.box(-1, -5, 3, 0, -4, 3, bone);
    g.box(-1, -3, 3, 0, -3, 3, 0xfffaf0);
    g.box(-1, -4, 2, 0, -4, 2, 0xf0e2b8);
  });
  g.on(CH.cloth, () => {
    for (const y of [-3, -4]) for (let x = -2; x <= 1; x++) for (let z = -2; z <= 1; z++) if (x === -2 || x === 1 || z === -2 || z === 1) g.add(x, y, z, VINE);
    g.box(1, -4, 1, 2, -4, 2, LEAF_LIGHT);
  });
  // team clay bead and a feather
  g.on(CH.rubber, () => {
    g.box(1, -6, -1, 2, -5, 0, t.main);
    for (let y = -9; y <= -7; y++) g.set(2, y, -1, y % 2 ? t.light : t.main);
  });
  return g;
}

// ---------------------------------------------------------------------------------------------

/** Dominant colour of each accent option (death debris, portraits). */
const ACCENT_COL = [LEAF_LIGHT, BONE, MUD, 0xd8bf66, 0x5fae3a, VINE, 0xe0c898, 0x6ff0e0] as const;
/** Dominant colour of each hat option (0 = bare head: moss). */
const HAT_COL = [MOSS[1], MUSH, 0x5a9e3a, BONE, 0x8a6a46, MOSS[2], 0x4c6b2a, 0xfff27a] as const;

export function ogrePalette(c: Cosmetics, team: Team): PudgyPalette {
  const n = COSMETIC_NAMES.ogre;
  const t = TEAM_COLORS[team];
  const accent = ACCENT_COL[wrap(c.accent, n.accents.length)];
  const hi = wrap(c.hat, n.hats.length);
  const hat = hi === 1 ? mix(t.main, MUSH, 0.2) : HAT_COL[hi];
  return { skin: SKIN, skinDark: SKIN_DARK, cloth: t.main, accent, metal: BONE, extra: [BELLY, hat, LEAF, t.dark] };
}

export function buildOgre(c: Cosmetics, team: Team): FamilyBuild {
  const n = COSMETIC_NAMES.ogre;
  const hat = wrap(c.hat, n.hats.length);
  const accent = wrap(c.accent, n.accents.length);
  const face = wrap(c.face, n.faces.length);
  const t = TEAM_COLORS[team];
  const k = (s: string) => `ogre:${s}:${team}`;
  const hm = HAT_META[hat];
  const parts: Partial<Record<PartName, PartDef>> = {
    body: part(k(`body${accent}`), () => buildBody(accent, t), SK.body),
    head: part(k(`head${face}.${hat === 0 || hat === 7 ? 1 : 0}`), () => buildHead(face, hat === 0 || hat === 7), SK.neck),
    jaw: part(k(`jaw${face}`), () => buildJaw(face), SK.jaw),
    eyes: part(k(`eyes${face === 3 ? 1 : 0}`), () => buildEyes(face), SK.eyes),
    upperL: part(k(`uarm${accent}`), () => buildUpperArm(accent, t), SK.shoulder),
    upperR: partMirrored(k(`uarm${accent}`) + 'R', () => buildUpperArm(accent, t), SK.shoulder),
    lowerL: part(k(`larm${accent}`), () => buildLowerArm(accent, t, false), SK.elbow),
    lowerR: partMirrored(k(`larm${accent}`) + 'R', () => buildLowerArm(accent, t, true), SK.elbow),
    legL: part(k(`leg${accent === 5 ? 1 : 0}`), () => buildLeg(accent), SK.leg),
    legR: partMirrored(k(`leg${accent === 5 ? 1 : 0}`) + 'R', () => buildLeg(accent), SK.leg),
    hook: part(k('hook'), () => buildHook(t), [0, 0, 0]),
    drop: part('ogre:drop', () => dropGrid(false), [0, 0, 0]),
  };
  if (hm.hat) parts.hat = part(k(`hat${hat}`), () => buildHat(hat, t).hat!, SK.hat);
  if (hm.extra) parts.hatExtra = part(k(`hatx${hat}`), () => buildHat(hat, t).extra!, hm.extraJoint);
  return {
    family: 'ogre',
    sk: { ...SK, hatExtra: hm.extraJoint },
    rest: { armSplay: 0.3, armFwd: -0.2, elbow: -0.25, legSplay: 0.06, hunch: 0.08, headPitch: 0, jawRest: 0.08, holdElbow: -0.95 },
    style: { kind: 'stomp', stride: 2.3, bounce: 0.11, legSwing: 0.62, armSwing: 0.55, roll: 0.16, sway: 0.06, lean: 0.16, stomp: 1, breath: 0.26 },
    hatMode: hm.mode,
    hatSpin: hm.spin,
    parts,
    palette: ogrePalette(c, team),
    scale: 1.02,
    hookDangles: false,
  };
}

