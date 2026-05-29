# Known Edge Cases

Date: 2026-05-28

## Upstream Provider Behavior

- PStream public sources can return no streams, require user tokens, or time out. Nebula keeps PStream selectable but does not rely on it by default.
- Vidlink sometimes returns playlist URLs that later 404. Nebula isolates the failure and does not cache empty results for priority sources.
- NetMirror can fail cookie extraction. This is upstream/session behavior and should remain isolated.
- Hub providers can hit link shortener 429s. These are logged compactly and should not crash aggregation.
- Some Nuvio French plugins time out or report content not found. These remain isolated through plugin-level failure handling.
- Some providers return mismatched TV/episode files. The TV title guard and invalid stream filter drop those.

## Client Behavior

- AIOStreams timeout set to 30s is supported with a 28.5s server timeout and 27s soft deadline.
- Some Stremio/Nuvio clients disconnect before Nebula finishes a slow search. These appear as nginx `499` and are client-side aborts, not server crashes.
- Malformed series IDs return `200` with empty streams instead of crashing the route.
- Old installed manifests may still request removed/hidden live TV catalogs until the client refreshes. Those routes return safe empty catalog responses.

## Deployment Edge Cases

- PM2 fork-mode restart has a short downtime window. Nginx can show 502 while the process is being replaced.
- True zero-downtime deploys need PM2 cluster mode or another blue/green process manager.
- If Redis is not enabled, each process has its own in-memory stream result cache.
- Cloudflare/proxy timeout settings must be greater than Nebula's route timeout or clients will see fetch failures first.

## Stream Playback Edge Cases

- Direct DDL/HLS streams may require headers or a player that supports the codec/container.
- Proxied playback can still fail if the upstream host returns 502/504 after all retries.
- Huge `.zip`, archive, or non-video links should be filtered as invalid or non-web-ready; new provider regressions should be added to normalization tests.
- Signed URLs can expire. Nebula caps cache TTL for signed stream URLs when expiry tokens are visible.

