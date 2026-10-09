// Stands in for `node:sqlite` inside the desktop server bundle (desktop/scripts/build.ts aliases it).
// server/economy/store.ts imports node:sqlite at the top, so a runtime without it (an Electron build
// whose Node lacks the module) could not even load the bundle. Here the real module is looked up at
// run time: present, it is used as is; missing, opening a database throws, which the economy turns
// into "no accounts" (the desktop server runs ECONOMY=trust and never opens one anyway).
type Sqlite = typeof import('node:sqlite');

const real = (process.getBuiltinModule?.('node:sqlite') ?? null) as Sqlite | null;

class SqliteMissing {
  constructor() {
    throw new Error('node:sqlite is not available in this runtime');
  }
}

export const DatabaseSync = (real?.DatabaseSync ?? SqliteMissing) as Sqlite['DatabaseSync'];
export const StatementSync = (real?.StatementSync ?? SqliteMissing) as Sqlite['StatementSync'];
