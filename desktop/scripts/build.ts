// Builds the Steam desktop app into desktop/build (uses vite from the project root's node_modules):
//   build/client/      the game client: vite build of the root project, base './' for app://hookwars
//   build/server.mjs   server/index.ts bundled to one ESM file (vite SSR build, ws included)
//   build/main.cjs     the Electron main process (src/main.ts); electron and steamworks.js stay external
//   build/preload.cjs  the preload (src/preload.ts): one CommonJS file whose only require is 'electron'
//
//   node desktop/scripts/build.ts              everything
//   node desktop/scripts/build.ts --server     only the server bundle (also: npm run desktop:bundle)
//   node desktop/scripts/build.ts --electron   only main and preload
//   node desktop/scripts/build.ts --client     only the client
//   --out <dir>                                write somewhere else than desktop/build (tests)
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig } from 'vite';

export const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const rootDir = resolve(desktopDir, '..');

/** Packages a bundle may require at run time without having them (ws loads them in a try/catch). */
const OPTIONAL = ['bufferutil', 'utf-8-validate'];

function nodeBundle(entry: string, outDir: string, file: string, format: 'esm' | 'cjs', external: string[], extra: InlineConfig = {}): InlineConfig {
  return {
    configFile: false,
    root: rootDir,
    logLevel: 'warn',
    mode: 'production',
    publicDir: false,
    ...extra,
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      rolldownOptions: {
        external: [...external, ...OPTIONAL],
        output: { entryFileNames: file, format },
      },
    },
    ssr: { noExternal: true, target: 'node' },
  };
}

/** server/index.ts as one ESM file. node:sqlite goes through a run-time lookup (src/server-shims/sqlite.ts). */
export async function buildServer(outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  await build(
    nodeBundle(join(rootDir, 'server/index.ts'), outDir, 'server.mjs', 'esm', [], {
      resolve: { alias: [{ find: /^node:sqlite$/, replacement: join(desktopDir, 'src/server-shims/sqlite.ts') }] },
    }),
  );
  return join(outDir, 'server.mjs');
}

export async function buildElectron(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await build(nodeBundle(join(desktopDir, 'src/main.ts'), outDir, 'main.cjs', 'cjs', ['electron', 'steamworks.js']));
  await build(nodeBundle(join(desktopDir, 'src/preload.ts'), outDir, 'preload.cjs', 'cjs', ['electron']));
}

export async function buildClient(outDir: string): Promise<void> {
  const clientOut = join(outDir, 'client');
  rmSync(clientOut, { recursive: true, force: true });
  await build({
    root: rootDir,
    configFile: join(rootDir, 'vite.config.ts'),
    logLevel: 'warn',
    mode: 'production',
    base: './', // relative asset paths: app://hookwars/index.html loads ./assets/...
    build: { outDir: clientOut, emptyOutDir: true, chunkSizeWarningLimit: 4000 }, // one 2 MB chunk is fine from disk
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 && argv[outIdx + 1] ? resolve(argv[outIdx + 1]) : join(desktopDir, 'build');
  const only = new Set(argv.filter((a) => a === '--server' || a === '--electron' || a === '--client'));
  const all = only.size === 0;
  const t0 = Date.now();
  if (all || only.has('--server')) {
    console.log(`server bundle -> ${await buildServer(outDir)}`);
  }
  if (all || only.has('--electron')) {
    await buildElectron(outDir);
    console.log(`main and preload -> ${join(outDir, 'main.cjs')}, ${join(outDir, 'preload.cjs')}`);
  }
  if (all || only.has('--client')) {
    await buildClient(outDir);
    console.log(`client -> ${join(outDir, 'client')}`);
  }
  console.log(`desktop build done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
