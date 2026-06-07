import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const CACHE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 8 * 60 * 1000;
const PROFILE_TTL_MS = 5 * 60 * 1000;
const EPG_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const CATALOG_LIMIT = 50;
const MIN_REQUEST_INTERVAL_MS = 180;
const MAG_USER_AGENT = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
const STB_TYPES = new Set(['MAG250', 'MAG254', 'MAG256', 'MAG270', 'MAG322', 'MAG324', 'MAG349', 'MAG351', 'MAG420']);

/**
 * @typedef {Object} StalkerCredentials
 * @property {string} portalUrl
 * @property {string} macAddress
 * @property {string} [stbType]
 * @property {string} [serialNumber]
 * @property {string} [deviceId]
 * @property {string} [deviceId2]
 */

/**
 * @typedef {Object} StalkerEnvelope
 * @property {Object|Array|null} [js]
 * @property {string|number} [status]
 * @property {string} [error]
 */

/**
 * @typedef {Object} StalkerHandshakeResponse
 * @property {string} [token]
 * @property {string} [random]
 */

/**
 * @typedef {Object} StalkerProfileResponse
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [stb_type]
 * @property {string} [account_number]
 */

/**
 * @typedef {Object} StalkerAccountInfoResponse
 * @property {string} [phone]
 * @property {string} [end_date]
 * @property {string} [tariff_plan]
 * @property {string} [account_balance]
 */

/**
 * @typedef {Object} StalkerCategory
 * @property {string|number} id
 * @property {string} title
 * @property {string|number} [alias]
 */

/**
 * @typedef {Object} StalkerChannel
 * @property {string|number} id
 * @property {string} name
 * @property {string} [number]
 * @property {string|number} [tv_genre_id]
 * @property {string} [cmd]
 * @property {string} [logo]
 * @property {string} [use_http_tmp_link]
 * @property {string|number} [status]
 */

const toString = (value) => String(value ?? '').trim();

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const hashKey = (value) => createHash('sha1').update(String(value)).digest('hex');

const normalizeMacAddress = (value) => {
  const hex = toString(value).toUpperCase().replace(/[^0-9A-F]/gu, '');
  if (hex.length !== 12) return '';
  return hex.match(/.{1,2}/gu).join(':');
};

const normalizeStbType = (value) => {
  const normalized = toString(value).toUpperCase().replace(/[^A-Z0-9]/gu, '');
  return STB_TYPES.has(normalized) ? normalized : 'MAG254';
};

const normalizeDeviceField = (value) => toString(value).replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 128);

const normalizePortalUrl = (value) => {
  const raw = toString(value).replace(/\/+$/u, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    return '';
  }
};

const normalizeCredentials = (credentials = null) => ({
  portalUrl: normalizePortalUrl(credentials?.portalUrl),
  macAddress: normalizeMacAddress(credentials?.macAddress),
  stbType: normalizeStbType(credentials?.stbType),
  serialNumber: normalizeDeviceField(credentials?.serialNumber),
  deviceId: normalizeDeviceField(credentials?.deviceId),
  deviceId2: normalizeDeviceField(credentials?.deviceId2)
});

export const hasStalkerCredentials = (credentials = null) => {
  const normalized = normalizeCredentials(credentials);
  return Boolean(normalized.portalUrl && normalized.macAddress);
};

const isTemporaryStatus = (status) => status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

const getEnvelopePayload = (payload) => {
  if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'js')) {
    return payload.js;
  }
  return payload;
};

const decodeMaybeBase64 = (value) => {
  const raw = toString(value);
  if (!raw) return '';
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return decoded || raw;
  } catch {
    return raw;
  }
};

const sanitizeCmd = (value) => toString(value).replace(/^(?:ffmpeg|ffrt3)\s*/iu, '').trim();

const absolutizeUrl = (value, baseUrl) => {
  const raw = sanitizeCmd(value);
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return raw;
  }
};

export class StalkerPortalAdapter {
  constructor({ logger = console, fetchImpl = globalThis.fetch } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
    this.tokenCache = new Map();
    this.channelCommandCache = new Map();
    this.lastRequestAtByPortal = new Map();
  }

  clear() {
    this.cache.clear();
    this.tokenCache.clear();
    this.channelCommandCache.clear();
    this.lastRequestAtByPortal.clear();
  }

  sanitizeCredentials(credentials) {
    return normalizeCredentials(credentials);
  }

  getCredentialKey(credentials) {
    const normalized = normalizeCredentials(credentials);
    return hashKey(JSON.stringify(normalized));
  }

  getPortalPaths(credentials) {
    const normalized = normalizeCredentials(credentials);
    const portal = new URL(normalized.portalUrl);
    const path = portal.pathname.replace(/\/+$/u, '');
    const basePath = path.endsWith('/c') ? path.slice(0, -2) : path;
    const api = new URL(portal.toString());
    api.pathname = `${basePath}/server/load.php`.replace(/\/+/gu, '/');
    api.search = '';
    api.hash = '';
    const referer = new URL(portal.toString());
    referer.pathname = path.endsWith('/c') ? `${path}/` : `${path}/c/`.replace(/\/+/gu, '/');
    referer.search = '';
    referer.hash = '';
    return {
      apiUrl: api,
      referer: referer.toString()
    };
  }

  buildApiUrl(credentials, type, action, extra = {}) {
    const { apiUrl } = this.getPortalPaths(credentials);
    apiUrl.searchParams.set('type', type);
    apiUrl.searchParams.set('action', action);
    apiUrl.searchParams.set('JsHttpRequest', '1-xml');
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null && String(value) !== '') {
        apiUrl.searchParams.set(key, String(value));
      }
    }
    return apiUrl;
  }

  buildHeaders(credentials, token = '') {
    const normalized = normalizeCredentials(credentials);
    const { referer } = this.getPortalPaths(normalized);
    const cookieParts = [
      `mac=${encodeURIComponent(normalized.macAddress)}`,
      'stb_lang=en',
      'timezone=Europe%2FLondon',
      ...(token ? [`token=${encodeURIComponent(token)}`] : [])
    ];
    return {
      Accept: '*/*',
      'User-Agent': MAG_USER_AGENT,
      Referer: referer,
      'Accept-Language': 'en-US,en;q=0.5',
      Pragma: 'no-cache',
      'X-User-Agent': `Model: ${normalized.stbType}; Link: WiFi`,
      Cookie: cookieParts.join('; '),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  async rateLimit(credentials) {
    const normalized = normalizeCredentials(credentials);
    const key = normalized.portalUrl;
    const last = this.lastRequestAtByPortal.get(key) || 0;
    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - last));
    if (waitMs > 0) await sleep(waitMs);
    this.lastRequestAtByPortal.set(key, Date.now());
  }

  async requestEnvelope(credentials, type, action, extra = {}, { token = '', signal = null } = {}) {
    const normalized = normalizeCredentials(credentials);
    if (!hasStalkerCredentials(normalized)) {
      throw new Error('Stalker credentials missing');
    }

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Stalker request timeout')), REQUEST_TIMEOUT_MS);
      timeout.unref?.();

      try {
        await this.rateLimit(normalized);
        const response = await this.fetchImpl(this.buildApiUrl(normalized, type, action, extra), {
          signal: signal && AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          headers: this.buildHeaders(normalized, token)
        });

        if (!response.ok) {
          const error = new Error(`Stalker HTTP ${response.status}`);
          error.statusCode = response.status;
          throw error;
        }

        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error('Stalker malformed JSON response');
        }

        if (payload?.error) {
          throw new Error(`Stalker portal error: ${payload.error}`);
        }
        if (payload?.js && typeof payload.js === 'object' && payload.js.error) {
          throw new Error(`Stalker portal error: ${payload.js.error}`);
        }

        return payload;
      } catch (error) {
        lastError = error;
        const statusCode = Number(error?.statusCode || 0);
        if (attempt >= 2 || (statusCode && !isTemporaryStatus(statusCode))) {
          break;
        }
        await sleep(300 * (2 ** attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError || new Error('Stalker request failed');
  }

  async getToken(credentials, { forceRefresh = false, signal = null } = {}) {
    const normalized = normalizeCredentials(credentials);
    const key = this.getCredentialKey(normalized);
    const cached = this.tokenCache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    /** @type {StalkerEnvelope} */
    const envelope = await this.requestEnvelope(normalized, 'stb', 'handshake', {
      token: '',
      prehash: ''
    }, { signal });
    /** @type {StalkerHandshakeResponse} */
    const payload = getEnvelopePayload(envelope) || {};
    const token = toString(payload.token);
    if (!token) {
      throw new Error('Stalker handshake missing token');
    }
    this.tokenCache.set(key, {
      token,
      expiresAt: Date.now() + TOKEN_TTL_MS
    });
    return token;
  }

  async requestPayload(credentials, type, action, extra = {}, { ttlMs = CACHE_TTL_MS, signal = null, refreshToken = false } = {}) {
    const normalized = normalizeCredentials(credentials);
    const cacheKey = `${this.getCredentialKey(normalized)}:${type}:${action}:${JSON.stringify(extra || {})}`;
    const cached = ttlMs > 0 ? this.cache.get(cacheKey) : null;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    let token = await this.getToken(normalized, { forceRefresh: refreshToken, signal });
    try {
      const envelope = await this.requestEnvelope(normalized, type, action, extra, { token, signal });
      const value = getEnvelopePayload(envelope);
      if (ttlMs > 0) {
        this.cache.set(cacheKey, {
          value,
          expiresAt: Date.now() + ttlMs
        });
      }
      return value;
    } catch (error) {
      if (/token|auth|handshake|forbidden|authorization/iu.test(error?.message || '')) {
        token = await this.getToken(normalized, { forceRefresh: true, signal });
        const envelope = await this.requestEnvelope(normalized, type, action, extra, { token, signal });
        const value = getEnvelopePayload(envelope);
        if (ttlMs > 0) {
          this.cache.set(cacheKey, {
            value,
            expiresAt: Date.now() + ttlMs
          });
        }
        return value;
      }
      throw error;
    }
  }

  async authenticate(credentials, signal = null) {
    const token = await this.getToken(credentials, { forceRefresh: true, signal });
    const [profile, accountInfo] = await Promise.all([
      this.getProfile(credentials, signal).catch((error) => ({ error: error?.message || String(error) })),
      this.getAccountInfo(credentials, signal).catch((error) => ({ error: error?.message || String(error) }))
    ]);
    const expiredText = `${accountInfo?.end_date || ''} ${accountInfo?.status || ''}`.toLowerCase();
    if (/expired|disabled|blocked|banned/iu.test(expiredText)) {
      throw new Error('Stalker subscription invalid or expired');
    }
    return {
      token,
      profile,
      accountInfo
    };
  }

  async getProfile(credentials, signal = null) {
    const normalized = normalizeCredentials(credentials);
    const credentialKey = this.getCredentialKey(normalized);
    const defaultDeviceId = credentialKey.slice(0, 32);
    const deviceId = normalized.deviceId || defaultDeviceId;
    const deviceId2 = normalized.deviceId2 || deviceId;
    const serialNumber = normalized.serialNumber || `NS${credentialKey.slice(0, 11).toUpperCase()}`;

    return this.requestPayload(credentials, 'stb', 'get_profile', {
      hd: 1,
      ver: 'ImageDescription: 0.2.18-r23-254; ImageDate: Wed Aug 29 10:49:53 EEST 2018; PORTAL version: 5.6.8; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c',
      num_banks: 2,
      sn: serialNumber,
      stb_type: normalized.stbType,
      client_type: 'STB',
      image_version: 218,
      video_out: 'hdmi',
      device_id: deviceId,
      device_id2: deviceId2,
      signature: hashKey(`${serialNumber}|${deviceId}|${deviceId2}|${normalized.macAddress}`)
    }, { ttlMs: PROFILE_TTL_MS, signal });
  }

  async getAccountInfo(credentials, signal = null) {
    return this.requestPayload(credentials, 'account_info', 'get_main_info', {}, {
      ttlMs: PROFILE_TTL_MS,
      signal
    });
  }

  async getCategories(credentials, signal = null) {
    const categories = await this.requestPayload(credentials, 'itv', 'get_genres', {}, { signal });
    return Array.isArray(categories) ? categories : [];
  }

  async getChannels(credentials, categoryId = null, signal = null) {
    const normalized = normalizeCredentials(credentials);
    const credentialKey = this.getCredentialKey(normalized);
    const normalizedCategoryId = toString(categoryId);
    if (normalizedCategoryId) {
      const channels = [];
      for (let page = 1; page <= 4; page += 1) {
        const payload = await this.requestPayload(credentials, 'itv', 'get_ordered_list', {
          genre: normalizedCategoryId,
          force_ch_link_check: '',
          fav: 0,
          sortby: 'number',
          hd: 0,
          p: page
        }, { signal });
        const pageChannels = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.data)
            ? payload.data
            : [];
        channels.push(...pageChannels);
        const maxPageItems = Number(payload?.max_page_items || 0);
        if (pageChannels.length === 0 || (maxPageItems > 0 && pageChannels.length < maxPageItems)) {
          break;
        }
      }
      this.rememberChannelCommands(credentialKey, channels);
      return channels;
    }

    const payload = await this.requestPayload(credentials, 'itv', 'get_all_channels', {}, { signal });
    const channels = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    this.rememberChannelCommands(credentialKey, channels);
    return channels;
  }

  rememberChannelCommands(credentialKey, channels) {
    if (!credentialKey || !Array.isArray(channels)) return;
    let cache = this.channelCommandCache.get(credentialKey);
    if (!cache) {
      cache = new Map();
      this.channelCommandCache.set(credentialKey, cache);
    }
    for (const channel of channels) {
      const id = toString(channel?.id);
      const cmd = toString(channel?.cmd);
      if (id && cmd) {
        cache.set(id, cmd);
      }
    }
  }

  getCachedChannelCommand(credentials, channelId) {
    const key = this.getCredentialKey(credentials);
    return this.channelCommandCache.get(key)?.get(toString(channelId)) || '';
  }

  getCatalogDefinitions(categories) {
    return (Array.isArray(categories) ? categories : [])
      .filter((category) => toString(category.id))
      .map((category) => ({
        type: 'tv',
        id: `stalker-live-${category.id}`,
        name: `MAG IPTV: ${category.title || category.name || category.id}`,
        categoryId: String(category.id)
      }));
  }

  getCompactCatalogDefinitions(categories = [], maxCategories = 40) {
    const definitions = [{
      type: 'tv',
      id: 'stalker-live-all',
      name: 'MAG IPTV Live TV',
      categoryId: '*'
    }];

    for (const category of (Array.isArray(categories) ? categories : [])) {
      const id = toString(category.id);
      if (!id || id === '*') continue;
      definitions.push({
        type: 'tv',
        id: `stalker-live-${id}`,
        name: `MAG: ${category.title || category.name || id}`,
        categoryId: id
      });
      if (definitions.length >= maxCategories) break;
    }

    return definitions;
  }

  async getCatalog({ credentials, catalogId, search = '', skip = 0, limit = CATALOG_LIMIT, signal = null }) {
    const match = toString(catalogId).match(/^stalker-live-(.+)$/u);
    if (!match) return [];
    const categoryId = match[1] === 'all' ? '*' : match[1];
    const channels = await this.getChannels(credentials, categoryId, signal);
    const needle = toString(search).toLowerCase();
    return channels
      .filter((channel) => !needle || toString(channel.name).toLowerCase().includes(needle))
      .slice(Math.max(0, Number(skip) || 0))
      .slice(0, limit)
      .map((channel) => this.toMeta(channel));
  }

  toMeta(channel) {
    return {
      id: `stalker:live:${channel.id}`,
      type: 'tv',
      name: channel.name || `Channel ${channel.id}`,
      poster: channel.logo || undefined,
      logo: channel.logo || undefined,
      posterShape: 'square',
      genres: ['Live TV'],
      releaseInfo: channel.number ? `#${channel.number}` : 'Live',
      runtime: 'Live',
      description: 'Stalker Portal live channel'
    };
  }

  parseMetaId(id) {
    const match = toString(id).match(/^stalker:live:(.+)$/u);
    return match ? { kind: 'live', channelId: match[1] } : null;
  }

  async getMeta(credentials, id, signal = null) {
    const parsed = this.parseMetaId(id);
    if (!parsed) return null;
    const channels = await this.getChannels(credentials, null, signal);
    const channel = channels.find((entry) => toString(entry.id) === parsed.channelId);
    const meta = channel ? this.toMeta(channel) : {
      id,
      type: 'tv',
      name: `Channel ${parsed.channelId}`,
      posterShape: 'square',
      releaseInfo: 'Live',
      runtime: 'Live',
      description: 'Stalker Portal live channel'
    };
    const epg = await this.getEpg(credentials, parsed.channelId, signal);
    if (epg.length > 0) {
      const current = epg[0];
      meta.description = [
        decodeMaybeBase64(current.name || current.title || ''),
        decodeMaybeBase64(current.descr || current.description || '')
      ].filter(Boolean).join('\n') || meta.description;
    }
    return meta;
  }

  async getEpg(credentials, channelId, signal = null) {
    try {
      const payload = await this.requestPayload(credentials, 'itv', 'get_short_epg', {
        ch_id: channelId,
        size: 5
      }, {
        ttlMs: EPG_TTL_MS,
        signal
      });
      return Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
    } catch {
      return [];
    }
  }

  buildPrivateStreamUrl({ baseUrl, privateConfigId, channelId }) {
    return `${String(baseUrl || '').replace(/\/+$/u, '')}/private/${encodeURIComponent(privateConfigId)}/stalker/live/${encodeURIComponent(String(channelId))}.ts`;
  }

  async getStreams({ credentials, id, baseUrl, privateConfigId, signal = null }) {
    const parsed = this.parseMetaId(id);
    if (!parsed) return [];
    const fallbackUrl = this.buildPrivateStreamUrl({ baseUrl, privateConfigId, channelId: parsed.channelId });
    return [{
      name: 'NebulaStreams MAG IPTV',
      title: 'Live TV\nStalker Portal',
      url: fallbackUrl,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `stalker:live:${parsed.channelId}`
      }
    }];
  }

  async createLink(credentials, channelId, signal = null) {
    const links = await this.createLinkCandidates(credentials, channelId, signal);
    if (links.length > 0) {
      return links[0];
    }

    throw new Error('Stalker create_link returned no playable URL');
  }

  async createLinkCandidates(credentials, channelId, signal = null) {
    const normalized = normalizeCredentials(credentials);
    const normalizedChannelId = toString(channelId);
    if (!normalizedChannelId) {
      throw new Error('Stalker channel id missing');
    }
    const commandCandidates = [
      this.getCachedChannelCommand(normalized, normalizedChannelId),
      `http://localhost/ch/${normalizedChannelId}_`
    ].filter(Boolean);
    let lastError = null;
    const links = [];

    for (const cmd of [...new Set(commandCandidates)]) {
      try {
        const payload = await this.requestPayload(normalized, 'itv', 'create_link', {
          cmd,
          series: 0,
          forced_storage: 0,
          disable_ad: 0,
          download: 0
        }, {
          // Playback links are often one-use or extremely short-lived.
          // Do not reuse them across Stremio retries/players.
          ttlMs: 0,
          signal,
          refreshToken: false
        });
        const link = absolutizeUrl(payload?.url || payload?.cmd || payload, normalized.portalUrl);
        if (!link || !/^https?:\/\//iu.test(link)) {
          throw new Error('Stalker create_link returned no playable URL');
        }
        if (!links.includes(link)) {
          links.push(link);
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (links.length === 0 && lastError) {
      throw lastError;
    }

    return links;
  }

  async getPlaybackHeaders(credentials, signal = null) {
    const normalized = normalizeCredentials(credentials);
    const token = await this.getToken(normalized, { signal });
    return this.buildHeaders(normalized, token);
  }
}
