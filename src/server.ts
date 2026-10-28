import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { Store } from './db.js';
import { readConfig } from './config.js';
const directory = path.dirname(fileURLToPath(import.meta.url));
const built = path.basename(directory) === 'dist';
const config = readConfig();
const store = new Store(config.dbFile);
store.migrate(path.join(directory, built ? 'migrations' : '../migrations'));
const app = createApp(store, config, path.join(directory, built ? 'public' : '../dist/public'));
const server = app.listen(config.port, config.host, () => { const address = server.address(); console.log(JSON.stringify({ event: 'ready', host: config.host, port: typeof address === 'object' && address ? address.port : config.port, origin: config.origin })); });
server.requestTimeout = 30000; server.headersTimeout = 15000;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return; stopping = true;
  server.close(() => { app.locals.demoStore?.close(); store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
});
