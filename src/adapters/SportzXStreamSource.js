const DEFAULT_BASE_URL = 'https://modiii.top/';
const DEFAULT_FALLBACK_URL = 'https://anshulajoy10.github.io/mygaja/';

const toString = (value) => String(value ?? '').trim();

const isHttpUrl = (value) => {
  try {
    const parsed = new URL(toString(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const normalizeBaseUrl = (value, fallback) => {
  const normalized = toString(value || fallback);
  try {
    const parsed = new URL(normalized.endsWith('/') ? normalized : `${normalized}/`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
};

export class SportzXDecryptUnavailableError extends Error {
  constructor() {
    super('SportzX decrypt unavailable');
    this.name = 'SportzXDecryptUnavailableError';
    this.code = 'SPORTZX_DECRYPT_UNAVAILABLE';
  }
}

export const decryptSportzXData = (_encryptedData) => {
  // TODO: port SportzX DataHelper.help native decrypt from libnative-lib.so.
  // Requires reproducing AES/HMAC key derivation from original APK public cert
  // and package name.
  throw new SportzXDecryptUnavailableError();
};

const extractStreamList = (decryptedPayload) => {
  if (Array.isArray(decryptedPayload)) return decryptedPayload;
  if (!decryptedPayload || typeof decryptedPayload !== 'object') return [];
  for (const key of ['streams', 'sources', 'links', 'channels', 'data']) {
    if (Array.isArray(decryptedPayload[key])) return decryptedPayload[key];
  }
  return [decryptedPayload];
};

const getStreamUrl = (stream) => {
  if (!stream || typeof stream !== 'object') return '';
  return toString(
    stream.link
    || stream.url
    || stream.file
    || stream.stream_url
    || stream.playback_url
  );
};

export class SportzXStreamSource {
  constructor({
    logger = console,
    fetchImpl = globalThis.fetch,
    baseUrl = process.env.SPORTZX_BASE_URL || DEFAULT_BASE_URL,
    fallbackUrl = process.env.SPORTZX_FALLBACK_URL || DEFAULT_FALLBACK_URL
  } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.baseUrls = [
      normalizeBaseUrl(baseUrl, DEFAULT_BASE_URL),
      normalizeBaseUrl(fallbackUrl, DEFAULT_FALLBACK_URL)
    ].filter((entry, index, values) => entry && values.indexOf(entry) === index);
  }

  async fetchEncryptedChannel(channelId, signal = null) {
    const safeChannelId = toString(channelId).replace(/[^a-zA-Z0-9_.-]/gu, '');
    if (!safeChannelId) throw new Error('Invalid SportzX channel id');

    let lastError = null;
    for (const baseUrl of this.baseUrls) {
      const url = new URL(`channels/${encodeURIComponent(safeChannelId)}.json`, baseUrl).toString();
      try {
        const response = await this.fetchImpl(url, {
          signal,
          headers: {
            accept: 'application/json,*/*',
            'User-Agent': 'NebulaStreams/1.0'
          }
        });
        if (!response.ok) throw new Error(`SportzX HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload || typeof payload !== 'object' || !toString(payload.data)) {
          throw new Error('Malformed SportzX encrypted payload');
        }
        return payload;
      } catch (error) {
        lastError = error;
        this.logger.debug?.('sportzx encrypted channel fetch failed', {
          host: new URL(baseUrl).hostname,
          channelId: safeChannelId,
          error: error?.message || String(error)
        });
      }
    }

    throw lastError || new Error('SportzX channel fetch failed');
  }

  async getChannelStreams(channelId, signal = null) {
    const payload = await this.fetchEncryptedChannel(channelId, signal);
    const decrypted = decryptSportzXData(payload.data);
    const parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
    return extractStreamList(parsed)
      .map((stream, index) => {
        const embedUrl = getStreamUrl(stream);
        return {
          id: `sportzx:${channelId}:${index}`,
          source: 'sportzx',
          streamId: channelId,
          streamNo: index + 1,
          language: toString(stream?.title || stream?.name) || 'SportzX',
          hd: true,
          viewers: 0,
          embedUrl
        };
      })
      .filter((stream) => isHttpUrl(stream.embedUrl));
  }
}
