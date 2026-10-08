// River water. (Slice version: a translucent animated plane.)
import * as THREE from 'three';
import { channelDepthAt } from '../../../shared/maps/helpers.ts';
import type { MapDef } from '../../../shared/maps/types.ts';
import type { MatchConfig, RiverState } from '../../../shared/types.ts';
import { WATER_LAYER, waterY, type Engine, type WaterView, type WorldView } from '../contracts.ts';

export function createWater(map: MapDef, config: MatchConfig, _engine: Engine, _world: WorldView): WaterView {
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(map.w * 0.5, map.d + 8, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: map.atmosphere.waterDeep, transparent: true, opacity: 0.78, roughness: 0.15, metalness: 0.1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.layers.set(WATER_LAYER);
  group.add(mesh);
  let level = config.riverMode === 'dry' ? 0 : 1;
  return {
    group,
    surfaceHeight(x: number, z: number) {
      if (channelDepthAt(map, x, z) < -map.river.bank) return -Infinity;
      return waterY(map, level);
    },
    update(_dt: number, _time: number, river: RiverState) {
      level = river.level;
      mesh.position.y = waterY(map, level);
      mesh.visible = config.riverMode !== 'dry';
      mat.color.set(river.frozen ? 0xdff1ff : map.atmosphere.waterDeep);
      mat.opacity = river.frozen ? 0.95 : 0.78;
    },
    disturb() {},
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
