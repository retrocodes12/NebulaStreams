import { ProviderService } from '../services/providerService.js';

const DEFAULT_PROVIDERS = Object.freeze([
  'pstream',
  'pstream-plugin',
  'vidlink',
  'moviebox',
  'cinestream'
]);

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const providers = String(process.env.PROVIDER_SANITY_PROVIDERS || DEFAULT_PROVIDERS.join(','))
  .split(',')
  .map((provider) => provider.trim().toLowerCase())
  .filter(Boolean);

const tmdbId = toPositiveInteger(process.env.PROVIDER_SANITY_TMDB_ID, 27205);
const mediaType = String(process.env.PROVIDER_SANITY_MEDIA_TYPE || 'movie').trim().toLowerCase() === 'tv' ? 'tv' : 'movie';
const season = toPositiveInteger(process.env.PROVIDER_SANITY_SEASON, 1);
const episode = toPositiveInteger(process.env.PROVIDER_SANITY_EPISODE, 1);
const timeoutMs = toPositiveInteger(process.env.PROVIDER_SANITY_TIMEOUT_MS, 30_000);

const providerService = new ProviderService();
await providerService.initialize();

try {
  const results = await Promise.allSettled(providers.map(async (provider) => {
    const startedAt = Date.now();
    const streams = await providerService.getStreams({
      provider,
      tmdbId,
      mediaType,
      season: mediaType === 'tv' ? season : null,
      episode: mediaType === 'tv' ? episode : null,
      priorityRequest: true,
      signal: AbortSignal.timeout(timeoutMs)
    });

    return {
      provider,
      ok: true,
      count: streams.length,
      durationMs: Date.now() - startedAt
    };
  }));

  const payload = results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }

    return {
      provider: providers[index],
      ok: false,
      count: 0,
      error: result.reason?.message || String(result.reason)
    };
  });

  console.log(JSON.stringify({
    tmdbId,
    mediaType,
    providers: payload
  }, null, 2));

  const hardFailures = payload.filter((entry) => !entry.ok);
  process.exitCode = hardFailures.length > 0 ? 1 : 0;
} finally {
  await providerService.close();
}
