const { runFrenchProvider } = require('./_nuvioFrenchProviderRunner.js');
async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  return runFrenchProvider('jetanimes', tmdbId, mediaType, season, episode);
}
module.exports = { getStreams };
