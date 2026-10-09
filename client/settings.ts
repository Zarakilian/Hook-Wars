// Player profile and settings, persisted in localStorage (best effort: private windows may block it).
import type { Profile } from '../shared/protocol.ts';
import { DEFAULT_LOADOUT } from '../shared/cosmetics.ts';
import { FAMILIES, type ControlScheme, type FamilyId, type MatchConfig } from '../shared/types.ts';
import { DEFAULT_CONFIG, MAX_NAME_LEN } from '../shared/constants.ts';
import { parseConfig, parseProfile } from '../shared/protocol.ts';
import type { Quality } from './render/contracts.ts';

export interface Settings {
  controls: ControlScheme;
  quality: Quality | 'auto';
  master: number; // 0..1
  sfx: number;
  music: number;
  shake: number; // 0..1 camera shake strength
  showFps: boolean;
  showRange: boolean; // hook range ring
  serverUrl: string; // last online server as typed ('' = the default server: in the browser, the host that served the page)
  soloConfig: MatchConfig;
  soloTeam: 0 | 1;
}

const KEY_PROFILE = 'hookwars.profile.v1';
const KEY_SETTINGS = 'hookwars.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  controls: 'modern',
  quality: 'auto',
  master: 0.8,
  sfx: 0.9,
  music: 0.55,
  shake: 1,
  showFps: false,
  showRange: true,
  serverUrl: '',
  soloConfig: { ...DEFAULT_CONFIG, killsToWin: 20 },
  soloTeam: 0,
};

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: settings last for this session only
  }
}

const FUNNY = ['Gutbucket', 'Chumlord', 'Reelmaster', 'Bilgerat', 'Hookwright', 'Mudlark', 'Gristleface', 'Snagtooth'];

export function loadProfile(): Profile {
  const p = parseProfile(read(KEY_PROFILE));
  if (p) return p;
  const family: FamilyId = FAMILIES[Math.floor(Math.random() * FAMILIES.length)];
  const name = `${FUNNY[Math.floor(Math.random() * FUNNY.length)]}${Math.floor(Math.random() * 90 + 10)}`.slice(0, MAX_NAME_LEN);
  const fresh: Profile = { name, family, loadout: { ...DEFAULT_LOADOUT[family] } };
  write(KEY_PROFILE, fresh);
  return fresh;
}

export function saveProfile(p: Profile): void {
  write(KEY_PROFILE, p);
}

export function loadSettings(): Settings {
  const raw = read(KEY_SETTINGS) as Partial<Settings> | null;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS, soloConfig: { ...DEFAULT_SETTINGS.soloConfig } };
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
  return {
    controls: raw.controls === 'classic' ? 'classic' : 'modern',
    quality: (['low', 'medium', 'high', 'ultra', 'auto'] as const).includes(raw.quality as Quality) ? (raw.quality as Quality | 'auto') : 'auto',
    master: num(raw.master, DEFAULT_SETTINGS.master),
    sfx: num(raw.sfx, DEFAULT_SETTINGS.sfx),
    music: num(raw.music, DEFAULT_SETTINGS.music),
    shake: num(raw.shake, DEFAULT_SETTINGS.shake),
    showFps: raw.showFps === true,
    showRange: raw.showRange !== false,
    serverUrl: typeof raw.serverUrl === 'string' ? raw.serverUrl.slice(0, 200) : '',
    soloConfig: parseConfig(raw.soloConfig) ?? { ...DEFAULT_SETTINGS.soloConfig },
    soloTeam: raw.soloTeam === 1 ? 1 : 0,
  };
}

export function saveSettings(s: Settings): void {
  write(KEY_SETTINGS, s);
}

/** Pick a quality tier from a quick hardware guess. */
export function autoQuality(): Quality {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (mobile) return 'low';
  const gpu = gpuName();
  // Measured 2026-10-08 on Intel UHD (0x9A60) at 1280x720: low 8.8 ms, medium 11 ms, high 14 ms, ultra 21 ms.
  if (/swiftshader|llvmpipe|software|basic render/i.test(gpu)) return 'low';
  const integrated = /intel|iris|uhd|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|mali|adreno|powervr/i.test(gpu);
  if (integrated) return cores >= 6 ? 'medium' : 'low';
  if (/nvidia|geforce|rtx|gtx|radeon rx|radeon pro|apple m\d/i.test(gpu)) return cores >= 6 ? 'high' : 'medium';
  if (cores >= 6) return 'medium';
  return 'low';
}

/** The WebGL renderer string, from a throwaway context (empty string if unavailable). */
function gpuName(): string {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}
