import path from 'node:path';

import { PluginManifestCache } from '../cache/pluginManifestCache.js';
import { CloudstreamPhisherAdapter } from '../adapters/CloudstreamPhisherAdapter.js';
import { NuvioPluginAdapter } from '../adapters/NuvioPluginAdapter.js';
import { R2PluginAdapter } from '../adapters/R2PluginAdapter.js';
import { R3PluginAdapter } from '../adapters/R3PluginAdapter.js';
import { R4AsianDramaMoviesAdapter } from '../adapters/R4AsianDramaMoviesAdapter.js';
import { ScraplingServiceAdapter } from '../adapters/ScraplingServiceAdapter.js';
import { RogPlayAdapter } from '../../providers/rogplay/RogPlayAdapter.js';

const NUVIO_LATINO_PROVIDER_ORDER = Object.freeze([
  'embed69',
  'sololatino',
  'pelisgo',
  'pelisplus',
  'cinecalidad',
  'seriesmetro',
  'xupalace',
  'fuegocine',
  'playhubmax',
  'tioplus',
  'cinemacity',
  'brazucaplay',
  'lamovie',
  'videasy',
  'cuevanaubd',
  'pelispanda',
  'hackstore'
]);

const NUVIO_FRENCH_PROVIDER_ORDER = Object.freeze([
  'frenchstream',
  'movix',
  'dulourd',
  'anime-sama',
  'voiranime',
  'vostfree',
  'animoflix',
  'french-anime',
  'animevostfr',
  'animesultra',
  'jetanimes',
  'sekai',
  'mugiwarastream',
  'animesite'
]);

const NUVIO_ITALIAN_PROVIDER_ORDER = Object.freeze([
  'easystreams-streamingcommunity',
  'easystreams-guardahd',
  'easystreams-guardoserie',
  'easystreams-altadefinizionestreaming',
  'easystreams-cinemacity',
  'easystreams-animeunity',
  'easystreams-animeworld',
  'easystreams-animesaturn'
]);

const NUVIO_2_PROVIDER_ORDER = Object.freeze([
  '4khdhub',
  'hdhub4u',
  'uhdmovies',
  'vidlink',
  'moviebox',
  'showbox',
  'netmirror',
  'streamflix',
  'animekai',
  'animepahe',
  'moviesmod',
  'dahmermovies',
  'vixsrc',
  'videasy',
  'castle',
  'cinemacity',
  'allmovieland',
  'movieblast',
  'dooflix',
  'vidnest',
  'vidnest-anime',
  'cinevibe',
  'mallumv',
  'dvdplay',
  'yflix',
  'mycima'
]);

export class PluginProviderRegistry {
  constructor({ cacheDir, logger = console }) {
    this.logger = logger;
    const pluginCache = new PluginManifestCache({
      cacheDir: path.join(cacheDir, 'plugin-adapters')
    });

    const rogPlayAdapter = new RogPlayAdapter({ logger });

    this.adapters = new Map([
      ['nuvio', new NuvioPluginAdapter({ cache: pluginCache, logger })],
      ['nuvio-latino', new NuvioPluginAdapter({
        id: 'nuvio-latino',
        name: 'Nuvio-Latino',
        cacheNamespace: 'nuvio-latino',
        cache: pluginCache,
        logger,
        manifestUrl: 'https://raw.githubusercontent.com/adrianjael/pluggin-latino/refs/heads/main/manifest.json',
        rawBaseUrl: 'https://raw.githubusercontent.com/adrianjael/pluggin-latino/refs/heads/main/',
        providerOrder: NUVIO_LATINO_PROVIDER_ORDER,
        pluginConcurrency: Number(process.env.NUVIO_LATINO_PLUGIN_CONCURRENCY || 4),
        earlyReturnStreams: Number(process.env.NUVIO_LATINO_EARLY_RETURN_STREAMS || 24),
        providerTimeoutMs: Number(process.env.NUVIO_LATINO_PROVIDER_TIMEOUT_MS || 8_000),
        overallTimeoutMs: Number(process.env.NUVIO_LATINO_OVERALL_TIMEOUT_MS || 18_000)
      })],
      ['nuvio-french', new NuvioPluginAdapter({
        id: 'nuvio-french',
        name: 'Nuvio-French',
        cacheNamespace: 'nuvio-french',
        cache: pluginCache,
        logger,
        manifestUrl: 'https://raw.githubusercontent.com/Gowaru/gowaru-nuvio-providers/refs/heads/main/manifest.json',
        rawBaseUrl: 'https://raw.githubusercontent.com/Gowaru/gowaru-nuvio-providers/refs/heads/main/',
        providerOrder: NUVIO_FRENCH_PROVIDER_ORDER,
        pluginConcurrency: Number(process.env.NUVIO_FRENCH_PLUGIN_CONCURRENCY || 4),
        earlyReturnStreams: Number(process.env.NUVIO_FRENCH_EARLY_RETURN_STREAMS || 24),
        providerTimeoutMs: Number(process.env.NUVIO_FRENCH_PROVIDER_TIMEOUT_MS || 9_000),
        overallTimeoutMs: Number(process.env.NUVIO_FRENCH_OVERALL_TIMEOUT_MS || 20_000)
      })],
      ['nuvio-italian', new NuvioPluginAdapter({
        id: 'nuvio-italian',
        name: 'Nuvio-Italian',
        cacheNamespace: 'nuvio-italian',
        cache: pluginCache,
        logger,
        manifestUrl: 'https://raw.githubusercontent.com/realbestia1/easystreams/refs/heads/main/manifest.json',
        rawBaseUrl: 'https://raw.githubusercontent.com/realbestia1/easystreams/refs/heads/main/',
        providerOrder: NUVIO_ITALIAN_PROVIDER_ORDER,
        pluginConcurrency: Number(process.env.NUVIO_ITALIAN_PLUGIN_CONCURRENCY || 4),
        earlyReturnStreams: Number(process.env.NUVIO_ITALIAN_EARLY_RETURN_STREAMS || 24),
        providerTimeoutMs: Number(process.env.NUVIO_ITALIAN_PROVIDER_TIMEOUT_MS || 9_000),
        overallTimeoutMs: Number(process.env.NUVIO_ITALIAN_OVERALL_TIMEOUT_MS || 20_000)
      })],
      ['nuvio-2', new NuvioPluginAdapter({
        id: 'nuvio-2',
        name: 'Nuvio 2',
        cacheNamespace: 'nuvio-2',
        cache: pluginCache,
        logger,
        manifestUrl: 'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json',
        rawBaseUrl: 'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/',
        providerOrder: NUVIO_2_PROVIDER_ORDER,
        pluginConcurrency: Number(process.env.NUVIO_2_PLUGIN_CONCURRENCY || 5),
        earlyReturnStreams: Number(process.env.NUVIO_2_EARLY_RETURN_STREAMS || 36),
        providerTimeoutMs: Number(process.env.NUVIO_2_PROVIDER_TIMEOUT_MS || 8_000),
        overallTimeoutMs: Number(process.env.NUVIO_2_OVERALL_TIMEOUT_MS || 20_000)
      })],
      ['cloudstream-phisher', new CloudstreamPhisherAdapter({ cache: pluginCache, logger })],
      ['r2-plugin', new R2PluginAdapter({ logger })],
      ['r3-plugin', new R3PluginAdapter({ logger })],
      ['r4-asian-drama-movies', new R4AsianDramaMoviesAdapter({ logger })],
      ['scrapling', new ScraplingServiceAdapter({ logger })],
      ['rogplay', rogPlayAdapter]
    ]);
  }

  getProviderConfigs() {
    return [
      {
        id: 'nuvio',
        label: 'Nuvio Plugins',
        kind: 'plugin-adapter',
        adapterId: 'nuvio',
        hostKey: 'plugin:nuvio'
      },
      {
        id: 'nuvio-latino',
        label: 'Nuvio-Latino',
        kind: 'plugin-adapter',
        adapterId: 'nuvio-latino',
        hostKey: 'plugin:nuvio-latino'
      },
      {
        id: 'nuvio-french',
        label: 'Nuvio-French',
        kind: 'plugin-adapter',
        adapterId: 'nuvio-french',
        hostKey: 'plugin:nuvio-french'
      },
      {
        id: 'nuvio-italian',
        label: 'Nuvio-Italian',
        kind: 'plugin-adapter',
        adapterId: 'nuvio-italian',
        hostKey: 'plugin:nuvio-italian'
      },
      {
        id: 'nuvio-2',
        label: 'Nuvio 2',
        kind: 'plugin-adapter',
        adapterId: 'nuvio-2',
        hostKey: 'plugin:nuvio-2'
      },
      {
        id: 'cloudstream-phisher',
        label: 'Phisher Cloudstream',
        kind: 'plugin-adapter',
        adapterId: 'cloudstream-phisher',
        hostKey: 'plugin:cloudstream-phisher'
      },
      {
        id: 'r2-plugin',
        label: 'R2 plugin',
        kind: 'plugin-adapter',
        adapterId: 'r2-plugin',
        hostKey: 'plugin:r2-plugin'
      },
      {
        id: 'r3-plugin',
        label: 'R3-plugin',
        kind: 'plugin-adapter',
        adapterId: 'r3-plugin',
        hostKey: 'plugin:r3-plugin'
      },
      {
        id: 'r4-asian-drama-movies',
        label: 'r4-Asian drama and movies',
        kind: 'plugin-adapter',
        adapterId: 'r4-asian-drama-movies',
        hostKey: 'plugin:r4-asian-drama-movies'
      },
      {
        id: 'scrapling-hdhub4u',
        label: 'Scrapling HDHub4u',
        kind: 'plugin-adapter',
        adapterId: 'scrapling',
        hostKey: 'plugin:scrapling-hdhub4u'
      },
      {
        id: 'scrapling-4khdhub',
        label: 'Scrapling 4KHDHub',
        kind: 'plugin-adapter',
        adapterId: 'scrapling',
        hostKey: 'plugin:scrapling-4khdhub'
      },
      {
        id: 'uhdmovies',
        label: 'UHDMovies',
        kind: 'plugin-adapter',
        adapterId: 'scrapling',
        hostKey: 'plugin:uhdmovies'
      },
      {
        id: 'rogplay-vod',
        label: 'RogPlay VOD',
        kind: 'plugin-adapter',
        adapterId: 'rogplay',
        hostKey: 'plugin:rogplay-vod'
      },
      {
        id: 'rogplay-live',
        label: 'RogPlay Live TV',
        kind: 'plugin-adapter',
        adapterId: 'rogplay',
        hostKey: 'plugin:rogplay-live'
      }
    ];
  }

  getAdapter(adapterId) {
    return this.adapters.get(adapterId);
  }

  async initialize() {
    await Promise.all([...this.adapters.values()].map(async (adapter) => {
      if (typeof adapter.initialize !== 'function') return;

      try {
        await adapter.initialize();
      } catch (error) {
        this.logger?.warn?.('plugin adapter initialization failed', {
          adapter: adapter.id,
          error: error?.message || String(error)
        });
      }
    }));
  }
}
