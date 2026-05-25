const { runProviderGroup } = require('./_csGroupRunner.js');

const PROVIDERS = [
  { id: 'filmpalast', label: 'CS-German FilmPalast', timeoutMs: 12_000 },
  { id: 'einschalten', label: 'CS-German Einschalten', timeoutMs: 12_000 },
  { id: 'frembed', label: 'CS-German Moflix', timeoutMs: 12_000 }
];

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  return runProviderGroup({
    providers: PROVIDERS,
    tmdbId,
    mediaType,
    season,
    episode,
    concurrency: 3,
    timeoutMs: 12_000,
    limit: 50
  });
}

module.exports = { getStreams };
