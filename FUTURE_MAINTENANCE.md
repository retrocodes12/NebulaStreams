# Future Maintenance

Date: 2026-05-28

## Weekly Checks

Run:

```bash
git status --short
npm run check:syntax
npm run check:providers
STABILITY_BASE_URL=https://nebula.work.gd npm run check:stability
curl -fsS https://nebula.work.gd/health
pm2 status
```

Then scan:

```bash
pm2 logs nebulastreams --lines 200 --nostream
tail -n 300 /var/log/nginx/access.log
```

Look for repeated `502`, `504`, `unhandled rejection`, `uncaught exception`, `background refresh queue full`, and provider-specific timeout spikes.

## Provider Maintenance

- Do not remove providers to fix stability. Isolate slow/failing providers with timeouts, abort cleanup, stale cache fallback, and health tracking.
- If a provider starts returning malformed streams, fix its normalizer or provider-specific validator.
- If a provider returns valid but unplayable streams, inspect headers, content type, signed URL expiry, and whether Stremio needs direct URL vs registered playback proxy.
- If a new adapter needs credentials, keep it selectable and avoid default auto-run until unauthenticated results are proven reliable.

## Cache Maintenance

- Keep `PROVIDER_MAINTENANCE_INTERVAL_SECONDS=300`.
- Watch stream result memory cache size in `/health`.
- Use Redis before increasing PM2 instances.
- Do not cache empty results from priority providers unless the search completed fully.

## Crash Recovery

- PM2 should run with `max_memory_restart: 900M`.
- App memory guard should restart only at `MEMORY_GUARD_RESTART_PERCENT=95`.
- Keep `MEMORY_GUARD_PRESSURE_PERCENT=45` and `MEMORY_GUARD_CRITICAL_PERCENT=60` for cache pruning/load shedding before restart.
- On repeated restarts, check RSS growth, hub cache size, stream result cache size, and open provider in-flight counts.

## Recommended Deploy Flow

```bash
npm run check:syntax
STABILITY_BASE_URL=https://nebula.work.gd npm run check:stability
pm2 restart nebulastreams --max-memory-restart 900M --update-env
pm2 save
curl -fsS https://nebula.work.gd/health
```

For zero-downtime deploys, move to:

```bash
pm2 start ecosystem.config.cjs -i 2
pm2 reload nebulastreams --update-env
```

Only do this after enabling Redis-backed stream result cache, otherwise cache behavior will differ between workers.

## New Provider Checklist

- Add adapter/provider wiring.
- Add provider timeout overrides if upstream is known slow.
- Add provider to health/ranking only after a live smoke test.
- Decide whether it is default auto-run or explicit-only.
- Add normalizer coverage for headers, HLS, DDL, magnets, file size, archive filtering, and quality labels.
- Run provider sanity and stability harness.

