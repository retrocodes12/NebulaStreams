import { performance } from 'node:perf_hooks';

const BASE_URL = String(process.env.STABILITY_BASE_URL || 'https://nebula.work.gd').replace(/\/+$/u, '');
const TIMEOUT_MS = Number(process.env.STABILITY_TIMEOUT_MS || 35_000);
const CONCURRENCY = Number(process.env.STABILITY_CONCURRENCY || 8);
const REQUESTS = Number(process.env.STABILITY_REQUESTS || 16);
const USER_AGENT = process.env.STABILITY_USER_AGENT || 'AIOStreams/2.30.2 NebulaStabilityHarness/1.0';

const targets = [
  { name: 'health', path: '/health', expectJson: true },
  { name: 'manifest', path: '/manifest.json', expectJson: true },
  { name: 'movie-stream', path: '/stream/movie/tt1375666.json', expectJson: true, streamResponse: true },
  { name: 'series-stream', path: '/stream/series/tt0944947:1:1.json', expectJson: true, streamResponse: true },
  { name: 'malformed-series-fallback', path: '/stream/series/tt1147517.json', expectJson: true, streamResponse: true },
  { name: 'pstream-provider', path: '/providers/pstream/streams?tmdbId=27205&mediaType=movie', expectJson: true, providerResponse: true }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithTimeout = async (target) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetch(`${BASE_URL}${target.path}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      }
    });
    const text = await response.text();
    let json = null;

    if (target.expectJson) {
      try {
        json = text ? JSON.parse(text) : null;
      } catch (error) {
        throw new Error(`invalid JSON: ${error.message}`);
      }
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const streamCount = target.streamResponse
      ? (Array.isArray(json?.streams) ? json.streams.length : 0)
      : (target.providerResponse ? Number(json?.count ?? json?.streams?.length ?? 0) : null);

    return {
      name: target.name,
      status: response.status,
      ok: response.ok && response.status < 500,
      durationMs,
      streamCount,
      bytes: text.length
    };
  } finally {
    clearTimeout(timeout);
  }
};

const runConcurrent = async () => {
  const queue = Array.from({ length: REQUESTS }, (_, index) => ({
    ...targets[index % targets.length],
    name: `load-${index + 1}-${targets[index % targets.length].name}`
  }));
  const results = [];

  const worker = async () => {
    while (queue.length > 0) {
      const target = queue.shift();

      try {
        results.push(await fetchWithTimeout(target));
      } catch (error) {
        results.push({
          name: target.name,
          ok: false,
          error: error?.message || String(error)
        });
      }

      await sleep(25);
    }
  };

  await Promise.allSettled(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker()));
  return results;
};

const main = async () => {
  const singleResults = [];

  for (const target of targets) {
    try {
      singleResults.push(await fetchWithTimeout(target));
    } catch (error) {
      singleResults.push({
        name: target.name,
        ok: false,
        error: error?.message || String(error)
      });
    }
  }

  const loadResults = await runConcurrent();
  const allResults = [...singleResults, ...loadResults];
  const failures = allResults.filter((result) => !result.ok);
  const summary = {
    baseUrl: BASE_URL,
    total: allResults.length,
    failures: failures.length,
    minDurationMs: Math.min(...allResults.map((result) => result.durationMs || 0)),
    maxDurationMs: Math.max(...allResults.map((result) => result.durationMs || 0)),
    streamResponses: allResults
      .filter((result) => result.streamCount !== null && result.streamCount !== undefined)
      .map((result) => ({
        name: result.name,
        status: result.status,
        streamCount: result.streamCount,
        durationMs: result.durationMs
      }))
  };

  console.log(JSON.stringify({ summary, results: allResults }, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
