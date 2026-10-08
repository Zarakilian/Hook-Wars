// Dev: `npm run dev` serves the client with hot reload AND runs the game server on the same port (/ws).
// Prod: `npm run build` then `npm start` (server/index.ts serves dist/ and /ws).
import { defineConfig, type Plugin } from 'vite';
import type { Server } from 'node:http';
import { GameServer } from './server/gameServer.ts';
import { loadConfig } from './server/config.ts';

function hookWarsServer(): Plugin {
  let game: GameServer | null = null;
  return {
    name: 'hook-wars-game-server',
    configureServer(server) {
      if (!server.httpServer) return;
      game = new GameServer({ ...loadConfig(), allowedOrigins: [] });
      game.attach(server.httpServer as Server);
      server.httpServer.on('close', () => game?.close());
    },
    configurePreviewServer(server) {
      game = new GameServer({ ...loadConfig(), allowedOrigins: [] });
      game.attach(server.httpServer as Server);
    },
  };
}

export default defineConfig({
  plugins: [hookWarsServer()],
  server: {
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 5173),
    strictPort: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
});
