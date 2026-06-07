# Supporter System

NebulaStreams supporter perks must never gate providers, stream quality, stream count, or core playback.

## Storage

Supporter data lives in `cache/supporters.json`.

Top-level collections:

- `codes`: supporter code hash records
- `payments`: Ko-fi transaction idempotency records
- `accounts`: supporter account records
- `usernames`: username to account id map
- `sessions`: supporter dashboard session hashes

Raw supporter codes are shown or emailed once. Codes and session tokens are stored as hashes.

## Auth

No passwords.

Flow:

1. User enters supporter code.
2. `SupporterService.authenticateCode()` validates active, unexpired, non-revoked code.
3. Account is created or loaded by code hash.
4. Dashboard session cookie `nebulastreams_supporter` is created.

## Routes

- `GET /dashboard`: dashboard login or account page
- `POST /supporter/login`: login with code
- `POST /supporter/logout`: clear session
- `POST /dashboard/settings`: username, display name, theme, wall privacy
- `POST /dashboard/profiles/create`: import profile JSON
- `POST /dashboard/profiles/delete`: delete profile
- `POST /dashboard/profiles/default`: use profile for short URL
- `POST /dashboard/backups/create`: create backup JSON
- `POST /dashboard/backups/restore`: restore backup into a new default profile
- `POST /dashboard/delete-account`: delete dashboard account data
- `GET /dashboard/export.json`: export account profiles and backups
- `POST /configure/supporter-profile`: save current config page settings to cloud profile
- GET /dashboard/early-access.json: supporter feature flags
- GET /u/:username: short URL redirect and install counter
- GET /u/:username/manifest.json: generate private manifest from default saved profile
- GET /u/:username/:profileId/manifest.json: generate private manifest from a specific saved profile

## Ko-fi

Webhook route: `POST /webhooks/kofi`

Behavior:

- Verifies Ko-fi `verification_token`.
- Ignores payments below `KOFI_MIN_AMOUNT`.
- `$1+` creates `supporter` tier.
- `$10+` creates `founder` tier with lifetime status.
- Creates supporter account, code, payment record.
- Emails code through SMTP.
- Duplicate transaction ids do not create duplicate codes.

## Perks

Free users keep all streams and providers.

Supporters get:

- Dashboard
- Badges
- Cloud profiles
- Config backups
- Short install URLs
- Theme preference applied to dashboard: Nebula Purple, AMOLED Black, Cyber Green, Aurora, Synthwave
- Supporter wall visibility control
- Early access feature flag API
- Priority support contact action
- Export data

## Future

- Add magic email links if SMTP deliverability is stable.

## Perk Verification Notes

- Canceled/inactive accounts cannot keep using old supporter codes.
- Saved profile Install links use profile-specific short URLs.
- /u/:username increments install stats; manifest generation increments manifest stats.
- Backups restore into a new default profile.
