const path = require('node:path');

const PROVIDERS_DIR = __dirname;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LIMIT = 50;
const BAD_STREAM_PATTERN = /(?:^|[\s._-])(?:sample|trailer|teaser|promo)(?:$|[\s._-])/iu;
const ARCHIVE_STREAM_PATTERN = /\.(?:zip|rar|7z|tar|gz|bz2|xz)(?:$|[?#\s])/iu;

function withTimeout(promiseFactory, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve([]), timeoutMs);
    timeout.unref?.();
  });

  return Promise.race([
    Promise.resolve().then(promiseFactory).catch(() => []),
    timeoutPromise
  ]).finally(() => clearTimeout(timeout));
}

function loadProvider(providerId) {
  const providerPath = path.join(PROVIDERS_DIR, `${providerId}.js`);
  const providerModule = require(providerPath);

  if (!providerModule || typeof providerModule.getStreams !== 'function') {
    throw new Error(`CS native provider target ${providerId} does not export getStreams()`);
  }

  return providerModule;
}

function normalizeUrlKey(stream) {
  const raw = stream?.url || stream?.magnet;
  return String(raw || '').trim();
}

function isUsableStream(stream) {
  const text = [
    stream?.filename,
    stream?.fileName,
    stream?.title,
    stream?.name,
    stream?.url
  ].map((value) => String(value || '')).join(' ');

  return !BAD_STREAM_PATTERN.test(text) && !ARCHIVE_STREAM_PATTERN.test(text);
}

function decorateStream(stream, label) {
  const name = String(stream?.name || '').trim();
  const title = String(stream?.title || '').trim();

  return {
    ...stream,
    name: name && !name.toLowerCase().includes(label.toLowerCase())
      ? `${label}\n${name}`
      : (name || label),
    title: title || label
  };
}

async function runProviderGroup({
  providers,
  tmdbId,
  mediaType = 'movie',
  season = null,
  episode = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  limit = DEFAULT_LIMIT
}) {
  const enabledProviders = Array.isArray(providers) ? providers.filter(Boolean) : [];
  const results = [];
  const seen = new Set();
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < enabledProviders.length && results.length < limit) {
      const providerConfig = enabledProviders[nextIndex];
      nextIndex += 1;

      const providerId = providerConfig.id;
      const label = providerConfig.label || providerId;
      const streams = await withTimeout(async () => {
        const providerModule = loadProvider(providerId);
        return providerModule.getStreams(tmdbId, mediaType, season, episode);
      }, providerConfig.timeoutMs || timeoutMs, label);

      for (const stream of Array.isArray(streams) ? streams : []) {
        if (!isUsableStream(stream)) continue;
        const key = normalizeUrlKey(stream);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        results.push(decorateStream(stream, label));
        if (results.length >= limit) break;
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), enabledProviders.length) },
    () => worker()
  ));

  return results.slice(0, limit);
}

module.exports = {
  runProviderGroup
};
