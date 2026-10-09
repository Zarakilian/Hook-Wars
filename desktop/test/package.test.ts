// desktop/package.json: exact versions only (the org rule: pinned, vetted packages), and a packaging
// setup that actually ships what the app needs at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopDir, rootDir } from './helpers.ts';

type Pkg = {
  main: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    directories: { output: string; buildResources?: string };
    files: string[];
    asarUnpack: string[];
    extraFiles?: { from: string; to: string }[];
  };
};

const pkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as Pkg;

test('every dependency is pinned to an exact version', () => {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.deepEqual(Object.keys(all).sort(), ['electron', 'electron-builder', 'steamworks.js', 'ws']);
  for (const [name, v] of Object.entries(all)) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `${name} must be an exact version, not "${v}"`);
  }
  // the desktop app's ws is the same one the game server is tested with
  const root = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies.ws, root.dependencies.ws);
});

test('packaging ships build/ (main, preload, server, client) and unpacks what cannot run from the asar', () => {
  assert.equal(pkg.main, 'build/main.cjs');
  // electron-builder leaves its buildResources folder (default "build") out of the app: that is our output
  assert.ok(pkg.build.directories.buildResources && pkg.build.directories.buildResources !== 'build', 'buildResources must not be build/');
  assert.ok(pkg.build.files.includes('build/**/*'));
  assert.ok(pkg.build.asarUnpack.includes('build/server.mjs'), 'the game server runs as a utility process from a real file');
  assert.ok(pkg.build.asarUnpack.includes('node_modules/steamworks.js/**'), 'the .node binary and steam_api64.dll load from disk');
  // the test build carries steam_appid.txt (480) next to the exe; docs/steam-desktop.md part D removes it for release
  assert.deepEqual(pkg.build.extraFiles, [{ from: 'steam_appid.txt', to: 'steam_appid.txt' }]);
  assert.equal(readFileSync(join(desktopDir, 'steam_appid.txt'), 'utf8').trim(), '480');
});

test('the scripts the home-PC guide uses exist and point at real files', () => {
  for (const s of ['build', 'typecheck', 'typecheck:electron', 'start', 'start:fake', 'start:fake2', 'test', 'dist']) {
    assert.ok(pkg.scripts[s], `script ${s}`);
  }
  assert.match(pkg.scripts['start:fake'], /--fake\b/);
  assert.match(pkg.scripts.dist, /electron-builder .*--publish never/);
  for (const f of ['scripts/build.ts', 'scripts/start.ts', 'tsconfig.json', 'tsconfig.electron.json', '.gitignore']) {
    assert.ok(existsSync(join(desktopDir, f)), f);
  }
  const ignore = readFileSync(join(desktopDir, '.gitignore'), 'utf8');
  for (const line of ['node_modules/', 'build/', 'dist/']) assert.ok(ignore.split(/\r?\n/).includes(line), `.gitignore has ${line}`);
});
