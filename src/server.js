import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { LocalDatabase } from './db.js';
import { GenerationManager } from './generation-manager.js';
import { IdleResourceGuard } from './idle-resource-guard.js';
import { HybridModelClient, MlxClient, MlxSidecar } from './mlx.js';
import { OllamaClient } from './ollama.js';
import { SearxngSidecar } from './search-sidecar.js';
import { WebSearchClient } from './web-search.js';
import { PreSearchManager } from './presearch-manager.js';
import { SourceSummaryCache } from './source-summaries.js';
import { DeepResearchManager } from './deep-research-manager.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger({ filePath: `${config.dataDir}/logs/backend.log` });
const db = new LocalDatabase(config.dbPath);
const generationManager = new GenerationManager();
const mlxPort = new URL(config.mlxBaseUrl).port || '5055';
const mlxSidecar = new MlxSidecar({
  python: config.mlxPython,
  cwd: process.cwd(),
  port: Number.parseInt(mlxPort, 10),
  autostart: config.mlxAutostart,
  home: config.dataDir,
  logger
});
mlxSidecar.start();
const mlx = new MlxClient({
  baseUrl: config.mlxBaseUrl,
  timeoutMs: config.ollamaTimeoutMs,
  modelName: config.mlxModel,
  residency: config.mlxResidency
});
const ollama = new OllamaClient({
  baseUrl: config.ollamaBaseUrl,
  timeoutMs: config.ollamaTimeoutMs,
  apiKey: config.ollamaApiKey,
  webSearchUrl: config.ollamaWebSearchUrl
});
const modelClient = new HybridModelClient({ mlx, ollama });
const searchSidecar = new SearxngSidecar({
  home: config.searchHome,
  url: config.searchUrl,
  settingsPath: config.searchSettingsPath,
  settingsTemplatePath: config.searchSettingsTemplatePath,
  setupScript: config.searchSetupScript,
  python: config.searchPython,
  managed: config.searchManaged,
  timeoutMs: Math.min(config.searchTimeoutMs, 1500),
  setupTimeoutMs: config.searchSetupTimeoutMs
});
searchSidecar.setLogger?.(logger);
const searchClient = new WebSearchClient({
  config,
  sidecar: searchSidecar
});
const preSearchManager = new PreSearchManager({
  config,
  searchClient,
  modelClient
});
const sourceSummaryCache = new SourceSummaryCache({
  config,
  modelClient
});

const deepResearchManager = new DeepResearchManager();

// Expose sidecars to routes so the UI can (re)start them.

const app = buildApp({
  config,
  db,
  ollama: modelClient,
  generationManager,
  mlxSidecar,
  searchClient,
  preSearchManager,
  sourceSummaryCache,
  deepResearchManager
});
const idleGuard = new IdleResourceGuard({
  config,
  generationManager,
  modelClient,
  searchClient,
  db
});

async function shutdown(signal) {
  idleGuard.stop();
  generationManager.stopAll('server_shutdown');
  deepResearchManager?.stopAll?.('server_shutdown');
  await app.close();
  mlxSidecar.stop();
  await searchSidecar.stop();
  db.close();
  console.log(`naow backend stopped by ${signal}`);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').finally(() => process.exit(0));
});

process.on('uncaughtException', (error) => {
  logger.error('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', reason);
});

try {
  await app.listen({
    host: config.host,
    port: config.port
  });
  idleGuard.start();
  logger.info(`naow backend listening on http://${config.host}:${config.port}`);
  logger.info(`SQLite database: ${config.dbPath}`);
  logger.info(`MLX URL: ${config.mlxBaseUrl}`);
  logger.info(`Ollama fallback URL: ${config.ollamaBaseUrl}`);
  logger.info(`Local search URL: ${config.searchUrl}`);
  logger.info(`Local search home: ${config.searchHome}`);
  searchClient.warmup().catch((error) => {
    logger.warn('Local search warmup skipped:', error);
  });
} catch (error) {
  logger.error('startup_failed', error);
  idleGuard.stop();
  mlxSidecar.stop();
  db.close();
  process.exit(1);
}
