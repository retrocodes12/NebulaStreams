const { runProviderGroup } = require('./_csGroupRunner.js');

const PROVIDERS = [
  { id: 'arabic-faselhd', label: 'CS-Arabic FaselHD', timeoutMs: 14_000 },
  { id: 'arabic-cineby', label: 'CS-Arabic Cineby', timeoutMs: 12_000 },
  { id: 'arabic-witanime', label: 'CS-Arabic WitAnime', timeoutMs: 14_000 },
  { id: 'arabic-animecloud', label: 'CS-Arabic AnimeCloud', timeoutMs: 14_000 },
  { id: 'arabic-kirmzi', label: 'CS-Arabic Kirmzi', timeoutMs: 12_000 }
];

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  return runProviderGroup({
    providers: PROVIDERS,
    tmdbId,
    mediaType,
    season,
    episode,
    concurrency: 3,
    timeoutMs: 14_000,
    limit: 50
  });
}

module.exports = { getStreams };
