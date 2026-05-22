import { createHash } from 'node:crypto';

const RAW_BASE = String(
  process.env.ROGPLAY_RAW_BASE
    || 'https://raw.githubusercontent.com/retrocodes12/rogplay_addons/refs/heads/main/'
).trim().replace(/\/?$/u, '/');
const DEFAULT_TIMEOUT_MS = 6_000;
const LIVE_CACHE_TTL_MS = 30 * 60 * 1000;
const VOD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const VOD_STREAM_CACHE_TTL_MS = 5 * 60 * 1000;
const TMDB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c';
const LIVE_CATALOG_LIMIT = 50;
const LIVE_HEALTH_TIMEOUT_MS = 2_500;
const LIVE_PLAYLIST_TIMEOUT_MS = 6_000;
const LIVE_HEALTH_CACHE_TTL_MS = 10 * 60 * 1000;
const LIVE_CATALOG_HEALTH_CONCURRENCY = 12;
const LIVE_CATALOG_HEALTH_BUDGET_MS = 6_000;

const VOD_MANIFEST_URLS = Object.freeze([
  `${RAW_BASE}cinema/appserver.json`,
  `${RAW_BASE}cinema/servers.json`,
  `${RAW_BASE}cinema/english.json`,
  `${RAW_BASE}cinema/hindi.json`
]);

const MOVIE_ADDON_MANIFEST_URLS = Object.freeze([
  `${RAW_BASE}movies/hindimovie.json`,
  `${RAW_BASE}movies/filmyfly.json`,
  `${RAW_BASE}movies/yomovies.json`,
  `${RAW_BASE}movies/mp4movies.json`
]);

const DEAD_VOD_HOSTS = new Set([
  'madplay.site',
  'vid.streamtest.site',
  'uembed.site'
]);

const BROKEN_VOD_HOSTS = new Set([
  'api.flickystream.co'
]);

const LIVE_SOURCES = Object.freeze([
  { id: 'sports-json', name: 'Sports Direct Channels', category: 'sports', url: `${RAW_BASE}livetv/data/sports.json` },
  { id: 'directfr', name: 'French Channels', category: 'sports', url: `${RAW_BASE}livetv/data/directfr.json` },
  { id: 'crichd', name: 'CricHD Channels', category: 'sports', url: `${RAW_BASE}livetv/data/crichd.m3u` },
  { id: 'sonyliv', name: 'Sony LIV Channels', category: 'sports', url: `${RAW_BASE}livetv/data/sonyliv.m3u` },
  { id: 'dangalplay', name: 'DangalPlay Channels', category: 'entertainment', url: `${RAW_BASE}livetv/data/dangalplay.m3u` },
  { id: 'yupptv', name: 'YuppTV Channels', category: 'regional', url: `${RAW_BASE}livetv/data/yupptv.m3u` },
  { id: 'mxplay', name: 'MX Player Channels', category: 'entertainment', url: `${RAW_BASE}livetv/data/mxplay.m3u` },
  { id: 'distrotv', name: 'DistroTV Channels', category: 'entertainment', url: `${RAW_BASE}livetv/data/distrotv.m3u` },
  { id: 'freeiptv', name: 'Free IPTV Channels', category: 'news', url: `${RAW_BASE}livetv/test.m3u` }
]);

const LIVE_CATALOG_SOURCE_IDS = new Set(['dangalplay', 'yupptv', 'distrotv', 'freeiptv']);
const DEAD_LIVE_SOURCE_IDS = new Set(['sports-json', 'directfr', 'crichd', 'sonyliv', 'mxplay']);
const LIVE_SOURCE_PRIORITY = Object.freeze({
  dangalplay: 500,
  yupptv: 450,
  freeiptv: 350,
  distrotv: 300
});
const WORKING_URL_HINTS = Object.freeze([
  'content.jwplatform.com/manifests/',
  'segment.yuppcdn.net/',
  'yuppmedtaorire.akamaized.net/',
  'streams2.sofast.tv/',
  'global.cgtn.cicc.media.caton.cloud/',
  'stream-us-east-1.getpublica.com/',
  'api-ott',
  'ottera.tv/',
  'afrolandtv.com/',
  'cloudfront.net/v1/master/9d',
  'damkf751d85s1.cloudfront.net/'
]);
const DEAD_URL_HINTS = Object.freeze([
  'api.flickystream.co/',
  'streamcrichd.com/',
  'fremtv.lol/',
  'pubads.g.doubleclick.net/',
  'd35j504z0x2vu2.cloudfront.net/v1/master/0bc8e8376bd8417a1b6761138aa41c26c7309312/',
  'commondatastorage.googleapis.com/gtv-videos-bucket/sample/'
]);

const LIVE_CATALOGS = Object.freeze([
  { id: 'rogplay-live-sports', category: 'sports', name: 'Sports Channels' },
  { id: 'rogplay-live-news', category: 'news', name: 'News Channels' },
  { id: 'rogplay-live-regional', category: 'regional', name: 'Regional Channels' },
  { id: 'rogplay-live-entertainment', category: 'entertainment', name: 'Entertainment Channels' },
  { id: 'rogplay-live-all', category: 'all', name: 'All Live Channels' },
  ...LIVE_SOURCES
    .filter((source) => LIVE_CATALOG_SOURCE_IDS.has(source.id))
    .map((source) => ({
      id: `rogplay-live-source-${source.id}`,
      source: source.id,
      category: source.category,
      name: source.name
    }))
]);

const toString = (value) => String(value ?? '').trim();

const isHttpUrl = (value) => {
  try {
    const parsed = new URL(toString(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const getHostname = (value) => {
  try {
    return new URL(toString(value)).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const isBrokenVodUrl = (value) => {
  const hostname = getHostname(value);
  return DEAD_VOD_HOSTS.has(hostname) || BROKEN_VOD_HOSTS.has(hostname);
};

const normalizeTitle = (value) =>
  toString(value)
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();

const titleSimilarity = (left, right) => {
  const leftTitle = normalizeTitle(left);
  const rightTitle = normalizeTitle(right);
  if (!leftTitle || !rightTitle) return 0;
  if (leftTitle === rightTitle) return 100;
  if (rightTitle.startsWith(leftTitle) || leftTitle.startsWith(rightTitle)) return 85;
  if (rightTitle.includes(leftTitle) || leftTitle.includes(rightTitle)) return 70;

  const leftWords = new Set(leftTitle.split(' ').filter(Boolean));
  const rightWords = new Set(rightTitle.split(' ').filter(Boolean));
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) overlap += 1;
  }
  return leftWords.size > 0 ? Math.round((overlap / leftWords.size) * 60) : 0;
};

const matchesEpisode = (value, season, episode) => {
  const text = normalizeTitle(value);
  const seasonNumber = Number.parseInt(String(season || ''), 10);
  const episodeNumber = Number.parseInt(String(episode || ''), 10);
  if (!Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) return true;

  const seasonPattern = `season ${seasonNumber}`;
  const episodePattern = `episode ${episodeNumber}`;
  const compactPattern = `s${String(seasonNumber).padStart(2, '0')}e${String(episodeNumber).padStart(2, '0')}`;
  const looseCompactPattern = `s${seasonNumber}e${episodeNumber}`;
  return (text.includes(seasonPattern) && text.includes(episodePattern))
    || text.includes(compactPattern)
    || text.includes(looseCompactPattern);
};

const matchesSeriesTitle = (candidateTitle, metadata, request) => {
  if (metadata.mediaType !== 'tv') return true;
  const title = normalizeTitle(candidateTitle);
  const baseTitle = normalizeTitle(metadata.title);
  const seasonNumber = Number.parseInt(String(request.season || ''), 10);
  if (!baseTitle || !Number.isInteger(seasonNumber)) return false;
  return title.startsWith(`${baseTitle} season ${seasonNumber}`)
    || title.startsWith(`${baseTitle} s${String(seasonNumber).padStart(2, '0')}`)
    || title.startsWith(`${baseTitle} s${seasonNumber}`);
};

const getCandidateTitleScore = (candidateTitle, metadata, request) => {
  if (metadata.mediaType === 'tv' && !matchesSeriesTitle(candidateTitle, metadata, request)) {
    return 0;
  }
  return titleSimilarity(metadata.title, candidateTitle);
};

const isExactMediaTitle = (candidateTitle, metadata, request) => {
  const title = normalizeTitle(candidateTitle);
  const baseTitle = normalizeTitle(metadata.title);
  if (metadata.mediaType === 'tv') {
    return title === normalizeTitle(`${metadata.title} Season ${request.season || 1} Episode ${request.episode || 1}`)
      || title === normalizeTitle(`${metadata.title} S${String(request.season || 1).padStart(2, '0')}E${String(request.episode || 1).padStart(2, '0')}`);
  }
  return title === baseTitle;
};

const normalizeHeaderName = (name) => {
  const normalized = toString(name).toLowerCase();
  if (normalized === 'user-agent' || normalized === 'useragent' || normalized === 'ua') return 'User-Agent';
  if (normalized === 'referer' || normalized === 'referrer') return 'Referer';
  if (normalized === 'origin') return 'Origin';
  if (normalized === 'cookie') return 'Cookie';
  return '';
};

const parseHeaderPairs = (raw) => {
  const headers = {};
  const parts = String(raw || '').split('&');

  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) continue;
    const headerName = normalizeHeaderName(decodeURIComponent(part.slice(0, separatorIndex)));
    if (!headerName) continue;
    headers[headerName] = decodeURIComponent(part.slice(separatorIndex + 1));
  }

  return headers;
};

const splitUrlAndHeaders = (value) => {
  const raw = toString(value);
  const pipeIndex = raw.indexOf('|');
  let url = pipeIndex >= 0 ? raw.slice(0, pipeIndex) : raw;
  let headers = pipeIndex >= 0 ? parseHeaderPairs(raw.slice(pipeIndex + 1)) : {};

  try {
    const parsedUrl = new URL(url);
    for (const [name, headerName] of [
      ['User-Agent', 'User-Agent'],
      ['user-agent', 'User-Agent'],
      ['Referer', 'Referer'],
      ['referer', 'Referer'],
      ['Origin', 'Origin'],
      ['origin', 'Origin'],
      ['Cookie', 'Cookie'],
      ['cookie', 'Cookie']
    ]) {
      const headerValue = parsedUrl.searchParams.get(name);
      if (headerValue) {
        headers[headerName] = headerValue;
        parsedUrl.searchParams.delete(name);
      }
    }
    url = parsedUrl.toString();
  } catch {
    // Keep raw URL if it is not parseable.
  }

  return {
    url: toString(url),
    headers: Object.keys(headers).length > 0 ? headers : null
  };
};

const withTimeout = async (operation, timeoutMs, message) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  timeout.unref?.();

  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
};

const combineSignals = (...signals) => {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return null;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(activeSignals);

  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
};

const hashId = (value) =>
  createHash('sha1').update(String(value)).digest('base64url').slice(0, 18);

const encodeTargetUrl = (value) => Buffer.from(String(value || ''), 'utf8').toString('base64url');

const decodeTargetUrl = (value) => {
  try {
    return Buffer.from(String(value || ''), 'base64url').toString('utf8');
  } catch {
    return '';
  }
};

const inferQuality = (text) => {
  const normalized = toString(text).toLowerCase();
  const match = normalized.match(/\b(2160p|1080p|720p|480p|360p)\b/u);
  if (match) return match[1];
  if (/\b4k\b|\buhd\b/u.test(normalized)) return '2160p';
  if (normalized.includes('hd')) return '1080p';
  return 'Live';
};

const inferLiveCategory = (channel, fallback = 'entertainment') => {
  const text = `${channel.title || ''} ${channel.group || ''} ${channel.genre || ''} ${fallback}`.toLowerCase();
  if (/sport|cricket|football|tennis|f1|fancode|star sports|sky sports/u.test(text)) return 'sports';
  if (/news|abp|cnn|bbc|fox|euronews|newsmax|scripps|today/u.test(text)) return 'news';
  if (/tamil|telugu|malayalam|hindi|bhojpuri|bangla|punjabi|regional|yupp|dangal/u.test(text)) return 'regional';
  return fallback === 'all' ? 'entertainment' : fallback;
};

const responseLooksPlayable = async (response) => {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('mpegurl') || contentType.startsWith('video/') || contentType.includes('mp2t')) {
    return true;
  }
  if (contentType.includes('text/html')) {
    return false;
  }

  try {
    const reader = response.body?.getReader?.();
    if (!reader) return response.ok || response.status === 206 || response.status === 403;
    const { value } = await reader.read();
    await reader.cancel().catch(() => {});
    const chunk = new TextDecoder().decode(value || new Uint8Array());
    return chunk.includes('#EXTM3U') || /^https?:\/\//u.test(chunk.trim()) || contentType.includes('octet-stream');
  } catch {
    return response.ok || response.status === 206 || response.status === 403;
  }
};

const resolveHlsUrl = (line, playlistUrl) => {
  const value = toString(line);
  if (!value) return '';

  try {
    if (isHttpUrl(value)) return value;
    const playlist = new URL(playlistUrl);
    const firstPathSegment = playlist.pathname.split('/').filter(Boolean)[0];

    if (firstPathSegment && value.startsWith(`${firstPathSegment}/`)) {
      return new URL(`/${value}`, playlist.origin).toString();
    }

    return new URL(value, playlist).toString();
  } catch {
    return value;
  }
};

const isPlaylistReference = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return /\.m3u8(?:$|[?#])/iu.test(String(url || ''));
  }
};

const rewriteAttributeUri = (line, playlistUrl) =>
  line.replace(/URI="([^"]+)"/giu, (_match, uri) => `URI="${resolveHlsUrl(uri, playlistUrl)}"`);

const isProbablyDeadLiveChannel = (channel) => {
  const url = toString(channel.url).toLowerCase();
  return DEAD_LIVE_SOURCE_IDS.has(channel.source) || DEAD_URL_HINTS.some((hint) => url.includes(hint));
};

const getLiveChannelPriority = (channel) => {
  const url = toString(channel.url).toLowerCase();
  let score = LIVE_SOURCE_PRIORITY[channel.source] || 0;
  if (WORKING_URL_HINTS.some((hint) => url.includes(hint))) score += 100;
  if (isProbablyDeadLiveChannel(channel)) score -= 1000;
  if (url.includes('.m3u8')) score += 20;
  if (channel.logo) score += 5;
  return score;
};

const chunk = (items, size) => {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
};

const parseExtInfAttributes = (line) => {
  const attrs = {};
  const attrPart = line.replace(/^#EXTINF:[^ ]*/u, '');
  const regex = /([a-zA-Z0-9_-]+)="([^"]*)"/gu;
  let match;

  while ((match = regex.exec(attrPart))) {
    attrs[match[1].toLowerCase()] = match[2];
  }

  const commaIndex = line.lastIndexOf(',');
  const title = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : '';
  return { attrs, title };
};

const parseM3u = (text, source) => {
  const lines = String(text || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const channels = [];
  let pending = null;

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      pending = parseExtInfAttributes(line);
      continue;
    }

    if (line.startsWith('#')) continue;
    const parsedStream = splitUrlAndHeaders(line);
    if (!isHttpUrl(parsedStream.url)) continue;

    const attrs = pending?.attrs || {};
    const title = pending?.title || attrs['tvg-name'] || attrs['tvg-id'] || source.id;
    channels.push({
      id: attrs['tvg-id'] || attrs['channel-id'] || attrs['tvg-chno'] || '',
      title,
      url: parsedStream.url,
      logo: attrs['tvg-logo'] || '',
      group: attrs['group-title'] || attrs['tvg-group'] || source.id,
      genre: attrs['tvg-genre'] || attrs['group-title'] || source.category,
      language: attrs['tvg-language'] || '',
      headers: parsedStream.headers,
      source: source.id,
      category: inferLiveCategory({ title, group: attrs['group-title'], genre: attrs['tvg-genre'] }, source.category)
    });
    pending = null;
  }

  return channels;
};

const normalizeJsonChannels = (items, source) =>
  (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const title = toString(item.title || item.name || item.channel || item.label);
      const parsedStream = splitUrlAndHeaders(item.url || item.file || item.link || item.stream);
      if (!title || !isHttpUrl(parsedStream.url)) return null;

      return {
        id: toString(item.id || index + 1),
        title,
        url: parsedStream.url,
        logo: toString(item.logo || item.image || item.poster),
        group: toString(item.group || item.groupTitle || item.type || source.id),
        genre: toString(item.genre || item.category || source.category),
        language: toString(item.language || item.lang),
        headers: item.headers && typeof item.headers === 'object'
          ? { ...(parsedStream.headers || {}), ...item.headers }
          : parsedStream.headers,
        source: source.id,
        category: inferLiveCategory(item, source.category)
      };
    })
    .filter(Boolean);

const dedupeByUrl = (channels) => {
  const seen = new Set();
  const deduped = [];

  for (const channel of channels) {
    const key = channel.url;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(channel);
  }

  return deduped;
};

export class RogPlayAdapter {
  constructor({ logger = console, fetchImpl = globalThis.fetch } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.memory = new Map();
    this.liveHealthCache = new Map();
    this.tmdbCache = new Map();
  }

  getLiveCatalogDefinitions() {
    return LIVE_CATALOGS.map((catalog) => ({ ...catalog }));
  }

  async fetchText(url, { ttlMs, signal = null } = {}) {
    const now = Date.now();
    const cached = this.memory.get(url);
    if (cached && cached.expiresAt > now) return cached.value;

    const value = await withTimeout(async (timeoutSignal) => {
      const response = await this.fetchImpl(url, {
        signal: combineSignals(signal, timeoutSignal),
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'User-Agent': 'NebulaStreams/1.0 RogPlayAdapter'
        }
      });
      if (!response.ok) throw new Error(`RogPlay fetch failed ${response.status} for ${url}`);
      return response.text();
    }, DEFAULT_TIMEOUT_MS, `RogPlay fetch timed out for ${url}`);

    this.memory.set(url, { value, expiresAt: now + ttlMs });
    return value;
  }

  async fetchJson(url, options = {}) {
    const text = await this.fetchText(url, options);
    return JSON.parse(text.replace(/,\s*\]/gu, ']'));
  }

  async getVodServers() {
    const settled = await Promise.allSettled(
      VOD_MANIFEST_URLS.map((url) => this.fetchJson(url, { ttlMs: VOD_CACHE_TTL_MS }))
    );

    return settled.flatMap((result) => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []);
  }

  async getMovieAddons() {
    const settled = await Promise.allSettled(
      MOVIE_ADDON_MANIFEST_URLS.map((url) => this.fetchJson(url, { ttlMs: VOD_CACHE_TTL_MS }))
    );

    return settled
      .flatMap((result) => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : [])
      .filter((addon) => toString(addon.type).toLowerCase() === 'movie' && isHttpUrl(addon.url))
      .filter((addon) => !isBrokenVodUrl(addon.url));
  }

  async getTmdbMetadata(request) {
    const mediaType = toString(request.mediaType) === 'tv' ? 'tv' : 'movie';
    const cacheKey = `${mediaType}:${request.tmdbId}`;
    const cached = this.tmdbCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const url = new URL(`https://api.themoviedb.org/3/${mediaType}/${encodeURIComponent(String(request.tmdbId))}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    const value = await this.fetchJson(url.toString(), {
      ttlMs: TMDB_CACHE_TTL_MS,
      signal: request.signal
    });
    const metadata = {
      mediaType,
      title: toString(value.title || value.name || value.original_title || value.original_name),
      year: Number.parseInt(String(value.release_date || value.first_air_date || '').slice(0, 4), 10) || null
    };
    this.tmdbCache.set(cacheKey, {
      value: metadata,
      expiresAt: Date.now() + TMDB_CACHE_TTL_MS
    });
    return metadata;
  }

  buildVodUrl(template, request) {
    return toString(template)
      .replaceAll('${tmdb}', encodeURIComponent(String(request.tmdbId || '')))
      .replaceAll('${season}', encodeURIComponent(String(request.season || '')))
      .replaceAll('${episode}', encodeURIComponent(String(request.episode || '')));
  }

  normalizeVodUrl(value) {
    const parsedStream = splitUrlAndHeaders(value);
    return parsedStream;
  }

  normalizeVodResponse(payload, server) {
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.streams)
        ? payload.streams
        : Array.isArray(payload?.data)
          ? payload.data
          : payload && typeof payload === 'object'
            ? [payload]
            : [];

    return rows.map((row) => {
      const parsedStream = this.normalizeVodUrl(row?.[server.url] || row?.url || row?.file || row?.link || row?.stream);
      if (!isHttpUrl(parsedStream.url)) return null;
      const title = toString(row?.[server.title] || row?.title || row?.name || server.server);

      return {
        provider: 'rogplay-vod',
        sourceProvider: `rogplay-vod:${toString(server.server).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`,
        sourceSite: server.server || 'RogPlay',
        title: title || server.server || 'RogPlay',
        name: title || server.server || 'RogPlay',
        quality: row?.quality || row?.resolution || inferQuality(`${title} ${parsedStream.url}`),
        url: parsedStream.url,
        headers: row?.headers && typeof row.headers === 'object'
          ? { ...(parsedStream.headers || {}), ...row.headers }
          : parsedStream.headers
      };
    }).filter(Boolean);
  }

  async getMovieAddonStreams(request) {
    const metadata = await this.getTmdbMetadata(request);
    if (!metadata.title) return [];

    const addons = await this.getMovieAddons();
    const searchTerms = metadata.mediaType === 'tv'
      ? [
          `${metadata.title} Season ${request.season || 1} Episode ${request.episode || 1}`,
          `${metadata.title} Season ${request.season || 1}`,
          metadata.title
        ]
      : [
          metadata.year ? `${metadata.title} ${metadata.year}` : metadata.title,
          metadata.title
        ];
    const settled = await Promise.allSettled(addons.map((addon) =>
      this.getSingleMovieAddonStreams(addon, metadata, searchTerms, request)
    ));

    return settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter(Boolean);
  }

  async getSingleMovieAddonStreams(addon, metadata, searchTerms, request) {
    const found = [];

    for (const searchTerm of searchTerms) {
      const searchUrl = new URL(addon.url);
      searchUrl.searchParams.set('search', searchTerm);
      const searchResults = await this.fetchJson(searchUrl.toString(), {
        ttlMs: VOD_STREAM_CACHE_TTL_MS,
        signal: request.signal
      });
      const candidates = (Array.isArray(searchResults) ? searchResults : [])
        .filter((row) => isHttpUrl(row?.url))
        .map((row) => ({
          row,
          exact: isExactMediaTitle(row.title, metadata, request),
          score: getCandidateTitleScore(row.title, metadata, request)
        }))
        .filter((entry) => metadata.mediaType !== 'tv' || matchesEpisode(`${entry.row.title} ${entry.row.url}`, request.season, request.episode))
        .filter((entry) => entry.score >= 70)
        .sort((left, right) => Number(right.exact) - Number(left.exact) || right.score - left.score);
      const exactCandidates = candidates.filter((entry) => entry.exact);
      const selectedCandidates = (exactCandidates.length > 0 ? exactCandidates : candidates).slice(0, 1);

      for (const candidate of selectedCandidates) {
        const streams = await this.fetchJson(candidate.row.url, {
          ttlMs: VOD_STREAM_CACHE_TTL_MS,
          signal: request.signal
        });
        const normalized = this.normalizeMovieAddonResponse(streams, addon, candidate.row);
        found.push(...normalized);
      }

      if (found.length > 0) break;
    }

    return found;
  }

  normalizeMovieAddonResponse(payload, addon, resultRow) {
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.streams)
        ? payload.streams
        : payload && typeof payload === 'object'
          ? [payload]
          : [];
    const sourceKey = `rogplay-movie:${toString(addon.title).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`;

    return rows.map((row) => {
      const parsedStream = this.normalizeVodUrl(row?.url || row?.file || row?.link || row?.stream);
      if (!isHttpUrl(parsedStream.url)) return null;
      const title = toString(row?.title || row?.name || resultRow?.title || addon.title);

      return {
        provider: 'rogplay-vod',
        sourceProvider: sourceKey,
        sourceSite: addon.title || 'RogPlay Movie',
        title: title || addon.title || 'RogPlay Movie',
        name: title || addon.title || 'RogPlay Movie',
        quality: row?.quality || row?.resolution || inferQuality(`${title} ${parsedStream.url}`),
        url: parsedStream.url,
        headers: row?.headers && typeof row.headers === 'object'
          ? { ...(parsedStream.headers || {}), ...row.headers }
          : parsedStream.headers
      };
    }).filter(Boolean);
  }

  async getStreams(request) {
    if (request.providerId === 'rogplay-live') {
      return [];
    }

    const servers = await this.getVodServers();
    const mediaType = toString(request.mediaType) === 'tv' ? 'tv' : 'movie';
    const settled = await Promise.allSettled(servers.map(async (server) => {
      const template = mediaType === 'tv' ? server.tvurl : server.movieurl;
      const url = this.buildVodUrl(template, request);
      if (!isHttpUrl(url) || isBrokenVodUrl(url)) return [];
      const payload = await this.fetchJson(url, { ttlMs: VOD_STREAM_CACHE_TTL_MS, signal: request.signal });
      return this.normalizeVodResponse(payload, server);
    }));
    const movieAddonStreams = await this.getMovieAddonStreams(request).catch((error) => {
      this.logger?.warn?.('rogplay movie addon lookup failed', {
        error: error?.message || String(error)
      });
      return [];
    });

    return [
      ...settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter(Boolean),
      ...movieAddonStreams
    ];
  }

  async loadLiveChannels() {
    const settled = await Promise.allSettled(LIVE_SOURCES.map(async (source) => {
      const text = await this.fetchText(source.url, { ttlMs: LIVE_CACHE_TTL_MS });
      if (source.url.endsWith('.m3u') || source.url.endsWith('.m3u8')) {
        return parseM3u(text, source);
      }
      return normalizeJsonChannels(JSON.parse(text), source);
    }));

    const channels = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    return dedupeByUrl(channels).map((channel) => ({
      ...channel,
      id: `rogplay:${hashId(`${channel.title}|${channel.url}`)}`,
      normalizedTitle: toString(channel.title).toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()
    }));
  }

  toLiveMeta(channel) {
    return {
      id: channel.id,
      type: 'tv',
      name: channel.title,
      poster: channel.logo || undefined,
      logo: channel.logo || undefined,
      posterShape: 'square',
      genres: [...new Set([channel.category, channel.group, channel.genre].filter(Boolean))],
      description: `${channel.group || channel.source} • ${channel.category}`,
      releaseInfo: 'Live',
      runtime: 'Live'
    };
  }

  async getLiveMeta(id) {
    const channels = await this.loadLiveChannels();
    const channel = channels.find((item) => item.id === id);
    return channel ? this.toLiveMeta(channel) : null;
  }

  async getLiveCatalog({ category = 'all', source = null, skip = 0, limit = LIVE_CATALOG_LIMIT } = {}) {
    const channels = await this.loadLiveChannels();
    const candidates = channels
      .filter((channel) => !source || channel.source === source)
      .filter((channel) => source || LIVE_CATALOG_SOURCE_IDS.has(channel.source))
      .filter((channel) => source || category === 'all' || channel.category === category)
      .filter((channel) => !isProbablyDeadLiveChannel(channel))
      .sort((left, right) => getLiveChannelPriority(right) - getLiveChannelPriority(left))
      .slice(skip);
    const healthyChannels = await this.filterHealthyLiveCatalogChannels(candidates, limit);

    return healthyChannels
      .map((channel) => this.toLiveMeta(channel));
  }

  async filterHealthyLiveCatalogChannels(channels, limit) {
    const requestedLimit = Number.isFinite(limit) && limit > 0 ? limit : LIVE_CATALOG_LIMIT;
    const healthy = [];
    const startedAt = Date.now();

    for (const batch of chunk(channels, LIVE_CATALOG_HEALTH_CONCURRENCY)) {
      if (healthy.length >= requestedLimit || Date.now() - startedAt > LIVE_CATALOG_HEALTH_BUDGET_MS) {
        break;
      }

      const settled = await Promise.allSettled(batch.map(async (channel) => ({
        channel,
        healthy: await this.isLiveStreamHealthy(channel)
      })));

      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value.healthy) {
          healthy.push(result.value.channel);
          if (healthy.length >= requestedLimit) break;
        }
      }
    }

    return healthy.length > 0 ? healthy.slice(0, requestedLimit) : channels.slice(0, requestedLimit);
  }

  async isLiveStreamHealthy(channel) {
    if (isProbablyDeadLiveChannel(channel)) {
      return false;
    }

    const cached = this.liveHealthCache.get(channel.url);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.healthy;
    }

    try {
      const healthy = await withTimeout(async (signal) => {
        const response = await this.fetchImpl(channel.url, {
          method: 'GET',
          signal,
          headers: {
            ...(channel.headers || {}),
            Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,*/*',
            'User-Agent': channel.headers?.['User-Agent'] || 'Mozilla/5.0'
          }
        });
        if (!(response.ok || response.status === 206 || response.status === 403)) {
          return false;
        }

        return responseLooksPlayable(response);
      }, LIVE_HEALTH_TIMEOUT_MS, 'RogPlay live health check timed out');
      this.liveHealthCache.set(channel.url, {
        healthy,
        expiresAt: Date.now() + LIVE_HEALTH_CACHE_TTL_MS
      });
      return healthy;
    } catch {
      this.liveHealthCache.set(channel.url, {
        healthy: false,
        expiresAt: Date.now() + Math.min(LIVE_HEALTH_CACHE_TTL_MS, 60_000)
      });
      return false;
    }
  }

  getLivePlaylistUrl(baseUrl, channelId, targetUrl = null) {
    const playlistUrl = new URL(`/rogplay/live/${encodeURIComponent(channelId)}/playlist.m3u8`, baseUrl);
    if (targetUrl) {
      playlistUrl.searchParams.set('target', encodeTargetUrl(targetUrl));
    }
    return playlistUrl.toString();
  }

  toStreamUrl(channel, baseUrl) {
    if (!baseUrl || !isPlaylistReference(channel.url)) {
      return channel.url;
    }

    return this.getLivePlaylistUrl(baseUrl, channel.id);
  }

  async getLiveStreams(id, { baseUrl = null } = {}) {
    const channels = await this.loadLiveChannels();
    const selected = channels.find((channel) => channel.id === id);
    if (!selected) return [];

    const duplicates = channels
      .filter((channel) => channel.normalizedTitle === selected.normalizedTitle)
      .slice(0, 4);
    const checked = await Promise.allSettled(duplicates.map(async (channel) => ({
      channel,
      healthy: await this.isLiveStreamHealthy(channel)
    })));
    const healthyOrder = checked
      .filter((result) => result.status === 'fulfilled' && result.value.healthy)
      .map((result) => result.value.channel);
    const fallbackOrder = healthyOrder.length > 0 ? healthyOrder : [];

    return fallbackOrder.map((channel, index) => ({
      name: `NebulaStreams ${channel.category === 'sports' ? 'Sports' : 'Live'}`,
      title: `${channel.title}\n🔗 ${channel.source} Live${index > 0 ? '\n↪ fallback' : ''}`,
      url: this.toStreamUrl(channel, baseUrl),
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `rogplay-live-${channel.normalizedTitle}`,
        ...(channel.headers ? { proxyHeaders: { request: channel.headers } } : {})
      }
    }));
  }

  validateLivePlaylistTarget(channel, targetUrl) {
    const target = toString(targetUrl) || channel.url;
    if (!isHttpUrl(target)) return null;

    try {
      const channelUrl = new URL(channel.url);
      const parsedTarget = new URL(target);
      if (parsedTarget.origin !== channelUrl.origin) {
        return null;
      }
      return parsedTarget.toString();
    } catch {
      return null;
    }
  }

  rewriteLivePlaylist(text, playlistUrl, channelId, baseUrl) {
    return String(text || '')
      .split(/\r?\n/u)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith('#')) {
          return rewriteAttributeUri(line, playlistUrl);
        }

        const absoluteUrl = resolveHlsUrl(trimmed, playlistUrl);
        if (isPlaylistReference(absoluteUrl)) {
          return this.getLivePlaylistUrl(baseUrl, channelId, absoluteUrl);
        }
        return absoluteUrl;
      })
      .join('\n');
  }

  async getLivePlaylist({ id, target = '', baseUrl, signal = null }) {
    const channels = await this.loadLiveChannels();
    const channel = channels.find((item) => item.id === id);
    if (!channel) return null;

    const targetUrl = this.validateLivePlaylistTarget(channel, decodeTargetUrl(target));
    if (!targetUrl) return null;

    const text = await withTimeout(async (timeoutSignal) => {
      const response = await this.fetchImpl(targetUrl, {
        signal: combineSignals(signal, timeoutSignal),
        headers: {
          ...(channel.headers || {}),
          Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
          'User-Agent': channel.headers?.['User-Agent'] || 'Mozilla/5.0'
        }
      });
      if (!response.ok) throw new Error(`RogPlay live playlist fetch failed ${response.status}`);
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) throw new Error('RogPlay live playlist returned HTML');
      return response.text();
    }, LIVE_PLAYLIST_TIMEOUT_MS, 'RogPlay live playlist fetch timed out');

    if (!text.includes('#EXTM3U')) return null;
    return this.rewriteLivePlaylist(text, targetUrl, id, baseUrl);
  }
}
