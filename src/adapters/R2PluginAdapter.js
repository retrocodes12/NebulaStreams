import { createRequire } from 'node:module';
import path from 'node:path';

import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';
import { withTimeout } from '../utils/timeout.js';

const require = createRequire(import.meta.url);

const PROVIDERS_DIR = path.resolve(process.cwd(), 'vendor/HTTP/providers');

const PROVIDER_ORDER = Object.freeze([
  '4khdhub',
  'hdhub4u',
  'uhdmovies',
  'moviesdrive',
  'moviesmod',
  'moviesleech',
  'vixsrc',
  'mkvcinemas',
  'mallumv',
  'cinedoze',
  'animeflix',
  'xdmovies'
]);

const PROVIDER_TIMEOUTS_MS = Object.freeze({
  '4khdhub': 14_000,
  hdhub4u: 14_000,
  uhdmovies: 18_000,
  moviesdrive: 14_000,
  moviesmod: 14_000,
  moviesleech: 12_000,
  vixsrc: 8_000,
  mkvcinemas: 14_000,
  mallumv: 12_000,
  cinedoze: 12_000,
  animeflix: 10_000,
  xdmovies: 12_000
});

const DIRECT_HOST_PATTERNS = Object.freeze([
  /(?:^|\.)r2\.dev$/iu,
  /(?:^|\.)workers\.dev$/iu,
  /(?:^|\.)hubcdn\.fans$/iu,
  /(?:^|\.)pixeldrain\.com$/iu,
  /(?:^|\.)googleusercontent\.com$/iu
]);

const toMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();
  return normalized === 'series' || normalized === 'tv' ? 'tv' : 'movie';
};

const isExpectedAbort = (error) => {
  const message = String(error?.message || error || '');
  return message === 'R2 plugin adapter finished'
    || message === 'The operation was aborted'
    || message === 'Provider request cancelled'
    || message.includes('R2 plugin adapter finished');
};

const hasDirectStorageHost = (stream) => {
  try {
    const host = new URL(String(stream?.url || '')).hostname.toLowerCase();
    return DIRECT_HOST_PATTERNS.some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
};

export class R2PluginAdapter extends PluginProviderAdapter {
  constructor({
    logger = console,
    providerOrder = PROVIDER_ORDER,
    providerConcurrency = Number(process.env.R2_PLUGIN_CONCURRENCY || 3),
    providerTimeoutMs = Number(process.env.R2_PLUGIN_PROVIDER_TIMEOUT_MS || 12_000),
    overallTimeoutMs = Number(process.env.R2_PLUGIN_TIMEOUT_MS || 22_000),
    earlyReturnStreams = Number(process.env.R2_PLUGIN_EARLY_RETURN_STREAMS || 12)
  } = {}) {
    super({ id: 'r2-plugin', logger });
    this.providerOrder = providerOrder;
    this.providerConcurrency = Math.max(1, Number(providerConcurrency) || 3);
    this.providerTimeoutMs = Math.max(3_000, Number(providerTimeoutMs) || 12_000);
    this.overallTimeoutMs = Math.max(5_000, Number(overallTimeoutMs) || 22_000);
    this.earlyReturnStreams = Math.max(1, Number(earlyReturnStreams) || 12);
    this.moduleCache = new Map();
  }

  async getManifest() {
    return {
      id: this.id,
      name: 'R2 plugin',
      providers: [...this.providerOrder]
    };
  }

  async getStreams(request) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('R2 plugin adapter timed out')),
      this.overallTimeoutMs
    );
    timeout.unref?.();

    try {
      return await this.runProviders(request, controller.signal);
    } finally {
      clearTimeout(timeout);
      controller.abort(new Error('R2 plugin adapter finished'));
    }
  }

  async runProviders(request, signal) {
    const results = [];
    let nextIndex = 0;
    const startedAt = Date.now();
    const providers = this.providerOrder.filter((providerId) => this.hasProviderModule(providerId));
    const workerCount = Math.min(this.providerConcurrency, providers.length);

    const worker = async () => {
      while (nextIndex < providers.length && !signal?.aborted && Date.now() - startedAt < this.overallTimeoutMs) {
        const index = nextIndex;
        nextIndex += 1;

        const streams = await this.runProvider(providers[index], request);
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
      Promise.all(Array.from({ length: workerCount }, () => worker())),
      new Promise((resolve) => {
        const timeout = setTimeout(resolve, Math.max(1, this.overallTimeoutMs - (Date.now() - startedAt)));
        timeout.unref?.();
      })
    ]);

    return results
      .sort((left, right) => left.index - right.index)
      .flatMap((result) => result.streams);
  }

  async runProvider(providerId, request) {
    try {
      const providerModule = this.loadProviderModule(providerId);
      const rawStreams = await withTimeout(
        () => Promise.resolve(providerModule.getStreams(
          String(request.tmdbId || ''),
          toMediaType(request.mediaType),
          request.season,
          request.episode
        )),
        PROVIDER_TIMEOUTS_MS[providerId] || this.providerTimeoutMs,
        `R2 plugin provider ${providerId} timed out`
      );
      const normalizedStreams = normalizePluginStreams(rawStreams, {
        adapterId: this.id,
        pluginId: providerId,
        pluginName: 'from adapter'
      }).filter((stream) => this.isUsableStream(stream));
      const directStorageStreams = normalizedStreams.filter(hasDirectStorageHost);
      return directStorageStreams.length > 0 ? directStorageStreams : normalizedStreams;
    } catch (error) {
      if (!isExpectedAbort(error)) {
        this.logger.info?.('r2 plugin provider failed', {
          provider: providerId,
          error: error?.message || String(error)
        });
      }
      return [];
    }
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

  hasProviderModule(providerId) {
    try {
      this.loadProviderModule(providerId);
      return true;
    } catch {
      return false;
    }
  }

  loadProviderModule(providerId) {
    if (this.moduleCache.has(providerId)) {
      return this.moduleCache.get(providerId);
    }

    const modulePath = path.join(PROVIDERS_DIR, `${providerId}.js`);
    const loaded = require(modulePath);

    if (!loaded || typeof loaded.getStreams !== 'function') {
      throw new Error(`R2 plugin provider ${providerId} does not export getStreams()`);
    }

    this.moduleCache.set(providerId, loaded);
    return loaded;
  }
}
