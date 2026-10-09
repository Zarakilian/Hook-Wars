// Minimal, safe static file server for the built client (dist/). No directory listing,
// no path traversal, strict security headers.
//
// Compression: text files (the 2 MB main bundle, CSS, HTML, SVG, JSON) are sent brotli or gzip
// encoded, about 3.5x smaller. They are compressed once, in the background on the thread pool
// (this process also runs the 30 Hz game loop, so nothing is compressed on the request path), and
// kept in memory keyed by size and mtime, so a rebuild is picked up. Until a file is ready it goes
// out as is. Hashed files under assets/ are cached for a year; index.html is revalidated (ETag).
import { createReadStream, readdirSync, statSync, type Dirent, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';

const MIME: Record<string, string> = {
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

/** Worth compressing. Images and woff/woff2 fonts are compressed already. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.wasm', '.ttf']);
/** Below this a compressed copy saves less than the headers it needs. */
const MIN_COMPRESS_BYTES = 1024;
const MAX_COMPRESS_BYTES = 32 * 1024 * 1024;
/** Memory for compressed copies, all files together. */
const MAX_CACHE_BYTES = 96 * 1024 * 1024;

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export type Encoding = 'br' | 'gzip';

/** Encodings the client accepts, best first (q-values honoured, br preferred on a tie). */
export function acceptedEncodings(header: string | string[] | undefined): Encoding[] {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  let br = -1;
  let gz = -1;
  let star = -1;
  for (const part of raw.split(',')) {
    const [first, ...params] = part.toLowerCase().split(';');
    const name = first.trim();
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q) || q < 0) q = 0;
    if (name === 'br') br = q;
    else if (name === 'gzip' || name === 'x-gzip') gz = q;
    else if (name === '*') star = q;
  }
  if (br < 0) br = Math.max(0, star);
  if (gz < 0) gz = Math.max(0, star);
  const out: Encoding[] = [];
  if (br > 0 && br >= gz) out.push('br');
  if (gz > 0) out.push('gzip');
  if (br > 0 && br < gz) out.push('br');
  return out;
}

/** The best encoding the client accepts, or null for none. */
export function pickEncoding(header: string | string[] | undefined): Encoding | null {
  return acceptedEncodings(header)[0] ?? null;
}

interface Packed {
  size: number;
  mtimeMs: number;
  gz: Buffer | null;
  br: Buffer | null;
}

export interface CompressionStats {
  files: number;
  rawBytes: number;
  gzipBytes: number;
  brotliBytes: number;
}

export type StaticHandler = ((req: IncomingMessage, res: ServerResponse) => void) & {
  /** settles once every compressible file found at start-up has its gzip and brotli copies */
  ready: Promise<CompressionStats>;
};

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

function etagOf(st: Stats): string {
  return `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
}

function listFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export function createStaticHandler(dir: string): StaticHandler {
  const root = resolve(dir);
  const indexFile = join(root, 'index.html');
  const hasIndex = (): boolean => {
    try {
      return statSync(indexFile).isFile();
    } catch {
      return false;
    }
  };
  let has = hasIndex();

  // ---- compressed copies --------------------------------------------------------------------
  const cache = new Map<string, Packed>();
  let cacheBytes = 0;
  const pending = new Set<string>();
  /** one file at a time: brotli 11 on the 2 MB bundle takes seconds of one pool thread */
  let chain: Promise<void> = Promise.resolve();

  const compressible = (file: string, size: number) =>
    COMPRESSIBLE.has(extname(file).toLowerCase()) && size >= MIN_COMPRESS_BYTES && size <= MAX_COMPRESS_BYTES;

  const store = (file: string, p: Packed) => {
    const old = cache.get(file);
    const bytes = (x: Packed | undefined) => (x ? (x.gz?.length ?? 0) + (x.br?.length ?? 0) : 0);
    if (cacheBytes - bytes(old) + bytes(p) > MAX_CACHE_BYTES) return false;
    cacheBytes += bytes(p) - bytes(old);
    cache.set(file, p);
    return true;
  };

  /** Queue gzip (fast) then brotli (slow) for one file; stale copies are replaced, never served. */
  const compress = (file: string, st: Stats, stats?: CompressionStats): Promise<void> => {
    if (pending.has(file)) return chain;
    pending.add(file);
    const job = async () => {
      try {
        const data = await readFile(file);
        // the file changed between stat and read (a rebuild in progress): try again on a later request
        if (data.length !== st.size) return;
        const gz = await gzipAsync(data, { level: 9 });
        if (!store(file, { size: st.size, mtimeMs: st.mtimeMs, gz, br: null })) return;
        const br = await brotliAsync(data, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        });
        store(file, { size: st.size, mtimeMs: st.mtimeMs, gz, br });
        if (stats) {
          stats.files++;
          stats.rawBytes += data.length;
          stats.gzipBytes += gz.length;
          stats.brotliBytes += br.length;
        }
      } catch {
        // unreadable or vanished: served uncompressed
      } finally {
        pending.delete(file);
      }
    };
    chain = chain.then(job);
    return chain;
  };

  const startup: CompressionStats = { files: 0, rawBytes: 0, gzipBytes: 0, brotliBytes: 0 };
  for (const file of listFiles(root)) {
    try {
      const st = statSync(file);
      if (compressible(file, st.size)) void compress(file, st, startup);
    } catch {
      // gone already
    }
  }
  const ready = chain.then(() => startup);

  /**
   * The best compressed copy of this exact file version the client takes, if one is ready (queues one
   * if not). standIn: a copy the client prefers is still being made, so what goes out now (the raw
   * file, or gzip while brotli runs) must not be cached: a shared cache would keep it for a year.
   */
  const packedFor = (file: string, st: Stats, accepted: Encoding[]): { enc: Encoding | null; body: Buffer | null; standIn: boolean } => {
    if (accepted.length === 0 || !compressible(file, st.size)) return { enc: null, body: null, standIn: false };
    const p = cache.get(file);
    if (!p || p.size !== st.size || p.mtimeMs !== st.mtimeMs) {
      void compress(file, st);
      return { enc: null, body: null, standIn: true };
    }
    for (const enc of accepted) {
      const body = enc === 'br' ? p.br : p.gz;
      // brotli may still be on its way while gzip is ready
      if (body) return { enc, body, standIn: enc !== accepted[0] && pending.has(file) };
    }
    return { enc: null, body: null, standIn: pending.has(file) };
  };

  // ---- requests -----------------------------------------------------------------------------
  const handle = function handle(req: IncomingMessage, res: ServerResponse): void {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (!has) has = hasIndex(); // built after the server started
    if (!has) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Client not built yet. Run: npm run build');
      return;
    }
    if (pathname.includes('\0')) {
      res.writeHead(400).end();
      return;
    }
    let file = normalize(join(root, pathname));
    if (!file.startsWith(root + sep) && file !== root) {
      res.writeHead(403).end();
      return;
    }
    let st: Stats | null = null;
    try {
      st = statSync(file);
      if (!st.isFile()) st = null;
    } catch {
      st = null;
    }
    if (!st) {
      // A hashed asset that is not there (a page from before a rebuild): a 404, never index.html
      // served as script, and never cached.
      if (pathname.startsWith('/assets/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Not found');
        return;
      }
      file = indexFile; // client-side routes
      try {
        st = statSync(file);
      } catch {
        res.writeHead(503).end();
        return;
      }
    }
    const ext = extname(file).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    const immutable = file.startsWith(join(root, 'assets') + sep);
    const headers: Record<string, string | number> = {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etagOf(st),
    };
    // caches must key compressible responses by Accept-Encoding, compressed or not
    if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === headers.ETag || t.trim() === '*')) {
      res.writeHead(304, headers).end();
      return;
    }
    const packed = packedFor(file, st, acceptedEncodings(req.headers['accept-encoding']));
    if (packed.standIn) headers['Cache-Control'] = 'no-store';
    if (packed.enc && packed.body) {
      headers['Content-Encoding'] = packed.enc;
      headers['Content-Length'] = packed.body.length;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else res.end(packed.body);
      return;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD' || st.size === 0) {
      res.end();
      return;
    }
    // Exactly the bytes the Content-Length promised: a file rewritten since the stat (a rebuild while
    // the server runs) must not send extra bytes, which would poison the keep-alive connection, nor
    // leave the client waiting for bytes that never come (a shorter file: the response is cut off).
    const stream = createReadStream(file, { start: 0, end: st.size - 1 });
    let sent = 0;
    stream.on('data', (d) => (sent += d.length));
    stream.on('error', () => res.destroy());
    stream.on('end', () => {
      if (sent < st.size) res.destroy();
    });
    stream.pipe(res);
  } as StaticHandler;
  handle.ready = ready;
  return handle;
}
