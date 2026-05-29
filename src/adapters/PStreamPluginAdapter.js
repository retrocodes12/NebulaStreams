import { makeProviders, makeStandardFetcher, targets } from '../../vendor/pstream-providers/index.js';

import { config } from '../../config.js';
import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SOURCE_ORDER = Object.freeze([
  'vidrock',
  'vidlink',
  'ridomovies',
  'fsharetv',
  'rgshows',
  'animekai',
  'lookmovie',
  'movies4f',
  'pelisplushd',
  'tugaflix',
  'fedapi',
  'fedapidb',
  'ee3'
]);
const TOKEN_REQUIRED_SOURCE_IDS = new Set(['fedapi', 'fedapidb', 'ee3']);
const INCLUDE_TOKEN_REQUIRED_SOURCES_BY_DEFAULT = String(process.env.PSTREAM_PLUGIN_INCLUDE_TOKEN_SOURCES || '')
  .trim()
  .toLowerCase() === 'true';

const toInteger = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toYear = (value) => {
  const year = Number.parseInt(String(value || '').slice(0, 4), 10);
  return Number.isInteger(year) && year > 1800 ? year : new Date().getUTCFullYear();
};

const normalizeSourceId = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

const mapQuality = (quality) => {
  const normalized = String(quality || '').trim().toLowerCase();
  if (normalized === '4k' || normalized === '2160') return '2160p';
  if (['1440', '1080', '720', '480', '360'].includes(normalized)) return `${normalized}p`;
  return 'Unknown';
};

const isExpectedAbort = (error) => {
  const message = String(error?.message || error || '');
  return error?.name === 'AbortError'
    || message.includes('P-Stream adapter timed out')
    || message.includes('Provider request cancelled')
    || message.includes('aborted');
};

const withTimeout = async (promise, timeoutMs, controller, message) => {
  const timeout = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  timeout.unref?.();
  try {
    return await promise;
  } finally {
    clearTimeout(timeout);
  }
};

const buildFetchWithAbort = (parentSignal) => async (url, options = {}) => {
  if (!parentSignal && !options.signal) {
    return fetch(url, options);
  }

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return fetch(url, {
      ...options,
      signal: AbortSignal.any([parentSignal, options.signal].filter(Boolean))
    });
  }

  const controller = new AbortController();
  const abort = (signal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal?.reason || new Error('Provider request cancelled'));
    }
  };
  const signals = [parentSignal, options.signal].filter(Boolean);
  const listeners = [];

  for (const signal of signals) {
    if (signal.aborted) abort(signal);
    else {
      const listener = () => abort(signal);
      listeners.push([signal, listener]);
      signal.addEventListener('abort', listener, { once: true });
    }
  }

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener);
    }
  }
};

export class PStreamPluginAdapter extends PluginProviderAdapter {
  constructor({
    id = 'pstream-plugin',
    name = 'P-Stream plugin',
    pluginName = 'P-Stream',
    logger = console,
    timeoutMs = Number(process.env.PSTREAM_PLUGIN_TIMEOUT_MS || 18_000),
    sourceLimit = Number(process.env.PSTREAM_PLUGIN_SOURCE_LIMIT || 10),
    sourceConcurrency = Number(process.env.PSTREAM_PLUGIN_SOURCE_CONCURRENCY || 3),
    embedConcurrency = Number(process.env.PSTREAM_PLUGIN_EMBED_CONCURRENCY || 3),
    maxEmbedsPerSource = Number(process.env.PSTREAM_PLUGIN_MAX_EMBEDS_PER_SOURCE || 4),
    maxStreams = Number(process.env.PSTREAM_PLUGIN_MAX_STREAMS || 32)
  } = {}) {
    super({ id, logger });
    this.name = name;
    this.pluginName = pluginName;
    this.timeoutMs = Math.max(8_000, timeoutMs || 18_000);
    this.sourceLimit = Math.max(1, sourceLimit || 6);
    this.sourceConcurrency = Math.max(1, sourceConcurrency || 3);
    this.embedConcurrency = Math.max(1, embedConcurrency || 4);
    this.maxEmbedsPerSource = Math.max(1, maxEmbedsPerSource || 4);
    this.maxStreams = Math.max(1, maxStreams || 20);
    this.metadataCache = new Map();
  }

  createProviderControls(signal = null) {
    const fetcher = makeStandardFetcher(buildFetchWithAbort(signal));
    return makeProviders({
      fetcher,
      proxiedFetcher: fetcher,
      target: targets.NATIVE,
      consistentIpForRequests: true,
      externalSources: 'all',
      proxyStreams: false
    });
  }

  async getManifest() {
    const providers = this.createProviderControls()
      .listSources()
      .sort((a, b) => (b.rank || 0) - (a.rank || 0))
      .map((source) => ({
        id: source.id,
        label: source.name || source.id,
        name: source.name || source.id,
        mediaTypes: source.mediaTypes || []
      }));

    return {
      id: this.id,
      name: this.name,
      providers
    };
  }

  async getStreams(request) {
    const tmdbId = toInteger(request.tmdbId);
    if (!tmdbId) return [];

    const controller = new AbortController();
    const abortFromParent = () => controller.abort(request.signal?.reason || new Error('Provider request cancelled'));
    if (request.signal) {
      if (request.signal.aborted) abortFromParent();
      else request.signal.addEventListener('abort', abortFromParent, { once: true });
    }

    try {
      return await withTimeout(
        this.collectStreams({ ...request, tmdbId, signal: controller.signal }),
        this.timeoutMs,
        controller,
        'P-Stream adapter timed out'
      );
    } catch (error) {
      if (!isExpectedAbort(error)) {
        this.logger.info?.('p-stream plugin adapter failed', {
          error: error?.message || String(error)
        });
      }
      return [];
    } finally {
      request.signal?.removeEventListener?.('abort', abortFromParent);
    }
  }

  async collectStreams(request) {
    const controls = this.createProviderControls(request.signal);
    const metadata = await this.getMetadata(request, request.signal);
    if (!metadata) return [];

    const media = this.buildMedia(request, metadata);
    if (!media) return [];

    const available = controls.listSources()
      .filter((source) => !Array.isArray(source.mediaTypes) || source.mediaTypes.includes(media.type))
      .sort((a, b) => (b.rank || 0) - (a.rank || 0));
    const availableIds = new Set(available.map((source) => source.id));
    const selected = this.getSelectedSourceIds(request)
      .filter((sourceId) => availableIds.has(sourceId));
    const ordered = selected.length > 0
      ? selected
      : DEFAULT_SOURCE_ORDER.filter((sourceId) =>
        availableIds.has(sourceId)
        && (INCLUDE_TOKEN_REQUIRED_SOURCES_BY_DEFAULT || !TOKEN_REQUIRED_SOURCE_IDS.has(sourceId))
      );
    const sourceIds = [...new Set(ordered)].slice(0, this.sourceLimit);

    const sourceResults = await this.runLimited(sourceIds, this.sourceConcurrency, async (sourceId) => {
      try {
        return await controls.runSourceScraper({
          id: sourceId,
          media,
          disableOpensubtitles: true
        });
      } catch (error) {
        if (!isExpectedAbort(error)) {
          this.logger.info?.('p-stream source failed', {
            source: sourceId,
            error: error?.message || String(error)
          });
        }
        return null;
      }
    }, request.signal);

    const rawStreams = [];
    const embedJobs = [];

    sourceResults.forEach((result, index) => {
      const sourceId = sourceIds[index];
      const directStreams = Array.isArray(result?.stream) ? result.stream : [];
      rawStreams.push(...directStreams.flatMap((stream) => this.toRawStreams(stream, sourceId, null)));

      const embeds = (Array.isArray(result?.embeds) ? result.embeds : [])
        .filter((embed) => embed?.embedId && embed?.url)
        .slice(0, this.maxEmbedsPerSource);

      for (const embed of embeds) {
        embedJobs.push({ sourceId, embedId: embed.embedId, url: embed.url });
      }
    });

    const embedResults = await this.runLimited(embedJobs, this.embedConcurrency, async (job) => {
      try {
        return {
          job,
          output: await controls.runEmbedScraper({
            id: job.embedId,
            url: job.url,
            disableOpensubtitles: true
          })
        };
      } catch (error) {
        if (!isExpectedAbort(error)) {
          this.logger.info?.('p-stream embed failed', {
            source: job.sourceId,
            embed: job.embedId,
            error: error?.message || String(error)
          });
        }
        return null;
      }
    }, request.signal);

    for (const result of embedResults) {
      const streams = Array.isArray(result?.output?.stream) ? result.output.stream : [];
      rawStreams.push(...streams.flatMap((stream) => this.toRawStreams(stream, result.job.sourceId, result.job.embedId)));
      if (rawStreams.length >= this.maxStreams) break;
    }

    return normalizePluginStreams(rawStreams.slice(0, this.maxStreams), {
      adapterId: this.id,
      pluginId: 'p-stream',
      pluginName: this.pluginName
    }).map((stream) => {
      const sourceId = normalizeSourceId(stream.source || stream.pluginProviderName || 'p-stream');
      const sourceLabel = stream.sourceSite && stream.sourceSite !== this.pluginName
        ? stream.sourceSite
        : (stream.source || sourceId);
      return {
        ...stream,
        provider: this.id,
        sourceProvider: `${this.id}:${sourceId}`,
        pluginProvider: sourceId,
        pluginProviderName: sourceLabel,
        sourceSite: sourceLabel,
        name: `${this.pluginName} ${sourceLabel} ${stream.quality || 'Unknown'}`.trim(),
        behaviorHints: {
          ...(stream.behaviorHints || {}),
          bingeGroup: `${this.id}:${sourceId}`
        }
      };
    });
  }

  getSelectedSourceIds(request) {
    const selections = request.streamOptions?.pluginProviderSelections;
    const raw = selections?.[this.id] || selections?.pstream || selections?.['p-stream'] || selections?.['pstream-plugin'];
    return (Array.isArray(raw) ? raw : [])
      .map((entry) => normalizeSourceId(entry))
      .filter(Boolean);
  }

  async runLimited(items, concurrency, worker, signal) {
    const results = new Array(items.length).fill(null);
    let cursor = 0;

    const runWorker = async () => {
      while (cursor < items.length && !signal?.aborted) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    };

    await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
    );
    return results;
  }

  toRawStreams(stream, sourceId, embedId) {
    if (!stream || typeof stream !== 'object') return [];

    const headers = stream.headers || stream.preferredHeaders || null;
    const sourceLabel = embedId ? `${sourceId}/${embedId}` : sourceId;
    const common = {
      provider: sourceId,
      source: sourceId,
      sourceSite: sourceLabel,
      headers,
      behaviorHints: {
        ...(headers ? { proxyHeaders: { request: headers } } : {}),
        bingeGroup: `${this.id}:${sourceId}:${embedId || 'direct'}`
      }
    };

    if (stream.type === 'hls' && stream.playlist) {
      return [{
        ...common,
        url: stream.playlist,
        name: `${this.pluginName} ${sourceLabel} HLS`,
        title: `${sourceLabel} HLS`,
        quality: 'Unknown'
      }];
    }

    if (stream.type !== 'file' || !stream.qualities || typeof stream.qualities !== 'object') {
      return [];
    }

    return Object.entries(stream.qualities)
      .filter(([, file]) => file?.url)
      .map(([quality, file]) => ({
        ...common,
        url: file.url,
        name: `${this.pluginName} ${sourceLabel} ${mapQuality(quality)}`.trim(),
        title: sourceLabel,
        quality: mapQuality(quality),
        behaviorHints: {
          ...common.behaviorHints,
          notWebReady: file.type !== 'mp4'
        }
      }));
  }

  buildMedia(request, metadata) {
    const mediaType = String(request.mediaType || 'movie').toLowerCase() === 'tv' ? 'show' : 'movie';
    const base = {
      title: metadata.title,
      releaseYear: metadata.releaseYear,
      tmdbId: String(request.tmdbId),
      ...(metadata.imdbId ? { imdbId: metadata.imdbId } : {})
    };

    if (mediaType === 'movie') {
      return {
        ...base,
        type: 'movie'
      };
    }

    const season = toInteger(request.season);
    const episode = toInteger(request.episode);
    if (!season || !episode) return null;

    return {
      ...base,
      type: 'show',
      season: {
        number: season,
        tmdbId: String(metadata.seasonTmdbId || season),
        title: metadata.seasonTitle || `Season ${season}`,
        episodeCount: metadata.episodeCount || undefined
      },
      episode: {
        number: episode,
        tmdbId: String(metadata.episodeTmdbId || episode)
      }
    };
  }

  async getMetadata(request, signal) {
    const mediaType = String(request.mediaType || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
    const season = toInteger(request.season);
    const episode = toInteger(request.episode);
    const key = `${mediaType}:${request.tmdbId}:${season || ''}:${episode || ''}`;
    const cached = this.metadataCache.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const base = await this.fetchTmdbJson(`https://api.themoviedb.org/3/${endpoint}/${request.tmdbId}?api_key=${config.TMDB_API_KEY}&append_to_response=external_ids`, signal);
    if (!base) return null;

    const value = {
      title: mediaType === 'tv'
        ? (base.name || base.original_name || `TMDB ${request.tmdbId}`)
        : (base.title || base.original_title || `TMDB ${request.tmdbId}`),
      releaseYear: toYear(mediaType === 'tv' ? base.first_air_date : base.release_date),
      imdbId: request.imdbId || base.external_ids?.imdb_id || null
    };

    if (mediaType === 'tv' && season && episode) {
      const [seasonPayload, episodePayload] = await Promise.all([
        this.fetchTmdbJson(`https://api.themoviedb.org/3/tv/${request.tmdbId}/season/${season}?api_key=${config.TMDB_API_KEY}`, signal),
        this.fetchTmdbJson(`https://api.themoviedb.org/3/tv/${request.tmdbId}/season/${season}/episode/${episode}?api_key=${config.TMDB_API_KEY}`, signal)
      ]);
      value.seasonTmdbId = seasonPayload?.id || null;
      value.seasonTitle = seasonPayload?.name || null;
      value.episodeCount = Array.isArray(seasonPayload?.episodes) ? seasonPayload.episodes.length : null;
      value.episodeTmdbId = episodePayload?.id || null;
    }

    this.metadataCache.set(key, {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS
    });

    if (this.metadataCache.size > 500) {
      const firstKey = this.metadataCache.keys().next().value;
      this.metadataCache.delete(firstKey);
    }

    return value;
  }

  async fetchTmdbJson(url, signal) {
    try {
      const response = await fetch(url, {
        signal,
        headers: {
          accept: 'application/json',
          'user-agent': `NebulaStreams/1.0 (+${this.id})`
        }
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      if (!isExpectedAbort(error)) {
        this.logger.info?.('p-stream tmdb metadata failed', {
          error: error?.message || String(error)
        });
      }
      return null;
    }
  }
}
