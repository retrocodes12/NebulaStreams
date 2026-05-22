import vm from 'node:vm';
import { createRequire } from 'node:module';

import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';
import { withTimeout } from '../utils/timeout.js';

const require = createRequire(import.meta.url);

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json';
const DEFAULT_RAW_BASE_URL = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/';
const DEFAULT_PROVIDER_ORDER = Object.freeze([
  'cinemm',
  'moviebox',
  'zinkmovies',
  'hdhub4u',
  'notorrent',
  'isaidub',
  'castle',
  'vidlink',
  'netmirror',
  'netmirrornew',
  'lordflix',
  'onetouchtv',
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
const NEWER_PRIORITY_PLUGIN_IDS = new Set([
  'showbox',
  'zinkmovies',
  'onetouchtv',
  'xpass',
  'cinemm',
  'lamovie',
  'isaidub',
  'notorrent',
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
  'moviebox',
  'vidlink',
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
    || message.includes('Nuvio adapter finished');
};

export class NuvioPluginAdapter extends PluginProviderAdapter {
  constructor({
    cache,
    logger = console,
    manifestUrl = DEFAULT_MANIFEST_URL,
    rawBaseUrl = DEFAULT_RAW_BASE_URL,
    providerOrder = DEFAULT_PROVIDER_ORDER,
    maxProvidersPerRequest = Infinity,
    pluginConcurrency = Number(process.env.NUVIO_PLUGIN_CONCURRENCY || 6),
    earlyReturnStreams = Number(process.env.NUVIO_EARLY_RETURN_STREAMS || 40),
    providerTimeoutMs = 7_000,
    overallTimeoutMs = 18_000
  }) {
    super({ id: 'nuvio', logger });
    this.cache = cache;
    this.manifestUrl = manifestUrl;
    this.rawBaseUrl = rawBaseUrl;
    this.providerOrder = providerOrder;
    this.maxProvidersPerRequest = maxProvidersPerRequest;
    this.pluginConcurrency = Math.max(1, Number(pluginConcurrency) || 6);
    this.earlyReturnStreams = Math.max(1, Number(earlyReturnStreams) || 40);
    this.providerTimeoutMs = providerTimeoutMs;
    this.overallTimeoutMs = overallTimeoutMs;
    this.moduleCache = new Map();
  }

  async getManifest(signal = null) {
    return this.cache.getJson('nuvio/manifest', this.manifestUrl, {
      signal,
      ttlMs: 60 * 60 * 1000
    });
  }

  async getStreams(request) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Nuvio adapter timed out')), this.overallTimeoutMs);
    timeout.unref?.();

    try {
      const manifest = await this.getManifest(controller.signal);
      const plugins = this.selectPlugins(manifest, request);
      return await this.runPluginsWithConcurrency(plugins, request, controller.signal, this.overallTimeoutMs);
    } finally {
      clearTimeout(timeout);
      controller.abort(new Error('Nuvio adapter finished'));
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
    let score = 0;
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
        throw new Error(`Nuvio plugin ${pluginId} missing getStreams()`);
      }

      const rawStreams = await withTimeout(
        () => Promise.resolve(module.getStreams(
          String(request.tmdbId || ''),
          toNuvioMediaType(request.mediaType),
          request.season,
          request.episode
        )),
        this.getPluginTimeoutMs(pluginId),
        `Nuvio plugin ${pluginId} timed out`
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
        plugin: pluginId,
        error: error?.message || String(error)
      });
      return [];
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
    if (BLOCKED_PLUGIN_IDS.has(pluginId)) {
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
    const script = await this.cache.getText(`nuvio/scripts/${encodeURIComponent(filename)}.js`, scriptUrl, {
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
      fetch: globalThis.fetch,
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
