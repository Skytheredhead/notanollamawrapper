import path from 'node:path';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 5050,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaWebSearchUrl: 'https://ollama.com/api/web_search',
  mlxBaseUrl: 'http://127.0.0.1:5055',
  mlxModel: 'mlx-community/Qwen3.5-9B-MLX-4bit',
  mlxResidency: 'always_hot',
  dataDir: '.naow',
  corsOrigin: '*',
  ollamaTimeoutMs: 5000,
  webSearchMaxResults: 5,
  searchProvider: 'searxng',
  searchManaged: true,
  searchUrl: 'http://127.0.0.1:8088/search',
  searchMaxResults: 5,
  searchFetchPages: 5,
  searchTimeoutMs: 1800,
  searchPageTimeoutMs: 2500,
  searchQueryCacheMs: 10 * 60 * 1000,
  searchPageCacheMs: 30 * 60 * 1000,
  searchMaxPageBytes: 2 * 1024 * 1024,
  searchMaxPageChars: 6000,
  searchMaxContextChars: 12000,
  searchSetupTimeoutMs: 180000,
  toolsEnabled: true,
  toolTimeoutMs: 1800,
  toolMaxResultChars: 3000,
  idleCleanupEnabled: true,
  idleCleanupDelayMs: 2 * 60 * 1000,
  idleCleanupIntervalMs: 30 * 1000,
  idleUnloadModels: true,
  idleUnloadPinnedMlx: true,
  idleSearchStopMs: 10 * 60 * 1000,
  idleAttachmentTtlMs: 24 * 60 * 60 * 1000,
  idleCacheMaxEntries: 80,
  weatherProvider: 'open-meteo',
  weatherUnits: 'imperial',
  weatherGeocodeUrl: 'https://geocoding-api.open-meteo.com/v1/search',
  weatherForecastUrl: 'https://api.open-meteo.com/v1/forecast'
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

function parsePositiveInt(value, fallback, name) {
  if (!value) return fallback;
  const next = Number.parseInt(value, 10);
  if (!Number.isInteger(next) || next < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return next;
}

function parseNonNegativeInt(value, fallback, name) {
  if (!value) return fallback;
  const next = Number.parseInt(value, 10);
  if (!Number.isInteger(next) || next < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return next;
}

function parseWebSearchMaxResults(value) {
  if (!value) return DEFAULTS.webSearchMaxResults;
  const maxResults = Number.parseInt(value, 10);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    throw new Error(`Invalid NAOW_WEB_SEARCH_MAX_RESULTS: ${value}`);
  }
  return maxResults;
}

function normalizeBaseUrl(value) {
  const url = value || DEFAULTS.ollamaBaseUrl;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function normalizeUrl(value, fallback) {
  const url = value || fallback;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function parseBoolean(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseResidency(value) {
  const next = value || DEFAULTS.mlxResidency;
  if (!['always_hot', 'warm_idle', 'unload_after_reply'].includes(next)) {
    throw new Error(`Invalid NAOW_MLX_RESIDENCY: ${value}`);
  }
  return next;
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const dataDir = env.NAOW_DATA_DIR || DEFAULTS.dataDir;
  const dbPath = env.NAOW_DB_PATH || path.join(cwd, dataDir, 'naow.sqlite');
  const frontendDist = env.NAOW_FRONTEND_DIST || path.join(cwd, 'frontend', 'dist');
  const resolvedDataDir = path.resolve(cwd, dataDir);

  return {
    name: 'naow',
    version: '0.1.0',
    host: env.HOST || DEFAULTS.host,
    port: parsePort(env.PORT),
    ollamaBaseUrl: normalizeBaseUrl(env.OLLAMA_BASE_URL),
    dataDir: resolvedDataDir,
    dbPath: dbPath === ':memory:' ? dbPath : path.resolve(cwd, dbPath),
    attachmentsDir: path.resolve(resolvedDataDir, 'attachments'),
    frontendDist: path.resolve(cwd, frontendDist),
    defaultModel: env.NAOW_DEFAULT_MODEL || null,
    corsOrigin: env.NAOW_CORS_ORIGIN || DEFAULTS.corsOrigin,
    ollamaTimeoutMs: parseTimeout(env.NAOW_OLLAMA_TIMEOUT_MS),
    ollamaApiKey: env.OLLAMA_API_KEY || null,
    ollamaWebSearchUrl: env.OLLAMA_WEB_SEARCH_URL || DEFAULTS.ollamaWebSearchUrl,
    webSearchMaxResults: parseWebSearchMaxResults(env.NAOW_WEB_SEARCH_MAX_RESULTS),
    searchProvider: env.NAOW_SEARCH_PROVIDER || DEFAULTS.searchProvider,
    searchManaged: parseBoolean(env.NAOW_SEARCH_MANAGED, DEFAULTS.searchManaged),
    searchUrl: normalizeUrl(env.NAOW_SEARCH_URL, DEFAULTS.searchUrl),
    searchMaxResults: parsePositiveInt(env.NAOW_SEARCH_MAX_RESULTS || env.NAOW_WEB_SEARCH_MAX_RESULTS, DEFAULTS.searchMaxResults, 'NAOW_SEARCH_MAX_RESULTS'),
    searchFetchPages: parsePositiveInt(env.NAOW_SEARCH_FETCH_PAGES, DEFAULTS.searchFetchPages, 'NAOW_SEARCH_FETCH_PAGES'),
    searchTimeoutMs: parsePositiveInt(env.NAOW_SEARCH_TIMEOUT_MS, DEFAULTS.searchTimeoutMs, 'NAOW_SEARCH_TIMEOUT_MS'),
    searchPageTimeoutMs: parsePositiveInt(env.NAOW_SEARCH_PAGE_TIMEOUT_MS, DEFAULTS.searchPageTimeoutMs, 'NAOW_SEARCH_PAGE_TIMEOUT_MS'),
    searchQueryCacheMs: parsePositiveInt(env.NAOW_SEARCH_QUERY_CACHE_MS, DEFAULTS.searchQueryCacheMs, 'NAOW_SEARCH_QUERY_CACHE_MS'),
    searchPageCacheMs: parsePositiveInt(env.NAOW_SEARCH_PAGE_CACHE_MS, DEFAULTS.searchPageCacheMs, 'NAOW_SEARCH_PAGE_CACHE_MS'),
    searchMaxPageBytes: parsePositiveInt(env.NAOW_SEARCH_MAX_PAGE_BYTES, DEFAULTS.searchMaxPageBytes, 'NAOW_SEARCH_MAX_PAGE_BYTES'),
    searchMaxPageChars: parsePositiveInt(env.NAOW_SEARCH_MAX_PAGE_CHARS, DEFAULTS.searchMaxPageChars, 'NAOW_SEARCH_MAX_PAGE_CHARS'),
    searchMaxContextChars: parsePositiveInt(env.NAOW_SEARCH_MAX_CONTEXT_CHARS, DEFAULTS.searchMaxContextChars, 'NAOW_SEARCH_MAX_CONTEXT_CHARS'),
    searchHome: path.resolve(cwd, env.NAOW_SEARCH_HOME || path.join(dataDir, 'search')),
    searchSettingsPath: path.resolve(cwd, env.NAOW_SEARCH_SETTINGS_PATH || path.join(dataDir, 'search', 'settings.yml')),
    searchSettingsTemplatePath: path.resolve(cwd, env.NAOW_SEARCH_SETTINGS_TEMPLATE_PATH || path.join('search', 'searxng', 'settings.yml')),
    searchSetupScript: path.resolve(cwd, env.NAOW_SEARCH_SETUP_SCRIPT || path.join('scripts', 'setup_search.py')),
    searchPython: env.NAOW_SEARCH_PYTHON || env.PYTHON || 'python3',
    searchSetupTimeoutMs: parsePositiveInt(env.NAOW_SEARCH_SETUP_TIMEOUT_MS, DEFAULTS.searchSetupTimeoutMs, 'NAOW_SEARCH_SETUP_TIMEOUT_MS'),
    toolsEnabled: parseBoolean(env.NAOW_TOOLS_ENABLED, DEFAULTS.toolsEnabled),
    toolTimeoutMs: parsePositiveInt(env.NAOW_TOOL_TIMEOUT_MS, DEFAULTS.toolTimeoutMs, 'NAOW_TOOL_TIMEOUT_MS'),
    toolMaxResultChars: parsePositiveInt(env.NAOW_TOOL_MAX_RESULT_CHARS, DEFAULTS.toolMaxResultChars, 'NAOW_TOOL_MAX_RESULT_CHARS'),
    idleCleanupEnabled: parseBoolean(env.NAOW_IDLE_CLEANUP_ENABLED, DEFAULTS.idleCleanupEnabled),
    idleCleanupDelayMs: parsePositiveInt(env.NAOW_IDLE_CLEANUP_DELAY_MS, DEFAULTS.idleCleanupDelayMs, 'NAOW_IDLE_CLEANUP_DELAY_MS'),
    idleCleanupIntervalMs: parsePositiveInt(env.NAOW_IDLE_CLEANUP_INTERVAL_MS, DEFAULTS.idleCleanupIntervalMs, 'NAOW_IDLE_CLEANUP_INTERVAL_MS'),
    idleUnloadModels: parseBoolean(env.NAOW_IDLE_UNLOAD_MODELS, DEFAULTS.idleUnloadModels),
    idleUnloadPinnedMlx: parseBoolean(env.NAOW_IDLE_UNLOAD_PINNED_MLX, DEFAULTS.idleUnloadPinnedMlx),
    idleSearchStopMs: parseNonNegativeInt(env.NAOW_SEARCH_IDLE_STOP_MS, DEFAULTS.idleSearchStopMs, 'NAOW_SEARCH_IDLE_STOP_MS'),
    idleAttachmentTtlMs: parsePositiveInt(env.NAOW_IDLE_ATTACHMENT_TTL_MS, DEFAULTS.idleAttachmentTtlMs, 'NAOW_IDLE_ATTACHMENT_TTL_MS'),
    idleCacheMaxEntries: parsePositiveInt(env.NAOW_IDLE_CACHE_MAX_ENTRIES, DEFAULTS.idleCacheMaxEntries, 'NAOW_IDLE_CACHE_MAX_ENTRIES'),
    weatherProvider: env.NAOW_WEATHER_PROVIDER || DEFAULTS.weatherProvider,
    weatherUnits: env.NAOW_WEATHER_UNITS || DEFAULTS.weatherUnits,
    weatherGeocodeUrl: normalizeUrl(env.NAOW_WEATHER_GEOCODE_URL, DEFAULTS.weatherGeocodeUrl),
    weatherForecastUrl: normalizeUrl(env.NAOW_WEATHER_FORECAST_URL, DEFAULTS.weatherForecastUrl),
    toolsMdPath: path.resolve(cwd, env.NAOW_TOOLS_MD_PATH || 'tools.md'),
    mlxBaseUrl: normalizeUrl(env.NAOW_MLX_BASE_URL, DEFAULTS.mlxBaseUrl),
    mlxModel: env.NAOW_MLX_MODEL || DEFAULTS.mlxModel,
    mlxResidency: parseResidency(env.NAOW_MLX_RESIDENCY),
    mlxAutostart: parseBoolean(env.NAOW_MLX_AUTOSTART, true),
    mlxPython: env.NAOW_MLX_PYTHON || path.join(resolvedDataDir, 'mlx-venv', 'bin', 'python')
  };
}
