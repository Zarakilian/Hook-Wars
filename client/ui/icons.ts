// Procedural icons drawn as inline SVG (createElementNS, never innerHTML). Chunky, outlined,
// warm nautical palette. Each icon is built once as a template and cloned on use.
import { RUNE_COLORS } from '../../shared/constants.ts';
import { s } from './dom.ts';

const RC = RUNE_COLORS;
/** '#rrggbb' (or rgba with alpha) from a 0xRRGGBB number. */
function hx(c: number, a = 1): string {
  return a >= 1 ? `#${c.toString(16).padStart(6, '0')}` : `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}

const OL = '#2a190d';
const METAL = '#cfd8de';
const METAL_D = '#8996a0';
const BRASS = '#e7b54d';
const BRASS_D = '#9a6418';
const ROPE = '#d9b474';
const WOOD = '#8a5a34';
const SEA = '#3a9fd0';
const SEA_D = '#1d5f8f';
const FOAM = '#d9f6ff';
const GOLD = '#ffd25a';
const FIRE = '#ff7a2a';
const FIRE_Y = '#ffd84a';
const GREEN = '#6fbf4a';
const GREEN_D = '#3f7a2a';
const RED = '#e8503a';
const ICE = '#bfeaff';
const ICE_D = '#6fb3d8';

type Spec = [keyof SVGElementTagNameMap, Record<string, string | number>];

const path = (d: string, fill: string, sw = 3): Spec => ['path', { d, fill, stroke: OL, 'stroke-width': sw, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }];
const flat = (d: string, fill: string): Spec => ['path', { d, fill }];
const stroke2 = (d: string, color: string, w: number): Spec[] => [
  ['path', { d, fill: 'none', stroke: OL, 'stroke-width': w + 4.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
  ['path', { d, fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
];
const hl = (d: string, w = 2.4, a = 0.6): Spec => ['path', { d, fill: 'none', stroke: `rgba(255,255,255,${a})`, 'stroke-width': w, 'stroke-linecap': 'round' }];
const circ = (cx: number, cy: number, r: number, fill: string, sw = 3): Spec => ['circle', { cx, cy, r, fill, stroke: OL, 'stroke-width': sw }];
const dot = (cx: number, cy: number, r: number, fill: string): Spec => ['circle', { cx, cy, r, fill }];
const ell = (cx: number, cy: number, rx: number, ry: number, fill: string, sw = 3): Spec => ['ellipse', { cx, cy, rx, ry, fill, stroke: OL, 'stroke-width': sw }];
const rect = (x: number, y: number, w: number, hh: number, rx: number, fill: string, sw = 3): Spec => ['rect', { x, y, width: w, height: hh, rx, fill, stroke: OL, 'stroke-width': sw, 'stroke-linejoin': 'round' }];
const poly = (points: string, fill: string, sw = 3): Spec => ['polygon', { points, fill, stroke: OL, 'stroke-width': sw, 'stroke-linejoin': 'round' }];
const mono = (d: string, w = 6): Spec => ['path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }];
const monoFill = (d: string): Spec => ['path', { d, fill: 'currentColor' }];

function star(cx: number, cy: number, r1: number, r2: number, n: number, rot = -Math.PI / 2): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? r1 : r2;
    const a = rot + (i * Math.PI) / n;
    pts.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return pts.join(' ');
}

function gearPath(cx: number, cy: number, r1: number, r2: number, teeth: number): string {
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const a1 = a0 + (Math.PI * 2) / teeth * 0.25;
    const a2 = a0 + (Math.PI * 2) / teeth * 0.5;
    const a3 = a0 + (Math.PI * 2) / teeth * 0.75;
    const p = (a: number, r: number) => `${(cx + Math.cos(a) * r).toFixed(1)} ${(cy + Math.sin(a) * r).toFixed(1)}`;
    d += `${i === 0 ? 'M' : 'L'}${p(a0, r2)} L${p(a1, r2)} L${p(a1 + 0.05, r1)} L${p(a2, r1)} L${p(a3 - 0.05, r1)} L${p(a3, r2)} `;
  }
  return `${d}Z`;
}

const HOOK: Spec[] = [
  ...stroke2('M32 3 V9', METAL_D, 4),
  ['ellipse', { cx: 32, cy: 10, rx: 4.5, ry: 6, fill: 'none', stroke: OL, 'stroke-width': 7 }],
  ['ellipse', { cx: 32, cy: 10, rx: 4.5, ry: 6, fill: 'none', stroke: METAL, 'stroke-width': 3 }],
  ...stroke2('M32 17 V40 A12.5 12.5 0 1 1 13.5 31', METAL, 6),
  path('M9 37 L12 22 L21 33 Z', METAL),
  hl('M35 21 V38', 2),
  hl('M23 52 A10 10 0 0 0 30 49', 2, 0.45),
];

const ICONS = {
  // ------------------------------------------------------------------ abilities
  hook: HOOK,
  grapple: [
    ...stroke2('M32 4 C 25 9, 39 13, 32 19', ROPE, 4),
    circ(32, 22.5, 4.5, BRASS),
    ...stroke2('M32 27 V40', METAL, 6),
    ...stroke2('M32 40 C 20 40, 13 46, 14 57', METAL, 5),
    ...stroke2('M32 40 C 44 40, 51 46, 50 57', METAL, 5),
    ...stroke2('M32 41 V58', METAL, 5),
    poly('9,52 14,62 19,54', METAL, 2.5),
    poly('45,54 50,62 55,52', METAL, 2.5),
    poly('27,56 32,63 37,56', METAL, 2.5),
    hl('M34 30 V38', 2),
  ],
  bash: [
    path('M6 22 H16 M3 32 H14 M6 42 H16', 'none', 4),
    circ(29, 33, 18, '#f2a066'),
    flat('M17 40 A16 16 0 0 0 44 42 A18 12 0 0 1 17 40Z', 'rgba(150,60,20,0.35)'),
    path('M25 34 q4 4 8 0', 'none', 2.6),
    hl('M18 26 A13 13 0 0 1 28 18', 3, 0.55),
    poly(star(50, 26, 13, 6, 7), FIRE_Y),
    poly(star(50, 26, 6, 3, 7), '#fff6c8', 0),
  ],
  // ------------------------------------------------------------------ items
  ricochet: [
    rect(10, 50, 44, 8, 3, WOOD),
    ...stroke2('M16 48 L48 42 L16 35 L48 28 L16 21 L48 15', METAL, 4.5),
    hl('M18 34 L44 29', 1.6, 0.5),
    path('M44 8 l8 -3 l-3 8', 'none', 3),
    ...stroke2('M40 13 L51 5', FIRE_Y, 2.5),
  ],
  ember: [
    path('M32 4 C 41 16 51 22 48 39 C 46 52 38 59 31 59 C 22 59 14 52 15 41 C 16 31 23 27 25 17 C 29 23 30 27 32 29 C 35 21 35 12 32 4Z', FIRE),
    flat('M32 26 C 37 34 42 38 41 46 C 40 53 36 56 32 56 C 27 56 23 52 23 46 C 23 40 28 37 29 31 C 31 35 32 36 32 26Z', FIRE_Y),
    ...stroke2('M32 40 V50 A5 5 0 1 1 25 47', METAL, 2.6),
  ],
  sinker: [
    ...stroke2('M32 4 V10', METAL_D, 3),
    circ(32, 11, 3.5, 'none', 2.6),
    path('M32 15 C 44 28 49 35 49 43 A17 17 0 0 1 15 43 C 15 35 20 28 32 15Z', '#8f98a3'),
    hl('M22 38 A12 12 0 0 1 27 28', 3, 0.5),
    dot(28, 42, 4.2, GREEN),
    dot(36, 42, 4.2, GREEN),
    dot(32, 38, 4.2, GREEN),
    dot(32, 46, 4.2, GREEN),
    path('M32 46 q1 5 4 7', 'none', 2.2),
  ],
  irongut: [
    path('M10 14 Q32 4 54 14 V36 Q54 56 32 60 Q10 56 10 36 Z', '#9aa6b0'),
    flat('M15 18 Q32 10 49 18 V36 Q49 51 32 55 Z', 'rgba(255,255,255,0.18)'),
    dot(16, 19, 2.4, '#5b6670'),
    dot(48, 19, 2.4, '#5b6670'),
    dot(16, 44, 2.4, '#5b6670'),
    dot(48, 44, 2.4, '#5b6670'),
    path('M32 46 C 20 37 19 28 25 25 C 28 23 31 25 32 28 C 33 25 36 23 39 25 C 45 28 44 37 32 46Z', RED, 2.6),
    hl('M25 29 q1 -2 3 -1', 1.8, 0.7),
  ],
  wellies: [
    path('M6 30 H14 M3 39 H12', 'none', 3.5),
    path('M21 6 H39 V38 C 39 41 41 43 45 43 H50 C 55 43 58 47 58 52 V54 H19 V38 Z', '#f6c431'),
    rect(17, 52, 43, 8, 3, '#5a3b22'),
    flat('M21 12 H39 V17 H21Z', 'rgba(255,255,255,0.35)'),
    hl('M25 22 V36', 2.4, 0.5),
  ],
  mine: [
    poly(star(32, 35, 26, 14, 10), '#6b4a2a'),
    circ(32, 35, 15, '#4a3220'),
    hl('M23 30 A10 10 0 0 1 30 24', 2.6, 0.4),
    dot(32, 35, 5.5, RED),
    dot(33.5, 33.5, 2, '#ffd0c0'),
    ...stroke2('M30 9 C 28 4 33 3 35 7', GREEN, 2.6),
  ],
  pie: [
    path('M10 38 C 10 30 54 30 54 38 L50 50 H14 Z', '#c47a3a'),
    ell(32, 36, 22, 9, '#e7b062'),
    path('M16 34 L48 40 M20 41 L44 31 M28 28 L36 44', 'none', 2.2),
    rect(8, 49, 48, 7, 3.5, '#d4d8de'),
    path('M24 22 q-4 -6 0 -12 M32 22 q-4 -6 0 -12 M40 22 q-4 -6 0 -12', 'none', 2.6),
  ],
  puffball: [
    circ(21, 38, 12, '#b9a3d6'),
    circ(43, 38, 12, '#b9a3d6'),
    circ(32, 28, 15, '#cdb9e8'),
    flat('M10 40 A12 12 0 0 0 54 40 A20 9 0 0 1 10 40Z', 'rgba(70,40,110,0.25)'),
    dot(26, 24, 2.6, '#f2eaff'),
    dot(37, 30, 2.2, '#f2eaff'),
    dot(22, 37, 1.8, '#f2eaff'),
    dot(44, 40, 2, '#f2eaff'),
    path('M12 54 q4 -3 8 0 M44 56 q4 -3 8 0', 'none', 2.4),
  ],
  // ------------------------------------------------------------------ runes (colours from RUNE_COLORS)
  // Tailwind: a gust of wind
  haste: [
    ...stroke2('M6 22 H33 C 44 22 46 9 37 8 C 31 7 29 14 34 16', hx(RC.haste.main), 5),
    ...stroke2('M4 36 H45 C 58 36 60 53 49 54 C 43 55 41 47 47 45', hx(RC.haste.main), 5),
    ...stroke2('M12 48 H27', hx(RC.haste.light), 3.6),
    hl('M10 21 H30', 1.8, 0.75),
  ],
  // Kraken Ink: an ink drop with a curling tentacle
  double: [
    path('M30 4 C 38 17 48 27 48 39 A18 18 0 0 1 12 39 C 12 27 22 17 30 4 Z', hx(RC.double.main)),
    flat('M30 11 C 36 21 43 29 43 39 A13 13 0 0 1 30 52 Z', hx(RC.double.dark, 0.55)),
    hl('M19 37 A11 11 0 0 1 23 26', 3, 0.65),
    ...stroke2('M40 46 C 52 44 58 52 52 58 C 48 61 43 57 47 54', hx(RC.double.light), 3.4),
    dot(51, 49.5, 1.4, hx(RC.double.dark)),
    dot(54.5, 53.5, 1.3, hx(RC.double.dark)),
  ],
  // Barnacle Hide: a shell shield crusted with barnacles
  ironskin: [
    path('M32 4 L54 12 V30 C 54 46 44 55 32 60 C 20 55 10 46 10 30 V12 Z', hx(RC.ironskin.main)),
    path('M32 11 L47 16 V30 C 47 41 40 48 32 52 Z', hx(RC.ironskin.light, 0.55), 0),
    circ(22, 24, 5, hx(RC.ironskin.light), 2.2),
    dot(22, 24, 1.8, hx(RC.ironskin.dark)),
    circ(38, 36, 6, hx(RC.ironskin.light), 2.2),
    dot(38, 36, 2.1, hx(RC.ironskin.dark)),
    circ(26, 42, 3.6, hx(RC.ironskin.light), 2),
    dot(26, 42, 1.3, hx(RC.ironskin.dark)),
  ],
  // Sea Fog: a rolling fog bank
  ghost: [
    circ(20, 30, 10, hx(RC.ghost.main)),
    circ(35, 23, 13, hx(RC.ghost.light)),
    circ(48, 31, 9, hx(RC.ghost.main)),
    rect(10, 30, 46, 10, 5, hx(RC.ghost.light), 0),
    path('M10 40 H56', 'none', 3),
    ...stroke2('M6 48 H38', hx(RC.ghost.main), 3.6),
    ...stroke2('M22 57 H58', hx(RC.ghost.main), 3.6),
    hl('M28 18 A10 10 0 0 1 38 14', 2.4, 0.9),
  ],
  // Sunken Loot: a chest spilling sea glass and a pearl
  bounty: [
    path('M8 32 H56 V56 H8 Z', '#8a5a34'),
    path('M8 32 C 8 18 56 18 56 32 Z', '#a8743e'),
    path('M8 32 H56', 'none', 3),
    rect(27, 28, 10, 13, 2.5, hx(RC.bounty.main), 2.4),
    dot(32, 34.5, 1.8, OL),
    path('M18 32 V56 M46 32 V56', 'none', 2.4),
    circ(16, 17, 4.6, hx(RC.bounty.light), 2.2),
    circ(26, 13, 4, hx(RC.bounty.main), 2.2),
    circ(46, 15, 5.5, '#fbf6ff', 2.2),
    dot(44.6, 13.4, 1.6, '#ffffff'),
    flat('M10 34 H54 V38 H10Z', 'rgba(255,255,255,0.12)'),
  ],
  // Bendy Eel: an eel that bends into a hook
  bendy: [
    ...stroke2('M8 54 C 22 56 20 34 32 30 C 44 26 42 12 54 10', hx(RC.bendy.main), 7),
    ['path', { d: 'M8 54 C 22 56 20 34 32 30 C 44 26 42 12 54 10', fill: 'none', stroke: hx(RC.bendy.dark, 0.7), 'stroke-width': 1.6, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round' }],
    poly('50,4 61,8 53,17', METAL, 2.6),
    dot(11, 52, 2.2, OL),
    hl('M22 44 C 24 37 26 33 31 31', 2, 0.7),
  ],
  // Boing Barb: a coiled spring with a barb on top
  bouncy: [
    ...stroke2('M20 58 L44 52 L20 46 L44 40 L20 34 L44 28 L22 22', hx(RC.bouncy.main), 4.4),
    rect(14, 56, 36, 6, 2.5, hx(RC.bouncy.dark), 2.2),
    ...stroke2('M30 22 V12', METAL, 4),
    poly('22,14 30,2 38,14', METAL, 2.6),
    ...stroke2('M50 10 l6 -4 M52 18 l7 0 M8 12 l-4 -4', hx(RC.bouncy.light), 2.2),
  ],
  // Long Line: a hook flying far, with speed lines
  longshot: [
    ...stroke2('M4 32 H48', ROPE, 4.6),
    path('M46 21 L62 32 L46 43 Z', METAL),
    ...stroke2('M10 20 H30 M14 44 H34', hx(RC.longshot.main), 3.6),
    ...stroke2('M36 14 H44 M38 50 H46', hx(RC.longshot.light), 2.4),
  ],
  // ------------------------------------------------------------------ status / causes
  burn: [
    path('M32 5 C 41 17 51 23 48 40 C 46 53 38 59 31 59 C 22 59 14 53 15 42 C 16 32 23 28 25 18 C 29 24 30 28 32 30 C 35 22 35 13 32 5Z', FIRE),
    flat('M32 27 C 37 35 42 39 41 47 C 40 54 36 57 32 57 C 27 57 23 53 23 47 C 23 41 28 38 29 32 C 31 36 32 37 32 27Z', FIRE_Y),
  ],
  spawn: [
    path('M32 4 L54 12 V30 C 54 46 44 55 32 60 C 20 55 10 46 10 30 V12 Z', '#9fe8ff'),
    poly(star(32, 31, 13, 5.5, 4), '#ffffff', 2.4),
  ],
  melee: [
    path('M14 26 C 14 18 22 16 26 20 C 28 14 36 14 38 20 C 41 16 49 17 49 25 V40 C 49 52 40 58 30 58 C 20 58 14 50 14 40 Z', '#f2a066'),
    path('M26 20 V32 M38 20 V32 M14 32 C 22 30 30 34 34 40', 'none', 2.6),
    hl('M19 24 V34', 2, 0.5),
    poly(star(52, 12, 9, 4, 6), FIRE_Y, 2.4),
  ],
  drown: [
    path('M4 40 C 12 32 20 32 26 40 C 32 48 40 48 46 40 C 52 32 58 34 62 38 V60 H4 Z', SEA),
    flat('M4 50 C 12 44 20 44 26 50 C 32 56 40 56 46 50 C 52 44 58 46 62 48 V60 H4 Z', SEA_D),
    ...stroke2('M8 40 C 14 35 20 35 25 40', FOAM, 2.5),
    circ(30, 22, 6, '#e6fbff', 2.4),
    circ(42, 12, 4, '#e6fbff', 2.2),
    circ(22, 8, 3, '#e6fbff', 2),
  ],
  hazard: [
    path('M32 5 L60 56 H4 Z', '#ffcf3a'),
    path('M32 22 V38', 'none', 6),
    dot(32, 47, 3.8, OL),
  ],
  fountain: [
    ...stroke2('M32 34 C 32 18 18 14 12 24', '#9fe2ff', 3.5),
    ...stroke2('M32 34 C 32 18 46 14 52 24', '#9fe2ff', 3.5),
    ...stroke2('M32 36 V10', '#c8f2ff', 4),
    path('M8 38 H56 L50 52 H14 Z', '#bfa58a'),
    rect(22, 52, 20, 7, 2, '#9c8266'),
    flat('M12 40 H52 L50 44 H14Z', SEA),
  ],
  // ------------------------------------------------------------------ river
  wave: [
    path('M3 30 C 11 20 19 20 25 28 C 31 36 39 36 45 28 C 51 20 57 22 61 26 V60 H3 Z', SEA),
    flat('M3 44 C 11 36 19 36 25 44 C 31 52 39 52 45 44 C 51 36 57 38 61 40 V60 H3 Z', SEA_D),
    ...stroke2('M7 29 C 13 23 19 23 24 29', FOAM, 2.5),
    ...stroke2('M45 28 C 50 23 55 23 59 26', FOAM, 2.5),
  ],
  dry: [
    rect(4, 22, 56, 34, 6, '#c99a62'),
    flat('M7 25 H57 V31 H7Z', 'rgba(255,240,200,0.35)'),
    path('M12 30 L22 38 L18 48 M22 38 L34 36 L40 46 L36 54 M34 36 L42 28 M40 46 L52 44', 'none', 2.4),
    path('M14 18 C 18 10 24 10 26 4', 'none', 2.4),
  ],
  tidal: [
    circ(44, 16, 10, '#fff2b8'),
    flat('M44 6 A10 10 0 1 0 54 16 A8 8 0 0 1 44 6Z', '#c9b46a'),
    path('M3 36 C 11 26 19 26 25 34 C 31 42 39 42 45 34 C 51 26 57 28 61 32 V60 H3 Z', SEA),
    flat('M3 48 C 11 42 19 42 25 48 C 31 54 39 54 45 48 C 51 42 57 44 61 46 V60 H3 Z', SEA_D),
    path('M8 22 V12 M4 16 L8 12 L12 16', 'none', 2.6),
  ],
  ice: [
    ...stroke2('M32 4 V60 M8 18 L56 46 M8 46 L56 18', ICE, 4),
    ...stroke2('M26 8 L32 14 L38 8 M26 56 L32 50 L38 56', ICE, 2.6),
    ...stroke2('M8 26 L16 22 L12 14 M56 38 L48 42 L52 50 M52 14 L48 22 L56 26 M12 50 L16 42 L8 38', ICE, 2.6),
    circ(32, 32, 5, '#ffffff', 2.4),
  ],
  crack: [
    path('M6 22 L32 10 L58 22 L58 44 L32 56 L6 44 Z', ICE),
    flat('M10 24 L32 14 L54 24 L32 33 Z', 'rgba(255,255,255,0.55)'),
    path('M32 14 L28 26 L36 32 L30 42 L34 54 M36 32 L46 36', 'none', 2.6),
    path('M20 30 L26 34', 'none', 2.2),
  ],
  lock: [
    rect(6, 10, 22, 48, 3, WOOD),
    rect(36, 10, 22, 48, 3, WOOD),
    path('M6 22 H28 M6 46 H28 M36 22 H58 M36 46 H58', 'none', 2.4),
    flat('M28 30 H36 V60 H28Z', SEA),
    path(gearPath(32, 14, 6, 9, 8), BRASS, 2.4),
    dot(32, 14, 2.5, OL),
  ],
  // ------------------------------------------------------------------ hazards
  thorns: [
    ...stroke2('M6 52 C 16 30 30 50 36 32 C 40 20 50 18 58 10', GREEN_D, 4.5),
    poly('16,40 12,30 21,36', '#e9d9a0', 2.2),
    poly('28,44 34,52 26,50', '#e9d9a0', 2.2),
    poly('36,30 30,24 39,24', '#e9d9a0', 2.2),
    poly('48,20 50,10 54,18', '#e9d9a0', 2.2),
    dot(44, 30, 4, '#c43a5a'),
    dot(14, 56, 3.4, '#c43a5a'),
  ],
  bristles: [
    poly('32,4 36,30 30,30', '#d9c08a', 2.4),
    poly('12,14 30,34 25,37', '#d9c08a', 2.4),
    poly('52,14 39,37 34,34', '#d9c08a', 2.4),
    poly('4,36 26,40 25,45', '#d9c08a', 2.4),
    poly('60,36 39,45 38,40', '#d9c08a', 2.4),
    path('M10 56 C 10 40 54 40 54 56 Z', '#7a5230'),
    hl('M18 50 C 22 46 30 44 36 45', 2, 0.35),
  ],
  quicksand: [
    ell(32, 38, 28, 18, '#d8b06a'),
    ...stroke2('M32 38 m-16 0 a16 10 0 1 0 32 0 a12 7 0 1 0 -24 0 a8 4 0 1 0 16 0', '#a77a3c', 2.4),
    ...stroke2('M44 14 V26 M40 18 L44 14 L48 18', '#6a4a24', 2),
  ],
  icespikes: [
    poly('8,58 16,22 24,58', ICE),
    poly('22,58 32,6 42,58', '#e4f7ff'),
    poly('40,58 48,26 56,58', ICE),
    flat('M32 10 L35 56 H32Z', 'rgba(111,179,216,0.6)'),
    path('M4 58 H60', 'none', 3),
  ],
  jellyfish: [
    ...stroke2('M20 34 C 16 42 24 46 18 58', '#ff9ad0', 2.6),
    ...stroke2('M28 36 C 24 46 32 50 28 60', '#ff9ad0', 2.6),
    ...stroke2('M36 36 C 40 46 32 50 36 60', '#ff9ad0', 2.6),
    ...stroke2('M44 34 C 48 42 40 46 46 58', '#ff9ad0', 2.6),
    path('M10 34 C 10 10 54 10 54 34 C 46 38 18 38 10 34Z', '#d77ce0'),
    flat('M16 28 C 18 16 30 14 34 16 C 26 18 20 22 18 30Z', 'rgba(255,255,255,0.55)'),
    dot(40, 26, 2.6, '#fff0ff'),
  ],
  steamvent: [
    circ(20, 24, 10, '#f2f6f8'),
    circ(34, 16, 12, '#ffffff'),
    circ(46, 26, 9, '#f2f6f8'),
    rect(18, 36, 28, 10, 2, '#b07a3a'),
    rect(24, 46, 16, 14, 2, '#8a5a2a'),
    path('M18 41 H46', 'none', 2),
    dot(22, 41, 1.6, OL),
    dot(42, 41, 1.6, OL),
  ],
  // ------------------------------------------------------------------ families
  brawler: [
    ...stroke2('M32 12 V54', METAL, 5),
    circ(32, 9, 5, 'none', 3.5),
    ...stroke2('M20 22 H44', METAL, 4.5),
    ...stroke2('M10 38 C 12 52 24 56 32 56 C 40 56 52 52 54 38', METAL, 5),
    poly('5,42 10,32 16,41', METAL, 2.6),
    poly('48,41 54,32 59,42', METAL, 2.6),
    ...stroke2('M30 9 C 22 2 14 10 20 16', ROPE, 2.4),
  ],
  ogre: [
    path('M12 30 C 12 12 52 12 52 30 C 52 48 44 58 32 58 C 20 58 12 48 12 30Z', '#7fa04a'),
    flat('M16 24 C 18 14 30 12 34 13 C 26 16 20 20 18 28Z', 'rgba(255,255,255,0.3)'),
    ell(24, 30, 4, 3.4, '#fff3b0', 2.2),
    ell(40, 30, 4, 3.4, '#fff3b0', 2.2),
    dot(24.8, 30.4, 1.8, OL),
    dot(40.8, 30.4, 1.8, OL),
    path('M22 44 C 28 48 36 48 42 44', 'none', 2.6),
    poly('22,44 20,34 27,42', '#fff6dc', 2.2),
    poly('42,44 44,34 37,42', '#fff6dc', 2.2),
    dot(18, 20, 2.6, '#5d7a34'),
    dot(46, 40, 2.2, '#5d7a34'),
  ],
  bot: [
    path(gearPath(32, 32, 22, 28, 10), '#b9c2ca'),
    circ(32, 32, 16, '#6f7c88'),
    rect(19, 26, 26, 11, 5, '#2a3540', 2.4),
    rect(22, 28.5, 20, 6, 3, '#7ff0ff', 0),
    dot(26, 31.5, 1.8, '#ffffff'),
  ],
  // ------------------------------------------------------------------ cosmetic slots
  slotHead: [
    path('M12 40 C 10 24 20 12 32 12 C 44 12 54 24 52 40 Z', '#f4ecd8'),
    flat('M16 36 C 16 24 24 16 32 16 C 26 20 22 28 22 36Z', 'rgba(255,255,255,0.55)'),
    rect(10, 34, 44, 8, 3, '#2c3a4a'),
    path('M6 44 C 18 40 46 40 58 44 C 58 50 6 50 6 44 Z', '#1d2833'),
    circ(32, 25, 5, BRASS, 2.4),
  ],
  slotFace: [
    circ(32, 30, 22, '#f0b488'),
    flat('M14 34 A20 20 0 0 0 50 34 A22 14 0 0 1 14 34Z', 'rgba(150,70,30,0.25)'),
    dot(24, 26, 3, OL),
    dot(40, 26, 3, OL),
    path('M14 42 C 20 34 28 36 32 40 C 36 36 44 34 50 42 C 44 46 38 44 32 42 C 26 44 20 46 14 42 Z', '#5a3a22'),
    ell(32, 35, 5, 4, '#e07a5a'),
  ],
  slotBody: [
    path('M20 6 H44 V18 C 52 20 56 28 54 40 L50 58 H14 L10 40 C 8 28 12 20 20 18 Z', '#e8b33a'),
    flat('M22 22 C 18 30 18 42 20 54 H16 L13 40 C 12 30 14 24 22 22Z', 'rgba(255,255,255,0.35)'),
    path('M20 6 V18 M44 6 V18', 'none', 2.6),
    rect(24, 34, 16, 10, 2, '#c48a22', 2.4),
    dot(22, 20, 2.4, BRASS),
    dot(42, 20, 2.4, BRASS),
  ],
  slotFeet: [
    path('M18 6 H38 V36 C 38 40 40 42 44 42 H50 C 55 42 58 46 58 51 V54 H16 V36 Z', '#5f8a4a'),
    rect(14, 52, 46, 8, 3, '#3a2a1a'),
    flat('M18 12 H38 V17 H18Z', 'rgba(255,255,255,0.3)'),
    hl('M23 22 V36', 2.4, 0.45),
  ],
  slotBack: [
    path('M16 14 C 16 8 48 8 48 14 V52 C 48 58 16 58 16 52 Z', '#9a6a3a'),
    path('M16 22 H48 M16 44 H48', 'none', 3.2),
    flat('M20 14 V54 H25 V12Z', 'rgba(255,255,255,0.18)'),
    rect(26, 26, 12, 10, 2, BRASS, 2.4),
    ...stroke2('M22 8 C 22 2 42 2 42 8', ROPE, 2.4),
  ],
  // ------------------------------------------------------------------ economy and screens
  pearl: [
    path('M6 44 C 6 30 18 22 32 22 C 46 22 58 30 58 44 C 50 50 14 50 6 44 Z', '#e9c7d9'),
    path('M14 44 C 18 34 24 30 32 30 M50 44 C 46 34 40 30 32 30 M32 30 V46', 'none', 2),
    circ(32, 20, 12, '#fbf6ff'),
    flat('M24 18 A9 9 0 0 1 31 11 A12 12 0 0 0 24 22Z', 'rgba(255,255,255,0.95)'),
    flat('M36 30 A12 12 0 0 0 43 21 A10 10 0 0 1 36 28Z', 'rgba(170,140,200,0.5)'),
  ],
  locker: [
    path('M6 28 H58 V56 H6 Z', '#6a4428'),
    path('M6 28 C 6 12 58 12 58 28 Z', '#8a5a34'),
    rect(6, 26, 52, 6, 2, BRASS, 2.4),
    rect(26, 30, 12, 14, 3, BRASS, 2.4),
    dot(32, 37, 2.2, OL),
    path('M16 32 V56 M48 32 V56', 'none', 2.4),
    flat('M10 30 H54 V34 H10Z', 'rgba(255,255,255,0.12)'),
  ],
  shop: [
    path('M6 22 L12 8 H52 L58 22 Z', '#e0533d'),
    flat('M17 9 H27 L25 21 H14Z M37 9 H47 L50 21 H39Z', '#fff3d9'),
    path('M17 8 L14 22 M27 8 L25 22 M37 8 L39 22 M47 8 L50 22', 'none', 2.4),
    path('M6 22 C 6 28 16 28 16 22 C 16 28 27 28 27 22 C 27 28 37 28 37 22 C 37 28 48 28 48 22 C 48 28 58 28 58 22', 'none', 2.6),
    rect(10, 28, 44, 28, 3, '#8a5a34'),
    rect(16, 34, 14, 22, 2, '#5a3420', 2.4),
    rect(36, 34, 12, 10, 2, '#9fd6ff', 2.4),
  ],
  market: [
    ...stroke2('M32 8 V54', '#c18a2c', 4),
    ...stroke2('M10 16 H54', '#c18a2c', 4),
    path('M4 36 L10 18 L16 36 Z', 'none', 2.2),
    path('M48 36 L54 18 L60 36 Z', 'none', 2.2),
    path('M2 36 H18 C 18 44 2 44 2 36 Z', BRASS),
    path('M46 36 H62 C 62 44 46 44 46 36 Z', BRASS),
    rect(20, 52, 24, 6, 2, '#8a5a34'),
    circ(32, 8, 4, BRASS, 2.4),
  ],
  career: [
    rect(8, 34, 12, 22, 2, '#5cb4ff'),
    rect(26, 22, 12, 34, 2, '#7fd99a'),
    rect(44, 10, 12, 46, 2, '#ffd25a'),
    path('M4 58 H60', 'none', 3),
    flat('M10 36 H13 V54 H10Z M28 24 H31 V54 H28Z M46 12 H49 V54 H46Z', 'rgba(255,255,255,0.4)'),
  ],
  sparkle: [poly(star(32, 32, 28, 7, 4), '#fff2b0', 2.6), poly(star(50, 13, 9, 3, 4), '#ffffff', 2)],
  tag: [path('M8 30 L30 8 H56 V34 L34 56 Z', '#e9c46a'), circ(46, 18, 4.2, '#7a4c12', 2.4), hl('M14 30 L32 12', 2.4, 0.5)],
  info: [mono('M32 6 a26 26 0 1 0 0.01 0Z', 5), monoFill('M28 26 H36 V48 H28Z M32 12 a4.5 4.5 0 1 1 -0.01 0Z')],
  sort: [mono('M20 10 V54 M10 44 L20 54 L30 44 M44 54 V10 M34 20 L44 10 L54 20', 5.5)],
  user: [monoFill('M32 8 a12 12 0 1 1 -0.01 0Z M10 58 C 10 38 54 38 54 58 Z')],
  link: [mono('M26 38 L38 26 M22 30 L16 36 a8 8 0 0 0 12 12 L34 42 M42 34 L48 28 a8 8 0 0 0 -12 -12 L30 22', 5.5)],
  // ------------------------------------------------------------------ UI glyphs (currentColor)
  star: [poly(star(32, 33, 27, 12, 5), GOLD, 3), hl('M22 24 L28 22', 2.4, 0.7)],
  check: [mono('M12 34 L26 48 L52 18', 8)],
  close: [mono('M16 16 L48 48 M48 16 L16 48', 8)],
  copy: [mono('M22 22 h26 v32 h-26 z', 5), mono('M14 42 V12 H38', 5)],
  gear: [monoFill(`${gearPath(32, 32, 20, 28, 8)} M32 22 a10 10 0 1 0 0.01 0Z`)],
  play: [monoFill('M20 10 L54 32 L20 54 Z')],
  globe: [mono('M32 6 a26 26 0 1 0 0.01 0 Z M6 32 H58 M32 6 C 18 18 18 46 32 58 C 46 46 46 18 32 6', 4.5)],
  book: [mono('M8 14 C 18 10 26 12 32 18 C 38 12 46 10 56 14 V52 C 46 48 38 50 32 56 C 26 50 18 48 8 52 Z M32 18 V56', 4.5)],
  left: [mono('M40 12 L20 32 L40 52', 9)],
  right: [mono('M24 12 L44 32 L24 52', 9)],
  refresh: [mono('M50 30 A18 18 0 1 1 42 16', 6), monoFill('M36 6 L52 14 L38 24 Z')],
  padlock: [mono('M20 28 V20 a12 12 0 0 1 24 0 V28', 6), monoFill('M12 28 H52 V56 H12 Z')],
  dice: [rect(8, 8, 48, 48, 10, '#f7efe0'), dot(20, 20, 5, OL), dot(44, 44, 5, OL), dot(32, 32, 5, OL), dot(44, 20, 5, OL), dot(20, 44, 5, OL)],
  people: [monoFill('M22 12 a9 9 0 1 1 -0.01 0 Z M42 14 a8 8 0 1 1 -0.01 0Z M6 54 C 6 38 38 38 38 54 Z M32 52 C 34 40 58 40 58 52 Z')],
  eye: [mono('M4 32 C 18 12 46 12 60 32 C 46 52 18 52 4 32 Z', 5), monoFill('M32 24 a8 8 0 1 1 -0.01 0Z')],
  chat: [mono('M8 12 H56 V44 H28 L16 54 V44 H8 Z', 5)],
  clock: [mono('M32 6 a26 26 0 1 0 0.01 0Z M32 18 V32 L42 40', 5)],
  enter: [mono('M50 14 V36 H16 M26 26 L16 36 L26 46', 6)],
  // ------------------------------------------------------------------ awards & misc colour
  coin: [circ(32, 32, 26, GOLD), circ(32, 32, 19, '#ffe58a', 2.4), ['text', { x: 32, y: 42, 'text-anchor': 'middle', 'font-family': 'Lilita One, sans-serif', 'font-size': 26, fill: '#9a6418' }], hl('M16 24 A18 18 0 0 1 26 13', 3, 0.7)],
  crown: [path('M8 50 L4 18 L20 32 L32 10 L44 32 L60 18 L56 50 Z', GOLD), rect(8, 48, 48, 9, 3, BRASS), dot(32, 26, 3.2, RED), dot(18, 40, 2.6, '#5ad0ff'), dot(46, 40, 2.6, '#5ad0ff')],
  trophy: [path('M18 8 H46 V26 C 46 36 40 42 32 42 C 24 42 18 36 18 26 Z', GOLD), ...stroke2('M18 14 C 6 14 8 30 20 30 M46 14 C 58 14 56 30 44 30', BRASS, 3), rect(27, 42, 10, 8, 1, BRASS), rect(18, 50, 28, 8, 2, WOOD), hl('M24 14 V28', 2.4, 0.7)],
  target: [circ(32, 32, 27, '#ffffff'), circ(32, 32, 19, RED, 2.4), circ(32, 32, 11, '#ffffff', 2.4), circ(32, 32, 4.5, RED, 2.2), ...stroke2('M58 6 L36 28', BRASS_D, 3), poly('34,30 36,22 42,28', METAL, 2)],
  lifebuoy: [circ(32, 32, 26, '#ffffff'), ['path', { d: 'M32 6 A26 26 0 0 1 58 32 H46 A14 14 0 0 0 32 18 Z M32 58 A26 26 0 0 1 6 32 H18 A14 14 0 0 0 32 46 Z', fill: RED, stroke: OL, 'stroke-width': 2.4 }], circ(32, 32, 13, '#123a52', 3), ...stroke2('M10 18 C 6 30 6 34 10 46', ROPE, 1.8)],
  anchor: [...stroke2('M32 12 V54', METAL, 5), circ(32, 9, 5, 'none', 3.5), ...stroke2('M20 22 H44', METAL, 4.5), ...stroke2('M10 38 C 12 52 24 56 32 56 C 40 56 52 52 54 38', METAL, 5), poly('5,42 10,32 16,41', METAL, 2.6), poly('48,41 54,32 59,42', METAL, 2.6)],
  fish: [path('M6 32 C 16 14 40 14 50 32 C 40 50 16 50 6 32 Z', '#7fc4e8'), poly('48,32 62,20 60,32 62,44', '#5ea6d0'), dot(18, 29, 3, OL), path('M28 22 C 32 28 32 36 28 42', 'none', 2.2), hl('M14 24 C 20 20 28 19 34 20', 2, 0.6)],
  tomb: [path('M14 58 V26 A18 18 0 0 1 50 26 V58 Z', '#a8b0b8'), path('M32 20 V44 M24 28 H40', 'none', 4), rect(8, 54, 48, 6, 2, '#6a8a4a')],
  skullsea: [circ(32, 30, 20, '#f0ead8'), rect(22, 44, 20, 12, 4, '#f0ead8'), ell(24, 30, 5, 6, OL, 0), ell(40, 30, 5, 6, OL, 0), path('M27 50 V56 M32 50 V56 M37 50 V56', 'none', 2.2)],
  wallop: [poly(star(32, 32, 28, 14, 9), FIRE_Y), poly(star(32, 32, 16, 8, 9), '#fff6c8', 0)],
  ping: [rect(6, 40, 10, 18, 2, 'currentColor', 0), rect(20, 30, 10, 28, 2, 'currentColor', 0), rect(34, 20, 10, 38, 2, 'currentColor', 0), rect(48, 8, 10, 50, 2, 'currentColor', 0)],
  flag: [...stroke2('M14 6 V60', WOOD, 4), path('M16 8 C 28 2 38 16 54 8 V34 C 38 42 28 28 16 34 Z', 'currentColor')],
} satisfies Record<string, Spec[]>;

export type IconId = keyof typeof ICONS;

const TEXT: Partial<Record<IconId, string>> = { coin: 'G' };

const cache = new Map<string, SVGSVGElement>();

/** A fresh SVG icon element (clone of a cached template). */
export function icon(id: IconId, cls = ''): SVGSVGElement {
  let tpl = cache.get(id);
  if (!tpl) {
    tpl = s('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' });
    for (const [tag, attrs] of ICONS[id] as Spec[]) {
      const el = s(tag, attrs);
      if (tag === 'text') el.textContent = TEXT[id] ?? '';
      tpl.append(el);
    }
    cache.set(id, tpl);
  }
  const el = tpl.cloneNode(true) as SVGSVGElement;
  el.setAttribute('class', `ico ${cls}`.trim());
  return el;
}

/** Swap the icon drawn inside an existing <svg> (keeps the element, so styles and position stay). */
export function setIcon(el: SVGSVGElement, id: IconId): void {
  if (el.dataset.icon === id) return;
  el.dataset.icon = id;
  const tpl = icon(id);
  while (el.firstChild) el.removeChild(el.firstChild);
  while (tpl.firstChild) el.append(tpl.firstChild);
}
