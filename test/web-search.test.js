import assert from 'node:assert/strict';
import test from 'node:test';
import { SearxngSidecar } from '../src/search-sidecar.js';
import { WebSearchClient, formatSearchResultsForContext } from '../src/web-search.js';

const baseConfig = {
  searchProvider: 'searxng',
  searchManaged: false,
  searchUrl: 'http://search.local/search',
  searchMaxResults: 5,
  searchFetchPages: 5,
  searchTimeoutMs: 1000,
  searchPageTimeoutMs: 1000,
  searchQueryCacheMs: 60_000,
  searchPageCacheMs: 60_000,
  searchMaxPageBytes: 200_000,
  searchMaxPageChars: 1000,
  searchMaxContextChars: 3000
};

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('web search normalizes SearXNG results and extracts fetched pages', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('http://search.local')) {
      return Response.json({
        results: [{
          title: 'Result title',
          url: 'https://example.com/page',
          content: 'Search snippet'
        }]
      });
    }
    return new Response('<html><head><title>Page title</title><meta name="description" content="Meta summary"></head><body><main><p>Readable page text.</p></main></body></html>', {
      headers: { 'content-type': 'text/html' }
    });
  };
  const client = new WebSearchClient({ config: baseConfig, fetchImpl, lookupImpl: publicLookup });
  const result = await client.search('hello world');

  assert.equal(result.provider, 'searxng');
  assert.equal(result.resultCount, 1);
  assert.equal(result.fetchedCount, 1);
  assert.equal(result.results[0].title, 'Page title');
  assert.match(result.results[0].content, /Meta summary/);
  assert.match(result.results[0].content, /Readable page text/);
  assert.equal(calls.length, 2);
});

test('web search can return snippets without fetching pages', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('http://search.local')) {
      return Response.json({
        results: [{
          title: 'Snippet title',
          url: 'https://example.com/snippet',
          content: 'Fast snippet'
        }]
      });
    }
    return new Response('<main>Should not be fetched</main>', {
      headers: { 'content-type': 'text/html' }
    });
  };
  const client = new WebSearchClient({ config: baseConfig, fetchImpl, lookupImpl: publicLookup });
  const result = await client.search('hello world', { fetchPages: 0 });

  assert.equal(result.provider, 'searxng');
  assert.equal(result.resultCount, 1);
  assert.equal(result.fetchedCount, 0);
  assert.equal(result.results[0].title, 'Snippet title');
  assert.equal(result.results[0].content, 'Fast snippet');
  assert.equal(calls.length, 1);
});

test('web search returns no_results for empty SearXNG result sets', async () => {
  const client = new WebSearchClient({
    config: baseConfig,
    fetchImpl: async () => Response.json({ results: [] }),
    lookupImpl: publicLookup
  });
  const result = await client.search('nothing');
  assert.equal(result.skipped, 'no_results');
  assert.deepEqual(result.results, []);
});

test('web search caches and dedupes identical queries', async () => {
  let searchCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).startsWith('http://search.local')) {
      searchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({
        results: [{ title: 'Cached', url: 'https://example.com/cached', content: 'Snippet' }]
      });
    }
    return new Response('<main>Cached page</main>', { headers: { 'content-type': 'text/html' } });
  };
  const client = new WebSearchClient({ config: baseConfig, fetchImpl, lookupImpl: publicLookup });
  const [a, b] = await Promise.all([client.search('cache me'), client.search('cache me')]);
  const c = await client.search('cache me');
  assert.equal(searchCalls, 1);
  assert.equal(a.resultCount, 1);
  assert.equal(b.cacheHit, true);
  assert.equal(c.cacheHit, true);
});

test('web search does not fetch private or non-html result pages', async () => {
  let privateFetchCalled = false;
  const fetchImpl = async (url) => {
    if (String(url).startsWith('http://search.local')) {
      return Response.json({
        results: [
          { title: 'Private', url: 'http://127.0.0.1:1234/private', content: 'Nope' },
          { title: 'PDF', url: 'https://example.com/file.pdf', content: 'PDF' }
        ]
      });
    }
    if (String(url).includes('127.0.0.1')) privateFetchCalled = true;
    return new Response('%PDF', { headers: { 'content-type': 'application/pdf' } });
  };
  const client = new WebSearchClient({ config: baseConfig, fetchImpl, lookupImpl: publicLookup });
  const result = await client.search('private');
  assert.equal(privateFetchCalled, false);
  assert.equal(result.fetchedCount, 0);
  assert.equal(result.results[0].fetched, false);
});

test('search context formatting includes source URLs and truncates', () => {
  const text = formatSearchResultsForContext([
    { title: 'One', url: 'https://example.com/one', content: 'a'.repeat(2000) }
  ], 500);
  assert.match(text, /https:\/\/example\.com\/one/);
  assert.match(text, /\[truncated\]/);
});

test('native SearXNG sidecar installs and starts without Docker', async () => {
  let spawned = false;
  let setupStarted = false;
  let healthy = false;
  const sidecar = new SearxngSidecar({
    home: '/tmp/naow-search-test',
    url: 'http://127.0.0.1:8088/search',
    settingsPath: '/tmp/naow-search-test/settings.yml',
    settingsTemplatePath: '/tmp/naow-search-test/template.yml',
    setupScript: '/tmp/naow-search-test/setup.py',
    managed: true,
    timeoutMs: 100,
    fetchImpl: async () => {
      if (!healthy) throw new Error('down');
      return Response.json({ results: [] });
    },
    execFileImpl: async () => {
      setupStarted = true;
      healthy = true;
      return { stdout: '', stderr: '' };
    },
    spawnImpl: () => {
      spawned = true;
      healthy = true;
      return {
        killed: false,
        unref() {},
        once() {},
        kill() {}
      };
    }
  });
  sidecar.installed = () => setupStarted;

  const first = await sidecar.ensureReady();
  assert.equal(first.state, 'installing');
  await sidecar.settingUp;
  const status = await sidecar.ensureReady();
  assert.equal(setupStarted, true);
  assert.equal(spawned, true);
  assert.equal(status.ready, true);
});

test('native SearXNG sidecar starts installed source with python', async () => {
  let spawned = false;
  let healthChecks = 0;
  const sidecar = new SearxngSidecar({
    home: '/tmp/naow-search-installed',
    url: 'http://127.0.0.1:8088/search',
    settingsPath: '/tmp/naow-search-installed/settings.yml',
    settingsTemplatePath: '/tmp/naow-search-installed/template.yml',
    setupScript: '/tmp/naow-search-installed/setup.py',
    managed: true,
    timeoutMs: 100,
    fetchImpl: async () => {
      healthChecks += 1;
      if (!spawned || healthChecks < 2) throw new Error('down');
      return Response.json({ results: [] });
    },
    spawnImpl: () => {
      spawned = true;
      return {
        killed: false,
        unref() {},
        once() {},
        kill() {}
      };
    }
  });
  sidecar.installed = () => true;

  const status = await sidecar.ensureReady();
  assert.equal(spawned, true);
  assert.equal(status.ready, true);
});
