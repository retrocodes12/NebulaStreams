import { gunzipSync } from 'node:zlib';

const RAW_BASE = 'https://raw.githubusercontent.com/famelack/famelack-data/main/tv/compressed';
const CACHE_TTL_MS = 45 * 60 * 1000;
const LIVE_CATALOG_LIMIT = 50;
const COUNTRY_CATALOG_LIMIT = 40;
const MAX_ALL_COUNTRIES = 48;
const MAX_SEARCH_COUNTRIES = 80;

const toString = (value) => String(value ?? '').trim();

const normalizeCountryCode = (value) => toString(value).toLowerCase().replace(/[^a-z]/gu, '').slice(0, 2);

const normalizeTitle = (value) =>
  toString(value)
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();

const isHttpUrl = (value) => {
  try {
    const parsed = new URL(toString(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const inferCategory = (channel) => {
  const text = `${channel.name || ''} ${(channel.languages || []).join(' ')}`.toLowerCase();
  if (/sport|football|soccer|tennis|cricket|nba|nfl|golf|racing|fight|wwe|ufc/iu.test(text)) return 'sports';
  if (/news|cnn|abc|cbs|nbc|fox|weather|bbc|al jazeera|france 24|dw|sky news|euronews/iu.test(text)) return 'news';
  if (/kids|child|cartoon|baby|junior|nick|disney/iu.test(text)) return 'kids';
  if (/music|radio|hits|mtv|vevo/iu.test(text)) return 'music';
  if (/movie|cinema|film|series|drama|comedy|action/iu.test(text)) return 'movies';
  if (/faith|church|bible|islam|quran|relig|christ|god|temple/iu.test(text)) return 'religious';
  return 'general';
};

const safeJsonFromMaybeGzip = async (response) => {
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer[0] === 0x1f && buffer[1] === 0x8b
    ? gunzipSync(buffer).toString('utf8')
    : buffer.toString('utf8');
  return JSON.parse(text);
};

export class FamelackLiveAdapter {
  constructor({ logger = console, fetchImpl = globalThis.fetch } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.metadataCache = null;
    this.countryCache = new Map();
  }

  async fetchJson(url, signal = null) {
    const response = await this.fetchImpl(url, {
      signal,
      headers: {
        accept: 'application/json,*/*',
        'User-Agent': 'NebulaStreams/1.0'
      }
    });
    if (!response.ok) throw new Error(`Famelack HTTP ${response.status}`);
    return safeJsonFromMaybeGzip(response);
  }

  async loadCountryMetadata(signal = null) {
    if (this.metadataCache && this.metadataCache.expiresAt > Date.now()) {
      return this.metadataCache.value;
    }

    try {
      const value = await this.fetchJson(`${RAW_BASE}/countries_metadata.json`, signal);
      this.metadataCache = {
        value,
        expiresAt: Date.now() + CACHE_TTL_MS
      };
      return value;
    } catch (error) {
      this.logger.warn?.('famelack country metadata load failed', { error: error?.message || String(error) });
      return this.metadataCache?.value || {};
    }
  }

  async getTopCountries(limit = COUNTRY_CATALOG_LIMIT, signal = null) {
    const metadata = await this.loadCountryMetadata(signal);
    return Object.entries(metadata)
      .map(([code, entry]) => ({
        code: normalizeCountryCode(code),
        name: toString(entry?.country || code),
        count: Number(entry?.channelCount || 0)
      }))
      .filter((entry) => entry.code && entry.count > 0)
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, limit);
  }

  getLiveCatalogDefinitions(countries = []) {
    const definitions = [
      { id: 'famelack-live-all', category: 'all', name: 'Famelack Live TV' },
      { id: 'famelack-live-news', category: 'news', name: 'Famelack News' },
      { id: 'famelack-live-sports', category: 'sports', name: 'Famelack Sports' },
      { id: 'famelack-live-movies', category: 'movies', name: 'Famelack Movies' },
      { id: 'famelack-live-kids', category: 'kids', name: 'Famelack Kids' },
      { id: 'famelack-live-music', category: 'music', name: 'Famelack Music' }
    ];

    for (const country of countries.slice(0, Math.max(0, COUNTRY_CATALOG_LIMIT - definitions.length))) {
      definitions.push({
        id: `famelack-live-country-${country.code}`,
        category: 'country',
        country: country.code,
        name: `Famelack: ${country.name}`
      });
    }

    return definitions;
  }

  async loadCountryChannels(countryCode, signal = null) {
    const code = normalizeCountryCode(countryCode);
    if (!code) return [];

    const cached = this.countryCache.get(code);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.channels;
    }

    try {
      const payload = await this.fetchJson(`${RAW_BASE}/countries/${code}.json`, signal);
      const channels = (Array.isArray(payload) ? payload : [])
        .flatMap((entry) => this.toChannels(entry, code))
        .filter((channel) => channel.url);
      this.countryCache.set(code, {
        channels,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      return channels;
    } catch (error) {
      this.logger.warn?.('famelack country channel load failed', {
        country: code,
        error: error?.message || String(error)
      });
      return cached?.channels || [];
    }
  }

  toChannels(entry, countryCode) {
    const urls = Array.isArray(entry?.stream_urls) ? entry.stream_urls.filter(isHttpUrl) : [];
    const name = toString(entry?.name);
    if (!name || urls.length === 0) return [];
    return urls.map((url, index) => {
      const idSuffix = urls.length > 1 ? `:${index + 1}` : '';
      const category = inferCategory(entry);
      return {
        id: `famelack:${normalizeCountryCode(countryCode)}:${entry.nanoid || encodeURIComponent(name)}${idSuffix}`,
        type: 'tv',
        title: name,
        name,
        url,
        country: normalizeCountryCode(countryCode),
        languages: Array.isArray(entry.languages) ? entry.languages : [],
        isGeoBlocked: Boolean(entry.isGeoBlocked),
        category,
        normalizedTitle: normalizeTitle(name),
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://famelack.com/'
        }
      };
    });
  }

  async loadChannelsForCatalog(catalog = {}, signal = null) {
    const topCountries = await this.getTopCountries(
      catalog.category === 'all' ? MAX_ALL_COUNTRIES : MAX_SEARCH_COUNTRIES,
      signal
    );
    const countryCodes = catalog.country
      ? [catalog.country]
      : topCountries.map((country) => country.code);
    const groups = await Promise.allSettled(countryCodes.map((code) => this.loadCountryChannels(code, signal)));
    return groups
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter((channel) => {
        if (catalog.category === 'country' || catalog.country) return channel.country === catalog.country;
        if (!catalog.category || catalog.category === 'all') return true;
        return channel.category === catalog.category;
      });
  }

  toLiveMeta(channel) {
    return {
      id: channel.id,
      type: 'tv',
      name: channel.title,
      posterShape: 'square',
      genres: [...new Set([channel.category, ...channel.languages].filter(Boolean))],
      releaseInfo: channel.isGeoBlocked ? 'Live - geo restricted' : 'Live',
      runtime: 'Live',
      description: [
        'Famelack public live TV',
        channel.country ? `Country: ${channel.country.toUpperCase()}` : '',
        channel.isGeoBlocked ? 'May be geo restricted' : ''
      ].filter(Boolean).join('\n')
    };
  }

  async getLiveCatalog({ catalog = {}, search = '', skip = 0, limit = LIVE_CATALOG_LIMIT, signal = null } = {}) {
    const needle = normalizeTitle(search);
    const channels = await this.loadChannelsForCatalog(catalog, signal);
    return channels
      .filter((channel) => !needle || channel.normalizedTitle.includes(needle))
      .slice(Math.max(0, Number(skip) || 0))
      .slice(0, limit)
      .map((channel) => this.toLiveMeta(channel));
  }

  async findChannel(id, signal = null) {
    const match = toString(id).match(/^famelack:([a-z]{2}):/u);
    const countries = match ? [match[1]] : (await this.getTopCountries(MAX_SEARCH_COUNTRIES, signal)).map((country) => country.code);
    for (const country of countries) {
      const channels = await this.loadCountryChannels(country, signal);
      const channel = channels.find((entry) => entry.id === id);
      if (channel) return channel;
    }
    return null;
  }

  async getLiveMeta(id, signal = null) {
    const channel = await this.findChannel(id, signal);
    return channel ? this.toLiveMeta(channel) : null;
  }

  async getLiveStreams(id, signal = null) {
    const selected = await this.findChannel(id, signal);
    if (!selected) return [];
    const channels = await this.loadCountryChannels(selected.country, signal);
    const duplicates = channels
      .filter((channel) => channel.normalizedTitle === selected.normalizedTitle)
      .slice(0, 4);

    return duplicates.map((channel, index) => ({
      name: 'NebulaStreams Famelack',
      title: `${channel.title}\nFamelack Live TV${index > 0 ? '\nfallback' : ''}${channel.isGeoBlocked ? '\ngeo restricted' : ''}`,
      url: channel.url,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `famelack-live-${channel.normalizedTitle}`,
        proxyHeaders: { request: channel.headers }
      }
    }));
  }
}
