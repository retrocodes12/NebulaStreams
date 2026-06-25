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
const REXDEX_SOURCE = 'rexdex';
const REXDEX_PORTUGAL_UZBEKISTAN_STREAM_ID = 'portugal-uzbekistan-fancode-live-3';
const REXDEX_PORTUGAL_UZBEKISTAN_HLS = 'https://rxne77juptdeyke3tytvgqwyh.medya.trt.com.tr/master.m3u8';
const REXDEX_PORTUGAL_UZBEKISTAN_PAGE = 'https://www.rexdexsports.in/p/fancode-live-3.html?m=1';
const REXDEX_PORTUGAL_UZBEKISTAN_UNTIL_MS = Date.parse('2026-06-24T06:00:00.000Z');
const WC_XTREAM_SOURCE = 'wciptv';
const WC_XTREAM_CATEGORY_ID = String(process.env.NEBULA_SPORTS_WC_XTREAM_CATEGORY_ID || '105').trim();
const WC_XTREAM_CACHE_MS = 60_000;
const WC_XTREAM_VALIDATION_BUDGET_MS = 6_000;
const WC_XTREAM_MAX_CANDIDATES = 6;
const WC_XTREAM_MAX_CARDS = 4;
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
const DLHD_CHANNEL_CATALOG_LIMIT = 200;
const DLHD_CHANNEL_CACHE_MS = 6 * 60 * 60 * 1000;
const DLHD_CHANNEL_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const DLHD_HLS_MAX_CACHE_MS = 10 * 60 * 1000;
const DLHD_HLS_EXPIRY_MARGIN_MS = 45_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
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
const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const HLS_PROBE_TIMEOUT_MS = 6_000;
const HLS_PROBE_DISABLE_MS = 10 * 60 * 1000;
const HLS_PROBE_SCRIPT = path.join(process.cwd(), 'scripts', 'streamed_hls_probe.py');
const HLS_CONTENT_TYPE_RE = /(?:mpegurl|m3u8|application\/vnd\.apple|application\/x-mpegurl)/iu;
const STREAM_VALIDATION_TOTAL_BUDGET_MS = 8_000;
const STREAM_DIRECT_HLS_FAST_SOURCE_MS = 1_800;
const STREAM_DIRECT_HLS_FAST_VALIDATION_MS = 1_500;
const STREAM_VALIDATION_CANDIDATE_TIMEOUT_MS = 7_500;
const STREAM_VALIDATION_MAX_CANDIDATES = 8;
const STREAM_VALIDATION_MAX_PER_SOURCE = 2;
const STREAM_BROWSER_FALLBACK_TOTAL_BUDGET_MS = 4_000;
const STREAM_BROWSER_FALLBACK_MAX_CANDIDATES = 2;
const LICENSED_EXTERNAL_VALIDATION_BUDGET_MS = 1_500;
const STREAM_FAST_MATCH_LOOKUP_TIMEOUT_MS = 2_500;
const STREAM_SOURCE_LOAD_TIMEOUT_MS = 3_500;
const STREAM_SOURCE_RANK = new Map([
  [CDNLIVETV_SOURCE, -1],
  ['echo', 0],
  ['golf', 1],
  ['nebulasports', 2],
  [FLIX_DLSTREAMS_SOURCE, 3],
  [REXDEX_SOURCE, 3],
  ['admin', 4],
  ['delta', 5],
  ['sportsbite', 20],
  ['streamfree', 21],
  ['dlhd', 22],
  ['sportzx', 23],
  ['hellosports', 30]
]);
const STREAMED_SOURCE_DEFAULT_RANK = 5;
const SUPPLEMENTAL_SPORTS_SOURCES_ENABLED = true;
const SUPPLEMENTAL_SPORTS_SOURCES = new Set([SPORTSBITE_SOURCE, STREAMFREE_SOURCE, FLIX_DLSTREAMS_SOURCE, CDNLIVETV_SOURCE, 'sportzx']);
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
    this.dlhdHlsCache = new Map();
    this.dlhdHlsInFlight = new Map();
    this.hlsCache = new Map();
    this.playlistCache = new Map();
    this.mediaCache = new Map();
    this.mediaCacheBytes = 0;
    this.browserFetchInFlight = new Map();
    this.playlistPrewarmInFlight = new Map();
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
    const title = cleanDlhdChannelTitle(entry.channel_name || entry.channelName || entry.name || entry.title);
    if (!channelId || !title) return null;
    return {
      id: `streamed:${encodeURIComponent(`cdnlivetv-channel-${channelId}`)}`,
      sourceId: `cdnlivetv-channel-${channelId}`,
      type: STREMIO_SPORTS_TYPE,
      title,
      category: 'Live TV',
      date: Date.now(),
      poster: null,
      popular: false,
      sources: [{
        source: CDNLIVETV_SOURCE,
        id: this.encodeCdnLiveTvSourceId({
          id: channelId,
          channel_name: title,
          channel_code: entry.channel_code || entry.channelCode || entry.code || '',
          url: playerUrl,
          image: entry.image || entry.logo_url || entry.logoUrl || '',
          viewers: entry.viewers || 0
        })
      }],
      teams: [],
      normalizedTitle: normalizeTitle(`${title} live tv cdnlivetv channel`)
    };
  }

  async loadDlhdApiChannels(signal = null) {
    const payload = await this.fetchCdnLiveTvJson('/api/v1/channels/', signal);
    const entries = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.channels) ? payload.channels : []);
    return entries
      .map((entry) => this.toDlhdChannelMatch(entry))
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
    );
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
	      const channels = apiChannels.sort((left, right) => left.title.localeCompare(right.title));
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
      { type: STREMIO_SPORTS_TYPE, id: DLHD_CHANNEL_CATALOG_ID, endpoint: DLHD_CHANNEL_CACHE_KEY, name: 'Live TV' }
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
    if (catalog?.fifaWorldCup || catalog?.id === FIFA_WC_CATALOG_ID || endpoint === FIFA_WC_CACHE_KEY) {
      return this.loadFifaWorldCupMatches(catalog, signal);
    }

    const cached = this.matchesCache.get(endpoint);
    if (cached && cached.expiresAt > Date.now()) {
      const matches = this.mergeMatches(cached.value);
      this.indexMatches(catalog, matches);
      return matches;
    }

    const shared = await this.readSharedCache(`matches:${endpoint}`);
    if (Array.isArray(shared)) {
      let matches = this.filterSupplementalMatches(this.mergeMatches(shared));
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
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, matches);
      return matches;
    }

    try {
      const payload = await this.fetchJson(endpoint, signal);
      let matches = (Array.isArray(payload) ? payload : [])
        .map((entry) => this.toMatch(entry))
        .filter((match) => match.id && match.title);
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
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      this.indexMatches(catalog, matches);
      await this.writeSharedCache(`matches:${endpoint}`, matches, CACHE_TTL_MS).catch(() => {});
      return matches;
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
      sources,
      teams: [home, away].filter(Boolean),
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
    return {
      id: `streamed:${encodeURIComponent(sourceId)}`,
      sourceId,
      type: STREMIO_SPORTS_TYPE,
      title,
      category,
      date,
      poster: null,
      popular: Boolean(entry?.is_live || entry?.popular),
      sources: [{ source: SPORTSBITE_SOURCE, id: sourceId }],
      sportsBiteStreams,
      teams: [home, away].filter(Boolean),
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
      sources: [{ source: FLIX_DLSTREAMS_SOURCE, id: sourceId }],
      teams,
      normalizedTitle: normalizeTitle(`${title} ${category} ${description} nebulasp dlstreams`)
    };
  }

  toMatch(entry) {
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
    return {
      id: `streamed:${encodeURIComponent(sourceId)}`,
      sourceId,
      type: STREMIO_SPORTS_TYPE,
      title,
      category,
      date: Number(entry?.date || 0),
      poster: isHttpUrl(poster) ? poster : null,
      popular: Boolean(entry?.popular),
      sources,
      teams: [home, away].filter(Boolean),
      normalizedTitle: normalizeTitle(`${title} ${category} ${home} ${away}`)
    };
  }

  toEventMeta(match) {
    const isWorldCupFootball = isFifaWorldCupMatch(match);
    const isDlhdChannel = normalizeIdPart(match?.category) === 'dlhd-channels'
      || normalizeIdPart(match?.category) === 'live-tv'
      || normalizeIdPart(match?.sourceId).startsWith('dlhd-channel-')
      || normalizeIdPart(match?.sourceId).startsWith('cdnlivetv-channel-');
    const displayTitle = isDlhdChannel ? cleanDlhdChannelTitle(match.title) : match.title;
    const displayCategory = isDlhdChannel ? 'Live TV' : match.category;
    return {
      id: match.id,
      type: STREMIO_SPORTS_TYPE,
      name: displayTitle,
      poster: match.poster || undefined,
      logo: match.poster || undefined,
      posterShape: match.posterShape || (match.sources?.some((source) => normalizeIdPart(source?.source) === FLIX_DLSTREAMS_SOURCE) ? 'poster' : 'landscape'),
      genres: [...new Set(['Sports', displayCategory].filter(Boolean))],
      tournament: isWorldCupFootball ? 'FIFA World Cup' : undefined,
      competition: isWorldCupFootball ? 'FIFA World Cup' : undefined,
      releaseInfo: isDlhdChannel ? 'Live TV' : formatEventTime(match.date),
      runtime: 'Live',
      description: isDlhdChannel
        ? [
          displayTitle,
          'Live TV channel',
          'Streams load from Live TV channel source.'
        ].filter(Boolean).join('\n')
        : [
          'Live sports event',
          `Category: ${displayCategory}`,
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
    const pageLimit = isDlhdChannelCatalog
      ? Math.max(Number(limit) || 0, DLHD_CHANNEL_CATALOG_LIMIT)
      : limit;
    return matches
      .filter((match) => !needle || match.normalizedTitle.includes(needle))
      .filter((match) => !isDlhdChannelCatalog || needle || isLikelySportsDlhdChannelTitle(match.title))
      .sort((left, right) => {
        if (isDlhdChannelCatalog) {
          const sportsScore = Number(isLikelySportsDlhdChannelTitle(right.title)) - Number(isLikelySportsDlhdChannelTitle(left.title));
          if (sportsScore !== 0) return sportsScore;
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
          .map((entry) => this.toMatch(entry))
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
    const cached = this.streamCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
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
        const sharedCacheKey = `stream:v1:${CDNLIVETV_SOURCE}:${toString(source.id)}`;
        const sharedCached = await this.readSharedCache(sharedCacheKey);
        if (Array.isArray(sharedCached) && sharedCached.length) {
          this.streamCache.set(key, {
            value: sharedCached,
            expiresAt: Date.now() + CDNLIVETV_STREAM_CACHE_MS
          });
          return sharedCached;
        }
        const staleShared = await this.readSharedCache(sharedCacheKey, {
          allowStale: true,
          staleTtlMs: CDNLIVETV_STREAM_STALE_MS
        });
        let streams = [];
        try {
          const hls = await this.resolveCdnLiveTvChannel(source.id, signal);
          const channel = this.decodeCdnLiveTvSourceId(source.id) || {};
          streams = hls?.url ? [{
            id: toString(source.id),
            streamNo: 1,
            language: toString(channel.name) || 'Live TV',
            hd: true,
            embedUrl: hls.contextUrl,
            directHlsUrl: hls.url,
            contextUrl: hls.contextUrl,
            headers: hls.headers,
            source: CDNLIVETV_SOURCE,
            viewers: Number(channel.viewers || 0),
            playbackProfile: hls.playbackProfile
          }] : [];
        } catch (error) {
          if (Array.isArray(staleShared) && staleShared.length) {
            this.logger.warn?.('CDNLiveTV stream resolve failed, using stale cache', {
              error: error?.message || String(error)
            });
            this.streamCache.set(key, {
              value: staleShared,
              expiresAt: Date.now() + CDNLIVETV_STREAM_CACHE_MS
            });
            return staleShared;
          }
          throw error;
        }
        this.streamCache.set(key, {
          value: streams,
          expiresAt: Date.now() + CDNLIVETV_STREAM_CACHE_MS
        });
        if (streams.length) {
          await this.writeSharedCache(sharedCacheKey, streams, CDNLIVETV_STREAM_CACHE_MS).catch((error) => {
            this.logger.debug?.('CDNLiveTV stream cache write failed', { error: error?.message || String(error) });
          });
        }
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
        const streams = await this.sportzXStreamSource.getChannelStreams(source.id, signal);
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

  formatQualityLabel(height = 0) {
    const value = Number.parseInt(height, 10) || 0;
    if (value >= 2000) return '4K';
    if (value >= 1000) return '1080p';
    if (value >= 700) return '720p';
    if (value >= 450) return '480p';
    if (value > 0) return `${value}p`;
    return 'HD';
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
      [STREAMFREE_SOURCE, 'StreamFree'],
      [SPORTSBITE_SOURCE, 'SportsBite'],
      [DLHD_SOURCE, 'Live TV'],
      [FLIX_DLSTREAMS_SOURCE, 'NebulaSP'],
      [CDNLIVETV_SOURCE, 'Live TV'],
      [REXDEX_SOURCE, 'RexDex'],
      [WC_XTREAM_SOURCE, 'World Cup IPTV'],
      ['nebulasports', 'Nebula Sports'],
      ['hellosports', 'Hello Sports'],
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
      'nebulasports',
      'hellosports',
      'sportzx'
    ]);
    if (knownSourceLabels.has(normalizedLanguage)) return '';
    return language;
  }

  buildPlaybackCardTitle(stream = {}, hls = {}) {
    const profile = hls?.playbackProfile || this.getCachedHlsPlaybackProfile(hls?.url) || this.inferStreamPlaybackProfile(stream);
    const sourceLabel = this.formatStreamSourceLabel(stream?.source);
    const languageLabel = this.getStreamLanguageLabel(stream, sourceLabel);
    return [
      `Recommended speed: ${profile.speedMbps || 5} Mbps+`,
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

    const dlhdSources = await this.getDlhdSourcesForMatch(match, signal).catch((error) => {
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
    if (Date.now() >= REXDEX_PORTUGAL_UZBEKISTAN_UNTIL_MS) return [];
    if (!isPortugalUzbekistanMatch(match)) return [];
    return [{
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
    }];
  }

  async getEventStreams(id, options = null) {
    const signal = options && typeof options === 'object' && 'signal' in options
      ? options.signal
      : options || null;
    const baseUrl = options?.baseUrl || '';
    const privateConfigId = options?.privateConfigId || '';
    const prewarm = options?.prewarm !== false;
    const match = await this.findMatch(id, signal);
    if (!match) return [];

    const dlhdSources = await this.getDlhdSourcesForMatch(match, signal).catch((error) => {
      this.logger.debug?.('dlhd event match failed', {
        match: match.sourceId || match.id,
        error: error?.message || String(error)
      });
      return [];
    });
    const eventSources = [...this.filterSupplementalSources(match.sources), ...dlhdSources];
    const collectedStreams = await this.collectEventSourceStreams(eventSources, signal);
    const rankedStreams = [
      ...this.getTemporaryEventDirectStreams(match),
      ...collectedStreams
    ].sort(compareStreamsBySourceRank);
    const streams = rankedStreams.slice(0, 12);
    const playableHlsByKey = new Map();
    let displayStreams = streams;
    const externalCardsPromise = SUPPLEMENTAL_SPORTS_SOURCES_ENABLED && isFifaWorldCupMatch(match)
      ? Promise.all([
        this.getPlayableLicensedExternalCards(match, { baseUrl, signal }),
      ]).then((groups) => groups.flat())
      : Promise.resolve([]);
    if (baseUrl && privateConfigId) {
      const playableKeys = new Set();
      const directHlsResults = this.getTrustedDirectHlsResults(rankedStreams, playableKeys);
      const validationStreams = (this.hlsProbeEnabled || this.hlsBrowserFallbackEnabled)
        ? this.getStreamValidationCandidates(rankedStreams.filter((stream) => {
          const sourceKey = normalizeIdPart(stream?.source);
          const streamNo = stream?.streamNo || 1;
          return !playableKeys.has(`${sourceKey}:${toString(stream?.id)}:${toString(streamNo)}`);
        }))
        : [];
      const needsStreamedProbeBudget = validationStreams.some((stream) =>
        ['admin', 'delta', 'echo', 'golf', 'nebulasports'].includes(normalizeIdPart(stream?.source))
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
      displayStreams = [...directHlsResults, ...playableResults]
        .map((result) => {
          const { stream, hls } = result;
          playableHlsByKey.set(`${stream.source}:${stream.id}:${stream.streamNo || 1}`, hls);
          return stream;
        })
        .sort(compareStreamsBySourceRank)
        .slice(0, 12);
    }
    const cards = displayStreams.map((stream) => {
        const hls = playableHlsByKey.get(`${stream.source}:${stream.id}:${stream.streamNo || 1}`);
        const privateUrl = this.getPrivateStreamUrl(stream, { baseUrl, privateConfigId });
        const playbackUrl = privateUrl && hls?.url
          ? (hls.resolveOnPlayback
            ? privateUrl
            : [
            `${privateUrl}?url=${Buffer.from(hls.url).toString('base64url')}`,
            hls.contextUrl ? `ctx=${Buffer.from(hls.contextUrl).toString('base64url')}` : ''
          ].filter(Boolean).join('&'))
          : null;
        if (!playbackUrl) return null;
        const sourceLabel = this.formatStreamSourceLabel(stream?.source);
        return {
          name: sourceLabel ? `NebulaStreams ${sourceLabel}` : 'NebulaStreams Streamed',
          title: this.buildPlaybackCardTitle(stream, hls),
          url: playbackUrl,
          behaviorHints: {
            bingeGroup: `streamed-${match.normalizedTitle}`
          }
        };
      }).filter(Boolean);
    const externalCards = await externalCardsPromise;
    if (prewarm && baseUrl && privateConfigId && this.hlsCacheMs > 0) {
      this.prewarmStreams(this.getStreamValidationCandidates(rankedStreams).slice(0, 2));
    }
    return [
      ...cards.slice(0, 2),
      ...externalCards,
      ...cards.slice(2)
    ];
  }

  getEmbedUrl({ source, streamId, streamNo }) {
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
    const trustedSources = new Set([FLIX_DLSTREAMS_SOURCE, CDNLIVETV_SOURCE, SPORTSBITE_SOURCE, STREAMFREE_SOURCE, REXDEX_SOURCE]);
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
          resolveOnPlayback: this.shouldResolveDirectHlsOnPlayback(stream.source),
          playbackProfile: stream.playbackProfile || this.inferStreamPlaybackProfile(stream)
        }
      });
    }
    return results;
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
          headers: stream.headers || this.getSportsBiteHeaders({
            accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*'
          }),
          resolveOnPlayback: this.shouldResolveDirectHlsOnPlayback(stream.source)
        };
      }
      if (!hls) {
        const probed = await this.resolvePlayableHlsWithProbe(embedUrl, validationSignal);
        if (probed?.url) {
          hls = {
            url: probed.url,
            contextUrl: embedUrl,
            headers: {
              ...this.getBrowserFetchHeaders(),
              origin: 'https://exposestrat.com',
              referer: 'https://exposestrat.com/maestrohd1.php'
            },
            resolveOnPlayback: this.requiresBrowserHlsContext(probed.url)
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
            headers: this.getBrowserFetchHeaders(),
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
      headers: this.getBrowserFetchHeaders(),
      resolveOnPlayback: this.requiresBrowserHlsContext(hlsUrl)
    };

    const cachedPlaylist = this.getCachedPlaylist(hlsUrl);
    if (cachedPlaylist?.body?.toString('utf8').includes('#EXTM3U')) {
      hls.playbackProfile = this.extractHlsPlaybackProfile(cachedPlaylist.body.toString('utf8')) || undefined;
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
    this.setCachedHls(cacheKey, hls);
    await this.setSharedHls(cacheKey, hls);
    return { stream, hls };
  }

  getCachedHls(cacheKey) {
    const cached = this.hlsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
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
    await this.writeSharedCache(`hls:${cacheKey}`, value, this.hlsCacheMs).catch(() => {});
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

  async validateDirectHlsUrl(url, signal = null, headers = null) {
    const validationSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, AbortSignal.timeout(4_000)])
      : AbortSignal.timeout(4_000);
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
        ...(headers || {})
      },
      redirect: 'follow',
      signal: validationSignal
    });
    if (!response.ok) {
      throw new Error(`Direct HLS HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text.includes('#EXTM3U')) {
      throw new Error('Direct HLS playlist is not playable');
    }
    const fetched = {
      status: response.status,
      url: response.url || url,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(text)
    };
    this.setCachedPlaylist(url, fetched);
    await this.setSharedPlaylist(url, fetched);
    return this.extractHlsPlaybackProfile(text);
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
          if (hls?.url) this.prewarmPlaylist(hls.url, { delayMs: 250 });
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
    return freemem() >= MIN_BROWSER_PREWARM_FREE_BYTES
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
      if (Date.now() >= REXDEX_PORTUGAL_UZBEKISTAN_UNTIL_MS || normalizedStreamId !== REXDEX_PORTUGAL_UZBEKISTAN_STREAM_ID) {
        throw new Error('RexDex temporary stream expired');
      }
      const value = {
        url: REXDEX_PORTUGAL_UZBEKISTAN_HLS,
        contextUrl: REXDEX_PORTUGAL_UZBEKISTAN_PAGE,
        headers: {
          ...this.getBrowserFetchHeaders(),
          accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
          origin: 'https://www.rexdexsports.in',
          referer: REXDEX_PORTUGAL_UZBEKISTAN_PAGE
        },
        playbackProfile: {
          quality: 'HD',
          speedMbps: 8
        }
      };
      this.setCachedHls(cacheKey, value);
      await this.setSharedHls(cacheKey, value);
      return value;
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
        this.setCachedHls(cacheKey, value);
        await this.setSharedHls(cacheKey, value);
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
    const probed = await this.resolvePlayableHlsWithProbe(embedUrl, signal);
    if (probed?.url) {
      const value = {
        url: probed.url,
        contextUrl: embedUrl,
        headers: {
          ...this.getBrowserFetchHeaders(),
          origin: 'https://exposestrat.com',
          referer: 'https://exposestrat.com/maestrohd1.php'
        },
        resolveOnPlayback: this.requiresBrowserHlsContext(probed.url)
      };
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
      headers: this.getBrowserFetchHeaders(),
      resolveOnPlayback: this.requiresBrowserHlsContext(hlsUrl)
    };
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
          throw error;
        });
    }
    return this.browserPromise;
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
