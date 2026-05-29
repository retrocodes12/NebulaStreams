# NebulaStreams Performance Report

Date: 2026-05-28

## Current Runtime Profile

- Live health after restart:
  - RSS: about 226 MB during smoke checks.
  - Heap usage: about 79 MB.
  - Total memory usage: about 47%.
  - Stream result cache entries: 8 after fresh restart.
  - HubCloud cache entries: 28 after smoke checks.
- Active daily usage remains high. Health reported over 2,000 active users in 24h at test time.

## Aggregation Changes

- Default provider search now considers a broader provider set within the same deadline instead of stopping after a small primary slice.
- Early return now requires more useful evidence by default:
  - `STREMIO_FAST_EARLY_RETURN_STREAMS=3`
  - `STREMIO_FAST_MIN_COMPLETED_PROVIDERS=3`
- Empty searches continue closer to the deadline, improving first-search coverage.
- Premium/high-quality providers still get grace windows, but no hard global delay was added.
- PStream direct provider is not in default auto-run because live tests showed 200/empty and slow public sources.

## Cache/Warmup Changes

- Background refresh queue default increased from 10 to 100.
- Background refreshes are queued and retried when provider load is temporarily high.
- Stale queued refreshes are pruned automatically.
- Provider result cache, fast-result cache, and in-memory metadata caches are cleaned on an interval.
- Last-good and stale stream fallbacks remain active for deadline and error paths.

## Recommended Timeout/Concurrency Settings

Use the defaults in `ecosystem.config.cjs` unless the EC2 instance changes size.

- `PROVIDER_GLOBAL_MAX_INFLIGHT=16`
- `PROVIDER_MAX_CONCURRENCY=4`
- `PROVIDER_HOST_MAX_INFLIGHT=3`
- `PROVIDER_FETCH_REQUEST_TIMEOUT_MS=18000`
- `STREMIO_FAST_PROVIDER_CONCURRENCY=5`
- `STREMIO_FAST_PROVIDER_LIMIT=50`
- `STREMIO_FAST_STREAM_LIMIT=100`
- `STREMIO_FAST_MAX_WAIT_MS=13000`
- `STREMIO_STREAM_OVERALL_TIMEOUT_MS=19000`
- AIOStreams clients are handled in code with a longer 28.5s route timeout and 27s soft deadline.
- `STREMIO_BACKGROUND_REFRESH_CONCURRENCY=2`
- `STREMIO_BACKGROUND_REFRESH_QUEUE_MAX=100`
- `STREMIO_BACKGROUND_REFRESH_MAX_PROVIDER_EXECUTIONS=8`

## EC2 Recommendations

- Run Node.js 20+.
- Keep at least 4 GB RAM for current provider count.
- Keep PM2 memory restart at `900M` and app memory guard restart at `95%`.
- Put Nginx in front with:
  - `proxy_connect_timeout 10s`
  - `proxy_send_timeout 75s`
  - `proxy_read_timeout 75s`
  - `send_timeout 75s`
  - `proxy_http_version 1.1`
  - `proxy_set_header Connection ""`
- For true zero-downtime restarts, move to PM2 cluster mode with at least 2 instances and Redis-backed stream result cache.

## Recommended PM2

Use:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

For the current single-process deployment:

```bash
pm2 restart nebulastreams --max-memory-restart 900M --update-env
pm2 save
```

Single-process restarts can still cause a short 502 window. Cluster mode is required to avoid that fully.

