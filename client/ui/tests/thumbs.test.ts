// Finding 38: item thumbnails must frame the item itself, the same way every time. Runs the real
// character models (createPudgy works without a DOM) through the thumbnail item locator.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { COSMETICS, cosmeticById, type CosmeticDef } from '../../../shared/cosmetics.ts';
import { createPudgy } from '../../render/models/pudgy.ts';
import { ItemLocator, meshGeometries, newMeshes, pinPose, visibleMeshes } from '../thumbFrame.ts';

const HOOKS = COSMETICS.filter((c) => c.slot === 'hands');
const YAW = -0.6;

/** Does this mesh sit under a node whose name starts with prefix (or is it one)? */
function under(o: THREE.Object3D, test: (name: string) => boolean): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (test(p.name)) return true;
  return false;
}

function describe(def: CosmeticDef, loc: ItemLocator) {
  const shot = loc.locate(def, YAW);
  assert.ok(shot, `${def.id}: the model draws it`);
  const out = {
    names: shot.meshes.map((m) => m.name).sort(),
    box: shot.box ? [...shot.box.min.toArray(), ...shot.box.max.toArray()].map((v) => v.toFixed(4)).join(' ') : 'none',
    hookOnly: shot.meshes.every((m) => under(m, (n) => n.startsWith('hw-held'))),
    boxH: shot.box ? shot.box.getSize(new THREE.Vector3()).y : Infinity,
    fullH: new THREE.Box3().setFromObject(shot.view.root).getSize(new THREE.Vector3()).y,
  };
  shot.view.dispose();
  return out;
}

test('there are 10 hooks to check', () => {
  assert.equal(HOOKS.length, 10);
});

test('every hook thumbnail frames the hook itself, not the body', () => {
  const loc = new ItemLocator();
  try {
    for (const def of HOOKS) {
      const d = describe(def, loc);
      assert.notEqual(d.box, 'none', `${def.id}: framed on the item`);
      assert.ok(d.names.length > 0, def.id);
      assert.ok(d.hookOnly, `${def.id}: only the held hook's meshes (${d.names.join(', ')})`);
      assert.ok(d.boxH < d.fullH * 0.85, `${def.id}: box ${d.boxH.toFixed(2)} m of ${d.fullH.toFixed(2)} m`);
    }
  } finally {
    loc.dispose();
  }
});

test('Featured items frame their own part (Crystal Tusks, Chrome Crown, Golden Harpoon)', () => {
  const loc = new ItemLocator();
  try {
    for (const id of ['ogre.crystal_tusks', 'bot.chrome_crown', 'brawler.golden_harpoon']) {
      const d = describe(cosmeticById(id)!, loc);
      assert.notEqual(d.box, 'none', id);
      assert.ok(d.boxH < d.fullH * 0.5, `${id}: box ${d.boxH.toFixed(2)} m of ${d.fullH.toFixed(2)} m (${d.names.join(', ')})`);
    }
  } finally {
    loc.dispose();
  }
});

test('framing is identical across builds, whatever else was built in between', () => {
  const ids = ['bot.crane_hook', 'bot.magnet_hook', 'ogre.crystal_tusks', 'brawler.captain_cap', 'bot.chrome_crown'];
  const first = new ItemLocator();
  const a = ids.map((id) => describe(cosmeticById(id)!, first));
  first.dispose();
  // other models built in between move the global animator seed on
  for (let i = 0; i < 5; i++) createPudgy({ family: 'bot', loadout: {}, team: 1, name: 'x', isLocal: false, quality: 'high', detail: 'showcase' }).dispose();
  const second = new ItemLocator();
  const b = ids.map((id) => describe(cosmeticById(id)!, second));
  second.dispose();
  assert.deepEqual(b, a);
});

test('pose is pinned: two thumbnail builds of one look stand exactly alike', () => {
  const box = () => {
    const v = createPudgy({ family: 'brawler', loadout: {}, team: 0, name: 't', isLocal: false, quality: 'high', detail: 'showcase' });
    assert.ok(pinPose(v), 'the animator seed can be pinned');
    v.update(1 / 60, { state: 0 as never, speed: 0, hpFrac: 1, flags: 0, hookOut: false, stateTime: 0.5, time: 0.5 });
    v.root.updateMatrixWorld(true);
    const s = new THREE.Box3().setFromObject(v.root);
    v.dispose();
    return [...s.min.toArray(), ...s.max.toArray()].map((x) => x.toFixed(5)).join(' ');
  };
  assert.equal(box(), box());
});

test('two views alive together share geometry for every part they have in common', () => {
  const a = createPudgy({ family: 'ogre', loadout: {}, team: 0, name: 'a', isLocal: false, quality: 'high', detail: 'showcase' });
  const b = createPudgy({ family: 'ogre', loadout: { face: 'ogre.crystal_tusks' }, team: 0, name: 'b', isLocal: false, quality: 'high', detail: 'showcase' });
  const fresh = newMeshes(b.root, meshGeometries(a.root));
  assert.ok(fresh.length > 0 && fresh.length < visibleMeshes(b.root).length / 2, `${fresh.length} new of ${visibleMeshes(b.root).length}`);
  a.dispose();
  b.dispose();
});
