import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { promises as fsPromises } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setMaxListeners } from 'node:events';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createHttpError } from './streamManager.js';
import { PluginProviderRegistry } from '../src/registry/pluginProviderRegistry.js';
import { Agent } from 'undici';

const require = createRequire(import.meta.url);
const { mkdir, readFile, readdir, rm, writeFile } = fsPromises;
const execFileAsync = promisify(execFile);
const providerAbortSignalStorage = new AsyncLocalStorage();
const providerFetchContextStorage = new AsyncLocalStorage();
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const providerFetchHostInflight = new Map();
const PROVIDER_FETCH_MAX_RETRIES = 2;
const SIGNED_STREAM_CACHE_SAFETY_SECONDS = 60;
const MIN_SIGNED_STREAM_CACHE_TTL_SECONDS = 15;
const SIGNED_URL_EXPIRY_PARAM_NAMES = Object.freeze([
  'token',
  'KEY2',
  'expires',
  'expire',
  'exp'
]);
const PROVIDER_FETCH_DISPATCHER = new Agent({
  connect: { family: 4 }
});
const PROVIDER_FETCH_REQUEST_TIMEOUT_OVERRIDES_MS = Object.freeze({
  '4khdhub': 18_000,
  '4khdhub_tv': 18_000,
  cinestream: 60_000,
  hdhub4u: 18_000,
  showbox: 60_000,
  uhdmovies: 60_000
});
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
const PROVIDER_RESULT_CACHE_SCHEMA_VERSION = 3;
const PROVIDER_FETCH_HOST_MAX_INFLIGHT = 2;
const PROVIDER_FETCH_HOST_MAX_INFLIGHT_OVERRIDES = Object.freeze({
  'enc-dec.app': 1,
  'api.videasy.net': 2,
  'api2.videasy.net': 2,
  'cloudnestra.com': 2,
  'vixsrc.to': 2,
  'vsembed.ru': 2,
  'vsembed.su': 2,
  'vidsrcme.ru': 2,
  'vidsrcme.su': 2,
  'vidsrc-me.ru': 2,
  'vidsrc-me.su': 2,
  'hubcloud.dad': 2,
  'hubdrive.dad': 2,
  'hubcdn.fans': 2,
  'player.vidzee.wtf': 2,
  'core.vidzee.wtf': 1,
  'frembed.cyou': 2,
  'search.pingora.fyi': 2
});
const getPrivateProviderSettingsKey = (providerId, privateProviderSettings = null) => {
  if (providerId === 'showbox') {
    const uiToken = String(privateProviderSettings?.febboxUiCookie || '').trim();

    if (!uiToken) {
      return '';
    }

    return crypto.createHash('sha1').update(uiToken).digest('hex');
  }

  return '';
};

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

const getProviderResultCacheTtlSeconds = (streams, providerId = null) => {
  if (providerId === 'showbox') {
    return Array.isArray(streams) && streams.length > 0 ? 120 : config.PROVIDER_EMPTY_CACHE_TTL_SECONDS;
  }

  if (!Array.isArray(streams) || streams.length === 0) {
    return PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId)
      ? config.PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS
      : config.PROVIDER_EMPTY_CACHE_TTL_SECONDS;
  }

  const now = Date.now();
  return streams.reduce((ttlSeconds, stream) => {
    const signedTtl = getSignedUrlExpiryTtlSeconds(stream?.url, now);
    return signedTtl === null ? ttlSeconds : Math.min(ttlSeconds, signedTtl);
  }, config.PROVIDER_CACHE_TTL_SECONDS);
};

const getProviderCacheVersion = (providerId) => {
  if (providerId === '4khdhub' || providerId === '4khdhub_tv') {
    return '50';
  }

  if (providerId === 'rgshows') {
    return '24';
  }

  if (providerId === 'moviesmod') {
    return '25';
  }

  if (providerId === 'vixsrc') {
    return '28';
  }

  if (providerId === 'vidsrc') {
    return '27';
  }

  if (providerId === 'animekai') {
    return '24';
  }

  if (providerId === 'animepahe') {
    return '24';
  }

  if (providerId === 'dahmermovies-4k') {
    return '24';
  }

  if (providerId === 'multivid') {
    return '24';
  }

  if (providerId === 'nakios') {
    return '24';
  }

  if (providerId === 'playimdb') {
    return '25';
  }

  if (providerId === 'playimdb_v2') {
    return '25';
  }

  if (providerId === 'toflix') {
    return '24';
  }

  if (providerId === 'vidzee') {
    return '24';
  }

  if (providerId === 'frembed') {
    return '24';
  }

  if (providerId === 'einschalten') {
    return '24';
  }

  if (providerId === 'filmpalast') {
    return '24';
  }

  if (providerId === 'hdhub4u') {
    return '42';
  }

  if (providerId === 'scrapling-hdhub4u') {
    return '2';
  }

  if (providerId === 'streamflix' || providerId === 'streamflix_eng') {
    return '24';
  }

  if (providerId === 'hdmovie2') {
    return '25';
  }

  if (providerId === 'kisskh') {
    return '32';
  }

  if (providerId === 'showbox') {
    return '57';
  }

  if (providerId === 'latino-lamovie') {
    return '32';
  }

  if (providerId === 'latino-cinecalidad') {
    return '31';
  }

  if (providerId === 'uhdmovies') {
    return '37';
  }

  if (providerId === 'cinestream') {
    return '35';
  }

  if (providerId === 'allyoucanwatch') {
    return '42';
  }

  if (providerId === 'fmovies') {
    return '24';
  }

  if (providerId === 'netmirror') {
    return '41';
  }

  if (providerId === 'moviebox') {
    return '24';
  }

  if (providerId === 'nuvio') {
    return '23';
  }

  if (providerId === 'nuvio-latino' || providerId === 'nuvio-french' || providerId === 'nuvio-italian' || providerId === 'nuvio-2') {
    return '2';
  }

  if (providerId.startsWith('fr-')) {
    return '2';
  }

  if (providerId.startsWith('cs-')) {
    return '3';
  }

  if (providerId === 'rogplay-vod') {
    return '2';
  }

  if (providerId === 'r2-plugin') {
    return '6';
  }

  if (providerId === 'r3-plugin') {
    return '2';
  }

  if (providerId === 'r4-asian-drama-movies') {
    return '2';
  }

  if (providerId === 'scrapling-4khdhub') {
    return '4';
  }

  return '23';
};

const normalizeProviderMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();
  if (normalized === 'series' || normalized === 'tv') return 'tv';
  return 'movie';
};

const hasShowboxCredential = (privateProviderSettings = null) => Boolean(
  String(privateProviderSettings?.febboxUiCookie || '').trim()
  || String(process.env.SHOWBOX_UI_TOKEN || process.env.SHOWBOX_COOKIE || '').trim()
);

const prioritizePrivateTokenProviders = (providers, privateProviderSettings = null) => {
  const ordered = Array.isArray(providers) ? [...providers] : [];

  if (hasShowboxCredential(privateProviderSettings) && ordered.includes('showbox')) {
    ordered.splice(ordered.indexOf('showbox'), 1);
    ordered.unshift('showbox');
  }

  return ordered;
};

const getPrivateProviderPriorityBoost = (providerId, privateProviderSettings = null) => {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();

  if (
    normalizedProviderId === 'showbox' &&
    hasShowboxCredential(privateProviderSettings)
  ) {
    return 180;
  }

  return 0;
};

const normalizeFetchUrl = (input) => {
  try {
    if (typeof input === 'string') {
      return new URL(input);
    }

    if (input instanceof URL) {
      return input;
    }

    if (input && typeof input.url === 'string') {
      return new URL(input.url);
    }
  } catch {
    return null;
  }

  return null;
};

const getFetchHostKey = (url) => {
  const hostname = String(url?.hostname || '').trim().toLowerCase();

  if (!hostname) {
    return 'default';
  }

  if (hostname.endsWith('.cloudnestra.com')) {
    return 'cloudnestra.com';
  }

  return hostname;
};

const getProviderFetchHostMaxInflight = (hostKey) =>
  PROVIDER_FETCH_HOST_MAX_INFLIGHT_OVERRIDES[hostKey] || PROVIDER_FETCH_HOST_MAX_INFLIGHT;

const withProviderFetchHostSlot = async (hostKey, fn, signal = null) => {
  const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';
  const maxInflight = getProviderFetchHostMaxInflight(normalizedHostKey);

  while ((providerFetchHostInflight.get(normalizedHostKey) || 0) >= maxInflight) {
    await waitForProviderSlot(50, signal);
  }

  if (signal?.aborted) {
    throw getAbortReason(signal, 'Provider fetch aborted');
  }

  providerFetchHostInflight.set(
    normalizedHostKey,
    (providerFetchHostInflight.get(normalizedHostKey) || 0) + 1
  );

  try {
    return await fn();
  } finally {
    const remaining = Math.max((providerFetchHostInflight.get(normalizedHostKey) || 1) - 1, 0);

    if (remaining === 0) {
      providerFetchHostInflight.delete(normalizedHostKey);
    } else {
      providerFetchHostInflight.set(normalizedHostKey, remaining);
    }
  }
};

const parseRetryAfterMs = (headers, attempt) => {
  const retryAfter = headers && typeof headers.get === 'function'
    ? headers.get('retry-after')
    : '';
  const retryAfterSeconds = Number.parseInt(String(retryAfter || '').trim(), 10);

  if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 5000);
  }

  return 250 * attempt;
};

const shouldRetryProviderFetch = (error, statusCode) => {
  if (statusCode === 429 || statusCode >= 500) {
    return true;
  }

  if (!error) {
    return false;
  }

  return /fetch failed|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|aborted|Connection reset/i
    .test(String(error.message || error));
};

const isRetryableProviderFetchMethod = (method, init = {}) => {
  const normalizedMethod = String(method || init?.method || 'GET').trim().toUpperCase();

  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
    return true;
  }

  if (normalizedMethod === 'POST') {
    return typeof init?.body === 'string' || init?.body === undefined || init?.body === null;
  }

  return false;
};

const applyDefaultFetchHeaders = (input, init = {}) => {
  const nextInit = init && typeof init === 'object' ? { ...init } : {};
  const headers = new Headers(nextInit.headers || (input instanceof Request ? input.headers : undefined));

  if (!headers.has('Accept-Encoding')) {
    headers.set('Accept-Encoding', 'identity');
  }

  nextInit.headers = headers;
  return nextInit;
};

if (nativeFetch && !globalThis.fetch.__nebulaProviderAbortWrapped) {
  const fetchWithProviderAbort = (input, init = {}) => {
    const providerSignal = providerAbortSignalStorage.getStore();
    const providerFetchContext = providerFetchContextStorage.getStore();
    const requestUrl = normalizeFetchUrl(input);
    const nextInit = applyDefaultFetchHeaders(input, init);

    if (!providerSignal && !providerFetchContext) {
      return nativeFetch(input, nextInit);
    }

    const providerTimeoutMs = providerFetchContext?.providerId
      ? (PROVIDER_FETCH_REQUEST_TIMEOUT_OVERRIDES_MS[String(providerFetchContext.providerId).trim().toLowerCase()] || config.PROVIDER_FETCH_REQUEST_TIMEOUT_MS)
      : config.PROVIDER_FETCH_REQUEST_TIMEOUT_MS;
    const timeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(providerTimeoutMs)
      : null;

    const signals = [nextInit.signal, providerSignal, timeoutSignal].filter(Boolean);

    if (signals.length > 1 && AbortSignal.any) {
      nextInit.signal = AbortSignal.any(signals);
    } else if (signals.length === 1) {
      nextInit.signal = signals[0];
    }

    if (!nextInit.dispatcher) {
      const host = requestUrl?.hostname || '';
      if (!host.includes('themoviedb.org') && !host.includes('tmdb.org')) {
        nextInit.dispatcher = PROVIDER_FETCH_DISPATCHER;
      }
    }

    if (!providerFetchContext || !requestUrl || !['http:', 'https:'].includes(requestUrl.protocol)) {
      return nativeFetch(input, nextInit);
    }

    const hostKey = getFetchHostKey(requestUrl);
    const method = String(nextInit.method || 'GET').trim().toUpperCase();
    const canRetry = isRetryableProviderFetchMethod(method, nextInit);
    let attempt = 0;

    const run = async () => withProviderFetchHostSlot(hostKey, async () => {
      try {
        const response = await nativeFetch(input, nextInit);

        if (canRetry && attempt < PROVIDER_FETCH_MAX_RETRIES && shouldRetryProviderFetch(null, response.status)) {
          attempt += 1;
          await waitForProviderSlot(parseRetryAfterMs(response.headers, attempt), nextInit.signal);
          return run();
        }

        return response;
      } catch (error) {
        if (canRetry && attempt < PROVIDER_FETCH_MAX_RETRIES && shouldRetryProviderFetch(error, 0)) {
          attempt += 1;
          await waitForProviderSlot(200 * attempt, nextInit.signal);
          return run();
        }

        throw error;
      }
    }, nextInit.signal);

    return run();
  };

  Object.defineProperty(fetchWithProviderAbort, '__nebulaProviderAbortWrapped', {
    value: true
  });
  globalThis.fetch = fetchWithProviderAbort;
}

const PROVIDERS_DIR = path.resolve(process.cwd(), 'vendor/HTTP/providers');
const LOCAL_PROVIDERS = Object.freeze({
  tamilian: {
    id: 'tamilian',
    label: 'Tamilian',
    modulePath: path.resolve(process.cwd(), 'providers/tamilian.cjs')
  },
  'torrent-scraper': {
    id: 'torrent-scraper',
    label: 'Torrent Scraper',
    modulePath: path.resolve(process.cwd(), 'providers/torrent-scraper.cjs'),
    runnerPath: path.resolve(process.cwd(), 'providers/torrent-scraper-runner.cjs'),
    invocation: 'subprocess'
  }
});
const FRENCH_NATIVE_PROVIDER_IDS = Object.freeze([
  'fr-frenchstream',
  'fr-movix',
  'fr-dulourd',
  'fr-anime-sama',
  'fr-voiranime',
  'fr-vostfree',
  'fr-animoflix',
  'fr-french-anime',
  'fr-animevostfr',
  'fr-animesultra',
  'fr-jetanimes',
  'fr-sekai',
  'fr-mugiwarastream',
  'fr-animesite'
]);
const IGNORED_PROVIDER_IDS = new Set(['test', 'test2', '_csgrouprunner', '_csproviderutils', '_nuviofrenchproviderrunner']);
const DISABLED_PROVIDER_IDS = new Set(config.DISABLED_SOURCES || []);
const NO_EMPTY_CACHE_PROVIDERS = new Set([
  'allyoucanwatch',
  '4khdhub',
  '4khdhub_tv',
  'cloudstream-phisher',
  'r2-plugin',
  'r3-plugin',
  'r4-asian-drama-movies',
  'scrapling-4khdhub',
  'anime-sama',
  'animekai',
  'animepahe',
  'animesalt',
  'brazucaplay',
  'cinestream',
  'fmovies',
  'gramcinema',
  'hdhub4u',
  'scrapling-hdhub4u',
  'hdmovie2',
  'kisskh',
  'moviebox',
  'moviesmod',
  'multivid',
  'nakios',
  'nuvio',
  'onetouchtv',
  'playimdb',
  'playimdb_v2',
  'showbox',
  'toflix',
  'vidzee',
  'frembed',
  'einschalten',
  'filmpalast',
  'torrent-scraper',
  'vidsrc',
  'vixsrc',
  'netmirror',
  'rogplay-vod'
]);
const PRIORITY_EMPTY_CACHE_PROVIDERS = new Set([
  '4khdhub',
  '4khdhub_tv',
  'cloudstream-phisher',
  'r2-plugin',
  'r3-plugin',
  'r4-asian-drama-movies',
  'allyoucanwatch',
  'scrapling-4khdhub',
  'hdhub4u',
  'scrapling-hdhub4u',
  'uhdmovies',
  'flixindia',
  'gramcinema',
  'tamilian',
  'onetouchtv',
  'streamflix',
  'moviebox',
  'vidlink'
]);
const PRIORITY_COOLDOWN_HOSTS = new Set(['4khdhub', 'hdhub4u']);
const PROVIDER_HOST_MAX_INFLIGHT_OVERRIDES = Object.freeze({
  allyoucanwatch: 1,
  '4khdhub': 2,
  hdhub4u: 2,
  showbox: 2
});
const EXPLICIT_PROVIDER_GLOBAL_LANE_BONUS = 4;
const EXPLICIT_PROVIDER_HOST_LANE_BONUS = 1;
const PROVIDER_TIMEOUT_OVERRIDES_SECONDS = Object.freeze({
  '4khdhub': 18,
  '4khdhub_tv': 18,
  'scrapling-4khdhub': 34,
  'scrapling-hdhub4u': 34,
  allyoucanwatch: 45,
  animepahe: 25,
  brazucaplay: 20,
  cinestream: 60,
  'dahmermovies-4k': 25,
  fmovies: 20,
  // These providers often require multi-hop extraction / CF redirects.
  // Give them enough headroom to succeed without marking them as failed.
  hdhub4u: 55,
  'cloudstream-phisher': 30,
  'cs-arabic': 26,
  'cs-anime-kd': 26,
  'cs-german': 26,
  'cs-brazilian': 26,
  'cs-indian': 26,
  'r2-plugin': 30,
  'r3-plugin': 40,
  'r4-asian-drama-movies': 24,
  uhdmovies: 55,
  moviebox: 20,
  'rogplay-vod': 18,
  moviesmod: 40,
  multivid: 15,
  nakios: 25,
  vidzee: 20,
  frembed: 25,
  einschalten: 20,
  filmpalast: 25,
  playimdb: 15,
  playimdb_v2: 15,
  showbox: 50,
  gramcinema: 25,
  onetouchtv: 25,
  rgshows: 10,
  kisskh: 15,
  onlykdrama: 18,
  streamflix: 18,
  nuvio: 24,
  'nuvio-latino': 24,
  'nuvio-french': 26,
  'nuvio-italian': 26,
  'nuvio-2': 26,
  toflix: 25,
  vidsrc: 20,
  vidlink: 20,
  videasy: 20,
  animekai: 25,
  'latino-lamovie': 25,
  'latino-cinecalidad': 25,
  'latino-embed69': 20,
  'latino-xupalace': 20,
  'latino-seriesmetro': 20,
  'arabic-faselhd': 30,
  'arabic-kirmzi': 25,
  'arabic-witanime': 30,
  'arabic-animecloud': 30,
  'arabic-cineby': 25,
  ...Object.fromEntries(FRENCH_NATIVE_PROVIDER_IDS.map((providerId) => [providerId, 18]))
});
const PROVIDER_FAST_TIMEOUT_OVERRIDES_SECONDS = Object.freeze({
  '4khdhub': 28,
  '4khdhub_tv': 28,
  'scrapling-4khdhub': 28,
  'scrapling-hdhub4u': 28,
  cinestream: 45,
  hdhub4u: 28,
  'cloudstream-phisher': 24,
  'cs-arabic': 22,
  'cs-anime-kd': 22,
  'cs-german': 22,
  'cs-brazilian': 22,
  'cs-indian': 22,
  'r2-plugin': 28,
  'r3-plugin': 30,
  'r4-asian-drama-movies': 18,
  playimdb: 10,
  playimdb_v2: 10,
  uhdmovies: 45,
  showbox: 35,
  gramcinema: 18,
  onetouchtv: 18,
  rgshows: 6,
  kisskh: 10,
  multivid: 10,
  onlykdrama: 12,
  nuvio: 22,
  'nuvio-latino': 22,
  'nuvio-french': 24,
  'nuvio-italian': 24,
  'nuvio-2': 24,
  'rogplay-vod': 12,
  streamflix: 12,
  ...Object.fromEntries(FRENCH_NATIVE_PROVIDER_IDS.map((providerId) => [providerId, 14]))
});
const PROVIDER_PARALLEL_TIMEOUT_OVERRIDES_MS = Object.freeze({
  '4khdhub': 32_000,
  '4khdhub_tv': 32_000,
  'scrapling-4khdhub': 34_000,
  'scrapling-hdhub4u': 34_000,
  cinestream: 55_000,
  hdhub4u: 32_000,
  'cloudstream-phisher': 30_000,
  'cs-arabic': 26_000,
  'cs-anime-kd': 26_000,
  'cs-german': 26_000,
  'cs-brazilian': 26_000,
  'cs-indian': 26_000,
  'r2-plugin': 28_000,
  'r3-plugin': 45_000,
  'r4-asian-drama-movies': 24_000,
  uhdmovies: 55_000,
  moviesmod: 18_000,
  streamflix: 18_000,
  multivid: 15_000,
  playimdb: 15_000,
  playimdb_v2: 15_000,
  rgshows: 8_000,
  kisskh: 15_000,
  onlykdrama: 18_000,
  showbox: 45_000,
  nuvio: 26_000,
  'nuvio-latino': 24_000,
  'nuvio-french': 26_000,
  'nuvio-italian': 26_000,
  'nuvio-2': 26_000,
  'rogplay-vod': 18_000,
  gramcinema: 20_000,
  onetouchtv: 20_000,
  ...Object.fromEntries(FRENCH_NATIVE_PROVIDER_IDS.map((providerId) => [providerId, 18_000]))
});
const FORCE_FAST_TIMEOUT_PROVIDER_IDS = new Set([
  '4khdhub',
  '4khdhub_tv',
  'scrapling-4khdhub',
  'scrapling-hdhub4u',
  'hdhub4u'
]);
const getProviderTimeoutSeconds = (providerId, params = null) => {
  if (params?.enforceFastTimeout) {
    const defaultFastTimeout = Math.min(config.PROVIDER_TIMEOUT_SECONDS, 10);
    return PROVIDER_FAST_TIMEOUT_OVERRIDES_SECONDS[providerId] || defaultFastTimeout;
  }

  if (
    providerId === 'showbox' &&
    String(params?.privateProviderSettings?.febboxUiCookie || '').trim()
  ) {
    return 60;
  }

  return PROVIDER_TIMEOUT_OVERRIDES_SECONDS[providerId] || config.PROVIDER_TIMEOUT_SECONDS;
};
const PROVIDER_PRIORITY = [
  'nuvio',
  'nuvio-latino',
  'nuvio-french',
  'nuvio-italian',
  'nuvio-2',
  'cloudstream-phisher',
  'r2-plugin',
  'r3-plugin',
  'r4-asian-drama-movies',
  '4khdhub',
  '4khdhub_tv',
  'scrapling-4khdhub',
  'uhdmovies',
  'hdhub4u',
  'scrapling-hdhub4u',
  'vidlink',
  'rogplay-vod',
  'cinestream',
  'moviebox',
  'onetouchtv',
  'allyoucanwatch',
  'kisskh',
  'onlykdrama',
  'rgshows',
  'streamflix',
  'netmirror',
  'videasy',
  'multivid',
  'playimdb',
  'playimdb_v2',
  'vidsrc',
  'fmovies',
  'tamilian',
  'streamflix_eng',
  'moviesmod',
  'hdmovie2',
  'dahmermovies-4k',
  'movix',
  'flixindia',
  'gramcinema',
  'isaidub',
  'allwish',
  'allmovieland',
  'animepahe',
  'nakios',
  'toflix',
  'vidzee',
  'frembed',
  'einschalten',
  'filmpalast',
  'vidmody-tr',
  'turkish-m3u',
  'rectv-tr',
  'diziyou',
  'it-streamingcommunity',
  'it-guardahd',
  'it-guardaserie',
  'it-guardoserie',
  'it-cc',
  'it-animeunity',
  'it-animeworld',
  'it-animesaturn',
  'latino-lamovie',
  'latino-embed69',
  'latino-cinecalidad',
  'latino-xupalace',
  'latino-seriesmetro',
  'arabic-faselhd',
  'arabic-cineby',
  'arabic-witanime',
  'arabic-animecloud',
  'arabic-kirmzi',
  'torrent-scraper'
];
const STREMIO_ALWAYS_EXCLUDED_PROVIDERS = new Set(['torrent-scraper', 'rogplay-live']);
const STREMIO_DEFAULT_ONLY_EXCLUDED_PROVIDERS = new Set(['allyoucanwatch', 'nuvio-latino', 'nuvio-french', 'nuvio-italian', 'nuvio-2', 'cs-arabic', 'cs-anime-kd', 'cs-german', 'cs-brazilian', 'cs-indian', ...FRENCH_NATIVE_PROVIDER_IDS]);
const WEB_READY_FALLBACK_PROVIDERS = Object.freeze(['moviebox', 'streamflix', 'videasy', 'fmovies', 'vidlink', 'cinestream', 'onetouchtv', 'multivid', 'playimdb', 'vidsrc', 'vixsrc']);
const DEFAULT_DIVERSITY_FALLBACK_PROVIDERS = Object.freeze(['moviebox', 'streamflix', 'videasy', 'fmovies', 'rgshows', 'multivid', 'playimdb', 'vidzee', 'onetouchtv', 'vidsrc', 'vixsrc']);
const CATALOG_MOVIE_FALLBACK_PROVIDERS = Object.freeze(['playimdb', 'vidsrc', 'vixsrc', 'moviebox', 'vidlink', 'cinestream', 'streamflix', 'videasy', 'fmovies', 'onetouchtv']);
const OLD_TITLE_FALLBACK_PROVIDERS = Object.freeze(['vidsrc', 'vixsrc', 'castle', 'moviebox', 'vidlink', 'cinestream']);
const OLD_TITLE_PRIORITY_PROVIDERS = Object.freeze(['nuvio', 'nuvio-latino', 'nuvio-french', 'nuvio-italian', 'cloudstream-phisher', 'r2-plugin', 'r3-plugin', '4khdhub', 'scrapling-4khdhub', '4khdhub_tv', 'uhdmovies', 'hdhub4u', 'moviebox', 'rogplay-vod', 'vidlink', 'cinestream', 'vidsrc', 'vixsrc', 'castle']);
const OLD_TITLE_PRIMARY_PROVIDERS = Object.freeze(['4khdhub', 'scrapling-4khdhub', '4khdhub_tv', 'hdhub4u', 'uhdmovies']);
const UNKNOWN_TV_PROFILE_FALLBACK_PROVIDERS = Object.freeze(['playimdb', 'animekai', 'animeworld', 'animesalt', 'animepahe', 'moviebox']);
const ANIME_PHASE_ONE_PRIORITY_PROVIDERS = Object.freeze(['animekai', 'animeworld', 'animesalt', 'moviebox', 'kisskh', '4khdhub_tv', '4khdhub']);
const ASIAN_DRAMA_FAST_PRIORITY_PROVIDERS = Object.freeze(['kisskh', 'onlykdrama', 'hdhub4u', '4khdhub_tv', '4khdhub', 'moviebox', 'vidlink', 'vixsrc', 'vidsrc', 'cinestream', 'showbox']);
const PRIMARY_FAST_PROVIDER_IDS = new Set(['4khdhub', 'scrapling-4khdhub', '4khdhub_tv', 'uhdmovies', 'hdhub4u', 'flixindia', 'tamilian', 'playimdb']);
const DEFAULT_EARLY_RETURN_BLOCKING_PROVIDERS = new Set(['nuvio']);
const QUALITY_GRACE_PROVIDER_IDS = new Set([
  'nuvio',
  'nuvio-2',
  'nuvio-latino',
  'nuvio-french',
  'nuvio-italian',
  'cloudstream-phisher',
  'r2-plugin',
  'r3-plugin',
  '4khdhub',
  '4khdhub_tv',
  'scrapling-4khdhub',
  'hdhub4u',
  'scrapling-hdhub4u',
  'uhdmovies',
  ...FRENCH_NATIVE_PROVIDER_IDS
]);
const FAST_DIRECT_FALLBACK_PROVIDER_IDS = new Set([
  'moviebox',
  'vidlink',
  'streamflix',
  'netmirror',
  'vixsrc',
  'vidsrc',
  'cinestream',
  'videasy',
  'onetouchtv',
  'showbox'
]);
const BROKEN_ANIME_FAST_PROVIDERS = new Set(['anime-sama']);
const FAST_PROVIDER_STAGGER_DELAYS_MS = Object.freeze([100, 200, 300]);
const FAST_RESULT_LAST_GOOD_TTL_MS = Math.max(
  config.STREMIO_LAST_GOOD_TTL_SECONDS * 1000,
  config.PROVIDER_CACHE_TTL_SECONDS * 12 * 1000
);
const SIGNAL_INCOMPATIBLE_PROVIDERS = new Set(['fmovies', 'vidsrc']);
const STALE_IF_ERROR_PROVIDERS = new Set(['fmovies', 'brazucaplay', 'cinestream', 'uhdmovies', 'hdhub4u', 'vidsrc']);
const ANIME_SPECIALIST_PROVIDERS = new Set([
  'animekai',
  'animepahe',
  'animesalt',
  'animeworld',
  'it-animeunity',
  'it-animeworld',
  'it-animesaturn',
  'arabic-witanime',
  'arabic-animecloud',
  'kisskh'
]);
const TMDB_METADATA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TMDB_METADATA_RETRY_DELAYS_MS = Object.freeze([250, 750]);
const CONTENT_PROVIDER_BOOSTS = Object.freeze({
  anime: Object.freeze({
    animekai: 220,
    animeworld: 190,
    animepahe: 185,
    animesalt: 180,
    moviebox: 172,
    '4khdhub_tv': 168,
    '4khdhub': 166,
    hdhub4u: 150,
    nuvio: 148,
    'it-animeunity': 120,
    'it-animeworld': 115,
    'it-animesaturn': 110,
    'arabic-witanime': 105,
    'arabic-animecloud': 100,
    'arabic-cineby': 95,
    kisskh: 92,
    'anime-sama': 40
  }),
  asian_drama: Object.freeze({
    'r4-asian-drama-movies': 240,
    kisskh: 225,
    onlykdrama: 210,
    moviebox: 145,
    vidlink: 130,
    vixsrc: 115,
    vidsrc: 110,
    cinestream: 95,
    showbox: 80
  }),
  kdrama: Object.freeze({
    'r4-asian-drama-movies': 240,
    kisskh: 230,
    onlykdrama: 220,
    moviebox: 145,
    vidlink: 130,
    vixsrc: 115,
    vidsrc: 110,
    cinestream: 95,
    showbox: 80
  }),
  indian: Object.freeze({
    '4khdhub': 230,
    '4khdhub_tv': 225,
    'scrapling-4khdhub': 224,
    uhdmovies: 223,
    hdhub4u: 220,
    'cloudstream-phisher': 219,
    'r2-plugin': 219,
    'r3-plugin': 218,
    'scrapling-hdhub4u': 219,
    nuvio: 218,
    'nuvio-latino': 217,
    'nuvio-french': 216,
    'nuvio-italian': 216,
    gramcinema: 212,
    moviebox: 208,
    vidlink: 180,
    cinestream: 175,
    onetouchtv: 130,
    flixindia: 205,
    tamilian: 165,
    isaidub: 155,
    hindmoviez: 145,
    streamflix: 110,
    streamflix_eng: 105,
    moviesmod: 100,
    allwish: 80,
    allmovieland: 70
  }),
  turkish: Object.freeze({
    'vidmody-tr': 195,
    'turkish-m3u': 190,
    'rectv-tr': 185,
    diziyou: 180,
    sinemacx: 170,
    cinemacity: 120
  }),
  italian: Object.freeze({
    'nuvio-italian': 215,
    'it-streamingcommunity': 195,
    'it-guardahd': 185,
    'it-guardaserie': 180,
    'it-guardoserie': 175,
    'it-cc': 155,
    'it-animeunity': 140,
    'it-animeworld': 135,
    'it-animesaturn': 130
  }),
  portuguese: Object.freeze({
    brazucaplay: 180
  }),
  french: Object.freeze({
    'nuvio-french': 215,
    ...Object.fromEntries(FRENCH_NATIVE_PROVIDER_IDS.map((providerId) => [providerId, 210])),
    nakios: 195,
    toflix: 190,
    frembed: 180
  }),
  german: Object.freeze({
    einschalten: 195,
    filmpalast: 190
  }),
  spanish: Object.freeze({
    'nuvio-latino': 215,
    'latino-lamovie': 195,
    'latino-cinecalidad': 190,
    'latino-embed69': 45,
    'latino-xupalace': 40,
    'latino-seriesmetro': 35,
    lamovie: 170,
    purstream: 130
  }),
  arabic: Object.freeze({
    'arabic-faselhd': 195,
    'arabic-cineby': 185,
    'arabic-witanime': 175,
    'arabic-animecloud': 170,
    'arabic-kirmzi': 150
  })
});
const PROVIDER_RELIABILITY_SCORES = Object.freeze({
  '4khdhub': 165,
  '4khdhub_tv': 160,
  'scrapling-4khdhub': 158,
  'cloudstream-phisher': 156,
  'r2-plugin': 155,
  'r3-plugin': 154,
  'r4-asian-drama-movies': 156,
  hdhub4u: 150,
  'scrapling-hdhub4u': 149,
  nuvio: 148,
  'nuvio-latino': 147,
  'nuvio-french': 146,
  'nuvio-italian': 146,
  ...Object.fromEntries(FRENCH_NATIVE_PROVIDER_IDS.map((providerId) => [providerId, 112])),
  uhdmovies: 145,
  vidlink: 120,
  onetouchtv: 116,
  cinestream: 118,
  videasy: 115,
  tamilian: 104,
  'torrent-scraper': 80,
  streamflix: 105,
  netmirror: 100,
  moviebox: 98,
  movix: 96,
  dooflix: 94,
  vixsrc: 92,
  hdmovie2: 90,
  lamovie: 88,
  purstream: 86,
  'vidmody-tr': 104,
  'turkish-m3u': 102,
  'rectv-tr': 100,
  diziyou: 98,
  'it-streamingcommunity': 106,
  'it-guardahd': 102,
  'it-guardaserie': 100,
  'it-guardoserie': 98,
  'it-cc': 94,
  'it-animeunity': 96,
  'it-animeworld': 94,
  'it-animesaturn': 92,
  'latino-lamovie': 106,
  'latino-embed69': 104,
  'latino-cinecalidad': 102,
  'latino-xupalace': 100,
  'latino-seriesmetro': 98,
  'arabic-faselhd': 106,
  'arabic-cineby': 104,
  'arabic-witanime': 100,
  'arabic-animecloud': 98,
  'arabic-kirmzi': 94,
  animepahe: 96,
  'dahmermovies-4k': 92,
  multivid: 110,
  nakios: 104,
  gramcinema: 82,
  playimdb: 108,
  playimdb_v2: 106,
  toflix: 102,
  vidzee: 108,
  frembed: 100,
  einschalten: 98,
  filmpalast: 96
});
const INDIAN_LANGUAGES = new Set(['ta', 'te', 'hi', 'ml', 'kn']);
const ASIAN_DRAMA_LANGUAGES = new Set(['ko', 'ja', 'zh', 'th']);
const ASIAN_DRAMA_COUNTRIES = new Set(['KR', 'JP', 'CN', 'TW', 'TH', 'HK']);
const ARABIC_COUNTRIES = new Set(['AE', 'BH', 'DZ', 'EG', 'IQ', 'JO', 'KW', 'LB', 'MA', 'OM', 'PS', 'QA', 'SA', 'SY', 'TN', 'YE']);
const PROVIDER_LABEL_OVERRIDES = Object.freeze({
  'it-streamingcommunity': 'StreamingCommunity IT',
  'it-guardahd': 'GuardaHD',
  'it-guardaserie': 'GuardaSerie',
  'it-guardoserie': 'GuardoSerie',
  'it-cc': 'CC IT',
  'it-animeunity': 'AnimeUnity IT',
  'it-animeworld': 'AnimeWorld IT',
  'it-animesaturn': 'AnimeSaturn',
  'latino-lamovie': 'LaMovie Latino',
  'latino-cinecalidad': 'CineCalidad',
  'latino-embed69': 'Embed69 Latino',
  'latino-xupalace': 'XuPalace',
  'latino-seriesmetro': 'SeriesMetro',
  'arabic-faselhd': 'FaselHD',
  'arabic-kirmzi': 'Kirmzi',
  'arabic-witanime': 'WitAnime',
  'arabic-animecloud': 'AnimeCloud Arabic',
  'arabic-cineby': 'Cineby Arabic',
  animepahe: 'AnimePahe',
  'dahmermovies-4k': 'DahmerMovies 4K',
  multivid: 'MultiVid',
  nakios: 'Nakios',
  gramcinema: 'GramCinema',
  'scrapling-4khdhub': 'Scrapling 4KHDHub',
  'cloudstream-phisher': 'Phisher Cloudstream',
  'r2-plugin': 'R2 plugin',
  'r3-plugin': 'R3-plugin',
  'r4-asian-drama-movies': 'r4-Asian drama and movies',
  'nuvio-latino': 'Nuvio-Latino',
  'nuvio-french': 'Nuvio-French',
  'nuvio-italian': 'Nuvio-Italian',
  'nuvio-2': 'Nuvio 2',
  'fr-frenchstream': 'Frenchstream',
  'fr-movix': 'Movix FR',
  'fr-dulourd': 'DuLourd',
  'fr-anime-sama': 'Anime-Sama FR',
  'fr-voiranime': 'VoirAnime FR',
  'fr-vostfree': 'Vostfree FR',
  'fr-animoflix': 'AnimoFlix FR',
  'fr-french-anime': 'French-Anime',
  'fr-animevostfr': 'AnimeVOSTFR',
  'fr-animesultra': 'AnimesUltra',
  'fr-jetanimes': 'JetAnimes',
  'fr-sekai': 'Sekai FR',
  'fr-mugiwarastream': 'Mugiwara Stream',
  'fr-animesite': 'AnimeSite FR',
  'cs-arabic': 'CS-Arabic',
  'cs-anime-kd': 'CS-Anime & KD',
  'cs-german': 'CS-German',
  'cs-brazilian': 'CS-Brazilian',
  'cs-indian': 'CS-Indian',
  'scrapling-hdhub4u': 'Scrapling HDHub4u',
  onetouchtv: 'OneTouchTV',
  playimdb: 'PlayIMDb',
  playimdb_v2: 'PlayIMDb V2',
  toflix: 'ToFlix',
  vidzee: 'VidZee',
  frembed: 'Frembed',
  einschalten: 'Einschalten',
  filmpalast: 'Filmpalast'
});

const toLabel = (providerId) =>
  PROVIDER_LABEL_OVERRIDES[providerId]
  || providerId
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

const discoverProviders = () => {
  const discovered = new Map();

  if (!fs.existsSync(PROVIDERS_DIR)) {
    return discovered;
  }

  const providerFiles = fs.readdirSync(PROVIDERS_DIR)
    .filter((fileName) => fileName.endsWith('.js'))
    .sort();

  for (const fileName of providerFiles) {
    const providerId = path.basename(fileName, '.js').toLowerCase();

    if (IGNORED_PROVIDER_IDS.has(providerId) || DISABLED_PROVIDER_IDS.has(providerId)) {
      continue;
    }

    discovered.set(providerId, {
      id: providerId,
      label: toLabel(providerId),
      modulePath: path.join(PROVIDERS_DIR, fileName)
    });
  }

  for (const provider of Object.values(LOCAL_PROVIDERS)) {
    if (DISABLED_PROVIDER_IDS.has(provider.id)) {
      continue;
    }

    discovered.set(provider.id, provider);
  }

  return discovered;
};

const toOptionalInteger = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

const mapConcurrent = async (items, concurrency, iteratee) => {
  const results = new Array(items.length);
  let currentIndex = 0;

  const worker = async () => {
    while (true) {
      const index = currentIndex;
      currentIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await iteratee(items[index], index);
    }
  };

  const workers = Array.from({
    length: Math.min(concurrency, items.length)
  }, () => worker());

  await Promise.all(workers);
  return results;
};

const copyStreams = (streams) => streams.map((stream) => ({ ...stream }));
const serializeStreams = (streams) => JSON.stringify(Array.isArray(streams) ? streams : []);
const deserializeStreams = (payload) => {
  if (typeof payload !== 'string' || !payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? copyStreams(parsed) : [];
  } catch {
    return [];
  }
};
const getSerializedApproxBytes = (payload) => Buffer.byteLength(String(payload || ''), 'utf8');

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

const getAbortReason = (signal, fallbackMessage = 'Provider query aborted') => {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  return createHttpError(504, fallbackMessage);
};

const waitForProviderSlot = (delayMs, signal) => {
  if (signal?.aborted) {
    return Promise.reject(getAbortReason(signal));
  }

  return new Promise((resolve, reject) => {
    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(getAbortReason(signal));
    };

    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    timeoutId.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const createCombinedAbortSignal = (signals, fallbackMessage) => {
  const cleanSignals = (Array.isArray(signals) ? signals : [signals]).filter(Boolean);
  const controller = new AbortController();
  allowHighFanoutAbortSignal(controller.signal);
  const abortHandler = () => {
    const abortedSignal = cleanSignals.find((s) => s?.aborted);
    controller.abort(getAbortReason(abortedSignal, fallbackMessage));
  };
  const signal = controller.signal;
  const cleanup = () => {
    for (const s of cleanSignals) {
      s?.removeEventListener?.('abort', abortHandler);
    }
  };

  for (const s of cleanSignals) {
    allowHighFanoutAbortSignal(s);

    if (s?.aborted) {
      controller.abort(getAbortReason(s, fallbackMessage));
      return { signal, cleanup: () => { } };
    }

    s?.addEventListener?.('abort', abortHandler, { once: true });
  }

  return { signal, cleanup };
};

const withCombinedAbortSignal = async (signals, callback, fallbackMessage = 'Provider query aborted') => {
  const { signal, cleanup } = createCombinedAbortSignal(signals, fallbackMessage);

  try {
    return await callback(signal);
  } finally {
    cleanup();
  }
};

const isProviderCancellationError = (error) =>
  Number(error?.statusCode) === 499
  || /provider request cancelled|phase aborted/i.test(String(error?.message || ''))
  || error?.name === 'AbortError'
  || /this operation was aborted/i.test(String(error?.message || ''));

const getProviderFamilyId = (providerId) => {
  const normalized = String(providerId || '').toLowerCase();

  if (normalized.startsWith('4khdhub')) {
    return '4khdhub';
  }

  if (normalized.startsWith('playimdb')) {
    return 'playimdb';
  }

  if (normalized.startsWith('vidzee')) {
    return 'vidzee';
  }

  if (normalized.startsWith('vidsrc') || normalized === 'vixsrc') {
    return 'vidsrc';
  }

  if (normalized.startsWith('latino-')) {
    return 'latino';
  }

  if (normalized.startsWith('it-')) {
    return 'it';
  }

  if (normalized.startsWith('arabic-')) {
    return 'arabic';
  }

  return normalized || 'unknown';
};

const getDistinctProviderFamilyCount = (streams = []) => (
  new Set(
    streams
      .map((stream) => getProviderFamilyId(stream?.provider))
      .filter(Boolean)
  ).size
);

const copyFastSearchResult = (result) => ({
  reason: result?.reason || 'all-complete',
  providers: Array.isArray(result?.providers) ? [...result.providers] : [],
  tried: Array.isArray(result?.tried)
    ? result.tried.map((entry) => ({
      provider: entry.provider,
      count: Number.isFinite(entry.count) ? entry.count : 0
    }))
    : [],
  streams: copyStreams(Array.isArray(result?.streams) ? result.streams : [])
});

const getProviderFailureThreshold = (providerId) =>
  PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId)
    ? config.PROVIDER_FAILURE_THRESHOLD * 4
    : config.PROVIDER_FAILURE_THRESHOLD;

const getProviderCooldownMs = (providerId) =>
  (PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId) ? 30 : config.PROVIDER_COOLDOWN_SECONDS) * 1000;

const getProviderHostFailureThreshold = (hostKey) =>
  PRIORITY_COOLDOWN_HOSTS.has(hostKey)
    ? config.PROVIDER_HOST_FAILURE_THRESHOLD * 4
    : config.PROVIDER_HOST_FAILURE_THRESHOLD;

const getProviderHostCooldownMs = (hostKey) =>
  (PRIORITY_COOLDOWN_HOSTS.has(hostKey) ? 30 : config.PROVIDER_HOST_COOLDOWN_SECONDS) * 1000;

const sanitizeHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return null;
  }

  const sanitized = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerName !== 'string' || typeof headerValue !== 'string') {
      continue;
    }

    const normalizedName = headerName.trim();
    const normalizedValue = headerValue.trim();

    if (!normalizedName || !normalizedValue) {
      continue;
    }

    sanitized[normalizedName] = normalizedValue;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
};

const parseProviderSizeBytes = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const match = String(value || '').match(/([0-9]+(?:\.[0-9]+)?)\s*(tb|gb|mb|kb)/iu);
  if (!match) {
    return 0;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4
  };

  return amount * (multipliers[unit] || 0);
};

const inferProviderStreamQuality = (stream) => {
  const explicitQuality = String(stream?.quality || '').trim();
  const qualityText = [
    explicitQuality,
    stream?.name,
    stream?.title,
    stream?.filename,
    stream?.fileName,
    stream?.url
  ].map((value) => String(value || '')).join(' ');
  const qualityMatch = qualityText.match(/\b(2160p|4k|1440p|1080p|720p|480p|360p|240p)\b/iu);

  if (qualityMatch) {
    const normalized = qualityMatch[1].toLowerCase();
    return normalized === '4k' ? '2160p' : normalized;
  }

  if (explicitQuality && explicitQuality.toLowerCase() !== 'unknown') {
    return explicitQuality;
  }

  const sizeBytes = parseProviderSizeBytes(`${String(stream?.size || '')} ${String(stream?.title || '')} ${String(stream?.name || '')}`);
  if (sizeBytes >= 14 * 1024 ** 3) return '2160p';
  if (sizeBytes >= 3 * 1024 ** 3) return '1080p';
  if (sizeBytes >= 1 * 1024 ** 3) return '720p';
  if (sizeBytes >= 350 * 1024 ** 2) return '480p';

  return explicitQuality || 'Unknown';
};

const ARCHIVE_FILE_EXTENSION_PATTERN = /\.(?:zip|rar|7z|tar|gz|bz2|xz)(?:$|[?#\s])/iu;
const KNOWN_UNPLAYABLE_STREAM_HOSTS = new Set([
  'cdn.video-gen.xyz',
  'video-gen.xyz'
]);

const isArchiveProviderStream = (stream, parsedUrl = null) => {
  const text = [
    stream?.filename,
    stream?.fileName,
    stream?.title,
    stream?.name,
    stream?.url,
    parsedUrl?.pathname
  ].map((value) => String(value || '')).join(' ');

  return ARCHIVE_FILE_EXTENSION_PATTERN.test(text);
};

const isKnownUnplayableProviderStream = (stream, parsedUrl = null) => {
  if (!parsedUrl || !KNOWN_UNPLAYABLE_STREAM_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
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

  return providerText.includes('uhdmovies');
};

const sanitizeProviderStream = (stream) => {
  if (!stream || typeof stream !== 'object') {
    return null;
  }

  const normalizedMagnet = typeof stream.magnet === 'string'
    ? String(stream.magnet).trim()
    : typeof stream.torrent === 'string'
      ? String(stream.torrent).trim()
      : '';

  if (normalizedMagnet && !normalizedMagnet.startsWith('magnet:?')) {
    return null;
  }

  const normalizedUrl = String(stream.url || '').trim();
  let parsedUrl = null;

  if (normalizedUrl) {
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      parsedUrl = null;
    }
  }

  if (parsedUrl && !['http:', 'https:'].includes(parsedUrl.protocol)) {
    parsedUrl = null;
  }

  if (!normalizedMagnet && !parsedUrl) {
    return null;
  }

  if (isArchiveProviderStream(stream, parsedUrl)) {
    return null;
  }

  if (isKnownUnplayableProviderStream(stream, parsedUrl)) {
    return null;
  }

  const {
    headers: _headers,
    magnet: _magnet,
    torrent: _torrent,
    url: _url,
    ...rest
  } = stream;

  const sanitizedStream = {
    ...rest,
    ...(parsedUrl ? { url: parsedUrl.toString() } : {}),
    ...(normalizedMagnet ? { magnet: normalizedMagnet } : {}),
    transport: normalizedMagnet ? 'torrent' : 'http',
    headers: sanitizeHeaders(stream.headers)
  };

  sanitizedStream.quality = inferProviderStreamQuality({
    ...stream,
    ...sanitizedStream
  });

  return sanitizedStream;
};

const getProviderStreamEpisodeText = (stream) => {
  const values = [
    stream?.filename,
    stream?.fileName,
    stream?.title,
    stream?.name,
    stream?.description,
    stream?.sourceName,
    stream?.url
  ];

  return values
    .map((value) => {
      const text = String(value || '');
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    })
    .join(' ')
    .replace(/[._-]+/g, ' ');
};

const getProviderStreamEpisodeMatch = (stream, season, episode) => {
  const normalizedSeason = toOptionalInteger(season);
  const normalizedEpisode = toOptionalInteger(episode);

  if (!normalizedSeason || !normalizedEpisode) {
    return { hasAnyMarker: false, hasExactMarker: false, hasWrongSameSeasonMarker: false };
  }

  const text = getProviderStreamEpisodeText(stream);
  const markers = [];
  const markerPatterns = [
    /\bs\s*0*(\d{1,2})\s*(?:e|ep)\s*0*(\d{1,3})\b/giu,
    /\b0*(\d{1,2})\s*x\s*0*(\d{1,3})\b/giu,
    /\bseason\s*0*(\d{1,2})\D{0,24}\b(?:episode|ep)\s*0*(\d{1,3})\b/giu
  ];

  for (const pattern of markerPatterns) {
    for (const match of text.matchAll(pattern)) {
      const markerSeason = Number.parseInt(match[1], 10);
      const markerEpisode = Number.parseInt(match[2], 10);

      if (Number.isFinite(markerSeason) && Number.isFinite(markerEpisode)) {
        markers.push({ season: markerSeason, episode: markerEpisode });
      }
    }
  }

  const hasExactMarker = markers.some((marker) =>
    marker.season === normalizedSeason && marker.episode === normalizedEpisode
  );
  const hasWrongSameSeasonMarker = markers.some((marker) =>
    marker.season === normalizedSeason && marker.episode !== normalizedEpisode
  );

  return {
    hasAnyMarker: markers.length > 0,
    hasExactMarker,
    hasWrongSameSeasonMarker
  };
};

const filterEpisodeMismatchedProviderStreams = ({
  streams,
  providerId,
  mediaType,
  season,
  episode,
  tmdbId
}) => {
  if (mediaType !== 'tv' || !toOptionalInteger(season) || !toOptionalInteger(episode) || !Array.isArray(streams) || streams.length === 0) {
    return streams;
  }

  const filtered = [];
  let droppedCount = 0;

  for (const stream of streams) {
    const match = getProviderStreamEpisodeMatch(stream, season, episode);

    if (match.hasWrongSameSeasonMarker && !match.hasExactMarker) {
      droppedCount += 1;
      continue;
    }

    filtered.push({
      ...stream,
      episodeMatchScore: match.hasExactMarker ? 100 : 0
    });
  }

  if (droppedCount > 0) {
    logger.info('provider tv episode mismatch streams dropped', {
      provider: providerId,
      tmdbId,
      season,
      episode,
      droppedCount,
      keptCount: filtered.length
    });
  }

  filtered.sort((left, right) =>
    (right.episodeMatchScore || 0) - (left.episodeMatchScore || 0)
  );

  return filtered;
};

const toQualityScore = (quality) => {
  const normalized = String(quality || '').trim().toLowerCase();

  if (!normalized) {
    return 0;
  }

  if (normalized === '4k') {
    return 2160;
  }

  if (normalized === 'auto' || normalized === 'adaptive') {
    return 850;
  }

  const match = normalized.match(/(\d{3,4})/);

  if (match?.[1]) {
    return Number.parseInt(match[1], 10);
  }

  return 0;
};

const getStreamQualityScore = (stream) => Math.max(
  toQualityScore(stream?.quality),
  toQualityScore(`${stream?.title || ''} ${stream?.name || ''} ${stream?.filename || stream?.fileName || ''}`)
);

const hasUltraHighQualityStream = (streams) =>
  Array.isArray(streams) && streams.some((stream) => toQualityScore(stream?.quality) >= 2160);

const withFallbackTimeout = async (promise, timeoutMs, fallbackValue) => {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
        timeoutId.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
};

const toTransportScore = (url) => {
  const normalized = String(url || '').toLowerCase();

  if (normalized.includes('.mp4') || normalized.includes('.mkv') || normalized.includes('.avi') || normalized.includes('.webm')) {
    return 40;
  }

  if (normalized.includes('.m3u8')) {
    return 32;
  }

  if (normalized.includes('pixeldrain') || normalized.includes('vidlink') || normalized.includes('videasy')) {
    return 24;
  }

  return 10;
};

const toHeaderScore = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return 0;
  }

  const headerNames = Object.keys(headers).map((headerName) => headerName.toLowerCase());
  let score = 0;

  if (headerNames.includes('referer')) {
    score += 2;
  }

  if (headerNames.includes('user-agent')) {
    score += 1;
  }

  return score;
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

const getPluginProviderScore = (stream) => {
  const providerId = String(stream?.provider || '').trim().toLowerCase();

  if (!providerId.startsWith('nuvio')) {
    return 0;
  }

  const pluginProvider = String(stream?.pluginProvider || stream?.sourceSite || '').trim().toLowerCase();
  return NUVIO_PLUGIN_PRIORITY_SCORES[pluginProvider] || 0;
};

const getProviderContentBoost = (providerId, contentProfile) => {
  if (!contentProfile || !Array.isArray(contentProfile.tags)) {
    return 0;
  }

  return contentProfile.tags.reduce((total, tag) => {
    const tagBoosts = CONTENT_PROVIDER_BOOSTS[tag];

    if (!tagBoosts || !Object.hasOwn(tagBoosts, providerId)) {
      return total;
    }

    return total + tagBoosts[providerId];
  }, 0);
};

const toProviderScore = (
  providerId,
  providerOrder,
  contentProfile = null,
  privateProviderSettings = null
) => {
  const baseReliability = Object.hasOwn(PROVIDER_RELIABILITY_SCORES, providerId)
    ? PROVIDER_RELIABILITY_SCORES[providerId]
    : 0;
  const contentBoost = getProviderContentBoost(providerId, contentProfile);
  const privatePriorityBoost = getPrivateProviderPriorityBoost(providerId, privateProviderSettings);
  const index = providerOrder.indexOf(providerId);

  if (index === -1) {
    return baseReliability + contentBoost + privatePriorityBoost;
  }

  return baseReliability + contentBoost + privatePriorityBoost + Math.max(providerOrder.length - index, 1);
};

const rankStream = (stream, providerOrder, contentProfile = null, privateProviderSettings = null) => {
  const providerId = String(stream.provider || '').toLowerCase();
  const qualityScore = getStreamQualityScore(stream);
  const transportScore = stream.url ? toTransportScore(stream.url) : stream.magnet ? 6 : 10;
  const headerScore = toHeaderScore(stream.headers);
  const providerScore = toProviderScore(
    providerId,
    providerOrder,
    contentProfile,
    privateProviderSettings
  );
  const pluginProviderScore = getPluginProviderScore(stream);
  const episodeMatchScore = Number.isFinite(stream.episodeMatchScore) ? stream.episodeMatchScore : 0;

  return (providerScore * 10000) + (pluginProviderScore * 3000) + (episodeMatchScore * 5000) + (qualityScore * 100) + (transportScore * 10) + headerScore;
};

const getResultBestQualityScore = (result) => {
  if (!Array.isArray(result?.streams) || result.streams.length === 0) {
    return 0;
  }

  return result.streams.reduce((best, stream) =>
    Math.max(best, getStreamQualityScore(stream)), 0);
};

const getResultBestRankScore = (result, providerOrder, contentProfile = null, privateProviderSettings = null) => {
  if (!Array.isArray(result?.streams) || result.streams.length === 0) {
    return 0;
  }

  return result.streams.reduce((best, stream) =>
    Math.max(best, rankStream(stream, providerOrder, contentProfile, privateProviderSettings)), 0);
};

const hasStrongProviderResult = (results, providerOrder, contentProfile = null, privateProviderSettings = null) =>
  results.some((result) => {
    const providerId = String(result?.provider || '').trim().toLowerCase();
    if (!QUALITY_GRACE_PROVIDER_IDS.has(providerId) || !Array.isArray(result?.streams) || result.streams.length === 0) {
      return false;
    }

    return getResultBestQualityScore(result) >= 1080
      || getResultBestRankScore(result, providerOrder, contentProfile, privateProviderSettings) > 1_400_000;
  });

const mergeAndRankProviderStreams = (
  settledResults,
  providerOrder,
  contentProfile = null,
  limit = Infinity,
  privateProviderSettings = null
) => {
  const mergedStreams = [];
  const seenSources = new Set();

  for (const result of settledResults) {
    if (!result) {
      continue;
    }

    for (const stream of result.streams) {
      const normalizedUrl = String(stream.url || '').trim();
      const normalizedMagnet = String(stream.magnet || stream.torrent || '').trim();
      const dedupeKey = JSON.stringify({
        url: normalizedUrl || null,
        magnet: normalizedMagnet || null
      });

      if ((!normalizedUrl && !normalizedMagnet) || seenSources.has(dedupeKey)) {
        continue;
      }

      seenSources.add(dedupeKey);
      mergedStreams.push({
        ...stream,
        provider: stream.provider || result.provider
      });
    }
  }

  mergedStreams.sort((left, right) => {
    const scoreDelta = rankStream(right, providerOrder, contentProfile, privateProviderSettings)
      - rankStream(left, providerOrder, contentProfile, privateProviderSettings);

    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return String(left.name || left.title || left.url).localeCompare(
      String(right.name || right.title || right.url)
    );
  });

  return Number.isFinite(limit)
    ? mergedStreams.slice(0, limit)
    : mergedStreams;
};

const applyPerProviderSoftLimit = (streams, limit, perProviderSoftLimit = Infinity) => {
  if (!Number.isFinite(limit)) {
    return streams;
  }

  if (!Number.isFinite(perProviderSoftLimit) || perProviderSoftLimit < 1) {
    return streams.slice(0, limit);
  }

  const selected = [];
  const deferred = [];
  const providerCounts = new Map();

  for (const stream of streams) {
    const providerId = String(stream.provider || '').trim().toLowerCase() || 'unknown';
    const count = providerCounts.get(providerId) || 0;

    if (count < perProviderSoftLimit) {
      providerCounts.set(providerId, count + 1);
      selected.push(stream);
    } else {
      deferred.push(stream);
    }

    if (selected.length >= limit) {
      return selected;
    }
  }

  for (const stream of deferred) {
    selected.push(stream);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
};

const applyPreferredProviderDiversity = (streams, limit, preferredProviders = []) => {
  if (!Number.isFinite(limit) || limit < 1 || !Array.isArray(preferredProviders) || preferredProviders.length === 0) {
    return Number.isFinite(limit) ? streams.slice(0, limit) : streams;
  }

  const normalizedPreferredProviders = preferredProviders
    .map((providerId) => String(providerId || '').trim().toLowerCase())
    .filter(Boolean);

  if (normalizedPreferredProviders.length === 0) {
    return streams.slice(0, limit);
  }

  const selected = streams
    .slice(0, limit)
    .map((stream, index) => ({ stream, originalIndex: index }));
  const indexedStreams = streams.map((stream, index) => ({ stream, originalIndex: index }));

  for (const preferredProvider of normalizedPreferredProviders) {
    const selectedProviderSet = new Set(
      selected.map(({ stream }) => String(stream.provider || '').trim().toLowerCase())
    );

    if (selectedProviderSet.has(preferredProvider)) {
      continue;
    }

    const candidate = indexedStreams.find(({ stream, originalIndex }) =>
      originalIndex >= limit
      && String(stream.provider || '').trim().toLowerCase() === preferredProvider
    );

    if (!candidate) {
      continue;
    }

    const providerCounts = new Map();

    for (const { stream } of selected) {
      const providerId = String(stream.provider || '').trim().toLowerCase();
      providerCounts.set(providerId, (providerCounts.get(providerId) || 0) + 1);
    }

    let replaceAt = -1;

    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const providerId = String(selected[index]?.stream?.provider || '').trim().toLowerCase();

      if (normalizedPreferredProviders.includes(providerId)) {
        continue;
      }

      if ((providerCounts.get(providerId) || 0) > 1) {
        replaceAt = index;
        break;
      }
    }

    if (replaceAt === -1) {
      continue;
    }

    selected[replaceAt] = candidate;
  }

  return selected
    .map(({ stream }) => stream)
    .slice(0, limit);
};

const reprioritizeProviders = (providers, preferredProviders = []) => {
  if (!Array.isArray(providers) || providers.length === 0 || !Array.isArray(preferredProviders) || preferredProviders.length === 0) {
    return Array.isArray(providers) ? [...providers] : [];
  }

  const preferredSet = new Set(preferredProviders);

  return [
    ...preferredProviders.filter((providerId) => providers.includes(providerId)),
    ...providers.filter((providerId) => !preferredSet.has(providerId))
  ];
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const compactProviderListForLog = (providerIds, limit = 24) => {
  const safeProviderIds = Array.isArray(providerIds) ? providerIds : [];
  return safeProviderIds.length > limit
    ? [...safeProviderIds.slice(0, limit), `... ${safeProviderIds.length - limit} more`]
    : safeProviderIds;
};

export class ProviderService {
  constructor() {
    this.providers = discoverProviders();
    this.pluginProviderRegistry = new PluginProviderRegistry({
      cacheDir: config.CACHE_DIR,
      logger
    });
    for (const providerConfig of this.pluginProviderRegistry.getProviderConfigs()) {
      if (!DISABLED_PROVIDER_IDS.has(providerConfig.id)) {
        this.providers.set(providerConfig.id, providerConfig);
      }
    }
    this.providerCacheDir = path.join(config.CACHE_DIR, 'provider-results');
    this.fastResultCacheDir = path.join(config.CACHE_DIR, 'fast-results');
    this.moduleCache = new Map();
    this.resultCache = new Map();
    this.inFlight = new Map();
    this.fastSearchInFlight = new Map();
    this.providerHealth = new Map();
    this.providerHostHealth = new Map();
    this.providerHostInflight = new Map();
    this.providerRuntime = new Map();
    this.providerGlobalInflight = 0;
    this.tmdbMetadataCache = new Map();
    this.tmdbMetadataInFlight = new Map();
  }

  async initialize() {
    await mkdir(this.providerCacheDir, { recursive: true });
    await mkdir(this.fastResultCacheDir, { recursive: true });
    await this.pluginProviderRegistry.initialize();
    setTimeout(() => {
      this.removeExpiredDiskEntries().catch((error) => {
        logger.warn('provider cache cleanup after startup failed', { error });
      });
    }, 0).unref?.();
  }

  listProviders() {
    return this.getProviderOrder().map((providerId) => {
      const provider = this.providers.get(providerId);

      return {
        id: provider.id,
        label: provider.label
      };
    });
  }

  getStats() {
    const now = Date.now();
    let coolingDownProviders = 0;
    let coolingDownHosts = 0;
    const providerStatuses = this.getProviderStatusSnapshot(now);

    for (const state of this.providerHealth.values()) {
      if ((state.cooldownUntil || 0) > now) {
        coolingDownProviders += 1;
      }
    }

    for (const state of this.providerHostHealth.values()) {
      if ((state.cooldownUntil || 0) > now) {
        coolingDownHosts += 1;
      }
    }

    return {
      discoveredProviders: this.providers.size,
      inMemoryCacheEntries: this.resultCache.size,
      inFlightRequests: this.inFlight.size,
      activeProviderExecutions: this.providerGlobalInflight,
      providerCacheDir: this.providerCacheDir,
      coolingDownProviders,
      coolingDownHosts,
      providers: providerStatuses
    };
  }

  getLiveLoad() {
    return {
      inFlightRequests: this.inFlight.size,
      activeProviderExecutions: this.providerGlobalInflight
    };
  }

  updateProviderRuntime(providerId, patch) {
    const current = this.providerRuntime.get(providerId) || {
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      consecutiveFailures: 0,
      lastResultCount: null,
      lastDurationMs: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastCacheHitAt: null,
      lastError: null,
      running: false
    };

    this.providerRuntime.set(providerId, {
      ...current,
      ...patch
    });
  }

  getProviderStatusSnapshot(now = Date.now()) {
    return this.getProviderOrder().map((providerId) => {
      const provider = this.providers.get(providerId);
      const hostKey = this.getProviderHostKey(providerId);
      const runtime = this.providerRuntime.get(providerId) || {};
      const health = this.providerHealth.get(providerId) || {};
      const hostHealth = this.providerHostHealth.get(hostKey) || {};
      const providerCooldownUntil = health.cooldownUntil || 0;
      const hostCooldownUntil = hostHealth.cooldownUntil || 0;
      const cooldownUntil = Math.max(providerCooldownUntil, hostCooldownUntil);
      const activeRequests = this.providerHostInflight.get(hostKey) || 0;
      let status = 'idle';

      if (runtime.running) {
        status = 'running';
      } else if (cooldownUntil > now) {
        status = 'cooldown';
      } else if ((runtime.consecutiveFailures || 0) > 0) {
        status = 'failing';
      } else if (runtime.lastResultCount === 0 && (runtime.totalSuccesses || 0) > 0) {
        status = 'intermittent';
      } else if (runtime.lastResultCount === 0) {
        status = 'empty';
      } else if (Number.isFinite(runtime.lastResultCount)) {
        status = 'ok';
      } else if (runtime.lastCacheHitAt) {
        status = 'cache-hit';
      }

      return {
        id: providerId,
        label: provider?.label || toLabel(providerId),
        hostKey,
        status,
        activeRequests,
        failures: health.failures || 0,
        hostFailures: hostHealth.failures || 0,
        cooldownUntil: cooldownUntil > now ? cooldownUntil : 0,
        lastStartedAt: runtime.lastStartedAt || null,
        lastFinishedAt: runtime.lastFinishedAt || null,
        lastCacheHitAt: runtime.lastCacheHitAt || null,
        lastResultCount: Number.isFinite(runtime.lastResultCount) ? runtime.lastResultCount : null,
        lastDurationMs: Number.isFinite(runtime.lastDurationMs) ? runtime.lastDurationMs : null,
        lastError: runtime.lastError || null,
        totalRequests: runtime.totalRequests || 0,
        totalSuccesses: runtime.totalSuccesses || 0,
        totalFailures: runtime.totalFailures || 0,
        consecutiveFailures: runtime.consecutiveFailures || 0
      };
    });
  }

  handleMemoryPressure({ critical = false } = {}) {
    if (critical) {
      this.resultCache.clear();
      this.tmdbMetadataCache.clear();
      return;
    }

    pruneMapByMaxEntries(this.resultCache, Math.max(50, Math.floor(config.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES / 4)));
    pruneMapByApproxBytes(this.resultCache, Math.max(512 * 1024, Math.floor((config.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024) / 4)));
    pruneMapByMaxEntries(this.tmdbMetadataCache, Math.max(50, Math.floor(config.TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES / 4)));
  }

  getStremioProviderOrder(requestedProviders = null, contentProfile = null) {
    const candidates = this.getProviderOrder(contentProfile, requestedProviders && requestedProviders.length > 0 ? requestedProviders : null);
    const hasExplicitProviders = Array.isArray(requestedProviders) && requestedProviders.length > 0;

    return candidates.filter((providerId) => {
      if (STREMIO_ALWAYS_EXCLUDED_PROVIDERS.has(providerId)) {
        return false;
      }

      if (!hasExplicitProviders && STREMIO_DEFAULT_ONLY_EXCLUDED_PROVIDERS.has(providerId)) {
        return false;
      }

      return true;
    });
  }

  async getContentProfile({ tmdbId, mediaType }) {
    try {
      const metadata = await this.getTmdbMetadata({ tmdbId, mediaType });
      return this.buildContentProfile(metadata, mediaType);
    } catch (error) {
      logger.warn('content profile detection failed', {
        tmdbId,
        mediaType,
        error
      });
      return null;
    }
  }

  async getAggregateStreams({ providers = null, ...rest }) {
    const contentProfile = rest.contentProfile || await this.getContentProfile(rest);
    const normalizedProviders = this.getProviderOrder(contentProfile, providers);

    if (normalizedProviders.length === 0) {
      throw createHttpError(400, 'No valid providers were supplied for aggregate search');
    }

    const settledResults = await mapConcurrent(normalizedProviders, config.PROVIDER_MAX_CONCURRENCY, async (provider) => {
      const streams = await this.getStreams({
        provider,
        ...rest,
        priorityRequest: Array.isArray(providers) && providers.length > 0
      });

      return {
        provider,
        streams
      };
    });

    const tried = settledResults.map((result) => ({
      provider: result.provider,
      count: result.streams.length
    }));
    return {
      providers: normalizedProviders,
      tried,
      streams: mergeAndRankProviderStreams(
        settledResults,
        normalizedProviders,
        contentProfile,
        Infinity,
        rest.privateProviderSettings
      )
    };
  }

  getProviderDynamicScore(providerId, contentProfile = null, privateProviderSettings = null) {
    const hostKey = this.getProviderHostKey(providerId);
    const runtime = this.providerRuntime.get(providerId);
    const isCoolingDown = (this.providerHealth.get(providerId)?.cooldownUntil || 0) > Date.now();
    const isHostCoolingDown = (this.providerHostHealth.get(hostKey)?.cooldownUntil || 0) > Date.now();
    const consecutiveFailures = runtime?.consecutiveFailures || 0;
    let score = PROVIDER_DYNAMIC_SCORE_BASE;

    if (isCoolingDown) score -= PROVIDER_DYNAMIC_SCORE_COOLDOWN_PENALTY;
    if (isHostCoolingDown) score -= PROVIDER_DYNAMIC_SCORE_HOST_COOLDOWN_PENALTY;
    if (consecutiveFailures >= config.PROVIDER_FAILURE_THRESHOLD) score -= PROVIDER_DYNAMIC_SCORE_FAILURE_PENALTY;

    const priorityMap = contentProfile?.priorityProviderMap || null;
    if (priorityMap) score += (priorityMap[providerId] || 0);

    if (privateProviderSettings && providerId === 'showbox' && String(privateProviderSettings.febboxUiCookie || '').trim()) {
      score += 1000;
    }

    return score;
  }

  buildFastSearchRequestKey({
    providers = null,
    tmdbId,
    imdbId = null,
    mediaType = 'movie',
    season = null,
    episode = null,
    streamOptions = null,
    privateProviderSettings = null
  }) {
    return JSON.stringify({
      version: 'two-phase-v40',
      providers: Array.isArray(providers) ? providers.map((providerId) => String(providerId || '').trim().toLowerCase()) : null,
      tmdbId: toOptionalInteger(tmdbId),
      imdbId: typeof imdbId === 'string' ? imdbId.trim() : null,
      mediaType: normalizeProviderMediaType(mediaType),
      season: toOptionalInteger(season),
      episode: toOptionalInteger(episode),
      webReadyOnly: Boolean(streamOptions?.webReadyOnly),
      privateProviderSettingsKey: getPrivateProviderSettingsKey('showbox', privateProviderSettings)
    });
  }

  getFastResultCacheFilePath(requestKey) {
    return path.join(this.fastResultCacheDir, `${this.hashCacheKey(requestKey)}.json`);
  }

  async getFastLastGoodResult(requestKey) {
    const cachePath = this.getFastResultCacheFilePath(requestKey);

    try {
      const payload = JSON.parse(await readFile(cachePath, 'utf8'));
      const streams = Array.isArray(payload?.streams) ? copyStreams(payload.streams) : [];

      if (!payload || payload.expiresAt <= Date.now() || streams.length === 0) {
        await rm(cachePath, { force: true });
        return null;
      }

      return {
        reason: 'last-good-fallback',
        providers: Array.isArray(payload.providers) ? [...payload.providers] : [],
        tried: Array.isArray(payload.tried)
          ? payload.tried.map((entry) => ({
            provider: entry.provider,
            count: Number.isFinite(entry.count) ? entry.count : 0
          }))
          : [],
        streams
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('fast result last-good cache read failed', { cacheKey: this.hashCacheKey(requestKey), error });
      }
      return null;
    }
  }

  async setFastLastGoodResult(requestKey, result) {
    const streams = Array.isArray(result?.streams) ? result.streams : [];
    if (streams.length === 0) return;
    const hasShowbox = streams.some((stream) =>
      String(stream?.provider || '').trim().toLowerCase() === 'showbox'
    );
    try {
      await writeFile(this.getFastResultCacheFilePath(requestKey), JSON.stringify({
        expiresAt: Date.now() + (hasShowbox ? 120_000 : FAST_RESULT_LAST_GOOD_TTL_MS),
        providers: Array.isArray(result?.providers) ? result.providers : [],
        tried: Array.isArray(result?.tried) ? result.tried : [],
        streams
      }));
    } catch (error) {
      logger.warn('fast result last-good cache write failed', { cacheKey: this.hashCacheKey(requestKey), error });
    }
  }

  getAdaptiveMinStreams(providers, contentProfile = null) {
    const baseMin = config.STREMIO_FAST_STREAM_LIMIT > 0 ? 1 : 0;
    const animeCount = providers.filter((id) => ANIME_SPECIALIST_PROVIDERS.has(id)).length;
    const isAnime = contentProfile?.anime || animeCount >= 2;
    const providerCount = providers.length;

    if (isAnime) return Math.max(baseMin, Math.min(4, Math.ceil(providerCount * 0.3)));
    return baseMin;
  }

  getFastPhaseOneLimit(providers, hasExplicitProviders) {
    const maxPhaseOne = hasExplicitProviders
      ? Math.min(providers.length, config.STREMIO_FAST_PROVIDER_LIMIT)
      : Math.min(8, Math.max(5, Math.ceil(providers.length * 0.6)));
    return Math.min(maxPhaseOne, providers.length);
  }

  getAdaptiveFallbackProviderLimit(providers, phaseOneTried) {
    if (!Array.isArray(providers) || providers.length === 0) return 0;
    const remaining = providers.filter((id) => !phaseOneTried.has(id));
    return Math.min(remaining.length, Math.max(3, Math.min(6, Math.ceil(remaining.length * 0.5))));
  }

  getProviderPerformanceScore(providerId) {
    const runtime = this.providerRuntime.get(providerId);
    if (!runtime) {
      return 0;
    }

    const totalRequests = Math.max(0, Number(runtime.totalRequests || 0));
    const totalSuccesses = Math.max(0, Number(runtime.totalSuccesses || 0));
    const totalFailures = Math.max(0, Number(runtime.totalFailures || 0));
    const lastResultCount = Number.isFinite(runtime.lastResultCount) ? runtime.lastResultCount : 0;
    const lastDurationMs = Number.isFinite(runtime.lastDurationMs) ? runtime.lastDurationMs : null;
    const successRatio = totalRequests > 0 ? totalSuccesses / totalRequests : 0;
    const failureRatio = totalRequests > 0 ? totalFailures / totalRequests : 0;
    const resultScore = Math.min(28, lastResultCount * 3);
    const durationScore = lastDurationMs === null
      ? 0
      : Math.max(-18, Math.min(14, Math.round((18_000 - lastDurationMs) / 1000)));

    return Math.round((successRatio * 30) - (failureRatio * 24) + resultScore + durationScore);
  }

  rankProvidersForFastSearch(providers, contentProfile = null, privateProviderSettings = null) {
    return [...providers].sort((left, right) => {
      const scoreDelta = this.getProviderDynamicScore(right, contentProfile, privateProviderSettings)
        - this.getProviderDynamicScore(left, contentProfile, privateProviderSettings);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return providers.indexOf(left) - providers.indexOf(right);
    });
  }

  getProviderDynamicScore(providerId, contentProfile = null, privateProviderSettings = null) {
    let score = 50
      + (PROVIDER_RELIABILITY_SCORES[providerId] || 0)
      + getProviderContentBoost(providerId, contentProfile)
      + getPrivateProviderPriorityBoost(providerId, privateProviderSettings);

    if (contentProfile?.anime && ANIME_SPECIALIST_PROVIDERS.has(providerId)) {
      score += 30;
    }

    if (providerId === 'showbox' && hasShowboxCredential(privateProviderSettings)) {
      score += 25;
    }

    if (['vidlink', 'moviebox', 'vidsrc', 'vixsrc'].includes(providerId)) {
      score += 10;
    }

    if (providerId === '4khdhub' || providerId === '4khdhub_tv') {
      score += 5;
    }

    if (QUALITY_GRACE_PROVIDER_IDS.has(providerId)) {
      score += 18;
    }

    return score + this.getProviderPerformanceScore(providerId);
  }

  buildFastPhaseProviders(providers, contentProfile, privateProviderSettings, hasExplicitProviders) {
    const contentTags = Array.isArray(contentProfile?.tags) ? contentProfile.tags : [];
    const basePriorityProviders = contentTags.includes('kdrama') || contentTags.includes('asian_drama')
      ? ASIAN_DRAMA_FAST_PRIORITY_PROVIDERS
      : OLD_TITLE_PRIORITY_PROVIDERS;
    const priorityProviders = hasShowboxCredential(privateProviderSettings)
      ? ['showbox', ...basePriorityProviders.filter((providerId) => providerId !== 'showbox')]
      : basePriorityProviders;
    const orderedProviders = this.rankProvidersForFastSearch(
      reprioritizeProviders(providers, priorityProviders),
      contentProfile,
      privateProviderSettings
    );
    const phaseOneLimit = this.getFastPhaseOneLimit(orderedProviders, hasExplicitProviders);
    const phaseOneProviders = orderedProviders.slice(0, phaseOneLimit);
    const phaseTwoCandidates = orderedProviders.slice(phaseOneLimit);
    const animeCount = phaseOneProviders.filter((id) => ANIME_SPECIALIST_PROVIDERS.has(id)).length;
    const isAnime = contentProfile?.anime || animeCount >= 2;
    const remainingAnime = phaseTwoCandidates.filter((id) => ANIME_SPECIALIST_PROVIDERS.has(id));
    const remainingNonAnime = phaseTwoCandidates.filter((id) => !ANIME_SPECIALIST_PROVIDERS.has(id));
    let finalPhaseTwo;
    if (isAnime && remainingAnime.length > 0) {
      finalPhaseTwo = [...remainingAnime, ...remainingNonAnime];
    } else {
      finalPhaseTwo = phaseTwoCandidates;
    }
    const fallbackLimit = this.getAdaptiveFallbackProviderLimit(phaseTwoCandidates, new Set(phaseOneProviders));
    return {
      phaseOneProviders,
      phaseTwoProviders: finalPhaseTwo.slice(0, fallbackLimit),
      phaseTwoFallbackProviders: finalPhaseTwo.slice(fallbackLimit)
    };
  }

  buildRelaxedRetryProviderList({
    phaseOneProviders,
    phaseTwoProviders,
    phaseOneResult,
    phaseTwoResult,
    contentProfile = null,
    privateProviderSettings = null,
    hasExplicitProviders = false
  }) {
    const alreadyTried = new Map();
    for (const entry of [...(phaseOneResult?.tried || []), ...(phaseTwoResult?.tried || [])]) {
      alreadyTried.set(entry.provider, Number.isFinite(entry.count) ? entry.count : 0);
    }
    const retryCandidates = [...new Set([...phaseOneProviders, ...phaseTwoProviders])]
      .filter((providerId) => (alreadyTried.get(providerId) || 0) === 0)
      .sort((left, right) =>
        this.getProviderDynamicScore(right, contentProfile, privateProviderSettings)
        - this.getProviderDynamicScore(left, contentProfile, privateProviderSettings)
      );
    const retryLimit = hasExplicitProviders ? retryCandidates.length : Math.min(retryCandidates.length, 4);
    return retryCandidates.slice(0, retryLimit);
  }

  getMergedFastPhaseStreams({ phaseOneResult, phaseTwoResult, contentProfile = null, privateProviderSettings = null, hasExplicitProviders = false }) {
    if (!phaseTwoResult?.streams?.length) return phaseOneResult || { reason: 'phase1', providers: [], tried: [], streams: [] };
    const combinedProviders = [...new Set([...(phaseOneResult?.providers || []), ...(phaseTwoResult?.providers || [])])];
    const combinedTried = [...(phaseOneResult?.tried || []), ...(phaseTwoResult?.tried || [])];
    const combinedStreams = [...(phaseOneResult?.streams || []), ...(phaseTwoResult?.streams || [])];
    const perProviderSoftLimit = hasExplicitProviders ? Infinity
      : (combinedStreams.some((s) => ANIME_SPECIALIST_PROVIDERS.has(s.provider)) ? 2 : 4);
    const ranked = mergeAndRankProviderStreams(
      [
        { provider: 'phase1', streams: phaseOneResult?.streams || [] },
        { provider: 'phase2', streams: phaseTwoResult?.streams || [] }
      ],
      combinedProviders,
      contentProfile,
      hasExplicitProviders ? Infinity : config.STREMIO_FAST_STREAM_LIMIT,
      privateProviderSettings
    );
    const limited = !hasExplicitProviders && !privateProviderSettings?.webReadyOnly
      ? applyPerProviderSoftLimit(ranked, config.STREMIO_FAST_STREAM_LIMIT, perProviderSoftLimit)
      : ranked;

    return {
      reason: 'phase-combined',
      providers: combinedProviders,
      tried: combinedTried,
      streams: limited
    };
  }

  async executeFastProviderPhase({ phase, providerIds, contentProfile, minStreams, stopOnMinStreams, abortSignal, staggerDelayMs = 100, enforceFastTimeout = false, ...params }) {
    const streams = [];
    const tried = [];
    const providers = [];
    const abortController = new AbortController();
    allowHighFanoutAbortSignal(abortController.signal);
    let done = false;
    let providerIndex = 0;
    const concurrency = config.PROVIDER_MAX_CONCURRENCY;
    const staggerMs = staggerDelayMs || FAST_PROVIDER_STAGGER_DELAYS_MS[phase === 'phase1' ? 0 : 1] || 100;

    const launchNext = async () => {
      while (!done && providerIndex < providerIds.length) {
        const providerId = providerIds[providerIndex++];

        try {
          const providerResult = await withCombinedAbortSignal(
            [abortController.signal, abortSignal].filter(Boolean),
            async (combinedSignal) => {
              await waitForProviderSlot(staggerMs, combinedSignal);
              return this.getStreams({
                provider: providerId,
                tmdbId: params.tmdbId,
                mediaType: params.mediaType,
                season: params.season,
                episode: params.episode,
                privateProviderSettings: params.privateProviderSettings,
                priorityRequest: true,
                signal: combinedSignal,
                enforceFastTimeout
              });
            },
            `Provider ${providerId} timed out`
          );
          const count = Array.isArray(providerResult) ? providerResult.length : 0;
          streams.push(...(Array.isArray(providerResult) ? providerResult : []));
          tried.push({ provider: providerId, count });
          providers.push(providerId);

          if (stopOnMinStreams && streams.length >= minStreams) {
            done = true;
            abortController.abort(createHttpError(499, 'Provider phase aborted — early success reached'));
          }
        } catch (error) {
          if (!isProviderCancellationError(error)) {
            tried.push({ provider: providerId, count: 0 });
            providers.push(providerId);
          }
        }
      }
    };

    const workerCount = Math.min(concurrency, providerIds.length);
    const workerPromises = [];

    for (let i = 0; i < workerCount; i++) {
      workerPromises.push(launchNext());
    }

    await Promise.all(workerPromises);

    return {
      reason: done ? 'min-streams' : 'all-complete',
      providers,
      tried,
      streams
    };
  }

  async getFastStreams({ providers = null, ...rest }) {
    const contentProfile = rest.contentProfile || await this.getContentProfile(rest);
    const hasExplicitProviders = Array.isArray(providers) && providers.length > 0;

    const orderedProviders = this.getStremioProviderOrder(
      providers && providers.length > 0 ? providers : null,
      contentProfile
    );

    const prioritizedProviders = prioritizePrivateTokenProviders(orderedProviders, rest.privateProviderSettings)
      .slice(0, hasExplicitProviders ? config.STREMIO_FAST_PROVIDER_LIMIT : Infinity);
    const { phaseOneProviders, phaseTwoProviders, phaseTwoFallbackProviders } = this.buildFastPhaseProviders(
      prioritizedProviders,
      contentProfile,
      rest.privateProviderSettings,
      hasExplicitProviders
    );

    if (phaseOneProviders.length === 0) {
      throw createHttpError(400, 'No valid providers were supplied for fast search');
    }

    const requestKey = this.buildFastSearchRequestKey({
      providers,
      tmdbId: rest.tmdbId,
      imdbId: rest.imdbId,
      mediaType: rest.mediaType,
      season: rest.season,
      episode: rest.episode,
      streamOptions: rest.streamOptions,
      privateProviderSettings: rest.privateProviderSettings
    });

    const existingRequest = this.fastSearchInFlight.get(requestKey);

    if (existingRequest) {
      return existingRequest.then((result) => copyFastSearchResult(result));
    }

    if (!hasExplicitProviders) {
      const lastGood = await this.getFastLastGoodResult(requestKey);
      if (lastGood?.streams?.length) {
        logger.info('serving fast last-good result before default search', {
          tmdbId: rest.tmdbId,
          mediaType: rest.mediaType,
          resultCount: lastGood.streams.length
        });
        return lastGood;
      }
    }

    const executeSearch = async () => {
      const providerAbortControllers = new Map();
      try {
        const isAnime = Array.isArray(contentProfile?.tags) && contentProfile.tags.includes('anime');
        const primaryProviderIds = hasExplicitProviders
          ? prioritizedProviders
          : [...new Set([
            ...phaseOneProviders,
            ...phaseTwoProviders,
            ...(isAnime ? ANIME_PHASE_ONE_PRIORITY_PROVIDERS : [])
          ])]
            .filter((providerId) => prioritizedProviders.includes(providerId))
            .slice(0, Math.max(8, Math.min(10, config.STREMIO_FAST_PROVIDER_LIMIT)));
        const fallbackProviderIds = hasExplicitProviders
          ? []
          : phaseTwoFallbackProviders
            .filter((providerId) => !primaryProviderIds.includes(providerId))
            .slice(0, Math.max(4, Math.min(8, config.STREMIO_FAST_PROVIDER_LIMIT)));
        const rankingProviderOrder = prioritizedProviders;

        const defaultProviderParallelTimeoutMs = 20_000;
        const explicitProviderParallelTimeoutCapMs = 65_000;

        const runProvider = async (providerId) => {
          const providerAbortController = new AbortController();
          allowHighFanoutAbortSignal(providerAbortController.signal);
          let providerParallelTimeoutId;
          const enforceProviderFastTimeout = !hasExplicitProviders || FORCE_FAST_TIMEOUT_PROVIDER_IDS.has(providerId);
          providerAbortControllers.set(providerId, providerAbortController);

          try {
            if (rest.signal?.aborted) {
              throw rest.signal.reason || createHttpError(499, 'Fast search aborted');
            }

            const providerParallelTimeoutMs = hasExplicitProviders
              ? Math.min(
                explicitProviderParallelTimeoutCapMs,
                Math.max(
                  PROVIDER_PARALLEL_TIMEOUT_OVERRIDES_MS[providerId] || defaultProviderParallelTimeoutMs,
                  (getProviderTimeoutSeconds(providerId, {
                    privateProviderSettings: rest.privateProviderSettings,
                    enforceFastTimeout: enforceProviderFastTimeout
                  }) * 1000) + 5_000
                )
              )
              : (PROVIDER_PARALLEL_TIMEOUT_OVERRIDES_MS[providerId] || defaultProviderParallelTimeoutMs);
            const streamPromise = withCombinedAbortSignal(
              [providerAbortController.signal, rest.signal].filter(Boolean),
              (combinedSignal) => this.getStreams({
                provider: providerId,
                tmdbId: rest.tmdbId,
                imdbId: rest.imdbId,
                mediaType: rest.mediaType,
                season: rest.season,
                episode: rest.episode,
                privateProviderSettings: rest.privateProviderSettings,
                priorityRequest: true,
                signal: combinedSignal,
                enforceFastTimeout: enforceProviderFastTimeout
              }),
              `Provider ${providerId} fast search aborted`
            );
            const streams = await Promise.race([
              streamPromise,
              new Promise((_, reject) => {
                providerParallelTimeoutId = setTimeout(() => {
                  const timeoutError = createHttpError(499, `Provider ${providerId} parallel timeout`);
                  providerAbortController.abort(timeoutError);
                  reject(new Error(`Provider ${providerId} parallel timeout`));
                }, providerParallelTimeoutMs);
                providerParallelTimeoutId.unref?.();
              })
            ]);
            return { provider: providerId, streams, error: null };
          } catch (error) {
            return { provider: providerId, streams: [], error };
          } finally {
            clearTimeout(providerParallelTimeoutId);
            if (providerAbortControllers.get(providerId) === providerAbortController) {
              providerAbortControllers.delete(providerId);
            }
          }
        };

        const collectProviderResults = async (providerIds) => {
          const requiredEarlyProviders = new Set();
          if (hasShowboxCredential(rest.privateProviderSettings) && providerIds.includes('showbox')) {
            requiredEarlyProviders.add('showbox');
          }
          if (!hasExplicitProviders) {
            for (const providerId of providerIds) {
              if (DEFAULT_EARLY_RETURN_BLOCKING_PROVIDERS.has(providerId)) {
                requiredEarlyProviders.add(providerId);
              }
            }
          }
          const pending = new Map();
          let nextProviderIndex = 0;
          let stopLaunching = false;
          const providerConcurrency = Math.max(
            1,
            Math.min(providerIds.length, config.STREMIO_FAST_PROVIDER_CONCURRENCY)
          );
          const startNextProviders = () => {
            while (!stopLaunching && !rest.signal?.aborted && pending.size < providerConcurrency && nextProviderIndex < providerIds.length) {
              const index = nextProviderIndex;
              nextProviderIndex += 1;
              pending.set(index, runProvider(providerIds[index]).then((result) => ({ index, result })));
            }
          };
          const getPendingProviderIndexes = () => [
            ...pending.keys(),
            ...Array.from(
              { length: Math.max(0, providerIds.length - nextProviderIndex) },
              (_, offset) => nextProviderIndex + offset
            )
          ];
          startNextProviders();
          const results = [];
          const requiredProviderWaitMs = [...requiredEarlyProviders]
            .filter((providerId) => providerIds.includes(providerId))
            .reduce((maxWaitMs, providerId) => Math.max(
              maxWaitMs,
              (PROVIDER_PARALLEL_TIMEOUT_OVERRIDES_MS[providerId] || defaultProviderParallelTimeoutMs) + 2_000
            ), 0);
          const maxFastWaitBeforeRouteTimeout = Math.max(
            Math.min(config.STREMIO_FAST_MAX_WAIT_MS, 21_000),
            Math.min(28_000, config.STREMIO_STREAM_OVERALL_TIMEOUT_MS - 1_000)
          );
          const fastSearchStartedAt = Date.now();
          const deadline = fastSearchStartedAt + Math.min(
            Math.max(config.STREMIO_FAST_MAX_WAIT_MS, requiredProviderWaitMs),
            maxFastWaitBeforeRouteTimeout
          );
          const qualityGraceDeadline = fastSearchStartedAt + Math.min(
            config.STREMIO_QUALITY_GRACE_MS,
            maxFastWaitBeforeRouteTimeout
          );
          const premiumProviderMinDeadline = fastSearchStartedAt + Math.min(
            config.STREMIO_PREMIUM_PROVIDER_MIN_WAIT_MS,
            maxFastWaitBeforeRouteTimeout
          );
          const nuvioSoftDeadline = fastSearchStartedAt + Math.min(12_000, maxFastWaitBeforeRouteTimeout);
          const minCompletedProviders = Math.min(config.STREMIO_FAST_MIN_COMPLETED_PROVIDERS, providerIds.length);

          while (pending.size > 0) {
            if (rest.signal?.aborted) {
              stopLaunching = true;
              break;
            }

            const remainingMs = Math.max(0, deadline - Date.now());

            if (remainingMs <= 0) {
              stopLaunching = true;
              break;
            }

            const winner = await Promise.race([
              ...pending.values(),
              waitForProviderSlot(remainingMs, rest.signal).then(() => null)
            ]);

            if (!winner) {
              stopLaunching = true;
              break;
            }

            pending.delete(winner.index);
            results.push(winner.result);
            startNextProviders();

            const streamCount = results.reduce((count, result) => count + result.streams.length, 0);
            const pendingProviderIndexes = getPendingProviderIndexes();
            const pendingProviderIds = pendingProviderIndexes.map((index) => providerIds[index]);
            const pendingRequiredProviders = pendingProviderIndexes
              .map((index) => providerIds[index])
              .filter((providerId) => requiredEarlyProviders.has(providerId));
            const pendingHighValueHubProviders = !hasExplicitProviders
              ? pendingProviderIds.filter((providerId) => QUALITY_GRACE_PROVIDER_IDS.has(providerId))
              : [];
            const hasCompletedHighValueHubProvider = results.some((result) =>
              QUALITY_GRACE_PROVIDER_IDS.has(result.provider) && result.streams.length > 0
            );
            const hasCompletedStrongProvider = hasStrongProviderResult(
              results,
              rankingProviderOrder,
              contentProfile,
              rest.privateProviderSettings
            );
            const bestQualityScore = results.reduce((best, result) =>
              Math.max(best, getResultBestQualityScore(result)), 0);
            const bestProviderConfidence = results.reduce((best, result) =>
              Math.max(best, this.getProviderDynamicScore(result.provider, contentProfile, rest.privateProviderSettings)), 0);
            const pendingQualityProviders = !hasExplicitProviders
              ? pendingProviderIds.filter((providerId) => QUALITY_GRACE_PROVIDER_IDS.has(providerId))
              : [];
            const pendingHigherConfidenceProviders = pendingQualityProviders.filter((providerId) =>
              this.getProviderDynamicScore(providerId, contentProfile, rest.privateProviderSettings) > bestProviderConfidence + 12
            );
            const hasOnlyWeakNuvioResult = results.length > 0
              && results.every((result) => result.provider === 'nuvio')
              && streamCount < 3
              && pendingProviderIds
                .some((providerId) => providerId === 'moviebox' || providerId === 'vidlink' || providerId === 'cinestream');
            const hasOnlyHubResult = streamCount > 0
              && results.every((result) => result.streams.length === 0 || QUALITY_GRACE_PROVIDER_IDS.has(result.provider))
              && pendingProviderIds.some((providerId) => FAST_DIRECT_FALLBACK_PROVIDER_IDS.has(providerId));
            const shouldWaitForPendingNuvio = Date.now() < nuvioSoftDeadline
              && streamCount < 40
              && pendingProviderIds.some((providerId) => providerId.startsWith('nuvio'));
            const shouldWaitForQualityGrace = pendingQualityProviders.length > 0
              && !hasCompletedStrongProvider
              && Date.now() < qualityGraceDeadline
              && (streamCount < 8 || bestQualityScore < 1080 || pendingHigherConfidenceProviders.length > 0);
            const shouldWaitForPremiumProviderMin = pendingQualityProviders.length > 0
              && !hasCompletedStrongProvider
              && Date.now() < premiumProviderMinDeadline
              && (streamCount < 3 || (bestQualityScore < 1080 && pendingHigherConfidenceProviders.length > 0));
            const hasEnoughEmptyPrimaryWait = !hasExplicitProviders
              && streamCount === 0
              && results.length >= Math.max(3, minCompletedProviders)
              && Date.now() - fastSearchStartedAt >= 7_000
              && pendingRequiredProviders.length === 0;
            if (hasEnoughEmptyPrimaryWait) {
              stopLaunching = true;
              break;
            }
            if (
              !hasExplicitProviders &&
              results.length >= minCompletedProviders &&
              streamCount >= config.STREMIO_FAST_EARLY_RETURN_STREAMS &&
              (pendingHighValueHubProviders.length === 0 || hasCompletedHighValueHubProvider) &&
              !hasOnlyWeakNuvioResult &&
              !hasOnlyHubResult &&
              !shouldWaitForPendingNuvio &&
              !shouldWaitForQualityGrace &&
              !shouldWaitForPremiumProviderMin &&
              pendingRequiredProviders.length === 0
            ) {
              stopLaunching = true;
              break;
            }
          }

          const pendingProviderIndexes = getPendingProviderIndexes();
          if (pending.size > 0) {
            const pendingProviders = pendingProviderIndexes.map((index) => providerIds[index]);
            const resultCount = results.reduce((count, result) => count + result.streams.length, 0);
            const logPartialResults = resultCount > 0 ? logger.info.bind(logger) : logger.warn.bind(logger);
            logPartialResults('fast provider search returning partial results before slow providers finished', {
              tmdbId: rest.tmdbId,
              mediaType: rest.mediaType,
              completedProviders: compactProviderListForLog(results.map((result) => result.provider)),
              pendingProviders: compactProviderListForLog(pendingProviders),
              pendingProviderCount: pendingProviders.length,
              resultCount
            });
          }

          for (const index of pending.keys()) {
            const pendingProviderId = providerIds[index];
            providerAbortControllers.get(pendingProviderId)?.abort(createHttpError(499, 'Fast provider search returned partial result'));
          }

          return {
            results,
            partial: pendingProviderIndexes.length > 0,
            pendingProviders: pendingProviderIndexes.map((index) => providerIds[index])
          };
        };

        const primaryCollection = await collectProviderResults(primaryProviderIds);
        let settledResults = primaryCollection.results;
        let partial = primaryCollection.partial;
        let pendingProviders = primaryCollection.pendingProviders;
        const primaryStreamCount = settledResults.reduce((count, result) => count + result.streams.length, 0);
        const minimumUsefulDefaultStreams = Math.min(1, config.STREMIO_FAST_EARLY_RETURN_STREAMS);

        if (!hasExplicitProviders && fallbackProviderIds.length > 0 && primaryStreamCount < minimumUsefulDefaultStreams) {
          logger.info('fast provider search expanding after weak primary phase', {
            tmdbId: rest.tmdbId,
            mediaType: rest.mediaType,
            primaryProviders: primaryProviderIds,
            fallbackProviders: fallbackProviderIds,
            primaryStreamCount
          });
          const fallbackCollection = await collectProviderResults(fallbackProviderIds);
          settledResults = [
            ...settledResults,
            ...fallbackCollection.results
          ];
          partial = partial || fallbackCollection.partial;
          pendingProviders = [...pendingProviders, ...fallbackCollection.pendingProviders];
        }

        const allStreams = settledResults.flatMap((r) => r.streams);
        const tried = settledResults.map((r) => ({
          provider: r.provider,
          count: r.streams.length
        }));
        const allProviderIds = settledResults.map((result) => result.provider);
        const rankedProviderOrder = [
          ...rankingProviderOrder.filter((providerId) => allProviderIds.includes(providerId)),
          ...allProviderIds.filter((providerId) => !rankingProviderOrder.includes(providerId))
        ];

        const perProviderSoftLimit = hasExplicitProviders
          ? Infinity
          : (allStreams.some((s) => ANIME_SPECIALIST_PROVIDERS.has(s.provider)) ? 6 : 10);

        const ranked = mergeAndRankProviderStreams(
          settledResults.map((r) => ({ provider: r.provider, streams: r.streams })),
          rankedProviderOrder,
          contentProfile,
          hasExplicitProviders ? Infinity : config.STREMIO_FAST_STREAM_LIMIT,
          rest.privateProviderSettings
        );

        const limited = !hasExplicitProviders && !rest.privateProviderSettings?.webReadyOnly
          ? applyPerProviderSoftLimit(ranked, config.STREMIO_FAST_STREAM_LIMIT, perProviderSoftLimit)
          : ranked;

        return {
          reason: 'parallel-all',
          providers: rankedProviderOrder,
          tried,
          partial,
          pendingProviders,
          streams: limited
        };
      } finally {
        for (const controller of providerAbortControllers.values()) {
          controller.abort(createHttpError(499, 'Fast search cleanup'));
        }
        this.fastSearchInFlight.delete(requestKey);
      }
    };

    const searchPromise = executeSearch();

    this.fastSearchInFlight.set(requestKey, searchPromise);

    let result;
    try {
      result = await searchPromise;
    } catch (error) {
      const lastGood = await this.getFastLastGoodResult(requestKey);
      if (lastGood?.streams?.length) {
        logger.warn('serving fast last-good result after search failure', {
          tmdbId: rest.tmdbId,
          mediaType: rest.mediaType,
          resultCount: lastGood.streams.length,
          error
        });
        return lastGood;
      }
      throw error;
    }

    if (!result.streams.length) {
      const lastGood = await this.getFastLastGoodResult(requestKey);
      if (lastGood?.streams?.length) {
        logger.warn('serving fast last-good result after empty search', {
          tmdbId: rest.tmdbId,
          mediaType: rest.mediaType,
          resultCount: lastGood.streams.length
        });
        return lastGood;
      }
    }

    if (!result.partial || result.streams.length > 0) {
      await this.setFastLastGoodResult(requestKey, result);
    }
    return result;
  }

  async getStreams({
    provider,
    tmdbId,
    imdbId = null,
    mediaType = 'movie',
    season = null,
    episode = null,
    privateProviderSettings = null,
    priorityRequest = false,
    signal = null,
    enforceFastTimeout = false
  }) {
    const providerId = String(provider || '').trim().toLowerCase();
    const providerConfig = this.providers.get(providerId);

    if (!providerConfig) {
      throw createHttpError(404, `Unknown provider: ${provider}`);
    }
    const providerHostKey = this.getProviderHostKey(providerId);

    const normalizedTmdbId = toOptionalInteger(tmdbId);

    if (!normalizedTmdbId) {
      throw createHttpError(400, 'tmdbId must be a positive integer');
    }

    const normalizedMediaType = normalizeProviderMediaType(mediaType);

    if (normalizedMediaType !== 'movie' && normalizedMediaType !== 'tv') {
      throw createHttpError(400, 'mediaType must be movie or tv');
    }

    const normalizedSeason = toOptionalInteger(season);
    const normalizedEpisode = toOptionalInteger(episode);
    const cacheKey = JSON.stringify({
      schemaVersion: PROVIDER_RESULT_CACHE_SCHEMA_VERSION,
      version: getProviderCacheVersion(providerId),
      provider: providerId,
      tmdbId: normalizedTmdbId,
      mediaType: normalizedMediaType,
      season: normalizedSeason,
      episode: normalizedEpisode,
      privateProviderSettingsKey: getPrivateProviderSettingsKey(providerId, privateProviderSettings)
    });

    const cached = await this.getCachedResult(cacheKey);

    if (cached) {
      const cachedStreams = filterEpisodeMismatchedProviderStreams({
        streams: cached,
        providerId,
        mediaType: normalizedMediaType,
        season: normalizedSeason,
        episode: normalizedEpisode,
        tmdbId: normalizedTmdbId
      });

      if (cachedStreams.length !== cached.length) {
        await this.setCachedResult(cacheKey, cachedStreams, providerId);
      }

      this.updateProviderRuntime(providerId, {
        lastCacheHitAt: Date.now()
      });
      logger.info('provider cache hit', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        resultCount: cachedStreams.length
      });
      return cachedStreams;
    }

    const cooldownState = this.providerHealth.get(providerId);

    // Only skip due to cooldown for non-priority requests; always try providers on fast path
    if (!priorityRequest && cooldownState?.cooldownUntil && cooldownState.cooldownUntil > Date.now()) {
      const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

      if (staleFallback?.length) {
        const staleFallbackStreams = filterEpisodeMismatchedProviderStreams({
          streams: staleFallback,
          providerId,
          mediaType: normalizedMediaType,
          season: normalizedSeason,
          episode: normalizedEpisode,
          tmdbId: normalizedTmdbId
        });

        if (staleFallbackStreams.length === 0) {
          logger.warn('provider stale fallback skipped after tv episode filter', {
            provider: providerId,
            tmdbId: normalizedTmdbId,
            mediaType: normalizedMediaType,
            season: normalizedSeason,
            episode: normalizedEpisode
          });
        } else {
          logger.warn('provider served stale fallback during cooldown', {
            provider: providerId,
            tmdbId: normalizedTmdbId,
            imdbId: typeof imdbId === 'string' ? imdbId.trim() : null,
            mediaType: normalizedMediaType,
            resultCount: staleFallbackStreams.length
          });
          this.updateProviderRuntime(providerId, {
            lastCacheHitAt: Date.now(),
            lastResultCount: staleFallbackStreams.length,
            lastError: 'Served stale fallback during cooldown'
          });
          return staleFallbackStreams;
        }
      }

      logger.warn('provider skipped due to cooldown', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        cooldownUntil: new Date(cooldownState.cooldownUntil).toISOString()
      });
      return [];
    }

    const hostCooldownState = this.providerHostHealth.get(providerHostKey);

    if (!priorityRequest && hostCooldownState?.cooldownUntil && hostCooldownState.cooldownUntil > Date.now()) {
      const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

      if (staleFallback?.length) {
        logger.warn('provider served stale fallback during host cooldown', {
          provider: providerId,
          hostKey: providerHostKey,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          resultCount: staleFallback.length
        });
        this.updateProviderRuntime(providerId, {
          lastCacheHitAt: Date.now(),
          lastResultCount: staleFallback.length,
          lastError: 'Served stale fallback during host cooldown'
        });
        return staleFallback;
      }

      logger.warn('provider skipped due to host cooldown', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        cooldownUntil: new Date(hostCooldownState.cooldownUntil).toISOString()
      });
      return [];
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const execution = this.executeProviderQuery({
      cacheKey,
      providerId,
      providerConfig,
      providerHostKey,
      normalizedTmdbId,
      imdbId,
      normalizedMediaType,
      normalizedSeason,
      normalizedEpisode,
      privateProviderSettings,
      priorityRequest,
      signal,
      enforceFastTimeout
    });

    this.inFlight.set(cacheKey, execution);

    try {
      return await execution;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  async executeProviderQuery({
    cacheKey,
    providerId,
    providerConfig,
    providerHostKey,
    normalizedTmdbId,
    imdbId = null,
    normalizedMediaType,
    normalizedSeason,
    normalizedEpisode,
    privateProviderSettings,
    priorityRequest = false,
    signal = null,
    enforceFastTimeout = false
  }) {
    const startedAt = Date.now();
    const existingRuntime = this.providerRuntime.get(providerId) || {};
    this.updateProviderRuntime(providerId, {
      running: true,
      lastStartedAt: startedAt,
      lastError: null,
      totalRequests: (existingRuntime.totalRequests || 0) + 1
    });

    try {
      logger.info('provider scrape started', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType
      });

      const providerPromise = this.withProviderGlobalSlot(
        () => this.withProviderHostSlot(providerHostKey, () => this.invokeProviderWithTimeout(providerConfig, providerId, {
          tmdbId: normalizedTmdbId,
          imdbId: typeof imdbId === 'string' ? imdbId.trim() : null,
          mediaType: normalizedMediaType,
          season: normalizedSeason,
          episode: normalizedEpisode,
          privateProviderSettings,
          signal,
          enforceFastTimeout
        }), signal, priorityRequest),
        signal,
        priorityRequest
      );

      const streams = await providerPromise;

      if (!Array.isArray(streams)) {
        throw createHttpError(502, `Provider ${providerId} returned an invalid stream payload`);
      }

      let normalizedStreams = streams
        .map((stream) => sanitizeProviderStream(stream))
        .filter(Boolean);

      normalizedStreams = filterEpisodeMismatchedProviderStreams({
        streams: normalizedStreams,
        providerId,
        mediaType: normalizedMediaType,
        season: normalizedSeason,
        episode: normalizedEpisode,
        tmdbId: normalizedTmdbId
      });

      if (normalizedStreams.length !== streams.length) {
        logger.warn('provider returned invalid streams', {
          provider: providerId,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          droppedCount: streams.length - normalizedStreams.length
        });
      }

      if (providerId === 'nuvio') {
        const fallbackStreams = await this.getNuvioHubFallbackStreams({
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          season: normalizedSeason,
          episode: normalizedEpisode,
          privateProviderSettings,
          signal
        }, normalizedStreams);

        if (fallbackStreams.length > 0) {
          normalizedStreams = mergeAndRankProviderStreams(
            [
              { provider: 'nuvio', streams: normalizedStreams },
              { provider: 'nuvio-hub-fallback', streams: fallbackStreams }
            ],
            ['4khdhub', 'hdhub4u', 'nuvio'],
            null,
            Infinity,
            privateProviderSettings
          );
          logger.info('nuvio hub fallback added streams', {
            tmdbId: normalizedTmdbId,
            mediaType: normalizedMediaType,
            fallbackCount: fallbackStreams.length,
            resultCount: normalizedStreams.length
          });
        }
      }

      normalizedStreams = filterEpisodeMismatchedProviderStreams({
        streams: normalizedStreams,
        providerId,
        mediaType: normalizedMediaType,
        season: normalizedSeason,
        episode: normalizedEpisode,
        tmdbId: normalizedTmdbId
      });

      await this.setCachedResult(cacheKey, normalizedStreams, providerId);

      if (normalizedStreams.length === 0 && STALE_IF_ERROR_PROVIDERS.has(providerId)) {
        const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

        if (staleFallback?.length) {
          const staleRuntime = this.providerRuntime.get(providerId) || {};
          this.updateProviderRuntime(providerId, {
            running: false,
            lastFinishedAt: Date.now(),
            lastDurationMs: Date.now() - startedAt,
            lastResultCount: staleFallback.length,
            lastError: 'Served stale fallback after empty result',
            totalSuccesses: (staleRuntime.totalSuccesses || 0) + 1,
            consecutiveFailures: 0
          });
          logger.warn('provider served stale fallback after empty result', {
            provider: providerId,
            hostKey: providerHostKey,
            tmdbId: normalizedTmdbId,
            mediaType: normalizedMediaType,
            resultCount: staleFallback.length
          });
          return staleFallback;
        }
      }

      this.providerHealth.delete(providerId);
      this.providerHostHealth.delete(providerHostKey);
      const successRuntime = this.providerRuntime.get(providerId) || {};
      this.updateProviderRuntime(providerId, {
        running: false,
        lastFinishedAt: Date.now(),
        lastDurationMs: Date.now() - startedAt,
        lastResultCount: normalizedStreams.length,
        lastError: null,
        totalSuccesses: (successRuntime.totalSuccesses || 0) + 1,
        consecutiveFailures: 0
      });
      logger.info('provider scrape finished', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        resultCount: normalizedStreams.length
      });

      return normalizedStreams;
    } catch (error) {
      if (error?.statusCode === 504) {
        // Don't record failures for timeouts - timeouts are expected with many providers
        // Just log and return empty (or stale fallback)
        const timeoutRuntime = this.providerRuntime.get(providerId) || {};
        this.updateProviderRuntime(providerId, {
          running: false,
          lastFinishedAt: Date.now(),
          lastDurationMs: Date.now() - startedAt,
          lastResultCount: 0,
          lastError: error.message || 'Provider timed out',
          totalFailures: (timeoutRuntime.totalFailures || 0) + 1,
          consecutiveFailures: (timeoutRuntime.consecutiveFailures || 0) + 1
        });
        logger.info('provider scrape timed out (no cooldown penalty)', {
          provider: providerId,
          hostKey: providerHostKey,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType
        });

        const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

        if (staleFallback?.length) {
          logger.info('provider served stale fallback after timeout', {
            provider: providerId,
            hostKey: providerHostKey,
            tmdbId: normalizedTmdbId,
            mediaType: normalizedMediaType,
            resultCount: staleFallback.length
          });
          this.updateProviderRuntime(providerId, {
            running: false,
            lastFinishedAt: Date.now(),
            lastDurationMs: Date.now() - startedAt,
            lastResultCount: staleFallback.length,
            lastError: 'Served stale fallback after timeout'
          });
          await this.deleteCachedResult(cacheKey);
          return staleFallback;
        }

        // Cache empty result with empty-cache TTL to prevent hammering
        await this.setCachedResult(cacheKey, [], providerId);
        return [];
      }

      if (isProviderCancellationError(error)) {
        const cancelledRuntime = this.providerRuntime.get(providerId) || {};
        this.updateProviderRuntime(providerId, {
          running: false,
          lastFinishedAt: Date.now(),
          lastDurationMs: Date.now() - startedAt,
          lastResultCount: 0,
          lastError: error?.message || error?.name || 'Provider request cancelled',
          totalFailures: cancelledRuntime.totalFailures || 0,
          consecutiveFailures: cancelledRuntime.consecutiveFailures || 0
        });
        logger.info('provider scrape cancelled, skipping failure recording', {
          provider: providerId,
          hostKey: providerHostKey,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          error: error?.message || error?.name || 'Unknown cancellation'
        });
        return [];
      }

      this.recordProviderFailure(providerId);
      this.recordProviderHostFailure(providerHostKey);
      const failureRuntime = this.providerRuntime.get(providerId) || {};
      this.updateProviderRuntime(providerId, {
        running: false,
        lastFinishedAt: Date.now(),
        lastDurationMs: Date.now() - startedAt,
        lastResultCount: 0,
        lastError: error?.message || 'Provider scrape failed',
        totalFailures: (failureRuntime.totalFailures || 0) + 1,
        consecutiveFailures: (failureRuntime.consecutiveFailures || 0) + 1
      });
      logger.error('provider scrape failed', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        error
      });

      const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

      if (staleFallback?.length) {
        logger.warn('provider served stale fallback after failure', {
          provider: providerId,
          hostKey: providerHostKey,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          resultCount: staleFallback.length
        });
        this.updateProviderRuntime(providerId, {
          running: false,
          lastFinishedAt: Date.now(),
          lastDurationMs: Date.now() - startedAt,
          lastResultCount: staleFallback.length,
          lastError: 'Served stale fallback after failure'
        });
        await this.deleteCachedResult(cacheKey);
        return staleFallback;
      }

      await this.deleteCachedResult(cacheKey);
      return [];
    }
  }

  async invokeProviderWithTimeout(providerConfig, providerId, params) {
    let timeoutId;
    const abortController = new AbortController();
    allowHighFanoutAbortSignal(abortController.signal);
    const timeoutSeconds = getProviderTimeoutSeconds(providerId, params);
    const externalSignal = params?.signal || null;
    allowHighFanoutAbortSignal(externalSignal);
    const requiresExplicitCancellationRace = Boolean(externalSignal);
    const cancelledError = createHttpError(499, 'Provider request cancelled');
    let abortHandler = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const timeoutError = createHttpError(504, `Provider ${providerId} timed out`);
        abortController.abort(cancelledError);
        reject(timeoutError);
      }, timeoutSeconds * 1000);
      timeoutId.unref?.();
    });
    const cancellationPromise = requiresExplicitCancellationRace
      ? new Promise((_, reject) => {
        if (externalSignal.aborted) {
          reject(cancelledError);
          return;
        }

        abortHandler = () => {
          abortController.abort(cancelledError);
          reject(cancelledError);
        };

        externalSignal.addEventListener('abort', abortHandler, { once: true });
      })
      : null;

    const runProvider = () => providerFetchContextStorage.run(
      {
        providerId
      },
      () => this.invokeProvider(providerConfig, providerId, params)
    );

    const providerPromise = withCombinedAbortSignal(
      [abortController.signal, externalSignal].filter(Boolean),
      (combinedSignal) => {
        if (SIGNAL_INCOMPATIBLE_PROVIDERS.has(providerId)) {
          return runProvider();
        }

        return providerAbortSignalStorage.run(
          combinedSignal,
          () => runProvider()
        );
      },
      `Provider ${providerId} timed out`
    );

    const pending = [
      providerPromise,
      timeoutPromise
    ];

    if (cancellationPromise) {
      pending.push(cancellationPromise);
    }

    return Promise.race(pending).finally(() => {
      clearTimeout(timeoutId);
      if (abortHandler && externalSignal) {
        externalSignal.removeEventListener('abort', abortHandler);
      }
    });
  }

  async withProviderGlobalSlot(fn, signal = null, priorityRequest = false) {
    const maxInflight = config.PROVIDER_GLOBAL_MAX_INFLIGHT + (priorityRequest ? EXPLICIT_PROVIDER_GLOBAL_LANE_BONUS : 0);

    while (this.providerGlobalInflight >= maxInflight) {
      await waitForProviderSlot(50, signal);
    }

    if (signal?.aborted) {
      throw getAbortReason(signal);
    }

    this.providerGlobalInflight += 1;

    try {
      return await fn();
    } finally {
      this.providerGlobalInflight = Math.max(this.providerGlobalInflight - 1, 0);
    }
  }

  getProviderHostKey(providerId) {
    return String(providerId || '')
      .trim()
      .toLowerCase()
      .replace(/(?:_tv|-tv)$/u, '');
  }

  async withProviderHostSlot(hostKey, fn, signal = null, priorityRequest = false) {
    const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';
    const baseMaxInflight = PROVIDER_HOST_MAX_INFLIGHT_OVERRIDES[normalizedHostKey] || config.PROVIDER_HOST_MAX_INFLIGHT;
    const maxInflight = baseMaxInflight + (priorityRequest ? EXPLICIT_PROVIDER_HOST_LANE_BONUS : 0);

    while ((this.providerHostInflight.get(normalizedHostKey) || 0) >= maxInflight) {
      await waitForProviderSlot(100, signal);
    }

    if (signal?.aborted) {
      throw getAbortReason(signal);
    }

    this.providerHostInflight.set(
      normalizedHostKey,
      (this.providerHostInflight.get(normalizedHostKey) || 0) + 1
    );

    try {
      return await fn();
    } finally {
      const remaining = Math.max((this.providerHostInflight.get(normalizedHostKey) || 1) - 1, 0);

      if (remaining === 0) {
        this.providerHostInflight.delete(normalizedHostKey);
      } else {
        this.providerHostInflight.set(normalizedHostKey, remaining);
      }
    }
  }

  recordProviderFailure(providerId) {
    const now = Date.now();
    const current = this.providerHealth.get(providerId) || { failures: 0, cooldownUntil: 0 };
    const failures = current.cooldownUntil && current.cooldownUntil <= now
      ? 1
      : current.failures + 1;
    const failureThreshold = getProviderFailureThreshold(providerId);
    const nextState = {
      failures,
      cooldownUntil: failures >= failureThreshold
        ? now + getProviderCooldownMs(providerId)
        : 0
    };

    this.providerHealth.set(providerId, nextState);

    if (nextState.cooldownUntil > now) {
      logger.warn('provider entered cooldown', {
        provider: providerId,
        failures,
        failureThreshold,
        cooldownUntil: new Date(nextState.cooldownUntil).toISOString()
      });
    }
  }

  recordProviderHostFailure(hostKey) {
    const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';
    const now = Date.now();
    const current = this.providerHostHealth.get(normalizedHostKey) || { failures: 0, cooldownUntil: 0 };
    const failures = current.cooldownUntil && current.cooldownUntil <= now
      ? 1
      : current.failures + 1;
    const failureThreshold = getProviderHostFailureThreshold(normalizedHostKey);
    const nextState = {
      failures,
      cooldownUntil: failures >= failureThreshold
        ? now + getProviderHostCooldownMs(normalizedHostKey)
        : 0
    };

    this.providerHostHealth.set(normalizedHostKey, nextState);

    if (nextState.cooldownUntil > now) {
      logger.warn('provider host entered cooldown', {
        hostKey: normalizedHostKey,
        failures,
        failureThreshold,
        cooldownUntil: new Date(nextState.cooldownUntil).toISOString()
      });
    }
  }

  async getCachedResult(cacheKey) {
    const entry = this.resultCache.get(cacheKey);

    if (!entry) {
      return this.getDiskCachedResult(cacheKey);
    }

    if (entry.expiresAt <= Date.now()) {
      this.resultCache.delete(cacheKey);
      return this.getDiskCachedResult(cacheKey);
    }

    touchMapEntry(this.resultCache, cacheKey, entry);
    return deserializeStreams(entry.serializedStreams);
  }

  async getDiskCachedResult(cacheKey) {
    const cachePath = this.getCacheFilePath(cacheKey);

    try {
      const payload = JSON.parse(await readFile(cachePath, 'utf8'));
      const serializedStreams = typeof payload?.serializedStreams === 'string'
        ? payload.serializedStreams
        : Array.isArray(payload?.streams)
          ? serializeStreams(payload.streams)
          : '';
      const hydratedStreams = deserializeStreams(serializedStreams);

      if (!payload || payload.expiresAt <= Date.now() || hydratedStreams.length === 0 && !serializedStreams) {
        await rm(cachePath, { force: true });
        return null;
      }

      const entry = {
        serializedStreams,
        approxBytes: getSerializedApproxBytes(serializedStreams),
        expiresAt: payload.expiresAt
      };

      touchMapEntry(this.resultCache, cacheKey, entry);
      pruneMapByMaxEntries(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES);
      pruneMapByApproxBytes(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);
      logger.info('provider disk cache hit', {
        cacheKey: this.hashCacheKey(cacheKey),
        resultCount: hydratedStreams.length
      });
      return hydratedStreams;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('provider disk cache read failed', {
          cacheKey: this.hashCacheKey(cacheKey),
          error
        });
      }

      return null;
    }
  }

  async getStaleFallbackResult(cacheKey, providerId = null) {
    if (!providerId || !STALE_IF_ERROR_PROVIDERS.has(providerId)) {
      return null;
    }

    const cachePath = this.getStaleFallbackCacheFilePath(cacheKey);

    try {
      const payload = JSON.parse(await readFile(cachePath, 'utf8'));
      const serializedStreams = typeof payload?.serializedStreams === 'string'
        ? payload.serializedStreams
        : Array.isArray(payload?.streams)
          ? serializeStreams(payload.streams)
          : '';
      const hydratedStreams = deserializeStreams(serializedStreams);

      if (!payload || payload.expiresAt <= Date.now() || hydratedStreams.length === 0) {
        await rm(cachePath, { force: true });
        return null;
      }

      logger.info('provider stale fallback cache hit', {
        provider: providerId,
        cacheKey: this.hashCacheKey(cacheKey),
        resultCount: hydratedStreams.length
      });
      return hydratedStreams;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('provider stale fallback cache read failed', {
          provider: providerId,
          cacheKey: this.hashCacheKey(cacheKey),
          error
        });
      }

      return null;
    }
  }

  async setCachedResult(cacheKey, streams, providerId = null) {
    if (streams.length === 0 && providerId && NO_EMPTY_CACHE_PROVIDERS.has(providerId)) {
      this.resultCache.delete(cacheKey);
      try {
        await rm(this.getCacheFilePath(cacheKey), { force: true });
      } catch { }
      return;
    }

    const cacheTtlSeconds = getProviderResultCacheTtlSeconds(streams, providerId);
    const serializedStreams = serializeStreams(streams);
    const entry = {
      serializedStreams,
      approxBytes: getSerializedApproxBytes(serializedStreams),
      expiresAt: Date.now() + (cacheTtlSeconds * 1000)
    };

    touchMapEntry(this.resultCache, cacheKey, entry);
    pruneMapByMaxEntries(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES);
    pruneMapByApproxBytes(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);

    try {
      await writeFile(this.getCacheFilePath(cacheKey), JSON.stringify({
        expiresAt: entry.expiresAt,
        serializedStreams
      }));
    } catch (error) {
      logger.warn('provider disk cache write failed', {
        cacheKey: this.hashCacheKey(cacheKey),
        error
      });
    }

    if (providerId && STALE_IF_ERROR_PROVIDERS.has(providerId) && streams.length > 0) {
      try {
        await writeFile(this.getStaleFallbackCacheFilePath(cacheKey), JSON.stringify({
          expiresAt: Date.now() + (config.PROVIDER_CACHE_TTL_SECONDS * 4 * 1000),
          serializedStreams
        }));
      } catch (error) {
        logger.warn('provider stale fallback cache write failed', {
          provider: providerId,
          cacheKey: this.hashCacheKey(cacheKey),
          error
        });
      }
    }
  }

  async deleteCachedResult(cacheKey) {
    this.resultCache.delete(cacheKey);

    try {
      await rm(this.getCacheFilePath(cacheKey), { force: true });
    } catch { }
  }

  normalizeProviders(providers) {
    const requestedProviders = Array.isArray(providers) ? providers : this.getProviderOrder();

    return requestedProviders
      .map((provider) => String(provider || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((provider, index, list) => list.indexOf(provider) === index)
      .filter((provider) => this.providers.has(provider));
  }

  getProviderOrderBase() {
    const discoveredIds = Array.from(this.providers.keys()).sort();
    const ordered = [];

    for (const providerId of PROVIDER_PRIORITY) {
      if (this.providers.has(providerId)) {
        ordered.push(providerId);
      }
    }

    for (const providerId of discoveredIds) {
      if (!ordered.includes(providerId)) {
        ordered.push(providerId);
      }
    }

    return ordered;
  }

  getProviderOrder(contentProfile = null, requestedProviders = null) {
    const baseOrder = this.getProviderOrderBase();
    const baseIndex = new Map(baseOrder.map((providerId, index) => [providerId, index]));
    const candidates = Array.isArray(requestedProviders)
      ? requestedProviders
        .map((provider) => String(provider || '').trim().toLowerCase())
        .filter(Boolean)
        .filter((provider, index, list) => list.indexOf(provider) === index)
        .filter((provider) => this.providers.has(provider))
      : baseOrder;

    if (!contentProfile || !Array.isArray(contentProfile.tags) || contentProfile.tags.length === 0) {
      return candidates;
    }

    return [...candidates].sort((left, right) => {
      const boostDelta = getProviderContentBoost(right, contentProfile) - getProviderContentBoost(left, contentProfile);

      if (boostDelta !== 0) {
        return boostDelta;
      }

      return (baseIndex.get(left) ?? Number.MAX_SAFE_INTEGER) - (baseIndex.get(right) ?? Number.MAX_SAFE_INTEGER);
    });
  }

  async getTmdbMetadata({ tmdbId, mediaType }) {
    const normalizedTmdbId = toOptionalInteger(tmdbId);
    const normalizedMediaType = String(mediaType || 'movie').trim().toLowerCase() === 'tv' ? 'tv' : 'movie';

    if (!normalizedTmdbId) {
      return null;
    }

    const cacheKey = `${normalizedMediaType}:${normalizedTmdbId}`;
    const cached = this.tmdbMetadataCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      touchMapEntry(this.tmdbMetadataCache, cacheKey, cached);
      return cached.value;
    }

    if (this.tmdbMetadataInFlight.has(cacheKey)) {
      return this.tmdbMetadataInFlight.get(cacheKey);
    }

    const request = (async () => {
      let lastError = null;

      for (let attempt = 0; attempt <= TMDB_METADATA_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const response = await fetch(`https://api.themoviedb.org/3/${normalizedMediaType}/${normalizedTmdbId}?api_key=${config.TMDB_API_KEY}`, {
            headers: {
              Accept: 'application/json',
              'Accept-Encoding': 'identity'
            },
            signal: AbortSignal.timeout(8_000)
          });

          if (!response.ok) {
            throw new Error(`TMDB metadata HTTP ${response.status}`);
          }

          const metadata = await response.json();

          this.tmdbMetadataCache.set(cacheKey, {
            value: metadata,
            expiresAt: Date.now() + TMDB_METADATA_CACHE_TTL_MS
          });
          pruneMapByMaxEntries(this.tmdbMetadataCache, config.TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES);

          return metadata;
        } catch (error) {
          lastError = error;

          if (attempt < TMDB_METADATA_RETRY_DELAYS_MS.length) {
            await delay(TMDB_METADATA_RETRY_DELAYS_MS[attempt]);
          }
        }
      }

      if (cached?.value) {
        logger.warn('using stale tmdb metadata after fetch failure', {
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          error: lastError
        });
        return cached.value;
      }

      throw lastError;
    })();

    this.tmdbMetadataInFlight.set(cacheKey, request);

    try {
      return await request;
    } finally {
      this.tmdbMetadataInFlight.delete(cacheKey);
    }
  }

  buildContentProfile(metadata, mediaType) {
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const originalLanguage = String(metadata.original_language || '').toLowerCase();
    const genreNames = new Set(
      Array.isArray(metadata.genres)
        ? metadata.genres.map((genre) => String(genre?.name || '').toLowerCase()).filter(Boolean)
        : []
    );
    const originCountries = new Set(
      [
        ...(Array.isArray(metadata.origin_country) ? metadata.origin_country : []),
        ...(Array.isArray(metadata.production_countries)
          ? metadata.production_countries.map((country) => country?.iso_3166_1)
          : [])
      ]
        .map((country) => String(country || '').toUpperCase())
        .filter(Boolean)
    );
    const tags = [];
    const isAnimation = genreNames.has('animation');
    const isAnime = isAnimation && (originalLanguage === 'ja' || originCountries.has('JP'));

    if (isAnime) {
      tags.push('anime');
    }

    if (
      mediaType === 'tv' &&
      !isAnime &&
      (originalLanguage === 'ko' || originCountries.has('KR'))
    ) {
      tags.push('kdrama');
    }

    if (
      mediaType === 'tv' &&
      !isAnime &&
      (
        ASIAN_DRAMA_LANGUAGES.has(originalLanguage) ||
        [...originCountries].some((country) => ASIAN_DRAMA_COUNTRIES.has(country))
      )
    ) {
      tags.push('asian_drama');
    }

    if (INDIAN_LANGUAGES.has(originalLanguage) || originCountries.has('IN')) {
      tags.push('indian');
    }

    if (originalLanguage === 'tr' || originCountries.has('TR')) {
      tags.push('turkish');
    }

    if (originalLanguage === 'it' || originCountries.has('IT')) {
      tags.push('italian');
    }

    if (originalLanguage === 'pt' || originCountries.has('BR') || originCountries.has('PT')) {
      tags.push('portuguese');
    }

    if (originalLanguage === 'fr' || originCountries.has('FR')) {
      tags.push('french');
    }

    if (originalLanguage === 'de' || originCountries.has('DE') || originCountries.has('AT')) {
      tags.push('german');
    }

    if (originalLanguage === 'es') {
      tags.push('spanish');
    }

    if (originalLanguage === 'ar' || [...originCountries].some((country) => ARABIC_COUNTRIES.has(country))) {
      tags.push('arabic');
    }

    const dateValue = mediaType === 'tv'
      ? metadata.first_air_date
      : metadata.release_date;
    const releaseYear = Number.parseInt(String(dateValue || '').slice(0, 4), 10);

    return {
      mediaType,
      originalLanguage,
      originCountries: [...originCountries],
      genreNames: [...genreNames],
      releaseYear: Number.isInteger(releaseYear) ? releaseYear : null,
      tags
    };
  }

  loadProviderModule(providerConfig, providerId = providerConfig.id) {
    if (this.moduleCache.has(providerConfig.modulePath)) {
      return this.moduleCache.get(providerConfig.modulePath);
    }

    let loadedModule;

    try {
      loadedModule = require(providerConfig.modulePath);
    } catch (error) {
      logger.error('provider module load failed', {
        provider: providerId,
        modulePath: providerConfig.modulePath,
        error
      });
      throw createHttpError(500, `Provider ${providerId} could not be loaded`);
    }

    if (!loadedModule || typeof loadedModule.getStreams !== 'function') {
      throw createHttpError(500, `Provider ${providerId} does not export getStreams`);
    }

    this.moduleCache.set(providerConfig.modulePath, loadedModule);
    return loadedModule;
  }

  async invokeProvider(providerConfig, providerId, params) {
    if (providerId === 'r2-plugin') {
      return this.invokeR2PluginProvider(params);
    }

    if (providerConfig.kind === 'plugin-adapter') {
      const adapter = this.pluginProviderRegistry.getAdapter(providerConfig.adapterId);

      if (!adapter) {
        throw createHttpError(500, `Plugin adapter ${providerConfig.adapterId} is not registered`);
      }

      return adapter.getStreams({
        providerId,
        tmdbId: params.tmdbId,
        imdbId: params.imdbId,
        mediaType: params.mediaType,
        season: params.season,
        episode: params.episode,
        privateProviderSettings: params.privateProviderSettings,
        signal: params.signal
      });
    }

    if (providerConfig.invocation === 'subprocess') {
      return this.invokeProviderSubprocess(providerConfig, providerId, params);
    }

    const providerModule = this.loadProviderModule(providerConfig, providerId);

    if (providerId === 'showbox') {
      return Promise.resolve().then(() => providerModule.getStreams(
        params.tmdbId,
        params.mediaType,
        params.season,
        params.episode,
        {
          uiToken: String(params.privateProviderSettings?.febboxUiCookie || '').trim(),
          ossGroup: String(params.privateProviderSettings?.showboxOssGroup || '').trim()
        }
      ));
    }

    return Promise.resolve().then(() => providerModule.getStreams(
      params.tmdbId,
      params.mediaType,
      params.season,
      params.episode
    ));
  }

  async invokeR2PluginProvider(params) {
    const sourceProviders = [
      '4khdhub',
      'scrapling-4khdhub',
      'uhdmovies',
      'hdhub4u',
      'vidlink',
      'moviebox'
    ].filter((providerId) => providerId !== 'r2-plugin' && this.providers.has(providerId));
    const results = [];
    let nextIndex = 0;
    const startedAt = Date.now();
    const deadlineMs = 24_000;
    const earlyReturnCount = 6;
    const workerCount = Math.min(2, sourceProviders.length);

    const normalizeAdapterStream = (stream, sourceProvider) => ({
      ...stream,
      provider: 'r2-plugin',
      sourceProvider: `r2-plugin:${sourceProvider}`,
      pluginProvider: sourceProvider,
      pluginProviderName: 'from adapter',
      sourceSite: 'from adapter',
      name: stream.name || 'R2 plugin',
      title: stream.title || stream.name || 'from adapter',
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        bingeGroup: stream.behaviorHints?.bingeGroup || `r2-plugin:${sourceProvider}`
      }
    });

    const worker = async () => {
      while (nextIndex < sourceProviders.length && Date.now() - startedAt < deadlineMs) {
        const sourceProvider = sourceProviders[nextIndex];
        nextIndex += 1;

        try {
          const streams = await this.getStreams({
            provider: sourceProvider,
            tmdbId: params.tmdbId,
            mediaType: params.mediaType,
            season: params.season,
            episode: params.episode,
            privateProviderSettings: params.privateProviderSettings,
            priorityRequest: true,
            enforceFastTimeout: true,
            signal: params.signal
          });

          if (Array.isArray(streams) && streams.length > 0) {
            results.push(...streams.map((stream) => normalizeAdapterStream(stream, sourceProvider)));
          }

          if (results.length >= earlyReturnCount) {
            return;
          }
        } catch (error) {
          logger.info('r2 plugin source provider failed', {
            provider: sourceProvider,
            error: error?.message || String(error)
          });
        }
      }
    };

    await Promise.race([
      Promise.all(Array.from({ length: workerCount }, () => worker())),
      new Promise((resolve) => {
        const interval = setInterval(() => {
          if (results.length >= earlyReturnCount || Date.now() - startedAt >= deadlineMs) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
        interval.unref?.();
      }),
      new Promise((resolve) => {
        const timeout = setTimeout(resolve, deadlineMs);
        timeout.unref?.();
      })
    ]);

    return results;
  }

  async getNuvioHubFallbackStreams(params, existingStreams = []) {
    if (hasUltraHighQualityStream(existingStreams)) {
      return [];
    }

    const fallbackProviders = params.mediaType === 'tv'
      ? ['4khdhub', 'hdhub4u']
      : ['4khdhub', 'hdhub4u'];
    const fallbackPromise = Promise.allSettled(
      fallbackProviders.map((provider) => this.getStreams({
        provider,
        tmdbId: params.tmdbId,
        mediaType: params.mediaType,
        season: params.season,
        episode: params.episode,
        privateProviderSettings: params.privateProviderSettings,
        priorityRequest: true,
        signal: params.signal,
        enforceFastTimeout: true
      }))
    );
    const settled = await withFallbackTimeout(fallbackPromise, 8_000, []);

    return (Array.isArray(settled) ? settled : [])
      .flatMap((result) => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : [])
      .filter((stream) => toQualityScore(stream?.quality) >= 1080);
  }

  async invokeProviderSubprocess(providerConfig, providerId, params) {
    const { stdout } = await execFileAsync(process.execPath, [
      providerConfig.runnerPath,
      String(params.tmdbId),
      String(params.mediaType),
      params.season === null ? '' : String(params.season),
      params.episode === null ? '' : String(params.episode)
    ], {
      cwd: process.cwd(),
      timeout: (config.PROVIDER_TIMEOUT_SECONDS * 1000) + 2000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env
    });

    try {
      return JSON.parse(stdout || '[]');
    } catch (error) {
      logger.warn('provider subprocess returned invalid JSON', {
        provider: providerId,
        error
      });
      return [];
    }
  }

  getCacheFilePath(cacheKey) {
    return path.join(this.providerCacheDir, `${this.hashCacheKey(cacheKey)}.json`);
  }

  getStaleFallbackCacheFilePath(cacheKey) {
    return path.join(this.providerCacheDir, `${this.hashCacheKey(cacheKey)}.stale.json`);
  }

  hashCacheKey(cacheKey) {
    return crypto.createHash('sha256').update(cacheKey).digest('hex');
  }

  async removeExpiredDiskEntries() {
    let entries = [];

    try {
      entries = await readdir(this.providerCacheDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      return;
    }

    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const filePath = path.join(this.providerCacheDir, entry.name);

        try {
          const payload = JSON.parse(await readFile(filePath, 'utf8'));

          if (!payload || payload.expiresAt <= Date.now()) {
            await rm(filePath, { force: true });
          }
        } catch {
          await rm(filePath, { force: true });
        }
      }));
  }
}
