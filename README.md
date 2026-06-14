# NebulaStreams

Lightweight scraper-backed streaming backend for Stremio.

## Features

- Stremio manifest and stream endpoints for movies and series
- Provider filtering and quality-priority install page at `/configure`
- Direct HTTP stream URLs for lower buffering
- Native Stremio torrent entries via `infoHash`
- Disk-backed provider and metadata cache

## VPS Deployment

This repo is intended to run on a VPS under a user-level systemd service. The app listens on `PORT` and should be exposed through your HTTPS reverse proxy or tunnel.

### 1. Prepare `.env`

```bash
cp .env.example .env
nano .env
```

Set at least:

- `PUBLIC_BASE_URL`: public HTTPS base URL, for example `https://your-domain.example`
- `ADMIN_PASSWORD`: long unique admin password
- `STREAM_SOURCE_TOKEN_SECRET`: long random signing secret
- `PORT`: local listen port, default `3000`

Do not commit `.env`. It may contain admin credentials, Redis URLs, or other secrets.

### 2. Install and start

```bash
git pull
npm ci
chmod +x start.sh
mkdir -p ~/.config/systemd/user
cp nebulastreams.service ~/.config/systemd/user/nebulastreams.service
systemctl --user daemon-reload
systemctl --user enable nebulastreams
systemctl --user restart nebulastreams
systemctl --user status nebulastreams
```

If your repo path is not `/home/sohil/NebulaStreams`, edit `WorkingDirectory`, `Environment=HOME`, `EnvironmentFile`, and `ExecStart` in `~/.config/systemd/user/nebulastreams.service`.

To keep user services running after logout:

```bash
loginctl enable-linger "$USER"
```

### 3. Check logs and health

```bash
journalctl --user -u nebulastreams -f
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/manifest.json
```

Expected local checks:

- `/health` returns JSON with service status.
- `/manifest.json` returns the Stremio addon manifest.

## Configuration

Important environment variables are listed in `.env.example`.

Production safety notes:

- `ADMIN_PASSWORD` defaults in code for compatibility with existing installs. Override it in `.env` on any public VPS.
- `STREAM_SOURCE_TOKEN_SECRET` signs private stream URLs. Set a unique value before public use.
- `TMDB_API_KEY` has a built-in fallback for current behavior. Use your own key if you operate the service long term.
- Torbox user API keys are entered through private Stremio configuration URLs. Do not put user Torbox keys in `.env`, systemd units, logs, or committed files.

## Torbox Behavior

Torbox is optional. Without a Torbox API key, NebulaStreams keeps returning the normal available streams.

When a user enables Torbox in `/configure`:

- the key is embedded in that user's private manifest/stream URLs;
- Torbox-only mode filters to streams that can be sent through Torbox;
- failed Torbox availability or resolve calls are logged and the request falls back according to current stream logic;
- Torbox credentials must not be shared publicly because the private manifest URL contains access material.

Troubleshooting:

- Recreate the private install URL if a Torbox key changes.
- Check `journalctl --user -u nebulastreams -f` for Torbox warnings.
- Test normal `/manifest.json` first to separate service health from Torbox account/API issues.

## Local Development

```bash
npm ci
npm start
```

Local endpoints:

- `http://127.0.0.1:3000/manifest.json`
- `http://127.0.0.1:3000/configure`
- `http://127.0.0.1:3000/health`

## Nebula Sports webOS

Homebrew Channel custom repository:

```text
https://raw.githubusercontent.com/retrocodes12/NebulaSports/main/stable-v2.json
```

In Homebrew Channel, open repository settings, add that URL, refresh repositories, then install **Nebula Sports**.

Direct IPK:

```text
https://raw.githubusercontent.com/retrocodes12/NebulaSports/main/com.nebulastreams.sports_1.0.10_all.ipk
```

If an older IPK is already installed and update fails, uninstall `com.nebulastreams.sports` from Homebrew Channel or Developer Mode first, then install again.

## Verification

Before or after a VPS update:

```bash
npm run check:syntax
npm start
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/manifest.json
```

If running under systemd, use:

```bash
systemctl --user restart nebulastreams
systemctl --user status nebulastreams
journalctl --user -u nebulastreams -f
```

## Rollback

Fast rollback to the previous git commit:

```bash
git log --oneline -5
git checkout <previous-commit>
npm ci
chmod +x start.sh
systemctl --user daemon-reload
systemctl --user restart nebulastreams
systemctl --user status nebulastreams
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/manifest.json
```

Rollback without changing git checkout:

```bash
git status --short
git diff
git restore README.md .gitignore .env.example start.sh nebulastreams.service
npm ci
systemctl --user restart nebulastreams
```

Only restore changed files you intend to discard. Keep your server `.env` file.

## Troubleshooting

- Service will not start: run `journalctl --user -u nebulastreams -n 100 --no-pager`.
- Port already used: change `PORT` in `.env` and restart.
- Public URL wrong in Stremio: fix `PUBLIC_BASE_URL`, restart, then reinstall manifest.
- Cache disk growth: inspect `CACHE_DIR` and tune `MAX_CACHE_SIZE_GB`.
- Missing Python helper dependencies: set `SCRAPLING_SERVICE_AUTOSTART=false` if you do not use the local Scrapling helper.
