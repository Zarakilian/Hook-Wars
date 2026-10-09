// The local game server launcher, against the real server (server/index.ts run by node, as the app's
// utility process would run the bundle): environment, readiness, clean stop, restart after a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { RELAY_SECRET_RE } from '../../server/config.ts';
import { APP_ORIGIN } from '../src/constants.ts';
import { ServerLauncher, freePort, probeServer, serverNameAsReported, type ChildHandle } from '../src/serverLauncher.ts';
import { SERVER_SOURCE, client, hello, nodeSpawner, sleep, tempDir, until } from './helpers.ts';

function launcher(spawned: ChildHandle[], extra: Partial<ConstructorParameters<typeof ServerLauncher>[0]> = {}) {
  const lines: string[] = [];
  const l = new ServerLauncher({
    spawn: nodeSpawner(SERVER_SOURCE, spawned),
    serverName: 'Test lobby',
    staticDir: tempDir('static'),
    dataDir: tempDir('data'),
    economy: 'trust',
    log: (s) => lines.push(s),
    ...extra,
  });
  return { l, lines };
}

test('the server gets a safe environment: 127.0.0.1, trust economy, a fresh relay secret, the app origin', () => {
  const { l } = launcher([], { parentEnv: { PATH: '/bin', TRUST_PROXY: '1', NODE_OPTIONS: '--require evil.js', ECONOMY: 'on', HOST: '0.0.0.0', SystemRoot: 'C:\\Windows' } });
  const env = l.envFor(41234);
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PORT, '41234');
  assert.equal(env.ECONOMY, 'trust');
  assert.equal(env.ALLOWED_ORIGINS, APP_ORIGIN);
  assert.equal(env.RELAY_SECRET, l.secret);
  assert.match(l.secret, RELAY_SECRET_RE, 'the server accepts the secret shape');
  assert.notEqual(new ServerLauncher({ spawn: () => null!, serverName: 'x', staticDir: '.', dataDir: '.' }).secret, l.secret, 'a new secret per launcher');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.TRUST_PROXY, undefined, 'a proxy setting would make X-Forwarded-For trusted');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(serverNameAsReported('A <b>lobby</b>\u0007'), 'A blobby/b');
});

test('start: free port, ready when it answers a hello, a game client can connect; stop ends it', async () => {
  const spawned: ChildHandle[] = [];
  const { l } = launcher(spawned);
  try {
    const url = await l.start();
    assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
    assert.equal(l.running, true);
    assert.equal(await l.start(), url, 'start twice: same server');
    const c = client(url);
    await c.open;
    hello(c, 'Host');
    const w = await c.wait('welcome');
    assert.equal(w.serverName, 'Test lobby');
    const e = await c.wait('econError');
    assert.equal(e.code, 'local_only', 'ECONOMY=trust answers economy with local_only');
    c.ws.close();
    let exited = false;
    spawned[0].onExit(() => (exited = true));
    await l.stop();
    assert.equal(l.running, false);
    await until(() => exited, 3000, 'process exit');
    assert.equal(await probeServer(url, 'Test lobby', 500), false);
  } finally {
    await l.stop();
  }
});

test('a crash restarts the server on the same port; repeated crashes give up', async () => {
  const spawned: ChildHandle[] = [];
  const { l, lines } = launcher(spawned, { maxRestarts: 1 });
  let restarted = '';
  let failed = '';
  l.onRestart = (u) => (restarted = u);
  l.onFailed = (r) => (failed = r);
  try {
    const url = await l.start();
    spawned[0].kill(); // a crash, as far as the launcher knows
    await until(() => restarted !== '', 15_000, 'restart');
    assert.equal(restarted, url, 'same address, so the page can rejoin');
    assert.ok(await probeServer(url, 'Test lobby'));
    assert.ok(lines.some((s) => s.includes('crashed')));
    spawned[spawned.length - 1].kill();
    await until(() => failed !== '', 5000, 'give up');
    assert.match(failed, /keeps crashing/);
  } finally {
    await l.stop();
  }
});

test('a port taken between choosing and binding: the launcher tries another one', async () => {
  const spawned: ChildHandle[] = [];
  const port = await freePort();
  const squatter = createServer();
  await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', () => r()));
  const { l, lines } = launcher(spawned, { readyTimeoutMs: 8000 });
  // force the first attempt onto the taken port
  const internals = l as unknown as { launch(port: number, firstTry: boolean): Promise<string> };
  try {
    const url = await internals.launch(port, true);
    assert.ok(!url.includes(`:${port}/`), 'moved to a free port');
    assert.ok(lines.some((s) => s.includes('trying another port')));
  } finally {
    await l.stop();
    squatter.close();
  }
});

test('a server that never answers fails the start in time and is killed', async () => {
  const spawned: ChildHandle[] = [];
  let killed = false;
  const l = new ServerLauncher({
    spawn: () => {
      const h: ChildHandle = { kill: () => (killed = true), onExit: () => {}, onOutput: () => {} };
      spawned.push(h);
      return h;
    },
    serverName: 'x',
    staticDir: '.',
    dataDir: '.',
    readyTimeoutMs: 600,
  });
  await assert.rejects(l.start(), /did not start in time/);
  assert.equal(killed, true);
  await sleep(10);
});
