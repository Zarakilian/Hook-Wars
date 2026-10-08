// Harbour Brawler (ref01 default look, ref08 bare base): a barrel-bellied sea dog with a curly
// beard, a red nose, anchor tattoos and Popeye forearms. Bare base: skin, underpants, bare feet.
// Default set: captain cap, cigar, yellow oilskin apron over a green knit jumper, green wellies,
// rope hook. Team colour: a rolled neckerchief with a back flap (head grid, survives every hat)
// and wristbands on both forearms. Never blood: the apron carries rust, grime and paint.
import type { PudgyPalette } from '../../contracts.ts';
import { dropGrid, knit, lumps, part, partMirrored, resOf, ring, teamCloth, type Look, type TeamCols } from './common.ts';
import { buildRes, CH, hashVox, hv, jitter, mix, P, RGrid, shade, type ColorFn } from './grid.ts';
import type { BackMode, FamilyBuild, HatMode, PartDef, PartName, PuffEmitter, Skeleton, V3 } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Palette (sampled from the reference renders)
// ---------------------------------------------------------------------------------------------

const SKIN = 0xe58f68;
const SKIN_D = 0xc8704d;
const SKIN_L = 0xf2a67d;
const ROSY = 0xe2715a;
const NOSE = 0xdc4f3a;
const HAIR = 0x553222;
const HAIR_L = 0x7a5038;
const GREY = 0x9a948e;
const BODYHAIR = 0x6a3e26;
const PANTS = 0xd6d0c4;
const JUMPER = 0x5d6b4a;
const OILSKIN = 0xd9a020;
const LEATHER = 0x3d2819;
const BRASS = 0xd8ac3e;
const TROUSER = 0x4b5139;
const WELLY = 0x56643f;
const SOLE = 0xd6c79c;
const ROPE = 0x6b4a2e;
const IRON = 0x8d939b;
const RUST = 0x8a4a26;
const INK = 0x26262f;
const NAVY = 0x243052;
const CREAM = 0xeee8da;
const WOOD = 0x8a5a32;
const COAT = 0x1f2a4a;
const NET = 0x9a8a62;

/** overall rig scale (metres per skeleton unit = VOX * SCALE) */
const SCALE = 0.9;

const HC: V3 = [0, 28.5, 4.5];
const HR: V3 = [5.7, 5.7, 5.5];

/**
 * Authoring skeleton: every grid below is painted in these coordinates. The rig skeleton (SK) lifts
 * the upper body by UP (longer legs) and the head by HUP more, by moving the joints only: each
 * part is meshed around its authoring joint, so the mesh lands on the lifted rig joint.
 */
const A: Skeleton = {
  core: 15,
  hip: [0, 9, 0],
  leg: [5, 9.5, 0.5],
  body: [0, 15, 2],
  neck: [0, 24, 3],
  shoulder: [12, 23, -0.5],
  elbow: [12.5, 16.5, -0.5],
  hand: [12.5, 6.2, 1.2],
  jaw: [0, 26.5, 6.5],
  eyes: [0, 29.4, 9.2],
  hat: [0, 32, 4.5],
  hatExtra: [0, 37, 4.5],
  back: [0, 19, -9],
  backExtra: [0, 19, -12],
  drop: [5.5, 31, 7],
  top: 35,
};
const UP = 3;
const HUP = 1;
/** hats sit a little higher than authored (the head grew) */
const HAT = 1.2;
const up = (v: V3, k = UP): V3 => [v[0], v[1] + k, v[2]];
const SK: Skeleton = {
  ...A,
  core: A.core + UP,
  hip: up(A.hip),
  leg: up(A.leg),
  body: up(A.body),
  neck: up(A.neck, UP + HUP),
  shoulder: up(A.shoulder),
  elbow: up(A.elbow),
  hand: up(A.hand),
  jaw: up(A.jaw, UP + HUP),
  eyes: up(A.eyes, UP + HUP),
  hat: up(A.hat, UP + HUP + HAT),
  hatExtra: up(A.hatExtra, UP + HUP + HAT),
  back: up(A.back),
  backExtra: up(A.backExtra),
  drop: up(A.drop, UP + HUP),
  top: A.top + UP + HUP + HAT,
};

/** the hook hangs straight down from the fist on its rope (curve facing front) */
const HANG = { pos: [0, -0.02, 0], rot: [Math.PI / 2, 0, 0] } as const;
/** harpoons: gripped in the fist, pointing forward and a little down */
const GRIP = { pos: [0, 0.03, 0.03], rot: [1.3, 0, Math.PI / 2] } as const;

const slug = (id: string | undefined): string => (id ? id.slice(id.indexOf('.') + 1) : '');

// ---------------------------------------------------------------------------------------------
// Paints
// ---------------------------------------------------------------------------------------------

/** Sun-burnt skin with freckles and (optionally) body hair clumps. */
function skin(seed: number, hairy = 0): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed);
    if (hairy > 0) {
      const clump = hashVox(Math.floor(x / 3), Math.floor(y / 3), Math.floor(z / 3), seed + 7);
      if (h < hairy * (0.45 + clump * 0.9)) return shade(BODYHAIR, 0.8 + hv(x, y, z, seed + 9) * 0.35);
    }
    const base = h > 0.9 ? SKIN_L : h < 0.12 ? SKIN_D : h < 0.17 ? ROSY : SKIN;
    return shade(base, 0.95 + (h - 0.5) * 0.08);
  };
}

/** Curly beard / hair: dark brown with lighter curls and grey strands. */
function curls(seed: number, grey = 0): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed);
    const c = hashVox(x, Math.floor(y / 2), z, seed + 3);
    if (grey > 0 && c < grey) return shade(GREY, 0.85 + h * 0.3);
    return shade(c > 0.7 ? HAIR_L : HAIR, 0.78 + h * 0.36);
  };
}

const oilskin = (seed: number): ColorFn => (x, y, z) => {
  const h = hv(x, y, z, seed);
  // grime blots, rust and paint stains (never blood), wet highlights
  const blot = hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), seed + 1);
  if (blot > 0.93) return mix(OILSKIN, RUST, 0.3 + h * 0.25);
  if (blot < 0.06) return mix(OILSKIN, 0x6b5a2a, 0.3 + h * 0.2);
  if (h > 0.96) return 0xf6dc7a;
  return shade(OILSKIN, 0.86 + h * 0.2 + (y - 10) * 0.006);
};

const leather: ColorFn = (x, y, z) => shade(LEATHER, 0.85 + hv(x, y, z, 15) * 0.3);
const ropeCol: ColorFn = (x, y, z) => ((x + y + z) % 2 === 0 ? shade(ROPE, 1.08) : shade(ROPE, 0.8 + hv(x, y, z, 4) * 0.15));
const rustyIron = (seed: number): ColorFn => (x, y, z) => {
  const h = hv(x, y, z, seed);
  const b = hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), seed + 2);
  if (b > 0.72) return shade(RUST, 0.8 + h * 0.4);
  return shade(IRON, 0.82 + h * 0.3);
};
const stripes: ColorFn = (x, y, z) => {
  const h = hv(x, y, z, 21);
  return Math.floor(y + 100) % 3 === 0 ? shade(NAVY, 0.9 + h * 0.15) : shade(CREAM, 0.93 + h * 0.08);
};
const coatCol: ColorFn = (x, y, z) => shade(COAT, 0.88 + hv(x, y, z, 41) * 0.18);

// ---------------------------------------------------------------------------------------------
// Body: belly, chest, shoulders + outfit (body slot)
// ---------------------------------------------------------------------------------------------

const BELLY_C: V3 = [0, 15, 2.6];
const BELLY_R: V3 = [11.5, 9.5, 12];
const CHEST_C: V3 = [0, 21, 0];
const CHEST_R: V3 = [10.5, 5.5, 8.5];

function torsoShape(g: RGrid, paint: ColorFn): void {
  g.blob(BELLY_C[0], BELLY_C[1], BELLY_C[2], BELLY_R[0], BELLY_R[1], BELLY_R[2], paint);
  g.blob(CHEST_C[0], CHEST_C[1], CHEST_C[2], CHEST_R[0], CHEST_R[1], CHEST_R[2], paint);
  // trapezius hump the small head sinks into
  g.blob(0, 24.2, -1.5, 8.4, 2.8, 6, paint);
  // hips / seat under the belly
  g.blob(0, 9.5, -1, 9, 4, 8, paint);
}

/** Trousers on the seat and hips (the visible part under any top). */
function trousers(g: RGrid, col: number): void {
  g.repaint((x, y) => y <= 10, CH.cloth, jitter(col, 0.08, 17), true);
  g.on(CH.cloth, () => g.blob(0, 6.5, 2, 4.5, 2.6, 5, jitter(col, 0.08, 18)));
}

function buildBody(l: Look): RGrid {
  const g = buildOutfit(l);
  neckerchief(g, l.t);
  return g;
}

/**
 * Team neckerchief, worn with every outfit: a fat roll on the shoulders round the neck, a knot at
 * the front left beside the beard and a sailor flap down the back (reads from the gameplay camera).
 */
function neckerchief(g: RGrid, t: TeamCols): void {
  const nk = teamCloth(t, 30);
  const backZ = (y: number) => {
    const c = Math.sqrt(Math.max(0, 1 - ((y - CHEST_C[1]) / CHEST_R[1]) ** 2)) * CHEST_R[2];
    const tr = 1.5 + Math.sqrt(Math.max(0, 1 - ((y - 24.2) / 2.8) ** 2)) * 6;
    const b = Math.sqrt(Math.max(0, 1 - ((y - BELLY_C[1]) / BELLY_R[1]) ** 2)) * BELLY_R[2] - BELLY_C[2];
    return -Math.max(c, tr, b);
  };
  // sailor collar: the shawl lies over the shoulder tops, so it shows round any hat from above
  g.repaint((x, y, z) => {
    const d = Math.hypot(x + 0.5, z + 0.5 - 1);
    return y >= 22 && d >= 4.5 && d <= 10.6 - Math.max(0, z - 4) * 0.5 && !(z > 5 && Math.abs(x + 0.5) < 5.5);
  }, CH.cloth, nk, true);
  g.on(CH.cloth, () => {
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const back = Math.cos(a) < 0 ? -Math.cos(a) : 0;
      g.blob(Math.sin(a) * 6.8, 26.6 + back * 0.6 - Math.max(0, Math.cos(a)) * 1.2, 2 + Math.cos(a) * 6, 1.8, 1.4, 1.8, nk);
    }
    // back flap on the back surface
    for (let y = 19; y <= 26; y++) {
      const w = 6.2 - (26 - y) * 0.85;
      const zb = backZ(y + 0.5);
      for (let x = Math.floor(-w); x <= Math.ceil(w) - 1; x++) {
        g.put(x, y, zb - 0.6, nk);
        g.put(x, y, zb + 0.4, nk);
      }
    }
    // knot and tails at the front left
    g.blob(5.4, 25.2, 7.8, 1.7, 1.6, 1.5, nk);
    g.blob(5.9, 22.8, 8.9, 1.1, 1.8, 0.9, nk);
    g.blob(4.6, 22.4, 9.2, 0.9, 1.6, 0.9, nk);
  });
  g.repaint((x, y, z) => y <= 20 && z < -5, CH.cloth, (x, y, z) => shade(t.dark, 1 + hv(x, y, z, 31) * 0.1), true);
}

function buildOutfit(l: Look): RGrid {
  const g = new RGrid(28, 28, 28, -14, 2, -13);
  const body = slug(l.body);
  const t = l.t;
  g.on(CH.skin, () => torsoShape(g, skin(3, 0)));

  if (!body) {
    // bare: hairy chest and a treasure trail, belly button, back hair, underpants
    g.repaint((x, y, z) => z > 2 && y > 15 && y < 24 && Math.abs(x + 0.5) < 8 - (y - 15) * 0.25, CH.skin, skin(5, 0.42), true);
    g.repaint((x, y, z) => z > 6 && y > 9 && y <= 16 && Math.abs(x + 0.5) < 1.6, CH.skin, skin(6, 0.5), true);
    g.repaint((x, y, z) => z < -4 && y > 12 && y < 25 && Math.abs(x + 0.5) < 3 - Math.abs(y - 19) * 0.12, CH.skin, skin(7, 0.45), true);
    g.repaint((x, y, z) => z > 4 && y >= 20 && y <= 21 && Math.abs(Math.abs(x + 0.5) - 5) < 0.8, CH.skin, shade(ROSY, 0.85), true);
    g.carveP((px, py, pz) => Math.hypot(px, py - 12.5, pz - 13) < 0.9);
    // underpants: a snug band round the hips and seat
    g.on(CH.cloth, () => {
      g.shell(0, 9.5, -1, 9, 4, 8, 0.7, 0.3, (x, y) => y <= 11, jitter(PANTS, 0.06, 8));
      g.shell(BELLY_C[0], BELLY_C[1], BELLY_C[2], BELLY_R[0], BELLY_R[1], BELLY_R[2], 0.7, 0.4, (x, y) => y <= 8, jitter(PANTS, 0.06, 9));
      g.blob(0, 6.5, 2, 4.5, 2.6, 5, jitter(PANTS, 0.06, 10));
    });
    g.repaint((x, y) => y === 11, CH.cloth, shade(PANTS, 0.86), true);
    return g;
  }

  if (body === 'oilskin_apron') {
    // green knit jumper under everything
    g.repaint(() => true, CH.cloth, knit(JUMPER, 11), true);
    g.on(CH.cloth, () => ring(g, 0, 2.5, 4.5, 6.6, 24, 25, knit(shade(JUMPER, 0.86), 12)));
    trousers(g, TROUSER);
    // yellow oilskin apron: bib on the chest, skirt over the belly down to the knees
    const ap = oilskin(13);
    const half = (y: number) => (y > 19 ? 6 : y > 17 ? 8 : 10);
    g.on(CH.rubber, () => {
      g.shell(BELLY_C[0], BELLY_C[1], BELLY_C[2], BELLY_R[0], BELLY_R[1], BELLY_R[2], 0.9, 0.2, (x, y, z) => z > 0.5 && y >= 5 && Math.abs(x + 0.5) < half(y), ap);
      g.shell(CHEST_C[0], CHEST_C[1], CHEST_C[2], CHEST_R[0], CHEST_R[1], CHEST_R[2], 0.9, 0.2, (x, y, z) => z > 3 && y >= 18 && y <= 24.5 && Math.abs(x + 0.5) < 6, ap);
      // skirt hanging below the belly, in front of the thighs
      for (let y = 3; y <= 7; y++)
        for (let x = -9; x <= 8; x++) {
          const zf = 2 + Math.sqrt(Math.max(0, 1 - ((x + 0.5) / 12.2) ** 2)) * 9.2 - (7 - y) * 0.25;
          g.add(x, y, Math.floor(zf), ap);
          g.add(x, y, Math.floor(zf) - 1, ap);
        }
    });
    // team piping on the hem and bib top
    g.repaint((x, y, z) => y <= 3 && z > 0, CH.rubber, teamCloth(t, 14), true);
    g.repaint((x, y, z) => y >= 24 && z > 3 && Math.abs(x + 0.5) < 6, CH.rubber, teamCloth(t, 15), true);
    // pocket seam
    g.repaint((x, y, z) => z > 9 && y === 12 && Math.abs(x + 0.5) < 4.5, CH.rubber, shade(OILSKIN, 0.72), true);
    if (buildRes() > 1) {
      // showcase trims: running stitches along the hem, the bib edge and the pocket
      const stitch = (px: number) => Math.floor(px * 2 + 100) % 2 === 0;
      g.repaint(() => Math.abs(P.y - 4.25) < 0.26 && P.z > 1 && stitch(P.x), CH.rubber, 0x8a6418, true);
      g.repaint(() => Math.abs(P.y - 11.25) < 0.26 && P.z > 9 && Math.abs(P.x) < 4.5 && stitch(P.x), CH.rubber, 0x8a6418, true);
      g.repaint(() => P.y > 18 && P.z > 3 && Math.abs(Math.abs(P.x) - 5.25) < 0.26 && stitch(P.y), CH.rubber, 0x8a6418, true);
    }
    // leather straps over the shoulders, crossing on the back, a belt round the middle
    g.repaint((x, y, z) => y >= 22 && Math.abs(Math.abs(x + 0.5) - 5.2) < 1.1 && z > -6, CH.skin, leather, true);
    g.repaint((x, y, z) => z < -3 && y >= 11 && y <= 25 && Math.abs(Math.abs(x + 0.5) - (5.4 * (y - 11)) / 14) < 1.1, CH.skin, leather, true);
    g.repaint((x, y, z) => y >= 13 && y <= 14 && z <= 1, CH.skin, leather, true);
    g.on(CH.brass, () => {
      for (const bx of [4, -6]) {
        g.box(bx, 23, 9, bx + 1, 24, 9, BRASS);
        g.set(bx, 23, 10, shade(BRASS, 0.75));
      }
      g.box(10, 13, -2, 10, 14, 0, BRASS);
      g.box(-11, 13, -2, -11, 14, 0, BRASS);
    });
    return g;
  }

  if (body === 'striped_shirt') {
    g.repaint(() => true, CH.cloth, stripes, true);
    g.on(CH.cloth, () => ring(g, 0, 2.5, 4.5, 6.4, 24, 24, shade(NAVY, 0.9)));
    trousers(g, 0x2c3346);
    g.repaint((x, y) => y >= 9 && y <= 10, CH.cloth, ropeCol, true);
    g.on(CH.cloth, () => {
      g.blob(4, 9, 12.4, 1.3, 1.3, 1, ropeCol);
      g.box(4, 6, 12, 4, 8, 12, ropeCol);
      g.box(5, 6, 12, 5, 7, 12, ropeCol);
    });
    return g;
  }

  if (body === 'net_cape') {
    // cream undershirt with a long coat knotted from old nets, corks along the hem and collar
    g.repaint(() => true, CH.cloth, jitter(0xd8ccb0, 0.06, 31), true);
    trousers(g, 0x3e3a34);
    const net = (x: number, y: number, z: number) => (x + y + 300) % 3 === 0 || (x - y + 300) % 3 === 0 || (z + y + 300) % 3 === 0;
    const netCol: ColorFn = (x, y, z) => shade(NET, 0.82 + hv(x, y, z, 32) * 0.3);
    g.on(CH.cloth, () => {
      g.shell(BELLY_C[0], BELLY_C[1], BELLY_C[2], BELLY_R[0], BELLY_R[1], BELLY_R[2], 1.4, 0.4, (x, y, z) => !(z > 4 && Math.abs(x + 0.5) < 4.5) && net(x, y, z), netCol);
      g.shell(CHEST_C[0], CHEST_C[1], CHEST_C[2], CHEST_R[0], CHEST_R[1], CHEST_R[2], 1.4, 0.4, (x, y, z) => !(z > 4 && Math.abs(x + 0.5) < 3.5) && net(x, y, z), netCol);
      // coat tails down the back to the knees
      for (let y = 2; y <= 8; y++)
        for (let x = -11; x <= 10; x++) {
          const zb = -1 - Math.sqrt(Math.max(0, 1 - ((x + 0.5) / 11.5) ** 2)) * 8.6;
          for (let k = 0; k <= 2; k++) if (net(x, y, k) || y === 2) g.add(x, y, Math.floor(zb) + k, netCol);
        }
      ring(g, 0, -0.5, 5, 8.2, 24, 25, (x, y, z) => (net(x, y, z) ? netCol(x, y, z) : shade(0x7d6e4a, 0.9)));
    });
    g.on(CH.cloth, () => {
      const cork = (cx: number, cy: number, cz: number) =>
        g.blob(cx, cy, cz, 1.2, 1.4, 1.2, (x, y, z) => shade(hashVox(x, y, z, 3) > 0.5 ? 0xc9a066 : 0xb08450, 0.9 + hv(x, y, z, 33) * 0.2));
      for (let i = -3; i <= 3; i++) {
        const a = (i / 3.5) * 1.4;
        cork(Math.sin(a) * 11, 2.6, -1 - Math.cos(a) * 8);
      }
      cork(6.4, 24.5, 4);
      cork(-6.4, 24.5, 4);
      cork(10.5, 15, 5);
      cork(-11, 15, 4.5);
    });
    return g;
  }

  if (body === 'admiral_coat') {
    // navy double-breasted coat, gold braid, brass buttons, white trousers, team sash (rank)
    g.repaint(() => true, CH.cloth, coatCol, true);
    trousers(g, 0xe8e4da);
    g.repaint((x, y, z) => z > 4 && y >= 17 && Math.abs(x + 0.5) < 1 + (y - 17) * 0.45, CH.cloth, jitter(0xf2efe6, 0.04, 42), true);
    g.repaint((x, y, z) => z > 4 && y >= 16 && Math.abs(Math.abs(x + 0.5) - (1.3 + (y - 17) * 0.45)) < 0.6, CH.brass, BRASS, true);
    g.repaint((x, y) => y >= 6 && y < 7, CH.brass, shade(BRASS, 0.92), true);
    g.repaint((x, y, z) => Math.abs(y - (13 + (x + 0.5) * 0.55)) < 1.3 && z > -12, CH.cloth, teamCloth(t, 43), true);
    g.on(CH.brass, () => {
      for (const sx of [-1, 1])
        for (let y = 8; y <= 17; y += 3) {
          const x = sx * 4;
          const zz = 2 + Math.sqrt(Math.max(0, 1 - (x / 11.5) ** 2 - ((y - 15) / 9.5) ** 2)) * 11;
          g.blob(x, y + 0.5, zz + 0.2, 0.75, 0.75, 0.75, shade(BRASS, 1.1));
        }
    });
    return g;
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Head (face slot, neckerchief, hair), jaw (beard), eyes
// ---------------------------------------------------------------------------------------------

function buildHead(l: Look): RGrid {
  const g = new RGrid(20, 18, 20, -10, 16, -5);
  const [cx, cy, cz] = HC;
  const [rx, ry, rz] = HR;
  const face = slug(l.face);
  const hatted = !!l.head;
  g.on(CH.skin, () => {
    g.blob(cx, cy, cz, rx, ry, rz, skin(21));
    // heavy jowls and a thick neck
    g.blob(0, 26, cz + 0.5, 5.4, 3.2, 4.8, skin(22));
    g.blob(0, 24.5, 2.5, 5.2, 2.5, 4.5, skin(22));
    for (const sx of [1, -1]) g.blob(sx * 5.7, 28.6, 3.6, 1.2, 1.9, 1.5, (x, y, z) => (hv(x, y, z, 23) > 0.5 ? ROSY : shade(SKIN, 0.95)));
  });
  g.repaint((x, y, z) => z > cz + 3 && y >= 27 && y <= 28 && Math.abs(Math.abs(x + 0.5) - 3.6) < 1.3, CH.skin, ROSY, true);
  // mouth: the jaw part fills the cavity
  g.carve((x, y, z) => y < 26.5 && z > cz + 1 && Math.abs(x + 0.5) < 4.6 && y > 21);
  g.on(CH.wet, () => {
    for (let x = -4; x <= 3; x++) for (let z = 6; z <= 9; z++) g.add(x, 26, z, 0x3a1214);
  });
  // eye sockets for the bead eyes
  g.carve((x, y, z) => z >= cz + 4 && y === 29 && Math.abs(Math.abs(x + 0.5) - 2) < 0.9);
  // big red potato nose
  g.on(CH.skin, () => {
    g.blob(0, 27.9, cz + 5.6, 1.9, 1.7, 1.7, (x, y, z) => (y >= 28 && z >= cz + 6 ? shade(NOSE, 1.1) : shade(NOSE, 0.92 + hv(x, y, z, 24) * 0.12)));
    g.blob(0, 29.3, cz + 5, 0.9, 1, 0.9, skin(25));
  });
  // heavy frowning brows
  const brow: ColorFn = (x, y, z) => shade(0x34201a, 0.85 + hv(x, y, z, 26) * 0.25);
  g.on(CH.cloth, () => {
    for (const sx of [1, -1]) {
      g.tube(sx * 1.1, 30.9, cz + 5.3, sx * 4.3, 31.6, cz + 4.5, 0.55, brow);
    }
  });
  // moustache and sideburns (static, the beard is on the jaw)
  const beard = curls(27, 0.12);
  g.on(CH.cloth, () => {
    g.blob(-2.2, 26.7, cz + 4.9, 2.6, 1.2, 1.4, beard);
    g.blob(2.2, 26.7, cz + 4.9, 2.6, 1.2, 1.4, beard);
    for (const sx of [1, -1]) g.blob(sx * 5.2, 26.2, cz + 0.5, 1, 2.2, 2, beard);
  });
  // curly hair round the back and sides, a mop on top when bare-headed
  const hair = curls(28);
  g.on(CH.cloth, () => {
    g.shell(cx, cy, cz, rx, ry, rz, 1, 0.4, (x, y, z) => (z < cz - 0.5 && y >= 25) || (Math.abs(x + 0.5) > 4.6 && y >= 29 && z < cz + 2), hair);
    lumps(g, cx, cy, cz, rx, ry, rz, hatted ? 10 : 22, 29, 0.9, 1.6, (nx, ny, nz) => (nz < -0.2 && ny > -0.6) || (Math.abs(nx) > 0.7 && ny > 0.1 && nz < 0.3) || (!hatted && ny > 0.45 && nz < 0.25), hair, -0.1);
    if (!hatted) {
      g.shell(cx, cy + 0.4, cz, rx, ry, rz, 1.3, 0.3, (x, y, z) => y >= 31.5 && z < cz + 1.5 - (Math.abs(x + 0.5) < 2 ? 0 : 0.8), hair);
      g.blob(1.5, 33.9, cz + 1, 2.4, 1.5, 2, hair);
      g.blob(-2, 33.7, cz - 0.5, 2.3, 1.5, 2.2, hair);
      // a curl falling on the forehead
      g.blob(-1, 32.6, cz + 4.2, 1, 1, 0.9, hair);
    }
  });

  switch (face) {
    case 'cigar': {
      // fat cigar in the left mouth corner, pointing out and slightly up
      g.on(CH.skin, () => g.tube(2.6, 26.1, cz + 4.6, 6.4, 26.9, cz + 8.4, 0.85, (x, y, z) => shade(0x6e3f22, 0.85 + hv(x, y, z, 32) * 0.3)));
      g.on(CH.cloth, () => {
        g.blob(3.8, 26.4, cz + 5.9, 0.95, 0.95, 0.95, (x, y, z) => (hv(x, y, z, 33) > 0.5 ? 0xc9a23a : 0x9a2a22));
        g.dot(6.7, 27, cz + 8.7, 0x8a8580);
      });
      g.on(CH.pulse, () => {
        g.dot(6.9, 27.1, cz + 8.9, 0xff6a1f);
        g.dot(6.6, 26.8, cz + 9, 0xff8a2a);
      });
      break;
    }
    case 'pipe': {
      // corncob pipe: stem from the right corner, bowl standing up in front of the beard
      g.on(CH.skin, () => g.tube(-2.6, 25.9, cz + 4.8, -5, 25, cz + 8.4, 0.6, 0x3a2a1e));
      g.on(CH.cloth, () => g.cyl('y', -5.6, cz + 8.9, 1.5, 25, 28, (x, y, z) => shade(hashVox(x, y, z, 34) > 0.45 ? 0xd9b46a : 0xb88a44, 0.9 + hv(x, y, z, 35) * 0.15)));
      g.on(CH.pulse, () => {
        g.dot(-5.6, 28.6, cz + 8.9, 0xff7a2a);
        g.dot(-5.2, 28.6, cz + 9.3, 0xffa040);
      });
      break;
    }
    case 'eyepatch': {
      // patch over the left eye, strap across the head, an old healed scar under it
      g.on(CH.skin, () => g.blob(2.6, 29.6, cz + 5, 1.8, 1.7, 0.9, (x, y, z) => shade(0x1d1b1f, 0.9 + hv(x, y, z, 36) * 0.2)));
      g.repaint((x, y, z) => Math.abs(y - (30 + (x - 2.5) * 0.7)) < 0.9 && (z < cz + 4 || x > 4) && x > -6 && y > 28, CH.skin, 0x2a272b, true);
      g.repaint((x, y, z) => z > cz + 3 && y >= 26.5 && y < 28 && Math.abs(x + 0.5 - 3.8) < 0.6, CH.skin, shade(ROSY, 1.1), true);
      break;
    }
    default:
      break;
  }
  return g;
}

function buildJaw(): RGrid {
  const g = new RGrid(16, 13, 14, -8, 16, -1);
  const beard = curls(41, 0.08);
  g.on(CH.skin, () => g.blob(0, 25.5, HC[2] + 2, 4.4, 1.6, 3.6, skin(42), (x, y, z) => y < 26.5 && z > HC[2] - 1));
  g.on(CH.wet, () => {
    for (let x = -3; x <= 2; x++) for (let z = 6; z <= 8; z++) g.paint(x, 26, z, z === 8 ? 0xb04a4a : 0x8a2e34);
  });
  g.on(CH.cloth, () => {
    // big bushy beard spilling onto the chest
    g.blob(0, 23.6, HC[2] + 3, 5.8, 3.8, 4.2, beard, (x, y, z) => y < 26.3 && (z > HC[2] + 0.5 || y < 23));
    g.blob(0, 21.2, HC[2] + 5.2, 4.4, 2.8, 3, beard);
    g.blob(0, 19.4, HC[2] + 6, 2.6, 1.8, 2, beard);
    lumps(g, 0, 22.5, HC[2] + 4, 5.2, 4.2, 3.8, 16, 43, 0.8, 1.3, (nx, ny, nz) => nz > -0.1 && ny < 0.5, beard, -0.2);
  });
  // grey patch on the chin (ref)
  g.repaint((x, y, z) => z >= HC[2] + 5 && y >= 20 && y <= 24 && Math.abs(x + 0.5) < 2.6 && hv(x, y, z, 44) > 0.62, CH.cloth, (x, y, z) => shade(GREY, 0.85 + hv(x, y, z, 45) * 0.3), true);
  return g;
}

function buildEyes(one: boolean): RGrid {
  const g = new RGrid(10, 4, 4, -5, 28, 7);
  const eye = (sx: number) => {
    const x0 = sx > 0 ? 2 : -3;
    const xi = sx > 0 ? 1 : -2;
    g.on(CH.wet, () => {
      g.set(xi, 29, 9, 0x140f0d);
      g.set(xi, 29, 8, 0x140f0d);
      g.set(x0, 29, 8, 0x2a1f1a);
      if (buildRes() > 1) {
        g.dot(x0 + 0.25 + (sx > 0 ? 0.5 : 0), 29.75, 9.75, 0xd8d0c4);
        g.dot(xi + 0.75 - (sx > 0 ? 0 : 0.5), 29.75, 9.75, 0xffffff);
      }
    });
  };
  if (!one) eye(1);
  eye(-1);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Hats (head slot)
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
    case 'captain_cap':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: A.hatExtra, top: 37.5 };
    case 'souwester':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: A.hatExtra, top: 36 };
    case 'bobble_beanie':
      return { hat: true, extra: true, mode: 'bob', spin: 0, extraJoint: [0, 36, cz], top: 40 };
    case 'tricorn':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: A.hatExtra, top: 38 };
    case 'lighthouse_helm':
      return { hat: true, extra: true, mode: 'spin', spin: 2.4, extraJoint: [0, 40, cz], top: 45 };
    default:
      return { hat: false, extra: false, mode: 'none', spin: 0, extraJoint: A.hatExtra, top: 35 };
  }
}

function buildHat(id: string): RGrid {
  const cz = HC[2];
  const g = new RGrid(24, 18, 26, -12, 27, cz - 12);
  switch (id) {
    case 'captain_cap': {
      // white crown puffing out over a black band, glossy black peak, gold anchor badge
      const white: ColorFn = (x, y, z) => shade((x + z + 200) % 2 === 0 ? 0xf3f0e8 : 0xe6e2d6, 0.95 + hv(x, y, z, 51) * 0.07);
      g.on(CH.cloth, () => {
        g.cyl('y', 0, cz, 6.1, 32, 34, white);
        g.blob(0, 35.2, cz + 0.8, 7.2, 1.9, 7.2, white);
        g.blob(0, 35.9, cz + 0.6, 6, 1.6, 6, white);
      });
      g.on(CH.rubber, () => {
        g.cyl('y', 0, cz, 6.35, 31, 32, (x, y, z) => shade(0x1d1f24, 0.9 + hv(x, y, z, 52) * 0.15));
        g.cyl('y', 0, cz + 2.4, 6.2, 30, 30, (x, y, z) => shade(0x15171b, 0.9 + hv(x, y, z, 53) * 0.12), 7.8, (x, y, z) => z > cz + 3.4);
      });
      g.on(CH.brass, () => {
        // anchor: ring, shank, stock and curved arms, standing proud of the crown front
        const z = cz + 6.2;
        const fine = buildRes() > 1;
        const gold: ColorFn = (x, y, zz) => shade(BRASS, 0.92 + hv(x, y, zz, 54) * 0.18);
        if (fine) {
          g.fineLine(0, 33, z + 0.4, 0, 36.2, z + 0.4, gold);
          g.fineLine(-1.2, 35.4, z + 0.4, 1.2, 35.4, z + 0.4, gold);
          for (let a = 0; a <= 10; a++) {
            const ang = Math.PI * (a / 10);
            g.dot(Math.cos(ang) * 1.5, 33.6 - Math.sin(ang) * 0.9, z + 0.4, gold);
          }
          g.dot(-1.6, 34, z + 0.4, gold);
          g.dot(1.6, 34, z + 0.4, gold);
          g.dot(0, 36.6, z + 0.4, gold);
        } else {
          g.box(0, 33, Math.floor(z), 0, 35, Math.floor(z), BRASS);
          g.set(-1, 34, Math.floor(z), BRASS);
          g.set(1, 34, Math.floor(z), BRASS);
          g.set(-1, 33, Math.floor(z), BRASS);
          g.set(1, 33, Math.floor(z), BRASS);
        }
        // braid over the peak
        g.box(-4, 31, Math.floor(cz + 6.3), 3, 31, Math.floor(cz + 6.3), shade(BRASS, 0.85));
      });
      return g;
    }
    case 'souwester': {
      const c: ColorFn = (x, y, z) => shade(0xe6b52a, 0.88 + hv(x, y, z, 54) * 0.18);
      g.on(CH.rubber, () => {
        g.blob(0, 31, cz, 6.5, 4.4, 6.4, c, (x, y) => y >= 31);
        for (let z = cz - 12; z <= cz + 11; z++)
          for (let x = -11; x <= 10; x++) {
            const dz = z + 0.5 - cz;
            const dx = x + 0.5;
            const d = Math.hypot(dx, dz * (dz < 0 ? 0.62 : 1.15));
            if (d <= 8.8 && d > 5.8) g.put(x, 31 - Math.max(0, -dz) * 0.42, z, shade(0xd8a420, 0.9 + hv(x, 0, z, 55) * 0.14));
          }
        ring(g, 0, cz, 5.9, 6.7, 31, 31, 0xb8861a);
      });
      g.on(CH.cloth, () => {
        g.box(5, 28, cz + 2, 5, 30, cz + 2, 0x6b5020);
        g.box(-6, 28, cz + 2, -6, 30, cz + 2, 0x6b5020);
      });
      return g;
    }
    case 'bobble_beanie': {
      const k: ColorFn = (x, y, z) => {
        const band = Math.floor(y) % 4 === 1;
        return shade(band ? 0xe7dcc4 : (x + 100) % 2 === 0 ? 0x3c3f46 : 0x33363c, 0.94 + hv(x, y, z, 56) * 0.1);
      };
      g.on(CH.cloth, () => {
        g.blob(0, 31, cz, 6.4, 5.4, 6.3, k, (x, y) => y >= 31);
        ring(g, 0, cz, 5.6, 7, 30, 32, (x, y, z) => shade((x + z + 100) % 2 === 0 ? 0x4a4e57 : 0x3b3e46, 0.95 + hv(x, y, z, 57) * 0.08));
      });
      return g;
    }
    case 'tricorn': {
      const felt: ColorFn = (x, y, z) => shade(0x2a2526, 0.85 + hv(x, y, z, 61) * 0.25);
      g.on(CH.cloth, () => {
        g.blob(0, 31, cz, 6.6, 4, 6.4, felt, (x, y) => y >= 31);
        for (let z = cz - 11; z <= cz + 11; z++)
          for (let x = -11; x <= 10; x++) {
            const dx = x + 0.5;
            const dz = z + 0.5 - cz;
            const a = Math.atan2(dz, dx);
            const r = Math.hypot(dx, dz);
            const tri = 9 + 1.8 * Math.cos(3 * (a - Math.PI / 2));
            if (r <= tri && r > 5.6) {
              const up = (r - 5.6) * 0.6;
              const edge = r > tri - 1;
              if (hashVox(x, 0, z, 62) > 0.93 && edge) continue;
              g.on(edge ? CH.brass : CH.cloth, () => g.put(x, 31 + up, z, edge ? shade(BRASS, 0.85 + hv(x, 0, z, 63) * 0.2) : felt(x, 31, z)));
              g.put(x, 30 + up, z, shade(0x221e1f, 0.9));
            }
          }
        // cream rosette and a feather
        g.blob(4, 34.5, cz + 5.4, 1.4, 1.4, 0.8, 0xeee6d2);
        g.tube(-4, 34, cz - 3, -8, 38, cz - 6, 0.6, 0xe9e2d0);
      });
      return g;
    }
    case 'lighthouse_helm': {
      g.on(CH.rubber, () => {
        for (let y = 30; y <= 37; y++) ring(g, 0, cz, 0, 5.6 - (y - 30) * 0.3, y, y, (x, yy, z) => shade(Math.floor((yy - 30) / 2) % 2 === 0 ? 0xf3efe6 : 0x26303c, 0.94 + hv(x, yy, z, 64) * 0.08));
        g.box(-1, 30, cz + 5, 0, 32, cz + 5, 0x5a3a22);
      });
      g.on(CH.iron, () => {
        ring(g, 0, cz, 0, 4.6, 38, 38, 0x2e333a);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          g.put(Math.cos(a) * 4.2, 39, cz + Math.sin(a) * 4.2, 0x3a4048);
        }
        g.cyl('y', 0, cz, 2.8, 42, 42, 0x2e5a4e);
        g.cyl('y', 0, cz, 1.6, 43, 43, 0x2e5a4e);
        g.put(0, 44, cz, 0x2e5a4e);
      });
      g.on(CH.glow, () => g.cyl('y', 0, cz, 2, 39, 41, 0xfff0b0));
      return g;
    }
    default:
      return g;
  }
}

function buildHatExtra(id: string): RGrid {
  const cz = HC[2];
  if (id === 'bobble_beanie') {
    const p = new RGrid(8, 8, 8, -4, 34, cz - 4);
    p.on(CH.cloth, () => p.blob(0, 37.8, cz, 2.5, 2.3, 2.5, (x, y, z) => shade(hv(x, y, z, 58) > 0.4 ? 0xf2ebdc : 0xd8ccb4, 0.95 + hv(x, y, z, 59) * 0.08)));
    return p;
  }
  // lighthouse shutter blades round the lamp
  const sh = new RGrid(8, 4, 8, -4, 39, cz - 4);
  sh.on(CH.iron, () => {
    sh.box(-3, 39, cz - 1, -3, 41, cz, 0x22272e);
    sh.box(2, 39, cz - 1, 2, 41, cz, 0x22272e);
  });
  return sh;
}

// ---------------------------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------------------------

function sleevePaint(body: string): ColorFn {
  if (body === 'oilskin_apron') return knit(JUMPER, 73);
  if (body === 'striped_shirt') return stripes;
  if (body === 'net_cape') return jitter(0xd8ccb0, 0.06, 75);
  return coatCol;
}

function buildUpperArm(l: Look): RGrid {
  const g = new RGrid(12, 13, 12, 6, 14, -6);
  const [sx, sy, sz] = A.shoulder;
  const body = slug(l.body);
  g.on(CH.skin, () => {
    g.blob(sx, sy - 0.5, sz, 3.9, 3.2, 3.7, skin(71, body ? 0 : 0.15));
    g.cyl('y', sx + 0.3, sz, 3.2, 16, 22, skin(72, body ? 0 : 0.12));
  });
  if (body) {
    const sleeve = sleevePaint(body);
    g.repaint(() => true, CH.cloth, sleeve, true);
    // rolled sleeve at the elbow: a fat cuff
    g.on(CH.cloth, () => g.cyl('y', sx + 0.3, sz, 3.75, 16, 17, body === 'oilskin_apron' ? knit(shade(JUMPER, 0.82), 77) : (x, y, z) => shade(sleeve(x, y, z), 0.88)));
    if (body === 'admiral_coat') {
      g.repaint((x, y) => y >= 16 && y < 18, CH.brass, BRASS, true);
      g.on(CH.brass, () => {
        g.blob(sx + 0.5, sy + 2.3, sz, 3.6, 1, 3.4, shade(BRASS, 1.05));
        for (let z = -3; z <= 3; z++) g.put(sx + 3.6, sy + 1, sz + z, z % 2 ? BRASS : shade(BRASS, 0.8));
      });
    }
    if (body === 'oilskin_apron') g.on(CH.skin, () => g.box(Math.floor(sx) - 3, sy + 2, Math.floor(sz) - 1, Math.floor(sx) - 1, sy + 2, Math.floor(sz) + 1, LEATHER));
  }
  return g;
}

/** Anchor tattoo on the outer face of the forearm (x = ox side). */
function anchorTattoo(g: RGrid, ox: number, y0: number, oz: number): void {
  const pts: [number, number][] = [
    [0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [-1, 3], [1, 3], [0, 5],
    [-2, 0], [2, 0], [-2, 1], [2, 1], [-1, -1], [1, -1], [0, -1],
  ];
  for (const [dz, dy] of pts) {
    for (let k = 0; k < 4; k++) {
      const x = ox - k;
      if (g.has(x, y0 + dy, oz + dz)) {
        g.paint(x, y0 + dy, oz + dz, INK);
        break;
      }
    }
  }
}

function buildLowerArm(l: Look, hookHand: boolean): RGrid {
  const g = new RGrid(12, 15, 13, 6, 3, -6);
  const [ex, , ez] = A.elbow;
  const [hx, hy, hz] = A.hand;
  g.on(CH.skin, () => {
    // Popeye forearm, swelling below the elbow, tapering to the wrist
    for (let y = 10; y <= 17; y++) {
      const u = (y - 10) / 7;
      const r = 2.9 + Math.sin(u * Math.PI * 0.85) * 1.3;
      g.cyl('y', ex + 0.2, ez + (1 - u) * 1.1, r, y, y, skin(81, 0.1), r * 0.95);
    }
    g.blob(hx, hy + 2.2, hz + 0.3, 3.5, 3.2, 3.7, skin(82));
    g.blob(hx - 2.6, hy + 3.2, hz + 2.2, 1.3, 1.2, 1.4, skin(83));
  });
  g.repaint((x, y, z) => z >= hz + 3 && y >= hy + 3 && y <= hy + 4, CH.skin, shade(SKIN_L, 1.02), true);
  g.repaint((x, y, z) => z >= hz + 2 && (y === Math.floor(hy + 1) || y === Math.floor(hy + 2.5)) && hv(x, y, z, 84) > 0.3, CH.skin, shade(SKIN_D, 0.88), true);
  if (hookHand) g.repaint((x, y) => y <= hy, CH.skin, shade(SKIN, 0.9), true);
  // wristband (team) just above the fist
  g.on(CH.cloth, () => g.cyl('y', ex + 0.2, ez + 1, 3.75, 10, 12, teamCloth(l.t, 85), 3.6));
  g.repaint((x, y) => y === 12, CH.cloth, (x, y, z) => shade(l.t.light, 0.95 + hv(x, y, z, 86) * 0.08), true);
  if (!hookHand) anchorTattoo(g, Math.floor(ex + 4), 12, Math.floor(ez + 0.5));
  return g;
}

// ---------------------------------------------------------------------------------------------
// Legs (body slot: trousers, feet slot: boots)
// ---------------------------------------------------------------------------------------------

function trouserOf(body: string): number {
  if (body === 'oilskin_apron') return TROUSER;
  if (body === 'striped_shirt') return 0x2c3346;
  if (body === 'net_cape') return 0x3e3a34;
  if (body === 'admiral_coat') return 0xe8e4da;
  return -1;
}

function buildLeg(l: Look): RGrid {
  const g = new RGrid(11, 17, 15, 0, 0, -6);
  const [lx, , lz] = A.leg;
  const feet = slug(l.feet);
  const trouser = trouserOf(slug(l.body));
  const thigh: ColorFn = trouser >= 0 ? jitter(trouser, 0.08, 91) : skin(92, 0.3);
  g.on(trouser >= 0 ? CH.cloth : CH.skin, () => {
    g.blob(lx, 8.6 + UP, lz, 4.4, 3.9, 4.4, thigh);
    for (let y = 2; y <= 7 + UP; y++) g.cyl('y', lx, lz + 0.3, 3.3 + (y - 2) * 0.12, y, y, thigh);
  });
  if (trouser < 0) g.on(CH.skin, () => g.blob(lx, 6.5, lz + 2.6, 2.2, 1.6, 1.4, skin(93)));
  if (feet === 'green_wellies') {
    const rub: ColorFn = (x, y, z) => {
      const h = hv(x, y, z, 94);
      const b = hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), 95);
      return b > 0.88 ? mix(WELLY, 0xbfb59a, 0.35) : shade(WELLY, 0.84 + h * 0.24);
    };
    g.on(CH.rubber, () => {
      g.cyl('y', lx, lz + 0.3, 3.9, 1, 8, rub);
      g.blob(lx, 2, lz + 3, 3.6, 2.2, 4.4, rub);
      g.cyl('y', lx, lz + 0.3, 4.15, 8, 9, (x, y, z) => shade(WELLY, 0.72 + hv(x, y, z, 96) * 0.1));
      g.box(lx - 4, 0, lz - 3.4, lx + 3, 0, lz + 7, (x, y, z) => shade(SOLE, 0.9 + hv(x, y, z, 97) * 0.12));
    });
    g.carve((x, y, z) => y === 0 && (z > lz + 6.5 || z < lz - 3.2) && Math.abs(x + 0.5 - lx) > 2.5);
  } else if (feet === 'clogs') {
    // grey wool socks and pale wooden clogs with an upturned toe
    g.on(CH.cloth, () => g.cyl('y', lx, lz + 0.3, 3.5, 2, 5, jitter(0x9c968c, 0.08, 98)));
    const wood: ColorFn = (x, y, z) => shade(0xd9b47a, 0.88 + hashVox(x, Math.floor(y / 2), 0, 99) * 0.18);
    g.on(CH.skin, () => {
      g.blob(lx, 1.8, lz + 2.4, 3.4, 2, 5, wood);
      g.blob(lx, 2.6, lz + 6.6, 1.6, 1.3, 1.2, wood);
      g.box(lx - 3, 0, lz - 2, lx + 2, 0, lz + 5, shade(0xa07a48, 0.9));
    });
  } else {
    // bare feet with stubby toes
    g.on(CH.skin, () => {
      g.blob(lx, 1.4, lz + 2, 3.4, 1.5, 4.3, skin(100));
      for (let i = 0; i < 5; i++) g.blob(lx - 2.3 + i * 1.15, 0.9, lz + 6 - Math.abs(i - 1.5) * 0.3, 0.75, 0.8, 0.8, skin(101 + i));
    });
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Held hooks (fallback when no fx hook skin exists). Grip at the origin, +Z = business end.
// ---------------------------------------------------------------------------------------------

/** Hook bend in the y/z plane: from (0, z0) round through (r, z0 + r) to (2r, z0). */
function hookBend(g: RGrid, z0: number, r: number, col: ColorFn, thick: number): void {
  for (let a = 0; a <= 24; a++) {
    const ang = -Math.PI / 2 + (a / 24) * Math.PI;
    g.blob(0, r + r * Math.sin(ang), z0 + r * Math.cos(ang), thick, thick, thick, col);
  }
}

function buildHook(id: string): RGrid {
  const g = new RGrid(14, 18, 26, -7, -6, -3);
  switch (id) {
    case 'harpoon_hook': {
      g.on(CH.cloth, () => g.tube(0, 0, 0, 0, 0, 5, 0.6, (x, y, z) => shade(0x2b2420, 0.8 + hv(x, y, z, 111) * 0.3)));
      g.on(CH.iron, () => {
        g.tube(0, 0, 5, 0, 0, 15, 0.7, rustyIron(112));
        for (let k = 0; k <= 4; k++) g.box(-2 + Math.ceil(k * 0.4), 0, 15 + k, 1 - Math.ceil(k * 0.4), 0, 15 + k, rustyIron(113));
        g.tube(0, 0, 12, 0, 2.5, 10, 0.5, rustyIron(114));
        g.tube(0, 0, 12, 0, -2.5, 10, 0.5, rustyIron(114));
        g.box(-1, -1, 5, 0, 0, 6, 0x5a5048);
      });
      return g;
    }
    case 'anchor_hook': {
      const iron: ColorFn = (x, y, z) => shade(0x34383e, 0.85 + hv(x, y, z, 121) * 0.25);
      g.on(CH.iron, () => {
        for (let i = 0; i < 4; i++) {
          const z = Math.floor(i * 1.6);
          if (i % 2 === 0) g.box(-1, 0, z, 0, 0, z + 1, 0x4a4e55);
          else g.box(0, -1, z, 0, 0, z + 1, 0x5a5f66);
        }
        g.blob(0, 0, 7.5, 1.2, 1.2, 1.2, iron);
        g.tube(0, 0, 8, 0, 0, 16, 0.75, iron);
        g.tube(-3.5, 0, 9.5, 3.5, 0, 9.5, 0.6, iron);
        for (let a = 0; a <= 12; a++) {
          const ang = (a / 12) * Math.PI;
          g.blob(Math.cos(ang) * 4.5, 0, 16 - Math.sin(ang) * 2.5, 0.8, 0.8, 0.8, iron);
        }
        g.blob(4.6, 0, 13.4, 1.3, 0.7, 1.2, iron);
        g.blob(-4.6, 0, 13.4, 1.3, 0.7, 1.2, iron);
      });
      return g;
    }
    case 'golden_harpoon': {
      // Limited: gilded harpoon with a pearl inlay
      const gold: ColorFn = (x, y, z) => shade(0xf0c34a, 0.85 + hv(x, y, z, 132) * 0.3);
      g.premium(() => {
        g.on(CH.cloth, () => g.tube(0, 0, 0, 0, 0, 5, 0.6, (x, y, z) => shade(0xe8dcc0, 0.85 + hv(x, y, z, 131) * 0.2)));
        g.on(CH.brass, () => {
          g.tube(0, 0, 5, 0, 0, 15, 0.75, gold);
          for (let k = 0; k <= 4; k++) g.box(-2 + Math.ceil(k * 0.4), 0, 15 + k, 1 - Math.ceil(k * 0.4), 0, 15 + k, gold);
          g.tube(0, 0, 12, 0, 2.5, 10, 0.5, gold);
          g.tube(0, 0, 12, 0, -2.5, 10, 0.5, gold);
          g.cyl('z', 0, 0, 1.4, 5, 6, shade(0xf0c34a, 1.1));
        });
        g.on(CH.wet, () => {
          g.blob(0, 0, 9, 1.1, 1.1, 1.3, (x, y, z) => shade(0xf4eee8, 0.92 + hv(x, y, z, 133) * 0.1));
          g.dot(0.4, 0.6, 9.6, 0xffe8f0);
        });
      });
      return g;
    }
    default: {
      // rope_hook: knotted rope, an iron collar and a rusty barbed fishing hook
      g.on(CH.cloth, () => {
        for (let z = 0; z <= 4; z++) g.blob(z % 2 ? 0.3 : -0.3, z % 2 ? 0.2 : -0.2, z, 0.85, 0.85, 0.7, ropeCol);
        g.blob(0, 0, 2.5, 1.3, 1.3, 1.1, ropeCol);
      });
      g.on(CH.iron, () => {
        g.cyl('z', 0, 0, 1.25, 5, 5, shade(IRON, 0.9));
        g.tube(0, 0, 6, 0, 0, 11, 0.8, rustyIron(141));
        hookBend(g, 11, 2.9, rustyIron(142), 0.8);
        g.tube(0, 5.8, 11, 0, 5.8, 8.2, 0.65, rustyIron(143));
        g.tube(0, 5.8, 8.2, 0, 4.5, 9.6, 0.5, (x, y, z) => shade(IRON, 1.1 + hv(x, y, z, 144) * 0.1));
      });
      return g;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Back slot
// ---------------------------------------------------------------------------------------------

function buildBack(id: string): RGrid {
  const g = new RGrid(26, 20, 16, -13, 9, -18);
  if (id === 'lobster_pot') {
    // arched wicker pot with a grumpy lobster, on rope straps
    const wick: ColorFn = (x, y, z) => shade((x + y + 100) % 2 === 0 ? 0xb88a4a : 0x9a6e36, 0.88 + hv(x, y, z, 151) * 0.2);
    g.on(CH.cloth, () => {
      g.box(-6, 11, -15, 5, 11, -10, wick);
      for (let x = -6; x <= 5; x++)
        for (let a = 0; a <= 12; a++) {
          const ang = (a / 12) * Math.PI;
          if (x === -6 || x === 5 || (x + 100) % 3 === 0 || a % 3 === 0) g.put(x, 11 + Math.sin(ang) * 8, -12.5 + Math.cos(ang) * 3.2, wick);
        }
      for (const sx of [-1, 1]) {
        g.tube(sx * 5, 19, -11, sx * 5, 25, -4, 0.6, ropeCol);
        g.tube(sx * 5, 13, -10, sx * 7, 13, -6, 0.6, ropeCol);
      }
    });
    // the lobster: dark olive-brown shell, orange-tipped claws poking out
    const shellC: ColorFn = (x, y, z) => shade(0x3a4630, 0.85 + hv(x, y, z, 152) * 0.3);
    g.on(CH.wet, () => {
      g.blob(0, 15, -12.6, 2.6, 2, 2, shellC);
      g.blob(-4, 17.5, -15, 1.6, 1.2, 1.4, (x, y, z) => (y > 17 ? 0xd2722a : shellC(x, y, z)));
      g.blob(4, 17.8, -15, 1.6, 1.2, 1.4, (x, y, z) => (y > 17 ? 0xd2722a : shellC(x, y, z)));
      g.tube(-1.5, 15.5, -13.5, -4, 17.5, -15, 0.55, shellC);
      g.tube(1.5, 15.5, -13.5, 4, 17.8, -15, 0.55, shellC);
      g.dot(-1, 16.4, -14.6, 0x111111);
      g.dot(1, 16.4, -14.6, 0x111111);
    });
    return g;
  }
  // barrel_pack: a little rum barrel strapped on with leather
  const wood: ColorFn = (x, y, z) => shade(WOOD, 0.85 + hashVox(Math.floor(Math.atan2(z + 12.8, x + 0.01) * 6), 0, 0, 161) * 0.2 + hv(x, y, z, 162) * 0.08);
  g.on(CH.cloth, () => {
    for (let y = 11; y <= 22; y++) {
      const u = (y - 16.5) / 6;
      g.cyl('y', 0, -12.8, 4.6 - u * u * 1.2, y, y, wood);
    }
  });
  g.on(CH.iron, () => {
    for (const y of [12, 16, 21]) ring(g, 0, -12.8, 3.4, 4.85 - ((y - 16.5) / 6) ** 2 * 1.2, y, y, shade(0x3a3d42, 0.95));
  });
  g.on(CH.brass, () => g.cyl('z', 0, 15, 0.9, -18, -17, BRASS));
  g.on(CH.skin, () => {
    for (const sx of [-1, 1]) {
      g.tube(sx * 3.5, 21, -10, sx * 5, 25, -4, 0.6, LEATHER);
      g.tube(sx * 3.5, 13, -9.5, sx * 7, 13, -6, 0.6, LEATHER);
    }
  });
  return g;
}

// ---------------------------------------------------------------------------------------------

export function brawlerPalette(l: Look): PudgyPalette {
  const body = slug(l.body);
  const head = slug(l.head);
  const outfit = body === 'oilskin_apron' ? OILSKIN : body === 'striped_shirt' ? NAVY : body === 'net_cape' ? NET : body === 'admiral_coat' ? COAT : PANTS;
  const hat = head === 'captain_cap' ? 0xf2efe6 : head === 'souwester' ? 0xe6b52a : head === 'bobble_beanie' ? 0x3c3f46 : head === 'tricorn' ? 0x2a2526 : head === 'lighthouse_helm' ? 0xf3efe6 : HAIR;
  const feet = slug(l.feet) === 'green_wellies' ? WELLY : slug(l.feet) === 'clogs' ? 0xd9b47a : SKIN;
  const second = body === 'oilskin_apron' ? JUMPER : body ? CREAM : SKIN_D;
  return { skin: SKIN, skinDark: SKIN_D, cloth: l.t.main, accent: outfit, metal: slug(l.hands) === 'golden_harpoon' ? 0xf0c34a : IRON, extra: [HAIR, hat, second, feet, l.t.dark] };
}

export function buildBrawler(l: Look): FamilyBuild {
  const res = resOf(l.fine);
  const team = l.team;
  const body = slug(l.body);
  const face = slug(l.face);
  const head = slug(l.head);
  const feet = slug(l.feet);
  const back = slug(l.back);
  const hands = slug(l.hands) || 'rope_hook';
  const hm = hatMeta(head);
  const sk: Skeleton = { ...SK, hatExtra: up(hm.extraJoint, UP + HUP + HAT), top: hm.top + UP + HUP + HAT };
  const parts: Partial<Record<PartName, PartDef>> = {
    body: part(`brawler:body:${body}:${team}`, () => buildBody(l), A.body, res),
    head: part(`brawler:head:${face}:${head ? 'h' : 'b'}`, () => buildHead(l), A.neck, res),
    jaw: part('brawler:jaw', () => buildJaw(), A.jaw, res),
    eyes: part(`brawler:eyes:${face === 'eyepatch' ? 1 : 0}`, () => buildEyes(face === 'eyepatch'), A.eyes, res),
    upperL: part(`brawler:uarm:${body}`, () => buildUpperArm(l), A.shoulder, res),
    upperR: partMirrored(`brawler:uarm:${body}`, () => buildUpperArm(l), A.shoulder, res),
    lowerL: part(`brawler:larm:${team}`, () => buildLowerArm(l, false), A.elbow, res),
    lowerR: partMirrored(`brawler:larmH:${team}`, () => buildLowerArm(l, true), A.elbow, res),
    legL: part(`brawler:leg:${body}:${feet}`, () => buildLeg(l), SK.leg, res),
    legR: partMirrored(`brawler:leg:${body}:${feet}`, () => buildLeg(l), SK.leg, res),
    hook: part(`brawler:hook:${hands}`, () => buildHook(hands), [0, 0, 0], res),
    drop: part('brawler:drop', () => dropGrid(false), [0, 0, 0], 1),
  };
  if (hm.hat) parts.hat = part(`brawler:hat:${head}`, () => buildHat(head), A.hat, res);
  if (hm.extra) parts.hatExtra = part(`brawler:hatx:${head}`, () => buildHatExtra(head), hm.extraJoint, res);
  const backMode: BackMode = 'none';
  if (back === 'lobster_pot' || back === 'barrel_pack') parts.back = part(`brawler:back:${back}`, () => buildBack(back), A.back, res);
  const puffs: PuffEmitter[] = [];
  if (face === 'cigar') puffs.push({ node: 'neck', at: up([7, 27.2, HC[2] + 9], UP + HUP), kind: 'smoke', rate: 1.1, burst: 2.5, size: 0.09 });
  if (face === 'pipe') puffs.push({ node: 'neck', at: up([-5.6, 29, HC[2] + 8.9], UP + HUP), kind: 'smoke', rate: 1.3, burst: 2.5, size: 0.1 });
  const dangles = hands === 'rope_hook' || hands === 'anchor_hook';
  return {
    family: 'brawler',
    sk,
    rest: { armSplay: 0.27, armFwd: -0.14, elbow: -0.32, legSplay: 0.04, hunch: 0, headPitch: 0.05, jawRest: 0, holdElbow: -1.05, holdShoulder: -0.45 },
    style: { kind: 'swagger', stride: 1.9, bounce: 0.09, legSwing: 0.7, armSwing: 0.6, roll: 0.13, sway: 0.1, lean: 0.12, stomp: 0.5, breath: 0.32 },
    hatMode: hm.mode,
    hatSpin: hm.spin,
    backMode,
    backSpin: 0,
    parts,
    palette: brawlerPalette(l),
    scale: SCALE,
    hookDangles: dangles,
    // dangling hooks hang straight down from the fist; harpoons point forward out of it
    hookMount: dangles ? HANG : GRIP,
    hangMount: HANG,
    gripMount: GRIP,
    puffs,
    corpseLift: 0.55,
    premium: hands === 'golden_harpoon',
  };
}
