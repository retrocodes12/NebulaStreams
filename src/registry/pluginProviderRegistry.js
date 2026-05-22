import path from 'node:path';

import { PluginManifestCache } from '../cache/pluginManifestCache.js';
import { CloudstreamPhisherAdapter } from '../adapters/CloudstreamPhisherAdapter.js';
import { NuvioPluginAdapter } from '../adapters/NuvioPluginAdapter.js';
import { R2PluginAdapter } from '../adapters/R2PluginAdapter.js';
import { ScraplingServiceAdapter } from '../adapters/ScraplingServiceAdapter.js';
import { RogPlayAdapter } from '../../providers/rogplay/RogPlayAdapter.js';

export class PluginProviderRegistry {
  constructor({ cacheDir, logger = console }) {
    this.logger = logger;
    const pluginCache = new PluginManifestCache({
      cacheDir: path.join(cacheDir, 'plugin-adapters')
    });

    const rogPlayAdapter = new RogPlayAdapter({ logger });

    this.adapters = new Map([
      ['nuvio', new NuvioPluginAdapter({ cache: pluginCache, logger })],
      ['cloudstream-phisher', new CloudstreamPhisherAdapter({ cache: pluginCache, logger })],
      ['r2-plugin', new R2PluginAdapter({ logger })],
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
