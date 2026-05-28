import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from '../../config.js';
import { PluginProviderAdapter } from './PluginProviderAdapter.js';
import { normalizePluginStreams } from '../normalizers/pluginStreamNormalizer.js';
import { withTimeout } from '../utils/timeout.js';

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8787';
const execFileAsync = promisify(execFile);
const VIDEO_GEN_HOSTS = new Set(['cdn.video-gen.xyz', 'video-gen.xyz']);

const wait = (ms, signal = null) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason || new Error('Scrapling wait aborted'));
    return;
  }

  let abortHandler = null;
  const timeout = setTimeout(() => {
    if (abortHandler) {
      signal?.removeEventListener?.('abort', abortHandler);
    }
    resolve();
  }, ms);
  timeout.unref?.();

  if (signal) {
    abortHandler = () => {
      clearTimeout(timeout);
      signal.removeEventListener?.('abort', abortHandler);
      reject(signal.reason || new Error('Scrapling wait aborted'));
    };
    signal.addEventListener('abort', abortHandler, { once: true });
  }
});

const isVideoGenUrl = (value) => {
  try {
    return VIDEO_GEN_HOSTS.has(new URL(String(value || '')).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const sharedState = {
  child: null,
  startPromise: null,
  shutdownHandlerRegistered: false
};

export class ScraplingServiceAdapter extends PluginProviderAdapter {
  constructor({
    logger = console,
    serviceUrl = config.SCRAPLING_SERVICE_URL || DEFAULT_SERVICE_URL,
    timeoutMs = config.SCRAPLING_SERVICE_TIMEOUT_MS || 32_000,
    autoStart = config.SCRAPLING_SERVICE_AUTOSTART !== false
  } = {}) {
    super({ id: 'scrapling', logger });
    this.serviceUrl = String(serviceUrl || DEFAULT_SERVICE_URL).replace(/\/+$/u, '');
    this.timeoutMs = timeoutMs;
    this.autoStart = autoStart;
  }

  async getManifest() {
    return {
      providers: ['scrapling-hdhub4u', 'scrapling-4khdhub', 'uhdmovies']
    };
  }

  async initialize() {
    if (!this.autoStart) return;
    await this.ensureService();
  }

  async getStreams(request) {
    const providerId = request.providerId || 'scrapling-hdhub4u';

    return withTimeout(async (signal) => {
      await this.ensureService(signal);
      const response = await fetch(`${this.serviceUrl}/scrape`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          provider: providerId,
          tmdbId: request.tmdbId,
          mediaType: request.mediaType,
          season: request.season,
          episode: request.episode
        })
      });

      if (!response.ok) {
        throw new Error(`Scrapling service HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (payload?.error) {
        this.logger.info?.('scrapling service returned error', {
          provider: providerId,
          error: payload.error
        });
      }

      const rawStreams = providerId === 'uhdmovies'
        ? await this.resolveUhdMoviesVideoGenStreams(payload?.streams || [], signal)
        : payload?.streams || [];

      return normalizePluginStreams(rawStreams, {
        adapterId: providerId,
        pluginId: providerId,
        pluginName: this.getProviderLabel(providerId)
      });
    }, this.timeoutMs, 'Scrapling adapter timed out');
  }

  async resolveUhdMoviesVideoGenStreams(streams, signal = null) {
    const normalizedStreams = Array.isArray(streams) ? streams : [];

    return Promise.all(normalizedStreams.map(async (stream) => {
      if (!isVideoGenUrl(stream?.url)) {
        return stream;
      }

      try {
        const resolvedUrl = await this.resolveVideoGenUrl(stream.url, stream.headers, signal);

        if (!resolvedUrl) {
          return stream;
        }

        return {
          ...stream,
          url: resolvedUrl,
          headers: null,
          source: stream.source || 'UHDMovies',
          behaviorHints: {
            ...(stream.behaviorHints || {}),
            originalVideoGenUrl: stream.url
          }
        };
      } catch (error) {
        this.logger.info?.('uhdmovies video-gen resolution failed', {
          error: error?.message || String(error)
        });
        return stream;
      }
    }));
  }

  async resolveVideoGenUrl(url, headers = null, signal = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('video-gen resolution timed out')), 6_000);
    timeout.unref?.();

    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        return null;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': headers?.['User-Agent'] || headers?.['user-agent'] || 'Mozilla/5.0',
          ...(headers?.Referer || headers?.referer ? { Referer: headers.Referer || headers.referer } : {})
        }
      });
      const location = response.headers.get('location');

      if (!location) {
        return null;
      }

      const resolvedLocation = new URL(location, url);
      const directUrl = resolvedLocation.searchParams.get('url');

      if (directUrl && /^https?:\/\//iu.test(directUrl)) {
        return directUrl;
      }

      if (resolvedLocation.hostname.toLowerCase().includes('googleusercontent.com')) {
        return resolvedLocation.toString();
      }

      return null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  getProviderLabel(providerId) {
    if (providerId === 'scrapling-hdhub4u') return 'Scrapling HDHub4u';
    if (providerId === 'scrapling-4khdhub') return 'Scrapling 4KHDHub';
    if (providerId === 'uhdmovies') return 'UHDMovies';
    return providerId;
  }

  async ensureService(signal = null) {
    if (await this.isHealthy()) {
      return;
    }

    if (!this.autoStart) {
      throw new Error('Scrapling service unavailable');
    }

    await this.startService(signal);
  }

  async isHealthy(signal = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    timeout.unref?.();

    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        return false;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await fetch(`${this.serviceUrl}/health`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async startService(signal = null) {
    if (sharedState.startPromise) {
      return this.waitForSharedStart(signal);
    }

    if (await this.isHealthy()) {
      return;
    }

    sharedState.startPromise = this.spawnAndWait().finally(() => {
      sharedState.startPromise = null;
    });

    return this.waitForSharedStart(signal);
  }

  async waitForSharedStart(signal = null) {
    if (!sharedState.startPromise) {
      return;
    }

    if (!signal) {
      return sharedState.startPromise;
    }

    if (signal.aborted) {
      throw signal.reason || new Error('Scrapling service start aborted');
    }

    return Promise.race([
      sharedState.startPromise,
      new Promise((_, reject) => {
        const onAbort = () => {
          signal.removeEventListener?.('abort', onAbort);
          reject(signal.reason || new Error('Scrapling service start aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        sharedState.startPromise.finally(() => {
          signal.removeEventListener?.('abort', onAbort);
        }).catch(() => {});
      })
    ]);
  }

  async spawnAndWait(signal = null) {
    if (await this.isHealthy()) {
      return;
    }

    await this.stopStaleSidecar();

    if (await this.isHealthy()) {
      return;
    }

    if (!sharedState.child || sharedState.child.exitCode !== null) {
      const scriptPath = path.resolve(process.cwd(), 'services/scrapling_service/server.py');
      const venvPython = path.resolve(process.cwd(), 'services/scrapling_service/.venv/bin/python');
      const pythonBin = String(process.env.SCRAPLING_PYTHON_BIN || (existsSync(venvPython) ? venvPython : 'python3')).trim() || 'python3';
      sharedState.child = spawn(pythonBin, [scriptPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SCRAPLING_SERVICE_PORT: new URL(this.serviceUrl).port || '8787',
          TMDB_API_KEY: config.TMDB_API_KEY
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      sharedState.child.stdout?.on('data', (chunk) => {
        this.logger.info?.('scrapling service stdout', { message: String(chunk).trim() });
      });
      sharedState.child.stderr?.on('data', (chunk) => {
        const message = this.summarizeChildLog(chunk);
        const isAccessNoise = /"GET \/health HTTP\/1\.1" 200|"POST \/scrape HTTP\/1\.1" 200|INFO: Fetched \(200\)/u.test(message);
        const log = isAccessNoise ? this.logger.info : this.logger.warn;
        log?.call(this.logger, 'scrapling service stderr', { message });
      });
      sharedState.child.on('exit', (code, childSignal) => {
        this.logger.warn?.('scrapling service exited', { code, signal: childSignal });
      });
      this.registerShutdownHandler();
      sharedState.child.unref?.();
    }

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason || new Error('Scrapling service start aborted');
      }
      if (await this.isHealthy(signal)) {
        return;
      }
      await wait(200);
    }

    throw new Error('Scrapling service did not become healthy');
  }

  summarizeChildLog(chunk) {
    return String(chunk)
      .trim()
      .replace(/([?&](?:sid|key|token|sig|signature)=)[^&\s"]+/giu, '$1<redacted>')
      .split('\n')
      .map((line) => line.slice(0, 700))
      .join('\n');
  }

  async stopStaleSidecar() {
    const port = new URL(this.serviceUrl).port || '8787';
    let stdout = '';

    try {
      ({ stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 1_000 }));
    } catch {
      return;
    }

    const pids = [...new Set(String(stdout).split(/\s+/u).map((pid) => Number(pid)).filter(Boolean))];
    for (const pid of pids) {
      if (pid === process.pid || pid === sharedState.child?.pid) {
        continue;
      }

      try {
        const { stdout: psOutput } = await execFileAsync('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 1_000 });
        if (!psOutput.includes('services/scrapling_service/server.py')) {
          continue;
        }

        this.logger.warn?.('stopping stale scrapling sidecar', { pid, port });
        process.kill(pid, 'SIGTERM');
        await wait(800);
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already exited.
        }
      } catch {
        // Best effort only. Spawn path will report real failure if port stays blocked.
      }
    }
  }

  registerShutdownHandler() {
    if (sharedState.shutdownHandlerRegistered) {
      return;
    }

    sharedState.shutdownHandlerRegistered = true;
    const stopChild = () => {
      if (sharedState.child && sharedState.child.exitCode === null) {
        sharedState.child.kill('SIGTERM');
      }
    };

    process.once('SIGINT', stopChild);
    process.once('SIGTERM', stopChild);
    process.once('exit', stopChild);
  }
}
