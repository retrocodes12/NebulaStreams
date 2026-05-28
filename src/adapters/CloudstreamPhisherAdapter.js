import { createRequire } from 'node:module';
import path from 'node:path';

import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';
import { withTimeout } from '../utils/timeout.js';

const require = createRequire(import.meta.url);

const DEFAULT_PLUGIN_LIST_URL = 'https://raw.githubusercontent.com/phisher98/cloudstream-extensions-phisher/refs/heads/builds/plugins.json';
const PROVIDERS_DIR = path.resolve(process.cwd(), 'vendor/HTTP/providers');

const PLUGIN_TO_PROVIDER = Object.freeze({
  AllMovieLandProvider: 'allmovieland',
  AllWish: 'allwish',
  Animesalt: 'animesalt',
  AnimePahe: 'animepahe',
  Aniworld: 'animeworld',
  Cinemacity: 'cinemacity',
  FourKHDHub: '4khdhub',
  HDhub4u: 'hdhub4u',
  Hindmoviez: 'hindmoviez',
  KisskhProvider: 'kisskh',
  MovieBlast: 'movieblast',
  MovieBoxProvider: 'moviebox',
  OneTouchTV: 'onetouchtv',
  ShowBox: 'showbox',
  UHDmoviesProvider: 'uhdmovies'
});

const PROVIDER_ORDER = Object.freeze([
  'ShowBox',
  'MovieBlast',
  'MovieBoxProvider',
  'AllMovieLandProvider',
  'AllWish',
  'OneTouchTV',
  'KisskhProvider',
  'Cinemacity',
  'Hindmoviez',
  'FourKHDHub',
  'HDhub4u',
  'UHDmoviesProvider',
  'AnimePahe',
  'Aniworld',
  'Animesalt'
]);

const BLOCKED_PROVIDER_IDS = new Set([
  // Heavy hub providers already run as direct Nebula providers. Do not duplicate
  // them inside this adapter or the default Stremio search gets slower.
  '4khdhub',
  'hdhub4u',
  'uhdmovies'
]);

const toMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();
  return normalized === 'series' || normalized === 'tv' ? 'tv' : 'movie';
};

const supportsMediaType = (plugin, mediaType) => {
  const tvTypes = Array.isArray(plugin?.tvTypes)
    ? plugin.tvTypes.map((type) => String(type || '').toLowerCase())
    : [];

  if (tvTypes.includes('all')) return true;
  if (mediaType === 'movie') {
    return tvTypes.some((type) => ['movie', 'animemovie'].includes(type));
  }

  return tvTypes.some((type) => ['tvseries', 'anime', 'asiandrama', 'cartoon', 'ova'].includes(type));
};

const isExpectedAbort = (error) => {
  const message = String(error?.message || error || '');
  return message === 'Cloudstream Phisher adapter finished'
    || message === 'The operation was aborted'
    || message === 'Provider request cancelled'
    || message.includes('Cloudstream Phisher adapter finished');
};

export class CloudstreamPhisherAdapter extends PluginProviderAdapter {
  constructor({
    cache,
    logger = console,
    pluginListUrl = DEFAULT_PLUGIN_LIST_URL,
    providerConcurrency = Number(process.env.CLOUDSTREAM_PHISHER_CONCURRENCY || 4),
    providerTimeoutMs = Number(process.env.CLOUDSTREAM_PHISHER_PROVIDER_TIMEOUT_MS || 10_000),
    overallTimeoutMs = Number(process.env.CLOUDSTREAM_PHISHER_TIMEOUT_MS || 20_000),
    earlyReturnStreams = Number(process.env.CLOUDSTREAM_PHISHER_EARLY_RETURN_STREAMS || 5)
  }) {
    super({ id: 'cloudstream-phisher', logger });
    this.cache = cache;
    this.pluginListUrl = pluginListUrl;
    this.providerConcurrency = Math.max(1, Number(providerConcurrency) || 4);
    this.providerTimeoutMs = Math.max(3_000, Number(providerTimeoutMs) || 12_000);
    this.overallTimeoutMs = Math.max(5_000, Number(overallTimeoutMs) || 28_000);
    this.earlyReturnStreams = Math.max(1, Number(earlyReturnStreams) || 30);
    this.moduleCache = new Map();
  }

  async getManifest(signal = null) {
    return this.cache.getJson('cloudstream-phisher/plugins', this.pluginListUrl, {
      signal,
      ttlMs: 60 * 60 * 1000
    });
  }

  async getStreams(request) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Cloudstream Phisher adapter timed out')),
      this.overallTimeoutMs
    );
    timeout.unref?.();

    try {
      const manifest = await this.getManifest(controller.signal);
      const plugins = this.selectPlugins(manifest, request);
      return await this.runPlugins(plugins, request, controller.signal);
    } finally {
      clearTimeout(timeout);
      controller.abort(new Error('Cloudstream Phisher adapter finished'));
    }
  }

  selectPlugins(manifest, request) {
    const mediaType = toMediaType(request.mediaType);
    const plugins = Array.isArray(manifest) ? manifest : [];
    const byInternalName = new Map(
      plugins
        .filter((plugin) => plugin?.status === 1 && plugin?.internalName && supportsMediaType(plugin, mediaType))
        .map((plugin) => [String(plugin.internalName), plugin])
    );

    return PROVIDER_ORDER
      .map((internalName) => byInternalName.get(internalName))
      .filter(Boolean)
      .filter((plugin) => {
        const providerId = PLUGIN_TO_PROVIDER[String(plugin.internalName)];
        return providerId && !BLOCKED_PROVIDER_IDS.has(providerId);
      });
  }

  async runPlugins(plugins, request, signal) {
    const results = [];
    let nextIndex = 0;
    const startedAt = Date.now();
    const workerCount = Math.min(this.providerConcurrency, plugins.length);

    const worker = async () => {
      while (nextIndex < plugins.length && !signal?.aborted && Date.now() - startedAt < this.overallTimeoutMs) {
        const index = nextIndex;
        nextIndex += 1;

        const streams = await this.runPlugin(plugins[index], request, signal);
        if (streams.length > 0) {
          results.push({ index, streams });
        }

        const streamCount = results.reduce((count, result) => count + result.streams.length, 0);
        if (streamCount >= this.earlyReturnStreams) {
          break;
        }
      }
    };

    await Promise.race([
      Promise.allSettled(Array.from({ length: workerCount }, () => worker())),
      new Promise((resolve) => {
        const remainingMs = Math.max(1, this.overallTimeoutMs - (Date.now() - startedAt));
        const timeout = setTimeout(resolve, remainingMs);
        timeout.unref?.();
      })
    ]);

    return results
      .sort((left, right) => left.index - right.index)
      .flatMap((result) => result.streams);
  }

  async runPlugin(plugin, request, signal) {
    const internalName = String(plugin?.internalName || '');
    const providerId = PLUGIN_TO_PROVIDER[internalName];
    if (!providerId) return [];

    try {
      const providerModule = this.loadProviderModule(providerId);
      const rawStreams = await withTimeout(
        () => Promise.resolve(providerModule.getStreams(
          String(request.tmdbId || ''),
          toMediaType(request.mediaType),
          request.season,
          request.episode
        )),
        this.getProviderTimeoutMs(providerId),
        `Cloudstream Phisher provider ${providerId} timed out`
      );

      return normalizePluginStreams(rawStreams, {
        adapterId: this.id,
        pluginId: providerId,
        pluginName: plugin.name || internalName || providerId
      }).filter((stream) => this.isUsableStream(stream));
    } catch (error) {
      if (!isExpectedAbort(error)) {
        this.logger.info?.('cloudstream phisher provider failed', {
          plugin: internalName,
          provider: providerId,
          error: error?.message || String(error)
        });
      }
      return [];
    }
  }

  getProviderTimeoutMs(providerId) {
    if (providerId === '4khdhub' || providerId === 'hdhub4u' || providerId === 'uhdmovies') {
      return Math.max(this.providerTimeoutMs, 12_000);
    }

    if (providerId === 'showbox') {
      return Math.max(this.providerTimeoutMs, 20_000);
    }

    return this.providerTimeoutMs;
  }

  isUsableStream(stream) {
    if (!stream?.url && !stream?.magnet) return false;

    if (stream?.url) {
      try {
        const parsed = new URL(String(stream.url));
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      } catch {
        return false;
      }
    }

    const text = `${stream?.title || ''} ${stream?.name || ''}`.toLowerCase();
    if (text.includes('cloudstream') && text.includes('install')) return false;
    return true;
  }

  loadProviderModule(providerId) {
    if (this.moduleCache.has(providerId)) {
      return this.moduleCache.get(providerId);
    }

    const modulePath = path.join(PROVIDERS_DIR, `${providerId}.js`);
    const loaded = require(modulePath);

    if (!loaded || typeof loaded.getStreams !== 'function') {
      throw new Error(`Mapped provider ${providerId} does not export getStreams()`);
    }

    this.moduleCache.set(providerId, loaded);
    return loaded;
  }
}
