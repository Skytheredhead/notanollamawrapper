import crypto from 'node:crypto';

const SEARCHY_PATTERNS = [
  /\b(latest|current|today|tonight|recent|right now|this week|this month|202[4-9])\b/i,
  /\b(price|pricing|release|version|docs?|api|policy|law|schedule|score|news|stock|weather)\b/i,
  /\b(best|top|compare|recommend|review)\b.+\b(now|today|current|latest|202[4-9])\b/i,
  /\b(search|look up|web|internet|find sources?)\b/i,
  /\bgoogle\s+(it|this|that|for)\b/i
];

const GENERAL_COMPARISON_PATTERNS = [
  /\b(difference|differences)\s+between\b/i,
  /\b(compare|comparison|versus|vs\.?)\b/i,
  /\b(pros\s+and\s+cons|which\s+is\s+better)\b/i
];

const SECRET_PATTERNS = [
  /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key|bearer)\b/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];

function tokenize(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 24);
}

function isSecretLike(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

function draftSimilarity(a, b) {
  const left = new Set(tokenize(normalizeText(a)).filter((word) => word.length > 2));
  const right = new Set(tokenize(normalizeText(b)).filter((word) => word.length > 2));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const word of left) {
    if (right.has(word)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

function dedupeResults(results = []) {
  const seen = new Set();
  const output = [];
  for (const result of results) {
    if (!result?.url) continue;
    const key = result.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}

function extractJson(text) {
  const value = String(text || '').trim();
  const direct = value.match(/\{[\s\S]*\}/);
  if (!direct) return null;
  try {
    return JSON.parse(direct[0]);
  } catch {
    return null;
  }
}

function fallbackClassification(draft) {
  const text = String(draft || '').trim();
  const shouldSearch = SEARCHY_PATTERNS.some((pattern) => pattern.test(text));
  return {
    shouldSearch,
    confidence: shouldSearch ? 0.72 : 0.2,
    queries: shouldSearch ? [text] : []
  };
}

function looksLikeGeneralComparison(text) {
  const value = String(text || '');
  const explicitlyCurrent = SEARCHY_PATTERNS.some((pattern) => pattern.test(value));
  if (explicitlyCurrent) return false;
  return GENERAL_COMPARISON_PATTERNS.some((pattern) => pattern.test(value));
}

function safeQueries(queries, fallback, maxQueries) {
  const seen = new Set();
  const output = [];
  for (const query of Array.isArray(queries) ? queries : []) {
    const text = String(query || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 3) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= maxQueries) break;
  }
  if (!output.length && fallback) output.push(fallback);
  return output.slice(0, maxQueries);
}

export class PreSearchManager {
  constructor({ config, searchClient, modelClient = null, now = () => Date.now() }) {
    this.config = config;
    this.searchClient = searchClient;
    this.modelClient = modelClient;
    this.now = now;
    this.records = new Map();
    this.inFlight = new Map();
  }

  cleanup() {
    const ttl = this.config.preSearchCacheMs;
    const now = this.now();
    for (const [id, record] of this.records) {
      if (now - record.createdAt > ttl) this.records.delete(id);
    }
    while (this.records.size > this.config.preSearchMaxEntries) {
      const oldest = this.records.keys().next().value;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }

  basicSkip({ draft, enabled = true, webSearch = true, hasAttachments = false } = {}) {
    const text = String(draft || '').trim();
    if (!enabled) return 'disabled';
    if (!webSearch) return 'web_search_disabled';
    if (hasAttachments) return 'attachments';
    if (tokenize(text).length < this.config.preSearchMinTokens) return 'too_short';
    if (isSecretLike(text)) return 'secret_like';
    if (!this.searchClient?.search) return 'search_unavailable';
    return null;
  }

  async classify(draft, signal, { forceModel = false } = {}) {
    const fallback = fallbackClassification(draft);
    if (!fallback.shouldSearch && !forceModel) return fallback;
    const mlx = this.modelClient?.mlx || this.modelClient;
    if (!mlx?.completeChat) return fallback;
    try {
      const result = await mlx.completeChat({
        model: this.config.preSearchModel,
        messages: [
          {
            role: 'system',
            content: [
              'Decide if this user message truly needs current web search before answering.',
              'Return shouldSearch true only when the answer would likely be wrong or stale without external current facts.',
              'Return false for ordinary explanations, coding help, definitions, brainstorming, and general comparisons unless the user asks for latest/current/recent/pricing/news/docs/sources.',
              'Return only compact JSON with keys shouldSearch, confidence, queries.',
              'queries must contain at most 5 short web search queries.'
            ].join('\n')
          },
          {
            role: 'user',
            content: String(draft || '').slice(0, this.config.preSearchMaxDraftChars)
          }
        ],
        options: {
          max_tokens: 64,
          temperature: 0,
          enable_thinking: false
        },
        signal
      });
      const parsed = extractJson(result.message?.content || result.content || '');
      if (!parsed) return fallback;
      return {
        shouldSearch: Boolean(parsed.shouldSearch),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
        queries: safeQueries(parsed.queries, draft, this.config.preSearchMaxQueries)
      };
    } catch {
      return fallback;
    }
  }

  async classifySubmitted(draft, signal) {
    const text = String(draft || '').trim();
    if (!text) {
      return { shouldSearch: false, confidence: 1, queries: [] };
    }
    if (isSecretLike(text)) {
      return { shouldSearch: false, confidence: 1, queries: [], skipped: 'secret_like' };
    }
    if (looksLikeGeneralComparison(text)) {
      return { shouldSearch: false, confidence: 0.9, queries: [], skipped: 'general_comparison' };
    }
    const fallback = fallbackClassification(text);
    if (!fallback.shouldSearch) {
      return { ...fallback, skipped: 'heuristic_not_needed' };
    }
    return this.classify(text, signal, { forceModel: false });
  }

  async analyze({ chatId, draft, enabled = true, webSearch = true, hasAttachments = false, signal } = {}) {
    this.cleanup();
    const skipped = this.basicSkip({ draft, enabled, webSearch, hasAttachments });
    if (skipped) return { used: false, skipped };

    const normalized = normalizeText(draft);
    const key = `${chatId}:${hashText(normalized)}`;
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const work = (async () => {
      const classification = await this.classify(draft, signal);
      const confidence = Number(classification.confidence || 0);
      if (!classification.shouldSearch || confidence < this.config.preSearchMinConfidence) {
        return { used: false, skipped: 'low_confidence', confidence };
      }

      const queries = safeQueries(classification.queries, draft, this.config.preSearchMaxQueries);
      const startedAt = this.now();
      const searchResults = [];
      for (const query of queries) {
        if (signal?.aborted) throw signal.reason || new Error('aborted');
        const result = await this.searchClient.search(query, {
          maxResults: this.config.searchMaxResults || this.config.webSearchMaxResults,
          fetchPages: 0,
          signal
        });
        searchResults.push(...(result.results || []));
      }
      const results = dedupeResults(searchResults).slice(0, this.config.preSearchMaxResults);
      if (!results.length) return { used: false, skipped: 'no_results', confidence, queries };

      const id = `pre_${this.now()}_${crypto.randomBytes(5).toString('hex')}`;
      const record = {
        id,
        chatId,
        draft: String(draft || ''),
        draftHash: hashText(draft),
        normalizedDraft: normalized,
        queries,
        results,
        confidence,
        createdAt: this.now(),
        elapsedMs: this.now() - startedAt,
        consumed: false
      };
      this.records.set(id, record);
      this.cleanup();
      return {
        used: true,
        preSearchId: id,
        confidence,
        queries,
        resultCount: results.length,
        elapsedMs: record.elapsedMs
      };
    })().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  consume({ preSearchId, chatId, finalQuery }) {
    this.cleanup();
    if (!preSearchId) return null;
    const record = this.records.get(preSearchId);
    if (!record || record.consumed || record.chatId !== chatId) return null;
    if (this.now() - record.createdAt > this.config.preSearchCacheMs) return null;
    const similarity = draftSimilarity(record.draft, finalQuery);
    const finalStartsWithDraft = normalizeText(finalQuery).startsWith(record.normalizedDraft);
    if (similarity < this.config.preSearchMinSimilarity && !finalStartsWithDraft) return null;
    record.consumed = true;
    return {
      ...record,
      result: {
        provider: this.config.searchProvider,
        results: record.results,
        resultCount: record.results.length,
        fetchedCount: record.results.filter((result) => result.fetched).length,
        cacheHit: true,
        elapsedMs: 0,
        preSearchId: record.id,
        fromPreSearch: true,
        draftFinalSimilarity: similarity
      }
    };
  }
}

export function looksSecretLikeDraft(text) {
  return isSecretLike(text);
}
