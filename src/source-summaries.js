function domainForUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function faviconForUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}/favicon.ico`;
  } catch {
    return '';
  }
}

function cacheKey(source) {
  return String(source?.url || source?.title || '').toLowerCase();
}

function fallbackSummary(source) {
  const text = String(source?.snippet || source?.content || source?.summary || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'No summary available.';
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

export class SourceSummaryCache {
  constructor({ config, modelClient = null, now = () => Date.now() }) {
    this.config = config;
    this.modelClient = modelClient;
    this.now = now;
    this.cache = new Map();
  }

  cleanup() {
    const now = this.now();
    for (const [key, item] of this.cache) {
      if (item.expiresAt <= now) this.cache.delete(key);
    }
    while (this.cache.size > this.config.sourceSummaryMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  async summarizeOne(source, signal) {
    const key = cacheKey(source);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const base = {
      title: source?.title || source?.url || 'Untitled source',
      url: source?.url || '',
      domain: source?.domain || domainForUrl(source?.url),
      faviconUrl: source?.faviconUrl || faviconForUrl(source?.url),
      summary: fallbackSummary(source)
    };

    const mlx = this.modelClient?.mlx || this.modelClient;
    if (mlx?.completeChat && (source?.snippet || source?.content)) {
      try {
        const result = await mlx.completeChat({
          model: this.config.preSearchModel,
          messages: [
            {
              role: 'system',
              content: 'Summarize this search source in one short sentence. Return only the sentence.'
            },
            {
              role: 'user',
              content: [
                `Title: ${base.title}`,
                `URL: ${base.url}`,
                `Text: ${String(source.snippet || source.content).slice(0, 1800)}`
              ].join('\n')
            }
          ],
          options: {
            max_tokens: 80,
            temperature: 0,
            enable_thinking: false
          },
          signal
        });
        const text = String(result.message?.content || result.content || '').replace(/\s+/g, ' ').trim();
        if (text) base.summary = text.length > 240 ? `${text.slice(0, 237)}...` : text;
      } catch {
        // Keep fallback summary.
      }
    }

    this.cache.set(key, {
      value: base,
      expiresAt: this.now() + this.config.sourceSummaryCacheMs
    });
    this.cleanup();
    return base;
  }

  async summarize(sources = [], { signal } = {}) {
    const items = [];
    for (const source of sources.slice(0, 10)) {
      items.push(await this.summarizeOne(source, signal));
    }
    return { sources: items };
  }
}
