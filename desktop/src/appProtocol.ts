// The app:// protocol: maps app://hookwars/<path> to a file in the built client (desktop/build/client)
// and the headers it is served with. Pure functions; main.ts registers them with Electron.
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { APP_HOST } from './constants.ts';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The page's Content-Security-Policy: only the app's own files, no remote scripts, styles or images.
 * connect-src keeps ws: and wss: because the Online screen connects to any dedicated server address a
 * player types, and Steam lobbies connect to 127.0.0.1 (the local server or the local relay).
 */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function appHeaders(mime: string): Record<string, string> {
  return {
    'Content-Type': mime,
    'Content-Security-Policy': APP_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()',
    'Cache-Control': 'no-cache',
  };
}

export type AppRequest = { ok: true; file: string; mime: string } | { ok: false; status: 400 | 403 | 404 };

/** Resolve an app:// URL to a file under root, or the status to answer with. Never leaves root. */
export function resolveAppRequest(rawUrl: string, root: string): AppRequest {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400 };
  }
  if (u.protocol !== 'app:' || u.host !== APP_HOST) return { ok: false, status: 403 };
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return { ok: false, status: 400 };
  }
  if (path.includes('\0') || path.includes('\\')) return { ok: false, status: 400 };
  if (path === '/' || path === '') path = '/index.html';
  // no hidden files or folders (.git, .env) and no parent references
  const parts = path.split('/').filter(Boolean);
  if (parts.some((p) => p.startsWith('.'))) return { ok: false, status: 404 };
  const base = resolve(root);
  const file = normalize(join(base, ...parts));
  const rel = relative(base, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return { ok: false, status: 403 };
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime) return { ok: false, status: 404 };
  return { ok: true, file, mime };
}
