// Finding 41: named hook power-ups in the HUD buff row. The name used to be absolutely positioned
// over its ring, so two or three names overlapped. It now sits in the row's flow (a .buff-col column
// above the ring), and because it is no longer inside .buff it needs its own pop and end-of-timer
// blink. The layout itself is measured in the browser (labels 4.8 px apart at 1280x720, 6.4 px at
// 1920x1080); these checks keep the CSS and the class toggling from sliding back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../hud/hud.css', import.meta.url), 'utf8');
const bar = readFileSync(new URL('../hud/bottombar.ts', import.meta.url), 'utf8');

/** Declarations of every top-level rule whose selector list is exactly `sel` (comments stripped). */
function rules(sel: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (sels.includes(sel)) out.push(m[2]);
  }
  return out;
}

test('the power-up name is laid out in the row, not absolutely over its ring', () => {
  const name = rules('.bf-name');
  assert.ok(name.length > 0, '.bf-name has a rule');
  for (const body of name) assert.doesNotMatch(body, /position:\s*absolute/, 'an absolute name overlaps its neighbours');
  const col = rules('.buff-col').join(';');
  assert.match(col, /display:\s*flex/);
  assert.match(col, /flex-direction:\s*column/);
  assert.match(bar, /class: 'buff-col'/, 'bottombar wraps a named power-up in a .buff-col');
});

test('the name pops in and blinks near the end together with its ring', () => {
  assert.match(rules('.buff-col .bf-name').join(';'), /animation:\s*pop\b/);
  assert.match(rules('.buff-col.ending .bf-name').join(';'), /animation:\s*buffEnd\b/);
  // the same keyframes as the ring, so both blink in step
  assert.match(rules('.buff.ending').join(';'), /animation:\s*buffEnd\b/);
  assert.match(bar, /setClass\(el\.root, 'ending'/, 'the column gets the ending class, not only the ring');
});
