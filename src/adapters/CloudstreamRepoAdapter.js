import { createRequire } from 'node:module';
import path from 'node:path';

import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';
import { withTimeout } from '../utils/timeout.js';

const require = createRequire(import.meta.url);
const PROVIDERS_DIR = path.resolve(process.cwd(), 'vendor/HTTP/providers');

const DEFAULT_PLUGIN_ORDER = Object.freeze([]);
const DEFAULT_PROVIDER_MAP = Object.freeze({});

const normalizeKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '');

const toMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();
  return normalized === 'series' || normalized === 'tv' ? 'tv' : 'movie';
};

const supportsMediaType = (plugin, mediaType) => {
  const tvTypes = Array.isArray(plugin?.tvTypes)
    ? plugin.tvTypes.map((type) => String(type || '').trim().toLowerCase())
    : [];

  if (tvTypes.includes('all')) return true;
  if (mediaType === 'movie') {
    return tvTypes.some((type) => ['movie', 'movies', 'animemovie', 'animemovies', 'documentary'].includes(type));
  }

  return tvTypes.some((type) => ['tvseries', 'series', 'anime', 'asiandrama', 'cartoon', 'ova', 'drama'].includes(type));
};

const isExpectedAbort = (error) => {
  const message = String(error?.message || error || '');
  return message === 'The operation was aborted'
    || message === 'Provider request cancelled'
    || message.includes('adapter finished');
};

export class CloudstreamRepoAdapter extends PluginProviderAdapter {
  constructor({
    id,
    name,
    cache,
    logger = console,
    repoUrl,
    providerMap = DEFAULT_PROVIDER_MAP,
    providerOrder = DEFAULT_PLUGIN_ORDER,
    providerConcurrency = 3,
    providerTimeoutMs = 12_000,
    overallTimeoutMs = 24_000,
    earlyReturnStreams = 12
  }) {
    super({ id, logger });
    this.name = name || id;
    this.cache = cache;
    this.repoUrl = repoUrl;
    this.providerMap = new Map(Object.entries(providerMap).map(([key, value]) => [normalizeKey(key), value]));
    this.providerOrder = providerOrder.map((name) => normalizeKey(name));
    this.providerConcurrency = Math.max(1, Number(providerConcurrency) || 3);
    this.providerTimeoutMs = Math.max(3_000, Number(providerTimeoutMs) || 12_000);
    this.overallTimeoutMs = Math.max(5_000, Number(overallTimeoutMs) || 24_000);
    this.earlyReturnStreams = Math.max(1, Number(earlyReturnStreams) || 12);
    this.moduleCache = new Map();
  }

  async getRepository(signal = null) {
    return this.cache.getJson(`${this.id}/repo`, this.repoUrl, {
      signal,
      ttlMs: 60 * 60 * 1000
    });
  }

  async getManifest(signal = null) {
    const repo = await this.getRepository(signal);
    const pluginLists = Array.isArray(repo?.pluginLists) ? repo.pluginLists : [];
    const settled = await Promise.allSettled(pluginLists.map((url, index) =>
      this.cache.getJson(`${this.id}/plugins/${index}`, url, {
        signal,
        ttlMs: 60 * 60 * 1000
      })
    ));

    const plugins = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter((plugin) => plugin && typeof plugin === 'object');

    return { ...repo, plugins };
  }

  async getStreams(request) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`${this.name} adapter timed out`)),
      this.overallTimeoutMs
    );
    timeout.unref?.();

    try {
      const manifest = await this.getManifest(controller.signal);
      const plugins = this.selectPlugins(manifest, request);
      return await this.runPlugins(plugins, request, controller.signal);
    } finally {
      clearTimeout(timeout);
      controller.abort(new Error(`${this.name} adapter finished`));
    }
  }

  selectPlugins(manifest, request) {
    const mediaType = toMediaType(request.mediaType);
    const enabled = (Array.isArray(manifest?.plugins) ? manifest.plugins : [])
      .filter((plugin) => Number(plugin?.status) === 1)
      .filter((plugin) => supportsMediaType(plugin, mediaType))
      .filter((plugin) => Boolean(this.getMappedProviderId(plugin)));

    return enabled.sort((left, right) => this.getPluginOrder(left) - this.getPluginOrder(right));
  }

  getPluginOrder(plugin) {
    const keys = [
      normalizeKey(plugin?.internalName),
      normalizeKey(plugin?.name)
    ];

    const index = keys
      .map((key) => this.providerOrder.indexOf(key))
      .filter((value) => value >= 0)
      .sort((left, right) => left - right)[0];

    return Number.isInteger(index) ? index : Number.MAX_SAFE_INTEGER;
  }

  getMappedProviderId(plugin) {
    const keys = [
      normalizeKey(plugin?.internalName),
      normalizeKey(plugin?.name)
    ];

    for (const key of keys) {
      const mapped = this.providerMap.get(key);
      if (mapped) return mapped;
    }

    return null;
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
    try {
      if (signal?.aborted) {
        throw signal.reason || new Error('Provider request cancelled');
      }

      const rawStreams = await this.runMappedProvider(plugin, request);

      const pluginId = normalizeKey(plugin?.internalName || plugin?.name);
      return normalizePluginStreams(rawStreams, {
        adapterId: this.id,
        pluginId,
        pluginName: plugin?.name || plugin?.internalName || this.name
      }).filter((stream) => this.isUsableStream(stream));
    } catch (error) {
      if (!isExpectedAbort(error)) {
        this.logger.info?.('cloudstream repo plugin failed', {
          adapter: this.id,
          plugin: plugin?.internalName || plugin?.name,
          error: error?.message || String(error)
        });
      }
      return [];
    }
  }

  async runMappedProvider(plugin, request) {
    const providerId = this.getMappedProviderId(plugin);
    if (!providerId) return [];

    const providerModule = this.loadProviderModule(providerId);
    return withTimeout(
      () => Promise.resolve(providerModule.getStreams(
        String(request.tmdbId || ''),
        toMediaType(request.mediaType),
        request.season,
        request.episode
      )),
      this.providerTimeoutMs,
      `${this.name} mapped provider ${providerId} timed out`
    );
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

  isUsableStream(stream) {
    if (!stream?.url && !stream?.magnet) return false;
    if (!stream?.url) return true;

    try {
      const parsed = new URL(String(stream.url));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
}
