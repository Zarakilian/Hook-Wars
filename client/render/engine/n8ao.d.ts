// Minimal typings for n8ao 2.0.1 (the package ships plain JS). Only what the engine uses.
declare module 'n8ao' {
  import type { Camera, Color, Scene, Texture } from 'three';
  import { Pass } from 'postprocessing';

  export interface N8AOConfiguration {
    aoSamples: number;
    aoRadius: number;
    aoTones: number;
    denoiseSamples: number;
    denoiseRadius: number;
    distanceFalloff: number;
    intensity: number;
    denoiseIterations: number;
    renderMode: 0 | 1 | 2 | 3 | 4;
    biasOffset: number;
    biasMultiplier: number;
    color: Color;
    gammaCorrection: boolean;
    screenSpaceRadius: boolean;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    colorMultiply: boolean;
    transparencyAware: boolean;
    accumulate: boolean;
    neuralDenoise: boolean;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    autoDetectTransparency: boolean;
    autosetGamma: boolean;
    lastTime: number;
    setDepthTexture(depthTexture: Texture): void;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
    setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
    enableDebugMode(): void;
    disableDebugMode(): void;
  }
}
