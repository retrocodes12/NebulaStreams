const API_BASE = 'https://nflixmovies.app/api';
const CACHE_TTL_MS = 15 * 60 * 1000;
const LIVE_CATALOG_LIMIT = 50;
const CATEGORY_LABELS = Object.freeze({
  all: 'Nflix Live TV',
  documentary: 'Nflix Documentary',
  entertainment: 'Nflix Entertainment',
  kids: 'Nflix Kids',
  movies: 'Nflix Movies',
  news: 'Nflix News',
  sports: 'Nflix Sports'
});

const toString = (value) => String(value ?? '').trim();

const normalizeCategory = (value) =>
  toString(value).toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'other';

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

export class NflixLiveAdapter {
  constructor({ logger = console, fetchImpl = globalThis.fetch } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.channelCache = null;
    this.epgCache = new Map();
  }

  async fetchJson(path, signal = null) {
    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      signal,
      headers: {
        accept: 'application/json,*/*',
        'User-Agent': 'NebulaStreams/1.0',
        Referer: 'https://nflixmovies.app/'
      }
    });
    if (!response.ok) throw new Error(`Nflix HTTP ${response.status}`);
    return response.json();
  }

  async loadChannels(signal = null) {
    if (this.channelCache && this.channelCache.expiresAt > Date.now()) {
      return this.channelCache.value;
    }

    try {
      const payload = await this.fetchJson('/livetv/channels', signal);
      const categories = Array.isArray(payload?.categories)
        ? payload.categories.map(normalizeCategory).filter(Boolean)
        : [];
      const channels = (Array.isArray(payload?.channels) ? payload.channels : [])
        .map((entry) => this.toChannel(entry))
        .filter((channel) => channel?.id && channel.url);
      const value = {
        categories: [...new Set(categories.length > 0 ? categories : channels.map((channel) => channel.category))],
        channels
      };
      this.channelCache = {
        value,
        expiresAt: Date.now() + CACHE_TTL_MS
      };
      return value;
    } catch (error) {
      this.logger.warn?.('nflix live channel load failed', { error: error?.message || String(error) });
      return this.channelCache?.value || { categories: [], channels: [] };
    }
  }

  toChannel(entry) {
    const id = toString(entry?.id);
    const name = toString(entry?.name);
    const url = toString(entry?.source_url);
    if (!id || !name || !isHttpUrl(url)) return null;
    const category = normalizeCategory(entry?.category);
    return {
      id: `nflix:${encodeURIComponent(id)}`,
      sourceId: id,
      type: 'tv',
      title: name,
      name,
      url,
      logoUrl: isHttpUrl(entry?.logo_url) ? toString(entry.logo_url) : null,
      epgSourceUrl: isHttpUrl(entry?.epg_source_url) ? toString(entry.epg_source_url) : null,
      region: toString(entry?.region),
      category,
      normalizedTitle: normalizeTitle(name),
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://nflixmovies.app/'
      }
    };
  }

  getLiveCatalogDefinitions(categories = []) {
    const normalized = [...new Set(categories.map(normalizeCategory).filter(Boolean))];
    const ordered = ['all', ...normalized.filter((category) => category !== 'all').sort()];
    return ordered.map((category) => ({
      id: `nflix-live-${category}`,
      category,
      name: CATEGORY_LABELS[category] || `Nflix ${category.replace(/-/gu, ' ')}`
    }));
  }

  async getCatalogDefinition(catalogId, signal = null) {
    const payload = await this.loadChannels(signal);
    return this.getLiveCatalogDefinitions(payload.categories)
      .find((definition) => definition.id === catalogId) || null;
  }

  filterChannels(channels, catalog = {}, search = '') {
    const needle = normalizeTitle(search);
    return channels
      .filter((channel) => catalog.category === 'all' || channel.category === catalog.category)
      .filter((channel) => !needle || channel.normalizedTitle.includes(needle));
  }

  toLiveMeta(channel) {
    return {
      id: channel.id,
      type: 'tv',
      name: channel.title,
      poster: channel.logoUrl || undefined,
      logo: channel.logoUrl || undefined,
      posterShape: 'square',
      genres: [...new Set([channel.category, channel.region].filter(Boolean))],
      releaseInfo: channel.region ? `Live - ${channel.region}` : 'Live',
      runtime: 'Live',
      description: [
        'Nflix public live TV',
        channel.region ? `Region: ${channel.region}` : ''
      ].filter(Boolean).join('\n')
    };
  }

  async getLiveCatalog({ catalog = {}, search = '', skip = 0, limit = LIVE_CATALOG_LIMIT, signal = null } = {}) {
    const payload = await this.loadChannels(signal);
    return this.filterChannels(payload.channels, catalog, search)
      .slice(Math.max(0, Number(skip) || 0))
      .slice(0, limit)
      .map((channel) => this.toLiveMeta(channel));
  }

  async findChannel(id, signal = null) {
    const sourceId = decodeURIComponent(toString(id).replace(/^nflix:/u, ''));
    if (!sourceId) return null;
    const payload = await this.loadChannels(signal);
    return payload.channels.find((channel) => channel.sourceId === sourceId) || null;
  }

  async getLiveMeta(id, signal = null) {
    const channel = await this.findChannel(id, signal);
    if (!channel) return null;

    const epg = await this.getEpg(channel.sourceId, signal);
    const now = Date.now();
    const current = epg.find((program) => program.start <= now && program.stop > now);
    const meta = this.toLiveMeta(channel);
    if (current?.title) {
      meta.description = [
        current.title,
        current.description || '',
        meta.description
      ].filter(Boolean).join('\n');
    }
    return meta;
  }

  async getEpg(sourceId, signal = null) {
    const id = toString(sourceId);
    if (!id) return [];
    const cached = this.epgCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      const payload = await this.fetchJson(`/livetv/epg?channel_id=${encodeURIComponent(id)}`, signal);
      const value = (Array.isArray(payload?.programs) ? payload.programs : [])
        .map((program) => ({
          title: toString(program?.title) || 'Live',
          description: toString(program?.description),
          start: Number(program?.start || 0) < 1e12 ? Number(program?.start || 0) * 1000 : Number(program?.start || 0),
          stop: Number(program?.stop || 0) < 1e12 ? Number(program?.stop || 0) * 1000 : Number(program?.stop || 0)
        }))
        .filter((program) => program.start > 0 && program.stop > program.start);
      this.epgCache.set(id, {
        value,
        expiresAt: Date.now() + 5 * 60 * 1000
      });
      return value;
    } catch {
      return cached?.value || [];
    }
  }

  async getLiveStreams(id, { baseUrl = '', privateConfigId = '', signal = null } = {}) {
    const channel = await this.findChannel(id, signal);
    if (!channel) return [];
    const playbackUrl = baseUrl && privateConfigId
      ? `${String(baseUrl).replace(/\/+$/u, '')}/private/${encodeURIComponent(privateConfigId)}/nflix/live/${encodeURIComponent(channel.sourceId)}.m3u8`
      : channel.url;
    return [{
      name: 'NebulaStreams Nflix',
      title: `${channel.title}\nNflix Live TV${channel.region ? `\n${channel.region}` : ''}`,
      url: playbackUrl,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `nflix-live-${channel.normalizedTitle}`,
        ...(baseUrl && privateConfigId ? {} : { proxyHeaders: { request: channel.headers } })
      }
    }];
  }
}
