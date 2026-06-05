#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

warn() {
  printf 'NebulaStreams warning: %s\n' "$*" >&2
}

if [ "${NODE_ENV:-}" = "production" ]; then
  if [ -z "${ADMIN_PASSWORD:-}" ] || [ "${ADMIN_PASSWORD:-}" = "sohil@123" ]; then
    warn "set ADMIN_PASSWORD in .env before exposing /configure/admin on a public VPS"
  fi

  if [ -z "${STREAM_SOURCE_TOKEN_SECRET:-}" ] || [ "${STREAM_SOURCE_TOKEN_SECRET:-}" = "nebulastreams" ]; then
    warn "set STREAM_SOURCE_TOKEN_SECRET in .env so private stream URLs are signed with a unique secret"
  fi

  if [ -z "${PUBLIC_BASE_URL:-}" ]; then
    warn "set PUBLIC_BASE_URL to your public HTTPS addon URL for VPS/Stremio installs"
  fi
fi

exec npm start
