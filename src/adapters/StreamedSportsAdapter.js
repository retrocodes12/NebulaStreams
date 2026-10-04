import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { freemem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { load as loadHtml } from 'cheerio';
import { SportzXStreamSource } from './SportzXStreamSource.js';

const execFileAsync = promisify(execFile);

const API_BASE = 'https://streamed.pk';
const EMBED_BASE = 'https://embed.st';
const SPORTSBITE_ORIGIN = 'https://sportsbite.xyz';
const SPORTSBITE_STREAMS_URL = 'https://embed.cr7siuu.xyz/streams';
const SPORTSBITE_CATALOG_ID = 'streamed-events-sportsbite';
const SPORTSBITE_CACHE_KEY = 'sportsbite';
const SPORTSBITE_SOURCE = 'sportsbite';
const STREAMFREE_ORIGIN = 'https://streamfree.app';
const STREAMFREE_CATALOG_ID = 'streamed-events-streamfree';
const STREAMFREE_CACHE_KEY = 'streamfree';
const STREAMFREE_SOURCE = 'streamfree';
const FLIX_DLSTREAMS_BASE_URL = 'https://free.flixnest.app/z.eNqNUcuOwjAM_JecQaIPeuivrJCVNi616iRV4hTBav99w0uwwGFPUTye0XjmWwHGiE5IMzAtCLryk3ZbJqyXF_Z64FYMKxnH8_PUqmVekj1WnDvA2FU7dfuDzJq55DhSn-DyfWcDII2iUW1g-aYraDTHSPU02jG1L2OjSY-Wi_k3Rt0F74fdZt_DOQ_O09xGQrYywvpYrBODx8fRCDOPsjtdHJRchFAJmc8EBRdeSymRqpueyylKLaHeqxiORVYzxtTLPW-anLUT2pCFmHwwWo511SP7_DJO8zXHPxCBgOw7zXntTmgpWSv3mQBWyWIPoX-0tujFrX7-QXb49ck';
const FLIX_DLSTREAMS_CATALOG_ID = 'streamed-events-flix-dlstreams';
const FLIX_DLSTREAMS_CACHE_KEY = 'flix-dlstreams-v2';
const FLIX_DLSTREAMS_SOURCE = 'nebulasp';
const FLIX_DLSTREAMS_STREAM_CACHE_MS = 2 * 60 * 1000;
const FLIX_DLSTREAMS_STREAM_STALE_MS = 10 * 60 * 1000;
const CDNLIVETV_API_BASE = 'https://api.cdnlivetv.tv';
const CDNLIVETV_ORIGIN = 'https://cdnlivetv.tv';
const CDNLIVETV_SOURCE = 'cdnlivetv';
const CDNLIVETV_CATALOG_ID = 'streamed-events-cdnlivetv';
const CDNLIVETV_CACHE_KEY = 'cdnlivetv';
const CDNLIVETV_USER = String(process.env.CDNLIVETV_USER || 'cdnlivetv').trim();
const CDNLIVETV_PLAN = String(process.env.CDNLIVETV_PLAN || 'free').trim();
const CDNLIVETV_STREAM_CACHE_MS = 60 * 1000;
const CDNLIVETV_STREAM_STALE_MS = 5 * 60 * 1000;
const CDNLIVETV_HEALTH_CACHE_MS = 60 * 1000;
const CDNLIVETV_DOWN_CACHE_MS = 2 * 60 * 1000;
const REXDEX_SOURCE = 'rexdex';
const REXDEX_ORIGIN = 'https://www.rexdexsports.in';
const REXDEX_FEED_URL = `${REXDEX_ORIGIN}/feeds/posts/default?alt=json&max-results=30`;
const REXDEX_POST_CACHE_MS = 2 * 60 * 1000;
const REXDEX_MIN_HEIGHT = 1080;
const REXDEX_PORTUGAL_UZBEKISTAN_STREAM_ID = 'portugal-uzbekistan-fancode-live-3';
const REXDEX_PORTUGAL_UZBEKISTAN_HLS = 'https://rxne77juptdeyke3tytvgqwyh.medya.trt.com.tr/master.m3u8';
const REXDEX_PORTUGAL_UZBEKISTAN_PAGE = 'https://www.rexdexsports.in/p/fancode-live-3.html?m=1';
const REXDEX_PORTUGAL_UZBEKISTAN_UNTIL_MS = Date.parse('2026-06-24T06:00:00.000Z');
const HELLOSPORTS_SOURCE = 'hellosports';
const HELLOSPORTS_ORIGIN = 'https://hellosports.jkssbcares.in';
const HELLOSPORTS_4K_PAGE = 'https://hellosports.jkssbcares.in/p/live-matches.html?m=1';
const HELLOSPORTS_FEED_URL = `${HELLOSPORTS_ORIGIN}/feeds/posts/default?alt=json&max-results=50`;
const HELLOSPORTS_4K_CACHE_MS = 60 * 1000;
const HELLOSPORTS_POST_CACHE_MS = 5 * 60 * 1000;
const HELLOSPORTS_4K_MAX_CARDS = 4;
const KNOWN_SPORTS_SOURCE = 'knownsports';
const KNOWN_SPORTS_MAX_CARDS = 3;
const KNOWN_SPORTS_HLS_TIMEOUT_MS = 7_000;
const KNOWN_SPORTS_HEALTH_CACHE_MS = 90_000;
const KNOWN_SPORTS_DOWN_CACHE_MS = 30_000;
const KNOWN_SPORTS_CHANNELS = Object.freeze([
  {
    id: 'bolt-bein1',
    channelName: 'beIN Sports 1',
    category: 'football',
    worldCup: true,
    directHlsUrl: 'https://bolt.highfly.dev/cinearena/bein1/live.m3u8',
    playbackProfile: {
      quality: '1080p',
      speedMbps: 10
    }
  },
  {
    id: 'bolt-bein3',
    channelName: 'beIN Sports 3',
    category: 'football',
    worldCup: true,
    directHlsUrl: 'https://bolt.highfly.dev/cinearena/bein3/live.m3u8',
    playbackProfile: {
      quality: '1080p',
      speedMbps: 10
    }
  },
  {
    id: 'bolt-tnt4',
    channelName: 'TNT Sports 4',
    category: 'football',
    worldCup: true,
    directHlsUrl: 'https://bolt.highfly.dev/cinearena/tnt4/live.m3u8',
    playbackProfile: {
      quality: '1080p',
      speedMbps: 10
    }
  }
]);
const STREAMZY_4K_SOURCE = 'streamzy4k';
const STREAMZY_4K_ORIGIN = 'https://vileembeds.pages.dev';
const WC_XTREAM_SOURCE = 'wciptv';
const WC_XTREAM_CATEGORY_ID = String(process.env.NEBULA_SPORTS_WC_XTREAM_CATEGORY_ID || '105').trim();
const WC_XTREAM_CACHE_MS = 60_000;
const WC_XTREAM_VALIDATION_BUDGET_MS = 6_000;
const WC_XTREAM_MAX_CANDIDATES = 6;
const WC_XTREAM_MAX_CARDS = 4;
const SPORTSRC_SOURCE = 'sportsrc';
const SPORTSRC_API_BASE = 'https://api.sportsrc.org/v2/';
const SPORTSRC_MATCH_CACHE_MS = 15 * 60 * 1000;
const SPORTSRC_DETAIL_CACHE_MS = 10 * 60 * 1000;
const SPORTSRC_VALIDATION_BUDGET_MS = 5_000;
const SPORTSRC_MAX_CANDIDATES = 4;
const SPORTSRC_MAX_CARDS = 2;
const RAPID_FOOTBALL_SOURCE = 'rapidfootball';
const RAPID_FOOTBALL_API_HOST = 'football-live-streaming-api.p.rapidapi.com';
const RAPID_FOOTBALL_MATCHES_URL = `https://${RAPID_FOOTBALL_API_HOST}/matches`;
const RAPID_FOOTBALL_CACHE_KEY = 'rapidfootball:matches:page1';
const RAPID_FOOTBALL_MATCH_CACHE_MS = 30 * 60 * 1000;
const RAPID_FOOTBALL_STALE_CACHE_MS = 2 * 60 * 60 * 1000;
const RAPID_FOOTBALL_VALIDATION_BUDGET_MS = 14_000;
const RAPID_FOOTBALL_MAX_CANDIDATES = 48;
const RAPID_FOOTBALL_MAX_CARDS = 6;
const RAPID_FOOTBALL_DAILY_LIMIT = Math.max(1, Number.parseInt(process.env.RAPID_FOOTBALL_DAILY_LIMIT || '40', 10) || 40);
const REPLAYZONE_SOURCE = 'replayzone';
const REPLAYZONE_CATALOG_ID = 'streamed-replays';
const REPLAYZONE_CACHE_KEY = 'replayzone';
const REPLAYZONE_FEED_URL = 'https://replay.adityapangshe.workers.dev/replays.txt';
const REPLAYZONE_MATCH_CACHE_MS = 10 * 60 * 1000;
const REPLAYZONE_HLS_CACHE_MS = 15 * 60 * 1000;
const REPLAYZONE_MAX_CARDS = 6;
const DLHD_ORIGIN = 'https://dlhd.pk';
const DLHD_SOURCE = 'dlhd';
const DLHD_ORIGINS = Object.freeze([
  DLHD_ORIGIN,
  'https://dlhd.to',
  ...String(process.env.DLHD_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/u, ''))
    .filter((origin) => origin && ![DLHD_ORIGIN, 'https://dlhd.to'].includes(origin) && /^https?:\/\//iu.test(origin))
]);
const DLHD_API_KEY = String(process.env.DLHD_API_KEY || '').trim();
const DLHD_PLAYER_FOLDERS = Object.freeze(['stream', 'cast', 'watch', 'plus', 'casting', 'player']);
const DLHD_SCHEDULE_CACHE_MS = 60_000;
const DLHD_SCHEDULE_STALE_MS = 6 * 60 * 60 * 1000;
const DLHD_CHANNEL_CATALOG_ID = 'streamed-events-dlhd-channels';
const DLHD_CHANNEL_CACHE_KEY = 'cdnlivetv-channels';
const DLHD_CHANNEL_CATALOG_LIMIT = 1200;
const DLHD_CHANNEL_CACHE_MS = 10 * 60 * 1000;
const DLHD_CHANNEL_STALE_MS = 30 * 60 * 1000;
const DLHD_HLS_MAX_CACHE_MS = 10 * 60 * 1000;
const DLHD_HLS_EXPIRY_MARGIN_MS = 45_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const LIVE_MATCH_CACHE_TTL_MS = 30 * 1000;
const EVENT_CATALOG_LIMIT = 50;
const STREMIO_SPORTS_TYPE = 'sports';
const FIFA_WC_CATALOG_ID = 'streamed-events-fifa-wc';
const FIFA_WC_CACHE_KEY = 'fifa-wc';
const DEFAULT_BROWSER_TIMEOUT_MS = 15_000;
const DEFAULT_HLS_CACHE_MS = 15_000;
const DEFAULT_PLAYLIST_CACHE_MS = 5_000;
const DEFAULT_MEDIA_CACHE_MS = 15_000;
const MAX_MEDIA_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_CACHE_ENTRY_BYTES = 8 * 1024 * 1024;
const DEFAULT_BROWSER_IDLE_MS = 60_000;
const MIN_BROWSER_PREWARM_FREE_BYTES = 768 * 1024 * 1024;
const MAX_BROWSER_PREWARM_IN_FLIGHT = 2;
const BROWSER_LAUNCH_DISABLE_MS = 15 * 60 * 1000;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const HLS_PROBE_TIMEOUT_MS = 6_000;
const HLS_PROBE_DISABLE_MS = 10 * 60 * 1000;
const HLS_PROBE_SCRIPT = path.join(process.cwd(), 'scripts', 'streamed_hls_probe.py');
const HLS_CONTENT_TYPE_RE = /(?:mpegurl|m3u8|application\/vnd\.apple|application\/x-mpegurl)/iu;
const STREAM_VALIDATION_TOTAL_BUDGET_MS = 8_000;
const STREAM_DIRECT_HLS_FAST_SOURCE_MS = 1_800;
const STREAM_DIRECT_HLS_FAST_VALIDATION_MS = 3_000;
const STREAM_VALIDATION_CANDIDATE_TIMEOUT_MS = 7_500;
const STREAM_VALIDATION_MAX_CANDIDATES = 8;
const STREAM_VALIDATION_MAX_PER_SOURCE = 2;
const STREAM_BROWSER_FALLBACK_TOTAL_BUDGET_MS = 4_000;
const STREAM_BROWSER_FALLBACK_MAX_CANDIDATES = 2;
const HLS_SEGMENT_PROBE_TIMEOUT_MS = 2_500;
const HLS_SEGMENT_PROBE_MAX_BYTES = 256 * 1024;
const LIVE_STREAM_PREWARM_LIMIT = 6;
const LIVE_STREAM_PREWARM_TIMEOUT_MS = 22_000;
const LICENSED_EXTERNAL_VALIDATION_BUDGET_MS = 1_500;
const STREAM_FAST_MATCH_LOOKUP_TIMEOUT_MS = 2_500;
const STREAM_SOURCE_LOAD_TIMEOUT_MS = 3_500;
const STREAM_SOURCE_RANK = new Map([
  [HELLOSPORTS_SOURCE, -3],
  [STREAMZY_4K_SOURCE, -2],
  [CDNLIVETV_SOURCE, -1],
  ['echo', 0],
  ['golf', 1],
  ['nebulasports', 2],
  [RAPID_FOOTBALL_SOURCE, 2],
  [FLIX_DLSTREAMS_SOURCE, 3],
  [REXDEX_SOURCE, 3],
  [SPORTSRC_SOURCE, 3],
  ['admin', 4],
  ['delta', 5],
  ['sportsbite', 20],
  ['streamfree', 21],
  ['dlhd', 22],
  ['sportzx', 23]
]);
const STREAMED_SOURCE_DEFAULT_RANK = 5;
const SUPPLEMENTAL_SPORTS_SOURCES_ENABLED = true;
const SUPPLEMENTAL_SPORTS_SOURCES = new Set([SPORTSBITE_SOURCE, STREAMFREE_SOURCE, FLIX_DLSTREAMS_SOURCE, CDNLIVETV_SOURCE, STREAMZY_4K_SOURCE, SPORTSRC_SOURCE, RAPID_FOOTBALL_SOURCE, 'sportzx']);
const STREAMZY_4K_STREAMS = Object.freeze([
  {
    id: 'fox-sports-1-4k',
    label: 'FS1 4K',
    language: 'English',
    embedUrl: `${STREAMZY_4K_ORIGIN}/embed/fox-sports-1-4k`
  },
  {
    id: 'fusballtv1uhd-de',
    label: 'Fusball TV1 UHD',
    language: 'German',
    embedUrl: `${STREAMZY_4K_ORIGIN}/embed/fusballtv1uhd-de`
  },
  {
    id: 'fusballtvuhd-de',
    label: 'Fusball TV1 UHD No Commentary',
    language: 'German',
    embedUrl: `${STREAMZY_4K_ORIGIN}/embed/fusballtvuhd-de`
  }
]);
const STREAMFREE_CHANNELS = Object.freeze([
  {
    id: 'willow',
    title: 'Willow TV Cricket',
    category: 'cricket',
    embedCategory: 'cricket',
    poster: null
  },
  {
    id: 'cricketsky',
    title: 'Sky Sports Cricket',
    category: 'cricket',
    embedCategory: 'cricket',
    poster: null
  },
  {
    id: 'skyf1',
    title: 'Sky Sports F1',
    category: 'motor-sports',
    embedCategory: 'racing',
    poster: null
  },
  {
    id: 'skytennis',
    title: 'Sky Sports Tennis',
    category: 'tennis',
    embedCategory: 'tennis',
    poster: null
  }
]);
const STREAMFREE_QUALITY_ORDER = ['2160p', '1080p', '720p', '540p'];
const LICENSED_EXTERNAL_EMBED_STREAMS = [
  {
    id: 'l1',
    streamNo: 1,
    language: 'English',
    hd: true,
    embedUrl: 'https://helloxsports.in/worldcup/fox1.html'
  },
  {
    id: 'l2',
    streamNo: 2,
    language: 'English',
    hd: true,
    embedUrl: 'https://paribirdflygame.blogspot.com/?b4x=https://soccerball.st/rampages/searccch1/'
  },
  {
    id: 'l3',
    streamNo: 3,
    language: 'Arabic',
    hd: true,
    embedUrl: 'https://helloxsports.in/isl/player.html?get=https://live.shoranz.cfd/shossss3/index.m3u8'
  },
  {
    id: 'l4',
    streamNo: 4,
    language: 'Brazilian',
    hd: true,
    embedUrl: 'https://helloxsports.in/uefa/telemundo.html'
  },
  {
    id: 'l5',
    streamNo: 5,
    language: 'Vietnamese',
    hd: true,
    embedUrl: 'https://helloxsports.in/isl/player.html?get=https://live05.msdht.app/live/24561735.m3u8'
  },
  {
    id: 'l6',
    streamNo: 6,
    language: 'Multi Quality',
    hd: true,
    embedUrl: 'https://helloxsports.in/worldcup/dsports.html'
  },
  {
    id: 'l7',
    streamNo: 7,
    language: 'Malayalam',
    hd: true,
    embedUrl: 'https://masszipp3.github.io/hls2.html?url=https://ts.sptck.cfd/hls/tist1.m3u8'
  },
  {
    id: 'l8',
    streamNo: 8,
    language: 'Malayalam',
    hd: true,
    embedUrl: 'https://ok.ru/videoembed/15174081388058'
  },
  {
    id: '4k',
    streamNo: 9,
    language: '4K',
    hd: true,
    embedUrl: 'https://lordatomic.github.io/uefa/ceng.html'
  }
];
const LICENSED_EXTERNAL_EMBED_STREAM_BY_ID = new Map(
  LICENSED_EXTERNAL_EMBED_STREAMS.map((stream) => [stream.id, stream])
);
const FIFA_WC_TEAM_ALIASES = new Set([
  'algeria',
  'argentina',
  'australia',
  'austria',
  'belgium',
  'bosnia and herzegovina',
  'brazil',
  'canada',
  'cape verde',
  'cabo verde',
  'colombia',
  'congo dr',
  'dr congo',
  'czechia',
  'curacao',
  'croatia',
  'ecuador',
  'egypt',
  'england',
  'france',
  'germany',
  'ghana',
  'haiti',
  'iran',
  'iraq',
  'ivory coast',
  'cote d ivoire',
  'japan',
  'jordan',
  'korea republic',
  'south korea',
  'mexico',
  'morocco',
  'netherlands',
  'new zealand',
  'norway',
  'panama',
  'paraguay',
  'portugal',
  'qatar',
  'saudi arabia',
  'scotland',
  'senegal',
  'south africa',
  'spain',
  'sweden',
  'switzerland',
  'tunisia',
  'turkiye',
  'turkey',
  'united states',
  'usa',
  'uruguay',
  'uzbekistan'
]);

const toString = (value) => String(value ?? '').trim();

const toBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const withTimeout = async (promise, timeoutMs, label = 'operation') => {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const waitForBrowserPageReady = async (page = null) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 75);
      timer.unref?.();
    });
    if (!page) return;
    try {
      page.mainFrame();
      return;
    } catch {}
  }
};

const normalizeIdPart = (value) =>
  toString(value).toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'other';

const isSupplementalSportsSource = (source) =>
  SUPPLEMENTAL_SPORTS_SOURCES.has(normalizeIdPart(source));

const cleanDlhdChannelTitle = (value) =>
  toString(value)
    .replace(/\s*ID:\s*\d+\s*$/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();

const isLikelySportsDlhdChannelTitle = (value) => {
  const title = toString(value);
  if (!title || /\b(?:18\+|adult|xxx|babes|playboy|player-\d+)\b/iu.test(title)) return false;
  return /\b(?:sport|sports|espn|bein|dazn|tnt|sky|willow|cricket|tennis|golf|racing|formula|f1|motogp|ufc|fight|wwe|rugby|nfl|nba|mlb|nhl|fox\s*(?:sports|deportes)|fs[12]|eurosport|supersport|arena|ziggo|canal\+|setanta|tsn|astro|star\s*sports|ssc|sony\s*ten|ptv\s*sports|viaplay|eleven|match\s*football|sportklub|sport\s*tv|tv\s*sport|ppv)\b/iu.test(title);
};

const isLikelyFlixDlstreamsSportsEvent = ({ title = '', category = '', description = '' } = {}) => {
  const categoryText = normalizeTitle(category);
  if (categoryText === 'tv shows') return false;
  const text = normalizeTitle(`${title} ${category} ${description}`);
  return /\b(?:soccer|football|fifa|world cup|baseball|mlb|tennis|snooker|wta|atp|cricket|basketball|nba|wnba|field hockey|hockey|horse racing|motorsport|motogp|rugby|softball|cycling|sailing|boating|squash|wrestling|nxt|golf|ufc|boxing|fight|formula|f1|tour de france|wimbledon)\b/u.test(text);
};

const isDlhdInterstitialHtml = (html) =>
  /FingerprintJS|redirect_link|domain is for sale|window\.location\.href="\/lander"|Click here to enter/iu.test(toString(html));

const getStreamSourceRank = (source) =>
  STREAM_SOURCE_RANK.get(normalizeIdPart(source)) ?? STREAMED_SOURCE_DEFAULT_RANK;

const compareStreamsBySourceRank = (left = {}, right = {}) => {
  const leftRank = getStreamSourceRank(left.source);
  const rightRank = getStreamSourceRank(right.source);
  return leftRank - rightRank
    || Number(right.hd) - Number(left.hd)
    || Number(right.viewers || 0) - Number(left.viewers || 0);
};

const isSourceOnlyMatch = (match = {}, sourceName = '') => {
  const normalized = normalizeIdPart(sourceName);
  const sources = Array.isArray(match?.sources) ? match.sources : [];
  return sources.length > 0 && sources.every((source) => normalizeIdPart(source?.source) === normalized);
};

const normalizeTitle = (value) =>
  toString(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();

const normalizeTeamName = (value) =>
  normalizeTitle(value)
    .replace(/\bt\s*rkiye\b/gu, 'turkiye')
    .replace(/\bturkiye\b/gu, 'turkiye')
    .replace(/\bturkey\b/gu, 'turkey')
    .replace(/\bcuracao\b/gu, 'curacao')
    .replace(/\bcote d ivoire\b/gu, 'cote d ivoire')
    .replace(/\bcabo verde\b/gu, 'cabo verde')
    .replace(/\bcape verde\b/gu, 'cape verde');

const splitFixtureTeams = (title) => {
  const normalized = toString(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/['’]/gu, '')
    .replace(/[._/]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const parts = normalized
    .split(/\s+(?:vs?\.?|versus)\s+|\s+-\s+/u)
    .map((part) => normalizeTeamName(part.replace(/^\bppv\b\s+/u, '')))
    .filter(Boolean);
  return parts.length === 2 ? parts : [];
};

const getMatchEventKey = (match = {}) => {
  const title = normalizeTitle(match.title)
    .replace(/\bfifa world cup\b/gu, ' ')
    .replace(/\bworld cup\b/gu, ' ')
    .replace(/\ball soccer events\b/gu, ' ')
    .replace(/\b(?:multiview|tactical feed|backup stream|live stream|main feed)\b/gu, ' ')
    .replace(/\b(?:jun|june|jul|july)\b\s*\d{1,2}\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const parsedTeams = splitFixtureTeams(title);
  const teams = parsedTeams.length >= 2
    ? parsedTeams
    : (Array.isArray(match.teams) && match.teams.length >= 2 ? match.teams : []);
  const teamKey = teams.length >= 2
    ? teams.map(normalizeTeamName).filter(Boolean).sort().join('|')
    : '';
  if (teamKey) return `teams:${teamKey}`;
  const titleKey = title
    .split(/\s+/u)
    .filter((part) => !['channel', 'live', 'tv', 'v', 'vs', 'event', 'events', 'sports'].includes(part))
    .join(' ');
  return titleKey ? `title:${titleKey}` : '';
};

const isFifaWorldCupTeam = (team) => FIFA_WC_TEAM_ALIASES.has(normalizeTeamName(team));

const extractFifaWorldCupTeamsFromText = (value = '') => {
  const normalized = ` ${normalizeTitle(value)} `;
  const matches = [];
  for (const alias of FIFA_WC_TEAM_ALIASES) {
    const team = normalizeTeamName(alias);
    const index = normalized.indexOf(` ${team} `);
    if (index >= 0) matches.push({ team, index });
  }
  const seen = new Set();
  return matches
    .sort((left, right) => left.index - right.index || right.team.length - left.team.length)
    .map((match) => match.team)
    .filter((team) => {
      if (seen.has(team)) return false;
      seen.add(team);
      return true;
    })
    .slice(0, 2);
};

const isFifaWorldCupMatch = (match = {}) => {
  const text = `${match.title || ''} ${match.category || ''}`;
  if (/\bworld\s+cup\b/iu.test(text) && /\b(?:fifa|football|soccer)\b/iu.test(text)) return true;
  if (normalizeIdPart(match.category) !== 'football') return false;
  const teams = Array.isArray(match.teams) && match.teams.length === 2
    ? match.teams
    : splitFixtureTeams(match.title);
  return teams.length === 2 && teams.every(isFifaWorldCupTeam);
};

const isPortugalUzbekistanMatch = (match = {}) => {
  const text = normalizeTitle([
    match.title,
    match.category,
    Array.isArray(match.teams) ? match.teams.join(' ') : ''
  ].filter(Boolean).join(' '));
  return /\bportugal\b/u.test(text) && /\buzbekistan\b/u.test(text);
};

const isGermanyMatch = (match = {}) => {
  const text = normalizeTitle([
    match.title,
    match.category,
    Array.isArray(match.teams) ? match.teams.join(' ') : ''
  ].filter(Boolean).join(' '));
  return /\bgermany\b/u.test(text);
};

const isHttpUrl = (value) => {
  try {
    const parsed = new URL(toString(value), API_BASE);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const isTrustedDirectPlaylistUrl = (source = '', value = '') => {
  if (!isHttpUrl(value)) return false;
  if (/\.m3u8(?:$|[?#])/iu.test(value)) return true;
  try {
    const parsed = new URL(toString(value));
    return normalizeIdPart(source) === SPORTSBITE_SOURCE
      && parsed.hostname === 'embed.cr7siuu.xyz'
      && parsed.pathname === '/manifest'
      && /\.m3u8(?:$|[?#])/iu.test(parsed.searchParams.get('url') || '');
  } catch {
    return false;
  }
};

const isLikelyHlsResponse = (url, headers = {}) => {
  if (/\.m3u8(?:$|[?#])/iu.test(toString(url))) return true;
  const contentType = toString(headers['content-type'] || headers['Content-Type']).toLowerCase();
  return HLS_CONTENT_TYPE_RE.test(contentType);
};

const isHlsPlaylistText = (value) => toString(value).trimStart().startsWith('#EXTM3U');

const extractDirectHlsUrl = (value) => {
  const normalized = toString(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (/\.m3u8$/iu.test(parsed.pathname) && isHttpUrl(normalized)) return normalized;
  } catch {
    // Fall through to nested parameter and text extraction.
  }
  const candidates = [];
  try {
    const parsed = new URL(normalized);
    for (const paramValue of parsed.searchParams.values()) {
      if (paramValue) candidates.push(paramValue);
    }
  } catch {
    // Fall through to regex extraction below.
  }
  candidates.push(normalized);

  for (const candidate of candidates) {
    const decoded = (() => {
      try {
        return decodeURIComponent(candidate);
      } catch {
        return candidate;
      }
    })();
    const match = decoded.match(/https?:\/\/[^\s"'<>]+?\.m3u8(?:[^\s"'<>]*)?/iu);
    if (match?.[0] && isHttpUrl(match[0])) return match[0];
  }
  return null;
};

const toAbsoluteStreamedUrl = (value) => {
  const normalized = toString(value);
  if (!normalized) return null;
  try {
    return new URL(normalized, API_BASE).toString();
  } catch {
    return null;
  }
};

const formatEventTime = (dateValue) => {
  const date = Number(dateValue || 0);
  if (!Number.isFinite(date) || date <= 0) return 'Live';
  return new Date(date).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};

const LIVE_EVENT_WINDOW_MS = 3 * 60 * 60 * 1000;
const SHORT_SESSION_LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
const LONG_LIVE_EVENT_WINDOW_MS = 4 * 60 * 60 * 1000;
const HELLOSPORTS_PRESTART_WINDOW_MS = 15 * 60 * 1000;

const getLiveEventWindowMs = (match = {}) => {
  const haystack = normalizeTitle([
    match?.title,
    match?.category,
    Array.isArray(match?.teams) ? match.teams.join(' ') : '',
    match?.normalizedTitle
  ].filter(Boolean).join(' '));
  if (/\b(?:practice|qualifying|sprint|stage|heat|session)\b/u.test(haystack)) {
    return SHORT_SESSION_LIVE_WINDOW_MS;
  }
  if (/\b(?:cricket|test match|golf|tennis|atp|wta|wimbledon|ufc|boxing|snooker|darts|cycling|road championships)\b/u.test(haystack)) {
    return LONG_LIVE_EVENT_WINDOW_MS;
  }
  return LIVE_EVENT_WINDOW_MS;
};

const isEventLiveByTime = (dateValue, now = Date.now(), match = {}) => {
  const date = Number(dateValue || 0);
  return Number.isFinite(date) && date > 0 && date <= now && now <= date + getLiveEventWindowMs(match);
};

const isLiveCatalog = (catalog = {}) =>
  toString(catalog?.id) === 'streamed-events-live' || toString(catalog?.endpoint) === '/api/matches/live';

const isCurrentlyLiveMatch = (match = {}) => {
  const date = Number(match?.date || 0);
  const hasDate = Number.isFinite(date) && date > 0;
  const explicitLive = Boolean(
    match?.isLive
    || match?.live
    || match?.currentlyLive
    || normalizeIdPart(match?.status) === 'live'
  );
  if (hasDate) {
    const now = Date.now();
    if (date > now || now > date + getLiveEventWindowMs(match)) return false;
    return explicitLive || isEventLiveByTime(date, now, match);
  }
  return explicitLive;
};

const isWithinPrestartWindow = (match = {}, windowMs = 0, now = Date.now()) => {
  const date = Number(match?.date || 0);
  return Number.isFinite(date) && date > now && date - now <= windowMs;
};

const shouldProbeHelloSportsForMatch = (match = {}) =>
  isCurrentlyLiveMatch(match) || isWithinPrestartWindow(match, HELLOSPORTS_PRESTART_WINDOW_MS);

const inferLiveTvGenres = (title = '') => {
  const normalized = normalizeTitle(title);
  const genres = ['Live TV'];
  const add = (genre) => {
    if (!genres.includes(genre)) genres.push(genre);
  };
  const cricketSpecific = /\b(?:cricket|willow|criclife|cricbuzz)\b/u.test(normalized);
  const explicitWorldCup = /\b(?:fifa|world cup|wc)\b/u.test(normalized);
  if (explicitWorldCup || (!cricketSpecific && /\b(?:bein sports|bein max|fox sports|fox deportes|fs1|fs2|tsn|rds|ctv|tudn|univision|telemundo|universo|itv\d*|bbc|sport tv|rtp|tve|la 1|tf1|m6|ard|zdf|das erste|srf|orf|rai|optus|supersport|sabc|sbs|astro|sony sports|sony ten|star sports|sports18|jio|hotstar|viaplay|svt|nrk|yle|nos|vrt|rtbf|tvp|match tv)\b/u.test(normalized))) {
    add('FIFA WC');
  }
  if (!cricketSpecific && /\b(?:football|soccer|fifa|world cup|premier league|laliga|serie a|bundesliga|ligue 1|uefa|espn|bein sports|bein max|fox sports|fs1|fs2|tudn|univision|telemundo|universo|itv\d*|bbc|sport tv|supersport football|astro supersport)\b/u.test(normalized)) {
    add('Football');
  }
  if (/\b(?:cricket|willow|sky sports cricket|sky sports main event|sky sports mix|star sports|starsports|ptv sports|ten sports|sony sports|sony ten|sports18|jio|hotstar|fancode|t sports|tsports|gazi tv|gtv|super sport cricket|supersport cricket|criclife|asports|a sports|ary zap|rta sport|tnt sports)\b/u.test(normalized)) {
    add('Cricket');
  }
  if (/\b(?:tennis|atp|wta|eurosport|tennis channel)\b/u.test(normalized)) {
    add('Tennis');
  }
  if (/\b(?:f1|formula|motogp|moto gp|nascar|racing|sky sports f1)\b/u.test(normalized)) {
    add('Motorsport');
  }
  if (/\b(?:ufc|boxing|fight|wwe|combat|dazn)\b/u.test(normalized)) {
    add('Fight');
  }
  if (/\b(?:nba|nfl|mlb|nhl|espn|fox sports|nbc sports|cbs sports|tnt|usa network|yes network|nesn|masn|sny|bally)\b/u.test(normalized)) {
    add('US Sports');
  }
  if (/\b(?:golf|pga|sky sports golf)\b/u.test(normalized)) {
    add('Golf');
  }
  if (/\b(?:rugby|premier sports|sky sports action)\b/u.test(normalized)) {
    add('Rugby');
  }
  if (/\b(?:sports news|sky sports news|espnews)\b/u.test(normalized)) {
    add('Sports News');
  }
  return genres;
};

const LIVE_TV_GENRE_RANK = new Map([
  ['FIFA WC', 0],
  ['Cricket', 1],
  ['Football', 2],
  ['Tennis', 3],
  ['US Sports', 4],
  ['Motorsport', 5],
  ['Fight', 6],
  ['Golf', 7],
  ['Rugby', 8],
  ['Sports News', 9],
  ['Live TV', 20]
]);

const getLiveTvChannelRank = (channel = {}) => {
  const genres = Array.isArray(channel?.genres) ? channel.genres : inferLiveTvGenres(channel?.title);
  const ranked = genres
    .map((genre) => LIVE_TV_GENRE_RANK.get(toString(genre)))
    .filter(Number.isFinite);
  const base = ranked.length ? Math.min(...ranked) : 30;
  return base + (isLikelySportsDlhdChannelTitle(channel?.title) ? 0 : 40);
};

const getCdnLiveTvChannelPayloadFromMatch = (channel = {}) => {
  const source = (Array.isArray(channel?.sources) ? channel.sources : [])
    .find((entry) => toString(entry?.id));
  if (!source) return null;
  try {
    const parsed = JSON.parse(Buffer.from(toString(source.id), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const withLiveTvChannelGenres = (channel = {}) => {
  const rawTitle = toString(channel?.title);
  const payload = getCdnLiveTvChannelPayloadFromMatch(channel);
  const code = toString(payload?.code).toUpperCase();
  const title = code && rawTitle && !new RegExp(`\\(${code.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\)$`, 'u').test(rawTitle)
    ? `${rawTitle} (${code})`
    : rawTitle;
  const genres = inferLiveTvGenres(title);
  return {
    ...channel,
    title,
    genres,
    normalizedTitle: normalizeTitle(`${title} live tv cdnlivetv channel ${genres.join(' ')}`)
  };
};

export class StreamedSportsAdapter {
  constructor({
    logger = console,
    fetchImpl = globalThis.fetch,
    chromePath = '',
    browserTimeoutMs = DEFAULT_BROWSER_TIMEOUT_MS,
    hlsCacheMs = DEFAULT_HLS_CACHE_MS,
    browserIdleMs = DEFAULT_BROWSER_IDLE_MS,
    cacheDir = path.join(process.cwd(), 'cache', 'streamed-sports'),
    sportzXStreamsEnabled = toBoolean(process.env.SPORTZX_STREAMS_ENABLED, false),
    sportzXBaseUrl = process.env.SPORTZX_BASE_URL || 'https://modiii.top/',
    sportzXFallbackUrl = process.env.SPORTZX_FALLBACK_URL || 'https://anshulajoy10.github.io/mygaja/'
  } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.chromePath = toString(chromePath || process.env.STREAMED_SPORTS_CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH);
    this.browserTimeoutMs = Math.max(5_000, Number(browserTimeoutMs || DEFAULT_BROWSER_TIMEOUT_MS));
    this.hlsCacheMs = Math.max(DEFAULT_HLS_CACHE_MS, Number(hlsCacheMs ?? DEFAULT_HLS_CACHE_MS));
    this.browserIdleMs = Math.max(10_000, Number(browserIdleMs || DEFAULT_BROWSER_IDLE_MS));
    this.cacheDir = cacheDir;
    this.cacheDirReady = null;
    this.sportsCache = null;
    this.matchesCache = new Map();
    this.matchIndex = new Map();
    this.catalogMatchIndex = new Map();
    this.streamCache = new Map();
    this.sportsBiteSourceStreams = new Map();
    this.dlhdScheduleCache = null;
    this.dlhdChannelsCache = null;
    this.dlhdScheduleInFlight = null;
    this.dlhdChannelsInFlight = null;
    this.worldCupXtreamStreamsCache = null;
    this.sportSrcMatchesCache = new Map();
    this.sportSrcDetailCache = new Map();
    this.rapidFootballMatchesCache = null;
    this.rexdexPostsCache = null;
    this.helloSports4kCache = null;
    this.helloSportsPostsCache = null;
    this.knownSportsHealthCache = new Map();
    this.knownSportsHealthInFlight = new Map();
    this.cdnLiveTvHealthCache = new Map();
    this.cdnLiveTvHealthInFlight = new Map();
    this.replayZoneMatchesCache = null;
    this.replayZoneHlsCache = new Map();
    this.dlhdHlsCache = new Map();
    this.dlhdHlsInFlight = new Map();
    this.hlsCache = new Map();
    this.playlistCache = new Map();
    this.mediaCache = new Map();
    this.mediaCacheBytes = 0;
    this.browserFetchInFlight = new Map();
    this.playlistPrewarmInFlight = new Map();
    this.liveStreamPrewarmInFlight = null;
    this.hlsResolveInFlight = new Map();
    this.browserPromise = null;
    this.browserFetchPagePromise = null;
    this.browserFetchPageUses = 0;
    this.hlsResolvePagePromise = null;
    this.hlsResolvePageUses = 0;
    this.hlsResolveChain = Promise.resolve();
    this.browserFetchChain = Promise.resolve();
    this.browserIdleTimer = null;
    this.activeBrowserPages = 0;
    this.browserLaunchFailures = 0;
    this.browserDisabledUntil = 0;
    this.hlsProbeEnabled = toString(process.env.STREAMED_SPORTS_HLS_PROBE_ENABLED).toLowerCase() === 'true';
    this.hlsBrowserFallbackEnabled = toString(
      process.env.STREAMED_SPORTS_HLS_BROWSER_FALLBACK_ENABLED || (this.hlsProbeEnabled ? 'false' : 'true')
    ).toLowerCase() === 'true';
    this.hlsProbeFailures = 0;
    this.hlsProbeDisabledUntil = 0;
    this.sportzXStreamSource = sportzXStreamsEnabled
      ? new SportzXStreamSource({
        logger,
        fetchImpl,
        baseUrl: sportzXBaseUrl,
        fallbackUrl: sportzXFallbackUrl
      })
      : null;
  }

  async fetchJson(path, signal = null) {
    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      signal,
      headers: {
        accept: 'application/json,*/*',
        'User-Agent': 'NebulaStreams/1.0',
        Referer: 'https://streamed.pk/'
      }
    });
    if (!response.ok) throw new Error(`Streamed HTTP ${response.status}`);
    return response.json();
  }

  getSportsBiteHeaders({ accept = 'application/json,*/*' } = {}) {
    return {
      accept,
      origin: SPORTSBITE_ORIGIN,
      referer: `${SPORTSBITE_ORIGIN}/`,
      'user-agent': BROWSER_USER_AGENT
    };
  }

  getStreamFreeHeaders({ referer = `${STREAMFREE_ORIGIN}/`, accept = 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*' } = {}) {
    return {
      accept,
      origin: STREAMFREE_ORIGIN,
      referer,
      'user-agent': BROWSER_USER_AGENT
    };
  }

  getFlixDlstreamsHeaders({ referer = `${FLIX_DLSTREAMS_BASE_URL}/manifest.json`, accept = 'application/json,*/*' } = {}) {
    return {
      accept,
      referer,
      'user-agent': 'NebulaStreams/1.0'
    };
  }

  getCdnLiveTvHeaders({ referer = `${CDNLIVETV_ORIGIN}/`, accept = 'application/json,*/*' } = {}) {
    return {
      accept,
      origin: CDNLIVETV_ORIGIN,
      referer,
      'user-agent': BROWSER_USER_AGENT
    };
  }

  getRexDexHeaders({ referer = `${REXDEX_ORIGIN}/`, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } = {}) {
    return {
      accept,
      origin: REXDEX_ORIGIN,
      referer,
      'user-agent': BROWSER_USER_AGENT
    };
  }

  getRexDexHlsHeaders(contextUrl = `${REXDEX_ORIGIN}/`) {
    return this.getRexDexHeaders({
      referer: contextUrl || `${REXDEX_ORIGIN}/`,
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,text/plain,*/*'
    });
  }

  getHelloSportsHeaders({ referer = `${HELLOSPORTS_ORIGIN}/`, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } = {}) {
    return {
      accept,
      origin: HELLOSPORTS_ORIGIN,
      referer,
      'user-agent': BROWSER_USER_AGENT
    };
  }

  getHelloSportsHlsHeaders(contextUrl = HELLOSPORTS_4K_PAGE) {
    return this.getHelloSportsHeaders({
      referer: contextUrl || HELLOSPORTS_4K_PAGE,
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,text/plain,*/*'
    });
  }

  getKnownSportsHlsHeaders() {
    return {
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,text/plain,*/*',
      'user-agent': BROWSER_USER_AGENT
    };
  }

  buildCdnLiveTvApiUrl(pathName, params = {}) {
    const url = new URL(pathName, CDNLIVETV_API_BASE);
    url.searchParams.set('user', CDNLIVETV_USER || 'cdnlivetv');
    url.searchParams.set('plan', CDNLIVETV_PLAN || 'free');
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async fetchCdnLiveTvJson(pathName, signal = null) {
    const response = await this.fetchImpl(this.buildCdnLiveTvApiUrl(pathName), {
      signal,
      headers: this.getCdnLiveTvHeaders()
    });
    if (!response.ok) throw new Error(`CDNLiveTV HTTP ${response.status}`);
    return response.json();
  }

  async fetchRexDexPosts(signal = null) {
    if (this.rexdexPostsCache?.expiresAt > Date.now()) {
      return this.rexdexPostsCache.value;
    }

    const response = await this.fetchImpl(REXDEX_FEED_URL, {
      signal,
      redirect: 'follow',
      headers: this.getRexDexHeaders({
        accept: 'application/json,text/javascript,*/*;q=0.8'
      })
    });
    if (!response.ok) throw new Error(`RexDex feed HTTP ${response.status}`);
    const payload = await response.json();
    const posts = (Array.isArray(payload?.feed?.entry) ? payload.feed.entry : [])
      .map((entry) => {
        const title = toString(entry?.title?.$t);
        const url = (Array.isArray(entry?.link) ? entry.link : [])
          .find((link) => toString(link?.rel) === 'alternate' && isHttpUrl(link?.href))?.href;
        if (!title || !url) return null;
        return {
          title,
          url,
          published: toString(entry?.published?.$t),
          normalizedTitle: normalizeTitle(title),
          teams: splitFixtureTeams(title)
        };
      })
      .filter(Boolean);
    this.rexdexPostsCache = {
      value: posts,
      expiresAt: Date.now() + REXDEX_POST_CACHE_MS
    };
    return posts;
  }

  getHelloSportsMatchTeams(match = {}) {
    const teams = Array.isArray(match.teams) && match.teams.length >= 2
      ? match.teams.map(normalizeTeamName).filter(Boolean)
      : [];
    if (teams.length >= 2) return teams.slice(0, 2);
    const splitTeams = splitFixtureTeams(match.title);
    if (splitTeams.length >= 2 && splitTeams.every(isFifaWorldCupTeam)) return splitTeams;
    return extractFifaWorldCupTeamsFromText(`${match.title || ''} ${match.category || ''}`);
  }

  async fetchHelloSportsPosts(signal = null) {
    if (this.helloSportsPostsCache?.expiresAt > Date.now()) {
      return this.helloSportsPostsCache.value;
    }

    const response = await this.fetchImpl(HELLOSPORTS_FEED_URL, {
      signal,
      redirect: 'follow',
      headers: this.getHelloSportsHeaders({
        accept: 'application/json,text/javascript,*/*;q=0.8'
      })
    });
    if (!response.ok) throw new Error(`HelloSports feed HTTP ${response.status}`);
    const payload = await response.json();
    const posts = (Array.isArray(payload?.feed?.entry) ? payload.feed.entry : [])
      .map((entry) => {
        const title = toString(entry?.title?.$t);
        const url = (Array.isArray(entry?.link) ? entry.link : [])
          .find((link) => toString(link?.rel) === 'alternate' && isHttpUrl(link?.href))?.href;
        const categories = (Array.isArray(entry?.category) ? entry.category : [])
          .map((category) => toString(category?.term))
          .filter(Boolean);
        if (!title || !url) return null;
        const teams = extractFifaWorldCupTeamsFromText(title);
        const categoryText = categories.join(' ');
        const isWorldCupPost = isFifaWorldCupMatch({ title, category: categoryText, teams })
          || /\b(?:fifa|world cup|wc)\b/iu.test(`${title} ${categoryText}`);
        if (!isWorldCupPost) return null;
        return {
          title,
          url,
          published: toString(entry?.published?.$t),
          normalizedTitle: normalizeTitle(`${title} ${categoryText}`),
          teams
        };
      })
      .filter(Boolean);
    this.helloSportsPostsCache = {
      value: posts,
      expiresAt: Date.now() + HELLOSPORTS_POST_CACHE_MS
    };
    return posts;
  }

  encodeHelloSportsStreamId(stream = {}) {
    return Buffer.from(JSON.stringify({
      url: toString(stream?.embedUrl || stream?.url),
      channelName: toString(stream?.channelName || stream?.language || stream?.label)
    }), 'utf8').toString('base64url');
  }

  decodeHelloSportsStreamId(sourceId = '') {
    try {
      const parsed = JSON.parse(Buffer.from(toString(sourceId), 'base64url').toString('utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      const url = toString(parsed.url);
      if (!isHttpUrl(url)) return null;
      return {
        url,
        channelName: toString(parsed.channelName)
      };
    } catch {
      return null;
    }
  }

  cleanHelloSportsChannelName(label = '') {
    return toString(label)
      .replace(/\bLink\s*\d+\s*\|?/giu, '')
      .replace(/\bClick\s+Here\s+to\s+Watch\s+Live\b/giu, '')
      .replace(/\b(?:hd|fhd|uhd|4k|1080p?|full\s*hd|quality|stream)\b/giu, '')
      .replace(/\|/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim() || '4K Channel';
  }

  inferHelloSportsPlaybackProfile(label = '') {
    const normalized = normalizeTitle(label);
    if (/\b(?:4k|uhd|2160p?)\b/u.test(normalized)) {
      return { quality: '4K', speedMbps: 25 };
    }
    if (/\b(?:fhd|1080p?|full\s*hd)\b/u.test(normalized)) {
      return { quality: '1080p', speedMbps: 10 };
    }
    if (/\bmalayal?am\b/u.test(normalized)) {
      return { quality: '1080p', speedMbps: 10 };
    }
    return { quality: 'HD', speedMbps: 8 };
  }

  extractHelloSportsButtonUrl(value = '') {
    const text = toString(value);
    const match = text.match(/location\.href\s*=\s*['"]([^'"]+)['"]/iu)
      || text.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/iu)
      || text.match(/window\.open\(\s*['"]([^'"]+)['"]/iu);
    if (!match?.[1]) return '';
    try {
      return new URL(match[1], HELLOSPORTS_4K_PAGE).toString();
    } catch {
      return '';
    }
  }

  async fetchHelloSports4kEntries(signal = null) {
    if (this.helloSports4kCache?.expiresAt > Date.now()) {
      return this.helloSports4kCache.value;
    }
    const response = await this.fetchImpl(HELLOSPORTS_4K_PAGE, {
      signal,
      redirect: 'follow',
      headers: this.getHelloSportsHeaders()
    });
    if (!response.ok) throw new Error(`HelloSports HTTP ${response.status}`);
    const html = await response.text();
    const $ = loadHtml(html);
    const seen = new Set();
    const entries = [];
    $('button, a').each((_, element) => {
      const label = $(element).text().replace(/\s+/gu, ' ').trim();
      const qualityText = normalizeTitle(label);
      if (!/\b(?:4k|uhd|fhd|1080p?|full\s*hd|malayal?am|malaylam)\b/u.test(qualityText)) return;
      const href = toString($(element).attr('href')) || this.extractHelloSportsButtonUrl($(element).attr('onclick'));
      if (!href) return;
      let embedUrl = '';
      try {
        embedUrl = new URL(href, HELLOSPORTS_4K_PAGE).toString();
      } catch {
        return;
      }
      if (!isHttpUrl(embedUrl) || seen.has(embedUrl)) return;
      seen.add(embedUrl);
      entries.push({
        embedUrl,
        channelName: this.cleanHelloSportsChannelName(label),
        label,
        playbackProfile: this.inferHelloSportsPlaybackProfile(label)
      });
    });
    this.helloSports4kCache = {
      value: entries,
      expiresAt: Date.now() + HELLOSPORTS_4K_CACHE_MS
    };
    return entries;
  }

  normalizeHelloSportsEmbedText(value = '') {
    let normalized = toString(value)
      .replace(/\\u0026/giu, '&')
      .replace(/\\\//gu, '/')
      .replace(/&amp;/giu, '&')
      .replace(/&#038;/giu, '&')
      .replace(/&quot;/giu, '"')
      .replace(/&#39;/giu, "'");
    for (let index = 0; index < 2; index += 1) {
      try {
        const decoded = decodeURIComponent(normalized);
        if (decoded === normalized) break;
        normalized = decoded;
      } catch {
        break;
      }
    }
    return normalized;
  }

  extractHelloSportsHlsCandidates(html = '', contextUrl = HELLOSPORTS_4K_PAGE) {
    const candidates = new Map();
    const addDirect = (value = '', referrer = contextUrl) => {
      const normalized = this.normalizeHelloSportsEmbedText(value).replace(/[),;]+$/u, '');
      if (!isHttpUrl(normalized)) return;
      try {
        const parsed = new URL(normalized);
        if (!/\.m3u8$/iu.test(parsed.pathname)) return;
        if (!candidates.has(parsed.toString())) {
          candidates.set(parsed.toString(), {
            url: parsed.toString(),
            contextUrl: referrer || contextUrl
          });
        }
      } catch {
        // Ignore malformed candidate.
      }
    };
    const inspectUrl = (value = '', referrer = contextUrl) => {
      const normalized = this.normalizeHelloSportsEmbedText(value).replace(/[),;]+$/u, '');
      if (!isHttpUrl(normalized)) return;
      try {
        const parsed = new URL(normalized, contextUrl);
        for (const key of ['x', 'url', 'file', 'src', 'hls', 'stream']) {
          const nested = parsed.searchParams.get(key);
          if (nested) addDirect(nested, parsed.toString());
        }
        addDirect(parsed.toString(), referrer);
      } catch {
        // Ignore malformed wrapper URL.
      }
    };
    const normalizedHtml = this.normalizeHelloSportsEmbedText(html);
    for (const match of normalizedHtml.matchAll(/https?:\/\/[^\s"'<>]+/giu)) {
      inspectUrl(match[0], contextUrl);
    }
    return Array.from(candidates.values());
  }

  async resolveHelloSportsEmbedHls(embedUrl, signal = null) {
    const response = await this.fetchImpl(embedUrl, {
      signal,
      redirect: 'follow',
      headers: this.getHelloSportsHeaders({
        referer: HELLOSPORTS_4K_PAGE
      })
    });
    if (!response.ok) throw new Error(`HelloSports embed HTTP ${response.status}`);
    const html = await response.text();
    const contextUrl = response.url || embedUrl;
    const candidates = this.extractHelloSportsHlsCandidates(html, contextUrl);
    if (!candidates.length) throw new Error('HelloSports HLS not found');

    let lastError = null;
    for (const candidate of candidates.slice(0, 8)) {
      const headers = this.getHelloSportsHlsHeaders(candidate.contextUrl || contextUrl);
      try {
        const playbackProfile = await this.validateDirectHlsUrl(candidate.url, signal, headers, {
          probeSegments: false,
          timeoutMs: 6_000
        });
        return {
          url: candidate.url,
          contextUrl: candidate.contextUrl || contextUrl,
          headers,
          playbackProfile,
          resolveOnPlayback: this.requiresBrowserHlsContext(candidate.url)
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('HelloSports HLS not playable');
  }

  scoreHelloSportsPostForMatch(post = {}, match = {}) {
    const matchTeams = this.getHelloSportsMatchTeams(match);
    const postTeams = Array.isArray(post.teams) && post.teams.length >= 2
      ? post.teams.map(normalizeTeamName).filter(Boolean)
      : extractFifaWorldCupTeamsFromText(post.title);
    if (matchTeams.length >= 2 && postTeams.length >= 2) {
      const matchedTeams = matchTeams.filter((team) => postTeams.includes(team)).length;
      if (matchedTeams >= 2) return 100;
      if (matchedTeams === 1) return 30;
    }

    const matchKey = getMatchEventKey(match);
    const postKey = getMatchEventKey({ title: post.title, teams: postTeams });
    if (matchKey && postKey && matchKey === postKey) return 90;

    const matchWords = new Set(normalizeTitle(`${match.title || ''} ${match.category || ''}`).split(/\s+/u).filter((word) => word.length > 2));
    const postWords = new Set(normalizeTitle(`${post.title || ''} ${post.normalizedTitle || ''}`).split(/\s+/u).filter((word) => word.length > 2));
    const hits = [...matchWords].filter((word) => postWords.has(word)).length;
    return hits >= 3 ? hits * 10 : 0;
  }

  async findHelloSportsPostForMatch(match = {}, signal = null) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED || !isFifaWorldCupMatch(match) || !match?.title) return null;
    const posts = await this.fetchHelloSportsPosts(signal);
    const candidates = posts
      .map((post) => ({
        post,
        score: this.scoreHelloSportsPostForMatch(post, match)
      }))
      .filter((entry) => entry.score >= 90)
      .sort((left, right) =>
        right.score - left.score
        || Date.parse(right.post.published || 0) - Date.parse(left.post.published || 0)
      );
    return candidates[0]?.post || null;
  }

  async fetchFlixDlstreamsJson(pathName, signal = null) {
    const response = await this.fetchImpl(`${FLIX_DLSTREAMS_BASE_URL}${pathName}`, {
      signal,
      headers: this.getFlixDlstreamsHeaders()
    });
    if (!response.ok) throw new Error(`Flix DLStreams HTTP ${response.status}`);
    return response.json();
  }

  async getFlixDlstreamsCatalogIds(signal = null) {
    const payload = await this.fetchFlixDlstreamsJson('/manifest.json', signal);
    const ids = (Array.isArray(payload?.catalogs) ? payload.catalogs : [])
      .map((catalog) => toString(catalog?.id))
      .filter((id) => id === 'essential-live-events'
        || (/^dlstreams-sport-/u.test(id) && !/\btv-shows\b/u.test(id)));
    return [...new Set(ids)];
  }

  async loadFlixDlstreamsCatalogMetas(signal = null) {
    const catalogIds = await this.getFlixDlstreamsCatalogIds(signal);
    const settled = await Promise.allSettled(catalogIds.map(async (catalogId) => {
      const payload = await this.fetchFlixDlstreamsJson(`/catalog/tv/${encodeURIComponent(catalogId)}.json`, signal);
      return Array.isArray(payload?.metas) ? payload.metas : [];
    }));
    return settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter(Boolean);
  }

  getDlhdHeaders({ referer = `${DLHD_ORIGIN}/`, accept = 'text/html,application/xhtml+xml,*/*' } = {}) {
    return {
      accept,
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      referer,
      'sec-ch-ua': '"Chromium";v="149", "Not=A?Brand";v="24", "Google Chrome";v="149"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'user-agent': BROWSER_USER_AGENT
    };
  }

  async fetchDlhdHtml(url, { signal = null, referer = '', accept = 'text/html,application/xhtml+xml,*/*' } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('DLHD request aborted');
    const normalizedUrl = toString(url);
    const fallbackReferer = (() => {
      try {
        return new URL('/', normalizedUrl).toString();
      } catch {
        return DLHD_ORIGIN + '/';
      }
    })();
    const response = await this.fetchImpl(normalizedUrl, {
      signal,
      redirect: 'follow',
      headers: this.getDlhdHeaders({
        referer: referer || fallbackReferer,
        accept
      })
    });
    if (!response.ok) throw new Error(`DLHD HTTP ${response.status}`);
    const html = await response.text();
    if (!isDlhdInterstitialHtml(html) || !this.chromePath) return html;
    return this.fetchDlhdHtmlWithBrowser(normalizedUrl, { signal });
  }

  async fetchDlhdHtmlWithBrowser(url, { signal = null } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('DLHD browser request aborted');
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    this.activeBrowserPages += 1;
    try {
      await page.setUserAgent(BROWSER_USER_AGENT);
      await page.setExtraHTTPHeaders({
        'accept-language': 'en-US,en;q=0.9'
      });
      await waitForBrowserPageReady(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.browserTimeoutMs });
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3_000 }).catch(() => null),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1_200);
          timer.unref?.();
        })
      ]);
      if (signal?.aborted) throw signal.reason || new Error('DLHD browser request aborted');
      return await page.content();
    } finally {
      await page.close().catch(() => {});
      this.activeBrowserPages = Math.max(0, this.activeBrowserPages - 1);
      this.scheduleBrowserIdleClose();
    }
  }

  async fetchDlhdApi(endpoint, signal = null) {
    if (!DLHD_API_KEY) return null;
    let lastError = null;
    for (const origin of DLHD_ORIGINS) {
      try {
        const apiUrl = new URL('/daddyapi.php', origin);
        apiUrl.searchParams.set('key', DLHD_API_KEY);
        apiUrl.searchParams.set('endpoint', endpoint);
        const response = await this.fetchImpl(apiUrl.toString(), {
          signal,
          redirect: 'follow',
          headers: this.getDlhdHeaders({
            referer: `${origin}/`,
            accept: 'application/json,text/plain,*/*'
          })
        });
        if (!response.ok) throw new Error(`DLHD API ${endpoint} HTTP ${response.status}`);
        const payload = await response.json();
        if (payload?.success === false) throw new Error(payload?.message || payload?.error || `DLHD API ${endpoint} failed`);
        return payload?.data ?? payload;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`DLHD API ${endpoint} unavailable`);
  }

  toDlhdChannelMatch(entry = {}) {
    const playerUrl = toString(entry.url || entry.playerUrl || entry.player_url);
    const channelId = toString(entry.channel_id || entry.channelId || entry.id)
      || normalizeIdPart(`${entry.name || entry.channel_name || entry.channelName || entry.title}-${entry.code || entry.channel_code || entry.channelCode || playerUrl}`);
    const rawTitle = cleanDlhdChannelTitle(entry.channel_name || entry.channelName || entry.name || entry.title);
    if (!channelId || !rawTitle) return null;
    const code = toString(entry.channel_code || entry.channelCode || entry.code).toUpperCase();
    const title = code && !new RegExp(`\\(${code.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\)$`, 'u').test(rawTitle)
      ? `${rawTitle} (${code})`
      : rawTitle;
    const genres = inferLiveTvGenres(title);
    return {
      id: `streamed:${encodeURIComponent(`cdnlivetv-channel-${channelId}`)}`,
      sourceId: `cdnlivetv-channel-${channelId}`,
      type: STREMIO_SPORTS_TYPE,
      title,
      category: 'Live TV',
      date: Date.now(),
      poster: null,
      popular: false,
      genres,
      sources: [{
        source: CDNLIVETV_SOURCE,
        id: this.encodeCdnLiveTvSourceId({
          id: channelId,
          channel_name: rawTitle,
          channel_code: entry.channel_code || entry.channelCode || entry.code || '',
          url: playerUrl,
          image: entry.image || entry.logo_url || entry.logoUrl || '',
          viewers: entry.viewers || 0
        })
      }],
      teams: [],
      normalizedTitle: normalizeTitle(`${title} live tv cdnlivetv channel ${genres.join(' ')}`)
    };
  }

  async loadDlhdApiChannels(signal = null) {
    const payload = await this.fetchCdnLiveTvJson('/api/v1/channels/', signal);
    const entries = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.channels) ? payload.channels : []);
    return entries
      .map((entry) => this.toDlhdChannelMatch(entry))
      .map((channel) => channel ? withLiveTvChannelGenres(channel) : null)
      .filter(Boolean);
  }

  async loadDlhdApiSchedule(signal = null) {
    const payload = await this.fetchDlhdApi('schedule', signal);
    const schedule = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const events = [];
    const pushEvent = (event = {}, category = '') => {
      const title = toString(event.event || event.title || event.name);
      if (!title) return;
      const channels = [
        ...(Array.isArray(event.channels) ? event.channels : []),
        ...(Array.isArray(event.channels2) ? event.channels2 : [])
      ]
        .map((channel) => ({
          id: toString(channel.channel_id || channel.channelId || channel.id),
          name: cleanDlhdChannelTitle(channel.channel_name || channel.channelName || channel.name || channel.title)
        }))
        .filter((channel) => channel.id && channel.name);
      if (!channels.length) return;
      events.push({
        title,
        normalizedTitle: normalizeTitle(title),
        category,
        time: toString(event.time),
        channels
      });
    };
    for (const day of Object.values(schedule)) {
      if (Array.isArray(day)) {
        day.forEach((event) => pushEvent(event));
        continue;
      }
      if (!day || typeof day !== 'object') continue;
      for (const [category, categoryEvents] of Object.entries(day)) {
        if (Array.isArray(categoryEvents)) {
          categoryEvents.forEach((event) => pushEvent(event, category));
        }
      }
    }
    return events;
  }

  async loadDlhdSchedule(signal = null) {
    if (this.dlhdScheduleCache?.expiresAt > Date.now()) {
      return this.dlhdScheduleCache.value;
    }
    if (this.dlhdScheduleInFlight) return this.dlhdScheduleInFlight;

    const shared = await this.readSharedCache('dlhd:schedule');
    const sharedEvents = Array.isArray(shared?.events) ? shared.events : (Array.isArray(shared) ? shared : []);
    if (sharedEvents.length) {
      this.dlhdScheduleCache = {
        value: sharedEvents,
        expiresAt: Date.now() + DLHD_SCHEDULE_CACHE_MS
      };
      void this.refreshDlhdSchedule().catch((error) => {
        this.logger.debug?.('dlhd schedule background refresh failed', {
          error: error?.message || String(error)
        });
      });
      return sharedEvents;
    }

    return this.refreshDlhdSchedule(signal);
  }

  async refreshDlhdSchedule(signal = null) {
    if (this.dlhdScheduleInFlight) return this.dlhdScheduleInFlight;
    const stale = this.dlhdScheduleCache?.value || [];
    const task = (async () => {
	    if (DLHD_API_KEY) {
	      const apiEvents = await this.loadDlhdApiSchedule(signal);
	      if (apiEvents.length) {
	        this.dlhdScheduleCache = {
	          value: apiEvents,
	          expiresAt: Date.now() + DLHD_SCHEDULE_CACHE_MS
	        };
	        await this.writeSharedCache('dlhd:schedule', {
	          fetchedAt: Date.now(),
	          events: apiEvents
	        }, DLHD_SCHEDULE_STALE_MS).catch(() => {});
	        return apiEvents;
	      }
	    }
	    let html = '';
	    let lastError = null;
	    for (const origin of DLHD_ORIGINS) {
	      try {
	        html = await this.fetchDlhdHtml(`${origin}/`, {
	          signal,
	          referer: `${origin}/`
	        });
	        if (html) break;
	      } catch (error) {
	        lastError = error;
	      }
	    }
	    if (!html) throw lastError || new Error('DLHD schedule unavailable');
	    const $ = loadHtml(html);
    const events = [];

    $('.schedule__event').each((_, element) => {
      const event = $(element);
      const dayLabel = toString(event.closest('.schedule__day').find('.schedule__dayTitle').first().text());
      const dayText = dayLabel
        .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/iu, '$1')
        .replace(/\s+-\s+.*$/u, '');
      const dayTimestamp = Date.parse(`${dayText} UTC`);
      if (Number.isFinite(dayTimestamp) && Math.abs(dayTimestamp - Date.now()) > 2 * 24 * 60 * 60 * 1000) {
        return;
      }
      const title = toString(event.find('.schedule__eventTitle').first().text());
      const time = toString(event.find('.schedule__time').first().attr('data-time') || event.find('.schedule__time').first().text());
      if (!title) return;

      const channels = [];
      event.find('.schedule__channels a[href*="watch.php?id="]').each((__, anchor) => {
        const href = toString($(anchor).attr('href'));
        const id = toString(href.match(/[?&]id=(\d+)/u)?.[1]);
        if (!id) return;
        channels.push({
          id,
          name: toString($(anchor).attr('title') || $(anchor).text()) || `Channel ${id}`
        });
      });
      if (!channels.length) return;

      events.push({
        title,
        normalizedTitle: normalizeTitle(title.replace(/\s+-\s+(?:multiview|tactical feed|backup.*)$/iu, '')),
        time,
        channels
      });
    });

    this.dlhdScheduleCache = {
      value: events,
      expiresAt: Date.now() + DLHD_SCHEDULE_CACHE_MS
    };
    await this.writeSharedCache('dlhd:schedule', {
      fetchedAt: Date.now(),
      events
    }, DLHD_SCHEDULE_STALE_MS).catch(() => {});
    return events;
    })()
      .catch((error) => {
        if (stale.length) return stale;
        throw error;
      })
      .finally(() => {
        this.dlhdScheduleInFlight = null;
      });
    this.dlhdScheduleInFlight = task;
    return task;
  }

  async loadDlhdChannels(catalog, signal = null) {
    if (this.dlhdChannelsCache?.expiresAt > Date.now()) {
      this.indexMatches(catalog, this.dlhdChannelsCache.value);
      return this.dlhdChannelsCache.value;
    }
    if (this.dlhdChannelsInFlight) return this.dlhdChannelsInFlight;

    const shared = await this.readSharedCache(`matches:${DLHD_CHANNEL_CACHE_KEY}`, { allowStale: true });
    const sharedChannels = Array.isArray(shared?.channels) ? shared.channels : (Array.isArray(shared) ? shared : []);
    const cdnSharedChannels = sharedChannels.filter((channel) =>
      normalizeIdPart(channel?.sourceId).startsWith('cdnlivetv-channel-')
        && (Array.isArray(channel?.sources) ? channel.sources : [])
          .some((source) => normalizeIdPart(source?.source) === CDNLIVETV_SOURCE)
    ).map((channel) => withLiveTvChannelGenres(channel));
    if (cdnSharedChannels.length) {
      this.dlhdChannelsCache = {
        value: cdnSharedChannels,
        expiresAt: Date.now() + DLHD_CHANNEL_CACHE_MS
      };
      this.indexMatches(catalog, cdnSharedChannels);
      void this.refreshDlhdChannels(catalog).catch((error) => {
        this.logger.debug?.('dlhd channels background refresh failed', {
          error: error?.message || String(error)
        });
      });
      return cdnSharedChannels;
    }

    return this.refreshDlhdChannels(catalog, signal);
  }

  async refreshDlhdChannels(catalog, signal = null) {
    if (this.dlhdChannelsInFlight) return this.dlhdChannelsInFlight;
    const stale = this.dlhdChannelsCache?.value || [];
    const task = (async () => {
	    const apiChannels = await this.loadDlhdApiChannels(signal);
	    if (apiChannels.length) {
	      const channels = apiChannels.sort((left, right) => {
	        const rankDelta = getLiveTvChannelRank(left) - getLiveTvChannelRank(right);
	        if (rankDelta !== 0) return rankDelta;
	        return toString(left.title).localeCompare(toString(right.title));
	      });
	      this.dlhdChannelsCache = {
	        value: channels,
	        expiresAt: Date.now() + DLHD_CHANNEL_CACHE_MS
	      };
	      this.indexMatches(catalog, channels);
	      await this.writeSharedCache(`matches:${DLHD_CHANNEL_CACHE_KEY}`, {
	        fetchedAt: Date.now(),
	        channels
	      }, DLHD_CHANNEL_STALE_MS).catch(() => {});
	      return channels;
	    }
	    throw new Error('CDNLiveTV channels empty');
    })()
      .catch((error) => {
        if (stale.length) return stale;
        throw error;
      })
      .finally(() => {
        this.dlhdChannelsInFlight = null;
      });
    this.dlhdChannelsInFlight = task;
    return task;
  }

  getDlhdEventMatchScore(match, event) {
    const eventTitle = normalizeTitle(event?.normalizedTitle || event?.title);
    if (!eventTitle) return 0;

    const teams = Array.isArray(match?.teams)
      ? match.teams.map(normalizeTeamName).filter(Boolean)
      : [];
    if (teams.length >= 2 && teams.every((team) => eventTitle.includes(team))) {
      return 100 + teams.reduce((score, team) => score + team.length, 0);
    }

    const matchTitle = normalizeTitle(match?.title)
      .replace(/\b(?:live|stream|streams|channel|tv)\b/gu, '')
      .trim();
    if (!matchTitle) return 0;
    if (eventTitle.includes(matchTitle) || matchTitle.includes(eventTitle)) return 80;

    const matchTokens = new Set(matchTitle.split(/\s+/u).filter((token) => token.length >= 3));
    const eventTokens = new Set(eventTitle.split(/\s+/u).filter((token) => token.length >= 3));
    if (!matchTokens.size || !eventTokens.size) return 0;
    const overlap = [...matchTokens].filter((token) => eventTokens.has(token)).length;
    return overlap >= 2 ? Math.round((overlap / Math.max(matchTokens.size, eventTokens.size)) * 60) : 0;
  }

  async getDlhdSourcesForMatch(match, signal = null) {
    const events = await this.loadDlhdSchedule(signal);
    const scored = events
      .map((event) => ({ event, score: this.getDlhdEventMatchScore(match, event) }))
      .filter((entry) => entry.score >= 40)
      .sort((left, right) => right.score - left.score);
    if (!scored.length) return [];

    const bestScore = scored[0].score;
    const seen = new Set();
    const sources = [];
    for (const { event, score } of scored) {
      if (score < bestScore - 10) break;
      for (const channel of event.channels) {
        if (seen.has(channel.id)) continue;
        seen.add(channel.id);
        sources.push({
          source: DLHD_SOURCE,
          id: channel.id,
          channelName: channel.name
        });
        if (sources.length >= STREAM_VALIDATION_MAX_PER_SOURCE) return sources;
      }
    }
    return sources;
  }

  getDlhdHlsCacheExpiry(url) {
    const maxExpiry = Date.now() + DLHD_HLS_MAX_CACHE_MS;
    try {
      const signedExpiry = Number(new URL(url).searchParams.get('expires')) * 1000;
      if (Number.isFinite(signedExpiry) && signedExpiry > 0) {
        return Math.min(maxExpiry, signedExpiry - DLHD_HLS_EXPIRY_MARGIN_MS);
      }
    } catch {
      // Use short maximum cache when source omits a readable expiry.
    }
    return maxExpiry;
  }

  async resolveDlhdChannel(channelId, signal = null) {
    const normalizedChannelId = toString(channelId);
    if (!/^\d+$/u.test(normalizedChannelId)) throw new Error('Invalid DLHD channel id');

    const cached = this.dlhdHlsCache.get(normalizedChannelId);
    if (cached?.expiresAt > Date.now() && cached.value?.url) return cached.value;
    if (cached) this.dlhdHlsCache.delete(normalizedChannelId);

    const sharedKey = `dlhd:hls:${normalizedChannelId}`;
    const shared = await this.readSharedCache(sharedKey);
    if (shared?.url && Number(shared.cacheExpiresAt || 0) > Date.now()) {
      const value = {
        url: shared.url,
        contextUrl: shared.contextUrl,
        headers: shared.headers
      };
      this.dlhdHlsCache.set(normalizedChannelId, {
        value,
        expiresAt: shared.cacheExpiresAt
      });
      return value;
    }
    if (this.dlhdHlsInFlight.has(normalizedChannelId)) {
      return this.dlhdHlsInFlight.get(normalizedChannelId);
    }

    const task = (async () => {
	    let outerUrl = '';
	    let playerUrl = '';
	    let encodedSource = '';
	    let lastError = null;
	    for (const origin of DLHD_ORIGINS) {
	      for (const folder of DLHD_PLAYER_FOLDERS) {
	        try {
	          outerUrl = `${origin}/${folder}/stream-${encodeURIComponent(normalizedChannelId)}.php`;
	          const outerHtml = await this.fetchDlhdHtml(outerUrl, {
	            signal,
	            referer: `${origin}/watch.php?id=${encodeURIComponent(normalizedChannelId)}`
	          });
	          playerUrl = outerHtml.match(/https?:\/\/[^'"\s<>]+\/premiumtv\/daddy3\.php\?id=\d+/iu)?.[0] || '';
	          if (!playerUrl) throw new Error('DLHD partner player not found');

	          const playerHtml = await this.fetchDlhdHtml(playerUrl, {
	            signal,
	            referer: outerUrl
	          });
	          encodedSource = playerHtml.match(/window\.atob\(\s*['"]([^'"]+)['"]\s*\)/iu)?.[1] || '';
	          if (!encodedSource) throw new Error('DLHD HLS source not found');
	          break;
	        } catch (error) {
	          lastError = error;
	          outerUrl = '';
	          playerUrl = '';
	          encodedSource = '';
	        }
	      }
	      if (encodedSource) break;
	    }
	    if (!encodedSource) throw lastError || new Error('DLHD HLS source not found');

    const url = Buffer.from(encodedSource, 'base64').toString('utf8').trim();
    if (!isHttpUrl(url) || !/\.m3u8(?:$|[?#])/iu.test(url)) {
      throw new Error('DLHD HLS source invalid');
    }
    const value = {
      url,
      contextUrl: playerUrl,
      headers: this.getBrowserFetchHeaders()
    };
    const cacheExpiresAt = this.getDlhdHlsCacheExpiry(url);
    const ttlMs = cacheExpiresAt - Date.now();
    if (ttlMs > 0) {
      this.dlhdHlsCache.set(normalizedChannelId, {
        value,
        expiresAt: cacheExpiresAt
      });
      await this.writeSharedCache(sharedKey, {
        ...value,
        cacheExpiresAt
      }, ttlMs).catch(() => {});
    }
    return value;
    })().finally(() => {
      this.dlhdHlsInFlight.delete(normalizedChannelId);
    });
    this.dlhdHlsInFlight.set(normalizedChannelId, task);
    return task;
  }

  shouldMergeStreamFreeIntoCatalog(catalog = {}) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return false;
    const catalogId = toString(catalog?.id);
    const endpoint = toString(catalog?.endpoint);
    return [
      'streamed-events-live',
      'streamed-events-today',
      'streamed-events-popular',
      'streamed-events-cricket',
      'streamed-events-tennis',
      'streamed-events-motor-sports',
      'streamed-events-racing'
    ].includes(catalogId) || [
      '/api/matches/live',
      '/api/matches/all-today',
      '/api/matches/all-today/popular',
      '/api/matches/cricket',
      '/api/matches/tennis',
      '/api/matches/motor-sports',
      '/api/matches/racing'
    ].includes(endpoint);
  }

  shouldMergeSportsBiteIntoCatalog(catalog = {}) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return false;
    const catalogId = toString(catalog?.id);
    const endpoint = toString(catalog?.endpoint);
    return [
      'streamed-events-live',
      'streamed-events-today',
      'streamed-events-popular',
      'streamed-events-football',
      FIFA_WC_CATALOG_ID
    ].includes(catalogId) || [
      '/api/matches/live',
      '/api/matches/all-today',
      '/api/matches/all-today/popular',
      '/api/matches/football',
      FIFA_WC_CACHE_KEY
    ].includes(endpoint);
  }

  shouldMergeFlixDlstreamsIntoCatalog(catalog = {}) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return false;
    const catalogId = toString(catalog?.id);
    const endpoint = toString(catalog?.endpoint);
    return [
      'streamed-events-live',
      'streamed-events-today',
      'streamed-events-popular',
      'streamed-events-football',
      FIFA_WC_CATALOG_ID
    ].includes(catalogId) || [
      '/api/matches/live',
      '/api/matches/all-today',
      '/api/matches/all-today/popular',
      '/api/matches/football',
      FIFA_WC_CACHE_KEY
    ].includes(endpoint);
  }

  shouldMergeCdnLiveTvIntoCatalog(catalog = {}) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return false;
    const catalogId = toString(catalog?.id);
    const endpoint = toString(catalog?.endpoint);
    return [
      'streamed-events-live',
      'streamed-events-today',
      'streamed-events-popular',
      'streamed-events-football',
      'streamed-events-cricket',
      'streamed-events-tennis',
      'streamed-events-basketball',
      'streamed-events-baseball',
      'streamed-events-ice-hockey',
      'streamed-events-rugby',
      'streamed-events-motor-sports',
      'streamed-events-racing',
      FIFA_WC_CATALOG_ID
    ].includes(catalogId) || [
      '/api/matches/live',
      '/api/matches/all-today',
      '/api/matches/all-today/popular',
      '/api/matches/football',
      '/api/matches/cricket',
      '/api/matches/tennis',
      '/api/matches/basketball',
      '/api/matches/baseball',
      '/api/matches/ice-hockey',
      '/api/matches/rugby',
      '/api/matches/motor-sports',
      '/api/matches/racing',
      FIFA_WC_CACHE_KEY
    ].includes(endpoint);
  }

  getCatalogSportFilter(catalog = {}) {
    const catalogId = toString(catalog?.id);
    const endpoint = toString(catalog?.endpoint);
    const isInternalSourceCatalog = catalogId.endsWith('-source');
    const coreCatalogs = new Set([
      'streamed-events-live',
      'streamed-events-today',
      'streamed-events-popular',
      CDNLIVETV_CATALOG_ID,
      DLHD_CHANNEL_CATALOG_ID,
      FIFA_WC_CATALOG_ID
    ]);
    if (!isInternalSourceCatalog && catalogId.startsWith('streamed-events-') && !coreCatalogs.has(catalogId)) {
      return normalizeIdPart(catalogId.replace(/^streamed-events-/u, ''));
    }
    const endpointMatch = endpoint.match(/^\/api\/matches\/([^/]+)$/u);
    if (endpointMatch && !['live', 'all-today', 'popular'].includes(endpointMatch[1])) {
      return normalizeIdPart(decodeURIComponent(endpointMatch[1]));
    }
    return '';
  }

  matchBelongsToCatalogSport(match = {}, sport = '') {
    const normalizedSport = normalizeIdPart(sport);
    if (!normalizedSport) return true;
    const category = normalizeIdPart(match?.category);
    if (category === normalizedSport) return true;
    const text = normalizeTitle([
      match?.title,
      match?.category,
      match?.normalizedTitle,
      ...(Array.isArray(match?.teams) ? match.teams : [])
    ].filter(Boolean).join(' '));
    const aliases = new Map([
      ['football', ['football', 'soccer', 'fifa']],
      ['cricket', ['cricket']],
      ['tennis', ['tennis', 'atp', 'wta']],
      ['basketball', ['basketball', 'nba']],
      ['baseball', ['baseball', 'mlb']],
      ['ice-hockey', ['ice hockey', 'hockey', 'nhl']],
      ['rugby', ['rugby']],
      ['motor-sports', ['motor sports', 'motorsport', 'formula', 'f1', 'moto gp', 'motogp', 'nascar']],
      ['racing', ['racing', 'race', 'formula', 'f1', 'moto gp', 'motogp', 'nascar']]
    ]);
    const needles = aliases.get(normalizedSport) || [normalizedSport.replace(/-/gu, ' ')];
    return needles.some((needle) => text.includes(normalizeTitle(needle)));
  }

  filterMatchesForCatalogSport(catalog = {}, matches = []) {
    const sport = this.getCatalogSportFilter(catalog);
    if (!sport) return matches;
    return matches.filter((match) => this.matchBelongsToCatalogSport(match, sport));
  }

  async getSports(signal = null) {
    if (this.sportsCache && this.sportsCache.expiresAt > Date.now()) {
      return this.sportsCache.value;
    }

    const shared = await this.readSharedCache('sports');
    if (Array.isArray(shared)) {
      this.sportsCache = {
        value: shared,
        expiresAt: Date.now() + CACHE_TTL_MS
      };
      return shared;
    }

    try {
      const payload = await this.fetchJson('/api/sports', signal);
      const sports = (Array.isArray(payload) ? payload : [])
        .map((sport) => ({
          id: normalizeIdPart(sport?.id),
          name: toString(sport?.name)
        }))
        .filter((sport) => sport.id && sport.name);
      this.sportsCache = {
        value: sports,
        expiresAt: Date.now() + CACHE_TTL_MS
      };
      await this.writeSharedCache('sports', sports, CACHE_TTL_MS).catch(() => {});
      return sports;
    } catch (error) {
      this.logger.warn?.('streamed sports load failed', { error: error?.message || String(error) });
      return this.sportsCache?.value || [];
    }
  }

  getEventCatalogDefinitions(sports = []) {
    const definitions = [
      { type: STREMIO_SPORTS_TYPE, id: 'streamed-events-live', endpoint: '/api/matches/live', name: 'Sports Events: Live' },
      { type: STREMIO_SPORTS_TYPE, id: FIFA_WC_CATALOG_ID, endpoint: FIFA_WC_CACHE_KEY, name: 'Sports Events: FIFA WC', fifaWorldCup: true },
      { type: STREMIO_SPORTS_TYPE, id: 'streamed-events-today', endpoint: '/api/matches/all-today', name: 'Sports Events: Today' },
      { type: STREMIO_SPORTS_TYPE, id: 'streamed-events-popular', endpoint: '/api/matches/all-today/popular', name: 'Sports Events: Popular' },
      { type: STREMIO_SPORTS_TYPE, id: CDNLIVETV_CATALOG_ID, endpoint: CDNLIVETV_CACHE_KEY, name: 'Sports Events: Live TV' },
      { type: STREMIO_SPORTS_TYPE, id: DLHD_CHANNEL_CATALOG_ID, endpoint: DLHD_CHANNEL_CACHE_KEY, name: 'Live TV' },
      { type: STREMIO_SPORTS_TYPE, id: REPLAYZONE_CATALOG_ID, endpoint: REPLAYZONE_CACHE_KEY, name: 'Sports Replays' }
    ];

    for (const sport of sports.slice(0, 15)) {
      definitions.push({
        type: STREMIO_SPORTS_TYPE,
        id: `streamed-events-${sport.id}`,
        endpoint: `/api/matches/${encodeURIComponent(sport.id)}`,
        name: `Sports Events: ${sport.name}`
      });
    }

    return definitions;
  }

  async getCatalogDefinition(catalogId, signal = null) {
    const sports = await this.getSports(signal);
    return this.getEventCatalogDefinitions(sports)
      .find((definition) => definition.id === catalogId) || null;
  }

	  async loadMatches(catalog, signal = null) {
	    const endpoint = toString(catalog?.endpoint);
	    if (!endpoint) return [];
	    const liveEndpoint = endpoint === '/api/matches/live';
    if (catalog?.id === SPORTSBITE_CATALOG_ID || endpoint === SPORTSBITE_CACHE_KEY) {
      if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return [];
      return this.loadSportsBiteMatches(catalog, signal);
    }
    if (catalog?.id === STREAMFREE_CATALOG_ID || endpoint === STREAMFREE_CACHE_KEY) {
      if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return [];
      return this.loadStreamFreeMatches(catalog, signal);
    }
    if (catalog?.id === FLIX_DLSTREAMS_CATALOG_ID || endpoint === FLIX_DLSTREAMS_CACHE_KEY) {
      if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return [];
      return this.loadFlixDlstreamsMatches(catalog, signal);
    }
    if (catalog?.id === CDNLIVETV_CATALOG_ID || endpoint === CDNLIVETV_CACHE_KEY) {
      if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return [];
      return this.loadCdnLiveTvMatches(catalog, signal);
    }
    if (catalog?.id === DLHD_CHANNEL_CATALOG_ID || endpoint === DLHD_CHANNEL_CACHE_KEY) {
      return this.loadDlhdChannels(catalog, signal);
    }
    if (catalog?.id === REPLAYZONE_CATALOG_ID || endpoint === REPLAYZONE_CACHE_KEY) {
      return this.loadReplayZoneMatches(catalog, signal);
    }
    if (catalog?.fifaWorldCup || catalog?.id === FIFA_WC_CATALOG_ID || endpoint === FIFA_WC_CACHE_KEY) {
      return this.loadFifaWorldCupMatches(catalog, signal);
    }

    const cached = this.matchesCache.get(endpoint);
	    if (cached && cached.expiresAt > Date.now()) {
	      const matches = this.mergeMatches(cached.value);
	      const filteredMatches = this.filterMatchesForCatalogSport(catalog, matches);
	      this.indexMatches(catalog, filteredMatches);
	      return filteredMatches;
	    }

	    const shared = liveEndpoint ? null : await this.readSharedCache(`matches:${endpoint}`);
    if (Array.isArray(shared)) {
      let matches = this.filterSupplementalMatches(this.mergeMatches(this.stripSupplementalSourcesFromMatches(shared)));
      if (this.shouldMergeSportsBiteIntoCatalog(catalog)) {
        const sportsBiteMatches = await this.loadSportsBiteMatches({
          id: SPORTSBITE_CATALOG_ID,
          endpoint: SPORTSBITE_CACHE_KEY
        }, signal).catch(() => []);
        matches = this.filterSupplementalMatches(this.mergeMatches([...matches, ...sportsBiteMatches]));
      }
      if (this.shouldMergeStreamFreeIntoCatalog(catalog)) {
        const streamFreeMatches = await this.loadStreamFreeMatches({
          id: STREAMFREE_CATALOG_ID,
          endpoint: STREAMFREE_CACHE_KEY
        }, signal).catch(() => []);
        matches = this.filterSupplementalMatches(this.mergeMatches([...matches, ...streamFreeMatches]));
      }
      if (this.shouldMergeFlixDlstreamsIntoCatalog(catalog)) {
        const flixMatches = await this.loadFlixDlstreamsMatches({
          id: FLIX_DLSTREAMS_CATALOG_ID,
          endpoint: FLIX_DLSTREAMS_CACHE_KEY
        }, signal).catch(() => []);
        matches = this.filterSupplementalMatches(this.mergeMatches([...matches, ...flixMatches]));
      }
      if (this.shouldMergeCdnLiveTvIntoCatalog(catalog)) {
        const cdnLiveTvMatches = await this.loadCdnLiveTvMatches({
          id: CDNLIVETV_CATALOG_ID,
          endpoint: CDNLIVETV_CACHE_KEY
        }, signal).catch(() => []);
        matches = this.filterSupplementalMatches(this.mergeMatches([...matches, ...cdnLiveTvMatches]));
      }
	      this.matchesCache.set(endpoint, {
	        value: matches,
	        expiresAt: Date.now() + (liveEndpoint ? LIVE_MATCH_CACHE_TTL_MS : CACHE_TTL_MS)
	      });
      const filteredMatches = this.filterMatchesForCatalogSport(catalog, matches);
      this.indexMatches(catalog, filteredMatches);
      return filteredMatches;
    }

    try {
	      const payload = await this.fetchJson(endpoint, signal);
	      const baseMatches = (Array.isArray(payload) ? payload : [])
	        .map((entry) => this.toMatch(entry, { liveEndpoint }))
	        .filter((match) => match.id && match.title);
      if (!liveEndpoint) {
        await this.writeSharedCache(`matches:${endpoint}`, baseMatches, CACHE_TTL_MS).catch(() => {});
      }
      let matches = baseMatches;
      matches = this.filterSupplementalMatches(matches);
      if (this.shouldMergeSportsBiteIntoCatalog(catalog)) {
        const sportsBiteMatches = await this.loadSportsBiteMatches({
          id: SPORTSBITE_CATALOG_ID,
          endpoint: SPORTSBITE_CACHE_KEY
        }, signal).catch(() => []);
        matches = this.filterSupplementalMatches(this.mergeMatches([...matches, ...sportsBiteMatches]));
      }
      if (this.shouldMergeStreamFreeIntoCatalog(catalog)) {
        const streamFreeMatches = await this.loadStreamFreeMatches({
          id: STREAMFREE_CATALOG_ID,
          endpoint: STREAMFREE_CACHE_KEY
        }, signal).catch(() => []);
        matches = this.filterSupplementalMatches(this.mergeMatches([...matches, ...streamFreeMatches]));
      }
      if (this.shouldMergeFlixDlstreamsIntoCatalog(catalog)) {
        const flixMatches = await this.loadFlixDlstreamsMatches({
          id: FLIX_DLSTREAMS_CATALOG_ID,
          endpoint: FLIX_DLSTREAMS_CACHE_KEY
        }, signal).catch(() => []);
        matches = this.filterSupplementalMatches(this.mergeMatches([...matches, ...flixMatches]));
      }
      if (this.shouldMergeCdnLiveTvIntoCatalog(catalog)) {
        const cdnLiveTvMatches = await this.loadCdnLiveTvMatches({
          id: CDNLIVETV_CATALOG_ID,
          endpoint: CDNLIVETV_CACHE_KEY
        }, signal).catch(() => []);
        matches = this.filterSupplementalMatches(this.mergeMatches([...matches, ...cdnLiveTvMatches]));
      }
	      this.matchesCache.set(endpoint, {
	        value: matches,
	        expiresAt: Date.now() + (liveEndpoint ? LIVE_MATCH_CACHE_TTL_MS : CACHE_TTL_MS)
	      });
	      const filteredMatches = this.filterMatchesForCatalogSport(catalog, matches);
	      this.indexMatches(catalog, filteredMatches);
      return filteredMatches;
    } catch (error) {
      this.logger.warn?.('streamed matches load failed', {
        catalog: catalog?.id,
        error: error?.message || String(error)
      });
      const fallback = this.filterSupplementalMatches(cached?.value || []);
      this.indexMatches(catalog, fallback);
      return fallback;
    }
  }

  async loadSportsBiteMatches(catalog, signal = null) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return [];
    const cached = this.matchesCache.get(SPORTSBITE_CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) {
      this.indexMatches(catalog, cached.value);
      return cached.value;
    }

    const shared = await this.readSharedCache(`matches:${SPORTSBITE_CACHE_KEY}`);
    if (Array.isArray(shared)) {
      this.matchesCache.set(SPORTSBITE_CACHE_KEY, {
        value: shared,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, shared);
      return shared;
    }

    try {
      const response = await this.fetchImpl(SPORTSBITE_STREAMS_URL, {
        signal,
        headers: this.getSportsBiteHeaders()
      });
      if (!response.ok) throw new Error(`SportsBite HTTP ${response.status}`);
      const payload = await response.json();
      const entries = Array.isArray(payload?.streams) ? payload.streams : [];
      const matches = entries
        .map((entry) => this.toSportsBiteMatch(entry))
        .filter((match) => match?.id && match.title && match.sportsBiteStreams?.length);
      this.matchesCache.set(SPORTSBITE_CACHE_KEY, {
        value: matches,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, matches);
      await this.writeSharedCache(`matches:${SPORTSBITE_CACHE_KEY}`, matches, CACHE_TTL_MS).catch(() => {});
      return matches;
    } catch (error) {
      this.logger.warn?.('sportsbite matches load failed', { error: error?.message || String(error) });
      const fallback = cached?.value || [];
      this.indexMatches(catalog, fallback);
      return fallback;
    }
  }

  mergeMatches(matches = []) {
    const bySourceId = new Map();
    const byEventKey = new Map();
    const ordered = [];
    const supplementalSources = new Set([SPORTSBITE_SOURCE, STREAMFREE_SOURCE, FLIX_DLSTREAMS_SOURCE, CDNLIVETV_SOURCE]);
    const sortedMatches = matches.slice().sort((left, right) => {
      const leftSupplemental = left?.sources?.every((source) => supplementalSources.has(normalizeIdPart(source?.source)));
      const rightSupplemental = right?.sources?.every((source) => supplementalSources.has(normalizeIdPart(source?.source)));
      return Number(leftSupplemental) - Number(rightSupplemental);
    });

    for (const match of sortedMatches) {
      if (!match?.sourceId) continue;
      const eventKey = getMatchEventKey(match);
      const existing = bySourceId.get(match.sourceId) || byEventKey.get(eventKey);
      if (!existing) {
        const value = {
          ...match,
          sources: Array.isArray(match.sources) ? [...match.sources] : [],
          sportsBiteStreams: Array.isArray(match.sportsBiteStreams) ? [...match.sportsBiteStreams] : undefined
        };
        ordered.push(value);
        bySourceId.set(value.sourceId, value);
        if (eventKey) byEventKey.set(eventKey, value);
        continue;
      }

      const sourceKeys = new Set(existing.sources.map((source) =>
        `${normalizeIdPart(source?.source)}:${toString(source?.id)}`
      ));
      for (const source of Array.isArray(match.sources) ? match.sources : []) {
        const sourceKey = `${normalizeIdPart(source?.source)}:${toString(source?.id)}`;
        if (normalizeIdPart(source?.source) === FLIX_DLSTREAMS_SOURCE
          && existing.sources.some((entry) => normalizeIdPart(entry?.source) === FLIX_DLSTREAMS_SOURCE)) {
          continue;
        }
        if (!sourceKeys.has(sourceKey)) {
          existing.sources.push(source);
          sourceKeys.add(sourceKey);
        }
      }
      const sportsBiteKeys = new Set((existing.sportsBiteStreams || []).map((stream) =>
        `${toString(stream?.id)}:${Number(stream?.streamNo || 1)}`
      ));
      for (const stream of Array.isArray(match.sportsBiteStreams) ? match.sportsBiteStreams : []) {
        const streamKey = `${toString(stream?.id)}:${Number(stream?.streamNo || 1)}`;
        if (!sportsBiteKeys.has(streamKey)) {
          existing.sportsBiteStreams = [...(existing.sportsBiteStreams || []), stream];
          sportsBiteKeys.add(streamKey);
        }
	      }
	      existing.popular = Boolean(existing.popular || match.popular);
	      existing.isLive = Boolean(existing.isLive || match.isLive || isCurrentlyLiveMatch(match));
	      bySourceId.set(match.sourceId, existing);
    }
    return ordered.map((match) => {
      let hasFlixSource = false;
      const sources = (Array.isArray(match.sources) ? match.sources : []).filter((source) => {
        if (normalizeIdPart(source?.source) !== FLIX_DLSTREAMS_SOURCE) return true;
        if (hasFlixSource) return false;
        hasFlixSource = true;
        return true;
      });
      return { ...match, sources };
    });
  }

  filterSupplementalMatches(matches = []) {
    if (SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return matches;
    return (Array.isArray(matches) ? matches : [])
      .map((match) => {
        const sources = (Array.isArray(match?.sources) ? match.sources : [])
          .filter((source) => !isSupplementalSportsSource(source?.source));
        if (!sources.length) return null;
        return {
          ...match,
          sources,
          sportsBiteStreams: undefined
        };
      })
      .filter(Boolean);
  }

  stripSupplementalSourcesFromMatches(matches = []) {
    return (Array.isArray(matches) ? matches : [])
      .map((match) => {
        const originalSources = Array.isArray(match?.sources) ? match.sources : [];
        const sources = originalSources
          .filter((source) => !isSupplementalSportsSource(source?.source));
        if (originalSources.length && !sources.length) return null;
        return {
          ...match,
          sources,
          sportsBiteStreams: undefined
        };
      })
      .filter(Boolean);
  }

  async loadFlixDlstreamsMatches(catalog, signal = null) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return [];
    const cached = this.matchesCache.get(FLIX_DLSTREAMS_CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) {
      const matches = this.filterFlixDlstreamsMatches(cached.value);
      this.indexMatches(catalog, matches);
      return matches;
    }

    const shared = await this.readSharedCache(`matches:${FLIX_DLSTREAMS_CACHE_KEY}`);
    if (Array.isArray(shared)) {
      const matches = this.filterFlixDlstreamsMatches(shared);
      this.matchesCache.set(FLIX_DLSTREAMS_CACHE_KEY, {
        value: matches,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, matches);
      return matches;
    }

    try {
      const metas = await this.loadFlixDlstreamsCatalogMetas(signal);
      const seenMetaIds = new Set();
      const matches = metas
        .filter((meta) => {
          const id = toString(meta?.id);
          if (!id || seenMetaIds.has(id)) return false;
          seenMetaIds.add(id);
          return true;
        })
        .map((meta) => this.toFlixDlstreamsMatch(meta))
        .filter((match) => match?.id && match.title && normalizeIdPart(match.category) !== 'tv-shows');
      this.matchesCache.set(FLIX_DLSTREAMS_CACHE_KEY, {
        value: matches,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, matches);
      await this.writeSharedCache(`matches:${FLIX_DLSTREAMS_CACHE_KEY}`, matches, CACHE_TTL_MS).catch(() => {});
      return matches;
    } catch (error) {
      this.logger.warn?.('NebulaSP matches load failed', { error: error?.message || String(error) });
      const fallback = this.filterFlixDlstreamsMatches(cached?.value || []);
      this.indexMatches(catalog, fallback);
      return fallback;
    }
  }

  encodeCdnLiveTvSourceId(channel = {}) {
    const payload = {
      id: toString(channel?.id),
      name: toString(channel?.channel_name || channel?.name),
      code: toString(channel?.channel_code || channel?.code),
      url: toString(channel?.url),
      image: toString(channel?.image),
      viewers: Number(channel?.viewers || 0)
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  decodeCdnLiveTvSourceId(sourceId) {
    try {
      const parsed = JSON.parse(Buffer.from(toString(sourceId), 'base64url').toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async loadCdnLiveTvMatches(catalog, signal = null) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return [];
    const cached = this.matchesCache.get(CDNLIVETV_CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) {
      this.indexMatches(catalog, cached.value);
      return cached.value;
    }

    const shared = await this.readSharedCache(`matches:${CDNLIVETV_CACHE_KEY}`);
    if (Array.isArray(shared)) {
      this.matchesCache.set(CDNLIVETV_CACHE_KEY, {
        value: shared,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, shared);
      return shared;
    }

    try {
      const payload = await this.fetchCdnLiveTvJson('/api/v1/events/sports/', signal);
      const root = payload?.['cdn-live-tv'] && typeof payload['cdn-live-tv'] === 'object'
        ? payload['cdn-live-tv']
        : payload;
      const entries = Object.entries(root && typeof root === 'object' ? root : {})
        .flatMap(([category, events]) => (Array.isArray(events) ? events.map((entry) => ({ category, entry })) : []));
      const matches = entries
        .map(({ category, entry }) => this.toCdnLiveTvMatch(entry, category))
        .filter((match) => match?.id && match.title && match.sources?.length);
      this.matchesCache.set(CDNLIVETV_CACHE_KEY, {
        value: matches,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, matches);
      await this.writeSharedCache(`matches:${CDNLIVETV_CACHE_KEY}`, matches, CACHE_TTL_MS).catch(() => {});
      return matches;
    } catch (error) {
      this.logger.warn?.('CDNLiveTV matches load failed', { error: error?.message || String(error) });
      const fallback = cached?.value || [];
      this.indexMatches(catalog, fallback);
      return fallback;
    }
  }

  toCdnLiveTvMatch(entry, categoryName = 'sports') {
    const title = toString(entry?.event) || [toString(entry?.homeTeam), toString(entry?.awayTeam)].filter(Boolean).join(' vs ');
    if (!title) return null;
    const channels = [...(Array.isArray(entry?.channels) ? entry.channels : []), ...(Array.isArray(entry?.channels2) ? entry.channels2 : [])]
      .filter((channel) => toString(channel?.url) || toString(channel?.channel_name || channel?.name));
    if (!channels.length) return null;
    const start = toString(entry?.start);
    const date = Number.isFinite(Date.parse(start)) ? Date.parse(start) : Date.now();
    const sourceId = `cdnlivetv-${normalizeIdPart(`${entry?.gameID || ''}-${title}-${start}`)}`;
    const category = normalizeIdPart(categoryName || entry?.category || 'sports');
    const home = toString(entry?.homeTeam);
    const away = toString(entry?.awayTeam);
    const tournament = toString(entry?.tournament);
    const country = toString(entry?.country);
    const sources = channels
      .map((channel) => ({
        source: CDNLIVETV_SOURCE,
        id: this.encodeCdnLiveTvSourceId(channel)
      }))
      .filter((source) => source.id);
    const teams = [home, away].filter(Boolean);
    const liveCandidate = { title, category, date, teams };
    return {
      id: `streamed:${encodeURIComponent(sourceId)}`,
      sourceId,
      type: STREMIO_SPORTS_TYPE,
      title,
      category,
      date,
	      poster: null,
	      posterShape: 'poster',
	      popular: normalizeIdPart(entry?.status) === 'live' || Date.now() >= date,
	      isLive: isCurrentlyLiveMatch({ ...liveCandidate, isLive: normalizeIdPart(entry?.status) === 'live' }),
	      sources,
      teams,
      normalizedTitle: normalizeTitle(`${title} ${category} ${home} ${away} ${tournament} ${country} cdnlivetv`)
    };
  }

  filterFlixDlstreamsMatches(matches = []) {
    return (Array.isArray(matches) ? matches : [])
      .filter((match) => isLikelyFlixDlstreamsSportsEvent({
        title: match?.title,
        category: match?.category,
        description: match?.description || match?.normalizedTitle
      }))
      .map((match) => ({
        ...match,
        poster: null,
        posterShape: match?.posterShape || 'poster'
      }));
  }

  async loadStreamFreeMatches(catalog, signal = null) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return [];
    const cached = this.matchesCache.get(STREAMFREE_CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) {
      this.indexMatches(catalog, cached.value);
      return cached.value;
    }

    const matches = STREAMFREE_CHANNELS.map((channel) => this.toStreamFreeMatch(channel));
    this.matchesCache.set(STREAMFREE_CACHE_KEY, {
      value: matches,
      expiresAt: Date.now() + CACHE_TTL_MS
    });
    this.indexMatches(catalog, matches);
    await this.writeSharedCache(`matches:${STREAMFREE_CACHE_KEY}`, matches, CACHE_TTL_MS).catch(() => {});
    return matches;
  }

  toReplayZoneMatch(entry = {}) {
    const title = toString(entry.title);
    if (!title || !Array.isArray(entry.embeds) || !entry.embeds.length) return null;
    const date = Number.isFinite(Date.parse(entry.date)) ? Date.parse(entry.date) : 0;
    const hash = createHash('sha1')
      .update(`${title}\n${entry.category}\n${entry.sub}\n${entry.date}`)
      .digest('hex')
      .slice(0, 16);
    const sourceId = `replay:${hash}`;
    const category = toString(entry.category) || 'Sports Replays';
    const sub = toString(entry.sub);
    return {
      id: `streamed:${encodeURIComponent(sourceId)}`,
      sourceId,
      type: STREMIO_SPORTS_TYPE,
      title,
      category,
      replay: true,
      replaySubcategory: sub,
      date,
      poster: isHttpUrl(entry.thumb) ? entry.thumb : null,
      posterShape: 'landscape',
      popular: false,
      isLive: false,
      sources: entry.embeds
        .map((embed, index) => ({
          source: REPLAYZONE_SOURCE,
          id: `${hash}:${index + 1}`,
          streamNo: index + 1,
          label: toString(embed.label) || `Replay ${index + 1}`,
          embedType: toString(embed.type),
          embedUrl: toString(embed.url)
        }))
        .filter((source) => isHttpUrl(source.embedUrl)),
      teams: splitFixtureTeams(title),
      normalizedTitle: normalizeTitle(`${title} ${category} ${sub} replay full match`)
    };
  }

  parseReplayZoneFeed(text = '') {
    const entries = [];
    let current = null;
    for (const rawLine of toString(text).split(/\r?\n/u)) {
      const line = rawLine.trimEnd();
      if (line.startsWith('# ')) {
        current = {
          title: line.slice(2).trim(),
          category: '',
          sub: '',
          thumb: '',
          date: '',
          embeds: []
        };
        entries.push(current);
        continue;
      }
      if (!current) continue;
      if (line.startsWith('~ ')) {
        const [category, sub, thumb, date] = line.slice(2).split('\t');
        current.category = toString(category).trim();
        current.sub = toString(sub).trim();
        current.thumb = toString(thumb).trim();
        current.date = toString(date).trim();
        continue;
      }
      if (line.trim()) {
        const [label, type, url] = line.split('\t');
        if (url) {
          current.embeds.push({
            label: toString(label).trim(),
            type: toString(type).trim(),
            url: toString(url).trim()
          });
        }
      }
    }
    return entries;
  }

  async loadReplayZoneMatches(catalog, signal = null) {
    if (this.replayZoneMatchesCache?.expiresAt > Date.now()) {
      this.indexMatches(catalog, this.replayZoneMatchesCache.value);
      return this.replayZoneMatchesCache.value;
    }
    const shared = await this.readSharedCache(`matches:${REPLAYZONE_CACHE_KEY}`);
    if (Array.isArray(shared)) {
      this.replayZoneMatchesCache = {
        value: shared,
        expiresAt: Date.now() + REPLAYZONE_MATCH_CACHE_MS
      };
      this.indexMatches(catalog, shared);
      return shared;
    }
    try {
      const response = await this.fetchImpl(REPLAYZONE_FEED_URL, {
        signal,
        headers: {
          accept: 'text/plain,*/*',
          'user-agent': BROWSER_USER_AGENT
        }
      });
      if (!response.ok) throw new Error(`ReplayZone HTTP ${response.status}`);
      const text = await response.text();
      const matches = this.parseReplayZoneFeed(text)
        .map((entry) => this.toReplayZoneMatch(entry))
        .filter((match) => match?.id && match.sources?.length)
        .sort((left, right) => Number(right.date || 0) - Number(left.date || 0));
      this.replayZoneMatchesCache = {
        value: matches,
        expiresAt: Date.now() + REPLAYZONE_MATCH_CACHE_MS
      };
      this.indexMatches(catalog, matches);
      await this.writeSharedCache(`matches:${REPLAYZONE_CACHE_KEY}`, matches, REPLAYZONE_MATCH_CACHE_MS).catch(() => {});
      return matches;
    } catch (error) {
      this.logger.warn?.('ReplayZone matches load failed', { error: error?.message || String(error) });
      const fallback = this.replayZoneMatchesCache?.value || [];
      this.indexMatches(catalog, fallback);
      return fallback;
    }
  }

  async loadFifaWorldCupMatches(catalog, signal = null) {
    const cached = this.matchesCache.get(FIFA_WC_CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) {
      this.indexMatches(catalog, cached.value);
      return cached.value;
    }

    const sourceCatalogs = [
      { id: 'streamed-events-football-source', endpoint: '/api/matches/football' },
      { id: 'streamed-events-today-source', endpoint: '/api/matches/all-today' },
      { id: 'streamed-events-popular-source', endpoint: '/api/matches/all-today/popular' },
      { id: 'streamed-events-live-source', endpoint: '/api/matches/live' }
    ];
    const settled = await Promise.allSettled(sourceCatalogs.map((sourceCatalog) => this.loadMatches(sourceCatalog, signal)));
    const bySourceId = new Map();
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const match of result.value) {
        if (isFifaWorldCupMatch(match)) bySourceId.set(match.sourceId, match);
      }
    }

    const matches = [...bySourceId.values()].sort((left, right) => Number(left.date || 0) - Number(right.date || 0));
    this.matchesCache.set(FIFA_WC_CACHE_KEY, {
      value: matches,
      expiresAt: Date.now() + CACHE_TTL_MS
    });
    this.indexMatches(catalog, matches);
    return matches;
  }

  indexMatches(catalog, matches = []) {
    const catalogId = toString(catalog?.id);
    if (catalogId) this.catalogMatchIndex.set(catalogId, Date.now());
    for (const match of Array.isArray(matches) ? matches : []) {
      if (!match?.sourceId) continue;
      this.matchIndex.set(match.sourceId, match);
      this.matchIndex.set(match.id, match);
      if (Array.isArray(match.sportsBiteStreams) && match.sportsBiteStreams.length) {
        this.sportsBiteSourceStreams.set(match.sourceId, match.sportsBiteStreams);
        for (const source of Array.isArray(match.sources) ? match.sources : []) {
          if (normalizeIdPart(source?.source) === SPORTSBITE_SOURCE && source?.id) {
            this.sportsBiteSourceStreams.set(toString(source.id), match.sportsBiteStreams);
          }
        }
      }
    }
    if (this.matchIndex.size > 5000) {
      this.matchIndex = new Map([...this.matchIndex.entries()].slice(-3500));
    }
  }

  prewarmCatalogs(catalogs = []) {
    for (const catalog of catalogs.slice(0, 6)) {
      const endpoint = toString(catalog?.endpoint);
      if (!endpoint || endpoint === DLHD_CHANNEL_CACHE_KEY || this.matchesCache.has(endpoint)) continue;
      this.loadMatches(catalog).catch((error) => {
        this.logger.warn?.('streamed catalog prewarm failed', {
          catalog: catalog?.id,
          error: error?.message || String(error)
        });
      });
    }
  }

  async prewarmLiveEventStreams({ baseUrl = '', privateConfigId = '', limit = LIVE_STREAM_PREWARM_LIMIT, signal = null } = {}) {
    if (!baseUrl || !privateConfigId || this.liveStreamPrewarmInFlight) {
      return { attempted: 0, warmed: 0, skipped: true };
    }

    const task = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Streamed sports live prewarm timeout')), LIVE_STREAM_PREWARM_TIMEOUT_MS);
      timeout.unref?.();
      const prewarmSignal = signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      let attempted = 0;
      let warmed = 0;
      try {
        const liveCatalog = { id: 'streamed-events-live', endpoint: '/api/matches/live' };
        const matches = await this.loadMatches(liveCatalog, prewarmSignal);
        const liveMatches = matches
          .filter((match) => isCurrentlyLiveMatch(match))
          .sort((left, right) =>
            Number(right.popular) - Number(left.popular)
            || Number(left.date || 0) - Number(right.date || 0)
          )
          .slice(0, Math.max(1, Math.min(12, Number(limit) || LIVE_STREAM_PREWARM_LIMIT)));

        for (const match of liveMatches) {
          if (prewarmSignal.aborted) break;
          attempted += 1;
          try {
            const streams = await this.getEventStreams(match.id || `streamed:${encodeURIComponent(match.sourceId)}`, {
              baseUrl,
              privateConfigId,
              prewarm: false,
              includeQuotaSources: true,
              signal: prewarmSignal
            });
            if (Array.isArray(streams) && streams.some((stream) => stream?.url)) warmed += 1;
          } catch (error) {
            this.logger.debug?.('streamed sports live stream prewarm event failed', {
              match: match.sourceId || match.id,
              error: error?.message || String(error)
            });
          }
        }
        return { attempted, warmed, skipped: false };
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      this.liveStreamPrewarmInFlight = null;
    });

    this.liveStreamPrewarmInFlight = task;
    return task;
  }

  toSportsBiteMatch(entry) {
    const title = toString(entry?.title) || [toString(entry?.home), toString(entry?.away)].filter(Boolean).join(' vs ');
    const kickoffSeconds = Number(entry?.kickoff?.unix || entry?.kickoff || 0);
    const date = Number.isFinite(kickoffSeconds) && kickoffSeconds > 0 ? kickoffSeconds * 1000 : Date.now();
    const sourceId = `sportsbite-${normalizeIdPart(`${title}-${kickoffSeconds || ''}`)}`;
    const category = normalizeIdPart(entry?.category || entry?.sport || 'sports');
    const home = toString(entry?.home);
    const away = toString(entry?.away);
    const sportsBiteStreams = (Array.isArray(entry?.sources) ? entry.sources : [])
      .map((source, index) => {
        const manifestUrl = toString(source?.source || source?.url);
        if (!isHttpUrl(manifestUrl)) return null;
        try {
          const url = new URL(manifestUrl);
          if (url.hostname.toLowerCase() !== 'embed.cr7siuu.xyz' || url.pathname !== '/manifest') return null;
        } catch {
          return null;
        }
        return {
          id: sourceId,
          streamNo: index + 1,
          language: 'SportsBite',
          hd: true,
          embedUrl: manifestUrl,
          directHlsUrl: manifestUrl,
          contextUrl: `${SPORTSBITE_ORIGIN}/`,
          headers: this.getSportsBiteHeaders({
            accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*'
          }),
          source: SPORTSBITE_SOURCE,
          viewers: 0
        };
      })
      .filter(Boolean);

    if (!title || !sportsBiteStreams.length) return null;
    const teams = [home, away].filter(Boolean);
    const explicitLive = Boolean(entry?.is_live || entry?.live || normalizeIdPart(entry?.status) === 'live');
    return {
      id: `streamed:${encodeURIComponent(sourceId)}`,
      sourceId,
      type: STREMIO_SPORTS_TYPE,
      title,
      category,
	      date,
	      poster: null,
	      popular: Boolean(entry?.is_live || entry?.popular),
	      isLive: isCurrentlyLiveMatch({ title, category, date, teams, isLive: explicitLive }),
	      sources: [{ source: SPORTSBITE_SOURCE, id: sourceId }],
      sportsBiteStreams,
      teams,
      normalizedTitle: normalizeTitle(`${title} ${category} ${home} ${away} ${toString(entry?.league)}`)
    };
  }

  toStreamFreeMatch(channel) {
    const sourceId = `${STREAMFREE_SOURCE}-${normalizeIdPart(channel.id)}`;
    const title = toString(channel.title);
    const category = normalizeIdPart(channel.category || 'sports');
    return {
      id: `streamed:${encodeURIComponent(sourceId)}`,
      sourceId,
      type: STREMIO_SPORTS_TYPE,
      title,
      category,
	      date: Date.now(),
	      poster: isHttpUrl(channel.poster) ? channel.poster : null,
	      popular: true,
	      isLive: true,
	      sources: [{ source: STREAMFREE_SOURCE, id: channel.id }],
      teams: [],
      normalizedTitle: normalizeTitle(`${title} ${category} streamfree live`)
    };
  }

  toFlixDlstreamsMatch(meta) {
    const sourceId = toString(meta?.id);
    const title = toString(meta?.name);
    if (!sourceId || !title) return null;
    const genres = Array.isArray(meta?.genres) ? meta.genres.map(toString).filter(Boolean) : [];
    const description = toString(meta?.description);
    const category = normalizeIdPart(
      genres.find((genre) => !/^sports$|^live tv$/iu.test(genre))
      || description.match(/^Category:\s*(.+)$/imu)?.[1]
      || 'sports'
    );
    if (!isLikelyFlixDlstreamsSportsEvent({ title, category, description })) return null;
    const released = meta?.videos?.[0]?.released || '';
    const date = Number.isFinite(Date.parse(released)) ? Date.parse(released) : Date.now();
    const teams = splitFixtureTeams(title);
    return {
      id: `streamed:${encodeURIComponent(`${FLIX_DLSTREAMS_SOURCE}-${sourceId}`)}`,
      sourceId: `${FLIX_DLSTREAMS_SOURCE}-${sourceId}`,
      type: STREMIO_SPORTS_TYPE,
      title,
      category,
      date,
	      poster: null,
	      posterShape: 'poster',
	      popular: /sources=(?:[2-9]|\d{2,})/iu.test(toString(meta?.poster)) || /sources:\s*(?:[2-9]|\d{2,})/iu.test(description),
	      isLive: isCurrentlyLiveMatch({ title, category, date, teams }),
	      sources: [{ source: FLIX_DLSTREAMS_SOURCE, id: sourceId }],
      teams,
      normalizedTitle: normalizeTitle(`${title} ${category} ${description} nebulasp dlstreams`)
    };
  }

  toMatch(entry, { liveEndpoint = false } = {}) {
    const sourceId = toString(entry?.id);
    const title = toString(entry?.title);
    const category = normalizeIdPart(entry?.category);
    const sources = (Array.isArray(entry?.sources) ? entry.sources : [])
      .map((source) => ({
        source: normalizeIdPart(source?.source),
        id: toString(source?.id)
      }))
      .filter((source) => source.source && source.id);
    const sportzXChannelId = toString(entry?.sportzxId || entry?.sportzxChannelId || entry?.sportzx_channel_id);
    if (sportzXChannelId && !sources.some((source) => source.source === 'sportzx' && source.id === sportzXChannelId)) {
      sources.push({
        source: 'sportzx',
        id: sportzXChannelId
      });
    }
    if (!sourceId || !title || sources.length === 0) return null;

    const poster = toAbsoluteStreamedUrl(entry?.poster);
    const home = entry?.teams?.home?.name ? toString(entry.teams.home.name) : '';
    const away = entry?.teams?.away?.name ? toString(entry.teams.away.name) : '';
    const date = Number(entry?.date || 0);
    const teams = [home, away].filter(Boolean);
    const explicitLive = Boolean(liveEndpoint || entry?.is_live || entry?.live || normalizeIdPart(entry?.status) === 'live');
    return {
      id: `streamed:${encodeURIComponent(sourceId)}`,
      sourceId,
      type: STREMIO_SPORTS_TYPE,
      title,
      category,
      date,
      poster: isHttpUrl(poster) ? poster : null,
	      popular: Boolean(entry?.popular),
	      isLive: isCurrentlyLiveMatch({ title, category, date, teams, isLive: explicitLive }),
	      sources,
      teams,
      normalizedTitle: normalizeTitle(`${title} ${category} ${home} ${away}`)
    };
  }

	  toEventMeta(match) {
	    if (match?.replay) {
	      const displayCategory = toString(match.category) || 'Sports Replays';
	      const subcategory = toString(match.replaySubcategory);
	      return {
	        id: match.id,
	        type: STREMIO_SPORTS_TYPE,
	        name: match.title,
	        poster: match.poster || undefined,
	        logo: match.poster || undefined,
	        posterShape: match.posterShape || 'landscape',
	        genres: [...new Set(['Sports', 'Replays', displayCategory, subcategory].filter(Boolean))],
	        releaseInfo: match.date ? formatEventTime(match.date) : 'Replay',
	        runtime: 'Replay',
	        isLive: false,
	        description: [
	          'Sports replay',
	          `Category: ${displayCategory}`,
	          subcategory ? `Competition: ${subcategory}` : '',
	          match.date ? `Date: ${formatEventTime(match.date)}` : '',
	          match.sources?.length ? `Parts: ${match.sources.length}` : ''
	        ].filter(Boolean).join('\n')
	      };
	    }
	    const isWorldCupFootball = isFifaWorldCupMatch(match);
	    const isDlhdChannel = normalizeIdPart(match?.category) === 'dlhd-channels'
	      || normalizeIdPart(match?.category) === 'live-tv'
	      || normalizeIdPart(match?.sourceId).startsWith('dlhd-channel-')
	      || normalizeIdPart(match?.sourceId).startsWith('cdnlivetv-channel-');
	    const actualLive = !isDlhdChannel && isCurrentlyLiveMatch(match);
	    const displayTitle = isDlhdChannel ? cleanDlhdChannelTitle(match.title) : match.title;
	    const displayCategory = isDlhdChannel ? 'Live TV' : match.category;
	    const liveTvGenres = isDlhdChannel
	      ? (() => {
	        const existing = Array.isArray(match?.genres) ? match.genres.map(toString).filter(Boolean) : [];
	        const inferred = inferLiveTvGenres(displayTitle);
	        return [...new Set([...existing, ...inferred])];
	      })()
	      : [];
	    return {
      id: match.id,
      type: STREMIO_SPORTS_TYPE,
      name: displayTitle,
      poster: match.poster || undefined,
      logo: match.poster || undefined,
      posterShape: match.posterShape || (match.sources?.some((source) => normalizeIdPart(source?.source) === FLIX_DLSTREAMS_SOURCE) ? 'poster' : 'landscape'),
		      genres: [...new Set(['Sports', displayCategory, ...liveTvGenres].filter(Boolean))],
	      tournament: isWorldCupFootball ? 'FIFA World Cup' : undefined,
	      competition: isWorldCupFootball ? 'FIFA World Cup' : undefined,
	      releaseInfo: isDlhdChannel ? 'Live TV' : (actualLive ? '🔴 LIVE' : formatEventTime(match.date)),
	      runtime: 'Live',
	      isLive: actualLive,
	      description: isDlhdChannel
	        ? [
	          displayTitle,
	          'Live TV channel',
	          liveTvGenres.filter((genre) => genre !== 'Live TV').length
	            ? `Genres: ${liveTvGenres.filter((genre) => genre !== 'Live TV').join(', ')}`
	            : '',
	          'Streams load from Live TV channel source.'
	        ].filter(Boolean).join('\n')
	        : [
	          'Live sports event',
	          `Category: ${displayCategory}`,
	          actualLive ? 'Status: LIVE' : '',
	          `Time: ${formatEventTime(match.date)}`,
	          match.teams.length ? `Teams: ${match.teams.join(' vs ')}` : '',
	          match.popular ? 'Popular event' : ''
	        ].filter(Boolean).join('\n')
    };
  }

	  async getEventCatalog({ catalog = {}, search = '', skip = 0, limit = EVENT_CATALOG_LIMIT, signal = null } = {}) {
	    const needle = normalizeTitle(search);
	    const matches = await this.loadMatches(catalog, signal);
	    const isDlhdChannelCatalog = catalog?.id === DLHD_CHANNEL_CATALOG_ID || catalog?.endpoint === DLHD_CHANNEL_CACHE_KEY;
	    const liveCatalog = isLiveCatalog(catalog);
	    const pageLimit = isDlhdChannelCatalog
	      ? Math.max(Number(limit) || 0, DLHD_CHANNEL_CATALOG_LIMIT)
	      : limit;
	    return matches
	      .filter((match) => !needle || match.normalizedTitle.includes(needle))
      .filter((match) => !liveCatalog || isCurrentlyLiveMatch(match))
	      .sort((left, right) => {
        if (isDlhdChannelCatalog) {
          const rankDelta = getLiveTvChannelRank(left) - getLiveTvChannelRank(right);
          if (rankDelta !== 0) return rankDelta;
          return toString(left.title).localeCompare(toString(right.title));
        }
        const eventScore = Number(!isSourceOnlyMatch(right, STREAMFREE_SOURCE)) - Number(!isSourceOnlyMatch(left, STREAMFREE_SOURCE));
        if (eventScore !== 0) return eventScore;
        const liveScore = Number(right.popular && !isSourceOnlyMatch(right, STREAMFREE_SOURCE)) - Number(left.popular && !isSourceOnlyMatch(left, STREAMFREE_SOURCE));
        if (liveScore !== 0) return liveScore;
        return Number(left.date || 0) - Number(right.date || 0);
      })
      .slice(Math.max(0, Number(skip) || 0))
      .slice(0, pageLimit)
      .map((match) => this.toEventMeta(match));
  }

  async findDirectStreamedMatch(sourceId, signal = null) {
    const endpoints = ['/api/matches/all-today', '/api/matches/live', '/api/matches/all-today/popular'];
    for (const endpoint of endpoints) {
      if (signal?.aborted) return null;
      const lookupSignal = signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, AbortSignal.timeout(STREAM_FAST_MATCH_LOOKUP_TIMEOUT_MS)])
        : AbortSignal.timeout(STREAM_FAST_MATCH_LOOKUP_TIMEOUT_MS);
      try {
	        const payload = await this.fetchJson(endpoint, lookupSignal);
	        const matches = (Array.isArray(payload) ? payload : [])
	          .map((entry) => this.toMatch(entry, { liveEndpoint: endpoint === '/api/matches/live' }))
	          .filter((match) => match.id && match.title);
        const match = matches.find((entry) => entry.sourceId === sourceId);
        if (match) {
          this.matchesCache.set(endpoint, {
            value: matches,
            expiresAt: Date.now() + CACHE_TTL_MS
          });
          this.indexMatches({ id: `fast-${normalizeIdPart(endpoint)}`, endpoint }, matches);
          await this.writeSharedCache(`matches:${endpoint}`, matches, CACHE_TTL_MS).catch(() => {});
          return match;
        }
      } catch (error) {
        this.logger.debug?.('streamed fast match lookup failed', {
          endpoint,
          error: error?.message || String(error)
        });
      }
    }
    return null;
  }

  async findMatch(id, signal = null) {
    const sourceId = decodeURIComponent(toString(id).replace(/^streamed:/u, ''));
    if (!sourceId) return null;

    const indexed = this.matchIndex.get(sourceId) || this.matchIndex.get(`streamed:${encodeURIComponent(sourceId)}`);
    if (indexed) return indexed;

    const directMatch = await this.findDirectStreamedMatch(sourceId, signal);
    if (directMatch) return directMatch;

    const baseCatalogs = this.getEventCatalogDefinitions();
    for (const catalog of baseCatalogs) {
      const matches = await this.loadMatches(catalog, signal);
      const match = matches.find((entry) => entry.sourceId === sourceId);
      if (match) return match;
    }

    const sports = await this.getSports(signal);
    const catalogs = this.getEventCatalogDefinitions(sports)
      .filter((catalog) => !baseCatalogs.some((baseCatalog) => baseCatalog.id === catalog.id));
    for (const catalog of catalogs) {
      const matches = await this.loadMatches(catalog, signal);
      const match = matches.find((entry) => entry.sourceId === sourceId);
      if (match) return match;
    }
    return null;
  }

  async getEventMeta(id, signal = null) {
    const match = await this.findMatch(id, signal);
    return match ? this.toEventMeta(match) : null;
  }

  prewarmMatchStreams(match, signal = null) {
    if (!match?.sources?.length || !this.canPrewarmBrowser()) return;
    const sources = this.filterSupplementalSources(match.sources);
    if (!sources.length) return;
    const taskKey = `match:${match.sourceId || match.id || match.normalizedTitle}`;
    if (this.playlistPrewarmInFlight.has(taskKey)) return;
    const task = Promise.allSettled(sources.map((source) => this.getSourceStreamsBounded(source, signal)))
      .then((settled) => {
        const rankedStreams = settled
          .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
          .sort(compareStreamsBySourceRank);
        this.prewarmStreams(this.getStreamValidationCandidates(rankedStreams).slice(0, 2));
      })
      .catch((error) => {
        this.logger.warn?.('streamed sports match prewarm failed', {
          match: match.sourceId || match.id,
          error: error?.message || String(error)
        });
      })
      .finally(() => {
        this.playlistPrewarmInFlight.delete(taskKey);
      });
    this.playlistPrewarmInFlight.set(taskKey, task);
  }

  async getSourceStreams(source, signal = null) {
    const key = `${source.source}:${source.id}`;
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED && isSupplementalSportsSource(source.source)) {
      return [];
    }
    const skipStreamCache = normalizeIdPart(source.source) === CDNLIVETV_SOURCE;
    const cached = skipStreamCache ? null : this.streamCache.get(key);
    if (!skipStreamCache && cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      if (normalizeIdPart(source.source) === DLHD_SOURCE) {
        const hls = await this.resolveDlhdChannel(source.id, signal);
        const streams = [{
          id: toString(source.id),
          streamNo: 1,
          language: '',
          hd: true,
          embedUrl: `${DLHD_ORIGIN}/watch.php?id=${encodeURIComponent(toString(source.id))}`,
          directHlsUrl: hls.url,
          contextUrl: hls.contextUrl,
          headers: hls.headers,
          source: DLHD_SOURCE,
          viewers: 0
        }];
        this.streamCache.set(key, {
          value: streams,
          expiresAt: Date.now() + Math.min(CACHE_TTL_MS, 30_000)
        });
        return streams;
      }
      if (normalizeIdPart(source.source) === STREAMFREE_SOURCE) {
        const channel = this.getStreamFreeChannel(source.id);
        if (!channel) return [];
        const hls = await this.resolveStreamFreeChannelHls(channel, signal);
        if (!hls?.url) return [];
        const streams = [{
          id: channel.id,
          streamNo: 1,
          language: 'StreamFree',
          hd: !String(hls.quality || '').includes('540'),
          embedUrl: hls.contextUrl,
          directHlsUrl: hls.url,
          contextUrl: hls.contextUrl,
          headers: hls.headers,
          source: STREAMFREE_SOURCE,
          viewers: 0,
          playbackProfile: {
            quality: hls.quality || 'HD',
            speedMbps: hls.quality === '2160p' ? 25 : hls.quality === '1080p' ? 10 : hls.quality === '720p' ? 6 : 4
          }
        }];
        this.streamCache.set(key, {
          value: streams,
          expiresAt: Date.now() + Math.min(CACHE_TTL_MS, 60_000)
        });
        return streams;
      }
      if (normalizeIdPart(source.source) === FLIX_DLSTREAMS_SOURCE) {
        const sharedCacheKey = `stream:v2:${FLIX_DLSTREAMS_SOURCE}:${toString(source.id)}`;
        const sharedCached = await this.readSharedCache(sharedCacheKey);
        if (Array.isArray(sharedCached) && sharedCached.length) {
          this.streamCache.set(key, {
            value: sharedCached,
            expiresAt: Date.now() + Math.min(CACHE_TTL_MS, 60_000)
          });
          return sharedCached;
        }
        const staleShared = await this.readSharedCache(sharedCacheKey, {
          allowStale: true,
          staleTtlMs: FLIX_DLSTREAMS_STREAM_STALE_MS
        });
        let streams = [];
        try {
          const payload = await this.fetchFlixDlstreamsJson(`/stream/tv/${encodeURIComponent(toString(source.id))}.json`, signal);
          const entries = Array.isArray(payload?.streams) ? payload.streams : [];
          streams = entries
            .map((entry, index) => {
              const url = toString(entry?.url);
              if (!isHttpUrl(url) || !/\.m3u8(?:$|[?#])/iu.test(url)) return null;
              return {
                id: toString(source.id),
                streamNo: index + 1,
                language: toString(entry?.name).replace(/^DLStreams\s*-\s*/iu, ''),
                hd: true,
                embedUrl: url,
                directHlsUrl: url,
                contextUrl: `${FLIX_DLSTREAMS_BASE_URL}/stream/tv/${encodeURIComponent(toString(source.id))}.json`,
                headers: this.getFlixDlstreamsHeaders({
                  accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*'
                }),
                source: FLIX_DLSTREAMS_SOURCE,
                viewers: 0
              };
            })
            .filter(Boolean);
        } catch (error) {
          if (Array.isArray(staleShared) && staleShared.length) {
            this.logger.warn?.('NebulaSP stream fetch failed, using stale cache', {
              source: source.id,
              error: error?.message || String(error)
            });
            this.streamCache.set(key, {
              value: staleShared,
              expiresAt: Date.now() + Math.min(CACHE_TTL_MS, 60_000)
            });
            return staleShared;
          }
          throw error;
        }
        if (!streams.length && Array.isArray(staleShared) && staleShared.length) {
          this.streamCache.set(key, {
            value: staleShared,
            expiresAt: Date.now() + Math.min(CACHE_TTL_MS, 60_000)
          });
          return staleShared;
        }
        this.streamCache.set(key, {
          value: streams,
          expiresAt: Date.now() + Math.min(CACHE_TTL_MS, 60_000)
        });
        if (streams.length) {
          await this.writeSharedCache(sharedCacheKey, streams, FLIX_DLSTREAMS_STREAM_CACHE_MS).catch((error) => {
            this.logger.debug?.('NebulaSP stream cache write failed', {
              source: source.id,
              error: error?.message || String(error)
            });
          });
        }
        return streams;
      }
      if (normalizeIdPart(source.source) === CDNLIVETV_SOURCE) {
        const hls = await this.resolveCdnLiveTvChannel(source.id, signal);
        const channel = this.decodeCdnLiveTvSourceId(source.id) || {};
        const channelName = toString(channel.name) || 'Live TV';
        const streams = hls?.url ? [{
          id: toString(source.id),
          streamNo: 1,
          channelName,
          language: '',
          hd: true,
          embedUrl: hls.contextUrl,
          directHlsUrl: hls.url,
          contextUrl: hls.contextUrl,
          headers: hls.headers,
          source: CDNLIVETV_SOURCE,
          viewers: Number(channel.viewers || 0),
          playbackProfile: hls.playbackProfile
        }] : [];
        return streams;
      }
      if (normalizeIdPart(source.source) === SPORTSBITE_SOURCE) {
        let streams = this.sportsBiteSourceStreams.get(source.id);
        if (!streams?.length) {
          await this.loadSportsBiteMatches({
            id: SPORTSBITE_CATALOG_ID,
            endpoint: SPORTSBITE_CACHE_KEY
          }, signal);
          streams = this.sportsBiteSourceStreams.get(source.id);
        }
        streams = Array.isArray(streams) ? streams : [];
        this.streamCache.set(key, {
          value: streams,
          expiresAt: Date.now() + CACHE_TTL_MS
        });
        return streams;
      }
      if (normalizeIdPart(source.source) === 'sportzx') {
        if (!this.sportzXStreamSource) return [];
        const streams = (await this.sportzXStreamSource.getChannelStreams(source.id, signal))
          .map((stream) => {
            const directHlsUrl = extractDirectHlsUrl(stream.embedUrl);
            return directHlsUrl ? { ...stream, directHlsUrl } : stream;
          });
        this.streamCache.set(key, {
          value: streams,
          expiresAt: Date.now() + CACHE_TTL_MS
        });
        return streams;
      }
      if (normalizeIdPart(source.source) === 'echo') {
        this.streamCache.set(key, {
          value: [],
          expiresAt: Date.now() + CACHE_TTL_MS
        });
        return [];
      }
      const payload = await this.fetchJson(`/api/stream/${encodeURIComponent(source.source)}/${encodeURIComponent(source.id)}`, signal);
      const streams = (Array.isArray(payload) ? payload : [])
        .map((entry) => ({
          id: toString(entry?.id) || source.id,
          streamNo: Number(entry?.streamNo || 1),
          language: toString(entry?.language),
          hd: Boolean(entry?.hd),
          embedUrl: toString(entry?.embedUrl),
          source: toString(entry?.source) || source.source,
          viewers: Number(entry?.viewers || 0)
        }))
        .filter((stream) => isHttpUrl(stream.embedUrl));
      this.streamCache.set(key, {
        value: streams,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      return streams;
    } catch (error) {
      const message = error?.message || String(error);
      if (/Streamed sports source load fast path complete/iu.test(message)) {
        return cached?.value || [];
      }
      const log = normalizeIdPart(source.source) === DLHD_SOURCE
        ? this.logger.debug
        : this.logger.warn;
      log?.call(this.logger, 'streamed event stream load failed', {
        source: source.source,
        error: message
      });
      return cached?.value || [];
    }
  }

  getStreamFreeChannel(channelId) {
    const normalized = normalizeIdPart(channelId);
    return STREAMFREE_CHANNELS.find((channel) => normalizeIdPart(channel.id) === normalized) || null;
  }

  getStreamFreeEmbedUrl(channel, quality = '1080p') {
    const embedCategory = encodeURIComponent(channel.embedCategory || channel.category || 'sports');
    const id = encodeURIComponent(channel.id);
    return `${STREAMFREE_ORIGIN}/embed/${embedCategory}/${id}?quality=${encodeURIComponent(quality)}&category=${embedCategory}&server=cdn`;
  }

  async getStreamFreeBestQuality(channel, signal = null) {
    try {
      const response = await this.fetchImpl(`${STREAMFREE_ORIGIN}/api/stream-status/${encodeURIComponent(channel.id)}`, {
        signal,
        headers: this.getStreamFreeHeaders({
          accept: 'application/json,*/*',
          referer: `${STREAMFREE_ORIGIN}/`
        })
      });
      if (!response.ok) throw new Error(`StreamFree status HTTP ${response.status}`);
      const payload = await response.json();
      const qualities = payload?.qualities && typeof payload.qualities === 'object' ? payload.qualities : {};
      return STREAMFREE_QUALITY_ORDER.find((quality) => qualities[quality]) || null;
    } catch (error) {
      this.logger.debug?.('streamfree status load failed', {
        channel: channel?.id,
        error: error?.message || String(error)
      });
      return null;
    }
  }

  extractStreamFreeTokens(html) {
    const match = String(html || '').match(/const\s+_0x\s*=\s*(\{.*?\});/su);
    if (!match?.[1]) return null;
    try {
      const parsed = JSON.parse(match[1]);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async resolveStreamFreeChannelHls(channel, signal = null) {
    const quality = await this.getStreamFreeBestQuality(channel, signal) || '1080p';
    const contextUrl = this.getStreamFreeEmbedUrl(channel, quality);
    const headers = this.getStreamFreeHeaders({ referer: contextUrl });
    const embedResponse = await this.fetchImpl(contextUrl, {
      signal,
      headers: this.getStreamFreeHeaders({
        accept: 'text/html,application/xhtml+xml,*/*',
        referer: `${STREAMFREE_ORIGIN}/`
      })
    });
    if (!embedResponse.ok) throw new Error(`StreamFree embed HTTP ${embedResponse.status}`);
    const embedHtml = await embedResponse.text();
    const tokens = this.extractStreamFreeTokens(embedHtml);
    const token = tokens?.[quality] || tokens?.['1080p'] || tokens?.['720p'] || tokens?.['540p'];
    if (!token?._t || !token?._e || !token?._n) {
      throw new Error('StreamFree token not found');
    }

    const keyResponse = await this.fetchImpl(`${STREAMFREE_ORIGIN}/get-stream-key/${encodeURIComponent(channel.id)}?force_server=cdn`, {
      signal,
      headers: this.getStreamFreeHeaders({
        accept: 'application/json,*/*',
        referer: contextUrl
      })
    });
    if (!keyResponse.ok) throw new Error(`StreamFree key HTTP ${keyResponse.status}`);
    const keyPayload = await keyResponse.json();
    if (keyPayload?.is_external && isHttpUrl(keyPayload.external_url)) {
      return {
        url: keyPayload.external_url,
        contextUrl,
        headers,
        quality
      };
    }

    const serverDomain = isHttpUrl(keyPayload?.server_domain) ? String(keyPayload.server_domain).replace(/\/+$/u, '') : STREAMFREE_ORIGIN;
    const playlistUrl = new URL(`/live/${channel.id}${quality}/index.m3u8`, `${serverDomain}/`);
    playlistUrl.searchParams.set('_t', token._t);
    playlistUrl.searchParams.set('_e', token._e);
    playlistUrl.searchParams.set('_n', token._n);
    return {
      url: playlistUrl.toString(),
      contextUrl,
      headers,
      quality
    };
  }

  extractCdnLiveTvHls(html) {
    const pieces = [];
    const varRe = /var\s+([A-Za-z0-9_$]+)\s*=\s*['"]([^'"]+)['"]/gu;
    for (const match of String(html || '').matchAll(varRe)) {
      const name = toString(match[1]);
      if (name.startsWith('_')) break;
      if (!match[2]) continue;
      pieces.push(match[2]);
      if (pieces.length >= 10) break;
    }
    if (!pieces.length) return null;
    try {
      const decoded = pieces.map((piece) => {
        const normalized = String(piece).replace(/-/gu, '+').replace(/_/gu, '/');
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
        return Buffer.from(padded, 'base64').toString('utf8');
      }).join('');
      const url = decoded.match(/https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*/iu)?.[0];
      return isHttpUrl(url) ? url : null;
    } catch {
      return null;
    }
  }

  async resolveCdnLiveTvChannel(sourceId, signal = null) {
    const channel = this.decodeCdnLiveTvSourceId(sourceId);
    if (!channel) throw new Error('CDNLiveTV channel id invalid');
    let playerUrl = toString(channel.url);
    if (!isHttpUrl(playerUrl)) {
      const url = new URL('/api/v1/channels/player/', CDNLIVETV_ORIGIN);
      url.searchParams.set('name', channel.name);
      url.searchParams.set('code', channel.code || '');
      url.searchParams.set('user', CDNLIVETV_USER || 'cdnlivetv');
      url.searchParams.set('plan', CDNLIVETV_PLAN || 'free');
      playerUrl = url.toString();
    }
    const response = await this.fetchImpl(playerUrl, {
      signal,
      headers: this.getCdnLiveTvHeaders({
        accept: 'text/html,application/xhtml+xml,*/*',
        referer: `${CDNLIVETV_ORIGIN}/`
      })
    });
    if (!response.ok) throw new Error(`CDNLiveTV player HTTP ${response.status}`);
    const html = await response.text();
    const hlsUrl = this.extractCdnLiveTvHls(html);
    if (!isHttpUrl(hlsUrl) || !/\.m3u8(?:$|[?#])/iu.test(hlsUrl)) {
      throw new Error('CDNLiveTV HLS not found');
    }
    return {
      url: hlsUrl,
      contextUrl: playerUrl,
      headers: this.getCdnLiveTvHeaders({
        accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
        referer: playerUrl
      }),
      playbackProfile: {
        quality: 'HD',
        speedMbps: 8
      }
    };
  }

  async validateCdnLiveTvChannelFresh(sourceId, signal = null) {
    return this.resolveCdnLiveTvChannel(sourceId, signal);
  }

  async isCdnLiveTvChannelHealthy(sourceId, signal = null) {
    const globalCached = this.cdnLiveTvHealthCache.get('__global__');
    if (globalCached && globalCached.expiresAt > Date.now() && globalCached.ok) return true;
    const key = toString(sourceId);
    if (!key) return false;
    const cached = this.cdnLiveTvHealthCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return Boolean(cached.ok);
    if (cached) this.cdnLiveTvHealthCache.delete(key);
    if (this.cdnLiveTvHealthInFlight.has(key)) return this.cdnLiveTvHealthInFlight.get(key);

    const task = this.validateCdnLiveTvChannelFresh(key, signal)
      .then((hls) => {
        this.cdnLiveTvHealthCache.set(key, {
          ok: true,
          checkedAt: Date.now(),
          expiresAt: Date.now() + CDNLIVETV_HEALTH_CACHE_MS
        });
        this.cdnLiveTvHealthCache.set('__global__', {
          ok: true,
          checkedAt: Date.now(),
          expiresAt: Date.now() + CDNLIVETV_HEALTH_CACHE_MS
        });
        return Boolean(hls?.url);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          this.cdnLiveTvHealthCache.set(key, {
            ok: false,
            error: error?.message || String(error),
            checkedAt: Date.now(),
            expiresAt: Date.now() + CDNLIVETV_DOWN_CACHE_MS
          });
          this.logger.warn?.('CDNLiveTV playback health check failed; hiding CDN cards briefly', {
            error: error?.message || String(error)
          });
        }
        return false;
      })
      .finally(() => {
        this.cdnLiveTvHealthInFlight.delete(key);
      });
    this.cdnLiveTvHealthInFlight.set(key, task);
    return task;
  }

  getSourceStreamsBounded(source, signal = null) {
    const sourceSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, AbortSignal.timeout(STREAM_SOURCE_LOAD_TIMEOUT_MS)])
      : AbortSignal.timeout(STREAM_SOURCE_LOAD_TIMEOUT_MS);
    return this.getSourceStreams(source, sourceSignal);
  }

  async collectEventSourceStreams(eventSources = [], signal = null) {
    if (!eventSources.length) return [];
    const controller = new AbortController();
    const combinedSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const pending = new Set();
    const streams = [];

    for (const source of eventSources) {
      let wrapped;
      wrapped = this.getSourceStreamsBounded(source, combinedSignal)
        .then((value) => ({ ok: true, value, source, task: wrapped }))
        .catch((error) => ({ ok: false, error, source, task: wrapped }));
      pending.add(wrapped);
    }

    const hasTrustedDirectHls = () =>
      this.getTrustedDirectHlsResults(streams.slice().sort(compareStreamsBySourceRank), new Set()).length > 0;
    const fastDeadlineAt = Date.now() + STREAM_DIRECT_HLS_FAST_SOURCE_MS;
    let fastWindowOpen = true;

    try {
      while (pending.size > 0 && !combinedSignal.aborted) {
        const raceItems = [...pending];
        if (fastWindowOpen) {
          const remainingMs = Math.max(1, fastDeadlineAt - Date.now());
          raceItems.push(new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), remainingMs);
            timer.unref?.();
          }));
        }

        const raced = await Promise.race(raceItems);
        if (!raced) {
          fastWindowOpen = false;
          if (hasTrustedDirectHls()) break;
          continue;
        }

        pending.delete(raced.task);
        if (raced.ok) {
          streams.push(...(Array.isArray(raced.value) ? raced.value : []));
        } else {
          const message = raced.error?.message || String(raced.error);
          if (!/Streamed sports source load fast path complete/iu.test(message)) {
            this.logger.warn?.('streamed event stream load failed', {
              source: raced.source?.source,
              error: message
            });
          }
        }

        if (fastWindowOpen && Date.now() >= fastDeadlineAt) {
          fastWindowOpen = false;
          if (hasTrustedDirectHls()) break;
        }
      }
    } finally {
      if (pending.size > 0) {
        controller.abort(new Error('Streamed sports source load fast path complete'));
      }
    }

    return streams.sort(compareStreamsBySourceRank);
  }

  filterSupplementalSources(sources = []) {
    if (SUPPLEMENTAL_SPORTS_SOURCES_ENABLED) return Array.isArray(sources) ? sources : [];
    return (Array.isArray(sources) ? sources : [])
      .filter((source) => !isSupplementalSportsSource(source?.source));
  }

  getPrivateStreamUrl(stream, { baseUrl = '', privateConfigId = '' } = {}) {
    if (!baseUrl || !privateConfigId) return null;
    const normalizedBase = String(baseUrl).replace(/\/+$/u, '');
    return `${normalizedBase}/private/${encodeURIComponent(privateConfigId)}/streamed/${encodeURIComponent(stream.source)}/${encodeURIComponent(stream.id)}/${encodeURIComponent(String(stream.streamNo || 1))}.m3u8`;
  }

  getLicensedExternalEmbedStreams({ baseUrl = '' } = {}) {
    return LICENSED_EXTERNAL_EMBED_STREAMS
      .map((stream) => ({
        id: `nebulasports:${stream.id}`,
        source: 'nebulasports',
        streamId: stream.id,
        streamNo: stream.streamNo,
        language: stream.language,
        hd: Boolean(stream.hd),
        viewers: 0,
        directHlsUrl: extractDirectHlsUrl(stream.embedUrl),
        embedUrl: baseUrl
          ? `${String(baseUrl).replace(/\/+$/u, '')}/watch-together/nebulasports/${encodeURIComponent(stream.id)}`
          : stream.embedUrl
      }))
      .filter((stream) => isHttpUrl(stream.embedUrl));
  }

  async getPlayableLicensedExternalCards(match, { baseUrl = '', signal = null } = {}) {
    const settled = await Promise.race([
      Promise.allSettled(this.getLicensedExternalEmbedStreams({ baseUrl })
      .filter((stream) => toString(stream.directHlsUrl) && isHttpUrl(stream.directHlsUrl))
      .map(async (stream) => {
        const playbackProfile = await this.validateDirectHlsUrl(stream.directHlsUrl, signal);
        return {
          name: 'NebulaStreams Streamed',
          title: this.buildPlaybackCardTitle(stream, {
            url: stream.directHlsUrl,
            playbackProfile
          }),
          url: stream.directHlsUrl,
          behaviorHints: {
            bingeGroup: `streamed-${match.normalizedTitle}`
          }
        };
      })),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve([]), LICENSED_EXTERNAL_VALIDATION_BUDGET_MS);
        timer.unref?.();
      })
    ]);
    return settled
      .filter((result) => result.status === 'fulfilled' && result.value?.url)
      .map((result) => result.value);
  }

  async getPlayableHelloSports4kCards(match, { baseUrl = '', privateConfigId = '', signal = null } = {}) {
    if (!baseUrl || !privateConfigId || !isFifaWorldCupMatch(match) || !shouldProbeHelloSportsForMatch(match)) return [];
    const streams = await this.getHelloSports4kStreamsForMatch(match, signal).catch((error) => {
      this.logger.debug?.('hellosports 4k stream load failed', {
        match: match.sourceId || match.id,
        error: error?.message || String(error)
      });
      return [];
    });
    const cards = [];
    for (const stream of streams) {
      if (cards.length >= HELLOSPORTS_4K_MAX_CARDS || signal?.aborted) break;
      try {
        const result = await this.validateStreamPlayableHls(stream, signal, {
          allowBrowserFallback: false
        });
        const hls = result?.hls;
        if (!hls?.url || !this.isPlayableHelloSportsProfile(stream, hls.playbackProfile || stream.playbackProfile)) continue;
        const privateUrl = this.getPrivateStreamUrl(stream, { baseUrl, privateConfigId });
        if (!privateUrl) continue;
        const playbackUrl = hls.resolveOnPlayback
          ? privateUrl
          : [
            `${privateUrl}?url=${Buffer.from(hls.url).toString('base64url')}`,
            hls.contextUrl ? `ctx=${Buffer.from(hls.contextUrl).toString('base64url')}` : ''
          ].filter(Boolean).join('&');
        cards.push({
          name: this.getHelloSportsCardName(stream, hls.playbackProfile),
          title: this.buildPlaybackCardTitle(stream, hls),
          url: playbackUrl,
          behaviorHints: {
            bingeGroup: `streamed-${match.normalizedTitle}`
          }
        });
      } catch (error) {
        this.logger.debug?.('hellosports 4k hls validation failed', {
          match: match.sourceId || match.id,
          channel: stream.channelName,
          error: error?.message || String(error)
        });
      }
    }
    return cards;
  }

  getKnownSportsChannelsForMatch(match = {}) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED || !isCurrentlyLiveMatch(match)) return [];
    const category = normalizeIdPart(match?.category);
    return KNOWN_SPORTS_CHANNELS.filter((channel) => {
      if (channel.worldCup) return false;
      return channel.category && normalizeIdPart(channel.category) === category;
    });
  }

  getKnownSportsHealthKey(channel = {}) {
    return toString(channel.id || channel.directHlsUrl).toLowerCase();
  }

  async validateKnownSportsChannelFresh(channel, signal = null) {
    const timeoutSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, AbortSignal.timeout(KNOWN_SPORTS_HLS_TIMEOUT_MS)])
      : AbortSignal.timeout(KNOWN_SPORTS_HLS_TIMEOUT_MS);
    const response = await this.fetchImpl(channel.directHlsUrl, {
      redirect: 'follow',
      signal: timeoutSignal,
      headers: this.getKnownSportsHlsHeaders()
    });
    if (!response.ok) throw new Error(`Known sports HLS HTTP ${response.status}`);
    const text = await response.text();
    if (!text.includes('#EXTM3U')) throw new Error('Known sports playlist is not playable');
    const fetched = {
      status: response.status,
      url: response.url || channel.directHlsUrl,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(text)
    };
    this.setCachedPlaylist(channel.directHlsUrl, fetched);
    await this.setSharedPlaylist(channel.directHlsUrl, fetched);
    return this.extractHlsPlaybackProfile(text) || channel.playbackProfile || {
      quality: 'HD',
      speedMbps: 8
    };
  }

  async validateKnownSportsChannel(channel, signal = null) {
    const key = this.getKnownSportsHealthKey(channel);
    const cached = this.knownSportsHealthCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.ok) return cached.playbackProfile;
      throw new Error(cached.error || 'Known sports channel unhealthy');
    }
    if (cached) this.knownSportsHealthCache.delete(key);
    if (this.knownSportsHealthInFlight.has(key)) {
      return this.knownSportsHealthInFlight.get(key);
    }
    const task = this.validateKnownSportsChannelFresh(channel, signal)
      .then((playbackProfile) => {
        this.knownSportsHealthCache.set(key, {
          ok: true,
          playbackProfile,
          checkedAt: Date.now(),
          expiresAt: Date.now() + KNOWN_SPORTS_HEALTH_CACHE_MS
        });
        return playbackProfile;
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          this.knownSportsHealthCache.set(key, {
            ok: false,
            error: error?.message || String(error),
            checkedAt: Date.now(),
            expiresAt: Date.now() + KNOWN_SPORTS_DOWN_CACHE_MS
          });
        }
        throw error;
      })
      .finally(() => {
        this.knownSportsHealthInFlight.delete(key);
      });
    this.knownSportsHealthInFlight.set(key, task);
    return task;
  }

  async getPlayableKnownSportsCards(match, { signal = null } = {}) {
    if (!isFifaWorldCupMatch(match) || !isCurrentlyLiveMatch(match)) return [];
    const channels = this.getKnownSportsChannelsForMatch(match).slice(0, KNOWN_SPORTS_MAX_CARDS);
    const settled = await Promise.allSettled(channels.map(async (channel) => {
      try {
        const playbackProfile = await this.validateKnownSportsChannel(channel, signal);
        const stream = {
          id: channel.id,
          source: KNOWN_SPORTS_SOURCE,
          streamNo: 1,
          channelName: channel.channelName,
          language: '',
          hd: true,
          highlightLabel: 'Fast direct stream',
          playbackProfile
        };
        return {
          name: 'Nebula Sports Fast',
          title: this.buildPlaybackCardTitle(stream, {
            url: channel.directHlsUrl,
            playbackProfile
          }),
          url: channel.directHlsUrl,
          behaviorHints: {
            bingeGroup: `streamed-${match.normalizedTitle}`
          }
        };
      } catch (error) {
        this.logger.debug?.('known sports HLS validation failed', {
          match: match.sourceId || match.id,
          channel: channel.channelName,
          error: error?.message || String(error)
        });
        return null;
      }
    }));
    return settled
      .filter((result) => result.status === 'fulfilled' && result.value?.url)
      .map((result) => result.value);
  }

  getDiagnostics() {
    const now = Date.now();
    return {
      caches: {
        sports: Boolean(this.sportsCache?.expiresAt > now),
        matches: this.matchesCache.size,
        streams: this.streamCache.size,
        hls: this.hlsCache.size,
        playlists: this.playlistCache.size,
        media: this.mediaCache.size,
        catalogIndexes: this.catalogMatchIndex.size,
        matchIndex: this.matchIndex.size,
        knownSportsHealth: this.knownSportsHealthCache.size
      },
      probe: {
        enabled: this.hlsProbeEnabled,
        failures: this.hlsProbeFailures,
        disabledForSeconds: Math.max(0, Math.ceil((this.hlsProbeDisabledUntil - now) / 1000))
      },
      browser: {
        fallbackEnabled: this.hlsBrowserFallbackEnabled,
        launchFailures: this.browserLaunchFailures,
        disabledForSeconds: Math.max(0, Math.ceil((this.browserDisabledUntil - now) / 1000)),
        activePages: this.activeBrowserPages
      },
      knownSports: KNOWN_SPORTS_CHANNELS.map((channel) => {
        const cached = this.knownSportsHealthCache.get(this.getKnownSportsHealthKey(channel));
        return {
          id: channel.id,
          channelName: channel.channelName,
          ok: cached ? Boolean(cached.ok) : null,
          checkedAt: cached?.checkedAt ? new Date(cached.checkedAt).toISOString() : null,
          expiresInSeconds: cached?.expiresAt ? Math.max(0, Math.ceil((cached.expiresAt - now) / 1000)) : null,
          quality: cached?.playbackProfile?.quality || channel.playbackProfile?.quality || '',
          speedMbps: cached?.playbackProfile?.speedMbps || channel.playbackProfile?.speedMbps || 0,
          error: cached?.error || ''
        };
      })
    };
  }

  getWorldCupXtreamConfig() {
    const baseUrl = toString(process.env.NEBULA_SPORTS_WC_XTREAM_BASE_URL).replace(/\/+$/u, '');
    const username = toString(process.env.NEBULA_SPORTS_WC_XTREAM_USERNAME);
    const password = toString(process.env.NEBULA_SPORTS_WC_XTREAM_PASSWORD);
    if (!baseUrl || !username || !password) return null;
    return {
      baseUrl,
      username,
      password,
      categoryId: WC_XTREAM_CATEGORY_ID || '105'
    };
  }

  getWorldCupXtreamHeaders({ accept = 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*' } = {}) {
    return {
      accept,
      'user-agent': 'Lavf/60.16.100'
    };
  }

  buildWorldCupXtreamApiUrl(config, action = '', extra = {}) {
    const url = new URL('/player_api.php', `${config.baseUrl}/`);
    url.searchParams.set('username', config.username);
    url.searchParams.set('password', config.password);
    if (action) url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(extra || {})) {
      if (value !== undefined && value !== null && String(value) !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  buildWorldCupXtreamHlsUrl(config, streamId) {
    return `${config.baseUrl}/live/${encodeURIComponent(config.username)}/${encodeURIComponent(config.password)}/${encodeURIComponent(String(streamId))}.m3u8`;
  }

  async getWorldCupXtreamStreams(signal = null) {
    const config = this.getWorldCupXtreamConfig();
    if (!config) return [];
    if (this.worldCupXtreamStreamsCache?.expiresAt > Date.now()) {
      return this.worldCupXtreamStreamsCache.value;
    }
    const response = await this.fetchImpl(this.buildWorldCupXtreamApiUrl(config, 'get_live_streams', {
      category_id: config.categoryId
    }), {
      signal,
      headers: this.getWorldCupXtreamHeaders({ accept: 'application/json,text/plain,*/*' })
    });
    if (!response.ok) throw new Error(`WC Xtream HTTP ${response.status}`);
    const payload = await response.json();
    const streams = (Array.isArray(payload) ? payload : [])
      .map((stream) => ({
        id: toString(stream?.stream_id),
        name: toString(stream?.name),
        hd: /\b(?:4k|uhd|fhd|hd|1080|2160|3840)\b/iu.test(toString(stream?.name))
      }))
      .filter((stream) => stream.id && stream.name && !/\bno\s+event\b/iu.test(stream.name));
    this.worldCupXtreamStreamsCache = {
      value: streams,
      expiresAt: Date.now() + WC_XTREAM_CACHE_MS
    };
    return streams;
  }

  async getPlayableWorldCupXtreamCards(match, { baseUrl = '', privateConfigId = '', signal = null } = {}) {
    if (!baseUrl || !privateConfigId || !isFifaWorldCupMatch(match)) return [];
    const config = this.getWorldCupXtreamConfig();
    if (!config) return [];
    const candidates = await this.getWorldCupXtreamStreams(signal)
      .then((streams) => streams.slice(0, WC_XTREAM_MAX_CANDIDATES))
      .catch((error) => {
        this.logger.warn?.('wc xtream streams load failed', { error: error?.message || String(error) });
        return [];
      });
    const deadlineAt = Date.now() + WC_XTREAM_VALIDATION_BUDGET_MS;
    const cards = [];
    for (const stream of candidates) {
      if (cards.length >= WC_XTREAM_MAX_CARDS || Date.now() >= deadlineAt || signal?.aborted) break;
      const hlsUrl = this.buildWorldCupXtreamHlsUrl(config, stream.id);
      try {
        const remainingMs = Math.max(750, deadlineAt - Date.now());
        const validationSignal = signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([signal, AbortSignal.timeout(remainingMs)])
          : AbortSignal.timeout(remainingMs);
        const playbackProfile = await this.validateDirectHlsUrl(hlsUrl, validationSignal, this.getWorldCupXtreamHeaders());
        const streamCard = {
          id: stream.id,
          source: WC_XTREAM_SOURCE,
          streamNo: 1,
          language: 'English',
          hd: stream.hd,
          playbackProfile,
          directHlsUrl: hlsUrl
        };
        const privateUrl = this.getPrivateStreamUrl(streamCard, { baseUrl, privateConfigId });
        if (!privateUrl) continue;
        cards.push({
          name: `NebulaStreams ${this.formatStreamSourceLabel(WC_XTREAM_SOURCE)}`,
          title: [
            this.buildPlaybackCardTitle(streamCard, { url: hlsUrl, playbackProfile }),
            stream.name
          ].filter(Boolean).join('\n'),
          url: privateUrl,
          behaviorHints: {
            bingeGroup: `streamed-${match.normalizedTitle}`
          }
        });
      } catch (error) {
        this.logger.debug?.('wc xtream hls validation failed', {
          streamId: stream.id,
          error: error?.message || String(error)
        });
      }
    }
    return cards;
  }

  getSportSrcApiKey() {
    return toString(process.env.SPORTSRC_API_KEY).trim();
  }

  buildSportSrcApiUrl(type, params = {}) {
    const url = new URL(SPORTSRC_API_BASE);
    url.searchParams.set('type', type);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && toString(value) !== '') {
        url.searchParams.set(key, toString(value));
      }
    }
    return url.toString();
  }

  getSportSrcHeaders() {
    return {
      accept: 'application/json,text/plain,*/*',
      'x-api-key': this.getSportSrcApiKey(),
      'user-agent': BROWSER_USER_AGENT
    };
  }

  formatSportSrcDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  }

  getSportSrcLookupDates(match = {}) {
    const dates = new Set();
    const add = (value) => {
      const formatted = this.formatSportSrcDate(value);
      if (formatted) dates.add(formatted);
    };
    add(match.date);
    add(match.timestamp);
    add(Date.now());
    return [...dates].slice(0, 2);
  }

  flattenSportSrcMatches(payload = {}) {
    const groups = Array.isArray(payload?.data) ? payload.data : [];
    return groups.flatMap((group) => {
      const leagueName = toString(group?.league?.name);
      const matches = Array.isArray(group?.matches) ? group.matches : [];
      return matches.map((entry) => {
        const teams = [
          toString(entry?.teams?.home?.name),
          toString(entry?.teams?.away?.name)
        ].filter(Boolean);
        return {
          id: toString(entry?.id),
          title: toString(entry?.title),
          category: 'football',
          league: leagueName,
          teams,
          status: toString(entry?.status),
          timestamp: Number(entry?.timestamp || 0)
        };
      }).filter((entry) => entry.id && entry.title);
    });
  }

  async fetchSportSrcMatchesForDate(date, signal = null) {
    const apiKey = this.getSportSrcApiKey();
    if (!apiKey || !date) return [];
    const cacheKey = `football:${date}`;
    const cached = this.sportSrcMatchesCache.get(cacheKey);
    if (cached?.expiresAt > Date.now()) return cached.value;
    const statusResults = await Promise.all(['inprogress', 'upcoming'].map(async (status) => {
      const response = await this.fetchImpl(this.buildSportSrcApiUrl('matches', {
        sport: 'football',
        status,
        date
      }), {
        signal,
        headers: this.getSportSrcHeaders()
      });
      if (!response.ok) throw new Error(`SportSRC matches HTTP ${response.status}`);
      return this.flattenSportSrcMatches(await response.json());
    }));
    const matches = [...new Map(statusResults.flat().map((match) => [match.id, match])).values()];
    this.sportSrcMatchesCache.set(cacheKey, {
      value: matches,
      expiresAt: Date.now() + SPORTSRC_MATCH_CACHE_MS
    });
    return matches;
  }

  getSportSrcMatchScore(match = {}, candidate = {}) {
    const matchKey = getMatchEventKey(match);
    const candidateKey = getMatchEventKey(candidate);
    if (matchKey && candidateKey && matchKey === candidateKey) return 100;
    const matchTeams = (Array.isArray(match.teams) && match.teams.length >= 2 ? match.teams : splitFixtureTeams(match.title))
      .map(normalizeTeamName)
      .filter(Boolean);
    const candidateTeams = (Array.isArray(candidate.teams) && candidate.teams.length >= 2 ? candidate.teams : splitFixtureTeams(candidate.title))
      .map(normalizeTeamName)
      .filter(Boolean);
    const teamHits = matchTeams.filter((team) => candidateTeams.includes(team)).length;
    if (teamHits >= 2) return 90;
    const matchTitle = normalizeTitle(match.title);
    const candidateTitle = normalizeTitle(candidate.title);
    if (matchTitle && candidateTitle && (matchTitle.includes(candidateTitle) || candidateTitle.includes(matchTitle))) return 70;
    return teamHits * 30;
  }

  async findSportSrcMatch(match = {}, signal = null) {
    if (!this.getSportSrcApiKey() || !isFifaWorldCupMatch(match)) return null;
    const candidates = [];
    for (const date of this.getSportSrcLookupDates(match)) {
      const dayMatches = await this.fetchSportSrcMatchesForDate(date, signal).catch((error) => {
        this.logger.debug?.('sportsrc matches load failed', {
          date,
          error: error?.message || String(error)
        });
        return [];
      });
      candidates.push(...dayMatches);
    }
    return candidates
      .map((candidate) => ({
        candidate,
        score: this.getSportSrcMatchScore(match, candidate)
      }))
      .filter((entry) => entry.score >= 60)
      .sort((left, right) => right.score - left.score)[0]?.candidate || null;
  }

  async fetchSportSrcDetail(matchId, signal = null) {
    const apiKey = this.getSportSrcApiKey();
    if (!apiKey || !matchId) return null;
    const cached = this.sportSrcDetailCache.get(matchId);
    if (cached?.expiresAt > Date.now()) return cached.value;
    const response = await this.fetchImpl(this.buildSportSrcApiUrl('detail', { id: matchId }), {
      signal,
      headers: this.getSportSrcHeaders()
    });
    if (!response.ok) throw new Error(`SportSRC detail HTTP ${response.status}`);
    const payload = await response.json();
    const detail = payload?.data || payload;
    this.sportSrcDetailCache.set(matchId, {
      value: detail,
      expiresAt: Date.now() + SPORTSRC_DETAIL_CACHE_MS
    });
    return detail;
  }

  getSportSrcStreams(detail = {}) {
    const detailMatchId = normalizeIdPart(detail?.match_info?.id || detail?.id || 'match');
    return (Array.isArray(detail?.sources) ? detail.sources : [])
      .map((stream, index) => ({
        id: `${detailMatchId}:${toString(stream?.id || `stream-${index + 1}`)}`,
        source: SPORTSRC_SOURCE,
        streamNo: Number(stream?.streamNo || index + 1),
        language: toString(stream?.language),
        hd: Boolean(stream?.hd),
        embedUrl: toString(stream?.embedUrl),
        contextUrl: toString(stream?.embedUrl),
        viewers: 0
      }))
      .filter((stream) => stream.id && isHttpUrl(stream.embedUrl));
  }

  async getPlayableSportSrcCards(match, { baseUrl = '', privateConfigId = '', signal = null } = {}) {
    if (!baseUrl || !privateConfigId || !isFifaWorldCupMatch(match) || !this.getSportSrcApiKey()) return [];
    const sportSrcMatch = await this.findSportSrcMatch(match, signal);
    if (!sportSrcMatch?.id) return [];
    const detail = await this.fetchSportSrcDetail(sportSrcMatch.id, signal).catch((error) => {
      this.logger.debug?.('sportsrc detail load failed', {
        match: sportSrcMatch.id,
        error: error?.message || String(error)
      });
      return null;
    });
    const candidates = this.getSportSrcStreams(detail).slice(0, SPORTSRC_MAX_CANDIDATES);
    const cards = [];
    const deadlineAt = Date.now() + SPORTSRC_VALIDATION_BUDGET_MS;
    for (const stream of candidates) {
      if (cards.length >= SPORTSRC_MAX_CARDS || Date.now() >= deadlineAt || signal?.aborted) break;
      try {
        const remainingMs = Math.max(750, deadlineAt - Date.now());
        const validationSignal = signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([signal, AbortSignal.timeout(remainingMs)])
          : AbortSignal.timeout(remainingMs);
        const probed = await this.resolvePlayableHlsWithProbe(stream.embedUrl, validationSignal);
        if (!probed?.url) continue;
        const headers = this.getPlaybackHeadersForSource(SPORTSRC_SOURCE, stream.embedUrl);
        const playbackProfile = this.requiresBrowserHlsContext(probed.url)
          ? this.inferStreamPlaybackProfile(stream)
          : await this.validateDirectHlsUrl(probed.url, validationSignal, headers);
        const hls = {
          url: probed.url,
          contextUrl: stream.embedUrl,
          headers,
          playbackProfile,
          resolveOnPlayback: this.requiresBrowserHlsContext(probed.url)
        };
        const cacheKey = `${SPORTSRC_SOURCE}:${stream.id}:${stream.streamNo || 1}`;
        this.setCachedHls(cacheKey, hls);
        await this.setSharedHls(cacheKey, hls);
        const privateUrl = this.getPrivateStreamUrl(stream, { baseUrl, privateConfigId });
        if (!privateUrl) continue;
        cards.push({
          name: `NebulaStreams ${this.formatStreamSourceLabel(SPORTSRC_SOURCE)}`,
          title: this.buildPlaybackCardTitle(stream, hls),
          url: [
            `${privateUrl}?url=${Buffer.from(hls.url).toString('base64url')}`,
            hls.contextUrl ? `ctx=${Buffer.from(hls.contextUrl).toString('base64url')}` : ''
          ].filter(Boolean).join('&'),
          behaviorHints: {
            bingeGroup: `streamed-${match.normalizedTitle}`
          }
        });
      } catch (error) {
        this.logger.debug?.('sportsrc hls validation failed', {
          match: sportSrcMatch.id,
          stream: stream.id,
          error: error?.message || String(error)
        });
      }
    }
    return cards;
  }

  getRapidFootballApiKey() {
    return toString(process.env.RAPID_FOOTBALL_API_KEY || process.env.RAPIDAPI_FOOTBALL_STREAMS_KEY).trim();
  }

  getRapidFootballHeaders() {
    return {
      accept: 'application/json,text/plain,*/*',
      'content-type': 'application/json',
      'x-rapidapi-host': RAPID_FOOTBALL_API_HOST,
      'x-rapidapi-key': this.getRapidFootballApiKey(),
      'user-agent': BROWSER_USER_AGENT
    };
  }

  getRapidFootballUsageKey(date = new Date()) {
    return `rapidfootball:usage:${date.toISOString().slice(0, 10)}`;
  }

  async canUseRapidFootballRequest() {
    const usage = await this.readSharedCache(this.getRapidFootballUsageKey()).catch(() => null);
    return Number(usage?.count || 0) < RAPID_FOOTBALL_DAILY_LIMIT;
  }

  async incrementRapidFootballUsage() {
    const key = this.getRapidFootballUsageKey();
    const usage = await this.readSharedCache(key).catch(() => null);
    await this.writeSharedCache(key, {
      count: Number(usage?.count || 0) + 1,
      updatedAt: Date.now()
    }, 48 * 60 * 60 * 1000).catch(() => {});
  }

  collectRapidFootballObjects(value, output = [], depth = 0) {
    if (depth > 5 || output.length > 200) return output;
    if (Array.isArray(value)) {
      for (const item of value) this.collectRapidFootballObjects(item, output, depth + 1);
      return output;
    }
    if (!value || typeof value !== 'object') return output;
    const hasTitle = toString(value.title || value.name || value.match || value.event || value.fixture);
    const hasTeams = toString(value.home_team_name || value.away_team_name || value.home || value.away || value.homeTeam || value.awayTeam || value.team1 || value.team2 || value.home_team || value.away_team);
    const serialized = JSON.stringify(value);
    const hasStream = /https?:\/\/[^"\s]+/iu.test(serialized) && /(?:m3u8|stream|embed|player|watch|live)/iu.test(serialized);
    if ((hasTitle || hasTeams) && hasStream) output.push(value);
    for (const key of ['data', 'matches', 'results', 'items', 'events', 'fixtures', 'list']) {
      if (value[key]) this.collectRapidFootballObjects(value[key], output, depth + 1);
    }
    return output;
  }

  extractRapidFootballTeams(entry = {}) {
    const pick = (...values) => values.map(toString).find(Boolean) || '';
    const home = pick(
      entry.home_team_name,
      entry.home,
      entry.homeTeam,
      entry.home_team,
      entry.team1,
      entry?.teams?.home?.name,
      entry?.teams?.home
    );
    const away = pick(
      entry.away_team_name,
      entry.away,
      entry.awayTeam,
      entry.away_team,
      entry.team2,
      entry?.teams?.away?.name,
      entry?.teams?.away
    );
    return [home, away].filter(Boolean);
  }

  extractRapidFootballUrls(entry = {}) {
    const urls = new Map();
    if (Array.isArray(entry?.servers)) {
      for (const [index, server] of entry.servers.entries()) {
        const url = toString(server?.url);
        if (!isHttpUrl(url)) continue;
        urls.set(url, {
          url,
          label: toString(server?.name || `Server ${index + 1}`),
          headers: server?.header && typeof server.header === 'object' ? server.header : null,
          type: toString(server?.type)
        });
      }
    }
    const visit = (value, label = '', depth = 0) => {
      if (depth > 6 || urls.size > 20) return;
      if (typeof value === 'string') {
        for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/giu)) {
          const rawUrl = match[0].replace(/[),;]+$/u, '');
          if (!isHttpUrl(rawUrl)) continue;
          if (!/(?:m3u8|stream|embed|player|watch|live)/iu.test(rawUrl)) continue;
          if (/\.(?:png|jpe?g|webp|svg|gif)(?:$|[?#])/iu.test(rawUrl)) continue;
          if (!urls.has(rawUrl)) urls.set(rawUrl, { url: rawUrl, label });
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, label, depth + 1);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, nested] of Object.entries(value)) {
        visit(nested, key, depth + 1);
      }
    };
    visit(entry);
    return Array.from(urls.values());
  }

  flattenRapidFootballMatches(payload = {}) {
    return this.collectRapidFootballObjects(payload)
      .map((entry, index) => {
        const teams = this.extractRapidFootballTeams(entry);
        const title = toString(entry.title || entry.name || entry.match || entry.event || entry.fixture)
          || (teams.length >= 2 ? `${teams[0]} vs ${teams[1]}` : '');
        const streams = this.extractRapidFootballUrls(entry);
        return {
          id: toString(entry.id || entry.match_id || entry.fixture_id || normalizeIdPart(title) || `match-${index + 1}`),
          title,
          category: 'football',
          teams,
          league: toString(entry.league_name || entry.league || entry.competition || entry.tournament),
          status: toString(entry.match_status || entry.status || entry.state),
          timestamp: Number(entry.match_time || entry.timestamp || entry.time || entry.start_time || entry.date || 0),
          streams
        };
      })
      .filter((entry) => entry.title && entry.streams.length);
  }

  async fetchRapidFootballMatches(signal = null) {
    const apiKey = this.getRapidFootballApiKey();
    if (!apiKey) return [];
    const now = Date.now();
    if (this.rapidFootballMatchesCache?.expiresAt > now) return this.rapidFootballMatchesCache.value;
    const shared = await this.readSharedCache(RAPID_FOOTBALL_CACHE_KEY).catch(() => null);
    if (shared?.matches && now - Number(shared.fetchedAt || 0) < RAPID_FOOTBALL_MATCH_CACHE_MS) {
      this.rapidFootballMatchesCache = {
        value: shared.matches,
        expiresAt: now + Math.min(RAPID_FOOTBALL_MATCH_CACHE_MS, 30 * 60 * 1000)
      };
      return shared.matches;
    }
    const canRequest = await this.canUseRapidFootballRequest();
    if (!canRequest) {
      return Array.isArray(shared?.matches) ? shared.matches : [];
    }
    const url = new URL(RAPID_FOOTBALL_MATCHES_URL);
    url.searchParams.set('page', '1');
    try {
      const response = await this.fetchImpl(url, {
        signal,
        headers: this.getRapidFootballHeaders()
      });
      await this.incrementRapidFootballUsage();
      if (!response.ok) throw new Error(`RapidFootball matches HTTP ${response.status}`);
      const matches = this.flattenRapidFootballMatches(await response.json());
      this.rapidFootballMatchesCache = {
        value: matches,
        expiresAt: now + RAPID_FOOTBALL_MATCH_CACHE_MS
      };
      await this.writeSharedCache(RAPID_FOOTBALL_CACHE_KEY, {
        matches,
        fetchedAt: now
      }, RAPID_FOOTBALL_STALE_CACHE_MS).catch(() => {});
      return matches;
    } catch (error) {
      this.logger.debug?.('rapid football matches load failed', {
        error: error?.message || String(error)
      });
      return Array.isArray(shared?.matches) ? shared.matches : [];
    }
  }

  findRapidFootballMatchScore(match = {}, candidate = {}) {
    return this.getSportSrcMatchScore(match, candidate);
  }

  async findRapidFootballMatch(match = {}, signal = null) {
    if (!this.getRapidFootballApiKey() || !isFifaWorldCupMatch(match)) return null;
    const candidates = await this.fetchRapidFootballMatches(signal);
    return candidates
      .map((candidate) => ({
        candidate,
        score: this.findRapidFootballMatchScore(match, candidate)
      }))
      .filter((entry) => entry.score >= 60)
      .sort((left, right) => right.score - left.score)[0]?.candidate || null;
  }

  async validateRapidFootballHlsUrl(url, signal = null, headers = null, timeoutMs = 2_500) {
    const controller = new AbortController();
    let parentAbortHandler = null;
    let timeout = null;
    const abort = (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    if (signal) {
      if (signal.aborted) throw signal.reason || new Error('Rapid football validation aborted');
      parentAbortHandler = () => abort(signal.reason || new Error('Rapid football validation aborted'));
      signal.addEventListener('abort', parentAbortHandler, { once: true });
    }
    const fetchTask = (async () => {
      const response = await fetch(url, {
        headers: {
          accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
          ...(headers || {})
        },
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Rapid football HLS HTTP ${response.status}`);
      const text = await response.text();
      if (!text.includes('#EXTM3U')) throw new Error('Rapid football HLS playlist is not playable');
      return this.extractHlsPlaybackProfile(text) || { quality: 'HD', speedMbps: 8 };
    })();
    const timeoutTask = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('Rapid football HLS validation timeout');
        abort(error);
        reject(error);
      }, Math.max(250, timeoutMs));
    });
    try {
      return await Promise.race([fetchTask, timeoutTask]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && parentAbortHandler) signal.removeEventListener('abort', parentAbortHandler);
    }
  }

  async getPlayableRapidFootballCards(match, { baseUrl = '', privateConfigId = '', signal = null } = {}) {
    if (!baseUrl || !privateConfigId || !isFifaWorldCupMatch(match) || !this.getRapidFootballApiKey()) return [];
    const rapidMatch = await this.findRapidFootballMatch(match, signal);
    if (!rapidMatch?.streams?.length) return [];
    const candidates = rapidMatch.streams
      .filter((stream) => extractDirectHlsUrl(stream.url))
      .slice(0, RAPID_FOOTBALL_MAX_CANDIDATES);
    const selected = [];
    const deadlineAt = Date.now() + RAPID_FOOTBALL_VALIDATION_BUDGET_MS;
    for (const [index, candidate] of candidates.entries()) {
      if (selected.length >= RAPID_FOOTBALL_MAX_CARDS || signal?.aborted || Date.now() >= deadlineAt) break;
      const hlsUrl = extractDirectHlsUrl(candidate.url);
      if (!hlsUrl) continue;
      const headers = candidate.headers || this.getPlaybackHeadersForSource(RAPID_FOOTBALL_SOURCE, candidate.url);
      try {
        const remainingMs = Math.max(500, deadlineAt - Date.now());
        const timeoutMs = Math.min(2_500, remainingMs);
        const playbackProfile = await this.validateRapidFootballHlsUrl(hlsUrl, signal, headers, timeoutMs);
        selected.push({
          stream: {
            id: `${rapidMatch.id}:${index + 1}`,
            source: RAPID_FOOTBALL_SOURCE,
            streamNo: index + 1,
            language: '',
            hd: true,
            embedUrl: candidate.url,
            contextUrl: candidate.url,
            viewers: 0
          },
          hls: {
            url: hlsUrl,
            contextUrl: candidate.url,
            headers,
            playbackProfile,
            resolveOnPlayback: this.requiresBrowserHlsContext(hlsUrl)
          }
        });
      } catch (error) {
        this.logger.debug?.('rapid football playlist validation failed', {
          match: rapidMatch.id,
          stream: candidate.label,
          error: error?.message || String(error)
        });
      }
    }
    const cards = [];
    for (const { stream, hls } of selected) {
      try {
        const cacheKey = `${RAPID_FOOTBALL_SOURCE}:${stream.id}:${stream.streamNo}`;
        this.setCachedHls(cacheKey, hls);
        await this.setSharedHls(cacheKey, hls);
        const privateUrl = this.getPrivateStreamUrl(stream, { baseUrl, privateConfigId });
        if (!privateUrl) continue;
        cards.push({
          name: 'NebulaStreams Football API',
          title: this.buildPlaybackCardTitle(stream, hls),
          url: hls.resolveOnPlayback
            ? privateUrl
            : [
              `${privateUrl}?url=${Buffer.from(hls.url).toString('base64url')}`,
              hls.contextUrl ? `ctx=${Buffer.from(hls.contextUrl).toString('base64url')}` : ''
            ].filter(Boolean).join('&'),
          behaviorHints: {
            bingeGroup: `streamed-${match.normalizedTitle}`
          }
        });
      } catch (error) {
        this.logger.debug?.('rapid football hls validation failed', {
          match: rapidMatch.id,
          error: error?.message || String(error)
        });
      }
    }
    return cards;
  }

  getLicensedExternalEmbedSource(id) {
    return LICENSED_EXTERNAL_EMBED_STREAM_BY_ID.get(normalizeIdPart(id)) || null;
  }

  extractHlsPlaybackProfile(text = '') {
    const body = toString(text);
    if (!body.includes('#EXTM3U')) return null;
    const profiles = [];
    for (const line of body.split(/\r?\n/u)) {
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const bandwidthMatch = line.match(/\bBANDWIDTH=(\d+)/iu);
      const resolutionMatch = line.match(/\bRESOLUTION=(\d+)x(\d+)/iu);
      profiles.push({
        bandwidth: bandwidthMatch ? Number.parseInt(bandwidthMatch[1], 10) : 0,
        height: resolutionMatch ? Number.parseInt(resolutionMatch[2], 10) : 0
      });
    }
    if (!profiles.length) return null;
    const best = profiles.sort((left, right) =>
      Number(right.height || 0) - Number(left.height || 0)
      || Number(right.bandwidth || 0) - Number(left.bandwidth || 0)
    )[0];
    return {
      quality: this.formatQualityLabel(best.height),
      speedMbps: this.estimateNetworkSpeedMbps(best.bandwidth, best.height)
    };
  }

  getHlsVariantPlaylists(text = '', playlistUrl = '') {
    const lines = toString(text).split(/\r?\n/u);
    const variants = [];
    let pending = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
        const bandwidthMatch = trimmed.match(/\bBANDWIDTH=(\d+)/iu);
        const resolutionMatch = trimmed.match(/\bRESOLUTION=(\d+)x(\d+)/iu);
        pending = {
          bandwidth: bandwidthMatch ? Number.parseInt(bandwidthMatch[1], 10) : 0,
          height: resolutionMatch ? Number.parseInt(resolutionMatch[2], 10) : 0
        };
        continue;
      }
      if (!pending || trimmed.startsWith('#')) continue;
      try {
        variants.push({
          ...pending,
          url: new URL(trimmed, playlistUrl).toString()
        });
      } catch {
        // Ignore malformed variant URL.
      }
      pending = null;
    }
    return variants.sort((left, right) =>
      Number(right.height || 0) - Number(left.height || 0)
      || Number(right.bandwidth || 0) - Number(left.bandwidth || 0)
    );
  }

  getHlsMediaSegmentUrls(text = '', playlistUrl = '', limit = 2) {
    const urls = [];
    let awaitingSegment = false;
    for (const line of toString(text).split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#')) {
        if (trimmed.toUpperCase().startsWith('#EXTINF')) awaitingSegment = true;
        continue;
      }
      if (!awaitingSegment) continue;
      awaitingSegment = false;
      try {
        urls.push(new URL(trimmed, playlistUrl).toString());
      } catch {
        // Ignore malformed segment URL.
      }
    }
    return urls.slice(-Math.max(1, limit)).reverse();
  }

  async fetchHlsPlaylistText(url, signal = null, headers = null, timeoutMs = 4_000) {
    const validationSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
        ...(headers || {})
      },
      redirect: 'follow',
      signal: validationSignal
    });
    if (!response.ok) throw new Error(`Direct HLS HTTP ${response.status}`);
    const text = await response.text();
    if (!text.includes('#EXTM3U')) throw new Error('Direct HLS playlist is not playable');
    return {
      status: response.status,
      url: response.url || url,
      headers: Object.fromEntries(response.headers.entries()),
      text
    };
  }

  async probeHlsMediaSegment(playlistUrl, playlistText, signal = null, headers = null) {
    let mediaPlaylistUrl = playlistUrl;
    let mediaPlaylistText = playlistText;
    const variants = this.getHlsVariantPlaylists(playlistText, playlistUrl);
    if (variants[0]?.url) {
      const variant = variants[0];
      const fetched = await this.fetchHlsPlaylistText(variant.url, signal, headers, HLS_SEGMENT_PROBE_TIMEOUT_MS);
      mediaPlaylistUrl = fetched.url || variant.url;
      mediaPlaylistText = fetched.text;
    }

    const segmentUrls = this.getHlsMediaSegmentUrls(mediaPlaylistText, mediaPlaylistUrl, 2);
    if (!segmentUrls.length) throw new Error('Direct HLS playlist has no media segments');

    let lastError = null;
    for (const segmentUrl of segmentUrls) {
      const startedAt = Date.now();
      try {
        const probeSignal = signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([signal, AbortSignal.timeout(HLS_SEGMENT_PROBE_TIMEOUT_MS)])
          : AbortSignal.timeout(HLS_SEGMENT_PROBE_TIMEOUT_MS);
        const response = await fetch(segmentUrl, {
          headers: {
            ...(headers || {}),
            accept: 'video/mp2t,video/mp4,application/octet-stream,*/*',
            range: `bytes=0-${HLS_SEGMENT_PROBE_MAX_BYTES - 1}`
          },
          redirect: 'follow',
          signal: probeSignal
        });
        if (!response.ok && response.status !== 206) throw new Error(`Direct HLS segment HTTP ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length < 1024) throw new Error('Direct HLS segment probe returned too few bytes');
        const durationMs = Math.max(1, Date.now() - startedAt);
        const measuredMbps = (body.length * 8) / (durationMs / 1000) / 1_000_000;
        return {
          url: segmentUrl,
          bytes: body.length,
          durationMs,
          measuredMbps: Math.round(measuredMbps * 10) / 10
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Direct HLS segment probe failed');
  }

  formatQualityLabel(height = 0) {
    const value = Number.parseInt(height, 10) || 0;
    if (value >= 2000) return '4K';
    if (value >= 1000) return '1080p';
    if (value >= 700) return '720p';
    if (value >= 450) return '480p';
    if (value > 0) return `${value}p`;
    return 'HD';
  }

  isRexDexHighQualityPlaybackProfile(profile = null) {
    const quality = normalizeTitle(profile?.quality || '');
    const heightMatch = quality.match(/\b(\d{3,4})p?\b/u);
    const height = heightMatch ? Number.parseInt(heightMatch[1], 10) : 0;
    return quality.includes('4k') || quality.includes('uhd') || height >= REXDEX_MIN_HEIGHT;
  }

  estimateNetworkSpeedMbps(bandwidth = 0, height = 0) {
    const measuredMbps = Math.ceil((Number(bandwidth || 0) * 1.6) / 1_000_000);
    if (measuredMbps > 0) return Math.max(3, measuredMbps);
    const normalizedHeight = Number.parseInt(height, 10) || 0;
    if (normalizedHeight >= 2000) return 25;
    if (normalizedHeight >= 1000) return 10;
    if (normalizedHeight >= 700) return 6;
    if (normalizedHeight >= 450) return 4;
    return 5;
  }

  inferStreamPlaybackProfile(stream = {}) {
    return {
      quality: stream?.hd ? 'HD' : 'SD',
      speedMbps: stream?.hd ? 8 : 4
    };
  }

  getCachedHlsPlaybackProfile(url) {
    const cached = this.getCachedPlaylist(url);
    const text = cached?.body?.toString('utf8') || '';
    return this.extractHlsPlaybackProfile(text);
  }

  formatStreamSourceLabel(source = '') {
    const normalized = normalizeIdPart(source);
    const labels = new Map([
      [STREAMZY_4K_SOURCE, 'Streamzy 4K'],
      [STREAMFREE_SOURCE, 'StreamFree'],
      [SPORTSBITE_SOURCE, 'SportsBite'],
      [DLHD_SOURCE, 'Live TV'],
      [FLIX_DLSTREAMS_SOURCE, 'NebulaSP'],
      [CDNLIVETV_SOURCE, 'Live TV'],
      [REXDEX_SOURCE, 'RexDex'],
      [WC_XTREAM_SOURCE, 'World Cup IPTV'],
      [SPORTSRC_SOURCE, 'SportSRC'],
      [RAPID_FOOTBALL_SOURCE, 'Football API'],
      [REPLAYZONE_SOURCE, 'ReplayZone'],
      ['nebulasports', 'Nebula Sports'],
      [HELLOSPORTS_SOURCE, 'Hello Sports'],
      [KNOWN_SPORTS_SOURCE, 'Known Sports'],
      ['sportzx', 'SportzX'],
      ['admin', 'Admin'],
      ['delta', 'Delta'],
      ['echo', 'Echo'],
      ['golf', 'Golf']
    ]);
    if (labels.has(normalized)) return labels.get(normalized);
    return toString(source)
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(' ');
  }

  getStreamLanguageLabel(stream = {}, sourceLabel = '') {
    const language = toString(stream?.language);
    if (!language) return '';

    const normalizedLanguage = normalizeIdPart(language);
    const knownSourceLabels = new Set([
      normalizeIdPart(stream?.source),
      normalizeIdPart(sourceLabel),
      STREAMFREE_SOURCE,
      SPORTSBITE_SOURCE,
      DLHD_SOURCE,
      FLIX_DLSTREAMS_SOURCE,
      CDNLIVETV_SOURCE,
      REXDEX_SOURCE,
      WC_XTREAM_SOURCE,
	      SPORTSRC_SOURCE,
	      RAPID_FOOTBALL_SOURCE,
	      REPLAYZONE_SOURCE,
      'nebulasports',
      HELLOSPORTS_SOURCE,
      KNOWN_SPORTS_SOURCE,
      'sportzx'
    ]);
    if (knownSourceLabels.has(normalizedLanguage)) return '';
    return language;
  }

  buildPlaybackCardTitle(stream = {}, hls = {}) {
    const profile = hls?.playbackProfile || this.getCachedHlsPlaybackProfile(hls?.url) || this.inferStreamPlaybackProfile(stream);
    const sourceLabel = this.formatStreamSourceLabel(stream?.source);
    const languageLabel = this.getStreamLanguageLabel(stream, sourceLabel);
    const sourceKey = normalizeIdPart(stream?.source);
    const channelName = [CDNLIVETV_SOURCE, HELLOSPORTS_SOURCE, KNOWN_SPORTS_SOURCE].includes(sourceKey)
      ? toString(stream?.channelName)
      : '';
    const highlightLabel = sourceKey === HELLOSPORTS_SOURCE && profile?.quality
      ? `${profile.quality} Stream`
      : toString(stream?.highlightLabel);
    return [
      highlightLabel,
      channelName ? `Channel: ${channelName}` : '',
      `Recommended speed: ${profile.speedMbps || 5} Mbps+`,
      'Use MPV or external player for smoother playback',
      languageLabel ? `Language: ${languageLabel}` : ''
    ].filter(Boolean).join('\n');
  }

  dedupeEmbedStreams(streams = []) {
    const seen = new Set();
    return streams.filter((stream) => {
      const key = toString(stream?.embedUrl).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async getEventEmbedStreams(id, options = null) {
    const signal = options && typeof options === 'object' && 'signal' in options
      ? options.signal
      : options || null;
    const baseUrl = options?.baseUrl || '';
    const match = await this.findMatch(id, signal);
    if (!match) return { match: null, streams: [] };

    const hasCdnLiveTvSource = Array.isArray(match.sources)
      && match.sources.some((source) => normalizeIdPart(source?.source) === CDNLIVETV_SOURCE);
    const dlhdSources = hasCdnLiveTvSource ? [] : await this.getDlhdSourcesForMatch(match, signal).catch((error) => {
      this.logger.debug?.('dlhd event match failed', {
        match: match.sourceId || match.id,
        error: error?.message || String(error)
      });
      return [];
    });
    const eventSources = [...this.filterSupplementalSources(match.sources), ...dlhdSources];
    const settled = await Promise.allSettled(eventSources.map((source) => this.getSourceStreamsBounded(source, signal)));
    const streams = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .sort(compareStreamsBySourceRank)
      .map((stream) => ({
        id: `${stream.source}:${stream.id}:${stream.streamNo || 1}`,
        source: stream.source,
        streamId: stream.streamId || stream.id,
        streamNo: Number(stream.streamNo || 1),
        language: stream.language,
        channelName: stream.channelName,
        hd: Boolean(stream.hd),
        viewers: Number(stream.viewers || 0),
        embedUrl: stream.embedUrl || this.getEmbedUrl({
          source: stream.source,
          streamId: stream.id,
          streamNo: stream.streamNo || 1
        })
      }))
      .filter((stream) => isHttpUrl(stream.embedUrl));

    const externalStreams = SUPPLEMENTAL_SPORTS_SOURCES_ENABLED && isFifaWorldCupMatch(match)
      ? this.getLicensedExternalEmbedStreams({ baseUrl })
      : [];
    return {
      match,
      streams: this.dedupeEmbedStreams([
        ...streams,
        ...externalStreams
      ])
    };
  }

  getTemporaryEventDirectStreams(match = {}) {
    const streams = [];
    if (Date.now() < REXDEX_PORTUGAL_UZBEKISTAN_UNTIL_MS && isPortugalUzbekistanMatch(match)) {
      streams.push({
        id: REXDEX_PORTUGAL_UZBEKISTAN_STREAM_ID,
        streamNo: 1,
        language: 'English',
        hd: true,
        embedUrl: REXDEX_PORTUGAL_UZBEKISTAN_PAGE,
        contextUrl: REXDEX_PORTUGAL_UZBEKISTAN_PAGE,
        directHlsUrl: REXDEX_PORTUGAL_UZBEKISTAN_HLS,
        headers: {
          ...this.getBrowserFetchHeaders(),
          accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
          origin: 'https://www.rexdexsports.in',
          referer: REXDEX_PORTUGAL_UZBEKISTAN_PAGE
        },
        source: REXDEX_SOURCE,
        viewers: 0,
        playbackProfile: {
          quality: 'HD',
          speedMbps: 8
        }
      });
    }
    return streams;
  }

  encodeRexDexStreamId(url = '') {
    return Buffer.from(toString(url), 'utf8').toString('base64url');
  }

  decodeRexDexStreamId(sourceId = '') {
    try {
      const url = Buffer.from(toString(sourceId), 'base64url').toString('utf8');
      if (!url.startsWith(`${REXDEX_ORIGIN}/`) && url !== REXDEX_ORIGIN) return '';
      return url;
    } catch {
      return '';
    }
  }

  scoreRexDexPostForMatch(post = {}, match = {}) {
    const matchKey = getMatchEventKey(match);
    const postKey = getMatchEventKey({ title: post.title, teams: post.teams });
    if (matchKey && postKey && matchKey === postKey) return 100;

    const matchTeams = Array.isArray(match.teams) && match.teams.length >= 2
      ? match.teams.map(normalizeTeamName)
      : splitFixtureTeams(match.title);
    const postTeams = Array.isArray(post.teams) ? post.teams.map(normalizeTeamName) : [];
    if (matchTeams.length >= 2 && postTeams.length >= 2) {
      const matchedTeams = matchTeams.filter((team) => postTeams.includes(team)).length;
      if (matchedTeams >= 2) return 90;
      if (matchedTeams === 1) return 35;
    }

    const matchWords = new Set(normalizeTitle(match.title).split(/\s+/u).filter((word) => word.length > 2));
    const postWords = new Set(normalizeTitle(post.title).split(/\s+/u).filter((word) => word.length > 2));
    const hits = [...matchWords].filter((word) => postWords.has(word)).length;
    return hits >= 2 ? hits * 10 : 0;
  }

  async findRexDexPostForMatch(match = {}, signal = null) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED || !match?.title) return null;
    const posts = await this.fetchRexDexPosts(signal);
    const candidates = posts
      .map((post) => ({
        post,
        score: this.scoreRexDexPostForMatch(post, match)
      }))
      .filter((entry) => entry.score >= 40)
      .sort((left, right) => right.score - left.score);
    return candidates[0]?.post || null;
  }

  async getRexDexStreamsForMatch(match = {}, signal = null) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED || !isCurrentlyLiveMatch(match)) return [];
    const post = await this.findRexDexPostForMatch(match, signal);
    if (!post?.url) return [];
    return [{
      id: this.encodeRexDexStreamId(post.url),
      streamNo: 1,
      language: 'RexDex',
      hd: true,
      embedUrl: post.url,
      contextUrl: post.url,
      source: REXDEX_SOURCE,
      viewers: 0,
      rexdexMinHeight: REXDEX_MIN_HEIGHT,
      playbackProfile: {
        quality: '1080p+',
        speedMbps: 10
      }
    }];
  }

  getStreamzy4kStreamById(id = '') {
    const normalizedId = normalizeIdPart(id);
    return STREAMZY_4K_STREAMS.find((stream) => stream.id === normalizedId) || null;
  }

  async getHelloSports4kStreamsForMatch(match = {}, signal = null) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED || !isFifaWorldCupMatch(match) || !shouldProbeHelloSportsForMatch(match)) return [];
    const post = await this.findHelloSportsPostForMatch(match, signal);
    if (!post?.url) return [];
    const entries = await this.fetchHelloSports4kEntries(signal);
    return entries.map((entry, index) => {
      const stream = {
        embedUrl: entry.embedUrl,
        channelName: entry.channelName
      };
      const playbackProfile = entry.playbackProfile || this.inferHelloSportsPlaybackProfile(entry.label || entry.channelName);
      const qualityLabel = normalizeTitle(playbackProfile.quality || '');
      return {
        id: this.encodeHelloSportsStreamId(stream),
        streamNo: index + 1,
        language: '',
        channelName: entry.channelName,
        hd: true,
        embedUrl: entry.embedUrl,
        contextUrl: HELLOSPORTS_4K_PAGE,
        helloSportsPostUrl: post.url,
        source: HELLOSPORTS_SOURCE,
        viewers: 0,
        highlightLabel: qualityLabel.includes('4k') || qualityLabel.includes('uhd')
          ? '4K Stream'
          : (qualityLabel.includes('1080') || qualityLabel.includes('fhd') ? 'FHD Stream' : 'HD Stream'),
        playbackProfile
      };
    });
  }

  isHelloSports4kPlaybackProfile(profile = null) {
    const quality = normalizeTitle(profile?.quality || '');
    const heightMatch = quality.match(/\b(\d{3,4})p?\b/u);
    const height = heightMatch ? Number.parseInt(heightMatch[1], 10) : 0;
    return quality.includes('4k') || quality.includes('uhd') || height >= 1080;
  }

  isMalayalamHelloSportsStream(stream = {}) {
    return /\bmalayal?am\b/iu.test(`${stream?.channelName || ''} ${stream?.language || ''} ${stream?.highlightLabel || ''}`);
  }

  isPlayableHelloSportsProfile(stream = {}, profile = null) {
    return this.isMalayalamHelloSportsStream(stream) || this.isHelloSports4kPlaybackProfile(profile);
  }

  getHelloSportsCardName(stream = {}, profile = null) {
    const quality = normalizeTitle(profile?.quality || stream?.playbackProfile?.quality || '');
    if (quality.includes('4k') || quality.includes('uhd')) return 'Nebula Sports 4K';
    return 'Nebula Sports FHD';
  }

  getStreamzy4kStreamsForMatch(match = {}) {
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED || !isFifaWorldCupMatch(match) || !isCurrentlyLiveMatch(match)) return [];
    return STREAMZY_4K_STREAMS.map((stream, index) => ({
      id: stream.id,
      streamNo: 1,
      language: stream.language,
      hd: true,
      embedUrl: stream.embedUrl,
      contextUrl: stream.embedUrl,
      source: STREAMZY_4K_SOURCE,
      viewers: 0,
      playbackProfile: {
        quality: index === 0 ? '4K' : 'UHD',
        speedMbps: 25
      }
    }));
  }

  getReplayZoneCachedHls(embedUrl = '') {
    const cached = this.replayZoneHlsCache.get(embedUrl);
    if (cached?.expiresAt > Date.now()) return cached.value;
    if (cached) this.replayZoneHlsCache.delete(embedUrl);
    return null;
  }

  setReplayZoneCachedHls(embedUrl = '', value = null) {
    if (!embedUrl || !value?.url) return;
    this.replayZoneHlsCache.set(embedUrl, {
      value,
      expiresAt: Date.now() + REPLAYZONE_HLS_CACHE_MS
    });
  }

  extractDailymotionVideoId(embedUrl = '') {
    try {
      const parsed = new URL(toString(embedUrl));
      const queryId = parsed.searchParams.get('video');
      if (queryId) return queryId;
      const match = parsed.pathname.match(/\/(?:video|embed\/video)\/([^/?#_]+)/iu);
      return match?.[1] || '';
    } catch {
      return '';
    }
  }

  async resolveDailymotionReplayHls(embedUrl = '', signal = null) {
    const videoId = this.extractDailymotionVideoId(embedUrl);
    if (!videoId) return null;
    const response = await this.fetchImpl(`https://www.dailymotion.com/player/metadata/video/${encodeURIComponent(videoId)}`, {
      signal,
      headers: {
        accept: 'application/json,text/plain,*/*',
        referer: 'https://www.dailymotion.com/',
        'user-agent': BROWSER_USER_AGENT
      }
    });
    if (!response.ok) throw new Error(`Dailymotion replay HTTP ${response.status}`);
    const payload = await response.json();
    const candidates = [
      ...(Array.isArray(payload?.qualities?.auto) ? payload.qualities.auto : []),
      ...Object.values(payload?.qualities || {}).flatMap((items) => Array.isArray(items) ? items : [])
    ];
    const hls = candidates.find((item) =>
      isHttpUrl(item?.url) && /(?:mpegurl|m3u8)/iu.test(`${item?.type || ''} ${item?.url || ''}`)
    );
    return hls?.url ? { url: hls.url, contextUrl: embedUrl } : null;
  }

  extractOkReplayHlsFromHtml(html = '') {
    try {
      const $ = loadHtml(html);
      const dataOptions = $('[data-module="OKVideo"]').attr('data-options');
      if (dataOptions) {
        const options = JSON.parse(dataOptions);
        const metadata = JSON.parse(toString(options?.flashvars?.metadata || '{}'));
        if (metadata?.hlsManifestUrl && isHttpUrl(metadata.hlsManifestUrl)) {
          return metadata.hlsManifestUrl;
        }
      }
    } catch {
      // Fallback regex handles escaped inline metadata.
    }
    const match = toString(html).match(/\\?"hlsManifestUrl\\?"\s*:\s*\\?"([^"\\]+(?:\\.[^"\\]*)*)\\?"/iu);
    if (!match?.[1]) return null;
    const decoded = match[1]
      .replace(/\\u0026/giu, '&')
      .replace(/\\\//gu, '/')
      .replace(/\\"/gu, '"');
    return isHttpUrl(decoded) ? decoded : null;
  }

  async resolveOkReplayHls(embedUrl = '', signal = null) {
    const response = await this.fetchImpl(embedUrl, {
      signal,
      headers: {
        ...this.getBrowserFetchHeaders(),
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        origin: 'https://ok.ru',
        referer: 'https://ok.ru/'
      }
    });
    if (!response.ok) throw new Error(`OK replay HTTP ${response.status}`);
    const html = await response.text();
    const url = this.extractOkReplayHlsFromHtml(html);
    return url ? { url, contextUrl: embedUrl } : null;
  }

  getReplayEmbedHost(embedUrl = '') {
    try {
      return new URL(toString(embedUrl)).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  async resolveReplayZoneEmbedHls(embed = {}, signal = null) {
    const embedUrl = toString(embed.embedUrl);
    if (!isHttpUrl(embedUrl)) return null;
    const cached = this.getReplayZoneCachedHls(embedUrl);
    if (cached?.url) return cached;
    const shared = await this.readSharedCache(`replay-hls:${embedUrl}`);
    if (shared?.url) {
      this.setReplayZoneCachedHls(embedUrl, shared);
      return shared;
    }
    const host = this.getReplayEmbedHost(embedUrl);
    let hls = null;
    if (host === 'ok.ru' || host.endsWith('.ok.ru')) {
      hls = await this.resolveOkReplayHls(embedUrl, signal);
    } else if (host === 'geo.dailymotion.com' || host.endsWith('.dailymotion.com')) {
      hls = await this.resolveDailymotionReplayHls(embedUrl, signal);
    }
    if (!hls?.url) return null;
    const headers = this.getPlaybackHeadersForSource(REPLAYZONE_SOURCE, embedUrl);
    const playbackProfile = await this.validateDirectHlsUrl(hls.url, signal, headers);
    const value = {
      url: hls.url,
      contextUrl: hls.contextUrl || embedUrl,
      headers,
      playbackProfile,
      resolveOnPlayback: this.requiresBrowserHlsContext(hls.url)
    };
    this.setReplayZoneCachedHls(embedUrl, value);
    await this.writeSharedCache(`replay-hls:${embedUrl}`, value, REPLAYZONE_HLS_CACHE_MS).catch(() => {});
    return value;
  }

  async getReplayZoneStreams(match, { baseUrl = '', privateConfigId = '', signal = null } = {}) {
    if (!baseUrl || !privateConfigId || !match?.replay) return [];
    const cards = [];
    for (const source of (Array.isArray(match.sources) ? match.sources : [])) {
      if (cards.length >= REPLAYZONE_MAX_CARDS || signal?.aborted) break;
      try {
        const hls = await this.resolveReplayZoneEmbedHls(source, signal);
        if (!hls?.url) continue;
        const streamCard = {
          id: source.id,
          source: REPLAYZONE_SOURCE,
          streamNo: source.streamNo || 1,
          language: '',
          hd: true,
          playbackProfile: hls.playbackProfile
        };
        const privateUrl = this.getPrivateStreamUrl(streamCard, { baseUrl, privateConfigId });
        if (!privateUrl) continue;
        cards.push({
          name: 'Nebula Sports Replay',
          title: [
            toString(source.label) || 'Replay',
            this.buildPlaybackCardTitle(streamCard, hls)
          ].filter(Boolean).join('\n'),
          url: [
            `${privateUrl}?url=${Buffer.from(hls.url).toString('base64url')}`,
            hls.contextUrl ? `ctx=${Buffer.from(hls.contextUrl).toString('base64url')}` : ''
          ].filter(Boolean).join('&'),
          behaviorHints: {
            bingeGroup: `replay-${match.sourceId || match.normalizedTitle}`
          }
        });
      } catch (error) {
        this.logger.debug?.('ReplayZone HLS resolve failed', {
          replay: match.sourceId || match.title,
          source: source.embedUrl,
          error: error?.message || String(error)
        });
      }
    }
    return cards;
  }

  async getEventStreams(id, options = null) {
    const signal = options && typeof options === 'object' && 'signal' in options
      ? options.signal
      : options || null;
    const baseUrl = options?.baseUrl || '';
    const privateConfigId = options?.privateConfigId || '';
    const prewarm = options?.prewarm !== false;
    const includeQuotaSources = options?.includeQuotaSources === true;
    const match = await this.findMatch(id, signal);
    if (!match) return [];
    if (match.replay) {
      return this.getReplayZoneStreams(match, {
        baseUrl,
        privateConfigId,
        signal
      });
    }

    const hasCdnLiveTvSource = Array.isArray(match.sources)
      && match.sources.some((source) => normalizeIdPart(source?.source) === CDNLIVETV_SOURCE);
    const dlhdSources = hasCdnLiveTvSource ? [] : await this.getDlhdSourcesForMatch(match, signal).catch((error) => {
      this.logger.debug?.('dlhd event match failed', {
        match: match.sourceId || match.id,
        error: error?.message || String(error)
      });
      return [];
    });
    const eventSources = [...this.filterSupplementalSources(match.sources), ...dlhdSources];
    const cdnSources = eventSources.filter((source) => normalizeIdPart(source?.source) === CDNLIVETV_SOURCE);
    const deferredCdnStreams = cdnSources
      .map((source) => {
        const channel = this.decodeCdnLiveTvSourceId(source.id) || {};
        const channelName = toString(channel.name) || 'Live TV';
        return {
          id: toString(source.id),
          streamNo: 1,
          channelName,
          language: '',
          hd: true,
          embedUrl: toString(channel.url),
          contextUrl: toString(channel.url),
          source: CDNLIVETV_SOURCE,
          viewers: Number(channel.viewers || 0),
          playbackProfile: {
            quality: 'HD',
            speedMbps: 8
          },
          resolveOnPlaybackOnly: true
        };
      })
      .filter((stream) => stream.id);
    const collectedStreams = await this.collectEventSourceStreams(
      eventSources.filter((source) => normalizeIdPart(source?.source) !== CDNLIVETV_SOURCE),
      signal
    );
    const rexdexStreams = await this.getRexDexStreamsForMatch(match, signal).catch((error) => {
      this.logger.debug?.('rexdex event match failed', {
        match: match.sourceId || match.id,
        error: error?.message || String(error)
      });
      return [];
    });
    const rankedStreams = [
      ...this.getStreamzy4kStreamsForMatch(match),
      ...this.getTemporaryEventDirectStreams(match),
      ...deferredCdnStreams,
      ...rexdexStreams,
      ...collectedStreams
    ].sort(compareStreamsBySourceRank);
    const streams = rankedStreams.slice(0, 12);
    const playableHlsByKey = new Map();
    let displayStreams = streams;
    const externalCardsPromise = SUPPLEMENTAL_SPORTS_SOURCES_ENABLED && isFifaWorldCupMatch(match)
      ? Promise.all([
        this.getPlayableLicensedExternalCards(match, { baseUrl, signal }),
        includeQuotaSources
          ? this.getPlayableKnownSportsCards(match, { signal })
          : Promise.resolve([]),
        includeQuotaSources
          ? this.getPlayableHelloSports4kCards(match, { baseUrl, privateConfigId, signal })
          : Promise.resolve([]),
        includeQuotaSources
          ? this.getPlayableSportSrcCards(match, { baseUrl, privateConfigId, signal })
          : Promise.resolve([]),
        includeQuotaSources
          ? this.getPlayableRapidFootballCards(match, { baseUrl, privateConfigId, signal })
          : Promise.resolve([]),
      ]).then((groups) => groups.flat())
      : Promise.resolve([]);
    if (baseUrl && privateConfigId) {
      const playableKeys = new Set();
      const playbackOnlyResults = await this.getPlaybackOnlyHlsResults(rankedStreams, playableKeys, signal);
      const directHlsCandidates = this.getTrustedDirectHlsResults(rankedStreams, playableKeys);
      const directHlsResults = await this.validateTrustedDirectHlsResults(directHlsCandidates, signal, {
        totalBudgetMs: STREAM_DIRECT_HLS_FAST_VALIDATION_MS
      });
      const validationStreams = (this.hlsProbeEnabled || this.hlsBrowserFallbackEnabled)
        ? this.getStreamValidationCandidates(rankedStreams.filter((stream) => {
          const sourceKey = normalizeIdPart(stream?.source);
          const streamNo = stream?.streamNo || 1;
          return !playableKeys.has(`${sourceKey}:${toString(stream?.id)}:${toString(streamNo)}`);
        }))
        : [];
      const needsStreamedProbeBudget = validationStreams.some((stream) =>
        ['admin', 'delta', 'echo', 'golf', 'nebulasports', STREAMZY_4K_SOURCE, REXDEX_SOURCE, HELLOSPORTS_SOURCE].includes(normalizeIdPart(stream?.source))
      );
      const validationBudgetMs = directHlsResults.length && !needsStreamedProbeBudget
        ? STREAM_DIRECT_HLS_FAST_VALIDATION_MS
        : STREAM_VALIDATION_TOTAL_BUDGET_MS;
      const playableSettled = await this.collectPlayableValidatedHls(validationStreams, signal, {
        totalBudgetMs: validationBudgetMs
      });
      const playableResults = playableSettled
        .filter((result) => result?.hls?.url);
      for (const result of playableResults) {
        const streamNo = result.stream?.streamNo || 1;
          playableKeys.add(`${normalizeIdPart(result.stream?.source)}:${toString(result.stream?.id)}:${toString(streamNo)}`);
      }
      displayStreams = [...playbackOnlyResults, ...directHlsResults, ...playableResults]
        .sort((left, right) => this.comparePlayableHlsResults(left, right))
        .map((result) => {
          const { stream, hls } = result;
          playableHlsByKey.set(`${stream.source}:${stream.id}:${stream.streamNo || 1}`, hls);
          return stream;
        })
        .slice(0, 12);
    }
    const temporaryUnavailableCard = cdnSources.length
      && baseUrl
      && !displayStreams.some((stream) => normalizeIdPart(stream?.source) === CDNLIVETV_SOURCE)
      ? {
        source: CDNLIVETV_SOURCE,
        name: 'Nebula Sports',
        title: [
          'More streams will be available soon',
          'Some live streams are temporarily unavailable',
          'Check again shortly'
        ].join('\n'),
        externalUrl: `${String(baseUrl).replace(/\/+$/u, '')}/sports`,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `streamed-temporary-${match.normalizedTitle}`
        }
      }
      : null;
    const cards = displayStreams.map((stream) => {
        const hls = playableHlsByKey.get(`${stream.source}:${stream.id}:${stream.streamNo || 1}`);
        const privateUrl = this.getPrivateStreamUrl(stream, { baseUrl, privateConfigId });
        const directPlaybackUrl = hls?.directPlayback ? hls.url : '';
        const playbackUrl = directPlaybackUrl || (privateUrl && hls?.url
          ? (hls.resolveOnPlayback
            ? privateUrl
            : [
            `${privateUrl}?url=${Buffer.from(hls.url).toString('base64url')}`,
            hls.contextUrl ? `ctx=${Buffer.from(hls.contextUrl).toString('base64url')}` : ''
          ].filter(Boolean).join('&'))
          : null);
        if (!playbackUrl) return null;
        const sourceLabel = this.formatStreamSourceLabel(stream?.source);
        return {
          name: sourceLabel ? `NebulaStreams ${sourceLabel}` : 'NebulaStreams Streamed',
          title: this.buildPlaybackCardTitle(stream, hls),
          url: playbackUrl,
          behaviorHints: {
            bingeGroup: `streamed-${match.normalizedTitle}`,
            ...(directPlaybackUrl
              ? {
                notWebReady: false,
                ...(hls.headers ? { proxyHeaders: { request: hls.headers } } : {})
              }
              : {})
          }
	        };
	      }).filter(Boolean);
    const externalCards = await externalCardsPromise;
    const helloSportsCards = externalCards.filter((card) =>
      card?.name === 'Nebula Sports 4K' || card?.name === 'Nebula Sports FHD' || card?.name === 'Nebula Sports Malayalam'
    );
    const knownSportsCards = externalCards.filter((card) => card?.name === 'Nebula Sports Fast');
    const rapidFootballCards = externalCards.filter((card) => card?.name === 'NebulaStreams Football API');
    const otherExternalCards = externalCards.filter((card) =>
      card?.name !== 'Nebula Sports 4K'
        && card?.name !== 'Nebula Sports FHD'
        && card?.name !== 'Nebula Sports Malayalam'
        && card?.name !== 'Nebula Sports Fast'
        && card?.name !== 'NebulaStreams Football API'
    );
    if (prewarm && baseUrl && privateConfigId && this.hlsCacheMs > 0) {
      this.prewarmStreams(this.getStreamValidationCandidates(rankedStreams).slice(0, 2));
    }
    return [
      ...rapidFootballCards,
      ...helloSportsCards,
      ...knownSportsCards,
      ...cards.slice(0, 2),
      ...(temporaryUnavailableCard ? [temporaryUnavailableCard] : []),
      ...otherExternalCards,
      ...cards.slice(2)
    ];
  }

  getEmbedUrl({ source, streamId, streamNo }) {
    if (normalizeIdPart(source) === STREAMZY_4K_SOURCE) {
      return this.getStreamzy4kStreamById(streamId)?.embedUrl || `${STREAMZY_4K_ORIGIN}/embed/${encodeURIComponent(toString(streamId))}`;
    }
    if (normalizeIdPart(source) === REXDEX_SOURCE) {
      return this.decodeRexDexStreamId(streamId) || `${REXDEX_ORIGIN}/`;
    }
    if (normalizeIdPart(source) === HELLOSPORTS_SOURCE) {
      return this.decodeHelloSportsStreamId(streamId)?.url || HELLOSPORTS_4K_PAGE;
    }
    return `${EMBED_BASE}/embed/${encodeURIComponent(source)}/${encodeURIComponent(streamId)}/${encodeURIComponent(String(streamNo || 1))}`;
  }

  getStreamValidationCandidates(streams = []) {
    const sourceBuckets = new Map();
    const sourceOrder = [];
    const sourcePriority = (source) => {
      const normalized = normalizeIdPart(source);
      return getStreamSourceRank(normalized);
    };
    const sorted = streams.slice().sort((left, right) => {
      const leftPriority = sourcePriority(left.source);
      const rightPriority = sourcePriority(right.source);
      return leftPriority - rightPriority
        || Number(right.hd) - Number(left.hd)
        || Number(right.viewers || 0) - Number(left.viewers || 0);
    });
    for (const stream of sorted) {
      const sourceKey = normalizeIdPart(stream.source);
      if (!sourceBuckets.has(sourceKey)) {
        sourceBuckets.set(sourceKey, []);
        sourceOrder.push(sourceKey);
      }
      const bucket = sourceBuckets.get(sourceKey);
      if (bucket.length < STREAM_VALIDATION_MAX_PER_SOURCE) {
        bucket.push(stream);
      }
    }

    const candidates = [];
    let index = 0;
    while (candidates.length < STREAM_VALIDATION_MAX_CANDIDATES) {
      let added = false;
      for (const sourceKey of sourceOrder) {
        const stream = sourceBuckets.get(sourceKey)?.[index];
        if (!stream) continue;
        candidates.push(stream);
        added = true;
        if (candidates.length >= STREAM_VALIDATION_MAX_CANDIDATES) break;
      }
      if (!added) break;
      index += 1;
    }
    return candidates;
  }

  getTrustedDirectHlsResults(streams = [], existingKeys = new Set()) {
    const trustedSources = new Set([FLIX_DLSTREAMS_SOURCE, CDNLIVETV_SOURCE, SPORTSBITE_SOURCE, STREAMFREE_SOURCE, REXDEX_SOURCE, 'sportzx']);
    const sourceCounts = new Map();
    const results = [];
    for (const stream of streams) {
      const sourceKey = normalizeIdPart(stream?.source);
      if (!trustedSources.has(sourceKey)) continue;
      const streamNo = stream.streamNo || 1;
      const cacheKey = `${sourceKey}:${toString(stream.id)}:${toString(streamNo)}`;
      if (existingKeys.has(cacheKey)) continue;
      if (!isTrustedDirectPlaylistUrl(sourceKey, stream.directHlsUrl)) continue;
      const sourceCount = sourceCounts.get(sourceKey) || 0;
      if (sourceCount >= STREAM_VALIDATION_MAX_PER_SOURCE) continue;
      sourceCounts.set(sourceKey, sourceCount + 1);
      existingKeys.add(cacheKey);
      results.push({
        stream,
        hls: {
          url: stream.directHlsUrl,
          contextUrl: stream.contextUrl || stream.embedUrl,
          headers: stream.headers || this.getBrowserFetchHeaders(),
          directPlayback: sourceKey === 'sportzx',
          resolveOnPlayback: this.shouldResolveDirectHlsOnPlayback(stream.source),
          playbackProfile: stream.playbackProfile || this.inferStreamPlaybackProfile(stream)
        }
      });
    }
    return results;
  }

  async getPlaybackOnlyHlsResults(streams = [], existingKeys = new Set(), signal = null) {
    const results = [];
    for (const stream of streams) {
      const sourceKey = normalizeIdPart(stream?.source);
      if (sourceKey !== CDNLIVETV_SOURCE || !stream?.resolveOnPlaybackOnly) continue;
      const streamNo = stream.streamNo || 1;
      const cacheKey = `${sourceKey}:${toString(stream.id)}:${toString(streamNo)}`;
      if (existingKeys.has(cacheKey)) continue;
      existingKeys.add(cacheKey);
      try {
        const hls = await this.resolveCdnLiveTvChannel(stream.id, signal);
        if (!hls?.url) continue;
        results.push({
          stream,
          hls: {
            ...hls,
            directPlayback: false,
            resolveOnPlayback: true,
            playbackProfile: hls.playbackProfile || stream.playbackProfile || this.inferStreamPlaybackProfile(stream)
          }
        });
      } catch (error) {
        this.logger.debug?.('CDNLiveTV direct stream card resolve failed', {
          error: error?.message || String(error)
        });
      }
    }
    return results;
  }

  getPlayableResultMeasuredMbps(result = {}) {
    return Number(
      result?.hls?.playbackProfile?.measuredMbps
      || result?.hls?.segmentProbe?.measuredMbps
      || 0
    ) || 0;
  }

  comparePlayableHlsResults(left = {}, right = {}) {
    return compareStreamsBySourceRank(left.stream || {}, right.stream || {})
      || this.getPlayableResultMeasuredMbps(right) - this.getPlayableResultMeasuredMbps(left)
      || Number(right?.stream?.hd) - Number(left?.stream?.hd)
      || Number(right?.stream?.viewers || 0) - Number(left?.stream?.viewers || 0);
  }

  async validateTrustedDirectHlsResults(results = [], signal = null, { totalBudgetMs = STREAM_DIRECT_HLS_FAST_VALIDATION_MS } = {}) {
    const candidates = Array.isArray(results)
      ? results.filter((result) => result?.hls?.url && result.hls.url !== 'resolve-on-playback')
      : [];
    const passthrough = Array.isArray(results)
      ? results.filter((result) => result?.hls?.url === 'resolve-on-playback')
      : [];
    if (!candidates.length) return passthrough;

    const controller = new AbortController();
    const combinedSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const budgetMs = Math.max(750, Number(totalBudgetMs) || STREAM_DIRECT_HLS_FAST_VALIDATION_MS);
    const deadlineAt = Date.now() + budgetMs;
    const timeout = setTimeout(() => controller.abort(new Error('Direct HLS segment validation budget expired')), budgetMs);
    timeout.unref?.();

    const playable = [...passthrough];
    const pending = new Set();
    for (const result of candidates) {
      let wrapped;
      wrapped = this.validateDirectHlsUrl(result.hls.url, combinedSignal, result.hls.headers, {
        timeoutMs: Math.min(4_000, Math.max(1_000, budgetMs)),
        probeSegments: true
      })
        .then((playbackProfile) => ({
          ok: true,
          value: {
            ...result,
            hls: {
              ...result.hls,
              playbackProfile: playbackProfile || result.hls.playbackProfile || result.stream?.playbackProfile
            }
          },
          task: wrapped
        }))
        .catch((error) => ({ ok: false, error, result, task: wrapped }));
      pending.add(wrapped);
    }

    try {
      while (pending.size > 0 && !combinedSignal.aborted) {
        const remainingMs = Math.max(0, deadlineAt - Date.now());
        if (remainingMs <= 0) break;
        const raced = await Promise.race([
          ...pending,
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), Math.max(1, remainingMs));
            timer.unref?.();
          })
        ]);
        if (!raced) break;
        pending.delete(raced.task);
        if (raced.ok && raced.value?.hls?.url) {
          playable.push(raced.value);
        } else {
          this.logger.debug?.('trusted direct hls segment probe failed', {
            source: raced?.result?.stream?.source,
            streamNo: raced?.result?.stream?.streamNo,
            error: raced?.error?.message || String(raced?.error || '')
          });
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort(new Error('Direct HLS segment validation complete'));
    }

    return playable;
  }

  shouldResolveDirectHlsOnPlayback(source = '') {
    return [FLIX_DLSTREAMS_SOURCE, CDNLIVETV_SOURCE, SPORTSBITE_SOURCE, STREAMFREE_SOURCE, REXDEX_SOURCE].includes(normalizeIdPart(source));
  }

  async collectPlayableValidatedHls(streams = [], signal = null, { totalBudgetMs = STREAM_VALIDATION_TOTAL_BUDGET_MS } = {}) {
    if (!streams.length) return [];
    const controller = new AbortController();
    const combinedSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const budgetMs = Math.max(500, Number(totalBudgetMs) || STREAM_VALIDATION_TOTAL_BUDGET_MS);
    const deadlineAt = Date.now() + budgetMs;
    const timeout = setTimeout(() => controller.abort(new Error('Streamed sports validation budget expired')), budgetMs);
    timeout.unref?.();

    const playable = [];
    const remainingStreams = [];
    for (const stream of streams) {
      const sourceKey = normalizeIdPart(stream.source);
      const streamNo = stream.streamNo || 1;
      const cacheKey = `${sourceKey}:${toString(stream.id)}:${toString(streamNo)}`;
      const cachedHls = this.getCachedHls(cacheKey) || await this.getSharedHls(cacheKey);
      if (cachedHls?.url) {
        this.setCachedHls(cacheKey, cachedHls);
        playable.push({ stream, hls: cachedHls });
      } else {
        remainingStreams.push(stream);
      }
    }
    if (!remainingStreams.length) {
      controller.abort(new Error('Streamed sports validation cache hit'));
      clearTimeout(timeout);
      return playable.slice(0, 12);
    }
    const targetSourceKeys = new Set(streams.map((stream) => normalizeIdPart(stream?.source)));
    const playableSourceKeys = new Set(playable.map((result) => normalizeIdPart(result?.stream?.source)));

    const pending = new Set();
    for (const stream of remainingStreams) {
      let wrapped;
      wrapped = this.validateStreamPlayableHls(stream, combinedSignal, {
        allowBrowserFallback: false
      })
        .then((value) => ({ ok: true, value, task: wrapped }))
        .catch((error) => ({ ok: false, error, stream, task: wrapped }));
      pending.add(wrapped);
    }

    try {
      while (pending.size > 0 && !combinedSignal.aborted) {
        const remainingMs = Math.max(0, deadlineAt - Date.now());
        if (remainingMs <= 0) break;
        const raced = await Promise.race([
          ...pending,
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), Math.max(1, remainingMs));
            timer.unref?.();
          })
        ]);
        if (!raced) break;
        pending.delete(raced.task);
        if (raced.ok && raced.value?.hls?.url) {
          playable.push(raced.value);
          playableSourceKeys.add(normalizeIdPart(raced.value?.stream?.source));
          if ([...targetSourceKeys].every((sourceKey) => playableSourceKeys.has(sourceKey))) break;
          if (playable.length >= 12) break;
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort(new Error('Streamed sports validation complete'));
    }
    return playable;
  }

  async collectPlayableBrowserFallbackHls(streams = [], signal = null) {
    const candidates = streams.slice(0, STREAM_BROWSER_FALLBACK_MAX_CANDIDATES);
    if (!candidates.length) return [];
    const fallbackSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, AbortSignal.timeout(STREAM_BROWSER_FALLBACK_TOTAL_BUDGET_MS)])
      : AbortSignal.timeout(STREAM_BROWSER_FALLBACK_TOTAL_BUDGET_MS);
    const playable = [];
    for (const stream of candidates) {
      if (fallbackSignal.aborted) break;
      try {
        const result = await this.validateStreamPlayableHlsWithBrowserFallback(stream, fallbackSignal);
        if (result?.hls?.url) {
          playable.push(result);
          break;
        }
      } catch (error) {
        this.logger.debug?.('streamed sports browser fallback validation failed', {
          source: stream?.source,
          streamNo: stream?.streamNo,
          error: error?.message || String(error)
        });
      }
    }
    return playable;
  }

  async validateStreamPlayableHls(stream, signal = null, { allowBrowserFallback = true } = {}) {
    const validationSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, AbortSignal.timeout(STREAM_VALIDATION_CANDIDATE_TIMEOUT_MS)])
      : AbortSignal.timeout(STREAM_VALIDATION_CANDIDATE_TIMEOUT_MS);
    const sourceKey = normalizeIdPart(stream.source);
    const streamNo = stream.streamNo || 1;
    const embedUrl = this.getEmbedUrl({
      source: stream.source,
      streamId: stream.id,
      streamNo
    });
    const cacheKey = `${sourceKey}:${toString(stream.id)}:${toString(streamNo)}`;
    let hls = null;

    hls = this.getCachedHls(cacheKey) || await this.getSharedHls(cacheKey);
    if (!hls) {
      if (stream.directHlsUrl && isHttpUrl(stream.directHlsUrl)) {
        hls = {
          url: stream.directHlsUrl,
          contextUrl: stream.contextUrl || embedUrl,
          headers: stream.headers || this.getPlaybackHeadersForSource(sourceKey, stream.contextUrl || embedUrl),
          resolveOnPlayback: this.shouldResolveDirectHlsOnPlayback(stream.source)
        };
      }
      if (!hls && sourceKey === HELLOSPORTS_SOURCE) {
        hls = await this.resolveHelloSportsEmbedHls(embedUrl, validationSignal);
      }
      if (!hls) {
        const probed = await this.resolvePlayableHlsWithProbe(embedUrl, validationSignal);
        if (probed?.url) {
          const probedHlsUrl = extractDirectHlsUrl(probed.url) || probed.url;
          hls = {
            url: probedHlsUrl,
            contextUrl: embedUrl,
            headers: this.getProbedHlsHeadersForSource(sourceKey, embedUrl),
            resolveOnPlayback: this.requiresBrowserHlsContext(probedHlsUrl)
          };
        } else if (allowBrowserFallback && this.hlsBrowserFallbackEnabled) {
          const hlsUrl = await this.resolvePlayableHlsInBrowser(embedUrl, {
            source: sourceKey,
            streamNo,
            signal: validationSignal
          });
          hls = {
            url: hlsUrl,
            contextUrl: embedUrl,
            headers: this.getPlaybackHeadersForSource(sourceKey, embedUrl),
            resolveOnPlayback: this.requiresBrowserHlsContext(hlsUrl)
          };
        } else {
          throw new Error('Streamed HLS probe found no playable source');
        }
      }
    }

    try {
      if (hls.resolveOnPlayback && this.requiresBrowserHlsContext(hls.url)) {
        hls.playbackProfile = hls.playbackProfile || this.inferStreamPlaybackProfile(stream);
        this.setCachedHls(cacheKey, hls);
        await this.setSharedHls(cacheKey, hls);
        return { stream, hls };
      }
      const playbackProfile = this.requiresBrowserHlsContext(hls.url)
        ? await this.validateBrowserContextHlsUrl(hls.url, {
          signal: validationSignal,
          contextUrl: hls.contextUrl
        })
        : await this.validateDirectHlsUrl(hls.url, validationSignal, hls.headers);
      if (playbackProfile && typeof playbackProfile === 'object') {
        hls.playbackProfile = playbackProfile;
      }
      hls.playbackProfile = hls.playbackProfile || stream.playbackProfile || this.inferStreamPlaybackProfile(stream);
      if (sourceKey === REXDEX_SOURCE && !this.isRexDexHighQualityPlaybackProfile(hls.playbackProfile)) {
        throw new Error('RexDex HLS below 1080p');
      }
      this.setCachedHls(cacheKey, hls);
      await this.setSharedHls(cacheKey, hls);
      return { stream, hls };
    } catch (error) {
      this.deleteCachedHls(cacheKey);
      await this.deleteSharedCache(`hls:${cacheKey}`).catch(() => {});
      throw error;
    }
  }

  async validateStreamPlayableHlsWithBrowserFallback(stream, signal = null) {
    const validationSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, AbortSignal.timeout(STREAM_VALIDATION_CANDIDATE_TIMEOUT_MS)])
      : AbortSignal.timeout(STREAM_VALIDATION_CANDIDATE_TIMEOUT_MS);
    const sourceKey = normalizeIdPart(stream.source);
    const streamNo = stream.streamNo || 1;
    const embedUrl = this.getEmbedUrl({
      source: stream.source,
      streamId: stream.id,
      streamNo
    });
    const cacheKey = `${sourceKey}:${toString(stream.id)}:${toString(streamNo)}`;
    const hlsUrl = await this.resolvePlayableHlsInBrowser(embedUrl, {
      source: sourceKey,
      streamNo,
      signal: validationSignal
    });
    const hls = {
      url: hlsUrl,
      contextUrl: embedUrl,
      headers: this.getPlaybackHeadersForSource(sourceKey, embedUrl),
      resolveOnPlayback: this.requiresBrowserHlsContext(hlsUrl)
    };

    const cachedPlaylist = this.getCachedPlaylist(hlsUrl);
    if (cachedPlaylist?.body?.toString('utf8').includes('#EXTM3U')) {
      hls.playbackProfile = this.extractHlsPlaybackProfile(cachedPlaylist.body.toString('utf8')) || undefined;
      hls.playbackProfile = hls.playbackProfile || stream.playbackProfile || this.inferStreamPlaybackProfile(stream);
      if (sourceKey === REXDEX_SOURCE && !this.isRexDexHighQualityPlaybackProfile(hls.playbackProfile)) {
        throw new Error('RexDex HLS below 1080p');
      }
      this.setCachedHls(cacheKey, hls);
      await this.setSharedHls(cacheKey, hls);
      return { stream, hls };
    }
    const playlist = await this.browserFetchBytes(hlsUrl, {
      signal: validationSignal,
      cachePlaylist: true,
      contextUrl: embedUrl
    });
    const playlistText = playlist.body?.toString('utf8') || '';
    if (!playlistText.includes('#EXTM3U')) {
      throw new Error('Streamed HLS playlist is not playable');
    }
    hls.playbackProfile = this.extractHlsPlaybackProfile(playlistText) || undefined;
    hls.playbackProfile = hls.playbackProfile || stream.playbackProfile || this.inferStreamPlaybackProfile(stream);
    if (sourceKey === REXDEX_SOURCE && !this.isRexDexHighQualityPlaybackProfile(hls.playbackProfile)) {
      throw new Error('RexDex HLS below 1080p');
    }
    this.setCachedHls(cacheKey, hls);
    await this.setSharedHls(cacheKey, hls);
    return { stream, hls };
  }

  getCachedHls(cacheKey) {
    const cached = this.hlsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (!this.shouldCacheHlsValue(cacheKey, cached.value)) {
        this.hlsCache.delete(cacheKey);
        return null;
      }
      if (this.requiresBrowserHlsContext(cached.value?.url) && !cached.value?.resolveOnPlayback && !this.getCachedPlaylist(cached.value.url)) {
        this.hlsCache.delete(cacheKey);
        return null;
      }
      return cached.value;
    }
    if (cached) this.hlsCache.delete(cacheKey);
    return null;
  }

  setCachedHls(cacheKey, value) {
    if (!this.hlsCacheMs || !value) return;
    if (!this.shouldCacheHlsValue(cacheKey, value)) return;
    this.hlsCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + this.hlsCacheMs
    });
  }

  deleteCachedHls(cacheKey) {
    if (!cacheKey) return;
    this.hlsCache.delete(cacheKey);
  }

  async getSharedHls(cacheKey) {
    const value = await this.readSharedCache(`hls:${cacheKey}`);
    return value?.url ? value : null;
  }

  async setSharedHls(cacheKey, value) {
    if (!this.hlsCacheMs || !value?.url) return;
    if (!this.shouldCacheHlsValue(cacheKey, value)) return;
    await this.writeSharedCache(`hls:${cacheKey}`, value, this.hlsCacheMs).catch(() => {});
  }

  shouldCacheHlsValue(cacheKey = '', value = {}) {
    const sourceKey = normalizeIdPart(toString(cacheKey).split(':')[0]);
    if (sourceKey === CDNLIVETV_SOURCE) return false;
    if (!value?.url) return false;
    return !this.isLikelySignedHlsUrl(value.url);
  }

  isLikelySignedHlsUrl(url = '') {
    try {
      const parsed = new URL(toString(url));
      const signedKeys = new Set([
        'token',
        'expires',
        'expire',
        'expiry',
        'exp',
        'sig',
        'signature',
        'auth',
        'hmac',
        'md5',
        'hdntl',
        'hdnts',
        'policy',
        'key',
        'st',
        'e'
      ]);
      for (const key of parsed.searchParams.keys()) {
        if (signedKeys.has(key.toLowerCase())) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  getCachedPlaylist(url) {
    const cached = this.playlistCache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    if (cached) this.playlistCache.delete(url);
    return null;
  }

  setCachedPlaylist(url, value) {
    if (!url || !value?.body) return;
    this.playlistCache.set(url, {
      value,
      expiresAt: Date.now() + DEFAULT_PLAYLIST_CACHE_MS
    });
  }

  getCachedMedia(url) {
    const cached = this.mediaCache.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.deleteCachedMedia(url);
    return null;
  }

  setCachedMedia(url, value) {
    const size = value?.body?.length || 0;
    if (!url || !size || size > MAX_MEDIA_CACHE_ENTRY_BYTES) return;
    this.deleteCachedMedia(url);
    this.mediaCache.set(url, {
      value,
      size,
      expiresAt: Date.now() + DEFAULT_MEDIA_CACHE_MS
    });
    this.mediaCacheBytes += size;
    while (this.mediaCacheBytes > MAX_MEDIA_CACHE_BYTES && this.mediaCache.size) {
      this.deleteCachedMedia(this.mediaCache.keys().next().value);
    }
  }

  deleteCachedMedia(url) {
    const cached = this.mediaCache.get(url);
    if (!cached) return;
    this.mediaCacheBytes = Math.max(0, this.mediaCacheBytes - (cached.size || 0));
    this.mediaCache.delete(url);
  }

  async getSharedPlaylist(url) {
    const value = await this.readSharedCache(`playlist:${url}`, { consume: true });
    if (!value?.bodyBase64) return null;
    return {
      status: value.status || 200,
      url: value.url || url,
      headers: value.headers || {},
      body: Buffer.from(value.bodyBase64, 'base64')
    };
  }

  async setSharedPlaylist(url, value) {
    if (!url || !value?.body) return;
    await this.writeSharedCache(`playlist:${url}`, {
      status: value.status || 200,
      url: value.url || url,
      headers: value.headers || {},
      bodyBase64: Buffer.from(value.body).toString('base64')
    }, DEFAULT_PLAYLIST_CACHE_MS).catch(() => {});
  }

  async validateDirectHlsUrl(url, signal = null, headers = null, { probeSegments = true, timeoutMs = 4_000 } = {}) {
    const fetchedPlaylist = await this.fetchHlsPlaylistText(url, signal, headers, timeoutMs);
    const text = fetchedPlaylist.text;
    const fetched = {
      status: fetchedPlaylist.status,
      url: fetchedPlaylist.url || url,
      headers: fetchedPlaylist.headers,
      body: Buffer.from(text)
    };
    this.setCachedPlaylist(url, fetched);
    await this.setSharedPlaylist(url, fetched);
    const playbackProfile = this.extractHlsPlaybackProfile(text) || {};
    if (probeSegments) {
      const segmentProbe = await this.probeHlsMediaSegment(fetched.url || url, text, signal, headers);
      playbackProfile.measuredMbps = segmentProbe.measuredMbps;
      playbackProfile.segmentProbeMs = segmentProbe.durationMs;
    }
    return Object.keys(playbackProfile).length ? playbackProfile : null;
  }

  async validateBrowserContextHlsUrl(url, { signal = null, contextUrl = '' } = {}) {
    const fetched = await this.browserFetchBytes(url, {
      signal,
      cachePlaylist: true,
      contextUrl
    });
    const text = fetched.body?.toString('utf8') || '';
    if (!text.includes('#EXTM3U')) {
      throw new Error('Streamed browser HLS playlist is not playable');
    }
    return this.extractHlsPlaybackProfile(text);
  }

  async handleMemoryPressure({ critical = false } = {}) {
    this.matchesCache.clear();
    this.streamCache.clear();
    this.dlhdScheduleCache = null;
    this.dlhdChannelsCache = null;
    this.dlhdHlsCache.clear();
    this.dlhdHlsInFlight.clear();
    this.hlsCache.clear();
    this.playlistCache.clear();
    this.mediaCache.clear();
    this.mediaCacheBytes = 0;
    this.browserFetchInFlight.clear();
    this.hlsResolveInFlight.clear();
    this.playlistPrewarmInFlight.clear();
    this.cdnLiveTvHealthCache.clear();
    this.cdnLiveTvHealthInFlight.clear();
    this.liveStreamPrewarmInFlight = null;
    if (!critical) {
      await Promise.allSettled([
        this.closeBrowserFetchPage('memory pressure'),
        this.closeHlsResolvePage('memory pressure')
      ]).then((settled) => {
        for (const result of settled) {
          if (result.status === 'rejected') {
            this.logger.warn?.('streamed sports browser page memory cleanup failed', {
              error: result.reason?.message || String(result.reason)
            });
          }
        }
      });
      return;
    }
    await this.closeBrowser('memory pressure').catch((error) => {
      this.logger.warn?.('streamed sports browser memory cleanup failed', {
        error: error?.message || String(error)
      });
    });
  }

  async ensureCacheDir() {
    if (!this.cacheDirReady) {
      this.cacheDirReady = fs.mkdir(this.cacheDir, { recursive: true });
    }
    await this.cacheDirReady;
  }

  getCachePath(key) {
    const hash = createHash('sha1').update(String(key)).digest('hex');
    return path.join(this.cacheDir, `${hash}.json`);
  }

  async readSharedCache(key, { consume = false, allowStale = false, staleTtlMs = 0 } = {}) {
    const filePath = this.getCachePath(key);
    try {
      const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!payload?.expiresAt || payload.expiresAt <= Date.now()) {
        const staleUntil = Number(payload?.expiresAt || 0) + Math.max(0, Number(staleTtlMs || 0));
        if (allowStale && payload?.value && (!staleTtlMs || staleUntil > Date.now())) return payload.value;
        await fs.rm(filePath, { force: true }).catch(() => {});
        return null;
      }
      if (consume) {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
      return payload.value || null;
    } catch {
      return null;
    }
  }

  async writeSharedCache(key, value, ttlMs) {
    if (!ttlMs || !value) return;
    await this.ensureCacheDir();
    const filePath = this.getCachePath(key);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify({
      expiresAt: Date.now() + ttlMs,
      value
    }), { mode: 0o600 });
    await fs.rename(tempPath, filePath);
  }

  async deleteSharedCache(key) {
    if (!key) return;
    await fs.rm(this.getCachePath(key), { force: true });
  }

  prewarmStreams(streams = []) {
    if (!Array.isArray(streams) || !streams.length || this.hlsCacheMs <= 0) return;
    if (!this.hlsProbeEnabled && !this.hlsBrowserFallbackEnabled) return;
    for (const [index, stream] of streams.slice(0, 2).entries()) {
      const source = stream?.source;
      const streamId = stream?.id;
      const streamNo = stream?.streamNo || 1;
      if (!source || !streamId) continue;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Streamed sports prewarm timeout')), 8_000);
      timer.unref?.();
      const delayMs = index * 1_000;
      const task = new Promise((resolve) => {
        const delay = setTimeout(resolve, delayMs);
        delay.unref?.();
      })
        .then(() => this.resolvePlayableHls({ source, streamId, streamNo, signal: controller.signal }))
        .then((hls) => {
          if (hls?.url && this.requiresBrowserHlsContext(hls.url)) {
            this.prewarmPlaylist(hls.url, { delayMs: 250 });
          }
        })
        .catch((error) => {
          this.logger.debug?.('streamed sports hls prewarm failed', {
            source,
            streamNo,
            error: error?.message || String(error)
          });
        })
        .finally(() => clearTimeout(timer));
      void task;
    }
  }

  prewarmPlaylist(url, { delayMs = 0 } = {}) {
    const normalizedUrl = toString(url);
    if (!/\.m3u8(?:$|[?#])/iu.test(normalizedUrl)) return;
    if (!this.canPrewarmBrowser()) return;

    const key = `playlist:${normalizedUrl}`;
    if (this.playlistPrewarmInFlight.has(key)) return;
    const waitMs = Math.max(0, Math.min(10_000, Number(delayMs) || 0));
    const task = new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    })
      .then(() => this.browserFetchBytes(normalizedUrl, { cachePlaylist: true }))
      .catch((error) => {
        this.logger.warn?.('streamed sports playlist prewarm failed', {
          error: error?.message || String(error)
        });
      })
      .finally(() => {
        this.playlistPrewarmInFlight.delete(key);
    });
    this.playlistPrewarmInFlight.set(key, task);
  }

  findIndexedMatchBySource(sourceName, streamId) {
    const normalizedSource = normalizeIdPart(sourceName);
    const normalizedStreamId = toString(streamId);
    if (!normalizedSource || !normalizedStreamId) return null;
    const uniqueMatches = new Set(this.matchIndex.values());
    for (const match of uniqueMatches) {
      if (!Array.isArray(match?.sources)) continue;
      if (match.sources.some((source) => source.source === normalizedSource && source.id === normalizedStreamId)) {
        return match;
      }
    }
    return null;
  }

  async findMatchBySource(sourceName, streamId, signal = null) {
    const indexed = this.findIndexedMatchBySource(sourceName, streamId);
    if (indexed) return indexed;
    const sports = await this.getSports(signal);
    const catalogs = this.getEventCatalogDefinitions(sports);
    for (const catalog of catalogs) {
      const matches = await this.loadMatches(catalog, signal);
      const match = matches.find((entry) =>
        Array.isArray(entry?.sources)
        && entry.sources.some((source) => source.source === normalizeIdPart(sourceName) && source.id === toString(streamId)));
      if (match) return match;
    }
    return null;
  }

  async resolveFallbackPlayableHls({ source, streamId, streamNo = 1, signal = null, limit = 1 } = {}) {
    const match = await this.findMatchBySource(source, streamId, signal);
    if (!match) return null;
    const settled = await Promise.allSettled(this.filterSupplementalSources(match.sources).map((candidateSource) => this.getSourceStreams(candidateSource, signal)));
    const candidates = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter((stream) => !(normalizeIdPart(stream.source) === normalizeIdPart(source)
        && toString(stream.id) === toString(streamId)
        && Number(stream.streamNo || 1) === Number(streamNo || 1)))
      .sort((left, right) => {
        const leftSameStreamNo = Number(left.streamNo || 1) === Number(streamNo || 1) ? 0 : 1;
        const rightSameStreamNo = Number(right.streamNo || 1) === Number(streamNo || 1) ? 0 : 1;
        return leftSameStreamNo - rightSameStreamNo
          || compareStreamsBySourceRank(left, right)
          || Number(right.hd) - Number(left.hd)
          || Number(right.viewers || 0) - Number(left.viewers || 0);
      })
      .slice(0, Math.max(1, Math.min(4, Number(limit) || 1)));

    for (const candidate of candidates) {
      try {
        const hls = await this.resolvePlayableHls({
          source: candidate.source,
          streamId: candidate.id,
          streamNo: candidate.streamNo || 1,
          signal
        });
        return {
          ...hls,
          fallback: {
            source: candidate.source,
            streamId: candidate.id,
            streamNo: candidate.streamNo || 1
          }
        };
      } catch (error) {
        this.logger.warn?.('streamed sports fallback hls failed', {
          source: candidate.source,
          streamNo: candidate.streamNo,
          error: error?.message || String(error)
        });
      }
    }
    return null;
  }

  canPrewarmBrowser() {
    return Date.now() >= this.browserDisabledUntil
      && freemem() >= MIN_BROWSER_PREWARM_FREE_BYTES
      && this.playlistPrewarmInFlight.size < MAX_BROWSER_PREWARM_IN_FLIGHT;
  }

  prewarmBrowser(reason = 'prewarm') {
    if (!this.chromePath || !this.canPrewarmBrowser() || this.browserPromise) return;
    void this.getHlsResolvePage()
      .then(() => {
        this.logger.debug?.('streamed sports browser prewarmed', { reason });
        this.scheduleBrowserIdleClose();
      })
      .catch((error) => {
        this.logger.warn?.('streamed sports browser prewarm failed', {
          reason,
          error: error?.message || String(error)
        });
      });
  }

  async resolvePlayableHls({ source, streamId, streamNo = 1, signal = null } = {}) {
    const normalizedSource = normalizeIdPart(source);
    const normalizedStreamId = toString(streamId);
    const normalizedStreamNo = toString(streamNo || 1);
    if (!normalizedSource || !normalizedStreamId) {
      throw new Error('Invalid Streamed sports stream id');
    }
    if (!SUPPLEMENTAL_SPORTS_SOURCES_ENABLED && isSupplementalSportsSource(normalizedSource)) {
      throw new Error('Supplemental sports source disabled');
    }

    const cacheKey = `${normalizedSource}:${normalizedStreamId}:${normalizedStreamNo}`;
    const skipHlsCache = normalizedSource === CDNLIVETV_SOURCE;
    if (!skipHlsCache) {
      const cached = this.getCachedHls(cacheKey);
      if (cached) {
        await this.setSharedHls(cacheKey, cached);
        return cached;
      }
      if (this.hlsCacheMs > 0) {
        const sharedCached = await this.getSharedHls(cacheKey);
        if (sharedCached) {
          this.setCachedHls(cacheKey, sharedCached);
          return sharedCached;
        }
      }
    }

    if (normalizedSource === STREAMFREE_SOURCE) {
      const channel = this.getStreamFreeChannel(normalizedStreamId);
      if (channel) {
        const value = await this.resolveStreamFreeChannelHls(channel, signal);
        if (value?.url) {
          this.setCachedHls(cacheKey, value);
          await this.setSharedHls(cacheKey, value);
          return value;
        }
      }
    }

    if (normalizedSource === REXDEX_SOURCE) {
      if (Date.now() < REXDEX_PORTUGAL_UZBEKISTAN_UNTIL_MS && normalizedStreamId === REXDEX_PORTUGAL_UZBEKISTAN_STREAM_ID) {
        const value = {
          url: REXDEX_PORTUGAL_UZBEKISTAN_HLS,
          contextUrl: REXDEX_PORTUGAL_UZBEKISTAN_PAGE,
          headers: this.getRexDexHlsHeaders(REXDEX_PORTUGAL_UZBEKISTAN_PAGE),
          playbackProfile: {
            quality: 'HD',
            speedMbps: 8
          }
        };
        this.setCachedHls(cacheKey, value);
        await this.setSharedHls(cacheKey, value);
        return value;
      }
    }

    if (normalizedSource === WC_XTREAM_SOURCE) {
      const config = this.getWorldCupXtreamConfig();
      if (!config) throw new Error('World Cup IPTV source is not configured');
      const value = {
        url: this.buildWorldCupXtreamHlsUrl(config, normalizedStreamId),
        contextUrl: config.baseUrl,
        headers: this.getWorldCupXtreamHeaders(),
        playbackProfile: {
          quality: 'HD',
          speedMbps: 8
        }
      };
      this.setCachedHls(cacheKey, value);
      await this.setSharedHls(cacheKey, value);
      return value;
    }

    if (normalizedSource === DLHD_SOURCE) {
      const value = await this.resolveDlhdChannel(normalizedStreamId, signal);
      if (value?.url) {
        this.setCachedHls(cacheKey, value);
        await this.setSharedHls(cacheKey, value);
        return value;
      }
    }

    if (normalizedSource === CDNLIVETV_SOURCE) {
      const value = await this.resolveCdnLiveTvChannel(normalizedStreamId, signal);
      if (value?.url) {
        return value;
      }
    }

    if (normalizedSource === 'echo') {
      throw new Error('Echo source disabled');
    }

    if (normalizedSource === FLIX_DLSTREAMS_SOURCE) {
      const streams = await this.getSourceStreams({
        source: FLIX_DLSTREAMS_SOURCE,
        id: normalizedStreamId
      }, signal);
      const stream = streams.find((entry) => toString(entry.streamNo || 1) === normalizedStreamNo) || streams[0];
      if (stream?.directHlsUrl && isHttpUrl(stream.directHlsUrl)) {
        const value = {
          url: stream.directHlsUrl,
          contextUrl: stream.contextUrl || `${FLIX_DLSTREAMS_BASE_URL}/stream/tv/${encodeURIComponent(normalizedStreamId)}.json`,
          headers: stream.headers || this.getFlixDlstreamsHeaders({
            accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*'
          })
        };
        this.setCachedHls(cacheKey, value);
        await this.setSharedHls(cacheKey, value);
        return value;
      }
    }

    if (normalizedSource === SPORTSBITE_SOURCE) {
      await this.loadSportsBiteMatches({
        id: SPORTSBITE_CATALOG_ID,
        endpoint: SPORTSBITE_CACHE_KEY
      }, signal);
      const stream = (this.sportsBiteSourceStreams.get(normalizedStreamId) || [])
        .find((entry) => toString(entry.streamNo || 1) === normalizedStreamNo);
      if (stream?.directHlsUrl && isHttpUrl(stream.directHlsUrl)) {
        const value = {
          url: stream.directHlsUrl,
          contextUrl: stream.contextUrl || `${SPORTSBITE_ORIGIN}/`,
          headers: stream.headers || this.getSportsBiteHeaders({
            accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*'
          })
        };
        this.setCachedHls(cacheKey, value);
        await this.setSharedHls(cacheKey, value);
        return value;
      }
    }

    const embedUrl = this.getEmbedUrl({
      source: normalizedSource,
      streamId: normalizedStreamId,
      streamNo: normalizedStreamNo
    });
    if (this.hlsResolveInFlight.has(cacheKey)) {
      return this.hlsResolveInFlight.get(cacheKey);
    }

    const task = this.resolvePlayableHlsFresh({
      cacheKey,
      embedUrl,
      normalizedSource,
      normalizedStreamNo,
      signal
    });
    this.hlsResolveInFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      if (this.hlsResolveInFlight.get(cacheKey) === task) {
        this.hlsResolveInFlight.delete(cacheKey);
      }
    }
  }

  async resolvePlayableHlsFresh({ cacheKey, embedUrl, normalizedSource, normalizedStreamNo, signal = null }) {
    if (normalizedSource === HELLOSPORTS_SOURCE) {
      const value = await this.resolveHelloSportsEmbedHls(embedUrl, signal);
      this.setCachedHls(cacheKey, value);
      await this.setSharedHls(cacheKey, value);
      return value;
    }
    const probed = await this.resolvePlayableHlsWithProbe(embedUrl, signal);
    if (probed?.url) {
      const probedHlsUrl = extractDirectHlsUrl(probed.url) || probed.url;
      const value = {
        url: probedHlsUrl,
        contextUrl: embedUrl,
        headers: this.getProbedHlsHeadersForSource(normalizedSource, embedUrl),
        resolveOnPlayback: this.requiresBrowserHlsContext(probedHlsUrl)
      };
      if (normalizedSource === REXDEX_SOURCE && !value.resolveOnPlayback) {
        const playbackProfile = await this.validateDirectHlsUrl(value.url, signal, value.headers);
        if (!this.isRexDexHighQualityPlaybackProfile(playbackProfile)) {
          throw new Error('RexDex HLS below 1080p');
        }
        value.playbackProfile = playbackProfile;
      }
      this.setCachedHls(cacheKey, value);
      await this.setSharedHls(cacheKey, value);
      return value;
    }
    if (this.hlsProbeEnabled && !this.hlsBrowserFallbackEnabled) {
      throw new Error('Streamed HLS probe found no playable source');
    }

    const hlsUrl = await this.resolvePlayableHlsInBrowser(embedUrl, {
      source: normalizedSource,
      streamNo: normalizedStreamNo,
      signal
    });
    const value = {
      url: hlsUrl,
      contextUrl: embedUrl,
      headers: this.getPlaybackHeadersForSource(normalizedSource, embedUrl),
      resolveOnPlayback: this.requiresBrowserHlsContext(hlsUrl)
    };
    if (normalizedSource === REXDEX_SOURCE && !value.resolveOnPlayback) {
      const playbackProfile = await this.validateDirectHlsUrl(value.url, signal, value.headers);
      if (!this.isRexDexHighQualityPlaybackProfile(playbackProfile)) {
        throw new Error('RexDex HLS below 1080p');
      }
      value.playbackProfile = playbackProfile;
    }
    this.setCachedHls(cacheKey, value);
    await this.setSharedHls(cacheKey, value);
    return value;
  }

  requiresBrowserHlsContext(url) {
    try {
      const host = new URL(String(url || '')).hostname.toLowerCase();
      return host === 'zohanayaan.com'
        || host.endsWith('.zohanayaan.com')
        || host === 'strmd.st'
        || host.endsWith('.strmd.st');
    } catch {
      return false;
    }
  }

  async resolvePlayableHlsInBrowser(embedUrl, { source = '', streamNo = '', signal = null } = {}) {
    const runResolve = async (attempt = 1) => {
      if (signal?.aborted) throw signal.reason || new Error('Streamed HLS resolve aborted');
      let timeout = null;
      let abortHandler = null;
      let requestHandler = null;
      let responseHandler = null;
      let page = null;
      let failHlsResolve = null;
      this.activeBrowserPages += 1;
      try {
        page = await this.getHlsResolvePage();
        this.hlsResolvePageUses += 1;
        await waitForBrowserPageReady(page);
        let settled = false;
        const hlsPromise = new Promise((resolve, reject) => {
          const fail = (error) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            reject(error);
          };
          failHlsResolve = fail;
          timeout = setTimeout(() => {
            fail(new Error('Streamed HLS resolve timeout'));
          }, this.browserTimeoutMs);
          if (signal) {
            abortHandler = () => fail(signal.reason || new Error('Streamed HLS resolve aborted'));
            signal.addEventListener('abort', abortHandler, { once: true });
          }
          responseHandler = async (response) => {
            const url = response.url();
            const headers = response.headers();
            const likelyHls = isLikelyHlsResponse(url, headers);
            if (likelyHls) {
              if (settled) return;
              if (!response.ok()) return;
              try {
                const body = await response.buffer();
                if (!isLikelyHlsResponse(url, headers) && !isHlsPlaylistText(body.toString('utf8', 0, Math.min(body.length, 256)))) {
                  return;
                }
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                const fetched = {
                  status: response.status(),
                  url,
                  headers,
                  body
                };
                this.setCachedPlaylist(url, fetched);
                void this.setSharedPlaylist(url, fetched);
              } catch (error) {
                this.logger.debug?.('streamed sports hls response cache failed', {
                  source,
                  streamNo,
                  error: error?.message || String(error)
                });
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
              }
              resolve(url);
            }
          };
          page.on('response', responseHandler);
        });
        void page.goto(embedUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.browserTimeoutMs
        }).catch((error) => {
          if (settled) return;
          const message = error?.message || String(error);
          const recoverable = /INSUFFICIENT_RESOURCES|Target closed|Session closed|Connection closed|Requesting main frame too early|detached Frame|Navigating frame was detached/iu.test(message);
          const log = attempt < 2 && recoverable ? this.logger.debug : this.logger.warn;
          log?.call(this.logger, 'streamed sports embed navigation failed', {
            source,
            streamNo,
            error: message
          });
          if (!recoverable) {
            failHlsResolve?.(error);
          }
        });
        setTimeout(() => {
          if (settled || page?.isClosed?.()) return;
          page.mouse?.click(400, 300).catch(() => {});
        }, 1_000).unref?.();
        const hlsUrl = await hlsPromise;
        if (this.hlsResolvePageUses >= 40) {
          void this.closeHlsResolvePage('hls resolve recycle');
        }
        return hlsUrl;
      } catch (error) {
        const message = error?.message || String(error);
        if (attempt < 2 && !signal?.aborted && /INSUFFICIENT_RESOURCES|Target closed|Session closed|Connection closed|Requesting main frame too early|detached Frame|Navigating frame was detached/iu.test(message)) {
          await this.closeBrowser('hls resolve browser failure').catch(() => {});
          return runResolve(attempt + 1);
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
        if (page && requestHandler) {
          page.off?.('request', requestHandler);
        }
        if (page && responseHandler) {
          page.off?.('response', responseHandler);
        }
        this.activeBrowserPages = Math.max(0, this.activeBrowserPages - 1);
        this.scheduleBrowserIdleClose();
        if (signal?.aborted) throw signal.reason || new Error('Streamed HLS resolve aborted');
      }
    };

    const task = this.hlsResolveChain.catch(() => {}).then(() => {
      if (signal?.aborted) throw signal.reason || new Error('Streamed HLS resolve aborted');
      return runResolve();
    });
    this.hlsResolveChain = task.catch(() => {});
    return task;
  }

  async cachePlaylistFromPage(page, url) {
    if (!page || !url) return null;
    const result = await page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, {
        headers: { accept: '*/*' },
        cache: 'no-store'
      });
      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = Array.from(new Uint8Array(await response.arrayBuffer()));
      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        headers,
        body
      };
    }, url);
    if (!result?.ok) {
      throw new Error(`Streamed browser fetch HTTP ${result?.status || 0}`);
    }
    const fetched = {
      status: result.status,
      url: result.url || url,
      headers: result.headers || {},
      body: Buffer.from(result.body || [])
    };
    const contentType = String(fetched.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('mpegurl') || contentType.includes('m3u8') || /\.m3u8(?:$|[?#])/iu.test(fetched.url)) {
      this.setCachedPlaylist(url, fetched);
    }
    return fetched;
  }

  getBrowserFetchHeaders() {
    return {
      accept: '*/*',
      origin: EMBED_BASE,
      referer: `${EMBED_BASE}/`,
      'user-agent': BROWSER_USER_AGENT
    };
  }

  getStreamzy4kHeaders(contextUrl = '') {
    return {
      accept: '*/*',
      origin: STREAMZY_4K_ORIGIN,
      referer: contextUrl || `${STREAMZY_4K_ORIGIN}/`,
      'user-agent': BROWSER_USER_AGENT
    };
  }

  getPlaybackHeadersForSource(source = '', contextUrl = '') {
    if (normalizeIdPart(source) === STREAMZY_4K_SOURCE) {
      return this.getStreamzy4kHeaders(contextUrl);
    }
    if (normalizeIdPart(source) === REXDEX_SOURCE) {
      return this.getRexDexHlsHeaders(contextUrl);
    }
    if (normalizeIdPart(source) === HELLOSPORTS_SOURCE) {
      return this.getHelloSportsHlsHeaders(contextUrl);
    }
    if (normalizeIdPart(source) === SPORTSRC_SOURCE && contextUrl) {
      let origin = SPORTSRC_API_BASE;
      try {
        origin = new URL(contextUrl).origin;
      } catch {
        origin = SPORTSRC_API_BASE;
      }
      return {
        ...this.getBrowserFetchHeaders(),
        accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,*/*',
        origin,
        referer: contextUrl
      };
    }
    if (normalizeIdPart(source) === RAPID_FOOTBALL_SOURCE && contextUrl) {
      let origin = RAPID_FOOTBALL_MATCHES_URL;
      try {
        origin = new URL(contextUrl).origin;
      } catch {
        origin = RAPID_FOOTBALL_MATCHES_URL;
      }
      return {
        ...this.getBrowserFetchHeaders(),
        accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,*/*',
        origin,
        referer: contextUrl
      };
    }
    if (normalizeIdPart(source) === REPLAYZONE_SOURCE && contextUrl) {
      let origin = 'https://replay-exc.pages.dev';
      try {
        origin = new URL(contextUrl).origin;
      } catch {
        origin = 'https://replay-exc.pages.dev';
      }
      return {
        ...this.getBrowserFetchHeaders(),
        accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,*/*',
        origin,
        referer: contextUrl
      };
    }
    return this.getBrowserFetchHeaders();
  }

  getProbedHlsHeadersForSource(source = '', contextUrl = '') {
    const normalized = normalizeIdPart(source);
    if (normalized === STREAMZY_4K_SOURCE || normalized === REXDEX_SOURCE || normalized === HELLOSPORTS_SOURCE) {
      return this.getPlaybackHeadersForSource(normalized, contextUrl);
    }
    return {
      ...this.getBrowserFetchHeaders(),
      origin: 'https://exposestrat.com',
      referer: 'https://exposestrat.com/maestrohd1.php'
    };
  }

  async resolvePlayableHlsWithProbe(embedUrl, signal = null) {
    if (!this.hlsProbeEnabled) return null;
    if (Date.now() < this.hlsProbeDisabledUntil || signal?.aborted) return null;
    try {
      const probeSignal = signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, AbortSignal.timeout(HLS_PROBE_TIMEOUT_MS)])
        : AbortSignal.timeout(HLS_PROBE_TIMEOUT_MS);
      const { stdout } = await execFileAsync('python3', [
        HLS_PROBE_SCRIPT,
        '--url',
        embedUrl,
        '--timeout',
        String(Math.max(1, Math.ceil(HLS_PROBE_TIMEOUT_MS / 1000)))
      ], {
        timeout: HLS_PROBE_TIMEOUT_MS + 500,
        maxBuffer: 256 * 1024,
        signal: probeSignal
      });
      const payload = JSON.parse(String(stdout || '{}'));
      if (payload?.url && /^https?:\/\/[^"\s]+\.m3u8(?:$|[?#])/iu.test(payload.url)) {
        this.hlsProbeFailures = 0;
        return { url: payload.url };
      }
    } catch (error) {
      const message = error?.message || String(error);
      const stdout = String(error?.stdout || '');
      if (Number(error?.code) === 2 || /"no hls found"/iu.test(stdout)) {
        return null;
      }
      if (!/no hls found|exit code 2|SIGTERM|ABORT_ERR|operation was aborted/iu.test(message)) {
        this.logger.debug?.('streamed sports python hls probe failed', { error: message });
      }
    }

    this.hlsProbeFailures += 1;
    if (this.hlsProbeFailures >= 3) {
      this.hlsProbeDisabledUntil = Date.now() + HLS_PROBE_DISABLE_MS;
      this.hlsProbeFailures = 0;
    }
    return null;
  }

  async closeHlsResolvePage(reason = 'manual') {
    const pagePromise = this.hlsResolvePagePromise;
    this.hlsResolvePagePromise = null;
    this.hlsResolvePageUses = 0;
    if (!pagePromise) return;
    try {
      const page = await pagePromise;
      if (page && !page.isClosed?.()) {
        await page.close();
      }
      this.logger.debug?.('streamed sports hls resolve page closed', { reason });
    } catch (error) {
      this.logger.warn?.('streamed sports hls resolve page close failed', {
        reason,
        error: error?.message || String(error)
      });
    }
  }

  async getHlsResolvePage() {
    if (!this.hlsResolvePagePromise) {
      this.hlsResolvePagePromise = this.getBrowser()
        .then(async (browser) => {
          const page = await browser.newPage();
          await page.setUserAgent(BROWSER_USER_AGENT);
          await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 }).catch(() => {});
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            window.chrome = window.chrome || { runtime: {} };
            const originalQuery = navigator.permissions?.query?.bind(navigator.permissions);
            if (originalQuery) {
              navigator.permissions.query = (parameters) => (
                parameters?.name === 'notifications'
                  ? Promise.resolve({ state: Notification.permission })
                  : originalQuery(parameters)
              );
            }
            window.close = () => {};
          }).catch(() => {});
          await page.setRequestInterception(true).catch(() => {});
          page.on('request', async (request) => {
            const resourceType = request.resourceType?.() || '';
            const url = request.url?.() || '';
            const isHlsRequest = /\.m3u8(?:$|[?#])/iu.test(url);
            if (resourceType === 'document' && url.startsWith(`${EMBED_BASE}/embed/`)) {
              try {
                const response = await this.fetchImpl(url, {
                  headers: {
                    accept: 'text/html,application/xhtml+xml,*/*',
                    'accept-encoding': 'identity',
                    referer: `${API_BASE}/`,
                    'user-agent': BROWSER_USER_AGENT
                  }
                });
                const body = await response.text();
                await request.respond({
                  status: response.status || 200,
                  contentType: 'text/html; charset=utf-8',
                  headers: {
                    'cache-control': 'no-store'
                  },
                  body
                });
                return;
              } catch (error) {
                this.logger.debug?.('streamed sports embed html proxy failed', {
                  error: error?.message || String(error)
                });
              }
            }
            if (resourceType === 'script' && (/cdn\.jsdelivr\.net\/npm\/(?:@swarmcloud\/hls|clappr)/iu.test(url) || url.startsWith(`${EMBED_BASE}/js/`))) {
              try {
                const response = await this.fetchImpl(url, {
                  headers: {
                    accept: 'application/javascript,*/*',
                    'accept-encoding': 'identity',
                    referer: `${EMBED_BASE}/`,
                    'user-agent': BROWSER_USER_AGENT
                  }
                });
                const body = await response.text();
                await request.respond({
                  status: response.status || 200,
                  contentType: 'application/javascript; charset=utf-8',
                  headers: {
                    'cache-control': 'public, max-age=300'
                  },
                  body
                });
                return;
              } catch (error) {
                this.logger.debug?.('streamed sports player script proxy failed', {
                  url,
                  error: error?.message || String(error)
                });
              }
            }
            if ((['image', 'font', 'stylesheet'].includes(resourceType))
              || /(?:\/ad\.html|usrpubtrk|acscdn|doubleclick|googletagmanager|google-analytics|adservice|adsterra|popads|onclick|optimserve)/iu.test(url)) {
              request.abort().catch(() => {});
              return;
            }
            request.continue().catch(() => {});
          });
          page.on('close', () => {
            this.hlsResolvePagePromise = null;
            this.hlsResolvePageUses = 0;
          });
          this.hlsResolvePageUses = 0;
          return page;
        })
        .catch((error) => {
          this.hlsResolvePagePromise = null;
          throw error;
        });
    }
    return this.hlsResolvePagePromise;
  }

  async browserFetchBytes(url, { signal = null, cachePlaylist = false, cacheMedia = false, contextUrl = '', preferCache = true } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('Streamed browser fetch aborted');
    const isPlaylistUrl = /\.m3u8(?:$|[?#])/iu.test(String(url || ''));
    const canUsePlaylistCache = isPlaylistUrl;
    const shouldReadPlaylistCache = preferCache && canUsePlaylistCache;
    const cachedPlaylist = shouldReadPlaylistCache ? this.getCachedPlaylist(url) : null;
    if (cachedPlaylist) {
      return cachedPlaylist;
    }
    const sharedPlaylist = shouldReadPlaylistCache ? await this.getSharedPlaylist(url) : null;
    if (sharedPlaylist) {
      return sharedPlaylist;
    }
    const shouldReadMediaCache = cacheMedia && !isPlaylistUrl;
    const cachedMedia = shouldReadMediaCache ? this.getCachedMedia(url) : null;
    if (cachedMedia) {
      return cachedMedia;
    }
    const inFlightKey = isPlaylistUrl
      ? `playlist:${url}`
      : (cacheMedia ? `media:${url}` : null);
    if (inFlightKey && this.browserFetchInFlight.has(inFlightKey)) {
      return this.browserFetchInFlight.get(inFlightKey);
    }

    const runFetch = async (attempt = 1) => {
      let timeout = null;
      let abortHandler = null;
      let page = null;
      let closeDedicatedPage = false;
      try {
        if (contextUrl) {
          const browser = await this.getBrowser();
          page = await browser.newPage();
          closeDedicatedPage = true;
          this.activeBrowserPages += 1;
          await page.setUserAgent(BROWSER_USER_AGENT);
          await waitForBrowserPageReady(page);
          await page.goto(contextUrl, { waitUntil: 'domcontentloaded', timeout: this.browserTimeoutMs });
        } else {
          page = await this.getBrowserFetchPage();
          this.browserFetchPageUses += 1;
          await waitForBrowserPageReady(page);
        }
        const result = await Promise.race([
          page.evaluate(async (targetUrl) => {
            const response = await fetch(targetUrl, {
              headers: { accept: '*/*' },
              cache: 'no-store'
            });
            const headers = {};
            response.headers.forEach((value, key) => {
              headers[key] = value;
            });
            const body = Array.from(new Uint8Array(await response.arrayBuffer()));
            return {
              ok: response.ok,
              status: response.status,
              url: response.url,
              headers,
              body
            };
          }, url),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Streamed browser fetch timeout')), this.browserTimeoutMs);
            if (signal) {
              abortHandler = () => reject(signal.reason || new Error('Streamed browser fetch aborted'));
              signal.addEventListener('abort', abortHandler, { once: true });
            }
          })
        ]);
        if (!result?.ok) {
          throw new Error(`Streamed browser fetch HTTP ${result?.status || 0}`);
        }
        const fetched = {
          status: result.status,
          url: result.url || url,
          headers: result.headers || {},
          body: Buffer.from(result.body || [])
        };
        const contentType = String(fetched.headers['content-type'] || '').toLowerCase();
        if (canUsePlaylistCache && cachePlaylist && (contentType.includes('mpegurl') || contentType.includes('m3u8') || /\.m3u8(?:$|[?#])/iu.test(fetched.url))) {
          this.setCachedPlaylist(url, fetched);
          await this.setSharedPlaylist(url, fetched);
        }
        if (cacheMedia && !isPlaylistUrl) {
          this.setCachedMedia(url, fetched);
        }
        if (isPlaylistUrl && this.browserFetchPageUses >= 80) {
          void this.closeBrowserFetchPage('playlist fetch recycle');
        }
        return fetched;
      } catch (error) {
        if (isPlaylistUrl && attempt < 2 && !signal?.aborted) {
          const message = error?.message || String(error);
          if (/Connection closed|Target closed|Session closed|Requesting main frame too early|detached Frame|Navigating frame was detached/iu.test(message)) {
            await this.closeBrowser('playlist fetch browser failure').catch(() => {});
          } else if (!contextUrl) {
            await this.closeBrowserFetchPage('playlist fetch failure');
          }
          return runFetch(attempt + 1);
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
        if (closeDedicatedPage && page) {
          await page.close().catch(() => {});
          this.activeBrowserPages = Math.max(0, this.activeBrowserPages - 1);
        }
      }
    };

    const task = isPlaylistUrl
      ? runFetch()
      : this.browserFetchChain.catch(() => {}).then(() => {
        if (signal?.aborted) throw signal.reason || new Error('Streamed browser fetch aborted');
        return runFetch();
      });
    if (inFlightKey) {
      this.browserFetchInFlight.set(inFlightKey, task);
    } else {
      this.browserFetchChain = task.catch(() => {});
    }

    try {
      return await task;
    } finally {
      if (inFlightKey && this.browserFetchInFlight.get(inFlightKey) === task) {
        this.browserFetchInFlight.delete(inFlightKey);
      }
      this.scheduleBrowserIdleClose();
      if (signal?.aborted) throw signal.reason || new Error('Streamed browser fetch aborted');
    }
  }

  async closeBrowserFetchPage(reason = 'manual') {
    const pagePromise = this.browserFetchPagePromise;
    this.browserFetchPagePromise = null;
    this.browserFetchPageUses = 0;
    if (!pagePromise) return;
    try {
      const page = await pagePromise;
      if (page && !page.isClosed?.()) {
        await page.close();
      }
      this.logger.debug?.('streamed sports browser fetch page closed', { reason });
    } catch (error) {
      this.logger.warn?.('streamed sports browser fetch page close failed', {
        reason,
        error: error?.message || String(error)
      });
    }
  }

  async getBrowserFetchPage() {
    if (!this.browserFetchPagePromise) {
      this.browserFetchPagePromise = this.getBrowser()
        .then(async (browser) => {
          const page = await browser.newPage();
          await page.setUserAgent(BROWSER_USER_AGENT);
          await page.setExtraHTTPHeaders({
            referer: `${EMBED_BASE}/`,
            origin: EMBED_BASE,
            accept: '*/*'
          });
          await page.goto(`${EMBED_BASE}/`, { waitUntil: 'domcontentloaded', timeout: this.browserTimeoutMs }).catch(() => {});
          page.on('close', () => {
            this.browserFetchPagePromise = null;
            this.browserFetchPageUses = 0;
          });
          this.browserFetchPageUses = 0;
          return page;
        })
        .catch((error) => {
          this.browserFetchPagePromise = null;
          throw error;
        });
    }
    return this.browserFetchPagePromise;
  }

  async getBrowser() {
    if (!this.chromePath) {
      throw new Error('STREAMED_SPORTS_CHROME_PATH is not configured');
    }
    if (Date.now() < this.browserDisabledUntil) {
      const seconds = Math.ceil((this.browserDisabledUntil - Date.now()) / 1000);
      throw new Error(`Streamed sports browser temporarily disabled for ${seconds}s after launch failure`);
    }
    if (this.browserIdleTimer) {
      clearTimeout(this.browserIdleTimer);
      this.browserIdleTimer = null;
    }
    if (!this.browserPromise) {
      this.browserPromise = import('puppeteer-core')
        .then(({ default: puppeteer }) => puppeteer.launch({
          executablePath: this.chromePath,
          headless: true,
          userDataDir: path.join(this.cacheDir, 'streamed-sports-chrome-profile'),
          args: [
            '--no-sandbox',
            '--single-process',
            '--no-zygote',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-client-side-phishing-detection',
            '--disable-extensions',
            '--disable-features=Translate,BackForwardCache,AcceptCHFrame',
            '--disable-sync',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-first-run',
            '--no-default-browser-check',
            '--enable-unsafe-swiftshader',
            '--window-size=1365,768',
            `--disk-cache-dir=${path.join(this.cacheDir, 'streamed-sports-chrome-cache')}`,
            `--media-cache-dir=${path.join(this.cacheDir, 'streamed-sports-chrome-media-cache')}`,
            '--autoplay-policy=no-user-gesture-required'
          ]
        }))
        .catch((error) => {
          this.browserPromise = null;
          this.recordBrowserLaunchFailure(error);
          throw error;
        });
    }
    return this.browserPromise;
  }

  recordBrowserLaunchFailure(error) {
    const message = error?.message || String(error);
    const hardFailure = /Failed to launch the browser process|SIGILL|ILL_ILLOPN|Code:\s*null|control flow integrity/iu.test(message);
    if (!hardFailure) return;
    this.browserLaunchFailures += 1;
    this.browserDisabledUntil = Date.now() + BROWSER_LAUNCH_DISABLE_MS;
    this.closeBrowser('browser launch failure').catch(() => {});
    this.logger.warn?.('streamed sports browser disabled after launch failure', {
      failures: this.browserLaunchFailures,
      disabledMs: BROWSER_LAUNCH_DISABLE_MS,
      error: message.split('\n').slice(0, 3).join('\n')
    });
  }

  scheduleBrowserIdleClose() {
    if (!this.browserPromise || this.activeBrowserPages > 0 || this.browserIdleTimer) return;
    this.browserIdleTimer = setTimeout(async () => {
      if (this.activeBrowserPages > 0) return;
      await this.closeBrowser('idle').catch((error) => {
        this.logger.warn?.('streamed sports browser idle close failed', {
          error: error?.message || String(error)
        });
      });
    }, this.browserIdleMs);
    this.browserIdleTimer.unref?.();
  }

  async closeBrowser(reason = 'manual') {
    if (this.browserIdleTimer) {
      clearTimeout(this.browserIdleTimer);
      this.browserIdleTimer = null;
    }
    const browserPromise = this.browserPromise;
    const fetchPagePromise = this.browserFetchPagePromise;
    const hlsPagePromise = this.hlsResolvePagePromise;
    this.browserPromise = null;
    this.browserFetchPagePromise = null;
    this.browserFetchPageUses = 0;
    this.hlsResolvePagePromise = null;
    this.hlsResolvePageUses = 0;
    this.browserFetchChain = Promise.resolve();
    this.hlsResolveChain = Promise.resolve();
    this.browserFetchInFlight.clear();
    this.hlsResolveInFlight.clear();
    if (fetchPagePromise) {
      const page = await withTimeout(fetchPagePromise, 3_000, 'streamed fetch page wait').catch(() => null);
      if (page) await withTimeout(page.close(), 3_000, 'streamed fetch page close').catch(() => {});
    }
    if (hlsPagePromise) {
      const page = await withTimeout(hlsPagePromise, 3_000, 'streamed hls page wait').catch(() => null);
      if (page) await withTimeout(page.close(), 3_000, 'streamed hls page close').catch(() => {});
    }
    if (browserPromise) {
      const browser = await withTimeout(browserPromise, 3_000, 'streamed browser wait');
      await withTimeout(browser.close(), 5_000, 'streamed browser close');
      this.logger.info?.('streamed sports browser closed', { reason });
    }
  }
}
