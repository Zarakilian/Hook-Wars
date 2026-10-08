// Entry point the game server calls. The economy pass replaces this with the real service.
import type { ServerConfig } from '../config.ts';
import { createNullEconomy, type ServerEconomy } from './api.ts';

export function createServerEconomy(_cfg: ServerConfig): ServerEconomy {
  return createNullEconomy();
}

export type { ServerEconomy };
