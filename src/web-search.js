import dns from 'node:dns/promises';
import net from 'node:net';
import { parseDocument } from 'htmlparser2';

function timeoutSignal(ms, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const abort = () => controller.abort();
  signal?.addEventListener?.('abort', abort, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
  };
}

function cacheGet(cache, key) {
  const item = cache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(cache, key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function cacheCleanup(cache, { now = Date.now(), maxEntries = 100 } = {}) {
  let expired = 0;
  let trimmed = 0;
  for (const [key, item] of cache) {
    if (item.expiresAt <= now) {
      cache.delete(key);
      expired += 1;
    }
  }
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) break;
    cache.delete(oldestKey);
    trimmed += 1;
  }
  return { expired, trimmed, size: cache.size };
}

function truncate(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 17))}\n[truncated]`;
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isPrivateIpv4(address);
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:') || value === '::';
  }
  return true;
}

async function assertPublicUrl(value, lookup) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs can be fetched.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private hostnames cannot be fetched.');
  }
  if (net.isIP(hostname) && isPrivateAddress(hostname)) throw new Error('Private network URLs cannot be fetched.');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Private network URLs cannot be fetched.');
  }
  return url;
}

function normalizeSearxngResults(payload, maxResults) {
  return (payload?.results || [])
    .map((result) => ({
      title: result.title || result.url || 'Untitled result',
      url: result.url || '',
      content: result.content || result.snippet || '',
      snippet: result.content || result.snippet || '',
      engine: result.engine || '',
      publishedAt: result.publishedDate || result.published_at || null
    }))
    .filter((result) => result.url && /^https?:\/\//i.test(result.url))
    .slice(0, maxResults);
}

function nodeText(node, parts = []) {
  if (!node) return parts;
  if (node.type === 'text' && node.data) {
    parts.push(node.data);
    return parts;
  }
  const name = node.name?.toLowerCase();
  if (['script', 'style', 'noscript', 'svg', 'canvas', 'form', 'nav', 'header', 'footer', 'aside'].includes(name)) {
    return parts;
  }
  for (const child of node.children || []) nodeText(child, parts);
  if (['p', 'div', 'section', 'article', 'main', 'li', 'br', 'h1', 'h2', 'h3'].includes(name)) parts.push('\n');
  return parts;
}

function findFirst(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

function findMetaDescription(node) {
  const meta = findFirst(node, (item) => item.name === 'meta' && ['description', 'og:description'].includes(String(item.attribs?.name || item.attribs?.property || '').toLowerCase()));
  return meta?.attribs?.content || '';
}

function extractHtml(html, fallbackTitle, maxChars) {
  const document = parseDocument(html);
  const titleNode = findFirst(document, (node) => node.name === 'title');
  const mainNode = findFirst(document, (node) => ['main', 'article'].includes(node.name)) || document;
  const title = truncate(nodeText(titleNode).join(' '), 180) || fallbackTitle || 'Untitled page';
  const description = truncate(findMetaDescription(document), 500);
  const text = truncate(nodeText(mainNode).join(' '), maxChars);
  return {
    title,
    description,
    text: [description, text].filter(Boolean).join('\n\n')
  };
}

async function readLimitedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class WebSearchClient {
  constructor({ config, sidecar = null, fetchImpl = fetch, lookupImpl = dns.lookup }) {
    this.config = config;
    this.sidecar = sidecar;
    this.fetch = fetchImpl;
    this.lookup = lookupImpl;
    this.queryCache = new Map();
    this.pageCache = new Map();
    this.inFlightQueries = new Map();
    this.inFlightPages = new Map();
  }

  async warmup() {
    if (this.config.searchProvider !== 'searxng' || !this.sidecar || !this.config.searchManaged) return;
    await this.sidecar.ensureReady();
  }

  async status() {
    if (this.config.searchProvider === 'disabled') {
      return { provider: 'disabled', managed: false, ready: false, state: 'disabled', message: 'Local search is disabled.' };
    }
    if (!this.sidecar) {
      return { provider: this.config.searchProvider, managed: false, ready: false, state: 'unavailable', message: 'Local search is not configured.' };
    }
    return this.sidecar.status();
  }

  async start() {
    if (!this.sidecar) return { provider: this.config.searchProvider, started: false, message: 'Local search is not configured.' };
    return this.sidecar.start();
  }

  async cleanupIdle({ maxEntries = 100, stopSidecar = false } = {}) {
    const queryCache = cacheCleanup(this.queryCache, { maxEntries });
    const pageCache = cacheCleanup(this.pageCache, { maxEntries });
    let sidecar = null;
    if (stopSidecar && this.sidecar?.stop) {
      sidecar = await this.sidecar.stop();
    }
    return {
      queryCache,
      pageCache,
      inFlightQueries: this.inFlightQueries.size,
      inFlightPages: this.inFlightPages.size,
      sidecar
    };
  }

  async search(query, { maxResults, signal } = {}) {
    const startedAt = Date.now();
    const provider = this.config.searchProvider || 'searxng';
    const limit = Math.max(1, Math.min(10, Number(maxResults || this.config.searchMaxResults || 5)));
    const pageLimit = Math.max(0, Math.min(limit, Number(this.config.searchFetchPages || 0)));
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return { provider, results: [], skipped: 'empty_query', message: 'Search query is empty.', elapsedMs: Date.now() - startedAt };
    }
    if (provider === 'disabled') {
      return { provider, results: [], skipped: 'disabled', message: 'Local search is disabled.', elapsedMs: Date.now() - startedAt };
    }

    const cacheKey = `${provider}:${limit}:${pageLimit}:${normalizedQuery.toLowerCase()}`;
    const cached = cacheGet(this.queryCache, cacheKey);
    if (cached) return { ...cached, cacheHit: true, elapsedMs: Date.now() - startedAt };
    if (this.inFlightQueries.has(cacheKey)) {
      const result = await this.inFlightQueries.get(cacheKey);
      return { ...result, cacheHit: true, elapsedMs: Date.now() - startedAt };
    }

    const work = this.searchFresh(normalizedQuery, { limit, pageLimit, provider, signal, startedAt });
    this.inFlightQueries.set(cacheKey, work);
    try {
      const result = await work;
      if (!result.skipped && !result.error) cacheSet(this.queryCache, cacheKey, result, this.config.searchQueryCacheMs);
      return result;
    } finally {
      this.inFlightQueries.delete(cacheKey);
    }
  }

  async searchFresh(query, { limit, pageLimit, provider, signal, startedAt }) {
    if (provider !== 'searxng') {
      return { provider, results: [], skipped: 'unsupported_provider', message: `Unsupported search provider: ${provider}.`, elapsedMs: Date.now() - startedAt };
    }

    if (this.sidecar) {
      const status = await this.sidecar.ensureReady();
      if (!status.ready) {
        return { provider, results: [], skipped: 'provider_unavailable', message: status.message, elapsedMs: Date.now() - startedAt };
      }
    }

    const timeout = timeoutSignal(this.config.searchTimeoutMs, signal);
    try {
      const url = new URL(this.config.searchUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('language', 'en-US');
      url.searchParams.set('safesearch', '0');
      const response = await this.fetch(url, {
        headers: { Accept: 'application/json' },
        signal: timeout.signal
      });
      if (!response.ok) {
        return { provider, results: [], skipped: 'provider_error', message: `SearXNG returned HTTP ${response.status}.`, elapsedMs: Date.now() - startedAt };
      }
      const payload = await response.json();
      const results = normalizeSearxngResults(payload, limit);
      if (!results.length) {
        return { provider, results: [], skipped: 'no_results', message: 'No search results found.', elapsedMs: Date.now() - startedAt };
      }
      const fetched = await Promise.all(results.slice(0, pageLimit).map((result) => this.fetchPage(result, signal)));
      const fetchedByUrl = new Map(fetched.filter(Boolean).map((page) => [page.url, page]));
      const merged = results.map((result) => {
        const page = fetchedByUrl.get(result.url);
        if (!page) return { ...result, content: truncate(result.content, this.config.searchMaxPageChars), fetched: false };
        return {
          ...result,
          title: page.title || result.title,
          content: truncate(page.text || result.content, this.config.searchMaxPageChars),
          pageDescription: page.description,
          fetched: true
        };
      });
      const output = {
        provider,
        results: merged,
        resultCount: merged.length,
        fetchedCount: merged.filter((result) => result.fetched).length,
        cacheHit: false,
        elapsedMs: Date.now() - startedAt
      };
      return output;
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      return { provider, results: [], skipped: 'provider_error', message: error?.message || 'Local search failed.', elapsedMs: Date.now() - startedAt };
    } finally {
      timeout.clear();
    }
  }

  async fetchPage(result, signal) {
    const key = result.url;
    const cached = cacheGet(this.pageCache, key);
    if (cached) return cached;
    if (this.inFlightPages.has(key)) return this.inFlightPages.get(key);

    const work = this.fetchPageFresh(result, signal);
    this.inFlightPages.set(key, work);
    try {
      const page = await work;
      if (page) cacheSet(this.pageCache, key, page, this.config.searchPageCacheMs);
      return page;
    } finally {
      this.inFlightPages.delete(key);
    }
  }

  async fetchPageFresh(result, signal) {
    const timeout = timeoutSignal(this.config.searchPageTimeoutMs, signal);
    try {
      const url = await assertPublicUrl(result.url, this.lookup);
      const response = await this.fetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'naow-local-search/0.1'
        },
        redirect: 'follow',
        signal: timeout.signal
      });
      if (!response.ok) return null;
      const type = response.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml\+xml/i.test(type)) return null;
      const html = await readLimitedText(response, this.config.searchMaxPageBytes);
      const extracted = extractHtml(html, result.title, this.config.searchMaxPageChars);
      return { url: result.url, ...extracted };
    } catch {
      return null;
    } finally {
      timeout.clear();
    }
  }
}

export function formatSearchResultsForContext(results, maxChars = 12000) {
  const rendered = (results || []).map((result, index) => {
    const title = result.title || 'Untitled result';
    const url = result.url || 'No URL';
    const content = truncate(result.content || result.snippet || '', 1400);
    return `${index + 1}. ${title}\nURL: ${url}${content ? `\nContent: ${content}` : ''}`;
  }).join('\n\n');
  return truncate(rendered, maxChars);
}
