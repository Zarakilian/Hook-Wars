// Quiet action symbols for the Iron Dock navigation. Gameplay/item icons retain their identity.
// Original inline paths, the same 64-unit coordinate system as icons.ts, no image assets.
import { s } from './dom.ts';
import { icon, type IconId } from './icons.ts';

const PATHS: Partial<Record<IconId, string>> = {
  play: 'M22 15L48 32L22 49Z',
  globe: 'M32 7A25 25 0 1 0 32 57A25 25 0 1 0 32 7M7 32H57M32 7C17 18 17 46 32 57M32 7C47 18 47 46 32 57M12 20H52M12 44H52',
  people: 'M24 30A10 10 0 1 0 24 10A10 10 0 1 0 24 30M8 53V46C8 36 40 36 40 46V53ZM45 13C57 13 57 30 45 30M47 38C57 38 59 44 59 53H47',
  locker: 'M22 11L14 16L6 30L17 37L21 31V55H43V31L47 37L58 30L50 16L42 11C39 20 25 20 22 11Z',
  shop: 'M11 27H53V55H11ZM7 11H57L53 27H11ZM24 55V38H40V55M20 11V27M32 11V27M44 11V27',
  market: 'M32 8V54M13 54H51M10 19H54M17 19L6 39H28ZM47 19L36 39H58ZM6 39C6 51 28 51 28 39M36 39C36 51 58 51 58 39',
  career: 'M9 54V39H19V54ZM27 54V25H37V54ZM45 54V10H55V54Z',
};

export function plateIcon(id: IconId, cls = ''): SVGSVGElement {
  const d = PATHS[id];
  if (!d) return icon(id, cls);
  return s('svg', { class: `ico plate-ico ${cls}`, viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d, fill: id === 'play' ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 3.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}
