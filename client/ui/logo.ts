// The animated HOOK WARS wordmark: chunky extruded letters that bob like buoys, and a barbed hook
// swinging on a chain from the top of the sign. Built with createElementNS, animated in CSS.
import { h, s } from './dom.ts';

let uid = 0;

function word(text: string, cls: string, delay0: number): HTMLElement {
  const w = h('span', { class: `lw ${cls}` });
  [...text].forEach((ch, i) => {
    const l = h('span', { class: 'll', 'data-l': ch, style: `--d:${(delay0 + i * 0.11).toFixed(2)}s` });
    l.textContent = ch;
    w.append(l);
  });
  return w;
}

function chainHook(): SVGSVGElement {
  const id = `lgm${++uid}`;
  const svg = s('svg', { class: 'logo-hook', viewBox: '0 0 90 230', 'aria-hidden': 'true' });
  const defs = s('defs', {},
    s('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '0' },
      s('stop', { offset: '0', 'stop-color': '#6d7a86' }),
      s('stop', { offset: '0.35', 'stop-color': '#f2f7fa' }),
      s('stop', { offset: '0.6', 'stop-color': '#b9c5ce' }),
      s('stop', { offset: '1', 'stop-color': '#55606a' })),
    s('linearGradient', { id: `${id}b`, x1: '0', y1: '0', x2: '0', y2: '1' },
      s('stop', { offset: '0', 'stop-color': '#ffe89a' }),
      s('stop', { offset: '0.5', 'stop-color': '#d9a03a' }),
      s('stop', { offset: '1', 'stop-color': '#8a5612' })));
  svg.append(defs);
  // brass mount the chain hangs from
  svg.append(s('rect', { x: 25, y: 0, width: 40, height: 12, rx: 4, fill: `url(#${id}b)`, stroke: '#2a160a', 'stroke-width': 3 }));
  const g = s('g', { class: 'swing' });
  const OL = '#24140a';
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
  // a little fish caught on the barb, for slapstick
  const fish = s('g', { class: 'logo-fish' },
    s('path', { d: 'M4 150 C 12 138 30 138 36 150 C 30 162 12 162 4 150 Z', fill: '#ff9a3c', stroke: OL, 'stroke-width': 3 }),
    s('path', { d: 'M34 150 L46 140 L44 150 L46 160 Z', fill: '#e86a1c', stroke: OL, 'stroke-width': 3, 'stroke-linejoin': 'round' }),
    s('circle', { cx: 13, cy: 147, r: 2.6, fill: OL }),
    s('path', { d: 'M20 142 C 23 147 23 153 20 158', fill: 'none', stroke: OL, 'stroke-width': 2 }));
  fish.setAttribute('transform', 'translate(-4 30) rotate(-20 20 150)');
  g.append(fish);
  svg.append(g);
  return svg;
}

export function createLogo(): HTMLElement {
  return h('div', { class: 'logo', role: 'img', 'aria-label': 'Hook Wars' },
    h('div', { class: 'logo-sign' },
      h('div', { class: 'logo-words' }, word('HOOK', 'lw-hook', 0), word('WARS', 'lw-wars', 0.45)),
      chainHook()),
    h('div', { class: 'logo-ribbon' }, h('span', { text: 'Fish for your friends' })));
}
