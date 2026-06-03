import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const CACHE_TTL_MS = 10 * 60 * 1000;
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const SERIES_INFO_CACHE_TTL_MS = 30 * 60 * 1000;
const EPG_CACHE_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const CATALOG_LIMIT = 50;
const MIN_REQUEST_INTERVAL_MS = 150;

/**
 * @typedef {Object} XtreamCredentials
 * @property {string} serverUrl
 * @property {string} username
 * @property {string} password
 */

/**
 * @typedef {Object} XtreamAuthResponse
 * @property {{ username?: string, status?: string, auth?: number|string, exp_date?: string, is_trial?: string }} [user_info]
 * @property {{ url?: string, port?: string, https_port?: string, server_protocol?: string }} [server_info]
 */

/**
 * @typedef {Object} XtreamCategory
 * @property {string|number} category_id
 * @property {string} category_name
 * @property {number|string} [parent_id]
 */

/**
 * @typedef {Object} XtreamLiveStream
 * @property {string|number} stream_id
 * @property {string} name
 * @property {string} [stream_icon]
 * @property {string|number} [category_id]
 * @property {string} [epg_channel_id]
 */

/**
 * @typedef {Object} XtreamVodStream
 * @property {string|number} stream_id
 * @property {string} name
 * @property {string} [stream_icon]
 * @property {string|number} [category_id]
 * @property {string} [container_extension]
 * @property {string|number} [rating]
 */

/**
 * @typedef {Object} XtreamSeries
 * @property {string|number} series_id
 * @property {string} name
 * @property {string} [cover]
 * @property {string|number} [category_id]
 * @property {string|number} [rating]
 */

const toString = (value) => String(value ?? '').trim();

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const hashKey = (value) => createHash('sha1').update(String(value)).digest('hex');

const normalizeServerUrl = (value) => {
  const raw = toString(value).replace(/\/+$/u, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    return '';
  }
};

const normalizeCredentials = (credentials = null) => ({
  serverUrl: normalizeServerUrl(credentials?.serverUrl),
  username: toString(credentials?.username),
  password: toString(credentials?.password)
});

export const hasXtreamCredentials = (credentials = null) => {
  const normalized = normalizeCredentials(credentials);
  return Boolean(normalized.serverUrl && normalized.username && normalized.password);
};

const isTemporaryStatus = (status) => status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

const decodeBase64Text = (value) => {
  const raw = toString(value);
  if (!raw) return '';
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return raw;
  }
};

export class XtreamCodesAdapter {
  constructor({ logger = console, fetchImpl = globalThis.fetch } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
    this.lastRequestAtByServer = new Map();
  }

  clear() {
    this.cache.clear();
    this.lastRequestAtByServer.clear();
  }

  sanitizeCredentials(credentials) {
    return normalizeCredentials(credentials);
  }

  getCredentialKey(credentials) {
    const normalized = normalizeCredentials(credentials);
    return hashKey(`${normalized.serverUrl}|${normalized.username}|${normalized.password}`);
  }

  buildApiUrl(credentials, action = '', extra = {}) {
    const normalized = normalizeCredentials(credentials);
    const url = new URL(`${normalized.serverUrl}/player_api.php`);
    url.searchParams.set('username', normalized.username);
    url.searchParams.set('password', normalized.password);
    if (action) url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null && String(value) !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  buildStreamTarget(credentials, kind, streamId, extension = '') {
    const normalized = normalizeCredentials(credentials);
    const safeKind = kind === 'live' ? 'live' : kind === 'series' ? 'series' : 'movie';
    const safeExtension = toString(extension).replace(/[^a-z0-9]/giu, '') || (safeKind === 'live' ? 'm3u8' : 'mp4');
    const encodedUser = encodeURIComponent(normalized.username);
    const encodedPassword = encodeURIComponent(normalized.password);
    return `${normalized.serverUrl}/${safeKind}/${encodedUser}/${encodedPassword}/${encodeURIComponent(String(streamId))}.${safeExtension}`;
  }

  buildPrivateStreamUrl({ baseUrl, privateConfigId, kind, streamId, extension = '' }) {
    const safeExtension = toString(extension).replace(/[^a-z0-9]/giu, '') || (kind === 'live' ? 'm3u8' : 'mp4');
    return `${String(baseUrl || '').replace(/\/+$/u, '')}/private/${encodeURIComponent(privateConfigId)}/xtream/${kind}/${encodeURIComponent(String(streamId))}.${safeExtension}`;
  }

  async rateLimit(credentials) {
    const normalized = normalizeCredentials(credentials);
    const key = normalized.serverUrl;
    const last = this.lastRequestAtByServer.get(key) || 0;
    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - last));
    if (waitMs > 0) await sleep(waitMs);
    this.lastRequestAtByServer.set(key, Date.now());
  }

  async requestJson(credentials, action = '', extra = {}, { ttlMs = CACHE_TTL_MS, signal = null } = {}) {
    const normalized = normalizeCredentials(credentials);
    if (!hasXtreamCredentials(normalized)) {
      throw new Error('Xtream credentials missing');
    }

    const cacheKey = `${this.getCredentialKey(normalized)}:${action || 'auth'}:${JSON.stringify(extra || {})}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Xtream request timeout')), REQUEST_TIMEOUT_MS);
      timeout.unref?.();

      try {
        await this.rateLimit(normalized);
        const response = await this.fetchImpl(this.buildApiUrl(normalized, action, extra), {
          signal: signal && AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          headers: {
            Accept: 'application/json,text/plain,*/*',
            'User-Agent': 'NebulaStreams/1.0 Xtream'
          }
        });

        if (!response.ok) {
          const error = new Error(`Xtream HTTP ${response.status}`);
          error.statusCode = response.status;
          throw error;
        }

        const text = await response.text();
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          throw new Error('Xtream malformed JSON response');
        }

        this.cache.set(cacheKey, {
          value,
          expiresAt: Date.now() + ttlMs
        });
        return value;
      } catch (error) {
        lastError = error;
        const statusCode = Number(error?.statusCode || 0);
        if (attempt >= 2 || (statusCode && !isTemporaryStatus(statusCode))) {
          break;
        }
        await sleep(250 * (2 ** attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError || new Error('Xtream request failed');
  }

  async authenticate(credentials, signal = null) {
    /** @type {XtreamAuthResponse} */
    const payload = await this.requestJson(credentials, '', {}, { ttlMs: AUTH_CACHE_TTL_MS, signal });
    const userInfo = payload?.user_info || {};
    const auth = userInfo.auth;
    const status = toString(userInfo.status).toLowerCase();
    if (auth === 0 || auth === '0' || status === 'disabled' || status === 'banned' || status === 'expired') {
      throw new Error('Xtream credentials invalid or inactive');
    }
    if (!payload || typeof payload !== 'object' || !payload.user_info) {
      throw new Error('Xtream authentication response missing user_info');
    }
    return payload;
  }

  async getCategories(credentials, kind, signal = null) {
    const action = kind === 'live' ? 'get_live_categories' : kind === 'vod' ? 'get_vod_categories' : 'get_series_categories';
    const categories = await this.requestJson(credentials, action, {}, { signal });
    return Array.isArray(categories) ? categories : [];
  }

  async getItems(credentials, kind, categoryId = null, signal = null) {
    const action = kind === 'live' ? 'get_live_streams' : kind === 'vod' ? 'get_vod_streams' : 'get_series';
    const extra = categoryId ? { category_id: categoryId } : {};
    const items = await this.requestJson(credentials, action, extra, { signal });
    return Array.isArray(items) ? items : [];
  }

  async getSeriesInfo(credentials, seriesId, signal = null) {
    return this.requestJson(credentials, 'get_series_info', { series_id: seriesId }, {
      ttlMs: SERIES_INFO_CACHE_TTL_MS,
      signal
    });
  }

  async getShortEpg(credentials, streamId, signal = null) {
    try {
      const payload = await this.requestJson(credentials, 'get_short_epg', { stream_id: streamId, limit: 4 }, {
        ttlMs: EPG_CACHE_TTL_MS,
        signal
      });
      return Array.isArray(payload?.epg_listings) ? payload.epg_listings : [];
    } catch {
      return [];
    }
  }

  toCatalogDefinitions(categoriesByKind) {
    const defs = [];
    for (const category of categoriesByKind.live || []) {
      defs.push({ type: 'tv', id: `xtream-live-${category.category_id}`, name: `IPTV: ${category.category_name}`, kind: 'live', categoryId: String(category.category_id) });
    }
    for (const category of categoriesByKind.vod || []) {
      defs.push({ type: 'movie', id: `xtream-vod-${category.category_id}`, name: `IPTV Movies: ${category.category_name}`, kind: 'vod', categoryId: String(category.category_id) });
    }
    for (const category of categoriesByKind.series || []) {
      defs.push({ type: 'series', id: `xtream-series-${category.category_id}`, name: `IPTV Series: ${category.category_name}`, kind: 'series', categoryId: String(category.category_id) });
    }
    return defs;
  }

  async getCatalogDefinitions(credentials, signal = null) {
    const [live, vod, series] = await Promise.all([
      this.getCategories(credentials, 'live', signal).catch(() => []),
      this.getCategories(credentials, 'vod', signal).catch(() => []),
      this.getCategories(credentials, 'series', signal).catch(() => [])
    ]);
    return this.toCatalogDefinitions({ live, vod, series });
  }

  getCompactCatalogDefinitions(categoriesByKind = {}, maxCategoryCatalogs = 40) {
    const definitions = [
      { type: 'tv', id: 'xtream-live-all', name: 'IPTV Live TV', kind: 'live', categoryId: null },
      { type: 'movie', id: 'xtream-vod-all', name: 'IPTV Movies', kind: 'vod', categoryId: null },
      { type: 'series', id: 'xtream-series-all', name: 'IPTV Series', kind: 'series', categoryId: null }
    ];
    const added = new Set(definitions.map((definition) => definition.id));
    const quotas = [
      ['live', Math.ceil(maxCategoryCatalogs * 0.5)],
      ['vod', Math.ceil(maxCategoryCatalogs * 0.25)],
      ['series', Math.max(0, maxCategoryCatalogs - Math.ceil(maxCategoryCatalogs * 0.5) - Math.ceil(maxCategoryCatalogs * 0.25))]
    ];

    for (const [kind, limit] of quotas) {
      const categories = Array.isArray(categoriesByKind[kind]) ? categoriesByKind[kind] : [];
      let count = 0;
      for (const category of categories) {
        if (count >= limit || definitions.length >= maxCategoryCatalogs + 3) break;
        const categoryId = toString(category.category_id);
        const categoryName = toString(category.category_name);
        if (!categoryId) continue;
        const id = `xtream-${kind}-${categoryId}`;
        if (added.has(id)) continue;
        definitions.push({
          type: kind === 'live' ? 'tv' : kind === 'vod' ? 'movie' : 'series',
          id,
          name: kind === 'live'
            ? `IPTV: ${categoryName || categoryId}`
            : kind === 'vod'
              ? `IPTV Movies: ${categoryName || categoryId}`
              : `IPTV Series: ${categoryName || categoryId}`,
          kind,
          categoryId
        });
        added.add(id);
        count += 1;
      }
    }

    return definitions;
  }

  parseCatalogId(catalogId) {
    const id = toString(catalogId);
    const match = id.match(/^xtream-(live|vod|series)-(.+)$/u);
    if (!match) return null;
    return {
      kind: match[1],
      categoryId: match[2] === 'all' ? null : match[2]
    };
  }

  inferTypeFromXtreamId(id) {
    const value = toString(id);
    if (value.startsWith('xtream:live:')) return 'tv';
    if (value.startsWith('xtream:vod:')) return 'movie';
    return 'series';
  }

  toMeta(item, kind) {
    if (kind === 'live') {
      return {
        id: `xtream:live:${item.stream_id}`,
        type: 'tv',
        name: item.name || `Live ${item.stream_id}`,
        poster: item.stream_icon || undefined,
        logo: item.stream_icon || undefined,
        posterShape: 'square',
        genres: ['Live TV'],
        releaseInfo: 'Live',
        runtime: 'Live',
        description: item.epg_channel_id ? `EPG: ${item.epg_channel_id}` : 'Xtream live channel'
      };
    }
    if (kind === 'vod') {
      return {
        id: `xtream:vod:${item.stream_id}`,
        type: 'movie',
        name: item.name || `Movie ${item.stream_id}`,
        poster: item.stream_icon || undefined,
        posterShape: 'poster',
        releaseInfo: item.year ? String(item.year) : undefined,
        imdbRating: item.rating ? String(item.rating) : undefined,
        description: item.plot || item.name || 'Xtream VOD'
      };
    }
    return {
      id: `xtream:series:${item.series_id}`,
      type: 'series',
      name: item.name || `Series ${item.series_id}`,
      poster: item.cover || undefined,
      posterShape: 'poster',
      imdbRating: item.rating ? String(item.rating) : undefined,
      description: item.plot || item.name || 'Xtream series'
    };
  }

  async getCatalog({ credentials, catalogId, search = '', skip = 0, limit = CATALOG_LIMIT, signal = null }) {
    const parsed = this.parseCatalogId(catalogId);
    if (!parsed) return [];
    const items = await this.getItems(credentials, parsed.kind, parsed.categoryId, signal);
    const needle = toString(search).toLowerCase();
    return items
      .filter((item) => !needle || toString(item.name).toLowerCase().includes(needle))
      .slice(Math.max(0, Number(skip) || 0))
      .slice(0, limit)
      .map((item) => this.toMeta(item, parsed.kind));
  }

  parseXtreamMetaId(id) {
    const parts = toString(id).split(':');
    if (parts[0] !== 'xtream') return null;
    if (parts[1] === 'live' || parts[1] === 'vod' || parts[1] === 'series') {
      return { kind: parts[1], id: parts[2] };
    }
    if (parts[1] === 'episode') {
      return { kind: 'episode', seriesId: parts[2], episodeId: parts[3], extension: parts[4] || 'mp4' };
    }
    return null;
  }

  async getMeta(credentials, id, signal = null) {
    const parsed = this.parseXtreamMetaId(id);
    if (!parsed) return null;
    if (parsed.kind === 'series') {
      const info = await this.getSeriesInfo(credentials, parsed.id, signal);
      const base = info?.info || {};
      const videos = [];
      const episodes = info?.episodes && typeof info.episodes === 'object' ? info.episodes : {};
      for (const [seasonKey, seasonEpisodes] of Object.entries(episodes)) {
        if (!Array.isArray(seasonEpisodes)) continue;
        for (const episode of seasonEpisodes) {
          const episodeId = episode.id || episode.episode_id;
          if (!episodeId) continue;
          videos.push({
            id: `xtream:episode:${parsed.id}:${episodeId}:${episode.container_extension || 'mp4'}`,
            title: episode.title || `S${seasonKey} E${episode.episode_num || videos.length + 1}`,
            season: Number.parseInt(seasonKey, 10) || undefined,
            episode: Number.parseInt(String(episode.episode_num || ''), 10) || undefined,
            released: episode.release_date || undefined
          });
        }
      }
      return {
        id,
        type: 'series',
        name: base.name || base.title || `Series ${parsed.id}`,
        poster: base.cover || base.movie_image || undefined,
        posterShape: 'poster',
        description: base.plot || base.description || 'Xtream series',
        genres: toString(base.genre).split(',').map((v) => v.trim()).filter(Boolean),
        videos
      };
    }

    if (parsed.kind === 'live') {
      const epg = await this.getShortEpg(credentials, parsed.id, signal);
      const current = epg[0];
      return {
        id,
        type: 'tv',
        name: current?.title ? decodeBase64Text(current.title) : `Live ${parsed.id}`,
        posterShape: 'square',
        description: current?.description ? decodeBase64Text(current.description) : 'Xtream live channel',
        releaseInfo: 'Live',
        runtime: 'Live'
      };
    }

    return {
      id,
      type: 'movie',
      name: `Movie ${parsed.id}`,
      posterShape: 'poster',
      description: 'Xtream VOD'
    };
  }

  async getStreams({ credentials, id, baseUrl, privateConfigId }) {
    const parsed = this.parseXtreamMetaId(id);
    if (!parsed) return [];
    if (parsed.kind === 'series') return [];

    const kind = parsed.kind === 'episode' ? 'series' : parsed.kind;
    const streamId = parsed.kind === 'episode' ? parsed.episodeId : parsed.id;
    const extension = parsed.kind === 'live' ? 'm3u8' : (parsed.extension || 'mp4');
    const url = this.buildPrivateStreamUrl({ baseUrl, privateConfigId, kind, streamId, extension });
    const name = kind === 'live' ? 'NebulaStreams IPTV' : 'NebulaStreams Xtream';
    return [{
      name,
      title: `${kind === 'live' ? 'Live TV' : kind === 'series' ? 'Series Episode' : 'VOD'}\nXtream Codes`,
      url,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `xtream:${kind}:${streamId}`
      }
    }];
  }

  getUpstreamStreamUrl(credentials, kind, streamId, extension = '') {
    return this.buildStreamTarget(credentials, kind, streamId, extension);
  }
}
