import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';

import axios from 'axios';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createHttpError, parseRangeHeader } from './streamManager.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jitterMs = (baseMs) => {
  const jitter = Math.floor(Math.random() * Math.min(250, Math.max(25, baseMs * 0.25)));
  return baseMs + jitter;
};

const isRetryableDnsError = (error) => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return error.code === 'EAI_AGAIN'
    || error.code === 'ETIMEOUT'
    || error.code === 'ECONNRESET';
};

const isRetryableUpstreamError = (error) => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const status = error.response?.status;

  if (typeof status === 'number') {
    return status === 429 || (status >= 500 && status <= 599);
  }

  return error.code === 'ECONNRESET'
    || error.code === 'ETIMEDOUT'
    || error.code === 'EAI_AGAIN'
    || error.code === 'ENOTFOUND'
    || error.code === 'ECONNREFUSED'
    || error.code === 'EPIPE'
    || error.code === 'ERR_SOCKET_CONNECTION_TIMEOUT'
    || error.message === 'socket hang up';
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const inferContentTypeFromPath = (value) => {
  const normalized = String(value || '').toLowerCase();

  if (normalized.includes('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (normalized.includes('.mpd')) return 'application/dash+xml';
  if (normalized.includes('.mkv')) return 'video/x-matroska';
  if (normalized.includes('.mp4')) return 'video/mp4';
  if (normalized.includes('.webm')) return 'video/webm';
  if (normalized.includes('.ts')) return 'video/mp2t';

  return null;
};

const decodeHeaderValue = (value) => {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/gu, '%20'));
  } catch {
    return String(value || '');
  }
};

const getContentDispositionFilename = (contentDisposition) => {
  const header = String(contentDisposition || '');
  const encodedMatch = header.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/iu);

  if (encodedMatch) {
    return decodeHeaderValue(encodedMatch[1].trim().replace(/^"|"$/gu, ''));
  }

  const quotedMatch = header.match(/filename\s*=\s*"([^"]+)"/iu);

  if (quotedMatch) {
    return quotedMatch[1];
  }

  const bareMatch = header.match(/filename\s*=\s*([^;]+)/iu);
  return bareMatch ? bareMatch[1].trim() : '';
};

const isCacheableStreamingResponse = (headers, contentLength) => {
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    return false;
  }

  if (contentLength > config.HTTP_STREAM_CACHE_MAX_BYTES) {
    return false;
  }

  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  return !contentType.startsWith('video/')
    && !contentType.includes('mpegurl')
    && !contentType.includes('dash+xml');
};

const getTargetUrlFilenameHint = (targetUrl) => {
  try {
    const parsedUrl = new URL(String(targetUrl || ''));
    const filenameHint = ['filename', 'fileName', 'KEY5', 'name']
      .map((key) => parsedUrl.searchParams.get(key))
      .find((value) => value && /\.[a-z0-9]{2,5}\b/iu.test(value));

    return filenameHint ? decodeHeaderValue(filenameHint) : '';
  } catch {
    return '';
  }
};

const getSafeUrlLogContext = (targetUrl) => {
  try {
    const parsedUrl = new URL(String(targetUrl || ''));
    return {
      host: parsedUrl.host,
      path: parsedUrl.pathname.slice(0, 120)
    };
  } catch {
    return {
      host: 'invalid',
      path: ''
    };
  }
};

const SYSTEM_CA_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem'
];

const isPrivateIPv4 = (address) => {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }

  const [first, second] = parts;

  return first === 10
    || first === 127
    || first === 0
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
};

const isPrivateIPv6 = (address) => {
  const normalized = address.toLowerCase();

  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('::ffff:127.')
    || normalized.startsWith('::ffff:10.')
    || normalized.startsWith('::ffff:192.168.')
    || /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./u.test(normalized);
};

const isPublicAddress = (address) => {
  const version = net.isIP(address);

  if (version === 4) {
    return !isPrivateIPv4(address);
  }

  if (version === 6) {
    return !isPrivateIPv6(address);
  }

  return false;
};

const loadSystemCaBundle = () => {
  for (const certificatePath of SYSTEM_CA_PATHS) {
    if (existsSync(certificatePath)) {
      return readFileSync(certificatePath, 'utf8');
    }
  }

  return null;
};

export class HttpProxyService {
  constructor({ cacheManager, torrentEngine }) {
    this.cacheManager = cacheManager;
    this.torrentEngine = torrentEngine;
    this.caBundle = loadSystemCaBundle();

    this.client = axios.create({
      httpAgent: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: config.HTTP_KEEP_ALIVE_MILLISECONDS,
        maxSockets: config.HTTP_MAX_SOCKETS,
        maxFreeSockets: config.HTTP_MAX_FREE_SOCKETS,
        scheduling: 'lifo'
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: config.HTTP_KEEP_ALIVE_MILLISECONDS,
        maxSockets: config.HTTP_MAX_SOCKETS,
        maxFreeSockets: config.HTTP_MAX_FREE_SOCKETS,
        scheduling: 'lifo',
        ...(this.caBundle ? { ca: this.caBundle } : {})
      }),
      timeout: config.HTTP_STREAM_TIMEOUT_SECONDS * 1000,
      maxRedirects: 3,
      validateStatus: (status) => status >= 200 && status < 300
    });
  }

  async getStreamDescriptor({ targetUrl, rangeHeader, requestHeaders = null }) {
    const normalizedUrl = await this.validateTargetUrl(targetUrl);
    const cachedEntry = await this.cacheManager.getHttpCacheEntry(normalizedUrl);

    if (cachedEntry) {
      await this.cacheManager.touchPath(cachedEntry.dataPath);
      return this.createCachedDescriptor(cachedEntry, rangeHeader);
    }

    return this.getUpstreamStreamDescriptor({
      targetUrl: normalizedUrl,
      rangeHeader,
      requestHeaders
    });
  }

  async getUpstreamStreamDescriptor({ targetUrl, rangeHeader, requestHeaders = null }) {
    const forwardedHeaders = {
      'accept-encoding': 'identity',
      ...(requestHeaders || {}),
      ...(rangeHeader ? { range: rangeHeader } : {})
    };

    const maxAttempts = Math.max(1, config.HTTP_STREAM_RETRY_MAX + 1);
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const upstreamResponse = await this.client.get(targetUrl, {
          family: 4,
          headers: forwardedHeaders,
          responseType: 'stream'
        });

        const upstreamHeaders = this.filterResponseHeaders(upstreamResponse.headers, targetUrl);
        logger.info('http stream started', {
          ...getSafeUrlLogContext(targetUrl),
          statusCode: upstreamResponse.status,
          rangeRequested: Boolean(rangeHeader),
          attempt
        });
        const rangeRequested = Boolean(rangeHeader);
        const contentLength = upstreamResponse.headers['content-length']
          ? Number.parseInt(upstreamResponse.headers['content-length'], 10)
          : null;
        const shouldCache = !rangeRequested
          && upstreamResponse.status === 200
          && isCacheableStreamingResponse(upstreamResponse.headers, contentLength)
          && contentLength <= this.cacheManager.maxCacheSizeBytes;

        if (!shouldCache) {
          return {
            statusCode: upstreamResponse.status,
            stream: upstreamResponse.data,
            headers: {
              ...upstreamHeaders,
              'Cache-Control': 'no-store'
            },
            cleanup: async ({ completed }) => {
              if (!completed && !upstreamResponse.data.destroyed) {
                upstreamResponse.data.destroy();
              }
            }
          };
        }

        const cacheWrite = await this.cacheManager.createHttpCacheWrite(targetUrl, upstreamResponse.headers);

        if (!cacheWrite) {
          return {
            statusCode: upstreamResponse.status,
            stream: upstreamResponse.data,
            headers: {
              ...upstreamHeaders,
              'Cache-Control': 'no-store'
            },
            cleanup: async ({ completed }) => {
              if (!completed && !upstreamResponse.data.destroyed) {
                upstreamResponse.data.destroy();
              }
            }
          };
        }

        const clientStream = new PassThrough();
        const cacheStream = new PassThrough();
        const writerFinished = finished(cacheWrite.writer);

        upstreamResponse.data.pipe(clientStream);
        upstreamResponse.data.pipe(cacheStream);
        cacheStream.pipe(cacheWrite.writer);

        return {
          statusCode: upstreamResponse.status,
          stream: clientStream,
          headers: {
            ...upstreamHeaders,
            'Cache-Control': 'no-store',
            'X-Cache-Status': 'MISS'
          },
          cleanup: async ({ completed }) => {
            if (!completed) {
              upstreamResponse.data.destroy();
              clientStream.destroy();
              cacheStream.destroy();
              await cacheWrite.abort();
              return;
            }

            try {
              await writerFinished;
              await cacheWrite.commit();
              await this.cacheManager.pruneCache(this.torrentEngine.getActiveCachePaths());
            } catch (error) {
              logger.error('cache commit failed', {
                ...getSafeUrlLogContext(targetUrl),
                error
              });
              await cacheWrite.abort();
            }
          }
        };
      } catch (error) {
        if (error?.response?.data && typeof error.response.data.destroy === 'function') {
          error.response.data.destroy();
        }

        lastError = error;

        const shouldRetry = attempt < maxAttempts && isRetryableUpstreamError(error);

        logger.warn('http stream attempt failed', {
          ...getSafeUrlLogContext(targetUrl),
          attempt,
          maxAttempts,
          code: error?.code,
          statusCode: error?.response?.status,
          shouldRetry
        });

        if (!shouldRetry) {
          throw this.mapUpstreamError(error);
        }

        const delayMs = jitterMs(config.HTTP_STREAM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        await sleep(delayMs);
      }
    }
    throw this.mapUpstreamError(lastError);
  }

  async validateTargetUrl(targetUrl) {
    if (typeof targetUrl !== 'string' || !targetUrl.trim()) {
      throw createHttpError(400, 'A url query parameter is required');
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw createHttpError(400, 'Only HTTP and HTTPS upstream URLs are supported');
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw createHttpError(400, 'Credentials are not allowed in upstream URLs');
    }

    if (parsedUrl.hostname.toLowerCase() === 'localhost' || parsedUrl.hostname.toLowerCase().endsWith('.local')) {
      throw createHttpError(400, 'Private upstream destinations are not allowed');
    }

    let resolvedAddresses;

    const lookupTarget = parsedUrl.hostname;

    for (let attempt = 1; attempt <= Math.max(1, config.HTTP_STREAM_RETRY_MAX + 1); attempt += 1) {
      try {
        resolvedAddresses = net.isIP(lookupTarget)
          ? [{ address: lookupTarget }]
          : await dns.lookup(lookupTarget, { all: true, verbatim: true });
        break;
      } catch (error) {
        const shouldRetry = attempt < Math.max(1, config.HTTP_STREAM_RETRY_MAX + 1) && isRetryableDnsError(error);

        logger.warn('upstream dns lookup failed', {
          hostname: lookupTarget,
          attempt,
          maxAttempts: Math.max(1, config.HTTP_STREAM_RETRY_MAX + 1),
          code: error?.code,
          shouldRetry
        });

        if (!shouldRetry) {
          throw createHttpError(502, 'Failed to resolve upstream host');
        }

        const delayMs = jitterMs(config.HTTP_STREAM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        await sleep(delayMs);
      }
    }

    if (resolvedAddresses.length === 0 || resolvedAddresses.some(({ address }) => !isPublicAddress(address))) {
      throw createHttpError(400, 'Private upstream destinations are not allowed');
    }

    return parsedUrl.toString();
  }

  createCachedDescriptor(entry, rangeHeader) {
    const range = parseRangeHeader(rangeHeader, entry.size);

    return {
      statusCode: range.statusCode,
      stream: createReadStream(entry.dataPath, { start: range.start, end: range.end }),
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': range.contentLength,
        'Content-Range': range.contentRange,
        'Content-Type': entry.metadata.contentType || 'application/octet-stream',
        'X-Cache-Status': 'HIT'
      }
    };
  }

  filterResponseHeaders(headers, targetUrl = '') {
    const output = {};

    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (!HOP_BY_HOP_HEADERS.has(headerName.toLowerCase())) {
        output[headerName] = headerValue;
      }
    }

    const currentContentType = String(
      output['content-type'] || output['Content-Type'] || ''
    ).toLowerCase();
    const filename = getContentDispositionFilename(
      output['content-disposition'] || output['Content-Disposition']
    ) || getTargetUrlFilenameHint(targetUrl);
    const filenameContentType = inferContentTypeFromPath(filename);
    const hasExplicitFilenameHint = Boolean(filename);
    const shouldInferContentType = !currentContentType
      || currentContentType.includes('octet-stream')
      || currentContentType.includes('binary/octet-stream')
      || (hasExplicitFilenameHint && filenameContentType && filenameContentType !== currentContentType);

    if (shouldInferContentType) {
      const inferredContentType = filenameContentType || inferContentTypeFromPath(targetUrl);

      if (inferredContentType) {
        output['content-type'] = inferredContentType;
        delete output['Content-Type'];
      }
    }

    return output;
  }

  mapUpstreamError(error) {
    let mappedError;

    if (error.response) {
      const upstreamStatus = Number(error.response.status);
      const passthroughStatuses = new Set([400, 401, 403, 404, 410, 416, 429, 451, 503, 504]);
      const statusCode = passthroughStatuses.has(upstreamStatus) ? upstreamStatus : 502;
      const message = statusCode === upstreamStatus
        ? `Upstream server returned ${upstreamStatus}`
        : `Upstream server returned ${error.response.status}`;
      mappedError = createHttpError(statusCode, message);
      const logMethod = statusCode >= 500 ? 'error' : 'warn';
      logger[logMethod]('http stream failed', {
        upstreamStatusCode: error.response.status,
        statusCode,
        error: mappedError
      });
      return mappedError;
    }

    if (error.code === 'ECONNABORTED') {
      mappedError = createHttpError(504, 'Upstream request timed out');
      logger.error('http stream failed', {
        code: error.code,
        error: mappedError
      });
      return mappedError;
    }

    if (error.code === 'ERR_BAD_REQUEST' || error.code === 'ERR_BAD_RESPONSE') {
      mappedError = createHttpError(502, 'Invalid upstream response');
      logger.error('http stream failed', {
        code: error.code,
        error: mappedError
      });
      return mappedError;
    }

    mappedError = createHttpError(502, 'Failed to reach upstream server');
    logger.error('http stream failed', {
      code: error.code,
      error: mappedError
    });
    return mappedError;
  }
}
