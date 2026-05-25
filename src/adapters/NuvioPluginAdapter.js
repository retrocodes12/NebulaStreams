import vm from 'node:vm';
import { createRequire } from 'node:module';

import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';
import { withTimeout } from '../utils/timeout.js';
import { config } from '../../config.js';

const require = createRequire(import.meta.url);

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json';
const DEFAULT_RAW_BASE_URL = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/';
const DEFAULT_PROVIDER_ORDER = Object.freeze([
  'notorrent',
  'vidlink',
  'castle',
  'hdhub4u',
  'cinemm',
  'moviebox',
  'goatapi',
  'netmirrornew',
  'netmirror',
  'onetouchtv',
  'movieboxhindi',
  'hindmoviez',
  'zinkmovies',
  'isaidub',
  'lordflix',
  'lamovie',
  'hdmovie2',
  'dooflix',
  '4khdhubnew',
  '4khdhub',
  'showbox',
  'xpass',
  'uhdmovies',
  'movieblast',
  'movies4u',
  'moviesdrive',
  'allmovieland',
  'dahmermovies',
  'dahmermovies-tv',
  'dahmermovies-4k',
  'moviesmod',
  'vidsync',
  'purstream',
  'toflix',
  'embed69',
  'peachify',
  'hindmoviez',
  'movieboxhindi',
  'allwish',
  'cinemacity',
  'onlykdrama',
  'kisskh',
  'videasy',
  'vixsrc',
  'vegamovies',
  'cinestream',
  'vidsrc',
  'playimdb',
  'playimdb_series',
  'playimdb_v2',
  'multivid',
  'streamflix',
  'rgshows'
]);
const RELIABLE_PLUGIN_SCORES = Object.freeze({
  notorrent: 260,
  vidlink: 250,
  castle: 240,
  hdhub4u: 230,
  cinemm: 225,
  moviebox: 205,
  goatapi: 200,
  netmirrornew: 185,
  netmirror: 180,
  onetouchtv: 190,
  movieboxhindi: 180,
  hindmoviez: 175,
  isaidub: 165,
  '4khdhubnew': 160,
  '4khdhub': 155,
  uhdmovies: 150,
  hdmovie2: 145
});
const NEWER_PRIORITY_PLUGIN_IDS = new Set([
  'showbox',
  'zinkmovies',
  'onetouchtv',
  'xpass',
  'cinemm',
  'lamovie',
  'isaidub',
  'notorrent',
  'goatapi',
  'purstream',
  'toflix',
  'embed69',
  'peachify',
  'hindmoviez',
  'movieboxhindi',
  'allwish',
  'cinemacity',
  'onlykdrama',
  'kisskh'
]);
const STABLE_PRIORITY_PLUGIN_IDS = new Set([
  'notorrent',
  'moviebox',
  'vidlink',
  'netmirrornew',
  'netmirror',
  'cinemm',
  '4khdhubnew',
  '4khdhub',
  'hdhub4u',
  'uhdmovies',
  'hdmovie2',
  'netmirror',
  'netmirrornew',
  'dooflix',
  'lordflix',
  'castle',
  'allmovieland',
  'movies4u',
  'moviesdrive'
]);
const SLOW_OR_NOISY_PLUGIN_IDS = new Set([
  'brazucaplay',
  'cinestream',
  'vidsrc',
  'playimdb',
  'playimdb_series',
  'playimdb_v2',
  'multivid',
  'vixsrc',
  'vegamovies',
  'moviesmod',
  'movieblast'
]);
const BLOCKED_PLUGIN_IDS = new Set([
  // These Nuvio plugins often emit stale/HTML links or links needing browser-only flows.
  // Keep Nebula direct providers for these instead of showing broken duplicate Nuvio cards.
  'movix',
  'nakios',
  'streamflix'
]);
const BLOCKED_HOSTS = new Set([
  'zebi.senpai-stream.club',
  'cdn.fastflux.xyz'
]);
const BLOCKED_HOST_SUFFIXES = Object.freeze([
  '.senpai-stream.club'
]);

const toNuvioMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();
  if (normalized === 'series' || normalized === 'tv') return 'tv';
  return 'movie';
};

const isExpectedAdapterAbort = (error) => {
  const message = String(error?.message || error || '');
  return message === 'Nuvio adapter finished'
    || message === 'The operation was aborted'
    || message === 'Provider request cancelled'
    || message.includes('Nuvio adapter finished')
    || message.includes('adapter finished');
};

export class NuvioPluginAdapter extends PluginProviderAdapter {
  constructor({
    id = 'nuvio',
    name = 'Nuvio',
    cacheNamespace = id,
    cache,
    logger = console,
    manifestUrl = DEFAULT_MANIFEST_URL,
    rawBaseUrl = DEFAULT_RAW_BASE_URL,
    providerOrder = DEFAULT_PROVIDER_ORDER,
    maxProvidersPerRequest = Infinity,
    pluginConcurrency = Number(process.env.NUVIO_PLUGIN_CONCURRENCY || 6),
    earlyReturnStreams = Number(process.env.NUVIO_EARLY_RETURN_STREAMS || 40),
    providerTimeoutMs = 7_000,
    overallTimeoutMs = 18_000,
    pluginFetchHeaders = null
  }) {
    super({ id, logger });
    this.name = name;
    this.cacheNamespace = cacheNamespace;
    this.cache = cache;
    this.manifestUrl = manifestUrl;
    this.rawBaseUrl = rawBaseUrl;
    this.providerOrder = providerOrder;
    this.maxProvidersPerRequest = maxProvidersPerRequest;
    this.pluginConcurrency = Math.max(1, Number(pluginConcurrency) || 6);
    this.earlyReturnStreams = Math.max(1, Number(earlyReturnStreams) || 40);
    this.providerTimeoutMs = providerTimeoutMs;
    this.overallTimeoutMs = overallTimeoutMs;
    this.pluginFetchHeaders = pluginFetchHeaders && typeof pluginFetchHeaders === 'object'
      ? pluginFetchHeaders
      : null;
    this.moduleCache = new Map();
    this.metadataCache = new Map();
  }

  async getManifest(signal = null) {
    return this.cache.getJson(`${this.cacheNamespace}/manifest`, this.manifestUrl, {
      signal,
      ttlMs: 60 * 60 * 1000
    });
  }

  async getStreams(request) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`${this.name} adapter timed out`)), this.overallTimeoutMs);
    timeout.unref?.();

    try {
      const manifest = await this.getManifest(controller.signal);
      const plugins = this.selectPlugins(manifest, request);
      return await this.runPluginsWithConcurrency(plugins, request, controller.signal, this.overallTimeoutMs);
    } finally {
      clearTimeout(timeout);
      controller.abort(new Error(`${this.name} adapter finished`));
    }
  }

  selectPlugins(manifest, request) {
    const scrapers = Array.isArray(manifest?.scrapers) ? manifest.scrapers : [];
    const mediaType = toNuvioMediaType(request.mediaType);
    const enabled = scrapers.filter((scraper) =>
      scraper?.enabled !== false
      && scraper?.filename
      && Array.isArray(scraper.supportedTypes)
      && scraper.supportedTypes.includes(mediaType)
    );
    const providerOrder = [...new Set(this.providerOrder.map((id) => String(id || '').toLowerCase()))];
    const providerOrderSet = new Set(providerOrder);
    const byId = new Map(enabled.map((scraper) => [String(scraper.id || '').toLowerCase(), scraper]));
    const ordered = [
      ...providerOrder.map((id) => byId.get(id)).filter(Boolean),
      ...enabled
        .filter((scraper) => !providerOrderSet.has(String(scraper.id || '').toLowerCase()))
        .sort((left, right) => this.getPluginPriority(right) - this.getPluginPriority(left))
    ];

    if (!Number.isFinite(this.maxProvidersPerRequest) || this.maxProvidersPerRequest <= 0) {
      return ordered;
    }

    return ordered.slice(0, this.maxProvidersPerRequest);
  }

  getPluginPriority(plugin) {
    const pluginId = String(plugin?.id || '').toLowerCase();
    let score = RELIABLE_PLUGIN_SCORES[pluginId] || 0;
    if (STABLE_PRIORITY_PLUGIN_IDS.has(pluginId)) score += 120;
    if (NEWER_PRIORITY_PLUGIN_IDS.has(pluginId)) score += 100;
    if (SLOW_OR_NOISY_PLUGIN_IDS.has(pluginId)) score -= 70;
    if (pluginId.includes('anime')) score -= 30;
    if (pluginId.includes('hindi')) score += 15;
    return score;
  }

  async runPluginsWithConcurrency(plugins, request, signal, timeoutMs) {
    const results = [];
    let nextIndex = 0;
    const workerCount = Math.min(this.pluginConcurrency, plugins.length);
    const startedAt = Date.now();

    const worker = async () => {
      while (nextIndex < plugins.length && !signal?.aborted && Date.now() - startedAt < timeoutMs) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          const streams = await this.runPlugin(plugins[index], request, signal);
          if (streams.length > 0) {
            results.push({ index, streams });
          }
          const streamCount = results.reduce((count, result) => count + result.streams.length, 0);
          if (streamCount >= this.earlyReturnStreams) {
            break;
          }
        } catch {
          // runPlugin already logs provider-level failures.
        }
      }
    };

    const timeout = new Promise((resolve) => {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      const timeoutId = setTimeout(resolve, remainingMs);
      timeoutId.unref?.();
    });

    await Promise.race([
      Promise.all(Array.from({ length: workerCount }, () => worker())),
      timeout
    ]);

    return results
      .sort((left, right) => left.index - right.index)
      .flatMap((result) => result.streams);
  }

  async runPlugin(plugin, request, signal) {
    const pluginId = String(plugin.id || '').toLowerCase();

    try {
      const module = await this.loadPluginModule(plugin, signal);
      if (!module || typeof module.getStreams !== 'function') {
        throw new Error(`${this.name} plugin ${pluginId} missing getStreams()`);
      }

      const metadata = await this.getTmdbMetadata(request, signal);
      const rawStreams = await withTimeout(
        () => Promise.resolve(module.getStreams(
          String(request.tmdbId || ''),
          toNuvioMediaType(request.mediaType),
          request.season,
          request.episode,
          metadata?.title,
          metadata?.year
        )),
        this.getPluginTimeoutMs(pluginId),
        `${this.name} plugin ${pluginId} timed out`
      );

      return normalizePluginStreams(rawStreams, {
        adapterId: this.id,
        pluginId,
        pluginName: plugin.name
      }).filter((stream) => this.isUsableStream(stream, request));
    } catch (error) {
      if (isExpectedAdapterAbort(error)) {
        return [];
      }

      this.logger.info?.('nuvio plugin failed', {
        adapter: this.id,
        plugin: pluginId,
        error: error?.message || String(error)
      });
      return [];
    }
  }

  async getTmdbMetadata(request, signal = null) {
    const tmdbId = String(request?.tmdbId || '').trim();
    if (!tmdbId) return null;

    const mediaType = toNuvioMediaType(request.mediaType);
    const cacheKey = `${mediaType}:${tmdbId}`;
    const cached = this.metadataCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < 6 * 60 * 60 * 1000) {
      return cached.value;
    }

    try {
      const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
      const url = new URL(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(tmdbId)}`);
      url.searchParams.set('api_key', config.TMDB_API_KEY);
      url.searchParams.set('language', 'en-US');
      const response = await fetch(url, {
        signal,
        headers: { accept: 'application/json' }
      });
      if (!response.ok) return null;

      const payload = await response.json();
      const title = String(payload.title || payload.name || payload.original_title || payload.original_name || '').trim();
      const year = String(payload.release_date || payload.first_air_date || '').slice(0, 4);
      const value = title ? { title, year } : null;
      this.metadataCache.set(cacheKey, { value, cachedAt: Date.now() });
      return value;
    } catch {
      return null;
    }
  }

  getPluginTimeoutMs(pluginId) {
    if (STABLE_PRIORITY_PLUGIN_IDS.has(pluginId) || NEWER_PRIORITY_PLUGIN_IDS.has(pluginId)) {
      return Math.max(this.providerTimeoutMs, 10_000);
    }
    if (SLOW_OR_NOISY_PLUGIN_IDS.has(pluginId)) {
      return Math.min(this.providerTimeoutMs, 5_000);
    }
    return this.providerTimeoutMs;
  }

  isUsableStream(stream, request = {}) {
    const pluginId = String(stream?.pluginProvider || '').trim().toLowerCase();
    if (this.id === 'nuvio' && BLOCKED_PLUGIN_IDS.has(pluginId)) {
      return false;
    }

    try {
      const hostname = new URL(String(stream?.url || '')).hostname.toLowerCase();
      if (BLOCKED_HOSTS.has(hostname) || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
        return false;
      }
    } catch {
      return Boolean(stream?.magnet);
    }

    const mediaType = toNuvioMediaType(request.mediaType);
    const titleText = `${stream?.title || ''} ${stream?.name || ''} ${stream?.url || ''}`.toLowerCase();
    if (mediaType === 'movie' && /\b\/s\d{1,2}\/|\bs\d{1,2}e\d{1,2}\b/u.test(titleText)) {
      return false;
    }

    return true;
  }

  async loadPluginModule(plugin, signal = null) {
    const pluginId = String(plugin.id || plugin.filename || '').toLowerCase();
    const filename = String(plugin.filename || '').replace(/^\/+/u, '');
    const cacheKey = `${pluginId}:${filename}`;

    if (this.moduleCache.has(cacheKey)) {
      return this.moduleCache.get(cacheKey);
    }

    const scriptUrl = new URL(filename, this.rawBaseUrl).toString();
    const script = await this.cache.getText(`${this.cacheNamespace}/scripts/${encodeURIComponent(filename)}.js`, scriptUrl, {
      signal,
      ttlMs: 6 * 60 * 60 * 1000
    });
    const loaded = this.evaluateCommonJs(script, scriptUrl);

    this.moduleCache.set(cacheKey, loaded);
    return loaded;
  }

  evaluateCommonJs(script, filename) {
    const module = { exports: {} };
    const sandbox = {
      module,
      exports: module.exports,
      require,
      fetch: this.fetchPlugin.bind(this),
      console: this.createPluginConsole(filename),
      AbortController,
      AbortSignal,
      Headers,
      Request,
      Response,
      URL,
      URLSearchParams,
      TextDecoder,
      TextEncoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Buffer,
      process: {
        env: process.env
      },
      global: {}
    };
    sandbox.global = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInNewContext(script, sandbox, {
      filename,
      timeout: 1_000
    });

    return module.exports;
  }

  fetchPlugin(input, init = {}) {
    if (!this.pluginFetchHeaders) {
      return globalThis.fetch(input, init);
    }

    const headers = new Headers(init?.headers || input?.headers || {});
    for (const [name, value] of Object.entries(this.pluginFetchHeaders)) {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }

    return globalThis.fetch(input, {
      ...init,
      headers
    });
  }

  createPluginConsole(filename) {
    const summarize = (args) => args
      .map((arg) => {
        if (typeof arg === 'string') return arg.slice(0, 240);
        try {
          return JSON.stringify(arg).slice(0, 240);
        } catch {
          return String(arg).slice(0, 240);
        }
      })
      .join(' ');

    return {
      log: () => {},
      info: () => {},
      warn: (...args) => this.logger.info?.('nuvio plugin warning', {
        pluginFile: filename,
        message: summarize(args)
      }),
      error: (...args) => this.logger.info?.('nuvio plugin error', {
        pluginFile: filename,
        message: summarize(args)
      })
    };
  }
}
