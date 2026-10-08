// Planar reflection for high/ultra: the scene (default layer only, water layer skipped) mirrored about
// the mean water plane into a half-res target, with an oblique near plane so the river bed never shows.
import * as THREE from 'three';
import { WATER_LAYER } from '../../contracts.ts';

export class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  private readonly cam = new THREE.PerspectiveCamera();
  private readonly plane = new THREE.Plane();
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly pos = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly rotM = new THREE.Matrix4();
  private readonly look = new THREE.Vector3(0, 0, -1);
  private readonly view = new THREE.Vector3();
  private readonly target3 = new THREE.Vector3();
  private readonly q = new THREE.Vector4();
  private readonly clip = new THREE.Vector4();
  private readonly size = new THREE.Vector2();
  private scale: number;
  frame = 0;

  constructor(scale: number) {
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true, samples: 0 });
    this.target.texture.generateMipmaps = false;
    this.target.texture.minFilter = THREE.LinearFilter;
    this.target.texture.magFilter = THREE.LinearFilter;
    this.cam.layers.set(0);
    this.cam.layers.disable(WATER_LAYER);
  }

  setScale(s: number): void {
    this.scale = s;
  }

  /** Render the mirrored scene. Returns false when the camera is below the plane. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, planeY: number): boolean {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(4, Math.floor(this.size.x * this.scale));
    const h = Math.max(4, Math.floor(this.size.y * this.scale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    this.pos.set(0, planeY, 0);
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    this.rotM.extractRotation(camera.matrixWorld);
    this.view.subVectors(this.pos, this.camPos);
    if (this.view.dot(this.normal) > 0) return false;
    // mirror the camera position
    this.view.reflect(this.normal).negate();
    this.view.add(this.pos);
    this.look.set(0, 0, -1).applyMatrix4(this.rotM).add(this.camPos);
    this.target3.subVectors(this.pos, this.look);
    this.target3.reflect(this.normal).negate();
    this.target3.add(this.pos);
    const cam = this.cam;
    cam.position.copy(this.view);
    cam.up.set(0, 1, 0).applyMatrix4(this.rotM).reflect(this.normal);
    cam.lookAt(this.target3);
    cam.near = camera.near;
    cam.far = Math.min(camera.far, 120);
    cam.fov = camera.fov;
    cam.aspect = camera.aspect;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(cam.projectionMatrix);
    this.textureMatrix.multiply(cam.matrixWorldInverse);

    // oblique near plane = the water plane, so nothing under the water renders into the reflection
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.pos);
    this.plane.applyMatrix4(cam.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = cam.projectionMatrix;
    const e = pm.elements;
    this.q.x = (Math.sign(this.clip.x) + e[8]) / e[0];
    this.q.y = (Math.sign(this.clip.y) + e[9]) / e[5];
    this.q.z = -1.0;
    this.q.w = (1.0 + e[10]) / e[14];
    this.clip.multiplyScalar(2.0 / this.clip.dot(this.q));
    e[2] = this.clip.x;
    e[6] = this.clip.y;
    e[10] = this.clip.z + 1.0 - 0.02;
    e[14] = this.clip.w;
    cam.projectionMatrixInverse.copy(pm).invert();

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.shadowMap.autoUpdate;
    const prevXr = renderer.xr.enabled;
    const prevAutoClear = renderer.autoClear;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevAuto;
    renderer.xr.enabled = prevXr;
    renderer.autoClear = prevAutoClear;
    return true;
  }

  dispose(): void {
    this.target.dispose();
  }
}
