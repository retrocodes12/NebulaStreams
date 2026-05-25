const { runProviderGroup } = require('./_csGroupRunner.js');

const PROVIDERS = [
  { id: 'brazucaplay', label: 'CS-Brazilian BrazucaPlay', timeoutMs: 16_000 },
  { id: 'latino-lamovie', label: 'CS-Brazilian LaMovie', timeoutMs: 14_000 },
  { id: 'latino-cinecalidad', label: 'CS-Brazilian CineCalidad', timeoutMs: 14_000 },
  { id: 'animepahe', label: 'CS-Brazilian Anime', timeoutMs: 12_000 },
  { id: 'kisskh', label: 'CS-Brazilian Doramas', timeoutMs: 12_000 }
];

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  return runProviderGroup({
    providers: PROVIDERS,
    tmdbId,
    mediaType,
    season,
    episode,
    concurrency: 3,
    timeoutMs: 16_000,
    limit: 50
  });
}

module.exports = { getStreams };
