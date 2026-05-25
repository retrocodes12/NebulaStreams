import { createHash } from 'node:crypto';

const PLAYLIST_URL = process.env.CS_GERMAN_IPTV_URL || 'https://iptv-org.github.io/iptv/countries/de.m3u';
const CACHE_TTL_MS = 30 * 60 * 1000;
const LIVE_CATALOG_LIMIT = 50;

const toString = (value) => String(value ?? '').trim();
const hashId = (value) => createHash('sha1').update(String(value)).digest('hex').slice(0, 16);

const parseExtInfAttrs = (line) => {
  const attrs = {};
  for (const match of line.matchAll(/([a-z0-9_-]+)="([^"]*)"/giu)) {
    attrs[match[1].toLowerCase()] = match[2];
  }
  return attrs;
};

const inferCategory = (channel) => {
  const text = `${channel.title} ${channel.group}`.toLowerCase();
  if (/sport|bundesliga|football|fussball|sky/iu.test(text)) return 'sports';
  if (/news|nachrichten|welt|tagesschau|ntv|n-tv/iu.test(text)) return 'news';
  if (/kinder|kids|musik|music|movie|film|serie|entertainment/iu.test(text)) return 'entertainment';
  return 'regional';
};

const parseM3u = (text) => {
  const lines = String(text || '').split(/\r?\n/u);
  const channels = [];
  let pending = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = parseExtInfAttrs(line);
      const title = toString(line.split(',').pop());
      pending = {
        title: title || attrs['tvg-name'] || attrs['tvg-id'] || 'German IPTV',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://iptv-org.github.io/'
        }
      };
      continue;
    }

    if (line.startsWith('#') || !pending || !/^https?:\/\//iu.test(line)) {
      continue;
    }

    const channel = {
      ...pending,
      url: line,
      source: 'cs-german-iptv'
    };
    channel.category = inferCategory(channel);
    channel.id = `cs-german:${hashId(`${channel.title}|${channel.url}`)}`;
    channel.normalizedTitle = channel.title.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
    channels.push(channel);
    pending = null;
  }

  const seen = new Set();
  return channels.filter((channel) => {
    if (seen.has(channel.url)) return false;
    seen.add(channel.url);
    return true;
  });
};

export class GermanIptvLiveAdapter {
  constructor({ logger = console, fetchImpl = globalThis.fetch } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.cache = null;
  }

  getLiveCatalogDefinitions() {
    return [
      { id: 'cs-german-live-all', category: 'all', name: 'German IPTV' },
      { id: 'cs-german-live-news', category: 'news', name: 'German News' },
      { id: 'cs-german-live-sports', category: 'sports', name: 'German Sports' },
      { id: 'cs-german-live-regional', category: 'regional', name: 'German Regional' },
      { id: 'cs-german-live-entertainment', category: 'entertainment', name: 'German Entertainment' }
    ];
  }

  async loadLiveChannels() {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.channels;
    }

    try {
      const response = await this.fetchImpl(PLAYLIST_URL, {
        headers: { accept: 'audio/x-mpegurl,text/plain,*/*' }
      });
      if (!response.ok) throw new Error(`German IPTV HTTP ${response.status}`);
      const channels = parseM3u(await response.text());
      this.cache = {
        channels,
        expiresAt: Date.now() + CACHE_TTL_MS
      };
      return channels;
    } catch (error) {
      this.logger.warn?.('german iptv catalog load failed', { error });
      return this.cache?.channels || [];
    }
  }

  toLiveMeta(channel) {
    return {
      id: channel.id,
      type: 'tv',
      name: channel.title,
      poster: channel.logo || undefined,
      logo: channel.logo || undefined,
      posterShape: 'square',
      genres: [...new Set([channel.category, channel.group].filter(Boolean))],
      description: `${channel.group || 'German IPTV'} • ${channel.category}`,
      releaseInfo: 'Live',
      runtime: 'Live'
    };
  }

  async getLiveCatalog({ category = 'all', skip = 0, limit = LIVE_CATALOG_LIMIT } = {}) {
    const channels = await this.loadLiveChannels();
    return channels
      .filter((channel) => category === 'all' || channel.category === category)
      .slice(skip)
      .slice(0, limit)
      .map((channel) => this.toLiveMeta(channel));
  }

  async getLiveMeta(id) {
    const channels = await this.loadLiveChannels();
    const channel = channels.find((item) => item.id === id);
    return channel ? this.toLiveMeta(channel) : null;
  }

  async getLiveStreams(id) {
    const channels = await this.loadLiveChannels();
    const selected = channels.find((channel) => channel.id === id);
    if (!selected) return [];

    const duplicates = channels
      .filter((channel) => channel.normalizedTitle === selected.normalizedTitle)
      .slice(0, 4);

    return duplicates.map((channel, index) => ({
      name: 'NebulaStreams German Live',
      title: `${channel.title}\nCS-German IPTV${index > 0 ? '\nfallback' : ''}`,
      url: channel.url,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `cs-german-live-${channel.normalizedTitle}`,
        proxyHeaders: { request: channel.headers }
      }
    }));
  }
}
