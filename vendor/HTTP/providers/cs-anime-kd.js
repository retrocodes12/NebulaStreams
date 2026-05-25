const { runProviderGroup } = require('./_csGroupRunner.js');

const PROVIDERS = [
  { id: 'animekai', label: 'CS-Anime AnimeKai', timeoutMs: 12_000 },
  { id: 'animepahe', label: 'CS-Anime AnimePahe', timeoutMs: 12_000 },
  { id: 'anime-nexus', label: 'CS-Anime Nexus', timeoutMs: 12_000 },
  { id: 'animesalt', label: 'CS-Anime Salt', timeoutMs: 12_000 },
  { id: 'animeworld', label: 'CS-Anime Aniworld', timeoutMs: 12_000 },
  { id: 'anime-sama', label: 'CS-Anime Sama', timeoutMs: 12_000 },
  { id: 'kisskh', label: 'CS-Anime KissKH', timeoutMs: 12_000 },
  { id: 'cinemacity', label: 'CS-Anime CinemaCity', timeoutMs: 12_000 },
  { id: 'movix', label: 'CS-Anime Movix', timeoutMs: 12_000 }
];

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  return runProviderGroup({
    providers: PROVIDERS,
    tmdbId,
    mediaType,
    season,
    episode,
    concurrency: 5,
    timeoutMs: 12_000,
    limit: 50
  });
}

module.exports = { getStreams };
