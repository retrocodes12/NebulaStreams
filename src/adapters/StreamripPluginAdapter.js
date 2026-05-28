import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';

const DEFAULT_BASE_URL = 'https://streamrip-website-production.up.railway.app';

const stripTrailingSlash = (value) => String(value || '').replace(/\/+$/u, '');

const isExpectedAbort = (error) => {
  const message = String(error?.message || error || '');
  return error?.name === 'AbortError'
    || message === 'The operation was aborted'
    || message === 'Provider request cancelled'
    || message.includes('Streamrip adapter timed out');
};

const toMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();
  return normalized === 'series' || normalized === 'tv' ? 'tv' : 'movie';
};

const inferQuality = (download) => {
  const explicit = Number(download?.quality);
  if (Number.isFinite(explicit) && explicit > 0) return `${explicit}p`;

  const text = `${download?.server || ''} ${download?.size || ''}`.toLowerCase();
  if (/\b(?:2160p|4k|uhd)\b/u.test(text)) return '2160p';
  if (/\b1440p\b/u.test(text)) return '1440p';
  if (/\b1080p\b/u.test(text)) return '1080p';
  if (/\b720p\b/u.test(text)) return '720p';
  if (/\b480p\b/u.test(text)) return '480p';
  if (/\b360p\b/u.test(text)) return '360p';
  return 'Unknown';
};

const parseSizeBytes = (value) => {
  const match = String(value || '').match(/\b(\d+(?:\.\d+)?)\s*(gb|mb)\b/iu);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return Math.round(amount * (match[2].toLowerCase() === 'gb' ? 1024 ** 3 : 1024 ** 2));
};

const getHost = (value) => {
  try {
    return new URL(String(value || '').trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const isDirectDownloadUrl = (value) => {
  const host = getHost(value);
  if (!host) return false;

  return host === 'pixeldrain.dev'
    || host === 'pixeldrain.com'
    || host.endsWith('.googleusercontent.com')
    || host === 'cdn.pixeldrain.eu.cc'
    || host.endsWith('.pixeldrain.eu.cc');
};

const isHttpUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const sourceToPluginId = (source) =>
  String(source || 'streamrip')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'streamrip';

export class StreamripPluginAdapter extends PluginProviderAdapter {
  constructor({
    logger = console,
    baseUrl = process.env.STREAMRIP_PLUGIN_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs = Number(process.env.STREAMRIP_PLUGIN_TIMEOUT_MS || 22_000)
  } = {}) {
    super({ id: 'streamrip-plugin', logger });
    this.baseUrl = stripTrailingSlash(baseUrl);
    this.timeoutMs = Math.max(5_000, Number(timeoutMs) || 22_000);
  }

  async getManifest() {
    return {
      id: this.id,
      name: 'Streamrip plugin',
      providers: ['VegaMovies', 'Movies4u', 'MoviesDrive', 'HDHub4u', 'AnimePahe']
    };
  }

  async getStreams(request) {
    const url = this.buildDownloadUrl(request);
    if (!url) return [];

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Streamrip adapter timed out')),
      this.timeoutMs
    );
    timeout.unref?.();

    const abortFromParent = () => controller.abort(request.signal?.reason || new Error('Provider request cancelled'));
    if (request.signal) {
      if (request.signal.aborted) abortFromParent();
      else request.signal.addEventListener('abort', abortFromParent, { once: true });
    }

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'NebulaStreams/1.0 (+streamrip-plugin)'
        }
      });

      if (!response.ok) {
        this.logger.info?.('streamrip plugin request failed', {
          status: response.status,
          url: url.toString()
        });
        return [];
      }

      const payload = await response.json();
      return this.normalizeDownloads(payload?.downloads);
    } catch (error) {
      if (!isExpectedAbort(error)) {
        this.logger.info?.('streamrip plugin adapter failed', {
          error: error?.message || String(error)
        });
      }
      return [];
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener?.('abort', abortFromParent);
    }
  }

  buildDownloadUrl(request) {
    const tmdbId = Number(request.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;

    const mediaType = toMediaType(request.mediaType);
    const url = new URL(`${this.baseUrl}/api/download/${mediaType}/${tmdbId}`);

    if (mediaType === 'tv') {
      const season = Number(request.season);
      const episode = Number(request.episode);
      if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode) || episode <= 0) {
        return null;
      }
      url.searchParams.set('season', String(season));
      url.searchParams.set('episode', String(episode));
    }

    return url;
  }

  normalizeDownloads(downloads) {
    const rawStreams = (Array.isArray(downloads) ? downloads : [])
      .filter((download) => isHttpUrl(download?.url))
      .map((download) => {
        const source = String(download.source || 'Streamrip').trim() || 'Streamrip';
        const server = String(download.server || source).trim() || source;
        const quality = inferQuality(download);
        const sizeBytes = parseSizeBytes(download.size);
        const direct = isDirectDownloadUrl(download.url);

        return {
          url: download.url,
          name: `Streamrip ${source} ${quality}`.trim(),
          title: `${server}${download.size ? ` [${download.size}]` : ''}`,
          filename: `${source} ${quality}${download.size ? ` ${download.size}` : ''}`.trim(),
          quality,
          size: download.size || null,
          provider: source,
          source,
          behaviorHints: {
            notWebReady: !direct,
            ...(sizeBytes ? { videoSize: sizeBytes } : {}),
            bingeGroup: `streamrip-plugin:${sourceToPluginId(source)}`
          }
        };
      });

    return normalizePluginStreams(rawStreams, {
      adapterId: this.id,
      pluginId: 'streamrip',
      pluginName: 'Streamrip'
    })
      .map((stream) => {
        const source = String(stream.source || stream.pluginProviderName || 'Streamrip').trim() || 'Streamrip';
        const pluginId = sourceToPluginId(source);

        return {
          ...stream,
          provider: this.id,
          sourceProvider: `streamrip-plugin:${pluginId}`,
          pluginProvider: pluginId,
          pluginProviderName: source,
          sourceSite: source,
          name: `Streamrip ${source} ${stream.quality || 'Unknown'}`.trim(),
          title: stream.title || `Streamrip ${source}`,
          behaviorHints: {
            ...(stream.behaviorHints || {}),
            bingeGroup: `streamrip-plugin:${pluginId}`
          }
        };
      });
  }
}
