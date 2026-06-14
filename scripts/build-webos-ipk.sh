#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/webos/nebula-sports"
DIST_DIR="$ROOT_DIR/dist/webos"
APP_ID="$(node -e "process.stdout.write(require('$APP_DIR/appinfo.json').id)")"
VERSION="$(node -e "process.stdout.write(require('$APP_DIR/appinfo.json').version)")"
OUT="$DIST_DIR/${APP_ID}_${VERSION}_all.ipk"
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/control" "$TMP/data/usr/palm/applications/$APP_ID" "$TMP/data/usr/palm/packages/$APP_ID" "$DIST_DIR"

printf '2.0\n' > "$TMP/debian-binary"

cat > "$TMP/control/control" <<EOF
Package: $APP_ID
Version: $VERSION
Section: web
Priority: optional
Architecture: all
Maintainer: NebulaStreams <support@nebulastreams.local>
Description: Nebula Sports webOS app
webOS-Package-Format-Version: 2
EOF

cp "$APP_DIR/appinfo.json" "$APP_DIR/index.html" "$APP_DIR/icon.png" "$APP_DIR/largeIcon.png" "$TMP/data/usr/palm/applications/$APP_ID/"

cat > "$TMP/data/usr/palm/packages/$APP_ID/packageinfo.json" <<EOF
{"id":"$APP_ID","version":"$VERSION","app":"$APP_ID"}
EOF

(cd "$TMP/control" && tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$TMP/control.tar.gz" .)
(cd "$TMP/data" && tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$TMP/data.tar.gz" .)

rm -f "$DIST_DIR/${APP_ID}_"*_all.ipk "$OUT"
(cd "$TMP" && ar rc "$OUT" debian-binary control.tar.gz data.tar.gz)
chmod 0644 "$OUT"

sha256sum "$OUT"
