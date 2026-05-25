import { pipeline } from 'node:stream/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { createClient } from 'redis';
import { config, cacheConfig } from '../config.js';
import { enhanceMagnet, extractInfoHash } from '../utils/magnet.js';
import { logger } from '../utils/logger.js';
import { RogPlayAdapter } from '../providers/rogplay/RogPlayAdapter.js';
import { GermanIptvLiveAdapter } from '../src/adapters/GermanIptvLiveAdapter.js';

const { mkdir, readFile, readdir, rm, writeFile } = fsPromises;

const allowHighFanoutAbortSignal = (signal) => {
  if (!signal?.addEventListener) {
    return signal;
  }

  try {
    setMaxListeners(0, signal);
  } catch {
    // Older runtimes may not support EventTarget listener limits.
  }

  return signal;
};

const detectSourceType = (source) => {
  const normalized = String(source || '').trim();

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('magnet:?')) {
    return 'magnet';
  }

  try {
    const parsedUrl = new URL(normalized);

    if (parsedUrl.protocol === 'magnet:') {
      return 'magnet';
    }

    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      return 'http';
    }
  } catch {
    return null;
  }

  return null;
};

const SIGNED_STREAM_CACHE_SAFETY_SECONDS = 60;
const MIN_SIGNED_STREAM_CACHE_TTL_SECONDS = 15;
const SIGNED_URL_EXPIRY_PARAM_NAMES = Object.freeze([
  'token',
  'KEY2',
  'expires',
  'expire',
  'exp'
]);
const SOURCE_TOKEN_VERSION = 2;
const CINESTREAM_RESULT_CACHE_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_NON_EMPTY_RESULT_CACHE_TTL_SECONDS = 24 * 60 * 60;
const SHOWBOX_RESULT_CACHE_TTL_SECONDS = 120;

const getSignedUrlExpiryTtlSeconds = (url, nowMs = Date.now()) => {
  try {
    const parsedUrl = new URL(String(url || '').trim());
    const expiryTokens = SIGNED_URL_EXPIRY_PARAM_NAMES
      .map((name) => parsedUrl.searchParams.get(name))
      .filter((token) => /^\d{10,13}$/u.test(String(token || '')));

    for (const pathPart of parsedUrl.pathname.split('/')) {
      if (/^\d{10,13}$/u.test(pathPart)) {
        expiryTokens.push(pathPart);
      }
    }

    if (expiryTokens.length === 0) {
      return null;
    }

    const ttlSeconds = expiryTokens.reduce((lowestTtlSeconds, token) => {
      const rawExpiry = Number(token);
      const expiryMs = rawExpiry > 1_000_000_000_000 ? rawExpiry : rawExpiry * 1000;
      const tokenTtlSeconds = Math.floor((expiryMs - nowMs) / 1000) - SIGNED_STREAM_CACHE_SAFETY_SECONDS;
      return Number.isFinite(tokenTtlSeconds)
        ? Math.min(lowestTtlSeconds, tokenTtlSeconds)
        : lowestTtlSeconds;
    }, Number.POSITIVE_INFINITY);

    return Number.isFinite(ttlSeconds)
      ? Math.max(MIN_SIGNED_STREAM_CACHE_TTL_SECONDS, ttlSeconds)
      : null;
  } catch {
    return null;
  }
};

const getSourceTokenTtlMs = (preparedSource) => {
  const defaultTtlSeconds = config.STREAM_SOURCE_TOKEN_TTL_SECONDS;
  const signedTtlSeconds = preparedSource?.type === 'http'
    ? getSignedUrlExpiryTtlSeconds(preparedSource.source)
    : null;
  const metadataExpiryMs = Number(preparedSource?.metadata?.expiresAt);
  const metadataTtlSeconds = Number.isFinite(metadataExpiryMs)
    ? Math.floor((metadataExpiryMs - Date.now()) / 1000) - SIGNED_STREAM_CACHE_SAFETY_SECONDS
    : null;
  const providerId = String(preparedSource?.metadata?.provider || '').trim().toLowerCase();
  const providerCapSeconds = providerId === 'showbox' ? 300 : defaultTtlSeconds;
  const ttlCaps = [defaultTtlSeconds, providerCapSeconds];
  if (signedTtlSeconds !== null) {
    ttlCaps.push(signedTtlSeconds);
  }
  if (metadataTtlSeconds !== null) {
    ttlCaps.push(metadataTtlSeconds);
  }
  const ttlSeconds = Math.min(...ttlCaps);

  return Math.max(MIN_SIGNED_STREAM_CACHE_TTL_SECONDS * 1000, ttlSeconds * 1000);
};

const getSignedStreamCacheLimit = (streams, nowMs = Date.now()) => {
  let ttlSeconds = null;

  for (const stream of Array.isArray(streams) ? streams : []) {
    const signedTtl = getSignedUrlExpiryTtlSeconds(stream?.url, nowMs);
    if (signedTtl !== null) {
      ttlSeconds = ttlSeconds === null ? signedTtl : Math.min(ttlSeconds, signedTtl);
    }
    const expiresAt = Number(stream?.expiresAt);
    if (Number.isFinite(expiresAt)) {
      const metadataTtl = Math.floor((expiresAt - nowMs) / 1000) - SIGNED_STREAM_CACHE_SAFETY_SECONDS;
      ttlSeconds = ttlSeconds === null ? metadataTtl : Math.min(ttlSeconds, metadataTtl);
    }
  }

  return ttlSeconds;
};

const getSourceTokenExpiryTtlSeconds = (streamUrl, nowMs = Date.now()) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    const sourceToken = parsedUrl.searchParams.get('sourceToken');

    if (!sourceToken) {
      return null;
    }

    const payload = JSON.parse(decryptSourceTokenPayload(sourceToken));
    const expiresAt = Number(payload?.expiresAt);

    if (!Number.isFinite(expiresAt)) {
      return null;
    }

    const ttlSeconds = Math.floor((expiresAt - nowMs) / 1000) - SIGNED_STREAM_CACHE_SAFETY_SECONDS;
    return Math.max(MIN_SIGNED_STREAM_CACHE_TTL_SECONDS, ttlSeconds);
  } catch {
    return MIN_SIGNED_STREAM_CACHE_TTL_SECONDS;
  }
};

const getSourceTokenStreamCacheLimit = (streams, nowMs = Date.now()) => {
  let ttlSeconds = null;

  for (const stream of Array.isArray(streams) ? streams : []) {
    const tokenTtl = getSourceTokenExpiryTtlSeconds(stream?.url, nowMs);
    if (tokenTtl !== null) {
      ttlSeconds = ttlSeconds === null ? tokenTtl : Math.min(ttlSeconds, tokenTtl);
    }
  }

  return ttlSeconds;
};

const normalizeRequestedType = (type) => {
  if (typeof type !== 'string' || !type.trim()) {
    return null;
  }

  const normalized = type.trim().toLowerCase();

  if (normalized === 'http' || normalized === 'torrent') {
    return normalized;
  }

  return null;
};

const toStremioCompatibilityScore = (stream) => {
  const url = String(stream.url || '').toLowerCase();
  const title = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  let score = 0;

  if (stream.magnet || stream.torrent) {
    return 20 + score;
  }

  if (url.includes('.mp4')) {
    score += 120;
  } else if (url.includes('.m3u8')) {
    score += 100;
  } else if (url.includes('.webm')) {
    score += 70;
  } else if (url.includes('.mkv')) {
    score += 40;
  } else {
    score += 50;
  }

  const qualityMatch = String(stream.quality || '').match(/(\d{3,4})/);

  if (qualityMatch?.[1]) {
    const quality = Number.parseInt(qualityMatch[1], 10);
    score += Math.min(quality, 1080);
  }

  if (/\b(hevc|x265|10bit|hdr|hdr10|dolby vision|dovi|remux|untouch)\b/u.test(title)) {
    score -= 1800;
  }

  if (/\b(x264|h264|aac)\b/u.test(title)) {
    score += 80;
  }

  if (title.includes('auto')) {
    score -= 40;
  }

  return score;
};

const getStreamFormatBadge = (stream) => {
  if (stream.magnet || stream.torrent) {
    return '[TORRENT]';
  }

  const url = String(stream.url || '').toLowerCase();
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  const parts = [];

  if (url.includes('.mp4')) {
    parts.push('MP4');
  } else if (url.includes('.m3u8')) {
    parts.push('HLS');
  } else if (url.includes('.mkv')) {
    parts.push('MKV');
  } else if (url.includes('.webm')) {
    parts.push('WEBM');
  } else {
    parts.push('HTTP');
  }

  if (/\b(hevc|x265)\b/u.test(text)) {
    parts.push('HEVC');
  } else if (/\b(h264|x264)\b/u.test(text)) {
    parts.push('H264');
  }

  if (/\b10bit\b/u.test(text)) {
    parts.push('10BIT');
  }

  if (/\b(hdr|dolby vision|dovi)\b/u.test(text)) {
    parts.push('HDR');
  }

  return `[${parts.join('/')}]`;
};

const toTitleCaseLabel = (providerId) =>
  String(providerId || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

const DEFAULT_QUALITY_PRIORITY = Object.freeze([
  '2160p',
  '1440p',
  '1080p',
  '720p',
  '480p',
  '360p',
  'auto',
  'unknown'
]);

const FORMATTER_STYLES = new Set(['clean', 'detailed', 'compact', 'minimal']);

const normalizeFormatterStyle = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return FORMATTER_STYLES.has(normalized) ? normalized : 'clean';
};

const DEFAULT_STREAM_OPTIONS = Object.freeze({
  webReadyOnly: false,
  hideHeavyFormats: false,
  allowedQualities: Object.freeze([]),
  maxSizeGb: 0,
  maxPerQuality: 0,
  maxPerProvider: 0,
  blockHosts: Object.freeze([]),
  contentSelection: 'default',
  preferredAudioLanguage: null,
  dedupeMode: 'off',
  preferHdr: false,
  preferH264: false,
  preferSmallerFiles: false,
  preferDirectHosts: false,
  torboxOnlyStreams: false,
  torboxUsenet: false,
  formatterStyle: 'clean',
  customProxyUrl: null
});
const DEFAULT_PRIVATE_PROVIDER_SETTINGS = Object.freeze({
  febboxUiCookie: null,
  showboxOssGroup: null,
  torboxApiKey: null
});
const PRIVATE_CONFIG_VERSION = 1;
const PRIVATE_PROVIDER_COOKIE_MAX_LENGTH = 4096;
const CONTENT_SELECTIONS = new Set(['default', 'movie', 'series']);

const normalizeContentSelection = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return CONTENT_SELECTIONS.has(normalized) ? normalized : 'default';
};

const normalizePositiveIntegerOption = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const HIGH_VALUE_CACHE_PROVIDERS = new Set(['4khdhub', 'scrapling-4khdhub', '4khdhub_tv', 'hdhub4u']);
const HIGH_VALUE_CACHE_PATTERN = /\b(4khdhub|hdhub|hubcloud|hub cloud)\b/iu;
const LAST_GOOD_PRIMARY_PROVIDERS = new Set(['4khdhub', 'scrapling 4khdhub', '4khdhub tv', 'hdhub4u', 'uhdmovies']);
const LAST_GOOD_SECONDARY_PROVIDERS = new Set(['vidsrc', 'vixsrc', 'vidlink', 'moviebox', 'cinestream', 'streamflix']);
const DIRECT_PLAYBACK_PROVIDER_IDS = new Set(['4khdhub', 'scrapling-4khdhub', '4khdhub_tv', 'hdhub4u', 'showbox']);
const REGISTERED_PLAYBACK_PROXY_PROVIDER_IDS = new Set([
  'hdhub4u',
  'scrapling-hdhub4u',
  'streamflix',
  'streamflix_eng'
]);

const CONFIGURED_PROFILE_LABELS = Object.freeze({
  wf: Object.freeze({ code: 'WF', label: 'Web Fast' }),
  md: Object.freeze({ code: 'MD', label: 'Mobile Data' }),
  '4k': Object.freeze({ code: '4K', label: '4K HDR' }),
  an: Object.freeze({ code: 'AN', label: 'Anime' }),
  in: Object.freeze({ code: 'IN', label: 'Indian Content' }),
  tr: Object.freeze({ code: 'TR', label: 'Turkish Content' }),
  it: Object.freeze({ code: 'IT', label: 'Italian Content' }),
  la: Object.freeze({ code: 'LA', label: 'Latino Content' }),
  fr: Object.freeze({ code: 'FR', label: 'French Content' }),
  ar: Object.freeze({ code: 'AR', label: 'Arabic Content' })
});
const STREMIO_INFLIGHT_STALE_MS = Math.max(
  config.STREMIO_STREAM_OVERALL_TIMEOUT_MS + 15_000,
  config.STREMIO_FAST_MAX_WAIT_MS + 30_000,
  45_000
);

const copyObjects = (items) => items.map((item) => ({ ...item }));
const serializeObjects = (items) => JSON.stringify(Array.isArray(items) ? items : []);
const deserializeObjects = (payload) => {
  if (typeof payload !== 'string' || !payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? copyObjects(parsed) : [];
  } catch {
    return [];
  }
};
const getSerializedApproxBytes = (payload) => Buffer.byteLength(String(payload || ''), 'utf8');

const delay = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const getSourceTokenKey = () =>
  createHash('sha256').update(config.STREAM_SOURCE_TOKEN_SECRET).digest();

const encryptSourceTokenPayload = (value) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getSourceTokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv, encrypted, tag].map((part) => part.toString('base64url')).join('.');
};

const decryptSourceTokenPayload = (value) => {
  const [iv, encrypted, tag, extra] = String(value || '').split('.');

  if (!iv || !encrypted || !tag || extra !== undefined) {
    throw createHttpError(400, 'Invalid source token');
  }

  const decipher = createDecipheriv('aes-256-gcm', getSourceTokenKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final()
  ]).toString('utf8');
};

const extractTorBoxWebDownloadId = (payload) => {
  const candidates = [
    payload?.data?.webdl_id,
    payload?.data?.webdownload_id,
    payload?.data?.web_id,
    payload?.data?.id,
    payload?.webdl_id,
    payload?.web_id,
    payload?.id
  ];

  for (const value of candidates) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }

  return null;
};

const findTorBoxVideoFileId = (payload) => {
  const data = payload?.data;
  const candidates = Array.isArray(data)
    ? data
    : Array.isArray(data?.files)
      ? data.files
      : Array.isArray(data?.download?.files)
        ? data.download.files
        : Array.isArray(data?.webdl?.files)
          ? data.webdl.files
          : [];

  for (const file of candidates) {
    const name = String(file?.name || file?.short_name || file?.filename || '').toLowerCase();
    if (!/\.(?:mkv|mp4|webm|m4v|avi)(?:$|\?)/u.test(name)) continue;
    const id = Number(file?.id ?? file?.file_id);
    if (Number.isInteger(id) && id >= 0) return id;
  }

  return null;
};

const TORBOX_DDL_HOST_PATTERNS = Object.freeze([
  /(?:^|\.)1fichier\.com$/iu,
  /(?:^|\.)buzzheavier\.com$/iu,
  /(?:^|\.)filemoon\./iu,
  /(?:^|\.)gofile\.io$/iu,
  /(?:^|\.)katfile\.com$/iu,
  /(?:^|\.)krakenfiles\.com$/iu,
  /(?:^|\.)mediafire\.com$/iu,
  /(?:^|\.)mega\.nz$/iu,
  /(?:^|\.)megaup\.net$/iu,
  /(?:^|\.)mixdrop\./iu,
  /(?:^|\.)pixeldrain\.(?:com|dev)$/iu,
  /(?:^|\.)qiwi\.gg$/iu,
  /(?:^|\.)rapidgator\.net$/iu,
  /(?:^|\.)send\.(?:cm|now)$/iu,
  /(?:^|\.)sendgb\.com$/iu,
  /(?:^|\.)streamtape\./iu,
  /(?:^|\.)userscloud\.com$/iu,
  /(?:^|\.)workupload\.com$/iu
]);

const isDirectPlayableMediaUrl = (url) => {
  try {
    const parsed = new URL(String(url || ''));
    return /\.(?:m3u8|mp4|webm|m4v)(?:$|[?#])/iu.test(parsed.pathname);
  } catch {
    return false;
  }
};

const isTorBoxDdlCandidateStream = (stream) => {
  if (!stream?.url || stream.transport !== 'http' || isDirectPlayableMediaUrl(stream.url)) {
    return false;
  }

  try {
    const host = new URL(String(stream.url)).hostname.toLowerCase();
    return TORBOX_DDL_HOST_PATTERNS.some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
};

const enableTorBoxDdlStreams = (streams, privateProviderSettings = null) => {
  if (!String(privateProviderSettings?.torboxApiKey || '').trim()) {
    return streams;
  }

  return streams.map((stream) => {
    if (!isTorBoxDdlCandidateStream(stream)) {
      return stream;
    }

    return {
      ...stream,
      torboxWebDownload: true,
      sourceSite: stream.sourceSite ? `${stream.sourceSite} via TorBox` : 'TorBox DDL',
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        notWebReady: false
      }
    };
  });
};

const normalizeProviderLabel = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const extractProviderLabelFromStremioStream = (stream) => {
  const firstLine = String(stream?.name || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
  const match = firstLine.match(/\|\s*([^\n|]+)\s*$/u);
  return normalizeProviderLabel(match?.[1] || '');
};

const extractQualityScoreFromStremioStream = (stream) => {
  const firstLine = String(stream?.name || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
  const match = firstLine.match(/NebulaStreams\s+([^|]+?)\s*\|/iu);
  const qualityText = String(match?.[1] || '').trim().toLowerCase();

  if (qualityText.includes('4k')) {
    return 2160;
  }

  const qualityMatch = qualityText.match(/(\d{3,4})/);
  if (qualityMatch?.[1]) {
    return Number.parseInt(qualityMatch[1], 10);
  }

  return 0;
};

const getLastGoodStreamSetScore = (streams) => {
  if (!Array.isArray(streams) || streams.length === 0) {
    return 0;
  }

  const providers = streams
    .map((stream) => extractProviderLabelFromStremioStream(stream))
    .filter(Boolean);
  const uniqueProviders = new Set(providers);
  const bestQualityScore = Math.max(
    0,
    ...streams.map((stream) => extractQualityScoreFromStremioStream(stream))
  );
  const primaryHits = providers.filter((providerId) => LAST_GOOD_PRIMARY_PROVIDERS.has(providerId)).length;
  const secondaryHits = providers.filter((providerId) => LAST_GOOD_SECONDARY_PROVIDERS.has(providerId)).length;

  return (primaryHits * 10000) + (secondaryHits * 3000) + (uniqueProviders.size * 500) + bestQualityScore + streams.length;
};

const shouldPersistLastGoodStreamSet = (streams) => {
  if (!Array.isArray(streams) || streams.length === 0) {
    return false;
  }

  const providers = streams
    .map((stream) => extractProviderLabelFromStremioStream(stream))
    .filter(Boolean);
  const uniqueProviders = new Set(providers);
  const hasPrimary = providers.some((providerId) => LAST_GOOD_PRIMARY_PROVIDERS.has(providerId));
  const hasSecondary = providers.some((providerId) => LAST_GOOD_SECONDARY_PROVIDERS.has(providerId));
  const bestQualityScore = Math.max(
    0,
    ...streams.map((stream) => extractQualityScoreFromStremioStream(stream))
  );

  if (hasPrimary) {
    return true;
  }

  return hasSecondary || uniqueProviders.size >= 2 || bestQualityScore >= 1080;
};

const normalizeStremioResultCacheEntry = (payload) => {
  if (!payload || (typeof payload.serializedStreams !== 'string' && !Array.isArray(payload.streams))) {
    return null;
  }

  const expiresAt = Number(payload.expiresAt || 0);
  const staleExpiresAt = Number(payload.staleExpiresAt || expiresAt);

  if (!Number.isFinite(expiresAt) || !Number.isFinite(staleExpiresAt)) {
    return null;
  }

  return {
    expiresAt,
    staleExpiresAt,
    approxBytes: getSerializedApproxBytes(typeof payload.serializedStreams === 'string'
      ? payload.serializedStreams
      : serializeObjects(payload.streams)),
    serializedStreams: typeof payload.serializedStreams === 'string'
      ? payload.serializedStreams
      : serializeObjects(payload.streams)
  };
};

class RedisStreamResultCache {
  constructor() {
    this.client = null;
    this.enabled = false;
    this.available = false;
    this.failureCount = 0;
  }

  async initialize() {
    if (!config.STREAM_RESULT_EXTERNAL_CACHE_ENABLED || !config.REDIS_URL) {
      return;
    }

    this.enabled = true;
    this.client = createClient({
      url: config.REDIS_URL,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: (retries) => retries > 3 ? false : Math.min(retries * 100, 1000)
      }
    });

    this.client.on('error', (error) => {
      this.available = false;
      this.failureCount += 1;
      logger.warn('redis stream result cache error', { error });
    });

    this.client.on('ready', () => {
      this.available = true;
      logger.info('redis stream result cache connected');
    });

    try {
      await this.client.connect();
      this.available = true;
    } catch (error) {
      this.available = false;
      this.failureCount += 1;
      logger.warn('redis stream result cache unavailable, using local cache fallback', { error });
    }
  }

  getStats() {
    return {
      enabled: this.enabled,
      available: this.available,
      failureCount: this.failureCount
    };
  }

  getKey(cacheKey) {
    return `${config.REDIS_CACHE_PREFIX}:stremio-result:${createHash('sha1').update(cacheKey).digest('hex')}`;
  }

  async get(cacheKey) {
    if (!this.client || !this.available) {
      return null;
    }

    try {
      const rawPayload = await this.client.get(this.getKey(cacheKey));

      if (!rawPayload) {
        return null;
      }

      return normalizeStremioResultCacheEntry(JSON.parse(rawPayload));
    } catch (error) {
      this.available = false;
      this.failureCount += 1;
      logger.warn('redis stream result cache read failed', { error });
      return null;
    }
  }

  async set(cacheKey, entry) {
    if (!this.client || !this.available) {
      return;
    }

    const ttlSeconds = Math.max(1, Math.ceil((entry.staleExpiresAt - Date.now()) / 1000));

    try {
      await this.client.setEx(this.getKey(cacheKey), ttlSeconds, JSON.stringify(entry));
    } catch (error) {
      this.available = false;
      this.failureCount += 1;
      logger.warn('redis stream result cache write failed', { error });
    }
  }

  async close() {
    if (!this.client) {
      return;
    }

    try {
      await this.client.quit();
    } catch (error) {
      logger.warn('redis stream result cache close failed', { error });
    }
  }
}

const touchMapEntry = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
};

const pruneMapByMaxEntries = (map, maxEntries) => {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    return;
  }

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    map.delete(oldestKey);
  }
};

const pruneMapByApproxBytes = (map, maxBytes, getEntryBytes = (entry) => entry?.approxBytes || 0) => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || map.size === 0) {
    return;
  }

  let totalBytes = 0;

  for (const entry of map.values()) {
    totalBytes += Math.max(0, Number(getEntryBytes(entry)) || 0);
  }

  while (totalBytes > maxBytes && map.size > 0) {
    const oldestKey = map.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    const oldestEntry = map.get(oldestKey);
    totalBytes -= Math.max(0, Number(getEntryBytes(oldestEntry)) || 0);
    map.delete(oldestKey);
  }
};
const HUBCLOUD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const HUBCLOUD_FETCH_TIMEOUT_MS = 3000;
const MAX_FETCH_TEXT_BYTES = 1024 * 1024;
const HUBCLOUD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const normalizeQualityKey = (quality) => {
  const normalized = String(quality || '').trim().toLowerCase();

  if (!normalized) {
    return 'unknown';
  }

  if (normalized.includes('2160') || normalized === '4k') {
    return '2160p';
  }

  if (normalized.includes('1440')) {
    return '1440p';
  }

  if (normalized.includes('1080')) {
    return '1080p';
  }

  if (normalized.includes('720')) {
    return '720p';
  }

  if (normalized.includes('480') || normalized.includes('sd') || normalized.includes('low hd')) {
    return '480p';
  }

  if (normalized.includes('360')) {
    return '360p';
  }

  if (normalized.includes('auto') || normalized.includes('adaptive') || normalized.includes('mid hd')) {
    return 'auto';
  }

  return 'unknown';
};

const getStreamQualityKey = (stream) => {
  const explicitQuality = normalizeQualityKey(stream.quality);

  if (explicitQuality !== 'unknown') {
    return explicitQuality;
  }

  return normalizeQualityKey([
    stream.name,
    stream.title,
    stream.filename,
    stream.url
  ].map((value) => String(value || '')).join(' '));
};

const getQualityPriorityScore = (stream, qualityPriority) => {
  const normalizedQuality = getStreamQualityKey(stream);
  const index = qualityPriority.indexOf(normalizedQuality);

  if (index === -1) {
    return 0;
  }

  return (qualityPriority.length - index) * 10000;
};

const isHighValueCacheStream = (stream) => {
  const providerId = String(stream.provider || '').trim().toLowerCase();
  const text = [
    stream.name,
    stream.title,
    stream.sourceSite,
    stream.url,
    stream.filename
  ].map((value) => String(value || '')).join(' ');

  return normalizeQualityKey(stream.quality) === '2160p'
    || HIGH_VALUE_CACHE_PROVIDERS.has(providerId)
    || HIGH_VALUE_CACHE_PATTERN.test(text);
};

const shouldUseWeakResultCache = (streams) =>
  streams.length > 0 && !streams.some((stream) => isHighValueCacheStream(stream));

const shouldCacheEmptyFastResult = (result) =>
  result?.reason === 'all-complete';

const hasForwardHeaders = (headers) =>
  Boolean(headers && typeof headers === 'object' && Object.keys(headers).length > 0);

const hasSensitiveForwardHeaders = (headers) => {
  if (!hasForwardHeaders(headers)) {
    return false;
  }

  const headerNames = Object.keys(headers).map((headerName) => headerName.toLowerCase());
  return headerNames.includes('cookie') || headerNames.includes('authorization');
};

const getProviderForwardHeaders = (stream) => {
  if (hasForwardHeaders(stream?.headers)) {
    return { ...stream.headers };
  }

  const proxyHeaders = stream?.behaviorHints?.proxyHeaders?.request;
  return hasForwardHeaders(proxyHeaders) ? { ...proxyHeaders } : null;
};

const isWebReadyHttpStream = (stream) =>
  stream.transport === 'http' &&
  Boolean(stream.url) &&
  (isPlainMp4Url(stream.url) || isPlainHlsUrl(stream.url) || stream.behaviorHints?.notWebReady === false) &&
  !hasForwardHeaders(stream.headers);

const isTrustedDirectHttpStream = (stream) =>
  stream.transport === 'http' &&
  Boolean(stream.url) &&
  !hasForwardHeaders(stream.headers) &&
  isHighValueCacheStream(stream);

const isProxyReadyHttpStream = (stream) =>
  stream.transport === 'http' &&
  Boolean(stream.url) &&
  hasSensitiveForwardHeaders(getProviderForwardHeaders(stream));

const isRegisteredProxyOnlyUrl = (streamUrl) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    const hostname = parsedUrl.hostname.toLowerCase();
    return hostname.includes('webstreamrmbg')
      || hostname.endsWith('baby-beamup.club')
      || parsedUrl.pathname.startsWith('/extract/');
  } catch {
    return false;
  }
};

const prefersDirectPlayback = (stream) => {
  const providerId = String(stream?.provider || '').trim().toLowerCase();
  return DIRECT_PLAYBACK_PROVIDER_IDS.has(providerId)
    || stream?.behaviorHints?.notWebReady === false
    || isPlainMp4Url(stream?.url)
    || isPlainHlsUrl(stream?.url);
};

const getStremioRequestBaseUrl = (req) => {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'https';
  const host = forwardedHost || req.get('host');
  return `${proto}://${host}`;
};

const getStremioRequestHost = (req) => {
  const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  return String(forwardedHost || req.get('host') || '')
    .split(':')[0]
    .trim()
    .toLowerCase();
};

const normalizeAddonIdPart = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '.')
    .replace(/^\.+|\.+$/gu, '')
    .slice(0, 48);

const shouldUseLegacyAddonIdForHost = (host) => {
  const normalizedHost = String(host || '').toLowerCase();
  if (!normalizedHost) {
    return false;
  }

  return config.STREMIO_LEGACY_ADDON_HOSTS.some((legacyHost) => {
    const normalizedLegacyHost = String(legacyHost || '').trim().toLowerCase();
    return normalizedLegacyHost && (
      normalizedHost === normalizedLegacyHost
      || normalizedHost.endsWith(`.${normalizedLegacyHost}`)
      || normalizedHost.includes(normalizedLegacyHost)
    );
  });
};

const getStandaloneAddonId = (req) => {
  const baseAddonId = config.STREMIO_ADDON_ID;
  if (!config.STREMIO_ADDON_ID_SCOPE_BY_HOST) {
    return baseAddonId;
  }

  const host = getStremioRequestHost(req);
  if (!host || shouldUseLegacyAddonIdForHost(host)) {
    return baseAddonId;
  }

  const hostPart = normalizeAddonIdPart(host);
  if (!hostPart || baseAddonId.endsWith(`.${hostPart}`)) {
    return baseAddonId;
  }

  return `${baseAddonId}.${hostPart}`;
};

const getManifestInstallUrls = (req, manifestPath) => {
  const baseUrl = getStremioRequestBaseUrl(req);
  const manifestUrl = `${baseUrl}${manifestPath}`;

  return {
    manifestUrl,
    stremioInstallUrl: `stremio://addon-install?addon=${encodeURIComponent(manifestUrl)}`
  };
};

const needsRegisteredPlaybackProxy = (stream) => {
  if (stream?.transport !== 'http' || !stream.url) {
    return false;
  }

  const forwardHeaders = getProviderForwardHeaders(stream);
  const providerId = String(stream?.provider || '').trim().toLowerCase();

  if (isRegisteredProxyOnlyUrl(stream.url)) {
    return true;
  }

  if (REGISTERED_PLAYBACK_PROXY_PROVIDER_IDS.has(providerId)) {
    return true;
  }

  if (hasForwardHeaders(forwardHeaders)) {
    if (providerId === 'nuvio') {
      return true;
    }

    if (hasSensitiveForwardHeaders(forwardHeaders)) {
      return true;
    }

    return false;
  }

  if (prefersDirectPlayback(stream)) {
    return false;
  }

  return false;
};

const hasHeavyFormatTraits = (stream) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  return /\b(hevc|x265|10bit|hdr|hdr10|hdr10\+|dolby vision|dovi|remux|untouch)\b/u.test(text);
};

const parseSizeBytes = (value) => {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*(tb|gb|mb|kb|b)\b/i);

  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024
  }[unit];

  if (!Number.isFinite(amount) || !multiplier) {
    return null;
  }

  return Math.round(amount * multiplier);
};

const formatSizeBytes = (value) => {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unitIndex = 0;

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  return `${amount >= 10 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(2)} ${units[unitIndex]}`;
};

const getStreamSizeBytes = (stream) => {
  const explicitSize = parseSizeBytes(stream.size);

  if (explicitSize) {
    return explicitSize;
  }

  return parseSizeBytes(`${String(stream.name || '')}\n${String(stream.title || '')}`);
};

const getStreamHostname = (stream) => {
  try {
    return new URL(String(stream.url || '').trim()).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return '';
  }
};

const toDiagnosticStreamExample = (stream) => ({
  name: stream.name || 'Untitled stream',
  quality: stream.quality || 'Unknown',
  host: getStreamHostname(stream) || 'Unknown host',
  size: stream.size || 'Unknown size'
});

const normalizeDedupeMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'smart' || normalized === 'filename' || normalized === 'host-quality') {
    return normalized;
  }

  return 'off';
};

const normalizeFilenameKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/u, '')
    .replace(/\[[^\]]+\]|\([^)]+\)/gu, ' ')
    .replace(/[_+.]+/g, ' ')
    .replace(/\b(2160p|1440p|1080p|720p|480p|360p|hevc|x265|x264|h264|hdr|hdr10\+?|dovi|dv|10bit|aac|atmos|web[- ]dl|webrip|bluray|multi)\b/gu, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const getExactUrlKey = (stream) => {
  if (!stream.url) {
    return '';
  }

  try {
    const parsedUrl = new URL(String(stream.url).trim());
    parsedUrl.hash = '';
    return `${parsedUrl.hostname.toLowerCase()}${parsedUrl.pathname}`;
  } catch {
    return String(stream.url || '').trim().toLowerCase();
  }
};

const getStreamDedupeKey = (stream, dedupeMode) => {
  if (stream.infoHash) {
    return `infohash:${String(stream.infoHash).toLowerCase()}`;
  }

  const qualityKey = normalizeQualityKey(stream.quality);
  const hostKey = getStreamHostname(stream);
  const filenameKey = normalizeFilenameKey(stream.filename || extractFilenameFromUrl(stream.url) || '');
  const sizeBytes = getStreamSizeBytes(stream);

  if (dedupeMode === 'filename') {
    return filenameKey ? `filename:${filenameKey}|${qualityKey}` : '';
  }

  if (dedupeMode === 'host-quality') {
    return hostKey ? `host-quality:${hostKey}|${qualityKey}` : '';
  }

  if (dedupeMode === 'smart') {
    if (filenameKey) {
      return `smart-filename:${filenameKey}|${qualityKey}`;
    }

    if (hostKey && sizeBytes) {
      return `smart-host-size:${hostKey}|${qualityKey}|${sizeBytes}`;
    }

    const exactUrlKey = getExactUrlKey(stream);

    if (exactUrlKey) {
      return `smart-url:${exactUrlKey}|${qualityKey}`;
    }
  }

  return '';
};

const applyConfiguredDedupe = (streams, streamOptions) => {
  const dedupeMode = normalizeDedupeMode(streamOptions.dedupeMode);

  if (dedupeMode === 'off' || streams.length <= 1) {
    return {
      streams,
      dedupeMode,
      removedCount: 0,
      examples: []
    };
  }

  const dedupedStreams = [];
  const seenKeys = new Set();
  let removedCount = 0;
  const examples = [];

  for (const stream of streams) {
    const dedupeKey = getStreamDedupeKey(stream, dedupeMode);

    if (!dedupeKey) {
      dedupedStreams.push(stream);
      continue;
    }

    if (seenKeys.has(dedupeKey)) {
      removedCount += 1;

       if (examples.length < 3) {
        examples.push(toDiagnosticStreamExample(stream));
      }
      continue;
    }

    seenKeys.add(dedupeKey);
    dedupedStreams.push(stream);
  }

  return {
    streams: dedupedStreams,
    dedupeMode,
    removedCount,
    examples
  };
};

const filterConfiguredStreamsDetailed = (streams, streamOptions) => {
  const filteredStreams = [];
  const diagnostics = {
    inputTotal: streams.length,
    keptTotal: 0,
    filteredTotal: 0,
    dedupedTotal: 0,
    dedupeMode: normalizeDedupeMode(streamOptions.dedupeMode),
    reasons: {
      archiveFile: 0,
      knownUnplayable: 0,
      nonHttp: 0,
      notWebReady: 0,
      heavyFormat: 0,
      tooLarge: 0,
      blockedHost: 0,
      languageMismatch: 0,
      duplicate: 0
    },
    examples: {
      archiveFile: [],
      knownUnplayable: [],
      nonHttp: [],
      notWebReady: [],
      heavyFormat: [],
      tooLarge: [],
      blockedHost: [],
      languageMismatch: [],
      duplicate: []
    }
  };
  const maxBytes = Number(streamOptions.maxSizeGb) > 0
    ? Number(streamOptions.maxSizeGb) * 1024 * 1024 * 1024
    : 0;
  const blockedHosts = Array.isArray(streamOptions.blockHosts)
    ? streamOptions.blockHosts.filter(Boolean)
    : [];
  const allowedQualities = Array.isArray(streamOptions.allowedQualities)
    ? streamOptions.allowedQualities
      .map((quality) => normalizeQualityKey(quality))
      .filter((quality, index, values) => quality && values.indexOf(quality) === index)
    : [];

  for (const stream of streams) {
    let reason = null;
    const qualityKey = normalizeQualityKey(stream?.quality);

    if (isArchiveStream(stream)) {
      reason = 'archiveFile';
    } else if (isKnownUnplayableStream(stream)) {
      reason = 'knownUnplayable';
    } else if (stream.transport !== 'http') {
      reason = 'nonHttp';
    } else if (allowedQualities.length > 0 && !allowedQualities.includes(qualityKey)) {
      reason = 'notWebReady';
    } else if (streamOptions.webReadyOnly && !isWebReadyHttpStream(stream) && !isTrustedDirectHttpStream(stream) && !isProxyReadyHttpStream(stream) && !needsRegisteredPlaybackProxy(stream)) {
      reason = 'notWebReady';
    } else if (streamOptions.hideHeavyFormats && hasHeavyFormatTraits(stream)) {
      reason = 'heavyFormat';
    } else if (streamOptions.torboxOnlyStreams && !stream.torboxWebDownload) {
      reason = 'notWebReady';
    } else if (maxBytes > 0) {
      const sizeBytes = getStreamSizeBytes(stream);

      if (sizeBytes && sizeBytes > maxBytes) {
        reason = 'tooLarge';
      }
    }

    if (!reason && blockedHosts.length > 0) {
      const hostname = getStreamHostname(stream);

      if (hostname && blockedHosts.some((blockedHost) => hostname.includes(blockedHost))) {
        reason = 'blockedHost';
      }
    }

    if (reason) {
      diagnostics.filteredTotal += 1;
      diagnostics.reasons[reason] += 1;
      if (diagnostics.examples[reason].length < 3) {
        diagnostics.examples[reason].push(toDiagnosticStreamExample(stream));
      }
      continue;
    }

    filteredStreams.push(stream);
  }

  diagnostics.keptTotal = filteredStreams.length;

  return {
    streams: filteredStreams,
    diagnostics
  };
};

const filterConfiguredStreams = (streams, streamOptions) =>
  filterConfiguredStreamsDetailed(streams, streamOptions).streams;

const applyStreamResultLimits = (streams, streamOptions) => {
  const maxPerQuality = normalizePositiveIntegerOption(streamOptions.maxPerQuality);
  const maxPerProvider = normalizePositiveIntegerOption(streamOptions.maxPerProvider);

  if (!maxPerQuality && !maxPerProvider) {
    return streams;
  }

  const qualityCounts = new Map();
  const providerCounts = new Map();
  const limited = [];

  for (const stream of streams) {
    const qualityKey = normalizeQualityKey(stream?.quality);
    const providerKey = getStreamDiversityProviderId(stream) || String(stream?.provider || 'unknown').toLowerCase();

    if (maxPerQuality && (qualityCounts.get(qualityKey) || 0) >= maxPerQuality) {
      continue;
    }

    if (maxPerProvider && (providerCounts.get(providerKey) || 0) >= maxPerProvider) {
      continue;
    }

    qualityCounts.set(qualityKey, (qualityCounts.get(qualityKey) || 0) + 1);
    providerCounts.set(providerKey, (providerCounts.get(providerKey) || 0) + 1);
    limited.push(stream);
  }

  return limited;
};

const relaxEmptyStreamFilters = (streams, streamOptions) =>
  filterConfiguredStreamsDetailed(streams, {
    ...streamOptions,
    webReadyOnly: false,
    hideHeavyFormats: false,
    maxSizeGb: 0
  });

const summarizeStreamOptions = (streamOptions) => {
  const parts = [];

  if (streamOptions.webReadyOnly) {
    parts.push('Web-ready only');
  }

  if (streamOptions.hideHeavyFormats) {
    parts.push('Hide HEVC / HDR / 10-bit');
  }

  if (Array.isArray(streamOptions.allowedQualities) && streamOptions.allowedQualities.length > 0) {
    parts.push(`Qualities: ${streamOptions.allowedQualities.join(', ')}`);
  }

  if (Number(streamOptions.maxSizeGb) > 0) {
    parts.push(`Max ${Number(streamOptions.maxSizeGb)} GB`);
  }

  if (Number(streamOptions.maxPerQuality) > 0) {
    parts.push(`Max ${Number(streamOptions.maxPerQuality)} per quality`);
  }

  if (Number(streamOptions.maxPerProvider) > 0) {
    parts.push(`Max ${Number(streamOptions.maxPerProvider)} per provider`);
  }

  if (Array.isArray(streamOptions.blockHosts) && streamOptions.blockHosts.length > 0) {
    parts.push(`Block hosts: ${streamOptions.blockHosts.join(', ')}`);
  }

  if (normalizeContentSelection(streamOptions.contentSelection) !== 'default') {
    parts.push(`Content: ${toTitleCaseLabel(streamOptions.contentSelection)}`);
  }

  if (streamOptions.preferredAudioLanguage) {
    parts.push(`Prefer audio: ${streamOptions.preferredAudioLanguage}`);
  }

  if (normalizeDedupeMode(streamOptions.dedupeMode) !== 'off') {
    const dedupeLabels = {
      smart: 'Smart dedupe',
      filename: 'Dedupe by filename',
      'host-quality': 'Dedupe by host + quality'
    };
    parts.push(dedupeLabels[normalizeDedupeMode(streamOptions.dedupeMode)] || 'Dedupe on');
  }

  if (streamOptions.preferHdr) {
    parts.push('Prefer HDR');
  }

  if (streamOptions.preferH264) {
    parts.push('Prefer H.264');
  }

  if (streamOptions.preferSmallerFiles) {
    parts.push('Prefer smaller files');
  }

  if (streamOptions.preferDirectHosts) {
    parts.push('Prefer direct hosts');
  }

  if (streamOptions.torboxOnlyStreams) {
    parts.push('TorBox only streams');
  }

  if (streamOptions.torboxUsenet) {
    parts.push('TorBox Usenet');
  }

  if (streamOptions.customProxyUrl) {
    parts.push('Custom proxy');
  }

  if (normalizeFormatterStyle(streamOptions.formatterStyle) !== 'clean') {
    parts.push(`Formatter: ${toTitleCaseLabel(streamOptions.formatterStyle)}`);
  }

  return parts.length > 0 ? parts.join(' • ') : 'Default stream settings';
};

const normalizePrivateCookie = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, PRIVATE_PROVIDER_COOKIE_MAX_LENGTH);
};

const normalizeCustomProxyUrl = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsedUrl = new URL(trimmed);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return null;
    }

    return parsedUrl.toString();
  } catch {
    return null;
  }
};

const matchesProxyPattern = (hostname, pattern) => {
  const normalizedHost = String(hostname || '').trim().toLowerCase();
  const normalizedPattern = String(pattern || '').trim().toLowerCase();

  if (!normalizedHost || !normalizedPattern) {
    return false;
  }

  if (normalizedPattern === '*') {
    return true;
  }

  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix);
  }

  if (!normalizedPattern.includes('*')) {
    return normalizedHost === normalizedPattern;
  }

  const escapedPattern = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*');
  const regex = new RegExp(`^${escapedPattern}$`, 'u');
  return regex.test(normalizedHost);
};

const getConfiguredProxyUrlForStream = (stream, customProxyUrl = null) => {
  const normalizedCustomProxyUrl = normalizeCustomProxyUrl(customProxyUrl);

  if (normalizedCustomProxyUrl) {
    return normalizedCustomProxyUrl;
  }

  if (!stream?.url || stream.transport !== 'http' || !Array.isArray(config.PROXY_CONFIG) || config.PROXY_CONFIG.length === 0) {
    return null;
  }

  try {
    const hostname = new URL(stream.url).hostname.toLowerCase();
    const matchedRule = config.PROXY_CONFIG.find((rule) => matchesProxyPattern(hostname, rule.pattern));
    return matchedRule?.proxyUrl || null;
  } catch {
    return null;
  }
};

const normalizePrivateProviderSettings = (value) => ({
  febboxUiCookie: normalizePrivateCookie(value?.febboxUiCookie),
  showboxOssGroup: normalizePrivateCookie(value?.showboxOssGroup),
  torboxApiKey: normalizePrivateCookie(value?.torboxApiKey)
});

const getPrivateProviderSettingsHash = (privateProviderSettings) => {
  const normalized = normalizePrivateProviderSettings(privateProviderSettings);

  if (!normalized.febboxUiCookie && !normalized.showboxOssGroup && !normalized.torboxApiKey) {
    return null;
  }

  return createHash('sha1')
    .update(JSON.stringify(normalized))
    .digest('hex');
};

const buildCustomProxyStreamUrl = (stream, customProxyUrl) => {
  const normalizedProxyUrl = getConfiguredProxyUrlForStream(stream, customProxyUrl);

  if (!normalizedProxyUrl || !stream || !stream.url || stream.transport !== 'http') {
    return null;
  }

  const serializedHeaders = hasForwardHeaders(stream.headers)
    ? JSON.stringify(stream.headers)
    : '';

  if (normalizedProxyUrl.includes('{url}') || normalizedProxyUrl.includes('{headers}')) {
    return normalizedProxyUrl
      .replaceAll('{url}', encodeURIComponent(stream.url))
      .replaceAll('{headers}', encodeURIComponent(serializedHeaders));
  }

  try {
    const proxyUrl = new URL(normalizedProxyUrl);
    proxyUrl.searchParams.set('url', stream.url);

    if (serializedHeaders) {
      proxyUrl.searchParams.set('headers', serializedHeaders);
    }

    return proxyUrl.toString();
  } catch {
    return null;
  }
};

const getDeliveryPriorityScore = (stream) => {
  if (stream.transport === 'http') {
    return hasForwardHeaders(stream.headers) ? -5000 : 5000;
  }

  if (stream.transport === 'torrent') {
    return -12000;
  }

  return 0;
};

const NUVIO_PLUGIN_PRIORITY_SCORES = Object.freeze({
  notorrent: 260,
  vidlink: 250,
  castle: 240,
  hdhub4u: 230,
  cinemm: 225,
  moviebox: 205,
  goatapi: 200,
  onetouchtv: 190,
  netmirrornew: 185,
  netmirror: 180,
  movieboxhindi: 180,
  hindmoviez: 175,
  isaidub: 165,
  '4khdhubnew': 160,
  '4khdhub': 155,
  uhdmovies: 150,
  hdmovie2: 145
});

const getNuvioPluginPriorityScore = (stream) => {
  const providerId = String(stream?.provider || '').trim().toLowerCase();
  const streamText = [
    stream?.pluginProvider,
    stream?.sourceSite,
    stream?.title,
    stream?.description,
    stream?.name
  ].map((value) => String(value || '')).join(' ');
  const nuvioSourceMatch = streamText.match(/(?:🔗\s*)?([A-Za-z0-9_-]+)\s+from\s+Nuvio/iu);

  if (!providerId.startsWith('nuvio') && !nuvioSourceMatch) {
    return 0;
  }

  const pluginProvider = String(
    stream?.pluginProvider
    || stream?.sourceSite
    || nuvioSourceMatch?.[1]
    || ''
  ).trim().toLowerCase();
  return (NUVIO_PLUGIN_PRIORITY_SCORES[pluginProvider] || 0) * 500;
};

const getProviderPlaybackReliabilityScore = (stream) => {
  const providerId = String(stream?.provider || '').trim().toLowerCase();

  if (providerId.startsWith('nuvio')) {
    return getNuvioPluginPriorityScore(stream);
  }

  if (providerId === 'showbox') {
    return 18000;
  }

  if (providerId === 'vixsrc' || providerId === 'vidsrc' || providerId === 'vidlink' || providerId === 'cinestream') {
    return 7000;
  }

  if (providerId === '4khdhub' || providerId === '4khdhub_tv' || providerId === 'hdhub4u') {
    return -3000;
  }

  return 0;
};

const getProviderPriorityScore = (stream, providerOrder) => {
  if (!Array.isArray(providerOrder) || providerOrder.length === 0) {
    return 0;
  }

  const providerId = String(stream.provider || '').trim().toLowerCase();
  const index = providerOrder.indexOf(providerId);

  if (index === -1) {
    return 0;
  }

  return (providerOrder.length - index) * 1500;
};

const getStreamDiversityProviderId = (stream) => {
  const sourceProvider = String(stream?.sourceProvider || '').trim().toLowerCase();

  if (sourceProvider) {
    return sourceProvider;
  }

  const pluginProvider = String(stream?.pluginProvider || '').trim().toLowerCase();
  const providerId = String(stream?.provider || 'default').trim().toLowerCase() || 'default';

  if (pluginProvider) {
    return `${providerId}:${pluginProvider}`;
  }

  const sourceSite = String(stream?.sourceSite || '').trim().toLowerCase();

  if (sourceSite) {
    return `${providerId}:${sourceSite}`;
  }

  return providerId;
};

const diversifyStreamsByProvider = (streams, { leadingCount = 5, softLimit = 6 } = {}) => {
  if (!Array.isArray(streams) || streams.length <= leadingCount) {
    return streams;
  }

  const output = [];
  const deferred = [];
  const providerCounts = new Map();

  for (const stream of streams) {
    const providerId = getStreamDiversityProviderId(stream);
    const currentCount = providerCounts.get(providerId) || 0;

    if (output.length < leadingCount || currentCount < softLimit) {
      output.push(stream);
      providerCounts.set(providerId, currentCount + 1);
    } else {
      deferred.push(stream);
    }
  }

  return output.concat(deferred);
};

const getStreamDiversityOptions = (streams, { requestedProviders = [] } = {}) => {
  if (!Array.isArray(streams) || streams.length === 0) {
    return { leadingCount: 8, softLimit: 12 };
  }

  if (Array.isArray(requestedProviders) && requestedProviders.length > 0) {
    const normalizedRequestedProviders = requestedProviders.map((provider) => String(provider || '').trim().toLowerCase());
    const diversitySourceCount = new Set(streams.map((stream) => getStreamDiversityProviderId(stream))).size;

    if (normalizedRequestedProviders.length === 1 && normalizedRequestedProviders[0] === 'nuvio' && diversitySourceCount >= 4) {
      return { leadingCount: 5, softLimit: 4 };
    }

    return { leadingCount: 8, softLimit: 12 };
  }

  const fallbackProviderSet = new Set(['vidsrc', 'vixsrc', 'cinestream', 'vidlink', 'moviebox']);
  const hasFallbackProviders = streams.some((stream) =>
    fallbackProviderSet.has(String(stream.provider || '').trim().toLowerCase())
  );

  if (hasFallbackProviders) {
    return { leadingCount: 6, softLimit: 4 };
  }

  return { leadingCount: 8, softLimit: 12 };
};

const fetchTextWithTimeout = async (url, options = {}, timeout = 8000) => {
  const controller = new AbortController();
  allowHighFanoutAbortSignal(controller.signal);
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  timeoutId.unref?.();

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();

    if (contentLength > MAX_FETCH_TEXT_BYTES || contentType.startsWith('video/')) {
      await response.body?.cancel?.();
      throw new Error(`Response too large for text fetch (${contentLength || 'unknown'} bytes)`);
    }

    if (!response.body) {
      const text = await response.text();
      clearTimeout(timeoutId);
      return text;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        receivedBytes += value.byteLength;

        if (receivedBytes > MAX_FETCH_TEXT_BYTES) {
          await reader.cancel();
          throw new Error(`Response too large for text fetch (${receivedBytes} bytes)`);
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    clearTimeout(timeoutId);
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
};

const withTimeoutFallback = async (promise, timeoutMs, fallbackValue) => {
  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const stripHtml = (html) =>
  String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8211;|&#8212;/gi, '-')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/\s+/g, ' ')
    .trim();

const extractHubCloudRedirectHref = (html) => {
  const markup = String(html || '');
  const match = markup.match(/var url ?= ?['"]([^'"]+)['"]/i)
    || markup.match(/id=["']download["'][^>]*href=["']([^"']+)["']/i)
    || markup.match(/href=["']([^"']+)["'][^>]*id=["']download["']/i)
    || markup.match(/window\.location(?:\.href)? ?= ?['"]([^'"]+)['"]/i)
    || markup.match(/location\.replace\(['"]([^'"]+)['"]\)/i)
    || markup.match(/document\.location(?:\.href)? ?= ?['"]([^'"]+)['"]/i)
    || markup.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i)
    || markup.match(/location\.assign\(['"]([^'"]+)['"]\)/i)
    || markup.match(/window\.open\(['"]([^'"]+)/i)
    || markup.match(/data-(?:url|href|link)\s*=\s*['"]([^'"]+)['"]/i)
    || markup.match(/<iframe[^>]+src\s*=\s*['"]([^'"]*(?:hubcloud|gamerxyt|hubdrive|hubcdn)[^'"]*)['"]/i)
    || markup.match(/var\s+\w+\s*=\s*['"]([^'"]*(?:hubcloud|gamerxyt|hubdrive|hubcdn)[^'"]*)['"]/i)
    || markup.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?\d+;\s*url=([^"'>\s]+)/i)
    || markup.match(/https?:\/\/(?:hubcloud\.[a-z.]+|hubdrive\.[a-z.]+|gamerxyt\.com|hubcdn\.fans)[^\s'"<>)]+/i);

  return match?.[1] ? stripHtml(match[1]) : null;
};

const extractHubCloudAnchorCandidates = (html) => {
  const candidates = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = String(match[1] || '').replace(/&amp;/g, '&').trim();
    const text = stripHtml(match[2]);

    if (!href || !/^https?:\/\//i.test(href)) {
      continue;
    }

    candidates.push({ href, text });
  }

  return candidates;
};

const getHubCloudCandidateScore = ({ href, text }) => {
  const normalizedHref = href.toLowerCase();
  const normalizedText = text.toLowerCase();
  let score = 0;

  if (normalizedText.includes('pdl') || normalizedHref.includes('workers.dev')) {
    score += 500;
  }

  if (normalizedText.includes('pixel') || normalizedText.includes('10gbps') || normalizedHref.includes('pixel.') || normalizedHref.includes('hubcdn.fans')) {
    score += 400;
  }

  if (normalizedText.includes('fslv2')) {
    score += 250;
  } else if (normalizedText.includes('fsl')) {
    score += 220;
  }

  if (normalizedHref.includes('hubcloud') || normalizedHref.includes('gamerxyt.com')) {
    score -= 300;
  }

  if (normalizedHref.includes('hubdrive') && normalizedText.includes('download')) {
    score += 120;
  }

  return score;
};

const classifyHubCloudCandidate = ({ href, text }) => {
  const normalizedHref = String(href || '').toLowerCase();
  const normalizedText = String(text || '').toLowerCase();

  if (normalizedText.includes('fslv2')) {
    return 'FSLv2';
  }

  if (normalizedText.includes('fsl')) {
    return 'FSL';
  }

  if (normalizedText.includes('pixelserver') || normalizedText.includes('pixel') || normalizedHref.includes('pixeldrain')) {
    return 'PixelServer';
  }

  if (normalizedText.includes('10gbps') || normalizedHref.includes('hubcdn.fans')) {
    return 'Fast';
  }

  if (normalizedText.includes('pdl') || normalizedHref.includes('workers.dev')) {
    return 'PDL';
  }

  return 'Download';
};

const parseHubCloudTitle = (html) => {
  const explicitTitleMatch = html.match(/<div class="card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (explicitTitleMatch?.[1]) {
    return stripHtml(explicitTitleMatch[1]);
  }

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  return titleMatch?.[1] ? stripHtml(titleMatch[1]) : null;
};

const parseHubCloudSize = (html) => {
  const sizeMatch = html.match(/id=["']size["'][^>]*>([\s\S]*?)</i);
  return sizeMatch?.[1] ? stripHtml(sizeMatch[1]) : null;
};

const hasValidHubCloudDownloadContent = (html) => {
  const markup = String(html || '');

  return /id=["']size["']/i.test(markup)
    || />\s*FSL/i.test(markup)
    || />\s*PixelServer/i.test(markup)
    || /href=["'][^"']*(?:workers\.dev|hubcdn\.fans|\/api\/file\/|\/u\/)/i.test(markup)
    || /(?:download-btn|btn-success|btn-danger)/i.test(markup);
};

const isHubCloudUrl = (streamUrl) => {
  try {
    const hostname = new URL(String(streamUrl || '').trim()).hostname.toLowerCase();
    if (hostname.startsWith('pixel.') || hostname.startsWith('gpdl.')) {
      return false;
    }
    return hostname.includes('hubcloud') || hostname.includes('hubdrive') || hostname === 'gamerxyt.com';
  } catch {
    return false;
  }
};

const isHubDriveUrl = (streamUrl) => {
  try {
    return new URL(String(streamUrl || '').trim()).hostname.toLowerCase().includes('hubdrive');
  } catch {
    return false;
  }
};

const resolveHubDriveDirectDownload = async (streamUrl) => {
  const parsedUrl = new URL(String(streamUrl || '').trim());
  const fileId = parsedUrl.pathname.match(/\/file\/(\d+)/i)?.[1];

  if (!fileId) {
    return null;
  }

  const controller = new AbortController();
  allowHighFanoutAbortSignal(controller.signal);
  const timeoutId = setTimeout(() => controller.abort(), HUBCLOUD_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(new URL('/ajax.php?ajax=direct-download', parsedUrl.origin), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': HUBCLOUD_USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: parsedUrl.toString()
      },
      body: new URLSearchParams({ id: fileId })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const directUrl = String(payload?.data?.gd || '').trim();

    if (String(payload?.code) !== '200' || !/^https?:\/\//i.test(directUrl)) {
      return null;
    }

    const expiresAtSeconds = Number(payload?.data?.t);
    return {
      url: directUrl,
      headers: {
        Referer: parsedUrl.origin,
        'User-Agent': HUBCLOUD_USER_AGENT
      },
      sourceSite: 'HubDrive (Direct)',
      title: String(payload?.data?.n || '').trim() || null,
      size: formatSizeBytes(Number(payload?.data?.s)),
      expiresAt: Number.isFinite(expiresAtSeconds) ? expiresAtSeconds * 1000 : null
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

const getStreamSearchText = (stream) =>
  `${String(stream.name || '')} ${String(stream.title || '')} ${String(stream.filename || '')} ${String(stream.language || '')}`.toLowerCase();

const getVisualTags = (stream) => {
  const text = getStreamSearchText(stream);
  const tags = [];

  if (text.includes('dolby vision') || text.includes('dovi')) {
    tags.push('DV');
  }

  if (text.includes('hdr10+')) {
    tags.push('HDR10+');
  } else if (text.includes('hdr10')) {
    tags.push('HDR10');
  } else if (text.includes('hdr')) {
    tags.push('HDR');
  }

  if (text.includes('imax')) {
    tags.push('IMAX');
  }

  if (text.includes('remux')) {
    tags.push('Remux');
  }

  if (text.includes('web-dl')) {
    tags.push('WEB-DL');
  } else if (text.includes('webrip')) {
    tags.push('WEBRip');
  } else if (text.includes('bluray') || text.includes('blu-ray')) {
    tags.push('BluRay');
  }

  return tags.filter((tag, index, list) => list.indexOf(tag) === index);
};

const getEncodeTags = (stream) => {
  const text = getStreamSearchText(stream);
  const tags = [];

  if (text.includes('hevc') || text.includes('x265') || text.includes('h265')) {
    tags.push('HEVC');
  } else if (text.includes('x264') || text.includes('h264')) {
    tags.push('H.264');
  }

  if (text.includes('10bit') || text.includes('10-bit')) {
    tags.push('10-bit');
  }

  return tags;
};

const getAudioTags = (stream) => {
  const text = getStreamSearchText(stream);
  const tags = [];

  if (text.includes('truehd')) {
    tags.push('TrueHD');
  }

  if (text.includes('atmos')) {
    tags.push('Atmos');
  }

  if (text.includes('ddp') || text.includes('dd+')) {
    tags.push('DD+');
  } else if (/\bdd\b/u.test(text)) {
    tags.push('DD');
  }

  if (text.includes('dts-hd')) {
    tags.push('DTS-HD');
  } else if (/\bdts\b/u.test(text)) {
    tags.push('DTS');
  }

  if (text.includes('aac')) {
    tags.push('AAC');
  }

  return tags.filter((tag, index, list) => list.indexOf(tag) === index);
};

const getCompactTags = (stream) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  const tags = [];

  if (text.includes('hdr10+') || text.includes('hdr10')) {
    tags.push('HDR10+');
  } else if (text.includes('hdr')) {
    tags.push('HDR');
  }

  if (text.includes('dolby vision') || text.includes('dovi')) {
    tags.push('Dolby Vision');
  }

  if (text.includes('web-dl') || text.includes('webrip')) {
    tags.push('WEB-DL');
  } else if (text.includes('bluray') || text.includes('blu-ray')) {
    tags.push('BluRay');
  }

  if (text.includes('hevc') || text.includes('x265')) {
    tags.push('hevc');
  } else if (text.includes('x264') || text.includes('h264')) {
    tags.push('h264');
  }

  if (text.includes('atmos')) {
    tags.push('Atmos');
  } else if (text.includes('aac')) {
    tags.push('AAC');
  }

  return tags;
};

const getTransportLabel = (stream) => {
  if (stream.transport === 'torrent' || stream.magnet || stream.torrent) {
    return 'P2P';
  }

  if (stream.transport === 'http') {
    return hasForwardHeaders(stream.headers) ? 'WEB PROXY' : 'WEB';
  }

  return 'EXT';
};

const truncateCardLine = (value, maxLength = 120) => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}…`;
};

const getStreamFilenameLabel = (stream) => {
  const filename = truncateCardLine(stream.filename || extractFilenameFromUrl(stream.url) || '');

  if (filename) {
    return filename;
  }

  const titleLine = String(stream.title || stream.name || '')
    .split('\n')
    .map((line) => truncateCardLine(line))
    .find(Boolean);
  return titleLine || null;
};

const isGenericStreamTitle = (value) =>
  /^(?:stream|download|watch|play|video|link|file|master\s*m3u8|m3u8|playlist|index)$/iu.test(String(value || '').trim())
    || /^[a-z0-9_-]{8,}\s*(?:lo|la|ll|==)?\s*=\s*m3u8$/iu.test(String(value || '').trim())
    || /^[a-z0-9_-]{12,}$/iu.test(String(value || '').trim());

const getStreamSizeLabel = (stream) => {
  const explicitSize = truncateCardLine(stream.size || '');

  if (explicitSize) {
    return explicitSize;
  }

  const hintedSize = formatSizeBytes(stream.behaviorHints?.videoSize);

  if (hintedSize) {
    return hintedSize;
  }

  const sizeMatch = `${String(stream.title || '')}\n${String(stream.name || '')}`.match(/\b\d+(?:\.\d+)?\s*(?:tb|gb|mb|kb)\b/iu);
  return sizeMatch ? sizeMatch[0].replace(/\s+/g, ' ') : null;
};

const AUDIO_LANGUAGE_PATTERNS = Object.freeze([
  ['Hindi', /\bhindi\b/u],
  ['English', /\benglish\b/u],
  ['Tamil', /\btamil\b/u],
  ['Telugu', /\btelugu\b/u],
  ['Malayalam', /\bmalayalam\b/u],
  ['Kannada', /\bkannada\b/u],
  ['French', /\bfrench\b/u],
  ['German', /\bgerman\b/u],
  ['Latino', /\b(?:latino|lat)\b/u],
  ['Spanish', /\b(?:spanish|espanol|español|castellano|esp)\b/u],
  ['Arabic', /(?:\barabic\b|\barab\b|عربي|مدبلج|مترجم)/u],
  ['Portuguese', /\bportuguese\b/u],
  ['Japanese', /\bjapanese\b/u],
  ['Korean', /\bkorean\b/u],
  ['Turkish', /\b(?:turkish|turkce|türkçe|tr)\b/u],
  ['Italian', /\b(?:italian|italiano|ita)\b/u]
]);

const normalizeAudioLanguageKey = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized || normalized === 'any' || normalized === 'unknown') {
    return null;
  }

  const matched = AUDIO_LANGUAGE_PATTERNS.find(([label]) => label.toLowerCase() === normalized);
  return matched ? matched[0] : null;
};

const getStreamLanguages = (stream) => {
  const text = getStreamSearchText(stream);
  const languages = [];

  for (const [label, pattern] of AUDIO_LANGUAGE_PATTERNS) {
    if (pattern.test(text)) {
      languages.push(label);
    }
  }

  return [...new Set(languages)];
};

const getLanguageLabel = (stream) => {
  const languages = getStreamLanguages(stream);

  if (languages.length === 0) {
    return 'Unknown';
  }

  return [...new Set(languages)].join(' + ');
};

const LANGUAGE_FLAG_MAP = Object.freeze({
  Arabic: '🇸🇦',
  English: '🇺🇸',
  French: '🇫🇷',
  German: '🇩🇪',
  Hindi: '🇮🇳',
  Italian: '🇮🇹',
  Japanese: '🇯🇵',
  Kannada: '🇮🇳',
  Korean: '🇰🇷',
  Latino: '🇲🇽',
  Malayalam: '🇮🇳',
  Portuguese: '🇵🇹',
  Spanish: '🇪🇸',
  Tamil: '🇮🇳',
  Telugu: '🇮🇳',
  Turkish: '🇹🇷'
});

const getStreamLanguageFlags = (stream) =>
  [...new Set(getStreamLanguages(stream).map((language) => LANGUAGE_FLAG_MAP[language]).filter(Boolean))];

const getSourceLabel = (stream) => {
  if (stream.sourceSite) {
    return stream.sourceSite;
  }

  return toTitleCaseLabel(stream.provider || 'default');
};

const getPreferredAudioLanguageScore = (stream, streamOptions) => {
  const preferredAudioLanguage = normalizeAudioLanguageKey(streamOptions.preferredAudioLanguage);

  if (!preferredAudioLanguage) {
    return 0;
  }

  const languages = getStreamLanguages(stream);

  if (languages.includes(preferredAudioLanguage)) {
    return 7000;
  }

  if (languages.length === 0) {
    return 1500;
  }

  return 0;
};

const getStreamPreferenceScore = (stream, streamOptions) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  let score = 0;

  if (streamOptions.preferHdr) {
    if (/\b(hdr|hdr10|hdr10\+|dolby vision|dovi)\b/u.test(text)) {
      score += 4500;
    }
  }

  if (streamOptions.preferH264) {
    if (/\b(h264|x264)\b/u.test(text)) {
      score += 4200;
    } else if (/\b(hevc|x265)\b/u.test(text)) {
      score -= 500;
    }
  }

  if (streamOptions.preferSmallerFiles) {
    const sizeBytes = getStreamSizeBytes(stream);

    if (sizeBytes) {
      const sizeGb = sizeBytes / (1024 * 1024 * 1024);
      score += Math.max(0, 4000 - Math.round(sizeGb * 350));
    }
  }

  if (streamOptions.preferDirectHosts) {
    if (stream.transport === 'http' && !hasForwardHeaders(stream.headers)) {
      score += 3800;
    }
  }

  return score;
};

const formatStremioCardTitle = (stream) => {
  const quality = String(stream.quality || 'Unknown').toUpperCase();
  const visualTags = getVisualTags(stream);
  const encodeTags = getEncodeTags(stream);
  const audioTags = getAudioTags(stream);
  const filename = getStreamFilenameLabel(stream);
  const size = getStreamSizeLabel(stream);
  const lines = [
    `${quality} | ${getTransportLabel(stream)}`,
    visualTags.length > 0 ? `📺 ${visualTags.join(' • ')}` : null,
    encodeTags.length > 0 ? `🎞️ ${encodeTags.join(' • ')}` : null,
    audioTags.length > 0 ? `🎧 ${audioTags.join(' • ')}` : null,
    size ? `📦 ${size}` : null,
    `🌐 ${getLanguageLabel(stream)}`,
    `🔍 ${getSourceLabel(stream)}`,
    filename ? `📁 ${filename}` : null
  ].filter(Boolean);

  return lines.join('\n');
};

const formatStremioCardFacts = (stream) => {
  const normalizedQuality = normalizeQualityKey(stream.quality);
  const qualityLabel = normalizedQuality === '2160p'
    ? '4K'
    : normalizedQuality === 'unknown'
      ? String(stream.quality || '').trim().toUpperCase() || null
      : normalizedQuality.toUpperCase();
  const visualTags = getVisualTags(stream);
  const encodeTags = getEncodeTags(stream);
  const audioTags = getAudioTags(stream);
  const size = getStreamSizeLabel(stream);
  const parts = [
    qualityLabel,
    ...visualTags.slice(0, 2),
    ...encodeTags.slice(0, 2),
    ...audioTags.slice(0, 2),
    getLanguageLabel(stream),
    size,
    getSourceLabel(stream)
  ].filter(Boolean);

  return [...new Set(parts)].join(' • ');
};

const extractFilenameFromUrl = (streamUrl) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    const filename = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '').trim();
    return filename || undefined;
  } catch {
    return undefined;
  }
};

const isPlainMp4Url = (streamUrl) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    return parsedUrl.protocol === 'https:' && parsedUrl.pathname.toLowerCase().endsWith('.mp4');
  } catch {
    return false;
  }
};

const isPlainHlsUrl = (streamUrl) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    return parsedUrl.protocol === 'https:' && parsedUrl.pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
};

const ARCHIVE_STREAM_EXTENSION_PATTERN = /\.(?:zip|rar|7z|tar|gz|bz2|xz)(?:$|[?#\s])/iu;
const KNOWN_UNPLAYABLE_STREAM_HOSTS = new Set([
  'cdn.video-gen.xyz',
  'video-gen.xyz',
  'bb.streamflixserver.site'
]);

const isArchiveStream = (stream) => {
  const text = [
    stream?.filename,
    stream?.fileName,
    stream?.title,
    stream?.name,
    stream?.url
  ].map((value) => String(value || '')).join(' ');

  return ARCHIVE_STREAM_EXTENSION_PATTERN.test(text);
};

const isKnownUnplayableStream = (stream) => {
  try {
    const hostname = new URL(String(stream?.url || '')).hostname.toLowerCase();

    if (!KNOWN_UNPLAYABLE_STREAM_HOSTS.has(hostname)) {
      return false;
    }
  } catch {
    return false;
  }

  const providerText = [
    stream?.provider,
    stream?.sourceProvider,
    stream?.pluginProvider,
    stream?.sourceSite,
    stream?.title,
    stream?.name
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  return providerText.includes('uhdmovies') || providerText.includes('streamflix');
};

const isWebReadyPlaybackProxyStream = (stream) =>
  Boolean(stream?.url)
  && !hasForwardHeaders(getProviderForwardHeaders(stream))
  && (isPlainMp4Url(stream.url) || isPlainHlsUrl(stream.url));

const getTorrentSources = (magnet) => {
  try {
    const parsedUrl = new URL(String(magnet || '').trim());
    const trackers = parsedUrl.searchParams.getAll('tr')
      .map((trackerUrl) => trackerUrl.trim())
      .filter((trackerUrl) => /^https?:\/\/|^udp:\/\//u.test(trackerUrl))
      .map((trackerUrl) => `tracker:${trackerUrl}`);

    return trackers.filter((source, index) => trackers.indexOf(source) === index);
  } catch {
    return [];
  }
};

const getAioStreamType = (stream) => {
  if (stream.transport === 'torrent' || stream.magnet || stream.infoHash) {
    return 'p2p';
  }

  return 'http';
};

const getAioParsedFile = (stream, qualityLabel, visualTags, encodeTags) => {
  const parsedFile = {};
  const normalizedQuality = normalizeQualityKey(stream.quality);
  const languages = getStreamLanguages(stream);

  if (normalizedQuality !== 'unknown') {
    parsedFile.resolution = normalizedQuality;
  } else if (qualityLabel && qualityLabel !== 'UNKNOWN') {
    parsedFile.resolution = qualityLabel;
  }

  if (visualTags.length > 0) {
    parsedFile.quality = visualTags.find((tag) => /web|bluray|remux/iu.test(tag)) || visualTags[0];
    parsedFile.visualTags = visualTags;
  }

  if (encodeTags.length > 0) {
    parsedFile.encode = encodeTags[0];
  }

  parsedFile.audioChannels = [];
  parsedFile.audioTags = getAudioTags(stream);
  parsedFile.languages = languages;
  parsedFile.visualTags = parsedFile.visualTags || visualTags;

  return parsedFile;
};

const getAioStreamData = (stream, stremioStream, parsedRequest, context = {}) => {
  const providerLabel = context.providerLabel || toTitleCaseLabel(stream.provider || 'Default');
  const sourceLabel = context.sourceLabel || getSourceLabel(stream);
  const filename = context.filename || stream.filename || stremioStream.behaviorHints?.filename || stremioStream.filename;
  const size = context.videoSize || getStreamSizeBytes(stream);
  const infoHash = stream.infoHash || stremioStream.infoHash || extractInfoHash(stream.magnet);
  const data = {
    id: createHash('sha1')
      .update([
        parsedRequest.mediaType,
        parsedRequest.imdbId || parsedRequest.tmdbId || '',
        parsedRequest.season || '',
        parsedRequest.episode || '',
        stream.provider || '',
        stream.url || stream.magnet || infoHash || '',
        filename || ''
      ].join('|'))
      .digest('hex'),
    addon: sourceLabel && sourceLabel !== providerLabel
      ? `${providerLabel} / ${sourceLabel}`
      : providerLabel,
    type: getAioStreamType(stream),
    indexer: stream.sourceSite || stream.provider || undefined,
    proxied: Boolean(String(stremioStream.url || '').includes('/stream?')),
    parsedFile: getAioParsedFile(
      stream,
      context.qualityLabel || String(stream.quality || '').toUpperCase(),
      context.visualTags || [],
      context.encodeTags || []
    )
  };

  if (filename) {
    data.filename = filename;
  }

  if (size) {
    data.size = size;
  }

  if (infoHash) {
    data.torrent = {
      infoHash,
      ...(stream.fileIdx !== undefined ? { fileIdx: stream.fileIdx } : {}),
      ...(Array.isArray(stremioStream.sources) && stremioStream.sources.length > 0 ? { sources: stremioStream.sources } : {})
    };
  }

  return data;
};

const toStremioStreamObject = (stream, parsedRequest, streamOptions = DEFAULT_STREAM_OPTIONS) => {
  const streamQuality = stream.quality || 'Unknown';
  const providerLabel = stream.provider ? toTitleCaseLabel(stream.provider) : 'Default';
  const filename = stream.filename || extractFilenameFromUrl(stream.url) || '';
  const visualTags = getVisualTags(stream);
  const encodeTags = getEncodeTags(stream);
  const audioTags = getAudioTags(stream);
  const languageLabel = getLanguageLabel(stream);
  const languageFlags = getStreamLanguageFlags(stream);
  const sourceLabel = getSourceLabel(stream);
  const sizeLabel = getStreamSizeLabel(stream);
  const formatterStyle = normalizeFormatterStyle(streamOptions.formatterStyle);

  const qualityKey = getStreamQualityKey(stream);
  const qualityLabel = qualityKey === 'unknown'
    ? streamQuality.toUpperCase()
    : qualityKey;

  let nameLine = ['NebulaStreams', ...languageFlags, qualityLabel].filter(Boolean).join(' ');

  const primaryCardTitle = filename && !/^[a-f0-9]{20,}$/i.test(filename.replace(/\.[^.]+$/, ''))
    ? filename
    : String(stream.title || '').split('\n')[0];
  const fallbackCardTitle = [
    sourceLabel || providerLabel,
    qualityLabel,
    sizeLabel,
    ...visualTags.slice(0, 2),
    ...encodeTags.slice(0, 2),
    ...audioTags.slice(0, 2),
    languageLabel && languageLabel !== 'Unknown' ? languageLabel : null
  ].filter(Boolean).join(' ');
  const behaviorFilename = filename && !isGenericStreamTitle(filename)
    ? filename
    : primaryCardTitle && !isGenericStreamTitle(primaryCardTitle)
      ? primaryCardTitle
      : fallbackCardTitle;
  let cardTitle = '';
  const videoSize = stream.behaviorHints?.videoSize || getStreamSizeBytes(stream) || undefined;

  if (formatterStyle === 'detailed') {
    cardTitle = formatStremioCardTitle(stream);
  } else if (formatterStyle === 'compact') {
    cardTitle = formatStremioCardFacts(stream);
  } else if (formatterStyle === 'minimal') {
    nameLine = ['NS', ...languageFlags, qualityLabel].filter(Boolean).join(' ');
    cardTitle = [providerLabel, sizeLabel, languageLabel && languageLabel !== 'Unknown' ? languageLabel : null]
      .filter(Boolean)
      .join(' • ');
  } else {
    const cleanTitleLines = [];

    if (primaryCardTitle && !isGenericStreamTitle(primaryCardTitle)) {
      cleanTitleLines.push(truncateCardLine(primaryCardTitle, 140));
    } else if (fallbackCardTitle) {
      cleanTitleLines.push(truncateCardLine(fallbackCardTitle, 140));
    }

    const cleanDetails = [];
    if (sizeLabel) cleanDetails.push(`💾 ${sizeLabel}`);
    cleanDetails.push(
      sourceLabel && sourceLabel !== providerLabel
        ? `🔗 ${sourceLabel} from ${providerLabel}`
        : `🔗 ${providerLabel}`
    );
    cleanTitleLines.push(cleanDetails.join(' '));

    const cleanTech = [
      ...visualTags.slice(0, 3),
      ...encodeTags.slice(0, 2)
    ];
    if (cleanTech.length > 0) {
      cleanTitleLines.push(`📺 ${[...new Set(cleanTech)].join(' · ')}`);
    }

    const cleanAudio = [
      ...audioTags.slice(0, 3),
      ...(languageLabel && languageLabel !== 'Unknown' ? [languageLabel] : [])
    ];
    if (cleanAudio.length > 0) {
      cleanTitleLines.push(`🎧 ${[...new Set(cleanAudio)].join(' · ')}`);
    }

    cardTitle = cleanTitleLines.filter(Boolean).join('\n');
  }

  const base = {
    name: nameLine,
    title: cardTitle,
    description: cardTitle,
    behaviorHints: {
      bingeGroup: parsedRequest.mediaType === 'series'
        ? `nebulastreams-${stream.provider || 'default'}-${getStreamHostname(stream) || 'torrent'}-${normalizeQualityKey(stream.quality)}`
        : undefined,
      ...(behaviorFilename ? { filename: behaviorFilename } : {}),
      ...(videoSize ? { videoSize } : {})
    }
  };

  if (stream.transport === 'torrent' && stream.magnet) {
    const infoHash = extractInfoHash(stream.magnet);

    if (!infoHash) {
      return null;
    }

    const sources = getTorrentSources(stream.magnet);

    const stremioStream = {
      ...base,
      infoHash,
      ...(sources.length > 0 ? { sources } : {})
    };

    return {
      ...stremioStream,
      streamData: getAioStreamData(stream, stremioStream, parsedRequest, {
        providerLabel,
        sourceLabel,
        filename: behaviorFilename,
        qualityLabel,
        visualTags,
        encodeTags,
        videoSize
      })
    };
  }

  if (!stream.url) {
    return null;
  }

  const proxiedUrl = buildCustomProxyStreamUrl(stream, streamOptions.customProxyUrl);
  const requestHeaders = proxiedUrl ? null : hasForwardHeaders(stream.headers) ? { ...stream.headers } : null;
  const streamUrl = proxiedUrl || stream.url;
  const isWebReady = proxiedUrl ? true : isWebReadyHttpStream(stream);

  const stremioStream = {
    ...base,
    url: streamUrl,
    ...(behaviorFilename ? { filename: behaviorFilename } : {}),
    behaviorHints: {
      ...base.behaviorHints,
      notWebReady: !isWebReady,
      ...(requestHeaders ? {
        proxyHeaders: {
          request: requestHeaders
        }
      } : {})
    }
  };

  return {
    ...stremioStream,
    streamData: getAioStreamData(stream, stremioStream, parsedRequest, {
      providerLabel,
      sourceLabel,
      filename: behaviorFilename,
      qualityLabel,
      visualTags,
      encodeTags,
      videoSize
    })
  };
};

export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const createHttpError = (statusCode, message, details) =>
  new HttpError(statusCode, message, details);

export const parseRangeHeader = (rangeHeader, totalSize) => {
  if (!rangeHeader) {
    return {
      start: 0,
      end: totalSize - 1,
      contentLength: totalSize,
      statusCode: 200,
      contentRange: null
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());

  if (!match) {
    throw createHttpError(416, 'Only single byte ranges are supported');
  }

  const [, rawStart, rawEnd] = match;

  if (rawStart === '' && rawEnd === '') {
    throw createHttpError(416, 'Invalid range header');
  }

  let start = rawStart === '' ? null : Number.parseInt(rawStart, 10);
  let end = rawEnd === '' ? null : Number.parseInt(rawEnd, 10);

  if ((start !== null && Number.isNaN(start)) || (end !== null && Number.isNaN(end))) {
    throw createHttpError(416, 'Invalid range header');
  }

  if (start === null) {
    const suffixLength = end;

    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      throw createHttpError(416, 'Invalid suffix range');
    }

    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    end = end ?? totalSize - 1;
  }

  if (start < 0 || end < 0 || start > end || start >= totalSize) {
    throw createHttpError(416, 'Requested range is not satisfiable');
  }

  end = Math.min(end, totalSize - 1);

  return {
    start,
    end,
    contentLength: end - start + 1,
    statusCode: 206,
    contentRange: `bytes ${start}-${end}/${totalSize}`
  };
};

export class StreamManager {
  constructor({ torrentEngine, httpProxy, cacheManager, sourceRegistry, providerService, imdbResolver, userTracker = null }) {
    this.torrentEngine = torrentEngine;
    this.httpProxy = httpProxy;
    this.cacheManager = cacheManager;
    this.sourceRegistry = sourceRegistry;
    this.providerService = providerService;
    this.imdbResolver = imdbResolver;
    this.userTracker = userTracker;
    this.activeStreams = 0;
    this.stremioResultCache = new Map();
    this.stremioResultInFlight = new Map();
    this.stremioBackgroundRefreshes = new Set();
    this.stremioBackgroundRefreshQueue = [];
    this.activeStremioBackgroundRefreshes = 0;
    this.stremioResultCacheDir = cacheConfig.STREMIO_RESULT_CACHE_DIR;
    this.stremioResultCacheDirReady = null;
    this.privateConfigDir = path.join(config.CACHE_DIR, 'private-configs');
    this.privateConfigDirReady = null;
    this.privateConfigStore = new Map();
    this.redisStreamResultCache = new RedisStreamResultCache();
    this.hubCloudCache = new Map();
    this.hubCloudInFlight = new Map();
    this.loadSheddingUntil = 0;
    this.loadSheddingReason = null;
    this.popularStreamPrewarmTimer = null;
    this.popularStreamPrewarmInitialTimer = null;
    this.popularStreamPrewarmRunning = false;
    this.popularStreamPrewarmLastStartedAt = null;
    this.popularStreamPrewarmLastFinishedAt = null;
    this.popularStreamPrewarmLastError = null;
    this.popularStreamPrewarmLastResultCount = 0;
    this.rogPlayAdapter = new RogPlayAdapter({ logger });
    this.germanIptvLiveAdapter = new GermanIptvLiveAdapter({ logger });
  }

  async initialize() {
    await this.ensureStremioResultCacheDir();
    await this.ensurePrivateConfigDir();
    await this.redisStreamResultCache.initialize();
    setTimeout(() => {
      this.loadPrivateConfigs().catch((error) => {
        logger.warn('private config background load failed', { error });
      });
    }, 0).unref?.();
    this.startPopularStreamPrewarm();
  }

  async close() {
    if (this.popularStreamPrewarmTimer) {
      clearInterval(this.popularStreamPrewarmTimer);
      this.popularStreamPrewarmTimer = null;
    }

    if (this.popularStreamPrewarmInitialTimer) {
      clearTimeout(this.popularStreamPrewarmInitialTimer);
      this.popularStreamPrewarmInitialTimer = null;
    }

    this.stremioBackgroundRefreshQueue = [];
    this.stremioBackgroundRefreshes.clear();
    for (const request of this.stremioResultInFlight.values()) {
      request?.controller?.abort?.(createHttpError(499, 'Stream manager closing'));
    }
    this.stremioResultInFlight.clear();
    for (const request of this.hubCloudInFlight.values()) {
      request?.controller?.abort?.(createHttpError(499, 'Stream manager closing'));
    }
    this.hubCloudInFlight.clear();
    await this.redisStreamResultCache.close();
  }

  getStats() {
    return {
      activeStreams: this.activeStreams,
      maxActiveStreams: config.MAX_ACTIVE_STREAMS,
      stremioResultCacheEntries: this.stremioResultCache.size,
      stremioResultInFlight: this.stremioResultInFlight.size,
      maxStremioResultInFlight: config.STREMIO_MAX_INFLIGHT_SEARCHES,
      stremioBackgroundRefreshActive: this.activeStremioBackgroundRefreshes,
      stremioBackgroundRefreshQueued: this.stremioBackgroundRefreshQueue.length,
      stremioBackgroundRefreshTracked: this.stremioBackgroundRefreshes.size,
      maxStremioBackgroundRefreshQueue: config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX,
      redisStreamResultCache: this.redisStreamResultCache.getStats(),
      hubCloudCacheEntries: this.hubCloudCache.size,
      hubCloudInFlight: this.hubCloudInFlight.size,
      popularStreamPrewarm: {
        enabled: Boolean(config.POPULAR_STREAM_PREWARM_ENABLED && this.userTracker),
        running: this.popularStreamPrewarmRunning,
        intervalSeconds: config.POPULAR_STREAM_PREWARM_INTERVAL_SECONDS,
        limit: config.POPULAR_STREAM_PREWARM_LIMIT,
        lastStartedAt: this.popularStreamPrewarmLastStartedAt,
        lastFinishedAt: this.popularStreamPrewarmLastFinishedAt,
        lastError: this.popularStreamPrewarmLastError,
        lastResultCount: this.popularStreamPrewarmLastResultCount
      },
      loadSheddingUntil: this.loadSheddingUntil,
      loadSheddingReason: this.loadSheddingReason
    };
  }

  enableLoadShedding({ durationMs, reason }) {
    this.loadSheddingUntil = Math.max(this.loadSheddingUntil, Date.now() + durationMs);
    this.loadSheddingReason = reason || 'memory-pressure';
    this.stremioBackgroundRefreshQueue = [];
    this.stremioBackgroundRefreshes.clear();
  }

  isLoadShedding() {
    if (this.loadSheddingUntil <= Date.now()) {
      this.loadSheddingReason = null;
      return false;
    }

    return true;
  }

  async waitForStremioResultSlot({ resultCacheKey, tmdbId, mediaType }) {
    this.sweepStaleStremioInFlight();

    if (this.stremioResultInFlight.size < config.STREMIO_MAX_INFLIGHT_SEARCHES) {
      return true;
    }

    if (config.STREMIO_INFLIGHT_SLOT_WAIT_MS <= 0) {
      return false;
    }

    const deadline = Date.now() + config.STREMIO_INFLIGHT_SLOT_WAIT_MS;
    logger.warn('stremio stream search waiting for in-flight slot', {
      inFlightSearches: this.stremioResultInFlight.size,
      maxInFlightSearches: config.STREMIO_MAX_INFLIGHT_SEARCHES,
      waitMs: config.STREMIO_INFLIGHT_SLOT_WAIT_MS,
      tmdbId,
      mediaType
    });

    while (this.stremioResultInFlight.size >= config.STREMIO_MAX_INFLIGHT_SEARCHES) {
      if (this.stremioResultInFlight.has(resultCacheKey)) {
        return true;
      }

      if (this.isLoadShedding()) {
        return false;
      }

      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        return false;
      }

      const activeRequests = Array.from(this.stremioResultInFlight.values());

      if (activeRequests.length === 0) {
        return true;
      }

      await Promise.race([
        Promise.race(activeRequests.map((request) => request.catch(() => undefined))),
        delay(Math.min(remainingMs, 500))
      ]);
    }

    return true;
  }

  sweepStaleStremioInFlight() {
    const now = Date.now();
    let staleCount = 0;

    for (const [cacheKey, request] of this.stremioResultInFlight.entries()) {
      const startedAt = Number(request?.startedAt || 0);
      if (!startedAt || now - startedAt <= STREMIO_INFLIGHT_STALE_MS) {
        continue;
      }

      staleCount += 1;
      request?.controller?.abort?.(createHttpError(499, 'Stale Stremio search aborted'));
      this.stremioResultInFlight.delete(cacheKey);
    }

    if (staleCount > 0) {
      logger.warn('stale stremio searches aborted', {
        staleCount,
        remainingInFlight: this.stremioResultInFlight.size
      });
    }
  }

  handleMemoryPressure({ critical = false } = {}) {
    if (critical) {
      this.stremioResultCache.clear();
      this.hubCloudCache.clear();
      this.stremioBackgroundRefreshQueue = [];
      this.stremioBackgroundRefreshes.clear();
      return;
    }

    pruneMapByMaxEntries(this.stremioResultCache, Math.max(50, Math.floor(config.STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES / 4)));
    pruneMapByApproxBytes(this.stremioResultCache, Math.max(512 * 1024, Math.floor((config.STREMIO_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024) / 4)));
    pruneMapByMaxEntries(this.hubCloudCache, Math.max(20, Math.floor(config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES / 4)));
    pruneMapByApproxBytes(this.hubCloudCache, Math.max(128 * 1024, Math.floor((config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024) / 4)));
    if (this.stremioBackgroundRefreshQueue.length > 0) {
      const keep = Math.max(0, Math.floor(config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX / 4));
      if (this.stremioBackgroundRefreshQueue.length > keep) {
        this.stremioBackgroundRefreshQueue = this.stremioBackgroundRefreshQueue.slice(0, keep);
      }
    }
  }

  getProviderLiveLoad() {
    if (!this.providerService || typeof this.providerService.getLiveLoad !== 'function') {
      return {
        inFlightRequests: 0,
        activeProviderExecutions: 0
      };
    }

    return this.providerService.getLiveLoad();
  }

  shouldSkipBackgroundRefresh() {
    if (this.isLoadShedding()) {
      return true;
    }

    const providerLoad = this.getProviderLiveLoad();
    return this.stremioResultInFlight.size >= config.STREMIO_BACKGROUND_REFRESH_MAX_INFLIGHT_SEARCHES
      || providerLoad.activeProviderExecutions >= config.STREMIO_BACKGROUND_REFRESH_MAX_PROVIDER_EXECUTIONS;
  }

  shouldSkipPopularPrewarm() {
    if (this.isLoadShedding()) {
      return true;
    }

    const providerLoad = this.getProviderLiveLoad();
    return this.stremioResultInFlight.size >= config.POPULAR_STREAM_PREWARM_MAX_INFLIGHT_SEARCHES
      || providerLoad.activeProviderExecutions >= config.POPULAR_STREAM_PREWARM_MAX_PROVIDER_EXECUTIONS;
  }

  startPopularStreamPrewarm() {
    if (!config.POPULAR_STREAM_PREWARM_ENABLED || !this.userTracker || this.popularStreamPrewarmTimer) {
      return;
    }

    const runPrewarm = () => {
      this.prewarmPopularStreams().catch((error) => {
        this.popularStreamPrewarmLastError = error?.message || String(error);
        logger.warn('popular stream prewarm failed', { error });
      });
    };

    const intervalMs = config.POPULAR_STREAM_PREWARM_INTERVAL_SECONDS * 1000;
    this.popularStreamPrewarmInitialTimer = setTimeout(runPrewarm, Math.min(10_000, intervalMs));
    this.popularStreamPrewarmInitialTimer.unref();
    this.popularStreamPrewarmTimer = setInterval(runPrewarm, intervalMs);
    this.popularStreamPrewarmTimer.unref();
  }

  async prewarmPopularStreams() {
    if (this.popularStreamPrewarmRunning || this.shouldSkipPopularPrewarm()) {
      return;
    }

    const popularSearches = this.userTracker.getPopularStreamSearches({
      limit: config.POPULAR_STREAM_PREWARM_LIMIT,
      maxAgeHours: config.POPULAR_STREAM_PREWARM_MAX_AGE_HOURS
    });

    if (popularSearches.length === 0) {
      return;
    }

    this.popularStreamPrewarmRunning = true;
    this.popularStreamPrewarmLastStartedAt = new Date().toISOString();
    this.popularStreamPrewarmLastError = null;
    let refreshedCount = 0;

    try {
      for (const search of popularSearches) {
        if (this.shouldSkipPopularPrewarm()) {
          break;
        }

        const resultCacheKey = this.buildStremioResultCacheKey({
          tmdbId: search.tmdbId,
          mediaType: search.mediaType,
          season: search.season,
          episode: search.episode,
          providers: search.providers,
          qualityPriority: search.qualityPriority,
          streamOptions: search.streamOptions
        });
        const cachedResult = await this.getCachedStremioStreams(resultCacheKey);

        if (cachedResult?.state === 'fresh') {
          continue;
        }

        await this.getOrBuildStremioStreams({
          resultCacheKey,
          baseUrl: config.PUBLIC_BASE_URL,
          parsed: {
            imdbId: search.imdbId || String(search.tmdbId),
            mediaType: search.mediaType,
            season: search.season,
            episode: search.episode
          },
          requestedProviders: search.providers,
          qualityPriority: search.qualityPriority,
          streamOptions: search.streamOptions,
          tmdbId: search.tmdbId
        });
        refreshedCount += 1;
      }

      this.popularStreamPrewarmLastResultCount = refreshedCount;
      this.popularStreamPrewarmLastFinishedAt = new Date().toISOString();
      logger.info('popular stream prewarm finished', {
        checkedCount: popularSearches.length,
        refreshedCount
      });
    } catch (error) {
      this.popularStreamPrewarmLastError = error?.message || String(error);
      throw error;
    } finally {
      this.popularStreamPrewarmRunning = false;
    }
  }

  async ensureStremioResultCacheDir() {
    if (!this.stremioResultCacheDirReady) {
      this.stremioResultCacheDirReady = mkdir(this.stremioResultCacheDir, { recursive: true });
    }

    await this.stremioResultCacheDirReady;
  }

  async ensurePrivateConfigDir() {
    if (!this.privateConfigDirReady) {
      this.privateConfigDirReady = mkdir(this.privateConfigDir, { recursive: true });
    }

    await this.privateConfigDirReady;
  }

  normalizePrivateConfigRecord(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const providers = this.providerService.normalizeProviders(payload.providers);
    const requestedQualityPriority = Array.isArray(payload.qualityPriority)
      ? payload.qualityPriority
        .map((value) => normalizeQualityKey(value))
        .filter(Boolean)
      : [];
    const qualityPriority = requestedQualityPriority.filter((quality, index) =>
      requestedQualityPriority.indexOf(quality) === index
    );

    for (const quality of DEFAULT_QUALITY_PRIORITY) {
      if (!qualityPriority.includes(quality)) {
        qualityPriority.push(quality);
      }
    }

    const baseStreamOptions = payload.streamOptions && typeof payload.streamOptions === 'object'
      ? payload.streamOptions
      : {};
    const streamOptions = {
      webReadyOnly: Boolean(baseStreamOptions.webReadyOnly),
      hideHeavyFormats: Boolean(baseStreamOptions.hideHeavyFormats),
      allowedQualities: Array.isArray(baseStreamOptions.allowedQualities)
        ? baseStreamOptions.allowedQualities
          .map((value) => normalizeQualityKey(value))
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index)
        : [],
      maxSizeGb: Number.isFinite(Number(baseStreamOptions.maxSizeGb)) && Number(baseStreamOptions.maxSizeGb) > 0
        ? Number(baseStreamOptions.maxSizeGb)
        : 0,
      maxPerQuality: normalizePositiveIntegerOption(baseStreamOptions.maxPerQuality),
      maxPerProvider: normalizePositiveIntegerOption(baseStreamOptions.maxPerProvider),
      blockHosts: Array.isArray(baseStreamOptions.blockHosts)
        ? baseStreamOptions.blockHosts
          .map((value) => String(value || '').trim().toLowerCase())
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index)
        : [],
      contentSelection: normalizeContentSelection(baseStreamOptions.contentSelection),
      preferredAudioLanguage: normalizeAudioLanguageKey(baseStreamOptions.preferredAudioLanguage),
      dedupeMode: normalizeDedupeMode(baseStreamOptions.dedupeMode),
      preferHdr: Boolean(baseStreamOptions.preferHdr),
      preferH264: Boolean(baseStreamOptions.preferH264),
      preferSmallerFiles: Boolean(baseStreamOptions.preferSmallerFiles),
      preferDirectHosts: Boolean(baseStreamOptions.preferDirectHosts),
      torboxOnlyStreams: Boolean(baseStreamOptions.torboxOnlyStreams),
      torboxUsenet: Boolean(baseStreamOptions.torboxUsenet),
      formatterStyle: normalizeFormatterStyle(baseStreamOptions.formatterStyle),
      customProxyUrl: normalizeCustomProxyUrl(baseStreamOptions.customProxyUrl)
    };
    const privateProviderSettings = normalizePrivateProviderSettings(payload.privateProviderSettings);
    const profileCode = typeof payload.profileCode === 'string'
      ? payload.profileCode.trim().toLowerCase()
      : null;

    return {
      version: PRIVATE_CONFIG_VERSION,
      providers,
      qualityPriority,
      streamOptions,
      privateProviderSettings,
      profileCode: profileCode && CONFIGURED_PROFILE_LABELS[profileCode] ? profileCode : null,
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : new Date().toISOString()
    };
  }

  getPrivateConfigPath(configId) {
    return path.join(this.privateConfigDir, `${configId}.json`);
  }

  async loadPrivateConfigs() {
    try {
      await this.ensurePrivateConfigDir();
      const entries = await readdir(this.privateConfigDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }

        const configId = entry.name.slice(0, -'.json'.length);

        try {
          const payload = JSON.parse(await readFile(this.getPrivateConfigPath(configId), 'utf8'));
          const normalized = this.normalizePrivateConfigRecord(payload);

          if (normalized) {
            this.privateConfigStore.set(configId, normalized);
          }
        } catch (error) {
          logger.warn('private config load failed', {
            configId,
            error
          });
        }
      }
    } catch (error) {
      logger.warn('private config directory scan failed', { error });
    }
  }

  getRequestedPrivateConfig(req) {
    const configId = typeof req.params?.privateConfigId === 'string'
      ? req.params.privateConfigId.trim()
      : '';

    if (!configId) {
      return null;
    }

    const privateConfig = this.privateConfigStore.get(configId) || null;

    if (!privateConfig) {
      throw createHttpError(404, 'Private config not found');
    }

    return privateConfig;
  }

  getRequestedPrivateProviderSettings(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (!privateConfig) {
      return { ...DEFAULT_PRIVATE_PROVIDER_SETTINGS };
    }

    return {
      ...DEFAULT_PRIVATE_PROVIDER_SETTINGS,
      ...normalizePrivateProviderSettings(privateConfig.privateProviderSettings)
    };
  }

  async createPrivateConfig(payload) {
    const normalized = this.normalizePrivateConfigRecord(payload);

    if (!normalized) {
      throw createHttpError(400, 'Invalid private config payload');
    }

    const configId = createHash('sha1')
      .update(JSON.stringify({
        version: PRIVATE_CONFIG_VERSION,
        providers: normalized.providers,
        qualityPriority: normalized.qualityPriority,
        streamOptions: normalized.streamOptions,
        privateProviderSettingsHash: getPrivateProviderSettingsHash(normalized.privateProviderSettings),
        profileCode: normalized.profileCode
      }))
      .digest('hex')
      .slice(0, 24);

    await this.ensurePrivateConfigDir();
    await writeFile(this.getPrivateConfigPath(configId), JSON.stringify(normalized));
    this.privateConfigStore.set(configId, normalized);

    return {
      configId,
      manifestPath: `/private/${configId}/manifest.json`
    };
  }

  buildStremioResultCacheKey({ tmdbId, mediaType, season, episode, providers, qualityPriority, streamOptions, privateProviderSettingsHash = null }) {
    return JSON.stringify({
      version: 129,
      tmdbId,
      mediaType,
      season: season ?? null,
      episode: episode ?? null,
      providers: providers ?? [],
      qualityPriority,
      streamOptions: streamOptions ?? DEFAULT_STREAM_OPTIONS,
      privateProviderSettingsHash
    });
  }

  getStremioResultCachePath(cacheKey) {
    const fileName = `${createHash('sha1').update(cacheKey).digest('hex')}.json`;
    return path.join(this.stremioResultCacheDir, fileName);
  }

  getStremioLastGoodCachePath(cacheKey) {
    const fileName = `${createHash('sha1').update(cacheKey).digest('hex')}.lastgood.json`;
    return path.join(this.stremioResultCacheDir, fileName);
  }

  sendStremioStreamsResponse(res, streams) {
    if (res.headersSent) {
      return;
    }

    const normalizedStreams = Array.isArray(streams) ? streams : [];

    if (normalizedStreams.length === 0) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=60');
    }

    res.setHeader('X-NebulaStreams-Stream-Count', String(normalizedStreams.length));
    res.json({
      streams: normalizedStreams
    });
  }

  toCacheLookupResult(cacheKey, entry) {
    if (!entry) {
      return null;
    }

    const now = Date.now();

    if (entry.expiresAt > now) {
      touchMapEntry(this.stremioResultCache, cacheKey, entry);
      return {
        state: 'fresh',
        streams: deserializeObjects(entry.serializedStreams),
        expiresAt: entry.expiresAt,
        staleExpiresAt: entry.staleExpiresAt
      };
    }

    if (entry.staleExpiresAt > now) {
      touchMapEntry(this.stremioResultCache, cacheKey, entry);
      return {
        state: 'stale',
        streams: deserializeObjects(entry.serializedStreams),
        expiresAt: entry.expiresAt,
        staleExpiresAt: entry.staleExpiresAt
      };
    }

    this.stremioResultCache.delete(cacheKey);
    return null;
  }

  async getCachedStremioStreams(cacheKey, { allowStale = false } = {}) {
    const cached = this.stremioResultCache.get(cacheKey);
    const cachedResult = this.toCacheLookupResult(cacheKey, cached);

    if (cachedResult && (cachedResult.state === 'fresh' || allowStale)) {
      return cachedResult;
    }

    const redisEntry = await this.redisStreamResultCache.get(cacheKey);
    const redisResult = this.toCacheLookupResult(cacheKey, redisEntry);

    if (redisResult && (redisResult.state === 'fresh' || allowStale)) {
      logger.info('stremio result redis cache hit', {
        state: redisResult.state,
        resultCount: redisResult.streams.length
      });
      return redisResult;
    }

    await this.ensureStremioResultCacheDir();

    try {
      const payload = JSON.parse(await readFile(this.getStremioResultCachePath(cacheKey), 'utf8'));
      const entry = normalizeStremioResultCacheEntry(payload);
      const diskResult = this.toCacheLookupResult(cacheKey, entry);

      if (!diskResult) {
        await rm(this.getStremioResultCachePath(cacheKey), { force: true });
        return null;
      }

      touchMapEntry(this.stremioResultCache, cacheKey, entry);
      pruneMapByMaxEntries(this.stremioResultCache, config.STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES);
      pruneMapByApproxBytes(this.stremioResultCache, config.STREMIO_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);

      if (diskResult.state === 'fresh' || allowStale) {
        return diskResult;
      }

      return null;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('stremio result cache read failed', {
          error
        });
      }

      return null;
    }
  }

  async getLastGoodStremioStreams(cacheKey) {
    await this.ensureStremioResultCacheDir();

    try {
      const payload = JSON.parse(await readFile(this.getStremioLastGoodCachePath(cacheKey), 'utf8'));
      const entry = normalizeStremioResultCacheEntry(payload);
      const result = this.toCacheLookupResult(cacheKey, entry);

      if (!result) {
        await rm(this.getStremioLastGoodCachePath(cacheKey), { force: true });
        return null;
      }

      return result.streams;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('stremio last-good cache read failed', {
          error
        });
      }

      return null;
    }
  }

  async setCachedStremioStreams(cacheKey, streams, { weak = false, hasCinestream = false, hasShowbox = false } = {}) {
    if (!Array.isArray(streams) || streams.length === 0) {
      return;
    }

    const now = Date.now();
    const signedTtlSeconds = getSignedStreamCacheLimit(streams, now);
    const sourceTokenTtlSeconds = getSourceTokenStreamCacheLimit(streams, now);
    const defaultResultTtlSeconds = hasShowbox
      ? SHOWBOX_RESULT_CACHE_TTL_SECONDS
      : hasCinestream
        ? CINESTREAM_RESULT_CACHE_TTL_SECONDS
        : DEFAULT_NON_EMPTY_RESULT_CACHE_TTL_SECONDS;
    const freshTtlSeconds = weak
      ? Math.min(config.STREMIO_WEAK_RESULT_CACHE_TTL_SECONDS, defaultResultTtlSeconds)
      : defaultResultTtlSeconds;
    const cappedFreshTtlSeconds = signedTtlSeconds === null
      ? freshTtlSeconds
      : Math.min(freshTtlSeconds, signedTtlSeconds);
    const sourceTokenCappedFreshTtlSeconds = sourceTokenTtlSeconds === null
      ? cappedFreshTtlSeconds
      : Math.min(cappedFreshTtlSeconds, sourceTokenTtlSeconds);
    const freshTtlMs = sourceTokenCappedFreshTtlSeconds * 1000;
    const staleTtlMs = weak
      ? freshTtlMs
      : signedTtlSeconds !== null || sourceTokenTtlSeconds !== null
        ? freshTtlMs
      : Math.max(
        freshTtlMs,
        config.STREMIO_RESULT_STALE_TTL_SECONDS * 1000
      );
    const serializedStreams = serializeObjects(streams);
    const entry = {
      expiresAt: now + freshTtlMs,
      staleExpiresAt: now + staleTtlMs,
      weak: Boolean(weak),
      approxBytes: getSerializedApproxBytes(serializedStreams),
      serializedStreams
    };

    touchMapEntry(this.stremioResultCache, cacheKey, entry);
    pruneMapByMaxEntries(this.stremioResultCache, config.STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES);
    pruneMapByApproxBytes(this.stremioResultCache, config.STREMIO_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);
    await this.redisStreamResultCache.set(cacheKey, entry);
    await this.ensureStremioResultCacheDir();

    try {
      await writeFile(this.getStremioResultCachePath(cacheKey), JSON.stringify(entry));
    } catch (error) {
      logger.warn('stremio result cache write failed', {
        error
      });
    }

    if (shouldPersistLastGoodStreamSet(streams)) {
      const lastGoodTtlMs = Math.min(
        config.STREMIO_LAST_GOOD_TTL_SECONDS * 1000,
        freshTtlMs
      );
      const lastGoodEntry = {
        expiresAt: now + lastGoodTtlMs,
        staleExpiresAt: now + lastGoodTtlMs,
        weak: false,
        approxBytes: getSerializedApproxBytes(serializedStreams),
        serializedStreams
      };

      try {
        await writeFile(this.getStremioLastGoodCachePath(cacheKey), JSON.stringify(lastGoodEntry));
      } catch (error) {
        logger.warn('stremio last-good cache write failed', {
          error
        });
      }
    }
  }

  getRequestedProviders(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (privateConfig) {
      return [...privateConfig.providers];
    }

    const rawConfig = typeof req.params?.providerConfig === 'string'
      ? req.params.providerConfig
      : typeof req.query?.providers === 'string'
        ? req.query.providers
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'all') {
      return [];
    }

    const requestedProviders = decoded
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    return this.providerService.normalizeProviders(requestedProviders);
  }

  getRequestedQualityPriority(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (privateConfig) {
      return [...privateConfig.qualityPriority];
    }

    const rawConfig = typeof req.params?.qualityConfig === 'string'
      ? req.params.qualityConfig
      : typeof req.query?.qualities === 'string'
        ? req.query.qualities
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'default') {
      return [...DEFAULT_QUALITY_PRIORITY];
    }

    const requestedQualities = decoded
      .split(',')
      .map((value) => normalizeQualityKey(value))
      .filter(Boolean);
    const uniqueQualities = requestedQualities.filter((quality, index) =>
      requestedQualities.indexOf(quality) === index
    );

    if (uniqueQualities.length === 0) {
      return [...DEFAULT_QUALITY_PRIORITY];
    }

    for (const quality of DEFAULT_QUALITY_PRIORITY) {
      if (!uniqueQualities.includes(quality)) {
        uniqueQualities.push(quality);
      }
    }

    return uniqueQualities;
  }

  getRequestedStreamOptions(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (privateConfig) {
      return {
        ...DEFAULT_STREAM_OPTIONS,
        ...privateConfig.streamOptions,
        allowedQualities: Array.isArray(privateConfig.streamOptions?.allowedQualities)
          ? [...privateConfig.streamOptions.allowedQualities]
          : [],
        maxPerQuality: normalizePositiveIntegerOption(privateConfig.streamOptions?.maxPerQuality),
        maxPerProvider: normalizePositiveIntegerOption(privateConfig.streamOptions?.maxPerProvider),
        blockHosts: Array.isArray(privateConfig.streamOptions?.blockHosts)
          ? [...privateConfig.streamOptions.blockHosts]
          : [],
        contentSelection: normalizeContentSelection(privateConfig.streamOptions?.contentSelection),
        formatterStyle: normalizeFormatterStyle(privateConfig.streamOptions?.formatterStyle),
        customProxyUrl: normalizeCustomProxyUrl(privateConfig.streamOptions?.customProxyUrl)
      };
    }

    const rawConfig = typeof req.params?.optionConfig === 'string'
      ? req.params.optionConfig
      : typeof req.query?.options === 'string'
        ? req.query.options
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'default') {
      return { ...DEFAULT_STREAM_OPTIONS };
    }

    const tokens = decoded
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    let maxSizeGb = 0;
    let blockHosts = [];
    let preferredAudioLanguage = null;
    let dedupeMode = 'off';
    let formatterStyle = 'clean';
    let allowedQualities = [];
    let maxPerQuality = 0;
    let maxPerProvider = 0;
    let contentSelection = 'default';

    for (const token of tokens) {
      if (token.startsWith('qualities=')) {
        allowedQualities = token
          .slice('qualities='.length)
          .split('|')
          .map((value) => normalizeQualityKey(value))
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index);
      }

      if (token.startsWith('max-size-gb=')) {
        const parsed = Number.parseFloat(token.slice('max-size-gb='.length));

        if (Number.isFinite(parsed) && parsed > 0) {
          maxSizeGb = parsed;
        }
      }

      if (token.startsWith('max-per-quality=')) {
        maxPerQuality = normalizePositiveIntegerOption(token.slice('max-per-quality='.length));
      }

      if (token.startsWith('max-per-provider=')) {
        maxPerProvider = normalizePositiveIntegerOption(token.slice('max-per-provider='.length));
      }

      if (token.startsWith('content=')) {
        contentSelection = normalizeContentSelection(token.slice('content='.length));
      }

      if (token.startsWith('block-hosts=')) {
        blockHosts = token
          .slice('block-hosts='.length)
          .split('|')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index);
      }

      if (token.startsWith('preferred-audio=')) {
        preferredAudioLanguage = normalizeAudioLanguageKey(token.slice('preferred-audio='.length));
      }

      if (token.startsWith('dedupe=')) {
        dedupeMode = normalizeDedupeMode(token.slice('dedupe='.length));
      }

      if (token.startsWith('formatter=')) {
        formatterStyle = normalizeFormatterStyle(token.slice('formatter='.length));
      }
    }

    return {
      webReadyOnly: tokens.includes('web-ready-only'),
      hideHeavyFormats: tokens.includes('hide-heavy-formats'),
      allowedQualities,
      maxSizeGb,
      maxPerQuality,
      maxPerProvider,
      blockHosts,
      contentSelection,
      preferredAudioLanguage,
      dedupeMode,
      preferHdr: tokens.includes('prefer-hdr'),
      preferH264: tokens.includes('prefer-h264'),
      preferSmallerFiles: tokens.includes('prefer-smaller-files'),
      preferDirectHosts: tokens.includes('prefer-direct-hosts'),
      torboxOnlyStreams: tokens.includes('torbox-only-streams'),
      torboxUsenet: tokens.includes('torbox-usenet'),
      formatterStyle,
      customProxyUrl: null
    };
  }

  getRequestedConfiguredProfile(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (privateConfig?.profileCode) {
      return CONFIGURED_PROFILE_LABELS[privateConfig.profileCode] || null;
    }

    const rawConfig = typeof req.params?.optionConfig === 'string'
      ? req.params.optionConfig
      : typeof req.query?.options === 'string'
        ? req.query.options
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';
    const profileToken = decoded
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .find((token) => token.startsWith('profile='));
    const queryProfile = typeof req.query?.profile === 'string'
      ? req.query.profile.trim().toLowerCase()
      : '';
    const profileKey = profileToken
      ? profileToken.slice('profile='.length)
      : queryProfile;

    return CONFIGURED_PROFILE_LABELS[profileKey] || null;
  }

  getAddonPresentation(req) {
    const providers = this.getRequestedProviders(req);
    const qualityPriority = this.getRequestedQualityPriority(req);
    const streamOptions = this.getRequestedStreamOptions(req);
    const privateProviderSettingsHash = getPrivateProviderSettingsHash(this.getRequestedPrivateProviderSettings(req));
    const configuredProfile = this.getRequestedConfiguredProfile(req);
    const hasDefaultQualityPriority = qualityPriority.join(',') === DEFAULT_QUALITY_PRIORITY.join(',');
    const hasDefaultStreamOptions = JSON.stringify(streamOptions) === JSON.stringify(DEFAULT_STREAM_OPTIONS);

    if (providers.length === 0 && hasDefaultQualityPriority && hasDefaultStreamOptions && !privateProviderSettingsHash) {
      return {
        providers,
        qualityPriority,
        streamOptions,
        addonId: getStandaloneAddonId(req),
        addonName: config.STREMIO_ADDON_NAME,
        configurable: true,
        description: config.CONFIGURATION_DESCRIPTION
      };
    }

    const providerHash = createHash('sha1')
      .update(`${providers.join(',')}|${qualityPriority.join(',')}|${JSON.stringify(streamOptions)}|${privateProviderSettingsHash || ''}`)
      .digest('hex')
      .slice(0, 10);
    const providerSummary = providers.length > 0
      ? `${providers.length} selected provider${providers.length === 1 ? '' : 's'}`
      : 'all providers';
    const configuredLabel = configuredProfile || { code: 'CFG', label: 'Custom' };

    return {
      providers,
      qualityPriority,
      streamOptions,
      addonId: `${getStandaloneAddonId(req)}.${providerHash}`,
      addonName: `${config.STREMIO_ADDON_NAME}(${configuredLabel.code})`,
      configurable: true,
      description: `Configured install: ${configuredLabel.label}. Providers: ${providerSummary}. Quality priority: ${qualityPriority.join(' > ')}. Playback: ${summarizeStreamOptions(streamOptions)}`
    };
  }

  async handleStremioManifest(req, res) {
    const baseUrl = getStremioRequestBaseUrl(req);
    const addonPresentation = this.getAddonPresentation(req);
    const contentSelection = normalizeContentSelection(addonPresentation.streamOptions?.contentSelection);
    const manifestTypes = contentSelection === 'movie'
      ? ['movie']
      : contentSelection === 'series'
        ? ['series']
        : ['movie', 'series', 'tv'];
    const liveCatalogs = contentSelection === 'default' ? [
      ...this.rogPlayAdapter.getLiveCatalogDefinitions(),
      ...this.germanIptvLiveAdapter.getLiveCatalogDefinitions()
    ].map((catalog) => ({
      type: 'tv',
      id: catalog.id,
      name: catalog.name,
      extra: [
        { name: 'skip', isRequired: false },
        { name: 'search', isRequired: false }
      ]
    })) : [];

    res.json({
      id: addonPresentation.addonId,
      version: '1.0.4',
      name: addonPresentation.addonName,
      description: addonPresentation.description,
      resources: [
        'stream',
        {
          name: 'catalog',
          types: ['tv'],
          idPrefixes: ['rogplay:', 'cs-german:']
        },
        {
          name: 'meta',
          types: ['tv'],
          idPrefixes: ['rogplay:', 'cs-german:']
        }
      ],
      types: manifestTypes,
      idPrefixes: ['tt', 'tmdb:', 'rogplay:', 'cs-german:'],
      catalogs: liveCatalogs,
      behaviorHints: {
        configurable: addonPresentation.configurable,
        configurationRequired: false,
        p2p: false
      },
      logo: `${baseUrl}/assets/WhatsApp%20Image%202026-04-25%20at%2012.16.53%20AM.jpeg`,
      stremioAddonsConfig: {
        issuer: 'https://stremio-addons.net',
        signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..c1dKT48ayjjpai4JwQCcTA.cTsGooecPtjL0uCwd_o8UuHCo--DfHlIfkqcpk5Pk5UidakL038sCsT2RMB6AuUyBZOVlVP2LKHbygHwNcYtcADvRZIK53YGr-SL2V9L8YH6SFgUwJC5eBE8lOlUWKio.ygBtjPAXg3ikys04cQarXQ'
      }
    });
  }

  async handleStremioStreams(req, res, next) {
    if (this.isRogPlayLiveStreamRequest(req.params.type, req.params.id)) {
      try {
        const streams = await this.rogPlayAdapter.getLiveStreams(req.params.id, {
          baseUrl: getStremioRequestBaseUrl(req)
        });
        this.sendStremioStreamsResponse(res, streams);
      } catch (error) {
        logger.warn('rogplay live stream lookup failed', {
          id: req.params.id,
          error
        });
        this.sendStremioStreamsResponse(res, []);
      }
      return;
    }

    if (this.isGermanIptvLiveStreamRequest(req.params.type, req.params.id)) {
      try {
        const streams = await this.germanIptvLiveAdapter.getLiveStreams(req.params.id);
        this.sendStremioStreamsResponse(res, streams);
      } catch (error) {
        logger.warn('german iptv live stream lookup failed', {
          id: req.params.id,
          error
        });
        this.sendStremioStreamsResponse(res, []);
      }
      return;
    }

    const overallTimeoutMs = Math.max(
      config.STREMIO_STREAM_OVERALL_TIMEOUT_MS,
      config.STREMIO_FAST_MAX_WAIT_MS + 5_000
    );
    const requestAbortController = new AbortController();
    allowHighFanoutAbortSignal(requestAbortController.signal);
    const abortActiveSearch = (message) => {
      if (!requestAbortController.signal.aborted) {
        requestAbortController.abort(createHttpError(499, message));
      }
    };
    const onClientClose = () => {
      if (!res.writableEnded) {
        abortActiveSearch('Stremio client disconnected');
      }
    };
    req.on('aborted', onClientClose);
    res.on('close', onClientClose);
    let timeoutFallbackContext = null;
    const overallTimeout = setTimeout(() => {
      void (async () => {
        if (res.headersSent) {
          return;
        }

        abortActiveSearch('Stremio route overall timeout');

        logger.warn('stremio stream request overall timeout', {
          imdbId: req.params.id,
          mediaType: req.params.type
        });

        const cachedStreams = timeoutFallbackContext?.cachedResult?.state === 'stale'
          ? timeoutFallbackContext.cachedResult.streams
          : null;
        let fallbackStreams = Array.isArray(cachedStreams) && cachedStreams.length > 0
          ? cachedStreams
          : (Array.isArray(timeoutFallbackContext?.lastGoodStreams) && timeoutFallbackContext.lastGoodStreams.length > 0
              ? timeoutFallbackContext.lastGoodStreams
              : null);
        let fallbackSource = fallbackStreams === cachedStreams ? 'stale-timeout' : 'last-good-timeout';

        if (!fallbackStreams && timeoutFallbackContext?.resultCacheKey) {
          const fallbackCachedResult = await this.getCachedStremioStreams(timeoutFallbackContext.resultCacheKey, { allowStale: true });
          const fallbackLastGood = await this.getLastGoodStremioStreams(timeoutFallbackContext.resultCacheKey);

          if (fallbackCachedResult?.streams?.length) {
            fallbackStreams = fallbackCachedResult.streams;
            fallbackSource = `${fallbackCachedResult.state}-timeout`;
          } else if (fallbackLastGood?.length) {
            fallbackStreams = fallbackLastGood;
            fallbackSource = 'last-good-timeout';
          }
        }

        if (Array.isArray(fallbackStreams) && fallbackStreams.length > 0) {
          logger.warn('serving cached stremio streams after overall timeout', {
            imdbId: req.params.id,
            mediaType: req.params.type,
            cacheSource: fallbackSource,
            resultCount: fallbackStreams.length
          });
          res.setHeader('X-NebulaStreams-Cache', fallbackSource);
          this.sendStremioStreamsResponse(res, fallbackStreams);
          return;
        }

        this.sendStremioStreamsResponse(res, []);
      })().catch((error) => {
        logger.warn('stremio timeout fallback failed', { error });
        this.sendStremioStreamsResponse(res, []);
      });
    }, overallTimeoutMs);

    try {
      const parsed = this.parseStremioStreamRequest(req.params.type, req.params.id);
      let tmdbId = parsed.tmdbId;

      if (!tmdbId) {
        try {
          tmdbId = await this.imdbResolver.resolve({
            imdbId: parsed.imdbId,
            mediaType: parsed.mediaType
          });
        } catch (error) {
          logger.warn('stremio imdb resolution failed', {
            imdbId: parsed.imdbId,
            mediaType: parsed.mediaType,
            error
          });
          clearTimeout(overallTimeout);
          this.sendStremioStreamsResponse(res, []);
          return;
        }
      }

      if (!tmdbId) {
        clearTimeout(overallTimeout);
        this.sendStremioStreamsResponse(res, []);
        return;
      }

      const baseUrl = getStremioRequestBaseUrl(req);
      const requestedProviders = this.getRequestedProviders(req);
      const qualityPriority = this.getRequestedQualityPriority(req);
      const streamOptions = this.getRequestedStreamOptions(req);
      const privateProviderSettings = this.getRequestedPrivateProviderSettings(req);
      const privateProviderSettingsHash = getPrivateProviderSettingsHash(privateProviderSettings);
      const isConfiguredRequest = String(req.path || '').startsWith('/configured/')
        || String(req.path || '').startsWith('/private/');
      const bypassStremioResultCache = requestedProviders.length === 1 && requestedProviders[0] === 'allyoucanwatch';
      const resultCacheKey = this.buildStremioResultCacheKey({
        tmdbId,
        mediaType: parsed.mediaType,
        season: parsed.season,
        episode: parsed.episode,
        providers: requestedProviders,
        qualityPriority,
        streamOptions,
        privateProviderSettingsHash
      });
      this.userTracker?.trackStreamSearch(req, {
        imdbId: parsed.imdbId,
        tmdbId,
        mediaType: parsed.mediaType,
        season: parsed.season,
        episode: parsed.episode,
        providers: requestedProviders,
        qualityPriority,
        streamOptions
      });
      const cachedResult = bypassStremioResultCache
        ? null
        : await this.getCachedStremioStreams(resultCacheKey, { allowStale: true });
      const lastGoodStreams = bypassStremioResultCache
        ? null
        : await this.getLastGoodStremioStreams(resultCacheKey);
      timeoutFallbackContext = {
        resultCacheKey,
        cachedResult,
        lastGoodStreams
      };

      if (cachedResult?.state === 'fresh') {
        clearTimeout(overallTimeout);
        this.sendStremioStreamsResponse(res, cachedResult.streams);
        return;
      }

      if (bypassStremioResultCache) {
        const uncachedStreams = await this.buildStremioStreams({
          resultCacheKey,
          baseUrl,
          parsed,
          requestedProviders,
          qualityPriority,
          streamOptions,
          tmdbId,
          privateProviderSettings,
          signal: requestAbortController.signal,
          cacheResult: false
        });

        res.setHeader('X-NebulaStreams-Mode', 'uncached-explicit-provider');
        clearTimeout(overallTimeout);
        this.sendStremioStreamsResponse(res, uncachedStreams);
        return;
      }

      if (isConfiguredRequest && this.isLoadShedding()) {
        logger.warn('serving configured request through degraded uncached path during load shedding', {
          tmdbId,
          mediaType: parsed.mediaType,
          loadSheddingUntil: new Date(this.loadSheddingUntil).toISOString(),
          reason: this.loadSheddingReason
        });

        const degradedStreams = Array.isArray(lastGoodStreams) && lastGoodStreams.length > 0
          ? lastGoodStreams
          : (cachedResult?.streams || []);

        res.setHeader('X-NebulaStreams-Mode', degradedStreams.length > 0 ? 'configured-degraded-cache' : 'configured-degraded-empty');
        clearTimeout(overallTimeout);
        this.sendStremioStreamsResponse(res, degradedStreams);
        return;
      }

      const buildInput = {
        resultCacheKey,
        baseUrl,
        parsed,
        requestedProviders,
        qualityPriority,
        streamOptions,
        tmdbId,
        privateProviderSettings,
        signal: requestAbortController.signal
      };

      if (lastGoodStreams?.length && getLastGoodStreamSetScore(lastGoodStreams) > 0) {
        this.scheduleStremioBackgroundRefresh(buildInput);
        res.setHeader('X-NebulaStreams-Cache', 'last-good-refreshing');
        clearTimeout(overallTimeout);
        this.sendStremioStreamsResponse(res, lastGoodStreams);
        return;
      }

      if (cachedResult?.state === 'stale') {
        this.scheduleStremioBackgroundRefresh(buildInput);
        res.setHeader('X-NebulaStreams-Cache', 'stale');
        clearTimeout(overallTimeout);
        this.sendStremioStreamsResponse(res, cachedResult.streams);
        return;
      }

      let stremioStreams;

      try {
        const buildTimeoutSentinel = { timedOut: true };
        const buildPromise = this.getOrBuildStremioStreams(buildInput);
        stremioStreams = await withTimeoutFallback(
          buildPromise,
          Math.max(5_000, overallTimeoutMs - 500),
          buildTimeoutSentinel
        );

        if (stremioStreams === buildTimeoutSentinel) {
          const fallbackStreams = Array.isArray(lastGoodStreams) && lastGoodStreams.length > 0
            ? lastGoodStreams
            : (cachedResult?.streams?.length ? cachedResult.streams : []);

          if (fallbackStreams.length > 0) {
            logger.warn('serving stremio response before client timeout', {
              tmdbId,
              mediaType: parsed.mediaType,
              resultCount: fallbackStreams.length
            });

            res.setHeader('X-NebulaStreams-Cache', 'deadline-fallback');
            abortActiveSearch('Stremio deadline fallback served');
            clearTimeout(overallTimeout);
            this.sendStremioStreamsResponse(res, fallbackStreams);
            return;
          }

          logger.warn('stremio build crossed soft deadline; returning empty before client timeout', {
            tmdbId,
            mediaType: parsed.mediaType
          });
          abortActiveSearch('Stremio soft deadline reached');
          res.setHeader('X-NebulaStreams-Cache', 'deadline-empty');
          clearTimeout(overallTimeout);
          this.sendStremioStreamsResponse(res, []);
          return;
        }
      } catch (error) {
        if (lastGoodStreams?.length) {
          logger.warn('serving last-good stremio streams after rebuild failure', {
            tmdbId,
            mediaType: parsed.mediaType,
            resultCount: lastGoodStreams.length,
            error
          });
          await this.setCachedStremioStreams(resultCacheKey, lastGoodStreams, { weak: true });
          res.setHeader('X-NebulaStreams-Cache', 'last-good-error');
          clearTimeout(overallTimeout);
          this.sendStremioStreamsResponse(res, lastGoodStreams);
          return;
        }

        throw error;
      }

      if ((!Array.isArray(stremioStreams) || stremioStreams.length === 0) && lastGoodStreams?.length) {
        const freshScore = getLastGoodStreamSetScore(stremioStreams);
        const lastGoodScore = getLastGoodStreamSetScore(lastGoodStreams);

        if (lastGoodScore > freshScore) {
          logger.warn('serving last-good stremio streams after empty rebuild result', {
            tmdbId,
            mediaType: parsed.mediaType,
            resultCount: lastGoodStreams.length,
            lastGoodScore,
            freshScore
          });
          await this.setCachedStremioStreams(resultCacheKey, lastGoodStreams, { weak: true });
          res.setHeader('X-NebulaStreams-Cache', 'last-good-empty');
          clearTimeout(overallTimeout);
          this.sendStremioStreamsResponse(res, lastGoodStreams);
          return;
        }
      }

      clearTimeout(overallTimeout);
      this.sendStremioStreamsResponse(res, stremioStreams);
    } catch (error) {
      clearTimeout(overallTimeout);
      next(error);
    } finally {
      req.off('aborted', onClientClose);
      res.off('close', onClientClose);
    }
  }

  scheduleStremioBackgroundRefresh(input) {
    if (config.STREMIO_BACKGROUND_REFRESH_CONCURRENCY <= 0 || config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX <= 0) {
      return;
    }

    if (this.shouldSkipBackgroundRefresh()) {
      return;
    }

    if (this.stremioBackgroundRefreshes.has(input.resultCacheKey) || this.stremioResultInFlight.has(input.resultCacheKey)) {
      return;
    }

    const trackedCount = this.stremioBackgroundRefreshes.size;

    if (trackedCount >= config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX) {
      logger.warn('stremio background refresh skipped because queue is full', {
        queueSize: this.stremioBackgroundRefreshQueue.length,
        activeRefreshes: this.activeStremioBackgroundRefreshes,
        maxQueue: config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX,
        tmdbId: input.tmdbId,
        mediaType: input.parsed?.mediaType
      });
      return;
    }

    const { signal: _signal, ...backgroundInput } = input;
    this.stremioBackgroundRefreshes.add(input.resultCacheKey);
    this.stremioBackgroundRefreshQueue.push(backgroundInput);
    this.runStremioBackgroundRefreshQueue();
  }

  runStremioBackgroundRefreshQueue() {
    while (
      this.activeStremioBackgroundRefreshes < config.STREMIO_BACKGROUND_REFRESH_CONCURRENCY &&
      this.stremioBackgroundRefreshQueue.length > 0
    ) {
      const input = this.stremioBackgroundRefreshQueue.shift();
      this.activeStremioBackgroundRefreshes += 1;

      this.getOrBuildStremioStreams(input)
        .catch((error) => {
          logger.warn('stremio background refresh failed', {
            error,
            tmdbId: input.tmdbId,
            mediaType: input.parsed?.mediaType
          });
        })
        .finally(() => {
          this.activeStremioBackgroundRefreshes -= 1;
          this.stremioBackgroundRefreshes.delete(input.resultCacheKey);
          this.runStremioBackgroundRefreshQueue();
        });
    }
  }

  async getOrBuildStremioStreams({
    resultCacheKey,
    baseUrl,
    parsed,
    requestedProviders,
    qualityPriority,
    streamOptions,
    tmdbId,
    privateProviderSettings,
    signal = null
  }) {
    this.sweepStaleStremioInFlight();

    const existingRequest = this.stremioResultInFlight.get(resultCacheKey);

    if (existingRequest) {
      return existingRequest.then((streams) => copyObjects(streams));
    }

    if (this.isLoadShedding()) {
      logger.warn('stremio stream search rejected due to load shedding', {
        loadSheddingUntil: new Date(this.loadSheddingUntil).toISOString(),
        reason: this.loadSheddingReason,
        tmdbId,
        mediaType: parsed.mediaType
      });
      return [];
    }

    if (this.stremioResultInFlight.size >= config.STREMIO_MAX_INFLIGHT_SEARCHES) {
      const slotAvailable = await this.waitForStremioResultSlot({
        resultCacheKey,
        tmdbId,
        mediaType: parsed.mediaType
      });
      const inFlightRequest = this.stremioResultInFlight.get(resultCacheKey);

      if (inFlightRequest) {
        return inFlightRequest.then((streams) => copyObjects(streams));
      }

      if (!slotAvailable) {
        logger.warn('stremio stream search rejected due to in-flight limit', {
          inFlightSearches: this.stremioResultInFlight.size,
          maxInFlightSearches: config.STREMIO_MAX_INFLIGHT_SEARCHES,
          waitMs: config.STREMIO_INFLIGHT_SLOT_WAIT_MS,
          tmdbId,
          mediaType: parsed.mediaType
        });
        return [];
      }
    }

    if (this.stremioResultInFlight.size >= config.STREMIO_MAX_INFLIGHT_SEARCHES) {
      logger.warn('stremio stream search rejected due to in-flight limit', {
        inFlightSearches: this.stremioResultInFlight.size,
        maxInFlightSearches: config.STREMIO_MAX_INFLIGHT_SEARCHES,
        tmdbId,
        mediaType: parsed.mediaType
      });
      return [];
    }

    const requestAbortController = new AbortController();
    allowHighFanoutAbortSignal(requestAbortController.signal);
    let abortHandler = null;

    if (signal) {
      allowHighFanoutAbortSignal(signal);

      if (signal.aborted) {
        return [];
      }

      abortHandler = () => {
        requestAbortController.abort(signal.reason || createHttpError(499, 'Stremio search aborted'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const request = this.buildStremioStreams({
      resultCacheKey,
      baseUrl,
      parsed,
      requestedProviders,
      qualityPriority,
      streamOptions,
      tmdbId,
      privateProviderSettings,
      signal: requestAbortController.signal
    });
    request.startedAt = Date.now();
    request.controller = requestAbortController;

    this.stremioResultInFlight.set(resultCacheKey, request);

    try {
      const streams = await request;
      return copyObjects(streams);
    } finally {
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      this.stremioResultInFlight.delete(resultCacheKey);
    }
  }

  async buildStremioStreams({
    resultCacheKey,
    baseUrl,
    parsed,
    requestedProviders,
    qualityPriority,
    streamOptions,
    tmdbId,
    privateProviderSettings,
    signal = null,
    cacheResult = true
  }) {
    const result = await this.providerService.getFastStreams({
      providers: requestedProviders.length > 0 ? requestedProviders : null,
      tmdbId,
      imdbId: parsed.imdbId,
      mediaType: parsed.mediaType === 'series' ? 'tv' : 'movie',
      season: parsed.season,
      episode: parsed.episode,
      streamOptions,
      privateProviderSettings,
      signal
    });

    if (result.streams.length === 0) {
      if (cacheResult && result.partial) {
        const refreshInput = {
          resultCacheKey,
          baseUrl,
          parsed,
          requestedProviders,
          qualityPriority,
          streamOptions,
          tmdbId,
          privateProviderSettings
        };
        const refreshDelay = setTimeout(() => {
          this.scheduleStremioBackgroundRefresh(refreshInput);
        }, 8_000);
        refreshDelay.unref?.();

        if (parsed.mediaType === 'series') {
          const hubRefreshDelay = setTimeout(() => {
            this.scheduleStremioBackgroundRefresh(refreshInput);
          }, 24_000);
          hubRefreshDelay.unref?.();
          const slowHubRefreshDelay = setTimeout(() => {
            this.scheduleStremioBackgroundRefresh(refreshInput);
          }, 34_000);
          slowHubRefreshDelay.unref?.();
        }
      }

      if (cacheResult && shouldCacheEmptyFastResult(result)) {
        await this.setCachedStremioStreams(resultCacheKey, []);
      } else if (!cacheResult) {
        logger.info('skipping stremio cache write for degraded configured request', {
          tmdbId,
          mediaType: parsed.mediaType,
          reason: result.reason,
          providersTried: result.tried
        });
      } else {
        logger.info('skipping empty stremio cache write for partial fast search result', {
          tmdbId,
          mediaType: parsed.mediaType,
          reason: result.reason,
          providersTried: result.tried
        });
      }
      return [];
    }

    const hasShowboxRawStreams = result.streams.some((stream) =>
      String(stream?.provider || '').trim().toLowerCase() === 'showbox'
    );
    const rawStreamsForNormalization = hasShowboxRawStreams
      ? result.streams.filter((stream) => !isHubCloudUrl(String(stream?.url || '').trim()))
      : result.streams;
    let normalizedStreams = await this.normalizeProviderStreams(baseUrl, rawStreamsForNormalization);
    normalizedStreams = enableTorBoxDdlStreams(normalizedStreams, privateProviderSettings);
    let { streams: configuredStreams } = filterConfiguredStreamsDetailed(normalizedStreams, streamOptions);

    if (configuredStreams.length === 0 && normalizedStreams.length > 0) {
      const relaxed = relaxEmptyStreamFilters(normalizedStreams, streamOptions);
      if (relaxed.streams.length > 0) {
        logger.warn('relaxed stream filters after empty configured result', {
          tmdbId,
          mediaType: parsed.mediaType,
          originalStreamCount: normalizedStreams.length,
          relaxedStreamCount: relaxed.streams.length,
          streamOptions
        });
        configuredStreams = relaxed.streams;
      }
    }

    if (configuredStreams.length === 0) {
      logger.warn('stremio stream search produced no configured streams', {
        tmdbId,
        mediaType: parsed.mediaType,
        reason: result.reason,
        providersTried: result.tried,
        rawStreamCount: result.streams.length,
        normalizedStreamCount: normalizedStreams.length,
        streamOptions
      });
      if (cacheResult && shouldCacheEmptyFastResult(result)) {
        await this.setCachedStremioStreams(resultCacheKey, []);
      }
      return [];
    }

    configuredStreams.sort((left, right) =>
      (getQualityPriorityScore(right, qualityPriority) + getPreferredAudioLanguageScore(right, streamOptions) + getStreamPreferenceScore(right, streamOptions) + getProviderPriorityScore(right, result.providers) + getProviderPlaybackReliabilityScore(right) + getDeliveryPriorityScore(right) + toStremioCompatibilityScore(right)) -
      (getQualityPriorityScore(left, qualityPriority) + getPreferredAudioLanguageScore(left, streamOptions) + getStreamPreferenceScore(left, streamOptions) + getProviderPriorityScore(left, result.providers) + getProviderPlaybackReliabilityScore(left) + getDeliveryPriorityScore(left) + toStremioCompatibilityScore(left))
    );
    const postDedupeStreams = applyConfiguredDedupe(configuredStreams, streamOptions).streams;
    const dedupedStreams = diversifyStreamsByProvider(
      applyStreamResultLimits(postDedupeStreams, streamOptions),
      getStreamDiversityOptions(postDedupeStreams, {
        requestedProviders
      })
    );
    const playbackStreams = await Promise.all(dedupedStreams.map(async (stream) => {
      if (stream?.torboxWebDownload && privateProviderSettings?.torboxApiKey) {
        try {
          const streamUrl = this.createTorBoxWebDownloadStreamUrl(baseUrl, {
            source: stream.url,
            apiKey: privateProviderSettings.torboxApiKey,
            filename: stream.filename || stream.fileName || stream.title,
            provider: stream.provider
          });

          return {
            ...stream,
            url: streamUrl.toString(),
            headers: null,
            behaviorHints: {
              ...stream.behaviorHints,
              notWebReady: false
            }
          };
        } catch (error) {
          logger.warn('failed to create torbox webdl stream url', {
            provider: stream.provider,
            url: stream.url,
            error
          });
          return stream;
        }
      }

      if (!needsRegisteredPlaybackProxy(stream)) {
        return stream;
      }

      try {
        const streamUrl = await this.createRegisteredStreamUrl(baseUrl, {
          type: 'http',
          source: stream.url,
          headers: getProviderForwardHeaders(stream),
          metadata: {
            provider: stream.provider,
            title: stream.title,
            quality: stream.quality,
            filename: stream.filename || stream.fileName || stream.title,
            ...(stream.expiresAt ? { expiresAt: stream.expiresAt } : {})
          },
          deferValidation: true
        });

        return {
          ...stream,
          url: streamUrl.toString(),
          headers: null,
          behaviorHints: {
            ...stream.behaviorHints,
            notWebReady: false
          }
        };
      } catch (error) {
        logger.warn('failed to register playback proxy for stream', {
          provider: stream.provider,
          url: stream.url,
          error
        });
        return stream;
      }
    }));
    const useWeakCache = Boolean(result.partial) || shouldUseWeakResultCache(playbackStreams);
    const hasCinestream = playbackStreams.some((stream) =>
      String(stream?.provider || '').trim().toLowerCase() === 'cinestream'
    );
    const hasShowbox = playbackStreams.some((stream) =>
      String(stream?.provider || '').trim().toLowerCase() === 'showbox'
    );
    const stremioStreams = playbackStreams
      .map((stream) => toStremioStreamObject(stream, parsed, streamOptions))
      .filter(Boolean);

    if (cacheResult && !result.partial) {
      await this.setCachedStremioStreams(resultCacheKey, stremioStreams, { weak: useWeakCache, hasCinestream, hasShowbox });
    } else if (cacheResult && result.partial && stremioStreams.length > 0) {
      await this.setCachedStremioStreams(resultCacheKey, stremioStreams, { weak: true, hasCinestream, hasShowbox });

      const refreshInput = {
        resultCacheKey,
        baseUrl,
        parsed,
        requestedProviders,
        qualityPriority,
        streamOptions,
        tmdbId,
        privateProviderSettings
      };

      const refreshDelay = setTimeout(() => {
        this.scheduleStremioBackgroundRefresh(refreshInput);
      }, 8_000);
      refreshDelay.unref?.();

      if (parsed.mediaType === 'series') {
        const hubRefreshDelay = setTimeout(() => {
          this.scheduleStremioBackgroundRefresh(refreshInput);
        }, 24_000);
        hubRefreshDelay.unref?.();
        const slowHubRefreshDelay = setTimeout(() => {
          this.scheduleStremioBackgroundRefresh(refreshInput);
        }, 34_000);
        slowHubRefreshDelay.unref?.();
      }
    }

    return stremioStreams;
  }

  async handleTorrentStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        source: req.query.magnet,
        fileIndex: req.query.fileIndex,
        fileName: req.query.fileName,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleHttpStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        source: req.query.url,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleAddSource(req, res, next) {
    try {
      const streamUrl = await this.createRegisteredStreamUrl(`${req.protocol}://${req.get('host')}`, {
        type: req.body?.type,
        source: req.body?.source,
        headers: req.body?.headers,
        metadata: req.body?.metadata
      });

      res.json({
        streamUrl: streamUrl.toString(),
        sourceId: streamUrl.searchParams.get('sourceId')
      });
    } catch (error) {
      logger.error('add-source failed', {
        error
      });
      next(error);
    }
  }

  createTorBoxWebDownloadStreamUrl(baseUrl, {
    source,
    apiKey,
    filename = null,
    provider = null
  } = {}) {
    const normalizedSource = this.normalizeHttpSource(source);
    const normalizedApiKey = normalizePrivateCookie(apiKey);

    if (!normalizedApiKey) {
      throw createHttpError(400, 'TorBox API key is required');
    }

    const token = encryptSourceTokenPayload(JSON.stringify({
      version: SOURCE_TOKEN_VERSION,
      expiresAt: Date.now() + (90 * 60 * 1000),
      source: normalizedSource,
      apiKey: normalizedApiKey,
      filename: filename ? String(filename).slice(0, 180) : null,
      provider: provider ? String(provider).slice(0, 80) : null
    }));
    const streamUrl = new URL('/torbox/webdl', baseUrl);
    streamUrl.searchParams.set('token', token);
    if (filename) {
      streamUrl.searchParams.set('filename', String(filename).slice(0, 180));
    }
    return streamUrl;
  }

  decodeTorBoxWebDownloadToken(token) {
    let parsed;

    try {
      parsed = JSON.parse(decryptSourceTokenPayload(token));
    } catch {
      throw createHttpError(400, 'Invalid TorBox token');
    }

    if (!parsed || parsed.version !== SOURCE_TOKEN_VERSION) {
      throw createHttpError(400, 'Unsupported TorBox token');
    }

    if (!Number.isFinite(Number(parsed.expiresAt)) || Number(parsed.expiresAt) <= Date.now()) {
      throw createHttpError(404, 'TorBox token has expired');
    }

    return {
      source: this.normalizeHttpSource(parsed.source),
      apiKey: normalizePrivateCookie(parsed.apiKey),
      filename: parsed.filename ? String(parsed.filename).slice(0, 180) : null
    };
  }

  async handleTorBoxWebDownload(req, res, next) {
    try {
      const payload = this.decodeTorBoxWebDownloadToken(req.query.token);
      const form = new FormData();
      form.set('link', payload.source);
      form.set('as_queued', 'true');
      if (payload.filename) {
        form.set('name', payload.filename);
      }

      const createResponse = await fetch('https://api.torbox.app/v1/api/webdl/createwebdownload', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${payload.apiKey}`,
          accept: 'application/json'
        },
        body: form
      });
      const createPayload = await createResponse.json().catch(() => ({}));

      if (!createResponse.ok && createResponse.status !== 409) {
        throw createHttpError(createResponse.status || 502, createPayload?.detail || 'TorBox web download failed');
      }

      const webId = extractTorBoxWebDownloadId(createPayload);
      if (!webId) {
        throw createHttpError(502, createPayload?.detail || 'TorBox did not return a web download id');
      }

      let fileId = null;
      try {
        const listUrl = new URL('https://api.torbox.app/v1/api/webdl/mylist');
        listUrl.searchParams.set('id', String(webId));
        listUrl.searchParams.set('bypass_cache', 'true');
        const listResponse = await fetch(listUrl, {
          headers: {
            authorization: `Bearer ${payload.apiKey}`,
            accept: 'application/json'
          }
        });
        const listPayload = await listResponse.json().catch(() => ({}));
        fileId = findTorBoxVideoFileId(listPayload);
      } catch (error) {
        logger.info('torbox webdl file lookup failed', {
          webId,
          error: error?.message || String(error)
        });
      }

      const requestUrl = new URL('https://api.torbox.app/v1/api/webdl/requestdl');
      requestUrl.searchParams.set('token', payload.apiKey);
      requestUrl.searchParams.set('web_id', String(webId));
      if (fileId !== null) requestUrl.searchParams.set('file_id', String(fileId));
      else requestUrl.searchParams.set('zip_link', 'true');
      requestUrl.searchParams.set('redirect', 'true');
      requestUrl.searchParams.set('append_name', 'true');

      res.redirect(302, requestUrl.toString());
    } catch (error) {
      next(error);
    }
  }

  async handleCreatePrivateConfig(req, res, next) {
    try {
      const { configId, manifestPath } = await this.createPrivateConfig({
        providers: req.body?.providers,
        qualityPriority: req.body?.qualityPriority,
        streamOptions: req.body?.streamOptions,
        privateProviderSettings: req.body?.privateProviderSettings,
        profileCode: req.body?.profileCode
      });
      const installUrls = getManifestInstallUrls(req, manifestPath);

      res.json({
        configId,
        manifestPath,
        ...installUrls
      });
    } catch (error) {
      next(error);
    }
  }

  async handleProviderStreams(req, res, next) {
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const provider = req.params.provider;
      const streams = await this.providerService.getStreams({
        provider,
        tmdbId: req.query.tmdbId,
        imdbId: req.query.imdbId,
        mediaType: req.query.mediaType,
        season: req.query.season,
        episode: req.query.episode,
        priorityRequest: true,
        enforceFastTimeout: true
      });

      if (streams.length === 0) {
        res.json({
          provider,
          count: 0,
          streams: []
        });
        return;
      }

      const normalizedStreams = await withTimeoutFallback(
        this.normalizeProviderStreams(baseUrl, streams, provider),
        8_000,
        streams
      );

      res.json({
        provider,
        count: normalizedStreams.length,
        streams: normalizedStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleAggregateProviderStreams(req, res, next) {
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const requestedProviders = typeof req.query.providers === 'string'
        ? req.query.providers.split(',').map((value) => value.trim()).filter(Boolean)
        : undefined;
      const result = await this.providerService.getAggregateStreams({
        providers: requestedProviders,
        tmdbId: req.query.tmdbId,
        mediaType: req.query.mediaType,
        season: req.query.season,
        episode: req.query.episode
      });

      if (result.streams.length === 0) {
        res.json({
          provider: null,
          count: 0,
          tried: result.tried,
          streams: []
        });
        return;
      }

      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);

      res.json({
        provider: null,
        count: normalizedStreams.length,
        tried: result.tried,
        streams: normalizedStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleRogPlayLivePlaylist(req, res, next) {
    try {
      const playlist = await this.rogPlayAdapter.getLivePlaylist({
        id: req.params.id,
        target: req.query.target,
        baseUrl: getStremioRequestBaseUrl(req),
        signal: req.signal
      });

      if (!playlist) {
        res.status(404).type('text/plain').send('Live playlist not found');
        return;
      }

      res
        .status(200)
        .setHeader('Cache-Control', 'no-store')
        .type('application/vnd.apple.mpegurl')
        .send(playlist);
    } catch (error) {
      next(error);
    }
  }

  async handleStremioCatalog(req, res, next) {
    try {
      const type = String(req.params.type || '').trim().toLowerCase();
      const catalogId = String(req.params.id || '').trim();

      if (type !== 'tv' || (!catalogId.startsWith('rogplay-live-') && !catalogId.startsWith('cs-german-live-'))) {
        res.json({ metas: [] });
        return;
      }

      const isGermanCatalog = catalogId.startsWith('cs-german-live-');
      const liveAdapter = isGermanCatalog ? this.germanIptvLiveAdapter : this.rogPlayAdapter;
      const catalog = liveAdapter.getLiveCatalogDefinitions()
        .find((definition) => definition.id === catalogId);

      if (!catalog) {
        res.json({ metas: [] });
        return;
      }

      const skip = Number.parseInt(req.query.skip || '0', 10);
      let metas = await liveAdapter.getLiveCatalog({
        category: catalog.category,
        source: catalog.source || null,
        skip: Number.isInteger(skip) && skip > 0 ? skip : 0
      });

      const search = String(req.query.search || '').trim().toLowerCase();
      if (search) {
        metas = metas.filter((meta) => String(meta.name || '').toLowerCase().includes(search));
      }

      res.json({ metas });
    } catch (error) {
      next(error);
    }
  }

  async handleStremioMeta(req, res, next) {
    try {
      const type = String(req.params.type || '').trim().toLowerCase();
      const id = String(req.params.id || '').trim();

      if (type !== 'tv' || (!id.startsWith('rogplay:') && !id.startsWith('cs-german:'))) {
        res.json({ meta: null });
        return;
      }

      const meta = id.startsWith('cs-german:')
        ? await this.germanIptvLiveAdapter.getLiveMeta(id)
        : await this.rogPlayAdapter.getLiveMeta(id);
      res.json({ meta });
    } catch (error) {
      next(error);
    }
  }

  isRogPlayLiveStreamRequest(type, id) {
    const normalizedType = String(type || '').trim().toLowerCase();
    return (normalizedType === 'tv' || normalizedType === 'live' || normalizedType === 'channel')
      && String(id || '').startsWith('rogplay:');
  }

  isGermanIptvLiveStreamRequest(type, id) {
    const normalizedType = String(type || '').trim().toLowerCase();
    return (normalizedType === 'tv' || normalizedType === 'live' || normalizedType === 'channel')
      && String(id || '').startsWith('cs-german:');
  }

  async handleUnifiedStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        sourceId: req.query.sourceId,
        sourceToken: req.query.sourceToken,
        type: req.query.type,
        source: req.query.source,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleStremioPreview(req, res, next) {
    try {
      const parsed = this.parseStremioStreamRequest(req.params.type, req.params.id);
      let tmdbId;

      try {
        tmdbId = await this.imdbResolver.resolve({
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType
        });
      } catch (error) {
        logger.warn('stremio preview imdb resolution failed', {
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType,
          error
        });
        res.json({
          resolved: false,
          reason: 'imdb-resolution-failed'
        });
        return;
      }

      if (!tmdbId) {
        res.json({
          resolved: false,
          reason: 'tmdb-not-found'
        });
        return;
      }

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const requestedProviders = this.getRequestedProviders(req);
      const qualityPriority = this.getRequestedQualityPriority(req);
      const streamOptions = this.getRequestedStreamOptions(req);
      const privateProviderSettings = this.getRequestedPrivateProviderSettings(req);
      const result = await this.providerService.getFastStreams({
        providers: requestedProviders.length > 0 ? requestedProviders : null,
        tmdbId,
        imdbId: parsed.imdbId,
        mediaType: parsed.mediaType === 'series' ? 'tv' : 'movie',
        season: parsed.season,
        episode: parsed.episode,
        streamOptions,
        privateProviderSettings
      });
      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);
      let { streams: configuredStreams, diagnostics } = filterConfiguredStreamsDetailed(normalizedStreams, streamOptions);

      if (configuredStreams.length === 0 && normalizedStreams.length > 0) {
        const relaxed = relaxEmptyStreamFilters(normalizedStreams, streamOptions);
        if (relaxed.streams.length > 0) {
          configuredStreams = relaxed.streams;
          diagnostics = {
            ...diagnostics,
            relaxedAfterEmpty: true,
            relaxedKeptTotal: relaxed.streams.length,
            relaxedDiagnostics: relaxed.diagnostics
          };
        }
      }

      configuredStreams.sort((left, right) =>
        (getQualityPriorityScore(right, qualityPriority) + getPreferredAudioLanguageScore(right, streamOptions) + getStreamPreferenceScore(right, streamOptions) + getProviderPriorityScore(right, result.providers) + getProviderPlaybackReliabilityScore(right) + getDeliveryPriorityScore(right) + toStremioCompatibilityScore(right)) -
        (getQualityPriorityScore(left, qualityPriority) + getPreferredAudioLanguageScore(left, streamOptions) + getStreamPreferenceScore(left, streamOptions) + getProviderPriorityScore(left, result.providers) + getProviderPlaybackReliabilityScore(left) + getDeliveryPriorityScore(left) + toStremioCompatibilityScore(left))
      );
      const dedupeResult = applyConfiguredDedupe(configuredStreams, streamOptions);
      diagnostics.dedupedTotal = dedupeResult.removedCount;
      diagnostics.reasons.duplicate = dedupeResult.removedCount;
      diagnostics.examples.duplicate = dedupeResult.examples;
      const limitedStreams = applyStreamResultLimits(dedupeResult.streams, streamOptions);

      res.json({
        resolved: true,
        tmdbId,
        providersTried: result.tried,
        providerOrder: result.providers,
        diagnostics,
        sample: limitedStreams.slice(0, 6).map((stream) => ({
          name: stream.name,
          quality: stream.quality,
          host: getStreamHostname(stream),
          size: stream.size || null,
          url: stream.url || null
        }))
      });
    } catch (error) {
      next(error);
    }
  }

  async handleCacheStats(_req, res, next) {
    try {
      const stats = await this.cacheManager.getCacheStats(this.torrentEngine.getActiveCachePaths());
      res.json(stats);
    } catch (error) {
      next(error);
    }
  }

  async handleTorrentFileStream(req, res, next) {
    try {
      const descriptor = await this.torrentEngine.getStreamDescriptorByInfoHash({
        infoHash: req.params.infoHash,
        fileName: req.params.filename,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleStreamRequest(input = {}) {
    if (typeof input.sourceId === 'string' && input.sourceId.trim()) {
      const resolved = this.sourceRegistry.get(input.sourceId.trim());

      if (!resolved && !input.sourceToken) {
        throw createHttpError(404, 'Source id was not found or has expired');
      }

      if (resolved) {
        return this.handleStreamRequest({
          ...input,
          type: resolved.type,
          source: resolved.source,
          headers: resolved.headers,
          metadata: resolved.metadata,
          fallback: resolved.fallback,
          sourceId: null,
          sourceToken: null
        });
      }
    }

    if (typeof input.sourceToken === 'string' && input.sourceToken.trim()) {
      const resolved = this.decodeSourceToken(input.sourceToken.trim());

      return this.handleStreamRequest({
        ...input,
        type: resolved.type,
        source: resolved.source,
        headers: resolved.headers,
        metadata: resolved.metadata,
        fallback: resolved.fallback,
        sourceId: null,
        sourceToken: null
      });
    }

    const preparedSource = await this.prepareSource(input);
    const sourceType = preparedSource.type;
    const source = preparedSource.source;
    const fallback = preparedSource.fallback;

    if (sourceType === 'torrent') {
      return this.torrentEngine.getStreamDescriptor({
        magnet: source,
        fileIndex: input.fileIndex,
        fileName: input.fileName,
        rangeHeader: input.rangeHeader
      });
    }

    const cachedEntry = await this.cacheManager.getHttpCacheEntry(source);

    if (cachedEntry) {
      await this.cacheManager.touchPath(cachedEntry.dataPath);
      return this.httpProxy.createCachedDescriptor(cachedEntry, input.rangeHeader);
    }

    try {
      return await this.httpProxy.getUpstreamStreamDescriptor({
        targetUrl: source,
        rangeHeader: input.rangeHeader,
        requestHeaders: preparedSource.headers
      });
    } catch (error) {
      if (fallback?.type === 'torrent') {
        logger.warn('http source failed, falling back to torrent', {
          source,
          fallbackSource: fallback.source,
          error
        });

        return this.torrentEngine.getStreamDescriptor({
          magnet: fallback.source,
          fileIndex: input.fileIndex,
          fileName: input.fileName,
          rangeHeader: input.rangeHeader
        });
      }

      throw error;
    }
  }

  async prepareSource(input = {}) {
    const rawSource = input.source ?? input.url ?? input.magnet;
    const requestedType = normalizeRequestedType(input.type);
    const detectedType = detectSourceType(rawSource);
    const normalizedDetectedType = detectedType === 'magnet' ? 'torrent' : detectedType;

    if (!detectedType || !normalizedDetectedType) {
      throw createHttpError(400, 'A valid HTTP URL or magnet link is required');
    }

    if (requestedType && requestedType !== normalizedDetectedType) {
      throw createHttpError(400, `Query parameter type=${requestedType} does not match the provided source`);
    }

    if (normalizedDetectedType === 'http') {
      const normalizedUrl = input.deferValidation
        ? this.normalizeHttpSource(rawSource)
        : await this.httpProxy.validateTargetUrl(rawSource);

      return {
        type: 'http',
        source: normalizedUrl,
        streamSource: normalizedUrl,
        headers: input.headers && typeof input.headers === 'object' ? { ...input.headers } : null,
        metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : null,
        fallback: await this.prepareFallback(input.fallback),
        cached: await this.cacheManager.isCached(this.cacheManager.getHttpCacheKey(normalizedUrl))
      };
    }

    let magnet;

    try {
      magnet = enhanceMagnet(rawSource);
    } catch (error) {
      throw createHttpError(400, error.message);
    }

    const infoHash = extractInfoHash(magnet);

    if (!infoHash) {
      throw createHttpError(400, 'Invalid magnet URI');
    }

    const cached = await this.cacheManager.isCached(infoHash);

    return {
      type: 'torrent',
      source: magnet,
      streamSource: String(rawSource).trim(),
      headers: null,
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : null,
      fallback: null,
      cached
    };
  }

  createSourceToken(preparedSource) {
    return encryptSourceTokenPayload(JSON.stringify({
      version: SOURCE_TOKEN_VERSION,
      expiresAt: Date.now() + getSourceTokenTtlMs(preparedSource),
      type: preparedSource.type,
      source: preparedSource.source,
      headers: preparedSource.headers,
      metadata: preparedSource.metadata,
      fallback: preparedSource.fallback
    }));
  }

  decodeSourceToken(token) {
    let parsed;

    try {
      parsed = JSON.parse(decryptSourceTokenPayload(token));
    } catch {
      throw createHttpError(400, 'Invalid source token payload');
    }

    if (!parsed || parsed.version !== SOURCE_TOKEN_VERSION) {
      throw createHttpError(400, 'Unsupported source token');
    }

    if (!Number.isFinite(Number(parsed.expiresAt)) || Number(parsed.expiresAt) <= Date.now()) {
      throw createHttpError(404, 'Source token has expired');
    }

    return {
      type: parsed.type,
      source: parsed.source,
      headers: parsed.headers && typeof parsed.headers === 'object' ? { ...parsed.headers } : null,
      metadata: parsed.metadata && typeof parsed.metadata === 'object' ? { ...parsed.metadata } : null,
      fallback: parsed.fallback && typeof parsed.fallback === 'object'
        ? {
            type: parsed.fallback.type,
            source: parsed.fallback.source,
            headers: parsed.fallback.headers && typeof parsed.fallback.headers === 'object' ? { ...parsed.fallback.headers } : null,
            metadata: parsed.fallback.metadata && typeof parsed.fallback.metadata === 'object' ? { ...parsed.fallback.metadata } : null
          }
        : null
    };
  }

  async createRegisteredStreamUrl(baseUrl, input = {}) {
    const preparedSource = await this.prepareSource(input);
    const sourceId = this.sourceRegistry.register({
      type: preparedSource.type,
      source: preparedSource.source,
      headers: preparedSource.headers,
      metadata: preparedSource.metadata,
      fallback: preparedSource.fallback
    });
    const streamUrl = new URL('/stream', baseUrl);
    streamUrl.searchParams.set('sourceId', sourceId);
    streamUrl.searchParams.set('sourceToken', this.createSourceToken(preparedSource));
    if (preparedSource.metadata?.filename) {
      streamUrl.searchParams.set('filename', String(preparedSource.metadata.filename).slice(0, 180));
    }
    return streamUrl;
  }

  async resolveHubCloudUrls(streamUrl, inheritedHeaders = null) {
    const normalizedUrl = String(streamUrl || '').trim();

    if (!isHubCloudUrl(normalizedUrl)) {
      return [];
    }

    const cached = this.hubCloudCache.get(normalizedUrl);

    if (cached && cached.expiresAt > Date.now()) {
      touchMapEntry(this.hubCloudCache, normalizedUrl, cached);
      return Array.isArray(cached.value) ? cached.value.map((entry) => ({ ...entry })) : [];
    }

    if (this.hubCloudInFlight.has(normalizedUrl)) {
      return this.hubCloudInFlight.get(normalizedUrl);
    }

    const request = (async () => {
      try {
        if (isHubDriveUrl(normalizedUrl)) {
          const directEntry = await resolveHubDriveDirectDownload(normalizedUrl);
          if (directEntry?.url) {
            touchMapEntry(this.hubCloudCache, normalizedUrl, {
              expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS,
              value: [directEntry],
              approxBytes: getSerializedApproxBytes(JSON.stringify([directEntry]))
            });
            pruneMapByMaxEntries(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES);
            pruneMapByApproxBytes(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024);
            return [{ ...directEntry }];
          }
        }

        const initialHeaders = {
          'User-Agent': HUBCLOUD_USER_AGENT,
          ...(inheritedHeaders && typeof inheritedHeaders === 'object' ? inheritedHeaders : {}),
          Referer: normalizedUrl
        };
        const initialHtml = await fetchTextWithTimeout(normalizedUrl, { headers: initialHeaders }, HUBCLOUD_FETCH_TIMEOUT_MS);
        const redirectHref = extractHubCloudRedirectHref(initialHtml);
        let redirectUrl = redirectHref ? new URL(redirectHref, normalizedUrl).toString() : normalizedUrl;
        let linksHtml = initialHtml;

        if (redirectHref) {
          linksHtml = await fetchTextWithTimeout(redirectUrl, {
            headers: {
              'User-Agent': HUBCLOUD_USER_AGENT,
              Referer: normalizedUrl
            }
          }, HUBCLOUD_FETCH_TIMEOUT_MS);
        } else if (!hasValidHubCloudDownloadContent(initialHtml)) {
          touchMapEntry(this.hubCloudCache, normalizedUrl, {
            expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS,
            value: [],
            approxBytes: 2
          });
          pruneMapByMaxEntries(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES);
          pruneMapByApproxBytes(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024);
          return [];
        }

        if (!hasValidHubCloudDownloadContent(linksHtml)) {
          await delay(500);
          const retryInitialHtml = await fetchTextWithTimeout(normalizedUrl, { headers: initialHeaders }, HUBCLOUD_FETCH_TIMEOUT_MS);
          const retryRedirectHref = extractHubCloudRedirectHref(retryInitialHtml);

          if (retryRedirectHref) {
            redirectUrl = new URL(retryRedirectHref, normalizedUrl).toString();
            linksHtml = await fetchTextWithTimeout(redirectUrl, {
              headers: {
                'User-Agent': HUBCLOUD_USER_AGENT,
                Referer: normalizedUrl
              }
            }, HUBCLOUD_FETCH_TIMEOUT_MS);
          }
        }
        const title = parseHubCloudTitle(linksHtml);
        const size = parseHubCloudSize(linksHtml);
        const candidates = extractHubCloudAnchorCandidates(linksHtml)
          .map((candidate) => ({
            ...candidate,
            score: getHubCloudCandidateScore(candidate),
            server: classifyHubCloudCandidate(candidate)
          }))
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score);

        if (candidates.length === 0) {
          touchMapEntry(this.hubCloudCache, normalizedUrl, {
            expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS,
            value: [],
            approxBytes: 2
          });
          pruneMapByMaxEntries(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES);
          pruneMapByApproxBytes(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024);
          return [];
        }

        const deduped = [];
        const seenKeys = new Set();

        for (const candidate of candidates) {
          let resolvedHref = candidate.href;
          let resolvedHeaders = null;

          if (candidate.server === 'PixelServer') {
            try {
              const pixelUrl = new URL(candidate.href);
              const pixelPath = pixelUrl.pathname.replace(/\/api\/file\//i, '/u/');
              const refererUrl = new URL(pixelPath, pixelUrl.origin).toString();
              const downloadUrl = new URL(candidate.href);
              if (!/\/api\/file\//i.test(downloadUrl.pathname)) {
                downloadUrl.pathname = downloadUrl.pathname.replace(/\/u\//i, '/api/file/');
              }
              if (!downloadUrl.searchParams.has('download')) {
                downloadUrl.searchParams.set('download', '');
              }
              resolvedHref = downloadUrl.toString();
              resolvedHeaders = {
                Referer: refererUrl,
                'User-Agent': HUBCLOUD_USER_AGENT
              };
            } catch {
              resolvedHeaders = {
                Referer: redirectUrl,
                'User-Agent': HUBCLOUD_USER_AGENT
              };
            }
          } else if (candidate.href.toLowerCase().includes('hubcdn')) {
            resolvedHeaders = {
              Referer: redirectUrl,
              'User-Agent': HUBCLOUD_USER_AGENT
            };
          }

          const dedupeKey = `${candidate.server}:${resolvedHref}`;
          if (seenKeys.has(dedupeKey)) {
            continue;
          }
          seenKeys.add(dedupeKey);

          deduped.push({
            url: resolvedHref,
            headers: resolvedHeaders,
            sourceSite: `HubCloud (${candidate.server})`,
            title,
            size
          });
        }

        touchMapEntry(this.hubCloudCache, normalizedUrl, {
          expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS,
          value: deduped,
          approxBytes: getSerializedApproxBytes(JSON.stringify(deduped))
        });
        pruneMapByMaxEntries(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES);
        pruneMapByApproxBytes(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024);

        return deduped.map((entry) => ({ ...entry }));
      } catch (error) {
        let streamHost = 'unknown';
        try {
          streamHost = new URL(normalizedUrl).hostname;
        } catch {
          streamHost = 'invalid-url';
        }
        logger.warn('hubcloud resolution failed', {
          streamHost,
          errorName: error?.name || 'Error',
          errorMessage: error?.message || String(error),
          statusCode: error?.statusCode || null
        });
        touchMapEntry(this.hubCloudCache, normalizedUrl, {
          expiresAt: Date.now() + (10 * 60 * 1000),
          value: [],
          approxBytes: 2
        });
        pruneMapByMaxEntries(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES);
        pruneMapByApproxBytes(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024);
        return [];
      }
    })();

    this.hubCloudInFlight.set(normalizedUrl, request);

    try {
      return await request;
    } finally {
      this.hubCloudInFlight.delete(normalizedUrl);
    }
  }

  async normalizeProviderStreams(_baseUrl, streams, fallbackProvider = null) {
    let hubCloudResolutionBudget = 8;
    const settled = await Promise.all(streams.flatMap((stream) => {
      const provider = stream.provider || fallbackProvider;
      const variants = [];
      const normalizedUrl = typeof stream.url === 'string' ? stream.url.trim() : '';
      const normalizedMagnet = typeof stream.magnet === 'string'
        ? stream.magnet.trim()
        : typeof stream.torrent === 'string'
          ? stream.torrent.trim()
          : '';

      if (normalizedUrl) {
        const headers = getProviderForwardHeaders(stream);

        variants.push({
          transport: 'http',
          source: normalizedUrl,
          headers
        });
      }

      if (normalizedMagnet) {
        variants.push({
          transport: 'torrent',
          source: normalizedMagnet,
          headers: null
        });
      }

      return variants.map(async (variant) => {
        try {
          const {
            url: _url,
            magnet: _magnet,
            torrent: _torrent,
            ...rest
          } = stream;
          const normalizedEntries = [];

          const shouldResolveHubCloud = variant.transport === 'http'
            && isHubCloudUrl(normalizedUrl)
            && hubCloudResolutionBudget-- > 0;

          if (variant.transport === 'http' && isHubCloudUrl(normalizedUrl) && !shouldResolveHubCloud) {
            return [];
          }

          if (shouldResolveHubCloud) {
            const resolvedHubCloudEntries = await withTimeoutFallback(
              this.resolveHubCloudUrls(normalizedUrl, variant.headers),
              HUBCLOUD_FETCH_TIMEOUT_MS + 1000,
              []
            );

            if (resolvedHubCloudEntries.length > 0) {
              for (const resolvedEntry of resolvedHubCloudEntries) {
                const resolvedSourceSite = provider === 'r2-plugin'
                  ? (rest.sourceSite || 'from adapter')
                  : resolvedEntry.sourceSite;
                normalizedEntries.push({
                  ...rest,
                  provider,
                  ...(resolvedSourceSite ? { sourceSite: resolvedSourceSite } : {}),
                  ...(resolvedEntry.title || rest.title ? { title: resolvedEntry.title || rest.title } : {}),
                  ...(resolvedEntry.size || rest.size ? { size: resolvedEntry.size || rest.size } : {}),
                  ...(resolvedEntry.expiresAt ? { expiresAt: resolvedEntry.expiresAt } : {}),
                  headers: resolvedEntry.headers,
                  transport: 'http',
                  url: resolvedEntry.url,
                  filename: rest.filename || extractFilenameFromUrl(resolvedEntry.url)
                });
              }

              return normalizedEntries;
            }

            const providerId = String(provider || '').trim().toLowerCase();
            const sourceProviderText = String(rest.sourceProvider || rest.pluginProvider || '').trim().toLowerCase();
            const shouldKeepUnresolvedHubCloud =
              providerId === '4khdhub'
              || providerId === '4khdhub_tv'
              || providerId === 'scrapling-4khdhub'
              || (providerId === 'r2-plugin' && sourceProviderText.includes('4khdhub'));

            if (shouldKeepUnresolvedHubCloud) {
              return [{
                ...rest,
                provider,
                headers: variant.headers,
                transport: 'http',
                url: normalizedUrl,
                filename: rest.filename || extractFilenameFromUrl(normalizedUrl),
                behaviorHints: {
                  ...(rest.behaviorHints || {}),
                  notWebReady: true
                }
              }];
            }

            return [];
          }

          return [{
            ...rest,
            provider,
            headers: variant.headers,
            transport: variant.transport,
            ...(variant.transport === 'http'
              ? {
                  url: normalizedUrl,
                  filename: rest.filename || extractFilenameFromUrl(normalizedUrl)
                }
              : {
                  magnet: normalizedMagnet,
                  infoHash: extractInfoHash(normalizedMagnet) || null,
                  sources: getTorrentSources(normalizedMagnet)
                })
          }];
        } catch (error) {
          logger.warn('provider stream skipped', {
            provider,
            source: variant.source,
            transport: variant.transport,
            error
          });
          return null;
        }
      });
    }));

    return settled.flat().filter(Boolean);
  }

  parseStremioStreamRequest(type, id) {
    const normalizedType = String(type || '').trim().toLowerCase();
    const normalizedId = String(id || '').trim();

    if (normalizedType !== 'movie' && normalizedType !== 'series') {
      throw createHttpError(400, 'Unsupported Stremio stream type');
    }

    const parseIdParts = () => {
      if (normalizedId.startsWith('tmdb:')) {
        const [, rawTmdbId, rawSeason, rawEpisode] = normalizedId.split(':');
        const tmdbId = Number.parseInt(rawTmdbId, 10);

        if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
          throw createHttpError(400, 'TMDB stream id must be in tmdb:id or tmdb:id:season:episode format');
        }

        return {
          imdbId: null,
          tmdbId,
          rawSeason,
          rawEpisode
        };
      }

      const [imdbId, rawSeason, rawEpisode] = normalizedId.split(':');

      if (!/^tt\d+$/u.test(imdbId || '')) {
        throw createHttpError(400, 'Stremio stream id must use an IMDb tt prefix or tmdb: prefix');
      }

      return {
        imdbId,
        tmdbId: null,
        rawSeason,
        rawEpisode
      };
    };

    const parsedId = parseIdParts();

    if (normalizedType === 'movie') {
      return {
        mediaType: 'movie',
        imdbId: parsedId.imdbId,
        tmdbId: parsedId.tmdbId,
        season: null,
        episode: null
      };
    }

    const season = Number.parseInt(parsedId.rawSeason, 10);
    const episode = Number.parseInt(parsedId.rawEpisode, 10);

    if (!Number.isInteger(season) || !Number.isInteger(episode)) {
      throw createHttpError(400, 'Series stream id must be in imdb:season:episode or tmdb:id:season:episode format');
    }

    return {
      mediaType: 'series',
      imdbId: parsedId.imdbId || `tmdb:${parsedId.tmdbId}`,
      tmdbId: parsedId.tmdbId,
      season,
      episode
    };
  }

  async prepareFallback(fallbackInput) {
    if (!fallbackInput || typeof fallbackInput !== 'object') {
      return null;
    }

    const fallbackType = normalizeRequestedType(fallbackInput.type);

    if (fallbackType !== 'torrent' || typeof fallbackInput.source !== 'string') {
      return null;
    }

    let magnet;

    try {
      magnet = enhanceMagnet(fallbackInput.source);
    } catch {
      return null;
    }

    const infoHash = extractInfoHash(magnet);

    if (!infoHash) {
      return null;
    }

    return {
      type: 'torrent',
      source: magnet,
      headers: null,
      metadata: fallbackInput.metadata && typeof fallbackInput.metadata === 'object'
        ? { ...fallbackInput.metadata }
        : null
    };
  }

  normalizeHttpSource(source) {
    let parsedUrl;

    try {
      parsedUrl = new URL(String(source || '').trim());
    } catch {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw createHttpError(400, 'Only HTTP and HTTPS upstream URLs are supported');
    }

    if (!parsedUrl.hostname) {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    return parsedUrl.toString();
  }

  async sendStream(res, descriptor) {
    if (this.activeStreams >= config.MAX_ACTIVE_STREAMS) {
      logger.warn('stream rejected due to active stream limit', {
        activeStreams: this.activeStreams,
        maxActiveStreams: config.MAX_ACTIVE_STREAMS
      });
      throw createHttpError(503, 'Server is at active stream capacity');
    }

    const {
      stream,
      statusCode = 200,
      headers = {},
      cleanup = null
    } = descriptor;

    let completed = false;
    this.activeStreams += 1;

    try {
      res.status(statusCode);

      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (headerValue !== undefined && headerValue !== null) {
          res.setHeader(headerName, String(headerValue));
        }
      }

      await pipeline(stream, res);
      completed = true;
    } catch (error) {
      const errorCode = String(error?.code || '');
      const errorMessage = String(error?.message || '');
      const clientClosed = errorCode === 'ERR_STREAM_PREMATURE_CLOSE'
        || errorCode === 'ECONNRESET'
        || errorMessage === 'aborted'
        || errorMessage === 'Premature close';

      if (clientClosed) {
        logger.info('stream client disconnected before pipeline completed', {
          activeStreams: this.activeStreams,
          errorCode,
          errorMessage
        });
        return;
      }

      logger.error('stream pipeline failed', {
        activeStreams: this.activeStreams,
        error
      });
      throw error;
    } finally {
      this.activeStreams = Math.max(this.activeStreams - 1, 0);

      if (typeof cleanup === 'function') {
        await cleanup({ completed });
      }
    }
  }
}
