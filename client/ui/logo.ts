// Concept C wordmark: tall condensed block lettering, offset WARS and an angled steel hook.
// Paths are authored here, not text baked into a generated image. The root supplies its accessible name.
import { h, s } from './dom.ts';

let uid = 0;

const LETTERS: Record<string, string> = {
  H: 'M0 0H25V32H60V0H85V85H60V56H25V85H0Z',
  O: 'M9 0H76L85 9V76L76 85H9L0 76V9ZM33 22V63H52V22Z',
  K: 'M0 0H25V32L55 0H85L49 42L87 85H56L25 55V85H0Z',
  W: 'M0 0H28L36 54L50 0H77L92 54L100 0H128L112 85H84L64 40L44 85H16Z',
  A: 'M9 0H76L85 85H60L58 66H27L25 85H0ZM34 23L31 44H54L51 23Z',
  R: 'M0 0H76L85 9V49L63 59L87 85H56L36 61H25V85H0ZM25 23V40H59V23Z',
  S: 'M8 0H77L85 8V25H25V33H77L85 41V77L77 85H8L0 77V60H60V52H8L0 44V8Z',
};

function wordmark(): SVGSVGElement {
  const svg = s('svg', { class: 'dock-wordmark', viewBox: '0 0 310 245', 'aria-hidden': 'true' });
  for (const [row, text] of ['HOOK', 'WARS'].entries()) {
    const transform = row ? 'translate(38 135) rotate(-2) scale(0.64 1.08)' : 'translate(5 26) rotate(-2) scale(0.65 1.08)';
    const word = s('g', { class: row ? 'dock-wars' : 'dock-hook-word', transform });
    let x = 0;
    for (const ch of text) {
      word.append(s('path', { d: LETTERS[ch], transform: `translate(${x} 0)`, 'fill-rule': 'evenodd' }));
      x += ch === 'W' ? 136 : 93;
    }
    svg.append(word);
  }
  const hook = chainHook();
  hook.setAttribute('x', '217');
  hook.setAttribute('y', '-8');
  hook.setAttribute('width', '65');
  hook.setAttribute('height', '170');
  svg.append(hook);
  return svg;
}

function chainHook(): SVGSVGElement {
  const id = `lgm${++uid}`;
  const svg = s('svg', { class: 'logo-hook', viewBox: '0 0 90 230', 'aria-hidden': 'true' });
  const defs = s('defs', {},
    s('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '0' },
      s('stop', { offset: '0', 'stop-color': '#6d7a86' }),
      s('stop', { offset: '0.35', 'stop-color': '#f2f7fa' }),
      s('stop', { offset: '0.6', 'stop-color': '#b9c5ce' }),
      s('stop', { offset: '1', 'stop-color': '#55606a' })));
  svg.append(defs);
  // copper mount the steel chain hangs from
  svg.append(s('rect', { x: 25, y: 0, width: 40, height: 12, rx: 1, fill: '#b76f4e', stroke: '#151d21', 'stroke-width': 3 }));
  const g = s('g', { class: 'swing' });
  const OL = '#151d21';
  // chain links, alternating face-on ovals and edge-on bars
  for (let i = 0; i < 7; i++) {
    const y = 14 + i * 16;
    if (i % 2 === 0) {
      g.append(s('ellipse', { cx: 45, cy: y + 8, rx: 7.5, ry: 10, fill: 'none', stroke: OL, 'stroke-width': 9 }));
      g.append(s('ellipse', { cx: 45, cy: y + 8, rx: 7.5, ry: 10, fill: 'none', stroke: `url(#${id})`, 'stroke-width': 4.5 }));
    } else {
      g.append(s('rect', { x: 41.5, y: y - 2, width: 7, height: 22, rx: 3.5, fill: `url(#${id})`, stroke: OL, 'stroke-width': 3 }));
    }
  }
  // the hook: eye, shank, bend, barb
  const shank = 'M45 128 V170 A24 24 0 1 1 9 158';
  g.append(s('circle', { cx: 45, cy: 128, r: 8, fill: 'none', stroke: OL, 'stroke-width': 10 }));
  g.append(s('circle', { cx: 45, cy: 128, r: 8, fill: 'none', stroke: `url(#${id})`, 'stroke-width': 5 }));
  g.append(s('path', { d: shank, fill: 'none', stroke: OL, 'stroke-width': 17, 'stroke-linecap': 'round' }));
  g.append(s('path', { d: shank, fill: 'none', stroke: `url(#${id})`, 'stroke-width': 10, 'stroke-linecap': 'round' }));
  g.append(s('path', { d: 'M2 168 L6 136 L24 158 Z', fill: '#dfe7ec', stroke: OL, 'stroke-width': 4, 'stroke-linejoin': 'round' }));
  g.append(s('path', { d: 'M49 140 V168', fill: 'none', stroke: 'rgba(255,255,255,0.8)', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  g.append(s('path', { class: 'glint', d: 'M30 196 A20 20 0 0 0 44 188', fill: 'none', stroke: 'rgba(255,255,255,0.9)', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  svg.append(g);
  return svg;
}

export function createLogo(): HTMLElement {
  return h('div', { class: 'logo', role: 'img', 'aria-label': 'Hook Wars' },
    h('div', { class: 'logo-sign' }, wordmark()));
}
