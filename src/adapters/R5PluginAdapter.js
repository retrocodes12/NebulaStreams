import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';

const DEFAULT_BASE_URL = 'https://nuvio-addon.tenies.site/abckdhfik-34585674';

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
    || message.includes('R5 plugin adapter timed out');
};

const inferQuality = (stream) => {
  const text = `${String(stream?.quality || '')} ${String(stream?.name || '')} ${String(stream?.title || '')}`.toLowerCase();

  if (/\b(?:2160p|4k|uhd)\b/u.test(text)) return '2160p';
  if (/\b1440p\b/u.test(text)) return '1440p';
  if (/\b1080p\b/u.test(text)) return '1080p';
  if (/\b720p\b/u.test(text)) return '720p';
  if (/\b480p\b/u.test(text)) return '480p';
  if (/\b360p\b/u.test(text)) return '360p';

  return stream?.quality || 'Unknown';
};

const parseSizeInfo = (stream) => {
  const text = `${String(stream?.size || '')} ${String(stream?.title || '')}`.toLowerCase();
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(gb|mb)\b/u);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2].toUpperCase();
  return {
    label: `${match[1]} ${unit}`,
    bytes: Math.round(value * (unit === 'GB' ? 1024 ** 3 : 1024 ** 2))
  };
};

const isPlayableExternalUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim());
    const host = parsed.hostname.toLowerCase();

    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? host === 'cdn.pixeldrain.eu.cc'
        || host.endsWith('.pixeldrain.eu.cc')
        || host.endsWith('.r2.dev')
      : false;
  } catch {
    return false;
  }
};

const prepareRawStreams = (streams) =>
  (Array.isArray(streams) ? streams : [])
    .filter((stream) => {
      const text = `${String(stream?.name || '')} ${String(stream?.title || '')} ${String(stream?.externalUrl || '')}`.toLowerCase();
      return !text.includes('buymeacoffee') && !text.includes('support us');
    })
    .map((stream) => {
      if (stream?.url || !isPlayableExternalUrl(stream?.externalUrl)) {
        return stream;
      }

      const sizeInfo = parseSizeInfo(stream);
      return {
        ...stream,
        url: stream.externalUrl,
        ...(sizeInfo ? { size: sizeInfo.label } : {}),
        behaviorHints: {
          ...(stream.behaviorHints || {}),
          ...(sizeInfo?.bytes ? { videoSize: sizeInfo.bytes } : {})
        }
      };
    });

export class R5PluginAdapter extends PluginProviderAdapter {
  constructor({
    logger = console,
    baseUrl = process.env.R5_PLUGIN_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs = Number(process.env.R5_PLUGIN_TIMEOUT_MS || 28_000)
  } = {}) {
    super({ id: 'r5-plugin', logger });
    this.baseUrl = stripTrailingSlash(baseUrl);
    this.timeoutMs = Math.max(5_000, Number(timeoutMs) || 28_000);
  }

  async getManifest() {
    return {
      id: this.id,
      name: 'r5-plugin',
      providers: ['tenies-site']
    };
  }

  async getStreams(request) {
    const id = this.buildStreamId(request);
    if (!id) return [];

    const mediaType = toMediaType(request.mediaType);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('R5 plugin adapter timed out')),
      this.timeoutMs
    );
    timeout.unref?.();

    const abortFromParent = () => controller.abort(request.signal?.reason || new Error('Provider request cancelled'));
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
          'user-agent': 'NebulaStreams/1.0 (+r5-plugin)'
        }
      });

      if (!response.ok) {
        this.logger.info?.('r5 plugin request failed', {
          status: response.status,
          mediaType,
          id
        });
        return [];
      }

      const payload = await response.json();
      return normalizePluginStreams(prepareRawStreams(payload?.streams), {
        adapterId: this.id,
        pluginId: 'tenies-site',
        pluginName: 'r5-plugin'
      })
        .map((stream) => this.relabelStream(stream))
        .filter((stream) => this.isUsableStream(stream));
    } catch (error) {
      if (!isExpectedAbort(error)) {
        this.logger.info?.('r5 plugin adapter failed', {
          error: error?.message || String(error)
        });
      }
      return [];
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener?.('abort', abortFromParent);
    }
  }

  buildStreamId(request) {
    const imdbId = String(request.imdbId || '').trim();
    if (!/^tt\d+$/u.test(imdbId)) return null;

    if (toMediaType(request.mediaType) !== 'series') {
      return imdbId;
    }

    const season = Number(request.season);
    const episode = Number(request.episode);
    if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode) || episode <= 0) {
      return null;
    }

    return `${imdbId}:${season}:${episode}`;
  }

  relabelStream(stream) {
    const quality = inferQuality(stream);
    const behaviorHints = { ...(stream.behaviorHints || {}) };
    delete behaviorHints.notWebReady;

    return {
      ...stream,
      provider: this.id,
      sourceProvider: 'r5-plugin:tenies-site',
      pluginProvider: 'tenies-site',
      pluginProviderName: 'r5-plugin',
      quality,
      name: `r5-plugin ${quality}`.trim(),
      title: '',
      description: '',
      filename: `R5 Plugin ${quality}.mp4`,
      fileName: undefined,
      sourceSite: undefined,
      behaviorHints: {
        ...behaviorHints,
        notWebReady: false,
        bingeGroup: stream.behaviorHints?.bingeGroup || 'r5-plugin:tenies-site'
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
