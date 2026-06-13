# NebulaStreams Backend Handoff

Use this file on the EC2 backend server. Work from the real repo path, likely:

```bash
cd ~/NebulaStreams
```

## Goal

Make live backend `https://nebula.work.gd` stable and stream-rich:

- ShowBox must not return stale `404 Not Found` playback links.
- `hdhub4u` and `4khdhub` must return streams without nginx `502/504`.
- CineStream should aggregate many working local providers.
- Provider failures should not spam huge stacks/log payloads.
- Process should restart only when memory usage reaches `95%`.

## First Checks

Run:

```bash
git status --short
pm2 status
pm2 logs nebulastreams --lines 250
curl -i https://nebula.work.gd/health
```

If code changes are present but not live:

```bash
pm2 restart nebulastreams --update-env
pm2 logs nebulastreams --lines 100
```

## Known Live Symptoms

Recent logs showed:

- `Kisskh Error: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
- `fast provider search returning partial results before slow providers finished`
- `Castle timed out`
- `vixsrc timed out` stack traces
- direct `hdhub4u` / `4khdhub` endpoint could hit nginx `502/504`
- `Vidlink` dumped huge full API JSON responses
- HubCloud failures logged huge signed URLs and stack traces

Some partial-return logs are okay if stream count is high. Bad case is returning only 1 stream while CineStream/Hub providers finish seconds later.

## Fixes Expected In Code

Confirm these are present. If missing, implement them.

### ShowBox stale 404

In `services/streamManager.js`:

- Stremio result cache key version should be bumped.
- Source token TTL should respect signed URL params:
  - `token`
  - `KEY2`
  - `expires`
  - `expire`
  - `exp`
- ShowBox source tokens should be capped around 5 minutes, not 6 hours.

Verify:

```bash
curl -fsS 'https://nebula.work.gd/stream/movie/tmdb:1413196.json' -o /tmp/showbox.json
node -e "const j=require('/tmp/showbox.json'); console.log(j.streams?.length, j.streams?.[0]?.url)"
```

Then `curl -I -r 0-1023 '<stream-url>'` should show `206 Partial Content`, not `404`.

### Hub providers timeout

In `services/providerService.js`:

- `hdhub4u`, `4khdhub`, and `4khdhub_tv` should use fast timeout caps even if explicitly selected.
- Per-fetch timeout for those should be around `18_000ms`.
- Parallel timeout should be around `22_000ms`.

In `services/streamManager.js`:

- `/providers/:provider/streams` should call provider service with `priorityRequest: true` and `enforceFastTimeout: true`.
- Direct provider normalization should have timeout fallback, so HubCloud resolution cannot make nginx return `502/504`.

Verify:

```bash
curl -fsS 'https://nebula.work.gd/providers/hdhub4u/streams?tmdbId=1316092&mediaType=movie' | head -c 500
curl -fsS 'https://nebula.work.gd/providers/4khdhub/streams?tmdbId=1316092&mediaType=movie' | head -c 500
```

Expected: JSON with `count > 0`, not nginx HTML.

### CineStream provider fanout

In `vendor/HTTP/providers/cinestream.js`, CineStream should fan out to local providers:

```text
vidlink, videasy, moviebox, streamflix, fmovies, playimdb, playimdb_v2,
multivid, vidsrc, vixsrc, netmirror, onetouchtv
```

Each source group should be timeout bounded, so slow sources do not block whole CineStream.

Verify:

```bash
curl -fsS 'https://nebula.work.gd/stream/movie/tmdb:1316092.json?providers=cinestream' | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);console.log(j.streams?.length,j.streams?.[0]?.name)})"
```

Expected: many streams, not zero.

### KissKH JSON safety

In `vendor/HTTP/providers/kisskh.js`:

- Do not call `response.json()` blindly.
- Read text first.
- If response is HTML or non-JSON, log short `KissKH skipped: ...` and return `[]`.
- No `Unexpected token '<'` stack.

Verify:

```bash
curl -fsS 'https://nebula.work.gd/providers/kisskh/streams?tmdbId=212204&mediaType=tv&season=1&episode=1' | head -c 500
```

### Fast search quality

In `services/providerService.js`:

- Fast search should wait for `cinestream` if it is in the primary provider set.
- When returning partial results, abort pending provider controllers.
- Partial results with `resultCount > 0` should log as `info`, not `warn`.
- Timeout abort reason sent into provider internals should be cancellation, to reduce scary stack traces.

Verify logged case:

```bash
curl -fsS 'https://nebula.work.gd/stream/series/tmdb:76479:5:6.json' -o /tmp/boys.json
node -e "const j=require('/tmp/boys.json'); console.log(j.streams?.length, j.streams?.slice(0,5).map(s=>s.name))"
```

Expected: dozens of streams, not only 1 `vixsrc` stream.

### Log spam cleanup

In `vendor/HTTP/providers/vidlink.js`:

- Do not log full `JSON.stringify(data, null, 2)`.
- Log compact summary only.

In `services/streamManager.js` HubCloud catch:

- Do not log full signed `streamUrl`.
- Do not log full stack object.
- Log `streamHost`, `errorName`, `errorMessage`, `statusCode`.

### Memory restart

Restart only when memory usage reaches `95%`.

In `config.js`:

```js
MEMORY_GUARD_RESTART_PERCENT default should be 95
```

In `index.js`:

```js
const restartRequired = usagePercent >= config.MEMORY_GUARD_RESTART_PERCENT;
```

Do not restart due only to `criticalStrikes` or `MIN_AVAILABLE_MB`.

In deploy/env config:

```text
MEMORY_GUARD_RESTART_PERCENT=95
```

## Verification Commands

Run after changes:

```bash
npm run check:syntax
pm2 restart nebulastreams --update-env
sleep 5
curl -i https://nebula.work.gd/health
curl -fsS 'https://nebula.work.gd/stream/series/tmdb:76479:5:6.json' -o /tmp/boys.json
node -e "const j=require('/tmp/boys.json'); console.log('streams', j.streams?.length)"
curl -fsS 'https://nebula.work.gd/providers/hdhub4u/streams?tmdbId=1316092&mediaType=movie' -o /tmp/hdhub4u.json
node -e "const j=require('/tmp/hdhub4u.json'); console.log('hdhub4u', j.count || j.streams?.length)"
curl -fsS 'https://nebula.work.gd/providers/4khdhub/streams?tmdbId=1316092&mediaType=movie' -o /tmp/4khdhub.json
node -e "const j=require('/tmp/4khdhub.json'); console.log('4khdhub', j.count || j.streams?.length)"
pm2 logs nebulastreams --lines 150
```

## Expected Good Results

- `tmdb:76479:5:6` returns many streams, previously tested locally around `40+`.
- `hdhub4u` Wuthering Heights returns `count > 0`.
- `4khdhub` Wuthering Heights returns `count > 0`.
- KissKH does not throw JSON parse stack.
- No nginx `502/504` for direct provider routes.
- No giant Vidlink API dumps.
- No giant HubCloud signed URLs in logs.

## Notes

- `Castle timed out` can be normal if upstream is slow.
- `MovieBox No streams from worker` can be normal for missing titles.
- `fast provider search returning partial results` is not automatically bad; bad only when result count is tiny and better providers finish shortly after.

## Current Production State - 2026-06-04

This section records recent verified state so future agents do not hallucinate after compaction.

### Live process

- Repo path: `/home/ubuntu/NebulaStreams`.
- Public base URL: `https://nebula.work.gd`.
- PM2 app name: `nebulastreams`.
- PM2 mode is now `cluster`, not single fork.
- Current PM2 state checked 2026-06-04:
  - worker id `2`: `nebulastreams`, cluster, online, pid `2729516`, uptime about 2h, memory about `707 MB`.
  - worker id `3`: `nebulastreams`, cluster, online, pid `2733251`, uptime about 43m, memory about `613 MB`.
  - `uptime-kuma` remains separate fork process, online.
- `ecosystem.config.cjs` should keep:
  - `instances: 2`
  - `exec_mode: 'cluster'`
  - `max_memory_restart: '900M'`
  - `MEMORY_GUARD_PRESSURE_PERCENT: '72'`
  - `MEMORY_GUARD_CRITICAL_PERCENT: '84'`
  - `MEMORY_GUARD_RESTART_PERCENT: '95'`
- Reason for 2 workers: heavy provider/plugin execution can pin one Node event loop. Cluster lets cheap routes like `/manifest.json`, `/configure`, and `/health` still respond from the other worker.
- Do not switch back to single fork unless replacing in-process plugin execution with worker threads/process isolation.

### Current git status

As checked 2026-06-04:

```text
 M .gitignore
 M services/scrapling_service/server.py
```

No other files were dirty at that check. Treat those as existing/user/live changes. Do not revert unless user explicitly asks.

### Important stability fixes already made

- Standalone Stremio flow had a load bug:
  - On cache miss it started a full background refresh before standalone fast-pass.
  - Then, if fast-pass returned no streams, route also ran a full build.
  - Result: duplicate provider work per request, refresh queue growth, timer starvation, 502/fetch-failed symptoms.
- Fix:
  - Removed immediate full background refresh before standalone fast-pass.
  - Schedule full background refresh only when standalone fast-pass returns non-empty streams and response is sent.
  - If fast-pass is empty/timed out, route continues into the normal full build without extra duplicate background build.
- Series partial/empty results had another load bug:
  - Code scheduled delayed full refreshes at `8s`, `24s`, and `34s`.
  - Repeated user searches multiplied refresh timers and queue entries.
- Fix:
  - Added `stremioDelayedRefreshTimers` map in `services/streamManager.js`.
  - Added `scheduleDelayedStremioBackgroundRefresh(input, 8_000)`.
  - Delayed refreshes are coalesced by `resultCacheKey`; only earliest/active timer per title survives.
  - `close()` and `enableLoadShedding()` clear these timers.
  - `getStats()` exposes `stremioDelayedRefreshTimers`.
- Fast-pass abort bug:
  - Previous code aborted the standalone fast-pass controller with message `Standalone fast-pass finished`.
  - That abort could poison shared provider/fetch work and cause route fallback errors.
- Fix:
  - Removed separate fast-pass abort controller from the soft-timeout path.
  - Fast-pass soft timeout now returns a sentinel only; provider-level deadlines/client-close still clean work.
  - After this, repeated public stream smoke returned HTTP 200 with 40 streams.

### Verified behavior after fixes

Run/verify examples:

```bash
curl -sS --max-time 32 -H 'User-Agent: Stremio/4.4' \
  -o /tmp/nebula-public-final.json \
  -w 'stream HTTP=%{http_code} TIME=%{time_total} SIZE=%{size_download}\n' \
  https://nebula.work.gd/stream/movie/tt35672862.json
jq '{streams:(.streams|length)}' /tmp/nebula-public-final.json
```

Observed after fixes:

```text
stream HTTP=200 TIME=9.738440 SIZE=51351
{ "streams": 40 }
```

Manifest/config responsiveness under provider CPU load:

```bash
for i in 1 2 3 4; do
  curl -sS --max-time 8 -o /dev/null -w 'manifest HTTP=%{http_code} TIME=%{time_total}\n' \
    https://nebula.work.gd/manifest.json
done
curl -sS --max-time 8 -o /dev/null -w 'configure HTTP=%{http_code} TIME=%{time_total}\n' \
  https://nebula.work.gd/configure
```

Observed after cluster:

```text
manifest HTTP=200 TIME=0.106959
manifest HTTP=200 TIME=0.039215
manifest HTTP=200 TIME=0.038900
manifest HTTP=200 TIME=0.028350
configure HTTP=200 TIME=0.085913
```

Before cluster, public manifest could time out at 15s while one worker was CPU-bound.

### Logs after fixes

Good fresh-log signs:

- No fresh `fetch failed`.
- No fresh `502` / `Bad Gateway`.
- No fresh `stremio stream route failed` from `Standalone fast-pass finished`.
- No fresh `stale stremio background refreshes pruned`.
- Background queue should usually stay small/zero:
  - `stremioBackgroundRefreshQueued: 0`
  - `stremioBackgroundRefreshTracked: 0` or very small
  - `stremioDelayedRefreshTimers: 0` or small

Expected external provider noise that should not crash app:

- `NetMirror Error: Failed to extract t_hash_t cookie`
- `Vidlink HTTP 403` / `Unexpected end of JSON input`
- `AnimeUnity HTTP 403 Forbidden`
- `provider returned invalid streams`
- `fast provider search returning partial results before slow providers finished`
- individual provider parallel timeouts

These are provider/upstream failures unless they become app-level route failures, queue explosions, or 502s.

### Current health expectations

With 2 cluster workers, whole-system memory baseline is higher. Do not use old `45/60` memory guard thresholds because they would trigger false load shedding.

Expected current local health shape:

```json
{
  "status": "ok",
  "streams": {
    "stremioResultInFlight": 0,
    "stremioBackgroundRefreshQueued": 0,
    "stremioBackgroundRefreshTracked": 0,
    "stremioDelayedRefreshTimers": 0
  },
  "memory": {
    "guardPressurePercent": 72,
    "guardCriticalPercent": 84
  }
}
```

`stremioResultInFlight`, delayed timers, and hub in-flight can be nonzero during live traffic, but they should drain. If queues grow and stay high, inspect duplicate refresh scheduling again.

### IPTV / live TV status

Current codebase includes Xtream, Stalker, and Famelack work from recent sessions.

- Xtream:
  - Adapter: `src/adapters/XtreamCodesAdapter.js`.
  - Tests: `scripts/xtreamAdapterTest.js`.
  - Docs: `docs/XTREAM_CODES.md`.
  - Config validator route exists through config page flow.
  - Supports live/VOD/series catalogs and generated stream URLs.
- Stalker:
  - Adapter: `src/adapters/StalkerPortalAdapter.js`.
  - Tests: `scripts/stalkerAdapterTest.js`.
  - Docs: `docs/STALKER_PORTAL.md`.
  - Supports portal URL, MAC, optional STB type, serial, device id, device id2.
  - Playback uses MAG-like headers and proxy/playlist rewrite fallback.
  - If user reports all Stalker channels playback-error but auth/catalog works, likely upstream/provider/IP/header behavior; inspect logs before assuming Nebula route bug.
- Famelack:
  - Adapter: `src/adapters/FamelackLiveAdapter.js`.
  - Toggle is below Stalker config fields.
  - Public live TV only when toggle enabled.
- Old RogPlay/German live catalogs were intentionally removed/hidden from normal live TV catalog surface earlier; user wanted TV section size reduced to Xtream/Stalker and optional Famelack.

### Adapter/plugin ecosystem notes

NebulaStreams has multiple adapter ecosystems:

- Nuvio default and Nuvio 2.
- Nuvio language adapters: Latino, French, Italian.
- R2/R4/R5/R-stream plugin style adapters from earlier work.
- PStream/plugin attempts.
- Cloudstream/CS related providers were not left as bridge service; user wanted direct provider/plugin-style integration instead.

Known architectural risk:

- `src/adapters/NuvioPluginAdapter.js` uses `vm.runInNewContext` and executes plugin JS in the main Node worker.
- Plugin execution/fetch chains can still be CPU-heavy or synchronous enough to block that worker.
- PM2 cluster mitigates route starvation, but best future fix is worker-thread/process isolation for plugin execution.

Do not reduce provider count/stream count just to hide timeouts. User repeatedly requested all providers and high stream density preserved.

### Test commands

Run before production reload after code edits:

```bash
npm run check:syntax
npm run check:stalker
npm run check:xtream
```

Production reload with current cluster config:

```bash
pm2 reload ecosystem.config.cjs --only nebulastreams --update-env
pm2 save
pm2 status
```

If PM2 mode must change between fork/cluster, `reload` may not apply mode changes. Use delete/start only when necessary:

```bash
pm2 delete nebulastreams
pm2 start ecosystem.config.cjs --only nebulastreams --update-env
pm2 save
```

### Debug commands

Use these first for timeout/fetch-failed reports:

```bash
pm2 status
pm2 logs nebulastreams --lines 250 --nostream
curl -fsS --max-time 10 http://127.0.0.1:3000/health | jq '{status,streams,memory}'
curl -sS --max-time 8 -o /dev/null -w 'manifest HTTP=%{http_code} TIME=%{time_total}\n' \
  https://nebula.work.gd/manifest.json
curl -sS --max-time 32 -H 'User-Agent: Stremio/4.4' \
  -o /tmp/nebula-smoke.json \
  -w 'stream HTTP=%{http_code} TIME=%{time_total} SIZE=%{size_download}\n' \
  https://nebula.work.gd/stream/movie/tt35672862.json
jq '{streams:(.streams|length)}' /tmp/nebula-smoke.json
```

### Supporter / Ko-fi automation

Manual supporter-code MVP exists:

- `services/supporterService.js` stores code hashes in `cache/supporters.json`; raw code shown/emailed once only.
- Config page has optional `Supporter Code` field and `/configure/validate-supporter`.
- Private configs store sanitized supporter metadata only.
- Admin page can create/revoke codes.

Ko-fi automation added:

- Route: `POST /webhooks/kofi` and `/webhooks/ko-fi`.
- Ko-fi payload accepted as form field `data=<json>` or JSON body.
- Requires `KOFI_WEBHOOK_TOKEN`; verifies against payload `verification_token`.
- Requires SMTP env; if missing returns `503` and does not mark payment delivered.
- Creates one supporter code per unique Ko-fi transaction id, emails to payload `email`, then records payment idempotency.
- Payment records store masked email/hash, amount/currency/type, code hash, emailSentAt. Raw supporter code is not logged/stored in payment record.
- Docs: `docs/KOFI_SUPPORTERS.md`.
- Full supporter system added later; docs: `docs/SUPPORTER_SYSTEM.md`.
- Current supporter implementation uses existing SSR/vanilla UI, not React. User said to ignore technical requirements section and build however suitable.
- Config page now has third tab: `Simple`, `Advanced`, `Support ❤️`.
- Support tab has tier cards:
  - `$1/month` Nebula Supporter.
  - `$10 lifetime` Nebula Founder.
  - Both link to existing Ko-fi URL.
- `/dashboard` exists:
  - Login with supporter code, no password.
  - Session cookie: `nebulastreams_supporter`.
  - Shows profile/tier/expiry/badges/stats/short URL/settings/profiles/backups/wall.
- Supporter code auth creates/loads account in `cache/supporters.json`.
- Supporter data collections:
  - `codes`, `payments`, `accounts`, `usernames`, `sessions`.
  - Raw codes and session tokens are not stored; hashes only.
- `/configure/supporter-profile` saves current config page payload to supporter cloud profile and sets dashboard session.
- `/u/:username` and `/u/:username/manifest.json` redirect to private manifest generated from account default saved profile.
- Ko-fi webhook now:
  - `$1+` creates `supporter`.
  - `$10+` creates `founder` with lifetime status.
  - Creates/updates account, creates code, emails code, records payment idempotency.
  - Renewal with same email reuses account.
  - Cancellation/refund/chargeback/suspend/pause payload text marks account inactive/revoked.
- Supporter perks do not affect free providers, quality, stream count, or stream aggregation.
- Final supporter perk hardening done after user asked to ensure all advertised perks work:
  - Dashboard themes now actually apply via body data-theme: nebula-purple, amoled-black, cyber-green, aurora, synthwave.
  - Dashboard has working Early Access feature flag API: /dashboard/early-access.json.
  - Dashboard has priority support contact card.
  - Saved profiles show Install links when username exists.
  - Added /u/:username/:profileId/manifest.json for profile-specific short installs.
  - /u/:username increments install stats; manifest short URLs increment manifest stats.
  - Backups restore to a new default profile.
  - Inactive/canceled supporter accounts can no longer reuse old supporter codes.
  - Supporter JSON store reloads before writes/validation to avoid PM2 cluster stale-worker overwrite bugs. This was necessary because one worker saved session/profile and another worker read stale in-memory cache.

Relevant env:

```bash
SUPPORTER_CODE_SECRET=
KOFI_WEBHOOK_TOKEN=
KOFI_SUPPORTER_CODE_MONTHS=1
KOFI_MIN_AMOUNT=1
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="NebulaStreams <support@example.com>"
SUPPORTER_EMAIL_REPLY_TO=
```

For standalone-vs-AIOStreams behavior:

- Standalone/Stremio clients get short-deadline flow:
  - faster route timeout around Stremio limit
  - standalone fast-pass first
  - full build continues only when route can still respond
- AIOStreams user-agent gets longer flow:
  - overall timeout at least about `28s`
  - better suited when user sets AIOStreams timeout above 30s

### Do not forget

- Do not revert dirty/user changes.
- Do not disable providers/adapters to fix stability unless user explicitly asks.
- Do not lower provider count, stream limit, or adapter count as a shortcut.
- Prefer isolating provider failures, coalescing duplicate work, caching, and process/worker isolation.
