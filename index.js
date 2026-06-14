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

const PROJECT_SUPPORTERS = [
  'Devon Durham'
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

const sleep = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

const maskEmailAddress = (email) => {
  const [user, domain] = String(email || '').trim().toLowerCase().split('@');
  if (!user || !domain) return '';
  return `${user.slice(0, 2) || '*'}***@${domain.slice(0, 1)}***`;
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
  if (!raw) return 'redx115775';

  try {
    const parsed = new URL(raw);
    const pageName = parsed.pathname.split('/').filter(Boolean)[0];
    return pageName || 'redx115775';
  } catch {
    return raw
      .replace(/^https?:\/\/(?:www\.)?ko-fi\.com\//iu, '')
      .split(/[/?#]/u)[0]
      .trim() || 'redx115775';
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
    || (amount >= 3 && amount < 5);
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

      .support-panel {
        display: grid;
        gap: 24px;
      }

      .support-hero {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(300px, 0.85fr);
        gap: 18px;
        align-items: stretch;
      }

      .support-hero-copy {
        min-height: 188px;
        padding: 26px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: var(--radius-lg);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.025)),
          radial-gradient(circle at top right, rgba(34,211,238,0.12), transparent 36%);
      }

      .support-hero-copy h3 {
        margin: 0 0 10px;
        font-size: clamp(24px, 4vw, 36px);
        line-height: 1.04;
        letter-spacing: 0;
      }

      .support-hero-copy p {
        max-width: 660px;
        margin: 0;
        color: var(--text-dim);
        font-size: 15px;
      }

      .support-kicker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 18px;
        color: #8ee7ff;
        font-size: 12px;
        font-weight: 850;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }

      .support-hero-stats {
        display: grid;
        gap: 1px;
        overflow: hidden;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: var(--radius-lg);
        background: rgba(148, 163, 184, 0.14);
      }

      .support-stat-card {
        padding: 18px 20px;
        background: rgba(9, 13, 23, 0.58);
      }

      .support-stat-card .meta-value {
        margin-top: 8px;
        font-size: 28px;
      }

      .support-pledge {
        display: grid;
        grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
        gap: 18px;
        align-items: center;
        padding: 18px 20px;
        border-radius: var(--radius-lg);
        border: 1px solid rgba(52, 211, 153, 0.24);
        background: rgba(52, 211, 153, 0.055);
      }

      .support-pledge h3 {
        margin: 0;
        color: #bbf7d0;
        font-size: 15px;
      }

      .support-pledge p {
        margin: 0;
        color: var(--text-dim);
        font-size: 13px;
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
        grid-template-columns: repeat(3, 1fr);
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

      body[data-config-mode="support"] .workspace > :not(#support-section),
      body[data-config-mode="support"] .sidebar,
      body[data-config-mode="support"] .hero,
      body[data-config-mode="support"] .simple-footer {
        display: none;
      }

      body[data-config-mode="support"] .layout {
        display: block;
      }

      body[data-config-mode="support"] #support-section {
        display: block;
      }

      .support-only {
        display: none;
      }

      body[data-config-mode="support"] .support-only {
        display: block;
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

      .support-hero-grid,
      .tier-grid,
      .supporter-wall-grid,
      .faq-grid {
        display: grid;
        gap: 14px;
      }

      .support-hero-grid {
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        margin: 18px 0;
      }

      .tier-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch;
      }

      .tier-card,
      .support-stat-card,
      .faq-card,
      .wall-card {
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--surface);
        padding: 18px;
      }

      .tier-card {
        position: relative;
        display: flex;
        flex-direction: column;
        min-height: 430px;
        padding: 22px;
        border-radius: 16px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.026)),
          rgba(7, 12, 22, 0.72);
      }

      .tier-card.featured {
        border-color: rgba(34, 211, 238, 0.45);
        box-shadow: inset 0 0 0 1px rgba(34, 211, 238, 0.1), 0 18px 48px rgba(2, 8, 23, 0.28);
      }

      .tier-card.featured::before {
        content: "Best value";
        position: absolute;
        top: 18px;
        right: 18px;
        padding: 5px 9px;
        border-radius: 999px;
        border: 1px solid rgba(34, 211, 238, 0.32);
        background: rgba(34, 211, 238, 0.1);
        color: #9befff;
        font-size: 11px;
        font-weight: 850;
      }

      .tier-eyebrow {
        display: inline-flex;
        width: fit-content;
        margin-bottom: 18px;
        padding: 5px 9px;
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 999px;
        color: var(--text-dim);
        font-size: 11px;
        font-weight: 850;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .tier-title {
        margin: 0;
        font-size: 20px;
        line-height: 1.15;
      }

      .tier-desc {
        min-height: 40px;
        margin: 8px 0 18px;
        color: var(--text-dim);
        font-size: 13px;
      }

      .tier-price {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin: 0 0 18px;
        font-size: 34px;
        font-weight: 900;
        letter-spacing: 0;
      }

      .tier-price span {
        color: var(--text-dim);
        font-size: 13px;
        font-weight: 750;
      }

      .tier-list {
        display: grid;
        gap: 10px;
        margin: 0 0 22px;
        padding: 0;
        color: var(--text-dim);
        list-style: none;
      }

      .tier-list li {
        position: relative;
        padding-left: 24px;
        line-height: 1.35;
      }

      .tier-list li::before {
        content: "";
        position: absolute;
        left: 0;
        top: 4px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: rgba(34, 211, 238, 0.14);
        box-shadow: inset 0 0 0 1px rgba(34, 211, 238, 0.28);
      }

      .tier-list li::after {
        content: "";
        position: absolute;
        left: 5px;
        top: 7px;
        width: 4px;
        height: 7px;
        border: solid #8ee7ff;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }

      .tier-card .btn {
        width: 100%;
        margin-top: auto;
      }

      .support-manage-card {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 0.65fr);
        gap: 18px;
        align-items: start;
        padding: 20px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: var(--radius-lg);
        background: rgba(255,255,255,0.03);
      }

      .support-code-box {
        display: grid;
        gap: 14px;
      }

      .support-faq-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }

      .faq-card {
        border-radius: 14px;
        background: rgba(255,255,255,0.028);
      }

      .supporter-wall-grid,
      .faq-grid {
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        margin-top: 14px;
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

      @media (max-width: 900px) {
        .support-hero,
        .support-pledge,
        .tier-grid,
        .support-manage-card {
          grid-template-columns: 1fr;
        }
        .support-hero-copy {
          min-height: auto;
        }
        .support-faq-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
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
        .simple-limit-grid,
        .support-hero,
        .support-pledge,
        .tier-grid,
        .support-manage-card,
        .support-faq-grid {
          grid-template-columns: 1fr;
        }
        .support-hero-copy,
        .support-card,
        .tier-card,
        .support-manage-card {
          padding: 14px;
        }
        .tier-card {
          min-height: auto;
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
        <button type="button" class="mode-button" data-config-mode="support">Support ❤️</button>
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

              <label class="torbox-toggle-row">
                <span>
                  <strong>Stalker / MAG Portal</strong>
                  <em>Add private MAG IPTV live TV catalogs from portal + MAC address.</em>
                </span>
                <span class="switch switch-small">
                  <input type="checkbox" id="stalker-enabled">
                  <span></span>
                </span>
              </label>

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
              <div class="field-grid">
                <div class="field">
                  <label class="field-label" for="stalker-category-offset">Category Start</label>
                  <input id="stalker-category-offset" class="field-input" type="number" min="0" step="1" value="0" placeholder="0">
                </div>
                <div class="field">
                  <label class="field-label" for="stalker-category-limit">Category Catalogs</label>
                  <input id="stalker-category-limit" class="field-input" type="number" min="1" max="120" step="1" value="40" placeholder="40">
                </div>
              </div>
              <div class="torbox-help">
                Stremio limits manifest size. For portals with hundreds of categories, set Category Start to 0, 40, 80, 120... to choose visible category page.
              </div>
              <p id="stalker-validation-status" class="torbox-help" style="min-height:18px;margin-top:-4px;"></p>

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

              <label class="torbox-toggle-row">
                <span>
                  <strong>Nflix Public Live TV</strong>
                  <em>Add public TV channel catalogs from NflixMovies.</em>
                </span>
                <span class="switch switch-small">
                  <input type="checkbox" id="nflix-live-enabled">
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
          <section class="card advanced-only support-only" id="support-section">
            <div class="card-inner">
              <div class="support-panel">
                <div class="support-hero">
                  <div class="support-hero-copy">
                    <span class="support-kicker">Support</span>
                    <h3>Support NebulaStreams</h3>
                    <p>NebulaStreams stays free for everyone. Supporters pay for convenience features and help keep hosting, monitoring, and provider maintenance funded.</p>
                  </div>
                  <div class="support-hero-stats">
                    <div class="support-stat-card"><p class="meta-label">Active users</p><p class="meta-value">${escapeHtml(String(userStats.streamUsers || userStats.totalUsers || 0))}</p></div>
                    <div class="support-stat-card"><p class="meta-label">Supporters</p><p class="meta-value">${escapeHtml(String(supporterStats.accounts || supporterStats.active || 0))}</p></div>
                    <div class="support-stat-card"><p class="meta-label">Providers</p><p class="meta-value">${escapeHtml(String(providers.length))}</p></div>
                  </div>
                </div>

                <div class="support-pledge">
                  <h3>50% donation pledge</h3>
                  <p>Half of supporter donations is set aside for charities and humanitarian programs such as UNICEF, UNFPA, CRY, and similar anti-genocide, child welfare, and emergency aid efforts. Remaining funds cover NebulaStreams hosting and maintenance.</p>
                </div>

                <div class="tier-grid">
                  <div class="tier-card">
                    <span class="tier-eyebrow">Nebula Supporter</span>
                    <h4 class="tier-title">Monthly supporter</h4>
                    <p class="tier-desc">Cloud convenience features while keeping every stream feature free.</p>
                    <div class="tier-price">$1 <span>/ month</span></div>
                    <ul class="tier-list">
                      <li>Supporter badge</li>
                      <li>Saved cloud profiles</li>
                      <li>Profile sync</li>
                      <li>Multiple config backups</li>
                      <li>Short install URLs</li>
                      <li>Early feature access</li>
                      <li>Priority support</li>
                    </ul>
                    <a class="btn btn-primary" href="${simpleKoFiUrl}" target="_blank" rel="noopener">Become Supporter</a>
                  </div>
                  <div class="tier-card featured">
                    <span class="tier-eyebrow">Nebula Founder</span>
                    <h4 class="tier-title">Lifetime founder</h4>
                    <p class="tier-desc">One-time support with founder status and lifetime perks.</p>
                    <div class="tier-price">$5 <span>/ lifetime</span></div>
                    <ul class="tier-list">
                      <li>Everything in Supporter</li>
                      <li>Lifetime founder badge</li>
                      <li>Founder recognition wall</li>
                      <li>Exclusive themes</li>
                      <li>Future supporter perks included</li>
                    </ul>
                    <a class="btn btn-primary" href="${simpleKoFiUrl}" target="_blank" rel="noopener">Become Founder</a>
                  </div>
                </div>

                <div class="support-shell">
                ${hasDonationSupport ? `
                  <div class="support-manage-card">
                    <div>
                      <h3>This addon is completely free.</h3>
                      <p class="card-desc">Support unlocks profile sync, backups, dashboard themes, and short install URLs. It never changes free provider access, stream quality, or stream count.</p>
                      <div class="support-actions">
                        <button type="button" class="donate-toggle" id="donate-toggle">Support</button>
                        ${donationPrimaryUrl ? `<a class="support-link" href="${donationPrimaryUrl}" target="_blank" rel="noopener">Ko-fi</a>` : ''}
                        <a class="support-link" href="${escapeHtml(baseUrl)}/donate">More ways</a>
                      </div>
                    </div>
                    <div class="support-code-box">
                      <div class="field">
                        <label class="field-label" for="supporter-code">Supporter Code</label>
                        <input id="supporter-code" class="field-input" type="password" placeholder="Optional supporter code" spellcheck="false" autocomplete="off">
                        <div id="supporter-validation-status" class="field-help">Supporter perks do not change free stream results.</div>
                      </div>
                      <div class="field">
                        <label class="field-label" for="supporter-profile-name">Cloud Profile Name</label>
                        <input id="supporter-profile-name" class="field-input" type="text" value="Default" maxlength="48">
                      </div>
                      <div class="field">
                        <label class="field-label">Profile Sync</label>
                        <button type="button" class="btn btn-secondary" id="save-supporter-profile">Save Current Config</button>
                      </div>
                      <div id="supporter-profile-status" class="field-help">Save provider, quality, TorBox, IPTV, adapter, and advanced settings to supporter cloud.</div>
                      <a class="support-link" href="${escapeHtml(baseUrl)}/dashboard">Open Dashboard</a>
                    </div>
                  </div>
                ` : `
                  <div class="support-manage-card">
                    <div>
                      <h3>Support account</h3>
                      <p class="card-desc">Enter supporter code from Ko-fi email to sync profiles, backups, themes, and short install URLs.</p>
                      <div class="support-actions">
                        ${donationPrimaryUrl ? `<a class="support-link" href="${donationPrimaryUrl}" target="_blank" rel="noopener">Ko-fi</a>` : ''}
                        <a class="support-link" href="${escapeHtml(baseUrl)}/donate">Support</a>
                      </div>
                    </div>
                    <div class="support-code-box">
                      <div class="field">
                        <label class="field-label" for="supporter-code">Supporter Code</label>
                        <input id="supporter-code" class="field-input" type="password" placeholder="Optional supporter code" spellcheck="false" autocomplete="off">
                        <div id="supporter-validation-status" class="field-help">Supporter perks do not change free stream results.</div>
                      </div>
                      <a class="support-link" href="${escapeHtml(baseUrl)}/dashboard">Open Dashboard</a>
                    </div>
                  </div>
                `}

                ${nowPaymentsWidgetUrl ? `
                  <div class="widget-panel" id="donation-widget-panel">
                    <iframe class="widget-frame" src="${nowPaymentsWidgetUrl}" loading="lazy" scrolling="no" title="NOWPayments donation widget">Can't load widget</iframe>
                  </div>
                ` : ''}
                </div>

                <div class="support-faq-grid">
                  <div class="faq-card"><h3>Why support?</h3><p class="card-desc">Hosting, proxy traffic, provider fixes, and uptime work cost money and time.</p></div>
                  <div class="faq-card"><h3>Free users?</h3><p class="card-desc">No provider, quality, stream count, or playback feature is gated.</p></div>
                  <div class="faq-card"><h3>Payments?</h3><p class="card-desc">Ko-fi sends a webhook. Nebula creates a supporter code and emails it.</p></div>
                  <div class="faq-card"><h3>Cloud sync?</h3><p class="card-desc">Supporters can sync, backup, restore, export, and use short install URLs.</p></div>
                </div>
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
      let activeUiMode = 'simple';
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
      const stalkerEnabled = $('stalker-enabled');
      const stalkerPortalUrl = $('stalker-portal-url');
      const stalkerMacAddress = $('stalker-mac-address');
      const stalkerStbType = $('stalker-stb-type');
      const stalkerSerialNumber = $('stalker-serial-number');
      const stalkerDeviceId = $('stalker-device-id');
      const stalkerDeviceId2 = $('stalker-device-id2');
      const stalkerCategoryOffset = $('stalker-category-offset');
      const stalkerCategoryLimit = $('stalker-category-limit');
      const stalkerValidationStatus = $('stalker-validation-status');
      const famelackLiveEnabled = $('famelack-live-enabled');
      const nflixLiveEnabled = $('nflix-live-enabled');
      const dedupeMode = $('dedupe-mode');
      const formatterStyle = $('formatter-style');
      const overviewProviderCount = $('overview-provider-count');
      const presetStatus = $('preset-status');
      const presetButtons = Array.from(document.querySelectorAll('[data-preset-id]'));
      const donateToggle = $('donate-toggle');
      const donationWidgetPanel = $('donation-widget-panel');
      const supporterCode = $('supporter-code');
      const supporterValidationStatus = $('supporter-validation-status');
      const supporterProfileName = $('supporter-profile-name');
      const saveSupporterProfile = $('save-supporter-profile');
      const supporterProfileStatus = $('supporter-profile-status');
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
        Boolean(stalkerEnabled.checked && stalkerPortalUrl.value.trim() && stalkerMacAddress.value.trim());
      const hasFamelackLiveConfig = () =>
        Boolean(famelackLiveEnabled.checked);
      const hasNflixLiveConfig = () =>
        Boolean(nflixLiveEnabled.checked);
      const hasStreamedSportsConfig = () =>
        false;
      const hasSupporterCode = () =>
        Boolean(supporterCode?.value.trim());

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
          && !hasSupporterCode()
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
        activeUiMode = mode === 'support' ? 'support' : mode === 'advanced' ? 'advanced' : 'simple';
        if (activeUiMode !== 'support') {
          configMode = activeUiMode;
        }
        document.body.dataset.configMode = activeUiMode;
        modeButtons.forEach((button) => button.classList.toggle('is-active', button.dataset.configMode === activeUiMode));
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
            stalkerPortalUrl: stalkerEnabled.checked ? stalkerPortalUrl.value.trim() : '',
            stalkerMacAddress: stalkerEnabled.checked ? stalkerMacAddress.value.trim() : '',
            stalkerStbType: stalkerEnabled.checked ? stalkerStbType.value.trim() : '',
            stalkerSerialNumber: stalkerEnabled.checked ? stalkerSerialNumber.value.trim() : '',
            stalkerDeviceId: stalkerEnabled.checked ? stalkerDeviceId.value.trim() : '',
            stalkerDeviceId2: stalkerEnabled.checked ? stalkerDeviceId2.value.trim() : '',
            stalkerCategoryOffset: stalkerEnabled.checked ? Math.max(0, Number.parseInt(stalkerCategoryOffset.value, 10) || 0) : 0,
            stalkerCategoryLimit: stalkerEnabled.checked ? Math.min(120, Math.max(1, Number.parseInt(stalkerCategoryLimit.value, 10) || 40)) : 40,
            famelackLiveEnabled: famelackLiveEnabled.checked,
            nflixLiveEnabled: nflixLiveEnabled.checked
          },
          supporterCode: supporterCode?.value.trim() || '',
          profileCode: activePresetId && presetDefinitions[activePresetId]?.code ? presetDefinitions[activePresetId].code.toLowerCase() : null
        };
      };

      let supporterValidationNonce = 0;
      let supporterValidationTimer = null;
      let lastSupporterValidationValid = false;
      let lastSupporterValidationKey = '';

      const getSupporterValidationKey = () => supporterCode?.value.trim() || '';
      const setSupporterValidationStatus = (text, color) => {
        if (!supporterValidationStatus) return;
        supporterValidationStatus.textContent = text || 'Supporter perks do not change free stream results.';
        supporterValidationStatus.style.color = color || '#94a3b8';
      };

      const validateSupporterCode = async ({ quiet = false } = {}) => {
        if (!hasSupporterCode()) {
          lastSupporterValidationValid = false;
          lastSupporterValidationKey = '';
          setSupporterValidationStatus('', '#94a3b8');
          return true;
        }
        const validationKey = getSupporterValidationKey();
        const nonce = ++supporterValidationNonce;
        if (!quiet) setSupporterValidationStatus('Checking supporter code...', '#94a3b8');

        try {
          const response = await fetch(origin + '/configure/validate-supporter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ supporterCode: validationKey })
          });
          if (!response.ok) throw new Error('Supporter validation failed');
          const result = await response.json();
          if (nonce !== supporterValidationNonce) return false;
          lastSupporterValidationValid = Boolean(result?.valid);
          lastSupporterValidationKey = validationKey;
          if (result?.valid) {
            const tier = result.supporter?.tier || 'supporter';
            setSupporterValidationStatus('Supporter valid - ' + tier, '#22c55e');
          } else {
            setSupporterValidationStatus('Supporter invalid - ' + (result?.message || 'check code'), '#ef4444');
          }
          return Boolean(result?.valid);
        } catch {
          if (nonce !== supporterValidationNonce) return false;
          lastSupporterValidationValid = false;
          lastSupporterValidationKey = validationKey;
          setSupporterValidationStatus('Supporter validation failed', '#ef4444');
          return false;
        }
      };

      const scheduleSupporterValidation = () => {
        clearTimeout(supporterValidationTimer);
        if (!hasSupporterCode()) {
          lastSupporterValidationValid = false;
          lastSupporterValidationKey = '';
          setSupporterValidationStatus('', '#94a3b8');
          updateManifest();
          return;
        }
        setSupporterValidationStatus('Waiting for supporter code...', '#94a3b8');
        supporterValidationTimer = setTimeout(() => {
          validateSupporterCode().catch(() => {});
        }, 700);
        updateManifest();
      };

      const setSupporterProfileStatus = (text, color) => {
        if (!supporterProfileStatus) return;
        supporterProfileStatus.textContent = text;
        supporterProfileStatus.style.color = color || '#94a3b8';
      };

      const saveSupporterProfileToCloud = async () => {
        if (!hasSupporterCode()) {
          setSupporterProfileStatus('Enter supporter code first.', '#ef4444');
          return;
        }
        const valid = lastSupporterValidationValid && lastSupporterValidationKey === getSupporterValidationKey()
          ? true
          : await validateSupporterCode();
        if (!valid) {
          setSupporterProfileStatus('Supporter code must be valid before saving.', '#ef4444');
          return;
        }
        setSupporterProfileStatus('Saving cloud profile...', '#94a3b8');
        try {
          const response = await fetch(origin + '/configure/supporter-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              supporterCode: supporterCode.value.trim(),
              name: supporterProfileName?.value.trim() || 'Default',
              configJson: buildPrivateConfigPayload()
            })
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error || 'Profile save failed');
          setSupporterProfileStatus('Saved. Dashboard: ' + origin + '/dashboard' + (payload.shortUrl ? ' | Short URL: ' + payload.shortUrl : ''), '#22c55e');
        } catch (error) {
          setSupporterProfileStatus(error?.message || 'Profile save failed', '#ef4444');
        }
      };

      let iptvValidationNonce = 0;
      let iptvValidationTimer = null;
      let lastXtreamValidationValid = false;
      let lastXtreamValidationKey = '';
      let lastStalkerValidationValid = false;
      let lastStalkerValidationKey = '';

      const getXtreamValidationKey = () =>
        [xtreamServerUrl.value.trim(), xtreamUsername.value.trim(), xtreamPassword.value.trim()].join('|');
      const getStalkerValidationKey = () =>
        [
          stalkerPortalUrl.value.trim(),
          stalkerMacAddress.value.trim(),
          stalkerStbType.value.trim(),
          stalkerSerialNumber.value.trim(),
          stalkerDeviceId.value.trim(),
          stalkerDeviceId2.value.trim(),
          stalkerCategoryOffset.value.trim(),
          stalkerCategoryLimit.value.trim()
        ].join('|');

      const setXtreamValidationStatus = (text, color) => {
        if (!xtreamValidationStatus) return;
        xtreamValidationStatus.textContent = text;
        xtreamValidationStatus.style.color = color || '#94a3b8';
      };
      const setStalkerValidationStatus = (text, color) => {
        if (!stalkerValidationStatus) return;
        stalkerValidationStatus.textContent = text;
        stalkerValidationStatus.style.color = color || '#94a3b8';
      };

      const validateIptvCredentials = async ({ quiet = false } = {}) => {
        if (!hasXtreamConfig() && !hasStalkerConfig()) {
          lastXtreamValidationValid = false;
          lastXtreamValidationKey = '';
          lastStalkerValidationValid = false;
          lastStalkerValidationKey = '';
          setXtreamValidationStatus('', '#94a3b8');
          setStalkerValidationStatus('', '#94a3b8');
          return true;
        }

        const xtreamValidationKey = getXtreamValidationKey();
        const stalkerValidationKey = getStalkerValidationKey();
        const nonce = ++iptvValidationNonce;
        if (hasXtreamConfig() && !quiet) {
          setXtreamValidationStatus('Checking Xtream credentials...', '#94a3b8');
        }
        if (hasStalkerConfig() && !quiet) {
          setStalkerValidationStatus('Checking Stalker credentials...', '#94a3b8');
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
            lastXtreamValidationKey = xtreamValidationKey;
            if (xtreamResult.valid) {
              const counts = xtreamResult.categories || {};
              setXtreamValidationStatus('Xtream valid - live ' + (counts.live || 0) + ', movies ' + (counts.vod || 0) + ', series ' + (counts.series || 0), '#22c55e');
            } else {
              setXtreamValidationStatus('Xtream invalid - ' + (xtreamResult.message || 'check credentials'), '#ef4444');
            }
          }
          if (hasStalkerConfig()) {
            const stalkerResult = result?.stalker || {};
            lastStalkerValidationValid = Boolean(stalkerResult.valid);
            lastStalkerValidationKey = stalkerValidationKey;
            if (stalkerResult.valid) {
              const count = Number(stalkerResult.categories?.live || 0);
              const start = Math.max(0, Number.parseInt(stalkerCategoryOffset.value, 10) || 0);
              const limit = Math.min(120, Math.max(1, Number.parseInt(stalkerCategoryLimit.value, 10) || 40));
              const end = Math.min(count, start + limit);
              setStalkerValidationStatus('Stalker valid - ' + count + ' categories, showing ' + (count > 0 ? (start + 1) + '-' + end : '0'), '#22c55e');
            } else {
              setStalkerValidationStatus('Stalker invalid - ' + (stalkerResult.message || 'check portal and MAC'), '#ef4444');
            }
          }

          return (!hasXtreamConfig() || Boolean(result?.xtream?.valid))
            && (!hasStalkerConfig() || Boolean(result?.stalker?.valid));
        } catch (error) {
          if (nonce !== iptvValidationNonce) return false;
          lastXtreamValidationValid = false;
          lastXtreamValidationKey = xtreamValidationKey;
          lastStalkerValidationValid = false;
          lastStalkerValidationKey = stalkerValidationKey;
          if (hasXtreamConfig()) {
            setXtreamValidationStatus('Xtream validation failed', '#ef4444');
          }
          if (hasStalkerConfig()) {
            setStalkerValidationStatus('Stalker validation failed', '#ef4444');
          }
          return false;
        }
      };

      const scheduleIptvValidation = () => {
        clearTimeout(iptvValidationTimer);
        if (!hasXtreamConfig() && !hasStalkerConfig()) {
          lastXtreamValidationValid = false;
          lastXtreamValidationKey = '';
          lastStalkerValidationValid = false;
          lastStalkerValidationKey = '';
          setXtreamValidationStatus('', '#94a3b8');
          setStalkerValidationStatus('', '#94a3b8');
          return;
        }
        if (hasXtreamConfig()) {
          setXtreamValidationStatus('Waiting for credentials...', '#94a3b8');
        } else {
          lastXtreamValidationValid = false;
          lastXtreamValidationKey = '';
          setXtreamValidationStatus('', '#94a3b8');
        }
        if (hasStalkerConfig()) {
          setStalkerValidationStatus('Waiting for credentials...', '#94a3b8');
        } else {
          lastStalkerValidationValid = false;
          lastStalkerValidationKey = '';
          setStalkerValidationStatus('', '#94a3b8');
        }
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
        const nflix = hasNflixLiveConfig();
        const streamed = hasStreamedSportsConfig();
        const proxy = customProxyUrl.value.trim();
        const supporter = hasSupporterCode();
        if (!cookie && !torbox && !xtream && !stalker && !famelack && !nflix && !streamed && !proxy && !supporter && !hasAdapterProviderSelections()) return buildManifestPath();
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
        manifestUrl.textContent = (febboxUiCookie.value.trim() || (torboxEnabled.checked && torboxApiKey.value.trim()) || hasXtreamConfig() || hasStalkerConfig() || hasFamelackLiveConfig() || hasNflixLiveConfig() || hasStreamedSportsConfig() || hasSupporterCode() || customProxyUrl.value.trim() || hasAdapterProviderSelections()) ? 'Preparing private manifest...' : origin + fb;
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
      if (saveSupporterProfile) {
        saveSupporterProfile.addEventListener('click', () => {
          saveSupporterProfileToCloud().catch(() => {});
        });
      }
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

      [webReadyOnly, hideHeavyFormats, preferHdr, preferH264, preferSmallerFiles, preferDirectHosts, torboxEnabled, torboxOnlyStreams, torboxUsenet, xtreamEnabled, stalkerEnabled, stalkerStbType, famelackLiveEnabled, nflixLiveEnabled, preferredAudioLanguage, maxSizeGb, dedupeMode, formatterStyle].filter(Boolean).forEach((el) => {
        el.addEventListener('change', () => {
          markPresetAsCustom();
          if (el === xtreamEnabled || el === stalkerEnabled || el === stalkerStbType) scheduleIptvValidation();
          updateManifest();
        });
      });
      [blockedHosts, customProxyUrl, febboxUiCookie, torboxApiKey, xtreamServerUrl, xtreamUsername, xtreamPassword, stalkerPortalUrl, stalkerMacAddress, stalkerSerialNumber, stalkerDeviceId, stalkerDeviceId2, stalkerCategoryOffset, stalkerCategoryLimit, supporterCode].filter(Boolean).forEach((el) => {
        el.addEventListener('input', () => {
          markPresetAsCustom();
          if ([xtreamServerUrl, xtreamUsername, xtreamPassword, stalkerPortalUrl, stalkerMacAddress, stalkerSerialNumber, stalkerDeviceId, stalkerDeviceId2, stalkerCategoryOffset, stalkerCategoryLimit].includes(el)) {
            scheduleIptvValidation();
          }
          if (el === supporterCode) {
            scheduleSupporterValidation();
            return;
          }
          updateManifest();
        });
      });

      presetButtons.forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.presetId)));

      installButton.addEventListener('click', async () => {
        try {
          const needsXtreamValidation = hasXtreamConfig()
            && (!lastXtreamValidationValid || lastXtreamValidationKey !== getXtreamValidationKey());
          const needsStalkerValidation = hasStalkerConfig()
            && (!lastStalkerValidationValid || lastStalkerValidationKey !== getStalkerValidationKey());
          if (needsXtreamValidation || needsStalkerValidation) {
            const valid = await validateIptvCredentials();
            if (!valid) {
              showFlash('IPTV credentials are invalid.', true);
              return;
            }
          }
          if (hasSupporterCode() && (!lastSupporterValidationValid || lastSupporterValidationKey !== getSupporterValidationKey())) {
            const valid = await validateSupporterCode();
            if (!valid) {
              showFlash('Supporter code is invalid.', true);
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
    <section class="panel"><div class="panel-title"><h2>Manage subscription</h2><p>${account?.lifetime ? 'Lifetime member. No renewal needed.' : 'Monthly supporter. Manage payment through Ko-fi.'}</p></div><a class="ghost link" href="https://ko-fi.com/nebulastreams">Open Ko-fi</a></section>
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
  const sportsBase = `${String(baseUrl || '').replace(/\/+$/u, '')}/sports`;
  const installUrl = account?.installKey ? `${sportsBase}/i/${account.installKey}/manifest.json` : '';
  const statusLabel = account
    ? (account.lifetime ? 'Lifetime' : `Active until ${account.expiresAt ? new Date(account.expiresAt).toLocaleDateString('en') : 'renewal'}`)
    : 'Sign in required';
  const kofiUrl = escapeHtml(config.DONATION_PRIMARY_URL || 'https://ko-fi.com/nebulastreams');
  const sportsPreview = (Array.isArray(availableSports) && availableSports.length
    ? availableSports
    : ['Football', 'Basketball', 'Tennis', 'MMA', 'Boxing', 'Cricket', 'Baseball', 'Hockey', 'Rugby', 'Motorsport']).slice(0, 14);
  const pinnedTrendingEvents = [
    { name: 'FIFA World Cup 2026', time: '2026 tournament coverage', genre: 'Football' }
  ];
  const liveTrendingEvents = (Array.isArray(trendingEvents) ? trendingEvents : [])
    .filter((event) => !/fifa|world\s*cup/iu.test(String(event?.name || '')));
  const eventPreview = [...pinnedTrendingEvents, ...liveTrendingEvents].slice(0, 6);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Nebula Sports</title>
    <link rel="icon" type="image/png" sizes="32x32" href="${escapeHtml(baseUrl)}/assets/nebula-sports-favicon-32.png">
    <link rel="apple-touch-icon" href="${escapeHtml(baseUrl)}/assets/nebula-sports-favicon.png">
    <style>
      :root{color-scheme:dark;--bg:#050914;--surface:#0b1220;--surface2:#0f1a2e;--line:rgba(148,163,184,.18);--line2:rgba(34,211,238,.3);--text:#eff6ff;--muted:#95a3b8;--soft:#d9f8ff;--accent:#22d3ee;--accent2:#2563eb;--ok:#22c55e;--bad:#fb7185;--shadow:0 26px 80px rgba(0,0,0,.32)}
      *{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;background:radial-gradient(circle at top left,rgba(34,211,238,.16),transparent 30%),linear-gradient(180deg,#07111f 0%,#050914 54%,#040711 100%);color:var(--text);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit;text-decoration:none}button,input{font:inherit}button{cursor:pointer}.page{max-width:1160px;margin:0 auto;padding:28px 22px 42px}.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}.brand{display:flex;gap:12px;align-items:center}.brand img{width:44px;height:44px;border-radius:12px;object-fit:cover}.brand strong{font-size:18px}.top-actions{display:flex;gap:10px;align-items:center}.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.04);padding:8px 11px;color:var(--muted);font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}.hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(360px,.9fr);gap:18px;align-items:start}.panel{border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.035));box-shadow:var(--shadow)}.hero-copy{padding:30px}.kicker{display:inline-flex;margin-bottom:18px;color:#8ee7ff;font-size:12px;font-weight:900;letter-spacing:.11em;text-transform:uppercase}h1{max-width:760px;margin:0 0 14px;font-size:clamp(36px,6vw,64px);line-height:.98;letter-spacing:0}h2{margin:0 0 12px;font-size:20px}h3{margin:0;font-size:15px}p{margin:0}.muted,.note{color:var(--muted)}.lead{max-width:700px;font-size:16px;line-height:1.65}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;overflow:hidden;margin-top:28px;border:1px solid var(--line);border-radius:16px;background:var(--line)}.stat{background:rgba(6,12,23,.74);padding:18px}.stat span{display:block;color:var(--muted);font-size:11px;font-weight:850;letter-spacing:.09em;text-transform:uppercase}.stat strong{display:block;margin-top:8px;font-size:28px}.preview-grid{display:grid;grid-template-columns:.92fr 1.08fr;gap:14px;margin-top:18px}.preview-card{border:1px solid var(--line);border-radius:16px;background:rgba(8,16,31,.6);padding:18px}.preview-card p{margin-top:5px;color:var(--muted);font-size:13px}.sport-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.sport-chip{display:inline-flex;padding:7px 10px;border:1px solid rgba(34,211,238,.2);border-radius:999px;background:rgba(34,211,238,.07);color:#cff8ff;font-size:12px;font-weight:800}.event-list{display:grid;gap:9px;margin-top:14px}.event-item{display:grid;gap:4px;padding:10px 0;border-top:1px solid rgba(148,163,184,.13)}.event-item:first-child{border-top:0;padding-top:0}.event-item strong{font-size:13px;line-height:1.35}.event-item span{color:var(--muted);font-size:12px}.pricing{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:18px}.price-card{position:relative;display:flex;flex-direction:column;min-height:250px;padding:20px;border:1px solid var(--line);border-radius:16px;background:rgba(8,16,31,.72)}.price-card.featured{border-color:var(--line2);box-shadow:inset 0 0 0 1px rgba(34,211,238,.08)}.price-card.featured:before{content:"Best value";position:absolute;top:16px;right:16px;padding:5px 9px;border:1px solid rgba(34,211,238,.35);border-radius:999px;background:rgba(34,211,238,.1);color:#9befff;font-size:11px;font-weight:900}.plan-name{color:var(--muted);font-size:11px;font-weight:900;letter-spacing:.1em;text-transform:uppercase}.price{display:flex;align-items:baseline;gap:7px;margin:18px 0 10px;font-size:34px;font-weight:950}.price span{color:var(--muted);font-size:13px;font-weight:750}.price-card p{min-height:42px;color:var(--muted);line-height:1.5}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;margin-top:auto;border:1px solid transparent;border-radius:10px;background:linear-gradient(135deg,var(--accent2),var(--accent));color:#fff;font-weight:850;text-align:center}.btn.secondary,.ghost{border-color:var(--line);background:rgba(255,255,255,.055);color:var(--text)}.auth-panel{padding:22px}.flash{margin-bottom:14px;border:1px solid rgba(34,197,94,.34);background:rgba(34,197,94,.09);color:#bbf7d0;border-radius:12px;padding:12px}.flash.error{border-color:rgba(251,113,133,.4);background:rgba(251,113,133,.08);color:#fecdd3}.forms{display:grid;grid-template-columns:1fr;gap:14px}.form-card{display:grid;gap:10px;padding:18px;border:1px solid var(--line);border-radius:16px;background:rgba(7,14,27,.68)}label{display:grid;gap:7px;color:var(--muted);font-size:13px;font-weight:700}input{width:100%;border:1px solid var(--line);background:#07111d;color:var(--text);border-radius:10px;padding:11px 12px}input:focus{outline:0;border-color:rgba(34,211,238,.55);box-shadow:0 0 0 3px rgba(34,211,238,.1)}.install{display:grid;gap:14px}.install-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.status{color:var(--ok);font-weight:850}.install code{display:block;word-break:break-all;background:#07111d;border:1px solid var(--line);border-radius:12px;padding:14px;color:var(--soft)}.row{display:flex;gap:10px;flex-wrap:wrap}.row form{margin:0}.note{font-size:13px;line-height:1.55}.footer-note{margin-top:18px;padding:16px 18px;border:1px solid rgba(34,211,238,.18);border-radius:16px;background:rgba(34,211,238,.055)}@media(max-width:900px){.hero,.pricing,.preview-grid{grid-template-columns:1fr}.topbar{align-items:flex-start;gap:14px}.top-actions{display:none}.price-card{min-height:auto}}@media(max-width:560px){.page{padding:18px 12px 28px}.hero-copy,.auth-panel{padding:16px}.stats{grid-template-columns:1fr}.install-head{display:block}.row .btn,.row button{width:100%}}
    </style>
  </head>
  <body>
    <main class="page">
      <div class="topbar">
        <div class="brand">
          <img src="${escapeHtml(baseUrl)}/assets/nebula-sports-logo.png" alt="Nebula Sports">
          <strong>Nebula Sports</strong>
        </div>
        <div class="top-actions">
          <span class="pill">Paid addon</span>
          <a class="pill" href="${escapeHtml(baseUrl)}/configure">NebulaStreams</a>
        </div>
      </div>
      <section class="hero">
        <div class="panel hero-copy">
          <span class="kicker">Nebula Sports</span>
          <h1>Live sports events for Stremio.</h1>
          <p class="lead muted">Private sports addon with clean catalogs, small manifest, username/password access, and Ko-fi token signup. Built separate from main NebulaStreams so sports catalogs stay fast on TV clients.</p>
          <div class="stats">
            <div class="stat"><span>Sports accounts</span><strong>${escapeHtml(String(stats.accounts || 0))}</strong></div>
            <div class="stat"><span>Active</span><strong>${escapeHtml(String(stats.active || 0))}</strong></div>
            <div class="stat"><span>Catalogs</span><strong>18</strong></div>
          </div>
          <div class="preview-grid">
            <div class="preview-card">
              <h3>Sports included</h3>
              <p>Live, today, popular, plus dedicated sports catalogs.</p>
              <div class="sport-chips">
                ${sportsPreview.map((sport) => `<span class="sport-chip">${escapeHtml(sport)}</span>`).join('')}
              </div>
            </div>
            <div class="preview-card">
              <h3>Trending events</h3>
              <p>Preview updates from current Streamed event data.</p>
              <div class="event-list">
                ${eventPreview.length ? eventPreview.map((event) => `
                  <div class="event-item">
                    <strong>${escapeHtml(event.name || 'Live sports event')}</strong>
                    <span>${escapeHtml([event.time, event.genre].filter(Boolean).join(' · ') || 'Live/upcoming')}</span>
                  </div>
                `).join('') : `
                  <div class="event-item">
                    <strong>Live and upcoming events</strong>
                    <span>Football, basketball, tennis, combat sports, cricket, motorsport, and more.</span>
                  </div>
                `}
              </div>
            </div>
          </div>
          <div class="pricing">
            <div class="price-card">
              <span class="plan-name">Monthly</span>
              <div class="price">$1 <span>/ month</span></div>
              <p>Access while subscription is active. Include "Nebula Sports" in Ko-fi note.</p>
              <a class="btn secondary" href="${kofiUrl}" target="_blank" rel="noopener">Pay on Ko-fi</a>
            </div>
            <div class="price-card featured">
              <span class="plan-name">Lifetime</span>
              <div class="price">$3 <span>/ lifetime</span></div>
              <p>One payment. Webhook treats $3 Sports payment as lifetime access.</p>
              <a class="btn" href="${kofiUrl}" target="_blank" rel="noopener">Get lifetime</a>
            </div>
          </div>
          <div class="footer-note note">After payment, Ko-fi webhook emails a one-use secret token. Create username/password here, paste token, then install your private manifest.</div>
        </div>
        <div class="panel auth-panel">
          ${errorMessage ? `<div class="flash error">${escapeHtml(errorMessage)}</div>` : ''}
          ${successMessage ? `<div class="flash">${escapeHtml(successMessage)}</div>` : ''}
          ${account ? `
            <div class="install">
              <div class="install-head">
                <div>
                  <h2>Welcome, ${escapeHtml(account.username)}</h2>
                  <p class="muted">Use this private install URL in Stremio.</p>
                </div>
                <span class="status">${escapeHtml(statusLabel)}</span>
              </div>
              <code>${escapeHtml(installUrl)}</code>
              <div class="row">
                <a class="btn" href="${escapeHtml(installUrl)}">Install manifest</a>
                <button class="btn secondary" type="button" data-copy="${escapeHtml(installUrl)}">Copy URL</button>
                <form method="post" action="/sports/logout"><button class="btn secondary" type="submit">Sign out</button></form>
              </div>
              <p class="note">Playback uses Nebula private HLS bridge. Do not share this URL; it belongs to your account.</p>
            </div>
          ` : `
            <div class="forms">
              <form class="form-card" method="post" action="/sports/trial/request">
                <h2>Try free for 24 hours</h2>
                <p class="note">Enter email. If eligible, one-use trial token arrives by email. One trial per user.</p>
                <label>Email<input name="email" type="email" autocomplete="email" required></label>
                <button class="btn secondary" type="submit">Get Free Trial</button>
              </form>
              <form class="form-card" method="post" action="/sports/login">
                <h2>Sign in</h2>
                <label>Username<input name="username" autocomplete="username" required></label>
                <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
                <button class="btn" type="submit">Sign in</button>
              </form>
              <form class="form-card" method="post" action="/sports/signup">
                <h2>Create account</h2>
                <p class="note">Use the one-use token from your Nebula Sports email.</p>
                <label>Username<input name="username" autocomplete="username" required></label>
                <label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
                <label>Secret token<input name="tokenCode" autocomplete="off" placeholder="NSPORT-..." required></label>
                <button class="btn secondary" type="submit">Create account</button>
              </form>
            </div>
          `}
        </div>
      </section>
    </main>
    <script>document.querySelectorAll('[data-copy]').forEach((btn)=>btn.addEventListener('click',async()=>{const value=btn.getAttribute('data-copy')||'';if(!value)return;await navigator.clipboard.writeText(value);btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy URL',1300)}));</script>
  </body>
</html>`;
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
  const kofiPageName = escapeHtml(getKofiPageName(config.DONATION_PRIMARY_URL || 'https://ko-fi.com/redx115775'));
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
	      *{box-sizing:border-box}html{background:var(--page)}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% -8%,rgba(120,215,255,.12),transparent 34%),radial-gradient(circle at 88% 6%,rgba(101,230,164,.1),transparent 30%),linear-gradient(180deg,#0b0b0e 0%,#0f1115 100%);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;letter-spacing:0}button,input,select{font:inherit}button{cursor:pointer}a{color:inherit;text-decoration:none}.app{min-height:100dvh;display:grid;grid-template-rows:auto 1fr}.top{height:58px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 18px;border-bottom:1px solid var(--line);background:rgba(11,11,14,.78);backdrop-filter:blur(18px);position:sticky;top:0;z-index:5}.brand{display:flex;align-items:center;gap:10px;font-weight:900}.brand img{width:34px;height:34px;border-radius:13px;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 10px 24px rgba(101,230,164,.15)}.brand-copy{display:grid;line-height:1.02}.brand-copy span{font-size:15px;letter-spacing:-.025em;background:linear-gradient(90deg,#f8fbff 0%,#78d7ff 52%,#65e6a4 100%);-webkit-background-clip:text;background-clip:text;color:transparent}.brand-copy small{margin-top:4px;color:var(--muted);font-size:10px;font-weight:800}.actions{display:flex;gap:7px;align-items:center}.btn{min-height:32px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.035);color:var(--soft);padding:6px 10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap;transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease,box-shadow .18s ease}.btn:hover{border-color:var(--line-strong);background:rgba(255,255,255,.07);color:var(--ink)}.btn:active{transform:translateY(1px) scale(.99)}.btn.primary{border-color:transparent;background:linear-gradient(135deg,var(--accent),#8df6bf);color:var(--accent-ink);box-shadow:0 10px 28px rgba(101,230,164,.2)}.btn.primary:hover{box-shadow:0 14px 36px rgba(101,230,164,.28)}.btn-icon{opacity:.86;font-weight:900}.layout{width:min(1280px,100%);margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px;padding:12px 16px 16px}.stage{min-width:0;display:grid;gap:12px}.intro{min-height:84px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(180deg,rgba(24,24,28,.82),rgba(15,15,18,.82));display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 18px;box-shadow:0 14px 46px rgba(0,0,0,.22)}.intro h1{margin:0;max-width:660px;font-size:clamp(26px,3vw,40px);font-weight:950;line-height:1;letter-spacing:-.04em}.intro p{margin:7px 0 0;max-width:520px;color:var(--muted);font-size:14px;line-height:1.45}.signal{display:flex;align-items:center;gap:9px;white-space:nowrap;padding:7px 9px 7px 11px;border:1px solid rgba(101,230,164,.22);border-radius:999px;background:rgba(101,230,164,.06)}.signal span{color:#d8f8e2;font-size:11px;font-weight:900}.pill{border:1px solid rgba(101,230,164,.24);border-radius:999px;padding:5px 10px;color:#d8f8e2;background:rgba(101,230,164,.08);font-size:11px;font-weight:900}.live-dot,.dot{position:relative;width:8px;height:8px;border-radius:99px;background:var(--accent);box-shadow:0 0 0 4px rgba(101,230,164,.14)}.live-dot::after,.dot::after{content:"";position:absolute;inset:-6px;border-radius:99px;border:1px solid rgba(101,230,164,.58);animation:pulse 1.8s ease-out infinite}@keyframes pulse{0%{transform:scale(.65);opacity:.9}100%{transform:scale(1.75);opacity:0}}.player-shell{border:1px solid var(--line-strong);border-radius:18px;background:#07080a;box-shadow:0 14px 44px rgba(0,0,0,.38);overflow:hidden}.player-head{min-height:42px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(35,35,40,.86),rgba(18,18,22,.92));color:#eef2f0}.status{display:inline-flex;align-items:center;gap:8px;min-height:30px;border:1px solid rgba(101,230,164,.22);border-radius:999px;background:rgba(101,230,164,.06);padding:5px 9px;color:#d8f8e2;font-size:10px;font-weight:900;letter-spacing:.02em}.player{aspect-ratio:16/9;width:100%;min-height:328px;background:#050608;display:grid;place-items:center;overflow:hidden;border-radius:0 0 19px 19px}.player iframe{display:block;width:100%;height:100%;border:0;background:#050608}.empty{display:grid;place-items:center;text-align:center;gap:6px;padding:20px;color:#8d949f}.empty strong{display:block;color:var(--soft);font-size:16px;font-weight:900}.empty span{max-width:320px;line-height:1.45}.now{border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,rgba(24,24,28,.8),rgba(15,15,18,.88));display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,42%);gap:10px;padding:10px;box-shadow:0 8px 34px rgba(0,0,0,.2)}.now-copy h1{margin:0;font-size:18px;font-weight:950;line-height:1.15;letter-spacing:-.025em}.now-copy p{margin:5px 0 0;color:var(--muted);font-size:12px}.streams{display:flex;align-items:center;gap:7px;overflow:auto;padding:2px 2px 3px}.streams h3{display:none}.stream-btn{min-height:34px;display:flex;align-items:center;justify-content:space-between;gap:9px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.04);color:var(--ink);padding:6px 9px 6px 10px;white-space:nowrap;transition:background .18s ease,border-color .18s ease,transform .18s ease}.stream-btn:hover{border-color:rgba(120,215,255,.32);background:rgba(120,215,255,.075);transform:translateY(-1px)}.stream-btn.active{border-color:rgba(101,230,164,.5);background:rgba(101,230,164,.12)}.quality{font-size:11px;font-weight:950;letter-spacing:.02em;color:#e9fff2}.viewer{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:#b9c1ca;font-weight:850}.viewer::before{content:"";width:10px;height:6px;border:1px solid currentColor;border-radius:999px;box-shadow:inset 0 0 0 2px rgba(255,255,255,.03)}.badge{font-size:11px;color:#d8f8e2;font-weight:900}.side{min-height:0;border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,rgba(24,24,28,.88),rgba(15,15,18,.92));overflow:hidden;box-shadow:0 14px 46px rgba(0,0,0,.26);display:grid;grid-template-rows:auto 1fr}.tabs{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:8px;padding:5px;border:1px solid var(--line);border-radius:999px;background:rgba(0,0,0,.22)}.tab{height:34px;border:0;border-radius:999px;background:transparent;color:var(--muted);font-weight:900;display:flex;align-items:center;justify-content:center;gap:6px;transition:background .2s ease,color .2s ease,box-shadow .2s ease,transform .2s ease}.tab:hover{color:var(--ink);background:rgba(255,255,255,.045)}.tab.active{background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.07));color:var(--ink);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),0 7px 18px rgba(0,0,0,.22)}.tab-icon{color:var(--accent);font-size:11px}.panel{display:none;min-height:0}.panel.active{display:grid}.events-panel{grid-template-rows:auto 1fr}.side-head{padding:12px 14px 14px;border-bottom:1px solid var(--line);display:grid;gap:10px}.side-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.side-title h2{margin:0;font-size:17px;font-weight:950;letter-spacing:-.025em}.search{display:grid;grid-template-columns:1fr auto;gap:8px}.search input,.side select,.chat input{width:100%;height:34px;border:1px solid var(--line);background:rgba(255,255,255,.045);color:var(--ink);border-radius:999px;padding:0 13px;outline:none;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease}.search input::placeholder,.chat input::placeholder{color:#737b86}.search input:focus,.side select:focus,.chat input:focus{border-color:rgba(101,230,164,.48);background:rgba(255,255,255,.065);box-shadow:0 0 0 4px rgba(101,230,164,.1)}.filters{display:grid;gap:8px}.catalog-picker{position:relative}.catalog-trigger{width:100%;height:34px;border:1px solid var(--line);background:rgba(255,255,255,.045);color:var(--ink);border-radius:999px;padding:0 13px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-weight:850;text-align:left;outline:none;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease}.catalog-trigger:hover,.catalog-trigger[aria-expanded="true"]{border-color:rgba(101,230,164,.48);background:rgba(255,255,255,.065);box-shadow:0 0 0 4px rgba(101,230,164,.1)}.catalog-menu{position:absolute;z-index:30;top:calc(100% + 6px);left:0;right:0;display:none;max-height:260px;overflow:auto;padding:6px;border:1px solid var(--line-strong);border-radius:14px;background:#101116;box-shadow:0 18px 42px rgba(0,0,0,.48)}.catalog-picker.open .catalog-menu{display:grid;gap:3px}.catalog-option{width:100%;min-height:32px;border:0;border-radius:10px;background:transparent;color:#e7edf4;padding:7px 10px;text-align:left;font-size:12px;font-weight:850}.catalog-option:hover,.catalog-option:focus{background:rgba(120,215,255,.12);color:#fff;outline:none}.catalog-option.active{background:rgba(101,230,164,.15);color:#d8f8e2}.list{overflow:auto;padding:8px;display:grid;gap:7px;align-content:start}.event{width:100%;text-align:left;border:1px solid transparent;border-radius:14px;background:rgba(255,255,255,.035);color:var(--ink);padding:11px 12px;display:grid;gap:6px;transition:background .18s ease,border-color .18s ease,transform .18s ease}.event:hover{border-color:var(--line-strong);background:rgba(255,255,255,.06);transform:translateY(-1px)}.event.active{border-color:rgba(101,230,164,.44);background:rgba(101,230,164,.1)}.event strong{display:block;font-size:13px;line-height:1.32;font-weight:900}.event span{display:block;color:var(--muted);font-size:11px;line-height:1.35}.chat{padding:12px;grid-template-rows:auto 1fr auto auto;gap:8px;min-height:440px}.chat-list{overflow:auto;display:grid;gap:8px;align-content:start;padding-right:2px}.chat-msg{position:relative;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.045);padding:10px 11px;box-shadow:0 7px 20px rgba(0,0,0,.12);display:grid;gap:6px}.chat-msg::before,.chat-msg::after,.chat-meta::before,.chat-meta::after{content:none!important;display:none!important}.chat-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--muted);font-size:10px;min-width:0}.chat-name{display:block;min-width:0;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d8f8e2;font-size:11px;font-weight:950;background:transparent!important;border:0!important;border-radius:0!important;padding:0!important}.chat-time{flex:0 0 auto;color:#858d98}.chat-text{margin:0;color:#e4e8ee;line-height:1.38;overflow-wrap:anywhere;background:transparent!important;border:0!important;border-radius:0!important;padding:0!important}.chat-form{display:grid;grid-template-columns:86px 1fr auto;gap:7px}.chat-status{min-height:16px;color:var(--muted);font-size:11px}.error{color:var(--danger);border:1px solid #7f1d1d;background:#2a1014;border-radius:14px;padding:10px;margin-top:12px}.floatingchat-container-wrap{right:18px!important;bottom:18px!important;z-index:20!important;background:transparent!important;box-shadow:none!important}.floatingchat-container-wrap iframe,.floatingchat-container-wrap-mobi iframe{background:transparent!important;box-shadow:none!important}.floatingchat-container-wrap-mobi{right:12px!important;bottom:12px!important;z-index:20!important}@media(min-width:1081px){body{font-size:12px}.top{height:54px;padding:0 16px}.brand img{width:31px;height:31px}.brand-copy span{font-size:14px}.layout{width:min(1200px,100%);grid-template-columns:minmax(0,1fr) 300px;gap:12px;padding:10px 14px 14px}.stage{gap:10px}.intro{min-height:74px;padding:13px 15px;border-radius:18px}.intro h1{font-size:clamp(24px,2.55vw,35px)}.intro p{font-size:13px}.player-head{min-height:38px}.player{min-height:296px}.now{padding:9px}.now-copy h1{font-size:16px}.side{border-radius:16px}.tabs{margin:7px}.side-head{padding:10px 12px 12px}.chat{min-height:400px;padding:10px}.event{padding:9px 10px}.btn{min-height:30px;padding:5px 9px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}@media(max-width:1080px){.layout{grid-template-columns:1fr}.player{min-height:auto}.side{min-height:480px}.intro{align-items:flex-start}.now{grid-template-columns:1fr}.streams{padding-top:4px}.signal{align-self:flex-start}}@media(max-width:680px){.top{height:auto;padding:12px;align-items:flex-start;flex-direction:column}.actions{width:100%;overflow:auto}.layout{padding:12px 12px 80px;gap:14px}.intro{min-height:0;padding:16px;align-items:flex-start;flex-direction:column}.intro h1{font-size:30px}.player-head{align-items:flex-start;flex-direction:column}.now{padding:12px}.side{min-height:540px}.brand-copy small{display:none}.btn{min-height:36px;padding:7px 12px}.chat{min-height:500px}.chat-form{grid-template-columns:1fr}.tabs{border-radius:20px}.tab{height:38px}.player{border-radius:0 0 19px 19px}}
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
		            <a class="rail-avatar" href="${escapeHtml(config.DONATION_PRIMARY_URL || 'https://ko-fi.com/redx115775')}" target="_blank" rel="noopener noreferrer" aria-label="Support Nebula Sports">N</a>
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
	              <div class="side-title"><h2>Event chat</h2><span class="pill" id="chatCount">0</span></div>
	              <div class="chat-list" id="chatMessages"><div class="empty">Loading chat...</div></div>
	              <form class="chat-form" id="chatForm">
                <input id="chatName" maxlength="24" placeholder="Name" autocomplete="nickname">
                <input id="chatText" maxlength="240" placeholder="Say something kind" autocomplete="off" required>
                <button class="btn primary" type="submit">Send</button>
	              </form>
	              <div class="chat-status" id="chatStatus">Public chat. Be kind. No spam.</div>
	            </section>
			          </aside>
	        </div>
	        </div>
	        </div>
	        <a class="kofi-fallback" id="kofiFallback" href="${escapeHtml(config.DONATION_PRIMARY_URL || 'https://ko-fi.com/redx115775')}" target="_blank" rel="noopener noreferrer">Support Us</a>
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
        const postApi=async(path,body)=>{const res=await fetch(withAccessKey(path),{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify(body)});const data=await res.json().catch(()=>({error:'Request failed'}));if(!res.ok)throw new Error(data.error||'Request failed');return data};
        const withPlayerParams=(value)=>{try{const url=new URL(value);[['autoplay','1'],['muted','0'],['mute','0'],['volume','1']].forEach(([key,paramValue])=>url.searchParams.set(key,paramValue));return url.toString()}catch{return value}};
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
            frame.referrerPolicy='no-referrer-when-downgrade';
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
          loadChat().catch(()=>{el('chatMessages').innerHTML='<div class="empty">Chat unavailable.</div>'});
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
        const renderChat=(messages=[])=>{
          el('chatCount').textContent=String(messages.length);
          if(!messages.length){el('chatMessages').innerHTML='<div class="empty">No messages yet.</div>';return}
	          el('chatMessages').innerHTML=messages.map((message)=>'<article class="chat-msg"><div class="chat-meta"><strong class="chat-name">'+esc(message.name||'Guest')+'</strong><time class="chat-time">'+esc(timeLabel(message.createdAt))+'</time></div><p class="chat-text">'+esc(message.text||'')+'</p></article>').join('');
          el('chatMessages').scrollTop=el('chatMessages').scrollHeight;
        };
        const loadChat=async()=>{
          if(!state.event?.id){renderChat([]);el('chatMessages').innerHTML='<div class="empty">Select an event to open its chat.</div>';return}
          const data=await api('/watch-together/api/chat?eventId='+encodeURIComponent(state.event.id));
          renderChat(data.messages||[]);
        };
        const lockChatName=()=>{
          const savedName=(localStorage.getItem('nebula-chat-name')||'').trim();
          if(savedName){
            el('chatName').value=savedName;
            el('chatName').disabled=true;
            el('chatName').title='Username locked for this browser';
            el('chatText').disabled=false;
            el('chatStatus').textContent='Chatting as '+savedName+'.';
          }else{
            el('chatName').disabled=false;
            el('chatText').disabled=true;
            el('chatStatus').textContent='Set a username first. It locks for this browser.';
          }
        };
        el('chatName').value=localStorage.getItem('nebula-chat-name')||'';
        lockChatName();
        el('chatName').addEventListener('input',()=>{el('chatText').disabled=!el('chatName').value.trim();el('chatStatus').textContent=el('chatText').disabled?'Set a username first. It locks for this browser.':'Username will lock after first message.'});
        el('chatForm').addEventListener('submit',async(event)=>{
          event.preventDefault();
          const name=el('chatName').value.trim();
          const text=el('chatText').value.trim();
          if(!name){el('chatStatus').textContent='Set a username before chatting.';el('chatName').focus();return}
          if(!text)return;
          el('chatStatus').textContent='Sending...';
          try{
            localStorage.setItem('nebula-chat-name',name);
            if(!state.event?.id){el('chatStatus').textContent='Select an event before chatting.';return}
            const data=await postApi('/watch-together/api/chat',{eventId:state.event.id,name,text});
            el('chatText').value='';
            lockChatName();
            renderChat(data.messages||[]);
            el('chatStatus').textContent='Sent';
            setTimeout(()=>{el('chatStatus').textContent='Chatting as '+(localStorage.getItem('nebula-chat-name')||name)+'.'},1200);
          }catch(error){
            el('chatStatus').textContent=String(error.message||error).slice(0,120);
          }
        });
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
	        renderChat([]);
	        el('chatMessages').innerHTML='<div class="empty">Select an event to open its chat.</div>';
	        setInterval(()=>loadChat().catch(()=>{}),8000);
	      </script>
	      <script>
	        (() => {
	          if (typeof window === 'undefined' || window.__nebulaKofiWidgetLoaded) return;
	          window.__nebulaKofiWidgetLoaded = true;
		          const drawWidget = () => {
		            if (!window.kofiWidgetOverlay?.draw) return;
		            window.kofiWidgetOverlay.draw('${kofiPageName}', {
		              type: 'floating-chat',
		              'floating-chat.donateButton.text': 'Support Us',
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
  || pathName === '/webhooks/kofi'
  || pathName === '/webhooks/ko-fi'
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

  app.get('/', renderConfigureResponse);
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
    return sportsSupporterService.validateSession(cookies[SPORTS_COOKIE_NAME]);
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
      .filter((catalog) => !['streamed-events-live', 'streamed-events-today', 'streamed-events-popular'].includes(catalog.id))
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
    const account = sportsSupporterService.getAccountByInstallKey(req.params.installKey);
    if (!sportsSupporterService.isAccountActive(account)) {
      res.status(402).json({ error: 'Nebula Sports account inactive or expired' });
      return null;
    }
    return account;
  };

  const getCatalogSearchValue = (req) => {
    const extra = String(req.params.extra || '');
    const extraParams = new URLSearchParams(extra.replace(/\.json$/u, ''));
    return String(req.query.search || req.params.search || extraParams.get('search') || '').trim();
  };

  const SPORTS_MAIN_CATALOG_ID = 'all';
  const SPORTS_LEGACY_CATALOG_ID = 'nebula-sports-events';

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

  const isSportsTvClient = (req) => {
    const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
    return /webos|smarttv|tizen|netcast|lge|stremio tv|stremio-shell/u.test(userAgent);
  };

  const SPORTS_TV_META_CACHE_TTL_MS = 10 * 60 * 1000;
  const SPORTS_TV_META_CACHE_MAX = 1000;
  const sportsTvMetaCache = new Map();

  const getSportsTvMetaCacheKey = (account, id) => `${account?.id || account?.installKey || 'anon'}:${String(id || '')}`;

  const getCachedSportsTvMeta = (account, id) => {
    const key = getSportsTvMetaCacheKey(account, id);
    const entry = sportsTvMetaCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      sportsTvMetaCache.delete(key);
      return null;
    }
    return entry.meta;
  };

  const cacheSportsTvMetas = (account, metas = []) => {
    const now = Date.now();
    for (const meta of metas) {
      if (!meta?.id) continue;
      sportsTvMetaCache.set(getSportsTvMetaCacheKey(account, meta.id), {
        meta,
        expiresAt: now + SPORTS_TV_META_CACHE_TTL_MS
      });
    }
    if (sportsTvMetaCache.size <= SPORTS_TV_META_CACHE_MAX) return;
    const targetSize = Math.floor(SPORTS_TV_META_CACHE_MAX * 0.8);
    for (const key of sportsTvMetaCache.keys()) {
      sportsTvMetaCache.delete(key);
      if (sportsTvMetaCache.size <= targetSize) break;
    }
  };

  const buildFallbackSportsMeta = (id) => {
    const rawId = String(id || '');
    const name = decodeURIComponent(rawId.replace(/^streamed:/u, ''))
      .replace(/[-_]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim() || 'Nebula Sports Event';
    return {
      id: rawId,
      type: 'tv',
      name,
      posterShape: 'landscape',
      genres: ['Sports'],
      releaseInfo: 'Live/upcoming',
      runtime: 'Live',
      description: 'Nebula Sports event. Stream list loads from fresh live source.'
    };
  };

  const decorateSportsMeta = (meta, reqOrBaseUrl) => {
    const baseUrl = typeof reqOrBaseUrl === 'string' ? reqOrBaseUrl : getPublicBaseUrl(reqOrBaseUrl);
    const defaultImage = `${baseUrl}/assets/nebula-sports-logo.png`;
    const genres = Array.isArray(meta?.genres) && meta.genres.length ? meta.genres : ['Sports'];
    const primaryGenre = genres.find((genre) => genre && genre !== 'Sports') || genres[0] || 'Sports';
    return {
      ...meta,
      id: String(meta?.id || ''),
      type: 'tv',
      name: String(meta?.name || 'Nebula Sports Event'),
      genre: primaryGenre,
      genres,
      poster: meta?.poster || defaultImage,
      logo: meta?.logo || meta?.poster || defaultImage,
      background: meta?.background || meta?.poster || defaultImage,
      posterShape: meta?.posterShape || 'landscape',
      country: 'Sports',
      countryCode: 'sports',
      time: meta?.releaseInfo || null,
      streams: []
    };
  };

  const prewarmSportsTvMetaCache = async (account, catalogDefinitions, req) => {
    if (!isSportsTvClient(req)) return;
    const baseUrl = getPublicBaseUrl(req);
    const warmCatalogs = [
      catalogDefinitions.find((catalog) => catalog.id === 'streamed-events-live'),
      catalogDefinitions.find((catalog) => catalog.id === 'streamed-events-today'),
      catalogDefinitions.find((catalog) => catalog.id === 'streamed-events-popular')
    ].filter(Boolean);
    if (!warmCatalogs.length) return;
    const results = await Promise.allSettled(warmCatalogs.map(async (catalog) => {
      const metas = await streamManager.streamedSportsAdapter.getEventCatalog({
        catalog,
        limit: 24,
        signal: AbortSignal.timeout(2_500)
      });
      cacheSportsTvMetas(account, metas.map((meta) => decorateSportsMeta(meta, baseUrl)));
    }));
    const failures = results.filter((result) => result.status === 'rejected').length;
    if (failures) {
      logger.debug('nebula sports tv meta prewarm partial failure', {
        failures,
        total: results.length
      });
    }
  };

  const sendSportsManifest = async (req, res, next) => {
    try {
      const account = await getSportsAccountFromInstall(req, res);
      if (!account) return;
      const baseUrl = getPublicBaseUrl(req);
      const tvClient = isSportsTvClient(req);
      const catalogDefinitions = await getSportsCatalogDefinitions({ timeoutMs: tvClient ? 1_500 : 6_000 });
      const genreOptions = catalogDefinitions
        .map((catalog) => String(catalog.name || '').replace(/^Sports Events:\s*/u, '').trim())
        .filter(Boolean);
      const catalogs = [{
        type: 'tv',
        id: SPORTS_MAIN_CATALOG_ID,
        name: 'Nebula Sports',
        extra: [
          { name: 'genre', options: genreOptions, isRequired: false }
        ]
      }];
      streamManager.streamedSportsAdapter.prewarmCatalogs(catalogDefinitions);
      void prewarmSportsTvMetaCache(account, catalogDefinitions, req).catch((error) => {
        logger.debug('nebula sports tv meta prewarm failed', {
          error: error?.message || String(error)
        });
      });
      await sportsSupporterService.increment(account.id, 'manifests', 1);
      res
        .setHeader('Cache-Control', 'private, max-age=120')
        .json({
          id: 'org.nebulastreams.sports',
          version: '1.0.0',
          name: 'Nebula Sports',
          description: 'Paid Nebula Sports addon for live sports event catalogs and Stremio playback.',
          logo: `${baseUrl}/assets/nebula-sports-logo.png`,
          background: `${baseUrl}/assets/nebula-sports-logo.png`,
          behaviorHints: {
            configurable: true
          },
          resources: ['catalog', 'stream', 'meta'],
          types: ['tv'],
          idPrefixes: ['streamed'],
          catalogs
        });
    } catch (error) {
      next(error);
    }
  };

  const sendSportsCatalog = async (req, res, next) => {
    try {
      const account = await getSportsAccountFromInstall(req, res);
      if (!account) return;
      const type = String(req.params.type || '').trim().toLowerCase();
      if (type !== 'tv' && type !== 'events' && type !== 'channel' && type !== 'live') {
        res.json({ metas: [] });
        return;
      }
      const tvClient = isSportsTvClient(req);
      const catalogs = await getSportsCatalogDefinitions({ timeoutMs: tvClient ? 1_500 : 6_000 });
      const requestedCatalogId = String(req.params.id || '').trim();
      const requestedGenre = getCatalogGenreValue(req);
      const useUnifiedCatalog = requestedCatalogId === SPORTS_MAIN_CATALOG_ID || requestedCatalogId === SPORTS_LEGACY_CATALOG_ID;
      const catalog = useUnifiedCatalog
        ? (catalogs.find((entry) => String(entry.name || '').replace(/^Sports Events:\s*/u, '').trim() === requestedGenre)
          || catalogs.find((entry) => entry.id === 'streamed-events-live')
          || catalogs[0])
        : catalogs.find((entry) => entry.id === requestedCatalogId);
      if (!catalog) {
        res.json({ metas: [] });
        return;
      }
      let metas = [];
      try {
        metas = await streamManager.streamedSportsAdapter.getEventCatalog({
          catalog,
          search: getCatalogSearchValue(req),
          skip: getCatalogSkipValue(req),
          limit: tvClient ? 24 : 50,
          signal: AbortSignal.timeout(tvClient ? 3_500 : 6_000)
        });
      } catch (error) {
        logger.warn('nebula sports catalog load failed', {
          catalog: catalog.id,
          tvClient,
          error: error?.message || String(error)
        });
      }
      await sportsSupporterService.increment(account.id, 'catalogs', 1);
      const decoratedMetas = metas.map((meta) => decorateSportsMeta(meta, req));
      if (tvClient) {
        cacheSportsTvMetas(account, decoratedMetas);
      }
      res.setHeader('Cache-Control', 'private, max-age=30').json({ metas: decoratedMetas });
    } catch (error) {
      next(error);
    }
  };

  const sendSportsMeta = async (req, res, next) => {
    try {
      const account = await getSportsAccountFromInstall(req, res);
      if (!account) return;
      const tvClient = isSportsTvClient(req);
      const cachedMeta = tvClient ? getCachedSportsTvMeta(account, req.params.id) : null;
      if (cachedMeta) {
        res.setHeader('Cache-Control', 'private, max-age=30').json({ meta: cachedMeta });
        return;
      }
      let meta = null;
      try {
        meta = await streamManager.streamedSportsAdapter.getEventMeta(req.params.id, AbortSignal.timeout(3_000));
      } catch (error) {
        logger.warn('nebula sports meta fallback used', {
          id: req.params.id,
          error: error?.message || String(error)
        });
      }
      const decoratedMeta = decorateSportsMeta(meta || buildFallbackSportsMeta(req.params.id), req);
      if (tvClient) {
        cacheSportsTvMetas(account, [decoratedMeta]);
      }
      res.setHeader('Cache-Control', 'private, max-age=30').json({ meta: decoratedMeta });
    } catch (error) {
      next(error);
    }
  };

  const sendSportsStreams = async (req, res, next) => {
    try {
      const account = await getSportsAccountFromInstall(req, res);
      if (!account) return;
      const playbackConfigId = await ensureSportsPlaybackConfigId(account);
      const streams = await streamManager.streamedSportsAdapter.getEventStreams(req.params.id, {
        baseUrl: getPublicBaseUrl(req),
        privateConfigId: playbackConfigId,
        signal: req.signal || null
      });
      await sportsSupporterService.increment(account.id, 'streams', 1);
      res.setHeader('Cache-Control', 'no-store').json({ streams });
    } catch (error) {
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

  app.get(['/sports', '/sports/configure'], async (req, res, next) => {
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
  const watchChatPostTimes = new Map();
  let watchChatMessagesByEvent = null;
  let watchChatIdentities = null;
  let watchChatWriteChain = Promise.resolve();
  let watchChatIdentityWriteChain = Promise.resolve();
  const watchChatResponseCache = new Map();
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

  const loadWatchChatMessages = async () => {
    if (watchChatMessagesByEvent && typeof watchChatMessagesByEvent === 'object') return watchChatMessagesByEvent;
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
    } catch {
      watchChatMessagesByEvent = {};
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
        await fsPromises.writeFile(WATCH_CHAT_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
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
      const catalogs = await getSportsCatalogDefinitions({ timeoutMs: 4_000 });
      res
        .setHeader('Cache-Control', 'public, max-age=30')
        .json({ catalogs });
    } catch (error) {
      next(error);
    }
  });

  app.get('/watch-together/api/events', async (req, res, next) => {
    try {
      const catalogs = await getSportsCatalogDefinitions({ timeoutMs: 4_000 });
      const requestedCatalogId = String(req.query.catalog || 'streamed-events-live').trim();
      const catalog = catalogs.find((entry) => entry.id === requestedCatalogId)
        || catalogs.find((entry) => entry.id === 'streamed-events-live')
        || catalogs[0];
      if (!catalog) {
        res.json({ events: [] });
        return;
      }
      const events = await streamManager.streamedSportsAdapter.getEventCatalog({
        catalog,
        search: String(req.query.search || '').trim(),
        skip: Number.parseInt(req.query.skip || '0', 10) || 0,
        limit: 60,
        signal: AbortSignal.timeout(5_000)
      });
      res
        .setHeader('Cache-Control', 'public, max-age=20')
        .json({
          catalog,
          events: events.map((event) => decorateSportsMeta(event, req))
        });
    } catch (error) {
      next(error);
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
          return fallback?.url;
        }));

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
        hlsHeaders
      });
    } catch (error) {
      next(error);
    }
  });

  const renderHelloSportsPlayerPage = ({ source = null, errorMessage = '' } = {}) => {
    const title = source ? `HelloSports #${source.streamNo}` : 'Live Stream';
    const sourceUrl = source?.embedUrl || '';
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
    ${errorMessage ? `<div class="message"><strong>Source unavailable</strong><span>${escapeHtml(errorMessage)}</span></div>` : `<div class="player-crop"><iframe src="${escapeHtml(sourceUrl)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe></div>`}
  </main>
</body>
</html>`;
  };

  app.get('/watch-together/hellosports/:id', async (req, res) => {
    try {
      const source = streamManager.streamedSportsAdapter.getLicensedExternalEmbedSource(req.params.id);
      if (!source) throw new Error('Unknown HelloSports source');
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
  });

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
      const eventId = sanitizeWatchChatEventId(req.query.eventId);
      if (!eventId) {
        res
          .setHeader('Cache-Control', 'no-store')
          .setHeader('X-Nebula-Cache', 'miss')
          .json({ messages: [] });
        return;
      }
      const now = Date.now();
      const cached = watchChatResponseCache.get(eventId);
      if (cached && cached.expiresAt > now) {
        res
          .setHeader('Cache-Control', 'no-store')
          .setHeader('X-Nebula-Cache', 'hit')
          .type('json')
          .send(cached.body);
        return;
      }
      const messages = await getWatchChatMessagesForEvent(eventId);
      const body = JSON.stringify({ messages: messages.slice(-WATCH_CHAT_MAX_MESSAGES) });
      watchChatResponseCache.set(eventId, {
        body,
        expiresAt: now + 1000
      });
      res
        .setHeader('Cache-Control', 'no-store')
        .setHeader('X-Nebula-Cache', 'miss')
        .type('json')
        .send(body);
    } catch (error) {
      next(error);
    }
  });

  app.post('/watch-together/api/chat', async (req, res, next) => {
    try {
      const rateLimitError = checkWatchChatRateLimit(req);
      if (rateLimitError) {
        res.status(429).json({ error: rateLimitError });
        return;
      }
      const submittedName = sanitizeWatchChatText(req.body?.name, 24);
      const text = sanitizeWatchChatText(req.body?.text, 240);
      const eventId = sanitizeWatchChatEventId(req.body?.eventId);
      if (!eventId) {
        res.status(400).json({ error: 'Select an event before chatting.' });
        return;
      }
      if (!submittedName) {
        res.status(400).json({ error: 'Set a username before chatting.' });
        return;
      }
      if (text.length < 1) {
        res.status(400).json({ error: 'Message cannot be empty.' });
        return;
      }
      const identityId = getWatchChatIdentityId(req);
      const identities = await loadWatchChatIdentities();
      const lockedName = identities[identityId];
      if (lockedName && lockedName !== submittedName) {
        res.status(409).json({ error: `Username already locked as ${lockedName}.` });
        return;
      }
      if (!lockedName) {
        identities[identityId] = submittedName;
        watchChatIdentities = identities;
        await persistWatchChatIdentities();
      }
      const messages = await getWatchChatMessagesForEvent(eventId);
      messages.push({
        id: crypto.randomUUID(),
        name: lockedName || submittedName,
        text,
        createdAt: new Date().toISOString()
      });
      watchChatMessagesByEvent[eventId] = messages.slice(-WATCH_CHAT_MAX_MESSAGES);
      await persistWatchChatMessages();
      setWatchChatCookie(req, res, identityId);
      res
        .setHeader('Cache-Control', 'no-store')
        .status(201)
        .json({ messages: watchChatMessagesByEvent[eventId] });
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
        await emailService.sendSportsTrialToken({
          to: created.normalizedEmail || email,
          code: created.code,
          expiresAt: created.expiresAt,
          baseUrl: getPublicBaseUrl(req)
        });
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

  app.post('/sports/signup', async (req, res, next) => {
    try {
      const account = await sportsSupporterService.claimToken({
        username: req.body?.username,
        password: req.body?.password,
        tokenCode: req.body?.tokenCode
      });
      const token = await sportsSupporterService.createSession(account.id);
      setSportsSessionCookie(req, res, token);
      redirectSports(res, { success: 'Sports account created' });
    } catch (error) {
      redirectSports(res, { error: error?.message || 'Signup failed' });
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
      if (!emailService.isConfigured()) {
        res.status(503).json({ ok: false, error: 'Supporter email not configured' });
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
        if (sportsSupporterService.hasPayment(transactionId)) {
          res.status(200).json({ ok: true, duplicate: true, product: 'sports' });
          return;
        }
        const sportsTier = amount >= 3 ? 'lifetime' : 'monthly';
        const created = await sportsSupporterService.createToken({
          label: payload.from_name || email,
          email,
          tier: sportsTier,
          months: sportsTier === 'lifetime' ? 36 : config.KOFI_SUPPORTER_CODE_MONTHS
        });
        await emailService.sendSportsToken({
          to: email,
          name: payload.from_name,
          code: created.code,
          expiresAt: created.expiresAt,
          baseUrl: getPublicBaseUrl(req)
        });
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
