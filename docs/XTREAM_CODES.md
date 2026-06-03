# Xtream Codes IPTV

NebulaStreams supports private Xtream Codes IPTV accounts for Live TV, VOD movies, series, episodes, dynamic categories, and short EPG data.

## Configuration

Open `/configure`, go to `IPTV`, enable `Xtream Codes IPTV`, then enter:

- Server URL, for example `https://example.com:8080`
- Username
- Password

When Xtream is configured, NebulaStreams creates a private manifest at `/private/:privateConfigId/manifest.json`. The default public manifest remains `/manifest.json`.

## Authentication Flow

NebulaStreams authenticates with:

```text
GET /player_api.php?username={username}&password={password}
```

If the provider returns disabled, banned, expired, inactive, missing, or malformed account data, Xtream catalogs return empty results instead of crashing the addon.

## Supported Features

- Live TV categories and streams
- VOD categories and movies
- Series categories and episode metadata
- Short EPG lookup through `get_short_epg` when provider supports it
- Private stream URLs compatible with the existing Stremio response format
- Cached API responses to reduce provider requests
- Retry with exponential backoff for temporary HTTP failures
- Per-server request pacing to avoid hammering IPTV providers

## Stream URLs

Stream cards point to private NebulaStreams URLs:

```text
/private/:privateConfigId/xtream/:kind/:streamId.:extension
```

The playback route redirects to the upstream Xtream stream URL only at play time. Credentials are not placed in the public install URL, stream card URL, logs, or analytics payloads.

## Caching

- Authentication: 5 minutes
- Categories and item lists: 10 minutes
- Series episode details: 30 minutes
- Short EPG: 2 minutes

Restarting the process clears in-memory Xtream cache. Private config files are stored under the server cache directory with mode `0600`.

## Troubleshooting

- `No IPTV catalogs`: check all three fields are filled and the private manifest URL is installed.
- `No streams`: provider may block the server IP, credentials may be inactive, or the Xtream panel may not expose that category.
- `Playback error`: try another channel/movie, check if the provider requires a specific user agent, or verify the same Xtream URL plays in VLC.
- `Timeout`: provider is slow or blocking the backend; NebulaStreams retries temporary failures but keeps route responses isolated.
- `Invalid credentials`: confirm username/password/server URL and account status with your IPTV provider.

## Security Notes

- Do not share private manifest URLs.
- Rotate IPTV credentials if a private manifest URL leaks.
- NebulaStreams intentionally masks credentials from logs and keeps them out of normal configured/public URLs.
