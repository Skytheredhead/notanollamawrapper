import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { LocalDatabase } from './db.js';
import { GenerationManager } from './generation-manager.js';
import { OllamaClient } from './ollama.js';

const config = loadConfig();
const db = new LocalDatabase(config.dbPath);
const generationManager = new GenerationManager();
const ollama = new OllamaClient({
  baseUrl: config.ollamaBaseUrl,
  timeoutMs: config.ollamaTimeoutMs
});

const app = buildApp({
  config,
  db,
  ollama,
  generationManager
});

async function shutdown(signal) {
  generationManager.stopAll('server_shutdown');
  await app.close();
  db.close();
  console.log(`naow backend stopped by ${signal}`);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').finally(() => process.exit(0));
});

try {
  await app.listen({
    host: config.host,
    port: config.port
  });
  console.log(`naow backend listening on http://${config.host}:${config.port}`);
  console.log(`SQLite database: ${config.dbPath}`);
  console.log(`Ollama URL: ${config.ollamaBaseUrl}`);
} catch (error) {
  console.error(error);
  db.close();
  process.exit(1);
}
