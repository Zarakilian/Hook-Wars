// Pure checks: IPC argument validation, the app:// file mapping and its headers, command-line switches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { APP_CSP, appHeaders, resolveAppRequest } from '../src/appProtocol.ts';
import { isSteamId64 } from '../src/constants.ts';
import { chooseAppId, parseLaunchArgs } from '../src/launchArgs.ts';
import * as check from '../src/validate.ts';

test('lobby ids and SteamIDs are 64-bit decimal strings only', () => {
  assert.equal(isSteamId64('109775240000000001'), true);
  assert.equal(isSteamId64('18446744073709551615'), true);
  assert.equal(isSteamId64('18446744073709551616'), false, 'over 64 bits');
  assert.equal(isSteamId64('0'), false);
  assert.equal(isSteamId64('0123'), false);
  assert.equal(isSteamId64('12 34'), false);
  assert.equal(isSteamId64(12345), false);
  assert.equal(check.lobbyId('1e5').ok, false);
});

test('host options and lobby info are cleaned and bounded', () => {
  const h = check.hostOpts({ name: '  <b>Big</b>\u0000 lobby\u2028 ', maxMembers: 10, isPrivate: true });
  assert.deepEqual(h, { ok: true, value: { name: 'bBig/b lobby', maxMembers: 10, isPrivate: true } });
  assert.equal(check.hostOpts({ name: '   ', maxMembers: 4, isPrivate: false }).ok, false);
  assert.equal(check.hostOpts({ name: 'x', maxMembers: 1, isPrivate: false }).ok, false);
  assert.equal(check.hostOpts({ name: 'x', maxMembers: 4.5, isPrivate: false }).ok, false);
  assert.equal(check.hostOpts(Object.assign(Object.create({ evil: 1 }), { name: 'x', maxMembers: 4, isPrivate: false })).ok, false, 'not a plain object');
  assert.equal(check.hostOpts([]).ok, false);
  const info = check.lobbyInfo({ room: 'ABCDE', map: 'coral\u0007', humans: '3' });
  assert.deepEqual(info, { ok: true, value: { room: 'ABCDE', map: 'coral', humans: '3' } });
  assert.equal(check.lobbyInfo({ room: 5 }).ok, false);
  assert.equal(check.lobbyInfo({ ['x'.repeat(33)]: 'y' }).ok, false);
  assert.equal(check.lobbyInfo({ room: 'y'.repeat(129) }).ok, false);
  assert.equal(check.lobbyInfo(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']))).ok, false);
  for (const k of ['game', 'v', 'host']) assert.equal(check.lobbyInfo({ [k]: 'x' }).ok, false, k);
  assert.equal(check.lobbyInfo({ __proto__: 'x' }).ok, true, 'an own __proto__ key is just dropped by the literal');
});

test('cloud names, cloud data, overlay urls, flags and the trusted sender', () => {
  assert.equal(check.cloudName('locker.json').ok, true);
  for (const bad of ['', '.hidden', '../x', 'a/b', 'a\\b', 'x'.repeat(65), 'a..b', 5]) assert.equal(check.cloudName(bad).ok, false, String(bad));
  assert.equal(check.cloudData('x'.repeat(1024 * 1024)).ok, true);
  assert.equal(check.cloudData('é'.repeat(600 * 1024)).ok, false, 'counted in UTF-8 bytes');
  assert.equal(check.overlayUrl('https://store.steampowered.com/itemstore/480/').ok, true);
  assert.equal(check.overlayUrl('https://steamcommunity.com/market/').ok, true);
  for (const bad of ['http://store.steampowered.com/', 'https://store.steampowered.com.evil.example/', 'https://user:pw@steamcommunity.com/', 'javascript:alert(1)', 'https://steamcommunity.com:8443/', 'file:///C:/x']) {
    assert.equal(check.overlayUrl(bad).ok, false, bad);
  }
  assert.equal(check.flag(true).ok, true);
  assert.equal(check.flag('true').ok, false);
  assert.equal(check.isTrustedSender('app://hookwars/index.html'), true);
  assert.equal(check.isTrustedSender('app://evil/index.html'), false);
  assert.equal(check.isTrustedSender('https://hookwars/'), false);
  assert.equal(check.isTrustedSender(null), false);
});

test('app:// maps to files inside the client folder only', () => {
  const root = resolve('/srv/client');
  const ok = (u: string) => {
    const r = resolveAppRequest(u, root);
    assert.ok(r.ok, `${u} refused`);
    return r;
  };
  assert.equal(ok('app://hookwars/').file, join(root, 'index.html'));
  assert.equal(ok('app://hookwars/index.html').mime, 'text/html; charset=utf-8');
  assert.equal(ok('app://hookwars/assets/main-abc.js').file, join(root, 'assets', 'main-abc.js'));
  assert.equal(ok('app://hookwars/assets/font%20x.woff2').mime, 'font/woff2');
  // dot segments the URL parser resolves itself stay inside the folder
  for (const u of ['app://hookwars/../secret.js', 'app://hookwars/%2e%2e/%2e%2e/secret.js', 'app://hookwars/assets/../../../secret.js']) {
    const r = resolveAppRequest(u, root);
    assert.ok(!r.ok || r.file === join(root, 'secret.js'), `${u} escaped: ${JSON.stringify(r)}`);
  }
  const refused: [string, number][] = [
    ['app://other/index.html', 403],
    ['https://hookwars/index.html', 403],
    ['app://hookwars/assets/..%2f..%2fsecret.js', 404],
    ['app://hookwars/a%5c..%5csecret.js', 400],
    ['app://hookwars/.env', 404],
    ['app://hookwars/x%00.js', 400],
    ['app://hookwars/%E0%A4%A', 400],
    ['app://hookwars/readme.md', 404],
  ];
  for (const [u, status] of refused) assert.deepEqual(resolveAppRequest(u, root), { ok: false, status }, u);
  const h = appHeaders('text/html; charset=utf-8');
  assert.equal(h['Content-Security-Policy'], APP_CSP);
  assert.match(APP_CSP, /default-src 'none'/);
  assert.match(APP_CSP, /script-src 'self'(;|$)/);
  assert.doesNotMatch(APP_CSP, /unsafe-eval|https?:/);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
});

test('command line: +connect_lobby from Steam, stand-in switches, app id choice', () => {
  assert.deepEqual(parseLaunchArgs(['electron', '.', '+connect_lobby', '109775240000000001']), { joinLobby: '109775240000000001', fake: false, instance: null, fakeName: null });
  assert.equal(parseLaunchArgs(['x', '+connect_lobby', 'nope']).joinLobby, null);
  assert.equal(parseLaunchArgs(['x', '+connect_lobby=109775240000000002']).joinLobby, '109775240000000002');
  const f = parseLaunchArgs(['x', '--fake-steam', '--instance=2', '--fake-name=Bob <script>'], {});
  assert.deepEqual(f, { joinLobby: null, fake: true, instance: 2, fakeName: 'Bob script' });
  assert.equal(parseLaunchArgs(['x', '--instance=42']).instance, null);
  assert.equal(parseLaunchArgs([], { HOOKWARS_FAKE_STEAM: '1' }).fake, true);
  assert.equal(parseLaunchArgs([], { HOOKWARS_FAKE_STEAM: 'yes' }).fake, false);
  assert.equal(chooseAppId({}, '480\r\n'), 480);
  assert.equal(chooseAppId({ HOOKWARS_STEAM_APP_ID: '123456' }, '480'), 123456);
  assert.equal(chooseAppId({}, null), undefined, 'launched by Steam: Steam decides');
  assert.equal(chooseAppId({ HOOKWARS_STEAM_APP_ID: 'abc' }, 'x'), undefined);
});
