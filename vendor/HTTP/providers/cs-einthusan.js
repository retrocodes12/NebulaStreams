const {
  USER_AGENT,
  absoluteUrl,
  chooseBestMatch,
  fetchDocument,
  getTmdbMeta,
  stream
} = require('./_csProviderUtils.js');

const MAIN_URL = 'https://einthusan.tv';
const LANGUAGES = ['tamil', 'hindi', 'telugu', 'malayalam', 'kannada', 'bengali', 'marathi', 'punjabi'];
const PLAYBACK_HEADERS = {
  Referer: `${MAIN_URL}/`,
  'User-Agent': USER_AGENT
};

function fixEinthusanCdn(url) {
  return String(url || '').replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, 'cdn1.einthusan.io');
}

async function searchLanguage(query, language) {
  try {
    const url = `${MAIN_URL}/movie/results/?lang=${encodeURIComponent(language)}&query=${encodeURIComponent(query).replace(/%20/g, '+')}`;
    const $ = await fetchDocument(url, { headers: { Referer: `${MAIN_URL}/` } });
    const results = [];

    $('#UIMovieSummary > ul > li').each((_, element) => {
      const item = $(element);
      const title = item.find('div.block2 > a.title > h3').text().trim();
      const href = absoluteUrl(item.find('div.block2 > a.title').attr('href'), MAIN_URL);
      const year = Number.parseInt(item.find('div.block2 > div.info > p').first().text().trim(), 10) || null;

      if (title && href) {
        results.push({ title, href, year, language });
      }
    });

    return results;
  } catch {
    return [];
  }
}

async function getStreams(tmdbId, mediaType = 'movie') {
  if (mediaType !== 'movie') return [];

  try {
    const meta = await getTmdbMeta(tmdbId, mediaType);
    const queryTitles = meta.titles.slice(0, 4);
    const searchResults = (await Promise.all(queryTitles.flatMap((title) =>
      LANGUAGES.map((language) => searchLanguage(title, language))
    ))).flat();
    const match = chooseBestMatch(searchResults, meta, 65);
    if (!match) return [];

    const $ = await fetchDocument(match.href, { headers: { Referer: `${MAIN_URL}/` } });
    const player = $('#UIVideoPlayer');
    const mp4Url = fixEinthusanCdn(player.attr('data-mp4-link'));
    const hlsUrl = fixEinthusanCdn(player.attr('data-hls-link'));
    const label = `Einthusan ${match.language}`;
    const streams = [
      stream('CS-Indian Einthusan', `${label} MP4`, mp4Url, {
        headers: PLAYBACK_HEADERS,
        quality: 'HD'
      }),
      stream('CS-Indian Einthusan', `${label} HLS`, hlsUrl, {
        headers: PLAYBACK_HEADERS,
        quality: 'HD'
      })
    ].filter(Boolean);

    return streams;
  } catch {
    return [];
  }
}

module.exports = { getStreams };
