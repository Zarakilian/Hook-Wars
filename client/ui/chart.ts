// Draws a map as a little nautical chart: banks, channel, islands, props, fountains, hazards.
// Used for the in-match minimap (static layer) and the map cards in the menus.
import { riverAt } from '../../shared/maps/helpers.ts';
import { getMap } from '../../shared/maps/index.ts';
import type { MapDef, PropKind } from '../../shared/maps/types.ts';
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

const PROP_COLOR: Partial<Record<PropKind, number>> = {
  cypress: 0x2f4a22, deadtree: 0x4a3a2a, mossrock: 0x5a6250, stump: 0x6a4a2a,
  pine: 0x1f3a2c, icerock: 0x9fb8c8, icepillar: 0xcde9f6, runestone: 0x6a7080,
  palm: 0x3a6a2a, coralrock: 0xd07a6a, reefpost: 0xff8fb0, tikitotem: 0x8a5a2a,
  crate: 0x8a6034, barrel: 0x6a4424, bollard: 0x3a3f46, lamppost: 0x2e3238, pipe: 0x8a6a3a,
  wall_wood: 0x7a5530, wall_stone: 0x7a7a72, wall_ice: 0xbfe0f0, wall_brick: 0x8a4a3a, wall_hedge: 0x2f5a2a,
};

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

export interface ChartOpts {
  hazards?: readonly HazardInst[];
  /** draw props, rune spots, fountains rings in full detail */
  detail?: boolean;
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
    const s = Math.max(1, k * (0.3 + rnd() * 0.5));
    ctx.fillRect(rnd() * W, rnd() * H, s, s);
  }

  // channel (bank band, then water)
  const z0 = -map.d / 2 - 1;
  const z1 = map.d / 2 + 1;
  const channel = (scale: number, pad = 0) => {
    ctx.beginPath();
    for (let z = z0; z <= z1; z += 0.5) {
      const r = riverAt(map.river.points, z);
      const x = sx(r.x - r.hw * scale - pad);
      if (z === z0) ctx.moveTo(x, sz(z));
      else ctx.lineTo(x, sz(z));
    }
    for (let z = z1; z >= z0; z -= 0.5) {
      const r = riverAt(map.river.points, z);
      ctx.lineTo(sx(r.x + r.hw * scale + pad), sz(z));
    }
    ctx.closePath();
  };
  // sloped bank band outside the water line
  channel(1, map.river.bank * 0.55);
  ctx.fillStyle = hex(mixc(bank, land, 0.35));
  ctx.fill();
  const wc = waterColor(map, water);
  channel(1);
  ctx.fillStyle = hex(wc.edge);
  ctx.fill();
  channel(0.55);
  ctx.fillStyle = hex(wc.mid);
  ctx.fill();
  // water texture
  ctx.save();
  channel(1);
  ctx.clip();
  if (water === 'deep' || water === 'shallow') {
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = Math.max(1, k * 0.18);
    for (let z = -map.d / 2; z < map.d / 2; z += 3.2) {
      const r = riverAt(map.river.points, z);
      ctx.beginPath();
      ctx.moveTo(sx(r.x - r.hw * 0.5), sz(z));
      ctx.quadraticCurveTo(sx(r.x), sz(z + 0.9), sx(r.x + r.hw * 0.4), sz(z + 0.2));
      ctx.stroke();
    }
  } else if (water === 'ice') {
    ctx.strokeStyle = 'rgba(80,140,180,0.45)';
    ctx.lineWidth = Math.max(1, k * 0.12);
    for (let i = 0; i < 26; i++) {
      const z = -map.d / 2 + rnd() * map.d;
      const r = riverAt(map.river.points, z);
      const x = r.x + (rnd() - 0.5) * r.hw * 1.6;
      ctx.beginPath();
      ctx.moveTo(sx(x), sz(z));
      ctx.lineTo(sx(x + (rnd() - 0.5) * 3), sz(z + (rnd() - 0.5) * 3));
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = 'rgba(40,25,10,0.28)';
    ctx.lineWidth = Math.max(1, k * 0.1);
    for (let i = 0; i < 40; i++) {
      const z = -map.d / 2 + rnd() * map.d;
      const r = riverAt(map.river.points, z);
      const x = r.x + (rnd() - 0.5) * r.hw * 1.7;
      ctx.beginPath();
      ctx.moveTo(sx(x), sz(z));
      ctx.lineTo(sx(x + (rnd() - 0.5) * 2.2), sz(z + (rnd() - 0.5) * 2.2));
      ctx.stroke();
    }
  }
  ctx.restore();
  // shore line
  channel(1);
  ctx.strokeStyle = water === 'ice' ? 'rgba(255,255,255,0.6)' : 'rgba(230,250,255,0.35)';
  ctx.lineWidth = Math.max(1, k * 0.16);
  ctx.stroke();

  // whirlpool
  if (map.whirlpool && water !== 'dry') {
    const wp = map.whirlpool;
    ctx.strokeStyle = 'rgba(220,250,255,0.55)';
    ctx.lineWidth = Math.max(1, k * 0.2);
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 6; a += 0.2) {
      const rr = (wp.r * (1 - a / (Math.PI * 6))) * k;
      const px = sx(wp.x) + Math.cos(a) * rr;
      const py = sz(wp.z) + Math.sin(a) * rr;
      if (a === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // islands
  for (const isl of map.islands) {
    ctx.beginPath();
    ctx.arc(sx(isl.x), sz(isl.z), (isl.r + 0.5) * k, 0, Math.PI * 2);
    ctx.fillStyle = hex(mixc(bank, land, 0.35));
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx(isl.x), sz(isl.z), isl.r * k, 0, Math.PI * 2);
    ctx.fillStyle = hex(land);
    ctx.fill();
  }

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
    const f = map.fountains[t];
    const tc = TEAM_COLORS[t];
    const x = sx(f.x);
    const y = sz(f.z);
    const gr = ctx.createRadialGradient(x, y, 0, x, y, f.r * k);
    gr.addColorStop(0, rgba(tc.light, 0.55));
    gr.addColorStop(0.6, rgba(tc.main, 0.28));
    gr.addColorStop(1, rgba(tc.main, 0));
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(x, y, f.r * k, 0, Math.PI * 2);
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
export function mapThumb(id: MapId, water: WaterClass = 'deep', W = 240): string {
  const key = `${id}:${water}:${W}`;
  const hit = thumbs.get(key);
  if (hit) return hit;
  const map = getMap(id);
  const H = Math.round((W * map.d) / map.w);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
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
