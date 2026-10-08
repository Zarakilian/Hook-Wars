// Pudgy characters: Harbour Brawler, Swamp Ogre, Butcher-Bot. (Slice version: simple voxel blobs.)
import * as THREE from 'three';
import type { Cosmetics, FamilyId, Team } from '../../../shared/types.ts';
import { UnitState } from '../../../shared/types.ts';
import { TEAM_COLORS, type PudgyAnimInput, type PudgyOneShot, type PudgyOptions, type PudgyPalette, type PudgyView } from '../contracts.ts';
import { shade, VoxelGrid, voxelMaterial, voxelMesh } from '../voxel/voxel.ts';

const SKIN: Record<FamilyId, number> = { brawler: 0xe0a882, ogre: 0x7d9a4a, bot: 0x9aa3ad };

export function pudgyPalette(family: FamilyId, _cosmetics: Cosmetics, team: Team): PudgyPalette {
  const skin = SKIN[family];
  return { skin, skinDark: shade(skin, 0.7), cloth: TEAM_COLORS[team].main, accent: 0xf2d16b, metal: 0x8d939a, extra: [0x4a3020] };
}

export function createPudgy(o: PudgyOptions): PudgyView {
  const pal = pudgyPalette(o.family, o.cosmetics, o.team);
  const g = new VoxelGrid(16, 22, 14);
  g.ellipsoid(8, 8, 7, 7, 8, 6.5, pal.skin);
  g.ellipsoid(8, 7, 9, 6.2, 5.5, 4.5, pal.cloth);
  g.ellipsoid(8, 17, 7, 4.5, 4, 4, pal.skin);
  g.box(6, 17, 10, 6, 17, 10, 0x111111);
  g.box(9, 17, 10, 9, 17, 10, 0x111111);
  const root = new THREE.Group();
  const body = voxelMesh(g, { size: 0.1 });
  root.add(body);
  const hand = new THREE.Object3D();
  hand.position.set(0.75, 1.0, 0.45);
  root.add(hand);
  const mat = body.material as THREE.MeshStandardMaterial;
  let bob = 0;
  return {
    root,
    getHandWorld(out) {
      return hand.getWorldPosition(out);
    },
    update(dt: number, a: PudgyAnimInput) {
      bob += dt * (2 + a.speed * 1.6);
      const moving = a.speed > 0.5;
      body.position.y = moving ? Math.abs(Math.sin(bob * 2)) * 0.12 : Math.sin(bob) * 0.03;
      body.rotation.z = moving ? Math.sin(bob * 2) * 0.06 : 0;
      body.rotation.x = a.state === UnitState.Hooked ? -0.6 : a.state === UnitState.Knocked ? -0.9 : 0;
      root.visible = a.state !== UnitState.Dead;
    },
    play(_kind: PudgyOneShot) {},
    setOpacity(alpha: number) {
      if (alpha < 1 && mat === voxelMaterial()) body.material = voxelMaterial({ transparent: true, opacity: alpha });
      else if (alpha >= 1) body.material = voxelMaterial();
    },
    dispose() {
      body.geometry.dispose();
    },
  };
}
