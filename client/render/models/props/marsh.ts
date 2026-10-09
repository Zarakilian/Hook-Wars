// Mirelight Marsh props: stilt hut, hollow swamp stump, hanging-lantern post (the post also serves the
// harbour maps with a themed finish). Origins at ground contact, +Z is the front (faces the river).
import type { PropCtx } from './buildProps.ts';
import { blob, blotch, capTop, CH, curve, h3, lampAt, mix, PGrid, pmat, rngFor, seg, shade, taper, toModel, vn3, type CFn, type PropLamp, type PropModel } from './common.ts';
import { LampSet, mossDrape, strand } from './dressing.ts';
import { grain, ironCol, lanternCage, mats, post, ropeCol, ropeWrap, snowCol, WOOD, waterline } from './kit.ts';

const SINK = 3;

/** Halo pair for a lantern at a voxel centre, relative to the model pivot. */
function lampHalos(c: [number, number, number], pivot: [number, number, number], V: number, warm = 0xffa040, size = 2.0): NonNullable<PropModel['halos']> {
  const pos: [number, number, number] = [(c[0] - pivot[0]) * V, (c[1] - pivot[1]) * V, (c[2] - pivot[2]) * V];
  return [
    { pos, color: warm, size: size * 1.15, opacity: 0.48 },
    { pos, color: 0xfff0c0, size: size * 0.34, opacity: 0.78 },
  ];
}

// ---------------------------------------------------------------------------------------------
// Stilt hut: a fisher's shack on stilts with lit windows, a porch, a lantern and a mossy roof
// ---------------------------------------------------------------------------------------------

export function buildStiltHut(r: number, seed: number, ctx: PropCtx): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 41 + 3);
  const s = Math.round((r * 0.72) / V); // wall half size
  const n = s * 2 + 26;
  const fy = SINK + Math.round(0.72 / V); // floor top
  const wallH = Math.round(1.38 / V);
  const ridge = Math.round(s * 0.85);
  const g = new PGrid(n, fy + wallH + ridge + 10, n);
  const cx = Math.floor(n / 2);
  const cz = Math.floor(n / 2);
  const theme = ctx.theme;
  const pal = WOOD[theme === 'ice' ? 'ice' : 'marsh'];
  const dark = pal.map((c) => shade(c, 0.7));
  const boards = grain(pal, seed, 1);
  const darkWood = grain(dark, seed + 1, 1);
  const wl = waterline('marsh');
  const stiltCol: CFn = (x, y, z) => wl(darkWood(x, y, z), x, y, z, SINK + 3);
  // --- stilts, bracing, a lattice skirt so the footprint reads solid at hook height
  const legs: [number, number][] = [];
  for (const sx of [-1, 0, 1]) for (const sz of [-1, 0, 1]) if (sx || sz) legs.push([cx + sx * (s - 1), cz + sz * (s - 1)]);
  for (const [lx, lz] of legs) post(g, lx + 0.5, lz + 0.5, 1.7, 0, fy - 1, stiltCol);
  for (const sz of [-1, 1]) {
    const z = cz + sz * (s - 1);
    seg(g, cx - s + 1, SINK + 1, z, cx, fy - 2, z, darkWood, 0.7);
    seg(g, cx + s - 1, SINK + 1, z, cx, fy - 2, z, darkWood, 0.7);
  }
  for (const sx of [-1, 1]) {
    const x = cx + sx * (s - 1);
    seg(g, x, SINK + 1, cz - s + 1, x, fy - 2, cz + s - 1, darkWood, 0.7);
  }
  // skirt boards with gaps on three sides, the front left open (crates and a barrel stored under)
  for (let y = SINK + 2; y < fy - 1; y++)
    for (let k = -s + 1; k <= s - 1; k++) {
      if (((k + 40) >> 1) % 2) continue;
      g.set(cx + k, y, cz - s + 1, darkWood(cx + k, y, 0));
      g.set(cx - s + 1, y, cz + k, darkWood(0, y, cz + k));
      g.set(cx + s - 1, y, cz + k, darkWood(1, y, cz + k));
    }
  g.box(cx - 5, SINK, cz + s - 7, cx - 1, SINK + 4, cz + s - 3, (x, y, z) => (y === SINK + 4 || (x + z) % 5 === 0 ? 0x5a4630 : 0x7a6040));
  taper(g, cx + 4, cz + s - 5, 2.4, 2.2, SINK, SINK + 5, (x, y, z) => (y % 3 === 0 ? 0x3a3a3c : shade(0x6a4a2c, 0.9 + h3(x, y, z) * 0.2)));
  // --- floor with a porch out front (+z)
  const porch = 6;
  g.box(cx - s - 1, fy - 1, cz - s - 1, cx + s + 1, fy, cz + s + 1 + porch, (x, y, z) => {
    const c = boards(x, y, z);
    return x % 3 === 0 ? shade(c, 0.7) : c;
  });
  for (const px of [cx - s - 1, cx + s + 1]) post(g, px + 0.5, cz + s + porch + 0.5, 1.4, 0, fy + 8, stiltCol);
  // porch rail
  g.box(cx - s - 1, fy + 7, cz + s + porch + 1, cx - 3, fy + 7, cz + s + porch + 1, darkWood);
  g.box(cx + 3, fy + 7, cz + s + porch + 1, cx + s + 1, fy + 7, cz + s + porch + 1, darkWood);
  // ladder down from the porch
  for (let y = SINK; y < fy - 1; y += 2) g.box(cx - 2, y, cz + s + porch + 2, cx + 2, y, cz + s + porch + 2, darkWood);
  g.box(cx - 2, SINK, cz + s + porch + 2, cx - 2, fy, cz + s + porch + 2, darkWood);
  g.box(cx + 2, SINK, cz + s + porch + 2, cx + 2, fy, cz + s + porch + 2, darkWood);
  // --- walls: vertical boards, darker corner posts
  const y0 = fy + 1;
  const y1 = fy + wallH;
  for (let y = y0; y <= y1; y++)
    for (let k = -s; k <= s; k++) {
      const edge = Math.abs(k) === s;
      for (const [x, z] of [[cx + k, cz - s], [cx + k, cz + s], [cx - s, cz + k], [cx + s, cz + k]] as const) {
        const c = mix(boards(x, y, z), pal[2], 0.35);
        const seam = (x + z) % 4 === 0;
        g.set(x, y, z, edge ? shade(dark[1], 0.85) : seam ? shade(c, 0.8) : c);
      }
    }
  // interior fill one voxel in (so AO and windows read deep)
  g.box(cx - s + 1, y0, cz - s + 1, cx + s - 1, y0, cz + s - 1, shade(pal[0], 0.5));
  // door on the front
  g.box(cx - 3, y0, cz + s, cx + 3, y0 + 12, cz + s, (x, y) => (x === cx - 3 || x === cx + 3 || y === y0 + 12 ? shade(dark[0], 0.8) : 0x2a1e14));
  g.box(cx - 2, y0, cz + s + 1, cx + 2, y0 + 11, cz + s + 1, (x, y, z) => ((x + 2 - cx) % 2 ? shade(pal[2], 0.85) : boards(x, y, z)));
  g.on(CH.metal, () => g.set(cx + 2, y0 + 6, cz + s + 2, 0xb89040));
  // lit windows on the other sides and one beside the door
  const win = (x0: number, z0: number, ax: 0 | 1, out: number) => {
    const wy0 = y0 + 5;
    for (let a = -2; a <= 2; a++)
      for (let b = 0; b <= 4; b++) {
        const x = ax ? x0 : x0 + a;
        const z = ax ? z0 + a : z0;
        const frame = Math.abs(a) === 2 || b === 0 || b === 4;
        const mull = a === 0 || b === 2;
        if (frame) g.set(x, wy0 + b, z, shade(dark[0], 0.8));
        else g.on(mull ? CH.base : CH.glow, () => g.set(x, wy0 + b, z, mull ? 0x3a2a1c : h3(x, b, z) < 0.3 ? 0xffc060 : 0xffd890));
      }
    // shutters
    for (const a of [-4, -3, 3, 4])
      for (let b = 0; b <= 4; b++) {
        const x = ax ? x0 + out : x0 + a;
        const z = ax ? z0 + a : z0 + out;
        g.set(x, wy0 + b, z, shade(pal[3], 0.9 + (b % 2) * 0.1));
      }
  };
  win(cx + s - 6, cz + s, 0, 1);
  win(cx - s, cz, 1, -1);
  win(cx + s, cz, 1, 1);
  win(cx, cz - s, 0, -1);
  // fishing net hanging on the west wall
  for (let y = y0 + 1; y < y0 + 10; y++)
    for (let k = -s + 2; k < -2; k++) if ((y + k) % 3 === 0 || (y - k) % 3 === 0) g.set(cx - s - 1, y, cz + k, 0x9c8a64);
  // --- roof: gable, ridge along x, shingles or reed thatch, moss, overhang
  const thatch = seed % 2 === 1;
  const ov = 3;
  const roofPal = thatch ? [0x8a7442, 0x9a8450, 0x7a6638, 0xa8925a] : [0x4a3a30, 0x54443a, 0x3e3028, 0x5e4c3e];
  const roofCol = blotch(roofPal, 0.3, seed + 7, 0.25);
  for (let k = 0; k <= ridge + 1; k++) {
    const y = y1 + 1 + k;
    const half = s + ov - k;
    if (half < 0) break;
    for (let x = cx - s - ov; x <= cx + s + ov; x++)
      for (const z of [cz - half, cz + half]) {
        let c = roofCol(x, y, z);
        if (!thatch && (x + (k % 2) * 2) % 4 === 0) c = shade(c, 0.7);
        if (thatch && h3(x, y, z, 2) < 0.2) c = shade(c, 1.15);
        g.set(x, y, z, c);
        g.set(x, y - 1, z, shade(c, 0.6));
      }
  }
  // gable ends
  for (let k = 0; k <= ridge; k++) {
    const half = s - k;
    if (half < 0) break;
    for (let z = cz - half; z <= cz + half; z++) {
      g.set(cx - s, y1 + 1 + k, z, boards(cx - s, y1 + k, z));
      g.set(cx + s, y1 + 1 + k, z, boards(cx + s, y1 + k, z));
    }
  }
  // moss drifts and a few roof patches
  capTop(g, 1, (x, y, z) => y > y1 && vn3(x * 0.16, y * 0.2, z * 0.16, seed + 5) > 0.55, (x, y, z) => mix(0x4f6a2a, 0x6a8a36, h3(x, y, z)));
  if (theme === 'ice') capTop(g, 2, (x, y) => y > y1, snowCol);
  // stovepipe
  g.on(CH.metal, () => {
    taper(g, cx + s - 3, cz - 3, 1.3, 1.3, y1 + 2, y1 + ridge + 5, ironCol(seed, 0.3));
    taper(g, cx + s - 3, cz - 3, 1.8, 1.8, y1 + ridge + 6, y1 + ridge + 6, 0x2a2a2c);
  });
  // a lantern hanging from the porch corner post
  const lx = cx + s + 1;
  const lz = cz + s + porch;
  g.box(lx, fy + 13, lz, lx, fy + 14, lz + 2, darkWood);
  const c = lanternCage(g, lx, fy + 7, lz + 2, 1, 3, 0xffb050);
  const pivot: [number, number, number] = [cx + 0.5, SINK, cz + 0.5];
  void rnd;
  const dressed = new LampSet(pivot, V);
  if (ctx.dress) {
    // Epic: a second lantern on the other porch post, and moss hanging off the roof eaves (ref04)
    const lx2 = cx - s - 1;
    g.box(lx2, fy + 13, lz, lx2, fy + 14, lz + 2, darkWood);
    dressed.add(lanternCage(g, lx2, fy + 7, lz + 2, 1, 3, 0xffb050), 'stilthut', 1.8, 0xffa040, PORCH_STANDOFF);
    const mr = rngFor(seed * 613 + 29);
    const eave = s + ov;
    for (let k = 0; k < 18; k++) {
      const x = cx - s - ov + Math.floor(mr() * (2 * (s + ov) + 1));
      const z = mr() < 0.5 ? cz - eave : cz + eave;
      strand(g, x, y1 - 1, z, 3 + Math.floor(mr() * 7), mossDrape, mr);
    }
  }
  return {
    ...toModel(g, V, { [CH.base]: mats.wood('marsh'), [CH.metal]: mats.iron(), [CH.glow]: mats.window() }, { pivot }),
    halos: [...lampHalos(c, pivot, V, 0xffa040, 1.8), { pos: [(cx - pivot[0]) * V, (y0 + 7 - SINK) * V, (s + 1.5) * V], color: 0xffb060, size: 1.4, opacity: 0.22 }, ...dressed.halos],
    lamps: [standoff(lampAt(c, pivot, V, 'stilthut'), PORCH_STANDOFF), ...dressed.lamps],
  };
}

/**
 * The porch lanterns hang a hand's width from the corner post and under a metre from the front wall: a light
 * at the glass centre burned the post white and bloomed the whole front (Epic close-ups). The light sits out
 * in front of the porch and a little higher instead; the glass and halos stay where they are.
 */
const PORCH_STANDOFF: [number, number, number] = [0, 0.15, 0.45];

function standoff(l: PropLamp, d: [number, number, number]): PropLamp {
  return { ...l, pos: [l.pos[0] + d[0], l.pos[1] + d[1], l.pos[2] + d[2]] };
}

// ---------------------------------------------------------------------------------------------
// Swamp stump: a huge broken hollow cypress stump with roots, moss, shelf fungus and ferns
// ---------------------------------------------------------------------------------------------

export function buildSwampStump(r: number, seed: number): PropModel {
  const V = 0.08;
  const rnd = rngFor(seed * 59 + 1);
  const rv = r / V;
  const H = Math.round((2.1 + (seed % 3) * 0.45) / V);
  const n = Math.ceil(rv * 3.4 + 8);
  const g = new PGrid(n, H + SINK + 10, n);
  const cx = n / 2;
  const cz = n / 2;
  const barkPal = [0x3e3428, 0x4a3e30, 0x564838, 0x342c22, 0x5e5040];
  const bark: CFn = (x, y, z) => {
    const a = Math.atan2(z + 0.5 - cz, x + 0.5 - cx);
    const furrow = Math.sin(a * 11 + vn3(x * 0.12, y * 0.04, z * 0.12, seed) * 9 + y * 0.05) > 0.62;
    const t = vn3(x * 0.5, y * 0.05, z * 0.5, seed) * 0.8 + h3(x, y, z, seed) * 0.2;
    const c = barkPal[Math.min(barkPal.length - 1, Math.floor(t * barkPal.length))];
    return furrow ? shade(c, 0.66) : c;
  };
  const heart = (x: number, y: number, z: number) => (h3(x, y, z, seed + 4) < 0.3 ? 0x8a5a32 : 0x9c6a3c);
  const tops: number[] = [];
  for (let k = 0; k < 24; k++) {
    const spike = rnd() < 0.22 ? 6 + rnd() * 8 : 0;
    tops.push(H - 6 - rnd() * 6 + spike);
  }
  const topAt = (a: number) => {
    const f = ((a + Math.PI) / (Math.PI * 2)) * 24;
    const i = Math.floor(f) % 24;
    return tops[i] + (tops[(i + 1) % 24] - tops[i]) * (f - Math.floor(f));
  };
  for (let y = 0; y <= SINK + H + 8; y++) {
    const t = Math.max(0, (y - SINK) / H);
    const flare = Math.pow(Math.max(0, 1 - t * 2.4), 2);
    const R = rv * (0.92 + flare * 0.55);
    const inner = y > SINK + H * 0.35 ? R - 3.2 : -1;
    for (let z = Math.floor(cz - R - 3); z <= Math.ceil(cz + R + 3); z++)
      for (let x = Math.floor(cx - R - 3); x <= Math.ceil(cx + R + 3); x++) {
        const dx = x + 0.5 - cx;
        const dz = z + 0.5 - cz;
        const a = Math.atan2(dz, dx);
        const lobes = 1 + flare * 0.35 * Math.cos(a * 6 + seed) + 0.06 * Math.cos(a * 13 + seed * 2);
        const d = Math.hypot(dx, dz) / lobes;
        if (d > R) continue;
        if (y > SINK + topAt(a)) continue;
        if (d < inner) continue;
        const rimTop = y > SINK + topAt(a) - 2;
        g.set(x, y, z, d > R - 1.2 ? bark(x, y, z) : rimTop ? heart(x, y, z) : shade(heart(x, y, z), 0.7));
      }
  }
  // dark hollow floor inside
  taper(g, cx, cz, rv * 0.92 - 3.2, rv * 0.92 - 3.2, SINK + Math.round(H * 0.35), SINK + Math.round(H * 0.35), 0x1e1812);
  // roots crawling out along the ground
  const nr = 6 + (seed % 3);
  for (let k = 0; k < nr; k++) {
    const a = (k / nr) * Math.PI * 2 + rnd() * 0.5;
    const L = rv * (1.35 + rnd() * 0.3);
    curve(g, [cx + Math.cos(a) * rv * 0.8, SINK + 5, cz + Math.sin(a) * rv * 0.8], [cx + Math.cos(a) * L * 0.8, SINK + 3, cz + Math.sin(a) * L * 0.8], [cx + Math.cos(a) * L, SINK - 1, cz + Math.sin(a) * L], 2.2, 1.0, bark);
  }
  // moss collar, moss on the rim and roots
  g.recolor((c, x, y, z) => (y < SINK + 6 && y >= SINK - 1 && h3(x, y, z, 5) < 0.5 ? mix(c, 0x4a6a28, 0.7) : c));
  capTop(g, 1, (x, y, z) => (y > SINK + 6 ? vn3(x * 0.2, y * 0.2, z * 0.2, seed + 9) > 0.45 : vn3(x * 0.2, y * 0.2, z * 0.2, seed + 9) > 0.62), (x, y, z) => mix(0x4f7a2c, 0x7a9a3a, h3(x, y, z, 3)));
  // shelf fungus brackets, a few glowing
  for (let k = 0; k < 7; k++) {
    const a = rnd() * Math.PI * 2;
    const y = SINK + 4 + Math.floor(rnd() * H * 0.7);
    const R = rv * 0.95;
    const fx = cx + Math.cos(a) * (R + 0.5);
    const fz = cz + Math.sin(a) * (R + 0.5);
    const glow = k < 3;
    g.on(glow ? CH.glow2 : CH.base, () => {
      for (let i = -2; i <= 2; i++)
        for (let j = 0; j <= 2 - Math.abs(i) / 2; j++) g.set(fx - Math.sin(a) * i + Math.cos(a) * j, y, fz + Math.cos(a) * i + Math.sin(a) * j, glow ? (j === 0 ? 0x6af0c8 : 0xa8ffe0) : j === 0 ? 0xc8a878 : 0xe0c898);
    });
  }
  // hanging moss strands and ferns sprouting from the rim
  g.on(CH.leaf, () => {
    for (let k = 0; k < 14; k++) {
      const a = rnd() * Math.PI * 2;
      const R = rv * 0.95 + 0.5;
      const x = Math.floor(cx + Math.cos(a) * R);
      const z = Math.floor(cz + Math.sin(a) * R);
      const ytop = SINK + Math.floor(topAt(a)) - 1;
      const len = 3 + Math.floor(rnd() * 8);
      for (let j = 0; j < len; j++) g.set(x, ytop - j, z, shade(0x6f7c5a, 0.85 + h3(x, j, z) * 0.25));
    }
    for (let k = 0; k < 4; k++) {
      const a = rnd() * Math.PI * 2;
      const R = rv * 0.9;
      const bx = cx + Math.cos(a) * R;
      const bz = cz + Math.sin(a) * R;
      const by = SINK + topAt(a);
      for (let f = 0; f < 4; f++) {
        const fa = a + (f - 1.5) * 0.6;
        curve(g, [bx, by, bz], [bx + Math.cos(fa) * 3, by + 5, bz + Math.sin(fa) * 3], [bx + Math.cos(fa) * 7, by + 2, bz + Math.sin(fa) * 7], 0.5, 0.5, (x, y, z) => (h3(x, y, z) < 0.4 ? 0x4a7a2c : 0x5e9036));
      }
    }
  });
  const halos: NonNullable<PropModel['halos']> = [];
  const lamps: NonNullable<PropModel['lamps']> = [];
  if (seed % 3 === 0) {
    // a lantern hung on a broken branch stub
    const a = 0.6;
    const bx = cx + Math.cos(a) * rv * 0.9;
    const bz = cz + Math.sin(a) * rv * 0.9;
    const by = SINK + Math.round(H * 0.62);
    seg(g, bx, by, bz, bx + Math.cos(a) * 6, by + 2, bz + Math.sin(a) * 6, bark, 1.1);
    const lx = Math.round(bx + Math.cos(a) * 6);
    const lz = Math.round(bz + Math.sin(a) * 6);
    g.on(CH.metal, () => g.box(lx, by - 1, lz, lx, by + 1, lz, 0x2a2a2a));
    const c = lanternCage(g, lx, by - 7, lz, 1, 3, 0xffc070);
    halos.push(...lampHalos(c, [cx, SINK, cz], V, 0xffa040, 1.7));
    lamps.push(lampAt(c, [cx, SINK, cz], V, 'lantern'));
  }
  return {
    ...toModel(g, V, { [CH.base]: pmat({ rough: 0.95 }), [CH.leaf]: mats.leaf(0.04, 2.5), [CH.metal]: mats.iron(), [CH.glow]: mats.lamp(), [CH.glow2]: pmat({ glow: 1.8, pulse: 0.5, rough: 0.5 }) }, { pivot: [cx, SINK, cz] }),
    halos,
    lamps,
  };
}

// ---------------------------------------------------------------------------------------------
// Lantern post: a tall timber post with an arm and a hanging lantern (iron on the wharf, snowy on ice)
// ---------------------------------------------------------------------------------------------

export function buildLanternPost(r: number, seed: number, ctx: PropCtx): PropModel {
  const V = 0.05;
  const rv = r / V;
  const theme = ctx.theme;
  const H = Math.round(2.75 / V);
  const arm = Math.round(0.62 / V);
  const n = Math.ceil(rv * 2 + 10);
  const g = new PGrid(n, H + SINK + 6, n + arm + 4);
  const cx = Math.floor(n / 2);
  const cz = Math.floor(n / 2);
  const pal = WOOD[theme];
  const wood = grain(pal.map((c) => shade(c, 0.85)), seed, 1);
  const iron = theme === 'wharf';
  const pw = Math.max(4, Math.round(rv * 1.15)); // the post fills the collision circle at hook height
  // base: a cairn of stones (or a cast plinth on the wharf)
  if (iron) {
    g.on(CH.metal, () => {
      taper(g, cx + 0.5, cz + 0.5, rv, rv * 0.85, 0, SINK + 3, ironCol(seed, 0.12));
      taper(g, cx + 0.5, cz + 0.5, rv * 0.7, rv * 0.7, SINK + 4, SINK + 6, 0x8a7a40);
    });
  } else {
    const stone = blotch([0x5a5a52, 0x6a6a60, 0x4e4e48, 0x76766a], 0.4, seed, 0.3);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + seed;
      blob(g, cx + 0.5 + Math.cos(a) * rv * 0.75, SINK, cz + 0.5 + Math.sin(a) * rv * 0.75, 2.6, 2.2, 2.6, 0.2, seed + k, stone, 0.4);
    }
    if (theme === 'ice') capTop(g, 1, () => true, snowCol);
    else capTop(g, 1, (x, y, z) => h3(x, y, z, 2) < 0.4, 0x4f6a2a);
  }
  // the post: square timber, slight lean, rope wraps
  const lean = theme === 'marsh' ? 0.035 : 0.01;
  g.on(iron ? CH.metal : CH.base, () => {
    for (let y = 0; y <= SINK + H; y++) {
      const ox = Math.round(Math.sin(y * 0.04 + seed) * lean * y);
      const c = iron ? ironCol(seed, 0.1) : wood;
      g.box(cx - (pw >> 1) + ox, y, cz - (pw >> 1), cx + ((pw - 1) >> 1) + ox, y, cz + ((pw - 1) >> 1), c);
    }
  });
  const topX = cx + Math.round(Math.sin((SINK + H) * 0.04 + seed) * lean * (SINK + H));
  if (!iron) {
    ropeWrap(g, cx + 0.5, cz + 0.5, pw * 0.7 + 0.6, SINK + 18, 3);
    ropeWrap(g, topX + 0.5, cz + 0.5, pw * 0.7 + 0.6, SINK + H - 14, 2);
  }
  // arm toward +z with a diagonal brace
  const ay = SINK + H - 3;
  g.on(iron ? CH.metal : CH.base, () => {
    const c = iron ? ironCol(seed + 1, 0.1) : wood;
    g.box(topX - 1, ay, cz, topX + 1, ay + 2, cz + arm, c);
    seg(g, topX, ay - 9, cz + 1, topX, ay, cz + arm - 3, c, 0.8);
    if (iron) for (let k = 0; k < 10; k++) g.set(topX, ay + 3 + Math.round(Math.sin(k * 0.6) * 1.5), cz + 2 + k, 0x8a7a40);
  });
  // chain and lantern
  const lz = cz + arm - 1;
  g.on(CH.metal, () => {
    for (let k = 1; k <= 4; k++) g.set(topX + (k % 2), ay - k, lz, 0x2c2c30);
  });
  const glow = theme === 'ice' ? 0xffd890 : theme === 'marsh' ? 0xffc060 : 0xffc870;
  const c = lanternCage(g, topX, ay - 17, lz, 3, 9, glow);
  if (theme === 'ice') {
    g.box(topX - 2, SINK + H + 1, cz - 2, topX + 2, SINK + H + 1, cz + 2, snowCol);
    g.box(topX - 1, ay + 3, cz, topX + 1, ay + 3, cz + arm, snowCol);
    g.on(CH.ice, () => {
      for (let k = 2; k < arm; k += 3) g.box(topX, ay - 1 - (k % 4), cz + k, topX, ay - 1, cz + k, 0xc8ecfa);
    });
  }
  const pivot: [number, number, number] = [cx + 0.5, SINK, cz + 0.5];
  return {
    ...toModel(g, V, { [CH.base]: mats.wood(theme), [CH.metal]: mats.iron(), [CH.glow]: mats.lamp(), [CH.ice]: mats.ice() }, { pivot }),
    halos: lampHalos(c, pivot, V, theme === 'ice' ? 0xffb860 : 0xffa040, 2.3),
    lamps: [lampAt(c, pivot, V, 'lanternpost')],
  };
}

export { ropeCol };
