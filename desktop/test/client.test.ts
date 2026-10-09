// The built game client against the app:// protocol and its CSP: every file the build makes is served
// (a file type the protocol does not know would be a silent 404 in the app), index.html has no inline
// script (script-src 'self'), every asset URL is relative (base './'), and the code needs no eval or
// WebAssembly compile (the CSP allows neither).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { APP_CSP, MIME, resolveAppRequest } from '../src/appProtocol.ts';
import { APP_ORIGIN } from '../src/constants.ts';
import { buildClient } from '../scripts/build.ts';
import { tempDir } from './helpers.ts';

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

test('the client build is served by app:// and fits the CSP', { timeout: 120_000 }, async () => {
  const out = tempDir('client');
  await buildClient(out);
  const root = join(out, 'client');
  const files = filesUnder(root);
  assert.ok(files.length >= 3, 'index.html, a script and a stylesheet at least');

  // every file resolves to itself with a MIME type
  for (const f of files) {
    const rel = relative(root, f).split(sep).join('/');
    const r = resolveAppRequest(`${APP_ORIGIN}/${rel}`, root);
    assert.ok(r.ok, `${rel}: no MIME type for ${extname(f) || '(none)'}: add it to MIME in src/appProtocol.ts`);
    if (r.ok) assert.equal(r.file, f);
  }

  // index.html: only external scripts, no inline handlers, relative URLs
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc="\.\/[^"]+"/, 'every script is a file from the app');
    assert.equal(body.trim(), '', 'no inline script');
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
  for (const [, url] of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    assert.ok(url.startsWith('./') || url.startsWith('data:'), `relative or data: URL, not ${url}`);
  }

  // CSS: fonts and images come from the app (or data:), never a remote host or the drive root
  for (const css of files.filter((f) => f.endsWith('.css'))) {
    for (const [, raw] of readFileSync(css, 'utf8').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      assert.ok(!/^(https?:)?\/\//i.test(raw) && !raw.startsWith('/'), `${relative(root, css)}: url(${raw})`);
    }
  }

  // JS: nothing the CSP would block at run time
  assert.doesNotMatch(APP_CSP, /unsafe-eval|wasm-unsafe-eval/);
  for (const js of files.filter((f) => MIME[extname(f)]?.startsWith('text/javascript'))) {
    const src = readFileSync(js, 'utf8');
    assert.doesNotMatch(src, /\bnew Function\s*\(|(?<![\w.$])eval\s*\(/, `${relative(root, js)} uses eval`);
    assert.doesNotMatch(src, /WebAssembly\.(?:instantiate|compile)/, `${relative(root, js)} compiles WebAssembly: the CSP needs 'wasm-unsafe-eval' first`);
    assert.doesNotMatch(src, /\bimportScripts\s*\(/, `${relative(root, js)} uses importScripts`);
  }
});
