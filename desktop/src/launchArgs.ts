// Command-line and environment switches of the desktop app.
//   +connect_lobby <id>      Steam starts the game this way for "Join game" or an accepted invite
//   --fake-steam             use the stand-in (also HOOKWARS_FAKE_STEAM=1)
//   --instance=<1-9>         a second (third...) window on one PC with the stand-in: its own profile folder
//   --fake-name=<name>       the stand-in's player name (also HOOKWARS_FAKE_NAME)
import { isSteamId64 } from './constants.ts';

export interface LaunchArgs {
  joinLobby: string | null;
  fake: boolean;
  instance: number | null;
  fakeName: string | null;
}

export function parseLaunchArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): LaunchArgs {
  let joinLobby: string | null = null;
  let fake = env.HOOKWARS_FAKE_STEAM === '1';
  let instance: number | null = null;
  let fakeName: string | null = cleanName(env.HOOKWARS_FAKE_NAME);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '+connect_lobby') {
      const id = argv[i + 1];
      if (isSteamId64(id)) joinLobby = id;
      i++;
    } else if (a.startsWith('+connect_lobby=')) {
      const id = a.slice('+connect_lobby='.length);
      if (isSteamId64(id)) joinLobby = id;
    } else if (a === '--fake-steam') {
      fake = true;
    } else if (a.startsWith('--instance=')) {
      const n = Number(a.slice('--instance='.length));
      if (Number.isInteger(n) && n >= 1 && n <= 9) instance = n;
    } else if (a.startsWith('--fake-name=')) {
      fakeName = cleanName(a.slice('--fake-name='.length));
    }
  }
  return { joinLobby, fake, instance, fakeName };
}

function cleanName(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 32);
  return s || null;
}

/** The Steam app id to start with: HOOKWARS_STEAM_APP_ID, else the steam_appid.txt next to the app, else none (Steam decides). */
export function chooseAppId(env: Record<string, string | undefined>, steamAppIdTxt: string | null): number | undefined {
  const fromEnv = Number(env.HOOKWARS_STEAM_APP_ID);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 2 ** 32) return fromEnv;
  const fromFile = Number((steamAppIdTxt ?? '').trim());
  if (Number.isInteger(fromFile) && fromFile > 0 && fromFile < 2 ** 32) return fromFile;
  return undefined;
}
