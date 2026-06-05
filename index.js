import crypto from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
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

const PROJECT_SUPPORTERS = [
  'Devon Durham'
];

const renderSupporterPills = (supporters = PROJECT_SUPPORTERS) => supporters
  .map((supporter) => `<span class="supporter-pill">${escapeHtml(supporter)}</span>`)
  .join('');

const ADMIN_COOKIE_NAME = 'nebulastreams_admin';
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CPU_SAMPLE_WINDOW_MS = 200;
const { readFile } = fsPromises;

const sleep = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

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

const getPublicBaseUrl = (req) => config.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

const renderConfigurePage = ({ baseUrl, providers }) => {
  const providerIds = providers.map((provider) => provider.id);
  const providerHints = providers
    .slice(0, 12)
    .map((provider) => escapeHtml(provider.id))
    .join(', ');
  const donationPrimaryUrl = escapeHtml(String(config.DONATION_PRIMARY_URL || '').trim());
  const simpleKoFiUrl = donationPrimaryUrl || `${escapeHtml(baseUrl)}/donate`;
  const statusPageUrl = escapeHtml(String(config.STATUS_PAGE_URL || `${baseUrl}/health`).trim() || `${baseUrl}/health`);
  const nowPaymentsWidgetUrl = escapeHtml(String(config.DONATION_NOWPAYMENTS_WIDGET_URL || '').trim());
  const hasDonationSupport = Boolean(
    config.DONATION_CRYPTO_ADDRESS ||
    config.DONATION_PRIMARY_URL ||
    config.DONATION_SECONDARY_URL ||
    nowPaymentsWidgetUrl
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams • Configure</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <script defer src="https://cloud.umami.is/script.js" data-website-id="ed6ff4d3-b737-4392-ab00-8cc7c98c45ec"></script>
    <style>
      :root {
        color-scheme: dark;
        --bg-0: #05060d;
        --bg-1: #0a0d1a;
        --bg-2: #11142a;
        --surface: rgba(255, 255, 255, 0.035);
        --surface-2: rgba(255, 255, 255, 0.06);
        --surface-3: rgba(255, 255, 255, 0.09);
        --border: rgba(255, 255, 255, 0.08);
        --border-strong: rgba(255, 255, 255, 0.14);
        --text: #eef1fb;
        --text-dim: #b6bdd4;
        --muted: #7d86a4;
        --accent: #7c5cff;
        --accent-2: #22d3ee;
        --accent-3: #ff5cf0;
        --success: #34d399;
        --warning: #fbbf24;
        --danger: #f87171;
        --radius-lg: 20px;
        --radius-md: 14px;
        --radius-sm: 10px;
        --shadow-lg: 0 30px 80px rgba(0, 0, 0, 0.55);
        --shadow-md: 0 14px 40px rgba(0, 0, 0, 0.35);
        --shadow-glow: 0 0 0 1px rgba(124, 92, 255, 0.25), 0 18px 60px rgba(124, 92, 255, 0.25);
      }

      * { box-sizing: border-box; }

      html, body { margin: 0; padding: 0; }

      body {
        font-family: 'Inter', system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 15px;
        line-height: 1.55;
        color: var(--text);
        background: var(--bg-0);
        background-image:
          radial-gradient(1100px 700px at 8% -10%, rgba(124, 92, 255, 0.22), transparent 60%),
          radial-gradient(900px 600px at 95% 5%, rgba(34, 211, 238, 0.16), transparent 60%),
          radial-gradient(700px 500px at 50% 100%, rgba(255, 92, 240, 0.10), transparent 60%),
          linear-gradient(180deg, #05060d 0%, #07091a 60%, #05060d 100%);
        background-attachment: fixed;
        min-height: 100vh;
      }

      /* ----- Background floaters ----- */
      .bg-grid {
        position: fixed;
        inset: 0;
        background-image:
          linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
        background-size: 56px 56px;
        mask-image: radial-gradient(ellipse 90% 70% at 50% 0%, #000 30%, transparent 75%);
        pointer-events: none;
        z-index: 0;
      }

      main {
        position: relative;
        z-index: 1;
        width: min(1240px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 48px;
      }

      /* ----- Top bar ----- */
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 14px 18px;
        border-radius: var(--radius-lg);
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015));
        backdrop-filter: blur(18px);
        box-shadow: var(--shadow-md);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .brand-mark {
        width: 46px;
        height: 46px;
        border-radius: 14px;
        overflow: hidden;
        border: 1px solid var(--border-strong);
        background: linear-gradient(135deg, rgba(124, 92, 255, 0.4), rgba(34, 211, 238, 0.3));
        display: grid;
        place-items: center;
      }

      .brand-mark img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .brand-text h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 800;
        letter-spacing: -0.01em;
      }

      .brand-text p {
        margin: 2px 0 0;
        font-size: 12px;
        color: var(--muted);
      }

      .topbar-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 12px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--surface);
        font-size: 12px;
        color: var(--text-dim);
        font-weight: 500;
      }

      .pill .dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: var(--success);
        box-shadow: 0 0 10px var(--success);
      }

      /* ----- Hero ----- */
      .hero {
        margin-top: 22px;
        padding: 38px 32px;
        border-radius: 24px;
        border: 1px solid var(--border);
        background:
          radial-gradient(900px 400px at 0% 0%, rgba(124, 92, 255, 0.18), transparent 60%),
          radial-gradient(700px 400px at 100% 0%, rgba(34, 211, 238, 0.14), transparent 60%),
          linear-gradient(180deg, rgba(20, 22, 44, 0.85), rgba(12, 14, 30, 0.85));
        box-shadow: var(--shadow-lg);
        position: relative;
        overflow: hidden;
      }

      .hero::after {
        content: '';
        position: absolute;
        right: -100px;
        top: -100px;
        width: 320px;
        height: 320px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255, 92, 240, 0.18), transparent 70%);
        pointer-events: none;
      }

      .hero-tag {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 13px;
        border-radius: 999px;
        border: 1px solid rgba(124, 92, 255, 0.35);
        background: rgba(124, 92, 255, 0.12);
        color: #d4caff;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .hero h2 {
        margin: 18px 0 10px;
        font-size: clamp(32px, 5vw, 50px);
        line-height: 1.05;
        font-weight: 800;
        letter-spacing: -0.03em;
        background: linear-gradient(135deg, #ffffff 0%, #c8c0ff 50%, #8de8ff 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .hero p {
        margin: 0;
        max-width: 680px;
        color: var(--text-dim);
        font-size: 16px;
      }

      .hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 22px;
      }

      .hero-chip {
        padding: 8px 14px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text-dim);
        font-size: 13px;
        font-weight: 500;
      }

      /* ----- Layout ----- */
      .layout {
        display: grid;
        grid-template-columns: 240px minmax(0, 1fr);
        gap: 22px;
        margin-top: 22px;
        align-items: start;
      }

      .sidebar {
        position: sticky;
        top: 22px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 14px;
        border-radius: var(--radius-lg);
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.01));
        backdrop-filter: blur(14px);
        box-shadow: var(--shadow-md);
      }

      .nav-item {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 11px 12px;
        border-radius: var(--radius-md);
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-dim);
        text-align: left;
        font: inherit;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.18s ease;
      }

      .nav-item:hover {
        background: var(--surface);
        color: var(--text);
      }

      .nav-item.is-active {
        background: linear-gradient(135deg, rgba(124, 92, 255, 0.22), rgba(34, 211, 238, 0.14));
        border-color: rgba(124, 92, 255, 0.4);
        color: #fff;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04);
      }

      .nav-index {
        width: 26px;
        height: 26px;
        border-radius: 8px;
        background: var(--surface-2);
        display: grid;
        place-items: center;
        font-size: 11px;
        font-weight: 700;
        color: var(--text-dim);
        font-family: 'JetBrains Mono', monospace;
      }

      .nav-item.is-active .nav-index {
        background: rgba(124, 92, 255, 0.35);
        color: #fff;
      }

      .nav-label {
        flex: 1;
        font-size: 14px;
      }

      .workspace {
        display: flex;
        flex-direction: column;
        gap: 18px;
        min-width: 0;
      }

      /* ----- Cards ----- */
      .card {
        position: relative;
        border-radius: var(--radius-lg);
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(20, 23, 45, 0.7), rgba(12, 14, 28, 0.7));
        backdrop-filter: blur(14px);
        box-shadow: var(--shadow-md);
        overflow: hidden;
      }

      .card-inner { padding: 24px; }

      .card-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }

      .card-title {
        margin: 0;
        font-size: 19px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }

      .card-desc {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 14px;
      }

      .card-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 11px;
        border-radius: 999px;
        background: rgba(124, 92, 255, 0.12);
        border: 1px solid rgba(124, 92, 255, 0.3);
        color: #d4caff;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        flex-shrink: 0;
      }

      /* ----- Manifest / Install card ----- */
      .install-card {
        background:
          radial-gradient(700px 300px at 0% 0%, rgba(124, 92, 255, 0.16), transparent 60%),
          linear-gradient(180deg, rgba(22, 24, 48, 0.85), rgba(14, 16, 32, 0.85));
        border-color: rgba(124, 92, 255, 0.25);
      }

      .manifest-box {
        padding: 16px 18px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: rgba(0, 0, 0, 0.3);
      }

      .manifest-label {
        margin: 0 0 6px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .manifest-url {
        margin: 0;
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        color: #c8d6ff;
        word-break: break-all;
      }

      .install-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
        gap: 18px;
      }

      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
      }

      .meta-card {
        padding: 14px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--surface);
      }

      .meta-label {
        margin: 0;
        color: var(--muted);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .meta-value {
        margin: 8px 0 0;
        font-size: 22px;
        font-weight: 800;
        letter-spacing: -0.02em;
        background: linear-gradient(135deg, #fff, #b8c5ff);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      /* ----- Buttons ----- */
      button, .btn {
        appearance: none;
        border: 0;
        font: inherit;
        cursor: pointer;
        border-radius: var(--radius-md);
        padding: 12px 18px;
        font-weight: 600;
        font-size: 14px;
        transition: all 0.18s ease;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: var(--text);
      }

      .btn-primary {
        background: linear-gradient(135deg, #7c5cff, #22d3ee);
        color: #fff;
        box-shadow: 0 12px 30px rgba(124, 92, 255, 0.35), inset 0 1px 0 rgba(255,255,255,0.2);
      }

      .btn-primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 16px 40px rgba(124, 92, 255, 0.5), inset 0 1px 0 rgba(255,255,255,0.2);
      }

      .btn-secondary {
        background: var(--surface-2);
        border: 1px solid var(--border-strong);
        color: var(--text);
      }

      .btn-secondary:hover {
        background: var(--surface-3);
        border-color: rgba(255,255,255,0.22);
      }

      .btn-ghost {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-dim);
        padding: 9px 14px;
        font-size: 13px;
        border-radius: 999px;
      }

      .btn-ghost:hover {
        background: var(--surface);
        color: var(--text);
        border-color: var(--border-strong);
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 14px 0;
      }

      /* ----- Forms ----- */
      .field { margin-top: 16px; }

      .field-label {
        display: block;
        margin-bottom: 8px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-dim);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .field-input {
        width: 100%;
        padding: 12px 14px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: rgba(0, 0, 0, 0.25);
        color: var(--text);
        font: inherit;
        font-size: 14px;
        outline: none;
        transition: all 0.18s ease;
      }

      .field-input:focus {
        border-color: rgba(124, 92, 255, 0.5);
        background: rgba(0, 0, 0, 0.4);
        box-shadow: 0 0 0 4px rgba(124, 92, 255, 0.15);
      }

      .field-input::placeholder { color: var(--muted); }

      select.field-input {
        appearance: none;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%237d86a4' d='M6 8L0 0h12z'/></svg>");
        background-repeat: no-repeat;
        background-position: right 14px center;
        padding-right: 38px;
      }

      select.field-input option {
        background: #11142a;
        color: var(--text);
      }

      .field-help {
        margin-top: 8px;
        color: var(--muted);
        font-size: 12.5px;
        line-height: 1.5;
      }

      .field-help code {
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        padding: 1px 6px;
        background: var(--surface-2);
        border-radius: 6px;
        color: #c8d6ff;
      }

      /* ----- Provider grid ----- */
      .summary-strip {
        margin-top: 12px;
        padding: 11px 14px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--surface);
        font-size: 13px;
        color: var(--text-dim);
      }

      .provider-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
        gap: 8px;
        margin-top: 14px;
        max-height: 380px;
        overflow-y: auto;
        padding-right: 4px;
      }

      .provider-grid::-webkit-scrollbar { width: 8px; }
      .provider-grid::-webkit-scrollbar-track { background: transparent; }
      .provider-grid::-webkit-scrollbar-thumb {
        background: var(--surface-3);
        border-radius: 4px;
      }

      .provider-option {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 11px 13px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--surface);
        cursor: pointer;
        transition: all 0.15s ease;
        user-select: none;
      }

      .provider-option:hover {
        background: var(--surface-2);
        border-color: rgba(124, 92, 255, 0.3);
        transform: translateY(-1px);
      }

      .provider-option:has(input:checked) {
        background: rgba(124, 92, 255, 0.12);
        border-color: rgba(124, 92, 255, 0.5);
      }

      .provider-option input {
        accent-color: #7c5cff;
        width: 16px;
        height: 16px;
        cursor: pointer;
      }

      .provider-name {
        font-size: 13.5px;
        font-weight: 500;
        word-break: break-word;
      }

      /* ----- Quality list ----- */
      .quality-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 14px;
      }

      .quality-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 14px;
        padding: 12px 14px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--surface);
        transition: all 0.15s ease;
      }

      .quality-row:hover {
        background: var(--surface-2);
        border-color: var(--border-strong);
      }

      .quality-rank {
        width: 30px;
        height: 30px;
        display: grid;
        place-items: center;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(124, 92, 255, 0.25), rgba(34, 211, 238, 0.15));
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        font-weight: 700;
        color: #d4caff;
      }

      .quality-actions { display: flex; gap: 6px; }

      .arrow-button {
        width: 32px;
        height: 32px;
        padding: 0;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--surface-2);
        color: var(--text-dim);
        font-size: 14px;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .arrow-button:hover:not(:disabled) {
        background: var(--surface-3);
        color: var(--text);
        border-color: var(--border-strong);
      }

      .arrow-button:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }

      /* ----- Choice cards ----- */
      .choice-grid {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      .three-column {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }

      .choice-card {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 12px;
        align-items: start;
        padding: 14px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--surface);
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .choice-card:hover {
        background: var(--surface-2);
        border-color: rgba(124, 92, 255, 0.3);
      }

      .choice-card:has(input:checked) {
        background: rgba(124, 92, 255, 0.1);
        border-color: rgba(124, 92, 255, 0.45);
      }

      .choice-card input {
        margin-top: 2px;
        accent-color: #7c5cff;
        width: 16px;
        height: 16px;
        cursor: pointer;
      }

      .choice-title {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
      }

      .choice-copy {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 12.5px;
        line-height: 1.5;
      }

      /* ----- Presets ----- */
      .preset-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
        margin-top: 14px;
      }

      .preset-card {
        text-align: left;
        padding: 16px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text);
        cursor: pointer;
        transition: all 0.18s ease;
        position: relative;
        overflow: hidden;
      }

      .preset-card::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, rgba(124, 92, 255, 0.08), transparent 60%);
        opacity: 0;
        transition: opacity 0.2s ease;
        pointer-events: none;
      }

      .preset-card:hover {
        background: var(--surface-2);
        border-color: rgba(124, 92, 255, 0.4);
        transform: translateY(-2px);
      }

      .preset-card:hover::before { opacity: 1; }

      .preset-card.is-active {
        background: linear-gradient(135deg, rgba(124, 92, 255, 0.18), rgba(34, 211, 238, 0.08));
        border-color: rgba(124, 92, 255, 0.55);
        box-shadow: 0 0 0 1px rgba(124, 92, 255, 0.3), 0 14px 36px rgba(124, 92, 255, 0.22);
      }

      .preset-card.is-active::before { opacity: 1; }

      .preset-name {
        margin: 0 0 6px;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }

      .preset-copy {
        margin: 0;
        color: var(--muted);
        font-size: 12.5px;
        line-height: 1.5;
      }

      .preset-status {
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: var(--radius-md);
        border: 1px dashed var(--border-strong);
        background: var(--surface);
        color: var(--text-dim);
        font-size: 13px;
      }

      .preset-status strong { color: var(--text); }

      /* ----- Empty state ----- */
      .empty-state {
        margin-top: 14px;
        padding: 18px;
        border-radius: var(--radius-md);
        background: var(--surface);
        color: var(--muted);
        text-align: center;
        font-size: 13.5px;
      }

      /* ----- Two column ----- */
      .two-column {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 18px;
      }

      /* ----- Preview ----- */
      .preview-grid {
        display: grid;
        grid-template-columns: 160px minmax(0, 1fr) auto;
        gap: 10px;
        margin-top: 14px;
      }

      .preview-result {
        margin-top: 14px;
        padding: 16px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: rgba(0, 0, 0, 0.2);
      }

      .preview-empty {
        color: var(--muted);
        font-size: 13.5px;
        text-align: center;
        padding: 8px 0;
      }

      .stat-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 8px;
      }

      .stat-card {
        padding: 12px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--surface);
      }

      .stat-label {
        margin: 0;
        color: var(--muted);
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .stat-value {
        margin: 6px 0 0;
        font-size: 24px;
        font-weight: 800;
        letter-spacing: -0.02em;
        background: linear-gradient(135deg, #fff, #b8c5ff);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .reason-list, .sample-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 14px;
      }

      .diagnostic-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .reason-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 10px 13px;
        border-radius: var(--radius-md);
        background: var(--surface);
        border: 1px solid var(--border);
        font-size: 13px;
      }

      .reason-row strong {
        font-family: 'JetBrains Mono', monospace;
        color: #ffd0a8;
      }

      .sample-row {
        padding: 11px 13px;
        border-radius: var(--radius-md);
        background: var(--surface);
        border: 1px solid var(--border);
        font-size: 13px;
      }

      .sample-row strong {
        display: block;
        color: var(--text);
        font-size: 13.5px;
        margin-bottom: 4px;
      }

      .diagnostic-examples {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-left: 12px;
        border-left: 2px solid var(--border-strong);
        margin-left: 8px;
      }

      .diagnostic-example {
        padding: 9px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: rgba(0,0,0,0.2);
      }

      .diagnostic-example strong {
        display: block;
        color: var(--text);
        font-size: 12.5px;
      }

      .diagnostic-meta, .sample-meta {
        color: var(--muted);
        font-size: 11.5px;
        margin-top: 3px;
        font-family: 'JetBrains Mono', monospace;
      }

      .adapter-provider-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 12px;
      }

      .adapter-provider-group {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--surface);
        overflow: hidden;
      }

      .adapter-provider-head {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: transparent;
        color: var(--text);
        text-align: left;
        font-weight: 800;
      }

      .adapter-provider-head small {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      .adapter-provider-body {
        display: none;
        padding: 0 14px 14px;
        border-top: 1px solid var(--border);
      }

      .adapter-provider-group.open .adapter-provider-body {
        display: block;
      }

      .adapter-provider-actions {
        display: flex;
        gap: 8px;
        margin: 12px 0;
      }

      .adapter-provider-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 8px;
      }

      .adapter-provider-option {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--surface-2);
        color: var(--text-dim);
        font-size: 12px;
        font-weight: 700;
      }

      /* ----- Support ----- */
      .support-shell {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .support-card {
        padding: 20px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: linear-gradient(135deg, rgba(34, 211, 238, 0.06), rgba(124, 92, 255, 0.05));
      }

      .support-card h3 {
        margin: 0 0 8px;
        font-size: 17px;
        font-weight: 700;
      }

      .support-card p {
        margin: 0;
        color: var(--text-dim);
        font-size: 14px;
      }

      .supporters-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 18px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.035);
      }

      .supporters-title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        color: var(--text-dim);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-align: center;
        text-transform: uppercase;
      }

      .supporters-star {
        color: var(--warning);
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
        min-height: 28px;
        padding: 5px 12px;
        border-radius: 8px;
        border: 1px solid rgba(52, 211, 153, 0.35);
        background: rgba(52, 211, 153, 0.12);
        color: #36f4b4;
        font-size: 12px;
        font-weight: 700;
      }

      .support-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }

      .donate-toggle {
        background: linear-gradient(135deg, #34d399, #22d3ee);
        color: #051018;
        font-weight: 700;
      }

      .donate-toggle:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 30px rgba(34, 211, 238, 0.4);
      }

      .support-link {
        padding: 12px 18px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-strong);
        background: var(--surface-2);
        color: var(--text);
        font-size: 14px;
        font-weight: 600;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        transition: all 0.18s ease;
      }

      .support-link:hover {
        background: var(--surface-3);
        border-color: rgba(255,255,255,0.25);
      }

      .widget-panel {
        display: none;
        padding: 16px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--surface);
      }

      .widget-panel.open { display: block; }

      .widget-frame {
        display: block;
        width: min(100%, 420px);
        min-height: 600px;
        margin: 0 auto;
        border: 0;
        border-radius: 12px;
        background: #fff;
      }

      /* ----- Notes ----- */
      .notes-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 14px;
      }

      .note-item {
        margin: 0;
        padding: 13px 16px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text-dim);
        font-size: 13.5px;
        line-height: 1.55;
      }

      .note-item strong { color: var(--text); }

      .disclaimer {
        margin-top: 16px;
        padding: 16px;
        border-radius: var(--radius-md);
        border: 1px solid rgba(248, 113, 113, 0.25);
        background: rgba(248, 113, 113, 0.06);
      }

      .disclaimer-text {
        margin: 0;
        color: var(--text-dim);
        font-size: 13.5px;
        line-height: 1.6;
      }

      .disclaimer-text strong { color: var(--danger); }

      /* ----- Flash ----- */
      .flash {
        min-height: 22px;
        margin-top: 12px;
        font-size: 13px;
        color: var(--text-dim);
        font-weight: 500;
      }

      /* ----- Responsive ----- */
      @media (max-width: 1024px) {
        .layout { grid-template-columns: 1fr; }
        .sidebar {
          position: static;
          flex-direction: row;
          flex-wrap: wrap;
          overflow-x: auto;
        }
        .nav-item { flex: 1 1 140px; min-width: 140px; }
        .install-grid, .two-column, .three-column {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 640px) {
        main {
          width: calc(100vw - 20px);
          padding: 16px 0 32px;
        }
        .topbar { padding: 12px 14px; }
        .hero { padding: 28px 22px; }
        .card-inner { padding: 18px; }
        .preview-grid { grid-template-columns: 1fr; }
        .actions { flex-direction: column; }
        .actions .btn { width: 100%; }
        .brand-text p { display: none; }
      }

      section[id] { scroll-margin-top: 16px; }

      /* fade-in */
      .card { animation: fadeIn 0.5s ease both; }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* compact configure skin */
      :root {
        --bg-0: #11151d;
        --bg-1: #151a23;
        --bg-2: #1a202b;
        --surface: #171c25;
        --surface-2: #1d2430;
        --surface-3: #242c3a;
        --border: #303847;
        --border-strong: #465165;
        --text: #f2f5fb;
        --text-dim: #b7c0d0;
        --muted: #818b9d;
        --accent: #2f6df6;
        --accent-2: #24c6a5;
        --accent-3: #c56cf0;
        --success: #29d391;
        --warning: #f0b84c;
        --danger: #f26d6d;
        --radius-lg: 8px;
        --radius-md: 6px;
        --radius-sm: 4px;
        --shadow-lg: none;
        --shadow-md: none;
        --shadow-glow: none;
      }

      body {
        font-size: 14px;
        line-height: 1.45;
        background: #11151d;
        background-image: none;
      }

      .bg-grid,
      .hero,
      .sidebar {
        display: none;
      }

      main {
        width: min(100% - 20px, 520px);
        padding: 14px 0 28px;
      }

      .topbar,
      .card {
        border: 1px solid var(--border);
        background: var(--surface);
        border-radius: var(--radius-lg);
        backdrop-filter: none;
        box-shadow: none;
      }

      .topbar {
        padding: 12px;
      }

      .brand-mark {
        width: 38px;
        height: 38px;
        border-radius: 7px;
        background: #202733;
      }

      .brand-text h1 {
        font-size: 16px;
        letter-spacing: 0;
      }

      .brand-text p,
      .pill,
      .card-desc,
      .field-help,
      .choice-copy,
      .preset-copy,
      .note-item,
      .disclaimer-text,
      .support-card p {
        font-size: 12px;
      }

      .pill {
        padding: 5px 8px;
        border-radius: 999px;
        background: var(--surface-2);
      }

      .layout {
        display: block;
        margin-top: 12px;
      }

      .workspace {
        gap: 10px;
      }

      .card {
        overflow: hidden;
        animation: none;
      }

      .install-card {
        background: var(--surface);
        border-color: var(--border);
      }

      .card-inner {
        padding: 14px;
      }

      .card-header {
        margin-bottom: 12px;
        gap: 10px;
      }

      .card-title {
        font-size: 15px;
        letter-spacing: 0;
      }

      .card-badge {
        display: none;
      }

      .install-grid,
      .two-column,
      .three-column,
      .preview-grid {
        grid-template-columns: 1fr;
        gap: 10px;
      }

      .manifest-box,
      .meta-card,
      .summary-strip,
      .provider-option,
      .quality-row,
      .choice-card,
      .preset-card,
      .preset-status,
      .preview-result,
      .stat-card,
      .reason-row,
      .sample-row,
      .support-card,
      .widget-panel,
      .note-item,
      .disclaimer {
        border-radius: var(--radius-md);
        border-color: var(--border);
        background: var(--surface-2);
        box-shadow: none;
      }

      .manifest-box {
        padding: 10px 12px;
      }

      .manifest-label,
      .meta-label,
      .stat-label,
      .field-label {
        font-size: 10px;
        letter-spacing: 0.04em;
      }

      .manifest-url {
        font-size: 11px;
        color: #c9d7f5;
      }

      .meta-grid,
      .stat-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }

      .meta-card,
      .stat-card {
        padding: 10px;
      }

      .meta-value,
      .stat-value {
        margin-top: 5px;
        font-size: 18px;
        color: var(--text);
        background: none;
        -webkit-text-fill-color: currentColor;
      }

      button,
      .btn,
      .support-link {
        border-radius: var(--radius-md);
        padding: 10px 12px;
        font-size: 13px;
      }

      .btn-primary {
        width: 100%;
        background: #2f6df6;
        box-shadow: none;
      }

      .btn-primary:hover,
      .donate-toggle:hover,
      .preset-card:hover,
      .provider-option:hover {
        transform: none;
        box-shadow: none;
      }

      .btn-secondary,
      .btn-ghost,
      .support-link {
        background: var(--surface-2);
        border: 1px solid var(--border);
      }

      .actions,
      .toolbar,
      .support-actions {
        gap: 8px;
        margin-top: 10px;
      }

      .field {
        margin-top: 12px;
      }

      .field-input {
        padding: 10px 11px;
        border-radius: var(--radius-md);
        border-color: var(--border);
        background: #11151d;
        font-size: 13px;
      }

      .field-input:focus {
        border-color: #5f84f8;
        background: #11151d;
        box-shadow: 0 0 0 2px rgba(47, 109, 246, 0.25);
      }

      select.field-input option {
        background: #171c25;
      }

      .provider-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        max-height: 260px;
        gap: 7px;
      }

      .provider-option,
      .choice-card {
        padding: 10px;
      }

      .provider-option:has(input:checked),
      .choice-card:has(input:checked),
      .preset-card.is-active {
        background: #1c2a43;
        border-color: #3d6ce8;
        box-shadow: none;
      }

      .provider-option input,
      .choice-card input {
        accent-color: #2f6df6;
      }

      .provider-name,
      .choice-title {
        font-size: 13px;
      }

      .quality-row {
        grid-template-columns: 28px 1fr auto;
        gap: 10px;
        padding: 9px 10px;
      }

      .quality-rank {
        width: 24px;
        height: 24px;
        border-radius: var(--radius-sm);
        background: #202838;
        color: var(--text-dim);
      }

      .arrow-button {
        width: 28px;
        height: 28px;
        border-radius: var(--radius-sm);
        background: #202838;
      }

      .choice-grid,
      .preset-grid,
      .quality-list,
      .notes-list,
      .reason-list,
      .sample-list {
        gap: 7px;
        margin-top: 10px;
      }

      .preset-grid {
        grid-template-columns: 1fr;
      }

      .preset-card {
        padding: 12px;
      }

      .preset-card::before {
        display: none;
      }

      .preset-name {
        font-size: 14px;
      }

      .support-card {
        padding: 14px;
      }

      .donate-toggle {
        background: #24c6a5;
        color: #071510;
      }

      .widget-frame {
        min-height: 520px;
        border-radius: var(--radius-md);
      }

      .torbox-card {
        border-color: #3b4658;
        background: #1a202a;
      }

      .torbox-head,
      .torbox-toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
      }

      .torbox-head {
        padding-bottom: 12px;
        border-bottom: 1px solid var(--border);
      }

      .torbox-help {
        margin-top: 10px;
        padding: 10px 12px;
        border-radius: var(--radius-md);
        background: #111820;
      }

      .torbox-help a {
        color: #7fb0ff;
        font-size: 13px;
        font-weight: 700;
        text-decoration: underline;
        text-underline-offset: 3px;
      }

      .torbox-options {
        display: grid;
        gap: 16px;
        margin-top: 18px;
      }

      .torbox-toggle-row strong {
        display: block;
        color: var(--text);
        font-size: 13px;
      }

      .torbox-toggle-row small {
        color: #b69cff;
        font-size: 11px;
      }

      .torbox-toggle-row em {
        display: block;
        margin-top: 3px;
        color: var(--muted);
        font-size: 12px;
        font-style: normal;
      }

      .torbox-toggle-row .warning-copy {
        color: #f0c34c;
        font-style: italic;
      }

      .switch {
        position: relative;
        display: inline-flex;
        width: 48px;
        height: 26px;
        flex: 0 0 auto;
        cursor: pointer;
      }

      .switch input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
      }

      .switch > span {
        width: 100%;
        border-radius: 999px;
        background: #566173;
        transition: background 0.16s ease;
      }

      .switch > span::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #f5f7fb;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
        transition: transform 0.16s ease;
      }

      .switch input:checked + span {
        background: #2f6df6;
      }

      .switch input:checked + span::after {
        transform: translateX(22px);
      }

      .switch-small {
        width: 42px;
        height: 24px;
      }

      .switch-small > span::after {
        width: 18px;
        height: 18px;
      }

      .switch-small input:checked + span::after {
        transform: translateX(18px);
      }

      .mode-switch {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-top: 10px;
        padding: 5px;
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--surface);
      }

      .mode-button {
        padding: 9px 10px;
        border-radius: var(--radius-md);
        background: transparent;
        color: var(--text-dim);
      }

      .mode-button.is-active {
        background: #2f6df6;
        color: #fff;
      }

      .simple-settings {
        display: none;
      }

      body[data-config-mode="simple"] .simple-settings {
        display: block;
      }

      body[data-config-mode="simple"] .advanced-only {
        display: none;
      }

      .simple-quality-grid,
      .simple-limit-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-top: 10px;
      }

      .simple-quality {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--surface-2);
        font-weight: 700;
        font-size: 13px;
      }

      .simple-quality input {
        accent-color: #2f6df6;
      }

      .simple-footer {
        display: none;
        margin: 14px 0 4px;
        padding: 4px 0 2px;
        text-align: center;
      }

      body[data-config-mode="simple"] .simple-footer {
        display: block;
      }

      .simple-support-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 11px 16px;
        border-radius: 8px;
        background: #7ea8ef;
        color: #fff;
        font-weight: 800;
        text-decoration: none;
      }

      .simple-footer-links {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 22px;
        margin-top: 16px;
      }

      .simple-social-link {
        display: inline-grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: 999px;
        color: #fff;
        font-size: 13px;
        font-weight: 900;
        text-decoration: none;
      }

      .simple-social-link img,
      .simple-social-link svg {
        width: 18px;
        height: 18px;
        display: block;
      }

      .simple-social-link.stremio {
        background: #725cff;
      }

      .simple-social-link.discord {
        background: #5865f2;
      }

      .simple-status-link {
        color: #e5e7eb;
        text-decoration: underline;
        text-underline-offset: 3px;
      }

      .simple-footer-credit {
        margin: 12px 0 0;
        color: #e5e7eb;
        font-size: 14px;
      }

      .simple-footer-credit a {
        color: #fff;
        text-decoration: underline;
        text-underline-offset: 3px;
      }

      @media (max-width: 640px) {
        main {
          width: calc(100vw - 18px);
          padding: 10px 0 24px;
        }
        .topbar-actions {
          display: none;
        }
        .card-inner {
          padding: 12px;
        }
        .meta-grid,
        .stat-grid,
        .provider-grid,
        .simple-quality-grid,
        .simple-limit-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="bg-grid"></div>
    <main>
      <!-- TOP BAR -->
      <div class="topbar">
        <div class="brand">
          <div class="brand-mark">
            <img src="${escapeHtml(baseUrl)}/assets/WhatsApp%20Image%202026-04-25%20at%2012.16.53%20AM.jpeg" alt="NebulaStreams" onerror="this.style.display='none'">
          </div>
          <div class="brand-text">
            <h1>NebulaStreams</h1>
            <p>Stremio addon configuration</p>
          </div>
        </div>
        <div class="topbar-actions">
          <span class="pill"><span class="dot"></span>Live</span>
          <span class="pill">${providers.length} providers</span>
        </div>
      </div>

      <div class="mode-switch" role="tablist" aria-label="Configuration mode">
        <button type="button" class="mode-button is-active" data-config-mode="simple">Simple</button>
        <button type="button" class="mode-button" data-config-mode="advanced">Advanced</button>
      </div>

      <!-- HERO -->
      <section class="hero">
        <span class="hero-tag">Configure addon</span>
        <h2>Build your perfect stream pipeline.</h2>
        <p>Pick providers, sort qualities, fine-tune filters, then install in one click. Every change updates the install URL in real time.</p>
        <div class="hero-meta">
          <div class="hero-chip">⚡ Live manifest</div>
          <div class="hero-chip">🎯 Smart presets</div>
          <div class="hero-chip">TorBox support</div>
          <div class="hero-chip">🔒 Private configs</div>
        </div>
      </section>

      <!-- LAYOUT -->
      <div class="layout">
        <!-- SIDEBAR -->
        <aside class="sidebar">
          <button type="button" class="nav-item is-active" data-section-target="overview-section">
            <span class="nav-index">01</span><span class="nav-label">Install</span>
          </button>
          <button type="button" class="nav-item advanced-only" data-section-target="presets-section">
            <span class="nav-index">02</span><span class="nav-label">Presets</span>
          </button>
          <button type="button" class="nav-item advanced-only" data-section-target="providers-section">
            <span class="nav-index">03</span><span class="nav-label">Providers</span>
          </button>
          <button type="button" class="nav-item advanced-only" data-section-target="adapter-providers-section">
            <span class="nav-index">04</span><span class="nav-label">Adapters</span>
          </button>
          <button type="button" class="nav-item advanced-only" data-section-target="sorting-section">
            <span class="nav-index">05</span><span class="nav-label">Quality</span>
          </button>
          <button type="button" class="nav-item advanced-only" data-section-target="filters-section">
            <span class="nav-index">06</span><span class="nav-label">Filters</span>
          </button>
          <button type="button" class="nav-item advanced-only" data-section-target="ranking-section">
            <span class="nav-index">07</span><span class="nav-label">Ranking</span>
          </button>
          <button type="button" class="nav-item" data-section-target="torbox-section">
            <span class="nav-index">08</span><span class="nav-label">TorBox</span>
          </button>
          <button type="button" class="nav-item" data-section-target="xtream-section">
            <span class="nav-index">09</span><span class="nav-label">IPTV</span>
          </button>
          <button type="button" class="nav-item" data-section-target="support-section">
            <span class="nav-index">10</span><span class="nav-label">Support</span>
          </button>
          <button type="button" class="nav-item" data-section-target="notes-section">
            <span class="nav-index">11</span><span class="nav-label">Notes</span>
          </button>
        </aside>

        <!-- WORKSPACE -->
        <div class="workspace">
          <!-- INSTALL -->
          <section class="card install-card" id="overview-section">
            <div class="card-inner">
              <div class="card-header">
                <div>
                  <h3 class="card-title">Install URL</h3>
                  <p class="card-desc">This is the manifest NebulaStreams will generate from your current settings.</p>
                </div>
                <span class="card-badge">Save & Install</span>
              </div>

              <div class="install-grid">
                <div>
                  <div class="manifest-box">
                    <p class="manifest-label">Manifest URL</p>
                    <p class="manifest-url" id="manifest-url">${escapeHtml(baseUrl)}/manifest.json</p>
                  </div>
                  <div class="actions">
                    <button type="button" class="btn-primary" id="install-addon">⬇ Install Add-on</button>
                    <button type="button" class="btn-secondary" id="copy-url">📋 Copy URL</button>
                  </div>
                  <div class="flash" id="flash" aria-live="polite"></div>
                </div>

                <div class="meta-grid">
                  <div class="meta-card">
                    <p class="meta-label">Providers</p>
                    <p class="meta-value" id="overview-provider-count">${providers.length}</p>
                  </div>
                  <div class="meta-card">
                    <p class="meta-label">Quality</p>
                    <p class="meta-value">Custom</p>
                  </div>
                  <div class="meta-card">
                    <p class="meta-label">TorBox</p>
                    <p class="meta-value">Ready</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <div class="supporters-card" aria-label="Special thanks to supporters">
            <p class="supporters-title"><span class="supporters-star" aria-hidden="true">★</span> Special thanks to our supporters</p>
            <div class="supporter-list">
              ${renderSupporterPills()}
            </div>
          </div>

          <!-- PRESETS -->
          <section class="card simple-settings" id="simple-section">
            <div class="card-inner">
              <div class="card-header">
                <div>
                  <h3 class="card-title">Simple Settings</h3>
                  <p class="card-desc">Quick setup with common stream controls.</p>
                </div>
              </div>

              <div class="field">
                <label class="field-label">Video Qualities</label>
                <div class="simple-quality-grid">
                  <label class="simple-quality"><input type="checkbox" class="simple-quality-input" value="2160p" checked>2160p (4K)</label>
                  <label class="simple-quality"><input type="checkbox" class="simple-quality-input" value="1080p" checked>1080p</label>
                  <label class="simple-quality"><input type="checkbox" class="simple-quality-input" value="720p" checked>720p</label>
                  <label class="simple-quality"><input type="checkbox" class="simple-quality-input" value="480p" checked>480p</label>
                </div>
              </div>

              <div class="field">
                <label class="field-label" for="simple-content-selection">Content Selection</label>
                <select id="simple-content-selection" class="field-input">
                  <option value="default">Default Content Only</option>
                  <option value="movie">Movies Only</option>
                  <option value="series">Series Only</option>
                </select>
              </div>

              <div class="field">
                <label class="field-label" for="simple-default-sorting">Default Sorting</label>
                <select id="simple-default-sorting" class="field-input">
                  <option value="highest" selected>Highest Quality</option>
                  <option value="highest-non-4k">Highest Non-4K Quality</option>
                  <option value="balanced">Balanced</option>
                </select>
              </div>

              <div class="field">
                <label class="field-label">Result Limits</label>
                <div class="simple-limit-grid">
                  <label>
                    <span class="field-label" for="simple-max-per-quality">Max Per Quality</span>
                    <select id="simple-max-per-quality" class="field-input">
                      <option value="0">Unlimited</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="5">5</option>
                    </select>
                  </label>
                  <label>
                    <span class="field-label" for="simple-max-per-provider">Max Per Provider</span>
                    <select id="simple-max-per-provider" class="field-input">
                      <option value="0">Unlimited</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="5">5</option>
                    </select>
                  </label>
                </div>
              </div>
            </div>
          </section>

          <section class="card advanced-only" id="presets-section">
            <div class="card-inner">
              <div class="card-header">
                <div>
                  <h3 class="card-title">One-Click Presets</h3>
                  <p class="card-desc">Apply a ready-made profile, then tweak anything you want manually.</p>
                </div>
                <span class="card-badge">Presets</span>
              </div>

              <div class="preset-grid">
                <button type="button" class="preset-card" data-preset-id="web-fast">
                  <p class="preset-name">⚡ Web Fast</p>
                  <p class="preset-copy">Direct-friendly playback, H.264 preference, aggressive dedupe.</p>
                </button>
                <button type="button" class="preset-card" data-preset-id="mobile-data">
                  <p class="preset-name">📱 Mobile Data</p>
                  <p class="preset-copy">Smaller files & resolutions, tighter caps for low-bandwidth.</p>
                </button>
                <button type="button" class="preset-card" data-preset-id="4k-hdr">
                  <p class="preset-name">🎬 4K HDR</p>
                  <p class="preset-copy">Top-end quality and HDR releases, no size restrictions.</p>
                </button>
                <button type="button" class="preset-card" data-preset-id="anime">
                  <p class="preset-name">🍙 Anime</p>
                  <p class="preset-copy">Anime-focused providers with Japanese audio preference.</p>
                </button>
                <button type="button" class="preset-card" data-preset-id="indian-content">
                  <p class="preset-name">🇮🇳 Indian Content</p>
                  <p class="preset-copy">Indian-focused providers, direct hosts preferred.</p>
                </button>
                <button type="button" class="preset-card" data-preset-id="turkish-content">
                  <p class="preset-name">🇹🇷 Turkish Content</p>
                  <p class="preset-copy">Turkish-focused providers for movies and series.</p>
                </button>
                <button type="button" class="preset-card" data-preset-id="italian-content">
                  <p class="preset-name">🇮🇹 Italian Content</p>
                  <p class="preset-copy">Italian-focused providers for movies, series, anime.</p>
                </button>
                <button type="button" class="preset-card" data-preset-id="latino-content">
                  <p class="preset-name">🌶 Latino Content</p>
                  <p class="preset-copy">Spanish and Latino-focused providers.</p>
                </button>
                <button type="button" class="preset-card" data-preset-id="french-content">
                  <p class="preset-name">🇫🇷 French Content</p>
                  <p class="preset-copy">French movies, series, and anime providers.</p>
                </button>
                <button type="button" class="preset-card" data-preset-id="arabic-content">
                  <p class="preset-name">🌙 Arabic Content</p>
                  <p class="preset-copy">Arabic-focused providers for movies, series, anime.</p>
                </button>
              </div>

              <div class="preset-status" id="preset-status">Preset: <strong>Custom</strong></div>
            </div>
          </section>

          <!-- PROVIDERS -->
          <section class="card advanced-only" id="providers-section">
            <div class="card-inner">
              <div class="card-header">
                <div>
                  <h3 class="card-title">Provider Selection</h3>
                  <p class="card-desc">Pick any combination. Leaving everything unchecked falls back to all providers.</p>
                </div>
                <span class="card-badge">Providers</span>
              </div>

              <div class="field">
                <label class="field-label" for="provider-search">Search providers</label>
                <input id="provider-search" class="field-input" type="text" placeholder="Type to filter…" spellcheck="false" autocomplete="off">
                <div class="field-help">Examples: ${providerHints || '4khdhub, cinestream, streamflix'}</div>
              </div>

              <div class="toolbar">
                <button type="button" class="btn-ghost" id="select-all-providers">Select all</button>
                <button type="button" class="btn-ghost" id="clear-providers">Clear</button>
              </div>

              <div class="summary-strip" id="provider-summary">All providers selected</div>
              <div class="provider-grid" id="provider-grid"></div>
            </div>
          </section>

          <section class="card advanced-only" id="adapter-providers-section">
            <div class="card-inner">
              <div class="card-header">
                <div>
                  <h3 class="card-title">Adapter Providers</h3>
                  <p class="card-desc">Open adapter groups and choose source providers inside plugins.</p>
                </div>
                <span class="card-badge">Adapters</span>
              </div>

              <div class="summary-strip" id="adapter-provider-summary">Loading adapter providers...</div>
              <div class="adapter-provider-list" id="adapter-provider-list"></div>
            </div>
          </section>

          <!-- TWO COLUMN: SORTING + FILTERS -->
          <div class="two-column advanced-only">
            <section class="card advanced-only" id="sorting-section">
              <div class="card-inner">
                <div class="card-header">
                  <div>
                    <h3 class="card-title">Quality Priority</h3>
                    <p class="card-desc">Move preferred qualities up. Used for ranking results.</p>
                  </div>
                  <span class="card-badge">Sort</span>
                </div>
                <div class="toolbar">
                  <button type="button" class="btn-ghost" id="reset-quality-order">↺ Reset</button>
                </div>
                <div class="quality-list" id="quality-list"></div>
              </div>
            </section>

            <section class="card advanced-only" id="filters-section">
              <div class="card-inner">
                <div class="card-header">
                  <div>
                    <h3 class="card-title">Playback Filters</h3>
                    <p class="card-desc">Cut noisy results without losing unknown or unlabeled streams.</p>
                  </div>
                  <span class="card-badge">Filter</span>
                </div>

                <div class="choice-grid">
                  <label class="choice-card">
                    <input type="checkbox" id="web-ready-only">
                    <div>
                      <p class="choice-title">Web-ready only</p>
                      <p class="choice-copy">Strict — only simple MP4-style links without proxy headers. Reduces results heavily.</p>
                    </div>
                  </label>
                  <label class="choice-card">
                    <input type="checkbox" id="hide-heavy-formats">
                    <div>
                      <p class="choice-title">Hide HEVC / HDR / 10-bit</p>
                      <p class="choice-copy">For lighter playback devices that struggle with heavier codecs.</p>
                    </div>
                  </label>
                </div>

                <div class="field">
                  <label class="field-label" for="formatter-style">Stream card formatter</label>
                  <select id="formatter-style" class="field-input">
                    <option value="clean">Clean</option>
                    <option value="detailed">Detailed</option>
                    <option value="compact">Compact</option>
                    <option value="minimal">Minimal</option>
                  </select>
                  <div class="field-help">Choose how stream cards are displayed in Stremio.</div>
                </div>

                <div class="field">
                  <label class="field-label" for="preferred-audio-language">Preferred audio language</label>
                  <select id="preferred-audio-language" class="field-input">
                    <option value="">Any language</option>
                    <option value="Hindi">Hindi</option>
                    <option value="English">English</option>
                    <option value="Tamil">Tamil</option>
                    <option value="Telugu">Telugu</option>
                    <option value="Malayalam">Malayalam</option>
                    <option value="Kannada">Kannada</option>
                    <option value="Japanese">Japanese</option>
                    <option value="Korean">Korean</option>
                    <option value="Turkish">Turkish</option>
                    <option value="Italian">Italian</option>
                    <option value="Latino">Latino</option>
                    <option value="Spanish">Spanish</option>
                    <option value="Arabic">Arabic</option>
                  </select>
                  <div class="field-help">Keeps matches and unknown-language streams. Only clearly different audio is filtered.</div>
                </div>

                <div class="field">
                  <label class="field-label" for="max-size-gb">Maximum file size</label>
                  <select id="max-size-gb" class="field-input">
                    <option value="0">No limit</option>
                    <option value="1.5">1.5 GB</option>
                    <option value="3">3 GB</option>
                    <option value="5">5 GB</option>
                    <option value="10">10 GB</option>
                    <option value="20">20 GB</option>
                  </select>
                  <div class="field-help">Hide oversized files for lighter playback or smaller downloads.</div>
                </div>

                <div class="field">
                  <label class="field-label" for="blocked-hosts">Blocked hosts</label>
                  <input id="blocked-hosts" class="field-input" type="text" placeholder="pixeldrain.dev, hub.toxix.buzz" spellcheck="false" autocomplete="off">
                  <div class="field-help">Comma-separated host fragments to hide.</div>
                </div>

                <div class="field">
                  <label class="field-label" for="custom-proxy-url">Custom proxy URL</label>
                  <input id="custom-proxy-url" class="field-input" type="text" placeholder="https://your-proxy.example/?url={url}&headers={headers}" spellcheck="false" autocomplete="off">
                  <div class="field-help">Optional. HTTP streams will be rewritten through your proxy. Supports <code>{url}</code> and <code>{headers}</code> placeholders. Stored behind a private config id.</div>
                </div>

                <div class="field">
                  <label class="field-label" for="febbox-ui-cookie">Febbox UI cookie (ShowBox)</label>
                  <input id="febbox-ui-cookie" class="field-input" type="password" placeholder="Optional personal token" spellcheck="false" autocomplete="off">
                  <div class="field-help">Optional. Enables ShowBox with your own Febbox UI cookie. Stored behind a private config id.</div>
                </div>

                <div class="field">
                  <label class="field-label" for="dedupe-mode">Deduplication mode</label>
                  <select id="dedupe-mode" class="field-input">
                    <option value="off">Off</option>
                    <option value="smart">Smart (Recommended)</option>
                    <option value="filename">By filename</option>
                    <option value="host-quality">By host + quality</option>
                  </select>
                  <div class="field-help">Collapse duplicates after ranking, keeping the best-scored copy.</div>
                </div>
              </div>
            </section>
          </div>

          <!-- RANKING -->
          <section class="card advanced-only" id="ranking-section">
            <div class="card-inner">
              <div class="card-header">
                <div>
                  <h3 class="card-title">Preference Boosts</h3>
                  <p class="card-desc">These don't remove streams — they push matching streams higher.</p>
                </div>
                <span class="card-badge">Ranking</span>
              </div>

              <div class="three-column">
                <label class="choice-card">
                  <input type="checkbox" id="prefer-hdr">
                  <div>
                    <p class="choice-title">Prefer HDR</p>
                    <p class="choice-copy">Push HDR & Dolby Vision higher.</p>
                  </div>
                </label>
                <label class="choice-card">
                  <input type="checkbox" id="prefer-h264">
                  <div>
                    <p class="choice-title">Prefer H.264 / x264</p>
                    <p class="choice-copy">For players that struggle with HEVC.</p>
                  </div>
                </label>
                <label class="choice-card">
                  <input type="checkbox" id="prefer-smaller-files">
                  <div>
                    <p class="choice-title">Prefer smaller files</p>
                    <p class="choice-copy">When speed matters more than quality.</p>
                  </div>
                </label>
                <label class="choice-card">
                  <input type="checkbox" id="prefer-direct-hosts">
                  <div>
                    <p class="choice-title">Prefer direct hosts</p>
                    <p class="choice-copy">Direct HTTP above streams that need extra headers.</p>
                  </div>
                </label>
              </div>
            </div>
          </section>

          <!-- TORBOX -->
          <section class="card torbox-card" id="torbox-section">
            <div class="card-inner">
              <div class="torbox-head">
                <div>
                  <h3 class="card-title">TorBox Integration</h3>
                  <p class="card-desc">Stream without buffering. Highly recommended.</p>
                </div>
                <label class="switch" aria-label="Enable TorBox integration">
                  <input type="checkbox" id="torbox-enabled" checked>
                  <span></span>
                </label>
              </div>

              <div class="field">
                <label class="field-label" for="torbox-api-key">API Key</label>
                <input id="torbox-api-key" class="field-input" type="password" placeholder="e.g. abcd1234-e123-567f-gh8i-jkl1m123456z" spellcheck="false" autocomplete="off">
              </div>

              <div class="torbox-help">
                <a href="https://torbox.app/settings" target="_blank" rel="noopener">Find your API key here</a>
              </div>

              <div class="torbox-options">
                <label class="torbox-toggle-row">
                  <span>
                    <strong>TorBox Only Streams</strong>
                    <em>Excludes normal search results</em>
                  </span>
                  <span class="switch switch-small">
                    <input type="checkbox" id="torbox-only-streams">
                    <span></span>
                  </span>
                </label>

                <label class="torbox-toggle-row">
                  <span>
                    <strong>TorBox Usenet <small>(Recommended)</small></strong>
                    <em class="warning-copy">Pro plan only - do not enable on Essential/Standard</em>
                  </span>
                  <span class="switch switch-small">
                    <input type="checkbox" id="torbox-usenet">
                    <span></span>
                  </span>
                </label>
              </div>
            </div>
          </section>

          <!-- XTREAM -->
          <section class="card torbox-card" id="xtream-section">
            <div class="card-inner">
              <div class="torbox-head">
                <div>
                  <h3 class="card-title">Xtream Codes IPTV</h3>
                  <p class="card-desc">Add private IPTV live TV, VOD, series, categories, and EPG.</p>
                </div>
                <label class="switch" aria-label="Enable Xtream Codes IPTV">
                  <input type="checkbox" id="xtream-enabled">
                  <span></span>
                </label>
              </div>

              <div class="field">
                <label class="field-label" for="xtream-server-url">Server URL</label>
                <input id="xtream-server-url" class="field-input" type="url" placeholder="https://example.com:8080" spellcheck="false" autocomplete="off">
              </div>

              <div class="field-grid">
                <div class="field">
                  <label class="field-label" for="xtream-username">Username</label>
                  <input id="xtream-username" class="field-input" type="text" placeholder="IPTV username" spellcheck="false" autocomplete="off">
                </div>
                <div class="field">
                  <label class="field-label" for="xtream-password">Password</label>
                  <input id="xtream-password" class="field-input" type="password" placeholder="IPTV password" spellcheck="false" autocomplete="off">
                </div>
              </div>
              <p id="xtream-validation-status" class="torbox-help" style="min-height:18px;margin-top:-4px;"></p>

              <div class="torbox-help">
                Credentials are stored only in the private manifest config and are not placed in the public install URL.
              </div>

              <div class="field-grid">
                <div class="field">
                  <label class="field-label" for="stalker-portal-url">Stalker Portal URL</label>
                  <input id="stalker-portal-url" class="field-input" type="url" placeholder="http://example.com/c/" spellcheck="false" autocomplete="off">
                </div>
                <div class="field">
                  <label class="field-label" for="stalker-mac-address">Stalker MAC Address</label>
                  <input id="stalker-mac-address" class="field-input" type="password" placeholder="00:1A:79:00:00:00" spellcheck="false" autocomplete="off">
                </div>
              </div>

              <div class="field-grid">
                <div class="field">
                  <label class="field-label" for="stalker-stb-type">STB Type</label>
                  <select id="stalker-stb-type" class="field-input">
                    <option value="MAG254" selected>MAG254</option>
                    <option value="MAG250">MAG250</option>
                    <option value="MAG256">MAG256</option>
                    <option value="MAG270">MAG270</option>
                    <option value="MAG322">MAG322</option>
                    <option value="MAG324">MAG324</option>
                    <option value="MAG349">MAG349</option>
                    <option value="MAG351">MAG351</option>
                    <option value="MAG420">MAG420</option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label" for="stalker-serial-number">Serial Number</label>
                  <input id="stalker-serial-number" class="field-input" type="text" placeholder="Optional MAG serial" spellcheck="false" autocomplete="off">
                </div>
              </div>

              <div class="field-grid">
                <div class="field">
                  <label class="field-label" for="stalker-device-id">Device ID</label>
                  <input id="stalker-device-id" class="field-input" type="text" placeholder="Optional device_id" spellcheck="false" autocomplete="off">
                </div>
                <div class="field">
                  <label class="field-label" for="stalker-device-id2">Device ID 2</label>
                  <input id="stalker-device-id2" class="field-input" type="text" placeholder="Optional device_id2" spellcheck="false" autocomplete="off">
                </div>
              </div>

              <label class="torbox-toggle-row">
                <span>
                  <strong>Famelack Public Live TV</strong>
                  <em>Add public worldwide live TV catalogs from Famelack data.</em>
                </span>
                <span class="switch switch-small">
                  <input type="checkbox" id="famelack-live-enabled">
                  <span></span>
                </span>
              </label>
            </div>
          </section>

          <footer class="simple-footer">
            <a class="simple-support-button" href="${simpleKoFiUrl}" target="_blank" rel="noopener">
              <span>☕</span>
              <span>Support me on Ko-fi -&gt;</span>
            </a>
            <div class="simple-footer-links">
              <a class="simple-social-link stremio" href="https://stremio-addons.net/addons/nebulastreams-stable" target="_blank" rel="noopener" aria-label="Stremio Addons">
                <img src="https://stremio-addons.net/favicon.ico" alt="">
              </a>
              <a class="simple-social-link discord" href="https://discord.gg/Y3gEjpcjm" target="_blank" rel="noopener" aria-label="Discord">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path fill="currentColor" d="M20.32 4.37A19.8 19.8 0 0 0 15.36 2.8a.07.07 0 0 0-.08.04c-.21.38-.45.88-.62 1.27a18.29 18.29 0 0 0-5.5 0 12.7 12.7 0 0 0-.63-1.27.08.08 0 0 0-.08-.04A19.74 19.74 0 0 0 3.5 4.37a.07.07 0 0 0-.03.03C.35 9.05-.46 13.58.02 18.06c0 .02.02.05.04.06a19.9 19.9 0 0 0 6.08 3.07.08.08 0 0 0 .09-.03c.47-.64.89-1.31 1.25-2.02a.08.08 0 0 0-.04-.11 13.16 13.16 0 0 1-1.9-.91.08.08 0 0 1 0-.13l.38-.3a.08.08 0 0 1 .08-.01c3.96 1.8 8.24 1.8 12.15 0a.08.08 0 0 1 .09.01l.38.3a.08.08 0 0 1-.01.13c-.6.35-1.23.66-1.9.91a.08.08 0 0 0-.04.11c.37.7.79 1.38 1.25 2.02a.08.08 0 0 0 .09.03 19.84 19.84 0 0 0 6.09-3.07.08.08 0 0 0 .03-.06c.58-5.18-.98-9.67-3.87-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.19 0-2.17-1.1-2.17-2.44 0-1.35.96-2.44 2.17-2.44 1.22 0 2.18 1.1 2.17 2.44 0 1.35-.96 2.44-2.17 2.44Zm7.97 0c-1.19 0-2.17-1.1-2.17-2.44 0-1.35.96-2.44 2.17-2.44 1.22 0 2.18 1.1 2.17 2.44 0 1.35-.95 2.44-2.17 2.44Z"/>
                </svg>
              </a>
              <a class="simple-status-link" href="${statusPageUrl}" target="_blank" rel="noopener">Status</a>
            </div>
            <p class="simple-footer-credit">2026. By <a href="https://discord.gg/Y3gEjpcjm" target="_blank" rel="noopener">retrocodex</a></p>
          </footer>

          <!-- SUPPORT -->
          <section class="card advanced-only" id="support-section">
            <div class="card-inner">
              <div class="card-header">
                <div>
                  <h3 class="card-title">Support NebulaStreams</h3>
                  <p class="card-desc">The addon is free. Support keeps the backend stable and maintained.</p>
                </div>
                <span class="card-badge">Support</span>
              </div>

              <div class="support-shell">
                ${hasDonationSupport ? `
                  <div class="support-card">
                    <h3>This addon is completely free.</h3>
                    <p>If NebulaStreams has made your setup easier, support helps keep the servers online for everyone using it. Traffic has grown a lot, and keeping it alive means paying for hosting, tunnels, and time spent fixing crashes when providers break.</p>
                    <div class="support-actions">
                      <button type="button" class="donate-toggle" id="donate-toggle">💖 Support</button>
                      ${donationPrimaryUrl ? `<a class="support-link" href="${donationPrimaryUrl}" target="_blank" rel="noopener">☕ Ko-fi</a>` : ''}
                      <a class="support-link" href="${escapeHtml(baseUrl)}/donate">More ways</a>
                    </div>
                  </div>
                ` : `
                  <div class="support-card">
                    <h3>Feeling generous?</h3>
                    <p>Support keeps the backend stable for everyone. Hosting, tunnels, and time spent fixing provider crashes all add up.</p>
                    <div class="support-actions">
                      ${donationPrimaryUrl ? `<a class="support-link" href="${donationPrimaryUrl}" target="_blank" rel="noopener">☕ Ko-fi</a>` : ''}
                      <a class="support-link" href="${escapeHtml(baseUrl)}/donate">Support</a>
                    </div>
                  </div>
                `}

                ${nowPaymentsWidgetUrl ? `
                  <div class="widget-panel" id="donation-widget-panel">
                    <iframe class="widget-frame" src="${nowPaymentsWidgetUrl}" loading="lazy" scrolling="no" title="NOWPayments donation widget">Can't load widget</iframe>
                  </div>
                ` : ''}
              </div>
            </div>
          </section>

          <!-- NOTES -->
          <section class="card advanced-only" id="notes-section">
            <div class="card-inner">
              <div class="card-header">
                <div>
                  <h3 class="card-title">Operational Notes</h3>
                  <p class="card-desc">A few practical details about how the addon behaves.</p>
                </div>
                <span class="card-badge">Notes</span>
              </div>

              <div class="notes-list">
                <p class="note-item"><strong>Quality order:</strong> only affects ranking. It can't invent missing qualities providers don't have.</p>
                <p class="note-item"><strong>Web-ready mode:</strong> filters hard. Use only for the safest direct-play subset.</p>
                <p class="note-item"><strong>Cold starts:</strong> first request can be slower while the backend wakes up and queries providers in parallel.</p>
                <p class="note-item"><strong>Media hosting:</strong> NebulaStreams does not store media. It discovers external links and passes them through configured playback.</p>
              </div>

              <div class="disclaimer">
                <p class="disclaimer-text"><strong>Disclaimer:</strong> NebulaStreams is a stream discovery tool. It does not host, upload, or own any media. It should not be used to view copyrighted material without permission. The developer assumes no responsibility for how this tool is utilized.</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>

    <script>
      const origin = ${JSON.stringify(baseUrl)};
      const providerData = ${JSON.stringify(providerIds)};
      const hiddenAdapterProviderGroups = new Set(['r3-plugin', 'r4-asian-drama-movies', 'r5-plugin']);
      const defaultQualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p', 'auto', 'unknown'];
      const simpleSortingOrders = {
        'highest-non-4k': ['1080p', '720p', '480p', '360p', '2160p', '1440p', 'auto', 'unknown'],
        highest: [...defaultQualityPriority],
        balanced: ['1080p', '720p', '2160p', '480p', '360p', '1440p', 'auto', 'unknown']
      };
      const selectedProviders = new Set();
      let qualityPriority = [...defaultQualityPriority];
      let activePresetId = null;
      let configMode = 'simple';
      let adapterProviderGroups = [];
      const adapterProviderSelections = {};

      providerData.forEach((p) => selectedProviders.add(p));

      const $ = (id) => document.getElementById(id);
      const modeButtons = Array.from(document.querySelectorAll('[data-config-mode]'));
      const simpleQualityInputs = Array.from(document.querySelectorAll('.simple-quality-input'));
      const simpleContentSelection = $('simple-content-selection');
      const simpleDefaultSorting = $('simple-default-sorting');
      const simpleMaxPerQuality = $('simple-max-per-quality');
      const simpleMaxPerProvider = $('simple-max-per-provider');
      const providerSearch = $('provider-search');
      const providerGrid = $('provider-grid');
      const providerSummary = $('provider-summary');
      const adapterProviderList = $('adapter-provider-list');
      const adapterProviderSummary = $('adapter-provider-summary');
      const manifestUrl = $('manifest-url');
      const flash = $('flash');
      const copyButton = $('copy-url');
      const installButton = $('install-addon');
      const qualityList = $('quality-list');
      const selectAllProvidersButton = $('select-all-providers');
      const clearProvidersButton = $('clear-providers');
      const resetQualityOrderButton = $('reset-quality-order');
      const webReadyOnly = $('web-ready-only');
      const hideHeavyFormats = $('hide-heavy-formats');
      const preferHdr = $('prefer-hdr');
      const preferH264 = $('prefer-h264');
      const preferSmallerFiles = $('prefer-smaller-files');
      const preferDirectHosts = $('prefer-direct-hosts');
      const preferredAudioLanguage = $('preferred-audio-language');
      const maxSizeGb = $('max-size-gb');
      const blockedHosts = $('blocked-hosts');
      const customProxyUrl = $('custom-proxy-url');
      const febboxUiCookie = $('febbox-ui-cookie');
      const torboxEnabled = $('torbox-enabled');
      const torboxApiKey = $('torbox-api-key');
      const torboxOnlyStreams = $('torbox-only-streams');
      const torboxUsenet = $('torbox-usenet');
      const xtreamEnabled = $('xtream-enabled');
      const xtreamServerUrl = $('xtream-server-url');
      const xtreamUsername = $('xtream-username');
      const xtreamPassword = $('xtream-password');
      const xtreamValidationStatus = $('xtream-validation-status');
      const stalkerPortalUrl = $('stalker-portal-url');
      const stalkerMacAddress = $('stalker-mac-address');
      const stalkerStbType = $('stalker-stb-type');
      const stalkerSerialNumber = $('stalker-serial-number');
      const stalkerDeviceId = $('stalker-device-id');
      const stalkerDeviceId2 = $('stalker-device-id2');
      const famelackLiveEnabled = $('famelack-live-enabled');
      const dedupeMode = $('dedupe-mode');
      const formatterStyle = $('formatter-style');
      const overviewProviderCount = $('overview-provider-count');
      const presetStatus = $('preset-status');
      const presetButtons = Array.from(document.querySelectorAll('[data-preset-id]'));
      const donateToggle = $('donate-toggle');
      const donationWidgetPanel = $('donation-widget-panel');
      const navItems = Array.from(document.querySelectorAll('[data-section-target]'));
      let manifestResolveNonce = 0;

      const escapeHtmlClient = (v) => String(v)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

      const showFlash = (text, isError = false) => {
        flash.textContent = text;
        flash.style.color = isError ? '#f87171' : '#34d399';
        clearTimeout(flash._timer);
        flash._timer = setTimeout(() => { flash.textContent = ''; }, 2400);
      };

      const copyText = async (value, successMessage) => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
          } else {
            const t = document.createElement('textarea');
            t.value = value;
            t.style.position = 'fixed';
            t.style.opacity = '0';
            document.body.appendChild(t);
            t.select();
            document.execCommand('copy');
            document.body.removeChild(t);
          }
          showFlash('✓ ' + successMessage);
        } catch (e) {
          showFlash('Copy failed. Please copy manually.', true);
        }
      };

      const isDefaultQualityOrder = () =>
        qualityPriority.length === defaultQualityPriority.length &&
        qualityPriority.every((q, i) => q === defaultQualityPriority[i]);

      const getSimpleAllowedQualities = () =>
        simpleQualityInputs
          .filter((input) => input.checked)
          .map((input) => input.value)
          .filter(Boolean);

      const getSimpleQualityPriority = () => {
        const order = simpleSortingOrders[simpleDefaultSorting.value] || simpleSortingOrders.highest;
        return [
          ...order.filter((quality) => getSimpleAllowedQualities().includes(quality)),
          ...order.filter((quality) => !getSimpleAllowedQualities().includes(quality))
        ];
      };

      const hasAdapterProviderSelections = () =>
        Object.values(adapterProviderSelections).some((selection) => selection instanceof Set && selection.size > 0);

      const getSelectedAdapterProviderIds = () =>
        Object.entries(adapterProviderSelections)
          .filter(([, selection]) => selection instanceof Set && selection.size > 0)
          .map(([adapterId]) => adapterId);

      const getAdapterProviderSelectionPayload = () =>
        Object.fromEntries(Object.entries(adapterProviderSelections)
          .map(([adapterId, selection]) => [adapterId, Array.from(selection || [])])
          .filter(([, selection]) => selection.length > 0));

      const hasXtreamConfig = () =>
        Boolean(xtreamEnabled.checked && xtreamServerUrl.value.trim() && xtreamUsername.value.trim() && xtreamPassword.value.trim());
      const hasStalkerConfig = () =>
        Boolean(xtreamEnabled.checked && stalkerPortalUrl.value.trim() && stalkerMacAddress.value.trim());
      const hasFamelackLiveConfig = () =>
        Boolean(famelackLiveEnabled.checked);

      const isDefaultSimpleConfig = () => {
        if (configMode !== 'simple') return false;

        const defaultSimpleQualities = ['2160p', '1080p', '720p', '480p'];
        const selectedSimpleQualities = getSimpleAllowedQualities();
        const allProvidersSelected = selectedProviders.size === providerData.length
          && providerData.every((providerId) => selectedProviders.has(providerId));

        return allProvidersSelected
          && activePresetId === null
          && selectedSimpleQualities.length === defaultSimpleQualities.length
          && defaultSimpleQualities.every((quality) => selectedSimpleQualities.includes(quality))
          && simpleContentSelection.value === 'default'
          && simpleDefaultSorting.value === 'highest'
          && Number.parseInt(simpleMaxPerQuality.value, 10) === 0
          && Number.parseInt(simpleMaxPerProvider.value, 10) === 0
          && !webReadyOnly.checked
          && !hideHeavyFormats.checked
          && !preferHdr.checked
          && !preferH264.checked
          && !preferSmallerFiles.checked
          && !preferDirectHosts.checked
          && !preferredAudioLanguage.value
          && (!dedupeMode.value || dedupeMode.value === 'off')
          && (!formatterStyle.value || formatterStyle.value === 'clean')
          && !(Number.parseFloat(maxSizeGb.value) > 0)
          && !blockedHosts.value.trim()
          && !customProxyUrl.value.trim()
          && !hasAdapterProviderSelections()
          && !febboxUiCookie.value.trim()
          && !(torboxEnabled.checked && torboxApiKey.value.trim())
          && !hasXtreamConfig()
          && !hasStalkerConfig()
          && !hasFamelackLiveConfig();
      };

      const syncSimpleQualityPriority = () => {
        if (configMode !== 'simple') return;
        qualityPriority = getSimpleQualityPriority();
        renderQualityList();
      };

      const setConfigMode = (mode) => {
        configMode = mode === 'advanced' ? 'advanced' : 'simple';
        document.body.dataset.configMode = configMode;
        modeButtons.forEach((button) => button.classList.toggle('is-active', button.dataset.configMode === configMode));
        syncSimpleQualityPriority();
        updateManifest();
      };

      const presetDefinitions = {
        'web-fast': { label: 'Web Fast', code: 'WF', providers: 'all', qualityPriority: ['1080p','720p','480p','360p','2160p','1440p','auto','unknown'], webReadyOnly: true, hideHeavyFormats: true, preferHdr: false, preferH264: true, preferSmallerFiles: true, preferDirectHosts: true, customProxyUrl: '', preferredAudioLanguage: '', maxSizeGb: '5', blockedHosts: '', dedupeMode: 'host-quality', formatterStyle: 'clean' },
        'mobile-data': { label: 'Mobile Data', code: 'MD', providers: 'all', qualityPriority: ['720p','480p','360p','1080p','2160p','1440p','auto','unknown'], webReadyOnly: false, hideHeavyFormats: true, preferHdr: false, preferH264: true, preferSmallerFiles: true, preferDirectHosts: true, customProxyUrl: '', preferredAudioLanguage: '', maxSizeGb: '3', blockedHosts: '', dedupeMode: 'host-quality' },
        '4k-hdr': { label: '4K HDR', code: '4K', providers: 'all', qualityPriority: ['2160p','1440p','1080p','720p','480p','360p','auto','unknown'], webReadyOnly: false, hideHeavyFormats: false, preferHdr: true, preferH264: false, preferSmallerFiles: false, preferDirectHosts: false, customProxyUrl: '', preferredAudioLanguage: '', maxSizeGb: '0', blockedHosts: '', dedupeMode: 'smart' },
        'anime': { label: 'Anime', code: 'AN', providers: ['animekai','animeworld','animesalt','animepahe','4khdhub_tv','4khdhub','hdhub4u','kisskh','vidlink','videasy'], qualityPriority: ['1080p','720p','1440p','2160p','480p','360p','auto','unknown'], webReadyOnly: false, hideHeavyFormats: false, preferHdr: false, preferH264: false, preferSmallerFiles: false, preferDirectHosts: true, customProxyUrl: '', preferredAudioLanguage: 'Japanese', maxSizeGb: '0', blockedHosts: '', dedupeMode: 'smart' },
        'indian-content': { label: 'Indian Content', code: 'IN', providers: ['4khdhub','4khdhub_tv','showbox','cinestream','vidlink','vixsrc','moviebox','hdhub4u','flixindia','hindmoviez','isaidub','tamilian','streamflix','streamflix_eng','allwish','moviesmod'], qualityPriority: ['1080p','720p','2160p','480p','360p','1440p','auto','unknown'], webReadyOnly: false, hideHeavyFormats: false, preferHdr: false, preferH264: false, preferSmallerFiles: false, preferDirectHosts: true, customProxyUrl: '', preferredAudioLanguage: '', maxSizeGb: '0', blockedHosts: '', dedupeMode: 'host-quality' },
        'turkish-content': { label: 'Turkish Content', code: 'TR', providers: ['vidmody-tr','turkish-m3u','rectv-tr','diziyou','sinemacx','cinemacity','vidlink','videasy'], qualityPriority: ['1080p','720p','2160p','480p','360p','1440p','auto','unknown'], webReadyOnly: false, hideHeavyFormats: false, preferHdr: false, preferH264: false, preferSmallerFiles: false, preferDirectHosts: true, customProxyUrl: '', preferredAudioLanguage: 'Turkish', maxSizeGb: '0', blockedHosts: '', dedupeMode: 'host-quality' },
        'italian-content': { label: 'Italian Content', code: 'IT', providers: ['it-streamingcommunity','it-guardahd','it-guardaserie','it-guardoserie','it-cc','it-animeunity','it-animeworld','it-animesaturn','vidlink','videasy'], qualityPriority: ['1080p','720p','2160p','480p','360p','1440p','auto','unknown'], webReadyOnly: false, hideHeavyFormats: false, preferHdr: false, preferH264: false, preferSmallerFiles: false, preferDirectHosts: true, customProxyUrl: '', preferredAudioLanguage: 'Italian', maxSizeGb: '0', blockedHosts: '', dedupeMode: 'host-quality' },
        'latino-content': { label: 'Latino Content', code: 'LA', providers: ['latino-lamovie','latino-embed69','latino-cinecalidad','latino-xupalace','latino-seriesmetro','lamovie','purstream','vidlink','videasy'], qualityPriority: ['1080p','720p','2160p','480p','360p','1440p','auto','unknown'], webReadyOnly: false, hideHeavyFormats: false, preferHdr: false, preferH264: false, preferSmallerFiles: false, preferDirectHosts: true, customProxyUrl: '', preferredAudioLanguage: 'Latino', maxSizeGb: '0', blockedHosts: '', dedupeMode: 'host-quality' },
        'french-content': { label: 'French Content', code: 'FR', providers: ['fr-frenchstream','fr-movix','fr-dulourd','fr-anime-sama','fr-voiranime','fr-vostfree','fr-animoflix','fr-french-anime','fr-animevostfr','fr-animesultra','fr-jetanimes','fr-sekai','fr-mugiwarastream','fr-animesite','nuvio-french','nakios','toflix','frembed','vidlink','videasy'], qualityPriority: ['1080p','720p','2160p','480p','360p','1440p','auto','unknown'], webReadyOnly: false, hideHeavyFormats: false, preferHdr: false, preferH264: false, preferSmallerFiles: false, preferDirectHosts: true, customProxyUrl: '', preferredAudioLanguage: 'French', maxSizeGb: '0', blockedHosts: '', dedupeMode: 'host-quality' },
        'arabic-content': { label: 'Arabic Content', code: 'AR', providers: ['arabic-faselhd','arabic-cineby','arabic-witanime','arabic-animecloud','arabic-kirmzi','vidlink','videasy'], qualityPriority: ['1080p','720p','2160p','480p','360p','1440p','auto','unknown'], webReadyOnly: false, hideHeavyFormats: false, preferHdr: false, preferH264: false, preferSmallerFiles: false, preferDirectHosts: true, customProxyUrl: '', preferredAudioLanguage: 'Arabic', maxSizeGb: '0', blockedHosts: '', dedupeMode: 'host-quality' }
      };

      const getOrderedProviders = () =>
        [
          ...providerData.filter((p) => selectedProviders.has(p)),
          ...getSelectedAdapterProviderIds().filter((providerId) => !providerData.includes(providerId))
        ];

      const setSelectedProviders = (input) => {
        selectedProviders.clear();
        if (input === 'all') {
          providerData.forEach((p) => selectedProviders.add(p));
          return;
        }
        const allowed = Array.isArray(input) ? input.filter((p) => providerData.includes(p)) : [];
        allowed.forEach((p) => selectedProviders.add(p));
      };

      const updatePresetUi = () => {
        presetButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.presetId === activePresetId));
        if (presetStatus) {
          const label = activePresetId && presetDefinitions[activePresetId] ? presetDefinitions[activePresetId].label : 'Custom';
          presetStatus.innerHTML = 'Preset: <strong>' + escapeHtmlClient(label) + '</strong>';
        }
      };

      const markPresetAsCustom = () => {
        if (!activePresetId) return;
        activePresetId = null;
        updatePresetUi();
      };

      const applyPreset = (id) => {
        const p = presetDefinitions[id];
        if (!p) return;
        setSelectedProviders(p.providers);
        qualityPriority = [...p.qualityPriority];
        webReadyOnly.checked = !!p.webReadyOnly;
        hideHeavyFormats.checked = !!p.hideHeavyFormats;
        preferHdr.checked = !!p.preferHdr;
        preferH264.checked = !!p.preferH264;
        preferSmallerFiles.checked = !!p.preferSmallerFiles;
        preferDirectHosts.checked = !!p.preferDirectHosts;
        customProxyUrl.value = p.customProxyUrl || '';
        preferredAudioLanguage.value = p.preferredAudioLanguage || '';
        maxSizeGb.value = p.maxSizeGb || '0';
        blockedHosts.value = p.blockedHosts || '';
        dedupeMode.value = p.dedupeMode || 'off';
        formatterStyle.value = p.formatterStyle || 'clean';
        activePresetId = id;
        renderProviderOptions();
        renderQualityList();
        updateManifest();
        updatePresetUi();
        showFlash(p.label + ' preset applied');
      };

      const getOptionTokens = () => {
        const tokens = [];
        const ap = activePresetId ? presetDefinitions[activePresetId] : null;
        if (ap?.code) tokens.push('profile=' + ap.code.toLowerCase());
        if (configMode === 'simple') {
          const allowedQualities = getSimpleAllowedQualities();
          if (allowedQualities.length > 0) {
            tokens.push('qualities=' + allowedQualities.join('|'));
          }
          if (simpleContentSelection.value !== 'default') tokens.push('content=' + simpleContentSelection.value);
          if (Number.parseInt(simpleMaxPerQuality.value, 10) > 0) tokens.push('max-per-quality=' + Number.parseInt(simpleMaxPerQuality.value, 10));
          if (Number.parseInt(simpleMaxPerProvider.value, 10) > 0) tokens.push('max-per-provider=' + Number.parseInt(simpleMaxPerProvider.value, 10));
        }
        if (webReadyOnly.checked) tokens.push('web-ready-only');
        if (hideHeavyFormats.checked) tokens.push('hide-heavy-formats');
        if (preferHdr.checked) tokens.push('prefer-hdr');
        if (preferH264.checked) tokens.push('prefer-h264');
        if (preferSmallerFiles.checked) tokens.push('prefer-smaller-files');
        if (preferDirectHosts.checked) tokens.push('prefer-direct-hosts');
        const hasTorboxKey = torboxEnabled.checked && torboxApiKey.value.trim();
        if (hasTorboxKey && torboxOnlyStreams.checked) tokens.push('torbox-only-streams');
        if (hasTorboxKey && torboxUsenet.checked) tokens.push('torbox-usenet');
        if (preferredAudioLanguage.value) tokens.push('preferred-audio=' + preferredAudioLanguage.value.toLowerCase());
        if (dedupeMode.value && dedupeMode.value !== 'off') tokens.push('dedupe=' + dedupeMode.value);
        if (formatterStyle.value && formatterStyle.value !== 'clean') tokens.push('formatter=' + formatterStyle.value);
        if (Number.parseFloat(maxSizeGb.value) > 0) tokens.push('max-size-gb=' + Number.parseFloat(maxSizeGb.value));
        const blocked = blockedHosts.value.split(/[,\\n]/).map((v) => v.trim().toLowerCase()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
        if (blocked.length > 0) tokens.push('block-hosts=' + blocked.join('|'));
        return tokens;
      };

      const buildManifestPath = () => {
        if (isDefaultSimpleConfig()) return '/manifest.json';

        const ordered = getOrderedProviders();
        const nativeOrdered = ordered.filter((providerId) => providerData.includes(providerId));
        const hasAdapterProviders = ordered.some((providerId) => !providerData.includes(providerId));
        const ps = (hasAdapterProviders || (nativeOrdered.length > 0 && nativeOrdered.length < providerData.length)) ? encodeURIComponent(ordered.join(',')) : 'all';
        const qs = isDefaultQualityOrder() ? 'default' : encodeURIComponent(qualityPriority.join(','));
        const ot = getOptionTokens();
        if (ps === 'all' && qs === 'default' && ot.length === 0) return '/manifest.json';
        if (ot.length === 0 && qs === 'default') return '/configured/' + ps + '/manifest.json';
        if (ot.length === 0) return '/configured/' + ps + '/' + qs + '/manifest.json';
        return '/configured/' + ps + '/' + qs + '/' + encodeURIComponent(ot.join(',')) + '/manifest.json';
      };

      const buildPrivateConfigPayload = () => {
        const ordered = getOrderedProviders();
        const simpleAllowedQualities = getSimpleAllowedQualities();
        return {
          providers: ordered.length === 0 || (ordered.length === providerData.length && !hasAdapterProviderSelections()) ? [] : ordered,
          qualityPriority: [...qualityPriority],
          streamOptions: {
            webReadyOnly: webReadyOnly.checked,
            hideHeavyFormats: hideHeavyFormats.checked,
            allowedQualities: configMode === 'simple' && simpleAllowedQualities.length > 0
              ? simpleAllowedQualities
              : [],
            maxSizeGb: Number.parseFloat(maxSizeGb.value) > 0 ? Number.parseFloat(maxSizeGb.value) : 0,
            maxPerQuality: configMode === 'simple' ? Number.parseInt(simpleMaxPerQuality.value, 10) || 0 : 0,
            maxPerProvider: configMode === 'simple' ? Number.parseInt(simpleMaxPerProvider.value, 10) || 0 : 0,
            blockHosts: blockedHosts.value.split(/[,\\n]/).map((v) => v.trim().toLowerCase()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i),
            contentSelection: configMode === 'simple' ? simpleContentSelection.value : 'default',
            preferredAudioLanguage: preferredAudioLanguage.value || null,
            dedupeMode: dedupeMode.value || 'off',
            formatterStyle: formatterStyle.value || 'clean',
            preferHdr: preferHdr.checked,
            preferH264: preferH264.checked,
            preferSmallerFiles: preferSmallerFiles.checked,
            preferDirectHosts: preferDirectHosts.checked,
            torboxOnlyStreams: Boolean(torboxEnabled.checked && torboxApiKey.value.trim() && torboxOnlyStreams.checked),
            torboxUsenet: Boolean(torboxEnabled.checked && torboxApiKey.value.trim() && torboxUsenet.checked),
            customProxyUrl: customProxyUrl.value.trim() || null,
            pluginProviderSelections: getAdapterProviderSelectionPayload()
          },
          privateProviderSettings: {
            febboxUiCookie: febboxUiCookie.value.trim(),
            torboxApiKey: torboxEnabled.checked ? torboxApiKey.value.trim() : '',
            xtreamServerUrl: xtreamEnabled.checked ? xtreamServerUrl.value.trim() : '',
            xtreamUsername: xtreamEnabled.checked ? xtreamUsername.value.trim() : '',
            xtreamPassword: xtreamEnabled.checked ? xtreamPassword.value.trim() : '',
            stalkerPortalUrl: xtreamEnabled.checked ? stalkerPortalUrl.value.trim() : '',
            stalkerMacAddress: xtreamEnabled.checked ? stalkerMacAddress.value.trim() : '',
            stalkerStbType: xtreamEnabled.checked ? stalkerStbType.value.trim() : '',
            stalkerSerialNumber: xtreamEnabled.checked ? stalkerSerialNumber.value.trim() : '',
            stalkerDeviceId: xtreamEnabled.checked ? stalkerDeviceId.value.trim() : '',
            stalkerDeviceId2: xtreamEnabled.checked ? stalkerDeviceId2.value.trim() : '',
            famelackLiveEnabled: famelackLiveEnabled.checked
          },
          profileCode: activePresetId && presetDefinitions[activePresetId]?.code ? presetDefinitions[activePresetId].code.toLowerCase() : null
        };
      };

      let iptvValidationNonce = 0;
      let iptvValidationTimer = null;
      let lastXtreamValidationValid = false;
      let lastXtreamValidationKey = '';

      const getXtreamValidationKey = () =>
        [xtreamServerUrl.value.trim(), xtreamUsername.value.trim(), xtreamPassword.value.trim()].join('|');

      const setXtreamValidationStatus = (text, color) => {
        if (!xtreamValidationStatus) return;
        xtreamValidationStatus.textContent = text;
        xtreamValidationStatus.style.color = color || '#94a3b8';
      };

      const validateIptvCredentials = async ({ quiet = false } = {}) => {
        if (!hasXtreamConfig() && !hasStalkerConfig()) {
          lastXtreamValidationValid = false;
          lastXtreamValidationKey = '';
          setXtreamValidationStatus('', '#94a3b8');
          return true;
        }

        const validationKey = getXtreamValidationKey();
        const nonce = ++iptvValidationNonce;
        if (hasXtreamConfig() && !quiet) {
          setXtreamValidationStatus('Checking Xtream credentials...', '#94a3b8');
        }

        try {
          const response = await fetch(origin + '/configure/validate-iptv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPrivateConfigPayload())
          });
          if (!response.ok) throw new Error('Validation failed');
          const result = await response.json();
          if (nonce !== iptvValidationNonce) return false;

          if (hasXtreamConfig()) {
            const xtreamResult = result?.xtream || {};
            lastXtreamValidationValid = Boolean(xtreamResult.valid);
            lastXtreamValidationKey = validationKey;
            if (xtreamResult.valid) {
              const counts = xtreamResult.categories || {};
              setXtreamValidationStatus('Xtream valid - live ' + (counts.live || 0) + ', movies ' + (counts.vod || 0) + ', series ' + (counts.series || 0), '#22c55e');
            } else {
              setXtreamValidationStatus('Xtream invalid - ' + (xtreamResult.message || 'check credentials'), '#ef4444');
            }
          }

          return !hasXtreamConfig() || Boolean(result?.xtream?.valid);
        } catch (error) {
          if (nonce !== iptvValidationNonce) return false;
          lastXtreamValidationValid = false;
          lastXtreamValidationKey = validationKey;
          if (hasXtreamConfig()) {
            setXtreamValidationStatus('Xtream validation failed', '#ef4444');
          }
          return false;
        }
      };

      const scheduleIptvValidation = () => {
        clearTimeout(iptvValidationTimer);
        if (!hasXtreamConfig()) {
          lastXtreamValidationValid = false;
          lastXtreamValidationKey = '';
          setXtreamValidationStatus('', '#94a3b8');
          return;
        }
        setXtreamValidationStatus('Waiting for credentials...', '#94a3b8');
        iptvValidationTimer = setTimeout(() => {
          validateIptvCredentials().catch(() => {});
        }, 700);
      };

      const getAdapterProviderGroupSelection = (group) => {
        const id = String(group?.id || '').toLowerCase();
        if (!adapterProviderSelections[id]) {
          adapterProviderSelections[id] = new Set();
        }
        return adapterProviderSelections[id];
      };

      const updateAdapterProviderSummary = () => {
        if (!adapterProviderSummary) return;
        const selectedCount = Object.values(adapterProviderSelections)
          .reduce((count, selection) => count + (selection?.size || 0), 0);
        if (selectedCount === 0) {
          adapterProviderSummary.textContent = 'No adapter sub-provider locks. Each selected adapter uses its default provider set.';
          return;
        }
        adapterProviderSummary.innerHTML = '<strong>' + selectedCount + '</strong> adapter provider' + (selectedCount === 1 ? '' : 's') + ' selected.';
      };

      const renderAdapterProviders = () => {
        if (!adapterProviderList) return;
        const groups = adapterProviderGroups.filter((group) =>
          !hiddenAdapterProviderGroups.has(String(group.id || '').toLowerCase()) &&
          Array.isArray(group.providers) &&
          group.providers.length > 0
        );
        if (groups.length === 0) {
          adapterProviderList.innerHTML = '<div class="empty-state">No adapter provider manifests loaded.</div>';
          updateAdapterProviderSummary();
          return;
        }

        adapterProviderList.innerHTML = groups.map((group) => {
          const selection = getAdapterProviderGroupSelection(group);
          const providers = group.providers || [];
          const selectedText = selection.size > 0 ? selection.size + ' selected' : 'default';
          return '<div class="adapter-provider-group" data-adapter-id="' + escapeHtmlClient(group.id) + '">' +
            '<button type="button" class="adapter-provider-head" data-adapter-toggle="' + escapeHtmlClient(group.id) + '">' +
              '<span>' + escapeHtmlClient(group.label || group.id) + '</span><small>' + selectedText + ' / ' + providers.length + '</small>' +
            '</button>' +
            '<div class="adapter-provider-body">' +
              '<div class="adapter-provider-actions">' +
                '<button type="button" class="btn-ghost" data-adapter-select-all="' + escapeHtmlClient(group.id) + '">Select all</button>' +
                '<button type="button" class="btn-ghost" data-adapter-clear="' + escapeHtmlClient(group.id) + '">Default</button>' +
              '</div>' +
              '<div class="adapter-provider-grid">' + providers.map((provider) =>
                '<label class="adapter-provider-option">' +
                  '<input type="checkbox" data-adapter-id="' + escapeHtmlClient(group.id) + '" data-adapter-provider-id="' + escapeHtmlClient(provider.id) + '" ' + (selection.has(provider.id) ? 'checked' : '') + '>' +
                  '<span>' + escapeHtmlClient(provider.label || provider.id) + '</span>' +
                '</label>'
              ).join('') + '</div>' +
            '</div>' +
          '</div>';
        }).join('');
        updateAdapterProviderSummary();
      };

      const loadAdapterProviders = async () => {
        if (!adapterProviderList) return;
        try {
          const response = await fetch(origin + '/configure/adapter-providers');
          if (!response.ok) throw new Error('Adapter provider list failed');
          const payload = await response.json();
          adapterProviderGroups = Array.isArray(payload?.groups) ? payload.groups : [];
          renderAdapterProviders();
        } catch (error) {
          adapterProviderList.innerHTML = '<div class="empty-state">Adapter providers unavailable.</div>';
          if (adapterProviderSummary) adapterProviderSummary.textContent = 'Adapter provider list failed.';
        }
      };

      const resolveManifestPath = async () => {
        const cookie = febboxUiCookie.value.trim();
        const torbox = torboxEnabled.checked ? torboxApiKey.value.trim() : '';
        const xtream = hasXtreamConfig();
        const stalker = hasStalkerConfig();
        const famelack = hasFamelackLiveConfig();
        const proxy = customProxyUrl.value.trim();
        if (!cookie && !torbox && !xtream && !stalker && !famelack && !proxy && !hasAdapterProviderSelections()) return buildManifestPath();
        const r = await fetch(origin + '/configure/private-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPrivateConfigPayload())
        });
        if (!r.ok) throw new Error('Private config failed');
        const p = await r.json();
        if (!p || typeof p.manifestPath !== 'string' || !p.manifestPath) throw new Error('Invalid response');
        return p.manifestPath;
      };

      const updateProviderSummary = () => {
        const ordered = getOrderedProviders();
        if (overviewProviderCount) {
          overviewProviderCount.textContent = ordered.length === 0 ? String(providerData.length) : String(ordered.length);
        }
        if (ordered.length === providerData.length) {
          providerSummary.innerHTML = '✓ All <strong>' + providerData.length + '</strong> providers selected';
          return;
        }
        if (ordered.length === 0) {
          providerSummary.textContent = 'No providers checked — falling back to all providers.';
          return;
        }
        providerSummary.innerHTML = '<strong>' + ordered.length + '</strong> provider' + (ordered.length === 1 ? '' : 's') + ' selected: ' + escapeHtmlClient(ordered.slice(0, 6).join(', ')) + (ordered.length > 6 ? ' +' + (ordered.length - 6) + ' more' : '');
      };

      const renderProviderOptions = () => {
        const f = providerSearch.value.trim().toLowerCase();
        const visible = providerData.filter((p) => p.includes(f));
        if (visible.length === 0) {
          providerGrid.innerHTML = '<div class="empty-state">No providers match "' + escapeHtmlClient(f) + '"</div>';
          return;
        }
        providerGrid.innerHTML = visible.map((p) =>
          '<label class="provider-option">' +
            '<input type="checkbox" data-provider-id="' + escapeHtmlClient(p) + '" ' + (selectedProviders.has(p) ? 'checked' : '') + '>' +
            '<span class="provider-name">' + escapeHtmlClient(p) + '</span>' +
          '</label>'
        ).join('');
      };

      const renderQualityList = () => {
        qualityList.innerHTML = qualityPriority.map((q, i) =>
          '<div class="quality-row">' +
            '<div class="quality-rank">' + (i + 1) + '</div>' +
            '<div><strong>' + escapeHtmlClient(q.toUpperCase()) + '</strong></div>' +
            '<div class="quality-actions">' +
              '<button type="button" class="arrow-button" data-quality-index="' + i + '" data-quality-move="-1" ' + (i === 0 ? 'disabled' : '') + '>↑</button>' +
              '<button type="button" class="arrow-button" data-quality-index="' + i + '" data-quality-move="1" ' + (i === qualityPriority.length - 1 ? 'disabled' : '') + '>↓</button>' +
            '</div>' +
          '</div>'
        ).join('');
      };

      const updateManifest = async () => {
        updateProviderSummary();
        const nonce = ++manifestResolveNonce;
        const fb = buildManifestPath();
        manifestUrl.textContent = (febboxUiCookie.value.trim() || (torboxEnabled.checked && torboxApiKey.value.trim()) || hasXtreamConfig() || hasStalkerConfig() || customProxyUrl.value.trim() || hasAdapterProviderSelections()) ? 'Preparing private manifest...' : origin + fb;
        try {
          const resolved = await resolveManifestPath();
          if (nonce !== manifestResolveNonce) return;
          manifestUrl.textContent = origin + resolved;
        } catch (e) {
          if (nonce !== manifestResolveNonce) return;
          manifestUrl.textContent = origin + fb;
          showFlash('Private manifest setup failed.', true);
        }
      };

      modeButtons.forEach((button) => {
        button.addEventListener('click', () => setConfigMode(button.dataset.configMode));
      });
      simpleQualityInputs.forEach((input) => {
        input.addEventListener('change', () => {
          markPresetAsCustom();
          syncSimpleQualityPriority();
          updateManifest();
        });
      });
      [simpleContentSelection, simpleDefaultSorting, simpleMaxPerQuality, simpleMaxPerProvider].forEach((el) => {
        el.addEventListener('change', () => {
          markPresetAsCustom();
          syncSimpleQualityPriority();
          updateManifest();
        });
      });

      providerSearch.addEventListener('input', renderProviderOptions);
      providerGrid.addEventListener('change', (e) => {
        const id = e.target?.dataset?.providerId;
        if (!id) return;
        if (e.target.checked) selectedProviders.add(id); else selectedProviders.delete(id);
        markPresetAsCustom();
        updateManifest();
      });
      adapterProviderList?.addEventListener('click', (e) => {
        const toggle = e.target?.closest?.('[data-adapter-toggle]');
        if (toggle) {
          toggle.closest('.adapter-provider-group')?.classList.toggle('open');
          return;
        }

        const selectAllId = e.target?.dataset?.adapterSelectAll;
        const clearId = e.target?.dataset?.adapterClear;
        const groupId = selectAllId || clearId;
        if (!groupId) return;

        const group = adapterProviderGroups.find((entry) => entry.id === groupId);
        const selection = getAdapterProviderGroupSelection({ id: groupId });
        selection.clear();
        if (selectAllId && group) {
          group.providers.forEach((provider) => selection.add(provider.id));
          selectedProviders.add(groupId);
        }
        markPresetAsCustom();
        renderProviderOptions();
        renderAdapterProviders();
        updateManifest();
      });
      adapterProviderList?.addEventListener('change', (e) => {
        const adapterId = e.target?.dataset?.adapterId;
        const providerId = e.target?.dataset?.adapterProviderId;
        if (!adapterId || !providerId) return;
        const selection = getAdapterProviderGroupSelection({ id: adapterId });
        if (e.target.checked) selection.add(providerId); else selection.delete(providerId);
        if (selection.size > 0) selectedProviders.add(adapterId);
        markPresetAsCustom();
        renderProviderOptions();
        renderAdapterProviders();
        updateManifest();
      });

      selectAllProvidersButton.addEventListener('click', () => {
        providerData.forEach((p) => selectedProviders.add(p));
        markPresetAsCustom();
        renderProviderOptions();
        updateManifest();
      });
      clearProvidersButton.addEventListener('click', () => {
        selectedProviders.clear();
        markPresetAsCustom();
        renderProviderOptions();
        updateManifest();
      });
      resetQualityOrderButton.addEventListener('click', () => {
        qualityPriority = [...defaultQualityPriority];
        markPresetAsCustom();
        renderQualityList();
        updateManifest();
      });
      qualityList.addEventListener('click', (e) => {
        const idx = Number.parseInt(e.target?.dataset?.qualityIndex || '', 10);
        const mv = Number.parseInt(e.target?.dataset?.qualityMove || '', 10);
        if (!Number.isInteger(idx) || !Number.isInteger(mv)) return;
        const ni = idx + mv;
        if (ni < 0 || ni >= qualityPriority.length) return;
        const r = [...qualityPriority];
        const [m] = r.splice(idx, 1);
        r.splice(ni, 0, m);
        qualityPriority = r;
        markPresetAsCustom();
        renderQualityList();
        updateManifest();
      });

      [webReadyOnly, hideHeavyFormats, preferHdr, preferH264, preferSmallerFiles, preferDirectHosts, torboxEnabled, torboxOnlyStreams, torboxUsenet, xtreamEnabled, stalkerStbType, famelackLiveEnabled, preferredAudioLanguage, maxSizeGb, dedupeMode, formatterStyle].forEach((el) => {
        el.addEventListener('change', () => {
          markPresetAsCustom();
          if (el === xtreamEnabled || el === stalkerStbType) scheduleIptvValidation();
          updateManifest();
        });
      });
      [blockedHosts, customProxyUrl, febboxUiCookie, torboxApiKey, xtreamServerUrl, xtreamUsername, xtreamPassword, stalkerPortalUrl, stalkerMacAddress, stalkerSerialNumber, stalkerDeviceId, stalkerDeviceId2].forEach((el) => {
        el.addEventListener('input', () => {
          markPresetAsCustom();
          if ([xtreamServerUrl, xtreamUsername, xtreamPassword, stalkerPortalUrl, stalkerMacAddress, stalkerSerialNumber, stalkerDeviceId, stalkerDeviceId2].includes(el)) {
            scheduleIptvValidation();
          }
          updateManifest();
        });
      });

      presetButtons.forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.presetId)));

      installButton.addEventListener('click', async () => {
        try {
          if (hasXtreamConfig() && (!lastXtreamValidationValid || lastXtreamValidationKey !== getXtreamValidationKey())) {
            const valid = await validateIptvCredentials();
            if (!valid) {
              showFlash('Xtream credentials are invalid.', true);
              return;
            }
          }
          const mp = await resolveManifestPath();
          window.location.href = 'stremio://addon-install?addon=' + encodeURIComponent(origin + mp);
        } catch (e) { showFlash('Install URL could not be prepared.', true); }
      });
      copyButton.addEventListener('click', async () => {
        try {
          const mp = await resolveManifestPath();
          copyText(origin + mp, 'Manifest URL copied');
        } catch (e) { showFlash('Manifest URL could not be prepared.', true); }
      });

      if (donateToggle && donationWidgetPanel) {
        donateToggle.addEventListener('click', () => donationWidgetPanel.classList.toggle('open'));
      }

      navItems.forEach((it) => {
        it.addEventListener('click', () => {
          const t = document.getElementById(it.dataset.sectionTarget || '');
          if (!t) return;
          t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });

      const observer = new IntersectionObserver((entries) => {
        const v = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!v) return;
        const id = v.target.id;
        navItems.forEach((it) => it.classList.toggle('is-active', it.dataset.sectionTarget === id));
      }, { rootMargin: '-18% 0px -55% 0px', threshold: [0.1, 0.35, 0.6] });

      ['overview-section','simple-section','presets-section','providers-section','adapter-providers-section','sorting-section','filters-section','ranking-section','torbox-section','xtream-section','support-section','notes-section']
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .forEach((s) => observer.observe(s));

      renderProviderOptions();
      renderQualityList();
      updatePresetUi();
      setConfigMode('simple');
      loadAdapterProviders();
    </script>
  </body>
</html>`;
};
const renderAdminPage = ({ stats }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="10">
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

const getClientAddress = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return String(req.ip || req.socket?.remoteAddress || 'unknown').trim();
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
  || pathName.startsWith('/admin')
  || pathName.startsWith('/assets/')
  || /^\/private\/[^/]+\/(?:stalker|xtream)\//u.test(pathName)
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
  || /^\/private\/[^/]+\/(?:stalker|xtream)\//u.test(pathName)
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

      if (restartRequired) {
        logger.error('memory guard restarting process before system lockup', {
          criticalStrikes,
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
  const torrentEngine = new TorrentEngineService({ cacheManager });
  const httpProxy = new HttpProxyService({ cacheManager, torrentEngine });
  const streamManager = new StreamManager({
    torrentEngine,
    httpProxy,
    cacheManager,
    sourceRegistry,
    providerService,
    imdbResolver,
    userTracker
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
  const renderConfigureResponse = (req, res) => {
    const baseUrl = getPublicBaseUrl(req);
    const cacheKey = baseUrl;
    const cached = configurePageCache.get(cacheKey);
    const now = Date.now();
    const html = cached && cached.expiresAt > now
      ? cached.html
      : renderConfigurePage({
        baseUrl,
        providers: providerService.listProviders()
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

  app.get('/', renderConfigureResponse);
  app.get('/configure', renderConfigureResponse);

  app.get('/donate', (req, res) => {
    res
      .status(200)
      .type('html')
      .send(renderDonatePage({
        baseUrl: getPublicBaseUrl(req)
      }));
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

  app.get('/admin', requireAdminAuth, async (req, res, next) => {
    try {
      const systemStats = await getSystemStats();
      const cacheStats = await cacheManager.getCacheStats(torrentEngine.getActiveCachePaths());
      const streamStats = streamManager.getStats();
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
        sourceRegistry: sourceRegistry.getStats()
      };

      res.status(200).type('html').send(renderAdminPage({ stats }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.post('/configure/private-config', streamManager.handleCreatePrivateConfig.bind(streamManager));
  app.post('/configure/validate-iptv', streamManager.handleValidateIptvConfig.bind(streamManager));
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
  app.get('/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/rogplay/live/:id/playlist.m3u8', streamManager.handleRogPlayLivePlaylist.bind(streamManager));
  app.get('/private/:privateConfigId/xtream/:kind/:streamId.:extension', streamManager.handleXtreamStream.bind(streamManager));
  app.get('/private/:privateConfigId/stalker/live/:channelId.:extension', streamManager.handleStalkerStream.bind(streamManager));
  app.get('/private/:privateConfigId/stalker/proxy/:channelId', streamManager.handleStalkerProxyStream.bind(streamManager));
  app.get('/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/private/:privateConfigId/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/private/:privateConfigId/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/private/:privateConfigId/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/private/:privateConfigId/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/catalog/:type/:id.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/catalog/:type/:id/search=:search.json', streamManager.handleStremioCatalog.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/meta/:type/:id.json', streamManager.handleStremioMeta.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
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
