const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: options.accept || '*/*',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

async function fetchDocument(url, options = {}) {
  return cheerio.load(await fetchText(url, options));
}

async function getTmdbMeta(tmdbId, mediaType = 'movie') {
  const type = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
  const data = await fetchJson(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids,alternative_titles,translations`);
  const title = data.title || data.name || data.original_title || data.original_name || '';
  const originalTitle = data.original_title || data.original_name || '';
  const date = data.release_date || data.first_air_date || '';
  const altTitles = [
    ...(data.alternative_titles?.titles || []).map((item) => item.title),
    ...(data.alternative_titles?.results || []).map((item) => item.title),
    ...(data.translations?.translations || []).map((item) => item.data?.title || item.data?.name)
  ].filter(Boolean);

  return {
    id: tmdbId,
    type,
    title,
    originalTitle,
    titles: [...new Set([title, originalTitle, ...altTitles].filter(Boolean))],
    year: Number.parseInt(String(date).slice(0, 4), 10) || null,
    imdbId: data.external_ids?.imdb_id || null
  };
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleScore(candidateTitle, meta) {
  const candidate = normalizeTitle(candidateTitle);
  if (!candidate) return 0;

  let best = 0;
  for (const title of meta.titles || []) {
    const expected = normalizeTitle(title);
    if (!expected) continue;
    if (candidate === expected) best = Math.max(best, 120);
    if (candidate.includes(expected) || expected.includes(candidate)) best = Math.max(best, 95);

    const candidateTokens = new Set(candidate.split(/\s+/).filter(Boolean));
    const expectedTokens = expected.split(/\s+/).filter(Boolean);
    const matches = expectedTokens.filter((token) => candidateTokens.has(token)).length;
    if (expectedTokens.length > 0) {
      best = Math.max(best, Math.round((matches / expectedTokens.length) * 80));
    }
  }

  return best;
}

function chooseBestMatch(items, meta, minScore = 70) {
  const scored = items
    .map((item) => {
      const score = titleScore(item.title, meta)
        + (item.year && meta.year && Number(item.year) === Number(meta.year) ? 20 : 0);
      return { ...item, score };
    })
    .sort((left, right) => right.score - left.score);

  return scored[0]?.score >= minScore ? scored[0] : null;
}

function absoluteUrl(url, baseUrl) {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

function inferQuality(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('2160') || text.includes('4k')) return '4K';
  if (text.includes('1080')) return '1080p';
  if (text.includes('720')) return '720p';
  if (text.includes('480')) return '480p';
  if (text.includes('360')) return '360p';
  return 'HD';
}

function stream(name, title, url, options = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  return {
    name,
    title,
    url,
    quality: options.quality || inferQuality(`${title} ${url}`),
    headers: options.headers || undefined,
    behaviorHints: options.headers ? { proxyHeaders: { request: options.headers } } : undefined
  };
}

module.exports = {
  USER_AGENT,
  absoluteUrl,
  chooseBestMatch,
  fetchDocument,
  fetchJson,
  fetchText,
  getTmdbMeta,
  inferQuality,
  normalizeTitle,
  stream,
  titleScore
};
