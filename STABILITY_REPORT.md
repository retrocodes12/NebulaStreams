# NebulaStreams Stability Report

Date: 2026-05-28

## Root Cause Summary

- Stream searches were bounded, but the default fast path could stop after a small empty primary wait. Under load this produced empty/weak first responses while better providers were still running.
- Background refreshes were dropped when the refresh queue filled or provider load was briefly high. That made warm-cache behavior inconsistent and caused repeated searches to look better than first searches.
- Provider fetches were mostly isolated, but abort-scoped provider executions could be shared through the in-flight cache. A client abort could poison unrelated requests for the same provider/search key.
- Provider maintenance was one-shot at startup. Expired disk cache, cooldown state, and in-memory provider metadata could accumulate during long uptime.
- Logging accepted large raw strings/objects. Signed URLs, stacks, and provider payloads could bloat logs and memory during upstream failures.
- Shutdown cancellation was logged like a real provider failure, making restart windows look worse than they were.
- PStream has no reliable public Stremio-style API. It can be wrapped through the existing PStream provider package, but several public sources are token-required or slow.

## Fixes Applied

- Added direct `pstream` provider adapter using the existing PStream provider package, separate from `pstream-plugin`.
- Kept PStream selectable, but excluded it from default auto-run and skipped token-required PStream sources unless explicitly selected.
- Increased default aggregation quality gate: default searches now wait for more completed providers/streams before early return.
- Expanded the default fast-search candidate set from a small primary slice to a larger deadline-bounded provider set.
- Removed the early empty-primary stop except near deadline, so no-result first searches get more provider coverage.
- Changed background refresh from drop-on-load to queued retry with stale cleanup and wake timers.
- Increased background refresh defaults safely: queue `100`, concurrency `2`, provider execution ceiling `8`.
- Added provider maintenance interval cleanup for provider result cache, fast result cache, cooldown maps, TMDB metadata, and memory caches.
- Added startup provider validation for core providers including `nuvio`, `nuvio-2`, `4khdhub`, `hdhub4u`, `moviebox`, `vidlink`, `cinestream`, and `pstream`.
- Added provider runtime metrics for duration, stream count, last success, and last failure.
- Fixed abort-scoped provider in-flight sharing so request-level aborts do not cancel unrelated provider users.
- Added safe shutdown cleanup for ProviderService and its undici dispatcher.
- Hardened logger sanitization: redacts sensitive keys, truncates huge strings/stacks, caps arrays/objects, and handles circular payloads.
- Downgraded expected shutdown cancellations from error to info.
- Added `scripts/providerSanityCheck.js`.
- Added `scripts/stabilityHarness.js`.
- Added `ecosystem.config.cjs` as the recommended PM2 baseline.

## Live Verification

- `npm run check:syntax`: passed.
- `npm run check:providers`: passed; `vidlink` and `cinestream` returned streams; `pstream` returned 200/empty for Inception.
- Live smoke:
  - `/health`: 200.
  - `/manifest.json`: 200.
  - `/stream/movie/tt1375666.json`: 86+ streams.
  - `/stream/series/tt0944947:1:1.json`: 23 streams.
  - `/providers/hdhub4u/streams?tmdbId=1316092&mediaType=movie`: 8 streams with 4K entries.
  - `/providers/4khdhub/streams?tmdbId=1316092&mediaType=movie`: 200.
- Stability harness:
  - 24 requests.
  - 0 failures.
  - 0 5xx responses.
  - Cached movie/series routes returned within milliseconds.

## Production Notes

- The 502s seen around `08:30:26 UTC` happened during PM2 restart while the process was being replaced. After the restart completed, health/config/manifest/stream routes returned 200.
- Some providers still return upstream 404/429/timeout/no-match. These are isolated and should not crash aggregation.
- Direct PStream is available but should be treated as optional until a usable public token/session strategy exists.

