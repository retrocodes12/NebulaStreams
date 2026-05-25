const { runFrenchProvider } = require('./_nuvioFrenchProviderRunner.js');
async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  return runFrenchProvider('vostfree', tmdbId, mediaType, season, episode);
}
module.exports = { getStreams };
