// Effects: hook chains, impacts, splashes, debris, damage numbers.
//
// Everything draws through a handful of pooled batches (see ./particles.ts): one billboard batch
// (additive and alpha particles share one premultiplied draw), one lit voxel-cube batch for debris,
// a fixed set of flash lights, pooled damage-number sprites and pooled chain views. Counts scale with
// the quality tier. Effect methods only read p.x / p.y / p.z, so plain {x,y,z} objects work too.
import * as THREE from 'three';
import type { FamilyId, HazardKind, RuneType, Team } from '../../../shared/types.ts';
import { TEAM_COLORS, type ChainView, type DamageKind, type Engine, type FxSystem, type PudgyPalette, type Quality } from '../contracts.ts';
import { shade } from '../voxel/voxel.ts';
import { ChainFactory, type ChainImpl } from './chains.ts';
import { DamageNumbers } from './numbers.ts';
import { CubeBatch, LightPool, PF, Shape, SpriteBatch, rand, type CubeSpec, type SpriteSpec } from './particles.ts';

interface Tier {
  sprites: number;
  cubes: number;
  lights: number;
  numbers: number;
  crits: number;
  k: number;
  cubeShadow: boolean;
}

const TIERS: Record<Quality, Tier> = {
  low: { sprites: 700, cubes: 260, lights: 0, numbers: 20, crits: 3, k: 0.5, cubeShadow: false },
  medium: { sprites: 1600, cubes: 600, lights: 1, numbers: 28, crits: 4, k: 0.8, cubeShadow: false },
  high: { sprites: 2800, cubes: 1000, lights: 2, numbers: 32, crits: 5, k: 1, cubeShadow: true },
  ultra: { sprites: 4200, cubes: 1600, lights: 3, numbers: 40, crits: 6, k: 1.3, cubeShadow: true },
};

export const RUNE_FX_COLORS: Record<RuneType, number> = {
  haste: 0xff4a3a,
  double: 0x4a8cff,
  ironskin: 0xffc030,
  ghost: 0xbdf4ff,
  bounty: 0xffe060,
};

type Surface = 'ground' | 'shallow' | 'ice' | 'snow' | 'sand' | 'mud';
type P = { x: number; y: number; z: number };

interface Emitter {
  active: boolean;
  x: number;
  y: number;
  z: number;
  t: number;
  life: number;
  acc: number;
  splash: number;
}

const TAU = Math.PI * 2;

export function createFx(engine: Engine, quality: Quality): FxSystem {
  const tier = TIERS[quality] ?? TIERS.medium;
  const scene = engine.scene;
  const root = new THREE.Group();
  root.name = 'fx';
  scene.add(root);

  const sprites = new SpriteBatch(tier.sprites);
  const cubes = new CubeBatch(tier.cubes, tier.cubeShadow);
  const lights = new LightPool(tier.lights);
  const numbers = new DamageNumbers(tier.numbers, tier.crits);
  root.add(sprites.mesh, cubes.mesh, lights.group, numbers.group);
  const chains = new ChainFactory(root, sprites, quality);
  // one chain of every style, built now and rendered once invisibly on the first frame
  let warmChains: ChainImpl[] | null = chains.prebuild();
  let warmState = 0; // 0 = warm next frame, 1 = release next frame, 2 = done

  const emitters: Emitter[] = [];
  for (let i = 0; i < 12; i++) emitters.push({ active: false, x: 0, y: 0, z: 0, t: 0, life: 0, acc: 0, splash: 0 });

  const camDir = new THREE.Vector3();
  let disposed = false;

  /** count scaled by tier */
  const n = (c: number) => Math.max(1, Math.round(c * tier.k));

  // ------------------------------------------------------------------------------------------
  // building blocks
  // ------------------------------------------------------------------------------------------

  function glow(x: number, y: number, z: number, hex: number, k: number, s0: number, s1: number, life: number, alpha = 1): void {
    const s = sprites.begin(Shape.Glow);
    s.pos(x, y, z).color(hex, k).size(s0, s1);
    s.life = life;
    s.alpha = alpha;
    s.fin = 0.01;
    s.fpow = 1.6;
    sprites.emit(s);
  }

  function star(x: number, y: number, z: number, hex: number, k: number, s0: number, s1: number, life: number): void {
    const s = sprites.begin(Shape.Star);
    s.pos(x, y, z).color(hex, k).size(s0, s1);
    s.life = life;
    s.fin = 0.01;
    s.fpow = 1.4;
    s.rot = Math.random() * 0.8 - 0.4;
    sprites.emit(s);
  }

  /** Comic impact burst: jagged spikes, white-hot core, pops big and vanishes. */
  function burst(x: number, y: number, z: number, hex: number, k: number, s0: number, s1: number, life: number, core = 0.5, flat = false, alpha = 1): void {
    const s = sprites.begin(Shape.Burst);
    s.pos(x, y, z).color(hex, k).size(s0, s1);
    s.flags = PF.EaseSize | (flat ? PF.Flat : 0);
    s.alpha = alpha;
    s.life = life;
    s.param = core;
    s.blend = 1;
    s.fin = 0.01;
    s.fpow = 0.45;
    s.rotV = (Math.random() - 0.5) * 2;
    sprites.emit(s);
  }

  function ring(x: number, y: number, z: number, flat: boolean, hex: number, k: number, s0: number, s1: number, life: number, thick: number, blend = 0, alpha = 1): void {
    const s = sprites.begin(Shape.Ring);
    s.pos(x, y, z).color(hex, k).size(s0, s1);
    s.flags = PF.EaseSize | (flat ? PF.Flat : 0);
    s.life = life;
    s.param = thick;
    s.blend = blend;
    s.alpha = alpha;
    s.fin = 0.01;
    s.fpow = 1.2;
    sprites.emit(s);
  }

  /** Streak sparks in a spray. up: 0 = full sphere-ish, 1 = straight up. */
  function sparks(x: number, y: number, z: number, count: number, vmin: number, vmax: number, hex: number, hexEnd: number, k: number, life: number, up: number, size = 0.08, grav = -15): void {
    for (let i = 0; i < count; i++) {
      const s = sprites.begin(Shape.Spark);
      const a = Math.random() * TAU;
      const vy = up + (Math.random() * 2 - 1) * (1 - Math.abs(up)) * 0.8;
      const h = Math.sqrt(Math.max(0.05, 1 - vy * vy));
      const v = rand(vmin, vmax);
      s.pos(x, y, z).vel(Math.cos(a) * h * v, vy * v, Math.sin(a) * h * v);
      s.color(hex, k).colorEnd(hexEnd, k * 0.6);
      s.flags = PF.Stretch;
      s.stretch = 0.045;
      s.size(size * rand(0.8, 1.3), size * 0.35);
      s.life = life * rand(0.6, 1.2);
      s.grav = grav;
      s.drag = 2.2;
      s.fin = 0.01;
      if (!sprites.emit(s)) return;
    }
  }

  function puff(s: SpriteSpec, x: number, y: number, z: number, hex: number, alpha: number, s0: number, s1: number, life: number): SpriteSpec {
    s.reset(Shape.Puff);
    s.pos(x, y, z).color(hex).size(s0, s1);
    s.blend = 1;
    s.alpha = alpha;
    s.life = life;
    s.fin = 0.12;
    s.fpow = 1.3;
    s.rotV = (Math.random() - 0.5) * 1.5;
    return s;
  }

  /** Ring of dust puffs rolling outward along the ground. */
  function dustRing(x: number, y: number, z: number, count: number, hex: number, alpha: number, speed: number, s0: number, s1: number, life: number): void {
    const off = Math.random() * TAU;
    for (let i = 0; i < count; i++) {
      const a = off + (i / count) * TAU + Math.random() * 0.3;
      const s = puff(sprites.spec, x + Math.cos(a) * 0.35, y, z + Math.sin(a) * 0.35, hex, alpha, s0, s1, life * rand(0.8, 1.2));
      const v = speed * rand(0.7, 1.2);
      s.vel(Math.cos(a) * v, rand(0.2, 0.8), Math.sin(a) * v);
      s.drag = 3.2;
      s.grav = 0.3;
      if (!sprites.emit(s)) return;
    }
  }

  function chunk(c: CubeSpec, x: number, y: number, z: number, color: number, size: number, floorY: number, life: number): CubeSpec {
    c.reset();
    c.x = x;
    c.y = y;
    c.z = z;
    c.color = color;
    c.cube(size);
    c.floorY = floorY;
    c.life = life;
    return c;
  }

  function spray(c: CubeSpec, vmin: number, vmax: number, upMin: number, upMax: number): CubeSpec {
    const a = Math.random() * TAU;
    const v = rand(vmin, vmax);
    c.vx = Math.cos(a) * v;
    c.vz = Math.sin(a) * v;
    c.vy = rand(upMin, upMax);
    return c;
  }

  function chips(x: number, y: number, z: number, count: number, palette: readonly number[], smin: number, smax: number, floorY: number, vmin: number, vmax: number, upMin: number, upMax: number, life: number, glowK = 0): void {
    for (let i = 0; i < count; i++) {
      const col = palette[(Math.random() * palette.length) | 0];
      const c = chunk(cubes.spec, x + rand(-0.15, 0.15), y + rand(-0.1, 0.15), z + rand(-0.15, 0.15), shade(col, rand(0.88, 1.12)), rand(smin, smax), floorY, life * rand(0.8, 1.2));
      spray(c, vmin, vmax, upMin, upMax);
      c.glow = glowK;
      if (!cubes.emit(c)) return;
    }
  }

  function droplets(x: number, y: number, z: number, count: number, hex: number, alpha: number, smin: number, smax: number, vmin: number, vmax: number, upMin: number, upMax: number, floorY: number, life: number): void {
    for (let i = 0; i < count; i++) {
      const s = sprites.begin(Shape.Drop);
      const a = Math.random() * TAU;
      const v = rand(vmin, vmax);
      const sz = rand(smin, smax);
      s.pos(x + Math.cos(a) * 0.2, y, z + Math.sin(a) * 0.2).vel(Math.cos(a) * v, rand(upMin, upMax), Math.sin(a) * v);
      s.color(hex).size(sz, sz * 0.55);
      s.blend = 1;
      s.alpha = alpha;
      s.life = life * rand(0.7, 1.2);
      s.grav = -17;
      s.drag = 0.4;
      s.floorY = floorY;
      s.flags = PF.FloorKill;
      s.fin = 0.02;
      s.fpow = 0.5;
      if (!sprites.emit(s)) return;
    }
  }

  function swirl(x: number, y: number, z: number, count: number, hex: number, hexEnd: number, k: number, r0: number, rv: number, w: number, vyMin: number, vyMax: number, life: number, size: number): void {
    const off = Math.random() * TAU;
    for (let i = 0; i < count; i++) {
      const s = sprites.begin(Shape.Glow);
      s.flags = PF.Orbit;
      s.ocx = x;
      s.ocz = z;
      s.orad = r0 * rand(0.75, 1.15);
      s.orv = rv;
      s.oang = off + (i / count) * TAU;
      s.ow = w * (i & 1 ? 1 : 0.8);
      s.pos(x, y + rand(-0.1, 0.4), z).vel(0, rand(vyMin, vyMax), 0);
      s.color(hex, k).colorEnd(hexEnd, k * 0.7).size(size, size * 0.25);
      s.life = life * rand(0.75, 1.15);
      s.drag = 0.3;
      s.fin = 0.08;
      s.fpow = 0.8;
      if (!sprites.emit(s)) return;
    }
  }

  function sparkles(x: number, y: number, z: number, count: number, hex: number, k: number, size: number, vmin: number, vmax: number, upMin: number, upMax: number, life: number): void {
    for (let i = 0; i < count; i++) {
      const s = sprites.begin(Shape.Star);
      const a = Math.random() * TAU;
      const v = rand(vmin, vmax);
      s.pos(x, y, z).vel(Math.cos(a) * v, rand(upMin, upMax), Math.sin(a) * v);
      s.color(hex, k).size(size * rand(1, 1.8), size * 0.3);
      s.life = life * rand(0.7, 1.25);
      s.drag = 2;
      s.grav = -3;
      s.rotV = (Math.random() - 0.5) * 6;
      s.fin = 0.05;
      s.fpow = 0.8;
      if (!sprites.emit(s)) return;
    }
  }

  function leaves(x: number, y: number, z: number, count: number, palette: readonly number[], size: number, vmin: number, vmax: number, upMin: number, upMax: number, floorY: number, life: number): void {
    for (let i = 0; i < count; i++) {
      const s = sprites.begin(Shape.Leaf);
      const a = Math.random() * TAU;
      const v = rand(vmin, vmax);
      s.pos(x, y, z).vel(Math.cos(a) * v, rand(upMin, upMax), Math.sin(a) * v);
      s.color(palette[(Math.random() * palette.length) | 0]).size(size * rand(0.8, 1.2));
      s.blend = 1;
      s.life = life * rand(0.8, 1.2);
      s.grav = -4.5;
      s.drag = 2.4;
      s.rotV = (Math.random() - 0.5) * 12;
      s.wobble = 1.6;
      s.wobbleF = 7;
      s.floorY = floorY;
      s.flags = PF.FloorStop;
      s.fin = 0.03;
      s.fpow = 0.5;
      if (!sprites.emit(s)) return;
    }
  }

  function shards(x: number, y: number, z: number, count: number, hex: number, k: number, blend: number, size: number, vmin: number, vmax: number, upMin: number, upMax: number, life: number): void {
    for (let i = 0; i < count; i++) {
      const s = sprites.begin(Shape.Shard);
      const a = Math.random() * TAU;
      const v = rand(vmin, vmax);
      s.pos(x, y, z).vel(Math.cos(a) * v, rand(upMin, upMax), Math.sin(a) * v);
      s.color(hex, k).size(size * rand(0.7, 1.3), size * 0.3);
      s.blend = blend;
      s.life = life * rand(0.7, 1.2);
      s.grav = -10;
      s.drag = 1.5;
      s.rotV = (Math.random() - 0.5) * 10;
      s.fin = 0.02;
      if (!sprites.emit(s)) return;
    }
  }

  // ------------------------------------------------------------------------------------------
  // effect recipes
  // ------------------------------------------------------------------------------------------

  const JUICE = [0xff5a3a, 0xffb23a, 0xfff1d6, 0xff8a5a, 0xffd84a] as const;
  const GOLD = [0xffd23a, 0xfff2a0, 0xffb000, 0xffe27a] as const;
  const DUST = [0x8a7a62, 0x6f6352, 0xa89878, 0x5d5446] as const;
  const METAL = [0xc8ced6, 0x9aa2ab, 0xe8eef4] as const;
  const DIRT = [0x5a4430, 0x6b5238, 0x4a3a28, 0x3f5a22, 0x5f7f2e, 0x2e2a28] as const;
  const GREENS = [0x5f9a30, 0x7cbf3e, 0x4a7a26, 0x8fd04a] as const;
  const ICE = [0xdff6ff, 0xa8e2ff, 0x7cc8f0, 0xffffff] as const;
  const SAND = [0xd8c08a, 0xc4a870, 0xe8d4a0] as const;
  const BRISTLE = [0x4a2a4a, 0x8a4a8a, 0x6a2a6a] as const;
  const TWIGS = [0x5a4026, 0x6e5030, 0x4a3420] as const;
  const IRONSKIN = [0xffc030, 0xffe07a, 0xd99a10] as const;
  const SNOW = [0xffffff, 0xeef6ff] as const;

  function hookHit(p: P, bull: boolean, ally: boolean): void {
    const { x, y, z } = p;
    if (ally) {
      glow(x, y, z, 0x8dff9a, 1.3, 1.8, 2.6, 0.2, 0.7);
      swirl(x, y - 0.7, z, n(26), 0x9dffa0, 0x2affb0, 2.4, 0.75, 0.5, 9, 1.4, 2.6, 0.85, 0.24);
      sparkles(x, y, z, n(8), 0xc8ffd0, 2.4, 0.42, 1, 2.5, 1.5, 3.5, 0.8);
      ring(x, y - 0.95, z, true, 0x7dff8a, 1.8, 0.4, 2.8, 0.5, 0.18, 0, 0.9);
      lights.flash(x, y + 0.5, z, 0x7dff8a, 25, 8, 0.35);
      return;
    }
    const ground = y - 1;
    glow(x, y, z, 0xffffff, 1.1, 1, 1.4, 0.05);
    glow(x, y, z, bull ? 0xffc23a : 0xff6a2a, 1, bull ? 3 : 2.2, bull ? 3.8 : 2.8, bull ? 0.16 : 0.11, 0.3);
    burst(x, y + 0.1, z, bull ? 0xffc23a : 0xff7a2a, 1.35, bull ? 2 : 1.4, bull ? 4.6 : 3.2, bull ? 0.2 : 0.15, 0.4);
    ring(x, y, z, false, bull ? 0xffe27a : 0xffd0b0, 1.2, 0.6, bull ? 4 : 3, 0.22, 0.12);
    sparks(x, y, z, n(bull ? 40 : 24), bull ? 9 : 8, bull ? 20 : 16, bull ? 0xfff0a0 : 0xffd890, bull ? 0xffb000 : 0xff5a1a, 2.2, 0.42, 0.18, 0.16);
    chips(x, y, z, n(bull ? 14 : 10), bull ? GOLD : JUICE, 0.16, 0.27, ground, 2, 5.5, 3, 7.5, 1.3, bull ? 1.3 : 0.3);
    dustRing(x, ground + 0.15, z, n(6), 0xc9b9a0, 0.5, 3, 0.5, 1.5, 0.65);
    if (bull) {
      ring(x, ground + 0.04, z, true, 0xffd23a, 2.4, 0.6, 6, 0.55, 0.16, 0, 0.95);
      ring(x, ground + 0.05, z, true, 0xfff2a0, 1.8, 0.3, 4, 0.75, 0.12, 0, 0.8);
      sparkles(x, y, z, n(16), 0xffe27a, 2.6, 0.5, 2, 4.5, 2, 5, 1);
      lights.flash(x, y + 0.6, z, 0xffd060, 70, 11, 0.35);
    } else {
      ring(x, ground + 0.04, z, true, 0xffb080, 1.4, 0.5, 3.2, 0.4, 0.18, 0, 0.7);
      lights.flash(x, y + 0.6, z, 0xff8a3a, 40, 9, 0.25);
    }
  }

  function hookClash(p: P): void {
    const { x, y, z } = p;
    glow(x, y, z, 0xe8f4ff, 1.3, 1.6, 2.4, 0.08);
    burst(x, y, z, 0x8ad0ff, 1, 1.6, 3.8, 0.16, 0.55);
    star(x, y, z, 0xffffff, 1.6, 3, 4.2, 0.12);
    sparks(x, y, z, n(34), 10, 24, 0xf0f8ff, 0x8ac8ff, 2.4, 0.36, 0, 0.15, -12);
    ring(x, y, z, false, 0xdff0ff, 1.6, 0.4, 5, 0.3, 0.1);
    ring(x, y - 0.93, z, true, 0xcfe8ff, 1.6, 0.5, 4.6, 0.42, 0.14, 0, 0.75);
    chips(x, y, z, n(8), METAL, 0.11, 0.18, y - 0.95, 4, 8, 2, 6, 1, 0.2);
    lights.flash(x, y + 0.5, z, 0xbfe0ff, 55, 10, 0.22);
  }

  function hookWall(p: P): void {
    const { x, y, z } = p;
    glow(x, y, z, 0xffd9a0, 1.5, 1, 1.6, 0.08);
    burst(x, y, z, 0xd8c09a, 1, 0.7, 1.8, 0.11, 0.45);
    sparks(x, y, z, n(12), 5, 11, 0xffe0a0, 0xff7a2a, 2.8, 0.3, 0.2, 0.13);
    for (let i = 0, c = n(7); i < c; i++) {
      const s = puff(sprites.spec, x + rand(-0.2, 0.2), y + rand(-0.2, 0.2), z + rand(-0.2, 0.2), i & 1 ? 0xb9a58a : 0x9f907a, 0.55, 0.35, rand(1.1, 1.7), rand(0.6, 1));
      const a = Math.random() * TAU;
      s.vel(Math.cos(a) * rand(1, 2.8), rand(0.3, 1.4), Math.sin(a) * rand(1, 2.8));
      s.drag = 3;
      s.grav = 0.4;
      if (!sprites.emit(s)) break;
    }
    chips(x, y, z, n(8), DUST, 0.12, 0.2, y - 0.95, 2.5, 5, 2, 5, 1.1);
  }

  function hookBounce(p: P): void {
    const { x, y, z } = p;
    glow(x, y, z, 0x7fd0ff, 1.1, 1.2, 1.8, 0.08);
    burst(x, y, z, 0x5ab8ff, 1, 1, 2.4, 0.13, 0.45);
    ring(x, y, z, false, 0x9fe0ff, 2, 0.3, 2.8, 0.26, 0.2);
    ring(x, y, z, false, 0x9fe0ff, 1.6, 0.2, 1.8, 0.34, 0.22);
    sparks(x, y, z, n(18), 6, 13, 0xbfeaff, 0x2a8aff, 2.4, 0.32, 0.1, 0.13);
    swirl(x, y - 0.2, z, n(10), 0x7fd0ff, 0x3a9aff, 2.6, 0.2, 2.6, 14, 1, 2, 0.42, 0.16);
    lights.flash(x, y + 0.4, z, 0x7fd0ff, 25, 8, 0.2);
  }

  function splash(p: P, strength: number): void {
    const st = Math.max(0.1, Math.min(1, strength));
    const { x, y, z } = p;
    const big = 0.8 + 0.6 * st;
    // cartoon foam splat on the surface
    burst(x, y + 0.04, z, 0xffffff, 1, 0.6, 2.2 + 1.8 * st, 0.28 + 0.2 * st, 0, true, 0.9);
    // crown: a ring of drops thrown up and out
    const crown = n(10 + 12 * st);
    for (let i = 0; i < crown; i++) {
      const a = (i / crown) * TAU + Math.random() * 0.3;
      const s = sprites.begin(Shape.Drop);
      const v = rand(1.6, 3.2) * (0.6 + st);
      const sz = rand(0.16, 0.3) * big;
      s.pos(x + Math.cos(a) * 0.45, y + 0.08, z + Math.sin(a) * 0.45).vel(Math.cos(a) * v, rand(3.5, 6.5) * (0.6 + 0.6 * st), Math.sin(a) * v);
      s.color(0xeefaff).size(sz, sz * 0.5);
      s.blend = 1;
      s.alpha = 0.95;
      s.life = rand(0.6, 1);
      s.grav = -17;
      s.floorY = y - 0.02;
      s.flags = PF.FloorKill;
      s.fin = 0.02;
      s.fpow = 0.4;
      if (!sprites.emit(s)) break;
    }
    droplets(x, y + 0.06, z, n(6 + 14 * st), 0xe8f8ff, 0.92, 0.14 * big, 0.28 * big, 0.5, 2 * (0.6 + st), 4 * (0.5 + 0.7 * st), 9 * (0.5 + 0.7 * st), y - 0.02, 1);
    // splash column
    for (let i = 0, c = n(3 + 6 * st); i < c; i++) {
      const s = sprites.begin(Shape.Spark);
      s.pos(x + rand(-0.3, 0.3), y + 0.05, z + rand(-0.3, 0.3)).vel(rand(-0.6, 0.6), rand(6, 11) * (0.5 + 0.6 * st), rand(-0.6, 0.6));
      s.flags = PF.Stretch | PF.FloorKill;
      s.floorY = y - 0.02;
      s.stretch = 0.06;
      s.color(0xf2fbff).size(0.22 * big, 0.1);
      s.blend = 1;
      s.alpha = 0.9;
      s.life = rand(0.45, 0.7);
      s.grav = -20;
      if (!sprites.emit(s)) break;
    }
    ring(x, y + 0.03, z, true, 0xffffff, 1, 0.4, 2 + 2.6 * st, 0.7 + 0.4 * st, 0.2, 1, 0.85);
    ring(x, y + 0.035, z, true, 0xdff4ff, 1, 0.2, 1.1 + 1.4 * st, 0.9 + 0.4 * st, 0.3, 1, 0.55);
    for (let i = 0, c = n(3 + 5 * st); i < c; i++) {
      const s = puff(sprites.spec, x + rand(-0.4, 0.4), y + 0.25, z + rand(-0.4, 0.4), 0xeaf6ff, 0.35, 0.7, 2.4 + st, rand(0.8, 1.3));
      const a = Math.random() * TAU;
      s.vel(Math.cos(a) * rand(0.6, 1.4), rand(0.3, 0.9), Math.sin(a) * rand(0.6, 1.4));
      s.drag = 1.5;
      if (!sprites.emit(s)) break;
    }
  }

  function bash(p: P, dirX: number, dirZ: number): void {
    let dx = dirX;
    let dz = dirZ;
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) {
      dx = 0;
      dz = 1;
    } else {
      dx /= l;
      dz /= l;
    }
    const px = -dz;
    const pz = dx;
    const { x, y, z } = p;
    const g = y - 0.55;
    const fx = x + dx * 1.1;
    const fz = z + dz * 1.1;
    ring(fx, g + 0.05, fz, true, 0xffe0b0, 1.6, 0.6, 4.4, 0.34, 0.26, 0, 0.95);
    ring(fx, g + 0.04, fz, true, 0xc8b090, 1, 0.8, 5.2, 0.6, 0.34, 1, 0.6);
    glow(fx, y, fz, 0xffd8a0, 1.2, 1.4, 2, 0.1, 0.7);
    burst(fx + dx * 0.3, y + 0.1, fz + dz * 0.3, 0xffb050, 1.2, 1.2, 3, 0.15, 0.45);
    for (let i = 0, c = n(12); i < c; i++) {
      const along = rand(0.3, 2.5);
      const side = rand(-0.9, 0.9) * (0.4 + along * 0.4);
      const s = puff(sprites.spec, x + dx * along + px * side, g + 0.25, z + dz * along + pz * side, i & 1 ? 0xc4ad8c : 0xb09a7c, 0.65, 0.6, rand(1.6, 2.2), rand(0.7, 1.1));
      const v = rand(2, 5);
      s.vel(dx * v + px * side * 0.8, rand(0.5, 1.5), dz * v + pz * side * 0.8);
      s.drag = 3;
      if (!sprites.emit(s)) break;
    }
    // speed lines along the shove
    for (let i = 0, c = n(12); i < c; i++) {
      const s = sprites.begin(Shape.Spark);
      const side = rand(-1.2, 1.2);
      const v = rand(16, 26);
      s.pos(x + px * side + dx * rand(-0.4, 0.6), y + rand(-0.35, 0.6), z + pz * side + dz * rand(-0.4, 0.6)).vel(dx * v, 0, dz * v);
      s.flags = PF.Stretch;
      s.stretch = 0.07;
      s.color(0xffffff, 1.3).size(0.15, 0.08);
      s.blend = 0.6;
      s.alpha = 0.9;
      s.life = rand(0.18, 0.28);
      s.drag = 9;
      s.fin = 0.02;
      if (!sprites.emit(s)) break;
    }
    chips(fx, g + 0.1, fz, n(6), DIRT, 0.11, 0.18, g, 1.5, 3.5, 3, 5.5, 1);
  }

  function melee(p: P): void {
    const { x, y, z } = p;
    const rot = Math.random() * TAU;
    const a = sprites.begin(Shape.Arc);
    a.pos(x, y, z).color(0xfff6dc, 2.4).size(1.4, 2);
    a.rot = rot;
    a.rotV = 7;
    a.life = 0.17;
    a.fin = 0.01;
    a.fpow = 1.5;
    sprites.emit(a);
    const b = sprites.begin(Shape.Arc);
    b.pos(x, y, z).color(0xffc85a, 1.9).size(1.1, 1.6);
    b.rot = rot + 0.7;
    b.rotV = 9;
    b.life = 0.2;
    b.fin = 0.01;
    b.fpow = 1.4;
    sprites.emit(b);
    burst(x, y, z, 0xffe08a, 1, 0.6, 1.5, 0.11, 0.55);
    sparks(x, y, z, n(7), 4, 9, 0xfff0c0, 0xff9a3a, 2.6, 0.25, 0.3, 0.12);
  }

  function damageNumber(p: P, amount: number, kind: DamageKind, mine: boolean, crit: boolean): void {
    numbers.spawn(p.x, p.y, p.z, amount, kind, mine, crit);
  }

  function pickPal(pal: PudgyPalette): number {
    const r = Math.random();
    if (r < 0.3) return pal.skin;
    if (r < 0.45) return pal.skinDark;
    if (r < 0.7) return pal.cloth;
    if (r < 0.8) return pal.accent;
    if (r < 0.88 || !pal.extra.length) return pal.metal;
    return pal.extra[(Math.random() * pal.extra.length) | 0];
  }

  function corpseBurst(p: P, pal: PudgyPalette): void {
    const { x, y, z } = p;
    const g = y - 0.8;
    const count = n(60);
    for (let i = 0; i < count; i++) {
      const big = i < 6;
      const size = big ? rand(0.42, 0.56) : rand(0.2, 0.36);
      const c = chunk(cubes.spec, x + rand(-0.45, 0.45), y + rand(-0.35, 0.6), z + rand(-0.45, 0.45), shade(pickPal(pal), rand(0.86, 1.12)), size, g, rand(2.6, 3.7));
      if (Math.random() < 0.22) {
        c.sy = size * rand(0.45, 0.7);
        c.sx = size * rand(1, 1.3);
      }
      spray(c, big ? 1 : 1.8, big ? 4 : 7.5, big ? 4 : 4.5, big ? 7.5 : 10.5);
      c.grav = -24;
      c.bounce = rand(0.3, 0.45);
      c.drag = 0.25;
      c.shrink = 0.55;
      c.grow = 0.03;
      c.wx = (Math.random() - 0.5) * 18;
      c.wz = (Math.random() - 0.5) * 18;
      if (!cubes.emit(c)) break;
    }
    glow(x, y, z, 0xffffff, 1.8, 2.4, 3.4, 0.1);
    burst(x, y + 0.2, z, pal.cloth, 1, 2, 5, 0.2, 0.6);
    ring(x, g + 0.04, z, true, 0xffffff, 1.5, 0.5, 4.6, 0.45, 0.15, 0, 0.8);
    dustRing(x, g + 0.25, z, n(12), 0xe8e0d0, 0.55, 3.6, 0.6, 1.8, 1);
    sparkles(x, y, z, n(10), pal.cloth, 2.4, 0.4, 1, 3, 3, 6, 0.9);
    // dizzy cartoon stars circling where the body was
    for (let i = 0, c = n(5); i < c; i++) {
      const s = sprites.begin(Shape.Star);
      s.flags = PF.Orbit;
      s.ocx = x;
      s.ocz = z;
      s.orad = 0.55;
      s.oang = (i / c) * TAU;
      s.ow = 5.5;
      s.pos(x, y + 0.6, z).vel(0, 0.25, 0);
      s.color(0xffe27a, 2.4).size(0.5, 0.4);
      s.life = 1.2;
      s.fin = 0.1;
      s.fpow = 0.6;
      s.rotV = 4;
      sprites.emit(s);
    }
    lights.flash(x, y + 0.5, z, 0xfff0d0, 45, 10, 0.3);
  }

  function runePickup(p: P, type: RuneType): void {
    const { x, y, z } = p;
    const c = RUNE_FX_COLORS[type] ?? 0xffffff;
    const g = y - 1.2;
    glow(x, y, z, c, 2.6, 2.6, 3.4, 0.2, 0.9);
    ring(x, g + 0.05, z, true, c, 2, 0.4, 3.6, 0.5, 0.16, 0, 0.95);
    sparkles(x, y, z, n(16), c, 3, 0.42, 3, 6, 1, 4, 0.7);
    swirl(x, g + 0.1, z, n(22), c, 0xffffff, 2.6, 0.95, -0.45, 6.5, 1.8, 3.2, 1.05, 0.22);
    switch (type) {
      case 'haste':
        for (let i = 0, k = n(10); i < k; i++) {
          const s = sprites.begin(Shape.Spark);
          const a = (i / k) * TAU;
          const v = rand(9, 14);
          s.pos(x, y - 0.5, z).vel(Math.cos(a) * v, 0, Math.sin(a) * v);
          s.flags = PF.Stretch;
          s.stretch = 0.05;
          s.color(0xffd0c8, 2.4).colorEnd(c, 1.5).size(0.1, 0.05);
          s.life = 0.28;
          s.drag = 6;
          sprites.emit(s);
        }
        break;
      case 'double':
        ring(x, y, z, false, c, 2.4, 0.5, 3.2, 0.3, 0.12);
        ring(x, g + 0.06, z, true, 0xbfd8ff, 1.8, 0.2, 2.4, 0.8, 0.1, 0, 0.8);
        break;
      case 'ironskin':
        chips(x, y, z, n(10), IRONSKIN, 0.08, 0.15, g, 1.5, 3.5, 3, 6, 1.2, 1.2);
        break;
      case 'ghost':
        for (let i = 0, k = n(8); i < k; i++) {
          const s = puff(sprites.spec, x + rand(-0.5, 0.5), y + rand(-0.6, 0.4), z + rand(-0.5, 0.5), 0xd8f8ff, 0.4, 0.5, 1.6, rand(1, 1.4));
          s.vel(rand(-0.3, 0.3), rand(0.6, 1.4), rand(-0.3, 0.3));
          s.wobble = 1.2;
          s.wobbleF = 4;
          if (!sprites.emit(s)) break;
        }
        break;
      case 'bounty':
        for (let i = 0, k = n(12); i < k; i++) {
          const cs = chunk(cubes.spec, x, y, z, i & 1 ? 0xffd23a : 0xffe27a, 0.2, g, rand(1.2, 1.6));
          cs.sx = cs.sz = 0.2;
          cs.sy = 0.05;
          spray(cs, 1.5, 3.2, 5, 8);
          cs.glow = 0.9;
          cs.bounce = 0.45;
          if (!cubes.emit(cs)) break;
        }
        break;
    }
    lights.flash(x, y + 0.4, z, c, 40, 9, 0.35);
  }

  function mineBoom(p: P): void {
    const { x, y, z } = p;
    const g = y - 0.3;
    glow(x, y + 0.3, z, 0xfff4d0, 2.4, 3.6, 5, 0.1);
    burst(x, y + 0.4, z, 0xff8a2a, 1, 2.4, 5.6, 0.17, 0.55);
    for (let i = 0, c = n(15); i < c; i++) {
      const s = sprites.begin(Shape.Puff);
      const a = Math.random() * TAU;
      const v = rand(2.5, 7);
      s.pos(x + rand(-0.5, 0.5), y + rand(0, 0.6), z + rand(-0.5, 0.5)).vel(Math.cos(a) * v, rand(2.5, 6), Math.sin(a) * v);
      s.color(i % 3 ? 0xffc060 : 0xfff0b0, 2.4).colorEnd(0xd8300a, 1).size(rand(1, 1.4), rand(2.8, 3.6));
      s.blend = 0;
      s.life = rand(0.32, 0.55);
      s.drag = 3.5;
      s.fin = 0.02;
      s.fpow = 1.4;
      s.rotV = (Math.random() - 0.5) * 3;
      if (!sprites.emit(s)) break;
    }
    for (let i = 0, c = n(14); i < c; i++) {
      const s = puff(sprites.spec, x + rand(-0.6, 0.6), y + rand(0, 0.7), z + rand(-0.6, 0.6), i & 1 ? 0x5a5250 : 0x48403e, 0.72, rand(1.2, 1.6), rand(3.6, 4.6), rand(1.6, 2.6));
      const a = Math.random() * TAU;
      const v = rand(1, 3);
      s.vel(Math.cos(a) * v, rand(1.5, 3.2), Math.sin(a) * v);
      s.colorEnd(0x2e2a2a);
      s.fin = 0.25;
      s.drag = 1.6;
      s.grav = 0.6;
      if (!sprites.emit(s)) break;
    }
    sparks(x, y + 0.2, z, n(30), 9, 20, 0xffe0a0, 0xff5a10, 4, 0.6, 0.25, 0.09, -14);
    chips(x, y, z, n(20), DIRT, 0.13, 0.26, g, 5, 11, 5, 10, 1.8);
    leaves(x, y + 0.3, z, n(8), GREENS, 0.28, 2, 5, 4, 7, g + 0.02, 1.5);
    const sc = sprites.begin(Shape.Scorch);
    sc.pos(x, g + 0.03, z).color(0x1a1410).size(2.6, 2.9);
    sc.flags = PF.Flat;
    sc.blend = 1;
    sc.alpha = 0.75;
    sc.life = 5;
    sc.fin = 0.02;
    sc.fpow = 0.6;
    sprites.emit(sc);
    ring(x, g + 0.06, z, true, 0xffc890, 2, 0.6, 6, 0.38, 0.12, 0, 0.95);
    dustRing(x, g + 0.25, z, n(10), 0xb8a080, 0.55, 5, 0.6, 2, 1);
    lights.flash(x, y + 0.8, z, 0xff8a30, 90, 13, 0.45);
  }

  function hazardBurst(p: P, kind: HazardKind): void {
    const { x, y, z } = p;
    const g = y - 0.2;
    switch (kind) {
      case 'icespikes': {
        for (let i = 0, c = n(16); i < c; i++) {
          const cs = chunk(cubes.spec, x + rand(-0.4, 0.4), y + rand(0, 0.4), z + rand(-0.4, 0.4), shade(ICE[(Math.random() * ICE.length) | 0], rand(0.92, 1.08)), 0.1, g, rand(1.2, 1.8));
          cs.sx = rand(0.1, 0.16);
          cs.sz = rand(0.1, 0.16);
          cs.sy = rand(0.35, 0.6);
          spray(cs, 1.5, 4, 6, 11);
          cs.glow = 0.35;
          cs.bounce = 0.25;
          if (!cubes.emit(cs)) break;
        }
        shards(x, y + 0.3, z, n(14), 0xcff4ff, 1.8, 0, 0.5, 3, 6, 3, 8, 0.6);
        for (let i = 0, c = n(8); i < c; i++) {
          const s = puff(sprites.spec, x + rand(-0.4, 0.4), y + 0.3, z + rand(-0.4, 0.4), 0xe8f8ff, 0.5, 0.8, 2.4, rand(1, 1.5));
          const a = Math.random() * TAU;
          s.vel(Math.cos(a) * rand(1, 2), rand(0.5, 1.5), Math.sin(a) * rand(1, 2));
          s.drag = 2;
          if (!sprites.emit(s)) break;
        }
        ring(x, g + 0.05, z, true, 0xbfeeff, 1.6, 0.5, 3.2, 0.4, 0.15, 0, 0.85);
        glow(x, y + 0.4, z, 0xd8f4ff, 2.2, 2.4, 3, 0.15);
        lights.flash(x, y + 0.8, z, 0x9fdcff, 35, 9, 0.3);
        break;
      }
      case 'steamvent': {
        for (let i = 0, c = n(20); i < c; i++) {
          const s = puff(sprites.spec, x + rand(-0.3, 0.3), y + rand(0, 0.4), z + rand(-0.3, 0.3), i % 3 ? 0xf4f8fa : 0xe0e8ec, 0.65, rand(0.6, 0.9), rand(3, 4.2), rand(1, 1.8));
          const a = Math.random() * TAU;
          const v = rand(0.6, 2);
          s.vel(Math.cos(a) * v, rand(8, 15), Math.sin(a) * v);
          s.drag = 2.2;
          s.fin = 0.05;
          if (!sprites.emit(s)) break;
        }
        droplets(x, y + 0.2, z, n(10), 0xe8f4ff, 0.8, 0.1, 0.18, 1, 3, 6, 10, g, 1);
        ring(x, g + 0.05, z, true, 0xffffff, 1, 0.4, 3, 0.45, 0.25, 1, 0.6);
        glow(x, y + 0.3, z, 0xfff6e8, 1.3, 1.6, 2.2, 0.15, 0.7);
        break;
      }
      case 'thorns': {
        leaves(x, y + 0.2, z, n(16), GREENS, 0.4, 2, 5, 2, 5, g + 0.02, 1.4);
        chips(x, y, z, n(8), TWIGS, 0.08, 0.1, g, 2, 4, 3, 5, 1.2);
        shards(x, y + 0.2, z, n(10), 0x2e4a1a, 1, 1, 0.4, 3, 5, 1, 3, 0.5);
        for (let i = 0, c = n(5); i < c; i++) {
          const s = puff(sprites.spec, x + rand(-0.4, 0.4), y, z + rand(-0.4, 0.4), 0x9ab070, 0.4, 0.4, 1.3, rand(0.6, 0.9));
          s.vel(rand(-1, 1), rand(0.3, 1), rand(-1, 1));
          s.drag = 3;
          if (!sprites.emit(s)) break;
        }
        break;
      }
      case 'bristles': {
        shards(x, y + 0.3, z, n(18), 0x8a3a8a, 1.2, 1, 0.5, 4, 8, 1, 4, 0.55);
        burst(x, y + 0.3, z, 0xc050c0, 1, 0.8, 2.4, 0.13, 0.4);
        sparks(x, y + 0.3, z, n(14), 6, 12, 0xffb0f0, 0xff4ac0, 2.2, 0.3, 0.2, 0.13);
        ring(x, y + 0.3, z, false, 0xff9af0, 1.4, 0.3, 3, 0.25, 0.14);
        chips(x, y, z, n(8), BRISTLE, 0.07, 0.1, g, 3, 6, 2, 4, 1);
        break;
      }
      case 'quicksand': {
        for (let i = 0, c = n(10); i < c; i++) {
          const s = puff(sprites.spec, x + rand(-0.6, 0.6), g + 0.25, z + rand(-0.6, 0.6), i & 1 ? 0xd8c08a : 0xc4a870, 0.65, 0.7, 2.4, rand(0.9, 1.3));
          const a = Math.random() * TAU;
          s.vel(Math.cos(a) * rand(1, 2.5), rand(0.4, 1.4), Math.sin(a) * rand(1, 2.5));
          s.drag = 2.6;
          if (!sprites.emit(s)) break;
        }
        ring(x, g + 0.04, z, true, 0xc8a868, 1, 0.4, 2.8, 0.6, 0.3, 1, 0.6);
        chips(x, y, z, n(14), SAND, 0.07, 0.12, g, 1, 3, 3, 6, 1);
        break;
      }
      case 'jellyfish': {
        sparks(x, y + 0.3, z, n(12), 6, 12, 0xffb8ff, 0xff4ae0, 2.6, 0.3, 0.1, 0.13, -4);
        sparks(x, y + 0.3, z, n(10), 6, 12, 0xbaf6ff, 0x3ac8ff, 2.6, 0.3, 0.1, 0.13, -4);
        ring(x, y + 0.3, z, false, 0xff9aff, 1.6, 0.4, 3.2, 0.26, 0.14);
        ring(x, g + 0.05, z, true, 0xff7af0, 1.4, 0.4, 3, 0.4, 0.16, 0, 0.8);
        glow(x, y + 0.3, z, 0xff7af0, 1.4, 1.8, 2.6, 0.14, 0.7);
        for (let i = 0, c = n(8); i < c; i++) {
          const s = sprites.begin(Shape.Bubble);
          s.pos(x + rand(-0.6, 0.6), y, z + rand(-0.6, 0.6)).vel(0, rand(0.8, 1.6), 0).color(0xf0d8ff).size(rand(0.2, 0.32), 0.42);
          s.blend = 1;
          s.alpha = 0.8;
          s.life = rand(0.6, 1);
          s.wobble = 1.2;
          s.wobbleF = 8;
          if (!sprites.emit(s)) break;
        }
        break;
      }
    }
  }

  function respawn(p: P, team: Team): void {
    const { x, y, z } = p;
    const c = TEAM_COLORS[team] ?? TEAM_COLORS[0];
    const g = y - 0.2;
    const pillar = (w: number, hex: number, k: number, life: number, alpha: number) => {
      const s = sprites.begin(Shape.Pillar);
      s.flags = PF.Axis;
      s.stretch = 1;
      s.pos(x, g + 3.6, z).vel(0, 7.5, 0).color(hex, k).size(w, w * 0.7);
      s.rot = 0;
      s.life = life;
      s.alpha = alpha;
      s.fin = 0.08;
      s.fpow = 1.2;
      sprites.emit(s);
    };
    pillar(2.6, c.main, 1.6, 1.15, 0.85);
    pillar(1.2, c.light, 1.8, 0.95, 0.9);
    pillar(0.45, 0xffffff, 1.8, 0.7, 0.9);
    const d = sprites.begin(Shape.Glow);
    d.flags = PF.Flat;
    d.pos(x, g + 0.05, z).color(c.main, 2.2).size(2.6, 3.4);
    d.life = 1.1;
    d.fin = 0.05;
    sprites.emit(d);
    ring(x, g + 0.06, z, true, c.light, 2, 0.4, 3.8, 0.55, 0.16, 0, 0.95);
    swirl(x, g + 0.1, z, n(34), c.light, c.main, 2.4, 1.4, -0.7, 7, 2.5, 4.5, 1.1, 0.32);
    sparkles(x, g + 0.6, z, n(12), c.light, 2.2, 0.5, 0.5, 1.6, 2, 5, 1);
    dustRing(x, g + 0.2, z, n(10), 0xe8e4dc, 0.45, 3.4, 0.5, 1.6, 0.8);
    lights.flash(x, g + 1.6, z, c.main, 50, 10, 0.8);
  }

  function drownBubbles(p: P): void {
    let e: Emitter | null = null;
    for (const em of emitters) if (!em.active) {
      e = em;
      break;
    }
    if (!e) {
      e = emitters[0];
      for (const em of emitters) if (em.t > e.t) e = em;
    }
    e.active = true;
    e.x = p.x;
    e.y = p.y;
    e.z = p.z;
    e.t = 0;
    e.life = 2.1;
    e.acc = 0;
    e.splash = 0;
    // big gulp on entry
    splash({ x: p.x, y: p.y + 0.25, z: p.z }, 0.55);
  }

  function updateEmitters(dt: number): void {
    for (const e of emitters) {
      if (!e.active) continue;
      e.t += dt;
      if (e.t >= e.life) {
        e.active = false;
        continue;
      }
      const surf = e.y + 0.25;
      const fade = 1 - e.t / e.life;
      e.acc += dt * 24 * tier.k;
      while (e.acc >= 1) {
        e.acc -= 1;
        if (sprites.load() > 0.85) continue;
        const s = sprites.begin(Shape.Bubble);
        const a = Math.random() * TAU;
        const r = Math.random() * 0.55;
        const sz = rand(0.1, 0.22);
        s.pos(e.x + Math.cos(a) * r, surf - 0.05, e.z + Math.sin(a) * r).vel(0, rand(0.5, 1.2), 0).color(0xd8f4ff).size(sz, sz * 1.5);
        s.blend = 1;
        s.alpha = 0.85;
        s.life = rand(0.35, 0.7);
        s.wobble = 1.4;
        s.wobbleF = 9;
        s.fpow = 0.6;
        sprites.emit(s);
      }
      e.splash -= dt;
      if (e.splash <= 0) {
        e.splash = rand(0.16, 0.3);
        const ox = e.x + rand(-0.5, 0.5);
        const oz = e.z + rand(-0.5, 0.5);
        droplets(ox, surf + 0.02, oz, n(5 + 5 * fade), 0xeaf8ff, 0.9, 0.1, 0.2, 1, 2.5, 2, 4.5 * (0.5 + fade), surf - 0.04, 0.7);
        ring(ox, surf + 0.03, oz, true, 0xffffff, 1, 0.3, 1.3, 0.45, 0.25, 1, 0.7 * fade + 0.2);
      }
    }
  }

  function footstep(p: P, surface: Surface): void {
    if (sprites.load() > 0.7) return;
    const { x, y, z } = p;
    const sp = sprites.spec;
    switch (surface) {
      case 'shallow':
        droplets(x, y + 0.04, z, 3, 0xeaf8ff, 0.85, 0.07, 0.12, 0.5, 1.4, 1.5, 2.8, y - 0.02, 0.45);
        ring(x, y + 0.03, z, true, 0xffffff, 1, 0.15, 0.8, 0.4, 0.3, 1, 0.55);
        break;
      case 'ice':
        star(x, y + 0.1, z, 0xffffff, 1.6, 0.25, 0.1, 0.22);
        puff(sp, x, y + 0.1, z, 0xe8f6ff, 0.35, 0.2, 0.55, 0.45).vel(0, 0.3, 0);
        sprites.emit(sp);
        break;
      case 'snow':
        for (let i = 0; i < 3; i++) {
          puff(sp, x + rand(-0.15, 0.15), y + 0.1, z + rand(-0.15, 0.15), 0xffffff, 0.6, 0.25, 0.7, rand(0.45, 0.7)).vel(rand(-0.5, 0.5), rand(0.3, 0.8), rand(-0.5, 0.5));
          sp.drag = 3;
          sprites.emit(sp);
        }
        if (cubes.load() < 0.6) chips(x, y + 0.05, z, 2, SNOW, 0.04, 0.06, y, 0.6, 1.4, 1.5, 2.5, 0.6);
        break;
      case 'sand':
        for (let i = 0; i < 3; i++) {
          puff(sp, x + rand(-0.15, 0.15), y + 0.08, z + rand(-0.15, 0.15), 0xe2cc94, 0.5, 0.22, 0.65, rand(0.4, 0.6)).vel(rand(-0.6, 0.6), rand(0.2, 0.6), rand(-0.6, 0.6));
          sp.drag = 3;
          sprites.emit(sp);
        }
        break;
      case 'mud':
        droplets(x, y + 0.04, z, 3, 0x4a3a26, 0.95, 0.06, 0.1, 0.6, 1.4, 1.5, 2.5, y - 0.02, 0.45);
        puff(sp, x, y + 0.06, z, 0x5a4a32, 0.35, 0.2, 0.55, 0.4).vel(0, 0.25, 0);
        sprites.emit(sp);
        break;
      default:
        for (let i = 0; i < 2; i++) {
          puff(sp, x + rand(-0.12, 0.12), y + 0.08, z + rand(-0.12, 0.12), i ? 0xb8a88c : 0xa8987c, 0.42, 0.22, 0.6, rand(0.38, 0.55)).vel(rand(-0.4, 0.4), rand(0.2, 0.45), rand(-0.4, 0.4));
          sp.drag = 3;
          sprites.emit(sp);
        }
        break;
    }
  }

  // ------------------------------------------------------------------------------------------
  // system
  // ------------------------------------------------------------------------------------------

  const fx: FxSystem & { readonly debug: unknown } = {
    update(dt: number, _time: number, camera: THREE.Camera) {
      if (disposed) return;
      const d = Math.min(Math.max(dt, 0), 0.1);
      if (warmState < 2) {
        if (warmState === 0) {
          // render every batch and chain style once, invisibly, so shaders compile now and not on
          // the first hit
          camera.getWorldDirection(camDir);
          const wx = camera.position.x + camDir.x * 15;
          const wy = camera.position.y + camDir.y * 15;
          const wz = camera.position.z + camDir.z * 15;
          sprites.warm(wx, wy, wz);
          cubes.warm(wx, wy, wz);
          numbers.warm(wx, wy, wz);
          for (const c of warmChains ?? []) c.warm(wx, wy, wz);
          warmState = 1;
        } else {
          for (const c of warmChains ?? []) c.dispose();
          warmChains = null;
          warmState = 2;
        }
      }
      // unlit alpha particles follow the map's sun: full daylight on Coral Cove, dim blue at night
      const sun = engine.sun;
      const c = sun.color;
      const peak = Math.max(c.r, c.g, c.b, 1e-3);
      const k = Math.min(1.05, Math.max(0.35, 0.4 + 0.6 * (sun.intensity / 3.2)));
      sprites.setLight(k * (0.65 + 0.35 * (c.r / peak)), k * (0.65 + 0.35 * (c.g / peak)), k * (0.65 + 0.35 * (c.b / peak)));
      updateEmitters(d);
      sprites.update(d);
      cubes.update(d);
      lights.update(d);
      numbers.update(d);
    },
    createChain(kind: 0 | 1, family: FamilyId, team: Team, fxBits: number, radius?: number): ChainView {
      return chains.acquire(kind === 1 ? 1 : 0, family, team, fxBits | 0, radius);
    },
    hookHit,
    hookClash,
    hookWall,
    hookBounce,
    splash,
    bash,
    melee,
    damageNumber,
    corpseBurst,
    runePickup,
    mineBoom,
    hazardBurst,
    respawn,
    drownBubbles,
    footstep,
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      chains.dispose();
      sprites.dispose();
      cubes.dispose();
      lights.dispose();
      numbers.dispose();
      root.clear();
    },
    /** debug counters (live particles), for perf checks from the console */
    get debug() {
      return { sprites: sprites.live, spriteCap: sprites.cap, cubes: cubes.live, cubeCap: cubes.cap };
    },
  };
  return fx;
}
