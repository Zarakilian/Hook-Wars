// The server trusts nothing a client sends. These tests throw junk at the validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, cleanText, defaultProfile, FUNNY_NAMES, parseClientMessage, parseConfig, parseProfile } from '../shared/protocol.ts';
import { DEFAULT_CONFIG, PROTOCOL_VERSION } from '../shared/constants.ts';
import { Rng } from '../shared/math.ts';

test('random junk never throws and is rejected', () => {
  const rng = new Rng(42);
  const atoms: unknown[] = [null, true, false, 0, -1, 1e308, -1e308, NaN, 'x', '', [], {}, [1, 2], { t: 'input' }, 'A'.repeat(5000)];
  const keys = ['t', 'v', 'profile', 'i', 'code', 'config', 'item', 'slot', 'stat', 'text', 'team', 'ready', 'c', 'name', 'isPrivate'];
  const types = ['hello', 'listRooms', 'createRoom', 'joinRoom', 'quickPlay', 'leaveRoom', 'setProfile', 'setTeam', 'setConfig', 'ready', 'start', 'input', 'buy', 'sell', 'upgrade', 'chat', 'ping', 'nope'];
  for (let n = 0; n < 5000; n++) {
    const o: Record<string, unknown> = { t: rng.pick(types) };
    const extra = rng.int(0, 4);
    for (let k = 0; k < extra; k++) o[rng.pick(keys)] = rng.pick(atoms);
    const raw = JSON.stringify(o);
    assert.doesNotThrow(() => parseClientMessage(raw));
  }
  for (const raw of ['', 'null', '[]', '"t"', '{', '{"t":1}', '{"t":"input","i":{"seq":1,"mx":1e999}}', 'x'.repeat(10000)]) {
    assert.equal(parseClientMessage(raw), null, raw.slice(0, 40));
  }
});

test('inputs are range checked and movement is normalised', () => {
  const ok = parseClientMessage(JSON.stringify({ t: 'input', i: { seq: 5, mx: 1, mz: 1, ax: 3, az: -4, b: 1 } }));
  assert.ok(ok && ok.t === 'input');
  if (ok && ok.t === 'input') assert.ok(Math.abs(Math.hypot(ok.i.mx, ok.i.mz) - 1) < 1e-9);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'input', i: { seq: 5, mx: 9, mz: 0, ax: 0, az: 0, b: 0 } })), null);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'input', i: { seq: 5, mx: 0, mz: 0, ax: 9999, az: 0, b: 0 } })), null);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'input', i: { seq: 5, mx: 0, mz: 0, ax: 0, az: 0, b: 999 } })), null);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'input', i: { seq: -1, mx: 0, mz: 0, ax: 0, az: 0, b: 0 } })), null);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'input', i: { seq: 1.5, mx: 0, mz: 0, ax: 0, az: 0, b: 0 } })), null);
});

test('names and chat are stripped of control, bidi and markup characters', () => {
  assert.equal(cleanName('  <b>Bob</b>  '), 'bBob/b');
  assert.equal(cleanName('‮evil‬'), 'evil');
  assert.equal(cleanName('\u0000\u0007'), null);
  assert.equal(cleanName('x'.repeat(40))?.length, 16);
  assert.equal(cleanText('a\n\tb​c', 50), 'a bc');
});

test('config validation clamps to known values and drops tidal on maps without tides', () => {
  assert.equal(parseConfig({ ...DEFAULT_CONFIG, teamSize: 6 }), null);
  assert.equal(parseConfig({ ...DEFAULT_CONFIG, mapId: 'mars' }), null);
  assert.equal(parseConfig({ ...DEFAULT_CONFIG, killsToWin: 1000 }), null);
  const c = parseConfig({ ...DEFAULT_CONFIG, mapId: 'muckmire', riverMode: 'tidal' });
  assert.equal(c?.riverMode, 'deep');
  const d = parseConfig({ ...DEFAULT_CONFIG, mapId: 'coralcove', riverMode: 'tidal' });
  assert.equal(d?.riverMode, 'tidal');
});

test('hello requires a valid profile', () => {
  const good = { t: 'hello', v: PROTOCOL_VERSION, profile: { name: 'Al', family: 'ogre', loadout: {} } };
  assert.ok(parseClientMessage(JSON.stringify(good)));
  assert.equal(parseClientMessage(JSON.stringify({ ...good, profile: { ...good.profile, family: 'pudge' } })), null);
  // a loadout with junk, other-family or wrong-slot items is cleaned, never trusted
  const junk = parseClientMessage(JSON.stringify({ ...good, profile: { ...good.profile, loadout: { head: 'brawler.captain_cap', hands: 'ogre.vine_tusk_hook', body: 'ogre.moss_mane', feet: 'x'.repeat(500) } } }));
  assert.ok(junk && junk.t === 'hello');
  if (junk && junk.t === 'hello') assert.deepEqual(junk.profile.loadout, { hands: 'ogre.vine_tusk_hook' });
  assert.equal(parseClientMessage(JSON.stringify({ ...good, profile: { ...good.profile, name: '   ' } })), null);
});

test('the fallback player name is an original fun name, never a Pudge echo, and valid on the wire', () => {
  const p = defaultProfile();
  assert.deepEqual(parseProfile(p), p, 'the default profile must pass its own validation');
  assert.doesNotMatch(p.name, /pudg|butcher/i);
  assert.ok(FUNNY_NAMES.includes(p.name));
  for (const n of FUNNY_NAMES) {
    assert.doesNotMatch(n, /pudg|butcher/i);
    assert.equal(cleanName(`${n}99`), `${n}99`, `${n} plus two digits must fit a name`);
  }
});
