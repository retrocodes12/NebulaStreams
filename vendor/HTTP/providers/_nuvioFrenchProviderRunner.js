const path = require('node:path');

const MANIFEST_URL = 'https://raw.githubusercontent.com/Gowaru/gowaru-nuvio-providers/refs/heads/main/manifest.json';
const RAW_BASE_URL = 'https://raw.githubusercontent.com/Gowaru/gowaru-nuvio-providers/refs/heads/main/';
const FRENCH_BROWSER_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.7,en;q=0.6',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache'
});

const PROVIDERS = Object.freeze({
  'anime-sama': { label: 'Anime-Sama FR', timeoutMs: 12_000 },
  voiranime: { label: 'VoirAnime FR', timeoutMs: 12_000 },
  vostfree: { label: 'Vostfree FR', timeoutMs: 12_000 },
  animoflix: { label: 'AnimoFlix FR', timeoutMs: 12_000 },
  'french-anime': { label: 'French-Anime', timeoutMs: 14_000 },
  animevostfr: { label: 'AnimeVOSTFR', timeoutMs: 12_000 },
  animesultra: { label: 'AnimesUltra', timeoutMs: 12_000 },
  jetanimes: { label: 'JetAnimes', timeoutMs: 10_000 },
  sekai: { label: 'Sekai FR', timeoutMs: 10_000 },
  movix: { label: 'Movix FR', timeoutMs: 14_000 },
  mugiwarastream: { label: 'Mugiwara Stream', timeoutMs: 10_000 },
  animesite: { label: 'AnimeSite FR', timeoutMs: 8_000 },
  frenchstream: { label: 'Frenchstream', timeoutMs: 14_000 },
  dulourd: { label: 'DuLourd', timeoutMs: 8_000 }
});

const adapterCache = new Map();

async function getAdapter(pluginId) {
  if (adapterCache.has(pluginId)) {
    return adapterCache.get(pluginId);
  }

  const [
    { config },
    { PluginManifestCache },
    { NuvioPluginAdapter }
  ] = await Promise.all([
    import('../../../config.js'),
    import('../../../src/cache/pluginManifestCache.js'),
    import('../../../src/adapters/NuvioPluginAdapter.js')
  ]);
  const meta = PROVIDERS[pluginId] || { label: pluginId, timeoutMs: 10_000 };
  const cache = new PluginManifestCache({
    cacheDir: path.join(config.CACHE_DIR, 'plugin-adapters-native')
  });
  const adapter = new NuvioPluginAdapter({
    id: `fr-${pluginId}`,
    name: meta.label,
    cacheNamespace: `nuvio-french-native/${pluginId}`,
    cache,
    manifestUrl: MANIFEST_URL,
    rawBaseUrl: RAW_BASE_URL,
    providerOrder: [pluginId],
    maxProvidersPerRequest: 1,
    pluginConcurrency: 1,
    earlyReturnStreams: 50,
    providerTimeoutMs: meta.timeoutMs,
    overallTimeoutMs: meta.timeoutMs + 1_500,
    pluginFetchHeaders: FRENCH_BROWSER_HEADERS
  });

  adapterCache.set(pluginId, adapter);
  return adapter;
}

function dedupeStreams(streams) {
  const seen = new Set();
  const result = [];

  for (const stream of Array.isArray(streams) ? streams : []) {
    const key = String(stream?.url || stream?.magnet || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(stream);
  }

  return result;
}

async function runFrenchProvider(pluginId, tmdbId, mediaType = 'movie', season = null, episode = null) {
  const adapter = await getAdapter(pluginId);
  const streams = await adapter.getStreams({ tmdbId, mediaType, season, episode });
  return dedupeStreams(streams);
}

module.exports = {
  PROVIDERS,
  runFrenchProvider
};
