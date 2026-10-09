// Starts the desktop app with the Electron that `npm install` put in desktop/node_modules.
//   node scripts/start.ts                       real Steam (steam_appid.txt with 480 sits in desktop/)
//   node scripts/start.ts --fake                the stand-in instead of Steam (HOOKWARS_FAKE_STEAM=1)
//   node scripts/start.ts --fake --instance=2 --fake-name=Bob    a second window on the same PC
// The app's working folder is desktop/, so Steam finds steam_appid.txt there.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let electronPath: string;
try {
  electronPath = require('electron') as string; // the electron package exports the path of its binary
} catch {
  console.error('Electron is not installed. Run "npm install" inside the desktop folder first (see docs/steam-desktop.md).');
  process.exit(1);
}

const flags = process.argv.slice(2);
const env: Record<string, string | undefined> = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // would start Electron as plain Node
if (flags.includes('--fake')) env.HOOKWARS_FAKE_STEAM = '1';
const pass = flags.filter((f) => f.startsWith('--instance=') || f.startsWith('--fake-name='));

const child = spawn(electronPath, ['.', ...pass], { cwd: desktopDir, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(`Could not start Electron: ${err.message}`);
  process.exit(1);
});
