/**
 * Broad image enrichment for search queries via Wikipedia thumbnails (+ DDG fallback).
 */

const WIKI_API =
  'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=0&gsrlimit=8&prop=pageimages&piprop=thumbnail&pithumbsize=520';

const DDG_API = 'https://api.duckduckgo.com/';

function normalizeImages(entries) {
  const out = [];
  const seen = new Set();
  for (const item of entries) {
    const url = item?.url;
    if (!url || seen.has(url)) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: String(item.title || '').slice(0, 200),
      source: item.source || 'Wikipedia'
    });
    if (out.length >= 12) break;
  }
  return out;
}

export async function fetchImagesForQuery(query, { fetchImpl = fetch, signal, limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const headers = {
    Accept: 'application/json',
    'User-Agent': 'NaowLocalChat/1.0 (educational; contact: local)'
  };

  const wiki = [];
  try {
    const url = `${WIKI_API}&gsrsearch=${encodeURIComponent(q)}`;
    const r = await fetchImpl(url, { signal, headers });
    if (r.ok) {
      const data = await r.json();
      const pages = data?.query?.pages || {};
      for (const page of Object.values(pages)) {
        const thumb = page?.thumbnail?.source;
        if (!thumb) continue;
        const title = page?.title || '';
        const desc = page?.terms?.description?.[0] || '';
        wiki.push({
          url: thumb,
          title: desc ? `${title} — ${desc}` : title,
          source: 'Wikipedia'
        });
      }
    }
  } catch {
    /* ignore */
  }

  let merged = normalizeImages(wiki);
  if (merged.length >= limit) return merged.slice(0, limit);

  try {
    const ddgUrl = `${DDG_API}?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
    const r2 = await fetchImpl(ddgUrl, { signal, headers: { ...headers, Accept: 'application/json' } });
    if (r2.ok) {
      const d = await r2.json();
      if (d?.Image) {
        merged = normalizeImages([
          ...merged,
          { url: d.Image, title: d.Heading || q, source: 'DuckDuckGo' }
        ]);
      }
      const topics = Array.isArray(d?.RelatedTopics) ? d.RelatedTopics : [];
      for (const t of topics) {
        const icon = t?.Icon?.URL;
        if (icon && icon.startsWith('http')) {
          merged = normalizeImages([
            ...merged,
            { url: icon, title: t.Text || t.FirstURL || '', source: 'DuckDuckGo' }
          ]);
        }
        if (merged.length >= limit) break;
      }
    }
  } catch {
    /* ignore */
  }

  return merged.slice(0, limit);
}
