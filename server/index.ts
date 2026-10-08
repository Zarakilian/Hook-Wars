// Production entry: serves the built client and the game websocket on one port.
//   npm run build && npm start
// See server/config.ts for environment variables (HOST, PORT, ...).
import { createServer } from 'node:http';
import { GAME_VERSION } from '../shared/constants.ts';
import { loadConfig } from './config.ts';
import { GameServer } from './gameServer.ts';
import { createStaticHandler } from './static.ts';

const cfg = loadConfig();
const handler = createStaticHandler(cfg.staticDir);
const http = createServer(handler);
http.headersTimeout = 15_000;
http.requestTimeout = 30_000;
http.keepAliveTimeout = 5_000;

const game = new GameServer(cfg);
game.attach(http);

http.listen(cfg.port, cfg.host, () => {
  console.log(`Hook Wars ${GAME_VERSION} listening on http://${cfg.host}:${cfg.port}`);
  if (cfg.host === '127.0.0.1') console.log('Only this machine can connect. Set HOST=0.0.0.0 to let other players in.');
});

function shutdown(): void {
  console.log('Shutting down...');
  game.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
