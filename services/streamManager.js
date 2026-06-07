import { pipeline } from 'node:stream/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { setMaxListeners } from 'node:events';
import v8 from 'node:v8';
import { createClient } from 'redis';
import { config, cacheConfig } from '../config.js';
import { enhanceMagnet, extractInfoHash, isVideoFile } from '../utils/magnet.js';
import { logger } from '../utils/logger.js';
import { RogPlayAdapter } from '../providers/rogplay/RogPlayAdapter.js';
import { GermanIptvLiveAdapter } from '../src/adapters/GermanIptvLiveAdapter.js';
import { FamelackLiveAdapter } from '../src/adapters/FamelackLiveAdapter.js';
import { XtreamCodesAdapter, hasXtreamCredentials } from '../src/adapters/XtreamCodesAdapter.js';
import { StalkerPortalAdapter, hasStalkerCredentials } from '../src/adapters/StalkerPortalAdapter.js';

const { mkdir, readFile, readdir, rename, rm, writeFile } = fsPromises;

const writeJsonFileAtomic = async (filePath, payload) => {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  try {
    await writeFile(tempPath, JSON.stringify(payload));
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

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

const getProcessHeapPressurePercent = () => {
  const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
  const heapUsedBytes = process.memoryUsage().heapUsed;
  return heapLimitBytes > 0 ? (heapUsedBytes / heapLimitBytes) * 100 : 0;
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
  customProxyUrl: null,
  pluginProviderSelections: Object.freeze({})
});
const DEFAULT_PRIVATE_PROVIDER_SETTINGS = Object.freeze({
  febboxUiCookie: null,
  showboxOssGroup: null,
  torboxApiKey: null,
  xtreamServerUrl: null,
  xtreamUsername: null,
  xtreamPassword: null,
  stalkerPortalUrl: null,
  stalkerMacAddress: null,
  stalkerStbType: null,
  stalkerSerialNumber: null,
  stalkerDeviceId: null,
  stalkerDeviceId2: null,
  famelackLiveEnabled: false
});
const PRIVATE_CONFIG_VERSION = 1;
const PRIVATE_PROVIDER_COOKIE_MAX_LENGTH = 4096;
const CONTENT_SELECTIONS = new Set(['default', 'movie', 'series']);

const normalizeSupporterRecord = (value) => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const expiresAtMs = Date.parse(value.expiresAt || '');
  if (!value.active || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return null;
  }
  return {
    active: true,
    tier: String(value.tier || 'supporter').trim().toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 32) || 'supporter',
    label: String(value.label || '').trim().slice(0, 80),
    expiresAt: new Date(expiresAtMs).toISOString(),
    codeHash: String(value.codeHash || '').trim().toLowerCase().replace(/[^a-f0-9]/gu, '').slice(0, 64)
  };
};

const normalizeContentSelection = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return CONTENT_SELECTIONS.has(normalized) ? normalized : 'default';
};

const normalizePluginProviderSelections = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value)
    .map(([adapterId, providers]) => {
      const normalizedAdapterId = String(adapterId || '').trim().toLowerCase();
      const normalizedProviders = Array.isArray(providers)
        ? providers
          .map((providerId) => String(providerId || '').trim().toLowerCase())
          .filter(Boolean)
          .filter((providerId, index, values) => values.indexOf(providerId) === index)
        : [];

      return normalizedAdapterId && normalizedProviders.length > 0
        ? [normalizedAdapterId, normalizedProviders]
        : null;
    })
    .filter(Boolean));
};

const normalizePositiveIntegerOption = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const HIGH_VALUE_CACHE_PROVIDERS = new Set(['4khdhub', 'scrapling-4khdhub', '4khdhub_tv', 'hdhub4u']);
const HIGH_VALUE_CACHE_PATTERN = /\b(4khdhub|hdhub|hubcloud|hub cloud)\b/iu;
const LAST_GOOD_PRIMARY_PROVIDERS = new Set(['4khdhub', 'scrapling 4khdhub', '4khdhub tv', 'hdhub4u', 'uhdmovies']);
const LAST_GOOD_SECONDARY_PROVIDERS = new Set(['vidsrc', 'vixsrc', 'vidlink', 'moviebox', 'cinestream', 'streamflix']);
const STANDALONE_FAST_PASS_PROVIDER_ORDER = Object.freeze([
  'r3-plugin',
  'r5-plugin',
  'r2-plugin',
  'moviebox',
  'vidlink',
  'videasy',
  'cinestream',
  'showbox',
  'vixsrc',
  'streamflix',
  'streamflix_eng',
  'netmirror',
  'vidsrc',
  'multivid',
  'playimdb',
  'playimdb_v2',
  'fmovies'
]);
const TORBOX_DEFAULT_PROVIDER_ORDER = Object.freeze([
  'torrent-scraper',
  'streamrip-plugin',
  'r5-plugin',
  'nuvio',
  'nuvio-2',
  'cloudstream-phisher',
  'r2-plugin',
  'r3-plugin',
  '4khdhub',
  '4khdhub_tv',
  'scrapling-4khdhub',
  'hdhub4u',
  'scrapling-hdhub4u',
  'uhdmovies'
]);
const DIRECT_PLAYBACK_PROVIDER_IDS = new Set(['4khdhub', 'scrapling-4khdhub', '4khdhub_tv', 'hdhub4u', 'showbox', 'r5-plugin']);
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

const extractTorBoxTorrentId = (payload) => {
  const candidates = [
    payload?.data?.torrent_id,
    payload?.data?.torrentId,
    payload?.data?.torrent?.id,
    payload?.data?.id,
    payload?.torrent_id,
    payload?.torrentId,
    payload?.id
  ];

  for (const value of candidates) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }

  return null;
};

const getTorBoxPayloadData = (payload) => payload?.data && typeof payload.data === 'object'
  ? payload.data
  : null;

const isTorBoxWebDownloadReady = (payload) => {
  const data = getTorBoxPayloadData(payload);
  if (!data) return false;

  return data.download_finished === true
    || data.download_present === true
    || data.cached === true
    || String(data.download_state || '').toLowerCase() === 'completed';
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

const getTorBoxFileList = (payload) => {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.files)) return data.files;
  if (Array.isArray(data?.download?.files)) return data.download.files;
  if (Array.isArray(data?.torrent?.files)) return data.torrent.files;
  if (Array.isArray(data?.webdl?.files)) return data.webdl.files;
  if (Array.isArray(payload?.files)) return payload.files;
  return [];
};

const getTorBoxCachedResults = (payload) => {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.hashes)) return data.hashes;
  if (data && typeof data === 'object') return Object.entries(data).map(([hash, value]) => ({
    hash,
    ...(value && typeof value === 'object' ? value : { cached: Boolean(value) })
  }));
  return [];
};

const isTorBoxCachedEntry = (entry) =>
  Boolean(entry)
  && (
    entry.cached === true
    || entry.download_present === true
    || entry.instant === true
    || Array.isArray(entry.files)
  );

const pickTorBoxVideoFile = (files, preferredFileIndex = null, preferredFilename = null) => {
  const normalizedPreferredIndex = Number.isInteger(Number(preferredFileIndex))
    ? Number(preferredFileIndex)
    : null;
  const normalizedPreferredName = String(preferredFilename || '').trim().toLowerCase();
  const videoFiles = (Array.isArray(files) ? files : [])
    .filter((file) => isVideoFile(file?.name || file?.short_name || file?.filename || ''))
    .sort((left, right) => Number(right?.size || 0) - Number(left?.size || 0));

  if (normalizedPreferredIndex !== null) {
    const byIndex = videoFiles.find((file) =>
      Number(file?.fileIndex ?? file?.file_index ?? file?.index) === normalizedPreferredIndex
    );
    if (byIndex) return byIndex;
  }

  if (normalizedPreferredName) {
    const byName = videoFiles.find((file) =>
      String(file?.name || file?.short_name || file?.filename || '').toLowerCase().includes(normalizedPreferredName)
    );
    if (byName) return byName;
  }

  return videoFiles[0] || null;
};

const extractTorBoxRequestDownloadUrl = (payload) => {
  const candidates = [
    typeof payload?.data === 'string' ? payload.data : null,
    payload?.data?.url,
    payload?.data?.download_url,
    payload?.data?.link,
    payload?.url,
    payload?.download_url,
    payload?.link
  ];

  for (const value of candidates) {
    try {
      const parsed = new URL(String(value || '').trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      // Continue checking alternate response shapes.
    }
  }

  return null;
};

const TORBOX_DDL_HOST_PATTERNS = Object.freeze([
  /(?:^|\.)1fichier\.com$/iu,
  /(?:^|\.)bzzhr\.co$/iu,
  /(?:^|\.)buzzheavier\.com$/iu,
  /(?:^|\.)filemoon\./iu,
  /(?:^|\.)gadgetsweb\.xyz$/iu,
  /(?:^|\.)gigabytes\.icu$/iu,
  /(?:^|\.)gofile\.io$/iu,
  /(?:^|\.)hub\.homelander\.buzz$/iu,
  /(?:^|\.)hubcdn\./iu,
  /(?:^|\.)hubcloud\./iu,
  /(?:^|\.)hubdrive\./iu,
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
const TORBOX_DDL_TEXT_PATTERN = /\b(?:direct\s*download|download\s*link|fast\s*dl|hub\s*cloud|hub\s*drive|hubcloud|hubdrive|hubcdn|pixeldrain|gofile|mediafire|mega|ddl)\b/iu;

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
    if (TORBOX_DDL_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
      return true;
    }
  } catch {
    // Fall through to metadata text detection.
  }

  const metadataText = [
    stream.name,
    stream.title,
    stream.description,
    stream.sourceSite,
    stream.sourceProvider,
    stream.pluginProviderName,
    stream.provider,
    stream.url
  ].filter(Boolean).join(' ');
  return TORBOX_DDL_TEXT_PATTERN.test(metadataText);
};

const getTorBoxTorrentInfoHash = (stream) => extractInfoHash(stream?.magnet || stream?.torrent || '');

const enableTorBoxDdlStreams = (streams, privateProviderSettings = null) => {
  if (!String(privateProviderSettings?.torboxApiKey || '').trim()) {
    return streams;
  }

  return streams.map((stream) => {
    const torrentInfoHash = getTorBoxTorrentInfoHash(stream);
    if (torrentInfoHash) {
      return {
        ...stream,
        url: stream.url || stream.magnet || stream.torrent,
        torboxTorrent: true,
        torboxInfoHash: torrentInfoHash,
        torboxMagnet: stream.magnet || stream.torrent,
        transport: 'http',
        sourceSite: stream.sourceSite ? `${stream.sourceSite} via TorBox` : 'TorBox Torrent',
        behaviorHints: {
          ...(stream.behaviorHints || {}),
          notWebReady: false
        }
      };
    }

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

const filterTorBoxCachedTorrentStreams = async (streams, privateProviderSettings = null, streamOptions = null) => {
  const apiKey = normalizePrivateCookie(privateProviderSettings?.torboxApiKey);
  if (!apiKey || !streamOptions?.torboxOnlyStreams) {
    return streams;
  }

  const torrentStreams = streams.filter((stream) => stream?.torboxTorrent && stream.torboxInfoHash);
  if (torrentStreams.length === 0) {
    return streams;
  }

  const hashes = [...new Set(torrentStreams.map((stream) => stream.torboxInfoHash).filter(Boolean))].slice(0, 100);
  if (hashes.length === 0) {
    return streams.filter((stream) => !stream?.torboxTorrent);
  }

  try {
    const checkUrl = new URL('https://api.torbox.app/v1/api/torrents/checkcached');
    checkUrl.searchParams.set('format', 'list');
    checkUrl.searchParams.set('list_files', 'true');
    const response = await fetch(checkUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ hashes }),
      signal: AbortSignal.timeout(8_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      logger.warn('torbox cached torrent availability failed', {
        status: response.status,
        detail: payload?.detail || payload?.error || null
      });
      return streams.filter((stream) => !stream?.torboxTorrent);
    }

    const cachedByHash = new Map(getTorBoxCachedResults(payload)
      .filter((entry) => isTorBoxCachedEntry(entry))
      .map((entry) => [String(entry.hash || entry.info_hash || entry.infoHash || '').toLowerCase(), entry]));

    return streams
      .map((stream) => {
        if (!stream?.torboxTorrent) return stream;
        const cachedEntry = cachedByHash.get(String(stream.torboxInfoHash || '').toLowerCase());
        if (!cachedEntry) return null;
        return {
          ...stream,
          torboxCachedFiles: Array.isArray(cachedEntry.files) ? cachedEntry.files : []
        };
      })
      .filter(Boolean);
  } catch (error) {
    logger.warn('torbox cached torrent availability request failed', {
      error: error?.message || String(error)
    });
    return streams.filter((stream) => !stream?.torboxTorrent);
  }
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

const STRICT_TV_TITLE_PROVIDER_IDS = new Set(['4khdhub', '4khdhub_tv', 'hdhub4u', 'scrapling-4khdhub', 'scrapling-hdhub4u']);

const normalizeTitleForTvGuard = (value) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/\b(?:the|a|an)\b/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();

const getTvGuardText = (stream) => [
  stream?.filename,
  stream?.fileName,
  stream?.title,
  stream?.name,
  stream?.description,
  stream?.sourceProvider,
  stream?.pluginProviderName,
  stream?.sourceSite,
  stream?.url
].map((value) => {
  const text = String(value || '');
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}).join(' ').replace(/[._-]+/g, ' ');

const hasExactEpisodeMarker = (stream, season, episode) => {
  const normalizedSeason = normalizePositiveIntegerOption(season);
  const normalizedEpisode = normalizePositiveIntegerOption(episode);
  if (!normalizedSeason || !normalizedEpisode) {
    return false;
  }

  const text = getTvGuardText(stream);
  const markerPatterns = [
    /\bs\s*0*(\d{1,2})\s*(?:e|ep)\s*0*(\d{1,3})\b/giu,
    /\b0*(\d{1,2})\s*x\s*0*(\d{1,3})\b/giu,
    /\bseason\s*0*(\d{1,2})\D{0,24}\b(?:episode|ep)\s*0*(\d{1,3})\b/giu
  ];

  for (const pattern of markerPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (Number.parseInt(match[1], 10) === normalizedSeason && Number.parseInt(match[2], 10) === normalizedEpisode) {
        return true;
      }
    }
  }

  return false;
};

const isStrictTvTitleProviderStream = (stream) => {
  const ids = [
    stream?.provider,
    stream?.sourceProvider,
    stream?.pluginProvider,
    stream?.sourceSite
  ].map((value) => String(value || '').trim().toLowerCase());

  return ids.some((id) =>
    STRICT_TV_TITLE_PROVIDER_IDS.has(id)
    || id.startsWith('4khdhub')
    || id.startsWith('scrapling-4khdhub')
    || id.startsWith('scrapling-hdhub4u')
  );
};

const filterMismatchedHubTvStreams = (streams, { expectedTitle, season, episode }) => {
  const normalizedExpectedTitle = normalizeTitleForTvGuard(expectedTitle);
  const expectedTokens = normalizedExpectedTitle
    .split(/\s+/u)
    .filter((token) => token.length >= 4);

  if (expectedTokens.length === 0) {
    return streams;
  }

  return streams.filter((stream) => {
    if (!isStrictTvTitleProviderStream(stream)) {
      return true;
    }

    if (hasExactEpisodeMarker(stream, season, episode)) {
      return true;
    }

    const normalizedText = normalizeTitleForTvGuard(getTvGuardText(stream));
    return expectedTokens.every((token) => normalizedText.includes(token));
  });
};

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
    if (providerId === 'nuvio' || providerId.startsWith('nuvio-')) {
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
    } else if (streamOptions.torboxOnlyStreams && !stream.torboxWebDownload && !stream.torboxTorrent) {
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
  torboxApiKey: normalizePrivateCookie(value?.torboxApiKey),
  xtreamServerUrl: normalizePrivateCookie(value?.xtreamServerUrl),
  xtreamUsername: normalizePrivateCookie(value?.xtreamUsername),
  xtreamPassword: normalizePrivateCookie(value?.xtreamPassword),
  stalkerPortalUrl: normalizePrivateCookie(value?.stalkerPortalUrl),
  stalkerMacAddress: normalizePrivateCookie(value?.stalkerMacAddress),
  stalkerStbType: normalizePrivateCookie(value?.stalkerStbType),
  stalkerSerialNumber: normalizePrivateCookie(value?.stalkerSerialNumber),
  stalkerDeviceId: normalizePrivateCookie(value?.stalkerDeviceId),
  stalkerDeviceId2: normalizePrivateCookie(value?.stalkerDeviceId2),
  famelackLiveEnabled: Boolean(value?.famelackLiveEnabled)
});

const getPrivateProviderSettingsHash = (privateProviderSettings) => {
  const normalized = normalizePrivateProviderSettings(privateProviderSettings);

  if (
    !normalized.febboxUiCookie &&
    !normalized.showboxOssGroup &&
    !normalized.torboxApiKey &&
    !hasXtreamCredentials({
      serverUrl: normalized.xtreamServerUrl,
      username: normalized.xtreamUsername,
      password: normalized.xtreamPassword
    }) &&
    !hasStalkerCredentials({
      portalUrl: normalized.stalkerPortalUrl,
      macAddress: normalized.stalkerMacAddress,
      stbType: normalized.stalkerStbType,
      serialNumber: normalized.stalkerSerialNumber,
      deviceId: normalized.stalkerDeviceId,
      deviceId2: normalized.stalkerDeviceId2
    }) &&
    !normalized.famelackLiveEnabled
  ) {
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

const isExpectedHubCloudResolutionError = (error) =>
  /\b(?:HTTP (?:403|404|429|500|502|503|504)|fetch failed|aborted|timed out|terminated|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b/iu
    .test(String(error?.message || error || ''));

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
    || /^[a-z0-9_-]{12,}={0,2}\.(?:m3u8|mp4)$/iu.test(String(value || '').trim())
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

const isR5PluginStream = (stream) =>
  String(stream?.provider || '').trim().toLowerCase() === 'r5-plugin'
  || String(stream?.sourceProvider || '').trim().toLowerCase().startsWith('r5-plugin:')
  || String(stream?.pluginProviderName || '').trim().toLowerCase() === 'r5-plugin';

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

  if (isR5PluginStream(stream) && !/play in vlc\/external player/iu.test(cardTitle)) {
    cardTitle = [cardTitle, '▶ Play in VLC/external player'].filter(Boolean).join('\n');
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
  constructor({ torrentEngine, httpProxy, cacheManager, sourceRegistry, providerService, imdbResolver, userTracker = null, supporterService = null }) {
    this.torrentEngine = torrentEngine;
    this.httpProxy = httpProxy;
    this.cacheManager = cacheManager;
    this.sourceRegistry = sourceRegistry;
    this.providerService = providerService;
    this.imdbResolver = imdbResolver;
    this.userTracker = userTracker;
    this.supporterService = supporterService;
    this.activeStreams = 0;
    this.stremioResultCache = new Map();
    this.stremioResultInFlight = new Map();
    this.stremioBackgroundRefreshes = new Set();
    this.stremioBackgroundRefreshQueue = [];
    this.stremioDelayedRefreshTimers = new Map();
    this.activeStremioBackgroundRefreshes = 0;
    this.stremioBackgroundRefreshWakeTimer = null;
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
    this.famelackLiveAdapter = new FamelackLiveAdapter({ logger });
    this.xtreamCodesAdapter = new XtreamCodesAdapter({ logger });
    this.stalkerPortalAdapter = new StalkerPortalAdapter({ logger });
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

    if (this.stremioBackgroundRefreshWakeTimer) {
      clearTimeout(this.stremioBackgroundRefreshWakeTimer);
      this.stremioBackgroundRefreshWakeTimer = null;
    }

    this.stremioBackgroundRefreshQueue = [];
    this.stremioBackgroundRefreshes.clear();
    for (const timer of this.stremioDelayedRefreshTimers.values()) {
      clearTimeout(timer.timeout);
    }
    this.stremioDelayedRefreshTimers.clear();
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
      stremioDelayedRefreshTimers: this.stremioDelayedRefreshTimers.size,
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
    for (const timer of this.stremioDelayedRefreshTimers.values()) {
      clearTimeout(timer.timeout);
    }
    this.stremioDelayedRefreshTimers.clear();
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
      for (const request of this.stremioResultInFlight.values()) {
        request?.controller?.abort?.(createHttpError(499, 'Critical memory pressure'));
      }
      this.stremioResultInFlight.clear();
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

  scheduleStremioBackgroundRefreshWake(delayMs = 1_000) {
    if (this.stremioBackgroundRefreshWakeTimer) {
      return;
    }

    this.stremioBackgroundRefreshWakeTimer = setTimeout(() => {
      this.stremioBackgroundRefreshWakeTimer = null;
      this.runStremioBackgroundRefreshQueue();
    }, Math.max(250, delayMs));
    this.stremioBackgroundRefreshWakeTimer.unref?.();
  }

  pruneStaleStremioBackgroundRefreshQueue(now = Date.now()) {
    if (this.stremioBackgroundRefreshQueue.length === 0) {
      return 0;
    }

    const staleMs = Math.max(120_000, Math.min(900_000, config.STREMIO_STREAM_OVERALL_TIMEOUT_MS * 16));
    const before = this.stremioBackgroundRefreshQueue.length;
    this.stremioBackgroundRefreshQueue = this.stremioBackgroundRefreshQueue.filter((input) => {
      const scheduledAt = Number(input?.scheduledAt || 0);
      const isStale = scheduledAt > 0 && now - scheduledAt > staleMs;

      if (isStale) {
        this.stremioBackgroundRefreshes.delete(input.resultCacheKey);
      }

      return !isStale;
    });

    return before - this.stremioBackgroundRefreshQueue.length;
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

    let providers = this.providerService.normalizeProviders(payload.providers);
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
      customProxyUrl: normalizeCustomProxyUrl(baseStreamOptions.customProxyUrl),
      pluginProviderSelections: normalizePluginProviderSelections(baseStreamOptions.pluginProviderSelections)
    };
    const privateProviderSettings = normalizePrivateProviderSettings(payload.privateProviderSettings);
    if (
      providers.length === 0 &&
      streamOptions.torboxOnlyStreams &&
      String(privateProviderSettings.torboxApiKey || '').trim() &&
      this.providerService.providers.has('torrent-scraper')
    ) {
      providers = ['torrent-scraper'];
    }
    const profileCode = typeof payload.profileCode === 'string'
      ? payload.profileCode.trim().toLowerCase()
      : null;

    return {
      version: PRIVATE_CONFIG_VERSION,
      providers,
      qualityPriority,
      streamOptions,
      privateProviderSettings,
      supporter: normalizeSupporterRecord(payload.supporter),
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
          if (error?.code === 'ENOENT') {
            continue;
          }

          logger.warn('private config load failed', {
            configId,
            error
          });
          const brokenPath = this.getPrivateConfigPath(configId);
          const quarantinePath = `${brokenPath}.invalid-${Date.now()}`;
          await rename(brokenPath, quarantinePath).catch(() => {});
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

  getRequestedXtreamCredentials(req) {
    const settings = this.getRequestedPrivateProviderSettings(req);
    return {
      serverUrl: settings.xtreamServerUrl,
      username: settings.xtreamUsername,
      password: settings.xtreamPassword
    };
  }

  getRequestedStalkerCredentials(req) {
    const settings = this.getRequestedPrivateProviderSettings(req);
    return {
      portalUrl: settings.stalkerPortalUrl,
      macAddress: settings.stalkerMacAddress,
      stbType: settings.stalkerStbType,
      serialNumber: settings.stalkerSerialNumber,
      deviceId: settings.stalkerDeviceId,
      deviceId2: settings.stalkerDeviceId2
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
        supporter: normalized.supporter ? {
          tier: normalized.supporter.tier,
          expiresAt: normalized.supporter.expiresAt,
          codeHash: normalized.supporter.codeHash
        } : null,
        profileCode: normalized.profileCode
      }))
      .digest('hex')
      .slice(0, 24);

    await this.ensurePrivateConfigDir();
    await writeFile(this.getPrivateConfigPath(configId), JSON.stringify(normalized), { mode: 0o600 });
    this.privateConfigStore.set(configId, normalized);

    return {
      configId,
      manifestPath: `/private/${configId}/manifest.json`
    };
  }

  buildStremioResultCacheKey({ tmdbId, mediaType, season, episode, providers, qualityPriority, streamOptions, privateProviderSettingsHash = null }) {
    return JSON.stringify({
      version: 145,
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
    if (res.locals?.nebulaStremioKeepaliveStartTimer) {
      clearTimeout(res.locals.nebulaStremioKeepaliveStartTimer);
      res.locals.nebulaStremioKeepaliveStartTimer = null;
    }

    if (res.destroyed || res.writableEnded) {
      return;
    }

    const normalizedStreams = Array.isArray(streams) ? streams : [];

    try {
      if (res.headersSent && res.locals?.nebulaStremioKeepaliveStarted) {
        this.stopStremioResponseKeepalive(res);
        res.end(JSON.stringify({
          streams: normalizedStreams
        }));
        return;
      }

      if (res.headersSent) {
        return;
      }

      if (normalizedStreams.length === 0) {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=60');
      }

      res.setHeader('X-NebulaStreams-Stream-Count', String(normalizedStreams.length));
      res.json({
        streams: normalizedStreams
      });
    } catch (error) {
      logger.warn('stremio stream response write skipped', {
        error: error?.message || String(error),
        streamCount: normalizedStreams.length
      });
    }
  }

  startStremioResponseKeepalive(res) {
    if (res.headersSent || res.destroyed || res.writableEnded || res.locals?.nebulaStremioKeepaliveStarted) {
      return;
    }

    try {
      res.locals.nebulaStremioKeepaliveStarted = true;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      res.write('\n');

      const interval = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
          this.stopStremioResponseKeepalive(res);
          return;
        }

        try {
          res.write('\n');
        } catch {
          this.stopStremioResponseKeepalive(res);
        }
      }, 8_000);
      interval.unref?.();
      res.locals.nebulaStremioKeepaliveInterval = interval;
    } catch (error) {
      logger.warn('stremio response keepalive failed', {
        error: error?.message || String(error)
      });
    }
  }

  stopStremioResponseKeepalive(res) {
    const interval = res.locals?.nebulaStremioKeepaliveInterval;
    if (interval) {
      clearInterval(interval);
      res.locals.nebulaStremioKeepaliveInterval = null;
    }
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
        await rm(this.getStremioResultCachePath(cacheKey), { force: true }).catch(() => {});
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
        await rm(this.getStremioLastGoodCachePath(cacheKey), { force: true }).catch(() => {});
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
      await writeJsonFileAtomic(this.getStremioResultCachePath(cacheKey), entry);
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
        await writeJsonFileAtomic(this.getStremioLastGoodCachePath(cacheKey), lastGoodEntry);
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
      if (privateConfig.providers.length === 0 && privateConfig.streamOptions?.torboxOnlyStreams) {
        return ['torrent-scraper'].filter((providerId) => this.providerService.providers.has(providerId));
      }

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
        customProxyUrl: normalizeCustomProxyUrl(privateConfig.streamOptions?.customProxyUrl),
        pluginProviderSelections: normalizePluginProviderSelections(privateConfig.streamOptions?.pluginProviderSelections)
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
      customProxyUrl: null,
      pluginProviderSelections: {}
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
    const privateConfig = this.getRequestedPrivateConfig(req);
    const providers = this.getRequestedProviders(req);
    const qualityPriority = this.getRequestedQualityPriority(req);
    const streamOptions = this.getRequestedStreamOptions(req);
    const privateProviderSettingsHash = getPrivateProviderSettingsHash(this.getRequestedPrivateProviderSettings(req));
    const configuredProfile = this.getRequestedConfiguredProfile(req);
    const supporter = normalizeSupporterRecord(privateConfig?.supporter);
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
      description: `${supporter ? 'Supporter install. ' : ''}Configured install: ${configuredLabel.label}. Providers: ${providerSummary}. Quality priority: ${qualityPriority.join(' > ')}. Playback: ${summarizeStreamOptions(streamOptions)}`
    };
  }

  async handleStremioManifest(req, res) {
    const baseUrl = getStremioRequestBaseUrl(req);
    const addonPresentation = this.getAddonPresentation(req);
    const contentSelection = normalizeContentSelection(addonPresentation.streamOptions?.contentSelection);
    const xtreamCredentials = this.getRequestedXtreamCredentials(req);
    const xtreamEnabled = hasXtreamCredentials(xtreamCredentials);
    const stalkerCredentials = this.getRequestedStalkerCredentials(req);
    const stalkerEnabled = hasStalkerCredentials(stalkerCredentials);
    const famelackEnabled = Boolean(this.getRequestedPrivateProviderSettings(req).famelackLiveEnabled);
    const xtreamCatalogDefinitions = xtreamEnabled
      ? await Promise.all([
        this.xtreamCodesAdapter.getCategories(xtreamCredentials, 'live', AbortSignal.timeout(8_000)).catch(() => []),
        this.xtreamCodesAdapter.getCategories(xtreamCredentials, 'vod', AbortSignal.timeout(8_000)).catch(() => []),
        this.xtreamCodesAdapter.getCategories(xtreamCredentials, 'series', AbortSignal.timeout(8_000)).catch(() => [])
      ]).then(([live, vod, series]) =>
        this.xtreamCodesAdapter.getCompactCatalogDefinitions({ live, vod, series }, 40)
      ).catch((error) => {
        logger.warn('xtream compact manifest catalog load failed', {
          error: error?.message || String(error)
        });
        return this.xtreamCodesAdapter.getCompactCatalogDefinitions();
      })
      : [];
    const stalkerCatalogDefinitions = stalkerEnabled
      ? await this.stalkerPortalAdapter.getCategories(stalkerCredentials, AbortSignal.timeout(8_000)).then((categories) =>
        this.stalkerPortalAdapter.getCompactCatalogDefinitions(categories, 40)
      ).catch((error) => {
        logger.warn('stalker compact manifest catalog load failed', {
          error: error?.message || String(error)
        });
        return this.stalkerPortalAdapter.getCompactCatalogDefinitions();
      })
      : [];
    const famelackCatalogDefinitions = famelackEnabled
      ? await this.famelackLiveAdapter.getTopCountries(40, AbortSignal.timeout(8_000)).then((countries) =>
        this.famelackLiveAdapter.getLiveCatalogDefinitions(countries)
      ).catch((error) => {
        logger.warn('famelack compact manifest catalog load failed', {
          error: error?.message || String(error)
        });
        return this.famelackLiveAdapter.getLiveCatalogDefinitions();
      })
      : [];
    const manifestTypes = contentSelection === 'movie'
      ? ['movie']
      : contentSelection === 'series'
        ? ['series']
        : ((xtreamEnabled || stalkerEnabled || famelackEnabled) ? ['movie', 'series', 'tv'] : ['movie', 'series']);
    const xtreamCatalogs = xtreamCatalogDefinitions
      .filter((catalog) => contentSelection === 'default' || catalog.type === contentSelection)
      .map((catalog) => ({
        type: catalog.type,
        id: catalog.id,
        name: catalog.name,
        extra: [
          { name: 'skip', isRequired: false },
          { name: 'search', isRequired: false }
        ]
      }));
    const stalkerCatalogs = stalkerCatalogDefinitions
      .filter((catalog) => contentSelection === 'default' || catalog.type === contentSelection)
      .map((catalog) => ({
        type: catalog.type,
        id: catalog.id,
        name: catalog.name,
        extra: [
          { name: 'skip', isRequired: false },
          { name: 'search', isRequired: false }
        ]
      }));
    const famelackCatalogs = famelackCatalogDefinitions
      .filter((catalog) => contentSelection === 'default' || catalog.type === contentSelection)
      .map((catalog) => ({
        type: 'tv',
        id: catalog.id,
        name: catalog.name,
        extra: [
          { name: 'skip', isRequired: false },
          { name: 'search', isRequired: false }
        ]
      }));
    const catalogResources = [
      ...(xtreamEnabled ? ['xtream:'] : []),
      ...(stalkerEnabled ? ['stalker:'] : []),
      ...(famelackEnabled ? ['famelack:'] : [])
    ];
    const allCatalogs = [...xtreamCatalogs, ...stalkerCatalogs, ...famelackCatalogs];

    res.json({
      id: addonPresentation.addonId,
      version: '1.0.4',
      name: addonPresentation.addonName,
      description: addonPresentation.description,
      resources: [
        'stream',
        ...(catalogResources.length > 0 ? [
          {
            name: 'catalog',
            types: [...new Set(allCatalogs.map((catalog) => catalog.type))],
            idPrefixes: catalogResources
          },
          {
            name: 'meta',
            types: [...new Set(allCatalogs.map((catalog) => catalog.type))],
            idPrefixes: catalogResources
          }
        ] : [])
      ],
      types: manifestTypes,
      idPrefixes: catalogResources.length > 0
        ? ['tt', 'tmdb:', ...catalogResources]
        : ['tt', 'tmdb:'],
      catalogs: allCatalogs,
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

    if (this.isFamelackLiveStreamRequest(req.params.type, req.params.id)) {
      try {
        const famelackEnabled = Boolean(this.getRequestedPrivateProviderSettings(req).famelackLiveEnabled);
        if (!famelackEnabled || !req.params.privateConfigId) {
          this.sendStremioStreamsResponse(res, []);
          return;
        }

        const streams = await this.famelackLiveAdapter.getLiveStreams(req.params.id, req.signal || null);
        this.sendStremioStreamsResponse(res, streams);
      } catch (error) {
        logger.warn('famelack live stream lookup failed', {
          id: req.params.id,
          error: error?.message || String(error)
        });
        this.sendStremioStreamsResponse(res, []);
      }
      return;
    }

    if (this.isXtreamStreamRequest(req.params.type, req.params.id)) {
      try {
        const xtreamCredentials = this.getRequestedXtreamCredentials(req);
        if (!hasXtreamCredentials(xtreamCredentials) || !req.params.privateConfigId) {
          this.sendStremioStreamsResponse(res, []);
          return;
        }

        const streams = await this.xtreamCodesAdapter.getStreams({
          credentials: xtreamCredentials,
          id: req.params.id,
          baseUrl: getStremioRequestBaseUrl(req),
          privateConfigId: req.params.privateConfigId
        });
        this.sendStremioStreamsResponse(res, streams);
      } catch (error) {
        logger.warn('xtream stream lookup failed', {
          id: req.params.id,
          type: req.params.type,
          error: error?.message || String(error)
        });
        this.sendStremioStreamsResponse(res, []);
      }
      return;
    }

    if (this.isStalkerStreamRequest(req.params.type, req.params.id)) {
      try {
        const stalkerCredentials = this.getRequestedStalkerCredentials(req);
        if (!hasStalkerCredentials(stalkerCredentials) || !req.params.privateConfigId) {
          this.sendStremioStreamsResponse(res, []);
          return;
        }

        const streams = await this.stalkerPortalAdapter.getStreams({
          credentials: stalkerCredentials,
          id: req.params.id,
          baseUrl: getStremioRequestBaseUrl(req),
          privateConfigId: req.params.privateConfigId,
          signal: req.signal || null
        });
        this.sendStremioStreamsResponse(res, streams);
      } catch (error) {
        logger.warn('stalker stream lookup failed', {
          id: req.params.id,
          type: req.params.type,
          error: error?.message || String(error)
        });
        this.sendStremioStreamsResponse(res, []);
      }
      return;
    }

    const routeStartedAt = Date.now();
    const clientUserAgent = String(req.get?.('user-agent') || '').toLowerCase();
    const isAioStreamsClient = /\baiostreams\b/u.test(clientUserAgent);
    const isShortDeadlineClient = /\b(?:nuvio|stremio-apple|stremioshell|strmr|fusionapp|ktor-client|okhttp)\b/u
      .test(clientUserAgent);
    const baseOverallTimeoutMs = Math.max(
      config.STREMIO_STREAM_OVERALL_TIMEOUT_MS,
      config.STREMIO_FAST_MAX_WAIT_MS + 5_000
    );
    const overallTimeoutMs = isAioStreamsClient
      ? Math.max(baseOverallTimeoutMs, 28_000)
      : Math.min(baseOverallTimeoutMs, isShortDeadlineClient ? 11_500 : 13_500);
    const requestAbortController = new AbortController();
    allowHighFanoutAbortSignal(requestAbortController.signal);
    const setResponseHeader = (name, value) => {
      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        res.setHeader(name, value);
      }
    };
    const abortActiveSearch = (message) => {
      if (!requestAbortController.signal.aborted) {
        requestAbortController.abort(createHttpError(499, message));
      }
    };
    const onClientClose = () => {
      if (res.locals?.nebulaStremioKeepaliveStartTimer) {
        clearTimeout(res.locals.nebulaStremioKeepaliveStartTimer);
        res.locals.nebulaStremioKeepaliveStartTimer = null;
      }
      this.stopStremioResponseKeepalive(res);
      if (!res.writableEnded) {
        abortActiveSearch('Stremio client disconnected');
      }
    };
    req.on('aborted', onClientClose);
    res.on('close', onClientClose);
    let timeoutFallbackContext = null;
    let deadlineRefreshInput = null;
    let overallTimeout = null;
    let standaloneDeadlineResponseTimer = null;
    const clearStandaloneDeadlineResponseTimer = () => {
      if (standaloneDeadlineResponseTimer) {
        clearTimeout(standaloneDeadlineResponseTimer);
        standaloneDeadlineResponseTimer = null;
      }
    };
    const sendDeadlineFallbackResponse = (reason) => {
      if (res.destroyed || res.writableEnded) {
        return false;
      }

      const cachedStreams = timeoutFallbackContext?.cachedResult?.state === 'stale'
        ? timeoutFallbackContext.cachedResult.streams
        : null;
      const fallbackStreams = Array.isArray(cachedStreams) && cachedStreams.length > 0
        ? cachedStreams
        : (Array.isArray(timeoutFallbackContext?.lastGoodStreams) && timeoutFallbackContext.lastGoodStreams.length > 0
            ? timeoutFallbackContext.lastGoodStreams
            : []);

      logger.warn('serving standalone stremio deadline response', {
        imdbId: req.params.id,
        mediaType: req.params.type,
        reason,
        resultCount: fallbackStreams.length
      });
      if (deadlineRefreshInput && !isAioStreamsClient) {
        this.scheduleStremioBackgroundRefresh(deadlineRefreshInput);
      }
      abortActiveSearch(`Stremio ${reason}`);
      setResponseHeader('X-NebulaStreams-Cache', fallbackStreams.length > 0 ? reason : 'deadline-empty');
      clearStandaloneDeadlineResponseTimer();
      if (overallTimeout) {
        clearTimeout(overallTimeout);
      }
      this.sendStremioStreamsResponse(res, fallbackStreams);
      return true;
    };
    overallTimeout = setTimeout(() => {
      void (async () => {
        if (res.headersSent && !res.locals?.nebulaStremioKeepaliveStarted) {
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
          setResponseHeader('X-NebulaStreams-Cache', fallbackSource);
          this.sendStremioStreamsResponse(res, fallbackStreams);
          return;
        }

        sendDeadlineFallbackResponse('overall-timeout');
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
      const hasExplicitProviderConfig = isConfiguredRequest && requestedProviders.length > 0;
      const hasOnlyNuvioProviders = hasExplicitProviderConfig
        && requestedProviders.every((providerId) => String(providerId || '').startsWith('nuvio'));
      const routeSoftDeadlineMs = Math.max(5_000, Math.min(
        overallTimeoutMs - 500,
        isAioStreamsClient
          ? 27_500
          : isShortDeadlineClient && hasOnlyNuvioProviders
            ? 8_500
            : isShortDeadlineClient && hasExplicitProviderConfig
              ? 12_500
              : isShortDeadlineClient
                ? 11_500
                : hasExplicitProviderConfig
                  ? 13_500
                  : overallTimeoutMs - 500
      ));
      const getRemainingRouteBudgetMs = (reserveMs = 350) =>
        Math.max(0, routeSoftDeadlineMs - (Date.now() - routeStartedAt) - reserveMs);
      const bypassStremioResultCache = (requestedProviders.length === 1 && requestedProviders[0] === 'allyoucanwatch')
        || streamOptions.torboxOnlyStreams;
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

      if (!isAioStreamsClient) {
        const elapsedMs = Date.now() - routeStartedAt;
        const standaloneResponseDeadlineMs = Math.min(
          overallTimeoutMs - 1_200,
          isShortDeadlineClient ? 9_500 : 11_000
        );
        const standaloneResponseDelayMs = Math.max(250, standaloneResponseDeadlineMs - elapsedMs);
        standaloneDeadlineResponseTimer = setTimeout(() => {
          sendDeadlineFallbackResponse('standalone-client-deadline');
        }, standaloneResponseDelayMs);
        standaloneDeadlineResponseTimer.unref?.();
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

        setResponseHeader('X-NebulaStreams-Mode', 'uncached-explicit-provider');
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

        setResponseHeader('X-NebulaStreams-Mode', degradedStreams.length > 0 ? 'configured-degraded-cache' : 'configured-degraded-empty');
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
      deadlineRefreshInput = buildInput;

      if (lastGoodStreams?.length && getLastGoodStreamSetScore(lastGoodStreams) > 0) {
        this.scheduleStremioBackgroundRefresh(buildInput);
        setResponseHeader('X-NebulaStreams-Cache', 'last-good-refreshing');
        clearTimeout(overallTimeout);
        this.sendStremioStreamsResponse(res, lastGoodStreams);
        return;
      }

      if (cachedResult?.state === 'stale') {
        this.scheduleStremioBackgroundRefresh(buildInput);
        setResponseHeader('X-NebulaStreams-Cache', 'stale');
        clearTimeout(overallTimeout);
        this.sendStremioStreamsResponse(res, cachedResult.streams);
        return;
      }

      const standaloneFastPassProviders = (() => {
        if (isAioStreamsClient || bypassStremioResultCache) {
          return null;
        }

        const requestedSet = requestedProviders.length > 0
          ? new Set(requestedProviders.map((providerId) => String(providerId || '').toLowerCase()))
          : null;
        const selected = STANDALONE_FAST_PASS_PROVIDER_ORDER.filter((providerId) =>
          !requestedSet || requestedSet.has(providerId)
        );

        if (selected.length < 2) {
          return null;
        }

        return selected;
      })();

      if (standaloneFastPassProviders) {
        const standaloneTimeoutSentinel = { timedOut: true };
        const standaloneFastPassCapMs = parsed.mediaType === 'movie' ? 9_000 : 6_000;
        const standaloneFastPassReserveMs = parsed.mediaType === 'movie' ? 700 : 1_200;
        const standaloneBudgetMs = Math.min(
          getRemainingRouteBudgetMs(standaloneFastPassReserveMs),
          standaloneFastPassCapMs
        );
        if (standaloneBudgetMs < 1_000) {
          logger.warn('standalone fast-pass skipped because deadline budget is exhausted', {
            tmdbId,
            mediaType: parsed.mediaType,
            remainingMs: standaloneBudgetMs
          });
        } else {
          const standaloneStreams = await withTimeoutFallback(
            this.buildStremioStreams({
              ...buildInput,
              requestedProviders: standaloneFastPassProviders,
              cacheResult: false
            }),
            standaloneBudgetMs,
            standaloneTimeoutSentinel
          );

          if (standaloneStreams !== standaloneTimeoutSentinel && Array.isArray(standaloneStreams) && standaloneStreams.length > 0) {
            this.scheduleStremioBackgroundRefresh(buildInput);
            setResponseHeader('X-NebulaStreams-Mode', 'standalone-fast-pass');
            clearTimeout(overallTimeout);
            this.sendStremioStreamsResponse(res, standaloneStreams);
            return;
          }

          logger.warn('standalone fast-pass returned no streams before client deadline', {
            tmdbId,
            mediaType: parsed.mediaType,
            providerCount: standaloneFastPassProviders.length,
            timedOut: standaloneStreams === standaloneTimeoutSentinel
          });
        }
      }

      let stremioStreams;

      try {
        const buildTimeoutSentinel = { timedOut: true };
        const buildPromise = this.getOrBuildStremioStreams(buildInput);
        const buildBudgetMs = getRemainingRouteBudgetMs();

        if (buildBudgetMs <= 0) {
          logger.warn('standalone route deadline exhausted before full build', {
            tmdbId,
            mediaType: parsed.mediaType
          });
          abortActiveSearch('Stremio route deadline exhausted');
          setResponseHeader('X-NebulaStreams-Cache', 'deadline-empty');
          clearTimeout(overallTimeout);
          this.sendStremioStreamsResponse(res, []);
          return;
        }

        stremioStreams = await withTimeoutFallback(
          buildPromise,
          buildBudgetMs,
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

            setResponseHeader('X-NebulaStreams-Cache', 'deadline-fallback');
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
          setResponseHeader('X-NebulaStreams-Cache', 'deadline-empty');
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
          setResponseHeader('X-NebulaStreams-Cache', 'last-good-error');
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
          setResponseHeader('X-NebulaStreams-Cache', 'last-good-empty');
          clearTimeout(overallTimeout);
          this.sendStremioStreamsResponse(res, lastGoodStreams);
          return;
        }
      }

      clearTimeout(overallTimeout);
      this.sendStremioStreamsResponse(res, stremioStreams);
    } catch (error) {
      clearTimeout(overallTimeout);
      const isMalformedStremioProbe = error?.statusCode === 400
        && /^Series stream id must be in/u.test(String(error?.message || ''));
      if (isMalformedStremioProbe) {
        logger.info('stremio stream route ignored malformed series probe', {
          id: req.params.id,
          mediaType: req.params.type
        });
        this.sendStremioStreamsResponse(res, []);
        return;
      }

      logger.warn('stremio stream route failed; serving fallback response', {
        id: req.params.id,
        mediaType: req.params.type,
        error: error?.message || String(error)
      });

      const fallbackStreams = Array.isArray(timeoutFallbackContext?.lastGoodStreams) && timeoutFallbackContext.lastGoodStreams.length > 0
        ? timeoutFallbackContext.lastGoodStreams
        : (Array.isArray(timeoutFallbackContext?.cachedResult?.streams) ? timeoutFallbackContext.cachedResult.streams : []);

      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        res.setHeader('X-NebulaStreams-Cache', fallbackStreams.length > 0 ? 'route-error-fallback' : 'route-error-empty');
      }
      this.sendStremioStreamsResponse(res, fallbackStreams);
    } finally {
      req.off('aborted', onClientClose);
      res.off('close', onClientClose);
    }
  }

  scheduleStremioBackgroundRefresh(input) {
    if (config.STREMIO_BACKGROUND_REFRESH_CONCURRENCY <= 0 || config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX <= 0) {
      return;
    }

    if (this.stremioBackgroundRefreshes.has(input.resultCacheKey) || this.stremioResultInFlight.has(input.resultCacheKey)) {
      return;
    }

    const staleDropped = this.pruneStaleStremioBackgroundRefreshQueue();
    if (staleDropped > 0) {
      logger.warn('stale stremio background refreshes pruned', {
        staleDropped,
        queueSize: this.stremioBackgroundRefreshQueue.length
      });
    }

    const trackedCount = this.stremioBackgroundRefreshes.size;

    if (trackedCount >= config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX) {
      const dropped = this.stremioBackgroundRefreshQueue.shift();
      if (!dropped) {
        logger.warn('stremio background refresh queue full with active refreshes; deferred new refresh', {
          activeRefreshes: this.activeStremioBackgroundRefreshes,
          maxQueue: config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX,
          tmdbId: input.tmdbId,
          mediaType: input.parsed?.mediaType
        });
        this.scheduleStremioBackgroundRefreshWake(1_000);
        return;
      }

      if (dropped?.resultCacheKey) {
        this.stremioBackgroundRefreshes.delete(dropped.resultCacheKey);
      }
      logger.warn('stremio background refresh queue full; replaced oldest queued refresh', {
        queueSize: this.stremioBackgroundRefreshQueue.length,
        activeRefreshes: this.activeStremioBackgroundRefreshes,
        maxQueue: config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX,
        droppedTmdbId: dropped?.tmdbId,
        droppedMediaType: dropped?.parsed?.mediaType,
        tmdbId: input.tmdbId,
        mediaType: input.parsed?.mediaType
      });
    }

    const { signal: _signal, ...backgroundInput } = input;
    backgroundInput.scheduledAt = Date.now();
    this.stremioBackgroundRefreshes.add(input.resultCacheKey);
    this.stremioBackgroundRefreshQueue.push(backgroundInput);
    this.runStremioBackgroundRefreshQueue();
  }

  scheduleDelayedStremioBackgroundRefresh(input, delayMs = 8_000) {
    const resultCacheKey = input?.resultCacheKey;
    if (!resultCacheKey) {
      return;
    }

    const runAt = Date.now() + Math.max(250, Number(delayMs) || 0);
    const existing = this.stremioDelayedRefreshTimers.get(resultCacheKey);
    if (existing && existing.runAt <= runAt) {
      return;
    }
    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      this.stremioDelayedRefreshTimers.delete(resultCacheKey);
      this.scheduleStremioBackgroundRefresh(input);
    }, Math.max(250, runAt - Date.now()));
    timeout.unref?.();
    this.stremioDelayedRefreshTimers.set(resultCacheKey, { timeout, runAt });
  }

  runStremioBackgroundRefreshQueue() {
    this.pruneStaleStremioBackgroundRefreshQueue();

    if (this.shouldSkipBackgroundRefresh()) {
      if (this.stremioBackgroundRefreshQueue.length > 0) {
        this.scheduleStremioBackgroundRefreshWake(this.isLoadShedding() ? 2_500 : 1_000);
      }
      return;
    }

    while (
      this.activeStremioBackgroundRefreshes < config.STREMIO_BACKGROUND_REFRESH_CONCURRENCY &&
      this.stremioBackgroundRefreshQueue.length > 0
    ) {
      if (this.shouldSkipBackgroundRefresh()) {
        this.scheduleStremioBackgroundRefreshWake(this.isLoadShedding() ? 2_500 : 1_000);
        break;
      }

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

    const waitForSharedRequest = (request) => {
      if (!signal) {
        return request.then((streams) => copyObjects(streams));
      }

      allowHighFanoutAbortSignal(signal);

      if (signal.aborted) {
        return Promise.resolve([]);
      }

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          resolve([]);
        };

        signal.addEventListener('abort', onAbort, { once: true });
        request.then(
          (streams) => {
            cleanup();
            resolve(copyObjects(streams));
          },
          (error) => {
            cleanup();
            reject(error);
          }
        );
      });
    };

    const existingRequest = this.stremioResultInFlight.get(resultCacheKey);

    if (existingRequest) {
      return waitForSharedRequest(existingRequest);
    }

    const getQueuedFallbackStreams = async (reason) => {
      const lastGoodStreams = await this.getLastGoodStremioStreams(resultCacheKey);

      if (Array.isArray(lastGoodStreams) && lastGoodStreams.length > 0) {
        logger.warn('serving last-good streams while stream search is saturated', {
          reason,
          resultCount: lastGoodStreams.length,
          tmdbId,
          mediaType: parsed.mediaType
        });
        return copyObjects(lastGoodStreams);
      }

      const staleResult = await this.getCachedStremioStreams(resultCacheKey, { allowStale: true });

      if (Array.isArray(staleResult?.streams) && staleResult.streams.length > 0) {
        logger.warn('serving stale streams while stream search is saturated', {
          reason,
          resultCount: staleResult.streams.length,
          tmdbId,
          mediaType: parsed.mediaType
        });
        return copyObjects(staleResult.streams);
      }

      return null;
    };

    if (this.isLoadShedding()) {
      logger.warn('stremio stream search rejected due to load shedding', {
        loadSheddingUntil: new Date(this.loadSheddingUntil).toISOString(),
        reason: this.loadSheddingReason,
        tmdbId,
        mediaType: parsed.mediaType
      });
      const fallbackStreams = await getQueuedFallbackStreams('load-shedding');
      if (fallbackStreams) {
        return fallbackStreams;
      }
      return [];
    }

    const heapPressurePercent = getProcessHeapPressurePercent();
    if (heapPressurePercent >= config.MEMORY_GUARD_PRESSURE_PERCENT) {
      const critical = heapPressurePercent >= config.MEMORY_GUARD_CRITICAL_PERCENT;
      this.handleMemoryPressure({ critical });
      this.enableLoadShedding({
        durationMs: config.MEMORY_GUARD_SHED_SECONDS * 1000,
        reason: critical ? 'stream-heap-critical' : 'stream-heap-pressure'
      });
      logger.warn('stremio stream search rejected due to heap pressure', {
        heapPressurePercent: Number(heapPressurePercent.toFixed(1)),
        pressurePercent: config.MEMORY_GUARD_PRESSURE_PERCENT,
        criticalPercent: config.MEMORY_GUARD_CRITICAL_PERCENT,
        critical,
        tmdbId,
        mediaType: parsed.mediaType
      });
      const fallbackStreams = await getQueuedFallbackStreams('heap-pressure');
      if (fallbackStreams) {
        return fallbackStreams;
      }
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
        return waitForSharedRequest(inFlightRequest);
      }

      if (!slotAvailable) {
        logger.warn('stremio stream search rejected due to in-flight limit', {
          inFlightSearches: this.stremioResultInFlight.size,
          maxInFlightSearches: config.STREMIO_MAX_INFLIGHT_SEARCHES,
          waitMs: config.STREMIO_INFLIGHT_SLOT_WAIT_MS,
          tmdbId,
          mediaType: parsed.mediaType
        });
        const fallbackStreams = await getQueuedFallbackStreams('in-flight-limit');
        if (fallbackStreams) {
          return fallbackStreams;
        }
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
      const fallbackStreams = await getQueuedFallbackStreams('in-flight-limit-after-wait');
      if (fallbackStreams) {
        return fallbackStreams;
      }
      return [];
    }

    const requestAbortController = new AbortController();
    allowHighFanoutAbortSignal(requestAbortController.signal);
    const hardCleanupMs = Math.max(60_000, config.STREMIO_STREAM_OVERALL_TIMEOUT_MS + 45_000);
    const hardCleanupTimer = setTimeout(() => {
      requestAbortController.abort(createHttpError(499, 'Stremio shared build cleanup timeout'));
    }, hardCleanupMs);
    hardCleanupTimer.unref?.();

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
    }).catch(async (error) => {
      logger.warn('stremio shared build failed; serving fallback', {
        tmdbId,
        mediaType: parsed.mediaType,
        error: error?.message || String(error)
      });
      const fallbackStreams = await getQueuedFallbackStreams('shared-build-error');
      return fallbackStreams || [];
    });
    request.startedAt = Date.now();
    request.controller = requestAbortController;

    this.stremioResultInFlight.set(resultCacheKey, request);
    request
      .finally(() => {
        clearTimeout(hardCleanupTimer);
        this.stremioResultInFlight.delete(resultCacheKey);
      })
      .catch(() => {});

    return waitForSharedRequest(request);
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
        this.scheduleDelayedStremioBackgroundRefresh(refreshInput, 8_000);
      }

      if (cacheResult && shouldCacheEmptyFastResult(result) && !streamOptions.torboxOnlyStreams) {
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
    normalizedStreams = await filterTorBoxCachedTorrentStreams(normalizedStreams, privateProviderSettings, streamOptions);
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

    if (parsed.mediaType === 'series' && configuredStreams.length > 0) {
      let expectedTitle = null;
      try {
        const metadata = await this.providerService.getTmdbMetadata({ tmdbId, mediaType: 'tv' });
        expectedTitle = metadata?.name || metadata?.title || null;
      } catch (error) {
        logger.warn('stremio tv title guard metadata lookup failed', {
          tmdbId,
          season: parsed.season,
          episode: parsed.episode,
          error: error?.message || error
        });
      }

      const guardedStreams = filterMismatchedHubTvStreams(configuredStreams, {
        expectedTitle,
        season: parsed.season,
        episode: parsed.episode
      });

      if (guardedStreams.length !== configuredStreams.length) {
        logger.warn('stremio tv title guard dropped mismatched hub streams', {
          tmdbId,
          season: parsed.season,
          episode: parsed.episode,
          droppedCount: configuredStreams.length - guardedStreams.length,
          resultCount: guardedStreams.length
        });
        configuredStreams = guardedStreams;
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
      if (cacheResult && shouldCacheEmptyFastResult(result) && !streamOptions.torboxOnlyStreams) {
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
    const playbackSettled = await Promise.allSettled(dedupedStreams.map(async (stream) => {
      if (stream?.torboxTorrent && privateProviderSettings?.torboxApiKey) {
        try {
          const streamUrl = this.createTorBoxTorrentStreamUrl(baseUrl, {
            magnet: stream.torboxMagnet || stream.magnet || stream.torrent || stream.url,
            apiKey: privateProviderSettings.torboxApiKey,
            filename: stream.filename || stream.fileName || stream.title,
            fileIndex: stream.fileIdx,
            provider: stream.provider
          });

          return {
            ...stream,
            url: streamUrl.toString(),
            magnet: null,
            torrent: null,
            transport: 'http',
            headers: null,
            sourceSite: stream.sourceSite || 'TorBox Torrent',
            behaviorHints: {
              ...stream.behaviorHints,
              notWebReady: false
            }
          };
        } catch (error) {
          logger.warn('failed to create torbox torrent stream url', {
            provider: stream.provider,
            infoHash: stream.torboxInfoHash,
            error
          });
          return stream;
        }
      }

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
    const playbackStreams = playbackSettled
      .map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }

        logger.warn('stremio playback stream preparation failed', {
          provider: dedupedStreams[index]?.provider,
          error: result.reason?.message || String(result.reason)
        });
        return dedupedStreams[index];
      })
      .filter(Boolean);
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

      this.scheduleDelayedStremioBackgroundRefresh(refreshInput, 8_000);
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
        res.end();
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
        res.end();
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

  createTorBoxTorrentStreamUrl(baseUrl, {
    magnet,
    apiKey,
    filename = null,
    fileIndex = null,
    provider = null
  } = {}) {
    const normalizedMagnet = enhanceMagnet(magnet);
    const normalizedApiKey = normalizePrivateCookie(apiKey);
    const infoHash = extractInfoHash(normalizedMagnet);

    if (!normalizedApiKey) {
      throw createHttpError(400, 'TorBox API key is required');
    }

    if (!infoHash) {
      throw createHttpError(400, 'Invalid torrent magnet');
    }

    const token = encryptSourceTokenPayload(JSON.stringify({
      version: SOURCE_TOKEN_VERSION,
      expiresAt: Date.now() + (90 * 60 * 1000),
      source: normalizedMagnet,
      infoHash,
      apiKey: normalizedApiKey,
      filename: filename ? String(filename).slice(0, 180) : null,
      fileIndex: Number.isInteger(Number(fileIndex)) ? Number(fileIndex) : null,
      provider: provider ? String(provider).slice(0, 80) : null
    }));

    const streamUrl = new URL('/torbox/torrent', baseUrl);
    streamUrl.searchParams.set('token', token);
    return streamUrl;
  }

  decodeTorBoxToken(token) {
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

    const rawSource = String(parsed.source || '').trim();
    return {
      source: rawSource.startsWith('magnet:') ? rawSource : this.normalizeHttpSource(rawSource),
      magnet: rawSource.startsWith('magnet:') ? enhanceMagnet(rawSource) : null,
      infoHash: parsed.infoHash ? String(parsed.infoHash).trim().toLowerCase() : extractInfoHash(rawSource),
      apiKey: normalizePrivateCookie(parsed.apiKey),
      filename: parsed.filename ? String(parsed.filename).slice(0, 180) : null,
      fileIndex: Number.isInteger(Number(parsed.fileIndex)) ? Number(parsed.fileIndex) : null
    };
  }

  async handleTorBoxWebDownload(req, res, next) {
    try {
      const payload = this.decodeTorBoxToken(req.query.token);
      const form = new FormData();
      form.set('link', payload.source);
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
        const detail = String(createPayload?.detail || createPayload?.error || 'TorBox web download failed');
        const unsupported = /not supported|unsupported|not allowed/iu.test(detail);
        throw createHttpError(unsupported ? 422 : (createResponse.status || 502), detail);
      }

      const webId = extractTorBoxWebDownloadId(createPayload);
      if (!webId) {
        const detail = String(createPayload?.detail || createPayload?.error || 'TorBox did not return a web download id');
        const unsupported = /not supported|unsupported|not allowed/iu.test(detail);
        throw createHttpError(unsupported ? 422 : 502, detail);
      }

      let fileId = null;
      let ready = false;
      let lastListPayload = null;
      const readyTimeoutMs = Math.max(5_000, Number(process.env.TORBOX_WEBDL_READY_TIMEOUT_MS || 25_000));
      const deadline = Date.now() + readyTimeoutMs;

      do {
        try {
          const listUrl = new URL('https://api.torbox.app/v1/api/webdl/mylist');
          listUrl.searchParams.set('id', String(webId));
          listUrl.searchParams.set('bypass_cache', 'true');
          const listResponse = await fetch(listUrl, {
            headers: {
              authorization: `Bearer ${payload.apiKey}`,
              accept: 'application/json'
            },
            signal: AbortSignal.timeout(10_000)
          });
          lastListPayload = await listResponse.json().catch(() => ({}));
          const data = getTorBoxPayloadData(lastListPayload);
          if (data?.error) {
            throw createHttpError(502, data.error);
          }
          fileId = findTorBoxVideoFileId(lastListPayload);
          ready = isTorBoxWebDownloadReady(lastListPayload) || fileId !== null;
          if (ready) break;
        } catch (error) {
          logger.info('torbox webdl file lookup failed', {
            webId,
            error: error?.message || String(error)
          });
          break;
        }

        await delay(2_000);
      } while (Date.now() < deadline);

      if (!ready) {
        const state = String(getTorBoxPayloadData(lastListPayload)?.download_state || 'preparing');
        throw createHttpError(425, `TorBox web download is ${state}; try again soon`);
      }

      const requestUrl = new URL('https://api.torbox.app/v1/api/webdl/requestdl');
      requestUrl.searchParams.set('token', payload.apiKey);
      requestUrl.searchParams.set('web_id', String(webId));
      if (fileId !== null) requestUrl.searchParams.set('file_id', String(fileId));
      else requestUrl.searchParams.set('zip_link', 'true');
      requestUrl.searchParams.set('redirect', 'false');
      requestUrl.searchParams.set('append_name', 'true');

      const requestResponse = await fetch(requestUrl, {
        headers: {
          accept: 'application/json'
        },
        signal: AbortSignal.timeout(15_000)
      });
      const requestPayload = await requestResponse.json().catch(() => ({}));
      const downloadUrl = extractTorBoxRequestDownloadUrl(requestPayload);

      if (!requestResponse.ok) {
        throw createHttpError(requestResponse.status || 502, requestPayload?.detail || 'TorBox download link request failed');
      }

      if (!downloadUrl) {
        throw createHttpError(425, requestPayload?.detail || 'TorBox download link is not ready');
      }

      res.redirect(302, downloadUrl);
    } catch (error) {
      next(error);
    }
  }

  async handleTorBoxTorrentDownload(req, res, next) {
    try {
      const payload = this.decodeTorBoxToken(req.query.token);
      const magnet = payload.magnet || enhanceMagnet(payload.source);
      const infoHash = payload.infoHash || extractInfoHash(magnet);

      if (!infoHash) {
        throw createHttpError(400, 'Invalid torrent magnet');
      }

      const createForm = new FormData();
      createForm.set('magnet', magnet);
      createForm.set('allow_zip', 'false');
      createForm.set('add_only_if_cached', 'true');
      if (payload.filename) {
        createForm.set('name', payload.filename);
      }

      const createResponse = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${payload.apiKey}`,
          accept: 'application/json'
        },
        body: createForm,
        signal: AbortSignal.timeout(15_000)
      });
      const createPayload = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok && createResponse.status !== 409) {
        throw createHttpError(createResponse.status || 502, createPayload?.detail || 'TorBox torrent create failed');
      }

      let torrentId = extractTorBoxTorrentId(createPayload);
      let torrentPayload = null;

      if (torrentId) {
        const listUrl = new URL('https://api.torbox.app/v1/api/torrents/mylist');
        listUrl.searchParams.set('id', String(torrentId));
        listUrl.searchParams.set('bypass_cache', 'true');
        const listResponse = await fetch(listUrl, {
          headers: {
            authorization: `Bearer ${payload.apiKey}`,
            accept: 'application/json'
          },
          signal: AbortSignal.timeout(10_000)
        });
        torrentPayload = await listResponse.json().catch(() => ({}));
      } else {
        const listUrl = new URL('https://api.torbox.app/v1/api/torrents/mylist');
        listUrl.searchParams.set('bypass_cache', 'true');
        const listResponse = await fetch(listUrl, {
          headers: {
            authorization: `Bearer ${payload.apiKey}`,
            accept: 'application/json'
          },
          signal: AbortSignal.timeout(10_000)
        });
        const listPayload = await listResponse.json().catch(() => ({}));
        const torrents = Array.isArray(listPayload?.data) ? listPayload.data : [];
        const found = torrents.find((torrent) =>
          String(torrent?.hash || torrent?.info_hash || '').toLowerCase() === infoHash.toLowerCase()
        );
        if (found) {
          torrentId = Number(found.id);
          torrentPayload = { data: found };
        }
      }

      const torrentData = getTorBoxPayloadData(torrentPayload);
      if (!torrentId || !torrentData) {
        throw createHttpError(425, 'TorBox cached torrent is not ready');
      }

      if (!isTorBoxWebDownloadReady(torrentPayload)) {
        throw createHttpError(425, `TorBox torrent is ${String(torrentData.download_state || 'preparing')}; try again soon`);
      }

      const targetFile = pickTorBoxVideoFile(getTorBoxFileList(torrentPayload), payload.fileIndex, payload.filename);
      const fileId = Number(targetFile?.id ?? targetFile?.file_id);
      if (!Number.isInteger(fileId) || fileId < 0) {
        throw createHttpError(404, 'No playable TorBox video file found');
      }

      const requestUrl = new URL('https://api.torbox.app/v1/api/torrents/requestdl');
      requestUrl.searchParams.set('token', payload.apiKey);
      requestUrl.searchParams.set('torrent_id', String(torrentId));
      requestUrl.searchParams.set('file_id', String(fileId));
      requestUrl.searchParams.set('redirect', 'false');
      requestUrl.searchParams.set('append_name', 'true');
      const requestResponse = await fetch(requestUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000)
      });
      const requestPayload = await requestResponse.json().catch(() => ({}));
      const downloadUrl = extractTorBoxRequestDownloadUrl(requestPayload);
      if (!requestResponse.ok) {
        throw createHttpError(requestResponse.status || 502, requestPayload?.detail || 'TorBox torrent download link request failed');
      }
      if (!downloadUrl) {
        throw createHttpError(425, requestPayload?.detail || 'TorBox torrent download link is not ready');
      }

      res.redirect(302, downloadUrl);
    } catch (error) {
      next(error);
    }
  }

  async handleCreatePrivateConfig(req, res, next) {
    try {
      let supporter = null;
      const supporterCode = String(req.body?.supporterCode || '').trim();
      if (supporterCode) {
        const validation = await this.supporterService?.validateCode(supporterCode, { touch: true });
        if (!validation?.valid) {
          throw createHttpError(401, validation?.message || 'Invalid supporter code');
        }
        supporter = validation.supporter;
      }
      const { configId, manifestPath } = await this.createPrivateConfig({
        providers: req.body?.providers,
        qualityPriority: req.body?.qualityPriority,
        streamOptions: req.body?.streamOptions,
        privateProviderSettings: req.body?.privateProviderSettings,
        supporter,
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

  async handleValidateIptvConfig(req, res, next) {
    try {
      const settings = normalizePrivateProviderSettings(req.body?.privateProviderSettings || req.body || {});
      const xtreamCredentials = {
        serverUrl: settings.xtreamServerUrl,
        username: settings.xtreamUsername,
        password: settings.xtreamPassword
      };
      const stalkerCredentials = {
        portalUrl: settings.stalkerPortalUrl,
        macAddress: settings.stalkerMacAddress,
        stbType: settings.stalkerStbType,
        serialNumber: settings.stalkerSerialNumber,
        deviceId: settings.stalkerDeviceId,
        deviceId2: settings.stalkerDeviceId2
      };
      const result = {
        xtream: { configured: hasXtreamCredentials(xtreamCredentials), valid: false, message: 'Not configured' },
        stalker: { configured: hasStalkerCredentials(stalkerCredentials), valid: false, message: 'Not configured' }
      };

      if (result.xtream.configured) {
        try {
          await this.xtreamCodesAdapter.authenticate(xtreamCredentials, AbortSignal.timeout(10_000));
          const [live, vod, series] = await Promise.all([
            this.xtreamCodesAdapter.getCategories(xtreamCredentials, 'live', AbortSignal.timeout(10_000)).catch(() => []),
            this.xtreamCodesAdapter.getCategories(xtreamCredentials, 'vod', AbortSignal.timeout(10_000)).catch(() => []),
            this.xtreamCodesAdapter.getCategories(xtreamCredentials, 'series', AbortSignal.timeout(10_000)).catch(() => [])
          ]);
          result.xtream = {
            configured: true,
            valid: true,
            message: 'Valid',
            categories: {
              live: live.length,
              vod: vod.length,
              series: series.length
            }
          };
        } catch (error) {
          result.xtream = {
            configured: true,
            valid: false,
            message: error?.message || 'Xtream validation failed'
          };
        }
      }

      if (result.stalker.configured) {
        try {
          await this.stalkerPortalAdapter.authenticate(stalkerCredentials, AbortSignal.timeout(12_000));
          const categories = await this.stalkerPortalAdapter.getCategories(stalkerCredentials, AbortSignal.timeout(12_000));
          result.stalker = {
            configured: true,
            valid: true,
            message: 'Valid',
            categories: {
              live: categories.length
            }
          };
        } catch (error) {
          result.stalker = {
            configured: true,
            valid: false,
            message: error?.message || 'Stalker validation failed'
          };
        }
      }

      res
        .setHeader('Cache-Control', 'no-store')
        .json(result);
    } catch (error) {
      next(error);
    }
  }

  async handleXtreamStream(req, res, next) {
    try {
      const credentials = this.getRequestedXtreamCredentials(req);
      if (!hasXtreamCredentials(credentials)) {
        throw createHttpError(404, 'Xtream config not found');
      }

      const kind = String(req.params.kind || '').trim().toLowerCase();
      if (!['live', 'movie', 'series'].includes(kind)) {
        throw createHttpError(400, 'Invalid Xtream stream kind');
      }

      const upstreamUrl = this.xtreamCodesAdapter.getUpstreamStreamUrl(
        credentials,
        kind,
        req.params.streamId,
        req.params.extension || (kind === 'live' ? 'm3u8' : 'mp4')
      );

      res
        .status(302)
        .setHeader('Cache-Control', 'no-store')
        .setHeader('Location', upstreamUrl)
        .end();
    } catch (error) {
      logger.warn('xtream playback redirect failed', {
        kind: req.params.kind,
        streamId: req.params.streamId,
        error: error?.message || String(error)
      });
      next(error);
    }
  }

  async handleStalkerStream(req, res, next) {
    try {
      const credentials = this.getRequestedStalkerCredentials(req);
      if (!hasStalkerCredentials(credentials)) {
        throw createHttpError(404, 'Stalker config not found');
      }

      if (String(req.method || 'GET').toUpperCase() === 'HEAD') {
        res
          .status(200)
          .setHeader('Cache-Control', 'no-store')
          .setHeader('Content-Type', 'video/mp2t')
          .setHeader('Accept-Ranges', 'none')
          .end();
        return;
      }

      const upstreamUrls = await this.stalkerPortalAdapter.createLinkCandidates(
        credentials,
        req.params.channelId,
        req.signal || null
      );

      await this.proxyStalkerUpstream({
        req,
        res,
        credentials,
        channelId: req.params.channelId,
        upstreamUrls,
        fallbackToRedirect: true
      });
    } catch (error) {
      logger.warn('stalker playback redirect failed', {
        channelId: req.params.channelId,
        error: error?.message || String(error)
      });
      next(error);
    }
  }

  async handleStalkerProxyStream(req, res, next) {
    try {
      const credentials = this.getRequestedStalkerCredentials(req);
      if (!hasStalkerCredentials(credentials)) {
        throw createHttpError(404, 'Stalker config not found');
      }

      const upstreamUrl = Buffer.from(String(req.query.url || ''), 'base64url').toString('utf8');
      if (!/^https?:\/\//iu.test(upstreamUrl)) {
        throw createHttpError(400, 'Invalid Stalker proxy URL');
      }

      await this.proxyStalkerUpstream({
        req,
        res,
        credentials,
        channelId: req.params.channelId,
        upstreamUrls: [upstreamUrl]
      });
    } catch (error) {
      logger.warn('stalker playback proxy failed', {
        channelId: req.params.channelId,
        error: error?.message || String(error)
      });
      next(error);
    }
  }

  async proxyStalkerUpstream({ req, res, credentials, channelId, upstreamUrls, fallbackToRedirect = false }) {
    const headers = await this.stalkerPortalAdapter.getPlaybackHeaders(credentials, req.signal || null);
    const requestHeaders = {
      ...headers,
      ...(req.headers.range ? { Range: req.headers.range } : {})
    };
    let response = null;
    let selectedUrl = '';
    let fallbackUrl = '';
    let lastError = null;

    for (const upstreamUrl of Array.isArray(upstreamUrls) ? upstreamUrls : []) {
      fallbackUrl = upstreamUrl;
      try {
        const candidateResponse = await fetch(upstreamUrl, {
          headers: requestHeaders,
          redirect: 'follow',
          signal: req.signal || null
        });
        if (candidateResponse.ok) {
          response = candidateResponse;
          selectedUrl = upstreamUrl;
          break;
        }
        lastError = createHttpError(candidateResponse.status, `Stalker upstream HTTP ${candidateResponse.status}`);
        await candidateResponse.body?.cancel?.().catch?.(() => {});
      } catch (error) {
        lastError = error;
      }
    }

    if (!response) {
      if (fallbackToRedirect && fallbackUrl && !res.headersSent) {
        logger.warn('stalker proxy failed; falling back to direct upstream redirect', {
          channelId,
          error: lastError?.message || String(lastError || 'unknown')
        });
        res
          .status(302)
          .setHeader('Cache-Control', 'no-store')
          .setHeader('Location', fallbackUrl)
          .end();
        return;
      }
      throw lastError || createHttpError(502, 'Stalker upstream unavailable');
    }

    if (!response.ok) {
      throw createHttpError(response.status, `Stalker upstream HTTP ${response.status}`);
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const finalUrl = response.url || selectedUrl;
    const isPlaylist = contentType.includes('mpegurl') || contentType.includes('m3u8') || /\.m3u8(?:$|[?#])/iu.test(finalUrl);

    if (isPlaylist) {
      const text = await response.text();
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      res
        .status(200)
        .setHeader('Cache-Control', 'no-store')
        .setHeader('Content-Type', 'application/vnd.apple.mpegurl')
        .send(this.rewriteStalkerPlaylist(text, finalUrl, baseUrl, req.params.privateConfigId, channelId));
      return;
    }

    res.status(response.status);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp2t');
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    const contentRange = response.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    const acceptRanges = response.headers.get('accept-ranges');
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

    await pipeline(response.body, res);
  }

  rewriteStalkerPlaylist(text, playlistUrl, baseUrl, privateConfigId, channelId) {
    return String(text || '').split(/\r?\n/u).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return line;
      }

      let absoluteUrl;
      try {
        absoluteUrl = new URL(trimmed, playlistUrl).toString();
      } catch {
        return line;
      }

      const encodedUrl = Buffer.from(absoluteUrl).toString('base64url');
      return `${String(baseUrl || '').replace(/\/+$/u, '')}/private/${encodeURIComponent(privateConfigId)}/stalker/proxy/${encodeURIComponent(String(channelId))}?url=${encodedUrl}`;
    }).join('\n');
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

      if (catalogId.startsWith('xtream-')) {
        const credentials = this.getRequestedXtreamCredentials(req);
        if (!hasXtreamCredentials(credentials)) {
          res.json({ metas: [] });
          return;
        }

        const catalogType = catalogId.startsWith('xtream-live-')
          ? 'tv'
          : catalogId.startsWith('xtream-vod-')
            ? 'movie'
            : catalogId.startsWith('xtream-series-')
              ? 'series'
              : null;

        if (!catalogType || type !== catalogType) {
          res.json({ metas: [] });
          return;
        }

        const search = String(req.query.search || req.params.search || '').trim();
        const skip = Number.parseInt(req.query.skip || '0', 10);
        const metas = await this.xtreamCodesAdapter.getCatalog({
          credentials,
          catalogId,
          search,
          skip: Number.isInteger(skip) && skip > 0 ? skip : 0,
          signal: req.signal || null
        });

        res
          .setHeader('Cache-Control', 'private, max-age=120')
          .json({ metas });
        return;
      }

      if (catalogId.startsWith('stalker-live-')) {
        const credentials = this.getRequestedStalkerCredentials(req);
        if (!hasStalkerCredentials(credentials) || type !== 'tv') {
          res.json({ metas: [] });
          return;
        }

        const search = String(req.query.search || req.params.search || '').trim();
        const skip = Number.parseInt(req.query.skip || '0', 10);
        const metas = await this.stalkerPortalAdapter.getCatalog({
          credentials,
          catalogId,
          search,
          skip: Number.isInteger(skip) && skip > 0 ? skip : 0,
          signal: req.signal || null
        });

        res
          .setHeader('Cache-Control', 'private, max-age=120')
          .json({ metas });
        return;
      }

      if (catalogId.startsWith('famelack-live-')) {
        const famelackEnabled = Boolean(this.getRequestedPrivateProviderSettings(req).famelackLiveEnabled);
        if (!famelackEnabled || type !== 'tv') {
          res.json({ metas: [] });
          return;
        }

        const countries = await this.famelackLiveAdapter.getTopCountries(40, req.signal || null);
        const catalog = this.famelackLiveAdapter.getLiveCatalogDefinitions(countries)
          .find((definition) => definition.id === catalogId);
        if (!catalog) {
          res.json({ metas: [] });
          return;
        }

        const search = String(req.query.search || req.params.search || '').trim();
        if (search && search.length < 3) {
          res
            .setHeader('Cache-Control', 'public, max-age=30')
            .json({ metas: [] });
          return;
        }
        const skip = Number.parseInt(req.query.skip || '0', 10);
        const metas = await this.famelackLiveAdapter.getLiveCatalog({
          catalog,
          search,
          skip: Number.isInteger(skip) && skip > 0 ? skip : 0,
          signal: req.signal || null
        });

        res
          .setHeader('Cache-Control', 'public, max-age=120')
          .json({ metas });
        return;
      }

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

      const search = String(req.query.search || req.params.search || '').trim().toLowerCase();
      if (search) {
        if (search.length < 3) {
          res
            .setHeader('Cache-Control', 'public, max-age=30')
            .json({ metas: [] });
          return;
        }

        const channels = typeof liveAdapter.loadLiveChannels === 'function'
          ? await liveAdapter.loadLiveChannels()
          : [];
        const metas = channels
          .filter((channel) => !catalog.source || channel.source === catalog.source)
          .filter((channel) => catalog.source || catalog.category === 'all' || channel.category === catalog.category)
          .filter((channel) => String(channel.title || channel.name || '').toLowerCase().includes(search))
          .slice(0, 30)
          .map((channel) => liveAdapter.toLiveMeta(channel));

        res
          .setHeader('Cache-Control', 'public, max-age=60')
          .json({ metas });
        return;
      }

      const skip = Number.parseInt(req.query.skip || '0', 10);
      let metas = await liveAdapter.getLiveCatalog({
        category: catalog.category,
        source: catalog.source || null,
        skip: Number.isInteger(skip) && skip > 0 ? skip : 0
      });

      res.json({ metas });
    } catch (error) {
      next(error);
    }
  }

  async handleStremioMeta(req, res, next) {
    try {
      const type = String(req.params.type || '').trim().toLowerCase();
      const id = String(req.params.id || '').trim();

      if (id.startsWith('xtream:')) {
        const credentials = this.getRequestedXtreamCredentials(req);
        if (!hasXtreamCredentials(credentials)) {
          res.json({ meta: null });
          return;
        }

        const expectedType = this.xtreamCodesAdapter.inferTypeFromXtreamId(id);
        if (type !== expectedType) {
          res.json({ meta: null });
          return;
        }

        const meta = await this.xtreamCodesAdapter.getMeta(credentials, id, req.signal || null);
        res
          .setHeader('Cache-Control', 'private, max-age=120')
          .json({ meta });
        return;
      }

      if (id.startsWith('stalker:')) {
        const credentials = this.getRequestedStalkerCredentials(req);
        if (!hasStalkerCredentials(credentials) || type !== 'tv') {
          res.json({ meta: null });
          return;
        }

        const meta = await this.stalkerPortalAdapter.getMeta(credentials, id, req.signal || null);
        res
          .setHeader('Cache-Control', 'private, max-age=120')
          .json({ meta });
        return;
      }

      if (id.startsWith('famelack:')) {
        const famelackEnabled = Boolean(this.getRequestedPrivateProviderSettings(req).famelackLiveEnabled);
        if (!famelackEnabled || type !== 'tv') {
          res.json({ meta: null });
          return;
        }

        const meta = await this.famelackLiveAdapter.getLiveMeta(id, req.signal || null);
        res
          .setHeader('Cache-Control', 'public, max-age=120')
          .json({ meta });
        return;
      }

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

  isFamelackLiveStreamRequest(type, id) {
    const normalizedType = String(type || '').trim().toLowerCase();
    return (normalizedType === 'tv' || normalizedType === 'live' || normalizedType === 'channel')
      && String(id || '').startsWith('famelack:');
  }

  isXtreamStreamRequest(type, id) {
    const normalizedType = String(type || '').trim().toLowerCase();
    const value = String(id || '').trim();
    if (!value.startsWith('xtream:')) {
      return false;
    }
    if (value.startsWith('xtream:live:')) {
      return normalizedType === 'tv' || normalizedType === 'live' || normalizedType === 'channel';
    }
    if (value.startsWith('xtream:vod:')) {
      return normalizedType === 'movie';
    }
    return value.startsWith('xtream:episode:') && normalizedType === 'series';
  }

  isStalkerStreamRequest(type, id) {
    const normalizedType = String(type || '').trim().toLowerCase();
    return (normalizedType === 'tv' || normalizedType === 'live' || normalizedType === 'channel')
      && String(id || '').startsWith('stalker:live:');
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
        res.end();
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
      let normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);
      normalizedStreams = enableTorBoxDdlStreams(normalizedStreams, privateProviderSettings);
      normalizedStreams = await filterTorBoxCachedTorrentStreams(normalizedStreams, privateProviderSettings, streamOptions);
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
        res.end();
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

    if (this.hubCloudInFlight.size >= config.HUBCLOUD_MAX_INFLIGHT) {
      return [];
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
        const logHubCloudFailure = isExpectedHubCloudResolutionError(error)
          ? logger.info.bind(logger)
          : logger.warn.bind(logger);
        logHubCloudFailure('hubcloud resolution failed', {
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
    const settled = await Promise.allSettled(streams.flatMap((stream) => {
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

    return settled
      .flatMap((result) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }

        logger.warn('provider stream normalization failed', {
          error: result.reason?.message || String(result.reason)
        });
        return [];
      })
      .flat()
      .filter(Boolean);
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
