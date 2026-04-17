import path from 'node:path';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 5050,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  dataDir: '.naow',
  corsOrigin: '*',
  ollamaTimeoutMs: 5000
};

function parsePort(value) {
  if (!value) return DEFAULTS.port;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function parseTimeout(value) {
  if (!value) return DEFAULTS.ollamaTimeoutMs;
  const timeout = Number.parseInt(value, 10);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error(`Invalid NAOW_OLLAMA_TIMEOUT_MS: ${value}`);
  }
  return timeout;
}

function normalizeBaseUrl(value) {
  const url = value || DEFAULTS.ollamaBaseUrl;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const dataDir = env.NAOW_DATA_DIR || DEFAULTS.dataDir;
  const dbPath = env.NAOW_DB_PATH || path.join(cwd, dataDir, 'naow.sqlite');

  return {
    name: 'naow',
    version: '0.1.0',
    host: env.HOST || DEFAULTS.host,
    port: parsePort(env.PORT),
    ollamaBaseUrl: normalizeBaseUrl(env.OLLAMA_BASE_URL),
    dataDir: path.resolve(cwd, dataDir),
    dbPath: dbPath === ':memory:' ? dbPath : path.resolve(cwd, dbPath),
    defaultModel: env.NAOW_DEFAULT_MODEL || null,
    corsOrigin: env.NAOW_CORS_ORIGIN || DEFAULTS.corsOrigin,
    ollamaTimeoutMs: parseTimeout(env.NAOW_OLLAMA_TIMEOUT_MS)
  };
}
