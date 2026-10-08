// Draws a map as a little nautical chart: banks, every water channel, pools, islands, decks over
// the water, props, fountains, hazards. Used for the in-match minimap (static layers per water
// state) and the map cards in the menus. Water is rasterized from waterDepthAt(), so braided side
// channels, lagoons and islands always match the sim; platforms are drawn on top as decks.
import { waterDepthAt } from '../../shared/maps/helpers.ts';
import { getMap } from '../../shared/maps/index.ts';
import type { MapDef, Platform, PropKind } from '../../shared/maps/types.ts';
import type { HazardInst } from '../../shared/sim/entities.ts';
import type { HazardKind, MapId } from '../../shared/types.ts';
import { TEAM_COLORS } from '../render/contracts.ts';
import { hex, rgba } from './dom.ts';

export type WaterClass = 'deep' | 'shallow' | 'dry' | 'ice';

function mixc(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

function avg(list: number[]): number {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of list) {
    r += (c >> 16) & 255;
    g += (c >> 8) & 255;
    b += c & 255;
  }
  const n = Math.max(1, list.length);
  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
}

const PROP_COLOR: Record<PropKind, number> = {
  cypress: 0x2f4a22, deadtree: 0x4a3a2a, mossrock: 0x5a6250, stump: 0x6a4a2a,
  pine: 0x1f3a2c, icerock: 0x9fb8c8, icepillar: 0xcde9f6, runestone: 0x6a7080,
  palm: 0x3a6a2a, coralrock: 0xd07a6a, reefpost: 0xff8fb0, tikitotem: 0x8a5a2a,
  crate: 0x8a6034, barrel: 0x6a4424, bollard: 0x3a3f46, lamppost: 0x2e3238, pipe: 0x8a6a3a,
  stilthut: 0x6a4a2a, swampstump: 0x5a4028, lanternpost: 0x5a3e24,
  watchtower: 0x7a5a3a, snowpine: 0x2a4a3a, iceshelf: 0xcfe9f6,
  seastack: 0x6a6258, shipwreck: 0x5a3a22, cratepile: 0x8a6034,
  crane: 0x7a5530, warehouse: 0x8a4a3a, gaslamp: 0x2e3238, bridgepier: 0x7a7a72,
  wall_wood: 0x7a5530, wall_stone: 0x7a7a72, wall_ice: 0xbfe0f0, wall_brick: 0x8a4a3a, wall_hedge: 0x2f5a2a,
};

/** Props that carry a lit lamp: drawn with a warm glow on the chart. */
const LIT: Partial<Record<PropKind, boolean>> = { lanternpost: true, lamppost: true, gaslamp: true, watchtower: true, stilthut: true };

export const HAZARD_COLOR: Record<HazardKind, number> = {
  thorns: 0x5ea040,
  bristles: 0xd9b86a,
  quicksand: 0xc89a50,
  icespikes: 0xbfeaff,
  jellyfish: 0xe07ce8,
  steamvent: 0xf0f0f0,
};

/** Water colours per class for this map. */
export function waterColor(map: MapDef, water: WaterClass): { edge: number; mid: number } {
  const a = map.atmosphere;
  switch (water) {
    case 'deep':
      return { edge: mixc(a.waterShallow, a.waterDeep, 0.35), mid: mixc(a.waterDeep, 0x000000, 0.1) };
    case 'shallow':
      return { edge: mixc(a.waterShallow, avg(map.terrain.bed), 0.25), mid: a.waterShallow };
    case 'dry':
      return { edge: avg(map.terrain.dryBed), mid: mixc(avg(map.terrain.dryBed), 0x000000, 0.12) };
    case 'ice':
      return { edge: 0xcfe9f7, mid: 0xa9d6ef };
  }
}

// ---------------------------------------------------------------------------------------------
// Depth field: waterDepthAt sampled on a 0.25 m grid, once per map, reused for every size and class
// ---------------------------------------------------------------------------------------------

const CELL = 0.25;
interface Field {
  nx: number;
  nz: number;
  d: Float32Array;
}
const fields = new Map<MapId, Field>();

function depthField(map: MapDef): Field {
  const hit = fields.get(map.id);
  if (hit) return hit;
  const nx = Math.ceil(map.w / CELL) + 1;
  const nz = Math.ceil(map.d / CELL) + 1;
  const d = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = -map.d / 2 + j * CELL;
    for (let i = 0; i < nx; i++) d[j * nx + i] = waterDepthAt(map, -map.w / 2 + i * CELL, z);
  }
  const f = { nx, nz, d };
  fields.set(map.id, f);
  return f;
}

function sampleField(f: Field, gx: number, gz: number): number {
  const i0 = Math.max(0, Math.min(f.nx - 2, Math.floor(gx)));
  const j0 = Math.max(0, Math.min(f.nz - 2, Math.floor(gz)));
  const tx = Math.max(0, Math.min(1, gx - i0));
  const tz = Math.max(0, Math.min(1, gz - j0));
  const a = f.d[j0 * f.nx + i0];
  const b = f.d[j0 * f.nx + i0 + 1];
  const c = f.d[(j0 + 1) * f.nx + i0];
  const e = f.d[(j0 + 1) * f.nx + i0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export interface ChartOpts {
  hazards?: readonly HazardInst[];
  /** draw props, rune spots, fountains rings in full detail */
  detail?: boolean;
}

function platformPath(ctx: CanvasRenderingContext2D, p: Platform, sx: (x: number) => number, sz: (z: number) => number): void {
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  // local (lx, lz) -> world: inverse of the rotation in platformAt()
  const pt = (lx: number, lz: number): [number, number] => [sx(p.x + lx * c + lz * s), sz(p.z - lx * s + lz * c)];
  const hw = p.w / 2;
  const hd = p.d / 2;
  const corners = [pt(-hw, -hd), pt(hw, -hd), pt(hw, hd), pt(-hw, hd)];
  ctx.beginPath();
  ctx.moveTo(corners[0][0], corners[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
  ctx.closePath();
}

function drawPlatforms(ctx: CanvasRenderingContext2D, map: MapDef, k: number, sx: (x: number) => number, sz: (z: number) => number): void {
  if (!map.platforms) return;
  for (const p of map.platforms) {
    const col = p.kind === 'bridge' ? 0x8a8478 : p.kind === 'floe' ? 0xe4f4fb : p.kind === 'raftdeck' ? 0x9a6a3a : 0x86603a;
    platformPath(ctx, p, sx, sz);
    ctx.fillStyle = 'rgba(10,6,2,0.45)';
    ctx.save();
    ctx.translate(Math.max(1, k * 0.25), Math.max(1, k * 0.3));
    ctx.fill();
    ctx.restore();
    platformPath(ctx, p, sx, sz);
    ctx.fillStyle = hex(col);
    ctx.fill();
    // planks across the short side (or stone courses on bridges)
    ctx.save();
    platformPath(ctx, p, sx, sz);
    ctx.clip();
    ctx.strokeStyle = p.kind === 'floe' ? 'rgba(120,170,200,0.45)' : 'rgba(30,16,6,0.38)';
    ctx.lineWidth = Math.max(0.6, k * 0.07);
    const c = Math.cos(p.rot);
    const s = Math.sin(p.rot);
    const along = p.w >= p.d;
    const len = along ? p.w : p.d;
    const span = along ? p.d : p.w;
    const step = p.kind === 'bridge' ? 1.1 : 0.6;
    for (let t = -len / 2; t <= len / 2; t += step) {
      const a = along ? [t, -span / 2] : [-span / 2, t];
      const b = along ? [t, span / 2] : [span / 2, t];
      ctx.beginPath();
      ctx.moveTo(sx(p.x + a[0] * c + a[1] * s), sz(p.z - a[0] * s + a[1] * c));
      ctx.lineTo(sx(p.x + b[0] * c + b[1] * s), sz(p.z - b[0] * s + b[1] * c));
      ctx.stroke();
    }
    ctx.restore();
    platformPath(ctx, p, sx, sz);
    ctx.strokeStyle = p.kind === 'floe' ? 'rgba(255,255,255,0.8)' : 'rgba(20,10,4,0.7)';
    ctx.lineWidth = Math.max(0.8, k * 0.1);
    ctx.stroke();
  }
}

/** Paint the chart into ctx (W x H pixels). Static: call once per map and water class. */
export function drawChart(ctx: CanvasRenderingContext2D, map: MapDef, W: number, H: number, water: WaterClass, o: ChartOpts = {}): void {
  const sx = (x: number) => ((x + map.w / 2) / map.w) * W;
  const sz = (z: number) => ((z + map.d / 2) / map.d) * H;
  const k = W / map.w; // px per metre
  const land = mixc(avg(map.terrain.grass), 0xcdb98a, 0.18);
  const bank = avg(map.terrain.bank);

  // land with soft lighting and a deterministic speckle
  ctx.fillStyle = hex(land);
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.1, W / 2, H / 2, W * 0.7);
  g.addColorStop(0, 'rgba(255,240,200,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const speck = Math.round((W * H) / 90);
  for (let i = 0; i < speck; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
    const sp = Math.max(1, k * (0.3 + rnd() * 0.5));
    ctx.fillRect(rnd() * W, rnd() * H, sp, sp);
  }

  // water, banks and islands from the depth field, written straight into the pixels
  const f = depthField(map);
  const wc = waterColor(map, water);
  const bankBand = Math.max(0.6, map.river.bank * 0.55);
  const bankCol = mixc(bank, land, 0.35);
  const img = ctx.getImageData(0, 0, W, H);
  const px = img.data;
  const er = (wc.edge >> 16) & 255;
  const eg = (wc.edge >> 8) & 255;
  const eb = wc.edge & 255;
  const mr = (wc.mid >> 16) & 255;
  const mg = (wc.mid >> 8) & 255;
  const mb = wc.mid & 255;
  const br = (bankCol >> 16) & 255;
  const bg = (bankCol >> 8) & 255;
  const bb = bankCol & 255;
  const foam = water === 'ice' ? 255 : water === 'dry' ? 60 : 225;
  for (let y = 0; y < H; y++) {
    const z = ((y + 0.5) / H) * map.d;
    const gz = z / CELL;
    for (let x = 0; x < W; x++) {
      const wx = ((x + 0.5) / W) * map.w;
      const d = sampleField(f, wx / CELL, gz);
      if (d < -bankBand) continue;
      const i = (y * W + x) * 4;
      if (d <= 0) {
        // sloped bank outside the water line
        const t = 0.35 + 0.65 * (1 + d / bankBand);
        px[i] = px[i] + (br - px[i]) * t;
        px[i + 1] = px[i + 1] + (bg - px[i + 1]) * t;
        px[i + 2] = px[i + 2] + (bb - px[i + 2]) * t;
        continue;
      }
      const t = Math.min(1, d / 2.4);
      let r = er + (mr - er) * t;
      let gg = eg + (mg - eg) * t;
      let b = eb + (mb - eb) * t;
      const n = hash(x, y);
      if (water === 'deep' || water === 'shallow') {
        // flow streaks along z
        const streak = Math.sin(z * 2.1 + Math.sin(wx * 0.9) * 1.4);
        if (streak > 0.93 && d > 0.5) {
          r += 26;
          gg += 30;
          b += 30;
        }
      } else if (water === 'dry') {
        if (n > 0.93) {
          r -= 28;
          gg -= 24;
          b -= 20;
        }
      } else if (n > 0.965) {
        r -= 40;
        gg -= 20;
        b -= 8;
      }
      // shore line
      if (d < 0.22) {
        const s = 1 - d / 0.22;
        r += (foam - r) * s * 0.55;
        gg += (foam + (water === 'dry' ? -10 : 18) - gg) * s * 0.55;
        b += (foam + (water === 'dry' ? -20 : 25) - b) * s * 0.55;
      }
      px[i] = r;
      px[i + 1] = gg;
      px[i + 2] = b;
    }
  }
  ctx.putImageData(img, 0, 0);

  // whirlpool
  if (map.whirlpool && water !== 'dry') {
    const wp = map.whirlpool;
    ctx.strokeStyle = 'rgba(220,250,255,0.55)';
    ctx.lineWidth = Math.max(1, k * 0.2);
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 6; a += 0.2) {
      const rr = wp.r * (1 - a / (Math.PI * 6)) * k;
      const x = sx(wp.x) + Math.cos(a) * rr;
      const y = sz(wp.z) + Math.sin(a) * rr;
      if (a === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // decks over the water
  drawPlatforms(ctx, map, k, sx, sz);

  // hazards
  if (o.hazards) {
    for (const hz of o.hazards) {
      if (hz.channel && water === 'deep') continue;
      const c = HAZARD_COLOR[hz.kind];
      ctx.beginPath();
      ctx.arc(sx(hz.x), sz(hz.z), hz.r * k, 0, Math.PI * 2);
      ctx.fillStyle = rgba(c, 0.38);
      ctx.fill();
      ctx.setLineDash([Math.max(2, k * 0.5), Math.max(2, k * 0.4)]);
      ctx.strokeStyle = rgba(c, 0.95);
      ctx.lineWidth = Math.max(1, k * 0.16);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // props
  const lit: [number, number][] = [];
  for (const ob of map.obstacles) {
    const c = PROP_COLOR[ob.kind] ?? 0x555555;
    if (ob.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(sx(ob.x), sz(ob.z), Math.max(1.2, ob.r * k), 0, Math.PI * 2);
      ctx.fillStyle = hex(c);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = Math.max(0.8, k * 0.1);
      ctx.stroke();
      if (o.detail) {
        ctx.beginPath();
        ctx.arc(sx(ob.x) - ob.r * k * 0.3, sz(ob.z) - ob.r * k * 0.3, Math.max(0.6, ob.r * k * 0.35), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fill();
      }
      if (LIT[ob.kind]) lit.push([sx(ob.x), sz(ob.z)]);
    } else {
      ctx.beginPath();
      ctx.moveTo(sx(ob.ax), sz(ob.az));
      ctx.lineTo(sx(ob.bx), sz(ob.bz));
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = Math.max(2, ob.r * 2 * k + 1.5);
      ctx.stroke();
      ctx.strokeStyle = hex(c);
      ctx.lineWidth = Math.max(1.5, ob.r * 2 * k);
      ctx.stroke();
    }
  }
  // lantern glows
  for (const [x, y] of lit) {
    const r = Math.max(3, k * 2.2);
    const gl = ctx.createRadialGradient(x, y, 0, x, y, r);
    gl.addColorStop(0, 'rgba(255,214,120,0.9)');
    gl.addColorStop(0.35, 'rgba(255,170,60,0.35)');
    gl.addColorStop(1, 'rgba(255,150,40,0)');
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // rune spots
  if (o.detail) {
    ctx.strokeStyle = 'rgba(255,220,120,0.55)';
    ctx.lineWidth = Math.max(1, k * 0.12);
    for (const r of map.runeSpots) {
      const x = sx(r.x);
      const y = sz(r.z);
      const s = k * 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.stroke();
    }
  }

  // fountains
  for (const t of [0, 1] as const) {
    const fo = map.fountains[t];
    const tc = TEAM_COLORS[t];
    const x = sx(fo.x);
    const y = sz(fo.z);
    const gr = ctx.createRadialGradient(x, y, 0, x, y, fo.r * k);
    gr.addColorStop(0, rgba(tc.light, 0.55));
    gr.addColorStop(0.6, rgba(tc.main, 0.28));
    gr.addColorStop(1, rgba(tc.main, 0));
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(x, y, fo.r * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.5, k * 1.1), 0, Math.PI * 2);
    ctx.fillStyle = hex(tc.main);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, k * 0.25);
    ctx.stroke();
  }

  // frame shading
  const v = ctx.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, 'rgba(255,240,200,0.08)');
  v.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

const thumbs = new Map<string, string>();

/** Data-URL thumbnail of a map chart (cached), for map cards and room rows. */
export function mapThumb(id: MapId, water: WaterClass = 'deep', W = 288): string {
  const key = `${id}:${water}:${W}`;
  const hit = thumbs.get(key);
  if (hit) return hit;
  const map = getMap(id);
  const H = Math.round((W * map.d) / map.w);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  drawChart(ctx, map, W, H, water, { detail: true });
  let url = '';
  try {
    url = c.toDataURL('image/png');
  } catch {
    url = '';
  }
  thumbs.set(key, url);
  return url;
}

/** CSS gradient that captures a map's mood (sky to horizon to water). */
export function moodGradient(map: MapDef): string {
  const a = map.atmosphere;
  return `linear-gradient(160deg, ${hex(a.skyTop)} 0%, ${hex(a.skyHorizon)} 48%, ${hex(a.waterShallow)} 72%, ${hex(a.waterDeep)} 100%)`;
}

/** Four mood colours (sky, horizon, sun, water) for a small swatch strip. */
export function moodSwatch(map: MapDef): string[] {
  const a = map.atmosphere;
  return [hex(a.skyTop), hex(a.skyHorizon), hex(a.sunColor), hex(a.waterDeep)];
}

/** Time-of-day label for map cards. */
export function moodLabel(map: MapDef): string {
  const t = map.atmosphere.timeOfDay;
  const w = map.atmosphere.weather;
  const tod = t === 'dawn' ? 'Dawn' : t === 'day' ? 'Day' : t === 'dusk' ? 'Dusk' : 'Night';
  const wx = w === 'rain' ? ' · rain' : w === 'snow' ? ' · snow' : w === 'fireflies' ? ' · fireflies' : w === 'pollen' ? ' · pollen' : '';
  return `${tod}${map.atmosphere.aurora ? ' · aurora' : ''}${wx}`;
}
