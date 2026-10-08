// Swamp Ogre (ref02 default look, ref09 bare base): a hulking, hunched bog troll with grey-green
// warty skin, moss patches and orange fungus growths, pointed ears and big lower tusks.
// Bare base: skin, short dark dreads, a plain woven loincloth, bare feet with big toenails.
// Default set: moss mane (long mossy dreads), tooth necklace with a reed and moss skirt, moss
// drapes over the back, muddy toes, vine-wrapped tusk hook. Team colour: a woven sash from the
// left shoulder to the right hip (drawn over every outfit) and cloth wraps on both forearms.
import type { PudgyPalette } from '../../contracts.ts';
import { dropGrid, lumps, part, partMirrored, resOf, ring, teamCloth, type Look, type TeamCols } from './common.ts';
import { buildRes, CH, hashVox, hv, jitter, mix, P, RGrid, shade, type ColorFn } from './grid.ts';
import type { BackMode, FamilyBuild, HatMode, PartDef, PartName, Skeleton, V3 } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Palette (ref02 / ref09)
// ---------------------------------------------------------------------------------------------

const SKIN = 0xb2ad84;
const SKIN_D = 0x8e8c62;
const SKIN_L = 0xcdc69e;
const SKIN_G = 0x8f9a5c;
const MOSS = [0x7f8f2a, 0x97a232, 0x5f6c1f, 0xa9b23e, 0x6f7d26] as const;
const FUNGUS = 0xd28a4e;
const FUNGUS_D = 0x8a4a28;
const DREAD = 0x302b22;
const DREAD_L = 0x4d4433;
const BONE = 0xe9ddc0;
const BONE_D = 0xc6b893;
const EAR = 0xc8704e;
const NOSE = 0xb86a52;
const CLOTH = 0x5a3e26;
const CLOTH_D = 0x3e2a1a;
const REED = 0xb89a54;
const VINE = 0x4a5a1e;
const MUD = 0x4e3a26;
const NAIL = 0xd8ccb0;
const AMETHYST = 0xa45ce0;

const SCALE = 0.93;

const HC: V3 = [0, 31.5, 7.5];
const HR: V3 = [5.8, 5.4, 5.4];
const BELLY_C: V3 = [0, 18, 3.5];
const BELLY_R: V3 = [12, 10, 12];
const CHEST_C: V3 = [0, 26, -1];
const CHEST_R: V3 = [12.5, 6, 9];
const HUMP_C: V3 = [0, 30, -3.5];
const HUMP_R: V3 = [9.5, 3.8, 7];

/** Authoring skeleton (grids are painted in it); SK lifts everything above the legs by UP. */
const A: Skeleton = {
  core: 18,
  hip: [0, 12, 0],
  leg: [5.8, 12, 0.5],
  body: [0, 18, 3],
  neck: [0, 28, 4],
  shoulder: [13.5, 28, -0.5],
  elbow: [14.5, 20.5, 0],
  hand: [15, 9.5, 1.5],
  jaw: [0, 29.5, 8],
  eyes: [0, 32.6, 12.4],
  hat: [0, 34, 6.5],
  hatExtra: [0, 38, 6.5],
  back: [0, 24, -9],
  backExtra: [0, 22, -14],
  drop: [6, 34, 9],
  top: 38,
};
const UP = 2;
const up = (v: V3, k = UP): V3 => [v[0], v[1] + k, v[2]];
const SK: Skeleton = {
  core: A.core + UP,
  hip: up(A.hip),
  leg: up(A.leg),
  body: up(A.body),
  neck: up(A.neck),
  shoulder: up(A.shoulder),
  elbow: up(A.elbow),
  hand: up(A.hand),
  jaw: up(A.jaw),
  eyes: up(A.eyes),
  hat: up(A.hat),
  hatExtra: up(A.hatExtra),
  back: up(A.back),
  backExtra: up(A.backExtra),
  drop: up(A.drop),
  top: A.top + UP,
};

const slug = (id: string | undefined): string => (id ? id.slice(id.indexOf('.') + 1) : '');

// ---------------------------------------------------------------------------------------------
// Paints and growths
// ---------------------------------------------------------------------------------------------

/** Grey-green warty skin with darker green blotches and pale speckles. */
function skin(seed: number): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed);
    const blot = hashVox(Math.floor(x / 3), Math.floor(y / 3), Math.floor(z / 3), seed + 5);
    let c = h > 0.88 ? SKIN_L : h < 0.14 ? SKIN_D : SKIN;
    if (blot > 0.72) c = mix(c, SKIN_G, 0.55);
    else if (blot < 0.12) c = mix(c, 0x8a7a5a, 0.4);
    return shade(c, 0.94 + (h - 0.5) * 0.1);
  };
}

const moss: ColorFn = (x, y, z) => shade(MOSS[Math.floor(hv(x, y, z, 91) * MOSS.length) % MOSS.length], 0.88 + hv(x, y, z, 92) * 0.22);
const dreadCol: ColorFn = (x, y, z) => {
  const s = hashVox(x, 0, z, 61);
  return shade(s > 0.6 ? DREAD_L : DREAD, 0.8 + hv(x, y, z, 62) * 0.35);
};
const bone = (seed: number): ColorFn => (x, y, z) => shade(hv(x, y, z, seed) > 0.8 ? BONE_D : BONE, 0.92 + hv(x, y, z, seed + 1) * 0.1);
const vine: ColorFn = (x, y, z) => shade((x + y + z) % 2 === 0 ? VINE : 0x5d6e28, 0.85 + hv(x, y, z, 63) * 0.25);
const clothCol: ColorFn = (x, y, z) => shade((x + y + 200) % 2 === 0 ? CLOTH : CLOTH_D, 0.88 + hv(x, y, z, 64) * 0.2);

/** Moss patches over the surface: recolour plus a few raised tufts. */
function mossOver(g: RGrid, test: (x: number, y: number, z: number) => boolean, amount: number, seed: number): void {
  g.repaint((x, y, z) => test(x, y, z) && hashVox(Math.floor(x / 3), Math.floor(y / 3), Math.floor(z / 3), seed) > 1 - amount, CH.cloth, moss, true);
  // tufts on top of mossy surface voxels, one voxel (of the build resolution) straight above, so
  // they always touch the surface
  const res = buildRes();
  const tufts: number[] = [];
  g.each((c, x, y, z) => {
    if ((c & 7) !== CH.cloth) return undefined;
    const fx = Math.floor(P.x * res);
    const fy = Math.floor(P.y * res) + 1;
    const fz = Math.floor(P.z * res);
    if (hv(x, y, z, seed + 1) > 0.86 && !g.hasF(fx, fy, fz)) tufts.push(fx, fy, fz);
    return undefined;
  }, true);
  g.on(CH.cloth, () => {
    for (let i = 0; i < tufts.length; i += 3) g.setF(tufts[i], tufts[i + 1], tufts[i + 2], moss);
  });
}

/** Orange bracket fungus / barnacle rosette sitting on an ellipsoid surface. */
function fungi(g: RGrid, c: V3, r: V3, count: number, seed: number, region: (nx: number, ny: number, nz: number) => boolean, size = 1.15): void {
  let placed = 0;
  for (let i = 0; i < count * 10 && placed < count; i++) {
    const u = hashVox(i, 7, 3, seed);
    const v = hashVox(i, 9, 5, seed);
    const th = u * Math.PI * 2;
    const ph = Math.acos(2 * v - 1);
    const nx = Math.sin(ph) * Math.cos(th);
    const ny = Math.cos(ph);
    const nz = Math.sin(ph) * Math.sin(th);
    if (!region(nx, ny, nz)) continue;
    const s = size * (0.8 + hashVox(i, 1, 1, seed) * 0.5);
    const px = c[0] + nx * r[0];
    const py = c[1] + ny * r[1];
    const pz = c[2] + nz * r[2];
    const ox = px + nx * s * 0.9;
    const oy = py + ny * s * 0.9;
    const oz = pz + nz * s * 0.9;
    g.on(CH.cloth, () => g.blob(px + nx * 0.3, py + ny * 0.3, pz + nz * 0.3, s, s, s, () => {
      const d = Math.hypot(P.x - ox, P.y - oy, P.z - oz);
      return d < s * 0.55 ? shade(FUNGUS_D, 0.9 + hv(P.x, P.y, P.z, seed) * 0.2) : shade(FUNGUS, 0.9 + hv(P.x, P.y, P.z, seed + 1) * 0.18);
    }));
    placed++;
  }
}

/** Raised warts painted darker. */
function warts(g: RGrid, density: number, seed: number): void {
  g.each((c, x, y, z) => {
    if ((c & 7) !== CH.skin) return undefined;
    const h = hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), seed);
    if (h > 1 - density) return hv(x, y, z, seed + 1) > 0.4 ? shade(SKIN_D, 0.85) : shade(SKIN_G, 0.85);
    return undefined;
  }, true);
}

/**
 * Dreadlocks rooted all over the scalp (not over the face): each strand pushes out from the head,
 * then hangs; back strands are the longest. len scales the length, mossy is the share of mossy ones.
 */
function dreads(g: RGrid, count: number, len: number, mossy: number, seed: number): void {
  const [cx, cy, cz] = HC;
  const [rx, ry, rz] = HR;
  let n = 0;
  for (let i = 0; i < count * 6 && n < count; i++) {
    const phi = Math.acos(1 - hashVox(i, 1, 0, seed) * 1.25);
    const th = hashVox(i, 2, 0, seed) * Math.PI * 2 - Math.PI;
    if (Math.abs(th) < 1.05 && phi > 0.45) continue; // keep the face and forehead clear
    n++;
    const nx = Math.sin(phi) * Math.sin(th);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.cos(th);
    const x0 = cx + nx * rx * 0.92;
    const y0 = cy + ny * ry * 0.92;
    const z0 = cz + nz * rz * 0.92;
    const out = 1.6 + hashVox(i, 3, 0, seed);
    const x1 = x0 + nx * out;
    const y1 = y0 + ny * out * 0.6 + 0.4;
    const z1 = z0 + nz * out;
    const back = Math.max(0, -Math.cos(th));
    const L = (3 + back * 11 + hashVox(i, 4, 0, seed) * 4) * len + 1.5;
    const x2 = x1 + nx * 1.5 * (1 - back * 0.5);
    const y2 = Math.max(y1 - L, 14);
    const z2 = z1 + nz * 1.5 - back * L * 0.25;
    const m = hashVox(i, 5, 0, seed) < mossy;
    const col: ColorFn = m ? (x, y, z) => (hv(x, y, z, seed + 1) > 0.4 ? moss(x, y, z) : dreadCol(x, y, z)) : dreadCol;
    g.on(CH.cloth, () => {
      g.tube(x0, y0, z0, x1, y1, z1, 0.8, col, 0.75);
      g.tube(x1, y1, z1, x2, y2, z2, 0.75, col, 0.55);
      if (m && L > 6) g.tube(x2, y2, z2, x2, y2 - 1.6, z2, 0.5, moss);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Body (body slot) + team sash
// ---------------------------------------------------------------------------------------------

function buildBody(l: Look): RGrid {
  const g = new RGrid(32, 30, 32, -16, 3, -14);
  const body = slug(l.body);
  g.on(CH.skin, () => {
    g.blob(BELLY_C[0], BELLY_C[1], BELLY_C[2], BELLY_R[0], BELLY_R[1], BELLY_R[2], skin(1));
    g.blob(CHEST_C[0], CHEST_C[1], CHEST_C[2], CHEST_R[0], CHEST_R[1], CHEST_R[2], skin(2));
    g.blob(HUMP_C[0], HUMP_C[1], HUMP_C[2], HUMP_R[0], HUMP_R[1], HUMP_R[2], skin(3));
    // pecs and the seat
    for (const sx of [1, -1]) g.blob(sx * 5.5, 25, 6, 5, 3.4, 3.4, skin(4));
    g.blob(0, 12.5, -1, 9.5, 4.5, 8.5, skin(5));
  });
  // paler belly
  g.repaint((x, y, z) => z > 6 && y < 24 && y > 10, CH.skin, (x, y, z) => mix(skin(6)(x, y, z), SKIN_L, 0.3), true);
  warts(g, 0.13, 7);
  // moss on the shoulders, hump and belly sides, fungi in it
  mossOver(g, (x, y, z) => y > 25 || (y > 14 && Math.abs(x + 0.5) > 8), 0.3, 11);
  fungi(g, BELLY_C, BELLY_R, 6, 12, (nx, ny, nz) => nz > 0.35 && ny > -0.4);
  fungi(g, CHEST_C, CHEST_R, 5, 13, (nx, ny) => ny > 0.35);
  fungi(g, HUMP_C, HUMP_R, 3, 14, (nx, ny, nz) => ny > 0.2 && nz < 0.3);

  // loincloth or skirt round the hips
  if (body === 'tooth_necklace') reedSkirt(g);
  else loincloth(g);

  switch (body) {
    case 'tooth_necklace': {
      // a cord of big teeth hanging over the chest
      g.on(CH.skin, () => {
        for (let i = 0; i <= 30; i++) {
          const a = -1.25 + (i / 30) * 2.5;
          g.put(Math.sin(a) * 9.4, 27.4 - Math.cos(a) * 4.4, 9 + Math.cos(a) * 1.6, i % 2 ? 0x3a2a1c : 0x5a4028);
        }
      });
      g.on(CH.wet, () => {
        for (let i = 0; i < 9; i++) {
          const a = -1.05 + (i / 8) * 2.1;
          const x = Math.sin(a) * 9.4;
          const y = 27.4 - Math.cos(a) * 4.4;
          const z = 9.6 + Math.cos(a) * 1.6;
          const len = i === 4 ? 3.4 : 2.2 + (i % 2) * 0.8;
          g.tube(x, y - 0.3, z, x * 0.95, y - len, z + 0.9, 0.85, bone(70 + i), 0.45);
        }
      });
      break;
    }
    case 'frog_pouch': {
      // belt of leather pouches; a green frog peeks out of one
      g.repaint((x, y) => y >= 14 && y <= 15, CH.skin, (x, y, z) => shade(0x5e3e24, 0.85 + hv(x, y, z, 81) * 0.25), true);
      g.on(CH.skin, () => {
        for (const [a, h] of [[-0.9, 1], [0.1, 0], [0.9, 1], [1.7, 0], [-1.7, 1]] as const) {
          const x = Math.sin(a) * 12.4;
          const z = 3.5 + Math.cos(a) * 12;
          g.blob(x, 12.6 - h * 0.4, z, 1.9, 2.2, 1.5, (xx, yy, zz) => shade(h ? 0x7a5432 : 0x8a6038, 0.85 + hv(xx, yy, zz, 82) * 0.2));
          g.put(x, 14.4, z, 0xb08a52);
        }
      });
      g.on(CH.wet, () => {
        const x = Math.sin(0.1) * 12.4;
        const z = 3.5 + Math.cos(0.1) * 12;
        g.blob(x, 15.4, z + 0.4, 1.6, 1.1, 1.3, (xx, yy, zz) => shade(0x6aa83a, 0.85 + hv(xx, yy, zz, 83) * 0.25));
        g.put(x - 1, 16, z + 1, 0xf2e070);
        g.put(x + 1, 16, z + 1, 0xf2e070);
      });
      break;
    }
    case 'shell_armor': {
      // a turtle shell worn as a breastplate, with scutes and a rope harness
      const sc: ColorFn = (x, y, z) => {
        const cell = (Math.floor((x + 100) / 4) + Math.floor((y + 100) / 4)) % 2;
        const edge = (x + 100) % 4 === 0 || (y + 100) % 4 === 0;
        return edge ? shade(0x3e3a22, 0.9) : shade(cell ? 0x6e6a34 : 0x7e7438, 0.88 + hv(x, y, z, 84) * 0.22);
      };
      g.on(CH.rubber, () => g.shell(BELLY_C[0], BELLY_C[1] + 2, BELLY_C[2], BELLY_R[0] - 1, BELLY_R[1], BELLY_R[2], 2.2, 0.6, (x, y, z) => z > 5 && y > 11 && y < 29 && Math.abs(x + 0.5) < 10, sc));
      g.on(CH.cloth, () => {
        for (const sx of [1, -1]) g.tube(sx * 8.5, 27, 9, sx * 10.5, 30.5, -2, 0.7, (x, y, z) => shade(REED, 0.75 + hv(x, y, z, 85) * 0.2));
      });
      break;
    }
    case 'glow_spots': {
      // glowing mushroom colony all over the belly
      for (let i = 0; i < 14; i++) {
        const a = -1.2 + hashVox(i, 1, 0, 86) * 2.4;
        const yy = 11 + hashVox(i, 2, 0, 86) * 14;
        const dy = (yy - BELLY_C[1]) / BELLY_R[1];
        const rr = Math.sqrt(Math.max(0, 1 - dy * dy));
        const x = Math.sin(a) * BELLY_R[0] * rr;
        const z = BELLY_C[2] + Math.cos(a) * BELLY_R[2] * rr;
        const s = 0.9 + hashVox(i, 3, 0, 86) * 0.8;
        g.on(CH.cloth, () => g.tube(x, yy, z, x * 1.05, yy + 0.8, z + 0.9, 0.5, 0xe6e0c8));
        g.on(CH.pulse, () => g.blob(x * 1.06, yy + 1.2, z + 1.1, s, s * 0.6, s, (xx, yy2, zz) => (hv(xx, yy2, zz, 87) > 0.75 ? 0xd8fff0 : 0x6ef0c0)));
      }
      break;
    }
    default:
      break;
  }
  sash(g, l.t);
  return g;
}

function loincloth(g: RGrid): void {
  g.on(CH.cloth, () => {
    g.shell(0, 12.5, -1, 9.5, 4.5, 8.5, 0.9, 0.2, (x, y) => y <= 14 && y >= 9, clothCol);
    g.shell(BELLY_C[0], BELLY_C[1], BELLY_C[2], BELLY_R[0], BELLY_R[1], BELLY_R[2], 0.8, 0.2, (x, y) => y <= 11.5 && y >= 8, clothCol);
    // front and back flaps hanging between the legs, frayed hems
    for (const fz of [1, -1]) {
      for (let y = 4; y <= 10; y++) {
        const w = 4 - (10 - y) * 0.28;
        for (let x = Math.floor(-w); x <= Math.ceil(w) - 1; x++) {
          if (y === 4 && hashVox(x, y, fz, 65) > 0.6) continue;
          const z = fz > 0 ? 8.5 - (10 - y) * 0.15 : -8.5;
          g.put(x, y, z, clothCol);
          g.put(x, y, z - fz, clothCol);
        }
      }
    }
  });
  g.repaint((x, y) => y === 14, CH.cloth, vine, true);
}

function reedSkirt(g: RGrid): void {
  // twisted vine belt, reeds and long moss hanging to the knees
  g.on(CH.cloth, () => {
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2;
      const rx = 12.4;
      const rz = 11.6;
      const x = Math.sin(a) * rx;
      const z = 2.6 + Math.cos(a) * rz;
      const len = 6 + hashVox(i, 0, 0, 66) * 4;
      const mossy = hashVox(i, 1, 0, 66) > 0.55;
      g.tube(x, 13.5, z, x * 1.06, 13.5 - len, z * 1.04 + 0.2, 0.6, mossy ? moss : (xx, yy, zz) => shade(REED, 0.7 + hv(xx, yy, zz, 67) * 0.3));
    }
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      g.blob(Math.sin(a) * 12, 13.6, 2.6 + Math.cos(a) * 11.3, 0.9, 0.8, 0.9, vine);
    }
  });
}

/** Team sash: from the left shoulder, across the belly, to the right hip, knotted with tails. */
function sash(g: RGrid, t: TeamCols): void {
  const col = teamCloth(t, 28);
  const onSash = (x: number, y: number) => Math.abs(y - (12.5 + (x + 11) * 0.72)) < 1.9;
  g.repaint((x, y, z) => onSash(x + 0.5, y) && y > 10 && y < 31, CH.cloth, col, true);
  // thickness: one layer outside the surface, front and back
  const add: number[] = [];
  const res = buildRes();
  g.each((c, x, y, z) => {
    if (!onSash(x + 0.5, y) || y <= 10 || y >= 31) return undefined;
    const nz = z > 2 ? 1 : -1;
    const fx = Math.floor(P.x * res);
    const fy = Math.floor(P.y * res);
    const fz = Math.floor(P.z * res);
    // thicken outward by one unit, voxel by voxel, so the layer always touches the surface
    for (let k = 1; k <= res; k++) if (!g.hasF(fx, fy, fz + nz * k)) add.push(fx, fy, fz + nz * k);
    return undefined;
  }, true);
  g.on(CH.cloth, () => {
    for (let i = 0; i < add.length; i += 3) g.setF(add[i], add[i + 1], add[i + 2], col);
    // knot and tails on the right hip
    g.blob(-11, 11.5, 6, 2, 1.8, 1.8, col);
    g.tube(-11.2, 10, 7, -11.8, 5, 8, 0.85, col);
    g.tube(-10.4, 10, 7, -9.6, 6, 8.6, 0.85, col);
  });
  g.repaint((x, y) => y < 6.5, CH.cloth, (x, y, z) => shade(t.dark, 1 + hv(x, y, z, 29) * 0.1), true);
}

// ---------------------------------------------------------------------------------------------
// Head (face slot), jaw (tusks), eyes
// ---------------------------------------------------------------------------------------------

function buildHead(l: Look): RGrid {
  const g = new RGrid(22, 18, 22, -11, 23, -4);
  const [cx, cy, cz] = HC;
  const [rx, ry, rz] = HR;
  const face = slug(l.face);
  const maned = slug(l.head) === 'moss_mane';
  g.on(CH.skin, () => {
    g.blob(cx, cy, cz, rx, ry, rz, skin(21));
    // heavy brow ridge and broad cheeks
    g.blob(0, 33.8, cz + 3.6, 5.2, 1.5, 2.2, skin(22));
    for (const sx of [1, -1]) g.blob(sx * 3.6, 30.8, cz + 3.6, 2.4, 2, 2, skin(23));
    // thick neck into the hump
    g.blob(0, 28.5, 4.5, 5.6, 3, 5, skin(24));
  });
  warts(g, 0.12, 25);
  // mouth cavity for the jaw
  g.carve((x, y, z) => y < 30 && y > 25 && z > cz + 1 && Math.abs(x + 0.5) < 5);
  g.on(CH.wet, () => {
    for (let x = -4; x <= 3; x++) for (let z = 9; z <= 12; z++) g.add(x, 29, z, 0x2a1a14);
  });
  // eye sockets under the brow
  g.carve((x, y, z) => z >= cz + 4 && y === 32 && Math.abs(Math.abs(x + 0.5) - 2.2) < 0.9);
  // broad nose
  g.on(CH.skin, () => {
    g.blob(0, 31, cz + 5.4, 1.7, 1.5, 1.6, (x, y, z) => shade(NOSE, 0.88 + hv(x, y, z, 26) * 0.18));
    g.dot(-0.8, 30.2, cz + 6.5, 0x3a2418);
    g.dot(0.8, 30.2, cz + 6.5, 0x3a2418);
  });
  // pointed ears sweeping back and up
  g.on(CH.skin, () => {
    for (const sx of [1, -1]) {
      g.tube(sx * 5.4, 32, cz - 0.5, sx * 9, 34.4, cz - 2.5, 1.2, (x, y, z) => shade(hv(x, y, z, 27) > 0.4 ? EAR : SKIN, 0.92 + hv(x, y, z, 28) * 0.12), 0.62);
    }
  });
  // short dark dreads (bare); the moss mane hat covers them
  if (!maned) {
    g.on(CH.cloth, () => {
      g.shell(cx, cy, cz, rx, ry, rz, 0.6, 0.2, (x, y, z) => y > 34 && z < cz + 3, dreadCol);
    });
    dreads(g, 34, 0.35, 0.05, 29);
  }
  switch (face) {
    case 'nose_ring':
      g.on(CH.wet, () => {
        for (let a = 0; a < 12; a++) {
          const a0 = (a / 12) * Math.PI * 2;
          const a1 = ((a + 1) / 12) * Math.PI * 2;
          g.fineLine(Math.cos(a0) * 1.1, 29.6 + Math.sin(a0) * 1.1, cz + 6.2, Math.cos(a1) * 1.1, 29.6 + Math.sin(a1) * 1.1, cz + 6.2, bone(31));
        }
        if (buildRes() === 1) g.put(0, 29, cz + 6, BONE);
      });
      break;
    case 'war_paint':
      // swamp clay stripes across the eyes and cheeks
      g.repaint((x, y, z) => z > cz + 1.5 && ((y >= 32 && y <= 33 && Math.abs(x + 0.5) < 5.5) || (Math.abs(Math.abs(x + 0.5) - 3.8) < 0.8 && y >= 29 && y <= 31)), CH.skin, (x, y, z) => shade(0xd9cfb4, 0.88 + hv(x, y, z, 32) * 0.15), true);
      g.repaint((x, y, z) => z > cz + 1.5 && y >= 34 && Math.abs(x + 0.5) < 1, CH.skin, 0x8a5a3a, true);
      break;
    default:
      break;
  }
  return g;
}

function buildJaw(l: Look): RGrid {
  const g = new RGrid(18, 14, 16, -9, 22, 1);
  const crystal = slug(l.face) === 'crystal_tusks';
  // big underbite jaw and chin
  g.on(CH.skin, () => g.blob(0, 27.6, HC[2] + 2.4, 5.2, 2.6, 4.4, skin(41), (x, y, z) => y < 29.4 && z > HC[2] - 2));
  warts(g, 0.12, 42);
  // lower teeth and lip
  g.on(CH.wet, () => {
    for (let x = -4; x <= 3; x++) g.paint(x, 29, 12, x % 2 ? BONE : BONE_D);
    for (let x = -3; x <= 2; x++) g.paint(x, 29, 10, 0x6a3a30);
  });
  // tusks: from the lower jaw, curving up and out past the cheeks
  const tusk = crystal ? (x: number, y: number, z: number) => shade(hv(x, y, z, 43) > 0.6 ? 0xc89aff : AMETHYST, 0.9 + hv(x, y, z, 44) * 0.2) : bone(45);
  const draw = () => {
    for (const sx of [1, -1]) {
      for (let i = 0; i <= 10; i++) {
        const u = i / 10;
        const x = sx * (3.7 + u * 2.6 - u * u * 0.6);
        const y = 28.8 + u * 6.6 - u * u * 0.8;
        const z = HC[2] + 5 + Math.sin(u * 1.8) * 1.8;
        const r = 1.55 * (1 - u * 0.78);
        g.blob(x, y, z, r, r, r, tusk);
      }
    }
  };
  if (crystal) g.premium(() => g.on(CH.glow, draw));
  else g.on(CH.wet, draw);
  if (buildRes() > 1 && !crystal) {
    // showcase: growth rings on the tusks
    g.repaint((x, y, z) => y > 29 && Math.abs(x + 0.5) > 3 && Math.floor(P.y * 2 + 100) % 3 === 0, CH.wet, (x, y, z) => shade(BONE_D, 0.9 + hv(x, y, z, 46) * 0.1), true);
  }
  return g;
}

function buildEyes(): RGrid {
  const g = new RGrid(10, 4, 4, -5, 31, 10);
  for (const sx of [1, -1]) {
    const xi = sx > 0 ? 1 : -2;
    const x0 = sx > 0 ? 2 : -3;
    g.on(CH.wet, () => {
      g.set(xi, 32, 12, 0x1c140e);
      g.set(x0, 32, 12, 0xd8a03a);
      g.set(xi, 32, 11, 0x1c140e);
      g.set(x0, 32, 11, 0x1c140e);
      if (buildRes() > 1) g.dot(xi + (sx > 0 ? 0.75 : 0.25), 32.75, 12.75, 0xfff4d8);
    });
  }
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
    case 'moss_mane':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: A.hatExtra, top: 39 };
    case 'mushroom_cap':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: A.hatExtra, top: 45 };
    case 'lily_crown':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: A.hatExtra, top: 39 };
    case 'antler_rack':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: A.hatExtra, top: 47 };
    case 'skull_helm':
      return { hat: true, extra: false, mode: 'none', spin: 0, extraJoint: [0, 36, cz], top: 41 };
    default:
      return { hat: false, extra: false, mode: 'none', spin: 0, extraJoint: A.hatExtra, top: 37.5 };
  }
}

function buildHat(id: string): RGrid {
  const [cx, cy, cz] = HC;
  const [rx, ry, rz] = HR;
  const g = new RGrid(30, 30, 34, -15, 18, cz - 22);
  switch (id) {
    case 'moss_mane': {
      // long mossy dreadlocks from the whole scalp, down the back and over the shoulders
      dreads(g, 56, 1, 0.5, 71);
      g.on(CH.cloth, () => lumps(g, cx, cy, cz, rx, ry, rz, 12, 73, 0.8, 1.4, (nx, ny, nz) => ny > 0.5 && nz < 0.4, moss, 0.6));
      // little orange fungi tucked in the mane
      for (let i = 0; i < 6; i++) {
        const a = 0.3 + (i / 5) * 2.5;
        const x = Math.cos(a) * 7.2;
        const z = cz - Math.sin(a) * 5.2 - 1;
        const y = 33 - hashVox(i, 0, 0, 74) * 3;
        g.on(CH.cloth, () => g.blob(x, y, z, 1, 1, 1, (xx, yy, zz) => (hv(xx, yy, zz, 75) > 0.6 ? FUNGUS_D : FUNGUS)));
      }
      return g;
    }
    case 'mushroom_cap': {
      // a huge red toadstool with cream spots, sitting on a mossy pad
      g.on(CH.cloth, () => {
        g.cyl('y', 0, cz, 2.4, 35, 38, jitter(0xe8dcc0, 0.05, 76));
        g.blob(0, 39.5, cz, 10.5, 5, 10, (x, y, z) => {
          const spot = hashVox(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2), 77) > 0.8;
          return spot ? shade(0xf2e6cc, 0.95 + hv(x, y, z, 78) * 0.06) : shade(0xb8321e, 0.86 + hv(x, y, z, 79) * 0.2);
        }, (x, y) => y >= 38);
        ring(g, 0, cz, 5, 10, 38, 38, (x, y, z) => shade(0xe8d8b8, 0.85 + hv(x, y, z, 80) * 0.1));
        lumps(g, cx, cy, cz, rx, ry, rz, 8, 81, 0.8, 1.2, (nx, ny) => ny > 0.3, moss, 0);
      });
      return g;
    }
    case 'lily_crown': {
      // woven reeds with lily pads and pink-white flowers
      g.on(CH.cloth, () => {
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * Math.PI * 2;
          g.blob(Math.sin(a) * 5.6, 35.4 + Math.sin(a * 3) * 0.3, cz + Math.cos(a) * 5.4, 0.9, 0.8, 0.9, i % 2 ? vine : (x, y, z) => shade(REED, 0.85 + hv(x, y, z, 82) * 0.2));
        }
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + 0.3;
          const x = Math.sin(a) * 6;
          const z = cz + Math.cos(a) * 5.8;
          g.blob(x, 36, z, 1.6, 0.5, 1.6, (xx, yy, zz) => shade(0x5a8a32, 0.85 + hv(xx, yy, zz, 83) * 0.25));
        }
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          const x = Math.sin(a) * 6.2;
          const z = cz + Math.cos(a) * 6;
          g.blob(x, 37.2, z, 1.4, 1, 1.4, (xx, yy, zz) => (yy > 37.6 ? 0xf6e4ee : shade(0xe8a0c0, 0.9 + hv(xx, yy, zz, 84) * 0.15)));
          g.put(x, 38, z, 0xf2d040);
        }
      });
      return g;
    }
    case 'antler_rack': {
      // branching antlers tied on with vine
      const ant: ColorFn = (x, y, z) => shade(hv(x, y, z, 85) > 0.5 ? 0xc8b48a : 0xa8946a, 0.88 + hv(x, y, z, 86) * 0.18);
      g.on(CH.skin, () => {
        for (const sx of [1, -1]) {
          g.tube(sx * 3.5, 35.5, cz - 1, sx * 8, 40, cz - 2.5, 0.95, ant, 0.75);
          g.tube(sx * 8, 40, cz - 2.5, sx * 11, 45, cz - 2, 0.75, ant, 0.45);
          g.tube(sx * 6.2, 38.4, cz - 2, sx * 6.5, 43, cz + 0.5, 0.6, ant, 0.35);
          g.tube(sx * 9.3, 42.2, cz - 2.3, sx * 12.8, 42.6, cz - 1, 0.55, ant, 0.3);
          g.tube(sx * 8, 40, cz - 2.5, sx * 8.6, 44.5, cz - 4.5, 0.55, ant, 0.3);
        }
      });
      g.on(CH.cloth, () => {
        for (let i = 0; i < 30; i++) {
          const a = (i / 30) * Math.PI * 2;
          g.put(Math.sin(a) * 5.4, 35 + (i % 3 === 0 ? 0.5 : 0), cz + Math.cos(a) * 5.2, vine);
        }
      });
      return g;
    }
    case 'skull_helm': {
      // the skull of a very big crocodile: long snout over the brow, teeth, eye holes
      const sk = bone(87);
      g.on(CH.wet, () => {
        g.blob(0, 36.2, cz - 0.5, 6.4, 3.4, 6.2, sk, (x, y) => y >= 34.5);
        // snout reaching forward over the face
        g.sblob(0, 36.4, cz + 7.5, 3.6, 1.8, 5, 2.6, sk);
        g.sblob(0, 35.6, cz + 11.5, 3, 1.4, 2.2, 2.6, sk);
        // side plates over the cheeks
        for (const sx of [1, -1]) g.blob(sx * 5.8, 33, cz + 1, 1.4, 3, 3.6, sk);
      });
      g.carveP((px, py, pz) => Math.hypot(Math.abs(px) - 3.2, py - 37.4, pz - (cz + 4)) < 1.25);
      g.on(CH.wet, () => {
        for (let i = 0; i < 6; i++) {
          for (const sx of [1, -1]) g.tube(sx * 3, 34.6, cz + 5.5 + i * 1.6, sx * 3.1, 33.4, cz + 5.7 + i * 1.6, 0.45, 0xf6f0e0);
        }
      });
      g.repaint((x, y, z) => y >= 37 && (x + z) % 3 === 0 && hv(x, y, z, 88) > 0.5, CH.wet, shade(BONE_D, 0.85), true);
      return g;
    }
    default:
      return g;
  }
}

// ---------------------------------------------------------------------------------------------
// Arms (team wraps on the forearms)
// ---------------------------------------------------------------------------------------------

function buildUpperArm(): RGrid {
  const g = new RGrid(13, 15, 13, 7, 17, -7);
  const [sx, sy, sz] = A.shoulder;
  g.on(CH.skin, () => {
    g.blob(sx, sy - 0.5, sz, 4.6, 3.8, 4.4, skin(51));
    g.cyl('y', sx + 0.4, sz + 0.2, 3.7, 19, 26, skin(52));
  });
  warts(g, 0.14, 53);
  mossOver(g, (x, y) => y > 25.5, 0.45, 54);
  fungi(g, [sx, sy - 0.5, sz], [4.6, 3.8, 4.4], 2, 55, (nx, ny) => ny > 0.2 && nx > -0.3);
  return g;
}

function buildLowerArm(l: Look, hookHand: boolean): RGrid {
  const g = new RGrid(14, 17, 15, 8, 4, -7);
  const [ex, , ez] = A.elbow;
  const [hx, hy, hz] = A.hand;
  g.on(CH.skin, () => {
    for (let y = 13; y <= 21; y++) {
      const u = (y - 13) / 8;
      const r = 3.4 + Math.sin(u * Math.PI * 0.8) * 1.1;
      g.cyl('y', ex + (1 - u) * 0.4, ez + (1 - u) * 1.3, r, y, y, skin(61));
    }
    // huge hand / fist with thick knuckles
    g.blob(hx, hy + 1.6, hz + 0.4, 3.9, 3.5, 4.1, skin(62));
    g.blob(hx - 3, hy + 2.6, hz + 2.6, 1.5, 1.4, 1.6, skin(63));
    for (let i = 0; i < 4; i++) g.blob(hx + 2 - i * 1.4, hy + 3.2, hz + 3.6, 0.9, 0.9, 0.9, skin(64 + i));
  });
  warts(g, 0.1, 68);
  // claws / nails on the knuckles
  g.repaint((x, y, z) => z >= hz + 4 && y <= hy + 1 && y >= hy, CH.wet, (x, y, z) => shade(NAIL, 0.85 + hv(x, y, z, 69) * 0.15), true);
  if (hookHand) g.repaint((x, y) => y <= hy - 1, CH.skin, shade(SKIN_D, 1.05), true);
  // team arm wraps: three bands spiralling up the forearm
  const wrap = teamCloth(l.t, 70);
  g.on(CH.cloth, () => {
    for (let k = 0; k < 2; k++) {
      const y0 = 13.8 + k * 3;
      for (let a = 0; a < 28; a++) {
        const ang = (a / 28) * Math.PI * 2;
        const r = 3.9 + Math.sin(((y0 - 13) / 8) * Math.PI * 0.8) * 1.1;
        g.blob(ex + Math.cos(ang) * r * 0.97, y0 + (a / 28) * 1.6, ez + 1 + Math.sin(ang) * r * 0.97, 0.7, 0.7, 0.7, wrap);
      }
    }
  });
  return g;
}

// ---------------------------------------------------------------------------------------------
// Legs (feet slot)
// ---------------------------------------------------------------------------------------------

function buildLeg(l: Look): RGrid {
  const g = new RGrid(14, 18, 18, -1, 0, -7);
  const [lx, , lz] = A.leg;
  const feet = slug(l.feet);
  g.on(CH.skin, () => {
    g.blob(lx, 11 + UP, lz, 5.2, 4.6, 5.2, skin(81));
    for (let y = 3; y <= 9 + UP; y++) g.cyl('y', lx + 0.2, lz + 0.5, 4 + Math.sin(((y - 3) / (6 + UP)) * Math.PI) * 0.7, y, y, skin(82));
    // knee
    g.blob(lx + 0.2, 8, lz + 3.4, 2.4, 2, 1.6, skin(80));
    // big flat feet with fat toes
    g.blob(lx, 1.6, lz + 2.5, 4.3, 1.8, 5.2, skin(83));
    for (let i = 0; i < 4; i++) g.blob(lx - 2.8 + i * 1.9, 1.2, lz + 7.4 - Math.abs(i - 1.5) * 0.4, 1.05, 1.1, 1.15, skin(84 + i));
  });
  warts(g, 0.12, 88);
  mossOver(g, (x, y, z) => y > 10 || z < lz - 2, 0.25, 89);
  // toenails
  g.repaint((x, y, z) => z >= lz + 8 && y >= 1 && y <= 2, CH.wet, (x, y, z) => shade(NAIL, 0.85 + hv(x, y, z, 90) * 0.12), true);
  if (feet === 'mud_toes') {
    // caked bog mud up to the ankles, drips
    g.repaint((x, y) => y <= 3.2 + hashVox(x, 0, 0, 91) * 1.6, CH.wet, (x, y, z) => shade(hv(x, y, z, 92) > 0.7 ? 0x6a5236 : MUD, 0.8 + hv(x, y, z, 93) * 0.25), true);
    g.on(CH.wet, () => g.blob(lx, 3.4, lz + 1.5, 4.5, 1.3, 5, (x, y, z) => shade(MUD, 0.85 + hv(x, y, z, 94) * 0.2), (x, y, z) => hashVox(x, y, z, 95) > 0.35));
  } else if (feet === 'reed_wraps') {
    // feet and ankles wrapped in woven reeds
    g.on(CH.cloth, () => {
      for (let y = 1; y <= 6; y++) g.cyl('y', lx + 0.1, lz + 1.4, 4.4 - (y < 3 ? 0 : 0.2), y, y, (x, yy, z) => shade((x + yy + z) % 2 ? REED : 0x9a7e40, 0.86 + hv(x, yy, z, 96) * 0.2), 5.2 - (y < 3 ? 0 : 1.6));
      g.cyl('y', lx + 0.1, lz + 1.4, 4.7, 6, 6, vine, 4);
    });
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Held hooks (fallback). Grip at the origin, +Z = business end, the curve rises toward +Y.
// ---------------------------------------------------------------------------------------------

function buildHook(id: string): RGrid {
  const g = new RGrid(16, 18, 30, -8, -6, -4);
  switch (id) {
    case 'croc_jaw_hook': {
      // a crocodile jaw on a vine rope, teeth up
      g.on(CH.cloth, () => g.tube(0, 0, -2, 0, 0, 6, 0.7, vine));
      g.on(CH.wet, () => {
        for (const sx of [1, -1]) g.tube(sx * 0.6, 0, 6, sx * 3, 0.5, 18, 1.1, bone(101), 0.7);
        g.blob(0, 0, 6.5, 1.8, 1.4, 1.6, bone(102));
        for (let i = 0; i < 6; i++) for (const sx of [1, -1]) g.tube(sx * (1 + i * 0.35), 1, 8 + i * 1.8, sx * (1 + i * 0.35), 2.6, 8.3 + i * 1.8, 0.4, 0xf8f2e0);
      });
      return g;
    }
    case 'root_hook': {
      // a living root, gnarled, still sprouting leaves
      const root: ColorFn = (x, y, z) => shade(hv(x, y, z, 103) > 0.5 ? 0x6a4a2a : 0x54381e, 0.85 + hv(x, y, z, 104) * 0.25);
      g.on(CH.cloth, () => {
        g.tube(0, 0, -2, 0.6, -0.4, 10, 1.2, root, 1);
        for (let a = 0; a <= 14; a++) {
          const ang = -Math.PI / 2 + (a / 14) * Math.PI * 1.1;
          g.blob(Math.sin(a * 0.9) * 0.4, 3.4 + Math.sin(ang) * 3.4, 10 + Math.cos(ang) * 3.4, 1, 1, 1, root);
        }
        g.tube(0, 3.4 + 3.4 * Math.sin(-Math.PI / 2 + Math.PI * 1.1), 10 + 3.4 * Math.cos(-Math.PI / 2 + Math.PI * 1.1), 0, 5.5, 7.5, 0.6, root, 0.3);
        // leaves
        for (const [x, y, z] of [[1.5, 1.4, 4], [-1.6, 1, 7], [1.2, 6.4, 12], [-1, 3, 13.5]] as const) g.blob(x, y, z, 1.2, 0.5, 1.6, (xx, yy, zz) => shade(0x6aa040, 0.85 + hv(xx, yy, zz, 105) * 0.25));
      });
      return g;
    }
    default: {
      // vine_tusk_hook: a curved tusk wrapped in vines, dripping moss
      const tusk = bone(106);
      g.on(CH.wet, () => {
        g.tube(0, 0, -2, 0, 0.4, 8, 1.4, tusk, 1.25);
        for (let a = 0; a <= 16; a++) {
          const u = a / 16;
          const ang = -Math.PI / 2 + u * Math.PI * 0.95;
          const r = 1.25 - u * 0.75;
          g.blob(0, 4.2 + Math.sin(ang) * 4.2, 8 + Math.cos(ang) * 4.2, r, r, r, tusk);
        }
        // spikes along the outer curve
        for (const z of [3, 6]) g.tube(0, -1, z, 0, -2.6, z + 1, 0.45, tusk, 0.2);
      });
      g.on(CH.cloth, () => {
        for (let i = 0; i < 26; i++) {
          const z = -1.5 + i * 0.42;
          const ang = i * 1.2;
          g.put(Math.cos(ang) * 1.5, 0.3 + Math.sin(ang) * 1.5, z, vine);
        }
        for (const [x, z, len] of [[0.6, 2, 3], [-0.5, 5.5, 4], [0.3, 9.5, 2.5]] as const) g.tube(x, -1.2, z, x, -1.2 - len, z + 0.3, 0.45, moss, 0.3);
      });
      return g;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Back slot
// ---------------------------------------------------------------------------------------------

function buildBack(id: string): RGrid {
  const g = new RGrid(32, 26, 18, -16, 10, -20);
  if (id === 'moss_drapes') {
    // hanging moss over the shoulders and down the back
    g.on(CH.cloth, () => {
      for (let i = 0; i < 34; i++) {
        const a = -1.5 + (i / 33) * 3;
        const x = Math.sin(a) * 11.5;
        const y = 31 - Math.abs(Math.sin(a)) * 3;
        const z = -3.5 - Math.cos(a) * 8.6;
        const len = 5 + hashVox(i, 0, 0, 111) * 9;
        g.tube(x, y, z, x * 1.08, y - len, z - 1.2 - hashVox(i, 1, 0, 111), 0.75, moss, 0.4);
      }
      lumps(g, HUMP_C[0], HUMP_C[1], HUMP_C[2], HUMP_R[0], HUMP_R[1], HUMP_R[2], 18, 112, 1, 1.7, (nx, ny, nz) => ny > -0.1 && nz < 0.2, moss, 0.4);
    });
    return g;
  }
  if (id === 'stump_pack') {
    // a hollow stump strapped on with vines, snacks (berries, a fish) poking out
    const bark: ColorFn = (x, y, z) => shade((x + z + 100) % 2 ? 0x5a4028 : 0x6e5032, 0.85 + hashVox(x, Math.floor(y / 3), z, 113) * 0.25);
    g.on(CH.cloth, () => {
      for (let y = 14; y <= 28; y++) ring(g, 0, -15, y > 26 ? 3.6 : 0, 5.6 - (y - 14) * 0.06, y, y, bark);
      g.cyl('y', 0, -15, 3.6, 27, 27, (x, y, z) => shade(0xc8a46a, 0.9 + hv(x, y, z, 114) * 0.12));
      for (const sx of [-1, 1]) g.tube(sx * 4, 27, -11, sx * 6, 31, -4, 0.7, vine);
    });
    g.on(CH.wet, () => {
      g.blob(-1.5, 28.5, -15, 1.2, 1.2, 1.2, 0x8a2a4a);
      g.blob(1.2, 28.2, -14, 1, 1, 1, 0x4a2a7a);
      g.tube(0.5, 27, -16.5, 1.5, 31.5, -17, 0.8, (x, y, z) => shade(0x8fa6b0, 0.9 + hv(x, y, z, 115) * 0.15));
    });
    return g;
  }
  // firefly_jar: the string and lid; the jar itself bobs (backExtra)
  g.on(CH.cloth, () => {
    g.tube(-8, 31, -6, 0, 23, -13, 0.5, (x, y, z) => shade(REED, 0.8 + hv(x, y, z, 116) * 0.2));
    g.tube(8, 31, -6, 0, 23, -13, 0.5, (x, y, z) => shade(REED, 0.8 + hv(x, y, z, 116) * 0.2));
  });
  return g;
}

function buildBackExtra(): RGrid {
  // the firefly jar, hanging from its string (pivot at the top of the jar)
  const g = new RGrid(10, 12, 10, -5, 12, -19);
  const [bx, by, bz] = A.backExtra;
  g.on(CH.wet, () => {
    for (let y = by - 7; y <= by - 1; y++) ring(g, bx, bz, 2.6, 3.4, y, y, (x, yy, z) => shade(0xbfd8d0, 0.9 + hv(x, yy, z, 117) * 0.1));
    g.cyl('y', bx, bz, 3.4, by - 8, by - 8, 0x9ab8b0);
  });
  g.on(CH.skin, () => g.cyl('y', bx, bz, 2.6, by - 1, by, 0x6a4a2a));
  g.on(CH.pulse, () => {
    for (let i = 0; i < 7; i++) g.put(bx - 1.5 + hashVox(i, 0, 0, 118) * 3, by - 6.5 + hashVox(i, 1, 0, 118) * 4.5, bz - 1.5 + hashVox(i, 2, 0, 118) * 3, i % 2 ? 0xf6ff8a : 0xd8ff5a);
  });
  return g;
}

// ---------------------------------------------------------------------------------------------

export function ogrePalette(l: Look): PudgyPalette {
  const head = slug(l.head);
  const body = slug(l.body);
  const hat = head === 'moss_mane' ? MOSS[1] : head === 'mushroom_cap' ? 0xb8321e : head === 'lily_crown' ? 0x5a8a32 : head === 'antler_rack' ? 0xc8b48a : head === 'skull_helm' ? BONE : DREAD;
  const outfit = body === 'tooth_necklace' ? REED : body === 'frog_pouch' ? 0x7a5432 : body === 'shell_armor' ? 0x6e6a34 : body === 'glow_spots' ? 0x6ef0c0 : CLOTH;
  return { skin: SKIN, skinDark: SKIN_D, cloth: l.t.main, accent: outfit, metal: slug(l.face) === 'crystal_tusks' ? AMETHYST : BONE, extra: [MOSS[0], hat, FUNGUS, DREAD, l.t.dark] };
}

export function buildOgre(l: Look): FamilyBuild {
  const res = resOf(l.fine);
  const team = l.team;
  const body = slug(l.body);
  const face = slug(l.face);
  const head = slug(l.head);
  const feet = slug(l.feet);
  const back = slug(l.back);
  const hands = slug(l.hands) || 'vine_tusk_hook';
  const hm = hatMeta(head);
  const sk: Skeleton = { ...SK, hatExtra: up(hm.extraJoint), top: hm.top + UP };
  const faceKey = face === 'crystal_tusks' ? '' : face;
  const parts: Partial<Record<PartName, PartDef>> = {
    body: part(`ogre:body:${body}:${team}`, () => buildBody(l), A.body, res),
    head: part(`ogre:head:${faceKey}:${head === 'moss_mane' ? 'm' : ''}`, () => buildHead(l), A.neck, res),
    jaw: part(`ogre:jaw:${face === 'crystal_tusks' ? 'c' : ''}`, () => buildJaw(l), A.jaw, res),
    eyes: part('ogre:eyes', () => buildEyes(), A.eyes, res),
    upperL: part('ogre:uarm', () => buildUpperArm(), A.shoulder, res),
    upperR: partMirrored('ogre:uarm', () => buildUpperArm(), A.shoulder, res),
    lowerL: part(`ogre:larm:${team}`, () => buildLowerArm(l, false), A.elbow, res),
    lowerR: partMirrored(`ogre:larmH:${team}`, () => buildLowerArm(l, true), A.elbow, res),
    legL: part(`ogre:leg:${feet}`, () => buildLeg(l), SK.leg, res),
    legR: partMirrored(`ogre:leg:${feet}`, () => buildLeg(l), SK.leg, res),
    hook: part(`ogre:hook:${hands}`, () => buildHook(hands), [0, 0, 0], res),
    drop: part('ogre:drop', () => dropGrid(false), [0, 0, 0], 1),
  };
  if (hm.hat) parts.hat = part(`ogre:hat:${head}`, () => buildHat(head), A.hat, res);
  let backMode: BackMode = 'none';
  if (back === 'moss_drapes' || back === 'stump_pack' || back === 'firefly_jar') parts.back = part(`ogre:back:${back}`, () => buildBack(back), A.back, res);
  if (back === 'firefly_jar') {
    parts.backExtra = part('ogre:backx:firefly_jar', () => buildBackExtra(), A.backExtra, res);
    backMode = 'bob';
  }
  return {
    family: 'ogre',
    sk,
    rest: { armSplay: 0.24, armFwd: -0.2, elbow: -0.25, legSplay: 0.06, hunch: 0.1, headPitch: 0, jawRest: 0.06, holdElbow: -0.95 },
    style: { kind: 'stomp', stride: 2.3, bounce: 0.11, legSwing: 0.6, armSwing: 0.55, roll: 0.16, sway: 0.06, lean: 0.16, stomp: 1, breath: 0.26 },
    hatMode: 'none',
    hatSpin: 0,
    backMode,
    backSpin: 0,
    parts,
    palette: ogrePalette(l),
    scale: SCALE,
    hookDangles: false,
    hookMount: { pos: [0, -0.02, 0.06], rot: [1.45, 0, -Math.PI / 2] },
    hangMount: { pos: [0, -0.03, 0], rot: [Math.PI / 2, 0, 0] },
    gripMount: { pos: [0, -0.02, 0.06], rot: [1.45, 0, -Math.PI / 2] },
    puffs: [],
    corpseLift: 0.62,
    premium: face === 'crystal_tusks',
  };
}
