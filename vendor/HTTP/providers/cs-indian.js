const { runProviderGroup } = require('./_csGroupRunner.js');

const PROVIDERS = [
  { id: 'cs-einthusan', label: 'CS-Indian Einthusan', timeoutMs: 18_000 },
  { id: '4khdhub', label: 'CS-Indian 4KHDHub', timeoutMs: 18_000 },
  { id: 'hdhub4u', label: 'CS-Indian HDHub4u', timeoutMs: 18_000 },
  { id: 'uhdmovies', label: 'CS-Indian UHDMovies', timeoutMs: 18_000 },
  { id: 'moviebox', label: 'CS-Indian MovieBox', timeoutMs: 16_000 },
  { id: 'streamflix', label: 'CS-Indian StreamFlix', timeoutMs: 12_000 },
  { id: 'flixindia', label: 'CS-Indian FlixIndia', timeoutMs: 14_000 },
  { id: 'gramcinema', label: 'CS-Indian GramCinema', timeoutMs: 14_000 },
  { id: 'hindmoviez', label: 'CS-Indian HindMoviez', timeoutMs: 14_000 },
  { id: 'isaidub', label: 'CS-Indian Isaidub', timeoutMs: 14_000 },
  { id: 'castle', label: 'CS-Indian Castle', timeoutMs: 16_000 },
  { id: 'cinemacity', label: 'CS-Indian CineTV', timeoutMs: 12_000 },
  { id: 'tamilian', label: 'CS-Indian Tamilian', timeoutMs: 14_000 },
  { id: 'dooflix', label: 'CS-Indian DoFlix', timeoutMs: 14_000 }
];

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  return runProviderGroup({
    providers: PROVIDERS,
    tmdbId,
    mediaType,
    season,
    episode,
    concurrency: 5,
    timeoutMs: 18_000,
    limit: 50
  });
}

module.exports = { getStreams };
