import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';

const SOURCES = Object.freeze([
  {
    id: 'dramayo',
    name: 'R4 DramaYo',
    baseUrl: 'https://dramayo.stream',
    idModes: ['imdb']
  },
  {
    id: 'yastream',
    name: 'R4 Yastream',
    baseUrl: 'https://yastream.tamthai.de',
    idModes: ['imdb', 'tmdb']
  }
]);
const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/u, '');

const toMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();
  return normalized === 'series' || normalized === 'tv' ? 'series' : 'movie';
};

const isExpectedAbort = (error) => {
  const message = String(error?.message || error || '');
  return error?.name === 'AbortError'
    || message === 'The operation was aborted'
    || message === 'Provider request cancelled'
    || message.includes('R4 Asian adapter timed out');
};

export class R4AsianDramaMoviesAdapter extends PluginProviderAdapter {
  constructor({
    logger = console,
    timeoutMs = Number(process.env.R4_ASIAN_TIMEOUT_MS || 18_000),
    sourceTimeoutMs = Number(process.env.R4_ASIAN_SOURCE_TIMEOUT_MS || 9_000)
  } = {}) {
    super({ id: 'r4-asian-drama-movies', logger });
    this.timeoutMs = Math.max(5_000, Number(timeoutMs) || 18_000);
    this.sourceTimeoutMs = Math.max(3_000, Number(sourceTimeoutMs) || 9_000);
    this.sources = SOURCES.map((source) => ({
      ...source,
      baseUrl: stripTrailingSlash(source.baseUrl)
    }));
  }

  async getManifest() {
    return {
      id: this.id,
      name: 'r4-Asian drama and movies',
      providers: this.sources.map((source) => source.id)
    };
  }

  async getStreams(request) {
    const mediaType = toMediaType(request.mediaType);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('R4 Asian adapter timed out')),
      this.timeoutMs
    );
    timeout.unref?.();

    const abortFromParent = () => controller.abort(request.signal?.reason || new Error('Provider request cancelled'));
    if (request.signal) {
      if (request.signal.aborted) abortFromParent();
      else request.signal.addEventListener('abort', abortFromParent, { once: true });
    }

    try {
      const tasks = [];
      const selected = this.getRequestedSourceSet(request);
      for (const source of this.sources) {
        if (selected && !selected.has(source.id)) continue;
        for (const id of this.buildStreamIds(request, source, mediaType)) {
          tasks.push(this.fetchSource(source, mediaType, id, controller.signal, request.privateProviderSettings));
        }
      }

      if (tasks.length === 0) return [];

      const settled = await Promise.allSettled(tasks);
      return this.dedupeStreams(settled
        .filter((result) => result.status === 'fulfilled')
        .flatMap((result) => result.value));
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener?.('abort', abortFromParent);
    }
  }

  getRequestedSourceSet(request) {
    const selections = request?.pluginProviderSelections || request?.streamOptions?.pluginProviderSelections || {};
    const selected = selections[this.id] || selections[request?.providerId] || null;
    if (!Array.isArray(selected) || selected.length === 0) return null;
    return new Set(selected.map((providerId) => String(providerId || '').trim().toLowerCase()).filter(Boolean));
  }

  buildStreamIds(request, source, mediaType) {
    const imdbId = String(request.imdbId || '').trim();
    const tmdbId = String(request.tmdbId || '').trim();
    const ids = [];

    if (source.idModes.includes('imdb') && /^tt\d+$/u.test(imdbId)) {
      ids.push(imdbId);
    }

    if (source.idModes.includes('tmdb') && tmdbId) {
      ids.push(`tmdb:${tmdbId}`);
    }

    if (mediaType !== 'series') {
      return ids;
    }

    const season = Number(request.season);
    const episode = Number(request.episode);
    if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode) || episode <= 0) {
      return [];
    }

    return ids.map((id) => `${id}:${season}:${episode}`);
  }

  async fetchSource(source, mediaType, id, parentSignal, privateProviderSettings = null) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('R4 Asian source timed out')),
      this.sourceTimeoutMs
    );
    timeout.unref?.();

    const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('Provider request cancelled'));
    if (parentSignal) {
      if (parentSignal.aborted) abortFromParent();
      else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }

    try {
      const baseUrl = this.getSourceBaseUrl(source, privateProviderSettings);
      const url = `${baseUrl}/stream/${encodeURIComponent(mediaType)}/${encodeURIComponent(id)}.json`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'NebulaStreams/1.0 (+R4-Asian)'
        }
      });

      if (!response.ok) {
        this.logger.info?.('r4 asian source request failed', {
          source: source.id,
          status: response.status,
          mediaType,
          id
        });
        return [];
      }

      const payload = await response.json();
      return normalizePluginStreams(payload?.streams, {
        adapterId: this.id,
        pluginId: source.id,
        pluginName: source.name
      })
        .map((stream) => this.relabelStream(stream, source))
        .filter((stream) => this.isUsableStream(stream));
    } catch (error) {
      if (!isExpectedAbort(error)) {
        this.logger.info?.('r4 asian source failed', {
          source: source.id,
          error: error?.message || String(error)
        });
      }
      return [];
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener?.('abort', abortFromParent);
    }
  }

  getSourceBaseUrl(source) {
    return source.baseUrl;
  }

  relabelStream(stream, source) {
    const title = stream.title || stream.description || stream.name || source.name;
    return {
      ...stream,
      provider: this.id,
      sourceProvider: `${this.id}:${source.id}`,
      pluginProvider: source.id,
      pluginProviderName: source.name,
      sourceSite: source.name,
      name: source.name,
      title,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        bingeGroup: stream.behaviorHints?.bingeGroup || `${this.id}:${source.id}`
      }
    };
  }

  isUsableStream(stream) {
    if (!stream?.url && !stream?.magnet) return false;
    if (!stream?.url) return true;

    try {
      const parsed = new URL(String(stream.url));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return this.isDirectMediaUrl(stream.url);
    } catch {
      return false;
    }
  }

  isDirectMediaUrl(url) {
    try {
      const parsed = new URL(String(url));
      return /\.(?:m3u8|mp4)(?:$|[?#])/iu.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  dedupeStreams(streams) {
    const seen = new Set();
    const deduped = [];

    for (const stream of streams) {
      const key = String(stream.url || stream.magnet || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(stream);
    }

    return deduped;
  }
}
