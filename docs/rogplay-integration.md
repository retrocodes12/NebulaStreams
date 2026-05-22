# RogPlay Adapter Integration

NebulaStreams integrates RogPlay as an external provider ecosystem through wrappers only. The RogPlay repository is not merged into this codebase.

## Provider Groups

- `rogplay-vod`: movie and series streams from RogPlay cinema server manifests.
- `rogplay-live`: Live TV/IPTV catalog and stream handling. This group is exposed through Stremio TV catalogs, not default movie/series scraping.

## Files

- `providers/rogplay/RogPlayAdapter.js`: fetches RogPlay manifests, parses JSON/M3U playlists, normalizes VOD and live streams.
- `src/registry/pluginProviderRegistry.js`: registers `rogplay-vod` and `rogplay-live`.
- `services/streamManager.js`: exposes RogPlay live catalogs and live stream lookup.
- `index.js`: adds Stremio catalog routes.

## Live Catalogs

Manifest includes these TV catalogs:

- `rogplay-live-sports` -> Sports Channels
- `rogplay-live-news` -> News Channels
- `rogplay-live-regional` -> Regional Channels
- `rogplay-live-entertainment` -> Entertainment Channels
- `rogplay-live-all` -> All Live Channels
- `rogplay-live-source-*` -> source-specific channel catalogs, such as Sony LIV, CricHD, YuppTV, DistroTV.

Example:

```text
GET /catalog/tv/rogplay-live-sports.json
GET /meta/tv/rogplay:<channel-id>.json
GET /stream/tv/rogplay:<channel-id>.json
```

## VOD Usage

Use `rogplay-vod` as a normal configured provider:

```text
GET /stream/movie/tmdb:603.json?providers=rogplay-vod
GET /stream/series/tmdb:93740:3:4.json?providers=rogplay-vod
```

RogPlay VOD endpoints are called with `Promise.allSettled`, so broken endpoints do not crash aggregation.

## Live Stream Handling

Live channels support:

- `.m3u8` HLS URLs
- direct IPTV URLs
- per-channel request headers
- health probing before playback
- duplicate-channel fallback by normalized title

Live channel metadata is cached for 30 minutes. VOD manifests are cached for 6 hours.
