# Nebula Sports Server Move Handoff

Use this when moving Nebula Sports to a new VPS.

## Target

- OS: Ubuntu 22.04 LTS or 24.04 LTS
- Node: 20.x
- Process manager: PM2
- Reverse proxy: nginx
- Public domain: `sports.nebulapro.xyz`
- App port: `3000`

## Critical Rule

Keep old server online for 24-48 hours after DNS switch.

Do not delete old server until these work on new server:

- `/health`
- `/sports`
- `/manifest.json`
- existing `/private/:id/manifest.json`
- supporter login
- token claim/create
- Ko-fi webhook
- Stremio catalog load
- Stremio stream card playback

## Required Files

Git pull gives code, assets, and this doc.

Secrets and runtime state are not in git. Copy these from old server:

- `.env`
- `cache/sports-supporters.json`
- `cache/supporters.json`
- `cache/private-configs/`
- `cache/smtp2go-webhooks.json`

Optional but useful:

- full `cache/` directory for warm catalogs and debug history

## New Server Setup

```bash
sudo apt update
sudo apt install -y git curl nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pm2
```

Clone and install:

```bash
git clone <REPO_URL> /home/ubuntu/NebulaStreams
cd /home/ubuntu/NebulaStreams
npm ci --omit=dev
npx puppeteer browsers install chrome-headless-shell
```

Copy runtime files from old server after clone:

```bash
mkdir -p cache/private-configs
# copy .env and critical cache files here
```

Start app:

```bash
pm2 start ecosystem.config.cjs --update-env
pm2 save
curl -fsS http://127.0.0.1:3000/health
```

## Nginx

Proxy `sports.nebulapro.xyz` to `127.0.0.1:3000`.

Use Certbot/Let's Encrypt for SSL. After SSL:

```bash
curl -fsS https://sports.nebulapro.xyz/health
curl -fsS https://sports.nebulapro.xyz/sports
```

## DNS Cutover

1. Lower DNS TTL if provider allows it.
2. Point `sports.nebulapro.xyz` A record to new VPS IP.
3. Keep old server running.
4. Test from phone + TV + desktop after propagation.

## Environment Checklist

`.env` must include these if used:

- `KOFI_WEBHOOK_TOKEN`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `SUPPORTER_EMAIL_REPLY_TO`
- `SPORTSRC_API_KEY`
- `RAPID_FOOTBALL_API_KEY`
- `RAPID_FOOTBALL_DAILY_LIMIT`
- `NEBULA_SPORTS_WC_XTREAM_BASE_URL`
- `NEBULA_SPORTS_WC_XTREAM_USERNAME`
- `NEBULA_SPORTS_WC_XTREAM_PASSWORD`
- `NEBULA_SPORTS_WC_XTREAM_CATEGORY_ID`

Do not commit `.env`.

## Verify Existing Private Installs

Pick one file from `cache/private-configs/`:

```bash
ls cache/private-configs | head
curl -fsS http://127.0.0.1:3000/private/<ID>/manifest.json
```

If this fails, old installed Stremio manifests may break.

## Useful Commands

```bash
pm2 status
pm2 logs nebulastreams --lines 100
pm2 reload ecosystem.config.cjs --only nebulastreams --update-env
npm run check:syntax
```

## Current Notes

- `cache/` is ignored by git.
- `.env` is ignored by git.
- Supporter state lives in `cache/sports-supporters.json`.
- Private Stremio install state lives in `cache/private-configs/`.
- Normal sports streams should avoid proxying media segments when direct CDN works.
- Keep server boring and stable; do not upgrade Node/Ubuntu during live move.
