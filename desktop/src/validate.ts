// Checks for every argument the page sends the main process over IPC. The page is our own code, but
// it renders player-supplied text and talks to servers on the internet, so main never trusts it:
// each IPC handler runs its arguments through one of these first and refuses anything else.
import { APP_ORIGIN, MAX_LOBBY_MEMBERS, MIN_LOBBY_MEMBERS, RESERVED_LOBBY_KEYS, isSteamId64 } from './constants.ts';

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const bad = <T>(error: string): Checked<T> => ({ ok: false, error });
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export const MAX_LOBBY_NAME = 40;
export const MAX_INFO_KEYS = 16;
export const MAX_INFO_VALUE = 128;
export const MAX_CLOUD_BYTES = 1024 * 1024;
export const MAX_URL_LENGTH = 2048;
/** Pages the Steam overlay may open: Steam's own store and community sites. */
export const OVERLAY_HOSTS = ['store.steampowered.com', 'steamcommunity.com', 'help.steampowered.com', 'partner.steamgames.com'];

export function lobbyId(v: unknown): Checked<string> {
  return isSteamId64(v) ? ok(v) : bad('lobby id must be a 64-bit number as a decimal string');
}

export interface HostOpts {
  name: string;
  maxMembers: number;
  isPrivate: boolean;
}

export function hostOpts(v: unknown): Checked<HostOpts> {
  if (!isPlainObject(v)) return bad('options must be an object');
  const keys = Object.keys(v);
  if (keys.some((k) => k !== 'name' && k !== 'maxMembers' && k !== 'isPrivate')) return bad('unknown option');
  if (typeof v.name !== 'string' || v.name.length > 200) return bad('name must be a short string');
  const name = v.name.replace(CONTROL, '').replace(/[<>]/g, '').trim().slice(0, MAX_LOBBY_NAME);
  if (!name) return bad('name is empty');
  if (!Number.isInteger(v.maxMembers) || (v.maxMembers as number) < MIN_LOBBY_MEMBERS || (v.maxMembers as number) > MAX_LOBBY_MEMBERS) {
    return bad(`maxMembers must be a whole number from ${MIN_LOBBY_MEMBERS} to ${MAX_LOBBY_MEMBERS}`);
  }
  if (typeof v.isPrivate !== 'boolean') return bad('isPrivate must be true or false');
  return ok({ name, maxMembers: v.maxMembers as number, isPrivate: v.isPrivate });
}

/** Lobby metadata from the page: short lowercase keys, short printable values, reserved keys refused. */
export function lobbyInfo(v: unknown): Checked<Record<string, string>> {
  if (!isPlainObject(v)) return bad('info must be an object');
  const keys = Object.keys(v);
  if (keys.length > MAX_INFO_KEYS) return bad(`at most ${MAX_INFO_KEYS} keys`);
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(k)) return bad(`bad key ${JSON.stringify(k.slice(0, 40))}`);
    if (RESERVED_LOBBY_KEYS.includes(k)) return bad(`key ${k} is set by the app`);
    const val = v[k];
    if (typeof val !== 'string' || val.length > MAX_INFO_VALUE) return bad(`value of ${k} must be a string of at most ${MAX_INFO_VALUE} characters`);
    out[k] = val.replace(CONTROL, '');
  }
  return ok(out);
}

/** A Steam Cloud file name: a plain name, no folders, no leading dot. */
export function cloudName(v: unknown): Checked<string> {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v) && !v.includes('..') ? ok(v) : bad('bad file name');
}

export function cloudData(v: unknown): Checked<string> {
  if (typeof v !== 'string') return bad('data must be a string');
  if (Buffer.byteLength(v, 'utf8') > MAX_CLOUD_BYTES) return bad('data is too big');
  return ok(v);
}

/** An https page on one of Steam's own sites. */
export function overlayUrl(v: unknown): Checked<string> {
  if (typeof v !== 'string' || v.length > MAX_URL_LENGTH) return bad('bad url');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad('bad url');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return bad('only https pages on Steam sites');
  if (!OVERLAY_HOSTS.includes(u.hostname.toLowerCase())) return bad('only https pages on Steam sites');
  return ok(u.toString());
}

export function flag(v: unknown): Checked<boolean> {
  return typeof v === 'boolean' ? ok(v) : bad('must be true or false');
}

/** Only the app's own page (top frame, app://hookwars/...) may use the bridge. */
export function isTrustedSender(frameUrl: string | null | undefined): boolean {
  if (typeof frameUrl !== 'string') return false;
  try {
    const u = new URL(frameUrl);
    return `${u.protocol}//${u.host}` === APP_ORIGIN;
  } catch {
    return false;
  }
}
