// Terrain, banks, river bed, props, decor, fountains. (Slice version: one displaced plane.)
import * as THREE from 'three';
import { channelDepthAt } from '../../../shared/maps/helpers.ts';
import type { MapDef } from '../../../shared/maps/types.ts';
import { fbm2 } from '../../../shared/math.ts';
import type { HazardInst } from '../../../shared/sim/entities.ts';
import type { MatchConfig, RiverState } from '../../../shared/types.ts';
import { bedY, groundY, waterY, type AnimatedView, type Engine, type WorldView } from '../contracts.ts';
import { buildDecor, buildProps, createFountainView } from '../models/props.ts';

/** Shared ground height function: bank top, a sloped bank and the river bed. */
export function makeHeightFn(map: MapDef): (x: number, z: number) => number {
  const top = groundY(map);
  const bed = bedY(map);
  const bank = map.river.bank;
  return (x: number, z: number) => {
    const c = channelDepthAt(map, x, z);
    const n = (fbm2(x * map.terrain.noiseScale, z * map.terrain.noiseScale, 3, 5) - 0.5) * 2 * map.terrain.noiseAmp;
    if (c <= -bank) return top + n;
    if (c <= 0) {
      const t = (c + bank) / bank; // 0 at bank start, 1 at the edge
      return top + n * (1 - t) - t * t * 0.45;
    }
    const k = Math.min(1, c / 1.6);
    return top - 0.45 - (top - 0.45 - bed) * (k * k * (3 - 2 * k));
  };
}

export function buildWorld(map: MapDef, config: MatchConfig, _hazards: HazardInst[], _engine: Engine): WorldView {
  const group = new THREE.Group();
  const height = makeHeightFn(map);
  const segX = Math.round(map.w * 2.5);
  const segZ = Math.round(map.d * 2.5);
  const geo = new THREE.PlaneGeometry(map.w, map.d, segX, segZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  const grass = map.terrain.grass[0];
  const bankC = map.terrain.bank[0];
  const bedC = config.riverMode === 'dry' ? map.terrain.dryBed[0] : map.terrain.bed[0];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, height(x, z));
    const c = channelDepthAt(map, x, z);
    col.setHex(c > 0 ? bedC : c > -map.river.bank ? bankC : grass, THREE.SRGBColorSpace);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  ground.receiveShadow = true;
  group.add(ground);

  group.add(buildProps(map.obstacles, map, height));
  group.add(buildDecor(map.decor, map, height, () => waterY(map, 1)));
  const fountains: AnimatedView[] = [0, 1].map((t) => {
    const f = createFountainView(t as 0 | 1, map.fountains[t], map);
    f.root.position.set(map.fountains[t].x, height(map.fountains[t].x, map.fountains[t].z), map.fountains[t].z);
    group.add(f.root);
    return f;
  });

  return {
    group,
    groundHeight: height,
    update(dt: number, time: number, _river: RiverState) {
      for (const f of fountains) f.update(dt, time);
    },
    dispose() {
      geo.dispose();
      for (const f of fountains) f.dispose();
    },
  };
}
