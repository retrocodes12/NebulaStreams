import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { freemem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const API_BASE = 'https://streamed.pk';
const EMBED_BASE = 'https://embed.st';
const CACHE_TTL_MS = 5 * 60 * 1000;
const EVENT_CATALOG_LIMIT = 50;
const DEFAULT_BROWSER_TIMEOUT_MS = 15_000;
const DEFAULT_HLS_CACHE_MS = 15_000;
const DEFAULT_PLAYLIST_CACHE_MS = 1_500;
const DEFAULT_BROWSER_IDLE_MS = 60_000;
const MIN_BROWSER_PREWARM_FREE_BYTES = 768 * 1024 * 1024;
const MAX_BROWSER_PREWARM_IN_FLIGHT = 2;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36';
const HLS_PROBE_TIMEOUT_MS = 6_000;
const HLS_PROBE_DISABLE_MS = 10 * 60 * 1000;
const HLS_PROBE_SCRIPT = path.join(process.cwd(), 'scripts', 'streamed_hls_probe.py');
const STREAM_SOURCE_RANK = new Map([
  ['admin', 0],
  ['delta', 1],
  ['echo', 2],
  ['golf', 3]
]);

const toString = (value) => String(value ?? '').trim();

const normalizeIdPart = (value) =>
  toString(value).toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'other';

const normalizeTitle = (value) =>
  toString(value)
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();

const isHttpUrl = (value) => {
  try {
    const parsed = new URL(toString(value), API_BASE);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const toAbsoluteStreamedUrl = (value) => {
  const normalized = toString(value);
  if (!normalized) return null;
  try {
    return new URL(normalized, API_BASE).toString();
  } catch {
    return null;
  }
};

const formatEventTime = (dateValue) => {
  const date = Number(dateValue || 0);
  if (!Number.isFinite(date) || date <= 0) return 'Live';
  return new Date(date).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};

export class StreamedSportsAdapter {
  constructor({
    logger = console,
    fetchImpl = globalThis.fetch,
    chromePath = '',
    browserTimeoutMs = DEFAULT_BROWSER_TIMEOUT_MS,
    hlsCacheMs = DEFAULT_HLS_CACHE_MS,
    browserIdleMs = DEFAULT_BROWSER_IDLE_MS,
    cacheDir = path.join(process.cwd(), 'cache', 'streamed-sports')
  } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.chromePath = toString(chromePath || process.env.STREAMED_SPORTS_CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH);
    this.browserTimeoutMs = Number(browserTimeoutMs || DEFAULT_BROWSER_TIMEOUT_MS);
    this.hlsCacheMs = Math.max(0, Number(hlsCacheMs ?? DEFAULT_HLS_CACHE_MS));
    this.browserIdleMs = Math.max(10_000, Number(browserIdleMs || DEFAULT_BROWSER_IDLE_MS));
    this.cacheDir = cacheDir;
    this.cacheDirReady = null;
    this.sportsCache = null;
    this.matchesCache = new Map();
    this.matchIndex = new Map();
    this.catalogMatchIndex = new Map();
    this.streamCache = new Map();
    this.hlsCache = new Map();
    this.playlistCache = new Map();
    this.browserFetchInFlight = new Map();
    this.playlistPrewarmInFlight = new Map();
    this.hlsResolveInFlight = new Map();
    this.browserPromise = null;
    this.browserFetchPagePromise = null;
    this.browserFetchPageUses = 0;
    this.hlsResolvePagePromise = null;
    this.hlsResolvePageUses = 0;
    this.hlsResolveChain = Promise.resolve();
    this.browserFetchChain = Promise.resolve();
    this.browserIdleTimer = null;
    this.activeBrowserPages = 0;
    this.hlsProbeEnabled = toString(process.env.STREAMED_SPORTS_HLS_PROBE_ENABLED).toLowerCase() === 'true';
    this.hlsBrowserFallbackEnabled = toString(
      process.env.STREAMED_SPORTS_HLS_BROWSER_FALLBACK_ENABLED || (this.hlsProbeEnabled ? 'false' : 'true')
    ).toLowerCase() === 'true';
    this.hlsProbeFailures = 0;
    this.hlsProbeDisabledUntil = 0;
  }

  async fetchJson(path, signal = null) {
    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      signal,
      headers: {
        accept: 'application/json,*/*',
        'User-Agent': 'NebulaStreams/1.0',
        Referer: 'https://streamed.pk/'
      }
    });
    if (!response.ok) throw new Error(`Streamed HTTP ${response.status}`);
    return response.json();
  }

  async getSports(signal = null) {
    if (this.sportsCache && this.sportsCache.expiresAt > Date.now()) {
      return this.sportsCache.value;
    }

    const shared = await this.readSharedCache('sports');
    if (Array.isArray(shared)) {
      this.sportsCache = {
        value: shared,
        expiresAt: Date.now() + CACHE_TTL_MS
      };
      return shared;
    }

    try {
      const payload = await this.fetchJson('/api/sports', signal);
      const sports = (Array.isArray(payload) ? payload : [])
        .map((sport) => ({
          id: normalizeIdPart(sport?.id),
          name: toString(sport?.name)
        }))
        .filter((sport) => sport.id && sport.name);
      this.sportsCache = {
        value: sports,
        expiresAt: Date.now() + CACHE_TTL_MS
      };
      await this.writeSharedCache('sports', sports, CACHE_TTL_MS).catch(() => {});
      return sports;
    } catch (error) {
      this.logger.warn?.('streamed sports load failed', { error: error?.message || String(error) });
      return this.sportsCache?.value || [];
    }
  }

  getEventCatalogDefinitions(sports = []) {
    const definitions = [
      { type: 'tv', id: 'streamed-events-live', endpoint: '/api/matches/live', name: 'Sports Events: Live' },
      { type: 'tv', id: 'streamed-events-today', endpoint: '/api/matches/all-today', name: 'Sports Events: Today' },
      { type: 'tv', id: 'streamed-events-popular', endpoint: '/api/matches/all-today/popular', name: 'Sports Events: Popular' }
    ];

    for (const sport of sports.slice(0, 15)) {
      definitions.push({
        type: 'tv',
        id: `streamed-events-${sport.id}`,
        endpoint: `/api/matches/${encodeURIComponent(sport.id)}`,
        name: `Sports Events: ${sport.name}`
      });
    }

    return definitions;
  }

  async getCatalogDefinition(catalogId, signal = null) {
    const sports = await this.getSports(signal);
    return this.getEventCatalogDefinitions(sports)
      .find((definition) => definition.id === catalogId) || null;
  }

  async loadMatches(catalog, signal = null) {
    const endpoint = toString(catalog?.endpoint);
    if (!endpoint) return [];

    const cached = this.matchesCache.get(endpoint);
    if (cached && cached.expiresAt > Date.now()) {
      this.indexMatches(catalog, cached.value);
      return cached.value;
    }

    const shared = await this.readSharedCache(`matches:${endpoint}`);
    if (Array.isArray(shared)) {
      this.matchesCache.set(endpoint, {
        value: shared,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, shared);
      return shared;
    }

    try {
      const payload = await this.fetchJson(endpoint, signal);
      const matches = (Array.isArray(payload) ? payload : [])
        .map((entry) => this.toMatch(entry))
        .filter((match) => match.id && match.title);
      this.matchesCache.set(endpoint, {
        value: matches,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, matches);
      await this.writeSharedCache(`matches:${endpoint}`, matches, CACHE_TTL_MS).catch(() => {});
      return matches;
    } catch (error) {
      this.logger.warn?.('streamed matches load failed', {
        catalog: catalog?.id,
        error: error?.message || String(error)
      });
      const fallback = cached?.value || [];
      this.indexMatches(catalog, fallback);
      return fallback;
    }
  }

  indexMatches(catalog, matches = []) {
    const catalogId = toString(catalog?.id);
    if (catalogId) this.catalogMatchIndex.set(catalogId, Date.now());
    for (const match of Array.isArray(matches) ? matches : []) {
      if (!match?.sourceId) continue;
      this.matchIndex.set(match.sourceId, match);
      this.matchIndex.set(match.id, match);
    }
    if (this.matchIndex.size > 5000) {
      this.matchIndex = new Map([...this.matchIndex.entries()].slice(-3500));
    }
  }

  prewarmCatalogs(catalogs = []) {
    for (const catalog of catalogs.slice(0, 6)) {
      const endpoint = toString(catalog?.endpoint);
      if (!endpoint || this.matchesCache.has(endpoint)) continue;
      this.loadMatches(catalog).catch((error) => {
        this.logger.warn?.('streamed catalog prewarm failed', {
          catalog: catalog?.id,
          error: error?.message || String(error)
        });
      });
    }
  }

  toMatch(entry) {
    const sourceId = toString(entry?.id);
    const title = toString(entry?.title);
    const category = normalizeIdPart(entry?.category);
    const sources = (Array.isArray(entry?.sources) ? entry.sources : [])
      .map((source) => ({
        source: normalizeIdPart(source?.source),
        id: toString(source?.id)
      }))
      .filter((source) => source.source && source.id);
    if (!sourceId || !title || sources.length === 0) return null;

    const poster = toAbsoluteStreamedUrl(entry?.poster);
    const home = entry?.teams?.home?.name ? toString(entry.teams.home.name) : '';
    const away = entry?.teams?.away?.name ? toString(entry.teams.away.name) : '';
    return {
      id: `streamed:${encodeURIComponent(sourceId)}`,
      sourceId,
      type: 'tv',
      title,
      category,
      date: Number(entry?.date || 0),
      poster: isHttpUrl(poster) ? poster : null,
      popular: Boolean(entry?.popular),
      sources,
      teams: [home, away].filter(Boolean),
      normalizedTitle: normalizeTitle(`${title} ${category} ${home} ${away}`)
    };
  }

  toEventMeta(match) {
    const isWorldCupFootball = /\bworld\s+cup\b/iu.test(`${match.title} ${match.category}`)
      && /\b(?:fifa|football|soccer)\b/iu.test(`${match.title} ${match.category}`);
    return {
      id: match.id,
      type: 'tv',
      name: match.title,
      poster: match.poster || undefined,
      logo: match.poster || undefined,
      posterShape: 'landscape',
      genres: [...new Set(['Sports', match.category].filter(Boolean))],
      tournament: isWorldCupFootball ? 'FIFA World Cup' : undefined,
      competition: isWorldCupFootball ? 'FIFA World Cup' : undefined,
      releaseInfo: formatEventTime(match.date),
      runtime: 'Live',
      description: [
        'Streamed sports event',
        `Category: ${match.category}`,
        `Time: ${formatEventTime(match.date)}`,
        match.teams.length ? `Teams: ${match.teams.join(' vs ')}` : '',
        match.popular ? 'Popular event' : ''
      ].filter(Boolean).join('\n')
    };
  }

  async getEventCatalog({ catalog = {}, search = '', skip = 0, limit = EVENT_CATALOG_LIMIT, signal = null } = {}) {
    const needle = normalizeTitle(search);
    const matches = await this.loadMatches(catalog, signal);
    return matches
      .filter((match) => !needle || match.normalizedTitle.includes(needle))
      .sort((left, right) => {
        const liveScore = Number(right.popular) - Number(left.popular);
        if (liveScore !== 0) return liveScore;
        return Number(left.date || 0) - Number(right.date || 0);
      })
      .slice(Math.max(0, Number(skip) || 0))
      .slice(0, limit)
      .map((match) => this.toEventMeta(match));
  }

  async findMatch(id, signal = null) {
    const sourceId = decodeURIComponent(toString(id).replace(/^streamed:/u, ''));
    if (!sourceId) return null;

    const indexed = this.matchIndex.get(sourceId) || this.matchIndex.get(`streamed:${encodeURIComponent(sourceId)}`);
    if (indexed) return indexed;

    const baseCatalogs = this.getEventCatalogDefinitions();
    for (const catalog of baseCatalogs) {
      const matches = await this.loadMatches(catalog, signal);
      const match = matches.find((entry) => entry.sourceId === sourceId);
      if (match) return match;
    }

    const sports = await this.getSports(signal);
    const catalogs = this.getEventCatalogDefinitions(sports)
      .filter((catalog) => !baseCatalogs.some((baseCatalog) => baseCatalog.id === catalog.id));
    for (const catalog of catalogs) {
      const matches = await this.loadMatches(catalog, signal);
      const match = matches.find((entry) => entry.sourceId === sourceId);
      if (match) return match;
    }
    return null;
  }

  async getEventMeta(id, signal = null) {
    const match = await this.findMatch(id, signal);
    return match ? this.toEventMeta(match) : null;
  }

  async getSourceStreams(source, signal = null) {
    const key = `${source.source}:${source.id}`;
    const cached = this.streamCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      const payload = await this.fetchJson(`/api/stream/${encodeURIComponent(source.source)}/${encodeURIComponent(source.id)}`, signal);
      const streams = (Array.isArray(payload) ? payload : [])
        .map((entry) => ({
          id: toString(entry?.id) || source.id,
          streamNo: Number(entry?.streamNo || 1),
          language: toString(entry?.language),
          hd: Boolean(entry?.hd),
          embedUrl: toString(entry?.embedUrl),
          source: toString(entry?.source) || source.source,
          viewers: Number(entry?.viewers || 0)
        }))
        .filter((stream) => isHttpUrl(stream.embedUrl));
      this.streamCache.set(key, {
        value: streams,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      return streams;
    } catch (error) {
      this.logger.warn?.('streamed event stream load failed', {
        source: source.source,
        error: error?.message || String(error)
      });
      return cached?.value || [];
    }
  }

  getPrivateStreamUrl(stream, { baseUrl = '', privateConfigId = '' } = {}) {
    if (!baseUrl || !privateConfigId) return null;
    const normalizedBase = String(baseUrl).replace(/\/+$/u, '');
    return `${normalizedBase}/private/${encodeURIComponent(privateConfigId)}/streamed/${encodeURIComponent(stream.source)}/${encodeURIComponent(stream.id)}/${encodeURIComponent(String(stream.streamNo || 1))}.m3u8`;
  }

  async getEventEmbedStreams(id, options = null) {
    const signal = options && typeof options === 'object' && 'signal' in options
      ? options.signal
      : options || null;
    const match = await this.findMatch(id, signal);
    if (!match) return { match: null, streams: [] };

    const settled = await Promise.allSettled(match.sources.map((source) => this.getSourceStreams(source, signal)));
    const streams = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .sort((left, right) => {
        const leftRank = STREAM_SOURCE_RANK.get(normalizeIdPart(left.source)) ?? 5;
        const rightRank = STREAM_SOURCE_RANK.get(normalizeIdPart(right.source)) ?? 5;
        return leftRank - rightRank
          || Number(right.hd) - Number(left.hd)
          || Number(right.viewers || 0) - Number(left.viewers || 0);
      })
      .map((stream) => ({
        id: `${stream.source}:${stream.id}:${stream.streamNo || 1}`,
        source: stream.source,
        streamId: stream.id,
        streamNo: Number(stream.streamNo || 1),
        language: stream.language,
        hd: Boolean(stream.hd),
        viewers: Number(stream.viewers || 0),
        embedUrl: stream.embedUrl || this.getEmbedUrl({
          source: stream.source,
          streamId: stream.id,
          streamNo: stream.streamNo || 1
        })
      }))
      .filter((stream) => isHttpUrl(stream.embedUrl));

    return { match, streams };
  }

  async getEventStreams(id, options = null) {
    const signal = options && typeof options === 'object' && 'signal' in options
      ? options.signal
      : options || null;
    const baseUrl = options?.baseUrl || '';
    const privateConfigId = options?.privateConfigId || '';
    const match = await this.findMatch(id, signal);
    if (!match) return [];

    const settled = await Promise.allSettled(match.sources.map((source) => this.getSourceStreams(source, signal)));
    const streams = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .sort((left, right) => {
        const leftRank = STREAM_SOURCE_RANK.get(normalizeIdPart(left.source)) ?? 5;
        const rightRank = STREAM_SOURCE_RANK.get(normalizeIdPart(right.source)) ?? 5;
        return leftRank - rightRank
          || Number(right.hd) - Number(left.hd)
          || Number(right.viewers || 0) - Number(left.viewers || 0);
      })
      .slice(0, 12);
    const playableHlsByKey = new Map();
    let displayStreams = streams;
    if (this.hlsProbeEnabled && !this.hlsBrowserFallbackEnabled && baseUrl && privateConfigId) {
      const playableSettled = await Promise.allSettled(streams.map(async (stream) => {
        const hls = await this.resolvePlayableHls({
          source: stream.source,
          streamId: stream.id,
          streamNo: stream.streamNo || 1,
          signal
        });
        return { stream, hls };
      }));
      displayStreams = playableSettled
        .filter((result) => result.status === 'fulfilled' && result.value?.hls?.url)
        .map((result) => {
          const { stream, hls } = result.value;
          playableHlsByKey.set(`${stream.source}:${stream.id}:${stream.streamNo || 1}`, hls);
          return stream;
        });
    }
    const cards = displayStreams.map((stream) => {
        const hls = playableHlsByKey.get(`${stream.source}:${stream.id}:${stream.streamNo || 1}`);
        const privateUrl = this.getPrivateStreamUrl(stream, { baseUrl, privateConfigId });
        const playbackUrl = privateUrl && hls?.url
          ? `${privateUrl}?url=${Buffer.from(hls.url).toString('base64url')}`
          : privateUrl;
        return {
          name: 'NebulaStreams Streamed',
          title: [
          match.title,
          'Sports Event',
          `${stream.source.toUpperCase()} #${stream.streamNo}${stream.hd ? ' HD' : ''}`,
          privateUrl ? 'Plays in Stremio' : 'Open external embed',
          stream.language || '',
          Number.isFinite(stream.viewers) && stream.viewers > 0 ? `${stream.viewers} viewers` : ''
        ].filter(Boolean).join('\n'),
          ...(playbackUrl ? { url: playbackUrl } : { externalUrl: stream.embedUrl }),
          behaviorHints: {
            ...(privateUrl ? {} : { notWebReady: true }),
            bingeGroup: `streamed-${match.normalizedTitle}`
          }
        };
      });
    if (baseUrl && privateConfigId && this.hlsCacheMs > 0) {
      this.prewarmStreams(streams.slice(0, 2), signal);
    }
    return cards;
  }

  getEmbedUrl({ source, streamId, streamNo }) {
    return `${EMBED_BASE}/embed/${encodeURIComponent(source)}/${encodeURIComponent(streamId)}/${encodeURIComponent(String(streamNo || 1))}`;
  }

  getCachedHls(cacheKey) {
    const cached = this.hlsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.hlsCache.delete(cacheKey);
    return null;
  }

  setCachedHls(cacheKey, value) {
    if (!this.hlsCacheMs || !value) return;
    this.hlsCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + this.hlsCacheMs
    });
  }

  async getSharedHls(cacheKey) {
    const value = await this.readSharedCache(`hls:${cacheKey}`);
    return value?.url ? value : null;
  }

  async setSharedHls(cacheKey, value) {
    if (!this.hlsCacheMs || !value?.url) return;
    await this.writeSharedCache(`hls:${cacheKey}`, value, this.hlsCacheMs).catch(() => {});
  }

  getCachedPlaylist(url) {
    const cached = this.playlistCache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    if (cached) this.playlistCache.delete(url);
    return null;
  }

  setCachedPlaylist(url, value) {
    if (!url || !value?.body) return;
    this.playlistCache.set(url, {
      value,
      expiresAt: Date.now() + DEFAULT_PLAYLIST_CACHE_MS
    });
  }

  async getSharedPlaylist(url) {
    const value = await this.readSharedCache(`playlist:${url}`, { consume: true });
    if (!value?.bodyBase64) return null;
    return {
      status: value.status || 200,
      url: value.url || url,
      headers: value.headers || {},
      body: Buffer.from(value.bodyBase64, 'base64')
    };
  }

  async setSharedPlaylist(url, value) {
    if (!url || !value?.body) return;
    await this.writeSharedCache(`playlist:${url}`, {
      status: value.status || 200,
      url: value.url || url,
      headers: value.headers || {},
      bodyBase64: Buffer.from(value.body).toString('base64')
    }, DEFAULT_PLAYLIST_CACHE_MS).catch(() => {});
  }

  async handleMemoryPressure({ critical = false } = {}) {
    this.matchesCache.clear();
    this.streamCache.clear();
    this.hlsCache.clear();
    this.playlistCache.clear();
    this.browserFetchInFlight.clear();
    this.hlsResolveInFlight.clear();
    this.playlistPrewarmInFlight.clear();
    if (!critical) {
      await Promise.allSettled([
        this.closeBrowserFetchPage('memory pressure'),
        this.closeHlsResolvePage('memory pressure')
      ]).then((settled) => {
        for (const result of settled) {
          if (result.status === 'rejected') {
            this.logger.warn?.('streamed sports browser page memory cleanup failed', {
              error: result.reason?.message || String(result.reason)
            });
          }
        }
      });
      return;
    }
    await this.closeBrowser('memory pressure').catch((error) => {
      this.logger.warn?.('streamed sports browser memory cleanup failed', {
        error: error?.message || String(error)
      });
    });
  }

  async ensureCacheDir() {
    if (!this.cacheDirReady) {
      this.cacheDirReady = fs.mkdir(this.cacheDir, { recursive: true });
    }
    await this.cacheDirReady;
  }

  getCachePath(key) {
    const hash = createHash('sha1').update(String(key)).digest('hex');
    return path.join(this.cacheDir, `${hash}.json`);
  }

  async readSharedCache(key, { consume = false } = {}) {
    const filePath = this.getCachePath(key);
    try {
      const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!payload?.expiresAt || payload.expiresAt <= Date.now()) {
        await fs.rm(filePath, { force: true }).catch(() => {});
        return null;
      }
      if (consume) {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
      return payload.value || null;
    } catch {
      return null;
    }
  }

  async writeSharedCache(key, value, ttlMs) {
    if (!ttlMs || !value) return;
    await this.ensureCacheDir();
    const filePath = this.getCachePath(key);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify({
      expiresAt: Date.now() + ttlMs,
      value
    }), { mode: 0o600 });
    await fs.rename(tempPath, filePath);
  }

  prewarmStreams(streams = [], signal = null) {
    if (!this.canPrewarmBrowser()) return;
    for (const stream of streams) {
      if (!this.canPrewarmBrowser()) break;
      const key = `${stream.source}:${stream.id}:${stream.streamNo || 1}`;
      if (this.playlistPrewarmInFlight.has(key)) continue;
      const task = this.resolvePlayableHls({
        source: stream.source,
        streamId: stream.id,
        streamNo: stream.streamNo || 1,
        signal
      })
        .catch((error) => {
          this.logger.warn?.('streamed sports prewarm failed', {
            source: stream.source,
            streamNo: stream.streamNo,
            error: error?.message || String(error)
          });
        })
        .finally(() => {
          this.playlistPrewarmInFlight.delete(key);
        });
      this.playlistPrewarmInFlight.set(key, task);
    }
  }

  prewarmPlaylist(url, { delayMs = 0 } = {}) {
    const normalizedUrl = toString(url);
    if (!/\.m3u8(?:$|[?#])/iu.test(normalizedUrl)) return;
    if (!this.canPrewarmBrowser()) return;

    const key = `playlist:${normalizedUrl}`;
    if (this.playlistPrewarmInFlight.has(key)) return;
    const waitMs = Math.max(0, Math.min(10_000, Number(delayMs) || 0));
    const task = new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    })
      .then(() => this.browserFetchBytes(normalizedUrl, { cachePlaylist: true }))
      .catch((error) => {
        this.logger.warn?.('streamed sports playlist prewarm failed', {
          error: error?.message || String(error)
        });
      })
      .finally(() => {
        this.playlistPrewarmInFlight.delete(key);
    });
    this.playlistPrewarmInFlight.set(key, task);
  }

  findIndexedMatchBySource(sourceName, streamId) {
    const normalizedSource = normalizeIdPart(sourceName);
    const normalizedStreamId = toString(streamId);
    if (!normalizedSource || !normalizedStreamId) return null;
    const uniqueMatches = new Set(this.matchIndex.values());
    for (const match of uniqueMatches) {
      if (!Array.isArray(match?.sources)) continue;
      if (match.sources.some((source) => source.source === normalizedSource && source.id === normalizedStreamId)) {
        return match;
      }
    }
    return null;
  }

  async findMatchBySource(sourceName, streamId, signal = null) {
    const indexed = this.findIndexedMatchBySource(sourceName, streamId);
    if (indexed) return indexed;
    const sports = await this.getSports(signal);
    const catalogs = this.getEventCatalogDefinitions(sports);
    for (const catalog of catalogs) {
      const matches = await this.loadMatches(catalog, signal);
      const match = matches.find((entry) =>
        Array.isArray(entry?.sources)
        && entry.sources.some((source) => source.source === normalizeIdPart(sourceName) && source.id === toString(streamId)));
      if (match) return match;
    }
    return null;
  }

  async resolveFallbackPlayableHls({ source, streamId, streamNo = 1, signal = null, limit = 1 } = {}) {
    const match = await this.findMatchBySource(source, streamId, signal);
    if (!match) return null;
    const settled = await Promise.allSettled(match.sources.map((candidateSource) => this.getSourceStreams(candidateSource, signal)));
    const candidates = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter((stream) => !(normalizeIdPart(stream.source) === normalizeIdPart(source) && toString(stream.id) === toString(streamId)))
      .sort((left, right) => {
        const leftRank = STREAM_SOURCE_RANK.get(normalizeIdPart(left.source)) ?? 5;
        const rightRank = STREAM_SOURCE_RANK.get(normalizeIdPart(right.source)) ?? 5;
        const leftSameStreamNo = Number(left.streamNo || 1) === Number(streamNo || 1) ? 0 : 1;
        const rightSameStreamNo = Number(right.streamNo || 1) === Number(streamNo || 1) ? 0 : 1;
        return leftSameStreamNo - rightSameStreamNo
          || leftRank - rightRank
          || Number(right.hd) - Number(left.hd)
          || Number(right.viewers || 0) - Number(left.viewers || 0);
      })
      .slice(0, Math.max(1, Math.min(4, Number(limit) || 1)));

    for (const candidate of candidates) {
      try {
        const hls = await this.resolvePlayableHls({
          source: candidate.source,
          streamId: candidate.id,
          streamNo: candidate.streamNo || 1,
          signal
        });
        return {
          ...hls,
          fallback: {
            source: candidate.source,
            streamId: candidate.id,
            streamNo: candidate.streamNo || 1
          }
        };
      } catch (error) {
        this.logger.warn?.('streamed sports fallback hls failed', {
          source: candidate.source,
          streamNo: candidate.streamNo,
          error: error?.message || String(error)
        });
      }
    }
    return null;
  }

  canPrewarmBrowser() {
    return freemem() >= MIN_BROWSER_PREWARM_FREE_BYTES
      && this.playlistPrewarmInFlight.size < MAX_BROWSER_PREWARM_IN_FLIGHT;
  }

  async resolvePlayableHls({ source, streamId, streamNo = 1, signal = null } = {}) {
    const normalizedSource = normalizeIdPart(source);
    const normalizedStreamId = toString(streamId);
    const normalizedStreamNo = toString(streamNo || 1);
    if (!normalizedSource || !normalizedStreamId) {
      throw new Error('Invalid Streamed sports stream id');
    }

    const cacheKey = `${normalizedSource}:${normalizedStreamId}:${normalizedStreamNo}`;
    const cached = this.getCachedHls(cacheKey);
    if (cached) {
      await this.setSharedHls(cacheKey, cached);
      return cached;
    }
    if (this.hlsCacheMs > 0) {
      const sharedCached = await this.getSharedHls(cacheKey);
      if (sharedCached) {
        this.setCachedHls(cacheKey, sharedCached);
        return sharedCached;
      }
    }

    const embedUrl = this.getEmbedUrl({
      source: normalizedSource,
      streamId: normalizedStreamId,
      streamNo: normalizedStreamNo
    });
    if (this.hlsResolveInFlight.has(cacheKey)) {
      return this.hlsResolveInFlight.get(cacheKey);
    }

    const task = this.resolvePlayableHlsFresh({
      cacheKey,
      embedUrl,
      normalizedSource,
      normalizedStreamNo,
      signal
    });
    this.hlsResolveInFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      if (this.hlsResolveInFlight.get(cacheKey) === task) {
        this.hlsResolveInFlight.delete(cacheKey);
      }
    }
  }

  async resolvePlayableHlsFresh({ cacheKey, embedUrl, normalizedSource, normalizedStreamNo, signal = null }) {
    const probed = await this.resolvePlayableHlsWithProbe(embedUrl, signal);
    if (probed?.url) {
      const value = {
        url: probed.url,
        headers: {
          ...this.getBrowserFetchHeaders(),
          origin: 'https://exposestrat.com',
          referer: 'https://exposestrat.com/maestrohd1.php'
        }
      };
      this.setCachedHls(cacheKey, value);
      await this.setSharedHls(cacheKey, value);
      return value;
    }
    if (this.hlsProbeEnabled && !this.hlsBrowserFallbackEnabled) {
      throw new Error('Streamed HLS probe found no playable source');
    }

    const hlsUrl = await this.resolvePlayableHlsInBrowser(embedUrl, {
      source: normalizedSource,
      streamNo: normalizedStreamNo,
      signal
    });
    const value = {
      url: hlsUrl,
      headers: this.getBrowserFetchHeaders()
    };
    this.setCachedHls(cacheKey, value);
    await this.setSharedHls(cacheKey, value);
    return value;
  }

  async resolvePlayableHlsInBrowser(embedUrl, { source = '', streamNo = '', signal = null } = {}) {
    const runResolve = async (attempt = 1) => {
      let timeout = null;
      let abortHandler = null;
      let requestHandler = null;
      let page = null;
      this.activeBrowserPages += 1;
      try {
        page = await this.getHlsResolvePage();
        this.hlsResolvePageUses += 1;
        let settled = false;
        const hlsPromise = new Promise((resolve, reject) => {
          const fail = (error) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            reject(error);
          };
          timeout = setTimeout(() => {
            fail(new Error('Streamed HLS resolve timeout'));
          }, this.browserTimeoutMs);
          if (signal) {
            abortHandler = () => fail(signal.reason || new Error('Streamed HLS resolve aborted'));
            signal.addEventListener('abort', abortHandler, { once: true });
          }
          requestHandler = (request) => {
            const url = request.url();
            if (/\.m3u8(?:$|[?#])/iu.test(url) && /strmd\.st/iu.test(url)) {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              resolve(url);
            }
          };
          page.on('request', requestHandler);
        });
        void page.goto(embedUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.browserTimeoutMs
        }).catch((error) => {
          if (settled) return;
          this.logger.warn?.('streamed sports embed navigation failed', {
            source,
            streamNo,
            error: error?.message || String(error)
          });
        });
        const hlsUrl = await hlsPromise;
        if (this.hlsResolvePageUses >= 40) {
          void this.closeHlsResolvePage('hls resolve recycle');
        }
        return hlsUrl;
      } catch (error) {
        const message = error?.message || String(error);
        if (attempt < 2 && !signal?.aborted && /INSUFFICIENT_RESOURCES|Target closed|Session closed/iu.test(message)) {
          await this.closeHlsResolvePage('hls resolve failure');
          return runResolve(attempt + 1);
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
        if (page && requestHandler) {
          page.off?.('request', requestHandler);
        }
        this.activeBrowserPages = Math.max(0, this.activeBrowserPages - 1);
        this.scheduleBrowserIdleClose();
        if (signal?.aborted) throw signal.reason || new Error('Streamed HLS resolve aborted');
      }
    };

    const task = this.hlsResolveChain.catch(() => {}).then(() => runResolve());
    this.hlsResolveChain = task.catch(() => {});
    return task;
  }

  getBrowserFetchHeaders() {
    return {
      accept: '*/*',
      origin: EMBED_BASE,
      referer: `${EMBED_BASE}/`,
      'user-agent': BROWSER_USER_AGENT
    };
  }

  async resolvePlayableHlsWithProbe(embedUrl, signal = null) {
    if (!this.hlsProbeEnabled) return null;
    if (Date.now() < this.hlsProbeDisabledUntil || signal?.aborted) return null;
    try {
      const probeSignal = signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, AbortSignal.timeout(HLS_PROBE_TIMEOUT_MS)])
        : AbortSignal.timeout(HLS_PROBE_TIMEOUT_MS);
      const { stdout } = await execFileAsync('python3', [
        HLS_PROBE_SCRIPT,
        '--url',
        embedUrl,
        '--timeout',
        String(Math.max(1, Math.ceil(HLS_PROBE_TIMEOUT_MS / 1000)))
      ], {
        timeout: HLS_PROBE_TIMEOUT_MS + 500,
        maxBuffer: 256 * 1024,
        signal: probeSignal
      });
      const payload = JSON.parse(String(stdout || '{}'));
      if (payload?.url && /^https?:\/\/[^"\s]+\.m3u8(?:$|[?#])/iu.test(payload.url)) {
        this.hlsProbeFailures = 0;
        return { url: payload.url };
      }
    } catch (error) {
      const message = error?.message || String(error);
      if (!/no hls found|exit code 2|SIGTERM|ABORT_ERR|operation was aborted/iu.test(message)) {
        this.logger.debug?.('streamed sports python hls probe failed', { error: message });
      }
    }

    this.hlsProbeFailures += 1;
    if (this.hlsProbeFailures >= 3) {
      this.hlsProbeDisabledUntil = Date.now() + HLS_PROBE_DISABLE_MS;
      this.hlsProbeFailures = 0;
    }
    return null;
  }

  async closeHlsResolvePage(reason = 'manual') {
    const pagePromise = this.hlsResolvePagePromise;
    this.hlsResolvePagePromise = null;
    this.hlsResolvePageUses = 0;
    if (!pagePromise) return;
    try {
      const page = await pagePromise;
      if (page && !page.isClosed?.()) {
        await page.close();
      }
      this.logger.debug?.('streamed sports hls resolve page closed', { reason });
    } catch (error) {
      this.logger.warn?.('streamed sports hls resolve page close failed', {
        reason,
        error: error?.message || String(error)
      });
    }
  }

  async getHlsResolvePage() {
    if (!this.hlsResolvePagePromise) {
      this.hlsResolvePagePromise = this.getBrowser()
        .then(async (browser) => {
          const page = await browser.newPage();
          await page.setUserAgent(BROWSER_USER_AGENT);
          page.on('close', () => {
            this.hlsResolvePagePromise = null;
            this.hlsResolvePageUses = 0;
          });
          this.hlsResolvePageUses = 0;
          return page;
        })
        .catch((error) => {
          this.hlsResolvePagePromise = null;
          throw error;
        });
    }
    return this.hlsResolvePagePromise;
  }

  async browserFetchBytes(url, { signal = null, cachePlaylist = false } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('Streamed browser fetch aborted');
    const isPlaylistUrl = /\.m3u8(?:$|[?#])/iu.test(String(url || ''));
    const canUsePlaylistCache = isPlaylistUrl;
    const cachedPlaylist = canUsePlaylistCache ? this.getCachedPlaylist(url) : null;
    if (cachedPlaylist) {
      return cachedPlaylist;
    }
    const sharedPlaylist = canUsePlaylistCache ? await this.getSharedPlaylist(url) : null;
    if (sharedPlaylist) {
      return sharedPlaylist;
    }
    const inFlightKey = isPlaylistUrl ? `playlist:${url}` : null;
    if (inFlightKey && this.browserFetchInFlight.has(inFlightKey)) {
      return this.browserFetchInFlight.get(inFlightKey);
    }

    const runFetch = async (attempt = 1) => {
      let timeout = null;
      let abortHandler = null;
      try {
        const page = await this.getBrowserFetchPage();
        this.browserFetchPageUses += 1;
        const result = await Promise.race([
          page.evaluate(async (targetUrl) => {
            const response = await fetch(targetUrl, {
              headers: { accept: '*/*' },
              cache: 'no-store'
            });
            const headers = {};
            response.headers.forEach((value, key) => {
              headers[key] = value;
            });
            const body = Array.from(new Uint8Array(await response.arrayBuffer()));
            return {
              ok: response.ok,
              status: response.status,
              url: response.url,
              headers,
              body
            };
          }, url),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Streamed browser fetch timeout')), this.browserTimeoutMs);
            if (signal) {
              abortHandler = () => reject(signal.reason || new Error('Streamed browser fetch aborted'));
              signal.addEventListener('abort', abortHandler, { once: true });
            }
          })
        ]);
        if (!result?.ok) {
          throw new Error(`Streamed browser fetch HTTP ${result?.status || 0}`);
        }
        const fetched = {
          status: result.status,
          url: result.url || url,
          headers: result.headers || {},
          body: Buffer.from(result.body || [])
        };
        const contentType = String(fetched.headers['content-type'] || '').toLowerCase();
        if (canUsePlaylistCache && (cachePlaylist || contentType.includes('mpegurl') || contentType.includes('m3u8') || /\.m3u8(?:$|[?#])/iu.test(fetched.url))) {
          this.setCachedPlaylist(url, fetched);
          if (cachePlaylist) {
            await this.setSharedPlaylist(url, fetched);
          }
        }
        if (isPlaylistUrl && this.browserFetchPageUses >= 80) {
          void this.closeBrowserFetchPage('playlist fetch recycle');
        }
        return fetched;
      } catch (error) {
        if (isPlaylistUrl && attempt < 2 && !signal?.aborted) {
          await this.closeBrowserFetchPage('playlist fetch failure');
          return runFetch(attempt + 1);
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    };

    const task = isPlaylistUrl
      ? runFetch()
      : this.browserFetchChain.catch(() => {}).then(runFetch);
    if (inFlightKey) {
      this.browserFetchInFlight.set(inFlightKey, task);
    } else {
      this.browserFetchChain = task.catch(() => {});
    }

    try {
      return await task;
    } finally {
      if (inFlightKey && this.browserFetchInFlight.get(inFlightKey) === task) {
        this.browserFetchInFlight.delete(inFlightKey);
      }
      this.scheduleBrowserIdleClose();
      if (signal?.aborted) throw signal.reason || new Error('Streamed browser fetch aborted');
    }
  }

  async closeBrowserFetchPage(reason = 'manual') {
    const pagePromise = this.browserFetchPagePromise;
    this.browserFetchPagePromise = null;
    this.browserFetchPageUses = 0;
    if (!pagePromise) return;
    try {
      const page = await pagePromise;
      if (page && !page.isClosed?.()) {
        await page.close();
      }
      this.logger.debug?.('streamed sports browser fetch page closed', { reason });
    } catch (error) {
      this.logger.warn?.('streamed sports browser fetch page close failed', {
        reason,
        error: error?.message || String(error)
      });
    }
  }

  async getBrowserFetchPage() {
    if (!this.browserFetchPagePromise) {
      this.browserFetchPagePromise = this.getBrowser()
        .then(async (browser) => {
          const page = await browser.newPage();
          await page.setUserAgent(BROWSER_USER_AGENT);
          await page.setExtraHTTPHeaders({
            referer: `${EMBED_BASE}/`,
            origin: EMBED_BASE,
            accept: '*/*'
          });
          await page.goto(`${EMBED_BASE}/`, { waitUntil: 'domcontentloaded', timeout: this.browserTimeoutMs }).catch(() => {});
          page.on('close', () => {
            this.browserFetchPagePromise = null;
            this.browserFetchPageUses = 0;
          });
          this.browserFetchPageUses = 0;
          return page;
        })
        .catch((error) => {
          this.browserFetchPagePromise = null;
          throw error;
        });
    }
    return this.browserFetchPagePromise;
  }

  async getBrowser() {
    if (!this.chromePath) {
      throw new Error('STREAMED_SPORTS_CHROME_PATH is not configured');
    }
    if (this.browserIdleTimer) {
      clearTimeout(this.browserIdleTimer);
      this.browserIdleTimer = null;
    }
    if (!this.browserPromise) {
      this.browserPromise = import('puppeteer-core')
        .then(({ default: puppeteer }) => puppeteer.launch({
          executablePath: this.chromePath,
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-client-side-phishing-detection',
            '--disable-extensions',
            '--disable-features=Translate,BackForwardCache,AcceptCHFrame',
            '--disable-sync',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-first-run',
            '--no-default-browser-check',
            '--autoplay-policy=no-user-gesture-required'
          ]
        }))
        .catch((error) => {
          this.browserPromise = null;
          throw error;
        });
    }
    return this.browserPromise;
  }

  scheduleBrowserIdleClose() {
    if (!this.browserPromise || this.activeBrowserPages > 0 || this.browserIdleTimer) return;
    this.browserIdleTimer = setTimeout(async () => {
      if (this.activeBrowserPages > 0) return;
      await this.closeBrowser('idle').catch((error) => {
        this.logger.warn?.('streamed sports browser idle close failed', {
          error: error?.message || String(error)
        });
      });
    }, this.browserIdleMs);
    this.browserIdleTimer.unref?.();
  }

  async closeBrowser(reason = 'manual') {
    if (this.browserIdleTimer) {
      clearTimeout(this.browserIdleTimer);
      this.browserIdleTimer = null;
    }
    const browserPromise = this.browserPromise;
    const fetchPagePromise = this.browserFetchPagePromise;
    const hlsPagePromise = this.hlsResolvePagePromise;
    this.browserPromise = null;
    this.browserFetchPagePromise = null;
    this.browserFetchPageUses = 0;
    this.hlsResolvePagePromise = null;
    this.hlsResolvePageUses = 0;
    this.browserFetchChain = Promise.resolve();
    this.hlsResolveChain = Promise.resolve();
    this.browserFetchInFlight.clear();
    this.hlsResolveInFlight.clear();
    if (fetchPagePromise) {
      const page = await fetchPagePromise;
      await page.close().catch(() => {});
    }
    if (hlsPagePromise) {
      const page = await hlsPagePromise;
      await page.close().catch(() => {});
    }
    if (browserPromise) {
      const browser = await browserPromise;
      await browser.close();
      this.logger.info?.('streamed sports browser closed', { reason });
    }
  }
}
