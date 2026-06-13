# Stalker Portal MAG IPTV

NebulaStreams supports private Stalker Portal / MAG IPTV accounts for Live TV catalogs, channel browsing, EPG metadata, and playback link generation.

## Configuration

Open `/configure`, go to `IPTV`, enable `Stalker / MAG Portal`, then enter:

- Stalker Portal URL, usually ending in `/c/`
- MAC Address, for example `00:1A:79:00:00:00`
- STB Type, for example `MAG250`, `MAG254`, or `MAG270`
- Optional serial number
- Optional `device_id`
- Optional `device_id2`
- Category Start and Category Catalogs when the portal has more categories than Stremio can fit in one manifest

When Stalker is configured, NebulaStreams creates a private manifest at:

```text
/private/:privateConfigId/manifest.json
```

The default public manifest remains `/manifest.json`.

## Authentication Flow

NebulaStreams emulates a MAG device and calls the Stalker portal API at:

```text
/server/load.php
```

Supported flow:

- `type=stb&action=handshake`
- `type=stb&action=get_profile`
- `type=account_info&action=get_main_info`
- `type=itv&action=get_genres`
- `type=itv&action=get_all_channels`
- `type=itv&action=create_link`

The adapter sends MAG-style headers, including MAG user agent, referrer, MAC cookie, timezone, and bearer token after handshake.
If device fields are blank, NebulaStreams generates stable private values from the portal/MAC config.

## Supported Features

- Live TV category catalogs
- Category window controls for large portals. Example: start `0`, `40`, `80`, `120` to page through hundreds of portal categories.
- Channel listing and search
- Per-channel Stremio metadata
- Short EPG when the portal exposes it
- Playback link generation through `create_link`
- Token cache and automatic token refresh
- API response cache to reduce portal traffic
- Retry/backoff for temporary network or portal errors

## Stream URLs

Stream cards point to private NebulaStreams URLs:

```text
/private/:privateConfigId/stalker/live/:channelId.ts
```

At playback time NebulaStreams calls `create_link` and redirects to the generated upstream stream URL.

## Security Notes

- Do not share private manifest URLs.
- MAC address and portal URL are stored only in private config.
- NebulaStreams does not place the MAC address in public install URLs or stream card URLs.
- Logs avoid MAC and portal credentials.

## Troubleshooting

- `No catalogs`: portal URL may be wrong, MAC may be invalid, portal may block the server IP, or subscription may be expired.
- `No streams`: channel command may be missing or portal may reject `create_link`.
- `Playback error`: test the generated channel in the original MAG/IPTV app; some portals restrict playback by IP, token, or device fingerprint.
- `Timeout`: portal is slow/offline or blocking backend traffic.
- `Invalid response`: portal may return HTML, anti-bot pages, or a non-standard Stalker fork.
