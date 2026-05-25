import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';

const DEFAULT_BASE_URL = 'https://87d6a6ef6b58-webstreamrmbg.baby-beamup.club';

const toMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();
  return normalized === 'series' || normalized === 'tv' ? 'series' : 'movie';
};

const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/u, '');

const isExpectedAbort = (error) => {
  const message = String(error?.message || error || '');
  return error?.name === 'AbortError'
    || message === 'The operation was aborted'
    || message === 'Provider request cancelled'
    || message.includes('R3 plugin adapter timed out');
};

export class R3PluginAdapter extends PluginProviderAdapter {
  constructor({
    logger = console,
    baseUrl = process.env.R3_PLUGIN_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs = Number(process.env.R3_PLUGIN_TIMEOUT_MS || 40_000)
  } = {}) {
    super({ id: 'r3-plugin', logger });
    this.baseUrl = stripTrailingSlash(baseUrl);
    this.timeoutMs = Math.max(5_000, Number(timeoutMs) || 40_000);
  }

  async getManifest() {
    return {
      id: this.id,
      name: 'R3-plugin',
      providers: ['webstreamrmbg']
    };
  }

  async getStreams(request) {
    const id = this.buildStreamId(request);
    if (!id) return [];

    const mediaType = toMediaType(request.mediaType);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('R3 plugin adapter timed out')),
      this.timeoutMs
    );
    timeout.unref?.();

    const abortFromParent = () => controller.abort(request.signal.reason || new Error('Provider request cancelled'));
    if (request.signal) {
      if (request.signal.aborted) abortFromParent();
      else request.signal.addEventListener('abort', abortFromParent, { once: true });
    }

    try {
      const url = `${this.baseUrl}/stream/${encodeURIComponent(mediaType)}/${encodeURIComponent(id)}.json`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'NebulaStreams/1.0 (+R3-plugin)'
        }
      });

      if (!response.ok) {
        this.logger.info?.('r3 plugin request failed', {
          status: response.status,
          mediaType,
          id
        });
        return [];
      }

      const payload = await response.json();
      return normalizePluginStreams(payload?.streams, {
        adapterId: this.id,
        pluginId: 'webstreamrmbg',
        pluginName: 'R3-plugin'
      })
        .map((stream) => this.relabelStream(stream))
        .filter((stream) => this.isUsableStream(stream));
    } catch (error) {
      if (!isExpectedAbort(error)) {
        this.logger.info?.('r3 plugin adapter failed', {
          error: error?.message || String(error)
        });
      }
      return [];
    } finally {
      clearTimeout(timeout);
      if (request.signal) {
        request.signal.removeEventListener?.('abort', abortFromParent);
      }
    }
  }

  buildStreamId(request) {
    const imdbId = String(request.imdbId || '').trim();
    const tmdbId = String(request.tmdbId || '').trim();
    const baseId = /^tt\d+$/u.test(imdbId) ? imdbId : (tmdbId ? `tmdb:${tmdbId}` : '');
    if (!baseId) return null;

    if (toMediaType(request.mediaType) !== 'series') {
      return baseId;
    }

    const season = Number(request.season);
    const episode = Number(request.episode);
    if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode) || episode <= 0) {
      return null;
    }

    return `${baseId}:${season}:${episode}`;
  }

  relabelStream(stream) {
    const replaceLabel = (value) =>
      String(value || '').replace(/WebStreamrMBG/gu, 'R3-plugin').trim();

    return {
      ...stream,
      provider: this.id,
      sourceProvider: 'r3-plugin:webstreamrmbg',
      pluginProvider: 'webstreamrmbg',
      pluginProviderName: 'R3-plugin',
      sourceSite: 'R3-plugin',
      name: replaceLabel(stream.name) || 'R3-plugin',
      title: replaceLabel(stream.title) || 'R3-plugin',
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        bingeGroup: stream.behaviorHints?.bingeGroup || 'r3-plugin:webstreamrmbg'
      }
    };
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
