import path from 'node:path';

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
};

const toPositiveNumber = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
};

const toBoundedInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value ?? '', 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
};

const toBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const toStringList = (value) => {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry, index, values) => values.indexOf(entry) === index);
};

const toProxyRuleList = (value) => {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');

      if (separatorIndex <= 0) {
        return null;
      }

      const pattern = entry.slice(0, separatorIndex).trim().toLowerCase();
      const proxyUrl = entry.slice(separatorIndex + 1).trim();

      if (!pattern || !proxyUrl) {
        return null;
      }

      try {
        const parsedProxyUrl = new URL(proxyUrl);

        if (!['http:', 'https:'].includes(parsedProxyUrl.protocol)) {
          return null;
        }

        return {
          pattern,
          proxyUrl: parsedProxyUrl.toString()
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || 'https://nebula.work.gd').trim().replace(/\/+$/u, '');
const defaultStatusPageUrl = `${publicBaseUrl}/status/nebula`;

export const config = Object.freeze({
  PORT: toPositiveInteger(process.env.PORT, 3000),
  CACHE_DIR: path.resolve(process.cwd(), process.env.CACHE_DIR || './cache'),
  PUBLIC_BASE_URL: publicBaseUrl,
  STATUS_PAGE_URL: String(process.env.STATUS_PAGE_URL || defaultStatusPageUrl).trim().replace(/\/+$/u, ''),
  UPTIME_KUMA_TARGET: String(process.env.UPTIME_KUMA_TARGET || `http://127.0.0.1:${process.env.UPTIME_KUMA_PORT || '3001'}`).trim().replace(/\/+$/u, ''),
  REVERSE_PROXY_TARGET: String(process.env.REVERSE_PROXY_TARGET || '').trim().replace(/\/+$/u, ''),
  REVERSE_PROXY_TIMEOUT_SECONDS: toPositiveInteger(process.env.REVERSE_PROXY_TIMEOUT_SECONDS, 120),
  REVERSE_PROXY_REJECT_UNAUTHORIZED: toBoolean(process.env.REVERSE_PROXY_REJECT_UNAUTHORIZED, true),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'sohil@123',
  STREMIO_ADDON_ID: process.env.STREMIO_ADDON_ID || 'community.nebulastreams',
  STREMIO_ADDON_ID_SCOPE_BY_HOST: toBoolean(process.env.STREMIO_ADDON_ID_SCOPE_BY_HOST, true),
  STREMIO_LEGACY_ADDON_HOSTS: toStringList(process.env.STREMIO_LEGACY_ADDON_HOSTS || 'onrender.com'),
  STREMIO_ADDON_NAME: process.env.STREMIO_ADDON_NAME || 'NebulaStreams',
  SCRAPLING_SERVICE_URL: String(process.env.SCRAPLING_SERVICE_URL || 'http://127.0.0.1:8787').trim().replace(/\/+$/u, ''),
  SCRAPLING_SERVICE_TIMEOUT_MS: toBoundedInteger(process.env.SCRAPLING_SERVICE_TIMEOUT_MS, 32000, 3000, 60000),
  SCRAPLING_SERVICE_AUTOSTART: toBoolean(process.env.SCRAPLING_SERVICE_AUTOSTART, true),
  CONFIGURATION_DESCRIPTION: String(process.env.CONFIGURATION_DESCRIPTION || 'Fast multi-provider HTTP stream addon for movies and series').trim() || 'Fast multi-provider HTTP stream addon for movies and series',
  INCLUDE_LIVE_CATALOGS: toBoolean(process.env.INCLUDE_LIVE_CATALOGS, false),
  DISABLED_SOURCES: toStringList(process.env.DISABLED_SOURCES || process.env.DISABLED_PROVIDERS || ''),
  PROXY_CONFIG: toProxyRuleList(process.env.PROXY_CONFIG || ''),
  DONATION_PRIMARY_URL: process.env.DONATION_PRIMARY_URL || 'https://ko-fi.com/redx115775',
  DONATION_SECONDARY_URL: process.env.DONATION_SECONDARY_URL || '',
  DONATION_NOWPAYMENTS_WIDGET_URL: process.env.DONATION_NOWPAYMENTS_WIDGET_URL || 'https://nowpayments.io/embeds/donation-widget?api_key=3acd79dd-66e2-48c4-9a7a-8938cb9a7a12',
  DONATION_CRYPTO_LABEL: process.env.DONATION_CRYPTO_LABEL || 'USDT (TRC20)',
  DONATION_CRYPTO_ADDRESS: process.env.DONATION_CRYPTO_ADDRESS || 'TF1WTj7BZVdU64rtMHsKwKrbqVXWtSynoD',
  TMDB_API_KEY: process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c',
  REDIS_URL: String(process.env.REDIS_URL || '').trim(),
  REDIS_CACHE_PREFIX: String(process.env.REDIS_CACHE_PREFIX || 'nebulastreams').trim() || 'nebulastreams',
  MAX_CACHE_SIZE_GB: toPositiveNumber(process.env.MAX_CACHE_SIZE_GB, 2),
  MAX_ACTIVE_TORRENTS: toBoundedInteger(process.env.MAX_ACTIVE_TORRENTS, 1, 1, 2),
  TORRENT_CONNECTIONS: toBoundedInteger(process.env.TORRENT_CONNECTIONS, 40, 20, 100),
  TORRENT_METADATA_TIMEOUT_SECONDS: toPositiveInteger(process.env.TORRENT_METADATA_TIMEOUT_SECONDS, 18),
  TORRENT_IDLE_TTL_SECONDS: toPositiveInteger(process.env.TORRENT_IDLE_TTL_SECONDS, 120),
  TORRENT_CLEANUP_INTERVAL_SECONDS: toPositiveInteger(process.env.TORRENT_CLEANUP_INTERVAL_SECONDS, 30),
  HTTP_STREAM_TIMEOUT_SECONDS: toPositiveInteger(process.env.HTTP_STREAM_TIMEOUT_SECONDS, 20),
  HTTP_MAX_SOCKETS: toBoundedInteger(process.env.HTTP_MAX_SOCKETS, 8, 2, 16),
  HTTP_MAX_FREE_SOCKETS: toBoundedInteger(process.env.HTTP_MAX_FREE_SOCKETS, 4, 1, 8),
  HTTP_KEEP_ALIVE_MILLISECONDS: toPositiveInteger(process.env.HTTP_KEEP_ALIVE_MILLISECONDS, 1000),
  HTTP_STREAM_RETRY_MAX: toBoundedInteger(process.env.HTTP_STREAM_RETRY_MAX, 2, 0, 6),
  HTTP_STREAM_RETRY_BASE_DELAY_MS: toBoundedInteger(process.env.HTTP_STREAM_RETRY_BASE_DELAY_MS, 250, 50, 5000),
  HTTP_STREAM_CACHE_MAX_BYTES: toPositiveInteger(process.env.HTTP_STREAM_CACHE_MAX_BYTES, 8 * 1024 * 1024),
  STREAMED_SPORTS_CHROME_PATH: String(process.env.STREAMED_SPORTS_CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '').trim(),
  STREAMED_SPORTS_BROWSER_TIMEOUT_MS: toBoundedInteger(process.env.STREAMED_SPORTS_BROWSER_TIMEOUT_MS, 15_000, 5_000, 45_000),
  STREAMED_SPORTS_HLS_CACHE_MS: toBoundedInteger(process.env.STREAMED_SPORTS_HLS_CACHE_MS, 60_000, 15_000, 120_000),
  STREAMED_SPORTS_BROWSER_IDLE_MS: toBoundedInteger(process.env.STREAMED_SPORTS_BROWSER_IDLE_MS, 120_000, 10_000, 600_000),
  SPORTZX_STREAMS_ENABLED: toBoolean(process.env.SPORTZX_STREAMS_ENABLED, false),
  SPORTZX_BASE_URL: String(process.env.SPORTZX_BASE_URL || 'https://modiii.top/').trim(),
  SPORTZX_FALLBACK_URL: String(process.env.SPORTZX_FALLBACK_URL || 'https://anshulajoy10.github.io/mygaja/').trim(),
  API_FOOTBALL_BASE_URL: String(process.env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io').trim().replace(/\/+$/u, ''),
  API_FOOTBALL_KEY: String(process.env.API_FOOTBALL_KEY || '').trim(),
  API_FOOTBALL_WORLD_CUP_LEAGUE_ID: toPositiveInteger(process.env.API_FOOTBALL_WORLD_CUP_LEAGUE_ID, 1),
  API_FOOTBALL_STATS_TIMEOUT_MS: toBoundedInteger(process.env.API_FOOTBALL_STATS_TIMEOUT_MS, 5_000, 1_000, 15_000),
  API_FOOTBALL_STATS_CACHE_MS: toBoundedInteger(process.env.API_FOOTBALL_STATS_CACHE_MS, 30_000, 5_000, 300_000),
  WATCH_TOGETHER_CBOX_URL: String(process.env.WATCH_TOGETHER_CBOX_URL || '').trim(),
  STREAM_SOURCE_TOKEN_TTL_SECONDS: toPositiveInteger(process.env.STREAM_SOURCE_TOKEN_TTL_SECONDS, 6 * 60 * 60),
  STREAM_SOURCE_TOKEN_SECRET: String(process.env.STREAM_SOURCE_TOKEN_SECRET || process.env.ADMIN_PASSWORD || process.env.STREMIO_ADDON_ID || 'nebulastreams').trim(),
  SUPPORTER_CODE_SECRET: String(process.env.SUPPORTER_CODE_SECRET || process.env.ADMIN_PASSWORD || process.env.STREMIO_ADDON_ID || 'nebulastreams-supporters').trim(),
  KOFI_WEBHOOK_TOKEN: String(process.env.KOFI_WEBHOOK_TOKEN || '').trim(),
  KOFI_SUPPORTER_CODE_MONTHS: toBoundedInteger(process.env.KOFI_SUPPORTER_CODE_MONTHS, 1, 1, 36),
  KOFI_MIN_AMOUNT: toPositiveNumber(process.env.KOFI_MIN_AMOUNT, 1),
  SMTP_HOST: String(process.env.SMTP_HOST || '').trim(),
  SMTP_PORT: toBoundedInteger(process.env.SMTP_PORT, 587, 1, 65535),
  SMTP_SECURE: toBoolean(process.env.SMTP_SECURE, false),
  SMTP_USER: String(process.env.SMTP_USER || '').trim(),
  SMTP_PASS: String(process.env.SMTP_PASS || '').trim(),
  SMTP_FROM: String(process.env.SMTP_FROM || '').trim(),
  SMTP_USER_2: String(process.env.SMTP_USER_2 || '').trim(),
  SMTP_PASS_2: String(process.env.SMTP_PASS_2 || '').trim(),
  SMTP_FROM_2: String(process.env.SMTP_FROM_2 || '').trim(),
  SMTP_USER_3: String(process.env.SMTP_USER_3 || '').trim(),
  SMTP_PASS_3: String(process.env.SMTP_PASS_3 || '').trim(),
  SMTP_FROM_3: String(process.env.SMTP_FROM_3 || '').trim(),
  SMTP_USER_4: String(process.env.SMTP_USER_4 || '').trim(),
  SMTP_PASS_4: String(process.env.SMTP_PASS_4 || '').trim(),
  SMTP_FROM_4: String(process.env.SMTP_FROM_4 || '').trim(),
  SMTP2GO_WEBHOOK_SECRET: String(process.env.SMTP2GO_WEBHOOK_SECRET || '').trim(),
  SUPPORTER_EMAIL_REPLY_TO: String(process.env.SUPPORTER_EMAIL_REPLY_TO || '').trim(),
  PUBLIC_RATE_LIMIT_WINDOW_SECONDS: toPositiveInteger(process.env.PUBLIC_RATE_LIMIT_WINDOW_SECONDS, 60),
  PUBLIC_RATE_LIMIT_MAX_REQUESTS: toPositiveInteger(process.env.PUBLIC_RATE_LIMIT_MAX_REQUESTS, 240),
  STREAM_RATE_LIMIT_WINDOW_SECONDS: toPositiveInteger(process.env.STREAM_RATE_LIMIT_WINDOW_SECONDS, 60),
  STREAM_RATE_LIMIT_MAX_REQUESTS: toPositiveInteger(process.env.STREAM_RATE_LIMIT_MAX_REQUESTS, 180),
  PROVIDER_RATE_LIMIT_WINDOW_SECONDS: toPositiveInteger(process.env.PROVIDER_RATE_LIMIT_WINDOW_SECONDS, 60),
  PROVIDER_RATE_LIMIT_MAX_REQUESTS: toPositiveInteger(process.env.PROVIDER_RATE_LIMIT_MAX_REQUESTS, 120),
  PROVIDER_TIMEOUT_SECONDS: toPositiveInteger(process.env.PROVIDER_TIMEOUT_SECONDS, 18),
  PROVIDER_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_CACHE_TTL_SECONDS, 3600),
  PROVIDER_EMPTY_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_EMPTY_CACHE_TTL_SECONDS, 900),
  PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS, 60),
  PROVIDER_FAILURE_THRESHOLD: toPositiveInteger(process.env.PROVIDER_FAILURE_THRESHOLD, 15),
  PROVIDER_COOLDOWN_SECONDS: toPositiveInteger(process.env.PROVIDER_COOLDOWN_SECONDS, 30),
  PROVIDER_HOST_FAILURE_THRESHOLD: toPositiveInteger(process.env.PROVIDER_HOST_FAILURE_THRESHOLD, 15),
  PROVIDER_HOST_COOLDOWN_SECONDS: toPositiveInteger(process.env.PROVIDER_HOST_COOLDOWN_SECONDS, 30),
  PROVIDER_HOST_MAX_INFLIGHT: toBoundedInteger(process.env.PROVIDER_HOST_MAX_INFLIGHT, 3, 1, 100),
  PROVIDER_MAX_CONCURRENCY: toBoundedInteger(process.env.PROVIDER_MAX_CONCURRENCY, 4, 1, 32),
  PROVIDER_GLOBAL_MAX_INFLIGHT: toBoundedInteger(process.env.PROVIDER_GLOBAL_MAX_INFLIGHT, 16, 1, 128),
  PROVIDER_FETCH_REQUEST_TIMEOUT_MS: toBoundedInteger(process.env.PROVIDER_FETCH_REQUEST_TIMEOUT_MS, 18000, 3000, 60000),
  PROVIDER_MAINTENANCE_INTERVAL_SECONDS: toBoundedInteger(process.env.PROVIDER_MAINTENANCE_INTERVAL_SECONDS, 300, 30, 3600),
  PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES, 1000, 50, 20000),
  PROVIDER_RESULT_MEMORY_CACHE_MAX_MB: toBoundedInteger(process.env.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB, 32, 1, 512),
  TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES, 1000, 50, 5000),
  MAX_ACTIVE_STREAMS: toBoundedInteger(process.env.MAX_ACTIVE_STREAMS, 32, 1, 64),
  STREMIO_FAST_PROVIDER_CONCURRENCY: toBoundedInteger(process.env.STREMIO_FAST_PROVIDER_CONCURRENCY, 5, 1, 16),
  STREMIO_FAST_PROVIDER_LIMIT: toBoundedInteger(process.env.STREMIO_FAST_PROVIDER_LIMIT, 50, 1, 80),
  STREMIO_FAST_STREAM_LIMIT: toBoundedInteger(process.env.STREMIO_FAST_STREAM_LIMIT, 100, 4, 200),
  STREMIO_FAST_EARLY_RETURN_STREAMS: toBoundedInteger(process.env.STREMIO_FAST_EARLY_RETURN_STREAMS, 3, 1, 60),
  STREMIO_FAST_MIN_COMPLETED_PROVIDERS: toBoundedInteger(process.env.STREMIO_FAST_MIN_COMPLETED_PROVIDERS, 3, 1, 12),
  STREMIO_FAST_MAX_WAIT_MS: toBoundedInteger(process.env.STREMIO_FAST_MAX_WAIT_MS, 13000, 1000, 60000),
  STREMIO_QUALITY_GRACE_MS: toBoundedInteger(process.env.STREMIO_QUALITY_GRACE_MS, 3000, 0, 15000),
  STREMIO_PREMIUM_PROVIDER_MIN_WAIT_MS: toBoundedInteger(process.env.STREMIO_PREMIUM_PROVIDER_MIN_WAIT_MS, 6500, 0, 30000),
  STREMIO_STREAM_OVERALL_TIMEOUT_MS: toBoundedInteger(process.env.STREMIO_STREAM_OVERALL_TIMEOUT_MS, 19000, 5000, 90000),
  STREMIO_RESULT_CACHE_TTL_SECONDS: toPositiveInteger(process.env.STREMIO_RESULT_CACHE_TTL_SECONDS, 3600),
  STREMIO_EMPTY_RESULT_CACHE_TTL_SECONDS: toPositiveInteger(process.env.STREMIO_EMPTY_RESULT_CACHE_TTL_SECONDS, 5),
  STREMIO_WEAK_RESULT_CACHE_TTL_SECONDS: toPositiveInteger(process.env.STREMIO_WEAK_RESULT_CACHE_TTL_SECONDS, 300),
  STREMIO_RESULT_STALE_TTL_SECONDS: toBoundedInteger(process.env.STREMIO_RESULT_STALE_TTL_SECONDS, 43200, 300, 86400),
  STREMIO_LAST_GOOD_TTL_SECONDS: toBoundedInteger(process.env.STREMIO_LAST_GOOD_TTL_SECONDS, 259200, 3600, 1209600),
  STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES, 1000, 50, 20000),
  STREMIO_RESULT_MEMORY_CACHE_MAX_MB: toBoundedInteger(process.env.STREMIO_RESULT_MEMORY_CACHE_MAX_MB, 48, 1, 512),
  STREMIO_MAX_INFLIGHT_SEARCHES: toBoundedInteger(process.env.STREMIO_MAX_INFLIGHT_SEARCHES, 32, 1, 500),
  STREMIO_INFLIGHT_SLOT_WAIT_MS: toBoundedInteger(process.env.STREMIO_INFLIGHT_SLOT_WAIT_MS, 8000, 0, 60000),
  STREMIO_BACKGROUND_REFRESH_CONCURRENCY: toBoundedInteger(process.env.STREMIO_BACKGROUND_REFRESH_CONCURRENCY, 2, 0, 8),
  STREMIO_BACKGROUND_REFRESH_QUEUE_MAX: toBoundedInteger(process.env.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX, 100, 0, 5000),
  STREMIO_BACKGROUND_REFRESH_MAX_INFLIGHT_SEARCHES: toBoundedInteger(process.env.STREMIO_BACKGROUND_REFRESH_MAX_INFLIGHT_SEARCHES, 20, 1, 500),
  STREMIO_BACKGROUND_REFRESH_MAX_PROVIDER_EXECUTIONS: toBoundedInteger(process.env.STREMIO_BACKGROUND_REFRESH_MAX_PROVIDER_EXECUTIONS, 8, 1, 64),
  POPULAR_STREAM_PREWARM_ENABLED: toBoolean(process.env.POPULAR_STREAM_PREWARM_ENABLED, false),
  POPULAR_STREAM_PREWARM_INTERVAL_SECONDS: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_INTERVAL_SECONDS, 120, 60, 86400),
  POPULAR_STREAM_PREWARM_LIMIT: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_LIMIT, 50, 1, 100),
  POPULAR_STREAM_PREWARM_MAX_AGE_HOURS: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_MAX_AGE_HOURS, 72, 1, 720),
  POPULAR_STREAM_PREWARM_MAX_INFLIGHT_SEARCHES: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_MAX_INFLIGHT_SEARCHES, 4, 1, 500),
  POPULAR_STREAM_PREWARM_MAX_PROVIDER_EXECUTIONS: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_MAX_PROVIDER_EXECUTIONS, 2, 1, 64),
  POPULAR_STREAM_SEARCH_MAX_ENTRIES: toBoundedInteger(process.env.POPULAR_STREAM_SEARCH_MAX_ENTRIES, 200, 50, 5000),
  POPULAR_STREAM_SEARCH_MAX_USERS_PER_ENTRY: toBoundedInteger(process.env.POPULAR_STREAM_SEARCH_MAX_USERS_PER_ENTRY, 200, 10, 2000),
  STREAM_RESULT_EXTERNAL_CACHE_ENABLED: toBoolean(process.env.STREAM_RESULT_EXTERNAL_CACHE_ENABLED, Boolean(String(process.env.REDIS_URL || '').trim())),
  HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES, 300, 20, 3000),
  HUBCLOUD_MEMORY_CACHE_MAX_MB: toBoundedInteger(process.env.HUBCLOUD_MEMORY_CACHE_MAX_MB, 2, 1, 128),
  HUBCLOUD_MAX_INFLIGHT: toBoundedInteger(process.env.HUBCLOUD_MAX_INFLIGHT, 4, 1, 64),
  IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES, 1000, 50, 5000),
  USER_TRACKER_MAX_ENTRIES: toBoundedInteger(process.env.USER_TRACKER_MAX_ENTRIES, 20000, 1000, 200000),
  USER_TRACKER_BASELINE_JSON: String(process.env.USER_TRACKER_BASELINE_JSON || '').trim(),
  SOURCE_REGISTRY_MAX_ENTRIES: toBoundedInteger(process.env.SOURCE_REGISTRY_MAX_ENTRIES, 1000, 100, 50000),
  RATE_LIMIT_MAX_BUCKETS: toBoundedInteger(process.env.RATE_LIMIT_MAX_BUCKETS, 10000, 1000, 500000),
  MEMORY_GUARD_ENABLED: toBoolean(process.env.MEMORY_GUARD_ENABLED, true),
  MEMORY_GUARD_INTERVAL_SECONDS: toBoundedInteger(process.env.MEMORY_GUARD_INTERVAL_SECONDS, 2, 1, 300),
  MEMORY_GUARD_PRESSURE_PERCENT: toBoundedInteger(process.env.MEMORY_GUARD_PRESSURE_PERCENT, 45, 40, 98),
  MEMORY_GUARD_CRITICAL_PERCENT: toBoundedInteger(process.env.MEMORY_GUARD_CRITICAL_PERCENT, 60, 50, 99),
  MEMORY_GUARD_RESTART_PERCENT: toBoundedInteger(process.env.MEMORY_GUARD_RESTART_PERCENT, 95, 60, 99),
  MEMORY_GUARD_RESTART_AFTER_CRITICAL: toBoundedInteger(process.env.MEMORY_GUARD_RESTART_AFTER_CRITICAL, 3, 1, 10),
  MEMORY_GUARD_MIN_AVAILABLE_MB: toBoundedInteger(process.env.MEMORY_GUARD_MIN_AVAILABLE_MB, 256, 32, 1024),
  MEMORY_GUARD_SHED_SECONDS: toBoundedInteger(process.env.MEMORY_GUARD_SHED_SECONDS, 60, 10, 600),
  BOT_PROTECTION_ENABLED: toBoolean(process.env.BOT_PROTECTION_ENABLED, true),
  BOT_PROTECTION_WINDOW_SECONDS: toBoundedInteger(process.env.BOT_PROTECTION_WINDOW_SECONDS, 60, 10, 600),
  BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT: toBoundedInteger(process.env.BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT, 30, 4, 300),
  BOT_PROTECTION_SUSPICIOUS_REQUEST_LIMIT: toBoundedInteger(process.env.BOT_PROTECTION_SUSPICIOUS_REQUEST_LIMIT, 2, 1, 100),
  BOT_PROTECTION_BLOCK_SECONDS: toBoundedInteger(process.env.BOT_PROTECTION_BLOCK_SECONDS, 1800, 60, 86400),
  BOT_PROTECTION_MAX_TRACKED_CLIENTS: toBoundedInteger(process.env.BOT_PROTECTION_MAX_TRACKED_CLIENTS, 50000, 1000, 500000),
  VERBOSE_INFO_LOGS: toBoolean(process.env.VERBOSE_INFO_LOGS, false)
});

export const cacheConfig = Object.freeze({
  HTTP_CACHE_DIR: path.join(config.CACHE_DIR, 'http'),
  PROVIDER_CACHE_DIR: path.join(config.CACHE_DIR, 'provider-results'),
  STREMIO_RESULT_CACHE_DIR: path.join(config.CACHE_DIR, 'stremio-results'),
  TORRENT_CACHE_DIR: path.join(config.CACHE_DIR, 'torrents'),
  MAX_CACHE_SIZE_BYTES: Math.floor(config.MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024)
});
