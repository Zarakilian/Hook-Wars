// The desktop build: server/index.ts bundled to one ESM file runs under plain node with ECONOMY=trust
// and serves a player relayed over the stand-in Steam; the preload is one CommonJS file that only
// requires 'electron'; main.cjs needs nothing but electron and Node's own modules at load time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../shared/constants.ts';
import { buildElectron, buildServer } from '../scripts/build.ts';
import { DesktopBridge } from '../src/desktopBridge.ts';
import { FakeHub, FakeSteamBackend, memoryLink } from '../src/fakeSteam.ts';
import type { ChildHandle } from '../src/serverLauncher.ts';
import { client, closeQuietly, hello, nodeSpawner, tempDir, type TestClient } from './helpers.ts';

const out = tempDir('build');

function requiresOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
}

test('the server bundle runs with node, ECONOMY=trust, and serves a player relayed over the stand-in', { timeout: 60_000 }, async () => {
  const bundle = await buildServer(out);
  const src = readFileSync(bundle, 'utf8');
  assert.doesNotMatch(src, /from\s+["']node:sqlite["']/, 'node:sqlite is looked up at run time, not imported');
  assert.doesNotMatch(src, /from\s+["']ws["']/, 'ws is bundled in');
  const hub = new FakeHub();
  const [hostB, joeB] = await Promise.all(['Host', 'Joe'].map((name) => FakeSteamBackend.connect({ link: memoryLink(hub), name, cloudDir: tempDir('cloud') })));
  const spawned: ChildHandle[] = [];
  const host = new DesktopBridge({ backend: hostB, spawnServer: nodeSpawner(bundle, spawned), dataDir: tempDir('host'), economy: 'trust', log: () => {}, leaveFlushMs: 0 });
  const joe = new DesktopBridge({ backend: joeB, spawnServer: () => null!, dataDir: tempDir('joe'), log: () => {} });
  let hc: TestClient | null = null;
  let jc: TestClient | null = null;
  try {
    const hosted = await host.hostLobby({ name: 'Bundle lobby', maxMembers: 2, isPrivate: false });
    hc = client(hosted.url);
    await hc.open;
    hello(hc, 'Host');
    assert.equal((await hc.wait('welcome')).serverName, 'Bundle lobby');
    assert.equal((await hc.wait('econError')).code, 'local_only', 'trust economy');
    const { url } = await joe.joinLobby(hosted.lobbyId);
    jc = client(url);
    await jc.open;
    hello(jc, 'Joe');
    await jc.wait('welcome');
    jc.send({ t: 'createRoom', name: 'Joe room', isPrivate: true, config: { ...DEFAULT_CONFIG, teamSize: 1 } });
    const room = await jc.wait('room');
    assert.equal(room.room.players[0].name, 'Joe');
  } finally {
    closeQuietly(hc);
    closeQuietly(jc);
    await Promise.all([host.shutdown(), joe.shutdown()]);
    for (const c of spawned) c.kill();
  }
});

test('preload.cjs requires only electron; main.cjs only electron and Node built-ins', { timeout: 60_000 }, async () => {
  await buildElectron(out);
  assert.deepEqual([...new Set(requiresOf(join(out, 'preload.cjs')))], ['electron'], 'a sandboxed preload can only require electron');
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const optional = new Set(['bufferutil', 'utf-8-validate']); // ws tries these in a try/catch
  const main = [...new Set(requiresOf(join(out, 'main.cjs')))].filter((m) => !builtins.has(m) && !optional.has(m));
  assert.deepEqual(main, ['electron'], 'steamworks.js is loaded at run time from the app folder, nothing else is needed');
  const mainSrc = readFileSync(join(out, 'main.cjs'), 'utf8');
  assert.match(mainSrc, /sandbox: true/);
  assert.match(mainSrc, /contextIsolation: true/);
  assert.match(mainSrc, /nodeIntegration: false/);
});
