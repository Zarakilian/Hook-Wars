// Renderer, scene, camera, lighting and atmosphere. (Slice version: plain forward render, no post.)
import * as THREE from 'three';
import type { MapDef } from '../../shared/maps/types.ts';
import type { MatchConfig } from '../../shared/types.ts';
import { WATER_LAYER, type Engine, type Quality, type SceneCapture } from './contracts.ts';

export function createEngine(canvas: HTMLCanvasElement, quality: Quality): Engine {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a8c8);
  scene.fog = new THREE.FogExp2(0x87a8c8, 0.01);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 400);
  camera.layers.enable(WATER_LAYER);

  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x3b3326, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 140;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -45;
  sc.right = 45;
  sc.top = 35;
  sc.bottom = -35;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
  const sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();

  let q = quality;
  const engine: Engine = {
    renderer,
    scene,
    camera,
    sun,
    get quality() {
      return q;
    },
    capture: null as SceneCapture | null,
    setQuality(nq: Quality) {
      q = nq;
      renderer.setPixelRatio(nq === 'low' ? 1 : Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = nq !== 'low';
    },
    setAtmosphere(map: MapDef | null, _config: MatchConfig | null) {
      if (!map) {
        scene.background = new THREE.Color(0x1a2233);
        (scene.fog as THREE.FogExp2).color.set(0x1a2233);
        return;
      }
      const a = map.atmosphere;
      scene.background = new THREE.Color(a.skyHorizon);
      const fog = scene.fog as THREE.FogExp2;
      fog.color.set(a.fogColor);
      fog.density = a.fogDensity;
      hemi.color.set(a.skyTop);
      hemi.groundColor.set(a.groundAmbient);
      hemi.intensity = a.ambientIntensity;
      sun.color.set(a.sunColor);
      sun.intensity = a.sunIntensity;
      sunDir.set(a.sunDir[0], a.sunDir[1], a.sunDir[2]).normalize();
      renderer.toneMappingExposure = a.exposure;
    },
    update(_dt: number, _time: number, fx: number, fz: number) {
      sun.position.set(fx + sunDir.x * 60, sunDir.y * 60, fz + sunDir.z * 60);
      sun.target.position.set(fx, 0, fz);
    },
    render() {
      renderer.render(scene, camera);
    },
    resize(w: number, h: number) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
    dispose() {
      renderer.dispose();
    },
  };
  return engine;
}
