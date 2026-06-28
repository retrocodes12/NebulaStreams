import crypto from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import express from 'express';

import { config } from './config.js';
import { CacheManager } from './services/cacheManager.js';
import { HttpProxyService } from './services/httpProxy.js';
import { ImdbResolverService } from './services/imdbResolver.js';
import { ProviderService } from './services/providerService.js';
import { ReverseProxyService } from './services/reverseProxy.js';
import { SourceRegistry } from './services/sourceRegistry.js';
import { StreamManager, HttpError } from './services/streamManager.js';
import { TorrentEngineService } from './services/torrentEngine.js';
import { UserTrackerService } from './services/userTracker.js';
import { SupporterService } from './services/supporterService.js';
import { SportsSupporterService } from './services/sportsSupporterService.js';
import { EmailService } from './services/emailService.js';
import { logger } from './utils/logger.js';

const getHeapUsagePercent = () => {
  const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
  return heapLimitBytes > 0 ? (process.memoryUsage().heapUsed / heapLimitBytes) * 100 : 0;
};

if (!config.VERBOSE_INFO_LOGS) {
  console.log = () => {};
  const shouldSuppressProviderConsoleNoise = (args) => {
    const message = args.map((arg) => String(arg ?? '')).join(' ');
    if (message.trim().startsWith('{')) return false;
    return /\b(?:Provider request cancelled|skipped: HTTP 403|Kwik extraction failed: HTTP 403|Failed to fetch page: 403|Failed to fetch movie page|Response does not indicate success: 403|HTTP 404 Not Found|fetch failed)\b/iu
      .test(message);
  };
  const originalConsoleWarn = console.warn.bind(console);
  const originalConsoleError = console.error.bind(console);
  console.warn = (...args) => {
    if (shouldSuppressProviderConsoleNoise(args)) return;
    originalConsoleWarn(...args);
  };
  console.error = (...args) => {
    if (shouldSuppressProviderConsoleNoise(args)) return;
    originalConsoleError(...args);
  };
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const clampPosterText = (value, max = 72) => {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
};

const SPORTS_ADDON_VERSION = '1.0.9';
const SPORTS_POSTER_VERSION = 'v8';
const posterImageCache = new Map();
const POSTER_IMAGE_CACHE_MAX = 320;

const wrapPosterLines = (value, maxChars = 18, maxLines = 4) => {
  const words = String(value || 'Sports Event')
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
      continue;
    }
    line = next;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.join(' ').length > lines.join(' ').length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(0, maxChars - 1)).trim()}…`;
  }
  return lines.length ? lines : ['Sports Event'];
};

const buildNebulaPosterTitleSvg = (title) => {
  const text = clampPosterText(title || 'Sports Event', 80);
  const versusParts = text.split(/\s+(?:vs\.?|v)\s+/iu)
    .map((part) => part.trim())
    .filter(Boolean);
  if (versusParts.length === 2) {
    const home = wrapPosterLines(versusParts[0], 15, 2);
    const away = wrapPosterLines(versusParts[1], 15, 2);
    const homeY = home.length === 1 ? 380 : 342;
    const awayY = away.length === 1 ? 622 : 586;
    return [
      ...home.map((line, index) => `<text x="360" y="${homeY + (index * 70)}" text-anchor="middle" class="team">${escapeHtml(line.toUpperCase())}</text>`),
      '<text x="360" y="506" text-anchor="middle" class="versus">VS</text>',
      ...away.map((line, index) => `<text x="360" y="${awayY + (index * 70)}" text-anchor="middle" class="team">${escapeHtml(line.toUpperCase())}</text>`)
    ].join('');
  }

  const lines = wrapPosterLines(text, 15, 4);
  const firstY = 410 - ((lines.length - 1) * 42);
  return lines
    .map((line, index) => `<text x="360" y="${firstY + (index * 78)}" text-anchor="middle" class="title">${escapeHtml(line.toUpperCase())}</text>`)
    .join('');
};

const getNebulaPosterAccent = (meta = '', kind = 'event') => {
  const text = `${meta} ${kind}`.toLowerCase();
  if (text.includes('cricket')) return ['#22c55e', '#a3e635'];
  if (text.includes('football') || text.includes('soccer') || text.includes('fifa')) return ['#1faa6e', '#38bdf8'];
  if (text.includes('basketball') || text.includes('nba')) return ['#f97316', '#22d3ee'];
  if (text.includes('fight') || text.includes('ufc') || text.includes('boxing')) return ['#ef4444', '#f59e0b'];
  if (text.includes('tennis')) return ['#84cc16', '#22c55e'];
  if (text.includes('live tv') || text.includes('channel')) return ['#38bdf8', '#1faa6e'];
  return ['#1faa6e', '#22d3ee'];
};

const buildNebulaSportsPosterSvg = ({ title, meta, timeLabel, badge, sources, kind, info }) => {
  const [accent, accent2] = getNebulaPosterAccent(meta, kind);
  const isLive = /^live/iu.test(String(timeLabel || '')) || /^live$/iu.test(String(badge || ''));
  const badgeLabel = clampPosterText(badge || (isLive ? 'LIVE' : 'EVENT'), 18).toUpperCase();
  const metaLabel = clampPosterText(meta || (kind === 'channel' ? 'Live TV' : 'Sports'), 34).toUpperCase();
  const time = clampPosterText(timeLabel || 'Starting soon', 42).toUpperCase();
  const lowerInfo = clampPosterText(info || sources || 'Nebula Sports', 54).toUpperCase();
  const titleSvg = buildNebulaPosterTitleSvg(title);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1080" viewBox="0 0 720 1080" role="img" aria-label="${escapeHtml(title || 'Nebula Sports poster')}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#06090d"/>
      <stop offset="0.48" stop-color="#0d1515"/>
      <stop offset="1" stop-color="#111827"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="44%" r="64%">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.28"/>
      <stop offset="0.48" stop-color="${accent2}" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="${accent}" stroke-opacity="0.08" stroke-width="1"/>
    </pattern>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="22" stdDeviation="20" flood-color="#000" flood-opacity="0.42"/>
    </filter>
    <style>
      .micro{font:700 18px Inter,Arial,sans-serif;letter-spacing:3px;fill:#d8f5e6}
      .pill{font:800 20px Inter,Arial,sans-serif;letter-spacing:2px;fill:#03100a}
      .team,.title{font:900 62px Inter,Arial,sans-serif;letter-spacing:0;fill:#f7fbff}
      .versus{font:900 30px Inter,Arial,sans-serif;letter-spacing:4px;fill:${accent2}}
      .meta{font:800 24px Inter,Arial,sans-serif;letter-spacing:2px;fill:#d8f5e6}
      .time{font:900 34px Inter,Arial,sans-serif;letter-spacing:1px;fill:#ffffff}
      .sub{font:700 18px Inter,Arial,sans-serif;letter-spacing:1.6px;fill:#96a6b8}
    </style>
  </defs>
  <rect width="720" height="1080" fill="url(#bg)"/>
  <rect width="720" height="1080" fill="url(#grid)"/>
  <rect width="720" height="1080" fill="url(#glow)"/>
  <path d="M42 54H678V1026H42Z" fill="none" stroke="${accent}" stroke-opacity="0.42" stroke-width="2"/>
  <path d="M64 78H250M470 78H656M64 1002H250M470 1002H656" fill="none" stroke="${accent2}" stroke-opacity="0.5" stroke-width="3"/>
  <circle cx="360" cy="510" r="238" fill="none" stroke="${accent}" stroke-opacity="0.12" stroke-width="2"/>
  <circle cx="360" cy="510" r="176" fill="none" stroke="${accent2}" stroke-opacity="0.12" stroke-width="1"/>
  <path d="M132 510H588" stroke="${accent}" stroke-opacity="0.15" stroke-width="2"/>
  <path d="M360 258V762" stroke="${accent2}" stroke-opacity="0.10" stroke-width="2"/>
  <g transform="translate(64 86)">
    <rect x="0" y="0" width="224" height="46" rx="8" fill="#0b1115" stroke="${accent}" stroke-opacity="0.55"/>
    <text x="20" y="30" class="micro">NEBULA SPORTS</text>
  </g>
  <g transform="translate(538 86)">
    <rect x="0" y="0" width="118" height="46" rx="23" fill="${isLive ? accent : '#d8f5e6'}"/>
    <text x="59" y="31" text-anchor="middle" class="pill">${escapeHtml(badgeLabel)}</text>
  </g>
  <g filter="url(#softShadow)">${titleSvg}</g>
  <g transform="translate(84 814)">
    <rect x="0" y="0" width="552" height="116" rx="14" fill="#071014" stroke="${accent}" stroke-opacity="0.42"/>
    <text x="34" y="43" class="meta">${escapeHtml(metaLabel)}</text>
    <text x="34" y="88" class="time">${escapeHtml(time)}</text>
  </g>
  <text x="360" y="972" text-anchor="middle" class="sub">${escapeHtml(lowerInfo)}</text>
  <text x="360" y="1012" text-anchor="middle" class="sub" fill="${accent2}">PRIVATE STREMIO SPORTS ADDON</text>
</svg>`;
};

const compareVersionParts = (left, right) => {
  const a = String(left || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

const buildSportsPosterUrl = (baseUrl, { id = '', name = '', genre = '', kind = 'event', time = '', info = '', badge = '' } = {}) => {
  const normalizedBase = String(baseUrl || '').replace(/\/+$/u, '');
  const sig = crypto.createHash('sha1').update(`${SPORTS_POSTER_VERSION}:${id}:${name}:${genre}:${kind}:${time}:${info}`).digest('hex').slice(0, 10);
  const params = new URLSearchParams({
    title: clampPosterText(name || 'Sports Event', 80),
    genre: clampPosterText(genre || (kind === 'channel' ? 'Live TV' : 'Sports'), 32),
    meta: clampPosterText(genre || (kind === 'channel' ? 'Live TV' : 'Sports'), 44),
    time: clampPosterText(time || (kind === 'channel' ? 'Live now' : 'Starting soon'), 44),
    info: clampPosterText(info || (kind === 'channel' ? '24/7 sports channel' : 'Live event stream'), 70),
    badge: clampPosterText(badge || (kind === 'channel' ? 'LIVE TV' : 'EVENT'), 18),
    sources: 'Nebula Sports',
    kind: String(kind || 'event').slice(0, 24),
    sig
  });
  return `${normalizedBase}/sports/poster/${SPORTS_POSTER_VERSION}/${sig}.jpg?${params.toString()}`;
};

const VIDKING_BASE_URL = 'https://www.vidking.net';
const MOVIE_EMBED_PROVIDERS = Object.freeze({
  vidking: {
    id: 'vidking',
    name: 'VidKing',
    movieUrl: 'https://vidking.net/embed/movie/{id}',
    tvUrl: 'https://vidking.net/embed/tv/{id}/{s}/{e}',
    supportsVidkingOptions: true
  },
  videasy: {
    id: 'videasy',
    name: 'Videasy',
    movieUrl: 'https://player.videasy.net/movie/{id}',
    tvUrl: 'https://player.videasy.net/tv/{id}/{s}/{e}'
  },
  vidsrcCc: {
    id: 'vidsrcCc',
    name: 'VidSrc CC',
    movieUrl: 'https://vsembed.ru/embed/movie/{id}',
    tvUrl: 'https://vsembed.ru/embed/tv/{id}/{s}/{e}'
  },
  twoEmbed: {
    id: 'twoEmbed',
    name: '2Embed',
    movieUrl: 'https://2embed.cc/embed/movie/{id}',
    tvUrl: 'https://2embed.cc/embed/tv/{id}?s={s}&e={e}'
  },
  vidfast: {
    id: 'vidfast',
    name: 'VidFast',
    movieUrl: 'https://vidfast.pro/movie/{id}',
    tvUrl: 'https://vidfast.pro/tv/{id}/{s}/{e}'
  },
  vidcore: {
    id: 'vidcore',
    name: 'VidCore',
    movieUrl: 'https://vidcore.net/embed/movie/{id}',
    tvUrl: 'https://vidcore.net/embed/tv/{id}/{s}/{e}'
  },
  rive: {
    id: 'rive',
    name: 'Rive',
    movieUrl: 'https://rivestream.org/embed?type=movie&id={id}',
    tvUrl: 'https://rivestream.org/embed?type=tv&id={id}&season={s}&episode={e}'
  },
  vidzee: {
    id: 'vidzee',
    name: 'VidZee',
    movieUrl: 'https://player.vidzee.wtf/embed/movie/{id}',
    tvUrl: 'https://player.vidzee.wtf/embed/tv/{id}?season={s}&episode={e}'
  },
  airflix: {
    id: 'airflix',
    name: 'Airflix',
    movieUrl: 'https://airflix1.com/movie/{id}',
    tvUrl: 'https://airflix1.com/tv/{id}/{s}/{e}'
  },
  vidsync: {
    id: 'vidsync',
    name: 'VidSync',
    movieUrl: 'https://vidsync.xyz/embed/movie/{id}',
    tvUrl: 'https://vidsync.xyz/embed/tv/{id}/{s}/{e}'
  },
  vidrock: {
    id: 'vidrock',
    name: 'VidRock',
    movieUrl: 'https://vidrock.net/embed/movie/{id}',
    tvUrl: 'https://vidrock.net/embed/tv/{id}/{s}/{e}'
  },
  hexa: {
    id: 'hexa',
    name: 'Hexa',
    movieUrl: 'https://hexa.su/embed/movie/{id}',
    tvUrl: 'https://hexa.su/embed/tv/{id}/{s}/{e}'
  },
  vidora: {
    id: 'vidora',
    name: 'VidOra',
    movieUrl: 'https://vidora.su/embed/movie/{id}',
    tvUrl: 'https://vidora.su/embed/tv/{id}/{s}/{e}'
  },
  peachify: {
    id: 'peachify',
    name: 'Peachify',
    movieUrl: 'https://peachify.top/embed/movie/{id}',
    tvUrl: 'https://peachify.top/embed/tv/{id}?season={s}&episode={e}'
  },
  mapple: {
    id: 'mapple',
    name: 'Mapple TV',
    movieUrl: 'https://mappletv.uk/embed/movie/{id}',
    tvUrl: 'https://mappletv.uk/embed/tv/{id}/{s}/{e}'
  },
  toustream: {
    id: 'toustream',
    name: 'TouStream',
    movieUrl: 'https://toustream-play.chickenkiller.com/movie/{id}',
    tvUrl: 'https://toustream-play.chickenkiller.com/tv/{id}/{s}/{e}'
  },
  vidsrcEmbed: {
    id: 'vidsrcEmbed',
    name: 'VidSrc Embed',
    movieUrl: 'https://vidsrc-embed.ru/embed/movie/{id}',
    tvUrl: 'https://vidsrc-embed.ru/embed/tv/{id}/{s}/{e}'
  },
  oneElevenMovies: {
    id: 'oneElevenMovies',
    name: '111Movies',
    movieUrl: 'https://111movies.net/movie/{id}',
    tvUrl: 'https://111movies.net/tv/{id}?s={s}&e={e}'
  },
  fmovies: {
    id: 'fmovies',
    name: 'FMovies',
    movieUrl: 'https://fmovies.gd/movie/{id}',
    tvUrl: 'https://fmovies.gd/tv/{id}?s={s}&e={e}'
  },
  cinemaos: {
    id: 'cinemaos',
    name: 'CinemaOS',
    movieUrl: 'https://cinemaos.tech/embed/movie/{id}',
    tvUrl: 'https://cinemaos.tech/embed/tv/{id}?s={s}&e={e}'
  }
});
const MOVIE_EMBED_PROVIDER_LIST = Object.freeze(Object.values(MOVIE_EMBED_PROVIDERS));
const CINEMETA_BASE_URL = 'https://v3-cinemeta.strem.io';
const AIO_METADATA_BASE_URL = 'https://aiometadata.viren070.me/stremio/ed602812-df91-4c90-a697-be9b911ebb28';
const CATALOG_SOURCES = Object.freeze({
  cinemeta: {
    id: 'cinemeta',
    name: 'Cinemeta',
    baseUrl: CINEMETA_BASE_URL
  },
  aio: {
    id: 'aio',
    name: 'AIOMetadata',
    baseUrl: AIO_METADATA_BASE_URL
  }
});

const getCatalogSource = (value) => CATALOG_SOURCES[String(value || '').trim().toLowerCase()] || CATALOG_SOURCES.cinemeta;

const toPositiveIntegerString = (value, fallback = '') => {
  const normalized = String(value ?? fallback).trim();
  return /^[1-9]\d*$/u.test(normalized) ? normalized : '';
};

const toBooleanQuery = (value) => String(value ?? '').trim().toLowerCase() === 'true';

const getMovieEmbedProvider = (value) =>
  MOVIE_EMBED_PROVIDERS[String(value || '').trim()] || MOVIE_EMBED_PROVIDERS.vidking;

const applyEmbedTemplate = (template, replacements) =>
  template
    .replaceAll('{id}', replacements.id)
    .replaceAll('{s}', replacements.seasonId)
    .replaceAll('{e}', replacements.episodeId);

const buildVidkingEmbedUrl = ({
  provider,
  type = 'movie',
  tmdbId,
  season,
  episode,
  color = '4F9EFF',
  autoPlay = false,
  nextEpisode = false,
  episodeSelector = false,
  progress
} = {}) => {
  const mediaType = type === 'tv' || type === 'series' ? 'tv' : 'movie';
  const id = toPositiveIntegerString(tmdbId);
  if (!id) {
    throw new HttpError(400, 'Valid tmdbId is required');
  }

  const seasonId = toPositiveIntegerString(season, '1') || '1';
  const episodeId = toPositiveIntegerString(episode, '1') || '1';
  const embedProvider = getMovieEmbedProvider(provider);
  const template = mediaType === 'tv' ? embedProvider.tvUrl : embedProvider.movieUrl;
  const embedUrl = applyEmbedTemplate(template, { id, seasonId, episodeId });
  const url = new URL(embedUrl);
  const cleanColor = String(color || '4F9EFF').replace(/^#/u, '').trim();

  if (embedProvider.supportsVidkingOptions && /^[0-9a-f]{6}$/iu.test(cleanColor)) {
    url.searchParams.set('color', cleanColor);
  }
  if (embedProvider.supportsVidkingOptions && autoPlay) url.searchParams.set('autoPlay', 'true');
  if (embedProvider.supportsVidkingOptions && mediaType === 'tv' && nextEpisode) url.searchParams.set('nextEpisode', 'true');
  if (embedProvider.supportsVidkingOptions && mediaType === 'tv' && episodeSelector) url.searchParams.set('episodeSelector', 'true');

  const startAt = Number(progress);
  if (embedProvider.supportsVidkingOptions && Number.isFinite(startAt) && startAt > 0) {
    url.searchParams.set('progress', String(Math.floor(startAt)));
  }

  return {
    url: url.toString(),
    embedPath: url.pathname,
    provider: {
      id: embedProvider.id,
      name: embedProvider.name
    },
    mediaType,
    tmdbId: id,
    season: mediaType === 'tv' ? seasonId : null,
    episode: mediaType === 'tv' ? episodeId : null
  };
};

const fetchJsonWithTimeout = async (url, timeoutMs = 12_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) {
      throw new HttpError(response.status, `Upstream request failed: ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

const extractTmdbId = (meta = {}) => {
  const direct = String(meta._tmdbId || meta.tmdb_id || meta.moviedb_id || '').trim();
  if (/^[1-9]\d*$/u.test(direct)) return direct;
  const slugMatch = String(meta.slug || '').match(/tmdb:(\d+)/u);
  return slugMatch ? slugMatch[1] : '';
};

const normalizeCatalogMeta = (meta = {}) => {
  const mediaType = meta.type === 'series' ? 'tv' : 'movie';
  const genres = Array.isArray(meta.genres)
    ? meta.genres
    : (Array.isArray(meta.genre) ? meta.genre : [meta.genre].filter(Boolean));
  return {
    id: String(meta.id || meta.imdb_id || '').trim(),
    type: mediaType,
    catalogType: meta.type === 'series' ? 'series' : 'movie',
    tmdbId: extractTmdbId(meta),
    imdbId: String(meta.imdb_id || meta._imdbId || meta.id || '').trim(),
    name: String(meta.name || '').trim(),
    description: String(meta.description || '').trim(),
    year: String(meta.year || meta.releaseInfo || '').trim(),
    runtime: String(meta.runtime || '').trim(),
    rating: String(meta.imdbRating || '').trim(),
    genres: genres.slice(0, 3).map(String),
    poster: String(meta.poster || meta._rawPosterUrl || '').trim(),
    background: String(meta.landscapePoster || meta.background || meta.poster || '').trim(),
    season: mediaType === 'tv' ? '1' : null,
    episode: mediaType === 'tv' ? '1' : null
  };
};

const normalizeAioCatalog = (catalog = {}) => ({
  id: String(catalog.id || '').trim(),
  type: catalog.type === 'series' ? 'series' : 'movie',
  name: String(catalog.name || catalog.id || '').trim(),
  pageSize: Number(catalog.pageSize || 20),
  showInHome: catalog.showInHome !== false,
  extras: Array.isArray(catalog.extra) ? catalog.extra : []
});

const normalizeAddonCatalog = normalizeAioCatalog;

const encodeCatalogExtra = (name, value) => {
  const cleanName = String(name || '').trim();
  const cleanValue = String(value || '').trim();
  if (!cleanName || !cleanValue) return '';
  return `${encodeURIComponent(cleanName)}=${encodeURIComponent(cleanValue)}`;
};

const PROJECT_SUPPORTERS = [
  'Devon Durham',
  'Shadow',
  'S10skillz'
];

const renderSupporterPills = (supporters = PROJECT_SUPPORTERS) => supporters
  .map((supporter) => `<span class="supporter-pill">${escapeHtml(supporter)}</span>`)
  .join('');

const ADMIN_COOKIE_NAME = 'nebulastreams_admin';
const SUPPORTER_COOKIE_NAME = 'nebulastreams_supporter';
const SPORTS_COOKIE_NAME = 'nebula_sports';
const WATCH_CHAT_COOKIE_NAME = 'nebula_watch_chat';
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CPU_SAMPLE_WINDOW_MS = 200;
const { readFile } = fsPromises;
const SMTP2GO_WEBHOOK_STORE_PATH = path.join(config.CACHE_DIR, 'smtp2go-webhooks.json');

const sleep = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

const maskEmailAddress = (email) => {
  const [user, domain] = String(email || '').trim().toLowerCase().split('@');
  if (!user || !domain) return '';
  return `${user.slice(0, 2) || '*'}***@${domain.slice(0, 1)}***`;
};

const normalizeWebhookEmail = (value) => String(value || '').trim().toLowerCase();

const hashWebhookEmail = (email) =>
  crypto.createHash('sha256').update(`smtp2go:${normalizeWebhookEmail(email)}`).digest('hex');

const getSmtp2goEvents = (body = {}) => {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.events)) return body.events;
  if (Array.isArray(body.data)) return body.data;
  if (body && typeof body === 'object') return [body];
  return [];
};

const getSmtp2goEmail = (event = {}) => normalizeWebhookEmail(
  event.recipient
    || event.email
    || event.to
    || event.rcpt
    || event.rcpt_to
    || event.address
    || event.envelope_to
    || ''
);

const getSmtp2goEventType = (event = {}) => String(
  event.event
    || event.type
    || event.event_type
    || event.category
    || event.status
    || ''
).trim().toLowerCase();

const isSmtp2goSuppressionEvent = (event = {}) => {
  const eventType = getSmtp2goEventType(event);
  const bounceType = String(event.bounce_type || event.bounceType || event.classification || '').trim().toLowerCase();
  return /(?:bounce|reject|complaint|spam|unsubscribe|blocked|dropped|failed)/u.test(eventType)
    || /(?:hard|permanent|complaint|spam|blocked)/u.test(bounceType);
};

const compactSmtp2goEvent = (event = {}) => {
  const email = getSmtp2goEmail(event);
  const message = String(
    event.reason
      || event.error
      || event.smtp_response
      || event.response
      || event.description
      || event.message
      || ''
  ).slice(0, 500);
  return {
    receivedAt: new Date().toISOString(),
    provider: 'smtp2go',
    event: getSmtp2goEventType(event) || 'unknown',
    suppressed: isSmtp2goSuppressionEvent(event),
    emailMasked: maskEmailAddress(email),
    emailHash: email ? hashWebhookEmail(email) : '',
    messageId: String(event.message_id || event.messageId || event.email_id || event.emailId || event.id || '').slice(0, 160),
    reason: message
  };
};

const readSmtp2goWebhookStore = async () => {
  try {
    const raw = await fsPromises.readFile(SMTP2GO_WEBHOOK_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      events: Array.isArray(parsed.events) ? parsed.events : [],
      suppressions: parsed.suppressions && typeof parsed.suppressions === 'object' ? parsed.suppressions : {}
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, events: [], suppressions: {} };
    }
    throw error;
  }
};

const recordSmtp2goWebhookEvents = async (events = []) => {
  const compactEvents = events
    .map(compactSmtp2goEvent)
    .filter((event) => event.emailHash || event.messageId || event.event !== 'unknown');
  const store = await readSmtp2goWebhookStore();

  for (const event of compactEvents) {
    store.events.push(event);
    if (event.suppressed && event.emailHash) {
      const current = store.suppressions[event.emailHash] || {
        emailMasked: event.emailMasked,
        count: 0
      };
      store.suppressions[event.emailHash] = {
        ...current,
        emailMasked: event.emailMasked || current.emailMasked,
        count: Number(current.count || 0) + 1,
        lastEventAt: event.receivedAt,
        lastEvent: event.event,
        lastReason: event.reason
      };
    }
  }

  store.events = store.events.slice(-1000);
  await fsPromises.mkdir(path.dirname(SMTP2GO_WEBHOOK_STORE_PATH), { recursive: true });
  await fsPromises.writeFile(SMTP2GO_WEBHOOK_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
  return {
    received: compactEvents.length,
    suppressed: compactEvents.filter((event) => event.suppressed).length
  };
};

const parseKofiWebhookPayload = (body = {}) => {
  if (typeof body.data === 'string') {
    return JSON.parse(body.data);
  }
  if (typeof body.data === 'object' && body.data) {
    return body.data;
  }
  return body;
};

const getKofiTransactionId = (payload = {}) =>
  String(payload.kofi_transaction_id || payload.message_id || payload.transaction_id || '').trim();

const getKofiAmount = (payload = {}) => {
  const parsed = Number.parseFloat(String(payload.amount || payload.amount_gross || '0'));
  return Number.isFinite(parsed) ? parsed : 0;
};

const getKofiPageName = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return 'retro76005';

  try {
    const parsed = new URL(raw);
    const pageName = parsed.pathname.split('/').filter(Boolean)[0];
    return pageName || 'retro76005';
  } catch {
    return raw
      .replace(/^https?:\/\/(?:www\.)?ko-fi\.com\//iu, '')
      .split(/[/?#]/u)[0]
      .trim() || 'retro76005';
  }
};

const getKofiText = (payload = {}) => [
  payload.message,
  payload.from_name,
  payload.type,
  payload.shop_items,
  payload.shop_item,
  payload.product,
  payload.product_name,
  payload.tier_name
].map((value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => typeof entry === 'object' ? Object.values(entry).join(' ') : String(entry)).join(' ');
  }
  if (value && typeof value === 'object') {
    return Object.values(value).join(' ');
  }
  return String(value || '');
}).join(' ').toLowerCase();

const isSportsKofiPayment = (payload = {}, amount = 0) => {
  const text = getKofiText(payload);
  return /\b(?:nebula\s*sports|sports\s*addon|sports\s*access|nsports)\b/iu.test(text)
    || (amount >= 3 && amount < 5)
    || amount >= 10;
};

const SPORTS_LAUNCH_PROMO_END_AT = Date.parse('2026-06-29T00:00:00.000Z');
const isSportsLaunchPromoActive = (now = Date.now()) => now < SPORTS_LAUNCH_PROMO_END_AT;
const getSportsKofiTier = (amount, now = Date.now()) => {
  const paidAmount = Number(amount) || 0;
  if (paidAmount >= 15) return 'premium-future';
  if (isSportsLaunchPromoActive(now)) {
    return paidAmount >= 3 ? 'lifetime' : 'monthly';
  }
  return paidAmount >= 7 ? 'lifetime' : 'monthly';
};

const createUptimeKumaProxy = ({ targetBaseUrl, mountPath = '/status' }) => {
  const target = new URL(targetBaseUrl);
  const client = target.protocol === 'https:' ? https : http;
  const agent = target.protocol === 'https:'
    ? new https.Agent({ keepAlive: true, maxSockets: 32 })
    : new http.Agent({ keepAlive: true, maxSockets: 32 });

  const rewriteSetCookie = (headers) => {
    const cookies = headers['set-cookie'];
    if (!Array.isArray(cookies)) {
      return;
    }

    headers['set-cookie'] = cookies.map((cookie) => {
      if (/;\s*path=/iu.test(cookie)) {
        return cookie.replace(/;\s*path=[^;]*/iu, `; Path=${mountPath}`);
      }

      return `${cookie}; Path=${mountPath}`;
    });
  };

  const rewriteLocation = (headers) => {
    const location = headers.location;
    if (typeof location !== 'string' || !location.startsWith('/')) {
      return;
    }

    if (location === mountPath || location.startsWith(`${mountPath}/`)) {
      return;
    }

    headers.location = `${mountPath}${location === '/' ? '' : location}`;
  };

  const getUpstreamPath = (req) => {
    const originalUrl = req.originalUrl || req.url || '/';
    if (originalUrl === mountPath) {
      return '/';
    }

    if (originalUrl.startsWith(`${mountPath}/`)) {
      const unmountedPath = originalUrl.slice(mountPath.length) || '/';
      const pathOnly = unmountedPath.split('?', 1)[0];
      const firstSegment = pathOnly.split('/').filter(Boolean)[0] || '';
      const rootRoutes = new Set([
        'add',
        'add-maintenance',
        'add-status-page',
        'api',
        'assets',
        'clone',
        'dashboard',
        'edit',
        'empty',
        'icon.svg',
        'list',
        'maintenance',
        'manage-status-page',
        'manifest.json',
        'page-not-found',
        'serviceWorker.js',
        'settings',
        'setup',
        'setup-database',
        'setup-database-info',
        'socket.io',
        'upload'
      ]);

      return rootRoutes.has(firstSegment) ? unmountedPath : `${mountPath}${unmountedPath}`;
    }

    return originalUrl;
  };

  const handle = (req, res, next) => {
    const upstreamPath = getUpstreamPath(req);
    const headers = {
      ...req.headers,
      host: target.host,
      origin: `${target.protocol}//${target.host}`,
      referer: `${target.protocol}//${target.host}${upstreamPath}`,
      'x-forwarded-host': req.headers.host,
      'x-forwarded-proto': req.protocol,
      'x-forwarded-prefix': mountPath
    };
    delete headers['content-length'];

    const upstreamReq = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers,
      agent,
      timeout: 30_000
    }, (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      rewriteSetCookie(responseHeaders);
      rewriteLocation(responseHeaders);
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('Uptime Kuma proxy timeout'));
    });
    upstreamReq.on('error', (error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      next(error);
    });
    req.on('aborted', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  };

  const handleUpgrade = (req, socket, head) => {
    const upstreamPath = getUpstreamPath(req);
    const headers = {
      ...req.headers,
      host: target.host,
      origin: `${target.protocol}//${target.host}`,
      'x-forwarded-host': req.headers.host,
      'x-forwarded-proto': 'http',
      'x-forwarded-prefix': mountPath
    };

    const upstreamReq = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers,
      agent: false
    });

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      socket.write([
        `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`,
        ...Object.entries(upstreamRes.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`),
        '',
        ''
      ].join('\r\n'));
      if (upstreamHead?.length) {
        socket.write(upstreamHead);
      }
      if (head?.length) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });

    upstreamReq.on('error', () => socket.destroy());
    upstreamReq.end();
  };

  return { handle, handleUpgrade, mountPath };
};

const sampleCpuTimes = () => os.cpus().reduce((totals, cpu) => {
  const cpuTotal = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);

  return {
    idle: totals.idle + cpu.times.idle,
    total: totals.total + cpuTotal
  };
}, { idle: 0, total: 0 });

const getSystemMemorySnapshot = async () => {
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const values = Object.fromEntries(meminfo
      .split('\n')
      .map((line) => line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/u))
      .filter(Boolean)
      .map((match) => [match[1], Number.parseInt(match[2], 10) * 1024]));
    const totalMemoryBytes = values.MemTotal || os.totalmem();
    const availableMemoryBytes = values.MemAvailable || values.MemFree || os.freemem();

    return {
      totalMemoryBytes,
      availableMemoryBytes,
      freeMemoryBytes: values.MemFree || os.freemem()
    };
  } catch {
    return {
      totalMemoryBytes: os.totalmem(),
      availableMemoryBytes: os.freemem(),
      freeMemoryBytes: os.freemem()
    };
  }
};

const getSystemStats = async () => {
  const start = sampleCpuTimes();
  await sleep(CPU_SAMPLE_WINDOW_MS);
  const end = sampleCpuTimes();
  const totalDelta = Math.max(1, end.total - start.total);
  const idleDelta = Math.max(0, end.idle - start.idle);
  const cpuUsagePercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
  const { totalMemoryBytes, availableMemoryBytes, freeMemoryBytes } = await getSystemMemorySnapshot();
  const usedMemoryBytes = Math.max(0, totalMemoryBytes - availableMemoryBytes);
  const processMemory = process.memoryUsage();

  return {
    cpuUsagePercent,
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
    totalMemoryBytes,
    freeMemoryBytes,
    availableMemoryBytes,
    usedMemoryBytes,
    memoryUsagePercent: totalMemoryBytes > 0 ? (usedMemoryBytes / totalMemoryBytes) * 100 : 0,
    processRssBytes: processMemory.rss,
    processHeapUsedBytes: processMemory.heapUsed
  };
};

const formatBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

const formatPercent = (value) => `${Number(value || 0).toFixed(1)}%`;
const formatAdminTimestamp = (value) => {
  if (!value) {
    return 'never';
  }

  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    return 'never';
  }

  return new Date(timestamp).toLocaleString('en-IN', {
    hour12: false,
    timeZone: 'Asia/Kolkata'
  });
};
const formatDurationMs = (value) => {
  const duration = Number(value);
  if (!Number.isFinite(duration)) {
    return '-';
  }

  if (duration >= 1000) {
    return `${(duration / 1000).toFixed(1)}s`;
  }

  return `${Math.round(duration)}ms`;
};
const renderProviderStatusRows = (providers = []) => providers.map((provider) => {
  const status = String(provider.status || 'idle');
  const statusClass = status.replace(/[^a-z0-9-]/giu, '');
  const cooldown = provider.cooldownUntil
    ? `${Math.max(0, Math.ceil((provider.cooldownUntil - Date.now()) / 1000))}s`
    : '-';
  const lastResult = provider.lastResultCount === null || provider.lastResultCount === undefined
    ? '-'
    : String(provider.lastResultCount);
  const lastError = provider.lastError
    ? `<span class="provider-error" title="${escapeHtml(provider.lastError)}">${escapeHtml(provider.lastError)}</span>`
    : '<span class="muted-inline">-</span>';

  return `
          <tr>
            <td><strong>${escapeHtml(provider.label || provider.id)}</strong><span class="provider-id">${escapeHtml(provider.id)}</span></td>
            <td><span class="status-pill status-${escapeHtml(statusClass)}">${escapeHtml(status)}</span></td>
            <td>${escapeHtml(String(provider.activeRequests || 0))}</td>
            <td>${escapeHtml(lastResult)}</td>
            <td>${escapeHtml(formatDurationMs(provider.lastDurationMs))}</td>
            <td>${escapeHtml(String(provider.consecutiveFailures || 0))}</td>
            <td>${escapeHtml(cooldown)}</td>
            <td>${escapeHtml(formatAdminTimestamp(provider.lastFinishedAt || provider.lastCacheHitAt || provider.lastStartedAt))}</td>
            <td>${lastError}</td>
          </tr>`;
}).join('');

const renderSupporterRows = (codes = []) => codes.map((code) => `
          <tr>
            <td><strong>${escapeHtml(code.label || 'Supporter')}</strong><span class="provider-id">${escapeHtml(code.hashPrefix)}</span></td>
            <td><span class="status-pill status-${code.status === 'active' && !code.expired ? 'ok' : 'failing'}">${escapeHtml(code.expired ? 'expired' : code.status)}</span></td>
            <td>${escapeHtml(code.tier || 'supporter')}</td>
            <td>${escapeHtml(code.expiresAt || '-')}</td>
            <td>${escapeHtml(code.lastUsedAt || 'never')}</td>
            <td>
              <form method="post" action="/admin/supporters/revoke" style="margin:0">
                <input type="hidden" name="hash" value="${escapeHtml(code.hash)}">
                <button type="submit">Revoke</button>
              </form>
            </td>
          </tr>`).join('');

const getPublicBaseUrl = (req) => config.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

const renderConfigurePage = ({ baseUrl, providers, supporterStats = {}, userStats = {} }) => {
  const providerIds = providers.map((provider) => provider.id);
  const escapedBaseUrl = escapeHtml(String(baseUrl || '').replace(/\/+$/u, ''));
  const providerCount = String(providers.length);
  const supporterCount = String(Math.max(Number(supporterStats.accounts || supporterStats.active || 0), PROJECT_SUPPORTERS.length));
  const activeUserCount = String(userStats.streamUsers || userStats.totalUsers || '60,107');
  let html = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n<title>NebulaStreams · Configure</title>\n<style>\n  :root {\n    --bg: #0c0c0d;\n    --surface: #131314;\n    --surface-2: #1a1a1c;\n    --surface-3: #212124;\n    --border: #2a2a2e;\n    --border-soft: #202023;\n    --text: #f2f2f3;\n    --text-2: #b2b2b8;\n    --muted: #7d7d84;\n    --faint: #54545b;\n    --on: #f2f2f3;        /* selected = near-white (inverted) */\n    --on-ink: #0c0c0d;    /* text on selected */\n    --green: #46c98a;\n    --radius: 12px;\n    --radius-sm: 8px;\n    --mono: \"SFMono-Regular\", \"JetBrains Mono\", \"Menlo\", \"Consolas\", monospace;\n    --sans: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Inter\", system-ui, sans-serif;\n  }\n  * { box-sizing: border-box; }\n  html { scroll-behavior: smooth; }\n  body {\n    margin: 0; background: var(--bg); color: var(--text);\n    font-family: var(--sans); font-size: 15px; line-height: 1.55;\n    -webkit-font-smoothing: antialiased;\n  }\n  a { color: inherit; text-decoration: none; }\n  ::selection { background: #2f2f34; }\n\n  /* Top bar */\n  .topbar {\n    position: sticky; top: 0; z-index: 50;\n    display: flex; align-items: center; justify-content: space-between; gap: 20px;\n    padding: 13px 28px; background: rgba(12,12,13,0.8); backdrop-filter: blur(14px);\n    border-bottom: 1px solid var(--border-soft);\n  }\n  .brand { display: flex; align-items: center; gap: 11px; }\n  .brand-mark {\n    width: 28px; height: 28px; border-radius: 50%;\n    border: 1.5px solid var(--text); position: relative; flex-shrink: 0;\n  }\n  .brand-mark::after {\n    content: \"\"; position: absolute; width: 6px; height: 6px; border-radius: 50%;\n    background: var(--text); top: 4px; right: 4px;\n  }\n  .brand-name { font-weight: 650; letter-spacing: -0.01em; font-size: 15px; }\n  .brand-name span { color: var(--muted); font-weight: 500; }\n  .nav { display: flex; align-items: center; gap: 4px; }\n  .nav a { color: var(--text-2); font-size: 13.5px; padding: 7px 12px; border-radius: 8px; transition: background .15s, color .15s; }\n  .nav a:hover { background: var(--surface-2); color: var(--text); }\n  .pill {\n    display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text-2);\n    padding: 6px 11px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); margin-left: 6px;\n  }\n  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); }\n\n  /* Layout */\n  .wrap { max-width: 1180px; margin: 0 auto; padding: 40px 28px 96px;\n    display: grid; grid-template-columns: 272px 1fr; gap: 40px; align-items: start; }\n  .rail { position: sticky; top: 84px; display: flex; flex-direction: column; gap: 18px; }\n\n  .install { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); padding: 18px; }\n  .install h3 { margin: 0 0 3px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }\n  .install .sub { margin: 0 0 14px; font-size: 12.5px; color: var(--faint); line-height: 1.45; }\n  .url-box { font-family: var(--mono); font-size: 12px; color: var(--text-2); background: var(--bg);\n    border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 11px; word-break: break-all; line-height: 1.5; margin-bottom: 12px; }\n  .url-box b { color: var(--text); font-weight: 500; }\n  .btn-row { display: flex; gap: 8px; }\n  .btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;\n    font-family: var(--sans); font-size: 13px; font-weight: 550; padding: 9px 12px; border-radius: var(--radius-sm);\n    border: 1px solid var(--border); background: var(--surface-3); color: var(--text); cursor: pointer; transition: background .15s, transform .05s; }\n  .btn:hover { background: #2a2a2e; }\n  .btn:active { transform: translateY(1px); }\n  .btn.primary { background: var(--on); border-color: transparent; color: var(--on-ink); }\n  .btn.primary:hover { background: #fff; }\n  .btn svg { width: 15px; height: 15px; }\n  .meta-row { display: flex; gap: 8px; margin-top: 12px; }\n  .meta { flex: 1; text-align: center; padding: 8px 4px; background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--radius-sm); }\n  .meta .v { font-size: 14px; font-weight: 650; letter-spacing: -.01em; }\n  .meta .l { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-top: 1px; }\n  .thanks { margin-top: 12px; font-size: 11.5px; color: var(--faint); }\n  .thanks b { color: var(--text-2); font-weight: 500; }\n\n  .sidenav { display: flex; flex-direction: column; gap: 1px; }\n  .sidenav a { font-size: 13.5px; color: var(--muted); padding: 7px 12px; border-radius: 8px;\n    display: flex; align-items: center; gap: 10px; transition: background .12s, color .12s; }\n  .sidenav a:hover { color: var(--text-2); background: var(--surface); }\n  .sidenav a.active { color: var(--text); background: var(--surface-2); }\n  .sidenav a .idx { font-family: var(--mono); font-size: 11px; color: var(--faint); width: 16px; }\n  .sidenav a.active .idx { color: var(--text); }\n\n  /* Content */\n  .content { display: flex; flex-direction: column; gap: 16px; min-width: 0; }\n  .hero { margin-bottom: 8px; }\n  .eyebrow { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin-bottom: 12px; display: block; }\n  .hero h1 { margin: 0 0 12px; font-size: 34px; line-height: 1.12; font-weight: 680; letter-spacing: -.025em; }\n  .hero p { margin: 0; color: var(--text-2); font-size: 15.5px; max-width: 60ch; }\n  .feature-line { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }\n  .chip-static { font-size: 12.5px; color: var(--text-2); border: 1px solid var(--border); border-radius: 999px; padding: 5px 12px; background: var(--surface); }\n\n  .card { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 22px 24px; }\n  .card-head { margin-bottom: 18px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }\n  .card-head h2 { margin: 0 0 4px; font-size: 17px; font-weight: 620; letter-spacing: -.015em; }\n  .card-head p { margin: 0; font-size: 13.5px; color: var(--muted); max-width: 60ch; }\n\n  .field { padding: 16px 0; border-top: 1px solid var(--border-soft); }\n  .field:first-of-type { border-top: 0; padding-top: 0; }\n  .field-label { font-size: 14px; font-weight: 550; margin-bottom: 2px; }\n  .field-hint { font-size: 12.5px; color: var(--muted); margin-bottom: 12px; line-height: 1.45; }\n\n  .chips { display: flex; flex-wrap: wrap; gap: 8px; }\n  .chip { font-size: 13px; color: var(--text-2); border: 1px solid var(--border); border-radius: 999px;\n    padding: 7px 14px; background: var(--surface-2); cursor: pointer; user-select: none; transition: all .13s; }\n  .chip:hover { border-color: #3a3a40; color: var(--text); }\n  .chip.on { background: var(--on); border-color: var(--on); color: var(--on-ink); font-weight: 550; }\n\n  .seg-group { display: flex; flex-direction: column; gap: 14px; }\n  .seg-line { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }\n  .seg-line > span { font-size: 13.5px; color: var(--text-2); }\n  .seg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--border); border-radius: 9px; padding: 3px; flex-wrap: wrap; }\n  .seg button { font-family: var(--sans); font-size: 12.5px; color: var(--muted); border: 0; background: transparent;\n    padding: 6px 12px; border-radius: 6px; cursor: pointer; white-space: nowrap; transition: all .13s; }\n  .seg button:hover { color: var(--text-2); }\n  .seg button.on { background: var(--on); color: var(--on-ink); font-weight: 550; }\n\n  /* native select */\n  .select-wrap { position: relative; }\n  select.input { appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 34px; }\n  .select-wrap .chev { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--muted); display: flex; }\n\n  .preset-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }\n  .preset { text-align: left; border: 1px solid var(--border); background: var(--surface-2); border-radius: var(--radius-sm);\n    padding: 13px 15px; cursor: pointer; transition: all .13s; font-family: var(--sans); }\n  .preset:hover { border-color: #3a3a40; background: var(--surface-3); }\n  .preset.on { border-color: var(--on); background: var(--surface-3); }\n  .preset .pt { font-size: 13.5px; font-weight: 600; color: var(--text); margin-bottom: 3px; }\n  .preset .pd { font-size: 12px; color: var(--muted); line-height: 1.4; }\n  .preset-foot { margin-top: 14px; font-size: 12.5px; color: var(--muted); font-family: var(--mono); }\n\n  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }\n  .search { flex: 1; min-width: 200px; display: flex; align-items: center; gap: 9px; background: var(--surface-2);\n    border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 9px 12px; }\n  .search svg { width: 15px; height: 15px; color: var(--faint); flex-shrink: 0; }\n  .search input { flex: 1; border: 0; background: transparent; color: var(--text); font-family: var(--sans); font-size: 13.5px; outline: none; }\n  .search input::placeholder { color: var(--faint); }\n  .ghost-btn { font-family: var(--sans); font-size: 12.5px; color: var(--text-2); border: 1px solid var(--border);\n    background: var(--surface-2); padding: 9px 13px; border-radius: var(--radius-sm); cursor: pointer; transition: all .13s; }\n  .ghost-btn:hover { background: var(--surface-3); color: var(--text); }\n  .examples { font-size: 12px; color: var(--faint); margin-bottom: 12px; line-height: 1.5; font-family: var(--mono); }\n\n  .provider-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }\n  .provider { display: flex; align-items: center; gap: 11px; padding: 10px 13px; border: 1px solid var(--border-soft);\n    border-radius: var(--radius-sm); background: var(--surface-2); cursor: pointer; transition: all .13s; }\n  .provider:hover { border-color: var(--border); }\n  .provider .box { width: 17px; height: 17px; border-radius: 5px; border: 1.5px solid #3c3c44; flex-shrink: 0; position: relative; transition: all .13s; }\n  .provider.on .box { background: var(--on); border-color: var(--on); }\n  .provider.on .box::after { content: \"\"; position: absolute; left: 5px; top: 2px; width: 4px; height: 8px; border: solid var(--on-ink); border-width: 0 2px 2px 0; transform: rotate(45deg); }\n  .provider .pname { font-family: var(--mono); font-size: 12.5px; color: var(--text-2); }\n  .provider.on .pname { color: var(--text); }\n  .count-note { font-size: 12.5px; color: var(--muted); margin-top: 12px; }\n\n  .adapter-empty { border: 1px dashed var(--border); border-radius: var(--radius-sm); padding: 20px; text-align: center; color: var(--faint); font-size: 13px; background: var(--surface-2); }\n\n  .prio { display: flex; flex-direction: column; gap: 7px; }\n  .prio-item { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--surface-2); }\n  .prio-item .grip { color: var(--faint); cursor: grab; display: flex; }\n  .prio-item .grip svg { width: 14px; height: 14px; }\n  .prio-item .rank { font-family: var(--mono); font-size: 11px; color: var(--muted); }\n  .prio-item .pq { font-size: 13.5px; font-weight: 500; flex: 1; }\n  .prio-item .tag { font-size: 11px; color: var(--faint); font-family: var(--mono); }\n\n  .toggle-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 15px 0; border-top: 1px solid var(--border-soft); }\n  .toggle-row:first-child { border-top: 0; padding-top: 2px; }\n  .toggle-row .tinfo .tt { font-size: 14px; font-weight: 540; }\n  .toggle-row .tinfo .td { font-size: 12.5px; color: var(--muted); margin-top: 2px; max-width: 56ch; line-height: 1.45; }\n  .switch { flex-shrink: 0; width: 40px; height: 23px; border-radius: 999px; background: var(--surface-3); border: 1px solid var(--border); cursor: pointer; position: relative; transition: background .16s, border-color .16s; }\n  .switch::after { content: \"\"; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: #8b8b93; transition: transform .16s, background .16s; }\n  .switch.on { background: var(--on); border-color: transparent; }\n  .switch.on::after { transform: translateX(17px); background: var(--on-ink); }\n\n  .input, .ta { width: 100%; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);\n    padding: 10px 12px; color: var(--text); font-family: var(--sans); font-size: 13.5px; outline: none; transition: border-color .13s; }\n  .input:focus, .ta:focus { border-color: #45454d; }\n  .input::placeholder, .ta::placeholder { color: var(--faint); }\n  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }\n  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }\n  .stack { display: flex; flex-direction: column; gap: 6px; }\n  .lbl { font-size: 12.5px; color: var(--text-2); font-weight: 500; }\n  .sub-hint { font-size: 12px; color: var(--faint); line-height: 1.5; }\n  .sub-hint code { font-family: var(--mono); background: var(--surface-3); padding: 1px 5px; border-radius: 4px; color: var(--text-2); }\n\n  .collap summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: space-between; }\n  .collap summary::-webkit-details-marker { display: none; }\n  .collap summary .caret { color: var(--muted); transition: transform .18s; display: flex; }\n  .collap[open] summary .caret { transform: rotate(90deg); }\n  .collap .body { margin-top: 18px; display: flex; flex-direction: column; gap: 14px; }\n\n  .price-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }\n  .price { border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; background: var(--surface-2); }\n  .price.feature { border-color: #3d3d44; }\n  .price .pkr { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }\n  .price .pn { font-size: 14px; font-weight: 600; }\n  .price .pp { font-family: var(--mono); font-size: 13px; color: var(--text-2); }\n  .price .pcap { font-size: 12.5px; color: var(--muted); margin: 0 0 14px; }\n  .price ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }\n  .price li { font-size: 13px; color: var(--text-2); display: flex; gap: 9px; align-items: flex-start; }\n  .price li svg { width: 14px; height: 14px; color: var(--text); flex-shrink: 0; margin-top: 2px; }\n\n  .faq { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 22px; }\n  .faq h4 { margin: 0 0 4px; font-size: 13.5px; font-weight: 600; }\n  .faq p { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.5; }\n\n  .notes { display: flex; flex-direction: column; gap: 12px; }\n  .note-item { display: flex; gap: 12px; font-size: 13px; color: var(--text-2); line-height: 1.5; }\n  .note-item b { color: var(--text); font-weight: 600; }\n  .note-item .nk { font-family: var(--mono); font-size: 11px; color: var(--faint); flex-shrink: 0; width: 70px; padding-top: 1px; }\n\n  .banner { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); padding: 16px 18px; display: flex; gap: 13px; align-items: flex-start; }\n  .banner .ico { color: var(--text); flex-shrink: 0; margin-top: 1px; }\n  .banner .bt { font-size: 13.5px; font-weight: 560; margin-bottom: 2px; }\n  .banner .bd { font-size: 12.5px; color: var(--muted); line-height: 1.5; }\n\n  .footer { border-top: 1px solid var(--border-soft); margin-top: 12px; padding-top: 22px; display: flex;\n    align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; font-size: 12.5px; color: var(--faint); }\n\n  .toast { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%) translateY(20px);\n    background: var(--surface-3); border: 1px solid var(--border); color: var(--text); padding: 11px 18px;\n    border-radius: 999px; font-size: 13px; opacity: 0; transition: all .25s; pointer-events: none; z-index: 100; box-shadow: 0 8px 30px rgba(0,0,0,.5); }\n  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }\n\n  .tabbar { display: flex; gap: 4px; padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 11px; position: sticky; top: 70px; z-index: 40; }\n  .tab { flex: 1; font-family: var(--sans); font-size: 13.5px; font-weight: 550; color: var(--muted); background: transparent; border: 0; padding: 10px 14px; border-radius: 8px; cursor: pointer; transition: all .14s; }\n  .tab:hover { color: var(--text-2); }\n  .tab.on { background: var(--surface-3); color: var(--text); }\n  .tabpanel { display: none; flex-direction: column; gap: 16px; }\n  .tabpanel.on { display: flex; animation: fade .2s ease; }\n  @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }\n  .rail-note { font-size: 12.5px; color: var(--muted); line-height: 1.55; padding: 2px 2px 0; }\n\n  .site-banner { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 16px 20px; }\n  .sb-main { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }\n  .sb-badge { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin-bottom: 7px; }\n  .sb-badge .lt { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }\n  .sb-title { font-size: 15.5px; font-weight: 620; letter-spacing: -.01em; margin-bottom: 3px; }\n  .sb-desc { font-size: 13px; color: var(--muted); max-width: 58ch; line-height: 1.45; }\n  .sb-actions { display: flex; gap: 8px; flex-shrink: 0; }\n  .sb-actions .btn { flex: 0 0 auto; padding: 9px 16px; }\n\n  .thanks-card { border: 1px solid var(--text); border-radius: var(--radius); background: var(--surface-2); padding: 15px 16px; }\n  .tc-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; letter-spacing: .01em; }\n  .tc-ico { display: flex; color: var(--text); }\n  .tc-sub { font-size: 12px; color: var(--muted); margin: 5px 0 11px; line-height: 1.45; }\n  .tc-names { display: flex; flex-wrap: wrap; gap: 6px; }\n  .tc-name { font-size: 12px; font-weight: 550; color: var(--on-ink); background: var(--on); border-radius: 999px; padding: 4px 11px; }\n\n  @media (max-width: 920px) {\n    .wrap { grid-template-columns: 1fr; gap: 24px; }\n    .rail { position: static; } .sidenav { display: none; }\n    .preset-grid, .provider-grid, .price-grid, .faq, .grid-2, .grid-3 { grid-template-columns: 1fr; }\n    .hero h1 { font-size: 27px; } .nav a:not(.pill) { display: none; }\n  }\n</style>\n</head>\n<body>\n  <header class=\"topbar\">\n    <div class=\"brand\">\n      <div class=\"brand-mark\"></div>\n      <div class=\"brand-name\">NebulaStreams <span>· Configure</span></div>\n    </div>\n    <nav class=\"nav\">\n      <a href=\"#\">Movie Site</a>\n      <a href=\"#\">Sports</a>\n      <a href=\"#support\">Support</a>\n      <span class=\"pill\"><span class=\"dot\"></span> Live · 115 providers</span>\n    </nav>\n  </header>\n\n  <div class=\"wrap\">\n    <aside class=\"rail\">\n      <div class=\"install\">\n        <h3>Install URL</h3>\n        <p class=\"sub\">The manifest NebulaStreams generates from your current settings. Updates in real time.</p>\n        <div class=\"url-box\"><b>https://</b>nebula.work.gd/manifest.json</div>\n        <div class=\"btn-row\">\n          <button class=\"btn primary\" id=\"installBtn\">\n            <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\"><path d=\"M12 3v12m0 0l-4-4m4 4l4-4M4 19h16\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>\n            Install\n          </button>\n          <button class=\"btn\" id=\"copyBtn\">\n            <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2\"/><path d=\"M5 15V5a2 2 0 012-2h10\"/></svg>\n            Copy URL\n          </button>\n        </div>\n        <div class=\"meta-row\">\n          <div class=\"meta\"><div class=\"v\">115</div><div class=\"l\">Providers</div></div>\n          <div class=\"meta\"><div class=\"v\">Custom</div><div class=\"l\">Quality</div></div>\n          <div class=\"meta\"><div class=\"v\">Ready</div><div class=\"l\">TorBox</div></div>\n        </div>\n      </div>\n\n      <div class=\"thanks-card\">\n        <div class=\"tc-head\"><span class=\"tc-ico\"><svg width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M12 21C6 16.5 3 13 3 9a4 4 0 017-2.5A4 4 0 0117 9c0 4-3 7.5-9 12z\" stroke-linejoin=\"round\"/></svg></span> Special thanks</div>\n        <div class=\"tc-sub\">Our supporters keep NebulaStreams free and online.</div>\n        <div class=\"tc-names\"><span class=\"tc-name\">Devon Durham</span><span class=\"tc-name\">Shadow</span></div>\n      </div>\n\n      <div class=\"rail-note\">\n        <p>Your manifest updates live as you change settings. Switch tabs to configure providers, filters, integrations, and support — nothing here affects free stream access.</p>\n      </div>\n    </aside>\n\n    <main class=\"content\">\n      <section class=\"hero\">\n        <span class=\"eyebrow\">Stremio Add-on Configuration</span>\n        <h1>Build your perfect<br>stream pipeline.</h1>\n        <p>Pick providers, sort qualities, fine-tune filters, then install in one click. Every change updates the install URL in real time. Browse movies and series with selectable stream sources — and watch live sports from Nebula Sports.</p>\n        <div class=\"feature-line\">\n          <span class=\"chip-static\">Live manifest</span>\n          <span class=\"chip-static\">Smart presets</span>\n          <span class=\"chip-static\">TorBox support</span>\n          <span class=\"chip-static\">Private configs</span>\n        </div>\n      </section>\n\n      <div class=\"site-banner\">\n        <div class=\"sb-main\">\n          <div class=\"sb-text\">\n            <span class=\"sb-badge\"><span class=\"lt\"></span> Now streaming</span>\n            <div class=\"sb-title\">NebulaStreams Movie Site &amp; Nebula Sports</div>\n            <div class=\"sb-desc\">Browse movies and series with selectable stream sources — and watch the World Cup and live sports from Nebula Sports.</div>\n          </div>\n          <div class=\"sb-actions\">\n            <a href=\"#\" class=\"btn primary\">\n              <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\"/><path d=\"M10 9l5 3-5 3z\" fill=\"currentColor\" stroke=\"none\"/></svg>\n              Movie Site\n            </a>\n            <a href=\"#\" class=\"btn\">\n              <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 3a14 14 0 000 18M12 3a14 14 0 010 18M3.5 9h17M3.5 15h17\" stroke-linecap=\"round\"/></svg>\n              Nebula Sports\n            </a>\n          </div>\n        </div>\n      </div>\n\n      <div class=\"tabbar\" id=\"tabbar\">\n        <button class=\"tab on\" data-tab=\"simple\">Simple</button>\n        <button class=\"tab\" data-tab=\"advanced\">Advanced</button>\n        <button class=\"tab\" data-tab=\"integrations\">Integrations</button>\n        <button class=\"tab\" data-tab=\"support\">Support</button>\n      </div>\n\n      <div class=\"tabpanel on\" data-panel=\"simple\">\n      <!-- 01 Presets -->\n      <section class=\"card\" id=\"presets\">\n        <div class=\"card-head\"><div><h2>One-click presets</h2><p>Apply a ready-made profile, then tweak anything you want manually.</p></div></div>\n        <div class=\"preset-grid\" id=\"presetGrid\">\n          <button class=\"preset on\"><div class=\"pt\">Web Fast</div><div class=\"pd\">Direct-friendly playback, H.264 preference, aggressive dedupe.</div></button>\n          <button class=\"preset\"><div class=\"pt\">Mobile Data</div><div class=\"pd\">Smaller files &amp; resolutions, tighter caps for low-bandwidth.</div></button>\n          <button class=\"preset\"><div class=\"pt\">4K HDR</div><div class=\"pd\">Top-end quality and HDR releases, no size restrictions.</div></button>\n          <button class=\"preset\"><div class=\"pt\">Anime</div><div class=\"pd\">Anime-focused providers with Japanese audio preference.</div></button>\n          <button class=\"preset\"><div class=\"pt\">Indian Content</div><div class=\"pd\">Indian-focused providers, direct hosts preferred.</div></button>\n          <button class=\"preset\"><div class=\"pt\">Turkish Content</div><div class=\"pd\">Turkish-focused providers for movies and series.</div></button>\n          <button class=\"preset\"><div class=\"pt\">Italian Content</div><div class=\"pd\">Italian-focused providers for movies, series, anime.</div></button>\n          <button class=\"preset\"><div class=\"pt\">Latino Content</div><div class=\"pd\">Spanish and Latino-focused providers.</div></button>\n          <button class=\"preset\"><div class=\"pt\">French Content</div><div class=\"pd\">French movies, series, and anime providers.</div></button>\n          <button class=\"preset\"><div class=\"pt\">Arabic Content</div><div class=\"pd\">Arabic-focused providers for movies, series, anime.</div></button>\n        </div>\n        <div class=\"preset-foot\">Preset: Custom</div>\n      </section>\n\n      <!-- 02 Simple -->\n      <section class=\"card\" id=\"simple\">\n        <div class=\"card-head\"><div><h2>Simple settings</h2><p>Quick setup with common stream controls.</p></div></div>\n        <div class=\"field\">\n          <div class=\"field-label\">Video quality</div>\n          <div class=\"field-hint\">Choose qualities allowed in stream results.</div>\n          <div class=\"chips\" data-multi>\n            <span class=\"chip on\">2160p (4K)</span><span class=\"chip on\">1080p</span><span class=\"chip on\">720p</span><span class=\"chip\">480p</span>\n          </div>\n        </div>\n        <div class=\"field\">\n          <div class=\"field-label\">Content and sorting</div>\n          <div class=\"field-hint\">Set content scope and result order.</div>\n          <div class=\"seg-group\">\n            <div class=\"seg-line\"><span>Content selection</span><div class=\"seg\" data-seg><button class=\"on\">Default</button><button>Movies only</button><button>Series only</button></div></div>\n            <div class=\"seg-line\"><span>Default sorting</span><div class=\"seg\" data-seg><button class=\"on\">Highest quality</button><button>Highest non-4K</button><button>Balanced</button></div></div>\n          </div>\n        </div>\n        <div class=\"field\">\n          <div class=\"field-label\">Result limits</div>\n          <div class=\"field-hint\">Control duplicates without disabling providers.</div>\n          <div class=\"seg-group\">\n            <div class=\"seg-line\"><span>Max per quality</span><div class=\"seg\" data-seg><button class=\"on\">Unlimited</button><button>1</button><button>2</button><button>3</button><button>5</button></div></div>\n            <div class=\"seg-line\"><span>Max per provider</span><div class=\"seg\" data-seg><button class=\"on\">Unlimited</button><button>1</button><button>2</button><button>3</button><button>5</button></div></div>\n          </div>\n        </div>\n      </section>\n\n      </div>\n\n      <div class=\"tabpanel\" data-panel=\"advanced\">\n      <!-- 03 Providers -->\n      <section class=\"card\" id=\"providers\">\n        <div class=\"card-head\"><div><h2>Provider selection</h2><p>Pick any combination. Leaving everything unchecked falls back to all providers.</p></div></div>\n        <div class=\"toolbar\">\n          <div class=\"search\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M21 21l-4-4\" stroke-linecap=\"round\"/></svg><input id=\"provSearch\" placeholder=\"Search providers…\" /></div>\n          <button class=\"ghost-btn\" id=\"selAll\">Select all</button>\n          <button class=\"ghost-btn\" id=\"clearAll\">Clear</button>\n        </div>\n        <div class=\"examples\">Examples: nuvio, nuvio-latino, nuvio-french, nuvio-italian, nuvio-2, cloudstream-phisher, r2-plugin, r3-plugin, r4-asian-drama-movies, r5-plugin, streamrip-plugin, pstream</div>\n        <div class=\"provider-grid\" id=\"provGrid\"></div>\n        <div class=\"count-note\" id=\"provCount\">All providers selected</div>\n      </section>\n\n      <!-- 04 Adapters -->\n      <section class=\"card\" id=\"adapters\">\n        <div class=\"card-head\"><div><h2>Adapter providers</h2><p>Open adapter groups and choose source providers inside plugins.</p></div></div>\n        <div class=\"adapter-empty\">Loading adapter providers…</div>\n      </section>\n\n      <!-- 05 Priority -->\n      <section class=\"card\" id=\"priority\">\n        <div class=\"card-head\"><div><h2>Quality priority</h2><p>Move preferred qualities up. Used for ranking results.</p></div><button class=\"ghost-btn\">Reset</button></div>\n        <div class=\"prio\" id=\"prioList\">\n          <div class=\"prio-item\"><span class=\"grip\"><svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><circle cx=\"9\" cy=\"6\" r=\"1.6\"/><circle cx=\"15\" cy=\"6\" r=\"1.6\"/><circle cx=\"9\" cy=\"12\" r=\"1.6\"/><circle cx=\"15\" cy=\"12\" r=\"1.6\"/><circle cx=\"9\" cy=\"18\" r=\"1.6\"/><circle cx=\"15\" cy=\"18\" r=\"1.6\"/></svg></span><span class=\"rank\">01</span><span class=\"pq\">2160p (4K)</span><span class=\"tag\">UHD</span></div>\n          <div class=\"prio-item\"><span class=\"grip\"><svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><circle cx=\"9\" cy=\"6\" r=\"1.6\"/><circle cx=\"15\" cy=\"6\" r=\"1.6\"/><circle cx=\"9\" cy=\"12\" r=\"1.6\"/><circle cx=\"15\" cy=\"12\" r=\"1.6\"/><circle cx=\"9\" cy=\"18\" r=\"1.6\"/><circle cx=\"15\" cy=\"18\" r=\"1.6\"/></svg></span><span class=\"rank\">02</span><span class=\"pq\">1080p</span><span class=\"tag\">FHD</span></div>\n          <div class=\"prio-item\"><span class=\"grip\"><svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><circle cx=\"9\" cy=\"6\" r=\"1.6\"/><circle cx=\"15\" cy=\"6\" r=\"1.6\"/><circle cx=\"9\" cy=\"12\" r=\"1.6\"/><circle cx=\"15\" cy=\"12\" r=\"1.6\"/><circle cx=\"9\" cy=\"18\" r=\"1.6\"/><circle cx=\"15\" cy=\"18\" r=\"1.6\"/></svg></span><span class=\"rank\">03</span><span class=\"pq\">720p</span><span class=\"tag\">HD</span></div>\n          <div class=\"prio-item\"><span class=\"grip\"><svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><circle cx=\"9\" cy=\"6\" r=\"1.6\"/><circle cx=\"15\" cy=\"6\" r=\"1.6\"/><circle cx=\"9\" cy=\"12\" r=\"1.6\"/><circle cx=\"15\" cy=\"12\" r=\"1.6\"/><circle cx=\"9\" cy=\"18\" r=\"1.6\"/><circle cx=\"15\" cy=\"18\" r=\"1.6\"/></svg></span><span class=\"rank\">04</span><span class=\"pq\">480p</span><span class=\"tag\">SD</span></div>\n        </div>\n      </section>\n\n      <!-- 06 Filters -->\n      <section class=\"card\" id=\"filters\">\n        <div class=\"card-head\"><div><h2>Playback filters</h2><p>Cut noisy results without losing unknown or unlabeled streams.</p></div></div>\n        <div class=\"toggle-row\"><div class=\"tinfo\"><div class=\"tt\">Web-ready only</div><div class=\"td\">Strict — only simple MP4-style links without proxy headers. Reduces results heavily.</div></div><div class=\"switch\" data-switch></div></div>\n        <div class=\"toggle-row\"><div class=\"tinfo\"><div class=\"tt\">Hide HEVC / HDR / 10-bit</div><div class=\"td\">For lighter playback devices that struggle with heavier codecs.</div></div><div class=\"switch\" data-switch></div></div>\n        <div class=\"field\" style=\"border-top:1px solid var(--border-soft)\">\n          <div class=\"seg-line\"><span>Stream card formatter</span><div class=\"seg\" data-seg><button class=\"on\">Clean</button><button>Detailed</button><button>Compact</button><button>Minimal</button></div></div>\n          <div class=\"field-hint\" style=\"margin:8px 0 0\">Choose how stream cards are displayed in Stremio.</div>\n        </div>\n        <div class=\"field\">\n          <div class=\"grid-2\">\n            <div class=\"stack\">\n              <span class=\"lbl\">Preferred audio language</span>\n              <div class=\"select-wrap\">\n                <select class=\"input\"><option>Any language</option><option>Hindi</option><option>English</option><option>Tamil</option><option>Telugu</option><option>Malayalam</option><option>Kannada</option><option>Japanese</option><option>Korean</option><option>Turkish</option><option>Italian</option><option>Latino</option><option>Spanish</option><option>Arabic</option></select>\n                <span class=\"chev\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M6 9l6 6 6-6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></span>\n              </div>\n              <span class=\"sub-hint\">Keeps matches and unknown-language streams. Only clearly different audio is filtered.</span>\n            </div>\n            <div class=\"stack\">\n              <span class=\"lbl\">Maximum file size</span>\n              <div class=\"select-wrap\">\n                <select class=\"input\"><option>No limit</option><option>1.5 GB</option><option>3 GB</option><option>5 GB</option><option>10 GB</option><option>20 GB</option></select>\n                <span class=\"chev\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M6 9l6 6 6-6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></span>\n              </div>\n              <span class=\"sub-hint\">Hide oversized files for lighter playback or smaller downloads.</span>\n            </div>\n          </div>\n        </div>\n        <div class=\"field\">\n          <div class=\"stack\">\n            <span class=\"lbl\">Blocked hosts</span>\n            <input class=\"input\" placeholder=\"Comma-separated host fragments to hide…\" />\n          </div>\n        </div>\n        <div class=\"field\">\n          <div class=\"stack\">\n            <span class=\"lbl\">Custom proxy URL</span>\n            <input class=\"input\" placeholder=\"https://your-proxy/…\" />\n            <span class=\"sub-hint\">Optional. HTTP streams will be rewritten through your proxy. Supports <code>{url}</code> and <code>{headers}</code> placeholders. Stored behind a private config id.</span>\n          </div>\n        </div>\n        <div class=\"field\">\n          <div class=\"stack\">\n            <span class=\"lbl\">Febbox UI cookie (ShowBox)</span>\n            <input class=\"input\" placeholder=\"Paste Febbox UI cookie…\" />\n            <span class=\"sub-hint\">Optional. Enables ShowBox with your own Febbox UI cookie. Stored behind a private config id.</span>\n          </div>\n        </div>\n        <div class=\"field\">\n          <div class=\"seg-line\"><span>Deduplication mode</span><div class=\"seg\" data-seg><button>Off</button><button class=\"on\">Smart</button><button>By filename</button><button>Host + quality</button></div></div>\n          <div class=\"field-hint\" style=\"margin:8px 0 0\">Collapse duplicates after ranking, keeping the best-scored copy.</div>\n        </div>\n      </section>\n\n      <!-- 07 Boosts -->\n      <section class=\"card\" id=\"boosts\">\n        <div class=\"card-head\"><div><h2>Preference boosts</h2><p>These don't remove streams — they push matching streams higher.</p></div></div>\n        <div class=\"toggle-row\"><div class=\"tinfo\"><div class=\"tt\">Prefer HDR</div><div class=\"td\">Push HDR &amp; Dolby Vision higher.</div></div><div class=\"switch\" data-switch></div></div>\n        <div class=\"toggle-row\"><div class=\"tinfo\"><div class=\"tt\">Prefer H.264 / x264</div><div class=\"td\">For players that struggle with HEVC.</div></div><div class=\"switch on\" data-switch></div></div>\n        <div class=\"toggle-row\"><div class=\"tinfo\"><div class=\"tt\">Prefer smaller files</div><div class=\"td\">When speed matters more than quality.</div></div><div class=\"switch\" data-switch></div></div>\n        <div class=\"toggle-row\"><div class=\"tinfo\"><div class=\"tt\">Prefer direct hosts</div><div class=\"td\">Direct HTTP above streams that need extra headers.</div></div><div class=\"switch on\" data-switch></div></div>\n      </section>\n\n      </div>\n\n      <div class=\"tabpanel\" data-panel=\"integrations\">\n      <!-- 08 TorBox -->\n      <section class=\"card\" id=\"torbox\">\n        <details class=\"collap\" open>\n          <summary><div><h2 style=\"font-size:17px;margin:0 0 4px;font-weight:620;letter-spacing:-.015em\">TorBox integration</h2><p style=\"margin:0;font-size:13.5px;color:var(--muted)\">Stream without buffering. Highly recommended.</p></div>\n            <span class=\"caret\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M9 6l6 6-6 6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></span></summary>\n          <div class=\"body\">\n            <div class=\"stack\"><span class=\"lbl\">API key</span><input class=\"input\" placeholder=\"Paste your TorBox API key…\" /><span class=\"sub-hint\">Find your API key in your TorBox account settings.</span></div>\n            <div class=\"toggle-row\" style=\"padding-top:4px\"><div class=\"tinfo\"><div class=\"tt\">TorBox-only streams</div><div class=\"td\">Excludes normal search results.</div></div><div class=\"switch\" data-switch></div></div>\n            <div class=\"toggle-row\"><div class=\"tinfo\"><div class=\"tt\">TorBox Usenet</div><div class=\"td\">Searches TorBox Usenet and resolves NZB results through your Pro account.</div></div><div class=\"switch\" data-switch></div></div>\n          </div>\n        </details>\n      </section>\n\n      <!-- 09 IPTV -->\n      <section class=\"card\" id=\"iptv\">\n        <div class=\"card-head\"><div><h2>IPTV &amp; live TV</h2><p>Add private IPTV and public live TV catalogs. Credentials are stored only in the private manifest config and never placed in the public install URL.</p></div></div>\n\n        <details class=\"collap field\" style=\"border-top:0;padding-top:0\">\n          <summary><div><div class=\"field-label\">Xtream Codes IPTV</div><div class=\"field-hint\" style=\"margin-bottom:0\">Add private IPTV live TV, VOD, series, categories, and EPG.</div></div>\n            <span class=\"caret\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M9 6l6 6-6 6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></span></summary>\n          <div class=\"body\">\n            <div class=\"stack\"><span class=\"lbl\">Server URL</span><input class=\"input\" placeholder=\"http://server:port\" /></div>\n            <div class=\"grid-2\"><div class=\"stack\"><span class=\"lbl\">Username</span><input class=\"input\" /></div><div class=\"stack\"><span class=\"lbl\">Password</span><input class=\"input\" type=\"password\" /></div></div>\n          </div>\n        </details>\n\n        <details class=\"collap field\">\n          <summary><div><div class=\"field-label\">Stalker / MAG Portal</div><div class=\"field-hint\" style=\"margin-bottom:0\">Add private MAG IPTV live TV catalogs from portal + MAC address.</div></div>\n            <span class=\"caret\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M9 6l6 6-6 6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></span></summary>\n          <div class=\"body\">\n            <div class=\"stack\"><span class=\"lbl\">Stalker portal URL</span><input class=\"input\" placeholder=\"http://portal/c/\" /></div>\n            <div class=\"grid-2\">\n              <div class=\"stack\"><span class=\"lbl\">Stalker MAC address</span><input class=\"input\" placeholder=\"00:1A:79:xx:xx:xx\" /></div>\n              <div class=\"stack\"><span class=\"lbl\">STB type</span>\n                <div class=\"select-wrap\"><select class=\"input\"><option>MAG254</option><option>MAG250</option><option>MAG256</option><option>MAG270</option><option>MAG322</option><option>MAG324</option><option>MAG349</option><option>MAG351</option><option>MAG420</option></select>\n                  <span class=\"chev\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M6 9l6 6 6-6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></span></div>\n              </div>\n            </div>\n            <div class=\"grid-3\">\n              <div class=\"stack\"><span class=\"lbl\">Serial number</span><input class=\"input\" /></div>\n              <div class=\"stack\"><span class=\"lbl\">Device ID</span><input class=\"input\" /></div>\n              <div class=\"stack\"><span class=\"lbl\">Device ID 2</span><input class=\"input\" /></div>\n            </div>\n            <div class=\"grid-2\">\n              <div class=\"stack\"><span class=\"lbl\">Category start</span><input class=\"input\" placeholder=\"0\" /></div>\n              <div class=\"stack\"><span class=\"lbl\">Category catalogs</span><input class=\"input\" /></div>\n            </div>\n            <span class=\"sub-hint\">Stremio limits manifest size. For portals with hundreds of categories, set Category Start to 0, 40, 80, 120… to choose the visible category page.</span>\n          </div>\n        </details>\n\n        <div class=\"toggle-row\"><div class=\"tinfo\"><div class=\"tt\">Famelack Public Live TV</div><div class=\"td\">Add public worldwide live TV catalogs from Famelack data.</div></div><div class=\"switch\" data-switch></div></div>\n        <div class=\"toggle-row\"><div class=\"tinfo\"><div class=\"tt\">Nflix Public Live TV</div><div class=\"td\">Add public TV channel catalogs from NflixMovies.</div></div><div class=\"switch\" data-switch></div></div>\n      </section>\n\n      </div>\n\n      <div class=\"tabpanel\" data-panel=\"support\">\n      <!-- 10 Support -->\n      <section class=\"card\" id=\"support\">\n        <div class=\"card-head\"><div><h2>Support NebulaStreams</h2><p>This add-on is completely free. Support only unlocks profile sync, backups, dashboard themes, and short install URLs — it never changes free provider access, stream quality, or stream count.</p></div></div>\n        <div class=\"banner\" style=\"margin-bottom:18px\">\n          <span class=\"ico\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M12 21C6 16.5 3 13 3 9a4 4 0 017-2.5A4 4 0 0117 9c0 4-3 7.5-9 12z\" stroke-linejoin=\"round\"/></svg></span>\n          <div><div class=\"bt\">50% donation pledge</div><div class=\"bd\">Half of supporter donations is set aside for charities and humanitarian programs such as UNICEF, UNFPA, and CRY — and similar child welfare and emergency aid efforts. Remaining funds cover NebulaStreams hosting and maintenance. If you would like to support without donating, <a href=\"https://omg10.com/4/11165437\" target=\"_blank\" rel=\"noopener sponsored\" style=\"color:var(--text);text-decoration:underline\">click here</a>, wait 20 seconds, then close the tab.</div></div>\n        </div>\n        <div class=\"price-grid\">\n          <div class=\"price\">\n            <div class=\"pkr\"><span class=\"pn\">Nebula Supporter</span><span class=\"pp\">$1 / month</span></div>\n            <p class=\"pcap\">Monthly supporter — cloud convenience while keeping every stream feature free.</p>\n            <ul>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Supporter badge</li>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Saved cloud profiles &amp; profile sync</li>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Multiple config backups</li>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Short install URLs</li>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Early feature access &amp; priority support</li>\n            </ul>\n          </div>\n          <div class=\"price feature\">\n            <div class=\"pkr\"><span class=\"pn\">Nebula Founder</span><span class=\"pp\">$5 / lifetime</span></div>\n            <p class=\"pcap\">One-time support with founder status and lifetime perks.</p>\n            <ul>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Everything in Supporter</li>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Lifetime founder badge</li>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Founder recognition wall</li>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Exclusive themes</li>\n              <li><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\"><path d=\"M5 13l4 4L19 7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg> Future supporter perks included</li>\n            </ul>\n          </div>\n        </div>\n\n        <div class=\"field\" style=\"border-top:1px solid var(--border-soft);margin-top:6px\">\n          <div class=\"toolbar\" style=\"margin:0\">\n            <button class=\"btn\" style=\"flex:0 0 auto;padding:9px 16px\">Support on Ko-fi</button>\n            <button class=\"ghost-btn\">More ways to support</button>\n            <button class=\"ghost-btn\">Open dashboard</button>\n          </div>\n        </div>\n        <div class=\"grid-2\">\n          <div class=\"stack\"><span class=\"lbl\">Supporter code</span><input class=\"input\" placeholder=\"Enter your supporter code…\" /><span class=\"sub-hint\">Supporter perks do not change free stream results.</span></div>\n          <div class=\"stack\"><span class=\"lbl\">Cloud profile name</span><input class=\"input\" placeholder=\"e.g. Living room TV\" />\n            <div class=\"toolbar\" style=\"margin:6px 0 0\"><button class=\"ghost-btn\">Save current config</button></div>\n            <span class=\"sub-hint\">Save provider, quality, TorBox, IPTV, adapter, and advanced settings to supporter cloud.</span>\n          </div>\n        </div>\n\n        <div class=\"field\">\n          <div class=\"faq\">\n            <div><h4>Why support?</h4><p>Hosting, proxy traffic, provider fixes, and uptime work cost money and time.</p></div>\n            <div><h4>Free users?</h4><p>No provider, quality, stream count, or playback feature is ever gated.</p></div>\n            <div><h4>Payments?</h4><p>Ko-fi sends a webhook. Nebula creates a supporter code and emails it.</p></div>\n            <div><h4>Cloud sync?</h4><p>Supporters can sync, backup, restore, export, and use short install URLs.</p></div>\n          </div>\n        </div>\n      </section>\n\n      <!-- 11 Notes -->\n      <section class=\"card\" id=\"notes\">\n        <div class=\"card-head\"><div><h2>Operational notes</h2><p>A few practical details about how the add-on behaves.</p></div></div>\n        <div class=\"notes\">\n          <div class=\"note-item\"><span class=\"nk\">Quality order</span><span><b>Only affects ranking.</b> It can't invent missing qualities providers don't have.</span></div>\n          <div class=\"note-item\"><span class=\"nk\">Web-ready</span><span><b>Filters hard.</b> Use only for the safest direct-play subset.</span></div>\n          <div class=\"note-item\"><span class=\"nk\">Cold starts</span><span>First request can be slower while the backend wakes up and queries providers in parallel.</span></div>\n          <div class=\"note-item\"><span class=\"nk\">Media hosting</span><span>NebulaStreams does not store media. It discovers external links and passes them through configured playback.</span></div>\n        </div>\n      </section>\n\n      </div>\n\n      <footer class=\"footer\">\n        <span>NebulaStreams — community Stremio add-on</span>\n        <span>60,107 active users · 115 providers · 2 supporters</span>\n      </footer>\n    </main>\n  </div>\n\n  <div class=\"toast\" id=\"toast\">Manifest URL copied</div>\n\n<script>\n  const PROVIDERS = [\"nuvio\",\"nuvio-latino\",\"nuvio-french\",\"nuvio-italian\",\"nuvio-2\",\"cloudstream-phisher\",\"r2-plugin\",\"r3-plugin\",\"r4-asian-drama-movies\",\"r5-plugin\",\"streamrip-plugin\",\"pstream\",\"torrentio\",\"comet\",\"mediafusion\",\"orion\"];\n  const grid = document.getElementById('provGrid');\n  const countEl = document.getElementById('provCount');\n  function refreshCount(){\n    const all = grid.querySelectorAll('.provider').length;\n    const on = grid.querySelectorAll('.provider.on').length;\n    countEl.textContent = on === all ? 'All providers selected' : (on === 0 ? 'No providers selected — falls back to all' : on + ' of ' + all + ' providers selected');\n  }\n  PROVIDERS.forEach(name => {\n    const el = document.createElement('div');\n    el.className = 'provider on'; el.dataset.name = name;\n    el.innerHTML = '<span class=\"box\"></span><span class=\"pname\">' + name + '</span>';\n    el.addEventListener('click', () => { el.classList.toggle('on'); refreshCount(); });\n    grid.appendChild(el);\n  });\n  document.getElementById('selAll').onclick = () => { grid.querySelectorAll('.provider').forEach(p => p.classList.add('on')); refreshCount(); };\n  document.getElementById('clearAll').onclick = () => { grid.querySelectorAll('.provider').forEach(p => p.classList.remove('on')); refreshCount(); };\n  document.getElementById('provSearch').addEventListener('input', e => {\n    const q = e.target.value.toLowerCase();\n    grid.querySelectorAll('.provider').forEach(p => { p.style.display = p.dataset.name.includes(q) ? 'flex' : 'none'; });\n  });\n\n  document.querySelectorAll('[data-multi] .chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('on')));\n  document.querySelectorAll('[data-seg]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {\n    seg.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on');\n  })));\n  document.querySelectorAll('[data-switch]').forEach(s => s.addEventListener('click', () => s.classList.toggle('on')));\n  document.querySelectorAll('#presetGrid .preset').forEach(p => p.addEventListener('click', () => {\n    document.querySelectorAll('#presetGrid .preset').forEach(x => x.classList.remove('on')); p.classList.add('on');\n    document.querySelector('.preset-foot').textContent = 'Preset: ' + p.querySelector('.pt').textContent;\n  }));\n\n  const toast = document.getElementById('toast');\n  function showToast(msg){ toast.textContent = msg; toast.classList.add('show'); setTimeout(()=>toast.classList.remove('show'), 1800); }\n  document.getElementById('copyBtn').onclick = () => { navigator.clipboard && navigator.clipboard.writeText('https://nebula.work.gd/manifest.json'); showToast('Manifest URL copied'); };\n  document.getElementById('installBtn').onclick = () => showToast('Opening Stremio…');\n\n  const tabs = [...document.querySelectorAll('#tabbar .tab')];\n  const panels = [...document.querySelectorAll('.tabpanel')];\n  tabs.forEach(t => t.addEventListener('click', () => {\n    tabs.forEach(x => x.classList.toggle('on', x === t));\n    const name = t.dataset.tab;\n    panels.forEach(p => p.classList.toggle('on', p.dataset.panel === name));\n    window.scrollTo({ top: 0, behavior: 'smooth' });\n  }));\n  refreshCount();\n</script>\n</body>\n</html>\n";

  const configureRuntimeScript = String.raw`
  const manifestBox = document.querySelector('.url-box');
  let manifestUrl = window.location.origin + '/manifest.json';
  let stremioInstallUrl = 'stremio://addon-install?addon=' + encodeURIComponent(manifestUrl);
  let configTimer = null;
  let configRequest = 0;
  let configAbortController = null;

  function textOf(selector, root = document) {
    return root.querySelector(selector)?.textContent?.trim() || '';
  }

  function activeButtonValue(label) {
    const line = [...document.querySelectorAll('.seg-line')].find((item) => textOf(':scope > span', item) === label);
    return textOf('button.on', line).toLowerCase();
  }

  function switchEnabled(label) {
    const row = [...document.querySelectorAll('.toggle-row')].find((item) => textOf('.tt', item) === label);
    return Boolean(row?.querySelector('[data-switch].on'));
  }

  function inputByLabel(label, scope = document) {
    const stack = [...scope.querySelectorAll('.stack')].find((item) => textOf('.lbl', item) === label);
    return stack?.querySelector('input, select')?.value?.trim() || '';
  }

  function qualityKey(value) {
    const match = String(value || '').match(/2160|1440|1080|720|480|360/);
    return match ? match[0] + 'p' : String(value || '').trim().toLowerCase();
  }

  function numericChoice(label) {
    const value = activeButtonValue(label);
    return value === 'unlimited' ? 0 : (Number.parseInt(value, 10) || 0);
  }

  function setActiveButton(label, value) {
    const line = [...document.querySelectorAll('.seg-line')].find((item) => textOf(':scope > span', item) === label);
    if (!line) return;
    const normalized = String(value).toLowerCase();
    line.querySelectorAll('button').forEach((button) => {
      button.classList.toggle('on', button.textContent.trim().toLowerCase() === normalized);
    });
  }

  function setSwitch(label, enabled) {
    const row = [...document.querySelectorAll('.toggle-row')].find((item) => textOf('.tt', item) === label);
    row?.querySelector('[data-switch]')?.classList.toggle('on', Boolean(enabled));
  }

  function setInput(label, value, scope = document) {
    const stack = [...scope.querySelectorAll('.stack')].find((item) => textOf('.lbl', item) === label);
    const input = stack?.querySelector('input, select');
    if (input) input.value = value ?? '';
  }

  function setAllowedQualities(qualities) {
    const wanted = new Set(qualities);
    document.querySelectorAll('#simple [data-multi] .chip').forEach((chip) => {
      chip.classList.toggle('on', wanted.has(qualityKey(chip.textContent)));
    });
  }

  function setProviders(providerIds = []) {
    const wanted = new Set(providerIds);
    grid.querySelectorAll('.provider').forEach((provider) => {
      provider.classList.toggle('on', wanted.size === 0 || wanted.has(provider.dataset.name));
    });
    refreshCount();
  }

  function markCustom() {
    document.querySelectorAll('#presetGrid .preset').forEach((preset) => preset.classList.remove('on'));
    const footer = document.querySelector('.preset-foot');
    if (footer) footer.textContent = 'Preset: Custom';
  }

  const PRESETS = {
    'Web Fast': {
      qualities: ['1080p', '720p', '480p'], sorting: 'Highest non-4K', maxPerQuality: '3',
      switches: { 'Web-ready only': true, 'Hide HEVC / HDR / 10-bit': true, 'Prefer H.264 / x264': true, 'Prefer direct hosts': true },
      dedupe: 'Smart', maxSize: '5 GB', audio: 'Any language', providers: []
    },
    'Mobile Data': {
      qualities: ['720p', '480p'], sorting: 'Balanced', maxPerQuality: '2', maxPerProvider: '2',
      switches: { 'Hide HEVC / HDR / 10-bit': true, 'Prefer H.264 / x264': true, 'Prefer smaller files': true },
      dedupe: 'Smart', maxSize: '3 GB', audio: 'Any language', providers: []
    },
    '4K HDR': {
      qualities: ['2160p', '1080p'], sorting: 'Highest quality',
      switches: { 'Prefer HDR': true, 'Prefer direct hosts': true },
      dedupe: 'Smart', maxSize: 'No limit', audio: 'Any language', providers: []
    },
    Anime: {
      qualities: ['1080p', '720p', '480p'], sorting: 'Balanced',
      switches: { 'Prefer H.264 / x264': true }, dedupe: 'Smart', maxSize: '5 GB', audio: 'Japanese',
      providers: ['anime-nexus', 'anime-sama', 'animekai', 'animepahe', 'allwish', 'kisskh']
    },
    'Indian Content': {
      qualities: ['1080p', '720p', '480p'], sorting: 'Balanced',
      switches: { 'Prefer direct hosts': true }, dedupe: 'Smart', maxSize: '10 GB', audio: 'Hindi',
      providers: ['hindmoviez', 'tamilian', 'gramcinema', 'isaidub', 'hdmovie2', 'flixindia']
    },
    'Turkish Content': {
      qualities: ['1080p', '720p', '480p'], sorting: 'Balanced',
      switches: {}, dedupe: 'Smart', maxSize: '10 GB', audio: 'Turkish',
      providers: ['vidmody-tr', 'turkish-m3u', 'rectv-tr', 'diziyou']
    },
    'Italian Content': {
      qualities: ['1080p', '720p', '480p'], sorting: 'Balanced',
      switches: {}, dedupe: 'Smart', maxSize: '10 GB', audio: 'Italian',
      providers: ['it-streamingcommunity', 'it-guardahd', 'it-guardaserie', 'it-animeunity', 'it-animeworld']
    },
    'Latino Content': {
      qualities: ['1080p', '720p', '480p'], sorting: 'Balanced',
      switches: {}, dedupe: 'Smart', maxSize: '10 GB', audio: 'Latino',
      providers: ['nuvio-latino', 'latino-lamovie', 'latino-embed69', 'latino-cinecalidad', 'latino-seriesmetro']
    },
    'French Content': {
      qualities: ['1080p', '720p', '480p'], sorting: 'Balanced',
      switches: {}, dedupe: 'Smart', maxSize: '10 GB', audio: 'Any language',
      providers: ['nuvio-french', 'fr-anime-sama', 'fr-frenchstream', 'fr-movix', 'fr-voiranime']
    },
    'Arabic Content': {
      qualities: ['1080p', '720p', '480p'], sorting: 'Balanced',
      switches: {}, dedupe: 'Smart', maxSize: '10 GB', audio: 'Arabic',
      providers: ['arabic-faselhd', 'arabic-cineby', 'arabic-witanime', 'arabic-animecloud']
    }
  };

  function applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    document.querySelectorAll('#presetGrid .preset').forEach((button) => {
      button.classList.toggle('on', textOf('.pt', button) === name);
    });
    const footer = document.querySelector('.preset-foot');
    if (footer) footer.textContent = 'Preset: ' + name;
    setAllowedQualities(preset.qualities);
    setActiveButton('Default sorting', preset.sorting);
    setActiveButton('Max per quality', preset.maxPerQuality || 'Unlimited');
    setActiveButton('Max per provider', preset.maxPerProvider || 'Unlimited');
    setActiveButton('Deduplication mode', preset.dedupe || 'Off');
    setActiveButton('Content selection', 'Default');
    setInput('Maximum file size', preset.maxSize || 'No limit');
    setInput('Preferred audio language', preset.audio || 'Any language');
    [
      'Web-ready only', 'Hide HEVC / HDR / 10-bit', 'Prefer HDR', 'Prefer H.264 / x264',
      'Prefer smaller files', 'Prefer direct hosts'
    ].forEach((label) => setSwitch(label, Boolean(preset.switches?.[label])));
    setProviders(preset.providers.filter((id) => PROVIDERS.includes(id)));
  }

  function adapterSelections() {
    const selections = {};
    document.querySelectorAll('[data-adapter-id]').forEach((group) => {
      const selected = [...group.querySelectorAll('.adapter-provider.on')].map((item) => item.dataset.providerId);
      if (selected.length) selections[group.dataset.adapterId] = selected;
    });
    return selections;
  }

  function buildConfigPayload() {
    const selectedProviders = [...grid.querySelectorAll('.provider.on')].map((item) => item.dataset.name);
    const providers = selectedProviders.length === PROVIDERS.length ? [] : selectedProviders;
    const qualityChips = [...document.querySelectorAll('#simple [data-multi] .chip')];
    const selectedQualityChips = qualityChips.filter((item) => item.classList.contains('on'));
    const allowedQualities = selectedQualityChips.length === qualityChips.length
      ? []
      : selectedQualityChips.map((item) => qualityKey(item.textContent));
    const manualQualityPriority = [...document.querySelectorAll('#prioList .pq')].map((item) => qualityKey(item.textContent));
    const sortingValue = activeButtonValue('Default sorting');
    const qualityPriority = sortingValue === 'highest non-4k'
      ? ['1080p', '720p', '480p', '360p', '2160p', '1440p', 'auto', 'unknown']
      : sortingValue === 'balanced'
        ? ['1080p', '720p', '2160p', '480p', '1440p', '360p', 'auto', 'unknown']
        : manualQualityPriority;
    const contentValue = activeButtonValue('Content selection');
    const audio = inputByLabel('Preferred audio language');
    const maxSize = Number.parseFloat(inputByLabel('Maximum file size')) || 0;
    const blockedHosts = inputByLabel('Blocked hosts').split(',').map((value) => value.trim()).filter(Boolean);
    const dedupeText = activeButtonValue('Deduplication mode');
    const formatterStyle = activeButtonValue('Stream card formatter') || 'clean';
    const torboxScope = document.querySelector('#torbox');
    const iptvScope = document.querySelector('#iptv');
    const xtream = iptvScope?.querySelectorAll('details')[0];
    const stalker = iptvScope?.querySelectorAll('details')[1];
    const presetCodes = {
      'Web Fast': 'wf', 'Mobile Data': 'md', '4K HDR': '4k', Anime: 'an',
      'Indian Content': 'in', 'Turkish Content': 'tr', 'Italian Content': 'it',
      'Latino Content': 'la', 'French Content': 'fr', 'Arabic Content': 'ar'
    };
    const presetName = textOf('#presetGrid .preset.on .pt');

    return {
      providers,
      qualityPriority,
      profileCode: presetCodes[presetName] || null,
      streamOptions: {
        allowedQualities,
        contentSelection: contentValue.startsWith('movies') ? 'movie' : contentValue.startsWith('series') ? 'series' : 'default',
        maxPerQuality: numericChoice('Max per quality'),
        maxPerProvider: numericChoice('Max per provider'),
        webReadyOnly: switchEnabled('Web-ready only'),
        hideHeavyFormats: switchEnabled('Hide HEVC / HDR / 10-bit'),
        formatterStyle,
        preferredAudioLanguage: audio === 'Any language' ? null : audio.toLowerCase(),
        maxSizeGb: maxSize,
        blockHosts: blockedHosts,
        customProxyUrl: inputByLabel('Custom proxy URL') || null,
        dedupeMode: dedupeText === 'smart' ? 'smart' : dedupeText.startsWith('by filename') ? 'filename' : dedupeText.startsWith('host') ? 'host-quality' : 'off',
        preferHdr: switchEnabled('Prefer HDR'),
        preferH264: switchEnabled('Prefer H.264 / x264'),
        preferSmallerFiles: switchEnabled('Prefer smaller files'),
        preferDirectHosts: switchEnabled('Prefer direct hosts'),
        torboxOnlyStreams: switchEnabled('TorBox-only streams'),
        torboxUsenet: switchEnabled('TorBox Usenet'),
        pluginProviderSelections: adapterSelections()
      },
      privateProviderSettings: {
        febboxUiCookie: inputByLabel('Febbox UI cookie (ShowBox)') || null,
        torboxApiKey: inputByLabel('API key', torboxScope) || null,
        xtreamServerUrl: inputByLabel('Server URL', xtream) || null,
        xtreamUsername: inputByLabel('Username', xtream) || null,
        xtreamPassword: inputByLabel('Password', xtream) || null,
        stalkerPortalUrl: inputByLabel('Stalker portal URL', stalker) || null,
        stalkerMacAddress: inputByLabel('Stalker MAC address', stalker) || null,
        stalkerStbType: inputByLabel('STB type', stalker) || null,
        stalkerSerialNumber: inputByLabel('Serial number', stalker) || null,
        stalkerDeviceId: inputByLabel('Device ID', stalker) || null,
        stalkerDeviceId2: inputByLabel('Device ID 2', stalker) || null,
        stalkerCategoryOffset: Number.parseInt(inputByLabel('Category start', stalker), 10) || 0,
        stalkerCategoryLimit: Number.parseInt(inputByLabel('Category catalogs', stalker), 10) || 40,
        famelackLiveEnabled: switchEnabled('Famelack Public Live TV'),
        nflixLiveEnabled: switchEnabled('Nflix Public Live TV')
      },
      supporterCode: inputByLabel('Supporter code') || ''
    };
  }

  function renderManifestUrl(url, installUrl = '') {
    manifestUrl = url;
    stremioInstallUrl = installUrl || 'stremio://addon-install?addon=' + encodeURIComponent(url);
    manifestBox.textContent = url;
  }

  async function refreshManifestUrl() {
    const requestId = ++configRequest;
    if (configAbortController) {
      configAbortController.abort();
    }
    configAbortController = new AbortController();
    manifestBox.textContent = 'Generating private install URL...';
    try {
      const response = await fetch('/configure/private-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(buildConfigPayload()),
        signal: configAbortController.signal
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not create config');
      if (requestId !== configRequest) return;
      renderManifestUrl(result.manifestUrl || window.location.origin + result.manifestPath, result.stremioInstallUrl);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (requestId !== configRequest) return;
      manifestBox.textContent = error.message || 'Could not create install URL';
    }
  }

  function scheduleManifestRefresh(delayMs = 350) {
    window.clearTimeout(configTimer);
    configTimer = window.setTimeout(refreshManifestUrl, delayMs);
  }

  function getManifestRefreshDelay(target) {
    if (!target) return 350;
    const input = target.closest?.('input');
    if (!input) return 350;
    const inputType = String(input.type || '').toLowerCase();
    if (inputType === 'checkbox' || inputType === 'radio' || inputType === 'number') return 350;
    return 1000;
  }

  document.addEventListener('click', (event) => {
    const preset = event.target.closest('#presetGrid .preset');
    if (preset) {
      applyPreset(textOf('.pt', preset));
    } else if (event.target.closest('.chip, [data-seg] button, [data-switch], .provider, #selAll, #clearAll, .adapter-provider')) {
      markCustom();
    }
    if (event.target.closest('.chip, [data-seg] button, [data-switch], .provider, .preset, #selAll, #clearAll, .adapter-provider')) {
      scheduleManifestRefresh();
    }
  });
  document.addEventListener('input', (event) => {
    if (event.target.matches('input, select')) scheduleManifestRefresh(getManifestRefreshDelay(event.target));
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('input, select')) scheduleManifestRefresh();
  });

  document.getElementById('copyBtn').onclick = async () => {
    await navigator.clipboard?.writeText(manifestUrl);
    showToast('Manifest URL copied');
  };
  document.getElementById('installBtn').onclick = () => {
    window.location.href = stremioInstallUrl;
  };

  async function loadAdapterProviders() {
    const container = document.querySelector('#adapters .adapter-empty');
    if (!container) return;
    try {
      const response = await fetch('/configure/adapter-providers', { headers: { accept: 'application/json' } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load adapter providers');
      const groups = (result.groups || []).filter((group) => Array.isArray(group.providers) && group.providers.length);
      if (!groups.length) {
        container.textContent = 'No adapter provider selections are available.';
        return;
      }
      container.className = '';
      container.innerHTML = groups.map((group) =>
        '<details class="collap field" data-adapter-id="' + String(group.adapterId || group.id).replace(/"/g, '&quot;') + '">' +
          '<summary><div><div class="field-label">' + group.label + '</div><div class="field-hint" style="margin-bottom:0">Choose sources, or leave all unchecked to use every source.</div></div>' +
          '<span class="caret">›</span></summary><div class="body"><div class="chips">' +
          group.providers.map((provider) => '<span class="chip adapter-provider" data-provider-id="' + String(provider.id).replace(/"/g, '&quot;') + '">' + provider.label + '</span>').join('') +
          '</div></div></details>'
      ).join('');
      container.querySelectorAll('.adapter-provider').forEach((item) => {
        item.addEventListener('click', () => item.classList.toggle('on'));
      });
    } catch (error) {
      container.textContent = error.message || 'Could not load adapter providers.';
    }
  }

  const priorityList = document.getElementById('prioList');
  function refreshPriorityRanks() {
    priorityList?.querySelectorAll('.prio-item').forEach((item, index) => {
      const rank = item.querySelector('.rank');
      if (rank) rank.textContent = String(index + 1).padStart(2, '0');
    });
  }
  priorityList?.querySelectorAll('.prio-item').forEach((item) => {
    item.draggable = true;
    item.addEventListener('dragstart', () => item.classList.add('dragging'));
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      refreshPriorityRanks();
      setActiveButton('Default sorting', 'Highest quality');
      markCustom();
      scheduleManifestRefresh();
    });
  });
  priorityList?.addEventListener('dragover', (event) => {
    event.preventDefault();
    const dragging = priorityList.querySelector('.dragging');
    if (!dragging) return;
    const siblings = [...priorityList.querySelectorAll('.prio-item:not(.dragging)')];
    const next = siblings.find((item) => event.clientY < item.getBoundingClientRect().top + item.offsetHeight / 2);
    priorityList.insertBefore(dragging, next || null);
  });

  const resetPriorityButton = document.querySelector('#priority .ghost-btn');
  resetPriorityButton?.addEventListener('click', () => {
    const order = ['2160p', '1440p', '1080p', '720p', '480p', '360p', 'auto', 'unknown'];
    order.forEach((quality) => {
      const item = [...priorityList.querySelectorAll('.prio-item')].find((row) => qualityKey(textOf('.pq', row)) === quality);
      if (item) priorityList.appendChild(item);
    });
    refreshPriorityRanks();
    setActiveButton('Default sorting', 'Highest quality');
    markCustom();
    scheduleManifestRefresh();
  });

  const supportButtons = [...document.querySelectorAll('#support button')];
  const supportUrl = ${JSON.stringify(config.DONATION_PRIMARY_URL || 'https://ko-fi.com/retro76005')};
  function openSupportPage() {
    window.open(supportUrl, '_blank', 'noopener,noreferrer');
  }
  document.querySelectorAll('#support .price').forEach((card) => {
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', textOf('.pn', card) + ' — open Ko-fi');
    card.style.cursor = 'pointer';
    card.addEventListener('click', openSupportPage);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSupportPage();
      }
    });
  });
  supportButtons.find((button) => button.textContent.trim() === 'Support on Ko-fi')?.addEventListener('click', () => {
    openSupportPage();
  });
  supportButtons.find((button) => button.textContent.trim() === 'More ways to support')?.addEventListener('click', () => {
    window.location.href = '/dashboard';
  });
  supportButtons.find((button) => button.textContent.trim() === 'Open dashboard')?.addEventListener('click', () => {
    window.location.href = '/dashboard';
  });
  supportButtons.find((button) => button.textContent.trim() === 'Save current config')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const supporterCode = inputByLabel('Supporter code');
    const name = inputByLabel('Cloud profile name') || 'Default';
    if (!supporterCode) {
      showToast('Enter a supporter code first');
      return;
    }
    button.disabled = true;
    try {
      const response = await fetch('/configure/supporter-profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ supporterCode, name, configJson: buildConfigPayload() })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save profile');
      showToast('Cloud profile saved');
      if (result.shortUrl) renderManifestUrl(result.shortUrl + '/manifest.json');
    } catch (error) {
      showToast(error.message || 'Could not save profile');
    } finally {
      button.disabled = false;
    }
  });

  applyPreset(textOf('#presetGrid .preset.on .pt'));
  loadAdapterProviders();
  refreshManifestUrl();`;

  html = html
    .replaceAll(
      '.brand-name { font-weight: 650;',
      '.brand-logo { width: 30px; height: 30px; border-radius: 8px; object-fit: cover; flex-shrink: 0; }\n  .brand-name { font-weight: 650;'
    )
    .replaceAll(
      '<div class="brand-mark"></div>',
      '<img class="brand-logo" src="' + escapedBaseUrl + '/assets/WhatsApp%20Image%202026-04-25%20at%2012.16.53%20AM.jpeg" alt="NebulaStreams logo">'
    )
    .replaceAll('https://nebula.work.gd/manifest.json', escapedBaseUrl + '/manifest.json')
    .replaceAll('nebula.work.gd/manifest.json', escapedBaseUrl.replace(/^https?:\/\//u, '') + '/manifest.json')
    .replaceAll('Live · 115 providers', 'Live · ' + providerCount + ' providers')
    .replaceAll('115 providers', providerCount + ' providers')
    .replaceAll('<div class="meta"><div class="v">115</div><div class="l">Providers</div></div>', '<div class="meta"><div class="v">' + providerCount + '</div><div class="l">Providers</div></div>')
    .replaceAll('60,107 active users · 115 providers · 2 supporters', activeUserCount + ' active users · ' + providerCount + ' providers · ' + supporterCount + ' supporters')
    .replaceAll('<span class="tc-name">Shadow</span>', '<span class="tc-name">Shadow</span><span class="tc-name">S10skillz</span>')
    .replaceAll('<button class="preset on"><div class="pt">Web Fast</div>', '<button class="preset"><div class="pt">Web Fast</div>')
    .replaceAll('<span class="chip on">2160p (4K)</span><span class="chip on">1080p</span><span class="chip on">720p</span><span class="chip">480p</span>', '<span class="chip on">2160p (4K)</span><span class="chip on">1080p</span><span class="chip on">720p</span><span class="chip on">480p</span>')
    .replaceAll('<button>Off</button><button class="on">Smart</button>', '<button class="on">Off</button><button>Smart</button>')
    .replaceAll('<div class="tt">Prefer H.264 / x264</div><div class="td">For players that struggle with HEVC.</div></div><div class="switch on" data-switch></div>', '<div class="tt">Prefer H.264 / x264</div><div class="td">For players that struggle with HEVC.</div></div><div class="switch" data-switch></div>')
    .replaceAll('<div class="tt">Prefer direct hosts</div><div class="td">Direct HTTP above streams that need extra headers.</div></div><div class="switch on" data-switch></div>', '<div class="tt">Prefer direct hosts</div><div class="td">Direct HTTP above streams that need extra headers.</div></div><div class="switch" data-switch></div>')
    .replaceAll('href="#" class="btn primary"', 'href="' + escapedBaseUrl + '/movies" class="btn primary"')
    .replaceAll('href="#" class="btn"', 'href="' + escapedBaseUrl + '/sports" class="btn"')
    .replaceAll(
      '              Nebula Sports\n            </a>',
      '              Nebula Sports\n            </a>\n            <a href="' + escapedBaseUrl + '/watch-together" class="btn">\n              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>\n              Sports web\n            </a>'
    )
    .replaceAll('<a href="#">Movie Site</a>', '<a href="' + escapedBaseUrl + '/movies">Movie Site</a>')
    .replaceAll('<a href="#">Sports</a>', '<a href="' + escapedBaseUrl + '/sports">Sports</a>');

  html = html.replace(
    "document.getElementById('copyBtn').onclick = () => { navigator.clipboard && navigator.clipboard.writeText('" + escapedBaseUrl + "/manifest.json'); showToast('Manifest URL copied'); };\n  document.getElementById('installBtn').onclick = () => showToast('Opening Stremio…');",
    configureRuntimeScript
  );

  html = html.replace("const PROVIDERS = [\"nuvio\",\"nuvio-latino\",\"nuvio-french\",\"nuvio-italian\",\"nuvio-2\",\"cloudstream-phisher\",\"r2-plugin\",\"r3-plugin\",\"r4-asian-drama-movies\",\"r5-plugin\",\"streamrip-plugin\",\"pstream\",\"torrentio\",\"comet\",\"mediafusion\",\"orion\"];", 'const PROVIDERS = ' + JSON.stringify(providerIds) + ';');
  return html;
};
const renderAdminPage = ({ stats, createdSupporterCode = '' }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Admin</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0f19;
        --panel: #141b2a;
        --panel-2: #1a2335;
        --text: #eef3ff;
        --muted: #98a7c7;
        --accent: #66b6ff;
        --border: rgba(255,255,255,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(102,182,255,0.18), transparent 24%),
          radial-gradient(circle at top right, rgba(123,112,255,0.18), transparent 20%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 34px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }
      p {
        margin: 0;
        color: var(--muted);
      }
      .logout-form {
        margin: 0;
      }
      .logout-form button {
        appearance: none;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 10px 14px;
        background: var(--panel);
        color: var(--text);
        cursor: pointer;
        font: inherit;
      }
      input, button {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 9px 10px;
        background: var(--panel);
        color: var(--text);
        font: inherit;
      }
      button {
        cursor: pointer;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 16px;
        margin-top: 24px;
      }
      .card {
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .value {
        margin-top: 8px;
        font-size: 28px;
        font-weight: 700;
      }
      .section {
        margin-top: 28px;
        padding: 22px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: var(--panel);
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
        margin-top: 16px;
      }
      .table-wrap {
        width: 100%;
        overflow-x: auto;
        margin-top: 16px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: rgba(0,0,0,0.18);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 940px;
      }
      th, td {
        padding: 11px 12px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        background: rgba(255,255,255,0.03);
      }
      tr:last-child td {
        border-bottom: 0;
      }
      .provider-id {
        display: block;
        margin-top: 2px;
        color: var(--muted);
        font-size: 12px;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 4px 9px;
        border: 1px solid var(--border);
        color: var(--text);
        background: rgba(255,255,255,0.06);
        font-size: 12px;
        font-weight: 700;
        text-transform: capitalize;
      }
      .status-ok,
      .status-cache-hit {
        border-color: rgba(76, 217, 160, 0.35);
        background: rgba(76, 217, 160, 0.12);
        color: #aef4d7;
      }
      .status-running {
        border-color: rgba(102, 182, 255, 0.42);
        background: rgba(102, 182, 255, 0.14);
        color: #bfe3ff;
      }
      .status-intermittent {
        border-color: rgba(255, 201, 92, 0.38);
        background: rgba(255, 201, 92, 0.12);
        color: #ffe4a3;
      }
      .status-empty,
      .status-idle {
        border-color: rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.04);
        color: var(--muted);
      }
      .status-failing,
      .status-cooldown {
        border-color: rgba(255, 123, 138, 0.45);
        background: rgba(255, 123, 138, 0.14);
        color: #ffc3cb;
      }
      .provider-error {
        display: inline-block;
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #ffc3cb;
      }
      .muted-inline {
        color: var(--muted);
      }
      code {
        display: inline-block;
        margin-top: 6px;
        padding: 8px 10px;
        border-radius: 12px;
        background: var(--panel-2);
        color: #dff1ff;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="header">
        <div>
          <h1>NebulaStreams Admin</h1>
          <p>Private runtime dashboard for service health, usage, cache, provider state, and source registry.</p>
        </div>
        <form class="logout-form" method="post" action="/admin/logout">
          <button type="submit">Sign out</button>
        </form>
      </div>

      <section class="grid">
        <div class="card"><div class="label">Uptime</div><div class="value">${stats.runtime.uptimeSeconds}s</div></div>
        <div class="card"><div class="label">System CPU</div><div class="value">${formatPercent(stats.system.cpuUsagePercent)}</div></div>
        <div class="card"><div class="label">System Memory</div><div class="value">${formatPercent(stats.system.memoryUsagePercent)}</div></div>
        <div class="card"><div class="label">Process RSS</div><div class="value">${formatBytes(stats.system.processRssBytes)}</div></div>
        <div class="card"><div class="label">Active Streams</div><div class="value">${stats.runtime.activeStreams}/${stats.runtime.maxActiveStreams}</div></div>
        <div class="card"><div class="label">Stream Searches</div><div class="value">${stats.runtime.streamSearchesInFlight}/${stats.runtime.maxStreamSearchesInFlight}</div></div>
        <div class="card"><div class="label">Active Torrents</div><div class="value">${stats.runtime.activeTorrentEngines}</div></div>
        <div class="card"><div class="label">Human Users</div><div class="value">${stats.users.totalUsers}</div></div>
        <div class="card"><div class="label">Users 24h</div><div class="value">${stats.users.activeUsers24h}</div></div>
        <div class="card"><div class="label">Configure Users</div><div class="value">${stats.users.configureUsers}</div></div>
        <div class="card"><div class="label">Stream Users</div><div class="value">${stats.users.streamUsers}</div></div>
        <div class="card"><div class="label">Human Requests</div><div class="value">${stats.users.totalTrackedRequests}</div></div>
      </section>

      <section class="section">
        <h2>System</h2>
        <div class="meta-grid">
          <div><div class="label">CPU Usage</div><code>${escapeHtml(formatPercent(stats.system.cpuUsagePercent))}</code></div>
          <div><div class="label">CPU Cores</div><code>${escapeHtml(String(stats.system.cpuCount))}</code></div>
          <div><div class="label">Load Average</div><code>${escapeHtml(stats.system.loadAverage.map((value) => value.toFixed(2)).join(' / '))}</code></div>
          <div><div class="label">Memory Used</div><code>${escapeHtml(formatBytes(stats.system.usedMemoryBytes))}</code></div>
          <div><div class="label">Memory Available</div><code>${escapeHtml(formatBytes(stats.system.availableMemoryBytes))}</code></div>
          <div><div class="label">Memory Free</div><code>${escapeHtml(formatBytes(stats.system.freeMemoryBytes))}</code></div>
          <div><div class="label">Memory Total</div><code>${escapeHtml(formatBytes(stats.system.totalMemoryBytes))}</code></div>
          <div><div class="label">Process RSS</div><code>${escapeHtml(formatBytes(stats.system.processRssBytes))}</code></div>
          <div><div class="label">Process Heap Used</div><code>${escapeHtml(formatBytes(stats.system.processHeapUsedBytes))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Traffic</h2>
        <div class="meta-grid">
          <div><div class="label">Raw Unique Clients</div><code>${escapeHtml(String(stats.users.rawUniqueClients))}</code></div>
          <div><div class="label">Raw Requests</div><code>${escapeHtml(String(stats.users.rawTrackedRequests))}</code></div>
          <div><div class="label">Bot Clients</div><code>${escapeHtml(String(stats.users.botClients))}</code></div>
          <div><div class="label">Bot Requests</div><code>${escapeHtml(String(stats.users.botRequests))}</code></div>
          <div><div class="label">Mixed Clients</div><code>${escapeHtml(String(stats.users.mixedClients))}</code></div>
          <div><div class="label">Configure Users</div><code>${escapeHtml(String(stats.users.configureUsers))}</code></div>
          <div><div class="label">Configure Requests</div><code>${escapeHtml(String(stats.users.configureRequests))}</code></div>
          <div><div class="label">Manifest Requests</div><code>${escapeHtml(String(stats.users.manifestRequests))}</code></div>
          <div><div class="label">Stream Requests</div><code>${escapeHtml(String(stats.users.streamRequests))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Nebula Sports Webapp</h2>
        <div class="meta-grid">
          <div><div class="label">Live Visitors</div><code>${escapeHtml(String(stats.watchTogether.liveVisitors))}</code></div>
          <div><div class="label">Live TTL</div><code>${escapeHtml(`${stats.watchTogether.liveTtlSeconds}s`)}</code></div>
          <div><div class="label">Chat Events</div><code>${escapeHtml(String(stats.watchTogether.chatEvents))}</code></div>
          <div><div class="label">Chat Messages</div><code>${escapeHtml(String(stats.watchTogether.chatMessages))}</code></div>
          <div><div class="label">Locked Chat Names</div><code>${escapeHtml(String(stats.watchTogether.lockedChatNames))}</code></div>
          <div><div class="label">Chat Cache Entries</div><code>${escapeHtml(String(stats.watchTogether.chatResponseCacheEntries))}</code></div>
          <div><div class="label">Chat Rate Buckets</div><code>${escapeHtml(String(stats.watchTogether.chatRateLimitClients))}</code></div>
          <div><div class="label">Sports Accounts</div><code>${escapeHtml(String(stats.watchTogether.sportsAccounts))}</code></div>
          <div><div class="label">Sports Active</div><code>${escapeHtml(String(stats.watchTogether.sportsActive))}</code></div>
          <div><div class="label">Sports Trials</div><code>${escapeHtml(String(stats.watchTogether.sportsTrials))}</code></div>
          <div><div class="label">Sports Tokens</div><code>${escapeHtml(String(stats.watchTogether.sportsTokens))}</code></div>
          <div><div class="label">Sports Payments</div><code>${escapeHtml(String(stats.watchTogether.sportsPayments))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Supporters</h2>
        ${createdSupporterCode ? `<div class="meta-grid"><div><div class="label">New Code - show once</div><code>${escapeHtml(createdSupporterCode)}</code></div></div>` : ''}
        <form method="post" action="/admin/supporters/create" style="display:grid;gap:12px;margin:12px 0;grid-template-columns:2fr 1fr 1fr auto;align-items:end">
          <label><span class="label">Label</span><input name="label" type="text" placeholder="Discord name / note"></label>
          <label><span class="label">Tier</span><input name="tier" type="text" value="supporter"></label>
          <label><span class="label">Months</span><input name="months" type="number" min="1" max="36" value="1"></label>
          <button type="submit">Create Code</button>
        </form>
        <div class="meta-grid">
          <div><div class="label">Total Codes</div><code>${escapeHtml(String(stats.supporters.total))}</code></div>
          <div><div class="label">Active</div><code>${escapeHtml(String(stats.supporters.active))}</code></div>
          <div><div class="label">Expired</div><code>${escapeHtml(String(stats.supporters.expired))}</code></div>
          <div><div class="label">Revoked</div><code>${escapeHtml(String(stats.supporters.revoked))}</code></div>
          <div><div class="label">Ko-fi Payments</div><code>${escapeHtml(String(stats.supporters.payments || 0))}</code></div>
          <div><div class="label">Emails Sent</div><code>${escapeHtml(String(stats.supporters.paymentEmailsSent || 0))}</code></div>
          <div><div class="label">Accounts</div><code>${escapeHtml(String(stats.supporters.accounts || 0))}</code></div>
          <div><div class="label">Founders</div><code>${escapeHtml(String(stats.supporters.founders || 0))}</code></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Status</th>
                <th>Tier</th>
                <th>Expires</th>
                <th>Last Used</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${renderSupporterRows(stats.supporters.codes)}
            </tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <h2>Stream Search</h2>
        <div class="meta-grid">
          <div><div class="label">Searches In Flight</div><code>${escapeHtml(`${stats.runtime.streamSearchesInFlight}/${stats.runtime.maxStreamSearchesInFlight}`)}</code></div>
          <div><div class="label">Background Refresh</div><code>${escapeHtml(`${stats.runtime.stremioBackgroundRefreshActive}/${stats.runtime.stremioBackgroundRefreshQueued}`)}</code></div>
          <div><div class="label">Stremio Result Cache</div><code>${escapeHtml(String(stats.runtime.stremioResultCacheEntries))}</code></div>
          <div><div class="label">Redis Result Cache</div><code>${escapeHtml(stats.runtime.redisStreamResultCache?.enabled ? (stats.runtime.redisStreamResultCache.available ? 'connected' : 'unavailable') : 'disabled')}</code></div>
          <div><div class="label">HubCloud Cache</div><code>${escapeHtml(String(stats.runtime.hubCloudCacheEntries))}</code></div>
          <div><div class="label">Popular Searches</div><code>${escapeHtml(String(stats.users.popularStreamSearches))}</code></div>
          <div><div class="label">Popular Prewarm</div><code>${escapeHtml(stats.runtime.popularStreamPrewarm?.enabled ? (stats.runtime.popularStreamPrewarm.running ? 'running' : 'enabled') : 'disabled')}</code></div>
          <div><div class="label">Last Prewarm</div><code>${escapeHtml(stats.runtime.popularStreamPrewarm?.lastFinishedAt || 'never')}</code></div>
          <div><div class="label">Last Prewarm Refreshed</div><code>${escapeHtml(String(stats.runtime.popularStreamPrewarm?.lastResultCount ?? 0))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Cache</h2>
        <div class="meta-grid">
          <div><div class="label">Cache Dir</div><code>${escapeHtml(stats.cache.cacheDir)}</code></div>
          <div><div class="label">Current Size</div><code>${escapeHtml(String(stats.cache.currentCacheSizeBytes))}</code></div>
          <div><div class="label">Max Size</div><code>${escapeHtml(String(stats.cache.maxCacheSizeBytes))}</code></div>
          <div><div class="label">HTTP Entries</div><code>${escapeHtml(String(stats.cache.httpEntries))}</code></div>
          <div><div class="label">Provider Entries</div><code>${escapeHtml(String(stats.cache.providerEntries))}</code></div>
          <div><div class="label">Torrent Entries</div><code>${escapeHtml(String(stats.cache.torrentEntries))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Providers</h2>
        <div class="meta-grid">
          <div><div class="label">Discovered</div><code>${escapeHtml(String(stats.providers.discoveredProviders))}</code></div>
          <div><div class="label">Memory Cache Entries</div><code>${escapeHtml(String(stats.providers.inMemoryCacheEntries))}</code></div>
          <div><div class="label">In-Flight Requests</div><code>${escapeHtml(String(stats.providers.inFlightRequests))}</code></div>
          <div><div class="label">Active Executions</div><code>${escapeHtml(String(stats.providers.activeProviderExecutions))}</code></div>
          <div><div class="label">Providers Cooling Down</div><code>${escapeHtml(String(stats.providers.coolingDownProviders))}</code></div>
          <div><div class="label">Hosts Cooling Down</div><code>${escapeHtml(String(stats.providers.coolingDownHosts))}</code></div>
          <div><div class="label">Provider Cache Dir</div><code>${escapeHtml(stats.providers.providerCacheDir)}</code></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Active</th>
                <th>Last Streams</th>
                <th>Last Time</th>
                <th>Failures</th>
                <th>Cooldown</th>
                <th>Last Seen</th>
                <th>Last Error</th>
              </tr>
            </thead>
            <tbody>
              ${renderProviderStatusRows(stats.providers.providers)}
            </tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <h2>Registry</h2>
        <div class="meta-grid">
          <div><div class="label">Source Entries</div><code>${escapeHtml(String(stats.sourceRegistry.entries))}</code></div>
          <div><div class="label">Fallback Entries</div><code>${escapeHtml(String(stats.sourceRegistry.activeFallbackEntries))}</code></div>
          <div><div class="label">TTL (ms)</div><code>${escapeHtml(String(stats.sourceRegistry.ttlMs))}</code></div>
        </div>
      </section>
    </main>
  </body>
</html>`;

const renderAdminLoginPage = ({ errorMessage = '' } = {}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Admin Login</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0f19;
        --panel: #141b2a;
        --text: #eef3ff;
        --muted: #98a7c7;
        --accent: #66b6ff;
        --danger: #ff7b8a;
        --border: rgba(255,255,255,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top left, rgba(102,182,255,0.18), transparent 24%),
          radial-gradient(circle at top right, rgba(123,112,255,0.18), transparent 20%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }
      .panel {
        width: min(420px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
        box-shadow: 0 20px 60px rgba(0,0,0,0.35);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 30px;
      }
      p {
        margin: 0;
        color: var(--muted);
      }
      form {
        display: grid;
        gap: 14px;
        margin-top: 22px;
      }
      label {
        display: grid;
        gap: 8px;
      }
      input {
        width: 100%;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--text);
        font: inherit;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 12px 16px;
        background: linear-gradient(135deg, var(--accent), #7b70ff);
        color: #081018;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      .error {
        margin-top: 14px;
        color: var(--danger);
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>NebulaStreams Admin</h1>
      <p>Sign in to view private runtime stats and usage data.</p>
      ${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ''}
      <form method="post" action="/admin/login">
        <label>
          <span>Username</span>
          <input name="username" type="text" autocomplete="username" required>
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;

const renderDonatePage = ({ baseUrl }) => {
  const donationPrimaryUrl = String(config.DONATION_PRIMARY_URL || '').trim();
  const primarySection = donationPrimaryUrl
    ? `
      <div class="support-card">
        <div class="support-label">Ko-fi</div>
        <div class="support-value">Support the project with Ko-fi.</div>
        <a class="copy-button" href="${escapeHtml(donationPrimaryUrl)}" target="_blank" rel="noopener">Open Ko-fi</a>
      </div>
    `
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Donate</title>
    <script defer src="https://cloud.umami.is/script.js" data-website-id="ed6ff4d3-b737-4392-ab00-8cc7c98c45ec"></script>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f0f0f;
        --card-bg: rgba(255, 255, 255, 0.07);
        --card-border: rgba(255, 255, 255, 0.12);
        --text: #f5f7ff;
        --muted: #a7afc6;
        --accent-start: #8b5cf6;
        --accent-end: #3b82f6;
        --surface: rgba(255, 255, 255, 0.05);
        --shadow: 0 28px 80px rgba(0, 0, 0, 0.42);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(139, 92, 246, 0.22), transparent 26%),
          radial-gradient(circle at top right, rgba(59, 130, 246, 0.18), transparent 28%),
          radial-gradient(circle at bottom center, rgba(99, 102, 241, 0.14), transparent 32%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }
      main {
        width: min(100%, 680px);
      }
      .shell {
        position: relative;
        overflow: hidden;
        padding: 34px 28px 26px;
        border-radius: 30px;
        border: 1px solid var(--card-border);
        background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04));
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }
      .shell::before {
        content: '';
        position: absolute;
        inset: -2px;
        background: linear-gradient(135deg, rgba(139, 92, 246, 0.18), rgba(59, 130, 246, 0.14), transparent 70%);
        pointer-events: none;
        z-index: 0;
      }
      .content {
        position: relative;
        z-index: 1;
      }
      .logo-wrap {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 82px;
        height: 82px;
        border-radius: 24px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 12px 38px rgba(99, 102, 241, 0.18);
      }
      .logo-wrap img {
        width: 62px;
        height: 62px;
        object-fit: contain;
        padding: 6px;
        box-sizing: border-box;
        border-radius: 18px;
      }
      h1 {
        margin: 18px 0 10px;
        font-size: clamp(34px, 8vw, 52px);
        line-height: 1.04;
      }
      .subtitle {
        margin: 0;
        color: var(--muted);
        font-size: 17px;
        max-width: 560px;
      }
      .blurb {
        margin-top: 22px;
        padding: 18px;
        border-radius: 20px;
        background: rgba(12, 14, 22, 0.45);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .blurb p {
        margin: 0;
        color: #dbe4ff;
      }
      .supporters-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        margin-top: 18px;
        padding: 18px;
        border-radius: 20px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(12, 14, 22, 0.45);
      }
      .supporters-title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        color: var(--muted);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-align: center;
        text-transform: uppercase;
      }
      .supporters-star {
        color: #fbbf24;
        letter-spacing: 0;
      }
      .supporter-list {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
      }
      .supporter-pill {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 5px 12px;
        border-radius: 8px;
        border: 1px solid rgba(52, 211, 153, 0.35);
        background: rgba(52, 211, 153, 0.12);
        color: #36f4b4;
        font-size: 12px;
        font-weight: 700;
      }
      .button, .copy-button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 54px;
        border-radius: 999px;
        padding: 14px 18px;
        font: inherit;
        text-decoration: none;
        cursor: pointer;
        transition: transform 140ms ease, box-shadow 160ms ease, opacity 140ms ease;
      }
      .button:hover, .copy-button:hover {
        transform: translateY(-1px);
      }
      .button:active, .copy-button:active {
        transform: translateY(0);
      }
      .button-primary {
        border: 0;
        background: linear-gradient(135deg, var(--accent-start), var(--accent-end));
        color: #f8fbff;
        box-shadow: 0 12px 30px rgba(99, 102, 241, 0.28);
      }
      .button-secondary, .copy-button {
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.06);
        color: var(--text);
      }
      .support-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
        margin-top: 22px;
      }
      .support-card {
        padding: 18px;
        border-radius: 22px;
        background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .support-label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .support-value {
        margin-top: 8px;
        font-size: 18px;
        color: #eef2ff;
        word-break: break-word;
      }
      .copy-button {
        margin-top: 14px;
        width: 100%;
        text-decoration: none;
      }
      .copy-actions {
        display: grid;
        gap: 10px;
      }
      .footer-note {
        margin-top: 18px;
        color: var(--muted);
        font-size: 13px;
      }
      .footer-note a {
        color: #cfd8ff;
      }
      .flash {
        min-height: 20px;
        margin-top: 12px;
        color: #dce7ff;
        font-size: 13px;
      }
      @media (max-width: 560px) {
        body {
          padding: 16px;
        }
        .shell {
          padding: 28px 20px 22px;
          border-radius: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="shell">
        <div class="content">
          <div class="logo-wrap">
            <img src="${escapeHtml(baseUrl)}/assets/WhatsApp%20Image%202026-04-25%20at%2012.16.53%20AM.jpeg" alt="NebulaStreams">
          </div>
          <h1>Support NebulaStreams</h1>
          <p class="subtitle">Help keep the self-hosted streaming backend online, maintained, and improving over time.</p>

          <div class="blurb">
            <p>If NebulaStreams is useful to you, your support helps cover hosting, testing, and new provider work. Every contribution keeps the project more reliable.</p>
          </div>
          <div class="supporters-card" aria-label="Special thanks to supporters">
            <p class="supporters-title"><span class="supporters-star" aria-hidden="true">★</span> Special thanks to our supporters</p>
            <div class="supporter-list">
              ${renderSupporterPills()}
            </div>
          </div>
          ${primarySection ? `<div class="support-grid">${primarySection}</div>` : ''}

          <div class="flash" id="flash" aria-live="polite"></div>
          <p class="footer-note">Main site: <a href="${escapeHtml(baseUrl)}" target="_blank" rel="noopener">${escapeHtml(baseUrl)}</a></p>
        </div>
      </section>
    </main>
    <script>
      const flash = document.getElementById('flash');
      const copyText = async (value, successMessage) => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
          } else {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
          }

          flash.textContent = successMessage;
          clearTimeout(flash._timer);
          flash._timer = setTimeout(() => { flash.textContent = ''; }, 2200);
        } catch {
          flash.textContent = 'Copy failed. Please copy manually.';
        }
      };

      const copyCryptoButton = document.getElementById('copy-crypto');
      const cryptoValue = document.getElementById('crypto-value');
      const qrImage = document.getElementById('crypto-qr');

      if (copyCryptoButton && cryptoValue) {
        copyCryptoButton.addEventListener('click', () => {
          void copyText(cryptoValue.textContent.trim(), 'Wallet address copied.');
        });
      }

      if (qrImage && cryptoValue) {
        const qrPayload = encodeURIComponent('https://link.trustwallet.com/send?asset=c195_tTR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t&address=' + cryptoValue.textContent.trim());
        qrImage.src = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=8&data=' + qrPayload;
      }
    </script>
  </body>
</html>`;
};

const renderDashboardPage = ({ baseUrl, account = null, wall = [], activeSection = 'overview', errorMessage = '', successMessage = '' }) => {
  const themes = ['nebula', 'nebula-purple', 'amoled-black', 'cyber-green', 'aurora', 'synthwave'];
  const sectionIds = ['overview', 'profiles', 'backups', 'install', 'themes', 'analytics', 'badges', 'support'];
  const section = sectionIds.includes(activeSection) ? activeSection : 'overview';
  const dashboardTheme = themes.includes(account?.theme) ? account.theme : 'nebula';
  const profiles = account ? Object.values(account.profiles || {}) : [];
  const backups = account ? account.backups || [] : [];
  const stats = account?.stats || {};
  const badges = Array.isArray(account?.badges) ? account.badges : [];
  const shortUrl = account?.username ? `${baseUrl}/u/${account.username}` : '';
  const defaultInstallUrl = account?.username ? `${baseUrl}/u/${account.username}/manifest.json` : '';
  const planName = account?.lifetime ? 'Nebula Founder' : 'Nebula Supporter';
  const planStatus = account?.status || 'active';
  const fmtDate = (value) => value ? new Date(value).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not recorded';
  const fmtTime = (value) => value ? new Date(value).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never';
  const jsonSize = (value) => `${Math.max(1, Math.ceil(JSON.stringify(value || {}).length / 1024))} KB`;
  const nav = [
    ['overview', 'Overview'], ['profiles', 'Profiles'], ['backups', 'Backups'], ['install', 'Install URLs'],
    ['themes', 'Themes'], ['analytics', 'Analytics'], ['badges', 'Badges'], ['support', 'Support']
  ];
  const metric = (label, value) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value || 0))}</strong></div>`;
  const activity = [
    stats.lastSyncAt ? ['Profile synced', stats.lastSyncAt] : null,
    backups[0] ? [`Backup created: ${backups[0].name}`, backups[0].createdAt] : null,
    account?.updatedAt ? ['Settings updated', account.updatedAt] : null,
    account?.createdAt ? ['Supporter joined', account.createdAt] : null
  ].filter(Boolean);
  const providerStats = Object.entries(stats.mostUsedProviders || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 6);
  const maxProvider = Math.max(1, ...providerStats.map((entry) => Number(entry[1]) || 0));
  const dailyStats = stats.daily && typeof stats.daily === 'object' ? stats.daily : {};
  const today = new Date();
  const requestDays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (6 - index));
    const key = date.toISOString().slice(0, 10);
    const day = dailyStats[key] || {};
    return { key, label: key.slice(5), value: Number(day.manifests || 0) + Number(day.searches || 0) };
  });
  const maxDailyRequests = Math.max(0, ...requestDays.map((day) => day.value));
  const sectionTitle = nav.find((item) => item[0] === section)?.[1] || 'Overview';
  const renderHeader = (eyebrow, title, desc = '') => `<header class="section-head"><span>${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1>${desc ? `<p>${escapeHtml(desc)}</p>` : ''}</header>`;
  const renderOverview = () => `
    ${renderHeader('Overview', `Welcome back, ${account?.username || account?.label || 'Supporter'}`, 'Your synced install profiles, supporter status, and recent activity.')}
    <section class="profile-hero">
      <div><span class="eyebrow">Current plan</span><h2>${escapeHtml(planName)}</h2><p>${escapeHtml(account?.emailMasked || 'Email private')}</p></div>
      <dl><div><dt>Status</dt><dd class="${planStatus === 'active' ? 'ok' : 'bad'}">${escapeHtml(planStatus)}</dd></div><div><dt>Joined</dt><dd>${escapeHtml(fmtDate(account?.createdAt))}</dd></div><div><dt>Last sync</dt><dd>${escapeHtml(fmtTime(stats.lastSyncAt))}</dd></div></dl>
    </section>
    <section class="metrics-row">
      ${metric('Profiles', profiles.length)}
      ${metric('Manifest Requests', stats.manifests || 0)}
      ${metric('Install URLs', account?.username ? Math.max(1, profiles.length) : 0)}
      ${metric('Saved Backups', backups.length)}
    </section>
    <section class="panel"><div class="panel-title"><h2>Recent activity</h2><p>Latest supporter account events.</p></div><div class="timeline">${activity.length ? activity.map(([label, when]) => `<div class="event"><i></i><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(fmtTime(when))}</span></div></div>`).join('') : '<p class="empty">No activity yet.</p>'}</div></section>`;
  const renderProfiles = () => `
    ${renderHeader('Nebula Profile Sync', 'Profiles', 'Save, restore, rename, and manage cloud profiles.')}
    <section class="toolbar-panel"><form method="post" action="/dashboard/profiles/create" class="inline-form"><input name="name" value="Home" placeholder="Home, Mobile, Family"><textarea name="configJson" placeholder='{"providers":[]}'></textarea><button type="submit">Create Profile</button></form></section>
    <section class="profile-list">${profiles.length ? profiles.map((profile) => `<article class="profile-item"><div><strong>${escapeHtml(profile.name)}</strong><span>Updated ${escapeHtml(fmtTime(profile.updatedAt || profile.createdAt))}${account.defaultProfileId === profile.id ? ' · default' : ''}</span></div><div class="actions"><form method="post" action="/dashboard/profiles/default"><input type="hidden" name="profileId" value="${escapeHtml(profile.id)}"><button class="ghost" type="submit">Restore</button></form><form method="post" action="/dashboard/profiles/rename"><input type="hidden" name="profileId" value="${escapeHtml(profile.id)}"><input name="name" value="${escapeHtml(profile.name)}"><button class="ghost" type="submit">Edit</button></form>${account.username ? `<a class="ghost link" href="/u/${escapeHtml(account.username)}/${escapeHtml(profile.id)}/manifest.json">Open</a>` : ''}<form method="post" action="/dashboard/profiles/delete"><input type="hidden" name="profileId" value="${escapeHtml(profile.id)}"><button class="ghost danger" type="submit">Delete</button></form></div></article>`).join('') : '<p class="empty">No profiles saved yet. Save one from config Support tab or import JSON here.</p>'}</section>`;
  const renderBackups = () => `
    ${renderHeader('Backup Manager', 'Backups', 'Versioned config snapshots with restore and export actions.')}
    <section class="toolbar-panel"><form method="post" action="/dashboard/backups/create" class="inline-form"><input name="name" value="Manual backup"><textarea name="configJson" placeholder='{"providers":[]}'></textarea><button type="submit">Create Backup</button><a class="ghost link" href="/dashboard/export.json">Export All</a></form></section>
    <section class="table-wrap"><table><thead><tr><th>Backup Name</th><th>Date</th><th>Size</th><th></th></tr></thead><tbody>${backups.length ? backups.map((backup) => `<tr><td>${escapeHtml(backup.name)}</td><td>${escapeHtml(fmtTime(backup.createdAt))}</td><td>${escapeHtml(jsonSize(backup.configJson))}</td><td class="table-actions"><form method="post" action="/dashboard/backups/restore"><input type="hidden" name="backupId" value="${escapeHtml(backup.id)}"><button class="ghost" type="submit">Restore</button></form><a class="ghost link" href="/dashboard/backups/${escapeHtml(backup.id)}.json">Download</a><form method="post" action="/dashboard/backups/delete"><input type="hidden" name="backupId" value="${escapeHtml(backup.id)}"><button class="ghost danger" type="submit">Delete</button></form></td></tr>`).join('') : '<tr><td colspan="4" class="empty">No backups yet.</td></tr>'}</tbody></table></section>`;
  const renderInstall = () => `
    ${renderHeader('Install URLs', 'Short install links', 'Clean supporter links for Stremio and AIOStreams.')}
    <section class="install-panel"><span>Primary Install URL</span><code>${escapeHtml(shortUrl || 'Set username first')}</code><div class="actions"><button class="ghost" type="button" data-copy="${escapeHtml(shortUrl)}">Copy</button>${shortUrl ? `<a class="ghost link" href="${escapeHtml(shortUrl)}">Open</a>` : ''}<form method="post" action="/dashboard/settings"><input type="hidden" name="username" value="${escapeHtml(account?.username || '')}"><input type="hidden" name="label" value="${escapeHtml(account?.label || '')}"><input type="hidden" name="theme" value="${escapeHtml(dashboardTheme)}"><input type="hidden" name="anonymousWall" value="${account?.anonymousWall ? 'true' : 'false'}"><button class="ghost" type="submit">Regenerate</button></form></div></section>
    <section class="panel"><div class="panel-title"><h2>Secondary URLs</h2><p>Profile-specific manifest links.</p></div><div class="url-list">${defaultInstallUrl ? `<div><span>Default manifest</span><code>${escapeHtml(defaultInstallUrl)}</code></div>` : ''}${profiles.map((profile) => account.username ? `<div><span>${escapeHtml(profile.name)}</span><code>${escapeHtml(`${baseUrl}/u/${account.username}/${profile.id}/manifest.json`)}</code></div>` : '').join('') || '<p class="empty">Set username and save profiles to generate links.</p>'}</div></section>`;
  const renderThemes = () => `
    ${renderHeader('Theme Gallery', 'Themes', 'Apply supporter dashboard themes with live preview.')}
    <section class="theme-grid">${themes.filter((theme) => theme !== 'nebula').map((theme) => `<form method="post" action="/dashboard/settings" class="theme-tile" data-preview="${escapeHtml(theme)}"><input type="hidden" name="username" value="${escapeHtml(account?.username || '')}"><input type="hidden" name="label" value="${escapeHtml(account?.label || '')}"><input type="hidden" name="anonymousWall" value="${account?.anonymousWall ? 'true' : 'false'}"><input type="hidden" name="theme" value="${escapeHtml(theme)}"><div class="preview"><span></span><i></i></div><strong>${escapeHtml(theme.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '))}</strong><button class="ghost" type="submit">${dashboardTheme === theme ? 'Applied' : 'Apply'}</button></form>`).join('')}</section>`;
  const renderAnalytics = () => `
    ${renderHeader('Personal Usage Analytics', 'Analytics', 'Private supporter usage stats from your short links.')}
    <section class="metrics-row">${metric('Manifest Requests', stats.manifests || 0)}${metric('Searches', stats.searches || 0)}${metric('Movies Opened', stats.movies || 0)}${metric('Series Opened', stats.series || 0)}</section>
    <section class="panel"><div class="panel-title"><h2>Requests over time</h2><p>Real daily manifest/search activity from this supporter account.</p></div>${maxDailyRequests ? `<div class="chart">${requestDays.map((day) => `<span title="${escapeHtml(day.key)}: ${escapeHtml(String(day.value))}" style="height:${Math.max(6, Math.round((day.value / maxDailyRequests) * 100))}%"><em>${escapeHtml(day.label)}</em></span>`).join('')}</div>` : '<p class="empty">No request history yet. Chart appears after short URLs are used.</p>'}</section>
    <section class="panel"><div class="panel-title"><h2>Most used providers</h2><p>Based on synced profile/provider stats.</p></div><div class="provider-bars">${providerStats.length ? providerStats.map(([name, count]) => `<div><span>${escapeHtml(name)}</span><strong>${escapeHtml(String(count))}</strong><i style="width:${Math.max(8, Math.round((Number(count) / maxProvider) * 100))}%"></i></div>`).join('') : '<p class="empty">Provider stats will appear after usage accrues.</p>'}</div></section>
    <section class="insight">Most active day: <strong>${escapeHtml(fmtDate(account?.lastActiveAt || stats.lastSyncAt))}</strong></section>`;
  const renderBadges = () => {
    const allBadges = ['Nebula Founder', 'Nebula Supporter', 'Beta Tester', 'Early Adopter', '100 Requests', '1000 Requests', '1 Year Member'];
    return `${renderHeader('Achievement System', 'Badges', 'Collected and future supporter milestones.')}<section class="badge-grid">${allBadges.map((badge) => `<div class="badge-tile ${badges.includes(badge) ? 'owned' : ''}"><span>${badges.includes(badge) ? 'Unlocked' : 'Future'}</span><strong>${escapeHtml(badge)}</strong></div>`).join('')}</section>`;
  };
  const renderSupport = () => `
    ${renderHeader('Support', 'Current plan', 'Supporters keep NebulaStreams free for everyone.')}
    <section class="support-plan"><div><span>Plan</span><strong>${escapeHtml(planName)}</strong></div><div><span>Status</span><strong class="${planStatus === 'active' ? 'ok' : 'bad'}">${escapeHtml(planStatus)}</strong></div><div><span>Renewal</span><strong>${account?.lifetime ? 'Lifetime' : escapeHtml(fmtDate(account?.expiresAt))}</strong></div></section>
    <section class="panel"><div class="panel-title"><h2>Supporter perks</h2><p>No providers, quality, or stream count are gated.</p></div><ul class="perk-list"><li>Profile Sync</li><li>Backups</li><li>Short URLs</li><li>Themes</li><li>Early Access</li></ul></section>
    <section class="panel"><div class="panel-title"><h2>Manage subscription</h2><p>${account?.lifetime ? 'Lifetime member. No renewal needed.' : 'Monthly supporter. Manage payment through Ko-fi.'}</p></div><a class="ghost link" href="${escapeHtml(config.DONATION_PRIMARY_URL || 'https://ko-fi.com/retro76005')}">Open Ko-fi</a></section>
    <section class="panel"><div class="panel-title"><h2>Supporters wall</h2><p>Optional public thanks.</p></div><div class="wall-list">${wall.length ? wall.map((entry) => `<span>${escapeHtml(entry.label)} · ${escapeHtml(entry.lifetime ? 'Founder' : entry.tier)}</span>`).join('') : '<p class="empty">Wall empty.</p>'}</div></section>`;
  const renderSection = () => ({ overview: renderOverview, profiles: renderProfiles, backups: renderBackups, install: renderInstall, themes: renderThemes, analytics: renderAnalytics, badges: renderBadges, support: renderSupport }[section] || renderOverview)();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams - Supporter Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
      :root{color-scheme:dark;--bg:#07080d;--surface:#0d1018;--surface2:#111522;--line:rgba(255,255,255,.09);--line2:rgba(255,255,255,.14);--text:#f4f7fb;--muted:#8e98ab;--soft:#c8d0df;--accent:#22d3ee;--accent2:#6d5dfc;--ok:#35d08f;--bad:#ff6b7a;--shadow:0 24px 80px rgba(0,0,0,.38)}
      body[data-theme="nebula-purple"]{--accent:#c084fc;--accent2:#7c3aed;--bg:#080513}body[data-theme="amoled-black"]{--accent:#38bdf8;--accent2:#334155;--bg:#000;--surface:#050505;--surface2:#0a0a0a}body[data-theme="cyber-green"]{--accent:#22c55e;--accent2:#06b6d4;--bg:#020b08}body[data-theme="aurora"]{--accent:#2dd4bf;--accent2:#a78bfa;--bg:#06111d}body[data-theme="synthwave"]{--accent:#f472b6;--accent2:#8b5cf6;--bg:#12051d}
      *{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:Inter,system-ui,sans-serif}a{color:inherit;text-decoration:none}button,input,select,textarea{font:inherit}button{cursor:pointer}.shell{display:grid;grid-template-columns:264px 1fr;min-height:100vh}.side{position:sticky;top:0;height:100vh;border-right:1px solid var(--line);background:rgba(9,11,17,.78);backdrop-filter:blur(22px);padding:22px;display:flex;flex-direction:column}.brand{font-weight:800;font-size:18px;margin-bottom:26px}.nav{display:grid;gap:4px}.nav a{padding:10px 12px;border-radius:10px;color:var(--muted);font-weight:650}.nav a.active,.nav a:hover{background:rgba(255,255,255,.06);color:var(--text)}.plan{margin-top:auto;border:1px solid var(--line);border-radius:14px;padding:14px;background:rgba(255,255,255,.035)}.plan span,.section-head span,.eyebrow,.metric span,.install-panel span,.support-plan span{display:block;color:var(--muted);font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.plan strong{display:block;margin-top:6px}.content{padding:38px 48px 56px;max-width:1180px;width:100%}.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.topbar h2{margin:0;font-size:14px;color:var(--muted);font-weight:700}.topbar .actions{display:flex;gap:10px}.section-head{margin-bottom:28px}.section-head h1{font-size:38px;line-height:1.05;margin:8px 0 10px;letter-spacing:-.03em}.section-head p{margin:0;color:var(--muted);font-size:16px}.flash{border:1px solid var(--line2);border-radius:12px;padding:12px 14px;margin-bottom:18px;background:rgba(255,255,255,.045)}.flash.error{color:#fecaca;border-color:rgba(255,107,122,.35)}.profile-hero{border-bottom:1px solid var(--line);padding:8px 0 28px;margin-bottom:26px;display:flex;justify-content:space-between;gap:28px}.profile-hero h2{font-size:30px;margin:6px 0}.profile-hero p{color:var(--muted);margin:0}.profile-hero dl{display:grid;grid-template-columns:repeat(3,minmax(110px,1fr));gap:22px;margin:0}.profile-hero dt{color:var(--muted);font-size:12px}.profile-hero dd{margin:6px 0 0;font-weight:750}.metrics-row{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--line);margin-bottom:28px}.metric{background:var(--surface);padding:20px}.metric strong{display:block;font-size:30px;margin-top:8px}.panel,.toolbar-panel,.install-panel,.support-plan,.insight{border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.025));padding:22px;margin-bottom:18px}.panel-title{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:18px}.panel-title h2{margin:0;font-size:18px}.panel-title p{margin:4px 0 0;color:var(--muted)}.timeline{display:grid;gap:0}.event{display:grid;grid-template-columns:18px 1fr;gap:12px;padding:13px 0;border-top:1px solid var(--line)}.event:first-child{border-top:0}.event i{width:9px;height:9px;margin-top:6px;border-radius:50%;background:var(--accent)}.event span,.profile-item span{display:block;color:var(--muted);margin-top:4px}.inline-form{display:grid;grid-template-columns:minmax(160px,220px) 1fr auto auto;gap:10px;align-items:start}input,textarea,select{width:100%;border:1px solid var(--line);background:#090b12;color:var(--text);border-radius:10px;padding:10px 12px}textarea{min-height:42px;font-family:JetBrains Mono,monospace;font-size:12px}.ghost,button{border:1px solid var(--line2);background:rgba(255,255,255,.045);color:var(--text);border-radius:10px;padding:9px 12px;font-weight:750}.ghost:hover,button:hover{border-color:rgba(34,211,238,.35)}.danger{color:#fecaca}.link{display:inline-flex;align-items:center}.profile-list{display:grid;gap:12px}.profile-item{border:1px solid var(--line);border-radius:16px;background:var(--surface);padding:20px;display:flex;justify-content:space-between;gap:20px;align-items:center}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.actions form{display:flex;gap:8px}.actions input{width:150px}.table-wrap{border:1px solid var(--line);border-radius:16px;overflow:auto;background:var(--surface)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:15px 16px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}tr:last-child td{border-bottom:0}.table-actions{display:flex;gap:8px;justify-content:flex-end}.install-panel code,.url-list code{display:block;font-family:JetBrains Mono,monospace;font-size:15px;margin:10px 0 14px;color:var(--soft);word-break:break-all}.url-list{display:grid;gap:14px}.url-list div{border-top:1px solid var(--line);padding-top:14px}.theme-grid,.badge-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}.theme-tile,.badge-tile{border:1px solid var(--line);border-radius:16px;background:var(--surface);padding:16px}.preview{height:86px;border-radius:12px;background:linear-gradient(135deg,var(--accent2),var(--accent));margin-bottom:14px;position:relative;overflow:hidden}.preview span{position:absolute;inset:14px 48px auto 14px;height:10px;background:rgba(255,255,255,.7);border-radius:8px}.preview i{position:absolute;left:14px;right:14px;bottom:14px;height:28px;background:rgba(0,0,0,.24);border-radius:8px}.theme-tile strong,.badge-tile strong{display:block;margin-bottom:12px}.chart{height:190px;display:flex;align-items:end;gap:12px;padding-bottom:22px}.chart span{flex:1;min-height:6px;border-radius:8px 8px 0 0;background:linear-gradient(180deg,var(--accent),rgba(34,211,238,.2));position:relative}.chart em{position:absolute;left:50%;bottom:-22px;transform:translateX(-50%);font-style:normal;color:var(--muted);font-size:11px}.provider-bars{display:grid;gap:14px}.provider-bars div{position:relative;padding-bottom:10px;border-bottom:1px solid var(--line)}.provider-bars strong{float:right}.provider-bars i{position:absolute;left:0;bottom:-1px;height:2px;background:var(--accent);border-radius:2px}.support-plan{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.support-plan strong{display:block;font-size:24px;margin-top:8px}.perk-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:0;padding:0;list-style:none}.perk-list li{border:1px solid var(--line);border-radius:12px;padding:12px;background:rgba(255,255,255,.03)}.badge-tile{min-height:130px;display:flex;flex-direction:column;justify-content:space-between}.badge-tile.owned{border-color:rgba(34,211,238,.32);box-shadow:inset 0 0 0 1px rgba(34,211,238,.12)}.badge-tile span{color:var(--muted);font-size:12px}.wall-list{display:flex;gap:8px;flex-wrap:wrap}.wall-list span{border:1px solid var(--line);border-radius:999px;padding:8px 10px;color:var(--soft)}.empty{color:var(--muted);margin:0}.ok{color:var(--ok)}.bad{color:var(--bad)}.logout{margin-top:14px}.login-wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.login-box{width:min(430px,100%);border:1px solid var(--line);border-radius:20px;background:var(--surface);padding:28px;box-shadow:var(--shadow)}.login-box h1{margin:0 0 8px}.login-box p{color:var(--muted);margin:0 0 20px}.login-box form{display:grid;gap:12px}
      @media(max-width:900px){.shell{grid-template-columns:1fr}.side{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)}.nav{grid-template-columns:repeat(4,1fr)}.content{padding:28px 20px}.profile-hero{display:block}.profile-hero dl{margin-top:20px}.metrics-row,.support-plan{grid-template-columns:repeat(2,1fr)}.inline-form{grid-template-columns:1fr}.profile-item{display:block}.actions{margin-top:14px}.topbar{display:block}.topbar .actions{margin-top:12px}}@media(max-width:560px){.nav{grid-template-columns:repeat(2,1fr)}.section-head h1{font-size:30px}.metrics-row,.profile-hero dl,.support-plan{grid-template-columns:1fr}.table-actions{display:grid;justify-content:start}.actions form{width:100%;display:grid;grid-template-columns:1fr auto}.actions input{width:100%}}
    </style>
  </head>
  <body data-theme="${escapeHtml(dashboardTheme)}">
    ${!account ? `<main class="login-wrap"><section class="login-box"><h1>NebulaStreams Dashboard</h1><p>Login with supporter code from Ko-fi email.</p>${errorMessage ? `<div class="flash error">${escapeHtml(errorMessage)}</div>` : ''}${successMessage ? `<div class="flash">${escapeHtml(successMessage)}</div>` : ''}<form method="post" action="/supporter/login"><input name="supporterCode" type="password" autocomplete="off" placeholder="Supporter code" required><button type="submit">Open Dashboard</button></form></section></main>` : `<div class="shell"><aside class="side"><div class="brand">NebulaStreams</div><nav class="nav">${nav.map(([id, label]) => `<a class="${section === id ? 'active' : ''}" href="/dashboard?tab=${escapeHtml(id)}">${escapeHtml(label)}</a>`).join('')}</nav><div class="plan"><span>Current Plan</span><strong>${escapeHtml(planName)}</strong><form method="post" action="/supporter/logout" class="logout"><button class="ghost" type="submit">Logout</button></form></div></aside><main class="content"><div class="topbar"><h2>${escapeHtml(sectionTitle)}</h2><div class="actions"><a class="ghost link" href="${escapeHtml(baseUrl)}/configure">Configure</a><a class="ghost link" href="/dashboard/export.json">Export</a></div></div>${errorMessage ? `<div class="flash error">${escapeHtml(errorMessage)}</div>` : ''}${successMessage ? `<div class="flash">${escapeHtml(successMessage)}</div>` : ''}${renderSection()}</main></div>`}
    <script>document.querySelectorAll('[data-copy]').forEach((btn)=>btn.addEventListener('click',async()=>{const value=btn.getAttribute('data-copy')||'';if(!value)return;await navigator.clipboard.writeText(value);btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy',1400)}));document.querySelectorAll('[data-preview]').forEach((tile)=>tile.addEventListener('mouseenter',()=>document.body.dataset.theme=tile.dataset.preview));document.querySelectorAll('[data-preview]').forEach((tile)=>tile.addEventListener('mouseleave',()=>document.body.dataset.theme='${escapeHtml(dashboardTheme)}'));</script>
  </body>
</html>`;
};

const renderSportsPage = ({ baseUrl, account = null, errorMessage = '', successMessage = '', stats = {}, availableSports = [], trendingEvents = [] }) => {
  const sportsBase = String(baseUrl || '').replace(/\/+$/u, '') + '/sports';
  const installUrl = account?.installKey ? sportsBase + '/i/' + account.installKey + '/manifest.json' : '';
  const canConfigureSports = ['monthly', 'lifetime', 'premium-future', 'trial', 'community-week'].includes(String(account?.tier || '').toLowerCase());
  const kofiUrlRaw = config.DONATION_PRIMARY_URL || 'https://ko-fi.com/retro76005';
  const kofiPageNameJson = JSON.stringify(getKofiPageName(kofiUrlRaw));
  const kofiUrl = escapeHtml(kofiUrlRaw);
  const accountCount = escapeHtml(String(stats.accounts || 0));
  const activeCount = escapeHtml(String(stats.active || 0));
  const promoActive = isSportsLaunchPromoActive();
  const sportsPaymentMaintenance = true;
  const monthlyPriceLabel = promoActive ? '$1' : '$3';
  const lifetimePriceLabel = promoActive ? '$3' : '$7';
  const pricingHeadingLabel = sportsPaymentMaintenance
    ? 'Supporter payments are under maintenance'
    : (promoActive ? 'Launch pricing ends June 29' : 'Sports supporter pricing');
  const pricingIntroLabel = sportsPaymentMaintenance
    ? 'Supporter payments are temporarily paused while we maintain the payment system. Please use the 24-hour supporter trial in the meantime; existing supporter accounts still work normally.'
    : (promoActive
        ? 'Launch pricing is $1/month or $3 once until June 29, 2026. After that pricing becomes $3/month or $7 lifetime. Premium Future Support is $15 once. Your one-use setup code is emailed automatically after payment.'
        : 'Pricing is $3/month, $7 lifetime, or $15 Premium Future Support. Pay through Ko-fi and include &ldquo;Nebula Sports&rdquo; in the note. Your one-use setup code is emailed automatically after payment.');
  const monthlyButtonHtml = sportsPaymentMaintenance
    ? 'href="#trial">Use trial for now</a>'
    : 'href="' + kofiUrl + '" target="_blank" rel="noopener">Choose monthly</a>';
  const lifetimeButtonHtml = sportsPaymentMaintenance
    ? 'href="#trial">Use trial for now</a>'
    : 'href="' + kofiUrl + '" target="_blank" rel="noopener">Get lifetime access</a>';
  const premiumButtonHtml = sportsPaymentMaintenance
    ? 'href="#trial">Use trial for now</a>'
    : 'href="' + kofiUrl + '" target="_blank" rel="noopener">Get premium future support</a>';
  const monthlyDescriptionLabel = 'Full supporter access while your subscription runs: all playable sources, Live TV catalogs, private Stremio install, catalog filters, live-only mode, and timezone settings.';
  const lifetimeDescriptionLabel = 'Permanent Nebula Sports access with all playable sources, Live TV catalogs, private Stremio install, catalog filters, live-only mode, and timezone settings.';
  const premiumFutureCardHtml = '          <a class="btn btn-primary btn-block" href="#account">Get lifetime access</a>\n        </div>\n        <div class="plan">\n          <span class="badge">Future access</span>\n          <div class="pname">Premium Future Support</div>\n          <div class="price">$15<span> / once</span></div>\n          <p class="pdesc">Lifetime Nebula Sports plus premium access to future Nebula addons and projects.</p>\n          <a class="btn btn-ghost btn-block" href="#account">Get premium future support</a>\n        </div>\n      </div>';
  const freeInstallUrl = `${sportsBase}/i/free/manifest.json`;
  const freeStremioUrl = `stremio://${freeInstallUrl.replace(/^https?:\/\//u, '')}`;
  const freeTierCardHtml = '<div class="plan">\n          <span class="badge">Free preview</span>\n          <div class="pname">Free</div>\n          <div class="price">$0<span> / preview</span></div>\n          <p class="pdesc">Free tier installs show easiest available streams per event. Subscribe to unlock every playable source.</p>\n          <a class="btn btn-ghost btn-block" href="' + escapeHtml(freeStremioUrl) + '">Install free tier</a>\n          <button class="btn btn-ghost btn-block" type="button" data-copy="' + escapeHtml(freeInstallUrl) + '" style="margin-top:10px">Copy manifest URL</button>\n        </div>\n        ';
  const sportsMoreStreamsNoteHtml = '<div style="margin-top:18px;max-width:760px;padding:16px 18px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface-2)"><strong style="display:block;color:var(--ink);font-size:15px;margin-bottom:4px">More streams coming in a few days</strong><span style="color:var(--ink-soft);font-size:14px">All active Nebula Sports supporters will get the new stream sources automatically. No plan change needed.</span></div>';
  const sportsLiveTvNoteHtml = '<div style="max-width:760px;margin:-12px 0 24px;padding:16px 18px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface-2)"><strong style="display:block;color:var(--ink);font-size:15px;margin-bottom:4px">Live TV is available for supporters</strong><span style="color:var(--ink-soft);font-size:14px">Monthly and lifetime supporters get the Live TV catalog inside Stremio with their private Nebula Sports install.</span></div>';
  const sportsDnsNoteHtml = '<p style="margin-top:18px;color:var(--ink-soft);font-size:14px;max-width:62ch">Change your DNS to <strong style="color:var(--ink)">1.1.1.1</strong> if the catalogs are not loading or streams are buffering.</p>';
  const sportsClaimAlertHtml = '<div role="alert" style="max-width:760px;margin:-12px 0 24px;padding:16px 18px;border:2px solid var(--accent);border-radius:9px;background:var(--accent-soft);color:#bbf7d0"><strong style="display:block;font-size:16px;color:#d1fae5;margin-bottom:4px">Email setup codes are back</strong><span style="font-size:14px">After Ko-fi payment, check your inbox for your one-use Nebula Sports setup code. If it is not there, check spam or junk.</span></div>';
  const sportsPaymentMaintenanceHtml = '<div role="alert" style="max-width:760px;margin:-12px 0 24px;padding:17px 18px;border:2px solid #f59e0b;border-radius:9px;background:rgba(245,158,11,.12);color:#fde68a"><strong style="display:block;font-size:16px;color:#fef3c7;margin-bottom:4px">Supporter payment system is in maintenance</strong><span style="font-size:14px">New card and PayPal payments are temporarily paused while we fix the payment flow. Existing supporter accounts continue to work.</span></div>';
  const sportsCryptoPaymentHtml = '<div style="max-width:760px;margin:-12px 0 24px;padding:18px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface-2)"><strong style="display:block;color:var(--ink);font-size:16px;margin-bottom:6px">Crypto payments are available for now</strong><p style="color:var(--ink-soft);font-size:14px;margin-bottom:14px">Use crypto while card and PayPal payments are being fixed. After payment, send your payment email or transaction hash on Discord/email so your supporter account can be created manually.</p><button class="btn btn-primary" type="button" data-open-crypto>Pay with crypto</button><div id="sportsCryptoWidget" hidden style="width:100%;max-width:346px;margin-top:14px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff"></div><p style="color:var(--muted);font-size:12px;margin-top:10px">Crypto payments are checked manually, so access is not instant.</p></div>';
  const flashHtml = [
    errorMessage ? '<div class="wrap" style="padding-top:18px"><div class="card" style="border-color:rgba(251,113,133,.4);color:#fecdd3">' + escapeHtml(errorMessage) + '</div></div>' : '',
    successMessage ? '<div class="wrap" style="padding-top:18px"><div class="card" style="border-color:rgba(31,170,110,.42);color:#bbf7d0">' + escapeHtml(successMessage) + '</div></div>' : ''
  ].join('');
  let html = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n<title>Nebula Sports — Live sports for Stremio</title>\n<style>\n  :root {\n    --ink: #e7ebf0;\n    --ink-soft: #aeb7c2;\n    --muted: #7c8794;\n    --line: #232a33;\n    --line-strong: #333c47;\n    --surface: #0e1116;\n    --surface-2: #161b22;\n    --surface-3: #1d232c;\n    --accent: #1faa6e;\n    --accent-hover: #28b878;\n    --accent-soft: rgba(31,170,110,.15);\n    --radius: 12px;\n    --radius-sm: 9px;\n    --shadow: 0 1px 2px rgba(15,20,25,.04), 0 8px 24px rgba(15,20,25,.05);\n    --font: \"Inter\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\n    --mono: ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace;\n  }\n\n  * { box-sizing: border-box; }\n  html { scroll-behavior: smooth; }\n  body {\n    margin: 0;\n    font-family: var(--font);\n    color: var(--ink);\n    background: var(--surface);\n    line-height: 1.55;\n    -webkit-font-smoothing: antialiased;\n    text-rendering: optimizeLegibility;\n  }\n  h1, h2, h3 { letter-spacing: -0.02em; line-height: 1.15; margin: 0; }\n  p { margin: 0; }\n  a { color: inherit; text-decoration: none; }\n\n  .wrap { width: 100%; max-width: 1080px; margin: 0 auto; padding: 0 24px; }\n\n  /* ---------- Header ---------- */\n  header.site {\n    position: sticky; top: 0; z-index: 50;\n    background: rgba(14,17,22,.82);\n    backdrop-filter: saturate(180%) blur(12px);\n    border-bottom: 1px solid var(--line);\n  }\n  .nav { display: flex; align-items: center; justify-content: space-between; height: 64px; }\n  .brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 16px; }\n  .brand .mark {\n    width: 28px; height: 28px; border-radius: 8px;\n    background: var(--accent); color: #fff;\n    display: grid; place-items: center; font-weight: 700; font-size: 15px;\n  }\n  .brand .tag {\n    font-size: 11px; font-weight: 600; color: var(--muted);\n    border: 1px solid var(--line-strong); border-radius: 999px;\n    padding: 2px 9px; margin-left: 4px; letter-spacing: .01em;\n  }\n  .nav-links { display: flex; align-items: center; gap: 28px; }\n  .nav-links a { font-size: 14px; color: var(--ink-soft); font-weight: 500; }\n  .nav-links a:hover { color: var(--ink); }\n\n  .btn {\n    display: inline-flex; align-items: center; justify-content: center; gap: 8px;\n    font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer;\n    border-radius: var(--radius-sm); padding: 10px 18px; border: 1px solid transparent;\n    transition: background .15s ease, border-color .15s ease, color .15s ease, transform .05s ease;\n  }\n  .btn:active { transform: translateY(1px); }\n  .btn-primary { background: var(--accent); color: #fff; }\n  .btn-primary:hover { background: var(--accent-hover); }\n  .btn-ghost { background: transparent; color: var(--ink); border-color: var(--line-strong); }\n  .btn-ghost:hover { background: var(--surface-2); }\n  .btn-block { width: 100%; padding: 12px 18px; }\n\n  /* ---------- Hero ---------- */\n  .hero { padding: 92px 0 64px; border-bottom: 1px solid var(--line); }\n  .hero .eyebrow {\n    display: inline-flex; align-items: center; gap: 8px;\n    font-size: 13px; font-weight: 600; color: var(--accent);\n    background: var(--accent-soft); border-radius: 999px; padding: 5px 13px;\n    margin-bottom: 22px;\n  }\n  .hero .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }\n  .hero h1 { font-size: 52px; max-width: 14ch; }\n  .hero p.lead { font-size: 18px; color: var(--ink-soft); max-width: 60ch; margin-top: 20px; }\n  .hero .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 32px; }\n\n  /* ---------- Stats ---------- */\n  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 56px; }\n  .stat {\n    background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);\n    padding: 22px 24px;\n  }\n  .stat .num { font-size: 34px; font-weight: 700; letter-spacing: -0.03em; }\n  .stat .lbl { font-size: 13px; color: var(--muted); margin-top: 4px; font-weight: 500; }\n\n  /* ---------- Sections ---------- */\n  section.block { padding: 72px 0; border-bottom: 1px solid var(--line); }\n  .section-head { margin-bottom: 36px; }\n  .section-head .kicker { font-size: 13px; font-weight: 650; color: var(--accent); text-transform: uppercase; letter-spacing: .06em; }\n  .section-head h2 { font-size: 30px; margin-top: 10px; }\n  .section-head p { color: var(--ink-soft); font-size: 16px; margin-top: 10px; max-width: 60ch; }\n\n  /* sports chips */\n  .chips { display: flex; flex-wrap: wrap; gap: 10px; }\n  .chip {\n    font-size: 14px; font-weight: 550; color: var(--ink-soft);\n    background: var(--surface-2); border: 1px solid var(--line);\n    border-radius: 999px; padding: 9px 16px;\n  }\n  .chip:hover { border-color: var(--line-strong); color: var(--ink); }\n\n  /* events */\n  .events { display: grid; gap: 0; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }\n  .event { display: flex; align-items: center; gap: 18px; padding: 18px 22px; border-bottom: 1px solid var(--line); background: var(--surface); }\n  .event:last-child { border-bottom: 0; }\n  .event:hover { background: var(--surface-2); }\n  .event .name { font-weight: 600; font-size: 15px; flex: 1; }\n  .event .meta { font-size: 13px; color: var(--muted); white-space: nowrap; }\n  .event .cat {\n    font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase;\n    color: var(--ink-soft); background: var(--surface-3);\n    border-radius: 6px; padding: 4px 9px; white-space: nowrap;\n  }\n\n  /* pricing */\n  .pricing { display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px; max-width: 760px; }\n  .plan { border: 1px solid var(--line); border-radius: var(--radius); padding: 30px; background: var(--surface); position: relative; }\n  .plan.featured { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), 0 8px 30px rgba(0,0,0,.35); }\n  .plan .badge {\n    position: absolute; top: 22px; right: 22px;\n    font-size: 11px; font-weight: 650; color: var(--accent);\n    background: var(--accent-soft); border-radius: 999px; padding: 4px 11px;\n  }\n  .plan .pname { font-size: 15px; font-weight: 650; color: var(--ink-soft); }\n  .plan .price { font-size: 42px; font-weight: 700; letter-spacing: -0.03em; margin-top: 10px; }\n  .plan .price span { font-size: 16px; font-weight: 500; color: var(--muted); }\n  .plan .pdesc { font-size: 14px; color: var(--ink-soft); margin-top: 14px; min-height: 42px; }\n  .plan .btn { margin-top: 22px; }\n\n  /* steps */\n  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }\n  .step { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius); padding: 26px; }\n  .step .n { width: 30px; height: 30px; border-radius: 8px; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 14px; }\n  .step h3 { font-size: 16px; margin-top: 16px; }\n  .step p { font-size: 14px; color: var(--ink-soft); margin-top: 8px; }\n\n  /* ---------- Auth / forms ---------- */\n  .auth { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }\n  .card { border: 1px solid var(--line); border-radius: var(--radius); padding: 30px; background: var(--surface); }\n  .card h3 { font-size: 19px; }\n  .card .hint { font-size: 13.5px; color: var(--muted); margin-top: 8px; }\n  .field { margin-top: 16px; }\n  .field label { display: block; font-size: 13px; font-weight: 600; color: var(--ink-soft); margin-bottom: 6px; }\n  .field input {\n    width: 100%; font-family: inherit; font-size: 14.5px; color: var(--ink);\n    background: var(--surface); border: 1px solid var(--line-strong);\n    border-radius: var(--radius-sm); padding: 11px 13px; transition: border-color .15s ease, box-shadow .15s ease;\n  }\n  .field input::placeholder { color: #5f6a76; }\n  .field input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }\n  .field input.mono { font-family: var(--mono); letter-spacing: .02em; }\n\n  .trial {\n    border: 1px solid var(--line); border-radius: var(--radius); padding: 30px 32px;\n    background: var(--surface-2); display: flex; align-items: center; justify-content: space-between; gap: 28px; flex-wrap: wrap;\n  }\n  .trial .copy h3 { font-size: 20px; }\n  .trial .copy p { font-size: 14px; color: var(--ink-soft); margin-top: 8px; max-width: 46ch; }\n  .trial form { display: flex; gap: 10px; flex: 1; min-width: 280px; }\n  .trial form input { flex: 1; }\n\n  /* ---------- Footer ---------- */\n  footer.site { padding: 44px 0; }\n  .foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }\n  .foot .muted { font-size: 13px; color: var(--muted); }\n  .foot .links { display: flex; gap: 22px; }\n  .foot .links a { font-size: 13px; color: var(--ink-soft); }\n  .foot .links a:hover { color: var(--ink); }\n\n  @media (max-width: 820px) {\n    .nav-links { display: none; }\n    .hero { padding: 64px 0 48px; }\n    .hero h1 { font-size: 38px; }\n    .stats, .pricing, .steps, .auth { grid-template-columns: 1fr; }\n    .stats { margin-top: 40px; }\n  }\n</style>\n</head>\n<body>\n\n<header class=\"site\">\n  <div class=\"wrap nav\">\n    <div class=\"brand\">\n      <span class=\"mark\">N</span>\n      Nebula Sports\n      <span class=\"tag\">NebulaStreams addon</span>\n    </div>\n    <nav class=\"nav-links\">\n      <a href=\"#sports\">Sports</a>\n      <a href=\"#events\">Events</a>\n      <a href=\"#pricing\">Pricing</a>\n      <a href=\"#account\">Account</a>\n    </nav>\n    <a class=\"btn btn-primary\" href=\"#account\">Sign in</a>\n  </div>\n</header>\n\n<main>\n  <!-- HERO -->\n  <section class=\"hero\">\n    <div class=\"wrap\">\n      <span class=\"eyebrow\"><span class=\"dot\"></span> Private sports addon</span>\n      <h1>Live sports events for Stremio.</h1>\n      <p class=\"lead\">A private sports addon with clean catalogs, a small manifest, and username/password access. Built separately from the main NebulaStreams addon so sports catalogs stay fast on TV clients.</p>\n      <div class=\"actions\">\n        <a class=\"btn btn-primary\" href=\"#trial\">Start 24-hour free trial</a>\n        <a class=\"btn btn-ghost\" href=\"#pricing\">View pricing</a>\n      </div>\n\n      <div class=\"stats\">\n        <div class=\"stat\"><div class=\"num\">10</div><div class=\"lbl\">Sports accounts</div></div>\n        <div class=\"stat\"><div class=\"num\">6</div><div class=\"lbl\">Active now</div></div>\n        <div class=\"stat\"><div class=\"num\">18</div><div class=\"lbl\">Catalogs</div></div>\n      </div>\n    </div>\n  </section>\n\n  <!-- SPORTS -->\n  <section class=\"block\" id=\"sports\">\n    <div class=\"wrap\">\n      <div class=\"section-head\">\n        <div class=\"kicker\">Coverage</div>\n        <h2>Sports included</h2>\n        <p>Live, today, and popular catalogs, plus dedicated catalogs for every sport below.</p>\n      </div>\n      <div class=\"chips\">\n        <span class=\"chip\">FIFA World Cup</span>\n        <span class=\"chip\">Basketball</span>\n        <span class=\"chip\">Football</span>\n        <span class=\"chip\">American Football</span>\n        <span class=\"chip\">Hockey</span>\n        <span class=\"chip\">Baseball</span>\n        <span class=\"chip\">Motor Sports</span>\n        <span class=\"chip\">Fight (UFC, Boxing)</span>\n        <span class=\"chip\">Tennis</span>\n        <span class=\"chip\">Rugby</span>\n        <span class=\"chip\">Golf</span>\n        <span class=\"chip\">Billiards</span>\n        <span class=\"chip\">AFL</span>\n        <span class=\"chip\">Darts</span>\n      </div>\n    </div>\n  </section>\n\n  <!-- EVENTS -->\n  <section class=\"block\" id=\"events\">\n    <div class=\"wrap\">\n      <div class=\"section-head\">\n        <div class=\"kicker\">Live feed</div>\n        <h2>Trending events</h2>\n        <p>Preview updates pulled from current Streamed event data.</p>\n      </div>\n      <div class=\"events\">\n        <div class=\"event\"><span class=\"name\">FIFA World Cup 2026</span><span class=\"meta\">2026 tournament coverage</span><span class=\"cat\">Football</span></div>\n        <div class=\"event\"><span class=\"name\">Spring Nationals — North Georgia</span><span class=\"meta\">Jun 19, 2026 · 00:00 UTC</span><span class=\"cat\">Other</span></div>\n        <div class=\"event\"><span class=\"name\">betr Darwin Triple Crown — Race 17</span><span class=\"meta\">Jun 19, 2026 · 00:00 UTC</span><span class=\"cat\">Motor Sports</span></div>\n        <div class=\"event\"><span class=\"name\">Summer Nationals Late Models — Dubuque</span><span class=\"meta\">Jun 19, 2026 · 00:10 UTC</span><span class=\"cat\">Other</span></div>\n        <div class=\"event\"><span class=\"name\">NARC Super Dirt Cup — Skagit</span><span class=\"meta\">Jun 19, 2026 · 01:00 UTC</span><span class=\"cat\">Other</span></div>\n        <div class=\"event\"><span class=\"name\">MotoGP Czech Republic Grand Prix</span><span class=\"meta\">Jun 19, 2026 · 07:00 UTC</span><span class=\"cat\">Motor Sports</span></div>\n      </div>\n    </div>\n  </section>\n\n  <!-- PRICING -->\n  <section class=\"block\" id=\"pricing\">\n    <div class=\"wrap\">\n      <div class=\"section-head\">\n        <div class=\"kicker\">Pricing</div>\n        <h2>Simple, one-off pricing</h2>\n        <p>Pay through Ko-fi and include &ldquo;Nebula Sports&rdquo; in the note. Your access token is emailed automatically.</p>\n      </div>\n      <div class=\"pricing\">\n        <div class=\"plan\">\n          <div class=\"pname\">Monthly</div>\n          <div class=\"price\">$1<span> / month</span></div>\n          <p class=\"pdesc\">Access stays active while the subscription is running. Include &ldquo;Nebula Sports&rdquo; in your Ko-fi note.</p>\n          <a class=\"btn btn-ghost btn-block\" href=\"#account\">Choose monthly</a>\n        </div>\n        <div class=\"plan featured\">\n          <span class=\"badge\">Best value</span>\n          <div class=\"pname\">Lifetime</div>\n          <div class=\"price\">$3<span> / once</span></div>\n          <p class=\"pdesc\">One payment, permanent access. The webhook treats a $3 sports payment as lifetime access.</p>\n          <a class=\"btn btn-primary btn-block\" href=\"#account\">Get lifetime access</a>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- HOW IT WORKS -->\n  <section class=\"block\" id=\"how\">\n    <div class=\"wrap\">\n      <div class=\"section-head\">\n        <div class=\"kicker\">Getting started</div>\n        <h2>How it works</h2>\n      </div>\n      <div class=\"steps\">\n        <div class=\"step\">\n          <div class=\"n\">1</div>\n          <h3>Pay on Ko-fi</h3>\n          <p>After payment, the Ko-fi webhook emails you a one-use secret token.</p>\n        </div>\n        <div class=\"step\">\n          <div class=\"n\">2</div>\n          <h3>Create your account</h3>\n          <p>Set a username and password here, then paste the token to verify.</p>\n        </div>\n        <div class=\"step\">\n          <div class=\"n\">3</div>\n          <h3>Install your manifest</h3>\n          <p>Add your private manifest to Stremio and start streaming live sports.</p>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- TRIAL -->\n  <section class=\"block\" id=\"trial\">\n    <div class=\"wrap\">\n      <div class=\"trial\">\n        <div class=\"copy\">\n          <h3>Try free for 24 hours</h3>\n          <p>Enter your email. If eligible, a one-use trial token arrives by email. One trial per user.</p>\n        </div>\n        <form method=\"post\" action=\"/sports/trial\">\n          <input type=\"email\" name=\"email\" placeholder=\"you@email.com\" required />\n          <button class=\"btn btn-primary\" type=\"submit\">Get free trial</button>\n        </form>\n      </div>\n    </div>\n  </section>\n\n  <!-- ACCOUNT -->\n  <section class=\"block\" id=\"account\">\n    <div class=\"wrap\">\n      <div class=\"section-head\">\n        <div class=\"kicker\">Access</div>\n        <h2>Sign in or create your account</h2>\n      </div>\n      <div class=\"auth\">\n        <div class=\"card\">\n          <h3>Sign in</h3>\n          <p class=\"hint\">Use the username and password you created.</p>\n          <form method=\"post\" action=\"/sports/login\">\n            <div class=\"field\">\n              <label for=\"si-user\">Username</label>\n              <input id=\"si-user\" type=\"text\" name=\"username\" placeholder=\"username\" autocomplete=\"username\" required />\n            </div>\n            <div class=\"field\">\n              <label for=\"si-pass\">Password</label>\n              <input id=\"si-pass\" type=\"password\" name=\"password\" placeholder=\"••••••••\" autocomplete=\"current-password\" required />\n            </div>\n            <button class=\"btn btn-ghost btn-block\" style=\"margin-top:18px\" type=\"submit\">Sign in</button>\n          </form>\n        </div>\n\n        <div class=\"card\">\n          <h3>Create account</h3>\n          <p class=\"hint\">Use the one-use token from your Nebula Sports email.</p>\n          <form method=\"post\" action=\"/sports/register\">\n            <div class=\"field\">\n              <label for=\"ca-user\">Username</label>\n              <input id=\"ca-user\" type=\"text\" name=\"username\" placeholder=\"choose a username\" autocomplete=\"username\" required />\n            </div>\n            <div class=\"field\">\n              <label for=\"ca-pass\">Password</label>\n              <input id=\"ca-pass\" type=\"password\" name=\"password\" placeholder=\"choose a password\" autocomplete=\"new-password\" required />\n            </div>\n            <div class=\"field\">\n              <label for=\"ca-token\">Secret token</label>\n              <input id=\"ca-token\" class=\"mono\" type=\"text\" name=\"token\" placeholder=\"paste your one-use token\" required />\n            </div>\n            <button class=\"btn btn-primary btn-block\" style=\"margin-top:18px\" type=\"submit\">Create account</button>\n          </form>\n        </div>\n      </div>\n    </div>\n  </section>\n</main>\n\n<footer class=\"site\">\n  <div class=\"wrap foot\">\n    <span class=\"muted\">© 2026 Nebula Sports · A NebulaStreams addon</span>\n    <div class=\"links\">\n      <a href=\"#pricing\">Pricing</a>\n      <a href=\"#how\">How it works</a>\n      <a href=\"#account\">Sign in</a>\n    </div>\n  </div>\n</footer>\n\n</body>\n</html>\n";

  html = html
    .replace('.pricing { display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px; max-width: 760px; }', '.pricing { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; max-width: 1080px; }')
    .replace('<div class="stat"><div class="num">10</div><div class="lbl">Sports accounts</div></div>', '<div class="stat"><div class="num">' + accountCount + '</div><div class="lbl">Sports accounts</div></div>')
    .replace('<div class="stat"><div class="num">6</div><div class="lbl">Active now</div></div>', '<div class="stat"><div class="num">' + activeCount + '</div><div class="lbl">Active now</div></div>')
    .replace('action="/sports/trial"', 'action="/sports/trial/request"')
	    .replace('action="/sports/register"', 'action="/sports/signup"')
	    .replace('name="token" placeholder="paste your one-use token"', 'name="tokenCode" placeholder="paste your one-use token"')
	    .replace('Start 24-hour free trial', 'Start 24-hour supporter trial')
	    .replace('Simple, one-off pricing', pricingHeadingLabel)
    .replace('Pay through Ko-fi and include &ldquo;Nebula Sports&rdquo; in the note. Your access token is emailed automatically.', pricingIntroLabel)
    .replace('$1<span> / month</span>', monthlyPriceLabel + '<span> / month</span>')
    .replace('$3<span> / once</span>', lifetimePriceLabel + '<span> / once</span>')
    .replace('<div class="pricing">', (sportsPaymentMaintenance ? sportsPaymentMaintenanceHtml + '\n      ' + sportsCryptoPaymentHtml : sportsClaimAlertHtml) + '\n      ' + sportsLiveTvNoteHtml + '\n      <div class="pricing">\n        ' + freeTierCardHtml)
    .replace('Access stays active while the subscription is running. Include &ldquo;Nebula Sports&rdquo; in your Ko-fi note.', monthlyDescriptionLabel)
    .replace('One payment, permanent access. The webhook treats a $3 sports payment as lifetime access.', lifetimeDescriptionLabel)
    .replace('          <a class="btn btn-primary btn-block" href="#account">Get lifetime access</a>\n        </div>\n      </div>', premiumFutureCardHtml)
    .replace('<span class="chip">Darts</span>\n      </div>', '<span class="chip">Darts</span>\n      </div>\n      ' + sportsMoreStreamsNoteHtml + '\n      ' + sportsDnsNoteHtml)
    .replaceAll('href="#account">Choose monthly</a>', monthlyButtonHtml)
    .replaceAll('href="#account">Get lifetime access</a>', lifetimeButtonHtml)
    .replaceAll('href="#account">Get premium future support</a>', premiumButtonHtml)
    .replace('Pay on Ko-fi', sportsPaymentMaintenance ? 'Use the trial' : 'Pay on Ko-fi')
    .replace('After payment, the Ko-fi webhook emails you a one-use secret token.', sportsPaymentMaintenance ? 'While payments are paused, request a 24-hour supporter trial token by email.' : 'After payment, the Ko-fi webhook emails you a one-use secret token.')
	    .replace('Try free for 24 hours', 'Try supporter access for 24 hours')
	    .replace('Enter your email. If eligible, a one-use trial token arrives by email. One trial per user.', 'The 24-hour trial gives you supporter-tier access. If you like the addon after trying it, please consider supporting to keep streams and servers running.')
    .replace(
      '<a class="btn btn-ghost" href="#pricing">View pricing</a>',
      '<a class="btn btn-ghost" href="#pricing">View pricing</a><a class="btn btn-ghost" href="https://discord.gg/YMjzX8AER" target="_blank" rel="noopener noreferrer">Join Discord</a>'
    )
    .replace(
      '<a href="#account">Sign in</a>\n    </div>\n  </div>\n</footer>',
      '<a href="#account">Sign in</a>\n      <a href="https://discord.gg/YMjzX8AER" target="_blank" rel="noopener noreferrer">Discord</a>\n    </div>\n  </div>\n</footer>'
    )
    .replace('<main>', '<main>' + flashHtml);

  if (account) {
    const statusLabel = account.lifetime
      ? 'Lifetime access'
      : 'Active until ' + (account.expiresAt ? new Date(account.expiresAt).toLocaleDateString('en') : 'renewal');
    const accountName = account.username || 'sports user';
    const stremioInstallUrl = installUrl
      ? `stremio://${installUrl.replace(/^https?:\/\//u, '')}`
      : '';
    const configButtonHtml = canConfigureSports
      ? '<a class="btn btn-ghost" href="/sports/configure">Configure catalogs</a>'
      : '';
    const signedInActionsHtml = '<div class="actions">' +
      '<a class="btn btn-primary" href="' + escapeHtml(stremioInstallUrl || installUrl) + '">Install in Stremio</a>' +
      configButtonHtml +
      '<button class="btn btn-ghost" type="button" data-copy="' + escapeHtml(installUrl) + '">Copy manifest</button>' +
      '<form method="post" action="/sports/logout" style="display:inline"><button class="btn btn-ghost" type="submit">Sign out</button></form>' +
      '</div>';
    const signedInQuickAccessSection = '<section class="block" id="quick-access">' +
      '<div class="wrap">' +
        '<div class="card">' +
          '<h3>Your private install is ready</h3>' +
          '<p class="hint">' + escapeHtml(statusLabel) + '. Install in Stremio, copy your manifest, or tune catalogs.</p>' +
          '<div class="field">' +
            '<label for="sports-install-url-quick">Manifest URL</label>' +
            '<input id="sports-install-url-quick" class="mono" type="text" readonly value="' + escapeHtml(installUrl) + '" />' +
          '</div>' +
          signedInActionsHtml +
        '</div>' +
      '</div>' +
    '</section>';
    html = html
      .replace('<a class="btn btn-primary" href="#account">Sign in</a>', '<a class="btn btn-primary" href="' + escapeHtml(stremioInstallUrl || installUrl) + '">Install</a>')
      .replaceAll('<a href="#account">Account</a>', '<a href="#quick-access">Access</a>')
      .replaceAll('<a href="#pricing">Pricing</a>', '<a href="#quick-access">Access</a>')
      .replaceAll('<a href="#account">Sign in</a>', '<a href="#quick-access">Access</a>')
      .replace('<span class="eyebrow"><span class="dot"></span> Private sports addon</span>', '<span class="eyebrow"><span class="dot"></span> Signed in</span>')
      .replace('<h1>Live sports events for Stremio.</h1>', '<h1>Welcome back, ' + escapeHtml(accountName) + '.</h1>')
      .replace('<p class="lead">A private sports addon with clean catalogs, a small manifest, and username/password access. Built separately from the main NebulaStreams addon so sports catalogs stay fast on TV clients.</p>', '<p class="lead">' + escapeHtml(statusLabel) + '. Your private Nebula Sports manifest is ready for Stremio.</p>')
	      .replace(/<div class="actions">\n        <a class="btn btn-primary" href="#trial">Start 24-hour supporter trial<\/a>\n        <a class="btn btn-ghost" href="#pricing">View pricing<\/a><a class="btn btn-ghost" href="https:\/\/discord\.gg\/YMjzX8AER" target="_blank" rel="noopener noreferrer">Join Discord<\/a>\n      <\/div>/u, signedInActionsHtml)
      .replace('</section>\n\n  <!-- SPORTS -->', '</section>\n\n  <!-- QUICK ACCESS -->\n  ' + signedInQuickAccessSection + '\n\n  <!-- SPORTS -->')
      .replace(/<section class="block" id="pricing">[\s\S]*?<\/section>\n\n  <!-- HOW IT WORKS -->/u, '<!-- HOW IT WORKS -->')
      .replace(/<section class="block" id="trial">[\s\S]*?<\/section>\n\n  <!-- ACCOUNT -->\n  <section class="block" id="account">[\s\S]*?<\/section>\n<\/main>/u, '</main>');
  }

  const sportsCopyScript = '<script>document.querySelectorAll("[data-copy]").forEach((btn)=>btn.addEventListener("click",async()=>{const value=btn.getAttribute("data-copy")||"";if(!value)return;const label=btn.dataset.copyLabel||btn.textContent||"Copy URL";btn.dataset.copyLabel=label;await navigator.clipboard.writeText(value);btn.textContent="Copied";setTimeout(()=>btn.textContent=label,1400)}));document.querySelectorAll("[data-open-crypto]").forEach((btn)=>btn.addEventListener("click",()=>{const box=document.getElementById("sportsCryptoWidget");if(!box)return;box.hidden=false;if(!box.dataset.loaded){box.dataset.loaded="1";box.innerHTML=\'<iframe src="https://nowpayments.io/embeds/donation-widget?api_key=3acd79dd-66e2-48c4-9a7a-8938cb9a7a12" width="346" height="623" frameborder="0" scrolling="no" style="display:block;width:100%;max-width:346px;height:623px;overflow-y:hidden;border:0" title="Nebula Sports crypto payment widget">Cannot load widget</iframe>\'};btn.textContent="Crypto payment widget opened";}));</script>';
  if (sportsPaymentMaintenance) {
    html = html.replace('</body>', '<a id="sportsTrialFallback" href="#trial" style="position:fixed;right:18px;bottom:18px;z-index:80;border:1px solid var(--line-strong);border-radius:999px;background:var(--accent);color:#fff;padding:11px 16px;font-weight:750;box-shadow:0 12px 30px rgba(0,0,0,.35)">Get trial</a>' + sportsCopyScript + '\n</body>');
  } else {
    html = html.replace('</body>', '<a id="sportsKofiFallback" href="' + kofiUrl + '" target="_blank" rel="noopener noreferrer" style="position:fixed;right:18px;bottom:18px;z-index:80;border:1px solid var(--line-strong);border-radius:999px;background:var(--accent);color:#fff;padding:11px 16px;font-weight:750;box-shadow:0 12px 30px rgba(0,0,0,.35)">Support on Ko-fi</a>' + sportsCopyScript + '<script>(()=>{if(window.__nebulaSportsKofiWidgetLoaded)return;window.__nebulaSportsKofiWidgetLoaded=true;const draw=()=>{if(!window.kofiWidgetOverlay?.draw)return;window.kofiWidgetOverlay.draw(' + kofiPageNameJson + ',{type:"floating-chat","floating-chat.donateButton.text":"Support","floating-chat.donateButton.background-color":"#1faa6e","floating-chat.donateButton.text-color":"#ffffff"});document.getElementById("sportsKofiFallback")?.remove()};const existing=document.querySelector("script[data-nebula-sports-kofi-widget]");if(existing){existing.addEventListener("load",draw,{once:true});draw();return}const script=document.createElement("script");script.src="https://storage.ko-fi.com/cdn/scripts/overlay-widget.js";script.async=true;script.defer=true;script.dataset.nebulaSportsKofiWidget="true";script.addEventListener("load",draw,{once:true});document.body.appendChild(script)})();</script>\n</body>');
  }
  return html;
};

const renderSportsConfigurePage = ({ baseUrl, account, catalogs = [], errorMessage = '', successMessage = '' }) => {
  const sportsBase = String(baseUrl || '').replace(/\/+$/u, '') + '/sports';
  const manifestUrl = `${sportsBase}/i/${encodeURIComponent(account.installKey)}/manifest.json`;
  const stremioUrl = `stremio://${manifestUrl.replace(/^https?:\/\//u, '')}`;
  const current = account.sportsConfig || {};
  const selected = new Set(Array.isArray(current.sports) ? current.sports : []);
  const timezone = String(current.timezone || 'UTC');
  const timezoneOptions = [
    ['UTC', 'UTC'],
    ['Asia/Kolkata', 'India (IST)'],
    ['Europe/London', 'United Kingdom'],
    ['Europe/Amsterdam', 'Central Europe'],
    ['America/New_York', 'US Eastern'],
    ['America/Chicago', 'US Central'],
    ['America/Denver', 'US Mountain'],
    ['America/Los_Angeles', 'US Pacific'],
    ['Asia/Dubai', 'Gulf'],
    ['Asia/Singapore', 'Singapore'],
    ['Australia/Sydney', 'Sydney']
  ];
  const sportOptions = catalogs
    .filter((catalog) => !['streamed-events-live', 'streamed-events-today', 'streamed-events-popular'].includes(catalog.id))
    .map((catalog) => {
      const label = String(catalog.name || '').replace(/^Sports Events:\s*/u, '').trim();
      return `<label class="sport"><input type="checkbox" name="sports" value="${escapeHtml(catalog.id)}"${selected.has(catalog.id) ? ' checked' : ''}><span>${escapeHtml(label)}</span></label>`;
    }).join('');
  const flash = errorMessage
    ? `<div class="flash error">${escapeHtml(errorMessage)}</div>`
    : (successMessage ? `<div class="flash">${escapeHtml(successMessage)}</div>` : '');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nebula Sports Configure</title>
<style>
:root{color-scheme:dark;--bg:#0c0f13;--panel:#151a21;--panel2:#1b222b;--line:#303945;--text:#f2f5f8;--muted:#9aa6b3;--green:#27b877}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif}a{color:inherit;text-decoration:none}.top{height:64px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 24px;position:sticky;top:0;background:rgba(12,15,19,.94);z-index:2}.brand{font-weight:750}.top a{color:var(--muted)}main{width:min(920px,calc(100% - 32px));margin:42px auto 72px}.hero{margin-bottom:28px}.hero span{color:var(--green);font-size:12px;font-weight:700;text-transform:uppercase}.hero h1{font-size:36px;line-height:1.1;margin:8px 0 10px}.hero p,.hint{color:var(--muted)}.grid{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:18px;align-items:start}.card{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:22px;margin-bottom:16px}.card h2{font-size:18px;margin:0 0 4px}.field{padding-top:18px;margin-top:18px;border-top:1px solid var(--line)}.toggle{display:flex;justify-content:space-between;gap:20px;align-items:center}.toggle input{width:22px;height:22px;accent-color:var(--green)}select{width:100%;margin-top:10px;background:var(--panel2);border:1px solid var(--line);color:var(--text);padding:11px;border-radius:7px}.sports{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:14px}.sport{display:flex;align-items:center;gap:9px;border:1px solid var(--line);background:var(--panel2);border-radius:7px;padding:10px 12px}.sport input{accent-color:var(--green)}button,.button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;padding:11px 15px;font-weight:700;cursor:pointer}.primary{background:var(--green);color:#07130e}.secondary{background:var(--panel2);border:1px solid var(--line);color:var(--text)}.actions{display:flex;gap:10px;flex-wrap:wrap}.url{font:12px/1.45 ui-monospace,monospace;word-break:break-all;background:#090b0e;border:1px solid var(--line);padding:11px;border-radius:7px;margin:12px 0}.flash{border:1px solid rgba(39,184,119,.5);padding:11px 13px;border-radius:7px;margin-bottom:16px;color:#baf4d7}.flash.error{border-color:#7f3943;color:#fecdd3}.perks{padding-left:18px;color:var(--muted)}.perks li{margin:7px 0}@media(max-width:760px){.grid{grid-template-columns:1fr}.sports{grid-template-columns:1fr}.hero h1{font-size:30px}}
</style></head><body>
<header class="top"><div class="brand">Nebula Sports</div><a href="/sports">Back to account</a></header>
<main>${flash}<div class="hero"><span>Supporter controls</span><h1>Configure your sports catalogs</h1><p>Settings save to your account. Reinstall or refresh addon after changes.</p></div>
<div class="grid"><form method="post" action="/sports/configure">
<section class="card"><h2>Catalog preferences</h2><p class="hint">Control what appears in Stremio.</p>
<div class="field toggle"><div><strong>Live matches only</strong><div class="hint">Hide Today and Popular catalog choices.</div></div><input type="checkbox" name="liveOnly" value="1"${current.liveOnly ? ' checked' : ''}></div>
<div class="field"><strong>Sports</strong><div class="hint">Select sports to keep. No selection means all sports.</div><div class="sports">${sportOptions}</div></div>
<div class="field"><strong>Poster timezone</strong><div class="hint">Event times are converted from UTC where possible.</div><select name="timezone">${timezoneOptions.map(([value, label]) => `<option value="${escapeHtml(value)}"${timezone === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div>
</section><button class="primary" type="submit">Save configuration</button></form>
<aside><section class="card"><h2>Private install</h2><p class="hint">Keep this URL private.</p><div class="url" id="manifest-url">${escapeHtml(manifestUrl)}</div><div class="actions"><a class="button primary" href="${escapeHtml(stremioUrl)}">Install in Stremio</a><button class="secondary" type="button" data-copy>Copy</button></div></section>
<section class="card"><h2>Supporter benefits</h2><ul class="perks"><li>Live-only catalog mode</li><li>Choose included sports</li><li>Live TV for monthly and lifetime supporters</li><li>Local event timezone</li><li>Private supporter manifest</li></ul></section></aside></div></main>
<script>document.querySelector("[data-copy]").addEventListener("click",async(e)=>{await navigator.clipboard.writeText(document.querySelector("#manifest-url").textContent.trim());e.currentTarget.textContent="Copied";setTimeout(()=>e.currentTarget.textContent="Copy",1200)});</script>
</body></html>`;
};

const renderSportsAdminStatusPage = ({ account, metrics = {}, diagnostics = {}, generatedAt = new Date().toISOString() }) => {
  const routeRows = ['catalog', 'stream'].map((name) => {
    const item = metrics.routes?.[name] || {};
    return '<tr><td>' + escapeHtml(name) + '</td><td>' + escapeHtml(String(item.count || 0)) + '</td><td>' + escapeHtml(String(item.errors || 0)) + '</td><td>' + escapeHtml(String(item.avgMs || 0)) + '</td><td>' + escapeHtml(String(item.p95Ms || 0)) + '</td><td>' + escapeHtml(String(item.maxMs || 0)) + '</td><td>' + escapeHtml(String(item.lastStatus || '')) + '</td></tr>';
  }).join('');
  const cache = diagnostics.caches || {};
  const probe = diagnostics.probe || {};
  const browser = diagnostics.browser || {};
  const alertRows = (metrics.alerts || [])
    .map((item) => '<li><span class="pill down">' + escapeHtml(item.level || 'warn') + '</span> ' + escapeHtml(item.message || '') + '</li>')
    .join('');
  const workerRows = (metrics.workers || [])
    .map((item) => '<tr><td>' + escapeHtml(String(item.pid || '')) + '</td><td>' + escapeHtml(String(item.uptimeSeconds || 0)) + '</td><td>' + escapeHtml(item.updatedAt || '') + '</td></tr>')
    .join('');
  const cacheRows = Object.entries({
    catalogResponse: metrics.caches?.catalogEntries || 0,
    streamResponse: metrics.caches?.streamEntries || 0,
    adapterMatches: cache.matches || 0,
    adapterHls: cache.hls || 0,
    adapterPlaylists: cache.playlists || 0,
    matchIndex: cache.matchIndex || 0
  }).map(([key, value]) => '<tr><td>' + escapeHtml(key) + '</td><td>' + escapeHtml(String(value)) + '</td></tr>').join('');
  const cacheHitRows = Object.entries(metrics.cacheStats || {})
    .map(([key, value]) => '<tr><td>' + escapeHtml(key) + '</td><td>' + escapeHtml(String(value.hits || 0)) + '</td><td>' + escapeHtml(String(value.misses || 0)) + '</td></tr>')
    .join('');
  const recentErrors = (metrics.recentErrors || [])
    .map((item) => '<li><code>' + escapeHtml(item.time || '') + '</code> ' + escapeHtml(item.kind || '') + ' ' + escapeHtml(item.error || '') + '</li>')
    .join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nebula Sports Status</title><style>body{margin:0;background:#0e1116;color:#e7ebf0;font:14px/1.5 Inter,system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:28px 18px 64px}h1{font-size:28px;margin:0 0 6px}h2{font-size:17px;margin:28px 0 12px}.muted{color:#aeb7c2}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.card{border:1px solid #232a33;background:#161b22;border-radius:12px;padding:16px}.num{font-size:28px;font-weight:750}table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #232a33;border-radius:12px;overflow:hidden}th,td{text-align:left;border-bottom:1px solid #232a33;padding:10px 12px;vertical-align:top}th{color:#aeb7c2;font-size:12px;text-transform:uppercase;letter-spacing:.06em}.pill{display:inline-flex;border-radius:999px;padding:2px 9px;font-weight:700;font-size:12px;background:#303846;color:#cbd5e1}.pill.ok{background:rgba(31,170,110,.18);color:#86efac}.pill.down{background:rgba(244,63,94,.18);color:#fecdd3}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd5e1}ul{margin:0;padding-left:18px}@media(max-width:800px){.grid{grid-template-columns:1fr}table{font-size:12px}}</style></head><body><main>' +
    '<h1>Nebula Sports Status</h1><p class="muted">Admin only · signed in as ' + escapeHtml(account?.username || 'admin') + ' · generated ' + escapeHtml(generatedAt) + '</p>' +
    (alertRows ? '<h2>Alerts</h2><div class="card"><ul>' + alertRows + '</ul></div>' : '<h2>Alerts</h2><div class="card muted">No active sports route alerts</div>') +
    '<div class="grid"><div class="card"><div class="muted">Catalog requests</div><div class="num">' + escapeHtml(String(metrics.routes?.catalog?.count || 0)) + '</div></div><div class="card"><div class="muted">Stream requests</div><div class="num">' + escapeHtml(String(metrics.routes?.stream?.count || 0)) + '</div></div><div class="card"><div class="muted">Probe disabled</div><div class="num">' + escapeHtml(String(probe.disabledForSeconds || 0)) + 's</div></div></div>' +
    '<h2>Route Latency</h2><table><thead><tr><th>Route</th><th>Count</th><th>Errors</th><th>Avg ms</th><th>P95 ms</th><th>Max ms</th><th>Last</th></tr></thead><tbody>' + routeRows + '</tbody></table>' +
    '<h2>Cache</h2><div class="grid"><div class="card"><table><tbody>' + cacheRows + '</tbody></table></div><div class="card"><table><thead><tr><th>Cache</th><th>Hit</th><th>Miss</th></tr></thead><tbody>' + cacheHitRows + '</tbody></table></div><div class="card"><p>Browser fallback: <strong>' + escapeHtml(String(browser.fallbackEnabled)) + '</strong></p><p>Browser disabled: <strong>' + escapeHtml(String(browser.disabledForSeconds || 0)) + 's</strong></p><p>Probe enabled: <strong>' + escapeHtml(String(probe.enabled)) + '</strong></p><p>Probe failures: <strong>' + escapeHtml(String(probe.failures || 0)) + '</strong></p></div></div>' +
    '<h2>Workers</h2><table><thead><tr><th>PID</th><th>Uptime</th><th>Updated</th></tr></thead><tbody>' + workerRows + '</tbody></table>' +
    '<h2>Recent Errors</h2><div class="card"><ul>' + (recentErrors || '<li class="muted">No recent sports route errors</li>') + '</ul></div>' +
    '</main></body></html>';
};

const WATCH_TOGETHER_NOTICE = Object.freeze({
  icon: '&#9888;',
  textBeforeLink: 'Stream issues? Use VPN or switch ',
  linkText: 'DNS',
  linkUrl: 'https://1.1.1.1',
  textAfterLink: '.'
});

const renderWatchTogetherNoticeBanner = (notice = WATCH_TOGETHER_NOTICE) => `
  <div class="watch-notice" role="status">
    <span class="watch-notice-icon" aria-hidden="true">${notice.icon}</span>
    <span>${escapeHtml(notice.textBeforeLink)}<a href="${escapeHtml(notice.linkUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(notice.linkText)}</a>${escapeHtml(notice.textAfterLink)}</span>
  </div>`;

const renderWatchTogetherWebManifest = (baseUrl) => {
  const safeBaseUrl = String(baseUrl || '').replace(/\/+$/u, '');
  return {
    name: 'Nebula Sports',
    short_name: 'Nebula Sports',
    description: 'Live sports events in one installable web app.',
    id: '/watch-together',
    start_url: '/watch-together',
    scope: '/watch-together',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone', 'browser'],
    orientation: 'any',
    background_color: '#0a0b0d',
    theme_color: '#e8113b',
    categories: ['sports', 'entertainment'],
    icons: [
      {
        src: `${safeBaseUrl}/assets/nebula-sports-favicon-32.png`,
        sizes: '32x32',
        type: 'image/png'
      },
      {
        src: `${safeBaseUrl}/assets/nebula-sports-favicon.png`,
        sizes: '128x128',
        type: 'image/png'
      },
      {
        src: `${safeBaseUrl}/assets/nebula-sports-logo.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable'
      }
    ],
    shortcuts: [
      {
        name: 'Live Events',
        short_name: 'Live',
        url: '/watch-together?catalog=streamed-events-live'
      },
      {
        name: 'Popular Events',
        short_name: 'Popular',
        url: '/watch-together?catalog=streamed-events-popular'
      }
    ]
  };
};

const renderWatchTogetherServiceWorker = () => `
const CACHE_NAME = 'nebula-sports-app-v1';
const APP_SHELL = [
  '/watch-together',
  '/watch-together/offline',
  '/watch-together/manifest.webmanifest',
  '/assets/nebula-sports-logo.png',
  '/assets/nebula-sports-favicon.png',
  '/assets/nebula-sports-favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => undefined)
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

const isSameOrigin = (url) => url.origin === self.location.origin;
const isAppRequest = (url) => url.pathname === '/watch-together' || url.pathname.startsWith('/watch-together/');
const isStaticAsset = (url) => url.pathname.startsWith('/assets/');
const isLiveApi = (url) => url.pathname.startsWith('/watch-together/api/');

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isSameOrigin(url)) return;

  if (isLiveApi(url)) {
    event.respondWith(fetch(request).catch(() => caches.match('/watch-together/offline')));
    return;
  }

  if (request.mode === 'navigate' && isAppRequest(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/watch-together', copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match('/watch-together').then((cached) => cached || caches.match('/watch-together/offline')))
    );
    return;
  }

  if (isStaticAsset(url) || isAppRequest(url)) {
    event.respondWith(
      caches.match(request)
        .then((cached) => cached || fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
          return response;
        }))
    );
  }
});
`;

const renderWatchTogetherOfflinePage = (baseUrl) => {
  const safeBaseUrl = String(baseUrl || '').replace(/\/+$/u, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#e8113b">
  <title>Nebula Sports Offline</title>
  <style>
    :root{color-scheme:dark;background:#0a0b0d;color:#f2f4f7;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body{margin:0;min-height:100dvh;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,rgba(232,17,59,.16),transparent 32%),#0a0b0d}
    main{width:min(420px,calc(100% - 32px));display:grid;justify-items:center;gap:14px;text-align:center}
    img{width:74px;height:74px;border-radius:18px}
    h1{margin:0;font-size:28px;letter-spacing:-.04em}
    p{margin:0;color:#aab2bd;line-height:1.5}
    a{margin-top:6px;border:1px solid #2c333c;border-radius:12px;background:#14171b;color:#f2f4f7;padding:11px 14px;text-decoration:none;font-weight:800}
  </style>
</head>
<body>
  <main>
    <img src="${escapeHtml(safeBaseUrl)}/assets/nebula-sports-logo.png" alt="">
    <h1>Offline</h1>
    <p>Nebula Sports needs internet for live events. Open again when connection returns.</p>
    <a href="/watch-together">Retry</a>
  </main>
</body>
</html>`;
};

const renderWatchTogetherPage = ({ baseUrl, account = null, errorMessage = '' }) => {
  const safeBaseUrl = String(baseUrl || '').replace(/\/+$/u, '');
  const kofiPageName = escapeHtml(getKofiPageName(config.DONATION_PRIMARY_URL || 'https://ko-fi.com/retro76005'));
  const cboxUrl = (() => {
    try {
      const parsed = new URL(config.WATCH_TOGETHER_CBOX_URL || '');
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
    } catch {
      return '';
    }
  })();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#e8113b">
    <meta name="description" content="Installable Nebula Sports web app for live events.">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="Nebula Sports">
    <title>Nebula Sports Watch Together</title>
    <link rel="manifest" href="/watch-together/manifest.webmanifest">
    <link rel="icon" type="image/png" sizes="32x32" href="${escapeHtml(safeBaseUrl)}/assets/nebula-sports-favicon-32.png">
    <link rel="apple-touch-icon" href="${escapeHtml(safeBaseUrl)}/assets/nebula-sports-favicon.png">
    <style>
      :root{color-scheme:dark;--page:#0b0b0e;--surface:#0f0f12;--surface-2:#18181c;--surface-3:#232328;--ink:#f6f7fb;--muted:#9ca3af;--soft:#c7ccd6;--line:rgba(255,255,255,.105);--line-strong:rgba(255,255,255,.18);--accent:#65e6a4;--accent-2:#78d7ff;--accent-ink:#06100b;--danger:#fecdd3;--shadow:0 24px 80px rgba(0,0,0,.48)}
	      *{box-sizing:border-box}html{background:var(--page)}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% -8%,rgba(120,215,255,.12),transparent 34%),radial-gradient(circle at 88% 6%,rgba(101,230,164,.1),transparent 30%),linear-gradient(180deg,#0b0b0e 0%,#0f1115 100%);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;letter-spacing:0}button,input,select{font:inherit}button{cursor:pointer}a{color:inherit;text-decoration:none}.app{min-height:100dvh;display:grid;grid-template-rows:auto 1fr}.top{height:58px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 18px;border-bottom:1px solid var(--line);background:rgba(11,11,14,.78);backdrop-filter:blur(18px);position:sticky;top:0;z-index:5}.brand{display:flex;align-items:center;gap:10px;font-weight:900}.brand img{width:34px;height:34px;border-radius:13px;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 10px 24px rgba(101,230,164,.15)}.brand-copy{display:grid;line-height:1.02}.brand-copy span{font-size:15px;letter-spacing:-.025em;background:linear-gradient(90deg,#f8fbff 0%,#78d7ff 52%,#65e6a4 100%);-webkit-background-clip:text;background-clip:text;color:transparent}.brand-copy small{margin-top:4px;color:var(--muted);font-size:10px;font-weight:800}.actions{display:flex;gap:7px;align-items:center}.btn{min-height:32px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.035);color:var(--soft);padding:6px 10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap;transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease,box-shadow .18s ease}.btn:hover{border-color:var(--line-strong);background:rgba(255,255,255,.07);color:var(--ink)}.btn:active{transform:translateY(1px) scale(.99)}.btn.primary{border-color:transparent;background:linear-gradient(135deg,var(--accent),#8df6bf);color:var(--accent-ink);box-shadow:0 10px 28px rgba(101,230,164,.2)}.btn.primary:hover{box-shadow:0 14px 36px rgba(101,230,164,.28)}.btn-icon{opacity:.86;font-weight:900}.layout{width:min(1280px,100%);margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px;padding:12px 16px 16px}.stage{min-width:0;display:grid;gap:12px}.intro{min-height:84px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(180deg,rgba(24,24,28,.82),rgba(15,15,18,.82));display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 18px;box-shadow:0 14px 46px rgba(0,0,0,.22)}.intro h1{margin:0;max-width:660px;font-size:clamp(26px,3vw,40px);font-weight:950;line-height:1;letter-spacing:-.04em}.intro p{margin:7px 0 0;max-width:520px;color:var(--muted);font-size:14px;line-height:1.45}.signal{display:flex;align-items:center;gap:9px;white-space:nowrap;padding:7px 9px 7px 11px;border:1px solid rgba(101,230,164,.22);border-radius:999px;background:rgba(101,230,164,.06)}.signal span{color:#d8f8e2;font-size:11px;font-weight:900}.pill{border:1px solid rgba(101,230,164,.24);border-radius:999px;padding:5px 10px;color:#d8f8e2;background:rgba(101,230,164,.08);font-size:11px;font-weight:900}.live-dot,.dot{position:relative;width:8px;height:8px;border-radius:99px;background:var(--accent);box-shadow:0 0 0 4px rgba(101,230,164,.14)}.live-dot::after,.dot::after{content:"";position:absolute;inset:-6px;border-radius:99px;border:1px solid rgba(101,230,164,.58);animation:pulse 1.8s ease-out infinite}@keyframes pulse{0%{transform:scale(.65);opacity:.9}100%{transform:scale(1.75);opacity:0}}.player-shell{border:1px solid var(--line-strong);border-radius:18px;background:#07080a;box-shadow:0 14px 44px rgba(0,0,0,.38);overflow:hidden}.player-head{min-height:42px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(35,35,40,.86),rgba(18,18,22,.92));color:#eef2f0}.status{display:inline-flex;align-items:center;gap:8px;min-height:30px;border:1px solid rgba(101,230,164,.22);border-radius:999px;background:rgba(101,230,164,.06);padding:5px 9px;color:#d8f8e2;font-size:10px;font-weight:900;letter-spacing:.02em}.player{aspect-ratio:16/9;width:100%;min-height:328px;background:#050608;display:grid;place-items:center;overflow:hidden;border-radius:0 0 19px 19px}.player iframe{display:block;width:100%;height:100%;border:0;background:#050608}.empty{display:grid;place-items:center;text-align:center;gap:6px;padding:20px;color:#8d949f}.empty strong{display:block;color:var(--soft);font-size:16px;font-weight:900}.empty span{max-width:320px;line-height:1.45}.now{border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,rgba(24,24,28,.8),rgba(15,15,18,.88));display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,42%);gap:10px;padding:10px;box-shadow:0 8px 34px rgba(0,0,0,.2)}.now-copy h1{margin:0;font-size:18px;font-weight:950;line-height:1.15;letter-spacing:-.025em}.now-copy p{margin:5px 0 0;color:var(--muted);font-size:12px}.streams{display:flex;align-items:center;gap:7px;overflow:auto;padding:2px 2px 3px}.streams h3{display:none}.stream-btn{min-height:34px;display:flex;align-items:center;justify-content:space-between;gap:9px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.04);color:var(--ink);padding:6px 9px 6px 10px;white-space:nowrap;transition:background .18s ease,border-color .18s ease,transform .18s ease}.stream-btn:hover{border-color:rgba(120,215,255,.32);background:rgba(120,215,255,.075);transform:translateY(-1px)}.stream-btn.active{border-color:rgba(101,230,164,.5);background:rgba(101,230,164,.12)}.quality{font-size:11px;font-weight:950;letter-spacing:.02em;color:#e9fff2}.viewer{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:#b9c1ca;font-weight:850}.viewer::before{content:"";width:10px;height:6px;border:1px solid currentColor;border-radius:999px;box-shadow:inset 0 0 0 2px rgba(255,255,255,.03)}.badge{font-size:11px;color:#d8f8e2;font-weight:900}.side{min-height:0;border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,rgba(24,24,28,.88),rgba(15,15,18,.92));overflow:hidden;box-shadow:0 14px 46px rgba(0,0,0,.26);display:grid;grid-template-rows:auto 1fr}.tabs{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:8px;padding:5px;border:1px solid var(--line);border-radius:999px;background:rgba(0,0,0,.22)}.tab{height:34px;border:0;border-radius:999px;background:transparent;color:var(--muted);font-weight:900;display:flex;align-items:center;justify-content:center;gap:6px;transition:background .2s ease,color .2s ease,box-shadow .2s ease,transform .2s ease}.tab:hover{color:var(--ink);background:rgba(255,255,255,.045)}.tab.active{background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.07));color:var(--ink);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),0 7px 18px rgba(0,0,0,.22)}.tab-icon{color:var(--accent);font-size:11px}.panel{display:none;min-height:0}.panel.active{display:grid}.events-panel{grid-template-rows:auto 1fr}.side-head{padding:12px 14px 14px;border-bottom:1px solid var(--line);display:grid;gap:10px}.side-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.side-title h2{margin:0;font-size:17px;font-weight:950;letter-spacing:-.025em}.search{display:grid;grid-template-columns:1fr auto;gap:8px}.search input,.side select{width:100%;height:34px;border:1px solid var(--line);background:rgba(255,255,255,.045);color:var(--ink);border-radius:999px;padding:0 13px;outline:none;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease}.search input::placeholder{color:#737b86}.search input:focus,.side select:focus{border-color:rgba(101,230,164,.48);background:rgba(255,255,255,.065);box-shadow:0 0 0 4px rgba(101,230,164,.1)}.filters{display:grid;gap:8px}.catalog-picker{position:relative}.catalog-trigger{width:100%;height:34px;border:1px solid var(--line);background:rgba(255,255,255,.045);color:var(--ink);border-radius:999px;padding:0 13px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-weight:850;text-align:left;outline:none;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease}.catalog-trigger:hover,.catalog-trigger[aria-expanded="true"]{border-color:rgba(101,230,164,.48);background:rgba(255,255,255,.065);box-shadow:0 0 0 4px rgba(101,230,164,.1)}.catalog-menu{position:absolute;z-index:30;top:calc(100% + 6px);left:0;right:0;display:none;max-height:260px;overflow:auto;padding:6px;border:1px solid var(--line-strong);border-radius:14px;background:#101116;box-shadow:0 18px 42px rgba(0,0,0,.48)}.catalog-picker.open .catalog-menu{display:grid;gap:3px}.catalog-option{width:100%;min-height:32px;border:0;border-radius:10px;background:transparent;color:#e7edf4;padding:7px 10px;text-align:left;font-size:12px;font-weight:850}.catalog-option:hover,.catalog-option:focus{background:rgba(120,215,255,.12);color:#fff;outline:none}.catalog-option.active{background:rgba(101,230,164,.15);color:#d8f8e2}.list{overflow:auto;padding:8px;display:grid;gap:7px;align-content:start}.event{width:100%;text-align:left;border:1px solid transparent;border-radius:14px;background:rgba(255,255,255,.035);color:var(--ink);padding:11px 12px;display:grid;gap:6px;transition:background .18s ease,border-color .18s ease,transform .18s ease}.event:hover{border-color:var(--line-strong);background:rgba(255,255,255,.06);transform:translateY(-1px)}.event.active{border-color:rgba(101,230,164,.44);background:rgba(101,230,164,.1)}.event strong{display:block;font-size:13px;line-height:1.32;font-weight:900}.event span{display:block;color:var(--muted);font-size:11px;line-height:1.35}.chat{padding:12px;grid-template-rows:auto 1fr auto;gap:8px;min-height:440px}.cbox-frame{width:100%;height:100%;min-height:360px;border:1px solid var(--line);border-radius:14px;background:#0b0d10;overflow:hidden}.cbox-frame iframe{display:block;width:100%;height:100%;border:0;background:#0b0d10}.cbox-status{min-height:16px;color:var(--muted);font-size:11px}.error{color:var(--danger);border:1px solid #7f1d1d;background:#2a1014;border-radius:14px;padding:10px;margin-top:12px}.floatingchat-container-wrap{right:18px!important;bottom:18px!important;z-index:20!important;background:transparent!important;box-shadow:none!important}.floatingchat-container-wrap iframe,.floatingchat-container-wrap-mobi iframe{background:transparent!important;box-shadow:none!important}.floatingchat-container-wrap-mobi{right:12px!important;bottom:12px!important;z-index:20!important}@media(min-width:1081px){body{font-size:12px}.top{height:54px;padding:0 16px}.brand img{width:31px;height:31px}.brand-copy span{font-size:14px}.layout{width:min(1200px,100%);grid-template-columns:minmax(0,1fr) 300px;gap:12px;padding:10px 14px 14px}.stage{gap:10px}.intro{min-height:74px;padding:13px 15px;border-radius:18px}.intro h1{font-size:clamp(24px,2.55vw,35px)}.intro p{font-size:13px}.player-head{min-height:38px}.player{min-height:296px}.now{padding:9px}.now-copy h1{font-size:16px}.side{border-radius:16px}.tabs{margin:7px}.side-head{padding:10px 12px 12px}.chat{min-height:400px;padding:10px}.event{padding:9px 10px}.btn{min-height:30px;padding:5px 9px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}@media(max-width:1080px){.layout{grid-template-columns:1fr}.player{min-height:auto}.side{min-height:480px}.intro{align-items:flex-start}.now{grid-template-columns:1fr}.streams{padding-top:4px}.signal{align-self:flex-start}}@media(max-width:680px){.top{height:auto;padding:12px;align-items:flex-start;flex-direction:column}.actions{width:100%;overflow:auto}.layout{padding:12px 12px 80px;gap:14px}.intro{min-height:0;padding:16px;align-items:flex-start;flex-direction:column}.intro h1{font-size:30px}.player-head{align-items:flex-start;flex-direction:column}.now{padding:12px}.side{min-height:540px}.brand-copy small{display:none}.btn{min-height:36px;padding:7px 12px}.tabs{border-radius:20px}.tab{height:38px}.player{border-radius:0 0 19px 19px}.cbox-frame{min-height:430px}}
    </style>
    <style>
      .watch-notice{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:8px 14px;border-bottom:1px solid rgba(240,160,32,.2);background:#2a1b04;color:#f0a020;font-size:12px;font-weight:800;text-align:center}
      .watch-notice a{color:#ffbd4a;text-decoration:underline;text-underline-offset:2px}
      .watch-notice-icon{font-size:13px;line-height:1}
      .install-app-btn{display:none}
      .install-app-btn.is-ready{display:inline-flex}
      .intro-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
      .live-count-pill{display:none;align-items:center;gap:8px;border:1px solid rgba(101,230,164,.24);border-radius:999px;background:rgba(101,230,164,.08);color:#d8f8e2;padding:5px 10px;font-size:11px;font-weight:900}
      .live-count-pill.is-ready{display:inline-flex}
      .live-count-pill .live-count-dot{position:relative;width:8px;height:8px;border-radius:99px;background:var(--accent);box-shadow:0 0 0 4px rgba(101,230,164,.14)}
      .live-count-pill .live-count-dot::after{content:"";position:absolute;inset:-6px;border-radius:99px;border:1px solid rgba(101,230,164,.58);animation:pulse 1.8s ease-out infinite}
      .player-gate{width:100%;height:100%;min-height:inherit;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 30%,rgba(101,230,164,.1),transparent 34%),#050608}
      .player-gate-card{display:grid;justify-items:center;text-align:center;color:var(--soft)}
      .play-gate-btn{width:72px;height:72px;border:1px solid rgba(101,230,164,.36);border-radius:999px;background:linear-gradient(135deg,var(--accent),#8df6bf);color:var(--accent-ink);font-size:30px;font-weight:950;line-height:1;display:grid;place-items:center;padding-left:4px;box-shadow:0 18px 46px rgba(101,230,164,.22);transition:transform .18s ease,box-shadow .18s ease}
      .play-gate-btn:hover{transform:translateY(-1px) scale(1.03);box-shadow:0 22px 56px rgba(101,230,164,.3)}
      .play-gate-btn:active{transform:scale(.98)}
      .player-shell{position:relative}
      .player-control{position:absolute;bottom:12px;z-index:3;width:38px;height:38px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(5,6,8,.62);backdrop-filter:blur(12px);color:var(--ink);display:grid;place-items:center;font-size:17px;font-weight:950;box-shadow:0 10px 28px rgba(0,0,0,.36);transition:background .18s ease,border-color .18s ease,transform .18s ease}
      .player-control:hover{background:rgba(101,230,164,.16);border-color:rgba(101,230,164,.38);transform:translateY(-1px)}
      .player-control:active{transform:scale(.98)}
      .player-fullscreen{right:12px}
      .stats-toggle[hidden],.match-stats-overlay[hidden]{display:none!important}
      .match-stats-overlay{position:absolute;right:12px;top:54px;z-index:4;width:min(360px,calc(100% - 24px));border:1px solid rgba(255,255,255,.16);border-radius:18px;background:rgba(10,12,16,.82);box-shadow:0 24px 60px rgba(0,0,0,.44);backdrop-filter:blur(18px);color:var(--ink);overflow:hidden}
      .match-stats-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 13px;border-bottom:1px solid rgba(255,255,255,.1)}
      .match-stats-head strong{font-size:12px;font-weight:950;color:#d8f8e2}
      .match-stats-head span{color:var(--muted);font-size:10px;font-weight:850}
      .match-stats-close{width:26px;height:26px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.06);color:var(--ink);display:grid;place-items:center}
      .match-score{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;padding:13px}
      .match-team{display:grid;gap:6px;justify-items:center;text-align:center;min-width:0}
      .match-crest{width:36px;height:36px;border:1px solid rgba(101,230,164,.24);border-radius:999px;background:rgba(101,230,164,.1);display:grid;place-items:center;color:#d8f8e2;font-size:12px;font-weight:950}
      .match-crest img{width:26px;height:26px;object-fit:contain}
      .match-team span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:900}
      .match-scoreline{display:grid;gap:3px;justify-items:center}
      .match-scoreline strong{font-size:24px;line-height:1;font-weight:950}
      .match-scoreline span{border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.06);color:var(--muted);padding:3px 8px;font-size:10px;font-weight:900}
      .match-stats-grid{display:grid;gap:7px;padding:0 13px 13px}
      .match-stat{display:grid;grid-template-columns:42px 1fr 42px;align-items:center;gap:8px;color:var(--soft);font-size:11px}
      .match-stat span:first-child,.match-stat span:last-child{font-weight:950;color:var(--ink);text-align:center}
      .match-stat small{text-align:center;color:var(--muted);font-size:10px;font-weight:850;text-transform:uppercase;letter-spacing:.04em}
      .match-stats-note{margin:0 13px 13px;padding:8px 10px;border:1px solid rgba(240,160,32,.18);border-radius:12px;background:rgba(240,160,32,.08);color:#f0c078;font-size:10px;font-weight:800;text-align:center}
      .player.is-multiview{aspect-ratio:auto;min-height:420px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:8px;padding:8px;align-items:stretch;justify-items:stretch}
      .player.is-multiview .empty{grid-column:1/-1}
      .multi-tile{position:relative;width:100%;aspect-ratio:16/9;min-width:0;min-height:0;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:#050608;overflow:hidden}
      .multi-tile iframe{display:block;width:100%;height:100%;border:0;background:#050608}
      .multi-title{position:absolute;left:8px;right:8px;top:8px;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;padding:6px 8px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(5,6,8,.68);backdrop-filter:blur(10px);color:var(--soft);font-size:10px;font-weight:900}
      .multi-title span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .multi-source{flex:0 0 auto;border:1px solid rgba(101,230,164,.24);border-radius:999px;background:rgba(101,230,164,.12);color:#d8f8e2;padding:3px 7px;font-size:9px;font-weight:950;white-space:nowrap}
      .multi-close{width:22px;height:22px;border:0;border-radius:999px;background:rgba(255,255,255,.08);color:var(--ink);padding:0;display:grid;place-items:center}
      .multi-body{width:100%;height:100%;min-width:0;min-height:0}
      .multi-tile .player-gate{width:100%;height:100%;min-height:0;padding:16px}
      .multi-tile .play-gate-btn{width:54px;height:54px;font-size:24px}
      .streams{flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;align-items:center;scrollbar-width:thin}
      .stream-btn{flex:0 0 auto;max-width:220px}
      .btn.active-mode{border-color:rgba(101,230,164,.45);background:rgba(101,230,164,.12);color:#d8f8e2}
      @media(max-width:680px){.player.is-multiview{grid-template-columns:1fr;min-height:520px}.multi-tile{aspect-ratio:16/10}.match-stats-overlay{left:10px;right:10px;top:auto;bottom:58px;width:auto;max-height:62%;overflow:auto}}
      @media(min-width:1081px){.layout{align-items:start}.side{height:calc(100dvh - 112px);max-height:680px;min-height:0}.panel.active{min-height:0}.events-panel{min-height:0}.list,.chat-list{min-height:0;overflow-y:auto}.chat{height:100%;min-height:0}}
      @media(max-width:1080px){.side{height:min(620px,70dvh);min-height:0}.panel.active,.events-panel{min-height:0}.list,.chat-list{min-height:0;overflow-y:auto}.chat{height:100%;min-height:0}}
	      @media(max-width:680px){.watch-notice{padding:8px 10px;font-size:11px}.intro-actions{justify-content:flex-start}.live-count-pill{padding:5px 8px}}
	    </style>
    <style>
      :root{--bg:#0a0b0d;--bg-2:#0f1114;--surface:#14171b;--surface-2:#1a1e23;--surface-3:#21262d;--hover:#272d35;--border:#20242b;--border-2:#2c333c;--text:#f2f4f7;--text-2:#aab2bd;--text-3:#6b7480;--accent:#e8113b;--accent-soft:rgba(232,17,59,.14);--radius:14px;--radius-sm:10px;--rail:76px;--page:var(--bg);--ink:var(--text);--muted:var(--text-3);--soft:var(--text-2);--line:var(--border);--line-strong:var(--border-2);--accent-ink:#fff;--danger:#fecdd3}
      html{scroll-behavior:smooth;background:var(--bg)}
      body{background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;overflow-x:hidden}
      body::selection{background:rgba(232,17,59,.3)}
      .app{display:grid;grid-template-rows:auto 1fr;min-height:100dvh;background:var(--bg)}
      .watch-notice{display:block;min-height:34px;height:auto;padding:6px 14px;border-bottom:1px solid var(--border);background:var(--bg-2);color:var(--text-2);font-size:12.5px;font-weight:500;line-height:1.25;text-align:center}
      .watch-notice-icon{display:inline-block;margin-right:6px}
      .watch-notice span:last-child{min-width:0;max-width:100%;overflow-wrap:anywhere}
      .watch-notice a{color:var(--text);font-weight:700;text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}
      .watch-shell{display:grid;grid-template-columns:var(--rail) 1fr;min-height:calc(100dvh - 34px)}
      .rail{position:sticky;top:0;align-self:start;height:calc(100dvh - 34px);display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 0;background:var(--bg-2);border-right:1px solid var(--border);z-index:8}
      .rail-logo{width:42px;height:42px;border-radius:12px;margin-bottom:14px;display:grid;place-items:center;overflow:hidden;background:var(--accent);box-shadow:0 6px 18px -6px rgba(232,17,59,.7)}
      .rail-logo img{width:100%;height:100%;object-fit:cover}
      .nav-item{width:48px;height:48px;border:0;border-radius:12px;display:grid;place-items:center;color:var(--text-3);background:transparent;cursor:pointer;transition:.15s ease;position:relative;font-size:20px}
      .nav-item:hover{background:var(--surface-2);color:var(--text)}
      .nav-item.active{background:var(--surface-3);color:var(--text)}
      .nav-item.active::before{content:"";position:absolute;left:-16px;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
      .nav-item .label{position:absolute;left:58px;white-space:nowrap;background:var(--surface-3);border:1px solid var(--border-2);padding:5px 10px;border-radius:7px;font-size:12px;font-weight:700;opacity:0;pointer-events:none;transform:translateX(-4px);transition:.15s ease;z-index:60}
      .nav-item:hover .label{opacity:1;transform:translateX(0)}
      .rail-spacer{flex:1}
      .rail-avatar{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:var(--surface-3);border:1px solid var(--border-2);font-size:13px;font-weight:800;color:var(--text-2)}
      .workspace{min-width:0}
      .top{height:68px;position:sticky;top:0;z-index:7;display:flex;align-items:center;gap:18px;padding:14px 28px;border-bottom:1px solid var(--border);background:rgba(10,11,13,.82);backdrop-filter:blur(14px)}
      .brand{gap:11px}.brand img{width:42px;height:42px;border-radius:12px;box-shadow:0 6px 18px -6px rgba(232,17,59,.55)}
      .brand-copy span{font-size:15px;color:var(--text);background:none;-webkit-background-clip:initial;background-clip:initial}
      .brand-copy small{color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
      .sport-tabs{display:flex;align-items:center;gap:4px;margin-left:16px;overflow:auto;scrollbar-width:none}
      .sport-tabs::-webkit-scrollbar{display:none}
      .sport-tab{min-height:34px;border:0;border-radius:9px;background:transparent;color:var(--text-3);padding:8px 14px;font-size:13px;font-weight:800;white-space:nowrap}
      .sport-tab:hover{background:var(--surface);color:var(--text)}
      .sport-tab.active{background:var(--surface-2);color:var(--text)}
      .actions{gap:8px}.top>.actions{margin-left:auto}
      .btn{min-height:40px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text-2);font-size:12.5px;font-weight:700;padding:7px 12px}
      .btn:hover{background:var(--hover);border-color:var(--border-2);color:var(--text);transform:none;box-shadow:none}
      .btn.primary{background:var(--accent);color:#fff;border-color:transparent;box-shadow:0 10px 30px -8px rgba(232,17,59,.6)}
      .btn.active-mode{background:var(--surface-3);border-color:var(--border-2);color:#fff}
      .layout{width:min(1640px,100%);grid-template-columns:minmax(0,1fr) 376px;gap:24px;padding:24px 28px 60px;align-items:start}
      .stage{gap:0}
      .intro{display:none}
      .player-shell{border-radius:var(--radius);border:1px solid var(--border);background:#000;box-shadow:none;overflow:hidden}
      .player-head{min-height:52px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--surface);gap:12px}
      .status{border:0;border-radius:6px;background:var(--accent);color:#fff;padding:5px 9px;font-size:11.5px;letter-spacing:.04em}
      .dot,.live-dot,.live-count-dot{background:#fff;box-shadow:none}
      .dot::after,.live-dot::after,.live-count-dot::after{border-color:rgba(255,255,255,.5)}
      .player{position:relative;min-height:360px;border-radius:0;background:linear-gradient(180deg,#101216,#050506)}
      .player::after{content:"";position:absolute;inset:0;background:radial-gradient(120% 80% at 50% 0%,transparent 60%,rgba(0,0,0,.5));pointer-events:none}
      .player iframe,.player-gate,.multi-tile{position:relative;z-index:1}
      .player-gate{background:transparent}
      .play-gate-btn{width:66px;height:66px;border:0;background:var(--accent);color:#fff;box-shadow:0 10px 30px -8px rgba(232,17,59,.6)}
      .play-gate-btn:hover{transform:scale(1.07);box-shadow:0 10px 30px -8px rgba(232,17,59,.75)}
      .player-control{right:14px;bottom:14px;border-radius:8px;border:1px solid var(--border-2);background:rgba(0,0,0,.55)}
      .match-stats-overlay{border-color:var(--border-2);border-radius:var(--radius);background:rgba(15,17,20,.92)}
      .match-stats-head strong,.chat-name,.quality,.badge{color:var(--text)}
      .now{grid-template-columns:1fr;gap:0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}
      .now-copy{display:flex;align-items:center;gap:16px;padding:16px 18px;background:var(--surface);border:1px solid var(--border);border-top:0}
      .now-copy h1{font-size:16px;font-weight:800}.now-copy p{margin:0;margin-left:auto;color:var(--text-3);font-size:12px}
      .streams{padding:12px 18px;border:1px solid var(--border);border-top:0;background:var(--surface);gap:10px}
      .streams::before{content:"Sources";font-size:12px;font-weight:700;color:var(--text-3);margin-right:2px}
      .stream-btn{min-height:34px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border);padding:7px 12px;max-width:none}
      .stream-btn:hover{background:var(--hover);border-color:var(--border-2);transform:none}
      .stream-btn.active{background:var(--surface-3);border-color:var(--border-2);color:#fff}
      .viewer{color:var(--text-3)}.viewer::before{display:none}
      .side{position:sticky;top:88px;height:calc(100dvh - 112px);max-height:760px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-2);box-shadow:none}
      .tabs{margin:0;padding:12px 14px;border:0;border-bottom:1px solid var(--border);border-radius:0;background:var(--surface);grid-template-columns:1fr 1fr}
      .tab{height:34px;border-radius:7px;color:var(--text-3);font-size:12.5px}.tab.active{background:var(--surface-3);box-shadow:none;color:var(--text)}
      .tab-icon{color:var(--accent)}
      .side-head{padding:14px 16px;border-bottom:1px solid var(--border);background:var(--surface)}
      .side-title h2{font-size:14px;font-weight:800}
      .pill,.live-count-pill{border:0;background:var(--accent-soft);color:var(--accent);font-size:11px;font-weight:800}
      .search{grid-template-columns:1fr auto;gap:8px}
      .search input,.chat input,.catalog-trigger{height:40px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text)}
      .search input:focus,.chat input:focus,.catalog-trigger:hover,.catalog-trigger[aria-expanded=true]{border-color:var(--border-2);box-shadow:none;background:var(--surface-2)}
      .catalog-menu{border-color:var(--border-2);border-radius:10px;background:var(--surface);box-shadow:0 18px 42px rgba(0,0,0,.45)}
      .catalog-option{border-radius:7px}.catalog-option:hover,.catalog-option:focus,.catalog-option.active{background:var(--surface-3);color:var(--text)}
      .list{padding:0;gap:0}
      .event{border:0;border-left:3px solid transparent;border-radius:0;background:transparent;padding:12px 16px;gap:4px}
      .event:hover{background:var(--surface);transform:none}
      .event.active{border-color:var(--accent);background:var(--surface-2)}
      .event strong{font-size:13px}.event span{color:var(--text-3)}
      .chat{padding:12px;gap:8px}
      .chat-msg{border-radius:10px;border-color:var(--border);background:var(--surface);box-shadow:none}
      .chat-form{grid-template-columns:86px 1fr auto}
      .floatingchat-container-wrap{right:18px!important;bottom:18px!important;z-index:80!important}
      .floatingchat-container-wrap-mobi{right:12px!important;bottom:12px!important;z-index:80!important}
      .kofi-fallback{position:fixed;right:18px;bottom:18px;z-index:79;display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 14px;border-radius:10px;background:var(--accent);color:#fff;font-size:13px;font-weight:900;box-shadow:0 14px 34px rgba(0,0,0,.36),0 10px 30px -8px rgba(232,17,59,.72)}
      .kofi-fallback.is-hidden{display:none}
      @media(max-width:1180px){.layout{grid-template-columns:1fr}.side{position:static;height:min(680px,72dvh);max-height:none}}
      @media(max-width:720px){.app,.watch-shell,.workspace,.layout,.stage,.side{width:100%;max-width:100vw;min-width:0}.watch-shell{display:block;min-height:100dvh}.rail{position:fixed;left:10px;right:10px;bottom:10px;top:auto;width:auto;height:58px;z-index:90;display:flex;flex-direction:row;justify-content:space-around;align-items:center;gap:2px;padding:6px;border:1px solid var(--border-2);border-radius:18px;background:rgba(15,17,20,.92);box-shadow:0 18px 44px rgba(0,0,0,.46);backdrop-filter:blur(18px)}.rail-logo,.rail-avatar,.rail-spacer{display:none}.nav-item{width:44px;height:44px;border-radius:14px;font-size:18px}.nav-item.active::before{left:12px;right:12px;top:auto;bottom:-6px;width:auto;height:3px;border-radius:3px}.nav-item .label{display:none}.top{height:auto;min-height:64px;align-items:center;flex-direction:row;flex-wrap:wrap;padding:10px 10px 8px;gap:8px}.brand{order:1;flex:1 1 auto}.brand img{width:34px;height:34px}.brand-copy span{font-size:14px}.brand-copy small{display:none}.top>.actions{order:2;margin-left:0;width:auto;max-width:48%;overflow:auto;justify-content:flex-end}.top>.actions .btn{min-height:34px;padding:7px 10px;font-size:12px}.sport-tabs{order:3;width:100%;margin-left:0;padding:2px 0 0;gap:6px}.sport-tab{min-height:34px;padding:7px 12px;border-radius:10px;background:var(--surface);font-size:12px}.sport-tab.active{background:var(--surface-3)}.layout{padding:8px 10px 88px;gap:12px}.player-shell{border-radius:16px}.player-head{min-height:46px;align-items:center;flex-direction:row;padding:8px 10px}.player-head>.actions{overflow:auto;justify-content:flex-end}.player-head .btn{min-height:34px;padding:7px 10px}.status{min-width:0;max-width:52%;overflow:hidden}.status span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.player{min-height:auto;aspect-ratio:16/9}.play-gate-btn{width:62px;height:62px;font-size:28px}.now-copy{align-items:flex-start;flex-direction:column;padding:12px}.now-copy h1{font-size:15px}.now-copy p{margin-left:0}.streams{padding:10px 12px;gap:8px}.streams::before{display:none}.stream-btn{max-width:78vw;min-height:38px}.side{position:static;height:min(620px,66dvh);max-height:none;border-radius:16px}.tabs{padding:10px}.side-head{padding:12px}.event{padding:13px 14px}.chat{padding:10px}.chat-form{grid-template-columns:1fr}.chat input{height:42px}.floatingchat-container-wrap,.floatingchat-container-wrap-mobi{right:12px!important;bottom:78px!important}.kofi-fallback{right:12px;bottom:78px}}
    </style>
	  </head>
  <body>
    ${
      `
	      <main class="app" data-base="${escapeHtml(safeBaseUrl)}">
	        ${renderWatchTogetherNoticeBanner()}
	        <div class="watch-shell">
	          <nav class="rail" aria-label="Sports navigation">
	            <a class="rail-logo" href="/watch-together" aria-label="Nebula Sports"><img src="${escapeHtml(safeBaseUrl)}/assets/nebula-sports-logo.png" alt=""></a>
		            <button class="nav-item active" type="button" data-rail="live" aria-label="Live"><span aria-hidden="true">⌂</span><span class="label">Live</span></button>
		            <button class="nav-item" type="button" data-rail="events" aria-label="Events"><span aria-hidden="true">◉</span><span class="label">Events</span></button>
		            <button class="nav-item" type="button" data-rail="today" aria-label="Today"><span aria-hidden="true">▦</span><span class="label">Today</span></button>
		            <button class="nav-item" type="button" data-rail="popular" aria-label="Popular"><span aria-hidden="true">☆</span><span class="label">Popular</span></button>
		            <button class="nav-item" type="button" data-rail="multi" aria-label="Multiview"><span aria-hidden="true">▣</span><span class="label">Multiview</span></button>
		            <div class="rail-spacer"></div>
		            <a class="nav-item" href="/sports" aria-label="Stremio addon"><span aria-hidden="true">□</span><span class="label">Addon</span></a>
		            <a class="rail-avatar" href="${escapeHtml(config.DONATION_PRIMARY_URL || 'https://ko-fi.com/retro76005')}" target="_blank" rel="noopener noreferrer" aria-label="Support Nebula Sports">N</a>
	          </nav>
	          <div class="workspace">
	        <header class="top">
		          <div class="brand"><img src="${escapeHtml(safeBaseUrl)}/assets/nebula-sports-logo.png" alt=""><div class="brand-copy"><span>Nebula Sports</span><small>Free live events</small></div></div>
		          <nav class="sport-tabs" aria-label="Sport filters">
		            <button class="sport-tab active" type="button" data-sport-filter="all">All</button>
		            <button class="sport-tab" type="button" data-sport-filter="football">Football</button>
		            <button class="sport-tab" type="button" data-sport-filter="rugby">Rugby</button>
		            <button class="sport-tab" type="button" data-sport-filter="motorsport">Motorsport</button>
		            <button class="sport-tab" type="button" data-sport-filter="combat">Combat</button>
		            <button class="sport-tab" type="button" data-sport-filter="more">More</button>
		          </nav>
			          <div class="actions">
			            <button class="btn primary install-app-btn" id="installApp" type="button"><span class="btn-icon">▣</span>Install webapp</button>
			            <a class="btn" href="/sports"><span class="btn-icon">□</span>Stremio addon</a>
			            <a class="btn" href="https://omg10.com/4/11165437" target="_blank" rel="sponsored noopener noreferrer"><span class="btn-icon">↗</span>Sponsored</a>
		          </div>
        </header>
        <div class="layout">
          <section class="stage">
	            <div class="intro">
	              <div>
	                <h1>Live sports.</h1>
	                <p>Pick an event, choose a source, start watching.</p>
	              </div>
		              <div class="intro-actions"><div class="signal"><span class="live-dot"></span><span>Now live</span><strong class="pill" id="heroCount">Loading</strong></div><span class="live-count-pill" id="liveCountBadge"><span class="live-count-dot"></span><span id="liveCountText">— live</span></span></div>
	            </div>
	            <div class="player-shell">
	              <div class="player-head">
		                <div class="status"><span class="dot"></span><span id="statusLine">Live events ready</span></div>
                    <div class="actions"><button class="btn stats-toggle" id="matchStatsToggle" type="button" hidden>Stats</button><button class="btn" id="multiViewToggle" type="button">Multi</button><button class="btn" id="reloadFrame" type="button"><span class="btn-icon">↻</span>Reload player</button></div>
	              </div>
	              <div class="player" id="player"><div class="empty"><strong>Select event</strong><span>Live player opens here.</span></div></div>
                <section class="match-stats-overlay" id="matchStatsOverlay" hidden aria-live="polite"></section>
                <button class="player-control player-fullscreen" id="fullscreenPlayer" type="button" aria-label="Fullscreen">⛶</button>
	            </div>
	            <div class="now">
	              <div class="now-copy"><h1 id="nowTitle">No event selected</h1><p id="nowMeta">Pick event and source.</p></div>
	              <div class="streams" id="streams"><h3>Sources</h3><div class="empty">Select event first.</div></div>
	            </div>
	          </section>
	          <aside class="side">
		            <nav class="tabs" aria-label="Watch sections">
			              <button class="tab active" type="button" data-panel="eventsPanel"><span class="tab-icon">▦</span>Events</button>
			              <button class="tab" type="button" data-panel="chatPanel"><span class="tab-icon">◌</span>Chat</button>
		            </nav>
	            <section class="panel events-panel active" id="eventsPanel" aria-label="Events">
	              <div class="side-head">
	                <div class="side-title"><h2>Events</h2><span class="pill" id="eventCount">Loading</span></div>
	                <div class="search"><input id="search" placeholder="Search event"><button class="btn" id="searchBtn" type="button">Search</button></div>
	                <div class="filters"><input type="hidden" id="catalog"><div class="catalog-picker" id="catalogPicker"><button class="catalog-trigger" id="catalogButton" type="button" aria-haspopup="listbox" aria-expanded="false"><span id="catalogLabel">Live</span><span aria-hidden="true">⌄</span></button><div class="catalog-menu" id="catalogMenu" role="listbox"></div></div></div>
	              </div>
	              <div class="list" id="events"><div class="empty">Loading events...</div></div>
	            </section>
	            <section class="panel chat" id="chatPanel" aria-label="Public chat">
	              <div class="side-title"><h2>Live chat</h2><span class="pill">Cbox</span></div>
	              <div class="cbox-frame">
                  ${cboxUrl ? `<iframe src="${escapeHtml(cboxUrl)}" title="Nebula Sports chat" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>` : '<div class="empty"><strong>Chat not configured</strong><span>Add WATCH_TOGETHER_CBOX_URL from Cbox Publish page.</span></div>'}
                </div>
	              <div class="cbox-status">Chat runs on Cbox, not Nebula server.</div>
	            </section>
			          </aside>
	        </div>
	        </div>
	        </div>
	        <a class="kofi-fallback" id="kofiFallback" href="${escapeHtml(config.DONATION_PRIMARY_URL || 'https://ko-fi.com/retro76005')}" target="_blank" rel="noopener noreferrer">Support</a>
	      </main>
      <script>
			        const state={catalogs:[],events:[],event:null,streams:[],stream:null,multiView:false,multiItems:[],sportFilter:'all',statsOpen:false,statsTimer:null,statsAbort:null};
	        const qs=new URLSearchParams(location.search);
	        const el=(id)=>document.getElementById(id);
	        const esc=(value)=>String(value??'').replace(/[&<>"']/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
	        const timeLabel=(value)=>{const ms=Date.now()-new Date(value).getTime();if(!Number.isFinite(ms))return '';if(ms<60000)return 'now';if(ms<3600000)return Math.max(1,Math.round(ms/60000))+'m';if(ms<86400000)return Math.round(ms/3600000)+'h';return new Date(value).toLocaleDateString()};
	        const openPanel=(panelId)=>{document.querySelectorAll('.panel').forEach((panel)=>panel.classList.toggle('active',panel.id===panelId));document.querySelectorAll('.tab').forEach((tab)=>tab.classList.toggle('active',tab.dataset.panel===panelId))};
	        const withAccessKey=(path)=>{const url=new URL(path,location.origin);const key=qs.get('key');if(key)url.searchParams.set('key',key);return url.pathname+url.search};
        const api=async(path)=>{const res=await fetch(withAccessKey(path),{headers:{accept:'application/json'}});if(!res.ok)throw new Error(await res.text());return res.json()};
        const postApi=async(path,body)=>{const res=await fetch(withAccessKey(path),{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify(body)});const data=await res.json().catch(()=>({error:'Request failed'}));if(!res.ok){const error=new Error(data.error||'Request failed');error.status=res.status;error.data=data;throw error}return data};
        const withPlayerParams=(value)=>{try{const url=new URL(value,location.href);if(/(^|\\.)ok\\.ru$/i.test(url.hostname))return url.toString();[['autoplay','1'],['muted','0'],['mute','0'],['volume','1']].forEach(([key,paramValue])=>url.searchParams.set(key,paramValue));return url.toString()}catch{return value}};
	        const isWorldCupFootballEvent=(event)=>{
	          const text=[event?.name,event?.releaseInfo,event?.description,event?.tournament,event?.competition,...(Array.isArray(event?.genres)?event.genres:[])].join(' ').toLowerCase();
	          return /\\bworld\\s+cup\\b/.test(text)&&/\\b(?:fifa|football|soccer)\\b/.test(text);
	        };
	        const sportText=(event)=>[event?.name,event?.releaseInfo,event?.description,event?.tournament,event?.competition,...(Array.isArray(event?.genres)?event.genres:[])].join(' ').toLowerCase();
	        const matchesSportFilter=(event)=>{
	          const filter=state.sportFilter||'all';
	          if(filter==='all')return true;
	          const text=sportText(event);
	          if(filter==='football')return /\\b(football|soccer|fifa|uefa|premier|laliga|bundesliga|serie\\s*a|ligue\\s*1|afl|nfl|ncaa|eagles|swans|kangaroos|vikings|rams|defenders|kings)\\b/.test(text);
	          if(filter==='rugby')return /\\b(rugby|nrl|super\\s*rugby|warriors|sharks|raiders|eels|broncos|rabbitohs|storm|panthers)\\b/.test(text);
	          if(filter==='motorsport')return /\\b(motor|motorsport|formula|f1|f2|f3|motogp|nascar|indycar|rally|circuit|prix|sbk)\\b/.test(text);
	          if(filter==='combat')return /\\b(boxing|mma|ufc|wwe|wrestling|fight|bellator|one\\s*championship)\\b/.test(text);
	          if(filter==='more')return !['football','rugby','motorsport','combat'].some((name)=>{const previous=state.sportFilter;state.sportFilter=name;const matched=matchesSportFilter(event);state.sportFilter=previous;return matched});
	          return true;
	        };
        const initials=(value)=>String(value||'').split(/\\s+/).filter(Boolean).slice(0,2).map((part)=>part[0]?.toUpperCase()||'').join('')||'—';
        const renderStatsPanel=(stats)=>{
          const overlay=el('matchStatsOverlay');
          if(!stats?.worldCup){overlay.hidden=true;return}
          const home=stats.teams?.home?.name||'Home';
          const away=stats.teams?.away?.name||'Away';
          const crest=(team,name)=>team?.crest?'<img src="'+esc(team.crest)+'" alt="" loading="lazy">':esc(initials(name));
          const score=stats.score||{};
          const statRows=[
            ['Possession',stats.stats?.possession],
            ['Shots OT',stats.stats?.shotsOnTarget],
            ['Corners',stats.stats?.corners],
            ['Cards',stats.stats?.cards],
            ['Subs',stats.stats?.substitutions]
          ];
          overlay.innerHTML='<div class="match-stats-head"><div><strong>World Cup live stats</strong><span>'+esc(stats.updatedAt?new Date(stats.updatedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}):'')+'</span></div><button class="match-stats-close" type="button" aria-label="Close stats">×</button></div><div class="match-score"><div class="match-team"><div class="match-crest">'+crest(stats.teams?.home,home)+'</div><span>'+esc(home)+'</span></div><div class="match-scoreline"><strong>'+esc((score.home||'—')+' - '+(score.away||'—'))+'</strong><span>'+esc(stats.clock||'—')+'</span></div><div class="match-team"><div class="match-crest">'+crest(stats.teams?.away,away)+'</div><span>'+esc(away)+'</span></div></div><div class="match-stats-grid">'+statRows.map(([label,pair])=>'<div class="match-stat"><span>'+esc(pair?.home||'—')+'</span><small>'+esc(label)+'</small><span>'+esc(pair?.away||'—')+'</span></div>').join('')+'</div>'+(!stats.available?'<p class="match-stats-note">'+esc(stats.message||'Stats unavailable')+'</p>':'');
          overlay.querySelector('.match-stats-close').addEventListener('click',()=>toggleMatchStats(false));
        };
        const clearStatsPolling=()=>{
          if(state.statsTimer)clearInterval(state.statsTimer);
          state.statsTimer=null;
          if(state.statsAbort)state.statsAbort.abort();
          state.statsAbort=null;
        };
        const fetchMatchStats=async()=>{
          if(!state.event||!isWorldCupFootballEvent(state.event))return;
          if(state.statsAbort)state.statsAbort.abort();
          state.statsAbort=new AbortController();
          const params=new URLSearchParams({
            name:state.event.name||'',
            releaseInfo:state.event.releaseInfo||'',
            genres:(state.event.genres||[]).join(','),
            tournament:state.event.tournament||'',
            competition:state.event.competition||'',
            description:state.event.description||''
          });
          try{
            const res=await fetch(withAccessKey('/watch-together/api/football-stats/'+encodeURIComponent(state.event.id)+'?'+params.toString()),{headers:{accept:'application/json'},signal:state.statsAbort.signal});
            const data=await res.json();
            renderStatsPanel(data);
          }catch(error){
            if(error?.name!=='AbortError')renderStatsPanel({worldCup:true,available:false,message:'Stats unavailable',clock:'—',score:{home:'—',away:'—'},teams:{home:{name:'Home'},away:{name:'Away'}},stats:{possession:{home:'—',away:'—'},shotsOnTarget:{home:'—',away:'—'},corners:{home:'—',away:'—'},cards:{home:'—',away:'—'},substitutions:{home:'—',away:'—'}}});
          }
        };
        const toggleMatchStats=(open=!state.statsOpen)=>{
          state.statsOpen=Boolean(open);
          el('matchStatsOverlay').hidden=!state.statsOpen;
          if(!state.statsOpen){clearStatsPolling();return}
          clearStatsPolling();
          fetchMatchStats();
          state.statsTimer=setInterval(fetchMatchStats,45000);
        };
        const refreshStatsForEvent=()=>{
          const eligible=isWorldCupFootballEvent(state.event);
          el('matchStatsToggle').hidden=!eligible;
          if(!eligible){state.statsOpen=false;el('matchStatsOverlay').hidden=true;clearStatsPolling();}
        };
        const mountStreamGate=(target,stream)=>{
          target.replaceChildren();
          const gate=document.createElement('div');
          gate.className='player-gate';
          gate.innerHTML='<div class="player-gate-card"><button class="play-gate-btn" type="button" aria-label="Play">▶</button></div>';
          gate.querySelector('button').addEventListener('click',()=>{
            const frame=document.createElement('iframe');
            frame.allow='autoplay; fullscreen; encrypted-media; picture-in-picture';
            frame.allowFullscreen=true;
            frame.referrerPolicy='strict-origin-when-cross-origin';
            if(/^https?:\\/\\/(?:www\\.)?ok\\.ru\\/videoembed\\//i.test(String(stream.embedUrl||''))){
              frame.sandbox='allow-forms allow-pointer-lock allow-same-origin allow-scripts';
            }
            frame.src=withPlayerParams(stream.embedUrl);
            target.replaceChildren(frame);
          },{once:true});
          target.appendChild(gate);
        };
        const setPlayer=(stream)=>{
          const player=el('player');
          if(!stream?.embedUrl){player.innerHTML='<div class="empty"><strong>No source</strong><span>Try another event.</span></div>';el('statusLine').textContent='No source available';return}
          if(state.multiView){addMultiItem(state.event,stream);return}
          player.classList.remove('is-multiview');
          mountStreamGate(player,stream);
          el('nowTitle').textContent=state.event?.name||'Live event';
	          el('nowMeta').textContent=[stream.source?.toUpperCase(),stream.hd?'HD':'',stream.language||'',stream.viewers?stream.viewers+' watching':''].filter(Boolean).join(' / ');
	          el('statusLine').textContent=[stream.source?.toUpperCase(),stream.hd?'HD':'Live'].filter(Boolean).join(' / ');
          qs.set('event',state.event.id);qs.set('source',stream.id);history.replaceState(null,'','/watch-together?'+qs.toString());
        };
        const renderMultiView=()=>{
          const player=el('player');
          el('multiViewToggle').classList.toggle('active-mode',state.multiView);
          if(!state.multiView){player.classList.remove('is-multiview');if(state.stream)setPlayer(state.stream);return}
          player.classList.add('is-multiview');
          player.replaceChildren();
          if(!state.multiItems.length){player.innerHTML='<div class="empty"><strong>Multiview</strong><span>Select events or sources to add up to 4 streams.</span></div>';return}
          state.multiItems.slice(0,4).forEach((item)=>{
            const tile=document.createElement('div');
            tile.className='multi-tile';
            tile.dataset.key=item.key;
            const sourceLabel=[item.stream?.source?.toUpperCase(),item.stream?.streamNo?'#'+item.stream.streamNo:'',item.stream?.hd?'HD':''].filter(Boolean).join(' ');
            tile.innerHTML='<div class="multi-title"><span>'+esc(item.event?.name||'Live event')+'</span><strong class="multi-source">'+esc(sourceLabel||'LIVE')+'</strong><button class="multi-close" type="button" aria-label="Remove">×</button></div><div class="multi-body"></div>';
            tile.querySelector('.multi-close').addEventListener('click',()=>{state.multiItems=state.multiItems.filter((entry)=>entry.key!==item.key);renderMultiView()});
            player.appendChild(tile);
            mountStreamGate(tile.querySelector('.multi-body'),item.stream);
          });
        };
        const addMultiItem=(event,stream)=>{
          if(!event?.id||!stream?.embedUrl)return;
          const key=event.id;
          state.multiItems=state.multiItems.filter((item)=>item.key!==key);
          state.multiItems.unshift({key,event:{id:event.id,name:event.name},stream});
          state.multiItems=state.multiItems.slice(0,4);
          renderMultiView();
          el('nowTitle').textContent='Multiview';
          el('nowMeta').textContent=state.multiItems.length+' streams loaded';
          el('statusLine').textContent='Multiview / '+state.multiItems.length+' streams';
        };
	        const renderEvents=()=>{
	          const box=el('events');
	          const visibleEvents=state.events.filter(matchesSportFilter);
	          el('eventCount').textContent=visibleEvents.length ? visibleEvents.length+' live' : 'Empty';
	          el('heroCount').textContent=state.events.length ? state.events.length+' events' : 'No events';
	          if(!state.events.length){box.innerHTML='<div class="empty">No events in this catalog.</div>';return}
	          if(!visibleEvents.length){box.innerHTML='<div class="empty"><strong>No '+esc(state.sportFilter)+' events here.</strong><span>Try All, Today, or Popular.</span></div>';return}
	          box.innerHTML=visibleEvents.map((event)=>'<button class="event '+(state.event?.id===event.id?'active':'')+'" data-id="'+esc(event.id)+'"><strong>'+esc(event.name)+'</strong><span>'+esc([event.releaseInfo,event.genres?.filter((g)=>g!=='Sports').join(', ')].filter(Boolean).join(' / '))+'</span></button>').join('');
	          box.querySelectorAll('.event').forEach((btn)=>btn.addEventListener('click',()=>loadStreams(btn.dataset.id)));
	        };
        const renderStreams=()=>{
          const box=el('streams');
          if(!state.streams.length){box.innerHTML='<h3>Sources</h3><div class="empty">No sources for this event.</div>';return}
	          box.innerHTML='<h3>Sources</h3>'+state.streams.map((stream)=>'<button class="stream-btn '+(state.stream?.id===stream.id?'active':'')+'" data-id="'+esc(stream.id)+'"><span class="quality">'+esc(stream.source.toUpperCase()+' #'+stream.streamNo+' '+(stream.hd?'HD':''))+'</span><span class="viewer">'+esc(stream.viewers?stream.viewers+' watching':(stream.language||'Live'))+'</span></button>').join('');
          box.querySelectorAll('.stream-btn').forEach((btn)=>btn.addEventListener('click',()=>{state.stream=state.streams.find((s)=>s.id===btn.dataset.id);renderStreams();setPlayer(state.stream)}));
        };
        const setCatalogValue=(id)=>{
          const catalog=state.catalogs.find((entry)=>entry.id===id)||state.catalogs[0];
          if(!catalog)return;
          el('catalog').value=catalog.id;
          el('catalogLabel').textContent=catalog.name.replace(/^Sports Events:\s*/,'');
          el('catalogMenu').querySelectorAll('.catalog-option').forEach((option)=>option.classList.toggle('active',option.dataset.id===catalog.id));
        };
        const closeCatalogMenu=()=>{el('catalogPicker').classList.remove('open');el('catalogButton').setAttribute('aria-expanded','false')};
        const openCatalogMenu=()=>{el('catalogPicker').classList.add('open');el('catalogButton').setAttribute('aria-expanded','true')};
        const renderCatalogMenu=()=>{
          el('catalogMenu').innerHTML=state.catalogs.map((catalog)=>'<button class="catalog-option" type="button" role="option" data-id="'+esc(catalog.id)+'">'+esc(catalog.name.replace(/^Sports Events:\\s*/,''))+'</button>').join('');
          el('catalogMenu').querySelectorAll('.catalog-option').forEach((option)=>option.addEventListener('click',()=>{setCatalogValue(option.dataset.id);closeCatalogMenu();el('catalog').dispatchEvent(new Event('change'))}));
        };
        const loadCatalogs=async()=>{
          const data=await api('/watch-together/api/catalogs');
          state.catalogs=data.catalogs||[];
          renderCatalogMenu();
          const requested=qs.get('catalog');
          setCatalogValue(requested && state.catalogs.some((c)=>c.id===requested)?requested:(state.catalogs[0]?.id||'streamed-events-live'));
        };
        const loadEvents=async()=>{
          el('events').innerHTML='<div class="empty">Loading events...</div>';
          el('eventCount').textContent='Loading';
          el('heroCount').textContent='Loading';
          const catalog=el('catalog').value||'streamed-events-live';
          qs.set('catalog',catalog);
          const search=el('search').value.trim();
          const data=await api('/watch-together/api/events?catalog='+encodeURIComponent(catalog)+'&search='+encodeURIComponent(search));
          state.events=data.events||[]; renderEvents();
          const requested=qs.get('event');
          if(requested && state.events.some((event)=>event.id===requested)) await loadStreams(requested, qs.get('source'));
        };
        const loadStreams=async(id, preferredStreamId='')=>{
          state.event=state.events.find((event)=>event.id===id)||{id,name:'Live event'};
          state.stream=null; state.streams=[]; renderEvents(); renderStreams();
          refreshStatsForEvent();
          el('statusLine').textContent='Loading sources';
          el('streams').innerHTML='<h3>Sources</h3><div class="empty">Loading sources...</div>';
          const data=await api('/watch-together/api/streams/'+encodeURIComponent(id));
          state.streams=data.streams||[];
          state.stream=state.streams.find((stream)=>stream.id===preferredStreamId)||state.streams[0]||null;
          renderStreams(); setPlayer(state.stream);
          refreshStatsForEvent();
        };
        el('catalogButton').addEventListener('click',()=>el('catalogPicker').classList.contains('open')?closeCatalogMenu():openCatalogMenu());
        document.addEventListener('click',(event)=>{if(!el('catalogPicker').contains(event.target))closeCatalogMenu()});
        el('catalogButton').addEventListener('keydown',(event)=>{if(event.key==='Escape')closeCatalogMenu();if(event.key==='ArrowDown'||event.key==='Enter'||event.key===' '){event.preventDefault();openCatalogMenu();el('catalogMenu').querySelector('.catalog-option')?.focus()}});
        el('catalogMenu').addEventListener('keydown',(event)=>{const options=[...el('catalogMenu').querySelectorAll('.catalog-option')];const index=options.indexOf(document.activeElement);if(event.key==='Escape'){closeCatalogMenu();el('catalogButton').focus()}if(event.key==='ArrowDown'){event.preventDefault();(options[index+1]||options[0])?.focus()}if(event.key==='ArrowUp'){event.preventDefault();(options[index-1]||options.at(-1))?.focus()}});
        el('catalog').addEventListener('change',()=>{qs.delete('event');qs.delete('source');history.replaceState(null,'','/watch-together?'+qs.toString());loadEvents().catch(showError)});
        el('searchBtn').addEventListener('click',()=>loadEvents().catch(showError));
        el('search').addEventListener('keydown',(event)=>{if(event.key==='Enter')loadEvents().catch(showError)});
	        el('reloadFrame').addEventListener('click',()=>setPlayer(state.stream));
        el('matchStatsToggle').addEventListener('click',()=>toggleMatchStats(!state.statsOpen));
        el('multiViewToggle').addEventListener('click',()=>{state.multiView=!state.multiView;if(state.multiView&&state.event&&state.stream)addMultiItem(state.event,state.stream);else renderMultiView()});
	        el('fullscreenPlayer').addEventListener('click',()=>{const target=el('player');const request=target.requestFullscreen||target.webkitRequestFullscreen||target.msRequestFullscreen;if(request)Promise.resolve(request.call(target)).catch(()=>{})});
		        document.querySelectorAll('.tab').forEach((tab)=>tab.addEventListener('click',()=>openPanel(tab.dataset.panel)));
	        const setRailActive=(action)=>document.querySelectorAll('[data-rail]').forEach((item)=>item.classList.toggle('active',item.dataset.rail===action));
	        const switchCatalog=(id,action)=>{
	          if(state.catalogs.some((catalog)=>catalog.id===id)){
	            setCatalogValue(id);
	            qs.delete('event');qs.delete('source');
	            history.replaceState(null,'','/watch-together?'+qs.toString());
	            loadEvents().catch(showError);
	          }
	          setRailActive(action);
	        };
	        document.querySelectorAll('[data-rail]').forEach((item)=>item.addEventListener('click',()=>{
	          const action=item.dataset.rail;
	          if(action==='live'){setRailActive(action);el('player').scrollIntoView({behavior:'smooth',block:'center'});return}
	          if(action==='events'){setRailActive(action);openPanel('eventsPanel');document.querySelector('.side')?.scrollIntoView({behavior:'smooth',block:'nearest'});return}
	          if(action==='today'){openPanel('eventsPanel');switchCatalog('streamed-events-today',action);return}
	          if(action==='popular'){openPanel('eventsPanel');switchCatalog('streamed-events-popular',action);return}
	          if(action==='multi'){setRailActive(action);el('multiViewToggle').click();el('player').scrollIntoView({behavior:'smooth',block:'center'});return}
	        }));
	        document.querySelectorAll('[data-sport-filter]').forEach((button)=>button.addEventListener('click',()=>{
	          state.sportFilter=button.dataset.sportFilter||'all';
	          document.querySelectorAll('[data-sport-filter]').forEach((entry)=>entry.classList.toggle('active',entry===button));
	          if(state.sportFilter!=='all'&&el('catalog').value!=='streamed-events-today'&&state.catalogs.some((catalog)=>catalog.id==='streamed-events-today')){
	            setCatalogValue('streamed-events-today');
	            qs.set('catalog','streamed-events-today');qs.delete('event');qs.delete('source');
	            history.replaceState(null,'','/watch-together?'+qs.toString());
	            loadEvents().catch(showError);
	          }else{
	            renderEvents();
	          }
	          openPanel('eventsPanel');
	        }));
		        const showError=(error)=>{el('events').innerHTML='<div class="empty"><strong>Load failed</strong><span>'+esc(String(error.message||error).slice(0,220))+'</span></div>'};
        const getLiveSessionId=()=>{
          try{
            const existing=localStorage.getItem('nebula-watch-live-session');
            if(existing)return existing;
            const created=(crypto.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(16).slice(2)).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);
            localStorage.setItem('nebula-watch-live-session',created);
            return created;
          }catch{
            if(!window.__nebulaLiveSessionId)window.__nebulaLiveSessionId=(String(Date.now())+'-'+Math.random().toString(16).slice(2)).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);
            return window.__nebulaLiveSessionId;
          }
        };
        const updateLiveCount=(count)=>{
          const parsed=Number.parseInt(count,10);
          if(!Number.isFinite(parsed)||parsed<1)return;
          el('liveCountText').textContent=parsed+' live';
          el('liveCountBadge').classList.add('is-ready');
        };
        const sendLiveHeartbeat=async()=>{
          try{
            const data=await api('/watch-together/api/live-count?sessionId='+encodeURIComponent(getLiveSessionId()));
            updateLiveCount(data.count);
          }catch{}
        };
        let deferredInstallPrompt=null;
        const installButton=el('installApp');
        const standalone=window.matchMedia?.('(display-mode: standalone)').matches||window.navigator.standalone;
        const showIosInstallHint=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)&&!standalone;
        if(showIosInstallHint()){
          installButton.classList.add('is-ready');
          installButton.addEventListener('click',()=>alert('Tap Share, then Add to Home Screen.'));
        }
        window.addEventListener('beforeinstallprompt',(event)=>{
          event.preventDefault();
          deferredInstallPrompt=event;
          installButton.classList.add('is-ready');
        });
        installButton.addEventListener('click',async()=>{
          if(!deferredInstallPrompt)return;
          deferredInstallPrompt.prompt();
          await deferredInstallPrompt.userChoice.catch(()=>null);
          deferredInstallPrompt=null;
          installButton.classList.remove('is-ready');
        });
        window.addEventListener('appinstalled',()=>installButton.classList.remove('is-ready'));
        if('serviceWorker' in navigator){
          window.addEventListener('load',()=>navigator.serviceWorker.register('/watch-together/sw.js',{scope:'/watch-together'}).catch(()=>{}));
        }
        sendLiveHeartbeat();
        setInterval(sendLiveHeartbeat,25000);
        loadCatalogs().then(loadEvents).catch(showError);
	      </script>
	      <script>
	        (() => {
	          if (typeof window === 'undefined' || window.__nebulaKofiWidgetLoaded) return;
	          window.__nebulaKofiWidgetLoaded = true;
		          const drawWidget = () => {
		            if (!window.kofiWidgetOverlay?.draw) return;
		            window.kofiWidgetOverlay.draw('${kofiPageName}', {
		              type: 'floating-chat',
		              'floating-chat.donateButton.text': 'Support',
			              'floating-chat.donateButton.background-color': '#e8113b',
			              'floating-chat.donateButton.text-color': '#ffffff'
		            });
		            document.getElementById('kofiFallback')?.classList.add('is-hidden');
		          };
	          const existing = document.querySelector('script[data-nebula-kofi-widget]');
	          if (existing) {
	            existing.addEventListener('load', drawWidget, { once: true });
	            drawWidget();
	            return;
	          }
	          const script = document.createElement('script');
	          script.src = 'https://storage.ko-fi.com/cdn/scripts/overlay-widget.js';
	          script.async = true;
	          script.defer = true;
	          script.dataset.nebulaKofiWidget = 'true';
	          script.addEventListener('load', drawWidget, { once: true });
	          document.body.appendChild(script);
	        })();
	      </script>
	    `}
  </body>
</html>`;
};

const parseBasicAuth = (headerValue) => {
  if (!headerValue || !headerValue.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return null;
  }
};

const parseCookies = (cookieHeader) => {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');

      if (separatorIndex === -1) {
        return cookies;
      }

      const key = part.slice(0, separatorIndex);
      const value = part.slice(separatorIndex + 1);
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
};

const createAdminSessionToken = () => {
  const payload = Buffer.from(JSON.stringify({
    username: config.ADMIN_USERNAME,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', `${config.ADMIN_USERNAME}:${config.ADMIN_PASSWORD}`)
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
};

const verifyAdminSessionToken = (token) => {
  if (!token || !token.includes('.')) {
    return false;
  }

  const [payload, signature] = token.split('.', 2);
  const expectedSignature = crypto
    .createHmac('sha256', `${config.ADMIN_USERNAME}:${config.ADMIN_PASSWORD}`)
    .update(payload)
    .digest('base64url');

  if (signature.length !== expectedSignature.length) {
    return false;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.username === config.ADMIN_USERNAME && Number(decoded.expiresAt) > Date.now();
  } catch {
    return false;
  }
};

const setAdminSessionCookie = (req, res) => {
  const cookieParts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(createAdminSessionToken())}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`
  ];

  if (req.secure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
};

const clearAdminSessionCookie = (res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
};

const setSupporterSessionCookie = (req, res, token) => {
  const cookieParts = [
    `${SUPPORTER_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${90 * 24 * 60 * 60}`
  ];

  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
};

const clearSupporterSessionCookie = (res) => {
  res.setHeader('Set-Cookie', `${SUPPORTER_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
};

const setSportsSessionCookie = (req, res, token) => {
  const cookieParts = [
    `${SPORTS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/sports',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${90 * 24 * 60 * 60}`
  ];

  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
};

const clearSportsSessionCookie = (res) => {
  res.setHeader('Set-Cookie', `${SPORTS_COOKIE_NAME}=; Path=/sports; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
};

const setWatchChatCookie = (req, res, token) => {
  const cookieParts = [
    `${WATCH_CHAT_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/watch-together',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${365 * 24 * 60 * 60}`
  ];

  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
};

const parseDashboardJson = (value) => {
  if (!String(value || '').trim()) {
    return {};
  }
  const parsed = JSON.parse(String(value));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config JSON must be an object');
  }
  return parsed;
};

const createSupporterRecordFromAccount = (account) => account ? {
  active: true,
  tier: account.tier || 'supporter',
  label: account.label || account.username || 'Supporter',
  expiresAt: account.lifetime ? null : account.expiresAt,
  lifetime: Boolean(account.lifetime),
  codeHash: account.codeHash
} : null;

const getClientAddress = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return String(req.ip || req.socket?.remoteAddress || 'unknown').trim();
};

const getClientSubnet = (req) => {
  const ip = getClientAddress(req).replace(/^::ffff:/u, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(ip)) {
    return ip.split('.').slice(0, 3).join('.');
  }
  const parts = ip.split(':').filter(Boolean);
  return parts.length ? parts.slice(0, 4).join(':') : ip;
};

const createRateLimiter = ({ windowMs, limit, name, matcher }) => {
  const buckets = new Map();
  let requestCount = 0;

  const pruneBuckets = (now) => {
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }

    if (buckets.size <= config.RATE_LIMIT_MAX_BUCKETS) {
      return;
    }

    const overflowCount = buckets.size - config.RATE_LIMIT_MAX_BUCKETS;
    const oldestKeys = Array.from(buckets.entries())
      .sort((left, right) => left[1].resetAt - right[1].resetAt)
      .slice(0, overflowCount)
      .map(([key]) => key);

    for (const key of oldestKeys) {
      buckets.delete(key);
    }
  };

  return (req, res, next) => {
    if (!matcher(req)) {
      next();
      return;
    }

    const now = Date.now();
    requestCount += 1;

    if (requestCount % 100 === 0 || buckets.size > config.RATE_LIMIT_MAX_BUCKETS) {
      pruneBuckets(now);
    }

    const key = `${name}:${getClientAddress(req)}`;
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      next();
      return;
    }

    current.count += 1;

    if (current.count <= limit) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));

    logger.warn('request rate limited', {
      limiter: name,
      path: req.path,
      ip: getClientAddress(req),
      retryAfterSeconds
    });

    const acceptsHtml = String(req.headers.accept || '').includes('text/html');

    if (acceptsHtml) {
      res.status(429).type('html').send('Too many requests. Please try again shortly.');
      return;
    }

    res.status(429).json({
      error: 'Too many requests',
      retryAfterSeconds
    });
  };
};

const BOT_USER_AGENT_PATTERN = /\b(?:ahrefs|aiohttp|axios|baiduspider|bingbot|bot|bytespider|claudebot|crawler|curl|discordbot|facebookexternalhit|googlebot|gptbot|go-http-client|headless|httpx|insomnia|libwww-perl|node-fetch|petalbot|phantomjs|playwright|postmanruntime|puppeteer|python-requests|python-urllib|scraper|selenium|semrush|slackbot|spider|undici|wget|yandex)\b/iu;
const BOT_STRICT_USER_AGENT_PATTERN = /(?:headless|phantomjs|playwright|puppeteer|selenium)/iu;
const BOT_SOFT_CLIENT_USER_AGENT_PATTERN = /\b(?:aiohttp|aiostreams|aiostrms|axios|curl|dalvik|exoplayer|go-http-client|httpx|insomnia|libwww-perl|node-fetch|okhttp|postmanruntime|python-requests|python-urllib|stremioshell|stremio-apple|strmr|undici|wget)\b/iu;

const isStremioManifestPath = (pathName) =>
  pathName === '/manifest.json'
  || pathName === '/stremio/manifest.json'
  || pathName.endsWith('/manifest.json')
  || pathName.endsWith('/stremio/manifest.json')
  || /^\/private\/[^/]+$/u.test(pathName)
  || /^\/configured\/[^/]+(?:\/[^/]+){0,2}$/u.test(pathName);

const isBotProtectionIgnoredPath = (pathName) =>
  pathName === '/health'
  || pathName === '/configure/private-config'
  || pathName === '/configure/validate-iptv'
  || pathName === '/configure/supporter-profile'
  || pathName === '/dashboard'
  || pathName.startsWith('/dashboard/')
  || pathName.startsWith('/supporter/')
  || pathName.startsWith('/u/')
  || pathName.startsWith('/sports/i/')
  || pathName === '/api/vidking/embed'
  || pathName === '/api/movie/embed'
  || pathName === '/api/movie/embed-providers'
  || pathName === '/watch-together/api/chat'
  || pathName === '/watch-together/api/live-count'
  || pathName === '/webhooks/kofi'
  || pathName === '/webhooks/ko-fi'
  || pathName === '/webhooks/smtp2go'
  || pathName.startsWith('/admin')
  || pathName.startsWith('/assets/')
  || /^\/private\/[^/]+\/(?:stalker|xtream|nflix|streamed)\//u.test(pathName)
  || pathName === '/favicon.ico'
  || isStremioManifestPath(pathName);

const isAddonJsonPath = (pathName) =>
  pathName === '/manifest.json'
  || pathName === '/stremio/manifest.json'
  || pathName.startsWith('/stream/')
  || pathName.startsWith('/stremio/stream/')
  || pathName.startsWith('/catalog/')
  || pathName.startsWith('/stremio/catalog/')
  || pathName.startsWith('/meta/')
  || pathName.startsWith('/stremio/meta/')
  || pathName.startsWith('/preview/')
  || pathName.startsWith('/stremio/preview/')
  || (pathName.startsWith('/configured/') && (pathName.includes('/stream/') || pathName.includes('/catalog/') || pathName.includes('/meta/') || pathName.includes('/preview/') || pathName.endsWith('/manifest.json')))
  || (pathName.startsWith('/sports/i/') && (pathName.includes('/stream/') || pathName.includes('/catalog/') || pathName.includes('/meta/') || pathName.endsWith('/manifest.json')))
  || (pathName.startsWith('/private/') && (pathName.includes('/stream/') || pathName.includes('/catalog/') || pathName.includes('/meta/') || pathName.includes('/preview/') || pathName.endsWith('/manifest.json')));

const isAddonJsonRequest = (req, pathName) => {
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return false;
  }

  if (!isAddonJsonPath(pathName) || (!pathName.endsWith('.json') && !pathName.endsWith('/manifest.json'))) {
    return false;
  }

  const accepts = String(req.headers.accept || '').toLowerCase();
  const fetchDest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();

  return fetchDest !== 'document' && !accepts.includes('text/html');
};

const isRegisteredPlaybackRequest = (req, pathName) => {
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return false;
  }

  if (pathName !== '/stream') {
    return false;
  }

  const sourceToken = typeof req.query?.sourceToken === 'string' ? req.query.sourceToken.trim() : '';
  const sourceId = typeof req.query?.sourceId === 'string' ? req.query.sourceId.trim() : '';

  return sourceToken.length >= 24 || sourceId.length >= 12;
};

const isExpensiveBotProtectionPath = (pathName) =>
  pathName === '/stream'
  || pathName === '/http-stream'
  || pathName === '/stream/http'
  || pathName === '/stream/torrent'
  || /^\/private\/[^/]+\/(?:stalker|xtream|nflix|streamed)\//u.test(pathName)
  || pathName.startsWith('/stream/')
  || pathName.startsWith('/stremio/stream/')
  || (pathName.includes('/catalog/') && pathName.includes('/search='))
  || pathName.startsWith('/preview/')
  || pathName.startsWith('/stremio/preview/')
  || (pathName.startsWith('/configured/') && (pathName.includes('/stream/') || pathName.includes('/preview/')))
  || (pathName.startsWith('/private/') && (pathName.includes('/stream/') || pathName.includes('/preview/')))
  || pathName.startsWith('/providers/');

const isAllowedBotProtectionClient = (userAgent) => {
  const normalized = String(userAgent || '').toLowerCase();

  return normalized.includes('stremio')
    || normalized.includes('stremioshell')
    || normalized.includes('stremio-apple')
    || normalized.includes('aiostreams')
    || normalized.includes('aiostrms')
    || normalized.includes('dalvik/')
    || normalized.includes('exoplayer')
    || normalized.includes('okhttp/')
    || normalized.includes('strmr/')
    || normalized.includes('qtwebengine/')
    || normalized.includes('tizen')
    || normalized.includes('mozilla/')
    || normalized.includes('applewebkit/')
    || normalized.includes('chrome/')
    || normalized.includes('safari/')
    || normalized.includes('firefox/');
};

const isLikelyAddonDataClient = (req, pathName, userAgent) => {
  if ((req.method || 'GET').toUpperCase() !== 'GET' || !isExpensiveBotProtectionPath(pathName)) {
    return false;
  }

  const normalizedUserAgent = String(userAgent || '').trim().toLowerCase();
  const accepts = String(req.headers.accept || '').toLowerCase();
  const fetchDest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  const knownPlaybackClient = normalizedUserAgent.includes('stremio')
    || normalizedUserAgent.includes('stremioshell')
    || normalizedUserAgent.includes('stremio-apple')
    || normalizedUserAgent.includes('aiostreams')
    || normalizedUserAgent.includes('aiostrms')
    || normalizedUserAgent.includes('dalvik/')
    || normalizedUserAgent.includes('exoplayer')
    || normalizedUserAgent.includes('okhttp/')
    || normalizedUserAgent.includes('strmr/')
    || normalizedUserAgent.includes('qtwebengine/')
    || normalizedUserAgent.includes('webappmanager')
    || normalizedUserAgent.includes('tizen')
    || normalizedUserAgent.includes('web0s');
  const isAddonDataPath = pathName.endsWith('.json')
    || pathName.endsWith('.m3u8')
    || pathName === '/stream'
    || pathName === '/http-stream'
    || pathName === '/stream/http'
    || pathName === '/stream/torrent'
    || pathName.includes('/stream/')
    || pathName.includes('/rogplay/live/')
    || pathName.includes('/preview/')
    || pathName.endsWith('/manifest.json');
  const wantsStructuredResponse = accepts.includes('application/json')
    || accepts.includes('text/plain')
    || accepts.includes('*/*')
    || (!accepts && isAddonDataPath)
    || knownPlaybackClient;
  const isHtmlNavigation = accepts.includes('text/html') && !wantsStructuredResponse;

  return wantsStructuredResponse
    && !isHtmlNavigation
    && isAddonDataPath
    && fetchDest !== 'document'
    && !normalizedUserAgent.includes('mozilla/5.0 (compatible;');
};

const sendBotProtectionResponse = (req, res, retryAfterSeconds) => {
  if (retryAfterSeconds) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }

  const acceptsHtml = String(req.headers.accept || '').includes('text/html');

  if (acceptsHtml) {
    res.status(403).type('html').send('Access blocked.');
    return;
  }

  res.status(403).json({
    error: 'Forbidden'
  });
};

const sendBotThrottleResponse = (req, res, retryAfterSeconds) => {
  if (retryAfterSeconds) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }

  const acceptsHtml = String(req.headers.accept || '').includes('text/html');

  if (acceptsHtml) {
    res.status(429).type('html').send('Too many requests. Try again shortly.');
    return;
  }

  res.status(429).json({
    error: 'Too Many Requests'
  });
};

const createMemoryFuse = (streamManager) => (req, res, next) => {
  const heapUsagePercent = getHeapUsagePercent();

  if (heapUsagePercent < config.MEMORY_GUARD_PRESSURE_PERCENT) {
    next();
    return;
  }

  streamManager.handleMemoryPressure({
    critical: heapUsagePercent >= config.MEMORY_GUARD_CRITICAL_PERCENT
  });
  streamManager.enableLoadShedding({
    durationMs: config.MEMORY_GUARD_SHED_SECONDS * 1000,
    reason: 'route-heap-pressure'
  });

  const pathName = req.path || '';
  logger.warn('memory fuse short-circuited addon route', {
    path: pathName,
    heapPressurePercent: Number(heapUsagePercent.toFixed(1)),
    pressurePercent: config.MEMORY_GUARD_PRESSURE_PERCENT,
    criticalPercent: config.MEMORY_GUARD_CRITICAL_PERCENT
  });

  if (pathName.includes('/stream/') || pathName.endsWith('/stream') || pathName === '/stream') {
    res.setHeader('X-NebulaStreams-Mode', 'memory-fuse');
    res.json({ streams: [] });
    return;
  }

  if (pathName.includes('/catalog/')) {
    res.setHeader('X-NebulaStreams-Mode', 'memory-fuse');
    res.json({ metas: [] });
    return;
  }

  if (pathName.includes('/meta/')) {
    res.setHeader('X-NebulaStreams-Mode', 'memory-fuse');
    res.json({ meta: null });
    return;
  }

  next();
};

const createBotProtection = () => {
  const clients = new Map();
  let requestCount = 0;

  const windowMs = config.BOT_PROTECTION_WINDOW_SECONDS * 1000;
  const blockMs = config.BOT_PROTECTION_BLOCK_SECONDS * 1000;

  const pruneClients = (now) => {
    for (const [key, state] of clients.entries()) {
      if (state.resetAt <= now && state.blockedUntil <= now) {
        clients.delete(key);
      }
    }

    if (clients.size <= config.BOT_PROTECTION_MAX_TRACKED_CLIENTS) {
      return;
    }

    const overflowCount = clients.size - config.BOT_PROTECTION_MAX_TRACKED_CLIENTS;
    const oldestKeys = Array.from(clients.entries())
      .sort((left, right) => Math.min(left[1].resetAt, left[1].blockedUntil) - Math.min(right[1].resetAt, right[1].blockedUntil))
      .slice(0, overflowCount)
      .map(([key]) => key);

    for (const key of oldestKeys) {
      clients.delete(key);
    }
  };

  const getClientState = (key, now) => {
    const current = clients.get(key);

    if (current && current.resetAt > now) {
      return current;
    }

    const nextState = {
      expensiveCount: 0,
      suspiciousCount: 0,
      resetAt: now + windowMs,
      blockedUntil: current?.blockedUntil && current.blockedUntil > now ? current.blockedUntil : 0
    };

    clients.set(key, nextState);
    return nextState;
  };

  return (req, res, next) => {
    if (
      !config.BOT_PROTECTION_ENABLED
      || req.method === 'OPTIONS'
      || isBotProtectionIgnoredPath(req.path)
      || isAddonJsonRequest(req, req.path || '')
      || isRegisteredPlaybackRequest(req, req.path || '')
    ) {
      next();
      return;
    }

    const pathName = req.path || '';
    const isExpensivePath = isExpensiveBotProtectionPath(pathName);
    const userAgent = String(req.headers['user-agent'] || '').trim();
    const normalizedUserAgent = userAgent.toLowerCase();
    const trustedStremioClient = normalizedUserAgent.includes('stremio/');
    const likelyAddonDataClient = isLikelyAddonDataClient(req, pathName, userAgent);
    const strictSuspiciousUserAgent = BOT_STRICT_USER_AGENT_PATTERN.test(userAgent);
    const suspiciousUserAgent = strictSuspiciousUserAgent
      || (BOT_USER_AGENT_PATTERN.test(userAgent) && !isAllowedBotProtectionClient(userAgent));
    const softClientUserAgent = BOT_SOFT_CLIENT_USER_AGENT_PATTERN.test(userAgent);
    const softAddonClient = likelyAddonDataClient && softClientUserAgent && !strictSuspiciousUserAgent;
    const shouldTreatAsSuspicious = suspiciousUserAgent && !softAddonClient;

    if (trustedStremioClient && !suspiciousUserAgent) {
      next();
      return;
    }

    if (!isExpensivePath && !suspiciousUserAgent) {
      next();
      return;
    }

    const now = Date.now();
    requestCount += 1;

    if (requestCount % 100 === 0 || clients.size > config.BOT_PROTECTION_MAX_TRACKED_CLIENTS) {
      pruneClients(now);
    }

    const ip = getClientAddress(req);
    const state = getClientState(ip, now);

    if (state.blockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.blockedUntil - now) / 1000));
      if (likelyAddonDataClient && !strictSuspiciousUserAgent) {
        const shortenedBlockedUntil = Math.min(state.blockedUntil, now + 30_000);
        if (shortenedBlockedUntil !== state.blockedUntil) {
          state.blockedUntil = shortenedBlockedUntil;
        }

        logger.warn('bot protection rate limited request', {
          reason: 'temporary-ip-throttle',
          path: pathName,
          ip,
          retryAfterSeconds: Math.max(5, Math.min(30, Math.ceil((state.blockedUntil - now) / 1000))),
          userAgent: userAgent.slice(0, 160)
        });
        sendBotThrottleResponse(req, res, Math.max(5, Math.min(30, Math.ceil((state.blockedUntil - now) / 1000))));
        return;
      }

      logger.warn('bot protection blocked request', {
        reason: 'temporary-ip-block',
        path: pathName,
        ip,
        retryAfterSeconds,
        userAgent: userAgent.slice(0, 160)
      });
      sendBotProtectionResponse(req, res, retryAfterSeconds);
      return;
    }

    if (isExpensivePath) {
      state.expensiveCount += 1;
    }

    if (shouldTreatAsSuspicious) {
      state.suspiciousCount += 1;
    }

    const expensiveRequestLimit = likelyAddonDataClient
      ? Math.max(config.BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT * 8, config.BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT + 60)
      : config.BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT;
    const overExpensiveLimit = state.expensiveCount > expensiveRequestLimit;
    const overSuspiciousLimit = state.suspiciousCount > config.BOT_PROTECTION_SUSPICIOUS_REQUEST_LIMIT;
    const instantScraperBlock = shouldTreatAsSuspicious && isExpensivePath;

    if (!overExpensiveLimit && !overSuspiciousLimit && !instantScraperBlock) {
      next();
      return;
    }

    if (likelyAddonDataClient && !strictSuspiciousUserAgent && (overExpensiveLimit || overSuspiciousLimit)) {
      const retryAfterSeconds = Math.max(5, Math.min(30, Math.ceil((state.resetAt - now) / 1000)));
      logger.warn('bot protection rate limited request', {
        reason: overSuspiciousLimit ? 'suspicious-client-throttle' : 'expensive-request-throttle',
        path: pathName,
        ip,
        expensiveCount: state.expensiveCount,
        expensiveRequestLimit,
        retryAfterSeconds,
        userAgent: userAgent.slice(0, 160)
      });
      sendBotThrottleResponse(req, res, retryAfterSeconds);
      return;
    }

    state.blockedUntil = now + blockMs;
    const reason = instantScraperBlock
      ? 'scraper-user-agent-on-expensive-route'
      : overSuspiciousLimit
        ? 'suspicious-user-agent-limit'
        : 'expensive-request-limit';

    logger.warn('bot protection blocked request', {
      reason,
      path: pathName,
      ip,
      expensiveCount: state.expensiveCount,
      suspiciousCount: state.suspiciousCount,
      retryAfterSeconds: config.BOT_PROTECTION_BLOCK_SECONDS,
      userAgent: userAgent.slice(0, 160)
    });

    sendBotProtectionResponse(req, res, config.BOT_PROTECTION_BLOCK_SECONDS);
  };
};

const startMemoryGuard = ({
  streamManager,
  providerService,
  imdbResolver,
  userTracker,
  sourceRegistry
}) => {
  if (!config.MEMORY_GUARD_ENABLED) {
    return null;
  }

  let running = false;
  let criticalStrikes = 0;
  const trimRuntime = ({ critical, reason }) => {
    streamManager.handleMemoryPressure({ critical });
    streamManager.enableLoadShedding({
      durationMs: config.MEMORY_GUARD_SHED_SECONDS * 1000,
      reason
    });
    providerService.handleMemoryPressure({ critical });
    imdbResolver.handleMemoryPressure({ critical });
    userTracker.handleMemoryPressure({ critical });
    sourceRegistry.handleMemoryPressure({ critical });
  };
  const runEmergencyCheck = () => {
    const processMemory = process.memoryUsage();
    const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
    const heapUsagePercent = heapLimitBytes > 0
      ? (processMemory.heapUsed / heapLimitBytes) * 100
      : 0;

    if (heapUsagePercent < config.MEMORY_GUARD_PRESSURE_PERCENT) {
      return;
    }

    const critical = heapUsagePercent >= config.MEMORY_GUARD_CRITICAL_PERCENT;
    trimRuntime({
      critical,
      reason: critical ? 'emergency-heap-critical' : 'emergency-heap-pressure'
    });

    logger.warn('memory guard emergency heap trim', {
      critical,
      heapPressurePercent: Number(heapUsagePercent.toFixed(1)),
      pressurePercent: config.MEMORY_GUARD_PRESSURE_PERCENT,
      criticalPercent: config.MEMORY_GUARD_CRITICAL_PERCENT,
      restartPercent: config.MEMORY_GUARD_RESTART_PERCENT,
      heapUsedBytes: processMemory.heapUsed,
      heapLimitBytes,
      processRssBytes: processMemory.rss
    });

    if (heapUsagePercent >= config.MEMORY_GUARD_RESTART_PERCENT) {
      logger.error('memory guard emergency restart before heap OOM', {
        heapPressurePercent: Number(heapUsagePercent.toFixed(1)),
        restartPercent: config.MEMORY_GUARD_RESTART_PERCENT,
        heapUsedBytes: processMemory.heapUsed,
        heapLimitBytes,
        processRssBytes: processMemory.rss
      });
      process.exit(1);
    }
  };
  const runCleanup = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      const memory = await getSystemMemorySnapshot();
      const processMemory = process.memoryUsage();
      const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
      const systemUsagePercent = memory.totalMemoryBytes > 0
        ? ((memory.totalMemoryBytes - memory.availableMemoryBytes) / memory.totalMemoryBytes) * 100
        : 0;
      const heapUsagePercent = heapLimitBytes > 0
        ? (processMemory.heapUsed / heapLimitBytes) * 100
        : 0;
      const minAvailableBytes = config.MEMORY_GUARD_MIN_AVAILABLE_MB * 1024 * 1024;
      const systemPressureActive = memory.availableMemoryBytes <= minAvailableBytes;
      const usagePercent = Math.max(systemPressureActive ? systemUsagePercent : 0, heapUsagePercent);

      if (usagePercent < config.MEMORY_GUARD_PRESSURE_PERCENT) {
        criticalStrikes = 0;
        return;
      }

      const critical = usagePercent >= config.MEMORY_GUARD_CRITICAL_PERCENT;
      criticalStrikes = critical ? criticalStrikes + 1 : 0;
      const before = {
        availableMemoryBytes: memory.availableMemoryBytes,
        usagePercent,
        systemUsagePercent,
        heapUsagePercent,
        heapLimitBytes,
        processMemory,
        streams: streamManager.getStats(),
        providers: providerService.getStats(),
        users: userTracker.getStats(),
        sourceRegistry: sourceRegistry.getStats()
      };

      trimRuntime({
        critical,
        reason: critical ? 'critical-memory-pressure' : 'memory-pressure'
      });

      logger.warn('memory guard trimmed runtime caches', {
        critical,
        pressurePercent: Number(usagePercent.toFixed(1)),
        systemPressurePercent: Number(systemUsagePercent.toFixed(1)),
        heapPressurePercent: Number(heapUsagePercent.toFixed(1)),
        thresholdPercent: config.MEMORY_GUARD_PRESSURE_PERCENT,
        criticalPercent: config.MEMORY_GUARD_CRITICAL_PERCENT,
        systemPressureActive,
        availableMemoryBytes: memory.availableMemoryBytes,
        heapUsedBytes: before.processMemory.heapUsed,
        heapLimitBytes,
        processRssBytes: before.processMemory.rss,
        stremioResultCacheEntries: before.streams.stremioResultCacheEntries,
        hubCloudCacheEntries: before.streams.hubCloudCacheEntries,
        providerCacheEntries: before.providers.inMemoryCacheEntries,
        rawUniqueClients: before.users.rawUniqueClients,
        sourceRegistryEntries: before.sourceRegistry.entries
      });

      const restartRequired = usagePercent >= config.MEMORY_GUARD_RESTART_PERCENT;
      const activeStreams = Number(before.streams.activeStreams || 0);
      const heapRestartRequired = heapUsagePercent >= config.MEMORY_GUARD_RESTART_PERCENT;

      if (restartRequired && activeStreams > 0 && !heapRestartRequired) {
        logger.warn('memory guard deferred restart while streams active', {
          criticalStrikes,
          activeStreams,
          pressurePercent: Number(usagePercent.toFixed(1)),
          systemPressurePercent: Number(systemUsagePercent.toFixed(1)),
          heapPressurePercent: Number(heapUsagePercent.toFixed(1)),
          availableMemoryBytes: memory.availableMemoryBytes,
          minAvailableBytes
        });
        return;
      }

      if (restartRequired) {
        logger.error('memory guard restarting process before system lockup', {
          criticalStrikes,
          activeStreams,
          pressurePercent: Number(usagePercent.toFixed(1)),
          systemPressurePercent: Number(systemUsagePercent.toFixed(1)),
          heapPressurePercent: Number(heapUsagePercent.toFixed(1)),
          systemPressureActive,
          restartPercent: config.MEMORY_GUARD_RESTART_PERCENT,
          availableMemoryBytes: memory.availableMemoryBytes,
          minAvailableBytes,
          heapUsedBytes: before.processMemory.heapUsed,
          heapLimitBytes,
          processRssBytes: before.processMemory.rss
        });

        await Promise.race([
          userTracker.flush(),
          sleep(1000)
        ]).catch((error) => {
          logger.warn('memory guard analytics flush before restart failed', { error });
        });
        process.exit(1);
      }
    } catch (error) {
      logger.warn('memory guard cleanup failed', { error });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runCleanup, config.MEMORY_GUARD_INTERVAL_SECONDS * 1000);
  timer.unref();
  const emergencyTimer = setInterval(runEmergencyCheck, 250);
  emergencyTimer.unref();
  timer.emergencyTimer = emergencyTimer;
  const warmupTimer = setTimeout(runCleanup, 1000);
  warmupTimer.unref?.();
  return timer;
};

const hasValidAdminSession = (req) => {
  const cookies = parseCookies(req.headers.cookie);
  return verifyAdminSessionToken(cookies[ADMIN_COOKIE_NAME]);
};

const requireAdminAuth = (req, res, next) => {
  if (hasValidAdminSession(req)) {
    next();
    return;
  }

  const credentials = parseBasicAuth(req.headers.authorization);

  if (!credentials || credentials.username !== config.ADMIN_USERNAME || credentials.password !== config.ADMIN_PASSWORD) {
    res.redirect(302, '/admin/login');
    return;
  }

  setAdminSessionCookie(req, res);
  next();
};

const bootstrap = async () => {
  const app = express();
  const landingPagePath = path.join(process.cwd(), 'public', 'nebulastreams.html');

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, _res, next) => {
    const originalUrl = String(req.url || '');
    const trimmedUrl = originalUrl.replace(/(?:%20|\s)+(?=$|\?)/giu, '');

    if (trimmedUrl && trimmedUrl !== originalUrl) {
      req.url = trimmedUrl;
    }

    next();
  });

  const reverseProxy = config.REVERSE_PROXY_TARGET
    ? new ReverseProxyService({
      targetBaseUrl: config.REVERSE_PROXY_TARGET,
      timeoutSeconds: config.REVERSE_PROXY_TIMEOUT_SECONDS
    })
    : null;
  const uptimeKumaProxy = config.UPTIME_KUMA_TARGET
    ? createUptimeKumaProxy({
      targetBaseUrl: config.UPTIME_KUMA_TARGET,
      mountPath: '/status'
    })
    : null;

  const cacheManager = new CacheManager();

  await cacheManager.initialize();

  const sourceRegistry = new SourceRegistry();
  const imdbResolver = new ImdbResolverService();
  const providerService = new ProviderService();
  await providerService.initialize();
  const userTracker = new UserTrackerService();
  await userTracker.initialize();
  const supporterService = new SupporterService({
    cacheDir: config.CACHE_DIR,
    secret: config.SUPPORTER_CODE_SECRET,
    logger
  });
  await supporterService.initialize();
  const sportsSupporterService = new SportsSupporterService({
    cacheDir: config.CACHE_DIR,
    secret: `${config.SUPPORTER_CODE_SECRET}:sports`,
    logger
  });
  await sportsSupporterService.initialize();
  const emailService = new EmailService({ config, logger });
  const torrentEngine = new TorrentEngineService({ cacheManager });
  const httpProxy = new HttpProxyService({ cacheManager, torrentEngine });
  const streamManager = new StreamManager({
    torrentEngine,
    httpProxy,
    cacheManager,
    sourceRegistry,
    providerService,
    imdbResolver,
    userTracker,
    supporterService
  });
  await streamManager.initialize();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept, Origin, User-Agent, Authorization, X-Requested-With, Accept-Language');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });
  if (uptimeKumaProxy) {
    app.use('/status', uptimeKumaProxy.handle);
  }
  app.use(createMemoryFuse(streamManager));
  app.use(createBotProtection());
  app.use((req, _res, next) => {
    userTracker.trackRequest(req);
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  app.use('/assets', express.static('assets', {
    maxAge: '7d',
    immutable: true
  }));
  app.get(['/sports/poster.jpg', '/sports/poster.png', '/sports/poster.svg', '/sports/poster/:version/:sig.jpg', '/sports/poster/:version/:sig.png', '/sports/poster/:version/:sig.svg'], async (req, res) => {
    const title = clampPosterText(req.query?.title || 'Sports Event', 80);
    const meta = clampPosterText(req.query?.meta || req.query?.genre || 'Sports', 44);
    const timeLabel = clampPosterText(req.query?.time || 'Starting soon', 44);
    const badge = clampPosterText(req.query?.badge || 'EVENT', 18);
    const sources = clampPosterText(req.query?.sources || 'Nebula Sports', 24);
    const kind = clampPosterText(req.query?.kind || 'event', 24);
    const info = clampPosterText(req.query?.info || sources || 'Nebula Sports', 70);
    const wantsSvg = String(req.path || '').endsWith('.svg');
    const wantsPng = String(req.path || '').endsWith('.png');
    const outputType = wantsSvg ? 'svg' : (wantsPng ? 'png' : 'jpg');
    const cacheKey = `${SPORTS_POSTER_VERSION}:${outputType}:${title}:${meta}:${timeLabel}:${badge}:${sources}:${kind}:${info}:${req.params.sig || ''}`;
    const cached = posterImageCache.get(cacheKey);
    if (cached) {
      res.type(wantsSvg ? 'image/svg+xml' : (wantsPng ? 'image/png' : 'image/jpeg'))
        .setHeader('Cache-Control', 'public, max-age=86400, immutable')
        .send(cached);
      return;
    }
    const svg = buildNebulaSportsPosterSvg({
      title,
      meta,
      timeLabel,
      badge,
      sources,
      kind,
      info
    });
    try {
      const body = wantsSvg
        ? svg
        : await import('sharp')
          .then(({ default: sharp }) => {
            const pipeline = sharp(Buffer.from(svg)).resize(720, 1080, { fit: 'cover' });
            return wantsPng
              ? pipeline.png({ compressionLevel: 8 }).toBuffer()
              : pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
          });
      posterImageCache.set(cacheKey, body);
      while (posterImageCache.size > POSTER_IMAGE_CACHE_MAX) {
        posterImageCache.delete(posterImageCache.keys().next().value);
      }
      res.type(wantsSvg ? 'image/svg+xml' : (wantsPng ? 'image/png' : 'image/jpeg'))
        .setHeader('Cache-Control', 'public, max-age=86400, immutable')
        .send(body);
    } catch (error) {
      logger.warn('nebula sports poster render failed', {
        error: error?.message || String(error)
      });
      res.type('image/svg+xml')
        .setHeader('Cache-Control', 'public, max-age=300')
        .send(svg);
    }
  });
  app.get('/webos/repo.json', (_req, res) => {
    res
      .type('application/json')
      .setHeader('Cache-Control', 'public, max-age=300')
      .sendFile(path.resolve('webos/repo.json'));
  });
  app.get('/webos/com.nebulastreams.sports_1.0.3_all.ipk', (_req, res) => {
    res
      .type('application/vnd.palm.ipk')
      .setHeader('Cache-Control', 'public, max-age=86400')
      .sendFile(path.resolve('dist/webos/com.nebulastreams.sports_1.0.3_all.ipk'));
  });
  app.get('/favicon.ico', (_req, res) => {
    res.redirect(301, '/assets/nebula-sports-favicon-32.png');
  });
  app.get('/sw.js', (_req, res) => {
    res
      .type('application/javascript')
      .set('Cache-Control', 'no-cache')
      .set('Service-Worker-Allowed', '/')
      .sendFile(path.resolve('sw.js'));
  });
  app.use(createRateLimiter({
    name: 'public',
    windowMs: config.PUBLIC_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.PUBLIC_RATE_LIMIT_MAX_REQUESTS,
    matcher: (req) => {
      if (req.path.startsWith('/admin')) {
        return false;
      }

      if (/^\/private\/[^/]+\/(?:stalker|xtream)\//u.test(req.path)) {
        return false;
      }

      return req.path === '/'
        || req.path === '/configure'
        || req.path.startsWith('/preview/')
        || req.path.startsWith('/stremio/preview/')
        || (req.path.startsWith('/configured/') && !isStremioManifestPath(req.path))
        || (req.path.startsWith('/private/') && !isStremioManifestPath(req.path));
    }
  }));
  app.use(createRateLimiter({
    name: 'streams',
    windowMs: config.STREAM_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.STREAM_RATE_LIMIT_MAX_REQUESTS,
    matcher: (req) => req.path.startsWith('/stream/')
      || req.path === '/stream'
      || req.path === '/http-stream'
      || req.path === '/stream/http'
      || req.path === '/stream/torrent'
      || req.path.startsWith('/stremio/stream/')
  }));
  app.use(createRateLimiter({
    name: 'providers',
    windowMs: config.PROVIDER_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.PROVIDER_RATE_LIMIT_MAX_REQUESTS,
    matcher: (req) => req.path.startsWith('/providers')
  }));

  app.get('/health', async (_req, res, next) => {
    try {
      const includeFullStats = _req.query?.full === '1' || _req.query?.full === 'true';
      const includeCacheStats = (_req.query?.cache === '1' || _req.query?.cache === 'true')
        && process.memoryUsage().heapUsed < 256 * 1024 * 1024;
      const activeCachePaths = torrentEngine.getActiveCachePaths();
      const cacheStats = includeCacheStats
        ? await cacheManager.getCacheStats(activeCachePaths)
        : null;
      const streamStats = streamManager.getStats();
      const memory = await getSystemMemorySnapshot();
      const processMemory = process.memoryUsage();
      const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
      const heapUsagePercent = heapLimitBytes > 0
        ? (processMemory.heapUsed / heapLimitBytes) * 100
        : 0;
      const memoryUsagePercent = memory.totalMemoryBytes > 0
        ? ((memory.totalMemoryBytes - memory.availableMemoryBytes) / memory.totalMemoryBytes) * 100
        : 0;
      const {
        configureUsers: _configureUsers,
        configureRequests: _configureRequests,
        ...publicUserStats
      } = userTracker.getStats();

      res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        activeTorrentEngines: activeCachePaths.length,
        activeStreams: streamStats.activeStreams,
        maxActiveStreams: streamStats.maxActiveStreams,
        streams: streamStats,
        memory: {
          totalMemoryBytes: memory.totalMemoryBytes,
          availableMemoryBytes: memory.availableMemoryBytes,
          freeMemoryBytes: memory.freeMemoryBytes,
          usagePercent: memoryUsagePercent,
          heapUsagePercent,
          heapUsedBytes: processMemory.heapUsed,
          heapLimitBytes,
          processRssBytes: processMemory.rss,
          guardEnabled: config.MEMORY_GUARD_ENABLED,
          guardPressurePercent: config.MEMORY_GUARD_PRESSURE_PERCENT,
          guardCriticalPercent: config.MEMORY_GUARD_CRITICAL_PERCENT
        },
        users: publicUserStats,
        cache: cacheStats || {
          cacheDir: config.CACHE_DIR,
          fullStats: false,
          skippedReason: includeFullStats ? 'cache stats require ?cache=1 and low heap usage' : 'not requested'
        },
        reverseProxy: reverseProxy
          ? {
            enabled: true,
            target: config.REVERSE_PROXY_TARGET
          }
          : {
            enabled: false
          }
      });
    } catch (error) {
      next(error);
    }
  });

  const configurePageCache = new Map();
  const adminSupporterFlashCodes = new Map();
  const renderConfigureResponse = (req, res) => {
    const baseUrl = getPublicBaseUrl(req);
    const cacheKey = baseUrl;
    const cached = configurePageCache.get(cacheKey);
    const now = Date.now();
    const html = cached && cached.expiresAt > now
      ? cached.html
      : renderConfigurePage({
        baseUrl,
        providers: providerService.listProviders(),
        supporterStats: supporterService.getStats(),
        userStats: userTracker.getStats()
      });

    if (!cached || cached.expiresAt <= now) {
      configurePageCache.set(cacheKey, {
        html,
        expiresAt: now + 30_000
      });
      if (configurePageCache.size > 6) {
        configurePageCache.delete(configurePageCache.keys().next().value);
      }
    }

    res
      .status(200)
      .set('Cache-Control', 'public, max-age=30, stale-while-revalidate=300')
      .type('html')
      .send(html);
  };

  const sendLandingPage = (_req, res) => {
    res
      .status(200)
      .set('Cache-Control', 'public, max-age=300')
      .type('html')
      .sendFile(landingPagePath);
  };
  app.get('/', sendLandingPage);
  app.get('/movies', sendLandingPage);
  app.get('/series', sendLandingPage);
  app.get('/configure', renderConfigureResponse);

  const getSupporterAccountFromRequest = async (req) => {
    const cookies = parseCookies(req.headers.cookie);
    return supporterService.validateSession(cookies[SUPPORTER_COOKIE_NAME]);
  };

  const redirectDashboard = (res, params = {}) => {
    const query = new URLSearchParams(params);
    res.redirect(302, `/dashboard${query.toString() ? `?${query.toString()}` : ''}`);
  };

  const getSportsAccountFromRequest = async (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionAccount = await sportsSupporterService.validateSession(cookies[SPORTS_COOKIE_NAME]);
    if (sportsSupporterService.isAccountActive(sessionAccount)) return sessionAccount;
    const installKey = String(req.query?.key || '').trim();
    if (!installKey) return null;
    const keyAccount = sportsSupporterService.getAccountByInstallKey(installKey);
    return sportsSupporterService.isAccountActive(keyAccount) ? keyAccount : null;
  };

  const redirectSports = (res, params = {}) => {
    const query = new URLSearchParams(params);
    res.redirect(302, `/sports${query.toString() ? `?${query.toString()}` : ''}`);
  };

  const getSportsCatalogDefinitions = async ({ timeoutMs = 6_000 } = {}) => {
    try {
      const sports = await streamManager.streamedSportsAdapter.getSports(AbortSignal.timeout(timeoutMs));
      return streamManager.streamedSportsAdapter.getEventCatalogDefinitions(sports);
    } catch (error) {
      logger.warn('nebula sports catalog definition load failed', { error: error?.message || String(error) });
      return streamManager.streamedSportsAdapter.getEventCatalogDefinitions();
    }
  };

  const getSportsPagePreview = async () => {
    let catalogs = streamManager.streamedSportsAdapter.getEventCatalogDefinitions();
    try {
      const sports = await streamManager.streamedSportsAdapter.getSports(AbortSignal.timeout(1_500));
      catalogs = streamManager.streamedSportsAdapter.getEventCatalogDefinitions(sports);
    } catch (error) {
      logger.warn('nebula sports page sports preview load failed', { error: error?.message || String(error) });
    }

    const availableSports = catalogs
      .filter((catalog) => !['streamed-events-live', 'streamed-events-today', 'streamed-events-popular', 'streamed-events-dlhd-channels'].includes(catalog.id))
      .map((catalog) => String(catalog.name || '').replace(/^Sports Events:\s*/u, '').trim())
      .filter(Boolean)
      .slice(0, 14);

    const trendingCatalog = catalogs.find((catalog) => catalog.id === 'streamed-events-popular')
      || catalogs.find((catalog) => catalog.id === 'streamed-events-live')
      || catalogs.find((catalog) => catalog.id === 'streamed-events-today');
    let trendingEvents = [];
    if (trendingCatalog) {
      try {
        const metas = await streamManager.streamedSportsAdapter.getEventCatalog({
          catalog: trendingCatalog,
          limit: 6,
          signal: AbortSignal.timeout(1_500)
        });
        trendingEvents = metas.map((meta) => ({
          name: meta?.name || '',
          time: meta?.releaseInfo || '',
          genre: Array.isArray(meta?.genres) ? meta.genres.filter((genre) => genre && genre !== 'Sports').join(', ') : ''
        })).filter((event) => event.name);
      } catch (error) {
        logger.warn('nebula sports page trending preview load failed', { error: error?.message || String(error) });
      }
    }

    return { availableSports, trendingEvents };
  };

  const normalizeWatchSportsText = (value) => String(value || '').toLowerCase();

  const isWorldCupFootballMetadata = (event = {}) => {
    const text = [
      event.name,
      event.title,
      event.releaseInfo,
      event.description,
      event.category,
      event.tournament,
      event.competition,
      ...(Array.isArray(event.genres) ? event.genres : [])
    ].map(normalizeWatchSportsText).join(' ');
    const hasWorldCup = /\bworld\s+cup\b/u.test(text);
    const hasFootball = /\b(?:fifa|football|soccer)\b/u.test(text);
    return hasWorldCup && hasFootball;
  };

  const parseWorldCupFootballTeams = (name) => {
    const cleanName = String(name || '')
      .replace(/\[[^\]]+\]/gu, ' ')
      .replace(/\([^)]*\)/gu, ' ')
      .replace(/\b(?:fifa|football|soccer|world cup|live|hd|stream)\b/giu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    const parts = cleanName
      .split(/\s+(?:vs\.?|v\.?|versus|[-–—])\s+/iu)
      .map((part) => part.trim())
      .filter(Boolean);
    return {
      home: parts[0] || 'Home',
      away: parts[1] || 'Away'
    };
  };

  const buildUnavailableWorldCupFootballStats = (event = {}) => {
    const teams = parseWorldCupFootballTeams(event.name || event.title);
    const emptyPair = { home: '—', away: '—' };
    return {
      worldCup: true,
      available: false,
      updatedAt: new Date().toISOString(),
      message: 'Stats unavailable',
      clock: '—',
      score: emptyPair,
      teams: {
        home: { name: teams.home, crest: null },
        away: { name: teams.away, crest: null }
      },
      stats: {
        possession: emptyPair,
        shotsOnTarget: emptyPair,
        corners: emptyPair,
        cards: emptyPair,
        substitutions: emptyPair
      }
    };
  };

  const worldCupFootballStatsCache = new Map();

  const normalizeFootballTeamName = (value) => String(value || '')
    .toLowerCase()
    .replace(/\b(?:fc|cf|sc|club|national|team|men|women)\b/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  const getApiFootballEventDate = (event = {}) => {
    const source = String(event.releaseInfo || event.date || '');
    const isoDate = source.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0];
    if (isoDate) return isoDate;
    const parsedDate = Date.parse(source);
    if (Number.isFinite(parsedDate)) return new Date(parsedDate).toISOString().slice(0, 10);
    return '';
  };

  const getApiFootballSeason = (event = {}) => {
    const date = getApiFootballEventDate(event);
    if (date) return Number.parseInt(date.slice(0, 4), 10);
    return new Date().getUTCFullYear();
  };

  const apiFootballRequest = async (pathName, params = {}, signal = AbortSignal.timeout(config.API_FOOTBALL_STATS_TIMEOUT_MS)) => {
    if (!config.API_FOOTBALL_KEY) {
      throw new Error('API-Football key missing');
    }
    const url = new URL(pathName, config.API_FOOTBALL_BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && String(value).trim()) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'x-apisports-key': config.API_FOOTBALL_KEY
      },
      signal
    });
    if (!response.ok) {
      throw new Error(`API-Football ${pathName} failed with ${response.status}`);
    }
    const payload = await response.json();
    const errors = payload?.errors;
    if (errors && ((Array.isArray(errors) && errors.length) || (typeof errors === 'object' && Object.keys(errors).length))) {
      throw new Error(`API-Football ${pathName} returned errors`);
    }
    return Array.isArray(payload?.response) ? payload.response : [];
  };

  const scoreApiFootballFixtureCandidate = (fixture, event = {}) => {
    const teams = parseWorldCupFootballTeams(event.name || event.title);
    const wantedHome = normalizeFootballTeamName(teams.home);
    const wantedAway = normalizeFootballTeamName(teams.away);
    const home = normalizeFootballTeamName(fixture?.teams?.home?.name);
    const away = normalizeFootballTeamName(fixture?.teams?.away?.name);
    const haystack = `${home} ${away}`;
    let score = 0;
    for (const wanted of [wantedHome, wantedAway].filter((value) => value && !['home', 'away'].includes(value))) {
      if (home === wanted || away === wanted) score += 8;
      else if (home.includes(wanted) || away.includes(wanted) || wanted.includes(home) || wanted.includes(away)) score += 5;
      else if (wanted.split(' ').some((part) => part.length > 3 && haystack.includes(part))) score += 2;
    }
    if (String(fixture?.league?.name || '').toLowerCase().includes('world cup')) score += 4;
    if (fixture?.fixture?.status?.elapsed) score += 3;
    if (fixture?.fixture?.status?.short && !['NS', 'TBD', 'PST', 'CANC'].includes(fixture.fixture.status.short)) score += 2;
    return score;
  };

  const findApiFootballWorldCupFixture = async (event = {}) => {
    const league = config.API_FOOTBALL_WORLD_CUP_LEAGUE_ID;
    const season = getApiFootballSeason(event);
    const date = getApiFootballEventDate(event);
    const attempts = [
      { live: 'all', league },
      date ? { league, season, date } : null
    ].filter(Boolean);
    for (const params of attempts) {
      const fixtures = await apiFootballRequest('/fixtures', params);
      const candidates = fixtures
        .map((fixture) => ({ fixture, score: scoreApiFootballFixtureCandidate(fixture, event) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);
      if (candidates[0]?.fixture) return candidates[0].fixture;
      if (fixtures.length === 1) return fixtures[0];
    }
    return null;
  };

  const getApiFootballStat = (statistics = [], typePattern) => {
    const entry = statistics.find((stat) => typePattern.test(String(stat?.type || '')));
    const value = entry?.value;
    if (value === null || value === undefined || value === '') return '—';
    return typeof value === 'number' ? String(value) : String(value);
  };

  const countApiFootballEvents = (events = [], teamId, typePattern, detailPattern = null) =>
    events.filter((event) => {
      if (Number(event?.team?.id) !== Number(teamId)) return false;
      if (!typePattern.test(String(event?.type || ''))) return false;
      return detailPattern ? detailPattern.test(String(event?.detail || '')) : true;
    }).length;

  const buildApiFootballStatsPayload = async (event = {}) => {
    const cacheKey = [
      'api-football-world-cup',
      event.id || '',
      event.name || '',
      event.releaseInfo || '',
      event.tournament || '',
      event.competition || ''
    ].join('|');
    const cached = worldCupFootballStatsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.payload;

    const fixture = await findApiFootballWorldCupFixture(event);
    if (!fixture?.fixture?.id) {
      return buildUnavailableWorldCupFootballStats(event);
    }
    const fixtureId = fixture.fixture.id;
    const [statistics, events] = await Promise.all([
      apiFootballRequest('/fixtures/statistics', { fixture: fixtureId }),
      apiFootballRequest('/fixtures/events', { fixture: fixtureId }).catch(() => [])
    ]);
    const homeTeam = fixture.teams?.home || {};
    const awayTeam = fixture.teams?.away || {};
    const homeStats = statistics.find((entry) => Number(entry?.team?.id) === Number(homeTeam.id))?.statistics || [];
    const awayStats = statistics.find((entry) => Number(entry?.team?.id) === Number(awayTeam.id))?.statistics || [];
    const toPair = (pattern) => ({
      home: getApiFootballStat(homeStats, pattern),
      away: getApiFootballStat(awayStats, pattern)
    });
    const elapsed = fixture.fixture?.status?.elapsed;
    const extra = fixture.fixture?.status?.extra;
    const payload = {
      worldCup: true,
      available: true,
      updatedAt: new Date().toISOString(),
      message: '',
      clock: elapsed ? `${elapsed}${extra ? `+${extra}` : ''}'` : (fixture.fixture?.status?.long || '—'),
      score: {
        home: fixture.goals?.home ?? '—',
        away: fixture.goals?.away ?? '—'
      },
      teams: {
        home: { name: homeTeam.name || 'Home', crest: homeTeam.logo || null },
        away: { name: awayTeam.name || 'Away', crest: awayTeam.logo || null }
      },
      stats: {
        possession: toPair(/possession/iu),
        shotsOnTarget: toPair(/shots on goal|shots on target/iu),
        corners: toPair(/corner/iu),
        cards: {
          home: String(countApiFootballEvents(events, homeTeam.id, /card/iu)),
          away: String(countApiFootballEvents(events, awayTeam.id, /card/iu))
        },
        substitutions: {
          home: String(countApiFootballEvents(events, homeTeam.id, /subst/iu)),
          away: String(countApiFootballEvents(events, awayTeam.id, /subst/iu))
        }
      }
    };
    worldCupFootballStatsCache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + config.API_FOOTBALL_STATS_CACHE_MS
    });
    if (worldCupFootballStatsCache.size > 200) {
      for (const key of worldCupFootballStatsCache.keys()) {
        worldCupFootballStatsCache.delete(key);
        if (worldCupFootballStatsCache.size <= 160) break;
      }
    }
    return payload;
  };

  const ensureSportsPlaybackConfigId = async (account) => {
    if (account?.playbackConfigId) return account.playbackConfigId;
    const created = await streamManager.createPrivateConfig({
      providers: [],
      qualityPriority: ['1080p', '720p', '480p'],
      streamOptions: {},
      privateProviderSettings: {
        streamedSportsEnabled: true
      },
      supporter: {
        active: true,
        tier: `sports-${account?.tier || 'monthly'}`,
        label: account?.username || 'Nebula Sports',
        expiresAt: account?.expiresAt || null,
        lifetime: Boolean(account?.lifetime),
        codeHash: account?.tokenHash || ''
      }
    });
    await sportsSupporterService.setPlaybackConfigId(account.id, created.configId);
    return created.configId;
  };

  const getSportsAccountFromInstall = async (req, res) => {
    await sportsSupporterService.initialize();
    const installKey = String(req.params.installKey || '').trim();
    const account = installKey === 'free'
      ? await sportsSupporterService.getOrCreateFreePreviewAccount()
      : sportsSupporterService.getAccountByInstallKey(installKey);
    if (!sportsSupporterService.isAccountActive(account)) {
      res.status(402).json({ error: 'Nebula Sports account inactive or expired' });
      return null;
    }
    return account;
  };

  const isPaidSportsSupporter = (account) =>
    sportsSupporterService.isAccountActive(account)
    && ['monthly', 'lifetime', 'premium-future', 'trial', 'community-week'].includes(String(account?.tier || '').toLowerCase());

  const isFreeSportsTier = (account) =>
    sportsSupporterService.isAccountActive(account)
    && String(account?.tier || '').toLowerCase() === 'free';

  const isCdnLiveTvSportsStream = (stream) => {
    const text = [
      stream?.source,
      stream?.name,
      stream?.title,
      stream?.url,
      stream?.externalUrl
    ].map((value) => String(value || '').toLowerCase()).join(' ');
    return text.includes('cdnlivetv') || text.includes('cdn live tv');
  };

  const shouldShowSportsUpdateNotice = (account) => {
    const seenVersion = String(account?.sportsManifestVersion || '').trim();
    return !seenVersion || compareVersionParts(seenVersion, SPORTS_ADDON_VERSION) < 0;
  };

  const DLHD_CHANNEL_CATALOG_ID = 'streamed-events-dlhd-channels';
  const hasDlhdChannelAccess = (account) =>
    sportsSupporterService.isAccountActive(account)
    && (Boolean(account?.lifetime)
      || ['monthly', 'lifetime', 'sports-lifetime', 'founder', 'premium-future'].includes(String(account?.tier || '').toLowerCase()));
  const filterSportsCatalogsForAccount = (catalogs, account) =>
    (Array.isArray(catalogs) ? catalogs : []).filter((catalog) =>
      catalog?.id !== DLHD_CHANNEL_CATALOG_ID || hasDlhdChannelAccess(account)
    );

  const getSportsConfig = (account) => ({
    liveOnly: Boolean(account?.sportsConfig?.liveOnly),
    sports: Array.isArray(account?.sportsConfig?.sports) ? account.sportsConfig.sports : [],
    timezone: String(account?.sportsConfig?.timezone || 'UTC')
  });

  const getCatalogSearchValue = (req) => {
    const extra = String(req.params.extra || '');
    const extraParams = new URLSearchParams(extra.replace(/\.json$/u, ''));
    return String(req.query.search || req.params.search || extraParams.get('search') || '').trim();
  };

  const SPORTS_MAIN_CATALOG_ID = 'all';
  const SPORTS_LEGACY_CATALOG_ID = 'nebula-sports-events';
  const SPORTS_STREMIO_TYPE = 'sports';
  const LIVE_TV_GENRE_OPTIONS = Object.freeze([
    'FIFA WC',
    'Football',
    'Cricket',
    'Tennis',
    'Motorsport',
    'Fight',
    'US Sports',
    'Golf',
    'Rugby',
    'Sports News'
  ]);

  const normalizeSportsCatalogText = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  const sportsGenreNeedles = (genre) => {
    const normalized = normalizeSportsCatalogText(genre);
    const aliases = {
      football: ['football', 'soccer', 'fifa'],
      soccer: ['football', 'soccer', 'fifa'],
      cricket: ['cricket'],
      tennis: ['tennis', 'atp', 'wta'],
      basketball: ['basketball', 'nba'],
      baseball: ['baseball', 'mlb'],
      'ice hockey': ['ice hockey', 'hockey', 'nhl'],
      hockey: ['ice hockey', 'hockey', 'nhl'],
	      rugby: ['rugby'],
	      'motor sports': ['motor sports', 'motorsport', 'formula', 'f1', 'moto gp', 'motogp', 'nascar'],
	      motorsport: ['motor sports', 'motorsport', 'formula', 'f1', 'moto gp', 'motogp', 'nascar'],
	      racing: ['racing', 'race', 'formula', 'f1', 'moto gp', 'motogp', 'nascar'],
	      fight: ['fight', 'ufc', 'boxing', 'wwe', 'combat', 'dazn'],
	      'us sports': ['us sports', 'nba', 'nfl', 'mlb', 'nhl', 'espn', 'fox sports', 'nbc sports', 'cbs sports'],
	      golf: ['golf', 'pga'],
	      'sports news': ['sports news', 'espnews'],
	      'fifa wc': ['fifa', 'world cup', 'wc']
	    };
    return aliases[normalized] || (normalized ? [normalized] : []);
  };

  const getCatalogGenreValue = (req) => {
    const extra = String(req.params.extra || '');
    const normalizedExtra = extra
      .replace(/\.json$/u, '')
      .replace(/,/gu, '&');
    const extraParams = new URLSearchParams(normalizedExtra);
    return String(req.query.genre || req.params.genre || extraParams.get('genre') || '').trim();
  };

  const getCatalogSkipValue = (req) => {
    const extra = String(req.params.extra || '');
    const normalizedExtra = extra
      .replace(/\.json$/u, '')
      .replace(/,/gu, '&');
    const extraParams = new URLSearchParams(normalizedExtra);
    const parsed = Number.parseInt(req.query.skip || req.params.skip || extraParams.get('skip') || '0', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  };

  const buildFallbackSportsMeta = (id) => {
    const rawId = String(id || '');
    const name = decodeURIComponent(rawId.replace(/^streamed:/u, ''))
      .replace(/[-_]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim() || 'Live Sports Event';
    return {
      id: rawId,
      type: SPORTS_STREMIO_TYPE,
      name,
      posterShape: 'landscape',
      genres: ['Sports'],
      releaseInfo: 'Live/upcoming',
      runtime: 'Live',
      description: 'Nebula Sports event. Stream list loads from fresh live source.'
    };
  };

  const decorateSportsMeta = (meta, reqOrBaseUrl, account = null) => {
    const baseUrl = typeof reqOrBaseUrl === 'string' ? reqOrBaseUrl : getPublicBaseUrl(reqOrBaseUrl);
    const genres = Array.isArray(meta?.genres) && meta.genres.length ? meta.genres : ['Sports'];
    const primaryGenre = genres.find((genre) => genre && genre !== 'Sports') || genres[0] || 'Sports';
    const metaName = String(meta?.name || 'Live Sports Event').trim();
    const isLiveTv = primaryGenre.toLowerCase() === 'live tv'
      || String(meta?.id || '').includes('dlhd-channel')
      || genres.some((genre) => String(genre || '').toLowerCase() === 'live tv');
	    const configuredTimezone = getSportsConfig(account).timezone;
	    let displayTime = meta?.releaseInfo || null;
	    const actualLive = Boolean(meta?.isLive || /^🔴?\s*LIVE$/iu.test(String(displayTime || '').replace(/^🔴/u, '').trim()));
	    const utcMatch = String(displayTime || '').match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+UTC$/u);
	    if (!actualLive && utcMatch && configuredTimezone !== 'UTC') {
      try {
        displayTime = new Intl.DateTimeFormat('en', {
          timeZone: configuredTimezone,
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZoneName: 'short'
        }).format(new Date(`${utcMatch[1]}T${utcMatch[2]}:00Z`));
      } catch {}
    }
    const generatedPoster = buildSportsPosterUrl(baseUrl, {
      id: meta?.id || metaName,
      name: metaName,
	      genre: primaryGenre,
	      kind: isLiveTv ? 'channel' : 'event',
	      time: actualLive ? 'Live now' : (displayTime || (isLiveTv ? 'Live now' : 'Starting soon')),
	      info: isLiveTv
	        ? `${primaryGenre} channel`
	        : `${primaryGenre} event${displayTime && !actualLive ? ` · ${displayTime}` : ''}`,
	      badge: actualLive ? 'LIVE' : ''
	    });
    const poster = generatedPoster;
    return {
      ...meta,
      id: String(meta?.id || ''),
      type: SPORTS_STREMIO_TYPE,
      name: metaName,
      genre: primaryGenre,
      genres,
      poster,
      logo: poster,
      background: poster,
      posterShape: 'poster',
      country: 'Sports',
      countryCode: 'sports',
	      releaseInfo: actualLive ? '🔴 LIVE' : displayTime,
	      time: actualLive ? '🔴 LIVE' : displayTime,
	      isLive: actualLive,
      streams: []
    };
  };

  const sendSportsManifest = async (req, res, next) => {
    try {
      const account = await getSportsAccountFromInstall(req, res);
      if (!account) return;
      touchSportsLivePrewarm(account, req);
      const baseUrl = getPublicBaseUrl(req);
      const catalogDefinitions = filterSportsCatalogsForAccount(
        await getSportsCatalogDefinitions({ timeoutMs: 6_000 }),
        account
      );
      const sportsConfig = getSportsConfig(account);
      const selectedSports = new Set(sportsConfig.sports);
      const genreOptions = catalogDefinitions
        .filter((catalog) => !sportsConfig.liveOnly || catalog.id === 'streamed-events-live' || selectedSports.has(catalog.id))
        .filter((catalog) => selectedSports.size === 0
          || ['streamed-events-live', 'streamed-events-today', 'streamed-events-popular', DLHD_CHANNEL_CATALOG_ID].includes(catalog.id)
          || selectedSports.has(catalog.id))
        .map((catalog) => String(catalog.name || '').replace(/^Sports Events:\s*/u, '').trim())
        .filter(Boolean);
      const catalogs = [{
	          type: SPORTS_STREMIO_TYPE,
	          id: SPORTS_MAIN_CATALOG_ID,
	          name: 'Nebula Sports',
          extra: [
            { name: 'genre', options: genreOptions, isRequired: false }
          ]
	        }];
      const liveTvCatalog = catalogDefinitions.find((catalog) => catalog.id === DLHD_CHANNEL_CATALOG_ID);
      if (liveTvCatalog && hasDlhdChannelAccess(account)) {
		        catalogs.push({
	          type: SPORTS_STREMIO_TYPE,
	          id: DLHD_CHANNEL_CATALOG_ID,
	          name: 'Nebula Sports: Live TV',
	          extra: [
	            { name: 'genre', options: LIVE_TV_GENRE_OPTIONS, isRequired: false }
	          ]
	        });
	      }
      if (!isFreeSportsTier(account)) {
        streamManager.streamedSportsAdapter.prewarmCatalogs(catalogDefinitions);
      }
      void sportsSupporterService.increment(account.id, 'manifests', 1).catch((error) => {
        logger.debug?.('sports manifest stat increment failed', { error: error?.message || String(error) });
      });
      await sportsSupporterService.setSportsManifestVersion(account.id, SPORTS_ADDON_VERSION);
      res
        .setHeader('Cache-Control', 'private, max-age=120')
        .json({
          id: 'org.nebulastreams.sports',
          version: SPORTS_ADDON_VERSION,
          name: 'Nebula Sports',
          description: 'Stremio addon for live sports streams and event catalogs.',
          logo: `${baseUrl}/assets/nebula-sports-logo.png`,
          background: `${baseUrl}/assets/nebula-sports-logo.png`,
          behaviorHints: {
            configurable: true
          },
          resources: ['catalog', 'stream', 'meta'],
          types: [SPORTS_STREMIO_TYPE],
          idPrefixes: ['streamed'],
          catalogs
        });
    } catch (error) {
      next(error);
    }
  };

  const sendSportsCatalog = async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const account = await getSportsAccountFromInstall(req, res);
      if (!account) return;
      touchSportsLivePrewarm(account, req);
      const type = String(req.params.type || '').trim().toLowerCase();
      if (type !== SPORTS_STREMIO_TYPE && type !== 'tv' && type !== 'events' && type !== 'channel' && type !== 'live') {
        res.json({ metas: [] });
        return;
      }
      const sportsConfig = getSportsConfig(account);
      const requestedCatalogId = String(req.params.id || '').trim();
      const isChannelCatalogRequest = requestedCatalogId === DLHD_CHANNEL_CATALOG_ID;
      const catalogCacheKey = getSportsCatalogResponseCacheKey(req, account, sportsConfig);
      const cachedCatalogResponse = sportsCatalogResponseCache.get(catalogCacheKey);
      const cacheControl = isChannelCatalogRequest ? 'private, max-age=21600' : 'private, max-age=120';
      if (cachedCatalogResponse?.expiresAt > Date.now()) {
        sportsRouteMetrics.cacheStats.catalog.hits += 1;
        void sportsSupporterService.increment(account.id, 'catalogs', 1).catch((error) => {
          logger.debug?.('sports catalog stat increment failed', { error: error?.message || String(error) });
        });
        recordSportsRouteMetric('catalog', startedAt, { ok: true, status: 200, cacheHit: true });
        sendSportsJsonPayload(res, cacheControl, cachedCatalogResponse.payload);
        return;
      }
      if (cachedCatalogResponse) sportsCatalogResponseCache.delete(catalogCacheKey);
      sportsRouteMetrics.cacheStats.catalog.misses += 1;
      const catalogs = filterSportsCatalogsForAccount(
        await getSportsCatalogDefinitions({ timeoutMs: 6_000 }),
        account
      );
      const selectedCatalogs = catalogs.filter((entry) => sportsConfig.sports.includes(entry.id));
      const selectedSportNames = selectedCatalogs
        .map((entry) => String(entry.name || '').replace(/^Sports Events:\s*/u, '').trim().toLowerCase())
        .filter(Boolean);
      if (requestedCatalogId === 'streamed-events-flix-dlstreams') {
        res.setHeader('Cache-Control', 'private, max-age=15').json({ metas: [] });
        return;
      }
      const requestedGenre = getCatalogGenreValue(req);
      const requestedGenreNeedle = normalizeSportsCatalogText(requestedGenre);
      const useUnifiedCatalog = requestedCatalogId === SPORTS_MAIN_CATALOG_ID || requestedCatalogId === SPORTS_LEGACY_CATALOG_ID;
      const catalog = sportsConfig.liveOnly
        ? catalogs.find((entry) => entry.id === 'streamed-events-live')
        : useUnifiedCatalog
        ? (catalogs.find((entry) => String(entry.name || '').replace(/^Sports Events:\s*/u, '').trim() === requestedGenre)
          || catalogs.find((entry) => entry.id === 'streamed-events-sportsbite')
          || catalogs.find((entry) => entry.id === 'streamed-events-today')
          || catalogs.find((entry) => entry.id === 'streamed-events-live')
          || catalogs[0])
        : catalogs.find((entry) => entry.id === requestedCatalogId);
      if (!catalog) {
        res.json({ metas: [] });
        return;
      }
      const requestedGenreCatalogMatched = useUnifiedCatalog
        && requestedGenre
        && String(catalog.name || '').replace(/^Sports Events:\s*/u, '').trim() === requestedGenre;
      let metas = [];
      try {
        const catalogLimit = [DLHD_CHANNEL_CATALOG_ID, 'streamed-events-cdnlivetv'].includes(catalog.id)
          || (useUnifiedCatalog && !requestedGenreNeedle)
          ? 500
          : 50;
        metas = await streamManager.streamedSportsAdapter.getEventCatalog({
	          catalog,
	          search: getCatalogSearchValue(req),
	          skip: getCatalogSkipValue(req),
		          limit: catalogLimit,
          signal: AbortSignal.timeout(6_000)
        });
      } catch (error) {
        logger.warn('nebula sports catalog load failed', {
          catalog: catalog.id,
          error: error?.message || String(error)
        });
      }
      void sportsSupporterService.increment(account.id, 'catalogs', 1).catch((error) => {
        logger.debug?.('sports catalog stat increment failed', { error: error?.message || String(error) });
      });
	      const decoratedMetas = metas
	        .map((meta) => decorateSportsMeta(meta, req, account))
	        .filter((meta) => {
	          if (catalog.id === DLHD_CHANNEL_CATALOG_ID) {
	            if (!requestedGenreNeedle) return true;
	            const text = normalizeSportsCatalogText([
	              meta.genre,
	              ...(meta.genres || []),
	              meta.name,
	              meta.description
	            ].join(' '));
	            return sportsGenreNeedles(requestedGenreNeedle).some((needle) => text.includes(needle));
	          }
	          if (useUnifiedCatalog && requestedGenreNeedle && !requestedGenreCatalogMatched) {
            const text = normalizeSportsCatalogText([
              meta.genre,
              ...(meta.genres || []),
              meta.name,
              meta.description,
              meta.tournament,
              meta.competition
            ].join(' '));
            return sportsGenreNeedles(requestedGenreNeedle).some((needle) => text.includes(needle));
          }
          if (!selectedSportNames.length) return true;
          const text = [meta.genre, ...(meta.genres || []), meta.name, meta.description]
            .join(' ')
            .toLowerCase();
          return selectedSportNames.some((sport) => text.includes(sport));
        });
      const payload = JSON.stringify({ metas: decoratedMetas });
      sportsCatalogResponseCache.set(catalogCacheKey, {
        payload,
        expiresAt: Date.now() + (isChannelCatalogRequest ? SPORTS_CHANNEL_CATALOG_RESPONSE_TTL_MS : SPORTS_CATALOG_RESPONSE_TTL_MS)
      });
      pruneSportsCatalogResponseCache();
      recordSportsRouteMetric('catalog', startedAt, { ok: true, status: 200, cacheHit: false });
      sendSportsJsonPayload(res, cacheControl, payload);
    } catch (error) {
      recordSportsRouteMetric('catalog', startedAt, {
        ok: false,
        status: error?.statusCode || 500,
        error: error?.message || String(error)
      });
      next(error);
    }
  };

  const sendSportsMeta = async (req, res, next) => {
    try {
      const account = await getSportsAccountFromInstall(req, res);
      if (!account) return;
      let meta = null;
      try {
        meta = await streamManager.streamedSportsAdapter.getEventMeta(req.params.id, AbortSignal.timeout(3_000));
      } catch (error) {
        logger.warn('nebula sports meta fallback used', {
          id: req.params.id,
          error: error?.message || String(error)
        });
      }
      const decoratedMeta = decorateSportsMeta(meta || buildFallbackSportsMeta(req.params.id), req, account);
      res.setHeader('Cache-Control', 'private, max-age=30').json({ meta: decoratedMeta });
    } catch (error) {
      next(error);
    }
  };

  const buildSportsTrialExpiryStreamCard = (account, req) => {
    if (String(account?.tier || '').trim().toLowerCase() !== 'community-week') {
      return null;
    }

    const expiresAtMs = Date.parse(account?.expiresAt || '');
    if (!Number.isFinite(expiresAtMs)) return null;

    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0) return null;

    const dayCount = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
    const hourCount = Math.ceil(remainingMs / (60 * 60 * 1000));
    const remainingLabel = dayCount >= 1
      ? `${dayCount} ${dayCount === 1 ? 'day' : 'days'}`
      : `${hourCount} ${hourCount === 1 ? 'hour' : 'hours'}`;

    const baseUrl = getPublicBaseUrl(req);
    const installKey = String(req.params.installKey || '').trim();
    const accountUrl = installKey ? `${baseUrl}/sports/i/${encodeURIComponent(installKey)}/configure` : `${baseUrl}/sports`;
    return {
      name: 'Nebula Sports Trial',
      title: [
        `Your trial expires in ${remainingLabel}`,
        'Click to continue using Nebula Sports',
        'Normal sports streams are below'
      ].join('\n'),
      externalUrl: accountUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'nebula-sports-trial-expiry'
      }
    };
  };

  const buildSportsNoStreamsCard = (req) => {
    const baseUrl = getPublicBaseUrl(req);
    const installKey = String(req.params.installKey || '').trim();
    const accountUrl = installKey ? `${baseUrl}/sports/i/${encodeURIComponent(installKey)}/configure` : `${baseUrl}/sports`;
    return {
      name: 'Nebula Sports',
      title: 'No streams currently available for this event',
      externalUrl: accountUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: `nebula-sports-empty-${String(req.params.id || 'event').slice(0, 120)}`
      }
    };
  };

  const buildSportsFreeUpgradeStreamCard = (req) => {
    const baseUrl = getPublicBaseUrl(req);
    const installKey = String(req.params.installKey || '').trim();
    const accountUrl = installKey ? `${baseUrl}/sports/i/${encodeURIComponent(installKey)}/configure` : `${baseUrl}/sports`;
    return {
      name: 'Nebula Sports Supporter',
      title: [
        'Subscribe to unlock more streams',
        'Free tier shows easiest available streams',
        'Click to get every playable source'
      ].join('\n'),
      externalUrl: accountUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: `nebula-sports-upgrade-${String(req.params.id || 'event').slice(0, 120)}`
      }
    };
  };

  const buildSportsUpdateNoticeStreamCard = (req) => {
    const baseUrl = getPublicBaseUrl(req);
    const installKey = String(req.params.installKey || '').trim();
    const accountUrl = installKey ? `${baseUrl}/sports/i/${encodeURIComponent(installKey)}/configure` : `${baseUrl}/sports`;
    return {
      name: 'Nebula Sports Update',
      title: [
        'Nebula Sports update available',
        'Refresh or reinstall addon to load the new Nebula poster style',
        'Click to open update page'
      ].join('\n'),
      externalUrl: accountUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'nebula-sports-update-1-0-5'
      }
    };
  };

  const SPORTS_STREAM_RESPONSE_CACHE_MAX = 500;
  const SPORTS_STREAM_RESPONSE_TTL_MS = 15_000;
  const SPORTS_STREAM_RESPONSE_PAID_TTL_MS = 10_000;
  const SPORTS_STREAM_EMPTY_TTL_MS = 4_000;
  const SPORTS_CATALOG_RESPONSE_CACHE_MAX = 300;
  const SPORTS_CATALOG_RESPONSE_TTL_MS = 120_000;
  const SPORTS_CHANNEL_CATALOG_RESPONSE_TTL_MS = 6 * 60 * 60 * 1000;
  const SPORTS_ROUTE_METRIC_MAX = 500;
  const SPORTS_ROUTE_ERROR_MAX = 25;
  const SPORTS_LIVE_PREWARM_INTERVAL_MS = 25_000;
  const SPORTS_LIVE_PREWARM_IDLE_STOP_MS = 10 * 60 * 1000;
  const sportsCatalogResponseCache = new Map();
  const sportsStreamResponseCache = new Map();
  const sportsStreamResponseInFlight = new Map();
  const sportsRouteMetrics = {
    catalog: [],
    stream: [],
    recentErrors: [],
    cacheStats: {
      catalog: { hits: 0, misses: 0 },
      stream: { hits: 0, misses: 0 }
    }
  };
  let sportsAdminMetricsWriteTimer = null;
  const sportsLivePrewarmState = {
    timer: null,
    running: false,
    lastSeenAt: 0,
    accountId: '',
    baseUrl: ''
  };

  const pruneSportsCatalogResponseCache = () => {
    const now = Date.now();
    for (const [key, entry] of sportsCatalogResponseCache) {
      if (entry.expiresAt <= now) sportsCatalogResponseCache.delete(key);
    }
    while (sportsCatalogResponseCache.size > SPORTS_CATALOG_RESPONSE_CACHE_MAX) {
      sportsCatalogResponseCache.delete(sportsCatalogResponseCache.keys().next().value);
    }
  };

  const getSportsCatalogResponseCacheKey = (req, account, sportsConfig) => [
    account?.id || account?.installKey || 'anon',
    String(req.params.type || ''),
    String(req.params.id || ''),
    String(req.params.extra || ''),
    String(req.params.search || ''),
    String(req.params.skip || ''),
    String(req.query?.genre || ''),
    sportsConfig?.liveOnly ? 'live' : 'all',
    Array.isArray(sportsConfig?.sports) ? sportsConfig.sports.join(',') : ''
  ].join('|');

  const sendSportsJsonPayload = (res, cacheControl, payload) => {
    res
      .status(200)
      .setHeader('Cache-Control', cacheControl)
      .type('application/json')
      .send(payload);
  };

  const recordSportsRouteMetric = (kind, startedAt, { ok = true, status = 200, cacheHit = false, error = '' } = {}) => {
    const bucket = sportsRouteMetrics[kind];
    if (!bucket) return;
    bucket.push({
      ms: Math.max(0, Date.now() - Number(startedAt || Date.now())),
      ok,
      status,
      cacheHit,
      at: Date.now()
    });
    while (bucket.length > SPORTS_ROUTE_METRIC_MAX) bucket.shift();
    if (!ok || error) {
      sportsRouteMetrics.recentErrors.unshift({
        time: new Date().toISOString(),
        kind,
        status,
        error: String(error || `HTTP ${status}`).slice(0, 180)
      });
      sportsRouteMetrics.recentErrors = sportsRouteMetrics.recentErrors.slice(0, SPORTS_ROUTE_ERROR_MAX);
    }
    scheduleSportsAdminWorkerSnapshotWrite();
  };

  const summarizeSportsRouteMetrics = (items = []) => {
    const values = items.map((item) => Number(item.ms || 0)).filter(Number.isFinite).sort((a, b) => a - b);
    const pct = (value) => values.length ? values[Math.min(values.length - 1, Math.floor((value / 100) * values.length))] : 0;
    const errors = items.filter((item) => !item.ok || Number(item.status || 0) >= 400).length;
    return {
      count: items.length,
      errors,
      avgMs: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0,
      p50Ms: Math.round(pct(50)),
      p95Ms: Math.round(pct(95)),
      p99Ms: Math.round(pct(99)),
      maxMs: Math.round(values.at(-1) || 0),
      lastStatus: items.at(-1)?.status || ''
    };
  };

  const getSportsAdminMetricFilePath = (pid = process.pid) =>
    path.join(config.CACHE_DIR, `sports-admin-metrics-${pid}.json`);

  const buildSportsAdminWorkerSnapshot = () => ({
    worker: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      updatedAt: new Date().toISOString()
    },
    routesRaw: {
      catalog: sportsRouteMetrics.catalog.slice(),
      stream: sportsRouteMetrics.stream.slice()
    },
    cacheStats: JSON.parse(JSON.stringify(sportsRouteMetrics.cacheStats)),
    caches: {
      catalogEntries: sportsCatalogResponseCache.size,
      streamEntries: sportsStreamResponseCache.size,
      streamInFlight: sportsStreamResponseInFlight.size
    },
    recentErrors: sportsRouteMetrics.recentErrors.slice()
  });

  const writeSportsAdminWorkerSnapshot = async () => {
    await fsPromises.mkdir(config.CACHE_DIR, { recursive: true });
    await fsPromises.writeFile(
      getSportsAdminMetricFilePath(),
      JSON.stringify(buildSportsAdminWorkerSnapshot()),
      { mode: 0o600 }
    );
  };

  const scheduleSportsAdminWorkerSnapshotWrite = () => {
    if (sportsAdminMetricsWriteTimer) return;
    sportsAdminMetricsWriteTimer = setTimeout(() => {
      sportsAdminMetricsWriteTimer = null;
      writeSportsAdminWorkerSnapshot().catch(() => {});
    }, 2_000);
    sportsAdminMetricsWriteTimer.unref?.();
  };

  const readSportsAdminWorkerSnapshots = async () => {
    await writeSportsAdminWorkerSnapshot().catch(() => {});
    const names = await fsPromises.readdir(config.CACHE_DIR).catch(() => []);
    const now = Date.now();
    const snapshots = [];
    for (const name of names) {
      if (!/^sports-admin-metrics-\d+\.json$/u.test(name)) continue;
      try {
        const filePath = path.join(config.CACHE_DIR, name);
        const payload = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
        const updatedAt = Date.parse(payload?.worker?.updatedAt || '');
        if (!Number.isFinite(updatedAt) || now - updatedAt > 2 * 60 * 1000) {
          await fsPromises.rm(filePath, { force: true }).catch(() => {});
          continue;
        }
        snapshots.push(payload);
      } catch {
        // ignore broken metric files
      }
    }
    return snapshots;
  };

  const mergeCacheStats = (snapshots = []) => {
    const result = { catalog: { hits: 0, misses: 0 }, stream: { hits: 0, misses: 0 } };
    for (const snapshot of snapshots) {
      for (const key of ['catalog', 'stream']) {
        result[key].hits += Number(snapshot?.cacheStats?.[key]?.hits || 0);
        result[key].misses += Number(snapshot?.cacheStats?.[key]?.misses || 0);
      }
    }
    return result;
  };

  const buildSportsAdminAlerts = (metrics = {}, diagnostics = {}) => {
    const alerts = [];
    for (const routeName of ['catalog', 'stream']) {
      const route = metrics.routes?.[routeName] || {};
      const count = Number(route.count || 0);
      const errorRate = count ? (Number(route.errors || 0) / count) * 100 : 0;
      if (count >= 20 && Number(route.p95Ms || 0) > 10_000) {
        alerts.push({ level: 'warn', message: `${routeName} p95 high: ${route.p95Ms}ms` });
      }
      if (count >= 20 && errorRate > 2) {
        alerts.push({ level: 'warn', message: `${routeName} error rate high: ${errorRate.toFixed(1)}%` });
      }
    }
    if (Number(diagnostics?.probe?.disabledForSeconds || 0) > 0) {
      alerts.push({ level: 'warn', message: `HLS probe disabled for ${diagnostics.probe.disabledForSeconds}s` });
    }
    if (Number(diagnostics?.browser?.disabledForSeconds || 0) > 0) {
      alerts.push({ level: 'warn', message: `Browser fallback disabled for ${diagnostics.browser.disabledForSeconds}s` });
    }
    return alerts;
  };

  const getSportsAdminMetrics = async () => {
    const snapshots = await readSportsAdminWorkerSnapshots();
    const catalogRoutes = snapshots.flatMap((snapshot) => Array.isArray(snapshot?.routesRaw?.catalog) ? snapshot.routesRaw.catalog : []);
    const streamRoutes = snapshots.flatMap((snapshot) => Array.isArray(snapshot?.routesRaw?.stream) ? snapshot.routesRaw.stream : []);
    const metrics = {
      workers: snapshots.map((snapshot) => snapshot.worker).filter(Boolean),
      routes: {
        catalog: summarizeSportsRouteMetrics(catalogRoutes),
        stream: summarizeSportsRouteMetrics(streamRoutes)
      },
      cacheStats: mergeCacheStats(snapshots),
      caches: {
        catalogEntries: snapshots.reduce((sum, snapshot) => sum + Number(snapshot?.caches?.catalogEntries || 0), 0),
        streamEntries: snapshots.reduce((sum, snapshot) => sum + Number(snapshot?.caches?.streamEntries || 0), 0),
        streamInFlight: snapshots.reduce((sum, snapshot) => sum + Number(snapshot?.caches?.streamInFlight || 0), 0)
      },
      recentErrors: snapshots
        .flatMap((snapshot) => Array.isArray(snapshot?.recentErrors) ? snapshot.recentErrors : [])
        .sort((left, right) => Date.parse(right.time || '') - Date.parse(left.time || ''))
        .slice(0, SPORTS_ROUTE_ERROR_MAX)
    };
    return metrics;
  };

  const isCdnLiveTvSportsEventId = (eventId = '') => {
    const raw = String(eventId || '').toLowerCase();
    if (raw.includes('cdnlivetv')) return true;
    try {
      return decodeURIComponent(raw).toLowerCase().includes('cdnlivetv');
    } catch {
      return false;
    }
  };

  const pruneSportsStreamResponseCache = () => {
    const now = Date.now();
    for (const [key, entry] of sportsStreamResponseCache) {
      if (entry.expiresAt <= now) sportsStreamResponseCache.delete(key);
    }
    while (sportsStreamResponseCache.size > SPORTS_STREAM_RESPONSE_CACHE_MAX) {
      sportsStreamResponseCache.delete(sportsStreamResponseCache.keys().next().value);
    }
  };

  const resolveSportsEventStreams = async ({ eventId, baseUrl, playbackConfigId, prewarm = true, cacheTtlMs = SPORTS_STREAM_RESPONSE_TTL_MS, includeQuotaSources = false }) => {
    const cacheKey = `${playbackConfigId}:${eventId}`;
    const useCache = Number(cacheTtlMs) > 0;
    if (useCache) {
      const cached = sportsStreamResponseCache.get(cacheKey);
      if (cached?.expiresAt > Date.now()) {
        sportsRouteMetrics.cacheStats.stream.hits += 1;
        return cached.streams;
      }
      sportsRouteMetrics.cacheStats.stream.misses += 1;
    } else {
      sportsRouteMetrics.cacheStats.stream.misses += 1;
    }
    if (sportsStreamResponseInFlight.has(cacheKey)) return sportsStreamResponseInFlight.get(cacheKey);

    const task = (async () => {
      const deadlineController = new AbortController();
      let deadlineTimer = null;
      try {
        const deadline = new Promise((_, reject) => {
          deadlineTimer = setTimeout(() => {
            const error = new Error('Nebula Sports stream resolution exceeded 20 seconds');
            deadlineController.abort(error);
            reject(error);
          }, 20_000);
          deadlineTimer.unref?.();
        });
        const streams = await Promise.race([
          streamManager.streamedSportsAdapter.getEventStreams(eventId, {
            baseUrl,
            privateConfigId: playbackConfigId,
            prewarm,
            includeQuotaSources,
            signal: deadlineController.signal
          }),
          deadline
        ]);
        if (useCache) {
          sportsStreamResponseCache.set(cacheKey, {
            streams,
            expiresAt: Date.now() + (streams.length ? cacheTtlMs : SPORTS_STREAM_EMPTY_TTL_MS)
          });
          pruneSportsStreamResponseCache();
        }
        return streams;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
    })().finally(() => {
      sportsStreamResponseInFlight.delete(cacheKey);
    });
    sportsStreamResponseInFlight.set(cacheKey, task);
    return task;
  };

  const runSportsLivePrewarm = async () => {
    if (sportsLivePrewarmState.running) return;
    if (!sportsLivePrewarmState.accountId || !sportsLivePrewarmState.baseUrl) return;
    if (Date.now() - sportsLivePrewarmState.lastSeenAt > SPORTS_LIVE_PREWARM_IDLE_STOP_MS) {
      if (sportsLivePrewarmState.timer) {
        clearInterval(sportsLivePrewarmState.timer);
        sportsLivePrewarmState.timer = null;
      }
      sportsLivePrewarmState.accountId = '';
      sportsLivePrewarmState.baseUrl = '';
      return;
    }

    const account = sportsSupporterService.getAccount(sportsLivePrewarmState.accountId);
    if (!sportsSupporterService.isAccountActive(account) || isFreeSportsTier(account)) return;

    sportsLivePrewarmState.running = true;
    try {
      const playbackConfigId = await ensureSportsPlaybackConfigId(account);
      const result = await streamManager.streamedSportsAdapter.prewarmLiveEventStreams({
        baseUrl: sportsLivePrewarmState.baseUrl,
        privateConfigId: playbackConfigId,
        limit: 6,
        signal: AbortSignal.timeout(24_000)
      });
      if (result && !result.skipped) {
        logger.info('nebula sports live stream prewarm complete', result);
      }
    } catch (error) {
      logger.info('nebula sports live stream prewarm failed', {
        error: error?.message || String(error)
      });
    } finally {
      sportsLivePrewarmState.running = false;
    }
  };

  const touchSportsLivePrewarm = (account, req) => {
    if (!sportsSupporterService.isAccountActive(account) || isFreeSportsTier(account)) return;
    sportsLivePrewarmState.accountId = account.id;
    sportsLivePrewarmState.baseUrl = getPublicBaseUrl(req);
    sportsLivePrewarmState.lastSeenAt = Date.now();
    if (!sportsLivePrewarmState.timer) {
      sportsLivePrewarmState.timer = setInterval(() => {
        void runSportsLivePrewarm();
      }, SPORTS_LIVE_PREWARM_INTERVAL_MS);
      sportsLivePrewarmState.timer.unref?.();
    }
    void runSportsLivePrewarm();
  };

  const sendSportsStreams = async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const account = await getSportsAccountFromInstall(req, res);
      if (!account) return;
      touchSportsLivePrewarm(account, req);
      const freeTier = isFreeSportsTier(account);
      const playbackConfigId = await ensureSportsPlaybackConfigId(account);
      const cdnLiveTvEvent = isCdnLiveTvSportsEventId(req.params.id);
      let streams = [];
      try {
        streams = await resolveSportsEventStreams({
          eventId: req.params.id,
          baseUrl: getPublicBaseUrl(req),
          playbackConfigId,
          prewarm: !freeTier,
          includeQuotaSources: !freeTier,
          cacheTtlMs: cdnLiveTvEvent ? 0 : (freeTier ? SPORTS_STREAM_RESPONSE_TTL_MS : SPORTS_STREAM_RESPONSE_PAID_TTL_MS)
        });
      } catch (error) {
        logger.warn('nebula sports stream resolution deadline reached', {
          id: String(req.params.id || '').slice(0, 160),
          error: error?.message || String(error)
        });
      }
      const expiryCard = buildSportsTrialExpiryStreamCard(account, req);
      const updateCard = shouldShowSportsUpdateNotice(account) ? buildSportsUpdateNoticeStreamCard(req) : null;
      const freeTierEligibleStreams = freeTier
        ? streams.filter((stream) => !isCdnLiveTvSportsStream(stream))
        : streams;
      const playableStreams = freeTier && freeTierEligibleStreams.length ? freeTierEligibleStreams.slice(0, 2) : freeTierEligibleStreams;
      const responseStreams = [
        ...(expiryCard ? [expiryCard] : []),
        ...(playableStreams.length ? playableStreams : [buildSportsNoStreamsCard(req)]),
        ...(freeTier && streams.length ? [buildSportsFreeUpgradeStreamCard(req)] : []),
        ...(updateCard ? [updateCard] : [])
      ];
      void sportsSupporterService.increment(account.id, 'streams', 1).catch((error) => {
        logger.debug?.('sports stream stat increment failed', { error: error?.message || String(error) });
      });
      recordSportsRouteMetric('stream', startedAt, { ok: true, status: 200 });
      res.setHeader('Cache-Control', 'no-store').json({ streams: responseStreams });
    } catch (error) {
      recordSportsRouteMetric('stream', startedAt, {
        ok: false,
        status: error?.statusCode || 500,
        error: error?.message || String(error)
      });
      next(error);
    }
  };

  app.get('/dashboard', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      res.status(200).type('html').send(renderDashboardPage({
        baseUrl: getPublicBaseUrl(req),
        account,
        wall: supporterService.getWall(),
        activeSection: typeof req.query.tab === 'string' ? req.query.tab : 'overview',
        errorMessage: typeof req.query.error === 'string' ? req.query.error : '',
        successMessage: typeof req.query.success === 'string' ? req.query.success : ''
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/sports', async (req, res, next) => {
    try {
      const account = await getSportsAccountFromRequest(req);
      const preview = await getSportsPagePreview();
      res.status(200).type('html').send(renderSportsPage({
        baseUrl: getPublicBaseUrl(req),
        account,
	        stats: sportsSupporterService.getStats(),
	        availableSports: preview.availableSports,
	        trendingEvents: preview.trendingEvents,
	        errorMessage: typeof req.query.error === 'string' ? req.query.error : '',
        successMessage: typeof req.query.success === 'string' ? req.query.success : ''
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/sports/configure', async (req, res, next) => {
    try {
      const account = await getSportsAccountFromRequest(req);
      if (!isPaidSportsSupporter(account)) {
        redirectSports(res, { error: 'Sign in with an active supporter account to open sports configuration' });
        return;
      }
      const catalogs = filterSportsCatalogsForAccount(
        await getSportsCatalogDefinitions({ timeoutMs: 4_000 }),
        account
      );
      res.status(200).type('html').send(renderSportsConfigurePage({
        baseUrl: getPublicBaseUrl(req),
        account,
        catalogs,
        errorMessage: typeof req.query.error === 'string' ? req.query.error : '',
        successMessage: typeof req.query.success === 'string' ? req.query.success : ''
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/sports/admin/status', requireAdminAuth, async (req, res, next) => {
    try {
      const generatedAt = new Date().toISOString();
      const metrics = await getSportsAdminMetrics();
      const diagnostics = { ...(streamManager.streamedSportsAdapter.getDiagnostics?.() || {}) };
      delete diagnostics.knownSports;
      metrics.alerts = buildSportsAdminAlerts(metrics, diagnostics);
      if (String(req.query.format || '').toLowerCase() === 'json' || req.accepts(['html', 'json']) === 'json') {
        res.status(200).json({ generatedAt, metrics, diagnostics });
        return;
      }
      res.status(200).type('html').send(renderSportsAdminStatusPage({
        account: { username: config.ADMIN_USERNAME },
        metrics,
        diagnostics,
        generatedAt
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/sports/configure', async (req, res, next) => {
    try {
      const account = await getSportsAccountFromRequest(req);
      if (!isPaidSportsSupporter(account)) {
        redirectSports(res, { error: 'Active supporter access required' });
        return;
      }
      const catalogs = filterSportsCatalogsForAccount(
        await getSportsCatalogDefinitions({ timeoutMs: 4_000 }),
        account
      );
      const allowedSports = new Set(catalogs.map((catalog) => catalog.id));
      const requestedSports = Array.isArray(req.body?.sports)
        ? req.body.sports
        : (req.body?.sports ? [req.body.sports] : []);
      const timezone = String(req.body?.timezone || 'UTC').trim();
      try {
        new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
      } catch {
        throw new Error('Invalid timezone');
      }
      await sportsSupporterService.updateSportsConfig(account.id, {
        liveOnly: req.body?.liveOnly === '1',
        sports: requestedSports.map(String).filter((value) => allowedSports.has(value)),
        timezone
      });
      res.redirect(302, '/sports/configure?success=Configuration saved. Refresh or reinstall addon to apply.');
    } catch (error) {
      res.redirect(302, `/sports/configure?error=${encodeURIComponent(error?.message || 'Configuration failed')}`);
    }
  });

  const getWatchTogetherAccountFromRequest = async (req) => {
    const sessionAccount = await getSportsAccountFromRequest(req);
    if (sportsSupporterService.isAccountActive(sessionAccount)) {
      return sessionAccount;
    }
    const installKey = String(req.query.key || req.headers['x-nebula-sports-key'] || '').trim();
    if (!installKey) return null;
    const keyAccount = sportsSupporterService.getAccountByInstallKey(installKey);
    return sportsSupporterService.isAccountActive(keyAccount) ? keyAccount : null;
  };

  const getOptionalWatchTogetherAccount = async (req) => {
    await sportsSupporterService.initialize();
    return getWatchTogetherAccountFromRequest(req);
  };

  const WATCH_CHAT_MAX_MESSAGES = 150;
  const WATCH_CHAT_FILE = path.join(config.CACHE_DIR, 'watch-together-chat.json');
  const WATCH_CHAT_IDENTITY_FILE = path.join(config.CACHE_DIR, 'watch-together-chat-identities.json');
  const WATCH_EVENTS_RESPONSE_CACHE_MAX = 48;
  const watchChatPostTimes = new Map();
  let watchChatMessagesByEvent = null;
  let watchChatMessagesLoadedMtimeMs = 0;
  let watchChatIdentities = null;
  let watchChatWriteChain = Promise.resolve();
  let watchChatIdentityWriteChain = Promise.resolve();
  const watchChatResponseCache = new Map();
  const watchEventsResponseCache = new Map();
  const watchTogetherLiveSessions = new Map();
  const WATCH_TOGETHER_LIVE_DIR = path.join(config.CACHE_DIR, 'watch-together-live');
  const WATCH_TOGETHER_LIVE_TTL_MS = 70_000;

  const sanitizeWatchChatText = (value, maxLength) => String(value || '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);

  const sanitizeWatchChatEventId = (value) => String(value || '')
    .replace(/[^\w:.-]/gu, '')
    .slice(0, 160);

  const loadWatchChatMessages = async ({ force = false } = {}) => {
    let fileMtimeMs = 0;
    try {
      const stat = await fsPromises.stat(WATCH_CHAT_FILE);
      fileMtimeMs = Number(stat.mtimeMs || 0);
    } catch {
      fileMtimeMs = 0;
    }
    if (
      !force
      && watchChatMessagesByEvent
      && typeof watchChatMessagesByEvent === 'object'
      && watchChatMessagesLoadedMtimeMs === fileMtimeMs
    ) {
      return watchChatMessagesByEvent;
    }
    try {
      const payload = JSON.parse(await fsPromises.readFile(WATCH_CHAT_FILE, 'utf8'));
      const sourceEvents = payload?.events && typeof payload.events === 'object' ? payload.events : {};
      watchChatMessagesByEvent = Object.entries(sourceEvents).reduce((events, [eventId, messages]) => {
        const safeEventId = sanitizeWatchChatEventId(eventId);
        if (!safeEventId || !Array.isArray(messages)) return events;
        events[safeEventId] = messages
          .map((message) => ({
            id: String(message?.id || crypto.randomUUID()),
            name: sanitizeWatchChatText(message?.name, 24),
            text: sanitizeWatchChatText(message?.text, 240),
            createdAt: new Date(message?.createdAt || Date.now()).toISOString()
          }))
          .filter((message) => message.name && message.text)
          .slice(-WATCH_CHAT_MAX_MESSAGES);
        return events;
      }, {});
      watchChatMessagesLoadedMtimeMs = fileMtimeMs;
    } catch {
      watchChatMessagesByEvent = {};
      watchChatMessagesLoadedMtimeMs = fileMtimeMs;
    }
    return watchChatMessagesByEvent;
  };

  const getWatchChatMessagesForEvent = async (eventId) => {
    const safeEventId = sanitizeWatchChatEventId(eventId);
    if (!safeEventId) return [];
    const messagesByEvent = await loadWatchChatMessages();
    if (!Array.isArray(messagesByEvent[safeEventId])) messagesByEvent[safeEventId] = [];
    return messagesByEvent[safeEventId];
  };

  const persistWatchChatMessages = async () => {
    const payload = {
      updatedAt: new Date().toISOString(),
      events: watchChatMessagesByEvent || {}
    };
    watchChatResponseCache.clear();
    watchChatWriteChain = watchChatWriteChain
      .catch(() => {})
      .then(async () => {
        await fsPromises.mkdir(config.CACHE_DIR, { recursive: true });
        let mergedEvents = payload.events;
        try {
          const currentPayload = JSON.parse(await fsPromises.readFile(WATCH_CHAT_FILE, 'utf8'));
          const currentEvents = currentPayload?.events && typeof currentPayload.events === 'object'
            ? currentPayload.events
            : {};
          mergedEvents = { ...currentEvents };
          for (const [eventId, messages] of Object.entries(payload.events || {})) {
            const byId = new Map();
            for (const message of Array.isArray(currentEvents[eventId]) ? currentEvents[eventId] : []) {
              if (message?.id) byId.set(String(message.id), message);
            }
            for (const message of Array.isArray(messages) ? messages : []) {
              if (message?.id) byId.set(String(message.id), message);
            }
            mergedEvents[eventId] = [...byId.values()]
              .sort((left, right) => new Date(left?.createdAt || 0).getTime() - new Date(right?.createdAt || 0).getTime())
              .slice(-WATCH_CHAT_MAX_MESSAGES);
          }
        } catch {}
        const mergedPayload = {
          ...payload,
          events: mergedEvents
        };
        const tmpFile = `${WATCH_CHAT_FILE}.${process.pid}.${Date.now()}.tmp`;
        await fsPromises.writeFile(tmpFile, JSON.stringify(mergedPayload, null, 2), { mode: 0o600 });
        await fsPromises.rename(tmpFile, WATCH_CHAT_FILE);
        watchChatMessagesByEvent = mergedEvents;
        const stat = await fsPromises.stat(WATCH_CHAT_FILE).catch(() => null);
        watchChatMessagesLoadedMtimeMs = Number(stat?.mtimeMs || Date.now());
      })
      .catch((error) => {
        logger.warn('watch together chat write failed', { error: error?.message || String(error) });
      });
    return watchChatWriteChain;
  };

  const loadWatchChatIdentities = async () => {
    if (watchChatIdentities && typeof watchChatIdentities === 'object') return watchChatIdentities;
    try {
      const payload = JSON.parse(await fsPromises.readFile(WATCH_CHAT_IDENTITY_FILE, 'utf8'));
      watchChatIdentities = Object.entries(payload?.identities || {}).reduce((identities, [id, value]) => {
        const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 64);
        const safeName = sanitizeWatchChatText(value?.name || value, 24);
        if (safeId && safeName) identities[safeId] = safeName;
        return identities;
      }, {});
    } catch {
      watchChatIdentities = {};
    }
    return watchChatIdentities;
  };

  const persistWatchChatIdentities = async () => {
    const payload = {
      updatedAt: new Date().toISOString(),
      identities: watchChatIdentities || {}
    };
    watchChatIdentityWriteChain = watchChatIdentityWriteChain
      .catch(() => {})
      .then(async () => {
        await fsPromises.mkdir(config.CACHE_DIR, { recursive: true });
        await fsPromises.writeFile(WATCH_CHAT_IDENTITY_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
      })
      .catch((error) => {
        logger.warn('watch together chat identity write failed', { error: error?.message || String(error) });
      });
    return watchChatIdentityWriteChain;
  };

  const getWatchChatIdentityId = (req) => {
    const existing = parseCookies(req.headers.cookie || '')[WATCH_CHAT_COOKIE_NAME];
    const safeExisting = String(existing || '').replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 64);
    return safeExisting || crypto.randomUUID();
  };

  const sanitizeWatchLiveSessionId = (value) => String(value || '')
    .replace(/[^a-zA-Z0-9_-]/gu, '')
    .slice(0, 80);

  const pruneWatchTogetherLiveSessions = (now = Date.now()) => {
    for (const [sessionId, lastSeen] of watchTogetherLiveSessions.entries()) {
      if (now - lastSeen > WATCH_TOGETHER_LIVE_TTL_MS) {
        watchTogetherLiveSessions.delete(sessionId);
      }
    }
  };

  const getWatchTogetherLiveCount = () => {
    pruneWatchTogetherLiveSessions();
    return watchTogetherLiveSessions.size;
  };

  const persistWatchTogetherLiveSession = async (sessionId, lastSeen = Date.now()) => {
    const safeSessionId = sanitizeWatchLiveSessionId(sessionId);
    if (!safeSessionId) return;
    try {
      await fsPromises.mkdir(WATCH_TOGETHER_LIVE_DIR, { recursive: true });
      await fsPromises.writeFile(
        path.join(WATCH_TOGETHER_LIVE_DIR, `${safeSessionId}.json`),
        JSON.stringify({ lastSeen }),
        { mode: 0o600 }
      );
    } catch (error) {
      logger.debug?.('watch together live session persist failed', {
        error: error?.message || String(error)
      });
    }
  };

  const getWatchTogetherLiveCountShared = async () => {
    const now = Date.now();
    pruneWatchTogetherLiveSessions(now);
    let entries = [];
    try {
      entries = await fsPromises.readdir(WATCH_TOGETHER_LIVE_DIR, { withFileTypes: true });
    } catch {
      return watchTogetherLiveSessions.size;
    }

    await Promise.allSettled(entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.json')) return;
      const sessionId = sanitizeWatchLiveSessionId(entry.name.replace(/\.json$/u, ''));
      if (!sessionId) return;
      const filePath = path.join(WATCH_TOGETHER_LIVE_DIR, entry.name);
      let lastSeen = 0;
      try {
        const stat = await fsPromises.stat(filePath);
        const payload = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
        lastSeen = Math.max(Number(stat.mtimeMs || 0), Number(payload?.lastSeen || 0));
      } catch {
        lastSeen = 0;
      }
      if (!lastSeen || now - lastSeen > WATCH_TOGETHER_LIVE_TTL_MS) {
        await fsPromises.rm(filePath, { force: true }).catch(() => {});
        watchTogetherLiveSessions.delete(sessionId);
        return;
      }
      watchTogetherLiveSessions.set(sessionId, lastSeen);
    }));

    pruneWatchTogetherLiveSessions(now);
    return watchTogetherLiveSessions.size;
  };

  const WATCH_ADMIN_HISTORY_LIMIT = 360;
  const WATCH_ADMIN_SAMPLE_MIN_MS = 15_000;
  const watchTogetherAdminSamples = [];

  const parseWatchAdminAmount = (value) => {
    const parsed = Number.parseFloat(String(value || '').replace(/[^0-9.-]/gu, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const summarizeWatchAdminSportsStore = () => {
    const accounts = Object.values(sportsSupporterService.store?.accounts || {});
    const payments = Object.values(sportsSupporterService.store?.payments || {});
    const tokenRecords = Object.values(sportsSupporterService.store?.tokens || {});
    const totals = accounts.reduce((next, account) => {
      const stats = account?.stats || {};
      next.installs += Number(stats.installs || 0);
      next.manifests += Number(stats.manifests || 0);
      next.catalogs += Number(stats.catalogs || 0);
      next.streams += Number(stats.streams || 0);
      return next;
    }, { installs: 0, manifests: 0, catalogs: 0, streams: 0 });
    const activeAccounts = accounts.filter((account) => sportsSupporterService.isAccountActive(account));
    const trialAccounts = accounts.filter((account) => String(account?.tier || '') === 'trial');
    const paymentTotal = payments.reduce((total, payment) => total + parseWatchAdminAmount(payment?.amount), 0);
    const claimedTokens = tokenRecords.filter((token) => token?.claimedBy).length;
    return {
      activeAccounts: activeAccounts.length,
      trialAccounts: trialAccounts.length,
      accountStreams: totals.streams,
      accountCatalogs: totals.catalogs,
      accountManifests: totals.manifests,
      accountInstalls: totals.installs,
      claimedTokens,
      paymentTotal,
      paymentCurrency: payments.find((payment) => payment?.currency)?.currency || 'USD',
      paymentEmailCount: payments.filter((payment) => payment?.emailSentAt).length
    };
  };

  const buildWatchTogetherAdminSample = (stats) => ({
    at: Date.now(),
    liveVisitors: Number(stats.liveVisitors || 0),
    chatMessages: Number(stats.chatMessages || 0),
    chatEvents: Number(stats.chatEvents || 0),
    lockedChatNames: Number(stats.lockedChatNames || 0),
    chatResponseCacheEntries: Number(stats.chatResponseCacheEntries || 0),
    chatRateLimitClients: Number(stats.chatRateLimitClients || 0),
    sportsAccounts: Number(stats.sportsAccounts || 0),
    sportsActive: Number(stats.sportsActive || 0),
    sportsTrials: Number(stats.sportsTrials || 0),
    sportsTokens: Number(stats.sportsTokens || 0),
    sportsPayments: Number(stats.sportsPayments || 0),
    paymentTotal: Number(stats.paymentTotal || 0),
    accountStreams: Number(stats.accountStreams || 0),
    accountCatalogs: Number(stats.accountCatalogs || 0),
    accountManifests: Number(stats.accountManifests || 0),
    accountInstalls: Number(stats.accountInstalls || 0)
  });

  const recordWatchTogetherAdminSample = (stats) => {
    const now = Date.now();
    const last = watchTogetherAdminSamples[watchTogetherAdminSamples.length - 1];
    const sample = buildWatchTogetherAdminSample(stats);
    if (!last || now - Number(last.at || 0) >= WATCH_ADMIN_SAMPLE_MIN_MS) {
      watchTogetherAdminSamples.push(sample);
      while (watchTogetherAdminSamples.length > WATCH_ADMIN_HISTORY_LIMIT) {
        watchTogetherAdminSamples.shift();
      }
      return;
    }
    watchTogetherAdminSamples[watchTogetherAdminSamples.length - 1] = { ...sample, at: last.at };
  };

  const touchWatchTogetherLiveSession = (req, rawSessionId = req.body?.sessionId) => {
    const bodySessionId = sanitizeWatchLiveSessionId(rawSessionId);
    const fallbackSessionId = crypto
      .createHash('sha1')
      .update(`${getClientAddress(req)}:${req.headers?.['user-agent'] || ''}`)
      .digest('hex')
      .slice(0, 40);
    const sessionId = bodySessionId || fallbackSessionId;
    const now = Date.now();
    pruneWatchTogetherLiveSessions(now);
    watchTogetherLiveSessions.set(sessionId, now);
    void persistWatchTogetherLiveSession(sessionId, now);
    return watchTogetherLiveSessions.size;
  };

  const getWatchTogetherAdminStats = async () => {
    const messagesByEvent = await loadWatchChatMessages();
    const identities = await loadWatchChatIdentities();
    const sportsStats = sportsSupporterService.getStats();
    const sportsStoreStats = summarizeWatchAdminSportsStore();
    const chatEvents = Object.keys(messagesByEvent || {}).length;
    const chatMessages = Object.values(messagesByEvent || {})
      .reduce((total, messages) => total + (Array.isArray(messages) ? messages.length : 0), 0);
    const chatEventRows = Object.entries(messagesByEvent || {})
      .map(([eventId, messages]) => ({
        eventId,
        messages: Array.isArray(messages) ? messages.length : 0,
        lastMessageAt: Array.isArray(messages) && messages.length
          ? messages[messages.length - 1]?.createdAt || null
          : null
      }))
      .sort((left, right) => right.messages - left.messages)
      .slice(0, 10);
    const stats = {
      liveVisitors: await getWatchTogetherLiveCountShared(),
      liveTtlSeconds: Math.round(WATCH_TOGETHER_LIVE_TTL_MS / 1000),
      chatEvents,
      chatMessages,
      lockedChatNames: Object.keys(identities || {}).length,
      chatResponseCacheEntries: watchChatResponseCache.size,
      chatRateLimitClients: watchChatPostTimes.size,
      sportsAccounts: sportsStats.accounts || 0,
      sportsActive: sportsStats.active || 0,
      sportsTrials: sportsStats.trials || 0,
      sportsTokens: sportsStats.tokens || 0,
      sportsPayments: sportsStats.payments || 0,
      ...sportsStoreStats,
      chatEventRows
    };
    recordWatchTogetherAdminSample(stats);
    return { ...stats, history: watchTogetherAdminSamples };
  };

  const getWatchTogetherAdminLiveStats = async () => ({
    at: Date.now(),
    liveVisitors: await getWatchTogetherLiveCountShared(),
    liveTtlSeconds: Math.round(WATCH_TOGETHER_LIVE_TTL_MS / 1000)
  });

  const renderWatchTogetherAdminLogin = ({ errorMessage = '' } = {}) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Nebula Sports Admin</title>
  <style>
    :root{color-scheme:dark;--bg:#0b0d11;--surface:#151820;--line:rgba(255,255,255,.11);--text:#f7f8fb;--muted:#8f97a6;--accent:#4f9cff;--bad:#ff6b7a}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 25% 10%,rgba(79,156,255,.18),transparent 35%),linear-gradient(180deg,#0b0d11,#08090c);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .box{width:min(420px,calc(100% - 32px));border:1px solid var(--line);border-radius:16px;background:rgba(21,24,32,.9);box-shadow:0 24px 90px rgba(0,0,0,.42);padding:26px}
    h1{margin:0 0 6px;font-size:25px;letter-spacing:-.03em}p{margin:0 0 20px;color:var(--muted)}form{display:grid;gap:12px}label{display:grid;gap:6px;color:var(--muted);font-size:13px;font-weight:750}input{width:100%;height:42px;border:1px solid var(--line);border-radius:10px;background:#0c0f15;color:var(--text);padding:0 12px;font:inherit}input:focus{outline:0;border-color:rgba(79,156,255,.7);box-shadow:0 0 0 4px rgba(79,156,255,.12)}button{height:42px;border:0;border-radius:10px;background:var(--accent);color:white;font-weight:850;cursor:pointer}.err{margin-bottom:14px;color:#fecdd3;border:1px solid rgba(255,107,122,.4);background:rgba(255,107,122,.08);border-radius:10px;padding:10px 12px;font-size:13px}
  </style>
</head>
<body><main class="box"><h1>Nebula Sports Admin</h1><p>Watch-together analytics console.</p>${errorMessage ? `<div class="err">${escapeHtml(errorMessage)}</div>` : ''}<form method="post" action="/watch-together/admin/login"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Open console</button></form></main></body>
</html>`;

  const renderWatchTogetherAdminConsole = (stats = {}) => {
    const snapshot = JSON.stringify({
      liveVisitors: Number(stats.liveVisitors || 0),
      liveTtlSeconds: Number(stats.liveTtlSeconds || 0),
      chatEvents: Number(stats.chatEvents || 0),
      chatMessages: Number(stats.chatMessages || 0),
      lockedChatNames: Number(stats.lockedChatNames || 0),
      chatResponseCacheEntries: Number(stats.chatResponseCacheEntries || 0),
      chatRateLimitClients: Number(stats.chatRateLimitClients || 0),
      sportsAccounts: Number(stats.sportsAccounts || 0),
      sportsActive: Number(stats.sportsActive || 0),
      sportsTrials: Number(stats.sportsTrials || 0),
      trialAccounts: Number(stats.trialAccounts || 0),
      sportsTokens: Number(stats.sportsTokens || 0),
      sportsPayments: Number(stats.sportsPayments || 0),
      accountStreams: Number(stats.accountStreams || 0),
      accountCatalogs: Number(stats.accountCatalogs || 0),
      accountManifests: Number(stats.accountManifests || 0),
      accountInstalls: Number(stats.accountInstalls || 0),
      claimedTokens: Number(stats.claimedTokens || 0),
      paymentTotal: Number(stats.paymentTotal || 0),
      paymentCurrency: String(stats.paymentCurrency || 'USD'),
      paymentEmailCount: Number(stats.paymentEmailCount || 0),
      chatEventRows: Array.isArray(stats.chatEventRows) ? stats.chatEventRows : [],
      history: Array.isArray(stats.history) ? stats.history : []
    }).replace(/</gu, '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NebulaSports - Admin Analytics Console</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/nebula-sports-favicon-32.png">
  <style>
    :root{color-scheme:dark;--bg:#191918;--side:#151514;--surface:#191918;--hover:#242423;--text:#fff;--soft:rgba(255,255,255,.58);--faint:rgba(255,255,255,.32);--line:rgba(255,255,255,.14);--line-soft:rgba(255,255,255,.08);--blue:#5e9fe8;--green:#72bc8f;--yellow:#eac26b;--orange:#de9255;--red:#e97366;--cyan:#4fb9c9;--radius:8px;--page:900px}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45}.app{display:grid;grid-template-columns:174px 1fr;min-height:100vh}.sidebar{position:sticky;top:0;height:100vh;background:var(--side);border-right:1px solid var(--line);padding:18px 12px;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:9px;margin-bottom:22px}.logo{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;overflow:hidden;background:#0c1014;box-shadow:0 0 0 1px var(--line-soft)}.logo img{width:100%;height:100%;object-fit:cover}.brand strong{display:block;font-size:12px;line-height:1.1}.brand span{display:block;color:var(--faint);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}.nav{display:grid;gap:8px}.nav button{height:28px;border:0;border-radius:6px;background:transparent;color:var(--soft);font:inherit;font-size:12px;font-weight:650;text-align:left;padding:0 12px;display:flex;align-items:center;gap:8px;cursor:pointer}.nav button:hover{background:var(--hover);color:var(--text)}.nav button.active{background:rgba(94,159,232,.13);color:var(--blue)}.nav .group{margin:6px 0 -2px;color:var(--faint);font-size:11px;font-weight:800}.foot{margin-top:auto;color:var(--faint);font-size:10px;line-height:1.35}.logout{margin-top:10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--soft);height:28px;padding:0 10px;font:inherit;font-size:11px;cursor:pointer}.main{min-width:0}.topbar{height:54px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 22px;position:sticky;top:0;z-index:5;background:rgba(25,25,24,.94);backdrop-filter:blur(8px)}.crumb{font-size:10px;color:var(--faint);font-weight:750}.topbar h1{margin:0;font-size:17px;line-height:1.1}.tools{display:flex;align-items:center;gap:8px}.live{height:25px;border:1px solid var(--line);border-radius:999px;padding:0 12px;display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800}.dot{width:6px;height:6px;border-radius:50%;background:var(--green)}.seg{height:26px;background:var(--hover);border-radius:6px;padding:2px;display:flex}.seg button,.refresh{border:0;background:transparent;color:var(--soft);border-radius:5px;padding:0 11px;font:inherit;font-size:11px;font-weight:800;cursor:pointer}.seg button.active{background:#111;color:var(--text)}.refresh{height:26px;border:1px solid var(--line);color:var(--text)}.content{max-width:var(--page);padding:26px 22px 58px}.page{display:none}.page.active{display:block}.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px}.kpi,.card{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}.kpi{min-height:74px;padding:14px 14px 10px}.label{font-size:11px;color:var(--soft);font-weight:750}.value{font-size:20px;font-weight:850;letter-spacing:-.02em;margin-top:8px;font-variant-numeric:tabular-nums}.sub{font-size:10px;color:var(--faint);margin-top:5px}.delta{display:inline-flex;margin-top:8px;border-radius:999px;padding:1px 6px;font-size:10px;font-weight:800}.up{background:rgba(114,188,143,.12);color:var(--green)}.down{background:rgba(233,115,102,.12);color:var(--red)}.flat{background:rgba(255,255,255,.08);color:var(--soft)}.section-title{display:flex;align-items:baseline;gap:10px;margin:0 0 10px}.section-title h2{margin:0;font-size:13px}.hint{font-size:10px;color:var(--faint);font-weight:650}.grid{display:grid;gap:10px;margin-bottom:10px}.g2{grid-template-columns:1fr 1fr}.card{padding:14px}.card h3{margin:0;font-size:12px}.card p{margin:2px 0 0;color:var(--faint);font-size:10px}.chart{width:100%;display:block}.grid-line{stroke:var(--line-soft);stroke-width:1}.axis{fill:var(--faint);font-size:9px;font-weight:650}.ln{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.area{opacity:.14}.bar-row{display:grid;grid-template-columns:116px 1fr 44px;gap:10px;align-items:center;margin:10px 0;font-size:11px}.bar-row strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.track{height:7px;border-radius:999px;background:rgba(255,255,255,.14);overflow:hidden}.fill{height:100%;border-radius:999px}.num{text-align:right;color:var(--soft);font-variant-numeric:tabular-nums}.tbl{width:100%;border-collapse:collapse;font-size:11px}.tbl th,.tbl td{border-bottom:1px solid var(--line-soft);padding:9px 10px;text-align:left}.tbl th{color:var(--soft);font-weight:750}.badge{display:inline-flex;border-radius:999px;padding:2px 7px;font-size:10px;font-weight:800}.badge.b{background:rgba(94,159,232,.12);color:var(--blue)}.badge.g{background:rgba(114,188,143,.12);color:var(--green)}.empty{color:var(--faint);font-size:12px;padding:20px 0}.note{color:var(--faint);font-size:10px;border-top:1px solid var(--line-soft);padding-top:14px;margin-top:16px}a{color:inherit}@media(max-width:920px){.app{grid-template-columns:1fr}.sidebar{position:static;height:auto}.nav{grid-template-columns:repeat(2,minmax(0,1fr))}.foot{display:none}.kpis,.g2{grid-template-columns:1fr}.topbar{height:auto;gap:12px;align-items:flex-start;flex-direction:column;padding:14px 16px}.content{padding:18px 16px}.bar-row{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand"><div class="logo"><img src="/assets/nebula-sports-logo.png" alt=""></div><div><strong>NebulaSports</strong><span>Admin Console</span></div></div>
      <nav class="nav">
        <button class="active" data-page="overview">📊 Overview</button>
        <button data-page="viewership">👁️ Live Viewership</button>
        <div class="group">💳 Subscriptions & Revenue</div>
        <button data-page="revenue">💳 Revenue</button>
        <button data-page="health">📡 Stream Health</button>
        <button data-page="content">🏆 Top Content</button>
        <button data-page="growth">📈 User Growth</button>
      </nav>
      <form class="foot" method="post" action="/watch-together/admin/logout">
        <div>Real counters from this server. History starts when this process samples stats.</div>
        <button class="logout" type="submit">Logout</button>
      </form>
    </aside>
    <section class="main">
      <header class="topbar">
        <div><div class="crumb">NebulaSports › Analytics</div><h1 id="title">Overview</h1></div>
        <div class="tools">
          <span class="live"><span class="dot"></span><span id="liveNow">0</span> watching now</span>
          <div class="seg" id="range"><button data-days="7">7d</button><button class="active" data-days="30">30d</button><button data-days="90">90d</button></div>
          <button class="refresh" id="refresh" type="button">↻ Refresh</button>
        </div>
      </header>
      <main class="content">
        <section class="page active" id="page-overview"></section>
        <section class="page" id="page-viewership"></section>
        <section class="page" id="page-revenue"></section>
        <section class="page" id="page-health"></section>
        <section class="page" id="page-content"></section>
        <section class="page" id="page-growth"></section>
        <p class="note">No demo data. Values come from live sessions, chat storage, supporter storage, and runtime samples. Last refreshed: <span id="refreshed"></span>.</p>
      </main>
    </section>
  </div>
<script>
let SERVER=${snapshot};
let current='overview';
let days=30;
const titles={overview:'Overview',viewership:'Live Viewership & Concurrency',revenue:'Subscriptions & Revenue',health:'Stream Health & Quality',content:'Top Content',growth:'User Growth & Engagement'};
const colors={blue:'#5e9fe8',green:'#72bc8f',yellow:'#eac26b',orange:'#de9255',red:'#e97366',cyan:'#4fb9c9'};
const esc=(v)=>String(v==null?'':v).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n)=>{n=Number(n||0);return n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':Math.round(n).toLocaleString();};
const money=(n,c)=>new Intl.NumberFormat('en-US',{style:'currency',currency:c||'USD',maximumFractionDigits:2}).format(Number(n||0));
const pct=(n)=>Number(n||0).toFixed(1)+'%';
function nowSample(){return {at:Date.now(),liveVisitors:SERVER.liveVisitors,chatMessages:SERVER.chatMessages,chatEvents:SERVER.chatEvents,lockedChatNames:SERVER.lockedChatNames,chatResponseCacheEntries:SERVER.chatResponseCacheEntries,chatRateLimitClients:SERVER.chatRateLimitClients,sportsAccounts:SERVER.sportsAccounts,sportsActive:SERVER.sportsActive,sportsTrials:SERVER.sportsTrials,sportsTokens:SERVER.sportsTokens,sportsPayments:SERVER.sportsPayments,paymentTotal:SERVER.paymentTotal,accountStreams:SERVER.accountStreams,accountCatalogs:SERVER.accountCatalogs,accountManifests:SERVER.accountManifests,accountInstalls:SERVER.accountInstalls};}
function series(){const cutoff=Date.now()-days*86400000;let rows=(SERVER.history||[]).filter((x)=>Number(x.at||0)>=cutoff);if(!rows.length)rows=[nowSample()];return rows.map((x)=>Object.assign({},x,{date:new Date(Number(x.at||Date.now()))}));}
function firstLastDelta(rows,key){if(rows.length<2)return '<span class="delta flat">0%</span>';const a=Number(rows[0][key]||0),b=Number(rows[rows.length-1][key]||0);if(!a&&!b)return '<span class="delta flat">0%</span>';const d=a?((b-a)/a)*100:(b>0?100:0);return '<span class="delta '+(d>=0?'up':'down')+'">'+(d>=0?'↗ ':'↘ ')+pct(Math.abs(d))+'</span>';}
function kpi(label,value,sub,delta){return '<article class="kpi"><div class="label">'+esc(label)+'</div><div class="value">'+value+'</div><div class="sub">'+esc(sub||'')+'</div>'+(delta||'')+'</article>';}
function pageHtml(kpis,body){return '<div class="kpis">'+kpis.join('')+'</div>'+body;}
function sum(rows,key){return rows.reduce((t,x)=>t+Number(x[key]||0),0);}
function avg(rows,key){return rows.length?sum(rows,key)/rows.length:0;}
function max(rows,key){return rows.reduce((m,x)=>Math.max(m,Number(x[key]||0)),0);}
const NS='http://www.w3.org/2000/svg';
function svgEl(t,a,p){const e=document.createElementNS(NS,t);Object.keys(a||{}).forEach((k)=>e.setAttribute(k,a[k]));if(p)p.appendChild(e);return e;}
function lineChart(host,rows,key,color,opts){opts=opts||{};host.innerHTML='';const W=host.clientWidth||620,H=opts.h||190,L=42,R=12,T=14,B=24;const svg=svgEl('svg',{viewBox:'0 0 '+W+' '+H,height:H,class:'chart'},host);const vals=rows.map((x)=>Number(x[key]||0));const hi=Math.max(1,Math.max.apply(null,vals));const lo=opts.zero===false?Math.min.apply(null,vals):0;const span=hi-lo||1;const X=(i)=>L+(W-L-R)*(rows.length<=1?.5:i/(rows.length-1));const Y=(v)=>T+(H-T-B)*(1-(v-lo)/span);for(let i=0;i<4;i++){const y=T+(H-T-B)*i/3;svgEl('line',{x1:L,x2:W-R,y1:y,y2:y,class:'grid-line'},svg);svgEl('text',{x:8,y:y+3,class:'axis'},svg).textContent=fmt(hi-(span*i/3));}let d='',area='';rows.forEach((row,i)=>{const x=X(i),y=Y(Number(row[key]||0));d+=(i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)+' ';area+=(i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)+' ';svgEl('circle',{cx:x,cy:y,r:2,fill:color},svg);});if(rows.length){area+='L '+X(rows.length-1).toFixed(1)+' '+(H-B)+' L '+X(0).toFixed(1)+' '+(H-B)+' Z';svgEl('path',{d:area,fill:color,class:'area'},svg);svgEl('path',{d:d,stroke:color,class:'ln'},svg);[0,Math.floor((rows.length-1)/2),rows.length-1].forEach((i)=>svgEl('text',{x:X(i),y:H-7,'text-anchor':'middle',class:'axis'},svg).textContent=rows[i].date.toLocaleDateString('en-US',{month:'short',day:'numeric'}));}}
function bars(items){const top=Math.max(1,...items.map((x)=>Number(x.v||0)));return items.map((x)=>'<div class="bar-row"><strong>'+esc(x.n)+'</strong><div class="track"><div class="fill" style="width:'+((Number(x.v||0)/top)*100).toFixed(1)+'%;background:'+esc(x.c||colors.blue)+'"></div></div><span class="num">'+(x.f?x.f(x.v):fmt(x.v))+'</span></div>').join('');}
function chartCard(id,title,sub){return '<div class="section-title"><h2>'+esc(title)+'</h2>'+(sub?'<span class="hint">'+esc(sub)+'</span>':'')+'</div><div class="card"><div id="'+id+'"></div></div>';}
function renderOverview(){const rows=series();document.getElementById('page-overview').innerHTML=pageHtml([kpi('Peak concurrency',fmt(max(rows,'liveVisitors')),'Highest sampled live sessions',firstLastDelta(rows,'liveVisitors')),kpi('Subscribers',fmt(SERVER.sportsAccounts),'Supporter accounts',firstLastDelta(rows,'sportsAccounts')),kpi('Payments',money(SERVER.paymentTotal,SERVER.paymentCurrency),fmt(SERVER.sportsPayments)+' recorded payments',firstLastDelta(rows,'paymentTotal')),kpi('Chat messages',fmt(SERVER.chatMessages),'Stored watch chat messages',firstLastDelta(rows,'chatMessages')),kpi('Avg session TTL',fmt(SERVER.liveTtlSeconds)+'s','Live viewer expiry window','<span class="delta flat">server</span>')],chartCard('ovLive','Concurrent viewers','Daily runtime samples')+'<div class="grid g2"><div class="card"><h3>Usage by feature</h3>'+bars([{n:'Streams opened',v:SERVER.accountStreams,c:colors.blue},{n:'Catalog loads',v:SERVER.accountCatalogs,c:colors.green},{n:'Manifest loads',v:SERVER.accountManifests,c:colors.yellow},{n:'Installs',v:SERVER.accountInstalls,c:colors.orange}])+'</div><div class="card"><h3>Audience accounts</h3>'+bars([{n:'Active',v:SERVER.sportsActive,c:colors.green},{n:'Trials',v:SERVER.sportsTrials,c:colors.yellow},{n:'Claimed tokens',v:SERVER.claimedTokens,c:colors.blue},{n:'Chat names',v:SERVER.lockedChatNames,c:colors.cyan}])+'</div></div>');lineChart(document.getElementById('ovLive'),rows,'liveVisitors',colors.blue);}
function renderViewership(){const rows=series();document.getElementById('page-viewership').innerHTML=pageHtml([kpi('Peak concurrency',fmt(max(rows,'liveVisitors')),'Runtime high in selected range',firstLastDelta(rows,'liveVisitors')),kpi('Avg concurrency',fmt(avg(rows,'liveVisitors')),'Average sampled live sessions','<span class="delta flat">sampled</span>'),kpi('Watching now',fmt(SERVER.liveVisitors),'Live browser sessions','<span class="delta up">live</span>'),kpi('Stream opens',fmt(SERVER.accountStreams),'Authenticated stream requests',firstLastDelta(rows,'accountStreams')),kpi('Total samples',fmt(rows.length),'Runtime data points','<span class="delta flat">real</span>')],'<div class="section-title"><h2>Peak vs average concurrency</h2><span class="hint">Sampled from live-count API</span></div><div class="grid g2"><div class="card"><div id="vwLive"></div></div><div class="card"><div id="vwStreams"></div></div></div>');lineChart(document.getElementById('vwLive'),rows,'liveVisitors',colors.blue);lineChart(document.getElementById('vwStreams'),rows,'accountStreams',colors.yellow);}
function renderRevenue(){const rows=series();document.getElementById('page-revenue').innerHTML=pageHtml([kpi('Payment total',money(SERVER.paymentTotal,SERVER.paymentCurrency),'Recorded Ko-fi sports revenue',firstLastDelta(rows,'paymentTotal')),kpi('Payments',fmt(SERVER.sportsPayments),'Recorded transactions',firstLastDelta(rows,'sportsPayments')),kpi('Accounts',fmt(SERVER.sportsAccounts),'Total supporter accounts',firstLastDelta(rows,'sportsAccounts')),kpi('Active',fmt(SERVER.sportsActive),'Currently active access',firstLastDelta(rows,'sportsActive')),kpi('Trials',fmt(SERVER.sportsTrials),'Trial tokens issued',firstLastDelta(rows,'sportsTrials'))],chartCard('revPay','Recurring revenue signal','Real payment total over runtime samples')+'<div class="grid g2"><div class="card"><h3>Account state</h3>'+bars([{n:'Active accounts',v:SERVER.sportsActive,c:colors.green},{n:'Trial accounts',v:SERVER.trialAccounts,c:colors.yellow},{n:'All accounts',v:SERVER.sportsAccounts,c:colors.blue}])+'</div><div class="card"><h3>Token funnel</h3>'+bars([{n:'Tokens issued',v:SERVER.sportsTokens,c:colors.blue},{n:'Claimed tokens',v:SERVER.claimedTokens,c:colors.green},{n:'Payment emails',v:SERVER.paymentEmailCount,c:colors.orange}])+'</div></div>');lineChart(document.getElementById('revPay'),rows,'paymentTotal',colors.green);}
function renderHealth(){const rows=series();document.getElementById('page-health').innerHTML=pageHtml([kpi('Cache entries',fmt(SERVER.chatResponseCacheEntries),'Chat response cache',firstLastDelta(rows,'chatResponseCacheEntries')),kpi('Rate buckets',fmt(SERVER.chatRateLimitClients),'Active chat rate clients',firstLastDelta(rows,'chatRateLimitClients')),kpi('Locked names',fmt(SERVER.lockedChatNames),'Chat identities',firstLastDelta(rows,'lockedChatNames')),kpi('Catalog loads',fmt(SERVER.accountCatalogs),'Authenticated catalog requests',firstLastDelta(rows,'accountCatalogs')),kpi('Manifests',fmt(SERVER.accountManifests),'Authenticated manifest requests',firstLastDelta(rows,'accountManifests'))],'<div class="section-title"><h2>Server health counters</h2><span class="hint">No synthetic CDN or error-rate data</span></div><div class="grid g2"><div class="card"><div id="hlCache"></div></div><div class="card"><div id="hlRate"></div></div></div><div class="card"><h3>Delivered quality distribution</h3>'+bars([{n:'Streams',v:SERVER.accountStreams,c:colors.blue},{n:'Catalogs',v:SERVER.accountCatalogs,c:colors.green},{n:'Manifests',v:SERVER.accountManifests,c:colors.yellow},{n:'Installs',v:SERVER.accountInstalls,c:colors.orange}])+'</div>');lineChart(document.getElementById('hlCache'),rows,'chatResponseCacheEntries',colors.orange);lineChart(document.getElementById('hlRate'),rows,'chatRateLimitClients',colors.red);}
function renderContent(){const rows=SERVER.chatEventRows||[];const table=rows.length?rows.map((row,i)=>'<tr><td><strong>'+String(i+1)+'</strong></td><td>'+esc(row.eventId)+'</td><td><span class="badge b">Watch room</span></td><td>'+fmt(row.messages)+'</td><td>'+esc(row.lastMessageAt?new Date(row.lastMessageAt).toLocaleString():'-')+'</td><td><span class="badge g">Real</span></td></tr>').join(''):'<tr><td colspan="6"><div class="empty">No chat activity tracked yet.</div></td></tr>';document.getElementById('page-content').innerHTML=pageHtml([kpi('Events tracked',fmt(SERVER.chatEvents),'Watch rooms with chat storage',''),kpi('Total messages',fmt(SERVER.chatMessages),'Stored chat messages',''),kpi('Stream opens',fmt(SERVER.accountStreams),'Authenticated stream requests',''),kpi('Catalog loads',fmt(SERVER.accountCatalogs),'Authenticated catalog requests',''),kpi('Live now',fmt(SERVER.liveVisitors),'Current browser sessions','')],'<div class="section-title"><h2>Top matches & events</h2><span class="hint">Ranked by stored chat activity</span></div><div class="card"><table class="tbl"><thead><tr><th>#</th><th>Event ID</th><th>Type</th><th>Messages</th><th>Last activity</th><th>Source</th></tr></thead><tbody>'+table+'</tbody></table></div><div class="grid g2"><div class="card"><h3>Views by system area</h3>'+bars([{n:'Streams',v:SERVER.accountStreams,c:colors.blue},{n:'Catalogs',v:SERVER.accountCatalogs,c:colors.green},{n:'Manifests',v:SERVER.accountManifests,c:colors.yellow},{n:'Installs',v:SERVER.accountInstalls,c:colors.orange}])+'</div><div class="card"><h3>Chat by event</h3>'+bars((rows.length?rows:[{eventId:'No events yet',messages:0}]).slice(0,5).map((row)=>({n:row.eventId,v:row.messages,c:colors.cyan})))+'</div></div>');}
function renderGrowth(){const rows=series();document.getElementById('page-growth').innerHTML=pageHtml([kpi('Accounts',fmt(SERVER.sportsAccounts),'Total supporter accounts',firstLastDelta(rows,'sportsAccounts')),kpi('Active accounts',fmt(SERVER.sportsActive),'Valid access now',firstLastDelta(rows,'sportsActive')),kpi('Trial tokens',fmt(SERVER.sportsTrials),'Trials issued',firstLastDelta(rows,'sportsTrials')),kpi('Tokens',fmt(SERVER.sportsTokens),'All sports tokens',firstLastDelta(rows,'sportsTokens')),kpi('Chat identities',fmt(SERVER.lockedChatNames),'Named chat users',firstLastDelta(rows,'lockedChatNames'))],'<div class="section-title"><h2>Daily active users</h2><span class="hint">Runtime sampled accounts and chat identity growth</span></div><div class="grid g2"><div class="card"><div id="grAccounts"></div></div><div class="card"><div id="grChat"></div></div></div><div class="card"><h3>Retention cohort proxy</h3>'+bars([{n:'Active / total',v:SERVER.sportsAccounts?SERVER.sportsActive/SERVER.sportsAccounts*100:0,c:colors.green,f:pct},{n:'Claimed / tokens',v:SERVER.sportsTokens?SERVER.claimedTokens/SERVER.sportsTokens*100:0,c:colors.blue,f:pct},{n:'Trials / tokens',v:SERVER.sportsTokens?SERVER.sportsTrials/SERVER.sportsTokens*100:0,c:colors.yellow,f:pct}])+'</div>');lineChart(document.getElementById('grAccounts'),rows,'sportsAccounts',colors.cyan);lineChart(document.getElementById('grChat'),rows,'lockedChatNames',colors.orange);}
const renderers={overview:renderOverview,viewership:renderViewership,revenue:renderRevenue,health:renderHealth,content:renderContent,growth:renderGrowth};
function render(){document.getElementById('liveNow').textContent=fmt(SERVER.liveVisitors);document.getElementById('refreshed').textContent=new Date().toLocaleTimeString();renderers[current]();}
function select(page){current=page;document.querySelectorAll('.nav button[data-page]').forEach((button)=>button.classList.toggle('active',button.dataset.page===page));document.querySelectorAll('.page').forEach((el)=>el.classList.toggle('active',el.id==='page-'+page));document.getElementById('title').textContent=titles[page];render();}
document.querySelectorAll('.nav button[data-page]').forEach((button)=>button.addEventListener('click',()=>select(button.dataset.page)));
document.getElementById('range').addEventListener('click',(event)=>{const button=event.target.closest('button');if(!button)return;days=Number(button.dataset.days||30);document.querySelectorAll('#range button').forEach((item)=>item.classList.toggle('active',item===button));render();});
document.getElementById('refresh').addEventListener('click',async()=>{const response=await fetch('/watch-together/admin/api/stats',{cache:'no-store'});if(response.ok){SERVER=await response.json();render();}});
async function refreshLiveOnly(){try{const response=await fetch('/watch-together/admin/api/live',{cache:'no-store'});if(!response.ok)return;const live=await response.json();SERVER.liveVisitors=Number(live.liveVisitors||0);SERVER.liveTtlSeconds=Number(live.liveTtlSeconds||SERVER.liveTtlSeconds||0);const sample=nowSample();sample.at=Number(live.at||Date.now());if(!Array.isArray(SERVER.history))SERVER.history=[];const last=SERVER.history[SERVER.history.length-1];if(!last||sample.at-Number(last.at||0)>=10000){SERVER.history.push(sample);}else{SERVER.history[SERVER.history.length-1]=Object.assign({},last,{liveVisitors:sample.liveVisitors});}while(SERVER.history.length>360)SERVER.history.shift();render();}catch{}}
setInterval(()=>{if(!document.hidden)refreshLiveOnly();},10000);
render();
</script>
</body>
</html>`;
  };

  const checkWatchChatRateLimit = (req) => {
    const key = getClientAddress(req);
    const now = Date.now();
    const recent = (watchChatPostTimes.get(key) || []).filter((time) => now - time < 60_000);
    if (recent.length && now - recent[recent.length - 1] < 3_000) {
      return 'Slow down before sending another message.';
    }
    if (recent.length >= 20) {
      return 'Chat rate limit reached. Try again later.';
    }
    recent.push(now);
    watchChatPostTimes.set(key, recent);
    if (watchChatPostTimes.size > 2_000) {
      for (const [entryKey, times] of watchChatPostTimes.entries()) {
        if (!times.some((time) => now - time < 60_000)) watchChatPostTimes.delete(entryKey);
        if (watchChatPostTimes.size <= 1_500) break;
      }
    }
    return '';
  };

  const hasWatchTogetherAdminSession = (req) => hasValidAdminSession(req);

  const requireWatchTogetherAdminAuth = (req, res, next) => {
    if (hasWatchTogetherAdminSession(req)) {
      next();
      return;
    }
    res.redirect(302, '/watch-together/admin/login');
  };

  app.get('/watch-together/admin/login', (req, res) => {
    if (hasWatchTogetherAdminSession(req)) {
      res.redirect(302, '/watch-together/admin');
      return;
    }
    res
      .status(200)
      .setHeader('Cache-Control', 'no-store')
      .type('html')
      .send(renderWatchTogetherAdminLogin({
        errorMessage: req.query.error === 'invalid' ? 'Invalid admin credentials.' : ''
      }));
  });

  app.post('/watch-together/admin/login', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (username !== config.ADMIN_USERNAME || password !== config.ADMIN_PASSWORD) {
      res.redirect(302, '/watch-together/admin/login?error=invalid');
      return;
    }
    setAdminSessionCookie(req, res);
    res.redirect(302, '/watch-together/admin');
  });

  app.post('/watch-together/admin/logout', (_req, res) => {
    clearAdminSessionCookie(res);
    res.redirect(302, '/watch-together/admin/login');
  });

  app.get('/watch-together/admin/api/stats', requireWatchTogetherAdminAuth, async (_req, res, next) => {
    try {
      res
        .setHeader('Cache-Control', 'no-store')
        .json(await getWatchTogetherAdminStats());
    } catch (error) {
      next(error);
    }
  });

  app.get('/watch-together/admin/api/live', requireWatchTogetherAdminAuth, (_req, res) => {
    res
      .setHeader('Cache-Control', 'no-store')
      .json(getWatchTogetherAdminLiveStats());
  });

  app.get('/watch-together/admin', requireWatchTogetherAdminAuth, async (_req, res, next) => {
    try {
      res
        .status(200)
        .setHeader('Cache-Control', 'no-store')
        .type('html')
        .send(renderWatchTogetherAdminConsole(await getWatchTogetherAdminStats()));
    } catch (error) {
      next(error);
    }
  });

  app.get('/watch-together/manifest.webmanifest', (req, res) => {
    res
      .status(200)
      .setHeader('Cache-Control', 'public, max-age=3600')
      .type('application/manifest+json')
      .send(JSON.stringify(renderWatchTogetherWebManifest(getPublicBaseUrl(req))));
  });

  app.get('/watch-together/sw.js', (req, res) => {
    res
      .status(200)
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Service-Worker-Allowed', '/watch-together')
      .type('application/javascript')
      .send(renderWatchTogetherServiceWorker());
  });

  app.get('/watch-together/offline', (req, res) => {
    res
      .status(200)
      .setHeader('Cache-Control', 'public, max-age=3600')
      .type('html')
      .send(renderWatchTogetherOfflinePage(getPublicBaseUrl(req)));
  });

  app.get('/watch-together', async (req, res, next) => {
    try {
      touchWatchTogetherLiveSession(req);
      const account = await getWatchTogetherAccountFromRequest(req);
      res
        .status(200)
        .setHeader('Cache-Control', 'no-store')
        .type('html')
        .send(renderWatchTogetherPage({
          baseUrl: getPublicBaseUrl(req),
          account,
          errorMessage: typeof req.query.error === 'string' ? req.query.error : ''
        }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/watch-together/api/catalogs', async (req, res, next) => {
    try {
      const catalogs = filterSportsCatalogsForAccount(
        await getSportsCatalogDefinitions({ timeoutMs: 4_000 }),
        null
      );
      res
        .setHeader('Cache-Control', 'public, max-age=30')
        .json({ catalogs });
    } catch (error) {
      next(error);
    }
  });

  app.get('/watch-together/api/events', async (req, res, next) => {
    const requestedCatalogId = String(req.query.catalog || 'streamed-events-live').trim();
    const search = String(req.query.search || '').trim();
    const skip = Number.parseInt(req.query.skip || '0', 10) || 0;
    const cacheKey = `${requestedCatalogId}:${skip}:${search.toLowerCase()}`;
    try {
      const catalogs = filterSportsCatalogsForAccount(
        await getSportsCatalogDefinitions({ timeoutMs: 4_000 }),
        null
      );
      const catalog = catalogs.find((entry) => entry.id === requestedCatalogId)
        || catalogs.find((entry) => entry.id === 'streamed-events-live')
        || catalogs[0];
      if (!catalog) {
        res.json({ events: [] });
        return;
      }
      const events = await streamManager.streamedSportsAdapter.getEventCatalog({
        catalog,
        search,
        skip,
        limit: 60,
        signal: AbortSignal.timeout(5_000)
      });
      const payload = {
        catalog,
        events: events.map((event) => decorateSportsMeta(event, req))
      };
      watchEventsResponseCache.set(cacheKey, payload);
      if (watchEventsResponseCache.size > WATCH_EVENTS_RESPONSE_CACHE_MAX) {
        watchEventsResponseCache.delete(watchEventsResponseCache.keys().next().value);
      }
      res
        .setHeader('Cache-Control', 'public, max-age=20')
        .json(payload);
    } catch (error) {
      logger.warn?.('watch together events route failed', {
        catalog: requestedCatalogId,
        search,
        error: error?.message || String(error)
      });
      const cached = watchEventsResponseCache.get(cacheKey);
      if (cached) {
        res
          .setHeader('Cache-Control', 'public, max-age=5')
          .setHeader('X-Nebula-Stale', '1')
          .json({ ...cached, stale: true });
        return;
      }
      res
        .setHeader('Cache-Control', 'no-store')
        .setHeader('X-Nebula-Stale', '1')
        .json({
          catalog: { type: 'tv', id: requestedCatalogId, name: 'Sports Events' },
          events: [],
          stale: true,
          error: 'Events unavailable. Try again.'
        });
    }
  });

  app.get('/watch-together/api/streams/:id', async (req, res, next) => {
    try {
      const account = await getOptionalWatchTogetherAccount(req);
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const result = await streamManager.streamedSportsAdapter.getEventEmbedStreams(req.params.id, {
        baseUrl,
        signal: AbortSignal.timeout(8_000)
      });
      const includeDirectPlayback = String(req.query?.webos || req.query?.direct || '').toLowerCase() === '1'
        || String(req.query?.webos || req.query?.direct || '').toLowerCase() === 'true';
      const streams = includeDirectPlayback
        ? result.streams.map((stream) => ({
          ...stream,
          url: `${baseUrl}/watch-together/hls/${encodeURIComponent(stream.source)}/${encodeURIComponent(stream.streamId || stream.id)}/${encodeURIComponent(String(stream.streamNo || 1))}.m3u8`
        }))
        : result.streams;
      if (account) {
        await sportsSupporterService.increment(account.id, 'streams', 1).catch((error) => {
          logger.warn('watch together optional stream stat failed', {
            error: error?.message || String(error)
          });
        });
      }
      res
        .setHeader('Cache-Control', 'no-store')
        .json({
          event: result.match ? decorateSportsMeta(streamManager.streamedSportsAdapter.toEventMeta(result.match), req) : null,
          streams
        });
    } catch (error) {
      next(error);
    }
  });

  app.get('/watch-together/hls/:source/:streamId/:streamNo.:extension', async (req, res, next) => {
    try {
      let hlsHeaders = null;
      let hlsContextUrl = '';
      const routeSignal = req.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([req.signal, AbortSignal.timeout(18_000)])
        : AbortSignal.timeout(18_000);
      const upstreamUrl = req.query.url
        ? Buffer.from(String(req.query.url), 'base64url').toString('utf8')
        : (await streamManager.streamedSportsAdapter.resolvePlayableHls({
          source: req.params.source,
          streamId: req.params.streamId,
          streamNo: req.params.streamNo,
          signal: routeSignal
        }).then((hls) => {
          hlsHeaders = hls?.headers || null;
          hlsContextUrl = hls?.contextUrl || '';
          return hls?.url;
        }).catch(async (error) => {
          logger.warn('watch together public hls primary failed; trying fallback', {
            source: req.params.source,
            streamNo: req.params.streamNo,
            error: error?.message || String(error)
          });
          const fallback = await streamManager.streamedSportsAdapter.resolveFallbackPlayableHls({
            source: req.params.source,
            streamId: req.params.streamId,
            streamNo: req.params.streamNo,
            signal: routeSignal
          });
          hlsHeaders = fallback?.headers || null;
          hlsContextUrl = fallback?.contextUrl || '';
          return fallback?.url;
        }));
      if (req.query.ctx) {
        hlsContextUrl = Buffer.from(String(req.query.ctx), 'base64url').toString('utf8');
      }

      if (!/^https?:\/\//iu.test(String(upstreamUrl || ''))) {
        throw new Error('Invalid watch together HLS URL');
      }

      const proxyReq = Object.create(req);
      proxyReq.params = {
        ...req.params,
        privateConfigId: '__watch_together__'
      };

      await streamManager.proxyStreamedSportsUpstream({
        req: proxyReq,
        res,
        upstreamUrl,
        source: req.params.source,
        streamId: req.params.streamId,
        streamNo: req.params.streamNo,
        hlsHeaders,
        hlsContextUrl
      });
    } catch (error) {
      next(error);
    }
  });

  const renderHelloSportsPlayerPage = ({ source = null, errorMessage = '' } = {}) => {
    const title = source ? `NebulaSports #${source.streamNo}` : 'Live Stream';
    const sourceUrl = source?.embedUrl || '';
    const isOkEmbed = /^https?:\/\/(?:www\.)?ok\.ru\/videoembed\//iu.test(sourceUrl);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    html,body{margin:0;width:100%;height:100%;background:#050608;color:#eef2f0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .shell{position:fixed;inset:0;background:#050608;overflow:hidden}
    .player-crop{position:absolute;inset:0;overflow:hidden;background:#050608}
    iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#050608}
    .message{max-width:360px;text-align:center;color:#9aa3af;font-size:13px;line-height:1.45;padding:18px}
    .message strong{display:block;color:#f8fbff;font-size:15px;margin-bottom:6px}
  </style>
</head>
<body>
  <main class="shell">
    ${errorMessage ? `<div class="message"><strong>Source unavailable</strong><span>${escapeHtml(errorMessage)}</span></div>` : `<div class="player-crop"><iframe src="${escapeHtml(sourceUrl)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"${isOkEmbed ? ' sandbox="allow-forms allow-pointer-lock allow-same-origin allow-scripts"' : ''}></iframe></div>`}
  </main>
</body>
</html>`;
  };

  const handleNebulaSportsExternalPlayer = async (req, res) => {
    try {
      const source = streamManager.streamedSportsAdapter.getLicensedExternalEmbedSource(req.params.id);
      if (!source) throw new Error('Unknown NebulaSports source');
      res
        .status(200)
        .setHeader('Cache-Control', 'no-store')
        .type('html')
        .send(renderHelloSportsPlayerPage({ source }));
    } catch (error) {
      logger.warn('hellosports clean player failed', {
        id: req.params.id,
        error: error?.message || String(error)
      });
      res
        .status(200)
        .setHeader('Cache-Control', 'no-store')
        .type('html')
        .send(renderHelloSportsPlayerPage({ errorMessage: error?.message || 'Unable to load this source.' }));
    }
  };

  app.get('/watch-together/nebulasports/:id', handleNebulaSportsExternalPlayer);
  app.get('/watch-together/hellosports/:id', handleNebulaSportsExternalPlayer);

  app.get('/watch-together/api/football-stats/:id', async (req, res) => {
    const event = {
      id: req.params.id,
      name: req.query?.name,
      releaseInfo: req.query?.releaseInfo,
      genres: String(req.query?.genres || '').split(',').map((genre) => genre.trim()).filter(Boolean),
      tournament: req.query?.tournament,
      competition: req.query?.competition,
      description: req.query?.description
    };
    if (!isWorldCupFootballMetadata(event)) {
      res
        .setHeader('Cache-Control', 'no-store')
        .json({ worldCup: false, available: false });
      return;
    }
    try {
      res
        .setHeader('Cache-Control', `private, max-age=${Math.max(5, Math.floor(config.API_FOOTBALL_STATS_CACHE_MS / 1000))}`)
        .json(await buildApiFootballStatsPayload(event));
    } catch (error) {
      logger.warn('watch together world cup stats unavailable', {
        eventId: event.id,
        error: error?.message || String(error)
      });
      res
        .setHeader('Cache-Control', 'no-store')
        .json(buildUnavailableWorldCupFootballStats(event));
    }
  });

  app.get('/watch-together/api/live-count', async (req, res) => {
    if (req.query?.sessionId) {
      touchWatchTogetherLiveSession(req, req.query.sessionId);
    }
    const count = await getWatchTogetherLiveCountShared();
    res
      .setHeader('Cache-Control', 'no-store')
      .json({ count });
  });

  app.post('/watch-together/api/live-count', async (req, res) => {
    touchWatchTogetherLiveSession(req);
    const count = await getWatchTogetherLiveCountShared();
    res
      .setHeader('Cache-Control', 'no-store')
      .json({ count });
  });

  app.get('/watch-together/api/chat', async (req, res, next) => {
    try {
      res
        .setHeader('Cache-Control', 'no-store')
        .status(410)
        .json({ messages: [], disabled: true, provider: 'cbox' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/watch-together/api/chat', async (req, res, next) => {
    try {
      res
        .setHeader('Cache-Control', 'no-store')
        .status(410)
        .json({ error: 'Nebula chat moved to Cbox.', disabled: true, provider: 'cbox' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/sports/trial/request', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim();
      const created = await sportsSupporterService.createTrialToken({
        email,
        ip: getClientAddress(req),
        subnet: getClientSubnet(req)
      });

      if (created.created) {
        try {
          await emailService.sendSportsTrialToken({
            to: created.normalizedEmail || email,
            code: created.code,
            expiresAt: created.expiresAt,
            baseUrl: getPublicBaseUrl(req)
          });
        } catch (error) {
          await sportsSupporterService.revokeToken(created.hash, { releaseTrial: true });
          throw error;
        }
        logger.info('nebula sports trial token sent', {
          tokenHashPrefix: String(created.hash || '').slice(0, 12),
          ip: getClientAddress(req),
          subnet: getClientSubnet(req)
        });
      } else {
        logger.warn('nebula sports trial request suppressed', {
          reason: created.reason,
          ip: getClientAddress(req),
          subnet: getClientSubnet(req)
        });
      }

      redirectSports(res, { success: 'If eligible, trial email sent. Check inbox or spam.' });
    } catch (error) {
      logger.error('nebula sports trial request failed', {
        error: error?.message || String(error),
        ip: getClientAddress(req)
      });
      redirectSports(res, { success: 'If eligible, trial email sent. Check inbox or spam.' });
    }
  });

  const normalizeSportsTokenCode = (value) =>
    String(value || '').trim().replace(/\s+/gu, '').toUpperCase();
  const getSportsTokenHashCandidates = (tokenCode) => {
    const normalizedCode = normalizeSportsTokenCode(tokenCode);
    if (!normalizedCode) return [];
    const secrets = [
      config.SUPPORTER_CODE_SECRET,
      process.env.SUPPORTER_CODE_SECRET,
      process.env.ADMIN_PASSWORD,
      process.env.STREMIO_ADDON_ID,
      'nebulastreams-supporters',
      'community.nebulastreams',
      'sohil@123'
    ]
      .map((secret) => String(secret || '').trim())
      .filter(Boolean);
    return [...new Set(secrets.map((secret) =>
      crypto.createHash('sha256').update(`${secret}:sports:code:${normalizedCode}`).digest('hex')
    ))];
  };

  app.post('/sports/signup', async (req, res, next) => {
    try {
      const tokenCode = req.body?.tokenCode || req.body?.token;
      const tokenHashes = getSportsTokenHashCandidates(tokenCode);
      let account = null;
      let lastError = null;
      for (const tokenHash of tokenHashes) {
        try {
          account = await sportsSupporterService.claimTokenHash({
            username: req.body?.username,
            password: req.body?.password,
            tokenHash
          });
          break;
        } catch (error) {
          lastError = error;
          if (error?.message !== 'Invalid sports token') throw error;
        }
      }
      if (!account) throw lastError || new Error('Invalid sports token');
      for (const tokenHash of tokenHashes) {
        if (tokenHash !== account.tokenHash) {
          await sportsSupporterService.revokeToken(tokenHash).catch(() => {});
        }
      }
      const token = await sportsSupporterService.createSession(account.id);
      setSportsSessionCookie(req, res, token);
      redirectSports(res, { success: 'Sports account created' });
    } catch (error) {
      redirectSports(res, { error: error?.message || 'Signup failed' });
    }
  });

  app.post('/sports/claim', async (req, res, next) => {
    try {
      const account = await sportsSupporterService.claimPayment({
        username: req.body?.username,
        password: req.body?.password,
        email: req.body?.email,
        transactionId: req.body?.transactionId
      });
      const token = await sportsSupporterService.createSession(account.id);
      setSportsSessionCookie(req, res, token);
      redirectSports(res, { success: 'Sports account created from Ko-fi payment' });
    } catch (error) {
      redirectSports(res, { error: error?.message || 'Could not find unclaimed Ko-fi payment' });
    }
  });

  app.post('/sports/login', async (req, res, next) => {
    try {
      const result = await sportsSupporterService.authenticate({
        username: req.body?.username,
        password: req.body?.password
      });
      if (!result.ok || !result.account) {
        redirectSports(res, { error: result.message || 'Invalid login' });
        return;
      }
      const token = await sportsSupporterService.createSession(result.account.id);
      setSportsSessionCookie(req, res, token);
      redirectSports(res, { success: 'Signed in' });
    } catch (error) {
      redirectSports(res, { error: error?.message || 'Login failed' });
    }
  });

  app.post('/sports/logout', async (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      await sportsSupporterService.destroySession(cookies[SPORTS_COOKIE_NAME]);
      clearSportsSessionCookie(res);
      redirectSports(res, { success: 'Signed out' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/sports/i/:installKey', async (req, res, next) => {
    try {
      const account = sportsSupporterService.getAccountByInstallKey(req.params.installKey);
      if (sportsSupporterService.isAccountActive(account)) {
        await sportsSupporterService.increment(account.id, 'installs', 1);
      }
      res.redirect(302, `/sports/i/${encodeURIComponent(req.params.installKey)}/manifest.json`);
    } catch (error) {
      next(error);
    }
  });
  app.get('/sports/i/:installKey/configure', async (req, res, next) => {
    try {
      const account = sportsSupporterService.getAccountByInstallKey(req.params.installKey);
      if (!isPaidSportsSupporter(account)) {
        redirectSports(res, { error: 'Sign in with an active supporter account to configure Nebula Sports' });
        return;
      }
      const token = await sportsSupporterService.createSession(account.id);
      setSportsSessionCookie(req, res, token);
      res.redirect(302, '/sports/configure');
    } catch (error) {
      next(error);
    }
  });
  app.get('/sports/i/:installKey/manifest.json', sendSportsManifest);
  app.get('/sports/i/:installKey/stremio/manifest.json', sendSportsManifest);
  app.get('/sports/i/:installKey/catalog/:type/:id.json', sendSportsCatalog);
  app.get('/sports/i/:installKey/catalog/:type/:id/:extra.json', sendSportsCatalog);
  app.get('/sports/i/:installKey/catalog/:type/:id/search=:search.json', sendSportsCatalog);
  app.get('/sports/i/:installKey/catalog/:type/:id/skip=:skip.json', sendSportsCatalog);
  app.get('/sports/i/:installKey/stremio/catalog/:type/:id.json', sendSportsCatalog);
  app.get('/sports/i/:installKey/stremio/catalog/:type/:id/:extra.json', sendSportsCatalog);
  app.get('/sports/i/:installKey/stremio/catalog/:type/:id/search=:search.json', sendSportsCatalog);
  app.get('/sports/i/:installKey/stremio/catalog/:type/:id/skip=:skip.json', sendSportsCatalog);
  app.get('/sports/i/:installKey/meta/:type/:id.json', sendSportsMeta);
  app.get('/sports/i/:installKey/stremio/meta/:type/:id.json', sendSportsMeta);
  app.get('/sports/i/:installKey/stream/:type/:id.json', sendSportsStreams);
  app.get('/sports/i/:installKey/stremio/stream/:type/:id.json', sendSportsStreams);

  app.post('/supporter/login', async (req, res, next) => {
    try {
      const auth = await supporterService.authenticateCode(req.body?.supporterCode || req.body?.code || '');
      if (!auth?.valid || !auth.account) {
        redirectDashboard(res, { error: auth?.message || 'Invalid supporter code' });
        return;
      }
      const token = await supporterService.createSession(auth.account.id);
      setSupporterSessionCookie(req, res, token);
      redirectDashboard(res, { success: 'Logged in' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/supporter/logout', async (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      await supporterService.destroySession(cookies[SUPPORTER_COOKIE_NAME]);
      clearSupporterSessionCookie(res);
      redirectDashboard(res, { success: 'Logged out' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/dashboard/settings', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        redirectDashboard(res, { error: 'Login required' });
        return;
      }
      await supporterService.updateAccountSettings(account.id, {
        username: req.body?.username,
        label: req.body?.label,
        theme: req.body?.theme,
        anonymousWall: req.body?.anonymousWall === 'true'
      });
      redirectDashboard(res, { tab: req.body?.theme ? 'themes' : 'overview', success: 'Settings saved' });
    } catch (error) {
      redirectDashboard(res, { tab: req.body?.theme ? 'themes' : 'overview', error: error?.message || 'Settings failed' });
    }
  });

  app.post('/dashboard/profiles/create', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        redirectDashboard(res, { error: 'Login required' });
        return;
      }
      await supporterService.saveProfile(account.id, {
        name: req.body?.name,
        configJson: parseDashboardJson(req.body?.configJson),
        makeDefault: true
      });
      redirectDashboard(res, { tab: 'profiles', success: 'Profile saved' });
    } catch (error) {
      redirectDashboard(res, { tab: 'profiles', error: error?.message || 'Profile save failed' });
    }
  });

  app.post('/dashboard/profiles/delete', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        redirectDashboard(res, { error: 'Login required' });
        return;
      }
      await supporterService.deleteProfile(account.id, String(req.body?.profileId || ''));
      redirectDashboard(res, { tab: 'profiles', success: 'Profile deleted' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/dashboard/profiles/rename', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        redirectDashboard(res, { tab: 'profiles', error: 'Login required' });
        return;
      }
      const profile = await supporterService.renameProfile(account.id, String(req.body?.profileId || ''), req.body?.name);
      redirectDashboard(res, profile ? { tab: 'profiles', success: 'Profile renamed' } : { tab: 'profiles', error: 'Profile not found' });
    } catch (error) {
      redirectDashboard(res, { tab: 'profiles', error: error?.message || 'Profile rename failed' });
    }
  });

  app.post('/dashboard/profiles/default', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        redirectDashboard(res, { error: 'Login required' });
        return;
      }
      await supporterService.setDefaultProfile(account.id, String(req.body?.profileId || ''));
      redirectDashboard(res, { tab: 'profiles', success: 'Profile restored' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/dashboard/backups/create', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        redirectDashboard(res, { error: 'Login required' });
        return;
      }
      await supporterService.createBackup(account.id, {
        name: req.body?.name,
        configJson: parseDashboardJson(req.body?.configJson)
      });
      redirectDashboard(res, { tab: 'backups', success: 'Backup saved' });
    } catch (error) {
      redirectDashboard(res, { tab: 'backups', error: error?.message || 'Backup failed' });
    }
  });

  app.post('/dashboard/backups/restore', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        redirectDashboard(res, { error: 'Login required' });
        return;
      }
      const restored = await supporterService.restoreBackup(account.id, String(req.body?.backupId || ''));
      redirectDashboard(res, restored ? { tab: 'backups', success: 'Backup restored to default profile' } : { tab: 'backups', error: 'Backup not found' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/dashboard/backups/delete', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        redirectDashboard(res, { tab: 'backups', error: 'Login required' });
        return;
      }
      const deleted = await supporterService.deleteBackup(account.id, String(req.body?.backupId || ''));
      redirectDashboard(res, deleted ? { tab: 'backups', success: 'Backup deleted' } : { tab: 'backups', error: 'Backup not found' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/dashboard/backups/:backupId.json', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        res.status(401).json({ error: 'Login required' });
        return;
      }
      const backup = await supporterService.getBackup(account.id, String(req.params.backupId || ''));
      if (!backup) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `attachment; filename="nebula-backup-${backup.id}.json"`);
      res.json(backup);
    } catch (error) {
      next(error);
    }
  });

  app.post('/dashboard/delete-account', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account || req.body?.confirm !== 'DELETE') {
        redirectDashboard(res, { error: 'Delete confirmation failed' });
        return;
      }
      const cookies = parseCookies(req.headers.cookie);
      await supporterService.deleteAccount(account.id);
      await supporterService.destroySession(cookies[SUPPORTER_COOKIE_NAME]);
      clearSupporterSessionCookie(res);
      redirectDashboard(res, { success: 'Account data deleted' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/dashboard/export.json', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        res.status(401).json({ error: 'Login required' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        exportedAt: new Date().toISOString(),
        account: {
          username: account.username,
          label: account.label,
          tier: account.tier,
          theme: account.theme,
          badges: account.badges,
          createdAt: account.createdAt,
          expiresAt: account.expiresAt,
          lifetime: account.lifetime
        },
        profiles: account.profiles || {},
        backups: account.backups || []
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/dashboard/early-access.json', async (req, res, next) => {
    try {
      const account = await getSupporterAccountFromRequest(req);
      if (!account) {
        res.status(401).json({ error: 'Login required' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        enabled: true,
        tier: account.tier || 'supporter',
        flags: { dashboardV2: true, profileSync: true, profileShortUrls: true, exclusiveThemes: true, prioritySupport: true },
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      next(error);
    }
  });
  app.post('/configure/supporter-profile', async (req, res, next) => {
    try {
      const auth = await supporterService.authenticateCode(req.body?.supporterCode || '');
      if (!auth?.valid || !auth.account) {
        res.status(401).json({ error: auth?.message || 'Invalid supporter code' });
        return;
      }
      const profile = await supporterService.saveProfile(auth.account.id, {
        name: req.body?.name,
        configJson: req.body?.configJson && typeof req.body.configJson === 'object' ? req.body.configJson : {},
        makeDefault: true
      });
      const token = await supporterService.createSession(auth.account.id);
      setSupporterSessionCookie(req, res, token);
      const freshAccount = supporterService.getAccount(auth.account.id);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        profile,
        dashboardUrl: `${getPublicBaseUrl(req)}/dashboard`,
        shortUrl: freshAccount?.username ? `${getPublicBaseUrl(req)}/u/${freshAccount.username}` : ''
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/u/:username', async (req, res, next) => {
    try {
      const account = supporterService.getAccountByUsername(req.params.username);
      if (account) await supporterService.incrementAccountStat(account.id, 'installs', 1);
      res.redirect(302, '/u/' + encodeURIComponent(req.params.username) + '/manifest.json');
    } catch (error) {
      next(error);
    }
  });

  app.get('/u/:username/:profileId/manifest.json', async (req, res, next) => {
    try {
      const account = supporterService.getAccountByUsername(req.params.username);
      const profile = account?.profiles?.[String(req.params.profileId || '')] || null;
      if (!account || !profile) {
        throw new HttpError(404, 'Supporter profile not found');
      }
      const configJson = profile.configJson || {};
      const { manifestPath } = await streamManager.createPrivateConfig({
        providers: configJson.providers,
        qualityPriority: configJson.qualityPriority,
        streamOptions: configJson.streamOptions,
        privateProviderSettings: configJson.privateProviderSettings,
        supporter: createSupporterRecordFromAccount(account),
        profileCode: configJson.profileCode
      });
      await supporterService.incrementAccountStat(account.id, 'manifests', 1);
      res.redirect(302, manifestPath);
    } catch (error) {
      next(error);
    }
  });
  app.get('/u/:username/manifest.json', async (req, res, next) => {
    try {
      const account = supporterService.getAccountByUsername(req.params.username);
      const profile = account?.defaultProfileId ? account.profiles?.[account.defaultProfileId] : null;
      if (!account || !profile) {
        throw new HttpError(404, 'Supporter profile not found');
      }
      const configJson = profile.configJson || {};
      const { manifestPath } = await streamManager.createPrivateConfig({
        providers: configJson.providers,
        qualityPriority: configJson.qualityPriority,
        streamOptions: configJson.streamOptions,
        privateProviderSettings: configJson.privateProviderSettings,
        supporter: createSupporterRecordFromAccount(account),
        profileCode: configJson.profileCode
      });
      await supporterService.incrementAccountStat(account.id, 'manifests', 1);
      res.redirect(302, manifestPath);
    } catch (error) {
      next(error);
    }
  });

  app.get('/donate', (req, res) => {
    res
      .status(200)
      .type('html')
      .send(renderDonatePage({
        baseUrl: getPublicBaseUrl(req)
      }));
  });

  app.post('/webhooks/smtp2go', async (req, res, next) => {
    try {
      const configuredSecret = config.SMTP2GO_WEBHOOK_SECRET;
      const providedSecret = String(
        req.get('x-nebula-webhook-secret')
          || req.get('x-smtp2go-webhook-secret')
          || req.query?.secret
          || ''
      ).trim();

      if (configuredSecret && providedSecret !== configuredSecret) {
        res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
        return;
      }

      const events = getSmtp2goEvents(req.body || {});
      if (!events.length) {
        res.status(400).json({ ok: false, error: 'Missing SMTP2GO event payload' });
        return;
      }

      const result = await recordSmtp2goWebhookEvents(events);
      logger.info('smtp2go webhook received', result);
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      logger.error('smtp2go webhook failed', { error });
      next(error);
    }
  });

  app.post(['/webhooks/kofi', '/webhooks/ko-fi'], async (req, res, next) => {
    try {
      if (!config.KOFI_WEBHOOK_TOKEN) {
        res.status(503).json({ ok: false, error: 'Ko-fi webhook not configured' });
        return;
      }

      let payload;
      try {
        payload = parseKofiWebhookPayload(req.body || {});
      } catch (error) {
        res.status(400).json({ ok: false, error: 'Invalid Ko-fi payload' });
        return;
      }

      if (payload?.verification_token !== config.KOFI_WEBHOOK_TOKEN) {
        res.status(401).json({ ok: false, error: 'Invalid Ko-fi token' });
        return;
      }
      const transactionId = getKofiTransactionId(payload);
      const email = String(payload.email || '').trim();
      const amount = getKofiAmount(payload);
      const currency = String(payload.currency || '').trim().toUpperCase();
      const paymentType = String(payload.type || (payload.is_subscription_payment ? 'Subscription' : 'Donation')).trim();
      const sportsPayment = isSportsKofiPayment(payload, amount);
      const tier = amount >= 5 ? 'founder' : 'supporter';
      const months = tier === 'founder' ? 36 : config.KOFI_SUPPORTER_CODE_MONTHS;
      const lifecycleType = paymentType.toLowerCase();

      if (!transactionId) {
        res.status(400).json({ ok: false, error: 'Missing transaction id' });
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
        res.status(400).json({ ok: false, error: 'Missing supporter email' });
        return;
      }
      if (/(?:cancel|cancelled|canceled|refund|chargeback|suspend|pause)/u.test(lifecycleType)) {
        await supporterService.updateAccountStatusByEmail(email, lifecycleType.includes('refund') || lifecycleType.includes('chargeback') ? 'revoked' : 'inactive');
        res.status(200).json({ ok: true, lifecycle: true });
        return;
      }
      if (amount < config.KOFI_MIN_AMOUNT) {
        res.status(202).json({ ok: true, ignored: true, reason: 'below minimum amount' });
        return;
      }
      if (sportsPayment) {
        if (!emailService.isConfigured()) {
          res.status(503).json({ ok: false, error: 'Sports email not configured' });
          return;
        }
        if (sportsSupporterService.hasPayment(transactionId)) {
          res.status(200).json({ ok: true, duplicate: true, product: 'sports' });
          return;
        }
        const sportsTier = getSportsKofiTier(amount);
        const created = await sportsSupporterService.createToken({
          label: payload.from_name || email,
          email,
          tier: sportsTier,
          months: sportsTier === 'lifetime' ? 36 : config.KOFI_SUPPORTER_CODE_MONTHS
        });
        try {
          await emailService.sendSportsToken({
            to: email,
            name: payload.from_name,
            code: created.code,
            expiresAt: created.expiresAt,
            baseUrl: getPublicBaseUrl(req)
          });
        } catch (error) {
          await sportsSupporterService.revokeToken(created.hash);
          throw error;
        }
        await sportsSupporterService.recordPayment({
          transactionId,
          email,
          amount: payload.amount || String(amount),
          currency,
          paymentType,
          tokenHash: created.hash,
          emailSentAt: new Date().toISOString()
        });
        logger.info('kofi sports token sent', {
          transactionId,
          emailMasked: maskEmailAddress(email),
          amount,
          currency,
          paymentType,
          sportsTier
        });
        res.status(200).json({ ok: true, product: 'sports' });
        return;
      }
      if (!emailService.isConfigured()) {
        res.status(503).json({ ok: false, error: 'Supporter email not configured' });
        return;
      }
      if (supporterService.hasPayment(transactionId)) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      const created = await supporterService.createCode({
        label: payload.from_name || email,
        tier,
        months
      });
      await supporterService.upsertAccountForCode({
        codeHash: created.hash,
        email,
        label: payload.from_name || email,
        tier,
        expiresAt: created.expiresAt,
        lifetime: tier === 'founder'
      });

      await emailService.sendSupporterCode({
        to: email,
        name: payload.from_name,
        code: created.code,
        expiresAt: created.expiresAt,
        baseUrl: getPublicBaseUrl(req)
      });

      await supporterService.recordPayment({
        transactionId,
        email,
        amount: payload.amount || String(amount),
        currency,
        paymentType,
        codeHash: created.hash,
        emailSentAt: new Date().toISOString()
      });

      logger.info('kofi supporter code sent', {
        transactionId,
        emailMasked: maskEmailAddress(email),
        amount,
        currency,
        paymentType
      });
      res.status(200).json({ ok: true });
    } catch (error) {
      let transactionId = '';
      try {
        transactionId = getKofiTransactionId(parseKofiWebhookPayload(req.body || {}));
      } catch {
        transactionId = '';
      }
      logger.error('kofi webhook failed', {
        error,
        transactionId
      });
      next(error);
    }
  });

  app.get('/admin/login', (req, res) => {
    if (hasValidAdminSession(req)) {
      res.redirect(302, '/admin');
      return;
    }

    res.status(200).type('html').send(renderAdminLoginPage({
      errorMessage: req.query.error === 'invalid' ? 'Invalid admin credentials.' : ''
    }));
  });

  app.post('/admin/login', (req, res) => {
    const { username = '', password = '' } = req.body ?? {};

    if (username !== config.ADMIN_USERNAME || password !== config.ADMIN_PASSWORD) {
      clearAdminSessionCookie(res);
      res.redirect(302, '/admin/login?error=invalid');
      return;
    }

    setAdminSessionCookie(req, res);
    res.redirect(302, '/admin');
  });

  app.post('/admin/logout', (req, res) => {
    clearAdminSessionCookie(res);
    res.redirect(302, '/admin/login');
  });

  app.post('/admin/supporters/create', requireAdminAuth, async (req, res, next) => {
    try {
      const created = await supporterService.createCode({
        label: req.body?.label,
        tier: req.body?.tier,
        months: req.body?.months
      });
      const flashId = crypto.randomBytes(8).toString('hex');
      adminSupporterFlashCodes.set(flashId, {
        code: created.code,
        expiresAt: Date.now() + 5 * 60 * 1000
      });
      res.redirect(302, `/admin?supporterFlash=${encodeURIComponent(flashId)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/supporters/revoke', requireAdminAuth, async (req, res, next) => {
    try {
      await supporterService.revokeCode(req.body?.hash);
      res.redirect(302, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin', requireAdminAuth, async (req, res, next) => {
    try {
      const systemStats = await getSystemStats();
      const cacheStats = await cacheManager.getCacheStats(torrentEngine.getActiveCachePaths());
      const streamStats = streamManager.getStats();
      const watchTogetherStats = await getWatchTogetherAdminStats();
      const stats = {
        runtime: {
          uptimeSeconds: Math.round(process.uptime()),
          activeTorrentEngines: torrentEngine.getActiveCachePaths().length,
          activeStreams: streamStats.activeStreams,
          maxActiveStreams: streamStats.maxActiveStreams,
          streamSearchesInFlight: streamStats.stremioResultInFlight,
          maxStreamSearchesInFlight: streamStats.maxStremioResultInFlight,
          stremioResultCacheEntries: streamStats.stremioResultCacheEntries,
          stremioBackgroundRefreshActive: streamStats.stremioBackgroundRefreshActive,
          stremioBackgroundRefreshQueued: streamStats.stremioBackgroundRefreshQueued,
          redisStreamResultCache: streamStats.redisStreamResultCache,
          hubCloudCacheEntries: streamStats.hubCloudCacheEntries,
          popularStreamPrewarm: streamStats.popularStreamPrewarm
        },
        system: systemStats,
        users: userTracker.getStats(),
        cache: cacheStats,
        providers: providerService.getStats(),
        sourceRegistry: sourceRegistry.getStats(),
        watchTogether: watchTogetherStats,
        supporters: supporterService.getStats()
      };

      const flashId = typeof req.query.supporterFlash === 'string' ? req.query.supporterFlash : '';
      const supporterFlash = adminSupporterFlashCodes.get(flashId);
      const createdSupporterCode = supporterFlash && supporterFlash.expiresAt > Date.now()
        ? supporterFlash.code
        : '';
      if (flashId) {
        adminSupporterFlashCodes.delete(flashId);
      }
      for (const [id, flash] of adminSupporterFlashCodes.entries()) {
        if (!flash || flash.expiresAt <= Date.now()) {
          adminSupporterFlashCodes.delete(id);
        }
      }

      res.status(200).type('html').send(renderAdminPage({
        stats,
        createdSupporterCode
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.post('/configure/private-config', streamManager.handleCreatePrivateConfig.bind(streamManager));
  app.post('/configure/validate-iptv', streamManager.handleValidateIptvConfig.bind(streamManager));
  app.post('/configure/validate-supporter', async (req, res, next) => {
    try {
      const result = await supporterService.validateCode(req.body?.supporterCode || req.body?.code || '');
      res
        .setHeader('Cache-Control', 'no-store')
        .json({
          configured: result.configured,
          valid: result.valid,
          message: result.message,
          supporter: result.valid ? {
            tier: result.supporter.tier,
            label: result.supporter.label,
            expiresAt: result.supporter.expiresAt
          } : null
        });
    } catch (error) {
      next(error);
    }
  });
  app.get('/configured/:providerConfig', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/private/:privateConfigId', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/private/:privateConfigId/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/stremio/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/rogplay/live/:id/playlist.m3u8', streamManager.handleRogPlayLivePlaylist.bind(streamManager));
  app.get('/private/:privateConfigId/xtream/:kind/:streamId.:extension', streamManager.handleXtreamStream.bind(streamManager));
  app.get('/private/:privateConfigId/stalker/live/:channelId.:extension', streamManager.handleStalkerStream.bind(streamManager));
  app.get('/private/:privateConfigId/stalker/proxy/:channelId', streamManager.handleStalkerProxyStream.bind(streamManager));
  app.get('/private/:privateConfigId/nflix/live/:channelId.:extension', streamManager.handleNflixStream.bind(streamManager));
  app.get('/private/:privateConfigId/streamed/:source/:streamId/:streamNo.:extension', streamManager.handleStreamedSportsStream.bind(streamManager));
  app.get('/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/private/:privateConfigId/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/private/:privateConfigId/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/private/:privateConfigId/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/catalog/:type/:id/:extra.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/api/vidking/embed', (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'public, max-age=300')
        .json(buildVidkingEmbedUrl({
          provider: 'vidking',
          type: req.query.type,
          tmdbId: req.query.tmdbId,
          season: req.query.season,
          episode: req.query.episode,
          color: req.query.color,
          autoPlay: toBooleanQuery(req.query.autoPlay),
          nextEpisode: toBooleanQuery(req.query.nextEpisode),
          episodeSelector: toBooleanQuery(req.query.episodeSelector),
          progress: req.query.progress
        }));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/movie/embed-providers', (req, res) => {
    res
      .set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
      .json({
        defaultProvider: 'vidking',
        providers: MOVIE_EMBED_PROVIDER_LIST.map((provider) => ({
          id: provider.id,
          name: provider.name
        }))
      });
  });
  app.get('/api/movie/embed', (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'public, max-age=300')
        .json(buildVidkingEmbedUrl({
          provider: req.query.provider,
          type: req.query.type,
          tmdbId: req.query.tmdbId,
          season: req.query.season,
          episode: req.query.episode,
          color: req.query.color,
          autoPlay: toBooleanQuery(req.query.autoPlay),
          nextEpisode: toBooleanQuery(req.query.nextEpisode),
          episodeSelector: toBooleanQuery(req.query.episodeSelector),
          progress: req.query.progress
        }));
    } catch (error) {
      next(error);
    }
  });
  const sendAddonCatalogs = async (req, res, next) => {
    try {
      const source = getCatalogSource(req.catalogSource || req.query.source);
      const manifest = await fetchJsonWithTimeout(`${source.baseUrl}/manifest.json`);
      const catalogs = Array.isArray(manifest.catalogs)
        ? manifest.catalogs.map(normalizeAddonCatalog).filter((catalog) => catalog.id && catalog.showInHome)
        : [];
      res
        .set('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600')
        .json({
          addon: {
            id: manifest.id || source.id,
            name: manifest.name || source.name,
            source: source.id
          },
          catalogs
        });
    } catch (error) {
      next(error);
    }
  };
  const sendAddonCatalog = async (req, res, next) => {
    try {
      const source = getCatalogSource(req.catalogSource || req.query.source);
      const type = req.params.type === 'series' ? 'series' : 'movie';
      const catalogId = String(req.params.id || '').trim();
      if (!catalogId || !/^[a-z0-9._-]+$/iu.test(catalogId)) {
        throw new HttpError(400, 'Valid catalog id is required');
      }

      const extras = [
        encodeCatalogExtra('genre', req.query.genre),
        encodeCatalogExtra('skip', req.query.skip)
      ].filter(Boolean);
      const extraPath = extras.length ? `/${extras.join('&')}` : '';
      const upstreamUrl = `${source.baseUrl}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}${extraPath}.json`;
      const payload = await fetchJsonWithTimeout(upstreamUrl);
      const items = Array.isArray(payload.metas)
        ? payload.metas.map(normalizeCatalogMeta).filter((item) => item.tmdbId && item.name)
        : [];

      res
        .set('Cache-Control', 'public, max-age=600, stale-while-revalidate=1800')
        .json({
          source: source.name,
          sourceId: source.id,
          type,
          catalogId,
          items
        });
    } catch (error) {
      next(error);
    }
  };
  app.get('/api/catalogs', sendAddonCatalogs);
  app.get('/api/catalog/:type/:id', sendAddonCatalog);
  app.get('/api/aio/catalogs', (req, res, next) => {
    req.catalogSource = 'aio';
    return sendAddonCatalogs(req, res, next);
  });
  app.get('/api/aio/catalog/:type/:id', (req, res, next) => {
    req.catalogSource = 'aio';
    return sendAddonCatalog(req, res, next);
  });
  app.get('/providers', (_req, res) => {
    res.json({
      providers: providerService.listProviders()
    });
  });
  app.get('/configure/adapter-providers', async (_req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store, max-age=0')
        .json({
          groups: await providerService.listAdapterProviderGroups()
        });
    } catch (error) {
      next(error);
    }
  });
  app.get('/aiostreams.json', (req, res) => {
    const baseUrl = getPublicBaseUrl(req).replace(/\/+$/u, '');
    const manifestUrl = `${baseUrl}/manifest.json`;
    const configuredManifestUrl = `${baseUrl}/configured/all/default/manifest.json`;

    res.json({
      name: 'NebulaStreams',
      integration: 'aiostreams',
      manifestUrl,
      configuredManifestUrl,
      recommendedPreset: {
        type: 'aiostreams',
        enabled: true,
        options: {
          name: 'NebulaStreams',
          manifestUrl,
          timeout: 30000,
          resources: ['stream'],
          mediaTypes: ['movie', 'series'],
          formatPassthrough: false,
          resultPassthrough: false
        }
      },
      customPresetFallback: {
        type: 'custom',
        enabled: true,
        options: {
          name: 'NebulaStreams',
          manifestUrl,
          timeout: 30000,
          resources: ['stream'],
          mediaTypes: ['movie', 'series']
        }
      }
    });
  });
  app.get('/providers/aggregate/streams', streamManager.handleAggregateProviderStreams.bind(streamManager));
  app.get('/providers/:provider/streams', streamManager.handleProviderStreams.bind(streamManager));
  app.get('/cache/stats', streamManager.handleCacheStats.bind(streamManager));
  app.post('/add-source', streamManager.handleAddSource.bind(streamManager));
  app.get('/torbox/webdl', streamManager.handleTorBoxWebDownload.bind(streamManager));
  app.get('/torbox/torrent', streamManager.handleTorBoxTorrentDownload.bind(streamManager));
  app.get('/torbox/usenet', streamManager.handleTorBoxUsenetDownload.bind(streamManager));
  app.get('/stream', streamManager.handleUnifiedStream.bind(streamManager));
  app.get('/http-stream', streamManager.handleHttpStream.bind(streamManager));
  app.get('/stream/http', streamManager.handleHttpStream.bind(streamManager));
  app.get('/stream/torrent/:infoHash/:filename', streamManager.handleTorrentFileStream.bind(streamManager));
  app.get('/stream/torrent', streamManager.handleTorrentStream.bind(streamManager));

  if (reverseProxy) {
    app.use((req, res, next) => {
      reverseProxy.handle(req, res, next).catch(next);
    });
  }

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'Route not found'));
  });

  app.use((error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }

    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof HttpError ? error.message : 'Internal server error';

    if (statusCode >= 500) {
      logger.error('request failed', {
        error
      });
    }

    res.status(statusCode).json({
      error: message,
      ...(error instanceof HttpError && error.details ? { details: error.details } : {})
    });
  });

  const server = app.listen(config.PORT, () => {
    logger.info('server started', {
      port: config.PORT,
      maxActiveTorrents: config.MAX_ACTIVE_TORRENTS,
      torrentConnections: config.TORRENT_CONNECTIONS
    });
  });
  if (uptimeKumaProxy) {
    server.on('upgrade', (req, socket, head) => {
      if ((req.url || '').startsWith(`${uptimeKumaProxy.mountPath}/socket.io`)) {
        uptimeKumaProxy.handleUpgrade(req, socket, head);
        return;
      }

      socket.destroy();
    });
  }
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 75_000;
  server.timeout = 75_000;
  server.maxRequestsPerSocket = 1000;
  server.on('clientError', (error, socket) => {
    logger.warn('client connection error', {
      error: error?.code || error?.message || String(error)
    });
    socket.destroy();
  });
  const memoryGuardTimer = startMemoryGuard({
    streamManager,
    providerService,
    imdbResolver,
    userTracker,
    sourceRegistry
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info('server shutting down', { signal });

    const closeActiveConnectionsTimer = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    }, 5_000);

    const forceExitTimer = setTimeout(() => {
      process.exit(0);
    }, 20_000);

    closeActiveConnectionsTimer.unref();
    forceExitTimer.unref();

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    if (memoryGuardTimer) {
      clearInterval(memoryGuardTimer);
      if (memoryGuardTimer.emergencyTimer) {
        clearInterval(memoryGuardTimer.emergencyTimer);
      }
    }

    await torrentEngine.close();
    await streamManager.close();
    await providerService.close();
    sourceRegistry.close();
    await userTracker.close();
    clearTimeout(closeActiveConnectionsTimer);
    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      logger.error('shutdown failed', { error });
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      logger.error('shutdown failed', { error });
      process.exit(1);
    });
  });

  process.on('unhandledRejection', (error) => {
    logger.error('unhandled rejection', { error });
  });

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
  });
};

bootstrap().catch((error) => {
  logger.error('server bootstrap failed', { error });
  process.exit(1);
});
