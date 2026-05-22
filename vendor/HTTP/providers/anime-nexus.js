// Anime Nexus provider.
// Public metadata endpoints expose HLS URLs, but playback is protected by a
// browser/socket token flow. Keep this provider gated until tokenized HLS is
// implemented, so Stremio never receives known-403 streams.

const TMDB_KEY = '439c478a771f35c05022f9feabcca01c';
const API = 'https://api.anime.nexus';
const SITE = 'https://anime.nexus';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const FINGERPRINT = process.env.ANIME_NEXUS_FINGERPRINT || 'server-side-nebulastreams';

function headers(extra) {
  return Object.assign({
    'Accept': 'application/json, text/plain, */*',
    'Origin': SITE,
    'Referer': SITE + '/',
    'User-Agent': UA,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Client-Fingerprint': FINGERPRINT,
    'x-fingerprint': FINGERPRINT
  }, extra || {});
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, ms);
  return { signal: controller.signal, clear: function() { clearTimeout(timer); } };
}

async function fetchJson(url, ms) {
  const t = timeoutSignal(ms || 10_000);
  try {
    const res = await fetch(url, { headers: headers(), signal: t.signal });
    const text = await res.text();
    if (!res.ok || !/^\s*[\[{]/.test(text)) return null;
    return JSON.parse(text);
  } catch (e) {
    return null;
  } finally {
    t.clear();
  }
}

async function getTmdbInfo(tmdbId, mediaType) {
  const type = mediaType === 'movie' ? 'movie' : 'tv';
  const url = 'https://api.themoviedb.org/3/' + type + '/' + tmdbId + '?api_key=' + TMDB_KEY;
  const data = await fetchJson(url, 8_000);
  if (!data) return null;
  return {
    title: data.title || data.name || '',
    originalTitle: data.original_title || data.original_name || '',
    year: String((data.release_date || data.first_air_date || '').slice(0, 4))
  };
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreCandidate(candidate, info) {
  const wanted = normalizeTitle(info.title);
  const original = normalizeTitle(info.originalTitle);
  const name = normalizeTitle(candidate.name);
  const alt = normalizeTitle(candidate.name_alt);
  let score = 0;
  if (name === wanted || alt === wanted) score += 100;
  if (original && (name === original || alt === original)) score += 90;
  if (wanted && (name.includes(wanted) || wanted.includes(name))) score += 35;
  if (original && (alt.includes(original) || original.includes(alt))) score += 30;
  if (info.year && String(candidate.relese_date || '').startsWith(info.year)) score += 15;
  return score;
}

async function searchAnime(info) {
  const query = encodeURIComponent(info.originalTitle || info.title);
  const data = await fetchJson(API + '/api/anime/search?query=' + query, 10_000);
  const list = Array.isArray(data && data.data) ? data.data : [];
  return list
    .map(function(item) { return { item: item, score: scoreCandidate(item, info) }; })
    .sort(function(a, b) { return b.score - a.score; })[0];
}

async function getEpisode(animeId, mediaType, episode) {
  const target = mediaType === 'movie' ? 1 : Number(episode || 1);
  const url = API + '/api/anime/details/episodes?id=' + encodeURIComponent(animeId) + '&page=1&perPage=100&order=asc';
  const data = await fetchJson(url, 10_000);
  const list = Array.isArray(data && data.data) ? data.data : [];
  return list.find(function(ep) { return Number(ep.number) === target; }) || list[target - 1] || null;
}

async function getStreamData(episodeId) {
  const url = API + '/api/anime/details/episode/stream?id=' + encodeURIComponent(episodeId) + '&fillers=false&recaps=false';
  const data = await fetchJson(url, 10_000);
  return data && data.data ? data.data : null;
}

async function isPlayableHls(url) {
  if (process.env.ANIME_NEXUS_RETURN_PROTECTED_HLS === 'true') return true;

  const t = timeoutSignal(8_000);
  try {
    const res = await fetch(url, {
      headers: headers({ 'Accept': 'application/vnd.apple.mpegurl, application/x-mpegurl, */*' }),
      signal: t.signal
    });
    if (!res.ok) return false;
    const text = await res.text();
    return text.indexOf('#EXTM3U') !== -1;
  } catch (e) {
    return false;
  } finally {
    t.clear();
  }
}

function qualityFromMeta(meta) {
  const qualities = meta && meta.qualities ? Object.keys(meta.qualities) : [];
  if (qualities.indexOf('1920x1080') !== -1) return '1080p';
  if (qualities.indexOf('1280x720') !== -1) return '720p';
  if (qualities.length > 0) return qualities[0].split('x').pop() + 'p';
  return 'Auto';
}

async function getStreams(tmdbId, mediaType, season, episode) {
  if (process.env.ANIME_NEXUS_ENABLED !== 'true') return [];

  try {
    const info = await getTmdbInfo(tmdbId, mediaType);
    if (!info || !info.title) return [];

    const match = await searchAnime(info);
    if (!match || !match.item || match.score < 30) return [];

    const ep = await getEpisode(match.item.id, mediaType, episode);
    if (!ep || !ep.id) return [];

    const stream = await getStreamData(ep.id);
    if (!stream || !stream.hls) return [];
    if (!(await isPlayableHls(stream.hls))) return [];

    const quality = qualityFromMeta(stream.video_meta);
    const subtitles = (stream.subtitles || [])
      .map(function(sub) {
        return {
          url: sub.url || sub.file || sub.src,
          lang: sub.lang || sub.language || 'en',
          name: sub.name || sub.language || 'Subtitle'
        };
      })
      .filter(function(sub) { return sub.url; });

    return [{
      name: 'Anime Nexus',
      title: 'Anime Nexus • ' + quality,
      url: stream.hls,
      quality: quality,
      provider: 'anime-nexus',
      sourceProvider: 'anime-nexus',
      sourceSite: 'Anime Nexus',
      headers: {
        'Referer': SITE + '/',
        'Origin': SITE,
        'User-Agent': UA
      },
      subtitles: subtitles
    }];
  } catch (e) {
    return [];
  }
}

module.exports = { getStreams };
